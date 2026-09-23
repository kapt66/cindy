# PI harness 集成规则与上线清单

> 修改 `packages/maker-core/src/agents/pi/**`、`apps/desktop/src/main/maker-host/pi-host.ts`、
> `apps/desktop/src/main/mcp-integrations/piEnvironment.ts`,或任何 PI 会话行为、权限、
> 配置、system prompt 之前必读本文件。PI(github.com/earendil-works/pi)被定位为 Cindy
> 未来的基座 harness,集成原则与其余 harness 有别 —— 详见「设计原则」。

## 1. 架构总览

Cindy 以 `pi --mode rpc` spawn pi 二进制(JSONL/stdio),`translator.ts` 把 pi 事件映射进
统一 `AgentEvent`。关键装配点:

- **provider/model**:`index.ts writeModelsJson` 把 host 注入的模型清单挂在单一自建
  provider `cindy` 下,写进 `<agentHome>/models.json`。`baseUrl = runtimeConfig.endpoint`
  —— desktop 侧是本地 anthropic-compat proxy(loopback);proxy 未起时 fail-open 直连真上游
  (`anthropic-compat-proxy-host.ts`)。凭证走 `$CINDY_PI_API_KEY` env 插值,不落盘。
- **system prompt**:`--append-system-prompt` 追加 host 产品段 + 用户段,**保留 pi 默认
  prompt**(不用 `--system-prompt` 整体替换 —— 那会丢掉 pi 自己调好的工具用法/工程约定)。
- **权限执行**:pi 原生无工具审批(security.md 明确:非沙箱、不限制工具)。Cindy 用注入的
  `cindy-bridge.ts` 扩展在 pi 进程内 `pi.on('tool_call')` 拦截,经 `extension_ui_request`
  子协议冒泡到 `index.ts handleExtensionUiRequest`,映射成 `InteractionRequest` 交 Cindy
  审批 UI。档位写 `<agentHome>/runtime/perm-<sessionId>.json`,bridge 每次 tool_call 现读
  (热切换)。
- **Full access(`bypassPermissions`)契约(务必如实理解,勿夸大)**:该档与原生 Pi 对齐,
  **不得**用凭证路径 / `/proc/*/environ` 文本硬拦拒绝原生允许的读、搜、bash。Ask/Auto
  仍把这类调用升级为审批;Full access 选择即接受父进程环境里的代理 token / 网关 key /
  BYOM key / 外部 MCP header **可能被读取**。允许保留的机械隔离仅限 Cindy 自身运行所必需:
  模型写 agent home(`models.json` / 权限档 / subagent 快照)必须强制用户确认,即使
  Full Access 也不得静默放行或静默拒绝。Extra Dirs 的结构化写跟随会话权限:本地
  Full Access 放行,Auto 交审阅,Ask 确认,禁止再在 bridge 里悄悄硬断。
  bash 写入 Extra Dirs 仍非 OS 强制。真正的强隔离需要 OS 级手段(macOS `sandbox-exec`、
  Linux 只读 bind mount / seccomp),**本阶段未接入**。需要硬边界时用 ask/auto 档,或等 OS
  沙箱落地。改动权限相关代码时不要再堆「看起来能拦」的正则并当成安全边界。
  与 Claude Code／Codex 一致，Pi 会话的 Full Access 也会让插件 `ghost_call` 的
  `attachments`／`dir`／`save_dir`，以及 Forge 在工作目录外的 scaffold／pack／install
  在 Host 侧免去额外确认；实现必须现读活跃 Session
  的稳定状态并同时匹配其 runtime instance identity；权限切换或关闭在途、远程／缺会话／
  实例不匹配／查询失败均 fail closed。工作区草稿、工作目录写入和媒体路径揭示等操作审批
  同样沿用会话权限；MCP 逐次审批标记不得覆盖 Full Access。Host 已按当前档位放行后，
  不得再因「不在会话工作目录内」悄悄硬断，把 Agent 晾在空转里。  cindy-docs 与电脑截图 /
  录制路径同样走这条会话权限，不得在工具层再静默 PATH_NOT_ALLOWED。  授权卡片与后续
  I/O 绑定已解析的规范路径，工作目录里的 symlink 不能把越界目标藏成相对路径。电脑
  驱动契约只丢掉 Cindy 后加的兼容字段（目前是 `delivery_mode`），其它未知参数仍拒。Setup、OAuth、Secret 的信息
  输入与安装／更新策略保持原边界。instance 仅作为 opaque query 写入 Host 生成的 Pi MCP URL；桥接
  注册表不匹配时返回 401。旧 URL 缺 instance 时可兼容普通会话工具，但必须向工具隐藏
  instance，使 Full Access 自动交接保持 fail closed。
  会话审批及切档回归见 [pi-auto-review-dispatch.test.ts](../../packages/maker-core/src/agents/pi/__tests__/pi-auto-review-dispatch.test.ts)。
