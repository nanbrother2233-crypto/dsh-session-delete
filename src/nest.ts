/**
 * Session-list nesting.
 *
 * This manager is the only surface that lists delegated child sessions at all —
 * the built-in sidebar hides every `origin: "subagent"` row — and one delete
 * takes a parent's whole subtree with it. Drawing children as siblings of their
 * parent, each labelled with whose child it is, makes the reader reconstruct
 * the family from text; indenting them under the parent shows the subtree a
 * selection actually covers.
 *
 * The walk is defensive on purpose. `parentSession` is untrusted header input,
 * and the list it runs on is the *filtered* one, so a child can outlive its
 * parent's visibility. Every input row is therefore emitted exactly once: a row
 * that cannot be attached anywhere is drawn at depth 0 rather than dropped,
 * because dropping one would hide a session that can still be deleted.
 *
 * The module is shared: the browser half inlines it, and `lib/nest.js` is what
 * the tests import.
 */

/** The lineage a row must expose to be nested. */
export interface NestableRow {
  readonly id: string
  readonly parentSession?: string | undefined
}

/** One row as the list draws it, plus how deep it sits under its parent. */
export interface NestedRow<T> {
  readonly row: T
  readonly depth: number
}

/**
 * Flatten rows into depth-first display order, children under their parent.
 *
 * Siblings keep their input order (the host's newest-first order), a parent is
 * always emitted before its children, and the depth is the number of edges to
 * the nearest *visible* ancestor.
 *
 * @param rows - the rows to draw, in the order the caller wants siblings in.
 * @returns every input row exactly once, with its depth.
 */
export function nestRows<T extends NestableRow>(rows: readonly T[]): readonly NestedRow<T>[] {
  const present = new Set(rows.map((row) => row.id))
  const childrenOf = new Map<string, T[]>()
  const roots: T[] = []
  for (const row of rows) {
    const parent = row.parentSession
    // A parent outside this listing — filtered away by the search box, or in
    // another working directory — cannot hold the row, and a self-parenting
    // header is not lineage at all.
    if (parent === undefined || parent === row.id || !present.has(parent)) {
      roots.push(row)
      continue
    }
    const bucket = childrenOf.get(parent)
    if (bucket === undefined) childrenOf.set(parent, [row])
    else bucket.push(row)
  }

  const out: NestedRow<T>[] = []
  const emitted = new Set<string>()
  const walk = (row: T, depth: number): void => {
    if (emitted.has(row.id)) return
    emitted.add(row.id)
    out.push({ row, depth })
    for (const child of childrenOf.get(row.id) ?? []) walk(child, depth + 1)
  }
  for (const root of roots) walk(root, 0)
  // Rows still unvisited sit in a parent cycle with no visible entry point.
  // They are unattachable, not invisible: drawing them at depth 0 is what keeps
  // the second pass from silently swallowing deletable sessions.
  for (const row of rows) walk(row, 0)
  return out
}
