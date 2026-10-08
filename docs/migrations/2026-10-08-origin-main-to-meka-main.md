# 第五轮上游同步：`origin/main` → `meka/main`（2026-10-08）

> 本轮把上游 `origin/main` 的最新提交语义合并进本仓 `meka/main`。
> 上一轮（2026-09-25）报告见 [`2026-09-25-origin-main-to-meka-main.md`](2026-09-25-origin-main-to-meka-main.md)；
> 迁移总账见 [`xdmaker-meka-to-cindy.md`](xdmaker-meka-to-cindy.md)。
> 接纳策略、波次与完成判定见 skill `cindy-meka-upstream-sync` 与
> [`meka-whitelist-verification.md`](../dev-rules/meka-whitelist-verification.md)。

## 1. 基线

| 项 | 值 |
| --- | --- |
| 本仓合并前 `HEAD`（产品线侧） | `20d1f27a9fcac45c0ff6c15c607246edc97575eb` |
| 上游 `origin/main`（上游侧） | `c940ab1903e16f24b249a06857afb27632693237` |
| `merge-base` | `fd73bc91fd3d2dabe680876f5271027630c68752` |
| 上游独有提交数 | **630** |
| 本仓独有提交数 | 177 |
| 上游本轮改动规模 | **2833 文件、`+230571 / −118110`** |
| 本仓相对基点改动规模 | 881 文件、`+150651 / −24897` |
| 合并引入改动文件数 | **2825** |
| Git 冲突路径 | **93**（87 `UU` + 3 `AA` + 3 `UD`） |

`merge-base` 恰好等于**上一轮同步的上游端点**，因此本轮只引入上游在这 630 个提交里的新增内容。

### 1.1 本轮主导上游改动

单个提交 `757d9797d5 refactor(plugins): 移除内置 iOS 模拟器并引导存量用户迁移 (#5412)`
是本轮体量最大、也是冲突面最广的一笔：**322 文件、`+1865 / −89863`**，93 个冲突路径里有
**35 个**被它触及。它做两件事：

1. **整体下线内置 iOS 模拟器**：删除 `packages/ios-simulator-runtime/**`（整个 package）、
   `packages/lizi-mcps/src/ios-simulator/**`、`apps/desktop/src/main/mcp-integrations/ios-simulator*.ts`、
   `apps/desktop/src/main/cindy-brain/{iosSimulatorSlot,iosSimulatorPluginGate}.ts`、
   `apps/desktop/src/shared/iosSimulatorIpc.ts`、`apps/desktop/scripts/ios-simulator-release-gate{,.test}.mjs`、
   `apps/desktop/forge-ios-simulator-helper.ts`、`apps/desktop/scripts/ci/lib.mjs`
   **里 251 行 iOS 专用代码**（**文件本身保留**，其余打包／签名／发布工具仍在；主代理已核对
   `package-desktop.mjs:58-76` 从它导入的 17 个符号全部仍在导出）、
   `.github/workflows/ios-simulator-compatibility.yml`、三份 `docs/ios-simulator-*.md` 等；
2. **引入通用「功能退役」基础设施**：`apps/desktop/src/shared/featureRetirements.ts`、
   `apps/desktop/src/main/cindy-brain/featureRetirementStore.ts`、
   `apps/desktop/src/renderer/features/plugin/RetiredFeatureDetail.tsx`、
   右栏 `retired-feature` 页签、`docs/product-rules/feature-retirements.md`，
   并给出**存量用户迁移引导**（推荐替代插件 `Baguette`）。

**用户裁决（2026-10-08）**：接纳上游这笔退役（不回退、不把 iOS 模拟器恢复成 Meka 独立能力）。
理由与影响登记见 §5。

其余影响面较大的上游改动（非穷举）：`24551276ff`（#5472 侧栏导航改偏好驱动注册表）、
`44f78204d5`（`openSession()` 抽取）、`6ed04a977b`（Claude Agent SDK 升至 `0.3.292` 并同步
`apps/mobile` 的 `react-native` / `expo-video` 等依赖）、`b118ea0b71` 一类 `hook-control` /
`auto-review` 相关迁移。

## 2. 冲突清单与分组

93 个冲突按能力组路由给 14 个并行解冲突任务包（`_analysis/wp-*.md` 为各包原始报告）：

| 组 | 任务包 | 冲突路径 | 结论 |
| --- | --- | --- | --- |
| 治理规则 | 主代理 | `AGENTS.md`、`docs/dev-rules/{repo-map,orca-team-architecture,plugin-security-and-authoring}.md`、`docs/design-rules/design-inventory.md` | §3.1 |
| 数据库谱系（D4） | `wp-db-lineage` | `drizzle/meta/{0120,0121,0122}_snapshot.json`（`AA`）+ 上游新增 4 条 migration | §4 |
| 数据库访问 | `wp-localdb` | `localDb/ipc/{sessions,registerAll}.ts` + 8 个 DB 测试 | §3.2 |
| maker-core | `wp-core-agents` | `packages/maker-core/src/agents/{base-agent,index}.ts`、`{claude-code,codex,pi}/index.ts`、`codex/index.test.ts` | §3.3 |
| maker-ipc / Orca | `wp-maker-ipc` | `maker-ipc/{register,makerSendTransaction,orcaInterAgentDispatcher,orcaLifecycleService,orcaWorkerCreationService}.ts` + 2 测试 | §3.4 |
| maker-host / MCPR | `wp-maker-host` | `maker-host/__tests__/{claudeProviderBridge,piProviderTransport}.test.ts`、`mcp-integrations/mcp-providers.ts`、`mcp-integrations/__tests__/{collabSendOutcome,ios-simulator-artifact}`、`packages/lizi-mcps/src/orca/server.ts` | §3.5 |
| Orca 包 | `wp-orca-pkgs` | `packages/orca-workflow/src/{orca-bridge-mcp,orca-bridge-prompt}.ts`、`packages/maker-cc-manager/{package.json,src/bin/cc-mgr.ts}` | §3.6 |
| 插件（main） | `wp-plugins-main` | `cindy-brain/{index,ghostVisibility,pickSlot}.ts`、`plugin-market/download.ts`、`skillhub/installService.ts`(+测试)、`shared/ghost.ts` | §3.7 |
| 插件（renderer） | `wp-plugins-ui` | `features/plugin/{GhostPluginDetailView,GhostPluginPage}.tsx`、`features/plugin/lib/permissionItemIcon.ts` | §3.8 |
| 侧栏与会话头 | `wp-sidebar` | `sidebar/SidebarTopNav.tsx`、`cc-agent/{CCAgentSidebarUpper,SessionContentHeader,NewMakerDraftRoute}.tsx`、`__tests__/newMakerProjectPicker.test.ts` | §3.9 |
| 布局 / 设置 / 输入 / 错误条 | `wp-ui-misc` | `layout/MainLayout.tsx`、`settings/SettingsSidebarNav.tsx`、`new-chat/ChatInput.tsx`、`chat/{ErrorBanner.tsx,__tests__/ErrorBannerCodexOAuth.test.tsx}` | §3.10 |
| 身份 / 深链 / 打包 | `wp-build-identity` | `main/deepLink.ts`、`maker-shared/src/__tests__/brandIdentity.test.ts`、`forge.config.ts`、`scripts/package-desktop.mjs`、`ios-simulator-release-gate{,.test}.mjs`（`UD`） | §3.11 |
| 工程脚本 / 杂项 | `wp-scripts-misc` | `scripts/restart-desktop-remote.mjs`(+测试)、`main/__tests__/{codexLocalSessions,endpointManifestCache,makerSendToSessionOrdering,agent-island/state,background-task-output/reader,bot-import/host,task-migration/service}*.test.ts`、`task-migration/service.ts`、`mobile/__tests__/mobileRealtimeAsrProvider.test.ts` | §3.12 |
| 品牌与文案 | `wp-i18n` | 五语 `renderer/i18n/locales/*/common.json` | §3.13 |
| 生成物 | 主代理 | `pnpm-lock.yaml`、`meta/_journal.json`、`docs/legal/notices/**`、`apps/desktop/resources/THIRD-PARTY-NOTICES.txt`、`docs/design-rules/design-inventory.md`（GENERATED 区） | §6 |

## 3. 逐组解决结论

### 3.1 治理规则与文档（主代理）

- **`AGENTS.md`**：唯一的冲突是「当前规则索引」列表同一锚点的各自追加 ⇒ **取并集**：
  保留 Meka 的 `meka-skills.md` / `meka-project-metadata-governance.md` 两条索引，
  采纳上游新增的 `im-permission-confirmation.md` / `usage-limit-auto-continue.md` /
  `message-source.md` 三条索引。另按本轮新增能力补一条
  `feature-retirements.md` 索引（退役必须可发现/可解释/可迁移）。
  「Git 与交付」一节里第四轮登记的**保留 Meka 门禁口径**（不采纳上游「提交前验证」放宽）
  原样保留 —— 它是**已登记的刻意偏离**，不是冲突残留。
- **`docs/dev-rules/repo-map.md`**：`## apps/` 表格冲突。采纳上游的表格排版，
  但把 Meka 侧对 `apps/codex-package-bin` 的事实说明（目录分发 runtime、pin
  `tools/codex-package/latest.json`、CDN 两种 manifest 形态）并入同一行 ——
  该行上游没有，删掉会让 repo 地图与真实 `apps/` 目录不符。
- **`docs/dev-rules/orca-team-architecture.md`**：第 3 条同一锚点两侧各自追加一句 ⇒
  **取并集**：保留上游的「Host 为插件 Worker 首次输入做调用内来源复核 +
  `AcceptedCallbackDispatchCancelled`」句，同时保留 Meka 的「auto-bridge Host 回调携带
  `workerId`/`workerSessionId`/terminal status，只有 `done` 终态实际投递后才记『报告已送达』，
  SAGA2 战斗服务器核查据此拒绝跨 Worker 冒领」句。
- **`docs/dev-rules/plugin-security-and-authoring.md`**（5 处冲突）：
  1. 「事实来源」表：以上游表格为基底，并回 Meka 的 `badgeSlot`/`confirmSlot`/`errandSlot`
     事实注释、「装入与更新入口 UI」行（`renderer/cindy-brain/installFlow.tsx`）、
     「Meka MCPRouter 能力」行；**删掉 `iosSimulatorSlot.ts` 引用**（该文件已随退役删除）；
     新增「功能退役登记与迁移引导」行。Meka 侧注释里的 `errandPrefsStore.ts` 全仓不存在，
     已不再引用（存量失真，未扩大范围清理）。
  2. Forge 段：保留 Meka 的「授权代次复验」与「Meka 开发目录独立通道」两段，
     去掉与上游重复的那句，并**采纳上游新增的「插件技能投影到账号私有目录」条**
     （`<状态根>/agent-skills`，Claude 每插件本地 plugin、Codex `CODEX_HOME/skills`、
     Pi 显式 `--skill`；不再写 `~/.agents/skills`）。
  3. §4 能力边界大块：以**上游新的能力分类**为基底（`agent.run` / `cindy.tasks` /
     `workspace.ensureSession` / `agent.errand` 作为旧适配器 + 「任务设置」与新建任务权限口径），
     把 Meka 的硬边界**重实现进新分类**（`cindy.text.oneshot` 的 `NO_CANDIDATE`；
     errand 文本只进 user 消息不进 system prompt；`bypassPermissions` 在协议层不存在；
     工作目录缺省为插件专属对话目录），并保留 Meka 的 `mcpr` 独立 slot 条与
     「媒体目录按有效 `edition` 投影 CN/Global」条。
  4. §4.3：保留 Meka 的 `panel` 呈现 override（Meka 助理设置 → Modal）整段，并把
     **Meka 的 `ios-simulator` 槽整段替换为上游的退役条**（旧记录只用于往返识别）。
  5. Review 清单：**取 Meka 侧**（它是上游版本的**严格超集**，多出「Renderer 字段 id 不得
     当 Secret key／路径」「保险库写失败不 emit、写成功后重新 assessment」与
     **6.5a 路径式 worker 的「操作前检查 → 原子操作 → 操作后复验 → identity-guarded cleanup
     + TOCTOU 边界」**；上游的 6.5/6.6 简写被完全覆盖）。**属刻意偏离**：
     不采纳上游对清单的篇幅收敛，因为它会静默削掉两条真实判据。
