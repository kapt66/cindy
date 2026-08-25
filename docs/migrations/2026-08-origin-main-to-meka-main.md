# `origin/main` → `meka/main` 同步报告

> 本轮（2026-08-21）在隔离 worktree `C:\Workspace\cindy-upstream-sync-20260821`
> 已启动真实 merge，并已在本隔离分支创建本地 merge commit。基线为
> `HEAD=d17186e42b724791b212bc55437587ce84069c2e`、
> `origin/main=625a7d714f199cb6770b5d1f556bb1f0322e9fbb`、
> `merge-base=58060cd4cde6682cdf0881885f4f9ff6f4489579`；目标侧独有 86 个提交，
> 上游侧独有 1790 个提交。Git 产生的 139 个冲突已按能力组完成语义解决，当前没有
> unmerged path；按用户决定保留 Meka `cindy-protocol` submodule 与 gitlink
> `35fe6bfca4f24046eba0a3ba2826a5079eb0cb8e`。merge 未 push、未创建 PR。

## 1. 范围与基线

- 工作区：`C:\Workspace\cindy-upstream-sync-20260821`
- 目标分支：`codex/sync-origin-main-20260821`（合并目标为 `meka/main`）
- 来源：`origin/main`
- 来源 SHA：`625a7d714f199cb6770b5d1f556bb1f0322e9fbb`
- 目标合并前 SHA：`d17186e42b724791b212bc55437587ce84069c2e`
- merge-base：`58060cd4cde6682cdf0881885f4f9ff6f4489579`
- 执行时间：2026-08-21（Asia/Shanghai）
- 交付状态：冲突和定向验证已收敛，merge commit 已在隔离分支创建，尚未 push 或创建 PR；插件基座仍待白名单批准。

本次只处理客户端仓库已有范围；按用户确认保留 Meka fork 的 `cindy-protocol` submodule
及当前 gitlink，不修改协议子仓源码。未修改服务端仓库或无关存量问题；没有执行
`git merge --abort`、破坏性回退或覆盖主 worktree 的已有改动。

## 2. 决策记录

| 决策 | 决策人 | 结论 |
| --- | --- | --- |
| 两边有效内容都保留，采用语义双向合并 | 用户 | 不使用盲目的 ours/theirs；冲突按产品边界逐组处理 |
| Desktop 新包身份采用 Meka 命名 | 用户 | 采用 `CindyMeka/CindyMekaDev`；旧 `Cindy/CindyDev` 仅做 dev marker 只读兼容，不回退 Meka 安装、数据、协议和更新器身份 |
| 数据库 migration 采用追加方式 | 用户 | 冻结 Meka `0082`-`0091` lineage；上游 schema 和 companion 行为从 `0092` 追加到 `0095`，不改写已发布编号或 checksum |
| 格式、重复 import、类型接口并集 | Agent | 仅处理可证明不改变功能的结构冲突 |
| Agent/IPC、插件权限、身份、远程路由冲突 | 用户定下“双向保留”原则；Agent 按现有产品边界落地 | 保留双方语义并恢复完整边界；没有用类型强转或删除路径掩盖不确定性。若后续行为测试显示真实产品取舍，暂停并回请用户决策 |
| 存量插件迁移时机 | 用户 | 本轮先完成上游同步；迁移入口和兼容验证保留，但不对真实存量插件目录执行迁移，待同步完成后由用户单独决定 |
| 合并后新增代码造成的括号/函数闭合断裂 | Agent | 仅补齐结构闭合并保留双方新增内容；未改变运行时语义 |
| `@` 资源 Provider 运行入口 | 用户 | 接受上游移除两阶段 Provider 搜索、IPC、preload 和权限展示；保留历史 `plugin-resource` 解析、序列化、正文投影与旧 manifest 宽容读取 |
| `cindy-protocol` gitlink | 用户 | 保留 Meka submodule 与原 gitlink `35fe6bfca4f24046eba0a3ba2826a5079eb0cb8e`；不接入上游本地化同名协议包，不修改子仓源码 |

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

涉及 `apps/desktop/drizzle/0082`-`0095`、snapshot、companion script 和 journal。

- 冻结 Meka `0082`-`0091` lineage；上游同编号 migration 不覆盖、不重放，避免改变历史
  runtime identity 或 checksum。
- 上游新增 schema 合并为 `0092_sync_upstream_20260821`，xAI provider provenance、session
  plan 和 media 修复依次追加为 `0093`-`0095`。上游 `0085_skinny_iron_man` 的
  `daily_spend` 重建行为也并入 `0092`，不占用 Meka 已发布的 `0085` 编号。
- companion 使用表/列守卫兼容 fresh DB、Meka 历史库和合成 partial-schema fixture；不删除
  历史 migration，不重写已有 snapshot。

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

### 3.7 `cindy-protocol` submodule 保留（本轮新增冲突）

