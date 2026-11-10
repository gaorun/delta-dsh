# Delta 录制管线移植调研（delta → DSH）

> 任务：task-1。范围：`hooks/recording/*`、`hooks/cli/*`、`hooks/core/*`、`hooks/register.tsx` 的录制路径、
> `hooks/testing/fixtures/cli/*`、以及 `register.test.ts` 与 `recording/*.test.ts` 体现的契约。
> 方法：只读源码与测试；未运行测试、未安装任何东西、未做 git 操作。DSH 侧事实对照
> `research/dsh-host.md`（task-4，DSH 0.2.2-rc.1 实测）与 `research/flows-port.md`（task-2）。
> 结论先行：**录制层与 DSH 之间隔着一个 `Host` 接口 + 一层“行投影”**。`core/host.ts` 的 `Host`
> 在 DSH 上实现后，`recording/`、`cli/` 约 80% 可原样复用；但 DSH **没有可改写的逐行
> `session.append` 入口**（`session/event` 是 post-commit emit，不能新增/改写事件），所以必须新增
> 一个把 SessionEvent 投影成 Delta row 的模块（见 §5 D1）。标题在 DSH 反而可直接移植
> （`session/title`/`ctx.sessionTitle`）；真正要改的是 **Claude transcript 派生逻辑**和
> **Claude 内置工具名/结果 schema**（`toolInfo`/`resultDiff`）。

---

## 0. 结论摘要

1. **可原样复用的 seam 是 `Host`**：`hooks/core/host.ts:14` 把 `$` 收窄成一个纯接口；`register.tsx:56`
   的 `hostOf($)` 是唯一命名 `$` 的地方（插件加载器只允许在注册文件里碰 `$`）。移植时保留
   `Host` 类型不动，只把 `hostOf` 换成 DSH 适配器，`recording/`、`core/session-state.ts`、
   `cli/*` 的绝大部分不用改。
2. **录制的最小事件面只有 4 个**：`session.append`（行）、`tool.call`（结构化工具结果）、
   `turn.start`/`turn.complete`（turn 生命周期），加上门禁用的 `prompt.submit`、
   `session.start`/`session.end`。其余事件（`session.attach`、`ui.render`、`command.run`、
   `config.set`、`session.send`）属于流程/UI 层，见 `flows-port.md` 与 `engine-contract.md`。
3. **Delta 的 sequence 不是引擎给的**：它是插件自己维护的 outbox 序号（`binding.next`，
   `recording/delivery.ts:128-143`）。引擎只提供**每行稳定的 `uuid`**（用作 `messageId` 前缀）
   和 tool_use/tool_result 的 id 配对。这一点对 DSH 有利：不需要 DSH 有全局单调序号。
4. **不可原样复用**（DSH 无对应物或语义不同）：
   `core/transcript.ts`（Claude transcript 路径发现/增量读）、`recording/title.ts` 的 transcript
   读取段、`setup/activation.ts` 的 continuation 检测（读 `continued-in` 行；DSH 改用
   `parentSession`/fork 事件）、`core/compatibility.ts`（Claude 版本下限）、`/delta show` 的行改写
   （DSH 不能改写已提交事件）。
5. **协议侧硬约束不能改**：`--source claude-code`、producer `source` 校验、契约版本 `[8,8]`、
   `DELTA_CLI_INTEGRATION=claude_code`、`PRODUCER_NAME='Claude Code'`（`cli/thread-commands.ts:402-419`、
   `cli/delta-cli.ts:35`）。除非 Delta CLI 新增 source，DSH 侧必须继续以 `claude-code` 身份录制。
6. **最大风险**是 DSH 没有 `session.append` 的等价物：`session/event` 是 post-commit、不可改写、
   fire-and-forget 的 emit（dsh-host §2.2/§2.3）。录制仍可工作——用 `user/message`、
   `assistant/message`、`tool/call`、`tool/result`、`turn/start/end` 等事件做**行投影**——但
   `/delta show` 的行改写不可能实现，必须去掉或改到 Client 半边（见 §5 D1/D16）。
7. **DSH 侧落点已核对**（见 §5.0 总表）：id/cwd/root/turns/messages/title/turn/tool 都有对应；
   `ui.status`/`ui.log`/`surfaces` 在 Host 侧无对应（属 Client 半边，task-5）；
   `process.run` 要自己用 `ctx.subprocess.spawn` 封；`store` 落 `ctx.storageDomain`；
   outbox 用 `node:fs` + DSH profile 目录。

---

## 1. 录制模型总览

### 1.0 概念与代码对照

| 概念 | 形状/位置 | 说明 |
| --- | --- | --- |
| 行 row | `session.append` 的 `message`（`SessionAppendMessage`） | `{type: user/assistant/attachment/system, name?, role?, isMeta?, content: ApiContentBlock[]}` |
| door | 12 值闭集 | `prompt/command/response/tool-result/tool-message/delivery/attachment/hook-context/note/compaction/notice/queue` |
| origin | 人/composer、模型、tool、engine、plugin | Delta 只用 `origin.kind`/`origin.name` 做过滤与 `show` 识别 |
| uuid | 引擎给的行 id | Delta 用作 `messageId` 前缀、`drawn` 账本键；**不是** Delta 的 sequence |
| Update | `recording/content.ts:6`，ACP `sessionUpdate` 形状 | 见 §1.4 |
| Entry | `subagents/children.ts:9`：`{sequence, files, digest}` | outbox 的一条待发记录 |
| Binding | `core/session-state.ts:29` | 每会话存 `store["session:<id>"]`；含 thread/locator/pending/next/execution/snapshot 等 |
| producer / externalId | `producerOf(binding)`（`:104`） | 一般=session id；会话续接时=父会话 id；子代理=agentId |
| turnSequence | 记录信封里的可选字段 | 该条记录属于哪个 turn 的 start 记录序号；仅 turn 自身的 running 记录可等于 sequence |
| snapshot | `binding.snapshot` | 录制总开关；只有 share/自动同步创建 snapshot 后才录行 |

### 1.1 端到端流水线

```
Claude 行
  └─ session.append hook（register.tsx:307-310）
       ├─ 过滤：door 匹配 + capturedMessage(e.message, e.door)
       ├─ next(e) 先让引擎存储行 → 拿 stored.message / stored.uuid
       └─ messageUpdates(stored.message, stored.uuid, …) → Update[]
            └─ liveActivity() 加 _meta.delta
                 ├─ 归属 turn：contentTurn() / heldRows（turn.start 未落盘时先挂起）
                 └─ persistUpdates → writeRecord → stageRecord（delivery.ts:120）
                      └─ stageOutboxRecord（:128）
                           line = {"schemaVersion":1,"sequence":N,["turnSequence":S,]"update":{…}}\n
                           fs.write  outbox/<producer>/<seq>-<chunk>.json   （≤900_000 字符/文件，≤16MiB/条）
                           binding.pending.push({sequence,files,digest}); binding.next++
                           save(binding)   （store）
                 └─ drain()（:525）
                      ├─ requireContract()（cli/delta-cli.ts:116）——每会话一次
                      ├─ verifyCheckout()（delivery.ts:247）——thread status + frontier + checkout 校验
                      ├─ appendPending()（:330）——按 ≤2MB 一批拼接 JSONL，stdin 喂给 CLI
                      │    delta --json thread append <reference> --source claude-code \
                      │      --external-id <producer> [--acknowledge local] --producer-name "Claude Code"
                      │    stdout 每行一个 receipt → parseAppendReceipt（thread-commands.ts:543）
                      │    只承认“按序匹配的前缀”；fenced 的 turn 立刻 loseExecution
                      └─ 确认前缀从 pending 裁掉 → scheduleOutboxCleanup（rm/PowerShell 删文件）
失败 → failDelivery（:555）：classifyCommandFailure → 可重试则 clock.after 退避重试；否则 pause('delivery'|'verification')
```

### 1.2 前置门禁：激活与 capture boundary

- `session.start` → `activate()`（`setup/activation.ts:58`）：确定 `pluginData=<config>/delta-plugin`、
  `outbox=<pluginData>/outbox`；从 store 读 binding；续接检测；已在录制中的会话再校验契约、恢复
  execution、起 watch、drain pending。
- `/clear`、`/resume` 后没有 `session.start`；`noticeSession()`（`activation.ts:218`）在首个行/首个
  prompt 时补做启动判定：`turns()===0 ? 'startup' : 'resume'`（`:249`），并打开 capture boundary
  （`captureDecided`，`:477`）。**录制行会等这个边界**（`delivery.ts:800`）。
- 只有 `binding.snapshot === true` 才录行（`delivery.ts:823`）；snapshot 由两处创建：
  - 显式 `/delta share`：先 `apiMessages()` 导出历史，全部 staged 后一次 `save({…, snapshot:true})`
    （`sharing/share.ts:138-190`）。
  - 仓库策略自动同步：新会话直接 `{session, snapshot:true, next:1, pending:[], checkout, autoUpload}`
    （`activation.ts:607`），不导出历史。
