/**
 * The band's rendering: the element constructors `$.ui.resolve(e)` hands Delta,
 * their serialization into plain JSON for the Web client, and the per-session
 * surface store the browser watches and presses.
 *
 * Delta draws its band with classic JSX over constructors from `ui.resolve`;
 * this module supplies those constructors (the injected `h` calls them), keeps
 * buttons' `onPress` closures on the Host behind per-drawing action ids, and
 * publishes a generation-numbered snapshot the client renders.
 */

/** Flatten a JSX children value into the plain nodes a surface keeps. */
export function normalizeChildren(children) {
  const out = []
  const push = (value) => {
    if (value === undefined || value === null || value === false || value === true) return
    if (Array.isArray(value)) { for (const item of value) push(item); return }
    if (typeof value === 'string' || typeof value === 'number') { out.push(String(value)); return }
    if (typeof value === 'object') out.push(value)
  }
  push(children)
  return out
}

/** One element constructor for a name in the surface's element table. */
function constructor(type) {
  const element = (props) => ({
    type,
    props: { ...(props ?? {}) },
    children: normalizeChildren((props ?? {}).children),
  })
  element.dshElementType = type
  return element
}

/** The element table `$.ui.resolve(e)` returns: the subset Delta draws with. */
export function elementTable() {
  return {
    Box: constructor('Box'),
    Text: constructor('Text'),
    Button: constructor('Button'),
    Link: constructor('Link'),
    Markdown: constructor('Markdown'),
  }
}

/** Props the client renderer understands; anything else (callbacks included) is dropped. */
const BOX_PROPS = ['flexDirection', 'justifyContent', 'alignItems', 'columnGap', 'gap', 'paddingX', 'paddingY', 'padding', 'width', 'height', 'flexShrink', 'backgroundColor', 'border', 'borderColor', 'overflow', 'display']
const TEXT_PROPS = ['color', 'bold', 'dimColor', 'inverse', 'italic', 'underline', 'wrap', 'backgroundColor']
const BUTTON_PROPS = ['label', 'dimColor', 'plain', 'autoFocus', 'disabled', 'hotkey']
const LINK_PROPS = ['href', 'label']

function pick(props, names) {
  const out = {}
  for (const name of names) {
    const value = props?.[name]
    if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') out[name] = value
  }
  return out
}

/**
 * Serialize one render result (an element or a node list) for the browser.
 *
 * @returns `{ tree, actions }`: plain nodes, and the buttons' closures keyed by their action id.
 */
export function serializeRender(result) {
  const actions = new Map()
  let nextAction = 0
  const serialize = (node, keyPath) => {
    if (node === null || node === undefined || node === false || node === true) return null
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map((child, index) => serialize(child, `${keyPath}.${index}`)).filter((child) => child !== null)
    if (typeof node !== 'object') return null
    if (node.type === 'Fragment') {
      return { type: 'Box', props: { flexDirection: 'column' }, children: node.children.map((child, index) => serialize(child, `${keyPath}.${index}`)).filter((child) => child !== null) }
    }
    const type = node.type
    const props = node.props ?? {}
    const out = { type, props: {}, children: [] }
    if (type === 'Box') {
      out.props = pick(props, BOX_PROPS)
      out.props.key = typeof props.key === 'string' ? props.key : undefined
      out.children = node.children.map((child, index) => serialize(child, `${keyPath}.${index}`)).filter((child) => child !== null)
    } else if (type === 'Text' || type === 'Markdown') {
      out.type = 'Text'
      out.props = pick(props, TEXT_PROPS)
      out.children = node.children.map((child, index) => serialize(child, `${keyPath}.${index}`)).filter((child) => child !== null)
    } else if (type === 'Button') {
      out.props = pick(props, BUTTON_PROPS)
      out.children = node.children.map((child, index) => serialize(child, `${keyPath}.${index}`)).filter((child) => child !== null)
      if (typeof props.onPress === 'function') {
        const actionId = `a${++nextAction}`
        actions.set(actionId, props.onPress)
        out.actionId = actionId
      }
    } else if (type === 'Link') {
      out.type = 'Link'
      out.props = pick(props, LINK_PROPS)
      out.children = node.children.map((child, index) => serialize(child, `${keyPath}.${index}`)).filter((child) => child !== null)
    } else {
      return null
    }
    if (out.props.key === undefined) delete out.props.key
    return out
  }
  const tree = serialize(result, 'r')
  return { tree: tree === null ? null : (Array.isArray(tree) ? tree : [tree]), actions }
}

/**
 * One session's published band: the drawing generation, its serialized tree,
 * the buttons' closures, and the subscribers (open browser streams).
 */
class Surface {
  constructor(key) {
    this.key = key
    this.generation = 0
    this.tree = null
    this.actions = new Map()
    this.subscribers = new Set()
    this.status = undefined
  }

  snapshot() {
    return { generation: this.generation, tree: this.tree, status: this.status }
  }

  publish(result) {
    const { tree, actions } = serializeRender(result)
    this.generation += 1
    this.tree = tree
    this.actions = actions
    const snapshot = this.snapshot()
    for (const subscriber of [...this.subscribers]) {
      try { subscriber(snapshot) } catch {}
    }
    return snapshot
  }

  subscribe(subscriber) {
    this.subscribers.add(subscriber)
    try { subscriber(this.snapshot()) } catch {}
    return () => { this.subscribers.delete(subscriber) }
  }

  /** Run the button a press named in the drawing the browser saw; stale presses are refused. */
  async press(generation, actionId) {
    if (generation !== this.generation) return { ok: false, stale: true, snapshot: this.snapshot() }
    const action = this.actions.get(actionId)
    if (!action) return { ok: false, stale: true, snapshot: this.snapshot() }
    await action({ surface: 'desktop' })
    return { ok: true, snapshot: this.snapshot() }
  }
}

/** Every live session's band surface in this Host process. */
export class SurfaceHub {
  constructor() {
    this.surfaces = new Map()
  }

  surface(key) {
    let surface = this.surfaces.get(key)
    if (surface === undefined) {
      surface = new Surface(key)
      this.surfaces.set(key, surface)
    }
    return surface
  }

  current(key) {
    return this.surfaces.get(key)?.snapshot() ?? { generation: 0, tree: null }
  }

  publish(key, result) {
    return this.surface(key).publish(result)
  }

  subscribe(key, subscriber) {
    return this.surface(key).subscribe(subscriber)
  }

  /** Whether a browser is watching this session's band right now. */
  hasSubscribers(key) {
    const surface = this.surfaces.get(key)
    return surface !== undefined && surface.subscribers.size > 0
  }

  press(key, generation, actionId) {
    const surface = this.surfaces.get(key)
    if (surface === undefined) return Promise.resolve({ ok: false, stale: true, snapshot: { generation: 0, tree: null } })
    return surface.press(generation, actionId)
  }

  status(key, text) {
    const surface = this.surfaces.get(key)
    if (surface === undefined) return
    if (surface.status === text) return
    surface.status = text
    const snapshot = surface.snapshot()
    for (const subscriber of [...surface.subscribers]) {
      try { subscriber(snapshot) } catch {}
    }
  }

  dispose(key) {
    const surface = this.surfaces.get(key)
    if (surface === undefined) return
    for (const subscriber of [...surface.subscribers]) {
      try { subscriber({ generation: surface.generation + 1, tree: null }) } catch {}
    }
    this.surfaces.delete(key)
  }
}
