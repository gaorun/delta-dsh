/** The band surface: element serialization, generations, presses and stale presses. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { SurfaceHub, elementTable, normalizeChildren, serializeRender } from '../src/surfaces.js'

test('element constructors carry type, props and normalized children', () => {
  const { Box, Text } = elementTable()
  const tree = Box({ flexDirection: 'row', children: [Text({ color: 'green', children: 'ok' }), ' x', null] })
  assert.equal(tree.type, 'Box')
  assert.equal(tree.children.length, 2)
  assert.equal(tree.children[0].type, 'Text')
  assert.deepEqual(tree.children[0].children, ['ok'])
})

test('serialization drops callbacks into action ids and keeps plain props', () => {
  const { Box, Text, Button } = elementTable()
  const result = Box({ children: [Text({ bold: true, children: 'hi' }), Button({ label: 'Update', onPress: () => {} })] })
  const { tree, actions } = serializeRender(result)
  assert.equal(tree[0].props.flexDirection, undefined)
  const button = tree[0].children.find((node) => node.type === 'Button')
  assert.equal(typeof button.actionId, 'string')
  assert.equal(button.props.label, 'Update')
  assert.equal(typeof actions.get(button.actionId), 'function')
  const text = tree[0].children.find((node) => node.type === 'Text')
  assert.equal(text.props.bold, true)
})

test('publishing increments the generation and notifies subscribers', () => {
  const hub = new SurfaceHub()
  const { Text } = elementTable()
  const frames = []
  const unsubscribe = hub.subscribe('s1', (snapshot) => frames.push(snapshot))
  hub.publish('s1', Text({ children: 'first' }))
  hub.publish('s1', Text({ children: 'second' }))
  assert.equal(frames.length, 3)
  assert.equal(frames[1].generation, 1)
  assert.equal(frames[2].generation, 2)
  unsubscribe()
  hub.publish('s1', Text({ children: 'third' }))
  assert.equal(frames.length, 3)
})

test('a press runs the button of the drawing generation it names', async () => {
  const hub = new SurfaceHub()
  const { Button } = elementTable()
  let pressed = 0
  const snapshot = hub.publish('s1', Button({ label: 'Keep', onPress: () => { pressed += 1 } }))
  const actionId = snapshot.tree[0].actionId
  const result = await hub.press('s1', snapshot.generation, actionId)
  assert.equal(result.ok, true)
  assert.equal(pressed, 1)
  const stale = await hub.press('s1', snapshot.generation - 1, actionId)
  assert.equal(stale.ok, false)
  assert.equal(stale.stale, true)
  assert.equal(pressed, 1)
})

test('status is published with the snapshot and cleared when undefined', () => {
  const hub = new SurfaceHub()
  const frames = []
  hub.subscribe('s1', (snapshot) => frames.push(snapshot.status))
  hub.status('s1', 'Delta sharing paused')
  hub.status('s1', undefined)
  assert.deepEqual(frames, [undefined, 'Delta sharing paused', undefined])
})

test('children normalize nested arrays and drop non-renderable values', () => {
  assert.deepEqual(normalizeChildren([['a', false], 2, undefined, [['b']]]), ['a', '2', 'b'])
})
