# PSB 远程工作区跨仓契约（脱敏摘要）

> **性质**：本文是 PSB 远程工作区跨仓契约的**仓库内稳定引用锚点**。字段级正本仍在 PSB 仓根目录
> `协作需求.md`；本仓不再把不入库的跨仓联调流水当事实源，产品/工程文档统一用本文的章节号或
> `CINDY-RW-xx` 编号引用契约事实。
>
> **脱敏边界**：本文不写本机绝对路径、内部主机名、真实人名 / 邮箱、账号或会话 id，也不复制帧体与
> 凭据。需要逐字节形状时读 PSB 仓 `协作需求.md` 与双方已提交的实现 / 测试。
>
> **维护约定**：PSB 侧形状变化先改 PSB 仓正本并双侧确认，再同批改本文与客户端；本文与代码 / 测试
> 冲突时以代码与测试为准，并修本文。Cindy 侧最终有效行为仍以
> [产品规则](../product-rules/psb-remote-workspace-sessions.md)与
> [工程契约](../dev-rules/psb-remote-session-transport.md)为准，本文只记跨仓确认的事实与适配状态。

## 1. 双方已确认的契约事实

### 1.1 身份、鉴权与端点

- **身份**：`remoteHostId = psb:<PSB sessionId>` 是第三种远端身份，与 `mcpr:`、SSH 并列互不混用；
  id 由 PSB 生成、Cindy 原样保存，`workingDir` 只是展示用的虚拟引用。
- **鉴权**：Cindy 宿主直签 **Connection JWT**，与「Meka 提交 / 项目管理」同一条 OIDC 链路，复用
  audience `<orgSlug>:meka-submit`，**不新增 audience**；仅企业组织成员可签。token 只在 main 内存，
  不落盘、不进渲染层 / IPC / 日志；401 只重签一次，403 `IDENTITY_NOT_LINKED` 不重签。
- **端点**：正式 / 测试部署由启动期环境变量白名单切换（与 Meka 提交插件同一份解析），HTTP、两条
  WebSocket 与网页跳转一起改道；不做 `http` / `ws` 明文降级。HTTP 走系统代理
  （`outboundFetch`），两条 WS 经 `agentForUrl` 注入出站 agent，**隧道与 HTTP 同一份代理语义**。
  需要认证的系统代理仍不支持（明确失败，不静默直连）。
- **HTTP 外壳**：`/api/cindy/remote/**` 精确白名单；成功 `{ data: … }`，失败
  `{ error: { code, message, details? } }`；工作区单行 GET 在 Cindy 身份下恒 403，工作区事实只从
  **列表口**读（单行仅作 403/404/405 兜底并视为「该读口没有答案」）。

### 1.2 隧道（`agent-tunnel`）

- 帧契约与 MCPRouter `agent-tunnel` **逐字节一致**；`mode` ∈ `cc-mgr` / `codex-appserver` / `pi` /
  `exec`，**必须显式写**（PSB 不接受缺省 `cc-mgr`）；`bundleVersion` 只在 `cc-mgr` /
  `codex-appserver` 上携带，值取客户端 pin 常量。
- 关闭码：`4003` 鉴权、`4004` 未就绪（排队期 close reason 是整段 JSON，含
  `cause=ATTACH_TIMEOUT|BUFFER_OVERFLOW|SESSION_STOPPED|CLIENT_OFFLINE` 等）；握手 401/403 鉴权、
  404 不可见、409 未就绪/占用/离线、429 限流。
- **就绪帧**：PSB 0.1.159+ 支持文本帧 `{"type":"agent-tunnel.ready",…}`（**opt-in**：客户端必须在
  隧道 URL 显式带 `readyFrame=1`，默认不发；恰一条且在业务字节之前）。Cindy 的
  `buildPsbTunnelUrl` **固定带 `readyFrame=1`**；等待它有超时（exec 1.2s、其它 5s），等不到按旧
  行为继续；文本帧一律不进业务字节流。
- **cwd 归属**：远端进程的工作目录由 PSB 按工作区 / 会话记录决定，Cindy **不得下发虚拟路径**
  （`psb:` 的 cc-mgr `cwd='.'`、pi 不写 `cd`、codex 传 `.`）；`stream/status` 不暴露
  `workspacePath`（避免第二种事实源）。
