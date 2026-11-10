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
    /**
     * Chinese copy for the Delta band.
     *
     * Delta's hooks draw the band in English because Claude Code has no locale
     * service. The Harness does, so the browser half translates the band's own
     * hint text at render time while leaving proper nouns — Delta, DeltaDB, team
     * names, people's names, URLs, and `/delta` commands — untouched. English (or
     * any other active locale) shows the original strings.
     */
    
    /** Exact status-band phrases, including the fragments with their leading spacing. */
    const ZH = {
      'Syncing': '同步中',
      'Updating': '更新中',
      'Not syncing': '未同步',
      'Not set up': '未设置',
      'Unlisted': '未公开',
      'Sharing after this turn': '本轮结束后共享',
      'Share after this turn': '本轮后共享',
      'copy link': '复制链接',
      'copy': '复制',
      '✔ copied': '✔ 已复制',
      'link appears when ready': '链接就绪后显示',
      'Syncing to DeltaDB…': '正在同步到 DeltaDB…',
      'Waiting to sync…': '等待同步…',
      'Updating Delta': '正在更新 Delta',
      'Checking for updates': '检查更新中',
      'Downloading': '下载中',
      'Preparing': '准备中',
      'Installing': '安装中',
      'Waiting for installer approval': '等待安装程序确认',
      'Waiting for you': '等待你的操作',
      'Plugin ': '插件 ',
      'Update': '更新',
      'Reload': '重载',
      'Details': '详情',
      'Later': '稍后',
      'Mute': '静音',
      'Fork & Restore': '派生并恢复',
      'Discard': '丢弃',
      ' starting…': ' 启动中…',
      'An agent': '某个代理',
      ' more running': ' 个仍在运行',
      'unknown': '未知',
      'agent': '代理',
      'thread': '线程',
      'child': '子会话',
      'running': '运行中',
      'failed': '失败',
      'queued': '排队中',
      'syncing': '同步中',
      'preparing': '准备中',
      'completed': '已完成',
      'stopped': '已停止',
      'inactive': '不活跃',
      'fail': '失败',
      'run': '运行',
      'sync': '同步',
      'queue': '排队',
      // Share, join, activation and update progress lines the band shows while it works.
      'Checking access to the shared thread…': '正在检查共享线程访问权限…',
      'Mounting the thread’s worktrees…': '正在挂载线程的工作树…',
      "Mounting the thread's worktrees…": '正在挂载线程的工作树…',
      'Starting a fresh Claude session…': '正在启动新的 Claude 会话…',
      'Connecting to the shared thread…': '正在连接共享线程…',
      'Reconnecting to the shared thread…': '正在重新连接共享线程…',
      'Joining the shared thread…': '正在加入共享线程…',
      'Connecting this session to Delta…': '正在把本会话连接到 Delta…',
      'Attaching the checkout…': '正在附加检出…',
      'Preparing to share…': '准备共享…',
      'Exporting earlier messages…': '正在导出历史消息…',
      'Publishing the thread…': '正在发布线程…',
      'Sending invitations…': '正在发送邀请…',
      'Syncing files…': '正在同步文件…',
      'Restoring this checkout’s synchronization…': '正在恢复此检出的同步…',
      "Restoring this checkout's synchronization…": '正在恢复此检出的同步…',
      'Waiting for Delta sign-in…': '等待 Delta 登录…',
      'Waiting for Delta to connect…': '等待 Delta 连接…',
      'Joined the shared thread': '已加入共享线程',
      'Moved to the thread folder': '已移动到线程文件夹',
      'Restored checkout synchronization': '已恢复检出同步',
      'Synced to DeltaDB': '已同步到 DeltaDB',
      'Opened the thread in a new session': '已在新会话中打开线程',
      'all changes': '全部变更',
    }
    
    /** Dynamic phrases, matched after the exact table. */
    const ZH_PATTERNS = [
      [/^Synced with (.+)$/, '已同步到 $1'],
      [/^Shared with (.+)$/, '已共享给 $1'],
      [/^Share with (.+)$/, '共享给 $1'],
      [/^Retrying: (.+)$/, '重试中：$1'],
      [/^Retry sync: (.+)$/, '重试同步：$1'],
      [/^Sync failed: (.+)$/, '同步失败：$1'],
      [/^Plugin (.+)$/, '插件 $1'],
      [/^(.+)'s agent$/, '$1 的代理'],
      [/^quiet (.+)$/, '安静 $1'],
      [/^(\d+) more running$/, '$1 个仍在运行'],
      [/^\+(\d+) ([a-z_]+)$/, (match, count, state) => `+${count} ${ZH[state] ?? state}`],
      [/^(\d+) ([a-z_]+)$/, (match, count, state) => `${count} ${ZH[state] ?? state}`],
      // Host status lines the band shows below the row: hint prefixes are translated
      // and the reason text after them stays as Delta reported it.
      [/^Delta sharing paused: (.+)$/, 'Delta 共享已暂停：$1'],
      [/^Delta participation is blocked: (.+)$/, 'Delta 参与已暂停：$1'],
      [/^Delta is not ready for this prompt: (.+)$/, 'Delta 尚未准备好此提示：$1'],
      [/^Delta join failed: (.+)$/, 'Delta 加入失败：$1'],
      [/^Delta could not (.+)$/, 'Delta 无法 $1'],
      [/^(.+) could not sign in to Delta: (.+)$/, '$1 无法登录 Delta：$2'],
      [/^The Delta watcher is not ready: (.+)$/, 'Delta 监听尚未就绪：$1'],
    ]
    
    /**
     * Translate one band text fragment for the active locale.
     *
     * @param text the fragment Delta's hooks produced.
     * @param language the active locale id, such as `zh` or `en`.
     * @returns the Chinese copy for a Chinese locale, the input otherwise.
     */
    function translateBandText(text, language) {
      if (typeof text !== 'string' || !/^zh/i.test(String(language ?? ''))) return text
      // A fragment whose spacing is part of its copy (a suffix such as ' starting…').
      if (ZH[text] !== undefined) return ZH[text]
      // The band composes rows from fragments separated by ' · '; translate each part.
      if (text === ' · ') return text
      if (text.includes(' · ')) return text.split(' · ').map((part) => translateFragment(part, false)).join(' · ')
      return translateFragment(text, true)
    }
    
    /** One fragment, keeping its leading/trailing spacing around the translated words. */
    function translateFragment(text, keepSpacing) {
      const leading = keepSpacing ? text.match(/^\s*/)[0] : ''
      const trailing = keepSpacing ? text.match(/\s*$/)[0] : ''
      const body = text.slice(leading.length, text.length - trailing.length)
      if (body.length === 0) return text
      const direct = ZH[body]
      if (direct !== undefined) return `${leading}${direct}${trailing}`
      for (const [pattern, replacement] of ZH_PATTERNS) {
        const match = body.match(pattern)
        if (match === null) continue
        const translated = typeof replacement === 'function' ? replacement(...match) : body.replace(pattern, replacement)
        return `${leading}${translated}${trailing}`
      }
      // Fragments composed around a name: the child kind, a running count, or a
      // child status word stays translatable wherever the composer placed it.
      let worded = body
        .replace(/\b(agent|thread|child)\b/g, (word) => ZH[word] ?? word)
        .replace(/\b(\d+) more running\b/g, '$1 个仍在运行')
        .replace(/(^|\s)(running|failed|queued|syncing|preparing|completed|stopped|inactive|unknown)(?=\s|$)/g,
          (whole, space, word) => `${space}${ZH[word] ?? word}`)
      if (worded !== body) return `${leading}${worded}${trailing}`
      return text
    }
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

    // The dock strip sizes and centres itself the way the Harness's own dock
    // entries do (see the shipped GoalBar): the slot is wider than the composer
    // card, so the entry subtracts the composer's side clearance and dock insets
    // and caps itself at the card's max width. Without this the band starts at
    // the window edge instead of the input box's left edge.
    const css = `
.dsd-dock{box-sizing:border-box;width:calc(100% - 2 * var(--dsh-composer-side-clearance, 0px) - 4 * var(--dsh-composer-dock-inset, 0px));margin:0 auto}
.dsd-band{box-sizing:border-box;width:100%;max-width:calc(var(--dsh-composer-card-max-width, 100%) - 4 * var(--dsh-composer-dock-inset, 0px));margin:0 auto 4px;padding:6px 10px;border-radius:8px;
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
    function Node({ node, pending, onPress, tr }) {
      if (typeof node === 'string') return tr(node)
      if (node === null || typeof node !== 'object') return null
      const children = (node.children ?? []).map((child, index) =>
        h(Node, { key: String(index), node: child, pending, onPress, tr }))
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
        }, ...(children.length ? children : [tr(String(node.props?.label ?? href ?? ''))]))
      }
      if (node.type === 'Button') {
        const label = tr(String(node.props?.label ?? ''))
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
    function Band({ useBand, press, t, language }) {
      const snapshot = useBand((value) => value)
      const currentLanguage = typeof language === 'function' ? language() : language
      const tr = (text) => translateBandText(text, currentLanguage)
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
      return h('div', { className: 'dsd-dock' },
        h('div', { className: 'dsd-band', role: 'group', 'aria-label': t('band'), 'data-generation': snapshot.generation },
          ...snapshot.tree.map((node, index) => h(Node, { key: `${snapshot.generation}.${index}`, node, pending, onPress, tr })),
          snapshot.status ? h('div', { className: 'dsd-status' }, tr(snapshot.status)) : null,
          notice ? h('div', { className: 'dsd-notice', role: 'status' }, notice) : null,
        ),
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
      let lastFocus = 0
      const apply = (snapshot) => {
        if (snapshot === null || typeof snapshot !== 'object') return
        if (snapshot.generation !== generation) {
          generation = snapshot.generation
          store.set(snapshot)
        }
      }
      // Tell the Host this is the Session the person is looking at: Delta follows
      // one Session at a time, so opening a conversation moves the band (and the
      // thread watch) to it.
      lastFocus = Date.now()
      fetch(`${BASE}/focus`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session: sessionId }),
      }).catch(() => {})
      const poll = async () => {
        if (closed) return
        try {
          const response = await fetch(`${BASE}/status?session=${encodeURIComponent(sessionId)}`, {
            headers: { accept: 'application/json' },
            cache: 'no-store',
          })
          if (response.ok) {
            const snapshot = await response.json()
            apply(snapshot)
            // A dock can mount before its Session's agent exists; while the band
            // is empty, ask the Host to focus this Session again (throttled).
            if ((snapshot === null || snapshot.tree === null) && Date.now() - lastFocus > 5_000) {
              lastFocus = Date.now()
              fetch(`${BASE}/focus`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ session: sessionId }),
              }).catch(() => {})
            }
          }
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
          language: () => {
            try { return locale.getLocale().active } catch { return 'en' }
          },
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
