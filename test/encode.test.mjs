/**
 * Fixtures here are real directory names observed under
 * `C:\Users\nan ge\.dsh\sessions\`, so these assertions pin the encoder to the
 * backend's actual on-disk spelling rather than to a re-derivation of it.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { encodeSegment, projectKey } from '../lib/encode.js'

test('encodeSegment leaves UUID session ids untouched', () => {
  assert.equal(encodeSegment('b7fdaf6c-af8b-4543-a326-fb2565d71d62'), 'b7fdaf6c-af8b-4543-a326-fb2565d71d62')
})

test('encodeSegment escapes a space as ~0020 (uppercase hex)', () => {
  assert.equal(encodeSegment('nan ge'), 'nan~0020ge')
})

test('encodeSegment escapes the escape character itself', () => {
  assert.equal(encodeSegment('a~b'), 'a~007Eb')
})

test('encodeSegment refuses the traversal segments', () => {
  assert.equal(encodeSegment('.'), '~002E')
  assert.equal(encodeSegment('..'), '~002E~002E')
})

test('encodeSegment rejects an empty id', () => {
  assert.throws(() => encodeSegment(''), /empty path segment/)
})

test('encodeSegment is injective over the ids a deleter must distinguish', () => {
  const ids = ['a b', 'a~0020b', 'a/b', 'a\\b', 'a:b', '.', '..', 'ab']
  const encoded = ids.map((id) => encodeSegment(id))
  assert.equal(new Set(encoded).size, ids.length, `collision among ${JSON.stringify(encoded)}`)
})

test('projectKey reproduces the observed project directory for a plain Windows path', () => {
  assert.equal(projectKey('D:\\Tools\\dsh-session-delete'), '--D-Tools-dsh-session-delete--')
})

test('projectKey reproduces the observed project directory for a path with a space', () => {
  assert.equal(
    projectKey('C:\\Users\\nan ge\\PycharmProjects\\HyperD_PM25_baseline_reproduction'),
    '--C-Users-nan~0020ge-PycharmProjects-HyperD_PM25_baseline_reproduction--',
  )
})

test('projectKey collapses a separator run into one dash', () => {
  assert.equal(projectKey('C:\\\\a'), '--C-a--')
})
