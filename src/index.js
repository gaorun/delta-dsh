/**
 * delta-dsh: Delta for DeepSeek Harness.
 *
 * The Host half of the plugin. It runs the Delta hooks module (the unmodified
 * Claude Code mod vendored under `vendor/delta`) on a small engine shim, serves
 * the `/delta` command family through the Harness command registry, projects
 * Harness Session events into the rows Delta records, and offers the band's
 * same-origin API to the browser half in `lib/client.js`.
 *
 * Everything the port needs from the Harness arrives through `ctx`: a
 * third-party bundle cannot import `@deepseek-ai/*` packages at runtime.
 */
import { join } from 'node:path'
import { register } from '../vendor/delta/register.tsx'
import { Engine } from './engine.js'
import { Bridge, claudeToolName, toolEventFields } from './bridge.js'
import { RowProjector, turnIdOf } from './rows.js'
import { SurfaceHub } from './surfaces.js'
import { FileStore } from './store.js'
import { registerBandRoutes } from './http.js'
import { dataDir } from './paths.js'

/** The package name; the patch row, the Client module id and the Locale namespace use it. */
export const name = 'delta-dsh'

/** Harness services the plugin cannot run without. */
export const inject = ['agents', 'commands', 'subprocess', 'userQuestions', 'workingDirectory', 'webServer']

/** Root of this installed package (vendored manifest and locale files live here). */
const pluginRoot = new URL('..', import.meta.url).pathname

/** The root agent a session belongs to; subagent Sessions are projected separately. */
function isRootSession(session) {
  return session?.header?.parentSession === undefined
}

