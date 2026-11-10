/**
 * Dialog localization: Delta's questions, options and headers in Chinese, with
 * answers mapped back to Delta's original labels (src/dialog-i18n.js).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { translateDialog, translateQuestion } from '../src/dialog-i18n.js'

const zh = (text) => translateDialog(text, 'zh')

test('headers and options are translated', () => {
  assert.equal(zh('Delta setup'), 'Delta 设置')
  assert.equal(zh('Team'), '团队')
  assert.equal(zh('Cancel'), '取消')
  assert.equal(zh('Not now'), '暂不')
  assert.equal(zh('Set up now'), '现在设置')
})

test('proper nouns, team names, paths and commands stay as written', () => {
  assert.equal(zh('Delta'), 'Delta')
  assert.equal(zh('/delta-setup'), '/delta-setup')
  assert.equal(zh('Currently: Private sync with Zed VIP.'), '当前：私有同步（团队 Zed VIP）。')
  assert.equal(zh('Create a new team called “Zed VIP”?'), '创建名为“Zed VIP”的新团队？')
  assert.equal(zh('Replace the unreadable Delta settings at /repo/.delta/settings.json?'),
    '替换 /repo/.delta/settings.json 处无法读取的 Delta 设置？')
})

test('questions and interpolated options are translated', () => {
  assert.match(zh('Which team should sessions from this repository sync to? Only you see a session until you share it. To create a new team, select “Type something” and enter its name; creating a team makes sharing easier.'), /^此仓库的会话应同步到哪个团队？/)
  assert.equal(zh('Team sharing (every new session, visible to Zed VIP)'), '团队共享（每个新会话，Zed VIP 可见）')
  assert.equal(zh('Share with Zed VIP'), '共享给 Zed VIP')
  assert.equal(zh('Your new setting starts with your next session. Sync this session to Zed VIP too?'),
    '新设置从下一个会话生效。是否也把当前会话同步到 Zed VIP？')
  assert.equal(zh('Who should join Zed VIP? Select “Type something” and enter their email addresses, separated by commas.'),
    '谁加入 Zed VIP？选择“输入内容”并输入邮箱地址，用逗号分隔。')
})

test('the mode question keeps its policy prefix and translates the explanation', () => {
  const question = "Delta isn't set up for this repository yet. When Delta syncs a Claude Code session, it stores the conversation and a copy of this checkout's code, including uncommitted changes, in DeltaDB. This applies to new sessions, not this one. Which sessions should Delta sync?"
  const translated = zh(question)
  assert.ok(translated.startsWith('这个仓库还没有设置 Delta。'))
  assert.ok(translated.includes('Delta 同步时会将会话内容'))
})

test('answers map back to the original English labels', () => {
  const { question, options, originalOf } = translateQuestion('Who should see this session?', [
    { label: 'Just me (sync privately)' },
    { label: 'Keep current sharing', description: 'Invite anytime with /delta-org invite' },
  ], 'zh')
  assert.equal(question, 'Who should see this session?')
  assert.equal(options[0].label, '仅自己（私有同步）')
  assert.equal(options[1].description, '随时可用 /delta-org invite 邀请')
  assert.equal(originalOf.get('仅自己（私有同步）'), 'Just me (sync privately)')
  assert.equal(originalOf.get('保持当前共享范围'), 'Keep current sharing')
})

test('other locales and unknown text pass through', () => {
  for (const language of ['en', 'ja', undefined, '']) {
    assert.equal(translateDialog('Delta setup', language), 'Delta setup')
  }
  assert.equal(zh('Something Delta has never asked'), 'Something Delta has never asked')
})
