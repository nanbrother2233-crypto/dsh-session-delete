/**
 * Path-segment encoding, reproduced from
 * `@deepseek-ai/dsh-session-persistence-jsonl` (`encodeSegment`,
 * `lib/index.js:852-864` and `projectKey`, `lib/index.js:874-893`).
 *
 * The backend does not export either helper, and a hard deleter must reproduce
 * `encodeSegment` byte-for-byte to locate a session directory from an id alone.
 * `projectKey` is intentionally *lossy* (separator runs collapse, the body is
 * truncated to 251 chars) and must therefore never be decoded or trusted as an
 * inverse — it is only used here as a search shortcut, never as proof.
 */

/** Safe literal code units; every other unit (including `~`) is escaped. */
const SAFE_UNIT = /^[A-Za-z0-9._-]$/

/** Escape one code unit as `~XXXX` with uppercase hex, matching the backend. */
function escapeUnit(code: number): string {
  return `~${code.toString(16).toUpperCase().padStart(4, '0')}`
}

/**
 * Encode a session id into the single filesystem segment the backend uses for
 * its session directory.
 *
 * Injective: distinct ids always produce distinct segments, so an exact
 * directory-name match is sound evidence. UUID ids pass through unchanged.
 *
 * @param raw - the id to encode; must be non-empty.
 * @returns the escaped single path segment.
 * @throws when `raw` is empty, mirroring the backend.
 */
export function encodeSegment(raw: string): string {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    out += ch !== '~' && SAFE_UNIT.test(ch) ? ch : escapeUnit(code)
  }
  return out
}

/**
 * Build the readable project-directory key for a session's cwd, matching the
 * backend's `projectKey`.
 *
 * Lossy by design: `:`, `/` and `\` collapse into a single `-`, leading dashes
 * are stripped, and the body is truncated. Two different cwds can therefore
 * share a key, which is why callers must treat a key match as a hint and
 * confirm membership by other means.
 *
 * @param cwd - the session's project directory; must be non-empty.
 * @returns a single filesystem-safe project directory name.
 * @throws when `cwd` is empty, mirroring the backend.
 */
export function projectKey(cwd: string): string {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i += 1) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && SAFE_UNIT.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += escapeUnit(code)
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}
