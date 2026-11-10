# delta-dsh 引擎 shim 契约：Claude Code mod 引擎中 delta 用到的那部分（`on` + `$`）

本文是 `delta-dsh` 的「引擎 shim」实现规格。shim 的作用是让 `hooks/`（Delta 的 Claude Code
插件）**原样**运行在 DeepSeek Harness 之上：hooks 代码不改，shim 提供 Claude Code 2.1.318 mod
引擎的注册器（`on`）与 `$`（`EngineInterface`）。

- 类型来源：`.claude-plugin/types/claude-code/index.d.ts`（下称 **d.ts**，由 Claude Code
  2.1.318 生成，见 d.ts:1-3）。行号均指该文件。
- 运行时来源：`hooks/register.tsx`（唯一命名 `$` 的文件）、`hooks/core/host.ts`（`Host` 窄化
  后的 `$` 子集）、`hooks/hooks.json`（`modules: ["./register.tsx"]`）。
- 事实分级：**d.ts** = 声明与文档明说；**推断** = d.ts 未明说、由 delta 代码反推（第 5 节集中
  列出，正文用 `〔推断〕` 标注）。
- 结论先行：shim 需要实现的是 **1 个注册器 + 1 个分发器 + 1 个 `$` 工厂 + 16 个 `$` 命名空间
  的最小子集 + 12 个事件的派发**；不需要实现 classic hooks、流式事件（`turn.step`、
  `process.spawn` 的 hook 形态）、op 事件 hook 链、`engine.create`、plugin nouns、`$.state`、
  telemetry、model/audio/mcp、pane/backdrop/blit/focus/scroll 等。

---

## 0. 范围：delta 实际用到的面

`register.tsx` 只注册 22 个 hook（12 种事件），只经 `hostOf` 暴露 16 个命名空间的一部分方法
（`hooks/register.tsx:56-142`）。`Host` 类型（`hooks/core/host.ts:14-58`）就是 shim 必须提供的
**运行时最小面**；类型面则更大一点（hooks 从 `claude-code` 导入 17 个类型，见第 7 节）。

shim **不需要**：

- `classic.*` 事件（Claude 的 settings hooks 那一套）；delta 一个都没用。
- 流式 hook（`turn.step`、`process.spawn` 的 generator 形态）；delta 只把 `$.process.spawn`
  当作流的**调用方**，不作为 hook 注册者。
- op 事件链（d.ts:7162 `OpEventOf`：每个 `$.noun.method()` 本身都是可 hook 的事件）。
  〔推断〕delta 不 hook 它们，org 的守卫插件可能 hook；shim 可以直连实现，等价性损失记录在 §6。
- `engine.create`、plugin nouns、`$.state`、`$.telemetry`、`$.model`、`$.audio`、`$.mcp`、
  `$.ui` 的 pane/backdrop/blit/scroll/focus/selection/view/place/open/close/panes/notify/toast/
  notice 等。
- `claude plugin validate` 的静态扫描（"只允许在注册文件里写 `$.noun.method`"那条约束，
  见 `hooks/register.tsx:50-55`）。shim 直接接收已 transpile 的 `hooks/` 源码，不做该扫描。

---

## 1. 注册与匹配语义

### 1.1 模块与 `register()`

```ts
// d.ts:10011-10033
export type Register = (on: On, options: PluginOptions) => unknown
export type HooksModule = { register: Register }          // d.ts:5406-5408
export type PluginOptions = Readonly<Record<string, string | number | boolean | readonly string[]>>
```

- 模块导出 `register`，引擎以 `(on, options)` 调用；返回值被丢弃但会 `await`（d.ts:10011-10021）。
- delta 的导出是 `export function register(on: On)`（`hooks/register.tsx:144`），忽略 options。
- `options` 固定于一次激活；变更会重载模块并重新 `register`（d.ts:10013-10016）。shim 只需传
  `{}`，但**必须每次激活都重新调用 `register`**，因为 `.catch` 只能在该调用内同步挂上（§1.5）。
- 加载入口由 `hooks/hooks.json` 的 `modules` 指定（`./register.tsx`）。

### 1.2 `On` 的两个签名

```ts
// d.ts:7097-7101
export type On = {
  <P extends Pattern>(pattern: P, hook: HookFor<P>): Registration<HookFor<P>>
  <P extends Pattern, const M extends MatcherFor<P>>(pattern: P, matcher: M, hook: MatchedHook<P, M>): Registration<MatchedHook<P, M>>
}
```

运行时就是 `on(pattern, hook)` 与 `on(pattern, matcher, hook)` 两种；第二参数是函数即无 matcher。

### 1.3 选择集：事件名 / glob / 取反

```ts
// d.ts:7848, 5276, 6844, 11337, 6775
export type Pattern = EventName | '*' | `${Namespace}.*` | `!${Exclude<EventName | Glob, '*'>}`
```

`Selected<P>` 的语义（d.ts:11337）：

| pattern | 选中 |
|---|---|
| `'session.end'` | 同名事件 |
| `'*'` | 全部事件（telemetry 事件除外，d.ts:5278-5281） |
| `'ui.*'` | 所有 `ui.` 前缀事件（命名空间 = 点号前缀链，d.ts:6775） |
| `'!tool.*'` | 全部减去 `tool.*` |

delta 只用**具体事件名**，没有 `*`/glob/negation（`hooks/register.tsx:145-330`）。shim 可先只
实现具体名字，`*`/glob/取反留接口（实现成本极低，建议顺手做全，因为 org 守卫插件可能会用）。

### 1.4 matcher：静态形态与运行时算法

类型上 matcher 是 `e` 的深偏序（d.ts:6048-6056），运行时只认四种叶子（d.ts:6053-6070）：

| 叶子 | 语义 |
|---|---|
| 标量 `string/number/boolean/null` | `===` |
| `RegExp` | `regex.test(String(value))` |
| 数组 | 任一元素匹配即匹配（any-of） |
| 普通对象 | 值是对象且每个键按同样规则递归匹配（partial） |

嵌套深度上限 8（`NarrowDepth`，d.ts:6783）。matcher 只做**筛选**，不做 pin；匹配失败的分发根本
不会调用该 hook。

delta 用到的 5 种形态，shim 的匹配器必须精确覆盖：

| 注册点 | matcher | 命中条件 |
|---|---|---|
| `register.tsx:180` | `{ component: 'AbovePrompt' }` | `e.component === 'AbovePrompt'` |
| `register.tsx:186` | `{ component: 'AskUserQuestion' }` | 同上 |
| `register.tsx:192` | `{ component: 'UserMessage' }` | 同上 |
| `register.tsx:197` | `{ component: 'CommandOutput' }` | 同上 |
| `register.tsx:226` | `{ key: 'theme' }` | `e.key === 'theme'`（`config.set`） |
| `register.tsx:258,271,276,282,286,290,297` | `{ command: 'delta' }` 等 | `e.command === …` |
| `register.tsx:307` | `{ door: ['prompt','command','response','tool-result','delivery'] }` | `e.door` 是数组任一元素 |
| `register.tsx:309` | `{ door: 'tool-message', origin: { kind: 'tool', tool: /^(?!Skill$)/ } }` | `door === 'tool-message'` 且 `origin.kind === 'tool'` 且 `origin.tool` 不匹配 `Skill`（RegExp 按字符串测） |

注意最后一条：`origin.tool` 是工具名（`Task`/`Bash`/…），`/^(?!Skill$)/` 等价于「不是 `Skill`」
——shim 必须真的用 `String(value)` 去测正则，不能对非字符串直接判不等。

### 1.5 注册顺序、重复、`.catch` 的时机

- 同一插件的多条注册按注册顺序嵌套，**先注册的在链外层**（d.ts:7091-7092）。delta 的
  `ui.render` 四条注册按 component 区分，`session.append` 两条按 door 区分，互相不重叠。
- 「a repeat throws」（d.ts:7092）：重复注册会抛。**重复的判等键 d.ts 未定义**〔推断〕：应是
  `(pattern, matcher)` 结构相等；否则 delta 的 `ui.render`×4 与 `session.append`×2 在同名
  事件上必然抛错，与它实际能加载矛盾。shim 实现建议：`pattern` + matcher 的深结构相等。
- `.catch` 只能**同步**挂在 `on(...)` 返回的 `Registration` 上（d.ts:10015-10033）：第二次挂、
  `register()` 返回后挂、在 `engine.create` 上挂都抛。delta 全部遵守（`register.tsx:150,155,
  231,270,274,281,285,289,293,302,308,310,323,330`）。

### 1.6 失败与 `.catch`

```ts
// d.ts:1208, 1218-1233, 5370-5390
export type CatchHandler<F> = ($, e, next: Next & Caught) => R | undefined | Promise<Awaited<R> | undefined>
export type Caught = { readonly error: HookFailure; readonly called: boolean }
export type HookFailure = { readonly kind: 'throw' | 'timeout'; readonly message?: string; readonly budget: number }
```

失败语义（d.ts:4124-4132，内核级）：

- **无 `.catch`**：失败的 hook 被跳过（fail open）——它下面的 hook 与 core 照跑；若它此前已经
  `next` 过，则它**最后一次 `next` 的结果**作为该环结果；失败按名字上报（debug log）。
- **有 `.catch`**：在 grace（`catchMs`，1000ms）内运行 handler；handler 的返回即该 hook 的结果；
  handler 返回 `undefined` 视为「该 hook 缺席」（等价于没有 handler）。
- `next.error` 只在 catch handler 里出现，普通 hook 的 `next.error` 是 `undefined`，其存在与否
  就是「现在是不是 handler」的判据（d.ts:1225-1229）。
- catch 里 `next` 是 **replay-safe** 的：`next.called === true` 时 `next(e)` 直接返回失败 hook
  最后一次调用的结果（不重跑下层、参数被忽略）；`called === false` 时重跑下层一次，之后再调用
  则 replay（d.ts:1228-1233）。
- 事件结果形状不对（"answers a wrong shape"）也算失败（d.ts:4994-4998 附近，EngineEventOf 头
  注释）。shim 必须做结果形状校验，否则 delta 的 `.catch` 语义对不上。

delta 的用法：
- 除 `prompt.submit` 外全部 fail open：catch 里 `return next(e)`（`register.tsx:150,231,270,…`）。
- `prompt.submit` 的 catch **拒绝**该 prompt：`return { drop: '…' }`（`register.tsx:155-158`）。
  → 这是全插件唯一 fail-closed 的地方，shim 必须让 catch 的返回值真的作为该 hook 的结果被使用。
- delta 从不读 `next.called`、`next.budget`、`next.signal`、`next.origin`、`next.trace`、
  `next.event`、`next.is`、`next.to`（全仓库 grep 为 0，`hooks/register.tsx` 内只出现
  `next.error` 与 `next(e)`）。→ shim 必须实现这些类型，但运行时可以只保证 `next(e)`、
  `next.error`、`next.called` 三个可用；其余可给桩值。
