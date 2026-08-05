# `origin/main` → `meka/main` 同步报告

## 1. 范围与基线

- 工作区：`C:\Workspace\cindy`
- 目标分支：`meka/main`
- 来源：`origin/main`
- 来源 SHA：`58060cd4c`（本轮最新 `origin/main`；前一阶段基线为 `2db5c6280641`）
- 目标合并前 SHA：`58edde41c7c8f2b712a9e2899742e519d37f0ca4`
- merge-base：`e4b464a2efcc56110dd71251c654eab72e9b70b0`
- 执行时间：2026-08-04（Asia/Shanghai）
- 交付状态：本轮 merge 正在收敛冲突，尚未 commit、push 或创建 PR。

本次只处理客户端仓库已有范围，并按用户确认纳入 Meka fork 的 `cindy-protocol` gitlink
同步；未修改协议子仓源码、服务端仓库或无关存量问题；没有执行 `git merge --abort`、
破坏性回退或覆盖用户已有改动。

## 2. 决策记录

| 决策 | 决策人 | 结论 |
| --- | --- | --- |
| 两边有效内容都保留，采用语义双向合并 | 用户 | 不使用盲目的 ours/theirs；冲突按产品边界逐组处理 |
| Desktop 新包身份采用 Meka 命名 | 用户 | 采用 `CindyMeka/CindyMekaDev`；旧 `Cindy/CindyDev` 仅做 dev marker 只读兼容，不回退 Meka 安装、数据、协议和更新器身份 |
| 数据库 migration 采用追加方式 | 用户 | 保留 Meka `0082`-`0089` lineage；不重放已被 Meka `0089` 覆盖的上游 `0082`/`0083` |
| 新增 `0090` | 用户确认后的实现 | 用于两边共同需要的新字段；nullable `cost_currency` 先以 USD 回填 |
| 格式、重复 import、类型接口并集 | Agent | 仅处理可证明不改变功能的结构冲突 |
| Agent/IPC、插件权限、身份、远程路由冲突 | 用户定下“双向保留”原则；Agent 按现有产品边界落地 | 保留双方语义并恢复完整边界；没有用类型强转或删除路径掩盖不确定性。若后续行为测试显示真实产品取舍，暂停并回请用户决策 |
| 合并后新增代码造成的括号/函数闭合断裂 | Agent | 仅补齐结构闭合并保留双方新增内容；未改变运行时语义 |
| `@` 资源 Provider 运行入口 | 用户 | 接受上游移除两阶段 Provider 搜索、IPC、preload 和权限展示；保留历史 `plugin-resource` 解析、序列化、正文投影与旧 manifest 宽容读取 |
| `cindy-protocol` gitlink | 用户 | 协议仓也是 Meka fork，接收上游 `ff055be58` 协议包回到源码直发的指针；不在本次修改子仓源码 |

## 3. 冲突内容与最终处理

### 3.1 区域、身份和端点

涉及 `clientEndpointsService.ts`、`bootstrap-electron.ts`、`AuthContext.tsx`。

- 上游提供新的端点/区域与认证生命周期；Meka 提供 `CindyMeka` 身份、`cindy-meka`
  协议/更新渠道和旧 `xdmaker-meka` 只读迁移。
- 最终保留上游区域默认与运行期 override，同时保留 Meka 安装身份、数据库前缀、深链
  和迁移边界。无限定区域仍归 Global。
- 该组没有发现需要用户二次裁决的语义冲突。

### 3.2 远程 Agent、IPC 与 Orca

涉及 `maker-ipc/register.ts`、`maker-host/index.ts`、`cc-manager-client.ts`、
`maker-cc-manager/src/sdk-handlers.ts`、`orcaWorkerCreationService.ts` 及协同 renderer。

- 上游增加 Pi、远程会话生命周期和新的 provider routing；Meka 增加 MCPRouter 目标、
  P4 路径、Meka 项目/角色绑定、远程 Codex bundle 和高风险授权卡。
- 最终通过接口并集保留两边能力：`authorizeMekaHighRiskCallViaDesktop` 恢复为
  fail-closed 的一次性交互；Meka Worker 目标只允许配置的 P4/绑定 MCPRouter 目录；
  provider availability 对 Pi 使用可选记录，旧测试不被迫伪造无关 Pi 数据；Orca 快照
  支持 `workspaceKind: 'meka'`。
