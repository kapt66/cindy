# PSB 远程工作区会话传输契约（`psb:` transport）

> **状态**：权威开发规则（authoritative）。
> **读取时机**：修改 `remoteHostId` 的 transport 分类、PSB 的 HTTP / 隧道 / 串流客户端、这一组
> IPC、远端 preflight，或把上游同步进 `meka/main` 时。
>
> 产品行为见 [远程工作区：PSB 远程 Agent 会话](../product-rules/psb-remote-workspace-sessions.md)；
> 跨仓已确认的契约事实、`CINDY-RW-*` 稳定编号与 Cindy 适配状态见
> [PSB 跨仓契约摘要](../collaboration/psb-remote-workspace-contract.md)（脱敏、入仓，是本文引用
> 跨仓事实的稳定锚点）。PSB 侧接口形状的字段级正本仍是 PSB 仓根目录 `协作需求.md`，本文
> 只写 Cindy 侧的契约、不变量与验收口径，不引用不入库的当地协调流水。
>
> 2026-11-25 落笔时的实现状态：共享契约（`apps/desktop/src/shared/psb-remote-workspace.ts`）、
> PSB 鉴权 / 端点 / HTTP 客户端 / agent-tunnel（`apps/desktop/src/main/remote-workspace/`）、
> `psb:` transport 分类与 maker-host 的隧道分派、main 服务装配与推送、preload 与
> `vite-env.d.ts` 声明、侧栏分组、串流观看端与「远程工作区」页签（工作区级页签：页面按工作区
> 工作、不跟随当前任务）均已落地；**2026-11-26 PSB 0.1.172 起，工作区级观看端改走服务接口
> `POST …/workspaces/:id/stream/subscribe`（返回桌面访问会话 id），Cindy 不再为串流创建 Agent
> 会话**（旧 PSB 的过渡回退带 `purpose:'internal'`，见 §11.7）。定向测试在同一次交付中并行落地
> ——**本文同时是它们的验收口径**，未落地项不得当作已完成。

## 1. `psb:` 是第三种远端身份

`remoteHostId` 现在是三种 transport 的联合，三者互不混用：

| 值 | transport | 进入哪条路径 |
| --- | --- | --- |
| 空 | 本地 | 不进入任何远程 preflight |
| `psb:<PSB sessionId>` | PSB 远程工作区（本文） | PSB HTTP / agent-tunnel / 串流 |
| `mcpr:<instanceId>` | MCPRouter 账号隧道 | MCPRouter bridge / tunnel |
| 其它非空值 | SSH Remote | SSH pool / SSH-only 探针 |

硬约束：

1. **前缀即身份**：`psb:` 是 PSB 会话身份，**不是** SSH 主机名，也不是 MCPR 实例 id。共享常量
   与纯函数在 [psb-remote-workspace.ts](../../apps/desktop/src/shared/psb-remote-workspace.ts)
   （`PSB_REMOTE_HOST_PREFIX` / `buildPsbRemoteHostId` / `parsePsbRemoteHostId`），主进程与渲染层
   都从这里取，禁止第三次手写 `startsWith('psb:')`。
2. **id 由 PSB 生成、Cindy 原样保存**：Cindy 不解析、不拼接、不推导它的格式；本地会话行用
   `remoteHostId = buildPsbRemoteHostId(session.id)` 记住它。
3. **`workingDir` 是虚拟引用**：`/psb-remote/<目录名或工作区 id>` 只服务显示与选择，绝不参与本机
   路径解析（不 `path.join`、不 `fs` 读、不当 worktree 根、不做路径型附件的根）。
4. **分类先于任何 transport 专属动作**：所有会话创建、lazy resume、send 前置、恢复、退休路径
   都必须先 `classifyRemoteSessionTransport(remoteHostId)`，再按 `'psb' | 'mcpr' | 'ssh' | 'local'`
   分派。分类器唯一入口是
   [remote-session-routing.ts](../../apps/desktop/src/main/maker-host/remote-session-routing.ts)；
   远端钩子的公共门禁用同一个模块的 `isTunnelRemoteSessionTransport`（`psb:` / `mcpr:` 走隧道），
   **不手写 `startsWith('mcpr:') || startsWith('psb:')`**。
5. **渲染层必须镜像同一判据**：渲染层 import 不到主进程模块，
   [remoteCodexModelHost.ts](../../apps/desktop/src/renderer/lib/remoteCodexModelHost.ts) 的
   `asSshRemoteHostId` / `resolveRemoteCodexModelHostId` / `resolveSshCodexCatalogHostId` 必须把
   `psb:` 判为**非 SSH**。两处判据的一致性由输入矩阵测试断言（不是靠注释约定），新增前缀时
   两侧与矩阵必须同一次改。这条的历史代价见
   [MCPR 远程会话路由](mcpr-remote-session-routing.md) §3 第 7、8 条（三次实机事故：假告警、
   发送被拦、模型整组消失）。
6. **`psb:` 不得进入 SSH pool 或 SSH-only 分支**：`ensureRemoteHostReady`、SSH 安装/daemon 预上传、
   `getRemoteSshPool().get`、远端 Codex 清单探针、远端 MCP 刷新、Codex 登录同步按钮等，
   只接受分类结果为 `'ssh'` 的身份。新增任何 SSH-only 探针时，调用点先分类。

## 2. agent-tunnel：与 MCPRouter 同一份帧契约

PSB 把 Cindy 与远端客户端串起来，但**数据面协议一行没变**——Cindy 已在 MCPRouter 上跑三种
Harness，那些实现只依赖「一条字节流 + mode 选择」。因此 PSB 侧只换三件事：地址、鉴权、失败
归因。分三层，改动只能落在对应层：

- 数据面：[psbTunnel.ts](../../apps/desktop/src/main/remote-workspace/psbTunnel.ts)（URL、帧契约、
  关闭码归因），**不解析身份、不自己取 token**；
- 生产接线：[psb-agent-tunnel.ts](../../apps/desktop/src/main/maker-host/psb-agent-tunnel.ts)
  （三种 Harness 共用的**唯一**取 token 处：登录身份 → audience → Connection JWT → 交给数据面）；
- 分派：
  [remote-tunnel-dispatch.ts](../../apps/desktop/src/main/maker-host/remote-tunnel-dispatch.ts)
  把 `psb:` / `mcpr:` 映射到各自的隧道 opener；本地与 SSH 在这里是**编程错误**，不回落 SSH pool
  （回落会把「这里不该有隧道」变成更难诊断的 SSH 错误）。

帧契约要点：

- **URL**：`wss://<PSB 站点根>/api/cindy/remote/sessions/<sessionId>/agent-tunnel?mode=…[&bundleVersion=…]&readyFrame=1`
  （路径常量在共享契约的 `PSB_CINDY_WS.agentTunnel`，不在两处各拼一次）。
- **就绪帧必须 opt-in（`readyFrame=1`；PSB 0.1.159+ 引入 `agent-tunnel.ready` 文本帧，
  0.1.160+ 起 opt-in、默认不发）**：不声明时服务端日志 `readyFrame=false`，也就永远收不到 ready。
  服务端只认字面量 `1`；`buildPsbTunnelUrl` 固定携带它，`psbTunnelWiring.test.ts` 对四种 mode
  都钉住该参数且不影响 `mode` / `bundleVersion`。
  **等待按进程级能力探测，不再每条连接固定等满**：第一次等到 ready → `supported`；第一次超时
  （非 exec 5s / exec 1.2s）→ `unsupported`，后续连接在 `open` 时立即交句柄（老服务端的兜底
  行为本来就是直接发）。探测结果在同一站点进程内复用；就绪前的 binary 帧有界排队、句柄交接后
  按序回放，不丢首帧（2026-11-26 复审，见 §15.5）。
- **鉴权**：`Authorization: Bearer <Cindy Connection JWT>`（MCPR 那条是 cookie session，这是唯一
  实质差别）。token 取不到时隧道直接失败，不带空凭据尝试；失败统一经 `psbAuthFailure` 归因
  （未登录 `signed-out` / 非企业组织 `need-org` → `PSB_AUTH_REQUIRED` + 身份原因键；签发通道
  不可达 → 网络类码），**取 token 失败不失效** token 缓存——失效只发生在 PSB 明确 401/403 之后
  （见 §15.5）。
- **mode**：`cc-mgr` / `codex-appserver` / `pi` / `exec`，语义与 MCPRouter `agent-tunnel` 逐字相同；
  Agent 类型到 mode 的映射与「只有消费 cc-mgr 产物的两种 mode 才声明 `bundleVersion`」由共享
  纯函数（`psbTunnelModeForAgent` / `psbTunnelNeedsBundleVersion`）决定。**四种 mode 都必须显式写**：
  PSB 把 `mode` 当必填（缺省不会落到 `cc-mgr`），2026-11-26 联调已因此纠正，见 §10.5。
- **`bundleVersion`**：值一律取自 `CC_MGR_BUNDLE_VERSION` 常量，**不在这里写第二份字面量**；只在
  `cc-mgr` / `codex-appserver` 上携带，`pi` / `exec` 不带（服务端白做一次物化没有收益）。
- **exec 帧形状**：与 MCPR `mode=exec` 的冻结 NDJSON 形状一致（请求行 / 流帧 / 末行 / error 行）；
  `truncated:true` 是**失败**（截断输出不得当完整数据返回给 file-ops），未知字段一律忽略。
- **关闭码**：`4003` 鉴权被拒、`4004` 会话/运行时未就绪，其它按不可用；握手阶段的 HTTP
  401/403/404/409/429 分别归因为鉴权、会话不可见、未就绪/占用/离线、限流——**归因错了用户就会去
  做无效动作**（重新登录解决不了「工作区被占用」）。
- **复用而不是重写**：三种 Harness 的数据面继续用既有客户端实现
  （`cc-manager-client` / Codex remote transport / Pi 的 `pi-mcpr-remote` 接缝），PSB 这条只提供
  `openStream` / `openTunnel` 注入点返回的 `ExecStreamHandle`。**不得为 PSB 另造帧格式或第二套
  Harness 协议**；PSB 若要求差异，先写进 PSB 仓 `协作需求.md` 并双侧确认。
- **退休必须释放**：每条隧道都要经 `remoteTransportRegistry` 登记 `{sessionId, remoteHostId, dispose}`，
  释放走单一入口 `releaseRemoteTransport(sessionId, reason)`（agent `close`、会话 `onClose`、Worker
  归档三条退休路径都调它，幂等）。漏登记的后果与 MCPR 同型：远端把会话当成一直开着，后续
  commit / 提交类动作被 `session-open` 挡住，只有重启客户端才恢复
  （见 [MCPR 远程会话路由](mcpr-remote-session-routing.md) §2.1 的实机复现）。
  **Codex 还有第二条长连接需要释放**：控制面 `mode=cc-mgr` 通道在
  `main/maker-host/mcpr-codex-capability.ts` 里按完整 `remoteHostId`（含 `psb:<sessionId>`）缓存，
  只在其**流自己 close** 时删缓存。PSB 的会话停止 / 重绑不会替我们关这条隧道，所以 PSB 分支在
  data-plane transport 终态时调 `releaseTunnelCodexControlChannel(remoteHostId)`（`end()` + 清缓存，
  幂等）；假设 PSB 在会话停止时也会回收该会话的隧道，但实现不依赖该假设。
- **版本门禁**：cc-mgr bundle pin 与 MCPR 同一份来源与同一套错配诊断口径（`INVALID_BUNDLE_VERSION`
  不得拍平成 `LAZY_CREATE_FAILED`）。PSB 的客户端 runtime 是否也按 `bundleVersion` 从 CDN 物化
  bundle、以及 Codex 最低版本，属于跨仓未定项，见[跨仓契约摘要](../collaboration/psb-remote-workspace-contract.md) §2（CINDY-RW-12/13）。
- **Codex 控制面与 MCPR 同源**：Codex 会话除了数据面隧道还要一条 capability 控制通道；
  PSB 分支复用同一份构造（`buildTunnelRemoteCodexBridgeHeader`），凭据模式恒为 **gateway-key**
  （远端只吃 Cindy AI Gateway key，**不**复制本机 OAuth），cc-mgr hello 里声明的 capability MCP
  地址/令牌与 MCPR 同形。PSB 侧若不提供（或 hello 未声明），失败归因为
  `[PSB_CAPABILITY_UNAVAILABLE]` **fail-closed**，不降级成「能对话但没有工具」的静默会话。
  PSB 分支**不下发 `cwd`**：会话的工作目录由 PSB 按工作区决定，Cindy 只给虚拟 `workingDir`
  （见 §1 第 3 条），不能把虚拟路径写进远端进程参数。
- **cc-mgr 的 `cwd` 同理由宿主拥有**：`query/start` 的 `cwd` 在 wire 上是**必填字段**（daemon 侧
  `sdk-handlers` 的 `requireString(p.cwd, 'cwd')`），所以 PSB 分支传 `'.'`——宿主按服务端会话记录
  的工作区 spawn daemon，`'.'` 即 daemon 自己的工作目录（= 服务端工作区）。**不得**把虚拟
  `workingDir`（`/psb-remote/<目录>`）当远端路径下发：daemon 的 SDK 用它 spawn `claude` 时
  目录不存在，query 在首个 turn 之前就终止，用户只看到 `Session <id> is closed`
  （2026-11-26 实报，根因与取证见 §10.9）。`mcpr:` 的 `workingDir` 是实例上的真实路径，不受此限。
- **Codex 的 workspace roots 同理由宿主拥有**（`remoteHostOwnsCwd`，2026-11-26 审查补齐）：只把
  `thread/start` 的 `cwd` 换成 `.` 不够 —— `runtimeWorkspaceRoots`、按本机 `workingDir`/`writableDirs`
  拼出来的 named permission profile、`turn/start` 的 `sandboxPolicy.writableRoots` 都会把本机路径
  下发到远端 app-server。`remoteHostOwnsCwd` 为真时这些一律不带（roots 为空、profile 不启用、
  writableRoots 只留远端 app-server 自报 CODEX_HOME 的 memories），本机 `extraDirs` /
  `writableDirs` 不进入该会话的可变授权面。判定只有一处：`maker-host/index.ts` 的
  `lifecycleHooks.prepareStartOptions` 用 `remoteSessionHostOwnsCwd` 给**所有** `createSession`
  入口打标（界面 / lazy-create / resume / Goal 恢复 / IM / hook-control 都经过这个钩子；
  `maker-ipc/register.ts` 不再单独打标，否则绕过它的恢复路径会漏）。
- **系统代理**：隧道与 HTTP 走**同一份**代理语义——HTTP 用 `outboundFetch`、隧道经  `PsbTunnelDeps.agentForUrl` 注入 `createOutboundHttpAgent(url)`（`ws` 自己不读系统代理，必须显式给）。
  漏这一条会出现「列表能读到、隧道连不上」这种一半一半的故障。已知边界：需要认证的系统代理
  仍不支持（与 main 其它出网一致，收到 407 明确失败）；代理解析失败 fail-open 走直连。

## 3. HTTP 客户端与错误映射

所有 PSB HTTP 调用都从 main 的 [psbClient.ts](../../apps/desktop/src/main/remote-workspace/psbClient.ts)
出去；渲染层没有直连能力，也没有 token。

- **命名空间**：`/api/cindy/remote/**`（Cindy 专用前缀，不是浏览器用的 `/api/remote/**`），路径
  常量在共享契约的 `PSB_CINDY_ROUTES`。
- **出网 URL 只有一份归一化判据（`resolvePsbUrl`）**：`psbEndpoint.ts` 对 HTTP 与两条 WS 统一
  校验「origin 相同 + 归一化后 pathname 逐字节不变 + 以 `/api/cindy/remote/` 开头」；`..` /
  `%2e%2e` / 反斜杠 / `//` 等会被 URL 解析器改写的形态全部拒绝。CINDY-RW-17 起**没有**任何
  命名空间例外（拉起访问也走 Cindy 命名空间的 `access/start`），不能靠字符串前缀二次判断
  （见 §15.1）。
- **外壳**：成功读 `{ data: … }`，失败读 PSB 既有的 `{ error: { code, message, details? } }`；
  DTO 由共享解析函数**防崩收口**（连 id 都没有的行丢弃；未知枚举值一律 `null`，**不**回落
  `claude-code` / `failed` 这类「安全默认」——把未知当已知会让错误隧道或假终态发生；展示字段按
  `PSB_TEXT_LIMITS` 截断、标识字段超限整行丢弃，截断会改身份），严格校验在 PSB。
  **列表键缺失 / 不是数组是协议错**：`readArray` 返回 `null`，由 `call` 统一抛 `PSB_PROTOCOL`
  （旧实现静默变 `[]`，界面显示「没有工作区」而真实原因是契约违约，见 §15.8）。
- **凭据纪律**：Bearer 只进请求头——不进 URL、不进日志、不进 IPC 返回值；日志里最多出现
  「audience 已解析」这类不含凭据的字段。
- **401 只重签一次**：`AUTH_INVALID` / `AUTH_EXPIRED` / `AUTH_REQUIRED` 才失效内存缓存并重新签发
  一次；再失败就是真的不能用，**不循环**（否则 401 会放大成对云端签发接口的滥用）。`403
  IDENTITY_NOT_LINKED` 不是「token 坏了」，**不重签**。
- **网络失败与业务失败分开**：连不上/超时记 `PSB_UNREACHABLE`（用户查网络），PSB 返回的
  `{error:{code}}` 保留原码并映射成文案键（用户看工作区）。混成一个码会让「为什么不能开会话」
  永远只有一句「操作失败」。单次请求预算 20s，超时按网络失败处理；「尽力拉起桌面访问」的轮询
  另受**总 deadline** 约束（CINDY-RW-17 起默认 `totalMs=90_000` 覆盖 Unity / 虚拟桌面冷启动，
  每次请求超时压到剩余预算内，见 §15.7）。
- **409 必须可行动**：`WORKSPACE_OCCUPIED_BY_OTHER`（带占用人名，用于文案插值）、`CLIENT_OFFLINE`、
  工作区非 `ready`、会话终态分别给不同的文案键与下一步建议；归属 404 与真不可达不混用。
- **失败形状统一**：渲染层只收 `PsbRemoteFailure { code, messageKey, message }`，**不在渲染层判
  HTTP 码**；未知码保留原始码并落通用文案键。payload 形状不符记 `PSB_PROTOCOL`，不静默当成空。
- **网页地址归一**：PSB 下发的 `webUrl` / `sessionsWebUrl` 来自 PSB 自己的部署认知，Cindy 只把
  协议与主机替换成当前生效站点根（路径与查询保持原样），避免联调部署点开链接跳到生产。
- **工作区详情只认列表口（2026-11-26 真机事故）**：`GET /workspaces/:id` 在 Cindy JWT 白名单里
  **不放行**，恒 403（`这个 Cindy 身份不能访问该接口`），而列表行本来就带完整 `webUrl` /
  `sessionsWebUrl`。因此读单行的唯一入口 `psbClient.readWorkspaceWebUrl()` 顺序固定为
  **列表 → 单行兜底 → `null`**：列表鉴权/组织/网络失败原样抛（用户要看真实原因）；单行的
  403/404/405 都当「读口没有答案」返回 `null`（调用方给「找不到工作区」的可行动提示，而不是
  把 PSB 的 403 文案透出去）。旧实现只对 404/405 兜底、把 403 当真实失败，结果「在网页打开」
  在真机上只剩一句误导的失败。

## 4. IPC 面

远程工作区的 IPC 面很宽（列表 / 占用 / 建会话 / 管理页 / 版本控制 / 会话结束释放），必须收口，否则同一条判据会
散在三处且各自漂移。**当前合计 23 个 invoke + 6 条推送**，唯一来源是共享契约的
两组常量；`psbRemoteIpcWiring.guard.test.ts` 用「方法 ↔ 通道」映射表锁住常量、preload、bridge 与
main handler 四处一一对应，新增 / 改名四处同改、不允许硬编码字符串。

- **会话级通道**：`PSB_REMOTE_CHANNELS`，**21 条 = 17 invoke + 4 推送**。
  invoke：`status` / `list-workspaces` / `list-clients` / `list-templates` / `create-workspace` /
  `occupy-workspace` / `release-workspace` / `create-session` / `refresh-workspaces` /
  `session-status` / `stop-session` / `open-web-workspace` / `workspace-vcs-notice:get`
  （兜底读当前工作区的版本控制通知）/ `workspace-vcs-action`（执行一个版本控制处置动作，
  渲染层只传 kind，见 §13.5）/ `release-session-workspace`（会话结束 → main 归还它占用的
  PSB 工作区）/ `pending-releases:get` / `pending-releases:retry`（读 / 显式重试 main 的
  待释放账本，见 §16.4）。
  推送：`workspace-changed` / `workspace-vcs-notice`（占用 / 释放时的版本控制通知，见 §13.5）/
  `sessions-rebound`（发送前透明重建成功后发一次，见 §6.1 / §9.4）/ `pending-releases-changed`
  （main 待释放账本变了：失败入账 / 重试成功出账 / 退出前重试，见 §16.4）。
  会话级 `STREAM_STATUS` / `STREAM_START` / `STREAM_STOP` / `STREAM_INPUT`（4 个 invoke）与
  `STREAM_EVENT`（1 个 push）**已删除**：渲染层零消费，串流一律走工作区级管理页通道（r10 死面清理）。
- **工作区级管理页通道**：`PSB_ADMIN_CHANNELS`，**8 条 = 6 invoke + 2 推送**。
  invoke：`admin-context` / `admin-stream-start` / `admin-stream-stop` / `admin-stream-status` /
  `admin-stream-input`（工作区级键鼠）/ `admin-stream-capture`（全屏捕获态）；
  推送：`admin-context-changed` / `admin-stream-event`（`sessionId` = 观看端绑定会话：正常是
  桌面访问会话 id，旧 PSB 过渡回退是内部 Agent 会话 id，见 §11）。
  语义与生命周期见 §11。**多窗口按工作区引用计数**：`start` +1、`stop` / 窗口销毁 -1，只有归零
  才真的 `streamStop`；`frame` / `cursor` 只发给登记过 owner 的窗口，`status` / `error` 仍广播；
  本端主动关闭的 `closed(client-stopped)` / `closed(superseded)` 也只发给该 `viewerSessionId`
  的 owner（没有 owner 就丢弃，见 §15.3）。两组常量刻意分开、值不重叠：会话级推送与管理页推送
  混用会让同一帧被两处解码，guard 会拦下重名。
- **main 侧的单一服务入口**：[remote-workspace/index.ts](../../apps/desktop/src/main/remote-workspace/index.ts)
  把 HTTP 客户端、串流观看端与推送装成一组语义方法（HTTP 走宿主 `outboundFetch`、WS 走
  `createOutboundHttpAgent`，与 MCPRouter / 插件同一条出网口径）；IPC handler 只做参数校验与
  错误映射，不自己拼 URL、不自己取 token；推送只经
  [push.ts](../../apps/desktop/src/main/remote-workspace/push.ts)，服务不直接碰 `BrowserWindow`。
- **handler 约定**：沿用仓库既有 IPC 规则（见
  [Electron 安全与进程边界](electron-security-and-process-boundaries.md) 与
  [工程约定](engineering-conventions.md)）：`assertTrustedAppRendererEvent` 校验来源窗口、
  payload 先校验再产生副作用、失败走 `throwIpcError` 的既有码；不信任渲染层传来的任何身份字段。
- **失败码跨 IPC**：`ipcMain.handle` 抛错跨进程只保留 `message`，所以语义由**命名空间化错误码**
  承载：`ipc-errors.ts` 的 **21 个** `PSB_*` 码（鉴权 `PSB_AUTH_REQUIRED` / 组织 `PSB_ORG_REQUIRED` /
  过期 `PSB_AUTH_EXPIRED` / 通讯录 `PSB_IDENTITY_NOT_LINKED` / 占用
  `PSB_WORKSPACE_OCCUPIED_BY_OTHER` / 离线 `PSB_CLIENT_OFFLINE` / 未就绪
  `PSB_WORKSPACE_NOT_READY` / 远端客户端无该引擎运行时 `PSB_AGENT_UNSUPPORTED` / 管理页 stale 归因
  `PSB_WORKSPACE_MISSING` / `PSB_WORKSPACE_UNREACHABLE` / `PSB_WORKSPACE_ID_UNKNOWN` / 版本控制
  `PSB_WORKSPACE_VCS_DIRTY` / `PSB_WORKSPACE_VCS_UNAVAILABLE` /
  `PSB_WORKSPACE_VCS_UNSUPPORTED` / 找不到 `PSB_NOT_FOUND` / 不可达 `PSB_UNREACHABLE` /
  串流不可用 `PSB_STREAM_UNAVAILABLE` / 串流未启动 `PSB_STREAM_NOT_ACTIVE` / 没有 running
  桌面访问三档 `PSB_STREAM_NO_RUNNING_SESSION` / `PSB_STREAM_ACCESS_STARTING` /
  `PSB_STREAM_ACCESS_STOPPING`）。
  main 用 `psbIpcCodeForFailure` 产出，渲染层用 `psbFailureMessageKeyForIpcCode` 映射文案键
  （或 `psbRemoteFailureFromIpcError` 取回 `PsbRemoteFailure` 形状）；协议错 / 未知码落通用
  `INTERNAL`，只带诊断原文。`message` 只放 PSB 原文或占用人名，**不含** token、Authorization 或身份字段。
- **handler 现取单例**：handler 内每次 `getPsbRemoteService()`，不在注册时捕获实例——账号边界会
  `disposePsbRemoteService()`（断开串流、释放远端观看名额），捕获旧实例会让串流在本进程内永久不可用。
- **推送点**：`WORKSPACE_CHANGED` 只在 main「刚拿到新快照」时发——新建工作区 / 占用 / 释放 / 建会话
  成功后（服务层 `emitWorkspaceSnapshot`），以及 `SESSION_STATUS` 读回、`STOP_SESSION` 停完后的会话
  所属工作区快照；串流事件（管理页 `ADMIN_STREAM_EVENT`）只来自串流观看端，其中 `frame` / `cursor`
  与「本端主动关闭」的 `closed(client-stopped|superseded)` 按 owner 定向、`status` / `error`
  广播（§15.3）。main **不轮询** PSB，
  列表刷新仍由渲染层按需触发。
- **preload**：`psbRemote` 组只暴露最小方法集；推送用 `createIpcFanOut` 并按引用计数解绑，
  必须丢弃 `IpcRendererEvent`、不暴露 `ipcRenderer` 本体。
- **渲染层单一入口**：[bridge.ts](../../apps/desktop/src/renderer/features/remote-workspace/bridge.ts)
  的 `PsbRemoteBridge` 是组件唯一依赖；`getPsbRemoteBridge()` 在缺失时抛错（供用户显式动作报错），
  `tryGetPsbRemoteBridge()` 返回 `null`（供只读渲染与单测）。组件不得各自解构
  `window.electronAPI.psbRemote`。
- **不得经 IPC 暴露身份凭据**：`PsbRemoteStatus` 只给 `ready` / `reasonKey` / `host` / `testHost`；
  token、`orgSlug`、`membershipId` 一概不出 main。渲染层能看到的身份事实只有「连的是哪个部署」。

## 5. 串流观看端链路

Cindy 是 PSB 会话串流的**第二个观看端实现**（浏览器是第一个），复用同一套帧协议，不自造流格式。

- **连接**：main 在 [streamViewer.ts](../../apps/desktop/src/main/remote-workspace/streamViewer.ts) 里用
  Bearer 打开 `wss://<PSB>/api/cindy/remote/sessions/<sessionId>/stream?subscriberId=<UUIDv4>`；
  上行是二进制 H.264 帧，**帧头 4 字节**：`type(1) + flags(1) + seq(2, BE)`，其后是 payload；`type`
  `1`=video、`2`=config（解码器配置），`flags` bit0=关键帧，`seq` 只用于诊断、不据此丢帧。
  下行（本端 → PSB）**只有** `{kind:'input', event}`（见 §12）：订阅/退订靠 WS 升级与断开，
  不发 `{kind:'open'}` / `{kind:'close'}`。`subscriberId` 的生成与复用规则见 §12.3。
  > PSB 仓契约的叙述里出现过「5 字节帧头」的说法，但同一份文档的字段分解是 1+1+2=4；Cindy
  > 实现按 **4 字节**信封（`features/remote-workspace/stream/psbStreamFrame.ts`，与 PSB C 通道
  > 那条「帧多 1 字节 tag」不是同一条链路）。**该口径已由真机首帧与 PSB 中继日志逐字节对齐**
  > （帧头 `01 00 02 44`，见产品规则 §8.2）；5 字节那套是客户端上行 C 通道，在中继侧剥 tag 后
  > 才给观看端，不要按 5 字节改客户端。
- **启动 / 停止由 WS 驱动**：PSB 不提供独立 HTTP 动作；`stream/status` 只服务「详情」与按钮可用性
  （能力位、当前是否采集、分辨率/帧率/编码、最近错误）。UI 只暴露启动 / 停止 / 详情，**不提供可调
  编解码参数**（详情与 HUD 只显示 PSB 下发的编码 / 解码器名称作诊断，不摆码率 / 预设开关）。
- **重启 / 替换观看端：预检通过后原子替换（2026-11-26 复审）**：`streamViewer.startInternal` 顺序是
  「读 `stream/status` 能力位 → 取 token → 取出站 agent → 建新 WS 并等握手成功 → 才替换旧连接」；
  预检或握手任一步失败时**旧连接原样保留**（画面不中断），不再出现「重启时 PSB 抖一下 → 从有画面
  掉到空面板」（见 §15.4）。
- **帧投递与解码**：main 把帧转成 `PsbStreamEvent { type:'frame', payload: ArrayBuffer }` 推给
  渲染层，状态、错误与宿主光标分别走 `status` / `closed` / `error` / `cursor`（`cursor` 来自
  `stream.cursor` 文本帧，见 §12.9）；渲染层**push 式**播放器解析信封后
  维护 `VideoDecoder` 并画到 canvas（不复用 `liveScreenStream` 的拉循环，只复用它的 avcC→codec
  推导与「解码器报错就重建、只从关键帧起喂」策略）。
- **载荷两种形态都接受**：契约没有逐字节固定采集端输出，所以 `config` 可能是 avcC 记录
  （首字节 1）或 Annex-B 的 SPS/PPS（现场拼 avcC），`video` 可能是 Annex-B（转 AVCC 与
  `description` 配套）。这套转换必须是可单测纯函数；解不出来时按「画面不可用」呈现，不静默
  显示黑屏。
- **观看状态刷新**：会话页读取会话 + 工作区快照（进入页面读一次、窗口重新聚焦补读、后台 30s
  一次、页面隐藏不发请求；同一时刻最多一个在途请求，迟到结果丢弃）。**会话进入终态后不停止
  轮询**：终态后用户下一次发送会触发透明重建并换会话 id，重绑推送之外还要靠轮询这条第二条
  发现路径跟上（推送丢失、页面长时间停在同一任务上时不僵住）；读取失败保留最后一次快照
  （从未读到过时不拿网络抖动锁死输入，读到过则保持禁用，避免「PSB 断了反而放开写」）。
  **「远程工作区」页签不再共用这份会话级快照**：它读工作区级
  `adminContext`（见 `shared/psb-workspace-admin.ts`），页面不因任务终态退化；启动 / 停止 /
  详情按 `workspaceId` 工作。
- **名额与泄漏**：PSB 的观看名额与**浏览器页面共用**，默认 4（部署级 `PSB_STREAM_MAX_SUBSCRIBERS`；
  2026-11-26 PSB 0.1.170 口径），中继按 `subscriberId` 认人。关闭面板、切换会话、
  退出登录都必须**断开 WS**（断开即退订；不要发 `{kind:'close'}`，见 §12.1），否则名额不释放，
  表现是「别人（包括自己另一个窗口）连不上」。`subscriberId` 是**客户端生成的 UUIDv4，一个观看端
  一个**，重连复用同一值（同 id 替换旧订阅、不占新名额；PSB 0.1.170 契约，生成点见 §12.3）。
  main 侧释放点：管理页 `adminStreamStop`（多窗口按 owner 引用计数，**归零才真的停**）、账号边界
  `disposePsbRemoteService()`、窗口销毁（该窗口 owner -1，归零停流）；管理页重复启动发现已有健康
  观看连接（绑定上的 `viewerActive`）时**复用**：不重连、不产生 `superseded`，只多一个 owner
  （观看端自身的同会话原子替换语义仍在，见 §15.3）。**本端主动关闭按原因区分并补发 `closed`**：
  用户停止 → `closed(client-stopped)`；被新连接替换 → `closed(superseded)`，两者只发给该
  `viewerSessionId` 的 owner。`client-stopped` 让渲染层清屏回未启动态；`superseded` **不是终态**：
  新连接继续向同一个 `sessionId` 送帧，渲染层保留相位、不清屏、不提示，也不释放 owner。
  `dispose` 与握手失败没有可报的界面，不推。远端关闭仍推，`reason` 是稳定 token
  （`closed` / `session-ended` / `session-not-found` / `client-offline` / `replaced` / `superseded` /
  `client-stopped` / `not-ready` / `slow-subscriber` / `no-stream` / `socket-unwritable` /
  `channel-lost` / `quota` / `control-conflict` / `control-lost` / `ws-<code>`，由
  `psbStreamClosedReason` 产出）；
  `control-conflict` / `control-lost` 是**协议保留、产品不再使用**（0.1.172 已取消单控制者仲裁，
  只有协商 `errors=frame` 的旧路径可能收到；Cindy 未启用），`ws-<code>` 只在未知关闭码时兜底。
  main 不写中文句子。
