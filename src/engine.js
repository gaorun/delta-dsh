/**
 * The Claude Code mod engine surface Delta's hooks use, over DeepSeek Harness.
 *
 * Delta's hooks module (`vendor/delta/register.tsx`) was written for Claude
 * Code's mod API: `register(on)` installs hooks with
 * `on(event, [matcher], handler)`, each handler receives the engine interface
 * `$`, the event input `e`, and `next`, and `.catch(...)` registers its failure
 * path. This module reproduces the parts of that engine Delta needs: the hook
 * registry and chain semantics, the per-dispatch `$`, and the failure, timeout
 * and budget rules. The harness-specific behavior lives in `bridge.js` as the
 * `ops` table this engine calls.
 */
import { elementTable, normalizeChildren } from './surfaces.js'

/** Claude Code's per-hook running-time limit, in milliseconds. */
export const DEFAULT_HOOK_TIMEOUT_MS = 10_000
/** Claude Code's `.catch` handler limit, in milliseconds. */
export const DEFAULT_CATCH_TIMEOUT_MS = 1_000

/** Report a hook failure once per (event, kind, message) so a broken path is visible but not noisy. */
function createReporter(logger) {
  const seen = new Set()
  return (event, kind, error) => {
    const message = error instanceof Error ? error.message : String(error)
    const key = `${event}:${kind}:${message}`
    if (seen.has(key)) return
    seen.add(key)
    try {
      logger.warn(`delta-dsh: ${event} hook failed (${kind}): ${message}`)
    } catch {}
  }
}

/** Whether a matcher value accepts one event field, recursively for object matchers. */
export function matcherValueMatches(expected, actual) {
  if (expected instanceof RegExp) return typeof actual === 'string' && expected.test(actual)
  if (Array.isArray(expected)) return expected.some((value) => matcherValueMatches(value, actual))
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object') return false
    return Object.entries(expected).every(([key, value]) => matcherValueMatches(value, actual[key]))
  }
  return expected === actual
}

/** Whether every field of `matcher` accepts the same field of `input`. */
export function matches(matcher, input) {
  if (matcher === undefined) return true
  if (input === null || typeof input !== 'object') return false
  return Object.entries(matcher).every(([key, value]) => matcherValueMatches(value, input[key]))
}

/** Whether an `on` event pattern selects an event name. */
export function patternMatches(pattern, event) {
  if (pattern === event) return true
  if (pattern === '*') return true
  if (pattern.startsWith('!')) return !patternMatches(pattern.slice(1), event)
  if (pattern.endsWith('.*')) return event.startsWith(pattern.slice(0, -1))
  return false
}

/** A monotonic clock in milliseconds, for hook budgets only (not wall-clock timing). */
function clockMs() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()
}

/**
 * A hook's own running time, paused whenever it waits on `next` or a `$` call.
 * The engine times only a hook's own work; waiting on the harness or on a
 * model turn is free. The timer rejects the racing hook call when it fires,
 * and the hook's own promise continues in the background like the engine's.
 */
function createBudget(ms) {
  let remaining = ms
  let runningSince = clockMs()
  let paused = 0
  let timer
  let expired = false
  let rejectExpired
  const expiredPromise = new Promise((_, reject) => { rejectExpired = reject })
  expiredPromise.catch(() => {})
  function arm() {
    if (expired || remaining <= 0) {
      if (!expired) fire()
      return
    }
    timer = setTimeout(fire, Math.max(1, remaining))
    timer.unref?.()
  }
  function fire() {
    if (expired) return
    expired = true
    clearTimeout(timer)
    rejectExpired(new Error(`hook timed out after ${ms}ms`))
  }
  arm()
  return {
    pause() {
      if (paused++ === 0) {
        remaining -= clockMs() - runningSince
        clearTimeout(timer)
      }
    },
    resume() {
      if (paused === 0) return
      if (--paused === 0) {
        runningSince = clockMs()
        arm()
      }
    },
    get expired() { return expired },
    race(promise) {
      return Promise.race([promise, expiredPromise])
    },
    settle() {
      clearTimeout(timer)
      if (paused === 0) remaining -= clockMs() - runningSince
      return { expired, remaining }
    },
  }
}

/**
 * The hook registry and dispatcher.
 *
 * A dispatch runs every selected hook outermost-first, with `next` continuing
 * the rest of the chain and the engine's default at the bottom. A hook that
 * throws, times out or returns nothing is skipped (fail open); its `.catch`
 * handler may answer instead.
 */
