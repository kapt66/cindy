# 第四轮上游同步：`origin/main` → `meka/main`（2026-09-25）

> 本轮把上游 `origin/main` 的最新提交语义合并进本仓 `meka/main`。
> 上一轮（2026-09-24）报告见 [`2026-09-24-origin-main-to-meka-main.md`](2026-09-24-origin-main-to-meka-main.md)；
> 迁移总账见 [`xdmaker-meka-to-cindy.md`](xdmaker-meka-to-cindy.md)。
> 接纳策略、波次与完成判定见 skill `cindy-meka-upstream-sync` 与
> [`meka-whitelist-verification.md`](../dev-rules/meka-whitelist-verification.md)。

## 1. 基线

| 项 | 值 |
| --- | --- |
| 本仓合并前 `HEAD`（产品线侧） | `08dd93c4e8af59134319d0fbdea4db43b82a4c9a` |
| 上游 `origin/main`（上游侧） | `fd73bc91fd3d2dabe680876f5271027630c68752` |
| merge-base | `2f169d6aeb4428ab57020cf925e10a3a80414391` |
| 上游独有提交数 | **214** |
| 本仓独有提交数 | 166 |
| 上游本轮改动规模 | 1554 文件、`+150405 / −19883` |
| 冲突路径 | **29**（26 `UU` + 3 `AA`） |

`merge-base` 恰好等于**上一轮同步的上游端点**，因此本轮只引入上游在这 214 个提交里的新增内容。

## 2. 冲突清单与分组

| 组 | 冲突路径 | 结论 |
| --- | --- | --- |
| 治理条款 | `AGENTS.md` | 见 §3.1 |
| 文档 | `docs/dev-rules/development-workflow.md`、`desktop-development.md`、`desktop-unit-test-performance.md`、`pi-harness.md`、`docs/design-rules/design-inventory.md` | 见 §3.2 |
| 测试调度脚本 | `scripts/test-workspaces.mjs`、`test-related.mjs`、`restart-desktop-remote.mjs`、`scripts/__tests__/{test-workspaces,test-related,restart-desktop-remote}.test.mjs` | 见 §3.3 |
| 插件（main） | `apps/desktop/src/main/plugin-market/{service.ts,registerIpc.ts}`、`mcp-integrations/__tests__/ghostWorkdirGate.test.ts` | 见 §3.4 |
| 插件（renderer） | `renderer/features/plugin/{GhostPluginPage.tsx,GhostPluginDetailView.tsx,MarketPluginDetailView.tsx,__tests__/MarketPluginDetailView.test.tsx}` | 见 §3.5 |
| maker-core | `packages/maker-core/src/agents/codex/index.ts` | 见 §3.6 |
| maker-host | `apps/desktop/src/main/maker-host/{index.ts,__tests__/piProviderTransport.test.ts}` | 见 §3.7 |
| main 其它 | `main/cindy-brain/index.ts`、`main/im/shared/sessionRepo.ts`、`main/maker-ipc/orcaInterAgentDispatcher.ts`、`main/session-share/sessionShareImport.ts` | 见 §3.8 |
| renderer 测试 | `renderer/features/cc-agent/__tests__/CreateWorkerPopover.test.tsx` | 见 §3.9 |
| 数据库谱系（D4） | `apps/desktop/drizzle/meta/{0115,0116,0117}_snapshot.json`（`AA`）+ 上游新增 5 条 migration | 见 §4 |

## 3. 逐组解决结论

（各能力组的「口径 + 证据 + 保留的不变量 + 定向取证结果」）

### 3.0 两道**机械化**双侧存活审计（本轮新增手段）

单看冲突清单会漏掉「自动合并成功但一侧内容被吃掉」的形态（上一轮就发生过）。因此本轮对
**126 个「双方都改过」的文件**做了两道独立的行级审计（脚本在 `_analysis/`，不提交）：

| 审计 | 判据 | 结果 | 定性 |
| --- | --- | --- | --- |
| **A：Meka 新增行存活** | 取 `git diff base..meka` 的 Meka 新增行（去空白后）逐行在合并结果里查找 | 124 个文件有非平凡新增行，**115 个全部存活**；9 个有「缺失」 | 9 个**逐条核实**后全部是**刻意的结构重实现**（见下），无未解释丢失 |
| **B：上游新增行存活** | 取 `git diff base..upstream` 的上游新增行逐行查找 | 125 个文件有非平凡新增行，**111 个全部存活**；14 个有「缺失」 | 14 个逐条核实后：8 类为**已登记偏离/D4 改号/生成物**，其余为等价重写，无未解释丢失 |

审计 A 的 9 处「缺失」逐条结论：
- `cindy-brain/index.ts`：`expectedPackageSha256` 与 dev 通道两个函数改用**多行 + consent** 形式，
  字段仍在（L7047/L7079/L7098）⇒ 等价重写。
- `orcaInterAgentDispatcher.ts`：`logEvent: string` 从多行签名合并成单行 ⇒ 格式。
- `ghostWorkdirGate.test.ts`：`makeDeps` 第 6 实参位次让位给上游新参数（见 §3.4）⇒ 刻意。
- `sessionShareImport.ts`：`workspaceKind === 'project'` 被上游**加宽**为
  `=== 'project' || runtimeScope.migration` ⇒ 上游加宽，Meka 分支仍在。
- `GhostPluginDetailView.tsx`（3 行）：`PERMISSION_ICON` 表被上游抽到 `lib/permissionItemIcon.ts`，
  Meka 的 `reveal` / `mcpr` 两个 kind 已迁入该模块 ⇒ 结构搬迁。
- `GhostPluginPage.tsx`（4 行）：Meka 复刻 Button 样式的长 className 与 `) : updatePending ? (` 分支
  被上游共享 `Button` 的 `min-w-[72px]` 取代 ⇒ **刻意的外观变化**（见 §3.5 的登记）。
- `desktop-development.md`：句子换行位置不同 ⇒ 审计的空白归一化误报。
- `codex/index.ts`（5 行）：Meka 的 revision/subagents host key 被**重实现**进上游统一的
  `localSessionHostIdentity` ⇒ 结构重实现（见 §3.6）。
- `__tests__/test-related.test.mjs`：Meka 的 `slice(0,4)` 精确顺序断言被改写为
  **更强**的偏序 + 存在性断言（旧断言在新口径下必然失败）⇒ 刻意。

审计 B 的 14 处「缺失」逐条结论（摘要）：`AGENTS.md` / `development-workflow.md` /
`desktop-unit-test-performance.md` = **已登记的刻意偏离**（保留 Meka 门禁口径，见 §3.1、§3.2）；
`drizzle/meta/0115..0117_snapshot.json` + `_journal.json` = **D4 改号**（上游原号内容已按 Meka 号
落到 `0118..0122`，§4）；`design-inventory.md` = **GENERATED 区**（已由 `pnpm design:inventory` 重生成）；
`claudeProviderBridge.test.ts` / `GhostPluginPage.tsx` / `ghostWorkdirGate.test.ts` /
`codex/index.ts` / `restart-desktop-remote.mjs` = **Meka 侧等价重实现或 Meka 口径保留**
（逐条用 `git show :2:` 对照后确认语义在），无未解释丢失。

### 3.1 `AGENTS.md`：保留 Meka 的提交前门禁口径（**刻意偏离上游**）

- 上游把「**提交前测试门禁（硬性要求）**」改写为「**提交前验证**」：默认选测、
  「已按影响面完成等效定向验证时，不要求为了 commit 重跑整仓测试」，并声明
  「仓库不强制多个 session 串行」。
- **本仓不采纳该放宽**：`meka/main` 是**直推集成分支**，其**唯一自动化门禁是 `client-ci` 的 push 触发**
  （见 `AGENTS.md`「Git 与交付」），没有 PR 阶段的 CI 兜底 ⇒ 推送前的本地门禁是唯一闸门；
  用户亦明确要求「仓库门禁在最终提交时统一执行」。
- 上游那句真正需要保留的是「**未执行项和原因须如实记录**」，本仓由
  `docs/dev-rules/development-workflow.md`「门禁时机」与本期报告的「未验证 + 原因」登记承担。
- 处理方式：在保留 Meka 原文的基础上**加注**「保留 Meka 口径（2026-09-25 第四轮上游同步）」说明块，
  写明上游原意、不采纳的理由与替代承担方式 —— 属**已登记的刻意偏离**，不是冲突残留。
- 同一口径也落到 `docs/dev-rules/development-workflow.md`（保留 Meka 门禁正文 + 采纳上游
  「如实记录结果」子条）与 `docs/dev-rules/desktop-unit-test-performance.md`（取 Meka 侧）。

### 3.2 文档组（4 个 dev-rules + design-inventory）

- `development-workflow.md`：保留 Meka「提交前测试门禁」正文；**采纳**上游新增的
  「**如实记录结果**」子条（并注明承担方）；未采纳上游 4 个**等价或更弱**的子条
  （「验证目标与本机执行方式分开」等，Meka 已有更严或等价正文，合并会自相矛盾）。
  **跨 worktree 测试锁改为上游的 opt-in（`--lock`）**：上游把
  `shouldUseTestGateLock` 改成 `if (!lock || noLock || CI) return false`，且 `package.json` 各
  `test:*` 脚本**都不传 `--lock`** ⇒ 重型 tier 默认不再跨 worktree 排队。该改动是**自动合并**
  （`scripts/test-gate-lock.mjs`、`test-workspaces.mjs` 非冲突文件），文档按「记录最终有效行为」
  改写成上游语义。**这不是门禁时机的放松**（门禁照跑），而是本机并发排队的默认值变化。
- `desktop-development.md`：双方合并 —— 保留 Meka 首段（账号命名、**常规开发不需要指定 `--region`**、
  Global 默认 + 登录页 override、沙箱与 checkout 无关）并采纳上游新增的 **Claude Code `~/.claude`
  非隔离**段（不设 `CLAUDE_CONFIG_DIR`、沿用本机订阅登录、旧 `<userData>/claude-home` 只补缺不覆盖）。
  **丢弃**上游的「并显式选择目标区域」与双行 `--region` 命令块：区域运行期可选是本仓**已登记例外**
  （`region-and-editions.md §1.2` 明写「上游同步时不得把区域收敛回『只由安装包决定』」）。
- `desktop-unit-test-performance.md`：取 Meka 侧（`meka/main` push 门禁、related 基准
  `origin/meka/main`、`db:validate` 基线）；上一轮新增的
  「**Windows 命令行长度预算与 tier 分块**」一节完整保留；非冲突部分自动并入上游新锁语义。
- `pi-harness.md`：两侧在同一锚点各自追加 ⇒ **取并集**；`§3.1「Pi 上游 GUI 非退化红线」`
  逐字未动，采纳的上游新条自带「不修改受管 Pi 二进制/版本/原生重试上限」⇒ **强化**红线而非弱化。
- `docs/design-rules/design-inventory.md`：冲突都在 **GENERATED 区**（不做语义判断），
  人工区双方合并（保留 4 条 `desktop.meka.*`、采纳上游 `mobile.companions.groups`、
  `mobile.automations` 随上游**退休该路由**同步消失 —— 工作区代码已确认是
  `LegacyAutomationsRedirect`，不是 Meka 登记被吞）；**GENERATED 区已由 `pnpm design:inventory` 重生成**
  （55 surface，`check:design-inventory` exit 0）。