- `prompt.submit` 的 `admitPrompt`（`recording/prompt.ts:26`）是录制可用性的门禁：join/share 进行中、
  capture boundary、activation、snapshot 缺失、watcher/checkout 未就绪、turn 归属（steering）任一不满足
  就返回 `{drop: 原因}`；`next` 只在 prompt 进入会话且 turn 已开始后 resolve。

### 1.3 行 → Update 的逐条规则

**门（matcher）**：`register.tsx:307` 注册
`door: ['prompt','command','response','tool-result','delivery']`；`:309` 另注册
`door: 'tool-message'` 且 `origin: {kind:'tool', tool: /^(?!Skill$)/}`。也就是：工具消息行里
**Skill 的正文不录**，其余工具消息录；attachment/hook-context/notice/compaction/note/queue 不录。

**capturedMessage**（`content.ts:9-37`）按 door 决定是否录、录什么：

| door | message 条件 | 结果 |
| --- | --- | --- |
| `command` | user/user | 只保留文本块，并 `bashMarkdown()` 转成可读命令/输出（无文本则丢弃） |
| `attachment`/`hook-context`/`notice`/`compaction`/`note` | 任意 | 不录 |
| `response` | assistant/assistant | `{role:'assistant', content:[...]}` 全块 |
| `tool-result`/`tool-message` | user/user | 只保留 `tool_result` 块；没有则丢弃 |
| `prompt`/`delivery` | user/user 且非 `isMeta` | 文本块 `bashMarkdown()` 后可读化 |
| 其它 | — | 不录 |

**messageUpdates**（`content.ts:272-333`）把一条 ApiMessage 拆成多个 Update：

- 连续的非空文本块聚合为一条 `user_message`/`agent_message`，`messageId = "<id>:message:<首个块下标>"`；
  纯空白文本丢弃。
- `thinking`/`redacted_thinking` → `agent_thought`，`messageId="<id>:thought:<下标>"`，
  `_meta.claudeCode.block` 保留原始 thinking block（含 signature/data）；空 thinking 丢弃，
  redacted 记 `[redacted thinking]`。
- `tool_use` → `tool_call_update`（`status:'in_progress'`, `name`, `title`, `kind`, `rawInput`）；
  `ExitPlanMode` 整条丢弃（`content.ts:259-266`），它的 tool_result 也丢弃。
- `tool_result` → `tool_call_update` 关闭：`status` 取 call 的结果记录（有则用 `structured.status`，
  否则 `is_error?'failed':'completed'`），`rawOutput` 优先用结构化结果，`content` 里包
  `{type:'content',content:block}`（ACP v2），并附结构化 diff/内容。`tool_use_id` 在 `omitted` 集合里也丢弃。
- 其它块（image/audio/document/resource/resource_link/未知）经 `blocks()`（`content.ts:52-113`）转成
  ACP 形状；无法解析的保留为 `{type:'text', text: JSON}`（宁可不漂亮也不丢数据）。

**bash-mode 行**：`bashMarkdown()`（`recording/bash.ts:1-38`）把
`<bash-input>/<bash-stdout>/<bash-stderr>` 整行转成 `Ran \`cmd\``、围栏代码块、`Stderr:` 段；
只有整行都是这些标签才转换，散文里的标签不动。

**turn 归属**（易错点，务必在 DSH 保留）：

- `turn.start` 才写该 turn 的 start 记录并分配 sequence（`beginExecution`，`delivery.ts:382`）。
- 早到的 prompt 行/assistant 输出通过 `heldRows`（`:92`）挂起，等 start 落盘后按该 sequence 落；
  挂起时 turn 结束/丢失 → 丢弃（避免给 Delta 一个“已结束 turn”的迟到输出，会被 fence）。
- `contentTurn()`（`:77`）决定一条输出属于哪个 sequence：当前 running turn 的 execution.sequence、
  已丢失 turn 的 `lastTurnSequence`，否则最近一次 start 的 sequence。
- `tool.call` 在调用时就把 `tool_use_id → turnSequence` 记入 `ToolRecords.toolTurns`（`:864`），
  使迟到的 tool_result 行仍归原 turn。

### 1.4 Update 形状（CLI append 的 `update` 字段）

| sessionUpdate | 字段 | 产生点 |
| --- | --- | --- |
| `user_message` / `agent_message` | `messageId`, `content`（ACP content blocks） | `messageUpdates` |
| `agent_thought` | `messageId`, `content`, `_meta.claudeCode.block`（原 thinking block） | `messageUpdates` |
| `tool_call_update`（开） | `toolCallId`, `name`, `title`, `kind`, `status:'in_progress'`, `rawInput` | `messageUpdates`；call 早于行时由 `resultUpdate`+`toolInfo` 补 |
| `tool_call_update`（闭） | `toolCallId`, `status:'completed'（或 'failed'）`, `rawOutput`, `content?`（diff） | `messageUpdates` 或有结构化结果时 `resultUpdate` |
| `state_update` running | `state:'running'`, `_meta.delta.producer_version?`, `_meta.delta.execution_location?` | `runningUpdate`（`delivery.ts:359`） |
| `state_update` idle | `state:'idle'`, `stopReason?`（`end_turn`/`cancelled`/`refusal`/`error`）, `error?`（error 时固定 `{code:-32603,message:'External producer reported an error'}`） | `endExecution` |
| `session_info_update` | `title` | `recordTitle` |

所有“活行”再经 `liveActivity()`（`delivery.ts:102-118`）加
`_meta.delta = {work_origin:'external_agent', interaction_surface:'cli', activity_kind}`
（`activity_kind` ∈ `user_message|agent_message|agent_thought|tool_call|edit`，有结构化 diff 的 tool_call 记为 `edit`）。
`toolInfo`（`content.ts:194-257`）按 Claude 工具名生成 ACP title/kind；`resultDiff`/`editDiff`
把 Edit/Write 的 `structuredPatch` 转成 `git_patch`，路径相对 checkout root。

### 1.5 Update → Entry → outbox

- 落盘单位是“一条 Update 一个记录文件组”：`stageOutboxRecord`（`delivery.ts:128-143`）。
- 行格式：`JSON.stringify({schemaVersion:1, sequence, ...body}) + "\n"`；`body = {update, turnSequence?}`。
  发送前 `pendingRecordTurn`（`outbox.ts:56-75`）校验：重新序列化必须字节一致（防重复键/手改）、
  `schemaVersion===1`、`sequence` 合法、键集合只允许两种、`update.sessionUpdate` 非空字符串、
  `turnSequence < sequence`，**唯一例外**是 turn 自己的 running 记录（`turnSequence===sequence &&
  state_update && state==='running'`）。
- 分片：`outboxChunks`（`outbox.ts:5-22`）按 900_000 UTF-16 字符切片、避免切断代理对；
  整条超过 16MiB 直接报错并暂停 sharing。
- 文件路径：`<outbox>/<producer>/<sequence>-<chunkIndex>.json`（`delivery.ts:140`）。
- 完整性：`digest` = SHA-256 hex（`session-state.ts:315`，`crypto.subtle`）；读回时重算，
  不一致 → 抛错并暂停（`delivery.ts:151-156`）。
- 权威性：`binding.pending` 是“已写入但未确认”的唯一清单；写入前绝不引用文件；
  中断留下的孤儿文件由清理逻辑按“pending frontier 以下 + 文件名白名单”删除
  （`outbox.ts:76-99`），绝不递归删除。

### 1.6 交付：批量 append、ack 解析、重试、暂停

- `drain()`（`delivery.ts:525`）单飞：进程内同一时刻只有一个 drain；pending 仍有剩余时递归再 drain。
- `appendPending`（`:330`）：
  - 逐条读回文件、`pendingRecordTurn` 取 turnSequence；`appendBatch`（`outbox.ts:44-50`）保证
    累计 ≤2_000_000 字节（注释说明是为了远低于 `process.run` 的 4 MiB stdout 捕获上限）。
  - 调用 `threadAppend`（`cli/delta-cli.ts:384-405`），stdin 即这批 JSONL。
  - `acknowledgedPrefix`（`outbox.ts:24-42`）：stdout 每个非空行必须 `parseAppendReceipt`
    且 `thread_id`/`sequence` 匹配、`turn_sequence` 与发出的记录一致；遇到第一个不匹配就停止。
  - 退出码非 0 → `appendFailure`（优先取 stdout 里的 error 信封，其次 stderr）；
    退出码 0 但确认数 < 发送数 → `invalid_acknowledgment`（永久失败）。
  - `fenced` 的 receipt：若 fence 的 turn_sequence 是当前 running execution 的 sequence →
    `loseExecution`（abort 该 turn 并写 idle 结束记录），不等待。
- 失败分类：`classifyCommandFailure`（`thread-commands.ts:170-176`）**信封的 `retryable` 优先**；
  无信封时只看本地码表 `process_failed/timeout → transient`、`command_failed/invalid_acknowledgment → permanent`
  （`:158-163`）。
- 重试：`deliveryRetryDelay`（`delivery-policy.ts:23-26`）= `min(30_000, 2000*2^min(attempt,4))`
  再取 `max(retryAfterMs, backoff)`，最终 `min(…, 300_000)`；用 `clock.after` 定时器而不是 sleep
  （`delivery.ts:595-604`）。
