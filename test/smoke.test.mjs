/**
 * A smoke test of the Host half: the built bundle loads, installs Delta's
 * command menu, starts a Session through the plugin, projects rows without
 * throwing, and ends the Session. Harness services are faked; the Delta CLI is
 * not installed in this test and every failure path must stay contained.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** One fake Harness context with the services the plugin injects. */
function fakeContext(cwd, agent) {
  const listeners = new Map()
  const services = {}
  const routes = []
  const logs = []
  const ctx = {
    logger: { warn(...args) { logs.push(['warn', ...args]) }, debug(...args) { logs.push(['debug', ...args]) }, info(...args) { logs.push(['info', ...args]) } },
    logs,
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {}
    },
    effect(fn) {
      const dispose = fn()
      return () => { try { dispose?.() } catch {} }
    },
    get(name) {
      return services[name]
    },
    emit(event, ...args) {
      const list = listeners.get(event) ?? []
      return Promise.all(list.map((listener) => listener(...args)))
    },
    routes,
    services,
  }
  services.agents = {
    list: () => [agent],
    get: (id) => (String(agent.session.id) === String(id) ? agent : undefined),
    roots: () => [agent],
    currentInitiator: () => agent,
    create: async () => ({ agent, dispose: async () => {} }),
  }
  services.sessions = { get: (id) => (String(agent.session.id) === String(id) ? agent.session : undefined), list: () => [agent.session] }
  services.commands = {
    defs: new Map(),
    register(definition) {
      this.defs.set(definition.name, definition)
      return () => {}
    },
    list() {
      return [...this.defs.values()].map((definition) => ({
        name: definition.name,
        description: definition.description,
        input: definition.input,
      }))
    },
    find(agentArg, name) { return this.defs.get(name) },
    async execute(agentArg, line) {
      const name = line.slice(1).split(/\s+/)[0]
      const definition = this.defs.get(name)
      if (definition === undefined) return undefined
      const result = await definition.handler({ agent: agentArg, commandId: 'c1', rawInput: line.slice(name.length + 1), attachments: [], signal: new AbortController().signal })
      return { commandId: 'c1', result }
    },
  }
  services.subprocess = {
    spawn() {
      // Delta's CLI, git and clipboard paths all fail this way in the test.
      throw new Error('subprocess is unavailable in this test')
    },
  }
  services.userQuestions = { ask: async () => ({ answers: [] }) }
  services.workingDirectory = {
    defaultDirectory: cwd,
    get: () => cwd,
    set: async (_agent, path) => path,
  }
  services.webServer = {
    register(route) { routes.push(route); return () => {} },
    getOrigin: () => 'http://127.0.0.1:0',
  }
  // Cordis exposes injected services as context members.
  Object.assign(ctx, services)
  return ctx
}

/** Invoke one registered route with a minimal request and response pair. */
async function callRoute(route, method, url) {
  const response = { status: 0, body: undefined, headers: {} }
  const req = { method, url, headers: {}, on() {}, }
  const res = {
    writableEnded: false,
    headersSent: false,
    writeHead(status, headers) { response.status = status; response.headers = headers; this.headersSent = true },
    write() {},
    end(text) { this.writableEnded = true; if (text !== undefined) { try { response.body = JSON.parse(text) } catch { response.body = text } } },
    on() {},
  }
  await route.handler(req, res)
  return response
}

function fakeAgent(cwd) {
  const session = {
    id: 'session-smoke',
    header: { cwd },
    deriveMessages: () => [],
  }
  return {
    session,
    status: 'idle',
    model: { current: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
    cancel() {},
    followup() {},
    inject() {},
  }
}

test('the built Host half starts and ends a Session with Delta installed', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'delta-dsh-smoke-'))
  const home = await mkdtemp(join(tmpdir(), 'delta-dsh-home-'))
  process.env.DSH_HOME = home
  const unhandled = []
  const onUnhandled = (error) => unhandled.push(error)
  process.on('unhandledRejection', onUnhandled)
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('network is unavailable in this test') }
  try {
    const plugin = await import('../lib/index.js')
    assert.equal(plugin.name, 'delta-dsh')
    assert.deepEqual(plugin.inject, ['agents', 'commands', 'subprocess', 'userQuestions', 'workingDirectory', 'webServer'])
    const agent = fakeAgent(cwd)
    const ctx = fakeContext(cwd, agent)
    plugin.apply(ctx)

    // A root Session starts: Delta's command menu and its session.start hook run.
    await ctx.emit('agent/created', { agent, source: 'startup' })
    assert.equal(ctx.services.commands.defs.has('delta'), true)
    assert.equal(ctx.services.commands.defs.has('delta-share'), true)
    assert.equal(ctx.services.commands.defs.has('delta-join'), true)
    assert.equal(ctx.services.commands.defs.has('delta-setup'), true)
    assert.equal(ctx.services.commands.defs.has('delta-update'), true)
    assert.equal(ctx.services.commands.defs.has('delta-plugin-update'), true)
    assert.equal(ctx.services.commands.defs.has('delta-org'), true)

    // The port adds /delta-stop; with no Delta connection it says so.
    assert.equal(ctx.services.commands.defs.has('delta-stop'), true)
    const stop = await ctx.services.commands.execute(agent, '/delta-stop')
    assert.equal(stop.result.kind, 'success')
    assert.match(stop.result.text, /not connected to Delta/)

    // `/delta-plugin-update` is adapted to the Harness plugin manager.
    const update = await ctx.services.commands.execute(agent, '/delta-plugin-update check')
    assert.equal(update.result.kind, 'success')
    assert.match(update.result.text, /Plugin Manager/)
    // Rows and a turn are projected without throwing.
    await ctx.emit('session/event', agent.session, { type: 'turn/start', seq: 1, data: { turn: 1 } })
    await ctx.emit('session/event', agent.session, {
      type: 'user/message',
      seq: 2,
      data: { role: 'user', id: 'm1', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] },
    })
    await ctx.emit('session/event', agent.session, { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } })
    await new Promise((resolve) => setTimeout(resolve, 100))

    // The band's API routes were registered, and its status endpoint answers
    // with a snapshot even when Delta draws nothing.
    assert.equal(ctx.routes.length, 1)
    assert.equal(ctx.routes[0].path, '/delta-dsh-api')
    const response = await callRoute(ctx.routes[0], 'GET', '/delta-dsh-api/status?session=session-smoke')
    assert.equal(response.status, 200)
    assert.equal(typeof response.body.generation, 'number')
    assert.equal(response.body.tree, null)

    // The plugin store exists and is JSON files.
    const storeDir = join(home, 'delta-dsh', 'store')
    const files = await readdir(storeDir).catch(() => [])
    assert.ok(files.every((file) => file.endsWith('.json')), `store files are JSON: ${files.join(', ')}`)

    await ctx.emit('agent/disposed', { agent })
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.deepEqual(unhandled, [])
  } finally {
    globalThis.fetch = originalFetch
    process.off('unhandledRejection', onUnhandled)
    delete process.env.DSH_HOME
  }
})

test('the plugin deactivates cleanly when every injected service exists', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'delta-dsh-smoke2-'))
  const home = await mkdtemp(join(tmpdir(), 'delta-dsh-home2-'))
  process.env.DSH_HOME = home
  try {
    const plugin = await import('../lib/index.js')
    const agent = fakeAgent(cwd)
    const ctx = fakeContext(cwd, agent)
    const dispose = plugin.apply(ctx)
    assert.equal(dispose, undefined)
  } finally {
    delete process.env.DSH_HOME
  }
})