- **`docs/design-rules/design-inventory.md`**：冲突全部落在 **GENERATED 区**，不做语义判断，
  由 `node scripts/design-inventory.mjs` 重新生成（见 §6）。
- 另按本轮事实同步：`docs/dev-rules/database-and-migrations.md` 的「编号现状」改为第五轮口径
  （见 §4）；`docs/dev-rules/meka-whitelist-verification.md` 的 WL-2.1/WL-2.2 锚点随上游侧栏重构
  更新、新增 **WL-25**（见 §3.4）；`docs/dev-rules/maker-core-and-agent-behavior.md` 与
  `docs/product-rules/meka-skills.md` 里对本轮被删的 `getShellCommandPolicy` 的表述改为退役口径；
  `docs/migrations/xdmaker-meka-to-cindy.md` 补记 iOS 模拟器退役闭合了第三轮那条 `listen(0)` 缺口。

### 3.2 数据库访问与持久化（`wp-localdb`，10 文件 / 12 处冲突）

- `localDb/ipc/sessions.ts`（唯一语义冲突）：**适配接纳**上游 `44f78204d5` 抽出的 `openSession()`
  （新文件 `sessionOpening.ts`），把 Meka 的创建期预校验结果 `validatedCreateBody`
  （`mekaProjectId`/`mekaRoleId` 校验、`extraDirs` 并集、formal 快照）与 Meka 解析出的
  `workingDir` 喂给它。**取 HEAD 侧会编译失败**：上游已删除
  `ensureProjectGitInitialized` / `readGitSafetySettings` 的 import，工作区零引用。
- `localDb/ipc/registerAll.ts`：**并集** —— 保留 Meka 的 5 条 `registerMeka*` + 采纳上游
  `registerHistoryQueryIpc`；上游删掉的 iOS 模拟器接线（`setSessionRemovalCancelOperations` /
  `setSessionRemovalCleanup` / `cancelSessionOperations` / `cleanupRemovedSession` /
  `reconcilePersistedSessionRuntimes`）**接受删除**，全仓 0 悬挂引用。
- 4 个 fixture 冲突都是「Meka 列 vs 上游新列 `agent_device_id`」⇒ **取并集**
  （`schema.ts:282/287` 两列都在；少一列会让 drizzle 全列展开失败）。
- `dbSlimmingUpgradeOrder.test.ts`：保留 Meka 的「符号优先 + 首次迁移调用必须是回调体」
  强断言（已内含上游新写法），实测 `localDb/index.ts:335/356` 锚点成立。
  `messagesClearRace.test.ts`：采纳上游 `tx`→`exec` mock 形状，并**额外修掉一处无冲突标记的
  自动合并缺陷**（`CREATE TABLE sessions` 被并出重复列 ⇒ `duplicate column name`）。
- **WL-3.6 五条守卫逐条在位**：`sessions.ts:1364`（`ALLOWED_WORKSPACE_KINDS`）、`:1387-1388`
  （取值联合）、`:1389-1456`（创建期 project+role/formal 校验）、`:1731-1744`（resume
  `expectedWorkspaceKind` 接受 `'meka'`）、`:1891-1921`（`sessions:update` 拒绝改成 `'meka'`
  + meka 身份不可变，行为证据 `sessionsUpdate.test.ts:862-903` 在位且文案逐字对齐）。
  tx 层 `localDb/client/tx/types.ts:969` 的第三轮 `'meka'` 补丁未被断开；
  `localDb/**` 全量逐文件比对 `HEAD:` ↔ 工作区，**`meka` 出现次数零收缩**。
- **本轮新发现的方法论（重要）**：这次合并的冲突边界上出现了**「并集/吞行且不留冲突标记」**
  的形态 —— 已用「导出 index 三阶段 + 重跑 `git merge-file`」复现两例：
  (a) `messagesClearRace.test.ts` 并出重复列（已修）；
  (b) `sessions.ts` 里 Meka 的 9 行 `const resource…/else await insert();` 在冲突段内整块消失
  （复跑 `git merge-file` 输出与冲突工作区逐行一致 ⇒ 是 git 自身合并输出，不是编辑残留；
  已按 Meka 语义补回）。这类缺陷 `--diff-filter=U` 与标记扫描**都抓不到**，
  只能靠 `pnpm audit:merge` 的 DROPPED 行级判定（见 §5.1）。
- **存量缺口（未擅自扩大范围）**：`sessionsRestoreIfArchived.test.ts:71-75` 的
  `ExpectedIdentity.workspaceKind` 联合（两侧同源）不含 `'meka'` ⇒ resume 侧 `'meka'` 接受
  无覆盖。登记待裁决。

### 3.3 `packages/maker-core` Agent 行为（`wp-core-agents`，6 文件 / 9 处冲突）

- `base-agent.ts`：`resolvePiNativeProviders` 加 `purpose?: 'startup'|'preview'|'live-refresh'`
  ⇒ 接纳上游；`getMcpToolApprovalPresentation` / `codexHostDynamicToolProvider` /
  `getShellCommandPolicy` 三个声明 ⇒ **接受上游删除**（随 iOS 模拟器退役整块删，
  两个接口与 import 已被 git 自动删掉）。
- `agents/index.ts`：两侧各加了一行**完全相同**的 `export { classifyShellCommand }` ⇒
  留双份是 Duplicate export，去重保留上游那行（真实消费方是上游新代码
  `remote-agent/executor/gate.ts:19`），保留 Meka 的 `HostToolExecutionContext/Decision`，
  接纳上游 `ToolLoopReview*` / `ToolLoopEvidence`。
- `claude-code/index.ts`：**并集** —— 上游 hosted 感知 `settingSources` + Meka
  `plugins: [{ type: 'local', path: opts.nativeSkillPluginPath }]`。
- `codex/index.ts`：两个冲突点是**上游自己**的 host shell policy 调用点（本仓只扩了 ctx），
  随上游整条通道删除；git 已在非冲突区自动应用同一删除 ⇒ 冲突块整块删除，不留半套。
  另**接纳上游 `faeedf0dc7`** 删掉 `botRuntimeProfile` 的 `agents.enabled: false`
  （与本仓 `cindy-bots-runtime.md:210/625` 口径一致）。
- `codex/index.test.ts`：删 1258 行上游 iOS shell policy 测试块（本仓只做了 9 行断言适配）；
  本仓实质新增（**F1/F2 原生子代理门禁 166 行**、MCPR 远端凭证、SkillsExtraRootsSet 用例）
  都在非冲突区，保留。
- `pi/index.ts`：imports 并集；startup 装配冲突是上游 `337aaac66b` 的 managed-skill 重构
  （`getManagedSkills` + bot grants + symlink root）vs Meka 的宿主技能快照挂载
  （`nativeSkillPluginPath`）—— 两者来源**正交** ⇒ 采用上游单一 argv 结构，
  把 `resolvePiHostSkillMount(...)` + 告警放回 try 前，`hostSkillMount.skillDirs` 作为显式
  `--skill` 注入上游 argv（排在项目 Skill 之前）。**Pi 非退化红线：只做加法，
  未新增任何拒绝/指纹/审批门。**
- **红线复检（第四轮「codex 原生子代理硬关」）仍然成立、未被上游覆盖**：
  `codexNativeSubagentsDisabled` 来源 `codex/index.ts:4966`；host key 隔离
  `:486/:493-495/:567/:571/:575/:582`；**独立于 hostPurpose 三元树**的传递
  `:5035`（`resolveSessionHostKey`）/`:5081`（`prepareCodexExtraSpawnConfig` ctx 独立 spread）；
  thread 级重申 `:6390 ...(codexNativeSubagentsDisabled ? { 'agents.enabled': false } : {})`
  由 `:6475` 下发；`thread/start` 走 `:6927`（params `:6916`）、`thread/resume` 走
  `:7055`（`:7042`）/`:7433`（`:7424`）/`:7491`（`:7488`）；用例 `codex/index.test.ts:5604-5631`
  的 `it.each` 覆盖 start/resume 两条 + 反例 `:5634-5652`；Desktop 消费端
  `maker-host/index.ts:1799` 与其测试自动合并保留。
- **自动合并审计**：对 `agents/**` 21 个 Meka 改动文件做「Meka 新增行是否仍在合并结果」逐行检查
  ⇒ 除有意删除的 3 组（共 10 行）外 100% 命中（`codex/index.ts` 94/94、`pi/index.ts` 16/16、
  `claude-code/index.ts` 22/22）；`getMcpToolApprovalPresentation` /
  `codexHostDynamicToolProvider` / `createIOSimulator*` 全仓零残留。
- **主代理收口**：`maker-host/index.ts:1760-1763` 的 Meka stub `getShellCommandPolicy: () => undefined`
  在 `AgentDeps` 删除后成为 `new CodexAgent({...})` 的 excess property（TS2353）⇒ 已删除该 stub
  与注释；两份引用它的文档改为退役口径（见 §3.1）。

### 3.4 `maker-ipc` 运行时与 Orca 路由（`wp-maker-ipc`，7 文件 / 16 处冲突）

- `register.ts`：`reconcileCreateOptsAgainstDb` 保留本仓的 helper 化重构
  （`sessionCreateReconciliation.ts` + WL-3 的 workingDir/workspaceKind/mekaProjectId/mekaRoleId
  校正），并把上游新增的 `agentDeviceId`/`remoteHostId` 取数与「换电脑就地落地」逻辑并入
  `readRow`/`applyRow`；deps 采纳上游 `steerStoredQueuedMessage`/`moveQueuedMessage`，
  `sendAutoBridgeToLead` 用本仓 5 参签名（与自动合并后的 `orcaTeamService.ts` 接口一致）。
- **WL-4 承重块**：`register.ts:13058-13068 getProviderRoutingContext` = 上游 `agentDeviceId`
  换电脑分支 **+ 本仓 transport 分类**。上游原式 `agent === 'codex' && remoteHostId` 会把
  `mcpr:` 送进 SSH-only 的 Codex 清单探针 ⇒ 必须保留分类前置。
- `makerSendTransaction.ts`：保留本仓 `preparedHooks` 的 onAccepted 结构，完整并入上游
  `agentMeta.sourceDevice/sourcePlugin` 与 `AUTO_REVIEW_DELEGATED_CONTINUATION` 三级判定。
- `orcaInterAgentDispatcher.ts`：整体接纳上游 `delivery=steer` 插话状态机与 `AUTO_REVIEW_*` 导入，
  额外保留本仓 `workerSessionId?` 字段（`register.ts` 调用面需要）⇒ 与 `orca-bridge-mcp.ts`
  的 deps 接口取并集（见 §3.6）。
- `orcaLifecycleService.createWorker`：**保留例外（刻意分歧）** —— 本仓 `aa930890ab fix(meka):
  make MCPRouter projects directly usable` 让无 active team 时就地 `startTeam`（+团队回滚），
  上游是 `NOT_FOUND`；与上游新增授权链（`getWorkerPermissionModeOverride` / `assertCurrent` /
  `assertCreatedCurrent` / `createWorkerInTeam` guard / rollback）**合成单一实现**，
  两侧测试语义同时成立。**已按白名单机制补登记为 WL-25**（清单外差异必须先登记才构成「需要保留的差异」）。
- `orcaWorkerCreationService.ts`：本仓 `workerRemoteHostId` + Meka 绑定块 + 上游 `agentDeviceId` 行。
- **WL-4 锚点新行号（实测）**：`ensureRemoteReadyForSessionStart`=8107 内 mcpr guard=8171
  **先于** `ensureRemoteHostReady`=8187（Pi 拒绝 8180）；turn-settled holder 3715/8369、
  mcpr 过滤 8377；Meka 远端 bundle 块 7559-7609（legacy SSH 明确抛错 7569、bind 7578、
  release 7600/7609）；`applyMekaRuntimeConfig`=7462；模型路由探针分类=18879；
  `getProviderRoutingContext`=13058-13068；worker 接线 12891/13036/13039/13076/13080。
  `meka-injection/**` 合并**零改动**。
- **不跑测试的替代取证**：手工复算 `remoteSessionMakerMemory.test.ts` 全部 **11 条** `indexOf`
  不变量（全成立），并逐条复核 6 个依赖本包文本的源码级用例锚点次序。
- **iOS 模拟器残留**：本包文件内已清零（`channels.ts` 自动合并 0 残留、无
  `iosSimulatorHandlers`/`ios-simulator.js`/`ios-simulator-runtime` 引用）。包外残留见 §3.11。

