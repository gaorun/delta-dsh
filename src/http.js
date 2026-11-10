/**
 * The band's same-origin API, served from the Harness web server.
 *
 * A third-party Host plugin cannot define Remote methods (that needs typert
 * codegen), and the Client half must not import Harness Client packages. The
 * band therefore speaks plain HTTP on the app's own origin:
 *
 * - `GET  /delta-dsh-api/status?session=<id>`  the current snapshot
 * - `POST /delta-dsh-api/band/press`           `{session, generation, actionId}`
 *
 * The browser polls `status` while its band is mounted and redraws on a changed
 * generation: the Harness web server finishes a prefix route's response when
 * its handler returns, so a Server-Sent Events stream cannot stay open through
 * it. A snapshot is `{ generation, tree: Node[] | null, status?, error? }`,
 * where a node is `{type: 'Box'|'Text'|'Button'|'Link', props, children,
 * actionId?}`. A press answers `{ok, stale?, snapshot}`.
 */
import { readBody, sendJson } from './http-util.js'

/** A request from the local page: loopback, or this app's own Origin header. */
function isLocalPage(ctx, req) {
  const remote = req.socket?.remoteAddress ?? ''
  if (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1' || remote === '') return true
  const origin = req.headers.origin
  if (origin === undefined) return false
  try {
    return ctx.webServer.getOrigin?.() === origin
  } catch {
    return false
  }
}

/**
 * @param ctx Harness plugin context (`webServer` injected).
 * @param options.hub a `SurfaceHub`, or a function returning the current one.
 * @param options.draw `(sessionId) => Promise<void>` redraws one session's band.
 * @param options.base route prefix.
 * @returns the web server disposer.
 */
export function registerBandRoutes(ctx, { hub, draw, base = '/delta-dsh-api' }) {
  const hubOf = typeof hub === 'function' ? hub : () => hub
  return ctx.webServer.register({
    kind: 'prefix',
    path: base,
    async handler(req, res) {
      const url = new URL(req.url ?? '/', 'http://local')
      const rest = url.pathname.slice(base.length) || '/'
      // The band shows the session's link, participants and sync failures, so it
      // is served only to the local page.
      if (!isLocalPage(ctx, req)) return sendJson(res, 403, { error: 'local request required' })
      try {
        if (rest === '/status' && req.method === 'GET') {
          const session = url.searchParams.get('session') ?? ''
          if (!session) return sendJson(res, 400, { error: 'session is required' })
          await draw(session)
          const snapshot = hubOf().current(session)
          const error = hubOf().lastDrawError
          return sendJson(res, 200, error === undefined ? snapshot : { ...snapshot, error })
        }
        if (rest === '/band/press' && req.method === 'POST') {
          const body = JSON.parse(await readBody(req, 64 * 1024))
          if (typeof body.session !== 'string' || typeof body.actionId !== 'string' || typeof body.generation !== 'number')
            return sendJson(res, 400, { error: 'invalid press' })
          const result = await hubOf().press(body.session, body.generation, body.actionId)
          if (result.ok || result.stale) await draw(body.session)
          return sendJson(res, 200, result)
        }
        return sendJson(res, 404, { error: 'not found' })
      } catch (error) {
        ctx.logger?.warn?.(`delta-dsh: band request failed: ${error instanceof Error ? error.message : String(error)}`)
        if (!res.headersSent) {
          return sendJson(res, 500, {
            error: 'delta-dsh band failed',
            detail: error instanceof Error ? error.message : String(error),
          })
        }
        try { res.end() } catch {}
      }
    },
  })
}