- 没有将 Meka 路由降级为普通 project，也没有删除上游 Pi/provider 能力。

### 3.3 插件市场与权限边界

涉及 `plugin-market/service.ts`、`registerIpc.ts`、`shared/pluginMarket.ts`、
`GhostPluginPage.tsx`、`GhostPluginDetailView.tsx`。

- 上游增加自定义 Git/本地市场、来源指纹、reviewed package 与权限复核；Meka 增加
  独立市场、下载大小策略、安装进度 channel 和 Meka/Cindy 来源 ledger。
- 最终保留两套服务：普通市场继续支持 custom source/reviewed package；Meka 市场使用
  独立 ledger、大小上限和 progress callback。IPC 只发送经过校验的 operationId 与
  progress payload；卸载时同时准备两套 ledger，渠道 ledger 继续区分 Cindy/Meka。
- 重复 import、构造函数参数和 renderer 类型声明按并集恢复，未通过 `any` 绕过权限
  检查。详情测试 fixture 补齐上游新增的 source 字段。

### 3.4 数据库 migration

涉及 `apps/desktop/drizzle/0082`-`0089`、`0090_rich_phalanx.sql`、snapshot、
script 和 journal。

- 保留 Meka `0082`-`0089` lineage；上游同义 `0082`/`0083` 不再次应用，避免重复建表
  或改变历史 checksum。
- 新增 `0090` 采用追加 schema；历史 nullable `cost_currency` 使用
  `COALESCE("cost_currency", 'USD')` 回填，再进入后续约束路径。
- 该决策由用户确认；迁移脚本不删除历史 migration，不重写已有 snapshot。

### 3.5 生成文档与测试辅助代码

- `helpKnowledge.generated.ts` 由 `help-knowledge/*.md` 重新生成，恢复上游文档正文，
  不手改生成结果。
- Orca 测试 availability 改为 `Partial<Record<AgentKind, ...>>`，补齐 Meka workspace
  类型，不删除 Meka 测试场景。
- renderer 测试 fixture 补齐 `sourceType/sourceMarketName`；普通插件 action 显式传入
  `meka={false}`；可选的文件更新回调不再要求测试构造无意义的 handler。

### 3.6 `@` 资源 Provider 移除（本轮新增冲突）

涉及 `atResourceProvider.ts`、对应 Main/Preload IPC、`atResourceService.ts`、
`AtMentionPanel`、`ChatInput`、`GhostManifest` 权限类型及旧 Provider 测试。

- Meka 旧实现解决的是“在 `@` 面板中先选择插件，再调用一个只读搜索工具定位外部
  资源”的问题，并提供本地 session 工作目录校验、插件启用/Setup 门禁、固定
  `{ query, limit }` 参数、结果清洗、超时与 `plugin-resource` 深链，避免草稿路径
  伪造和副作用工具被隐式调用。
- 上游提交 `694ae8607` 重构 `@` 入口，改为直接列出已安装插件的 `plugin-command`；
  远程会话也不再暴露控制端本地插件入口，因此删除 Provider 搜索调度、IPC、preload
  API、权限 receipt 和两阶段输入状态。普通插件 tool/command 仍保留。
- 最终处理：接受上游删除运行入口及 `atResourceProvider.ts`/旧 Provider 测试；不恢复
  已废弃的两阶段搜索。保留共享层对历史 `plugin-resource` 的 parse/project、正文
  展开、消息展示和 composer 序列化兼容，并让旧 manifest 中同名字段被宽容忽略，避免
  历史插件/消息因升级而消失。`plugin-resource` 只作为历史引用类型，不再由新入口生成。
  `reveal` 权限类型与该功能无关，继续保留 Meka 的独立 Reveal 能力。
- 影响：新安装或更新的插件不能再通过 `manifest.atResourceProvider` 接入 `@` 搜索；
  需要搜索资源的能力应迁移到普通插件 command/tool。已有消息中的资源正文和 session/
  message 元数据仍可展示与投影。决策人：用户；实施人：Codex。