export class Engine {
  constructor({ pluginName, pluginRoot, ops, logger, hookTimeoutMs = DEFAULT_HOOK_TIMEOUT_MS, catchTimeoutMs = DEFAULT_CATCH_TIMEOUT_MS }) {
    this.pluginName = pluginName
    this.pluginRoot = pluginRoot
    this.ops = ops
    this.logger = logger
    this.hookTimeoutMs = hookTimeoutMs
    this.catchTimeoutMs = catchTimeoutMs
    this.report = createReporter(logger)
    this.registrations = []
    this.sequence = 0
  }

  /** `on(event, [matcher], handler)`, returning the registration's `.catch`. */
  on(pattern, matcherOrHandler, maybeHandler) {
    const matcher = typeof matcherOrHandler === 'function' ? undefined : matcherOrHandler
    const handler = typeof matcherOrHandler === 'function' ? matcherOrHandler : maybeHandler
    if (typeof handler !== 'function') throw new TypeError(`on(${pattern}) needs a handler`)
    const registration = { id: ++this.sequence, pattern, matcher, handler, onFailure: undefined }
    this.registrations.push(registration)
    const self = this
    return {
      catch(onFailure) {
        registration.onFailure = onFailure
        return this
      },
      dispose() {
        const index = self.registrations.indexOf(registration)
        if (index >= 0) self.registrations.splice(index, 1)
      },
    }
  }

  /** The registrations a dispatch selects, in registration order, minus re-entry skips. */
  selected(event, input, skip) {
    return this.registrations.filter((registration) => {
      if (!patternMatches(registration.pattern, event) || !matches(registration.matcher, input)) return false
      // A `$` call raised from a hook skips that hook; one raised from background code
      // skips every hook this plugin registered, as Claude Code's engine does.
      if (skip === 'plugin') return false
      if (Array.isArray(skip) && skip.includes(registration.id)) return false
      return true
    })
  }

  /**
   * Run one event through its selected hooks.
   *
   * @param event the engine event name.
   * @param input the event input a hook receives.
   * @param bottom the engine's own behavior below every hook.
   * @param context `{ agent, session, signal }` the dispatch belongs to.
   * @param options `{ skip }`: a re-entrant `$` call's hooks to leave out.
   */
  async dispatch(event, input, bottom, context = {}, options = {}) {
    const hooks = this.selected(event, input, options.skip)
    const { signal } = context
    const run = async (index, current) => {
      if (index >= hooks.length) return await bottom(current)
      const registration = hooks[index]
      const budget = createBudget(this.hookTimeoutMs)
      const pausedOps = this.ops.createPause(budget)
      const next = this.createNext(run, index + 1, context, budget, signal, event, pausedOps)
      let settled
      let failure
      try {
        const result = await budget.race(registration.handler(
          this.dollar({ ...context, hookId: registration.id }, budget, pausedOps), Object.freeze(current), next))
        budget.settle()
        if (result !== undefined) return result
        failure = { kind: 'throw', message: 'hook returned nothing' }
      } catch (error) {
        budget.settle()
        failure = { kind: budget.expired ? 'timeout' : 'throw', message: error instanceof Error ? error.message : String(error) }
      }
      // A hook that already called `next` leaves the result from beneath standing.
      if (next.called) return next.lastResult
      this.report(event, failure.kind, failure.message)
      if (registration.onFailure) {
        const catchBudget = createBudget(this.catchTimeoutMs)
        const catchNext = this.createNext(run, index + 1, context, catchBudget, signal, event, this.ops.createPause(catchBudget))
        catchNext.error = failure
        try {
          const result = await catchBudget.race(registration.onFailure(
            this.dollar({ ...context, hookId: registration.id }, catchBudget, this.ops.createPause(catchBudget)),
            Object.freeze({ ...current, hook_event_name: failure.kind }), catchNext))
          catchBudget.settle()
          if (result !== undefined) return result
        } catch (error) {
          catchBudget.settle()
          this.report(event, 'throw', error instanceof Error ? error.message : String(error))
        }
        if (catchNext.called) return catchNext.lastResult
      }
      // Skipped: continue with the next hook in the chain.
      return await run(index + 1, current)
    }
    return await run(0, input)
  }