### 3.5 Agent Host / MCP 集成 / MCPRouter（`wp-maker-host`，5 文件 + 1 `UD`）

- `claudeProviderBridge.test.ts` / `piProviderTransport.test.ts`：**导入并集** ——
  上游加 `buildUserProvider`/`invocationModelRecord`/`NATIVE_BRIDGE_SESSION_HEADER`，
  本仓加 `listenOnFetchSafePort`（Fetch bad-port 类级修复取代了 `once`）；**不收上游的 `once`**
  （工作区无 `once(` 调用）。
- `mcp-integrations/mcp-providers.ts`：**接受删除** `resolveIOSSimulatorAccess` dep 字段
  （唯一注入点同被删）。
- `mcp-integrations/__tests__/collabSendOutcome.test.ts`：**接受删除** mock 里的
  `cindy_ios_simulator → 'ios-simulator'` 分支。
- `packages/lizi-mcps/src/orca/server.ts`：**接纳上游** `wakeKind: 'resumed' | 'already-active' |
  'queued' | 'steered'`（#5515 超集，与工作区已自动合并的 `delivery`/`steerFallbackReason` 一致）。
- `UD` `mcp-integrations/__tests__/ios-simulator-artifact.test.ts`：**接受删除**。
  5 个用例全在 `describe('packaged iOS Simulator sidecar artifact verification')` 内；
  本仓 `9ee5f7522f` 新增的 5 行断言保护的是**已随退役从 `ci/lib.mjs` 删除的导出**，失去意义。
- **WL-4 存在性证明**：WL-4.1.4 ✅ `maker-host/index.ts:1392` 分类 → `:1393 openMcprTunnel` →
  `:1394-1411 openCcManagerSession({stream, transportId, …})` 整体**先于** `:1417` SSH pool +
  `:1419 remote ssh host not ready`；WL-4.1.5 ✅ 三项齐（`:2214-2225 createMcprCodexTransport`
  + `[MCPR_INSTANCE_NOT_READY]`；`:2261 resolveRemoteCodexCredentialMode` → `'gateway-key'`，
  消费端 `maker-core/src/agents/codex/index.ts:4947`；`:2090/:2109 routeCodexThreadRegister/Unregister`）；
  WL-4.1.9 ✅ 8 个 Pi 钩子首句各一次 `assertMcprHostSupportsAgent('pi', …)`，
  `index.ts` 内 12 处 `getRemoteSshPool().get(remoteHostId)` **12/12** 都有前置分类。
- **Meka 新能力（`5f00e43666`）完好**：`mcpr-tunnel.ts:57` 的 `bundleVersion` 头、
  `send-outcome.ts:93/102` 的 `createHostSendFailure → projectCcMgrRuntimeVersionMismatch`；
  相关文件本轮**完全无变更**。
- **静默风险**：59 个 Meka 改动文件逐行存活扫描 ⇒ 56 个 missing=0，余下 3 个各缺 1 行，
  正是上述三处有意取代；`ToolApprovalPresentation` 全仓零引用；`PLUGIN_ID_TO_MCP_ID` 14 项
  与 `CreateLiziMcpProvidersOptions` 键集合逐项一致。

### 3.7 Meka 插件基座（main 侧，`wp-plugins-main`，7 文件 / 17 处冲突）

- `shared/ghost.ts`：`GhostPermissionItem['kind']` = `| 'reveal' | 'workspace' | 'mcpr'`
  （**删 `ios-simulator`**，保住 Meka 的 `reveal`/`mcpr`）；`ghostContentKeys` 保
  `slotMcpr`/`slotReveal`、删 `slotIOSSimulator`（自动合并的 `ghost.test.ts:4007` 断言的正是
  「不产出」）；删 `iosSimulatorIpc` 导入；`LEGACY_GHOST_SLOTS` 与 `manifest.iosSimulator`
  **保留**（上游保留，用于旧 receipt 往返与 `ghostManifestToAuthorFormat`）。
- `cindy-brain/index.ts`：接受删除 `getIOSSimulatorPluginAccessDecision`（全仓仅此一处引用）；
  接纳上游 `case 'feature-retired'` → `PRECONDITION_FAILED`；最大冲突块是「Meka 开发目录装入机制
  （`inspectDevelopmentPackage`/`installDevelopmentPackage`/`updateDevelopmentPackage`/
  `MekaDevPluginManager`/7 个 `meka-dev-plugins:*` handler）」vs 上游 `MobilePluginPages` 组装
  ⇒ **两块并存**（Meka 块在前，`mobilePluginPages` 赋值随后，`scheduleGhostSkillReconcile()` 不变；
  两块的 deps 逐项核对匹配）。
- `cindy-brain/ghostVisibility.ts`：上游 retirement 门 + Meka `resolveGhostId` 别名解析。
- `cindy-brain/pickSlot.ts`：directory 模式采用上游 `{ghostName,purpose,ghostId,mobilePageId?}`；
  `file` 模式（Meka 扩展）保持 `{ghostName,purpose}` 契约 ⇒ 上游 `pickSlot.test.ts:101-105`
  与 Meka 的 `:131` **同时成立**，无需改动那个自动合并成功的测试文件。
- `plugin-market/download.ts` + `skillhub/installService.ts`：采用上游共享下载器 `download()`，
  同时保住 Meka 的 `PluginDownloadOptions{maxBytes,onProgress}`（渠道上限现在传给下载器
  `maxBytes`）、`{downloadedBytes,totalBytes}` 进度语义、`SkillInstallSource` 第三参与
  `distribution` 归属；Meka 的 `refreshSourceAvailability()` 全部还原到原有语义位点
  （尤其「下载后、装前」那一处特意从冲突区移回 `checkPost-download` 位置，
  保住「下载期间账号/路由漂移即取消」）。
- **存量插件兼容红线**：**未引入任何要求重装/重新确认/重新配置的改动**。唯一受影响者
  =内置 iOS 模拟器，走上游既有退役链路（`featureRetirements` 单条 `embedded-ios-simulator`
  + replacement 引导、receipt 仍 approved 且 `enabled: true`、`migrateLegacyApprovalsOnce`
  自动补批准）；其余内置插件未被连带打断（`builtin-plugins`/`plugin-registry`/`types`
  自动合并后仅测试断言「不得存在 ios-simulator」）。
- **上一轮两个 P0 复核：仍是已修复状态，本轮上游没有再加必填参数**：市场
  `install(id, options, context)` 三个调用点全满足（`registerIpc.ts:288` 上游插件页、
  `registerIpc.ts:403` **Meka 渠道**带 `consent` + `operationId` 进度、`agentTools.ts:90`）；
  `skillhub install(p, onProgress, source?)` 两参与三参调用点（`registerIpc.ts:1184`、
  `meka-skills/service.ts:192`）都兼容；`installAndDock` 5 个调用点全带 `consent` +
  `expectedPackageSha256`。
- **命中插件基座白名单批准门**（`plugin-security-and-authoring.md` 明列
  `main/cindy-brain/`、`main/plugin-market/`、`shared/ghost.ts`）⇒ 需放行人在 PR/推送前明确 Approve。
- **静默风险**：能力组内自动合并成功文件的 `meka/Meka` 标记数与 `HEAD` **逐一相等**
  （`GhostManager.ts`、`forge.ts`、`plugin-market/service.ts`、各 slot、
  `electronSandboxAdapter.ts` 等），无整块静默丢失。

### 3.8 插件 UI 投影（`wp-plugins-ui`，3 文件 / 9 处冲突）

- `features/plugin/lib/permissionItemIcon.ts`：删 `'ios-simulator': Smartphone` 与
  `Smartphone` import（上游退役），**保留 Meka `reveal: FolderOpen`（`:49`）与
  `mcpr: Network`（`:56`）及不变量注释**；仍是唯一共享图标表。
- `GhostPluginDetailView.tsx`：5 块逐一合并 —— 取上游（`IOSSimulatorPreferences` /
  `detail.hostCapability==='ios-simulator'` / `primaryAction==='capability'` /
  `detail.hasErrand` 全删、`hasGithubConnection` + gh 账号卡 + `PluginTaskPrefs`、
  上游新 section 布局），保留 Meka（`updateProgress` + `PluginMarketProgressContent`、
  `hasPanelPresentationPreference` + `PluginPanelPresentationPreference`（搬进上游新 div）、
  `onOpenPanel` 直达按钮、`development`/`displayId`/`minCindyVersion`）。
  上游侧该文件与 `origin/main:` **逐字节相同**，且 Meka 本轮没改过它 ⇒ `detail.hasErrand`
  等按上游删除无实质损失（`hasTaskPreferences ⊇ hasErrand`）。
- `GhostPluginPage.tsx`：`marketUpdate` 两侧条件不互斥 ⇒ 合并为
  `development || ghost.retirement ? null : pluginUpdateForInstalledVersion(marketItem)`
  （Meka dev 装入项与上游退役项都不给市场更新）；保留 Meka「从目录装入」菜单项，
  class 改用上游共享下拉默认外观（**不回退** Meka 复刻长 className —— 第四轮已登记该外观变化）。
- **连带修复（主代理）**：Meka 独有的 `features/plugin/MekaDevInstallReview.tsx` 仍留第二套图标表
  `KIND_ICON` 的 `'ios-simulator': Smartphone`（+ import）—— 按最终联合体必然 typecheck 失败；
  已删该两行（文件内 `Smartphone` 无其它引用）。
  > 已知存量缺口（未扩大范围）：`MekaDevInstallReview.tsx` 与 `permissionItemIcon()` 仍有若干
  > Meka 专属映射差异（`badge→BellDot`、`nodeSecret→KeyRound`、`main-view→PanelLeft` 等），
  > 统一收口需先裁决，本轮未动。
- **双模式**：未新增任何颜色；Meka 菜单项颜色改由共享 DropdownMenu 的 `--cmd-palette-*` token
  提供 ⇒ 双模式「实现」成立；**Light/Dark 均未实机目检**。
- 命中插件基座白名单批准门（与 §3.7 同）。

### 3.9 Meka 侧栏与会话头（`wp-sidebar`，5 文件 / 14 处冲突）

上游 `24551276ff`（#5472 侧栏导航改**偏好驱动注册表**）把 `SidebarTopNav.tsx` 整体重构成
`useSidebarNavigationActions` / `orderedNavigationRows` / `SidebarRailNavigation` /
`SidebarNavigationCustomize`，删掉了 `automationsRow`/`pluginsRow`/`botsRow`/`mainViewRows`
与 `mekaRow` 所挂的旧结构。按「上游结构为准 + Meka 重实现」：

- **WL-2.1 ✅**：保留 `mekaRow` 符号（`SidebarTopNav.tsx:504`）与 `onMekaMatch`（`:476`），
  把它 **splice 进 `orderedNavigationRows`**（`:603`，紧随 `automations`；`automations` 被隐藏时
  顶到最前）⇒ scrollable 段与 all 段**两处渲染分支都含 Meka**（旧版的 `:189`/`:232`
  两处独立分支已被新结构取代）。
- **WL-2.2 ✅（位次变更，已登记）**：`SidebarRailNavigation` 新增可选 prop `mekaEntry`
  （`SidebarTopNav.tsx:369/375`、定位 `:400 mekaTileIndex`、渲染 `:431-433`），由
  `CCAgentSidebarUpper.tsx:4244-4250` 注入（`onMekaMatch` + `SidebarIconButton` +
  `BriefcaseBusiness` + `active={Boolean(onMekaMatch)}` 仍在原文件）。旧口径「在
  `GhostMainViewNavEntries`（rail）之后、插件 rail 入口之前」在 tile 顺序归用户偏好的新结构下
  **不可表达**，现改为「紧随自动任务之后」——与展开态 `mekaRow` 同一条排序规则，两形态保持对称。
  已同步更新 `meka-whitelist-verification.md` 的 WL-2.2。
- **WL-2.5 ✅**（`MekaAssistantSection` 偏移 160499 < `PinnedSection` 162342 <
  `ProjectsSection` 165970）；**WL-3.1 ✅**（`nonMeka*` → `allGroups`/`allProjectGroups`/`groups`/
  `groupsWithPinnedProjects`/`unfilteredProjectSessions` 逐条在位，另做「ours vs 合并后」Meka 行
  diff，**无一行被吞**）；**WL-3.5 ✅**（三处条件逐条在）；**WL-1.7 ✅**（`useMekaConfigGate.ts`
  0 冲突、`:46` 跳转原样；两条发送路径 `:4027`/`:5207` 的 `checkAndConfirm` 前门在）。
