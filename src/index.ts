/**
 * dsh-session-delete — host half.
 *
 * Exposes a small HTTP surface that the browser half drives:
 *
 * - `GET  /api/session-delete/sessions` — every session across all workspaces
 * - `POST /api/session-delete/preview`  — expand a selection and report blockers
 * - `POST /api/session-delete/delete`   — perform a confirmed hard delete
 *
 * Enumeration goes through `sessionQuery`, which merges persisted and live
 * sessions newest-first in one call and is the same corpus the sidebar shows.
 * Removal has no harness API at all, so {@link executeDelete} performs it
 * directly and only through primitives the harness sanctions.
 *
 * The harness-specific context surface is described by a local structural
 * interface and reached through one narrowing cast. The `@deepseek-ai/dsh-*`
 * packages publish their Cordis type augmentations inconsistently, so depending
 * on them would make the build hostage to another package's `files` list; the
 * methods used here are few and stable.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import { dshHomeDisplay, resolveDshHome } from '@deepseek-ai/dsh-home-paths'

import { type RouteRegistration, guardedHandler, sessionDeleteRoutes } from './routes.js'
import {
  type DeleteOutcome,
  type DeletePlan,
  type SessionDeleteHost,
  type SessionRecordLike,
  type SessionSummary,
  type SubagentDescriptorEventLike,
  type TitleSnapshotResult,
  executeDelete,
  planDelete,
  subagentLabelFrom,
  summarizeHostSessions,
  titlesFromSnapshots,
} from './service.js'

/** Cordis plugin name; also the loader row id in `cordis.patch.yml`. */
export const name = 'dsh-session-delete'

/** The web transport plus the session corpus this plugin reads. */
export const inject = ['webServer', 'sessionQuery']

/** The `webServer` route registry, as far as this plugin uses it. */
interface WebServerLike {
  register(route: {
    kind: 'exact'
    path: string
    handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>
  }): () => void
}

/** The harness-specific slice of the Cordis context this plugin touches. */
interface HarnessContext {
  get(serviceName: string): unknown
  emit(event: string, ...args: unknown[]): void
  effect(callback: () => () => void, label?: string): void
  readonly logger: { warn(message: string): void }
  readonly webServer: WebServerLike
}

/** One session-query record, widened for structural use. */
interface QueryRecord {
  readonly header: { readonly id: string }
  readonly live: boolean
  readonly persisted: boolean
}

/**
 * One caller-owned session observation, as far as this plugin uses it.
 *
 * `observeSession` answers with a *lease*, not a value: the corpus pins the
 * loaded log until the holder disposes it, so an undisposed lease is a leak the
 * harness cannot collect. Only the two fields read here are declared.
 */
interface ObservationLease {
  readonly events: readonly SubagentDescriptorEventLike[]
  readonly inheritedEventCount: number
  [Symbol.dispose](): void
}

/**
 * The `sessionQuery` capability this plugin uses.
 *
 * `readTitleSnapshots` answers with one *settled* envelope per unique id, which
 * is why {@link titlesFromSnapshots} unwraps it rather than reading a field.
 * `observeSession` is optional because it is how the harness itself reads a
 * child's descriptor (`dsh-subagent/lib/index.js:1880`): a plain log read with
 * no replay validation, and with the inherited-event count the descriptor fold
 * needs.
 */
