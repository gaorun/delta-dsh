/**
 * An integration pass over the Host half with real files, a real git checkout
 * and the real Delta CLI, but a faked Harness context. It exercises the paths
 * the smoke test cannot: session.start inside a checkout, prompt admission, row
 * projection through Delta's capture decision, a tool call around execution,
 * and session end — without installing, sharing, or touching the network.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A Harness-subprocess service over node's child_process, matching the adapter's two modes. */
function localSubprocess() {
  return {
    spawn(spec) {
      const child = spawn(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        env: { ...process.env, ...(spec.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const buffers = { out: '', err: '' }
      child.stdout.on('data', (chunk) => { buffers.out += chunk.toString('utf8') })
      child.stderr.on('data', (chunk) => { buffers.err += chunk.toString('utf8') })
      const collected = {
        stdout: { readFrom: () => ({ text: buffers.out, nextOffset: 0, lossy: false }) },
        stderr: { readFrom: () => ({ text: buffers.err, nextOffset: 0, lossy: false }) },
      }
      return {
        stdin: undefined,
        stdout: spec.stdio.stdout === 'pipe' ? child.stdout : undefined,
        stderr: spec.stdio.stderr === 'pipe' ? child.stderr : undefined,
        collected,
        done: new Promise((resolve) => {
          child.on('error', () => resolve({ exitCode: null, signal: null }))
          child.on('close', (code, signal) => resolve({ exitCode: code, signal }))
        }),
        terminate() { child.kill('SIGTERM') },
      }
    },
  }
}

function fakeHarness(cwd, agent) {
  const listeners = new Map()
  const services = {
    agents: {
      list: () => [agent],
      get: (id) => (String(agent.session.id) === String(id) ? agent : undefined),
      roots: () => [agent],
      currentInitiator: () => agent,
    },
    sessions: { get: () => agent.session, list: () => [agent.session] },
    commands: {
      defs: new Map(),
      register(definition) { this.defs.set(definition.name, definition); return () => {} },
      list() { return [...this.defs.values()].map(({ name, description, input }) => ({ name, description, input })) },
      find: (agentArg, name) => this.defs.get(name),
      async execute(agentArg, line) {
        const name = line.slice(1).split(/\s+/)[0]
        const definition = this.defs.get(name)
        if (!definition) return undefined
        return { commandId: 'c1', result: await definition.handler({ agent: agentArg, commandId: 'c1', rawInput: line.slice(name.length + 1), attachments: [], signal: new AbortController().signal }) }
      },
    },
    subprocess: localSubprocess(),
    userQuestions: { ask: async () => ({ answers: [{ id: 'delta-1', selected: [] }] }) },
    workingDirectory: { defaultDirectory: cwd, get: () => cwd, set: async (_agent, path) => path },
    webServer: { register: () => () => {}, getOrigin: () => 'http://127.0.0.1:0' },
  }
  const ctx = {
    logger: { warn() {}, debug() {}, info() {} },
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {}
    },
    effect(fn) { const dispose = fn(); return () => { try { dispose?.() } catch {} } },
    get: (name) => services[name],
    emit(event, ...args) { return Promise.all((listeners.get(event) ?? []).map((listener) => listener(...args))) },
    listeners,
    ...services,
  }
  return ctx
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
}

test('a checkout Session activates, admits a prompt, projects a tool call and ends', async () => {
  const home = await mkdtemp(join(tmpdir(), 'delta-dsh-int-home-'))
  const cwd = await mkdtemp(join(tmpdir(), 'delta-dsh-int-repo-'))
  process.env.DSH_HOME = home
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('network disabled in the integration test') }
  try {
    // A real checkout, so Delta's activation finds a repository root.
    git(cwd, ['init', '--quiet'])
    git(cwd, ['config', 'user.email', 'test@example.com'])
    git(cwd, ['config', 'user.name', 'Test'])
    await writeFile(join(cwd, 'file.txt'), 'hello\n')
    git(cwd, ['add', '.'])
    git(cwd, ['commit', '--quiet', '-m', 'initial'])

    const session = {
      id: 'integration-session',
      header: { cwd },
      deriveMessages: () => ([
        { role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' }, id: 'm1' },
      ]),
    }
    const agent = {
      session,
      status: 'idle',
      model: { current: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
      cancel() {},
      followup() {},
      inject() {},
    }
    const ctx = fakeHarness(cwd, agent)
    const plugin = await import('../lib/index.js')
    plugin.apply(ctx)

    // A root Session starts in the checkout.
    await ctx.emit('agent/created', { agent, source: 'startup' })
    // The command menu is installed for this agent.
    assert.equal(ctx.commands.defs.has('delta'), true)
    // Delta read the checkout's policy and recorded a reminder; no share was started.
    await new Promise((resolve) => setTimeout(resolve, 50))

    // Prompt admission lets the prompt through (no binding means nothing to wait on).
    const preStep = ctx.listeners.get('agent/pre-step')[0]
    const decision = await preStep({
      agent,
      messages: [{ role: 'user', id: 'm1', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    }, async () => ({ kind: 'enter', messages: [] }))
    assert.equal(decision.kind, 'enter')

    // A turn and its rows are projected.
    await ctx.emit('session/event', session, { type: 'turn/start', seq: 1, data: { turn: 1 } })
    await ctx.emit('session/event', session, {
      type: 'user/message',
      seq: 2,
      data: { role: 'user', id: 'm1', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] },
    })
    // A tool call runs around the real execution and Delta sees its result.
    const toolExecute = ctx.listeners.get('tools/execute')[0]
    let dispatched = 0
    const outcome = await toolExecute({
      name: 'bash',
      callId: 'call-1',
      arguments: { command: 'ls' },
      agent,
      signal: new AbortController().signal,
    }, async () => { dispatched += 1; return { isError: false, value: { stdout: 'file.txt' }, content: [] } })
    assert.equal(dispatched, 1)
    assert.equal(outcome.isError, false)
    await ctx.emit('session/event', session, {
      type: 'assistant/message',
      seq: 3,
      data: {
        turn: 1,
        step: 1,
        message: { role: 'assistant', id: 'a1', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-flash' }, content: [{ type: 'text', text: 'done' }] },
        stream: [],
      },
    })
    await ctx.emit('session/event', session, { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } })
    await new Promise((resolve) => setTimeout(resolve, 100))

    // The plugin store holds Delta's binding for the session.
    const { readdir } = await import('node:fs/promises')
    const store = await readdir(join(home, 'delta-dsh', 'store')).catch(() => [])
    assert.ok(store.length > 0, 'the plugin store has Delta state')

    await ctx.emit('agent/disposed', { agent })
    await new Promise((resolve) => setTimeout(resolve, 100))
  } finally {
    globalThis.fetch = originalFetch
    delete process.env.DSH_HOME
  }
})