- 上游提交 `b247c2d32` 将共享协议从 submodule 本地化；Meka 的协议仓仍承载私有扩展和
  独立发布边界，不能用上游同名本地 package 覆盖。
- 最终按用户决定保留 Meka submodule，workspace 只从该 submodule 提供协议包，父仓 gitlink
  保持 `35fe6bfca4f24046eba0a3ba2826a5079eb0cb8e`。本轮不修改协议源码、子仓 remote 或服务端。

## 4. 验证与剩余风险

已执行：

```text
git diff --name-only --diff-filter=U
pnpm --filter desktop gen:help-kb
NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter desktop exec tsc --noEmit --pretty false
```

当前没有未解决 merge marker。已完成的定向验证如下：

- Desktop TypeScript：`pnpm --filter desktop exec tsc --noEmit --pretty false` 通过。
- Desktop 数据库：`pnpm --filter desktop db:validate` 通过；标准 migration replay 8/8 通过。
- Orca 输入队列 294/294、maker-cc-manager 120/120、cindy-tools 68/68、lizi-mcps 18/18、
  maker-core native Skill/远程 MCP 投影 24/24、Mobile 设计契约 10/10 通过。
- Desktop、Mobile、cindy-tools、lizi-mcps 和 maker-cc-manager TypeScript 检查通过；
  maker-core 没有仓库门禁定义的 `typecheck` script。
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

merge commit 已创建但尚未 push；后续提交必须按仓库要求使用 `git commit -s` 并先完成完整门禁。

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

### 5.11 2026-08-21 新一轮上游同步

- 本轮使用新 worktree `C:\Workspace\cindy-upstream-sync-20260821`，从
  `meka/main@d17186e42b724791b212bc55437587ce84069c2e` 启动真实
  `git merge --no-commit --no-ff origin/main`。
- fetch 后来源为 `origin/main@625a7d714f199cb6770b5d1f556bb1f0322e9fbb`，Git 选出的
  merge-base 为 `58060cd4cde6682cdf0881885f4f9ff6f4489579`；目标侧独有 86 个提交，来源侧
  独有 1790 个提交。
- Git 首次列出 139 个冲突：测试 48、产品代码 41、UI 25、数据库生成物 6、治理规则 6、
  本地化 5、构建配置 3、协议/子模块 2、脚本 2、文档 1。全部冲突已按能力域完成三方
  语义解决，`git diff --name-only --diff-filter=U` 为空。
- 上游提交 `b247c2d32` 将共享协议从 submodule 本地化。用户明确决定保留 Meka submodule；
  最终 workspace 只从该 submodule 提供同名协议包，不接入上游本地副本，gitlink 固定为
  `35fe6bfca4f24046eba0a3ba2826a5079eb0cb8e`。本轮未修改协议子仓源码或服务端仓库。

#### 5.11.1 Meka 能力审计

| ID | 能力 | Meka 不变量 | 上游对应变化 | 最终关系与实现 | 状态 |
| --- | --- | --- | --- | --- | --- |
| `CAP-IDENTITY` | 身份、深链与旧数据 | `CindyMeka` / `cindy-meka` / `cindy-meka://`；旧 `xdmaker-meka` 只读迁移 | 区域、认证、正式 profile 和更新生命周期重构 | 接纳上游生命周期；保留 Meka 身份、互操作解析和更新渠道 | 已验证 |
| `CAP-PROTOCOL` | Meka 协议与 MCPR 扩展 | 保留 Meka submodule 和 `mcpr-plugin-capability` | 上游协议包本地化 | 用户决定的保留例外；只保留一套 workspace 包来源 | 已验证 |
| `CAP-DATABASE` | 历史数据库升级 | 已发布 migration/runtime identity 不改写 | 上游 `0086`-`0092` 新 schema、FTS、统计和数据迁移 | Meka `0082`-`0091` 冻结；合并 schema 与 guarded companion 追加为 `0092`-`0095` | 已验证 |
| `CAP-MEKA-PROJECT` | 项目、角色、正式事项 | 草稿和历史任务继续绑定 Meka 项目/角色 | 上游 Draft/Composer、侧栏和 session route 重构 | 在上游 route owner/historyLoaded 与 Composer 状态层上恢复 Meka 投影 | 已验证 |
| `CAP-MCPR-REMOTE` | MCPRouter 远程任务 | `mcpr:<instanceId>` 独立于 SSH；保留目标目录与标签 | 上游 Worker 权限、远程 worktree phase 和生命周期 | 共享 Worker 创建流程，Meka adapter 保留 MCPRouter target/workingDir | 已验证 |
| `CAP-AGENT-ORCA` | Agent/Orca 行为 | Meka combat/runtime/高风险 Host 门禁不降级 | 上游 Review、Provider、队列、Pi 与权限模式 | 重建 `maker-ipc/register.ts`，按契约并集接纳上游并保留 Meka Host 强制边界 | 已验证 |
| `CAP-MEKA-PLUGIN` | Meka 插件渠道 | 独立 ledger/channel、大小与 SHA、staged review、旧批准继续有效 | 上游 receipt、package review、自定义来源与批量更新 | 共享市场/批量控制器；Meka adapter 保留渠道隔离，review token 绑定实际批准和包 SHA | 同步代码已验证；存量迁移待本轮结束后由用户决定，插件基座仍待白名单批准 |
| `CAP-MEKA-SKILL` | Meka 技能与项目角色 | MCPRouter 市场技能不混入 Cindy SkillHub | 上游技能页与导航演进 | 接纳共享 UI/详情行为，保留 Meka provenance、目录和返回落点 | 已验证 |
| `CAP-I18N` | 五语用户界面 | Meka 文案不因新增 locale 丢失 | 上游新增 `zh-TW` 并扩充四语 catalog | 四语结构化上游优先合并；Meka 独有键生成台湾繁中投影并遵守术语表 | 已验证 |

