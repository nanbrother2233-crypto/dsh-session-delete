/**
 * Delete planning and execution.
 *
 * The service is deliberately written against *structural* interfaces rather
 * than the harness's own service types: it consumes only the handful of methods
 * it calls, so a harness upgrade that adds surface area cannot break the build,
 * and every optional capability degrades instead of failing the plugin.
 *
 * Behaviour that matters, with the evidence in
 * `research/session-storage-and-deletion.md`:
 *
 * - A live session must never be deleted. No plugin can close one (the detach
 *   disposer is owned by the creating fiber), and a live writer simply
 *   re-materialises a removed log. Refusal is the only safe answer.
 * - Enumeration is `sessionQuery.listSessions()`: one call, live-preferred,
 *   across every workspace, newest-first.
 * - The session log has no delete API, so the directory is removed directly;
 *   the projection cache has one, and it is preferred over raw file removal so
 *   the live domain table stays coherent.
 */

import { readdir, rm } from 'node:fs/promises'

import {
  type HarnessLayout,
  type ProjectDirectory,
  findSessionDirectories,
  listProjectDirectories,
  mutateWithRetry,
  projectionRecordPath,
  pruneHistoryCache,
  pruneProjectDirectory,
  removeSessionDirectory,
} from './store.js'

/** The subset of a persisted session header this plugin reads. */
export interface SessionHeaderLike {
  readonly id: string
  readonly createdAt?: string | number
  readonly cwd?: string
  readonly parentSession?: string
  readonly origin?: string
  readonly delegationDepth?: number
}

/**
 * One `subagent/descriptor` event, as far as this plugin reads it.
 *
 * The payload is a larger, version-stamped descriptor (`mode`, `provider`,
 * `agentProvider`, …); only the human label is read, and an absent or
 * non-string one simply means "this child declared no task name".
 */
export interface SubagentDescriptorEventLike {
  readonly type?: unknown
  readonly data?: unknown
}

/** One record from `sessionQuery.listSessions()`. */
export interface SessionRecordLike {
  readonly header: SessionHeaderLike
  readonly live: boolean
  readonly persisted: boolean
}

/** A storage-domain table, as far as this plugin uses it. */
export interface DomainTableLike {
  delete(key: string): Promise<boolean>
}

/** The subset of `ctx.storageDomain` this plugin uses. */
export interface StorageDomainLike {
  get(name: string): { table(name: string): DomainTableLike } | undefined
}

/** A workspace entity, as far as this plugin uses it. */
export interface WorkspaceEntityLike {
  readonly sessionIds?: readonly string[]
  detachSession?(sessionId: string): Promise<void>
}

/** The harness capabilities a delete needs, all resolved structurally. */
export interface SessionDeleteHost {
  listSessions(signal?: AbortSignal): Promise<readonly SessionRecordLike[]>
  readTitles(ids: readonly string[], signal?: AbortSignal): Promise<readonly (string | undefined)[]>
  /**
   * Read the `subagent/descriptor` label of each given id, keyed by id.
   *
   * Called with delegated children only, because each one costs a log read that
   * the title fold has already paid for once. Ids whose label cannot be read are
   * simply absent from the map.
   */
  readSubagentLabels(ids: readonly string[], signal?: AbortSignal): Promise<ReadonlyMap<string, string>>
  isLive(id: string): boolean
  isPending(id: string): boolean
  storageDomain?: StorageDomainLike | undefined
  workspaceEntities(): readonly WorkspaceEntityLike[]
  emitRemoved(id: string): void
  warn(message: string): void
}

