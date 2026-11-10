/**
 * Copy Delta's runtime hooks (the Claude Code mod in this repository's hooks/
 * directory) into vendor/delta so the DSH bundle is self-contained. Tests,
 * fixtures and the generated type declarations are not copied.
 *
 * Run with: node scripts/sync-delta.mjs
 */
import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { readFile, writeFile } from 'node:fs/promises'
import { applyPatches } from './patches.mjs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const plugin = join(here, '..')
const source = join(plugin, '..', 'hooks')
const target = join(plugin, 'vendor', 'delta')

/** Directories under hooks/ that hold runtime modules. */
const RUNTIME_DIRS = ['band', 'cli', 'core', 'plugin-update', 'recording', 'setup', 'sharing', 'subagents', 'watch']
/** Runtime files at the root of hooks/. */
const RUNTIME_FILES = ['register.tsx']

async function copyRuntime(file, destination) {
  await mkdir(dirname(destination), { recursive: true })
  await cp(file, destination)
}

async function main() {
  await rm(target, { recursive: true, force: true })
  for (const file of RUNTIME_FILES) await copyRuntime(join(source, file), join(target, file))
  for (const dir of RUNTIME_DIRS) {
    const from = join(source, dir)
    for (const entry of await readdir(from)) {
      if (entry.endsWith('.test.ts') || entry.endsWith('.test.tsx')) continue
      const file = join(from, entry)
      if (!(await stat(file)).isFile()) continue
      await copyRuntime(file, join(target, dir, entry))
    }
  }
  const patched = await applyPatches(readFile, writeFile, target)
  const copied = []
  async function count(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name)
      if (entry.isDirectory()) await count(file)
      else copied.push(relative(target, file))
    }
  }
  await count(target)
  console.log(`vendor/delta: ${copied.length} files copied from ${relative(plugin, source)}; patched ${[...new Set(patched)].join(', ')}`)
}

await main()