- **MCP 桥**:`piEnvironment.ts` 把 in-process MCP providers 暴露成 localhost streamable-HTTP，
  并把用户显式配置的外部 HTTP / Streamable HTTP MCP 作为 direct remote server 装入；旧式
  SSE transport 不在此链支持（但 Streamable HTTP 的 SSE response framing 受支持）。外部 URL
  要求 HTTPS，只有明确 loopback endpoint 可用 HTTP；认证 header
  真值仅经 Pi 父进程专用 env 传递，`CINDY_PI_MCP_BRIDGE` 只存 env 引用；这些 env 与描述符
  都会在 bash spawn 边界剥离。bridge 并行执行外部 server 启动探测，每个 server 的
  `initialize + tools/list` 总预算为 10s（低于 Pi RPC 30s ready 门槛）；探测完成后实际工具
  调用保留 600s 长预算。SSE response 按 event 增量消费，不等待 server 关闭持续流。Pi 模型侧
  始终只注册 `cindy_mcp_list_tools` 与 `cindy_mcp_call_tool` 两个稳定网关 schema；完整工具目录与
  input schema 留在 bridge 内部。先发现名称／描述，再按具体 server + tool 取单个 schema，
  未检查 schema 的调用在 bridge 内 fail closed，不会触达 MCP 或弹权限框。该错误本身附带目标工具的
  input schema（复用 `schemaHint`，超 16,000 字符按既有策略截断），模型不必再单独取一次即可带正确
  参数重试（Host **不**代为重放，纠正是模型自己发起的下一次工具调用）。**披露门只认精确
  `(server, tool)` 对**：只传 server、缺 tool、传空 tool 名、传错 tool 名四种形状都不记披露、不执行、
  不弹权限框；同 server 的**另一个** tool 仍须重新检视（部分披露不放行）。
  `cindy_mcp_list_tools` 先判定 server 再现查 tool；**「是否已连接」按三集合并集判定**（连接路径登记的
  server 名 ∪ 已注册但不可用的 server 名 ∪ 工具表），因此「连上了但当前 0 个工具」的 server **不是**
  未知 server——把它答成 `UNKNOWN_SERVER` 并附插件课是一条事实错误。三条口径分开：① **从未连接**的
  server（含把插件 id 当 server 的两种写法）⇒ `UNKNOWN_SERVER` + `availableServers`，`reason` 明说
  插件（ghost）不是 MCP server、只能经 `{server:"cindy", tool:"ghost_call"}` 调用，插件 id 用
  `ghost_list` 发现；② **已登记但当前不可用**的 server ⇒ 有界文案说明「已注册但不可用 + 原因」，
  **不贴**与该事实无关的插件课；③ **Bot memory facade 打开**时 `cindy_memory` 的工具会从网关目录里
  摘掉，但它是已连接 server：`list` 带 `tool` 与不带 `tool` 两种形状都给出同一条准确 `reason`
  （工具在原生 `bot_memory` 上），且答案有界、不含 `inputSchema`、不倒工具目录。
  **验证现状（2026-09-22）**：`packages/maker-core` 无 `typecheck` script，用
  `npx tsc --noEmit -p packages/maker-core/tsconfig.json`（exit 0）；`cindyBridgeSource` +
  `pi-mcp-client` 58 passed / 4 skipped，`pi-mcp-bridge.integration.test.ts`（真 pi 二进制）15 passed。
  上述三条口径与披露门四形状均有反向还原的红→绿证据（还原后同批 4 failed / 54 passed）。
  Host 审批、策略与变更捕获仍使用真实
  `mcp__<server>__<tool>` identity 和真实参数，不能退化成对网关包装器授权。Claude Code 与
  Codex 保持各自的直接 MCP 注册方式，不经过此 Pi 专属网关。配置新增、修改、禁用或删除对
  下一新建/重启会话生效；旧活动会话保留启动时 generation 快照至 close。
  展示层通过共享 `parseMessageToolUse` 将网关调用还原为既有 MCP 工具名与参数；实时事件、
  Pi 分支历史和旧持久化消息共用此解析，保留 toolUseId，不改变 Pi 原生 transcript 或授权路径。
  MCP 请求接入 Pi 的取消信号；Bun fetch 的独立空闲计时关闭，由既有请求期限统一约束响应头与
  正文。取消只中止本次 HTTP 等待，不承诺撤销服务端已执行的动作。网络错误只附白名单错误码，
  仅 JSON-RPC `-32602` 明确参数错误附 schema，工具业务错误保留原反馈。
- **plan 模式**:挂 pi 自带 plan-mode 扩展,`/plan` toggle 驱动;Cindy 维护镜像态并在 resume
  时从本机 session JSONL 校正（只打开启动时 `--session-dir` 真身内的普通文件，
  并有字节/时间预算，超限回退 RPC）；远端仍走 `get_entries`。

## 2. 配置面:Cindy 显式设置 vs 放任 pi 默认

Cindy 显式设置:models.json、`settings.json` 的 `transport:sse` 与 `retry.maxRetries=6`
（`retry.provider.maxRetries` 保持 0）、`--append-system-prompt`、`--session-dir`、启动时 RPC
`set_auto_compaction{enabled:true}` / `set_thinking_level`。Pi 原生负责 threshold 与 overflow 压缩；
Cindy 消费 compaction 事件做 UI、usage、digest 投影，并只在本机原生自动压缩确定性失败后锁存
下一次发送前换窗。设置页的 Pi 百分比默认 90%（已有显式 override 保留），在每次启动或恢复
Pi 任务时冻结，并写入该任务 `settings.json` 的 `compaction.reserveTokens`
（`capacity - budget * pct/100`）；切模只按这份百分比快照重算，不回读最新全局值。
模型容量用于 Pi 原生请求长度裁剪，不能随小预算缩到 1K；工作预算只调整原生压缩阈值，
并作为已应用预算进入 Cindy 的用量快照。
大窗切小窗先由 Desktop 的统一目标窗口事务按目标窗口 90% 固定压力线评估（独立于 Pi
日常自动压缩百分比），命中时换干净原生窗口；未命中时 Pi 重写 settings 后调用
`switch_session`，必须重新 `set_model` 并用 `get_state` 校验
provider／model／contextWindow，因为 Pi 会用进程初始 CLI route 重建 runtime。校验完成前
子代理 route 保持 pending，失败则终止该 live 任务。Claude Code 仍用独立百分比。env:`CINDY_PI_API_KEY`、
`CINDY_PI_SESSION_ID`、`PI_CODING_AGENT_DIR`、`CINDY_PI_PERMISSION_FILE`、`CINDY_PI_MCP_BRIDGE`、
外部 MCP 专用动态 env、`PI_OFFLINE=1`(关启动期联网)、`NO_PROXY` 兜底 loopback(防全局代理
打穿本地 proxy 与 MCP bridge)。

Pi 同样消费 `AgentRuntimeConfig.behaviorFlags`（静态对象或按来源、凭证形态、执行位置求值）。
Desktop 复用既有工具链并行度设置，向本机 Pi 注入 `VITEST_MAX_FORKS`、`VITEST_MAX_THREADS`、
`CARGO_BUILD_JOBS` 与非 Windows 的 `MAKEFLAGS`；用户已有 env 优先，关闭设置后新进程不注入，
SSH 不套用本机限核值。沿用现有默认值与 override 存储，不新增 PI 专属开关。

放任 pi 默认(未写 settings.json):`httpIdleTimeoutMs=300000`、`websocketConnectTimeoutMs`、
`compaction.keepRecentTokens`、`defaultProjectTrust`。Cindy 会在每次 startSession 覆写
`transport`、`retry.maxRetries=6`（provider 级保持 0）与 `compaction.reserveTokens`；
未配置 Pi 百分比且未缩小工作预算时不写 `reserveTokens`，沿用 Pi 默认 16384；
显式小预算仍以默认 90% 计算触发阈值。


