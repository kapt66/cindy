# 第七轮上游同步：`origin/main` → `meka/main`（2026-11-06）

> 本轮把上游 `origin/main` 的最新提交语义合并进本仓 `meka/main`。
> 上一轮（2026-10-16）报告见 [`2026-10-16-origin-main-to-meka-main.md`](2026-10-16-origin-main-to-meka-main.md)；
> 迁移总账见 [`xdmaker-meka-to-cindy.md`](xdmaker-meka-to-cindy.md)（本轮登记为 §11.37）。
> 接纳策略、波次与完成判定见 skill `cindy-meka-upstream-sync` 与
> [`meka-whitelist-verification.md`](../dev-rules/meka-whitelist-verification.md)。
>
> **状态（2026-11-12）**：冲突已 **0**、索引已 **stage**；阶段 A `audit:merge` 已跑 **PASS（有待确认项）**
> （blockers=0 / dropped=0（18 条逐条 allow）/ review=31 / generated=34，见 §4.1）；desktop `typecheck`
> **exit 0**、`test:db` / `test:device-link` / `ui-smoke` / `session-smoke` 均已实跑；`pnpm test:unit` **已跑完但
> 不是全绿**：原始全量 desktop tier 20 文件 / 80 例失败，其中 **12 文件已修复并复跑**（`RemoteSkillsPage`
> **18/18**，其余 11 文件 **190/190**），mobile / maker-core 各文件也已修复复跑（**16/16**、**1077/1077**）；
> **剩余仅：8 个 desktop 文件因本机 Windows symlink EPERM（CI Linux 不受限）+ `cindySubagentRunner` 1 例
> Windows OS inventory 超时（环境）**，见 §4.6。**仍未验证**：真机打包 / 真机更新 /
> 移动端冷更**实机**（批准门已于 2026-11-12 全过）、Light/Dark 与十二语人工目检、WL-4 端到端。 —— 这些标注「待最终门禁」的项**不得**被读成已经通过。

## 1. 基线

| 项 | 值 |
| --- | --- |
| 本仓合并前 `HEAD`（产品线侧） | `a0bf8d19ab5ab37dc7e23f8b26ddfd0810029ad8`（`meka/main`，2026-11-03） |
| 上游 `origin/main`（上游侧） | `b69985e79b31b557acc1de1797b13ad64fe32a7a`（2026-11-06） |
| `merge-base` | `53b2c99854ddea4ead1868e3477e830f66f20800` |
| 上游独有提交数 | **6417**（4299 非 merge + 2118 merge；`53b2c998..b69985e7` ≈ 3 周） |
| 本仓独有提交数 | **206**（189 非 merge + 17 merge） |
| 上游本轮改动规模 | **9726 文件**（两侧自 base 的改动：本仓 981 文件） |
| 本轮前 Meka 侧真实增量 | `c90098a372..HEAD` = **21 提交 / 64 文件 / +2836 −109** |
| Git 冲突路径 | **169**（158 `UU` + 3 `AA` + 5 `DU` + 3 `UD`） |
| merge 命令 | `git merge --no-commit --no-ff origin/main`（**无** `-X ours` / `-X theirs`；退出码 1 = 有冲突，符合预期） |

`merge-base` 恰好等于**第六轮同步登记的上游端点** `origin/main@53b2c998`，因此本轮只接纳上游在这
6417 个提交里的新增内容；第四轮（2026-09-25）、第六轮（2026-10-16）的裁决继续有效。

冲突按能力组路由给 9 个并行解决工作包（`_analysis/wp7-*.md` 为各包原始报告），另由主代理处理
身份/构建与生成物：

| 组 | 任务包 / 报告 | 冲突路径（代表） |
| --- | --- | --- |
| 数据库谱系（D4） | `wp7-db-report.md`（12 文件） | `drizzle/meta/{0129,0130,0131}_snapshot.json`（3 `AA`）+ `localDb/{mapper,sessions,WorkerThreadTransport,tx}` 与其测试 |
| 插件基座（main） | `wp7-plugins-main-report.md`（20 文件） | `shared/ghost.ts`、`cindy-brain/{index,forge,pickSlot,scheduleSlot,pipeDispatcher}`、`mcp-integrations/ghost.ts`、`plugin-market/{api,registerIpc,service}`、`preload/{ghostPreload,preload}.ts`、`skillhub/installService.ts` |
| 插件 UI / 面板 | `wp7-panel-design.md`（执行稿）+ 本报告 §3 | `features/plugin/{GhostPluginPage,GhostPluginDetailView,PluginManagementLayout}`、`cindy-brain/{ghostPanels,ghostPanelBody,GhostSettingsWebview}`、`shared/ghost.ts`（面板段） |
| maker-ipc / Orca | `wp7-maker-ipc-report.md`（17 文件） | `maker-ipc/{register,makerSendTransaction,orcaLifecycleService,orcaTeamService,orcaWorkerCreationService}`、`maker-orchestration/fork.ts`、`lizi-mcps/{orca/server,create_worker,create_workers}`、`orca-workflow/*` |
| maker-core / Host / Pi | `wp7-core-host-report.md`（10 文件） | `maker-core/src/agents/{base-agent,codex/index,pi/cindy-bridge-source}`、`maker.ts`、`maker-host/index.ts`、`mcp-providers.ts`、`anthropic-compat-proxy` |
| 侧栏 / CC-Agent / 杂项 UI | `wp7-sidebar-report.md`（35 文件，含 1 `UD`） | `SidebarTopNav`、`CCAgentSidebarUpper`、`NewMakerDraftRoute`、`CreateWorkerPopover`、`RolePillDropdown`、`TaskMoveSubmenu`、`localDbFatalView`、skillhub 三页 |
| 身份 / 构建 / 外壳 | `wp7-identity-report.md`（19 文件） | 根 `package.json`、`forge.config.ts`、`bootstrap-electron.ts`、`deepLink.ts`、`authManager.ts`、`agent-island/state.ts`、`scripts/{restart-desktop-remote,test-workspaces,ensure-agent-binaries}.mjs`、`.github/workflows/ci.yml` |
| i18n | `wp7-i18n-report.md`（10 文件） | desktop 五语 `common.json` + mobile 五语 `settings.json`（另全域 12 语审计） |
| 治理 / 规则文档 | `wp7-governance-report.md`（14 文件） | `AGENTS.md`、`docs/dev-rules/{development-workflow,plugin-security-and-authoring,desktop-development,DESIGN,...}.md`、`docs/design-rules/DESIGN.md` |
| 生成物（生成组 + 主代理） | **已重建**（`wp7-generated-report.md`） | `docs/design-rules/design-inventory.md`、`docs/legal/notices/**`、`THIRD-PARTY-*`、`maker-ipc/helpKnowledge.generated.ts` |

### 1.1 本轮主导上游改动（非穷举）

- **插件基座大改**：`0ece30efb4 feat(plugins): 统一能力授权与 local 开发安装` —— 移除「插件名称／
  官方来源」门禁、本地文件与 Forge 新装默认 `namespace:"local"`、工具审批统一吃已批准声明、
  `source:"gh-cli"` 按声明开放；删除保留 ID 前缀的开发闸（`reservedGhostIdGate.ts`），并把
  `layoutWithGhostPanel` 从共享层删除。配套一整批（合计 331 提交 / 431 文件 / `+51066 −8199`）：
  `52b4396a19`（客户端原生 UI、独立视图、个性化）、`60110fa673`（本地提审与「我的插件」）、
  `0649869045`（跨电脑插件 + 技能市场）、`509623aa7f`（插件创建统一为内置 Skill，`forge.ts` 只剩转出）、
  `80d517b4a0`（任务运行能力接口）、`1319c3a89d`（本地分享 + 固定版本）、`1b29438a4c`（在目标电脑
  执行插件管理）、`2f2721a49b`（回退 Harness 能力桥接）。
- **右侧栏 / 停靠面板重构**：`abb83fa21c 插件停靠面板收束为右侧栏全局页签；mainView 可在侧边栏中打开`
  （**96 文件 `+1272 −5917`**，本域唯一删除源），加上 `23d01f2c54`（侧栏弹出改按页签弹独立窗口）、
  `065783d1e6`（弹出窗口改多页签页签组）、`08078dca33`（页签组可移到聊天区左/上/下）、
  `838e197f3b`（页签窗口 review 收敛）、`6d1430ee1d`（停放页签组 pane 保留 webview）
  —— 合计 123 提交 / 135 文件 / `+14287 −1945`。结论见 §3。
- **数据库 19 条 migration `0129`–`0147`**（`0133_chat_history_cache`、`0134_schedule_model_location`、
  `0140_schedule_pre_run_plugin`、`0144_preserve_existing_pr_associations` 等；journal 129 → 148），
  落为 Meka `0132`–`0150`（§2.1）。
- **深链**：`0f2fd465b7 feat(deep-link): 新增 cindy://plugins[/<ghostId>] 打开已装插件`（本仓落到
  `cindy-meka://plugins`）。
- **i18n 扩语**：`2b771422a2`（de/es/fr/pt-BR/pt-PT 五语）、`378820a7fe` / `3019820b8f`（文言版）、
  `986a748f22`（补齐客户端原生界面与附带内容的**十语**支持）。仓库侧实测 **12 个 locale**：
  `en/ja/ko/zh-CN/zh-TW` + `de/es/fr/pt-BR/pt-PT` + 文言 `zh-Hans-x-lzh`/`zh-Hant-x-lzh`（§2.8）。
- **Agent / Orca / 伙伴**：`44ac8fccf3`（伙伴自主跟进）、`f1ad8475e7`（伙伴自带 IM bot）、
  `98767bbbe3`（观察/行动授权分离）、`65e3f2f1e1`（session-import 新导入核心）、
  `36a333ac18`（**下线内置智能通讯录**，由通讯录插件承接）、`72c6890c18`（统一插件/普通任务权限判断）
  —— 1166 提交 / 1044 文件 / `+101418 −28992`。
- **产品面新增（与 Meka 交叉）**：`cdfec9aa5b` 内置截图、`dc3fc2bac7` 浏览器配方全量、
  `6551b7a4ec` 移动端远程插件管理 + 原配置页、`f03a2065b1` 受邀者直连执行电脑、
  `5c6d201cb1` GitHub PR 状态跨 agent、`145ebaca90` GitLab MR、`9122c27dc7` 附件查看统一。
- **工程工具链**：`31b49781db`（单页 UI 快速验证 `pnpm ui:check` / `ui:preview`）、
  `e2f05349d4`（CI 加速与 `check:test-hygiene` 基线）。

## 2. 逐组解决结论