### 3.3 测试调度脚本组（6 个文件）——含 **2 处静默断链修复**

- `scripts/test-workspaces.mjs`：**自动合并成功**。上游新增跨 worktree 锁的
  `--lock` / `--no-lock` 解析与 `lock` 透传、`--lock` 与 `--no-lock` 互斥校验；Meka 的
  `buildPnpmArgParts` / `commandLineLength` / `maxInlineCommandLength` / `planPnpmArgBatches` /
  `runPlannedTests`（Windows 命令行分块）**全部在位**（`git diff origin/main -- <path>` 只有新增行、
  没有被删掉的上游行）。定向 `node --test scripts/__tests__/test-workspaces.test.mjs` → **96/96**。
- `scripts/test-related.mjs`：**保留 Meka + 适配上游**。`GIT_BASE_REFS` 最终为
  `["origin/meka/main", "meka/main", refs/remotes/upstream/HEAD, upstream/main, upstream/master,
  refs/remotes/origin/HEAD, origin/main, origin/master, main, master]`：
  Meka 的**产品分支优先**（否则 related 门禁会把整个 Meka 产品增量当成「本次改动」并静默退回全量）
  与上游的 `upstream/*` 候选**共存**（`resolveGitBaseRef` 对每个 ref 逐条 try/catch，不存在的自然跳过）；
  保持 `export`（测试需要读取该常量，属可见性超集）。
- `scripts/restart-desktop-remote.mjs`：**跟随上游结构 + 保留 Meka 身份** —— 取上游的
  `devEnvEntries(env)` 抽取与 `darwinStaleDevEnvUnset()`（修「长驻 Terminal 残留 XDT_* env 串沙箱」），
  两边条目内容逐项一致故无 Meka 能力可失；`BRAND_USER_DATA_DIR_NAME = "CindyMeka"`、
  `looksLikeCindyManagedUserDataDir` 的 `CindyMeka|CindyMekaDev`、`resolveStartupReadyTimeoutMs` 均在。
- **静默断链 1（本轮修复）**：`scripts/__tests__/test-workspaces.test.mjs` 的冲突区外，
  双方在同一插入点追加测试块，git 把两块共用的收尾 `});` 判为共同上下文放到冲突区外
  ⇒ Meka 分块测试块**缺了自己的闭合 `});`**（语法错误）。已补回；Meka 的 9 条分块测试与
  上游新的 `--lock` CLI 测试**都在**。
- **静默断链 2（本轮修复）**：`scripts/__tests__/test-related.test.mjs` 里 Meka 的
  `GIT_BASE_REFS.slice(0,4) === ["origin/meka/main","meka/main","origin/main","main"]` 断言
  在合并后的顺序下**必然失败**（无冲突标记）。已改写为**更强**的偏序 + 存在性 + 兜底顺序断言。
- 定向实跑：`test-workspaces` **96/96**、`test-related` **20/20**、`restart-desktop-remote` **76/76**。

### 3.4 插件 main 组（3 个文件）——含 **1 处会导致 Meka 市场安装崩溃的静默断链**

- `plugin-market/service.ts`：完整接纳上游 `771c5cde3e` / #5088 的结构
  （**确认在 per-plugin mutation 之外求得**，锁移到 `installDetail` 的 `acquireMutation:true` 落位段），
  同时保留 Meka 的 `onProgress` 透传；`installDetail` 的 options 类型取上游
  `acquireMutation?` ∪ Meka `onProgress?`；上游删除的 options 默认值一并采纳（3 个调用点都显式传参）。
- `plugin-market/registerIpc.ts`：import 取并集。
  **静默断链（本轮修复）**：上游把 `install()` 第三参从可选 `assertCurrent` 改成**必填**
  `PluginMarketInstallContext`，而 Meka 的 `meka-plugin-market:install` 仍只传 2 个实参 ⇒
  `install()` 首行 `const { assertCurrent } = context;` 会抛
  `TypeError: Cannot destructure property 'assertCurrent' of 'context'` ⇒
  **Meka 市场页每一次安装/更新都会直接崩**（TS 也会报错）。已补
  `{ consent: { prompt: createWindowGhostInstallConsentPrompt(sender), initiator: 'user' } }`，
  并保留 Meka 的 `operationId` 进度、`expectedInstalledApproval` / `expectedManifest` /
  `allowSourceReplacement` 透传（`plugin-security-and-authoring.md §4.2` 的「Meka 安装包装层只能
  追加 operationId、必须完整保留调用方事务 options」仍然成立）。
- `mcp-integrations/__tests__/ghostWorkdirGate.test.ts`：Meka 把 `workingDir` 插在第 5 位、
  上游把 `pluginMarket`/`requestHostPermission` 追加在后 ⇒ 唯一那处 ≥5 实参的调用点
  必须整体右移一位（否则 `deps.installMarket` 不存在、整组 market 用例静默失效）。已修。
- 定向实跑：`ghostWorkdirGate.test.ts` **179/179**；`plugin-market/__tests__` 7 文件 **318 passed / 2 skipped**；
  同目录 ghost/meka 4 文件 **76 passed**；`cindy-brain` 基座 2 文件 **99 passed / 2 skipped**。
- **下载上限不变量**：`git log -S` 与 `numstat` 均显示上游本批**未触碰**
  `MAX_BASIC_CINDY_FILE_BYTES` / `PLUGIN_MEMBER_UPLOAD_MAX_ARCHIVE_BYTES` / `resolveMaxDownloadBytes`；
  Meka 的 8 MiB / 128 MiB 与「`mekaDownloadPolicy` 恒返回 `number`」完好
  （`mekaDownloadPolicy.test.ts` 3/3）。

### 3.5 插件 renderer 组（4 个文件 + 1 个连带文件）——含 **1 处已登记红线拒收**

- `MarketPluginDetailView.tsx`：采纳上游「去掉 `!busy &&` 门、子节点常驻」的结构，
  在**上游新结构上重新实现** Meka 的进度分支（`loading={busy && !progress}`、
  `aria-label` 在 progress 分支不写死、进度内容做子节点）。
- `GhostPluginPage.tsx`：3 处冲突 + 1 处**冲突区外的静默断链**。
  - 采纳上游新增的 `updateNeedsConsent` 分支（Meka 规则**要求**标出「需确认新权限」）；
  - **拒收上游的 `upToDate`「已是最新」分支** —— 依据 `plugin-security-and-authoring.md:192-202`
    （「投影信息不足时客户端不得断言『已是最新』；该文案连同 i18n 键 `settings.ghosts.page.upToDate`
    已一并删除，**不得重新引入**」，门禁 `GhostPluginCard.test.tsx` 头部钉住）。这是本组**唯一**拒收上游的点。
  - **静默断链（本轮修复）**：上游自动合入的 `loading={updatePending}` 与 Meka 的
    `{updatePending ? <Spinner/> : …}` 叠加会变成「双 Spinner + 进度文案被 `opacity-0` 吃掉」；
    已改为 `loading={updatePending && !updateProgress}`（与详情页 CTA 同口径）。
- `GhostPluginDetailView.tsx`：完全接受上游把 `PERMISSION_ICON` 抽到 `lib/permissionItemIcon.ts`
  （删本地表 + 5 个只服务该表的图标导入），Meka 头部进度 CTA 未受影响。
- `lib/permissionItemIcon.ts`（上游新增、**不在原冲突清单**）：上游抽取时缺 Meka 的 `reveal` / `mcpr`
  两个 kind，而 `Record<GhostPermissionItem['kind'], LucideIcon>` 要求穷尽 ⇒ **必然 TS 报错**。
  已按 Meka 原映射补齐（并做逐键比对 missing=[] extra=[]）。
- `MarketPluginDetailView.test.tsx`：Meka 的两态用例（7 条）零丢失，叠加上游 4 条结构断言 = 超集。
- **登记的产品差异/风险**：
  1. 唯一拒收上游项 = `upToDate`（有明确红线依据，见上）；
  2. **外观变化**：更新胶囊从 Meka 复刻的 `text-11/px-2.5` 改为上游共享 `Button` 的
     `min-w-[72px]`（字号 13）—— 属「跟随上游共享组件重构」，需视觉目检确认（视觉目检本就是
     本清单登记的「未验证」项之一）；
  3. 存量缺陷（**非本轮引入**，见 §5「登记项」）：`GhostPluginPage.tsx:2924`
     `aria-busy={updatePending || updateProgress !== null || undefined}` —— `updateProgress` 类型是
     `T | null | undefined`，未传时 `undefined !== null` 为真 ⇒ **空闲态也报 `aria-busy="true"`**。
- 定向实跑：`MarketPluginDetailView.test.tsx` **7/7**；同组 3 文件 **84/84**；再 6 文件 **28/28**。

### 3.6 maker-core codex 组（1 个文件，6 处冲突）

- **C1/C2（位置实参）**：`createHost` 调用点与形参取**两边全保留** —— 14 项实参顺序为
  `…historyHome, localAuthPolicy(上游), routeIsCurrent(上游), codexNativeSubagentsDisabled(Meka)`。
  实参清单里的顺序即形参顺序，已按形参逐个对齐（`tsc --noEmit` exit 0 佐证）。
  **Meka 原生子代理硬关链路完整**：`getHost` opts → `createHost` 实参 → 形参 →
  `prepareCodexExtraSpawnConfig` ctx → maker-host 的 `&& !disableNativeSubagents` 与
  `['-c','agents.enabled=false']`。
- **C3**：取上游的 `let routeSelection/requestedCredentialMode/localAuthPolicy/credentialMode`
  结构（route 重选要重算），只把**远端**（`mcpr:`）分支换回 Meka 的
  `resolveRemoteCodexCredentialMode` —— 远端凭证模式由 host 拥有，不能被钉成 `undefined`。
- **C4**：上游 `localAuthPolicy`/`credentialMode` 与 Meka 的 `nativeSkillRevision`/`isolatedLocalHost`
  全保留。
- **C5（**结构性重实现**）**：上游删除了 Meka 的 `baseSessionHostKey` 并把 host key 计算收敛到统一的
  `localSessionHostIdentity`（同时服务初始创建 / route 重选 / writer handoff）。Meka 的
  revision 级隔离与 subagents 硬关**重实现**为该函数的两个**新增可选输入**
  （`nativeSkillRevision?` / `nativeSubagentsDisabled?`），后备顺序与 Meka 原实现逐字一致；
  `keyOverride`、hostPurpose 分支、以及「single-session teardown 不回收该 host」均保留。
- **C6**：取上游签名 + `preserveExternalAuth` 主体，初始 key 集合补回
  `localSubagentsDisabledHostKey()`，并保留两条 Meka 前缀过滤。
- **Pi 非退化自查**：本轮上游**没有**收紧 argv/prompt 长度或内容守卫（唯一的尺寸逻辑是**反应式**的
  HTTP 413 恢复）；`assertPiSpawnArgvFitsPlatform` 三阶段一致；Meka 的
  `Method.SkillsExtraRootsSet`（`skills/extraRoots/set`）是 Meka 独有且 `app-server/protocol.ts`
  本轮未改 ⇒ **文件载体方案仍成立**；未新增任何审批/指纹/静态分析门。
- 定向实跑：`codex/index.test.ts` **929/929**；`src/agents/codex` + `maker.shutdown.test.ts`
  **1386 passed / 15 skipped**；`src/agents/pi` **1269 passed / 25 skipped**；`maker.test.ts` **119/119**；
  `tsc --noEmit` **exit 0**；护栏 `mekaRuntimeInjection{Baseline,}` **82/82**。