- **关闭归因：4004 有两种含义（2026-11-26 修正）**。PSB 的「没有可观看画面」（notReady）与串流中继的
  「慢订阅者被断开」都用 `4004`，PSB 明确要求 Cindy 按「是否收到过二进制帧」+ close `reason` 文本区分
  （PSB 仓 `docs/remote-workspace.md` §11.10「已知语义重叠」）。归因唯一入口是 `streamViewer.ts` 的
  `classifyStreamClose`（token 由 `psbStreamClosedReason(code, context)` 映射）：

  | 4004 情形 | 归因 token | 依据 |
  | --- | --- | --- |
  | close reason 以 `{"reasonCode":…,"desktopSession":…}\|` 开头（PSB notReady） | `not-ready` | 结构前缀优先于帧数：PSB 只给 notReady 加前缀 |
  | 该连接**从未收到二进制帧**、且没有结构前缀 | `not-ready` | 一帧都没有 = 从来没出过画面，不可能触发中继的慢订阅者断开 |
  | **收到过帧之后**、且没有结构前缀（中继自己的 4004） | `slow-subscriber` | 只有已收帧、缓冲持续超阈值的路径才会出现 |

  `closed` 事件同时带 `detail`（`PsbStreamCloseDetail`）：`reasonCode` / `desktopSession`（来自结构前缀，
  没有则 `null`）与 `messageZh`（PSB 的中文原话，已去掉 JSON 前缀；没有前缀时是整段 reason）。
  握手阶段的 4004 也走同一份解析，失败的 `message` 只放 `|` 之后的人话，不把 JSON 前缀塞进错误条。
  渲染层按 token / `reasonCode` 选文案，**不解析中文**；`messageZh` 只作兜底显示，不从中反推机器状态。
- **`stream/status` 的加性字段**：`reasonCode` / `desktopSession` 由 `parsePsbSessionStreamStatus` 透传；
  旧服务端缺字段时解析成 `null`（= 未知），**不**猜 `'none'`——`desktopSession:'none'` 是「确定没有桌面
  会话」，与「不知道」是两件事。`reasonCode:null` 同样既可能是「没有阻塞性问题」也可能是旧服务端没给，
  需要区分时看 `desktopSession`。
- **4008 = 心跳超时**（2026-11-26 审查补归因）：中继判定观看端失联后用它关闭。稳定 token 是
  `heartbeat-timeout`（不再落成裸 `ws-4008`）；它不同于 `slow-subscriber`，用户可行动的是重新
  「启动」观看（会话本身通常还在），面板仍优先显示 PSB 给的 `detail.messageZh`。
- **二进制帧有大小上限**：`PSB_STREAM_MAX_BINARY_FRAME_BYTES` = 16 MiB。PSB 的 H.264 帧远小于它，
  超限帧**丢弃并只告警一次**（不关闭连接、不占坏名额）；该帧仍计入 `receivedBinaryFrames`（它确实
  来自这条流，不能把「坏帧流」归因成「从没出过画面」）。HTTP 响应同样有
  `PSB_HTTP_MAX_RESPONSE_BYTES` = 4 MiB 上限，超限按 `PSB_PROTOCOL` 失败（不是网络失败、不重试）。
- **入口判据与页签落点**：只有 `psb:` 会话在会话标题行显示「远程工作区」入口（标题行「…」之后的
  文字按钮）；`mcpr:`、SSH 与本地会话没有这个入口（判据在
  `features/remote-workspace/stream/psbStreamSession.ts`，不要用「有 remoteHostId」判断）。页签
  本身是全局工作区级页面，右侧栏「+」菜单在任意任务下也能直接打开；页面对象由 main 的
  `adminContext` 解析（当前任务 psb 会话任何状态 → 最近使用工作区），所以切到本地任务页时
  页签内容不退化成提示态。
  页签是实现事实，三条都不能漂移：
  1. **全局单例**：kind `remote-workspace-admin`、固定 id `g_remote-workspace-admin`，存放在
     `features/right-sidebar/globalTabs.ts`（与插件页签同一份 localStorage），**不进**按任务分桶的
     `store.ts`；关闭不需要 `onBeforeClose`，观看名额由页面卸载清理释放。
  2. **与插件页签同一排**：落点先收敛为 `targetGroup`——调用方给出**显式落点**（「+」菜单 / 空
     面板那排标签栏把所在组传成 `targetGroup`）就用它；否则按
     `preferredRemoteWorkspaceAdminGroup()`（跟随第一个插件全局页签所在的页签组；没有插件页签时
     用停靠面板插件的缺省边 `left`），已有页签的显式放置记忆优先。**组只写一次**：
     `addRemoteWorkspaceAdminTab({groupId})` 是唯一写组处（新页签先落组再持久化，已有页签按同一
     入口按需挪组），调用方**不得**返回后再 `setTabGroup` 覆盖——那样 dock 展开判定会按旧组执行
     （在左排点「+」却弹出右侧 dock）。边组的 pane 由 `tabGroupPanes.ts` 的「组里有可见页签 →
     `ensurePaneInTree`」自动插入，**不要**为它调用 `requestRightSidebarVisibility('open')`；只有
     最终落进 `right` 组（可折叠的右侧 dock）时才请求展开。没有显式落点时已存在的页签只聚焦、
     不搬回默认组（用户拖走的放置记忆优先）；用户没显式放置过（`tabGroups` 无条目）的旧页签在
     下一次打开时迁到插件组。
  3. **内容是工作区级管理页**：`TabBody` = `RemoteWorkspaceAdminPanel`，页面对象由 main
     `adminContext` 解析（当前任务 psb 会话任何状态 → 最近使用工作区），观看端按工作区绑定启动 /
     停止，页面卸载时释放名额；页签 state 恒为空、不落任何会话 id —— 页签不跟随「打开它时的
     会话」，也不按 PSB 会话 id 做 React key。
- **输入**：**可交互观看**（2026-11-26 用户口径，替换旧的「只读观看」）：渲染层把指针 / 键盘 /
  滚轮采集成本地事件，经**工作区级** `psb-remote:admin-stream-input` 交给 main，main 解析出观看端
  绑定会话后用`{kind:'input', event}` 写进同一条观看端 WS。鉴权与「谁能输入」由 **PSB 服务端权限模型**
  （0.1.172）判定：工作区被占用 → 占用人可控制，未被占用 → 已登录用户可控制，其它情况服务端只丢弃
  输入、画面照旧；Cindy 不做客户端互斥，也不发 `role` / `takeover`。协商 `errors=frame` 时服务端会
  先发 `stream.control` 拒绝帧，Cindy 当前未启用该协商。全屏时宿主快捷键由 main 抑制，详见 §12。
- **弱网**：解码队列积压时丢掉后续 delta 帧、等下一个关键帧重来，而不是无限排队；不做无人值守的
  长时间后台拉流，面板不可见时应停止。

## 6. 恢复语义与故障半径

改动恢复路径前必须回答 [远程与手机适配](remote-and-mobile-adaptation.md) 的「故障半径三问」，
本 transport 的答案：

1. **PSB 不可达只影响远程工作区**：列表读不到、会话不能新建、已有会话隧道失败；本机任务、
   `mcpr:` 会话与 SSH 会话不受影响（分类器保证它们不共用这条路径）。不得因为 PSB 掉线把别的
   远程目标一起标成不可用。
2. **写操作不自动重试**：占用 / 释放 / 新建工作区 / 建会话 / 停止会话都只有一次，失败交给用户
   决定；唯一自动重试是 401 后重签一次。避免「重试把占用抢回来又冲突」这类不可解释状态。
3. **局部禁用而不是全局失败**：一个工作区被占用或离线只禁用该会话的输入与新建会话入口，不清空
   其它工作区的列表、不影响其它会话。刷新是幂等的只读动作，可重复。

### 6.1 发送前透明重建（终态不等于「任务结束」）

PSB 的 agent 会话终态（`stopped` / `failed`）**永不逆转**，但这不等于用户的任务结束：本地任务
行、消息历史、工作区都还在。因此 Cindy 把「远端会话落定」处理成**一次透明的重建**，而不是
永久禁止输入（修复前：输入框锁死 +「这个任务已经结束。」，与本地任务「runtime 停了还能继续
发消息」的行为不一致，用户明确要求对齐）。

**触发条件（三条同时成立）**

1. 本地会话行 `remoteHostId` 是 `psb:<id>`（唯一依据，`parsePsbRemoteHostId`）；
2. 当前**没有回合在跑**（`maker.getSession(id)?.isTurnRunning()`，在跑就绝不换隧道）；
3. 该 PSB 会话已终态，**或** PSB 说它不存在（404/403）。**`status: null`（未知枚举 / 缺字段）不算
   终态、不触发重建**——把「读不到」当终态会在 PSB 抖动时无谓地换掉一条健康会话。

**链路（唯一入口，不要只补某一条 UI 路径）**

`main/maker-ipc/makerSendTransaction.ts` 的 `sendToAgentAccepted` 在解析 runtime 之前调用可选
dep `preparePsbRemoteRebind`（位置：`applyPendingAgentSwitch` 之后、`prepareUnhealthySession`
之前）。renderer 直发、队列 drain、device-link / 手机输入全部经过这个事务，所以一条改动覆盖
所有发送入口。**只有调用方带了 `createOpts` 才尝试**：新身份必须能经 `createOpts` 进入
lazy-create，否则重建完也没有入口交给 runtime。

决策与幂等在 `main/remote-workspace/sessionRebind.ts`（`createPsbSessionRebindCoordinator`，
纯注入、可单测）；主进程副作用集中在 `main/maker-ipc/register.ts` 的接线：

1. 读旧 PSB 会话（`sessionStatus`）→ 拿它自己的 `workspaceId`、状态与工作区快照；
2. 工作区可开新会话 → `createSession({ workspaceId, agentKind, title, clientRequestId })`。
   `clientRequestId` 由 `deriveRebindRequestId(localSessionId, previousPsbSessionId)` **确定性派生**
   （`psb-rebind-<sha256 前 32 hex>`）：同一旧身份的重试 / 崩溃恢复复用同一个键，PSB 只建一条会话，
   不再每次 `randomUUID()`（见 §15.9）；
3. **先落库（一次事务，含上下文交接）**：`session.remoteRebind` 事务把
   `UPDATE sessions SET remote_host_id='psb:<新>', sdk_session_id=NULL`（CAS：
   `WHERE ifnull(remote_host_id,'') = ifnull(<旧>,'') AND status != 'deleted'`）与一条隐藏
   `context_rebuild` 交接标记**一起提交**（`contextRebuildPersistence.ts` →
   `commitRemoteSessionRebindWithPorts`，`reason='remote-session-rebind'`）。成功后
   `createSessionRemoteHostIdReader.invalidate()` 失效进程内缓存、失效旧 PSB 会话的状态快照，
   再 `broadcastSessionPatched({ remoteHostId })`；CAS 冲突时整单不写（不插标记），按库里现值继续；
4. 推送 `psb-remote:sessions-rebound`（payload：`{localSessionId, previousRemoteHostId,
   remoteHostId}`，落库之后才发）；
5. 事务关掉仍持旧身份的空闲 runtime（`closeSessionIfCurrent`，与 workdir 漂移回收同口径），
   把 `createOpts.remoteHostId` 改成新身份，**继续这一轮发送**（用户不需要重试）。
6. 交接注入：下次（含本轮）发送时 `agentHandoffPending.peek` 按隐藏标记取回交接文本，前置到
   wire user 消息（`buildHandoffText` 的 `reason` 同名字面量），accepted 后持久标记消费。

「只清 `sdk_session_id` 不写交接」是**静默错误**（界面看起来重连成功、模型已经失忆，审查 r7
P1），所以身份与交接必须是同一个事务；这也是不把两步拆成两次写的原因。

`psbSessionInputAllowed()` 因此不再把终态当成阻断：真正阻断只剩被他人占用 / 客户端离线 /
工作区未就绪（这三种发送时也无法恢复）。「这条会话下次发送会不会重建」用
`psbSessionNeedsRebind(status)` 单独问（渲染层提示与 main 决策同一判据）。

**工作区身份的来源（以及为什么不加列）**

旧 PSB 会话行自己的 `workspaceId` 就是权威来源，**重启后同样成立**——终态会话记录在 PSB 仍然
可读。本地**不新增 `sessions` 列**：`apps/desktop/src/main/devCliFlags.ts`（`CindyMeka` 是正式
profile）+ `apps/desktop/src/main/index.ts` 的 `XDT_OFFICIAL_SHARED_PROFILE` +
`localDb/migrate.ts` 的 `shouldRefuseOfficialProfileWriterMigration` 决定「非打包 + 正式 profile +
存在 pending migration ⇒ 启动直接拒绝迁移」。在共享 profile 上验证用户报的那个场景必须能重启
dev 实例，所以本功能不引入 migration。`sessionRebind.ts` 的 `PsbSessionRebindRow.workspaceId`
类型如实为 **`null`**（本地没有这一列，工作区 id 的唯一来源是旧 PSB 会话行）；若将来 PSB 会单独
删除终态会话行而工作区仍在，再追加列 + 发版协调。

**失败语义（全部：不重绑、本地行与 runtime 保持原状、下一次发送可重试、不广播事件）**

| 情况 | 上抛的失败码 |
| --- | --- |
| 工作区被**别人**占用 | `PSB_WORKSPACE_OCCUPIED_BY_OTHER`（message = 占用人名） |
| 远端客户端离线 | `PSB_CLIENT_OFFLINE` |
| 工作区未就绪（`planned` / `provisioning` / `failed` / `deleting`） | `PSB_WORKSPACE_NOT_READY` |
| 客户端没有该引擎的运行时 | `PSB_AGENT_UNSUPPORTED`（来自 `psbWorkspaceWritable` 的 `agent-unsupported`） |
| 旧会话读不到且没有工作区线索 / 工作区不可见 | `PSB_NOT_FOUND`（**不猜工作区**） |
| 新建失败 / PSB 不可达 / 鉴权失败 | 对应的 `PSB_*` 码 |
| 落库失败 | `INTERNAL`（并尽力 `stopSession` 回收刚建出来的 PSB 会话） |

可写判据统一走 `psbWorkspaceWritable(workspace, { requireAgentRuntime: true })`（与占用闸门、
渲染层禁用态同一份判据，见 §15.10）；main **只给码**、不拼中文兜底句子，文案在 i18n（§15.9）。

**幂等与并发**：同一个本地会话 id 的重建串行化（进程内 in-flight map），并发两次发送只建
**一条** PSB 会话、两边拿到同一新身份；重建失败立刻从 map 移除，所以失败后的下一条消息会
重新尝试。落库用 CAS：期间别的一方改过这一行时回收自己建的那条，按库里的现值继续。

**发送前状态读取：重建走快照 store，占用闸门走权威读（2026-11-27 用户复测收口）**

发送前的两项判定读口不同，不要混用：

- **要不要重建**（`preparePsbRemoteRebind`）读 `maker-host/psb-session-status.ts` 的**进程内会话
  快照**，不再每条消息各打一次 `sessionStatus`（`GET` + 全量 list）：
  - `PSB_SESSION_STATUS_TTL_MS = 10_000` 内复用；`maxAgeMs: 0` 强制刷新（重建决策前）；
  - 事件失效：重绑（旧 PSB 会话）、`stopSession`、归档 / 删除释放、应用退出都 `invalidate` /
    `record`，隧道报出终态码时 `psb-agent-tunnel` 也失效；
  - **读不到 fail-open**：网络 / 鉴权 / 协议错**不是判定结果**——本轮继续发送、不重绑；真正
    的终态由建隧道时的 `[PSB_SESSION_STOPPED]` 等可行动失败报出。失败时若还有旧快照一并交回
    （`stale`），让调用方能按最近一次事实继续；
  - 「明确不存在」（404/403）才是权威事实：清掉快照并按 `missing` 返回（重建触发条件）。
  `maker-ipc/register.ts` 的 `preparePsbRemoteRebind` 先查快照：活的直接放行（常见路径零额外
  请求），终态 / 不存在才进协调器。
- **工作区占用闸门**（`preparePsbWorkspaceLock`）**不再读这份快照**，也**不再 fail-open**：
  **每条消息发送前**都按 `ensureWorkspaceLockedForSession(psbSessionId, { requireAuthoritative: true })`
  读一次 PSB 会话行 + 工作区事实再判定（见 §13.2 / §13.3）。用户口径（2026-11-27 人工复测）：
  会话创建后工作区可能被交接给别人，发送前必须确认「此刻仍由我占用」，10s 快照 / 1.5s 缓存
  都不算证据；读不到就是「无法确认」，本轮不发送。

**已知边界**：重绑后远端原生上下文不延续（新 PSB 会话是全新引擎会话，本地消息历史完整）——
所以落库时清 `sdk_session_id`，**并**同事务写入交接标记；否则新会话会去 resume 一个不存在的
原生会话而拒绝启动（只清不交则是模型失忆）。

## 7. 合并防回归清单

同步 `origin/main` 进 `meka/main`，或在这一块加功能后，逐项核对：

1. `classifyRemoteSessionTransport` 仍是 `psb:` → `mcpr:` → `ssh` 的顺序判断，**`psb:` 不得落
   ssh 默认分支**；渲染层镜像判据同一次改；`remoteCodexModelHost.test.ts` 的输入矩阵包含
   `psb:` 输入。
2. `maker-host` 的每个远端钩子（transport、file-ops、技能源读取、探针等）都按 transport 分派，
   `psb:` 走 PSB 隧道实现；不得新增第三处 `startsWith('mcpr:')` 式的一次性判断。
3. `maker-ipc/register.ts` 的远端启动前置对 `psb:` 早返回（必须早于 `ensureRemoteHostReady`）；
   turn-settled 的远端 Codex MCP 刷新跳过 `psb:`。
4. 渲染层 SSH-only 动作（远端 Codex 清单探针、草稿 SSH Codex 目录、「同步 Codex 登录」按钮）
   对 `psb:` 一律不触发：模型面用**本机目录**，不走远端探测（同 MCPR 口径）。
5. IPC / preload / 类型三处同步：共享通道常量、`preload` 的 `psbRemote` 组、`vite-env.d.ts` 的
   `ElectronAPI` 声明；组件不绕过 `PsbRemoteBridge`。
6. 端点解析只有一份：复用 `CINDY_MEKA_PSB_HOST` 的启动期白名单解析（见
   [插件安全与作者契约](plugin-security-and-authoring.md) §4.4），**不新增第二个开关**；
   HTTP / 两条 WS / 网页跳转一起改道；不做 `http`/`ws` 降级。
7. 隧道参数：`mode` 白名单、`bundleVersion` 只在 `cc-mgr` / `codex-appserver` 且取自 pin 常量；
   关闭码与握手状态映射保持可归因。
8. 隧道退休：所有创建点经 `remoteTransportRegistry` 登记，退休释放走 `releaseRemoteTransport`。
9. 跨仓形状改动（路径、DTO、状态词、错误码）先改 PSB 仓 `协作需求.md` 并由 PSB 确认，再改客户端；
   本仓不得静默改形状——否则联调时才撞上。
10. 上游同步后按 [Meka 能力白名单与验证清单](meka-whitelist-verification.md) 的 WL-30 做语义验收；
    结构审计抓不到「代码都在、语义被覆盖」。

## 8. 验证方式

- 类型：`pnpm --filter desktop run typecheck`（品牌类型让裸 `remoteHostId` 喂 SSH-only 入口编译不过）。
- 单文件复现：在仓库根执行
  `pnpm --filter desktop exec vitest run src/main/remote-workspace/__tests__/psbTunnel.test.ts`
  （`<path>` 用 `apps/desktop` 内的相对路径；产品规则 §8.2 引用的「可复现命令」同此口径）。
- 定向单测（改动后先跑，交付时统一跑 `pnpm test:unit:related`）：
  - `remote-session-routing.test.ts`、`remoteCodexModelHost.test.ts`、`remoteTransportProbeWiring.guard.test.ts`
    的 `psb:` 矩阵与接线守卫；
  - 隧道装配：`psbTunnelWiring.test.ts`（`buildPsbTunnelUrl` 的 mode / `bundleVersion` 参数白名单、
    session id 编码、分派不回落 SSH）、`psbAgentTunnel.test.ts`（token 映射、只交 reasonKey、
    `[PSB_TUNNEL_AUTH]` 时失效 JWT 缓存）；
  - Codex 控制面：`mcprCodexCapability.test.ts` 的 PSB 用例（header 无 `cwd`、
    `[PSB_CAPABILITY_UNAVAILABLE]` fail-closed）；
  - PSB 客户端、鉴权、端点与串流的定向单测（`apps/desktop/src/main/remote-workspace/__tests__/`、
    `renderer/features/remote-workspace/**/__tests__/` 与共享契约的纯函数用例）；
  - 发送前透明重建：`main/remote-workspace/__tests__/sessionRebind.test.ts`（决策矩阵：终态/404
    才重建、跑回合中不重建、并发只建一条、占用/离线/未就绪不重建、失败可重试、落库失败回收）+
    `main/maker-ipc/__tests__/makerSendTransaction.test.ts` 的 rebind 接线用例 +
    `main/localDb/ipc/__tests__/sessionRemoteHostIdReader.test.ts` 的缓存失效用例；
  - 发送前占用闸门（**每条消息权威校验**，2026-11-27）：`main/remote-workspace/__tests__/workspaceLock.test.ts`
    （TTL 路径 vs `requireAuthoritative`、缓存失效、**空闲 → `occupy-required` 且 0 次占用请求**、
    显式 `allowAutoOccupy:true` 才占用、读失败抛出）+
    `makerSendTransaction.test.ts` 的闸门接线用例（连续两条各校验一次、失败不派发不落库）+
    `renderer/features/remote-workspace/__tests__/occupyRequired.test.ts`（确认 + 显式占用 + 重试的
    唯一实现）+ `remoteErrorDecode.test.ts` / `RemoteWorkspaceAdminPanel.test.tsx` /
    `psbDraftSession.test.ts` 的「确认后重试同一次动作、取消不占用」三条入口用例 +
    `renderer/__tests__/makerChatStorePsbSendPreflight.test.ts`（发送前预检：取消零发送 /
    occupy→send 顺序 / byMe 直接发 / 他人占用·离线的可行动提示 / 读取失败 fail-open /
    预检占用后竞态不重复确认 / 队列恢复与重试同样预检 / 非 psb 零 PSB 请求，见 §13.6.1）+
  - IPC 面接线守卫（preload ↔ handler ↔ bridge 三处一致）。
- 纯文档改动：`pnpm check:dev-docs`。
- 实机联调顺序（PSB 侧同样要求逐段留证据，见 PSB 仓 `协作需求.md` §3A.5）：**测试部署** →
  列表 / 客户端 / 模板 → 占用与释放 → 建会话（网页会话页签可见）→ `mode=exec` → `pi` →
  `cc-mgr` → `codex-appserver` → 串流首帧与停止。测试部署已按此顺序走完（结论与未验证项见
  产品规则 §8.2 与 §10–§12）；**正式部署**的只读链路 + 一次隧道握手仍未复测。

## 9. 本轮收口记录（2026-11-25，实现事实）

### 9.1 main 进程文件清单与职责

| 文件 | 职责 | 边界 |
| --- | --- | --- |
| `main/remote-workspace/psbEndpoint.ts` | 站点根解析（正式 / `CINDY_MEKA_PSB_HOST` 测试覆盖）、**出网 URL 唯一归一化判据 `resolvePsbUrl`**（HTTP + 两条 WS）、`webUrl` 归一到当前站点 | 只回答地址，不取凭据、不发请求 |
| `main/remote-workspace/psbAuth.ts` | 宿主直签 Connection JWT：`getAuthState()` → `<orgSlug>:<slug>` → `ConnectionTokenProvider` | token 只在 main 内存，不进 IPC / 日志 / 渲染层 |
| `main/remote-workspace/psbClient.ts` | HTTP 客户端（契约 §5）、错误映射、401 只重签一次；`createSession` **先读工作区再建会话**（不产生孤儿会话）、`getSession` / `ensureForSession` 各 **2 次 HTTP**（会话行 + 列表）、列表缺键判协议错、`accessPoll` 是总 deadline | 唯一 HTTP 出口 |
| `main/remote-workspace/psbTunnel.ts` | agent-tunnel（与 MCPR 同帧契约）、ready 帧**进程级能力探测**、就绪期字节回放、`PsbTunnelError` 结构化失败、`agentForUrl` 注入系统代理 | 不解析身份、不自己取 token |
| `main/remote-workspace/wsFrames.ts` | 两条 WS 共用的字节搬运（`toBuffer` / `toArrayBuffer` / `createExecByteStream`）与就绪前 1 MiB 有界排队 | 纯结构，不碰 Electron |
| `main/remote-workspace/streamViewer.ts` | 串流观看端：`wss` + Bearer、帧原样转 `ArrayBuffer`、预检后**原子替换**（失败保留旧连接）、本端主动关闭补发 `closed(superseded/client-stopped)`（只发给该观看连接的 owner，`superseded` 在渲染层非终态） | 帧不做任何解析（解码在渲染层） |
| `main/remote-workspace/streamOwners.ts` | 管理页观看端 **owner 引用计数**（`workspaceId → Set<webContentsId>`；归零才停流、按 owner 定向帧与本端主动关闭事件） | 纯结构，可单测 |
| `main/remote-workspace/index.ts` | 服务单例装配（注入 auth/token/出网/推送/日志）、mutation 后推送工作区快照 | 登录边界 dispose（退出登录断流） |
| `main/remote-workspace/ipc.ts` | 23 个 invoke handler（17 个会话级 + 6 个管理页，与 §4 的通道数一致）、来源校验、payload 校验、失败 `PSB_*` 码；管理页 start/stop 记账到 `streamOwners`、`starting` 相位停止标记（`adminStreamReleasePending`） | handler 每次现取单例（dispose 后自动重建） |
| `main/remote-workspace/vcsNotice.ts` | VCS action **固定目标表**（kind → path/method，不采信服务端 method/path）+ 服务端形状校验 + ≤32 LRU 通知缓存 | 不自己跑 VCS、不猜清理轮询端点 |
| `main/remote-workspace/adminService.ts` | **工作区级管理页**：工作区解析、工作区级 `stream/subscribe` 拿桌面访问会话并建立观看端绑定、重复启动复用 / 失效重订阅、串流订阅与 `STREAM_EVENT` 过滤、`CONTEXT_CHANGED` 判定。**串流不创建 Agent 会话**；旧 PSB 的过渡回退见 §11.7 | 不 import Electron/DB/真实 PSB 客户端；副作用全走注入端口（见 §11） |
| `main/remote-workspace/adminRecentStore.ts` | 最近使用的远程工作区 + `PSB 会话→工作区`映射 + `工作区→观看端绑定会话`（JSON 键 `desktopSessions`；有上限、幂等写） | 可丢的展示偏好，不写 DB、不新增 schema |
| `main/remote-workspace/adminRuntime.ts` | 管理页服务的生产装配（PSB 服务单例、localDb 会话行懒读、本机记录文件、两条推送） | 宿主依赖只在这里出现 |
| `main/remote-workspace/push.ts` | `WORKSPACE_CHANGED` / `WORKSPACE_VCS_NOTICE` / `SESSIONS_REBOUND` / `ADMIN_CONTEXT_CHANGED` / `ADMIN_STREAM_EVENT` 广播（只发受信窗口；`ADMIN_STREAM_EVENT` 的帧 / 光标 / 本端主动关闭按观看端 owner 定向，`status` / `error` 广播） | 出站推送同样是授权边界 |
| `main/remote-workspace/sessionRebind.ts` | 发送前透明重建的决策与幂等（终态/404 判定、同工作区新建、CAS 落库、并发去重） | 不 import Electron/DB/PSB：副作用全走注入（见 §6.1） |
| `main/maker-host/psb-session-status.ts` | 发送前 PSB 会话状态快照：10s TTL + 事件失效（重绑 / 停止 / 隧道终态 / 归档释放）+ 并发共享单次读取 + **读不到 fail-open**（交回 stale 快照，不判终态） | 进程内存、不落盘、不含凭据；读口由 `maker-ipc/register.ts` 注入，**只服务发送前重建**（占用闸门 2026-11-27 起改走权威读，不读这份快照） |
| `main/maker-host/psb-workspace-session-release.ts` | 会话结束（归档 / 删除 / 退出应用）释放 PSB 工作区占用：main **单权威**（终态 observer 触发）、幂等、同工作区还有活动任务则跳过且不入账（`workspace-in-use`）、失败进有界账本（带 `workspaceId`，重试不依赖会话行）可重试、不阻断主流程 | 只对 `psb:` 生效；dataOwner 边界（切号不替旧账号归还）；渲染层提示条消费同一账本，不另记一份 |
| `main/maker-host/psb-agent-tunnel.ts` | 三种 Harness 共用的**唯一**取 token 处 → 交给数据面 | 不在 transport 层解析登录态 |
| `main/maker-host/remote-tunnel-dispatch.ts` | `mcpr:` → `openMcprTunnel`、`psb:` → `openPsbAgentTunnel` 的唯一分派 | 本地 / SSH 到这里是编程错误，不回落 SSH pool |

### 9.2 失败码跨 IPC（新增约定）

IPC 只保留 message，所以 PSB 的语义码用**命名空间化**的 `PSB_*` 码传递：
`shared/ipc-errors.ts` 现有 **21 码**（`PSB_AUTH_REQUIRED` / `PSB_ORG_REQUIRED` /
`PSB_AUTH_EXPIRED` / `PSB_IDENTITY_NOT_LINKED` / `PSB_WORKSPACE_OCCUPIED_BY_OTHER` /
`PSB_CLIENT_OFFLINE` / `PSB_WORKSPACE_NOT_READY`（发送时重建才用到，见 §6.1）/
`PSB_AGENT_UNSUPPORTED`（远端客户端无该引擎运行时）/ 管理页 stale 三条
`PSB_WORKSPACE_MISSING` / `PSB_WORKSPACE_UNREACHABLE` / `PSB_WORKSPACE_ID_UNKNOWN`（见 §11.2）/
`PSB_WORKSPACE_VCS_DIRTY` / `PSB_WORKSPACE_VCS_UNAVAILABLE` / `PSB_WORKSPACE_VCS_UNSUPPORTED`
（占用 / 释放的版本控制检查，见 §13.5）/ `PSB_NOT_FOUND` / `PSB_UNREACHABLE` /
`PSB_STREAM_UNAVAILABLE` / `PSB_STREAM_NOT_ACTIVE`（本机没有活动观看，见 §12.2）/
`PSB_STREAM_NO_RUNNING_SESSION` / `PSB_STREAM_ACCESS_STARTING` / `PSB_STREAM_ACCESS_STOPPING`
（没有 running 桌面访问的三档，见 §11.8）），
**单表派生**：`IPC_ERROR_CODES` 是唯一手写处，`IpcErrorCode = keyof` 与 `isIpcErrorCode` 都查同一张表，
不再保留第二份 union/Set 清单。PSB 失败码到文案 / 下一步的映射也收敛成**一张表**
（`shared/psb-remote-workspace.ts` 的 `PSB_FAILURE_DESCRIPTORS`，**21 行** = `ipc-errors.ts` 里 21 个
`PSB_*` 码各一行；字段 `psbCode` / `noticeCode` / `messageKey` / `state` / `nextStep`，可选
`alsoPsbCodes`（历史别名）/ `whenMessageKey`（`AUTH_REQUIRED` 的「组织账号 vs 未登录」鉴别）/
`writableReason` / `inputMessageKey` / `occupantName`）。可写判据、IPC 码、文案键、通知码、PSB 原始码
与串流访问分档**全是它的投影**：`PSB_IPC_FAILURE_MESSAGE_KEYS`（保留旧名，由
`Object.fromEntries(单表)` 生成，不再是手写清单）、`PSB_WORKSPACE_WRITABLE_FAILURES`、
`PSB_NO_RUNNING_SESSION_IPC_CODES` 与 `psbIpcCodeForFailure` 的反查；PSB 原始码反查是
`psbFailureDescriptorForPsbCode` / `psbFailureMessageKeyForPsbCode`（main 与常驻提示条把 main
账本里的 PSB 原始 `failureCode` 归一成文案键用它，不在渲染层另抄码表）。不面向用户的本地诊断码
（`PSB_PROTOCOL` / `PSB_UNKNOWN` / `PSB_AUTH_LOOP`，见 `PSB_LOCAL_DIAGNOSTIC_CODES`）刻意不入表，
只进日志与 `INTERNAL`。新增一类失败只在单表加一行、再到 `ipc-errors.ts` 登记该 IPC 码，
**不要**在别处手抄第二份映射。
**DTO 收敛**：`PsbWorkspaceAdminStreamStatus` 是 `PsbSessionStreamStatus` 的**纯别名**（字段名统一
PSB wire 名 `capability` / `encoder` / `lastErrorZh`；早期草稿 `capable` / `codec` / `lastError` 的
兼容读取已删）；未知载荷只有一个读口 `readPsbAdminStreamStatus(unknown)`（`null` = 读不到，
不等于 `capability:false`）；未知枚举值一律 `null`（会话 `status` / `agentKind`、工作区 `state`），
`status:null` 不会触发远端重建（§6.1）。
映射函数在 `shared/psb-remote-workspace.ts` §8（`psbIpcCodeForFailure` / `psbFailureMessageKeyForIpcCode` /
`psbRemoteFailureFromIpcError`）。**不要**用 `PRECONDITION_FAILED` 之类泛化码：占用、离线、鉴权
三种失败需要三种不同动作，糊成一个码等于把「去做哪一步」藏起来。

