# 第六轮上游同步：`origin/main` → `meka/main`（2026-10-16）

> 本轮把上游 `origin/main` 的最新提交语义合并进本仓 `meka/main`。
> 上一轮（2026-10-08）报告见 [`2026-10-08-origin-main-to-meka-main.md`](2026-10-08-origin-main-to-meka-main.md)；
> 迁移总账见 [`xdmaker-meka-to-cindy.md`](xdmaker-meka-to-cindy.md)（本轮登记为 §11.36）。
> 接纳策略、波次与完成判定见 skill `cindy-meka-upstream-sync` 与
> [`meka-whitelist-verification.md`](../dev-rules/meka-whitelist-verification.md)。

## 1. 基线

| 项 | 值 |
| --- | --- |
| 本仓合并前 `HEAD`（产品线侧） | `4fa3b253d6f16e76e3dd83390d4de44c6dcd6102` |
| 上游 `origin/main`（上游侧） | `53b2c99854ddea4ead1868e3477e830f66f20800` |
| `merge-base` | `c940ab1903e16f24b249a06857afb27632693237` |
| 上游独有提交数 | **184** |
| 本仓独有提交数 | 1301 |
| 上游本轮改动规模 | **3629 文件、`+417302 / −31007`** |
| Git 冲突路径 | **80**（76 `UU` + 3 `AA` + 1 `UD`） |

`merge-base` 恰好等于**上一轮同步的上游端点**，因此本轮只引入上游在这 184 个提交里的新增内容。

冲突按能力组路由给 8 个并行解决工作包（`_analysis/wp6-*.md` 为各包原始报告），
加主代理直接处理的身份/构建与治理文档两类。

| 组 | 任务包 | 冲突路径 |
| --- | --- | --- |
| 数据库谱系（D4） | `wp6-db-lineage` | `drizzle/meta/{0124,0125,0126}_snapshot.json`（`AA`）+ 上游新增 5 条 migration 的顺移 |
| 插件基座（main） | `wp6-plugins-main` | `cindy-brain/{index,forge,ghostVisibility,pipeDispatcher}`+测试、`googleAccountsMigration`（`UD`）、`mcp-integrations/ghost.ts`、`plugin-market/service.ts`+测试、`packages/plugin-protocol/src/index.ts` |
| 插件 UI 投影 | `wp6-plugins-ui` | `renderer/cindy-brain/**`、`renderer/features/plugin/**`、`OrcaWorkersTabBody.tsx` |
| maker-ipc / Orca | `wp6-maker-ipc` | `maker-ipc/{register,makerSendTransaction,orcaWorkerCreationService}`+测试、`lizi-mcps/{orca/server.ts,create_worker.ts}` |
| maker-core / Host | `wp6-core-host` | `maker-core/src/agents/{base-agent,codex/index,pi/index}.ts`、`maker-host/index.ts`、`mcp-integrations/mcp-providers.ts`、`xdt-helper/app_update.ts` |
| cc-agent / 侧栏 UI | `wp6-sidebar` | `SidebarTopNav`、`CCAgentSidebarUpper`、`NewMakerDraftRoute`、`CCAgentSessionView`、`SessionContentHeader`、`CreateWorkerPopover`(+测试)、`OrcaWorkerPanel`、`RolePillDropdown`、`TaskMoveSubmenu` |
| 外壳 / 设置 / 杂项 | `wp6-shell-misc` | `UserInfoSection`、`AboutSection`、`SettingsView`、`FolderPickerPopover`、`ErrorBanner`(+测试)、`agent-island/state.ts`、`bootstrap-electron.ts`、`authIpc`(+测试)、`versionStartup.ts`、`updateScriptMacOS`(+测试)、`mobile/sessionLinks.ts`、`restart-desktop-remote.mjs`(+测试)、`bot-import/__tests__/host.test.ts` |
| i18n 五语 | `wp6-i18n` | 五份 `renderer/i18n/locales/*/common.json` |
| 身份 / 构建（主代理） | — | `main/deepLink.ts`、`forge.config.ts` |
| 治理文档与生成物（主代理） | — | `docs/dev-rules/{plugin-security-and-authoring,desktop-development,environment-setup}.md`、`docs/design-rules/design-inventory.md`、`docs/legal/notices/**` |

### 1.1 本轮主导上游改动（非穷举）

- `93f1393143 feat(plugins): 按 namespace 识别并隔离插件实例 (#5753)` —— 插件基座最大一笔
  （`GhostManager.ts` +1134 行、大量 `ghostFirstParty*` / `ghostInstance*` / `ghostLocalUpdateSource*`
  新守卫），并**删除** `googleAccountsMigration.ts` 与 `__tests__/filoGoogleClientConfig.test.ts`。
- `2ce5ab565e feat(desktop): 伙伴并入侧栏第一层，与任务列表并存 (#5943)` —— 侧栏结构再次变化
  （WL-2 的 Meka 入口需按新结构重实现）。
- `24320dc07e feat(mcp-apps): 支持标准 MCP Apps 与通用交互卡片 (#6057)`。
- `ae54765a32 feat(provider-share): 同账号任意电脑管理供应商组…(#6069)`、
  `4f26df40fa feat(provider-share): 分享来的供应商经组转给他人需原主人逐人同意 (#6100)`、
  `2c1d7e54c4 feat(provider-group): 同一台电脑上的多个账号按电脑聚合显示与计数 (#6156)`。
- `58761bbac0 perf(desktop): 裁剪安装包冗余资源并去重运行依赖 (#6090)` —— `forge.config.ts`
  新增 `prunePackagedRuntime` / `prunePackagedMigrationSnapshots` / `forge-runtime-deps`。
- `f2f5ba54ed feat(desktop): 为 Linux 添加系统托盘入口 (#6093)`。
- Orca 供应商切换一组：`5f89c8c711`、`d7ac0545f5`、`3c2af7b5e5`、`8b7e52204c`、`158122c02e`。
- 伙伴/群聊一组（`b10c3239d4`、`2ce5ab565e`、`23c15643b9` 等）与
  `0127_bot_group_task_posts` / `0128_demonic_odin` 两条 migration。

## 2. 逐组解决结论

> 各工作包的原始报告在 `_analysis/wp6-*.md`（该目录由 `.git/info/exclude` 排除，不入库）。
> 本节只记「最终有效行为 + 决定归属 + 证据 + 残留风险」。

### 2.1 插件基座（main 侧，`wp6-plugins-main`，10 文件 / 20 处冲突 + 1 `UD`）

本轮插件基座的主导上游改动是 `93f1393143 feat(plugins): 按 namespace 识别并隔离插件实例 (#5753)`
（`GhostManager.ts` 单文件 +1134 行，配套十余个 `ghostFirstParty*` / `ghostInstance*` /
`ghostLocalUpdateSource*` 新守卫）。冲突文件全部按「上游新结构为宿主 + Meka 能力重实现进新结构」解决：

- **`googleAccountsMigration.ts`（`UD`）⇒ 接受上游删除**。上游 commit body 明示这是行为变更：
  「删除了 Filo Google 自动搬账和构建期 OAuth client 注入」。本仓该文件**不是 Meka 自有能力**
  （`c940ab19..HEAD` 只有 merge 提交），消费者是 `cindy-brain/index.ts` 的 import + 调用点，
  上游已同步删除；`filoGoogleClientConfig.ts` 及其测试随之消失（本仓未改过，属干净删除）。
  **存量兼容结论**：已装/已批准/已启用的 `filo-google` 插件本体照旧可用，vault 里既有凭证不删不改，
  无新增必填字段 / 新校验 / 重装 / 重新确认权限 ⇒ **不构成存量兼容红线的 P0**；
  唯一用户可见影响是「从未搬过账的极老 Google 集成账号需手动重新授权一次」（登记在 §6）。
- **`index.ts`（5 处）**：保留 Meka 的 `resolveGhostRuntimeId`（`:1182`）、`resolveGhostLogicalId`（`:1193`）与
  `mekaDevPluginsSingleton` / `runtimeIdFor` 链（`:764` 声明），上游
  `findGhostForInstanceId`(≥12 处) / `installedGhostStoragePart` / `resolvePluginInstanceQuery` 新结构照收。
- **`ghostVisibility.ts`（3 处）**：采用上游四参形态
  `classifyGhostVisibility(ghostId, workdir, deps, namespace?)`（`:39`），`GhostVisibilityDeps`（`:33`）
  为 `{listGhosts, isAvailableForActiveSession, isDisabledForWorkdir}`，**不含 `resolveGhostId`**；
  该文件现与 `origin/main` 逐字节相同。Meka 的逻辑 id 别名改由调用侧收敛：
  `mcp-integrations/ghost.ts` 新增私有 `resolveVisibilityGhostId`（薄封装 `resolveGhostRuntimeId`）
  覆盖 7 处 Agent 可见性入口；市场侧 `installedState` 刻意不映射（开发副本不是市场安装）。
- **`pipeDispatcher.ts`（5 处）+ 其测试（1 处）**：以上游 `installedGhostStoragePart` 为唯一实例身份
  （取代 Meka 的 `runtimeGhostId`），保留 Meka 的 `meka-unity` 专句 ⇒ Meka 开发副本测试与上游统计测试
  在同一实现下同时通过。
- **`plugin-market/service.ts`（3 处）+ 测试（1 处）**、**`mcp-integrations/ghost.ts`（6 处）**、
  **`forge.ts`（1 处）**：WL-9 五条契约逐条实测仍在 —— `channel: 'meka'`、
  `pluginClientVersionReader('meka')`、`meka-ledger.v1.json`、8/128 MiB 双档下载上限、
  `ignoredRoundStorageKey` 旧键形态 `cindy.pluginUpdates.ignoredRound.<mode>.<owner>`
  （Meka = `...ignoredRound.meka.<mode>.<owner>`）。
- **`packages/plugin-protocol/src/index.ts`（1 处）**：**接纳上游自身变更**（上游 `7a6ad446e9` 新增
  `export * from './usage.js'`）+ 保留本仓既有 `./mcpr-plugin-capability.js` 导出。
  本包**未新增/修改任何类型、常量、wire 字段、枚举或校验函数** ⇒ 不构成本仓自有的跨端协议改动；
  `usage.js` 的 ack 契约与 namespace 解析都是**可选/加性**设计
  （`parseOptionalNamespace` 缺字段返回 `{}` 并在注释里写明「Missing is an old protocol」），
  旧对端忽略即现行行为（§6 仍登记跨仓发布注意）。
