/**
 * Display filters for the Delta band.
 *
 * Delta's hooks draw a generic permanent-failure line ("Not syncing: Fix the
 * cause") when activation fails without a specific, actionable reason. It
 * repeats on every redraw and tells the person nothing they can act on, so the
 * port does not show a band whose only content is that line. Any band with a
 * link, people, a share control or a specific message still draws.
 */

/** Every string in one serialized node tree, flattened. */
function texts(nodes, out = []) {
  for (const node of nodes ?? []) {
    if (typeof node === 'string') { out.push(node); continue }
    if (node === null || typeof node !== 'object') continue
    texts(node.children, out)
  }
  return out
}

/** Whether a serialized band has any interactive control (a link or a button). */
function interactive(nodes) {
  for (const node of nodes ?? []) {
    if (node === null || typeof node !== 'object') continue
    if (node.type === 'Link' || node.type === 'Button' || typeof node.actionId === 'string') return true
    if (interactive(node.children)) return true
  }
  return false
}

/**
 * A band whose only content is the generic "Not syncing: Fix the cause" advice.
 * The English and translated copies both count; a specific failure reason does
 * not (it stays visible).
 */
export function isGenericFailureBand(tree) {
  if (!Array.isArray(tree) || tree.length === 0) return false
  if (interactive(tree)) return false
  const joined = texts(tree).join(' ').replace(/\s+/g, ' ').trim()
  if (!joined.includes('Fix the cause')) return false
  return joined.includes('Not syncing') || joined.includes('未同步')
}