- 暂停：三种 `watcher|verification|delivery`（`session-state.ts:229-244`）。一次失败若
  verification 已暂停 → 记到 `verification`，否则 `delivery`；永久失败立即暂停，transient 只重试。
  提示去重按 `${retry}:${code}`（`delivery-policy.ts:8-21`），文字随原因变。
- 捕获失败（写 store/outbox 失败）→ `recordCaptureFailure`（`delivery.ts:606`）：写 `captureFailure`、
  `loseExecution` 停当前 turn、报错；之后不再录，直到 `flushUnsaved` 成功（`:642`）。

### 1.7 turn / execution 生命周期

- `turn.start`（主环路 `agentId===undefined`）→ `startTurn`（`:720`）：
  `noticeSession` → `captureDecided` → 记 `currentTurnId`；若已有 snapshot 且非本地 hand-off turn，
  `beginExecution`：先补写上一未闭合 execution 的 idle 记录，再写本 turn 的 running 记录
  （`turnSequence = 自身 sequence`），`binding.execution={sequence,turnId}`、`lastTurnSequence=seq`，
  把 `heldRows` 中属于本 turn 的行落盘，存 `nativeTurns[turnId]=seq`。随后按 offline/pause/watch
  可用性决定是否 `loseExecution`，否则后台 drain。
- 录制被判定不可用（hook 抛错）时 `host.turn.abort({turnId})`，绝不让“无归属输出”继续
  （`:742-746`）。
- `turn.complete` → `completeTurn`（`:753`）：取 sequence（nativeTurns 或 execution），清 runtime，
  `next(e)`，`tools.forgetUnpaired(seq)`，`endExecution`（写 idle+stopReason，删 execution），
  限时交付 `TURN_COMPLETE_DELIVERY_BUDGET_MS = 5_000`（`:424`，注释：宿主约 10s 预算），
  超时后续由 outbox 后台完成。stopReason 映射见 `subagents/subagents.ts:79-84`。
- `recoverExecution`（`:513`）：进程重启后只 abort“本进程亲眼见过”的 turn，否则只补 idle 记录。
- `observeTurn`（`:506`）：watch 报 `producer.turn.status==='superseded'` → loseExecution。

### 1.8 snapshot（历史导出）

- `snapshotMessages`（`recording/snapshot.ts:21-36`）：取最后 4096 条，保持顺序；user 行里
  去掉整块引擎 framing（`<command-name>/<command-message>/<command-args>/<local-command-stdout>/
  <local-command-stderr>/<local-command-caveat>/<system-reminder>`）、以 `[Delta]` 开头的行、
  以及紧挨 tool_result 的 `Tool loaded.` 文本块；剩下的文本再 `bashMarkdown()`。
- `sharing/share.ts:146-176`：`apiMessages()` 拿快照（≤4096、已规范化、以 user 开头）；
  `messages()` 拿工具摘要，把 `toolUses[].result` 预置进 `structuredResults`；
  逐条 `messageUpdates(message, "snapshot:<i>", …)` 后 `stageRecord`（**不带 turnSequence**），
  最后一次性 `save({…, snapshot:true})`。
- 并发屏障：`beginAppend`/`endAppend`/`waitForSnapshot`（`sharing/share.ts:42-64`）保证
  snapshot 读取期间新行不落盘；`recordRow` 用 `beginAppend` 包住 `next(e)`+落盘（`delivery.ts:817`），
  `recordToolCall` 在写结构化结果前 `await waitForSnapshot()`（`:869`）。

### 1.9 tool records 配对（`recording/tool-records.ts`）

`ToolRecords` 保存 5 张表：`structuredResults`（call 的结果 Update）、`toolResults`（结果行 block）、
`toolTurns`（call 时的 turn sequence）、`omitted`（不录的工具 id）、`settled`（已见过哪一半）。

- 两半以任意顺序到达：call hook 的结果、结果行 block。`settle(id, half)` 在第二半到达时释放。
- 只见过一半的条目：`forgetUnpaired(completedSequence)` 在该 turn 完成时释放**更早 turn**的条目
  与无 turn 的条目（`:47-52`）；本 turn 的留到下一个 turn 完成。
- `ExitPlanMode` 调用与其结果都走 `omitted`；Skill 的 tool-message 行由 matcher 排除（不占 ToolRecords）。
- 没配对的 call 也会先落一条 `status:'in_progress'` 的 tool_call_update，带 `e` 里的调用参数
  （`toolInfo(e.tool, e, root)`），保证 Delta 能看到这次调用（`delivery.ts:874-884`）。

### 1.10 契约协商与 offline 规则

- 契约：`thread contract` 每个 session 只查一次（模块内 `Map`，`delta-cli.ts:53`），
  `session.end` 时 `forgetContract`。CLI 不认该子命令（非 0 退出且 stdout 空）→ 视为 `undefined`
  = 太旧；`parseThreadContract` 校验 `operation:'contract'`、`min/max` 安全整数、`0<=min<=max`。
  `[PLUGIN_CONTRACT_MIN, PLUGIN_CONTRACT_MAX] = [8,8]`（`thread-commands.ts:402-408`），
  `contractVersion = min(cli.max, 8)`。子代理录制能力门槛 `CHILD_CONTRACT_VERSION=7`（`:419`）。
  拒绝不记忆，成功才记忆；会话结束/重新激活后重新协商。
- offline：`recordsOffline(session,binding)`（`delivery.ts:53-55`）= 有 binding、非 joined、
  且本会话契约已验证。满足时 append 带 `--acknowledge local`，由 Delta 后台上传；
  非 joined 会话的 transient 投递失败不阻塞 prompt（`prompt.ts:114-127`）。**joined 会话永远不 offline**：
  写别人 thread，必须服务端确认。

### 1.11 checkout 校验（每次 drain 前）

`verifyCheckout`（`delivery.ts:247-271`）：

1. `boundDirectory(binding)` 必须存在（joined → `binding.directory`，否则 `binding.checkout`）。
2. joined 会话还要求 `session.id()===binding.session` 且 Claude 在绑定目录内（`isInDirectory`，
   `session.root()`+`cwd()`，`:231-245`）。
3. `threadStatus(...)`（stream 读，默认 120s）→ `parseThreadStatus`。
4. `validateThreadFrontier`（`thread-commands.ts:565-580`）：thread_id 一致；producer
   `source==='claude-code'` 且 `external_id===binding.producer ?? binding.session`；
   `next_sequence` 不能小于本地已确认 frontier，也不能大于本地 next（丢失/超前都报错）。
5. `validateJoinedMounts`（joined）或 `validateThreadCheckout`（普通）：access 必须 granted
   （自动上传会话允许 local_only）、worktrees 必须 available、绑定目录+reference 的 checkout
   必须 attached/active（或 detached 且 active）、joined 的每个 worktree 必须 active 且目录一致。
   worktrees unavailable 时抛携带 CLI code/reason 的 `DeltaCommandError`。
6. 恢复 pause、写 watch 状态（`rememberStatus`）。

### 1.12 标题

- `register.tsx:169-177`：`turn.complete` 后 fire-and-forget `followTranscript`（不阻塞、不失败 turn）。
  注：DSH 侧改用 `session/title`/`ctx.sessionTitle`，不需要 transcript（见 §5 D6）。
- `followTranscript`（`activation.ts:305-320`）→ `findTranscript` → `recordTitle`（`title.ts:118`）。
- `TitleScanner`（`title.ts:26-68`）扫描 Claude transcript 的 JSONL：`{"type":"ai-title","aiTitle":…}`
  与 `{"type":"custom-title","customTitle":…}`，**最后一次 rename 优先**；`cleanTitle` 合并空白、截断 200。
- 读取：`tail -c +offset`（Windows 用 PowerShell 从 stdin 取 path/offset，`:70-83`）；失败则
  `fs.read` 整个文件（≤4MiB，`:100`）；窗口 256KiB、行上限 16KiB、超时 10s；连续 3 次找不到 transcript
  就停。只对“非 joined 且已有 thread”的会话录 `session_info_update`，`binding.title` 去重。

---

## 2. Hook 输入契约（delta 实际依赖的字段）

事件类型来自 `.claude-plugin/types/claude-code/index.d.ts`（Claude Code 2.1.318 生成）。

### 2.1 `session.append`

输入（`index.d.ts:11437-11529`）：

```
message: { type:'user'|'assistant'|'attachment'|'system'; name?; role?:'user'|'assistant';
           isMeta?: true; content: ApiContentBlock[] }
door: SessionAppendDoor            // 12 值闭集，匹配器键
origin: SessionAppendOrigin        // prompt/composer、model、tool、engine、plugin、peer…
uuid: string                       // 稳定行 id，同一行在 transcript 与后续读取中一致
agentId?: string                   // 子代理循环；主环路缺省
```

- delta 读取：`message.type/role/isMeta/content`、
  `door`、`origin`（`{kind:'tool',tool}` 正则、`{kind:'plugin',name}`）、`uuid`、`agentId`。
