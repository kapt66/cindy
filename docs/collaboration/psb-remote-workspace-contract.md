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
- **访问生命周期**：`GET /api/cindy/remote/workspaces/:id/access` 读
  `state` / `session` / `stream`；`POST …/access/stop` 显式销毁（需
  `{"confirm":"destroy-unsaved-content"}`，缺参数 400、幂等 200 `requested:false`、真正下发 202
  `requested:true`）。

## 2. 跨仓确认项（稳定编号 `CINDY-RW-*`）

编号一次分配后不复用；`CINDY-RW-09..11` 未使用。本表是这些确认项的**最终结论**，旧问答以本表为准。

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
| CINDY-RW-12 | Harness 宿主层抽取与产物契约 | PSB 从 Cindy CDN 按 `bundleVersion` 物化 `cc-mgr` / `claude-code` / `codex` / `pi` 产物；`codexPackage` 优先、`ccMgr` 段缺失回退、CLI 形状冻结；`pins.json` 仍待发布流水线（维护者待办） | Cindy 侧无需改 |
| CINDY-RW-13 | CDN 产物契约与协议冻结 | 与 CINDY-RW-12 同一组事实；协议 / 关闭码按 MCPR 逐字节对齐；平台范围与 `pi` 保活语义以 PSB 部署为准 | Cindy 侧无需改 |
| CINDY-RW-14 | `pi-manager.mjs` 纳入 CDN | 仍未发布（维护者待办）；PSB 暂时内联产物并校验 sha256。Cindy 源码已修 pi 子进程 cwd，需 PSB 更新 vendored bundle / pin 后生效，期间 PSB 侧用 `cd` 前缀缓解 | 源码已修，发布待办 |
| CINDY-RW-15 | 会话消息推给 PSB | **已作废**：PSB 从自己的会话链路取内容，不要求 Cindy 额外上报转录 | 无需实现 |
| CINDY-RW-16 | 串流停止 ≠ 销毁；显式销毁接口 | 停止观看不影响桌面会话；销毁走 `access/stop`（`confirm` 必须，二次确认文案要写明未保存内容会丢失） | 停止语义已实现；显式销毁入口未接入（产品无此入口，有意） |

## 3. Cindy 侧适配状态

### 3.1 已适配（可复核证据在测试与两份正本）

- 身份 / 分类 / 隧道 / 三引擎真实回合 / 发送前透明重建 / 占用闸门 / 系统代理 / 就绪帧等待 /
  4004 两种归因 / 可交互观看与全屏捕获 / 宿主光标形状（**宿主风格 CSS 关键字、只在画面区域**）/
  极简全屏 + 性能 HUD + 停止清屏 / 工作区级管理页（页面按工作区工作）/ 串流名额与 `subscriberId`
  语义。
- 证据入口：工程契约 §5、§6.1、§10–§12 的定向测试清单；产品规则 §2.4、§8.1–§8.2；测试命令形如
  `pnpm --filter desktop exec vitest run <file>`（具体文件见工程契约 §8 与各小节「验证方式」）。

### 3.2 已知偏差 / 未适配（不得按最终设计描述）

1. **工作区级 `stream/subscribe` 未适配（P0）**：PSB 已交付工作区级订阅端点契约（上线状态以 PSB
   部署为准）并要求删除「Cindy 观看端」内部 Agent 会话，Cindy 当前仍在用户点「启动」时于
   `main/remote-workspace/adminService.ts` 创建 / 复用该内部会话（复用只认本机记录
   `viewers[workspaceId]`，不按标题认领），用它订阅；读 `stream/status` 只借已有会话、不创建。
   原因：该契约在本批观看端落地之后到达，替换会横切内部会话生命周期、状态读取与测试，未在同一
   交付内完成。影响：PSB 会话列表会出现用户没发起过的内部会话、占用 1 个观看名额，且未消费
   `NO_RUNNING_SESSION` / 按工作区重订语义。迁移条件：PSB 端点上线状态与字段 / 错误码确认后，
   改用 `POST …/workspaces/:id/stream/subscribe`，删除内部会话创建 / 复用与标题常量，补「不创建
   Agent 会话」「409 空态」「桌面重建后重新订阅」的定向测试；届时同步删本偏差条目。
2. **`errors=frame` 未启用**：协议可选、不加参数行为与旧版逐字节一致；当前没有消费
   `stream.reject` / `stream.control` 的界面文案，启用前先补渲染层归因。
3. **权限模型拒绝帧未消费**：PSB 0.1.172 的 `stream.control` `CONTROL_FORBIDDEN` /
   `AUTH_EXPIRED` 只在协商 `errors=frame` 时出现；Cindy 当前默认允许交互，只在失焦 / 退出全屏 /
   断连时补发 release-all，不做客户端权限闸门。
4. **显式销毁入口未接入（有意）**：Cindy 没有「结束远程工作区」按钮，不调用 `access/stop`；如将来
   要做，必须单独入口 + 二次确认，不能和「停止串流」共用按钮。
5. **`pi-manager` CDN 发布与 PSB pin 更新未完成**：见 CINDY-RW-14；发布后 PSB 才可去掉 `cd` 前缀。

### 3.3 未验证（真机 / 环境）

- Windows 远端的 `SendInput` 注入路径：PSB 未做生产验证，Cindy 不按「已支持」承诺。
- 多观看者同时注入输入（权限模型下）：未构造真机场景；`CONTROL_*` 码与 `errors=frame` 未实测。
- 慢订阅者（收帧后 4004）的弱网 / 积压真机复现：只有单测。
- 宿主光标形状的真机复验（文本区 I-beam / 窗口边缘 resize / 忙碌 loading、移出画面恢复宿主默认、
  HUD / 按钮不受影响、全屏内只在画面区域生效）：进行中。
- 正式部署复测：测试部署与正式部署同一份代码，差异只在端点开关；正式环境只读链路尚未复跑。
- 「进入页面不自动启动 / 离开页面自动停止」的新口径真机复验（旧「进页自动出画面 / 切回自动重订」
  结论已随口径作废）。