- `NewMakerDraftRoute.tsx`：两处 `createSession` **取并集** —— Meka 的 `workspaceKind:'meka'`
  + project/role/formal 字段 **加上** 上游远程 Agent 的 `agentDeviceId`；`handleDeviceChange`
  保留 Meka 的 MCPR 守卫（测试 `newMakerProjectPicker.test.ts:778` 逐字要求）。
  主代理复核 `rightOfPermissionControl` 透传仍在（`:6303`），与 `ChatInput.tsx:669/1219/9132`
  声明-解构-渲染三处对齐。
- **`Bot` import 更正（登记）**：合并后 `SidebarTopNav.tsx` **不再**直接 import `Bot` ——
  上游把伙伴图标搬进 `sidebar/sidebarNavigationPrefs.ts:2,20`
  （`SIDEBAR_NAVIGATION_ITEM_ICONS.bots = Bot`，该文件 0 冲突）。**历史回归的实体没丢，承载文件变了**；
  补回 `Bot` 只会变成未使用 import。文件头 `:29-31` 有对应注释。
- **「自定义」草稿面板期间 Meka 行不常驻**（沿用上游：面板取代所有导航行）；
  「侧栏显示设置」的全局菜单不作用于 Meka 段（WL-3.4 不变）。均属上游继承行为。
- **静默风险**：sidebar/cc-agent 组内只有本包 4 个文件有冲突；
  `MekaAssistantSection.tsx`/`SidebarHeaderActions.tsx`/`useMekaSessionScope.ts`/
  `lib/sidebarProjectVisibility.ts`/`lib/collaborationEligibility.ts` 全 0 冲突且其依赖的
  10 个共享导出逐一核实存在；`onlineDeviceSectionIds → hasSettledOnlineDeviceSection` 是上游有意替换。

### 3.10 布局 / 设置 / 输入 / 错误条（`wp-ui-misc`，5 文件 / 8 处冲突）

- `layout/MainLayout.tsx`：两处均为两侧独立新增 ⇒ 全留（上游 `sharedTaskInvitation`/
  `invitationSequence`/`JoinSharedTaskDialog`（`8ecf37cbe5`）+ `ghosts.onRetirementOpen` +
  `useAgentIslandRemoteSessionsSync`（`757d9797d5`）；Meka `MekaRouterConnectDialog` 的
  3 个 state + `onOpenLogin` 订阅 + `reportLoginState('presented'/'cancelled')` + 挂载点）。
  无竞争状态机。
- `settings/SettingsSidebarNav.tsx`：`TAB_ICON` 是 `Record<VisibleSettingsTab,…>`，键集必须与
  `TAB_IDS` 全等 ⇒ 上游 `'shared-tasks': Users` 与 Meka `'meka-assistant': MessagesSquare` 都留
  （机器核对 20/20，missing=∅ extra=∅）。
- `new-chat/ChatInput.tsx`：删掉两条 merge-base 既有、已被上游搬到
  `hooks/useAttachments.ts:577` 与 `ComposerAttachments.tsx:139,176` 的 import（本文件已无调用点）；
  **接受上游 `useAvailableAgents(catalogDeviceId)`，在其上重实现 Meka 的 Pi×MCPR 收窄**
  （`mcprRemoteTarget`/`effectiveRuntimeVendors` 供 `unifiedAgents`）——
  上游删了 `resolveMcprEngineSurface` 且无等价承载点，这是必须保留的 Meka 能力。
- `chat/ErrorBanner.tsx`：上游 `isAccountBoundaryPending`（`11a5ae2596`）与 Meka
  `ccMgrVersionMismatch` 是同一 if 链上的**互斥 `else if`** ⇒ 全留。
- `chat/__tests__/ErrorBannerCodexOAuth.test.tsx`：冲突形态是「两个 `it()` 交错、共用一个 `});`」
  ⇒ 两条用例各自补回收尾。
- **WL-1.1 位置证明**：`lib/tabLabels.ts:40` 的 `'meka-assistant'` 在 `providers`(39) 与
  `billing`(41) **之间**（该文件自动合并成功；上游 `'shared-tasks'` 落在 `:58` 未挤动）；
  `:16` 类型联合、`:82` key；`SettingsSidebarNav.tsx:78` 图标；`SettingsView.tsx:217-227`
  过滤器不含它 ⇒ 恒常驻；五语 label 齐全（`common.json:544`）；门禁
  `lib/__tests__/tabLabels.test.ts:6-14`。
- **WL-4.1.6 全链完好**：marker `packages/maker-shared/src/ccManagerRuntimeVersion.ts:26`
  + 判定/解析 `:63/:74/:84`；包出口 `packages/maker-shared/package.json:18`；
  唯一规约点 `maker-host/send-outcome.ts:93 createHostSendFailure → :102
  projectCcMgrRuntimeVersionMismatch`（本轮未改动）；渲染层 `ErrorBanner.tsx:191-193` + `:400-404`；
  五语 `chat.errorBanner.ccMgrVersionMismatch` 均含 `{{client}}`+`{{server}}`；
  行为用例 `:150-166`。
- **静默风险（量化）**：对 `git diff HEAD -- apps/desktop/src/renderer`（91,549 行）的删除行做
  大小写不敏感 `meka|mcpr|cc-mgr|ccmgr` 匹配 ⇒ 命中 10 行，**全部落在 3 个可见 `UU` 文件**
  （`SidebarTopNav.tsx`、`CCAgentSidebarUpper.tsx`、`newMakerProjectPicker.test.ts`，均属 §3.9），
  **自动合并成功的文件零命中**。
- **双模式**：本次改动不含任何新增颜色/样式/条件补丁，仅新增一个走语义 token 的图标键 + 文案
  ⇒ 按结构满足「同时实现」；**未实机目检**。

### 3.13 i18n 五语 locale（`wp-i18n`，5 文件 / 32 处冲突）

做法是**逐 key 三方合并**（`ours==base ⇒ theirs`／`theirs==base ⇒ ours`／两侧都改才按规则裁决），
不从冲突块整体选边。

- **iOS 退役五语同步删除 164 个 key**（1 个手工删的 `slotIOSSimulator` + 163 个随上游删除的），
  零孤儿；接纳上游 `settings.ghosts.retirement.*`（21 key，含 `embeddedSimulator.*`）等新增。
- **`settings.ghosts.contents`**：删 `slotIOSSimulator`，保留 `slotWorkspace`/`slotMcpr`/`slotReveal`。
- **`settings.ghosts`**：本仓 `meka` + `reapproveConfirm` ∪ 上游 `retirement.*`。
- **`login`**：本仓 `realmSelector` ∪ 上游 `rateLimit.*`（5 key）。
- **`taskMigration`**：`limits` 取本仓 `{{appName}}`（WL-3.7 + `i18nBrandPlaceholder.test.ts:79`）；
  `device`/`project` 与新增 `dialogue`/`newProject` 取上游；**`defaultFolder` 取本仓
  （上游删除 ⇒ 保留例外）**，因为 `i18nBrandPlaceholder.test.ts:80` 断言它五语渲染含 `BRAND_NAME`
  —— 删 key 会让该 Meka 门禁变红；这是**有意保留的孤儿 key**，已在报告登记。
- **`logic.errors.hostShellCommandBlocked`**：两侧都改且不同 ⇒ 取本仓（WL-3.7 明文；
  证据 `errorMessageRestore.test.ts:39-45`）。
- **唯一「两侧改了同一文案」的 key 就是它**；其余冲突都是两侧各有新增。
- **重复 key 陷阱（en）**：本仓把 `usageDetails` 的 5 个 duration/performance 键移到了对象尾部，
  上游在**同位置新增** 2 个键 ⇒ 整块取上游会让那 5 个键重复定义（`JSON.parse` 静默吃掉一侧）。
  已按「只取上游 2 个新键放上游位置」解决。
- **主代理独立复核**：5 个 locale 全部 `JSON.parse` 通过、无冲突标记；key 数
  en=11919、其余各 11889，差异 **30 个**且**全部是复数 `_one` 后缀**（en 有 one/other，
  ja/ko/zh-CN/zh-TW 只有 other），**非复数键零缺失**。
- **`meka.*` / `settings.ghosts.meka.*` / `slotMcpr` / `slotReveal` 一律以本仓为准**，
  未与上游 `sidebar.*` / `settings.ghosts.*` 合并；品牌走 `{{appName}}`，未被写死 `Cindy` 覆盖。

### 3.11 身份 / 深链 / 打包（`wp-build-identity`，4 文件 / 6 处冲突 + 2 `UD`）

- `main/deepLink.ts`：**保留 Meka 身份红线** —— `DEEP_LINK_REGISTERED_SCHEMES`
  （`cindy-meka` + Meka 历史 scheme；**上游 `cindy://` 只解析、不注册**，`:584` 的注释逐字仍在），
  并**收养**上游的 `let registered` / `registerWindowsDeepLinkName`；上游 `shared-task-join`
  全链路已自动并入。
- `maker-shared/src/__tests__/brandIdentity.test.ts`：保留 Meka 的
  `acceptedUnregisteredSchemes: []`（`BrandIdentity` 必填字段）并采用上游排版。
- `forge.config.ts`：冲突块**保留 `assertMekaResourceTree(path.join(__dirname, 'resources', 'meka'))`
  （`:1942`）**、删除 `ensureMacIOSimulatorWdaArchive(platform)`（其宿主
  `forge-ios-simulator-helper.ts` 已被上游删除）；另删掉**冲突块之外**的自动合并残留
  `base.push('resources/ios-simulator')`（约 `:867`；该目录已 staged `D` 且磁盘不存在，
  而该数组就是 `packagerConfig.extraResource` ⇒ macOS 打包会对缺失路径报错，
  且 `packagedResourceDeclarations.test.ts:657-659` 的「源码树里必须存在」门禁必红）。
  整份文件 `ios-simulator|IOSSimulator|IOSSim` 命中 **0**。
- `apps/desktop/scripts/package-desktop.mjs`：3 处冲突清零（删掉 iOS release gate 的三处调用点）。
  **额外重要发现**：本文件的自动合并结果是「Meka 整份文件 + 3 个冲突块内容」——
  上游**其余非冲突改动全部没进来**。其中两组被 Meka 自己的文档/vite 配置点名为本文件职责：
  1. `desktopLogUploadBuildEnv` 注入缺失 ⇒ `vite.main.config.ts:59-64` 明写「由
     `package-desktop.mjs` 经 `scripts/shared/log-upload-build-env.mjs` 注入」、
     `docs/dev-rules/log-upload-and-redaction.md:197` 同款链路图；缺它
     `process.env.XDT_LOG_UPLOAD_TARGET` 恒空 = **桌面日志上报整体静默关闭**，
     且 `log-upload-build-env.test.mjs` 只测函数本身 ⇒ **没有任何测试会红**；
  2. `CINDY_WEBAUTHN_APPLE_TEAM_ID` 注入缺失 ⇒ `vite.main.config.ts:74-78` 用
     `readMainEnvPreservingEmpty()` 读它，专门为「打包入口显式写空串防 shell 陈旧值误启 Touch ID」。
  两组都已按上游补回，同时收养上游的 WebAuthn 签名链（keychain-access-groups +
  provisioning profile）与 adhoc 分支的 `verifyMacBinaryArch`。整份文件 `ios-simulator|IOSSimulator` 命中 **0**。
- **2 个 `UD` 文件 ⇒ 接受删除**：`81d6035a7e` 的 `packagedGateArguments()`（`--use-mock-keychain`）
  与 `9ee5f7522f` 的 gate import 都**只服务已退役的 iOS 模拟器 release gate**；
  通用的 macOS keychain 隔离仍独立活在 `smoke-packaged.mjs:175`（被
  `meka-release-identity.test.mjs:127` 锁定），打包签名主体在 `ci/lib.mjs`。
- **主代理独立复核**：`ci/lib.mjs` **未被删文件**（上游只删其内部 iOS 导出；文件仍 1320 行），
  `package-desktop.mjs:58-76` 导入的 17 个符号**全部仍在导出**；
  `deepLink.ts` 的 `cindy-meka://` 主深链与「不注册上游 `cindy://`」注释仍在（`:63`/`:584`）。
