# DSH Web UI 侧：输入框上方状态带与会话行渲染

目标：给 delta-dsh 的 DSH Web Client 半制定可直接实现的方案——把 Claude Code 的
`AbovePrompt` 状态带（`hooks/band/band.tsx`）与必要的会话行搬到 `conversation.input.dock`
等 slot；并回答「能否直接复用 `dsh-experimental-client-ui-claude-code-mods`」。

环境：DeepSeek Harness 0.2.2-rc.1 Desktop，profile `desktop`，GUI `http://127.0.0.1:64350`。
证据来源分三类，文中用 `[asar]`、`[npm:<pkg>]`、`[inspect]` 标注：

- `[asar]`：`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/...`
  （用 `ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"` 读，见 §6.4）
- `[npm:<pkg>]`：`cd /tmp && npm --cache /tmp/npmcache pack @deepseek-ai/<pkg>@0.2.2-rc.1` 解包的 README / `.d.ts`
- `[inspect]`：`cordis_inspect_query`（host Service/Event/Config；client 侧本环境不可用，见 §6.1）

---

## 0. 结论（先看这里）

1. **状态带放在 `conversation.input.dock`**：这是 ui-conversation 声明的「Full-width entries above
   the composer card」列表 slot（`kind: list`，`scope: session`）。它正是 Claude Code
   `AbovePrompt` 的对应位置；`conversation.composer.dock` 是**输入框卡片下方**的环境条（统计
   pill 用），不要放状态带。
2. **Client 侧自研一个小插件是对的**：一个 `conversation.input.dock` entry + 一份 band 渲染组件，
   约 300–500 行。`@deepseek-ai/dsh-experimental-client-ui-claude-code-mods` **不能直接复用**
   （§5）：它只为 bridge 的 `claudeCodeMods` Remote 服务渲染 `Box/Text/Button` 序列化树，绑定在
   `@deepseek-ai/dsh-experimental-claude-code-mods` 上，而这个 bridge 本 profile 并未组合；它的事件
   词汇（无 `session.append`）也接不住 delta 的 hooks。可以**抄它的协议与渲染器**（MIT），不安装它。
3. **Host→Client 状态没有免费通道**。band 的内容（连接状态、share 链接、presence、conflict、
   update 提示、spinner）是插件内存态，不是 session log 的纯函数，因此 **session projection
   (`wire.view`) 承载不了它**；必须走一条自有 Remote 命名空间（与 forge / claude-code-mods /
   goal 同构），或者退化为命令 + 投影的混合方案。推荐：
   - **A（推荐）**：自有 Remote `deltaUi`：`watchBand(sessionId)` 流 + `pressBand(sessionId,
     generation, actionId)`；client 用 `ctx.remote.$mount()` 挂手写/生成的贡献，slot 里订阅流。
   - **B（无构建工具的兜底）**：Host 用 `bindTypertRemote` + 手写 marker 描述符（Gateway SRC 模式）
     或 `ctx.typert.register()` 手写 strict 贡献；Client 贡献手写（照抄 ccmods 内联的
     `createTypertRemoteInfo` 形态）。
   - **C（临时过渡）**：按钮走 `ctx.remote.commands.execute(sessionId, '/delta <action>', [])`
     + Host `ctx.commands.register()`；代价是每次点击向 session log 写 `command/run`/`command/done`，
     会话里出现 command 行。
4. **按钮不经过 DOM 事件跨进程**：按下时 client 拿 slot props 的 `sessionId` 调 Remote（或 command），
   Host 用 `lookup: 'agent'` 由 sessionId 解析 live Agent；失败用 `RemoteResult` 的 `{ok:false,error}`
   渲染成 band 下方一行 notice（照抄 ccmods 的 `press.failed` 做法）。
5. **会话行渲染**：轻量做法是 `conversation.chat.turnTail`（Turn 级）和 `conversation.chat.user.before`
   （用户消息来源徽标）；要新增真正的行必须 `ctx.uiConversation.events.register()` 注册一个
   `ConversationNodeDefinition`，再把视图注册进 `conversation.chat.node` 的 `key = kind`（§1.6）。
6. **主题/locale/清理**：只用 `--dsw-alias-*` token；文案走 `ctx.locale.register(ns, {zh,en,...})`
   + register 选项 `locale: ns` 得到 `t`；样式可以随 bundle 注入 `<style data-plugin-css>`（会随
   HMR/卸载移除），或组件内 style；资源一律 `ctx.effect()` 注册，返回清理函数。
7. **需要 Lead 拍板的点**见 §7.5：接受 2 个实验包依赖吗、走 Remote 还是先命令过渡、band 协议用
   序列化树还是 typed view model、client 用纯 JS 单文件还是走 TS 构建。

---

## 1. Client 插件机制

### 1.1 包清单与 `dsh.client` 字段

一个 Web UI 插件 = 一个 bundle 包（`dsh.bundle.patch` 提供 Cordis 行）+ 一个 `./client` 浏览器
bundle。manifest 解析器在 `@deepseek-ai/dsh-client-modules/lib/client.js`（`parseDshClient`），字段只有：

| 字段 | 必填 | 类型 | 含义 |
|---|---|---|---|
| `dsh.client.platform` | 是 | `string`（用 `'web'`） | 浏览器平台声明 |
| `dsh.client.immediately` | 否 | `boolean` | 是否在 boot 时随应用 combo 一起加载；`false` 时按需懒加载 |
| `dsh.client.inject` | 否 | `string[]` | **只用于激活排序**（宿主包名），不是模块 import |
| `dsh.client.external` | 否 | `string[]` | 基座模块表之外的**精确** `require(...)` 请求，每条由某个动态包 row 或静态表键提供 |

相关顶层字段：`dsh.bundle.patch`（`./cordis.patch.yml`）、`exports["./client"]`（浏览器入口）、
`exports["./typert"]`（Host 反射产物，loader 自动注册）、`exports["./remote"]`（Client 侧自动生成的
Remote 贡献）、`exports["./locale/*.json"]`、`exports["./icon"]`、`exports["./assets/*"]`。

模板（`[asar] dsh-agent-preset/skills/cordis-plugin-development/templates/decoration/package.json`）：

```json
{
  "name": "@local/my-decoration",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg"
  },
  "files": ["index.js", "client.js", "cordis.patch.yml", "locale/*.json", "icon.svg"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": ["@deepseek-ai/dsh-client-ui-conversation"]
    }
  }
}
```

`cordis.patch.yml`：

```yaml
- insert:
    - id: my-decoration
      name: '@local/my-decoration'
```

`index.js`（Host 半，渲染不在这里）：

```js
/** Host half of the decoration bundle; the Client module owns the rendering. */
export function apply() {}
```

### 1.2 `client.js` 懒工厂格式

浏览器侧是一个 UMD-ish 工厂注册，**id 必须等于包名**；React 从平台的冻结模块表取，不能自己装
React，也不能 `require` 任何 Harness Client 包（`[asar] .../references/practices.md`）：

```js
window.__ModuleLoader__.load({
  id: '@local/my-decoration',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    function Decoration() {
      return h('svg', { viewBox: '0 0 64 64', width: 48, height: 48, 'aria-hidden': true,
        style: { display: 'block', pointerEvents: 'none' } },
        h('circle', { cx: 32, cy: 32, r: 24, fill: '#247bbf' }));
    }
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock', id: 'my-decoration', order: 5,
        }, Decoration));
      },
    };
  },
});
```

要点：

- **执行 bundle 只注册工厂**，模块体副作用（CSS 注入、订阅、timer）都要落在 factory 闭包 +
  `apply` 里；`[asar] dsh-client-modules/README.md` 明说 lazy-CJS：materialize 时才跑。
- 返回值 `{ inject: [...], apply(ctx), dispose? }`：`inject` 是 Cordis 服务名（`slots`、`remote`、
  `locale`、`theme`…），`apply` 里注册的一切必须是 effect，HMR/卸载时自动撤销。
