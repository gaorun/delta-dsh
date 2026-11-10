# DSH Host 插件 API 与打包参考（delta-dsh 实现用）

目标读者：实现 `delta-dsh` 的人。本文只写本机实测过的事实，每条结论都带证据路径。
机器：DeepSeek Harness **0.2.2-rc.1** Desktop，profile `desktop`，`DSH_HOME=/Users/run/.dsh`，
`DSH_PROFILE_DIR=/Users/run/.dsh/profiles/desktop`。

## 0. 结论速查（先读这段）

1. **第三方 bundle 的 Host 半边只能拿到 `ctx`，不能 `import '@deepseek-ai/*'`。** 这是本机实测的硬结论，不是风格建议：
   `cd ~/.dsh/profiles/desktop/node_modules/dsh-guizang-design && node --input-type=module -e "import('@deepseek-ai/dsh-commands')"`
   → `ERR_MODULE_NOT_FOUND`。profile 的 `node_modules` 里只有第三方包和它们的 npm 依赖，没有任何 `@deepseek-ai/*`。
   官方包里那句 "Packages shipped with dsh resolve from the dsh installation" 只对 **Loader row 的 `name` 说明符** 成立，对插件代码里的 ESM `import` 不成立。
   → 运行时只写纯 JS：`export const inject = [...]` 声明依赖的服务，用 `ctx.<service>` 或 `ctx.get('service')`。
2. **事件名、Service 方法签名一律以运行时 inspection 为准**，不要靠猜：`cordis_inspect_query(host, Service|Event).listService/listEvents`（见 §6.1）。本文的签名都抄自它。
3. **不要新增 SessionEvent 类型。** `Session.append()` 写不进 `ignorable` 标记，新类型会让会话之后无法重新打开（`references/practices.md` 明写）。delta 要的自有状态放 `ctx.storageDomain` KV，或派生自既有事件。
4. **`agent` 没有 `abort()`**，只有 `agent.cancel(cause, opts)`。`subprocess` 没有 `run()`，只有 `spawn(spec)` + `handle.done`。
5. **第三方 Host 插件做不出 Client 可调的 Remote 方法**（需要 `@deepseek-ai/dsh-typert-generator` 生成 `lib/typert.host.js`，见 `@deepseek-ai/dsh-commands` 的 `exports["./typert"]`）。Client→Host 的唯一现成通道是 **commands**（`ctx.remote.commands.execute`），见 §4.4。
6. 参考实现：**`dsh-guizang-design` 0.1.3**（`~/.dsh/profiles/desktop/node_modules/dsh-guizang-design/`）。它就是一个装好的第三方 bundle，`package.json` + `cordis.patch.yml` + `lib/index.js` 三件套，可整份对照抄。

---

## 1. Bundle 清单与打包

### 1.1 什么算一个 bundle

`package.json` 里有 `dsh.bundle.patch` 就是 bundle。最小可用形态（Host-only，无构建、无依赖）：

```json
{
  "name": "@local/my-plugin",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.js" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`cordis.patch.yml`：

```yaml
- insert:
    - id: my-plugin
      name: '@local/my-plugin'
      config: {}
```

证据：`dsh-agent-preset/skills/cordis-plugin-development/references/host-plugin.md:7-27`。

`dsh.bundle.patch` 可以是**字符串或字符串数组**（数组按顺序叠层）。证据：`@deepseek-ai/dsh-web-app` 的 `package.json`
→ `"patch": ["./cordis.patch.yml","./presets/standard.patch.yml","./presets/ptc.patch.yml","./presets/minimal.patch.yml","./presets/cordis.patch.yml"]`。

### 1.2 package.json 字段清单（逐字段，含实测证据）

以 `dsh-guizang-design@0.1.3` 的真实 manifest 为模板（路径：`~/.dsh/profiles/desktop/node_modules/dsh-guizang-design/package.json`）：

| 字段 | 必要性 | 说明 |
|---|---|---|
| `name` | 必须 | 包名；patch row 的 `name` 与 `dsh.client` 的 factory id 都用它 |
| `version` | 必须 | 语义化版本；`plugin_manager` 的 `listVersions`/`updateBundle` 依赖它 |
| `type` | 必须 | 必须 `"module"`（ESM）。桌面版没有 CJS 加载路径 |
| `main` | 建议 | `"lib/index.js"` |
| `exports` | 必须至少 `"."` | 见下表 |
| `files` | 发布时必须 | 本地目录安装（`install_bundle` 传绝对路径）会 **symlink 整个目录**，`files` 不过滤；只有打包发布时才生效 |
| `icon` | 建议 | 顶层 `icon` 字段优先于 `./icon` export，值是相对 manifest 的路径 |
| `engines.node` | 建议 | `"^22.19.0 || >=24.0.0"`（guizang 实测值） |
| `engines.dsh` | 建议 | `">=0.2.1-rc.2 <0.3.0"`。不满足会被 `plugin_manager` 拒：`ManagementError.code = 'incompatible-version'` + `IncompatiblePlugin.requirements` |
| `keywords` | 无功能 | 建议带 `"dsh-plugin"`、`"deepseek-harness"` |
| `dependencies` | 按需 | 第三方 npm 依赖；`install_bundle` 会用 pnpm 装进 profile |
| `peerDependencies` | 谨慎 | profile 是 `autoInstallPeers: false`（`~/.dsh/profiles/desktop/pnpm-workspace.yaml`），peer 不会自动装。guizang 声明 `react` peer 是因为 Client 半边从宿主模块表拿 React，不需要自己装 |

`exports` 必须包含的条目：

```json
"exports": {
  ".": "./lib/index.js",
  "./client": "./lib/client.js",
  "./cordis.patch.yml": "./cordis.patch.yml",
  "./package.json": "./package.json",
  "./locale/*.json": "./locale/*.json",
  "./icon": "./icon.png"
}
```

理由（全部来自 `host-plugin.md:31-51`）：Plugin Manager 与 Settings **在不激活插件的条件下** 读 `locale/*.json` 里的 `meta.title`/`meta.description` 和图标，所以这些必须能在 `exports` 里解析到。

### 1.3 `dsh.client`（只有需要 Web UI 时才要）

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "platform": "web", "immediately": true, "inject": ["@deepseek-ai/dsh-client-ui-conversation"] }
}
```

- `platform`: `"web"`
- `immediately`: 是否在首屏就加载
- `inject`: **只影响激活顺序**，不是模块 import（`references/ui-plugin.md`）
- `external`: 声明非 baseline 运行时 import

guizang 用的是 `"client": { "platform": "web", "inject": [] }`。

**重要**：`references/practices.md` 明确禁止 `require('@deepseek-ai/dsh-client-ui-primitives')` 或把任何 Harness Client 包当模块加载——它们会变、没有类型检查、抛错会让整个 slot 空白。要用就抄它的 markup/CSS 到自己前缀下，只保留 `--dsw-alias-*` 主题 token。

### 1.4 locale 与 icon 的硬性要求

`locale/en.json`（至少英文一份，中文建议 `locale/zh.json`）：

```json
{ "meta": { "title": "My decoration", "description": "Draws a badge under the composer." } }
```

- 标题用 sentence case（只有首字母和专有名词大写）。
- 可加 `meta.detail: "./README.md"`（长文档），`readBundleDetail` 会读它。
- icon：SVG/PNG/JPEG/WebP，≤ **256 KiB**，必须在包内；绝对路径、URL、指向包外的符号链接一律拒绝。
- 包根插件可用顶层 `icon`；subpath 插件（如 `@deepseek-ai/dsh-tool-subagent/model-selection-settings`）不是包，不读 `package.json`，只能 export `./<sub>/icon`。
- 缺失时回退：`name`/`description` 用 `package.json` 的，图标用面板默认图。

证据：`host-plugin.md:29-55`。

### 1.5 patch 的 YAML 方言

来自 `cordis-composition-reference/SKILL.md`（app.asar 内 `dsh-agent-preset/skills/cordis-composition-reference/SKILL.md`）：

- `insert: [rows]` 追加行。若 `insert` 的 `id` 指向一个 `group: true` 的行，则插入到该 group 的 `config` 列表里。
- 只有 `id` 没有 `insert` → **改** 已存在的同 id 行。**`config` 是整体替换，不是深合并**；`name` 为真值是「断言」不是「改名」。
- 没有非空 `id` 的非 insert patch、匹配不到行的 patch → 告警并跳过。
- 一行 = `id`, `name`（包说明符；相对路径相对 patch 文件解析）, 可选 `config`, `disabled`, `inject`, `intercept`, `isolate`。
- `group: true` + `name: cordis:group` → `config` 是嵌套 entry 列表。
- `disabled` 可以是 boolean / null / `!!js` 表达式；`!!js` 在 `config` 内部于该插件 required injections 激活后、以其 `ctx` 求值，可写 `!!js dshHomePath('sessions')`、`!!js "!ctx.get('profileContext')"`。其它 row 元数据保持字面量。
- `isolate` 控制服务实例隔离（`isolate: { foo: true }` 或 realm label）。

**不要写 profile 的 `cordis.patch.yml`**。宿主插件改自己的配置走 `ctx.configEditor.edit()`（§5.6）。

### 1.6 安装方式：`plugin_manager install_bundle`

对实现者：**只允许用 `plugin_manager` 工具**，不要手工 pnpm / 手写 profile `package.json` / 不要 `dsh plugin add`。

调用形状（`@deepseek-ai/dsh-plugin-manager` 的 `PluginManager.installBundle`）：

```ts
installBundle(spec: string, options?: InstallBundleOptions): Promise<ChangeResult>
```
```ts
interface InstallBundleOptions {
  enabled?: boolean                 // 默认 true（装完即启用）
  saveExact?: boolean               // 存精确版本，不写 ^range
  requestId?: PluginInstallRequestId // 需要取消时自己生成
  approvedBuilds?: string[]         // 只有用户明确同意后才传（会执行 install script！）
  registry?: Registry               // string | null
}
interface ChangeResult {
  changed: boolean
  application: 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled'
  restartReason?: 'no-hmr' | 'package-moved' | 'host-module' | 'unmanaged-plugin' | 'module-comparison'
  stage: 'install' | 'enable' | 'remove'
  target: string
  enabled?: boolean
  error?: ManagementError
  warnings?: string[]
  bundle?: string
  version?: string
  pendingBuilds?: string[]
  approvedBuilds?: string[]
  registries?: Registry[]
  failedAt?: 'registry' | 'spec-host'
}
```

`install_bundle` 实际做了什么（实测，来自 `~/.dsh/profiles/desktop/.plugin-manager/logs/operation-8dkWZ2/pnpm.log`）：

1. 在 `$DSH_PROFILE_DIR` 里跑 pnpm（guizang 日志：`+ dsh-guizang-design 0.1.3  Done in 18.9s using pnpm v11.28.5`）；
2. 写 profile `package.json` 的 `dependencies` 和 `dsh.profile.bundles`（现存值可对照 `/Users/run/.dsh/profiles/desktop/package.json`）；
3. 应用它的 patch；
4. 返回 `application` —— **只看 `application`，不要看日志或进程列表来判断是否生效**。

**判断生效的正确读法**（`cordis-plugin-include`/`host-plugin.md:83` 的转述）：

- `applied` → 已生效（desktop profile 有 HMR，新插入的 bundle 通常走这条路）
- `restart-required` + `restartReason: 'no-hmr' | 'package-moved' | 'host-module' | 'unmanaged-plugin' | 'module-comparison'` → 没生效
- `overridden` → 被更高优先级 layer 盖掉
- `failed` → 需要诊断（`error.code` + `error.diagnostic`）

### 1.7 依赖解析：能 import `@deepseek-ai/*` 吗

**运行时：不能。** 实测失败（见 §0 第 1 条）。可行做法只有三种：

| 想要 | 做法 |
|---|---|
| 调服务 | `export const inject = ['commands','tools']` 然后 `ctx.commands.register(...)`；可选服务用 `ctx.get('configEditor')` 拿 `undefined` 判断，或 `ctx.inject(['a','b'], ctx => {...})` 延迟绑定 |
| 拿常量/枚举 | 自己抄字面量（如 `surfaceOp: 'append'`、`kind: 'reject'`）。这些是持久化的线上值，不会随便改 |
| 类型 | TS 工程里把 `@deepseek-ai/*` 放 **devDependencies**，只用 `import type`（编译后擦除）。pubished 的 npm 包带完整 `lib/types/**/*.d.ts`，`npm pack @deepseek-ai/dsh-session@0.2.2-rc.1` 可验证。**别用值导入**，`import { SessionSeq } from '@deepseek-ai/dsh-session'` 会把运行时依赖带进去 |

桌面版安装包里的 `lib` 目录**只有 `.js`，`.d.ts` 被裁掉了**（对照 `app.asar/dsh/node_modules/@deepseek-ai/dsh-session/lib/`）；所以类型必须从 npm 拉。

如果确实需要在运行时复用官方包的**实现**（比如 `defineDomain`/`domainTable`/`z` 校验），有两条路：
- 自己实现等价物（推荐，KV domain 的 spec 就几个字段，见 §5.1）；
- 或者在你的包里 `dependencies` 声明 `@deepseek-ai/dsh-storage-domain@0.2.2-rc.1`，让 pnpm 把它装进 profile `node_modules`（会引入第二份 zod 与 cordis，**未实测**，风险见 §8）。

### 1.8 ESM / JS 要求

- `"type": "module"`，Node ESM。
- **不需要构建**：纯 JS 直接 `export function apply(ctx, config) {}`（guizang 就是这样，`lib/*.js` 全是手写 ESM）。
- 如果用 TS 写，自己构建出 ESM `.js` + 保留目录结构；`exports` 指到构建产物。
- Node 版本看 `engines.node`，本机 Node 由 Electron 提供（`ELECTRON_RUN_AS_NODE=1` 可用同一份 Node 跑脚本）。
- 相对导入必须带扩展名（ESM 规则）：`import { dataDir } from './library.js'`。
- 包内资源路径用 `fileURLToPath(new URL('..', import.meta.url))` 求根，不要 `__dirname`。证据：guizang `lib/index.js:18`。

### 1.9 Host 插件导出形态（三选一，不可混）

```js
// 形态 A：apply 函数（推荐，guizang 用的这个）
export const name = 'guizang-design'
export const inject = ['webServer', 'skills', 'tools']
export function apply(ctx, config) { ... }

// 形态 B：apply + Config（schemastery）
export const Config = Schema.object({ foo: Schema.string() })
export function apply(ctx, config) { /* config 已按 Config 校验 */ }