- `logHookFailure`（`register.tsx:37-43`）只看 `kind === 'throw' | 'timeout'`。

### 1.7 `next` 契约

```ts
// d.ts:6859-6945
next(e): Promise<下游结果>            // 每次调用都重新跑下层的 hook
next.to(e, tier): Promise<…>         // 跳过 tier 之间的 link（delta 不用）
next.signal: AbortSignal             // 本次分发被放弃时 abort（delta 不用）
next.is(pattern, e): e is …          // 类型谓词（delta 不用）
next.event: EventName                // 本次分发的事件名（delta 不用）
next.origin: Origin                  // { plugin, tier }（delta 不用）
next.trace: readonly TraceEntry[]    // 正在跑/已跑的下层链（delta 不用）
next.budget: NextBudget              // { ms, remainingMs }，每次读刷新（delta 不用）
```

- 不给参数调用 `next()` 会 reject 并指名 hook（d.ts:6851-6853）。
- 「不调用 `next` 就返回」= 主动结束链；「什么都不返回（`undefined`）」= 失败（d.ts:6851-6854）。
- 传入的 `e` 是**冻结对象到任意深度**；改写 = 复制一份传给 `next`（d.ts:5033-5036）。
- 下层最底是 core；`next` 在 core 下面会 reject。
- `next` 每个 dispatch 每个 hook 构造一次并冻结。
- **`next` 不是一次性的**：普通 hook 里每次调用都会重跑下层（d.ts:6849-6851）；只有在 `.catch`
  handler 里当 `next.called === true` 时才换成 replay（返回最后一次结果、不重跑）。delta 的正常
  路径只调一次、catch 里再调一次，所以 shim 必须同时支持「重跑」与「replay」两种语义。

**重入（`$` 调用引发的同事件链）** —— 对 delta 至关重要：

- 「`$` 调用跑的链会跳过**调用中的那个 hook**，其余照跑」（d.ts:5033-5036, 7162-7169）。
- 〔推断，高置信，`hooks/watch/rows.tsx:69-77` 注释明写〕从**后台代码**（没有 hook 帧，例如
  `clock.after` 回调、`ui.render` 之外的异步续体）发起 `$` 调用时，**该插件自己的所有 hook 都被
  跳过**。delta 的 `/delta show <id>` 自绘管线正建立在这条上：`command.run` 从 `ui.render`
  hook 里发起 → 只跳过那个 `ui.render` hook，所以自己的 `command.run` hook 仍会跑；从后台发起
  → 自己的 `command.run` 被跳过，命令无输出。
  shim 必须按「当前 hook 帧栈」做同插件跳过，不能只按「插件」一刀切。

### 1.8 结果放行 / 拒绝 / 丢弃总表（engine 侧行为）

| 事件 | delta 返回值 | engine 的行为 |
|---|---|---|
| 全部只读事件 | `next(e)` 的结果（转述） | 用 core 结果，hook 的结果不改变事实（`session.start/attach/end`、`turn.start` 的回显值被忽略） |
| `prompt.submit` | `next(e)` 结果 / `{ drop: string }` | `drop` → prompt **不进入**，`drop` 文案展示给用户；`next` 之后才 `{drop}` 会 fail 该 hook（d.ts:9785-9812） |
| `tool.call` | `next(e)` 结果（含 `result`/`isError`） | `{ deny }` → 模型读到错误结果；`{ result }` → 代替工具结果；`next` 之后 deny 只会「扣下」结果，不回滚（d.ts:4143-4152） |
| `command.run` | `{ text }` / `{}` | 不调 `next` 直接 `{text}` → 不跑 core 命令，`text` 作为该命令输出（d.ts:4438-4452） |
| `session.append` | `next(...)` 的存储结果 | 不调 `next` 或返回别的行 → 该 hook 被跳过（d.ts:11551-11579） |
| `session.send` | `next(...)` / `{ isDelivered:false, reason }` | 后者且未调 `next` → 拒绝发送，模型读到 `reason`（d.ts:12559-12579） |
| `config.set` | `next(e)` 结果 | `{ deny }` → 该行不变，菜单显示原因（d.ts:4465-4479） |
| `turn.complete` | `next(e)` 结果 | `{ text }` 与主循环答案不同则展示在其下；不改 transcript（d.ts:4670-4690） |
| `ui.render` | RenderElement / `next(e)` | 返回树即绘制；返回 `next(e)` 即引擎自己的绘制；非法树/抛错 → 画引擎的（d.ts:4160-4172） |
| `session.start/attach/end`、`turn.start` | 原样转述 | 值被忽略，只当事实（§3） |

---

## 2. `hostOf($)` 每个成员的契约

### 2.0 `$` 的作用域

`$` 是**每个 hook 分发的第一个参数**：

- 「同一个对象在每次调用中都一样」（d.ts:5030-5036），但「`$` 携带收到它的那个 hook 的上下文」
  （`hooks/register.tsx:50-55`）——delta 在每个 handler 顶部 `const host = hostOf($)`
  （§2 各处的 `register.tsx` 行号），因此 **`$` 必须按 dispatch 绑定**：至少 `agentId`/`cwd`
  这类上下文要按分发解析（d.ts:3038-3048 说"timer 活过 hook 时读的是 session 的目录，需要
  hook 的目录就在 hook 里先读出来"）。
- 〔推断〕delta 实际依赖的上下文只有 `session.id()`（几乎每个 handler 都调）与
  `session.cwd()`；`$.session.id()` 在子代理 hook 里也必须返回**主会话 id**（`register.tsx:47`
  用 `e.agentId` 区分，而不是让 `$` 换会话）。→ shim 可以「一个进程一个 `$`」，但建议保留
  按 dispatch 携带 `agentId` 以贴合 `cwd` 语义。

下表：`d.ts` 签名 → 语义 → delta 的绑定/用法 → shim 最低要求。**粗体**是 delta 真正调用的成员。

### 2.1 `plugin`（d.ts:2355-2366）

```ts
plugin: { name: string; root: string }
```

- `name`：plugin.json 的名字（debug/`ui.log` 行带它）；`root`：含 plugin.json 的插件目录，绝对路径。
- delta：`register.tsx:94-97`。`name` 用于 `command.run` 的 origin 自识别（`register.tsx:266`）
  与命令回声改写（`delivery.ts:793`）；`root` 用于**读 `${root}/.claude-plugin/plugin.json`**
  取版本（`delivery.ts:363`、`plugin-update/updates.ts:86,116,270`）。
- shim 最低要求：`name = 'delta'`；`root` 指向一个**真的存在 `.claude-plugin/plugin.json` 且含
  semver `version`** 的目录（delta 对其做 `/^(0|…)\.(0|…)\.(0|…)$/` 校验）。

### 2.2 `ui`（d.ts:2369-2681）

| 成员 | d.ts 签名 | 语义 | delta 用法 |
|---|---|---|---|
| **log** | `(text: string, options?: UiLogOptions) => void`（d.ts:2453） | 追加一行。默认 `to:'transcript'`：transcript 里一条**自己的 dim 系统行**，不进模型上下文；`{to:'debug'}` 只进 debug log（行首带插件名），每行 1 万字符上限；终端画前 2000 字符。**同步、返回 void**、不 reject。以 `ui.log` op 事件抛给 hook，hook 可改 `to`（delta 不 hook）。 | `register.tsx:237`（version 警告→transcript）、`logHookFailure`（→debug）、大量 debug 日志 |
| **status** | `(text: string \| undefined) => void`（d.ts:2516） | 每个插件**一条**状态行，钉在 prompt 下方，下次调用替换；`undefined` 清除。同步 void。 | `session-state.ts:330`、`delivery.ts:541`、`band/band.tsx` 进度 |
| **invalidate** | `(event: InvalidatableEventName) => void`（d.ts:2399） | 重跑可缓存事件：`'ui.render'`（本插件可画的实例）与其他缓存事件。重画限速：10 次/秒，终端已显示 pane/band/prompt hint 时 30 次/秒（更频繁的调用被折叠）。同步 void。 | `register.tsx:136`（`hostOf` 固定传 `'ui.render'`）、`rows.tsx:76`、`delivery.ts:199,217,543,577,700,713`、`band.tsx:96,117,129` |
| **resolve** | `<E extends ResolveInput>(e: E) => Elements[E['surface']]`（d.ts:2436） | **同步读**，不是分发：`ui.resolve` 事件在加载时已对每个 surface×component 跑过。返回该 surface 的冻结元素表（`Box/Text/Button/Link/Code/Markdown/Input/Select/Client/…`）。 | `register.tsx:138`；`band.tsx:407`、`rows.tsx` 等解构 `{ Box, Text, Link, Button, Markdown }` |
| **copy** | `(args: UiCopyArgs) => Promise<UiCopyResult>`（d.ts:2646） | 写某 surface 剪贴板；`{isCopied:true}` 或 `{isCopied:false, reason:'no-surface'\|'no-clipboard'\|'refused'}`。**不 reject**。 | `band.tsx` 的 copy 按钮 → `{isCopied}` 判断 |
| **ask** | `(question: string, options?: readonly string[] \| AskOptions) => Promise<string>`（d.ts:2469） | 引擎自己的 AskUserQuestion 对话框；返回 label / 多选逗号连接 / "Other" 自由文本；**被关闭或 `-p` 时 reject**。`AskOptions = { options?, header?, multiSelect? }`（d.ts:692-703）。 | `interaction.ts:204`（`ownQuestions++` 包裹）；`register.tsx:186` 的 `ui.render` hook 靠这个计数区分「插件自己的问题」不去记录 |

shim 最低要求：`log`/`status`/`invalidate` 同步且不抛；`resolve` 产出的元素表能让
`<Box>/<Text>/<Button>/<Link>/<Markdown>` 构造出 `RenderElement`（§4.8）；`ask` 要么真实现，
要么按「TypeError 同步抛 = 交互不可用 / 其他 reject = 用户取消」的 delta 容错约定来退化
（`interaction.ts:197-218`）——**注意**：非 TypeError 的 reject 会被 delta 当成"用户取消"，
`/delta` 菜单会静默返回 `{}`，不给用法文本。这是行为差异，见 §6。

### 2.3 `session`（d.ts:2839-3031）

