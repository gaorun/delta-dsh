/**
 * The subprocess adapters against the real `delta` CLI: the collected `run`
 * used for one-shot answers and the streaming `spawn` used for `--json` output.
 * Skipped when the CLI is not installed.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { runProcess, spawnProcess } from '../src/process.js'

/** A Harness-subprocess-shaped service over node's child_process, for the two modes the adapter uses. */
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

/** Whether the test machine has the Delta CLI on PATH. */
async function hasDelta() {
  return await new Promise((resolve) => {
    const child = spawn('delta', ['--version'], { stdio: 'ignore' })
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
  })
}

test('the delta CLI contract answers through the streaming adapter', async (t) => {
  if (!(await hasDelta())) return t.skip('delta CLI is not installed')
  const stream = spawnProcess(localSubprocess(), { argv: ['delta', '--json', 'thread', 'contract'] }, process.cwd())
  let text = ''
  let exit
  for (;;) {
    const piece = await stream.next()
    if (piece.done) { exit = piece.value; break }
    if (piece.value.stream === 'stdout') text += piece.value.text
  }
  const contract = JSON.parse(text)
  assert.equal(typeof contract.min, 'number')
  assert.equal(typeof contract.max, 'number')
  assert.equal(exit.code, 0)
})

test('the delta CLI auth status answers through the collected adapter', async (t) => {
  if (!(await hasDelta())) return t.skip('delta CLI is not installed')
  const result = await runProcess(localSubprocess(), ['delta', '--json', 'auth', 'status'], {}, process.cwd())
  assert.equal(result.exitCode, 0)
  const status = JSON.parse(result.stdout)
  assert.equal(typeof status.status, 'string')
  assert.equal(result.isStdoutTruncated, false)
})
