# Delta for DeepSeek Harness — 功能对等矩阵

> 对象：`delta-dsh/`（DSH 原生 Host 插件 + 引擎 shim）。上游：本仓库 `hooks/`（Delta for Claude Code）。
> 依据：`delta-dsh` 当前源码（`src/`、`scripts/`、`vendor/`、`lib/`）、`research/` 四份调研、本机实测；每条给 `文件:行`。
> 状态只有四种：**Ported**（行为对等）、**Adapted**（语义有差异但对用户目标等价，差异见说明）、**Deferred**（v1 未实现）、**Not applicable**（Claude Code 特有、Harness 无对应，写替代）。
> 说明列里的“代码路径完成”指实现已落地但未做真实账号端到端验证；“未验证”以第 3 节为准。

## 1. 总表

### 1.1 入口与流程

| 功能 | 状态 | delta-dsh 实现 | 差异 / 说明 |
| --- | --- | --- | --- |
| 打包与安装（bundle/client/patch/locale/icon） | Ported | `package.json:28-36`、`cordis.patch.yml:5-7`、`lib/index.js`、`lib/client.js` | 第三方 bundle 三件套；本机 profile 里为指向仓库的 symlink（第 3 节） |
| `/delta`、`-share`、`-join`、`-setup`、`-update`、`-plugin-update`、`-org` 注册 | Ported | `src/index.js:81-91` → `src/bridge.js:461-469`、`409-458`；用例 `test/smoke.test.mjs:144-150` | 命令名/描述/参数提示来自 vendored `setup/commands.ts`（文案仍称 Claude Code，见 §2.1） |
| 裸 `/delta` 菜单、`/delta <action>` 形态 | Ported | `src/bridge.js:471-490`（`command.run` dispatch，origin=plugin）→ vendored `setup/delta-menu.ts` | 会话内 7 条命令均由 `agent/created` 逐 agent 注册（`bridge.js:460-469`） |
| `/delta-share`（受众问题） | Ported | vendored `sharing/share.ts`、`share-audience.ts` 未改；问题经 `bridge.js:656-670`、`736-758` 映射到 `ctx.userQuestions` | 代码路径完成；未 E2E |
| `/delta-join`（mount/校验/重试/进入目录） | Ported | vendored `sharing/join.ts`，仅两处过渡补丁 `scripts/patches.mjs:11-45` | 见下两行；mount、verifyCheckout、重试与失败文案全保留 |
| join 的会话切换（Claude 的 `/clear` + 新会话） | Adapted | `scripts/patches.mjs:15-44`；`cd` → `ctx.workingDirectory.set`（`bridge.js:471-476`）；`sessionRoot` 返回 live cwd 以过 root 校验（`bridge.js:201-209`） | 原地加入：同一 Session 保留身份与对话，只切目录；不做 `/clear`、不新建会话 |
| Claude Code Desktop hand-off | Not applicable | vendored `sharing/handoff.ts` 保留但走不到；`sessionSurfaces()` 固定 `['terminal']`（`bridge.js:234-238`） | DSH 单一 Web UI、无 `claude://` 深链；替代 = 上一条的原地 join |
| `/delta-setup` 向导（团队→模式→是否同步本会话） | Ported | vendored `setup/setup.ts` 未改；`$.ui.ask`→DSH 提问、`fs.write`→本地文件（`bridge.js:567-572`、`656-670`） | 代码路径完成；未 E2E。Delta 文案里的“Type something”指 Claude 对话行，DSH 是否自动提供自由输入未验证 |
| 每仓库一次 setup 邀约 | Ported | vendored `setup/setup.ts:541-558`；标记落插件 store（`src/store.js:27-28`、`src/paths.js:16-24`） | 代码路径完成；未 E2E |
| 自动同步（读 `.delta/settings.json` → thread create/attach/mount） | Ported | `src/index.js:88-91` dispatch `session.start` → vendored `setup/activation.ts:488-528`、`575-689`；CLI 走 `subprocess`（`src/process.js:53-72`） | 代码路径完成；真实账号/契约未 E2E |
| 未同步提醒、band 上的 `/delta-share` `/delta-setup` | Ported | vendored `band/band.tsx:158-174`；本机实测 band 返回 “○ Delta · Not set up /delta-setup”，随后同一会话返回 “● Delta · Syncing + 真实 thread 链接 + Synced with Zed VIP” | 插件启用时已在运行的 root Session 也会补发 `session.start`（`src/index.js:186-192`）；多个并发 root Session 时 Delta 的单活动会话状态会影响谁有 band（见 §4.6） |
| Delta CLI 发现/首次安装/登录与 beta 条款 | Ported | vendored `cli/cli.ts`、`cli/auth.ts`；进程→`subprocess`（`src/bridge.js:597-603`），浏览器打开与 sleep 走 shim（`bridge.js:327-356`） | 代码路径完成；未 E2E |
| `/delta-org list\|current\|switch\|invite\|manage` | Ported | vendored `setup/commands.ts:114-124` → `cli/delta-cli.ts:184-202` | 直通 CLI 人类可读输出；未 E2E |
| `/delta-update`（启动检查 + 显式更新 + band 进度） | Ported | vendored `cli/install-update.ts` 未改；进度经 `ui.status`/invalidate 到 band | 代码路径完成；Windows 分支未验证（第 3 节） |
| `/delta-plugin-update` | Adapted | `src/bridge.js:376-395`、`417-420`、`478-481` 拦截为 Harness Plugin Manager 提示；notifications on/off 存 `delta-dsh:plugin-update:notifications`（`bridge.js:378-389`） | DSH 无插件市场 CLI/`/reload-plugins`，改为声明“由 Plugin Manager 安装/更新/重载” |
| share/join 进行中拒绝 prompt（门禁） | Ported | `src/index.js:143-173`（`agent/pre-step` → `prompt.submit`；`drop` → `{kind:'reject'}` + 文案写 band status） | 文案保留；未 E2E |
| 会话结束清理（releaseOnEnd/mounts/band/命令） | Ported | `src/index.js:94-105`（`agent/disposed` → `session.end`，reason 固定 `other`） | 语义等价；join 的 mount 会在 dispose 时释放 |