- **凭据零接触**：模型凭据只走隧道内既有 Harness 的应用层 RPC（cc `query/start.env`、pi
  `ensure.env`、codex bridge 首行 `env`），PSB 不落库、不写日志 / 缓存，也不新增凭据 DTO。

### 1.3 工作区、占用与会话

- **工作区与占用归 PSB**：协作锁是「人 vs 人」的独占，无自动过期（本轮无 TTL）；写操作（建会话 /
  启动串流 / 发送消息）要求「工作区由自己占用」，由服务端做最终判定。
- **会话记录懒创建**：Cindy 选中工作区即占用，但 PSB 会话记录在**首条消息发送时**才创建（此时引擎
  已选定）；弹窗 / 草稿阶段不要求引擎。
- **会话用途 `purpose`（2026-11-26，PSB 0.1.172）**：`POST …/workspaces/:id/sessions` 新增可选 body
  字段。省略 = `agent`（用户任务，进列表）；`internal` = 接入端服务用途（**默认不进会话列表、不增加
  工作区 `sessionCount`**，详情 / 停止 / 转录照旧可用）；其它值（含空串、大小写不对）PSB 回 400。
  `GET …/sessions` 默认只返回 `purpose='agent'`，`?includeInternal=1` 仅排障。
  **Cindy 的用户任务创建路径从不显式传 `purpose`**（与旧服务端逐字节一致）；只有旧 PSB 的过渡回退
  才传 `internal`（见 §3.2）。
- **状态词**：`starting` / `running` / `idle` / `stopped` / `failed`；`starting` / `running` / `idle`
  都允许输入，**终态永不逆转**（PSB 状态机显式保证，`stop()` 对终态幂等）。
- **终态语义**：Cindy 侧产品裁决是「终态不等于任务结束」——下一次发送在同一工作区新建 PSB 会话并
  透明重绑本地任务，不把输入锁死；PSB 不需要为 Cindy 实现 resume（会话记录是全新的）。
- **停止串流 ≠ 销毁环境**：关观看 WS / 断网只让观看者数归零，桌面会话继续运行；需要收掉环境时走
  PSB 的显式访问接口（销毁要带 `confirm:"destroy-unsaved-content"`，会丢未保存内容）。

### 1.4 串流观看端

- **协议**：观看端 WS 连上即订阅、断开即退订；上行**只有** `{kind:'input', event}`，不发
  `{kind:'open'}` / `{kind:'close'}`（会被计为非法消息）。服务端 → Cindy 的二进制帧是
  **4 字节帧头** `type(1)+flags(1)+seq(2,BE)` + H.264 载荷（客户端上行 C 通道那套 5 字节信封在
  中继侧剥掉 tag，不是观看端链路）；已用真机首帧与中继侧记录逐字节对齐。
- **名额**：观看名额与浏览器页面**共用同一套**，默认 4（部署级可配 1–16）；Cindy 观看端占 1 个。
- **`subscriberId`**：客户端生成 UUIDv4，一个观看端实例一个；重连复用同一 id = 替换旧订阅、不占新
  名额；换 id 才占新名额。
- **`errors=frame`（可选协商）**：不带参数时行为与旧版逐字节一致；带上后 PSB 先回 101 再发
  `stream.reject` 原因帧并按 `4409`（名额满）/ `4001`（会话停止）/ `4404`（会话不存在）等关闭。
  当前 Cindy **未启用**该参数（见 §3.2）。
- **`stream/status`**：`capability` = 这台客户端能不能串流，`active` = 此刻有没有画面；
  `desktopSession` / `reasonCode` / `lastErrorZh` 是加性字段，缺字段是「未知」而不是 `none`。
  `active` 的语义是「中继里有没有订阅者」，Cindy 不把它改写成 true。
- **4004 的两种含义**：未就绪（`reasonCode` / `desktopSession` 结构前缀优先）与慢订阅者被断开
  （只会在收到过帧之后出现）；Cindy 按「结构前缀 + 是否收过帧」归因。
- **4008 = 心跳超时**：中继判定观看端已失联后的关闭。Cindy 归因成稳定 token
  `heartbeat-timeout`（不是裸 `ws-4008`）；它与「慢订阅者」不同，用户可行动的是重新「启动」观看
  （桌面会话通常还在），面板优先显示 PSB 给的中文 reason。