- `next(e)` 的返回（`index.d.ts:11544-11570`）：`{message, uuid}`（行已存储）或 `{deny: reason}`
  （仅插件自己的 append 可能被拒）。钩子可以 `next({...e, message})` 改 content（Delta 只在
  `/delta show` 内部行上这么做）；pinned 字段（type/name/role/isMeta/door/origin/uuid/agentId）改了会被拒。
- delta 处理：`recordRow`（`delivery.ts:786-853`）。先 `noticeSession`（补启动判定），再
  `shownCommandRewrite`（把插件自己的 show 行改写掉后 `storeShownRow`），再过滤/转换；`next(e)`
  之后才用 `stored.message`/`stored.uuid` 落盘；`beginAppend/endAppend` 包住；`tool_result` 行同时
  `tools.settle(id,'row')`。
- 子代理：`register.tsx:145` 按 `e.agentId` 分派 `recordChildRow`（`subagents/subagents.ts`），
  每子代理有独立 thread/outbox，`externalId=agentId`。

### 2.2 `tool.call`

输入（`index.d.ts:13828-13862`）：`{tool, tool_use_id?, consent?, ...该工具的参数（Bash 有 e.command，Edit 有 e.file_path…）}`
+ `agentId?`（`AgentLoop`）。`tool`/`tool_use_id`/`agentId` 保留，不可改写。

返回（`index.d.ts:13876-13930`）：`{result, context?, ref?, text?, isError?, isReadOnly?}` 或 `{deny}`。
`result` 是工具的结构化输出（核心会按工具输出 schema 校验）；`ref` 由核心设置、指向核心产出的消息。

- delta 读取：`e.tool`、`e.tool_use_id`、`e.agentId`、以及**工具参数本身**（用于 `toolInfo` 生成
  title/kind）、`result.result`、`result.isError`。
- delta 处理：`recordToolCall`（`delivery.ts:855-895`，provisional 记录在 `:874-884`）。`isAskingOwnQuestion()` 时不录
  `AskUserQuestion`；按 `contentTurn` 绑定 turn；`next(e)` 后 `waitForSnapshot`；若已有结果行则
  用 `messageUpdates` 关闭该调用，否则先落 `in_progress` 记录；`finally` 里成对 settle 或 forget。

### 2.3 `turn.start` / `turn.complete`

`turn.start`（`index.d.ts:14608-14649`）：`{text, turnId, agentId?}`；返回 `{turnId}`（核心回显）。
`turn.complete`（`index.d.ts:14490-14600`）：`{answer, durationMs, isAborted, turnId, agentId?,
reason:'answer'|'aborted'|'refusal'|'error', refusal?{category,explanation}, usage?}`；
返回 `{text, usage?}`。

- delta 读取：`turnId`、`agentId`（区分主环路/子代理）、`isAborted`、`reason`；`text`/`answer` 不参与录制。
- delta 处理：`startTurn`/`completeTurn`（`delivery.ts:720-784`），详见 §1.7。
- **事件顺序契约**：`turn.start` 之后才可能收到该 turn 的输出行；`turn.complete` 必在
  `turn.start` 之后（aborted 也发）。但**迟到的 complete 可能在下个 turn.start 之后到达**：
  Delta 用 `nativeTurns`/`execution.turnId` 双重匹配，迟到的 complete 不会关闭新 turn
  （`delivery.ts:753-784`；契约测试 `register.test.ts:1605`）。

### 2.4 `prompt.submit`

输入（`index.d.ts:9736-9808`）：`{text, command?{name,args}, isMeta?, attachments?,
context?: string[], turnId?, wait: boolean, origin: PromptOrigin}`；
返回（`:9814-9840`）：`{text, context?, origin?}` 或 `{drop: reason}`。

- delta 读取：`text`、`turnId`（是否投递进运行中的 turn，steering 归属校验）、`isMeta`（间接，行层）、
  `origin`、`wait` 不用。
- delta 处理：`admitPrompt`（`prompt.ts:26-146`）。失败时 `register.tsx:152-161` 的 `.catch`
  返回固定 `{drop: 'Delta could not safely prepare this shared turn. Retry after the watcher is ready.'}`。
- `next` 语义：resolve 表示 prompt 已进入会话且其 turn 已开始（或被排队），不是 turn 结束。
  Delta 依赖这一点做 hand-off 本地 turn（`HANDOFF_PROMPT`→`HANDOFF_ACKNOWLEDGEMENT`）与
  `promptEntering` 状态。

### 2.5 `session.start` / `session.end`

- `session.start`（`index.d.ts:12609-12634`）：`{cwd, surface: RenderSurface|null, isInteractive}`；
  返回 `{cwd}`。delta 用 `$.session.version()` 做版本告警、注册命令、`activate`、`noticeStart`。
- `session.end`（`index.d.ts:11927-11955`）：`{reason: 'prompt_input_exit'|'clear'|'resume'|'logout'|'other',
  sessionId, resume}`；返回 `{sessionId}`。delta 用它清理 watcher/契约/标题 reader/子代理、
  `markEnded`（写 `endedAt` 供收尾清理）、释放 joiner。
- **注意**：`/clear`、`/resume` 不发 `session.start`，只发 `session.end`（reason clear/resume）；
  Delta 用 `successor` 变量 + 首个活动补判定（`activation.ts:181-260` 的 `sessionStarts/successor/decideStart/noticeSession`，以及 `:317-330` 的 `forgetSessionStart`）。DSH 若语义不同，
  需要适配层显式给出“新会话开始”的信号。

### 2.6 录制会间接依赖的其它事件

| 事件 | delta 用途 | 对录制的影响 |
| --- | --- | --- |
| `session.attach`/`session.detach` | Desktop 客户端加入/离开、hand-off | 流程层（task-2）；录制只用 `surfaces()` |
| `session.send` | 子代理/线程消息转发 | 子代理录制（task-2） |
| `command.run` | `/delta` 命令族 | 流程层 |
| `ui.render`（AbovePrompt/UserMessage/CommandOutput） | 状态带与 echo | UI 层（task-5） |
| `config.set`（theme） | 重绘状态带 | UI 层 |
| `session.compact`/`session.measure` 等 | 未注册 | 无 |

---

## 3. Host 方法语义清单

`Host` 定义在 `core/host.ts:14-58`；`hostOf` 绑定在 `register.tsx:56-140`。下表列出录制路径真正用到的
成员。DSH 侧逐项落点见 §5.0（来源 `research/dsh-host.md`）；本节只写 Delta 依赖的语义。

### 3.1 `session`

| 方法 | 签名/返回 | delta 用法与语义要求 |
| --- | --- | --- |
| `id()` | `Promise<string>` | 会话稳定 id；作为 store key `session:<id>`、CLI `--external-id`、线程身份。`/clear`/`/resume` 后变新 id。 |
| `cwd()` | `Promise<string>` | 当前目录，可被 `/cd` 改变；用于 transcript 路径、git root、joined 目录校验。 |
| `root()` | `Promise<string>` | 项目根（会话起点或 `/cd`/move 结果）；shell 里的 cd 不改变它。joined 校验要求 root 等于挂载目录。 |
| `turns()` | `Promise<number>` | 用户 turn 数；`===0 ? startup : resume`（`activation.ts:249`）。 |
| `surfaces()` | `Promise<readonly RenderSurface[]>` | 不 reject；`-p` 下为空。用于交互判定（join/share/menu/onboarding）。 |
| `version()` | `Promise<{version, base?, builtAt?}>` | 仅用于版本告警（`compatibility.ts`）；失败可忽略（`register.tsx:235`）。 |
| `messages()` | `Promise<SessionMessage[]>` | 行摘要：`{role,text,toolUses:[{tool_use_id,tool,input,result?,text?,isError?:true,agentId?}],toolResults?}`；snapshot 的结构化工具结果与 watch 账本用。 |
| `apiMessages()` | `Promise<ApiMessage[]>` | Anthropic Messages 形式（≤4096、已规范化、以 user 开头）；snapshot 的唯一来源。 |
| `append(args)` | `Promise<{message,uuid} 或 {deny}>` | 插件写自己的行（door=note）；Delta 用 `{type:'user'/'system', content: 文本块}` 写通知/echo；只有文本块，否则被拒。 |
| `agentMessages({agentId?})` | `Promise<SessionMessage[] 或 {deny}>` | 子代理行；`Array.isArray` 区分。 |
| `agentApiMessages(agentId)` | `Promise<ApiMessage[] 或 {deny}>` | 子代理快照。 |

错误语义：除 `surfaces()` 明确 never rejects 外，都可能 reject；delta 对 `version()`/`followTranscript`
做了 catch，其余失败走 hook 的 fail-open catch。

### 3.2 `fs` / `process` / `store` / `clock` / `env` / `ui` / `turn` / `plugin`