#### 5.11.2 上游变化接纳审计

| 变化 ID | 上游行为 | 能力 | 接纳方式 | Meka 动作与兼容边界 | 验证 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| `UP-20260821-01` | Review/Provider、输入队列和生命周期重构 | `CAP-AGENT-ORCA` | 适配接纳 | 保留 MCPRouter runtime/combat 和 fail-closed Host 门禁 | Desktop typecheck、Orca/IPC 定向测试 | 已验证 |
| `UP-20260821-02` | Worker 权限、route owner、remote phase、Composer 状态层 | `CAP-MEKA-PROJECT` / `CAP-MCPR-REMOTE` | 适配接纳 | Meka 草稿、项目/角色、远程目标和目录标签映射到新状态层 | renderer/Main 定向测试 | 已验证 |
| `UP-20260821-03` | 插件 receipt、实际包权限复核与批量更新 | `CAP-MEKA-PLUGIN` | 适配接纳 | Meka staged review 持久化 `reviewedApproval`，批准时继续绑定 package SHA；不放宽权限；不在本轮触发存量插件迁移 | `updateAllController` 49/49 及插件组定向测试 | 已验证；存量迁移决策延期，插件基座待批准 |
| `UP-20260821-04` | 上游数据库 `0086`-`0092` | `CAP-DATABASE` | 适配接纳 | 生成合并 schema；FTS/统计触发器与数据迁移用 guarded companion 追加，不改历史 checksum | `db:validate`、migration replay 8/8 | 已验证 |
| `UP-20260821-05` | `zh-TW` locale | `CAP-I18N` | 适配接纳 | 保留上游繁中，缺失 Meka 键由简中语义转换为台湾繁中；产品术语固定为“插件” | `check:i18n`、`check:i18n-glossary` | 已验证 |
| `UP-20260821-06` | 协议包从 submodule 本地化 | `CAP-PROTOCOL` | 保留例外 | 用户明确要求保留 Meka submodule；不同时装入上游同名包 | gitlink/workspace 审计 | 已验证 |
| `UP-20260821-07` | 正式 profile migration 写保护 | `CAP-IDENTITY` / `CAP-DATABASE` | 适配接纳 | 启动入口恢复 `XDT_OFFICIAL_SHARED_PROFILE` 和 isolated-on-production 拒绝，错误身份改为 Cindy Meka | policy/dev flags 定向测试 | 已验证 |
| `UP-20260821-08` | Worker provider 与执行目标扩展 | `CAP-MCPR-REMOTE` | 并集接纳 | 创建 Worker 同时保留上游 `provider_id` 与 Meka `working_dir` / `remote_host_id` / `execution_target` | lizi-mcps 18/18、typecheck | 已验证 |
| `UP-20260821-09` | Claude 远端环境与 protocol v4 | `CAP-MCPR-REMOTE` / `CAP-MEKA-SKILL` | 适配接纳 | 恢复 capability bundle ensure/release、revision/thread register、MCP tunnel、`CapabilityMcpRouter`、`mcp-shim`、`codex-bridge` 及关闭清理；bundle 与 protocol 必须精确匹配当前 `0.0.9/protocol 4`，不得以 `>=3` 代替发布 pin | maker-cc-manager 120/120、MCPRouter 跨仓构建探针与 typecheck | 已验证；2026-08-24 修正原报告的宽松表述 |
| `UP-20260821-10` | Claude native Skill plugin 与远程 MCP 投影 | `CAP-MEKA-SKILL` / `CAP-AGENT-ORCA` | 适配接纳 | 本地恢复 `nativeSkillPluginPath` / `nativeSkillRevision`；远端仅投影 `orca_worker_bridge`、`lizi_orca` 到 tunnel 与 in-process MCP | maker-core 24/24 | 已验证 |
| `UP-20260821-11` | Orca 自动报告与队列恢复 | `CAP-AGENT-ORCA` | 适配接纳 | 自动报告可穿过 `active-turn` Retry 但不消费 Retry/error；`queue-head` recovery 继续严格阻塞 | Orca 队列 294/294 | 已验证 |
| `UP-20260821-12` | Mobile session 切换与分享设计契约 | `CAP-I18N` | 完整接纳 | 恢复 session-switch 品牌 loading、conversation-share footer、approved 标记及 wordmark 尺寸间距 | Mobile 设计契约 10/10 | 已验证 |
| `UP-20260821-13` | 共享 session header/menu 与协同重试策略 | `CAP-MEKA-PROJECT` / `CAP-AGENT-ORCA` | 适配接纳 | 恢复 tooltip、包含 archived session 的 fork family 发现和协同 disabled/retry 行为；Meka 继续显示角色 scope，不把 Pi 专属 `exportHtml` / `compact` 注入共享菜单 | Renderer 定向回归 | 已验证 |
| `UP-20260821-14` | 新草稿 worktree 资格与项目选择器重构 | `CAP-MEKA-PROJECT` / `CAP-MCPR-REMOTE` | 适配接纳 | confirmed-ineligible 目录回退 plain session，未完成 probe 时 fail closed；Meka 项目选择器继续只列 MCPRouter 目标 | Renderer/Main 定向回归 | 已验证 |
| `UP-20260821-15` | 侧栏分组与运行时 edition 投影 | `CAP-MEKA-PROJECT` / `CAP-IDENTITY` | 保留例外 | Meka session 保持在普通 pinned groups 之外并位于侧栏既定入口；Login 已改由运行时 edition selector 驱动，不再要求消费 build-region pill keys | source contract 与 sidebar 定向回归 | 已验证 |
| `UP-20260821-16` | Windows 文件身份与测试锁兼容 | `CAP-AGENT-ORCA` | 完整接纳 | symlink 因 `EPERM` / `ENOSYS` 不可用时，PI package-store TOCTOU 测试改用 hard link 继续验证 identity replacement；真实 test-gate 锁测试恢复上游分散端口参数，不改生产锁或跳过测试 | PI security 66/66（另 3 项平台 skip）、runner 454 项 | 已验证 |
| `UP-20260821-17` | 存量插件迁移的可读 demo | `CAP-MEKA-PLUGIN` / `CAP-MEKA-SKILL` | 保留迁移能力，延期实际执行 | 独立 `tsx` 宿主复用正式技能快照 worker；demo 只操作临时副本，不触碰真实用户目录；迁移失败、快照失配、一次性门失效或安装目录被改写均非零退出 | `pnpm demo:legacy-migration`、GhostManager 234 pass / 1 platform skip | 验证完成；用户将在同步完成后决定是否执行存量迁移，插件基座仍待批准 |