/** One row of the session manager. */
export interface SessionSummary {
  readonly id: string
  readonly title: string | undefined
  /**
   * The name the row is drawn with, derived by {@link displayNameOf}.
   *
   * Computed on the host rather than in the browser half so it is the *same*
   * chain the built-in session list uses, and so it is unit-testable. A
   * delegated child leads with the task label it was spawned with, which is why
   * `title` above may not be the text this row shows.
   */
  readonly displayName: string
  readonly cwd: string | undefined
  readonly createdAt: string | undefined
  readonly live: boolean
  readonly persisted: boolean
  readonly parentSession: string | undefined
  /** True when the session is a delegated child (`origin: "subagent"`). */
  readonly delegated: boolean
  /** Number of transitive children that a delete of this row would also remove. */
  readonly descendantCount: number
  /**
   * How the *parent* session reads, for a row that is a delegated child.
   *
   * The manager is the only surface that lists child sessions at all — the
   * built-in sidebar hides every `origin: "subagent"` row — so without this a
   * child is an anonymous entry in a delete list, with no way to tell whose
   * subagent it is. Undefined for a root session, and for the degenerate
   * self-parenting header the traversal already refuses to index.
   */
  readonly parentName: string | undefined
}

/** Why a requested session cannot be deleted. */
export interface DeleteBlocker {
  readonly id: string
  readonly reason: 'live' | 'missing' | 'duplicate-on-disk' | 'current'
}

/** A reviewed, ready-to-run delete. */
export interface DeletePlan {
  /** Every id that would be removed, children before parents. */
  readonly targets: readonly string[]
  /** Targets that are delegated children rather than the requested rows. */
  readonly expanded: readonly string[]
  /** Requested ids that the delete will refuse, with the reason. */
  readonly blockers: readonly DeleteBlocker[]
}

/** Outcome of one delete run. */
export interface DeleteOutcome {
  readonly id: string
  readonly removed: boolean
  readonly directories: readonly string[]
  readonly projectionRemoved: boolean
  readonly historyEntryRemoved: boolean
  readonly error?: string
}

/**
 * One settled title read from `sessionQuery.readTitleSnapshots`.
 *
 * The `title` here is **not** the title text. `readTitleSnapshots` folds each
 * log with `foldSessionTitle` (`@deepseek-ai/dsh-session-title`), and that fold
 * returns the immutable `SessionTitleSnapshot`
 * (`{ title, messageSeqs, source, eventSeq, updatedAt }`); the observation hangs
 * that object off `title`. Reading it as text finds nothing and silently drops
 * every title — which is exactly the bug this shape documents away. The
 * signature that pins it down is
 * `readTitle(sessionId): Promise<SessionTitleSnapshot | undefined>` in
 * `dsh-session-query`, whose `title` is that same snapshot.
 *
 * A bare string is still tolerated: a harness build that answers with the text
 * directly must not lose its titles.
 */
export interface TitleSnapshotResult {
  readonly status: unknown
  readonly value?: {
    readonly session?: { readonly id?: unknown }
    /** A `SessionTitleSnapshot` on every shipping harness; text is tolerated. */
    readonly title?: unknown
  }
}

/** Read the title text out of one observation's `title`, or undefined. */
function titleTextOf(value: unknown): string | undefined {
  const candidate =
    typeof value === 'object' && value !== null ? (value as { readonly title?: unknown }).title : value
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined
}

/**
 * Fold settled title reads back onto the requested ids.
 *
 * `readTitleSnapshots` answers with one *settled* result per unique id — an
 * allSettled envelope (`{ status, value }`), not a title — and it collapses
 * duplicates, so the reply cannot be zipped against the request by index.
 * Matching on the id inside each fulfilled value is the only sound mapping; a
 * rejected entry (a session that vanished mid-read) simply has no title.
 *
 * Verified against `@deepseek-ai/dsh-session-query/lib/index.js:1121-1129`,
 * whose own `readTitleSnapshot` unwraps the envelope the same way.
 *
 * @param ids - the requested ids, in the order the caller wants titles back.
 * @param results - the settled envelopes, in first-occurrence order.
 * @returns one title per requested id, `undefined` where there is none.
 */
export function titlesFromSnapshots(
  ids: readonly string[],
  results: readonly TitleSnapshotResult[],
): (string | undefined)[] {
  const titles = new Map<string, string>()
  for (const result of results) {
    if (result.status !== 'fulfilled') continue
    const value = result.value
    const id = value?.session?.id
    if (typeof id !== 'string') continue
    const title = titleTextOf(value?.title)
    if (title === undefined) continue
    titles.set(id, title)
  }
  return ids.map((id) => titles.get(id))
}