> 各工作包的原始报告在 `_analysis/wp7-*.md`（该目录由 `.git/info/exclude` 排除，不入库）。
> 本节只记「最终有效行为 + 决定归属 + 证据 + 残留风险」，不复制报告正文。
> **注意**：分组执行报告里多数「未跑」项的原因是**其它组当时仍未解冲突**（locale JSON、生成物），
> 不是语义失败；这些统一进 §4.2「待最终门禁」。

### 2.1 数据库谱系（`wp7-db-report.md`，12 文件）

- **上游 19 条 `0129`–`0147` 顺移为 Meka `0132`–`0150`**（+3，与第三/四/五/六轮同一偏移；只改编号前缀，
  后缀与正文不变）。19 条 SQL + 5 条 companion 的 blob 与上游**逐字节相同**（`git hash-object` 实测）；
  5 条 companion = `scripts/0133_parallel_devos.ts`、`0137_schedule_model_location.ts`、
  `0141_talented_blacklash.ts`、`0143_schedule_pre_run_plugin.ts`、`0148_bizarre_tinkerer.ts`。
- **3 个 `AA`（`meta/0129`/`0130`/`0131_snapshot.json`）取 `:2:`**：实测 = 合并前 `HEAD` 逐字节
  （`d4d5834b6822` / `22a9786e5b50` / `45cf656bed7c`），上游内容改写入新号 `0132`/`0133`/`0134`；
  已发布谱系 `0000`–`0131` 的 SQL / snapshot / companion **零字节改动**。
- **新 snapshot = 上游同内容 snapshot + Meka delta（每份恰 15 项）**：2 张整表（`meka_projects` 8 列、
  `meka_roles` 12 列）+ `sessions` 10 列 + 2 索引 + 1 外键（`onDelete: set null`）；剥 delta 后与上游
  `JSON.stringify` 逐字符相等，逐行 diff 全部 **4 hunks / +284 / −0**，`id`/`prevId` 沿用上游，
  链从 Meka `0131` 的 `779b3cd5…` 自然接上。
- **`meta/_journal.json` 132 → 151 条**（`idx 0..150` 连续无重复）：既有 `0..131` 段逐字节保留，
  新增段 `when` 沿用上游且严格单调。merge 自动合并的中间态是**无效**的（151 条里同时含两套 tag、
  `129/130/131` idx 重复），已按 Meka 号重建。
- **对象级碰撞核对**：本轮 5 张新表（`chat_cache_messages`/`chat_cache_rooms`/`session_imports`/
  `github_observations`/`pi_usage_receipts`）与 18 个新列在 Meka 已发布 schema 里**都不存在**；
  唯一「已存在」的 `sessions.hidden_at` 本轮没有任何 migration 再碰它 ⇒ 无需给上游 SQL 打补丁。
- **`0139_bizarre_pet_avengers`（上游 `0136`）的特殊依赖**：它 `DROP TRIGGER` 三个
  `hook_group_message_stats_*`，而这三个对象在 Meka 谱系里由 **`0092` 的 companion 脚本**
  （`scripts/0092_sync_upstream_20260821.ts`，`tableExists` 守卫内）创建，SQL 本身没有 ⇒ 真实回放与
  `migrationReplay` 的历史夹具按「`0089` 群表 + `0092` SQL + `0092` companion + `0139`」准备。
  同源影响 4 个群窗口/群历史测试夹具（`['0089_','0092_']` + `['0139_']`）。
- **localDb 语义组 10 项**逐条给结论（`mapper.createSessionInsert` 并集、`scheduleToCamel` 保留 Meka 的
  `normalizeScheduleWorkspaceKind`、`sessions.ts` 以上游 provisional 为宿主 + Meka `validatedCreateBody`、
  两条 fork INSERT 合成 **29 列 == 29 占位符 == 29 实参**、`task-migration` 两字段并存等），
  详见 `_analysis/wp7-db-report.md` §5；独立复算 `verify.mjs` **133/133 PASS**、
  `semantic-check.mjs` **12/12 PASS**。
- **实跑**：`pnpm --filter desktop db:validate` **6/6 exit 0**（151 sql / seq `0000..0150`；journal↔sql↔snapshot
  对齐且 `id`/`prevId` 链连续；`drizzle-kit check` 无 drift；52 companion 全 CommonJS；
  固定 SHA256 基线 80 SQL + 23 script；canonical 冻结 132 SQL + 47 script）。
- **残余**：真实回放（空库 0..150 与历史库升级）与 7 个定向测试在 db 组执行时被 locale 冲突挡住，
  收口后必须补跑（§4.2）；上游 `meta/0136_snapshot.json` 自身是紧凑数组格式，产物按 Meka 风格展开
  （内容逐字符等价，属序列化归一）。

### 2.2 插件基座（main 侧，`wp7-plugins-main-report.md`，20 文件）

- 冲突文件全部按「**以上游新状态机为宿主，Meka 渠道/开发目录/批准能力重挂到新结构**」解决：
  `shared/ghost.ts` 四张能力表（`LEGACY_GHOST_SLOTS` / `GhostPermissionItem` / known-fields /
  `V3_BOOLEAN_*`）同时含 Meka 的 `mcpr`/`reveal` 与上游的 `liveScreen`/`browserExtension`；
  `cindy-brain/index.ts` 的 Meka `meka-dev-plugins:*` 整段（`MekaDevPluginManager`、两段式确认、
  发布上传、`syncRegistered()`）与上游 `browserExtensionSlot`/`taskViewSlot`/`liveScreenHost`/
  `remotePluginManagement` 并存；`forge.ts` 取上游（手册搬进内置 Skill），Meka 作者章节迁到
  `forgeGuide.ts` 的 `MEKA_FORGE_GUIDE`（4.25 `mcpr` / 4.26 `reveal` + 面板呈现方式）。
- **`pickSlot.ts` 两态并存**：上游 `into` 导入（多选/进度/`callId` 取消）为宿主，缺省 `into` 时走 Meka
  私有形态（只交绝对路径给 `node|reveal`、禁 `deposit`）；`hasReveal` 并入路径交付、目录模式拒绝条件
  为 `!node && !reveal && !deposit`。**作者文档已写明差异**（`MEKA_FORGE_GUIDE` 4.26 + 规则 §3）。
- **`skillhub/installService.ts` 第三参收成按形状区分的联合**：上游 `remoteGuard{current,beforeCommit}`
  与 Meka `source?: SkillInstallSource`（渠道账本）各自生效。
- **`pluginDistributionContract.test` 的门禁被上游新文件打破后收紧为「唯一附加例外」**：
  允许 `localSharing.ts` 读 `app.getVersion()`，但断言只剩 1 次、必须是 `'x-cindy-version'`、
  且不得引用渠道身份常量。
- **存量兼容自检（实测）**：`RECEIPT_SCHEMA_VERSION = 2`（未 bump）、内容指纹 `cindy-ghost-content-v2\0`
  （未变）、`MAX_BASIC_CINDY_FILE_BYTES = 8 MiB`、`PLUGIN_MEMBER_UPLOAD_MAX_ARCHIVE_BYTES = 128 MiB`
  / `..._UNCOMPRESSED_BYTES = 256 MiB`（两侧同值）、Meka 双档下载（8/128 MiB）注入点仍在、
  `ignoredRound` 旧键形态两套都在、`meka-ledger.v1.json` 与 `adoptLegacyInstallations=false` 隔离在位。
- **权限变化（放行人必须知悉）**：上游 `0ece30efb4` **删除** `source:"gh-cli"` 仅官方 `cindy-github` 的
  manifest 拒绝面 ⇒ 已批准插件都能按声明使用本机 `gh auth token`；补偿是
  `diffInstalledGhostPermissionItems` 把「非历史官方安装新增的 gh-cli 声明」算作**新增权限**进入更新确认
  （`cindy-github` + root + `cindy-official` 保留 PAT→gh 指纹兼容）。**Meka 本轮新增 1 个拒绝点**：
  `panel.allowUserPresentationOverride` 非布尔 / `position:'tab'` 时声明该字段 ⇒ 拒装（§3）。
- **实跑（定向取证）**：10 文件 / **252 用例全绿**（`scheduleSlot` 60、`marketGhostSessionBoundary` 19、
  `builtinGhostProvisioner` 32、`pickSlot` 30、`ghostLocalFileIpc` 27、`ghostLocalInstallIdentity` 33、
  `ipcErrorBoundary` 15、`pluginDistributionContract` 28、`mekaDownloadPolicy` 3、`ghost.mcpr` 5）；
  `packages/plugin-protocol` 的 `build`（= `tsc --noEmit`）通过。
- **残余**：`forge.test.ts` / `ghostWorkdirGate.test.ts` / `plugin-market/service.test.ts`（含 Meka 账本隔离用例）
  在分组执行时分别被 `@jackwener/opencli/catalog` 解析失败与 locale 冲突挡住。**2026-11-06 收口后**：
  `@jackwener/opencli/catalog` 的 `exports` 已由 `packages/opencli-vendor` 提供（`./catalog` →
  `opencli-vendor/cindy/catalog.ts`），并在 `packages/lizi-mcps/node_modules` 下完成 link ⇒ 阻塞前提消失，
  这三个文件**仍未复跑**，按 §4.2 记为「待最终门禁」。

### 2.3 插件 UI / 面板（执行稿 `wp7-panel-design.md` + 本报告 §3）

- 9 个冲突路径全部以上游新结构为宿主，Meka 侧保留「Modal 宿主 + 三态选择器 + resolver」并重挂到
  `plugin-view` 页签语义：`GhostPluginPage.tsx`（17 hunk，`panelStatus` 改三态、`?panel=` 深链走统一
  resolver、卡片主动作分流）、`GhostPluginDetailView.tsx`（6 hunk，`hasPanelPresentationPreference` 卡与
  上游 `browserExtension` 卡**两块都留**）、`ghostPanelBody.tsx`（4 hunk，`autoFocusWebview` 与上游
  `tabView` 并集）、`GhostSettingsWebview.tsx`（`useGhostContentRevision` + 上游 `remoteDeviceId`/`instanceId`）、
  `PluginManagementLayout.tsx`（头注释取上游）。
- **0 冲突但会静默断链的文件**已逐条处理：`ghostPanels.tsx`（269 → 上游 69 行，追加 1 行 `[MEKA]` 同步调用）、
  `useGhostPanelLauncher.tsx`（删 `layoutWithGhostPanel` 与 `restoreGhostPanel`，改 resolver 三分支）、
  `PluginPanelPresentationPreference.tsx`（删 `ghostPanelWindow.setDetached` 死调用）、
  `MekaAssistantSettingsSection.tsx`（设置开关副作用改为 `applyGhostPanelPresentationChange`）。
