# MCPRouter 远程任务路由契约

> **状态**：权威开发规则（authoritative）
> **读取时机**：修改 Desktop 远程任务启动、恢复、SSH preflight、MCPRouter tunnel 或
> `remoteHostId` 处理时。

## 1. 两种远程身份

`remoteHostId` 不是统一的 SSH 主机名字段，而是两种 transport 身份的联合：

- `mcpr:<instance-id>`：MCPRouter 账号隧道的逻辑实例身份。这里的值必须是服务端实例记录的
  稳定 `id`（不是可变的显示/业务名称 `instanceId`）。`routerService.normalizeInstance()`
  用同一个 `id` 构造 `remoteHostId`，MCPRouter bridge 查询也必须按 `instance.id` 匹配；两处
  不得混用，否则实例列表明明存在仍会报 `MCPR_INSTANCE_NOT_READY`。分类器按
  `MCPR_REMOTE_HOST_PREFIX` 识别，具体实例值再由 `parseMcprRemoteHostId` 校验；它必须
  进入 `openMcprTunnel`、`remoteCcQueryFactory` 或 `createMcprCodexTransport`，不能查 SSH
  pool。即使值是不完整的 `mcpr:`，也不能降级成 SSH host。
- 其它非空值：SSH Remote 的 host id，才允许进入 `ensureRemoteHostReady`、
  `ensureRemoteAgentInstalledOrInstall`、`getRemoteSshPool().get` 以及 SSH MCP bridge
  的注入/恢复逻辑。

空值表示本地任务，不进入任一远程 preflight。

SAGA2 战斗 Lead 需要创建服务器只读 Worker 时，不得让模型从项目 ID、显示名或实例
`instanceId` 拼接 `mcpr:`。Host 只在用户已经绑定技能 ID 后，读取当前项目绑定、筛选唯一的
available/supported 服务器实例，并按实例 `agentType` 执行 Claude cc-manager 或 Codex 控制通道
的 capability hello；随后把 `remoteHostId` 与匹配的 `workerAgent` 作为一组任务级可信字段
注入，模型必须原样传给 `create_worker`。Worker 创建入口仍需重新核对稳定记录 `id`、项目绑定、
在线状态、实例 Agent 类型和 capability，不能把 prompt 字段当成授权事实。零个或多个
capability-ready 服务器目标都不得猜选，Agent 类型不一致也必须拒绝。

服务器能力核查 Worker 与 Lead 运行在不同设备时，`initial_task` 只能携带逻辑证据（技能 ID、
导出结论、协议字段和待核查语义），不得依赖 Lead 主机的绝对项目路径或临时导出路径。
Host 在统一 `create_worker` 请求及后续首任务派发边界，对带
`[SAGA2_COMBAT_REMOTE_SERVER_WORKER]` 标记的任务移除 Windows/Unix 主机绝对路径；Worker
使用自身的远程工作目录和当前 `HEAD`。普通 Worker 任务不经过该处理，保持原始消息内容。

## 2. 启动与恢复不变量

所有会话创建、lazy resume、send 前置和 Main 发起的 Worker bootstrap 都必须先完成
transport 分类，再执行 transport 专属动作。MCPRouter 会话不得因为“远程”这个共同字段
而经过 SSH preflight；恢复路径也必须在进入 SSH pool 前过滤 `mcpr:`。

`apps/desktop/src/main/maker-host/remote-session-routing.ts` 是分类的唯一纯函数入口。新增
远程路径时复用 `classifyRemoteSessionTransport`，不要复制 `startsWith('mcpr:')` 或直接
把 `remoteHostId` 传给 SSH API。

## 3. 合并防回归

同步 `origin/main` 到 `meka/main` 时，冲突解决必须逐项核对上述不变量。特别检查：

1. `register.ts` 的 MCPRouter guard 仍位于 `ensureRemoteHostReady` 之前；
2. `maker-host/index.ts` 的 Claude/Codex transport factory 仍保留 MCPRouter 分支；
3. bridge shutdown、turn-settled、bridge-recreate 等 SSH-only recovery 不会把
   `mcpr:<instanceId>` 放入 SSH pool；
