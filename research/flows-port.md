# Delta for Claude Code → Delta for DSH：流程/状态/UI 行为规格

> 调研对象：`/Users/run/my-repos/delta-claude`（Claude Code 插件 delta，`hooks/` 为 TS 源码）。
> 目标：为 DSH 插件 `delta-dsh` 提供可直接照做的行为规格。所有结论带 `路径:行号` 证据。
> 本文只覆盖 task-2 范围：setup/、sharing/、watch/、subagents/、band/、plugin-update/、`cli/install-update.ts`、`cli/auth.ts`、README、release-notes；为说明流程串联，少量引用 `register.tsx`、`core/`、`recording/prompt.ts`、`cli/delta-cli.ts`、`cli/thread-commands.ts`。

## 0. 前提与阅读说明

### 0.1 任务描述与实际文件不符之处

- 任务里列的 `hooks/setup/auto.ts` **不存在**；`hooks/setup/` 只有 `auto.test.ts`（1024 行测试）。"自动同步"的真实实现全部在 `hooks/setup/activation.ts`：`startSession`（`activation.ts:488-528`）读仓库策略，`activateAutomatically`（`activation.ts:575-689`）执行创建/上传/挂载，`retryAutomaticActivation`（`activation.ts:51-56`）做失败重试。
- 同理，`hooks/setup/interaction.ts` 只是把 Claude 的 `$.ui.ask`/浏览器/进程绑定注入 wizard；问题文案在 `setup.ts`、`delta-menu.ts`、`share-audience.ts`、`auth.ts` 里。

### 0.2 DSH 侧调研限制（重要）

- Host 侧可查（`cordis_inspect_query`）：`Service`/`Event` 目录、`claudeCodeMods` 桥、`commands`、`userQuestions` 契约均已取到，见 §10。
- **Client 侧 Slot 枚举失败**：`Slots.listSubTree`、Client `Service.listService` 均 10s 超时（"Open or reconnect the Harness page"），因此 DSH 里 band 应挂在哪个具体 slot、slot props 是什么 **尚需在打开 GUI 页面后复查**。§10 给出的是"由 Host Remote 提供数据、Client slot 渲染"的结构建议，不是最终 slot key。
- DSH 已存在 `claudeCodeMods` 桥（Claude Code mod 兼容层），提供 `ui.render` 的 `AbovePrompt` + `Box/Text/Button` 序列化树、`watchBand`/`pressBand`、以及 mod 事件。**这是本项目的头号决策点**（见 §10.4）。

### 0.3 一句话总览（状态机索引）

| 流程 | 入口 | 结束态 | 主要持久化 |
| --- | --- | --- | --- |
| 首次 setup 邀约 | 新会话 `session.start`（`activation.ts:488`） | 决定过（写/拒）或清标记重来 | store `setup-offered:<gitCommonDir>` |
| setup 向导 | `/delta-setup`、邀约、`/delta setup` | 写 `.delta/settings.json` 或 cancelled | `.delta/settings.json`、`.git/info/exclude` |
| 自动同步 | 新会话 + policy 为 private/organization | binding 有 thread；或 "Not syncing" 卡死 | binding（store `session:<id>`）+ outbox 文件 |
| share | `/delta-share [emails]`、band 按钮、setup 尾部 | `Shared`/`Synced privately`/`Invited N people`/失败 | binding thread/url/visibility/autoUpload |
| join | `/delta-join <link>` | 新会话加入 thread 并 `/cd` 到 mount 目录 | binding joined+locator+owner+directory+mounts |
| Desktop handoff | join 在 desktop surface | 新 Desktop 会话 claim 后 join | `${pluginData}/handoffs/<owner>.json` |
| org | `/delta-org …` | CLI 直通输出 | 无（进程内缓存 org 名/当前 org） |
| watch | thread 绑定后 `startConversation` | 持续 live，掉线重连/暂停 | store `appended:<id>` ledger、binding.execution |
| 子代理记录 | 子代理 loop 的第一个 hook | 子 thread 记录/被接管/被拒 | store `child:<session>:<agentId>` + 独立 outbox |
| app/CLI 更新 | `/delta-update`、启动检查 | updated/up_to_date/unsupported/失败 | 无（安装锁进程内） |
| 插件自更新 | 启动+每小时检查、`/delta-plugin-update` | 装好后请求 reload/提示新会话 | store `plugin-update:check`、`:notifications`、`:reminder:<branch>` |

---

## 1. 命令族与菜单

### 1.1 注册了哪些斜杠命令

`registerCommands`（`hooks/setup/commands.ts:40-51`）在 `session.start` 时注册（`hooks/register.tsx:238`）：

| 命令 | description（原文） | argumentHint |
| --- | --- | --- |
| `delta` | `Share or join a Delta session, set up syncing, choose a team, or update Delta` | `share [<email>…] | join <shared-link-or-thread> | setup | update | plugin-update | org list | org current | org switch <ID> | org manage` |
| `delta-share` | `Delta: sync this session and its code to DeltaDB, and choose who sees it` | `[<email>…]` |
| `delta-join` | `Delta: join a shared conversation. Needs its link: /delta-join <link>`（描述里带格式，因为 Claude 菜单不显示 argumentHint，见 `commands.ts:45`） | `<shared-link-or-thread>` |
| `delta-setup` | `Delta: choose which sessions in this repository sync to DeltaDB` | — |
| `delta-update` | `Delta: update the installed Delta app and CLI` | — |
| `delta-plugin-update` | `Delta: update this Claude Code plugin and apply it when supported` | `check | notifications on|off` |
| `delta-org` | `Delta: manage your team. /delta-org list, current, switch <ID>, invite <email>, or manage` | `list | current | switch <ID> | invite <email>… | manage` |

分发在 `command.run` 的 matcher 上（`register.tsx:258-302`）：`delta` 的 args 直接作为动作串；`delta-share` → `share <args>`；`delta-join` 无参数时**进菜单**（`deltaMenu(host,'join',JOIN_USAGE,…)`，`register.tsx:276-281`）；`delta-org` 无参数时进菜单（start=`team`，`register.tsx:297-302`）；`delta-setup`/`delta-update`/`delta-plugin-update` 走 `runDeltaCommand` 并带 `form='dedicated_command'`。

> **Claude 特有**：`delta` 命令还被插件自己用来"画行"——内部形式 `delta show <itemId>`，`origin.kind==='plugin' && origin.name===plugin` 时直接返回 `showAnswer(id)`（`register.tsx:258-270`）。DSH 无此需要（见 §7.5）。

### 1.2 裸 `/delta` 菜单（`delta-menu.ts`）

顶部标题 `header='Delta'`（12 字符以内，`delta-menu.ts:12`）。常量：`Share this session` / `Join a shared session` / `Set up this repository` / `More actions` / `Manage your team` / `Update Claude Code plugin` / `Update Delta app and CLI` / `Invite people` / `List my teams` / `Manage team in browser` / `Back to the menu` / `Cancel`（`delta-menu.ts:13-24`）。

状态机（`delta-menu.ts:34-61`，`MenuStart = 'menu' | 'join' | 'team' | 'more'`）：

1. `menu`：问题 **"What would you like to do with Delta?"**，options `[SHARE, JOIN, SETUP, MORE]`，header `Delta`；descriptions：`JOIN`→`Needs the link someone shared with you`，`MORE`→`Manage your team or update Delta`（`delta-menu.ts:37-40`）。
   - SHARE→`share`；SETUP→`setup`；JOIN→`join`；MORE→`more`；其他（自由输入）→ `undefined`（什么都不做，返回空）。
2. `more`：问题 **"Which Delta action?"**，options `[TEAM, PLUGIN_UPDATE, APP_UPDATE, BACK]`，header `Delta`（`delta-menu.ts:49-51`）。PLUGIN_UPDATE→`plugin-update`；APP_UPDATE→`update`；BACK→回 menu；TEAM→`team`；其他→undefined。
3. `join`：问题 **`Which shared session? Select “Type something” and paste its link.`**，options `[BACK, CANCEL]`（`delta-menu.ts:65-71`）。输入里含空格或以 `/` 开头或为空 → undefined。有效→`join <link>`。
4. `team`：问题 **"What would you like to do with your team?"**，options `[INVITE, MANAGE, LIST, BACK]`（`delta-menu.ts:76-81`）。LIST→`org list`；MANAGE→`org manage`；BACK→回 menu；INVITE→再问 **`Who should join your team? Select “Type something” and enter their email addresses, separated by commas.`**，options `[BACK, CANCEL]`（`delta-menu.ts:82-84`），无邮箱也照样执行 `org invite`（让后续文案解释用法）。
5. 返回的 action 串交给 `runDeltaCommand(host, action, form)`（`commands.ts:58-68`）。

交互不可用/被 dismiss 的降级：`InteractionDismissedError` → 返回 `{}`（不进 transcript）；`InteractionUnavailableError` → 返回 usage 文本（`commands.ts:59-68`）。

### 1.3 动作分派与拒绝（`commands.ts:93-150`）

`runDeltaCommand` 顺序（这是 DSH 重写时的分支表）：

1. `noticeSession(host)`：确保会话已启动（`commands.ts:94`）。
2. `plugin-update` / `plugin-update …` → `pluginUpdateCommand`（95-96）。
3. `update` → `installationUpdates.update(installUpdateHost(host), form)`（97）。
4. `org manage` → 打开 dashboard 成员页（98；实现 70-78）。
5. 若动作以 `setup|share|join` 开头且**有浏览器等待中的登录** → 问 "Stop waiting?"（99-100；实现见 `interaction.ts:52-62`），返回空。
6. `setup` → 检查交互面后跑 wizard（101-102），成功后 `refreshReminder`。
7. 其余按正则解析：`join <locator>`、`org (list|current|switch <ID>)`、`org invite <emails>`、`share [emails]`（103-109）。
8. 不匹配 → `DELTA_USAGE`（110-111）。
9. 已有 join/share 在跑 → `'A Delta join is already in progress. Wait for its result.'` / `'A Delta share is already in progress…'`（112-113）。
10. org 子命令 → `orgCommand`（114-115）；invite 无邮箱 → 用法文案 + dashboard 链接（116-124）。
11. share/join 前：`session !== activation.session || !binding` → `activate`；非交互面 → 固定拒绝文案（125-130）：
    `"/delta-join 或 /delta-share needs an interactive Claude Code terminal or Desktop Code tab. Print mode, SDK sessions, and cloud runners aren't supported."`
12. join：当前有 turn 或 `promptEntering` → `'Wait for the current Claude turn to finish before joining.'`；否则 `startJoin(...)` 立即返回 `{}`（131-137）。
13. share：当前有 turn → `'Wait for the current Claude turn to finish before sharing.'`；否则 `startShare(...)` 返回 `{}`（138-142）。
14. 只有 activation 抛错 → `setProgress(error)` + `shareFailureText(...)`（144-149）。

usage 原文：`DELTA_USAGE`（33）、`JOIN_USAGE`（35）、`ORG_USAGE`（37）。

### 1.4 交互原语（DSH 结构化提问需要照抄的细节）

- `AskOptions` 是 `readonly string[]` 或 `{ options, header?, multiSelect?, descriptions? }`（`setup.ts:28-31`）。**Claude 的 `$.ui.ask` 只接受 label 列表**，`descriptions` 不进提问，而是插件在 `ui.render` 的 `AskUserQuestion` 里把 label→description 塞进选项（`interaction.ts:166-189`，注册在 `register.tsx:186-189`）。DSH 的 `AskUserQuestionOption` 原生有 `description`（见 §10.2），所以这层 hack 在 DSH 不需要。
- header ≤ 12 字符（`setup.ts:215` 注释；`share-audience.ts:37`）；选项上限 4（`setup.ts:242-243`）：`$.ui.ask` 最多四个选项，团队列表只给 3 个 + skip/cancel。
- 自由输入永远由宿主画在最后一行，标签 `“Type something”`（`setup.ts:169` 的 `TYPE_SOMETHING`）；插件无法移动/改名，所以需要输入的问题都在文案里点名它（如 `TEAM_NAME_QUESTION`，`setup.ts:217`）。
- `ask` 返回字符串；被 dismiss → `InteractionDismissedError`；宿主没有该 API（TypeError）→ `InteractionUnavailableError`（`interaction.ts:199-218`）。空答案当 dismiss。
- 多行消息不能一条 `ui.log` 发出（transcript 会把内嵌换行压成 U+FFFD），按行拆开逐条（`interaction.ts:219-224`，`rows.tsx:39-44`）。
- 同一进程同一文案只提示一次：`notifyOnce`（`interaction.ts:229-234`）。

### 1.5 org 命令族

- `orgCommand` 不走 `--json`，直接 `delta org list|current|switch -- <id>|invite -- <emails>`，把 CLI 的人类输出原样回给命令（`cli/delta-cli.ts:184-202`）。失败包装为 `Delta team command failed: …`。
- `/delta-org manage`：找 current org，交互面用 `open <dashboardUrl>` 打开；否则给链接。`DASHBOARD_URL='https://dashboard.zed.dev'`，成员页 `${DASHBOARD_URL}/<orgId>/members`（`setup.ts:172-185`；`commands.ts:70-78`）。
- invite 无邮箱的文案（`commands.ts:119-122`）：`Usage: /delta-org invite <email> [<email>…]. Invites people to your current Delta team. To invite many people at once, use the dashboard: <membersUrl>`。
- 进程内缓存：`organizationNames`(id→name)、`currentOrganizationId`、`personalIds`；`loadOrganizationDirectory` 每进程读一次 org list + auth status（`organizations.ts:10-49`）。band 的 `Shared with <org>` 依赖这份缓存，后续重画才填上（`band.tsx:211-212`）。

### 1.6 DSH 映射

- 命令：`commands.register(CommandDefinition)`（Host），`handler(invocation) → {kind:'success', text?, sourceEventSeq?}` 或 `{kind:'error', text}`；UI 直接执行不进模型 turn（见 §10.2）。`argumentHint` 对应 `input: { hint }`。`/delta` 的"子命令菜单"在 DSH 可继续用提问实现（`userQuestions.ask`），或改用 `input.hint` 文本约定。
- 交互：`userQuestions.ask({questions:[{id,question,header?,detail?,options:[{label,description?}],multiSelect?}], agent, signal})`；一次可问多题（DSH 比 Claude 强，可把 setup 的"团队→模式"两题合并，但建议保持一问一答以贴合文案）。
- 直通命令：`orgCommand` 原样保留，只把 `process.run` 换成 DSH 的 subprocess 服务。