#### 5.11.3 数据库与验证事实

- Meka `0082`-`0091` SQL、snapshot 和 companion runtime identity 保持原样；上游新增 schema
  合并为 `0092_sync_upstream_20260821`，上游 xAI provenance、session plan 和 media 修复作为
  `0093`-`0095` 追加。`0092` 对强制 replay 使用 `IF NOT EXISTS` 和表/列守卫；冻结的 Meka
  `0091` 只在完整 Meka sessions shape 上执行重建，合成 partial-schema fixture 无对应外键时 no-op。
- `pnpm --filter desktop db:validate` 通过：`0000..0095` 连续、96 份 journal/snapshot 对齐、
  Drizzle schema 无漂移、32 个 companion 均为 CJS；固定基线 80 条 SQL + 23 个 runtime、
  canonical 基线 92 条 SQL + 28 个 runtime identity 均未改写。
- `pnpm --filter desktop test:migration-replay` 8/8 通过，覆盖 fresh DB、Meka session 历史、
  v39 Orca、v59 重放、旧 lineage bridge、Worker label 归一化和 history side-write 失败路径。
- `pnpm check:i18n` 通过：五语 8232 个 key 一致；`pnpm check:i18n-glossary` 通过，仅保留
  6 个 `status: proposed` 的既有告警。
- Meka 发布身份与写入保护 50/50 通过，覆盖独立 artifact/updater 命名、Windows 旧签名
  服务、macOS Meka 证书、RustFS bucket/prefix 隔离、Claude/Codex/ripgrep runtime manifest
  以及 publish/promote 的 `--execute` / `--yes` 门。插件与技能平行投影 13 个文件、116 项
  通过，覆盖 Meka 批量更新 adapter、独立 channel ledger、包权限复核、下载策略、Meka
  技能 API/source manager 和共享详情页的 Meka 路由/动作边界。
- `pnpm demo:legacy-migration` 首次演练发现独立 `tsx` 宿主没有 Electron 打包后的技能快照
  utility worker 路径：普通 receipt 可迁移，但带技能旧插件被 demo 误报失败；生产
  `GhostManager` 对应旧布局回归本身通过。demo 现显式复用同一
  `ghostSnapshotWorkerProcess` 请求处理器，并把迁移结果、技能快照、一次性门和安装目录
  不变性改为硬断言。修复后市场插件、用户停用插件、带技能插件三类 fixture 全部迁移，
  `GhostManager` 234 项通过、1 项平台 skip。演练全程只使用 `os.tmpdir()`，未读取真实用户数据。