- **宿主光标（`stream.cursor`）**：PSB 把客户端上报的宿主光标形状作为文本帧转发给同会话所有
  观看者。Cindy **只用 `name`**（XFixes 光标名）映射成 **CSS 关键字**（外观永远本机指针主题，与
  PSB 网页 `system` 模式同款；不用位图、不画假指针），且只在鼠标位于画面区域时生效；
  `serial` 不严格单调，Cindy 只去重连续重复形状、不按序号丢弃。
  **当前依赖（变更需双方同步）**：帧里的 `imageBase64` / `width` / `height` / `xhot` / `yhot` 虽不
  参与渲染，Cindy 解析器仍**强制要求并校验**它们（尺寸 1..64、热点在形状内、base64 ≤ 48 KiB 且
  只含 base64 字符集）；PSB 若停发位图字段或改边界，Cindy 会把整条 cursor 帧判为非法丢弃（不是
  静默降级）。PSB 侧改契约前双方确认，再同批改 Cindy 解析 / 测试 / 工程契约 §12.9。
- **映射语义已对齐共享核心（CINDY-RW-09，2026-11-26）**：X11 `name` → CSS 关键字的映射以 PSB
  `@psb/shared` 的 `packages/shared/src/stream-cursor.ts` 为权威来源（`remoteStreamCursorKeywordOf` /
  `remoteStreamCursorCssOf` / `remoteStreamCursorStyleOf`）；Cindy 的副本与之**逐条一致**（PSB
  源检出 0.1.127，2026-11-26 工作区快照：36 个 CSS 关键字 / 64 条 X11 别名，归一化顺序与
  未知/缺名 → `default` 相同；PSB 记录里的 `0.1.17x` 是**部署版本号**，不是源检出
  `package.json` 的版本）。`host` 位图只是 PSB 的**可选**外观策略，Cindy 固定 `system`
  （宿主风格），不渲染位图；未知 / 缺名 → `default`，**绝不 `none`**。Cindy 不 import PSB 包，
  表是带版本注明的只读副本；漂移检查与后续替换点见工程契约 §12.9。

### 1.5 串流输入与权限模型（2026-11-26，PSB 0.1.172）

- **单控制者仲裁已取消**：PSB 删除了 `role=control` 互斥、`takeover=1` 抢断与
  `CONTROL_CONFLICT`(4413) / `CONTROL_LOST`(4412) 的拒绝 / 踢人路径；这两个码与 `role` /
  `takeover` 参数**协议保留、产品不再使用**（参数仍被解析，`takeover` 只进审计）。
- **改成服务端权限模型**：工作区被占用 → 占用人可控制；工作区未被占用 → 已登录用户可控制；其它
  情况**只丢弃输入**、画面照旧。协商了 `errors=frame` 时会收到
  `{"type":"stream.control","allowed":false,"code":"CONTROL_FORBIDDEN"|"AUTH_EXPIRED",…}` 原因帧。
- **多观看者可同时注入输入**（有权限时），不再有「只读观看 / 接管」提示；Cindy 不在客户端做互斥。

### 1.6 工作区级服务接口（串流 / 工作区读取，2026-11-26）

- **模型边界**：Agent 会话只装用户任务（有对话、有转录、出现在会话列表、可停止）；**串流 / 工作区
  读取是服务接口**，与网页调同一套接口，**不创建任何 Agent 会话**。
- **工作区级订阅**：`POST /api/cindy/remote/workspaces/:workspaceId/stream/subscribe`，Bearer 鉴权，
  `subscriberId`（建议 UUIDv4）与 `errors` 原样透传到观看端 WS URL；返回
  `{ workspaceId, sessionId, streamPath, subscriberId }`。**没有 `expiresAt`**：订阅生命周期 = 观看端
  WS 连接；桌面访问被重建后要按工作区语义重新调一次拿新 `sessionId`，不当长期句柄保存。
- **没有 running 桌面访问时**：`409`，`details.code = "NO_RUNNING_SESSION"`、`details.state` ∈
  `none` / `starting` / `stopping` / `stopped` / `failed`；**不会**因订阅自动拉起桌面（先显式启动）。
