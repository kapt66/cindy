# MCPRouter 远程任务路由契约

> **状态**：权威开发规则（authoritative）
> **读取时机**：修改 Desktop 远程任务启动、恢复、SSH preflight、MCPRouter tunnel 或
> `remoteHostId` 处理时。

## 1. 三种远程身份

`remoteHostId` 不是统一的 SSH 主机名字段，而是**三种** transport 身份的联合
（第三种 `psb:` 的工程契约见 [PSB 远程会话传输](psb-remote-session-transport.md)）：

- `mcpr:<instance-id>`：MCPRouter 账号隧道的逻辑实例身份。这里的值必须是服务端实例记录的
  稳定 `id`（不是可变的显示/业务名称 `instanceId`）。`routerService.normalizeInstance()`
  用同一个 `id` 构造 `remoteHostId`，MCPRouter bridge 查询也必须按 `instance.id` 匹配；两处
  不得混用，否则实例列表明明存在仍会报 `MCPR_INSTANCE_NOT_READY`。分类器按
  `MCPR_REMOTE_HOST_PREFIX` 识别，具体实例值再由 `parseMcprRemoteHostId` 校验；它必须
  进入 `openMcprTunnel`、`remoteCcQueryFactory` 或 `createMcprCodexTransport`，不能查 SSH
  pool。即使值是不完整的 `mcpr:`，也不能降级成 SSH host。
- `psb:<PSB session-id>`：PSB 远程工作区会话身份（会话跑在 PSB 远端客户端机器的工作区里，
  Cindy 只是客户端）。同样是**隧道逻辑身份**：必须进入 `openPsbAgentTunnel`
  （`maker-host/remote-tunnel-dispatch.ts` 的 `psb` 分支），不得进入 SSH pool；分类器按
  `PSB_REMOTE_HOST_PREFIX` 识别，畸形 `psb:` 同样不回落 SSH。它与 `mcpr:` 共用**同一份**
  agent-tunnel 帧契约与「不是 SSH 主机」这条边界，差别只在地址与鉴权（Bearer Connection JWT）。
- 其它非空值：SSH Remote 的 host id，才允许进入 `ensureRemoteHostReady`、
  `ensureRemoteAgentInstalledOrInstall`、`getRemoteSshPool().get` 以及 SSH MCP bridge
  的注入/恢复逻辑。

`classifyRemoteSessionTransport` 是唯一分类入口；新增远程 transport 时必须同时扩主进程分类器与
渲染层镜像判据（`renderer/lib/remoteCodexModelHost.ts`），两者的输入矩阵测试断言逐字一致。
「有 `remoteHostId`」只等于「这是远端会话」，不等于「这是 SSH 主机」。

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
把 `remoteHostId` 传给 SSH API。**「cwd 归远端宿主」也由同一模块派生**：
`remoteSessionHostOwnsCwd(remoteHostId)`（目前只有 `psb:` 为真）是 cwd 所有权的唯一判据，
desktop 在 maker-core 的 `lifecycleHooks.prepareStartOptions` 里用它给所有 `createSession`
入口打 `remoteHostOwnsCwd`（不在各 funnel / 钩子里手写前缀判断；`pi-mcpr-remote.ts` 也走它）。
Codex 侧对 cwd / roots / sandboxPolicy 的消费见
[PSB 远程会话传输](psb-remote-session-transport.md) §2。

### 2.1 远程 transport 必须随会话退休一起释放（2026-10-30）

每条远程会话都由 `remoteCcQueryFactory` 打开自己的 transport（SSH exec 通道或 MCPRouter
WebSocket），并通过 `remoteTransportRegistry` 登记 `{sessionId, remoteHostId, dispose}`。
释放走**单一入口** `releaseRemoteTransport(sessionId, reason)`：agent 的 `close`、会话
`onClose` 生命周期钩子、Orca worker 归档三条退休路径都调它，天然幂等（entry 先摘除再
dispose）。

**为什么必须登记而不是只依赖 agent close**：worker 完成一轮后可能先离开 Maker 的
`activeSessions`，再被 `archive_worker` 关闭；此时 `maker.closeSession` 是 no-op，agent 的
`close()` 也不会再跑，transport 就永远留着。MCPRouter runtime 的 `activeTurnCount` 因此
停在 1，实例上所有 commit/push/`git_submit` 都被 `blocked / session-open` 挡住，只有重启
整个客户端才会归零。