- 末轮定向回归 11 个文件共 302 项通过、3 项平台 skip；PI package-store security 66 项通过、
  3 项平台 skip。Windows 无文件 symlink 权限时只将 replacement fixture 降级为 hard link，
  被测的文件身份变化与 fail-closed 行为不变，没有扩大 skip。
- 根 `pnpm test:unit` 最终完整通过：runner 454 项（447 pass、7 skip），Desktop、Mobile、
  maker-core 及其余全部 required unit workspace 均 PASS。此前三次在 runner 真实锁用例结束，
  原因是冲突落地漏掉上游为该用例提供的 `lockPortStart` / `lockPortCount` / `lockPortStride`，
  导致 Windows 连续动态/排除端口可能全被判为 collision；恢复 `origin/main` 的测试专用
  `10000..39999` 分散候选后通过。生产锁默认范围、串行语义和 `--no-lock` 策略均未修改。
- Desktop、Mobile 和四个受影响 bridge package 的最终 typecheck 通过；较早完成的 cindy-tools、
  lizi-mcps、maker-cc-manager 检查及插件/更新器/深链/Orca 定向测试仍通过。
- Windows 真实 Electron 已通过 `pnpm restart:desktop:remote -- --isolated=@worktree` 在隔离
  profile `upstream-sync-20260821-3d9898` 启动，得到 `DESKTOP_DEV_VERDICT=ready`。首次运行审计
  发现并修复三项合并后运行期断链：未登录 xAI 后台 discovery 在 token 读取处形成
  `unhandledRejection`、Remote SSH pending-upgrade 快照早于 Main handler 注册、Meka `localDb`
  的五组 preload 投影在冲突解决时遗漏。xAI 现在把未登录预热视为 no-op，后台调用另有异常
  边界；Remote SSH IPC 在首个 renderer 窗口前注册；Meka 项目、角色、元数据、技能目录与
  正式流程 bridge 全部恢复，并由 source contract 回归锁定。
- 修复后再次完整重启，启动日志未再出现上述 `FATAL` / `unhandledRejection` / `No handler`
  或 Meka renderer crash。通过 Electron CDP 实际进入本地模式，确认 Meka 助理、SAGA2、
  正式流程和普通对话入口；Meka 项目页成功读取内置 SAGA2。Light 与 Dark 均在 1280x800
  实测，document 尺寸与 viewport 一致、无 renderer console error 或可见重叠。
- Windows x64 版本无关本地产物已由 `electron-forge package` 生成。首次使用 Node 默认约
  4 GB heap 在 renderer production bundle 阶段 OOM；按仓库 Desktop typecheck 同级的
  `NODE_OPTIONS=--max-old-space-size=8192` 重跑后完整通过。产物为
  `out/CindyMeka-win32-x64/CindyMeka.exe`，包内 metadata 为 `productName=CindyMeka`、
  `version=0.0.0`，并包含 `cindy-meka-updater.exe`、ripgrep、Android platform-tools、
  Windows function-key listener、原生 SQLite/PTY 与 sqlite-vec。标准 packaged smoke 和
  `--plugin-storage` smoke 均通过，临时库升级到 schema 95，核心表与 owner-scoped 插件目录、
  安装账本可用。构建产生的 updater 工作树二进制已恢复为 merge index 中的审计版本；
  `out/` 与下载 tools 保持 ignored。未签名开发包只验证构建/启动，不替代正式签名验收。
- 真实旧 `xdmaker-meka` 数据已在 2026-08-22 通过只读来源、系统临时目录目标完成升级
  验证：先用生产 `copyDatabaseVerified` online backup 合入 WAL，再以精确旧 user ID 走
  `runLegacyUserDataMigration`，随后重放 8 条 migration 到 schema 95。迁移前后 118 个任务、
  1848 条消息、2 个 Meka 项目、7 个角色、109 个 Meka 工作区任务和 15 个正式流程任务计数
  一致，`quick_check=ok`；非敏感设置与角色文件完成复制，smoke DB 未被选择。验证未读取或
  输出消息、凭证、邮箱和身份锚内容，未写真实旧目录，临时副本已删除。旧安装包到正式签名
  新包的原地升级仍属于发布验收，不影响本次数据兼容门结论。
- 2026-08-24 按用户要求使用现有 `CindyMeka` profile（非隔离目录）启动已构建的
  `CindyMeka.exe`，实际扫描到 schema 91 的 4 条待执行 migration（0092-0095），并全部
  `apply.ok` 完成到 schema 95。启动后的 worker 报告 `pendingCount=0`、`schemaDrift=clean`，
  `quick_check=ok`；任务/消息/ Meka 项目/角色聚合计数为 6/782/1/2，与迁移前一致。Electron
  CDP 9223 主窗口 `readyState=complete`，实际显示 Meka、插件、SAGA2、正式流程和普通对话；
  启动日志未发现 FATAL、unhandled rejection、缺失 IPC handler、renderer crash 或
  SQLite/migration 错误。应用自动在 profile 保留 migration backup，另有系统临时 online
  backup 作为本次验证的回滚依据；验证实例已正常关闭。