- **面板域最终形态、删除面、迁移与门禁见 §3**（该节是本轮唯一的产品形态裁决）。
- **证据**：面板 UI 执行组的独立报告已落盘（`_analysis/wp7-plugins-ui-report.md`）——**逐文件/逐 hunk 结论以其 §1 为准**
  （9 个冲突文件：`GhostSettingsWebview` / `ghostPanelBody` / `installFlow.test.tsx` / `GhostPluginDetailView` /
  `GhostPluginPage` / `PluginManagementLayout` / `GhostPluginIcon.test.tsx` / `permissionItemIcon.ts` + 2 个 `UD`），
  落地模块与 seam 见其 §2、入口路径表见 §3、旧状态迁移见 §4、定向测试见 §6.1（9 文件 / 70 例全绿）与 §6.3（T1–T9）。
  本节只保留与产品形态相关的决定；**未做**部分（Light/Dark 与 12 语实机目检、CDP 14 步、跨窗口偏好同步实测）
  见该报告 §6.4。

### 2.4 maker-ipc / Orca / `lizi-mcps`（`wp7-maker-ipc-report.md`，17 文件）

- **`register.ts`（9 处，最大风险）**：上游把 `ensureRemoteHostReady` **提前**到 `ensureAgentKind` 之前 ⇒
  Meka 的 `classifyRemoteSessionTransport(...) === 'mcpr'` 早返回**随 ensure 一起前置**（顺序不变量实测：
  mcpr 早返回先于唯一一次 `ensureRemoteHostReady`）。拒绝「机械并集」——保留旧位置守卫会让 `mcpr:`
  先落进 SSH 前置（正是 `4d1e01b7f` 那类回归）。
- **会话创建 funnel**：Meka `bootstrapSessionOnce` 真身 + `bootstrapSession` in-flight 去重包装，
  接上游 `creationSignal` / 供应商组换电脑 `while` / `createSessionCloseTeardown` / `planModeEnabled` 回读 /
  `listWorkerAgentLocations`（删本地副本）；teardown 后只补一条上游不认识的
  `releaseSessionRemoteCodexCapability`。**拒绝**两套 `bootstrapSession` / 两套 teardown 并存。
- **远端角色 Skill bundle（WL-4.1.8）**按第六轮已取证形状重建：bundle 块移到重试循环之前只做一次，
  循环整体外层 `try`：成功释放旧 revision、异常撤销注册并恢复旧 handle。
- **Orca 授权缝收敛为上游单缝**：`authorizeToolCall`（仓内零生产者）删除，统一 `authorizeCall` +
  `withToolCallAuthority`（拒绝先于 `getWorkspaceInfo` 等副作用，入参带调用期 session 身份）；
  Meka 语义由 `taskActionAuthorization.test.ts` 覆盖。`wait_for_worker` 保留 ⇒ 工具总数 **22**
  （18 team + 3 只读诊断 + 1），`sessionContext.test.ts` 清单断言同步到 22。
- **Worker 目标路由（WL-4.2.1/4.2.2）**：入参 `remote_host_id` 走 Meka（Host 重核，不采信 prompt 字段）、
  输出 `workerCreationRoutePayload` 走上游、`execution_target` 由上游 `resolved.remoteHostId` 计算；
  MCPR Codex Worker 仍强制 `providerId='xd'` 与网关 key 校验。
- **auto-bridge**：结构取上游（`reportsInFlight` + `withWorkerTransition`），Host 回调保留 Meka 5 参
  （`workerSessionId` + terminal status），测试断言从 3 参扩到 5 参（更强）。
- **`fork.ts`**：上游「预热窗口档位先写后提交 + 失败撤销」结构 + Meka 三个身份字段
  （`mekaProjectId`/`mekaRoleId`/`mekaRole`）继承（§6.67 的修好点不回退）。
- **自动合并审计**：258 个 `M` 文件中真正被 Meka 改过的只有 15 个，其中与上游 `MERGE_HEAD` 逐字节相同
  的 **0 个** ⇒ 无整文件被上游静默顶掉。
- **实跑**：`orca-workflow` 62、`lizi-mcps` `server.test` 2 + 三个 create/start 工具测试 47、定向取证探针 5、
  `orcaTeamService` 223、`orcaLifecycleService` 67、`remoteSessionMakerMemory` 7、`orcaWaitForWorkerReport` 7、
  `mekaRuntimeInjection` 16（修掉跨组 P2：把 `await maker.createSession(o)` 字面量锚点改前缀匹配）。
- **残余**：`orcaInterAgentDispatcher.workerSessionId` 现只声明不被读取（消费已由上游
  `captureLocalWorkerReport` 承担）——死字段，登记不改；WL-4 端到端仍未验证。

### 2.5 maker-core / Agent Host / Pi（`wp7-core-host-report.md`，10 文件）

- `base-agent.ts`：采纳上游接口演进，删除上游已退役的通讯录注入类型（`36a333ac18` 把内置智能通讯录
  整体下线，由通讯录插件承接）。
- `codex/index.ts` + `maker-host/index.ts`：Meka 原生子代理硬关字段 / `nativeSkillRevision` 与上游
  `nativeStorageOnly` / 工具取消 / 模型接口存储**并集**；宿主侧把上游抽出的纯函数保留在调用点，
  不复制第二份判据。
- `pi/cindy-bridge-source.ts`：接纳上游 schema 指纹披露门、双包自愈与分页，保留 Meka 网关分类与
  **回执自带 schema** 的 `disclosureSignpost`（明说不需要再调 `list_tools`，少一次往返、不新增阻断）。
- `maker.ts`：上游启动取消处理 + Meka Codex resume 线程不匹配守卫并存。`mcp-providers.ts`：上游
  DB 快照 / 通讯录退役 / `authorizeCall` / `updateWorker` + Meka `waitForWorkerReport`。
- **同域额外修复**：`codexNativeSubagentsDisabled.test.ts` 因上游新增自由标识符
  `CODEX_GATEWAY_PROVIDER_ID` 而 `ReferenceError`（5 failed）⇒ 只补 scope 注入，
  **0 删除、0 动断言、0 改生产代码**，复测 **6 passed**。
- **Pi 原生非退化证据**：本轮对 Pi 控制层只有「采纳上游既有披露门 + Meka 文案增强」，
  **未新增**静态分析 / 内容指纹 / 宿主审批阻断；真实 Pi 二进制集成 `pi-mcp-bridge.integration.test.ts`
  **27/27 passed**（真实 `apps/pi-bin/win32-x64/pi.exe`）；未改 `apps/pi-bin/**`、版本 pin、
  `resolvePiBinaryPath` 只读不变。
- **实跑**：`anthropic-compat-proxy` 20 文件 / 568 passed、Pi 三文件 104 passed、`maker.ts` 与
  `maker.agentDevice` 164 passed、desktop 侧 `piProviderTransport`+矩阵+注册+注入+基线 113 passed、
  5 文件 78 passed（修后）。**残余**：`meka-runtime-mcp` / `piEnvironment` 在分组执行时被
  `@jackwener/opencli/catalog` 缺依赖挡住；收口后该依赖已就位（`exports` 有 `./catalog`、
  `packages/lizi-mcps/node_modules` 已 link），**这两个套件仍未复跑**，按 §4.2 记为「待最终门禁」。

### 2.6 侧栏 / CC-Agent / 设置 / 杂项 UI（`wp7-sidebar-report.md`，35 文件，含 1 `UD`）

- **侧栏 Meka 入口按上游新结构重实现**：`SidebarTopNav.tsx` 的 `SidebarNavigationSlot =
  SidebarNavigationEntryId | 'meka'`、`mekaRow`、槽位表 `splice` 与 `renderRows(slots)` **三处共用**仍在
  （整段 + 搜索前后两段）；rail 的 `mekaTileIndex`/`mekaEntry` 保留；**上游已删 `GhostPanelRestoreEntry`**
  ⇒ rail 的「面板恢复入口」行随之删除（保留会 import 不存在的模块）。
- **`CCAgentSidebarUpper.tsx`**：上游把「同步 Codex 项目」换成 `handleImportFromTools`，取上游并删除
  `handleLinkCodexProject` 与失去消费者的 `emitRefresh` import；4 个 Meka 处理器逐字保留。
  **`MainListScopeHeader.tsx`**：保留 Meka 的共享件 `SidebarHeaderActions`（WL-3.3 单一实现），
  但补回 `HEADER_HOVER_ACTION_CLASS` 包裹折叠按钮（上游新用例抓到 3 红 → 修后 3 绿）。
- **`NewMakerDraftRoute.tsx` 10 处**：Meka 的 `workspaceKind:'meka'` + project/role/formal 绑定、
  MCPR 设备 pill、`CREATE_AGENT_CONTEXT_TRIGGER_CLASS` 全部保留；设备维度取上游 `routeAgentDeviceId`
  （比 Meka 的 `effectiveAgentDeviceId` 更准）；`max-w`/`opacity` 的 Meka 有意差异就地注明。
- **`localDbFatalView.ts` 拒绝按位置拼接**：上游第二位参数是**本地库故障码**、Meka 是**更新器错误码**
  ⇒ 拆成 `resolveLocalDbFatalView(status, code?, updateErrorCode?)`，否则两条恢复路径同时失效
  （修后 10 条全绿）。
- **群历史/群窗口 4 个测试夹具**改按 Meka 谱系取文件（`0089`/`0092` + `0139`，见 §2.1），
  因为上游前缀在 Meka 树里是 `SELECT 1;` 占位，照抄会「拿不到群表」；修后 4 文件 66 条全绿。
- **`userInfoSectionHover.test.ts`（`UD`）按上游删除**：上游不再做源码字面量扫描，改为行为用例
  `userInfoSectionMobileDownload.test.tsx`（含「dev 构建显示 Global edition」）与
  `userInfoSectionUpdateFlame.test.tsx`（火焰入口 vs banner 互斥）。**WL-5.5 的自动化门禁已同批改指这两个文件**
  （见 `meka-whitelist-verification.md`），不保留 30+ 条 CSS 类名断言（与 `engineering-conventions.md` §3.2 对撞）。
- **实跑**：15 文件 / 355 条通过（含 `SidebarTopNav` 47、`CreateWorkerPopover` 101、`localDbFatalView` 10、
  `ErrorBanner` 81）+ `MainListScopeHeader` 3 + 群窗口 4 文件 66。**被 locale 冲突挡住 9 个文件**
  （`mekaSessionPresentation` 等）须在 i18n 收口后复跑。
- **未验证**：`NewMakerDraftRoute` / `CCAgentSidebarUpper` 只有源码级断言与 typecheck，无渲染级用例；
  WL-2.1/2.2/3.2/3.3 实机目检未跑；Light/Dark 未目检。

### 2.7 身份 / 构建 / 外壳（`wp7-identity-report.md`，19 文件）