### 3.7 `cindy-protocol` 指针同步（本轮新增冲突）

- 上游将协议包从预构建产物切回源码直发，目标 commit 为 `ff055be58e05a082bb5eb6327de115ad8bf127b9`；
  Desktop dev/typecheck/bundle 不再依赖撤销的预构建 `@cindy/model-access-protocol`，
  Mobile 增加 `.js` → `.ts` fallback。
- 子仓 `origin` 已核对为 Meka 官方 fork `https://github.com/kapt66/cindy-protocol.git`。
  本次只在已有 fork 提交之间合并并更新父仓 gitlink，不修改协议源码；跨仓发布前服务端需
  同步使用同一协议 commit，避免 wire protocol 漂移。用户确认将该 fork 纳入本轮同步。

## 4. 验证与剩余风险

已执行：

```text
git diff --name-only --diff-filter=U
pnpm --filter desktop gen:help-kb
NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter desktop exec tsc --noEmit --pretty false
```

当前没有未解决 merge marker。已完成的定向验证如下：

- Desktop TypeScript：`pnpm --filter desktop exec tsc --noEmit --pretty false` 通过。
- Desktop 数据库：`pnpm --filter desktop db:validate` 通过。
- migration replay：直接运行 `migrationReplay.test.ts` 的 6 项通过；标准
  `test:migration-replay` 在准备 Pi 二进制时被 GitHub API 403 rate limit 阻断。
- 合并相关定向回归：7 个文件、185 项通过；结构修复后 maker-cc-manager 32 项、
  lizi-mcps 9 项、orca-workflow 11 项通过。
- Telegram 个人群窗口测试夹具已直接修复：原测试错误执行 `0083_*`，未创建上游新增的
  `hook_group_messages` 表；改为按表定位并执行包含该表的 migration 后，12 项通过。
- 身份测试基线按用户决策改为 `CindyMeka/CindyMekaDev`；`devKeychainName` 运行时仍接受
  旧 `Cindy/CindyDev` 标记并映射到当前身份，开发身份与 CLI 测试共 43 项通过。

根 `pnpm test:unit` 的早期失败快照（保留在 5.1 作为归因证据）曾显示基础 workspace 360
通过、7 跳过；Desktop 22 个失败文件/53 项失败，Mobile 2 个失败文件/2 项失败，
`packages/maker-shared` 1 个失败文件/6 项失败。3 个本次合并插入的结构闭合错误
（`sdk-handlers.ts`、`createWorkerTool.test.ts`、`orca-bridge-prompt.test.ts`）已补齐，
相关 package 测试分别通过 32、9、11 项，且不再有 collect/transform 失败。该快照中的剩余项
随后按 5.1-5.4 逐项复测、归因并处理；最终门禁结果见下方最新验证记录。

尚未 commit、push；后续提交必须按仓库要求使用 `git commit -s` 并先完成完整门禁。

## 5. 决策记录与验证追踪

本轮没有遗留需要用户选择的功能语义冲突。若后续重新同步上游并暴露 Agent 路由、插件权限、
数据库历史或身份兼容的行为差异，应暂停该具体冲突并追加决策记录，不以测试绿化为理由改变
产品行为。

### 5.1 失败复测与归属判断（2026-08-04）

以下保留上次失败集合的归因快照，作为处理证据；后续修复结果见 5.2-5.5。归属依据是当前
合并结果相对两条父线的对象：