- 平台模块表（`PLATFORM_MODULES`）提供 `react`、`react/jsx-runtime`、`zod` 等基线模块：证据是
  `[npm:client-ui-claude-code-mods@0.2.2-rc.1] lib/client.js` 在 `dsh.client` 无 `external` 的情况下
  直接 `require("react")`、`require("react/jsx-runtime")`、`require("zod")`。`react-dom` 用于
  `createPortal`（composer 槽位的浮层要求，见 ui-conversation README），同属基座；若确实需要
  非基线模块，才写进 `dsh.client.external`，并确认有包 row 提供它。
- 用 `require.async('./client.<name>.js')` 拿 tsdown 拆分的 chunk（同包内相对 chunk）；
  `require.asset('plugins/<pkg>/assets/...')` 拿随包资源。

### 1.3 `ctx.slots.inject` / `ctx.slots.register` 正确用法

```js
ctx.slots.inject('<ownerSlotKey>', () => ctx.slots.register({ ...options }, Component));
```

- `ctx.slots.inject(ownerKey, cb)`：把注册挂到**父声明（owner declaration）的生命周期**上。
  owner 声明塌缩（例如 `conversation` 视图卸载）时回调内的注册全部 dispose，回来时重新安装。
  注册到未声明的 slot 会在加载期直接 throw（`[npm:client-ui-slots] README`）。
- `register(options, Component)` 返回幂等 disposer。options 按 slot `kind` 不同：

| kind | 必填 option | 其它 |
|---|---|---|
| `single` | —（`name`） | 同 id/同 slot 再注册会替换该格（shadow），`replaceRisk: shadows-shipped-ui` |
| `list` | `id` | `order`（升序，默认 0）、`label`（导航类投影用） |
| `keyed` | `key` | 同一 key 替换该格 |
| `chain` | `select(owner) => unknown \| null` | 升序尝试，第一个非 null 胜出并作为 `matched` prop；全 null 走 owner fallback |

- 通用注册选项（类型见 `[npm:client-ui-slots] lib/types/index.d.ts`）：`inject(sessionId,
  actions) => props`、`locale`（命名空间，框架给组件注入 `t`）、`store`（store seat，给
  `useStore` + `actions`）、`children`（声明子 slot）、`slots`（Factory 用）。
- `inject` 的返回值会变成组件 props；其中**保留字段 `hooks: {name: observable}`** 会被
  renderer 用 `useSyncExternalStore` 包成 `use<Name>` prop（`[asar] dsh-client-ui-renderer/lib/client.js`
  `bindInjectSources`）。`observable` 只需要 `getSnapshot()` + `subscribe(fn)`。这是官方推荐的
  「插件自有 store 注入」姿势，ccmods 的 `useBand` 就是这么来的。
- 组件会收到：标准 kit（见 §1.5 的 `standardProps`）+ `inject` 结果 + slot 级 inject + owner props
  （owner props 最后展开，优先）。

一个带本地 store + locale 的完整 entry（照 ccmods 简化）：

```js
apply(ctx) {
  ctx.effect(() => ctx.locale.register('delta', { zh, en }), 'delta: dictionaries');
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'delta-band',
    order: 20,
    locale: 'delta',
    inject: (sessionId) => ({
      hooks: { band: bandStoreFor(sessionId) },          // -> useBand
      press: (actionId) => pressBand(ctx, sessionId, actionId), // -> press
    }),
  }, Band));
}
```

组件签名：`function Band({ sessionId, useBand, press, t }) { ... }`。

### 1.4 候选 slot 目录（本机实测清单）

> 本环境 client inspect 不可用（§6.1）。以下数据来自 `[asar]
> dsh-cordis-client-runner/lib/client.js` 的 `CLIENT_SLOT_API`（随包发布的 slot 目录，权威、静态，
> 与运行时 `Slots.listSubTree` 同源），以及 `[asar] dsh-client-ui-conversation`、`dsh-client-ui-chat`
> 的实现。

标准 props（session scope 的 slot 基本都带，`Select` 语义为 hook）：

```
useRemoteAccess, useResource, useContextMenu, useWorkspaces, usePanelInfo,
useSessions, useSessionStatus, useSessionRetainInfo, useSessionAccess, useWorkspaceAccess,
useChat, useConversation, useInput, inputActions, useSession, sessionId,
useProjection, useAccess, useTrajectory
```

关键候选：

| slot key | kind / scope | 位置 | owner props / 说明 |
|---|---|---|---|
| **`conversation.input.dock`** | list / session | **输入框卡片上方**，full-width | `{ session: SessionSnapshot, input: InputState }`；occupants：QueueDock `queue`、TodoDock `todo`、GoalDock `goal`、ccmods Band `claude-code-mods`、forge worktree；`replaceRisk: none`。**状态带首选** |
| `conversation.composer.dock` | list / session | 输入框卡片**下方**环境条 | owner props 无；occupants：ActivityPill `activity`、UsagePill `usage`。适合次要状态（如 delta 连接点） |
| `conversation.composer.bar` | single / session-maybe | 整个 composer 本体 | owner props `{variant, blocked, disabled, workspacePickerOpen, onRequestWorkspace, placeholder, accessory}`；`shadows-shipped-ui`，别碰 |
| `conversation.input.activity` | single / session | 模型选择器后的紧凑动作位 | `onActiveChange`；语音输入在用 |
| `conversation.input.overlay` | list / session | composer 卡片内的浮动条目（菜单等） | owner props 无；fixed 浮层必须 portal 到 body；`replaceRisk: none` |
| `conversation.composer` | chain / session | composer 接管（approval/question 用） | `select(owner)`，owner 含 `{sessionId, session, pendingInteraction}` |
| **`conversation.chat.node`** | keyed / session | Chat 行渲染器，key = `ChatNodeKind` | owner props：`{groupPart?, cwd?, openFile, inspectCall?, forkAt, loadImage, turnProcess?}`；`shadows-shipped-ui`；**新增行**见 §1.6 |
| `conversation.chat.flow` | single / session | 整个 Chat 行流 | owner：`{entries, pendingInputs, lastInputTurn, deferCollapse, cwd, openFile, …}`；`shadows-shipped-ui` |
| `conversation.chat.turnTail` | list / session | 完成 Turn 的动作行之前 | `{turn: TurnLocation, seq, openFile}`；**轻量加一行**首选（action-cards 就用它） |
| `conversation.chat.user.before` | chain / session | 用户消息气泡上方的来源徽标 | selector 收到 `{source, kind:'user'|'steering'}`；liveshare 用它显示共享来源。**delta 的「远端作者」徽标很适合这里** |
| `conversation.chat.assistant-actions` | list / session | 完成 assistant 消息的附加动作 | `{messageId}` |
| `conversation.session.header.actions` | list / session | 会话标题旁动作 | 无 owner 值；溢出会裁剪，浮层要 portal |
| `conversation.header` | single / session-maybe | 导航头容器 | 替换风险高 |
| `shell.overlay` | list / root | 全帧浮层 | 弹窗/Toast 可考虑 |
| `main.conversation` | single / session-maybe | 会话壳 | 别碰 |

结论：**band → `conversation.input.dock`**；**轻量 Turn 级信息 → `conversation.chat.turnTail`**；
**作者徽标 → `conversation.chat.user.before`**；**真新增行 → §1.6**。

### 1.5 slot props 细节（input.dock）

`[npm:client-ui-conversation] README` + slot 目录：

```ts
export interface InputZone {
  readonly session: SessionSnapshot
  readonly input: InputState
}
```

加上标准 props 里的 `sessionId: SessionId`、`useSession`（`SessionSnapshotSelector`）、
`useProjection`、`useAccess(action)`、`inputActions`、`useConversation`。**`agent` 不在 props 里**：
Client 只有 sessionId，Host 侧才持有 live Agent（见 §3）。

注意：`scope: session` 表示**没有绑定 Session 时 entry 不渲染**（Hero 输入态、空白会话的
无 session 阶段都没有 band），且切换 Session 会重挂载组件（组件内部 state 不跨 session）。
这正好符合 Claude Code band「每会话一条」的语义。

### 1.6 会话行渲染的两条路