- **身份字面值零改动**：`brandIdentity.ts` / `branding.ts` / `shared/deepLinkSchemes.ts` 本轮**未被上游改动**
  （`git status` 干净）；`CindyMeka`、`com.xd.cindy.meka`、`cindy-meka` 渠道、`cindy-meka-updater`
  与 RustFS Meka bucket 全在位（`test:runner` 的 `ok 33` / `ok 414-416`）。
- **`deepLink.ts`**：注释取 Meka 身份叙述并把上游新增 `builtin-tools` 条目改写成 `cindy-meka://`；
  **注册行为取上游**（`if (!app.isPackaged) return;`，未打包实例一律不接管系统关联），遍历仍是
  `DEEP_LINK_REGISTERED_SCHEMES`（**排除 `cindy://`**）；上游 `chat-invite` / `provider-share-join` /
  `islandEntryId` / `takePendingDeepLinkFromRenderer` 全部保留。文档落点见 §2.9 与
  `desktop-development.md`「开发深链与系统关联」的 Meka 口径补充。
- **`authManager.ts` 冷启动取上游可重试流程**：删除 Meka「提前 `loadClientEndpointsForRealm`，失败即
  `finishColdStartSignedOut('cold-start-realm-manifest-unavailable')`」的早退，保留
  `activeProductEdition = readPersistedProductEdition() ?? CURRENT_CINDY_REGION`（WL-5.6 不回退）。
  证据：上游新用例 `authColdStartRecovery.test.ts:508` 在保留早退时失败。规则落点
  `region-and-editions.md` §1.2（本轮补齐）。
- **`agent-island/state.ts`**：Meka silent-stop 挂起 + 上游「完成条目一日保留期」并存；
  第六轮修好的**锚点**（未读 TTL 不得被结算延迟顺延）扩到新锚点 `completedAt`，单测仍能抓锚点漂移。
  未读 completed 现走 24h 保留期 ⇒ **若产品要保留「未读完成 4h」需另行裁决**（回退点：
  `terminalRetentionAt()` 让 `unreadIslandTtlAt` 优先）。
- **构建**：`forge.config.ts` 资源并集（Meka `resources/meka` + 上游 `device-link-relay`）；
  Windows remote-desktop helper 取上游三次构建/`--target-dir`/crt-static 结构，但**第三种产物名保留
  Meka 的 `cindy_meka_windows_desktop_host_napi.dll`**（合并后的 `Cargo.toml` 仍声明该 `[lib] name`）。
  根 `package.json` 脚本并集：Meka 独有 16 条全留、上游新增 9 条全收；`test:runner` 名单 45 文件并集，
  **刻意删除** `log-upload-build-env.test.mjs`（该模块在 meka/main 已删，加回会 ENOENT）。
- **`ci.yml` 取上游四 Windows 分片 + 一次性 `windows-runner-checks`**：去掉恒假的 `if: matrix.shard == 1`
  并把 Meka 种子库回归并入该步；`push.branches` 仍含 `meka/main`。`restart-desktop-remote.mjs` 取上游
  fail-closed 进程表扫描 + 回写 Meka 三处（600s/夹取、双身份常量、正则补 `CindyMeka|CindyMekaDev`）。
- **实跑**：`restart-desktop-remote.test.mjs` 89 pass / 3 skip（安装后 103 pass）、其余三个脚本 141 pass；
  desktop 定向 6 文件 373 pass / 1 fail（唯一失败见 §4.3）；`pnpm install --frozen-lockfile --lockfile-only`
  exit 0（lockfile 与 manifest 一致，无内容改动）。
- **残余（收口后）**：真实打包/更新未验证（Windows helper 新参数只做静态一致性核对）；
  `@cindy/maker-shared` 的独立 `tsc` 2 条错误（上游 `botGroupProcess.ts` 的 `findLastIndex`，`lib` 为 ES2022）
  **已在本轮收口修好** —— `packages/maker-shared/tsconfig.json` 的 `"lib": ["ES2022"] → ["ES2023"]`
  （`target` 与 `noEmit` 不动，V8 早已支持该 API，运行期无降级），`pnpm --filter @cindy/maker-shared run build`
  **exit 0**；这是上游自身遗留的 lib 缺口（`MERGE_HEAD` 的 tsconfig 同为 ES2022），不是 Meka 侧差异。

### 2.8 i18n（`wp7-i18n-report.md`，10 冲突文件 + 全域 12 语审计）

- **做法**：三方内容取证（`:2:`/`:3:` 各自 `JSON.parse` 成完整对象）→ **以上游结构为基**（采纳新增/
  删除/重排）→ 把 Meka 自有 key 按相对位置锚点回插 → 同 key 冲突（3 条，均为上游通用文案/语义已变）
  取上游 → 再按 **12 语**做 key 集合对齐。**不从冲突块整体选边**。
- **落地数**：desktop `common.json` leaves — en **15980**、ja/ko/zh-CN/zh-TW 各 **15908**、
  de **15980**、es/fr/pt-BR/pt-PT 各 **16166**（多 `_many` 复数类别）、文言两版 **15906**；
  mobile `settings.json` 12 语均 **274**（+2 Meka 键 −7 WL-26 上传键）。`check:i18n` 归一后
  **15783 键 12 语全部一致**；`JSON.parse` 300 个 locale 文件 0 失败、逐层重复 key 0 命中。
- **Meka 保留面**：**571 个 Meka 自有键**（`meka.*` / `mekaSkills.*` / `slotMcpr` / `slotReveal` 等）
  零丢失；本轮新增 1 键 `settings.ghosts.detail.panelModal` × 12 语（面板三态状态行，见 §3）。
- **WL-26 收口（同批）**：`localLogs.upload*` 7 键 0 消费者 ⇒ 从 12 语删除；`localLogs.footer` 仍有渲染
  消费者，键保留、**12 语文案按 WL-26 重写**；`logSupport.*` 只留本地面文案。
- **扩语代价如实登记**：设计稿估算的「7 语 × 13 键 = 91 条」**不足以过门禁** —— `check-i18n.mjs` 以
  全部 locale 的 key 并集为基准，7 个新语种相对合并后 en 的**真实缺口是 570~574 键/语**（desktop 合计
  **4008 条**）+ mobile 2 键/语；已按「英文占位（文言用现代底本）+ 登记翻译债」补齐
  （**翻译债**：de/es/fr/pt-BR/pt-PT 与文言为占位，需后续人工翻译）。
- **实跑（本会话复跑，exit 0）**：`pnpm check:i18n`（15783 键一致，警告 7464 处为非 en 值与 en 相同等
  预期占位）、`pnpm check:i18n-glossary`（33 条已裁决 / 170 条待讨论，无新增违规）、
  `pnpm check:brand-terminology`（PASS，`{{appName}}` 合规）、`pnpm check:endpoints`。
- **未验证**：12 语界面**实机目检**（字形/换行/截断）未做；文言为现代底本占位，属已知产品债。

### 2.9 治理 / 规则文档（`wp7-governance-report.md`，14 文件）

- 原则：**以上游规则为宿主**，把 Meka 私有产品线背景、已裁决例外与 Meka 专属入口并回新结构。
  `AGENTS.md` 按上游「按模块进入 + 规则索引」重排，保留「首要背景：Meka 私有产品线」全节、Meka 技能/
  注入层/MCPR/插件分发/`meka/main` 命名 §8/同步静默丢失门禁/白名单/文档同步/门禁时机与「交付」判据/
  直推唯一门禁/第四轮「提交前测试门禁不放宽」说明块；`docs/dev-rules/README.md` 改为上游主题表 +
  新增「Meka 私有产品线」专区；`development-workflow.md` 保留 Meka 门禁正文并把上游新增两节落为 §5/§6。
- **本轮采纳的上游新规则（摘要）**：`check:dev-docs`（纯文档）、`AGENT_ENV_TEST_POLLUTANTS`、长测试输出
  落盘、测试价值门槛 §3.2 与性能预算、`check:test-hygiene`（CI 阻断、基线只减不增）、
  `ui:check`/`ui:preview`/`ui:check:publish`、内存排查、Windows 安装目录与远程桌面 CRT 验收、
  Registry V6 多接口目录、`feature-retirements`、Browser Use、Device Link 自建中转同步维护、
  `server-channel-review`、`DESIGN.md` §16 迁出到 `login-flow.md`（`LoginRealmSelector` 迁入）。
- **失效引用修复**：`docs/dev-rules/README.md` 的「开发工作流 §5」→ §6、`AGENTS.md` 的「§4/§5」→ §5/§6、
  `request_input_handoff` → `ask_owner`（工具已改名）、`desktop-development.md` 的行号锚点改符号名、
  `orca-team-architecture.md` 工具数 21 → **22** 并删除已不存在的 `settleWorkerReport()` /
  `authorizeToolCall`（改为 `authorizeCall` / `withToolCallAuthority`）、`DESIGN.md` 生成脚本路径。
- **本报告同批改的规则文档**（详见 `_analysis/wp7-docs-report.md`）：
  `meka-whitelist-verification.md`（WL-1.5 重写、WL-5.5 门禁改指、WL-26 终态）、
  `database-and-migrations.md`（编号现状）、`plugin-security-and-authoring.md`（§4 面板模型、§4.3、
  §5 拒绝点净变化、gh-cli 权限扩大）、`electron-security-and-process-boundaries.md`（插件面板无专属窗口）、
  `desktop-development.md`（Meka 深链口径）、`region-and-editions.md`（冷启动可重试端点流程）、
  `log-upload-and-redaction.md` §4.1（移动端 `diagnosticUpload.ts` 文件名更正 + 已删除）、
  `engineering-conventions.md` §3.2（`check:test-hygiene` 本地基准改 `origin/<branch>`，`--base` 可显式指定）。
- **实跑**：`pnpm check:dev-docs` **10/10 pass**（治理组三轮复跑；本报告交付后本会话再复跑一次，见 §4.1）。

### 2.10 生成物（**已由生成器重建，不手改**）

12 个冲突生成物 + 9 个连带产物已从**源**重建（原报告 `_analysis/wp7-generated-report.md`），全部 0 冲突标记：

| 生成物 | 命令 | 结果 |
| --- | --- | --- |
| `apps/desktop/src/main/maker-ipc/helpKnowledge.generated.ts` | `pnpm --filter desktop gen:help-kb` + `gen:help-kb:check` | `wrote 33 docs`；`PASS — generated KB is in sync` |
| `docs/design-rules/design-inventory.md` | `pnpm design:inventory` + `pnpm check:design-inventory` | **63 个 surface**；`PASS — GENERATED 区块最新`（人工区保留） |
| `docs/legal/notices/**`（含 `sbom/*.spdx.json`）与 `THIRD-PARTY-{NOTICES,RESTRICTED}.txt` | `pnpm licenses:generate`（复跑一次做确定性校验） | **19/19 文件哈希一致**；SBOM 可解析（`spdxVersion: SPDX-2.3`）；`third-party-notices.test.mjs` 14/14、`design-inventory.test.mjs` 52/52 |