### 1.2 band 与实时协作

| 功能 | 状态 | delta-dsh 实现 | 差异 / 说明 |
| --- | --- | --- | --- |
| band 数据来源：Delta 自己的 hooks 画什么就显示什么 | Ported | `src/bridge.js:274-304` dispatch `ui.render{AbovePrompt}`；`src/surfaces.js:12-109` 序列化；`src/client.js:107-164` 渲染 | 实现方实测 `/delta-dsh-api/status` 返回真实 Delta 绘制；本机复测到路由 200 |
| 元素与样式（Box/Text/Button/Link） | Adapted | `src/surfaces.js:37-109`；`src/client.js:24-63`（CSS 用 DSH 主题 token） | 仅这 4 类；无终端底色/边框阴影/焦点/hotkey；`Link` 为 `<a target=_blank>` |
| Markdown 元素 | Adapted | `src/surfaces.js:85-88` 把 Markdown 降级为 Text | band 内目前无 Markdown 需求；远程消息渲染属 Deferred |
| 布局参数（列/行/问卷让位/isWorking） | Adapted | `src/bridge.js:41-45`、`287-298`：固定 `bandColumns=120`、`bandRows=10`、`hasSurvey:false` | 不用真实视口；窄屏靠 client CSS wrap，Delta 的 give-way 仍按 120 列算 |
| band 按钮（copy/share/Fork&Discard/plugin-update 行） | Ported | 按钮在 Host 侧保留闭包（`src/surfaces.js:89-96`），client 渲染 + press（`client.js:125-136`、`202-212`），HTTP（`src/http.js:53-59`），stale generation 拒绝（`surfaces.js:147-154`） | 代码路径完成；按钮真实点击未验证 |
| band 内 plugin 更新通知行 | Deferred | vendored `band/plugin-update.tsx` 仍在；但其通知来自 Claude marketplace 检查 | DSH 无对应 target，通常不出现；未验证 |
| `ui.status(text)`（失败/暂停文案） | Adapted | `src/bridge.js:710-714` → `SurfaceHub.status`（`src/surfaces.js:196-205`）→ client 底部状态行（`client.js:161`） | 覆盖式单行，不进入会话流 |
| `ui.log({to:'transcript'})`（向导结果、share 失败等长文案） | Adapted | `src/bridge.js:699-708`：写 band status（截 2000 字符），debug 写 `ctx.logger` | DSH Host 无 transcript/通知 API；文案只做“最近一条”展示，不持久 |
| `ui.invalidate` 重绘节流 | Ported | `src/bridge.js:306-319`：50ms 合并、仅订阅者存在时重画 | 替代 Claude 的 `ui.render` 节流 |
| watch：连接/重连/退避/followUpload/link/audience | Ported | vendored `watch/watch.ts` 未改；`thread watch` 流走 `spawn`（`src/process.js:78-140`） | 代码路径完成；真实线程未 E2E |
| presence、远端 agent 活动、children 列表 | Ported | vendored `watch/presence.ts`、`band/status.ts`；band 渲染同上 | 依赖 watch 已 live；未 E2E |
| 远程行注入对话（给模型看） | Deferred | `src/bridge.js:266-269` `sessionAppend` 返回 deny | DSH Session 日志不可由插件追加/改写（`research/recording-port.md` §5 D1） |
| `/delta show` 自绘行（给人看） | Deferred | vendored `watch/rows.tsx` 保留，但 `src/` 从不 dispatch `ui.render` 的 `UserMessage`/`CommandOutput`（唯一的 `ui.render` 在 `bridge.js:287-298`，组件固定 `AbovePrompt`） | DSH 无“命令输出行重绘”机制；退化为 band status 文案 |
| Delta 线程当 Claude 子代理（`session.send`/SendMessage） | Deferred | `register.tsx` 的 `session.send` hook 在 vendored 中保留，但 `src/` 从不 dispatch（`src/index.js` 仅 dispatch：session.start/end、prompt.submit、turn.*、tool.call、command.run、session.append、ui.render） | DSH 有 `agentTeams`/`subagents`，但 v1 未接这条语义 |
| 录 Claude 原生子代理为 Delta 子线程 | Deferred | `src/index.js:33-35`、`83`、`96-98`、`109`、`119`、`146` 只处理 root Session（`header.parentSession === undefined`） | 子 Session 事件被整体跳过；README“Known limits (v1)”同述 |
| 标题录制 | Adapted | `src/rows.js:263-286` 把 `session/title` 追加成 Claude 形状的合成 transcript（`src/paths.js:37-38`），供 vendored `recording/title.ts` 读取 | 机制不同、结果等价；合成文件在 `$DSH_HOME/delta-dsh/claude/projects/` |
| 快照导出与续接（continued-in） | Adapted | `sessionMessages`→`session.deriveMessages()`（`src/bridge.js:241-260`）；`rows.js` 投影行；vendored continuation 检测保留 | DSH 会话不会被 Claude 式“续接到新会话”；该分支通常不触发，未验证 |
| 行投影（替代 `session.append` 拦截） | Adapted | `src/rows.js:205-270`：`turn/start`、`user/message`、`assistant/message`、`tool/result`、`turn/end`、`session/title` → Delta 事件；door 映射 `rows.js:70-95` | DSH `session/event` 是 post-commit、不可改写；投影只处理 append 语义 |