- **兼容期**：旧 `WS …/sessions/:id/stream` 与 `…/stream/status` 仍可用，且现在也接受桌面访问会话
  id；但 PSB 要求**新代码只走工作区级端点**，并**删除「Cindy 观看端」内部 Agent 会话**。
- **Cindy 已适配（2026-11-26）**：`main/remote-workspace/psbClient.ts` 新增
  `subscribeWorkspaceStream(workspaceId)`（`POST`，解析 `{ sessionId, streamPath?, subscriberId?,
  expiresAt? }`，缺 `sessionId` 判协议错）；`adminService.streamStart` 先过占用闸门，再调它拿桌面
  访问会话 id 起观看端，**不创建 Agent 会话**；绑定（workspace → 桌面会话 id）持久化在本机记录
  （JSON 键 `desktopSessions`），重复启动先读一次 `stream/status` 复用、失效再重订阅；读路径只用
  绑定 id 只读 HTTP，**不订阅、不建会话、不占名额**。旧 PSB（订阅端点 404/405/`UNSUPPORTED`）才
  过渡回退到内部 Agent 会话，且必须带 `purpose:'internal'` + 内部用途标题 + warn 日志。
- **订阅 409 的处置（2026-11-26 真机修复）**：`NO_RUNNING_SESSION` 会被解析成
  `PsbRemoteFailure{ code:'PSB_STREAM_NO_RUNNING_SESSION', streamAccessState }`，并按 `state`
  跨 IPC 翻成三条码（`PSB_STREAM_NO_RUNNING_SESSION` / `PSB_STREAM_ACCESS_STARTING` /
  `PSB_STREAM_ACCESS_STOPPING`）；界面按 state 给可行动文案（去网页启动访问 / 等启动 / 等结束）、
  「在网页启动访问」按钮与 `starting` 的一次自动重试，PSB 中文原话保留为诊断行。
- **访问生命周期**：`GET /api/cindy/remote/workspaces/:id/access` 读
  `state` / `session` / `stream`；`POST …/access/stop` 显式销毁（需
  `{"confirm":"destroy-unsaved-content"}`，缺参数 400、幂等 200 `requested:false`、真正下发 202
  `requested:true`）。
- **跟进项（Cindy → PSB，2026-11-26）：放行 Cindy 的 `access/start` 入口**。PSB 拉起桌面访问的
  机器接口是**通用网页**路由 `POST /api/remote/workspaces/:id/access/start`（幂等 ensure，200/202/
  409），但 Cindy 的 Bearer 白名单是精确形状（只放行 `/api/cindy/remote/**`），这条对 Cindy 恒
  **403**（PSB 台账记「Cindy 入口下一轮加」）。Cindy 已预埋 `ensureWorkspaceAccess`（订阅前尝试一次
  + 轮询 `GET …/access` 到 running，403/404/超时一律**非致命**），**等 PSB 放行或提供
  `/api/cindy/remote/**` 命名空间下的等价入口即可生效，无需改 UI**。同时请给该接口的**最终 409
  示例**（当前 `details` 形状按 `none`/`starting`/… 推断，见 `联动需求.md`）。

## 2. 跨仓确认项（稳定编号 `CINDY-RW-*`）

编号一次分配后不复用；`CINDY-RW-11` 未使用。本表是这些确认项的**最终结论**，旧问答以本表为准。

