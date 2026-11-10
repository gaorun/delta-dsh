/**
 * Chinese copy for Delta's questions (the setup wizard, share audience, sign-in
 * prompts) and their options.
 *
 * Dialog text reaches the Harness question UI through `ctx.userQuestions`, which
 * has no locale of its own: the browser half reports its active locale with the
 * focus request, and the Host translates question, options and descriptions
 * before asking. Delta matches answers against the original English option
 * labels, so the Host keeps a reverse map and unwraps the answer before
 * returning it to Delta's code.
 *
 * Proper nouns stay as written: Delta, DeltaDB, organization/team names, emails,
 * paths, and `/delta` commands.
 */

/** Question and option copy that appears verbatim. */
const ZH = {
  // Headers.
  'Delta setup': 'Delta 设置',
  'Delta share': 'Delta 共享',
  'Delta': 'Delta',
  'Team': '团队',

  // Onboarding (the port no longer offers it; kept so a future offer reads correctly).
  'The Delta plugin is installed, but nothing in this repository syncs until you set it up. You\'ll configure your team and which sessions to sync. Set it up now?':
    'Delta 插件已安装，但此仓库尚未设置同步。你将选择团队以及哪些会话同步。现在就设置吗？',
  'Set up now': '现在设置',
  "Delta isn't set up here, so nothing syncs. Run /delta-setup to set it up, or /delta-share to sync and share just this session.":
    'Delta 在此仓库尚未设置，不会同步。运行 /delta-setup 进行设置，或运行 /delta-share 仅同步并分享本次会话。',

  // Setup: team, mode, new team, invitations.
  'Which team should sessions from this repository sync to? Only you see a session until you share it. To create a new team, select “Type something” and enter its name; creating a team makes sharing easier.':
    '此仓库的会话应同步到哪个团队？分享前只有你可见。要创建团队，选择“输入内容”并输入团队名；创建团队便于后续共享。',
  'Create a team to more easily share sessions with others. Only you see a session until you share it, or skip this step to keep sessions to yourself.':
    '创建团队以便与他人共享会话。分享前只有你可见；也可以跳过此步，让会话仅自己可见。',
  'Skip this step (keep sessions to myself)': '跳过此步（会话仅自己可见）',
  'Create a team': '创建团队',
  'Cancel': '取消',
  'Current team': '当前团队',
  'Create a team: select “Type something” and enter its name.': '创建团队：选择“输入内容”并输入团队名。',
  'Back to the list': '返回列表',
  'Create it': '创建',
  'Invite later': '稍后邀请',
  'Manage team in browser': '在浏览器中管理团队',
  'Invite anytime with /delta-org invite': '随时可用 /delta-org invite 邀请',
  'Replace it': '替换它',
  'Private sync (every new session, only you see it until you share)': '私有同步（每个新会话，分享前只有你可见）',
  'Manual (only sessions you share with /delta-share)': '手动（仅 /delta-share 分享的会话）',
  "Delta isn't set up for this repository yet.": '这个仓库还没有设置 Delta。',
  'Currently: Manual (only sessions you share with /delta-share).': '当前：手动（只有你用 /delta-share 分享的会话才同步）。',
  "When Delta syncs a Claude Code session, it stores the conversation and a copy of this checkout's code, including uncommitted changes, in DeltaDB. This applies to new sessions, not this one. Which sessions should Delta sync?":
    'Delta 同步时会将会话内容以及此检出的代码副本（包括未提交改动）存入 DeltaDB。该设置对新会话生效，不影响当前会话。哪些会话应同步？',
  'Your new setting starts with your next session. Sync this session privately too?': '新设置从下一个会话生效。是否也私有同步当前会话？',
  'Sync it': '同步',
  'Not now': '暂不',

  // Share audience.
  'Who should see this session? Delta syncs its conversation and a copy of this checkout\'s code, including uncommitted changes, to DeltaDB. To invite people by email instead, select “Type something” and enter their addresses, separated by commas.':
    '谁可以看到此会话？Delta 会将会话内容及此检出的代码副本（包括未提交改动）同步到 DeltaDB。若要按邮箱邀请，选择“输入内容”并输入邮箱地址（逗号分隔）。',
  'Just me (sync privately)': '仅自己（私有同步）',
  'Keep current sharing': '保持当前共享范围',

  // Sign-in and beta terms.
  'Delta needs you to sign in before it can sync. Sign in with your browser?': 'Delta 需要登录后才能同步。使用浏览器登录？',
  'Sign in': '登录',
  'Delta needs you to accept its beta terms before it can sync. Open them in your browser?':
    'Delta 需要先接受 Beta 条款才能同步。在浏览器中打开？',
  'Open the beta terms': '打开 Beta 条款',
  'Delta is waiting for you to finish signing in with your browser. Stop waiting?': 'Delta 正在等待你完成浏览器登录。停止等待？',
  'Delta is waiting for you to accept its beta terms in your browser. Stop waiting?': 'Delta 正在等待你在浏览器中接受 Beta 条款。停止等待？',
  'Stop waiting': '停止等待',
  'Keep waiting': '继续等待',
}

