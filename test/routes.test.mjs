/**
 * The HTTP surface's safety invariants.
 *
 * These routes destroy user data and the harness webserver carries no
 * authentication, so the guards are the whole defence: a mutating request must
 * arrive as JSON (so a browser has to preflight it) with the plugin's marker
 * header, and a delete must additionally carry an explicit `confirm: true`.
 *
 * Every request goes through {@link guardedHandler} — the same wrapper the
 * plugin registers — with mock request/response objects. No server, no sockets,
 * no filesystem.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { GUARD_HEADER, guardedHandler, sessionDeleteRoutes, statusFor } from '../lib/routes.js'

/** A minimal async-iterable request carrying a JSON body. */
function request({ headers = {}, body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  return {
    headers: { 'content-type': 'application/json', ...headers },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/** A response recorder exposing what was written. */
function response() {
  return {
    status: undefined,
    headers: undefined,
    headersSent: false,
    destroyed: false,
    body: undefined,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
      this.headersSent = true
    },
    end(body) {
      this.body = body === undefined ? undefined : body.toString('utf8')
    },
    destroy() {
      this.destroyed = true
    },
  }
}

/** Find one route by path suffix. */
function route(table, suffix) {
  const found = table.find((entry) => entry.path.endsWith(suffix))
  assert.ok(found !== undefined, `no route for ${suffix}`)
  return found
}

/** Route table plus a call log, so a test can prove a route was never reached. */
function routes(plan = { targets: ['a'], expanded: [], blockers: [] }) {
  const calls = { list: 0, plan: 0, execute: 0, executed: [] }
  return {
    calls,
    table: sessionDeleteRoutes(
      {
        list: async () => {
          calls.list += 1
          return []
        },
        plan: async () => {
          calls.plan += 1
          return plan
        },
        execute: async (ids) => {
          calls.execute += 1
          calls.executed.push([...ids])
          return ids.map((id) => ({
            id,
            removed: true,
            directories: [],
            projectionRemoved: false,
            historyEntryRemoved: false,
          }))
        },
      },
      '~/.dsh',
    ),
  }
}

/**
 * Dispatch one request the way the plugin does.
 *
 * @returns the response, plus every warning the wrapper emitted.
 */
async function invoke(table, suffix, req) {
  const warnings = []
  const res = response()
  await guardedHandler(route(table, suffix), (message) => {
    warnings.push(message)
  })(req, res)
  return { res, warnings, json: res.body === undefined ? undefined : JSON.parse(res.body) }
}

test('the route table is exactly the three documented paths, all exact matches', () => {
  const { table } = routes()
  assert.deepEqual(
    table.map((entry) => [entry.kind, entry.path]),
    [
      ['exact', '/api/session-delete/sessions'],
      ['exact', '/api/session-delete/preview'],
      ['exact', '/api/session-delete/delete'],
    ],
  )
})

test('GET /sessions is not guarded: it only reads', async () => {
  const { table, calls } = routes()
  const { res, json } = await invoke(table, '/sessions', request())

  assert.equal(res.status, 200)
  assert.deepEqual(json, { home: '~/.dsh', sessions: [] })
  assert.equal(calls.list, 1)
})

test('POST /preview without the marker header is refused, and nothing is planned', async () => {
  const { table, calls } = routes()
  const { res, warnings, json } = await invoke(table, '/preview', request({ body: { ids: ['a'] } }))

  assert.equal(res.status, 400)
  assert.match(json.error, new RegExp(GUARD_HEADER))
  assert.equal(calls.plan, 0, 'a cross-site request must not even reach the planner')
  assert.equal(warnings.length, 1, 'a refused request is still diagnosed')
  assert.match(warnings[0], /\/api\/session-delete\/preview failed/)
})

test('POST /preview with the wrong marker value is refused', async () => {
  const { table, calls } = routes()
  const { res } = await invoke(
    table,
    '/preview',
    request({ headers: { [GUARD_HEADER]: 'true' }, body: { ids: ['a'] } }),
  )

  assert.equal(res.status, 400)
  assert.equal(calls.plan, 0)
})

test('a non-JSON content type is refused with 415 before any planning', async () => {
  const { table, calls } = routes()
  const { res } = await invoke(
    table,
    '/preview',
    request({ headers: { [GUARD_HEADER]: '1', 'content-type': 'text/plain' }, body: { ids: ['a'] } }),
  )

  assert.equal(res.status, 415)
  assert.equal(calls.plan, 0)
})

test('POST /delete without the marker header is refused and executes nothing', async () => {
  const { table, calls } = routes()
  const { res } = await invoke(table, '/delete', request({ body: { ids: ['a'], confirm: true } }))

  assert.equal(res.status, 400)
  assert.equal(calls.execute, 0)
})

test('POST /delete without confirm is refused and executes nothing', async () => {
  const { table, calls } = routes()
  const { res, json } = await invoke(
    table,
    '/delete',
    request({ headers: { [GUARD_HEADER]: '1' }, body: { ids: ['a'] } }),
  )

  assert.equal(res.status, 400)
  assert.match(json.error, /confirm: true is required/)
  assert.equal(calls.execute, 0)
})

test('POST /delete with confirm: false is refused', async () => {
  const { table, calls } = routes()
  const { res } = await invoke(
    table,
    '/delete',
    request({ headers: { [GUARD_HEADER]: '1' }, body: { ids: ['a'], confirm: false } }),
  )

  assert.equal(res.status, 400)
  assert.equal(calls.execute, 0)
})

test('POST /delete with no ids is refused', async () => {
  const { table, calls } = routes()
  const { res } = await invoke(
    table,
    '/delete',
    request({ headers: { [GUARD_HEADER]: '1' }, body: { ids: [], confirm: true } }),
  )

  assert.equal(res.status, 400)
  assert.equal(calls.plan, 0)
  assert.equal(calls.execute, 0)
})

test('POST /delete with a non-string id is refused', async () => {
  const { table, calls } = routes()
  const { res } = await invoke(
    table,
    '/delete',
    request({ headers: { [GUARD_HEADER]: '1' }, body: { ids: [{ toString: 'a' }], confirm: true } }),
  )

  assert.equal(res.status, 400)
  assert.equal(calls.plan, 0)
})

test('a blocked plan answers 409 and executes nothing', async () => {
  const plan = { targets: [], expanded: [], blockers: [{ id: 'a', reason: 'live' }] }
  const { table, calls } = routes(plan)
  const { res, json } = await invoke(
    table,
    '/delete',
    request({ headers: { [GUARD_HEADER]: '1' }, body: { ids: ['a'], confirm: true } }),
  )

  assert.equal(res.status, 409)
  assert.deepEqual(json, { plan, outcomes: [] })
  assert.equal(calls.execute, 0, 'a blocker must stop the run, not trim it')
})

test('a clean delete re-plans, executes the fresh targets, and reports both', async () => {
  const plan = { targets: ['child', 'parent'], expanded: ['child'], blockers: [] }
  const { table, calls } = routes(plan)
  const { res, json } = await invoke(
    table,
    '/delete',
    request({ headers: { [GUARD_HEADER]: '1' }, body: { ids: ['parent'], confirm: true, currentSessionId: 'other' } }),
  )

  assert.equal(res.status, 200)
  assert.deepEqual(json.plan, plan)
  assert.deepEqual(json.outcomes.map((outcome) => outcome.id), ['child', 'parent'])
  assert.equal(calls.plan, 1)
  assert.deepEqual(calls.executed, [['child', 'parent']], 'execution uses the re-planned targets, not the request ids')
})

test('the current session id is passed through from the body', async () => {
  const seen = []
  const table = sessionDeleteRoutes(
    {
      list: async () => [],
      plan: async (ids, currentSessionId) => {
        seen.push([[...ids], currentSessionId])
        return { targets: [], expanded: [], blockers: [{ id: 'a', reason: 'current' }] }
      },
      execute: async () => [],
    },
    '~/.dsh',
  )
  const { res } = await invoke(
    table,
    '/preview',
    request({ headers: { [GUARD_HEADER]: '1' }, body: { ids: ['a'], currentSessionId: 'hosting' } }),
  )

  assert.deepEqual(seen, [[['a'], 'hosting']])
  assert.equal(res.status, 200, 'a preview reports blockers, it does not fail')
})

test('duplicate ids in one request are collapsed', async () => {
  const seen = []
  const table = sessionDeleteRoutes(
    {
      list: async () => [],
      plan: async (ids) => {
        seen.push([...ids])
        return { targets: [], expanded: [], blockers: [] }
      },
      execute: async () => [],
    },
    '~/.dsh',
  )
  await invoke(table, '/preview', request({ headers: { [GUARD_HEADER]: '1' }, body: { ids: ['a', 'a', 'b', 'a'] } }))

  assert.deepEqual(seen, [['a', 'b']])
})

test('an oversized body is refused rather than buffered', async () => {
  const { table, calls } = routes()
  const { res } = await invoke(
    table,
    '/preview',
    request({ headers: { [GUARD_HEADER]: '1' }, body: { ids: ['x'.repeat(70 * 1024)] } }),
  )

  assert.equal(res.status, 413)
  assert.equal(calls.plan, 0)
})

test('statusFor maps only its own error type to a non-500 status', () => {
  assert.equal(statusFor(new Error('boom')), 500)
  assert.equal(statusFor('boom'), 500)
})