| 编号 | 主题 | 最终结论（2026-11-26） | Cindy 适配 |
| --- | --- | --- | --- |
| CINDY-RW-01 | 鉴权 issuer / audience / claims | 复用 Meka 提交那条 Connection JWT（`<orgSlug>:meka-submit`），组织成员；claims 含 `iss`/`aud`/`org`/`email`/`sub`/`identities`；401 只重签一次。测试部署已实测 200 | 已实现 |
| CINDY-RW-02 | 模型凭据由谁注入 | 凭据不经 PSB、不进 HTTP / 隧道 URL；只在隧道内 Harness 应用层 RPC 里。PSB 零接触、不落库 / 日志 / 缓存 | 已实现 |
| CINDY-RW-03 | 隧道最小帧样例 | 与 MCPR 逐字节一致；`mode` 必填；exec 帧 NDJSON、`truncated:true` 当失败；pi 两阶段握手；cc-mgr hello 协商 `bundleVersion` | 已实现 |
| CINDY-RW-04 | 工作区选择弹窗交互 | 占用失败刷新列表 + 可读错误、**不进入草稿**；新建工作区弹窗保持并禁用、`provisioning` 不可开会话；只选工作区，引擎在草稿页选、首条消息时建会话 | 已实现 |
| CINDY-RW-05 | 串流连接上限与「停止」语义 | **旧答复（每会话 1 条 WS / 上限 2 / stop=close）已作废**。现行：名额与浏览器共用默认 4、`subscriberId` UUIDv4 重连复用、停止 = 断开 WS、桌面会话继续运行 | 已实现 |
| CINDY-RW-06 | 会话状态机映射 | **旧答复（只读观看 + 发 `open`/`close` + 四类输入禁用含终态）已作废**。现行：可交互观看；上行只有 `input`，订阅靠 WS 升级、退订靠断开；输入只由「他人占用 / 客户端离线 / 工作区未就绪」三种外部条件阻断；终态不锁输入、下一次发送透明重建；PSB 确认终态永不逆转 | 已实现 |
| CINDY-RW-07 | `psb:` transport 接入点 | 分类单一入口 + 渲染层镜像判据，`psb:` 不得进 SSH pool / SSH-only 探针；侧栏独立分组、i18n 12 locale | 已实现 |
| CINDY-RW-08 | 真机联调顺序 | 测试部署按「列表 / 占用 / 建会话 → exec → 三种 Harness → 串流」逐段取证；四阶段均已在测试部署走通（见 §3.3） | 已完成（测试部署） |
| CINDY-RW-09 | 宿主光标形状复用共享核心 | 映射语义以 PSB `@psb/shared` 的 `packages/shared/src/stream-cursor.ts` 为准（PSB 0.1.127，2026-11-26 工作区快照）：36 个 CSS 关键字 / 64 条 X11 别名、归一化与未知 → `default` 逐条一致；`host` 位图是可选策略（Cindy 固定 `system`，不渲染位图）；Cindy 不 import PSB 包。**跟进项**：请 PSB 给出版本化快照（当前 PSB 侧该文件尚未提交），拿到后改为 pinned 快照对照测试 | 已对齐 |
| CINDY-RW-10 | 占用 / 解除占用时的版本控制检查（含 P4 reconcile） | **两代口径并存（以 2026-11-26 20:4x 再更正为准）**：① PSB 0.1.180 起占用 / 释放**恒成功**（除权限 / 被他人占用 / 工作区不存在），2xx 响应里带**建议性** `data.vcs`（`advisory:true`，`dirty:true` 才有）与 actions `inspect-vcs` / `clean-workspace`（`POST …/vcs/revert`，**202 + operationId** 异步执行）/ `continue`（不发请求）；② 旧版 PSB（<0.1.180）的 `409 WORKSPACE_VCS_*` + `error.details.vcs` 仍作为**兼容路径**处置（`inspect-vcs` / `revert-then-*` / `retry`，更早还有 `revert-vcs`）。**没有 force 分支**（旧 `force-release` 已删除，收到不执行不渲染）。`messageZh` / `descriptionZh` 可直接展示；不可逆动作（clean / revert）需二次确认。**跟进项**：`clean-workspace` 202 之后若 PSB 有轮询 / 查询端点，请给最终形状（Cindy 当前只给「清理已开始 + 刷新」，不猜路径） | 已实现（advisory 主路径 + 旧 409 兼容） |
| CINDY-RW-12 | Harness 宿主层抽取与产物契约 | PSB 从 Cindy CDN 按 `bundleVersion` 物化 `cc-mgr` / `claude-code` / `codex` / `pi` 产物；`codexPackage` 优先、`ccMgr` 段缺失回退、CLI 形状冻结；`pins.json` 仍待发布流水线（维护者待办） | Cindy 侧无需改 |
| CINDY-RW-13 | CDN 产物契约与协议冻结 | 与 CINDY-RW-12 同一组事实；协议 / 关闭码按 MCPR 逐字节对齐；平台范围与 `pi` 保活语义以 PSB 部署为准 | Cindy 侧无需改 |
| CINDY-RW-14 | `pi-manager.mjs` 纳入 CDN | 仍未发布（维护者待办）；PSB 暂时内联产物并校验 sha256。Cindy 源码已修 pi 子进程 cwd，需 PSB 更新 vendored bundle / pin 后生效，期间 PSB 侧用 `cd` 前缀缓解 | 源码已修，发布待办 |
| CINDY-RW-15 | 会话消息推给 PSB | **已作废**：PSB 从自己的会话链路取内容，不要求 Cindy 额外上报转录 | 无需实现 |
| CINDY-RW-16 | 串流停止 ≠ 销毁；显式销毁接口 | 停止观看不影响桌面会话；销毁走 `access/stop`（`confirm` 必须，二次确认文案要写明未保存内容会丢失） | 停止语义已实现；显式销毁入口未接入（产品无此入口，有意） |