4. 运行 `remote-session-routing` 与 `remoteSessionMakerMemory` 回归测试，并检查最终
   合并结果，而不是只检查某一个父提交。
5. `maker-host/index.ts` 的 Claude `remoteCcQueryFactory` 必须在 SSH pool 查询前打开
   MCPRouter tunnel；共享 `cc-manager-client` 必须同时支持 SSH host 与 MCPRouter byte stream，
   并在两种 transport 上保留当前协议的 approval、subagent model access 与 bundle hello。
6. Codex 的 MCPRouter 分支必须成组保留 transport、remote credential mode 以及 capability
   thread register/unregister；只恢复其中一项仍会在启动鉴权或远端 Skill 路由阶段失败。
7. **任何新增的 SSH-only 探针（远端清单、远端 host 探测、远端文件系统读取）都必须先
   `classifyRemoteSessionTransport`，`mcpr:` 不得进入 SSH-only 分支。**
   上游 `340888c77d` 新增的「按 SSH 执行主机读远端 Codex 清单」探针
   `readSshCodexModelList`（`apps/desktop/src/main/remote-ssh/codex-model-list.ts:16`；其内部把
   一切失败折叠成 `throwIpcError('SSH_EXEC_FAILED', 'Unable to read remote Codex models; reconnect and retry')`，
   见该文件 `:30`）新增时有**三个 `mcpr:` 可达的调用点漏按 transport 分类**，会让 MCPRouter Codex 的
   **会话创建 / 改模型 / Orca 远端 worker 创建全部硬失败**：
   `apps/desktop/src/main/maker-ipc/register.ts` 的 `assertModelRouteUsable`（约 `:6937`，函数体
   `:6924` 起）、注入给 maker-host 的 `getProviderRoutingContext` dep（约 `:11417-11420`）、
   `SET_MODEL` handler 的 `sshCodexProviders` 分支（约 `:16795-16798`）。
   本轮已在三处统一加 `classifyRemoteSessionTransport(remoteHostId) === 'ssh'`，`mcpr:` 回落通用路径
   （`getProviderRoutingContext()` / 非 SSH 的 provider 解析），不再触发该探针。
   **新规则**：新增任何 SSH-only 探针时，调用点必须先分类，且**不得**用
   `startsWith('mcpr:')`、`parseMcprRemoteHostId` 之类的一次性判断代替共享分类器；分类为
   `mcpr` / `local` 时必须走各自的通用路径，SSH-only 分支只接受 `'ssh'`。
   **2026-10-08 补记（渲染层同样适用）**：那次修的是**主进程**三处，**渲染层漏了**，于是实机
   又炸了一次 —— `ChatInput` 把任意 `remoteHostId` 当成「SSH Codex 主机」
   （`sshCodexHostId`），MCPRouter 的 Codex 会话因此：报
   `SSH_EXEC_FAILED: Unable to read remote Codex models`、经 `remoteModelListBlocked`
   **连发送都被拦下**、并用空清单当远端模型面（模型选择器少掉一大批模型，本机普通会话正常）。
   修复与口径：
   - 判定收在渲染层的唯一纯函数 `apps/desktop/src/renderer/lib/remoteCodexModelHost.ts`
     （`resolveRemoteCodexModelHostId`），消费方是 `ChatInput` 的 `sshCodexHostId` 与
     `sshSessionModelSelection.ts` 的 `loadSshSessionModelSelection`；
   - **MCPRouter 的 Codex 模型面是本机目录**，不是远端探测：远端 bridge 只带本机 AI Gateway
     key（`mcpr-codex-capability.ts` 的 `buildRemoteCodexBridgeHeader`，
     `resolveRemoteCodexCredentialMode` 判 `'gateway-key'`），而 SSH 那台主机有自己的登录与
     `CODEX_HOME` —— 两者不可互推；
   - 渲染层 import 不到主进程分类器，所以 `remoteCodexModelHost.test.ts` 用**输入矩阵**断言两侧
     判定永远一致（含畸形 `mcpr:` 留在 MCPRouter 一侧）；这是这条规则不再两处漂移的机制，
     而不是靠注释约定；
   - 第二道保险在 `main/remote-ssh/index.ts` 的 `LIST_CODEX_MODELS` handler：先分类，非 SSH 抛
     `INVALID_PARAMS`，将来漏改时失败归因仍是事实，不会退化成「重连后重试」。
