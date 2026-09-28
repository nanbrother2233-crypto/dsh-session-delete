/**
 * Dictionary parity for the browser half.
 *
 * The client source declares its `zh` dictionary as the key-set source of truth
 * and documents `en` as "checked complete against" it — but nothing checked. A
 * key present on one side and missing on the other renders as a raw key like
 * `row.untitled` in one language only, which is invisible to every other test
 * here because the dictionaries are module-local and never leave the bundle.
 *
 * The dictionaries are read out of the source text rather than imported, since
 * `src/client/` has no Node-consumable build.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SOURCE = fileURLToPath(new URL('../src/client/index.tsx', import.meta.url))

/**
 * Extract the `'key': value` entries of one dictionary literal.
 *
 * @param source - the client source text.
 * @param marker - the declaration to start at.
 * @returns the declared keys, in source order.
 */
function keysOf(source, marker) {
  const start = source.indexOf(marker)
  assert.notEqual(start, -1, `no dictionary declared as ${marker}`)
  const end = source.indexOf('\n}\n', start)
  assert.notEqual(end, -1, `unterminated dictionary ${marker}`)
  return [...source.slice(start, end).matchAll(/'([^']+)':/g)].map((match) => match[1])
}

test('the zh and en dictionaries carry exactly the same keys', async () => {
  const source = await readFile(SOURCE, 'utf8')
  const zh = keysOf(source, 'const zh = {')
  const en = keysOf(source, 'const en = {')

  assert.ok(zh.length > 20, `parsed only ${String(zh.length)} keys — the extraction broke, not the dictionaries`)
  assert.deepEqual([...en].sort(), [...zh].sort(), 'a key is translated on one side only')
})

test('no dictionary declares the same key twice', async () => {
  const source = await readFile(SOURCE, 'utf8')
  for (const marker of ['const zh = {', 'const en = {']) {
    const keys = keysOf(source, marker)
    assert.equal(new Set(keys).size, keys.length, `duplicate key in ${marker}`)
  }
})