组件集合三方比对：上游与 HEAD 组件均保留（唯一差异是 lockfile 把 `acorn@8.17.0` 解析为 `8.19.0`，属版本更新），
并新增 `gifenc@1.0.3`（正是本轮合并后的依赖）⇒ 产物取自**合并后**依赖集。
**注意**：SBOM 的 `created` 取自 `pnpm-lock.yaml` 最近提交，合并提交落盘后需再跑一次 `licenses:generate`
（否则会产出一次时间戳 diff，属生成器既有行为）。

## 3. 第二阶段面板收敛定稿（上游全局页签 + Meka Modal）

> 决策依据：`_analysis/wp7-panel-design.md`（设计稿，含逐入口/逐键裁定）与
> `_analysis/wp7-audit-prep.md` §3；代码事实以当前工作区锚点为准。上游删除源仅
> `abb83fa21c`（96 文件 `+1272 −5917`）。

**最终形态 = 一个停靠宿主（上游右侧栏全局页签）+ 一个 Modal 宿主（Meka），由单一 effective resolver
二选一；`panel.position:'tab'` 交回上游插件页内宿主；整条「布局树停靠 pane + 面板独立窗口 + 气泡/恢复
入口」旧链路彻底删除。**

| 维度 | 定稿 | 依据 |
| --- | --- | --- |
| `docked` | 上游右侧栏**全局页签** `plugin-view`（`view:'panel'`，复用 `GhostChipPanelBody`）；落边 = 页签组记忆 > `panel.position`（Meka 三插件 = `left` ⇒ 聊天区左侧页签组） | 上游 `abb83fa21c` 自述「停靠面板这一层退场」；`globalTabs.defaultGroupForGhost` |
| `modal` | Meka `GhostPanelModal`（同页覆盖层，90vw/90vh）；**不是**第三种页签，不参与页签组/拖拽/弹出窗口 | WL-1.5 / `plugin-security-and-authoring.md` §4 |
| `tab` | 上游 `GhostPagePanelHost`（插件页内独占宿主）；**取消** Meka 旧「无会话宿主时用 Modal 兜底」 | §2.3 单宿主不变量 I1 |
| 旧链路 | 停靠 pane / `PanelChrome` / `main/ghost-panel-window/**` / `ghostPanelWindowPreload` / `?ghostPanelWindow=` 路由 / `GhostPanelBubbleLayer` / `GhostPanelRestoreEntry` / `useMinimizedGhostPanels` / 恢复入口设置项：**全部移除** | 上游删除面（磁盘 13 模块 + 5 测试已 `Test-Path=False`） |
| 优先级 | 插件级 override → Meka 全局开关 → 停靠产品默认（不变） | WL-1.5 |
| 关闭语义 | 关页签 = `dismissed`（跨重启记忆）；关 Modal = 仅隐藏（不写 dismissed、不清组记忆）；两者不互写 | I3 |
| `position` 五值 | 跟上游 `['left','right','top','bottom','tab']`；**删除** Meka 旧「`right` 归一化为 `left`」⇒ 声明 `right/top/bottom` 的旧包**真的**落到该边（行为变化，登记 §6.3） | 上游 `shared/ghost.ts` |
| `systemButtons` | 继续被校验（存量声明不得因此拒装），但**退化为声明数据**：无 UI 消费方（`maximize`→页签组/弹窗，`detach`→页签弹出窗口，`minimize`→关页签） | §2.10 |
| `mainView` | 全量跟随上游（`open: page|sidebar|window`、`side`、`icon`、`multiple`）；Meka 现无 mainView 插件，但安装/校验路径必须放行 | Q8 = 跟随上游 |
| `taskView` | 协议层接受，**UI 层不主动开放**（不写文档、不进作者模板、不做市场准入校验）；开放属新增产品面，另立裁决 | Q9 / Q-E |

**新增拒绝点（唯一一处，已登记）**：`position:'tab'` 的 `panel` 声明 `allowUserPresentationOverride` 或
`minWidth`/`defaultFraction`/`systemButtons` ⇒ **拒装**（文案「仅停靠形态(left)有效」）；该字段必须是布尔值。
影响面 = 已声明 `tab` 且声明该字段的插件，当前 **0 个**；存量已装插件无需重装/重确认/重配置 ——
机制是**严格路径才拒装**（`validateGhostManifest` 拒非法值，`validateInstalledGhostManifest` 对已装快照
`preserveHistoricalTasks` 容错，历史非法值按未知字段保留），由 `shared/__tests__/ghost.test.ts` 的
「严格新装拒非法值，已装快照容错」用例锁住。

**旧状态迁移（只读，不主动删数据）**：
- `xdt:ghostPanelBubble:v1`：上游 `reconcileGlobalPluginTabs` 只读消费
  （`globalTabs.ts:478-484` 读旧键、`:498` `legacyPanelEdge`、`:532-538` 迁移落点：命中实例记 `dismissed`、
  旧边迁成页签组），Meka **不再写**。
  升级前被气泡抑制过的面板因此**不会**自动出现在右栏 —— 详情页状态行显示「已从右侧栏关闭」+
  「在右侧栏中打开」按钮，属**有意的可发现行为**，不是静默消失。
- `userData/ghost-panel-windows-settings.json`（旧独立窗口账本）与恢复入口偏好成为**孤儿键**：
  列入清单但**不主动删**（删键属数据操作，需单独批准）。
- 布局树里的 `ghost:<id>` pane：保留历史数据、无渲染方（上游口径），**不清理**。
- Meka 自有偏好（`xdt:ghostPanelPresentation:v1` / `...Overrides:v1`）语义不变，`docked` 现表示「上游全局页签」。

**实现锚点（符号名为准，行号为 2026-11-12 版实测）**：`shared/ghost.ts` 面板段校验（`:4673-4729`：
布尔拒装 `:4680-4686`、`tab` 拒装 `:4704-4709`、已知键 `:4714-4719`、作者往返 `:4727-4728`）、
`renderer/lib/ghostPanelPresentationPreference.ts::resolveGhostPanelPresentation`（`:178`）/
`useGhostPanelPresentation`（`:189`）、`renderer/features/plugin/lib/panelTabProjection.ts`
（`syncPanelTabProjection` `:36` / `applyGhostPanelPresentationChange` `:47`）、
`globalTabs.ts` 两处 `[MEKA]` seam（`isAutoGlobalPanelGhost` `:457-462` / `setGlobalPanelAutoTabEnabled`
`:576-591`）、`cindy-brain/ghostPanels.tsx:40`、
`GhostPanelModal.tsx:56`（非 modal 呈现 `return null`）、`useGhostPanelLauncher.tsx:92-98`（`tab` 直接交插件页
宿主、docked/modal 由 resolver 分流）、`GhostPluginPage.tsx:614`（`tab` 分流）与
`:1267-1278`（三态 `panelStatus`，含新键 `panelModal`）。

**与既有设计系统契约的衔接**：`GhostPanelModal` 现有实现对 `modalSurfaceContract.test.ts`
（`modal-scrim`/`modal-panel`、禁自绘圆角/阴影/底色）与 `dialogScrimDismissal.test.ts` 已合规，本轮不改外观类。

## 4. 验证

> 口径：**已实跑** = 本会话或分组报告中确有一次真实执行并给出结果；**待最终门禁** = 未跑或跑在
> 中间态、不得当作通过。原始日志在各分组报告指出的 `_analysis/wp7-*` 路径下。

### 4.1 本轮已实跑（可复现命令与结果）