8. **每个远端 hook 的第一句都必须完成 transport 分类或引擎门禁**，而不是只要求
   「SSH-only 探针」分类。2026-09-29 实机证明了这条更严的口径：Pi 引擎在 MCPR 位置下
   建任务，首条消息报
   `LAZY_CREATE_FAILED: remote SSH host "mcpr:f235de4c-…" not found in pool — connect it first under Settings → Remote`。
   外围 preflight 已正确跳过 SSH（上一节第 7 条的 `ensureRemoteReadyForSessionStart`
   在 `mcpr:` 上直接 return），**但 `maker-host/index.ts` 里 Pi 的 6 个远端钩子
   （`getRemotePiTransport` / `getRemotePiFileOps` / Pi 侧 `getRemoteAgentFileOps` /
   `resolveRemotePiBinaryPath` / `rewriteRemotePiMcpBridgeUrl` / `getRemotePiAgentProxyEnv`）
   以及伙伴 Skill 的 `readSkillSource` / `fingerprintSkillSource` 一个都没分类**，
   于是 `mcpr:<id>` 直接进了 `getRemoteSshPool()`。当时的处置是加一道**引擎级静态门禁**
   （`assertMcprHostSupportsAgent` + 类型化 `MCPR_AGENT_UNSUPPORTED`），让这个组合在读取
   SSH pool 之前失败。

   **2026-10-09 订正：`pi` + `mcpr:` 已实现，门禁整体撤除。** MCPRouter 侧新增 `mode=pi`
   与 `mode=exec` 两条隧道，客户端接缝在 `apps/desktop/src/main/maker-host/pi-mcpr-remote.ts`：
   - **数据面 `mode=pi`**：runtime 把隧道接到 `pi-manager bridge --socket <受管 socket>` 的
     stdio；客户端先在这条隧道上跑 pi-manager **既有 RPC**（`protocol/hello` +
     `pi/ensure(sessionId, cmd, env, envHash)`，与 SSH 同一个启动方式），ensure 响应之后的
     字节就是该 session 的 pi JSONL —— 因此 Pi 协议实现与 SSH **共用同一份**
     （`pi-remote-transport.ts` 的 `createPiTransportFromProvider`）。
   - **执行面 `mode=exec`**：单连接单次执行，语义等价 SSH 的 `remoteHost.exec`
     （实例容器内、runtime 同一非 root 用户）。Pi 与 Claude 的远端 file ops **原样复用**
     `createRemotePiFileOps` 那批 bash 脚本，差别只是 exec 从哪条通道来；客户端不额外加
     路径/命令白名单（真正的边界是容器与用户身份）。末帧的**加性可选** `truncated:true`
     （只在服务端输出触顶 16 MiB 时出现）被客户端当**失败**处理（`[MCPR_EXEC_TRUNCATED]`）：
     截断输出**不得**作为完整数据返回给调用方，file-ops 的 `readFile` 一旦被截断却当完整文件，
     会静默污染 agentHome / 技能正文且难以回溯。未知末帧字段一律忽略（加性演进基线）。
   - 因此 8 个钩子的第一句现在是**按 transport 分派**（`classifyRemoteSessionTransport(...)
     === 'mcpr'` → 隧道实现；否则 SSH pool），不再有「先拒一次」的静态闸门，
     `MCPR_AGENT_UNSUPPORTED` 这个 IPC 码与它的 5 语言文案已随之删除（不再可达的键不留死键）。
   - **仍然保留（有意）**：`mode=pi` 不投影控制端的 in-process MCP bridge（agent-tunnel 只有
     正向字节流，没有 `-R` 反向转发；Claude 走的是 cc-mgr 自己的 capability MCP 回呼）。
     用户显式配置的外部 HTTP/Streamable HTTP MCP 仍直连可用；`getRemotePiAgentProxyEnv` 在
     `mcpr:` 上返回 `null`（没有反向转发，不注入代理 env），与 Claude 的 MCPR 分支同口径。
   - 回归测试：`apps/desktop/src/main/maker-host/__tests__/mcprPiTransport.test.ts`
     （行为级：8 个钩子在 `mcpr:` 上零次触碰 pool、各走隧道实现；**源码级不变量**：
     `index.ts` 里每个 `getRemoteSshPool().get(remoteHostId)` 所在钩子体内必须出现共享分类器）、
     `__tests__/piMcprRemote.test.ts`（接缝行为）、`__tests__/mcprExec.test.ts`（`mode=exec`
     的冻结帧形状）、`__tests__/mcprRemoteFileOps.test.ts`（Claude 侧同一缺口）。
   - `maker-ipc/register.ts` 的 `ensureRemoteReadyForSessionStart` 在 `mcpr:` 分支上对三个
     引擎一律早返回（安装 / daemon 预上传 / SSH pool 前置都不适用于这条 transport）。

   **仍未分类的存量旁路（本次有意未改，见交付说明）**：`handleCodexEnvironmentShutdownForRemote`
   （`index.ts` 约 `:646`）、`refreshRemoteCodexMcpAfterBridgeRecreate` 的 `getReadyHost`
   （约 `:711`）用 `hostId` 变量名查 pool，`listSshCodexProviders`（约 `:3061`）同理；
   三处都只在未命中时当作「host 未就绪」跳过或由调用方先分类，不产生误导性归因。

