/**
 * The Harness side of the engine shim: every `$` call Delta makes, implemented
 * over DeepSeek Harness services, plus the band surface and the same facts the
 * Host adapter needs (working directory, API-shaped history, synthetic
 * transcript titles).
 *
 * The plugin runs as a trusted Host plugin: it reads and writes its own files
 * with `node:fs`, runs the Delta CLI and git through the Harness `subprocess`
 * service, keeps its store under `$DSH_HOME/delta-dsh`, and asks the person
 * questions through `ctx.userQuestions`.
 */
import { readFileSync } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { runProcess, spawnProcess } from './process.js'
import { configDir, dataDir } from './paths.js'
import { registerCommands } from '../vendor/delta/setup/commands.ts'
import { reportedProgress } from '../vendor/delta/band/band.tsx'
import { watchStatus, watchedSession } from '../vendor/delta/watch/watch.ts'
import { activation, sessions as deltaSessions } from '../vendor/delta/core/session-state.ts'
import { apiBlocks } from './rows.js'
import { bandShouldShow, isUserFacingSession, repoPolicyConfigured } from './visibility.js'

/** CLI names for Harness tool names, so Delta's tool-call rows keep their Claude titles. */
const TOOL_NAMES = {
  bash: 'Bash',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  apply_patch: 'Edit',
  glob: 'Glob',
  grep: 'Grep',
  web_fetch: 'WebFetch',
  web_search: 'WebSearch',
  subagent: 'Task',
  subagent_fork: 'Task',
  todo_write: 'TodoWrite',
  ask_user_question: 'AskUserQuestion',
  exit_plan_mode: 'ExitPlanMode',
  skill: 'Skill',
}

/** The argument name Delta's tool titles read for each Claude tool. */
const TOOL_ARGS = {
  Read: (args) => ({ ...args, file_path: args.file_path ?? args.path }),
  Write: (args) => ({ ...args, file_path: args.file_path ?? args.path }),
  Edit: (args) => ({ ...args, file_path: args.file_path ?? args.path }),
  Glob: (args) => ({ ...args, path: args.path ?? args.cwd }),
  Grep: (args) => ({ ...args, path: args.path ?? args.cwd }),
}

/** The Claude Code mod API level this engine shim implements. */
export const MOD_API_VERSION = '2.1.318'

/** Commands the Harness ships as built-ins, for Delta's join capability check. */
const BUILTIN_COMMANDS = new Set(['clear', 'cd', 'compact', 'model', 'feedback', 'goal', 'plan', 'skill', 'workflow', 'exit_plan_mode'])

/** The tool name Delta sees for one Harness tool. */
export function claudeToolName(name) {
  return TOOL_NAMES[name] ?? name
}

/** The event fields Delta's `toolInfo` reads for one tool call. */
export function toolEventFields(name, args) {
  const claude = claudeToolName(name)
  const fields = args !== null && typeof args === 'object' ? { ...args } : {}
  const map = TOOL_ARGS[claude]
  return map ? map(fields) : fields
}

/** One DSH message list as Messages-API rows, for Delta's snapshot and line conversion. */
export function toApiMessages(messages) {
  const out = []
  for (const message of messages ?? []) {
    if (message.role === 'user') {
      const content = apiBlocks(message.content)
      if (content.length) out.push({ role: 'user', content })
    } else if (message.role === 'assistant') {
      const content = apiBlocks(message.content)
      if (content.length) out.push({ role: 'assistant', content })
    } else if (message.role === 'tool') {
      out.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: String(message.toolCallId ?? ''),
          content: apiBlocks(message.content),
          is_error: message.isError === true,
        }],
      })
    }
  }
  // Delta expects the history to open with the person's turn, as the Messages API does.
  while (out.length && out[0].role !== 'user') out.shift()
  return out
}