### 1.3 更新、平台与身份

| 功能 | 状态 | delta-dsh 实现 | 差异 / 说明 |
| --- | --- | --- | --- |
| Delta app/CLI 启动更新检查 | Ported | vendored `plugin-update`/`install-update` 走 `session.start`（`src/index.js:88-91`） | 代码路径完成；未 E2E |
| 插件自更新检查（启动+每小时） | Adapted | vendored `plugin-update/updates.ts` 仍在跑；命令层被拦截（`bridge.js:376-395`） | target 识别依赖 `claude plugin list/marketplace list`，DSH 上通常 undefined → 不提示；若机器恰有匹配的 Claude 安装可能误报（未验证） |
| 插件 reload（`/reload-plugins --force`） | Not applicable | `src/bridge.js:477` 返回空 | DSH 由 Plugin Manager 重载；替代 = 重启 Host / 新 Session（client 模块需重启加载） |
| Windows 首次安装与更新编排 | Deferred | vendored `cli/cli.ts`、`cli/windows-install.ts` 保留 | 本机 macOS，未验证（README“Known limits”同述） |
| 遥测/协议身份 | Adapted | 仍 `DELTA_CLI_INTEGRATION=claude_code`（`vendor/delta/cli/delta-cli.ts:35`）、`PRODUCER_NAME='Claude Code'`（`vendor/delta/cli/thread-commands.ts:414`）、`thread create --source claude-code` | 必须保留才能过 Delta 契约；副作用：Delta 端显示为 “Claude Code” |
| 隐私与本地数据目录 | Ported | outbox/store/合成 transcript 全在 `$DSH_HOME/delta-dsh/`（`src/paths.js:16-38`、`src/store.js:27-28`） | 不读写 Claude 配置目录；`CLAUDE_CONFIG_DIR` 由 shim 指向插件自有目录（`bridge.js:512-513`） |
| 非必要流量开关 | Adapted | `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` → `DSH_DISABLE_NONESSENTIAL_TRAFFIC`（`src/bridge.js:516-517`） | 变量名适配，语义一致 |
| `ui.copy` | Adapted | `src/bridge.js:672-697` 用 `pbcopy`/`clip.exe`/`wl-copy`/`xclip` 子进程 | DSH Host 无剪贴板 API；未验证 |
| 主题配置（`config.set{theme}`） | Not applicable | `src/bridge.js:492-502` 固定 `dark`；`config.set` 从不 dispatch | band 走 desktop 布局（`bridge.js:290`），无终端底色需求；颜色由 client CSS token 决定 |
| 提问选项 hint（Delta 用 `AskUserQuestion` 渲染钩子补 description） | Not applicable | `src/bridge.js:736-758` 把 `descriptions` 直接映射为 DSH option `description` | DSH 原生支持，不需要 Claude 的渲染钩子 hack |
| DSH 工具名/参数映射 | Ported | `src/bridge.js:22-66`（如 `bash→Bash`、`apply_patch→Edit`、`read.path→file_path`） | 让 Delta 工具行标题保持 Claude 名称与字段 |