这条契约源自 2026-08-04 的回归：`4d1e01b7f` 合并 `origin/main` 时，第一父提交已有的
MCPRouter preflight 分支被上游版本覆盖，最终把 `mcpr:<id>` 送进 SSH pool，产生
`SSH_HOST_NOT_FOUND`。

2026-08-05 又发现一类独立回归：MCPRouter 返回的 `id` 与 `instanceId` 不同时，Codex
bridge 曾按后者查找，而 `remoteHostId` 按前者构造；同时实例规范化只把 `claude` 标成
supported，导致合法 Codex 实例在 bootstrap 阶段被误报为不可用。修复要求：`id` 是唯一
transport 身份，`agentType` 为 `claude` 或 `codex` 时才进入支持判断，UI/Main 的 Agent
选择与实例类型保持一致。

2026-08-25 实机再次发现合并回归：新建 MCPRouter Claude 任务后首次发送报
`LAZY_CREATE_FAILED: remote ssh host not ready: mcpr:<id>`。外围 preflight 已正确跳过 SSH，
但 maker-host 的 lazy create factory、`cc-manager-client` byte-stream 形态以及 Codex 配套接线
被同步结果覆盖，导致最终 transport 创建仍查询 SSH pool。修复按本节不变量恢复完整闭环，并以
`remoteCcQueryFactory`、Codex remote credential 与既有 routing 测试共同守住。

同次实机验证还区分了 transport 回归与上游瞬时失败：修复后两个 Codex 任务曾在同一约
24 秒窗口内同时收到 `/v1/responses` `stream disconnected before completion`，但随后使用同一
实例、同一 Gateway key、同一 Codex 0.145.0 Linux runtime，分别覆盖无 MCP、远端
`lizi_capabilities` MCP、dynamic tool 及生产 `Full access` thread/turn 配置的请求均完成。
因此这类错误不得重新归因为 `mcpr:` 被送入 SSH pool，也不得据此回退 capability routing；先用
同实例最小 app-server 请求复验，只有稳定复现后再按请求形状或 Gateway 链路继续定位。

## 4. 远端运行时版本门禁

- Claude 的 MCPRouter/SSH cc-mgr `protocol/hello` 必须携带
  `CC_MGR_BUNDLE_VERSION`。客户端可以兼容旧 daemon 不回显 bundle 字段，但不能省略请求
  参数；否则新版本 daemon 会返回 `[INVALID_PARAMS] bundleVersion is required (string)`。
