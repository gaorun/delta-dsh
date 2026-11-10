// delta-dsh: Delta for DeepSeek Harness — browser half.
//
// Draws the band above the composer from the Host's same-origin API
// (GET /delta-dsh/band as Server-Sent Events, POST /delta-dsh/band/press) and
// sends a button press back. The Host keeps the button closures, so a press
// names the drawing generation it saw and a stale press is refused.
//
// This file is loaded verbatim by the Harness Client module system:
// window.__ModuleLoader__.load({ id, factory(require) }). The factory receives
// React from the platform module table; no other module is imported.
window.__ModuleLoader__.load({
  id: 'delta-dsh',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const NS = 'delta-dsh'
    const BASE = '/delta-dsh-api'
    const STYLE_ID = 'delta-dsh/Band.css'

    const en = {
      band: 'Delta',
      'press.failed': 'The button failed: {message}',
      'band.connecting': 'Connecting to Delta…',
    }
    const zh = {
      band: 'Delta',
      'press.failed': '按钮操作失败：{message}',
      'band.connecting': '正在连接 Delta…',
    }

    const css = `
.dsd-band{display:flex;flex-direction:column;gap:2px;margin:0 0 4px;padding:6px 10px;border-radius:8px;
 background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary);
 font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;line-height:18px;white-space:pre-wrap}
.dsd-box{display:flex;min-width:0}
.dsd-box[data-direction=row]{flex-flow:wrap;align-items:center}
.dsd-box[data-direction=column]{flex-direction:column}
.dsd-box[data-border]{border:.5px solid var(--dsw-alias-border-l2);border-radius:6px}
.dsd-text{display:inline}
.dsd-text[data-bold]{font-weight:600}
.dsd-text[data-dim]{color:var(--dsw-alias-label-tertiary)}
.dsd-text[data-italic]{font-style:italic}
.dsd-text[data-underline]{text-decoration:underline}
.dsd-band [data-color=yellow]{color:var(--dsw-alias-state-warn-primary)}
.dsd-band [data-color=red]{color:var(--dsw-alias-state-error-primary)}
.dsd-band [data-color=green]{color:var(--dsw-alias-state-success-primary)}
.dsd-band [data-color=cyan],.dsd-band [data-color=blue]{color:var(--dsw-alias-button-info-fill)}
.dsd-band [data-color=magenta]{color:var(--dsw-alias-state-business-primary)}
.dsd-band [data-color=gray]{color:var(--dsw-alias-label-tertiary)}
.dsd-band [data-color=white],.dsd-band [data-color=black]{color:var(--dsw-alias-label-primary)}
.dsd-button{border:.5px solid var(--dsw-alias-border-l2);color:inherit;font:inherit;cursor:pointer;
 background:0 0;border-radius:6px;align-items:center;gap:4px;margin:0 2px;padding:1px 8px;line-height:16px;display:inline-flex}
.dsd-button:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsd-button:disabled{cursor:default;opacity:.6}
.dsd-link{color:var(--dsw-alias-button-info-fill);text-decoration:none;cursor:pointer}
.dsd-link:hover{text-decoration:underline}
.dsd-status{color:var(--dsw-alias-label-tertiary);font-size:11px}
.dsd-notice{color:var(--dsw-alias-state-error-primary);font-size:11px}
`

    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'delta-dsh'
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = css
      document.head.appendChild(tag)
    }

    /** One prop-subset of a serialized node, as DOM attributes. */
    function textAttributes(props) {
      const color = typeof props.color === 'string' ? props.color : undefined
      return {
        'data-color': color === 'grey' ? 'gray' : color,
        'data-bold': props.bold === true ? true : undefined,
        'data-dim': props.dimColor === true ? true : undefined,
        'data-italic': props.italic === true ? true : undefined,
        'data-underline': props.underline === true ? true : undefined,
      }
    }

    function boxStyle(props) {
      const style = {}
      const unit = (value) => (typeof value === 'number' ? `${value * 4}px` : undefined)
      const paddingX = unit(props.paddingX ?? props.padding)
      const paddingY = unit(props.paddingY ?? props.padding)
      if (paddingX !== undefined) style.paddingLeft = style.paddingRight = paddingX
      if (paddingY !== undefined) style.paddingTop = style.paddingBottom = paddingY
      const gap = unit(props.columnGap ?? props.gap)
      if (gap !== undefined) style.gap = gap
      if (typeof props.width === 'number') style.width = `${props.width}ch`
      const bordered = props.border !== undefined && props.border !== false
      return {
        style,
        attributes: {
          'data-direction': props.flexDirection === 'row' ? 'row' : 'column',
          'data-border': bordered ? true : undefined,
        },
      }
    }

    /** One serialized node (Box/Text/Button/Link, or plain text). */
    function Node({ node, pending, onPress }) {
      if (typeof node === 'string') return node
      if (node === null || typeof node !== 'object') return null
      const children = (node.children ?? []).map((child, index) =>
        h(Node, { key: String(index), node: child, pending, onPress }))
      if (node.type === 'Text') {
        return h('span', { className: 'dsd-text', ...textAttributes(node.props ?? {}) }, ...children)
      }
      if (node.type === 'Link') {
        const href = typeof node.props?.href === 'string' ? node.props.href : undefined
        return h('a', {
          className: 'dsd-link',
          href,
          target: '_blank',
          rel: 'noreferrer noopener',
        }, ...(children.length ? children : [String(node.props?.label ?? href ?? '')]))
      }
      if (node.type === 'Button') {
        const label = String(node.props?.label ?? '')
        const actionId = typeof node.actionId === 'string' ? node.actionId : ''
        const disabled = node.props?.disabled === true || actionId === '' || pending !== undefined
        return h('button', {
          type: 'button',
          className: 'dsd-button',
          disabled,
          'aria-busy': pending === actionId ? true : undefined,
          onClick: () => onPress(actionId),
        }, ...(children.length ? children : [label]))
      }
      const { style, attributes } = boxStyle(node.props ?? {})
      return h('div', { className: 'dsd-box', style, ...attributes }, ...children)
    }

    /** The band above the prompt: the Host's current drawing and its buttons. */
    function Band({ useBand, press, t }) {
      const snapshot = useBand((value) => value)
      const [pending, setPending] = React.useState(undefined)
      const [notice, setNotice] = React.useState(undefined)
      const onPress = React.useCallback((actionId) => {
        if (!snapshot) return
        setPending(actionId)
        setNotice(undefined)
        press(snapshot.generation, actionId).then(
          () => setPending(undefined),
          (error) => {
            setPending(undefined)
            setNotice(t('press.failed', { message: error instanceof Error ? error.message : String(error) }))
          },
        )
      }, [press, t, snapshot?.generation])
      if (snapshot === undefined || snapshot.tree === null) return null
      return h('div', { className: 'dsd-band', role: 'group', 'aria-label': t('band'), 'data-generation': snapshot.generation },
        ...snapshot.tree.map((node, index) => h(Node, { key: `${snapshot.generation}.${index}`, node, pending, onPress })),
        snapshot.status ? h('div', { className: 'dsd-status' }, snapshot.status) : null,
        notice ? h('div', { className: 'dsd-notice', role: 'status' }, notice) : null,
      )
    }

    /** A minimal observable the slot renderer exposes as `useBand`. */
    class BandStore {
      constructor() {
        this.snapshot = undefined
        this.listeners = new Set()
      }
      getSnapshot() { return this.snapshot }
      subscribe(listener) {
        this.listeners.add(listener)
        return () => { this.listeners.delete(listener) }
      }
      set(next) {
        this.snapshot = next
        for (const listener of [...this.listeners]) listener()
      }
    }

    /**
     * Keep one session's store fed by polling the Host's snapshot, and allow
     * presses. The Harness web server finishes a prefix route's response when
     * its handler returns, so the band polls instead of holding an event stream.
     */
    function watchSession(sessionId) {
      const store = new BandStore()
      let closed = false
      let timer
      let generation = -1
      const apply = (snapshot) => {
        if (snapshot === null || typeof snapshot !== 'object') return
        if (snapshot.generation !== generation) {
          generation = snapshot.generation
          store.set(snapshot)
        }
      }
      const poll = async () => {
        if (closed) return
        try {
          const response = await fetch(`${BASE}/status?session=${encodeURIComponent(sessionId)}`, {
            headers: { accept: 'application/json' },
            cache: 'no-store',
          })
          if (response.ok) apply(await response.json())
        } catch {}
        if (!closed) timer = setTimeout(poll, 700)
      }
      void poll()
      const press = async (pressedGeneration, actionId) => {
        const response = await fetch(`${BASE}/band/press`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ session: sessionId, generation: pressedGeneration, actionId }),
        })
        const body = await response.json()
        if (!response.ok || body.error !== undefined) throw new Error(body.error ?? `press failed (${response.status})`)
        if (body.snapshot !== undefined) apply(body.snapshot)
        if (body.stale) throw new Error('That button belonged to an earlier drawing; the band has refreshed')
      }
      return {
        store,
        press,
        dispose() {
          closed = true
          clearTimeout(timer)
        },
      }
    }

    function registerUi(ctx, locale) {
      ctx.effect(() => locale.register(NS, { en, zh }), 'delta-dsh: dictionaries')
      const watches = new Map()
      ctx.effect(() => () => {
        for (const watch of watches.values()) watch.dispose()
        watches.clear()
      }, 'delta-dsh: band watches')
      const watchOf = (sessionId) => {
        let watch = watches.get(sessionId)
        if (watch === undefined) {
          watch = watchSession(sessionId)
          watches.set(sessionId, watch)
        }
        return watch
      }
      ensureStyle()
      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock',
        id: 'delta-dsh',
        order: 20,
        locale: NS,
        inject: (sessionId) => ({
          hooks: { band: watchOf(sessionId).store },
          press: (generation, actionId) => watchOf(sessionId).press(generation, actionId),
        }),
      }, Band))
    }

    function apply(ctx) {
      return ctx.inject(['slots', 'locale'], (scoped) => registerUi(scoped, scoped.locale))
    }

    exports.apply = apply
    exports.inject = ['slots', 'locale']
    return module.exports
  },
})