| 成员 | d.ts | 语义 | delta |
|---|---|---|---|
| **messages** | `SessionMessagesCall`（d.ts:12164，含 5 个重载） | 无参 → `SessionMessage[]`（**最多 4096 条**，`{role,text,toolUses,toolResults?}`）；`{as:'api'}` → `ApiMessage[]`（`{role,content}`，块原样，最多 4096 条，以 user 开头）；`{agentId}` → 该 agent 的行，读不到 → `{deny:string}`；`{as:'api',agentId}` → API 形或 deny。主会话**不 reject**。 | `register.tsx:109-111` 绑 4 个方法；`share.ts:146,149`、`thread-runs.ts:461`、`subagents.ts:158,377`、`thread-runs.ts:328,520` |
| **cwd** | `() => Promise<string>`（d.ts:2879） | 会话工作目录，绝对；子代理 hook 里是该 loop 的目录。 | `share.ts:69`、`sharing/join` 等 |
| **root** | `() => Promise<string>`（d.ts:2887） | 项目根：启动目录，或被 `/cd`/worktree 移动后的位置。 | `delivery.ts:232`、`updates.ts:116,250`、`join.ts:423` |
| **turns** | `() => Promise<number>`（d.ts:2896） | 本会话用户已发 prompt 数。**0 ⇒ delta 判为 startup**（`activation.ts:249`）。 | `register.tsx:118` |
| **id** | `() => Promise<string>`（d.ts:2900） | 会话 id（Claude 里是 transcript 文件名）。delta 用它作 store 键、与 `session.end` 的 `e.sessionId` 对齐。 | 几乎所有 handler |
| **surfaces** | `() => Promise<readonly RenderSurface[]>`（d.ts:2920） | 会话绘制的所有 surface，一次性每个；终端在 REPL 下是 `terminal`；`-p`/SDK 下**空**；**never rejects**。 | `commands.ts:26,59,76,129`、`activation.ts:515,596`、`join.ts:122`、`updates.ts:137,258`；判定函数 `hasInteractiveSurface` 只认 `'terminal' \| 'desktop'`（`sharing/lifecycle.ts:10-12`） |
| **version** | `() => Promise<SessionVersion>`（d.ts:2967） | `{version, base?, builtAt?}`。delta 用 `base ?? version` 判 Claude 版本兼容并警告（`register.tsx:235-237`）。 | `register.tsx:119,235` |
| **append** | `(args: SessionAppendArgs) => Promise<SessionAppendResult>`（d.ts:3005；类型 11406-11432） | 给会话追加一行：`{message:{type:'user'\|'system', content: text 块}, agentId?}`；`{deny:reason}` = 被上面的 hook 拒了、什么都没存。 | `register.tsx:112`；`watch/rows.tsx:58,140`（把 Delta 的 note 塞进模型上下文） |
| `usage/compact/send/authorize/identity/model/repo/surface` | — | 不用 | — |

shim 最低要求：`id` 稳定且与 `session.end` 一致；`messages()` 必须能产出 delta 认的
`ApiMessage` 块（`text`/`tool_use{id,name,input}`/`tool_result{tool_use_id,content,is_error}`，
`recording/snapshot.ts:23-51`、`content.ts:9-36`）；`turns()` 在会话开始后为 0。

### 2.4 `turn`（d.ts:3034-3055）

```ts
turn: { abort: (input: { turnId: string }) => Promise<void> }   // op 事件 'turn.abort'（d.ts:7267-7269）
```

- 取消主循环正在跑的 turn（id 来自 `turn.start`）；`turnId` 不是当前 turn 时报错并点出两个 id。
- delta：`register.tsx:130-132`；`delivery.ts:743`（turn.start 里持久化失败时中止该 turn）。

### 2.5 `prompt`（d.ts:3056-3142）

```ts
prompt.submit: (input: PromptSubmitArgs) => Promise<PromptSubmitResult>   // 4937
```

- 与用户敲入同样的 `prompt.submit` 事件，跳过调用中的 hook，`e.origin` 为
  `{kind:'plugin', name}`；空闲后才起 turn；`{drop}` 表示没进入。
- delta：`register.tsx:102-104`；`thread-runs.ts:307` 用 `{text}` 向子会话发消息。

### 2.6 `tool`（d.ts:3145-3196）

```ts
tool.call: (input: ToolCallArgs) => Promise<ToolCallResult>   // 13819-13831
tool.list / tool.check / tool.register   // delta 不用
```

- 走 `tool.call` 事件链（跳过调用 hook）、权限检查与对话框，然后跑工具；没有该名字的工具/被中止
  则 reject。
- delta 只用一次：`register.tsx:127-129` → `$.tool.call({ tool: 'TaskStop', task_id })`
  （`subagents.ts:683`，停一个后台子代理）。`TaskStop` 的入参声明在
  `.claude-plugin/types/claude-code-tools/index.d.ts:752-757`（`task_id?: string`）。
- shim 最低要求：要么实现一个叫 `TaskStop` 的等价工具（返回任意 `ToolCallResult`），要么让它
  reject 且 delta 的调用点在 try 里；不要让它静默返回 `{}` 冒充成功。

### 2.7 `command`（d.ts:3198-3237）

```ts
command.list: () => Promise<CommandInfo[]>          // {name, description, source, plugin?}
command.run: (input: CommandRunArgs) => Promise<CommandRunResult>   // { text?, context?, exitCode?, ref? }
command.register: (command: CommandSpec) => Promise<{ command: string }>  // {name, description, argumentHint?, immediate?}
```

- `run` 等价于用户敲 `/name args`，排队到空闲后跑；`e.origin` 为 `{kind:'plugin',name}`；未知名字
  会 reject。
- `register` 在 `session.start` 内可用（"rejects until the session binds, at session.start"，
  d.ts:3230-3236）。
- delta：`register.tsx` 的 `command.run` 处理器 **7 条**；`registerCommands` 在 `session.start`
  里注册 7 个命令（`setup/commands.ts:40-51`）；`command.list` 用于 join 前的能力检查
  （`join.ts:215-221` + `lifecycle.ts:15-17`，要求 `source === 'builtin'`）；`command.run`
  被 delta 自己用来画行（`rows.tsx:110`）。
- shim 最低要求：`register` 后 `list` 立刻可见；`run` 的返回 `{text}` 要能变成命令输出行
  （见 §5 的 transcript 格式）；从 hook 内发起的 `run` 要跑到自己 `command.run` hook（§1.7 重入）。

### 2.8 `config`（d.ts:3240-3270）

```ts
config.list: () => Promise<ConfigRow[]>   // {key,label,description?,kind,value,options?,provider,isLocked}
```

- delta：`register.tsx:73-75`；`config.list()` 在 2 个文件用（读 `theme` 等行）。
- `config.set` 只作为**事件**被 hook（`register.tsx:226`），delta 从不调用 `$.config.set`。

### 2.9 `agent`（d.ts:3309-3368）

```ts
agent.list: () => Promise<AgentInfo[]>    // 见 d.ts:125-187：{id, teammateId?, description, type, status, parentId?, spawnedBy?, name?}
agent.spawn: (input: AgentSpawnArgs) => Promise<AgentSpawnResult>   // {model, agentId} 或 {deny}
```

- `spawn` 总是后台跑；answer 走该 agent 的 `turn.complete`。
- delta：`register.tsx:58-61`；`subagents.ts:153`（按 id 找 agent）、`thread-runs.ts:264`
  （`spawn({prompt, description, subagentType:'general-purpose', cwd})`）、`thread-runs.ts:445,460`
  （按 `status` 过滤）、`join.ts:65,144`（后台 agent 是否活跃）、`subagents.ts:683`。
- shim 最低要求：`list()` 的 `id`/`status`/`type`/`spawnedBy` 语义要与 `turn.*`、`tool.call`
  的 `agentId` 同一套 id；`status ∈ 'pending'|'running'|'waiting'|'idle'|'completed'|'failed'|'killed'`
  （d.ts:566）。

### 2.10 `fs`（d.ts:3369-3496）

```ts
fs.read: ((path: string) => Promise<string>) & ((path, {as:'bytes'}) => Promise<{base64:string}>)
fs.write: (path: string, text: string) => Promise<void>
fs.list: (path?: string) => Promise<FsEntry[]>       // {name, kind:'file'|'dir'|'other', size, mtimeMs, isLink}
fs.exists: (path: string) => Promise<boolean>        // 只有网络位置才 reject
fs.stat: (path: string, options?: {resolve: boolean}) => Promise<FsStat>  // {kind,size,mtimeMs,isLink,realPath?}；缺失 ENOENT
```

- 相对路径相对 **会话工作目录**；UTF-8；单文件读/写超 **4 MiB reject**；网络位置不触碰。
- delta：`register.tsx:84-90`；47 处调用（读 transcript、读插件 manifest、写 outbox、建 worktree
  等）。注意 `delivery.ts:136` 写、`delivery.ts:152` 读、`recording/title.ts:151,175` stat/read
  一个可能很大的 transcript（用 `tail` 分流，超 4 MiB 只能放弃标题）。
- shim 最低要求：保留 4 MiB 读上限（delta 有 `FS_READ_LIMIT` 分支，见 `title.ts:99`）；`exists`
  对 ENOENT 返回 false 而不是 throw；`stat` 对缺失抛错（delta 用 `.catch(()=>undefined)` 依赖它）。

### 2.11 `store`（d.ts:3497-3529）

```ts
store.get: (key: string) => Promise<unknown>
store.set: (key: string, value: unknown) => Promise<void>   // 必须 JSON 数据；读回 JSON.parse(JSON.stringify(v))
store.delete: (key: string) => Promise<void>
store.keys: () => Promise<string[]>                          // 插入顺序
```

- 跨会话持久；**全部键的 JSON 总量超 4 MiB reject**；函数/环 reject。
- delta：`register.tsx:121-126`；202 处调用，键形如 `session:<id>`（`session-state.ts:395`）。
- shim 最低要求：JSON 往返语义一致（delta 传 `structuredClone` 后的数据）；按键前缀枚举
  （`keys()`）是 delta 清理已结束会话的唯一手段之一，必须返回全部键。

### 2.12 `clock`（d.ts:3572-3614）

```ts
clock.now: () => Promise<number>                       // 毫秒 epoch
clock.sleep: (ms: number, options?: {signal?: AbortSignal}) => Promise<void>  // abort 立刻 reject
clock.after: (ms: number, fn: () => void) => Timer      // 同步返回 { cancel }
clock.every: (ms: number, fn: () => void) => Timer      // ms >= 1；回调是引擎侧的 clock.after/every 事件
```

- **`after`/`every` 是同步返回 Timer**（d.ts:13790-13803），回调在插件的环境里跑；插件热重载会
  取消 pendding waits。
- 预算细节：hook 的 budget 在 `$.clock` 等待期间**继续走**（唯一例外，d.ts:3584-3602）。
- delta：`register.tsx:62-67`；`clock.after` 用于延迟重试/退避（`rows.tsx:74` 的 drawQueue、
  `updates.ts` 定时器）、`clock.sleep(ms,{signal})` 用于轮询（`join.ts:202`、
  `thread-runs.ts:271`、`subagents.ts:562,575`）。
