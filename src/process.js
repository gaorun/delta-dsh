/**
 * `$.process.run` and `$.process.spawn` over the Harness subprocess service.
 *
 * Delta runs the Delta CLI and git through these two calls. `run` collects a
 * bounded stdout/stderr and resolves with the exit code; `spawn` yields decoded
 * stdout/stderr chunks as an async iterator and terminates the child when the
 * iterator returns early. The Harness subprocess service has no `run`, so `run`
 * is built on `spawn` with the collected-stdout mode.
 */
import { StringDecoder } from 'node:string_decoder'

/** Claude Code keeps each captured stream to 4 MiB and flags truncation. */
const CAPTURE_LIMIT = 4 * 1024 * 1024

/**
 * One Harness subprocess spawn spec for a Delta argv request.
 *
 * `run` wants the bounded collector mode; `spawn` streams raw pipes, because a
 * collected stream is not exposed as a Readable on the handle.
 */
function specFor(subprocess, argv, init = {}, cwd, mode = 'run') {
  const env = init.env ? { ...init.env } : undefined
  const stdin = typeof init.stdin === 'string' ? { data: init.stdin }
    : typeof init.input === 'string' ? { data: init.input } : 'ignore'
  const stdout = mode === 'run' ? { maxBytes: CAPTURE_LIMIT, spill: { maxBytes: 8 * 1024 * 1024 } } : 'pipe'
  const stderr = mode === 'run' ? { maxBytes: CAPTURE_LIMIT } : 'pipe'
  return {
    argv: [...argv],
    cwd: init.cwd ?? cwd ?? process.cwd(),
    stdio: { stdin, stdout, stderr },
    graceMs: 2_000,
    env,
    signal: init.signal,
  }
}

/** One collected spawn result as `$.process.run`'s answer. */
async function collect(handle) {
  const outcome = await handle.done
  const stdout = handle.collected?.stdout?.readFrom(0)
  const stderr = handle.collected?.stderr?.readFrom(0)
  return {
    exitCode: outcome.exitCode ?? null,
    stdout: stdout?.text ?? '',
    stderr: stderr?.text ?? '',
    isStdoutTruncated: stdout?.lossy === true,
    isStderrTruncated: stderr?.lossy === true,
    signal: outcome.signal ?? null,
  }
}

/** `$.process.run(argv, init)` with Delta's default 30s and 10min cap. */
export async function runProcess(subprocess, argv, init = {}, cwd) {
  const timeoutMs = Math.min(init.timeoutMs ?? 30_000, 10 * 60_000)
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, Math.max(1, timeoutMs))
  timer.unref?.()
  const onAbort = () => controller.abort()
  init.signal?.addEventListener('abort', onAbort, { once: true })
  // A caller's stdin arrives as a whole string in Delta's code paths.
  const handle = subprocess.spawn({ ...specFor(subprocess, argv, init, cwd), signal: controller.signal })
  try {
    const result = await collect(handle)
    if (timedOut) throw new Error(`command timed out after ${timeoutMs}ms: ${argv.join(' ')}`)
    if (init.signal?.aborted) throw new Error(`command cancelled: ${argv.join(' ')}`)
    return result
  } finally {
    clearTimeout(timer)
    init.signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * `$.process.spawn(request)`: an async iterator of `{stream, text}` chunks ending
 * with `{code, signal}`. Returning early kills the child, as Claude Code's does.
 */
export function spawnProcess(subprocess, request, cwd) {
  const handle = subprocess.spawn(specFor(subprocess, request.argv, request, cwd, 'spawn'))
  const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') }
  const queue = []
  const waiters = []
  let ended = false
  let killed = false
  let outcome
  const push = (chunk) => {
    if (ended) return
    queue.push(chunk)
    const waiter = waiters.shift()
    if (waiter) waiter()
  }
  for (const stream of ['stdout', 'stderr']) {
    const readable = handle[stream]
    if (!readable) continue
    readable.on('data', (buffer) => {
      const text = decoders[stream].write(buffer)
      if (text) push({ stream, text })
    })
    readable.on('end', () => {
      const text = decoders[stream].end()
      if (text) push({ stream, text })
    })
    readable.on('error', () => {})
  }
  handle.done.then((settled) => {
    outcome = settled
    ended = true
    for (const waiter of waiters.splice(0)) waiter()
  }, (error) => {
    outcome = { exitCode: null, signal: null, error }
    ended = true
    for (const waiter of waiters.splice(0)) waiter()
  })
  const iterator = {
    async next() {
      while (true) {
        if (queue.length) return { done: false, value: queue.shift() }
        if (ended) {
          if (outcome?.error) throw outcome.error
          return { done: true, value: { code: outcome?.exitCode ?? null, signal: outcome?.signal ?? null } }
        }
        await new Promise((resolve) => waiters.push(resolve))
      }
    },
    async return() {
      if (!killed) {
        killed = true
        try { handle.terminate() } catch {}
      }
      killed = true
      return { done: true, value: { code: null, signal: 'SIGTERM' } }
    },
    async throw(error) {
      await iterator.return()
      throw error
    },
    [Symbol.asyncIterator]() { return iterator },
  }
  return iterator
}