| 成员 | 语义要求（delta 依赖） | 录制调用点 |
| --- | --- | --- |
| `fs.read(path)` | 读文本；**>4MiB 拒绝**（`title.ts:100` 注释）；文件不存在 reject | outbox 读回、transcript 整读、plugin.json |
| `fs.write(path,text)` | 覆盖写，父目录不存在时行为需明确（delta 假定 outbox 目录已建） | outbox 落盘 |
| `fs.exists(path)` | boolean，不因不存在而抛 | transcript/挂载发现 |
| `fs.list(path)` | `{name,kind:'file'/'dir'/'other',size,mtimeMs,…}[]`；目录不存在 reject（调用方 catch） | outbox 清理、projects 目录搜索 |
| `fs.stat(path)` | `{kind,size,mtimeMs,isLink,realPath?}`；不存在的路径如何表现由实现约定（title 里会抛被 catch） | transcript 增量读、`endedAt` 判定 |
| `process.run(argv, {input?,env?,cwd?,timeoutMs?})` | 无 shell；返回 `{exitCode,stdout,stderr,isStdoutTruncated,isStderrTruncated}`；stdout/stderr 各 4MiB 截断；超时 reject | CLI 短命令、`git rev-parse`、`rm`/PowerShell |
| `process.spawn({argv,cwd?,env?,input?})` | 异步迭代器：`{stream:'stdout'/'stderr', text}` 流式块（UTF-8 不切断多字节），结束时返回 `{code,signal}`；`return({code,signal})` 杀进程；未读缓冲 1MiB | CLI 长命令/流（watch、mount、append 流、标题 tail） |
| `store.get/set/keys/delete` | 任意 JSON 值（Delta 存 Binding 对象、账本字符串）；`keys()` 可枚举（续接检测依赖）；跨进程持久 | binding、`appended:` 账本、`drawn:` |
| `clock.now()` | epoch ms | `endedAt`、时间比较 |
| `clock.after(ms,fn)` | 返回 `{cancel()}` 的定时器 | 重试、上传轮询 |
| `clock.sleep(ms,{signal})` | signal abort 时 reject（调用方靠它取消超时） | 所有超时控制（标题读取、命令超时、mount ready） |
| `env.get(name)` | Delta 用 `HOME`/`USERPROFILE`/`OS`/`CLAUDE_CONFIG_DIR`/`CLAUDE_CODE_REMOTE`/`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`；缺省 undefined | 数据目录、Windows 判定、execution_location、遥测开关 |
| `ui.log(text,{to:'debug'/'transcript'})` | 写日志/transcript；对录制**尽力而为**（多处 catch 忽略） | 失败提示、调试日志 |
| `ui.status(text/undefined)` | 状态带文字（undefined 清除） | `report()`（`session-state.ts:326`） |
| `ui.invalidate()` | 重绘插件的 `ui.render` 点 | 状态带刷新 |
| `turn.abort({turnId})` | 中止指定 turn；失败不应抛出致命错 | loseExecution、capture 失败 |
| `plugin.root` / `plugin.name` | 插件安装根目录/名字；`runningUpdate` 读 `<root>/.claude-plugin/plugin.json` 的 `version` 作为 `producer_version`（`delivery.ts:363-369`），名字用于过滤自己的 show 行 | producer_version |
| 全局 `crypto.subtle.digest`/`TextEncoder` | Web Crypto + UTF-8 编码 | outbox digest |

补充：`host.http.fetch`、`agent.*`、`command.*`、`settings.read({source:'policy'})`、`tool.call(TaskStop)`
不属于录制核心，属于安装/分享/子代理/更新流程（task-2/3）。

---

## 4. Delta CLI 调用清单与 JSON 校验

所有录制相关命令都经 `readCommand`/`runJson`（`cli/delta-cli.ts:94-183`）执行，argv 形如
`[executable, '--json', ...args]`，统一带 `DELTA_CLI_INTEGRATION=claude_code`（`delta-cli.ts:35`）。
**答案必须正好是一个 JSON 对象**，否则 `checkResult` 判为“不是当前 Delta CLI 的回答”
（`command-outcomes.ts:8-22`）。

| 子命令 | argv | 入口/超时 | 校验（代码） | fixture |
| --- | --- | --- | --- | --- |
| `thread contract` | `thread contract` | `delta-cli.ts:135`，30s（`:46`） | 自解析：`operation:'contract'` + `min<=max` 安全整数（`thread-commands.ts:425`）；非 0 退出且 stdout 空 → `undefined`（太旧） | `thread-contract.json` `{"min":8,"max":8}` |
| `thread status` | `thread status <thread> --source claude-code --external-id <session>` | `delta-cli.ts:246`，流式默认 120s | `parseThreadStatus`（`thread-commands.ts:345`）+ 严格字段校验（`:353-391`）：thread_id/url/title/access.state/visibility/upload/worktrees/producer | `thread-status.{local_only,granted,worktrees_unavailable}.json` |
| `thread create` | `thread create --source claude-code --external-id <id> [--organization <id> --visibility <v>] [--parent <ref> --name <n> [--shared-worktrees 或 --isolated-worktrees]]` | `delta-cli.ts:230`，120s | `validateCreationReceipt`（`command-outcomes.ts:31`）：`operation:'created'`、thread_id 非空、created 布尔；子线程另需 `reference` 非空（`subagents.ts:488-492`） | `thread-create.json`、`thread-create.child.json` |
| `thread append` | `thread append <reference> --source claude-code --external-id <producer> [--acknowledge local] --producer-name "Claude Code"`，stdin=JSONL | `delta-cli.ts:384`，120s | 每行 `parseAppendReceipt`（`thread-commands.ts:543`）：thread_id/sequence 匹配、next_sequence>sequence、duplicate 布尔、version 非空、operation、disposition ∈ recorded/fenced/duplicate、turn_sequence null 或 1..sequence；前缀匹配 + turn_sequence 一致（`outbox.ts:24-42`） | `thread-append.{recorded,fenced,duplicate}.json`、`thread-append.batch.jsonl` |
| `thread share` | `thread share <thread> --visibility organization` | `delta-cli.ts:254` | `validatePublicationReceipt`（`command-outcomes.ts:95`）：operation/thread_id 一致、url 是安全 web link | `thread-share.json` |
| `thread invite` | `thread invite <thread> -- <emails…>` | `delta-cli.ts:264` | `threadInvitationsFrom`：url + results | `thread-invite.json` |
| `thread fork` / `thread discard` | `thread fork <thread>` / `thread discard <thread> --force` | `delta-cli.ts:358/363/368` | fork：`{thread_id}`；discard：`checkResult` | — |
| `thread mount` | `thread mount <locator> --owner <owner> [--join]`（长驻，首行 ready） | `delta-cli.ts:334`，600s ready | `parseThreadMount`（`thread-commands.ts:508`）：operation/thread_id/owner/directory/worktrees | `thread-mount.json` |
| `thread watch` | `thread watch <reference> [--source claude-code --external-id <id>] [--participate "Claude Code"]`（长驻，每行事件） | `delta-cli.ts:406-449`，行上限 16MiB | `parseWatchEvent`（`thread-commands.ts:235`）：未知 type 跳过、已知 malformed 报错；error 信封抛出 | `thread-watch.frames.jsonl` |
| `worktree list` | `worktree list` | `delta-cli.ts:461` | `localWorktreesAt`/`checkoutStillSyncing`（`command-outcomes.ts:66/79`） | `worktree-list.json` |
| `worktree create` | `worktree create <directory>` | `delta-cli.ts:466` | `validateWorktreeCreationReceipt`（`command-outcomes.ts:43`）：`reference===worktree_id` | `worktree-create.json` |
| `worktree attach` | `worktree attach <reference> --thread <thread>` | `delta-cli.ts:475` | `validateWorktreeMembershipReceipt`（`command-outcomes.ts:52`） | `worktree-attach.json` |
| `worktree mount` | `worktree mount <reference> <directory> --existing-checkout`（长驻，首行 ready） | `delta-cli.ts:487`，600s ready | `validateAttachmentReceipt`（`command-outcomes.ts:88`）：operation/reference/directory 一致 | `worktree-mount.json` |
| `auth status`（JSON） | `auth status` | `delta-cli.ts:220`，120s | `account.login` 可选 | — |
| `auth`（交互） | `auth status`/`auth login --no-wait`/`auth wait <login_id>` | `cli/auth.ts:73-140`，60s/16min | 退出码 0 或（1 且 stdout 有 `status`）视为合法；`status` ∈ signed_in/signed_out/signing_in/access_denied/pending；失败信封优先 | — |
| `org list/current/switch/invite` | 非 `--json`，直接人类可读 stdout | `delta-cli.ts:184-204`，120s | 只看退出码/空/截断 | — |
| `update` | `update [--check 或 --download-only] --json` | `cli/install-update.ts:148`，5s/600s | `parseInstallUpdate`（`:46`）：schema_version=1、status 枚举、版本/渠道/install_argv 校验 | — |
| 发现/安装 | `sh -c <discover>`、`sh -c <install>`；Windows `where.exe`/`reg.exe`/PowerShell | `cli/cli.ts:12/36/97`，30s/600s | 路径必须是绝对路径且无换行/NUL（`cli.ts:71-110`） | — |

通用约定：

- 长驻命令（watch/mount）用 `process.spawn` 流式读；短命令用 `process.run`（4MiB 捕获上限，
  截断标志视为失败，绝不假设成功）。