**轻量（推荐先做）**

- `conversation.chat.turnTail`：Turn 完成后、动作行前插一条；拿到 `turn`(TurnLocation) 与 `seq`，
  自己用 `useProjection`/自己的 Remote 数据渲染。不用定义新 node 类型，风险最低。
- `conversation.chat.user.before`（chain）：selector 收到持久消息的 `source`（Chat 不解释它）和
  `kind`，返回非 null 即接管徽标渲染。delta 的「这条消息来自某人/某个远端 turn」用这里最自然。

**新增一种行（重）**

`[asar] practices.md` 原文：「Add a Chat row by registering an event definition with
`ctx.uiConversation.events.register()` and its view in the `conversation.chat.node` slot under the
definition's `kind`, which is the renderer key; the Conversation layer owns paging, Turn and Step
placement, and incremental assembly.」

定义形状（`[npm:client-ui-conversation] lib/types/client/contract/conversation.d.ts`）：

```ts
interface ConversationNodeDefinition<State> {
  kind: string                       // 渲染键，同时是 conversation.chat.node 的 key
  target?: string                    // 绑定的 view target（Chat 用 'chat'；省略=只产状态不产行）
  match(event: SessionEventLike): { id: string; role: 'start' | 'update'; exclusive?: true } | null
  start(ctx, match, reader): State
  update(ctx & { state: State }, match): State
  publication?(match): 'none' | 'animation-frame' | 'immediate'
  buildLocationData?(...): ConversationLocationData | null   // Turn/Step 级业务数据
  buildViewNode?(ctx): ConversationViewNode | null           // 最终行
}
ctx.uiConversation.events.register(definition)   // 返回 disposer；match 也可传 {type: handler} 表
```

配套：

```js
ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
  { name: 'conversation.chat.node', key: 'delta-remote-row' }, DeltaRemoteRow));
```

注意点：

- `key` 是 owner 的 `ChatNodeKind` 键表（`{ [Kind in ChatNodeKind]: { node: ChatNode<Kind> } }`，
  已被 shipped 占用的键如 `user`/`tool-call`/`turn-tail` 会被 shadow，`replaceRisk: shadows-shipped-ui`）。
  新增 kind 在 TS 侧需要 declaration merge；纯 JS 下运行时按字符串分发，能跑，但**必须先在小样里
  验证 Chat 确实渲染未知 kind**（本次环境没有 client inspect，无法离线证实，列为风险）。
- `match` 只能看到 session event，不能访问历史；delta 的「远端 turn」若没有对应 durable event，
  就只能靠 `turnTail` / 徽标路线，或者由 Host 侧把自己的状态折进 projection（仅当日志可推导时）。
- 不要尝试 `appendPluginRecord` / 自定义 event type 来造行：`[asar] practices.md` 明确
  「Do not append session events with a new type」，`appendPluginRecord()` 保留给 DSH 实验包且
  跨版本 best-effort。

---

## 2. Client 如何拿到 Host 侧插件状态

### 2.1 硬事实

- `ctx.remote` 的命名空间集合是**构建期固定**的：`[npm:api-remotes] README`
  「The capability set is fixed by explicit build-time value imports; the Client does not discover the
  Host's active Services or Remote definitions at runtime.」当前 Web 组合挂了 27 个贡献（服务键：
  `accountController, agentPresets, commands, credentialsController, directoryPickerController,
  dynamicCordisRunner, fileUploads, goals, jobController, llm, messageFeedback, officeToPdf,
  permissionPresets, pluginInventory, pluginManager, pluginMarket, pluginRegistryProbe,
  productAnalytics, schedule, sessionController, sessionFeedback, sessionFileReferences,
  sessionReferenceResolver, sessionSkillCatalog, sessionToolResults, settingsController, subagents,
  terminalController, userQuestions, workspaceController, workspaceFiles`，见
  `[asar] dsh-api-remotes/lib/client.js` 的 `$mount` 列表）。
- 新增一个 Client 能调的 Host 能力 = 挂一个 **Typert Remote 贡献**：
  Client 侧 `await ctx.remote.$mount(contribution)`；Host 侧要么有生成的 `./typert` 产物（loader
  自动注册），要么 `ctx.typert.register(...)` 手写贡献，要么用 Gateway 的 SRC 回退（见 §2.3）。
- `ctx.remote.$mount(contribution)` 的契约（`[asar] dsh-api-gateway/lib/client.browser.js`
  `mountContribution` / `validateContribution`）：贡献至少要有 `package` 与 `descriptors[]`，每个
  descriptor 含 `namespace`、`method`、`invocation[{kind:'direct'}|{kind:'context',context,wire}]`、
  `parameters[{name,wire,source:'json'|'lookup',lookup?,codec:{mode:'strict',create,jsonSchema?}}]`、
  `result{mode:'strict',...}`，可带 `mode:'stream'`、`cancellation:{parameter:'signal'}`、
  `scope:{context,wire}`；**所有输入 codec 必须是 `mode:'strict'`**，否则 mount 前就 throw。
  `$mount` 会把贡献同时注册到 `ctx.typert.remotes` 并按 namespace 建立 `ctx.remote.<ns>` 服务。
- 调用结果统一是 `RemoteResult<T>`：`{ok:true,value}` / `{ok:false,error: RemoteError}`；只有装配
  错误（arity、未挂载、贡献撤销、缺 Context adapter）才 reject（`[npm:api-gateway] README`）。
- 流：`await ctx.remote.<ns>.<streamMethod>(sessionId, signal)` 返回 `RemoteStreamHandle`（可
  `for await`，`dispose()` 取消；`send/end` 是 uplink）。

### 2.2 方案 A：session projection（`wire.view`）+ `useProjection` —— 只能承载「日志可推导」状态

Host 侧注册 projection unit（`[npm:session-projection] README`）：

```js
const handle = await ctx.sessionProjections.register({
  key: 'deltaThread',
  stateSchema,                 // schemastery
  stateVersion: 1,
  init: (header, inheritedEventCount) => ({ ... }),
  apply: (state, event) => event.type === 'delta/...' ? next : state,  // 纯、同步、无关事件返回同一引用
  wire: { viewSchema, view: state => ({ link: state.link, audience: state.audience }) },
})
```

Client 读（slot 标准 prop，签名来自
`[npm:api-session-controller] lib/types/client/sessions/projection-store.d.ts`）：

```ts
type UseProjection = {
  <K extends keyof SessionProjectionMap & string>(key: K): SessionProjectionMap[K] | undefined
  <K extends keyof SessionProjectionMap & string, S>(key: K,
    selector: (v: SessionProjectionMap[K] | undefined) => S, eq?: (a: S, b: S) => boolean): S
}
// 组件里：
const delta = useProjection('deltaThread')
```

- 值通过 history baseline 的 whole projections 块 + 控制流 frame 推送，Client 不 fold 事件。
- `wire.summary: false` 可排除 Session 列表汇总；`SessionProjectionMap` 用 declaration merge 加键。
- **限制**：`apply` 只能折叠 committed session events。delta band 的 connection、presence、
  share 进度、plugin-update 通知都是**插件内存态**，没有对应 durable event；也无法由 delta-dsh
  自己追加自定义事件（见 §1.6 末尾）。所以 projection 只能承载 band 里「从会话事件能推导」的子集
  （例如「本 turn 是否已记录/同步」），单独用它做不出 band。

### 2.3 方案 B：自有 Remote 命名空间（推荐）

与 shipped 的 `forge`、`goal`、`claude-code-mods` 完全同构：一个 host 服务 + 一个生成的（或手写的）
client 贡献。两条实现路线：

**B1. 生成式（最稳）**：Host 侧写 TS 服务（`@Remote` / `@Remote({mode:'stream'})`，`extends
TypertRemoteService` 或用 `bindTypertRemote`），构建期跑 `@deepseek-ai/dsh-typert-generator`
（npm 上有 `0.2.2-rc.1`）。它产出 `lib/typert.host.js`（loader 自动注册）与
`lib/typert.remote-client.js`（Client 侧 `./remote` 贡献）。代价：generator 要求工作区布局
（`tsdown` 的 `typertPlugin()` 以「最近的同时有 `tsconfig.host.json` 与 `packages/` 的祖先」为
workspace root；或 `writePackageArtifacts()` 手动写）。delta-dsh 若不是 DSH monorepo 布局，需要
照这个约定造目录，属于一次性的构建 spike。

