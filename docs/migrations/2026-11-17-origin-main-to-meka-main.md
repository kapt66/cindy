# 第八轮上游同步：`origin/main` → `meka/main`（2026-11-17）

> 本轮把上游 `origin/main` 的最新提交语义合并进本仓 `meka/main`。
> 上一轮（2026-11-06）报告见 [`2026-11-06-origin-main-to-meka-main.md`](2026-11-06-origin-main-to-meka-main.md)；
> 迁移总账见 [`xdmaker-meka-to-cindy.md`](xdmaker-meka-to-cindy.md)（本轮登记为 §11.38）。
> 接纳策略、波次与完成判定见 [`meka-whitelist-verification.md`](../dev-rules/meka-whitelist-verification.md)。
>
> **状态**：合并提交已成、阶段 A/B/C 按 §3 逐条实跑；**未验证项**在 §4 显式登记，**不得读成通过**。

## 1. 基线

| 项 | 值 |
| --- | --- |
| 本仓合并前 `HEAD`（产品线侧） | `74dd61d10f`（`meka/main`，2026-11-17） |
| 上游 `origin/main`（上游侧） | `e8b5e2fd965c70c30959fca3f1b3449b299ae61a`（2026-11-17） |
| `merge-base` | `b69985e79b31b557acc1de1797b13ad64fe32a7a`（= **第七轮登记的上游端点**） |
| 上游独有提交数 | **5047**（3308 非 merge + 1739 merge；`b69985e7..e8b5e2fd` ≈ 11 天） |
| 本仓独有提交数 | **212** |
| 上游本轮改动规模 | **8280 文件 / +972067 −201117**（本仓自 base 改动 1100 文件 / +176245 −33093） |
| Git 冲突路径 | **139**（130 `UU` + 2 `AA` + 6 `DU` + 1 `UD`） |
| merge 命令 | `git merge --no-commit --no-ff origin/main`（**无** `-X ours` / `-X theirs`；退出码 1 = 有冲突，符合预期） |
| 合并 worktree | `C:\Workspace\cindy-sync-1117`（分支 `sync/origin-main-20261117`） |
| 合并提交 | 双父 `74dd61d10f` + `e8b5e2fd96` |

`merge-base` 恰好等于第七轮的上游端点，因此本轮只接纳上游在这 5047 个提交里的新增内容；
第三轮（2026-09-23）、第四轮（2026-09-25）、第六轮（2026-10-16）、第七轮（2026-11-06）的裁决继续有效。

冲突按能力组路由给 9 个并行解决工作包（`_analysis/wp8-*.md` 为各包原始报告）：

| 组 | 冲突路径（代表） |
| --- | --- |
| 数据库谱系（D4） | `drizzle/meta/{0148,0149}_snapshot.json`（2 `AA`）+ `localDb/{ipc/sessions,migrationReplay,DbClient.inproc,drizzle-proxy-perf}` |
| 插件基座 / 面板 / 市场 | `cindy-brain/{index,pipeDispatcher,pickSlot}`、`plugin-market/{service,api}`、`mcp-integrations/ghost`、`preload/{preload,ghostPreload}`、`renderer/features/plugin/{GhostPluginPage,MarketPluginDetailView,GhostPluginIcon}`、`renderer/cindy-brain/ghostPanelBody`、`cindy-tools/src/ghost/mcpServer`、插件作者手册 |
| maker-ipc / Orca / lizi-mcps | `maker-ipc/{register,makerSendTransaction,orcaInterAgentDispatcher,orcaTeamService,orcaWorkerCreationService,agent-input-coordinator}`、`orca-workflow/*`、`lizi-mcps` create/archive |
| maker-core / Pi / maker-host | `maker-core/src/agents/{base-agent,codex/index,pi/*}`、`maker-host/{index,session-storage,cc-manager-client}`、`mcp-integrations/{mcp-providers,codexHttpBridge,codexEnvironment}`、`maker-shared/tsconfig.json` |
| 侧栏 / 设置 / 新会话 / 杂项 UI | `SidebarTopNav`、`SessionContentHeader`、`NewMakerDraftRoute`、`CreateWorkerPopover`、`new-chat/*`、`SettingsView`、`router.tsx`、`tabLabels`、`LocalDbFatalScreen`、`ccMgrUpgradeStore` |
| 身份 / 构建 / 更新 / 脚本 / 生成物 | 根 `package.json`、`pnpm-lock.yaml`、`bootstrap-electron`、`deepLink`、`authManager`、`updateService`、`manifestService`、`scripts/{restart-desktop-remote,test-workspaces,shared/desktop-dev-node-options}`、SBOM 生成物 |
| i18n | desktop 12 语 `common.json` + mobile 5 文件 + `i18n/glossary.json` |
| 治理 / 规则文档 | `AGENTS.md`、`docs/dev-rules/*`（11 份） |
| WL-26 日志上报退役 | `shared/logUpload.ts`、`log-upload/{index,uploadCode,types}`（3 `DU`）、mobile `diagnosticUpload`（2 `DU`）、`performance-trace/*`、`LogSupportActions` |

> 另有 1 个**未分组** `UD`：`maker-ipc/__tests__/botGroupTaskPostSnapshot.test.ts` —— 该文件由上游
> `ffa6a3b8e2` 引入、上游本轮删除其被测模块 `botGroupTaskPostSnapshot.ts`；本仓侧唯一改动是把 SQL 文件名
> 顺移成 Meka `0130`。**按上游接受删除**（仓库内已无任何引用）。

## 2. 逐组解决结论

> 各工作包的原始报告在 `_analysis/wp8-*.md`（该目录由 `.git/info/exclude` 排除，不入库）。
> 本节只记「最终有效行为 + 决定归属 + 证据 + 残留风险」。

### 2.1 数据库谱系（`wp8-db-report.md`）

- **偏移 +3 用 blob 相等证明**：上游 `0145`≡Meka `0148`、`0146`≡`0149`、`0147`≡`0150`；上游本轮新增
  `0148_schedule_webhook_trigger` / `0149_damp_wind_dancer` ⇒ Meka **`0151` / `0152`**。
- **SQL 与 companion 逐字节取自上游**（`0151_schedule_webhook_trigger.sql`、`scripts/0151_schedule_webhook_trigger.ts`；
  上游 `0149` **无** companion，未凭空补造，companion 仍 53 个）。上游原号 3 个文件已移出工作区。