## 2. DSH 适配差异汇总

0b. **band 文案本地化（DSH 特有的增量）**：band 的所有文案由 Delta hooks 以英文生成；client 按 Harness locale 翻译提示性内容（状态词、按钮、进度步骤、受众、更新行、host status 前缀），保留专有名词：Delta、DeltaDB、团队名、人名、URL、`/delta` 命令（`src/band-i18n.js`，build 时内联进 `lib/client.js`；测试 `test/band-i18n.test.mjs`）。`zh` 以外 locale 保持 Delta 原文。
0. **按会话甄别（DSH 特有，上游没有）**：Claude 版一进程一会话，因此每个会话都有 band；DSH 一 Host 多会话，因此做了三层甄别：① **跟随视图**——Delta 一次只激活一个 Session，client 打开会话时 `POST /delta-dsh-api/focus`，Host 把 activation/watch/录制移到该 Session（`src/bridge.js` 的 `focus`/`focusBand`、`src/http.js` /focus、`src/client.js` 挂载时上报），其他已打开会话只有 `/delta` 命令菜单、无 band、不录制；② **只服务用户可见的 root 会话**（排除 Team teammate 与 subagent child，`src/visibility.js`，`src/index.js` 各监听器同样跳过）；③ **Delta 有内容可说才显示 band**（thread/join/上传中/操作进行中/watch 失败/仓库已有 `.delta/settings.json`），未 setup 的仓库保持安静。测试见 `test/visibility.test.mjs`。

