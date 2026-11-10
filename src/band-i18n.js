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
export function translateBandText(text, language) {
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
