/**
 * Documented edits to the vendored Delta hooks for the Harness.
 *
 * `vendor/delta` is a copy of this repository's `hooks/`, kept byte-identical
 * except for the replacements below. `scripts/sync-delta.mjs` re-applies them
 * after every copy, so the port never quietly forks the shared code.
 *
 * Every replacement must match exactly once; a missed anchor fails the sync
 * instead of leaving the port running silently unpatched.
 */
export const patches = [
  {
    file: 'sharing/join.ts',
    why: 'Claude Code joins by starting a fresh Session after /clear and moving it with /cd. The Harness keeps one Session per tab: the current Session joins in place, its working directory moves through the adapter\'s cd, and there is no plugin-callable /clear. This patch replaces only the session transition; mounting, verification, activation and every failure path stay Delta\'s.',
    find: `    const handsOff = (await host.session.surfaces()).includes('desktop')
    // \`/delta join\` is the request, and the fresh session leaves this one resumable, so the only
    // question is Claude's own folder trust prompt.
    if (!handsOff) await requireJoinCommands(host, ['clear', 'cd'])
`,
    replace: `    const handsOff = (await host.session.surfaces()).includes('desktop')
    // The Harness has no plugin-callable /clear or /cd: the Session joins in place, and the
    // adapter moves its working directory when completeJoin asks for cd.
`,
  },
  {
    file: 'sharing/join.ts',
    why: 'Same in-place join: skip the fresh-session sequence (clear, new id, duplicate-binding check) and save the transition under the current Session instead, so completeJoin mounts and enters the directory as it does for a retried transition.',
    find: `    setProgress(host, 'Starting a fresh Claude session…', 'active')
    request.clearing = true
    try { await host.command.run({ command: 'clear' }) }
    finally { request.clearing = false }
    fresh = await host.session.id()
    if (fresh === request.session) {
      fresh = undefined
      throw new Error('Claude did not create a fresh session after /clear; the old binding was not replaced')
    }
    request.fresh = fresh
`,
    replace: `    // Join in place: the Harness Session keeps its identity and its conversation, and the
    // working directory transition below is the only move. (Claude Code needed /clear here.)
    fresh = request.session
    request.fresh = fresh
`,
  },
]

/** Apply every patch to its file, refusing a file whose anchor does not appear exactly once. */
export async function applyPatches(readFile, writeFile, root) {
  const results = []
  for (const patch of patches) {
    const path = `${root}/${patch.file}`
    const text = await readFile(path, 'utf8')
    const count = text.split(patch.find).length - 1
    if (count !== 1) throw new Error(`vendor patch for ${patch.file} matched ${count} times, expected 1`)
    await writeFile(path, text.replace(patch.find, patch.replace), 'utf8')
    results.push(patch.file)
  }
  return results
}
