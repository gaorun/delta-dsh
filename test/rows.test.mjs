/**
 * The row projection: Harness Session events become the engine events Delta
 * records, with the doors its capture rules select on.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine } from '../src/engine.js'
import { RowProjector } from '../src/rows.js'

const ops = new Proxy({ createPause: () => undefined }, { get: () => async () => ({}) })
const agent = { session: { id: 's1', header: { cwd: '/work' } } }
const session = { id: 's1', header: { cwd: '/work' } }

function setup() {
  const engine = new Engine({ pluginName: 'delta', pluginRoot: '/tmp/delta', ops, logger: { warn() {} } })
  const bridge = { cwdOf: () => '/work' }
  const rows = new RowProjector({ engine, bridge, logger: { warn() {} } })
  const seen = []
  for (const event of ['turn.start', 'turn.complete', 'session.append']) {
    engine.on(event, async ($, input, next) => {
      seen.push([event, input])
      return next(input)
    })
  }
  return { rows, seen }
}

test('a human prompt becomes a prompt-door row and counts the turn', async () => {
  const { rows, seen } = setup()
  await rows.handle(agent, session, {
    type: 'user/message',
    seq: 2,
    data: { role: 'user', id: 'm1', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] },
  })
  const append = seen.find(([event]) => event === 'session.append')[1]
  assert.equal(append.door, 'prompt')
  assert.deepEqual(append.message, { type: 'user', role: 'user', content: [{ type: 'text', text: 'hello' }] })
  assert.deepEqual(append.origin, { kind: 'user' })
  assert.equal(rows.userTurns('s1'), 1)
})

test('injected context becomes a door Delta does not record', async () => {
  const { rows, seen } = setup()
  await rows.handle(agent, session, {
    type: 'user/message',
    seq: 3,
    data: {
      role: 'user', id: 'm2', source: { kind: 'instructions', form: 'snapshot', sections: [] },
      content: [{ type: 'text', text: 'AGENTS.md' }],
    },
  })
  const append = seen.find(([event]) => event === 'session.append')[1]
  assert.equal(append.door, 'hook-context')
  assert.equal(append.message.isMeta, true)
})

test('an assistant message becomes a response row with thinking and tool calls', async () => {
  const { rows, seen } = setup()
  await rows.handle(agent, session, {
    type: 'assistant/message',
    seq: 4,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'assistant',
        id: 'a1',
        source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
        content: [
          { type: 'reasoning', text: 'thinking' },
          { type: 'text', text: 'answer' },
          { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"ls"}' },
        ],
      },
      stream: [],
    },
  })
  const append = seen.find(([event]) => event === 'session.append')[1]
  assert.equal(append.door, 'response')
  assert.deepEqual(append.origin, { kind: 'model', model: 'deepseek-chat' })
  assert.deepEqual(append.message.content, [
    { type: 'thinking', thinking: 'thinking' },
    { type: 'text', text: 'answer' },
    { type: 'tool_use', id: 'c1', name: 'bash', input: { command: 'ls' } },
  ])
})

test('a tool result becomes a tool-result row', async () => {
  const { rows, seen } = setup()
  await rows.handle(agent, session, {
    type: 'tool/result',
    seq: 5,
    data: {
      turn: 1,
      step: 1,
      toolName: 'bash',
      message: {
        role: 'tool',
        id: 'r1',
        toolCallId: 'c1',
        isError: false,
        content: [{ type: 'text', text: 'file.txt' }],
        source: { kind: 'tool', callId: 'c1' },
      },
    },
  })
  const append = seen.find(([event]) => event === 'session.append')[1]
  assert.equal(append.door, 'tool-result')
  assert.deepEqual(append.message.content[0], {
    type: 'tool_result',
    tool_use_id: 'c1',
    content: [{ type: 'text', text: 'file.txt' }],
    is_error: false,
  })
})

test('turn start and end become turn.start and turn.complete', async () => {
  const { rows, seen } = setup()
  await rows.handle(agent, session, { type: 'turn/start', seq: 1, data: { turn: 1 } })
  await rows.handle(agent, session, { type: 'turn/end', seq: 9, data: { turn: 1, reason: { kind: 'completed' } } })
  assert.deepEqual(seen.filter(([event]) => event === 'turn.start')[0][1], { text: '', turnId: 'turn-1' })
  const complete = seen.find(([event]) => event === 'turn.complete')[1]
  assert.equal(complete.turnId, 'turn-1')
  assert.equal(complete.reason, 'answer')
  assert.equal(complete.isAborted, false)
})

test('a session title is written as a Claude-shaped transcript row', async () => {
  const home = await mkdtemp(join(tmpdir(), 'delta-dsh-rows-'))
  process.env.DSH_HOME = home
  const { rows } = setup()
  await rows.handle(agent, session, {
    type: 'session/title',
    seq: 6,
    data: { title: 'Fix the parser', messageSeqs: [], source: { kind: 'provider', provider: 'title' } },
  })
  const path = join(home, 'delta-dsh', 'claude', 'projects', '-work', 's1.jsonl')
  const text = await readFile(path, 'utf8')
  assert.match(text, /"type":"ai-title","aiTitle":"Fix the parser"/)
  delete process.env.DSH_HOME
})