/**
 * Normalize a header's `createdAt` for sorting and display.
 *
 * Real logs carry epoch milliseconds (verified against a decoded header:
 * `"createdAt":1790238079236`), but the field is typed loosely upstream, so an
 * ISO string is accepted too. Normalizing to ISO text keeps the newest-first
 * comparison a plain string compare in both cases.
 *
 * @param value - the raw header value.
 * @returns ISO text, or undefined when absent or unparseable.
 */
function toIsoTimestamp(value: string | number | undefined): string | undefined {
  if (value === undefined) return undefined
  const epoch = typeof value === 'number' ? value : Date.parse(value)
  if (!Number.isFinite(epoch)) return typeof value === 'string' ? value : undefined
  return new Date(epoch).toISOString()
}

/** Compare ids newest-first using `createdAt`, falling back to the id. */
function compareNewestFirst(left: SessionSummary, right: SessionSummary): number {
  const a = left.createdAt ?? ''
  const b = right.createdAt ?? ''
  if (a !== b) return a < b ? 1 : -1
  return left.id < right.id ? 1 : left.id > right.id ? -1 : 0
}

/**
 * Last path segment of a working directory.
 *
 * A byte-for-byte copy of the harness's own `workspaceTitleOf`
 * (`dsh-api-session-controller`): trailing separators are stripped first, so a
 * path ending in `/` names its real directory rather than the empty string.
 *
 * @param cwd - the session's working directory, if it has one.
 * @returns the basename, or `''` when there is no usable path.
 */
export function workspaceBasename(cwd: string | undefined): string {
  if (cwd === undefined) return ''
  const trimmed = cwd.replace(/[/\\]+$/u, '')
  const separator = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return trimmed.slice(separator + 1)
}

/**
 * Fold the task label a delegated child was created with.
 *
 * Every session-backed subagent appends exactly one `subagent/descriptor` event
 * as its own first event, and the label there is what the subagent was asked to
 * do: `"Research DSH session storage"`, not the generic first-prompt fallback the
 * child's `session/title` folds to (which is why three siblings otherwise read
 * identically). The harness folds the same event — `foldSubagentDescriptor` in
 * `@deepseek-ai/dsh-subagent`, first event wins because the establishing
 * provider appends exactly one — and its own subagent surfaces show that label.
 *
 * The caller must pass the child's *own* events: a forked child inherits its
 * parent's log as a prefix, so a grandchild's slice would otherwise fold its
 * parent's descriptor. `dsh-subagent/lib/index.js:1888` slices by
 * `inheritedEventCount` for exactly this reason.
 *
 * @param events - the child's own events, inherited prefix already removed.
 * @returns the declared label, or undefined when the log declares none.
 */
export function subagentLabelFrom(events: readonly SubagentDescriptorEventLike[]): string | undefined {
  const event = events.find((candidate) => candidate.type === 'subagent/descriptor')
  const label = (event?.data as { readonly label?: unknown } | undefined)?.label
  return typeof label === 'string' && label.length > 0 ? label : undefined
}

/**
 * The name one session row is drawn with.
 *
 * For an ordinary session this is the chain the built-in session list projects
 * (`displayTitleOf` in `dsh-api-session-controller`): the log's durable title,
 * else the basename of the working directory, else the raw id. This manager sits
 * beside that list and lists the same corpus, so two different names for one
 * session would be a usability bug, not a cosmetic one.
 *
 * A delegated child leads with its `subagent/descriptor` label instead. That is
 * the only name that says what the child was actually doing, it is what the
 * harness's own subagent surfaces display, and the built-in sidebar hides child
 * sessions entirely — so there is no sidebar row for it to disagree with.
 *
 * @param session - the row's id, folded title, working directory and task label.
 * @returns a non-empty display name.
 */
export function displayNameOf(session: {
  readonly id: string
  readonly title: string | undefined
  readonly cwd: string | undefined
  readonly label: string | undefined
}): string {
  if (session.label !== undefined && session.label.length > 0) return session.label
  if (session.title !== undefined && session.title.length > 0) return session.title
  const base = workspaceBasename(session.cwd)
  if (base !== '') return base
  return session.id
}