- 所有 CLI 错误信封见 `error-codes.json`：`{code, message, reason?, retryable?, retry_after_ms?}`。
  录制命令的每个已发布 code 都应带 `retryable`；`reason` 只用于日志与文案，**不能**用来分支行为
  （`thread-commands.ts:130-149`, `:170-176`）。
- 任何 stdout 截断都不算确认（`checkResult`、`appendFailure`、watch 读取都是这个原则）。

---

## 5. DSH 适配难点清单

> 已对照 `research/dsh-host.md`（task-4，DSH 0.2.2-rc.1 实测）。**核心结论：DSH 没有
> `session.append` 这种“逐行、可改写”的入口**。`session/event` 是 post-commit 的 `emit`
> （fire-and-forget、监听器抛错被吞、不能新增事件类型、不能改写已提交行，见 dsh-host §2.2/§2.3）。
> 所以移植的关键不是换 hook 名，而是**新增一层“行投影”（row projection）**，把 DSH 的
> SessionEvent 还原成 Delta 需要的 `message/door/origin/uuid/agentId`。其余 Host 原语都有对应物，
> 标题甚至比 Claude 更直接（DSH 有 `session/title` 事件与服务）。

### 5.0 delta 概念 → DSH 落点（总表）

| Delta 依赖 | DSH 事实（出处） | 适配方式 |
| --- | --- | --- |
| `session.id()` | `agent.session.id`（dsh-host §7） | 直接映射；binding key 用 sessionId |
| `session.cwd()` / `root()` | `ctx.workingDirectory.get(session)` / `session.header.cwd` | 直接映射；`working-directory/change` 事件追踪变化 |
| `session.turns()` | `ctx.agents.turnBoundaryOf(session)`，或 fold `turn/start`/`turn/end` | fold 事件计数即可（录制只用来判 startup/resume） |
| `session.version()` | 无会话修订号；`session.header.version` 是格式版本（=4），`session.seq` 是单调水位 | 版本告警改用 DSH 自身版本；勿把 header.version 当修订号 |
| `session.messages()` | `session.deriveMessages()`（模型可见历史）或 `ctx.sessionQuery.readSession`；`session.toolHistory()` | 投影成 Delta 的 `SessionMessage` 摘要（toolUses） |
| `session.apiMessages()` | `session.deriveMessages(): Message[]`（深冻结） | 投影成 Anthropic 风格 `ApiMessage`（snapshot 用） |
| `session.append()` | **不可实现**：不能新增 SessionEvent 类型；`Session.append` 只接受既有 surface 类型 | 去掉写回通道；插件自己的行放 KV/Client 渲染（`/delta show` 受影响，见 D1） |
| `session.surfaces()` | **无对应**（单一 Web UI） | 交互判定改 `ctx.get('webApp')`/preset；录制不依赖 |
| `session.agentMessages/agentApiMessages` | `ctx.subagents.listChildren(parentSessionId)` + child session 读取 | 子代理录制见 D14 |
| `tool.call`（结构化 result） | `tools/pre-execute`/`tools/execute`/`tools/post-execute` waterfall + `tools/result`；`ToolExecution` 有 `callId/name/arguments(已解析)/agent`，结果有 `value/content/meta?` | `tool/result.meta`（JSON）映射为 Delta structured result；错误取 `isError/error` |
| `turn.start` / `turn.complete` | `turn/start {turn}` / `turn/end {turn, reason: TurnEndReason}` | turnId = `String(turn)`；reason 映射见 D1 末段 |
| `prompt.submit`（门禁/drop） | `agent/pre-step` waterfall 可改/拒绝消息（`PreStepDecision`），`agent/inbox/inserted/claimed` 是 emit | 用 pre-step 或 inbox 事件近似门禁；drop 文案保留 |
| `ui.status` / `ui.log({to})` | **Host 无 API**（dsh-host §7/§8） | 状态带/通知改 Client 半边（task-5）；日志降级 `ctx.logger` |
| `ui.invalidate()` | projection `wire.view` 引用变化自动推送 | 换机制 |
| `process.run` | **`ctx.subprocess` 只有 `spawn`**（dsh-host §5.2/§8.6） | 封 helper：spawn + collected + 显式 `graceMs`/`AbortSignal`（服务不提供 timeout） |
| `process.spawn` | `ctx.subprocess.spawn` 原始 `stdout/stderr` Readable + `terminate()` + `done` | 直接映射；argv 从不经 shell（`sh -c` 需显式传） |
| `store.{get,set,delete,keys}` | `ctx.storageDomain.open(spec)` → `KvTable.get/put/delete/deleteMany/keys/entries/size`（值整体替换、先落盘再 emit） | 建一个 domain（如 `delta/sessions`）：table key=sessionId，value=Binding JSON |
| `turn.abort` | `agent.cancel({kind:'user'})` | 映射；注意“保留排队输入”用 `keepInbox` |
| `tool.stopTask` | `ctx.subagents.interrupt(...)` / `ctx.terminals.kill` | 流程层映射 |
| `plugin.root/name` | `import.meta.url` 推算；版本取 bundle `package.json` | 替换 `runningUpdate` 的清单读取 |
| `env.*` | `process.env` / `os.homedir()` / `process.platform` | 数据目录改用 DSH profile 目录（如 `DSH_PROFILE_DIR`），不要写 Claude 目录 |
| 插件私有文件（outbox） | `ctx.fs` 是“模型可见 FS”（不透明 target + 沙箱 + 版本守卫）；插件私有文件宜用 `node:fs`（dsh-host §5.3） | outbox 用 `node:fs` + 插件数据目录；`fs.read` 的 4MiB 限制由适配层自己实现 |
| 标题 | `session/title` SessionEvent（latest-wins）+ `ctx.sessionTitle.get/rename/refresh`（dsh-host §2.3/§5.9） | 直接用，不需要 transcript |

### D1. 行投影层（替代 `session.append`，最关键）

- **DSH 事实**：`session/event` 是 post-commit `emit`，listener 同步 fire-and-forget、异常被吞；
  事件不可改写；`Session.append` 只接受既有 surface 类型，插件不能新增类型（dsh-host §2.2/§2.3）。
- **Delta 所需**：每条会话行在落盘时带 `message/door/origin/uuid/agentId`，并可选择录/不录。
- **适配方案**：新增 `rows.ts`（DSH 侧唯一新增模块），把 SessionEvent 投影成 Delta row：

  | DSH SessionEvent | delta door | delta message |
  | --- | --- | --- |
  | `user/message`（`source.kind==='user'`） | `prompt`（命令行为 `command`） | `{type:'user', role:'user', content: content}` |
  | `user/message`（synthetic source：注入上下文/skill/cron） | `delivery` 或 `hook-context` | 按 source.kind 判定 |
  | `assistant/message`（`message: AssistantMessage`） | `response` | `{type:'assistant', role:'assistant', content}` |
  | `tool/call`（`callId/name/arguments` 原始 JSON 字符串） | （`response` 里的 tool_use） | `tool_use` block；id=callId |
  | `tool/result`（`message` + `error?` + `meta?`） | `tool-result` | `tool_result` block；结构化结果取 `meta`/`value` |
  | `command/run` + `command/done` | `command` | 合成 caveat/echo/output 文本（Delta 的 command door 只读文本块） |
  | `system/message` / `developer/message` | 无（丢弃） | Delta 不录 notice/attachment 之外的系统行；若需要映射为 `notice`/`hook-context` 再按 capturedMessage 过滤 |
  | `compaction/*` | `compaction`（丢弃） | Delta 不录 |
  | `turn/start` / `turn/end` | （不产生 row） | 驱动 turn 生命周期（见 D1 末段） |

- **uuid**：DSH 每事件有会话内单调 `seq`，用 `${event.type}:${event.seq}` 作为稳定行 id
  （比 mint UUID 更好）；surface 事件的 `surfaceOp:{op:'replace',startSeq,endSeq}` 会替换区间，
  **投影层应忽略 replace 事件**（Delta 的 door 过滤本来就不录 compaction），只处理 `append`。
- **失败模式**：若投影层按事件顺序处理，Delta 的 `heldRows`/turnSequence 逻辑仍成立；若 DSH 事件
  批量到达，按 `seq` 排序即可。
- **turn 生命周期映射**：`turn/start {turn}` → Delta `turn.start`；`turn/end {turn, reason}` →
  `turn.complete`，`turnId = String(turn)`。DSH 的 `TurnEndReason` 比 Delta 的 stopReason 多：
  `{kind:'completed'}`→`end_turn`、`{kind:'aborted'}`→`cancelled`、`{kind:'error'}`→`error`；
  `blocked`/`max-tokens`/`interrupted`/`forked` 无对应值 → 省略 stopReason（Delta 允许省略）。
  DSH 没有 agentId 概念的主/子会话区分靠“事件来自哪个 Session”判定。
- `/delta show` 的行改写（`shownCommandRewrite`/`storeShownRow`）**不可实现**（不能改已提交行）；
  选项：去掉该功能，或把 echo 放到 Client 半边渲染（task-5）。风险：中-高（但要重写的只是入口层，
  `recording/*` 的转换与 outbox 逻辑不变）。