**B2. 手写（无构建工具）**：loader 文档明确允许「Manual `ctx.typert.register()` … (hand-written
wire schemas, tests, non-loader compositions)」。两端都能照抄现成产物：

- Host 描述符的完整样例：`[asar] dsh-commands/lib/typert.host.js`；Client 贡献的完整样例：
  `[npm:client-ui-claude-code-mods@0.2.2-rc.1] lib/client.js`（它把 `createTypertRemoteInfo` 的
  120 行实现内联进 bundle，直接 `require('zod')`）。
- 最小 Host 侧面（SRC 模式，代码最少，但属"development fallback"）：普通 class +
  `myService.typertRemote = bindTypertRemote(this, 'deltaUi', { namespace: 'deltaUi' })`，再在
  prototype 上挂 marker 描述符（`@deepseek-ai/dsh-typert-protocol/remote-methods`，
  `{version:1, methods:[{method:'pressBand', invocation:{kind:'direct'}}, {method:'watchBand',
  invocation:{kind:'direct'}, mode:'stream'}]}`）；Gateway 会把 `deltaUi/pressBand` 这类端点按方法
  参数名（`agent` 命中 lookup、`generation`/`actionId` 为 JSON、末尾 `signal` 为取消）解析成
  descriptor。**先用 1 小时 spike 验证**：SRC 是回退路径，没有 strict 输入校验，且撤销后会
  `definition-unavailable`。
- Client 的调用面（与 ccmods 一致）：

```js
const disposeRemote = await ctx.remote.$mount(TYPERT_REMOTE)   // 手写贡献也走这里
const handle = ctx.remote.deltaUi.watchBand(sessionId, controller.signal)
for await (const snapshot of handle) store.set(snapshot)
const result = await ctx.remote.deltaUi.pressBand(sessionId, snapshot.generation, actionId)
if (!result.ok) throw result.error
```

**B 的推荐数据形状**（见 §7.3）：`DeltaBandSnapshot { generation, view }`，`generation` 递增，
press 必须带自己看到的那一版（旧版点击 Host 拒绝并重绘，ccmods 已证明这套语义好用）。

### 2.4 方案 C：commands Remote（只做动作，不做状态）

见 §3。适合「先让按钮通电」的过渡版：状态部分先不放/放 projection 子集，动作走命令。

### 2.5 方案 D：actionCards

不适用。`[asar] dsh-action-cards/README.md`：卡片由**模型**调用 `propose_action` 触发、一 turn
最多一张、渲染在 `conversation.chat.turnTail`，面向「答案下方的可选动作」，不是常驻输入框状态带。
它的 `act(sessionId, callId, verb, payload?)` 也有同样的问题（生命周期绑卡片）。不要用它做 band。

### 2.6 方案 E：同源 HTTP 路由

Host 有 `webServer` 服务（`[inspect] host Service`：`register(route: WebRoute | WebResourceRoute):
() => void`、`registerUpgrade(route)`、`registerFallback(handler)`、`tapIndex(transform)`），
`/plugins` 路由就是 client-modules 用它注册的。理论上可以 `GET /delta/band?session=` +
`POST /delta/press`：Client 用页面的 authenticated transport（HMR 用
`window.__DSH_TRANSPORT__.fetch`，普通页面走同源 fetch）访问。

不推荐：没有推送语义（要么轮询，要么自己 `registerUpgrade` 一个 WS 通道），鉴权/Peer 归
Connection 契约，错误映射要自己写；而 Remote 已经把这些（含取消、重连、错误码）免费给齐了。
只在「连 typert 都不可能」时作为最后手段。

### 2.7 可行性排序

1. **B（自有 Remote `deltaUi`）** —— 唯一能同时承载内存态 + 按钮动作 + 推送的方案；与 shipped
   插件架构一致。B1 生成式优先，B2 手写为兜底。
2. **A（projection）** —— 作为 band 的补充数据源（可推导的子集），或用于会话行需要的派生状态；
   单独不够。
3. **C（commands）** —— 过渡版的按钮通道；有 session log 副作用。
4. **E（HTTP 路由）** —— 可行但工作量大、无推送。
5. **D（actionCards）** —— 位置/语义都不对。

---

## 3. 按钮如何触发 Host 动作

### 3.1 `ctx.remote.commands.execute` 的确切签名

Client（`[asar] dsh-commands/lib/typert.remote-client.js` + `[asar]
dsh-client-ui-commands/lib/client.js` 的实际调用）：

```js
// 返回 Promise<RemoteResult<CommandExecution | undefined>>
const result = await ctx.remote.commands.execute(sessionId, line, submittedAttachments)
```

- `sessionId: SessionId`：**wire 字段是 `agentId`**，descriptor 参数 `{ name:'agent', wire:'agentId',
  source:'lookup', lookup:'agent' }` —— Gateway 用 `lookup: 'agent'` 把这个值解析成 live `Agent`。
  所以 Client 传 sessionId 即可（`ui-commands`、`ui-plan` 都是这么传的）。
- `line: string`：完整 slash 命令行，如 `'/delta join'`。
- `submittedAttachments: readonly CommandSubmitAttachment[]`：纯按钮场景传 `[]`。
- Host 端实际方法（`[inspect] host Service commands`）：
  `async execute(agent: Agent, line: string, submittedAttachments, signal: AbortSignal):
  Promise<CommandExecution | undefined>`，`CommandExecution = { commandId, result: {kind:'success',
  text?} | {kind:'error', text} }`。
- `signal` 由 Client 生成的取消方法**可选**作为最后一个实参传入（`execute(sessionId, line, [],
  signal)`，框架会与贡献 mount 生命周期合并）。

### 3.2 Host 侧注册命令

`[asar] dsh-commands/README.md`：

```js
const dispose = ctx.commands.register({
  name: 'delta',                                  // lowercase，不含斜杠
  description: 'Join, share, or manage this Delta thread',
  input: { hint: '<join|share|update|...>' },     // 可选；声明 input.attachments 才允许带附件
  handler: async ({ agent, rawInput }) => {
    // 直接跑，不产生模型消息
    return { kind: 'success', text: 'joined' }    // 或 { kind: 'error', text: reason }
  },
})
```

命令语法：`/delta join` → `name='delta'`，`rawInput='join'`（含分隔空白，命令自己解释语法）。
`recordInput` 默认 true。

### 3.3 错误展示

- `RemoteResult` 失败（离线/取消/拒绝）：`if (!result.ok) throw result.error`，在组件里
  `setNotice(t('press.failed', { message }))`，渲染一行 `role="status"` 的错误文字（ccmods 的
  `press.failed` 样式即 `--dsw-alias-state-error-primary`）。
- 命令本身失败：`ok:true` 但 `value.result.kind === 'error'`，要自己取 `text` 展示。
- `isRemoteFailure(error)` 用来区分「Host 明确失败」与「本地装配错误（应该 crash）」。
- 按钮 in-flight 时全部 disabled（ccmods：`aria-busy` + `pending` state），避免双击。

### 3.4 命令通道的代价（为什么只做过渡）

- 每次执行都往 session log 写 `command/run` 与 `command/done`（`[inspect] commands` 的
  `execute` 描述写得很清楚：direct log-only appends，无 turn 包裹），于是会话流里会出现
  command 行；Join/Keep/Discard 这种高频小按钮会污染历史。
- 需要 session 是 live 的（agent lookup 解析），冷 session 不行。
- 命令名会进入 `/` 菜单，是用户可见 API（这对 `/delta` 主命令是好事，但对 band 内部按钮不是）。

因此：**band 按钮优先走自有 Remote 的 `pressBand(generation, actionId)`**；命令通道只作为
「Remote 还没打通」时的过渡，以及 `/delta` 用户入口本身。