| 归属 | 证据与代表性失败 | 当前处理 |
| --- | --- | --- |
| 本地双向合并结果 | `newMakerOrcaCreateOrder`、`orcaWorkflowRoute`、`agent-input-coordinator`、`GhostPluginCreatePrompt`、`plugin-market/ipcErrorBoundary` 等测试或实现同时偏离 `HEAD` 与 `origin/main`；早期失败表现为 Orca policy 字段、插件引导文案和 IPC 错误契约不一致 | 用户选择 A 后按并集保留：Meka workspace 绕过普通 Cindy policy，普通 Cindy/远程会话保留上游 policy；插件 prompt 与 IPC 集合保留双方有效内容。定向测试已通过 |
| 高可信 Meka 基线存量 | `imageRefParseUserContent`、`agentInputReferences` 等测试和对应实现均与 `HEAD` 相同，失败不由本次文件合并产生 | 不纳入本次 merge 修复，保留并记录 |
| 上游新增能力在 Meka 环境中的兼容失败 | `devKeychainName`、`installCliCommand`、`systemCardAutoResumeRow` 等测试/实现来自 `origin/main`；其中身份测试期望 `CindyDev/Cindy`，当前产品身份是 `CindyMeka`。Telegram 原失败是测试夹具未执行包含 `hook_group_messages` 的 migration，已直接修复并通过 12 项 | 不把身份/文案失败误判为 Meka 存量，也不为绿测试改身份；身份需用户决策 |
| 引用 projection 与 Meka scheme 的本地合并回归 | `agentHandoff`、`sessionTaskSummary`、`atResourceService`、Mobile `messageNormalize/inputProjection`、maker-shared `agentInputProjection`。回溯确认正文展开由共同祖先 `e69e0cac7` 引入，两边都没有删除；Meka `1303745e7` 只把跨端解析改为 `cindy://` 互操作集合。本次 merge 接入上游新增引用类型时误覆盖该解析边界 | 改用 `allAcceptedDeepLinkSchemes()` 接受 Meka 本机及 Cindy 互操作输入；生成侧不变。本机任务链接测试使用 `cindy-meka://`，带 deviceId 的跨端链接继续使用 `cindy://` |

这次复测没有发现新的语法/collect 阻断；此前 3 处合并闭合错误的修复保持通过。上述归属是
证据等级判断，不等价于“上游版本单独运行必然通过”；在没有独立父线复跑环境前，不将低等级
兼容失败归咎于某一方。

### 5.2 文案冲突处理（2026-08-04）

- `GhostPluginCreatePrompt`：上游把插件创作引导升级为先读 guide 第 0 章“设计对齐”，
  使用带选项的提问卡片并标注推荐项；Meka 原文只要求逐步提问。按用户选择 A，四种语言
  均采用上游新引导，同时保留 Meka 的 `ghost_forge_pack(channel: "meka")` 渠道归属文案。
- `builtinToolsCollabDescriptionI18n`：中文原文使用“新建的对话”，上游测试及同组其他语言
  使用“新建的任务/session”。按同一选择将中文同步为“任务”；未改变协同开关的运行时策略。
- 决策人：用户（本次对话选择 A）；实施人：Codex。定向测试 3/3 通过。
- `plugin-market/ipcErrorBoundary`：测试原本把 `invokePluginMarket` 调用数固定为 10，
  这分别对应任一父线的 IPC 集合；合并后同时保留普通市场、Meka 市场和自定义来源管理，
  当前 16 个注册点均经过同一结构化错误边界。未删除 handler，测试改为断言完整合并集合的
  16 个调用点。该项属于测试契约修正，不改变 IPC 行为；实施人：Codex。定向测试 4/4 通过。
- 其余同组 i18n 缺口：同步上游已明确的中文“任务”术语（权限范围、自动化成本/持续任务）
  以及四语自动续接成功态与分隔条的独立文案。没有改变组件逻辑；`PermissionPrompt`、
  `SystemCard`、`automationGeneratedSessions` 定向测试共 39/39 通过。实施人：Codex。

### 5.3 引用投影与 scheme 回溯（2026-08-04）

- “引用消息展开为可读正文并附 session/message ID”来自共同祖先提交 `e69e0cac7`
  （原 Cindy PR #502），用于富文本引用 chip 在 Agent 输入、handoff、标题摘要等语义消费点
  读取真实内容；深链只作为稳定位置元数据。该行为不是 Meka 私有改动，上游和 Meka 父线
  都继承了它。
- Meka 提交 `1303745e7` 仅将 `agentInputProjection` 的解析集合切到
  `CINDY_INTEROP_DEEP_LINK_SCHEMES`，使跨设备 wire 延续 `cindy://`；没有改动正文展开。
- 本次 merge 为接入上游提交 `c1e8c3b94` 新增的 browser-tab、desktop-window、
  plugin-resource 引用，误把 parser 循环覆盖回 `allDeepLinkSchemes()`。在 Cindy Meka
  身份下该集合不含只解析的 `cindy://`，导致合法互操作引用被判无效并原样透传深链。