- **唯一取舍（主代理已接受保守解）**：上游把 `runForgeMake` 调用改成多行并传
  `webAuthnAppleTeamId`，而 `scripts/__tests__/meka-release-identity.test.mjs:258` 用
  `indexOf('runForgeMake({ platform, arch, region, version, versionless, noSign });')` 精确匹配该字面量。
  为不动清单外文件，保留该字面量，把 Team ID 放进 `runForgeMake()` 内由
  `resolveWebAuthnAppleTeamId()`（`:382-393`）解析 —— 判定条件与上游逐项等价、
  禁用时同样返回 `''` 覆盖 shell 陈旧值。**备选**（改回上游结构 + 改那 1 行断言）留给裁决。

### 3.12 工程脚本与杂项（`wp-scripts-misc`，11 文件 / 20 处冲突）

- `scripts/restart-desktop-remote.mjs`：删 `CINDY_IOS_SIMULATOR_NATIVE_H264/HID` 透传；
  darwin 启动改用上游 `prepareDarwinTerminalLaunch`（长命令写临时脚本 + 失败兜底删除）。
  测试 import 取并集（保 Meka `resolveStartupReadyTimeoutMs` + 上游 3 个 helper），删 iOS 用例。
- **本包发现并修复的「无冲突标记的静默断链」4 处**：
  1. `codexLocalSessions.test.ts`：两侧在 fixture `CREATE TABLE sessions` 的**不同位置**各插入
     同 3 列 ⇒ 重复列名建表即错（保留上游位置、删 Meka 重复）；
  2. `makerSendToSessionOrdering.test.ts`：Meka 的单行 `{ planMode: false, throwOnStartFailure: true },`
     断言 vs 上游源码改成跨行 + `await assertCurrent?.();` ⇒ 必红（已换上游断言）；
     另 3 处旧签名断言按合并后源码取上游；`pendingAgentSwitchApplyHolder` 锚点
     **保留 Meka 更精确的 4 参版**（第四轮先例）；
  3. `task-migration/service.ts`：SELECT 缺 `agent_device_id` 而准入已读 `row.agentDeviceId`
     ⇒ **远程 Agent 任务会被误放行**（取上游 SELECT）；另 `SourceSession` 同时声明
     `workspaceKind: string` 与 `string | null`（TS2717）⇒ 合并为单个 `string | null`；
  4. `bot-import/__tests__/host.test.ts`：3 处取上游（`secretValues.size` 1→2 是源码语义变化：
     每 bot 现在写 `companionEnvironmentKey` + `companionDiscoveryKey` 两把；两条「整单硬拒」
     用例被上游改写为「部分保存 + `checks` 报 needs-attention + 可重试」），
     `pendingImport` 清理用例**保留 Meka 更强断言**。
- `background-task-output/__tests__/reader.test.ts`：采纳上游的「目录 junction」方案
  （Windows 上无需符号链接特权，且额外断言 `stat`/`open` **未被调用** ⇒ 比 Meka HEAD 的
  `it.skipIf(canCreateFileSymlink)` **更强**），因此删除已变死代码的 `canCreateFileSymlink`
  探测与 `node:fs` default import —— 这正是 §5.1 里唯一那条 `DROPPED`，已按本条逐项确认并豁免。
- `apps/mobile/src/__tests__/mobileRealtimeAsrProvider.test.ts`：**适配接纳**（非任一侧原文）——
  合并后 zh-CN catalog 已是上游新措辞，但注入的 `appName` 是 `BRAND_NAME`（`Cindy Meka`）
  ⇒ 断言按 catalog 模板逐字重算后写成 `'Cindy Meka 语音服务的登录已失效或没有权限，…（状态码 403）。'`
  （上游原文硬编码 `Cindy` 违反品牌不变量）。**只改测试文件，不触及冷更指纹。**
- **`MIGRATION_MEKA_UNSUPPORTED` 在位**：`task-migration/service.ts:271`（唯一准入点
  `assertSource`，`:310` start / `:325` 团队成员都走它）；单测 `service.test.ts:1283/1302/1312`
  + 对照 `:1338`；renderer 入口屏蔽 `TaskMoveSubmenu.tsx:202`
  （`session.workspaceKind !== 'meka' &&`）；五语 key 齐备（各 `common.json:43`）。
  上游 24 笔 task-copy 重构未改变准入结构 ⇒ **无需在新结构上重实现**。
- **跨文件依赖（已核对当前工作区成立）**：`makerSendToSessionOrdering.test.ts` 的 4 处上游签名断言
  依赖 `maker-ipc/register.ts` 保持上游 `assertCurrent` 线程化（`:9444` 4 参 holder、
  `:12680 sendLockHeld`、`:13189-13194` 跨行对象 + `assertCurrent`）；移动端断言依赖
  `apps/mobile/src/i18n/locales/zh-CN/composer.json` 的
  `composer.voice.sessionExpiredOrForbidden` 保持上游新措辞（合并结果如此）。
- **存量观察项（未改，登记）**：`main/__tests__/agentProcessPriority.test.ts:222` 注释仍写
  `CindyGlobal`（与 Meka 口径不符，仅注释）。

### 3.6 `packages/orca-workflow` 与 `packages/maker-cc-manager`

**`wp-orca-pkgs`（2 文件 / 13 处冲突）**：

- `orca-bridge-mcp.ts`（12 处）：**适配接纳**。按主代理预先核实的跨文件契约执行 ——
  `dispatchInterAgentMessage` deps 是 **Meka `workerSessionId?: string` 与上游
  `delivery?: OrcaMessageDelivery` 的并集**（唯一实现 `orcaInterAgentDispatcher.ts:63/65`
  确实两者都有）；返回类型取上游 `mode: 'dispatched' | 'queued' | 'steered'` +
  `steerFallbackReason?`；`HostOrcaDispatch` 取上游（含**必填** `steered` —— 工作区
  `:923-935` 的 `dispatchError.steered` / `steer_fallback_reason` 是自动合入的上游代码）；
  `formatAgentMessage` 取上游 4 参版本（自动合入的 `formatOrcaWorkerLabel` +
  `promptSafeSourceName` 已按该形态在跑）；`SEND_TO_LEAD_TOOL_DESCRIPTION` 补上
  `delivery=steer` 那行；`send_to_lead` schema 加 `delivery` enum 且回调签名收 `delivery`；
  直发兜底消息改为 `formatAgentMessage('worker', message, link.workerId)`。
- **package 内 auto-bridge pending map 按上游 `a65df1c003`（#5495）整块删除**：
  `AutoBridgeState` / `workerAutoBridgePending` / `peekAutoBridgeState` / `setAutoBridgePending` /
  `hasAutoBridgePending` / `clearAutoBridgePending` / `__testing` 在 `packages/orca-workflow/**`
  **零命中**；`index.ts` 的 `__testing` 导出也已随自动合并移除。**宿主侧**
  `orcaTeamService.ts` 的 `clearAutoBridgeState` / `AutoBridgeState` 是上游「Host 管理 pending」
  的落点，**未动**（`makerSendToSessionOrdering.test.ts` 断言的正是 `register.ts` 源码不含
  `workerAutoBridgePending`，方向一致）。文档承载点已同步（见 §3.1）。
- `orca-bridge-prompt.ts`（1 处）：**接纳上游** —— worker 回报示例取
  `[From Orca Worker Backend (worker_id: w-1)]`（与 `formatOrcaWorkerLabel` 现在会输出
  角色 + `worker_id` 一致）；其余差异仅引号风格。
- **规格一致性**：自动合并的 `orca-bridge-mcp.test.ts`（`:211`/`:291-294`/`:575-642`/`:1627-1665`）
  与 `orca-bridge-prompt.test.ts`（`:176/179/181/183`）逐条对应上述改动，
  **没有任何断言与「并集」口径冲突**；测试文件未改。
- **静默覆盖排查**：用「引号归一化后的行集合比较」核对工作区 vs 上游 `:3:` ⇒
  `orca-bridge-mcp.ts` 残留差异仅为 Meka 排版 + `workerSessionId` 通道，
  `orca-bridge-prompt.ts` 仅 `reportDelivery` + 排版，**未发现 Meka 语义被静默覆盖**。
- **主代理已先行解决的两项**：`packages/maker-cc-manager/package.json` =
  上游 `@anthropic-ai/claude-agent-sdk` 0.3.292 **∪** Meka 的 `@modelcontextprotocol/sdk` +
  `zod`（后两者是 Meka `mcp-shim.ts` / `capability-mcp-router.ts` 的真实依赖，
  上游从未有过它们）；`src/bin/cc-mgr.ts` 的 import 块 = 上游三符号
  （`buildRemoteClaudeSdkEnv` / `ensureRemoteClaudeConfigDir` / `stripSensitiveAnthropicEnv`，
  其中 `stripSensitiveAnthropicEnv` 是本轮从 cc-mgr 本地函数**上提**到 `remote-claude-env.ts`
  的，函数体逐字相同）**∪** Meka 的 `runMcpShim` / `runCodexBridge` / `CapabilityMcpRouter`。
- **残留风险**：接口并集对 `DispatchOrcaInterAgentMessageParams` 的（逆变）可赋值性、
  包内与 dispatcher 同名 `OrcaSteerFallbackReason` 的等价性均为**结构比对推理，未编译验证**；
  steer 运行时行为未实测（由阶段 B 的 typecheck 与单测覆盖）。
- **存量项（未扩大范围）**：`orca-bridge-prompt.ts:11` 的 `reportDelivery?: "explicit-bridge"`
  是 Meka 专有字段且**无消费点**（`orcaSessionStartOptions.ts:124` 仍写入），属非冲突区自动合并
  保留，登记为存量。

### 3.14 其它主代理直接处理项

- **`apps/desktop/package.json`**：Meka 的 `release:*` 家族（`release:publish`/`promote`/`rollback`/
  `win`/`mac*`/`promote:*`/`reset-canary:*`）**全部保留**（上游该文件只有 `release:package`，
  这些是 Meka 的发布分层能力）；删掉随退役消失的 `release:ios-simulator-gate`；
  `build:ios-simulator-sidecar` / `ensure-wda-source` 已由 git 自动删除。
- **`pnpm-lock.yaml`**：手工解冲突（唯一冲突块是 `packages/maker-cc-manager` 的依赖块），
  随后用仓库 pin 的 `pnpm@10.33.2` 跑 `pnpm install --lockfile-only --no-frozen-lockfile` 归一化
  （`.npmrc` 默认 `frozen-lockfile=true`，必须显式放开）。见 §6。
- **三个 `UD` 文件**：`apps/desktop/scripts/ios-simulator-release-gate.mjs`、同目录
  `.test.mjs`、`apps/desktop/src/main/mcp-integrations/__tests__/ios-simulator-artifact.test.ts`
  ⇒ **接受删除**（上游整体退役；第三个由 `wp-maker-host` 独立核对）。
- **`apps/desktop/src/main/maker-host/index.ts`**：删除随上游退役消失的
  `getShellCommandPolicy: () => undefined` stub 与注释（`AgentDeps` 已无该字段，
  留着是 `new CodexAgent({...})` 的 excess property ⇒ TS2353）。
- **`apps/desktop/src/main/__tests__/packagedResourceDeclarations.test.ts`**：把已知局限示例里
  对已删除 `ios-simulator.ts` / `IOSSimulatorPackagedSidecarArtifactResolver` 的引用改为
  「历史示例 + 该形态仍是盲区」的表述（局限类别本身不变）。
- **`docs/dev-rules/meka-whitelist-verification.md` WL-2.1/WL-2.2 锚点更新 + 新增 WL-25**
  （见 §3.1/§3.4）。

## 4. D4 顺移追加（数据库谱系）

详见 `wp-db-lineage` 的逐项结论（§3 未单列，因其属第 6 波生成物但基础事实必须在最前确定）：

- **已发布谱系 `0000..0122` 一个字节都没改**。上游本轮新增 `0120..0123` 四条
  （`0120_neat_war_machine`、`0121_plugin_task_requests`、`0122_auto_review_projections`、
  `0123_wonderful_oracle`）→ Meka **`0123..0126`**。