Skill 停用适配同时保存物理身份与管理页已扫描的词法发现入口；启动前只采用仍指向该
物理身份的入口，直接加入 Pi 排除配置，不依赖重新遍历宽目录。旧偏好没有发现入口时
仍保留物理路径，并尽力解析发现目录中的符号链接别名；该额外扫描
共享 2048 个条目、16 层深度和 100ms 的遍历预算，先检查各发现根的直接入口，再逐层
进入子目录，避免无关子树抢先耗尽预算；目录流逐项读取并在退出时关闭。
启动时将额外发现的别名绑定到冻结的物理身份。会话内模型目录刷新、模型切换及上下文
窗口重新校准都传递这份映射和原生包配置；写 settings 前剔除改指向路径，不从旧 JSON
中的负路径重新推导物理身份。
预算耗尽后保留已解析路径，不继续扫描；原生 Pi 仍负责资源加载，不能因 Cindy 的扫描
截断而拒绝加载其它资源。时间预算在文件系统调用之间检查，不是对单次系统调用的超时。

### 全局约定入口

普通 Pi 任务从执行设备用户的 `~/.pi/agent` 继承约定，按 Pi 原生顺序选择首个文件：
`AGENTS.override.md` → `AGENTS.md` → `AGENTS.MD` → `CLAUDE.md` → `CLAUDE.MD`。
本机尊重启动 Cindy 时的 `PI_CODING_AGENT_DIR`
覆写（支持 `~`）。SSH 使用远端 `$HOME/.pi/agent`，不读取控制端个人文件；手机／设备互联
控制本机任务复用桌面链路。Bot 保持 `--no-context-files`，不读取或复制这些全局约定。

每次启动读取软链目标并复制内容到独立 `configHome`，不建立指向用户文件的可写链接。
用户更新约定后，新启动的任务读取新版；运行中的任务保留启动快照。SSH 的配置目录身份
包含约定内容哈希，内容不变可以 attach，变化或删除不能覆盖仍存活的旧运行时快照。
只继承上述约定文件，不整目录复制 settings、auth、extensions，也不复制会替换 Pi 默认
系统提示词的 `SYSTEM.md`。远端沿用文件读取通道的 4 MiB 上限，触及上限明确报错，不能
静默截断。文件不存在允许正常启动，读取／写入失败须报错，不能假称约定已加载。
远端探测使用系统 `stat`（GNU／BSD，固定 C locale）区分明确缺失与权限／探测失败，
不能用 shell `-f`／`-e` 的 false 推断文件不存在，也不能依赖首次启动尚未安装的 Node。
内建 Pi 子代理从父任务 `configHome` 复制选中的约定快照到自己的持久运行目录；
不重读用户原文件，父任务卸载后子代理仍保留同一份约定。

## 3. 设计原则(Chris 2026-07-30 裁决)

- PI 是 Cindy 未来的基座 harness。
- **桥接/模型接入必须充分利用 pi 自身兼容层**(models.json 四种 api 形态 + per-model compat
  开关),**禁止「先转成 Claude 格式再转 pi 兼容」的双重转义**。BYOM 用户自定义/本地模型直接
  写 models.json 走 pi 原生 provider,不过 anthropic-compat 代理。

### 3.1 Pi 上游 GUI 非退化红线（Chris 2026-08-19 裁决）

Cindy 是 Pi 的上游 GUI，不是 Pi 的二次安全产品。Cindy 的 Pi 集成验收基线首先是：**不得让
同版本 Pi 原本能完成的事情，因为 Cindy 控制层新增的判断而失败、停用或无法由 Agent 恢复。**

1. **原生成功是成功真源**：`pi install/update/remove` 的退出结果是包 mutation 的成功真源。
   命令成功后，Cindy 的检查器、指纹器、快照器、兼容解析器或 UI 投影失败，不得把它改判成
   安装失败，不得回滚或自动停用。宿主自己的分析失败只能显示为 Cindy 诊断不可用。
2. **兼容检查永不阻断**：TUI API、RPC、静态语法、runtime range、未知资源及未来 Pi 格式的
   检查只用于详情提示。`partial`、`unsupported`、`unknown`、超时和解析异常都不能影响安装、
   更新、启用或运行；Pi 能加载就交给 Pi 加载，运行错误再按 Pi 原始错误呈现。
3. **显式操作零附加审批**：用户直接发送完整确定性的 Pi 包命令，或在设置页点击明确的
   安装／更新／启用／停用／移除，即完成对应授权，不得再弹宿主确认。Agent 自主发起的工具
   调用可以沿用通用工具批准，但批准后不得再加第二层包审批。
4. **宿主不确定时退回 Pi**：Cindy 无法识别 manifest、filter、symlink、构建产物、资源类型或
   新版包格式时，必须优先使用 Pi 原生包发现／加载路径；禁止因 Cindy 未覆盖全部情况而
   fail closed。Cindy 可以隔离自己的内部桥接文件，但不能据此隔离用户明确安装的 Pi 包。
5. **Agent 必须有恢复路径**：失败回执至少区分 Pi 原生命令失败与 Cindy 辅助分析失败；前者
   提供脱敏、可行动的错误类别，后者不得阻断。不得把原始可修复错误吞成只有“操作失败”的
   死路，也不得禁止 Agent 在用户授权后换 source/version、补构建或重试。
6. **对等测试是硬门**：包管理改动必须覆盖“Pi 原生命令成功 + Cindy 分析失败／超时／未知格式”
   仍安装并加载，以及失败后 Agent 可继续重试。任何以“安全增强”为理由接受 Cindy Pi 低于
   原生 Pi 能力的测试预期都应删除或改写。

允许保留的边界仅限 Cindy 自身运行所必需、且不改变 Pi 用户包结果的机械隔离（例如不把远端
会话指向控制端本地路径、保护 Cindy 内部凭证不被写入包目录）。这类边界也不能被描述成
Cindy 对 Pi 的产品安全升级，更不能拿来扩大阻断范围。

Full access 读/搜/bash 与原生对齐的需求正本见 [`pi-full-access-native-parity.md`](pi-full-access-native-parity.md)。

Pi CLI 管理入口、内核自更新与旧工具兼容的执行边界见
[`pi-managed-commands.md`](pi-managed-commands.md)。

扩展 UI 能力清单、RPC 静默过滤与设置兼容提示的统一合同见
[`pi-extension-ui.md`](pi-extension-ui.md)。

## 4. 维护不变量(改动时不得破坏)

1. **权限档从严到宽**:`capabilities.permissionModes` 必须 `[ask, auto, bypassPermissions]`
   顺序,`[0]` 是最严档 —— 无人值守链路(`hook-control/defaults.ts`)在「显式档不被支持」时
   回落 `[0]`,顺序错了会把更严选择静默放宽成完全访问。由 `pi-capabilities.test.ts` 守。