| 命令 | 结果 | 来源 |
| --- | --- | --- |
| **阶段 A 结构审计**：`pnpm audit:merge`（索引已 stage，2026-11-12 实跑） | **PASS（有待确认项）**：`blockers=0` / `dropped=0`（首跑 20 条 DROPPED 已消除，其中 **18 条逐条 `--allow`**，清单见 `_analysis/wp7-audit-allow.log`；主体为 WL-26 上报面移除 7 文件、移动端上传/文言文案、面板呈现偏好、`forge.ts` / `authLoginFlowReset.test.ts` / `design-inventory` 等有意取单侧项）/ `review=31`（**19 条 drizzle SQL 顺移** + 12 条 snapshot/其它，DB 组已逐字节确认）/ `generated=34`（20 drizzle + 13 notices + lockfile） | 本会话（11-12）；`_analysis/wp7-audit-index.log`、`wp7-audit-allow.log` |
| `pnpm --filter desktop typecheck`（11:33 最终树） | **exit 0 / 0 error**（`_analysis/wp7-typecheck-final.log`） | 本会话（11-12） |
| `pnpm test:db` | **exit 0**：`PASS apps/desktop db (390.6s)`，788 例 / 777 pass / 0 fail（含 `migrationReplay` 在内的 db tier；`test:runner` 作为前置一并跑过） | `_analysis/wp7-test-db.log` |
| `pnpm test:device-link` | **exit 0**：1 文件 / **10 passed**（真实 loopback WebSocket 契约夹具） | `_analysis/wp7-test-device-link.log` |
| `pnpm desktop:ui-smoke` | **PASS**：`checks=15 pass=13 fail=0 unverified=2`（**0 FAIL**）。2 项 unverified = WL-1.2 / WL-1.3 的 MCPRouter / MekaDesign **「配置」对话框**：当前 profile 已连接，入口被「断开」替代；为不打扰用户真实凭证未造未连接态。**脚本已改为按连接状态分支**（已连接断言「断开」/ 未连接断言「配置」并开对话框），不再误报 FAIL | `_analysis/wp7-ui-smoke2.log` |
| `pnpm desktop:session-smoke` | **PASS 11/11**（`checks=11 pass=11 fail=0 unverified=0`）：WL-11.3 = `workspace_kind=meka / project=saga2 / role=saga2-default-role / is_formal=0`；WL-11.6 运行期 `mcp=mcp-router,meka-design`、`skillsCount=51`、`workflow键=不存在`；WL-11.17 参考段 4 条 | `_analysis/wp7-session-smoke3.log` |
| Phase 2 面板 CDP（main target 实测） | **docked 时 `ghost-panel-modal` = 0** → 详情选「弹窗打开」→ `[data-testid=ghost-panel-modal]` **=1 且 header=Meka P4** → 切回 `inherit` → **=0**（WL-1.5 的单宿主/双向切换由此取得实机证据） | 本会话（11-12）；日志同 ui-smoke 批次 |
| `pnpm test:unit`（**已跑完，仍不是全绿**） | **apps/desktop tier** 原始：`Test Files 20 failed \| 3978 passed \| 11 skipped (4009)`、`Tests 80 failed \| 68567 passed \| 194 skipped (68841)`（**1078.1s**，`TEST_COLLECT_FAILED`）。归因与修复见 **§4.6**：**12 文件已修复并复跑**（11 文件 190/190 + `RemoteSkillsPage` **18/18**）、**8 文件为本机 Windows EPERM 建 symlink**（CI Linux 不受限）；`apps/mobile unit` 的 `mobileAndroidSimulator` **16/16 已修复**；`packages/maker-core unit` 的 `codex/index.test.ts` + `device-hosted-guest.test.ts` **1077/1077 已修复**、`cindySubagentRunner` **1 例 Windows OS inventory 超时（环境）**。**剩余仅 8 EPERM + 1 超时** | `_analysis/wp7-test-unit-final.log`（11:41 起）+ 复跑证据见 §4.6 |
| `pnpm check:test-hygiene` / `pnpm check:settings-search`（最终树复跑） | **PASS 372 files**（test-hygiene，exit 0）/ **PASS**（settings-search，`--merge-parent` 双父判据 + 33 条 Meka 定义） | 本会话（11-12） |
| `pnpm --filter desktop db:validate` | **6/6，exit 0**：151 sql / seq `0000..0150`；journal↔sql↔snapshot 对齐 + `id`/`prevId` 链连续；`drizzle-kit check` 无 drift；151 snapshot；52 companion 全 CommonJS；固定基线 80 SQL + 23 script；canonical 冻结 132 SQL + 47 script | `wp7-db-report.md` §6.1 |
| 独立复算 `verify.mjs` / `semantic-check.mjs` | **133/133 PASS** / **12/12 PASS** | `wp7-db-report.md` §6.2/§6.3 |
| `pnpm check:i18n`（**本会话复跑**） | **exit 0**：12 locale 共 15783 key 全部一致（警告 7464 处为预期的「非 en 值与 en 相同」等） | 本会话 |
| `pnpm check:i18n-glossary`（**本会话复跑**） | **exit 0**：33 条已裁决 / 170 条待讨论，无新增违规 | 本会话 |
| `pnpm check:brand-terminology`（**本会话复跑**） | **exit 0**：PASS，无违禁品牌写法、locale 使用 `{{appName}}` | 本会话 |
| `pnpm check:endpoints`（**本会话复跑**） | **exit 0**：`endpoint source guard passed` | 本会话 |
| `pnpm check:dev-docs` | **10/10 pass**（治理组三轮复跑；本轮文档收口后再复跑，见下） | `wp7-governance-report.md` §6 |
| `node --test scripts/__tests__/meka-whitelist-contract.test.mjs`（**本会话复跑**） | **5/5 pass**（WL 结构契约：四字段齐备、编号唯一升序、命令真实存在、被 AGENTS/开发工作流索引） | 本会话 |
| `pnpm install --frozen-lockfile --lockfile-only` / 完整 `pnpm install` | **exit 0** / **exit 0（5m27s）**；lockfile 与 manifest 一致、无内容改动；workspace link 实测就位 | `wp7-identity-report.md` §5 |
| 插件基座 10 文件定向 vitest | **252 passed**（`scheduleSlot` 60 / `marketGhostSessionBoundary` 19 / `builtinGhostProvisioner` 32 / `pickSlot` 30 / `ghostLocalFileIpc` 27 / `ghostLocalInstallIdentity` 33 / `ipcErrorBoundary` 15 / `pluginDistributionContract` 28 / `mekaDownloadPolicy` 3 / `ghost.mcpr` 5） | `wp7-plugins-main-report.md` §6 |
| 侧栏/UI 15 文件定向 vitest | **355 passed**（`SidebarTopNav` 47 / `CreateWorkerPopover` 101 / `localDbFatalView` 10 / `ErrorBanner` 81 等）+ `MainListScopeHeader` 3 + 群窗口 4 文件 66 | `wp7-sidebar-report.md` §3.2 |
| maker-ipc / Orca 定向 | `orca-workflow` 62、`lizi-mcps` 2 + 47、探针 5、`orcaTeamService` 223、`orcaLifecycleService` 67、`remoteSessionMakerMemory` 7、`orcaWaitForWorkerReport` 7、`mekaRuntimeInjection` 16 | `wp7-maker-ipc-report.md` §4 |
| maker-core / Pi 定向 | `anthropic-compat-proxy` 568、Pi 三文件 104、`maker.ts` 164、desktop 113 + 78（含真实 Pi 二进制集成 **27/27**） | `wp7-core-host-report.md` §6 |
| 身份/外壳定向 | `restart-desktop-remote` 89 + 安装后 103、其余三脚本 141、desktop 6 文件 373 pass / 1 fail | `wp7-identity-report.md` §6 |
| i18n 定向 | `i18nCompleteness` 5 + `i18nBrandPlaceholder` 4 = 9 passed；`i18nCatalogParity` 49 passed | `wp7-i18n-report.md` §8 |
| WL-26 面板/日志定向（**本会话**） | 见下方「本会话补充取证」 | 本会话 |
| `pnpm test:runner`（**本会话复跑，收口后**） | **exit 0**：**781 例 / 770 pass / 0 fail / 11 skip**（253s；含 `meka-whitelist-contract`、`design-inventory`、`third-party-notices`、`glossary-rules`、`check-test-hygiene`） | 本会话 + `wp7-identity-report.md` §10.4 |
| `pnpm check:test-hygiene`（**本会话复跑**） | **exit 0 / PASS（372 files within baseline）**；本地基准解析改为当前分支 `origin/<branch>`（`--base` 可显式指定），拒绝上调语义未动 | 本会话 + `wp7-identity-report.md` §10 |
| `pnpm check:design-inventory`（**本会话复跑**） | **exit 0**：`GENERATED 区块最新（63 个 surface）` | 本会话 |
| `gen:help-kb` / `--check`、`licenses:generate`、notices/inventory 自测 | `wrote 33 docs` / `PASS in sync`；19 个产物复跑哈希一致；`third-party-notices` 14/14、`design-inventory` 52/52 | `wp7-generated-report.md` §4 |
| `pnpm --filter @cindy/maker-shared run build` | **exit 0**（`lib` 修为 ES2023 后；`tsc --noEmit`） | `wp7-wl26-report.md` §5 |

**本会话补充取证**（文档收口时按白名单条目实跑，属取证不是最终门禁）：

| 命令 | 结果 |
| --- | --- |
| `pnpm --filter desktop exec vitest run src/renderer/lib/__tests__/ghostPanelPresentationPreference.test.ts src/renderer/features/plugin/lib/__tests__/panelTabProjection.test.ts src/renderer/cindy-brain/__tests__/GhostPanelModal.test.tsx src/renderer/__tests__/pluginPanelPresentationPreference.test.tsx src/renderer/features/right-sidebar/__tests__/globalTabs.test.ts` | **5 文件 / 37 用例全绿**（偏好 store 10 + 页签投影 6 + 三态选择器 3 + Modal 5 + `globalTabs` 13） |
| `pnpm --filter desktop exec vitest run src/main/log-upload/__tests__/redact.test.ts src/main/github-issue/__tests__/issueDiagnostics.test.ts src/main/performance-trace/__tests__/performanceTrace.test.ts src/renderer/components/log-support/__tests__/StartupLogSupport.test.tsx` | **4 文件 / 100 用例全绿**（`redact` 58 + `issueDiagnostics` 2 + `performanceTrace` 26 含「`upload` 命令必须 `INVALID_PARAMS`」+ `StartupLogSupport` 14 含「只有打开日志目录 / 无 `uploadLogsNow`」） |
| WL-26 收口定向（WL-26 执行组）：`src/main/performance-trace/__tests__ src/main/log-upload/__tests__ src/main/github-issue/__tests__/issueDiagnostics.test.ts` / mobile `src/debug` / `MenuButton+log-support` | **8 文件 / 251 passed** / **11 文件 / 68 passed**（含 `diagnosticUpload.test.ts` 已随模块删除）/ **2 文件 / 17 passed** | `wp7-wl26-report.md` §6 |
| `pnpm check:dev-docs`（文档收口后复跑） | **10/10 pass，exit 0**（纯文档改动的仓库门禁；含本报告与 §11.37 的内链/命令一致性） |

### 4.2 待最终门禁（**未跑或未全绿，不得当作通过**）

| 项 | 现状与原因 |
| --- | --- |
| `pnpm test:unit`（**已跑完，仍不是全绿**） | **不得写成 PASS**。**剩余仅 2 类环境项**：① **8 个 desktop 文件**因本机 **Windows symlink EPERM**（`native-binding`、`replyArtifacts`、`pluginAppearanceResources`、`pluginUiPageResources`、`pluginFileAccess`、`browserScreenshotResolver`、`botSkillStore`、`chatServerReplyFiles`；CI Linux 不受限）；② **`cindySubagentRunner` 1 例** Windows OS inventory 超时（测试内已有 Windows CI 注释，属环境）。其余原始失败已全部修复复跑：`RemoteSkillsPage` **18/18**、11 文件 **190/190**、mobile `mobileAndroidSimulator` **16/16**、maker-core `codex/index.test.ts`+`device-hosted-guest.test.ts` **1077/1077**（明细见 §4.6） |
| 真机打包 / 真机更新 | **未跑**（§6.1） |
| 移动端冷更**实机** | **未跑**（§6.1；批准门已过、mobile 全量复用上游） |
| Light / Dark 与十二语**人工目检** | **未跑**（`ui-smoke` 已做十二语程序化横切与功能断言，不等于人眼目检字形/换行） |

> 收口后已转绿、**不再列在这里**：`pnpm audit:merge`（PASS，18 条逐条 allow / 31 REVIEW / 34 GENERATED）、
> `pnpm --filter desktop typecheck`（exit 0 / 0 error）、`pnpm test:db`（788 例 / 777 pass）、
> `pnpm test:device-link`（10/10）、`pnpm desktop:ui-smoke`（15 checks：13 pass / 0 fail / 2 unverified）、
> `pnpm desktop:session-smoke`（11/11）、`pnpm test:runner`（781/770/0）、`pnpm check:test-hygiene`（372 文件 PASS）、
> `pnpm check:settings-search`（PASS）、`pnpm check:design-inventory`（63 surface 最新）、三个生成器与
> `@cindy/maker-shared` 的 `build`。

### 4.3 已知红与归属（**逐条给机制，不冒充通过**）

1. **`authColdStartRecovery.test.ts` 1 例 —— 已收敛（2026-11-12）**：`continues a retry requested before
   the stopped request fails without offering new login` 此前为红，根因是**测试隔离**（`manualLogin` 之后
   未清 provider spy，spy 串到了后续用例），不是生产语义问题（曾用上游 `:3:authManager.ts` 复现同样
   失败）。修法 = **清 spy**，**断言未弱化、未删除**。见 §4.5 修复记录第 3 条。