1. **协议身份保留 claude-code**：`--source claude-code`、producer `Claude Code`、`DELTA_CLI_INTEGRATION=claude_code` 均未改（`vendor/delta/cli/delta-cli.ts:35`、`thread-commands.ts:414`），否则 Delta 契约/遥测拒收；代价是线程里不显示 DeepSeek Harness。
2. **没有 `session.append` 的可改写入入口**：`session/event` 是 post-commit、不可改写、不能新增事件类型；行来自 `src/rows.js` 的投影，因此 `/delta show` 自绘行、给模型的远程行注入都不可能，v1 去掉。
3. **没有 `ui.status` / transcript 行**：`ui.status`/`ui.log(to:'transcript')` 落到 band 的单行 status（`bridge.js:699-714`、`client.js:161`），覆盖式、不持久、不写入会话记录。
4. **第三方插件没有 Remote 方法**：Client↔Host 改走同源 HTTP（`src/http.js:1-90`：`GET /delta-dsh-api/status`、`POST /delta-dsh-api/band/press`），loopback + Origin 校验，press 带 generation 防陈旧；client 以 700ms 轮询 `/status`（Harness web server 在 prefix handler 返回时结束响应，SSE 无法保持连接）。
5. **join 原地切换目录**：`scripts/patches.mjs:11-45` 只改两处过渡；`cd` 映射 `ctx.workingDirectory.set`（`bridge.js:471-476`）；无 `/clear`、无新会话、无 Desktop hand-off。
6. **不新增 SessionEvent 类型**：Delta 自有状态放插件 store（`$DSH_HOME/delta-dsh/store/<percent-encoded-key>.json`，`src/store.js`），不写 Session 日志。
7. **Client 需重启 Host 才加载**：Host 半装好即生效（命令/录制/API），但 `lib/client.js` 由模块系统在启动时装载；已运行的 Host 需重启后 band 才出现（README“Known limits”）。
8. **UI 能力缩水**：`ui.render` 只实现 `AbovePrompt`；`UserMessage`/`CommandOutput`/`AskUserQuestion`/`config.set`/`session.attach`/`session.send` 从不 dispatch，对应 vendored hook 为死代码。
9. **交互映射**：Delta 的一问一答 → DSH `userQuestions.ask`（header/description/multiSelect/custom）；`ui.ask` 返回值取 `custom` 优先、否则 `selected.join(', ')`（`bridge.js:656-670`）。
10. **进程/文件/HTTP 走宿主**：`subprocess` 只有 `spawn`，`run` 由 collected 模式封装（`src/process.js:53-72`）；插件私有文件用 `node:fs`（`bridge.js:523-572`）；`fetch` 30s 超时（`bridge.js:574-595`）。
11. **工具事件字段改名**：DSH `tools/execute` → `tool.call`（`index.js:117-139`），工具名/参数经 `TOOL_NAMES`/`TOOL_ARGS` 还原成 Delta 期望的 Claude 形状。
12. **无 `agent.abort`**：`turn.abort` → `agent.cancel({kind:'user'})`（`bridge.js:652-654`）。

## 3. 验证状态

### 已实测（本机，2026-11-10）
- 单元/集成测试：`node --test test/*.test.mjs` → **44 passed / 0 failed / 0 skipped**（engine 9、rows 6、surfaces 6、process 4、process-cli 2、visibility 5、band-i18n 9、smoke 2、integration 1）。integration 用真实 git checkout；process-cli 用真实 `delta` CLI。
- 安装：`plugin_manager install_bundle` → `application: applied`，`~/.dsh/profiles/desktop/node_modules/delta-dsh` 指向本仓库；禁用/启用可反复加载（路由与命令在进程内不冲突）。
- band 数据链路：`GET /delta-dsh-api/status?session=<live>` → 200，真实返回 Delta 的绘制树：先是 “○ Delta · Not set up /delta-setup”，setup 完成后同一会话返回 “● Delta · Syncing”、真实 `https://delta.dev/join/thread_…` 链接、`Synced with Zed VIP`，以及 copy link / Share 按钮（按钮闭包含 generation/actionId）。
- 真实 Delta 账号：插件在本机 desktop profile 运行、`/delta-setup` 向导经 DSH 提问完成并把 `{"threads":{"mode":"private","organization":"…"}}` 写入仓库 `.delta/settings.json`；Delta CLI 自动创建 thread 并在 `$DSH_HOME/delta-dsh/claude/delta-plugin/outbox/<session>` 持续暂存记录（实测 869 个记录文件）；`delta --json thread show <thread>` 能读到本会话 prompt 原文。即：自动同步、录制、CLI 集成、setup 向导在本机真实链路跑通。
- 兼容：`delta --json thread contract` = min 8/max 9，插件按 max 8 协商；`delta auth status`/`org list` 经 shim 解析正常。
- 按会话甄别：`POST /delta-dsh-api/focus`（当前 Lead 会话）→ 200，随后 `GET /status` 返回真实 band 绘制；另外 3 个未聚焦 root 会话 `GET /status` 均 `tree:null`（隐藏）。