---

## 2. 激活与自动同步

### 2.1 会话生命周期的 hook 顺序（Claude Code 语义 → DSH 要重建的时序）

`register.tsx`：

| Claude 事件 | 插件动作 |
| --- | --- |
| `session.attach` | desktop 时重新检查插件更新（145-150） |
| `session.start` | 版本警告 → `registerCommands` → `installationUpdates.check`（延迟 0）→ `startPluginUpdates` → `activate` → 等 `handoffClaim` → `noticeStart`（233-256） |
| `prompt.submit` | `admitPrompt` 门禁（152-158） |
| `turn.start` / `turn.complete` | 主 loop 记录 execution；子代理走 child 分支（163-178） |
| `session.append`（doors: prompt/command/response/tool-result/delivery + tool-message 非 Skill） | 记录行（307-310） |
| `session.send` | 把 Delta 线程当子代理（312-323） |
| `tool.call` | 记录工具结果；Agent 调用期间跟踪 foreground/background（326-330） |
| `ui.render` | `AbovePrompt`→band；`AskUserQuestion`→hint；`UserMessage`→藏 echo；`CommandOutput`→画远程消息（180-200） |
| `session.end` | 停插件更新、清理 join/share、释放 mounts、`markEnded`（201-223） |
| `config.set{key:'theme'}` | 清 band 底色缓存（226-231） |
| `command.run` | 各命令（258-302） |

**DSH 等价**：`session/created`、`session/event`、`session/flush`、`agent/created`、`agent/disposed`、`agent/turn-stopping`、`agent/inbox/*`、`agent/status` 等 Host 事件（已从 `Event` 目录确认存在），外加 `commands`/`userQuestions` 服务；没有 `session.attach`、`session.append`、`session.send`、`ui.render` 的 UserMessage/CommandOutput。逐项见 §10。

### 2.2 会话"怎么开始的"判定

Claude 只把 start source 报给 `classic.SessionStart`，而组织 guard 不让用户插件收到，所以插件自己推（`activation.ts:179-257`）：

- `sessionStarts: Map<sessionId, 'startup'|'clear'|'resume'>`；`startedSession`、`endedSession`、`successor: 'clear'|'resume'|'join'`。
- `noticeStart`（201-206）：`activation.session` 已是它才继续。
- `noticeSession`（218-237）：幂等；先启 `startPluginUpdates`；`decideStart`：
  - `successor` 有值 → 用它（`join` 记为 `clear`，并 `return false`，因为新会话属于 join）；
  - 否则 `session.turns()===0 ? 'startup' : 'resume'`（读取失败默认 `resume`，248-250）；
  - 只有"新会话"（startup/clear）且非 join、非已 joined binding 才 `beginCaptureDecision`（255-256）。
- `forgetSessionStart`（317-334）：删除 start 状态；按 `session.end.reason` 设置 `successor`（`clear`+进行中 join→`join`；`clear`/`resume`→自身）；释放未决定的 setup offer（防"跳过"永久生效）；`decideCapture` 放行采集边界。

**DSH**：`session/created` 事件带 `SessionStartSource`（`agents.announce(agent, source)`），可直接拿到 start source，不必自己推（省掉这一整块）。

### 2.3 `activate()` 主状态机（`activation.ts:58-161`）

每会话一次、可重入（`activation.epoch` 防陈旧）：

1. 定位 Claude 配置目录 → `pluginData = <config>/delta-plugin`，`outbox = <pluginData>/outbox`（63-67）。**DSH 需改为 `$DSH_PROFILE_DIR` 或插件数据目录**。
2. session 变化先 `stopConversation()`（68）。
3. `load(session)` binding；若 `endedAt` 存在则删除并保存（"复活"）（71-79）。
4. 续接判定：`continuationCandidate`（session 来源 resume、无 thread/snapshot/joinTransition，`activation.ts:370-372`）→ `continuedFrom`（扫 store 所有 `session:` 找 `continuedIn===session` 或 transcript 尾部 `continued-in` 记录，`347-390`）→ `adoptContinuation`（父会话标记 `continuedIn`，子继承 binding/producer/ledger，`398-422`）。
5. `joinTransition` 存在 → 记 error（"join directory transition is incomplete… prompts remain blocked"）并 return（90-93）。
6. 未记录过的会话若落在 handoff 目录里 → `pendingHandoff` → `claimHandoff`，先 claim 再继续（95-102）。
7. `endDeliveryFailures`、`scheduleOutboxCleanup`、`pruneStore`（后台，30 天保留期，见 §2.7）（103-107）。
8. `activationIncomplete`（有 autoUpload 但无 thread）→ `retryAutomaticActivation` 并 return（110-113）。
9. 有 snapshot 且绑定目录：pause `watcher`；`requireContract` 失败 → pause `delivery` + band/transcript 报 "Delta participation is blocked: …" 并 return（114-134）。
10. `binding.joined && !runtime.mounted` → `beginRestore`（后台恢复 mounts + `/cd`）并 return（130-133）。
11. `checkoutNeedsMount` → `beginRestoreCheckout`（后台恢复用户 checkout 挂载）并 return（135-138）。
12. 有 thread：离线会话直接起 watcher（后台）否则 `startParticipation`；自动会话 `followUpload`；`recoverExecution`（清理上次进程遗留的 running execution，`delivery.ts:513-523`）（139-153）。
13. 有 pending 且无 captureFailure → `drain`；有 children → `restoreChildren`（154-157）。

### 2.4 自动同步（repo policy）状态机与原文案

`startSession`（`activation.ts:488-528`）：

1. `checkoutRoot`（`git rev-parse --show-toplevel`，失败即静默返回：不在 checkout 里）。
2. 读 `.delta/settings.json`：读失败 → 一次性提示
   `Delta settings at <path> couldn't be read (<err>). Until it's fixed, only sessions you share with /delta-share sync.`
   `problem` 字段存在 → 提示 `…couldn't be used (<problem>). … Run /delta-setup to replace it.`（496-504）。
3. **新会话** + `recordsAutomatically(policy)`：
   - 若该目录被别的 joined thread 占着（`joinedBindingAt(root)`）→ 提示 `"<root> is a worktree of a Delta thread a Claude session joined, so this session isn't recorded automatically. Run /delta-join with that thread's link to record in it."`（505-506）。
   - 否则 `activateAutomatically(host, session, root, {mode, organization})`（507-509）。
4. `finally decideCapture(session)`：**先放行采集边界再弹 setup offer**，保证 offer 对话框不挡记录（510-513）。
5. 非交互面：不发 reminder、不 offer，直接返回（514-515）。
6. `runtime.reminder = syncReminder(policy)`（`configured ? 'manual' : 'not set up'`，`activation.ts:555-558`），`ui.invalidate()`。
7. `offerOnboarding(...)`（519-522），`refreshReminder`（527）。

`activateAutomatically`（`activation.ts:575-689`）——幂等、每会话去重（`autoActivating`）：

1. 前置：`existing.thread` 或 `snapshot&&!autoUpload` 或 `joined/joinTransition` → 什么都不做（582-585）。
2. 新会话并行算 `policyMisconfiguration(org)`（`listOrganizations` 在 30s 内；空列表/读失败**不拒绝**，`712-721`）。
3. `requireContract`：CLI 契约版本必须 ∈ [8,8]（`thread-commands.ts:402-408,460-465`）。
4. 永久性拒绝（未登录且非交互、或 org 不匹配）→ `stopAutomaticRecording`（见下）并 return。
5. `!existing.snapshot` → **先落 staged binding** `{session, snapshot:true, next:1, pending:[], checkout:root, autoUpload}`（606-610）——网络步骤之前先持久化意图。
6. `decideCapture(session)` 放行新会话活动（612-613）。
7. 交互面：`requireAuthentication`（`auth.ts:46-152`），进度条 "Waiting for Delta sign-in…"；失败/取消 → `stopAutomaticRecording`，band：
   `Not syncing: Delta sign-in incomplete · /delta-share`（626-636）。
8. 进度 `Connecting this session to Delta…`（648）。
9. `threadCreate(externalId=session, organization:{id, visibility: mode})`（649-651）。
10. `attachWorktree(root, thread, …)`（653）→ 保存 `checkoutReference`（655）→ `mountCheckout`（656-658）。
11. 全部成功后才把 `thread` 写进 binding（661-663）——"thread 可见 = 所有步骤成功"。
12. `startConversation` + `drain` + `clearProgress` + `followUpload`（666-671）。
13. 失败分类：`permanent` → `stopAutomaticRecording(activationRefusal(...))`；否则进度错误 + 一次性提示
    `Delta couldn't start syncing this session: <err>. Nothing is lost; Delta retries on your next prompt.`（676-684）。

`stopAutomaticRecording`（745-768）：删除 `session:<id>` binding、清 outbox（在 `serial` 内做，防与 share 竞态）、`finishProgress(band, 'error')`，transcript 解释按 `auto-refused:<gitCommonDir>` 去重（每仓库每原因一次）。band 文案来自三种 refusal：

- 未登录：band `Not syncing: sign in with `delta auth login``，transcript（`694-697`）。
- 非团队成员：band `Not syncing: your Delta account isn't in this repo's team · /delta-share`（`699-705`）。
- 永久失败：`Not syncing: <advice>`（`724-735`，advice 来自 `permanentFailureAdvice`，`thread-commands.ts:180-209`）。

### 2.5 每仓库一次的 setup 邀约（`offerOnboarding`，`setup.ts:541-558`）

条件：`!configured && !joined && !joining && newToPlugin`（`activation.ts:519-522` 传入；`newToPlugin = newSession || loadedMidSession`）。

- 幂等标记 key：`setup-offered:${await env.gitCommonDir() ?? root}`；**先写标记再提问**（两会话并发只弹一次）；linked worktree 共享 git common dir，所以共享标记（`setup.ts:546-549`）。
- 只有"决定"消费邀约：`Not now`、或 setup 写成（`wrote`）→ 算 settled；dismiss/取消/失败/无法提问 → `releaseOnboarding` 写回 `false`，下个新会话再问（`550-557`，`561-563`）。
- 会话结束时若 offer 还开着：`forgetSessionStart` 里 `releaseOnboarding`（`activation.ts:325-331`）。
- 文案：
  - 问题 `ONBOARDING_QUESTION`：`The Delta plugin is installed, but nothing in this repository syncs until you set it up. You'll configure your team and which sessions to sync. Set it up now?`（565-567），options `[Set up now, Not now]`，header `Delta setup`（578）。
  - `Not now` → transcript `ONBOARDING_DECLINED`（569-570）。
  - `Set up now` → 跑 wizard，结果写 transcript；只有 `wrote` 算 settled（589-599）。

### 2.6 setup 向导全文（`runSetupWizard` → `askAndWrite`，`setup.ts:287-413`）

前置（都没有问题就先失败，避免问完再失败）：

1. 非 Git checkout → `/delta-setup needs a Git checkout: <err>`（298-299）。
2. Git remote 不可识别 → `remoteRefusal`（`setup.ts:156-163`）：
   - 无 remote：`This repository has no Git remote, and Delta needs one to sync it. Add a remote and push to it, then run /delta-setup again`
   - 多 remote 且无 `origin`：`Delta can't sync this repository because it has several Git remotes (…), and none is named origin, so Delta can't tell which one is the repository. Rename the one you push to: git remote rename <name> origin. Then run /delta-setup again`
3. 读 settings 失败 → 失败文案；JSON 坏 → 提示 `Delta could not read <path>: <problem>. Its contents were left untouched.` 然后问
   **`Replace the unreadable Delta settings at <path>?`** options `[Replace it, Cancel]`（308-311）。
4. `contract()`（含 resolveCli 安装 + `thread contract`），refusal → 失败；然后 `authenticate`（313-322）。
5. `organizations()`；若已有 policy 指向的 org 不在列表 → 先提示（329-331）。

问题序列：

**Q1 团队**（`setup.ts:342-366`）：

- 有 team 时问题：`Which team should sessions from this repository sync to? Only you see a session until you share it. To create a new team, select “Type something” and enter its name; creating a team makes sharing easier.`
- 无 team 时问题：`Create a team to more easily share sessions with others. Only you see a session until you share it, or skip this step to keep sessions to yourself.`
- options：有 team → 当前 team + 至多再 2 个（`MAX_ORGANIZATION_OPTIONS=3`），最后是 `Skip this step (keep sessions to myself)`（有 personal org）或 `Cancel`；无 team → `[Create a team, Skip…/Cancel]`。header **`Team`**。
- 唯一的 option hint：当前 team 的 label → `Current team`（356-359）。
- personal org 判定：CLI 的 `personal` 字段优先，否则名字等于 `<login>'s Organization`（`setup.ts:52-54`）。personal org 不提供 "Team sharing" 模式（203-209）。
- 输入解析：等于 label → 该 team；等于 `Create a team` → 问名字；无 team 时直接输入的文本 = 新 team 名；有 team 时按 id/label/唯一 name 匹配，失败则 `confirmNewTeam`（363-365）。
- 新 team 名字问题：**`Create a team: select “Type something” and enter its name.`** options `[Back to the list, Cancel]`（`setup.ts:217, 423`）；以 `/` 开头的答案不算名字（430-433）。
- 不确定的名字 → **`Create a new team called “<name>”?`** options `[Create it, Back to the list]`（446）。
- 创建成功 → transcript `Created the team "<name>".`（461）；随后邀请（见 Q2b）。
- 创建失败 → `/delta-setup couldn't create the team "<name>": <err>. Check /delta-org list before trying again; it may have been created.`（460）。

**Q1b 邀请**（`offerInvites`，`setup.ts:471-505`）：问题 **`Who should join <team>? Select “Type something” and enter their email addresses, separated by commas.`** options `[Invite later, Manage team in browser]`，hint：`Invite anytime with /delta-org invite`。`Invite later` → transcript 提示可用 `/delta-org invite <email>`；`Manage team in browser` → 打开 dashboard；输入 → `emailsIn` 过滤，结果用 `invitationSummary`（`Invited a@x, b@y to <team>. Couldn't invite c@z (<msg>).`）加 `Manage members: <url>`。此步任何失败都不阻断 setup。

**Q2 同步模式**（`setup.ts:370-379`）：问题以 `currentPolicy(...)` 开头（275-281）：