2. **凭证路径判定三处同步**:`shared/auto-review.ts CREDENTIAL_PATH_PATTERNS`、
   `cindy-bridge-source.ts touchesCredentialPath`、`auto-review-policy.ts` 只读分支全字段扫描
   必须同口径。bridge 自包含不能 import,改一处记得改三处。
3. **斜杠命令转义**:`escapeLeadingSlashCommand` 对 `/` 开头用户输入前置空格转字面。仅放行
   `/skill:`、本次 `get_commands` 证明 provenance 落在 Cindy-managed package 根内的命令，以及
   本次显式传入的项目 Skill/prompt/extension 路径所证明的命令。`/` 面板用同一套
   `authorizedSlashCommandNames`，不单看 managed package。其余扩展命令(如 `/plan`)
   转义成字面，避免 Cindy 状态镜像脱同步，也堵住未装配来源的命令攻击面。
4. **auto 档 dispatcher fail-closed**:分类抛错 / 无 resolver 一律不放行。
5. **成本计量**:models.json 的 cost 来自 host 模型目录(`ModelDescriptor.cost`),缺省按 0;
   派生链 `catalog-to-descriptors.ts` → `capabilities.availableModels` → `writeModelsJson`。
6. **权限弹窗正文**:`PermissionPrompt.formatToolInput` 必须 harness 无关(pi 小写工具名 +
   path/command 字段,CC 大写 + file_path),由 `formatToolInput.test.ts` 守。
7. **统一会话树真相**:Cindy `parentSessionId` 是外层独立会话分叉;Pi JSONL entry tree 是当前
   Pi 会话内分支。Pi 导航后必须通过 `session.treeRehydrate` 原子替换 SQLite 可见投影,旧行仅
   soft-hide;切换只改对话上下文,不得声称或尝试回滚工作区文件。
8. **项目资源显式装配**:root、只读 subagent 与离线 fork 启动 Pi 时都必须显式传
   `--no-approve`;没有 Cindy-managed 本机用户包根时同时传 `--no-extensions`。本机普通 runtime
   存在明确安装且未停用的用户包根时，为保留 Pi 原生 package discovery 可以只省略
   `--no-extensions`：包根只能来自 Main 生成的 runtime `settings.json`，`--no-approve` 仍禁止
   读取项目 `.pi/settings.json` 与自动安装项目 packages，不得因此传 `--approve`。
   本地非 Review、非 Bot、非 SSH 的 root 任务用重复 `--skill` / `--prompt-template` /
   `--extension` 把仓库原路径交给 Pi：`.pi/skills` 与 cwd→git root 内 `.agents/skills`
   的目录型 Skill、`.pi/prompts/*.md`、`.pi/extensions/*.ts` 与 `*/index.ts`。越界 symlink
   不传入。root 仍回装 Cindy 自有 bridge/subagent 与 pinned plan-mode。Review、Bot、子代理、
   离线 `forkSdkSession` 克隆进程与远端会话不带这些项目资源。随后以 `resumeSessionId`
   恢复的本地根任务（含 fork 之后的恢复）与普通本地任务相同，加载项目资源。
   不得读取/复制项目 `.pi/settings.json`，不得传 `--approve`，
   不得依赖 `PI_OFFLINE=1` 代替该 settings 硬门。root 不传 `--no-skills`，以保留现有
   user/global skill 行为；项目 skill 的 `loaded` 由当前会话 `get_commands` 对原路径 provenance
   证明。
   **宿主冻结的技能快照（2026-09-22 起）**：本地 root 任务还会额外收到宿主为**该会话**冻结的技能
   快照根——`opts.nativeSkillPluginPath` 的 `<path>/skills/<id>` 逐个作为显式 `--skill` 传入
   （`packages/maker-core/src/agents/pi/host-skill-mount.ts:69`，注入点在
   `packages/maker-core/src/agents/pi/index.ts:3764`），排列在**项目 Skill 之前**，与
   「自己的 → 用户的 → 项目的」优先级一致。同一条 `--skill` 通道，**没有**第二套加载机制、
   不复制快照、不新增审批面。只挂直接含 `SKILL.md` / `skill.md` 的真实目录（隐藏项与 symlink
   跳过）；**远端会话（`remoteHostId`）与 review 会话不挂**（不把本地路径透传给远端 harness）；
   根不可用或一个可挂 Skill 都没有时降级为**不带** `--skill` 启动并 `logger.warn` 留痕，不抛错。
   新增的是**路径**不是正文，不变量 12 的 argv 预算与判据不变。
9. **Pi bash bounded timeout**:Cindy 覆盖的模型可调 `bash` 在 execute 入口强制默认
   `300s`、上限 `1800s`。缺省或非正数用默认;大于上限或非有限数字 fail-fast(参数错误,
   不是 `Command timed out`);合法秒数原样交给 Pi 原生执行器。不另起 timer / AbortController。
   覆盖范围是 Cindy 当前可达的模型 bash 路径(本地新进程、SSH 新进程、ask/auto/Full access)。
   Pi RPC `{type:'bash'}` 与 MCP 工具不在此契约内。tool schema / description 必须与上述语义一致。
10. **Pi 会话 spawn env 稳定性(轮 41,2026-08-12)**:同一 `sessionId` 的重建(断链重连 /
   恢复 / 重启挂回)spawn env 必须**逐字节稳定**(除显式换代)。远端 daemon 的
   `pi/ensure` 以 envHash 全量对比判定条件 restart——**任何 per-call 随机值
   (`randomBytes` / 时间戳 / 计数器)进入 spawn env 都会让 envHash 必变 → 重连即
   kill + 全新建,毁掉「断链保活 / 纯 attach」语义**。轮 41 实锤:pi session bridge
   token 曾每次 `randomBytes` 新生成,正常对话中 SSH 闪断一次就杀一次 pi。规则:
   新增 spawn env 键前先问「同 session 重建时这个值变不变?」——会变就必须确定性派生
   (如 `HMAC(进程级key, sessionId)`),或走非 env 通道(文件 / RPC 参数)。由
   `piEnvironment.test.ts` 的 token 稳定性断言守;`session-registry` 的 envHash
   机制测试只守「mismatch 会 restart」,守不住「env 不会自己 mismatch」。远端 Cindy-owned
   extension(`cindy-bridge` / `cindy-subagent`)源码字节必须进入 launch identity:
   `CINDY_PI_EXTENSION_BUNDLE_HASH` 只由源码确定,禁止随机数或时间戳;字节不变可 reattach,
   字节变化必须 restart。
