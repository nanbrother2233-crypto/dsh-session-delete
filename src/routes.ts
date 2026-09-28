/**
 * HTTP surface for the session manager.
 *
 * The harness webserver carries no authentication and no origin policy of its
 * own (see `@deepseek-ai/dsh-host-webserver`), and one of these routes destroys
 * user data. Two consequences shape this file:
 *
 * 1. Every destructive route requires the `application/json` content type *and*
 *    a plugin-specific header. Both are non-simple requests, so a browser must
 *    preflight them; a cross-site form post or `no-cors` fetch therefore cannot
 *    reach the handler. This is the same shape other route owners rely on.
 * 2. A delete additionally requires an explicit `confirm: true` in the body, so
 *    a truncated or replayed request cannot delete anything by itself.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { DeleteOutcome, DeletePlan, SessionSummary } from './service.js'

/** Route prefix owned by this plugin. */
const PREFIX = '/api/session-delete'

/** Marker header that forces a CORS preflight on every mutating route. */
export const GUARD_HEADER = 'x-dsh-session-delete'

/** Upper bound on a request body; the payloads here are small id lists. */
const MAX_BODY_BYTES = 64 * 1024

/** The read/plan/execute capabilities the routes expose. */
export interface SessionDeleteRoutes {
  list(): Promise<readonly SessionSummary[]>
  plan(ids: readonly string[], currentSessionId: string | undefined): Promise<DeletePlan>
  execute(ids: readonly string[], currentSessionId: string | undefined): Promise<readonly DeleteOutcome[]>
}

/** One registered route, mirroring the webserver's `register` contract. */
export interface RouteRegistration {
  readonly kind: 'exact'
  readonly path: string
  readonly handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>
}

/** Send a JSON response. */
function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8')
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
  })
  response.end(body)
}

/** Read a small JSON body, rejecting anything oversized or mislabelled. */
async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers['content-type'] ?? ''
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'content-type must be application/json')
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    total += buffer.byteLength
    if (total > MAX_BODY_BYTES) throw new HttpError(413, 'request body too large')
    chunks.push(buffer)
  }
  if (total === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'request body is not valid JSON')
  }
}

/** A failure that maps to one HTTP status. */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

/** Extract a validated id list from an untrusted body. */
function readIds(body: unknown): string[] {
  if (typeof body !== 'object' || body === null) throw new HttpError(400, 'body must be an object')
  const ids = (body as { ids?: unknown }).ids
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || id.length === 0)) {
    throw new HttpError(400, 'ids must be a non-empty array of non-empty strings')
  }
  if (ids.length === 0) throw new HttpError(400, 'ids must not be empty')
  if (ids.length > 512) throw new HttpError(413, 'too many ids in one request')
  return [...new Set(ids as string[])]
}

/** Extract the optional session the caller is currently viewing. */
function readCurrentSessionId(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const value = (body as { currentSessionId?: unknown }).currentSessionId
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Build the plugin's route table.
 *
 * Returned rather than registered so the caller can wrap each one in a Cordis
 * effect and get disposers back.
 *
 * @param routes - the session-manager capabilities to expose.
 * @param projectDirectoryName - `~/.dsh` vs `$DSH_HOME`, for display only.
 * @returns one registration per route.
 */
export function sessionDeleteRoutes(routes: SessionDeleteRoutes, projectDirectoryName: string): readonly RouteRegistration[] {
  const requireGuard = (request: IncomingMessage): void => {
    if (request.headers[GUARD_HEADER] !== '1') {
      throw new HttpError(400, `missing ${GUARD_HEADER}: 1 guard header`)
    }
  }

  return [
    {
      kind: 'exact',
      path: `${PREFIX}/sessions`,
      handler: async (_request, response) => {
        sendJson(response, 200, { home: projectDirectoryName, sessions: await routes.list() })
      },
    },
    {
      kind: 'exact',
      path: `${PREFIX}/preview`,
      handler: async (request, response) => {
        requireGuard(request)
        const body = await readJsonBody(request)
        const plan = await routes.plan(readIds(body), readCurrentSessionId(body))
        sendJson(response, 200, plan)
      },
    },
    {
      kind: 'exact',
      path: `${PREFIX}/delete`,
      handler: async (request, response) => {
        requireGuard(request)
        const body = await readJsonBody(request)
        if ((body as { confirm?: unknown }).confirm !== true) {
          throw new HttpError(400, 'confirm: true is required')
        }
        const ids = readIds(body)
        const currentSessionId = readCurrentSessionId(body)
        // Re-plan at execution time: the preview and the confirm are separate
        // requests, so a session may have gone live in between.
        const plan = await routes.plan(ids, currentSessionId)
        if (plan.blockers.length > 0) {
          sendJson(response, 409, { plan, outcomes: [] })
          return
        }
        const outcomes = await routes.execute(plan.targets, currentSessionId)
        sendJson(response, 200, { plan, outcomes })
      },
    },
  ]
}

/** Translate a thrown value into the closest HTTP status. */
export function statusFor(error: unknown): number {
  return error instanceof HttpError ? error.status : 500
}

/**
 * Turn a route into the handler the webserver actually registers.
 *
 * Handlers here throw rather than write their own failures, so one wrapper owns
 * the mapping from an exception to a response. It lives beside the routes it
 * protects rather than in the plugin body because the mapping is part of the
 * HTTP contract and is asserted directly.
 *
 * A failure raised *after* the headers went out cannot be answered — the client
 * has already been promised a status — so the socket is destroyed instead of
 * writing a second, contradictory response.
 *
 * @param route - the route to wrap.
 * @param warn - sink for the diagnostic; the harness logger in production.
 * @returns a handler that never rejects.
 */
export function guardedHandler(
  route: RouteRegistration,
  warn: (message: string) => void,
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    try {
      await route.handler(request, response)
    } catch (error) {
      const status = statusFor(error)
      const message = error instanceof Error ? error.message : String(error)
      warn(`dsh-session-delete: ${route.path} failed: ${message}`)
      if (response.headersSent) {
        response.destroy()
        return
      }
      const body = Buffer.from(`${JSON.stringify({ error: message })}\n`, 'utf8')
      response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(body.byteLength),
        'cache-control': 'no-store',
      })
      response.end(body)
    }
  }
}