- `"Delta isn't set up for this repository yet."` 或 `"Currently: Manual (only sessions you share with /delta-share)."` 或 `"Currently: <Private sync|Team sharing> with <org>."`
- 接：`When Delta syncs a Claude Code session, it stores the conversation and a copy of this checkout's code, including uncommitted changes, in DeltaDB. This applies to new sessions, not this one. Which sessions should Delta sync?`
- header `Delta setup`；options（推荐在前，`modeLabels` 203-209）：
  - `Private sync (every new session, only you see it until you share)`
  - `Team sharing (every new session, visible to <team>)`（personal org 时没有此项）
  - `Manual (only sessions you share with /delta-share)`
- 也接受输入模式短名（`private`/`organization`/`manual` 对 `MODE_NAMES` 不区分大小写，377-378）；匹配不上 → cancelled。

**写盘**（`serializeProjectPolicy`，`project-policy.ts:78-88`）：保留未知 key，2 空格缩进 + 结尾换行；`threads.mode` + `threads.organization`（manual 也保存 org，供 `/delta-share` 用）。

**Q3 是否同步当前会话**（`setup.ts:395-412`）：仅当模式非 manual、且当前会话的 audience 还不是目标（`shared`，或 private 模式下 `private`）：

- private：**`Your new setting starts with your next session. Sync this session privately too?`**
- organization：**`Your new setting starts with your next session. Sync this session to <team> too?`**
- options `[Sync it, Not now]`，header `Delta setup`。
- `Sync it` → `shareSession('private'|'organization')`；成功文案 `<saved> Syncing this session now.`，失败 `<saved> This session couldn't start syncing now; use /delta-share once Claude is idle.`。
- 不共享时文案：`<saved> This session isn't syncing; run /delta-share to sync and share it.`
- `<saved>` = `Saved <模式> with <team> to .delta/settings.json. New sessions follow it from now on; run /delta-setup to change it.`（390）。

**排除 Git**：写 `<gitCommonDir>/info/exclude` 追加 `/.delta/settings.json`（`EXCLUDE_ENTRY`，`setup.ts:220-238`）；失败 → transcript `Delta couldn't keep .delta/settings.json out of Git; add it to .gitignore if you don't want to commit it.`（388-389）。

**结局枚举**：`SetupOutcome.status ∈ wrote|cancelled|unavailable|no-checkout|failed`（192-196）；`InteractionUnavailableError` → `UNAVAILABLE_NOTICE`（246-247）；dismiss → `CANCELLED`（244）。

### 2.7 持久化总表（DSH 重写必须复刻的数据）

**`.delta/settings.json`**（checkout 根，`project-policy.ts:36-38`）：

```json
{ "threads": { "mode": "manual|private|organization", "organization": "<orgId>" } }
```

- 未知顶层 key 原样保留（74-88）。
- 读规则（45-72）：文件不存在 / 无 `threads` / 无 `mode` → 未配置（`configured:false`）；坏 JSON / 非对象 / `threads` 非对象 / 模式非法 / automatic 模式缺 org → `malformed` 或 `problem`，effective 回落 `manual` 且 `configured:false`（于是下个新会话会再 offer）。
- `recordsAutomatically = private|organization`（91-93）。

**Claude 插件 store key**（`core/session-state.ts:252-254`，另有各模块自建）：

| key | 值 | 位置 |
| --- | --- | --- |
| `session:<sessionId>` | `Binding`（见下） | `key()` |
| `appended:<sessionId>` | `{thread, items: Record<itemId, fingerprint|'omitted'>}` ledger | `ledgerKey()` |
| `drawn:<sessionId>:<rowId>` | 该行是哪个 item 的"插件输出行"/echo | `drawnRowKey()` |
| `setup-offered:<gitCommonDir|root>` | `true`/`false` | `setup.ts:546` |
| `auto-refused:<gitCommonDir|root>` | 上次拒绝的 transcript 文案 | `activation.ts:762` |
| `child:<sessionId>:<agentId>` | `ChildBinding` | `children.ts:94-96` |
| `plugin-update:check` | `Check`（checkedAt/root/project/target/version） | `catalog.ts:104-122` |
| `plugin-update:notifications` | `false` 表示关闭 | `updates.ts:20` |
| `plugin-update:reminder:<branch>` | `{version, until}` | `updates.ts:149-158` |

**Binding 字段**（`core/session-state.ts:29-101`，DSH 需一一对应）：`session`、`thread?`、`locator?`、`joined?`、`joinTransition?`（JoinPlan）、`checkout?`、`checkoutReference?`、`pendingWorktree?`、`owner?`、`directory?`、`mounts?`（ThreadMount[]）、`url?`、`visibility?('private'|'organization'|'unlisted')`、`upload?`（`{state:'queued'|'uploading'|'uploaded'|'failed', organization_id, error}`）、`uploaded?: true`、`autoUpload?`（`{mode:'private'|'organization', organization}`）、`organization?`、`endedAt?`、`snapshot`（bool）、`captureFailure?`、`next`（sequence）、`pending`（Entry[]）、`execution?`（`{sequence, turnId?, lost?, endSequence?}`）、`lastTurnSequence?`、`title?`、`children?`（agentId[]）、`producer?`、`transcript?`、`continuedIn?`。`restoreBinding` 会校验 sequence 单调性（`core/binding.ts:9-21`）。

**文件系统路径**：`<config>/delta-plugin/`（`pluginData`）、`.../outbox/`、`.../outbox/<session>-<agentId>/`（child 用，`children.ts:99-101`）、`.../handoffs/<owner>.json`（`join.ts:286`）。DSH 需换成 profile 数据目录；**注意不能与 Claude 插件共用**（outbox 兼容性见 §10）。

**保留期**：只有 `endedAt` 存在、超过 30 天、pending/captureFailure/joinTransition 都空、且 children 无 pending 的会话才删（`activation.ts:770-801`）；有 `endedAt` 缺失的 binding 视为可能活着，永不删。

### 2.8 失败/降级速查

- 不在 Git checkout：自动同步静默跳过；`/delta-setup` 报 no-checkout；`/delta-share` 报 `current directory is not inside a Git checkout; open a checkout first`（`share.ts:68-73`）。
- CLI 太旧/太新：`ContractRefusalError` → band `Not syncing: <msg>`（`activation.ts:727-728`）；share/join 直接失败文案。
- Delta 未安装：交互式命令才允许安装（`resolveCli` 的 install 参数，`cli.ts:75-95`）；后台发现**永不安装**（`cli.ts:11` 注释）。Windows 首次安装先问（见 §9.1）。
- 登录/条款：见 §3.4。
- store 不可用：`host.store.keys()` 抛错 → 续接/join 目录检查/保留期全部跳过（`activation.ts:376-378, 782-784`；`share.ts:292-295`）；binding 读写失败按本地错误报告，不阻塞会话。
- 多 Claude 进程：store 无事务；每个会话"读-校验-删"串行（`activation.ts:777-780`）。DSH 里多会话共享同一 store 时同样要串行化（`serial()`，`session-state.ts:246-250`）。

---

## 3. share（`/delta-share`）

### 3.1 触发点

| 触发 | 代码 |
| --- | --- |
| `/delta-share [emails]` | `register.tsx:271-274` → `runDeltaCommand('share …')` |
| `/delta share [emails]` | 同上 |
| band 的 share 按钮 | `band.tsx:416-417` → `beginShare(host, session)`（`share.ts:387-396`） |
| setup 尾部 "Sync it" | `setup.ts:395-412` → `env.shareSession`（`interaction.ts:147`） |
| 轮次结束后补 share | `requests.shareAfterTurn`（`share.ts:389-392`） |

`ShareRequest`（`share.ts:38-40`）：`{session, cwd, cancelled?, form?, choose?:{emails}, audience?}`。`choose` 存在 → 自己问受众；否则用 `audience`（setup 传入）或默认 organization（band 按钮）。

`startShare`（334-342）立刻把 `requests.share=request`、band 进度 `Preparing to share…`（step `[1,5]`），`clock.after(0)` 后异步跑，命令本身返回 `{}`（不写 transcript 行）。

### 3.2 完整状态机（`share()`，`share.ts:97-286`）

按序（任何一步 throw → 失败路径 §3.3）：

1. 会话/目录未变（`assertShareSession`，75-80；变了 → `The Claude session or folder changed during share; the obsolete share was stopped`）。
2. 当前有 turn → `Wait for the current Claude turn to finish before sharing or reattaching`（102）。
3. `joined || joinTransition` → `This session joined an already shared thread. Retry <recoveryCommand> to reconnect; joining never attaches or republishes a checkout.`（104-105）。
4. `flushUnsaved`；重读 binding（106-107）。
5. `captureFailure` → `a stored Claude row could not be saved locally (…); sharing is paused to avoid an incomplete transcript`（108-109）。
6. `remoteRefusal(gitRemotes...)` → `ShareRefusalError`（110-112）。
7. `resolveCli(host, progress)`（会安装 CLI，band 显示安装进度）；`requireContract`（113-117）。
8. **问受众**（118-121）→ `chooseAudience`（367-384）：typed emails 直接 `invite`；否则问 `chooseShareAudience`（见 3.4）。`none` → 结束（可选 `notice` 写 transcript）。
9. 再查 turn（124）、`requireAuthentication`（125-129，band `Waiting for Delta sign-in…`）。
10. `checkoutRoot`（131-133）。
11. `joinedBindingAt(root)` → 拒绝：`<root> is a worktree of the Delta thread <url|thread>, mounted when a Claude session joined it. Sharing it would publish the same files as a separate thread; run /delta-join <locator> to record this conversation in that thread instead`（135-136, 325-327）。
12. **导出历史快照**（仅 `!binding.snapshot`，138-186）：
    - 设 `snapshotBarrier.gate`，等 in-flight append 静默（45-66, 140-143）；
    - band 进度 `Exporting earlier messages…` `[2,5]`；`snapshotMessages(await host.session.apiMessages())`；
    - 进度 `Exporting <N> earlier messages…` `[2,5]`；
    - 收集工具结果结构化输出，`stageRecord` 逐条写 outbox，最后一次性 `save({...snapshot:true})`（"commit 完整计划"）；
    - 已有子代理 → `adoptExistingChildren`（失败只 log，不影响 share）；
    - finally 清工具结果缓存、放行 barrier。
13. 清 pauses / deliveryNotice（188-190）。
14. 需要建 thread（`!thread`，或 private 且无 autoUpload）：决定 organization（binding.threadOrganization → `savedOrganization(root)` → private 时 `currentOrganizationId`）（194-202）；private 无 org → `Delta has no team to sync this session to; check /delta-org list`。`threadCreate`（204-206），并做防串线校验：返回不同 thread → 报错保留原 binding（207-208）；`!created.created` 时读 `threadStatus` 校验 frontier，且 producer 必须 `next_sequence===1` 才能接受"已存在但没有本地身份"（209-216，文案见 `thread-commands.ts:565-579`）。保存 thread/organization/(autoUpload)（218-221）。
15. `stopConversation()`（228）；非离线会话 `pauseCheckout(runtime,'watcher')`（232）。
16. band `Attaching the checkout…` `[3,5]`；`attachWorktree`；`worktree_directory_in_use` → 专用文案 `… is a checkout Delta manages for another thread… Run /delta-join with that thread's link to work there (…)`（234-241）；用 `worktreeHistory` 校验 reference 不变，保存 checkout（242-248）；`mountCheckout`（249）。
17. 受众为 organization，或 `unchanged` 且 binding 已知 organization：band `Publishing the thread…` `[4,5]`；`threadShare` → 保存 `url`；band 结果 `Shared`（256-260）。
    受众 invite：band `Sending invitations…` `[4,5]`；`threadInvite` → 保存 url；band 结果 `Invited 1 person`/`Invited N people`/`Synced privately; nobody was invited`；transcript notice `<邀请摘要> Link: <url>`（261-271）。
    受众 private/unchanged（非 org）：band 结果 `Synced privately`（251）。
18. `startConversation`（273）。
19. band `Syncing files…` `[5,5]`；`drain`；遍历 children 触发 `deliverChild`（275-277）。
20. 收尾校验：仍 paused → `checkout sharing is paused; saved messages remain queued until reattachment succeeds`；captureFailure/unsaved → `a live row could not be saved locally; fix the outbox error and retry /delta-share`；`verifyCheckout`（278-283）。
21. 清 `joinFailure`；把 `url` 补进返回值（284-285）。

### 3.3 结果与通知

- 成功：`finishProgress(band, outcome.band, 'done')`，成功行 4 秒后自动清（`BAND_NOTICE_MS=4000`，`band.tsx:65-66,120-132`）；`outcome.notice` 写 transcript；`outcome.url` 只写 debug（`Delta share link: …`）（`share.ts:344-361`）。
- 失败：`shareFailureText`（`share.ts:311-316`）：
  - `ShareRefusalError` → `Delta didn't share this session: <msg>.`（不劝重试）
  - 其他 → `Delta sharing failed: <reason>. Fix the issue and retry <recoveryCommand>; saved records retain their sequence.`
  - `AccessRequiredError` 原样展示（登录类文案已完整）。
  - 同时 `setProgress(text,'error')` + transcript。
- `recoveryCommand`：joined → `/delta-join <locator|thread>`；否则 `/delta-share`（`session-state.ts:256-259`）。
- 已同步会话再 share：`sessionSyncs = !!url || !!autoUpload`（`share.ts:86-88`）→ 会走 `unchanged` 分支，只重连不改变可见性。

### 3.4 受众问题（`share-audience.ts:48-63`）

header **`Delta share`**；问题原文：

`Who should see this session? Delta syncs its conversation and a copy of this checkout's code, including uncommitted changes, to DeltaDB. To invite people by email instead, select “Type something” and enter their addresses, separated by commas.`

options：

- 非 personal org（且 thread 未对 org 共享）→ `Share with <team>`（team 名；`delta-cli` 缓存缺失时 `'your team'`）
- 已同步 → `Keep current sharing`；未同步 → `Just me (sync privately)`
- 若只有 1 个选项（仅 `Just me` 的情况）→ 补 `Cancel`（`share-audience.ts:41-42,50-55`）

语义：`Share with team`→`{kind:'organization'}`；`Just me`→`{kind:'private'}`；`Keep`→`{kind:'unchanged'}`；输入含邮箱→`{kind:'invite',emails}`；Cancel→`{kind:'none',reason:''}`；输入无可解析邮箱→`{kind:'none',reason:'No email addresses found in "<answer>", so nothing was shared. Run /delta-share again to choose.'}`（56-62）。