11. **正式包后台脚本启动边界**:Desktop 正式包保持 `RunAsNode=false`,因此 Main 的
   `process.execPath` 是 Cindy 应用程序,**不是 Node 可执行文件**。Pi Subagent 的 durable
   runner 必须经 host 注入的 `spawnPiSubagentRunner` 交给 Desktop
   `utilityProcess.fork` 固定入口执行;扩展与 maker-core 不得再拼
   `ELECTRON_RUN_AS_NODE=1` 或把 `process.execPath` 写入子代理 env。开发版 / Vitest 里
   `process.execPath` 恰好可执行 JavaScript 不构成生产证据。打包契约测试必须同时断言
   `RunAsNode=false`、固定 utility-process 入口在 forge 清单中、Pi host 使用该入口，避免
   两份各自正确的测试再次掩盖跨模块矛盾。身份校验必须读未截断命令行（POSIX `ps -ww`
   / Linux `/proc/<pid>/cmdline`）；成功读到的命令行不含本 run 的 `runnerScript` 即
   视为 gone，只有读失败才 unverifiable。紧急停止和就绪超时都先对 runner pid 发 SIGTERM
   再 SIGKILL，禁止 `kill(-pid)` 把 utility-process 当成独立进程组。未确认退出不得写
   failed 终态（控制协议要带回 unconfirmed），否则 quit / 账号边界 sweep 会跳过仍可能活着的 runner。
   真正 spawn 前必须再读一次账号边界，并把在途 launch 纳入 teardown 收敛。Host 只用
   realpath 校验包含关系，传给 runner 的 argv 必须与 `config.runDir` 同一套原始绝对路径。
   dispose 未确认 runner 退出必须失败；Host 观察到的退出要能通过控制协议通知前台等待，不能只靠 status.json。
   Windows 上 SIGTERM 不得带 taskkill /F；前台若已读到终态必须先返回，不得被 Host 退出通知盖成失败。
12. **spawn argv 受平台命令行长度限制,host 注入的 prompt 不得整篇内联(2026-09-18,同步实测)**:
   Pi root 任务的 system prompt 追加段是经 **`--append-system-prompt <正文>` 作为命令行参数**
   传给子进程的（`packages/maker-core/src/agents/pi/index.ts`）。命令行有平台硬上限
   （Windows `CreateProcess` 32767 字符），上游因此新增保守预算
   `PI_WINDOWS_SPAWN_ARGV_BUDGET = 30_000` 并在 spawn 前调
   `assertPiSpawnArgvFitsPlatform(args)` 拦截（`project-resource-cli.ts`）。
   **后果**:任何把大段文本(**尤其是长 Skill 正文**)塞进 `userPrompt`/`runtimeConfig.systemPrompt`
   的 host 侧注入,都会让 argv 逼近上限;超限时抛出的文案是
   「This project has too many Pi skills, prompts, or extensions to start a task」——
   **与真实原因(某个参数太长)无关**,按该文案去删项目 Skill 不会解决问题。
   实测:战斗总控 Skill 正文 24,027 字符 ⇒ argv 30,497 > 预算 30,000 ⇒ Meka 战斗角色会话被拒。
   **规则**:host 要注入大段静态文本时,必须走**非 argv 载体**(文件路径 / 运行期已授权的目录),
   prompt 里只放**唯一绝对路径 + 读取指令**;禁止整篇内联。这条同时是 Meka 侧硬约束,
   见 `docs/dev-rules/meka-whitelist-verification.md` 的 **WL-15**。
   诊断建议:守卫超限时打印各参数长度(本轮曾用临时插桩定位,见同步报告 §7.8.6)。
   **2026-09-23 的量化事实(规范类元数据,Meka 默认角色)**:同一规则换到项目规范类元数据
   (`agents-md` / `rule`)上后,该样本的 `promptText` 从约 **42,600 字符降到约 4,900 字符**
   (真实项目样本:6 条 `agents-md` 正文合计 **95,418 B**;正文改为「作用范围 + 绝对路径 + 描述」
   的引用后不再进 prompt)。**据此按 win32 预算做一次算术推演**(⚠️ **算术推演,非实测**):
   基础 argv ≈ **1,500** 字符 + `--append-system-prompt` ≈ **6,400** 字符(即约 4,900 字符的
   `promptText` 加上 flag 与包装) ⇒ 留给逐条 `--skill` 的余量约 **22,100** 字符;单条快照 skill
   的路径参数(含 `--skill` flag 与分隔)≈ **193** 字符 ⇒ **约 114 个 skill 才越界**;本批实际规模
   **42–51 条** ⇒ 余量约 **2×**。这三个数字**全部是算术推演,没有任何一次 argv 实测**;
   判据仍以 argv 实测总长为准(见上),**不得**把它们当作「预算余量已被自动守住」的证据。
   **超过该量级时的两条 Pi 载体优化**(与本次改动解耦,可独立提交):① `--append-system-prompt`
   改**传文件**而不是正文(本仓 pin 的 0.85.1 二进制 `--help` 写明支持 `text or file contents`,
   见下方的取证纪律);② `--skill` 改**传目录/根**而不是逐条叶子路径(同一份 `--help` 写明接受
   `a skill file or directory`)。两条都能把对应参数从 O(N) 降为 O(1);改载体前必须实测
   「路径不存在时是否被静默当作正文字符串」等判定启发式。
   **战斗角色的 argv 代价(有意差异,2026-09-23)**:`workflow === 'saga2-combat-development-v1'`
   的角色,其 `agents-md` / `rule` **仍按改动前内联进 `promptText`**(理由见
   `meka-injection-layer.md` §7 D2.4 边界②与 WL-11.17 第 6 条:战斗会话的参考路径是封闭且精确的
   白名单契约,策略层会拒绝读工作区根 `AGENTS.md`)。⇒ 上面对默认角色算出的余量**不适用于战斗角色**:
   战斗角色若勾选大体积 `AGENTS.md`,内联后仍可能逼近 win32 的 30,000 预算,**本次没有为战斗角色
   加体积安全阀**。

   **取证纪律(2026-09-23 登记):「Pi 是否支持某形态」一律以 pin 的二进制 `--help` 为准。**
   本仓 pin 的 Pi **0.85.1** 发行包(`apps/pi-bin/win32-x64/`,`.version = 0.85.1`)自带
   `apps/pi-bin/win32-x64/docs/**`,而这些文档**滞后于同一个包里的二进制**:
   `apps/pi-bin/win32-x64/docs/usage.md:243-244` 写的是
   `--system-prompt <text>` / `--append-system-prompt <text>`(只暗示纯文本),
   而同一个包的 `pi.exe --help` 写的是 `Append text or file contents to the system prompt`
   (即**也接受文件路径**)。⇒ 任何「Pi 支不支持传文件路径 / 传目录 / 重复 flag」的判断,
   必须以**该包二进制自己的 `--help`** 为准;包内 `docs/**` 只能当参考,不得据它否掉一个
   二进制已经提供的能力。若两者冲突,以二进制为准,并在改动说明里登记该冲突。

