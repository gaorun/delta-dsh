/**
 * The engine shim's registry and chain semantics: registration order, matchers,
 * `next`, re-entrant `$` dispatch skips, and failure rules (fail open, `.catch`,
 * timeouts).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Engine, matches, patternMatches } from '../src/engine.js'

/** A minimal ops table: every `$` member resolves to a no-op promise. */
function ops() {
  const call = async () => ({})
  return new Proxy({ createPause: () => undefined }, {
    get(target, property) {
      if (property in target) return target[property]
      return call
    },
  })
}

function engine(options = {}) {
  return new Engine({ pluginName: 'delta', pluginRoot: '/tmp/delta', ops: ops(), logger: { warn() {} }, ...options })
}

test('matcher leaves: equality, arrays, regexps and nested objects', () => {
  assert.equal(matches({ door: 'prompt' }, { door: 'prompt' }), true)
  assert.equal(matches({ door: ['prompt', 'response'] }, { door: 'response' }), true)
  assert.equal(matches({ door: ['prompt'] }, { door: 'response' }), false)
  assert.equal(matches({ origin: { kind: 'tool', tool: /^(?!Skill$)/ } }, { origin: { kind: 'tool', tool: 'Bash' } }), true)
  assert.equal(matches({ origin: { kind: 'tool', tool: /^(?!Skill$)/ } }, { origin: { kind: 'tool', tool: 'Skill' } }), false)
  assert.equal(matches(undefined, { anything: true }), true)
})

test('patterns select names, namespaces and negations', () => {
  assert.equal(patternMatches('session.start', 'session.start'), true)
  assert.equal(patternMatches('session.*', 'session.start'), true)
  assert.equal(patternMatches('session.*', 'turn.start'), false)
  assert.equal(patternMatches('!tool.*', 'session.start'), true)
  assert.equal(patternMatches('!tool.*', 'tool.call'), false)
})

test('hooks run outermost first and next continues the chain', async () => {
  const e = engine()
  const order = []
  e.on('session.start', async ($, input, next) => {
    order.push('outer')
    const result = await next({ ...input, rewritten: true })
    order.push('outer-after')
    return result
  })
  e.on('session.start', async ($, input, next) => {
    order.push('inner')
    return next(input)
  })
  const result = await e.dispatch('session.start', { cwd: '/w' }, async (input) => {
    order.push('bottom')
    return { cwd: input.cwd, rewritten: input.rewritten }
  })
  assert.deepEqual(order, ['outer', 'inner', 'bottom', 'outer-after'])
  assert.deepEqual(result, { cwd: '/w', rewritten: true })
})

test('a hook that throws is skipped and the chain below still runs', async () => {
  const e = engine()
  const seen = []
  e.on('session.append', async () => { throw new Error('boom') })
  e.on('session.append', async ($, input, next) => { seen.push('second'); return next(input) })
  const result = await e.dispatch('session.append', { door: 'prompt' }, async () => ({ stored: true }))
  assert.deepEqual(seen, ['second'])
  assert.deepEqual(result, { stored: true })
})

test('a catch handler answers in place of the failed hook', async () => {
  const e = engine()
  e.on('prompt.submit', async () => { throw new Error('nope') })
    .catch(async ($, input, next) => ({ drop: next.error.message }))
  const result = await e.dispatch('prompt.submit', { text: 'hi' }, async () => ({ text: 'hi' }))
  assert.deepEqual(result, { drop: 'nope' })
})

test('a failed hook that already called next keeps the downstream result', async () => {
  const e = engine()
  e.on('session.end', async ($, input, next) => {
    await next(input)
    throw new Error('after next')
  })
  const result = await e.dispatch('session.end', { sessionId: 's' }, async () => ({ sessionId: 's', done: true }))
  assert.deepEqual(result, { sessionId: 's', done: true })
})

test('matched hooks only see matching inputs', async () => {
  const e = engine()
  const doors = []
  e.on('session.append', { door: ['prompt', 'response'] }, async ($, input, next) => {
    doors.push(input.door)
    return next(input)
  })
  for (const door of ['prompt', 'response', 'tool-result']) {
    await e.dispatch('session.append', { door }, async () => ({}))
  }
  assert.deepEqual(doors, ['prompt', 'response'])
})

test('a re-entrant dispatch skips the hook that raised it', async () => {
  const e = engine()
  const calls = []
  e.on('command.run', { command: 'delta' }, async () => {
    calls.push('command')
    return { text: 'ran' }
  })
  // A `$` call from another event's hook skips that hook, not this event's.
  const fromHook = await e.dispatch('command.run', { command: 'delta' }, async () => ({}), { hookId: 99 }, { skip: [99] })
  assert.deepEqual(fromHook, { text: 'ran' })
  // A `$` call from background code skips every hook this plugin registered.
  const fromBackground = await e.dispatch('command.run', { command: 'delta' }, async () => ({ text: 'core' }), {}, { skip: 'plugin' })
  assert.deepEqual(fromBackground, { text: 'core' })
  assert.deepEqual(calls, ['command'])
})

test('a hook that never returns is reported as a timeout and skipped', async () => {
  const e = engine({ hookTimeoutMs: 20 })
  let ran = false
  e.on('session.start', async () => { await new Promise(() => {}) })
  e.on('session.start', async ($, input, next) => { ran = true; return next(input) })
  const result = await e.dispatch('session.start', { cwd: '/w' }, async () => ({ cwd: '/w' }))
  assert.deepEqual(result, { cwd: '/w' })
  assert.equal(ran, true)
})