- **顺带修好的静默断连（本轮最典型的「代码都在、语义被覆盖」）**：
  `GhostMcprSlot` / `GhostRevealSlot` 的 `getGhost: findAvailableGhost` → `findGhostForInstanceId`
  （管子反查表已按上游改为**物理实例键**，旧写法在 `_root__*` / `_ns__*` 安装上会静默失效），
  `meka-unity` 重试块内 3 次 `callGhostTool` 同批改传 `instanceId`。
- **存量兼容自检实测**：`RECEIPT_SCHEMA_VERSION = 2`（未 bump）、内容指纹 `cindy-ghost-content-v2\0`
  （未变）、`MAX_BASIC_CINDY_FILE_BYTES = 8 MiB` 与 `PLUGIN_MEMBER_UPLOAD_MAX_ARCHIVE_BYTES = 128 MiB`
  （两侧同值）、`validateGhostManifest` 内 `ok: false` 计数 **HEAD 44 / 上游 44 / 工作区 44**
  （未新增拒绝点）。
- **证据**：单文件 vitest 8 文件 158 用例全绿，跨包裁决修订后复跑 4 文件 83 用例全绿（取证非门禁）；
  175 个上游触及的 `cindy-brain/**` 文件逐个比对 Meka 标记数，唯一收缩是
  `ghostVisibility.ts` 1→0（原因见上，能力迁到 `ghost.ts` +5）。
- **残余风险**：`getGhostSetupAssessment` 不再接受逻辑 dev id（上游语义）；种子 submodule 在本
  worktree 未初始化，无法逐包核对是否自报 namespace。

### 2.2 插件 UI 投影（`wp6-plugins-ui`，9 文件 / 23 处冲突 + 9 个授权连带文件）

- 冲突文件全部按上游新结构解决，并接纳上游两笔产品决定：
  `226c83d31a`（删 `detail.cindyCapabilities` 与 `CindyCapabilityPrefs`）、
  `73b7cfc5a1`（**列表卡不再展示版本号**，元信息收敛为来源·作者·共享下载量；版本号改在详情页头
  `GhostPluginMetadata` 与 `DetailsSection` 呈现）。
- **`93f1393143` 对 Meka 入口的连带静默影响（全部是 0 冲突文件，已逐条修好并留证）**：
  Meka 渠道归属 `mekaInstalledGhostIdSet.has(item.id)` → 改按 `item.ghostId`（否则新装 Meka 插件
  被判到 Cindy 页）；开发目录 3 处查询改按 `ghostId`；「打开界面」面板直达改
  `findInstalledGhostByInstanceId` + 新增实例键用例；Modal 面板崩溃/熔断接管态改
  `installedGhostStoragePart(ghost)`；面板呈现方式开关拆成两个 key 空间
  （偏好 store 要**逻辑 id**、`setDetached` 要**实例键**，新增可选 `instanceId`）；设置页全局切 Modal
  时关分离窗口同批改。
- **测试**：`GhostPluginCard.test.tsx` 的版本行断言按上游改成正向断言，**两条「不得声称已是最新」的
  真正不变量原样保留**；`installFlow.test.tsx` 除补 `expectedInstalledInstanceId` 外，还须把文件导入桩
  补成 root 身份（上游把「拖入/双击」受体重解析换成 `findInstalledRootGhostForFileImport`，要求
  `namespaceState` 已确认）——同属这条最小适配。
- **证据**：单文件 vitest **253 passed / 0 failed / 21 files**（取证非门禁）；18 个文件 TS 解析器
  `parseDiagnostics` 全通过。
- **存量兼容**：唯一可观察差异是设置页高度缓存键由逻辑 id 变实例键（显示层，首个量高周期自愈）。
- **未实机目检 Light/Dark**（登记 §6）。

### 2.3 `maker-ipc` 运行时与 Orca 路由（`wp6-maker-ipc`，7 文件 / 18 处冲突）

- **`register.ts`（8 处，最大风险）**：Meka 的 WL-4.1.8 远端 bundle `ensure`/`bind` 块**移到**上游新增的
  「供应商组换电脑重试循环」`while (!session)` 之前只做一次，循环整体用外层 `try` 包住
  （成功 → release 旧 revision；失败 → `unbindSessionRemoteCodex` + 恢复旧 handle + release 新 bundle）。
  `try` 包住 `while` 后 TS 是否仍把 `session` 收窄为非 undefined，用 5 行最小复现跑
  `tsc --noEmit --strict` **取证通过**。
- 保留 Meka 的 `reconcileCreateOptsFromPersistedSession` helper（含 WL-3 Meka 会话身份守卫），
  并入上游新增的 `permissionMode` 回读，**删掉上游那份内联实现**（否则重复定义 + 绕过 Meka 守卫）。
- 上游把 `applyPersistedCindyMakeMarker` 移到 `bootstrapSession` 开头后，自动合并造出**两次调用**，
  已去重为上游位置唯一一次。
- **WL-4 源码级分类自检 4/4**：`register.ts` 共 4 处 `getRemoteSshPool().get(...)`
  （`:9000/:9017/:9060` 在 `ensureRemoteReadyForSessionStart`，`:9186` 在
  `refreshRemoteCodexMcpOnTurnSettledHolder`），逐处向回找同层函数起点，分类器均先出现；
  **顺序不变量实测 `:8991` 早返回 < `:8995 ensureRemoteHostReady(...)`**；
  三条 mcpr 分类/早返回探针全在（`:7997`、`:20875-20879`、`:14676-14686`）。
- WL-4.1.8 六步锚点全在（普通 SSH 明确抛错 `:8317`／成功 release `:8401`／失败 unbind+恢复+release `:8407`）；
  WL-4.2.1/4.2.2 全在（resolver 返回**注册表值**；MCPR Codex worker 强制 `providerId = 'xd'`）；
  **WL-25** 只读核对完整在位（`orcaLifecycleService.ts` 本轮为自动合并的 `M`）。
- 顺手修掉自动合并造成的两处真缺陷：`create_worker.ts` 的**重复 `- working_dir:` 描述行**、
  `OrcaWorkerCreateParams` 的**重复 `workingDir` 声明**（会 TS2300）。
- **证据**：43 条源码级断言 0 FAIL（复算 8 个受影响测试文件的 `indexOf`/`toContain`/否定断言语义）；
  `HEAD:` vs 工作区 `meka|Meka|MEKA|mcpr|MCPR` 计数零收缩（`register.ts` Meka 28→29，来自新增注释）。

### 2.4 `packages/maker-core` Agent 行为与 Agent Host（`wp6-core-host`，6 文件 / 12 处冲突 + 1 个授权测试文件）

- **`codex/index.ts`（7 处）**：全部是 Meka 字段（`nativeSkillRevision` / `nativeSubagentsDisabled` /
  `codexNativeSubagentsDisabled` / 两个 host key helper）与上游受邀者字段（`guestSession` /
  `deviceHostedGuestProviderId` / `LOCAL_GUEST_HOST_PREFIX`）的**并集**，唯一调用点与形参严格同序。
- **`maker-host/index.ts`**：接纳上游抽出的纯函数 `codexHostUsesSmartSubagentRouting(...)`，
  并在**调用点**补 Meka 的 `!disableNativeSubagents`（不把档位判据复制成第二份）。
- **`app_update.ts`**：接纳上游三工具判别联合结构；三条文案回到 `${BRAND_NAME}`（WL-6.5）。
- **`mcp-providers.ts` / `base-agent.ts` / `pi/index.ts`**：取上游（`mcp-providers.ts` 取 HEAD 会引用未定义变量）；
  `pi/index.ts` 为 import 并集，Pi 宿主技能快照**只做加法**（17 行，零新增拒绝/指纹/审批，
  `--skill` 仍排在项目 Skill 之前，argv 预算守卫仍在其后）。
- **上游抽取纯函数打红的 Meka 红线测试已修**：`maker-host/__tests__/codexNativeSubagentsDisabled.test.ts`
  用 AST 提取钩子体后求值，缺 `codexHostUsesSmartSubagentRouting` 与 `restrictCodexRoutesToGuestProvider`
  两个自由标识符 ⇒ `ReferenceError`（修复前 3 failed | 3 passed）。按授权补 2 个 import + 2 个
  `scope()` 键，**0 删除、0 动用例、0 弱化断言**，复测 **6 passed**；上游抽出的判据未内联回去。
- **实测锚点**：WL-4.1.13 **12/12** pool 查询钩子体内都有共享分类器（逐处行号见 `_analysis/wp6-core-host.md`）；
  `remoteCcQueryFactory` 的 mcpr 分支 `:1501` 分类 → `:1502 openMcprTunnel` → `:1503-1520`
  `openCcManagerSession` → **`:1526`** 才是 SSH pool + `:1528 remote ssh host not ready`；
  WL-4.1.5 三项成组（`:2330` 分类 / `:2337` transport / `:2377` credential mode / `:2206`+`:2225`
  thread register-unregister）；Codex 原生子代理硬关 8 个承载点全在且后续 spread 无法反悔；
  `MCPR_AGENT_UNSUPPORTED` 全仓 0 命中；maker-core 生产代码零 `mcpr:` 解析。
- **证据（单文件取证）**：`mcprPiTransport.test.ts` **25 passed**、maker-core Codex 红线 **7 passed /
  1017 skipped**、`send-outcome` **11 passed**、`mcprTunnelMeka` **2 passed**、
  `codexNativeSubagentsDisabled` 3 failed → **6 passed**；最小复现脚本两条
  （`scanned=12 offences=[]`、钩子自由标识符差集 `[]`）。
- **Meka 行存活扫描**：4 目录 83 个 Meka 改动文件，80 个 100% 命中，3 个文件缺 8 行且全是**有意替换**
  （格式/结构），`FILE ABSENT` = 0。

### 2.5 cc-agent / 侧栏 / 会话头（`wp6-sidebar`，11 文件 / 19 处冲突）