- 最终修复：parser 使用已有 `allAcceptedDeepLinkSchemes()`，同时接受本机
  `cindy-meka://`、历史 Meka scheme 和只解析的 `cindy://`；生成逻辑保持不变。本机任务
  引用仍生成 `cindy-meka://`，带 deviceId 的跨端引用仍生成 `cindy://`，不改变 OS 注册边界。
- 决策依据：用户确认 scheme 分层是既定设计；正文展开按两边共同历史恢复，不需新增产品
  取舍。实施人：Codex。验证：maker-shared 10/10、Mobile 57/57、Desktop 投影相关
  529/531 初次通过，剩余 2 项为本机 scheme 测试基线，修正后 `atResourceService` 23/23
  通过。

### 5.4 剩余 Desktop 测试归因（2026-08-04）

- `atResourceProvider` 的插件资源测试沿用了上游 `cindy://` 期望，而被测代码生成的是本机
  资源链接。按用户确认的既定分层，将测试期望改为 `cindy-meka://`；不修改生成逻辑，也不
  改变带 deviceId 的跨端 `cindy://` wire。决策人：用户；实施人：Codex。
- Agent Island 的中文无标题断言暴露出 4 个产品 Session key 仍保留 Meka 父线旧称
  “未命名对话”。上游父线和当前术语表均已裁决为“未命名任务”；按用户此前选择 A（采用
  上游术语）同步这些 key。英文、日文、韩文已经符合各自既定译法，无需改值。决策人：用户；
  实施人：Codex。
- 两个 macOS 受保护目录测试实际收到中文弹窗，是同文件前序用例切换 main locale 后未由
  `beforeEach` 恢复，属于测试全局状态泄漏，不是合并后的功能行为变化。测试初始化现在显式
  重置为英文；产品弹窗文案和目录权限逻辑不变。直接处理依据：测试隔离修复，不涉及产品取舍。
  实施人：Codex。
- 合并后的术语门禁发现 3 个 message 操作仍沿用 Meka 父线的“条对话”，按用户选择 A 同步
  上游“消息”术语。另有 2 个仅 Meka 保留的余额说明被新版 Provider 规则误报；术语表既有
  说明明确这里指支付渠道/收单机构，日文“事業者”是正确语义，因此恢复仅覆盖这两个 key 的
  精确豁免，不把它改成模型“プロバイダー”。决策依据：用户选择 A、术语表既有语义说明；
  实施人：Codex。

### 5.5 第二轮全量门禁失败归因（2026-08-04）

- 四语 locale 的 44 个缺 key 不是 Meka 调用路径错误。两条父线都只有一个
  `settings.ghosts` 对象：Meka 父线包含 Meka 市场、开发插件和面板文案，上游父线包含新版
  普通插件市场文案；本次文本合并把两块对象同时放进同一个 `settings`，形成重复 JSON key。
  运行时 JSON 解析采用后一个对象，前一块 Meka 文案因此被整体遮蔽。最终以结构化对象并集
  合成唯一 `settings.ghosts`，重叠 key 采用上游当前值，Meka 独有 key 全部保留；组件调用和
  用户可见行为不改。该问题由本地双父线合并引入，实施人：Codex。
- `sentPastedTextPreview` 的失败来自上游提交 `789f417c7` 新增的源码结构断言把换行写死为
  LF；Windows checkout 读取到 CRLF 后匹配失败，被测 Renderer 行为与上游一致。测试改为
  同时接受 LF/CRLF，不改粘贴正文投影或收起逻辑。该问题属于上游测试的 Windows 兼容缺口，
  实施人：Codex。
- 两项修复后的定向复测为 13/13 通过；locale 结构恢复为四语各一个
  `settings.ghosts`，Meka 与上游关键子树均可由运行时 JSON 对象读取。

最新验证（2026-08-04）：第二轮 `pnpm test:unit` 全部通过；Desktop、Mobile、maker-core、
maker-shared、lizi-im 及全部可运行协议包均 PASS。受影响包按仓库门禁执行
`run --if-present typecheck`，Desktop、Mobile 通过，其余包无该脚本并按规则跳过；
`pnpm check:i18n` 与 `pnpm check:i18n-glossary` 通过（仅保留仓库既有 warning）。工作区无
未解决冲突标记；本报告随 DCO 签名 merge commit 落地，未 push。