### 4.1 包变更与执行终态

- 工具或原生包命令的回执写入队列、`extension_ui_response` 发出，只表示发送，不能据此
  关闭正在消费结果的调用者。包变更仍推进原有 generation 并捕获准确 runtime 实例；
  空闲实例退役，忙碌调用者和同一快照里的兄弟实例保留当前执行，产品终态送达后再退役。
  `runtimeConvergence=deferred` 表示旧快照暂时服务在途工作，不表示新包已经加载。
  provider 已空闲但 Session 尚未消费终态时，待退役实例仍拒绝新 turn；
  仅当前 generation 已由 Host 明确 claim 的 silent-stop continuation 可继续发送。
  调用者的现有 Host lease 必须覆盖兄弟关闭结果汇总及准确收敛回执的 Session 分发；
  不能把回执入队当作已分发。交付等待有界，显式关闭仍可结束旧实例。
  内部退役尚未真正开始关闭时，显式 Agent 切换／关闭可接管关闭原因；一旦开始关闭
  （包括退出未确认而失败），原因固定，不得被迟到操作改写。IM 切换保护继续匹配准确实例与原因。
  Host 已放弃续跑时，即使 turn lease 记账失败，也应按原实例与 generation 释放退役等待；
  记账失败仍不得据此派发后续工作或重放副作用。只有 Host 实际登记续跑的 generation
  才能阻止空闲关闭；远端／无 observer 接管的 silent-stop 不得凭终态自行占有续跑门。
  用户 Stop 发出 abort 后、等待 RPC 回执前即按 generation 撤销 Host 续跑门；
  挂起的 abort 不得阻止已结算工作的待退役 runtime 关闭，迟到返回不得复活旧实例。
  延迟退役的实际关闭若失败，应在该实例的监听器清理前补发 `partial` 与
  `restart-cindy-to-refresh-packages` 恢复回执；不改判此前成功结果，不自动重放工作。
  恢复回执只走 Session 的 `onRuntimeRecovery`，不得进入产品 `onEvent` 正文流；
  Desktop 与 IM 显式订阅，Goal／Learn／Orca 等消费者不逐个追加过滤。
  IM 已在 done 退订时，恢复回执须走独立渠道通知，不能把 post-terminal text fan-out
  当作已交付。通知保留准确实例和包退役发起 generation，渠道发送与送达确认分开；
  不借通知重开已完成 turn。官方 Telegram 复用协商后的 msg.op；旧 hook、Slack／X
  的独立出站缺口及离线／拒收／超时限制见 Telegram 能力台账，不扩大现有 wire 契约。
- 设置页明确要求停用／移除的即时失效路径仍可关闭运行时；Session 必须在清除监听器和
  当前 turn 归属前给未结算工作发明确失败。用户 Stop 则保持取消，不触发重放。
- provider idle、进程退出、事件流结束都不是成功证明。Session 用已有 turn generation／
  control 判断未结算工作，保留缺终态时的有界 watchdog；已送达的成功终态不能被后续退出
  改判成失败，provider continuation claim 也不能被当作最终结束。
- Pi 的 `Request was aborted` 只在无当前 generation 的 Host Stop 时归入请求断流失败；
  无错误正文的 bare abort 仍保持取消。复用既有错误收口及重试预算，不重放包命令或工具。
  但**整轮零用户可见正文、且不是 Host Stop 的收尾**不得静默收尾。共同条件是
  `finalAssistantText.trim()` 为空、`pendingAssistantError === null`、没有已发出的终态 error，
  且本 turn **没有** Host abort 请求（`isCurrentTurnHostAbortRequested`）；`outcome` 上再分两支：
  `completed`（上游用空正文 assistant 消息正常收尾）**无条件**进入该判定；`cancelled`
  （`stopReason='aborted'` 且非 Host Stop）额外要求本 turn **没有出现过** Host 停止登记
  （`isCurrentTurnHostStopSeen` 为假）。**seen 锁存只收紧 `cancelled`**：它的用途是「不回放用户
  明确停掉的 turn」，该关切只存在于 `cancelled`；套到 `completed` 上会让「abort RPC 报错回滚 +
  上游正常空收尾」这个既有自愈形态退回零输出（无正文、无终态 error、也不补发「继续」）——
  这正是本批第一版实现过的回归，改动时不得重犯。
  两个标记的寿命**刻意不同**：`markPiHostAbortRequested` 与 abort 标记同点写入
  `hostStopSeenGeneration`，而 `rollbackPiHostAbortRequest`（abort RPC 未被接受）**只**回滚 abort
  标记、**不**回滚 seen 锁存——用户确实按下过的 Stop 是既成事实，不能被一次 RPC 失败抹掉，
  否则那次空 `cancelled` 会被补发「继续」重新跑起来。锁存只按代际存活：`agent_start` 的代际前滚
  清掉上一代的锁存、`rollbackPiHostTurnStart` 撤销从未启动代际（`turnGeneration + 1`）的锁存、
  `disposePiTranslateContext` 做会话级清理；这几个清除点各自承重，删掉任何一个都不应让测试变绿。
  `isCurrentTurnHostStopSeen` 是 translator **模块私有**判定（`agents/index.ts` 只导出 `PiAgent`，
  它不属于公开 API）；回归用例一律钉行为（`done.data.silentStop`）而不探这个布尔——锁存未被清理时
  该布尔同样可能为假（旧代际值 ≠ 当前代际），只断言布尔等于凭空给测试以虚假的承重感。
  `stopReason` **是**判定条件，不只是日志字段：`aborted` 决定 `outcome` 落 `cancelled`，
  `length` 落终态 output-limit error；它同时作为诊断写进那条 WARN。
  命中后 translator 在 `done` 上附 `silentStop`，交既有 silent-stop 自愈（补发「继续」；
  额度／熔断耗尽时弹 `silent-stop-exhausted` 终态横幅），而不是补一条裸 error——
  `empty-response` 那类 reason 的自动重试会克隆原文，只对零副作用 turn 安全。
  Host Stop（用户 Stop 与 stall watchdog 共用 `abort()`）及已有正文的收尾仍不附标记，
  `outcome` 也保持各自的 `cancelled` / `completed`。
  **验证现状（2026-09-22）**：`packages/maker-core` 无 `typecheck` script，用
  `npx tsc --noEmit -p packages/maker-core/tsconfig.json`（exit 0）；
  `pi-translator` / `cindyBridgeSource` / `pi-mcp-client` 三文件 145 passed / 4 skipped，
  `pi-mcp-bridge.integration.test.ts`（真 pi 二进制）15 passed。上述锁存与两支判定均有红→绿
  变异证据；`completed + 锁存命中 + 空正文` 这一格此前零覆盖，现已有回归用例。
  **未实机验证**：真实网络断流下「用户一个字都没拿到」的场景未复现。