- shim 最低要求：`after/every` 的返回值必须有 `cancel()`；`sleep` 的 `signal` 必须真的提前
  reject（delta 依赖它做 deadline 竞速）。

### 2.13 `http`（d.ts:3615-3643）

```ts
http.fetch: (url: string, init?: HttpInit) => Promise<HttpResponse>   // {status, ok, headers, text}
// HttpInit: { method?, headers?, body?, auth?, socketPath? }
```

- 经宿主发；`auth` handle 来自 `session.authorize()`；`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`
  会拒带 `auth` 的请求。
- delta：`register.tsx:91-93`；3 处（`delta-cli`/watch 与 Delta 服务器通信）。

### 2.14 `process`（d.ts:3644-3707）

```ts
process.run: (argv: readonly string[], init?: ProcessRunInit) => Promise<ProcessRunResult>
// ProcessRunInit: {cwd?, env?, stdin?, timeoutMs?}；默认 30s，上限 10 分钟
// ProcessRunResult: {exitCode, stdout, stderr, isStdoutTruncated, isStderrTruncated}
//                  每条流保留前 4194304 字节（4 MiB），截断时 flag 为 true

process.spawn: (request: ProcessSpawnRequest) => HookStream<ProcessSpawnChunk, ProcessSpawnResult>
// ProcessSpawnRequest: {argv, cwd?, env?, input?}
// chunk: {stream:'stdout'|'stderr', text}；从不空、从不切断多字节字符；未读满 1048576 字符则子进程阻塞
// 结果: {code: number|null, signal: string|null}
```

- **无 shell**；`run` 一次性读完，进程留在后台写会让调用挂到超时；无法启动/超时 reject。
- `spawn` 是 `AsyncGenerator`：**离开循环、`return()`、`next.signal` abort、模块卸载都会杀子进程**，
  其它都不会（hook 返回也不会）。
- delta：`register.tsx:98-101`；34 处。`process.run` 用于 git/`open`/CLI 一次性调用，超时
  `OPEN_TIMEOUT_MS=5000`（`interaction.ts:65`）；`process.spawn` 用于流式读 transcript
  （`title.ts:186`，用 `stream.next()` 逐块读、超时后 `stream.return(...)` 杀）、CLI `--json`
  流（`cli/delta-cli.ts:103,311,415`）、交互式集成（`interaction.ts:30`）。
- shim 最低要求：`spawn` 的 `return()` 必须杀进程并让 `for await` 结束；chunk 不得跨块拆多字节
  字符（delta 的 JSON 行扫描器按块拼接，`title.ts:198-207`）。

### 2.15 `settings`（d.ts:3709-3754）

```ts
settings.read: {
  (args: { key: string }): Promise<unknown>
  (args?: { source?: SettingsSource }): Promise<Settings>
}
// SettingsSource = 'user'|'project'|'local'|'flag'|'policy'（12835）
```

- delta 只用 `{source:'policy'}`（`register.tsx:105-107`），读组织托管设置（`policy` = 所有
  managed 层合并）。
- shim 最低要求：返回 `{}` 是安全退化（delta 对空 policy 有默认路径），但**不能 reject**。

### 2.16 `env`（d.ts:3756-3783）

```ts
env.get: (name: string) => Promise<string | undefined>
env.set: (name: string, value: string | undefined) => Promise<{ deny?: string }>
```