/** The rows, index and lineage one listing folds into. */
export interface SessionIndex {
  readonly summaries: readonly SessionSummary[]
  readonly byId: ReadonlyMap<string, SessionSummary>
  readonly childrenOf: ReadonlyMap<string, readonly string[]>
}

/**
 * Index every session record by id and by parent, newest-first.
 *
 * @param records - the corpus, in the order the host reported it.
 * @param titles - one folded title per record, by position.
 * @param labels - `subagent/descriptor` labels by child id. Sparse on purpose:
 * only delegated children have one, and a label for anything else is ignored
 * rather than trusted.
 * @returns the sorted rows, their index, and the parent → children index.
 */
export function indexSessions(
  records: readonly SessionRecordLike[],
  titles: readonly (string | undefined)[],
  labels: ReadonlyMap<string, string> = new Map(),
): SessionIndex {
  const childrenOf = new Map<string, string[]>()
  // Lineage-derived fields are filled in by the second pass, once every id has
  // a name to point at.
  const summaries: Omit<SessionSummary, 'descendantCount' | 'parentName'>[] = records.map((record, index) => {
    const header = record.header
    const parent = header.parentSession
    if (parent !== undefined && parent !== header.id) {
      const bucket = childrenOf.get(parent)
      if (bucket === undefined) childrenOf.set(parent, [header.id])
      else bucket.push(header.id)
    }
    const delegated = header.origin === 'subagent'
    return {
      id: header.id,
      title: titles[index],
      displayName: displayNameOf({
        id: header.id,
        title: titles[index],
        cwd: header.cwd,
        label: delegated ? labels.get(header.id) : undefined,
      }),
      cwd: header.cwd,
      createdAt: toIsoTimestamp(header.createdAt),
      live: record.live,
      persisted: record.persisted,
      parentSession: parent,
      delegated,
    }
  })
  const byId = new Map(summaries.map((summary) => [summary.id, summary]))
  const withCounts = summaries.map((summary) => {
    let count = 0
    const seen = new Set<string>([summary.id])
    const stack = [...(childrenOf.get(summary.id) ?? [])]
    while (stack.length > 0) {
      const next = stack.pop()
      if (next === undefined || seen.has(next)) continue
      seen.add(next)
      count += 1
      stack.push(...(childrenOf.get(next) ?? []))
    }
    const parent = summary.parentSession
    return {
      ...summary,
      descendantCount: count,
      // A parent outside the corpus — one already deleted, or one this listing
      // could not fold — still has to be named: the raw id is what the sidebar
      // falls back to as well, and an unnamed child would be worse.
      parentName:
        parent === undefined || parent === summary.id ? undefined : (byId.get(parent)?.displayName ?? parent),
    }
  })
  return {
    summaries: withCounts.sort(compareNewestFirst),
    byId: new Map(withCounts.map((summary) => [summary.id, summary])),
    childrenOf,
  }
}

/** One listing folded from the host, with the corpus it came from. */
export interface HostSessionIndex extends SessionIndex {
  /** The corpus this index was folded from, for a caller that must keep it. */
  readonly records: readonly SessionRecordLike[]
}

/**
 * Read one listing from the host and index it, descriptor labels included.
 *
 * The whole read chain lives here rather than in the plugin body so that the
 * *wiring* is testable, not just its ends. `indexSessions` happily accepts an
 * empty label map and `SessionDeleteHost.readSubagentLabels` happily returns
 * one, so a plugin body that reads labels and forgets to pass them produces two
 * green units and an anonymous session manager: every delegated child falls
 * back to the first-prompt title its log folds to, and three siblings spawned
 * for three different tasks all read the same. That is what this function
 * exists to make impossible to reintroduce silently.
 *
 * Only delegated children are asked for a label: each one costs its own log
 * read, and a root session has no descriptor to find.
 *
 * @param host - the harness capabilities a listing needs.
 * @param signal - caller cancellation, forwarded to every read.
 * @returns the corpus plus its index.
 */