### 5.6 合并后插件开发态 UI 回审（2026-08-05）

- 用户反馈插件开发模式角标消失。回溯确认 `GhostPluginIcon`、开发注册表、
  `development` 计算和 Meka 快捷入口均仍在；问题来自 `4d1e01b7f` 对上游插件卡片重构的
  冲突落地：`GhostPluginCard` 仍接收 `development`，但调用图标时漏传该属性。开发卡的
  `onDevelopmentPackage` 入口和 `syncError` 来源文案也在同一重构中被遗漏；Meka 列表更新
  按钮的 `updateProgress` 参数/渲染同时被删除，导致准备、下载、安装阶段不再可见。
- 处理：恢复卡片到图标的 `development` 投影；恢复开发卡“打包”动作和同步失败来源文案；
  恢复 Meka 列表更新按钮的进度投影，并补充卡片回归测试。未改变普通 Cindy 插件市场、
  Meka/普通市场账本或开发注册表运行时行为。
- 归因：本地双向合并后的 UI 语义断链；不是上游删除 Meka 功能。决策人：用户要求修复；
  实施人：Codex。验证：插件卡片、图标、详情和开发包弹窗定向测试 50/50 通过；Desktop
  typecheck、`git diff --check` 和 `pnpm check:i18n-glossary` 通过。真实目录热更新、Light/Dark
  实机目检仍未执行。

### 5.7 Meka 插件/技能基础能力映射回审（2026-08-05）

- 对照 `origin/main` 的插件页更新链路与迁移账 4.7.1，确认 Meka 已复用同一批量更新模型、
  权限差异复核和安装进度展示；但 Meka surface 的列表渲染曾漏掉更新横幅、“全部更新”入口及
  批量弹窗，只保留了卡片单项更新。该遗漏属于本地 Meka Renderer 映射断链，不是上游有意移除
  Meka 功能。
- 处理：Meka 插件页补回 Cindy 同款“`x` 个插件有可用更新”横幅、忽略本轮和“全部更新”按钮，
  复用 `UpdateAllDialog`；批量控制器在启动时捕获当前 market adapter，普通页绑定 Cindy
  `pluginMarket`，Meka 页绑定 `mekaPluginMarket`，并按渠道隔离窗口级批次投影，批次离开页面后仍不跨渠道。Meka 的独立
  MCPRouter ledger、安装进度事件和开发插件管理入口均保留。
- “忽略本轮”状态同时按渠道分桶：保留旧 Cindy key 的兼容读取，新增 Meka 独立 key，避免用户
  在普通插件页忽略更新后误把 Meka 更新横幅一并隐藏。
- 回审还发现 Meka 安装 IPC 未透传 `reviewedBaseline` / `approvedPackageSha256`，导致扩权或
  实际包权限复核批准无法达到 Main 的既有安全前置条件。只补齐这两个已存在于共享
  `PluginMarketService` 的参数，不改变权限策略或放宽审查；单项和批量 Meka 更新都继续要求
  用户确认扩权。
- 技能页逐项核对：Meka 首页已复用 Cindy 的推荐卡、本地全局/项目分组、预览面板和安装目标；
  市场页已复用工具栏、筛选、卡片、预览和安装交互，并保留 Meka 独立 MCPRouter 目录、文件
  预览、发布、访问范围管理和删除能力。发现 Cindy 首页的“导入本地技能”暂未映射：Meka
  当前没有独立的本地目录授权/安装 IPC，且迁移账 4.7.2 明确把独立 ZIP 安装、本地卸载和持久
  开发来源列为后续增量；没有把 Cindy `skillhub.importLocal` 误接到 Meka，以免写入错误
  provenance。Meka 市场技能仍未混入 Cindy SkillHub 或 Meka 项目角色内置目录；该导入能力若要
  纳入本轮，需要新增 Meka 渠道设计与 Main IPC，留待用户决策。