- 当前 pin 是 bundle `0.0.10` / protocol `5`（`packages/maker-cc-manager/src/protocol.ts`
  的 `PROTOCOL_VERSION` 与 `CC_MGR_BUNDLE_VERSION`，包内 `protocol.test.ts` 硬断言这两个值）。
  daemon 按连接协商版本隔离能力：protocol `2` 保留 Claude query/session 与 host
  `toolGuards`；protocol `3` 才开放 immutable bundle、Codex revision/thread routing 和
  tunneled MCP；protocol `4` 增加 Full access 前的 subagent 模型能力预检；protocol `5`
  让 root-only `toolGuards` 接受原生 `AskUserQuestion` 工具名（旧 daemon 会把这个 guard
  当成非法 root-only 工具而拒，因此必须先升级 daemon 再下发）。manager version 相同但
  protocol 不同同样属于不可部署的 pin mismatch，MCPRouter 构建期和 tunnel 启动前都必须阻断。
  ⚠️ 每次上游同步后都要重新核对本节版本号与实际代码一致——2026-09 同步把 pin 从
  `0.0.9/protocol 4` 提升到 `0.0.10/protocol 5`，本节曾因此落后一版。
  （2026-09-23 第三轮同步复核：`packages/maker-cc-manager/src/protocol.ts:42` 仍为
  `PROTOCOL_VERSION = 5`、`:51` 仍为 `CC_MGR_BUNDLE_VERSION = '0.0.10'`，与本节一致，未改动。）
- protocol `4` 起的 immutable bundle 文件可二选一携带 UTF-8 `content` 或规范
  `contentBase64`；后者用于完整投递角色 Skill 的脚本、引用和二进制资产。daemon 必须先解码、
  校验规范 base64 与文件 SHA-256，再原子物化。Desktop 使用任务快照的 revision 和原始字节，
  不在远端重建 `SKILL.md`。
- MCPRouter 角色 Skill 启动先 `bundle/ensure`、再注册 revision，然后把返回的远端 plugin
  路径交给 Claude/Codex 原生加载；会话关闭、启动失败或 revision 替换时成对 release。
  恢复必须继续使用任务绑定的原 revision。空选择仍冻结任务绑定，但不投递空 bundle；普通
  SSH 没有这条投影契约，仅在快照实际含 Meka 角色 Skill 时明确失败，不能把正文退化为
  prompt。
- Codex capability routing 依赖 app-server `0.145.0` 引入的协议能力。远程
  `codex-appserver` tunnel 使用 MCPRouter 打包的 Codex 可执行文件；当远端版本低于
  `0.145.0` 时必须 fail closed 并提示升级 MCPRouter runtime，不得为了让会话启动而关闭
  capability routing。
- MCPRouter Codex 的凭证来源固定为 Cindy AI Gateway key。Desktop 只在 bridge spawn
  header 中注入该 key，绝不把本机 Codex OAuth 复制到远端；因此 maker-core 启动前的鉴权
  也必须由 Host 按 transport 显式解析为 `gateway-key`，不能使用本机 fallback OAuth 状态。
  即使本机 OAuth 因 `token_revoked` 进入恢复态，只要 Gateway key 有效，`mcpr:` Codex 仍应
  正常启动。SSH Codex 继续使用其隔离 `CODEX_HOME` 的既有 fallback 语义。凭证模式解析与
  transport 分类必须共同复用 `remote-session-routing.ts`，不得在 maker-core 解析 `mcpr:`
  前缀。

这条版本契约源自 2026-08-05 的两次现场错误：Claude 握手漏传 bundleVersion，以及
MCPRouter Worker 使用 `cindy/0.144.1` Codex runtime。

同日第三次现场错误暴露了 bundle 只校验 manager version 的漏洞：当时 MCPRouter 期待
`0.0.6/protocol 3`，实际镜像仍携带 Cindy 迁移初期的 `0.0.6/protocol 2`。因此不得只 bump
字符串版本；Cindy 的 `maker-cc-manager` 是 bundle 源码真源，MCPRouter 完整版必须通过
`build:cc-mgr-bundle` 重新构建并探测 pin；按需 runtime manifest/cache 链路校验 Codex
最低版本。部署后还必须重启 runtime。