- 上游本轮**第二次重构顶行导航**：`2ce5ab565e` 把「伙伴」并入侧栏第一层
  （`sidebarNavigationPrefs` 删掉 `bots` 条目、`SIDEBAR_NAVIGATION_ITEM_ICONS.bots` 删除、
  `SidebarTopNav` 删掉 `bots` 动作 / `isBotsPath` / `ArrowLeft` / rail 伙伴瓷砖改 `return <></>`，
  rail 入口改由 `CCAgentSidebarUpper` 的 `CollapsedView` 承担）。Meka 行按新结构**重实现**：
  新增本地联合 `SidebarNavigationSlot = SidebarNavigationEntryId | 'meka'`（**不占偏好 id** ⇒ 结构性保证
  不进「更多」/「自定义」面板），槽位表一次 `splice` 插在 `automations` 之后，
  `renderRows(slots)` 供**三处**渲染共用（整段 + 搜索前后两段），顺手消掉第五轮遗留的下标补偿算式。
  rail 的 `mekaEntry` / `mekaTileIndex` 因该函数本轮未被上游改动而原样保留。
- **WL-2.1 / WL-2.2 / WL-2.5 白名单锚点已更新**（见 §6 与 `meka-whitelist-verification.md` 本轮改写）。
- WL-3.1（`nonMeka*` 派生链逐条在位）、WL-3.3/3.4（`MekaAssistantSection` 与 HEAD 一致，13 个依赖文件 +
  8 个共享导出全在）、WL-3.5、WL-4.2.4（`handleDeviceChange` 的 MCPR 守卫逐字保留）、
  WL-11.1–11.3 全部在位；5 个 0 冲突邻居经复核未被静默断链。
- **唯一功能收缩（已升级为待裁决项，登记 §6）**：`NewMakerDraftRoute.tsx` 的「MCPRouter 远程目标丢
  路径型附件」守卫按上游删除，**未做等价替代** —— 上游把它钉成两条**整文件**源码断言
  （`newMakerProjectPicker.test.ts` 禁 `dropPathBackedAttachments` 与
  `attachmentState.removeFile(f.id)`），任何改名/换变量的等价实现都会命中，那属于「绕过断言制造通过」。
  缺口是真实的（出站上传层只在 device-link，`mcpr:` 走隧道不经 `handleInvoke`），已就地写明并在 §6
  给出三选一。
- **证据**：文本级源码断言求值 `checked=352 failures=0`（扩到相邻文件 540，0 失败）——**不是测试执行**；
  全区域删除行扫描仅命中本包主动改写的 8 行；`meka` 计数无一收缩。

### 2.6 外壳 / 设置 / 工程脚本杂项（`wp6-shell-misc`，17 文件 / 36 处冲突）

- **`agent-island/state.ts`**：把上游的「换卡 + 清 `completionNotification`」与 Meka 的 WL-11.15 挂起清理
  **合成单一状态机**（挂起期 `running=true`，两者天然不竞争）；`AGENT_ISLAND_SILENT_STOP_HOLD_MS`（`:91`）、
  `holdSilentStopForResume`（`:1843`，两个 producer `:741`/`:833`）、`expireSilentStopHolds`（`:1884`）、
  单调时钟锚全在。
- **`cindy-make/versionStartup.ts`**：import 并集；WL-6.1 的「正本派生 `APP_NAMES` / `UNMARKED_APP_NAMES` /
  marker 词表，上游名只作 legacy 只读闭集」逐字保留，并接纳上游 `CINDY_MAKE_ENABLED` 门。
- **`bootstrap-electron.ts`**：日志上报**未加回**（`initLogUploadService` 无代码引用，只剩 divergence 注释），
  保留上游 `logSupport` 的「打开日志目录」；上游 `93f1393143` 在本文件的 3 处 namespace 改动都在。
- **`updateScriptMacOS.ts`(+测试)**：合成**一套**实现 —— 上游 glob 循环（BSD `find` 无 `-maxdepth`）
  + Meka「ZIP 根恰好一个同名 `.app`」精确闸 + 上游零-app 原文案分支；Meka 的四道身份闸
  （CFBundleIdentifier/Executable、`lipo -archs`、`codesign --verify`）与 rollback slot 保持 ⇒
  上游 2 条新用例与 Meka 3 条既有断言**同时成立、零断言改动**。
- **`restart-desktop-remote.mjs`(9 处)+测试**：全取上游（checkout 归属收窄 `commandBelongsToCheckout`、
  darwin 日志逃生口、`printFailedVerdict`、`?? null`），保住 `BRAND_USER_DATA_DIR_NAME = "CindyMeka"`
  与 `resolveStartupReadyTimeoutMs`；测试 import 取并集并去掉重复符号。
- **`AboutSection.tsx`**：WL-26 口径 = 不渲染/不 import 上报两行；「打开日志目录」改用上游抽出的共享
  `OpenLogsRow`（否则与外层锚点 div 撞同一 DOM id，settings-search 滚动会坏）。
- **`SettingsView.tsx`**：只留 `MekaAssistantSettingsSection`（WL-1.1 渲染块在位，`TAB_IDS` 顺序仍是
  `providers` → `meka-assistant` → `billing`）；**`UserInfoSection.tsx`**：WL-5.5/5.6 的运行期 `edition`
  前缀逻辑在位。**`ErrorBanner.tsx`**：WL-4.1.6 链完整（判定 → 分支 → 五语 key）。
  **`authIpc.ts`(+测试)**：`select-realm`（WL-5.6）与上游 `back` 并集。
- **`apps/mobile/src/session/sessionLinks.ts`**：import 并集，上游四笔手机深链改动全在；
  **未触碰任何冷更指纹输入**（详见 §6 的冷更门登记）。
- **`bot-import/__tests__/host.test.ts`**：三处取上游的确定性同步，未弱化断言。
- 双模式：本包未新增硬编码颜色；**Light/Dark 均未实机目检**。

### 2.7 i18n 五语（`wp6-i18n`，5 文件 / 14 处冲突）

- 做法是**逐 key 三方合并**（`ours == base ⇒ theirs`／`theirs == base ⇒ ours`／两侧都改才裁决），
  不从冲突块整体选边。**本轮不存在真双边冲突**：`both-modified` / `both-added-diff` /
  `delete-modify` 逐 leaf 均为 0 ⇒ 没有一条文案需要 Meka-vs-上游 的内容裁决；
  第五轮的 Meka 例外（`logic.errors.hostShellCommandBlocked`、`taskMigration.limits`、
  `taskMigration.defaultFolder` 孤儿键等）靠规则自动保住。
- 落地结果：en **13396** leaf / ja·ko·zh-CN·zh-TW 各 **13333**；`JSON.parse` 通过、逐层重复 key **0**、
  纯 CRLF 无 BOM；三方并集独立复算 `missing=0 / extra=0 / value-diff=0`；五语 key 集合一致
  （`missing=0 / type-conflict=0`，folded union 13238，复数家族 147）；en 多出的 63 条**全是 `_one`
  复数变体**（既有合法差异）。
- 品牌与不变量：12 条 `i18nBrandPlaceholder` 钉住键五语均含 `{{appName}}`；本仓含占位符的 61/62 键
  **零丢失**；`logic.errors.*` 五语平台专属措辞 **0**；Meka 独有 **576 键/语零丢失**（含 `meka.*` /
  `mekaSkills.*` / `slotMcpr` / `slotReveal`）。
- 删除面：五语一致删除 **61 键**（上游删 39、本仓删 23、同删 1），孤儿检查：真引用仅剩
  「零引用 46 条 + 前缀误报 2 条 + 上游改复数家族 1 条 + 仅负向断言/注释 1 条」⇒ **无孤儿**。
- 新增 9 个顶层命名空间（`menubar` 242、`providerShare` 205、`providerGroup` 126、`inputHandoff` 95、
  `teammateTodo` 74、`codexResets` 23、`mcpApps` 9、`groupTools` 8、`logSupport` 6）。
- **WL-26 收口（同一交付内）**：`logSupport.*` 按保留面/移除面切分 —— 保留 `title` / `localFiles` /
  `close`（被 `main/logSupport.ts` 与保留的 `OpenLogsRow` 引用），删除
  `uploaded` / `uploadDescription` / `uploadDetails`（全仓删后 0 引用）；19 条
  `settings.about.logUpload.*` 保持删除。
- **品牌收敛（本轮不动，登记 §6）**：上游本轮新增且值里写死 `Cindy` 的 **64 条**已逐条分类 ——
  「指应用自身、应改 `{{appName}}`」34 条 vs「指上游服务/账号/官方仓库/插件生态、应保持」30 条
  （清单见 `_analysis/wp6-i18n.md` 附录 A）。现行门禁钉住清单仍全绿。
- **未实机目检五语界面**（登记 §6）。

### 2.8 身份 / 构建（主代理）

- **`main/deepLink.ts`（1 处）**：冲突只在文件头注释块 —— 取 Meka 的身份叙述
  （生成一律 `cindy-meka://`、解析接受当前/Meka 历史/不注册的上游 `cindy://`）并**收养上游新增的
  `chat-invite/<token>` 形态**。合并结果实测：`DEEP_LINK_REGISTERED_SCHEMES`（`:52`）仍只遍历注册集合
  （`:641`）、`DEEP_LINK_INTEROP_URL_PREFIX`（`:54`）仍用于跨设备链接（`:242`/`:253`）、
  `cindy://` 仍「只解析不注册」；上游 `provider-share-join` / `chat-invite` / `islandEntryId` /
  `takePendingDeepLinkFromRenderer` 等全部并入。
- **`forge.config.ts`（1 处）**：冲突只在 import 块 ⇒ 并集：保留 Meka 的
  `assertMekaResourceTree` / `assertPackagedMekaResources`（打包不变量，`:1979` 前置断言 +
  `:2024` postPackage 复核），接纳上游 `prunePackagedRuntime` / `prunePackagedMigrationSnapshots`
  （`forge-prune-runtime`）、`copyRuntimeDependencyTrees as copyRuntimeTrees`（`forge-runtime-deps`）、
  `packagedResourcesPath`。上游裁剪只删 sqlite loader 源码/exceljs `dist` 与打包内的 migration
  snapshot，不触 `resources/meka`。

### 2.9 生成物与治理文档（主代理）

- **`docs/dev-rules/plugin-security-and-authoring.md`（2 处）**：① Forge 段取**并集** ——
  保留 Meka 的「安装根或**批准状态根**」+ `SOURCE_IS_INSTALLED_PLUGIN` + realpath **双向**挡别名，
  并收养上游新增的「目录内外均核对活跃任务的实际执行计划状态」（会话工作目录内措辞随上游改为
  「无需额外确认」，因为该新检查覆盖目录内外，与 Meka 旧的「直接放行」互斥）。
  ② 快问快答选型**取上游**：模型依次取插件详情「模型」字段 → 身份卡 `oneshotModel` → 系统辅助模型链；
  Meka 旧口径「选型不在插件手里」作废 —— **代码已随自动合并采用上游链**
  （`cindySlot.ts:1593-1601`，`:1614` 仍保留 `NO_CANDIDATE`），本仓接纳上游重设计（登记 §6）。
  另把 §3.1 末句「版本行照旧展示」改为「版本号只在详情页展示」（上游 `73b7cfc5a1`，见 §2.2）。