- SDK 成功与正文入库／交付分开取证。只见 JSONL 成功但 SQLite 缺正文时，不能自动重跑
  已成功的工作；应沿 RPC → translator → Session → persistence 查丢失边界。

## 5. 已交付(2026-07 里程碑)

- redacted thinking 不再显示为空卡片;PI 会话图标(π);Auto-review 核心 + pi adapter + auto 档;
  PI_OFFLINE / NO_PROXY;`--append-system-prompt`;斜杠转义 + 只读工具凭证收口;成本计量真值;
  权限档四语 i18n + 弹窗正文归一化 + 能力契约测试。
- 自动化安全网:maker-core PI 定向 + 端到端集成(真 pi 二进制 + 真 bridge + 假模型工具调用)
  覆盖安全命令静默执行 / 危险命令升级并 deny 拦截 / 区内写落盘 / 凭证读升级 / 普通读直通 /
  斜杠转义 / models.json 计费透传。
- PR4 项目资源桥(2026-07,已废止):当时只装配 Cindy 明确批准的 Skill，项目 packages/extensions
  不执行。现行口径见 §8：本地根任务用 `--skill` / `--prompt-template` / `--extension` 原地加载
  仓库原路径，不走批准快照；项目 `.pi/extensions` 会进入该会话。项目 packages 仍不自动安装。
  同一条 `--skill` 通道现也承接**宿主冻结的技能快照**（2026-09-22 起，见不变量 8）：本地 root
  任务把快照的每个 `skills/<id>` 作为显式 `--skill` 挂入并排在项目 Skill 之前；远端会话不挂，
  review 会话保持 hermetic。

### SSH 远端能力(2026-08 里程碑,轮 39 补记)

- **形态**:SSH remote 已交付。远端 daemon 唯一形态是 `packages/maker-pi-manager/`
  (TS 单例 Node daemon,NDJSON RPC over unix socket,per-host 常驻);Python per-session
  daemon(`pi-daemon.py`)已完全退役并从仓库移除。新增 `PiTransport` 抽象(本地
  `createPiStdioTransport` / 远端 `createSshPiDaemonTransport` 双实现,PiRpcProcess
  感知不到差异)。
- **关键组件**:`maker-pi-manager`(protocol/codec/server/client/session-registry/bin)、
  `pi-manager-installer.ts`(probe/install/ensure/uninstall)、desktop 侧
  `pi-manager-client.ts` / `pi-remote-transport.ts` / `pi-host.ts` 装配。
- **凭证面**:网关 key/BYOM key 经 SSH 加密通道传远端,落 per-session env-file(0600);
  kill/空闲回收(30min)/daemon 重启(cleanupStaleState)三路径清理。Full Access 下
  bash 可读父进程 env 的已知风险(见上文 §3)同样适用于远端会话 —— 远端会话的
  ask/auto 档同样受限。BYOM key 落远端机器是设计语义(远端 pi 直连 BYOM endpoint),
  用户可见性由 i18n 文案覆盖。
- **受限能力(有意)**:远端会话不支持本地 fork(`forkSdkSession` 抛 remoteFork);
  `/review` 对 SSH 远端会话前置拦截(device-link 同款);无自动重连(用户手动 Retry,
  与 CC/Codex 对齐);版本差 + daemon 活着时 defer 并显示 UpgradeBanner, 用户确认
  后才 kill + 重装(daemon 已死则静默升级磁盘 bundle)。

## 6. 上线门禁

- [x] **平台分发**:pin 已升级到 Pi `v0.84.3`，darwin arm64/x64、linux arm64/x64、
      win32 arm64/x64 六份官方资产都进入 digest pin；下载器兼容 Unix `pi/` 嵌套包与
      Windows 根目录平铺 zip。当前 Mac 已完成六资产 SHA-256 下载验收；非本机 OS 的
      最终启动 smoke 仍由对应发布 runner 执行。2026-08 起 pi 与 cc/codex 一样只走
      CDN 运行时分发链(`agent-binaries` + splash prepare):CDN manifest 的可选 `pi`
      字段指向整包 tar.gz(归档根即完整目录分发,SHA256 为 tar.gz 的),启动时按
      manifest 版本下载到 `userData/pi/<version>/` 并清理更旧版本；prepare 会先对所有带
      `.verified` 的本地候选执行有界 `--version` 探针，真实 semver 不低于 manifest 时直接
      保留该安装（包括原地自更新后目录名仍旧的情况），不下载也不清理。只有 manifest
      版本更高，或探针没有得到可用候选时，才沿用原 CDN 安装流程。正式安装包不内置 Pi；
      manifest 缺字段或下载失败时**不阻塞启动**(splash 不进失败态),本次不注册 pi。
      **不变量(刻意如此,别当 bug 改掉)**:`pi-host.resolvePiBinaryPath` 只读
      `getReadyBinaryPath('pi')`——即本次启动 prepare 成功回填的路径,**不回落
      `getCachedBinaryStatus`**,因此不会复用上一次启动下载的旧版本。`prepare()` 先取
      CDN manifest、取不到就直接失败(不看本地存货),所以离线时 pi 本次不可用。这与
      Claude Code 一致(同样只读 `getReadyBinaryPath`),但与 **Codex 不同**——codex 读
      `getCachedBinaryStatus`,会接受早前已 `.verified` 的旧版本,离线仍可用。想让 pi
      也离线可用属于行为变更,需先确认再改,不要以"和 codex 对齐"为由顺手改回。
      发布入口：**Cindy Meka 桌面渠道**的 pi 段由本仓发布链路发布（`pi-host` / `agent-binaries`
      的消费端不变）：`apps/desktop/scripts/ci/runtime-release.mjs` 的 `PI_DIR_DIST_DEFINITION`
      从 `tools/pi/latest.json` 直链下载上游归档 → 按 pin sha256 校验 → 归一布局 → 补主题 →
      确定性 tar.gz → `pi/<ver>/<platform>/pi.dist.tar.gz` + manifest `pi` 段。上游 Cindy 渠道的
      二进制发布仍走 cindy 同级目录的独立工程 `cindy-binary-release`
      (`pnpm release:pi -- --region cn|global`)。本仓另外保留版本 pin 与暂存
      (`pnpm update:pi` / `install:pi`)。
      **回归红线**：`pi` 段是 packaged 用户拿到 Pi 的**唯一**途径（安装包不内置、客户端无本地回退），
      漏发就等于 Pi agent 在正式包里不存在。验证方式：装包后日志出现
      `pi agent enabled { binaryPath: ... }`（而不是 `pi runtime not ready: asset_missing`），
      且 `maker:get-capabilities` 回报三个 agent（含 `pi`）；清单与语义检查见
      `meka-whitelist-verification.md`。历史事实：0.0.21 / 0.0.22 两个正式包都因漏发该段而
      Pi agent 不可用（表现为只在 pi 路由上默认开启的模型集体消失）。