- `name` 必须是**字符串字面量**（`claude plugin validate` 据此列出读写项）；未设 → `undefined`。
- delta 只用 `get` 6 个变量（`register.tsx:76-83`）：`CLAUDE_CODE_REMOTE`、`CLAUDE_CONFIG_DIR`、
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`、`HOME`、`OS`、`USERPROFILE`。
- shim 最低要求：`OS` 在 Windows 上返回 `'Windows_NT'`（delta 据此选 PowerShell/tail 分支，
  `title.ts:70-84`、`install-update`）；`CLAUDE_CODE_REMOTE` 语义（delta 用 `'true'|'false'` 判
  执行位置，`delivery.ts:368-372`）；`CLAUDE_CONFIG_DIR`/`HOME` 决定 transcript 路径与 store 位置。

---

## 3. 事件逐字段契约

### 3.0 通用派发模型

对每个事件 `N`：

1. 收集本插件所有 `pattern` 选中 `N` 且 matcher 命中的注册（按注册顺序，先注册者在**外层**）。
2. 构造冻结的 `e`（深冻结）与 `next`。
3. 依次调用 hook；「最后返回的结果」= 该事件的结果；最内层是 core。
4. hook 抛错/超时/返回错形状 → §1.6（有 `.catch` 则问它，否则 fail open）。
5. 返回值规则见 §1.8。
6. 事件 `e` 的名字集合：`session.start`、`session.attach`、`session.append`、`session.end`、
   `session.send`、`prompt.submit`、`turn.start`、`turn.complete`、`tool.call`、`command.run`、
   `ui.render`、`config.set`。

### 3.1 `session.start`（d.ts:4530-4539 文档；输入 12609-12627；结果 12630-12635）

| 字段 | 类型 | delta 读 |
|---|---|---|
| `cwd` | `string`（绝对，= `session.cwd()`） | 否（自己调 `session.id()`） |
| `surface` | `RenderSurface \| null`（终端下 `terminal`；`-p`/SDK 为 null） | 否 |
| `isInteractive` | `boolean`（REPL true；`-p`/SDK false） | 否 |

- 结果：`{ cwd }`，core 回显；hook 的值不改变会话。
- 时机：**每个插件每进程一次、在首个 prompt 之前**，且是「awaited」的——「第一次是 await 的：
  `$.tool.register` 在第一轮就可见」（d.ts:4531-4534）。**Claude 在 hook 返回后才投递第一个
  prompt**（`register.tsx:245-249` 注释）。
- delta 行为（`register.tsx:233-256`）：读 version → 兼容性警告 → `registerCommands` →
  `next(e)` → `clock.after(0, installationUpdates.check)` → `session.id()` → `startPluginUpdates`
  → `activate` → **await `handoffClaim`** → `noticeStart`。注意：**大部分工作在 `next(e)` 之后
  仍在继续**，且要求返回前全部完成（否则第一个 prompt 时 delta 未激活）。
- 失败/超时：fail open（无 `.catch`），`next(e)` 代跑；但「完整执行」是 delta 激活成立的前提。
- shim 最低要求：`session.start` 必须是**可 await 的、在第一条 prompt 之前完成**的分发；分发期间
  `command.register` 可用；hook 返回后 `$` 仍可用（delta 在 `next` 后继续用 `$`）。

### 3.2 `session.attach`（文档 4580-4599；输入 11581-11599；结果 11602-11606）

| 字段 | 类型 | delta 读 |
|---|---|---|
| `surface` | `RenderSurface` | **是**（`register.tsx:148`） |
| `clientId` | `string`（未命名客户端为 `<surface>:default`） | 否 |
| `viewport?` | `{columns, rows, isFullscreen?}` | 否 |

- 结果：`{ clientId }`，core 回显。
- delta：只有 `e.surface === 'desktop'` 时做 `recheckPluginUpdates`；桌面/远端 attach 才触发。
- 失败：fail open。shim 可只在会话有 UI 时合成一次（surface 由 §6 决策定），否则 delta 的更新
  复查不会跑（可接受退化）。

### 3.3 `session.append`（文档 4559-4563；输入 11444-11479；结果 11551-11579）

输入（**引擎为每一行发一次**，在存储前）：

| 字段 | 类型 | delta 读 |
|---|---|---|
| `message` | `SessionAppendMessage`（11481-11549）：`{type:'user'\|'assistant'\|'attachment'\|'system', name?, role?:'user'\|'assistant', isMeta?:true, content: ApiContentBlock[]}` | **是**（`content.ts:9-36`、`delivery.ts:798-801`） |
| `door` | `'prompt'\|'command'\|'response'\|'tool-result'\|'tool-message'\|'delivery'\|'attachment'\|'hook-context'\|'note'\|'compaction'\|'notice'\|'queue'`（11434） | **是**（两条 matcher、`capturedMessage`） |
| `origin` | `SessionAppendOrigin`（11522-11549）：`PromptOrigin \| PromptAttachmentOrigin \| {kind:'model', model} \| {kind:'tool', tool}` | **是**：`{kind:'plugin', name}` 用于识别本插件命令的回声（`row-delivery.ts:109-113`） |
| `uuid` | `string`（与 transcript 文件一致） | **是**（`delivery.ts:791-793, 831`） |
| `agentId?` | `string`（子代理 loop 的会话） | **是**（`register.tsx:47`） |

要点：
- **door 由引擎从行本身判定**，是"封闭集合，pin 在事件上、也是 matcher 收窄的键"（d.ts:11426-11433）。
  delta 的分类依赖它：`prompt`/`delivery` 是人的输入，`tool-result`/`tool-message` 是工具结果，
  `attachment/hook-context/notice/compaction/note` 不进 Delta 记录（`content.ts:22-36`）。
- `message` 可被 `next({...e, message})` 改写 `content`（文本块 / tool_result 的 `content`、
  `is_error`）；`type/name/role/isMeta` 是 pinned（改了该 hook 失败）。delta 改写 `content`
  （`delivery.ts:791-795`：把插件自己的 `show` 回声改成空）。
- 结果：`{message, uuid}`（存储后的行）或 `{deny:reason}`（**只有插件自己的 append（door
  `note`）可被拒**）。delta 检查 `!('deny' in stored)`。
- 「hook 必须转述 `next` 的结果；不调 `next` 或返回别的行 → 该 hook 被跳过」。
- shim 最低要求：**这是 delta 记录的主动脉**。DSH 必须为「用户 prompt / 模型响应 / 工具结果 /
  插件命令回声与输出 / 附件 / 通知」合成这些行，door 必须按上述集合分类，且 `origin` 要能表达
  `plugin`。否则 delta 全部记录功能失能。
- 失败/超时：fail open（`.catch` → `next(e)`）。**超时 = 该行照存，但 Delta 记录缺这一行**
  （delta 的 catch 只是放行，不补记）。`{deny}` 只对插件自己的 append 有意义。

### 3.4 `session.end`（文档 4624-4631；输入 11927-11953；结果 11961-11966）

| 字段 | 类型 | delta 读 |
|---|---|---|
| `reason` | `'clear'\|'resume'\|'logout'\|'prompt_input_exit'\|'other'`（`SessionEndReason`，11955） | **是**（`forgetSessionStart`、`releaseOnEnd`） |
| `sessionId` | `string`（`session.id()` 直到此刻） | **是** |
| `resume` | `SessionResume`（`--resume` 用） | 否 |

- **硬约束**：整条链共享**一个很短的 wall-clock 上界（默认 1.5 s）**，它包含 hook 的 `$` 等待与
  core；到点 `next.signal` abort，进行中的 `$` 调用一起被中止（d.ts:11916-11925）。
  `next.budget` 在这里读这个上界（d.ts:6947-6972）。
- `clear`：`/clear` 就是这样——会话结束、进程在新 session id 下继续，且**不再发 `session.start`**。
- delta 行为（`register.tsx:201-223`）：`stopPluginUpdates` → `forgetSessionStart` → 取消请求 →
  `forgetSubagents` → `endActivationOf` → `resetRuntime` → `stopWatching` → 忘掉
  contract/title/thread notes → 清进度 → `markEnded`（**store 写**）→ `releaseOnEnd`（可能
  发 HTTP/CLI）→ 最后 `next(e)`。
- 失败/超时：无 `.catch`（fail open），但**超时 = 收尾丢失**——delta 的 `markEnded` 记录
  「何时结束」，丢了会导致后续会话清理逻辑退化。
- shim 决策点：是否保留 1.5s 硬上界（§6）。保留则必须把 `$` 等待也计入；否则 delta 收尾更可靠
  但与 Claude 语义不同（Claude 里这些收尾本来就是尽力而为）。

### 3.5 `session.send`（文档 4570-4575；输入 12491-12527；结果 12559-12579）

| 字段 | 类型 | delta 读 |
|---|---|---|
| `to` | `string`（SendMessage 的收件人拼写：名字、agent id、收到过的 `from` 地址） | **是**（`register.tsx:315`） |
| `text` | `string`（收件人读到的正文） | **是** |
| `origin` | `{kind:'model'} \| {kind:'plugin', name}` | 否 |
| `agentId?` | `string`（发送方 loop） | **是**（`register.tsx:316`） |

- 结果：`{isDelivered:true}` 或 `{isDelivered:false, reason}`；`next({...e, to, text})` 可改写并
  重新判址；未调 `next` 直接返 `{isDelivered:false,reason}` = 拒绝发送，模型读到 `reason`。
- delta（`register.tsx:312-323`）：非字符串 `to` 或本会话不记录子代理 → `next(e)`；否则
  `sendToThread(...)`，`sent ?? next(e)`；catch 返回 `{isDelivered:false, reason}`。
- shim 最低要求：`to` 必须是**字符串**（delta 判 `typeof e.to !== 'string'`）；`agentId` 与
  `$.agent.list()` 的 id 同一套。
- 失败/超时：fail open（catch 返回 `{isDelivered:false, reason}`，**这是 delta 唯一主动构造该结果的
  事件**）→ 超时/抛错时消息不会被发出，模型读到理由。

### 3.6 `prompt.submit`（文档 4284-4292；输入 9736-9812；结果 9814-9854）

| 字段 | 类型 | delta 读 |
|---|---|---|
| `text` | `string`（已展开粘贴、将到达模型的文本；slash 命令时是 `command.run` 留下的那行） | **是**（`prompt.ts:38`） |
| `command?` | `{name, args}`（引擎设，pin） | 否 |
| `isMeta?` | `true`（人看不到的输入；pin） | 否（但 delta 的 `localTurn` 语义依赖「不是人输入的」路径） |
| `attachments?` | `readonly {type,mediaType?,filename?,id?}[]` | 否 |
| `context?` | `readonly string[]`（模型读、人不见） | 否 |
| `turnId?` | `string`（提交时正在跑的 turn id；空闲提交为 absent；插件提交也为 absent） | **是**（`prompt.ts:38,102-105`） |
| `wait` | `boolean`（用户要求排队） | 否 |
| `origin` | `PromptOrigin`（9470-9592，闭合集合；`composer` = 人敲的回车；`plugin` = 插件提交） | 否 |

- 结果：`{text, context?, origin?}`（进入的 prompt）或 `{drop: string}`（没进入，`drop` 文案给
  用户看）。`next(e)` 在 prompt **进入会话且 turn 已开始**（或排到运行中的 turn 后）时 resolve，
  不等 turn 结束。
- delta 行为（`register.tsx:152-158` → `prompt.ts:26-147`）：大量前置条件检查，任一不满足返回
  `{drop: '…'}`（**唯一 fail-closed 路径**）；`e.turnId` 存在时是「插话」，只校验是否仍拥有该
  turn；否则 `next(e)`。
- `next` 之后：`result.drop !== undefined` 时清 `promptEntering` 并 `settleRemote`。
- shim 最低要求：`drop` 必须真的阻止 prompt 进入并把文案展示出来；`turnId` 的「空闲 vs 中途」
  两种情形要能区分（delta 的手递手/插话逻辑依赖它）。

### 3.7 `turn.start`（文档 4648-4654；输入 14608-14632；结果 14638-14643）

| 字段 | 类型 | delta 读 |
|---|---|---|
| `text` | `string`（turn 开始的用户文本；续写可能为 `""`） | 否 |
| `turnId` | `string`（本 turn 铸造，后续 `turn.complete` 同值） | **是**（`delivery.ts:725-726,743,756`） |
| `agentId?` | `string`（子代理/teammate 的 loop id；主循环 absent） | **是**（`register.tsx:165`） |

- 结果：`{turnId}`，core 回显；hook 的值不改变 turn。
- delta：主循环 `startTurn`（绑定 `currentTurnId`、开 execution；失败时 `turn.abort`）；
  `agentId` 存在走 `startChildTurn`。
- shim 最低要求：`turnId` 唯一且与 `turn.complete` 对应；`agentId` 有值 = 子代理 loop。
  `next` 之后 delta 继续做 `drain` 等异步工作（不阻塞 turn 启动）→ shim 不能 `next` 一 resolve
  就销毁 hook 上下文。
- 失败/超时：fail open（无 `.catch`）。但 delta 在自身持久化失败时会主动
  `host.turn.abort({turnId})`（`delivery.ts:743`）——所以 shim 的 `turn.abort` 必须真的能中止。

### 3.8 `turn.complete`（文档 4670-4690；输入 14502-14558；结果 14578-14583）

| 字段 | 类型 | delta 读 |
|---|---|---|
| `answer` | `string`（本轮最终可见文本） | 否 |
| `durationMs` | `number` | 否 |
| `isAborted` | `boolean`（`reason === 'aborted'`） | **是**（`subagents.ts:79-83`） |
| `turnId` | `string` | **是** |
| `agentId?` | `string`（pin） | **是**（`register.tsx:171`） |
| `usage?` | `TurnUsage` | 否 |
| `reason` | `'answer'\|'aborted'\|'refusal'\|'error'` | **是**（`stopReasonOf`） |
| `refusal` | `{category, explanation}`（仅 `reason==='refusal'`） | 否 |

- 结果：`{text, usage?}`；`text` 与主循环答案不同则展示在其下（不改 transcript）。
- delta：主循环先 `next(e)` 再 `endExecution`/`settleRemote`/`scheduleMove`/share；子代理走
  `completeChildTurn`；随后 fire-and-forget `$.session.id().then(followTranscript)`（**`session.id()`
  在 turn.complete 里也必须可用**）。
- shim 最低要求：**每个 agent 的每个 turn 都要发**（delta 的父/子 turn 关联）；`next` resolve
  后 hook 仍继续跑（同上）。
- 失败/超时：fail open（无 `.catch`）。**超时 = delta 的 `endExecution`/收尾丢失**（`next` 之后
  的工作在超时后被丢弃），记录里该 turn 停在 `running`。

### 3.9 `tool.call`（文档 4136-4146；输入 13840-13842；结果 13876-13970）

输入 = `{tool, tool_use_id, agentId?, requestMeta?, ...该工具自己的参数}`：

| delta 读 | 说明 |
|---|---|
| `e.tool` | 工具名（`Bash`/`Read`/`Edit`/`Write`/`Glob`/`Grep`/`Agent`/`Task`/`Skill`…） |
| `e.tool_use_id` | 调用 id（`delivery.ts:864-877`） |
| `e.agentId` | 子代理 loop（`register.tsx:328`） |
| 工具参数（平铺） | `content.ts:194-260` 的 `toolInfo(name, e, root)` 直接读 `e.command`、`e.file_path`、`e.offset`、`e.pattern`、`e['-i']` 等**Claude 工具 schema 的字段名** |

- 结果：`{result, text?, ref?, isError?, isReadOnly?, context?}`（core）或 `{deny}`（拒绝）或
  hook 自己的 `{result}`。
- delta：`recordToolCall` 调 `next(e)` 后在 `'result' in result` 且非 undefined 时把
  `result.result`（工具结构化记录）+ `result.isError` 记进 Delta 记录；子代理走
  `recordChildToolCall`。
- 失败：fail open（`.catch` → `next(e)`）。
- shim 最低要求：**工具名与参数键必须映射成 Claude 的 schema 形状**（否则 `toolInfo` 退化成
  `'Terminal'`/工具名本身，delta 记录的工具行变差）；`Skill` 工具的 `tool-message` 行被 matcher
  排除，shim 若没有 Skill 概念可忽略。

### 3.10 `command.run`（文档 4438-4452；输入 1828-1870；结果 1873-1915）

| 字段 | 类型 | delta 读 |
|---|---|---|
| `command` | `string`（无斜杠、别名已解析；**改写被拒**） | **是**（matcher） |
| `args` | `string`（命令名后全部；可改写） | **是**（`register.tsx:260`） |
| `origin` | `PromptOrigin`（人的回车 = `composer`；插件 = `{kind:'plugin',name}`） | **是**（`register.tsx:266`） |
| `presentation` | `{isFullscreen: boolean, columns: number}`（pin） | 否 |

- 结果：`{text?, context?, exitCode?, ref?}`。不调 `next` 直接 `{text}` → **不跑 core 命令**，
  `text` 作为该命令输出；`next` 之后返回 `{text}` → 替换已打印输出（不替换面板/输入框）。
- delta：7 条 `command.run` 注册。内部 `show <id>` 形式：`e.origin?.kind==='plugin' &&
  e.origin.name === $.plugin.name` 才走 `showAnswer`，否则给人看用法文本（`register.tsx:263-267`）。
  **这条自识别是安全边界**：shim 必须给「插件自己发起的 run」和「人敲的 run」不同的 origin。
- 失败：fail open（`.catch` → `next(e)`；`delta-plugin-update` 的 catch 返回 `{text}` 提示）。
- shim 最低要求：`origin.kind` 必须区分 `composer` 与 `plugin`；`args` 原样透传；`{text}` 结果
  必须能变成用户可见输出行（§5 的 `<local-command-stdout>` 格式）。

### 3.11 `ui.render`（文档 4160-4172；输入 10437-10483；结果 `RenderElement`）

输入：

| 字段 | 类型 | delta 读 |
|---|---|---|
| `surface` | `RenderSurface`（`terminal`/`desktop`/`vscode`/`mobile`） | **是**（`band.tsx:389`、`drawRow` 用 `e.viewport?.columns`） |
| `component` | `RenderComponent`（10072：`AskUserQuestion/UserMessage/AssistantMessage/ToolUse/ToolResult/ToolGroup/ToolProgress/CommandOutput/Spinner/TurnDuration/InfoNotice/SessionMode/PromptHint/AbovePrompt/Pane/Placed/Backdrop`） | **是**（matcher） |
| `requestId` | `string`（实例：dialog/tool 行是 `tool_use_id`，消息行是消息 id，spinner 是 agent id） | **是**（`rows.tsx:255,270`） |
| `viewport?` | `{columns, rows, isFullscreen?}` | **是**（`drawRow` 的 `e.viewport?.columns ?? 80`） |
| `props` | 该 component 的 props（10485-11233） | **是** |

delta 用到的 component 与其 props 要点：

| component | props（d.ts 行） | delta 读 |
|---|---|---|
| `AbovePrompt` | `hasSurvey`、`isWorking`、`maxRows`、`bodyColumns`、`scroll`、`view`（11062-11118） | `hasSurvey`（让位）、`maxRows`、`bodyColumns`、`view`（无） |
| `AskUserQuestion` | `questions: unknown[]`、`metadataSource?`（10495-10509） | `questions`（`withQuestionHints` 加 description，schema 不合法就原样 `next(e)`） |
| `UserMessage` | `text`、`origin`、`isExpanded`、`task?`、`from?`、`onScreen?`（10521-10618） | `text`（等于 `EMPTY_ROW_TEXT` 时隐藏该行） |
| `CommandOutput` | `command`、`args`、`text`、`isErrored`、`onScreen?`（10796-10830） | `command`（只画自己的 `delta`）、`args`（解析 item id）、`onScreen`（不读） |

- 结果：`RenderElement`（`Box`/`Text`/`Button`/`Link`/`Code`/`Markdown`/… 的普通数据树，10082-10110）。
- 触发与缓存：「**每个输入值一次**（props、viewport 宽度）、插件加载、或
  `$.ui.invalidate('ui.render')`；重绘复用答案」（d.ts:4160-4166）。delta 完全依赖 invalidate
  刷新 band 与行。
- 失败：抛错/非法树 → 画引擎自己的（`next(e)` 的值），`--plugin-dir` 时上报。
- shim 最低要求：见 §6 的渲染面决策；若 DSH 端没有等价绘制面，`ui.render` 可以只
  `return next(e)`（delta 的 band/行不显示，但逻辑照跑、invalidates 无害）。

### 3.12 `config.set`（文档 4465-4479；输入 2076-2111；结果 2113-2123）

| 字段 | 类型 | delta 读 |
|---|---|---|
| `key` | `string`（如 `theme`；pin，改写被拒） | **是**（matcher） |
| `value` | `ConfigValue = boolean\|string\|number\|readonly string[]` | 否 |
| `previous` | `ConfigValue`（pin） | 否 |
| `provider` | `Origin`（pin） | 否 |
| `origin` | `ConfigOrigin`（composer / plugin；pin） | 否 |

- 结果：`{value}`（已写入）或 `{deny:reason}`（行不变）。
- delta（`register.tsx:226-231`）：`await next(e)` → `forgetBarTheme()` → `ui.invalidate('ui.render')`
  → 返回 next 结果；catch fail open。
- shim 最低要求：DSH 若没有 `/config` 体系，可永不发此事件（delta 只是清主题缓存，无害）；
  但如果 DSH 有主题/配置变更，应发 `{key:'theme'}` 以保持状态条配色刷新。

---

## 4. shim 接口清单

### 4.1 模块边界

```
delta-dsh/
  vendor/hooks/…                    ← 原样复制 hooks/（register.tsx + 全部模块 + hooks.json）
  src/engine/types.ts               ← 类型：直接引用 vendor 的 .claude-plugin/types/claude-code
  src/engine/registration.ts        ← On 实现：收集 registration 记录
  src/engine/dispatch.ts            ← 事件分发器 + next 工厂 + .catch/预算/失败语义
  src/engine/dollar.ts              ← $ 工厂：把 EnginePorts 映射成 EngineInterface
  src/engine/ports.ts              ← EnginePorts：DSH 侧宿主适配器接口（session/turn/tool/…）
  src/engine/host-adapter.ts        ← DSH 事件 → core 事件 e 的翻译（§3 的合成）
  src/engine/render.ts              ← h/Fragment + Box/Text/Button/Link/Markdown 元素构造
  src/engine/load.ts                ← transpile+bundle vendor/hooks，注入全局，调用 register(on)
  src/index.ts                      ← DSH 插件入口：注册 hook、启动适配器