### 3.5 登录/条款（`auth.ts:46-152`，share/join/setup/自动激活共用）

1. `delta --json auth status`。
2. `signed_in` → 返回。
3. `access_denied` + reason `terms_not_accepted` → 问 **"Delta needs you to accept its beta terms before it can sync. Open them in your browser?"** options `[Open the beta terms, Not now]`；选打开 → 打开 url（默认 `https://zed.dev/delta/terms`），band `Waiting for Delta's beta terms…`，每 2s 轮询 `auth status`，最长 15 分钟（`TERMS_POLL_MS=2000`，`TERMS_WAIT_MS=15*60000`，`auth.ts:31-33,105-112`）。
4. `signed_out`/`signing_in` → 问 **"Delta needs you to sign in before it can sync. Sign in with your browser?"** options `[Sign in, Not now]`；否则 `Delta isn't signed in. Run <retry> again to sign in.`
5. `auth login --no-wait`：`signed_in` 直接完成；`access_denied` 回到条款；`pending` 需要 `login_id/url/expires_at`（格式校验），transcript 提示 `Finish signing in to Delta in your browser; this link expires at <expires>: <url>`，band `Waiting for Delta sign-in…`，然后 `auth wait <login_id>`（超时 16 分钟）。
6. 等待中再跑 share/join/setup：`offerToStopWaiting` 问 **"Delta is waiting for you to finish signing in with your browser. Stop waiting?"**（条款时文案不同）options `[Stop waiting, Keep waiting]`（`interaction.ts:52-62`）。
7. 失败矩阵（`authFailure`，155-165）：`access_denied`/`signed_out`/`wrong_account`/`cancelled`/`expired`/未知状态，各有固定文案；`AccessRequiredError` 的 message 是完整句子（含 recovery: 运行 `authLoginCommand`）。
8. 进度清理：`waiting(undefined)` 时若 band 仍显示等待则 `clearProgress`（`interaction.ts:33-43`）。

---

## 4. join 与 handoff

### 4.1 入口与计划

`startJoin(host, {session, cwd, locator, form})`（`join.ts:46-50`）：立刻 `requests.join`、band `Checking access to the shared thread…`，异步跑。

`JoinPlan = {session, cwd, locator, thread, owner?}`；`JoinRequest` 还有 `fresh?`、`clearing?`、`cancelled?`、`contractVersion?`（`join.ts:33-38`）。

### 4.2 终端会话的完整流程（`joinSession`，52-183）

前置拒绝（都有固定文案）：

1. 会话/目录变化 → `The session or folder changed while join was queued; retry from the intended session`。
2. 当前 turn 或 prompt entering → `Wait for Claude to become idle before joining`。
3. 正在恢复 mounts → `Wait for Delta to finish restoring this session's worktrees before joining`。
4. 有后台 agent → `Stop background agents and teammates before joining; an idle main turn is not sufficient`。
5. `resolveCli`；`requireContract`（`request.contractVersion` 记忆，用于 `/clear` 后新会话复用）。
6. `requireAuthentication`（这里在会话切换前完成，失败不丢任何状态）。
7. `pending.joinTransition` 已存在：locator 必须一致，否则 `Retry the pending join with its original locator`；然后 `completeJoin(fresh=当前 session)`。
8. 已 joined 且 `threadStatus.thread_id === binding.thread` → **重连路径**：`Reconnecting to the shared thread…` → `restoreMounts`（mount + `/cd`）→ `verifyCheckout` → `flushUnsaved` → 清 pause/`endDeliveryFailures` → `startConversation` → `recoverExecution` → `drain` → 再校验。debug 记 `Reconnected to the joined Delta thread in Claude session …`，band `Joined the shared thread`。
9. **需要新会话**（终端）：`requireJoinCommands(['clear','cd'])`（宿主必须暴露 builtin `/clear` `/cd`，`lifecycle.ts:15-17`，否则 `This Claude host does not expose the built-in /clear and /cd command required to join; the saved session and mount plan were preserved`）。
10. `threadStatus` 预检（`readJoinStatus` 带 30s retry 预算，186-206；`Waiting for Delta to connect…`）：
    - 无权限 → `Joining requires authenticated access to an already shared thread; check your Delta sign-in and link`
    - 无 worktree → `This thread has no worktree to join`
11. 再查会话/目录/后台 agent。
12. band `Starting a fresh Claude session…`；`host.command.run({command:'clear'})`；新 session id 必须变化，否则 `Claude did not create a fresh session after /clear; the old binding was not replaced`；新会话不能已有 binding（157-159）。
13. **先持久化 joinTransition**（`{session:fresh, snapshot:false, next:1, pending:[], joinTransition:plan}`，163-166），再 `completeJoin`。
14. `completeJoin`（222-267）：
    - `rememberContract`；band `Mounting the thread's worktrees…`；
    - `threadMount(locator, --owner session, --join)`（`cli/delta-cli.ts:334-343`；长驻进程，等 ready 行；`MOUNT_TIMEOUT_MS=600000`）；
    - `requireMounted`（thread 一致 + 至少一个 worktree）；
    - 先保存 `directory`（即使 `/cd` 被拒，重试提示也能指对目录，235-239）；
    - `enterDirectory`（411-425）：已在目录则跳过；否则要求 `/cd` 命令，band `Waiting for you to trust the thread's folder…`，transcript 解释 **Claude 的信任提示要选 "Yes, move here"**；`command.run({command:'cd', args:directory})`；校验 session id、cwd、root 精确等于目录，否则 `Claude did not keep the session in the exact mounted directory; participation remains paused`。
    - 写完整 binding：`{session, thread, locator, joined:true, owner, directory, mounts, snapshot:true, next:1, pending:[]}`（241-246），`verifyCheckout` + `statusFields`（url/visibility/upload/uploaded）合并（247-249）。
    - `stateFor(session).mounted = true`；band `Connecting to the shared thread…`；`activate`（会话内不再依赖 session.start）；`startConversation`；band `Joined the shared thread`；debug 记 `claude --resume <旧 session>` 回到原会话（262-266）。
15. 失败：`Delta join failed: <err>. …`（172-179）——fresh 存在 → `Fresh session <id> was preserved. Retry /delta-join <locator> to finish the saved transition; the previous session is <id> at <cwd>.`；否则 `The previous session and folder were preserved. Retry /delta-join <locator>.`；`invalid_reference` 特判提示改用分享链接。`stateFor(fresh).joinFailure` 会让后续 prompt 被 drop。

### 4.3 Desktop handoff（`joins.ts` 中的 offer/claim）

原因：Desktop 没有 `/cd`，也不接受插件移动 worktree 会话，所以改为"在 thread 目录里新开一个 Desktop 会话"（`join.ts:119-124`）。

- 触发：join 在 `surfaces` 含 `desktop` 时（122）。
- `offerHandoff`（293-325）：
  1. `owner = 'desktop-<uuid>'`；
  2. band `Mounting the thread's worktrees…`；`threadMount(..., owner, join:true)`；
  3. 写 `${pluginData}/handoffs/<owner>.json`：`Handoff={owner, thread, locator, directory, created}`（`handoff.ts:15-23`）；
  4. 打开 `claude://code/new?folder=<dir>&q=<HANDOFF_PROMPT>`（`handoff.ts:39-41`），`HANDOFF_PROMPT='Join this Delta thread.'`（26）；
  5. 打开成功 → band `Press Enter in the new Claude Code Desktop session to join <“title”> there; this tab stays as it is. Desktop may ask you to trust the thread's folder. It waits 5 minutes.`；失败 → band 提示 + transcript 给链接（313-319）；
  6. `stateFor(session).offered = handoff`；每 2s `watchHandoff`（328-345）：claim 文件消失 → band `Opened the thread in a new session`；5 分钟（`HANDOFF_EXPIRY_MS`）超时 → 释放 mount + 文案 `No session joined the Delta thread within 5 minutes, so Delta released its checkouts. Run /delta-join <locator> to bring it back.`。
- claim：新会话启动在 handoff 目录 → `activate` 里 `pendingHandoff` → `claimHandoff`（374-387）→ `takeOverHandoff`（394-399）：**先删 claim 文件**（防旧 tab 超时释放），再 `completeJoin`（owner 沿用，不 clear 不 `/cd`）。
- 开场白处理（`prompt.ts:30-42`）：`prompt.submit` 的 text 等于 `HANDOFF_PROMPT` 时改写成 `HANDOFF_ACKNOWLEDGEMENT`（`This session just joined a Delta thread. Reply with exactly "Joined." and nothing else.`，`handoff.ts:29`），并标 `localTurn`（该轮不进 thread）。
- 失败：`Delta couldn't join the thread in this session: <err>. Run /delta-join <locator> to retry.` → `joinFailure` + band error。

### 4.4 prompt 门禁（`prompt.ts` + `lifecycle.promptGate`）

`promptGate` 优先级：`joining` > `sharing` > `transition` > `restoring` > `moving`（`lifecycle.ts:41-51`）。drop 文案（`prompt.ts`）：

| 状态 | drop 文案 |
| --- | --- |
| join 进行中 | `Delta is joining in a fresh session. Wait for the join result before submitting a prompt.`（44） |
| share 进行中 | `Delta is sharing this session. Wait for the share result before submitting a prompt.`（45） |
| joinFailure | `<joinFailure> The prompt was not submitted.`（48） |
| joinTransition | `The Delta join directory transition is incomplete. Run /delta-join <locator> to retry; the prompt was not submitted.`（65） |
| restoring | `Delta is restoring this thread's worktrees. Wait for the band to say they are restored, then try again. The prompt was not submitted.`（67） |
| moving | `Delta is moving Claude to the thread folder between turns. Try again in a moment. The prompt was not submitted.`（69） |
| delivery pause（非离线） | `<pause notice> The prompt was not submitted.`（94-96） |
| watcher 未就绪 | `The Delta watcher is not ready: <err>. <recoveryAdvice>.`（99-101） |
| 非本人 turn 的 steering | `This Claude turn no longer owns the shared conversation.`（102-106） |
| checkout 校验失败 | `Delta is not ready for this prompt: <err>. The prompt was not submitted.`（121-126，`JoinNotReadyError` 还会设 verification pause） |
| throttle 失败且离线 | 不 drop（离线会话继续记录） |

### 4.5 worktree 变化与目录迁移

- watch 的 `worktrees` 事件 → `refreshMounts`（`join.ts:491-501`）→ `applyWorktrees`（503-529）：列表不变直接返回；变了 → 重新 `threadMount`，保存 mounts，band `Thread worktrees changed: added X; removed Y · moving to the thread folder`，并给模型塞上下文行（`deliverNote`，见 §7.5）；需要迁移时 `runtime.moveTo` + 在 turn 之间 `moveSession`（`/cd` 到 thread 目录）→ band `Moved to the thread folder`（539-564）。
- 失败文案：`Delta couldn't move Claude to the thread folder <dir>: <err>. The session stays where it is; /cd there to work across every worktree.`

### 4.6 会话结束释放（`releaseOnEnd`，580-589）

- 只有 `reason ∈ {prompt_input_exit, logout, other}`（`releasesMounts`，`lifecycle.ts:5-7`）才释放 mount——`clear`（join 自己的迁移）和 `resume` 不释放。
- 若会话已 handoff 到别的 session（`handedOff`，`activation.ts:434-446`）则不释放。
- 释放本会话的 mounts + 子代理 mounts（`releaseThreadMounts`），以及未 claim 的 handoff。

---

## 5. org

见 §1.5。补充：`/delta-org` 的 band/transcript 表现就是 CLI 人类可读输出，没有进度条；`org switch -- <ID>` 用 `--` 防止 ID 被当参数（`cli/delta-cli.ts:186-188`）。`savedOrganization(host, root)` 供 share/band 读当前仓库存的组织（`organizations.ts:56-59`）。

---

## 6. band（状态带）完整内容模型

> 这是 DSH 必须用 Client UI 重画的部分。它**不是一个字符串**，而是一棵带按钮的布局树；Claude 侧由 `drawBand`（`band/band.tsx:374-461`）在 `ui.render{component:'AbovePrompt'}` 上返回 `Box/Text/Link/Button`，宽度不够时按固定顺序舍弃内容（`renderBand`）。

### 6.1 渲染点与整体布局

- 只有在 `statusShown()` 为真时绘制：`watchedSession() || currentProgress() || watchStatus().error || activeReminder()`（`band.tsx:154-156`）；否则透传 `next(e)`。
- `e.props.hasSurvey` 为真（有问卷/计划确认）时让位（379-380）；`maxRows===0` 直接不画（381-382）。
- 终端布局（`surface==='terminal'`）：整条 `Box width=columns paddingX=1 backgroundColor=<theme shade>`；`BAR_SHADES={dark:'#303030', light:'#e8e8e8'}`，主题从 `host.config.list()` 的 `theme` 读，`light*` → light（315-334, 454）。
- 桌面布局：普通 `Box column`，不加底色（453）。
- 行组成（429-446）：
  1. 主行：`[mark][label][link(内联)][audience][controls]` + 右对齐 `[right]`（`justifyContent:'space-between'`，`columnGap=2`）；
  2. 插件更新行（可选，见 6.7）；
  3. 链接独占行（终端且行宽放不下时）；
  4. detail 行（失败原因/重试原因，`statusRows>=2` 时）；
  5. band 上方还有可选的 `activity`（远端 agent 正在做什么）与 `childActivity`（子线程状态）行（447-450, 453-459）。
- 行数预算：`maxRows`；插件更新行占 1 行（`statusRows = maxRows - (update?1:0)`）；`band.detail && maxRows<3` 时丢弃更新行（393-395）。`activityLine`/`childLine` 也各要 1 行（`renderBand` 365-370）。

### 6.2 状态数据模型（`StatusState`，`band/status.ts:17-55`）与数据来源

