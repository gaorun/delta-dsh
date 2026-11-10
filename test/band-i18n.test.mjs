/**
 * Chinese band copy: hint text is translated, proper nouns stay as written
 * (src/band-i18n.js).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { translateBandText } from '../src/band-i18n.js'

const zh = (text) => translateBandText(text, 'zh')

test('status labels are translated', () => {
  assert.equal(zh('Syncing'), '同步中')
  assert.equal(zh('Updating'), '更新中')
  assert.equal(zh('Not syncing'), '未同步')
  assert.equal(zh('Not set up'), '未设置')
  assert.equal(zh('copy link'), '复制链接')
  assert.equal(zh('✔ copied'), '✔ 已复制')
  assert.equal(zh('link appears when ready'), '链接就绪后显示')
  assert.equal(zh('Syncing to DeltaDB…'), '正在同步到 DeltaDB…')
})

test('proper nouns, commands, URLs and names stay untouched', () => {
  assert.equal(zh(' Delta'), ' Delta')
  assert.equal(zh('  /delta-setup'), '  /delta-setup')
  assert.equal(zh('  /delta-share'), '  /delta-share')
  assert.equal(zh('delta.dev/join/…t89yzv'), 'delta.dev/join/…t89yzv')
  assert.equal(zh('Maya'), 'Maya')
  assert.equal(zh('DeltaDB'), 'DeltaDB')
})

test('organization names are kept inside translated sentences', () => {
  assert.equal(zh('Synced with Zed VIP'), '已同步到 Zed VIP')
  assert.equal(zh('Shared with Zed VIP'), '已共享给 Zed VIP')
  assert.equal(zh('Share with Zed VIP'), '共享给 Zed VIP')
})

test('buttons and update rows are translated', () => {
  assert.equal(zh('Fork & Restore'), '派生并恢复')
  assert.equal(zh('Discard'), '丢弃')
  assert.equal(zh('Later'), '稍后')
  assert.equal(zh('Mute'), '静音')
  assert.equal(zh('Plugin 0.2.4'), '插件 0.2.4')
  assert.equal(zh('Waiting for installer approval'), '等待安装程序确认')
})

test('agent activity keeps the person name and translates the rest', () => {
  assert.equal(zh("Maya's agent"), 'Maya 的代理')
  assert.equal(zh('An agent'), '某个代理')
  assert.equal(zh(' starting…'), ' 启动中…')
  assert.equal(zh('quiet 12s'), '安静 12s')
  assert.equal(zh('(5s · 3 more running)'), '(5s · 3 个仍在运行)')
})

test('composed child rows are translated part by part', () => {
  assert.equal(zh('1 running · +2 queued'), '1 运行中 · +2 排队中')
  // The child row is composed from fragments: a prefix and kind, a name, a status suffix.
  assert.equal(zh('· agent '), '· 代理 ')
  assert.equal(zh(' running'), ' 运行中')
  assert.equal(zh(' running · +1 running'), ' 运行中 · +1 运行中')
  assert.equal(zh('· agent Maya running'), '· 代理 Maya 运行中')
})

test('progress lines are translated', () => {
  assert.equal(zh('Checking access to the shared thread…'), '正在检查共享线程访问权限…')
  assert.equal(zh('Mounting the thread’s worktrees…'), '正在挂载线程的工作树…')
  assert.equal(zh('Joined the shared thread'), '已加入共享线程')
})

test('other locales keep the original English', () => {
  for (const language of ['en', 'ja', 'fr', undefined, '']) {
    assert.equal(translateBandText('Syncing', language), 'Syncing')
    assert.equal(translateBandText('copy link', language), 'copy link')
  }
})

test('unknown text passes through unchanged', () => {
  assert.equal(zh('Something Delta has never said'), 'Something Delta has never said')
  assert.equal(zh(''), '')
})