---

## 4. 主题 / locale / 样式 / 清理 / 崩溃边界

### 4.1 主题 token

`[asar] dsh-client-ui-theme/lib/client.js` 内联的 token 表共 114 个 `--dsw-alias-*`。只用 alias
token，字面颜色只用于插图（`[asar] references/practices.md`）。分组（节选）：

- 背景/表面：`--dsw-alias-bg-base`、`bg-layer-1..3`、`bg-overlay`、`bg-skeleton`、`bg-mask-*`、
  `bg-multi-select`、`bg-module-platform`
- 文字：`label-primary`、`label-secondary`、`label-tertiary`、`label-caption`、`label-dimmed`、
  `label-primary-inverted`、`label-primary-bluish`、`label-primary-dimmed`、`link`、`markdown-*`
- 边框：`border-l1..l4`、`border-inverted`、`border-inverted2`、`border-l2-darkmode-thin`
- 状态：`state-success-primary/secondary/tertiary`、`state-warn-primary/secondary/tertiary`、
  `state-warn-label`、`state-error-primary/secondary`、`state-business-primary/tertiary`、
  `state-idle-primary`、`state-done-primary`
- 交互：`interactive-bg-hover`、`interactive-bg-active`、`interactive-bg-hover-accent`、
  `interactive-bg-hover-danger`、`interactive-bg-hover-solid`
- 按钮：`button-primary-fill/hover/dimmed`、`button-info-fill/hover`、`button-ghost-*`、
  `button-contrast-fill`、`button-elevated-fill`、`button-floating-fill/hover`、`button-tool-bar-*`
- 其它：`toast-bg`、`toast-label`、`tooltip-bg`、`tooltip-key-bg`、`switch-thumb`、
  `settings-card-fill/stroke`、`menu-icon`、`menu-group-header-fill`、`scrollbar-*`、
  `file-diff-*`、`code-diff-added/deleted`、`illustration-*`、`turn-trigger-bg(-hover)`

字体：`--dsw-font-family`（文本）、`--ds-font-family-code`（代码）、`--dsw-font-mono`（等宽，
ccmods band 用）、`--dsh-content-font-size`、`--dsh-code-font-size`、`--dsh-terminal-font-size`、
`--dsh-font-family-*-default`。圆角/焦点遵循 `docs/ui-radius.md`、`--dsw-focus-ring-*`。

band 可直接照 ccmods 的用法：

```css
.delta-band { background: var(--dsw-alias-bg-layer-1, transparent);
  color: var(--dsw-alias-label-primary); border-radius: 8px; }
.delta-band [data-tone=error] { color: var(--dsw-alias-state-error-primary); }
.delta-band [data-tone=live]  { color: var(--dsw-alias-state-success-primary); }
.delta-band [data-tone=warn]  { color: var(--dsw-alias-state-warn-primary); }
```

### 4.2 locale

```js
ctx.effect(() => ctx.locale.register('delta', {
  zh: { band: 'Delta', 'press.failed': '按钮操作失败：{message}', ... },
  en: { band: 'Delta', 'press.failed': 'The button failed: {message}', ... },
}), 'delta: dictionaries')
```

register 时 `locale: 'delta'`，组件得到 `t(key, params?)`。规则
（`[asar] dsh-client-locale/README.md`）：

- 基线必须同时提供 `zh` 与 `en`（编译期/运行期都要求），其余 locale 可选；
- 字典注册发生在 UI 挂载之后也会被拾取，无需重挂载；占位符 `{name}` 原样保留；
- 不带 `locale` 就不注入 `t`；`bind(ns)` 可在非组件代码里翻译；
- 安装包的标题/描述走包根 `locale/*.json` 的 `meta.title`/`meta.description`（Plugin Manager 读，
  不激活插件），与运行时字典是两套（`[asar] references/host-plugin.md`）。

### 4.3 CSS 隔离

三种都行，按复杂度选：

1. **随 bundle 的全局样式 + 前缀类**（推荐，ccmods 做法）：构建期把 CSS 内联进 `lib/client.js`，
   materialize 时注入 `<style data-plugin="<pkg>" data-plugin-css="<pkg>/Band.module.css">`，只在
   不存在时插入。HMR/卸载时由模块系统清理该插件拥有的 style。类名加包前缀（ccmods 用哈希前缀
   `rLFjeG_`），选择器都挂在 `.delta-band` 下，不写裸元素选择器。
2. **组件内 `style` 对象**：最省事，适合结构简单；动态主题靠 CSS 变量（`style={{ color:
   'var(--dsw-alias-label-primary)' }}`）。
3. **CSS Modules / TS 构建**：仓库内正常写法；产出仍是上面第 1 种形态。

统一要求：不读别的插件的 DOM/样式、不改 `document.body`、不用 `!important`、浮层（Tooltip/Menu）
用 `createPortal`/`portal` 到 body（composer 是 fixed 的包含块，
`[npm:client-ui-conversation] README` 明确要求）。

### 4.4 清理与卸载

- 一切注册都用 effect：`ctx.effect(() => {...; return () => cleanup}, 'delta: ...')`；
  slot 用 `ctx.slots.inject` 包住；`ctx.on(...)` 返回 disposer。
- 流：`AbortController` + `handle.dispose()`；`for await` 结束/异常都要在 `finally` 里清 store 引用
  （ccmods 的 `watchSession` 是范本：store 关闭后从 map 删除，下次订阅重开）。
- timer/动画（spinner 120ms）：client 侧用 `ctx.effect` 里的 `setInterval`/`requestAnimationFrame`
  并把 cancel 返回；不要裸 timer。
- HMR：bundle 重新执行 → 旧 fiber 卸载（effect 清理）→ 新 bundle mount；组件内 React state 丢失，
  session/connection 状态保留（`[asar] dsh-client-hmr/README.md`）。所以 band 的「已显示 N 秒」
  这类瞬态允许丢；持久的东西放 Host。

### 4.5 崩溃边界

renderer 对每个 entry 套 `SlotErrorBoundary`（`[asar] dsh-client-ui-renderer/lib/client.js`）：

- 渲染或 inject 工厂抛错：`console.error("slot entry crashed in '<slotKey>':", error)`，该 entry
  渲染成 `<div data-slot-error="<slotKey>">`，**不会拖垮整个界面**；shadow 类（keyed/single 替换）
  的 crash 会放弃该 entry 并回落到下一个存活者。
- 装配错误（`SlotAssemblyError`：缺 provider、hook 源缺失等）**重新抛出**，会让上层炸——这是故意的
  「连错要响」；所以**不要**在 `inject` 里做可能失败的 I/O，`inject` 是纯函数。
- 结论：band 组件要自己 catch 订阅/渲染分支里的可预期错误（例如 `useBand` 返回 undefined 时
  渲染 null），别把异常留到 render。

---

## 5. 研判 `@deepseek-ai/dsh-experimental-client-ui-claude-code-mods` 能否直接复用

### 5.1 它是什么（事实）

`[npm:client-ui-claude-code-mods@0.2.2-rc.1]`：

- 包清单：`dsh.client = { platform:'web', inject:['@deepseek-ai/dsh-api-remotes',
  '@deepseek-ai/dsh-api-session-controller','@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-ui-conversation','@deepseek-ai/dsh-client-ui-primitives'] }`，
  `./client` = `lib/client.js`，无 `external`。
- `client.js`：整包内联了 `createTypertRemoteInfo` 的 RemoteInfo 实现 + `TYPERT_REMOTE`
  （package `@deepseek-ai/dsh-experimental-claude-code-mods`，方法 `claudeCodeMods/watchBand`
  （stream，scope agent）+ `claudeCodeMods/pressBand`）+ `Band` 组件 + `Band.module.css` + 8 语言字典。
- `apply(ctx)`：`await ctx.remote.$mount(TYPERT_REMOTE)`，然后
  `ctx.inject(['remote.claudeCodeMods','slots','locale'], registerUi)`，在 registerUi 里
  `ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
  name:'conversation.input.dock', id:'claude-code-mods', order:20, locale:NS,
  inject:(sessionId)=>({ hooks:{band: store}, press: async (generation, actionId)=>{...} })}, Band))`。