- 共享技能详情页对 Meka provenance 仅保留文件预览/编辑，隐藏 Cindy SkillHub 的发布、更新、
  卸载和审核状态动作，避免 Meka 本地技能误调用 Cindy IPC；这是对“本地卸载尚待后续增量”的
  明确保护，不改变 Meka 安装或管理弹窗。
- 修正 Meka 技能首页进入共享详情后的返回落点：沿用入口 state 回到 `/cc-agent/meka/skills`，
  不再误跳上游 `/skillhub/local`；四语补齐对应返回文案。
- 决策人：用户要求“基础功能同步、Meka 管理能力保留”；实施人：Codex。验证：插件批量控制器
  新增 Meka adapter 回归测试，插件批量/模型/卡片 62 项与 plugin-market Main/API 52 项通过；
  Desktop typecheck 与 `git diff --check` 通过。技能页面真实 MCPRouter 数据、Light/Dark 实机
  目检和全量 `pnpm test:unit` 本轮未重复执行。

### 5.8 普通对话草稿的协同入口回归（2026-08-05）

- 用户反馈普通对话的 composer `+` 菜单看不到“协同模式”。回溯 `origin/main` 的
  `resolveCollabEntryPolicy` 及其测试确认：普通 Cindy 对话草稿（尚未分配
  `workingDir`）和已创建对话都属于可显示入口，草稿只查询用户/全局协同策略。
- 本地 Meka 迁移提交 `fc7a77b6c` 新增 `canShowMekaCollabToggleForDraft`，其职责是覆盖
  `workspaceKind=meka` 在 Main 分配 cwd 前的资格；合并落地时却把它用于所有草稿，
  把 Cindy 的 `dialogue` 误判为不 eligible，导致 `ChatInput` 没收到
  `collaboration` 配置。该问题是本地合并后的入口断链，不是上游有意删除协同功能。
- 处理：普通 Cindy 草稿继续使用 `collabEntry.eligible`；只有 Meka 草稿使用 Meka 专用
  eligibility。保留 Worker、远程和策略查询边界，不改变协同开启/关闭流程。决策人：用户
  要求检查合并遗漏并修复；实施人：Codex。
- 验证：`collabEntryPolicy` 定向测试、Desktop typecheck、`git diff --check`；未做真实
  Electron UI 点击和 Light/Dark 实机目检。

### 5.9 Meka 插件来源筛选文案缺失（2026-08-05）

- 用户反馈 Meka 插件页来源筛选显示裸 key `settings.ghosts.meka.origin.all`。
- 原因：合并后的 Meka `origin` locale 对象只保留 `public` / `local`，但页面复用了上游
  `RECOMMENDED_FILTERS` 的动态 `all` 来源；四语同时缺字段，所以 fallback 无法提供文案。
- 处理：四语补齐 `settings.ghosts.meka.origin.all`（All / すべて / 전체 / 全部），并增加
  locale 回归测试。未改变筛选逻辑或市场来源边界。决策人：用户报告问题；实施人：Codex。
- 验证：Meka 来源文案回归、`pnpm check:i18n`、`pnpm check:i18n-glossary`、
  `git diff --check`。

### 5.10 最终全量单测复核（2026-08-05）

- 首次并发运行 `pnpm test:unit` 仅有
  `src/renderer/__tests__/unsupportedBrowserPrompt.test.ts` 的 20 秒单测超时；该测试
  单独重跑为 2/2 通过（约 1.95 秒），没有发现 `prompt()` 违规或断言失败。
- 按仓库提供的排查参数重新运行
  `pnpm test:unit -- --workspace-concurrency=1`，全量通过：Desktop 1676 个文件、
  20453 项测试通过（46 skipped），其它 unit workspace 也全部通过。归因是全量 workspace
  并发下的资源/扫描时延波动，不是本次代码或测试行为回归；未修改测试超时或降低覆盖率。
- 随后按提交门禁原始命令再次运行 `pnpm test:unit`，默认并发配置全量通过，确认首次超时
  不可复现，最终提交以这次默认门禁结果为准。
- 决策人：无需产品取舍；实施人：Codex。该结果覆盖此前 5.7 中“全量未重复执行”的旧记录，
  以本节为最终验证事实。
