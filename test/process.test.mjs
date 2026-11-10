/**
 * The subprocess adapters: collected `run` and streaming `spawn` over a fake
 * Harness subprocess service. Delta's CLI and git paths go through both.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { runProcess, spawnProcess } from '../src/process.js'

/** A fake handle whose stdout/stderr the test feeds. */
function fakeHandle({ exitCode = 0, collected = true } = {}) {
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  let resolveDone
  const done = new Promise((resolve) => { resolveDone = resolve })
  const handle = {
    stdin: undefined,
    stdout: collected ? undefined : stdout,
    stderr: collected ? undefined : stderr,
    collected: collected ? {
      stdout: { readFrom: () => ({ text: 'collected-out', nextOffset: 0, lossy: false }) },
      stderr: { readFrom: () => ({ text: 'collected-err', nextOffset: 0, lossy: false }) },
    } : undefined,
    done,
    terminate() {},
    spawnOut(text) { stdout.emit('data', Buffer.from(text)) },
    spawnErr(text) { stderr.emit('data', Buffer.from(text)) },
    finish() { resolveDone({ exitCode, signal: null }) },
  }
  return handle
}

function subprocessReturning(handles) {
  const specs = []
  return {
    specs,
    spawn(spec) {
      specs.push(spec)
      return handles.shift()
    },
  }
}

test('run collects stdout, stderr and the exit code', async () => {
  const handle = fakeHandle()
  const subprocess = subprocessReturning([handle])
  const run = runProcess(subprocess, ['delta', '--json', 'auth', 'status'], {}, '/work')
  setTimeout(() => handle.finish(), 5)
  const result = await run
  assert.equal(result.stdout, 'collected-out')
  assert.equal(result.stderr, 'collected-err')
  assert.equal(result.exitCode, 0)
  assert.equal(result.isStdoutTruncated, false)
  assert.deepEqual(subprocess.specs[0].argv, ['delta', '--json', 'auth', 'status'])
  assert.equal(subprocess.specs[0].cwd, '/work')
})

test('spawn streams decoded chunks and ends with the exit', async () => {
  const handle = fakeHandle({ collected: false })
  const subprocess = subprocessReturning([handle])
  const stream = spawnProcess(subprocess, { argv: ['delta', '--json', 'thread', 'contract'] }, '/work')
  const chunks = []
  const reading = (async () => {
    for await (const chunk of stream) chunks.push(chunk)
  })()
  handle.spawnOut('{"min":')
  handle.spawnOut('8}')
  handle.spawnErr('warn')
  handle.finish()
  await reading
  assert.deepEqual(chunks, [
    { stream: 'stdout', text: '{"min":' },
    { stream: 'stdout', text: '8}' },
    { stream: 'stderr', text: 'warn' },
  ])
})

test('spawn pipes rather than collects, so chunks reach the reader', () => {
  const handle = fakeHandle({ collected: false })
  const subprocess = subprocessReturning([handle])
  spawnProcess(subprocess, { argv: ['delta'] }, '/work')
  assert.equal(subprocess.specs[0].stdio.stdout, 'pipe')
  assert.equal(subprocess.specs[0].stdio.stderr, 'pipe')
})

test('returning early terminates the child', async () => {
  const handle = fakeHandle({ collected: false })
  let terminated = 0
  handle.terminate = () => { terminated += 1 }
  const subprocess = subprocessReturning([handle])
  const stream = spawnProcess(subprocess, { argv: ['delta'] }, '/work')
  handle.spawnOut('ready')
  const first = await stream.next()
  assert.equal(first.value.text, 'ready')
  await stream.return()
  assert.equal(terminated, 1)
})