- 渲染的数据形状是 `SerializedNode[]`：`Box/Text/Button` 三种元素，props 只支持
  `flexDirection/paddingX/paddingY/padding/gap/border/borderColor`（Box）、
  `color/bold/dimColor/italic/underline`（Text，颜色名限定 yellow/red/green/cyan/blue/magenta/
  gray/white/black）、`label/hotkey/disabled/onPress`（Button，`onPress` 被换成本次绘制内的
  `actionId`）。Host 固定按 120 列渲染、wrap；`width/height/overflow/wrap/truncate` 被忽略；
  每 session 一条；`Pane/TextInput/热键/焦点/滚动` 不支持。
- 依赖：它自己只 peer-depend `@deepseek-ai/cordis`；真正提供数据的是 **另一个包**
  `@deepseek-ai/dsh-experimental-claude-code-mods`（Host bridge，`[npm]` 可拉到同版本），该 bridge
  注册 `claudeCodeMods` 服务，`add(definition)` 挂 `defineMod` 插件、跑 `ui.render` 钩子链、
  维护 per-session band 与 per-drawing action id。

### 5.2 本机组合状态（关键）

- `[inspect] host Service` 目录里能看到 `claudeCodeMods`，但那是**静态类型目录**：同一次
  `[inspect] Config.listConfigs(name:'@deepseek-ai/dsh-experimental-claude-code-mods')` 返回
  `entries: []`（对照 `client-ui-chat` 能查到 1 条），说明 **bridge 在本 desktop profile 并未组合**；
  asar 的 `@deepseek-ai` 目录里也没有这两个包（属于 npm opt-in 实验包）。
- 因此现状是：**没有 bridge → 没有 band 数据；只装 client 包会在 `$mount`/`ctx.inject`
  阶段失败**（`remote.claudeCodeMods` 不存在）。

### 5.3 能否让 delta 的 host shim 产生 band 树、从而省掉自研 Client？

**可以，但前提是把 delta 的 band 重写成 bridge 的 mod，而不是复用 delta 现有 hooks。**

成立的路径：

1. 安装 bridge（`dsh-experimental-claude-code-mods`）+ 本 client 包（两个都必须，版本锁
   `0.2.2-rc.1`；两者都属 npm 实验包，Desktop 没有内置）。
2. delta-dsh 的 Host 半在 `apply` 里 `ctx.claudeCodeMods.add(defineMod({ name:'delta-band',
   version, root, register }))`：`register(on, options)` 注册 `ui.render` 钩子，钩子把 delta 的
   band 状态翻译成 `Box/Text/Button` 树（Host 侧算布局/文案），把每个按钮的 handler 留在 Host。
3. Client 完全不用写：现有 client 包渲染树、发 `pressBand(sessionId, generation, actionId)`、
   Host 把 action 跑在 mod 的 `onPress` 里并重绘；`generation` 已经是防旧点击的语义。

不成立的路径 / 代价：

- delta 现有 `register.tsx` 直接跑不通：bridge 的事件是 `session.start / prompt.submit /
  turn.start / tool.call / turn.complete / command.run / ui.render / session.end`，**没有
  `session.append`**，而 delta 的记录/远端行大量依赖它；`$` 也没有 `agent.list/spawn`、
  `settings.policy`、`turn.abort`、`ui.copy`、`session.append`、`session.surfaces`、
  `session.apiMessages` 等 delta 用到的成员（对照 `[npm:dsh-experimental-claude-code-mods]
  lib/types/api.d.ts` 与 delta `hooks/core/host.ts`）。所以「band 重写成 mod」是唯一可行形态，
  等于 Host 侧仍要写一层翻译（与自研方案 Host 工作量相当），省下的只有 Client 组件。
- 视觉保真度上限：元素词汇只有 Box/Text/Button，**没有 Link**（delta 的 share 链接是可点链接，
  只能改成 Text + 按钮）、颜色只有 10 个具名色（delta 的 `personColor` 任意色不行）、
  `inverse/autoFocus/plain` 等属性不支持、固定 120 列、`width/overflow` 被忽略。
- 依赖风险：两个实验包与 `0.2.2-rc.1` 强绑定，Host 升级 rc 版本即可能失配（bridge 的
  peerDependencies 里有一长串 `0.2.2-rc.1` 包）；它们不在 Desktop 发行物里，需要
  `plugin_manager install_bundle` 进 profile，并随每次 DSH 升级复核。
- 它不能用在没有 Session 的状态（band 只在 session 打开时由流提供），与 delta 的 Hero 态一致，
  这点无碍。

### 5.4 结论

- **不建议**为实现 band 引入这两个实验包：省下的是我们已经要写的 Band 组件（约 200–300 行），
  换来两个版本锁死的实验依赖 + 元素词汇/视觉降级 + Host 侧照样要写翻译层。
- **建议**把它的两样东西当资产复制：
  1. **数据协议**：`{ generation, tree }` + 序列化 Button 的 `actionId`（我们改用 typed view model，
     但 generation/actionId 语义照搬）；
  2. **渲染器与 CSS**（MIT，`Band.tsx` 约 100 行 + `Band.module.css`），可按需裁剪成 delta 版本，
     其中 `--dsw-alias-*` 映射表可以直接抄。
- 如果 Lead 想赌一把「零 Client 代码」，则应把它列为独立 spike：装 bridge + client，先用一个
  10 行的合成 mod 验证「box/文字/按钮出现在输入框上方、点击回到 Host」，再评估视觉降级是否可接受。

---

## 6. 验证

### 6.1 本环境的能力边界（先看，避免无效尝试）

- **client inspect 全部不可用**：`cordis_inspect_query`（client，Slots/Builtin/Service/Event/Theme）
  实测均 10s 超时。原因：这些 provider 由 `dsh-cordis-client-runner` 的浏览器半注册，而本
  desktop profile 的 `package.json` bundles 里没有它（`~/.dsh/profiles/desktop/package.json`）。
  所以 `Slots.listSubTree` 拿不到——本报告用 `[asar] dsh-cordis-client-runner/lib/client.js`
  的 `CLIENT_SLOT_API` 静态目录替代（同源、随版本发布）。
- **host inspect 的 Service/Event 目录是静态契约**，不等于「已组合」：`claudeCodeMods`、`webServer`
  等都会列出来。判断 live 用 `Config.listConfigs`（有 `entries` 才是真条目）、或看
  `~/.dsh/profiles/desktop/cordis.patch.yml` / bundles。
- **GUI 有鉴权**：`curl http://127.0.0.1:64350/` 返回 401；页面用 shell 注入的
  `window.__DSH_BOOT__` 与 authenticated transport。不要去找 token（`[asar] references/
  verification.md` 明确禁止搜索凭据）。

### 6.2 在有页面的情况下验证

安装后（本任务不安装）打开 GUI，DevTools：

1. `window.__DSH_BOOT__`：确认新包在 boot graph 的 entries 里（`id`、`rev`、`immediately`）。
2. Console 无 `client-modules`/`slot entry crashed in 'conversation.input.dock'`；有则说明组件
   或 inject 崩了（§4.5）。
3. Elements：`[data-slot-error]` 是否出现；band 根节点加一个稳定 `data-*`（例如
   `data-delta-band` + `data-tone` + `data-generation`），便于定位。
4. 交互：点 Join/Keep/Discard/Update/Later/Mute → Network 里应出现 `POST /api`
   （unary Remote）或 `/api/remote.mux` 的 WebSocket 帧；Host 侧状态变化后 band 的
   `data-generation` 递增。
5. 切 Session：band 重挂载（`scope: session`）；切主题/语言：颜色与文案即时变化（locale 字典
   注册后无需重挂载）。

### 6.3 热更新条件

- **普通 bundle 代码改动**：需要 `pnpm run dev:web`（Host + 共享 Client tsdown 的 watch）在跑；
  重建 `lib/client.js` 后，Host 发 `rebuilt` 帧，页面自动替换该插件（组件 state 丢失，
  session/connection 保留）。没有 watch 进程时，改代码不会生效。