- **`docs/dev-rules/desktop-development.md`（2 处）**、**`environment-setup.md`（1 处）**：均为
  「两侧在同一锚点各自追加」⇒ **并集**（Meka 的启动超时/不得并行重复启动、ripgrep pin 流水线段
  与上游的 dev-terminal 日志、Electron binary 复核段并存）。
- **`docs/design-rules/design-inventory.md`（3 处，全在 GENERATED 区）**：不做语义判断，
  由 `node scripts/design-inventory.mjs` 重新生成（**57 个 surface**，人工区保留）。
- **`docs/legal/notices/**`（6 处）与 `apps/desktop/resources/THIRD-PARTY-*`**：由
  `node scripts/generate-third-party-notices.mjs` 重新生成（21 个文件；desktop 914 包依赖 +
  23/21 个非 npm 组件，mobile 618 包依赖）。
- **`pnpm-lock.yaml`**：自动合并；由 `pnpm install --frozen-lockfile` 验证（exit 0，见 §4）。
- **6 处硬编码上游 migration 序号 + 3 份文档引用随 D4 顺移 +3**（见 §3）。

## 3. D4 顺移追加（数据库谱系）

- **已发布谱系 `0000..0126` 零改动**：`git diff HEAD -- apps/desktop/drizzle` 只有
  `A meta/0127_snapshot.json`、`A meta/0128_snapshot.json`、`M meta/_journal.json`；
  Meka `0124`/`0125`/`0126` 三份 snapshot 实测 `HEAD = worktree = index`（
  `b13315daea97` / `999663e31626` / `687b2d980af6`）⇒ 三个 `AA` 冲突按 `:2:` 解、逐字节未变。
- **上游本轮新增 5 条 migration → Meka `0127..0131`**（+3，只改编号前缀、文件名后缀不变）：

  | 上游原号 | Meka 新号 | blob（`git hash-object` 实测） |
  | --- | --- | --- |
  | `0124_funny_glorian.sql` | `0127_funny_glorian.sql` | `e0ac49d1ecfb` **IDENTICAL** |
  | `0125_magical_night_thrasher.sql` | `0128_magical_night_thrasher.sql` | `ff619bfcb66b` **IDENTICAL** |
  | `0126_melodic_toxin.sql` | `0129_melodic_toxin.sql` | `5308d64123e6` **IDENTICAL** |
  | `0127_bot_group_task_posts.sql` | `0130_bot_group_task_posts.sql` | `dc7b43ac6485` **IDENTICAL** |
  | `0128_demonic_odin.sql` | `0131_demonic_odin.sql` | `0a35d7728fec` **IDENTICAL** |
  | `scripts/0124_funny_glorian.ts` | `scripts/0127_funny_glorian.ts` | `8352f0f7acc0` **IDENTICAL** |
  | `scripts/0125_magical_night_thrasher.ts` | `scripts/0128_magical_night_thrasher.ts` | `a355dc984b73` **IDENTICAL** |

  两条 companion 的职责：`scripts/0127_funny_glorian.ts` 建 `orca_remote_opens` 并给 `orca_workers`
  加列；`scripts/0128_magical_night_thrasher.ts` 给 `orca_workers` 补列。上游原号 7 个文件已从工作区消失。
- **新 snapshot `0127..0131`** = 上游同内容 snapshot **+ Meka delta（每份恰 15 项）**；
  剥掉 delta 后 `JSON.stringify` 与上游逐字符相等；逐行 diff 均 4 hunks / 284 新增行 / **0 删除行**；
  `id` / `prevId` 沿用上游，链从 Meka `0126` 的 `d06b22f6-84f0-4f67-b5ab-0f13f2e21a2a` 天然接上
  （上游 `0124` 的 `prevId` 正是它）；`_meta` 三子对象保持 `{}`。
- **`meta/_journal.json`**：127 → **132 条**，idx `0..131` 连续无重复；既有 127 条逐字节保留，
  新增 5 条沿用上游 `when` 且严格单调。
- **6 处硬编码上游原号的引用已同步 +3**（不改则静默失配）：`drizzle-split.spike.test.ts:140/146/273/279`
  （按文件名派发 companion DDL，不改会**静默不建** `orca_remote_opens` 与 `orca_workers` 列）、
  `botGroupTaskPostSnapshot.test.ts:26`、`DbClient.inproc.test.ts:194`、
  `plugin-usage/__tests__/service.test.ts:31`、`migrationReplay.test.ts:113/114/131/132`
  （`currentVersion` 124→127、期望 `[125,126,127,128]`→`[128,129,130,131]`、125→128、126→129）。
  另有 3 份文档引用同批改：`docs/acceptance/plugin-statistics-pr/{checks.json,README.md}` 与
  `docs/plugin-usage-statistics-implementation.md`（各保留上游原号作为历史对照）。
- **基线冻结结论**：`drizzle/migration-baseline.json` 只覆盖迁仓前 80 SQL + 23 script（两侧未改），
  `0123..0131` 不在其内；canonical 基线由 `scripts/lib/migration-freeze.mjs` 按 git ref 动态解析，
  **新增属合法追加 ⇒ 无需登记、无需改文件**。
- **未验证**：`test:migration-replay` 的真实回放（本轮 5 条 migration）由 §4 的 `test:db` 覆盖；
  **`drizzle-kit generate` 零 drift 比对未单独执行**（`db:validate` 的 step 3 覆盖 `check`）。

## 4. 验证

> 阶段 A/B/C 的实跑命令、原始日志与退出码；本节每行都是**跑出来的**。
> 原始日志：`_analysis/r6-gate-b.log`（首轮）、`_analysis/r6-gate-b2.log`（修复后干净复跑）、
> `_analysis/r6-gate-c-*.log`（阶段 C）。

### 4.1 阶段 A —— 结构审计（`pnpm audit:merge`）

命令：`node scripts/audit-merge-resolution.mjs`（审 index = commit 将包含的内容）。

**结果：`blockers=0 / dropped=0 / review=12 / generated=18`，`verdict: PASS (有待确认项)`，退出码 0。**
首跑为 `dropped=4`，逐条确认后带 `--allow` 记账重跑（命令与逐条理由见下）。

**4 条 `DROPPED` 的逐条确认**：

| 路径 | 形态 | 确认结论 |
| --- | --- | --- |
| `apps/desktop/src/renderer/components/log-support/LogSupportActions.tsx` | 上游 59/148 新增行缺失 | **WL-26 的刻意移除面**：只保留 `OpenLogsRow`（本地日志目录），删掉 `UploadLogsRow` / `UploadLogsActionRow` |
| `apps/desktop/src/renderer/components/log-support/__tests__/StartupLogSupport.test.tsx` | 上游 97/210 新增行缺失 | 同上：上报用例随之删除，改为「启动可见性 + 本地日志 + 不渲染上传动作」 |
| `apps/desktop/src/renderer/components/log-support/useManualLogUpload.ts` | 整文件被丢 | 同上：上报 hook 整体移除（其调用的 preload API `uploadLogsNow` 在第五轮已移除） |
| `apps/desktop/src/main/cindy-brain/ghostVisibility.ts` | 本仓 6/6 新增行缺失 | **跨包契约**：采用上游四参形态后 `GhostVisibilityDeps` 不含 Meka 的 `resolveGhostId`（该文件现与 `origin/main` 逐字节相同），别名能力迁到 `mcp-integrations/ghost.ts` 的调用侧封装 `resolveVisibilityGhostId` ⇒ 非能力丢失 |

**12 条 `REVIEW` 的逐条确认**（脚本只提示、不判对错，逐条给结论）：

1. `drizzle/0124_funny_glorian.sql` / `0125_magical_night_thrasher.sql` / `0126_melodic_toxin.sql` /
   `0127_bot_group_task_posts.sql` / `0128_demonic_odin.sql`（5 条「疑似按编号顺移」）：
   确认顺移为 Meka `0127..0131`，7 个文件（含 2 个 companion）`git hash-object` 与上游原号
   **逐字节 IDENTICAL**（哈希见 §3）。
2. `drizzle/meta/0124_snapshot.json` / `0125` / `0126`「== ours」：**正确** —— 这三份是 Meka 已发布编号的
   snapshot，实测 `HEAD = worktree = index`（`b13315daea97` / `999663e31626` / `687b2d980af6`）。
3. `drizzle/scripts/0124_funny_glorian.ts` / `0125_magical_night_thrasher.ts`：确认顺移为
   `scripts/0127` / `0128`，blob 逐字节一致。
4. `apps/desktop/src/main/cindy-brain/ghostVisibility.ts`「== theirs」：**正确**（见上表第 4 条）。
5. `docs/legal/notices/mobile-android.txt` / `mobile-ios.txt`「== theirs」：**生成物**，
   由 `node scripts/generate-third-party-notices.mjs` 重新生成（磁盘 = 索引），Meka 未分叉 mobile 依赖。

**18 条 `GENERATED`**：6 个 drizzle snapshot（0124–0126 为 Meka 已发布内容不动、0127–0131 按 §3 的
顺移流程构造）+ 11 个 legal notices（生成器重跑）+ `pnpm-lock.yaml`（`pnpm install --frozen-lockfile` 通过）。

另附**主代理独立复算**：`pnpm install --frozen-lockfile` **exit 0**（6m 1.9s，lockfile 与 manifest 一致）；
包清单并集核对（`apps/desktop/package.json` 与根 `package.json` 两侧脚本零丢失）；
`meka-injection/**` 文件清单与 HEAD 逐条一致（9/9）。

### 4.2 阶段 B —— 自动化验收

**首轮（`_analysis/r6-gate-b.log`）**：根级 check 家族、`db:validate`、`typecheck`（除 desktop）、
`test:db`（1 文件红）、`test:unit`（10 文件 / 14 用例红）、`test:device-link` 全绿；
`test:git-integration` 6 文件 / 33 用例红（超时类，见 4.4）。

**首轮暴露的 10 类红全部在本次交付内修好**（逐条给根因、归属与实跑证据）：