### 3.7 maker-host 组（2 个文件）

- `maker-host/index.ts`：冲突 A（import 成员表）两边都留（`AgentDeps` 与 `InteractionRequest`
  在合并后正文里**都仍被引用**）；冲突 B（const 插入点）两边都留且**正交**
  （Meka 的 `codexSubagentSpawnArgs` 供 `extraArgs`、上游的 `releaseScopedCapabilities` 供
  `onHostRetired`）。
- `piProviderTransport.test.ts`：provider import 取上游新增两符号 + 保留 Meka 的
  `listenOnFetchSafePort` 行；**Meka 的 Windows flake 修复未被静默还原**
  （上游该处仍是 base 的 `once` 写法，合并取了 Meka 版）。顶层 `it` 数 base 7 → Meka 7 → 上游 9 → 合并 **9**。
- 自动合并审计：maker-host 下 7 个双方都改的文件双向行级核验 missing=0；
  **`model-visibility-mirror.ts` 双方都没动**（四处 blob 一致、上游零提交）⇒ WL-10 的
  「未知 key 不加 `fallback: false`」语义在本轮**结构上不可能被静默断开**。
- 定向实跑：`piProviderTransport` **36/36**、`codex-subagent-config` **3/3**、
  `codexCustomProviderRoute` + `codexProxyHost` **291/291**。

### 3.8 main 其它组（4 个文件）

- `maker-ipc/orcaInterAgentDispatcher.ts`：**实现上游全部改动 + 保留 Meka 唯一承重行**。
  上游新增 `resolveWorkerSessionLink` dep、rollback 带 `reason`、`resolveOrigin` / `senderSessionId`、
  `resolveOrcaSenderSessionId`、`buildQueuedOrcaInterAgentMessage` 改 `origin` 入参 —— 全部采纳；
  Meka 侧的 `workerSessionId?: string`（`:54-55`）**必须保留**：它是**承重行**，
  `main/maker-ipc/register.ts:2304-2313` 的战斗报告自动桥接据此判定
  （`params.source==='worker' && meta.source==='mcp-tool' && workerId && workerSessionId && /serverCapabilityReport|supportStatus/`），
  命中后 `:2315-2340` 包 `onAccepted` / `onAcceptedRollback` 调
  `recordCombatServerCapabilityAutoBridge` / `rollbackCombatServerCapabilityAutoBridge`。
  字面照抄上游会 `TS2339`（typecheck 不可能 exit 0）且**战斗报告信任登记静默失效**。
  ⇒ **更正**：本节初稿曾写「完全采用上游 / Meka 在该文件的改动为 0 行」，该措辞**不准确**（已由独立审查指出并据此更正）；
  正确表述是「上游全部改动 + 保留 1 行 Meka 语义」。§3.0 审计 A 的缺失清单亦据此补齐（除 `logEvent` 折行属格式外，
  还包含 `workerSessionId` 这一处唯一语义行）。
- `cindy-brain/index.ts`：冲突区取上游逐字（两处：`deleteGhostLibraryForActiveOwner` 加
  `slot.setRelocating` + try/finally；`expectedPackageSha256` 去掉真值判断 —— 调用方 opts 里该字段本就是
  必填 `string`，旧写法是死代码）；**但该文件另有一处 Meka 独有的静默断链已在本轮修复**，见下。
- `im/shared/sessionRepo.ts`：取上游新增的 `defaultRouteFingerprint` + **保留 Meka 的 `'meka'`
  workspaceKind**（两边各自新增；缺任一侧会导致 `readWorkspaceKind` 返回类型不可赋值）。
- `session-share/sessionShareImport.ts`：上游 migration 交接 + Meka `mekaBinding` **两边都保留**
  （`resolveShareMekaBinding` / `applySharedMekaBinding` / `mekaBindingRestored` /
  `mekaBindingFailed` / `!mekaBound` 降级路径均在；上游把条件加宽为
  `workspaceKind === 'project' || runtimeScope.migration`）。
- **静默断链（本轮修复）**：`cindy-brain/index.ts` 的 Meka **开发目录插件通道**
  （`installDevelopmentPackage` / `updateDevelopmentPackage`，base 与上游都没有这两个函数）
  调用 `installAndDock` 时**缺上游新必填的 `consent`** ⇒ typecheck 两处报错。已按与市场渠道
  **同口径**补齐：用户发起走 `{ mode:'prompt', prompt: createWindowGhostInstallConsentPrompt(sender),
  initiator:'user', origin:'local-file' }`；目录监听的后台 `sync` 走 `{ mode:'automatic' }`
  （需要确认时抛 `GhostInstallConsentRequiredError`，**fail-closed**，旧版本继续可用、不弹窗打断用户）。
- 定向实跑：orca **19**、`sessionShareImport` **70**、im sessionRepo/channelDefaultRoute **90**、
  cindy-brain librarySlot+GhostManager+marketGhostSessionBoundary **317**、slashCommands **34**、
  agent-input-coordinator+makerSendTransaction **564**、share export/format **58**。

### 3.9 renderer 测试组（`CreateWorkerPopover.test.tsx`）——含 **对上一轮的跨轮审计发现**

- 冲突形态是 **delete-vs-modify**：HEAD 侧整段为空（上一轮把 Meka 侧整份文件当冲突解），
  theirs 侧 132 行（上游既有 6 个用例 + 本轮新增的「点遮罩保留草稿」用例）。
- **跨轮审计发现**：`git log -m -S` 指向上一轮的合并提交 `1d42753a22` ——
  即**上一轮同步曾静默删掉上游的 6 个用例**（roleLabel / device-link 无 permission-mode /
  Full access 默认 / prefs 记忆 / 旧 peer 阻断 / 取消确认）**以及冲突区外第一个用例里的 4 行断言**，
  而上一轮报告只声明「改用 `pick-codex-config`、保留 Meka 语义断言」，**从未声明要删除这些用例**
  ⇒ 判为静默丢失而非产品裁决。本轮已**按上游原文恢复**（含冲突区外那 4 行），
  并保留 Meka 的 3 项独有内容（`Session` 类型导入、`mekaSettings` mock、MCPRouter/Codex 用例）。