- **两个 `AA` snapshot 取 `:2:`**（实测与合并前 `HEAD` 逐字节相同）；`0148/0149/0150` 已发布谱系零字节改动。
  新 snapshot = 上游同内容 + **Meka delta（每份恰 15 项）**，变换用**三重对照**验证（上游 `0145`→`0148`、
  `0146`→`0149`、`0147`→`0150` 全部逐字节相同）；`0151.prevId` = `0150.id`、`0152.prevId` = `0151.id`。
- **`meta/_journal.json` 重建**：合并自动结果是 153 条但 idx `148`/`149` 各出现两次（**无效中间态**）⇒
  重建为 **153 条、idx `0..152` 连续无重复、153 唯一 tag**，既有 `0..150` 段逐字节取自 `HEAD`。
- **对象碰撞：无**。`schedules.webhook_trigger`、`schedule_runs.trigger_source`、`mcp_app_view_states`
  在 Meka 已发布 schema 与全部历史 SQL/companion 中零命中；两条新 migration 全文**无 `DROP`**
  ⇒ 不会删 Meka companion 建的 `hook_group_message_stats_*`（不同于第七轮 `0139` 的坑）。
- `localDb/ipc/sessions.ts` 取上游委托 `createUserSession(...)`，Meka 语义（`'meka'` 白名单/类型、
  项目+角色+formal 校验、`validatedCreateBody`、工作目录解析、recent-workdirs 收录）**重挂进上游新增的**
  `localDb/ipc/createUserSession.ts`，未保留第二份实现。
- **实跑**：`db:validate` **6/6 PASS**（153 sql / seq `0000..0152`、journal↔sql↔snapshot 对齐且
  `id`/`prevId` 链连续、`drizzle-kit check` 无 drift、153 snapshot、53 companion 全 CommonJS、
  固定基线 80 SQL + 23 script、canonical 冻结 151 SQL + 52 script）；`migrationReplay` / `DbClient.inproc`
  在 db tier 内实跑（见 §3）。

### 2.2 插件基座 / 面板 / 市场（`wp8-plugins-report.md`）

- 21 个分派文件 + **1 个清单外必要接线** `mcp-integrations/ghost.desktop.ts`（上游新增网关装配器；
  不打点会让 meka-unity / 开发目录映射在 Desktop 静默失效），共 22 文件、50 hunk 全解。