- **`package.json` 的 `dsh.client` 改动**：manifest 只在 Loader entry 启动/重启时读取，
  「A manifest edit alone is not observed」→ 需要重启 entry 或 Host。
- **启用/禁用插件**：HMR 图更新，页面无需刷新；**替换已安装包的代码**需要重启才能加载新的
  JavaScript module generation（`[asar] references/host-plugin.md`）。
- bundle 必须先构建：`lib/client.js` 不存在会让 activation 明确失败（client-modules）。
- 新增 `./typert` 导出后需要**重启 Host**（loader 的 package 判定缓存是进程级的）。

### 6.4 无浏览器控制时的替代检查

```sh
# 1) 语法：client.js 是 classic script（window.__ModuleLoader__），直接 parse
node --check delta-dsh/client.js
node --check delta-dsh/index.js            # Host 半（ESM 用 .mjs 或 type:module 下同）
# 2) manifest / 补丁
node -e "JSON.parse(require('fs').readFileSync('delta-dsh/package.json','utf8'))"
node -e "require('fs').readFileSync('delta-dsh/cordis.patch.yml','utf8')"   # 至少能读
# 3) 产物核对：bundle 里应出现预期标识
grep -c "__ModuleLoader__" delta-dsh/client.js
grep -c "conversation.input.dock" delta-dsh/client.js
# 4) 读 asar 内文件（Electron 的 patched fs）
ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
  /tmp/asar_cat.js "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/<pkg>/lib/client.js"
```

Host 侧可用的免渲染检查：

- `[inspect] Config.listConfigs(name)` 确认新行是否 live；
- `[inspect] host Service/Event` 确认服务方法/事件契约（静态）；
- 安装返回里的 `application` / `warnings`（`plugin_manager` 结果）才是「是否生效」的判据，
  不是日志或进程列表；
- 测试替身：`@deepseek-ai/dsh-client-test-runtime` 提供 `RemoteError` 等，可对 band 渲染做
  jsdom 快照（本仓库若引入 Client 测试，参考 ccmods 用 `@testing-library/react` 的做法）。

**必须如实报告**：无浏览器控制时，「band 在页面里长什么样/位置对不对」属于未验证；安装成功或
slot 注册成功都不等于视觉验证。

---

## 7. 推荐实现（给 delta-dsh 的落地方案）

### 7.1 架构

```
Host（Cordis，Node）：
  delta service（现有 port 的核心：watch/recording/sharing/join/update 状态）
    ├─ 订阅 delta 后端流、CLI 事件、timer → 维护 per-session DeltaBandState（内存）
    ├─ 渲染 DeltaBandView（typed view model）→ 按 generation 维护快照 + actionId → handler 表
    ├─ Remote: deltaUi/watchBand(agent, signal) : stream<DeltaBandSnapshot>
    │          deltaUi/pressBand(agent, generation, actionId) : Promise<DeltaBandSnapshot>
    ├─（可选）Session projection: 只放可从会话事件推导的派生值（如本 turn 的同步状态）
    └─ 会话行：conversation 行数据（远端作者/turn）→ 同一条 Remote 快照里带
Client（浏览器 bundle）：
  apply(ctx):
    ├─ ctx.remote.$mount(deltaUi 贡献)            // §2.3
    ├─ ctx.locale.register('delta', {zh,en,...})
    ├─ ctx.effect: per-session band store（首个订阅者打开 watchBand 流，最后关闭）
    ├─ ctx.slots.inject('conversation.input.dock', register({id:'delta-band', order:20,
    │     locale:'delta', inject: sessionId => ({hooks:{band}, press})}, DeltaBand))
    ├─（可选）conversation.chat.turnTail / user.before 的 delta 行/徽标
    └─ 样式：注入 data-plugin-css 的 <style>（或组件内 style）
```

### 7.2 文件清单（建议）

```
delta-dsh/
  package.json            # dsh.bundle.patch + dsh.client{platform:web,immediately:true,
                          # inject:[ui-conversation, api-remotes, client-locale]} + exports
                          #   ./client, ./locale/*.json, ./icon, ./typert, ./remote(可选)
  cordis.patch.yml        # - insert: [{id: delta-dsh, name: '@…/delta-dsh'}]
  index.js / src/host/index.ts     # apply(ctx)：delta service、Remote、commands、projection
  src/host/band.ts                 # Host 侧 DeltaBandView 计算（band/status.ts 的移植）
  src/host/actions.ts              # press 分发（join/share/fork/discard/update/later/mute）
  lib/typert.host.js               # 生成物（B1）或手写（B2）
  lib/typert.remote-client.js      # 仅 B1；B2 时手写等价贡献并内联进 client bundle
  src/client/index.js / lib/client.js   # 懒工厂：$mount + slots + locale + store
  src/client/DeltaBand.tsx         # band 组件（tone/mark/link/audience/people/progress/...）
  src/client/Band.module.css       # 或内联样式
  src/client/rows.tsx              # （可选）turnTail/author 徽标/新增行
  locale/{en,zh,...}.json          # meta.title/description（Plugin Manager 用）
  icon.svg
```

### 7.3 Host↔Client 数据协议（JSON）

推荐 **typed view model**（而不是 ccmods 的序列化树）。理由：band 要多人色、链接、复制按钮、
进度步骤、可访问性（`role="group"`/`aria-busy`/`aria-live`），typed 模型让 Client 用 React +
token 精细控制；Host 也不必编码布局。序列化树方案保留为「若改走 bridge」时的选项，两者共享
`generation` + `actionId` 语义。

```jsonc
// DeltaBandSnapshot
{
  "generation": 42,                    // 每次重绘 +1；press 必须带自己看到的值
  "view": {
    "tone": "live",                    // live | pending | quiet | error
    "mark": { "text": "●", "color": "success" },
    "label": [                          // 拼接成的状态文字段
      { "text": "Syncing", "bold": true },
      { "text": " · ", "dim": true },
      { "text": "Ada, Lin", "color": "label-secondary" }
    ],
    "link": {                           // 可点/可复制
      "text": "delta.dev/t/abc123",
      "href": "https://delta.dev/t/abc123",
      "copyLabel": "Copy link",
      "copied": false
    },
    "audience": [{ "text": "Shared with Zed" }],
    "people": [
      { "id": "ada", "name": "Ada", "arriving": false, "leaving": false }
    ],
    "children": [                       // 子代理/子线程
      { "id": "child-1", "name": "auth-fix", "state": "running" }
    ],
    "activity": {                       // 别人的 turn 正在跑
      "seconds": 12, "doing": { "text": "bash: pnpm test", "tool": true, "seconds": 4, "more": 0 }
    },
    "progress": { "text": "Sharing…", "tone": "active", "step": [1, 3] },
    "spinner": { "frame": 3 },          // 或用 "spinner": true，由 Client 自己动
    "conflict": { "fork": "Fork & Restore", "discard": "Discard" },
    "notice": { "text": "Update available (0.1.30)", "tone": "info" }
  },
  "actions": [                          // 按钮：Host 分配 actionId 并持有 handler
    { "actionId": "a:share", "label": "Share", "hotkey": "s", "disabled": false },
    { "actionId": "a:fork",  "label": "Fork & Restore", "disabled": false },
    { "actionId": "a:discard","label": "Discard", "disabled": false },
    { "actionId": "a:update","label": "Update", "disabled": false },
    { "actionId": "a:later", "label": "Later", "disabled": false },
    { "actionId": "a:mute",  "label": "Mute", "disabled": false }
  ]
}
```

Remote 方法：

```
deltaUi/watchBand(agent, signal) -> stream<DeltaBandSnapshot>
    // 首帧立即给出当前快照；之后每次重绘/状态变化一帧；Client 断开即取消
deltaUi/pressBand(agent, generation, actionId) -> RemoteResult<DeltaBandSnapshot>
    // generation 不匹配：Host 拒绝并返回最新快照（Client 重绘 + 可选提示「面板已刷新」）
    // actionId 失效/已消费：同上
```