- 关联：`c0ba10a195`「阻止点击对话框遮罩误关闭 (#5104)」使该弹窗**点遮罩不再关闭**
  （符合 `DESIGN.md`「Closing affordance」2026-09-24 更新），属**接受的上游行为变化**。
- 同能力组自动合并文件行数核对：`CreateWorkerPopover.tsx` 851/954/851/**954**、
  `OrcaWorkerPanel.tsx` 206/231/206/**231**、`CCAgentSessionView.tsx` 6299/6310/6316/**6327**、
  `NewMakerDraftRoute.tsx` 5528/6077/5532/**6081**、`SessionBranchTreeDialog.tsx` 286/286/287/**287**
  ⇒ 全部 = ours + 上游增量，无整段回退。
- 定向实跑：**45/45**。

## 4. 数据库谱系（D4 顺移追加）

上游本轮新增 5 条 migration，按其原号 `0115..0119` 命名；本仓 Meka 谱系已占用
`0000..0117`（其中 `0113..0117` 是上一轮把上游 `0110..0114` 顺移追加的结果）。
按「**已发布 Meka 编号冻结、上游顺移追加**」的 append-only 不变量，本轮把这 5 条追加为
Meka `0118..0122`：

| 上游原号 | Meka 现号 |
| --- | --- |
| `0115_silky_power_man.sql` | `0118_silky_power_man.sql` |
| `0116_last_the_watchers.sql` | `0119_last_the_watchers.sql` |
| `0117_spicy_valkyrie.sql` | `0120_spicy_valkyrie.sql` |
| `0118_cynical_thunderball.sql` | `0121_cynical_thunderball.sql` |
| `0119_hard_vindicator.sql` | `0122_hard_vindicator.sql` |

- **SQL 正文**：逐字节取上游（改名不改内容）。
- **snapshot**：`meta/0118..0122_snapshot.json` = **上游同序号 snapshot + Meka delta**。
  Meka delta 不是硬编码，而是每次从 `:2:0117_snapshot.json` 与上游 `0114_snapshot.json` 的差集**推导**：
  多出 `meka_projects`、`meka_roles` 两张表，`sessions` 多 10 列
  （`meka_role`、`meka_target_json`、`meka_project_id`、`meka_role_id`、`is_formal`、`formal_type`、
  `formal_link`、`formal_ref`、`formal_content_json`、`capability_snapshot_json`）、
  2 个索引（`idx_sessions_meka_project_id`、`idx_sessions_meka_role_id`）、
  1 个外键（`sessions_meka_role_id_meka_roles_id_fk`）。
- **snapshot 链**：`prevId` 重连为 Meka 自身链路（`0117.id → 0118.id → … → 0122.id`），
  不再引用上游编号对应的 id。
- **journal**：`meta/_journal.json` **自动合并后出现重复 idx 115/116/117**（Meka 与上游各一套）
  —— 无冲突标记但结构已坏；已丢掉上游原号那 5 条、追加 `118..122`（`when` 取上游值，尾部单调）。
- **AA 冲突**：`meta/0115|0116|0117_snapshot.json` 三个路径两侧都新增 ⇒ 取 **Meka 侧**（本仓顺移后的快照），
  上游同名内容改为 `0118..0120`。

**实跑验证**：

```
pnpm --filter desktop db:validate
[db:validate] step 1/6 ok — 123 sql file(s), seq 0000..0122
[db:validate] step 2/6 ok — _journal.json entries 与 sql 文件、snapshot 全部对齐，snapshot 链 id/prevId 连续
[db:validate] step 3/6 ok — drizzle-kit check 通过（无 schema drift）
[db:validate] step 4/6 ok — 123 snapshot file(s) 与 journal entries 数量一致
[db:validate] step 5/6 ok — 44 个配套迁移脚本均为 CommonJS
[db:validate] step 6/6 ok — 固定 SHA256 基线冻结 80 条 migration SQL + 23 条 runtime script，
                     canonical 基线冻结 118 条 SQL + 44 条 runtime script
✅ migration validation passed（exit 0）

pnpm --filter desktop exec drizzle-kit generate
No schema changes, nothing to migrate 😴（exit 0）
```

`canonical 基线` 的 118 条来自**固定的 Git 基线提交**（`validate-migrations.mjs` 从 canonical ref 读），
属「已进入产品分支/发版的 migration 不可增删改」的冻结检查；本轮的 `0118..0122` 是**新增追加**，
不在该冻结范围内，符合 append-only 不变量。

## 5. 审查—修复—再审查：本轮超出「冲突解决」范围的修复与登记

冲突解决完成后，按用户要求做了**独立对抗性审查**（5 个审查者按能力面分工，默认「这里一定有问题」），
外加两道机械化双侧存活审计（§3.0）。审查发现的**本轮引入**问题一律在本次交付内修复；
**存量**问题按 `AGENTS.md`「审查与问题范围」报告后由用户裁决。

### 5.1 本轮引入 → 本次交付内修复

| # | 问题 | 定性 | 修法 |
| --- | --- | --- | --- |
| 1 | **Meka 开发目录插件「用户发起安装」必然失败**（P0）：确认算在**源码包**身份上、落位前 `assertGhostInstallConsent` 却用**派生包**身份复核 ⇒ `ghostId` 与 `packageSha256` 两个字段都不等，稳定抛 `PRECONDITION_FAILED / 插件内容在确认后发生了变化` ⇒ 首装永远装不上、扩权更新永远失败；且 `meka-dev-plugins:install` **零测试覆盖**（`mekaDevPlugins.test.ts` 的 `installPackage` mock 只有 1 个形参） | 上游新增强制确认门 × 本轮为 Meka 通道接线 | 把 `MekaDevPluginInstallAuthorization` 从「预先算好的 decision」改成**策略**（与 `GhostInstallConsentPolicy` 同形），让确认在**派生包 inspection** 上求得 ⇒ 确认与落位复核同一份身份；IPC 层 `expectedPackageSha256`（源码内容指纹）与 dataOwner/generation 校验保持不动；`install()` 缺省值仍为后台口径 **fail-closed**。补 4 类回归测试（首装成功 / 扩权需确认 / 未扩权不弹窗 / 后台 sync fail-closed） |
| 2 | **Meka 市场页每次安装/更新都会崩**：上游把 `install()` 第三参从可选 `assertCurrent` 改成**必填** `PluginMarketInstallContext`，而 Meka 的 `meka-plugin-market:install` 仍只传 2 个实参 ⇒ `TypeError: Cannot destructure property 'assertCurrent' of 'context'` | 上游改语义、Meka 调用点前提被静默覆盖（无冲突标记） | 补齐第三参 `{ consent: { prompt: createWindowGhostInstallConsentPrompt(sender), initiator: 'user' } }`，并保留 operationId 进度与 `expectedInstalledApproval` / `expectedManifest` / `allowSourceReplacement` 透传 |
| 3 | **Meka 开发目录通道缺上游新必填的 `consent`**（`cindy-brain/index.ts` 两处 typecheck 报错；该通道是 base/上游都没有的 Meka 独有代码） | 同上 | 用户发起走 `prompt` + `initiator:'user'` + `origin:'local-file'`；目录监听后台 `sync` 走 `automatic`（需要确认时抛 `GhostInstallConsentRequiredError`，**fail-closed**、不弹窗、旧版本继续可用） |
| 4 | **Meka「任务迁移 / 复制任务」链路对 Meka 零适配**（上游本轮新增 `task-migration/` 11 文件）：`assertSource()` 不含 `workspace_kind` 判定 ⇒ Meka 任务准入；源侧按成员 `workingDir` 整包快照，而**内置 Meka 项目的工作目录就是 P4 根** ⇒ 「复制任务」= 归档整个 Perforce 工作区；目标侧 `mekaBound` 优先于交接目录 ⇒ 副本成孤儿；缺项目/角色时 `result.notes` 被 `view()` 丢弃 ⇒ **绑定丢失完全静默** | 上游新能力 × Meka 第三态 `workspace_kind='meka'` | 本轮**不向 Meka 会话提供该能力**：main 侧权威入口拒绝 `workspace_kind='meka'` 并返回可展示错误；renderer 对 Meka 会话不渲染复制入口。理由：Meka 迁移不是设计中的功能，而现有链路会 ① 触发几十 GB 的不该发生的传输 ② 静默丢项目/角色绑定 —— 宁可不提供 |
| 5 | **`.github/workflows/**` 不再触发全量单测回退**：上游把 `scripts/test-related.mjs` 的 `isWideFile` 收窄并把对应测试期望**反转**为 `false` | 上游有意重构（非静默丢失），但与 Meka 口径冲突 | **刻意保留 Meka 口径**：恢复 `.github/workflows/**` 为 wide（`scripts/test-related.mjs`），并把被反转的两处测试期望改回、写明理由。依据：`meka/main` 是直推分支、**唯一自动化门禁是 `ci.yml` 的 push 触发**，故 AGENTS.md「改到…单测 CI 时会自动退回全量」必须继续成立。上游新增的「包级 package.json / 包级 vitest.config ⇒ 整包全跑」`fullWorkspaces` 逻辑**原样保留** |
| 6 | **本轮新增文案写死上游品牌名**（桌面 7 key × 5 语 + 移动 1 key × 5 语 + `updateService.ts` 的 macOS 引导文案 + `lizi-mcps/app_update.ts` 三条 errorPayload），且两道品牌门禁都拦不住（`brand-terminology-guard` 只拒**旧**上游名 `XDMaker` 等；`i18nBrandPlaceholder.test.ts` 只断言固定 key 列表） | 本轮引入（新实例）；类别与门禁缺口是存量 | 按「指应用/产品自身 ⇒ 用 `{{appName}}` / `BRAND_NAME`」改写 40 处 locale + 4 处代码；**两个 market key 判定不改**（五语一致指**上游 Cindy 服务端** / **Cindy 插件清单契约**，改名即事实错误 —— 已逐语核实，且其 Cindy 子句在本轮之前逐字已存在，本轮只是同句追加了确认句才变成 `+` 行）。门禁侧把**实际修掉的 7 个桌面 key** 纳入 `i18nBrandPlaceholder.test.ts` |
| 7 | **Meka 的 codex 原生子代理硬关在主路径与远端均失效**（用户已裁决「两处都修」） | **存量**（非本轮引入，见 §5.2） | 见 §5.2 第 1 项 |
| 8 | `docs/legal/notices/**` 未随本轮新增生产依赖（`dotenv@^16.6.1`、`json5@^2.2.3`）重生成（上游自己也没重生成，无 CI 门禁） | 继承自上游的漂移，但本仓 README / 上一轮惯例要求在依赖变更后重生成 | 实跑 `pnpm licenses:generate`（exit 0），生成物只含预期新增 |
| 9 | `docs/dev-rules/database-and-migrations.md:51-62` 的「编号现状」仍是**第三轮**口径（写 `0113`–`0117`、108/43 条、且称「本轮未实跑 db:validate」） | 文档同步缺口（本轮 D4 改号后未同步） | 更新为第四轮口径：已发布 `0000`–`0117`、本轮追加 `0118`–`0122`、`db:validate` 实测**固定基线 80+23 / canonical 118+44** |

### 5.2 登记项（**存量 / 未验证**，按 `AGENTS.md` 报告后待裁决或待真机）

**A. 已在本次修复（用户裁决「两处都修」）——codex 原生子代理硬关**

Meka 通过 `vendorOptions.codexNativeSubagentsDisabled === true` 要求 Host 硬关 codex 原生子代理，
契约见 `maker-core-and-agent-behavior.md:478-482` 与 `meka-skills.md:872-877`（后者明确要求
「thread 的新建、恢复和 profile 切换也重申同一配置，**以覆盖 MCPR 远端 Worker**」）。
独立审查用真实 `createHost` 路径**实测**出两处**存量**缺陷（本轮原样保留）：
- **主路径静默失效**：`codex/index.ts` 的 hostPurpose 三元组（约 `:5077-5091`）把该 flag
  **只挂在最后一个分支**；`usesCustomContextHost` 为真时走 custom-context 分支 ⇒ flag 不进 ctx。
  实测 Desktop 钩子收到的 ctx 为
  `{ remoteHostId: undefined, credentialMode: 'provider-oauth', hostPurpose: 'custom-context',
     customContextModel: …, customContextWindow: 700000, customContextHostKey: … }`（**无该 flag**）
  ⇒ `maker-host/index.ts:1748` 的 `disableNativeSubagents === false` ⇒ 既不追加
  `['-c','agents.enabled=false']`（`:1962-1964`）、智能调配门（`:1893-1899`）也是开的。
  而 Desktop **恒提供** `resolveCodexThreadContextWindow`（`:1646-1652`），只要 provider 在目录里且该
  codex 模型有 `contextWindow > 0` 就返回正数 ⇒ **本地 codex 会话（含战斗会话）绝大多数走这条分支**。
  既有唯一 Meka 用例（`index.test.ts:5179-5211`）用的是**没有**该 resolver 的 deps，恰好只覆盖不走
  custom-context 的形状 —— 这正是缺陷能长期存活的原因。
- **远端整条链路缺失**：`codex/index.ts:5057` 对 `opts.remoteHostId` 早返回且不把 opts 传给 `getHost`；
  `maker-host/index.ts:1728-1745` 对 remote 也早返回。历史上 Meka 曾用「thread config 重申」覆盖远端
  （`2fa5f3e4ee` 在 `currentThreadWorkspaceConfig().config` 里写 `{ 'agents.enabled': false }`），
  该行在 `7eb9757ea6`（08-24 合并）被弄丢、`0ee88f5aa5` 只恢复了 host key 与 ctx 透传。
- **附带更正**：白名单 `meka-whitelist-verification.md:2451-2454` 曾断言「远端只读 worker 的硬禁用仍在
  链路里 … `maker-host/index.ts:1618` 读取」——该行在 remote early-return **之后**，对远端 worker
  **不成立**；已随本次修改一并更正。
- **验证**：修复 + 回归测试（maker-core 侧断言 flag 进入 ctx 与 thread config；desktop 侧已先由另一
  修复组钉住「钩子给定 flag ⇒ argv 有 `-c agents.enabled=false` 且智能调配被关」一跳，
  `codexNativeSubagentsDisabled.test.ts` 6/6）。**真机仍待取证**（见 §6 的未验证项）。

**B. 存量缺口（不修，仅登记；其中三项已用「known gap 断言」锁死现值）**

1. **`scripts/dev-embed-search.mjs:138` 的 `DB_FILE_PREFIX = 'cindy'`** 未跟身份正本
   （正本 `brandIdentity.ts` 的 `dbFilePrefix = 'cindy-meka'`）⇒ 该 dev 工具的 `--user-id` 分支
   **定位不到数据库**（glob 分支因字符类宽松侥幸命中）。存量（三侧同 blob）。
   已在 `brand-identity-sync.test.mjs` 用 **known gap 断言**锁死现值：缺口未修时保持绿，
   **一旦被改动（修好或再次漂移）立刻变红**，并在断言旁指向本条登记与 `2026-09-24` §6.17。
2. **Linux 用户级安装链路的身份不一致**（`forge-linux.ts:14` 的 build-info executable、
   `install-user.sh:69/:104/:110`、`install-omarchy.sh:61/:69/:194`）—— 上一轮已登记未修；
   **本轮新增证据**：`install-omarchy.sh:27-28` 还硬编码**上游渠道根** `https://hotfix.cindy.app/cindy`
   与 `https://hotfix.cindy.com.cn/cindy`（不是 Meka 的 `/cindy-meka`）；
   `docs/linux.md:64/70/194/249` 公开的正是上游 `/cindy` 引导与 `PREFIX/current/Cindy`；
   `updateScriptLinux.ts:1` 把 `install-user.sh?raw` **内嵌进运行时更新脚本**。
   ⇒ **修复时必须一并处理渠道根与公开文档**，否则改名后仍会拉到上游包。同样已用 known gap 断言锁死。
3. **`brand-identity-sync.test.mjs` 的镜像覆盖缺口**：本轮把 5 个镜像点扩到 **10 个**
   （新增 `installer.nsh`、`forge-third-party-notices.ts` 两个**正本**断言 +
   `dev-embed-search.mjs`、`forge-linux.ts`、两个 linux 安装脚本共三个 **known gap** 断言）。
   仍未覆盖（登记）：`scripts/meka-{ui,session}-smoke.mjs` 的 `'CindyMeka'` 字面量、
   `restart-desktop-remote.mjs:633` 的 legacy 闭集正则本体、`browser-managed-config.ts` 的
   `MANAGED_PROFILE='Cindy'`（`branding.ts:11` 已声明「翻转时定格」，属**有意**）、
   `installer.rs` 的 Rust 自带 fixture、`voice-input-benchmark.mjs:635` 的 `app.setName('Cindy')`。
3.1 **known gap 断言的语义**（务必按此理解）：它断言的是**当前实际值**而非正本值 ⇒
   「缺口存在时恒绿」；它的价值是**在缺口被改动时立刻变红**，**不等于「该缺口已验收通过」**。
4. **移动端 locale 没有任何硬编码品牌门禁**：`check:i18n` 只扫 desktop locales，
   `brand-terminology-guard.mjs` 的 `LOCALE_FILE_RE` 只匹配
   `apps/desktop/src/renderer/i18n/locales/<locale>/common.json`（连 desktop 的其它 namespace 都不覆盖）。
   本轮修掉的 mobile `hostNotReady` **无门禁守护**，同类漂移下一轮仍会静默通过。
5. **`settings.ghosts.market.securityDescription` 的 en↔CJK 语义分叉**（存量）：en 第一分句主语是
   应用（“Cindy verifies package size and SHA-256 in the main process”），而 zh/zh-TW/ja/ko 的 Cindy
   限定「**插件清单**」（指上游 Cindy 插件生态的清单契约，属 `brandIdentity.ts` 明示「永久不随身份配置
   变化」的标识符层）。统一替换成 `{{appName}}` 会让另四语变成事实错误；正确做法是**重写 en 源句**。
6. **图标映射分叉**（存量）：`renderer/features/plugin/lib/permissionItemIcon.ts` 的注释自称与
   `MekaDevInstallReview.tsx` 的 `KIND_ICON` 一致，实测 `main-view`（AppWindow vs PanelLeft）、
   `subscribe`（Radio vs Bell）以及 `badge` / `nodeSecret` / `networkSecretOrganizationIdentity`
   三个 labelKey 分支**都不同** ⇒ 同一权限在开发确认框与新安装确认框/详情页显示不同图标。
   建议让 `MekaDevInstallReview` 复用共享 helper（把 Meka 特例并入）。
7. **进度分支的 `aria-label` 口径分叉**（存量）：`GhostPluginDetailView.tsx:269-291` 显示
   `updateProgress` 时 `aria-label`（`:273-277`）**无条件**写死「更新到 vX」，会覆盖进度子节点文本；
   另两处（`MarketPluginDetailView.tsx:103`、`GhostPluginPage.tsx:2925`）都是
   `progress ? undefined : …`，而 `MarketPluginDetailView.test.tsx:184` 的注释还写着「两处不得分叉」。
8. **`GhostPluginPage.tsx:2924` 空闲态恒报 `aria-busy="true"`**（存量）：
   `aria-busy={updatePending || updateProgress !== null || undefined}` —— `updateProgress` 类型是
   `T | null | undefined`，未传时 `undefined !== null` 为真。同文件详情页 CTA 用的是 `updateBusy || undefined`。
9. **上游自带空断言**（存量，上游 `fd73bc91` 自身状态）：`im/shared/__tests__/slashCommands.test.ts:28-31`
   仍 mock `sessionRepo.resetSessionToDefaults`，而上游 `faff4c71e4`（#5155）已把 `slashCommands.ts`
   改调 `resetImSessionChannelDefaults` 却未同步该测试 ⇒ 三条
   `expect(mocks.resetSessionToDefaults).not.toHaveBeenCalled()` 已成**空断言**（两父线都未改该文件）。
10. **journal 的 `when` 非单调**（存量）：`0006→0007`（上游本身也有）与 `0107→0108`（Meka 合成时间戳），
    本轮 5 条新 entry 的 `when` 取自上游原值、尾部单调，未引入新问题。
11. **`applySharedMekaBinding` 在事务提交之后执行**（存量设计，注释已说明）：理论上存在一个
    「行已可见但仍是粗粒度 `project`」的窗口；`withSessionRouteLocks` 覆盖创建路径。非本轮引入。
12. **`task-migration` 的 `view()` 不透出 `result.notes`**：目标机缺项目/角色时的**绑定丢失提示**因此
    静默（对比普通分享 wizard 会展示 `mekaProjectMissing` 等文案，i18n 五语齐全）。
    Meka 会话已被排除（§5.1 第 4 项），该路径对 Meka 不可达 —— 留作后续议题。
13. **`meka_target_json` 往返是值等价、非字节等价**（存量）：`sessionShareExport.ts:876-880` 解析后
    `mekaShareBinding.ts:213` 重新 `JSON.stringify`，与该文件 `:267` 注释「原样回写」字面不符；
    该列无消费者，判为无害。
14. **`tools/model-catalog/sync-xai.mts:54` 硬编码生产端点** `https://model-access.cindy.app/...`：
    该字面量**不在** `scripts/check-endpoint-literals.mjs` 的 `CONTROLLED_SOURCE_FILES` 内 ⇒
    端点单一来源门禁覆盖不到（也不违反已实现的受控范围）；且它只支持 global（CN 是
    `model-access.cindy.com.cn`），但 `region-and-editions.md §2.2` 允许「缺省落 global」。门禁覆盖缺口。
15. **移动冷更边界（需把关人确认，属流程而非代码）**：上游本轮把新 config plugin
    （`apps/mobile/plugins/with-incoming-share-feedback.js`，及 `incoming-share-feedback.swift` /
    `incoming-share-strings.json`）接进**已注册**的 `app.json:136` prebuild 链
    （`with-incoming-share-files.js:4` require、`:64` 调用）。`apps/mobile/plugins/**` 与 `app.json` 是
    runtime fingerprint 输入 ⇒ 按 `AGENTS.md`「冷更边界」，**须由仓库指定把关人针对冷更明确确认后才能合并**。
    本轮只做了**文件级**确认，**未实算指纹**。
16. **`host-system-prompt.md:4` 写死 `Cindy`**（本轮新增段落：“…direct the user to **Cindy's built-in
    Check for Updates action**…”）：该文件 `:1` 存量已是 `You are Cindy, …` ⇒ 与本文件既有约定一致，
    属**提示词层面的沿用**而非新缺口；登记以明示「提示词继续用 Cindy」这一口径（若要改，应整文件统一裁决）。
17. **`orcaInterAgentDispatcher.ts:55` 的 `workerSessionId`**：一度被误判为「Meka 死字段」，
    实测**承重**（`register.ts:2304-2313` 的战斗报告桥接依赖它）。此处登记为**语义行**，
    下一轮同步**不得**按「取上游」删掉它。
18. **`codexRouteTransaction.integration.test.ts` 的 35 项 skip**：`describe.skipIf(!process.env.CINDY_TEST_CODEX_BINARY)`，
    属环境门而非弱化，但意味着本轮新接入的 codex writer transfer（`register.ts` 的 relink 路径，
    上游 `d4489b81a3` 首次接通：HEAD 里 `requiresCodexThreadRelink` 曾是死参数）**默认无自动化覆盖**。
    建议纳入发布前真机验证清单。

**C. 修复 codex 硬关（§5.2 A）后新增的登记项**

19. **远端只有 thread-config 一层防线**：修复后 `getSessionHost` 对 `remoteHostId` 仍早返回、不传 opts，
    Desktop 钩子对 remote 也早返回（`maker-host/index.ts:1748` 读不到、`:1973` 又把 remote 排除在
    `codexSubagentSpawnArgs` 之外）⇒ 远端**没有** spawn 层 `-c agents.enabled=false`、也没有智能调配门，
    唯一防线是恢复后的 thread config（`agents.enabled:false`，由 `thread/start` / `thread/resume` /
    workspace-routing reload 共用）。这与 `meka-skills.md:872-877` 的分工一致，但**要在真机确认
    远端 codex 确实遵守 thread 级 `agents.enabled`**（若远端 `config.toml` 的 Multi-Agent 提示更早生效则门禁不成立）。
    要彻底封死需改 Desktop 生产代码，超出本轮范围。
20. **共享 utility host 不携带该 flag**（key 恒为 `local`）：`forkSdkSession`（thread/fork）、one-shot、
    compact/rollback、memory 系列都跑在这台 host 上，fork 出来的子 thread 不会重新重申
    `agents.enabled:false`。存量、非本轮引入。
21. **真机未取证**：F1/F2 的证据止于 maker-core 真实 `createHost` 路径单测 + Desktop 钩子单测 +
    变异复核，**未实跑真机链路读 `codex app-server` 的完整命令行**。⇒ 见 §6.3/§6.4 的未验证项。

**D. 修复「任务迁移」门禁（§5.1 第 4 项）后新增的登记项**

22. **目标侧（`receive`）没有 Meka 门禁**：若**源机是旧版本**（无本轮门禁），被控端仍会收下 Meka 包并落盘；
    且 `receive()` 的 `restoreWorkspace`（`task-migration/service.ts:795`）**早于** `inspectShareFile`（`:800`），
    所以即便想用 `inspected.preview.meka.present` 拦也要先调整顺序。属「混合版本 + 第 12 项」的后续议题。
23. **同类第三态落空仍在（存量，非本轮引入）**：`SessionItem.tsx:833-834` 与
    `SessionContentHeader.tsx:696-699` 的**本地**「移动到项目」子菜单仍是
    `workspaceKind === 'project' ? workingDir : null` / `=== 'dialogue'`，对本地 Meka 会话同样两头落空。
    两处在合并前 HEAD 就存在。本轮只修了「其他电脑（复制任务）」那条链。
24. **新错误码 `MIGRATION_MEKA_UNSUPPORTED`**（五语齐备）与准入规则位置
    （`main/task-migration/service.ts` 的 `assertSource()`，覆盖 `start` 锁前/锁内、`retry` 的后台 `prepare`、
    以及团队成员逐个准入）已随本次交付登记进 `docs/`（本节即其事实落点）。

**E. 修复「开发目录装入确认」（§5.1 第 1 项）后新增的登记项**

25. **`meka-dev-plugins:package` 仍把 owner 租约跨在 `dialog.showSaveDialog` 上**（`cindy-brain/index.ts:7339-7340`，
    HEAD 亦如此 ⇒ 存量）：与本次修的「等待用户交互不得持租约」属同一类问题，但不在本轮范围内。
26. **`updateDevelopmentPackage` 仍不取 `withGhostInstallLock` / `withActiveOwnerGhostOauthMutationLock`，
    broker 用 `stop()` 而非 `stopAndWait()`**（存量；市场与本地更新路径与它不同构）。本轮未扩大范围。
27. **开发目录仍是两次确认**（Meka 自有 `MekaDevInstallReview` 展示信任等级与源码目录 + 上游权限确认框）：
    这是**有意行为**（`plugin-security-and-authoring.md` 要求展示信任等级与源码目录，上游要求权限确认），
    相关注释已如实改写并指向本节。
28. **开发目录装入尚未做真实 Electron 端到端**：需实机走「选目录 → 自有 review → 上游权限确认 → 首装成功 →
    `meka-dev-*` 落位 → 卡片 DEV 角标」一遍。⇒ 见 §6.3 的未验证项。

### 5.3 推送后 `client-ci` 红点（**存量**）的修复

**起因**：推送后按 `AGENTS.md`「推送后要确认 `client-ci` 通过」核查，确认 **`client-ci` 是红的**，
但用**逐条注解对照**证明**推送前**的分支头 `1b4f6a7c91`（该分支自 2026-09-21 起连续 5 次推送）**就是同一批失败**
⇒ 属**存量**、非本轮合并引入。用户裁决「全部修」（本轮授权），故一并修复并再推送。

**当时 `client-ci` 的分工**：`verify-checks` ✅ 与 `Desktop Git integration` ✅ **通过**
（typecheck desktop/mobile、`db:validate`、i18n、品牌术语、术语表、设计清单、端点、scheduler guard、
mobile scope guard 在 CI 上全部通过）；红的只有 **4 个单元测试分片**与汇总作业 `verify`。

| # | 症状（CI 注解 / 作业） | 根因（**同一批：POSIX 语义 × Windows 字面量 / 8.3 短名 / 时序假设**） | 修法与证据 |
| --- | --- | --- | --- |
| 1 | Linux 1/2：`expected [ 'default', …(3) ] to deeply equal [ 'default', …(4) ]`（`linuxInstallation.test.ts`） | `apps/desktop/resources/linux/register-desktop.sh` 只注册 `x-scheme-handler/cindy`（**上游 scheme**）+ `xdt-maker`，漏了 Meka 的 `cindy-meka` / `xdmaker-meka` | **产品缺陷**：改为身份正本的 `allDeepLinkSchemes()`（`cindy-meka` / `xdmaker-meka` / `xdt-maker`），并**不再注册上游 `cindy://`**（AGENTS.md 的不变量）。**真实 Linux（WSL `fedora44`）before/after 实证**：修复前 2 个 handler 且含上游 scheme，修复后 3 个 Meka scheme、零上游。新增 `brand-identity-sync.test.mjs` 镜像断言（**11/11**，含 `xdg-mime` 实参与 `MimeType` 双向 + 负向「不得注册 `acceptedUnregisteredSchemes`」）；**变异复核**：把脚本改回旧形态 ⇒ 该断言立刻红，还原后逐字节一致 |
| 2 | Linux 1/2：`Error: Test timed out in 5000ms`（`unsupportedBrowserPrompt.test.ts:69`） | 该用例要遍历 renderer 源码树并逐个解析 AST；Linux 默认 `testTimeout` 只有 5s（见 `desktop-unit-test-performance.md`），**本机实测该用例自身耗时 4.44s** | 按仓库既有做法给该用例**显式 60s 预算**（不改断言）。Windows 实跑 2/2 |
| 3 | Linux 2/2：`expected "spy" to be called with arguments: [ 'skills/extraRoots/set', …(2) ]` | `codex/index.test.ts` 的 Skill 根注册用例把 `C:\snapshots\revision-a\claude-plugin` 写死，而生产用 `path.join(pluginPath, 'skills')` ⇒ POSIX 上得到 `.../skills` 与期望的 `\skills` 不等 | 夹具与期望**与生产同构**地用 `path.join` 按平台构造。**Linux 侧实算**：`/snapshots/revision-a/claude-plugin/skills` 两侧一致；Windows `codex/index.test.ts` **934/934** |
| 4 | Linux 2/2：`expected 0 to be greater than 0`（`mekaDefaultRole.test.ts:413`） | 夹具写死 `path: 'C:\Workspace\demo'`，而生产 `localDb/ipc/mekaRoles.ts:185` 是 `if (!configuredPath \|\| !path.isAbsolute(configuredPath)) return null;` ⇒ POSIX 上不读项目配置、调用数恒为 0 | 夹具改为 `path.resolve('workspace-demo')`（两平台都绝对）。**真实 Linux（整棵 `apps/desktop/src` 镜像 + Linux Node 22 + vitest 3.2.7）**：修复前 1 红（与 CI 注解逐字吻合）→ 修复后 **7/7**；**变异复核**：把守卫改成「绝对路径也返回 null」⇒ 同一条断言立刻红，还原后与仓库逐字节一致 |
| 5 | Linux 1/2：`Error: P4 root must be an existing absolute directory`、`expected false to be true`（`meka-settings` / `combatEnvironmentGate`） | 同类：夹具硬编码 `C:\P4` / `C:\Workspace\saga2\saga2_project`；POSIX 上 `path.isAbsolute('C:\P4') === false`，且 `path.join` 会产出混合分隔符 `C:\...\saga2_project/saga2_unity` ⇒ 校验/映射判定走偏 | 改为**自建真实 tmp 夹具**：`mkdtempSync(os.tmpdir())` 建真实 P4 根与子目录、`where` 映射也走 `path.join`；并**删掉 `statDirectory` / `readdir` 两个 stub**，让生产校验与子目录发现**真的被测**。**真实 Linux 8/8**、Windows 8/8；**变异 3/3 全被抓**（去掉校验守卫 / 去掉映射校验 / `ready:true`） |
| 6 | Windows 1/2、2/2：`Error: Runtime config target escapes the managed directory`、`expected 'C:\Users\runneradmin\…' to be 'C:\Users\RUNNER~1\…'`、`expected "spy" to be called with arguments: [ Array(1) ]` | **Windows 8.3 短名 vs `realpath` 长名**：GitHub runner 的 `os.tmpdir()` 是 `C:\Users\RUNNER~1\…`，而 `fs.realpath*` 一律回长名 ⇒ 严格 `startsWith` / `toBe` 全部假失败 | ① **生产代码**：`cindy-brain/localServerSupervisor.ts` 的越界守卫加 `canonicalManagedRoot()`（两侧都规范化；`:747` 仍要求严格子路径、`:790` 仍允许等于根）—— **未削弱守卫**，并**新增 2 条 junction 反例**（受管目录内的链接指向目录外 ⇒ 必须拒绝且外部文件字节不变），变异 `if (false && …)` ⇒ 两条都红；② 测试侧：`revealSlot.test.ts`、`forge.test.ts`、`localServerRuntime.test.ts` 的期望改为**规范化后严格相等**（`forge` 还**加强**了一条 `access()` 证明真实落盘）。取证：本机造**真实 8.3 短名**（含最接近 CI 的中段短名）注入 `TEMP`，4 种形态实跑 **146 passed / 2 skipped** 全绿 |
| 7 | Windows 分片（本地全量复现，CI 注解未展示全）：`expected { selection: { …(5) }, …(1) } to be undefined`（`bot-import/host.test.ts`） | **不是路径问题**：持久回执在共享 `transferCompanion` 内先写成 `complete`，宿主随后才删检查点（`bot-import/host.ts:508`）；埋点实测该窗口 **30–160 ms**，而 `vi.waitFor` 默认 50 ms 轮询 ⇒ 周期性先观测到 `complete` 就断言 | 改为用 `vi.waitFor` 等**最终状态**（要求记录存在 **且** 检查点已删，超时 10s）—— 若生产不再删检查点照样红。同条件负载对照：before 3 次失败 1 次（正是 CI 那条消息）→ after 4/4 全绿 |

**归因结论**：以上 7 条**全部是存量**（推送前 `1b4f6a7c91` 的注解里就有同样断言）。
反向证据：**我本轮修的 `packagedResourceDeclarations` 让旧运行里的 `expected [ Array(1) ] to deeply equal []` 从我的运行中消失** ——
即「修好的会消失、没修的照旧」，正是存量判定的正向对照。

**本轮新发现、但按范围只登记的同类隐患**（均有实测证据）：

1. `meka-projects/__tests__/combatWorkflowPolicy.test.ts:70` 的
   `path.resolve('C:/Workspace/saga2/saga2_project')`：POSIX 上它会变成 `<cwd>/C:/Workspace/...`；
   **当前 Linux 实跑 61/61 绿**（cwd 不在 `/tmp`），但把仓库 clone 到临时目录时其中 2 条会红
   （`saga2_json` 恰好落进「授权临时目录」分支 ⇒ `TypeError` 而非 deny）。修的时候**不能用 `os.tmpdir()` 做根**，
   否则反而改坏这两条用例的语义。
2. `localDb/ipc/mekaRoles.ts:169` 的 `path.isAbsolute(projectRoot) ? path.resolve(projectRoot) : ''`
   **两个平台都没有覆盖**：`mekaDefaultRole.test.ts` 用工厂 mock 把 `readProjectConfigState` 整个替换掉了
   （mock 忽略 locator）。探针实测：Linux 上 `projectRoot` 传到 mock 时是**空串**（Windows 上是绝对路径）而 7 条仍全绿
   ⇒ 值无关、非侥幸，但**一旦有人把 mock 换成真实实现，那三条会「Windows 绿 / Linux 红」**（真实实现 `projectConfig.ts:450/615`
   对非绝对 root 直接 throw）。
3. `bot-import` 生产侧的**有界快照泄漏**：回执已 `complete` 时预览检查点仍短暂存在，
   若崩溃落在该窗口内会留下无人回收的检查点（恢复逻辑只处理 `running` 回执）。非正确性破坏。
4. 复现边界（如实登记）：Windows 侧结论建立在「本机造真实 8.3 短名」的同类错配复现 + CI 注解逐字对齐上，
   **没有**在真实 GitHub Windows runner 上验证；Linux 侧结论来自 WSL 真实 Linux 镜像跑（含整棵 `apps/desktop/src`）。



> 依据 `docs/dev-rules/meka-whitelist-verification.md` §2 的四阶段口径。**逐项都是实跑**，
> 未跑项一律标注「未跑 / 未验证 + 原因」，不代填、不预设结论。

## 6. 白名单验证（阶段 A–D）

> 依据 `docs/dev-rules/meka-whitelist-verification.md` §2 的四阶段口径。**逐项都是实跑**，
> 未跑项一律标注「未跑 / 未验证 + 原因」，不代填、不预设结论。

### 6.1 阶段 A — 结构审计（实跑）

```
pnpm audit:merge -- --worktree --allow <6 项见下>
paths=12745  hand-merged=2257  took-ours=0  took-theirs=0
additive-ours=0  additive-theirs=0  dropped-by-result=69  added-by-result=10419
blockers=0  dropped=0  review=0  generated=48
verdict: PASS (有待确认项)
```

首跑（不带 `--allow`）报 **6 个 dropped**，逐条核实后全部良性并带证据豁免：

| dropped 项 | 定性 | 证据 |
| --- | --- | --- |
| `drizzle/0115..0119_silky_power_man/last_the_watchers/spicy_valkyrie/cynical_thunderball/hard_vindicator.sql`（5 条，`[upstream] 整个文件被丢`） | **D4 有意改号**（重编号为 Meka `0118..0122`），审计的「file-removed」判定看不到 rename | `git hash-object` × 5 与 `git rev-parse origin/main:<原号>` **逐字节 IDENTICAL** |
| `scripts/test-related.mjs`（`[ours] 11/28 新增行缺失`） | Meka 的**英文说明注释**被改写成**同义中文注释**（且并入了上游口径说明），行为零丢失 | 逐行比对：缺失的 7 行全是 `//` 注释；`GIT_BASE_REFS` 的 Meka 优先项与 `baseRef` 透传都在 |

### 6.2 阶段 B — 最小自动化集合

（逐项实跑结果见下；`test:unit` / `test:db` / 实机项在修复收敛后一次性重跑）

| 命令 | 结果 |
| --- | --- |
| `pnpm --filter desktop typecheck` | ✅ **exit 0**（修复前后各跑一次；期间由 `pnpm install` 修掉上游新增 `dotenv@^16.6.1` 未安装导致的两条 `bot-import/sources.ts` 报错） |
| `pnpm --filter desktop db:validate` | ✅ **6/6 全过**：`123 sql file(s) seq 0000..0122`、journal 与 snapshot 全对齐、`drizzle-kit check` 无 schema drift、44 脚本均 CJS、固定基线 80+23 / canonical 118+44 |
| `pnpm --filter desktop exec drizzle-kit generate` | ✅ `No schema changes, nothing to migrate`，且**跑前跑后 drizzle 目录文件哈希清单一致**（未写盘） |
| `pnpm audit:merge` | ✅ 见 §6.1 |
| `pnpm check:i18n` | ✅ 五语 **11384** key 全部一致（exit 0） |
| `pnpm check:i18n-glossary` | ✅ 无新增违规（exit 0） |
| `pnpm check:brand-terminology` | ✅ PASS（exit 0） |
| `pnpm check:endpoints` | ✅ PASS（exit 0） |
| `pnpm check:design-inventory` | ✅ GENERATED 最新（55 surface，exit 0；冲突解决后由 `pnpm design:inventory` 重生成） |
| `pnpm check:dev-docs` | ✅ 9/9（exit 0） |
| `pnpm licenses:generate` | ✅ exit 0（生成物只含本轮新增依赖的预期变化） |
| `node --test scripts/__tests__/brand-identity-sync.test.mjs` | ✅ **10/10**（镜像点 5 → 10，含 3 条 known gap 锁） |
| 定向套件（各能力组自跑） | ✅ 见 §3 各组「定向实跑」；累计逾 3000 条断言通过 |
| `pnpm test:runner`（`test:unit` 的第一阶段） | ✅ **705 条：698 pass / 0 fail / 7 skipped** |
| `pnpm test:unit` | ⚠️ 首跑 4 个 workspace 红（详见 §6.2.1 分诊）；**唯一实质失败已修**，其余逐条单独重跑全绿 |
| `pnpm test:db` | ✅ **exit 0**（`# fail 0`） |

### 6.2.1 `test:unit` 失败分诊（首跑 4 个 workspace 红，逐条单跑复核）

`pnpm test:unit` 会把各 workspace **并发**拉起（本机 32 CPU 但为共享开发机）。首跑结果：

| workspace | 失败 | 分诊结论 | 单独重跑 |
| --- | --- | --- | --- |
| `apps/desktop` | 10 条（7 文件） | 见下表 | 见下表 |
| `packages/maker-core` | `pi-startsession-cleanup` 1 条 | **并发负载下的超时抖动**（非代码问题） | ✅ **106/106 通过** |
| `packages/maker-pi-manager` | `session-registry` 1 条 + 1 个 unhandled error | **并发负载下的抖动** | ✅ **57/57 通过** |
| `packages/lizi-mcps` | `COMMAND_FAILED`（无具体失败用例） | **并发负载下的假红**（与上一轮同一现象） | ✅ **67 文件 / 904 passed / exit 0** |

`apps/desktop` 的 10 条逐条结论：

| 失败用例 | 分诊 | 证据 / 处理 |
| --- | --- | --- |
| `packagedResourceDeclarations` 「声明集合的每个条目在源码树里真实存在且非空」 | **真实缺陷（确定性红，非抖动）** | `resources/${UPDATER_EXE}` 被 `extraResourcesForTarget()` 声明，但 `cindy-meka-updater.exe` 依 2026-09-24 裁决**有意不入仓**（`.gitignore:48-51`）却**没进** `BUILD_TIME_GENERATED_RESOURCES` 白名单 ⇒ 只要本机没恰好留着该 exe 就必红，**干净 checkout（CI）必红**。已补白名单条目（写明 `forge.config.ts` 的 `prePackage` 现场用 Rust + Tauri 构建、落点 `destExe`、并引 `.gitignore:48-51`）⇒ 该文件 **6/6 通过**，全量单跑亦为 0 红 |
| `i18nCompleteness`「every static t() key exists in all locales」 | 负载超时（win32 默认 60s） | 单独跑 **通过** |
| `mainWindowBackgroundThrottling`「关闭了 backgroundThrottling 的窗口…」 | 负载超时（该用例要遍历 `src/main` 全树） | 单独跑 **通过** |
| `send-outcome`「does not allow accepted and outcome to contradict at type level」 | 负载超时（自带 15s 预算，要跑 TS 类型诊断） | 单独跑 **通过** |
| `codexAuthInvalidation`「compares Codex hard-link identities…」 | 负载超时（自带 20s 预算，首次 `await import('../auth-adapters.js')` 要冷转译整个 auth-adapter 图；该用例注释本身就记录了这个已知慢点） | 受控实验：把预算临时抬到 180s 后**该用例 6.95s 通过**（断言逻辑正确），随后从 index 完整还原该文件（`git diff` 为空） |
| `bot-import/host.test.ts` 3 条 | 负载超时 | 单独跑 **通过** |
| `background-task-output/reader.test.ts` 2 条（符号链接用例） | **本机环境限制** | `EPERM: operation not permitted, symlink`；最小复现证明本 shell 无 Windows 创建符号链接权限（`fs.symlinkSync` 直接 EPERM）。**`client-ci` 跑在 `ubuntu-latest`（`.github/workflows/ci.yml:36`）**，不受此限 |

**额外发现（不在 `test:unit` 集合内，但属本轮合并引入，已修 / 已登记）**：

- **`makerSendToSessionOrdering.test.ts` 的源码标记因合并失效（已修）**：该用例断言
  `register.ts` 的源码形状，标记写的是 `pendingAgentSwitchApplyHolder = async (sessionId, signal, selection) =>`
  （三参形态）。上游本轮把该 holder 的签名扩成**四参** `(sessionId, signal, selection, beforeApply)`，
  而**上游自己的测试文件也没同步**（`git show fd73bc91:…` 里 UP 测试仍是三参、UP 的 `register.ts` 已是四参）
  ⇒ 上游自带的不一致；它在单元 tier 里被 `scripts/test-workspaces.config.mjs` 显式 `exclude`，
  所以上游 CI 看不见。**但对本仓是「本轮合并让它从通过变为失败」**（HEAD 侧 `register.ts` 当时还是三参、标记匹配），
  故按「本次修改引入的问题必须在本次交付内修复」把标记更新为四参形态并加注释说明
  ⇒ 该文件 **35/35 通过**。
- **`drizzle-proxy-perf.test.ts`（手动 `db-perf` tier，未修，仅登记）**：单跑报
  `no such column: "context_window_runtime"`。该列**确实存在**（`drizzle/0108_context_window_runtime.sql`
  与 `meta/0108..0110_snapshot.json` 均可查），且该测试文件**本轮未被改动**；
  它属于配置里 `status: 'manual'`、理由写着「DB proxy performance is intentionally explicit because
  strict timing is host-sensitive」的 tier，**不在 `test:unit` 集合内** ⇒ 按存量登记，不纳入本轮修复。

### 6.3 阶段 C — 实机验收（实跑）

环境：Windows x64 开发机、dev 沙箱实例（`mode=remote`、`region=global`、`userData=CindyMeka-dev2-dev`）。

| # | 命令 | 结果 |
| --- | --- | --- |
| 1 | `pnpm restart:desktop:remote` | ✅ `DESKTOP_DEV_VERDICT=ready`（窗口 + 认证 + 本地库就绪），`pid=42984`；四类 agent 二进制均已就位（claude 2.1.280 / codex 0.156.0 / ripgrep 15.1.0 / pi 0.85.1） |
| 2 | `pnpm desktop:whoami` | ✅ `ready`，实例上报 `commit=08dd93c4e8…` **与当时的 HEAD 一致**（本次验收跑在合并后的工作区上，其 tree 即 §7 的 merge commit） |
| 3 | `pnpm desktop:ui-smoke` | ⚠️ `checks=15 pass=13 fail=2 unverified=0` —— 2 条 FAIL 是 **WL-1.2 / WL-1.3**（要求**未配置**态；本机沙箱已连接，而断开连接会吊销**不可续期**的 MCPRouter 凭据，故不能为跑门禁而断开）⇒ 与第三轮**同一结论**，登记为「未验证 + 原因」 |
| 4 | `pnpm desktop:session-smoke` | ⚠️ `checks=11 pass=2 fail=9 unverified=0` —— **WL-11.4 PASS：真实建会话并跑完一轮，模型回复「收到」**；其余 9 条属 WL-3.2 / WL-11.1–11.8 / WL-11.17 系列，根因是本机沙箱项目（saga2）处于**正式流程 + jira/SAGA** 状态（2026-08-05 起），而该脚本的门禁预期是「普通项目 + 普通对话」 |

**第 4 项为何判为「非回归」**：本套失败涉及的 Meka 代码与本轮门禁脚本**全部未被本次合并改动** ——
`packages/maker-core` 侧 `meka-injection/mekaResolvePlan.ts`、`apps/desktop` 侧 `meka-injection/index.ts`、
以及 `scripts/meka-session-smoke.mjs` / `scripts/meka-ui-smoke.mjs` 对 `08dd93c4e8` 的 `git diff --numstat`
**均为空**；第三轮在同一项目态下得到同一组结果与同一根因。⇒ 与第三轮一样登记为
「未验证 + 原因」，需维护者以**改动项目态**（或提供普通项目夹具）的方式书面接受。

**阶段 C 未覆盖的真机项（如实登记，不得据此宣告收敛）**：

1. **codex 原生子代理硬关的真机取证**：需起一条 codex 战斗会话（`providerId=xd` + 目录内有
   `contextWindow` 的模型）后读取 `codex app-server` 进程的完整命令行，确认含 `-c agents.enabled=false`。
   本轮修复的证据止于 maker-core 真实 `createHost` 路径的单测 + Desktop 钩子单测 + 变异复核（§5.2 A）。
   同时需确认**远端**（MCPR/SSH）codex worker 确实遵守 thread 级 `agents.enabled:false`（远端只有这一层保护）。
2. **开发目录插件「装入确认」的真实 Electron 端到端**：需人工走「选目录 → Meka 自有 review（信任等级／源码目录）
   → 上游权限确认框 → 首装成功 → `meka-dev-*` 落位 → 卡片 DEV 角标」，并验证**取消不报错 toast**、
   **权限未变多的更新不弹确认框**（存量兼容红线）。本轮修复的自动化证据是 6 条定向用例 + typecheck。
3. **codex writer transfer（本轮新接通的 relink 路径）真机切换**：任务内 xd↔openai 切换需实机验证
   fork/转移成功与失败文案可行动；对应集成套件需 `CINDY_TEST_CODEX_BINARY`（默认 35 项 skip）。
4. **移动冷更指纹**：本轮上游把新 config plugin 接进已注册的 prebuild 链（§5.2 第 15 项），
   按 `AGENTS.md`「冷更边界」须由仓库指定把关人针对冷更明确确认；本轮只做文件级确认，**未实算指纹**。
5. **双模式（Light/Dark）目检**：本轮改动含插件详情页/目录页的按钮呈现与开发确认框文案，
   **未做视觉目检**（与第三轮同为「未验证」项）。

### 6.4 阶段 D — 结论

- **结构层**：`pnpm audit:merge` **PASS**（blockers 0 / dropped 0 / review 0，6 项豁免逐条有据）；
  两道机械化行级审计覆盖 126 个「双方都改过」的文件，无未解释的双侧内容丢失（§3.0）。
- **实现层**：desktop `typecheck` **exit 0**；`test:runner` 698/705（7 skipped，0 fail）；`test:db` **exit 0**；
  `db:validate` **6/6**；`drizzle-kit generate` 无 schema 变更；i18n / 术语表 / 品牌 / 端点 /
  设计清单 / dev-docs 六道检查全 **exit 0**；`test:unit` 的唯一实质失败已修，其余失败逐条单独重跑全绿或
  属本机环境限制（§6.2.1）。
- **语义层**：阶段 C 四项实机命令全部执行；**真实会话跑通并产出回复**；两处门禁红项与第三轮同形、
  根因在**项目态**而非本次改动（涉及文件 `git diff` 均为空）。
- **本轮共发现并修复 12 处问题**（§5.1；含 1 处会让 Meka 开发目录插件永远装不上的 P0、1 处会让 Meka
  市场页每次安装都崩的 `TypeError`、1 处会把整个 Perforce 工作区打包并静默丢绑定的「任务迁移」缺口、
  2 处存量红线违例，以及 1 处**干净 checkout 必红**的静态门禁缺口）。
- **结论**：在「结构 / 实现 / 语义」三层**未发现 Meka 能力丢失**；上表 5 项真机与 6.3 的 2 项门禁红项
  **未验证**，已连同原因逐项登记，**需维护者书面接受**后方可宣告合并完成。

## 7. 交付状态

- **分支**：`meka/main`（直推集成分支，**不开 PR**）；本次交付 = 一个 merge commit
  （`origin/main` = `fd73bc91fd` 合入，父提交 `08dd93c4e8` + `fd73bc91fd`），DCO 已签
  （`git commit -s`，author/committer = `zhouwenkang <zhouwenkang@xd.com>`）。
- **工作区状态**：冲突 0、`git diff --diff-filter=U` 空、全仓冲突标记 0；暂存 1573 个文件
  （+155911 / −21301）；未跟踪仅 `_analysis/`（一次性脚本与日志，**不提交**；交付时用显式路径 `git add` 复核）。
- **卫生扫描**（相对 `origin/main` 的新增行）：`.only(` = 0、`@ts-expect-error` / `@ts-ignore` = 0；
  `.skip(` 2 处均为平台条件跳过（如 `t.skip('Windows tar ZIP behavior')`）；`as any` 3 处中 2 处是本轮新增测试
  沿用该文件**既有**的 `vi.spyOn(agent as any, '<private>')` 风格（HEAD 已有同款用法），1 处为既有
  `(globalThis as any).Gateway`。
- **推送后门禁**：`meka/main` 的唯一自动化门禁是 `client-ci` 的 push 触发；提交 SHA 与 `client-ci`
  的最终结论记录在本报告 **§7.1 补记**（含未通过项时的处置口径）。
- **本次交付同步更新的事实文档与契约**：
  1. `docs/migrations/2026-09-25-origin-main-to-meka-main.md`（本报告，§1–§7）
  2. `docs/migrations/xdmaker-meka-to-cindy.md` **§11.30**（第四轮同步总账条目）
  3. `docs/dev-rules/database-and-migrations.md`（编号现状 → 第四轮：已发布 `0000..0117`、本轮追加
     `0118..0122`、canonical 基线实测 118+44）
  4. `docs/dev-rules/plugin-security-and-authoring.md` §4.1（**两段式复核的绑定口径**：源码快照指纹是
     求得确认的前置条件，确认 key 必须绑定**派生开发包**的 inspection）
  5. `docs/dev-rules/cindy-updater.md`（新增「Agent 侧的『检查应用更新』入口」一节）
  6. `docs/dev-rules/meka-whitelist-verification.md`（WL-6.5 登记新 agent 更新面；更正「远端 worker 硬禁用
     仍在链路里」的不成立断言）
  7. 门禁与测试：`scripts/test-related.mjs` + 其测试（`.github/workflows/**` 恢复 wide，Meka 门禁口径）、
     `scripts/__tests__/brand-identity-sync.test.mjs`（镜像点 5 → 10，含 3 条 known gap 锁）、
     `apps/desktop/src/renderer/__tests__/i18nBrandPlaceholder.test.ts`（7 个新 key 纳入）、
     `apps/desktop/src/main/maker-host/__tests__/codexNativeSubagentsDisabled.test.ts`（硬关最后一跳）、
     `packages/maker-core/src/agents/codex/index.test.ts`（F1/F2 回归）、
     `apps/desktop/src/main/cindy-brain/__tests__/mekaDevPlugins.test.ts` + `marketGhostSessionBoundary.test.ts`
     （开发目录装入确认）、`apps/desktop/src/main/task-migration/__tests__/service.test.ts` +
     `TaskMoveSubmenu.test.tsx`（Meka 门禁）、
     `apps/desktop/src/main/session-share/__tests__/sessionShareImport.test.ts`（device handoff 成对测试）、
     `apps/desktop/src/main/maker-ipc/__tests__/botGroupChatService.test.ts`（群聊头品牌断言成对）、
     `apps/desktop/src/main/__tests__/packagedResourceDeclarations.test.ts`（白名单补项）、
     `apps/desktop/src/main/__tests__/makerSendToSessionOrdering.test.ts`（源码标记随上游签名更新）
  8. `docs/legal/notices/**` 与 `apps/desktop/resources/THIRD-PARTY-*.txt`（随新增生产依赖重生成）

### 7.1 交付事实补记（提交 SHA 与 `client-ci` 结论）

- **merge commit**：`6749aacfab086151a56d4b41b86c7291083de3c5`
  （父提交 `08dd93c4e8af59134319d0fbdea4db43b82a4c9a` + `fd73bc91fd3d2dabe680876f5271027630c68752`）；
  `Signed-off-by: zhouwenkang <zhouwenkang@xd.com>` 已在 trailer 中核对。
- **推送**：`git push origin meka/main` → `1b4f6a7c91..6749aacfab`（fast-forward，`0 behind / 694 ahead`）；
  推送后用 `git ls-remote origin refs/heads/meka/main` 确认远端 ref 已指向该 SHA。
- **`client-ci` 结论（第一次推送）**：**红**，但**逐条注解对照证明是存量** ——
  `verify-checks` ✅ 与 `Desktop Git integration` ✅ 通过；红的只有 4 个单元测试分片 + `verify`，
  且与**推送前**分支头 `1b4f6a7c91`（自 2026-09-21 起连续 5 次推送）的失败**逐条同源**。
  正向对照：本轮修的 `packagedResourceDeclarations` 让旧运行里的
  `expected [ Array(1) ] to deeply equal []` **从我的运行中消失**。
- **为降低 CI 红的风险，已逐条执行与 `client-ci` 等价的本地检查**（步骤名取自
  `.github/workflows/ci.yml`）：

| CI 步骤 | 本地结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | ✅ exit 0（lockfile 与 manifest 一致） |
| `pnpm test:runner` | ✅ 706 条：699 pass / 0 fail / 7 skipped |
| Device Link 集成（`tsc -p scripts/device-link/tsconfig.json` + `pnpm test:device-link`） | ✅ exit 0；集成用例 **9/9** |
| `pnpm check:design-colors --base-ref … --head-ref …` | ✅ exit 0（仅 `report/bare-color` 提示，均在非阻断范围内） |
| `pnpm check:design-inventory` | ✅ exit 0 |
| `pnpm check:endpoints` | ✅ exit 0 |
| `pnpm check:i18n` | ✅ exit 0（11384–11385 key 五语一致） |
| `pnpm check:brand-terminology` | ✅ exit 0 |
| `pnpm check:i18n-glossary` | ✅ exit 0 |
| `pnpm --filter desktop typecheck` | ✅ exit 0 |
| `pnpm --filter mobile typecheck` | ✅ exit 0 |
| `pnpm --filter desktop db:validate` | ✅ 6/6 |
| `pnpm ci:scheduler-guard` | ✅ 6 条守门规则全过 |
| `pnpm --filter mobile test:scope` | ✅ `mobile-scope-guard passed` |
| unit tier（`test:workspaces --tier unit`，Windows 作业的那一份） | ⚠️ 见 §6.2.1：唯一实质失败已修；其余为负载/环境所致，逐条单独重跑全绿 |
| companion DB 回归（`botCanonicalSession` / `botRemoteResourceProvider` / `builtinMekaSeed`） | ✅ exit 0；**402/402** |
| Pi manager integration tier（CI 的 Linux 作业项，本机也实跑） | ✅ `PASS packages/maker-pi-manager integration` |
| **Linux 专属单元分片** | 本机为 Windows，无法执行 ⇒ 改为**用真实 Linux（WSL 镜像）**逐条复现并修掉 §5.3 的 7 条红点 |

### 7.2 存量 `client-ci` 红点的修复与第二次推送

- **内容**：§5.3 的 7 条（4 个单元分片 + `verify` 的失败来源），逐条给出根因、修法与**双平台证据**
  （Linux 侧用 WSL 真实 Linux + Linux Node 22 + vitest 3.2.7 的镜像跑；Windows 侧用本机真实 8.3 短名注入复现），
  并对每处做**变异复核**证明修复后仍能抓住真回归。
- **涉及文件**：`resources/linux/register-desktop.sh`（产品行为：深链 scheme 注册）+ `cindy-brain/localServerSupervisor.ts`
  （生产守卫规范化，**未削弱**，含 2 条 junction 反例）+ 6 个测试文件 + `brand-identity-sync.test.mjs`（镜像断言 5 → 11）
  + 本报告/docs 落账。
- **提交与 CI 结论**：见 §7.3（第二次推送后回填）。
- **本轮授权边界**：这 7 条属**存量**，按 `AGENTS.md`「审查与问题范围」需用户确认后才动 —— 已向用户报告证据并取得
  「全部修」的明确授权；其余同类但**不造成 CI 红**的隐患（§5.3 末段 3 条）仍按「只登记」处理。

### 7.3 第二次推送的事实补记

- **提交**：`f1159fd8712a044dd9d108c807fa67b768c28abe`（父提交 `22e28e29b8`，单亲普通提交），
  DCO 已签；`git push origin meka/main` → `22e28e29b8..f1159fd871`，`git ls-remote` 确认远端 ref 指向该 SHA。
- **`client-ci` 复跑结论：✅ completed successfully**（Actions run **#39**，
  `run id 36426372957`）。逐作业核对（运行页无任何失败步骤锚点）：
  `verify-checks` ✅、`Desktop Git integration` ✅、**`Linux unit tests (1/2)` ✅**、
  **`Linux unit tests (2/2)` ✅**、`Windows unit tests` ✅、汇总 `verify` ✅。
  ⇒ 与第一次推送的对照：**两个 Linux 分片由「有失败锚点」变为「clean」，`verify` 由红变绿**，
  而 `verify-checks` / `Desktop Git integration` 保持绿。
- **获取方式备注**：本机无 `gh`、无 GitHub 令牌（`origin` 走 SSH）且未认证 API 有 60 次/小时限流，
  故 CI 结论通过 GitHub 公开网页解析获得 —— 运行页 `aria-label="completed successfully: Run 39 of client-ci …"`
  与运行列表页同一标记即为绿；失败项则通过作业页的 `#step:N:LINE` 失败锚点与注解（含 `file:line`）定位。
  **该解析方式已在本轮全程使用**（含第一次推送红点的逐条注解取证）。