| # | 红点 | 根因 | 修的是 | 实跑 |
| --- | --- | --- | --- | --- |
| 1 | `desktop typecheck`（23 error / 9 文件） | 自动合并遗漏：① `orcaLifecycleService.ts` / `CreateWorkerPopover.tsx` 重复 `workingDir` 声明；② `WorkerInfo` 出现两份定义（上游把它收进 `workerProjectionStore` 并加 `agentDeviceId` / `executionDevice`，本仓 `useWorkers.ts` 仍留本地副本）；③ `registerIpc.ts` 的账本 preparer 参数被上游放宽为 `string \| InstalledGhost`；④ `installAndDock` 新增必填 `namespace` 而 Meka 两处开发目录装入调用点未交；⑤ `AGENT_UPDATE_FAILURE_REASONS` 的 `Record` 键集含 Meka 三个扩展状态；⑥ 上游新测试夹具缺 Meka 必填字段 | **实现（并集/单一事实源）** | `pnpm --filter desktop typecheck` → **exit 0** |
| 2 | `sessionsHiddenTasks.test.ts` 4 例（`no such column: sessions.meka_role`） | 上游新用例的 `CREATE TABLE sessions` 夹具缺 Meka 的 10 个会话列 | 夹具（照 `sessionsUpdate.test.ts` 同形补列） | 单文件 **5 passed** |
| 3 | `deepLink.test.ts` 2 例（期望 `cindy://consumed`） | 上游新用例把占位符写成上游 scheme 字面量，而本仓 `DEEP_LINK_PROTOCOL = 'cindy-meka'` | 用例（改用已导入的 `DEEP_LINK_PROTOCOL` 常量） | 单文件通过（与 4 条同批复跑） |
| 4 | `authLoginBack.test.ts` 2 例 | **harness 前言缺 Meka 依赖**：`loadLoginProviders` 的默认形参用 `authRealmForEdition(activeProductEdition)`（WL-5.6），上游新 harness 未提供 ⇒ ReferenceError 被当成 `AUTH_REQUEST_FAILED` 写进状态机 | 测试 harness（按 `authCredentialLoginRecovery.test.ts` 先例**源码切片**补入，不手抄实现） | 单文件 **7 passed** |
| 5 | `ghostWorkdirGate.test.ts` 1 例 | 上游 `93f1393143` 收紧后的 `forgeOutsidePackFlags` 现在对**目录内**打包也带上 `isCurrent`（授权代次复验），Meka 该用例用严格全等匹配 | 用例（显式四键 + 新增两条否定断言锁语义） | 单文件 **199 passed** |
| 6 | `CreateWorkerPopover.test.tsx` 3 例 | ① `window.electronAPI` 内外层夹具形态冲突（内层直接赋值撞只读）；②/③ **真回归**：合并造出两个 `workingDir` 生产者，`workingDir: undefined` 也是自有属性，违反上游「没选目录就不带键」契约 | 实现（三处改条件 spread：`CreateWorkerPopover.tsx`、`useOrcaWorkerSelection.ts`、`CCAgentSessionView.tsx`）+ 夹具形态 | 单文件 **67 passed**（+ 同能力组 `useOrcaWorkerSelection` 21 passed） |
| 7 | `updateScriptMacOS.test.ts` 1 例 | **实现缺陷**：上游用模板字面量 `` `for candidate in "${extractDir}"/*.app; do` ``，合成时误写成 JS 单引号 ⇒ `${extractDir}` 原样留在 shell 文本里；该脚本带 `set -u`，**真机会以 unbound variable 中止更新** | 实现（改回模板字面量；并审计全文件单引号条目） | 单文件 **11 passed / 4 skipped**（darwin-only） |
| 8 | `agent-island/state.test.ts` 1 例 | 上游新 `replaceAgentIslandCard`（写 `lastActivityAt` + 推进代数）被 `completeAgentIslandSession` 调用，而 Meka 的 `completeAgentIslandSessionWithoutAttention` 传的是结算处理时刻 ⇒ 未读 TTL 锚点被顺带延后 1s | 实现（解挂时保留真实活动锚点，`activityGeneration` 照常推进） | 单文件 **157 passed** + 服务层 **153 passed** |
| 9 | `updateService.test.ts` 1 例 | 夹具把**上游产物名** `cindy-updater.exe` 写进 `process.resourcesPath`，而 WL-6.5 的产物是 `cindy-meka-updater.exe` ⇒ 在 spawn 前就以 `updater_missing` 返回 | 夹具（改用派生名；接线本身未断：`spawn`/`on('spawn')`/`on('error')` 全在） | 单文件 **124 passed** |
| 10 | `cindy-make/taskWorkspace.test.ts` 1 例 | 环境 + 上游夹具：夹具用 `symlink(..., 'dir')`，本机实测 EPERM（`'junction'` 可用且 `isSymbolicLink()` 为真）；实现与 `origin/main` 逐字节相同 | 夹具（win32 用 `'junction'`，仓库既有先例），并让同文件 3 条原先空跑绿的链接用例**变成真跑** | 单文件 **45 passed** |

> 上述 5 / 6 / 7 / 8 / 9 / 10 的处理都**没有**删改或放松任何断言；3 条疑为负载/环境的
> （`authLoginBack` 之外的 `filePeer`、`readSheetProcessPackaging`）在**隔离复跑**下通过
> （4 文件同批：`1 failed | 3 passed`，唯一失败是当时尚未修的 `authLoginBack`）。

**修复后干净复跑（`_analysis/r6-gate-b2.log`）**：见 §4.3。

### 4.3 阶段 B 逐项结论（修复后干净复跑，`_analysis/r6-gate-b2.log`）

| 命令 | 退出码 | 结果 |
| --- | ---: | --- |
| `pnpm test:runner` | 0 | 全绿（WL-14 工具链自测 + 发布/身份自测 `meka-release-flow` / `meka-release-identity` / `brand-identity-sync`） |
| `pnpm check:endpoints` | 0 | |
| `pnpm check:i18n` | 0 | 五语键一致 |
| `pnpm check:i18n-glossary` | 0 | |
| `pnpm check:brand-terminology` | 0 | |
| `pnpm check:dev-docs` | 0 | |
| `pnpm check:design-inventory` | 0 | 生成物与源一致（57 surface） |
| `pnpm ci:scheduler-guard` | 0 | |
| `pnpm --filter mobile test:scope` | 0 | |
| `pnpm --filter desktop exec tsc -p scripts/device-link/tsconfig.json` | 0 | |
| `pnpm --filter desktop db:validate` | 0 | **6/6**：132 sql / seq `0000..0131`；journal↔sql↔snapshot 对齐 + `prevId` 链连续；`drizzle-kit check` **无 drift**；47 companion 全 CommonJS；固定 SHA256 基线 80+23；canonical 冻结 **127 SQL + 45 runtime script** |
| `pnpm --filter desktop typecheck` | 0 | 首轮 23 error → 0（修法见 §4.2） |
| `pnpm --filter mobile typecheck` | 0 | |
| `@cindy/maker-core` / `@cindy/maker-shared` / `@cindy/plugin-protocol` / `@cindy/lizi-mcps` / `@cindy/maker-cc-manager` typecheck | 0 | |
| `pnpm test:db` | **0** | 首轮 1 文件红（`sessionsHiddenTasks`）已修（§4.2 第 2 条） |
| `pnpm test:unit` | **1** | `apps/desktop unit` **PASS**（900.8s）、`apps/mobile unit` **PASS**（164.1s）、**各 package unit 全 PASS**；2 条环境依赖失败见 §4.4 |
| `pnpm test:device-link` | 0 | |

### 4.4 阶段 B 的 2 类环境依赖失败（逐条给机制，**不是本轮合并引入**）

1. **`packages/maker-core` 的 `claude-code/__tests__/device-hosted-guest.test.ts > keeps same-account
   hosted sessions unchanged`（1 例，隔离复跑同样失败：1 failed | 6 passed）**。
   失败断言是 `options.env.CLAUDE_SUBAGENT_MODEL === 'other/model-c'`，实得 `undefined`。
   **机制**：按设计，子代理定义扫描**只要发现任何 agent 自己声明了 `model:` 就不设该 env**
   （`subagent-model-default.ts:250-251` 的 `someoneDeclared` 分支）；而扫描的用户级根目录是
   `<CLAUDE_CONFIG_DIR>/agents`，**该变量缺席时回落到 `~/.claude/agents`**
   （`subagent-definitions.ts:196-198`，模块头 24-32 行明确写了这条回落）。
   本机 `C:\Users\XINDONG\.claude\agents` 有 **12 个文件、其中 10 个声明了 `model:`**
   （`model: opus` / `claude-ocx-native--*` 等）⇒ `someoneDeclared = true` ⇒ env 正确地不被设置，
   测试夹具（只隔离临时 `CLAUDE_CONFIG_DIR`）在这台机器上不成立。
   **归属**：上游本轮新增的用例（`A`）+ 开发机个人 Claude 子代理；`subagent-definitions.ts` /
   `subagent-model-default.ts` 与本用例涉及的 `index.ts` 区段**与 `origin/main` 逐字节相同**
   （`git diff origin/main --` 为空 / diff 只落在 438、3748-3904、4455 三处 Meka 自有追加）
   ⇒ **不是合并引入，也不是 Meka 能力回归**（生产行为就是「用户显式声明优先」）。
   建议（存量、本轮不改）：夹具除 `CLAUDE_CONFIG_DIR` 外固定用户级扫描根（或临时改 `HOME`/`USERPROFILE`），
   否则任何装过个人 Claude 子代理的开发机都会红。
2. **`apps/cindy-headless` 的 `src/codex-memory-bridge.test.ts`（1 例，隔离复跑通过）**。
   失败形态 `TypeError: fetch failed` / `Caused by: Error: bad port`。
   **机制**：该用例从 `bridge.port`（**随机 `listen(0)` 端口**）拼 `fetch('http://127.0.0.1:<port>/…')`，
   而 Node 的 `fetch`（undici）对一批**被禁端口**直接抛 `bad port`；随机端口偶尔落在禁端口段即红。
   **归属**：`apps/cindy-headless` 是本轮上游**新增的整个 app**（`d826f05738 feat(headless): 新增容器化
   Benchmark CLI 与 Linux 打包流程 (#4750)`），与 `origin/main` **逐字节相同**
   （`git diff origin/main --stat -- apps/cindy-headless` 为空）⇒ 上游自身的随机端口 flake，
   非合并引入。建议（存量）：固定一个非禁端口或对 `listen(0)` 结果做禁端口重试。

