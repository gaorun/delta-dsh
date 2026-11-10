/**
 * Which Sessions Delta serves, and which show its band.
 *
 * The Claude Code plugin runs one process per Session, so a band on every
 * process meant a band on every Session the person opened. A Harness Host runs
 * every root Session in one process, including Team teammates and child agents
 * the person never opened a tab for, so the port has to discriminate:
 *
 * - Only a user-facing root Session is recorded at all. Team teammates and
 *   subagent children are not recorded and never ask a Delta question.
 * - A Session shows the band only when Delta has something to say about it: it
 *   has a thread (shared, synced or joined), a join or upload in flight, a
 *   running operation or a watch failure, or its checkout has a deliberate
 *   Delta policy (the "manual" reminder). A checkout Delta was never set up in
 *   stays quiet — `/delta-setup` and `/delta-share` are still one command away.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** The checkout root above `cwd`: the nearest directory holding `.git` (a directory or worktree file). */
export function findRepoRoot(cwd) {
  let directory = cwd
  while (directory !== undefined && directory.length > 0) {
    try {
      if (existsSync(join(directory, '.git'))) return directory
    } catch {}
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
  return undefined
}

/** How long a policy read is reused; the band redraws on every poll of an open page. */
const POLICY_TTL_MS = 10_000
const policyCache = new Map()

/** Whether the checkout containing `cwd` has a valid `.delta/settings.json` policy. */
export function repoPolicyConfigured(cwd) {
  const cached = policyCache.get(cwd)
  if (cached !== undefined && Date.now() - cached.at < POLICY_TTL_MS) return cached.configured
  const root = findRepoRoot(cwd)
  let configured = false
  if (root !== undefined) {
    const path = join(root, '.delta', 'settings.json')
    try {
      const document = JSON.parse(readFileSync(path, 'utf8'))
      const mode = document?.threads?.mode
      configured = typeof mode === 'string' && ['manual', 'private', 'organization'].includes(mode)
      // A malformed policy is a problem the plugin reports through its own
      // offer; it is not a reason to leave the band on.
    } catch (error) {
      configured = false
      // Distinguish "no policy" from "unreadable policy" only for cost: both
      // stay quiet; a malformed file is surfaced by the setup offer instead.
    }
  }
  policyCache.set(cwd, { at: Date.now(), configured })
  return configured
}

/** A user-facing root Session: not a subagent child, not a Team teammate. */
export function isUserFacingSession(agent, membership) {
  if (agent === undefined || agent === null || agent.session === undefined) return false
  if (agent.session.header?.parentSession !== undefined) return false
  if (membership?.role === 'teammate') return false
  return true
}

/**
 * Whether one Session shows the band, given what Delta knows about it.
 *
 * @param options.userFacing the Session may be recorded and shown at all.
 * @param options.binding its Delta binding, when it has one.
 * @param options.configured whether its checkout has a deliberate Delta policy.
 * @param options.progress whether a share, join or installation update is running.
 * @param options.watchError whether its thread watch reports a failure.
 */
export function bandShouldShow({ userFacing, binding, configured, progress, watchError }) {
  if (!userFacing) return false
  if (progress || watchError) return true
  if (binding === undefined || binding === null) return configured
  if (binding.thread || binding.joined || binding.joinTransition || binding.autoUpload) return true
  return configured
}
