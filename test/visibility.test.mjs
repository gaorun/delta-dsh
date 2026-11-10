/**
 * Which Sessions Delta serves and when the band shows (src/visibility.js).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bandShouldShow, findRepoRoot, isUserFacingSession, repoPolicyConfigured } from '../src/visibility.js'

async function policyRepo(policy) {
  const root = await mkdtemp(join(tmpdir(), 'delta-dsh-policy-'))
  await mkdir(join(root, '.git'))
  await mkdir(join(root, '.delta'))
  if (policy !== undefined) await writeFile(join(root, '.delta', 'settings.json'), JSON.stringify(policy))
  return root
}

test('the checkout root is the nearest ancestor holding .git', async () => {
  const root = await policyRepo({ threads: { mode: 'private' } })
  const nested = join(root, 'a', 'b')
  await mkdir(nested, { recursive: true })
  assert.equal(findRepoRoot(nested), root)
  assert.equal(findRepoRoot(await mkdtemp(join(tmpdir(), 'delta-dsh-nogit-'))), undefined)
})

test('only a deliberate valid policy counts as configured', async () => {
  assert.equal(repoPolicyConfigured(await policyRepo({ threads: { mode: 'private', organization: 'o1' } })), true)
  assert.equal(repoPolicyConfigured(await policyRepo({ threads: { mode: 'manual' } })), true)
  assert.equal(repoPolicyConfigured(await policyRepo(undefined)), false)
  assert.equal(repoPolicyConfigured(await policyRepo({ threads: {} })), false)
  assert.equal(repoPolicyConfigured(await policyRepo({ threads: { mode: 'other' } })), false)
  assert.equal(repoPolicyConfigured(await mkdtemp(join(tmpdir(), 'delta-dsh-outside-'))), false)
})

test('a malformed policy stays quiet instead of failing the draw', async () => {
  const root = await policyRepo(undefined)
  await mkdir(join(root, '.delta'), { recursive: true })
  await writeFile(join(root, '.delta', 'settings.json'), '{not json')
  assert.equal(repoPolicyConfigured(root), false)
})

test('the person-facing Sessions are root and not Team teammates', () => {
  const root = { session: { id: 's', header: {} } }
  const child = { session: { id: 'c', header: { parentSession: 's' } } }
  assert.equal(isUserFacingSession(root, undefined), true)
  assert.equal(isUserFacingSession(root, { role: 'lead' }), true)
  assert.equal(isUserFacingSession(root, { role: 'teammate' }), false)
  assert.equal(isUserFacingSession(child, { role: 'lead' }), false)
  assert.equal(isUserFacingSession(undefined, undefined), false)
})

test('the band shows only when Delta has something to say', () => {
  const base = { userFacing: true, configured: false, progress: false, watchError: false }
  // A checkout Delta was never used in stays quiet; setup/share are a command away.
  assert.equal(bandShouldShow({ ...base, binding: undefined }), false)
  // A configured checkout shows its manual reminder even without a binding.
  assert.equal(bandShouldShow({ ...base, binding: undefined, configured: true }), true)
  // A shared/synced/joined thread always shows.
  for (const binding of [{ thread: 't' }, { joined: true }, { joinTransition: {} }, { autoUpload: { mode: 'private' } }])
    assert.equal(bandShouldShow({ ...base, binding }), true)
  // Running operations and watch failures show even before the thread exists.
  assert.equal(bandShouldShow({ ...base, binding: undefined, progress: true }), true)
  assert.equal(bandShouldShow({ ...base, binding: undefined, watchError: true }), true)
  // A plain binding with a local-only capture shows only in a configured checkout.
  assert.equal(bandShouldShow({ ...base, binding: { snapshot: true } }), false)
  assert.equal(bandShouldShow({ ...base, binding: { snapshot: true }, configured: true }), true)
  // Agent-internal Sessions never show it.
  assert.equal(bandShouldShow({ ...base, userFacing: false, binding: { thread: 't' } }), false)
})