| 字段 | 含义 | 来源 |
| --- | --- | --- |
| `connection: stopped|connecting|live|retrying` | 连接态（带 4s grace 伪装 live） | `watchStatus()`（`watch.ts:122-143`） |
| `recording?` | 会话已被 capture（有 snapshot） | `binding.snapshot`（`band.tsx:216`） |
| `reminder? {text,command}` | 未同步提示 | `state.reminder`（`activation.ts:516,531-537`） |
| `reconnecting?` | 掉线超过 grace | `watchStatus().reconnecting` |
| `turn: idle|starting|remote|own` | 当前 turn 归属 | `statusCurrentTurn(feed)`（`status.ts:114-129`） |
| `error?` | watcher 失败原因 | `watchStatus().error`（`watch.ts:224-228`） |
| `progress? {text,tone,step?,update?}` | 正在进行中的 share/join/update | `bandState.progress`/`update`/`uploadProgress` |
| `spinner?` | 动画帧 | `bandState.spinner` |
| `deliveryPause?` | delivery/verification pause 的文案 | `state.pauses`（`band.tsx:222`） |
| `retryReason?` | 发送重试原因 | `state.retryReason`（`band.tsx:223`） |
| `link?` | thread 链接 | `binding.url` → `conversationWebLink`（`band.tsx:308-312`） |
| `audience?` | 可见性标签 | `audienceLabel(binding)`（254-261） |
| `conflict? {fork,discard}` | 离线改动被拒 | `state.refusedOffline`（229） |
| `share? {label}` | 私有 thread 的分享按钮 | 见 6.6（232-236） |
| `people?` | 在线的人 | `presence.roster()`（`presence.ts:30-36`） |
| `children?` | 子线程清单 | watch 的 `children` 事件 |
| `childrenStale?` | children 数据来自非 live 连接 | `watch.actual !== 'live'`（239） |
| `agent? {seconds,quiet?,doing?}` | 远端 participant 的 turn | `feed.remoteTurn`（180-196, 240-244） |
| `copied?` | 刚复制链接 | `bandState.copiedTimer` |

### 6.3 主行文本规则（`renderBand`，`status.ts:337-443`）

**色调 → 标记（mark）**（341-347）：

| tone | 条件 | mark |
| --- | --- | --- |
| `error` | progress.tone==='error'，或 state.error，或 deliveryPause | `✕` `red` |
| `pending` | 进行中的 progress，或 retryReason，或 reconnecting，或 connecting | `◌` `yellow` |
| `live` | 其余且 connection !== stopped | `●` `green` |
| `quiet` | connection === stopped | `○` dim |

**label（永不让位，348-352）**：` Delta`（dim）
- 安装更新进行中 → ` · Updating`
- 有 snapshot → ` · Syncing`
- 有 reminder → ` · <reminder.text>` + `  <reminder.command>`（dim）
- reminder 只有 `Not syncing`/`/delta-share` 与 `Not set up`/`/delta-setup` 两种（`band.tsx:158-163`）。

**detail**（353-354）：失败 → `[{failure, red}]`；重试中 → `Retrying: <retryReason>`（yellow）。

**链接**（356-359, 405-407, 438）：
- `href` = `state.link`；**正在运行时不给 href（不可点），文本 `link appears when ready`（dim）**。
- 终端显示完整 URL；桌面显示 `shortLink`（`host/<首段>/…<末 6 字符>`，`status.ts:227-235`）。
- 终端用无 label 的 `<Link href>`（避免重复打印 URL），桌面用带 label 的 `<Link>`；无 href 时用 dim Text（399-407）。

**受众**（432）：`audience` dim 文本，紧邻链接：`Unlisted` / `Synced with <org>`（private 或 personal org）/ `Shared with <org>`（`band.tsx:254-261`）。

**右侧（right，408-424）**，按优先级：
1. 安装更新进行中 → `updateStep`（见 6.6）；
2. 有 progress（share/join）→ `⠋ <text>`（yellow）+ ` <step a/b>`（dim）；
3. progress.tone==='done' → `✔ <text>`（green）；
4. 否则：`agent` / `children` / `people` 用 ` · ` 连接，列表逐个按 give-way 舍弃。

**远端 agent（390-407）**：
- 在 band 主行：`⠋ <First>'s agent`（人名颜色 bold）+ ` 125s`（dim，格式 `formatSeconds`：<60 → `Xs`，否则 `Xm Ys`）。
- 独占一行时还可带正在做的事：`⠋ <first>'s agent › <tool name|thinking>  (3s · 2 more running)`；工具名 bold，文本 `middleTruncate`。
- `state==='starting'`：`⠋ <who> starting…`。
- quiet（超过 30s 无活动且无 open item）：`◌ <who> quiet 45s`（yellow）。
- 有 open 的 thought/tool_call 满 500ms 才显示"在做什么"（`SHOW_ACTIVITY_AFTER_MS`，`band.tsx:70, 180-196`）。

**子线程（`childStatus`，`status.ts:159-193）**：
- 排序优先级：`failed(0) running(1) waiting_for_synchronization(2) queued(3) preparing(4) unknown(5) completed(6) stopped(7)`（142-145）。
- 前缀：running→spinner 帧，failed→`✕`，其它→`·`，stale→`◌`；kind 映射 `subagent→agent`、`subthread→thread`、其它→`child`。
- 颜色：failed red、running cyan、queued/waiting/preparing yellow。
- 文本：`‹前缀› ‹kind› ‹名字(bold, middleTruncate)› ‹状态›[ · +N 同状态][ · 其它状态计数]`；宽度不够时退化为汇总 `2 running · 1 completed`，再不够用紧凑名 `run/queue/sync/fail`。
- stale（连接不 live）时 dim 且状态一律 `unknown`。

**人（roster，378-388）**：最多 3 个（`MAX_NAMES`），名字取 first name（重名加 last initial，`firstNames` 217-224）；颜色由 personKey hash 到 `PERSON_COLORS`（196）；`arriving` → inverse，`leaving`/reconnecting → dim；多出的 `+N` dim。

### 6.4 进行中的操作（progress）与安装更新

`currentProgress()`（`band.tsx:295-300`）优先级：`bandState.progress` > `bandState.update`（`{text:'Updating Delta', tone:'active', update}`）> `uploadProgress(binding)`。

`uploadProgress`（279-289，自动上传会话）：

| 条件 | 文本 | tone |
| --- | --- | --- |
| `upload.state==='failed'` | `Sync failed: <error.message|reason|unknown reason>` | error |
| 已 `uploaded` | 不显示 | — |
| `state==='queued'` 且带 error | `Retrying sync: <msg>` | active |
| `state==='queued'` | `Waiting to sync…` | active |
| 其它（uploading） | `Syncing to DeltaDB…` | active |

安装更新 step（`src/status.ts:249-265`）：

- `{action}`：`action==='approve_installer'` → spinner + `Waiting for installer approval`（yellow bold）；否则 `Waiting for you`。
- `{phase,version?,percent?}`：`Checking for updates` / `Downloading` / `Preparing` / `Installing` + ` <version>` + `…`；downloading 且有 percent 时追加 8 格进度条 `▰▱` + ` 42%`（`UPDATE_BAR_CELLS=8`）；标签行显示 ` · Updating`（349-350）。
- 空间不足时先丢进度条（`give.bar`），再丢版本号（`give.version`）。

### 6.5 链接复制

- 有 `href` 且未复制 → Button `copy link`（give-way 后为 `copy`），`plain dimColor autoFocus`；按下 → `host.ui.copy({text, surface})`，成功 → `✔ copied`（green）2 秒后恢复（`COPIED_MS=2000`，`band.tsx:336-351, 408-413`）；失败只写 debug `Delta: couldn't copy the link: <reason>`。
- focus 落在复制控件上（注释 410-411：从 prompt 按 Enter 也生效）。

### 6.6 按钮与动作 id 全表（DSH Client 必须重建）

`drawBand` 里按钮顺序：`copier, sharer, fork, discard`，彼此用两个空格分隔（426-427）。

| 按钮 | 出现条件 | label（含动态） | 按下调用 | 证据 |
| --- | --- | --- | --- | --- |
| copy | `link.href` 存在且未复制 | `copy link` / `copy`（窄）/ `✔ copied`（复制后 2s） | `host.ui.copy` → `copyLink` | `band.tsx:408-413`, 336-351 |
| share | `binding.visibility==='private'` 且 org 不是 personal | 无 turn：`Share with <org>`；有 turn：`Share after this turn`；已请求：`Sharing after this turn` | `beginShare(host, watchedSession())`（无 audience → 默认 organization） | `band.tsx:232-236, 416-417`；`share.ts:387-396` |
| fork | `refusedOffline` | `Fork & Restore` | `beginRefusalResolution(host, session, 'fork')` → `threadFork` + `threadDiscard` | `band.tsx:229, 419-421`；`delivery.ts:673-705` |
| discard | `refusedOffline` | `Discard` | `beginRefusalResolution(..., 'discard')` → `threadDiscard` | 同上 |
| plugin update 主按钮 | 更新通知可见 | 未安装：`Update`；已安装可 reload：`Reload`；已安装不可 reload（Desktop）：`Details` | `pluginUpdateCommand(host, '')` | `plugin-update.tsx:68-71`；`status.ts:274-289` |
| plugin update `Later` | 通知可见且宽度允许 | `Later` | `snoozePluginUpdate(host, session, branch, version)`（24h，按版本） | `plugin-update.tsx:72-77`；`updates.ts:170-179` |
| plugin update `Mute` | 通知可见且宽度允许 | `Mute` | `pluginUpdateCommand(host,'notifications off')` | `plugin-update.tsx:78-81` |

插件更新行（`drawPluginUpdateNotice`，`plugin-update.tsx:48-84`）：

- 仅在：有通知、`!e.props.isWorking`、无 app/plugin 安装进行中、无 join/share、没有插件自己的问题打开、session 匹配（51-53）。
- 布局：`[✓|↑][prefix][version]`（`summaryColumns` 预留） + 按钮组；颜色 ready→green，否则 cyan；`↑`/`✓`。
- 宽度缩减策略 `pluginUpdateRow`（`status.ts:274-289`）：依次尝试 `Plugin ` 前缀、Later、Mute 三种取舍；版本过长用 `middleTruncate`；按钮"原生渲染为 `[ label ]`"占 4 格。
- 没有键盘焦点、不启动模型 turn（文件头注释）。

### 6.7 优先级与"让位"顺序（DSH 布局要照抄）

`GIVE_WAY`（`status.ts:313-322`），按顺序累加，`renderBand` 选第一个宽度放得下的：

1. 全量；
2. copy 标签缩短为 `copy`；
3. 链接移到下一行（仅终端且行数够）；
4. 其他人显示首字母；
5. 其他人全去掉（`alone`）；
6. share 按钮去掉；
7. audience 去掉；
8. 链接文本去掉（仅终端或有 children 时；复制按钮仍在）。

宽度模型 `bandWidth`（300-309）：`(终端 padding 2) + mark/label + 链接(2+len) + audience + copy + share + conflict + (右对齐有内容时 MIN_GAP=2 + 右宽)`。终端里链接独占行时按实际换行数算行数（372-374）。

**优先级结论（写 DSH 组件时按此实现）**：错误 detail > 进行中操作 > 安装更新 step > 自动上传状态 > 远端 agent 活动 > 子线程 > 人 > 链接/受众/分享按钮；reminder 只在完全没有其它状态时出现；问卷（survey）出现时 band 整个让位。

### 6.8 动画与计时器

- 帧：`SPINNER_FRAMES=['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏']`，间隔 120ms（`status.ts:88`；`band.tsx:64`）。
- 只在"有进行中操作"或"live 且远端 turn/starting/子线程 running"时动画（`statusSpinnerRunning`，`status.ts:135-139`；`band.tsx:87-109`）。
- 成功行 4s 自动清；错误行保留到被替换（121-132）。
- 复制确认 2s；到达高亮 4s（`presence.ts:14`）。
- 主题变化清 `barTheme` 缓存（`band.tsx:319-322`；`register.tsx:226-231`）。

### 6.9 DSH 重画建议

- 数据：把上表 `StatusState` 原样作为 Host→Client 的投影（**不要在 Client 里算 business status**），Host 端维持 `watch/presence/progress/reminder/plugin-update` 状态，Client 只按 `StatusState` 画。
- 结构：一条主行 + 可选第二行（更新/详情）+ 可选上方活动行；按钮用 DSH 的按钮/动作，动作 id 语义沿用（`copy`、`share`、`fork`、`discard`、`plugin-update`、`plugin-update-later`、`plugin-update-off`）。
- DSH 的 `claudeCodeMods` 桥已经能把 `Box/Text/Button` 序列化成 `SurfaceSnapshot{generation, tree, actionId}` 并用 `pressBand(agent, generation, actionId)` 回调（见 §10.3）。若走桥，band 的绘制代码可以几乎原样移植（`Link`/`Markdown` 不可用，链接降级为文本+复制按钮）。若走原生 Client 插件，则按上表自己画，可保留更强的样式（链接可点、tooltip）。
- 颜色注意：DSH Client 有主题 token（`Theme.listTokens` 可查）；`BAR_SHADES` 是 Claude 终端的硬编码底色，DSH 应换成主题 surface token。

---

## 7. watch / presence

### 7.1 连接状态机（`watch.ts`）

`Connection`（52-72）：`stopped` → `connecting`（有 cancel/gate/outage）→ `live`（有 ready/stopProcess）→ `dropped`（有 failure）→ `retrying`（有 interruption/outage）→ 回到 `connecting`；不可恢复 → `failed`（保留 session 以便 band 说明）。

- `startConversation`（244-290）：会话已有非 stopped/failed 的 watch 时复用（retrying 直接抛 interruption，dropped 有 ready 则返回 ready，否则抛 failure）；否则 `enter(connecting)`，读 ledger 建 `RemoteView`，异步 `consumeConversation`，等 readiness。
- `stopConversation`（292-314）：bump revision、abort、`stopBandTimers`、reject gate、`stopRows`（等未完成 save）、重置 feed/presence。
- `consumeConversation`（316-503）：
  - `threadWatch(reference, {externalId: producer, participate:true})`（`delta-cli.ts:406-416`）；
  - 事件循环：`producer.turn` → 更新 `feed.producerTurn` + `observeThreadTurn` + `observeTurn`；`ready` → 校验 frontier（`validateThreadFrontier`）、重置 view/presence/children；`live` → 快照完成、`settleRemote`、participate（goLive + resume watcher pause + resolve readiness + drain）；`worktrees` → `refreshMounts`；其余 → `observeRemote`（item/item.append/remove/comment/turn/presence/children/child/child.remove）。
  - 就绪条件 = `ready` + snapshot 完成 + **inspection 通过**（`threadStatus` + `validateThreadCheckout` 或 `validateJoinedMounts`，354-389）。
  - 失败：4s grace（`RECONNECT_GRACE_MS`）内 band 仍显示 live；之后 `reconnecting`；非离线会话 pause watcher + `loseExecution('The Delta watcher disconnected')`；`retryable===false` → pause delivery + `failWatch` + transcript `Delta sharing paused: <msg>. <advice>, then <recovery>.`；否则指数退避重连（`reconnectDelay`，单次 live ≥30s 归零），第一次失败写 transcript `Connection interrupted: <err> Retrying in Ns.`，band `◈ …`。