`agent` 参数在 Client 侧传 `sessionId`，Host 侧由 `lookup:'agent'` 解析（与 commands 一致）。

### 7.4 Client 关键代码骨架

```js
// lib/client.js（节选自 ccmods 的成熟结构）
window.__ModuleLoader__.load({
  id: '@deepseek-ai/delta-dsh',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const z = require('zod');
    const TYPERT_REMOTE = /* §2.3：内联 createTypertRemoteInfo + deltaUi 两个方法 */;

    const NS = 'delta';
    const inject = ['remote', 'slots', 'locale'];

    class BandStore {
      snapshot; listeners = new Set();
      getSnapshot = () => this.snapshot;
      subscribe = (fn) => { this.listeners.add(fn); return () => this.listeners.delete(fn); };
      set = (v) => { this.snapshot = v; for (const fn of [...this.listeners]) fn(); };
    }

    function watchSession(ctx, sessionId, onEnd) {
      const store = new BandStore();
      const controller = new AbortController();
      const handle = ctx.remote.deltaUi.watchBand(sessionId, controller.signal);
      (async () => {
        try { for await (const snap of handle) store.set(snap); }
        catch (e) { if (!controller.signal.aborted) ctx.logger.warn(`delta band: ${e}`); }
        finally { onEnd(); }
      })();
      return { store, dispose: () => { controller.abort(); handle.dispose(); } };
    }

    function registerUi(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'delta: dictionaries');
      const watches = new Map();
      ctx.effect(() => () => { for (const w of watches.values()) w.dispose(); watches.clear(); },
        'delta: band watches');
      const watchOf = (sessionId) => { /* 同 ccmods：懒开、流结束即删 */ };
      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock', id: 'delta-band', order: 20, locale: NS,
        inject: (sessionId) => ({
          hooks: { band: watchOf(sessionId).store },     // -> useBand
          press: async (generation, actionId) => {
            const result = await ctx.remote.deltaUi.pressBand(sessionId, generation, actionId);
            if (!result.ok) throw result.error;
            watchOf(sessionId).store.set(result.value);
          },
        }),
      }, DeltaBand));
    }

    async function apply(ctx) {
      const disposeRemote = await ctx.remote.$mount(TYPERT_REMOTE);
      const ui = ctx.inject(['remote.deltaUi', 'slots', 'locale'], registerUi);
      try { await ui; }
      catch (e) { await ui.dispose(); await disposeRemote(); throw e; }
      return async () => { await ui.dispose(); await disposeRemote(); };
    }
    exports.apply = apply; exports.inject = inject;
  },
});
```

`DeltaBand` 组件（要点）：

```jsx
function DeltaBand({ useBand, press, t }) {
  const snap = useBand((v) => v);
  const [pending, setPending] = React.useState();
  const [notice, setNotice] = React.useState();
  if (!snap) return null;
  const onPress = (id) => {
    setPending(id); setNotice(undefined);
    press(snap.generation, id).then(() => setPending(undefined),
      (e) => { setPending(undefined); setNotice(t('press.failed', { message: String(e?.message ?? e) })); });
  };
  return (
    <div className="delta-band" role="group" aria-label={t('band')}
         data-delta-band data-tone={snap.view.tone} data-generation={snap.generation}>
      {/* mark/label/link/audience/people/progress … */}
      {snap.actions.map((a) => (
        <button key={a.actionId} type="button" disabled={a.disabled || pending !== undefined}
          aria-busy={pending === a.actionId} onClick={() => onPress(a.actionId)}>
          {a.label}{a.hotkey ? <span className="delta-band__hotkey">[{a.hotkey}]</span> : null}
        </button>
      ))}
      {notice ? <div role="status" className="delta-band__notice">{notice}</div> : null}
    </div>
  );
}
```

（纯 JS 版把 JSX 换成 `h(...)`；若走 TS 构建，产物仍是上面 `window.__ModuleLoader__` 形态。）

### 7.5 已知限制

- band 只在**已绑定 Session** 时渲染（`scope: session`）；Hero/无 session 态没有 band，与
  Claude Code 一致。
- 切 Session 会重挂载 band（组件 state 丢失）；瞬时态（spinner 帧、copied 计时）放 Client，
  语义态（share 进度、update 提示）放 Host。
- 若选命令过渡方案：每次按钮点击在会话里留下 `command/run` + `command/done` 行，且要求 session
  是 live 的。
- projection 只能承载日志可推导状态；不要试图用它送 presence/link。
- SRC 手写 Remote 属 Gateway 的 development fallback：无 strict 输入校验、端点撤销后不可降级；
  上生产优先 B1 生成物。
- 实验包路线（bridge + client-ui）把版本锁在 `0.2.2-rc.1`，且视觉词汇受限（§5.3）。
- Client 半无法被 client inspect 验证（本 profile 无 `dsh-cordis-client-runner`）；需要页面
  DevTools 或装该插件后再 inspect。
- 会话行：自定义 `ChatNodeKind` 在纯 JS 下能否被 Chat 渲染，本环境无法离线证实（§1.6 风险）。

### 7.6 需要 Lead 决策

1. **依赖策略**：允许引入 `@deepseek-ai/dsh-experimental-claude-code-mods` +
   `dsh-experimental-client-ui-claude-code-mods` 吗？推荐**不引入**，复制协议与渲染器。
2. **Remote 落地方式**：B1（接 typert generator，需造 monorepo 式布局）还是 B2（手写
   `ctx.typert.register` / SRC markers，先 spike 1 小时）？推荐 B1 若 delta-dsh 本来就有构建；
   否则 B2。
3. **过渡顺序**：先 C（按钮走 commands）让 band 可用，还是一次性做 B？推荐先做 B 的
   `watchBand` + 只读 band（Layout/数据先通），再补 `pressBand`；commands 只保留 `/delta` 用户入口。
4. **协议**：typed view model（推荐）还是照抄 ccmods 的 `SerializedNode` 树？前者保真，后者可直接
   复用现成渲染器。
5. **会话行范围**：v1 只做 band + `turnTail` 一行，还是同时做「远端作者」行（需要
   `uiConversation.events.register` + `conversation.chat.node` 自定义 kind）？推荐 v1 只做
   `turnTail`/`user.before`。

---

## 附：关键证据索引

| 结论 | 证据 |
|---|---|
| `dsh.client` 字段 | `[asar] dsh-client-modules/lib/client.js` `parseDshClient`；`README.md` |
| 懒工厂/模块表/HMR | `[asar] dsh-client-modules/README.md`、`dsh-client-hmr/README.md` |
| slot 目录与 props | `[asar] dsh-cordis-client-runner/lib/client.js` `CLIENT_SLOT_API` |
| slot API 语义 | `[npm:client-ui-slots@0.2.2-rc.1] README`、`lib/types/index.d.ts` |
| inject/hooks 绑定、崩溃边界 | `[asar] dsh-client-ui-renderer/lib/client.js`（`bindInjectSources`、`SlotErrorBoundary`） |
| band 参考实现 | `[npm:client-ui-claude-code-mods@0.2.2-rc.1] lib/client.js` |
| bridge 能力与事件表 | `[npm:dsh-experimental-claude-code-mods@0.2.2-rc.1] README.md`、`lib/types/api.d.ts`、`elements.d.ts` |
| Remote 调用契约 | `[npm:api-gateway] README.md`、`[asar] dsh-api-gateway/lib/client.browser.js` |
| commands 签名 | `[asar] dsh-commands/lib/typert.remote-client.js`；`[inspect] commands` |
| projection | `[npm:session-projection] README.md`；`[npm:api-session-controller] lib/types/client/sessions/projection-store.d.ts` |
| 主题 token | `[asar] dsh-client-ui-theme/lib/client.js`；`README.md` |
| locale | `[asar] dsh-client-locale/README.md` |
| 插件/包规范 | `[asar] dsh-agent-preset/skills/cordis-plugin-development/references/{ui-plugin,host-plugin,practices,verification,user-actions}.md` |