**实机复现与验证（2026-10-30）**：测试实例上 `activeTurnCount` 0 → 创建 claude-code 远程
worker → 归档 → 读数 **1**，12 小时后仍为 1，重启客户端才归 0。修复后同一复现路径要求
归档读数为 **0**；`remoteTransportRegistry.test.ts` 覆盖单次释放、重复释放、dispose 抛错
与同 id 替换四种情形。

**第二条长连接：Codex capability 控制通道（2026-11-26 审查补）**：隧道 Codex 会话除了数据面
transport，还有一条 `mode=cc-mgr` 控制通道（`main/maker-host/mcpr-codex-capability.ts`，按完整
`remoteHostId` 缓存）。它只在**流自己 close** 时清缓存；PSB 的会话停止 / 重绑不会替我们关它。
PSB 分支因此在 data-plane transport 终态时调 `releaseTunnelCodexControlChannel(remoteHostId)`
（`end()` + 清缓存，幂等，`McprCodexTransportOptions.onClosed` 接线）；回归见
`mcprCodexCapability.test.ts`。MCPRouter 分支仍由 `bundleRelease` / 流 close 收口，不额外改。

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
   **2026-11-23 补记（渲染层第三处漏点：新建任务草稿）**：2026-11-02 新增的「SSH 草稿 Codex
   目录」在 `NewMakerDraftRoute` 里**又手写了一遍**「有 `effectiveRemoteHostId` 就当 SSH 主机」，
   于是 MCPRouter 远程项目草稿一打开模型选择器就命中同一条探针：主进程第二道保险抛
   `INVALID_PARAMS`（同一台机器实测 9 次），`useSshCodexProviders` 把任何 reject 折叠成
   `status:'error'`，选择器顶部弹出「无法读取远程设备上的模型。请检查连接后重试。」——
   **远端请求从未发出，是假告警**；同类实例为 codex 类型时后果更重：空远端清单经
   `mergeSshCodexCatalog` 会剥掉本机目录里的 codex 型号，并把草稿首选项钉成
   `providerId:'openai'`。修复按三层落地，缺一层都会重演：
   - **判据只留一处**：`renderer/lib/remoteCodexModelHost.ts` 新增品牌类型 `SshRemoteHostId` +
     `asSshRemoteHostId()`，并把两个入口判据都收在这里：`resolveRemoteCodexModelHostId`
     （Codex 探针）、`resolveSshCodexCatalogHostId`（草稿 SSH 目录，2026-11-23 新增）。
   - **类型层封口**：`useSshCodexProviders` 只接受 `SshRemoteHostId`。新增或合并进来的调用点
     若仍传裸 `remoteHostId`（`string`），`pnpm --filter desktop run typecheck` 直接失败，
     不必等实机复现；`ChatInput` 与草稿页已按判据取值。
   - **运行时保险**：钩子内部再用同一判据复核一次 —— 非 SSH 身份**零次 IPC**，返回空 `ready`
     而不是 `error`（进入 error 态就会再次被渲染成「连接失败，重试」）。
   - **合并防回归**：guard tier 新增
     `renderer/__tests__/remoteTransportProbeWiring.guard.test.ts`（CI 的 `pnpm test:guard`），
     静态断言上述接线；`remoteCodexModelHost.test.ts` 的输入矩阵继续断言渲染层与主进程分类器
     逐字一致。语义验收登记在 `meka-whitelist-verification.md` 的 WL-29。
   **同日补记（同一判据的第二个后果：MCPR 下 Codex 型号整组消失）**：`ChatInput` 先用裸
   `sshHostId` 给选择器挂了一个 `{providers:[], status:'idle'}` 的「待到远端读取」目录。SSH 主机
   这是对的（远端清单到了再替换），但 `mcpr:` 的清单永远到不了，于是
   `mergeSshCodexCatalog(本机目录, [])` 把本机目录里所有 `codex` 型号、以及只有 codex 的来源
   全部当成「远端没有」剥掉 —— 用户看到的就是「用 MCPR 时 Codex 相关模型一个都不显示」。
   修复口径与上面同一条：目录**是否存在**也由唯一判据决定（`resolveSshCodexCatalogHostId`），
   不是由「有没有 remoteHostId」决定；`ChatInput` 的 `sshCodexCatalog` 与
   `sshCatalogProviders` 都以它为门，非 SSH 目标（本地 / device-link / mcpr）完全不挂该目录，
   直接使用本机目录。行为级回归在 `chatInputModelLoading.test.tsx` 的 mcpr 用例（断言选择器
   拿不到 `sshCodex` 目录）与 `remoteTransportProbeWiring.guard.test.ts`（禁止退回裸
   `sshHostId` 判断）。
   **仍有意保留的边界**：MCPRouter 是 gateway-key only，`excludeSubscriptionDirect` /
   `excludeChatBridgedCodex` / `filterChatBridgedCodexProviders(..., !!remoteHostId)` 对 mcpr
   保持 true —— 订阅直连（`chatgpt/` 等）与仅本机可桥接的来源在那条路由上本就发不出去，
   它们不显示不是上面的 bug，而是这条路由能力边界。
   **同日补记（渲染层第四处：错误横幅的「同步 Codex 登录」）**：`ErrorBanner` 同样用裸
   `remoteHostId` 判断「远端 Codex 缺登录态」，于是 MCPR 会话的 Codex 401 会显示「同步登录态」
   按钮；点下去把 `mcpr:` 传进 `remoteSsh.checkCodexAuth` / `syncCodexAuth`，主进程
   `requireConnectedHost` 抛 `SSH_HOST_NOT_FOUND: unknown host: mcpr:…`，用户被指向一个不存在的
   SSH 主机。修复口径同前：SSH 专属动作先用 `asSshRemoteHostId(remoteHostId)` 取品牌 host，
   `mcpr:` 不显示该按钮、保留普通 Retry（网关侧重试是有效路径），真 SSH host 行为不变；
   `remoteTransportProbeWiring.guard.test.ts` 同时禁止这两个 IPC 再收裸 `remoteHostId`。
   **本轮的渲染层结论**：`remoteHostId` 一律先过 `lib/remoteCodexModelHost.ts` 的判据再进
   SSH-only 分支；「有 remoteHostId」只等于「这是远端会话」，不等于「这是 SSH 主机」。
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

   **2026-10-30 补记：Orca `create_worker` 的 `mcpr:` 目标也按同口径放开了 Pi。**
   `maker-ipc/mekaWorkerTarget.ts` 里原本对 `requestedRemoteHostId` +
   `agent !== 'claude-code' && agent !== 'codex'` 直接返
   `INVALID_PARAMS: MCPRouter Workers support Claude Code and Codex only`。那是
   `35c8f12355` 逐引擎放开 Claude→Codex 时的历史残留（同一次提交只把 codex 加进白名单，
   没有判据注释），与「Pi 会话能不能跑在 `mcpr:` 上」无关 —— 后者已由 `mode=pi` / `mode=exec`
   实现并测试。现在白名单是 `MCPR_WORKER_AGENTS = { claude-code, codex, pi }`，其余判定
   （稳定 `id`、项目绑定、`supported/available`、workdir 由实例记录决定）一字未改。
   已知能力差异仍是第 8 条「有意不投影」的直接后果：Pi 远端 Worker 没有
   `orca_worker_bridge`，手动 `send_to_lead` 不可用，回报走 auto-bridge。SAGA2 战斗服务器
   只读核查链（`resolveUniqueBoundMekaServerTarget`）不放开 Pi，那是有意的产品裁决。

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
- 当前 pin 是 bundle `0.0.12` / protocol `5`（`packages/maker-cc-manager/src/protocol.ts`
  的 `PROTOCOL_VERSION` 与 `CC_MGR_BUNDLE_VERSION`，包内 `protocol.test.ts` 硬断言这两个值）。
  daemon 按连接协商版本隔离能力：protocol `2` 保留 Claude query/session 与 host
  `toolGuards`；protocol `3` 才开放 immutable bundle、Codex revision/thread routing 和
  tunneled MCP；protocol `4` 增加 Full access 前的 subagent 模型能力预检；protocol `5`
  让 root-only `toolGuards` 接受原生 `AskUserQuestion` 工具名（旧 daemon 会把这个 guard
  当成非法 root-only 工具而拒，因此必须先升级 daemon 再下发）。manager version 相同但
  protocol 不同同样属于不可部署的 pin mismatch，MCPRouter 构建期和 tunnel 启动前都必须阻断。
  ⚠️ 每次上游同步后都要重新核对本节版本号与实际代码一致——2026-09 同步把 pin 从
  `0.0.9/protocol 4` 提升到 `0.0.10/protocol 5`，本节曾因此落后一版。
  （2026-11-19：SDK 0.3 边界合并改变产物字节后 pin 升到 `0.0.12`；发布侧遇到
  「同路径内容不同，拒绝覆盖」时先确认产物确实变了再 bump，不要放宽不可覆盖约束。）
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