- `watchStatus()`（122-143）暴露 `connection`（带 grace 伪装）、`actual`（真实态，用于 spinner/childrenStale）、`reconnecting`、`error`。
- `followUpload`（674-693）：自动会话的 thread 链接不由 share 产生，所以按退避反复 `threadStatus`，直到 `uploaded`（`uploadSettled`），每次 `rememberStatus` 把 url/visibility/upload 写回 binding；首次 uploaded 且无其它进度时报 `Synced to DeltaDB`（640-658）。
- `stopWatching(session)`（696-698）：会话结束时停。

### 7.2 presence（`presence.ts`）

- 第一次 `presence` 事件只建基线，不算到达（51-52）。
- 到达去抖 3s（`ARRIVAL_SETTLE_MS`）后才进 roster 并高亮 4s；离开宽限 5s（`DEPARTURE_GRACE_MS`）内仍显示 `leaving`（dim）（9-14, 49-94）。
- roster 顺序 = 到达顺序；id 用 `personKey`（user_id 或 `name:<name>`），颜色由 hash 决定（band §6.3）。

### 7.3 远端 item 的分发（`observeRemote`，506-558）

- `item`/`item.append`：更新 `feed.view`；`announceThought`（完成时的一次性 thinking 公告，`row-delivery.ts:9-11`）→ `showToPerson`；维护 `openSince`（工具/思考开始时间，供 band 计时）；刷新远端 turn 的 `heard`。
- `comment`/`comment.remove`：进 view，`settleRemote`。
- `turn`：`feed.threadTurn` + 归属判定（`ownsThreadTurn`，572-577；`threadTurnOwned`，`status.ts:100-111`）→ `remoteTurn`（远端）或 own。
- `presence`：见 §7.2；`clearDoneNotice()`（真实活动压过"操作完成"提示）。
- `children`/`child`/`child.remove`：更新清单；`recordsChildren(session)` 时 `observeThreads`（§8.3）。

### 7.4 远程行如何进 Claude 对话（Claude 特化，DSH 必改）

两套通道：

1. **给模型看**：`settleRemote`（`rows.tsx:161-188`）把线程里已完成 item 用 `host.session.append({message:{type:'user',content:[{type:'text',text}]}})` 追加为 user 行（不启动 turn）；`deliverNote`（47-61）用于 worktree 变更等 `[Delta] …` 上下文，同一轮内先挂起、turn 结束再 flush。`RemoteView.addRows` 用 ledger（store `appended:<id>`，`{thread, items:{id: fingerprint|'omitted'}}`）保证不重复添加、能改能删；快照只给最新 5 条可见、总预算 400k 字符（`conversation.ts:14-22`）。
2. **给人看**：消息/评论/事件/工具调用用插件自己的隐藏命令 `delta show <itemId>` 的输出行来"画"到 transcript，再通过 `ui.render` 的 `CommandOutput` 替换成富文本（`rows.tsx:264-330`），`UserMessage` 里藏掉 `(no content)` 的 echo（250-258）。绘制队列 `DrawQueue` 等 `session.append` 确认该行已存（2s 重试，`row-delivery.ts:31-74`），失败降级为 `showToPerson` 纯文本。

**DSH 不需要第 2 套**：DSH 的会话行由 Host 日志 + Client 渲染，插件可以用自己的 Client 行组件（或工具/消息渲染扩展）直接画；第 1 套（给模型的上下文行）在 DSH 可用 `session/event` 追加或系统提示/工具结果注入，但**必须防止重复注入**（ledger 逻辑要移植）。

### 7.5 ledger 与渲染缓存

- `drawn:<session>:<rowId>` 记录"这条存储行画的是哪个 item / 是 echo"（`rows.tsx:216-234`）。
- `conversation.ts` 的 `RemoteView`（512）维护 items/comments + fingerprint；`addRows`（762）按键排序、批量保存 `LEDGER_SAVE_INTERVAL=20`。
- 上限：`SNAPSHOT_TAIL=5`、`SNAPSHOT_BUDGET=400_000`、`ROW_LIMIT=24_000`、`SECTION_LIMIT=8_000`、`DISPLAY_LIMIT=2_000`、`TOOL_LINE_LIMIT=200`、`MARKDOWN_LIMIT=10_000`（`conversation.ts:8-22`）。

---

## 8. subagents

两类完全不同的东西：**(A) Claude 原生子代理 → Delta 子线程**；**(B) Delta 线程 → Claude 子代理**（SendMessage）。

### 8.1 A：记录原生子代理

- 关键约束：组织 guard 不让用户插件收 `agent.spawn`，所以插件**不注册 spawn hook**，而是在 agent loop 的**第一个 hook**上发现（`subagents.ts:93-98` 注释；`childFor` 99-113）。
- 发现（`discoverChild`，148-174）：`recordsChildren(session)`（有 snapshot 且契约版本 ≥7，135-139）→ 已有 `child:<session>:<agentId>` 则复用 → `agent.list()` 找 agent，`recordsSubagent`（非 fork/teammate，`children.ts:85-87`）→ adoption spawn 特判 → 父必须是已记录会话或已记录子代理 → 若该 agent 已有 assistant 消息（本次记录前就跑过）则不记录 → 否则 `addChild` 并存 binding `{session, agentId, parent, name, next:1, pending:[]}`（name 取 spawn 的 name 或 description，`children.ts:103-106`）。
- foreground/background：跟踪父 loop 的 Agent 调用（`followAgentCall`，192-214），`async_launched` 的返回值把子代理改判成 background；foreground child 在父 turn 内运行，被接管时会 abort 父 turn。
- 每 child 独立 outbox 目录 `<session>-<agentId>`（`children.ts:99-101`）、独立 binding、独立 sequence；prompt 用 `_meta.delta.sender` 归属到发起 agent（`sentBy`，112-117）。
- turn 记录：`beginChildTurn`（217-240）写 running state_update + 把 held rows 放进该 turn；`endChildTurn`（286-314）写 idle + stopReason（`end_turn|cancelled|refusal|error`）。
- 交付（`deliverChild` 404-484）：父 thread 不存在则等；`threadCreate({externalId: agentId, parent:{reference, name, worktrees:'shared'|'isolated'}})`（487-493）；自己的 checkout 才 attach/mount；append pending → 收 ack → 清 outbox；被 server fenced（`superseded`）→ `takeOverChild`。
- 被 Delta 接管（`stopChild`，671-687）：后台 child `host.tool.stopTask`；前台 child abort 父 turn；transcript `Someone took over the subagent "<name>" in Delta, so Claude stopped it. Tool effects it already made are not rolled back.`；并给父上下文 `[Delta] …`。
- 失败：永久错误 → `Delta stopped recording the subagent "<name>": <err>. Its records stay queued.`（646-653）；transient → 退避重试，**永不暂停主会话**。

### 8.2 孤立子代理的 worktree fork（Claude 特化）

- Claude 给 isolated 子代理建 `<root>/.claude/worktrees/agent-<id>`；插件在第一个 turn 把该目录 `mv` 成 `.claude-worktree` 后缀，再 `ln -s` 指向 Delta fork 的目录（`forkIntoClaudeWorktree` 785-816；`linkWorktree` 822-832；`isClaudeWorktree` 771-773 只支持 POSIX）。
- fork 的线程用 `--isolated-worktrees`（`forkWorktrees` 732-751），mount 后记录 `mountOwner`；结束后 `restoreClaudeWorktree` 还原并 `git worktree remove`/`branch -d`（861-870）；崩溃遗留由 `restoreAbandonedWorktrees` 修复（877-899）。
- 组织提供的 agent（managed plugin/managed `.claude/agents/`）**不动 Claude 的 worktree**（`org-agents.ts:56-65`）；Windows 也不做（junction 不支持）。
- 合并提示：`[Delta] The subagent "<name>" worked in its own copy of this checkout in Delta, not in a git branch of this repository. To bring its changes into the checkout it was forked from, run: delta thread merge <ref> --into <parent>`（`subagents.ts:586-596`）。

### 8.3 B：Delta 线程当 Claude 子代理（`session.send` → `sendToThread`）

- `sendToThread`（`thread-runs.ts:161-182`）：`to` 命中已记录 child → resume；命中 watch children 的线程名 → 已有 child 则 resume，否则新建；像链接（`https://…`、`thread_…`、`ksQQ…`，`delta-threads.ts:32-35`）→ 新建；否则按名字找已记录 child。
- resume（188-219）：正在运行 → 直接把消息交给 Claude 的 `next(to,text)` 并在插件侧额外记录一条 user 行；已停止 → 先读该线程快照（15s 超时，`readThread` 51-93），若别人正在跑 → **问** `Claude wants to take over "<name>", which <who> is running in Delta. Take it over?` options `[Take it over, Leave it running]`（112-128）；把"自上次以来 Delta 里的变化"拼进 prompt（`resumePrompt`，`delta-threads.ts:74-81`，预算 100k 字符）；`unlinkForResume` 还 Claude worktree。
- 新建（`runThread`，226-281）：读快照 → 拒绝已被本会话运行的线程 → 接管询问 → 无 worktree 拒绝（`The Delta thread "<name>" has no worktree for Claude to work in.`）→ 共享 worktree 则在当前 checkout，否则自己 mount（`mountOwner=<session>-<threadId 尾 12>`）→ prompt 由历史 + 消息组成（`adoptionPrompt`，69-71）→ `host.agent.spawn({prompt, description:name, subagentType:'general-purpose', cwd})` → 用 spawn 返回的 agentId（无则等 5s 内第一个 hook 的 `adoptThread`）。
- 父通知：插件启动的 spawn，Claude 不报结果，所以插件把最后一条 assistant 消息用 `host.prompt.submit` 送回父 loop（`reportReply` 306-313；`reportClaudeRun` 316-332）；失败则 `deliverNote`。
- Delta 里的 turn 结束（`observeThreads`/`reportDeltaTurn`，349-395）：线程列表变化时给父一条可 message 的清单（`threadsNote`，`delta-threads.ts:110-117`）；被 Delta 接管的 turn 结束时，按 `awaited` 决定 `prompt.submit` 还是 `deliverNote`。

### 8.4 恢复/收养

- 重启：`restoreChildren`（`thread-runs.ts:411-423`）关闭上次遗留 running turn（`cancelled`）并继续交付。
- share 时：`adoptExistingChildren`（429-451）把记录前跑过的 agent 逐个收养（父先子后），已完成者整段 transcript 当历史记录（`snapshotChild`），仍在跑者标 `awaitingSnapshot` 并立刻开一个 running turn，等结束再快照。

### 8.5 DSH 映射

- DSH 有 `subagents` 服务（`startActivation`/`sendMessage`/`listChildren`/`listDescendants`/`interrupt`/`waitForChildren`）与 `subagent/start`、`subagent/end` 事件，`agentTeams` 服务另管 teammate。Delta 的"每个子代理=Delta 子线程"语义在 DSH 可映射为：监听 `subagent/start|end` 建/收子线程；用 `subagents.sendMessage` 复刻 B 类；`interrupt` 复刻接管。
- 不能照搬：`host.agent.spawn`（插件起子代理）、`tool.stopTask`、`turn.abort`、worktree symlink 把戏、`session.messages({agentId})` 读取子代理 transcript。这些都需要 DSH 侧确认能力（见 §10.4）。

---

## 9. 更新（app/CLI 与插件自更新）

### 9.1 Delta app/CLI 更新（`/delta-update`、`/delta update`）

**启动检查**（`InstallationUpdates.check`，`install-update.ts:74-93`）：每插件进程一次，10s 预算，`delta update --check --json`；结果 `update_available` → transcript `Delta <latest> is available (installed: <current>). Run /delta-update or /delta update to update the installation.`（`canInstall` 为假时改用 CLI 的 message）；`unsupported` → `Delta update check: <message>`；其它失败 → debug（若是"CLI 不支持 update 子命令"则写 transcript）。**检查永不安装**。

**显式更新**（`update`，95-128）：

1. `claimInstallation('app')` 失败 → `A Delta plugin update or activation is in progress. Wait for its result before running /delta-update.` / `A Delta installation update is already in progress.`
2. transcript `Updating Delta installation…`；band step `{phase:'checking'}`。
3. 运行（`run`，130-173）：
   - 非 Windows：`delta update --json`（流式 stderr 进度）；Windows：`delta update --download-only --json`（CLI 不能替换自己）。
   - stdout 结果 `schema_version=1` 校验（46-67）：`status ∈ up_to_date|update_available|updated|install_ready|unsupported`，`can_install`，`current_version`，`latest_version`，`channel ∈ dev|trunk|stable`，`message`，`restart_required?`，`install_ready` 时 `install_argv`。
   - stderr 进度事件（255-270）：`{schema_version:1, type:'progress', phase:'checking'|'downloading'|'preparing'|'installing', version?, percent?}` → band；`{type:'action_required', action, message}` → transcript 全文 + band `{action}`。
   - 超时：检查 10s（run 内 5s 进程超时），更新 600s；失败文案含 `Run delta update in a terminal to see why, then retry /delta-update.`。
   - Windows `install_ready` → 再跑 `install_argv`（600s，`leaveRunning:true`：超时也不杀，防释放锁）。
4. 结果文案：`Updated Delta to <v>.`（`restartRequired` 时加 Windows 重启提示）；`Delta <v> is already up to date.`；`Delta cannot update this installation: <message>`；`Delta was not updated: <message>`；`app_working` → `Delta was not updated because it is running agent work, such as a turn or a terminal. Nothing was stopped. Retry /delta-update once that work finishes.`。
5. 结束：band `progress(undefined)`，释放安装锁。

**插件安装 CLI 的路径**（`cli/cli.ts`）：macOS/Linux `/bin/sh` 脚本发现（`command -v delta`、`Delta.app/Contents/MacOS/delta`、`~/.local/delta.app/bin/delta`），安装脚本从 `https://delta.dev/install.sh` 下载并用 `--locate-cli`/`--non-interactive`；带 `~/.cache/delta-claude-install.lock` 防并发（`cli.ts:12-68`）。Windows：`where.exe delta.exe` → 注册表 `HKCU|HKLM\Software\Zed Industries\Delta\InstallFolder`（64 位视图）→ 都没有时**问**安装（见下），然后执行 `windows-install.ts` 的 PowerShell（下载 `https://delta.dev/api/releases/stable/latest/asset?asset=delta&os=windows&arch=…`，`/passive /norestart`，退出码 0/1602/1223/3010/1641 各有文案）。