### 4.4b `test:git-integration` 的 Windows 环境限制（首轮 6 文件 / 33 用例红）

失败形态**全部是超时**（`Test timed out in 30000ms / 90000ms / 120000ms`），不是断言失败；
逐条取样见 `_analysis/r6-gate-b.log`（`upstreamMerge` 的 17 例、`featureHistory`、`personalBuild`、
`reviewSelfCheck` 等）。其中仅 `upstreamMerge.git-integration.test.ts` 与
`reviewSelfCheck.git-integration.test.ts` 本轮被上游改动，其余三份（`reviewSubmoduleIdentity`、
`workspace`、maker-core `scope-resolver`）与 `HEAD` 逐字节一致。
按第五轮同一口径在隔离下复跑 `upstreamMerge.git-integration.test.ts`：**仍为 17 failed | 7 passed
（全部超时形态，总耗时 675s）**，且第五轮已逐条登记该类为「Windows 环境限制
（junction / 符号链接 / 性能预算 / submodule 语义）」。
⇒ 本轮**未在本机取得 `test:git-integration` 的可判定通过证据**，登记为
**环境受限 + 未验证**；该套件在有意义的平台上由 `client-ci` 的 push 触发运行（推 `meka/main` 即门禁）。
### 4.5 白名单逐项结论（`meka-whitelist-verification.md`）

> 口径：**通过** = 本轮实跑或逐条打开文件实测成立；**未验证** = 有明确原因，已登记；
> 「定向取证」= 单文件 vitest 或源码级自检（不是门禁，但比读 diff 强）。

| 条目 | 本轮结论 | 证据 |
| --- | --- | --- |
| WL-1.1 设置侧栏入口与分区 | **通过** | `SettingsView.tsx` 的 `activeTab === 'meka-assistant'` 无门控渲染块在位；`TAB_IDS` 顺序仍 `providers` → `meka-assistant` → `billing`；`tabLabels.test.ts` 在 `test:unit` 内通过 |
| WL-1.2 MCPRouter 连接 / 注册 / 实例 / 工具 / route / 模板 | **未验证（+原因）** | 自动化侧本轮无文件改动；实机侧沿用第五轮结论：smoke 的「未连接态」前提在本沙盒不成立（已连接真实 MCPRouter 账号），第五轮旁证（四卡齐全 + MCPRouter 卡片已连接 + 61 个工具）仍然有效 |
| WL-1.3 MekaDesign 连接 | **未验证（+原因）** | 同上 |
| WL-1.4 P4 项目根 | **通过（自动化部分）** | `MekaAssistantSettingsSection` / IPC channel 常量本轮未被改动；`pnpm test:unit` 中相关用例通过；实机在阶段 C 的 Meka 会话创建路径被间接覆盖 |
| WL-1.5 插件面板呈现方式 | **通过** | WP-C 修好「偏好 store 要逻辑 id / `setDetached` 要实例键」两个 key 空间并新增双 key 断言；定向 2 passed |
| WL-1.6 / WL-1.7 风险分级与未配置门 | **未验证（+原因）** | 无自动化覆盖；本轮未改这些路径（属存量登记项） |
| WL-1.8 / WL-1.9 多域字段共存 / 旧设置只读迁移 | **通过** | `pnpm test:unit` 内相关用例通过；本轮无改动 |
| WL-2.1 顶部导航 Meka 入口行 | **通过** | 符号级实测：`onMekaMatch` / `mekaRow` / 槽位表 `SidebarNavigationSlot` + `renderRows(slots)` 三处共用（`:583-596`、`:631-632`、`:643`）在位；`pnpm test:unit` 全绿；**白名单锚点已随本轮结构更新** |
| WL-2.2 折叠态 Meka 入口图标 | **通过** | `CCAgentSidebarUpper.tsx:4236` / `:4272-4288` 与 `SidebarTopNav.tsx:368` / `:393` / `:424-426` 在位；rail 态位次规则未变 |
| WL-2.3 三页签管理页骨架 | **通过** | `PluginManagementLayout.test.tsx` 定向 **22 passed**；`pnpm test:unit` 全绿 |
| WL-2.4 Meka 路由族与旧深链重定向 | **通过（部分）** | 路由与重定向本轮未被改动；`PluginManagementLayout` / 四个 Meka 页面用例在 `test:unit` 内通过 |
| WL-2.5 Meka 段在侧栏的位次 | **通过** | `mekaSidebarOrder.test.ts` 在 `test:unit` 内通过；锚点实测 `3916 < 3954 < 4020`；**锚点已更新** |
| WL-3.1–3.7 Meka 会话分类 / 详情 / 头 / 侧栏族 | **通过（3.6 为强证据）** | 3.6：`localDb/ipc/sessions.ts` 的 `ALLOWED_WORKSPACE_KINDS` / `expectedWorkspaceKind` / `mekaProjectId` / `mekaRoleId` 守卫逐条在位；`nonMeka*` 派生链（`allGroups` / `allProjectGroups` / `groups` / `groupsWithPinnedProjects` / `unfilteredProjectSessions`）逐条在位；`pnpm test:unit` 全绿 |
| WL-4.1.1–4.1.14 MCPRouter 远程 | **源码级通过 / 端到端未验证** | 源码级：`register.ts` **4/4** pool 查询前都有共享分类器（`:8991` mcpr 早返回 **先于** `:8995 ensureRemoteHostReady`，对三引擎一律 return）；`maker-host/index.ts` **12/12** 钩子含分类器；WL-4.1.8 六步锚点全在；WL-4.1.5 三项成组；`mcprPiTransport.test.ts` **25 passed**、`mcprTunnelMeka` **2 passed**、`send-outcome` **11 passed**；**端到端 V1–V4 未验证（缺账号/实例/Gateway key）** |
| WL-4.2.1–4.2.4 Orca worker 目标与路由 | **通过（自动化）** | resolver 返回注册表值、MCPR Codex 强制 `providerId='xd'`、`handleDeviceChange` 的 MCPR 守卫逐字在位；`CreateWorkerPopover` 定向 **67 passed**、`useOrcaWorkerSelection` **21 passed**；`pnpm test:unit` 全绿 |
| WL-5.1–5.7 登录区域 | **通过 / 5.7 待裁决** | `authRealmPolicy.ts` 本轮**未被上游改动**且仍恒 `true`；`authManager.ts` 的 `PRODUCT_EDITION_KEY` / `readPersistedProductEdition` / `authRealmForEdition` / `resetActiveAuthRealmToBuild` / `selectLoginRealm` 全在；`brandIdentity.ts` 本轮**未被上游改动**（`CindyMeka` / legacy 目录集合原样）；WL-5.7 的裁决入口仍开放（§6.3 第 5 条） |
| WL-6.1–6.7 构建、更新链路与项目标识 | **通过（自动化）/ 真机未验证** | `pnpm test:runner` 内 `meka-release-flow` / `meka-release-identity` / `brand-identity-sync` 全绿（复跑日志）；`updateService.test.ts` 定向 **124 passed**（产物名派生式）；WL-6.5 验证现状已按本轮扩写登记；**真机更新验收未执行** |
| WL-8 Meka 技能链与技能市场 | **通过** | 本轮无改动；`pnpm test:unit` 全绿 |
| WL-9 Meka 插件链（渠道 + 开发目录） | **通过** | 五条契约实测：`channel:'meka'`、`pluginClientVersionReader('meka')`、`meka-ledger.v1.json`、8/128 MiB 双档、`ignoredRoundStorageKey` 旧键形态；**并修好上游实例键语义打断的三处 Meka 入口**（渠道归属、开发目录查询、面板直达） |
| WL-10 模型可见性与模型目录 | **通过** | 本轮无上游改动；`pnpm test:unit` 全绿 |
| WL-11.1–11.27 Meka 项目 / 角色 / 正式事项 | **通过（自动化）/ 实机部分** | `db:validate` 6/6 + `pnpm test:db`（复跑日志）；`sessionsHiddenTasks` 夹具补 Meka 列后 **5 passed**；`pnpm test:unit` 全绿 |
| WL-11.15 Pi 空回合兜底 | **通过** | `agent-island/state.ts` 定向 **157 passed** + 服务层 **153 passed**；两个 producer 与单调时钟锚在位 |
| WL-12 Meka 会话在横切域的守卫 | **通过** | 本轮无改动；`pnpm test:unit` 全绿 |
| WL-13 文案、术语与 i18n | **通过（品牌收敛批次登记）** | `check:i18n` / `check:i18n-glossary` / `check:brand-terminology` 全绿；五语键集合一致（`missing=0 / type-conflict=0`）；**34 条上游新写死的 `Cindy` 登记为下一批品牌收敛** |
| WL-14 同步流程工具链本身 | **通过** | `pnpm test:runner` 全绿（含 `audit-merge-resolution` 自测） |
| WL-16 Meka 注入层契约与能力矩阵 | **通过** | `meka-injection/**` 9 个文件与 HEAD 逐条一致（未被上游触及）；`maker-host/index.ts:2545 → :2550` 的 `_mcpProviders.pi` → `registerMekaCapabilities` 顺序正确 |
| WL-17 `.cshare` 绑定往返 | **通过** | 本轮无改动；`pnpm test:unit` 全绿 |
| WL-18 Pi 宿主技能快照与 Meka 运行时 MCP | **通过** | Pi 宿主技能快照**只做加法**（17 行，零新增拒绝/指纹/审批；`--skill` 顺序与 argv 预算守卫保持）；`meka-runtime-mcp.ts` 仍含 codex+pi |
| WL-19 Unity 只能走 Meka Unity 官方 CLI | **通过** | 本轮无改动；`pnpm test:unit` 全绿 |
| WL-20 / WL-21 / WL-22 / WL-23 读时回落 | **通过** | 本轮无改动；相关用例在 `pnpm test:unit` 内 |
| WL-24 随包 SAGA2 元数据基线 | **通过** | 本轮无改动；`meka-project-metadata` 相关门禁在 `test:unit` / `test:runner` |
| WL-25 Meka 项目首次派发 Worker 就地开团队 | **通过** | `orcaLifecycleService.ts` 只读核对：`createWorker:271` 就地 `startTeam:278` + 回滚三件套 + `assertCreatedCurrent` 完整在位；两条专用用例在 `test:unit` 内通过 |
| WL-26 Meka 不启用客户端日志上报 | **通过（本轮收口）** | 代码：删 `UploadLogsRow` / `UploadLogsActionRow` / `useManualLogUpload.ts` 与启动面板上传行，保留 `OpenLogsRow`；i18n：`logSupport.*` 保留 3 键、删 3 个上传专用键，19 条 `settings.about.logUpload.*` 保持删除；反回归自检由 `test:unit` 新用例守护（对话只有本地日志动作 + `uploadLogsNow` 不存在） |
### 4.6 阶段 C —— 实机验收