### 未验证
- GUI 中 band 的实际渲染与按钮点击（`lib/client.js` 由 Harness Client 模块系统在 Host 启动时装载，本次运行的 Host 早于安装，未重启；未在页面复测）。
- 多 Session 跟随：已实现“跟随当前视图”的方式（focus 后 activation/watch/band 移到该 Session，其余隐藏），本机实测聚焦会话出 band、未聚焦隐藏；但 Delta 一次只激活一个 Session，切走期间该会话暂停录制，这是上游单活动会话设计的直接结果。
- share 受众选择与 publish/invite、join（mount/cd/重连）、watch/presence 的人机交互部分；Windows；`ui.copy` 剪贴板；Fork & Restore/Discard；插件更新通知行；提问卡片的自由输入。

### 未验证
- GUI 中 band 的实际渲染与按钮点击（client 模块需重启 Host 后加载，本次未重启/未在页面复测）。
- 真实 Delta 账号端到端：share（受众/快照/publish/invite）、join（mount/cd/重连）、setup 向导、自动同步、org、watch/presence。
- Windows 安装/更新；`ui.copy` 剪贴板；`Fork & Restore`/`Discard`；plugin 更新通知行。
- DSH 问题卡片是否提供自由输入（setup 的团队名/邮箱、join link 依赖它）。
- vendor 启动的插件自更新检查在 DSH 上的实际行为（可能误命中 Claude marketplace 安装）。

## 4. 风险与后续

1. **join 原地加入的语义代价**：`completeJoin` 以 `pending:[]` 保存新 binding（`vendor/delta/sharing/join.ts:234-239`）；本 Session 之前为本地线程暂存的记录不会带入所加入的线程（Claude 版用新会话回避了这一点）。已在 README“Known limits”声明；如需保留旧记录，应在 join 前先 share 完旧线程。
2. **插件自更新的 vendored 启动检查**：命令层已拦截为 Plugin Manager 提示；shim 的 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` 默认返回 `'1'`（`src/bridge.js`），因此 Claude marketplace 检查默认不跑；设 `DSH_DELTA_PLUGIN_UPDATE_CHECKS=1` 才放开。
3. **用户可见文案仍是 Claude Code**：菜单/向导文案来自未改的 vendored 代码（`vendor/delta/setup/commands.ts:41-50`、`setup/setup.ts`）；产品上需决定是否改写。
4. **README 与代码一致性**：README 已补 `/delta-plugin-update notifications on|off`。
5. **构建产物**：`lib/` 为 esbuild 产物；改 `src/` 或重新 `sync-delta` 后必须重跑 `node scripts/build.mjs`。
6. **多 Session 采用“跟随视图”而非并行录制**：Delta 的 activation/watch/band 是模块级单例（上游按“一进程一 Claude 会话”设计）。本端口让 client 打开会话时 focus 该 Session（`POST /delta-dsh-api/focus`），Host 迁移 activation/watch；未聚焦会话不录制、无 band（仅保留命令菜单）。若需要后台会话持续录制，需要重构上游单例状态，v1 不做。