/** The Host adapter's operations table and side services. */
export class Bridge {
  constructor(ctx, { engine, hub, store, rows, pluginName, pluginRoot, logger, config = {} }) {
    this.ctx = ctx
    this.hub = hub
    this.store = store
    this.rows = rows
    this.pluginName = pluginName
    this.pluginRoot = pluginRoot
    this.logger = logger
    this.config = config
    this.engine = engine
    this.active = new Set()
    this.state = new Map()
    this.redrawTimers = new Map()
    this.commandNames = new Set()
    this.menuPromises = new Map()
    this.questionSequence = 0
    this.userFacing = new WeakMap()
    this.focusedSession = undefined
    try {
      this.packageVersionValue = JSON.parse(readFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8')).version
    } catch {
      this.packageVersionValue = undefined
    }
  }

  /** Let the engine arrive after the bridge is constructed (they reference each other). */
  setEngine(engine) {
    this.engine = engine
  }

  /** The person-facing Harness agent for a dispatch. */
  agentOf(context) {
    if (context?.agent !== undefined) return context.agent
    const initiator = this.ctx.agents?.currentInitiator?.()
    if (initiator !== undefined) return initiator
    const roots = this.ctx.agents?.roots?.() ?? []
    return roots[0]
  }

  /** The Harness Session one dispatch belongs to. */
  sessionOf(context) {
    const agent = this.agentOf(context)
    if (agent?.session !== undefined) return agent.session
    if (context?.session !== undefined) return context.session
    if (typeof context?.sessionId === 'string') return this.ctx.sessions?.get?.(context.sessionId)
    return undefined
  }

  /** The working directory of a session, or the process default. */
  cwdOf(session) {
    try {
      if (session !== undefined && this.ctx.workingDirectory !== undefined) {
        const directory = this.ctx.workingDirectory.get(session)
        if (typeof directory === 'string' && directory.length) return directory
      }
    } catch {}
    return session?.header?.cwd ?? process.cwd()
  }

  /** A host path resolved against the dispatch's working directory. */
  resolvePath(context, path) {
    const cwd = this.cwdOf(this.sessionOf(context))
    return isAbsolute(path) ? path : resolve(cwd, path)
  }

  /** Every timer this plugin started; disposal cancels them all. */
  async dispose() {
    for (const dispose of [...this.active]) {
      try { dispose() } catch {}
    }
    this.active.clear()
    for (const timer of this.redrawTimers.values()) clearTimeout(timer)
    this.redrawTimers.clear()
  }

  /** Remember a timer-owner disposer until the plugin unloads. */
  own(dispose) {
    this.active.add(dispose)
    return () => { this.active.delete(dispose) }
  }

  // ── agent and session facts ──────────────────────────────────────────────

  agentList() {
    return (this.ctx.agents?.list?.() ?? []).map((agent) => ({
      id: String(agent.session.id),
      description: '',
      type: 'agent',
      status: agent.status === 'running' ? 'running' : 'idle',
      ...(agent.session.header?.parentSession === undefined ? {} : { parentId: String(agent.session.header.parentSession) }),
    }))
  }

  async agentSpawn() {
    throw new TypeError('Delta cannot spawn agents on this host yet')
  }

  sessionId(context) {
    const session = this.sessionOf(context)
    if (session === undefined) throw new Error('Delta is not bound to a Harness session')
    return String(session.id)
  }

  sessionCwd(context) {
    return this.cwdOf(this.sessionOf(context))
  }

  /**
   * The session's current project root. Claude Code moves both the working
   * directory and the root when `/cd` moves a session; the Harness keeps the
   * creation directory in the header, so the port reports the live directory
   * for both, which is what Delta's join verification checks.
   */
  sessionRoot(context) {
    return this.sessionCwd(context)
  }

  sessionModel(context) {
    const agent = this.agentOf(context)
    try {
      const current = agent?.model?.current?.()
      return typeof current?.model === 'string' ? current.model : 'harness'
    } catch {
      return 'harness'
    }
  }

  sessionTurns(context) {
    return this.rows.userTurns(this.sessionId(context))
  }

  /**
   * The Claude Code mod API level this engine shim implements. Delta checks it
   * only to warn about an engine older than the API it was written against, so
   * the shim reports the API level it provides rather than the Harness version.
   */
  sessionVersion() {
    return { version: MOD_API_VERSION, base: MOD_API_VERSION }
  }

  sessionSurfaces() {
    // The Web app is an interactive surface; Delta's terminal path draws the band,
    // runs dialogs, and its join transition is adapted in the vendored join flow.
    return ['terminal']
  }

  /** The session's model-visible history as Messages-API rows. */
  sessionMessages(context, args) {
    const session = this.sessionOf(context)
    if (session === undefined) return { deny: 'no session' }
    if (args?.agentId !== undefined && args.agentId !== String(session.id)) return { deny: 'Delta cannot read that agent' }
    let messages
    try {
      messages = session.deriveMessages()
    } catch {
      messages = []
    }
    const api = toApiMessages(messages)
    if (args?.as === 'api') return api
    return api.map((message) => ({
      role: message.role,
      text: message.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n'),
      toolUses: message.content.filter((block) => block.type === 'tool_use').map((block) => ({
        tool_use_id: block.id, tool: block.name, input: block.input ?? {},
      })),
    }))
  }

  sessionUsage() {
    return undefined
  }

  /** Append a row to the model's context, as Delta's watch replies do in Claude Code. */
  async sessionAppend() {
    return { deny: 'delta-dsh does not inject rows into a Harness Session' }
  }

  // ── the band surface ─────────────────────────────────────────────────────

  /** The Session the person is looking at; Delta follows one Session at a time. */
  isFocused(sessionId) {
    return this.focusedSession === sessionId
  }

  /**
   * Make one Session the Delta Session: its command menu, then its own
   * session.start (which activates recording and the thread watch). Delta's
   * hooks keep one active Session per process, so switching the focused Session
   * switches Delta's activation with it.
   */
  async focus(sessionId) {
    if (this.focusedSession === sessionId) return
    const previous = this.focusedSession
    this.focusedSession = sessionId
    // Hide the previous session's band immediately; its watch stops when the new
    // activation runs (Delta stops the conversation it was watching).
    if (previous !== undefined) this.hub.publish(previous, null)
    let agent
    try { agent = this.ctx.agents?.get?.(sessionId) } catch {}
    if (agent === undefined || !this.isUserFacing(agent)) return
    const session = agent.session
    await this.ensureCommands(agent)
    const cwd = this.cwdOf(session)
    await this.engine.dispatch('session.start', Object.freeze({ cwd, surface: 'terminal', isInteractive: true }),
      async () => ({ cwd }), { agent, session, signal: new AbortController().signal })
    this.invalidateBand({ agent, session })
  }

  /** Announce one Session's band to an open browser (the Client calls this when its dock mounts). */
  async focusBand(sessionId) {
    if (!this.isFocused(sessionId)) await this.focus(sessionId)
    await this.drawBand(sessionId)
  }

  /** The Team role of one agent, when it belongs to a Team. */
  teamMembership(agent) {
    try { return this.ctx.get?.('agentTeams')?.tryMembership?.(agent) } catch { return undefined }
  }

  /** Whether this Session is one a person opened: a root Session, not a Team teammate. */
  isUserFacing(agent) {
    if (agent === undefined || agent === null) return false
    const cached = this.userFacing.get(agent)
    if (cached !== undefined) return cached
    const facing = isUserFacingSession(agent, this.teamMembership(agent))
    this.userFacing.set(agent, facing)
    return facing
  }

  /** A Session's Delta binding, if it has one. */
  async bindingOf(session) {
    try { return await this.store.get(`session:${String(session.id)}`) } catch { return undefined }
  }

  /** Whether Delta has something worth showing for this Session (see `visibility.js`). */
  async bandShouldShow(agent, session) {
    const userFacing = this.isUserFacing(agent)
    if (!userFacing) return false
    let progress = false
    let watchError = false
    try { progress = reportedProgress() !== undefined } catch {}
    try { watchError = watchStatus()?.error !== undefined } catch {}
    return bandShouldShow({
      userFacing,
      binding: await this.bindingOf(session),
      configured: repoPolicyConfigured(this.cwdOf(session)),
      progress,
      watchError,
    })
  }

  /** Redraw one session's band from Delta's own hooks and publish it to the Client. */
  async drawBand(sessionId) {
    let agent
    try { agent = this.ctx.agents?.get?.(sessionId) } catch {}
    let session = agent?.session
    if (session === undefined) {
      try { session = this.ctx.get?.('sessions')?.get?.(sessionId) } catch {}
    }
    if (session === undefined) {
      this.hub.dispose(sessionId)
      return
    }
    if (!this.isFocused(sessionId)) {
      this.hub.publish(sessionId, null)
      return
    }
    if (!(await this.bandShouldShow(agent, session))) {
      this.hub.publish(sessionId, null)
      return
    }
    let result
    try {
      this.hub.lastDrawError = undefined
      result = await this.engine.dispatch('ui.render', Object.freeze({
        component: 'AbovePrompt',
        surface: 'desktop',
        requestId: `delta-dsh:${sessionId}`,
        props: {
          bodyColumns: Math.max(20, this.config.bandColumns ?? 120),
          maxRows: Math.max(0, this.config.bandRows ?? 10),
          hasSurvey: false,
          isWorking: agent?.status === 'running',
        },
        viewport: { columns: this.config.bandColumns ?? 120, rows: this.config.bandRows ?? 10 },
      }), async () => null, { agent, session, signal: new AbortController().signal })
    } catch (error) {
      this.hub.lastDrawError = error instanceof Error ? error.message : String(error)
      this.logger.warn(`delta-dsh: band draw failed: ${this.hub.lastDrawError}`)
      result = null
    }
    this.hub.publish(sessionId, result ?? null)
  }

  /** Coalesce redraw requests for one session, as the engine throttles ui.render. */
  invalidateBand(context) {
    const session = this.sessionOf(context)
    if (session === undefined) return
    const sessionId = String(session.id)
    if (!this.hub.hasSubscribers?.(sessionId)) return
    if (this.redrawTimers.has(sessionId)) return
    const timer = setTimeout(() => {
      this.redrawTimers.delete(sessionId)
      void this.drawBand(sessionId)
    }, 50)
    timer.unref?.()
    this.redrawTimers.set(sessionId, timer)
  }

  // ── operations Delta's Host binds ────────────────────────────────────────

  createPause() {
    return undefined
  }

  async clockNow() {
    return Date.now()
  }

  async clockSleep(_context, ms, options) {
    const signal = options?.signal
    return await new Promise((resolvePromise, reject) => {
      if (signal?.aborted) return reject(new Error('sleep cancelled'))
      const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolvePromise() }, Math.max(0, ms))
      timer.unref?.()
      const onAbort = () => { clearTimeout(timer); reject(new Error('sleep cancelled')) }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  clockAfter(_context, ms, run) {
    const timer = setTimeout(() => { this.active.delete(dispose); run() }, Math.max(0, ms))
    timer.unref?.()
    const dispose = () => clearTimeout(timer)
    this.active.add(dispose)
    return { cancel: dispose }
  }

  clockEvery(_context, ms, run) {
    const timer = setInterval(run, Math.max(1, ms))
    timer.unref?.()
    const dispose = () => clearInterval(timer)
    this.active.add(dispose)
    return { cancel: dispose }
  }

  async commandList(context) {
    const agent = this.agentOf(context)
    let descriptors = []
    try { descriptors = this.ctx.commands.list(agent) ?? [] } catch {}
    return descriptors.map((descriptor) => ({
      name: descriptor.name,
      description: descriptor.description,
      source: BUILTIN_COMMANDS.has(descriptor.name) ? 'builtin' : 'plugin',
      ...(BUILTIN_COMMANDS.has(descriptor.name) ? {} : { plugin: this.pluginName }),
    }))
  }

  /**
   * Plugin self-update, adapted to the Harness: the Harness Plugin Manager owns
   * installation and reload, so this reports that path instead of driving
   * Claude Code's marketplace CLI. `/delta-update` still updates the Delta app
   * and CLI through Delta's own code.
   */
  async pluginUpdateResult(args) {
    const action = String(args ?? '').trim()
    const key = 'delta-dsh:plugin-update:notifications'
    if (/^notifications\s+(on|off)$/.test(action)) {
      const on = action.endsWith('on')
      await this.store.set(key, on)
      return on
        ? 'Delta plugin update notices are on.'
        : 'Delta plugin update notices are off.'
    }
    if (/^notifications$/.test(action)) {
      const on = (await this.store.get(key)) !== false
      return `Delta plugin update notices are ${on ? 'on' : 'off'}. Use /delta-plugin-update notifications on|off.`
    }
    const version = this.packageVersion()
    if (action === 'check') {
      return `Delta for DeepSeek Harness ${version} is installed. The Harness Plugin Manager owns plugin installation, updates and reload (Settings → Plugins).`
    }
    return `Delta for DeepSeek Harness ${version} is managed by the Harness Plugin Manager. Update it from Settings → Plugins, or ask the Harness to install a newer build; then start a new Session to load it.`
  }

  /** The version this package declares in its manifest. */
  packageVersion() {
    return this.packageVersionValue ?? '0.1.0'
  }

  /**
   * Register one command Delta's menu asked for; the handler dispatches
   * `command.run`. A re-enabled plugin in the same process can find an earlier
   * instance's global registration of the same name (the Harness command
   * registry keeps it for the process), so a name already taken is registered
   * on the asking agent's own scope, which shadows the stale global for it.
   */
  async commandRegister(context, spec) {
    if (typeof spec?.name !== 'string') return { command: '' }
    const scopeKey = `${context?.agent === undefined ? 'global' : String(context.agent.session.id)}:${spec.name}`
    if (this.commandNames.has(scopeKey)) return { command: spec.name }
    this.commandNames.add(scopeKey)
    const handler = async (invocation) => {
      const dispatchContext = { agent: invocation.agent, session: invocation.agent.session, signal: invocation.signal }
      const rawInput = invocation.rawInput ?? ''
      if (spec.name === 'delta-plugin-update' || (spec.name === 'delta' && /^plugin-update\b/.test(rawInput.trim()))) {
        const args = spec.name === 'delta' ? rawInput.trim().replace(/^plugin-update/, '').trim() : rawInput.trim()
        return { kind: 'success', text: await this.pluginUpdateResult(args) }
      }
      try {
        const result = await this.engine.dispatch('command.run', Object.freeze({
          command: spec.name,
          args: invocation.rawInput ?? '',
          origin: { kind: 'composer' },
        }), async () => ({}), dispatchContext)
        const text = typeof result?.text === 'string' ? result.text : undefined
        return text === undefined ? { kind: 'success' } : { kind: 'success', text }
      } catch (error) {
        return { kind: 'error', text: `Delta could not run /${spec.name}: ${error instanceof Error ? error.message : String(error)}` }
      }
    }
    const definition = {
      name: spec.name,
      description: spec.description ?? '',
      ...(spec.argumentHint ? { input: { hint: spec.argumentHint } } : {}),
      handler,
    }
    const agent = context?.agent
    let existing
    try { existing = agent === undefined ? undefined : this.ctx.commands.find(agent, spec.name) } catch {}
    if (agent !== undefined && existing !== undefined) {
      // Shadow the stale process-wide registration for this agent.
      try {
        agent.ctx.inject(['commands'], (commandCtx) => commandCtx.commands.register(definition))
        return { command: spec.name }
      } catch (error) {
        this.logger.warn?.(`delta-dsh: could not scope command /${spec.name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    try {
      const dispose = this.ctx.commands.register(definition)
      if (typeof dispose === 'function') this.own(dispose)
    } catch (error) {
      this.logger.warn?.(`delta-dsh: could not register /${spec.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
    return { command: spec.name }
  }

  /**
   * Install Delta's command menu for one agent, once per agent. Concurrent
   * callers (the plugin's startup pass and a new agent) share the same run, so a
   * caller that awaits this sees the complete menu.
   */
  async ensureCommands(agent) {
    const key = `menu:${String(agent.session.id)}`
    const existing = this.menuPromises.get(key)
    if (existing !== undefined) return await existing
    const run = (async () => {
      const host = { command: { register: (spec) => this.commandRegister({ agent }, spec) } }
      try { await registerCommands(host) } catch (error) {
        this.logger.warn?.(`delta-dsh: could not register commands: ${error instanceof Error ? error.message : String(error)}`)
      }
    })()
    this.menuPromises.set(key, run)
    await run
  }

  async commandRun(context, input) {
    const agent = this.agentOf(context)
    if (input?.command === 'cd' && agent !== undefined && typeof input.args === 'string') {
      await this.ctx.workingDirectory.set(agent, input.args)
      return {}
    }
    if (input?.command === 'reload-plugins') return {}
    if (input?.command === 'delta' && /^plugin-update\b/.test(String(input.args ?? '').trim()))
      return { text: await this.pluginUpdateResult(String(input.args).trim().replace(/^plugin-update/, '').trim()) }
    if (input?.command === 'delta-plugin-update')
      return { text: await this.pluginUpdateResult(String(input.args ?? '').trim()) }
    if (input?.command === 'clear')
      throw new Error('the Harness has no plugin-callable /clear; join keeps the current session instead')
    const dispatchContext = { agent, session: agent?.session, signal: context?.signal, hookId: context?.hookId }
    return await this.engine.dispatch('command.run', Object.freeze({
      command: input?.command ?? '',
      args: input?.args ?? '',
      origin: { kind: 'plugin', name: this.pluginName },
    }), async () => ({}), dispatchContext, { skip: context?.hookId === undefined ? 'plugin' : [context.hookId] })
  }

  configList() {
    return [{
      key: 'theme',
      label: 'Theme',
      kind: 'select',
      value: 'dark',
      options: [{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }],
      provider: this.pluginName,
      isLocked: false,
    }]
  }

  async envGet(_context, name) {
    switch (name) {
      case 'OS':
        return process.platform === 'win32' ? 'Windows_NT' : process.platform === 'darwin' ? 'Darwin' : 'Linux'
      case 'HOME':
        return homedir()
      case 'USERPROFILE':
        return process.env.USERPROFILE
      case 'CLAUDE_CONFIG_DIR':
        return configDir()
      case 'CLAUDE_CODE_REMOTE':
        return 'false'
      case 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC':
        // Delta's Claude Code plugin-release check looks for the installed Claude
        // marketplace copy; the Harness Plugin Manager owns this port instead.
        // Set DSH_DELTA_PLUGIN_UPDATE_CHECKS=1 to let that check run anyway.
        return process.env.DSH_DELTA_PLUGIN_UPDATE_CHECKS === '1'
          ? process.env.DSH_DISABLE_NONESSENTIAL_TRAFFIC
          : '1'
      default:
        return process.env[name]
    }
  }

  async fsExists(context, path) {
    try {
      await stat(this.resolvePath(context, path))
      return true
    } catch {
      return false
    }
  }

  async fsList(context, path) {
    const directory = this.resolvePath(context, path)
    const entries = await readdir(directory, { withFileTypes: true })
    return await Promise.all(entries.map(async (entry) => {
      const target = join(directory, entry.name)
      let info
      try { info = await stat(target) } catch {}
      return {
        name: entry.name,
        kind: entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : 'other',
        size: info?.size ?? 0,
        mtimeMs: info?.mtimeMs ?? 0,
        isLink: entry.isSymbolicLink(),
      }
    }))
  }

  async fsRead(context, path) {
    const target = this.resolvePath(context, path)
    const info = await stat(target)
    if (info.size > 4 * 1024 * 1024) throw new Error(`${path} exceeds the 4 MiB read limit`)
    return await readFile(target, 'utf8')
  }

  async fsStat(context, path) {
    const target = this.resolvePath(context, path)
    const info = await stat(target)
    return {
      kind: info.isDirectory() ? 'dir' : info.isFile() ? 'file' : 'other',
      size: info.size,
      mtimeMs: info.mtimeMs,
      isLink: info.isSymbolicLink(),
    }
  }

  async fsWrite(context, path, text) {
    const target = this.resolvePath(context, path)
    if (Buffer.byteLength(text, 'utf8') > 4 * 1024 * 1024) throw new Error(`${path} exceeds the 4 MiB write limit`)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, text, 'utf8')
  }

  async httpFetch(_context, url, init = {}) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30_000)
    timeout.unref?.()
    try {
      const response = await fetch(url, {
        method: init.method ?? 'GET',
        headers: init.headers,
        body: init.body,
        signal: controller.signal,
      })
      const text = await response.text()
      return {
        status: response.status,
        ok: response.ok,
        headers: Object.fromEntries(response.headers.entries()),
        text,
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  async processRun(context, argv, init) {
    return await runProcess(this.ctx.subprocess, argv, init ?? {}, this.cwdOf(this.sessionOf(context)))
  }

  processSpawn(context, request) {
    return spawnProcess(this.ctx.subprocess, request, this.cwdOf(this.sessionOf(context)))
  }

  promptSubmit(context, input) {
    const agent = this.agentOf(context)
    if (agent === undefined) throw new Error('no session to submit a prompt to')
    agent.followup({
      role: 'user',
      content: [{ type: 'text', text: String(input?.text ?? '') }],
      source: { kind: 'user' },
    })
    return { text: String(input?.text ?? '') }
  }

  async settingsRead() {
    return {}
  }

  stateKey(context, key) {
    return `${this.sessionId(context)}:${key}`
  }

  async stateGet(context, key) {
    return this.state.get(this.stateKey(context, key))
  }

  async stateSet(context, key, value) {
    this.state.set(this.stateKey(context, key), value)
  }

  async storeGet(_context, key) {
    return await this.store.get(key)
  }

  async storeSet(_context, key, value) {
    await this.store.set(key, value)
  }

  async storeDelete(_context, key) {
    await this.store.delete(key)
  }

  async storeKeys() {
    return await this.store.keys()
  }

  async toolCall() {
    throw new TypeError('Delta cannot call Harness tools directly on this host yet')
  }

  turnAbort(context) {
    this.agentOf(context)?.cancel?.({ kind: 'user' })
  }

  /** Ask the person one question through the Harness question service. */
  async uiAsk(context, question, options) {
    const agent = this.agentOf(context)
    const request = normalizeAsk(question, options)
    request.id = `delta-${++this.questionSequence}`
    const answer = await this.ctx.userQuestions.ask({
      questions: [request],
      ...(agent === undefined ? {} : { agent }),
      ...(context?.signal === undefined ? {} : { signal: context.signal }),
    })
    const first = answer?.answers?.[0]
    if (first === undefined) return ''
    if (first.custom !== undefined && first.custom.length) return first.custom
    return (first.selected ?? []).join(', ')
  }

  /** Write text to the host clipboard for the surface a copy control came from. */
  async uiCopy(_context, args) {
    const text = String(args?.text ?? '')
    try {
      await this.writeClipboard(text, args?.surface)
      return { isCopied: true }
    } catch (error) {
      return { isCopied: false, reason: 'no-clipboard' }
    }
  }

  async writeClipboard(text, surface) {
    const commands = process.platform === 'darwin'
      ? [['pbcopy'], []]
      : process.platform === 'win32'
        ? [['clip.exe'], []]
        : [['wl-copy'], ['xclip', '-selection', 'clipboard']]
    for (const argv of commands) {
      if (!argv.length) continue
      try {
        const outcome = await runProcess(this.ctx.subprocess, argv, { stdin: text }, process.cwd()).catch(() => undefined)
        if (outcome !== undefined && outcome.exitCode === 0) return
      } catch {}
    }
    throw new Error(`no clipboard on ${surface ?? 'this surface'}`)
  }

  uiLog(context, text, options) {
    const line = String(text ?? '')
    if (options?.to === 'debug') {
      this.logger.debug?.(`delta: ${line}`) ?? this.logger.warn?.(`delta: ${line}`)
      return
    }
    const session = this.sessionOf(context)
    if (session !== undefined) this.hub.status(String(session.id), line.slice(0, 2000))
    this.logger.warn?.(`delta: ${line}`)
  }

  uiStatus(context, text) {
    const session = this.sessionOf(context)
    if (session === undefined) return
    this.hub.status(String(session.id), text === undefined ? undefined : String(text))
  }

  uiInvalidate(context) {
    this.invalidateBand(context)
  }

  /** The band with a small notice line, for a session whose surface already exists. */
  sessionKeyOf(context) {
    try { return this.sessionId(context) } catch { return undefined }
  }

  /** A session's config folder, for the vendored activation code. */
  configDir() {
    return configDir()
  }

  /** The plugin's own data folder. */
  dataDir() {
    return dataDir()
  }
}

/** One `$.ui.ask` question as the Harness question service takes it. */
function normalizeAsk(question, options) {
  if (Array.isArray(options)) {
    return {
      question,
      options: options.map((label) => ({ label: String(label) })),
    }
  }
  const hint = options !== null && typeof options === 'object' ? options : {}
  const list = Array.isArray(hint.options) ? hint.options : []
  const descriptions = hint.descriptions !== null && typeof hint.descriptions === 'object' ? hint.descriptions : {}
  return {
    question,
    ...(hint.header === undefined ? {} : { header: String(hint.header) }),
    ...(list.length === 0 ? {} : {
      options: list.map((label) => {
        const text = String(label)
        return descriptions[text] === undefined ? { label: text } : { label: text, description: String(descriptions[text]) }
      }),
    }),
    ...(hint.multiSelect === true ? { multiSelect: true } : {}),
  }
}