- **逐字节同一性（主代理独立复核 `git hash-object`）**：

  | Meka 新号 | 上游原号 | blob |
  | --- | --- | --- |
  | `0123_neat_war_machine.sql` | `0120_neat_war_machine.sql` | `6b9b8656657f` **IDENTICAL** |
  | `0124_plugin_task_requests.sql` | `0121_plugin_task_requests.sql` | `b98018c9f35c` **IDENTICAL** |
  | `0125_auto_review_projections.sql` | `0122_auto_review_projections.sql` | `170d2ba9da9f` **IDENTICAL** |
  | `0126_wonderful_oracle.sql` | `0123_wonderful_oracle.sql` | `3aec20111e97` **IDENTICAL** |
  | `scripts/0125_auto_review_projections.ts` | `scripts/0122_auto_review_projections.ts` | `eb83cb6309ce` **IDENTICAL** |

- **Meka delta 的形状（15 项，纯增量且稳定）**：新增表 `meka_projects`（8 列）+
  `meka_roles`（12 列，含索引 `idx_meka_roles_project_id` 与外键 `→meka_projects.id`）；
  `sessions` 加 10 列（`meka_role`/`meka_target_json`/`meka_project_id`/`meka_role_id`/`is_formal`/
  `formal_type`/`formal_link`/`formal_ref`/`formal_content_json`/`capability_snapshot_json`）
  + 2 索引（`idx_sessions_meka_project_id`、`idx_sessions_meka_role_id`）
  + 1 外键（`sessions_meka_role_id_meka_roles_id_fk`，onDelete **set null**）。
  在 6 对编号（ours `0117..0122` ↔ 上游 `0114..0119`）上的结构化 diff **去重后完全一致**，
  且零 `SUB-DIFF` / 零 theirs-only ⇒ 纯增量、可安全复用。
- **snapshot 生成方式**：`meta/0123..0126_snapshot.json` = 上游同编号 snapshot **+ Meka delta**，
  `id`/`prevId` 沿用上游（`87e4ab7e → d90a85b3 → caa7f32c → d06b22f6`），链从 Meka `0122`
  的 `ee1f5fc9` 自然接上。**强校验**：剥掉 delta 后 `JSON.stringify` 与上游 snapshot 逐字符相等；
  每份新增项恰好 15。
- **`_meta` 更正**：`_meta.columns` / `_meta.tables` / `_meta.schemas` 在**全部 127 份 snapshot 里
  都是空对象 `{}`**（含上一轮的 `HEAD:0122`），Meka delta 从来不需要也不应该有 `_meta` 条目。
- **`meta/_journal.json`**：123 → **127 条**（idx `0..126` 连续无重复），上游原号 4 条已移除；
  新条目 `when` 沿用上游原值且单调。
- **上游 4 条 SQL 与 Meka 已发布 schema 无任何对象冲突**（`attachments_json` 两列 /
  `plugin_task_requests` / `auto_review_projections` / `sessions.agent_device_id` 在 Meka 谱系里都不存在）；
  companion 依赖的 `messages.client_id`、`sessions.cleared_at` 等列 Meka 都有 ⇒ **`待用户决定` 项 = 0**。
- **实跑证据（`wp-db-lineage`）**：`validate-migrations.mjs` **6/6**
  （step 1/2 通过：127 sql、seq `0000..0126`、journal↔sql↔snapshot 对齐、prevId 链连续；
  step 3 `drizzle-kit check` → `Everything's fine`；step 4 = 127 snapshot；
  step 5 = 45 个配套脚本均 CommonJS；step 6 = 固定基线 80 SQL + 23 script、
  canonical 基线冻结 **123 SQL + 44 script** = 已发布 `0000..0122` 未被改写，新增项不在冻结集合内）。
  > 该任务包首次以 `pnpm --filter desktop db:validate` 跑时**阻塞**于当时仍未解决的
  > `apps/desktop/package.json` 冲突（pnpm 解析包清单即失败）；主代理解决后已在 §5 阶段 B 复跑留档。
- **文档同步**：`docs/dev-rules/database-and-migrations.md` 的「编号现状」已改为
  「第五轮后 `0000..0122` 冻结、新增到 `0126`」并补上 companion script 与链式接续的说明。
- **未验证（登记）**：`test:migration-replay`（真实空库/历史库回放到 HEAD）在阶段 B 的
  `pnpm test:db` 里覆盖；`drizzle-kit generate` 零 drift 比对见阶段 B。

## 5. 验证

### 5.1 阶段 A —— 结构审计（`pnpm audit:merge`）

命令：`node scripts/audit-merge-resolution.mjs`（审 index = commit 将包含的内容）。

**结果：`blockers=0 / dropped=0 / review=14 / generated=17`，`verdict: PASS (有待确认项)`**，
退出码 0。首跑为 `dropped=1`，逐条确认如下后带 `--allow` 记账重跑：

- **唯一 `DROPPED`：`apps/desktop/src/main/background-task-output/__tests__/reader.test.ts`**
  （ours 32/37 新增行缺失）。逐项确认结论：**刻意的等价替换（覆盖率反而更强）**。
  Meka 侧被删的是 `canCreateFileSymlink` 探测 + `import fsSync from 'node:fs'` 与
  `it.skipIf(!canCreateFileSymlink)` 的**被跳过**用例；上游侧取而代之的是 `:58-74` 的
  「目录 junction」用例 —— 它在**无符号链接特权的 Windows 上也会真跑**（用 `'junction'` 目标），
  且额外断言 `fs.stat` / `fs.open` **未被调用**（规范化扩展名校验先于读取/打开）。
  ⇒ 无覆盖损失，且不再有一条永久 skip 的用例。豁免理由：`--allow
  apps/desktop/src/main/background-task-output/__tests__/reader.test.ts`。

**14 条 `REVIEW` 的逐条确认**：

| 项 | 结论 |
| --- | --- |
| `drizzle/{0120,0121,0122,0123}_*.sql`（上游原号，4 条） | **Meka 编号不落入这些路径**（那是 Meka 自己的 `0120_spicy_valkyrie`… 等已发布 migration），上游四条已顺移到 `0123..0126`；`git hash-object` 证明**内容逐字节同一** ⇒ 确认。 |
| `drizzle/scripts/0122_auto_review_projections.ts` | 同上，已顺移到 `scripts/0125_auto_review_projections.ts`，hash `eb83cb6309ce` 相同。 |
| `drizzle/meta/{0120,0121,0122}_snapshot.json` `== ours` | 正确：这三份是 **Meka 已发布编号**的 snapshot（`0120_spicy_valkyrie`/`0121_cynical_thunderball`/`0122_hard_vindicator`），必须保留 Meka 内容（AA 冲突按 `:2:` 解）。 |
| `resources/THIRD-PARTY-NOTICES.txt`、`docs/legal/notices/desktop-{linux,macos,win}.txt` `== theirs` | 正确：这四份是**生成物**，由 `scripts/generate-third-party-notices.mjs` 重新生成；两侧依赖集收敛后输出与上游一致（见 §6）。 |
| `src/main/__tests__/codexLocalSessions.test.ts` `== theirs` | 正确：该文件两侧在同一 fixture 的不同位置各插入同 3 列（重复列名建表即错），解决时**保留上游位置**、删 Meka 重复 ⇒ 结果等于 theirs 是预期。 |
| `src/main/localDb/__tests__/dbSlimmingUpgradeOrder.test.ts` `== ours` | 正确：上游那条**更弱**的断言在 `:2:` 已被删除，Meka 的「符号优先 + 首次迁移调用必须是回调体」强断言是两侧的唯一内容，且实测 `localDb/index.ts:335/356` 锚点成立。 |

**`generated=17`**（不阻断）：5 份 drizzle snapshot（D4 顺移，已按源重新生成）、11 份 legal notices
（已由生成器重跑）、`pnpm-lock.yaml`（已由 `pnpm install` 重跑）。**没有一份是手工拼出来的。**

### 5.2 阶段 B —— 最小自动化集合（实跑）

门禁**只在最终代码上跑一次**（用户要求「门禁在最终提交时统一执行」）。全部命令、原始日志与退出码：

#### 5.2.1 `verify-checks` 等价集 + `test:runner` + DB/DB-link

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `pnpm test:runner` | **0** | node test：`# tests 708 / # pass 699 / # fail 0 / # cancelled 0 / # skipped 9 / # todo 0`，末行 `Windows atomic rename check passed.` |
| `pnpm check:design-inventory` | **0** | — |
| `pnpm check:endpoints` | **0** | — |
| `pnpm check:i18n` | **0** | — |
| `pnpm check:brand-terminology` | **0** | — |
| `pnpm check:i18n-glossary` | **0** | — |
| `pnpm ci:scheduler-guard` | **0** | — |
| `pnpm --filter mobile test:scope` | **0** | — |
| `pnpm check:design-colors --base-ref origin/meka/main --head-ref HEAD` | **0** | DS-7 colour 消费者门禁 |
| `pnpm --filter desktop db:validate` | **0** | 127 sql / seq `0000..0126` / 127 snapshot / `drizzle-kit check` 无 drift / 45 companion script |
| `pnpm --filter desktop exec tsc --project ../../scripts/device-link/tsconfig.json` | **0** | — |
| `pnpm test:device-link` | **0** | 真实 loopback WebSocket 连接集成（9.23s） |

#### 5.2.2 编译门（`desktop` / `mobile` / 各改动 package）

| 命令 | 退出码 | 备注 |
| --- | --- | --- |
| `pnpm --filter mobile typecheck` | **0** | — |
| `pnpm --filter desktop typecheck` | 首跑 **2** → 修复后 **0** | 首跑唯一失败原因见 §5.2.4 |
| `pnpm --filter <pkg> run build`（19 个改动包，等价 `tsc --noEmit`） | **全 0** | `@cindy/maker-core`、`@cindy/orca-workflow`、`@cindy/maker-cc-manager`、`@cindy/maker-shared`、`@cindy/mcps`、`@cindy/device-link`、`@cindy/plugin-protocol`、`@cindy/slack-hook-protocol`、`@cindy/device-link-protocol`、`cindy-tools`、`@cindy/im`、`@cindy/maker-scheduler`、`@cindy/maker-remote-ssh`、`@cindy/model-providers`、`@cindy/auth-client`、`@cindy/browser-control-runtime`、`@cindy/anthropic-compat-proxy`、`@cindy/design-tokens`、`@cindy/responses-chat-bridge` |

#### 5.2.3 DB / 集成 / 全量单测（冻结态一次性实跑）

| 命令 | 退出码 | 备注 |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | **0** | lockfile 与 manifest 一致（§6） |
| `pnpm test:runner` | **0** | 见 §5.2.1；含 `design-inventory`（迁移 10 个弹窗后重生成过台账） |
| `pnpm test:db` | **1** | 2 条在 `codexLocalSessions.test.ts`；定性见 §5.2.4-D 与下面「环境限制」段 |
| 3 个 companion DB 回归（CI 同一命令） | **0** | `botCanonicalSession` / `botRemoteResourceProvider` / `builtinMekaSeed` |
| `pnpm test:unit`（全量） | **0** | `apps/desktop unit` **PASS**（529s）、`apps/mobile unit` **PASS**（127s）、其余 package unit 全绿 |
| `pnpm test:git-integration` | **1** | 5 条 / 3 个文件；**全部是 Windows 环境限制，非本次合并引入**，证据见下 |
| `pnpm test:device-link` | **0** | |

**Windows 环境限制（如实登记，不是合并引入，也不是本次要修的）**：`test:git-integration`
的 5 条失败逐条取证如下。

| 用例 | 失败形态 | 为什么不是本次合并引入 |
| --- | --- | --- |
| `task-migration/__tests__/workspace.git-integration.test.ts > copies link chains…` | `EPERM: operation not permitted, symlink`（`fs.symlink(..., 'dir')`） | Windows 未开开发者模式时无法建目录符号链接；该用例**没有** win32 capability 跳过保护（文件里只在 FIFO/尾随空格那条用了 `it.skipIf(win32)`） |
| `reviewer/__tests__/reviewSubmoduleIdentity.git-integration.test.ts` ×3 | 路径预算 10000 / 512 MB 指纹上限被越界 | **该用例与它消费的生产代码在本轮 diff 里都是零改动**：`git diff --stat origin/main -- apps/desktop/src/main/reviewer` 为空 ⇒ 与上游逐字节一致，本机任意分支跑都是同样结果 |
| `cindy-make/__tests__/upstreamMerge.git-integration.test.ts > removes ignored workspace dependency links…` | `expected false to be true`（junction 链接清理） | 生产代码 `cindy-make/upstreamMerge.ts` 与上游**逐字节一致**（`git diff --stat` 为空）；用例用 `symlink(..., 'junction')`，Windows junction 语义与 Linux 不同 |
| `packages/maker-core .../scope-resolver.git-integration.test.ts > linked worktree 内二级 submodule` | `Test timed out in 5000ms` | `packages/maker-core/src/memory` 与上游**零改动**；`vitest.config.ts` 明确注释 Windows 默认预算给到 60s 就是因为 Windows 明显更慢，而该用例自带 5s 预算 |