2. **`test:unit` 的剩余失败（2026-11-12）—— 只剩两类环境项，见 §4.6**：① **8 个 desktop 文件**因本机
   **Windows symlink EPERM**（CI Linux 不受限，非代码回归）；② **`cindySubagentRunner` 1 例** Windows
   OS inventory 超时（测试内已有 Windows CI 注释）。**其余原始失败均已修复复跑**：desktop 12 文件
   （`RemoteSkillsPage` **18/18** 属真实目标 Hub 行为修复；11 文件 **190/190**）、mobile
   `mobileAndroidSimulator` **16/16**、maker-core `codex/index.test.ts` + `device-hosted-guest.test.ts`
   **1077/1077**。**全量仍不是全绿，不得写成 PASS。**
3. **历史红已消失**：`@jackwener/opencli/catalog` 不是缺链（`packages/opencli-vendor` 的 `exports` 已含
   `./catalog`，且 `packages/lizi-mcps/node_modules/@jackwener/opencli` 已 link，`require.resolve` 指向
   `opencli-vendor/cindy/catalog.ts`）；`@cindy/maker-shared` 的 ES2023 已修（`lib: ["ES2023"]`，
   `build` exit 0）；`scripts/test-hygiene-baseline.json` 的缺口已按 §3.2 收口（详见 §4.1 与
   `wp7-identity-report.md` §10）。

### 4.5 收口修复记录（2026-11-12，交付前最后一轮；**非门禁**）

1. **`NewMakerDraftRoute` 的 Meka 草稿不再预建 provisional dialogue 会话** —— 这是 WL-11.3 的**真实根因**：
   预建的临时「对话」行会让 Meka 草稿先以 `workspace_kind` 非 meka 的身份落库/落分组，表现为新建草稿后
   多出一条普通对话、项目绑定不对。改为不预建，绑定由创建路径完整写入（`session-smoke` 11/11 复验）。
2. **maker-ipc `send_to_session` 的 create 分支完整保留 `'meka'` 绑定** —— `workspace_kind` / project / role
   三键必须一起写；缺一即降级为普通会话（与 WL-3 / WL-11.3 同一条不变量）。
3. **`authColdStartRecovery.test.ts` 在 `manualLogin` 后清 provider spy** —— 测试隔离修复，断言未弱化。
4. **`check:settings-search` 加 `--merge-parent` 双父判据 + 33 条 Meka 定义** —— 防「只搜单侧父线」漏项：
   合并提交有两个父，搜索项校验必须对**双父**同时成立；Meka 侧 33 条设置搜索定义已登记。
5. **`desktop:ui-smoke` 的 MCPRouter / MekaDesign 检查改为按连接状态分支** —— 已连接断言「断开」，
   未连接才断言「配置」并验证对话框；不再把「用户真实已连接」误报成 FAIL（本轮 15 checks = 13 pass /
   0 fail / **2 unverified** 即此两态无法在不影响用户凭证下构造）。

### 4.6 `test:unit` 归因与修复清单（2026-11-12；**不得读成全绿**）

原始结论（`_analysis/wp7-test-unit-final.log`）：`apps/desktop unit` = `Test Files 20 failed | 3978 passed |
11 skipped (4009)`、`Tests 80 failed | 68567 passed | 194 skipped (68841)`（**1078.1s**，tier 结论
`TEST_COLLECT_FAILED`）；另 `apps/mobile unit` = 1 文件 / 2 例（`mobileAndroidSimulator`，250.7s）、
`packages/maker-core unit` = 4 文件 / 6 例（130.9s）。

**最终归类（修复后仍在的只剩环境项）**：

| 组 | 原始失败 | 处理 |
| --- | --- | --- |
| desktop 12 文件 | 20 文件失败中的 12 个 | **已修复并复跑 PASS**（11 文件 **190/190** + `RemoteSkillsPage` **18/18**） |
| desktop 8 文件 | 本机 **Windows EPERM** 无法建 symlink | **环境项，非代码回归**；CI 的 Linux runner 不受限 |
| mobile 1 文件 | `mobileAndroidSimulator` 2 例（Windows 参数断言） | **已修复并复跑 16/16 PASS** |
| maker-core（3 文件） | `codex/index.test.ts` 3 例 + `device-hosted-guest.test.ts` 1 例 | **已修复并复跑 1077/1077 PASS** |
| maker-core（1 文件） | `cindySubagentRunner` 1 例 Windows OS inventory 超时 | **环境项**（测试内已有 Windows CI 注释） |

**已修复的 12 个 desktop 文件**：
- `RemoteSkillsPage`：**生产修复** —— `SkillhubMarketDetailView` 的默认 `loadSkillFiles` / `readFile` 改走
  `SkillhubBrowseApi`（**目标 Hub**），不再直连 `window.electronAPI.skillhub`；这是真实的目标 Hub 行为修复，
  不只是改测试。复跑 **18/18 PASS**。
- `newMakerDraftSubmission`：补 `effectiveCollabEnabled` / `isMekaDraft` / `isFormalDraft`，并修真实
  `messageToSend` 的「首条 pending」别名同步；
- `dingtalk` / `wecom` adapter：迁移 fixture 改按 Meka 谱系（`0089` + `0092` + TS 脚本 + `0139`）；
- `pluginMarketSurface`：`MyPluginsPage` 走 `marketApi`；
- `marketPluginInstallProgress`：补 `AuthContext` + `initReactI18next` mock；
- `tabAvailability`：补 `ghostPanelPresentation` 的 `window` 守卫；
- `textTierDiscipline`：placeholder token；
- `makerEventHotPathOrdering`：Meka wrapper 断言；
- `packagedResourceDeclarations`：`..` 豁免 `.app` bundle；
- `built-in-skills`：Meka 4.25 / 4.26 Host 追加段；
- `foreignSourceAdapters`：本机 `DSH_HOME` 环境变量污染（清掉后恢复正常）。
  复跑证据：11 个文件在同一树上单独执行 vitest → **190/190 PASS**。

**另外两个 tier 的修复**：
- mobile `mobileAndroidSimulator.test.ts`：Windows 参数断言改为**解析后的 `pnpm.cmd` 路径**（不再比较字面量），
  复跑 **16/16 PASS**。
- maker-core `codex/index.test.ts`：Codex 断言改用**恒在的 `features.goals:false`**（不再依赖缺失键）；
  `device-hosted-guest.test.ts`：**mock 掉开发机 `~/.claude/agents` 泄漏**（第六轮已登记的开发机环境依赖）。
  两文件合计复跑 **1077/1077 PASS**；**无生产行为变化**（仅测试）。
  `project-resource-cli` 未再出现在剩余清单（复跑未复现）。

**结论**：全量 `test:unit` **仍不是全绿**，剩余 **8 个 desktop 文件（Windows symlink EPERM）+ `cindySubagentRunner`
1 例（Windows OS inventory 超时）** 均为本机环境项，**不得写成 PASS**。

## 5. 生成物与依赖

| 生成物 | 来源命令 | 状态 |
| --- | --- | --- |
| `pnpm-lock.yaml` | 自动合并 + `pnpm install --frozen-lockfile --lockfile-only` | **exit 0**，lockfile 与全部 workspace manifest 一致（`git diff` 无内容改动） |
| `apps/desktop/drizzle/meta/0132..0150_snapshot.json` + `_journal.json` | D4 顺移（上游同内容 snapshot + Meka delta；§2.1） | 每份 delta 恰 15 项、剥 delta 后与上游逐字符相等；journal 151 条连续；`db:validate` 6/6 |
| `docs/design-rules/design-inventory.md` | `pnpm design:inventory` + `pnpm check:design-inventory` | **已重建**：63 个 surface；`--check` exit 0；人工区保留 |
| `docs/legal/notices/**` + `THIRD-PARTY-{NOTICES,RESTRICTED}.txt` | `pnpm licenses:generate`（复跑一次做确定性校验） | **已重建**：19 个产物、两次哈希完全一致；`third-party-notices` 14/14 |
| `apps/desktop/src/main/maker-ipc/helpKnowledge.generated.ts` | `pnpm --filter desktop gen:help-kb` + `:check` | **已重建**：33 篇；`PASS — generated KB is in sync` |

> 本节实跑证据见 `_analysis/wp7-generated-report.md` §4/§5；**唯一后续动作**：合并提交落盘后再跑一次
> `licenses:generate`（SBOM `created` 取自 `pnpm-lock.yaml` 最近提交，否则会有一行时间戳 diff）。

## 6. 未验证 / 批准门 / 待裁决

### 6.1 未验证（有明确原因，需维护者书面接受）

1. **WL-4 全部端到端（V1–V4）**：需要 MCPRouter 账号 + 已绑定到 Meka 项目的实例（Claude/Codex/Pi）+
   有效 Cindy AI Gateway key，且 MCPRouter 侧部署的 bundle pin 与客户端一致 ⇒ 本会话不具备。
   客户端侧在位证据见 §2.4/§2.5（源码级顺序不变量 + 定向用例）。
2. **真实 migration 回放**（空库 `0..150` / 历史库升级到 `0150`）：**已由 `pnpm test:db` 覆盖并 PASS**
   （788 例 / 777 pass / 0 fail，db tier 含 `migrationReplay`，`PASS apps/desktop db (390.6s)`）；
   `db:validate` 另做结构与链校验（6/6）。`0139`→`0092` companion 触发器依赖由该 tier 的回放证明。
3. **Light / Dark 实机目检**：本轮 UI 改动面很大（面板域 + 侧栏 + 插件页 + 设置），**两种模式均未目检**
   （不得把「复用 themed 样式 / 未新增颜色」当成已验证）；`ui-smoke`/CDP 只覆盖功能与 DOM 断言。
4. **12 语界面实机目检**：`ui-smoke` 已逐语言横切并断言「无裸 key / Meka 页签与面板渲染」（12 语全部 PASS），
   但**未人工目检**字形/换行/截断；文言两版为现代底本占位。
5. **真机更新验收**（应用内更新、签名、发布渠道）：需真实签名与发布渠道，未执行。
6. **移动端冷更实机**：**门已获用户确认**（2026-11-12：本轮 mobile 全部复用上游、不做 Meka 分叉，见 §6.2 第 2 条），
   但**真机实跑未做** —— 本轮 merge **包含 `apps/mobile` 指纹输入变化**（`app.json`、`modules/**`
   的 Kotlin/Swift/gradle/podspec/expo-module.config.json、`plugins/**`，实测 **115 个路径**；
   `apps/mobile` 总改动 1551 文件），⇒ 新商店包/自建重装与存量装机热更影响**未实测**，
   合并前后指纹值也**未计算**。
