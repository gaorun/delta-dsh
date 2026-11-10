/**
 * The band's display filter for Delta's generic permanent-failure line
 * (src/band-visibility.js).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { isGenericFailureBand } from '../src/band-visibility.js'

/** Shorthand for a text node tree like the one the Host serializes. */
const text = (value, props = {}) => ({ type: 'Text', props, children: [value] })
const box = (children) => ({ type: 'Box', props: { flexDirection: 'column' }, children })

test('the generic English failure band is hidden', () => {
  const tree = [box([
    box([text('✕'), text(' Delta'), text(' · '), text('Not syncing: Fix the cause')]),
  ])]
  assert.equal(isGenericFailureBand(tree), true)
})

test('the translated generic failure band is hidden', () => {
  const tree = [box([box([text('✕'), text(' Delta'), text(' · '), text('未同步：Fix the cause')])])]
  assert.equal(isGenericFailureBand(tree), true)
})

test('a specific failure reason stays visible', () => {
  const tree = [box([box([text('✕'), text(' Delta'), text(' · '), text('Not syncing: sign in with `delta auth login`')])])]
  assert.equal(isGenericFailureBand(tree), false)
})

test('a band with a link, people or a button stays visible', () => {
  const withButton = [box([box([text('✕'), text(' Delta'), text('Not syncing: Fix the cause')]),
    { type: 'Button', props: { label: 'copy link' }, children: [], actionId: 'a1' }])]
  assert.equal(isGenericFailureBand(withButton), false)
  const withLink = [box([{ type: 'Link', props: { href: 'https://delta.dev/join/x' }, children: [] }])]
  assert.equal(isGenericFailureBand(withLink), false)
})

test('normal and empty bands are untouched', () => {
  assert.equal(isGenericFailureBand(null), false)
  assert.equal(isGenericFailureBand([]), false)
  assert.equal(isGenericFailureBand([box([box([text('●'), text(' Delta'), text(' · '), text('Syncing')])])]), false)
})