- macOS 尚未实测；插件基座路径必须取得指定放行人的明确 `Approve` 后才可合并。
- 2026-08-24 首轮正式 Canary 验证中，Windows x64 已成功发布；macOS x64 首次在 packaged
  smoke 启动后弹出 `Safe Storage` 钥匙串授权并在 60 秒无结果后失败；人工授权后的重跑
  已由 smoke 正常输出 schema 95 与核心表结果，但随后仍命中下述缺失定义。macOS arm64
  在 Intel Runner 完成交叉构建、drizzle
  校验、Mach-O 校验和整包签名后，因 `hostCanExecArch` 定义在本次 merge 中被删除但两处
  调用仍保留而抛出 `ReferenceError`。arm64 失败发生在 DMG/热更新 ZIP 归集及快捷发布的
  本地复核/上传之前，未改动 arm64 Canary、Stable 或既有版本对象。对照线上 0.0.16 对象
  时间与 Meka first-parent 后确认正式版源码基线为 `d17186e42`：smoke 原本就在最终签名前，
  因此不调整 make、smoke、签名、公证、iOS gate、DMG/ZIP、上传或 manifest 写入顺序。
  当前只恢复同步新增 iOS gate 丢失的架构判定，并以 Intel/Apple Silicon × x64/arm64 四象限
  测试锁定；macOS smoke 子进程增加 `--use-mock-keychain`，与临时 userData 一起隔离产品
  Safe Storage，避免 Forge 临时签名触发钥匙串授权，不跳过 smoke、不延长超时。
- 同轮 Windows 0.0.17 从 0.0.16 热更新时已完成 292539872 字节 ZIP 下载、安装目录替换与
  新进程验证，但新进程读取 Meka 公开 `endpoint.json` 后把有意留空的 `cdnBaseUrl` 拼成
  `/manifest-win32-x64-canary.json`，应用/Agent manifest 全部失败并显示“环境初始化失败”。
  对照 `d17186e42` 确认同步时删除了正式版已有的 `resolveUpdateBaseUrl` 接线；0.0.17 Canary
  已回退到 0.0.16 且热更新对象已删除。当前原样恢复 `XDT_CDN_BASE_URL` → 清单非空
  `cdnBaseUrl` → 烘焙 `VITE_ENDPOINT_MANIFEST_BASE_URL` 的优先级，不修改 updater
  替换/回滚状态机、构建发布分发流程或数据库。现场中更新前 0.0.16 的 migration identity
  报错来自当天候选包已把该机器共享 profile 升至 schema 95 后再用旧版打开；0.0.17 新进程
  未再次报 migration 错误，数据库保护门禁按设计 fail closed，数据未被降级或改写。
- 2026-08-24 修复后，本地发布/公证/架构定向测试 52/52 PASS，Desktop 更新 URL 与 iOS
  Simulator gate 测试 30/30 PASS（另 1 项按平台跳过），`db:validate`、Desktop typecheck、
  `git diff --check` 及全仓 `pnpm test:unit` 均 PASS；Desktop、Mobile、全部 required
  workspace 与 `cindy-protocol` submodule 无失败。本机为 Windows，尚未替代 macOS x64/
  arm64 Runner 的真实签名、smoke、DMG/ZIP 和 Canary 复验；该复验应继续使用现有发布任务，
  不调整签名、公证、上传或 manifest 写入流程。
- 同日基于 `ae07e3a97` 的真实 macOS 复验中，arm64 Canary 已成功；Intel Runner 的 x64
  packaged smoke 使用 mock Keychain 后无授权弹窗并成功输出 schema 95，最终自签名与
  `codesign --verify --deep --strict` 也通过。x64 随后在签名后 iOS Simulator gate 处暴露
  第二个同步遗漏：`ci/lib.mjs` 仍导出 `runIOSSimulatorReleaseGate`，两处调用仍在，但
  `package-desktop.mjs` 的具名 import 被删除，因而抛出 `ReferenceError`。arm64 在 Intel
  宿主按设计跳过该启动型 gate，所以未触发。修复只恢复历史已有 import，并由源码契约测试
  同时锁定“接线存在”和签名后、归集前的原顺序；x64 在 DMG/ZIP 与上传前失败，未写入 x64
  0.0.17 Canary，已成功的 arm64 对象无需回滚或重发。修复后 iOS Simulator 打包/gate
  定向测试 26 项 PASS（另 1 项按平台跳过），发布/公证/架构测试 52/52 PASS；Desktop
   typecheck 与全仓 `pnpm test:unit` 均 PASS。