补充：`apps/desktop/src/main/task-migration` 的**生产代码**本轮确有改动（子代理修回了被合并丢掉的
`agent_device_id` SELECT），但其 `workspace.git-integration.test.ts` 的失败是**符号链接能力 EPERM**，
与那段逻辑无关；该文件的 `service.test.ts` 在 `test:unit` 里全绿。

`test:db` 的第 2 条失败是**存量**用例
`caps to newest MAX_THREADS_PER_HOME top-level threads when more than 1000 exist`
（`meka/main` 合并前就存在，本轮文件与生产代码均未被这一侧改动），实测 `Test timed out in 15000ms`
（≥1000 个 thread 的真实文件系统操作，Windows 上越过它自带的 15s 预算）——同样是环境/负载性超时，
不是断言失败。

#### 5.2.4 本轮引入、已在交付内修复的缺陷

首轮全量单测（`apps/desktop` unit）实测：**`Test Files 6 failed | 3343 passed`、
`Tests 18 failed | 48751 passed`**。逐个定性后**全部属于本次交付引入**（其中 5 个失败测试文件
在合并前的 `meka/main` 上**根本不存在**，是本轮上游带进来的新守卫）：

| # | 文件 | 失败数 | 定性 | 修法 |
| --- | --- | --- | --- | --- |
| 1 | `main/maker-ipc/__tests__/orcaLifecycleService.test.ts` | 2 | 合并把两侧的格式化与新增实参拼在一起 ⇒ 语法破坏 | 见下 §5.2.4-A |
| 2 | `main/__tests__/deepLinkWindowsRegistration.test.ts` | 3 | **新上游文件**硬编码上游品牌名 `Cindy`，与 Meka 的 `BRAND_NAME`（`Cindy Meka`）冲突 | 改用 `BRAND_IDENTITY.displayName`（Meka 品牌走常量，不写死） |
| 3 | `main/__tests__/authCredentialLoginRecovery.test.ts` | 9 | **新上游 harness** 只截取 `runLoginAction`；Meka 在函数体里新增了 `authRealmForEdition(activeProductEdition)`，harness 前言没提供该依赖 | 按**源码切片**把 `authRealmForEdition` 补进 harness 前言 + `let activeProductEdition = AUTH_REGION`（不手抄实现，避免漂移） |
| 4 | `main/__tests__/remoteAgentSetModelWiring.test.ts` | 1 | **新上游源码文本断言**锚 `bootstrapSession`；Meka 把函数体改名为 `bootstrapSessionOnce` 并在外层加了 in-flight 去重包装 | 断言改锚 `bootstrapSessionOnce`（被守卫的不变量就在该函数体里，三行断言逐条仍在） |
| 5 | `renderer/__tests__/dialogScrimDismissal.test.ts` | 1 | **新上游守卫**：每个 Radix `Dialog.Content` 必须无条件 `e.preventDefault()` 外部点击；10 个 Meka 弹窗不符合（早于该契约） | 见下 §5.2.4-B |
| 6 | `renderer/__tests__/modalSurfaceContract.test.ts` | 2 | **新上游守卫**：模态必须用共享 `.modal-scrim` / `.modal-panel`，不得自带外观/动画类与内联外观样式；同 10 个 Meka 弹窗不符合 | 见下 §5.2.4-B |

同时**主代理自查发现**（首轮单测未覆盖或与我的中途编辑交错）：

- **`localDb/ipc/__tests__/messagesWriteReadback.test.ts`**：`h.client` 对象字面量里
  **两侧各插入了一个 `tx:` 成员**（Meka 的 drizzle 写回 mock 与上游的 `runInprocTx` mock）
  ⇒ `TS1117`（重复属性）；同文件 `CREATE TABLE sessions` 也被两侧在不同位置各插入了同一批
  `list_preview*` 列 ⇒ 运行期 `duplicate column name`。**修法**：保留**上游**的 `tx`
  （它调用真实的 `worker/opHandlers/tx` 生产实现，保真度更高，且 `h.queries` 由 sqlite
  `verbose` 采集，断言不受影响），删掉 Meka 的重复实现与随之无用的 `and, eq` 导入；
  `CREATE TABLE sessions` 去重为 `id, list_preview, list_preview_role, list_message_count,
  cleared_at, status`。
- **`main/maker-ipc/__tests__/orcaWorkerCreationService.test.ts`**：**新上游文件**的 `deviceLead()`
  fixture 缺 Meka 的必填字段 `mekaProjectId` ⇒ `TS2322`。**修法**：fixture 补 `mekaProjectId: null`。
- **全量语法扫描**：主代理对**全部 2355 个本次改动的 TS/TSX 文件**用 esbuild `transformSync`
  做了语法层扫描 ⇒ **0 处失败**；另对**全部改动文件**做了「`CREATE TABLE` 内重复列名」的
  精确括号匹配扫描（2394 文件）⇒ **0 处**（初版扫描器的 4 个命中经逐条复核全是解析器假阳性：
  跨表匹配与 `PRIMARY KEY(...)` / `UNIQUE(...)` 被当成列名）。

**§5.2.4-A `orcaLifecycleService.test.ts` 语法破坏**：解冲突时把 Meka 的多行格式与上游新增的
第二实参拼在了一起，落成 `}), undefined);`（多一个 `}`）⇒ `desktop typecheck` 报
`TS1135 Argument expression expected` + 级联 `TS1128`（`:663/:664/:1039/:1040`）。
按三方证据还原为「Meka 的多行格式 + 上游新增的第二实参」：
`expect.objectContaining({ … }),` / `undefined,` / `);`。修复后 `desktop typecheck` **exit 0**。

**§5.2.4-B 模态契约迁移（10 个 Meka 弹窗）**：`cindy-brain/GhostPanelModal.tsx`、
`components/new-chat/MekaRemoteSessionPicker.tsx`、`components/settings/MekaAssistantSettingsSection.tsx`、
`components/settings/MekaRouterConnectDialog.tsx`、`features/cc-agent/MekaFormalIssueModal.tsx`、
`features/cc-agent/MekaProjectCreateDialog.tsx`、`features/cc-agent/MekaProjectRemoteInstances.tsx`、
`features/plugin/MekaDevPluginPackageDialog.tsx`、
`features/skillhub/components/MekaSkillManagementDialog.tsx`、
`features/skillhub/components/MekaSkillPublishDialog.tsx`
⇒ 改用共享 `modal-scrim` / `modal-panel`、去掉被契约收编的自带外观/动画类与内联外观样式、
并给每个 Radix `Dialog.Content` 补无条件 `onPointerDownOutside`。

- **实跑**：`dialogScrimDismissal.test.ts` + `modalSurfaceContract.test.ts` ⇒ `Test Files 2 passed`、
  `Tests 11 passed`，**exit 0**（修前 `3 failed / 8 passed`）；这 10 个组件已有的 6 个测试文件
  回归 `15 passed`；`pnpm --filter desktop typecheck` **exit 0**。
- **例外登记 0 条**：10 个 offender 全是**居中**弹窗（`fixed left-1/2 top-1/2` + transform，
  或 `inset-0 + m-auto`），没有一个是贴右整高抽屉，因此 **`SIDE_DRAWERS` 一条都没加**；
  全部经 Radix `Dialog.Overlay` / `Dialog.Content`，因此也没动 `HAND_BUILT_DIALOGS`；
  8 个文件的 `var(--overlay-modal` 命中项都是它们自己的遮罩，全部换成 `modal-scrim` 后
  renderer 里只剩已允许的 `DiffPanelShell.tsx` 与 `WindowControls.tsx` 的一句注释。
  **两个守卫测试文件逐字节未改** —— 这与「不得为变绿而登记假例外」的口径一致。
- **宽度、定位（transform 居中）、内边距、`overflow-hidden`、`focus:outline-none`、
  `WINDOW_NO_DRAG_STYLE` 全部保留**（`GhostPanelModal.test.tsx` 断言的 `h-[90vh]` / `w-[90vw]` /
  `data-[state=closed]:invisible` 仍在）。
- **可见观感变化（不是回归，但用户可见，需实机确认）**：①阴影统一为 `--shadow-menu`
  （顺带修正了 `shadow-[var(--confirm-shadow)]` 这个在本仓原本不生效的写法）；
  ②③ `--surface-elevated` / `--settings-theme-card-bg` → `--confirm-bg`（5 处）；
  ④两处硬编码色 `bg-black/45 backdrop-blur-[1px]` 被删除（改走共享遮罩）；
  ⑤`GhostPanelModal` 90% 视口面板底色与面板内 body 的 `--panel-bg` 可能出现轻微分层；
  ⑥**行为变化**：`MekaRemoteSessionPicker` 原先点遮罩可关（`creating` 时不可关），
  现按契约「点遮罩一律不关、Esc 仍可关」。
- **未验证**：**Light/Dark 实机目检未做**（不得声明已验证）；未改 `globals.css`、
  未改 `components/ui/**` 共享 primitive。

**§5.2.4-C 上游守卫被 WL-25 取代的一处（登记，未隐藏）**：
`orcaLifecycleService.test.ts` 的 `does not change the ordinary preference when team lookup is missing`
是**上游**用例，它依赖「无 active team ⇒ `NOT_FOUND` 早返回，因此不动 Worker 偏好」。
Meka 的 **WL-25** 刻意让 `create_worker` 就地开团队并继续 ⇒ 该情形的 `result.ok` 变为 `true`，
且会按产品既有规则解析显式入参（`orca-worker-permission-mode.ts`：`auto` / `bypassPermissions`，
**缺省 `bypassPermissions`**）—— 与「已有团队」路径同一口径。
已把该用例改为**按 outcome 分支**：`failed` 分支保持上游原断言（不继续、不动偏好），
`missing` 分支断言 WL-25 语义（成功 + 入参按既有规则解析）。
**这是一处「已登记分歧吞掉上游守卫」的实例**，维护者若不同意 WL-25，需同时回滚该用例。

**§5.2.4-D 上游按区域闸门历史 userData 目录，撞上本仓已登记的兼容红线（保留本仓行为）**：
`db` 层实测 `codexLocalSessions.test.ts` 红 2 条，其中一条是**本轮上游新加**的守卫
`does not implicitly adopt China-edition legacy state in the Global edition`
（由 `a5467dc0c1` 引入；merge-base 与上一轮都不存在）。它断言 Global 版**不**接管
`xdt-maker` 历史 Codex HOME —— 上游为此把 `legacyUserDataDirNamesByRegion` 设为
`{ cn: ['xdt-maker'], global: [], dev: [] }`，并让 `allUserDataDirNames(region)` 按区域取。

**但本仓的平铺模型是已登记的红线**：`docs/dev-rules/meka-whitelist-verification.md` WL-6.1 把
`legacyUserDataDirNames: ['xdmaker-meka','xdt-maker']` 列为**兼容红线**，WL-5.7（本轮新增）
进一步写清「历史 userData 目录不按区域闸门」，且 `brandIdentity.test.ts` 有两条锁死用例
（「Cindy Meka 新身份与 XDMaker Meka 迁移锚保持分离」逐元素断言该列表；
「dialogue cwd 迁移在两服务区只读扫描 Meka 历史目录」断言 cn 与 global 返回**同一**列表）。

⇒ **按白名单口径保留本仓行为**（不改 `brandIdentity.ts`、不改 `brandIdentity.test.ts`），
把上游该用例改为显式锁定本仓语义：用例名改为
`scans the same Meka legacy Codex HOME in the Global edition as in the CN edition`，
断言 Global 版同样接管该历史 thread、且源文件保持只读不被改写，并在用例注释里写明
上游守卫与本仓红线的关系（**不静默删除上游用例**）。
这是一个需要维护者裁决的产品口径（Global 是否该读 `xdt-maker` 目录的解），
裁决入口已写在 WL-5.7；**若要采纳上游闸门，必须同时改实现 + 那两条 maker-shared 用例 + WL-5.7/WL-6.1，
不允许只改测试**。