// 形态 C：Service 类作 default export
export default class MyService extends Service { ... }
```

证据：`host-plugin.md:57-64`，以及 guizang `lib/index.js:30-31`（`name` + `inject`）与 `:115`（`apply`）。

注册资源**必须**在 `apply` 里用 `ctx.effect(...)` 返回清理函数，或用 `ctx.on(...)`（Cordis 自动回收）。`ctx.effect` 的返回值是 disposer，插件卸载时调用。

---

## 2. 事件

### 2.1 分发模式

来自 `cordis_inspect_query(host, Event).listEvents` 的 `mode` 字段：

| mode | 监听器形状 | 语义 |
|---|---|---|
| `emit` | `(...args) => void` | 广播通知，返回值忽略，异常被吞 |
| `serial` | `(...) => Promise<void> \| void` | 顺序 await；抛错会打断后续 listener |
| `parallel` | `(...) => Promise<void> \| void` | 全部 await，失败不影响别人 |
| `waterfall` | `(...args, next) => Promise<R>` | 链式；**不接管就必须 `return next()`** |

`this: Scoped<Agent>` / `Scoped<Session>` 表示该事件是**按 scope 过滤**的：注册在 `agent.ctx` 上的 listener 只收到那个 agent 的。

监听写法：

```js
export function apply(ctx) {
  ctx.on('agent/created', async ({ agent, source }) => { /* ... */ })
  ctx.on('session/event', (session, event) => { /* ... */ })
  // waterfall：不要接管时
  ctx.on('tools/pre-execute', async (exec, next) => next())
  // 绑定到 agent 生命周期（推荐）
  ctx.on('agent/created', ({ agent }) => {
    const dispose = agent.ctx.on('agent/status', ({ status }) => { /* 只属于这个 agent */ })
    // agent 销毁时 agent.ctx 自动回收；也建议把 dispose 挂在自己的 effect 里
  })
}
```

`references/practices.md` 的两条硬规矩：
- waterfall listener 不接管就必须 `return next()`；改写 `agent/pre-step` 的决策要 `{ ...decision, messages }` 展开，别丢 `startsRequestSeries`。
- 「与顺序无关、必须拒掉」用同步 guard（`ctx.tools.guard()`），要能 await（比如问用户）就用 `tools/pre-execute` 返回 `{ kind: 'ask' }`。

### 2.2 Host 事件全集（签名逐字抄自 `Event.listEvents`）

**Agent 生命周期 / 流**

```
'agent/created'      serial    (this: Scoped<Agent>, payload: { agent; source: 'startup'|'resume'|'clear'|'compact'; signal? }): undefined | Promise<undefined>
'agent/disposed'     emit      (this: Scoped<Agent>, payload: { agent: Agent }): void
'agent/status'       emit      (this: Scoped<Agent>, payload: { agent; status: 'idle'|'running' }): void
'agent/error'        emit      (this: Scoped<Agent>, payload: { agent; turn: number; step: number; error: unknown }): void
'agent/assistant-stream' emit  (this: Scoped<Agent>, payload: { agent; frame: AssistantStreamFrame }): void
'agent/pre-step'     waterfall (this: Scoped<Agent>, payload: { agent; messages: UserMessage[]; turn; step; signal: AbortSignal; modelSelection: Readonly<ModelSelection> }, next: () => Promise<PreStepDecision>): Promise<PreStepDecision>
'agent/turn-stopping' serial   (this: Scoped<Agent>, payload: { agent; turn; signal: AbortSignal }): Promise<void>|void
'agent/request-error' waterfall(this: Scoped<Agent>, payload: { agent; turn; step; provider: string; failure: LlmFailure; retryPolicy; signal }, next: () => Promise<RequestErrorAction>): Promise<RequestErrorAction>
'agent/inbox/inserted'  emit   (this: Scoped<Agent>, payload: { agent; message: UserMessage }): void
'agent/inbox/claimed'   emit   (this: Scoped<Agent>, payload: { agent; message; turn: number }): void
'agent/inbox/discarded' emit   (this: Scoped<Agent>, payload: { agent; message: UserMessage }): void
'agent-loop/config-start-failed' emit (payload: { sessionId; error: unknown }): void
```

`agent/created` 语义（`dsh-agent/lib/types/runtime-types.d.ts:242-258`）：listener 顺序执行且被 await，**抛错会让创建失败并跳过后面的 listener**；AgentLoop 在所有 listener 完成前压住入队输入。**listener 里不能 await `agent.whenIdle()`，也不能 await 自己 owner 的销毁。**

`PreStepDecision`（同文件 117-124）：

```ts
{ kind: 'reject' } | { kind: 'enter'; messages: UserMessage[]; startsRequestSeries?: true }
```

**Session**

```
'session/created'  emit     (this: Scoped<Session>, session: Session): void
'session/disposed' emit     (this: Scoped<Session>, session: Session): void
'session/event'    emit     (this: Scoped<Session>, session: Session, event: SessionEvent): void   -- post-commit，fire-and-forget
'session/flush'    parallel (this: Scoped<Session>, session: Session): Promise<void> | void        -- 可 await 的持久化检查点
```

`session/event` 的关键性质（`dsh-session/lib/types/index.d.ts:53-63`）：
- listener 快照在 log push **之前**取，回调在 push **之后**跑；
- 单个 listener 抛错被 record 并吞掉，不影响已提交的 append；
- 是**同步 fire-and-forget**，不是 await 的。要保证落盘用 `ctx.sessions.flush(session)` 或 `session/flush`。

**Tools**

```
'tools/pre-execute'  waterfall (this: Scoped<ToolsService>, exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>
'tools/execute'      waterfall (this: Scoped<ToolsService>, exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult>
'tools/post-execute' waterfall (this: Scoped<ToolsService>, exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>): Promise<PostToolDecision>
'tools/result'       emit      (this: Scoped<ToolsService>, exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): undefined
'tools/change'       emit      (): void
'tools/ptc-dispatch-log' waterfall (this: Scoped<ToolsService>, dispatch: PtcDispatchLog, next: () => Promise<ContentBlock[]>): Promise<ContentBlock[]>
```

payload 结构（`@deepseek-ai/dsh-tools@0.2.2-rc.1` → `lib/types/contracts.d.ts`）：

```ts
interface ToolExecution {           // 208-213
  readonly callId: ToolCallId
  readonly rootCallId: ToolCallId
  readonly name: string
  readonly arguments: unknown       // 已解析 + 深冻结
  readonly agent?: Agent
  readonly token: ToolExecutionToken
  readonly signal: AbortSignal
  // 可选：schema?, toolSet?, parent?
}
interface ToolExecutionSuccess {    // 289-299
  readonly isError: false
  readonly value: JsonValue
  readonly content: ContentBlock[]
  readonly meta?: JsonValue
  readonly additionalContexts?: UserMessage[]
  readonly concludesTurn?: true
}
interface ToolExecutionFailure {    // 301-309
  readonly isError: true
  readonly error: { message: string; info?: { name; code; reason? } }
  readonly content: ContentBlock[]
}
type PreToolDecision  = { kind:'allow' } | { kind:'deny'; reason; info? } | { kind:'cancel' } | { kind:'ask'; reason?; displayReason? }
type PostToolDecision = { kind:'accept'; content?; additionalContexts? } | { kind:'accept'; value: JsonValue; additionalContexts? } | { kind:'block'; feedback: ContentBlock[]; additionalContexts? }
```

**其它 Host 事件（全量，按需查）**

```
'commands/change'              emit      (): void
'user-questions/request'       waterfall (this: Scoped<Agent>, request: AskUserQuestionRequestEvent, next: () => Promise<AskUserQuestionAnswer>): Promise<...>
'session-telemetry/record'     waterfall (record: SessionTelemetryRecord, next: () => SessionTelemetryRecord): SessionTelemetryRecord
'domain/changed'               emit      (change: DomainChanged): void
'fs/write-intent' 'fs/edit-intent' 'fs/delete-intent'  waterfall
'fs/observed'                  emit      (target: FsTarget, observation: FsObservation, actor: object|undefined): void
'skills/change'                emit      (): void
'settings/document-updated'    emit      (ns: SettingsNamespace, revision: number): void
'plugin-manager/changed' | /install-log | /install-state | /operation | /update-state
'app-boot/config-reload'       emit      (): void
'hmr/change' | 'hmr/reload'
'approval/request'             waterfall
'subagent/start' 'subagent/end' 'subagent/provider-added' 'subagent/provider-removed'
'api-session/added|removed|status|activity|error'
'goal/changed' 'goal/activation-changed'
'workflow/start|phase|log|end|agent-start|agent-end'
'credentials/record-updated' 'credentials/reference-updated'
'connection/request' 'webserver/index-inject' 'workspace/session-activity|session-stop'
'llm/stream' 'llm/models-updated' 'llm/adapters-updated'
'schedule/changed' 'schedule/resolve-agent'
'compaction/summary-error'
'feedback/committed' 'forge/providers-changed' 'plugin-market/changed' 'permission-presets/catalog-changed'
'agent-preset/selected' 'authorization/settled' 'deepseek-account/*'
```

### 2.3 SessionEvent 全部类型与关键字段

`SessionEvent` 的形状（`dsh-session/lib/types/types.d.ts:497-520`）：

```ts
type SessionEvent<T extends SessionEventType = SessionEventType> = {
  [K in SessionEventType]: {
    type: K
    seq: SessionSeq             // 会话内单调
    time: number                // unix ms
    data: SessionEventMap[K]
    ignorable?: true            // 只有 informational 事件才允许置；默认（缺席）= required
  } & (K extends SurfaceEventType
      ? { surfaceOp: SurfaceOp; sourceEventSeqs?: SessionSeq[] }
      : { surfaceOp?: never; sourceEventSeqs?: never })
}[T]

type SurfaceEventType = 'system/message' | 'developer/message' | 'user/message' | 'assistant/message' | 'tool/result'
type SurfaceOp = 'append' | { op: 'replace'; startSeq: SessionSeq; endSeq: SessionSeq }
```

**delta 会直接用到的那几个（字段已逐字核对）：**

```ts
'turn/start': { turn: number }
'turn/end':   { turn: number; reason: TurnEndReason }
// TurnEndReason = {kind:'completed'} | {kind:'aborted'; reason: TurnEndCancelCause}
//   | {kind:'blocked'} | {kind:'error'; error: LlmFailure} | {kind:'max-tokens'}
//   | {kind:'interrupted'} | {kind:'forked'}
// TurnEndCancelCause = {kind:'user'}|{kind:'parent'}|{kind:'hook'; reason}|{kind:'disposed'}|{kind:'legacy'}

'step/start': { turn: number; step: number }
'step/end':   { turn: number; step: number }

'user/message': UserMessage   // 整个 data 就是 UserMessage：{ role:'user', content: ContentBlock[], id?, source: MessageSource }
// source 区分来源：{ kind:'user' } | 各种 synthetic（agent.inject 的 context、skill 内容、cron 通知…）

'assistant/message': {
  turn: number; step: number
  message: AssistantMessage
  stream: AssistantStreamRecord[]   // 紧凑的时间流
  usage?: TokenUsage
  interrupted?: true
}

'tool/call': { turn; step; callId: ToolCallId; name: string; arguments: string }  // arguments 是模型产出的原始 JSON 字符串，未解析
'tool/result': {
  turn; step
  message: ToolResultMessage
  error?: { name: string; code: string; reason?: string }   // 仅当 message.isError === true
  meta?: JsonValue                                          // 工具私有展示载荷，必须 JSON 可序列化
}

'command/run':  { commandId: CommandId; name: string; args?: string; source: { kind: 'user' } }   // args 在 recordInput:false 时缺席
'command/done': { commandId: CommandId; kind: 'success'|'error'; text?: string; sourceEventSeq?: SessionSeq }

'session/title': SessionTitleEventData   // latest-wins 标题快照，log-only
'working-directory/change': { cwd: string }
'agent/inbox/spliced': { target: InboxTarget; start: number; removedCount?: number; inserted: UserMessage[]; outcome?: 'canceled' }
'model/selection': ModelSelection
'developer/message': { turn; step; message: DeveloperMessage; headerSeq?: SessionSeq }
'system/message': { turn; step; message: SystemMessage }
'assistant/attempt': { turn; step; stream: AssistantStreamRecord[] }
'request/header': { header: EpochHeader; reason: 'initial'|'resume'|'change'|'series'; startsSeries?: true }
'request/context': RequestContext
'session/end-seed': { inherited?: true }
```

证据：`@deepseek-ai/dsh-session@0.2.2-rc.1/lib/types/types.d.ts:261-441`；`@deepseek-ai/dsh-commands@0.2.2-rc.1/lib/types/types.d.ts:89-120`；
`@deepseek-ai/dsh-agent@0.2.2-rc.1/lib/types/types.d.ts:91-110`；`@deepseek-ai/dsh-session-title@0.2.2-rc.1/lib/types/index.d.ts`；
`@deepseek-ai/dsh-working-directory@0.2.2-rc.1/lib/types/index.d.ts:26-32`。

**全部 62 个已注册类型**（`@deepseek-ai/dsh-session@0.2.2-rc.1/lib/types/known-event-types.js` 的 `KNOWN_SESSION_EVENT_TYPES`）：

```
agent-preset/selected      agent/inbox/spliced        approval/asked            approval/decided
approval/policy            assistant/attempt          assistant/message         command/done
command/run                compaction/end             compaction/prune          compaction/start
compaction/summary         deliverables/presented     developer/message         feedback/message-delete
feedback/message-put       feedback/record            goal/change               hook/invoked
hook/result                image/offload              job/registered            job/settled
llm/retry                  llm/retry-started          model/selection           permission/preset
plan/mode                  request/context            request/header            sandbox/mode
schedule/change            session-log-deepseek/delivery-accepted              session/end-seed
session/title              session/title-llm-request  step/end                  step/start
subagent/catalog           subagent/descriptor        subagent/model-selection-policy
system/message             team/member                team/message/delivered    team/message/queued
team/task                  todo/write                 tool-workflow/agent-end   tool-workflow/agent-start
tool-workflow/run-end      tool-workflow/run-start    tool/call                 tool/ptc-dispatch
tool/ptc-dispatch-start    tool/result                turn/end                  turn/start
user/message               web/deepseek-search-llm-request                      working-directory/change
workspace/changes
```

> 有 4 个类型我只拿到名字、没拿到 payload 声明：`hook/invoked`、`hook/result`、`image/offload`、`subagent/*`。
> 桌面安装包里对应的声明包找不到（`@deepseek-ai/dsh-hook*` 不存在）。实现时不要依赖它们。
> **`notice` 不是 SessionEvent 类型**——不存在。UI 侧通知只能走 Client 半边或 actionCards 的 status notice（§5.7）。

**读日志的姿势**：`session.eventAt()/snapshotEvents()/ownEvents()` 已 `@deprecated`，新代码不要用（`dsh-session/lib/types/index.d.ts:210-235`）。
在线状态派生用 `ctx.sessionProjections`，历史/冷读用 `ctx.sessionQuery`（§3.6）。

---

## 3. Agent 操作

### 3.1 `ctx.agents`（AgentRegistry）

```
turnBoundaryOf(session: Session): TurnBoundaryProjection
currentInitiator(): Agent | undefined
requireInitiator(): Agent
withInitiator<T>(agent, operation: () => T): T
withoutInitiator<T>(operation: () => T): T
setFactory(factory: AgentFactory): () => void
create(options: CreateAgentOptions): Promise<AgentHandle>
resume(options: ResumeAgentOptions): Promise<AgentHandle>
register(agent: Agent): ReturnType<Context['effect']>
get(id: SessionId): Agent | undefined
isOwnedBy(id: SessionId, owner: Agent): boolean
list(): Agent[]
roots(): Agent[]
```

`CreateAgentOptions`（`dsh-agent/lib/types/index.d.ts:49-106`）：

```ts
{
  sessionId: SessionId
  parentAgent?: Agent                       // 运行期归属；根 agent 省略
  meta?: { cwd?; parentSession?; isSeeded?; origin?: 'subagent'; delegationDepth?; agentPreset? }
  inheritedEventCount?: SessionLogOffset    // isSeeded 时必须
  seed?: readonly SessionEvent[]            // fork 历史
  agentOptions?: AgentOptions               // { provider?, model?, reasoningEffort?, maxTokens? }
  signal?: AbortSignal
  setup?: (agentCtx: Context, agent: Agent) => AgentSetupCommit | Promise<AgentSetupCommit|void> | void
}
```

`AgentHandle = { agent: Agent; dispose(): Promise<void> }`。**`dispose()` 是能力（capability）**：只有持有它的调用方能拆掉这个 agent。

`setup` 是给插件组合 agent 作用域的地方：在 `agent/created` 之前跑完，里面注册的 scoped tools / prompt section / listener 在首个 prompt assembly 之前就绪。**"Setup composes, it never drives"** —— 不要在 setup 里驱动 agent。

`ResumeAgentOptions = { resumeSessionId; parentAgent?; agentOptions?; signal?; setup? }`。

替代路径：`ctx.get('agentLoop').create(id, options?, meta?)` 直接拿裸 `Agent`（`@deepseek-ai/dsh-agent-loop` 的 `AgentLoop.create`，签名 `create(id: SessionId, options?: AgentOptions, meta?: Pick<SessionHeader,'cwd'>): Promise<Agent>`）。
**推荐用 `ctx.agents.create()`**：它走 registry 的完整生命周期（enter/announce/dispose 配对），且不依赖具体 loop 包。

### 3.2 `Agent` 对象（`agent.ctx` 的宿主）

```ts
interface Agent {
  readonly options: AgentOptions            // provider/model/reasoningEffort/maxTokens，可能是 live accessor
  readonly session: Session
  readonly model: Model                     // current(): Readonly<ModelSelection>|undefined; select(sel): void
  readonly inbox: Inbox                     // nextTurn, nextStep, clear, append, prepend, replace, remove, splice
  readonly status: AgentStatus              // 'idle' | 'running'
  readonly ctx: Context                     // agent 作用域；销毁时全部回收

  cancel(cause: AgentCancelCause, options?: { keepInbox?: boolean }): void
  whenIdle(): Promise<void>
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>
  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void
  followup(message: UserMessage): void      // 排队一个普通 turn 并唤醒
  steer(message: UserMessage): void         // 就近 step 的 steering；空闲则开新 turn
  inject(message: UserMessage): void        // ✅ 给下一步注入上下文，但不唤醒
}
```

证据：`dsh-agent/lib/types/runtime-types.d.ts:163-237`。

**delta 的 `turn.abort` → `agent.cancel({ kind: 'user' })`**。没有 `abort()`。
`cancel` 的 `cause.kind` 决定归因：`'user' | 'parent' | 'hook' | 'disposed'`。
`whenIdle()` **不代表某一个 follow-up 结束**（多个输入可以共享一个 running 区间）。

### 3.3 `ctx.workingDirectory`

```
readonly defaultDirectory: string
get(session: Session): string
ensure(agent: Agent, signal?: AbortSignal): Promise<string>
set(agent: Agent, path: string, signal?: AbortSignal): Promise<string>
```

语义（`@deepseek-ai/dsh-working-directory`）：`session.header.cwd` 是**不可变的原始项目目录**；`workingDirectory` 是**当前生效目录**，改动会 append `working-directory/change` 事件并投影出 `workingDirectory: string | null`（sessionProjections 的 key）。
→ delta 的 `session.cwd()` 对应 `get`，`session.root()` 对应 `session.header.cwd`。

### 3.4 `ctx.subagents`

```
resolveMaxDepth(configured?: number | 'provider-managed'): number | undefined
startActivation(spec: SubagentActivationSpec): Promise<SubagentActivation>
waitForChildren(parent: Agent): Promise<boolean>
sendMessage(sender: Agent, targetId: SessionId, content: ContentBlock[], options: SubagentSendMessageOptions): Promise<MessageId>
interrupt(targetSessionId: SessionId, authority: SubagentInterruptAuthority): void
drainDescendants(parents: readonly Agent[]): Promise<void>
drainChildren(parent: Agent, childIds: readonly SessionId[]): Promise<void>
listChildren(parentSessionId: SessionId, signal?: AbortSignal): Promise<SubagentCatalogEntry[]>
listDescendants(rootSessionId: SessionId, signal?: AbortSignal): Promise<SubagentDescendantListEntry[]>
prompt(request: SubagentPromptRequest, signal: AbortSignal): Promise<SubagentPromptReceipt>   // @Remote('prompt')
interruptByParent(childSessionId, parentSessionId, mode: 'continuable'): SubagentInterruptReceipt  // @Remote
registerProvider(provider: SubagentProvider): () => void
getProvider(name): SubagentProvider | undefined
list(): string[]
```

**这就是 delta `tool.stopTask(agentId)` 的落点：`ctx.subagents.interrupt(sessionId, authority)`。**
`listChildren` 是 delta `agent.list()` + 子 transcript 的落点。

配置里的执行深度：本会话环境 `Delegation depth for subagent: current 1, maximum 1, remaining levels 0` —— 插件**自己有** Agent Teams / subagent 工具，但第三方插件再往下委派会被深度限制卡住。

### 3.5 `ctx.sessionProjections`（在线派生状态 + Client 视图）

```ts
register<K, S>(definition: ProjectionDefinition<K, S> & { wire: NonNullable<...['wire']> }): Promise<ProjectionHandle<S>>
register<K, S>(definition: ProjectionDefinition<K, S> & { key: Exclude<K, keyof SessionProjectionMap> }): Promise<ProjectionHandle<S>>
onChanged(listener): () => void
onEventChanged(listener): () => void
snapshot(session, keys?): ProjectionSnapshot
summaryKeys(): ReadonlySet<string>
checkpoint(session): ProjectionCheckpoint
restoreFloor(checkpoint): SessionLogOffset | undefined
viewCheckpoint(checkpoint, keys?): Partial<SessionProjectionMap>
restore(checkpoint, events, baseSeq, header, inheritedEventCount): { snapshot; checkpoint }
hydrate(session, checkpoint, events, baseSeq): ProjectionSnapshot
```

`ProjectionDefinition`（`@deepseek-ai/dsh-session-projection@0.2.2-rc.1/lib/types/index.d.ts:62-112`）：

```ts
{
  key: string                      // 已声明在 SessionProjectionMap 里的 key，或自带新 key
  stateSchema: ZodType<S>
  init(header: SessionHeader, inheritedEventCount: SessionLogOffset): S
  apply(state: S, event: SessionEvent): S     // 纯同步；不关心的事件必须返回同一个引用（Object.is）
  wire?: {                                     // 只有要给 Client 才需要
    viewSchema: ZodType<...>
    view(state: S): ...                       // 引用不变 = 不推送
    summary?: boolean                         // 是否进 session summary，默认 true
  }
  stateVersion: number                         // 持久化 cache 失效版本，改字段/语义就 +1
}
```

`ProjectionHandle = { stateOf(session): S; readerFor(session): () => S; dispose(): Promise<void> }`。
要点：`apply` **必须同步**、`state` **必须是纯 JSON**（这是持久化 cache 的前提）；`register` 返回 Promise，必须在插件激活期 await 并留住 handle。

**`wire.view` 是 Host→Client 传值的唯一正路**：Client 拿到的已经是算好的值，不需要自己 fold 事件（`references/practices.md` 最后一条）。

现成例子可抄：`@deepseek-ai/dsh-session-title@0.2.2-rc.1` 的 `titleProjectionDefinition`（`lib/types/index.d.ts:96-105`，含 `key/stateVersion/stateSchema/init/apply/wire.{viewSchema,view}`），完整折叠实现看同包 `lib/index.js`。

`sessionProjectionCache` 会持久化 checkpoint（`~/.dsh/storages/session_projcache*` 实测存在），`restore`/`hydrate` 用它做冷启动快捷路径。

### 3.6 `Session` 对象可读字段

```ts
class Session {
  readonly header: SessionHeader            // { version: 4, id, createdAt, cwd?, parentSession?, isSeeded, origin?, delegationDepth?, agentPreset? }
  readonly inheritedEventCount: SessionLogOffset
  get id(): SessionId
  readonly firstLiveSeq: SessionLogOffset
  readonly firstLifecycleSeq: SessionLogOffset
  get surface(): SessionSurface             // 有序表面（派生历史的唯一来源）
  get seq(): SessionLogOffset               // 下一个事件的 seq = 当前 log 长度
  requestHeader(): EpochHeader | undefined
  requestContext(): RequestContext | undefined
  toolHistory(): ToolHistory
  deriveMessages(): Message[]               // 模型看到的历史，每次新的数组，元素深冻结
  deriveEventMessage(event): Message | null
  append<T>(type: T, data: SessionEventMap[T], ...opts: SurfaceIntent<T>): SessionEvent<T>
  isOwnSeq(seq): boolean
  // 已废弃：eventAt / snapshotEvents / ownEvents
}
```

**`append` 的使用限制**（`dsh-session/lib/types/index.d.ts:244-286`）：

- `data` 必须是**无损 JSON**：拒绝 BigInt、函数、symbol、undefined、-0、非有限数、循环、稀疏数组、Map/Set/Date/类实例。
- `SurfaceEventType`（5 种）**必须**传 `{ surfaceOp: 'append' }` 或 `{ op:'replace', startSeq, endSeq }`。
- 非 surface 类型**禁止**传 `surfaceOp`/`sourceEventSeqs`。
- `tool/result` 的 `error` 只在 `message.isError === true` 时允许。
- **不能新增 type**（新类型写不进 `ignorable`）→ 插件自有状态用 KV domain。

`SessionStore`（`ctx.sessions`）：
```
registerMessageProjection(projection): () => Promise<void>
create(id?, options?): Session
prepare(id?, options?): Session
enter(session): () => void
announce(session): void
flush(session): Promise<boolean>
get(id): Session | undefined
list(): Session[]
fork(source, boundary?, childSessionId?): Session
```

---

## 4. commands 服务

### 4.1 `CommandDefinition` 完整字段

```ts
interface CommandDefinition {
  readonly definitionId?: CommandDefinitionId   // 插件自有稳定标识；有基于 id 的 client 行为时才需要
  readonly name: string                         // 小写、不带前导斜杠
  readonly description: string
  readonly input?: { hint: string; attachments?: boolean }
  readonly recordInput?: boolean                // 默认 true；false 时 command/run 不记 args
  readonly handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>
}

interface CommandInvocation {
  readonly commandId: CommandId     // 已写进 command/run 的配对 id
  readonly agent: Agent
  readonly rawInput: string         // 命令名之后的原文，含分隔空白
  readonly attachments: readonly (ImageBlock | FileBlock)[]
  readonly signal: AbortSignal
}
```

证据：`@deepseek-ai/dsh-commands@0.2.2-rc.1/lib/types/index.d.ts:17-55`。

### 4.2 handler 返回值

```ts
type CommandResult =
  | { kind: 'success'; text?: string; sourceEventSeq?: SessionSeq }
  | { kind: 'error';   text: string }
```

`ctx.commands.execute()` 返回的是：

```ts
interface CommandExecution { readonly commandId: CommandId; readonly result: CommandResult }
```

`execute()` 返回 `undefined` ⟺ 语法不对或名字解析不到（**此时不写任何日志**）。

### 4.3 注册与执行

```js
export const inject = ['commands']

export function apply(ctx) {
  ctx.effect(() => ctx.commands.register({
    name: 'delta',
    description: 'Share this conversation through Delta',
    input: { hint: 'share | join <url> | status' },
    async handler({ agent, rawInput, signal }) {
      const [verb] = rawInput.trim().split(/\s+/)
      if (verb === 'share') { /* ... */ return { kind: 'success', text: 'Sharing…' } }
      return { kind: 'error', text: `Unknown subcommand: ${verb}` }
    },
  }))
}
```

```
ctx.commands.register(definition): () => void
ctx.commands.find(agent, name): CommandDefinition | undefined
ctx.commands.list(agent): readonly CommandDescriptor[]
ctx.commands.execute(agent, line, submittedAttachments, signal): Promise<CommandExecution | undefined>
```

注册在**普通 ctx** 上是全局命令；注册在**某个 agent context 的 command-injected 子 ctx** 上会 shadow 全局（`CommandRuntime` 类注释，`index.d.ts:76-79`）。

### 4.4 从 Client 调 `ctx.remote.commands.execute`

Client 侧调用签名（由 typert 生成，`@Remote` 标注在 `CommandRuntime.execute` 上）：

```ts
// Client：
await ctx.remote.commands.execute(agent, '/delta share', [], signal)   // Promise<CommandExecution | undefined>
await ctx.remote.commands.list(agent)                                  // readonly CommandDescriptor[]
```

**限制（重要）**：

- `execute` 的 `agent` 参数在线上是投影出来的 `sessionId`（`SessionId` 是 TypertResource，由 session controller 注册默认 wire 字段）。
- `submittedAttachments` 只有命令声明了 `input.attachments` 才能非空，否则 registry 在 handler 之前就返回 error（`index.d.ts:126-131`）。
- **第三方 Host 插件不能自己造 Remote 方法**：`@Remote` 依赖 `lib/typert.host.js`（`@deepseek-ai/dsh-typert-generator` 生成，见 commands `package.json` 的 `exports["./typert"]` 与 `files` 里的 `lib/typert.host.js`/`lib/typert.remote-client.js`）。纯 JS 插件没有 codegen → 没有 Remote。
  → **Client 半边要触发 Host 动作，就走「注册一个命令 + `ctx.remote.commands.execute`」**，这正是 `references/user-actions.md` 给的推荐路径。

### 4.5 `command/run` / `command/done` 日志事件

规则（`dsh-commands/lib/types/index.d.ts:114-141`）：

- **`command/run` 在 handler 调用之前** append，`command/done` 在结算之后 append（handler 抛错/被 abort 也结算为 `kind: 'error'` + 渲染好的失败文案）。
- 两者都是 **log-only 直接 append，不包 turn**，persistence 在普通 checkpoint 落盘。
- **准入失败（语法错/未知命令）不写任何日志。**
- `command/done` 的 append 失败，在 handler 已失败路径上被吞掉（保留 handler 自己的失败）。
- 成功时可带 `sourceEventSeq` 指向更早的权威 domain 事件，让 client 做更丰富的展示。

监听方式：

```js
ctx.on('session/event', (session, event) => {
  if (event.type === 'command/run')  { const { commandId, name, args } = event.data }
  if (event.type === 'command/done') { const { commandId, kind, text } = event.data }
})
```

---

## 5. 其他服务

### 5.1 `ctx.storage` / `ctx.storageDomain`（KV）

`ctx.storage`（hub）：
```
readonly backend: BackendRegistry
mount<K>(form: K, facility: StorageForms[K]): () => void
form<K>(form: K): StorageForms[K]
```

`ctx.storageDomain`（域设施）：
```
open<S extends DomainSpec>(spec: S): Promise<Domain<S>>
get(name: string): DomainImpl | undefined
closeAll(): Promise<void>
```

域声明（`@deepseek-ai/dsh-storage-domain@0.2.2-rc.1/lib/types/spec.d.ts`）：

```ts
interface DomainSpec {
  readonly name: string                 // 必须匹配 UNIT_NAME_RE；同时是 backend unit 名
  readonly version: number
  readonly layout?: 'single' | 'per-record'
  readonly compatibleVersions?: readonly number[]
  readonly invalidRecords?: 'backup-and-skip'
  readonly global?: { schema: ZodType<G>; initial: G }
  readonly tables: Record<string, { valueSchema: ZodType<V>; __key?: K }>
}
```

运行时：
```
Domain<S>          { name; global: DomainGlobal<S>; table(name): KvTable; close(): Promise<void> }
DomainGlobal<G>    { get(): G; set(v: G): Promise<void> }
KvTable<K,V>       { get(k): V|undefined; entries(); keys(); size; put(k,v): Promise<void>;
                     delete(k): Promise<boolean>; deleteMany(keys): Promise<number>; update(k, fn): Promise<V> }
