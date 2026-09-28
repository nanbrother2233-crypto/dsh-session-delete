/**
 * The destructive path, end to end, against a fixture home.
 *
 * Everything here runs inside `.scratch/test-tmp/<case>/` and never touches the
 * real `$DSH_HOME`: the layout is built explicitly rather than resolved, so a
 * mistake in these tests cannot reach a user's sessions.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { encodeSegment } from '../lib/encode.js'
import { executeDelete } from '../lib/service.js'
import { findSessionDirectories, pruneHistoryCache } from '../lib/store.js'

const TMP_ROOT = fileURLToPath(new URL('../.scratch/test-tmp/', import.meta.url))

// `mkdtemp` does not create parents.
await mkdir(TMP_ROOT, { recursive: true })

/** Every fixture built here, for one cleanup pass. */
const created = []

after(async () => {
  for (const directory of created) await rm(directory, { recursive: true, force: true })
})

/** Build a fixture harness home with the given on-disk sessions. */
async function fixture(sessions) {
  const home = await mkdtemp(join(TMP_ROOT, 'case-'))
  created.push(home)
  const layout = { home, sessionsRoot: join(home, 'sessions') }
  for (const session of sessions) {
    const directory = join(layout.sessionsRoot, session.project, encodeSegment(session.id))
    await mkdir(directory, { recursive: true })
    for (const generation of session.generations ?? ['session.v3.jsonl.zstd']) {
      await writeFile(join(directory, generation), 'log', 'utf8')
    }
  }
  return { home, layout }
}

/** Write a projection-cache checkpoint document for one session. */
async function projection(layout, id) {
  const directory = join(layout.home, 'storages', 'session_projcache', 'sessions')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, `${id}.json`), '{"id":"' + id + '"}', 'utf8')
}

/** Write the shared third-party history cache with the given session keys. */
async function historyCache(layout, ids) {
  const sessions = Object.fromEntries(ids.map((id) => [id, { title: id }]))
  await writeFile(join(layout.home, 'dsh-session-plugin-history-cache.json'), JSON.stringify({ sessions }), 'utf8')
}

/** A host stub that reports nothing live and records what it was told. */
function host(overrides = {}) {
  const removed = []
  const warnings = []
  return {
    removed,
    warnings,
    listSessions: async () => [],
    readTitles: async (ids) => ids.map(() => undefined),
    isLive: () => false,
    isPending: () => false,
    storageDomain: undefined,
    workspaceEntities: () => [],
    emitRemoved: (id) => {
      removed.push(id)
    },
    warn: (message) => {
      warnings.push(message)
    },
    ...overrides,
  }
}

test('executeDelete removes the whole session directory, every generation', async () => {
  const { layout } = await fixture([
    { id: 'doomed', project: '--proj--', generations: ['session.v3.jsonl.zstd', 'session.v2.jsonl.zstd'] },
    { id: 'kept', project: '--proj--' },
  ])
  const doomed = join(layout.sessionsRoot, '--proj--', 'doomed')
  const kept = join(layout.sessionsRoot, '--proj--', 'kept')
  assert.ok(existsSync(join(doomed, 'session.v2.jsonl.zstd')), 'fixture holds an older generation')

  const outcomes = await executeDelete(['doomed'], layout, host())

  assert.deepEqual(outcomes, [
    // No projection checkpoint was written for this fixture, and the outcome
    // must say so rather than claim a cleanup that never happened.
    { id: 'doomed', removed: true, directories: [doomed], projectionRemoved: false, historyEntryRemoved: false },
  ])
  assert.equal(existsSync(doomed), false, 'the directory is gone, not merely emptied')
  assert.equal(existsSync(kept), true, 'an unrelated session survives')
})

test('executeDelete drops the projection checkpoint and the history-cache entry', async () => {
  const { layout } = await fixture([{ id: 'doomed', project: '--proj--' }])
  await projection(layout, 'doomed')
  await projection(layout, 'other')
  await historyCache(layout, ['doomed', 'other'])

  const outcomes = await executeDelete(['doomed'], layout, host())

  assert.equal(outcomes[0].projectionRemoved, true)
  assert.equal(outcomes[0].historyEntryRemoved, true)
  assert.equal(existsSync(join(layout.home, 'storages', 'session_projcache', 'sessions', 'doomed.json')), false)
  assert.equal(existsSync(join(layout.home, 'storages', 'session_projcache', 'sessions', 'other.json')), true)

  const cache = JSON.parse(await readFile(join(layout.home, 'dsh-session-plugin-history-cache.json'), 'utf8'))
  assert.deepEqual(Object.keys(cache.sessions), ['other'], 'the shared document is edited, never removed')
})