#### 5.2.5 阶段 B 逐项结论

冻结态一次性实跑（`_analysis/gate-final.ps1`、`_analysis/gate-final2.ps1` 的原始日志）：

| 门禁 | 退出码 | 结论 |
| --- | --- | --- |
| `pnpm test:runner` | **0** | 708 tests / 699 pass / 0 fail / 9 skipped；`meka-whitelist-contract`（本轮新增 WL-5.7 后重跑）全绿 |
| `pnpm check:design-inventory` | **0** | 迁移 10 个弹窗后重生成台账再校验 |
| `pnpm check:design-colors` | **0** | 迁移**删掉** 2 处硬编码色，无新增 immature 色 |
| `pnpm check:endpoints` / `check:i18n` / `check:brand-terminology` / `check:i18n-glossary` | **0** | |
| `pnpm ci:scheduler-guard` | **0** | |
| `pnpm --filter mobile test:scope` | **0** | |
| `pnpm --filter desktop db:validate` | **0** | D4 顺移后的 127 个 snapshot 与 canonical 一致 |
| `pnpm test:unit`（全量） | **0** | desktop unit **PASS**（529s）/ mobile unit **PASS**（127s）/ 各 package unit 全绿 |
| `pnpm test:db` | **1** | 仅剩 1 条 **Windows 预算性超时**（见 §5.2.3 环境限制段）；定向复跑 1 条；放宽预算至 120s 后**该文件 133 条全绿** |
| `pnpm test:git-integration` | **1** | 5 条，全部是 **Windows 平台能力/超时**，且相关生产代码与上游**逐字节一致**（§5.2.3） |
| `pnpm --filter desktop typecheck` | **0** | 修掉 3 处本轮引入的类型错误后通过 |
| `pnpm --filter mobile typecheck` | **0** | |
| `pnpm test:device-link` | **0** | |

定向复现（隔离、无并发，用于区分「并发争用」与「真实回归」）：

| 隔离复跑 | 结果 |
| --- | --- |
| `messagesWriteReadback.test.ts` | **133→exit 0**（我的去重修复成立，audit 的 `--allow` 有据） |
| `codexLocalSessions.test.ts` | 133 条中仅 2 条 15s 预算超时；**放宽到 120s 后 133/133 全绿** ⇒ 纯环境速度 |
| `reviewSubmoduleIdentity.git-integration.test.ts` | 仍失败（生产代码与上游逐字节一致） |
| `upstreamMerge.git-integration.test.ts` | 仍失败（生产代码与上游逐字节一致） |
| `task-migration/workspace.git-integration.test.ts` | 仍失败（`EPERM` 建目录符号链接，Windows 能力限制） |
| `packages/maker-core .../scope-resolver.git-integration.test.ts` | 仍失败（自带 5s 预算，Windows 更慢） |

## 6. 生成物重生成记录

| 生成物 | 来源命令 | 结果 |
| --- | --- | --- |
| `pnpm-lock.yaml` | 手工解唯一冲突块（`packages/maker-cc-manager` 依赖）+ `pnpm install --lockfile-only --no-frozen-lockfile` 归一化 | `pnpm install --frozen-lockfile` **exit 0**（与 manifest 一致）；`.npmrc` 默认 `frozen-lockfile=true`，故归一化时必须显式放开 |
| `apps/desktop/drizzle/meta/0123..0126_snapshot.json` + `_journal.json` | D4 顺移（上游 snapshot + Meka delta） | 见 §4；`db:validate` 通过 |
| `docs/design-rules/design-inventory.md` | `node scripts/design-inventory.mjs` | 56 个 surface；生成器只重写 GENERATED 区块、人工区保留；冲突标记 0 |
| `docs/legal/notices/**`、`apps/desktop/resources/THIRD-PARTY-{NOTICES,RESTRICTED}.txt` | `node scripts/generate-third-party-notices.mjs` | desktop 909 包依赖 + 20/18 个非 npm 组件；写盘 21 个文件；冲突标记 0 |

## 7. 未验证 / 未完成 / 待裁决（不得据此宣告收敛）

**阶段 C 实机（本轮实跑，非「读过清单」）**：`pnpm restart:desktop:remote` 起 dev 实例
（`DESKTOP_DEV_VERDICT=ready`、region=global、沙盒 userData `CindyMeka-dev2-dev`、pid 59168）后：

- `pnpm desktop:ui-smoke` ⇒ **13 PASS / 2 FAIL / 0 UNVERIFIED**（日志
  `_analysis/r5-stage-c-ui-smoke.log`）。2 条 FAIL 全在 WL-1.2 / WL-1.3 的
  「配置」needle 上。**CDP 只读实证**（`_analysis/dump-meka-panel-buttons.mjs`）该沙盒的
  MCPRouter **已连接**：卡片文案 `已连接 | 断开 | https://mcpr.meka.pawdy.fun | 账号：zhouwenkang`，
  面板按钮 `["选择目录","断开","断开"]` —— 按产品设计（`MekaAssistantSettingsSection.tsx:415-432`
  的 `router?.configured ? 断开 : 配置`）此时按钮就是「断开」，
  **检查的前提是「未连接态」，在当前沙盒不成立**，不是能力回归。**没有**为了造前提去断开
  用户真实的 MCPRouter 凭证（不改用户数据）。旁证强于原检查：面板四卡齐全、
  MCPRouter 卡片显示已连接、**46 个 MekaDesign 工具 + 15 个系统工具 + 2 个远程模板实例**
  （`zhouwenkang/saga2-server`、`zhouwenkang/muffin-server`、`zhouwenkang/test1`）。
- `pnpm desktop:session-smoke` ⇒ **11 PASS / 0 FAIL / 0 UNVERIFIED**（重跑后，日志
  `_analysis/r5-stage-c-session-smoke-2.log`；首轮 WL-11.17 报「未能发送…探针」属操作抖动，
  断言本身没跑到，重跑给出实证：段命中条目 4 条、格式行在场、无 `#` 标题行、无清单外文本）。
- 上述两项与 WL-4 的差异见下；**ui-smoke 的 2 条是「未验证 + 前提不成立 + 旁证」，需要维护者书面接受**。

**其余未跑 / 未验证项逐条登记如下**：

1. **WL-1.2 / WL-1.3（MCPRouter / MekaDesign 连接对话框）**：见上「阶段 C」——
   当前只能登记为**未验证（检查前提不成立）**：沙盒已连接真实 MCPRouter，按钮按设计是
   「断开」；要跑通该检查需要 ① 在**干净沙盒**（未连接态）里跑，或 ② 把检查改成双态覆盖
   （已连接→断言「断开」；未连接→断言「配置」且点击后出现 `[role=dialog]` 且 URL 框是 https）。
   方案 ② 属 smoke 脚本的**存量工具缺口**（非本轮引入），登记不改写。
2. **WL-4 全部端到端**：需 MCPRouter 账号 + 已绑定到 Meka 项目的实例（Claude 与 Codex 各一更佳）
   + 有效 Cindy AI Gateway key，且 MCPRouter 侧部署的 bundle pin 与客户端一致 ⇒ 本会话不具备，
   登记「**未验证 + 缺账号/缺实例**」（客户端侧代码在位证据见 §3.5）。
3. **WL-4.2 / 远端 codex 是否真遵守 thread config**、真机 codex 硬关取证（读完整命令行）：
   需远端环境。
4. **Light/Dark 实机目检**：本轮改动未新增颜色/样式，但**两种模式均未目检**（不得声称已验证）。
5. **移动端冷更指纹**：本轮 `apps/mobile` 只改了一个测试文件，不进入 runtime fingerprint；
   若最终判定需要发布级确认，按 `mobile-development.md` 的冷更把关人流程另行确认。
6. **存量缺口（非本轮引入，未擅自扩大范围）**：
   - `localDb/ipc/__tests__/sessionsRestoreIfArchived.test.ts:71-75` 的
     `ExpectedIdentity.workspaceKind` 联合（两侧同源）**不含 `'meka'`** ⇒ resume 侧 `'meka'`
     接受**无测试覆盖**；
   - `MekaDevInstallReview.tsx` 与 `features/plugin/lib/permissionItemIcon()` 的图标映射分叉
     （`badge→BellDot`、`networkSecretOrganizationIdentity`/`nodeSecret→KeyRound`、
     `main-view→PanelLeft`）；
   - `docs/dev-rules/plugin-security-and-authoring.md` 里引用的 `errandPrefsStore.ts` 全仓不存在
     （存量文档失真）；
   - `orca-bridge-prompt.ts:11` 的 `reportDelivery?: "explicit-bridge"`（Meka 专有、无消费点）；
   - `main/__tests__/agentProcessPriority.test.ts:222` 注释仍写 `CindyGlobal`。
7. **存量文档口径（本轮已就 iOS gate 退役处就地补注，另有 3 处待裁决是否改写）**：
   `docs/dev-rules/credentials-and-local-storage.md`（§4 约 `:149`）、
   `docs/migrations/cindy-meka-release.md`（`:174`）、
   `docs/migrations/xdmaker-meka-to-cindy.md`（`:303`，**本条为带日期的历史条目，倾向不改写**）
   仍描述「签名后的 iOS Simulator release gate 使用 `--use-mock-keychain`」——
   gate 退役后该半句已无对应实现。
8. **待裁决**：
   - `runForgeMake` 调用形状（保留 Meka 字面量 + 函数内解析 Team ID，v.s. 改回上游结构 +
     改 `meka-release-identity.test.mjs:258` 的 1 行断言）—— 当前取**保守解**（§3.11）；
   - 上一条第 7 项的 3 处文档是否连带改写；
   - **WL-5.7 的区域闸门口径**（§5.2.4-D）：是否采纳上游 `legacyUserDataDirNamesByRegion`
     （即 Global 版不再接管 `xdt-maker` 历史 userData / Codex HOME）。当前保留本仓已登记的
     平铺模型（WL-6.1 兼容红线）；采纳需同时改实现 + `brandIdentity.test.ts` 两条用例 + WL-5.7/WL-6.1；
   - **WL-1.2 / WL-1.3 的 smoke 检查是否按双态覆盖改造**（见 §7 第 1 条）；
   - **`orcaLifecycleService.test.ts` 的 WL-25 分支断言**（§5.2.4-C）：若维护者不同意 WL-25
     （「无 active team ⇒ 就地开团队」），需同时回滚该用例与实现；
   - 插件基座白名单**批准门**：需放行人明确 Approve（§8）。
9. **跨端协议**：本轮接受的上游协议改动均为**可选增补 / 注释 / 兼容标记**
   （`device-link-protocol` 的 `NotifyPayload.sender?`、`plugin-protocol` 的 `mobile?`/`agent.tasks?`
   与 skill 投影路径变更、`slack-hook-protocol` 注释）—— 按 `AGENTS.md`
   「非必要不得修改跨端协议」的口径登记为**接纳上游**而非本仓自有变更；如需跨仓同步
   （relay / MCPRouter），由发布流程另行处理。

## 8. 白名单批准门（放行人动作）

本轮改动命中 `docs/dev-rules/plugin-security-and-authoring.md` 的**插件基座白名单确认门**：
`apps/desktop/src/main/cindy-brain/**`、`apps/desktop/src/main/plugin-market/**`、
`apps/desktop/src/shared/ghost.ts`、`apps/desktop/src/renderer/features/plugin/**`。
按该文件第 5 节，**需放行人明确 Approve**，不看 diff 大小、不因「是 bugfix／纯技术改动」豁免。

存量插件兼容红线核对结论（`wp-plugins-main` + `wp-plugins-ui`）：
**未引入任何要求重新安装 / 重新确认权限 / 重新配置的改动**；唯一受影响者是内置 iOS 模拟器，
它走上游既有的退役链路（`featureRetirements` 单条 `embedded-ios-simulator` + 替代插件引导、
receipt 仍 `approved` 且 `enabled: true`、`migrateLegacyApprovalsOnce` 自动补批准）；
其余内置插件未被连带打断。

`plugins/meka-release-identity.test.mjs:127` 锁定的通用 macOS keychain 隔离**不受影响**。