/** Interpolated question and option copy, matched after the exact table. */
const ZH_PATTERNS = [
  [/^Currently: Private sync with (.+)\.$/, '当前：私有同步（团队 $1）。'],
  [/^Currently: Team sharing with (.+)\.$/, '当前：团队共享（团队 $1）。'],
  [/^Team sharing \(every new session, visible to (.+)\)$/, '团队共享（每个新会话，$1 可见）'],
  [/^Create a new team called “(.+)”\?$/, '创建名为“$1”的新团队？'],
  [/^Who should join (.+)\? Select “Type something” and enter their email addresses, separated by commas\.$/,
    '谁加入 $1？选择“输入内容”并输入邮箱地址，用逗号分隔。'],
  [/^Replace the unreadable Delta settings at (.+)\?$/, '替换 $1 处无法读取的 Delta 设置？'],
  [/^Share with (.+)$/, '共享给 $1'],
  [/^Your new setting starts with your next session\. Sync this session to (.+) too\?$/, '新设置从下一个会话生效。是否也把当前会话同步到 $1？'],
  [/^This repository syncs to (.+), which your Delta account isn't a member of, so its sessions don't sync for you\. Choose a team you're in, or cancel to leave it unchanged\.$/,
    '此仓库会同步到 $1，但你的 Delta 账号不属于该团队，所以会话不会同步。请选择一个你所在的团队，或取消以保持不变。'],
]

/**
 * Translate one dialog string for the active locale.
 *
 * @param text a question, option label, option description or header.
 * @param language the active locale id, such as `zh` or `en`.
 */
export function translateDialog(text, language) {
  if (typeof text !== 'string' || !/^zh/i.test(String(language ?? ''))) return text
  const direct = ZH[text]
  if (direct !== undefined) return direct
  for (const [pattern, replacement] of ZH_PATTERNS) {
    if (pattern.test(text)) return text.replace(pattern, replacement)
  }
  // The mode question is a policy sentence followed by a fixed explanation; translate
  // the explanation wherever it appears after a prefix.
  const explanation = 'When Delta syncs a Claude Code session, it stores the conversation and a copy of this checkout\'s code, including uncommitted changes, in DeltaDB. This applies to new sessions, not this one. Which sessions should Delta sync?'
  if (text.includes(explanation)) {
    const prefix = text.slice(0, text.indexOf(explanation)).trim()
    const translatedPrefix = prefix.length ? translateDialog(prefix, language) : ''
    return `${translatedPrefix}${translatedPrefix ? ' ' : ''}${ZH[explanation]}`
  }
  return text
}

/**
 * Translate a question and its options for display, returning the reverse map
 * that turns the person's answer back into Delta's original labels.
 *
 * @returns `question`, `header`, display `options`, and `originalOf` by display label.
 */
export function translateQuestion(question, options, language) {
  const originalOf = new Map()
  const shownOptions = (options ?? []).map((option) => {
    const original = option.label
    const translated = translateDialog(original, language)
    if (translated !== original) originalOf.set(translated, original)
    return {
      ...option,
      ...(option.description === undefined ? {} : { description: translateDialog(option.description, language) }),
      label: translated,
    }
  })
  return {
    question: translateDialog(question, language),
    options: shownOptions,
    originalOf,
  }
}