### D2. `door` 由投影层判定

- Delta 依赖 12 值 door 决定录不录、录什么（`content.ts:9-37`）；`command` door 要 bashMarkdown，
  `tool-message` door 要用 origin.tool 过滤 Skill。
- DSH 没有 door，但事件类型 + `user/message.source.kind` + `tool/result.error` 足以推出上表；
  **建议把 door 判定写成纯函数并单测**（表驱动，覆盖每个事件类型）。
- 风险：中（判错=漏录/多录；`command` 判错会丢掉 bash 行）。

### D3. `uuid` / `messageId`

- Delta 依赖：`uuid` 仅用于 `messageId` 前缀（`<uuid>:message:<i>` / `<uuid>:thought:<i>`）、
  `storeShownRow` 的 key、重放去重（同一显示行不画两次）。
- **交付正确性不依赖 uuid**（幂等靠 sequence/receipt），所以用 `${type}:${seq}` 足够；
  snapshot 行继续用 `snapshot:<i>`。
- 风险：低。

### D4. snapshot：需要把 DSH 历史投影成 `ApiMessage`

- Delta 依赖：`apiMessages()`（≤4096、已规范化、user 开头）+ `messages()` 的 `toolUses[].result`。
- DSH 有 `session.deriveMessages()`（模型看到的历史，深冻结，每次新数组）和
  `ctx.sessionQuery.readSession/readSurface`（历史/冷读）；工具摘要可用 `session.toolHistory()`
  或 `tool/call`+`tool/result` 事件配对。
- 适配：投影层写 `Message[] → ApiMessage[]`，并遵守 Delta 的 4096 条/去 framing 规则；
  DSH 的注入行如果是 `user/message` 的 synthetic source，**必须按 source 过滤**，否则 snapshot
  会把注入上下文当用户输入导出。
- 风险：中（有等价物，工作量在投影质量；显式 share 的历史导出仍是产品风险）。

### D5. checkout 校验依赖目录语义

- Delta 依赖：`root()/cwd()` 与 `/cd` 语义、`git rev-parse --show-toplevel`、`thread status` 的
  worktrees 绝对路径匹配、joined 会话必须“Claude 在挂载目录内”。
- DSH：`session.header.cwd`（不可变原始目录）≈ root；`ctx.workingDirectory.get/set` ≈ cwd；
  git 用 subprocess helper。joined/checkout move 属于 task-2 的 join 流程。
- 风险：中（目录语义不一致会导致 verifyCheckout 永久 pause）。

### D6. 标题：可直接移植（比 Claude 更简单）

- DSH 有 `session/title` SessionEvent（latest-wins）和 `ctx.sessionTitle`
  服务（`get/rename/refresh`，provider 支持 first-prompt/all-prompts 自动标题，dsh-host §5.9）。
- 适配：监听 `session/title`（或每 turn 结束 `ctx.sessionTitle.get(session)`），沿用
  `recordTitle` 的“变化才写、非 joined、`session_info_update`、去重”逻辑；
  `TitleScanner`/transcript 增量读取整段删除。
- 风险：低（§0 原“无法移植”的判断据此修正）。

### D7. 会话续接 / fork

- DSH 有 `SessionHeader.parentSession`、`session.fork(source, boundary?, childSessionId?)`、
  `session/end-seed {inherited?: true}`、`agent/created source:'startup'|'resume'|'clear'|'compact'`、
  `turn/end reason {kind:'forked'}`。
- 适配：把 Claude 的 `continued-in` transcript 检测替换为 `parentSession`/fork 事件；若把 fork
  后的会话当同一 Delta producer 续录，需与 Delta 服务端确认（同一 external_id 换 sessionId 可能
  被 frontier 校验拒绝）。建议第一版：fork = 新 producer，不继承 outbox。
- 风险：中（协议归属决策）。

### D8. 工具名与结果 schema

- DSH `tool/call` 的 `name/arguments`（arguments 是模型产出的原始 JSON 字符串）与 `tool/result` 的
  `message/meta/error` 和 Claude 的 `tool_use`/结构化 result 不同；`tools/post-execute` 可改写结果。
- 适配：在 `content.ts` 的 `toolInfo`/`editDiff` 前加一层 `dshToolInfo(name, args)` 与
  `dshResult(name, meta)`；把 DSH 的 `meta`（工具私有展示载荷，JSON）当 Delta structured result。
  否则录制可跑但 title/kind 退化、没有 diff。
- 风险：中（可见质量，不影响正确性）。

### D9. 分发模式、hook 预算与后台任务

- DSH：`session/event` 是同步 fire-and-forget emit（不能阻塞、不能拒绝）；`agent/created` 是
  `serial` 且监听器被 await（抛错会让创建失败）；`tools/*` 是 waterfall（不接管必须 `next()`）；
  `agent/pre-step` 可 reject。定时器 `ctx.timeout/interval` 是 disposable，**随 ctx 回收**。
- 适配：Delta 的“hook 返回后继续异步”（drain、settleRemote、share snapshot）在 DSH 要挂在
  **插件级 ctx** 上（不能用某个 hook 的临时 ctx）；需要门禁/拒绝的地方（prompt.submit drop）
  放 `agent/pre-step` 的 `PreStepDecision`（注意 reject 的语义是拒绝该 step）。
- 风险：中（影响投递及时性与 prompt 门禁；outbox 已持久化，不丢数据）。

### D10. 插件清单与身份

- DSH 插件是 bundle（`cordis.patch.yml` + Host/Client 入口），没有 `.claude-plugin/plugin.json`；
  `producer_version` 改读 bundle `package.json` 的 version；`plugin.root` 用 `import.meta.url` 推算。
- `DELTA_CLI_INTEGRATION=claude_code` 是否改成 `dsh` 需实测 Delta CLI 是否接受未知值
  （dsh-host §8.9；flows-port §10.4 也列为决策）。
- 风险：中。

### D11. `surfaces/turns/version`

- 录制侧只需 `turns()` 的 startup/resume 判定（可用 fold `turn/start`）；`surfaces()` 的交互判定
  改 `ctx.get('webApp')`/preset；`version()` 只做告警，换成 DSH 版本或删。
- 风险：低。

### D12. 协议身份（硬约束，与 DSH 无关）

- 必须保留：`--source claude-code`、`thread status` 的 `producer.source==='claude-code'` 校验
  （`thread-commands.ts:565-580`）、契约 `[8,8]`（`:402-408`）、`CHILD_CONTRACT_VERSION=7`、
  `--producer-name 'Claude Code'`（展示名，可改但要同步 `watch --participate`）。
- DSH 插件仍以子进程调 Delta CLI，所以伪装成 `claude-code` 是纯协议问题，不涉及 DSH API。
- 风险：高（改错则完全无法录制）。

### D13. 原语差异（都有方案，但都要写适配）

- `subprocess` 没有 `run`：封 helper（B 形态 collect + `maxBytes` + `readFrom(0)`），超时自己用
  `AbortController` + `graceMs`；`argv` 从不经 shell，`sh -c <script>` 要显式写。
- `ctx.fs` 是模型可见 FS（不透明 target、沙箱、版本守卫）→ outbox 用 `node:fs` + 插件数据目录；
  `fs.read` 4MiB 限制、`stat` 形状由适配层自己保证。
- `storageDomain` 的 `KvTable` 值整体替换、domain 有 version/schema（zod）；Delta 的 Binding 是对象，
  建议 table key=sessionId，value=Binding JSON；`keys()`/`entries()` 满足续接与 prune。
- `crypto.subtle`/`TextEncoder`：Node 运行时天然有。
- 风险：中（store/fs 已有明确落点，工作量大但可预期）。

### D14. 子代理（agentId）

- DSH 的子代理是独立 child session：`ctx.subagents.listChildren(parentSessionId)`、
  `subagent/start|end` 事件；`session/event` 按 `Scoped<Session>` 过滤，**子会话的事件要在
  `subagent/start` 后挂到对应 agent/session 的 ctx 上**。
- 适配：每个 recorded child 对应一个 Delta child thread（`thread create --parent`），
  externalId=child session id；行投影同样适用。工作量高于主会话，建议二期。
- 风险：中-高。

### D15. 测试资产与第三方插件限制

- `hooks/testing/fixtures/cli/*`（21 文件）与 `fake-thread-commands.ts`（1916 行 fake CLI）
  可直接复用：DSH 侧测试只需替换测试宿主，把 fake 的 `operations()/records()/store/files/
  appendFaults` 保留。
- DSH 第三方插件**不能 `import @deepseek-ai/*`**（只能 `import type` + devDependency，dsh-host §8.1），
  delta-dsh 必须打成运行时零官方依赖的 bundle；单测用 vitest/node 自带即可。
- `register.test.ts` 的录制契约断言（见 §5 D15 行号索引）应逐条移植为 DSH 测试。
- 风险：中（测试基建工作量）。

### D16. 路线选择：原生插件 vs `claudeCodeMods` 桥