- 2026-08-25 的下一次 Intel Runner x64 Canary 复验中，packaged smoke、schema 95、最终
  自签名和 `codesign --verify --deep --strict` 均通过；失败收敛到签名后的 static iOS
  Simulator release gate。该 gate 使用了临时 `userData` 但遗漏 `--use-mock-keychain`，
  导致 Electron 子进程等待 macOS Safe Storage 授权，最终被 job 的 SIGTERM 终止。arm64
  在 Intel 宿主按设计跳过启动型 gate，因此不受该遗漏影响并成功完成。x64 未到达 DMG/ZIP、
  上传或 manifest 写入，也未写入已有版本对象；本次修复仅为 gate 临时子进程补回
  `--use-mock-keychain`，不改变线上正式版阶段顺序、正常启动参数、更新器、数据库或用户数据。
- 2026-08-24 在本地 `meka/main` 合并提交 `7eb9757ea61803a9c7c72c39e750681c35c68a8b`
  上按提交门禁重新运行 `pnpm test:unit`：Desktop、Mobile、全部 required workspace 与
  `cindy-protocol` submodule 均 PASS；`desktop`、`@cindy/maker-core` typecheck、
  `db:validate` 与 migration replay 8/8 也 PASS。
- 同一提交随后以共享现有 `%APPDATA%\CindyMeka` profile 执行
  `pnpm restart:desktop:remote --wait-ready`，`desktop:whoami` 返回 `MATCH`，
  `DESKTOP_DEV_VERDICT=ready`。只读核验显示 `migration_meta.schema_version=95`，
  `migration_history` 的 0092-0095 均已落账，新增表/列存在；原 profile 仍可读取 6 个任务、
  782 条消息。该 shared Desktop 进程保持运行供用户手测；本次未 push、未创建 PR、未发布。
- 2026-08-24 在当前 merge commit 上重新启动隔离 Desktop：首轮启动器返回
  `DESKTOP_DEV_VERDICT=ready`，但默认 `desktop:whoami` 暴露出 Windows crashpad
  `/prefetch:4` 被误识别为 userData 后缀。已过滤 `crashpad-handler` 并补回归测试；修复后
  第二轮 PID `73920` 同时通过默认 `desktop:whoami -- --all`（`MATCH`、root/HEAD/ready
  全匹配）、显式隔离 userData、CDP `9222` 和主窗口响应检查。CDP 主页面
  `document.readyState=complete`，viewport `1535x800`、scroll width `1535`，DOM 可读到
  `Meka`、`插件`、`SAGA2`、`正式流程`、`普通对话`；隔离库 migration 日志显示
  `currentVersion=95`、`pendingCount=0`、`schema-drift-repair.no-op`。
- 该未登录隔离沙箱的日志没有 FATAL、unhandled rejection、renderer crash、缺失 IPC handler、
  `SQLITE_ERROR` 或 migration/database error。Device Link 的 `PERMISSION_DENIED` 是未登录
  沙箱按设计拒绝账号能力；DB ready 前的少量 `DbClient not ready` 属于启动竞态，DB ready 后
  完成接管并继续注册 IPC/调度器，Review 入口保留 retry。随后将该 verifier 修复纳入最终
  merge commit `f44b86a3210d9e1366c3f7a12b44726dcc819fc1`，第三轮 PID `58232` 再次通过
  启动器 `DESKTOP_DEV_VERDICT=ready`、默认 whoami `MATCH`、root/HEAD/ready 对齐、CDP
  `9222`、Electron 响应和主页面 DOM 检查；页面显示 `Meka`、`插件`、`SAGA2`、`正式流程`、
  `普通对话`，viewport/scroll 均为 `1280x800`。

#### 5.11.4 全路径接纳完成性审计

- 以 `merge-base..origin/main` 的 3352 条变化路径为全集，首次逐路径比对得到：3055 条
  原样接纳、212 条已经做三方语义整合、85 条结果仍完全等于合并前 Meka HEAD。继续沿调用链
  审计后补接 24 条静默遗漏；隔离验收又将上游 legacy migration demo 适配到当前技能快照
  worker。最终 index 重新按三树逐路径比对得到 3060 条与上游字节/模式一致、231 条同时
  不同于两父线的适配接纳、61 条与合并前 Meka 等值的有意例外，总和 3352。该可复现结果
  取代处理过程中的中间计数；能力级适配另由 5.11.2 的 `UP-*` 表记录，不混入文件等值分类。
- 最终 61 条例外均有明确边界：17 条是 Meka 已发布数据库 migration SQL/snapshot/companion
  冻结历史；36 条属于用户决定保留的 submodule 拓扑（`.gitmodules`、`cindy-protocol`、
  `pnpm-workspace.yaml` 与上游同名本地 protocol packages）；6 条 hook-control 文件依赖当前
  Meka protocol 尚未提供的 message operations、durable request ledger 或 `turn.delivery`
  wire 符号；`remoteSessionMakerMemory.test.ts` 保留 MCPRouter transport 不走 SSH preflight
  的 Meka 契约；`protocol-and-submodules.md` 保留 submodule 权威规则。