export async function summarizeHostSessions(
  host: SessionDeleteHost,
  signal?: AbortSignal,
): Promise<HostSessionIndex> {
  const records = await host.listSessions(signal)
  const ids = records.map((record) => record.header.id)
  const titles = await host.readTitles(ids, signal)
  const childIds = records
    .filter((record) => record.header.origin === 'subagent')
    .map((record) => record.header.id)
  const labels = childIds.length === 0 ? new Map<string, string>() : await host.readSubagentLabels(childIds, signal)
  return { records, ...indexSessions(records, titles, labels) }
}

/**
 * Expand the requested ids into a full delete set.
 *
 * Children come before their parent so a partially failed run never leaves a
 * parent removed while an orphaned child survives. Cycles and repeated ids are
 * tolerated (the header is untrusted input) because the traversal memoises.
 *
 * @param roots - ids the user selected.
 * @param childrenOf - parent → direct children index.
 * @returns every id to delete, children first, each exactly once.
 */
export function collectSubtree(roots: readonly string[], childrenOf: ReadonlyMap<string, readonly string[]>): string[] {
  const ordered: string[] = []
  const emitted = new Set<string>()
  const visiting = new Set<string>()
  const visit = (id: string): void => {
    if (emitted.has(id) || visiting.has(id)) return
    visiting.add(id)
    for (const child of childrenOf.get(id) ?? []) visit(child)
    visiting.delete(id)
    emitted.add(id)
    ordered.push(id)
  }
  for (const root of roots) visit(root)
  return ordered
}

/**
 * Plan a delete: resolve the full target set and refuse anything unsafe.
 *
 * Blockers are per id, not per requested id: a delegated child that is itself
 * live, or that is the session the caller is viewing, blocks the whole plan
 * rather than silently deleting a subtree minus one member. Refusing the whole
 * plan is the only safe answer — a subtree with a hole in it is worse than an
 * untouched subtree.
 *
 * @param roots - ids the user selected.
 * @param byId - session index.
 * @param childrenOf - parent → direct children index.
 * @param options - live/pending probes plus the session the caller is viewing.
 * @returns the plan, including why any requested id was refused.
 */
export function planDelete(
  roots: readonly string[],
  byId: ReadonlyMap<string, SessionSummary>,
  childrenOf: ReadonlyMap<string, readonly string[]>,
  options: {
    readonly isLive: (id: string) => boolean
    readonly isPending: (id: string) => boolean
    readonly currentSessionId?: string | undefined
  },
): DeletePlan {
  const blockers: DeleteBlocker[] = []
  const blocked = (id: string): boolean => blockers.some((blocker) => blocker.id === id)
  const requests = [...new Set(roots)]
  for (const id of requests) {
    if (options.currentSessionId !== undefined && id === options.currentSessionId) {
      blockers.push({ id, reason: 'current' })
      continue
    }
    if (id.length === 0) {
      blockers.push({ id, reason: 'missing' })
      continue
    }
    if (byId.get(id) === undefined) {
      blockers.push({ id, reason: 'missing' })
    }
  }

  const targets = collectSubtree(requests, childrenOf)
  for (const id of targets) {
    // The current session is refused as an *expanded* target too: it is usually
    // the parent the caller selected, not the row they clicked, so checking only
    // the requested ids would delete the session they are looking at.
    if (options.currentSessionId !== undefined && id === options.currentSessionId && !blocked(id)) {
      blockers.push({ id, reason: 'current' })
      continue
    }
    if ((options.isLive(id) || options.isPending(id)) && !blocked(id)) {
      blockers.push({ id, reason: 'live' })
    }
  }

  return {
    targets: blockers.length > 0 ? [] : targets,
    expanded: targets.filter((id) => !requests.includes(id)),
    blockers,
  }
}

/**
 * Execute a deletion.
 *
 * Each id is handled independently so one failure does not abandon the rest;
 * the caller reports per-id outcomes. A duplicate on-disk match is refused
 * rather than guessed, mirroring the backend's own refusal to resolve it.
 *
 * @param ids - ids to delete, in the order produced by {@link planDelete}.
 * @param layout - resolved harness paths.
 * @param host - capability probes and notifications.
 * @returns one outcome per id.
 */