一键序列（隔离沙箱，不碰正式 profile），原始日志 `_analysis/r6-gate-c.log`：

| 命令 | 结果 |
| --- | --- |
| `pnpm restart:desktop:remote` | **exit 0**，`DESKTOP_DEV_VERDICT=ready`（"Desktop dev is ready (window + auth/local database, pid 84680)"） |
| `pnpm desktop:whoami` | **exit 0**，`Desktop source: MATCH`；活动实例 `pid=84680 root=C:\Workspace\cindy commit=4fa3b253d6`（= 本次合并前 HEAD；合并尚未提交，故 commit 行显示的是 HEAD）、`mode=isolated`、`region=global`、`userData=C:\Users\…\CindyMeka-dev2-dev` |
| `pnpm desktop:ui-smoke` | **13 / 15 通过，2 条失败**（见下，均为**已知前提失效**，非本轮回归） |
| `pnpm desktop:session-smoke` | **11 / 11 通过**（`SESSION_SMOKE PASSED — checks=11 pass=11 fail=0 unverified=0`） |

**`ui-smoke` 逐条结果（15 条）**：

- **通过 13 条**：WL-2.1（侧栏 Meka 入口位次 `["新建","自动化","Meka","插件","搜索","站点","伙伴"]` + 点击导航 + 激活态）、
  WL-2.2（rail 态入口）、WL-2.3（三页签与三条路由）、WL-2.4（`/meka-plugins` 重定向）、
  WL-1.5（插件默认打开方式开关 aria-checked 翻转）、WL-2.5+WL-3.3（Meka 段头存在且可折叠）、
  WL-3.2（分组树渲染）、WL-1.1（设置页「Meka 助理」位次 = 第 4 项 / 共 17 项，面板渲染）、
  **WL-1.2-1.5 四卡齐全**（插件打开方式 / P4 / MCPRouter / MekaDesign；P4 已匹配 5 个 saga2 子目录）、
  WL-5.5+WL-6.1（版本行 `Global · 0.0.0 · meka/main@4fa3b25` 与 HEAD 一致）、
  WL-6.5（Beta 渠道徽标）、**WL-10（草稿模型选择器非空且可展开，20 个选项）**、
  WL-13（五语逐一横切：English / 简体中文 / 繁体中文 / 日本語 / 한국어 均正常、无裸 key）。
- **失败 2 条**：`WL-1.2 MCPRouter「配置」可打开连接对话框`（"面板里找不到「配置」按钮"）与
  `WL-1.3 MekaDesign「配置」可打开独立连接对话框`（"面板里只有 0 个「配置」按钮"）。
  **与第五轮同一现象、同一原因**：该检查断言的是**未连接态**下的「配置」按钮文案，而本沙箱的
  MCPRouter 已连接（卡片显示已连接 / 「断开」），且**四卡齐全那一条是通过的** ⇒ 卡片并未缺失。
  第五轮已把这两条登记为「未验证 + 前提不成立」，并给出改造建议（扩成
  「已连接→断言『断开』/ 未连接→断言『配置』且能开对话框」双态覆盖）。
  **本轮未改造 smoke 脚本**（属存量工具缺口，不擅自扩大范围）⇒ 这两条登记为
  **未验证（前提不成立）**，不是失败。

### 4.7 阶段 D —— 结论

- 阶段 A：**PASS**（`blockers=0 / dropped=0`，4 条豁免与 12 条 REVIEW 逐条书面确认，见 §4.1）。
- 阶段 B：**除 2 类已定性的环境/存量问题外全绿** —— `test:db` / `test:unit`（`apps/desktop unit`
  **PASS**、`apps/mobile unit` 与各 package unit PASS）/ `test:device-link` / 全部 `typecheck` /
  根级 check 家族全部 exit 0；`test:git-integration` 为 Windows 环境限制（§4.4），
  `cindy-headless` 的 `codex-memory-bridge` 为上游新 app 的随机端口 flake（隔离复跑通过）。
- 阶段 C：`ready` + `whoami MATCH` + `session-smoke 11/11`；`ui-smoke` 13/15，2 条为已知前提失效（§4.6）。
- 白名单逐项结论：见 §4.5（无「失败」项；未验证项均已给原因）。

## 5. 生成物重生成记录

| 生成物 | 来源命令 | 结果 |
| --- | --- | --- |
| `pnpm-lock.yaml` | 自动合并 + `pnpm install --frozen-lockfile` | **exit 0**（6m 1.9s；lockfile 与 manifest 一致，未手工改） |
| `apps/desktop/drizzle/meta/0127..0131_snapshot.json` + `_journal.json` | D4 顺移（上游 snapshot + Meka delta；见 §3） | 每份 delta 恰 15 项、剥 delta 后与上游逐字符相等；journal 132 条连续 |
| `docs/design-rules/design-inventory.md` | `node scripts/design-inventory.mjs` | 57 个 surface；生成器只重写 GENERATED 区块、人工区保留；磁盘 = 索引 |
| `docs/legal/notices/**`（含 `sbom/*.spdx.json`）与 `apps/desktop/resources/THIRD-PARTY-{NOTICES,RESTRICTED}.txt` | `node scripts/generate-third-party-notices.mjs` | 写盘 21 个文件；desktop 914 包依赖 + 23/21 非 npm 组件，mobile 618 包依赖 + 8/9；磁盘 = 索引 |


## 6. 未验证 / 未完成 / 待裁决

> 本节是**未完成判定的兜底**：任何一项都不得被读成「已通过」。

### 6.1 未验证（有明确原因，需维护者书面接受）

1. **WL-4 全部端到端（V1–V4）**：需要 MCPRouter 账号 + 已绑定到 Meka 项目的实例（Claude / Codex / Pi）
   + 有效 Cindy AI Gateway key，且 MCPRouter 侧部署的 bundle pin 与客户端一致（本轮客户端 pin 已是
   `0.0.11`，服务端必须一致）⇒ 本会话不具备，登记「**未验证 + 缺账号/缺实例**」。
   客户端侧在位证据见 §2.3 / §2.4（源码级分类自检与定向用例）。
2. **WL-1.2 / WL-1.3（MCPRouter / MekaDesign 连接对话框）**：沿用第五轮的结论 —— 该 smoke 检查的前提是
   「未连接态」，而沙盒已连接真实 MCPRouter 账号；本轮未为了造前提去改动用户真实凭证。
   详见 §4 的阶段 C 结果与第五轮报告 §7 第 1 条（检查本身的双态覆盖属**存量工具缺口**）。
3. **Light/Dark 实机目检**：本轮 18 个 UI 文件有改动（插件 UI 9 个 + 侧栏/会话头 11 个 + 外壳 2 个），
   但**两种模式均未实机目检**（不得把「复用 themed 样式 / 未新增颜色」当成已验证）。
4. **五语界面实机目检**：`ui-smoke` 会做五语切换断言（见 §4），但**没有人工目检**字形/换行/截断。
5. **真机更新验收**（应用内更新、签名、发布渠道）：需真实签名与发布渠道，本轮未执行；
   `agent-app-update/**` 只做了类型自洽与品牌文案收口（WL-6.5 验证现状已同步登记）。
6. **移动端冷更实机**：见 §6.2 —— 本轮**改变了 runtime fingerprint 输入**，当前指纹已实测为
   `ios = 4b20dcf98be4ab3ea5e9120ad5754eedfdc8ee6d`、`android = f203410af72ae5958fd0d667ea354bcc98dcfef0`
   （`node apps/mobile/scripts/ci-fingerprint.mjs compute --output _analysis/r6-fp-current.json`，exit 0，
   工具版本 `0.20.13`）；**合并前的 base 指纹未计算**（需干净 checkout），本轮未做真机冷更验证
   （新商店包/自建重装）与存量装机影响实测。
7. **`test:git-integration` 的 Windows 环境限制**：**未在本机取得可判定的通过证据** —— 首轮
   6 文件 / 33 用例全红且**全部是超时形态**，隔离复跑 `upstreamMerge` 仍 17 failed（675s）。
   逐条见 §4.4b（与第五轮同源：符号链接/junction 语义、submodule 语义与 Windows 性能预算；
   相关生产代码与上游逐字节一致或本轮未改动）。该套件在有意义的平台上由 `client-ci` 的 push 触发运行。
8. **`packages/maker-core` 的 `device-hosted-guest.test.ts` 1 例**：**开发机环境依赖** —— 本机
   `~/.claude/agents` 有 10 个声明 `model:` 的 agent ⇒ 按设计不设 `CLAUDE_CODE_SUBAGENT_MODEL`。
   机制与字节级归属见 §4.4 第 1 条；**不是合并引入，也不是 Meka 能力回归**。
9. **`apps/cindy-headless` 的 `codex-memory-bridge.test.ts` 1 例**：上游新增 app 的**随机 `listen(0)`
   端口 flake**（`fetch` → `bad port`），隔离复跑通过；见 §4.4 第 2 条。
10. **`demo:legacy-migration`（旧身份只读迁移演示）**：本轮未跑（WP-C 判断插件面零影响，但未实证）。
11. **新建的 `apps/cindy-headless`（上游 `d826f05738`，#4750）**：整 app 原样接纳、与 `origin/main`
    逐字节相同；本轮**未做**它的容器化 / Linux 打包实机验证。

### 6.2 交付前置批准门（未获批准前不得推送）

1. **插件基座白名单批准门（放行人明确 Approve）**：本轮改动命中
   `docs/dev-rules/plugin-security-and-authoring.md` §5 点名的基座目录 ——
   `apps/desktop/src/main/cindy-brain/**`、`apps/desktop/src/main/plugin-market/**`、
   `apps/desktop/src/main/mcp-integrations/ghost.ts`、`apps/desktop/src/renderer/features/plugin/**`、
   `apps/desktop/src/renderer/cindy-brain/**`、`packages/plugin-protocol/**`。
   **存量插件兼容结论：无需重新安装、无需重新确认权限、无需重新配置**（实测
   `RECEIPT_SCHEMA_VERSION = 2` 未 bump、指纹格式 `cindy-ghost-content-v2` 未变、安装布局常量未变、
   `validateGhostManifest` 拒绝点 44/44/44 未新增）。**唯一用户可见影响**见 6.3 第 6 条。