### 9.3 返回值包装形状（易错点，已有 guard）

main handler 返回的是**包装对象**：`{workspaces}` / `{clients}` / `{templates}` / `{workspace}` /
`{status}` / `{session, workspace}`。早期版本有裸数组 / 裸对象，渲染层按包装解构会永远拿到空列表
——这类"编译期不报错、运行期静默为空"的漂移由 `psbRemoteIpcWiring.guard.test.ts` 的 `satisfies`
标记断言与 bridge 签名同源锁死。新增 handler 时必须同时改 bridge 类型，否则 typecheck 会失败。

### 9.4 推送点（`WORKSPACE_CHANGED`）

main 只在「刚拿到新快照」的位置推送，不做自己的轮询：占用 / 释放成功后、新建工作区后、
建会话成功后、`SESSION_STATUS` 读回后、`STOP_SESSION` 补读后。网页侧别人改占用时 Cindy 不实时
推送，靠渲染层 12s 轮询 + 聚焦补拉（与「不做无人值守后台任务」同一取舍）。

另一条推送 `SESSIONS_REBOUND`（`psb-remote:sessions-rebound`）只在**发送前透明重建成功**后发
一次：载荷是 `{localSessionId, previousRemoteHostId, remoteHostId}`，发出时 `remoteHostId` 已是
落库真值（见 §6.1）。它不是工作区快照，消费方按本地会话 id 更新远程派生数据即可；不要用它推断
占用或工作区状态。

### 9.5 串流观看端消息形状（2026-11-26 已与 PSB 对齐）

Cindy 上行**只有** `{kind:'input', event}`。PSB 明确：订阅 = WS 升级、退订 = 断开，
`{kind:'open'}` / `{kind:'close'}` 会被计入非法消息（[跨仓契约摘要](../collaboration/psb-remote-workspace-contract.md)
§1.4），Cindy 已删除这两条控制帧（`streamViewer.ts`，单测断言「升级后不发任何非 input 文本帧」）。
帧头是 **4 字节**（`type(1)+flags(1)+seq(2,BE)`，其后 H.264 载荷；客户端上行 C 通道那套是 5 字节，
中继剥离 tag 后才给观看端）。渲染层把 config 帧的 SPS/PPS 拼成 avcC 作为 `VideoDecoder.description`，
video 帧按需把 Annex-B 转 AVCC 后喂解码器。观看端连接带客户端生成的 UUIDv4 `subscriberId`（§12.3）。

### 9.6 已知缺口（本批不修，登记）

- **无关键帧请求通道**：解码队列积压时丢 delta 等自然关键帧；换取低延迟的代价是弱网恢复慢。
- **分离侧栏窗口**（`sidebarWindowPreload.ts`）未暴露 `psbRemote`：「远程工作区」页签拖成独立窗口后
  观看端显示不可用；页签组内嵌形态正常。另外右侧栏处于分离窗口形态时边页签组整体停用（既有行为），
  此时「远程工作区」页签与插件页签一样不投影。
- **占用无 TTL**：异常退出（强杀、退出登录、换账号）会留下占用，需在 PSB 网页手动释放；
  `dispose` 只断串流、不调用 `releaseWorkspace`（产品 §2.5 同口径）。**正常应用退出与任务结束
  已主动释放**（`psb-workspace-session-release.ts`，见 §16.4）；这不等同于 TTL，也不覆盖强杀。
- **工作区级 `stream/subscribe` 已适配（2026-11-26，PSB 0.1.172）**：串流观看端改走
  `POST /api/cindy/remote/workspaces/:id/stream/subscribe`，拿**桌面访问会话** id 起观看端，
  **不创建 Agent 会话**；绑定持久化、重复启动复用、失效重订阅、读路径不订阅不建会话。旧 PSB
  （端点 404/405/`UNSUPPORTED`）的过渡回退带 `purpose:'internal'`，见 §11.7。
- **输入仲裁改为 PSB 权限模型**（0.1.172）：取消 `role=control` 单控制者 / `takeover` 互斥，
  改由服务端按「工作区是否被占用 + 是否已登录」判定，其它情况只丢弃输入。Cindy 默认允许交互、
  不做客户端互斥；`errors=frame` 未启用（见 §12.5）。

### 9.7 渲染层单入口 / 单判据（2026-11-26 独立审查归并）

同一事实只允许一处判定的渲染层落点（工程侧正本；产品口径见产品规则 §2.3 / §2.4 / §8）：

- **新建任务目标**：`state/newMakerDraft.ts` 的 `DraftTarget` 联合 + `deriveDraftTargetFields()`
  单点归约，`resolveDraftTargetKind()` 是所有闸门的唯一判据；`explicitNoProject` 只表示「对话」；
  一次性导航三套 reader 收敛为 `NewMakerNavigationIntent` 单次 consume；PSB 草稿目标生命周期在
  `features/cc-agent/usePsbDraftTarget.ts`（懒建 / 在途拒绝 / 换目标 / 卸载释放 + owner generation）。
- **右栏页签创建**：`features/right-sidebar/lib/useTabCreationMenu.ts` 统一调
  `openRemoteWorkspaceAdminTab()`（组迁移 / dock 展开 / 激活位由单入口负责），其它入口不再各自
  计算 disabled 条件或拼 `openTab` 参数。
- **失败文案**：根 `renderer/features/remote-workspace/psbFailureText.ts` 的
  `psbFailureText(t,error)`（规则见 §13.4）。
- **占用释放**：main 单权威（归档 / 删除由终态 observer 发起；同工作区还有活动 `psb:` 任务时
  跳过且不入账）。渲染层 `features/cc-agent/psbOccupancyRelease.ts` 只剩**旧 main / 旧 preload
  的兼容补投**（能力探测 `releaseWorkspaceForSession`，新 main 下零调用）；提示条消费两个数据源
  （main 账本 + 工作区级账本，按 `workspaceId` 跨源去重展示；同一工作区重试由 main 代表），
  唯一 UI 消费方是常驻提示条
  `features/remote-workspace/release/PsbPendingReleaseNotice.tsx`（见 §16.4）。
- **工作区显示名 / 次要行**：`features/remote-workspace/dialog/psbWorkspaceDisplay.ts` 是唯一实现——
  **实例名 = 工作区目录名**（PSB `directoryName`，如 `saga2_project-3`；trim 非空优先，缺失回退
  `title`，再回退 `<客户端名>-<短 id>` / 短 id，由 `psbWorkspaceInstanceName` 单点取）；**模板名不是
  实例名**，模板名 · 机器名只作次要行（`psbWorkspaceTemplateMachineText`：去重、`' · '` 连接、不进
  翻译；主标签已是目录名时不再输出「目录：…」重复行）。选择器行用 `psbWorkspaceRowLabels`（按整个
  列表消歧，主标题 + 次要行都撞才追加短 id）；草稿页项目胶囊用 `psbWorkspaceTargetDisplayName(psbTarget)`
  （接整个 PSB 目标载荷，路由里禁止手写第二份「目标 → 显示名」拼接）；管理页页头 / VCS 横幅用同一对
  helper。产品口径见产品规则 §2.3 / §3。
- **工作区选择 / 占用确认**：`renderer/features/remote-workspace/dialog/usePsbWorkspaceSelection.ts`
  是弹窗与草稿页下拉唯一的**选择引擎**（`requestSelect` / `confirmOccupy` / `cancelOccupy` /
  `handoffSelection` / `cancel`；确认弹窗走宿主 `useConfirmDialog`，行 UI / 徽标 / 键盘 / 失败
  文案同源）。容器不再自己判定「要不要占用 / 要不要确认 / 谁负责归还」；状态机、`held.newlyOccupied`
  归还边界与两个入口的交接时机见 §9.8。
- **隐式写路径的占用确认（2026-11-27 复测）**：`features/remote-workspace/occupyRequired.ts` 是
  「用户确认 → 显式占用 → 调用方重试同一次动作」的**唯一实现**（码识别 /
  `confirmAndOccupyPsbWorkspace` / 两个注册式 resolver / `adminContext` 解析 workspaceId）；
  宿主 `PsbOccupyRequiredConfirmation.tsx`（App 主窗挂一次）只做「注册 resolver + 取全局确认框」。
  发送（`makerChatStore` 的 enqueue / steer catch）、启动串流（`useAdminStreamSession.start`）、
  懒建会话（`psbDraftSession.ensure`）只调用它，不再各自判定占用或自行占用（见 §13.6）。

定向测试：`psbDraftTarget.test.ts` / `psbDraftSession.test.ts`（目标归约与草稿生命周期）、
`psbWorkspaceDisplay.test.ts`（实例名 = 目录名 / 模板名只进次要行 / 同名消歧 / 交接载荷 → 胶囊同一
口径）、`remoteWorkspaceAdminEntry.test.tsx`（右栏「+」菜单单入口）、`psbFailureText.test.ts`（码表 /
包装剥离 / 人名插值）、`psbOccupancyRelease.test.ts`（main 单权威探测 / 旧 main 兼容补投）、
`PsbPendingReleaseNotice.test.tsx`（跨源去重 / 单一重试 / 失败码归一 / 关闭 / 旧 preload 降级）、`psbStreamLifecycle.test.ts` /
`RemoteWorkspaceAdminPanel.test.tsx`（状态机 / 保活 / watchdog）、`vcsNoticeStore.test.ts` /
`WorkspaceVcsNoticeHost.test.tsx` / `WorkspaceVcsNoticeView.test.tsx`（revision 单调 / 合并 /
关闭语义 / 右下横幅）、`RemoteWorkspacePickerDialog.test.tsx` / `PsbWorkspacePicker.test.tsx`
（选择状态机 / 占用确认 / 归还边界，见 §9.8 / §16.5）。

### 9.8 工作区选择状态机与归还（2026-11-27 用户复测，实现事实）

行点击不再等于「立刻占用」，两个容器（`RemoteWorkspacePickerDialog` / `PsbWorkspacePicker`）共用
`usePsbWorkspaceSelection()` 的一套状态机：

- `requestSelect(workspace)`：**只分类、不发请求**——`mine` → 立即返回可交接载荷（不占、不弹）；
  无人占用 → 只登记 `pendingOccupy`（给容器弹确认）；不可选（他人占用 / 离线 / 未就绪 / 不支持
  Agent，判据仍是共享 `psbWorkspaceHealth().canStartSession`）→ no-op。切到另一行时：之前
  **本次新占用且未交接**的工作区立刻归还（返回值带 `releasedWorkspaceId`），**选之前就已是 mine**
  的旧选择先留着（取消确认时用户仍能交接它）；同一个工作区再次点击沿用已占用的选择。
- `confirmOccupy()`：用户确认后才真正 `occupy()`；成功登记
  `held = { workspaceId, created, newlyOccupied: true }`，失败保持未选中（`actionError` / VCS
  通知照旧）。
- `cancelOccupy()`：清掉待确认，不发占用。
- `handoffSelection()`：把已占用的选择交给调用方（弹窗主按钮 / 下拉选中草稿），返回工作区级载荷；
  **交接后本 hook 不再归还这把锁**（释放交给草稿 / 任务生命周期）。
- `cancel()`：关闭 / 卸载 / 放弃选择的统一出口——作废在途占用（迟到成功立刻归还并记账）、清掉
  待确认、归还已占用未交接的选择。

**归还边界（`held.newlyOccupied`）**：只有「**本次选择期间新占用、且尚未交接**」的工作区在切换 /
关闭 / 卸载时归还，且**每次选择至多一次**（先清 `heldRef` 再发 `releasePsbWorkspaceOccupancy`，
切换 + 关闭 + 卸载重复触发也只释放一次）。**选之前已是 mine 的锁不归还**（锁可能是同一用户另一条
任务占的，替它释放会打断那条任务）。归还失败进 `draft/psbPendingReleaseLedger.ts` 的待释放账本
（常驻提示条统一展示 / 重试，见 §16.4）。

**两个容器的交接时机不同**（占用都只发生一次）：弹窗在行上确认占用成功只设选中态，主按钮
`handoffSelection()` 交接 `held` 载荷并关闭（**不第二次 occupy**；可交接判据是
`heldWorkspaceId === 选中行 id` 且 `canStartSession`，未被占用的行即使被选中也不能交接）；
下拉确认占用成功即 `handoffSelection()` + `onSelect()` 交给草稿，父层随之关闭下拉。

**键盘**：两个容器都用 `listbox`（`usePsbWorkspaceListKeyboard`）——方向键 / Home / End **只移动
焦点**，Enter / Space / 点击才激活选择。若沿用 radio 的「焦点跟随选中」，键盘浏览会反复弹占用
确认甚至直接占用工作区，与「先看再决定」冲突。不可用行原生 `disabled`（Tab 跳过、不进键盘序列），
在途行用 `aria-disabled` + loading 保焦点。

**文案**：`remoteWorkspace.dialog.confirmOccupy.{title,body,confirm,cancel,occupying}`，12 locale
同步；行内 tooltip 的占用人名 / 下一步仍走共享 `psbWorkspaceUnavailableReason()`（唯一实现，
见 §10.3 E4/E5）。


## 10. 与 PSB 实现的联调对齐（2026-11-25 夜，测试部署）

实测发现 PSB 的 Cindy 入口有两处**形状差异**，已由 Cindy 客户端适配（PSB 未改动），后续改动以 PSB 仓
`packages/shared/src/cindy-remote.ts` 为事实源：

1. **创建 / 读取会话**回答 `{ data: <会话行> }`（单条行，不夹带工作区）。`psbClient` 现在「先解析会话行，
   再按 `session.workspaceId` 从工作区列表补工作区」（`requireWorkspaceById`），两种外壳都兼容；
   渲染层的 DTO 不需要知道这个差异。
2. **串流状态**字段用 PSB wire 名 `capability` / `encoder` / `lastErrorZh`；早期草稿的
   `capable` / `codec` / `lastError` 双拼写兼容读取**已于 2026-11-26 删除**（只认现行字段，
   缺字段按 `null` / 未知处理，不再两种都认）。
3. PSB **没有**「读单个工作区」路由：Cindy 的 JWT 白名单也不放行 `GET /workspaces/:id`，
   该路由在 Cindy 身份下**恒 403**（2026-11-26 真机：`open-web-workspace` 报
   `[PSB_NOT_FOUND] 这个 Cindy 身份不能访问该接口`，来自 PSB `packages/server/src/app.ts` 的
   Cindy 白名单）。所以「读一个工作区」**只能走列表口按 id 取**；单行 GET 仅作兜底，且它的
   403/404/405 一律按「这条读口没有答案」处理（见 §3「工作区详情只认列表口」）。

**实测到的阻塞点（不是 Cindy 缺陷）**：远端 `mode=exec` 被客户端回 `[EXEC_BUSY]`（「同时执行的命令已达
上限（8 条）」），说明 PSB 客户端的 exec 并发名额在多次建/停会话后被占满或未释放；已写入 PSB 仓
`协作需求.md` §8（跨仓确认项见[契约摘要](../collaboration/psb-remote-workspace-contract.md) §2），
要求 PSB 确认 stop 后的名额释放与孤儿清理。后续 PSB 已定位并修复该回归（见 §10.5–§10.7）。

### 10.1 第二轮联调阻塞（2026-11-26 凌晨，PSB 0.1.155）

- **现象**：三 Harness 在客户端全部可用后，Cindy 首条消息仍失败：
  `[PSB_SESSION_NOT_READY] session runtime is not ready: 客户端还没建立隧道，等待期内的数据已超过缓冲上限；请重试。`
- **Cindy 侧行为**：WS 升级成功即发送首帧应用层 RPC（与 MCPRouter 隧道同契约），之后才由 PSB 把客户端
  出站隧道接上。PSB 后续给出就绪契约（0.1.159+ 引入 `agent-tunnel.ready` 文本帧，0.1.160+ 起
  opt-in、URL 不声明 `readyFrame=1` 就不发）：10s 排队等待 + 1 MiB 预检缓冲
  （跨仓确认项见[契约摘要](../collaboration/psb-remote-workspace-contract.md)
  §1.2）。Cindy 按「收到 ready 再发首帧、等不到按超时回退」实现（见 §10.7）。
- **不要**在 Cindy 侧私自加"盲等 N 秒"：等待时长与缓冲上限是 PSB 的事实，猜一个值只会让失败更难归因；
  就绪帧超时值也必须来自契约（exec 1.2s / 其它 5s 的超时回退只是兼容旧服务端，不是业务等待）。
- **重试**：当前是用户手动点「重试」重跑同一回合（复用同一 PSB 会话与 `clientRequestId`），不做自动重连；
  在 PSB 就绪机制落地前，自动重试只会把同一个竞态重放一遍。


### 10.2 第三轮实测（PSB 0.1.155）：远端会话记录正确，卡在宿主 pi 运行时

- **本地记录口径正确**：经草稿页懒建后，会话行必须有 `remoteHostId='psb:<psbSessionId>'`、
  `workingDir='/psb-remote/<workspace 目录>'`。实测两条都符合；反过来，**`remoteHostId=null` 的会话是本地会话**，
  判定「远端回合成功」前必须先断言这一列（我们的 E2E 脚本已加此断言，防止把本机回退当成远端成功）。
- **唯一阻塞**：pi 会话首条消息报
  `[MCPR_PI_BINARY_MISSING] … (checked CINDY_PI_AGENT_BIN, PATH, $HOME/.xdt-server/v1/pi/pi)`。
  解析顺序在 `apps/desktop/src/main/maker-host/pi-mcpr-remote.ts`（`resolveMcprPiBinaryPath`）：
  ①`CINDY_PI_AGENT_BIN` ②PATH 上的 `pi` ③`$HOME/.xdt-server/v1/pi/pi`。
  PSB 客户端已能起 pi（`agents.pi available:true`），但没把路径暴露给 Cindy 的隧道环境——属**宿主侧**的
  配置/物化问题，不是 Cindy transport 缺陷。已要求 PSB 二选一（导出 env 或物化到 `$HOME/.xdt-server/v1/pi/pi`）。
- **不要**在 Cindy 侧加「多探几条私有路径」的补救：路径是与 PSB 的契约事实，猜路径会让下次失败更难归因。
- **已验证通过的部分**：`psb:` 分类、PSB 会话创建、`psb:` 记录落库、执行时进入 psb 隧道（错误来自宿主侧
  `pi/ensure` 的运行时定位），说明 transport 接入点本身正确。


### 10.3 交付前独立审查发现的修复（2026-11-26）

一次性审查（只读、按"真实故障/数据错误/安全"标准）在本批改动里拦下 1 个必须修复 + 5 个建议，均已修复并补测试：

| # | 问题 | 修复 |
| --- | --- | --- |
| B1 | `psb:` 会话页仍显示协同（Orca）入口；点击后 main 把 `psb:<id>` 当 SSH host preflight，报 `SSH_HOST_NOT_FOUND: unknown ssh host: psb:<id>`（正是本批要防的「`psb:` 落进 SSH-only 探针」） | `collabEntryPolicy` 作为**单一判定点**新增 `psb:` 不可用分支（草稿页早已 `isPsbDraft ? false`），会话页自动同步；`collabEntryPolicy.test.ts` 补 psb/mcpr 两例 |
| S1 | 放弃草稿时 `stopSession` 与 `releaseWorkspace` 并发发出，PSB 若因「仍有运行中会话」拒绝 release，协作锁留在我名下（无 TTL） | `releasePsbDraftTarget` 改为**先等 stop（上限 3s）再 release**；`psbDraftSession.test.ts` 断言调用顺序 |
| S2 | `createPsbSessionGate` 的 `inFlight` 被过期请求的 `finally` 清空 → `reset()` 后并发 `ensure` 会再建一条 PSB 会话（新 `clientRequestId`，PSB 幂等键挡不住） | 改成「票号 + Promise」，`finally` 只在句柄仍是自己时清；测试覆盖「reset 后旧请求失败、新请求仍共享」 |
| S3 | 输入禁用未覆盖排队消息的快捷插话路径（`steerSoleQueuedMessageRef` 不看 `disabled`、`PendingQueueBubble` 未带 `psbInputBlocked`） | 两处都并入禁用判据（产品 §2.4 要求覆盖所有发送入口） |
| S4 | 占用失败的人名在 toast 路径丢失：IPC 只带 code+message，渲染层 `personName` 恒为 null → 只剩「使用中」 | main 侧把 `occupiedByOther` 的 `message` **收敛为「占用人名 / 空串」**，渲染层按码回填 `personName`；不再混入 PSB 中文原文 |
| S5 | `startStream` 回包把 `active` 强行置 true，面板在零帧时显示「串流中」 | 观看端**不改写 PSB 的 `active`**；面板区分「已订阅（stop 可点）」与「有画面」，新增 `remoteWorkspace.session.streamWaiting`（12 locale） |

审查同时确认以下面无需改动：IPC 通道（当时 18 条；现为会话级 21 条 + 管理页 8 条通道常量）
与 preload/main/bridge 一一对应、token 不进日志/IPC、
`wss:`/`https:` 单一来源、401 只重签一次、`psb:` 的 maker-host 钩子全部走隧道分支（清单见 §7）、
渲染层判据与 main 分类器同源、草稿占用释放有 `psbTargetCommittedRef` 守护。

**2026-11-26 第二轮独立审查（渲染层阻断项）**：`streaming` 改为**只由本端 `frame` 事件置 true**
（PSB `active` 只进状态 / 详情，订阅成功到首帧显示「已连接，等待画面…」，`status.active` 既不提前
点亮也不回切）；停止失败路径清屏 + 复位（§12.8）；输入边沿改走 `pump.sendEdge` 保序（§12.2）；
草稿页按 `isPsbDraft || isPsbChannelSelected` 收掉「另一台电脑上的模型」与「本机引用目录」、
未选工作区用专用提示 key；`CONTEXT_CHANGED` 载荷加 `localSessionId` 供跨窗口过滤（§11.2）；
同时清理 12 个未消费 i18n key 与 glossary 里已不存在的 exempt。逐条修复清单与真机复测点见产品规则
§8.1 的「独立审查渲染层阻断项」条目。

**渲染层独立审查复审（同日，5 项）**：① `newMakerProjectPicker.test.ts` 里两处仍在断言修复前的
源码字面量（`onExtraDirsChange` / `onWritableDirsChange` 的旧门禁表达式）会红门禁 —— 改为按 prop
表达式提取后断言参与门禁的条件集合（`isDeviceLinkDraft` / `isRemoteProjectDraft` /
`isPsbDraft || isPsbChannelSelected` 与 `? undefined : handle*`），不再复制 jsx 排版；② picker 已
占用成功但换目标被「发送 / 目录恢复在途」拒绝时，渲染层立刻 `releaseWorkspace` 刚占用的工作区
（占用无 TTL）并给 `remoteWorkspace.draft.actionBusy` 提示（`handleCreatePsbWorkspace` 被挡时同样
提示）；③ 侧栏交接重进**同一工作区**沿用已懒建的 `sessionId`（不覆盖成 null、不留孤儿 PSB 会话）；
④ Codex 模型选择的 SSH 分支判据从 `effectiveRemoteHostId` 改 `sshRemoteHostId`（PSB 懒建 / 重试窗口
里前者是 `psb:<id>`，旧判据会走 SSH 分支并写 `patchSshDraftSelection(hostId=null)` 被静默丢弃）。
定向测试：`newMakerProjectPicker.test.ts`、`newMakerDraftTargetCatalog.test.ts` 新增的
「PSB draft target guards」（占用释放 / 同工作区保留 sessionId / 交接沿用 sessionId）。

**复审收尾（同日，3 项）**：① 播放器 effect 的依赖从 `[t]` 改为 `[]`，`onFailure` 改读
`translateRef.current` —— 否则观看中切换界面语言会 dispose 播放器、新实例拿不到上一次 config
（画面白掉，只能手动停/再启动）；面板测试新增「切语言不重建播放器」。② 删除未消费的死代码：
`psbStreamInput` 的 `isInputCaptureActive` / `keyboardLockSupport`（捕获态判据由采集 hook 的
`captureRef` 单点决定、Keyboard Lock 探测已由 `keyboardLockApiOf` 覆盖，连同其单测一并删除），
`psbStreamPlayer` 统计里的 `decodedFrames` / `decodeErrors`（无 UI 消费、不参与解码决策）。
③ `remoteWorkspace.admin.directoryValue` 等 12 个无引用 i18n key 已在上一批删除，本轮复核仍为
零引用。

**渲染层选择器 / 草稿 / 串流 / 侧栏独立修复（2026-11-26 第三轮，FIX-E）**：本批只动
`renderer/features/remote-workspace/{dialog,draft,stream,sidebar}/**` 与根
`psbFailureText.ts`，事实如下（实现与测试同批落地）：

