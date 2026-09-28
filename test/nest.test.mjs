/**
 * The session list's nesting walk.
 *
 * `parentSession` is untrusted header input and the rows handed to it are the
 * *filtered* ones, so the walk's job is not only to indent children: it has to
 * emit every row exactly once, whatever the lineage says. A cycle, a
 * self-parenting header, or a parent the search box filtered away must not cost
 * the reader a row — a hidden session here is a session nobody can delete.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { nestRows } from '../lib/nest.js'

/** Build one row with the lineage fields nesting reads. */
function row(id, parentSession) {
  return parentSession === undefined ? { id } : { id, parentSession }
}

/** Read a nesting result back as `id@depth`, the shape a failure is readable in. */
function shape(rows) {
  return rows.map(({ row: nested, depth }) => `${nested.id}@${depth}`)
}

test('nestRows puts children directly under their parent', () => {
  const rows = [row('parent'), row('other'), row('child-b', 'parent'), row('child-a', 'parent')]

  assert.deepEqual(shape(nestRows(rows)), ['parent@0', 'child-b@1', 'child-a@1', 'other@0'])
})

test('nestRows keeps sibling order and descends through grandchildren', () => {
  const rows = [
    row('root'),
    row('a', 'root'),
    row('a1', 'a'),
    row('a2', 'a'),
    row('b', 'root'),
    row('b1', 'b'),
  ]

  // Depth-first, so a whole subtree reads as one block, and a parent always
  // precedes the children it would take with it on a delete.
  assert.deepEqual(shape(nestRows(rows)), ['root@0', 'a@1', 'a1@2', 'a2@2', 'b@1', 'b1@2'])
})

test('nestRows floats a child whose parent is not in the listing', () => {
  // The parent may have been filtered away by the search box, or already
  // deleted. The child is still deletable, so it still has to be drawn.
  const rows = [row('orphan', 'session-gone'), row('loose')]

  assert.deepEqual(shape(nestRows(rows)), ['orphan@0', 'loose@0'])
})

test('nestRows treats a self-parenting header as a root', () => {
  assert.deepEqual(shape(nestRows([row('self', 'self')])), ['self@0'])
})

test('nestRows breaks a parent cycle instead of dropping it', () => {
  const rows = [row('a', 'b'), row('b', 'a'), row('c')]

  const nested = nestRows(rows)
  assert.deepEqual(
    [...nested.map(({ row: entry }) => entry.id)].sort(),
    ['a', 'b', 'c'],
    'every row survives a cycle',
  )
  assert.equal(nested.length, rows.length, 'and none is emitted twice')
  // Whichever member is unvisited after the rooted pass is the one that gets
  // floated — either way the cycle is visible to the reader.
  assert.ok(nested.every(({ depth }) => depth === 0 || depth === 1))
})

test('nestRows emits every row exactly once', () => {
  const rows = [
    row('root'),
    row('a', 'root'),
    row('b', 'a'),
    row('c', 'b'),
    row('self', 'self'),
    row('orphan', 'root-of-another-listing'),
    row('dupe', 'root'),
  ]

  const nested = nestRows(rows)
  assert.equal(nested.length, rows.length)
  assert.equal(new Set(nested.map(({ row: entry }) => entry.id)).size, rows.length)
})

test('nestRows returns nothing for an empty listing', () => {
  assert.deepEqual(nestRows([]), [])
})