2. **移动端冷更确认门（仓库指定把关人明确确认）**：本轮的 `apps/mobile` 改动**包含指纹输入**：
   `app.json`、`modules/**`（`cindy-html-preview` / `cindy-remote-credentials` / `cindy-speaker-onnx` /
   `xdt-ios-action-sheet` / `xdt-tapdb` 的 Kotlin/Swift/gradle/podspec/expo-module.config.json）、
   `plugins/with-android-release-optimization.js`。按 `docs/dev-rules/mobile-development.md`
   「冷更边界」，这与技术框架变动同级，**必须由把关人针对冷更明确确认后才能合并/推送**；
   提交者身份与普通 Approve 都不构成例外。本轮指纹实测值与来源见 §4。
   这些改动全部**来自上游**（`e57a79793b` R8 优化、`68d83f2a0d` ONNX 混淆闪退修复等），
   本仓未新增指纹输入；但**代价由全体存量装机承担**（拿不到本次及后续热更，直到装上新包），
   因此仍须走该门。**本轮实测指纹**：`ios = 4b20dcf98be4ab3ea5e9120ad5754eedfdc8ee6d`、
   `android = f203410af72ae5958fd0d667ea354bcc98dcfef0`（`node apps/mobile/scripts/ci-fingerprint.mjs
   compute --output _analysis/r6-fp-current.json`，exit 0，工具版本 `0.20.13`）。**base（合并前）指纹未计算**
   （需干净 checkout）；放行人若需要「前后对比」而非「输入清单 + 当前值」，需在放行前补算。

### 6.3 待裁决（本轮按接纳策略先行落地，列出可回退点）

1. **MCPRouter 远程目标的「路径型附件」缺口**（WP-F 发现，本轮按上游取）：
   上游 `d3873e96e2` 删除了 `NewMakerDraftRoute.tsx` 里的 `dropPathBackedAttachments`，
   并用两条**整文件**源码断言钉死（`newMakerProjectPicker.test.ts` 禁 `dropPathBackedAttachments` 与
   `attachmentState.removeFile(f.id)`）。但出站上传层**只在 device-link**
   （`main/device-link/ipc.ts:708` → 出站媒体上传），`mcpr:<instanceId>` 走隧道不经 `handleInvoke`，
   而 `rehomeDraftAttachments` 只重整图片 ⇒ **向 MCPRouter 实例派发时，非图片附件会把控制端绝对路径
   交给对端 agent**（读不到或读到同路径无关文件），且无提示。
   三选一：① 改那两条断言 + 恢复 Meka 作用域守卫（需该测试文件负责人配合，且必须是显式裁决）；
   ② 给 MCPR transport 补出站搬运（跨包，超出本包）；③ 登记为已知限制（**本轮即此**）。
   现残留：`remoteTarget?: boolean` 字段与 `remoteTarget: true` 调用点保留（测试逐字要求存在），
   但**目前无消费方**。
2. **Cindy Make 产品面整体关闭**：上游 `68d62d3d9f fix(cindy-make): 隐藏并禁用所有用户入口` 把
   `CINDY_MAKE_ENABLED` 置为 `false`（`packages/maker-shared/src/cindyMakeFeature.ts`）并加了
   32 处门与入口删除。本仓**按默认策略接纳**（白名单里没有 Cindy Make 条目，故未登记例外）。
   代码仍在磁盘上（上游刻意保留 checkout/历史/个人版构建），**回退点是一行常量**。
   若维护者要保留入口，须先登记 WL 项再改。
3. **快问快答（`cindy.text.oneshot`）选型口径**：上游把「主机轻量链唯一定」改为
   「插件详情「模型」字段（钉死不回落）> 身份卡 `oneshotModel` > 系统辅助模型链；每单现读」。
   **代码已随自动合并采用上游链**（`cindySlot.ts:1593-1601`，`:1614` 仍保留 `NO_CANDIDATE`），
   因此文档同步取上游、Meka 旧口径「选型不在插件手里」作废（§2.9）。如需保留旧口径，须改代码而不是文档。
4. **极老 Google 集成账号不再自动搬账**（§2.1）：`filo-google` 插件本体与既有凭证不受影响，
   但从未搬过账的用户需要在插件详情页手动重新授权一次。若要保留搬账，
   应在 namespace 架构下**重做为独立一次性迁移**，而不是恢复构建期 OAuth client 注入。
5. **WL-5.7 的区域闸门口径**（第五轮遗留，本轮未变）：Global 版是否接管 `xdt-maker` 历史 userData。
   本仓维持平铺模型（兼容红线），裁决入口与「必须同时改的四件事」写在 WL-5.7。
6. **品牌收敛批次（本轮不动）**：上游本轮新增且值里写死 `Cindy` 的 64 条已逐条分类
   （34 条指应用自身、应改 `{{appName}}`；30 条指上游服务/账号/仓库、应保持），
   清单见 `_analysis/wp6-i18n.md` 附录 A（含表 A-4 的 zh-CN 现值与 5 条边界项）。
   现行门禁 `i18nBrandPlaceholder.test.ts` 的钉住清单仍全绿；这 34 条需整句重写而非机械替换，属独立批次。
7. **本轮就地更正的存量文档漂移**（非本轮引入）：cc-mgr bundle pin 自**第五轮**（上游 `6ed04a977b`）
   已是 `0.0.11`，而 `meka-whitelist-verification.md`（WL-4.1.6）、
   `mcpr-remote-session-routing.md`（§4）、`agent-runtime-release.md` 仍写 `0.0.10` ⇒ 本轮就地更正为
   `0.0.11`（数值正本仍是 `packages/maker-cc-manager/src/protocol.ts`）。
   **跨仓注意**：MCPRouter 侧部署的 cc-mgr bundle 必须与 `0.0.11` 精确相等，否则 `protocol/hello`
   会拒（这是 WL-4.1.10 的既有闸门，不是新问题）。

### 6.4 存量缺口与观察项（**非本轮引入**，未擅自扩大范围）

1. `apps/desktop/src/main/maker-ipc/orcaInterAgentDispatcher.ts` 的 `params.workerSessionId`
   仍无读取方（第五轮已登记）。
2. `localDb/ipc/__tests__/sessionsRestoreIfArchived.test.ts` 的 `ExpectedIdentity.workspaceKind`
   联合不含 `'meka'` ⇒ resume 侧 `'meka'` 接受无测试覆盖（第五轮已登记）。
3. `MekaDevInstallReview.tsx` 与 `features/plugin/lib/permissionItemIcon()` 的图标映射分叉（第五轮已登记）。
4. `docs/dev-rules/plugin-security-and-authoring.md` 里引用的 `errandPrefsStore.ts` 全仓不存在。
5. `scripts/meka-session-smoke.mjs` 仍硬编码战斗角色（第五轮 §8.12 第 4 条第 7 项登记「待改」）。
6. `apps/desktop/src/main/maker-host/index.ts:3303` 的 `canUseRemote`（`hostId` 型 pool 探针）
   **未被 `mcpr-remote-session-routing.md §3` 的存量旁路清单登记**（三阶段一致、非本轮引入）；
   是否补进清单待裁决。
7. **三处未使用 import**（`NewMakerDraftRoute.tsx:61 RightSidebarToggle`、
   `SessionContentHeader.tsx:26 ChevronRight`、`:75 MENU_ROW_CLASS`）：`HEAD` 与工作区都在，
   非本轮引入；本轮未清理（存量问题不擅自扩大范围）。
8. `apps/desktop/src/main/__tests__/agentProcessPriority.test.ts:222` 注释仍写 `CindyGlobal`。
9. `?retired=<id>` 深链按 `manifest.id` 判存在、却把同一 id 交给 `findInstalledGhostByInstanceId`

10. **`pnpm check:dco` 在本仓库整体为红（存量，非本轮）**：本提交带
    `Signed-off-by: zhouwenkang <zhouwenkang@xd.com>`（与 author 一致，`git commit -s` 生成）；
    该脚本报的 **9 个缺签 commit 全部是本轮之前的历史提交**（`bbcef9d6` / `298a3991` / `1303745e` /
    `fc7a77b6` / `50e98ebf` / `33348870` / `fed5702c` / `775bce95` / `f6a5025f`，逐个
    `git merge-base --is-ancestor <c> 4fa3b253d6` 均为真），属初始迁移期的历史遗留。
    按 `AGENTS.md`「DCO」节口径，判定以 PR 的 DCO App check 与真实范围（`origin/main..PR head`）为准；
    修它需要 `git rebase --signoff` 重写 1300+ 提交，**属破坏性历史改写，本轮不做，需维护者另行决定**。
   （上游自身不一致，退役插件都是裸 id 旧装 ⇒ 当前无实际影响）。

## 7. 白名单与批准门

- 本轮**新增 Meka 白名单条目：无**（没有新增 Meka 专属能力）。
- **更新的白名单条目**：WL-2.1 / WL-2.2 / WL-2.5（锚点与注入结构随上游 `2ce5ab565e` 重写，
  见 §2.5）、WL-4.1.6（pin 更正为 `0.0.11`）、WL-6.5（Agent 侧更新入口扩到三工具 + 品牌要求扩写，
  见 §2.9）、WL-26（本轮收口代码/i18n/文档三面，含反回归自检）。
- **两个前置门已获批准（2026-10-16，维护者在本会话中明确裁决）**：
  1. **插件基座白名单批准门** = 维护者 **Approve**（依据：存量兼容结论「无需重装 / 重新确认权限 /
     重新配置」，`RECEIPT_SCHEMA_VERSION=2`、内容指纹 `cindy-ghost-content-v2`、安装布局常量、
     `validateGhostManifest` 拒绝点 44/44/44 全部未变；唯一用户可见影响 = 极老 Google 集成账号
     需手动重新授权一次）。
  2. **移动端冷更确认门** = 维护者 **确认接受本轮冷更**（认可「装新包才拿热更」的存量影响，
     指纹输入全部来自上游）。
- **提交范围**：维护者选择「**提交但不推送**」⇒ 本交付产出 `git commit -s` 的 merge commit；
  `push meka/main` 与 `client-ci` 验证另行授权。
- **批准门（留档）**：见 §6.2（两项均已获批，逐条依据如上）。
- 存量插件兼容红线核对结论：**无 P0**（逐条实测见 §2.1 与 `_analysis/wp6-plugins-main.md` §2/§3）。