2026-08-24 上游同步再次暴露跨仓发布漏项：Cindy 已升级到
`0.0.9/protocol 4`，MCPRouter 生产仍携带 `0.0.7/protocol 3`。当前 MCPRouter 在完整构建前
静态核对构建脚本、daemon 和 smoke 三处 pin，再探测从指定 `CINDY_SRC` 生成的真实 bundle；
因此只改 Cindy、只改某一处 MCPRouter 常量或复用旧构建产物都不能通过发布构建。

### 4.1 版本错配必须**可诊断**（2026-09-29）

**不变量**：`INVALID_BUNDLE_VERSION` 不得作为自由文本被拍平成 `LAZY_CREATE_FAILED`。
daemon 的原文是

```
[INVALID_BUNDLE_VERSION] client bundle 0.0.10 does not match server bundle 0.0.9
```

它既不说明哪边旧，也不给任何动作入口；用户（与运维）无法据此判断该升级客户端还是远端运行时。

落地形状：

- **线协议**（`packages/maker-shared/src/ccManagerRuntimeVersion.ts`，
  export `@cindy/maker-shared/cc-manager-runtime-version`）：
  marker `[REMOTE_CC_MGR_VERSION_MISMATCH]` + `client=<X> server=<Y>`。提供
  `projectCcMgrRuntimeVersionMismatch`（规约，**幂等**，认不出形状原样透传）、
  `isCcMgrRuntimeVersionMismatchError`（渲染层判定）、
  `readCcMgrRuntimeVersionMismatch` / `readProjectedCcMgrRuntimeVersions`（取版本）。
  版本号只接受 `[A-Za-z0-9][A-Za-z0-9._-]{0,31}`，避免把 daemon 的自由文本当版本渲染。
- **唯一规约点**：`maker-host/send-outcome.ts` 的 `createHostSendFailure` —— 所有 host-send
  失败（lazy create / rehydrate / send）都经过它，一处即可覆盖全部路径。
- **渲染层**：`components/chat/ErrorBanner.tsx` 命中 marker 时改用
  `chat.errorBanner.ccMgrVersionMismatch`（5 语言，带 `{{client}}` / `{{server}}` 插值），
  文案给出「哪边旧 + 用同一份 Cindy 源码重建并重启远端运行时」的行动指引。
- **回归测试**：`packages/maker-shared/src/__tests__/ccManagerRuntimeVersion.test.ts`
  （含现场原文、`LAZY_CREATE_FAILED:` 前缀包装、幂等、非法版本号不认、其它错误透传）、
  `maker-host/__tests__/send-outcome.test.ts` 的规约用例、
  `components/chat/__tests__/ErrorBannerCodexOAuth.test.tsx` 的横幅用例。

> 仍**未**解决的结构问题（见 MCPRouter 仓 `docs/cc-mgr-version-compatibility.md` 的 L2/L3）：
> `mcpr:` 路径下客户端无法把匹配的 daemon 送上去，且两侧仍以「精确相等」判定。本条只把
> 失败从「不可诊断」变成「可诊断 + 有动作」。
>
> **L2 已按 A+A 落地代码（2026-09-29）**：客户端在 cc-mgr 隧道上声明 `bundleVersion`
> （取自真实 pin，见 `maker-host/mcpr-tunnel.ts` 的 `buildMcprTunnelUrl`），MCPRouter 侧
> 解析并**显式转发**该参数（公开路由 + `proxyAgentTunnel` + runtime 路由 + `openAgentTunnel`），
> 由 `AgentBinaryCache.ensureCcMgr(version)` 从 CDN 按版本物化 bundle，
> `CcMgrDaemon` 在 bundle 变化时重启子进程；取不到时**回退镜像内那份**并告警，让下面的
> `INVALID_BUNDLE_VERSION` 成为唯一失败面。生产端见 `agent-runtime-release.md` 的
> 「cc-mgr bundle 的 CDN 段」。
>
> **仍未做**：把新 manifest/对象发布到 CDN、重建并部署 MCPRouter 镜像。因此**线上行为此刻
> 仍是「版本错配 = 会话不可用」**，只是失败可诊断 + 代码侧已具备按版本交付能力。
> 完整方案、落地顺序与部署阶段验证见 MCPRouter 仓 `docs/cc-mgr-cdn-delivery.md`。