| # | 问题 | 修复 |
| --- | --- | --- |
| E1 | 两份同名 `psbFailureText`（根 + `dialog/psbDialogModel.ts`），码表不一致：同一失败在两个入口可能显示两句话 | 实现只留根 `psbFailureText.ts`：PSB 码走共享 `psbFailureMessageKeyForIpcCode`、本地码兜底 `ipcError.<CODE>`、剥 `[CODE] ` 前缀、占用空人名回落 `remoteWorkspace.error.workspaceOccupied`；dialog 侧正则码表删除，只留 `dialog/psbFailure.ts` 的失败事实归一（`readPsbFailure` / 超时事实 / 诊断行） |
| E2 | 弹窗与草稿页下拉逐行同构（列出→占用→刷新补人名→hydrate VCS→内联错误；行 UI / 徽标 / 事件订阅 / VCS state 各一份） | 共享 `dialog/usePsbWorkspaceSelection.ts`（选择引擎）、`dialog/PsbWorkspaceRow.tsx` + `dialog/WorkspaceStatusBadge.tsx`（行 UI/徽标）、`dialog/usePsbWorkspaceListKeyboard.ts`（radiogroup/listbox 键盘与 roving tabindex）；两个容器只留壳 |
| E3 | 忙时无出口：占用无超时、在途禁止关闭；取消后迟到的占用成功无人释放（占用无 TTL） | 占用 20s 超时（`PSB_OCCUPY_TIMEOUT_MS`）给可行动失败；弹窗允许取消/关闭、下拉卸载即放弃；**放弃后迟到的成功立刻 `releaseWorkspace`**，失败进 `draft/psbPendingReleaseLedger.ts` 账本（`record/list/subscribe/retryPsbPendingReleases`）由常驻提示条消费（提示文案键 `remoteWorkspace.draft.releasePending` / `releaseRetained`；**12 locale 与常驻提示条 UI 均已落地**，见 §16.4） |
| E4 | 同一占用在一行里表达三次（徽标 + 长句 + 锁）；行材质两个入口各一套 | 行内只留短徽标，占用人名/下一步进 tooltip；`other` 不再挂锁（`mine` 保留亮锁）；行材质统一为 `--border-default` + `--surface-hover` / `--accent-emphasis` 选中态（inner-control 8px 圆角） |
| E5 | 失败 `{{name}}` 未插值、VCS 通知与通用错误同显 | 所有失败文案经根函数（人名唯一插值点）；`vcsNotice` 在场时 `visibleActionError` 为 null（同一事实一句话） |
| E6 | 键盘/ARIA 缺失：弹窗 radiogroup 无方向键与 roving tabindex，下拉 listbox 不处理方向键；忙时按钮被原生 disabled 后焦点丢回 body | 共享键盘 hook 按 WAI-ARIA 惯例（单选跟随焦点 / 列表只移焦点）；在途按钮用 `aria-disabled` + loading（`allowWhileLoading`），行在「外部锁」时才是原生 disabled。**2026-11-27 起两个容器都改用 `listbox`（方向键只移焦点），见 §9.8** |
| E7 | 显示名冲突无消歧：同名 + 同目录/同机器时两行完全一样 | `psbWorkspaceRowLabels()` 按整表消歧：冲突行主标题追加 `-<短 id>`（仍撞用完整 id） |
| E8 | 历史交接值 `directoryName` 未校验：`/`、`\`、`..`、控制字符会进入虚拟工作目录 | `readPsbDraftRouteTarget` 经 `readPsbDirectoryName` 只接受单个目录名（≤255、拒分隔符/`..`/控制字符）；脏值丢弃该字段，目标仍成立 |
| E9 | 孤儿 PSB 会话：gate 判过后清去重键、回调目标变化时静默 return → 远端残留无人引用会话，重试再建第二条 | `onSessionCreated` 改为返回是否采纳；未采纳/目标已变 → 尽力 `stopSession` 且**保留去重键**（重试按同一 `clientRequestId` 拿回同一条）；`reused` 与 `getClientRequestId` 等无消费 API 删除 |
| E10 | 会话级串流五通道在渲染层零消费（bridge/IPC/preload 自认）；`psbStreamSessionId` 与 `remoteWorkspacePsbSessionId` 双包装；`psbWorkspaceRowHealth` 纯别名；`top-px` 魔法值无说明 | 测试/注释里的会话级引用删除（bridge 声明归 FIX-G）；身份解析收敛到 `sidebar/isRemoteWorkspaceSession.ts` 一份实现（`remoteWorkspacePsbSessionId` 接受会话对象或 `remoteHostId` 字符串）；**跨组集成波次已把最后一个调用点（`CCAgentSessionView`）迁到 `remoteWorkspacePsbSessionId` 并删除 `psbStreamSessionId` 别名**；删别名改调共享 `psbWorkspaceHealth`；`top-px` 注明 1px 光学基线对齐 |
| E11 | 侧栏状态缓存：手列 14 字段比较、TTL 与轮询间隔同一常量、释放引用后清空却不 publish | 改为「行投影」比较（只含渲染字段）；`REFRESH_TTL_MS=12s` 与 `POLL_INTERVAL_MS=15s` 拆开；释放时清空后 `publish` 让行上的标签/锁立即消失；会话→工作区反查加带 revision 的单次解析缓存（一行两个装饰不再各扫一遍表） |
| E12 | 串流播放器 `submittedAt` 无上限（解码器只吃输入不产出的窗口里随串流时长增长）；播放器无行为测试 | 待配对提交样本上限 `PSB_STREAM_MAX_PENDING_SUBMISSIONS=64`；`psbStreamPlayer.test.ts` 用 fake `VideoDecoder`/canvas 钉住重建、丢 delta、统计与上限 |
| E13 | `psbDraftTarget` 脏 history state 无测试；测试夹具在两个入口重复 | 新增 `psbDraftTarget.test.ts`（脏目录名/消费语义）；`__tests__/psbTestFixtures.ts` 统一 `makePsbWorkspace` / `installPsbBridge` 等夹具，删掉两个入口各自的复制 |
| E14 | 确认占用弹窗从工作区选择弹窗里发起时被下层模态挡住：确认框 zIndex 缺省 10000 低于选择弹窗内容 z-[10001]，只看到遮罩变黑、确认框不可见、页面点什么都没反应 | `ConfirmDialog` 缺省层级提升到 `10090`（高于普通模态内容最高档 `z-[10020]`、仍低于 Toast `10100`），可盖在任何弹窗之上；`confirmDialogA11y.test.tsx` 增加层级回归断言，并在 `confirm-dialog.tsx` 注释写明嵌套模态约定 |

定向测试：`vitest run src/renderer/features/remote-workspace`（23 files / 236 tests 全通过）；
渲染层类型检查 `tsc --noEmit -p tsconfig.renderer.json` 通过（整包 `pnpm --filter desktop run typecheck`
的 main 分片由并行的主进程修复批次一起复验）。后续（跨组集成波次，2026-11-27）：`psbStreamSessionId`
的最后一个调用点已迁移并删除别名；会话级串流通道删除由 FIX-G 完成；待释放账本已从「渲染层
进程内记账（App 重启后丢失）」改为 **main 的有界账本 + IPC 读/重试/推送**（见 §16.4），渲染层
只缓存快照。`remoteWorkspace.draft.releasePending` / `releaseRetained` 的 **12 locale 文案已在**
（跨组集成波次补齐）；**常驻「待释放」提示条 UI 已在后续任务落地**
（`features/remote-workspace/release/PsbPendingReleaseNotice.tsx`，主窗挂一次、非阻塞、重试 /
关闭 / 计数徽标，单测 `PsbPendingReleaseNotice.test.tsx`），真机未验证。


### 10.4 外壳缺失当契约违约 + 串流失败文案去包装（2026-11-26）

- **`psbClient.call()` 不再容忍"没有 data 键"**：PSB 的 Cindy 入口统一是 `{ data: … }`；外壳缺失时宽松解析器
  会把 `undefined` 静默回落成默认值（`capability:false` + 空错误），HTTP 200 完全看不出异常。2026-11-26 的
  `stream/status` 事故就是这个形状：PSB 计算值一直正确，但 Cindy 显示"客户端不支持串流"。
  现在缺失外壳 → `PSB_PROTOCOL` + warn（`psbClient.test.ts` 用裸状态对象钉住该形状）。
  例外保持：`allowEmptyResult` 且响应体为空（如 `DELETE` 停止）仍视为成功。
- **串流失败文案只展示 PSB 原文**：IPC 失败经 Electron 会包成
  `Error invoking remote method '…': Error: [CODE] 原文`；面板现在优先 `extractIpcError().message`，
  不再把包装前缀塞给用户（例：409「这个 agent 会话已经结束，没有可以观看的画面」）。
- **`active` 语义与面板状态**（同 §10.3 S5）：PSB 0.1.157 修正外壳后实测 `capability:true, active:false`
  并带 `lastErrorZh`「没有正在运行的桌面会话」——Cindy 面板据此显示「串流未启动。」+ 提示，「启动」可用，
  订阅成功后显示「已连接，等待画面…」，首帧到达才切「串流中」。


### 10.5 真实回合打通与两处协议纠偏（2026-11-26 凌晨，PSB 0.1.158）

**结论：`psb:` 的 pi 真实回合已端到端通过**——本地会话 `remoteHostId=psb:<id>`、`agentKind=pi`，
首条消息后远端 pi 在 PSB 客户端工作区执行并回复，消息正常落库/上屏（验证脚本断言「本地会话身份
必须是 `psb:`」+「本地 messages 出现 assistant 内容」，避免再被本机会话误导）。

两条**协议纠偏**（都是联调暴露、都改了代码 + 测试）：

1. **`mode` 一律显式写**：`buildPsbTunnelUrl` 原先按 MCPR 约定对 `cc-mgr` 省略 `mode`，但 PSB 的
   `parseTunnelMode(undefined)` 回 400「mode 必须是 … 之一（收到 空）」——把 cc-mgr 控制通道与
   codex-appserver 的 bootstrap 全挡掉（只有 pi/exec 能过）。现在四种模式都写 `mode`；
   `psbTunnelWiring.test.ts` 的守卫同步改成「cc-mgr 也必须写」。
2. **pi 的 `cwd` 归属**：`pi/ensure` 的 `cmd` 里不能出现 `cd "/psb-remote/<目录>"`——那是 Cindy 的虚拟路径，
   宿主按服务端会话记录的工作区 spawn（`cwd: workspacePath`）。拼进去只会让 `bash -c` 立即 `exit 1`
   （表象是 `pi process exited (code=null, signal=null)`）。`buildPiLaunchCommand` 现在接受 `cwd: string | null`，
   `psb:` 传 `null`（不写 cd），SSH/MCPR 保持原语义；`piRemoteTransport.test.ts` 新增三条用例钉住。

**诊断增强**：隧道 Upgrade 被拒时读取 PSB 的响应体（≤2KB / 2s 超时）并附在错误消息后；否则 400 只剩状态码，
用户与联调都看不出真正原因。`psbTunnel.test.ts` 覆盖「带 body 原因」与「无 body 回退状态码分类」两种形状。

**仍未验证**：codex-appserver 的真实回合（隧道已通，模型凭据需 BYOK / 或 PSB 指一个平台可用模型）、
cc-mgr（本机目录无 Claude 模型）、串流首帧（需 PSB 侧起 running 桌面会话）、
以及 `[PSB_SESSION_NOT_READY]` 间歇出现（已要求 PSB 给就绪契约：缓冲上限/等待时长/是否有就绪帧）。

### 10.6 第四轮复验（2026-11-26 03:2x）：成功一次 + 两个间歇问题

- pi 远端回合**可成功**（`0357eba5-…`）；第二次复验在 pi 启动前的 exec 探测阶段失败：
  `[MCPR_EXEC_PROTOCOL] instance exec returned a non-JSON frame`（session `psb:a548bbaf-…`）。
  Cindy 的 exec 通道按 MCPR 契约解析 JSON 结果帧；不要为了"容错"把非 JSON 当空结果吞掉（会变成
  更难查的静默失败），等 PSB 给出帧样例再决定放宽点。
- 上一轮同路径还遇到 `[PSB_SESSION_NOT_READY] 客户端还没建立隧道，等待期内的数据已超过缓冲上限`。
  两条都已按 sessionId 提给 PSB（就绪契约 + exec 帧样例）。
- 「停止会话」目前只在用户下一次操作（发送/读状态轮询）时体现；若要"立刻"置灰并提示终态，
  需要 PSB 确认 `SESSION_TERMINAL` 的主动刷新口径（Cindy 倾向主动刷新一次状态并展示终态）。

### 10.7 第五轮验证（2026-11-26 09:4x，PSB 0.1.160）：codex 与 pi 均通过

- codex：本地会话 `c0d26655-…` / `psb:4bf4498d-…` / `agentKind=codex` / `model=openai/gpt-6-luna`（模型用「Cindy AI」行的
  GPT-6 Luna，不是 `byok-openai-codex/…`），回复 OK 落库。上一轮的 403 是选错模型行，不是隧道/凭据口径问题。
- pi：本地会话 `38d3053e-…` / `psb:713d127d-…` / `agentKind=pi`，回复 OK 落库。
- cc-mgr 当时未验证：该账号模型目录搜不到 Claude 模型（`Claude`/`Sonnet`/`Opus` 均 0 条）。后续换到
  可用模型后已跑通（见 §10.9 与产品 §8.2，2/2）。
- **已落地**（PSB §14 契约；就绪帧 0.1.159+ 引入、0.1.160+ 起 opt-in，见 §2）：等
  `agent-tunnel.ready` 再发首帧（超时回退）、文本帧不进
  业务字节流（只按 `isBinary` 分流）、4004 的 JSON `cause` 分类（`SESSION_STOPPED` / `CLIENT_OFFLINE`
  等）；实现与单测见 §2 与 `main/remote-workspace/__tests__/psbTunnel.test.ts`。

### 10.8 串流 4004 归因修正（2026-11-26，此前误报已被修正）

**缺陷**：Cindy 把 4004 一律映射成 `slow-subscriber`（见 §5 旧 token 列表），且不解析 PSB 的
`{"reasonCode":…,"desktopSession":…}|中文` 结构前缀；「该工作区没有 running 桌面会话」在联调中因此被
误报成「用户消费太慢」（真机取证：一次订阅被 4004 秒关、0 帧、当时 `active:false` 且 PSB 提示
「没有正在运行的桌面会话」；结论见[契约摘要](../collaboration/psb-remote-workspace-contract.md) §1.4）。

**修正**（代码 + 测试同批）：

1. `main/remote-workspace/streamViewer.ts`：新增 `classifyStreamClose({ code, reason, receivedBinaryFrames })`，
   按 §5 的三种情形归因；`closed` 事件带 `PsbStreamCloseDetail`（`reasonCode` / `desktopSession` /
   `messageZh`）。`psbStreamClosedReason` 保留为码映射，4004 在**没有帧数证据**时默认 `not-ready`
   （安全侧），只有「收到过帧 + 无结构前缀」才 `slow-subscriber`；握手阶段 4004 的失败 `message`
   改为只取结构前缀后的中文人话。
2. `shared/psb-remote-workspace.ts`：新增 `PSB_DESKTOP_SESSION_STATES` / `PSB_STREAM_REASON_CODES`、
   `parsePsbStreamCloseReason`；`PsbSessionStreamStatus` 加性扩展 `desktopSession` / `reasonCode`
   （缺字段 → `null`），`parsePsbSessionStreamStatus` 透传。
3. 定向单测：`streamViewer.test.ts` 的表驱动用例覆盖「结构化 reason」「0 帧 + 纯中文 reason」
   「收帧后 4004」三种归因（修复前前两条会红）；`psbClient.test.ts` 钉住 `stream/status` 两个
   加性字段的透传与缺省回退。

**验证现状**：定向单测与类型检查已过（修复前两条归因用例会红，已实测先红后绿）。
**真机已复核**「没有桌面会话时启动串流」：管理页显示 PSB 的「去网页启动桌面会话」可行动文案，
`reasonCode` / `desktopSession` 生效（见产品 §8.2）；**仅剩**弱网 / 积压场景的 4004 是否仍归因
`slow-subscriber` 未构造真机复现。**渲染层已消费 `closed.detail` 与
`reasonCode`**：新「远程工作区」页的 `RemoteWorkspaceAdminConnection` 把 PSB 原话显示成中性
提示，并按 `reasonCode` / `desktopSession`（`NO_DESKTOP_SESSION` / `CAPTURE_NOT_READY` /
`CLIENT_NO_STREAMING`）给出专用空态引导；`status: null` 只当「此刻读不到」，不禁用启动。
**终态会话点「启动」时 PSB 原话的实际文案尚未真机重放**。

### 10.9 第六轮定位（2026-11-26 10:xx）：cc-mgr 远端会话失败 = 虚拟 cwd 被下发给 daemon

**现象**（3 次以上复现，`psb:d41a3482-…` / `psb:b1744d99-…` / `psb:b42907fd-…` / `psb:21769c5d-…` 等）：
CC 主进程日志只有 `[cc-manager-client] cc-mgr hello ok { protocolVersion: 5, managerVersion: '0.0.12' }`，
之后没有任何 cc-mgr 帧日志；约 40~60 ms 后本地会话被关闭，`[maker-input-coordinator] pre-accept send failed`
带上 `Session <本地 id> is closed`，UI 与诊断都只显示这一句。PSB 侧 journal 显示 hello 已被 replay、
双向转发已建立，随后隧道以 `code=1011`（空 reason）关闭。

**根因**：`remoteCcQueryFactory` 的隧道分支把 maker-core 的 `startParams.cwd`
（= 会话 `workingDir`，PSB 上是虚拟路径 `/psb-remote/<目录名>`）原样交给 `openCcManagerSession`。
daemon 收到 `query/start` 后用该 cwd 调 SDK `query()`，SDK 立刻 spawn `claude`：目录不存在 →
spawn 失败（本机 SDK 复现：**11 ms** 内 iterator 抛错）→ daemon 的 consume loop 抛错并把
`session/closed(reason='error', detail=<错误原文>)` 发给 Cindy → `RemoteQuery` 的迭代器结束 →
maker-core 走 `event loop ended unexpectedly (likely remote daemon shutdown)` 的 U2 兜底并
`auto-closing session` → 下一条消息拿到 `Session <id> is closed`。**所以 1011 是我们会话收尾时
`terminate()` 隧道的结果，不是失败原因**；失败从 `query/start` 建 query 的那一刻就发生了。

**错误被吞在哪一层**（本次一并修掉）：
1. `packages/maker-cc-manager/src/remote-query.ts` 收到 `session/closed` 时只 `end()` 事件队列，
   `reason`/`detail` 直接丢弃 → daemon 的 `session consume loop threw {error}` 原文再也拿不到；
2. `psbTunnel` 只在 `4003/4004` 时把关闭归类成错误，其余关闭码（含 1011）静默变成字节流 EOF，
   `cc-manager-client` 也没有记录关闭码 → 「谁先断」只能跨仓对 journal。

**修复**：`psb:` 的 cc-mgr 分支把 `cwd` 改写为 `'.'`（宿主工作区口径，与 pi 不写 `cd`、codex
不下发 `cwd` 同一裁决）；`createRemoteQuery` 新增 `onSessionClosed({reason, detail})` 并由
`cc-manager-client` 落 main 日志（`cc-mgr: daemon closed the session`），同时记录隧道关闭码
（`cc-mgr transport closed {code, signal}`）。回归断言：
`__tests__/remote-query.test.ts`（daemon 报错原文透出）、
`src/main/maker-host/__tests__/remoteCcQueryFactory.test.ts`（psb 改写 cwd + 两处诊断接线）。

**验证现状**：单测与受影响类型检查已过；**真机已通过**（cc 远端回合 2/2，根因修复后无
`daemon closed the session`，见产品 §8.2）。

## 11. 工作区级管理页与观看端绑定（2026-11-26）

### 11.1 为什么需要这一层

「远程工作区」页签是 **PSB 网页远程工作区的快捷访问**，用户要的是「这台机器 · 这个工作区、
目录、现在被谁占用」以及它的实时画面。这套内容**与用户的 Agent 任务无关**：任务结束了、
任务根本不是远程任务、甚至一个任务都没打开，页面都应当照常工作。

旧实现把页面绑在「当前打开任务 → 它的 PSB 会话」上。PSB 的 agent 会话终态**不可逆**，于是
会话一落定，页面就读不到状态、点「启动」被 PSB 拒（「agent 会话已结束」）—— 一个纯观看需求
被用户任务的生命周期连坐。会话侧链路（`psb:` transport、发送时透明重建）解决的是「用户消息
怎么送达」，与这里的「画面怎么看」是两件事，不能共用一条会话。

因此新增**工作区级**一层：契约 `shared/psb-workspace-admin.ts`，实现
`main/remote-workspace/adminService.ts`（纯逻辑）+ `adminRuntime.ts`（宿主装配）。渲染层页面
只用这组桥方法，不再自己拼「当前任务的 psb 会话」。

### 11.2 当前工作区怎么解析（`adminContext`）

入参只有 `localSessionId`（当前打开的任务，可为空）。**工作区解析完全在 main**，渲染层不传
`remoteHostId` / `workspaceId`（那些是主进程的事实，传进来只会成为可伪造的输入）。

1. 该任务行的 `remoteHostId` 是 `psb:` → 读它的 PSB 会话（`sessionStatus`）。**任何状态都算
   解析成功**（含 `stopped` / `failed`）：工作区行由会话自带，`source: 'session'`。
2. 读不到（PSB 已清记录 → 404/403，或网络失败）→ 用本机记录的 **`PSB 会话→工作区`映射**
   （见 11.5），`source: 'last-used'`。**不猜**工作区：映射也没有就退到 3。
3. 没有远程任务 / 不是远程任务 / 上一步也没线索 → 用**最近使用过的远程工作区**。
4. 都没有 → `context: null`（页面的空提示态）。**只有这一步才允许空态** —— 只要本机还有
   固定信息快照或会话行种子，就必须返回 `stale: true` 的上下文（2026-11-26 真机事故口径）。

**固定信息快照与 stale 降级（2026-11-26 真机事故修复）**：名称 / 模板 / 机器 / 目录名是
**固定信息**，占用 / 在线 / 桌面会话是**状态信息**。main 在实时读成功时把它们落盘到
`workspaceSnapshots[workspaceId]`（见 11.5），读不到时用快照构造同形状上下文：

- `PsbWorkspaceAdminContext.stale`（加性字段）：固定信息来自本机快照时为 `true`；
- `availability`：`'missing'` = PSB 工作区列表读成功但工作区已不在（被删 / 无权限）；
  `'unavailable'` = 读不到 PSB（网络 / 鉴权 / PSB 不可达）或当前任务的 PSB 会话读不到；
- `staleReason`：`list-failed` / `workspace-missing` / `session-unreadable` / `snapshot-only` /
  **`unknown-workspace`**（占位身份专用：只有目录名 / 会话标题这类启发式线索，连工作区 id 都
  没有；它不表示「PSB 读不到」的某种原因，而是身份事实，渲染层据此给「只能看到本机保存的信息」）；
- `snapshotSavedAt`：固定信息快照**第一次落盘**的时间（不是最近确认时间；见 11.5 的
  `savedAt` / `confirmedAt` 分工）；`workspaceIdKnown: false` = 占位身份（历史会话
  种子，写操作必须拒绝）；
- stale 时 `occupancy` 是未知（全空，渲染层显示「无法获取」）、`desktopSession` / `reasonCode`
  是 `null`、`viewerSessionId` 是 `null`；`lastErrorZh` 只放 PSB 原文做诊断；
- 历史会话兜底（2026-11-26 真机复验修正）：本机会话行有 `remoteHostId=psb:*` /
  `workingDir=/psb-remote/<目录名>` 时，**先**按目录名去实时工作区列表匹配（`directoryName`
  或 `title` 相同；会话详情对终态也有效，可读时优先用详情的 workspace id）；匹配到就返回
  live（名称 / 模板 / 机器 / 占用全部来自 PSB）。**这是启发式，结果只留内存**（日志记
  `inferred: true`）：**不写** `会话→工作区`映射、**不写**固定信息快照、**不推进**
  `lastWorkspaceId`。只有 `sessionStatus` 详情返回的 workspace id 才是权威身份，才持久化映射；
  猜错的代价是把任务永久指向别人的工作区，远大于一次列表请求。
  列表读失败或确实匹配不到时才用降级种子：名称 = 目录名（**任务标题不是工作区名称，禁止冒充**；
  渲染层页头也把目录名当实例名、模板名只作次要信息，见 §9.7），
  机器 / 模板拿不到就留空；`workspaceIdKnown: false` 的占位身份拒绝写操作。列表刚失败时
  不再重复请求一次（避免双倍超时），种子带上 PSB 原话；
- 写操作闸门（2026-11-26 审查修复）：`streamStart` 在已知 stale / 占位身份时直接抛可行动失败，
  不再先打占用闸门：
  | 状态 | 失败码 | messageKey | 用户下一步 |
  | --- | --- | --- | --- |
  | 占位身份（`workspaceIdKnown:false`） | `WORKSPACE_ID_UNKNOWN` | `remoteWorkspace.admin.staleUnknownWorkspaceAction` | 重新打开一个远程工作区任务 |
  | 工作区已不在列表（`availability:'missing'`） | `WORKSPACE_MISSING` | `remoteWorkspace.admin.staleMissingAction` | 换工作区 / 找管理员 |
  | 读不到 PSB（`availability:'unavailable'`） | `WORKSPACE_UNREACHABLE` | `remoteWorkspace.admin.staleUnavailableAction` | 查网络后重试 |
  `message` 只放 PSB 原文（可为空），main 不自写中文兜底。
  上表是 main 侧 `PsbRemoteFailure.code`；跨 IPC 由 `psbIpcCodeForFailure` 翻成 `PSB_` 命名空间码
  （`PSB_WORKSPACE_ID_UNKNOWN` / `PSB_WORKSPACE_MISSING` / `PSB_WORKSPACE_UNREACHABLE`，见 §9.2）。
  闸门带 `checkedAt` 与 **15s 信任窗**：结论够新才直接拒绝；过旧时先重新解析一次（服务器恢复后
  用户点「启动」应该能用，而不是被十几分钟前的失败永久拦住）。写路径的 PSB 失败也会**反向吸收**：
  `NOT_FOUND` / `FORBIDDEN` → `missing`、`PSB_UNREACHABLE` → `unavailable` —— 刚被 PSB 告知
  「工作区没了」之后不能还把它标成 live。`streamStatus` 对 stale 返回 `status: null`，不拿可能
  已死的绑定去打网络。

读 PSB 工作区列表失败但本机有记录时**不清空页面**：保留最后一次固定信息快照 / 会话行种子并把
PSB 原话放进 `lastErrorZh`（与 §5「读取失败保留最后一次快照」同一取舍）。工作区在列表里**确实
不存在**时只清**观看端绑定**与内存缓存，**保留** `会话→工作区`映射、`lastWorkspaceId` 与固定
信息快照 —— 页面仍要显示「当初是哪个工作区」，且下一次解析还要靠映射找回快照（2026-11-26
真机事故：旧实现清掉后整页变空态）。

**桌面会话状态**（`desktopSession` / `reasonCode` / `lastErrorZh`）取工作区级 `stream/status`。
PSB 把这条读数挂在会话路径上，所以 main 借**观看端绑定里的那条会话 id** 去问：正常是工作区级
`stream/subscribe` 返回的**桌面访问会话** id，旧 PSB 的过渡回退时是内部 Agent 会话 id（两条
路由 PSB 都接受，见 §11.7）。**不再借用户任务的 agent 会话读状态**（PSB 0.1.172：新代码只走
工作区级绑定），也不拿终态会话做探针。读不到时 `desktopSession` 是 `null`（未知），**不是**
`none` —— 把「不知道」显示成「没有桌面会话」会把网络抖动误导成用户要去 PSB 网页操作。

**读路径只用绑定 id，绝不订阅、绝不创建会话（2026-11-26）**：应用重启后内存绑定全丢，此时
**只复用本机记录里的绑定 id**（`<userData>/psb-remote-workspace-admin.json` 的
`desktopSessions[workspaceId]`，见 11.5）发一次只读 HTTP `stream/status`，不订阅、不占观看名额。
没有绑定（用户还没点过「启动」/重启后无记录）就返回 `status: null`，**不为了读状态去订阅或建
会话**：订阅会占观看名额，建会话属于工作区写操作（写前占用闸门会把它顺带占用为当前身份）——
打开「远程工作区」页签就静默占用一个空闲工作区是不可接受的副作用（2026-11-26 审查发现的原实现
正是这种「读着读着就占用」）。代价是「首次打开页面」`desktopSession` 是 `null`（未知）：用户显式
点一次「启动」才建立绑定并落盘，之后重启 / 重开页面就能靠记录自动读到状态。

- 读数失败（绑定会话已不存在 / 网络）**不抛错**：PSB 明确回 404/403 时**清掉绑定与记录**
  （下次启动重新订阅），网络失败保留记录（下次可能就好了）；`status` 仍是 `null`（未知），
  上下文照常返回工作区信息；
- `ADMIN_STREAM_STATUS` 的返回值仍带 `viewerSessionId`（加性字段）：本次读数所用的绑定会话 id
  （只来自内存绑定 / 本机记录，没有则 `null`），渲染层可以立刻用它过滤 `ADMIN_STREAM_EVENT` /
  判断输入是否可发；
- 绑定 id 从 `null` 变为有值（记录命中并复用成功）时 main 会推一次 `CONTEXT_CHANGED`。

`CONTEXT_CHANGED` 只在 main「刚拿到新事实」且与**上次发出的完整上下文**不同时推送；载荷与
invoke 结果同形，渲染层直接替换状态。main 不轮询 PSB。串流事件驱动的上下文重读有**合并窗口**：
窗口内只重读一次，读取在途时只记一笔待刷新、不并发叠加（`adminService.ts` 的
`refreshContextQuietly`；代码注释里遗留的旧章节引用指的就是本节）。

**推送按窗口分桶（2026-11-26 独立审查修复）**：`CONTEXT_CHANGED` 是发给所有受信窗口的**广播**，
而每个窗口各自打开一个任务。旧实现用两个全局量：全局「最近一次读取用的 `localSessionId`」与单一
推送基线。前者让后读取的窗口改写全局 id，随后广播出的上下文标成**它**的任务；后者让两个窗口
交替读取时互相把对方的值当成「上一次」，推送要么丢要么错标。现在：

- `adminContext` 把入参固化到本次调用的局部变量，**不写任何全局「最近 id」**；
- 推送基线与去重按 `localSessionId` **分桶**（无任务线索的兜底解析单独一桶），
  `CONTEXT_CHANGED` 载荷仍是 `{ context, localSessionId }`（加性字段），渲染层
  `useWorkspaceAdminContext` 按 id 过滤：不匹配丢弃，`null` 桶任何窗口都接受；
- 动作后的刷新目标由调用方显式给出：`streamStart` / `streamStop` / `streamStatus` 接受可选
  `{ localSessionId }`（ipc 层透传发起动作的窗口；不传也能工作），main 刷新「发起窗口的桶 +
  所有上次解析到该工作区的桶」；串流事件驱动的刷新同样只碰相关桶。不再读「全局最近 id」，
  于是打开别的任务 / 工作区的窗口不会被刷成别人的工作区。
- evict / 重建仍按工作区，不影响上述过滤。

### 11.3 工作区级订阅与观看端绑定（生命周期）

`adminStreamStart({ workspaceId, localSessionId? })` 的路径（2026-11-26 起，PSB 0.1.172 服务接口）：

1. **占用闸门**：`remote().ensureWorkspaceLocked(workspaceId)`（订阅/回退建会话都是工作区写操作，
   见 §13）。失败即返回可行动原因，不建立订阅。
2. **拿绑定**（`ensureBinding`）：内存绑定 → 本机记录里的绑定 id ✓ **先读一次 `stream/status`
   确认还能用** → 都不可用才调用 `POST /api/cindy/remote/workspaces/:id/stream/subscribe`。
   订阅返回的 `sessionId` 是**桌面访问会话** id（不是 agent 会话），绑定立刻落盘（11.5）。
   同一工作区的并发启动共享一次「拿绑定」（in-flight map），不会订阅出两条绑定 / 建出两条内部
   会话。
3. **起观看端**：`startStream(绑定会话 id)`。失败时只有**明确指向会话失效**（404/409/410、
   `NOT_FOUND` / `FORBIDDEN` / `PSB_STREAM_NOT_READY`）才丢掉绑定、重新订阅并重试一次（访问会话
   被重建的竞态）；鉴权 / 网络 / 客户端不支持串流**原样上抛**，不重试。
4. **提交状态**：`binding.status` 更新、`CONTEXT_CHANGED` 重读推送、返回
   `{ status, workspaceId, viewerSessionId }`（`viewerSessionId` = 桌面访问会话 id）。

**多窗口复用已有连接（2026-11-27 复审 P1）**：进程内只有一个观看端实例，`startStream` 的语义是
原子替换旧连接并补发 `closed(superseded)`。第二个窗口点「启动」时若绑定 `viewerActive === true`，
直接复用当前连接并返回现有状态（不重连、不产生 `superseded`），这次启动只表示多一个 owner
（IPC 层 +1）；连接真的断了（`closed` / `error` / 显式停止）才清 `viewerActive`，下次重新
`startStream`。

其余口径：

- **启动 / 停止按工作区串行 + 代次（2026-11-26 审查修复）**：同一工作区的 `adminStreamStart` /
  `adminStreamStop` 进同一条串行队列；`streamStop` 在**入队前**推进该工作区的操作代次，
  `streamStart` 落定（拿到启动结果）后发现代次变了就**自己停掉**刚起的串流并返回未启动状态，
  随后排队的 stop 视为已完成、不重复停。用户快速「启动→停止」不会出现「停止返回后画面又起来」。
  这条互斥在服务内部完成，ipc / index 不需要额外 helper。
- **重复启动复用绑定**：先读绑定状态，正常就复用同一条桌面访问会话（不重复订阅、不重建任何
  会话）；PSB 说它已不可用时才重新订阅。已有健康观看连接时连观看端也不重连（见上）。**停止只断
  本端观看**（`adminStreamStop` 调 `stopStream`），绑定保留供下次复用；**多窗口按 owner 引用
  计数**（`streamOwners.ts`）：`start` +1、`stop` / 窗口销毁 -1，**集合归零才停流**；`starting`
  相位卸载的停止由 IPC 的「启动在途停止」标记兜住（见 §15.3）。
- **桌面访问被重建**：旧绑定 id 读不到 → 丢掉绑定与本机记录，下一次启动重新订阅拿新 id
  （PSB 契约：订阅没有 `expiresAt`，不要把它当长期句柄）。
- **桌面访问启动**：CINDY-RW-17 起启动串流**必经** `ensureWorkspaceAccess`（读 access → 终态才
  `POST access/start` → 轮询到 running，默认 90s 预算；见 §11.8），失败带码抛出、不会带着「访问
  没起来」去订阅；旧 PSB（404/405/`UNIMPLEMENTED`）才退回直接订阅，此时 409 `NO_RUNNING_SESSION`
  仍按 `details.state` 给可行动文案。它不会降级去建会话。
- **过渡回退（仅旧 PSB）**：订阅端点 404/405/`UNSUPPORTED` → 允许临时回退创建**内部 Agent
  会话**，必须 `purpose:'internal'` + 标题 `PSB_ADMIN_INTERNAL_STREAM_SESSION_TITLE`
  （`Cindy 观看端 · 内部串流订阅`）+ warn 日志；新端点可用时永不执行。详见 §11.7。
  **回退会话必须收尸（2026-11-26 审查修复）**：创建成功后若起观看端失败 → best-effort
  `stopSession` 回滚并清掉本机绑定；PSB 说这条会话已结束 → 丢掉绑定并结束内部会话；工作区级
  订阅成功（服务端已支持新端点）或绑定被判定失效时，按 TTL / 失效清理本进程记录的旧回退会话
  （不再被任何绑定引用立即清，仍被引用则等 TTL）。端口上没有 `stopSession` 的旧装配跳过收尸。
- **清理点**：工作区不可见（删/无权限）→ 丢掉内存绑定与本机记录；PSB 说绑定会话结束
  （`closed.reason` ∈ `session-ended` / `session-not-found`）→ 丢掉绑定与本机记录，**下一次启动**
  重新订阅；读状态发现绑定已失效同样只清记录、不订阅（读路径，见 §11.2）；账号边界换 PSB 服务
  实例 → 服务自己按实例身份清空内存绑定与推送基线，本机记录保留——下一次启动会把记录里的 id
  交给新实例校验，新账号看不到它时（404/403）清掉并重新订阅。
  **应用退出不主动停远端任何会话**：桌面访问会话归 PSB 与用户管理（PSB 网页可停），Cindy 只断
  本端观看连接；唯一例外是过渡回退创建的内部观看端会话（它只为本端观看存在，见上条收尸口径）。
- **串流事件**：观看端事件按 `sessionId` 过滤，只有绑定会话的事件经
  `psb-remote:admin-stream-event` 转发（`frame/status/cursor/closed/error` 复用 `PsbStreamEvent`，
  渲染层按 `context.viewerSessionId` 过滤）；`closed.detail` 的 `reasonCode` / `desktopSession`
  会写回管理页状态，随后触发一次合并后的上下文重读（§11.2「合并窗口」的「在途不并发、丢通知
  不丢事实」）。本端主动关闭的 `closed(client-stopped)` / `closed(superseded)` 只发给该
  `viewerSessionId` 的 owner；main 内部收尸（重建前旧连接 / 代次自停）补发的
  `closed(client-stopped)` 不转发（`quietStreamStops`，见 §15.3）。
  `cursor`（宿主光标形状）只透传给渲染层映射成**宿主风格 CSS 关键字**（只在画面区域生效），没有
  管理页状态、也不触发上下文重读
  （契约见 §12.9）。用户任务会话**没有**会话级串流通道（4 invoke + 1 push 已删）：观看端事件只走
  工作区级 `ADMIN_STREAM_EVENT`。
- **渲染层面板状态机与保活（2026-11-26 独立审查 r4）**：`useAdminStreamSession` 用显式联合态
  `idle / starting / connecting / waiting-frame / streaming / stopping / error` 取代旧 5 个布尔；
  `streaming` 只由 `frame` 事件进入（PSB `active` 不参与），`connecting` = 已订阅未首帧、
  `waiting-frame` = PSB 明确说此刻没有采集。**分类切换保活**：切「版本控制 / 设置」只 `hidden`
  不卸载连接区，已建立串流继续；只有页签不可见 / 关闭 / 换工作区才释放名额（旧实现按分类卸载
  并静默停播）。**多窗口收敛**：本端 `closed(superseded)` 是**非终态**（同会话新连接继续送帧，
  保留相位、不清屏、不释放 owner），只有 `closed(client-stopped)` / 远端关闭才回 `idle`；绑定从
  有变无 / 换了、首帧 **20s watchdog**（`FIRST_FRAME_TIMEOUT_MS`）读一次状态仍无绑定 → 回 `idle`
  （不循环、不自动重连）；**输入上行失败**按 5s 节流（`INPUT_FAILURE_THROTTLE_MS`）提示一次并回
  `idle`；进页时历史 `lastError` 只登记、不产红条。
- **`viewerSessionId` 语义（字段名不变）**：正常是**桌面访问会话** id；只有旧 PSB 的过渡回退才
  是内部 Agent 会话 id。渲染层只做等值过滤，不做 id 形状判断。

### 11.4 IPC 面（6 invoke + 2 推送）

| 通道 | 方向 | 语义 |
| --- | --- | --- |
| `psb-remote:admin-context` | invoke | `{ localSessionId? }` → `{ context: PsbWorkspaceAdminContext \| null }` |
| `psb-remote:admin-stream-start` | invoke | `{ workspaceId, localSessionId? }` → `{ status, workspaceId, viewerSessionId }`（`localSessionId` 可选：只用于把 `CONTEXT_CHANGED` / 串流动作记到发起窗口的桶，不是身份字段） |
| `psb-remote:admin-stream-stop` | invoke | `{ workspaceId, localSessionId? }` → `void`（幂等，只停观看） |
| `psb-remote:admin-stream-status` | invoke | `{ workspaceId, localSessionId? }` → `{ status: PsbWorkspaceAdminStreamStatus \| null, viewerSessionId: string \| null }`（**只用绑定里的会话 id**：内存绑定 / 本机记录里的 `desktopSessions[workspaceId]`；**不订阅、不创建会话、不占用工作区**；见 §11.2） |
| `psb-remote:admin-stream-input` | invoke | `{ workspaceId, event }` → `void`（键鼠输入，见 §12.2） |
| `psb-remote:admin-stream-capture` | invoke | `{ active, workspaceId? }` → `void`（捕获态开关，见 §12.4） |
| `psb-remote:admin-context-changed` | push | `{ context, localSessionId: string \| null }`（`context` 与 invoke 结果同形；`localSessionId` 供渲染层按窗口过滤，见 §11.2） |
| `psb-remote:admin-stream-event` | push | `PsbStreamEvent`（`sessionId` = 观看端绑定会话：正常是桌面访问会话 id，旧 PSB 过渡回退是内部 Agent 会话 id；含 `frame/status/cursor/closed/error`，`cursor` 见 §12.9） |

- **`status: null` 不是「不支持串流」**：`ADMIN_STREAM_STATUS` 读不到 PSB 状态时返回 `null`，渲染层
  不得据此禁用「启动」（`capability` 只在真的读到状态时才有意义）。这是本轮最容易写错的一处：
  把「读不到」当 `capability: false` 会让按钮永久不可用，正是本批要修的退化。
- 失败仍用 §9.2 的 `PSB_ 命名空间化错误码` 与 `throwIpcError`；payload 校验在 handler 内，
  校验通过才产生副作用；`message` 不含 token/身份字段。
- preload 桥方法：`adminContext` / `onAdminContextChanged` / `adminStreamStart` /
  `adminStreamStop` / `adminStreamStatus` / `adminStreamInput` / `setAdminStreamCaptureActive` /
  `onAdminStreamEvent`（渲染层窄入口
  `PsbRemoteBridge` 的接口同步，`psbRemoteIpcWiring.guard.test.ts` 的
  `ADMIN_BRIDGE_METHODS` 守两边一致）。

### 11.5 本机持久化（最近工作区 + 会话映射 + 观看端绑定 + 固定信息快照）

落点 `<userData>/psb-remote-workspace-admin.json`（走既有 `createOverrideSettingsFile`：原子
替换、跨进程锁、64 KB 上限），内容四项。**没有 `version` 字段**（2026-11-26 审查）：写路径
`writePatch` 会删掉与默认值相等的键，而 `version` 恒等于默认值，所以它**永远落不了盘**；
现在这份文件走**加性演进**——新字段可选、读取时缺省按旧行为归一，语义变更换新键
（`viewers` → `desktopSessions`），旧文件里的 `version` 读取时忽略：

- `lastWorkspaceId`：没有远程任务时页面的默认对象，重启后仍然生效；
- `sessions[{ sessionId, workspaceId }]`：**agent** PSB 会话读不到时兜底解析工作区，容量 32、
  最近的在前、超出淘汰最旧。**只有 `sessionStatus` 详情读成功（或会话启动那一刻）才写**；
  按目录名 / 标题的启发式匹配不写这张表（猜错会把这个任务永久指向别人的工作区）；
- `desktopSessions[{ workspaceId, sessionId }]`：该工作区**观看端绑定**的会话 id，容量 16、最近的
  在前。正常是工作区级 `stream/subscribe` 返回的**桌面访问会话** id；旧 PSB 的过渡回退是内部
  Agent 会话 id。它是「重启后复用同一条桌面访问会话 + 只读地读 `stream/status`」的唯一依据；
  **不按标题认领** `listSessions` 里的会话——那是全工作区可见范围，可能含别人的会话。
- `workspaceSnapshots[{ workspaceId, title, templateTitle, clientName, directoryName, savedAt,
  confirmedAt }]`（2026-11-26 真机事故后新增）：固定信息快照，容量 16、按 `workspaceId` 幂等
  （同 id 只留一条，重复行保留 `confirmedAt` 最新的那条）。**只存固定字段**，不存占用 / 在线 /
  工作区状态 / 桌面会话这类易变信息（2026-11-26 审查：旧实现把 `clientOnline` / `state` 也存了，
  这两个字段每 30 秒都可能变，导致「值没变就不写」的比较永远不等、每次读页面都整份重写文件）。
  `savedAt` = **第一次落盘**的时间（后续重写不推进）；`confirmedAt` = 最近一次落盘时固定信息被
  PSB 确认的时间。排序 / 「最近确认过」用 `confirmedAt`；坏行（两个时间都不可解析）**直接丢弃**，
  不伪造 1970 的时间去抢兜底位。写入点：`createSession` 成功（工作区会话启动那一刻）、
  占用 / 释放成功、`adminContext` 实时读成功、目录启发式命中后用户占用成功（PSB 已确认工作区
  存在）；固定字段不变时 **0 次写**；损坏行只丢该行、读坏整份文件回空记录。

> **JSON 键变更（2026-11-26）**：由 `viewers` 改为 `desktopSessions`。旧值是「我们自己创建的内部
> 观看端 Agent 会话」，语义已作废（那正是用户事故里不该出现在会话列表的行）；新代码按新键读，
> 旧数据自然丢弃——**不迁移、不复用旧 Agent 会话**（下次启动会重新订阅拿桌面访问会话）。
> `workspaceSnapshots` 是加性键：旧文件没有它就按空快照读，下一次实时读取会重新写入。
> 旧文件里残留的 `clientOnline` / `state` / `version` 读取时归一忽略，不影响其它字段。

为什么不用 DB 新列：加列要 migration（会阻断 dev 实例、也让发版多一道协调），而这份记录是
**可丢的展示偏好**——丢了只回到「本机无快照」的旧行为，不损坏用户数据。写纪律：所有写入口
**幂等**，值不变 0 次写；管理页读路径会推进一次「最近使用」与固定信息快照，但写次数不随
轮询/刷新增长，也**不会**因为读状态写绑定记录（绑定只在用户显式「启动」并真的订阅出会话时写）。
实现上生产读写单例在 `main/remote-workspace/adminRecentRuntime.ts`：管理页服务与 PSB 远程服务
（`index.ts` 的会话创建 / 占用写入点）**共用同一个 store 实例**，避免两个实例各缓存整份 JSON、
覆盖写互相丢字段。

### 11.6 验证方式

- 定向单测：`main/remote-workspace/__tests__/psbWorkspaceAdminService.test.ts`（工作区解析六个
  分支、占用/在线/桌面会话映射、**无绑定启动 → 订阅一次 + 用桌面访问会话 id 起观看端 +
  `createSession` 零调用**、重复启动复用绑定（只订阅一次）、失效后重新订阅、起观看端时的
  会话失效竞态重试一次、网络失败不重试、旧 PSB 的三种「端点不可用」回退（`purpose:'internal'`
  + 内部用途标题 + warn）、`409 NO_RUNNING_SESSION` 不建会话、事件过滤与上下文推送、`status: null`
  语义、记录容量与幂等写（`desktopSessions`）、账号边界丢绑定、键鼠输入转发与「没有活动连接」
  失败、**读路径不订阅 / 不建会话 / 不占用**：`adminContext` / `adminStreamStatus` 在无绑定时
  返回 `null` 且订阅 / `createSession` / 占用闸门调用次数为 0、记录命中时只读复用、记录里的
  绑定失效时清记录不重建、`viewerSessionId` 变化推送）。多窗口复用同一条健康观看连接（不重连 /
  不产生 `superseded`）、内部收尸的 `closed(client-stopped)` 不转发、用户显式停止照常转发；
  `psbAdminStreamOwnership.test.ts` 用真实 handler + 推送覆盖两窗口只停一次、`starting` 相位卸载
  收流、主动关闭只发 owner。
- 固定信息快照 / stale 降级（2026-11-26 真机事故修复，同一测试文件）：live 读取写入快照且同值
  0 次写、**固定字段相同但旧文件带 `clientOnline` / `state` 时也 0 次写**、目录名反查、
  损坏行 / 容量上限、`savedAt` 保留首次落盘而 `confirmedAt` 在重写时推进、
  `latestWorkspaceSnapshot` 按时间而不是数组顺序、坏行两个时间都不可解析时丢弃（不出现 1970）、
  本机 JSON 不写 `version` 且旧 `version` 被忽略；PSB 读不到时用快照构造 `stale: true` /
  `availability: 'unavailable'` 的上下文（名称 / 模板 / 机器不变、占用与桌面会话未知）、工作区
  被删返回 `availability: 'missing'` 且只清易变记录、历史会话（无快照 / 无映射）用
  `/psb-remote/<目录>` 的 **目录名**作种子（目录名命中本机快照就取快照的固定信息；
  **任务标题不参与命名**）、`streamStart` 在 stale 时直接可行动失败（0 次占用闸门 / 0 次订阅）；
  renderer 侧 `RemoteWorkspaceAdminPanel.test.tsx` 覆盖「stale 仍显示名称 / 模板 · 机器、不出现
  『还没有远程工作区』、降级说明条、stale 下启动 / 占用给可行动文案且不发 IPC」。
- **多窗口 / 写闸门新鲜度 / 启发式持久化 / 回退收尸 / 启停互斥 / ensure 位置（2026-11-26 独立
  审查修复，同一测试文件）**：两个窗口各读不同任务 → 推送基线分桶、窗口 watchdog 重读不产生
  错标推送；串流动作只刷新发起窗口的桶与同工作区桶（另一个窗口不被刷成别人的工作区）；
  stale 结论过旧时 `streamStart` 重新解析（服务器恢复后能启动，旧结论新鲜时直接给码）、写路径
  `NOT_FOUND` 被吸收后第二次启动给 `WORKSPACE_MISSING` 且不再打 PSB、占位身份给
  `WORKSPACE_ID_UNKNOWN` + `unknown-workspace`；目录启发式命中不写会话映射 / 快照（占用成功
  确认后才落快照，映射仍不写）；回退内部会话起观看端失败 → `stopSession` 回滚、PSB 说会话结束
  → 结束内部会话、新订阅成功后按 TTL 清理旧回退会话；启动未落定时点停止 → 自动停掉刚起的
  串流、排队 stop 不重复停；启动串流前**必经** ensure 访问（闸门 → ensure → 订阅的顺序）、
  ensure 未占用 / 被他人占用 / 超时 / 端口违约时**不订阅**、旧 PSB `unsupported` 退回直接订阅；
  `context` 读会话行线索抛错时退化到最近使用工作区而不向上抛。
- `main/remote-workspace/__tests__/psbClient.test.ts` 补新契约：工作区级订阅的路径 / 方法 /
  `{ sessionId, streamPath?, subscriberId?, expiresAt? }` 解析、缺 `sessionId` 判 `PSB_PROTOCOL`、
  409 `NO_RUNNING_SESSION` 保留 PSB 可读原因、`createSession` 省略 `purpose` 时不带该字段 /
  `purpose:'internal'` 原样带出。
- 接线守卫：`psbRemoteIpcWiring.guard.test.ts` 的 `ADMIN_BRIDGE_METHODS`（通道 ↔ 桥方法 ↔
  handler，且两组通道值不重名；另守输入事件共享校验器与捕获态自救允许清单没有被绕过）。
- 宿主光标形状（`stream.cursor`，见 §12.9）：`shared/__tests__/psbRemoteWorkspaceStreamCursor.test.ts`
  （帧校验 / 关键字映射与未知回退 / **PSB shared 测试移植的四类映射、别名、容错、非法形状用例** /
  映射表 64 条别名与 36 个关键字计数 / 不生成位图 data URL）与
  `__tests__/streamViewer.test.ts` 的 cursor 用例
  （文本帧 → `{type:'cursor'}`、同 serial 去重、serial 回退照常 emit、`start`/`stop` 重置、文本帧
  不进二进制帧路径）；`psbWorkspaceAdminService.test.ts` 另钉住「只转发绑定会话的 cursor 事件」。
- 交互输入 / 捕获态：`__tests__/psbStreamInputEvent.test.ts`（事件形状与 4KiB 边界）、
  `__tests__/streamCapture.test.ts`（抑制清单、恢复路径、回滚）、`__tests__/streamViewer.test.ts`
  （上行只有 input 帧、每观看端 UUIDv4 `subscriberId`、`sendInput` 失败码、`errors=frame` 新关闭码）。
- 真机已通过（旧实现）：用户任务终态后 `adminContext` 仍返回工作区与画面；键鼠输入真的驱动远端
  （本机指针进入画面 / 全屏后按键与滚轮在远端生效，见 §12.7）；全屏时 Ctrl+R 不再作用到宿主
  （§12.7），F5/F11/F12 与开发者工具组合的放行仍待真机走查。
- 真机待验证（2026-11-26 工作区级订阅改版）：**启动串流后 PSB 会话列表只有用户任务**
  （不再出现「Cindy 观看端」行，也不增加到 `sessionCount`）；**本机记录里有绑定**的那次重启后
  首次打开「远程工作区」页，`adminContext.desktopSession` 能读到、`adminStreamStatus` 返回带
  `viewerSessionId` 的状态（值为桌面访问会话 id）；**从未启动过观看**时读路径不订阅不建会话
  （`status: null`、不占用工作区），点「启动」才订阅、切走页签自动停止、回来是未启动态
  （旧「自动恢复画面」结论已随口径作废）；旧 PSB（端点 404/405/`UNSUPPORTED`）的过渡回退路径
  端到端可用且 `purpose:'internal'` 会话不可见。以上目前只有单测。

### 11.7 工作区级订阅契约与过渡回退（2026-11-26 已适配）

> 这条记录**新契约事实 + 过渡兜底规则**。曾经的「已知偏差：工作区级订阅未适配」已于 2026-11-26
> 消除（见 §11.2 / §11.3 / §11.5），不要再把内部 Agent 会话写成最终设计。

**契约事实（PSB 0.1.172，字段级正本在 PSB 仓 `协作需求.md`，稳定摘要见
[跨仓契约摘要](../collaboration/psb-remote-workspace-contract.md) §1.3 / §1.6）**：

1. **新端点**：`POST /api/cindy/remote/workspaces/:workspaceId/stream/subscribe`（Bearer 鉴权）。
   语义是解析该工作区当前 `running` 的**桌面访问会话**（`remote_sessions.id`）并返回
   `{ workspaceId, sessionId, streamPath?, subscriberId?, expiresAt? }`；**不创建任何 Agent 会话**、
   不写库。`sessionId` 不是 agent 会话 id。
2. **没有 running 访问会话**：`409` + `error.details.code = NO_RUNNING_SESSION`
   （`details.state` ∈ `none` / `starting` / `stopping` / `stopped` / `failed`）+ 一句可行动中文
   （先 `POST …/access/start`）。订阅**不会**自动拉起访问。其它错误：`401`、`404`（工作区不存在 /
   不可见）、`403`（看得见但不可管）、`400`（参数形状非法）。Cindy 对这条 409 的解析、跨 IPC 码
   与 UI 处置见 **§11.8**。
3. **没有 `expiresAt`**：订阅生命周期 = 观看端 WS 连接，服务端不发票据；桌面访问被重建后按工作区
   语义重新调一次拿新 id（不要把 `sessionId` 当长期句柄保存——Cindy 只把它当「当前观看绑定」持久化，
   失效就重新订阅）。
4. **观看端 WS 与 `stream/status`**：既有路由保持不变，过渡期同时接受 agent 会话 id 与桌面访问
   会话 id；Cindy 的新代码只用桌面访问会话 id（旧 PSB 回退时才用内部 agent 会话 id）。
5. **`purpose`（会话用途）**：`POST …/workspaces/:id/sessions` 新增可选字段；省略 = `agent`
   （用户任务）；`internal` = 接入端服务用途（**默认不进会话列表 / 不计入 `sessionCount`**，
   详情 / 停止 / 转录照旧）；其它值 PSB 回 400。Cindy 的用户任务路径**从不显式传** `purpose`。

**Cindy 实现要点**：`psbClient.subscribeWorkspaceStream(workspaceId)` 是唯一调用点（解析 DTO，
缺 `sessionId` 判 `PSB_PROTOCOL`，错误按常规 `PsbClientError` 保留 PSB 可读原因）；
`adminService` 的状态机见 §11.3；绑定持久化见 §11.5；`viewerSessionId` 字段语义见 §11.3。

**过渡回退（临时止血，不是长期方案）**：仅当订阅端点**不可用**——HTTP 404 / 405 或错误码
`UNSUPPORTED` / `NOT_IMPLEMENTED` / `ROUTE_NOT_FOUND`（旧 PSB 没有这条路由）——才允许回退到
「内部 Agent 会话」充当观看端，且必须同时满足：

- 创建请求带 `purpose: 'internal'`（PSB 默认不进列表 / 不计入 `sessionCount`；其它值 400）；
- 标题用 `PSB_ADMIN_INTERNAL_STREAM_SESSION_TITLE`（`Cindy 观看端 · 内部串流订阅`），
  **不伪装成用户任务**；
- 记 warn 日志（`workspace-level stream subscribe is unavailable; falling back to an internal agent
  session`），让「用户还在跑旧服务端」可归因。

**其它失败一律不回退**：409 `NO_RUNNING_SESSION`、鉴权、网络、可读业务错误都原样上抛——它们不是
「端点不存在」，静默建会话只会掩盖真实原因（409 的正确下一步是去 PSB 网页启动桌面访问）。404 的
歧义由前一步的占用闸门消解：`ensureWorkspaceLocked` 已经确认工作区可见、就绪、由当前身份锁定，
所以订阅再回 404 只可能是路由不存在；万一工作区真的在这几毫秒内消失，回退建会话同样失败，
最终错误一致且**不会留下任何会话行**。

**退出条件**：等旧服务端灰度面收窄后删除回退分支、`PSB_ADMIN_INTERNAL_STREAM_SESSION_TITLE`
与 `createRequestId` 依赖，并同步本节与产品规则 §2.4。

### 11.8 桌面访问的启动：`access/start` 状态机、409 处置与临时失败呈现（CINDY-RW-17）

**口径（2026-11-27，PSB 0.1.183 测试环境已上线）**：Cindy 与 PSB 网页**同一条**启动访问链，
用户**不需要再去网页点一次**：

```
GET …/access → 终态（none / stopped / failed）才 POST …/access/start（幂等 ensure）
            → 轮询 GET …/access 到 running → POST …/stream/subscribe → 观看端 WS