export async function executeDelete(
  ids: readonly string[],
  layout: HarnessLayout,
  host: SessionDeleteHost,
): Promise<DeleteOutcome[]> {
  const outcomes: DeleteOutcome[] = []
  for (const id of ids) {
    if (host.isLive(id) || host.isPending(id)) {
      outcomes.push({
        id,
        removed: false,
        directories: [],
        projectionRemoved: false,
        historyEntryRemoved: false,
        error: 'session became live before it could be deleted',
      })
      continue
    }
    try {
      const directories = await findSessionDirectories(layout, id)
      if (directories.length > 1) {
        outcomes.push({
          id,
          removed: false,
          directories,
          projectionRemoved: false,
          historyEntryRemoved: false,
          error: `duplicate session id on disk in ${String(directories.length)} project directories`,
        })
        continue
      }
      for (const directory of directories) await removeSessionDirectory(directory)

      const projectionRemoved = await removeProjectionRecord(layout, id, host)
      const historyEntryRemoved = (await pruneHistoryCache(layout, [id])) > 0
      await detachFromWorkspaces(id, host)
      host.emitRemoved(id)

      outcomes.push({ id, removed: true, directories, projectionRemoved, historyEntryRemoved })
    } catch (error) {
      outcomes.push({
        id,
        removed: false,
        directories: [],
        projectionRemoved: false,
        historyEntryRemoved: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return outcomes
}

/**
 * Remove one session's projection-cache checkpoint.
 *
 * Prefers the storage-domain table so the live in-memory table and its change
 * notification stay coherent. The table delete is a no-op for a key it does not
 * hold, so the per-record file is removed as a fallback — safe precisely because
 * a key absent from the in-memory table has no write-behind checkpoint that
 * could recreate it.
 *
 * @param layout - resolved harness paths.
 * @param id - session id.
 * @param host - capability probes.
 * @returns true when a record or file was actually removed.
 */
async function removeProjectionRecord(layout: HarnessLayout, id: string, host: SessionDeleteHost): Promise<boolean> {
  const table = host.storageDomain?.get('session_projcache')?.table('sessions')
  if (table !== undefined) {
    try {
      if (await table.delete(id)) return true
    } catch (error) {
      host.warn(`dsh-session-delete: projection table delete failed for ${id}: ${String(error)}`)
    }
  }
  try {
    await mutateWithRetry(async () => {
      // Deliberately without `force`: an absent record must report as absent
      // rather than as removed, or the outcome claims a cleanup that never
      // happened.
      await rm(projectionRecordPath(layout, id))
    })
    return true
  } catch {
    return false
  }
}

/**
 * Drop a session id from every workspace that lists it.
 *
 * Cosmetic: the registry filters stale membership on read, so a failure here
 * never leaves a phantom row. `workspace.json` is a shared index and is only
 * ever mutated through the registry, never rewritten by this plugin.
 *
 * @param id - session id.
 * @param host - capability probes.
 */
async function detachFromWorkspaces(id: string, host: SessionDeleteHost): Promise<void> {
  for (const entity of host.workspaceEntities()) {
    if (entity.detachSession === undefined) continue
    if (!(entity.sessionIds ?? []).includes(id)) continue
    try {
      await entity.detachSession(id)
    } catch (error) {
      host.warn(`dsh-session-delete: workspace detach failed for ${id}: ${String(error)}`)
    }
  }
}

/**
 * Report project directories left empty by a delete, and optionally prune them.
 *
 * Exposed so the route layer can decide; an empty project directory is inert.
 *
 * @param layout - resolved harness paths.
 * @returns the project directories that currently hold no entries.
 */
export async function listEmptyProjectDirectories(layout: HarnessLayout): Promise<ProjectDirectory[]> {
  const empty: ProjectDirectory[] = []
  for (const project of await listProjectDirectories(layout)) {
    try {
      if ((await readdir(project.path)).length === 0) empty.push(project)
    } catch {
      // Unreadable project directories are simply not pruned.
    }
  }
  return empty
}

export { pruneProjectDirectory }