- 上游把 `mcp-integrations/ghost.ts` 改成**共享网关工厂**（`apps/host` 直接 import）⇒ Meka 四个依赖
  （`resolveGhostRuntimeId` / `resolveGhostLogicalId` / `ensureMekaDevPluginsReady` / `requestGhostHostConfirmation`）
  改为**可选端口**，缺省恒等/空操作/**fail closed**；未在 Host 侧建立第二份实现。
- `preload/ghostPreload.ts` 全交上游 `createGhostPageBridge`，只在同 `window.cindy` 挂 `reveal` + `mcpr`；
  tabView 分支随上游删除。`GhostPluginPage.tsx`（15 hunk）上游 catalog-memory 架构为宿主，Meka 三态面板、
  开发目录状态、`ignoredRoundKey` 渠道分桶、`importCindyFile` + 账本归属、`handleInstallDevelopment` 全保留。
- **存量兼容自检（实测）**：`RECEIPT_SCHEMA_VERSION = 2`、内容指纹 `cindy-ghost-content-v2\0`、
  8 MiB / 128 MiB / 256 MiB 上限、`meka-ledger.v1.json`、`adoptLegacyInstallations=false`、双档 8/128 MiB
  注入点**全部未变**；**新增拒装点 0**（上游唯一新严格校验是 `agent.hostTools` 类型，只在
  `!preserveHistoricalTasks` 路径）。
- **主代理收口**：`GhostPluginPage.tsx` 合并自动结果有两处硬伤（重复 `useState` 声明、`availableMarketItems`
  未定义），已修 —— 后者按 Meka 前台需要，把 Meka 自己的「按来源筛选的市场条目」派生（`searchedAvailableMarketItems`
  / `availableMarketItems`）**就地保留**在上游新骨架上，两段纯函数逻辑无第二份实现。

### 2.3 maker-ipc / Orca / lizi-mcps（`wp8-makeripc-report.md`）

- `register.ts` 10 处全解，**未做机械并集**：① MCPRouter 早返回仍在 `ensureRemoteHostReady` **之前**
  （实测 `:10396` 早返回 < `:10401` 唯一一次 ensure）；② 创建 funnel 只留一套 `bootstrapSessionOnce` +
  in-flight 包装，并入上游 `createSessionWithRuntimePlugins` / `withSharedSessionResumeRecovery` /
  `prepareGuestStartSwitch`，**删掉被 git 塞进 bundle 块的旧循环体副本**（本轮最易漏点）；
  ③ WL-4.1.8 bundle 块仍在重试循环前一次、外层 try + 成功 release / 失败 unbind 恢复；
  ④ 授权缝一套 `authorizeCall` + `withToolCallAuthority`（`authorizeToolCall` 零命中）；
  ⑤ `wait_for_worker` 保留（22 工具，与文档一致）。
- **上游搬家 ⇒ Meka 不变量跟着搬**（范围外但必需）：`modelRouteAdmission.ts`、
  `sessionRuntimeSelectionApply.ts` 各补 `classifyRemoteSessionTransport(...) === 'ssh'`
  （否则 MCPRouter Codex 的创建 / SET_MODEL 会重新落 `SSH_EXEC_FAILED`）；
  `sessionOptionsReconciler.ts` 承接 WL-3 归属身份守卫与 §6.33 `requirePersistedSession` / fail-closed。
- auto-bridge 取上游形态（`autoBridge:true` / `report` / `reportClientId`，删死字段 `workerSessionId`）；
  `agent-input-coordinator` 按上游 `preservesAutoResume` 形参重挂 orca 例外
  （只挂「放弃失败轮 Retry」那一处，不影响另 3 处既有语义）。
- **主代理收口**：`orcaTeamService.test.ts` 的 3 处 5 参断言（Meka 上一轮遗留）改回上游 3 参形态，
  该文件现与 `origin/main` **逐字节相同**。
- **实跑**：lizi-mcps 5 文件 **104 passed**；orca-workflow bridge-prompt **18 passed**；
  desktop 四文件 **447 passed**（2 条失败**仅因 `better-sqlite3` 原生绑定在并发安装中缺失**，重装后随 db tier 复跑）；
  `orcaTeamService` + 契约 + reconciler + treeResume + botBaselineRecovery **5 文件 288 passed**。

### 2.4 maker-core / Pi / maker-host（`wp8-core-report.md`）

- **Pi 侧零新增阻断**（`pi-harness.md` 非退化红线）：`cindy-bridge-source.ts` 只并集上游 `displayName` 显示名 +
  Meka `connectedServers` 记账；披露门 / schema 指纹 / `UNKNOWN_SERVER` 文案 / `disclosureSignpost` 一字未改。
  `pi/index.ts` 只并集「上游资源漂移检测 + Meka argv 超限诊断日志」与 Skill 根折叠；**未改** `apps/pi-bin/**`、
  版本 pin 与安装/扩展加载路径。
- **Codex 宿主大重构（310 行）**：上游把本地装配抽到 `codexSpawnConfigCore.ts`，`index.ts` 只留
  `prepareRemote` + `proxy`；Meka 语义（`codexNativeSubagentsDisabled` 硬关、`nativeSkillRevision` 快照根注册）
  重挂到新结构。
- `session-storage.ts` 改 `extends OwnerSessionStorage`（同一语义只留一份）并顺带修掉合并残留的多余 `});`；
  `mcp-providers.ts` 取上游共享实现（`gateBuiltinMcpProviders` / `createHistoryToolCallbacks`，与 Meka 旧内联版逐句一致）。
- **刻意偏离（登记回退点）**：proxy 未就绪改按上游 **fail-closed**，Meka 的 gateway-key 兜底消失（回退点见报告 §3）；
  `authAdaptersImportPurity` 删掉 Meka 的 Windows skip（上游把 import 提到模块作用域消除了超时诱因，断言全留）；
  `codexAuthIsolatedSandbox` 参数化用例里 `'CindyGlobal'` 换回 `brandUserDataDirName(CURRENT_CINDY_REGION)`。
- **跨出清单的 4 处重挂（各 1–6 行，已登记）**：`codexSpawnConfigCore.ts`（原生子代理硬关）、
  `localDb/sessionStorageAdapter.ts`（补回 `workspaceKind:'meka'`，WL-3.6）、`codexEnvironment.ts`
  （工厂化后补 `CODEX_MCP_TOKEN_ENV` / `CODEX_MCP_TIMEOUT_SEC` / `codexTomlString` 模块导出）、
  `codexHttpBridge.ts`（去重复声明，保留 Meka `FETCH_SAFE_PORT_MAX_ATTEMPTS`）。

### 2.5 侧栏 / 设置 / 新会话 / 杂项 UI（`wp8-ui-report.md`）

- **侧栏三处渲染路径（WL-2）**：保留 HEAD 的槽位表（`SidebarNavigationSlot` / `mekaRow` / `splice` /
  `renderRows(slots)`），套到上游新骨架（`pluginNavigation/pluginRows`、`searchRowRef` clipPath 观察器）上；
  实测三处（整段 `:734`、搜索前段 `:675`、搜索后段 `:692`）+ rail `mekaTileIndex :381` 与
  `mekaEntry :414-416`（调用方 `CCAgentSidebarUpper.tsx:4321` 未断）。
- **路由（WL-2.4）**：四条 `meka/*` 在 `:109-112`，全部早于 `:sessionId`(`:133`)；`/meka-plugins` 重定向
  `:281-284` 保留；上游 lazy 路由 + `HydrateFallback` 全收。
- **设置页签（WL-1.1）**：真源随上游上移到 `packages/maker-shared/src/settingsTabs.ts`（`tabLabels.ts` 只 re-export），
  `meka-assistant` 仍在「模型供应商 → 计费」之间、`activeTab === 'meka-assistant'` 分支无门控。
- **跨组加性改动（3，已追认）**：① `packages/maker-shared/src/settingsTabs.ts` 登记 `meka-assistant`
  （不改则 WL-1.1 页签整条消失、`get_settings_link` 也给不出深链）；② `renderer/cindy-brain/importCindyFile.ts`
  加可选 `onInstalled` 透传给 `installFlow`（否则上游把 `.cindy` 分流收进该 helper 后 Meka 渠道归属丢失）；
  ③ 三条 Meka 管理页路由**未 lazy 化**（`design-inventory.mjs` 的 `routeEntryComponents` 按组件名精确核对且需
  `surface="meka"`，要跟上游 lazy 须同步改该脚本 —— 单列待裁决，见 §4）。
- 接受上游删除：`CreateWorkerPopover` 的 `customRoleError`（改按内置角色解析）、会话头远程 Agent 设备 chip、
  `agent-island` 测试顶部 `i18n.js` 的 `setMainLocale`（改 `i18n.desktop.js`）。
- **主代理收口**：`AuthState.edition`（WL-5.6 跨层身份字段）在两处上游新测试 fixture 里缺失，已补
  `edition: CURRENT_CINDY_REGION`（**测试 fixture 补字段，断言未弱化**）。

### 2.6 身份 / 构建 / 更新 / 脚本 / 生成物（`wp8-identity-report.md`）

- **身份字面值零改动**（逐文件比 `:2:` 与结果）：`CindyMeka` / `com.xd.cindy.meka` / `cindy-meka` /
  `x-cindy-version` 除 `deepLink.ts` 注释重排（值逐字未变）外**新增 0 / 删除 0**；
  `brandIdentity.ts:164 updaterName:'cindy-meka-updater'`、`brandRegion.ts com.xd.cindy.meka` 全在。
- `deepLink.ts` 取上游完整注册条件（`!isPackaged || --smoke-test || --no-protocol-registration`）——
  只留 `!isPackaged` 会打红上游新用例；遍历仍 `DEEP_LINK_REGISTERED_SCHEMES`（排除 `cindy://`），
  上游新增 `gift/<code>` 与 `settings/im-bot` 条目改写成 `cindy-meka://`（`cindy-meka://` 9→11 处）。
- `authManager.ts`：上游把 `AUTH_SESSION_KEY` / `AUTH_ACCOUNT_VAULT_KEY` 搬进 `./authCredentialKeys` ⇒
  只保留 Meka `PRODUCT_EDITION_KEY`；冷启动可重试流程**零回退**（`cold-start-realm-manifest-unavailable` 零命中，
  `activeProductEdition = readPersistedProductEdition() ?? CURRENT_CINDY_REGION` 在位）。
- `bootstrap-electron.ts`（5 处）：`check-environment` 取上游 localOnly 形态；`registerMekaSettingsIpc` +
  `registerCindyFileIpc` 并集；**接 `initCrashDiagnosisService()`、不接** `initLogUploadService()` /
  `scheduleStartupBackfill()`（WL-26，见 2.7）。
- 根 `package.json`：Meka 独有 **16** 条脚本全留 + 上游新增 **12** 条全收（丢失 0 / 未收 0）；
  `test:runner` 并集 **53** 项（刻意剔除已随上报面删除的 `log-upload-build-env.test.mjs`），53 项全部存在。
- `restart-desktop-remote.mjs`：600s + 30s/30min 夹取保留（上游退回 180s 未采纳）、`CindyMeka` 与
  `CindyMeka|CindyMekaDev` 正则、fail-closed 进程表扫描均在位。
- SBOM ×3 整份取上游 `:3:`（`git hash-object` 三份字节全等），未手改。
- **主代理收口**：① `legacyUserDataMigration.ts` 的合并结果引用了不存在的 `userId`（上游形参是 `userId`、
  Meka 形参是 `user`）⇒ 改 `user.id`；② `scripts/desktop-whoami.mjs` **删除 Meka 上一轮的一处偏离**
  （「跳过 crashpad 子进程」）—— 上游新用例要求 crashpad 的 `--user-data-dir` 就是 profile 来源，
  尾部 `/prefetch:N` 由 `extractArgumentPath` 的边界正则剥掉；保留旧过滤会让 `userDataDir` 变 `null`
  （实测 `test:runner` 1 例红，修后 **104 例 99 pass / 0 fail / 5 skip**）。

### 2.7 WL-26 日志上报退役（`wp8-wl26-report.md`）

- **保留我方（去上报）**：`shared/logUpload.ts`（只留 `LogUploadReason`）、`log-upload/types.ts`（只留采集形状）、
  `performance-trace/retention.ts`、`performance-trace/index.ts`、`performanceTrace.test.ts`（删上游 4 个上传/还原用例）、
  `LogSupportActions.tsx`（删 `UploadLogsRow` / `UploadLogsActionRow`，**保留**上游对 `OpenLogsRow` 的样式刷新）。
- **保持删除**（合并把它们写回磁盘，工作区已删）：`log-upload/index.ts`、`log-upload/uploadCode.ts`、
  `log-upload/__tests__/{crashTriggersAndCode,logSink}.test.ts`、`mobile/src/debug/diagnosticUpload{,.test}.ts`。
- **两处非冲突「静默合入」已纠偏**：① `performanceTrace.test.ts` 的保留期用例被上游改成
  `it.each(['','CN-','GLOBAL-','DEV-'])`（前缀目录也要清理）—— Meka 本地 ID 无前缀，该用例必红，已改回单例
  并保留「近似名不得删除」断言；② 上游给上传编号加区域前缀（`formatUploadCode` / `isFormattedUploadCode`），
  `retention.ts` + `index.ts` 是**诱饵入口**，全部不接。
- **`crashTriggers` 窄例外（主代理裁决，方案 A）**：上游新增的 `main/crash-diagnosis.ts` 是**纯本地**崩溃诊断
  （无网络、无上报目标），只消费 `isFatalCrashReason` ⇒ 以**极窄形态**保留
  `main/log-upload/crashTriggers.ts`（**只含该函数**；补传三函数禁止加回），
  `bootstrap-electron.ts` 接 `initCrashDiagnosisService()`。preload / `vite-env.d.ts` 五个上报 API 继续不声明、
  三个本地 crash-diagnosis API 保留。
- **采集/脱敏仍可用的证据**：`log-upload/` 现存 9 模块（`redact`/`collect`/`collectRuntime`/`mainLogReader`/
  `agentLogReader`/`sourceAllowlist`/`limits`/`types` + 窄 `crashTriggers`），`redact.ts` 本轮 **0 diff**；
  上游采集面净新增（`device-link:*` 精确 scope）保留。
- **实跑**：`vitest run src/main/log-upload/__tests__ src/main/performance-trace/__tests__ src/main/github-issue/__tests__/issueDiagnostics.test.ts src/renderer/components/log-support/__tests__`
  → **10 files / 275 tests 全绿**；反回归搜索（`generateUploadCode` / `submitPerformanceReport` /
  `uploadPerformanceTraceReport` / `traceRedactionWorker` / `restore-performance-report` /
  `isFormattedUploadCode` / `formatUploadCode` / `MAX_LOGS_PER_BATCH`）**代码 0 命中**。

### 2.8 i18n（`wp8-i18n-report.md`）

- **做法**（与第七轮一致）：三方 `git cat-file blob` 字节级取证 → 以上游结构为宿主 → Meka 自有键按相对位置
  锚点回插 → 同 key 逐条裁决 → 12 语对齐。顺序不变量已断言（摘掉回插键后逐语 key 序列 = `:3:`）。
- **落地**：desktop 12 语 merged leaves（en/de **17903**、es/fr/pt-PT 18111、pt-BR 18112、ja/ko/zh-CN/zh-TW
  17820、文言两版 17818）= 上游 + Meka − WL-26；**Meka 自有键 6868 leaves 零丢失**（`missing 0 / value-changed 0`）。
  采纳上游新增 2217~2255 leaves、上游删除 305/309 leaves。mobile 4 个 `settings.json`（389 leaves）
  + `es/groupChat.json`（557）。
- **同 key 双侧改 18 条**：16 条品牌/任务通用文案取上游新文案 + `Cindy`→`{{appName}}`（WL-3.7，
  `i18nBrandPlaceholder` 12 语断言）；2 条通用文案全额取上游。
- **WL-26**：desktop 22 leaves（`settings.about.logUpload.*` 19 + `logSupport.upload*` 3）与 mobile 7 leaves
  **保持删除**，脚本加 deny 前缀防复活；`localLogs.footer` 保留并取 Meka 文案（文言版上游又写回上传承诺）。
- **`i18n/glossary.json`**：取上游宿主（225 条：+22 新增、13 更新），仅 `provider` 保留我方
  （Meka 余额功能的两条 `creditParity*` 豁免）；补 3 条 `englishCopyExempt.en-straight-quote`。
- **刻意偏离（需知悉）**：上游新增英文写法规则（`en-please` / `en-successfully` / `en-straight-quote`）
  把 **12 处 Meka 自有存量文案**判为新增违规 ⇒ 3 处机器字面量登记豁免、9 处按 `DESIGN.md` §11 修 en 源
  （弯引号 7 / 去 "Please" 1 / 去 "successfully" 1）。替代方案是往 `i18n/glossary-baseline.json` 冻结
  （该文件不在本组范围），回退步骤见报告 §8-4。

### 2.9 治理 / 规则文档（主代理自办）

- 原则：**以上游规则为宿主**，把 Meka 私有产品线背景、已裁决例外与 Meka 专属入口并回新结构。
- `AGENTS.md`：3 处冲突全部「上游新规则 + Meka 已裁决条目」并集 —— 保留 `feature-retirements` 与
  `agent-runtime-release` 两条 Meka 索引、`cindy-meka` 更新渠道口径、`meka/main` 命名与 §8→**§10** 重编号
  （`engineering-conventions.md` 因上游新增 §8/§9 把「meka/main 上的命名」推到 §10，索引同步改指）、
  收下上游新增 agent-net 规则与 `engineering-conventions.md` §9 登记点规则。
- `docs/dev-rules/README.md`：保留「Meka 私有产品线」整区（9 行索引）+ 收下上游新增「可选的开发者高级工具」区。
- `engineering-conventions.md`：§3 术语表「条目顺序」规则收下；§5 术语豁免取两侧并集（Codex 旧命名空间豁免 +
  `englishCopyExempt`）；**§8 `meka/main` 命名规则重编号为 §10**（上游 §8/§9 占位）。
- `desktop-development.md`：内存排查段取上游 `mcpBridgeSessions` / `eventLoopDelay*` 详细口径 + Meka WL-26 口径
  改写；打包完整性/原生会话恢复段并集；NSIS/右侧栏/Codex Micro Guard 段收上游。
- `desktop-unit-test-performance.md`：Meka 的超时默认值/tier 分块章节保留，上游新增「2026-11-14 CI 提速」整章收下。
- `log-upload-and-redaction.md`：WL-26 终态（不启用上报）与上游「已删真值」并集 + 新 device-link 诊断 scope；
  本轮补 `crashTriggers` 窄例外与「区域前缀编号不接」两段。
- `plugin-security-and-authoring.md`：第七轮 gh-cli 权限扩大说明保留，并收下上游 OAuth 账号复用 / 已保存凭证复用
  两大段（含注入边界与审计要求）。
- `pi-harness.md`：Meka 的宿主技能快照段保留，收下上游「运行时空闲资源漂移回收」段与**离线启动（localOnly）**
  新裁决；Meka 的「pi 段由本仓发布链路发布」与回归红线保留。
- `performance-tracing.md`：Meka 本地口径（无上传面）为宿主，收下上游新增采集面（long task / 输入延迟 /
  截图回退标签 / invoke registry 计时），并补「区域前缀不接」判据。
- `orca-team-architecture.md`：22 工具口径保留（Meka `wait_for_worker`），收下上游「冷启动 Lead 回报先留存再投递」
  整段（4a）；删掉第七轮 `settleWorkerReport` 指针段与上游重复块；补回 `Host 归属校验` 一条。
- `maker-core-and-agent-behavior.md`：权威来源表取上游（新增「实时生成速度」一行）。
- `database-and-migrations.md`：**编号现状改为第八轮** —— 已发布 `0000`–`0131`，第七轮追到 `0150`、本轮追到 `0152`；
  `db:validate` 实测数字改为 153 sql / `0..0152` / 153 snapshot / 53 companion / canonical 冻结 151 SQL + 52 script。
- `protocol-compatibility/schedule-webhook-trigger.md`：迁移链接按 Meka 谱系 +3 顺移到 `0151`（否则 `check:dev-docs`
  报断链）。

### 2.10 生成物（不手改）

| 生成物 | 命令 | 结果 |
| --- | --- | --- |
| `docs/design-rules/design-inventory.md` | `pnpm design:inventory` + `check:design-inventory` | **已重建**（63 surface）；`--check` **exit 0** |
| `apps/desktop/src/main/maker-ipc/helpKnowledge.generated.ts` | `pnpm --filter desktop gen:help-kb` | **已重建**（`wrote 33 docs`） |
| `docs/legal/notices/**` + `THIRD-PARTY-*` | `pnpm licenses:generate` | **未重建：本机无 `cargo`（环境）**；产物同步性由 `third-party-notices.test.mjs` **14/14** 证明。其**登记闸**要求的两枚上游新二进制已补登记（见 §5） |
| `pnpm-lock.yaml` | `pnpm install --no-frozen-lockfile`（干净重装） | 解析成功；lockfile 与 manifest 一致（`--frozen-lockfile --lockfile-only` 见 §3） |

## 3. 验证

> 口径：**已实跑** = 本会话确有一次真实执行并给出结果；**未验证** = 未跑或跑在受限环境，不得当作通过。

### 3.1 阶段 A —— 结构审计

| 命令 | 结果 |
| --- | --- |
| `pnpm audit:merge -- --merge-commit <merge-sha>`（首跑） | `blockers=0` / **`dropped=5`** / `review=17` / `generated=17` ⇒ FAIL（dropped 非 0） |
| 同上 + **7 条 `--allow`**（逐条书面确认见下） | **PASS（有待确认项）**：`blockers=0` / **`dropped=0`** / `review=15` / `generated=17`；`paths=22411 hand-merged=375 took-ours=5 took-theirs=9 additive-ours=690 additive-theirs=7657` |

7 条 DROPPED 的逐条确认（含 2 条收口改写：`codexNativeSubagentsDisabled.test.ts` 从源码提取改写为驱动工厂、`desktop-whoami.mjs` 删除 Meka 的 crashpad 偏离）（**均为有意取单侧，且已实跑证明**）：

| 路径 | 侧 | 确认理由 | 证据 |
| --- | --- | --- | --- |
| `main/performance-trace/__tests__/performanceTrace.test.ts` | 上游 | WL-26：上游新增的「区域前缀编号也过期」用例前提是本地 ID 带前缀，Meka 不接该语义 | 本文件与 `performance-trace/**` 定向 **26 passed** |
| `shared/logUpload.ts` | 上游 | WL-26：上报编号生成器（`formatUploadCode` / `generateUploadCode`）随上报面删除 | 反回归 grep 代码 0 命中 |
| `docs/dev-rules/performance-tracing.md` | 上游 | 上游新增段落**已按其语义并回**（采集面一条 + 「区域前缀不接」判据），未逐字照抄 | `check:dev-docs` **10/10 pass** |
| `localDb/client/__tests__/DbClient.inproc.test.ts` | 我方 | 上游把内联 SQL 夹具换成「`0000_init.sql` + 真实 runner」；Meka 旧的大段 `INIT_SQL` 是该测试**唯一**被替代的脚手架，断言目标（query/queryOne/exec/tx 路由）未变 | 该文件**单独实跑 1 passed（54.5s）**，且与 `origin/main` 仅 1 行不同（Meka 号顺移） |
| `maker-host/__tests__/authAdaptersImportPurity.test.ts` | 我方 | 删除 Meka 的 Windows skip：上游把 `import '../auth-adapters.js'` 提到模块作用域，「冷转换计入收集期」⇒ 超时诱因消失 | 该文件**单独实跑 1 passed（108ms）**，断言全留 |
| `maker-host/__tests__/codexNativeSubagentsDisabled.test.ts` | 我方 | 上游把 `prepareCodexExtraSpawnConfig` 收敛成工厂后，Meka 的**源码 AST 提取**手法失效 ⇒ 改写成**直接驱动工厂**的行为测试（覆盖同一契约且更强） | 改写后**单独实跑 5/5 passed** |
| `scripts/desktop-whoami.mjs` | 我方 | 删除 Meka 上一轮「跳过 crashpad 子进程」的偏离 —— 上游新用例要求 crashpad 的 `--user-data-dir` 就是 profile 来源，尾部 `/prefetch:N` 由 `extractArgumentPath` 剥掉 | 修后 `node --test scripts/__tests__/restart-desktop-remote.test.mjs` **99 pass / 0 fail** |

REVIEW 15 条的处置：

| 项 | 结论 |
| --- | --- |
| `drizzle/{0148,0149}` SQL / snapshot / script（6 条） | **按编号顺移**，DB 组用 blob 相等 + 三重对照确认内容同一份；`db:validate` 6/6 |
| `maker-host/session-storage.ts` / `maker-ipc/orcaTeamService.ts` / 两个测试（4 条） | 取上游为**唯一实现**；Meka 侧在这几处的差异上一轮已登记为死字段/无消费者，主代理已把 `orcaTeamService.test.ts` 校回上游逐字节相同 |
| `performance-trace/{index,retention}.ts`（2 条） | 取我方（WL-26：不接区域前缀编号） |
| SBOM ×3 | 生成物，整份取上游；`third-party-notices.test.mjs` 14/14 |
| `packages/maker-shared/tsconfig.json` | 取上游格式，但 **`lib: ["ES2023"]` 的 Meka 语义保住**（上游为 ES2022；`tsc --noEmit` exit 0 证明 `findLastIndex` 可用） |

### 3.2 阶段 B —— 自动化验收（逐条实跑）

| 命令 | 结果 |
| --- | --- |
| `pnpm --filter desktop run typecheck` | **两侧分片均 exit 0**：`tsconfig.main.json`（6389 文件）、`tsconfig.renderer.json`（4571 文件），合计 10481 文件覆盖检查 PASS。首跑抓到 **8 类真实问题**并逐个修复（见 §2.5/§2.6 的「主代理收口」与 §2.4） |
| `pnpm --filter @cindy/maker-shared run build` | **exit 0** |
| `pnpm --filter @cindy/maker-core run build`（该包无 `typecheck` 脚本，`build` = `tsc --noEmit`） | **exit 0** |
| `pnpm --filter cindy-tools run build` | **exit 0** |
| `pnpm --filter desktop db:validate` | **6/6 PASS**（153 sql / `0000..0152` / journal 对齐 / no drift / 53 companion CJS / canonical 冻结 151+52） |
| `pnpm test:runner` | **主体 880 pass / 0 fail / 19 skip**；末步 `check-windows-atomic-rename.mjs` **失败 = 环境**（本机无 `rustc`，`spawnSync` 返回 `status:null`） |
| `node scripts/test-workspaces.mjs --tier db` | **1675 tests / 1 failed**：`botRemoteEditors.test.ts` 的「phone 列 teammate automations」在**本机 zh-CN 默认 locale** 下按拼音排序（早报 < 周报），上游用例按 en 排序写死。**实现与用例均与上游逐字节相同** ⇒ 环境/上游用例健壮性问题，非本轮回归（证明见 §4） |
| `node scripts/test-workspaces.mjs --tier unit` | 见 §3.3 |
| `pnpm check:i18n` | **exit 0**（17662 key × 12 语一致；警告 7806 处为预期的「非 en 值与 en 相同」等） |
| `pnpm check:i18n-glossary` | **exit 0**（35 条已裁决 / 190 条待讨论 / 无新增违规 / baseline 存量 41） |
| `pnpm check:brand-terminology` | **exit 0**（PASS） |
| `pnpm check:endpoints` | **exit 0** |
| `pnpm check:dev-docs` | **10/10 pass**（首跑 1 红：上游新文档链接到 `0148_…` script，按 Meka 号顺移到 `0151_…` 后转绿） |
| `pnpm check:design-inventory` | **exit 0**（GENERATED 区块最新，63 surface） |
| `pnpm check:test-hygiene -- --base origin/meka/main` | **PASS（354 files within baseline）**。默认基线解析在同步分支上会退到 `origin/main`（上游基线天然不含 Meka 存量条目）⇒ 出现 18 条「0 → N」假阳性；按反推集成分支口径加 `--base origin/meka/main` 后 PASS |
| `node --test scripts/__tests__/third-party-notices.test.mjs` | **14/14 pass**（生成的披露产物与当前依赖一致） |
| `node --test scripts/__tests__/restart-desktop-remote.test.mjs` | **99 pass / 0 fail / 5 skip**（修 `desktop-whoami.mjs` 后；此前 1 fail） |
| `node --test scripts/__tests__/test-workspaces.test.mjs` | 见 §3.3 |

### 3.3 `test:unit`（全量实跑，**不是全绿**）

`node scripts/test-workspaces.mjs --tier unit` 实跑（日志 `_analysis/wp8-test-unit.log`）。

**首跑结果**：desktop / mobile / packages 多个文件红。**逐条归因与处置**：

| 类别 | 文件 | 结论与证据 |
| --- | --- | --- |
| **合并回归（已修）** | `maker-host/__tests__/codexNativeSubagentsDisabled.test.ts`（6） | 上游把 `prepareCodexExtraSpawnConfig` 从「index.ts 里的属性体」收敛成 `createCodexSpawnConfig(ports)` 工厂 ⇒ 旧测试的 AST 提取锚点失效（`createCodexSpawnConfig is not defined`）。**改为直接驱动真实工厂**（与上游 `codexSpawnConfigCore.test.ts` 同手法）：硬关时 argv 出现相邻 `['-c','agents.enabled=false']` 且智能调配不准备；放行时相反。修后 **5/5** |
| 同上 | `meka-skills/__tests__/api.test.ts`（套件级） | 我把生产入口改走 `serverApiClient.desktop.js`（上游工厂化）后，旧 `vi.mock('../../serverApiClient')` 不再被命中 ⇒ 补 `createServerApiClient` 缺失报错。**mock 改挂适配器**后转绿 |
| 同上 | `maker-ipc/__tests__/mekaRuntimeInjection.test.ts`（3） | 上游把函数体改名 `bootstrapSessionOnce`、创建调用收敛成 `createSessionWithRuntimePlugins(o, …)`、`hasExecutionOverrides` 局部变量消失 ⇒ 三处源码锚点改按**符号名 + 前缀**定位；修后 **20/20** |
| 同上 | `cindy-media/__tests__/mediaInvocationStore.test.ts`（6） | 上游新用例引 `drizzle/0092_fixed_zeigeist.sql`，Meka 该 migration 序号是 `0095`，但 `media_invocations` 表在 Meka 谱系里由 **`0092_sync_upstream_20260821.sql`** 创建 ⇒ 夹具改指后者（按「表由谁创建」而非「原号顺移」判）；修后 **7/7** |
| 同上 | `agent-island/__tests__/service.test.ts`（1） | 上游断言写死 `cindy://session/s1`，而 Meka 主 scheme 是 `cindy-meka://`（本机无 deviceId 时走 `URL_PREFIX`）。**只改本地链接那条**；带 `?device=` 的跨设备链接走 `DEEP_LINK_INTEROP_URL_PREFIX`（= `CINDY_INTEROP_PRIMARY_SCHEME` = `cindy://`），**保持上游原样**；修后 **198/198** |
| 同上 | `renderer/features/plugin/__tests__/pluginMarketSurface.test.ts`（1） | 上游新增的 `detailCache` 四处直接 `window.electronAPI.pluginMarket.detail(...)`，绕过 surface 选择 ⇒ **Meka 前台的市场请求被打回 Cindy 渠道（WL-9 回归）**。生产修复：新增 `marketApiRef`（永远指向当前 surface 的 API）并改这四处；转绿 |
| 同上 | `renderer/features/plugin/__tests__/MarketPluginDetailView.test.tsx`（1） | Meka 的「叠层量宽文案」让共享 Button 的 `opacity-0` 遮罩 textContent 变成两段文案拼接，破坏「可见文案被 spinner 取代 + 可访问名称不丢」断言形态。生产修复：无 progress 时只留一份文案节点（宽度由 `min-w-[104px]` 兜底）；**16/16** |
| 同上 | `__tests__/packagedResourceDeclarations.test.ts`（2） | 上游新静态门禁要求「运行期读的每个 `resources/<name>` 都被 `extraResourcesForTarget()` 声明」。Meka 两处读的是**个人版构建产物**（`resources/personal-plugins`、`resources/personal-native.json`），普通包与源码树都没有 ⇒ 不是 extraResource；按门禁既有契约登记进 `NON_EXTRA_RESOURCE_ROOTS`（**每条写清理由与读点**，不是放宽成白名单蒙混）；**6/6** |
| 同上 | `renderer/features/cc-agent/__tests__/CreateWorkerPopover.test.tsx`（8） | 该文件的 `beforeEach` 用 `Object.defineProperty(window,'electronAPI',{configurable:true, value})` 但**没写 `writable`**（缺省 false），后续用例的普通赋值即抛 `Cannot assign to read only property`。补 `writable: true`（断言零改动）；**120/120** |
| **环境（Windows 无 symlink 权限）** | `botSkillStore`(2)、`pluginFileAccess`、`browser-extension/native-binding`、`companion-cloud/localData`、`companion-cloud/replyArtifacts`、`browserScreenshotResolver`、`local-themes/packages`、`cindy-brain/personalPluginUpdates` | 全部 `EPERM: operation not permitted, symlink …`（本机无创建符号链接权限；CI Linux 不受限）。与第七轮同一类环境项 |
| **环境（宿主 locale）** | `localDb/ipc/__tests__/botRemoteEditors.test.ts`（db tier，1） | 本机默认 locale 为 **zh-CN**，`a.name.localeCompare(b.name)` 按拼音排序（早报 < 周报），上游用例按 en 排序写死。**用例与实现都与 `origin/main` 逐字节相同** ⇒ 非本轮回归（上游用例对非 en locale 不健壮） |
| **环境（DSH 变量污染）** | `session-import/__tests__/foreignSourceAdapters.test.ts`（1） | 期望 1 实得 51：本进程环境带 `DSH_HOME`，用例读到真实 DSH 会话目录（第七轮已登记同一机制） |
| **负载抖动（复跑已绿）** | `updateService`、`doc-tools/readSheetProcessPackaging`、`browser-extension/bridge`、`packages/maker-cc-manager`(125/125)、`packages/maker-pi-manager`(285/285)、`packages/maker-core` 三个 pi 文件(357/357)、mobile `selfhostOtaPlugin`(12/12) | 首跑时与 tsc/smoke 并发抢 CPU；单独复跑全绿（命令与计数见上表） |
| **仍未修（登记）** | `renderer/features/plugin/__tests__/GhostPluginPage.navigation.test.tsx`（1） | 「background 刷新返回等价详情时不得重渲染」的计数断言多 1 次渲染。已确认**与本轮我做的 `marketApiRef` 改动无关**（首跑即红）；属上游新增 detailCache 与 Meka 页面组合后的多余状态更新，需要单独立项（不影响功能，`loadDetail` 次数断言正确） |

### 3.4 阶段 C —— 实机验收（**已实跑**）

合并后的代码在本机**真实启动**并接受程序化驱动（不是只读代码或只跑单测）：

1. `XDT_CDP_PORT=9222 pnpm restart:desktop:remote` → `DESKTOP_DEV_VERDICT=ready`，
   `root=C:\Workspace\cindy-sync-1117`，`commit=96bda3761e…`（= 本轮合并提交），
   沙箱 `dev`（沿用本机既有登录态，未新建/未重置用户数据）。
2. `pnpm desktop:ui-smoke -- --port 9222` → **PASSED：checks=15 pass=13 fail=0 unverified=2**
   - WL-2.1 侧栏入口位次与激活态、WL-2.2 rail 入口、WL-2.3 三页签与路由、WL-2.4 旧深链重定向、
     WL-1.5 面板打开方式开关翻转、WL-2.5+WL-3.3 段头折叠、WL-3.2 分组树、WL-1.1 设置页签位次、
     WL-1.2~1.5 四卡齐全（P4 匹配 5 个 saga2 子目录）、WL-5.5+WL-6.1 版本行（`Global · 0.0.0 ·
     sync/origin-main-20261117@96bda37` = HEAD）、WL-6.5 Beta 徽标、**WL-10 模型选择器展开 26 个选项**、
     **WL-13 十一语横切无裸 key**
   - 2 项 UNVERIFIED：WL-1.2 / WL-1.3 —— 本机 MCPRouter 与 MekaDesign **已连接**，入口被「断开」替代；
     为不打扰用户真实凭证未造未连接态（脚本已按连接状态分支，不再误报 FAIL）。
3. `pnpm desktop:session-smoke -- --port 9222` → **PASSED：11/11**：`workspace_kind=meka / project=saga2 /
   role=saga2-default-role / is_formal=0`；真实 Agent 跑完一轮并回复「收到。」；`[MEKA_ROLE_CONTEXT]`
   回显 `projectId/roleId/displayName`；运行期 `mcp=mcp-router,meka-design`、`skillsCount=51`；
   参考段 4 条、正文不内联；升级库无退役内置角色行。
4. **首跑即失败、修完转绿的脚本锚点维护（同批）**：WL-1.2/WL-1.3 缺「设置分区 lazy 渲染」等待、
   WL-1.5 选择器绑了 `button[role=switch]`（实际是 `[role=switch]`）、WL-5.5 正则写死 `meka/main@`
   （同步分支名不匹配）、WL-10 首次展开只等 900ms（冷启动要等目录读取）。四处按 DOM 事实修正
   （只改锚点与等待，**断言口径未放宽**），修完 5 → 13 pass。


## 5. 上游新增二进制的许可登记（本轮必要改动）

`pnpm licenses:generate` 的登记闸（`assertTrackedBinariesRegistered`）要求仓内一切二进制资产有明确归属。
上游本轮新增两枚，已在 `scripts/generate-third-party-notices.mjs` 补登记（含理由注释）：

| 资产 | 归属 | 处理 |
| --- | --- | --- |
| `packages/agent-net-core/prebuilt/core.wasm` | 本仓 `packages/agent-net-core`（Apache-2.0）由同目录 Rust 源经 `build.mjs` 编译；`prebuilt/manifest.json` 记录源/二进制摘要可校验 | 加入 `registeredFiles`（不产生第三方披露条目） |
| `apps/desktop/resources/system-skills/cindy-plugin-creator/references/examples/interactive-pages/host-ui/assets/JetBrainsMono-*` | SIL OFL-1.1，授权正文随字体入仓（同目录 `JetBrainsMono-OFL.txt`） | 加入 `registeredPrefixes`（披露条目复用既有 JetBrainsMono 段） |

登记后 `licenses:generate` 可通过登记闸，但其后续步骤需要 `cargo` —— 本机未安装 Rust 工具链，
故**产物重建未在本机执行**（见 §4）。

## 4. 未验证 / 批准门 / 待裁决

### 4.1 未验证（有明确原因，需维护者书面接受）

1. **真机打包 / 真机更新**：需真实签名与发布渠道，未执行。
2. **移动端冷更实机**：门已获用户确认（第七轮）但本轮未实测；指纹输入变化未计算。
3. **Light / Dark 与十二语人工目检**：`ui-smoke` 已做 11 语程序化横切与功能断言（WL-13 PASS），
   但不等于人眼目检字形/换行；**双模式实机目检未做**（不得把「复用 themed 样式」当成已验证）。
4. **WL-4 端到端 V1–V4**：需 MCPRouter 账号 + 已绑定实例 + Gateway key；本轮只做源码级顺序
   不变量与定向用例（WL-4.1.2 的 mcpr 早返回实测在 `ensureRemoteHostReady` 之前）。
5. **`pnpm licenses:generate`**：本机无 `cargo`（Rust 工具链未安装）⇒ 生成器无法跑完；产物同步性
   由 `third-party-notices.test.mjs` 14/14 证明，登记闸所需的两枚上游新二进制已补登记（§5）。
6. **`check-windows-atomic-rename.mjs`**（`test:runner` 末步）：本机无 `rustc`，`spawnSync` 返回
   `status: null` ⇒ 该步失败属环境；`test:runner` 主体 **880 pass / 0 fail / 19 skip**。
7. **`GhostPluginPage.navigation.test.tsx` 的 1 条渲染计数断言**（§3.3 末行）：功能正确、
   `loadDetail` 调用次数断言正确，仅「等价背景刷新不重渲染」多 1 次渲染，未在本轮修。
8. **Windows symlink EPERM 的 8+ 个文件**（§3.3）：本机权限限制，CI Linux 不受限。

### 4.2 批准门 / 待裁决

1. **设计台账门禁的 lazy 路由**：上游把路由改成 lazy，Meka 三条管理页路由仍用具名 element
   （`design-inventory.mjs` 的 `routeEntryComponents` 按组件名精确核对且需 `surface="meka"`）。
   本轮保持具名（`check:design-inventory` exit 0），**是否跟上游 lazy 需单独立项**（要同步改脚本）。
2. **上游英文写法规则带来的 9 处 Meka 存量文案改写**（§2.8）：已按 `DESIGN.md` §11 修 en 源；
   若要保留原文案，应改为往 `i18n/glossary-baseline.json` 冻结（回退步骤见 `wp8-i18n-report.md` §8-4）。
3. **存量缺口未修（非本轮引入）**：`maker-ipc/scheduledModelSelection.ts:211` 的
   `readSshCodexProviders` 仍缺 `classifyRemoteSessionTransport(...) === 'ssh'` 守卫；
   `packages/lizi-mcps/src/__tests__/sessionContext.test.ts` 用例名仍写 "21-tool"（断言 22）。


