# MCPRouter 插件能力契约

> **状态**：跨仓事实契约，版本 `1`（2026-08-05）
> **适用范围**：所有显式声明 `mcpr` 卡槽的 `.cindy` 插件；不按插件来源区分。

本文是 Cindy Desktop、Meka `cindy-protocol` 子仓与 `mcp-router` 仓库之间的共同约束。它只定义能力边界和 wire
形状，不把 MCPRouter 的业务 route 清单复制进 Cindy。Host 代码、插件作者手册和
MCPRouter 服务端实现发生冲突时，必须先修正契约和两边实现，再交付。

协议正本位于 `C:\Workspace\cindy\cindy-protocol` 的
`packages/plugin-protocol`，Meka 使用 `kapt66/cindy-protocol` 的 `meka/main` 分支。
Desktop 的 `apps/desktop/src/shared/mcpr-plugin-capability.ts` 只是历史 import 兼容层，
必须从 `@cindy/plugin-protocol` 转出；不要在 Desktop 或插件仓库复制协议校验器。

## 1. 能力声明

`mcpr` 是独立的能力 slot。存量插件未声明该 slot，升级后保持原行为；声明了 slot 的
插件必须同时声明精确的 `mcpr.routes` 白名单：

```json
{
  "slots": ["tool", "mcpr"],
  "mcpr": {
    "routes": ["mcp.tools.list", "mcp.tools.call", "meka.design.*"]
  }
}
```

校验规则由 `@cindy/plugin-protocol` 的 `validateGhostManifest` 强制，Desktop Host 在
安装和运行期再次校验：route 只允许小写点分标识，最多
32 条、每条最多 128 个字符；末尾 `.*` 才是通配符，且只匹配同一 namespace 下的 route。
不能声明 URL、HTTP method、headers、Cookie、Authorization、client key 或任意
其它 transport 字段。

`status` 与 `configure-login` 是 Host 固定操作，不写入 route 白名单。v1 契约为
`mcp.tools.list` 和 `mcp.tools.call` 预留 MCP 基础 route；实际可调用性仍以 Router registry
是否注册为准。其它业务 route 由 MCPRouter registry 注册，Cindy 不需要随业务扩展更新。

## 2. 调用模型

插件请求只允许携带以下字段：

| 字段 | 要求 |
| --- | --- |
| `route` | 必须命中当前插件 manifest 的 route pattern，并由 Router registry 注册 |
| `input` | JSON 值；Host 按 256 KiB 请求预算限制大小 |
| `scope` | `account`、`current-project` 或 `selected-instance`；route 要求时必填 |
| `callId` | 可选插件侧关联值，不是权限凭证；Host 会另铸 Router `requestId` |

Host 通过真实 `webContents` 反查 `ghostId`，不信任插件自报身份。Host 负责：

- 固定 MCPRouter origin、session cookie 注入和远端认证状态探测；
- manifest route 匹配、请求大小、超时、并发和速率限制；
- account / project / instance scope 绑定与高风险操作确认；
- 错误规范化、响应脱敏、审计关联和取消传播。

MCPRouter 负责 route 是否存在、输入 schema、用户/项目/实例权限、风险分类和业务
dispatch。插件永远不能取得密码、session token、client key 或原始 HTTP 响应头。

## 3. 登录与状态

`status` 返回本地 `configured` 与远端 `remote` 两个维度。`configured` 只表示本地有
配置，不能替代远端 session 有效性；`remote` 为 `authenticated`、`unauthenticated`、
`expired` 或 `unavailable`。

`configure-login` 的目标行为是由 Host 打开宿主通用的 MCPRouter 鉴权窗口。插件只接收
成功、取消或失败，以及最新 `status`；不得自行打开登录 URL、读取 Cookie 或实现第二套
登录页。当前窗口桥尚未接线，调用只返回现有状态，未登录时由插件引导用户进入 Cindy
Meka 设置。

## 4. 错误、兼容与审计

两仓共享 `contractVersion: 1`。错误使用稳定 code：`ROUTE_NOT_DECLARED`、
`ROUTE_NOT_FOUND`、`INVALID_REQUEST`、`INVALID_INPUT`、`SCOPE_REQUIRED`、`FORBIDDEN`、
`AUTH_REQUIRED`、`AUTH_EXPIRED`、`AUTH_UNAVAILABLE`、`RISK_CONFIRMATION_REQUIRED`、
`RATE_LIMITED`、`TIMEOUT`、`INTERNAL`。面向插件的 message 不得包含 token、Cookie、URL
中的敏感查询参数或后端堆栈。

新增 route 只需在 MCPRouter registry 注册并在插件 manifest 中声明；不得修改 Cindy
代码来增加业务 URL。变更字段、错误语义或认证边界时必须提升契约版本，并在两仓同时
记录迁移/兼容策略。`cindy-protocol` 承载插件 manifest 与 Plugin Delivery 的共享形状，
但不承载本地 Desktop→MCPRouter HTTP transport 契约；本能力不接入 Mobile/device-link。

## 5. 实现状态