test('executeDelete refuses a duplicate id instead of guessing which copy to remove', async () => {
  const { layout } = await fixture([
    { id: 'twin', project: '--proj-a--' },
    { id: 'twin', project: '--proj-b--' },
  ])
  const outcomes = await executeDelete(['twin'], layout, host())

  assert.equal(outcomes[0].removed, false)
  assert.match(outcomes[0].error, /duplicate session id on disk in 2 project directories/)
  assert.equal(outcomes[0].directories.length, 2)
  assert.ok(existsSync(join(layout.sessionsRoot, '--proj-a--', 'twin')))
  assert.ok(existsSync(join(layout.sessionsRoot, '--proj-b--', 'twin')))
})

test('executeDelete re-checks liveness and refuses a session that came alive', async () => {
  const { layout } = await fixture([{ id: 'doomed', project: '--proj--' }])
  const directory = join(layout.sessionsRoot, '--proj--', 'doomed')

  const outcomes = await executeDelete(['doomed'], layout, host({ isLive: (id) => id === 'doomed' }))

  assert.equal(outcomes[0].removed, false)
  assert.match(outcomes[0].error, /became live/)
  assert.equal(existsSync(directory), true)
})

test('executeDelete reports per-id outcomes so one failure does not abandon the rest', async () => {
  const { layout } = await fixture([
    { id: 'first', project: '--proj--' },
    { id: 'second', project: '--proj--' },
  ])

  const outcomes = await executeDelete(['first', 'second'], layout, host({ isLive: (id) => id === 'first' }))

  assert.deepEqual(
    outcomes.map((outcome) => [outcome.id, outcome.removed]),
    [
      ['first', false],
      ['second', true],
    ],
  )
  assert.equal(existsSync(join(layout.sessionsRoot, '--proj--', 'second')), false)
})

test('a session id is encoded to one path segment, so it cannot escape its project directory', async () => {
  const hostile = ['../../escape', 'a/b', 'a\\b', '.', '..']
  for (const id of hostile) {
    const segment = encodeSegment(id)
    assert.equal(segment.includes('/'), false, `${id} produced a separator`)
    assert.equal(segment.includes('\\'), false, `${id} produced a separator`)
    assert.notEqual(segment, '.')
    assert.notEqual(segment, '..')
  }

  const { layout } = await fixture([{ id: 'kept', project: '--proj--' }])
  assert.deepEqual(await findSessionDirectories(layout, '../../escape'), [])
  assert.deepEqual(await findSessionDirectories(layout, '..'), [])
  assert.equal(existsSync(layout.sessionsRoot), true, 'the session root is untouched')
})

test('pruneHistoryCache tolerates an absent and a malformed document', async () => {
  const { home, layout } = await fixture([])
  assert.equal(await pruneHistoryCache(layout, ['x']), 0, 'absent file')

  await writeFile(join(home, 'dsh-session-plugin-history-cache.json'), 'not json at all', 'utf8')
  assert.equal(await pruneHistoryCache(layout, ['x']), 0, 'unparseable file')

  await writeFile(join(home, 'dsh-session-plugin-history-cache.json'), '{"sessions":[]}', 'utf8')
  assert.equal(await pruneHistoryCache(layout, ['x']), 0, 'sessions is not an object')
})

test('pruneHistoryCache leaves the document alone when no key matches', async () => {
  const { home, layout } = await fixture([])
  await historyCache(layout, ['other'])
  const before = await readFile(join(home, 'dsh-session-plugin-history-cache.json'), 'utf8')

  assert.equal(await pruneHistoryCache(layout, ['absent']), 0)
  assert.equal(await readFile(join(home, 'dsh-session-plugin-history-cache.json'), 'utf8'), before)
})