```

写语义：**先落盘再改内存再 emit `domain/changed`**；后端失败则内存不动；读是同步内存读；`put` 是整体替换不是部分合并。
`close()` 由消费者自己负责（通常作为自己的 `ctx.effect` disposer）。

**不要 `import` 这个包的 `defineDomain`/`domainTable`**（见 §1.7）。自己写等价的对象字面量即可，zod schema 用你自己依赖的 zod（guizang 就没用 domain，直接写 JSON 文件；但 delta 需要多点写入，KV domain 更合适）。

**这是 delta `store`（KV：get/set/delete/keys）的落点。**

### 5.2 `ctx.subprocess`（**没有 `run`，只有 `spawn`**）

```
abstract resolveExecutable(command, env?, signal?): Promise<string>
abstract terminalEnvironment(signal?): Promise<SubprocessTerminalEnvironment>
abstract spawn(spec: SubprocessSpawnSpec): SubprocessHandle
abstract spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle>
```

`SubprocessSpawnSpec`（`@deepseek-ai/dsh-subprocess@0.2.2-rc.1/lib/types/types.d.ts:69-99`）：

```ts
{
  argv: readonly string[]        // argv[0] 是程序，**从不做 shell 解释**
  cwd: string
  stdio: {
    stdin: 'ignore' | 'pipe' | { data: string }
    stdout: 'pipe' | 'inherit' | { maxBytes: number; spill?: { maxBytes: number } }
    stderr: 'pipe' | 'inherit' | { maxBytes: number; spill?: { maxBytes: number } }
    control?: 'pipe'
  }
  graceMs: number                // 正有限 ms，终止程序的宽限；也用于排空未关的 collected pipe
  signal?: AbortSignal           // 触发即开始 terminate 升级
  env?: NodeJS.ProcessEnv        // 显式条目，叠加在 scrub 过的父环境上；undefined 是 tombstone（删除）
}
```

`SubprocessHandle`（同文件 156-183）：

```ts
{
  readonly stdin: Writable | undefined      // 仅 stdin:'pipe'
  readonly stdout: Readable | undefined     // 仅 stdout:'pipe'
  readonly stderr: Readable | undefined
  readonly control: Duplex | undefined
  readonly collected: { stdout?: SubprocessOutputReader; stderr?: SubprocessOutputReader }  // collect 模式，退出后仍可读
  readonly done: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>        // 退出码 / 终止信号
  terminate(): void                          // 唯一的终止动词；幂等；signal 触发也走它
  waitForExit(signal?): Promise<boolean>     // 等托管进程组空，不只是等子进程报 outcome
}