7. **`demo:legacy-migration`**（旧身份只读迁移演示）：本轮未跑。
8. **`pnpm test:unit` 的剩余失败**：已跑完、**不是全绿** —— 原始 desktop tier 20 文件 / 80 例失败中，
   **12 文件已修复复跑**（`RemoteSkillsPage` **18/18** + 11 文件 **190/190**）、**8 文件为 Windows symlink EPERM**；
   mobile `mobileAndroidSimulator` **16/16** 已修复；maker-core `codex/index.test.ts` + `device-hosted-guest.test.ts`
   **1077/1077** 已修复、`cindySubagentRunner` **1 例 Windows OS inventory 超时（环境）**。
   **剩余仅：8 EPERM + 1 超时**，逐条见 **§4.6**（**不得写成 PASS**）。
9. **生成物的后续一次性动作**：三类生成物已重建并与 `--check`/哈希一致（§2.10/§5），但 **SBOM 的
   `created` 依赖合并提交**，合并落盘后需再跑一次 `licenses:generate`，否则会产出一行时间戳 diff。
10. **`forge.test.ts` / `ghostWorkdirGate.test.ts` / `plugin-market/service.test.ts` / `meka-runtime-mcp` /
    `piEnvironment`**：阻塞前提已消失（opencli exports+link、locale 收口），但**未单独复跑**（部分由
    `test:unit` 全量覆盖，以其结论为准）。

### 6.2 交付前置批准门（**三项均已获用户确认，2026-11-12**）

1. **插件基座白名单批准门 —— ✅ 已获用户批准（2026-11-12）**。本轮改动命中
   `docs/dev-rules/plugin-security-and-authoring.md` §5 点名的基座目录 ——
   `apps/desktop/src/main/cindy-brain/**`、`main/plugin-market/**`、`main/mcp-integrations/ghost.ts`、
   `src/shared/ghost.ts`、`src/preload/**`、`src/main/skillhub/installService.ts`、
   `renderer/features/plugin/**`、`renderer/cindy-brain/**`、`packages/plugin-protocol/**`。
   **存量插件兼容结论：无需重新安装、无需重新确认权限、无需重新配置**（实测
   `RECEIPT_SCHEMA_VERSION = 2` 未 bump、指纹 `cindy-ghost-content-v2` 未变、安装布局常量未变、
   两个 manifest 拒绝点变化都只作用于新声明路径）。批准时放行人已知悉两件事：
   ① **gh-cli 权限扩大**（上游删除「仅官方 `cindy-github`」拒绝面，改为按声明开放 + 更新确认补偿）；
   ② **Meka 新增 1 个拒绝点**（`panel.position:'tab'` 声明 `allowUserPresentationOverride` ⇒ 拒装，
   当前受影响插件 0 个）。**本项不再是推送阻塞项。**
2. **移动端冷更确认门 —— ✅ 已获用户确认（2026-11-12）**。用户原话：
   「**cindy/meka 没有主观动过任何 mobile 内容，所以全部接纳上游即可（复用上游的 mobile）**」。
   即：本轮 `apps/mobile` 的改动**全部来自上游**（含 `app.json`、`modules/**` 原生源码与
   gradle/podspec/expo-module.config.json、`plugins/**`，工作区实测 **115 个指纹输入路径**、
   `apps/mobile` 总改动 1551 文件），**不按 Meka 分叉处理、直接复用上游 mobile**；用户已知悉并接受
   「指纹输入变化 ⇒ 装新包才拿热更」的存量代价（拿不到本次及后续热更，直到装上新包）。
   ⚠️ **门已过，实机仍未跑**：真机冷更（新商店包 / 自建重装）与存量装机影响**未实测**，
   **合并前后指纹值未计算**（需干净 checkout + `ci-fingerprint`）—— 仍列 §6.1 未验证。
3. **协议确认门 —— ✅ 已获用户确认（2026-11-12）**：`packages/plugin-protocol` 接纳上游自身变更
   （`manifest.taskView`、`mainView.open|side|icon|multiple`、`readme`、namespace/usage 前序；+1937 行），
   `packages/device-link*` 与 `slack-hook-protocol` 亦为上游大改（自建 relay、LAN 直连、direct-first 等）。
   本仓 **未新增**任何 wire 字段（Meka 侧只有 `mcpr-plugin-capability.ts` 等 4 文件加性改动）。
   用户已确认本次协议变更；MCPRouter / plugin-server 的对应部署仍由发布流程协调。

### 6.3 待裁决 / 刻意偏离（本轮按接纳策略先行落地，列出回退点）

1. **面板旧链路整体退役**（§3）：Modal 保留为停靠宿主的替代呈现；独立窗口/气泡/布局树 pane 全部删除。
   回退点：恢复任一链路都要重写白名单条目 + 生命周期基线合规，属大改，不建议回退。
2. **`position:'right'` 不再归一化为 `left`**（跟上游）：声明 `right/top/bottom` 的旧包行为变化（真的落该边）。
   如要保留归一化，须登记 WL 例外（= 再分叉）。
3. **`panel.systemButtons` 退化为声明数据**：校验不变，但三类按钮不再有 UI（`maximize`/`detach`/`minimize`
   由页签组/弹窗/关页签承担）。作者文档已注明「当前不产生 UI」。
4. **`taskView` 对 Meka 渠道暂不开放**（协议接受、UI 不宣传）：开放属新增产品面，另立裁决。
5. **未读 completed 保留期取上游 24h**（原 Meka 4h）：锚点修好点保留；回退点是
   `terminalRetentionAt()` 让 `unreadIslandTtlAt` 优先（§2.7）。
6. **冷启动端点加载取上游可重试流程**（删除 Meka「失败即登出」早退）：WL-5.6 运行期版别语义不变（§2.7）。
7. **十二语翻译债**：de/es/fr/pt-BR/pt-PT 与文言为**占位**（英文/现代底本），需后续人工翻译；
   `check:i18n` 只把「与默认语相同」记为 warning，不阻断。
8. **内置智能通讯录退役**（`36a333ac18`）：按上游接受，由通讯录插件承接；Meka 侧无自有入口需迁移。
9. **`check:test-hygiene` 的本地基准口径**（已落地，留档）：直推集成分支继承上游基线文件会让「写死
   `origin/main`」的本地检查恒红 ⇒ 改为本地按当前分支 `origin/<branch>`、`--base` 可显式指定，
   CI 的 `pull_request.base.sha` / `merge_group.base_sha` / `push.before` 事件路径不变（规则已同步到
   `engineering-conventions.md` §3.2）。

### 6.4 存量缺口与观察项（**非本轮引入**，未擅自扩大范围）

1. `orcaInterAgentDispatcher.ts` 的 `workerSessionId` 只声明不读取（消费已由上游 `captureLocalWorkerReport`
   承担）—— 死字段，删除会连带改 `register.ts` 调用点。
2. `sessionsRestoreIfArchived.test.ts` 的 `ExpectedIdentity.workspaceKind` 联合不含 `'meka'`（第六轮已登记）。
3. `MekaDevInstallReview.tsx` 与 `features/plugin/lib/permissionItemIcon()` 的图标映射分叉（第五轮已登记）。
4. `docs/dev-rules/plugin-security-and-authoring.md` 里引用的 `errandPrefsStore.ts` 全仓不存在（存量文档失真）。
5. `scripts/meka-session-smoke.mjs` 仍硬编码战斗角色（第五轮登记「待改」）。
6. 三个上游段头（`PinnedSection` / `DialogueSection` / `bots/TeammatesSection`）仍各有一份内联 hover 规则副本，
   WL-3.3「两处不得各写一套」只覆盖主列表段头与 Meka 段头；收敛属跨包重构。
7. 三处未使用 import / `agentProcessPriority.test.ts:222` 注释仍写 `CindyGlobal` 等（第六轮 §6.4 登记，未变化）。
8. `orca-team-architecture.md`（`start_team.ts:45-53` 等）、`pi-harness.md`、`desktop-development.md`
   仍有若干存量**行号锚点**未改成符号名（治理组 §5 第 4 条：非本次 diff 引入，建议单开一轮
   「行号锚点转符号名」）。

> 已随本轮收口消失的一条：移动端 `src/debug/diagnosticUpload.ts` 与测试**已删除**（WL-26 移动端漏面已清，
> 见 WL-26 与 `log-upload-and-redaction.md` §4.1）；`git grep diagnosticUpload` 现在只应命中历史文档。

## 7. 白名单与批准门

- **本轮新增 Meka 白名单条目：无**（没有新增 Meka 专属能力；面板形态是既有 WL-1.5 的**收敛**）。
- **更新的白名单条目**：
  - **WL-1.5**（重写为最终形态）：docked = 上游右侧栏全局页签 `plugin-view(view:'panel')`、
    modal = Meka `GhostPanelModal`、`position:'tab'` 回上游 `GhostPagePanelHost`；删除「气泡/独立窗口/
    布局树不变」旧口径；保留三态优先级与 `allowUserPresentationOverride`；登记新拒绝点（`tab` + 该字段
    拒装）与旧 bubble 键只读迁移。
  - **WL-5.5**：`userInfoSectionHover.test.ts` 已被上游删除（`UD`），自动化门禁改指
    `userInfoSectionMobileDownload.test.tsx` / `userInfoSectionUpdateFlame.test.tsx`，并注明断言形态由
    源码扫描改为行为用例；同时把已随 WL-26 消失的「日志上报目标」消费面就地更正。
  - **WL-26**（**第二次收口**）：不启用上报；`performance-trace` 保留本地录制/保存/查看并**去上传**
    （`upload` / `artifacts` / `restore` / `traceRedactionWorker` 与 `restore-performance-report.ts` 删除、
    `reportId.ts` 改本地 ID）；`log-upload` 上报模块删除、本地采集/脱敏/「打开日志目录」保留
    （`types`/`limits` 只留采集形状与上限）；**移动端漏面已清**（`src/debug/diagnosticUpload.ts` + 测试已删，
    `git grep diagnosticUpload` 只应命中历史文档）；补 `check:test-hygiene`（当前 exit 0）与
    `performance-trace` 验证锚点 + 反回归搜索清单。
- **状态**：三个条目均已在清单中就地更新；**四个阶段的实际结论** = 阶段 A 未跑（§4.2）、阶段 B
  部分实跑（§4.1）、阶段 C 未跑（§4.2/§6.1）、阶段 D **不得宣告收敛**。
- **批准门状态（2026-11-12）**：**三项均已获用户确认** —— 插件基座白名单 Approve、移动端冷更
  （「全部接纳上游 mobile / 复用上游的 mobile」）、协议确认（§6.2）。**推送不再被批准门阻塞**；
  仍未完成的是 §4.2 / §6.1 的未跑项（`test:unit` 结论、真机冷更/更新实机、Light/Dark 与十二语人工目检）。
- **存量插件兼容红线核对结论：无 P0**（逐条实测见 §2.2 与 `_analysis/wp7-plugins-main-report.md` §4/§5）。