- DSH 已加载一个 Claude Code mod 兼容桥（`claudeCodeMods`，flows-port §10.3），提供
  `session.start/end`、`prompt.submit`、`turn.start/complete`、`tool.call`、`command.run`、
  `ui.render` 与 `session{id,cwd,root,turns,messages…}`。
- **但桥没有 `session.append`/`session.send`/`session.attach`，也没有确认 `fs/process/store/clock/
  agent.spawn`**（ModsApi 字段被截断未验证）。也就是说：**即使走桥，行投影层依然必须写**，
  而录制依赖的 CLI/进程/fs/store 仍需原生服务。
- 建议：**原生 DSH Host 插件 + 行投影层**（task-4 结论一致）；`claudeCodeMods` 只用于 UI 桥的
  可行性对照（task-5）。风险：中（路线决策）。

### D17. 实现前必须核对的未知点

- `claudeCodeMods` 的 `ModsApi` 是否真的提供 `fs/process/store/clock`（决定“薄适配”是否可行）。
- Delta CLI 是否接受 `DELTA_CLI_INTEGRATION` 的非 `claude_code` 值、`--producer-name` 任意值
  （D10/D12）。
- DSH 在 Windows 上的支持范围（决定 `windows-install.ts`/PowerShell 分支去留）。
- `session/title` 的节流与 latest-wins 频率（标题去重逻辑要适配）。
- `tools/post-execute` 改写 `value/meta` 对 `tool/result` 事件的可见性（决定 structured result 来源）。
- storageDomain 是否允许同一 domain 多会话并发写（Delta 需要 `serial()` 级别的写串行化）。

## 6. 文件级复用结论

图例：**原样** = 不改逻辑，最多改 import/类型名；**小改** = 数据源或少量常量/映射；**重写** = 语义不同；
**删除** = DSH 无对应物。

| 文件 | 行数 | 结论 | 原因 / 改动点 |
| --- | --- | --- | --- |
| `hooks/core/host.ts` | 58 | **改** | 保留为 seam；把 Claude 类型换成 DSH 类型（或保留结构、只换实现）。 |
| `hooks/core/binding.ts` | 21 | 原样 | 纯校验逻辑。 |
| `hooks/core/session-state.ts` | 397 | 小改 | 只依赖 `Host.store/clock`；`HookEvent/HookNext` 类型来源换 DSH。 |
| `hooks/core/json.ts` / `text.ts` / `paths.ts` | 37/11/20 | 原样 | 纯函数。 |
| `hooks/core/transcript.ts` | 54 | **删除** | 完全基于 Claude transcript 路径约定；DSH 无会话文件可读。 |
| `hooks/core/compatibility.ts` | 22 | 改 | Claude 版本下限 → 可选删除，或换成 DSH 版本要求。 |
| `hooks/recording/content.ts` | 351 | 小改 | `capturedMessage`/`messageUpdates`/`blocks` 原样；`toolInfo`/`editDiff`/`OMITTED_TOOLS` 需按 DSH 工具名与结果 schema 加映射。 |
| `hooks/recording/delivery.ts` | 895 | 小改 | 逻辑原样；`HookEvent/HookNext` 类型换名；`plugin.json` 路径、`CLAUDE_CODE_REMOTE` 语义可按 DSH 调整。 |
| `hooks/recording/outbox.ts` | 110 | 原样 | 纯函数 + 平台删除命令。 |
| `hooks/recording/snapshot.ts` | 36 | 原样 | 输入就是 `ApiMessage[]`；framing 过滤可保留作兜底。 |
| `hooks/recording/tool-records.ts` | 61 | 原样 | 纯配对状态机。 |
| `hooks/recording/delivery-policy.ts` | 26 | 原样 | 纯策略。 |
| `hooks/recording/bash.ts` | 38 | 原样 | 纯文本转换。 |
| `hooks/recording/title.ts` | 210 | 小改 | 去重/`cleanTitle`/`recordTitle` 逻辑保留；transcript 扫描（`TitleScanner`/tail/PowerShell/`readFrom`）删除，数据源换 DSH `session/title`/`ctx.sessionTitle`（§5 D6）。 |
| `hooks/recording/prompt.ts` | 146 | 小改 | 门禁逻辑原样；hand-off/continuation/join 分支依赖流程层，DSH 无等价则删/简化。 |
| `hooks/cli/cli.ts` | 161 | 原样 | CLI 发现/安装与宿主无关；仅 `process.run` 语义需一致。 |
| `hooks/cli/delta-cli.ts` | 527 | 小改 | 原样；`CONTRACT_TIMEOUT_MS`/`MOUNT_TIMEOUT_MS` 可调；`plugin.root` 读清单路径改 DSH。 |
| `hooks/cli/thread-commands.ts` | 580 | 原样 | 纯协议解析/校验；常量（契约版本、PRODUCER_NAME）需 Lead 决策。 |
| `hooks/cli/command-outcomes.ts` | 106 | 原样 | 纯校验。 |
| `hooks/cli/command-reader.ts` | 131 | 原样 | 依赖 spawn 流形状（需适配层一致）。 |
| `hooks/cli/auth.ts` | 165 | 小改 | 依赖 `ui.ask`/`process.spawn`/`clock.sleep`；DSH 有等价即可原样。 |
| `hooks/cli/install-update.ts` | 282 | 小改 | `delta update` 部分可留；Claude 插件自更新部分由 DSH 机制替代。 |
| `hooks/cli/windows-install.ts` | 72 | 原样 | PowerShell 安装脚本。 |
| `hooks/setup/activation.ts` | 801 | 大改 | capture boundary + snapshot binding + activate/drain 骨架保留；transcript/continuation（改 `parentSession`/fork）/handoff（DSH 无）/自动策略重写或删。 |
| `hooks/sharing/share.ts`（snapshot 段） | 第 138-190 行 | 小改 | 依赖 `apiMessages()/messages()`；DSH 若提供等价则原样。 |
| `hooks/register.tsx` | 340 | 改 | 保留 hook 分派结构；`hostOf` 换 DSH 实现；事件名改 `ctx.on('session/event' / 'agent/*' / 'tools/*' / ...)`；`ui.render` 三处另做（task-5）。 |
| （新增）`delta-dsh/src/rows.ts` | — | **必写** | 行投影层：DSH SessionEvent → Delta row（message/door/origin/uuid/agentId）+ turn 生命周期事件；这是替代 `session.append` 的核心新代码（§5 D1）。 |
| （新增）`delta-dsh/src/host.ts` | — | **必写** | `core/host.ts` 的 DSH 实现：session/fs/process/store/clock/env/ui/turn 映射（§5.0）。 |
| （新增）bundle 入口 + `cordis.patch.yml` | — | **必写** | Host bundle 清单；可选 Client 半边（band/echo，task-5）。 |
| `hooks/testing/fixtures/cli/*` | 21 文件 | 原样 | 协议 fixture，直接复用。 |
| `hooks/testing/fake-thread-commands.ts` | 1916 | 小改 | fake 引擎测试宿主部分换掉；fake CLI 部分复用。 |
| `register.test.ts` / `recording/*.test.ts` | 173KB+ | 重写/移植 | 测试宿主从 `claude-code/testing` 换成 DSH 测试宿主；断言可大部保留。 |

---

## 7. 需 Lead 决策的点

1. **协议身份**：DSH 插件是否继续以 `--source claude-code`、`DELTA_CLI_INTEGRATION=claude_code`、
   `PRODUCER_NAME='Claude Code'` 录制？建议保留 source/integration（Delta CLI 的 producer 校验只认
   `claude-code`，`thread-commands.ts:565-580`），仅把展示名改为 “DeepSeek Harness”（需实测 CLI
   不校验该值）。改动会使整套 CLI 调用失效。（§5 D12）
2. **移植路线**：原生 DSH Host 插件 + 行投影层（推荐）还是走 `claudeCodeMods` 桥？桥没有
   `session.append`，且 `fs/process/store/clock` 未确认，走桥仍要写投影层并另找原语；
   flows-port §10.3/§10.4 同结论。（§5 D16）
3. **`/delta show` 的行改写**：DSH 不可能改写已提交事件。选择：去掉该功能（show 行以原样留存），
   或只在 Client 半边渲染 echo、不写回会话。（§5 D1）
4. **标题**：已确认 DSH 有 `session/title` + `ctx.sessionTitle`，建议直接映射（无需退化到首条
   prompt）。只需决定是否把 DSH 的自动标题（first-prompt/all-prompts）当 Delta 标题。
   （§5 D6）
5. **会话续接/fork**：DSH 有 `parentSession`/`session.fork`/`agent/created source`。是否让 fork
   后的会话继承同一 Delta producer/outbox（可保持一条 thread），还是每个会话独立 producer？
   这会影响 Delta 服务端的 frontier 校验（同一 external_id 换 sessionId）。（§5 D7）
6. **工具映射**：把 DSH 工具名/结果映射成 Claude 形状（Edit/Bash/Read…）以复用
   `toolInfo`/`editDiff`，还是给 DSH 写新的 title/kind/diff 映射？建议前者（工作量小、结果稳定）。
   （§5 D8）
7. **子代理录制**：第一版是否只做主会话录制，子代理（child session）留到第二阶段？（§5 D14）