// 流式读取（collect 模式）：
SubprocessOutputReader.readFrom(fromByte: number): {
  text: string; nextOffset: number; lossy: boolean; spillPath?: string
}
```

**流式读 stdout 的两种姿势**：

```js
// A. 原始流（边读边解析）
const h = ctx.subprocess.spawn({
  argv: ['git', 'log', '--oneline'], cwd, graceMs: 2000,
  stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  signal,
})
h.stdout.on('data', (chunk) => { /* chunk 是 Buffer */ })
const outcome = await h.done             // { exitCode, signal }

// B. 有界收集 + offset 增量读（推荐给「跑完拿输出」，等价于 process.run）
const h2 = ctx.subprocess.spawn({
  argv: ['git', 'rev-parse', '--show-toplevel'], cwd: root, graceMs: 5000,
  stdio: { stdin: 'ignore', stdout: { maxBytes: 1 << 20, spill: { maxBytes: 8 << 20 } }, stderr: { maxBytes: 1 << 18 } },
  signal,
})
const { exitCode } = await h2.done
const out = h2.collected.stdout.readFrom(0)   // { text, nextOffset, lossy, spillPath? }
```

超时：**自己 `AbortController` + `graceMs`**，服务本身不提供 timeout 参数（"the caller owns deadlines"）。
kill：`handle.terminate()`。

**delta 的 `process.run(argv, {cwd})` → 上面 B 形态封一个本地 helper**（`{ stdout, stderr, exitCode }`）。`process.spawn` → 上面 A 形态。

### 5.3 `ctx.fs`

`FsTarget` 是**不透明**的：`{ targetKey: FsTargetKey; displayPath: string }`，**不能解析 key、不能假定是本地绝对路径**。

```
resolve(path, opts?: { cwd?, signal? }): Promise<FsTarget>
processPath(target): string
processPathFromHostPath(hostPath): string | undefined
fileUrl(target): string
contains(parent, child): boolean
stat(target, signal?): Promise<FsInfo | undefined>
lstat(path, opts?, signal?): Promise<FsPathInfo | undefined>
readText(target, signal?): Promise<string>
streamText(target, signal?): Promise<AsyncIterable<string>>
readBytes(target, signal, maxBytes): Promise<Uint8Array>
readByteRange(target, range, signal?): Promise<Uint8Array>
listDir(target, signal?): Promise<FsDirEntry[]>
writeText(target, content, expected?: FsWriteIntent, signal?, sandboxPolicy?): Promise<FsWriteOutcome>
editText(target, edit: FsEditRequest, expected?: { version }, signal?, sandboxPolicy?): Promise<FsEditOutcome>
patchText(target, hunks, expected?, signal?, sandboxPolicy?): Promise<FsEditOutcome>
deleteFile(target, expected?, signal?, sandboxPolicy?): Promise<FsDeleteOutcome>
moveFile(source, destination, options, signal?, sandboxPolicy?): Promise<FsMoveOutcome>
watch(target, changed: (error?: Error) => void, signal): Promise<() => Promise<void>>
```

写操作会触发 `fs/{write,edit,delete}-intent` waterfall 与 `fs/observed`，并受 sandbox policy 影响（`sandboxPolicy?` 参数）。
**注意**：插件自己的文件读写（比如存 `~/.dsh/delta/...`）用 `node:fs` 更直接（guizang 就是这么做的，`lib/library.js` 用 `node:fs` + `homedir()`）；`ctx.fs` 是「模型可见文件系统」，带沙箱和版本守卫。

### 5.4 `ctx.timer`（混入 Cordis context，直接 `ctx.timeout` 等）

```
timeout(callback, delay): () => void
timeout(delay): Promise<void>
interval(callback, delay): () => void
interval<R>(delay): AsyncIterableIterator<void, R, void>
throttle<F>(callback, delay, noTrailing?): ((...a) => void) & { dispose: () => void }
debounce<F>(callback, delay): ((...a) => void) & { dispose: () => void }
```

它们是 **disposable**：在 `ctx.effect` 里注册，卸载时自动清。`references/practices.md` 提醒：定时器要唤醒 agent 用 `agent.followup()`（`agent.inject()` 不唤醒）。

### 5.5 `ctx.userQuestions.ask`

```ts
async ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer>
async askTimed(request & { agent: Agent }, callId: ToolCallId, timeoutMs: number): Promise<TimedUserQuestionResult>
@Remote answer(agent, callId, answer: AskUserQuestionAnswer): boolean
@Remote({ mode:'stream' }) attachWait(agent, callId, signal): AsyncIterable<{ remainingMs: number }>
```

请求 / 答案形状（`@deepseek-ai/dsh-user-questions@0.2.2-rc.1/lib/types/types.d.ts`）：

```ts
interface AskUserQuestionItem {
  id: string                 // caller 给的稳定 id，答案里回显
  question: string
  detail?: string
  header?: string            // 短标题
  options?: { label: string; description?: string }[]
  multiSelect?: boolean      // 默认单选
  intent?: AskUserQuestionIntent   // 'plan-review' | 'approval'，只影响展示
}
interface AskUserQuestionAnswer {
  answers: {
    id: string
    selected: string[]       // 选中的 label（多选可多项）
    custom?: string          // 自由文本 "Other"
  }[]
}
interface AskUserQuestionRequest {
  questions: AskUserQuestionItem[]
  agent?: Agent
  signal?: AbortSignal
  wait?: { callId: ToolCallId; timed?: boolean }
}
```

监听/intercept 用 waterfall 事件 `'user-questions/request'`。

### 5.6 settings / configEditor

**`ctx.settings`**
```
configure(presentation: { auto?: boolean }, owner?: Fiber): () => void
prepareDocument(): Promise<string>
describe(options?): SettingsDescriptor[]
update(ns: string, patch: object, expectedRevision?: number): Promise<void>
replace(ns: string, section: object, expectedRevision?: number): Promise<void>
mutate(ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void>
```

**`ctx.configEditor`**（`@deepseek-ai/dsh-config-editor`，`lib/types/index.d.ts`）
```
get documentPath(): string
entries(): Entry[]
configuration(): Array<{ entry: Entry; inherited: Record<string,unknown>; override: Record<string,unknown> }>
edit(entry: Entry, change: (current, inherited) => Record<string,unknown>): Promise<void>
```

插件持久化自己的配置**唯一允许的方式**（`host-plugin.md:66-77`）：

```js
const entry = ctx.fiber.entry
const editor = ctx.get('configEditor')
if (entry === undefined || editor === undefined) throw new Error('Configuration cannot be saved in this profile')
await editor.edit(entry, (current) => ({ ...current, field: value }))
```

规则：
- **绝不**自己去读写 profile 的 `cordis.patch.yml`，也不要用包目录向上遍历去找它——那是用户的文件，含别人的 `insert`、注释、`!!js`。
- editor 会保留文件其余部分、校验候选值、与其它 profile 变更串行化、拒绝被更高层覆盖的值。
- 改普通字段会**重启该插件**（`apply` 重跑重建状态）；声明为 `.volatile()` 的字段原地更新，用 `config.field.get()` 读。这在 **schemastery Config** 里是支持的（`Config.string().volatile()`），但本机未实测。
- 密钥不要放 config，放 `ctx.credentials.modifyRecord()`。

### 5.7 `ctx.actionCards`

```
register<Details>(kind: ActionCardKind<Details>): () => void
record(agent: Agent, decision: ActionCardDecision): void
view(session: Session): ActionCardView
@Remote act(agent: Agent, callId: ToolCallId, verb: string, payload?): Promise<ActionCardResult>
```

`ActionCardKind`（`@deepseek-ai/dsh-action-cards@0.2.2-rc.1/lib/types/index.d.ts:53-101`）：`{ action, skill, invitation, details: ZodType<Details>, verbs: Record<string, { global?: true; writes?: true }>, openPhases?, statusGuidance?, statusFields?, dismissal?, reconcile?, act }`。

用途：模型通过 `propose_action` 工具提出一个卡片（带 `details`），用户点按钮 → `verbs` 里的 verb 走到 `kind.act`。**这是 DSH 里「用户点卡片触发 Host 动作」的标准机制**，比命令更结构化。它天然带 Client 渲染（`dsh-client-ui-action-cards` 已装），且**第三方插件可以用**（`register` 只要 zod schema + handler，不需要 typert codegen）。
代价：必须先有一个 skill 声明该 action（`kind.skill` 决定 `propose_action` 何时对模型可见）。

### 5.8 `uiConversation.events.register` —— 这是 **Client** API

`ctx.uiConversation` 在 Host Service 目录里**不存在**（`Service.listService` 里没有）。它是 Client 半边：

```js
// client.js（浏览器里跑）
ctx.uiConversation.events.register(definition)     // 注册一个 Chat 行的事件定义
// 然后在该定义 kind 对应的 'conversation.chat.node' slot 注册渲染组件
```

证据：`references/practices.md` UI 段最后两条；Client Service inspect（`cordis_inspect_query(client, Service)`）**本机超时**（没有页面连接），所以这条只有文档依据，**未能实测**。要确认就在本机 GUI 打开页面后跑
`cordis_inspect_query({platform:'client', provider:'Service', method:'listService', input:{service:'uiConversation'}})`。

### 5.9 `ctx.sessionTitle`

```
get(session): SessionTitleSnapshot | undefined
rename(session, title): SessionTitleSnapshot            // 写 session/title，source:'user'，钉住标题
refresh(session, signal?): Promise<SessionTitleSnapshot | undefined>
register(provider: SessionTitleProvider): () => Promise<void>
```
provider：`{ id: SessionTitleProviderId; automatic: 'first-prompt'|'all-prompts'; generate(req) }`，`generate` 返回 `{ title, messageSeqs, model? }`。全局只能有一个 provider。

### 5.10 `ctx.sessionTelemetry`

```
abstract readonly sharing: SessionTelemetrySharingStatus
abstract emit(record: SessionTelemetryRecord): void
flush?(): void
abstract shutdown(): Promise<void>
```
它是**可加载的 backend 契约**（一个 context 只能一个实现，key 是 `telemetry`）。第三方插件要上报自己的指标，走 `'session-telemetry/record'` waterfall 改写出站 record，而不是自己 `emit`。
本机 `session-log-deepseek` 在 `cordis.patch.yml` 里是 `enabled: false`。

### 5.11 `ctx.pluginManager`（自更新 / 自检）

```
readBundleDetail(name, language, options?): Promise<BundleDetail>
listPlugins(): Promise<PluginInfo[]>
listBundles(): Promise<BundleInfo[]>
registries(): Promise<PluginRegistries>
inspect(spec, options?, signal?): Promise<PluginSpecInspection>
listVersions(name, options?, signal?): Promise<PluginVersionList>
updateBundle(name, version, options?): Promise<PluginUpdateResult>
setPluginEnabled(id, enabled): Promise<ChangeResult>
setBundleEnabled(name, enabled): Promise<ChangeResult>
installBundle(spec, options?): Promise<ChangeResult>
waitForInstall(requestId): Promise<ChangeResult | null>
cancelInstall(requestId): Promise<PluginInstallCancellation>
removeBundle(name): Promise<ChangeResult>
listVersionExemptions(): { exemptions; warnings }
setVersionExemption(packageVersion, runtimeVersion, enabled, acceptRisk?): Promise<ChangeResult>
```

**插件自更新**：`updateBundle(自己包名, version)`。`updateBundle` 会移除旧版本再装新版本；`plugin-manager/update-state` 事件报告阶段。
**自检**：`listBundles()` 里找自己的 `BundleInfo`（`enabled`/`installed`/`version`/`rows`/`error`）。
监听 `'plugin-manager/changed'`（`emit`，payload `PluginChange`）感知 profile 变更。

⚠️ `installBundle`/`updateBundle` 在第三方插件里调用会**改动用户的 profile**，属于重度副作用。当前会话的 `plugin_manager` 工具需要 danger-full-access 审批，而本会话审批被禁用 → 插件里做自更新的事**必须由用户显式触发**。

### 5.12 sandbox 对 Host 插件的影响

```
ctx.sandbox:          abstract confine(argv: readonly string[], policy: SandboxPolicy, signal?): Promise<ConfinedArgv>
ctx.sandboxPolicy:    readonly defaultMode: SandboxMode
                      readonly workspaceRoot: string
                      readonly additionalWritableRoots: readonly string[] | undefined
                      resolve(request?: SandboxPolicyRequest): SandboxExecutionPolicy
                      overrideOf(session: Session): SandboxMode | undefined
```

- `sandbox` 只**包一层 argv**（把命令套进沙箱启动器），不管文件 IO。
- `sandboxPolicy` 决定当前 mode / 可写根。`ctx.fs` 的写操作接受 `sandboxPolicy` 参数。
- **对本会话的直接影响**（实测，不是文档）：插件进程内的 `node:fs` 写**不受** `ctx.fs` 沙箱约束，但**受 DSH 会话级文件策略约束**——本会话是 `workspace-write`，工作区外写会被拒（`[sandbox: file access denied under <mode> mode]`）。
  证据：本会话执行 `mkdir /tmp/dsh-research` **成功**（平台临时区放行），但 profile 目录拒写。
  → 插件的持久数据目录应放 `$DSH_HOME` 下（guizang 用 `~/.dsh/guizang-design/`，`lib/library.js` 的 `dataDir()`），或工作区内。
- `session-log-deepseek`、`session-persistence` 这些与沙箱无关。

---

## 6. 本机验证手段

### 6.1 `cordis_inspect_query`（首选，免审批）

Provider 清单（`cordis_inspect_list` 实测）：

| platform | provider | method | 用途 |
|---|---|---|---|
| host | `Service` | `listService` (`{service?}`) | 按 key 查精确方法签名；省略 `service` 返回能力目录 |
| host | `Event` | `listEvents` (`{event?}`) | 查事件名/模式/签名；省略返回目录 |
| host | `Config` | `listConfigs` (`{name?, entry?, offset?, limit?}`) | 已挂插件行的 Config JSON Schema；`name` 过滤包名，`entry` 拿 `packageDir` |
| host | `Tool` | `listTools` (`{}`) | 当前 Agent 可调用的工具 schema |
| client | `Service` | `listService` | Client 服务（需要页面连接） |
| client | `Event` | `listEvents` | Client 事件 |
| client | `Builtin` | `listBuiltins` | 动态 Client 半边可用的纯 JS 符号 |
| client | `Slots` | `listSubTree` (`{root?}`) | 活 slot 树 + 某 slot 的 catalog/occupants |
| client | `Theme` | `listTokens` | 主题 token 名 |

**"插件是否真的生效"用 `Config.listConfigs` 查自己的行**（skill 明确要求："Confirm new rows with approval-free `cordis_inspect_query`, not `list_plugins`"）：

```
cordis_inspect_query({platform:'host', provider:'Config', method:'listConfigs', input:{name:'@your/package'}})
→ 目录里出现你的 entry id  =  行已挂上
cordis_inspect_query({... input:{entry:'<entry id>'}} )
→ 返回 packageDir + 投影后的 Config Schema
```

### 6.2 命令 / 服务是否生效

- 命令：`ctx.commands.list(agent)`（Host 侧）或 Client 侧 `ctx.remote.commands.list(agent)` / 在输入框敲 `/` 看目录。
- 服务：`cordis_inspect_query(host, Service).listService({service:'命令名'})` —— 存在即挂载。
- 事件：`cordis_inspect_query(host, Event).listEvents({event:'你的事件'})`。
- **`plugin_manager` 的 `list_plugins` 不适合做验收**：每次调用都要审批，且它只报持久化状态不报运行时生效。

### 6.3 日志文件位置（实测）

| 内容 | 路径 |
|---|---|
| 插件安装（pnpm）输出 | `~/.dsh/profiles/desktop/.plugin-manager/logs/operation-<id>/pnpm.log`（每次安装/移除一个目录） |
| 会话 JSONL | `~/.dsh/sessions/<cwd-slug>/`（slug 形如 `--Users-run-my-repos-delta-claude--`） |
| 投影 cache | `~/.dsh/storages/session_projcache.json` + `session_projcache/sessions/` |
| 工作区注册表 | `~/.dsh/storages/workspace.json` |
| Desktop 应用日志 | `~/Library/Logs/DeepSeek Harness/` —— **实测为空目录**，别指望它 |
| 插件自身诊断 | `ctx.logger.{debug,info,warn,error}`（Cordis logger，所有官方包都用它）。**sink 未实测**，只能确定它不是用户可见 UI |

安装过程的实时流：事件 `'plugin-manager/install-log'`（emit，`chunk: PluginInstallLogChunk`）、`'plugin-manager/install-state'`（emit，`progress: PluginInstallProgress`）。GUI 的安装进度就是这么来的。

### 6.4 HMR 与重启要求

- desktop profile **有** HMR：`~/.dsh/profiles/desktop/cordis.patch.yml` 没禁它，而 `@deepseek-ai/dsh-hmr` 的 row 条件是 `disabled: !!js "!ctx.get('profileContext')"`（`dsh-base/cordis.patch.yml:28-29`），desktop 有 profileContext → **启用**。
- **新 bundle 装入可以走 HMR 激活**；**替换已安装的同名包必须重启**（要加载新的 JS module generation）。
- `ChangeResult.application === 'restart-required'` + `restartReason` 就是判据，5 种原因见 §1.6。
- 插件代码**改了文件但没重装**：HMR 会监听（`hmr/change`/`hmr/reload` 事件），但**不要依赖**；改完重新 `install_bundle` 最可靠。
- Client 半边：`dsh-client-hmr` 负责浏览器侧重建与 reload transport。**"slot id 没变" 不等于浏览器代码更新了**。

### 6.5 用 `dsh` CLI / HTTP 跟运行中的 desktop 交互

**`dsh` CLI 存在**（`/usr/local/bin/dsh`，`dsh --version` → `0.2.2-rc.1`），但：

```
$ dsh --profile desktop --dump-config
error: profile "desktop" is managed exclusively by the Electron application
```

→ **desktop profile 不能用 CLI 启动/转向**。CLI 只能用于：`dsh web`/`dsh tui`/`dsh headless` 起**别的** profile、`dsh plugin --profile <name> add <pkg>`。
`dsh plugin --profile desktop ...` 会不会也被同一个守卫挡住，**未实测**（怕它跑 pnpm 动 profile）；按这条错误推断大概率同样受限，要装插件就走 `plugin_manager`。

**HTTP**：`http://127.0.0.1:64350` 需要认证。

```
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:64350/        → 401
$ curl -s http://127.0.0.1:64350/api                                   → unauthorized
```

认证走 `ctx.connection`：
```
readonly rpc: HostConnectionRpc
readonly fetch: HostConnectionFetch
readonly browserPeer: PeerScope
readonly allowsRemoteAuthorities: boolean
authenticatedUrl(baseUrl: string): string    // ← 这就是拿带 token 的 URL 的方法
admit(request): PeerAdmission
createPeer(options): PeerScope
```
token 存在哪、怎么取，本次**未定位**（`~/.dsh/.credentials.yaml` 是 LLM 凭据，不是 web token；不属于本任务范围，也不该去翻）。
**结论：验证走 GUI / `plugin_manager` / `cordis_inspect_query`，不要试图用 curl 打 `/api`。**
`ctx.webApp.getAdvertisedUrl()` 能拿到对外公布的 URL。

### 6.6 语法/清单预检（装之前）

```sh
node --check <bundle>/index.js          # 纯 JS 语法
node -e "JSON.parse(require('fs').readFileSync('<bundle>/package.json','utf8'))"
# patch YAML 用 node 的 yaml 解析一遍；`dsh --profile <non-desktop> --patch <你的patch> --dump-config` 也能验
```
`references/verification.md`：**不要**为了验证去起第二个浏览器、改 `HOME`、翻个人浏览器 profile、找 token、改 keychain；没有浏览器控制时就只报「语法/清单/slot 注册已验，视觉未验」。

---

## 7. delta 概念 → DSH 映射表

| delta Host 概念 | DSH 对应实现 | 可行性 / 备注 |
|---|---|---|
| `session.id()` | `agent.session.id`（`SessionId` brand，运行时是 string） | ✅ 直接可用 |
| `session.cwd()` | `ctx.workingDirectory.get(agent.session)`（生效目录） | ✅ |
| `session.root()` | `agent.session.header.cwd`（不可变原始项目目录） | ✅ 语义要分清 |
| `session.messages()`（主会话 rows） | ① 在线派生：`ctx.sessionProjections` 自定义 unit；② 历史/冷读：`ctx.sessionQuery.readSession(sessionId)` / `readSurface(sessionId)` | ⚠️ **不要用** `session.snapshotEvents()`（已废弃）；`session.surface` 可用但同步在读 |
| `session.apiMessages()` | `agent.session.deriveMessages(): Message[]`（返回模型看到的 Message 数组，深冻结） | ✅ 最接近 api messages |
| `session.agentMessages({agentId})` / `agentApiMessages` | `ctx.subagents.listChildren(parentSessionId)` 拿目录；具体内容用 `ctx.sessionQuery.readSession(childSessionId)`，或若 child 是 live agent，`ctx.agents.get(id).session.deriveMessages()` | ✅ 但需自己判 live/persisted |
| `session.append()`（写 Claude 行） | **不可实现**（不能新增 SessionEvent 类型） | ❌ 替代：① 派生自既有事件（`user/message`/`assistant/message`/`tool/call`/`tool/result`/`turn/start`/`turn/end`）；② delta 自己的记录放 `ctx.storageDomain` KV 表（`delta/rows`），用 `sessionId` 做 key 前缀 |
| `session.turns()` | `ctx.agents.turnBoundaryOf(session)` → `TurnBoundaryProjection`；或 `sessionProjections` 里 fold `turn/start`/`turn/end` | ✅ |
| `session.surfaces()`（`'desktop'`/`'cli'` 等） | **无对应概念**。DSH 是单一 Web UI + 可选 terminal/preset | ❌ 替代：判断 `ctx.get('webApp') !== undefined` 即「有 Web 面」；或用 agent preset 名 `ctx.agentPresets.presetForSession(session)` |
| `session.version()` | 无「会话修订号」。最接近：`session.header.version`（= `SESSION_FORMAT_VERSION` = 4，**格式版本不是修订号**）；要单调水位用 `session.seq` | ⚠️ delta 若用 version 做「会话变更检测」，改成 `session.seq` 或投影 watermark |
| `transcript`（磁盘 JSONL 路径） | 不直接读文件。`ctx.sessionQuery.readSession/readSurface/readEvent`；已持久化的会话 JSONL 在 `~/.dsh/sessions/<cwd-slug>/` | ⚠️ 读盘可行但绕过 API，易随格式变化；优先 sessionQuery |
| `ui.status(...)`（状态行） | **Host 无 API**。替代：① Client 半边（`dsh.client`）在某 slot 渲染；② `ctx.actionCards` 的 status notice / `propose_action` 卡片；③ 往模型侧说话用 `agent.inject()` | ❌ Host-only 做不出来。delta 的常驻状态条是最大缺口 |
| `ui.log(text, {to})` | 无用户可见通道。`ctx.logger.*` 只是诊断 | ❌ 同上，需要 Client 半边 |
| `ui.invalidate()` | Client 侧自动：projection `wire.view` 引用变化即推送；`sessionProjections.onChanged` 是 Host 侧变更源 | ✅ 换个机制 |
| `ui.ask(...)` | `ctx.userQuestions.ask(request)` | ✅ 形状不同，见 §5.5 |
| `process.run(argv, {cwd})` | `ctx.subprocess.spawn(spec)` + `stdio.stdout/stderr = {maxBytes}` + `await handle.done` + `handle.collected.*.readFrom(0)` | ✅ 需自己封 helper（没有 `run`） |
| `process.spawn(...)` | `ctx.subprocess.spawn({ stdio: { stdin:'pipe', stdout:'pipe', stderr:'pipe' } })`，用 `handle.stdout/stderr` 原始 Readable | ✅ |
| `store.{get,set,delete,keys}` | `ctx.storageDomain.open(spec)` → `domain.table(name)` 的 `KvTable`（`get/put/delete/deleteMany/keys/size`） | ✅ 需自己声明 DomainSpec（不要 import 官方包） |
| `turn.abort()` | `agent.cancel({ kind: 'user' })`；保留排队输入用 `{ keepInbox: true }` | ✅ 无 `abort` |
| `tool.stopTask(taskId)` | `ctx.subagents.interrupt(sessionId, authority)`；PTY 用 `ctx.terminals.kill(owner, id)`；job 用 `ctx.jobs` | ✅ |
| `settings.policy()`（组织托管配置） | **无组织策略概念**。最接近 `ctx.settings.describe()`（profile 设置表单）+ `ctx.sandboxPolicy.resolve()`（沙箱策略）+ `ctx.approval.overrideOf(session)` | ⚠️ 若 delta 靠 policy 做「组织禁用某些功能」，DSH 侧要改成插件自己的 Config |
| `agent.list()` / `agent.spawn()` | `ctx.agents.list()` / `ctx.agents.roots()`；spawn 用 `ctx.agents.create(CreateAgentOptions)` 或 `ctx.subagents.startActivation(spec)` | ✅ |
| `command.{list,register,run}` | `ctx.commands.list/find/register/execute` | ✅ |
| `fs.{exists,read,write,list,stat}` | `ctx.fs.resolve/readText/writeText/listDir/stat`（模型可见文件系统，带沙箱+版本守卫）；插件私有文件用 `node:fs` | ✅ 二选一要想清楚 |
| `clock.{after,every,now,sleep}` | `ctx.timeout(cb, ms)` / `ctx.interval(cb, ms)` / `Date.now()` / `await ctx.timeout(ms)` | ✅ dispatcher 随 ctx 回收 |
| `http.fetch(url)` | 没有全局 fetch 服务（`ctx.web.fetch` 需要 provider 注册）。Node 22 的全局 `fetch` 可直接用 | ✅ |
| `prompt.submit(text)` | `agent.followup(userMessage)`（开新 turn，唤醒）或 `agent.steer(...)`（就近 step） | ✅ |
| `env.{home,os,userProfile,claudeConfigDir,...}` | `process.env` / `os.homedir()` / `process.platform`（guizang 实测可用） | ✅ |
| `plugin.name()` / `plugin.root()` | `import.meta.url` → `fileURLToPath(new URL('..', import.meta.url))` | ✅ |
| `config.list()` | `ctx.configEditor.configuration()` / `ctx.settings.describe()` | ✅ |
| `agent 生命周期 hook`（delta 的 `session.append` hook 拦截） | 事件 `'session/event'`（emit，post-commit）+ `'tools/*'` waterfall + `'agent/pre-step'` waterfall。**注意 `session/event` 是通知，不能改写**，要拦截在 append 之前没有等价点 | ⚠️ delta 的 append 拦截必须在写入方（模型侧）改用「不要写」，或改用 waterfall（`tools/post-execute` 可改 result；`agent/pre-step` 可改 messages） |

---

## 8. 最大风险 / 未知点（实现前必须知道）

1. **第三方插件不能 `import '@deepseek-ai/*'`**（实测）。所有类型只能 `import type` + devDependency。这决定了 `delta-dsh` 必须写成**纯 JS 或 TS→ESM 构建且运行时零 @deepseek-ai 依赖**，大量东西要手抄（surfaceOp 字面量、PreStepDecision、KV domain spec）。
2. **不能新增 SessionEvent 类型**。delta 的「写 Claude 行」核心能力只能降级为「派生既有事件 + 自有 KV」。这是产品语义的损失，不是实现偷懒。
3. **`ui.status` / `ui.log` / `session.surfaces()` 三个 delta 概念在 Host 侧无对应**。要它们就必须写 Client 半边（`dsh.client` + slot），工作量和风险都上一个台阶；且 Client inspect 本机超时未验。
4. **第三方无法定义 Remote 方法**（需要 typert codegen）。Client→Host 只能走 commands 或 actionCards。
5. **HMR 边界**：新 bundle 可 HMR 激活，**替换同名包必须重启**。开发循环里「改了没生效」大概率是这条。
6. **`subprocess` 没有 `run`**，`graceMs`/`capBytes`/`cwd` 全部显式，`argv` 从不经 shell。delta 里所有 shell 风格调用要重写。
7. **未验证**：
   - `ctx.uiConversation` 的 Client 方法签名（页面未连接，inspect 超时）——只有 `references/practices.md` 的文档依据。
   - `Config.field.volatile()` 的原地更新行为（文档有，未实测）。
   - 在第三方包里声明 `dependencies: {'@deepseek-ai/dsh-storage-domain': ...}` 让 pnpm 装第二份官方包是否会导致 cordis/zod 双实例问题。
   - `ctx.logger` 的实际 sink。
   - `hook/invoked`、`hook/result`、`image/offload`、`subagent/*` 的 payload（声明包在桌面安装里找不到）。
8. **desktop profile 不能由 CLI 操作**（`managed exclusively by the Electron application`），`http://127.0.0.1:64350` 的 `/api` 需要认证且 token 位置未定位。→ 所有验证只能走 GUI + `plugin_manager` + `cordis_inspect_query`。
9. **`install_bundle` 跑 pnpm、改 profile `package.json`、可能执行 install script**。第三方插件里做自更新会动用户环境，必须用户显式触发（本会话审批已禁用）。

---

## 9. 复现本文证据的最小命令集

```sh
# 1. 从桌面安装包读已构建 JS / patch / skill 文档（asar 只有 Host 进程自己能读）
ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" -e '
const fs=require("fs");
const p="/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai";
console.log(fs.readdirSync(p).join("\n"))'

# 2. 读完整类型 / README（桌面版裁掉了 .d.ts）
cd /tmp && npm --cache /tmp/npmcache pack @deepseek-ai/dsh-session@0.2.2-rc.1
tar -xzf deepseek-ai-dsh-session-0.2.2-rc.1.tgz -C /tmp/dsh-session
sed -n '255,445p' /tmp/dsh-session/package/lib/types/types.d.ts     # SessionEventMap

# 3. 运行时权威签名
#    cordis_inspect_query({platform:'host', provider:'Service', method:'listService', input:{service:'commands'}})
#    cordis_inspect_query({platform:'host', provider:'Event',   method:'listEvents',  input:{event:'session/event'}})

# 4. 已装第三方 bundle 当模板
ls ~/.dsh/profiles/desktop/node_modules/dsh-guizang-design/
cat ~/.dsh/profiles/desktop/node_modules/dsh-guizang-design/{package.json,cordis.patch.yml}

# 5. skill 文档原文（含模板）
ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" -e '
const fs=require("fs");
const s="/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development";
console.log(fs.readFileSync(s+"/references/host-plugin.md","utf8"))'
```

## 10. 相关文件索引（证据路径汇总）

> 下表里 `@deepseek-ai/...` 开头的路径有两种位置：
> **已构建 JS / patch / skill 文档**在 `app.asar` 内，前缀是
> `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/`（Shell 读不了，必须用 `ELECTRON_RUN_AS_NODE=1` 那条命令）；
> **`.d.ts` / `README.md`** 桌面版被裁掉，要用 §9 的 `npm pack` 从同版本 npm 包取，前缀是解包后的 `<pkg>/`。

| 主题 | 路径 |
|---|---|
| 打包 / 清单 / 安装 / Config | `@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/host-plugin.md` |
| 扩展点选择 / 稳定性 / 性能 | 同目录 `references/practices.md` |
| Web UI / Client 模块 | 同目录 `references/ui-plugin.md` |
| 验证规矩 | 同目录 `references/verification.md` |
| 用户动作 ↔ 工具 | 同目录 `references/user-actions.md` |
| 可抄模板 | 同目录 `templates/decoration/*`、`templates/mcp/*` |
| Loader patch 方言 + 可安装包清单 | `skills/cordis-composition-reference/SKILL.md`、`references/packages.md` |
| Agent preset 组合 | `skills/editing-cordis-compositions/SKILL.md` |
| SessionEventMap | `@deepseek-ai/dsh-session@0.2.2-rc.1` → `lib/types/types.d.ts:261-441` |
| 全部事件类型名 | 同上 → `lib/types/known-event-types.js` |
| Agent / 事件 / PreStepDecision | `@deepseek-ai/dsh-agent@0.2.2-rc.1` → `lib/types/index.d.ts`、`lib/types/runtime-types.d.ts` |
| tools 事件 + 契约 | `@deepseek-ai/dsh-tools@0.2.2-rc.1` → `lib/types/events.d.ts`、`lib/types/contracts.d.ts` |
| commands | `@deepseek-ai/dsh-commands@0.2.2-rc.1` → `lib/types/index.d.ts`、`lib/types/types.d.ts` |
| subprocess | `@deepseek-ai/dsh-subprocess@0.2.2-rc.1` → `lib/types/types.d.ts` |
| fs | `@deepseek-ai/dsh-fs@0.2.2-rc.1` → `lib/types/types.d.ts` |
| storage domain | `@deepseek-ai/dsh-storage-domain@0.2.2-rc.1` → `lib/types/spec.d.ts`、`lib/types/domain.d.ts` |
| session projections + wire.view | `@deepseek-ai/dsh-session-projection@0.2.2-rc.1` → `lib/types/index.d.ts`；范例 `@deepseek-ai/dsh-session-title` → `titleProjectionDefinition` |
| user questions | `@deepseek-ai/dsh-user-questions@0.2.2-rc.1` → `lib/types/types.d.ts` |
| action cards | `@deepseek-ai/dsh-action-cards@0.2.2-rc.1` → `lib/types/index.d.ts` |
| plugin manager | `@deepseek-ai/dsh-plugin-manager@0.2.2-rc.1` → `lib/types/index.d.ts`、`lib/types/types.d.ts` |
| config editor | `@deepseek-ai/dsh-config-editor@0.2.2-rc.1` → `lib/types/index.d.ts` |
| working directory | `@deepseek-ai/dsh-working-directory@0.2.2-rc.1` → `lib/types/index.d.ts` |
| 实战第三方 bundle | `~/.dsh/profiles/desktop/node_modules/dsh-guizang-design/{package.json,cordis.patch.yml,lib/*.js}` |
| 已装 profile 的 bundle 列表 | `~/.dsh/profiles/desktop/package.json` → `dsh.profile.bundles` |
| 用户 patch 层 | `~/.dsh/profiles/desktop/cordis.patch.yml`（只读，不要写） |
| delta 自己的 Host 面 | `hooks/core/host.ts`（`Host` 类型即 delta 用到的引擎 API 全集） |