interface SessionQueryLike {
  listSessions(signal?: AbortSignal): Promise<readonly QueryRecord[]>
  readTitleSnapshots?(
    sessionIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly TitleSnapshotResult[]>
  observeSession?(
    sessionId: string,
    options?: { readonly signal?: AbortSignal; readonly projectionMode?: 'none' },
  ): Promise<ObservationLease>
}

/** The `sessions` capability, used only as a liveness probe. */
interface SessionStoreLike {
  get(id: string): unknown
}

/** The `agents` capability, used only as a liveness probe. */
interface AgentStoreLike {
  get(id: string): unknown
}

/** The `storageDomain` capability, used to drop a projection checkpoint. */
interface StorageDomainCapability {
  get(name: string): { table(name: string): { delete(key: string): Promise<boolean> } } | undefined
}

/** The `workspaceRegistry` capability, used to drop stale membership. */
interface WorkspaceRegistryLike {
  list(): readonly { readonly sessionIds?: readonly string[]; detachSession?(id: string): Promise<void> }[]
}

/** Read one capability without asserting its presence. */
function optional<T>(ctx: HarnessContext, serviceName: string): T | undefined {
  return ctx.get(serviceName) as T | undefined
}

/**
 * Bind the harness's services to the structural host contract.
 *
 * Every optional capability is resolved through `get` rather than declared in
 * `inject`, so a profile without a workspace registry still loads the plugin and
 * simply skips the cosmetic steps.
 *
 * @param ctx - the narrowed harness context.
 * @returns the host adapter plus the record map the pending probe reads.
 */
function createHost(ctx: HarnessContext): { host: SessionDeleteHost; records: Map<string, SessionRecordLike> } {
  const query = ctx.get('sessionQuery') as SessionQueryLike
  const sessions = optional<SessionStoreLike>(ctx, 'sessions')
  const agents = optional<AgentStoreLike>(ctx, 'agents')
  const registry = optional<WorkspaceRegistryLike>(ctx, 'workspaceRegistry')
  const storageDomain = optional<StorageDomainCapability>(ctx, 'storageDomain')
  const records = new Map<string, SessionRecordLike>()

  const host: SessionDeleteHost = {
    async listSessions(signal) {
      const listed = await query.listSessions(signal)
      return listed.map((record) => ({
        header: record.header as SessionRecordLike['header'],
        live: record.live,
        persisted: record.persisted,
      }))
    },
    async readTitles(ids, signal) {
      if (query.readTitleSnapshots === undefined) return ids.map(() => undefined)
      try {
        // The reply is an allSettled envelope per *unique* id, so it is folded
        // by id rather than zipped against the request by index.
        return titlesFromSnapshots(ids, await query.readTitleSnapshots(ids, signal))
      } catch (error) {
        // Titles are a cosmetic projection: a failure here must not cost the
        // user the list. It is still reported — a silent fallback is how a
        // title-shape mismatch once went unnoticed for every row.
        ctx.logger.warn(`dsh-session-delete: title read failed: ${String(error)}`)
        return ids.map(() => undefined)
      }
    },
    async readSubagentLabels(ids, signal) {
      const labels = new Map<string, string>()
      if (query.observeSession === undefined) return labels
      let failure: unknown
      for (const id of ids) {
        try {
          const lease = await query.observeSession(id, {
            projectionMode: 'none',
            ...(signal === undefined ? {} : { signal }),
          })
          try {
            // The inherited prefix is dropped first: a forked child's log opens
            // with its parent's events, and its parent may itself be a subagent
            // whose descriptor would otherwise be folded onto this child.
            const label = subagentLabelFrom(lease.events.slice(lease.inheritedEventCount))
            if (label !== undefined) labels.set(id, label)
          } finally {
            // A lease pins the loaded log in the corpus cache until it is
            // disposed; forgetting this leaks one entry per child per refresh.
            lease[Symbol.dispose]()
          }
        } catch (error) {
          failure ??= error
        }
      }
      // One warning per listing, not one per child: a corpus where every child
      // fails would otherwise turn one refresh into a wall of warnings.
      if (failure !== undefined) ctx.logger.warn(`dsh-session-delete: subagent label read failed: ${String(failure)}`)
      return labels
    },
    isLive(id) {
      return sessions?.get(id) !== undefined || agents?.get(id) !== undefined
    },
    isPending(id) {
      // A session in neither the live stores nor persisted storage was created
      // but never materialised: it has no files to remove, and deleting files
      // cannot make it disappear.
      const record = records.get(id)
      return record !== undefined && !record.live && !record.persisted
    },
    storageDomain,
    workspaceEntities() {
      try {
        return registry?.list() ?? []
      } catch {
        return []
      }
    },
    emitRemoved(id) {
      ctx.emit('api-session/removed', id)
    },
    warn(message) {
      ctx.logger.warn(message)
    },
  }

  return { host, records }
}

/**
 * Register the plugin's routes.
 *
 * @param context - the plugin context.
 */
export function apply(context: Context): void {
  const ctx = context as unknown as HarnessContext
  const home = resolveDshHome()
  const layout = { home, sessionsRoot: join(home, 'sessions') }
  const { host, records } = createHost(ctx)

  /**
   * Re-read the session corpus for one request.
   *
   * Never cached across requests: a preview and its confirming delete are
   * separate round trips, and a session may have gone live in between. The
   * record map is refreshed in the same pass so the pending probe sees the
   * same snapshot the plan was built from.
   */
  const refresh = async () => {
    // The titles *and* the children's descriptor labels are read by this fold.
    // Reading a child's task label here is the difference between a row named
    // after the work the subagent was given and one named after whatever its
    // first prompt folded to.
    const { records: listed, summaries, byId, childrenOf } = await summarizeHostSessions(host)
    records.clear()
    for (const record of listed) records.set(record.header.id, record)
    return { summaries, byId, childrenOf }
  }

  const probes = {
    isLive: (id: string) => host.isLive(id),
    isPending: (id: string) => host.isPending(id),
  }

  const registrations = sessionDeleteRoutes(
    {
      async list() {
        return (await refresh()).summaries
      },
      async plan(ids: readonly string[], currentSessionId: string | undefined): Promise<DeletePlan> {
        const { byId, childrenOf } = await refresh()
        return planDelete(ids, byId, childrenOf, { ...probes, currentSessionId })
      },
      async execute(ids: readonly string[], currentSessionId: string | undefined): Promise<readonly DeleteOutcome[]> {
        const { byId, childrenOf } = await refresh()
        const plan = planDelete(ids, byId, childrenOf, { ...probes, currentSessionId })
        return executeDelete(plan.targets, layout, host)
      },
    },
    dshHomeDisplay(home),
  )

  ctx.effect(() => {
    const disposers = registrations.map((route: RouteRegistration) =>
      ctx.webServer.register({
        kind: route.kind,
        path: route.path,
        handler: guardedHandler(route, (message) => {
          ctx.logger.warn(message)
        }),
      }),
    )
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'dsh-session-delete: routes')
}

export type { DeleteOutcome, DeletePlan, SessionSummary } from './service.js'