```

### 4.2 注册器

```ts
export type HookFn   = ($: EngineInterface, e: unknown, next: Next) => unknown
export type CatchFn  = ($: EngineInterface, e: unknown, next: CaughtNext) => unknown
export type RegistrationRecord = {
  readonly pattern: string
  readonly matcher: unknown | undefined     // undefined = 三参注册
  readonly hook: HookFn
  readonly seq: number                      // 注册顺序：先注册 = 外层
  catchHandler?: CatchFn
  catchLocked: boolean                      // register() 返回后置 true
}

export interface Registrar {
  readonly on: On                            // d.ts:7097 的两个签名
  readonly records: readonly RegistrationRecord[]
  /** register() 结束后调用：之后禁止再挂 .catch / 再注册 */
  seal(): void
}

export function createRegistrar(): Registrar
/** 载入一个 hooks 模块：await module.register(registrar.on, options)，然后 seal() */
export async function installHooksModule(module: HooksModule, options: PluginOptions): Promise<Registrar>
```

`.catch` 的挂接规则（§1.5）在同一次 `register()` 调用内同步完成，`seal()` 后抛错。

### 4.3 事件分发器

```ts
export type Tier = 'prepend' | 'user' | 'append' | 'builtin' | 'core'   // d.ts:13775 / 13785
export type Origin = { readonly plugin: string; readonly tier: Tier }    // d.ts:7692-7706

export type DispatchContext = {
  readonly event: EventName
  readonly origin: Origin                  // 调用来源：core 事件 = engine/core；$ 调用 = 发起插件
  readonly agentId?: string                // 当前 loop（子代理）
  readonly signal: AbortSignal
  readonly budgetMs: number                // 10_000；session.end 为 1_500 的硬上界
  readonly caughtGraceMs: number           // 1_000
  /** 当前 hook 帧栈：同事件重入时用来跳过调用中的 hook（§1.7） */
  readonly frames: readonly HookFrame[]
}

export type Bottom = (e: unknown) => Promise<unknown>

/** 派发一次事件：按 §1.3/§1.4 选注册 → 建链 → 运行 → 按 §1.6/§1.8 收尾 */
export function dispatch(
  registry: Registrar,
  ctx: DispatchContext,
  e: unknown,
  bottom: Bottom,
): Promise<unknown>
```

分发器必须保证：

1. `e` 深冻结（或至少 `Object.freeze` 每层；delta 只做浅拷贝 `{...e}`）。
2. 每个 hook 一个 `next`（§4.4），冻结。
3. hook 超时（`budgetMs`，`$` 调用与 `next` 等待不计时；`$.clock` 等待计时）→ 视为 `timeout`
   失败；`.catch` 有 `caughtGraceMs`。
4. 失败 → §1.6；结果形状不对也算失败（对每个事件做轻量 schema 校验：§3 的必填字段）。
5. 返回 `undefined` 视为失败；不调 `next` 的返回 = 结束链。
6. abort：`ctx.signal` abort 时该 hook 的 `next.signal` 同步 abort，进行中的 `$` 调用一起中止；
   hook 仍有 `lingerMs`（d.ts:5345-5352，5 s）收尾，之后按「已放弃」处理，链已继续。
7. 生命周期：**`next` resolve 不等于 hook 结束**——delta 在多个事件的 `next` 之后继续用 `$` 做
   异步收尾（`session.start:239-255`、`turn.complete:176-177`、`session.end` 全程）。分发器
   必须让 hook 的 `$` 在 `next` 返回后仍可用、计时/预算按 `next` 等待免除，不能回收 `$`。

### 4.4 `next` 工厂

```ts
export type CaughtNext = Next & { readonly error: HookFailure; readonly called: boolean }

export function makeNext(opts: {
  ctx: DispatchContext
  run: (e: unknown) => Promise<unknown>     // 跑下层的 hook（含 core bottom）
  lastCall: { value?: Promise<unknown>; called: boolean }   // catch 的 replay 状态
  caught?: HookFailure
}): Next
```

必须保证：

| 保证 | 理由 |
|---|---|
| `next(e)` 每次调用**重新跑下层** | d.ts:6849-6851 |
| `next()` 无参 reject 并指名 hook | d.ts:6851 |
| catch handler 里 `next.called` 为 true 时 `next(e)` 返回最后一次结果、不重跑 | d.ts:1228-1233；delta 的 catch 一律 `next(e)` |
| `next.signal` 在分发被放弃时 abort，且驱动 `$.clock.sleep({signal: next.signal})` | delta 只把 `{signal}` 用于 `clock.sleep` 的 deadline；这里兼容 |
| `next.budget`/`next.origin`/`next.event`/`next.to`/`next.is`/`next.trace` 存在且形状对 | 类型要过；delta 不读，但 org 守卫插件可能读 |

### 4.5 `$` 工厂

```ts
export function createDollar(ports: EnginePorts, ctx: DispatchContext | undefined): EngineInterface
```

- 每次 dispatch 建一个（或每进程一个 + 按 dispatch 的上下文解析，见 §2.0）。
- `$` 的每个方法都是 **op 事件的调用点**（d.ts:7162-7169）：先派发同名 op 事件（hook 可改写/
  拒绝/代答），再落到 `ports`。delta 不 hook op 事件 → shim 可先直连 `ports`，但**必须保留两个语义**：
  - `$` 调用在 hook 帧内时跳过该 hook（§1.7）；
  - op 事件失败 = 跳过（fail open），除非 `.catch` 里 `{deny}`（d.ts:7165-7167）。
- `$` 必须深冻结（d.ts:5030）。
- 同步/异步要精确：`ui.log`/`ui.status`/`ui.invalidate`/`ui.resolve`/`clock.after`/`clock.every`
  /`plugin.name`/`plugin.root` 是**同步**；其余返回 Promise。

### 4.6 `EnginePorts`（DSH 宿主适配器）

```ts
export interface EnginePorts {
  plugin: { readonly name: string; readonly root: string }

  ui: {
    log(text: string, options?: { to?: 'transcript' | 'debug' }): void
    status(text: string | undefined): void
    invalidate(event: InvalidatableEventName): void
    resolve(e: unknown): ElementTable          // 同步
    copy(args: { text: string; surface?: string }): Promise<UiCopyResult>
    ask(question: string, options?: readonly string[] | AskOptions): Promise<string>
  }