> **跟进项（CINDY-RW-09，2026-11-26）**：请 PSB 提供 `packages/shared/src/stream-cursor.ts` 的
> **版本化快照**（或发布共享包；PSB 在 CINDY-RW-09 第 4 点已表示可发布到共享包或给出版本化
> 快照）。原因是该文件目前只在 PSB 工作区（未提交），Cindy 只能按「PSB 0.1.127 + 2026-11-26
> 工作区快照」标注来源、靠人工逐条比对防漂移。拿到快照后：Cindy 把
> `apps/desktop/src/shared/psb-remote-workspace.ts` §5b 的表与归一化改为「对照 pinned 快照的差异
> 测试」；若后续允许跨仓依赖，则改为 import PSB 共享包。本项不阻塞当前口径（映射已逐条对齐）。

## 3. Cindy 侧适配状态

### 3.1 已适配（可复核证据在测试与两份正本）

- 身份 / 分类 / 隧道 / 三引擎真实回合 / 发送前透明重建 / 占用闸门 / 系统代理 / 就绪帧等待 /
  4004 两种归因 / 可交互观看与全屏捕获 / 宿主光标形状（**宿主风格 CSS 关键字、只在画面区域**；
  映射语义 CINDY-RW-09 已与 PSB 共享核心逐条对齐）/
  极简全屏 + 性能 HUD + 停止清屏 / 工作区级管理页（页面按工作区工作）/ 串流名额与 `subscriberId`
  语义。
- 工作区级 `stream/subscribe` 已适配（2026-11-26）：串流观看端不再创建 Agent 会话；绑定持久化、
  重复启动复用、失效重订阅、读路径不订阅不建会话；旧 PSB 的过渡回退带 `purpose:'internal'`。
  证据入口：工程契约 §11、产品规则 §2.4；定向测试
  `apps/desktop/src/main/remote-workspace/__tests__/psbWorkspaceAdminService.test.ts` 与
  `psbClient.test.ts`。
- **版本控制检查（CINDY-RW-10，2026-11-26）已适配**：0.1.180 的 2xx `data.vcs`（advisory）被解析为
  非阻塞提示（查看详情 / 一键清理（二次确认）/ 继续）；旧版 409 `details.vcs` 保留兼容处置
  （`retry` / 旧 `revert-*`）；无 force 分支，action 的 method/path/body 只经 main 校验后执行。
  证据入口：工程契约 §13.5；定向测试
  `shared/__tests__/psbWorkspaceVcs.test.ts`、`main/remote-workspace/__tests__/vcsNotice.test.ts`、
  `psbRemoteVcsService.test.ts`、`renderer/features/remote-workspace/vcs/__tests__/`。
- **订阅 409 `NO_RUNNING_SESSION` 三档处置（2026-11-26 真机修复）已适配**：客户端解析
  `details.code/state` → 三条 IPC 码 → 按 state 的可行动文案 + 「在网页启动访问」+ `starting`
  自动重试一次；PSB 中文原话保留为诊断行。证据入口：工程契约 §11.8、产品规则 §2.4；定向测试
  `main/remote-workspace/__tests__/psbClient.test.ts`、
  `psbWorkspaceAdminService.test.ts`、
  `renderer/features/remote-workspace/admin/__tests__/RemoteWorkspaceAdminPanel.test.tsx`。
