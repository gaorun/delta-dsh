# Delta for DeepSeek Harness

[Delta](https://delta.dev) 为每个 agent 线程分配一个 URL。本插件把 DeepSeek
Harness 的会话（Session）及其检出（checkout）记录到 Delta。记录后，队友可以打开
线程、加入线程，并查看进展。队友可以从自己的 Harness 会话加入，也可以从
[delta.dev](https://delta.dev) 或 Delta 应用加入。

本插件是 [Delta for Claude Code](../README.md) 的功能移植版本。移植版用同一个
Delta hooks 模块驱动。中间的小型引擎适配层（shim）实现这些 hooks 用到的 Claude
Code mod API 部分。`docs/parity.md` 列出每项功能，并说明移植版在哪些地方行为相同、
不同或尚未移植。

## 安装

1. 打开 Harness 的「Settings → Plugins」。
2. 选择从本地文件夹安装 bundle。
3. 选择本 `delta-dsh/` 目录。

也可以用插件管理器的 `install_bundle` 安装，参数为同一绝对路径。

安装过程会链接检出目录，因此插件无需构建即可运行。`lib/` 存放两部分已构建的产物。
安装后，在插件管理器的插件列表中确认「Delta」已启用。`/delta` 命令会出现在会话的
输入框菜单中。状态带（band）由 Host 部分立即提供，浏览器部分在 Harness Host 启动时
加载。因此安装后重启一次 Harness 应用，状态带才会显示在输入框上方。

插件使用 `delta` CLI。如果未安装 CLI，第一次执行 share、join 或 setup 时，插件会
提示安装，行为与 Claude Code 插件相同。

## 命令

| 命令 | 说明 |
| --- | --- |
| `/delta` | 下方命令的菜单 |
| `/delta-share [<email>…]` | 同步本会话及其检出，并选择可见范围 |
| `/delta-join <link>` | 在本会话中、在线程的检出目录中，加入共享线程 |
| `/delta-setup` | 选择本仓库的团队，以及哪些会话同步 |
| `/delta-update` | 更新已安装的 Delta 应用和 CLI |
| `/delta-plugin-update [check \| notifications on\|off]` | 报告本插件的安装情况，以及 Harness 更新本插件的方式 |
| `/delta-stop` | 停止共享和同步本会话（移植版新增；Delta 没有此命令） |
| `/delta-org list\|current\|switch <ID>\|invite <email>…\|manage` | 管理 Delta 团队 |

每个命令也可以写成 `/delta <command>`，例如 `/delta share`。setup 写入
`.delta/settings.json`，并把该文件排除在 Git 之外。

## Delta 何时连接

打开会话不会连接 Delta。执行下面任一命令后，Delta 才开始工作：

- `/delta-setup`
- `/delta-share`
- `/delta-join`

在这之前，插件保持空闲。它只在上面的命令之后开始记录和连接。`/delta` 命令菜单
始终存在。

`/delta-stop` 停止已连接的会话。如果本账号拥有该会话自己的线程，该线程变为私有。
插件同时停止线程监视（thread watch），忘记绑定，并隐藏状态带。已在本地暂存的记录
保留在 outbox 中，但不会上传。再次执行 `/delta-share` 可以恢复共享。

因此，仓库的 `.delta/settings.json` 中设置的自动同步模式，不会让新会话自行同步。
移植版仍从该文件读取团队和默认受众。每次同步或共享都从一条明确的 Delta 命令开始。

对话框文案跟随 Harness 的语言设置。初始化向导、共享受众和登录问答都会翻译，界面为
中文时显示中文。答案会映射回 Delta 自己的标签，专有名词、团队名称和命令保持不变。

## 哪些会话是 Delta 会话

Claude Code 插件为每个会话运行一个进程，因此它看到的每个会话都有 Delta 状态带。
一个 Harness Host 在一个进程中运行全部根会话，因此移植版区分处理：

1. **哪些会话由 Delta 服务。** 每个面向用户的会话都有 `/delta` 命令菜单。Delta
   只在两种情况下记录并连接。第一种是执行 Delta 命令。第二种是用户此前已共享或已
   加入该会话。团队队友和子代理（subagent）子会话不在服务范围内。这些会话没有
   Delta 启动过程、没有提问、没有状态带。
2. **状态带何时显示。** 只在三种情况显示。第一种是用户在本次 profile 中用
   `/delta-share` 或 `/delta-join` 连接过该会话。第二种是其中一条命令正在执行。
   第三种是该连接失败，需要处理。这个选择与会话一起保存，重启后仍然有效。从旧版
   自动同步行为继承的绑定不算。从未连接过的会话，或只有本地捕获的会话，不显示状态
   带。这类会话没有「未设置」提醒和「未同步」提示。`/delta-setup` 和
   `/delta-share` 始终在输入框菜单中，直接可选。

## 状态带

状态带隐藏没有可操作细节的失败行，即 Delta 的通用建议「Not syncing: Fix the
cause」。如果失败原因具体，或者带有链接、人员、按钮，状态带仍然绘制该行。

状态带文案跟随 Harness 的语言。界面为中文时，提示文字会翻译，包括状态标签、按钮、
进度步骤、受众和更新行。专有名词保持原样：Delta、DeltaDB、团队名称、人员姓名、
链接和 `/delta` 命令。其他语言环境显示 Delta 的原始英文。翻译位于
`src/band-i18n.js`，构建时内联到浏览器 bundle。

Delta 在输入框上方绘制状态带，内容包括线程链接与受众、同步进度与失败、插件版本通知
和按钮。Host 部分用 Delta 自己的 hooks 绘制状态带。浏览器部分渲染生成的元素树，并
通过同源、仅限回环地址的 API 回传按钮点击。点击会带上它看到的绘制代数（generation），
因此过期按钮会被拒绝，不会作用到错误的状态上。

## 隐私

Delta 保存已记录会话的内容，包括对话、工具输入与输出、模型推理。它同时保存检出中的
文件：暂存文件、未暂存文件，以及未被忽略的未跟踪文件。

在用户共享或加入会话之前，或者仓库设置自动同步之前，插件不上传任何内容。

插件以 `claude_code` 集成标识运行 Delta CLI，因此 Delta 的生产者协议（producer
protocol）和遥测继续接受这些记录。CLI 的生产者名称把这些记录标注为
**DeepSeek Harness**。

## 开发

Host 部分是纯 JavaScript bundle，运行时不依赖 `@deepseek-ai/*` 包。它用到的内容全部
由插件上下文传入。浏览器部分由 Harness Client 模块系统加载。

```sh
cd delta-dsh
npm install            # esbuild, for the build only (registry: see .npmrc)
node scripts/sync-delta.mjs   # copy ../hooks -> vendor/delta and re-apply the documented patches
node scripts/build.mjs        # src/ + vendor/ -> lib/index.js, src/client.js -> lib/client.js
node --test test/*.test.mjs   # engine, rows, surfaces, process and a fake-context smoke test
```

`vendor/delta/` 是本仓库 `hooks/` 的副本。`scripts/patches.mjs` 记录并应用仅有的
两处修改，即原地加入转换（in-place join transition）。禁止手动编辑 `vendor/delta/`：
同步会覆盖该目录。

Host 测试使用伪造的 Harness 上下文，因此不会安装、启动进程，也不会访问网络。冒烟
测试加载 `lib/index.js`，所以先运行 build。

## 故障排查

- **Harness 应用重启后状态带消失。** Delta 跟随页面显示的会话，而页面可能在该会话的
  agent 注册之前挂载。状态带为空时，浏览器每隔几秒重新询问。Host 也会重试 Delta 未
  接受的启动，因此状态带会自行恢复。如果页面在插件更新之前已加载，刷新一次页面，
  即可加载当前的浏览器部分。
- **诊断空状态带。** 向 Host 查询某个会话的绘制状态：
  `GET /delta-dsh-api/status?session=<id>`。`tree` 表示状态带绘制的内容。返回 `null`
  并带 `debug` 对象时，`debug` 说明原因（`unfocused`、`hidden`、`no-session`）和
  Delta 的激活情况。

## 已知限制（v1）

- 浏览器部分从已安装的包注册。安装插件时已在运行的 Harness Host 必须重启，状态带的
  界面才会出现。Host 部分（命令、记录、API）立即生效。
- Harness 会话日志在提交后写入，无法重写，因此记录行由持久事件推导，而不拦截写入。
  远程监视行目前不注入对话，Delta 线程回复也无法在本会话日志内回答。
- 只记录主对话。子代理会话、Claude Code Desktop 交接流程和 Delta 的 `/delta show`
  回显行尚未移植。
- 原地加入线程时，本会话的绑定转换为被加入的线程；Claude Code 会在那里启动新会话。
  本会话此前在本地暂存的记录留在原处，不转入被加入的线程。
- Delta 的 hooks 按每个进程一个会话编写。Harness 在一个 Host 进程中保留全部打开的
  会话，因此移植版跟随用户正在查看的会话。切换对话会移动 Delta 的激活状态和线程监视。
  不在屏幕上的会话不记录，其暂存记录保留在本地。共享和加入操作在发起它们的会话中运行。
- Delta 的插件自更新路径改为适配 Harness 插件管理器。`/delta-update` 仍通过 Delta
  自己的代码更新 Delta 应用和 CLI。
- Windows 专用的安装和更新编排保留 Delta 的代码，但未在本环境测试。

## 软件源

`.npmrc` 把本包固定到官方 npm 源（`https://registry.npmjs.org/`），
`package-lock.json` 从该源解析。构建依赖只有 esbuild。

## 许可证

Copyright (C) 2026 Zed Industries。

本项目按 GNU Affero 通用公共许可证第 3 版授权，仅此版本（`AGPL-3.0-only`）。详见
[LICENSE](LICENSE) 和 [NOTICE.md](NOTICE.md)。
