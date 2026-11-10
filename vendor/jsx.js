/**
 * The JSX factory the Claude Code engine injects globally while it loads a mod's
 * hooks module. The Delta hooks are written in classic JSX (`h(...)` calls with
 * element constructors from `$.ui.resolve`), so the DSH port injects this module
 * into every bundled source file (esbuild `inject`) to supply the same names.
 *
 * `h(tag, props, ...children)`: an element constructor from `ui.resolve` is called
 * with merged children; a string tag is kept as plain text data. `Fragment` is a
 * column of its children, matching the engine's documented behavior.
 */

/** Merge JSX children into the props the constructor receives. */
function withChildren(props, children) {
  const next = { ...(props ?? {}) }
  const flat = children.flat(Infinity).filter((child) => child !== undefined && child !== null && child !== false && child !== true)
  if (flat.length === 1) next.children = flat[0]
  else if (flat.length > 1) next.children = flat
  else if (!('children' in next)) next.children = undefined
  return next
}

/** The classic-runtime JSX factory. */
export function h(tag, props, ...children) {
  const merged = withChildren(props, children)
  if (typeof tag === 'function') return tag(merged)
  return merged.children
}

/** `<>…</>`: a column of the children. */
export function Fragment(props) {
  return { type: 'Fragment', props: {}, children: normalizeChildren(props?.children) }
}

/** A render node list as the surface expects: plain data, text, or elements. */
export function normalizeChildren(children) {
  if (children === undefined || children === null || children === false || children === true) return []
  if (Array.isArray(children)) return children.flatMap(normalizeChildren)
  return [children]
}