  session: {
    id(): string
    cwd(): string
    root(): string
    turns(): number
    surfaces(): readonly string[]
    version(): Promise<SessionVersion>
    messages(args?: { agentId?: string; as?: 'api' }): Promise<unknown>
    append(args: { message: { type: 'user' | 'system'; content: unknown[] }; agentId?: string }):
      Promise<{ message: unknown; uuid: string } | { deny: string }>
  }

  turn: { abort(args: { turnId: string }): Promise<void> }     // 注意是 camelCase（OpEventOf['turn.abort']）
  prompt: { submit(input: { text: string }): Promise<unknown> }
  tool: { call(input: { tool: string } & Record<string, unknown>): Promise<unknown> }
  command: {
    list(): Promise<CommandInfo[]>
    run(input: { command: string; args?: string }): Promise<CommandRunResult>
    register(spec: CommandSpec): Promise<{ command: string }>
  }
  config: { list(): Promise<ConfigRow[]> }
  agent: { list(): Promise<AgentInfo[]>; spawn(input: AgentSpawnArgs): Promise<unknown> }
  fs: {
    read(path: string): Promise<string>
    write(path: string, text: string): Promise<void>
    list(path?: string): Promise<FsEntry[]>
    exists(path: string): Promise<boolean>
    stat(path: string, options?: { resolve: boolean }): Promise<FsStat>
  }
  store: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
    delete(key: string): Promise<void>
    keys(): Promise<string[]>
  }
  clock: {
    now(): Promise<number>
    sleep(ms: number, options?: { signal?: AbortSignal }): Promise<void>
    after(ms: number, fn: () => void): { cancel(): void }
    every(ms: number, fn: () => void): { cancel(): void }
  }
  http: { fetch(url: string, init?: HttpInit): Promise<HttpResponse> }
  process: {
    run(argv: readonly string[], init?: ProcessRunInit): Promise<ProcessRunResult>
    spawn(request: ProcessSpawnRequest): AsyncIterable<{ stream: 'stdout' | 'stderr'; text: string }> &
      AsyncGenerator<{ stream: 'stdout' | 'stderr'; text: string }, { code: number | null; signal: string | null }>
  }
  settings: { policy(): Promise<Readonly<Record<string, unknown>>> }
  env: { get(name: string): Promise<string | undefined> }
}
```

（`$` 上 `turn.abort` 的入参是 `{ turnId: string }`（d.ts:7267-7269），不是 `turn_id`；
`register.tsx:131` 的 `turn.abort: (input) => $.turn.abort(input)` 原样转发。）

### 4.7 每个 `$` 调用的最低行为保证

| 调用 | 同步性 | 保证 | 失败姿态 |
|---|---|---|---|
| `ui.log(text,{to})` | **同步 void** | `transcript` → 用户可见的一条 dim 系统行（**不进模型上下文**）；`debug` → 只进 log，行首带插件名 | 不抛、不 reject |
| `ui.status(text\|undefined)` | **同步 void** | 每插件一条，钉在 prompt 下方；`undefined` 清除；新调用替换旧的 | 不抛 |
| `ui.invalidate('ui.render')` | **同步 void** | 丢弃本插件可画实例的缓存结果并重画（≤10/s，终端已显示时 ≤30/s；更频繁折叠） | 不抛；delta 有 `try{}catch{}` 也有裸调用 |
| `ui.resolve(e)` | **同步** | 返回该 surface 的冻结元素表，`Box/Text/Button/Link/Code/Markdown` 至少齐备 | 不抛（否则 render hook 失败） |
| `ui.copy` | Promise | 成功 `{isCopied:true}`；失败 `{isCopied:false,reason}`（reason 取闭集） | 不 reject |
| `ui.ask` | Promise<string> | 真人选择返回 label/逗号连接/自由文本；放弃时 reject | reject 类型决定 delta 退化路径（§6） |
| `session.id/cwd/root/turns/surfaces/version` | Promise | 见 §2.3；`surfaces` never reject；`turns()` 首次为 0 | 不 reject（`version` 可 reject，delta 有 `.catch`） |
| `session.messages(...)` | Promise | 4 种形态；主会话不 reject；未知 agentId 返回 `{deny}` | 主会话不 reject |
| `session.append` | Promise | 行真的进会话（模型上下文 + transcript）；返回 `{message,uuid}` | 插件 append 可 `{deny}`；其它不能拒 |
| `command.register` | Promise | 注册后 `command.list()` 立刻可见；`session.start` 内可用 | 重名替换；内置名被拒 |
| `command.run` | Promise | 走 `command.run` 事件链（跳过调用 hook）；空闲后跑；返回 `{text}` | 未知命令 reject |
| `tool.call` | Promise | 走 `tool.call` 链 + 权限 + 工具；返回 `ToolCallResult` | 无此工具/中止 reject |
| `prompt.submit` | Promise | 走 `prompt.submit` 链（跳过调用 hook）；`{drop}` 生效 | 一般 resolve |
| `agent.list/spawn` | Promise | 见 §2.9；id 与 `agentId` 同一套 | spawn 可 `{deny}` |
| `fs.*` | Promise | 见 §2.10；读上限 4 MiB；`exists` 缺失 → false | 见 §2.10 |
| `store.*` | Promise | JSON 往返；4 MiB；`keys()` 全量 | 超限/非 JSON reject |
| `clock.now/sleep/after/every` | 见 §2.12 | `sleep({signal})` 真 abort；`after/every` 同步返回 `{cancel}` | sleep abort → reject |
| `process.run/spawn` | Promise / 流 | 见 §2.14；spawn 离开循环即杀子进程；每条流前 4 MiB；chunk 不切多字节 | 启动失败 reject |
| `http.fetch` | Promise | `{status, ok, headers, text}`；不返回裸 Response | 网络错误 reject |
| `settings.read({source:'policy'})` | Promise | 返回合并后的 policy 对象 | 不 reject（`{}` 可接受） |
| `env.get(name)` | Promise | 未设 → `undefined`；`OS==='Windows_NT'` 等约定见 §2.16 | 不 reject |
| `plugin.name/root` | **同步属性** | root 含 `.claude-plugin/plugin.json`（带 semver version） | — |

### 4.8 载入 / 编译层

- `vendor/hooks/` 是 `hooks/` 的原样副本（含 `hooks.json`，仅作参考）。**运行时入口是
  `vendor/hooks/register.tsx` 的 `export function register(on)`。**
- 用 bundler（esbuild）把 `vendor/hooks/register.tsx` 打成单文件 ESM/CJS 给 Node：
  - 所有 `from 'claude-code'` 都是 `import type`（已 grep 确认：全仓库无值导入），打包时被擦除，
    **不需要** 运行时模块解析；类型仅在 tsc 阶段需要（沿用
    `.claude-plugin/types/claude-code/index.d.ts` + `.claude-plugin/types/tsconfig.json`）。
  - 需要注入全局 **`h` 与 `Fragment`**（d.ts:16175-16245）：`h(tag, props, ...children)` 返回
    `RenderNode`（普通数据），`Fragment` 是 column `Box`。delta 的 JSX 只有 `Box/Text/Button/
    Link/Markdown` 五种标签（grep 确认），shim 的 `render.ts` 用 `ui.resolve(e)` 的表构造这些。
  - 插件环境需要的 Web API：`URL`、`TextEncoder/TextDecoder`（`session-state.ts:316`）、
    `crypto.subtle.digest`、`crypto.randomUUID`（`join.ts:294`、`thread-runs.ts:196`）、
    `structuredClone`（`core/binding.ts:10`）、`AbortController/AbortSignal`。Node 20+ 原生具备。
  - 不得提供 Node 的 `fs`/`child_process`/`require`——delta 全部经由 `$`（hooks 里没有任何
    Node 内置模块导入；已 grep）。
- `hooks.json` 的 `modules` 顺序在 shim 里等价于「调用 `register(on)` 的模块顺序」。

### 4.9 最小实现范围分级

| 级别 | 内容 | 说明 |
|---|---|---|
| **P0（不实现就无法加载）** | `On` 与注册收集（22 条全部要能注册）；`session.start` 必须分发；`$` 的 `plugin`、`session.id/cwd/root/turns/surfaces/version`、`fs`、`store`、`clock`、`env`、`process.run/spawn`、`ui.log/status/invalidate/resolve` | 否则 `register()` 抛错或一进 hook 就崩 |
| **P1（记录功能）** | `session.append`（含 door）、`prompt.submit`、`turn.start/complete`、`tool.call`、`command.run`+`command.register/list`、`session.end`、`session.send`、`agent.list/spawn` | Delta 的核心价值 |
| **P2（体验）** | `ui.render`（band/行）、`ui.status`、`ui.invalidate` 真重画、`ui.ask`、`ui.copy`、`session.attach`、`config.set` | 视觉与交互 |
| **P3（可选）** | transcript JSONL 兼容（title/activation）、join/share 依赖的 `/clear` 与内置命令、`claude-code/testing` shim（37 个测试文件）、`$.tool.call('TaskStop')` | 见 §5/§6 |

---

## 5. 推断：d.ts 未明说、但 delta 依赖的行为

以下每条都**不是** d.ts 明说的契约，来自 delta 源码反推；实现前应验证。

1. **`command.run` 的回声/输出行格式**〔推断，来自 `watch/row-delivery.ts:99-123`〕
   `/delta show <id>` 自绘管线要求引擎为插件命令写两行：
   - 回声行：`door:'command'`、`role:'user'`、content 含
     `<command-name>/delta</command-name>…<command-args>show x</command-args>`、
     `origin = {kind:'plugin', name:'delta'}`；
   - 输出行：`message.type='system'`、`message.name='local_command'`、content 为
     `<local-command-stdout>delta: <text></local-command-stdout>`（无插件前缀时 `<local-command-stdout><text></local-command-stdout>`）。
   delta 靠这两行的形状（1）隐藏自己的回声（2）从 `showAnswer` 里解析 item id。shim 若合成
   `session.append` 行但不合这些格式，delta 的行不会画、且会把内部命令记进 Delta 记录。

2. **后台`$`调用跳过本插件全部 hook**〔推断，`watch/rows.tsx:69-77`〕见 §1.7。

3. **Claude Code 的 transcript 文件布局**〔推断，`core/transcript.ts:1-56`〕
   delta 直接读写 `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/<cwd 中非字母数字替换为 '-'>/<session>.jsonl`；
   解析 `{type:'ai-title', aiTitle}` 与 `{type:'custom-title', customTitle}` 行（`recording/title.ts:55-65`）；
   用 `tail -c +(offset+1)` / PowerShell 流式读（`title.ts:70-84`）。DSH 没有这种文件 →
   §6 决策（伪造 / patch vendor / 功能降级）。

4. **`plugin.root` 必须含 `.claude-plugin/plugin.json`**且 `version` 是 3 段 semver
   〔推断，`delivery.ts:361-368`、`plugin-update/updates.ts:86`〕。

5. **`session.end` 的 1.5 s 硬上界包含 `$` 等待**〔d.ts 有明说（11916-11925），但"delta 的收尾
   会不会因此丢"是推断〕。`markEnded`、`releaseOnEnd` 都在这条链里。

6. **`session.start` 完成先于第一个 prompt**〔d.ts 明说 "The first is awaited"；"Claude 在 hook
   返回后才投递第一个 prompt" 来自 `register.tsx:245-249` 注释 → 属于实现事实，非仅类型〕。

7. **事件 `e` 是深冻结的普通数据**，delta 用 `{...e}` 浅拷贝后传给 `next`；`props` 里的
   `origin/task/from/onScreen/isExpanded` 等在 `UserMessage` 上被文档标为只读（10521-10618），
   delta 只读不写。

8. **`ui.render` 的缓存键 = (props, viewport 宽度)**〔d.ts:4160-4166 明说〕，delta 依赖
   「同一 props 不重画、invalidate 才重画」；`requestId` 是画布句柄（delta 用它把
   `CommandOutput` 行与 item 关联，`rows.tsx:270`）。

9. **`hasInteractiveSurface` 只认 `terminal|desktop`**〔`sharing/lifecycle.ts:10-12`〕→
   DSH 若返回 `['sdk']`/`[]`，delta 全局按 headless 处理：`/delta*` 只回用法文本、不激活记录、
   setup 菜单不弹。这是**唯一由 `session.surfaces()` 决定的全局分支**。

10. **`isAskingOwnQuestion()` 依赖 `ui.ask` 内部走 AskUserQuestion 工具调用**〔`setup/interaction.ts:151-160`〕：
    delta 在 `ui.ask` 期间置计数，`ui.render` 的 `AskUserQuestion` hook 用
    `withQuestionHints` 给选项加 description；`recordToolCall` 在计数 > 0 时不记录该调用。
    shim 的 `ui.ask` 若不走 `ui.render` + `tool.call` 路径，这两处逻辑变成无害死代码（可接受）。

11. **`session.messages()` 的 `toolUses[].tool_use_id` / `toolUses[].agentId` 字段**
    〔推断，`share.ts:149-153` 用它做 tool 索引；d.ts:14373-14436 有明说字段名，但"delta 用它
    关联 Agent 子会话"是推断〕。

12. **`session.send` 的 `to` 必须是字符串**〔d.ts:12496-12499 明说插件传入的 `{sessionId}` 到达 hook 时
    已 "spelled"；delta 另外还做 `typeof e.to !== 'string'` 兜底（`register.tsx:315`）〕。

13. **`store` 与 `fs` 的 4 MiB 限额**〔d.ts 明说〕，delta 的 outbox/binding 体积受它约束；
    shim 放宽限额不会破坏 delta（只影响其它插件），收紧会破坏。

14. **`process.spawn` 的 chunk 边界不得切断多字节字符**（d.ts:8451-8466 明说），delta 的
    JSONL 扫描器（`title.ts:198-207`）按块拼接后按行解析，依赖这个保证。

15. **插件命令的 `command` 字段的别名展开**〔d.ts:1830-1836 说 "aliases and folds resolved"〕；
    delta 注册的是 `delta`/`delta-share`/…，shim 只要原样比对即可。

---

## 6. 需要 Lead 决策的点

| # | 决策 | 选项（推荐先） | 影响 |
|---|---|---|---|
| 1 | `session.surfaces()` 返回什么 | 推荐 `['terminal']`（DSH Web GUI 当作交互终端） | 决定 delta 走交互路径还是 headless 退化（§5 第 9 条）。返回 `[]` 则 `/delta` 只有用法文本、不记录 |
| 2 | `ui.render` 是否有真实绘制面 | 推荐 P2 再做：先 `return next(e)`（无 band/Delta 行） | 牺牲状态条/Delta 行，换取 P0/P1 快速跑通；`invalidate` 变成无害空转 |
| 3 | `session.append` 的合成策略 | 推荐按 §5.1 的 Claude 格式合成 `{door, origin, message}` | 不合成则记录功能全失；合成了但格式不同则 `show` 自绘链路坏 |
| 4 | 是否允许 patch `vendor/hooks/` | 推荐：核心逻辑零 patch；只允许「引擎格式适配」集中在 shim | clone 的 `core/transcript.ts`/`title.ts` 依赖 Claude JSONL（§5.3）；join/share 依赖 `/clear` 与内置命令 |
| 5 | `ui.ask` 策略 | 推荐真实现；否则用 `TypeError` 抛（delta 归为"无交互 API"→ 返回用法文本），**不要**普通 reject（会被当"用户取消"→ 静默 `{}`） | `/delta` 菜单、setup 选择、join 确认 |
| 6 | `session.end` 是否保留 1.5 s 硬上界 | 推荐保留（对齐语义，delta 收尾本就是尽力而为） | 收尾可靠性 vs 语义等价 |
| 7 | 工具名/参数映射 | 推荐 DSH 工具适配成 Claude 名（`Bash/Read/Write/Edit/Glob/Grep/Agent`）与字段名 | `toolInfo` 的工具行质量；`Skill` 排除规则 |
| 8 | `claude-code/testing` 要不要 shim | 推荐暂不做 | 37 个测试文件（含 3 个大型 fake-engine 测试）是 delta 行为的最强回归网，但 shim 成本高 |
| 9 | `$.tool.call({tool:'TaskStop'})` | 推荐实现（或 patch 成 delta 自己的停止路径） | 子代理回收（`subagents.ts:683`） |
| 10 | op 事件链是否实现 | 推荐只直连（不做 op hook） | org 守卫插件（`classic.*`/op 事件）在 DSH 上不存在，等价性损失可接受 |

---

## 7. 附：证据索引与类型面

### 7.1 关键 d.ts 行号

| 主题 | 行 |
|---|---|
| 模块头 / 生成版本 | 1-100 |
| `On` / `Registration` / `Register` | 7097-7101 / 10037-10057 / 10011-10033 |
| `Pattern` / `Glob` / `Negation` / `Selected` | 7848 / 5276-5284 / 6844 / 11337 |
| `Matcher` / `MatcherData` / `NarrowDepth` | 6048-6070 / 6060 / 6783 |
| `HookFor` / `MatchedHook` / `Events` | 5392 / 5998 / 5039-5043 |
| `Next` / `NextBudget` / `HookBudget` / `HookFailure` | 6859-6945 / 6947-6972 / 5334-5368 / 5370-5390 |
| `CatchHandler` / `Caught` | 1208 / 1218-1233 |
| `Origin` / `Tier` | 7692-7706 / 13785-13788 |
| `EngineEventOf`（事件文档） | 4134-4696 |
| `CoreEngineInterface`（`$`） | 2351-3784 |
| `session.messages` 重载 | 12104-12218 |
| `SessionMessage` / `ApiMessage` / `ApiContentBlock` | 12072-12102 / 667-685 / 651-665 |
| `SessionAppend*` | 11406-11579 |
| `SessionStart/End/Attach/Send*` | 12609-12635 / 11927-11966 / 11581-11606 / 12491-12579 |
| `PromptSubmit*` / `PromptOrigin` | 9670-9854 / 9470-9592 |
| `TurnStart*` / `TurnComplete*` | 14608-14643 / 14502-14583 |
| `ToolCall*` / `ToolCallResult` | 13819-13870 / 13876-13970 |
| `CommandRun*` / `CommandSpec` / `CommandInfo` | 1817-1915 / 1922-1945 / 1768-1795 |
| `ConfigSet*` / `ConfigRow` | 2070-2123 / 2028-2068 |
| `RenderInput*` / `RenderPropsOf` / `RenderResultOf` | 10432-10483 / 10485-11233 / 11234 |
| `UiLogOptions` / `UiCopy*` / `AskOptions` | 15344-15367 / 15037-15095 / 692-703 |
| `Process*` / `Fs*` / `Http*` | 8385-8517 / 5139-5275 / 5429-5496 |
| `SettingsRead*` / `SessionVersion` / `AgentInfo` | 12764-12835 / 12702-12730 / 125-187 |
| 全局 `h` / `Fragment` / `JSX` | 16160-16245 |
| `claude-code/testing` 模块 | 16291-16400+ |

### 7.2 hooks 从 `claude-code` 导入的类型（编译面必须精确一致）

`AgentInfo`、`ApiContentBlock`、`ApiMessage`、`ConfigRow`、`EngineInterface`、`EventName`、
`FsEntry`、`HookFailure`、`HookFor`、`MatchedHook`、`On`、`ProcessRunResult`、`ProcessSpawnResult`、
`RenderSurface`、`TextProps`、`Timer`、`UiCopyResult`。

关键点：`hooks/core/session-state.ts:24-28` 用 `HookFor<E>`/`MatchedHook<E, M>` 推导
`HookEvent<E>`/`HookNext<E>`，即 delta 的**所有 handler 类型都从 shim 的 `On` 类型推导**。
→ shim 的 `claude-code` 类型声明必须与原 d.ts **同一份**（直接 vendor 该 `.d.ts`），否则
`hooks/` 编译不过。

### 7.3 delta 注册点一览（22 条）

| 事件 | matcher | register.tsx |
|---|---|---|
| `session.attach` | — | 145 |
| `prompt.submit` | — | 152 |
| `turn.start` | — | 163 |
| `turn.complete` | — | 169 |
| `ui.render` | `{component:'AbovePrompt'}` | 180 |
| `ui.render` | `{component:'AskUserQuestion'}` | 186 |
| `ui.render` | `{component:'UserMessage'}` | 192 |
| `ui.render` | `{component:'CommandOutput'}` | 197 |
| `session.end` | — | 201 |
| `config.set` | `{key:'theme'}` | 226 |
| `session.start` | — | 233 |
| `command.run` | `{command:'delta'}` | 258 |
| `command.run` | `{command:'delta-share'}` | 271 |
| `command.run` | `{command:'delta-join'}` | 276 |
| `command.run` | `{command:'delta-setup'}` | 282 |
| `command.run` | `{command:'delta-update'}` | 286 |
| `command.run` | `{command:'delta-plugin-update'}` | 290 |
| `command.run` | `{command:'delta-org'}` | 297 |
| `session.append` | `{door:[…5]}` | 307 |
| `session.append` | `{door:'tool-message', origin:{kind:'tool',tool:/^(?!Skill$)/}}` | 309 |
| `session.send` | — | 312 |
| `tool.call` | — | 326 |