```

`starting` 只轮询（不重复 POST）；`stopping` 等它落定再 POST；`running` 直接订阅。PSB 自 0.1.183
起在 `/api/cindy/remote/**` 放行 `access/start`，此前借用的通用网页 `/api/remote/**` 例外**已删除**
（`resolvePsbUrl` 只接受 Cindy 命名空间，见 §15.1）。

1. **客户端解析**（`main/remote-workspace/psbClient.ts`）：
   - `startWorkspaceAccess(workspaceId)`（`POST …/access/start`）解析 202 / 200 的**真实外壳**：
     202 `{data:{access:{state:'starting',session:{id,state}},state:'starting',sessionId,attached:false}}`；
     200 `{data:{access:{state:'running',…},state:'running',sessionId,attached:true}}`
     （`PsbWorkspaceAccessStartResult`；`state` / `sessionId` 缺省归一 `null`）。
   - `readWorkspaceAccess(workspaceId)`（`GET …/access`）只读 `data.access.state`（兼容顶层
     `state`）；未知词 → `null`（不猜成某个已知状态）。
   - `ensureWorkspaceAccess(workspaceId)` 是**网页同款状态机**，总预算 **90s deadline**
     （`PSB_ACCESS_POLL_DEFAULT = { attempts: 180, intervalMs: 500, totalMs: 90_000 }`；单次请求
     超时压到剩余预算内；单测注入 0 间隔 / 短预算）。**永不抛异常**，失败收敛成
     `{ok:false, reason, failure}`：`not-occupied`（403）/ `occupied-by-other`（409）/
     `unsupported`（404/405/`UNIMPLEMENTED`，旧 PSB）/ `timeout`（预算用尽，`failure` 带按最后
     观察状态的可行动码，如 `PSB_STREAM_ACCESS_STARTING`）/ `failed`（其它）。**fatal 语义由调用方
     决定**（`adminService.streamStart` 把它当闸门）。
2. **失败码与业务码提升**（`shared/psb-remote-workspace.ts`）：
   - 403 `WORKSPACE_NOT_OCCUPIED` → `PSB_WORKSPACE_NOT_OCCUPIED`（用户先确认占用再重试）；
   - 409 `WORKSPACE_OCCUPIED_BY_OTHER` → 带占用人名；409 `TOO_MANY_TUNNELS` →
     `PSB_TOO_MANY_TUNNELS` + `remoteWorkspace.error.tooManyTunnels`（关闭 / 停止其它远程会话后重试）；
   - 错误外壳是 `{ error: { code, message, details } }`，**可读中文在 `error.message`**（不是
     `messageZh`），保留为 `failure.message`；`details.code` 命中失败单表时提升为业务码
     （`resolvePsbFailureCode`）；两个具体码冲突时保留外层 `error.code`（REST 契约里它是权威位置）。
   - **agent-tunnel Upgrade 拒绝的外层是 `FORBIDDEN` / `CONFLICT`，业务码在 `error.details.code`**：
     `psbTunnel` 用同一份 `readPsbGuardFailurePromotion` 把 `WORKSPACE_NOT_OCCUPIED` /
     `WORKSPACE_OCCUPIED_BY_OTHER` / `AGENT_SESSION_ACTIVE` / `TOO_MANY_TUNNELS` 提升成
     `[PSB_*]` 业务码（`PsbTunnelError.code` = 跨 IPC 的业务码），用户看到的是可行动文案而不是
     泛化的 FORBIDDEN；其余 Upgrade 失败仍按状态码归因（§5 / §15.1）。
3. **启动串流接入点（必经路径）**：`adminService.streamStart` 顺序固定为
   「占用闸门（mine；空闲返回 `PSB_WORKSPACE_NOT_OCCUPIED`，由渲染层弹确认 → 用户确认 → 重试）→
   `ensureWorkspaceAccess`（**必经**，失败带码抛出、不订阅、不起观看端）→ 工作区级
   `stream/subscribe` → `streamViewer.start`」。只有旧 PSB 的 `unsupported` 才退回直接订阅
   （订阅的 409 会给可行动文案）。旧「能力位 / 后台预热 / 不阻塞启动」编排已删除：它建立在
   「Cindy 入口恒 403」的历史事实上，真机上会让启动永远拿不到访问。`streamStatus` / `context`
   **不为读 access 多发请求**：桌面访问状态仍由 `stream/status` 与 409 `details.state` 承载。
4. **渲染层呈现（2026-11-27 用户口径：临时提示不得占布局）**：
   - `starting` 期间控制条显示「**正在启动桌面访问…**」
     （`remoteWorkspace.admin.streamAccessStarting`），不再显示「正在连接串流」——后者会让用户
     以为本端连接卡住并反复点「启动」；
   - **所有临时失败 / 中性关闭说明走全局 toast**（`@/lib/toast`，绝对定位、自动消失，
     `ToastContainer` 覆盖所有受信窗口）：启动失败、`STARTING` / `STOPPING` / `NO_RUNNING_SESSION`、
     网络失败、停止失败、观看端被 PSB 关闭的原因。`none` 家族的「在网页启动访问」作为 toast 上的
     **动作按钮**（复用 `openWebWorkspace`），不再渲染 `border-b` + `shrink-0` 的内联条；
   - `WORKSPACE_NOT_OCCUPIED` **不产任何提示**：直接弹既有「占用工作区」确认框
     （`features/remote-workspace/occupyRequired.ts`）→ 确认后 occupy → 重试同一次启动；
     取消 → 不占用、不启动、不产常驻错误，状态收回「串流未启动」；
   - 布局里只保留**持久状态**：控制条上的串流未启动 / 正在启动桌面访问… / 已连接等待画面 /
     串流中、详情浮层字段与画面本身。
5. **回退与兼容**：旧 PSB（`access/start` 404/405/`UNIMPLEMENTED`）→ `unsupported` → 直接订阅并
   沿用既有 409 文案；旧装配端口没有 `ensureWorkspaceAccess` 时按旧路径订阅（生产装配一定有）。

**验证**：`main/remote-workspace/__tests__/psbClient.test.ts`（202 / 200 外壳、状态机六种入口、
403 / 409 码、预算超时、旧 PSB 404、`TOO_MANY_TUNNELS`、`details.code` 提升）、
`psbTunnel.test.ts`（Upgrade 403 / 409 的 `details.code` 提升）、
`psbWorkspaceAdminService.test.ts`（闸门 → ensure → 订阅顺序、ensure 失败不订阅、`unsupported`
回退、旧装配兼容）、`shared/__tests__/psbRemoteWorkspaceParsing.test.ts`（访问状态 / 202-200 外壳 /
业务码提升）、`renderer/features/remote-workspace/__tests__/psbFailureText.test.ts`
（`TOO_MANY_TUNNELS` 文案）、`renderer/features/remote-workspace/admin/__tests__/RemoteWorkspaceAdminPanel.test.tsx`
（启动等待文案、失败走 toast 不占布局、403 弹确认框且无内联条、取消无常驻错误、持久状态可见）。

## 12. 交互输入与全屏捕获（2026-11-26）

产品口径见 [产品规则](../product-rules/psb-remote-workspace-sessions.md) §2.4「可交互观看」与
「全屏 = 远端独占键鼠」；本节只记工程事实：通道、校验、`subscriberId`、非法帧删除、主进程
快捷键抑制与已知风险。

### 12.1 上行协议：只有 `input`，删除 `open` / `close`

PSB 观看端的订阅语义是**连上即订阅、断开即退订**。Cindy 早期按「加性协议」的猜测在上行发过
`{kind:'open'}` / `{kind:'close'}`，PSB 侧把这两个 kind 计入**非法消息**（2026-11-26 联调确认；
跨仓确认项见[契约摘要](../collaboration/psb-remote-workspace-contract.md) §1.4，旧口径已作废）。
本轮已删除：

- `streamViewer` 握手成功后**不再**发 `{kind:'open'}`（升级完成即视为已订阅）；
- `stop` / 重连替换 / `dispose` **不再**发 `{kind:'close'}`，直接用 `terminate()` 断开
  （名额立即释放；优雅关闭反而可能让旧连接多占一小段时间）；
- 本地状态机保持不变：启动代次（握手期间被 stop/dispose 取代就自己放弃）、
  `intentionallyClosed`（本端主动断开不推 `closed`）、4004 归因、订阅状态都不依赖控制帧。

单测钉住「升级后不发送任何非 input 文本帧」：`streamViewer.test.ts` 断言 `socket.sent` 在
start / 重连 / stop 全程为空，只有 `sendInput` 会写入 `{kind:'input', event}`。

**可选升级 `?errors=frame`（PSB 0.1.170，本轮不启用）**：订阅 URL 带该参数后，PSB 会先回 101，
再发一条 `stream.reject` 原因帧，并按 `4409`（名额满）/ `4001`（会话停止）/ `4404`（会话不存在）/
`4413`（控制冲突）/ `4412`（控制丢失）关闭；**不带该参数行为与旧版逐字节一致**。Cindy 暂不启用，
理由是目前 `closed.detail` 之外没有消费 `stream.reject` 的 UI/文案（见 §12.5），启用需要
渲染层同步加文案。main 已做的**最小加性**准备（不会有行为变化，因为这些码在未启用时不会出现）：

- `psbStreamClosedReason` 已识别新码：`4404 → session-not-found`、`4413 → control-conflict`、
  `4412 → control-lost`（`4409 → quota`、`4001 → session-ended` 本来就有）；
- `classifyStreamHandshakeClose` 对握手阶段的 4404 归因 `NOT_FOUND`、4413/4412 落
  `PSB_STREAM_NOT_READY`（不把新码错报成「不可达」）；
- 管理页服务对 `closed.reason === 'session-not-found'` 与 `session-ended` 同样丢掉观看端绑定
  （会话不存在不能继续用，下一步都是重新订阅）；
- `stream.reject` 文本帧目前按未知文本帧忽略（`handleTextMessage` 只认 `{kind:'status'}` 与
  `{type:'stream.cursor'}`；后者见 §12.9）。启用
  `errors=frame` 时需要在同一处解析它、把 `reasonCode` 并入 `closed.detail`，并给
  `control-conflict` / `control-lost` 补渲染层文案。

### 12.2 工作区级输入通道（`psb-remote:admin-stream-input`）

| 项 | 值 |
| --- | --- |
| 通道 | `PSB_ADMIN_CHANNELS.STREAM_INPUT` = `psb-remote:admin-stream-input` |
| 入参 | `{ workspaceId, event }`（`PsbWorkspaceAdminStreamInputRequest`） |
| 返回 | `void` |
| 桥方法 | `adminStreamInput({ workspaceId, event })` |

解析链（全部在 main）：`workspaceId → bindings 里的观看端绑定会话 → PsbRemoteService.sendStreamInput
→ streamViewer.sendInput → WS {kind:'input', event}`。**渲染层不传会话 id**：绑定会话是
main 的事实，传进来只会成为可伪造的输入。

**事件校验**（共享纯函数 `validatePsbStreamInputEvent`，IPC handler 在产生任何副作用之前调用）：

1. 必须是对象（非 `null` / 数组）且可 JSON 序列化；
2. `event.kind` ∈ `PSB_STREAM_INPUT_KINDS` = `pointermove` / `pointerdown` / `pointerup` /
   `wheel` / `keydown` / `keyup` / `relative`（未知 kind 说明渲染层在造新协议，共享中继会把它
   计成非法消息）；
3. **完整上行帧**（`{"kind":"input","event":…}`）序列化后 ≤ `PSB_STREAM_INPUT_MAX_FRAME_BYTES`
   （4096，PSB 中继硬限制）。按整帧而不是内层算，避免刚好超限的帧被放过去。

不校验 `x/y/button/key/deltaX/deltaY` 的必填与取值范围：PSB 网页观看端的完整输入 schema 仍是它
自己的事实（跨仓确认项见[契约摘要](../collaboration/psb-remote-workspace-contract.md) §1.5），
在这里猜字段只会把合法事件挡在门外。校验失败一律 `INVALID_PARAMS`，message 带具体原因
（不是先转发再失败）。

**「没有活动观看」的可行动失败**：没有观看端绑定（从没启动过）时由 `adminService.streamInput`
抛 `PsbClientError{ code:'PSB_STREAM_NOT_ACTIVE', messageKey:'remoteWorkspace.session.streamIdle' }`；
绑定存在但 WS 不在 OPEN（已停止 / 断开）时由 `streamViewer.sendInput` 抛同一个失败。跨 IPC 的
错误码是 **`PSB_STREAM_NOT_ACTIVE`**（`psbIpcCodeForFailure` 单独映射，不要并进
`PSB_STREAM_UNAVAILABLE`）：文案键 `remoteWorkspace.session.streamIdle`（「串流未启动」），
用户的下一步是「先启动观看」，不是「这台机器不能串流」。单测覆盖这两条路径。

输入是**高频路径**：`adminService.streamInput` 不重读上下文、不写最近使用记录、不打 info 日志。
渲染层应对 `pointermove` 做 rAF / 节流合并，并忽略个别 rejection（避免错误提示随鼠标移动刷屏）。

**渲染层保序（2026-11-26 独立审查修复）**：合并器 `PsbStreamInputPump` 是**唯一出口** —— 指针移动
走 `queueMove`（一帧至多一条 pointermove），按下 / 抬起 / 滚轮 / 键盘这些**边沿**必须走
`sendEdge()`：它先冲刷同一帧里待发的移动再发边沿，保证「先移动到 (x,y)、再按下」的顺序不会被写成
「先在旧位置按下、再移动」。输入采集 hook 里**不要再**直接 `sender.send(edgeEvent)` 绕过合并器。
定向测试：`admin/__tests__/RemoteWorkspaceAdminPanel.test.tsx` 断言同一帧里
`pointermove → pointerdown` 的 IPC 调用顺序。

**画布矩形不做缓存（2026-11-26 复审评估结论）**：每个指针事件里直接 `getBoundingClientRect()`。
Chromium 读的是本帧已布局结果（非强制同步布局），单次开销可忽略；缓存需要在窗口 resize、全屏
切换、右侧栏折叠/拖宽、画面上方浮层变化等处各自失效，漏一个就会点不准，而指针上行已被合并器
压到「一帧至多一条」，不存在上行压力。保持现取。

### 12.3 `subscriberId`（PSB 0.1.170：客户端 UUIDv4，一个观看端一个）

PSB 0.1.170 的正式口径（取代早期「用会话 id 派生」的猜测）：

- `subscriberId` 由**客户端生成 UUIDv4**，一个「观看端（观看会话）」一个；
- **重连必须复用同一 id**：同 id 重连 = **替换**旧订阅、不占新名额；换 id 才占新名额；
- 观看名额与浏览器页面**共用**，默认 4（部署级 `PSB_STREAM_MAX_SUBSCRIBERS`）；Cindy 的工作区级
  观看端（桌面访问会话订阅）占其中 1 个名额。

Cindy 侧实现（`streamViewer.ts`）：

- 生成点：**viewer 实例创建时**（`createPsbStreamViewer` 里调 `createSubscriberId`，生产 =
  `node:crypto.randomUUID`），该实例的所有 `start` / 重连 / 多个会话订阅共用同一个值；
- 「换观看端」= 重建 viewer 实例：账号边界 `disposePsbRemoteService()` 后下一次动作会装配新实例
  → 新 UUID（PSB 才会把它算作另一个订阅者）。进程重启同理（旧连接已断，名额由断开释放）；
- 携带方式：WS 升级 URL 的 query，`buildPsbStreamUrl(sessionId, subscriberId)` 产出
  `wss://<host>/api/cindy/remote/sessions/<id>/stream?subscriberId=<uuid>`。main 没有
  localStorage，而浏览器观看端的稳定 id 语义对 WS 而言唯一等价的载体就是 query（PSB 只要能被
  服务端读到即可）；若后续确认是 header 或其它名字，只改 `buildPsbStreamUrl` 一处；
- 单测钉住：同一实例重连/多会话复用同一 id、生成工厂每实例只调一次、新实例换新 id、生产工厂
  产出 UUIDv4。

### 12.4 全屏捕获态与主进程快捷键抑制（`psb-remote:admin-stream-capture`）

| 项 | 值 |
| --- | --- |
| 通道 | `PSB_ADMIN_CHANNELS.STREAM_CAPTURE` = `psb-remote:admin-stream-capture` |
| 入参 | `{ active: boolean, workspaceId?: string }`（`PsbWorkspaceAdminStreamCaptureRequest`） |
| 桥方法 | `setAdminStreamCaptureActive({ active, workspaceId? })` |

渲染层只在 `document.fullscreenElement === 画面容器`（或画面聚焦态）时发 `active:true`，退出全屏 /
页面卸载时发 `active:false`。main 侧实现分两层：

**状态机** `main/remote-workspace/streamCapture.ts`（不 import Electron，可单测）：
按 `webContents.id` 记捕获态；进入即 `setIgnoreMenuShortcuts(true)` 并挂 `before-input-event` 闸门；
退出 / 失焦 / 隐藏 / 关闭 / 页面消失 / 进程崩溃 / 显式释放全部收敛到同一个 `release()`（逆序卸载 +
无条件恢复 `setIgnoreMenuShortcuts(false)`，单个卸载失败不阻断恢复）。进入过程失败会回滚并抛出，
绝不留下「只装了抑制、没有恢复路径」的半态。

**接线** `streamCaptureRuntime.ts`：把 app-shortcut registry 的生效组合（用户改绑立刻生效）、
`webContents` 的 `before-input-event`、窗口 `blur`/`hide`/`closed`、`did-start-navigation`（主 frame
真实导航）/`render-process-gone`/`destroyed`、以及 `app.on('before-quit')` 接起来。捕获态**只作用于
发起 IPC 的那个窗口**，不影响其它窗口。

**抑制规则**（`psbStreamCaptureShouldSuppressInput`）：

- 只处理 `keyDown` / `keyUp`；鼠标事件不拦（渲染层要采集并转发）。
- 先判**自救允许清单**（共享判定 `psbStreamCaptureIsPassthroughInput`，与渲染层同一份）：
  `Escape`（退出全屏）、`F5`（刷新）、`F11`（宿主全屏惯例键）、`F12`（dev 的 DevTools 兜底），
  以及开发者工具组合：win/linux `Ctrl+Shift+I` / `J` / `C`，macOS `Cmd+Alt+I` / `J` / `C`。
  修饰键必须与平台口径完全一致（多按一个键的变体不算允许清单）。
- 再判「命中宿主快捷键」：app-shortcut registry 的当前生效组合（`close-tab-or-window` = mod+W、
  `browser-reload` = mod+R / F5、缩放、`new-maker` 等）＋ registry 之外的兜底
  `mod+Shift+R`（forceReload）。命中即 `event.preventDefault()`。
- 其余一律放行：普通字母 / 数字、`Ctrl+C`/`Ctrl+V` 这类编辑键、输入法组合键都照常进 renderer，
  由渲染层转发给远端（产品规则 §2.4 的「全部转发 + preventDefault」）。

**代价与边界**（写在这里避免下次当成 bug）：

- 被抑制的宿主组合**既不会触发宿主、也到不了 renderer**（`before-input-event` 的 `preventDefault`
  同时挡住页面 keydown），所以全屏时 mod+W / mod+N 这类键不会发给远端 —— 它们属于「宿主保留」。
  渲染层的「不转发清单」应与允许清单 + 宿主组合保持一致，不要向用户承诺这些键能操作远端。
- macOS 上 `setIgnoreMenuShortcuts(true)` 会一并忽略菜单 accelerator（含 Cmd+Q / Cmd+R / 缩放）。
  先按 `Escape` 退出全屏即可恢复；这是「远端独占键鼠」的预期行为。
- 窗口失焦即恢复原状（焦点回来后渲染层需重新发 `active:true` 才能继续独占），所以渲染层要在
  focus / fullscreenchange 时补发，不能只在进入全屏那一刻发一次。

### 12.5 已知风险与限制（PSB 权限模型）

PSB 0.1.172（2026-11-26）给出的事实，作为当前实现的边界写在这里：

- **名额**：观看名额与浏览器页面**共用**，默认 4（部署级 `PSB_STREAM_MAX_SUBSCRIBERS`）；
  Cindy 的工作区级观看端占 1 个；同 `subscriberId` 重连替换旧订阅、不占新名额（§12.3）。
- **输入权限 = 服务端权限模型（单控制者仲裁已取消）**：有权限的多个观看端**可以同时注入输入**。
  服务端判定：工作区被占用 → 占用人可控制；未被占用 → 已登录用户可控制；其它情况**只丢弃输入**、
  画面照旧。`role` / `takeover` 参数仍被解析（`takeover` 只进审计），`CONTROL_CONFLICT`(4413) /
  `CONTROL_LOST`(4412) 标为**协议保留、产品不再使用**。协商 `errors=frame` 时会先收到
  `stream.control` 原因帧（`CONTROL_FORBIDDEN` / `AUTH_EXPIRED`）；Cindy 当前未启用该协商。
- **输入限流**：目前只有「单条 ≤4KiB」，没有速率上限；main 侧对应常量
  `PSB_STREAM_INPUT_MAX_FRAME_BYTES`，渲染层仍需自行节流（见下）。
- **平台验证面**：Linux（`xdotool`）是 PSB 的生产验证路径；Windows（`SendInput`）尚未做生产
  验证，Windows 远端的输入行为不能按「已验证」承诺。
- **工作区级 subscribe 端点**：PSB 0.1.172 已上线，Cindy 已改用它（§11.7）；会话列表默认只装
  用户任务。

在此之上，Cindy 侧的已知风险：

- **权限模型不是客户端安全边界**：Cindy 默认允许交互、不做客户端互斥；服务端拒绝时只丢弃输入，
  Cindy 当前收不到拒绝原因（未启用 `errors=frame`），所以**不要**向用户承诺「多观看者互不干扰」。
  若产品需要只读观看，应由 PSB 用显式参数（如 `readonly=1`）+ 权限模型实现，不能恢复客户端猜测。
- **多观看者真机未验证**：多个观看端同时输入的实际表现（谁生效、是否互相抢占指针 / 键盘）还没有
  真机证据；单例「远程工作区」页签只是不主动开第二个可交互入口，不构成服务端约束。
- **输入没有回执**：`ws.send` 成功只代表写出，远端是否应用不可知；不要显示「已执行」这类文案。
- 4KiB 上限由 main 在 IPC 边界校验；若 PSB 收紧/放宽，同改 `PSB_STREAM_INPUT_MAX_FRAME_BYTES`。
- main 不做输入节流：节流属于采集端（渲染层），否则高频 `pointermove` 会把 IPC 与中继都压满。
- 键盘状态补发（失焦时补 `keyup`）在渲染层（产品规则 §2.4），main 不缓存按键状态。
- **`errors=frame` 未启用**（§12.1）：`stream.reject` / `stream.control` 原因帧未解析、
  `control-conflict` / `control-lost` 没有渲染层文案；启用前不要依赖这些码的用户可见归因。

### 12.6 验证方式

- `streamViewer.test.ts`：上行只有 input 帧（start / 重连 / stop 全程零控制帧）、**每观看端
  UUIDv4 `subscriberId`**（重连/多会话复用、生成工厂每实例一次、新实例换新、生产工厂是 v4 格式）、
  `sendInput` 的帧形状与 `PSB_STREAM_NOT_ACTIVE`、PSB 0.1.170 `errors=frame` 新关闭码
  （4404/4413/4412/4409/4001）的加性 token 归因，以及宿主光标形状（`stream.cursor` → cursor 事件、
  serial 去重（**回退不丢弃**）、`start`/`stop` 重置、文本帧不进入二进制帧路径；见 §12.9）。
- `psbStreamInputEvent.test.ts`：允许的 kind、未知 kind / 非对象 / 不可序列化拒绝、4096 字节边界。
- `streamCapture.test.ts`：抑制清单（registry + 兜底 + 自救允许清单 + 放行普通输入）、
  改绑即时生效、失焦 / 隐藏 / 页面消失自动恢复、重复调用幂等、进入失败回滚。
- `psbWorkspaceAdminService.test.ts`：输入按工作区解析到观看端绑定会话、高频路径不写盘、
  无绑定与 WS 断开的可行动失败、`session-not-found` 关闭后丢掉观看端绑定。
- **真机已通过**：全屏后本机 Ctrl+R / Ctrl+= 不再作用到宿主、真实 Esc 可退出全屏；远端真的收到
  指针 / 键盘 / 滚轮（点击远端编辑器触发原生对话框，见 §12.7）。
- **真机待验证**：F5/F11/F12 与开发者工具组合的放行、退出全屏后宿主快捷键恢复的完整走查；连续
  「启动 → 停止 → 启动」时 PSB 侧只看到一个 `subscriberId`（同 id 替换），浏览器页 + Cindy 同时
  观看不超过默认 4 个名额；Windows `SendInput` 路径（PSB 未生产验证）；多观看者同时输入的权限模型
  行为。
  **宿主光标形状（§12.9）**：远端文本区（I-beam）/ 窗口边缘（resize）/ 忙碌态（loading）下指针
  **形态**跟随变化且**外观保持宿主本机主题**（不是 Linux 主题位图）；指针移出画面后恢复宿主默认；
  HUD / 全屏退出按钮 / 控制条不受远端形状影响；停止观看后恢复宿主默认；全屏内同样只在画面区域
  生效（旧 PSB 客户端若不上报 `stream.cursor`，则保持宿主默认、不得伪造形状）。可用 DevTools 读
  `canvas.style.cursor` / `data-stream-cursor-keyword` / `data-stream-cursor-name` 取证。


### 12.7 真机验收（2026-11-26，测试部署 0.1.167 → 0.1.170）

- **手动启动（2026-11-26 新口径，0.1.172 后按工作区级订阅复验）**：应用重启后进入「远程连接」页，
  main 在没有观看端绑定时**什么都不做**（不订阅、不建会话、不占名额）；页面保持「串流未启动」，
  **点「启动」才走 `stream/subscribe` 建立绑定并订阅出画面**；切走页签自动 `adminStreamStop`
  释放名额，回来是未启动态。旧「应用重启后自动订阅 / 切回自动重订」结论**已作废**，按新口径复验
  （见 §11.6 的待复验项）。
- **交互输入**：渲染层采集（contain 坐标映射 / 滚轮归一 / 键盘修饰键与 release-all）→ `adminStreamInput`
  → 同一条 viewer WS 发 `{"kind":"input","event":…}`；真机点击远端 Unity 编辑器触发远端原生对话框。
- **全屏捕获**：`document.fullscreenElement===stage` 时键鼠捕获 + `setAdminStreamCaptureActive(true)`
  让 main 抑制宿主菜单 accelerator；Esc/F5/F11/F12 与开发者工具组合放行；退出全屏/失焦补 release-all。
- **subscriberId**：客户端 `randomUUID()`，一个观看端实例一个；重连复用（PSB 语义：同 id 替换、不占新名额）。
- **协议清理**：不再发送 `{kind:'open'|'close'}`；只发 `{kind:'input'}`（非法帧会被 PSB 计 invalidMessages）。
- **Electron accelerator 抑制已真机补验**：全屏捕获态下真实 `Ctrl+R`/`Ctrl+=` 未作用到宿主（页面未重载、缩放未变），真实 `Esc` 可退出全屏。仍待：Windows 注入路径（PSB 未验证）、多观看者输入（权限模型下未构造真机场景）、`errors=frame`（未启用）。


### 12.8 极简全屏 / 串流信息 / 停止清屏（2026-11-26 真机）

- 全屏：`document.fullscreenElement === stage` 时页面只渲染画面 + 右下角「退出全屏」图标按钮 +
  可选 HUD；控制条不渲染。退出走按钮或 Esc；全屏捕获与 `setAdminStreamCaptureActive` 不变。
- HUD：`串流信息` 开关（与 `详情` 并列）→ 右上角绝对定位面板；数据 = 本端 1s 帧数/字节数 +
  `psbStreamPlayer.getStats()`（解码耗时 avg/p95、丢帧、队列、解码错误）+ `adminStreamStatus`。
- 清屏：`psbStreamPlayer.clear()` 清 canvas 尺寸/内容与解码状态；stop/closed/error/切工作区/卸载都调用，
  未播放时 canvas `hidden`，再次播放重新 configure。**停止失败同样清屏（2026-11-26 独立审查修复）**：
  `adminStreamStop` reject 时也把本端复位成「未订阅 / 未流式」并 `clearPicture()`（手动停止与页签隐藏
  触发的自动停止两条路径都在 `finally` 里做），只留一条中性可行动提示
  `remoteWorkspace.session.stopFailed`（12 locale）；成功路径同时清掉上一轮的错误条。否则页签切走
  自动停止失败后再回来会看到「串流中 / 停止」按钮 + 冻结的上一帧。
- 工作区 webUrl：**列表口优先**（PSB 单行 GET 对 Cindy 恒 403），403/404/405 兜底；
  见工程契约 §3「工作区详情的读口」。

### 12.9 宿主光标形状同步（`stream.cursor` 文本帧 → 宿主风格 CSS 关键字，2026-11-26）

PSB 中继把客户端上报的宿主光标形状作为**文本帧**转发给同会话所有观看者（新订阅者会补发最近一次）。
Cindy 观看端据此让宿主指针随远端内容**变形态**（文本 I-beam / 按钮 pointer / resize / loading /
抓手…），与 PSB 网页串流同款。**外观永远是宿主（本机）指针风格**（用户 2026-11-26 明确口径）：
只把 XFixes 光标名映射成 CSS 关键字，不再把远端 PNG 拼成 `url("data:image/png…")` 自定义光标。
远端光标不烘进采集帧，Cindy 也不在画面里画假指针；位置永远用本机指针。

| 项 | 值 |
| --- | --- |
| 文本帧 | `{ "type":"stream.cursor", "sessionId":"…", "serial":12, "width":32, "height":32, "xhot":5, "yhot":2, "imageBase64":"<PNG base64>", "name":"text" }` |
| main 入口 | `streamViewer.handleTextMessage` → 共享纯函数 `parsePsbStreamCursorTextFrame` |
| 事件 | `PsbStreamEvent{ type:'cursor', sessionId, cursor: PsbStreamCursorShape }`（**加性**变体） |
| 渲染入口 | `admin/usePsbStreamCursor`（订阅 `onAdminStreamEvent`，按 `viewerSessionId` 过滤；只写 canvas） |
| CSS | 纯关键字（如 `text` / `ew-resize` / `wait`），由本机指针主题渲染 |
| 映射 | 共享 `psbStreamCursorKeyword(shape)`；表与 PSB `@psb/shared` 的 `packages/shared/src/stream-cursor.ts` **逐条一致**（PSB 0.1.127，2026-11-26 工作区快照：36 个 CSS 关键字 / 64 条 X11 别名；网页 `cursor-shape.ts` 只是 DOM 落点层） |

**形状 → CSS 关键字**（共享纯函数 `psbStreamCursorKeyword`，渲染层唯一映射点）：

1. `name` 大小写归一、去首尾空白、`-` / 空格当 `_`；
2. 归一后本身是合法 CSS 关键字（CSS UI 4 的 cursor 关键字白名单）→ 直接沿用；
3. 否则查 X11→CSS 别名表（`PSB_STREAM_CURSOR_KEYWORD_BY_X11_NAME`：`xterm→text`、
   `left_side/right_side/sb_h_double_arrow→ew-resize`、`top_side/bottom_side→ns-resize`、
   `left_ptr/arrow→default`、`watch→wait`、`left_ptr_watch→progress` 等；**表与白名单逐条对照
   PSB `@psb/shared` 的 `packages/shared/src/stream-cursor.ts`（PSB 0.1.127，2026-11-26 工作区
   快照；网页薄层 `cursor-shape.ts` 只负责「写到哪个 DOM 元素」）**，改动必须与 PSB 同批）；
4. 未知 / 缺 `name` → `default`（箭头，**绝不**回退 `none`：不知道宿主形状时不能让指针消失）；
5. **形状不合法 → `null`**：调用方保持现状、不写样式（畸形远端数据不能伪造光标，也不能清掉已有形状）。

**映射表来源与漂移检查（CINDY-RW-09，2026-11-26 对齐）**：

- **权威来源**：PSB `@psb/shared` 的 `packages/shared/src/stream-cursor.ts` ——
  `remoteStreamCursorKeywordOf` / `remoteStreamCursorCssOf` / `remoteStreamCursorStyleOf`；形状边界
  校验只有 `remote-clients.ts` 的 `normalizeRemoteStreamCursorShape` 一份。Cindy 的
  `psbStreamCursorKeyword` + 两张表是**只读副本**（不 import PSB 包，不引入跨仓依赖），语义等价于
  `remoteStreamCursorCssOf(shape)`（默认 `system`，含非法形状 → `null`）。
- **版本记录**：PSB 源检出根 `package.json` = **0.1.127**（2026-11-26）；对照的
  `stream-cursor.ts` 在 PSB 工作区**尚未提交**（`git status` `??`，HEAD `edd6d4b`），所以 Cindy
  注释只能记「PSB 0.1.127 / 2026-11-26 工作区快照」；网页薄层最近提交 `236926e`（2026-11-26）。
  Cindy 的版本注正在 `apps/desktop/src/shared/psb-remote-workspace.ts` §5b 文件头。PSB 联调记录里
  出现的 `0.1.17x` 是**部署版本号**（发布流水线/测试环境抬高，不等于源检出 `package.json` 的
  值），引用版本时写明是「源检出」还是「部署」。
- **`host` 位图是可选语义**：PSB 共享核心提供 `style: 'host'` 的
  `url("data:image/png;base64,…") <xhot> <yhot>, auto`（位图 + 热点 + `auto` 兜底）；Cindy 固定
  `system`（用户 2026-11-26 口径：永远保持宿主指针风格），**不渲染位图**。将来若要做 host 模式，
  CSS 值必须照共享核心拼，不自行发明格式。
- **漂移检查方式（PSB 改表 / 升级后）**：逐条对比三处——① `REMOTE_STREAM_CURSOR_CSS_KEYWORDS`
  白名单；② `REMOTE_STREAM_CURSOR_KEYWORD_BY_X11_NAME` 别名表；③
  `remoteStreamCursorKeywordOf` 的归一化与回退顺序；再对比形状边界
  `normalizeRemoteStreamCursorShape`。Cindy 侧跑
  `shared/__tests__/psbRemoteWorkspaceStreamCursor.test.ts`（含 64 条别名 / 36 个关键字计数与 PSB
  shared 测试移植用例），PSB 侧跑其 `packages/shared/src/stream-cursor.test.ts`。**两侧条目数与
  关键期望值必须一致**；表外新增别名由 PSB 先加，Cindy 只跟随。
- **跟进项**：请 PSB 提供 `stream-cursor.ts` 的**版本化快照**（或发布共享包；PSB 在
  CINDY-RW-09 第 4 点已表示可以给）。拿到后把 Cindy 的副本改为「对照 pinned 快照的差异测试」，
  不再靠人工逐条比对；登记见 `docs/collaboration/psb-remote-workspace-contract.md` §2。

**校验**（main 在产生事件前完成，任一字段不合规整条丢弃、只记 debug）：`serial` 为整数 uint32；
`width/height` 为整数 1..`PSB_STREAM_CURSOR_MAX_SIZE`(64)；`xhot < width`、`yhot < height`（热点允许 0）；
`imageBase64` 非空、长度 ≤ `PSB_STREAM_CURSOR_MAX_BASE64_LENGTH`(48 KiB)、只含 base64 字符集
（`A-Za-z0-9+/` + 尾部 `=`）、长度 `% 4 !== 1`；`name` 可选并截断到
`PSB_STREAM_CURSOR_MAX_NAME_LENGTH`(64)。**这是 Cindy 自己的协议边界，与共享核心的边界校验不是
逐字相同**（Cindy：热点须严格小于尺寸、`name` 超长截断、不要求 PNG magic 前缀；PSB：允许
`xhot === width`、`name` 超长整条拒绝、要求 PNG 前缀）——这些差异只影响「帧收不收」，不影响被
接受形状的映射值；映射本身逐条一致。PSB 若改这些边界，仍按本节「当前跨仓依赖」双方同步。

**当前跨仓依赖（变更需双方同步）**：Cindy **只用 `name`**，但解析器仍**强制要求并校验**
`imageBase64` / `width` / `height` / `xhot` / `yhot`（协议边界，也是未来显式 host 位图降级模式的唯一
输入）。PSB 若停发这些位图字段（或放宽 / 收紧边界），Cindy 会把整条 cursor 帧判为非法丢弃——不是
静默降级。改契约必须先双方确认，再同批改 `parsePsbStreamCursorTextFrame` / 测试 / 本文。

**serial 语义（不再严格单调）**：语义仍是**覆盖**（丢一条无后果）。main 每会话维护
`lastCursorSerial`，但**只去重连续重复的同一条形状，不按序号丢弃**：真机日志出现过同一连接里序号
回退，旧的「out-of-order 丢弃」会让远端新形状被吃掉（指针卡在旧形态）。`start` / `stop` /
`dispose` 清空去重状态（新订阅是新的序号生命线）。渲染层同样只对同 serial 重复做去重、不回退。

**只在画面区域生效**：关键字只写到 **canvas（画面区域）** 的 `style.cursor`：指针进入画面即应用，
离开画面立即清空 → 恢复宿主默认；缓存最近一次形状，重新进入画面时立刻应用，不必等下一帧事件。
stage 不承载样式（stage 还含黑边与浮层），因此控制条、HUD、全屏退出按钮这些本地 UI 保持宿主默认
光标（HUD / 退出按钮另有显式 `cursor-default` / `cursor-pointer`）。全屏时 canvas 仍在 stage 里，
同一份样式继续生效；全屏同样只在画面区域生效。
命中判定不能只靠 canvas 的 `pointerleave`：拖拽时 `usePsbStreamInteraction` 把指针捕获到 stage，
canvas 会收到一次伪造的 `pointerleave`，只按边界事件会在整个拖拽期间清掉 resize / grabbing 形状。
实现是 canvas `pointerenter` 应用 + stage `pointermove` 按 **canvas 矩形几何命中**持续校正（捕获前后
一致）+ stage `pointerleave` 清空。
排障属性：canvas 上 `data-stream-cursor-keyword` / `data-stream-cursor-name`（真机用
`getComputedStyle(canvas).cursor` + 这两个属性断言，不用解码位图）。

**生命周期与宿主默认**：只在**已订阅**（`subscribed || streaming`）期间接收形状；停止 / `closed` /
错误断开 / 切工作区（页面按 `workspaceId` 重挂连接区）/ 卸载 → 清 canvas `style.cursor` 与排障属性、
清缓存、回到宿主默认光标。没有 cursor 事件时保持默认：不猜形状、不把远端光标写进任何持久状态。

**与输入 / 全屏的关系**：

- 光标只影响**外观**，不参与输入转发：指针坐标仍按 contain 映射发 `pointermove`，全屏捕获态继续拦
  宿主默认行为。两者互不依赖（cursor 事件丢失不影响输入；输入通道缺失时仍可只读观看并同步形状）。
- 文本帧不变式不变：`stream.cursor` 只走 `handleTextMessage`，**绝不**进入二进制帧路径，也不计入
  `receivedBinaryFrames`（否则 4004 的「从没出过画面」会被污染成「慢订阅者」）。

**验证方式**：

- `shared/__tests__/psbRemoteWorkspaceStreamCursor.test.ts`：合法帧、尺寸/热点/长度/base64 字符集/
  serial 非法拒绝、**PSB shared `stream-cursor.test.ts` 移植的同一形状同一 CSS（四类验收场景、X11
  别名、大小写/空白/横线归一、未知/缺 name → `default`、映射表只输出合法关键字）**、映射表
  64 条别名 / 36 个关键字计数、非法形状 → `null`、输出不含 `url("data:image/png`；
- `main/remote-workspace/__tests__/streamViewer.test.ts`：cursor 文本帧 → `{type:'cursor'}`、
  连续同 serial 去重、**serial 回退照常 emit**、非法/超限只丢自己、`stop` → `start` 重置去重状态、
  文本帧不进入二进制帧路径；
- `main/remote-workspace/__tests__/psbWorkspaceAdminService.test.ts`：管理页只转发观看端绑定会话的 cursor
  事件（用户任务会话不串通道、无管理页状态映射）；
- `renderer/features/remote-workspace/admin/__tests__/RemoteWorkspaceAdminPanel.test.tsx`：进入画面
  才写关键字、移出立即恢复、重新进入用缓存形状、拖拽捕获期间（canvas 收到伪造 pointerleave /
  stage 几何 pointermove）形状不丢、serial 回退生效、别的观看端忽略、停止 / `closed` / 错误 /
  卸载恢复默认并清缓存、HUD 与全屏退出按钮不继承、全屏内 canvas 继续生效。

真机验收点见产品规则 §8.2（文本区 I-beam / 窗口边缘 resize / 忙碌 loading / 移出画面恢复宿主默认 /
HUD 与按钮不受影响）。

## 13. 写操作前的占用闸门（2026-11-26 用户口径；2026-11-27 复测改「一律用户确认」）

PSB 服务端对**工作区写操作**（新建会话 / 启动串流 / 发送消息）做占用校验：不是自己锁定的写入会被
拒绝。Cindy 因此在主进程里自己先校验，而不是等 PSB 拒绝后再把一句不可行动的失败转给用户。

> **2026-11-27 人工复测（用户口径，最高优先级）**：**所有工作区占用都必须由用户通过弹窗确认，
> 禁止任何默认 / 自动占用**。闸门因此不再「看到空闲就替用户占用」：空闲时返回
> `PSB_WORKSPACE_NOT_OCCUPIED`（与 PSB 2026-11-27 守卫契约 `403 WORKSPACE_NOT_OCCUPIED` **同码
> 同形**），渲染层弹确认框 → 用户确认 → **显式占用**（`psb-remote:occupy-workspace`）→ 重试发起
> 的那次动作。`allowAutoOccupy`（默认 `false`）是唯一开关，只有显式用户动作的调用点可以传 `true`。

### 13.1 唯一助手

`main/remote-workspace/workspaceLock.ts` 的 `createPsbWorkspaceLock(ports)`（生产装配在
`index.ts` 的 `PsbRemoteService` 里，一处 TTL 缓存全会话共享）。「能不能写」的判定**委托唯一判据**
`shared/psb-remote-workspace.ts` 的 `psbWorkspaceWritable(workspace, { requireAgentRuntime: false })`
（`requireAgentRuntime:false`：那台机器没装某个 Harness 不阻断与它无关的写）；闸门只在该占用时
**且调用方显式允许**时占用：

| 输入状态 | 结果 | 动作 |
| --- | --- | --- |
| 由自己占用 | `{ ok: true }` | 放行 |
| 无人占用 + `allowAutoOccupy:false`（缺省） | `{ ok:false, reason:'occupy-required' }` | **不占用**；映射 `PSB_WORKSPACE_NOT_OCCUPIED`，等用户确认 |
| 无人占用 + `allowAutoOccupy:true`（仅显式用户动作） | `{ ok: true }` | 幂等 `occupyWorkspace` 后放行 |
| 被他人占用 | `occupied-by-other` + `personName` | 拒绝，不尝试占用 |
| 客户端离线 | `offline` | 拒绝（占用了也用不了） |
| 工作区不可见 / 未就绪 | `workspace-unavailable`（`missing` / `state`） | 拒绝 |
| 网络 / 鉴权失败 | **原样抛** `PsbClientError` | 用户看到真实原因，不静默放行 |

读口：`ensure()` 不命中缓存读 **1 次工作区列表**；`ensureForSession()` 不命中缓存读 **2 次 HTTP**
（先读会话行拿 `workspaceId`，再读列表拿占用 / 在线 / usable——PSB 没有单工作区读口，见 §13.3）。
`GET /workspaces/:id` 在 Cindy 身份下恒 403（§3 与 §10 第 3 条）。调用方手上有新鲜工作区行时用
`snapshot` 传入，省一次请求。**`allowAutoOccupy:false` 且空闲时 0 次占用请求**（只有读口那 1/2 次）。
**发送路径固定 `requireAuthoritative: true`**（不命中任何缓存），其它调用方保留 `PSB_WORKSPACE_LOCK_TTL_MS`
的乐观有效期，见 §13.3。

### 13.2 三个接入点（缺一处就等于让 PSB 替我们拒绝）

1. **新会话**：`PsbRemoteService.createSession()` 在 `api.createSession` 之前 `ensureWorkspaceLocked`
   → 失败不建会话、不落库，直接给 `PSB_WORKSPACE_OCCUPIED_BY_OTHER`（带人名）等可行动码。
   发送前透明重建（§6.1）的建会话走同一个服务方法，因此**重绑路径同样被闸门覆盖**，没有第二条
   绕过路径。`psbClient.createSession` 内部**先读工作区再 POST**（共 2 次 HTTP）：读工作区失败时
   一个请求都不发，不会留下无人认领的孤儿会话（见 §15.6）。
2. **启动串流**：`adminService.streamStart()` 先过占用闸门
   `remote().ensureWorkspaceLocked(workspaceId, { allowAutoOccupy: false })` → 空闲时返回
   `PSB_WORKSPACE_NOT_OCCUPIED`（渲染层弹确认框，用户确认占用后重试本次启动），失败不订阅、不建
   会话、不建立观看连接。随后**必经** `ensureWorkspaceAccess`（CINDY-RW-17，见 §11.8）：读
   `GET …/access` → 终态才 `POST …/access/start` → 轮询到 running（默认 90s）；未占用 / 被他人
   占用 / 超时 / 网络失败**带码抛出且不订阅**，只有旧 PSB 的 `unsupported` 才退回直接订阅。顺序是
   「占用闸门 → ensure 访问 → 订阅 → 起观看端」。
   只读的 `streamStatus` / `adminContext` 不受此限（读状态不是工作区写入，且**不会**订阅或创建
   会话，只借已有绑定 id，见 §11.2）。会话级串流通道已删除（§4），不存在「会话级启动串流」这条
   绕过占用检查的路径；`ensureWorkspaceLockedForSession()` 仍保留给下面第 3 条的发送前闸门。
3. **每条消息发送**：`makerSendTransaction.sendToAgentAccepted` 在 `ensureRemoteReadyForSessionStart`
   （进 lazy-create/隧道）**之前**调用 `deps.preparePsbWorkspaceLock(sessionId)`，**无条件执行**
   （不在任何分支里：直发 / 队列 drain / 手机 / 自动重试 / 重建后都经过本事务）。`register.ts`
   的实现按会话行的 `remoteHostId` 定位 `psb:<id>`，再走
   `PsbRemoteService.ensureWorkspaceLockedForSession(id, { requireAuthoritative: true, allowAutoOccupy: false })`：
   **每条消息都读一次 PSB 会话行 + 工作区事实**（2 次 HTTP），
   - 仍由我占用 → 放行；
   - 此刻无人占用（被交接回空闲）→ **不自动占用**，返回 `PSB_WORKSPACE_NOT_OCCUPIED`；渲染层弹
     「需要占用这个工作区」确认框，用户确认 → 显式占用 → **自动重试同一次发送**（§13.6）；
   - 被他人占用 / 离线 / 未就绪 → 可行动 `PSB_*` 失败（带占用人名），本轮不发送；
   - 读不到 / 网络 / 鉴权失败 → 同样不发送（**禁止 fail-open**：「无法确认」不是「可以写」）。
   位置刻意放在 `SESSION_RUNNING` 之后：插话/排队被拒时仍报原来的原因，不被占用文案抢答。失败时
   本轮没有开隧道、没有落任何远端写入，**消息保留在草稿/队列里可重试**（不会因为占位而丢消息）。
   **非 `psb:` 会话不进这道闸门**：`register.ts` 按 `remoteHostId` 解析 `psb:<id>`，解析不到
   直接返回——本机 / MCPR / SSH / device-link 任务 **0 次 PSB 请求**，不因这道校验增加延迟。
   2026-11-27 第二轮起，渲染层在调用 enqueue/steer **之前**还会用同一判据做一次**发送前预检**
   （`renderer/features/remote-workspace/psbSendPreflight.ts`，见 §13.6.1）——把「先发出去、失败后
   再确认」改成「发送前先确认，取消就不发送」。因此一条 psb 消息的占用读取总成本是预检 2 次 HTTP
   + 本闸门 2 次 HTTP（闸门仍是最终权威，预检不替代它）。

**串流键鼠输入不单独再校验**：启动已经锁过；未锁定的场景由启动失败覆盖（`PSB_STREAM_NOT_ACTIVE`
/ 启动失败），单独加闸门只会让弱网下的合法输入被静默丢掉。

### 13.3 缓存与新鲜度（发送路径权威读，其它调用方 TTL）

- `PSB_WORKSPACE_LOCK_TTL_MS = 1500`：**只缓存成功**（`isFresh`）。**发送路径不吃它**——
  `ensureForSession(id, { requireAuthoritative: true })` 跳过乐观缓存，每次都按读口重新判定：
  **2 次 HTTP**（会话行 + 列表；PSB 的会话行只带 `workspaceId`，不带工作区快照，见 §15.10）。
  这是 2026-11-27 用户复测后**刻意接受**的成本：会话创建后工作区可能被交接，本地缓存（含 10s
  会话快照）都不能证明「此刻仍由我占用」。连续两条消息 = 两次权威读（无人占用时再各加一次占用）。
- **其它调用方保留 TTL**：工作区级 `ensure()`（发送前重建的建会话、启动串流、管理页占用等既有
  链路）与 `ensureForSession()` 的**缺省**分支命中「本工作区 / 本会话在 TTL 内仍由我锁定」即零
  请求，最高 1.5s 乐观窗口由 PSB 服务端闸门兜底。生产上 `ensureForSession` 目前只有发送闸门
  调用，且固定传 `requireAuthoritative: true`。
- **权威读不是 mine 时清缓存**：`ensureForSession` 读到工作区未由我占用（无人占用 / 他人占用 /
  未就绪）会先删掉该工作区的乐观缓存，避免非权威调用方在 TTL 内继续拿「1.5s 前是我的」放行
  （交接后仍以为锁还在）。读到 mine 或本次**显式允许**的占用成功时按原方式更新缓存。
- 失败一律不缓存：读不到 / 被他人占用 / 离线 / **`occupy-required`** 等失败后，下一条消息立刻
  重新读并重新判定（用户确认占用后由渲染层显式占用，不经闸门的 TTL）。
- 本端占用/释放（`occupyWorkspace` / `releaseWorkspace`）会 `invalidate` 该工作区的乐观缓存。

### 13.4 失败码与文案

`psbWorkspaceLockFailureError()` 把**四种**可行动失败映射成 `PSB_*` 码（`shared/psb-remote-workspace.ts`
§4b 单表，`→PSB_WORKSPACE_NOT_OCCUPIED` / `PSB_WORKSPACE_OCCUPIED_BY_OTHER` / `PSB_CLIENT_OFFLINE` /
`PSB_NOT_FOUND` 或 `PSB_WORKSPACE_NOT_READY`）。`PSB_WORKSPACE_NOT_OCCUPIED` 与 PSB 的
`403 WORKSPACE_NOT_OCCUPIED` 同码（PSB 原始码 → 本地失败码同名），PSB 上线后语义不变。被他人占用时
`message` **只放占用人名**（渲染层插值 `{{name}}`）。
网络 / 鉴权失败原样抛（`PSB_UNREACHABLE` / `PSB_AUTH_*` 等既有映射），发送路径据此**不发送**；
`register.ts` 的闸门统一用 `psbIpcCodeForFailure(toPsbRemoteFailure(error))` 收敛成带码的
`IpcError`（映射不到才落 `INTERNAL`），跨 IPC 保留命名空间码。

渲染层文案全部可行动（12 locale）：
`remoteWorkspace.error.occupiedByOther`（带占用人名 + 「请对方释放 / 到 PSB 网页解除占用」；
占用 / 启动串流等按钮失败）与输入框置灰的三条原因——被他人占用 / 客户端离线 / 工作区未就绪
分别取 `PSB_WORKSPACE_WRITABLE_FAILURES` 的 `inputMessageKey`
（`remoteWorkspace.error.workspaceOccupied` / `remoteWorkspace.error.clientOffline` /
`remoteWorkspace.input.workspaceNotReady`，都是无名字的同一句 + 同一下一步，与按钮失败共享同一
判据）。**两个消费面的映射都在共享契约里**：按钮 / 操作失败用
`psbFailureMessageKeyForIpcCode`（`occupiedByOther`，可插值名字），错误横幅 / 输入禁用用
`psbBannerMessageKeyForIpcCode`（`workspaceOccupied`，无名字兜底）；渲染层不得为单个码手写
if，否则同一条失败会出现两套文案。会话页错误横幅的 PSB 码解码在
`renderer/lib/makerChatStore.ts` 的 `decodeRemoteErrorMessage`（`[PSB_*]` →
`remoteWorkspace.*`）：否则通用通道会让用户看到裸的 Electron 包装串
（`Error invoking remote method …`）。

**2026-11-27 新增两条可行动失败**（同一张单表，`remoteWorkspace.error.*` × 12 locale）：
`remoteWorkspace.error.occupyRequired`（「这个工作区还没被你占用，需要先占用。」——覆盖
`PSB_WORKSPACE_NOT_OCCUPIED`）与 `remoteWorkspace.error.agentSessionActive`（「这个工作区里还有
任务正在输出，先结束或停止它，再释放占用。」——覆盖 `PSB_AGENT_SESSION_ACTIVE`）。两条都是
可行动说明，**不新增「去 PSB」类降级提示**（用户明确反对用提示掩盖契约缺口）。

**2026-11-27 CINDY-RW-17 新增一条**：`TOO_MANY_TUNNELS` → `PSB_TOO_MANY_TUNNELS` +
`remoteWorkspace.error.tooManyTunnels`（12 locale，语义「隧道 / 观看名额已满，先关闭或停止其它
远程会话再重试」，单表 `nextStep:'stop-session'`）。同时 agent-tunnel Upgrade 的外层
`FORBIDDEN` / `CONFLICT` 会把 `details.code` 提升成上述业务码（`PsbTunnelError.code` 即跨 IPC 的
业务码），渲染层按单表给出可行动文案，不再显示泛化的 FORBIDDEN。**临时失败呈现**（2026-11-27
用户口径）：渲染层不再渲染 `border-b` / `shrink-0` 的内联错误条，失败 / 中性关闭一律走全局 toast
（绝对定位、自动消失），布局里只保留持久状态（串流未启动 / 正在启动桌面访问… / 等待画面）。

**渲染层唯一文案实现（2026-11-26 独立审查归并）**：`renderer/features/remote-workspace/psbFailureText.ts`
的 `psbFailureText(t, error)` 是唯一出口——输入可以是原始 IPC 错误、推送里的 `PsbRemoteFailure`
或 UI state 的 `PsbFailureLike`，按「共享 `PSB_FAILURE_DESCRIPTORS` 文案键 → `ipcError.<CODE>` →
PSB / 本机可读原文（只作诊断行）→ 通用兜底」顺序取文案；剥掉 `Error invoking remote method…` 与
`[CODE] ` 包装，占用人名只在这一处插值（拿不到名字回落无名字的同一句）。管理页操作 / 串流启动 /
草稿 / 侧栏「在网页打开」全部改指它，**不要再新增第二套同码表实现**。

### 13.5 占用 / 释放时的版本控制检查（CINDY-RW-10，2026-11-26 20:4x 再更正）

PSB 在**占用 / 解除占用的那一刻**做版本控制检查（P4 会完整执行 `p4 reconcile`，git 读工作区状态）。
Cindy 只消费服务端结论、不自己跑 VCS；两代服务端形态**并存**，同一套 store / 组件承接：

| 形态 | 何时 | Cindy 行为 |
| --- | --- | --- |
| **0.1.180 advisory（主路径）** | 占用 / 释放**成功**（2xx）且 `data.vcs.dirty:true`、`advisory:true` | **非阻塞提示**（全局横幅 / 页内条）：显示 `messageZh` + `projects` 摘要，给「查看详情 / 一键清理 / 继续」。操作已经成功，不把提示做成错误。 |
| **旧版 409（兼容路径，<0.1.180）** | 占用 / 释放返回 `409 WORKSPACE_VCS_*` + `error.details.vcs` | 操作未生效：按错误处置（`retry` / 旧 `revert-*`），**不删**这条路径（用户可能连着旧部署）。 |

**没有 force 分支**：旧 `force-release` 已删除；`actions` 里即使出现也不会渲染按钮、不会执行，
路径里的 `force` 查询参数在执行前被拒。

#### 13.5.1 数据流与安全边界

- `psbClient` 解析：2xx 用 `readAdvisoryWorkspaceVcs`（`data.vcs` / 工作区行内嵌 `vcs`）；
  409 用 `psbFailureFromResponse` 把 `details.vcs` 挂到 `PsbRemoteFailure.vcs`。
  `message` 缺省时用 `vcs.messageZh` 兜底（PSB 的 `error.message` 常为空）。
- **IPC 只能带 code+message**：`details.vcs` 的 `projects` / `actions` 跨不了 invoke 失败。因此
  `main/remote-workspace/index.ts` 在占用 / 释放（含发送前确认后占用与启动串流闸门）拿到 notice 后
  **先写有界缓存（≤32，LRU）再广播** `psb-remote:workspace-vcs-notice`；成功占用 / 释放 / 清理 /
  继续后广播 `notice:null` 撤掉提示。渲染层另有 `workspaceVcsNotice` 兜底读（推送与 invoke
  失败到达顺序不可依赖）。
- 渲染层**只传 kind**（`runWorkspaceVcsAction`）：main 用 `main/remote-workspace/vcsNotice.ts` 的
  `workspaceVcsActionTarget(workspaceId, kind, operation)` 决定**固定 path + 固定方法**，**不采信
  服务端下发的 method / path**（2026-11-26 复审）：`inspect-vcs`=GET `…/workspaces/<id>/vcs`；
  `clean-workspace` / `revert-vcs`=POST `…/vcs/revert`；`revert-then-occupy`=POST `…/occupy`；
  `revert-then-release`=DELETE `…/occupy`；`retry` 按产生 notice 的入口决定方向；`continue` 不发
  请求。服务端形状只用于**确认这是一条已知 action**：方法必须与固定目标一致、pathname 必须等于
  固定路径、同工作区 `decodeURIComponent` 比较 + 每段拒绝 `.` / `..` + 禁 `force`，否则整条丢弃；
  body 只接受 `revert` / `projectIds` / `confirm`（多余键整条 action 丢弃）。
  `isAllowedPsbRemoteActionPath` 是发请求前的第二道兜底（见 §15.2）。
- 不可逆动作（`clean-workspace` / `revert-*`）**二次确认**：渲染层弹确认（列 projects / changes、
  写明删除新增 / 还原修改 / Git 切回默认分支、不可撤销），main 还要求 `confirm:true`（IPC 被绕过
  也不能凭一个 kind 触发还原）。
- **`clean-workspace` 是 202 异步**：响应带 `operationId` 时展示「清理已开始」+ 刷新按钮，调用
  既有 `refreshWorkspaces` 重新读工作区；**不猜轮询端点**（服务端没给就不新增未约定请求）。

#### 13.5.2 接入点与测试

占用 / 释放入口全部经服务层收敛：工作区弹窗 / 草稿页工作区选择（`occupyWorkspace`）、管理页页头
占用/释放、发送前用户确认后的显式占用（`workspaceLock` 的 occupy 端口，`allowAutoOccupy:true`）、
启动串流与新建会话的 `ensureWorkspaceLocked`。占用产生的 advisory 也广播（operation=`ensure`）。

定向测试：`apps/desktop/src/shared/__tests__/psbWorkspaceVcs.test.ts`（形状 / 白名单 / advisory
读取）、`main/remote-workspace/__tests__/vcsNotice.test.ts`（路径 / body / 缓存安全边界 / 固定目标表
（encoded-dot、method 不匹配、retry 方向））、
`main/remote-workspace/__tests__/psbRemoteVcsService.test.ts`（advisory 广播、旧 409 兼容、
clean 确认 / 202、continue、inspect）、`renderer/features/remote-workspace/vcs/__tests__/`
（store 推送 / 兜底读、View 的确认取消与确认、force-release 不渲染、旧形态 retry）。

**需 PSB 补的联调样本**：`revert-then-release` 已取消，但旧版 409 的 `revert-then-*` 与
`clean-workspace` 202 的 `operationId` 之后的**刷新/轮询端点**都还没有最终形状；拿到后改
「清理已开始 → 自动刷新」并在本文件登记。

#### 13.5.3 渲染层挂载点与接线（2026-11-26 集成接线）

通知由 main 广播、渲染层 store（`vcs/vcsNoticeStore.ts`）承接；**同一份通知在三个 UI 位置
呈现**，各自只负责展示与处置，不解析 method/path/body（动作只按 kind 走 `runWorkspaceVcsAction`）：

| 挂载点 | 形态 | 数据与行为 |
| --- | --- | --- |
| `renderer/App.tsx`（主窗、`ConfirmDialogProvider` 内） | `WorkspaceVcsNoticeHost`：**右下角悬浮横幅**（`variant="banner"`，避开窗口按钮 / 标题栏拖拽区 / 右上 ToastContainer 落点；外层 `pointer-events-none` + 内层 `auto`，不遮断输入；带工作区名） | 订阅 `onWorkspaceVcsNotice`，显示**revision 最近的一条**；`requestConfirm` 接宿主 `useConfirmDialog`，`notice:null`（成功占用 / 释放 / 清理 / 继续后）自动撤下。`!isSecondaryWindow() && !isSidebarWindow()`：副窗 / 侧栏子窗不挂，不重复弹。 |
| `admin/RemoteWorkspaceAdminPanel.tsx` › 版本控制分类 | `WorkspaceVcsNoticeView variant="inline"` | `useWorkspaceVcsNotice(context.workspaceId)`（挂载 / 换工作区时兜底读 main 缓存）；有通知时替换占位空态，没有时保留原「后续提供」空态。`clean-workspace` 202 被接受后页面重读一次 `adminContext`。 |
| `admin/RemoteWorkspaceAdminActions.tsx` 页头占用 / 解除占用 | 无独立 UI | 动作成功后 `hydrateWorkspaceVcsNotice(workspaceId)` 兜底读一次（推送已覆盖时幂等；页头保持单行 ≤40px，不加提示条）。 |
| `dialog/RemoteWorkspacePickerDialog.tsx` | `WorkspaceVcsNoticeView variant="inline"`（弹窗底部、错误条上方） | 占用失败（旧版 409）后 `hydrateWorkspaceVcsNotice` 并在弹窗内就地展示；占用成功带 advisory 时同样兜底读，但弹窗随即关闭，提示由全局宿主 / 管理页继续展示。 |
| `draft/PsbWorkspacePicker.tsx`（草稿页项目胶囊下拉） | 同上（行列表下方） | 选中即占用：失败后原地展示通知与处置动作，占用仍**不选中**；成功时兜底读（提示交给全局宿主）。 |
| 发送前自动占用 / 放弃草稿释放 | 无单独 UI | main 在 `workspaceLock` 的 occupy 端口（operation=`ensure`）与 `releaseWorkspace`（operation=`release`）同样缓存 + 广播，全局宿主覆盖；**不弹 modal**，释放失败不阻塞离开但不会静默。 |

不可逆动作的**二次确认在宿主挂载时是两道**：先 View 内置确认区（列 projects / changes /
不可撤销说明），再宿主 `ConfirmDialogProvider` 确认框；两者都确认后才发
`{ kind, confirm: true }`。缺 `requestConfirm` 的裸渲染环境（单测 / Story）只有内置两步确认。

**store 的最终形态（2026-11-26 独立审查 r4）**：

- **顺序单调**：每条 entry 带单调递增 `revision`，更新 / 删除 / 兜底写入都推进；多工作区同时有
  提示时取 revision 最大者（「最近一条」）。
- **单调合并**：兜底读 `hydrate` 在请求前记下该工作区修改序号，响应回来时若期间已有推送 / 清除，
  以本地为准（不覆盖、不清除）；静默期外的 `notice:null` 才清。
- **关闭语义按类型**：advisory 的「继续」只关本地 store（建议可忽略）；**非 advisory（旧版 409）
  先调 main 的 `continue` 清有界缓存再关**，否则下一次兜底读会把同一条提示带回来。
- **「清理已开始」只属于 `clean-workspace`**（202+`operationId` 异步）；其它 kind 不显示。
- **stale / 占位身份只读**：读不到工作区时不给写动作入口；VCS 通知与通用失败条互斥（同一事实
  只出现一处）。

接线测试（同一批）：
`renderer/features/remote-workspace/vcs/__tests__/WorkspaceVcsNoticeHost.test.tsx`（推送订阅、
宿主确认框确认 / 取消、`notice:null` 撤下）、`admin/__tests__/RemoteWorkspaceAdminPanel.test.tsx`
（版本控制分类 inline advisory、二次确认后 `runWorkspaceVcsAction`、继续关闭、页头动作后
hydrate）、`dialog/__tests__/RemoteWorkspacePickerDialog.test.tsx` 与
`draft/__tests__/PsbWorkspacePicker.test.tsx`（占用失败兜底读 + inline 通知、成功路径 hydrate）。

**已知边界**：advisory 的「继续」是纯本地关闭，main 的缓存仍保留到下一次占用 / 释放 / 清理；
其它窗口或重新挂载后再兜底读可能让同一条 advisory 再出现（这是「建议可忽略、但不假装已处理」的
取舍，主窗口横幅本身不重复弹）。非 advisory（旧版 409）走 `continue` 清 main 缓存，不受此限。

### 13.6 占用一律用户确认：渲染层确认 + 显式占用 + 重试同一次动作（2026-11-27 复测，实现事实）

主进程三条隐式写路径（发送 / 启动串流 / 新建会话）在**工作区空闲**时不再替用户占用（§13.1），
统一返回 `PSB_WORKSPACE_NOT_OCCUPIED`。渲染层的唯一实现在
`renderer/features/remote-workspace/occupyRequired.ts`（文案复用 `remoteWorkspace.dialog.confirmOccupy.*`
五键，`useConfirmDialog` 的模态队列 / 焦点陷阱 / 主题；确认框层高于选择弹窗的 z-index 修复不变）：

| 入口 | 失败点 | 确认 + 占用 + 重试 |
| --- | --- | --- |
| 发送消息（composer / 插话） | `makerChatStore.sendMessageCore` / `steerMessage` 的 enqueue / steer reject | store 在 `.catch` 里识别码 → 清横幅 → 经宿主要求用户确认；确认并占用成功后**用同一份载荷重试一次**（同 `clientId`，失败发生在受理之前）；取消 → 不占用、不发送、失败落横幅、调用方恢复草稿 |
| 启动串流（管理页） | `useAdminStreamSession.start` 的 `adminStreamStart` reject | 确认 → `occupyWorkspace` → 以 `resume` 重跑同一次 `start`（保留 `starting` 相位语义）；取消 → 不启动，横幅给 `remoteWorkspace.error.occupyRequired` |
| 新建 / 懒建 PSB 会话（草稿页首条消息） | `draft/psbDraftSession.ensure` 的 `createSession` reject | 确认 → `occupyWorkspace` → 重试同一次建会话（**同一 `clientRequestId`**，PSB 侧仍去重）；取消 → 不建、不占用 |
| 显式占用（选择流程确认后 / 页头「占用」按钮） | — | 保持**直接占用**（`psb-remote:occupy-workspace`），不弹第二道确认 |

- **宿主**：`renderer/features/remote-workspace/PsbOccupyRequiredConfirmation.tsx`（App 主窗挂一次，
  `ConfirmDialogProvider` 内）。复制模式：store 不认识 React，但注册的 resolver 让它能「等用户决定」
  再自己重试；没有宿主（旧 preload / 副窗 / 单测）→ resolver 返回 `false`，失败照旧落横幅，
  **不会静默占用**、也不假装成功。
- **workspace 解析**：发送路径的 `workspaceId` 来自 main 的 `adminContext({ localSessionId })`
  （渲染层不持有 workspaceId，`workspaceIdKnown:false` 的占位身份直接不给确认框）；管理页 / 草稿页
  用页头 / 交接载荷里已有的工作区事实。
- **失败不重试**：占用本身失败（被抢 / 离线 / 网络）→ 调用方**不得**重试发起的动作，按既有
  `PSB_*` 文案展示（被抢时带占用人名）。确认框只弹一次（重试轮不再弹，避免循环）。
- **PSB 2026-11-27 守卫契约对齐**：`403 WORKSPACE_NOT_OCCUPIED`（新建 / 继续 Agent 会话）与
  Cindy 本地闸门**同码同形**（`PSB_WORKSPACE_NOT_OCCUPIED`），PSB 上线后无需改语义；
  释放时 `409 AGENT_SESSION_ACTIVE` → `PSB_AGENT_SESSION_ACTIVE`，文案说明「先结束 / 停止会话再释放」，
  **不**自动重试、**不**引导去 PSB 网页兜底。
- 定向测试：`features/remote-workspace/__tests__/occupyRequired.test.ts`（识别 / 取消 0 次占用 /
  确认 1 次 / 无宿主不假装成功）、`renderer/__tests__/remoteErrorDecode.test.ts`（发送重试同一次）、
  `admin/__tests__/RemoteWorkspaceAdminPanel.test.tsx`（启动串流确认 + 重试、取消不启动）、
  `draft/__tests__/psbDraftSession.test.ts`（懒建确认 + 同一去重键重试、取消不建）。

### 13.6.1 发送前预检：先查占用，取消就不发送（2026-11-27 第二轮复测，实现事实）

用户截图暴露的坏体验是「消息先进对话 → 占用闸门拒绝 → 对话里留下『回复未完成 /
`[PSB_WORKSPACE_NOT_OCCUPIED]`』→ 才补确认框」。现在渲染层在**发送之前**做预检，失败后确认
只保留为**竞态兜底**：

- **判定唯一实现**：`renderer/features/remote-workspace/psbSendPreflight.ts` 的
  `startPsbSendPreflight({ remoteHostId, bridge })`。它不是 React 组件、不碰 store：桥与确认框
  都注入（确认复用 `occupyRequired` 的注册式工作区 resolver，宿主仍是
  `PsbOccupyRequiredConfirmation.tsx`）。
- **顺序**：解析 `psb:<PSB sessionId>`（`remoteWorkspacePsbSessionId`）→ 每次发送都读一次
  `psbRemote.sessionStatus({ sessionId })`（**不用本地缓存**）→ 与主进程闸门同一判据
  `psbWorkspaceWritable(workspace, { requireAgentRuntime: false })`：
  1. 不能写（他人占用 / 离线 / 未就绪）→ `blocked(workspace)`：**不发送**，用共享单表文案给
     可行动提示（被他人占用带占用人名），不产生对话内失败气泡；
  2. 由我占用 → `proceed(occupiedByPreflight:false)`：直接发送；
  3. 空闲 → `requestPsbOccupyConfirmationForWorkspace`：确认并**显式占用成功后**
     `proceed(occupiedByPreflight:true)`；取消 → `cancelled`（静默不发送）；占用失败 →
     `blocked(occupy-failed)`（带原始失败，按既有 `psbFailureText` 文案提示，不发送）；
  4. `sessionStatus` 读取失败 / **读预算超时（3s，见 `PSB_SEND_PREFLIGHT_READ_TIMEOUT_MS`；
     不设上限时主进程 20s×2 次 HTTP 的 PSB 超时会让点发送后几十秒没反应）** / 没有桥 /
     非 `psb:` / 畸形 `psb:` → 返回 `null`（**不预检**），交给主进程权威闸门按现状处理
     （主进程读不到仍拒绝并给可行动失败）。
- **零写入点**：预检在 `makerChatStore.sendMessageCore` / `steerMessageCore` 的**乐观气泡、
  队列项、`input.enqueue`/`steer` 之前** await；取消 / 拦下直接 `return false`，此时没有任何
  消息、队列项或落库写入，调用方（ChatInput 等）按既有 `false` 语义保留草稿 / 附件。
  非 psb 会话 `startPsbSendPreflightForSession` 同步返回 `null`：不引入 await、**0 次 PSB 请求**，
  本机 / SSH / device-link 发送的既有同步语义不变。
- **覆盖入口**：`sendMessage` / `steerMessage`（composer、草稿页首条消息、长文本粘贴发送、
  鉴权恢复等自动重发都经它们）、`resumeQueue`（暂停队列「继续」→ main 随后自动 drain 队列消息）、
  `retryLastError`（失败重试 → main 重新入队）、`steerQueuedMessage`（队列项直接插话）。
  拿不到 `remoteHostId`（非 psb / 会话状态未水合）时跳过预检，由主进程兜底。
  **主进程在回合结束后自动 drain 已在队列里的消息**没有渲染层插入点（不改主进程闸门的前提），
  那一段仍以主进程闸门为准——这是本批如实登记的边界。
- **不与失败后确认重复**：`proceed.occupiedByPreflight` 会传进 enqueue / steer 的失败 catch，
  该次发送若仍被主进程闸门以 `PSB_WORKSPACE_NOT_OCCUPIED` 拒绝（预检后被抢 / 被交接），
  **不再弹第二次确认**，失败直接落错误横幅；预检只是放行（`byMe` / 读失败）时，既有的
  「失败后确认」兜底保持不变。
- **`occupyRequired` 的小幅扩展**：新增 `confirmAndOccupyPsbWorkspaceDetailed`（`occupied` /
  `declined` / `failed{error}`）与 `PsbOccupyAttemptResult`；**按工作区**的注册式 resolver 改为
  返回详细结果（`requestPsbOccupyConfirmationForWorkspace` 无宿主时返回 `null`，不再用
  boolean 把「取消」和「占用失败」混成同一个 `false`）。启动串流 / 显式占用仍用三态字符串版
  `confirmAndOccupyPsbWorkspace`，行为不变。
- **成本（如实登记）**：每个 psb 消息的占用读取 = 预检 1 次 `sessionStatus`（main 内部
  2 次 HTTP：会话行 + 工作区列表）+ 主进程闸门 2 次 HTTP = **约 4 次 HTTP/条**。这是「每条消息
  发送前都必须确认当前占用、且主进程闸门仍是最终权威」的直接成本；**不**为此加 TTL 缓存
  （会重新引入「交接后仍以为锁还在」的窗口）。
- 定向测试：`renderer/__tests__/makerChatStorePsbSendPreflight.test.ts`（空闲+取消零发送 /
  空闲+确认的 occupy→send 顺序 / byMe 直接发 / 他人占用与离线可行动提示且无失败气泡 /
  占用失败提示 / 读取失败 fail-open / **读预算超时不拦截（假定时器）** / 预检占用后竞态不重复
  确认 / byMe 放行时失败后兜底保留 / resumeQueue 与 retryLastError 预检 / 非 psb 零 PSB 请求）、
  `features/remote-workspace/__tests__/occupyRequired.test.ts`（详细结果区分取消与失败）、
  `draft/__tests__/psbDraftSession.test.ts`（详细 resolver 下懒建行为不变）。

### 13.6.2 确认框的键盘与焦点语义（2026-11-27 第三轮复测，实现事实）

用户复测「占用确认框取消后，回车被输入进输入框」。根因不在 composer 的回车发送（它已同步
`preventDefault`），而在两处：

- **关框键漏进 composer**：确认框是程序化 `AlertDialog`（无 Trigger），关闭后焦点回 body，
  Enter/Esc 的默认行为落到 textarea/下一次发送。修法：`renderer/lib/confirmDialogKeyboardGuard.ts`
  统计打开中的确认框；框打开期间 `[role="alertdialog"]` 之外的 Enter/Esc 一律
  `preventDefault + stopPropagation`；框内按键记为「关框键」，关闭后 300ms 内**一次性**吞掉同名
  Enter/Esc（不影响用户随后立刻输入）；`confirm-dialog-provider.tsx` 接线并在卸载后异步归还
  弹框前焦点。
- **取消后草稿被追加空段**：发送失败 / 取消的恢复复用了 device-link 的 FIFO 恢复
  `insertComposerDocumentForRestore`，会追加恢复分隔空段。修法：`ChatInput` 的 PSB 发送失败 /
  占用确认取消改为**原样放回点击时的草稿**（不追加分隔段），光标置末尾、草稿静默保存。
- `useComposerSendFocusRestore`：发送解锁时若确认框还开着，保留待恢复意图，等框彻底关闭再恢复
  （否则会把框内按钮误判成「用户去了别处」而丢弃恢复）。

定向测试：`components/ui/__tests__/confirmDialogFocus.test.tsx`、
`components/new-chat/__tests__/chatInputAnnotationAbort.test.tsx`、
`components/new-chat/__tests__/useComposerSendFocusRestore.test.tsx`。

## 14. 独立审查阻断项修复（2026-11-26，实现事实）

一次性独立审查在 PSB 这一块拦下 9 个阻断项，本批逐条修复（每项都有定向测试；真机复测点见末尾）：

| # | 问题（修复前） | 修法 / 证据 |
| --- | --- | --- |
| 1 | `buildPsbTunnelUrl` 没带 `readyFrame=1`：就绪帧 0.1.159+ 引入、0.1.160+ 起 opt-in（默认不发），长连接隧道固定等满 5s、exec 等 1.2s | URL 固定带 `readyFrame=1`（服务端只认 `1`），保留超时兜底兼容老服务端；`psbTunnelWiring.test.ts` 四种 mode 都断言该参数且不破坏 `mode` / `bundleVersion`。固定等待已在 2026-11-26 复审改为**进程级能力探测**（见 §15.5） |
| 2 | codex 只把 `cwd` 换成 `.`，`runtimeWorkspaceRoots` / writableRoots / named permission profile 仍从虚拟 `workingDir` + 本机 extraDirs 派生并下发远端 | `remoteHostOwnsCwd` 时 roots 为空、profile 不启用、`sandboxPolicy.writableRoots` 不含本机目录、会话内 `extraDirs`/`writableDirs` 不进入可变授权面；`codex/index.test.ts` 用真实 pin UA（0.159.2）+ 本机 extraDirs 断言所有下行帧不含虚拟/本机路径（修复前该断言会红） |
| 3 | 上条测试是假阳性：mock 默认 UA `mock-codex` 让版本门禁为 false | 测试显式设 `mock-codex/0.159.2` + 额外目录，先红后绿（已实测） |
| 4 | `codex/index.ts` fork 里读未进类型的 `remoteHostOwnsCwd` 字段是死代码 | 删除该分支：远端 fork 由 `maker-orchestration/fork.ts` 对 `source.remoteHostId` 抛 `REMOTE_NOT_SUPPORTED` 拦住，虚拟路径到不了 `thread/fork`；同处注释写明将来开放远端 fork 时要在宿主层带上所有权 |
| 5 | `remoteHostOwnsCwd` 只在 `maker-ipc/register.ts` 一个 funnel 打标，Goal 恢复 / IM / hook-control 冷启动漏标 | 判定下沉到 maker-core `lifecycleHooks.prepareStartOptions`（所有 `createSession` 必经），用唯一分类器 `remoteSessionHostOwnsCwd`（`remote-session-routing.ts` ← `classifyRemoteSessionTransport`）；register 不再重复打标。`remote-session-routing.test.ts` 钉矩阵 |
| 6 | `psb:<sessionId>` 的 codex 控制隧道只靠流 close 清缓存，psb 会话停止 / 重绑后残留长连接 | 新增 `releaseTunnelCodexControlChannel(remoteHostId)`（`end()` + 清缓存，幂等），PSB data-plane transport 终态时调用（`McprCodexTransportOptions.onClosed`）；`mcprCodexCapability.test.ts` 钉「释放一次 → 缓存清空 → 下次 hello 重开」与幂等；PSB 代关假设写在函数注释里，实现不依赖 |
| 7 | `pi-mcpr-remote.ts` 第三次手写 `startsWith(PSB_REMOTE_HOST_PREFIX)` 判 cwd 归属 | 改用 `remoteSessionHostOwnsCwd`（同 #5 的唯一判据），本文件不再 import 前缀常量 |
| 8 | `adminContext` / `adminStreamStatus` 在无内部会话时**新建 PSB 会话**读状态；写前占用闸门落地后等于「打开页签就静默占用空闲工作区」 | 读路径只借已有绑定 id（内存绑定 → 本机记录 `desktopSessions`），没有绑定返回 `null`；**2026-11-26 后续**：绑定改为工作区级 `stream/subscribe` 返回的桌面访问会话，读路径连「用户任务会话」也不再借；`psbWorkspaceAdminService.test.ts` 钉「不订阅、不创建会话、`lockChecks` 为空」 |
| 9 | 内部观看端按标题前缀 `Cindy 观看端` 认领 `listSessions`，可能认到别人的会话 | 只认本机持久化的绑定记录（`adminRecentStore.ts`，容量 16、幂等写），不认领陌生标题；**2026-11-26 后续**：该记录改为 `desktopSessions`（桌面访问会话），内部 Agent 会话只在旧 PSB 过渡回退时存在且带 `purpose:'internal'` |

**同批的 P2（低成本项）**：streamViewer `4008` 归因为稳定 token `heartbeat-timeout`；二进制帧
16 MiB 上限（超限丢弃 + 只告警一次）与 HTTP 响应 4 MiB 上限（超限 `PSB_PROTOCOL`、不重试）；
`remote-tunnel-dispatch` 的 `RemoteTunnelMode` 改用共享 `PsbTunnelMode`；会话级 `STREAM_START`
补占用闸门；错误横幅的 PSB 失败码映射收进共享表（`psbBannerMessageKeyForIpcCode`，被他人占用
用无名字兜底键），渲染层不再为单个码手写 if；`psb:<sessionId>` 控制通道的「旧流迟到 close 不误删
新缓存」与「hello 失败 kill 流」两处泄漏/竞态修复。**2 次 HTTP 的既定成本（2026-11-27 口径）**：
`psbClient.getSession` / `ensureForSession` 仍需 **2 次 HTTP**（会话行只带 `workspaceId`，占用 /
在线 / usable 必须再读列表——已按 2 次如实登记，见 §13.1 / §13.3 与 §15.6 / §15.10）。它现在是
**发送前占用闸门的每条消息固定成本**：用户复测要求「每次发送前都必须确认当前由我占用」，所以不再
按「加短 TTL 缓存」的方向优化——那会重新引入「交接后仍以为锁还在」的窗口。**已在后续 r10 清理**：会话级 5 条死面通道
（`STREAM_STATUS` / `STREAM_START` / `STREAM_STOP` / `STREAM_INPUT` + `STREAM_EVENT`，跨共享
常量 / preload / 桥 / guard）已删除，串流只走工作区级管理页通道（见 §4）。

**真机复测点**：① 隧道建立到首帧的等待时间应从 ~5s / ~1.2s 降到就绪帧到达即发（看 PSB 侧
`readyFrame=true` 与服务端首帧时间）；② PSB codex 会话启动后 `thread/start` / `turn/start` 不带
`/psb-remote/` 与本机目录（main 日志或远端 app-server 日志）；③ Goal 恢复 / IM 冷启动的 psb
codex 任务同样不带虚拟 cwd；④ psb 会话停止 / 重绑后该会话不再有活动的 `mode=cc-mgr` 控制隧道；
⑤ 打开「远程工作区」页签**不**订阅、**不**创建 PSB 会话、不产生占用；点「启动」才走工作区级
`stream/subscribe` 并出现画面（PSB 会话列表不再出现「Cindy 观看端」行，`sessionCount` 不增加），
重启后再打开能靠本机记录读到状态。

**PSB codex 真机回合在修复后的代码上未验证**：历史 11-26 上午的 codex 真机结论属于修复前代码；
本轮只有单测与 typecheck（`packages/maker-core` PSB 用例、`psbTunnelWiring`、`mcprCodexCapability`、
`remote-session-routing`），不得写成已验证。原因与影响登记在白名单 WL-30「未验证」第 10 条。

## 15. FIX-A 传输 / 安全 / 事件收口（2026-11-26 复审，实现事实）

本节只记 FIX-A 改动**后的最终行为**。前置章节（§2 / §3 / §4 / §5 / §6.1 / §11 / §13 / §14）
已按本节口径合并；若再发现冲突，以本节为准。

### 15.1 出网 URL 只有一份归一化判据（`resolvePsbUrl`）

`main/remote-workspace/psbEndpoint.ts` 的 `resolvePsbUrl(path)` 是
HTTP 与两条 WS 出网路径的唯一来源：`new URL(path, origin)` 后要求 ①origin 相同；
②**归一化后的 pathname 与原始 pathname 逐字节相同**（`..` / `%2e%2e` / 反斜杠 / `//`
等 URL 解析器会改写的形态因此全部拒绝）；③以 `/api/cindy/remote/` 开头。旧实现只查字面
`..`，`%2e%2e` 会被 URL 归一化到命名空间之外，带 Bearer 的请求可被服务端下发的 action 路径
指到别的路由。`psbWebSocketUrl` 复用同一校验器；`psbClient` 的所有请求（含 VCS action）都经
它拼 URL，`isAllowedPsbRemoteActionPath` 只是同判据的布尔包装。CINDY-RW-17 起**不存在**任何
`/api/remote/**` 例外：拉起访问走 Cindy 命名空间的 `access/start`（§11.8），`resolvePsbUrl`
只接受 `/api/cindy/remote/**`。

### 15.2 VCS 处置动作：kind → 固定路径 + 固定方法（不采信服务端 method/path）

`main/remote-workspace/vcsNotice.ts` 的 `workspaceVcsActionTarget(workspaceId, kind, operation)`
是唯一目标表：`inspect-vcs`=GET `…/workspaces/<id>/vcs`；`clean-workspace` / `revert-vcs`=
POST `…/vcs/revert`；`revert-then-occupy`=POST `…/occupy`；`revert-then-release`=DELETE
`…/occupy`；`retry` 按产生 notice 的入口决定方向（`release` → DELETE occupy，否则 POST
occupy）；`continue` 不发请求。服务端下发的 method/path 只用于**确认这是一条已知 action**：
方法必须与固定目标一致、pathname 必须等于固定路径、形状校验（同工作区 `decodeURIComponent`
比较 + 每段拒绝 `.`/`..` + 禁 `force`）必须通过，否则整条丢弃。`isAllowedPsbRemoteActionPath`
保留为发请求前的第二道兜底。

### 15.3 管理页串流：多窗口引用计数 + 帧定向 + 主动关闭定向

- `ipc.ts` 的 owner 账本改为 `createPsbStreamOwnerRegistry()`（`streamOwners.ts`，纯结构）：
  `workspaceId → Set<webContentsId>`；start +1、stop/窗口销毁 -1，**只有归零才 `streamStop`**。
  窗口销毁另有兜底（清帧 owner + 归零工作区停流）。
- `push.ts` 的 `ADMIN_STREAM_EVENT`：`frame` / `cursor` 只发给登记过 owner 的窗口（没有 owner
  时回退广播）；`status` / `error` 与 `CONTEXT_CHANGED` 仍广播；本端主动关闭的
  `closed(client-stopped)` / `closed(superseded)` 只发给该 `viewerSessionId` 的 owner，没有
  owner 时丢弃（广播会把只是打开同一工作区页面的窗口误判成「串流被关闭」）。
- `streamViewer.ts` 的本端主动关闭按原因区分：替换旧连接 → 补发 `closed(reason='superseded')`，
  用户停止 → `closed(reason='client-stopped')`；`dispose` 与握手失败不推（没有可报的界面）。
  旧实现一律不推，渲染层只能靠 invoke 返回值猜状态。
- **多窗口复用与渲染层非终态（2026-11-27 复审 P1）**：管理页 `streamStart` 发现该工作区已有
  健康观看连接（绑定上的 `viewerActive`）时**复用**：返回当前状态、不重连、不产生 `superseded`，
  这次启动只表示多一个 owner（owner +1 由 IPC 层在成功返回后登记）；连接真的断了（`closed` /
  `error` / 显式停止）才清 `viewerActive`。`superseded` 在渲染层是**非终态**：新连接继续向同一个
  `sessionId` 送帧，所以保留相位、不清屏、不提示、也不释放 owner；`client-stopped` 才回 `idle`。
- **本端内部收尸不转发（`quietStreamStops`）**：失效绑定重建前的旧连接、代次竞态里的自停都会让
  `streamViewer.stop` 补发 `closed(client-stopped)`；它不是用户动作，`adminService.handleStreamEvent`
  只更新本端状态、不转发，避免把正在看的其它窗口误判成「串流被关闭」。
- **`starting` 相位的停止标记（2026-11-27 复审 P1）**：渲染层在 `starting` 卸载 / 快速停止时也会
  发 `STREAM_STOP`，但这时 `STREAM_START` 可能还在 PSB 里飞、owner 尚未登记。`ipc.ts` 的
  `adminStreamReleasePending` 先落「启动在途停止」标记；`STREAM_START` 落定后消费它：**不登记
  owner**，并按「最后离开者」判据收掉刚起来的流（启动失败则清标记），防止 owner / 观看名额永久
  残留。落定处还要判 `event.sender.isDestroyed()`：窗口在启动在途被销毁时不登记 owner、清该窗口
  的停止标记，并按「没有观看者」收流——否则 `destroyed` 兜底监听没机会挂上，owner 永不归零、
  PSB 观看名额泄漏到进程退出（`psbAdminStreamOwnership` 有对应用例）。

### 15.4 重启观看端：预检通过后原子替换，失败保留旧连接

`streamViewer.startInternal` 顺序：读 `stream/status`（能力位）→ 取 token → 取出站 agent →
建新 WS 并等握手成功 → 才 `active.set` 并关旧连接。预检或握手任一步失败时**旧连接原样保留**
（画面不中断），修复了「重启时 PSB 抖一下 / 预检失败 → 用户从有画面掉到空面板」。

### 15.5 agent-tunnel：就绪能力探测 + 就绪期字节回放 + 结构化错误

- `PSB_TUNNEL_READY_*` 仍是兜底，但**进程级探测一次**就够：第一次收到
  `agent-tunnel.ready` → `supported`；第一次超时 → `unsupported`，后续连接在 `open` 时立即交
  句柄（老服务端的兼容行为本来就是「直接发」）。不再每条长连接固定等 5s / exec 1.2s。
- 就绪前的 binary 帧先有界排队（1 MiB，`wsFrames.ts`），句柄交给调用方后**在首个 stdout 订阅
  者出现时按序回放**，不再丢首帧。
- 失败改抛 `PsbTunnelError { code: PSB_TUNNEL_FAILURE_CODES, detail, failure? }`（`message` 仍
  是 `[CODE] detail`），HTTP 与隧道共用 `psbAuthFailure` 的 token 失败归因：未登录
  （`signed-out`）/ 非企业组织（`need-org`）→ `PSB_AUTH_REQUIRED` + 身份原因键；签发通道失败
  （`unreachable`）→ 网络类码。取 token 失败**不失效** token 缓存（失效只发生在 PSB 明确
  401/403 之后）。
- 字节搬运与 `ExecStreamHandle` 包装抽到 `wsFrames.ts`（`toBuffer` / `toArrayBuffer` /
  `createExecByteStream`），PSB 的两条 WS 与 MCPRouter 的 `agent-tunnel` **已共用同一份**：
  `main/maker-host/mcpr-tunnel.ts` 已改为 import `wsFrames`（第三份副本已删除），两条通道的差别
  只在参数（`binaryOnly` 不传、`closedErrorCodes:[4003,4004]`、`classifyError` / `classifyClose`）。

### 15.6 开新会话：先读工作区、再建会话（不产生孤儿会话）

`psbClient.createSession` 现在先 `requireWorkspaceById`（1 次列表 HTTP），再 POST 建会话
（共 2 次请求）。旧实现先建会话、再补读工作区，补读失败会把**已经建好的 PSB 会话丢掉**
（抛错 → 调用方认为没建成 → 远端留下无人认领的会话、本地不落 `remoteHostId`）。读工作区
失败发生在创建之前：一个请求都不发。`getSession` 的成本仍是 2 次请求（会话行 + 工作区列表，
PSB 没有单工作区读口），§13.3 的「读一次会话行」按本节口径修正为 2 次。

### 15.7 `ensureWorkspaceAccess` 的总预算是 deadline

`accessPoll = { attempts?, intervalMs?, totalMs? }`，CINDY-RW-17 起默认 `{180, 500, 90_000}`
（90s 覆盖 Unity / 虚拟桌面冷启动）。每次请求的超时被压到「剩余预算」以内，最坏等待恒为
`totalMs`；单测注入 `intervalMs:0` + 短 `totalMs` 避免真实等待。

### 15.8 列表解析：缺键是协议错，不是空列表

`readArray` 在 `data` / 列表键不是数组时返回 `null`，由 `call` 统一抛 `PSB_PROTOCOL`；
单行缺 id 仍按行丢弃但记 warn。旧实现把缺键静默变成 `[]`（界面显示「没有工作区」而真实原因
是契约违约）。

### 15.9 发送前重建：确定性去重键

`psbClient` 的 `clientRequestId` 由 `(localSessionId, previousPsbSessionId)` 经
`deriveRebindRequestId` 确定性派生（`psb-rebind-<sha256 前 32 hex>`），同一旧身份的重试复用
同一个键（PSB 只建一条会话），不再是每次 `randomUUID()`。`PsbSessionRebindDeps.createRequestId`
降级为可选且不再调用（装配可删）；`PsbSessionRebindRow.workspaceId` 类型如实为 `null`
（本地没有这一列，工作区 id 的唯一来源是旧 PSB 会话行）。main 侧不再拼中文兜底句子：失败只给
码（`PSB_AGENT_UNSUPPORTED` / `PSB_CLIENT_OFFLINE` / `PSB_WORKSPACE_NOT_READY` /
`PSB_NOT_FOUND`），文案在 i18n。

### 15.10 唯一可写判据 `psbWorkspaceWritable`（三处收敛）

`shared/psb-remote-workspace.ts` 的 `psbWorkspaceWritable(workspace, { requireAgentRuntime })`
是「能不能写」的唯一判据（先信 PSB 权威 `usable` / `unusableReason`，再用本地字段兜底），
返回 `{ok, reason, ipcCode, messageKey, inputMessageKey, personName, state}`。三处收敛：
`workspaceLock.decideFrom`（`requireAgentRuntime:false`：占用闸门服务建会话 / 启串流 / 发送，
「没装某个 Harness」不阻断与它无关的写）、`sessionRebind.assertWorkspaceStartable`
（`true`：要新建 Agent 会话）、`psbWorkspaceHealth` / `psbSessionInputAllowed`（渲染层禁用态）。
`workspaceLock` 的文件头与端口注释如实写明 `ensureForSession` 不命中缓存时是 **2 次 HTTP**
（会话行 + 列表），而不是「一次会话行」。

### 15.11 定向测试

`main/remote-workspace/__tests__` 全量 240+ 用例：新增 encoded-dot / 方法不匹配 / retry 方向 /
固定目标（`vcsNotice`）、归一化 URL 白名单（`psbEndpoint`）、列表契约与 2 次请求 /
先读后建 / deadline（`psbClient`）、ready 探测与就绪期回放 / token 归因（`psbTunnel`）、
原子替换与失败保留旧连接 / 主动关闭补发（`streamViewer`）、usable 权威原因（`workspaceLock`）、
确定性去重键与 agent-unsupported（`sessionRebind`）、多窗口引用计数（`streamOwners`）、
多窗口 owner + 启动在途停止 + 主动关闭定向（`psbAdminStreamOwnership`，真实 handler 与推送）。

## 16. r7 审查修复：能力描述符 / 归因码 / 释放（2026-11-26 夜，实现事实）

审查（r7 独立审查，2026-11-26）在本块列了几条「同一事实写三遍 / 归因指错系统」的
问题。本批按「一处判定、其余消费」收口；H 的文档汇总只改组织，本段是实现事实正本。

### 16.1 transport 能力描述符（唯一能力表）

`main/maker-host/remote-session-routing.ts` 现在同时是分类器与能力表：

```ts
resolveRemoteTransportCapabilities(remoteHostId): {
  transport: 'local' | 'ssh' | 'mcpr' | 'psb';
  tag: 'LOCAL' | 'SSH' | 'MCPR' | 'PSB';   // 错误码 / 日志归因
  ownsCwd: boolean;                        // 只有 psb: true
  tunnelModeByAgent: Record<RemoteAgentKind, RemoteTunnelMode> | null; // 隧道 transport 才有
  fileOpsMode: 'local' | 'ssh' | 'tunnel-exec';
  codexCredentialMode: 'gateway-key' | undefined;
}
```

- `remoteSessionHostOwnsCwd()` / `isTunnelRemoteSessionTransport()` /
  `resolveRemoteCodexCredentialMode()` 全部改为读这张表（不再各自判断前缀）；
- `remoteTunnelModeForAgent()`（`remote-tunnel-dispatch.ts`）也从这张表取 mode，映射本身复用
  共享契约的 `psbTunnelModeForAgent` —— `psbTunnelModeForAgent` 不再是零调用函数；
- `McprTunnelMode` 从第二份字面量联合改成 `PsbTunnelMode` 的类型别名：MCPRouter 与 PSB 是
  同一份 mode 语义，新 mode 只改共享契约一处；
- cc 宿主：`resolveRemoteCcTunnelStartParams()`（`remote-cc-start.ts`）是 cwd 的唯一判定点，
  **不再用第二分类器 `parsePsbRemoteHostId`**（畸形 `psb:` 在分类器里仍是 psb，但解析返回
  `null`，曾把虚拟 `/psb-remote/…` 原样下发 → daemon 侧 SDK 用不存在的目录 spawn
  `claude` → query 首个 turn 前终止、本地会话被自动关闭）。畸形 `psb:` 现在同样改成 `.`；
- 远端 Skill 发现：`ListAgentSkillsOptions.remoteHostOwnsCwd` 由宿主按能力打标；claude 的
  `listAgentSkills` 在该标记下**不拿虚拟 workingDir 拼远端目录**（只列 agent 全局 Skill），
  与 codex 的 PSB 口径一致；
- pi 的 `pi/ensure` 新增显式 cwd 契约（`cwdPolicy: 'host' | 'command' | 'explicit'`，
  见 `docs/dev-rules/pi-harness.md`）；SSH / MCPR 传 `'command'`、PSB 传 `'host'`，
  daemon 不再用进程 cwd 隐式兜底。

### 16.2 归因码跟着 transport 走

`remoteTransportErrorCode(remoteHostId, code)`：`psb:` 会话得到 `[PSB_…]`、`mcpr:` 得到
`[MCPR_…]`、SSH / 本地得到中性的 `[REMOTE_…]`。`pi-mcpr-remote.ts` 原先固定写
`[MCPR_PI_*]`（PSB 会话上会指向错误系统），现在全部改走这个函数，文案只描述「远端没有暴露
该运行时 / 能力」，不再点名 MCPRouter。`mcprPiMcpBridgeUnavailable` 同理。

### 16.3 隧道登记：两种作用域一张表

`remoteTransportRegistry` 增加**按隧道身份**的登记档（`registerRemoteHostTransport` /
`releaseRemoteHostTransport` / `listRemoteHostTransports` / `releaseAllRemoteTransports`）：

- `psb:` 的 Codex app-server 连接按 `psb:<PSB sessionId>` 复用（Maker 会话可在同一 PSB 会话上
  重建 runtime，长连接只有一条），所以按 host 作用域登记；
- pi 的 `mode=pi` 隧道按 Maker 会话登记（与 cc 同档）；
- 释放入口单一（先删条目再 dispose，单次语义），诊断表 `listRemoteTransports` /
  `listRemoteHostTransports` + 事件流都可见。`maker:debug-remote-transports` 仍只读会话档。
- **字节工具只有一份**：两条 PSB WS 通道与 MCPRouter 的 `agent-tunnel` 共用
  `remote-workspace/wsFrames.ts` 的 `toBuffer` / `createExecByteStream`（MCPRouter 不传
  `binaryOnly`、`closedErrorCodes: [4003, 4004]`，与 PSB 的差别只在帧语义声明）；
  `psb-agent-tunnel` 把 `getPsbConnectionToken` 的 `kind` 一并交给隧道层（未登录 / 缺组织 /
  签发通道不可达的归因更准），`detail` 只用于诊断、不进用户可见文案。

### 16.4 会话结束释放占用（用户要求）

`maker-host/psb-workspace-session-release.ts` 是 main 侧的释放端口（幂等、可重试、不阻断）。
**触发与事实判断都在 main（单权威）**：

- 触发点：任务进入终态（`localDb/ipc/sessions.ts` 的 `cleanupSessionTerminalArtifacts` 经
  `setTerminalSessionStatusObserver` 注册槽，覆盖批量归档 / 元数据 patch / 侧删 / 解绑）、
  应用退出（`bootstrap-electron.ts` 的 `onQuit('psb-workspace-session-end-release', …, 'async')`，
  并行释放 `status='active' AND remote_host_id LIKE 'psb:%'` 的任务 + 两种作用域的隧道 +
  待释放账本重试）。渲染层**不再**对同一次归档 / 删除重复上报：`psbOccupancyRelease.ts` 降为
  **旧 main / 旧 preload 的兼容账本**——能力探测 `releaseWorkspaceForSession` 存在 = 新 main 已有
  终态 observer，渲染层零调用、不写本地账本；只有旧 build 才把结束事件入账并在启动 / 可见 /
  pagehide 补投一次。同一动作因此只产生一轮 PSB 请求，不会双记账。
- **工作区级而不是会话级**：归档其中一条时，只要同一工作区还有**活动**（`status='active'`）的
  `psb:` 任务，就跳过释放且**不入账**（`reason:'workspace-in-use'`）——提前解锁会让别人接手
  正在使用的工作区。判据只能在 main 算（会话表 + 本机会话→工作区映射 + PSB 状态）。
- 口径：先读 PSB 会话行，只有「由我占用」才 `releaseWorkspace`（PSB 侧幂等）；未占用 / 别人
  占用 → 成功 no-op；失败（网络 / 鉴权 / 5xx）记进**有界进程内账本**
  （`listPendingWorkspaceReleases` / `retryPendingWorkspaceReleases`），同一 `(sessionId, reason)`
  只留一条。**账本条目带 `workspaceId`**（读会话行成功那一刻记下）：重试优先按它直接
  `releaseWorkspace`，不依赖 PSB 会话行还在（会话 404 时锁仍可归还），也不再为一条账本各打一次
  `sessionStatus`；`workspaceId` 未知才回退读会话行。`NOT_FOUND` / `FORBIDDEN` /
  `WORKSPACE_OCCUPIED_BY_OTHER` 是**终止归因**（没有可释放的东西）→ 出账并留日志，不再重试。
  条目带 **dataOwner 印记**：切号后新身份不替旧账号归还工作区（那是越权），账号边界 / teardown
  直接清账本。
- **重试前的两道复核（2026-11-27 终局复审 P1）**：① **这条会话是否又被恢复成活动任务**
  （`ledgerSessionActivity` 按 `localSessionId` 查本机活动 `psb:` 任务）——`active` 时只出账，
  **不释放锁、也不收隧道**（锁正被恢复的任务合法占用）；读活动列表失败（`unknown`）保留条目。
  ② **同工作区是否还有别的活动任务**——只有 `mapping` / `session-status` 的确证结论才出账；
  `unknown`（读不到本机映射且 PSB 会话行也读失败）**保留条目**，不把「无法确认在用」当成
  「别人在用」把待释放义务与提示条一起静默丢掉。首次释放路径遇到 `unknown` 同样保守按
  「在用」跳过、不提前解锁。
- **不**在普通 runtime close 上释放：`/clear`、换模型、漂移回收都会 close，那不是任务结束，
  释放会让协作锁在用户还在用时被别人拿走；真正的「任务结束」= 归档 / 删除 / 应用退出。
- **渲染层常驻提示条（2026-11-27，T3）**：`features/remote-workspace/release/PsbPendingReleaseNotice.tsx`
  + `pendingReleaseNoticeStore.ts` 在主窗挂一次（副窗 / 侧栏窗不挂，同一账本不会渲染多份），把
  **main 账本**与**工作区级账本**（picker 放弃草稿 / 在途取消）合并成一条展示：右下角非阻塞
  （`role=status` + `aria-live=polite`，`pointer-events` 分层不遮输入）、计数徽标 + 最多 3 条
  原因行（余下用 `+N` 折叠），「重试」是**唯一**入口：先重试 main 账本，再重试**未被 main 覆盖**
  的工作区级条目（同一工作区两本账并存时由 main 代表，避免对同一把锁打两次；旧 preload 缺 main
  方法时两本账各自重试），不排后台重试；「关闭」只隐藏**当前这一批**（账本仍在，新的失败会重新
  出现），重试后仍失败时正文换成 `releaseRetained`。**展示按 `workspaceId` 跨源去重**：同一把
  工作区锁只出现一条（main 条目优先；main 内部同一 `workspaceId` 取最近失败那条；读不到
  `workspaceId` 的 main 条目按来源 key 保留），所以计数 = 可能被占住的工作区数。**失败码归一**：
  main 账本的 `failureCode` 是 PSB 原始码，经共享单表的 `psbFailureDescriptorForPsbCode` 归一成
  文案键再交给 `psbFailureText`（归一不了的码才保留原始码），不在渲染层另抄码表。旧 preload /
  无 bridge 时订阅 no-op、读取空快照、重试不假成功。「N 个远程工作区」的带数量汇总文案键留给
  i18n Wave 2，当前用计数徽标表达 N。12 locale 的 `remoteWorkspace.draft.releasePending` /
  `releaseRetained` 文案已在跨组集成波次补齐。
- **渲染层会话级事件账本（兼容层）**：只在旧 main / 旧 preload 时生效（见上），补投覆盖归档 /
  删除 / 启动 / 可见 / pagehide；`ok:false`（新 main 已记账、负责重试）按「已送达」处理，渲染层
  不再为同一事件排第二份重试。
- **IPC 接线（跨组集成波次，2026-11-27）**：共享通道 `RELEASE_SESSION_WORKSPACE` /
  `PENDING_RELEASES_GET` / `PENDING_RELEASES_RETRY` / `PENDING_RELEASES_CHANGED`，preload
  `psbRemote` 桥四个对应方法，bridge.ts 类型同步；guard 表与 main handler / preload / bridge
  一一对应。旧 preload 缺方法时渲染层退回留账、下次启动补投，main 端口未装配时回 `not-wired`
  （同样留账）——两者都不假装释放成功。

### 16.5 测试与验证现状

定向单测：`maker-host/__tests__/psbSessionStatus.test.ts`（TTL / 并发共享 / fail-open / 404
清快照 / 事件失效 / 上限）、`psbWorkspaceSessionRelease.test.ts`（释放 / 幂等 / 非 psb no-op /
同工作区还有活动任务 → `workspace-in-use` 跳过且不入账 / 同工作区「在用」结论 `unknown` 时
**保留条目** / 会话归档后又被恢复成活动任务时重试**只出账不释放锁** / 账本按 `workspaceId`
直接重试 / `NOT_FOUND` 等终止归因出账 / dataOwner 切号边界 / 失败记账 / 退出并行释放）、
`remoteTransportRegistry.test.ts`（会话 + host 两档 + 退出全释放）、`remote-session-routing.test.ts`
（能力表 / mode 单表 / 归因码 / `resolveRemoteCcTunnelStartParams` 含畸形 `psb:`）、删除
`remoteCcQueryFactory.test.ts` 的源码文本 cwd 守卫改为行为断言、`localDb` 侧
`sessionRemoteRebindTx.test.ts`（CAS 冲突不落标记 / 删任务拒绝 / 不清理原生会话时不写交接）
与 `contextRebuildPersistence.test.ts`。跨组接线（2026-11-27）：`psbRemoteIpcWiring.guard.test.ts`
扩表覆盖 4 条新通道 + 「释放判据在 main、IPC 层只映射结果」守卫；`psbOccupancyRelease.test.ts`
覆盖 main 单权威探测（新 main → `main-authority` 零调用）、旧 main 补投、`ok:false`（main 已记账）
按送达处理、`not-wired` 留账、main 账本读/重试/推送订阅与旧 preload 降级；常驻提示条
`features/remote-workspace/release/__tests__/PsbPendingReleaseNotice.test.tsx` 覆盖「账本非空 →
显示计数」「跨源同 `workspaceId` 只显示一条（main 优先）且重试只打一次」「重试失败保留 +
`releaseRetained`」「关闭只影响显示、新失败重新出现」「main 原始 PSB 码归一 / 归一不了回退原文」
「副窗 / 侧栏窗不渲染」「旧 preload 不崩」。

**发送路径权威占用校验（2026-11-27 用户复测）**：`remote-workspace/__tests__/workspaceLock.test.ts`
（整文件 **20 例**；新增权威路径四类：每次读会话行 / 缓存过 mine 但权威读 other → 拒绝且清缓存 /
权威读 free → **`occupy-required`（0 次占用请求）**、显式允许后才占用 / 权威读失败 → 抛出且不缓存）、
`maker-ipc/__tests__/makerSendTransaction.test.ts`（整文件 **323 例**；新增「连续两条各过一次
闸门」「权威读为他人占用 → 第二条不派发、不落库、`PSB_WORKSPACE_OCCUPIED_BY_OTHER`（带人名）」
「权威读为无人占用 → `PSB_WORKSPACE_NOT_OCCUPIED`（0 次占用）、用户确认占用后同一条才发出」
三个事务级用例）、`psbRemoteIpcWiring.guard.test.ts`（整文件 **12 例**；钉住发送闸门不再引用 10s
快照 store、不再 fail-open，且三个接入点都带 `allowAutoOccupy: false`）。**工作区选择状态机（同日，见 §9.8）**：
`dialog/__tests__/RemoteWorkspacePickerDialog.test.tsx`（整文件 **17 例**：确认占用只占一次、取消
不占用不选中、mine 直选不弹确认、他人占用 / 离线行原生 disabled、切换 / 关闭只归还一次、交接后
不归还、listbox 方向键不占用）、`draft/__tests__/PsbWorkspacePicker.test.tsx`（整文件 **13 例**：
下拉同一流程 + 草稿在途整块禁用 + 卸载后迟到成功归还）。

**定向运行（2026-11-27 本机单次，非门禁）**：在 `apps/desktop` 下对上面 4 个文件跑
`pnpm exec vitest run` → **4 files / 372 tests passed（8.95s）**
（17 + 322 + 20 + 13 = 372）。包级 typecheck：`desktop`（main + renderer 分片）、
`@cindy/maker-core`、`@cindy/maker-pi-manager`。

**以上均为单测 / 源级守卫证据，真机未验证**：本轮新增的选择器占用确认弹窗 / 行状态徽标 / listbox
焦点态**未做 Light / Dark 实机目检**，确认占用 → 交接 → 交接后发送校验的 **PSB 端到端也未验证**，
不得写成已通过。真机复测点：① **每条消息**发送前 PSB 侧请求日志应看到一次会话行 + 一次工作区
列表（发送闸门的权威读；重建判定本身仍走快照，不额外打 `sessionStatus`）；② 工作区被交接给
别人后，下一条消息仍能读到状态一致的结果（拒绝并显示人名）；③ 无人占用行点击先弹占用确认、
取消后不占用不选中，mine 行直接可选、不弹确认；④ 终态后下一条消息透明重绑且模型记得前文；
⑤ 归档远程任务后工作区立即可被他人占用（同一工作区还有另一条活动远程任务时应**保持占用**）；
⑥ 退出应用后 PSB 工作区不再显示本地占用；⑦ 释放失败时常驻提示条能读到 main 账本并显式重试、
重试失败换成「占用可能仍未解除」文案（UI 已实现、单测覆盖，真机未验证）。