- 证据入口：工程契约 §5、§6.1、§10–§12 的定向测试清单；产品规则 §2.4、§8.1–§8.2；测试命令形如
  `pnpm --filter desktop exec vitest run <file>`（具体文件见工程契约 §8 与各小节「验证方式」）。

### 3.2 已知偏差 / 未适配（不得按最终设计描述）

1. **`errors=frame` 未启用**：协议可选、不加参数行为与旧版逐字节一致；当前没有消费
   `stream.reject` / `stream.control` 的界面文案，启用前先补渲染层归因。
2. **权限模型拒绝帧未消费**：PSB 0.1.172 的 `stream.control` `CONTROL_FORBIDDEN` /
   `AUTH_EXPIRED` 只在协商 `errors=frame` 时出现；Cindy 当前默认允许交互，只在失焦 / 退出全屏 /
   断连时补发 release-all，不做客户端权限闸门。
3. **显式销毁入口未接入（有意）**：Cindy 没有「结束远程工作区」按钮，不调用 `access/stop`；如将来
   要做，必须单独入口 + 二次确认，不能和「停止串流」共用按钮。
4. **`pi-manager` CDN 发布与 PSB pin 更新未完成**：见 CINDY-RW-14；发布后 PSB 才可去掉 `cd` 前缀。
5. **旧 PSB 的过渡回退仍保留（临时）**：工作区级订阅端点不可用（404/405/`UNSUPPORTED`）时，
   Cindy 会创建一条 `purpose:'internal'` 的内部 Agent 会话充当观看端，并记 warn 日志。这是红线
   之外的**临时止血**，PSB 新端点在 0.1.172 已上线，新版客户端正常路径永不触发；等灰度面收窄后
   删除回退与 `PSB_ADMIN_INTERNAL_STREAM_SESSION_TITLE`。
6. **Cindy 还不能自己拉起桌面访问（待 PSB 放行白名单）**：`ensureWorkspaceAccess` 已实现（幂等
   ensure + 轮询），但 PSB 只对 Cindy 放行 `/api/cindy/remote/**`，通用网页
   `POST /api/remote/workspaces/:id/access/start` 对 Cindy 恒 403；该尝试被设计成**非致命**，
   用户下一步仍是「去 PSB 网页启动访问」。PSB 放行后无需改客户端。

### 3.3 未验证（真机 / 环境）

- Windows 远端的 `SendInput` 注入路径：PSB 未做生产验证，Cindy 不按「已支持」承诺。
- 多观看者同时注入输入（权限模型下）：未构造真机场景；`CONTROL_*` 码与 `errors=frame` 未实测。
- 慢订阅者（收帧后 4004）的弱网 / 积压真机复现：只有单测。
- 宿主光标形状的真机复验（文本区 I-beam / 窗口边缘 resize / 忙碌 loading、移出画面恢复宿主默认、
  HUD / 按钮不受影响、全屏内只在画面区域生效）：进行中。
- 正式部署复测：测试部署与正式部署同一份代码，差异只在端点开关；正式环境只读链路尚未复跑。
- 「进入页面不自动启动 / 离开页面自动停止」的新口径真机复验（旧「进页自动出画面 / 切回自动重订」
  结论已随口径作废）。
- 串流改工作区级订阅后的真机复验（2026-11-26 交付待办）：① 启动串流后 PSB 会话列表只有用户任务
  （无「Cindy 观看端」行）；② 重启 Cindy 后仍能读桌面会话状态并复用绑定；③ 旧 PSB / 灰度前服务端
  的过渡回退路径（端点 404/405/`UNSUPPORTED` → `purpose:'internal'`，列表不可见、`sessionCount`
  不增加）。
- **版本控制检查（CINDY-RW-10）两代形态的真机复验**：① 旧版 409 兼容路径（<0.1.180）可在当前
  测试部署直接构造（故意弄脏工作区 → 占用/释放 → 409 + actions → retry/旧 revert）；② 0.1.180
  advisory 主路径（2xx `data.vcs`、`clean-workspace` 202 + `operationId`、「清理已开始 + 刷新」）
  **需要 PSB 0.1.180 已上线后真机联调**，当前只有单测；③ `clean-workspace` 后的刷新/轮询端点
  形状待 PSB 给出（Cindy 未猜路径）。