Windows 首次安装询问（`delta-cli.ts:80-86`）：问题 `Delta is not installed. Download and run the official Windows installer? It installs the Delta app and CLI and may ask for Windows administrator permission.` options `[Install Delta, Not now]`，header `Delta setup`；`Not now` 文案 `Delta was not installed. Retry /delta-setup, /delta-share, or /delta-join <link> to approve installation, or install Delta manually from https://delta.dev.`

### 9.2 插件自更新（`plugin-update/`）

**检查节奏**：`session.start` 后立刻一次，之后每小时（`observer.first=after(0)`，`observer.timer=every(CHECK_INTERVAL_MS=3600000)`，`updates.ts:33-39`）；desktop attach 会 recheck（`register.tsx:145-150`）。每会话一个 observer；检查结果按 `root+project` 跨会话共享（`answersFor`，`catalog.ts:128-131`），先写 `checkedAt` 再检查（失败也等一小时）。

**检查门禁**（130-141）：非交互面、`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`、通知被关（store `plugin-update:notifications===false`）、有安装进行中 → 清通知并跳过。

**目标识别**（`targetFor`，85-93）：读本地 `plugin.json` 得 runningVersion；`claude plugin list --json` → `installationFrom`（只认 `delta@zed-industries`、enabled、scope 顺序 `local|project|user|managed`、项目型 scope 必须同 project、路径必须是当前运行副本的缓存目录，`catalog.ts:62-76`）；`claude plugin marketplace list --json` → `branchFrom`（必须是 `zed-industries/delta-claude` 的 github/git 源；`ref` 缺省或 `main`=main，`develop`=develop；其它 return undefined = 不更新，`catalog.ts:79-93`）。

**版本获取**：先看本地安装是否已领先（native auto-update 已下载）；否则 `fetch https://raw.githubusercontent.com/zed-industries/delta-claude/<branch>/.claude-plugin/plugin.json`（10s 超时、≤16KB），解析 `name==='delta'` 的 semver（`catalog.ts:41-47,96-98`；`updates.ts:95-106,114-128`）。

**通知**（`checkInBackground`，130-167）：版本更新时：
- 提醒 key `plugin-update:reminder:<branch>`，`{version, until: now+24h}`；同版本 snoozed → 只刷新已显示的通知，不再写 transcript；否则写 store + 显示通知 + transcript：
  - 已安装待激活（`ready`）：`Delta's Claude Code plugin <v> is installed and ready. Run /delta-plugin-update to request a reload.`（Desktop：`Desktop may apply it when idle; otherwise start a new Claude Code session.`）
  - 可下载：`Delta's Claude Code plugin <v> is available (running: <cur>). Run /delta-plugin-update to update, or /delta-plugin-update notifications off to stop these notices.`

**显式更新**（`pluginUpdateCommand`，229-284）：

- `notifications on|off` → store `plugin-update:notifications`、清通知、开启时 recheck；文案 `Delta plugin update notifications are <on|off>. You can always run /delta-plugin-update to update manually.`
- `check` → 强制检查；无 target → `UNSUPPORTED`（`This copy of Delta is not installed from the Zed Industries marketplace on main or develop. Local copies and pinned or other marketplace sources are left unchanged.`）；否则 `Delta plugin <v> is installed and ready to apply|available (running: <cur>). Run /delta-plugin-update for the next step.` 或 `Delta's Claude Code plugin <cur> is up to date on <branch>.`
- 无参数：join/share/turn 进行中 → `Wait for the current Claude turn, Delta share, or join to finish, then run /delta-plugin-update.`；安装锁（与 app 更新互斥）→ `A Delta plugin update or activation is already in progress.` / app 在装 → `APP_UPDATE_BUSY`。
- 已是最新安装版本 → 直接激活：终端 `activateInstalled`（`host.command.run({command:'reload-plugins',args:'--force'})`，15s watchdog 后若仍存活则提示 `The updated Delta plugin is not active in this session yet. Start a new Claude Code session to apply it.`；Desktop 返回 `Desktop may apply it automatically when idle…`）；文案 `Delta plugin <v> is already installed. <activate>`。
- 否则 transcript `Updating Delta's Claude Code plugin…`；`claude plugin marketplace update zed-industries --json` → `claude plugin update delta@zed-industries --scope <scope> --json`（120s）；再 list 校验安装 scope 与版本；失败 `The updated installation could not be verified. Check /plugin before retrying.`；成功后删除 `plugin-update:check`；版本没变则只回 CLI message；会话/目录变了 → `Installed Delta plugin <v>. The session or folder changed; run /delta-plugin-update there to reload, or start a new session.`
- usage 文案（22）：`Usage: /delta-plugin-update [check | notifications on | notifications off]. Updates this Claude Code plugin; terminals request a reload, while Desktop may need a new session. /delta-update updates the Delta app and CLI instead.`
- 安装锁：`claimInstallation(kind)` 进程级互斥（`core/installation.ts:7-12`），app 与 plugin 更新互斥。

### 9.3 启动版本兼容警告

`MINIMUM_CLAUDE_VERSION='2.1.303'`（`core/compatibility.ts:2`）；`session.start` 时读 `session.version()`，低于则 transcript 警告但不阻止（`compatibility.ts:5-22`；`register.tsx:235-237`）。

### 9.4 DSH 映射