export function apply(ctx) {
  const logger = ctx.logger ?? console
  const hub = new SurfaceHub()
  const store = new FileStore(join(dataDir(), 'store'))
  const config = {
    hookTimeoutMs: 10_000,
    bandColumns: 120,
    bandRows: 10,
  }
  const engine = new Engine({
    pluginName: 'delta',
    pluginRoot,
    ops: undefined,
    logger,
    hookTimeoutMs: config.hookTimeoutMs,
  })
  const rows = new RowProjector({ engine, bridge: undefined, logger })
  const bridge = new Bridge(ctx, {
    engine,
    hub,
    store,
    rows,
    pluginName: 'delta',
    pluginRoot,
    logger,
    config,
  })
  engine.ops = bridge
  rows.bridge = bridge
  bridge.setEngine(engine)

  // Delta's own hooks module registers its `on(...)` handlers here, once.
  register((event, matcherOrHandler, maybeHandler) => engine.on(event, matcherOrHandler, maybeHandler))

  /** Dispatch one Harness lifecycle event into Delta's hooks. */
  const dispatch = (agent, session, event, input, bottom) =>
    engine.dispatch(event, Object.freeze(input), bottom, {
      agent,
      session,
      signal: new AbortController().signal,
    })

  /** Start Delta's view of one root Session: its command menu, then its own start hook. */
  const startRootSession = async (agent) => {
    const session = agent.session
    const cwd = bridge.cwdOf(session)
    rows.state(String(session.id))
    await bridge.ensureCommands(agent)
    await dispatch(agent, session, 'session.start',
      { cwd, surface: 'terminal', isInteractive: true },
      async () => ({ cwd }))
  }

  // A root session starting: Delta activates recording, registers commands and
  // decides whether this checkout syncs.
  ctx.on('agent/created', async (payload) => {
    const { agent } = payload
    if (agent?.session === undefined || !isRootSession(agent.session)) return
    await startRootSession(agent)
  })

  // A root session ending: Delta finishes its turn bookkeeping and cleans up.
  ctx.on('agent/disposed', (payload) => {
    const agent = payload?.agent
    const session = agent?.session
    if (session === undefined || !isRootSession(session)) return
    const sessionId = String(session.id)
    void dispatch(agent, session, 'session.end', { sessionId, reason: 'other' }, async () => ({ sessionId }))
      .catch((error) => logger.warn(`delta-dsh: session end failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        rows.forget(sessionId)
        hub.dispose(sessionId)
      })
  })

  // Every durable Session event is projected into Delta's row events.
  ctx.on('session/event', (session, event) => {
    if (session === undefined || !isRootSession(session)) return
    const agent = ctx.agents.get(session.id)
    if (agent === undefined) return
    void rows.handle(agent, session, event)
  })

  // Tool calls are recorded around their execution, the way Claude Code raises
  // `tool.call`; Delta's handler calls `next` and keeps the structured result.
  ctx.on('tools/execute', async (exec, next) => {
    const agent = exec.agent ?? ctx.agents.currentInitiator()
    if (agent?.session === undefined || !isRootSession(agent.session)) return await next()
    const session = agent.session
    let outcome
    const input = {
      tool: claudeToolName(exec.name),
      tool_use_id: String(exec.callId),
      ...toolEventFields(exec.name, exec.arguments),
    }
    try {
      await engine.dispatch('tool.call', Object.freeze(input), async () => {
        outcome = await next()
        if (outcome.isError) {
          return { result: outcome.error?.message ?? 'tool failed', isError: true }
        }
        return { result: outcome.value, isError: false }
      }, { agent, session, signal: exec.signal })
    } catch (error) {
      logger.warn(`delta-dsh: tool call ${exec.name} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return outcome ?? await next()
  })

  // The person's prompt is admitted before the step it starts; Delta may block it
  // while a share or join is in progress, and rewrites a hand-off's opening line.
  ctx.on('agent/pre-step', async (payload, next) => {
    const agent = payload?.agent
    const session = agent?.session
    if (session === undefined || !isRootSession(session)) return await next()
    const messages = Array.isArray(payload.messages) ? payload.messages : []
    const human = messages.filter((message) => message.role === 'user' && message.source?.kind === 'user')
    if (!human.length) return await next()
    const text = human.flatMap((message) => message.content)
      .filter((block) => block.type === 'text').map((block) => block.text).join('\n')
    if (!text.trim()) return await next()
    const turnId = payload.step > 1 ? turnIdOf(payload.turn) : undefined
    let result
    try {
      result = await engine.dispatch('prompt.submit', Object.freeze({
        text,
        context: [],
        wait: false,
        origin: { kind: 'composer' },
        ...(turnId === undefined ? {} : { turnId }),
      }), async () => ({ text }), { agent, session, signal: payload.signal })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await bridge.uiLog({ agent, session }, `Delta could not admit this prompt: ${message}`, { to: 'transcript' })
      return await next()
    }
    if (result?.drop !== undefined) {
      bridge.uiLog({ agent, session }, String(result.drop), { to: 'transcript' })
      return { kind: 'reject' }
    }
    return await next()
  })

  // The band's HTTP API and the client half itself. A process-wide owner keeps
  // one route across plugin reloads: the route reads the current instance's hub
  // and drawing, so a re-enabled plugin never collides with its predecessor.
  const owner = globalThis[Symbol.for('delta-dsh.band-owner')] ?? (globalThis[Symbol.for('delta-dsh.band-owner')] = {})
  try { owner.dispose?.() } catch {}
  owner.hub = hub
  owner.draw = (sessionId) => bridge.drawBand(sessionId)
  owner.dispose = ctx.effect(() => registerBandRoutes(ctx, {
    hub: () => owner.hub,
    draw: (sessionId) => owner.draw(sessionId),
    base: '/delta-dsh-api',
  }))

  ctx.effect(() => () => {
    void bridge.dispose()
  })

  // A plugin enabled into a running Host also serves the Sessions already open.
  for (const agent of ctx.agents.roots()) {
    if (!isRootSession(agent.session)) continue
    void startRootSession(agent).catch((error) => {
      logger.warn(`delta-dsh: could not start the open Session: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
}