- protocol 门控的缺失符号为 `HOOK_FEATURE_MESSAGE_OPS`、`makeMessageOp`、
  `MessageOpResultPayload`、`HOOK_FEATURE_TURN_DELIVERY`、`makeTurnDelivery` 与
  `TurnDeliveryPayload`。本轮没有在 Desktop 私造 wire adapter，也没有修改协议子仓或服务端；
  对应 `ackReactions`、request ledger、`turn.delivery` 及 transport/defaults 测试等待协议仓
  单独授权升级后再接入。

#### 5.11.5 补接的上游行为与 Meka 适配

- Settings 使用上游双栏导航、返回提示、Vision Bridge、stream fade、Pi packages、catalog
  panel 与 query 清理，同时保留账户删除和 Meka 助理设置入口；插件 legacy tab 仍回到
  `/settings?tab=ghosts`。Light/Dark 继续走现有语义 token。
- hook-control 接入失效任务 replacement、共享交互卡/TurnPresenter/出站附件、Telegram cursor
  提交时机、同 session 串行、lane-only 群历史、计划对账、Auto 审批回退、Slack retry 与 Pi
  扩展命令路由；Meka transport 不支持的 wire 能力按上节门控。全目录 18 个测试文件、477 项
  通过。
- 旧数据迁移接入 Electron `original-fs` 读取真实 `.asar`，仍保留 Meka identity anchor、
  smoke DB 排除、SQLite online backup 及设置/角色迁移。Global/CN 正式包继续共用
  `CindyMeka`，未打包开发 profile 使用 `CindyMekaDev`，并接受 `XDT_USER_DATA_DIR` override。
  真实旧数据临时副本已按上述生产路径升级到 schema 95，并通过聚合数据保持检查；深链继续
  只注册 `cindy-meka://`，兼容 provider connect ID 与跨端 `cindy://` 解析。
- Forge 完整接纳上游受管根双向隔离、workdir/realpath 门、stable-parent scaffold、TOCTOU
  防护、Unix mode、required node/icon、Manual 校验与最新作者手册；Meka 开发目录仍可用
  `outputDir` 直接写独立临时卷，`reveal` 与 `channel: 'meka'` 归属语义继续保留。公开作者手册
  因上游 `ios-simulator` 与 Meka `reveal` 同时存在，按实际清单记为十九个卡槽。Forge 与市场
  session boundary 定向测试 78 项通过、2 项平台 skip；插件基座白名单批准要求不变。
- 本轮新增语义组复测：旧数据、region、深链、远程 query/memory 与 Settings sidebar 71 项
  通过；真实 `.asar` 子进程回归包含在内。demo 修复后最终再次执行根 `pnpm test:unit`：
  runner 454 项（447 pass、7 skip）及 Desktop、Mobile、maker-core、Meka protocol submodule 等全部 required
  workspace 均 PASS；串行 `pnpm -r --workspace-concurrency=1 --if-present run typecheck` 的 8 个可运行
  workspace 全部通过。随后再次执行 `db:validate`（96 条 SQL，`0000..0095`）、migration replay
  8/8、`check:i18n` 与 `check:i18n-glossary`，均通过。i18n 仍报告 851 条存量非阻塞提示，术语表
  仍报告 6 处 `status=proposed` 命中；本次同步没有新增违规。
- 最终隔离启动再次得到 `DESKTOP_DEV_VERDICT=ready`。CDP 在 1280×800 实测 Settings 通用、
  Meka 助理、插件和 Pi 扩展 panel，Dark/Light 均无 viewport 越界、可见重叠或 renderer
  exception/console error；主任务页继续显示 Meka 助理、SAGA2、正式流程与普通对话入口。
- 2026-08-22 完成性复审重新 fetch `origin/main`，tip 仍为本次 `MERGE_HEAD`
  `625a7d714f199cb6770b5d1f556bb1f0322e9fbb`。直接从 HEAD、MERGE_HEAD 与 index 三棵树复算
  3352 条上游变化，结果仍为 3060 条上游等值、231 条适配接纳、61 条有意 Meka 例外；没有
  新增未解释分歧。插件/技能 13 个直接覆盖文件 131/131 通过，发布核心门禁 30/30、品牌/
  打包参数/macOS 公证契约补充门禁 36/36 通过。现有 Windows 包的 ASAR 再次确认
  `productName=CindyMeka`，`cindy-meka-updater.exe` 存在；标准与 plugin-storage packaged smoke
  均通过 schema 95。最后一次命名沙箱启动由 `desktop:whoami` 返回
  `DESKTOP_DEV_VERDICT=ready`，CDP 主窗口为 `CindyMekaDev/0.0.0`、1280×800、无横向溢出，
  同时可见 Meka、插件、SAGA2、正式流程和普通对话入口；本次启动日志未命中 FATAL、
  unhandled rejection、缺失 IPC handler、renderer crash 或 SQLite/migration 错误。