- [x] **协议/模型兼容自动矩阵**:Anthropic Messages、OpenAI Responses、OpenAI Chat 三种
      Pi 原生 BYOM 映射均有契约测试；真实 Pi + fake gateway 覆盖 thinking/tool streaming、
      MCP bridge、redacted/usage 翻译，ChatGPT 订阅已做真实请求与 cacheRead 验收。发布账号的
      每个真实模型(chatgpt/、xai/、glm、deepseek、kimi…)仍建议在 release candidate 上
      anthropic-compat 下至少跑一轮**带工具调用**的回合,逐个确认 thinking 格式 / tool
      streaming / redacted thinking 正确；这是额度/账号发布 smoke，不再是功能缺口。
- [x] **compaction**:启动显式开启 Pi 原生 auto-compaction；threshold／overflow 压缩及续接由 Pi
      负责，Cindy 只投影事件并在本机确定性失败后换窗。手动 compact、boundary/usage 翻译、
      compaction digest 写入与缓存命中仍有测试。
- [x] **无人值守**:scheduler 对 `agentKind=pi` 使用 Pi 默认模型与
      `bypassPermissions` 的契约测试已补；Pi bridge 的 auto allow/deny 也用真二进制覆盖。
- [x] **resume 边界**:已用 Pi v0.82.1 真二进制创建 JSONL，再由 v0.83.0 恢复；
      invalid resume 在适配层先校验文件存在并遵守 CAS，precise rewind/fork 后 resume 有真二进制测试。
- [x] **prompt cache**:Pi 子进程默认注入 `PI_CACHE_RETENTION=long`；不支持的 provider
      忽略该选项。已用 ChatGPT 订阅实例确认 `cacheRead` 命中会端到端落库与展示。

## 7. 上线后路线图(已与 Chris 对齐)

项目 trust 的输入/输出契约见 [`pi-project-trust.md`](pi-project-trust.md)。PR4 已按该契约
收缩为 skills-only 显式装配；它不授权 `--approve`、trust.json、项目原始 settings 或用户
Pi home 复用。settings/packages/extensions 仍属于后续独立安全评审范围。

> 续做指南(每项怎么接着做 + file:line 锚点 + 坑)见 `docs/dev-rules/pi-remaining-work.md`。

- ✅ **HTML 导出**(已交付):`export_html` RPC 全链路仍在。会话头部 overflow 菜单入口暂隐
  (Pi 专属项先不进 `···`)。见 `Capabilities.sessionHtmlExport` /
  `Session.exportSessionHtml` / `MAKER_INVOKE.EXPORT_SESSION_HTML`。
- ✅ **手动压缩**(已交付):`compact` RPC 全链路仍在。头部 overflow 菜单入口暂隐;对话区
  context ring 仍可点按压缩。良性「nothing to compact / too small」→ `noop`(不报失败)。
  见 `Capabilities.manualCompact` / `Session.compactSession` / `MAKER_INVOKE.COMPACT_SESSION`。
  注:pi 斜杠转义后用户无法手输 `/compact`,context ring 是当前 Pi 会话手动压缩入口。
- ✅ **subagent 接 pi 轻量引擎**(已交付):Orca worker 可选 `pi` 引擎。核心链路(MCP
  schema / worker 创建服务 / 默认模型 claude-sonnet-4-6 / PiAgent 注册)本已按 AgentKind
  接通;本次补齐 UI(CreateWorkerPopover / composer「+」菜单协同项 / draft 映射)、两个
  main IPC coercion(WORKER_CREATE / SESSION_ENABLE_ORCA)、worker 展示(π 而非 Claude 脸)。
  注:pi 二进制缺失时 buildPiAgent 返回 null,pi 不进 agents map,建 pi worker 会抛错。
- ✅ **压缩即记忆**(已交付):新增 `digest` 记忆类型(与 curated 解耦)。pi `compaction_end`
  带 `result.summary` 时经 `deps.makerMemory.write` 写 digest —— 进 FTS 可 `memory_search`,
  但排除出 MEMORY.md / system prompt / LLM 的 memory_write 工具,**不污染 curated 记忆**。
  gate 同 CC(makerMemoryEnabled + manager),fire-and-forget。见 `memory/types.ts`
  (MEMORY_TYPES / CURATED_MEMORY_TYPES)、`memory/storage.ts rebuildIndex`、`pi/index.ts`
  writeCompactionDigest。
- ✅ **BYOM / 本地模型**(已交付):自定义/本地模型走 pi 原生 provider 块直连,不过 compat 代理。
  链路:ProviderConnectionDialog 连接设置(模型能力来自统一目录)→ custom-provider-store(pi runtime)→
  user-provider 派生 → pi-host `resolvePiNativeProviders` → PiAgent writeModelsJson 原生块 +
  provider 感知 setModel。真二进制测试证明直连原生端点、网关零请求。
- ✅ **统一会话树**(已交付):Cindy session fork 与 Pi append-only entry tree 的后端/
  对话框实现仍在。头部 overflow「任务分支」只在存在 Cindy 分叉家族时显示,不再单凭
  `agentKind=pi` 露出。支持原生分支切换、可选分支摘要、选中 user entry 回填原 prompt、
  SQLite 可见时间线原子重投影与上下文 usage 恢复;device-link / mobile transport
  contract 同步开放。切换不回滚工作区文件。