  /** The `next` one hook receives: continue the chain, with the engine's metadata. */
  createNext(run, index, context, budget, signal, event, pausedOps) {
    const self = this
    const next = async (rewritten) => {
      if (rewritten === undefined) throw new Error(`next() in ${event} needs the event`)
      next.called = true
      budget.pause()
      try {
        next.lastResult = await run(index, rewritten)
        return next.lastResult
      } finally {
        budget.resume()
      }
    }
    next.called = false
    next.lastResult = undefined
    next.event = event
    next.origin = { plugin: 'engine', tier: 'core' }
    next.signal = signal ?? new AbortController().signal
    next.budget = { ms: this.hookTimeoutMs, get remainingMs() { return Math.max(0, budget.remaining) } }
    next.is = (pattern, value) => patternMatches(pattern, event)
    next.to = (rewritten) => next(rewritten)
    next.pause = pausedOps?.pause
    return next
  }

  /**
   * The engine interface (`$`) one hook call receives. Every `$` call pauses the
   * hook's budget while it runs, because the engine times only the hook's own work.
   */
  dollar(context, budget, pausedOps) {
    const ops = this.ops
    const call = (operation) => async (...args) => {
      budget?.pause()
      try {
        return await operation(...args)
      } finally {
        budget?.resume()
      }
    }
    return {
      plugin: { name: this.pluginName, root: this.pluginRoot },
      agent: {
        list: call(() => ops.agentList(context)),
        spawn: call((input) => ops.agentSpawn(context, input)),
      },
      clock: {
        now: () => ops.clockNow(),
        sleep: (ms, options) => call(() => ops.clockSleep(context, ms, options))(),
        after: (ms, run) => ops.clockAfter(context, ms, run),
        every: (ms, run) => ops.clockEvery(context, ms, run),
      },
      command: {
        list: call(() => ops.commandList(context)),
        register: call((command) => ops.commandRegister(context, command)),
        run: call((input) => ops.commandRun(context, input)),
      },
      config: { list: call(() => ops.configList(context)) },
      env: { get: call((name) => ops.envGet(context, name)) },
      fs: {
        exists: call((path) => ops.fsExists(context, path)),
        list: call((path) => ops.fsList(context, path)),
        read: call((path) => ops.fsRead(context, path)),
        stat: call((path, options) => ops.fsStat(context, path, options)),
        write: call((path, text) => ops.fsWrite(context, path, text)),
      },
      http: { fetch: (url, init) => call(() => ops.httpFetch(context, url, init))() },
      process: {
        run: (argv, init) => call(() => ops.processRun(context, argv, init))(),
        spawn: (request) => ops.processSpawn(context, request),
      },
      prompt: { submit: (input) => call(() => ops.promptSubmit(context, input))() },
      session: {
        id: call(() => ops.sessionId(context)),
        cwd: call(() => ops.sessionCwd(context)),
        root: call(() => ops.sessionRoot(context)),
        model: call(() => ops.sessionModel(context)),
        turns: call(() => ops.sessionTurns(context)),
        version: call(() => ops.sessionVersion(context)),
        surfaces: call(() => ops.sessionSurfaces(context)),
        messages: (args) => call(() => ops.sessionMessages(context, args))(),
        apiMessages: call(() => ops.sessionMessages(context, { as: 'api' })),
        agentMessages: (args) => call(() => ops.sessionMessages(context, args))(),
        agentApiMessages: (agentId) => call(() => ops.sessionMessages(context, { agentId, as: 'api' }))(),
        usage: call(() => ops.sessionUsage(context)),
        append: (args) => call(() => ops.sessionAppend(context, args))(),
      },
      settings: { read: (args) => call(() => ops.settingsRead(context, args))() },
      state: {
        get: (key) => call(() => ops.stateGet(context, key))(),
        set: (key, value) => call(() => ops.stateSet(context, key, value))(),
      },
      store: {
        get: (key) => call(() => ops.storeGet(context, key))(),
        set: (key, value) => call(() => ops.storeSet(context, key, value))(),
        delete: (key) => call(() => ops.storeDelete(context, key))(),
        keys: () => call(() => ops.storeKeys(context))(),
      },
      tool: { call: (input) => call(() => ops.toolCall(context, input))() },
      turn: { abort: (input) => call(() => ops.turnAbort(context, input))() },
      ui: {
        ask: (question, options) => call(() => ops.uiAsk(context, question, options))(),
        resolve: (event) => elementTable(event),
        log: (text, options) => call(() => ops.uiLog(context, text, options))(),
        status: (text) => call(() => ops.uiStatus(context, text))(),
        copy: (args) => call(() => ops.uiCopy(context, args))(),
        invalidate: (event) => { ops.uiInvalidate(context, event) },
      },
    }
  }
}

export { clockMs, createBudget, normalizeChildren }