- app/CLI 更新：可原样保留（只依赖子进程 + 输出流）。DSH 上把 `delta update` 的进度映射到 band/进度 UI；Windows 分支按平台保留。
- 插件自更新：**不可移植**。DSH 的安装单位是 profile bundle（`plugin_manager`/marketplace），没有 `claude plugin list/update --json`，也没有 `/reload-plugins`。建议 DSH 版不做自更新，或改成"检查 DSH 市场里的 delta-dsh 新版本并提示用户用 Profile 管理更新"，且必须重命名 store key。
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` 未在 DSH 服务目录中确认；实现前需查 DSH 是否有等价的遥测/网络开关，没有则删除该门禁并记录在移植说明里。

---

## 10. 必须为 DSH 重写的点与等价建议

### 10.1 Claude Code 强耦合清单（逐项给 DSH 方向）

| # | Claude 语义 | 用途/证据 | DSH 现状 | 结论 |
| --- | --- | --- | --- | --- |
| 1 | `session.attach`、`session.start`、`session.end`、`session.append`、`session.send` | 生命周期、记录、画行、线程即子代理 | 有 `session/created`、`session/disposed`、`session/event`、`session/flush`、`agent/created`、`agent/disposed`、`agent/inbox/*`；**无 append/send** | 重写：录制管线改为监听 `session/event` 日志事件 + 自己的追加通道 |
| 2 | `/clear` + `/cd` 实现 join | join 必须新会话+切目录（`join.ts:119-149, 411-425`） | 有 `workingDirectory.set(agent,path)`，无 `/cd` 命令/信任提示 | 重写：DSH 可直接改工作目录；不再需要 handoff |
| 3 | Desktop handoff（`claude://code/new`、handoffs 目录、5 分钟占用） | desktop surface 的 join | DSH 是 Web GUI，同一 Host 可多会话 | **可删**；join 直接在目标目录建/切会话 |
| 4 | `ui.render` 三个渲染点：`AbovePrompt`/`UserMessage`/`CommandOutput` | band；藏 echo；画远程行 | 有 `claudeCodeMods` 桥的画布（`AbovePrompt` 序列化 Box/Text/Button，见 §10.3）；Client slot 未枚举 | band 可复用桥或重画；**UserMessage/CommandOutput 不需要**（DSH 无此 hack 需求） |
| 5 | `ui.ask`（label-only + descriptions hack） | 所有交互问题 | `userQuestions.ask`，原生 `description`、`detail`、多题、`multiSelect` | 重写为 DSH 结构（§10.2）；问题文案可 1:1 迁移 |
| 6 | 插件自更新（`claude plugin *`、`/reload-plugins --force`） | §9.2 | profile bundle + `plugin_manager` | 不可移植；改提示或删 |
| 7 | Windows 首次安装（PowerShell、注册表、`--download-only`/`install_argv`） | §9.1 | 取决于 DSH 的 subprocess 能力 | 逻辑可移植，需 DSH subprocess 服务 |
| 8 | 组织 guard（`classic.SessionStart` 被挡、`agent.spawn` 被挡） | 自推 start source、子代理靠首 hook 发现 | 无此机制 | 删除这些 workaround，直接用 DSH 事件 |
| 9 | `store`（`$.store.get/set/keys/delete`） | binding/ledger/offered 标记 | DSH 有 storage/domain、Session 日志；**无同名 KV** | 重写持久层：binding 用插件数据域，ledger 可放 Session 日志或自有 domain |
| 10 | `agent.list/spawn`、`turn.abort`、`tool.stopTask` | 子代理发现/新建子代理/接管 | `subagents` 服务（`startActivation`/`sendMessage`/`interrupt`/`listChildren`）+ `agentTeams`；`agents.list` | 重写映射（§8.5） |
| 11 | `session.messages({as:'api'})`、`agentMessages` | 历史快照、续接、子代理快照 | `Session` 日志可读（`session/event`、可查历史） | 重写读取层（快照/续接逻辑可复用） |
| 12 | `host.settings.read({source:'policy'})` | 判断组织提供的 agent | DSH 无 managed policy | 删除 `org-agents.ts` 逻辑 |
| 13 | `env.CLAUDE_CONFIG_DIR`/`CLAUDE_CODE_*` | pluginData/outbox 路径、禁用非必要流量、Windows/OS 判定 | 用 `DSH_PROFILE_DIR`、`process.platform`、DSH 设置 | 重写路径与环境读取 |
| 14 | `ui.log({to:'debug'|'transcript'})`、`ui.status`、`ui.invalidate` | 消息展示与重画 | DSH 有 UI 通知/状态/日志与 Remote 事件 | 映射为 DSH 日志/通知/状态栏 |
| 15 | `Link`/`Markdown` UI 组件 | band 超链接、远程行 markdown | 桥的序列化元素只有 Box/Text/Button；原生 Client 可自由 | band 走桥则链接降级；走原生可保留 |
| 16 | `prompt.submit` 的 `drop` 语义 | 门禁挡住 prompt 且说明原因（§4.4） | DSH `agent/pre-step` 可拒/改消息；`agent/inbox/*` | 重写门禁（可保留文案） |
| 17 | 合同版本协商（`thread contract` ≥8） | CLI/插件兼容闸 | 与 DSH 无关，保留 | **可复用** |

### 10.2 DSH 可用的原生扩展点（已核实）

- **命令**（`commands` service）：`register({name, description, input:{hint, attachments?}, handler})`；UI 侧直接执行、不进模型 turn；`handler` 收到 `{commandId, agent, rawInput, attachments, signal}`，返回 `{kind:'success', text?, sourceEventSeq?}` 或 `{kind:'error', text}`。`/delta*` 全部可以这样注册，`argumentHint`→`input.hint`。`execute` 会记录 `command/run`、`command/done` 日志。
- **结构化提问**（`userQuestions`）：`ask({questions:[{id, question, detail?, header?, options?:[{label, description?}], multiSelect?}], agent, signal})` → `{answers:[{id, selected[], custom?}]}`。注意：`ask` 要求传入的 agent 是**当前 live 根运行时**（owned child 不能问人），`askTimed` 支持超时并把超时映射为 pending。Delta 的每个问题都能 1:1 映射，且 `descriptions` 不再需要 hack。
- **事件**：`session/created`（带 `SessionStartSource`）、`session/event`（post-commit append feed）、`session/flush`、`agent/created|disposed|status|turn-stopping|error`、`agent/inbox/inserted|claimed|discarded`、`agent/pre-step`（可改/拒绝消息）、`tools/pre-execute|post-execute`、`user-questions/request`、`subagent/start|end`、`plugin-manager/changed|update-state`、`schedule/*`。
- **其它服务**：`workingDirectory.get/set/ensure`（目录切换）、`subagents`（子代理/消息/中断/清单）、`agentTeams`（teammate）、`timer`（`timeout/interval/throttle/debounce`）、`systemPrompt`（注入上下文行）、`storage`/`storageDomain`（持久化）、`webApp`/`webServer`（如需 dashboard 打开回调）、`subprocess`（跑 delta CLI，`spawn`/`resolveExecutable`）。
- **插件形态**：Host bundle（`cordis.patch.yml` + Host 入口 + 可选 Client 入口），`plugin_manager install_bundle` 安装；Client 插件通过 `dsh.client` + slot 注册渲染 UI。**Client slot 具体 key 与注册 API 需在页面连接后复查**（本次 `Slots.listSubTree` 超时）。

### 10.3 `claudeCodeMods` 桥：能不能少写一半？

DSH 已加载一个 Claude Code mod 兼容桥（`claudeCodeMods` Service）：

- `add(ModDefinition)`：mod 用 `on(event, matcher?, hook)` 注册，`ModEvents` = `session.start|session.end|prompt.submit|turn.start|turn.complete|tool.call|command.run|ui.render`；`ModsApi` 提供 `plugin{name,root}`、`ui{log,toast,status,invalidate,open(pane),close,panes,ask,resolve}`、`command{register,run,list}`、`tool{register,call,list}`、`prompt.submit`、`session{id,cwd,root,model,turns,messages,…}`。
- UI：`ui.render` 的 component 只有 `AbovePrompt`/`Pane`；`ui.resolve(e)` 返回 `Box/Text/Button`；`SurfaceSnapshot{generation, tree}`；Client 用 `watchBand(agent, signal)` 订阅、`pressBand(agent, generation, actionId)` 按按钮（等价于 Delta 的 band + 按钮动作）。
- 与 Delta 需求的重合：band 的绘制模型几乎 1:1（Box/Text/Button、actionId、行/宽度由插件自己算）；`ui.ask` 的 `AskOptions` 与 Claude 相同（含 header/multiSelect）。
- **缺口**（按 inspected 契约，`ModsApi.session` 之后的字段被截断，需到 DSH 源码确认）：`fs`、`process.run/spawn`、`http.fetch`、`env`、`settings.policy`、`store`、`clock`、`agent.list/spawn`、`tool.stopTask`、`turn.abort`、`ui.copy`、`Link`/`Markdown`；`ui.render` 无 UserMessage/CommandOutput/AskUserQuestion 组件；无 `session.append/send/attach`。
- **结论**：桥可以复用 **band 的 UI 层**（甚至文案/布局代码），但 Delta 的核心（跑 CLI、进程、fs、store、定时器、记录）不在 `ModsApi` 里。因此推荐 **原生 DSH 插件**：Host 半用 Cordis 服务实现流程，Client 半按 §6 画 band；band 的纯函数（`status.ts` 的 `renderBand`/`StatusState`）可以移植为 DSH Client 的渲染模型（把 `Box/Text/Button` 换成 DSH 组件）。若愿意扩展 `claudeCodeMods`（在 DSH 仓库补 ModsApi），则可走"band 原样复用 + Host 事件适配"的路线，但那是跨仓库改动。

### 10.4 决策点（需 Lead/用户拍板）

1. **路线**：原生 DSH Host+Client 插件（推荐）还是扩展 `claudeCodeMods` 桥后"薄适配"？前者工作量大但可控；后者需要改 DSH 本体。
2. **持久化**：binding/ledger 放插件自有 domain（推荐，按 profile 隔离）还是放 Session 日志？注意 Delta 的 sequence/frontier 语义要求"单写者 + 单调序列"，必须串行化（`serial()` 模式）。
3. **join 在 DSH 的形态**：DSH 可直接 `workingDirectory.set`（甚至不需要新会话），但 Delta 协议要求 `thread mount` 的 owner 与 producer/外部 id 对应，需确认"同一 Host 多会话共用一个 mount owner"是否允许；也需决定是否保留"新会话/`/clear`"以贴合 Delta 的 clean-slate 语义。
4. **子代理**：DSH `subagents` 的 child session 与 Delta child thread 的映射；是否需要保留 worktree fork/symlink 技巧（DSH 无 Claude 的 `.claude/worktrees` 约定，可能整段删除，改为"子代理在父 checkout 内 → shared；否则 isolated"）。
5. **插件自更新**：删除 vs 改为 DSH 市场提示；涉及 store key 与"每小时检查"是否保留。
6. **Windows**：DSH 是否运行在 Windows；若只支持 macOS/Linux，可删 `windows-install.ts` 与 PowerShell 分支（但 `/delta-update` 的 `--download-only` 逻辑仍建议按平台保留）。
7. **Client band 的 slot**：连接 GUI 后重跑 `Slots.listSubTree`；确认是否有"composer 上方"slot 及 props（columns/rows/theme），以及按钮/链接能力。
8. **遥测/隐私**：`DELTA_CLI_INTEGRATION=claude_code` 与 `DELTA_CLI_COMMAND_FORM` 是否改成 `dsh`；这会影响 Delta 服务端的集成统计与隐私声明。

---

## 11. 文件级复用结论

图例：**A=可直接复用**（纯逻辑/无 Claude 依赖）；**B=需改适配**；**C=不可移植/删除**。

| 文件 | 结论 | 说明 |
| --- | --- | --- |
| `hooks/setup/project-policy.ts` | A | 纯函数：路径、解析、序列化、`recordsAutomatically`。DSH 版可原样（路径语义不变）。 |
| `hooks/setup/setup.ts` | B | 纯逻辑占比高（remoteRefusal/emailsIn/modeLabels/invitationSummary/organization 校验/邀请摘要）。`SetupEnv`/`Interaction` 需换成 DSH 的 services；`HEADLESS_REFUSAL`、`UNAVAILABLE_NOTICE`、`DASHBOARD_URL` 保留。 |
| `hooks/setup/delta-menu.ts` | A | 只依赖 `Interaction`（ask/log），常量与状态机可原样。 |
| `hooks/setup/interaction.ts` | C/B | 强绑 Claude `$.ui.ask`/`process.run open`/`pluginData`。DSH 需重写 `Interaction` 绑定、打开链接、进度条、`AskUserQuestion` hint hack（可删）。 |
| `hooks/setup/commands.ts` | B | 分派表/文案可复用；`host.command.register`/`session.surfaces`/`activate` 换成 DSH；`installUpdateHost` 换 subprocess。 |
| `hooks/setup/organizations.ts` | A/B | 缓存 + `delta --json org list` 调用；换 subprocess 即可。 |
| `hooks/setup/activation.ts` | C/B | 核心状态机值得整体移植（记录/自动同步/续接/prune 的决策），但依赖 `$.store`、`$.session`、hooks、`pluginData`、`thread abort`。DSH 重写为事件驱动的 Host 模块，保留函数级逻辑（`startSession`、`activateAutomatically`、`stopAutomaticRecording`、`pruneStore`、`continuationOf/adoptContinuation`）。 |
| `hooks/setup/auto.test.ts` | C | 测试基于 `claude-code/testing` 的 fake engine；DSH 需重写成 Host 集成测试（用例语义可抄）。 |
| `hooks/band/status.ts` | A | **最有价值的可复用文件**：`StatusState`/`BandView`/`renderBand`/`GIVE_WAY`/`updateStep`/`pluginUpdateRow`/颜色与文案全部是纯函数（无 Host）。DSH Client 可把 `StatusSegment` 映射成自己的 Text/Button。 |
| `hooks/band/band.tsx` | B | 布局与 drawBand 逻辑、计时器、copy、按钮动作可照搬；`host.ui.resolve`（JSX）、`Link`、`configure`、`invalidate` 换成 DSH Client/Host API；主题底色换成 token。 |
| `hooks/band/plugin-update.tsx` | B/C | 行布局与按钮逻辑可抄；`pluginUpdateCommand`/`snoozePluginUpdate` 在 DSH 无对应（自更新不可移植）。 |
| `hooks/sharing/share.ts` | B | 分享状态机/进度/拒绝矩阵/账本顺序可整体移植；`snapshotMessages`、`host.session.apiMessages`、`threadCreate/Share/Invite`（CLI 调用可复用）需适配；`snapshotBarrier` 的并发控制可保留。 |
| `hooks/sharing/share-audience.ts` | A | 纯问题/答案逻辑，原样。 |
| `hooks/sharing/join.ts` | C/B | 终端 join 的"clear+cd"、Desktop handoff、`pluginData/handoffs`、mount owner 全部 Claude 特化；但 `threadMount`/`requireMounted`/binding 字段/重连与 retry 逻辑可复用。DSH 需重写迁移与会话切换（`workingDirectory.set`）。 |
| `hooks/sharing/handoff.ts` | C | `claude://code/new`、Desktop 专用；DSH 删除。 |
| `hooks/sharing/lifecycle.ts` | A | 纯判定（`releasesMounts`/`hasInteractiveSurface`/`joinPreflight`/`promptGate`/`worktreeChanges`/`ownsSteering`）。DSH 的"交互面"判定换成 Web GUI 恒真。 |
| `hooks/sharing/checkout.ts` | B | `worktree list/create/attach/mount` 的流程可复用；`hasWorktreeMount` 进程内 registry 可复用（DSH subprocess 需支持长驻进程）。 |
| `hooks/watch/watch.ts` | B | 连接状态机、事件处理、inspection、退避、followUpload 值得整体移植；`threadWatch`（spawn+JSONL）可复用；`host.ui.invalidate`/`store`/`pauseCheckout` 换 DSH。 |
| `hooks/watch/presence.ts` | A | 纯去抖逻辑，原样。 |
| `hooks/watch/row-delivery.ts` | C | Claude 的"隐藏命令画行"机制（`show <id>`/`SHOW_ANSWER`/echo 重写）在 DSH 无意义；`DrawQueue`/`DrawnRows` 思想可留（防止重复注入）。 |
| `hooks/watch/rows.tsx` | C | `ui.render UserMessage/CommandOutput` 专用；DSH 用原生行渲染/上下文注入替代。`deliverNote`（给模型的 [Delta] 上下文）可复用（映射到 DSH 注入方式）。 |
| `hooks/watch/conversation.ts` | A/B | 纯文本/渲染/`RemoteView`/ledger 大体可复用；`Markdown`/`itemDisplay` 输出给远程行，DSH 可用自己的 Markdown 渲染。 |
| `hooks/subagents/subagents.ts` | C/B | 记录子代理到子线程的核心（发现/outbox/交付/接管）有复用价值，但强依赖 `agent.list`（无 spawn hook）、`tool.stopTask`、`turn.abort`、`agentMessages`、Claude worktree 约定。DSH 用 `subagents` 服务/事件重写，保留 binding/outbox/sequence 设计。 |
| `hooks/subagents/children.ts` | A | 纯数据/命名/规则（`recordsSubagent`、`childKey`、`childOutbox`、`sentBy`），原样。 |
| `hooks/subagents/thread-runs.ts` | B | "Delta 线程当子代理"的语义可移植，但 `agent.spawn`/`prompt.submit`/`session.send`/`agentMessages` 全部要换 DSH；`delta-threads.ts` 的 prompt 构造可保留。 |
| `hooks/subagents/delta-threads.ts` | A | 纯 prompt/历史/报告构造。 |
| `hooks/subagents/org-agents.ts` | C | 依赖 Claude 托管设置与 managed agents；DSH 无，删除。 |
| `hooks/subagents/git-worktrees.ts` | B | 只读 git porcelain，可复用；但整个 fork/symlink 策略在 DSH 可能不需要。 |
| `hooks/plugin-update/catalog.ts` | C/B | 版本比较、manifest 解析、listing 解析可复用；`claude plugin list/marketplace list`/marketplace 分支识别不可移植（DSH 无此安装模型）。 |
| `hooks/plugin-update/updates.ts` | C | CLI/宿主专用（`/reload-plugins`、claude CLI、桌面语义）；DSH 应重写为 DSH 市场检查或删除。 |
| `hooks/cli/install-update.ts` | B | app/CLI 更新的状态机、schema 校验、Windows handoff、进度事件、超时/锁可复用；只换 `UpdateHost`。 |
| `hooks/cli/auth.ts` | B | 登录/条款状态机可复用；换 `AuthenticationHost`（sleep/spawn/ask/open）到 DSH。 |
| `hooks/cli/cli.ts` | B | CLI 发现/安装脚本可复用；Windows 注册表/PowerShell 取决于 DSH 平台支持。 |
| `hooks/cli/windows-install.ts` | B | PowerShell 脚本可原样执行（若 DSH 支持 Windows 子进程）；否则删。 |
| `hooks/cli/delta-cli.ts` | A/B | **CLI 协议层，几乎全部可复用**：子命令参数、JSON 校验、mount/watch 流读取、契约协商。只需把 `Host.process/fs/clock` 换成 DSH 实现。 |
| `hooks/cli/thread-commands.ts` | A | 协议解析/校验/错误分类/契约版本/`permanentFailureAdvice`，纯逻辑，原样。 |
| `hooks/cli/command-outcomes.ts`/`command-reader.ts` | A | receipt 校验与流读取，纯逻辑，原样（需确认 DSH subprocess 流接口）。 |
| `hooks/core/{host,binding,json,paths,text,compatibility,installation,transcript}.ts` | A/B | `Host` 类型换成 DSH 服务集合；其余纯逻辑可原样；`transcript` 是 Claude transcript 定位（C，DSH 用 Session 日志）。 |
| `hooks/core/session-state.ts` | B | Binding/State 模型是移植核心，可原样；`store`/`$.session` 换 DSH；`report`/`recoveryAdvice` 文案保留。 |
| `hooks/recording/*` | B/C | 录制管线（outbox/sequence/update 形状）可复用；入口 hook（`session.append`/`turn.start`）与 `ui.log` 需 DSH 重写。（不在本任务范围，仅交叉引用。） |

### 11.1 建议的 DSH 模块划分（供实现任务参考）

```
delta-dsh/
  src/host/            # Cordis Host 插件
    index.ts           # 注册命令、事件监听、userQuestions 使用
    policy.ts          # A: project-policy
    cli/               # A/B: delta-cli, thread-commands, command-reader, install-update, auth
    state/             # B: binding/state/persistence（单写者串行）
    setup/             # B: wizard/menu/onboarding（Interaction 接口换成 DSH）
    sharing/           # B: share/join/checkout（去掉 handoff/clear-cd）
    watch/             # B: connection/presence/followUpload/ledger
    subagents/         # B: subagent 映射（用 DSH subagents 服务）
    band/              # A 的 StatusState/renderBand + Host 侧状态投影
  src/client/          # DSH Client 插件
    band.tsx           # 按 StatusState 画：主行+详情+活动行+按钮（§6）
  research/            # 本文档
```

---

## 12. 风险与未决问题（供 Lead）

1. **DSH Client 渲染能力未验证**：`Slots.listSubTree` 超时，band 的 slot/props/按钮/主题能力未知；这是 UI 移植的第一阻塞项。打开 GUI 后先跑 `cordis_inspect_list` + `Slots.listSubTree`（root 用候选 slot）再定组件。
2. **录制语义差异最大**：Delta 的 sequence/frontier/outbox/fence 模型建立在"插件能拦截每一行并持久化"之上；DSH 的 Session 日志是 append-only 事件流，需确认能否在 turn/step 边界拿到等价数据（`session/event` + `agent/pre-post`），否则整个记录层要重设计。
3. **join 语义**：Delta 用"新会话 + `/clear` + `thread mount` owner"保证干净加入；DSH 可以切目录但会话切换语义不同，需与 Delta 协议侧确认是否允许同 owner 多会话、以及 mount 的 owner 生命周期（离开页面/关会话如何释放）。
4. **`claudeCodeMods` 桥的 ModsApi 缺口**：`session`/`store`/`process`/`fs` 字段被截断未确认；若桥实际提供这些，则"薄适配"路线的成本会大幅下降。建议实现前先读 DSH 源码 `claude-code-mods` 包的 `.d.ts`。
5. **插件自更新不可移植**：若产品要求 DSH 版也自动更新，需要 DSH 提供安装器能力；否则在 README/UI 里改成手动更新说明。
6. **多会话并发**：Delta 用 `serial()` 全局串行 + store 无事务假设；DSH 单 Host 多会话并发更强，需要同样或更强的串行化（一个 profile 内所有 Delta 会话共享 binding store）。
7. **路径/凭据隔离**：Claude 的 `CLAUDE_CONFIG_DIR/delta-plugin` 与 DSH 的 `DSH_PROFILE_DIR` 不同；DSH 版必须用自己的数据目录，避免与 Claude 插件抢 outbox/handoff（若两者同时装在同一机器）。
