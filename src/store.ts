/**
 * Filesystem side of a hard delete.
 *
 * Everything here is intentionally id-keyed: the on-disk project directory name
 * is a lossy encoding of a cwd, so the deleter never decodes it. It scans the
 * session root for a directory named exactly `encodeSegment(id)`, which is
 * sound because that encoding is injective.
 *
 * Read the reconnaissance notes for the evidence behind each path:
 * `research/session-storage-and-deletion.md` §1, §3.3, §5.
 */

import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { encodeSegment } from './encode.js'

/** Transient Windows failures that a short retry clears. */
const RETRYABLE = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'])

/** Attempts per filesystem mutation before giving up. */
const MUTATION_ATTEMPTS = 5

/** Base backoff between mutation attempts, in milliseconds. */
const MUTATION_BACKOFF_MS = 30

/** The two harness-home locations a hard delete needs. */
export interface HarnessLayout {
  /** Absolute harness home (`~/.dsh` or `$DSH_HOME`). */
  readonly home: string
  /** Absolute session log root (`<home>/sessions`). */
  readonly sessionsRoot: string
}

/** One workspace level below the session root. */
export interface ProjectDirectory {
  /** Directory name, e.g. `--D-Tools-dsh-session-delete--`. */
  readonly name: string
  /** Absolute path. */
  readonly path: string
}

function isRetryable(error: unknown): boolean {
  return error instanceof Error && 'code' in error && RETRYABLE.has(String((error as { code: unknown }).code))
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Run a filesystem mutation, retrying only the transient codes Windows raises
 * while a writer or an indexer still holds a handle.
 *
 * The backend keeps no lock on the log between appends (verified: an exclusive
 * open succeeds on every log, including a live one), so these retries exist for
 * antivirus and indexer interference rather than for harness locking.
 *
 * @param operation - the mutation to attempt.
 * @returns nothing once an attempt succeeds.
 * @throws the last error when every attempt fails or the error is not transient.
 */
export async function mutateWithRetry(operation: () => Promise<void>): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt < MUTATION_ATTEMPTS; attempt += 1) {
    try {
      await operation()
      return
    } catch (error) {
      lastError = error
      if (!isRetryable(error)) throw error
      await delay(MUTATION_BACKOFF_MS * (attempt + 1))
    }
  }
  throw lastError
}

/** List the project directories directly under the session root. */
export async function listProjectDirectories(layout: HarnessLayout): Promise<ProjectDirectory[]> {
  let entries
  try {
    entries = await readdir(layout.sessionsRoot, { withFileTypes: true })
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as { code: unknown }).code === 'ENOENT') return []
    throw error
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, path: join(layout.sessionsRoot, entry.name) }))
}

/**
 * Locate every on-disk session directory for one id.
 *
 * Scans all project directories rather than computing one from the header's
 * cwd, because `projectKey` is lossy and a header may live in a directory that
 * no longer matches its recorded cwd. More than one match is the duplicate-id
 * anomaly the backend itself refuses to resolve (`findLog`), and the caller
 * must treat it as an error rather than guess.
 *
 * @param layout - resolved harness paths.
 * @param sessionId - the session id to locate.
 * @returns absolute session directory paths, possibly empty.
 */
export async function findSessionDirectories(layout: HarnessLayout, sessionId: string): Promise<string[]> {
  const segment = encodeSegment(sessionId)
  const matches: string[] = []
  for (const project of await listProjectDirectories(layout)) {
    const candidate = join(project.path, segment)
    try {
      if ((await stat(candidate)).isDirectory()) matches.push(candidate)
    } catch {
      // Absent in this project directory; keep scanning the others.
    }
  }
  return matches
}

/**
 * Remove a session directory tree.
 *
 * Removes the *whole* directory, not just the current generation file: it also
 * holds older generations (`session.jsonl.zstd`, `session.vN.jsonl.zstd`) and,
 * on POSIX, a lock sidecar.
 *
 * @param directory - absolute session directory.
 */
export async function removeSessionDirectory(directory: string): Promise<void> {
  await mutateWithRetry(async () => {
    await rm(directory, { recursive: true, force: true })
  })
}

/**
 * Remove a project directory once it holds no session directories.
 *
 * Purely cosmetic: an empty project directory yields no phantom row, so leaving
 * it is harmless. Failures are the caller's to ignore.
 *
 * @param project - the project directory to reconsider.
 * @returns true when the directory was removed.
 */
export async function pruneProjectDirectory(project: ProjectDirectory): Promise<boolean> {
  try {
    const remaining = await readdir(project.path)
    if (remaining.length > 0) return false
    await mutateWithRetry(async () => {
      await rm(project.path, { recursive: true, force: true })
    })
    return true
  } catch {
    return false
  }
}

/**
 * Absolute path of one session's projection-cache checkpoint document.
 *
 * Used only as a fallback: the table API is the sanctioned removal because it
 * keeps the live in-memory domain coherent, but it is a no-op for a key the
 * in-memory table does not hold, in which case the file itself still has to go.
 *
 * @param layout - resolved harness paths.
 * @param sessionId - the session id.
 * @returns the absolute per-record document path.
 */
export function projectionRecordPath(layout: HarnessLayout, sessionId: string): string {
  return join(layout.home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
}

/** Absolute path of the shared third-party session history cache document. */
export function historyCachePath(layout: HarnessLayout): string {
  return join(layout.home, 'dsh-session-plugin-history-cache.json')
}

/**
 * Drop entries for deleted sessions from the shared history-cache document.
 *
 * The file is one shared document keyed by session under a `sessions` object, so
 * it is edited in place and never deleted. Its writer is a third-party plugin
 * that is not installed in this profile, so absence and malformed content are
 * both tolerated: this is opportunistic cleanup, never a reason to fail a
 * delete.
 *
 * @param layout - resolved harness paths.
 * @param sessionIds - ids to drop.
 * @returns the number of keys removed.
 */
export async function pruneHistoryCache(layout: HarnessLayout, sessionIds: readonly string[]): Promise<number> {
  if (sessionIds.length === 0) return 0
  const file = historyCachePath(layout)
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return 0
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 0
  const document = parsed as Record<string, unknown>
  const sessions = document['sessions']
  if (typeof sessions !== 'object' || sessions === null || Array.isArray(sessions)) return 0
  const bucket = sessions as Record<string, unknown>
  let removed = 0
  for (const id of sessionIds) {
    if (Object.hasOwn(bucket, id)) {
      delete bucket[id]
      removed += 1
    }
  }
  if (removed === 0) return 0
  await mutateWithRetry(async () => {
    await writeFile(file, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  })
  return removed
}