Desktop 电子脑 preload 已暴露 `cindy.mcpr.status()`、`configureLogin()`、`call()` 与受限的
`local()` 固定操作；
Main 按真实 `webContents` 反查插件身份，并在 `GhostMcprSlot` 中检查启用状态、manifest
route、scope、callId 和 256 KiB JSON 预算，再使用 Host 保存的 Router session 调用
`GET /api/plugin-capabilities/status` 或 `POST /api/plugin-capabilities/call`。插件不接触
Router origin 或任何认证材料。

`GhostMcprSlot` 对失败调用记录固定 route 与稳定错误码；对 `git.preview` 只在响应结构发生
变化时记录一次脱敏形状摘要，包括顶层 key、字段类型、变更数量和尾斜杠路径数量。摘要不记录
文件名、仓库路径、提交值、实例值、URL、凭证或完整响应，避免后台轮询刷屏并保留契约漂移的
定位证据。

`cindy.mcpr.local({ action, instanceId, taskId, programId })` 只对声明服务器运行 route 的插件开放。
固定 action 为 `configure`、`probe-project-config`、`configure-project-config`、`describe`、`prepare`、
`start`、`start-all`、`status`、`stop`、`stop-all` 和 `logs`；插件不能提交其它本机操作。
`configure` 由 Cindy Main 打开目录选择框，
所选配置表绝对路径仅以 `0600` 权限保存在 Cindy 用户数据中，返回插件的只有已配置状态和
目录显示名，不返回绝对路径。

`probe-project-config` / `configure-project-config` 用于 Agent 启动本地服务器时复用当前本地任务的项目
目录。插件只能提交由项目 Skill 明确给出的单层相对子目录名和当前 `toolCallId`；Main 通过在途
callId 账本反查真实插件和任务，拒绝远程任务、绝对路径、空目录、非直接子目录和 realpath 逃逸。
探测只返回安全相对名；采用候选前必须由 Agent 取得用户确认。这两个 action 不是通用文件访问能力，
不增加 slot 或 manifest 权限，已安装插件不需要重新授权。

模板可以在 `runtimeContract.config.steps` 中声明宿主执行的通用配置步骤。当前支持
`mount-config`（把用户选择的配置目录以 junction/symlink 或副本放到运行目录的相对路径）
和 `set-toml`（写入运行目录内 TOML 文件的点分字段）。步骤中的目标必须是运行目录内的
相对路径；宿主拒绝路径逃逸和经过链接写回用户配置目录。`config.adapter` 继续作为可选的
产物内适配器，并在声明式步骤完成后执行。平台不得根据模板、项目或程序名称选择步骤。

本地服务器必须先显式 `prepare` 下载并校验远端产物，之后才能 `start`；启动操作不隐式下载
或切换到新的构建任务。`describe` 会区分模板声明的程序与本机真实已准备状态，并返回下载时
固化的编译时间、HEAD SHA 和提交标题。已校验产物跨插件页面和应用重启保留；应用重启会先
终止持久状态中的残留 PID，并把程序恢复为 `stopped`，不会把旧进程视为仍在运行。Main
Supervisor 负责产物摘要、路径边界、配置适配器、进程树和有限日志；返回值不含本地/远端
路径、PID、命令或凭证。运行契约由模板能力在 Host 内部读取，插件不得自行提交可执行路径
或 shell。

首个已接线业务 route 为 `other-configs.get`（`account` scope / `read` risk），输入只含
`ownerUsername` 与 `name`。Router 复用 `/api/configs/:ownerUsername/:name` 的
private/shared/public 权限查询；无权访问与不存在统一为 `ROUTE_NOT_FOUND`。

`configureLogin()` 已登录时返回 `connected`；未认证或登录过期时会通过 Host 固定事件
聚焦主窗口，并打开共用的 MCPRouter 登录/注册对话框。插件不能提交设置路由或 URL，
也不能通过开放网络请求或自行收集密码绕过该宿主入口。

测试覆盖 manifest 校验、route 匹配、Host 拒绝未声明 route、session-only HTTP 调用、
远端状态映射，以及 Router 对 other-config 可见性和额外 transport 字段的拒绝。

## 6. 跨仓开发清单

新增或调整 `mcpr` 能力时按以下顺序落地：

1. 在 `kapt66/cindy-protocol` 的 `meka/main` 修改 `plugin-protocol` 源码、测试和文档，
   先确认 `origin`、工作区干净，并避免把业务 route 清单写进协议包。
2. 对 manifest 字段或 slot 变化，补充 `manifest.test.ts`；对插件市场详情兼容性，补充
   `delivery.test.ts`。通过子仓 test/typecheck 后提交并推送协议 commit。
3. 在 Cindy 父仓更新 submodule gitlink；Desktop 只保留 Host 行为和必要的兼容转出，
   然后运行 `ghost.mcpr`、插件市场 API 定向测试和 Desktop typecheck。
4. 新 route 只需 MCPRouter registry 注册并由插件 manifest 声明；不要为了业务 route
   修改 `plugin-protocol` 或 Desktop URL。
5. 若日志仍打印不含 `mcpr` 的旧 slot 白名单，优先检查 gitlink 和 `.vite/build` 构建时间，
   再确认实际运行进程已重启。
