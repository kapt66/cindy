# `origin/main` → `meka/main` 同步报告（2026-09-10）

> 本轮在 `C:\Workspace\cindy`（主 worktree）把上游 `origin/main` 语义合并进
> `meka/main`。基线：`HEAD(合并前)=5917437271f29eb97b0a36d828430020e17d7176`、
> 上游 `origin/main = MERGE_HEAD = 4f03ea9a7b5f6425e517acd91071df6d397c6079`、
> `merge-base=625a7d714f199cb6770b5d1f556bb1f0322e9fbb`（= 上一轮同步的上游来源）。
> 目标侧独有 112 个提交，上游侧独有 1383 个提交；Git 报告 **133** 个冲突路径。
> merge 已解决并提交（`git commit -s`，merge commit 的两个父提交为
> `5917437271` 与 `4f03ea9a`；具体 SHA 见 `git log -1 --merges`）。
> **未 push、未创建 PR。**

## 1. 范围与基线

- 工作区：`C:\Workspace\cindy`（主 worktree，分支 `meka/main`）
- 目标分支：`meka/main`；来源：`origin/main`
- 来源 SHA：`4f03ea9a7b5f6425e517acd91071df6d397c6079`
- 目标合并前 SHA：`5917437271f29eb97b0a36d828430020e17d7176`
- merge-base：`625a7d714f199cb6770b5d1f556bb1f0322e9fbb`
- 执行时间：2026-09-10 起（Asia/Shanghai）
- 交付状态：`git diff --name-only --diff-filter=U` 为空；index 全为 stage 0 且与工作区
  一致；merge 已提交（merge commit 的两个父为 `5917437271` 与 `4f03ea9a`）；**未 push、未创建 PR**。
- 本次只处理客户端仓；未修改服务端仓库、未修改已发布 migration、未执行
  `git merge --abort` 或任何破坏性回退。

## 2. 决策记录

| 决策 | 决策人 | 结论 |
| --- | --- | --- |
| 冲突区分口径 | 用户 | 先区分「只是代码冲突」与「真实的 Meka 功能点冲突」；不是 Meka 特意改的功能一律优先接纳上游；真实功能冲突逐条列出交用户决策 |
| D1 协议包归属 | 用户 | `cindy-protocol` **没有特意处理**，按上游做：移除 Meka submodule 与 gitlink，改用上游仓内 `packages/{plugin-protocol,slack-hook-protocol,device-link-protocol}` 与 `packages/design-tokens`；已有的功能必须保持正常 |
| D2 Desktop 启动／区域策略 | 用户 | **身份保留**；**启动语义同步上游** |
| D3 插件市场「能力与安装批准解耦」 | 用户 | 同步上游（属插件基座，仍需仓库白名单批准门） |
| D4 数据库 migration 编号 | 用户 | 冻结 Meka 已发布编号（`0082`–`0095`），上游 schema 从下一个合法编号追加（`0096`–`0107`）；不手改 snapshot，从源重新生成 |

## 3. 审计方法与本轮的关键发现

上一轮解冲突时，Git 对**单侧删除/改写上游未察觉的能力组**不报冲突，导致若干能力组被静默解成
「上一轮同步前」的旧世代。本轮用三种机械审计交叉验证，再逐组人工复核：

1. **三方 blob 比对**：对 index 每个路径比较 `HEAD` / `MERGE_HEAD` / index 的 blob，
   按「是否引入 stage≠0」「是否只等于某一侧」分类（`mekaOnly=245`、`upstreamOnly=1863`、
   纯取一侧且另一侧无改动 = 正确、**两侧都改过却整体取一侧 = 需要人工判定**）。
2. **行集合包含性比对**：对「取了一侧」的文件，检查另一侧**新增的行**是否在结果中缺失。
   这一步找出 `hook-control/**` 整组被解成旧世代（上游新增 406 行缺失）。
3. **token 多重集比对**：对剩余偏差做 token 级比较，区分「纯换行/重排」与「真实内容丢失」。
   结论：所有存活偏差 ≤1%，且剩余项是 Meka 身份改名（如 `CindyGlobal` → `CindyMeka`）与
   Meka 有意分歧，**无实质上游内容丢失**。

补充确认：`cindy-protocol` 的 gitlink/`.gitmodules` 被移除属于 D1 决策；上游对
`ackReactions.ts` / `requestLedger.ts` 相对 merge-base **零改动**，而 Meka 侧删除了它们，
所以 Git 静默接受删除、不报冲突——这正是本轮最危险的一类产物。

## 4. 发现并修复的合并产物缺陷

### 4.1 `hook-control` 能力组（P0，构建与运行期都断）

- **现象**：index 的 `manager.ts` 是完整上游版本，却在 4 处调用
  `dispatcher.setEmojiReactionsMode` / `onMessageOpResult` / `handleTurnDelivery` /
  `settleAckReactions`，而 `dispatcher.ts` 被解成 Meka 旧侧、这 4 个成员一个都不存在
  → `pnpm --filter desktop typecheck` 必然失败；运行期 X 渠道每帧 `turn.delivery` 抛
  TypeError、`deactivateAccount()` 中途中断、Telegram 表情档位同步与 👀 收口整体缺失。
- **证据**：上游 `ackReactions.ts`(343 行) / `requestLedger.ts`(359 行) 相对 merge-base
  零差异却被 Meka 删除；`dispatcher.test.ts` 缺 664 行、`session-runner.test.ts` 缺 326 行、
  `dispatcher.ts` 缺 406 行；逐行集合比对确认 **上游是这些文件的严格超集**
  （Meka 新增的 73 行全部已在上游存在）。
- **处置**：按上游恢复 `dispatcher.ts`、`dispatcher.test.ts`、`session-runner.test.ts`、
  `interactions.ts`、`defaults.ts`、`ipc.ts`（补 `createHookRequestLedger` 与
  `terminalLedger` 构造），并恢复被误删的 4 个文件（`ackReactions.ts`、`requestLedger.ts`
  及两个测试）。`manager.ts` / `session-runner.ts` / `queryResponder.ts` /
  `turnObserver.ts` 本就是「上游 + Meka」的正确并集，未动。
- **保留的 Meka 分歧**（仅 2 处，其余与上游一致）：
  - `recentSessions.ts`：`workspaceKind` 允许 `'meka'` 并在投影中跳过——**Meka 项目工作区不得
    进入 IM `/sessions` 选择器**（上游不认识 `'meka'`，会当普通项目会话下发）。
  - `__tests__/groupWindow.test.ts`：用 Meka migration 谱系（`0089` /
    `0092_sync_upstream_20260821` + companion）替代上游的 `0083/0086/0087/0088`
    ——**已发布 migration 编号不得按上游重写**。
- **验证**：`vitest run src/main/hook-control` → 22 文件 / 627 测试通过。

### 4.2 `typecheck` 断链（35 个 TS 错误 → 0）

以能力组为单位修复（每个都做了三方比对，区分 a=合并产物、b=Meka 有意分歧）：

| 文件 | 根因 | 处置 |
| --- | --- | --- |
| `main/authManager.ts` | Meka 常量 `PRODUCT_EDITION_KEY = 'cindy_product_edition_v1'` 声明被吃掉，只剩 4 处引用 | 按 Meka 补回常量（保护 edition 持久化 key 契约，老用户已存 edition 继续可读） |
| `main/index.ts` | 上游单行 `BRAND_IDENTITY` 导入与 Meka 多符号块重复 → TS2300 | 删上游重复行，保留 Meka 块（`brandDesktop*` 设备身份派生） |
| `im/shared/sessionRepo.ts` | 上游新增 `im.rotateSession` tx 的 `workspaceKind` 只写 `'project' \| 'dialogue'` | 在 `localDb/client/tx/types.ts` 反向补 `'meka'`（保护 Meka 原生项目会话不被 IM `/new` rotate 截断） |
| `maker-ipc/register.ts` | Meka 独有的 `authorizeMekaHighRiskCallViaDesktop` 仍用被上游替换掉的 `wiredSessionsById` | 改用上游 `sessionBindings.getSession(id)`（语义等价） |
| `mcp-integrations/__tests__/collabSendOutcome.test.ts` | Meka 新增的两个 combat-gate 用例缺上游新必填 `botCapabilities` | 复用文件内既有 mock 补上 |
| `meka-formal/jiraClient.ts` | 上游给 `GhostOauthAccessTokenResult.error` 新增 `'BROKER_FORBIDDEN'` | 补齐 error 联合并按原样上报（不静默折叠成 `NETWORK`） |
| `renderer/features/plugin/GhostPluginPage.tsx` | D3 删除 `approveUpdateExpansion`/`skipUpdateExpansion` 后，Meka 残留的 `UpdateAllDialog` 调用点仍传 `onApprove`/`onSkip`；`ghostPermissionItems` import 丢失 | 删两行、按上游正典路径补 import |
| `renderer/features/plugin/MekaDevInstallReview.tsx` | 相对路径深度错（`../../shared/ghost`） | 修正为 `../../../shared/ghost` |
| `renderer/components/sidebar/SidebarTopNav.tsx` | lucide `Bot` import 丢失（Meka 保留 `mekaRow` + 上游新增 `botsRow` 需要并集） | 补 import |
| `renderer/features/cc-agent/CCAgentSidebarUpper.tsx` | `CircleAlert`/`Loader2` import 丢失；且上游与 HEAD 都有的「内容可见分支远程任务部分失败提示」被丢 | 补 import + 按上游恢复该提示块 |
| `renderer/features/skillhub/lib/mekaSkillMarketViewModel.ts` | 上游 `MarketSkill` 新增 `canManage`/`tags`/`githubUrl` | 按语义补齐：`canManage: item.access === 'owner'`（与既有 Meka 视图门禁同口径）、`tags: []`、`githubUrl: null`（MCPRouter 目录不提供该维度） |
| `renderer/features/skillhub/SkillhubDetailView.tsx` | outdated 横幅谓词被错按成上游 name-taken 谓词（`entry.registryEntry` 窄化消失）；`onLocalRenamed` 取了上游签名却留 Meka 函数体 | 恢复上游谓词；采纳上游 2 参签名 + 保留 Meka 函数体；并回被静默覆盖的 `!isMekaEntry` 守卫（`isMekaEntry` 计数恢复为 13，与 HEAD 一致） |
| `cindy-brain/__tests__/forge.test.ts` | `GHOST_MANIFEST_SUMMARY_MAX_CHARS` 双来源导入（上游已移到 plugin-protocol） | 只留 plugin-protocol 来源 |
| `cindy-brain/mekaDevPlugins.ts`（Meka 独有） | 上游 `ForgePackResult` 新增 `buf: Buffer` | 从 `packed.buf` 装载 zip，派生包返回真实落盘字节（非空 Buffer） |
| `renderer/features/cc-agent/NewMakerDraftRoute.tsx` | `switchVendor(next, prefs)` 旧世代签名 | 改 1 参（上游 store 已由 `patchVendorPrefsInternal` 维护 `lastByVendor`） |

### 4.3 单元测试（renderer 源码契约 / 行为）

- `AuthContext.tsx`：上游 `enterLocalMode`/`exitLocalMode` 已用 `applyIncomingState(state)`，
  工作区仍是旧的手拼 setter 列表 → 恢复上游形态。
- `NewMakerDraftRoute.tsx`：上游「本机首条消息在草稿路由发出」整套（fence、
  `sendWorkingDir`、`navigateToSession`/`handOffDraftToSession`、
  `restoreRemoteOptimisticDraft` FIFO 恢复、斜杠/pi 前缀交接）在 MERGE_HEAD 完整存在、
  工作区却仍是 HEAD 的 `setPending` + 交给 SessionView hydrate → 按上游整段移植，
  保留 Meka 的 `messageToSend`（正式任务首条正文）与 `isMekaDraft`/`workspaceKind:'meka'`。
- `UserInfoSection.tsx` 源码形态断言：Meka 保留运行期 `edition = CURRENT_CINDY_REGION`
  解构使单行 needle 不可能匹配 → 断言改为格式无关（字段集合 + `edition` 仍在同一次
  `useAuth()` 解构内）。
- `CCAgentSidebarUpper.tsx`：上游已删「设备目录失败提示 + 手动重试」，工作区残留且
  `retryDeviceLinkDeviceList` 连 import 都没有（未定义标识符）→ 按上游删除。
- `LoginPage.tsx`：Meka 在 identifier 视图插入 `LoginRealmSelector`，使两个视图的第 3 个
  子节点类型相同、React 复用同一 `<input>` 节点，导致上游 `autoFocus` 失效
  → 给两个视图的 `LoginInput` 加显式 `key`（零布局影响）。
- 身份/凭证隔离 4 文件：`authPassiveSharedInstance`（迁移入口对象签名）、
  `devKeychainMarkerIo`（dev 身份名 `CindyMekaDev`）、`codexAuthIsolatedSandbox`
  （夹具目录名改用 `brandUserDataDirName(CURRENT_CINDY_REGION)`）、`xaiModelDiscovery`
  （Meka signed-out 短路）——均为**测试口径落后于 Meka 源码**，零源码改动。
  修正 `codexAuthIsolatedSandbox` 后，原本「假绿」的两条 Release 继承用例真正走了 Release 路径。
- `updateService`：上游新增用例写死 `cindy-updater.exe`，Meka 渠道名是
  `cindy-meka-updater` → 测试改走 `BRAND_IDENTITY.updaterName`。
- `transport-manager`：内联假 dispatcher 缺上游新增的 `setEmojiReactionsMode`/
  `settleAckReactions`（导致绑定状态机中断 + 20s 超时）；另一条需采用上游已适配的
  `provider.behavior.get` 断言块 → 均按上游适配。
- `agent-input-coordinator.ts`：`drain()` 丢了 HEAD 的
  `if (head.origin?.kind !== 'orca')` 守卫、并删掉 `state.recovery = null`
  → 恢复 Orca 守卫，守卫内保留上游新增的 `clearErrorProjectionSignals(state)` 与
  HEAD 的 `state.recovery = null`（**Orca 自动报告只可穿过 `active-turn` Retry，
  不能消费 Retry/error；`queue-head` recovery 继续严格阻塞**）。
- `composerStructuredLists`：Bot mention 的 href 是**生成值**（`buildBotReferenceHref` →
  `allDeepLinkSchemes()[0]` = 主 scheme），故期望 `cindy-meka://bot/...`；
  解析侧 `parseBotReferenceHref` 仍同时接受 `cindy-meka://` 与不注册的 `cindy://`。
- `CreateWorkerPopover`：上游已把 Agent 切换并入统一模型面板并显式断言弹窗内不再有独立
  agent tablist → 测试改用本文件既定适配范式（`pick-codex-config`），保留 Meka 语义断言
  （`agent: 'codex'` / `remoteHostId: 'mcpr:instance-1'` / `providerId: null`）。

### 4.4 手工 db tier（CI 不跑，所以上游自己也失修）

8 个文件 / 56 个失败，全部归 **(a)**，修法统一是「让手写夹具对齐合并后的真实 schema／
真实 `DbClient.tx` 契约」，**未弱化任何断言**：`claudeLocalSessions`、`codexLocalSessions`
（夹具补 `list_preview*` 列）、`storage.db.test.ts`（补 `model_agent_kind`）、
`messagesWriteReadback` / `messagesClearRace`（假 DbClient 补 `tx`，后者接真实 in-proc
事务处理器以保住 CAS 语义）、`drizzle-proxy-perf.bench.ts`（补 `writable_dirs` 与历史列）、
`subagentRunsBroadcast`（Windows 路径分隔符改走 `path.join`）、`conversationSearch`
（源码形态断言读取后归一化 CRLF）。Meka 生产列/表/迁移**零改动**。

### 4.5 新增同步审计门禁 `pnpm audit:merge`

本轮把当时手工做的三类机械审计固化成 `scripts/audit-merge-resolution.mjs`
（`pnpm audit:merge`），并挂进 `docs/dev-rules/development-workflow.md` 第 4 节与根
`AGENTS.md` 的同步前置规则。它专抓** Git 不报的静默丢失**，与本轮两个 P0 同源：

- 上游新增的能力（文件或整块代码）而 Meka 从未碰过 → Git 无冲突，结果里却没有；
- 两侧都改过、解决时整体取了单侧；
- 生成物被手工解决。

判定分三档：**BLOCKER**（未解决冲突／冲突标记残留）与 **DROPPED**（一侧实质新增的
内容缺失）阻断；**REVIEW**（结果整体等于单侧、疑似按编号顺移）与 **GENERATED**
（生成物被改动）只提示。为压低误报做了：内容归一化（行尾/空白）、token 多重集兜底
（区分"重排"与"真丢"）、生成物与二进制跳过内容比对、按 blob/内容/路径三种 key 识别
搬迁、以及"对方也删了"的合法删除识别。

自查结果（对本次 merge commit 运行）：

- 10406 路径，`hand-merged=287`、`took-ours=3`、`took-theirs=27`、
  `additive-ours=383`、`additive-theirs=4048`；`blockers=0`、`dropped=8`、`review=53`。
- 8 条 DROPPED 已逐条确认为合理，不需要恢复：
  - `apps/desktop/src/renderer/features/plugin/lib/updateAllController.ts`、
    `maker-host/__tests__/codex-subagent-config.test.ts` —— D3（插件市场能力与安装批准
    解耦）与上游 Codex 子代理协议废弃后的**有意删除/替换**；
  - `.gitmodules` —— D1 移除 submodule；
  - `apps/desktop/src/main/updateVersion.ts`、
    `apps/desktop/src/shared/cindyVersion.ts` —— 已被上游
    `updateVersionPolicy.ts`（`compareAppUpdateVersions`）与 `@cindy/plugin-protocol`
    （`supportsCindyVersion`）取代，属**孤儿清理**，引用已全部改向；
  - `apps/desktop/src/main/__tests__/updateVersion.test.ts` —— 随之移除。
- 工具同时抓出**上一轮同步的真实事故**作为正向验证：对
  `01391448e9`（2026-08-24 那次同步）运行会报出 48 条 DROPPED，其中包含本次修复的
  `hook-control` 相关丢失与 drizzle 迁移文件缺失——即该门禁若当时存在，事故在提交前
  就会被拦下。
- 反向验证：对本次已修复的 merge 运行结果为 `blockers=0`；对同一批文件用
  `git read-tree -m --aggressive` 只读复现 Git 的自动三方合并，确认上述被删文件
  **被 Git 自动合并保留**，即删除来自上一轮解冲突时的误操作而非 Git 行为。

该工具的判定逻辑有单测覆盖（`scripts/__tests__/audit-merge-resolution.test.mjs`，
23 条，含在临时仓库里真实跑 merge 的端到端用例），已登记进 `pnpm test:runner`。

### 4.6 Meka 老用户模型可见性被整张清空（P0，静默；属 (b) 覆盖而非 (a) 解错）

**症状**：合并后「新建任务」草稿的模型选择器**一条模型都不显示**，而「设置 → 模型供应商」
页照常列出全部模型与开关。数据、凭据、供应商连接全部正常。

**归因**：上游 2026-09-05 `053b000be7`、09-07 `b91b78c507`、09-10 `54bbf3abca` 三个提交
引入「模型可见性初始化清单」机制（规则见 `docs/dev-rules/configuration-and-overrides.md`
§2「模型可见性例外」）。上游把这两者写成**上下位关系**，客户端新逻辑覆盖了 Meka 旧语义：

| | 合并前 Meka | 合并后（= 上游） |
| --- | --- | --- |
| `isModelEnabled` 判定 | `isModelVisible(override, defaultEnabled)` = `override ?? defaultEnabled !== false` | 显式 override → `followCatalogKeys` 跟随目录 → **初始化清单 `defaults[key] ?? false`** → 兜底 `mayInitializeDefaults ? defaultEnabled : false` |
| 无记录路线的默认 | 可见（跟随目录） | **不可见**（除非拿到新用户初始化资格） |

初始化清单只由 `migrateModelVisibilityDefaults` 写入，而它只对 Main 判定为
`profileOrigin === 'new'` 的配置开放（`readOwnerState` → `claimLegacyModelVisibilityOwner`）。
`profileOrigin` 由 `readModelDefaultsProfileOrigin(ownerDatabasePath(userData, owner))` 按
**该 owner 的库文件 / 迁移标记是否存在**定性：库已在 ⇒ `existing`。

**Meka 之所以被整群命中，不是库名前缀的差异**：`ownerDatabasePath` 用
`BRAND_IDENTITY.dbFilePrefix` 拼出路径再查**同名**文件，前缀在「拼」与「查」两端互相抵消，
上游同形态的老配置同样会被判成 `existing`（`cindy-meka` 与 `cindy` 在这里语义等价）。
真正的差异是**机制的到达时间**：

- 上游自 2026-09-05 起逐版引入该机制（`053b000be7` → `b91b78c507` → `54bbf3abca`），
  期间新建的配置走 `new` 初始化、持有清单；上游只有「9/5 之前就存在且没有任何历史证据」
  的老配置会落到无清单分支。
- 而 Meka 谱系在本轮同步之前**完全没有这套机制**：`eligibleForDefaults`、
  `INITIALIZATION_KEY_PREFIX`、`profileOrigin`、`followCatalogKeys` 在合并前的 `meka/main`
  中出现次数均为 **0**（`git grep -c` 实测），且 Meka 自 merge-base 起从未改过该文件
  （`git log 625a7d714..5917437271 -- <path>` 为空）。

因此**没有任何一个既有 Meka 配置可能持有初始化记录**，整个存量用户群同时落到
「无清单 ⇒ 该配置下所有模型解析为『不显示』」。

草稿选择器（`unifiedModelEntries` 的 `isVisible` 谓词 → `isModelEnabled`）因此整张空；
设置页不受影响，因为 `UnifiedModelList` 的**行是否渲染**只看 `isAgentSelectableModel`
与停用轴，显示轴只决定开关态与「未启用」沉底区（上游「保存过的选择不出行」契约）。

**三方对比证据**：工作区的 `apps/desktop/src/renderer/state/modelVisibilityPrefs.ts`
与上游 `4f03ea9a7b` **逐字节相同**（`git diff 4f03ea9a7b -- <path>` 为空）⇒ 上游实现被
完整接受。该语义在 `b91b78c507` 时仍是旧的 `isModelVisible(...)`，到 `54bbf3abca` 才改成
严格清单语义；两个提交都只存在于上游一侧（`merge-base 625a7d714` 之前不存在）。
故这不是「合并解错」，而是**有意的 Meka 分歧被上游覆盖**：上游改的是决策函数的语义，
而 Meka 的产品前提（既有配置也必须看得见模型）没有被表达出来。

**修复**（`modelVisibilityPrefs.ts`，最小改动、只加不删）：给 Meka 谱系补一次
一次性快照初始化。`migrateModelVisibilityDefaults` 的锁内新增：当
① 该 owner 的补种标记不存在，② 现有清单资格位不为真且 `defaults` 为空，
③ Main 把这份配置定性为 `existing` / `adopted-local` 时，
按「同一次调用观察到的目录」写一份 `defaults[key] = defaultEnabled !== false` 基线
（= 合并前的实际可见集合），并落下补种标记；`pending`（Main 还没定性）一律不猜、
等它，`new` 走既有初始化，`profileOrigin` 缺失则失败关闭（保持上游「未知路线关闭」）。

不变量保持：显式 override 仍最高优先（用户关掉的不会被重新打开）；`followCatalogKeys`
（「恢复推荐」）不参与判定也不被改写；补种后新增模型不随目录默认开启（冻结语义与上游
新用户一致）；补种标记只在真的观察到目录后落盘，目录未到时重放幂等。
条件 ② 同时覆盖「已经被合并后版本跑过一遍、写成 `{eligibleForDefaults:false,
defaults:{}, scopes:[...]}`」的配置 —— 空清单与「没有清单」在读取侧等价，必须一起修。

**同一根因的第二个受害面（一并修）**：main 侧的可见性快照由 `effectiveMap` 从
`initialization.defaults` 派生（`model-visibility-mirror.ts` 在 `strict` 模式下对快照外的
任何 key 返回 `false`），而 `mirrorToMain` 只在 `setModelVisibilityOwner` 与 `persist` 里
触发、`load()` 在本模块把 `cache` 置非空后不再走镜像分支。补种发生在目录到达之后，因此
「只落盘、不重推」会让应用内选择器已有模型而 **IM `/model` 卡片仍按旧空快照把所有模型判成
不显示**，违反本文件头注承诺的「两侧同一套可见性」。故在 `saveInitialization` 成功后
补一次 `mirrorToMain(cache ?? {})`；这同时覆盖上游「新配置首次初始化」路径（同样只落盘
不重推，属上游原有缺口）。新增用例 `mirrors the seeded snapshot to main so IM /model is
not left empty` 锁定该行为。

**同时修正的测试口径**：`modelVisibilityPrefs.test.ts` 里两条用例断言的是上游
「`existing` 配置一律不出模型」口径（`does not initialize an existing owner…`、
`does not infer a new profile from empty model storage`）。它们**不是被弱化**，而是
按新的、经用户裁决的 Meka 事实改写：`existing` + 空清单现在必须补种（新增
`seeds a frozen upgrade snapshot for a pre-merge Meka profile`），并为「已补种后冻结」
「被合并后版本写过空清单后的修复」「`followCatalogKeys` 路线仍跟随目录」
「`pending` / 定性缺失 fail-closed」各补一条用例。

### 4.7 Meka 开发插件「从目录加载」直接失败（P0，属 (b) 覆盖而非 (a) 解错）

**症状**：Meka 插件页「从目录加载（开发模式）」选中源码目录后立即报
`无法生成独立开发身份：schemaVersion 2 的 slots 必须是数组`，插件无法登记，重试无效。

**归因**：`mekaDevPlugins.createDevelopmentPackage` 把 Host **归一化后**的清单
（`packed.manifest`）当作者清单用：叠加派生 `id` / `command` 后交给
`validateGhostManifest`。上游本轮把 v2 的 `slots` 从归一化产物里彻底移除了——
`validateGhostManifest` 现在返回的运行时模型只保留 `tools` / `panel` / `notify` /
`reveal` 等直接字段（`ghost.ts` 头部注、`prepareGhostManifestForValidation` 的 v2 分支），
作者格式的 `slots` 只在兼容解析入口出现。于是同一份清单二次校验必然命中
“schemaVersion 2 的 slots 必须是数组”（`ghost.ts:4092`）。

**为什么合并前能用**：Meka 侧的 `createDevelopmentPackage` 与合并前**逐字节相同**
（`git show 5917437271:…/mekaDevPlugins.ts` 对比），差异全在 `ghost.ts`：合并前
`validateGhostManifest` 的返回体里带 `slots`（旧 `ghost.ts:5395`），归一化清单**本身就是**
合法作者清单，所以二次校验能过；上游把归一化产物改成“无 slots 的运行时投影”后，
这一处调用随即失效。属 (b) 上游改语义、Meka 侧调用点前提被覆盖。

**排查范围**：`git grep 'validateGhostManifest('` 在 `src/main` 共 27 处，逐处核对输入格式后
**只有这一处**把归一化清单当作者清单用；`ghostInstallReceipt`、`GhostManager` 用的是专用
`validateNormalizedGhostManifest`，`plugin-market`、`installedGhostManifest`、`forge`、
`ghostSignature` 的输入本来就是作者格式（或与其自身同格式比较），均不受影响。

**修复**（`mekaDevPlugins.ts`，最小改动）：派生包改为以包内**作者格式**的 `ghost.json`
为基底——即 `packed.buf`（内存快照，仍不回读磁盘，保持 Forge 不变量）里的那一份，只叠加
派生的 `id` 与被改写的 `command`，再走同一道 `validateGhostManifest`。不采用
`ghostManifestToAuthorFormat` 反向重建：反向投影依赖 field↔slot 映射，会丢掉没有对应能力
详单的槽（`dropEmptyLegacyCapabilitySlots` 已在归一化时丢弃）与未识别的历史槽，等于让开发
副本静默缩水；直接沿用作者字节与正式打包（`forge` 写进 zip 的就是作者字节）同口径。同时把
“缺少 `ghost.json`”与校验失败区分开，避免内部错误被包成同一句文案。

**验证**：新增用例 `真实打包派生开发身份后仍是合法作者清单，且只改身份字段` —— 用生产
`packMekaDevPluginSource` 真实打包（不再用 mock 打包器，mock 无法暴露该缺陷），并在
`inspectPackage` / `installPackage` 里跑**装包入口同一道** `validateGhostManifest`，
断言派生包 `ghost.json` 与源码作者清单逐字段一致、只有 `id`/`command` 不同、签名已移除。
修复前该用例以用户报告的原句失败，修复后通过。定向回归：`mekaDevPlugins` 13 / `ghost`
199 / `forge` 81 / `marketGhostSessionBoundary` 13 全通过；desktop `typecheck` 0 错误。

**实机端到端证据（用户真实插件 `meka-unity`，隔离沙箱 `dev`）**：用户 19:48 在
「Meka 插件 → 从目录加载」的实际失败原文留在 `apps/desktop/logs/main-2026-09-11.log:3278`
（`Error occurred in handler for 'meka-dev-plugins:install': … 无法生成独立开发身份：schemaVersion 2 的
slots 必须是数组`）；修复后把该源码目录登记进沙箱开发注册表并重启，启动同步的同一个
`createDevelopmentPackage` 在 20:04 成功：`main-2026-09-11.log:3543`
`ghost installed { id: 'meka-dev-meka-unity-02ef16d0', version: '1.0.15' }`，
`ghost-install-state/meka-dev-meka-unity-02ef16d0.json` 落盘。逐字段核对派生清单：
`slots: ["tool","node"]`、`tools`、`node.entry`、`manual.items`、`locales`、`icon`、`entry`
与源码 `ghost.json` 完全一致，只有 `id` 为派生 runtime ID、`command` 为
`unity-dev-ef16d0`——即「只改身份字段」在真实节点上成立，作者声明的卡槽与能力没有缩水。
（沙箱开发注册表里这一条是本次验证写入的，需要时可从「Meka 插件」页移除。）

**同一根因的第二个受害面（一并修）**：写归一化清单不只影响 v2 的 `slots`。归一化后的
`setup` 是内部 `{ kind, key }` 形态，而装包入口对 `ghost.json` 跑的是 `validateGhostManifest`
—— 上游在 `ghost.test.ts:2747` 显式断言 `validateGhostManifest(归一化清单).ok === false`，
并要求这类快照改走 `validateNormalizedGhostManifest`。所以修复前，**任何声明了 `setup` 的
插件**（v2 或 v3）派生成开发包后，会在**装包**阶段以另一个理由失败。改写成作者格式后该面
同时消失：`meka-unity` 虽未声明 `setup`，但派生清单里的 `tools` / `node` / `manual` / `slots`
逐字段与作者清单一致，已证明不存在「归一化往返」这一层。

**规则落点**：`docs/dev-rules/plugin-security-and-authoring.md` §4.1 新增
「派生包的 `ghost.json` 必须是作者格式，且只改写身份字段」条款。该文件属插件基座，
本次改动落在插件打包判据上，按仓库白名单确认门需放行人明确 Approve。

### 4.8 cc-mgr 协议 pin 的规则正文漂移（本轮合并引入，已修）

**症状**：`docs/dev-rules/mcpr-remote-session-routing.md` §4 写「当前 bundle `0.0.9` 的 daemon
自报最高 protocol `4`」，而代码实际是 bundle `0.0.10` / `PROTOCOL_VERSION = 5`
（`packages/maker-cc-manager/src/protocol.ts:42,51`，包内 `protocol.test.ts:23,27` 硬断言这两个值）。

**归因**：合并前代码与文档**一致**（`5917437271` 侧是 protocol `4` / bundle `0.0.9`，文档也这么写）；
上游把 pin 提到 `0.0.10` / protocol `5`（v5 语义：root-only `toolGuards` 接受原生
`AskUserQuestion`），本轮**接纳了上游代码但没更新 Meka 侧的规则正文**——该文件是 Meka 独有正文
（上游没有），不会被上游改动带走。

**危害**：这不是文案瑕疵。规则正文是后续同步者的判断依据，读错一版会让人对着**错误的 pin**
做「远端运行时版本门禁」核对，或据此误判 MCPRouter 侧的 pin mismatch。

**修复**：改 `mcpr-remote-session-routing.md` §4 —— 写明当前 pin 是 `0.0.10` / protocol `5`，
保留 protocol `2/3/4` 作为协商历史并补上 v5 的语义，并加一条提醒：**每次上游同步后都要重新
核对本节版本号与代码一致**，同时记录本次漂移。历史事故段（2026-08-24 记录的
「Cindy `0.0.9/p4` vs MCPRouter 生产 `0.0.7/p3`」）保持原样，它是历史事实。

**同类风险**：这是「Meka 独有的规则正文描述上游可变的常量」这一模式的必然弱点。
[`../dev-rules/meka-whitelist-verification.md`](../dev-rules/meka-whitelist-verification.md)
WL-4.1.6 已把该 pin 登记为清单项，阶段 C 实机验收必须核对。

### 4.9 新增「Meka 能力白名单与合并后验证清单」

本轮同步暴露出结构审计抓不到的一类回归：**代码都在、语义被上游覆盖**（§4.6 模型可见性、
§4.7 开发插件都是这个形态，两边各自自洽、冲突标记为零）。为此新增
[`../dev-rules/meka-whitelist-verification.md`](../dev-rules/meka-whitelist-verification.md)：
把 Meka 专属能力定义成 **WL-1…WL-14** 的白名单，每一项给出保护的不变量、可核实的代码锚点、
现有自动化门禁与可操作的实机步骤；**清单内全绿即判定可以安全接纳这批上游**。

- 与既有门禁的分工写在该文 §1：`audit:merge` 管结构层静默丢失、`test:unit` 管实现自洽、
  白名单清单管语义未退化，三者不可互相替代。
- 结构由新增的 `scripts/__tests__/meka-whitelist-contract.test.mjs` 强制（字段完整性、
  命令可解析、编号唯一、被 `AGENTS.md` 与 `development-workflow.md` 索引）。
- 同次把 `scripts/__tests__/meka-release-identity.test.mjs` 登记进 `pnpm test:runner` ——
  它此前**没有被任何门禁引用**，自己通过但永远不会跑。
- 清单 §8 汇总了**当前无自动化覆盖**的条目（含本轮真实坏过的 `mekaRow`、scheduler 5 处
  `meka` 跳过、`recentSessions` 的 meka 跳过等），以及一处**已核实的存量缺陷**：
  `sidebarProjectVisibility.ts:125` 会把隐藏项目下的 Meka 会话降级成普通对话（上游与合并前
  逐字相同，属 Meka 新增 kind 后未补豁免，未擅自修复）。


## 5. 保留的 Meka 分歧（有意为之，非缺陷）

| 分歧 | 保护的不变量 |
| --- | --- |
| `brandIdentity.ts`：`CindyMeka`/`CindyMekaDev`、`cindy-meka` scheme/渠道/db 前缀/device 前缀、`cindy-meka-updater`、cn 与 global 同目录、`cindy` 只解析不注册 | 产品身份与旧链接兼容 |
| `legacyUserDataDirNames` = `xdmaker-meka`/`xdt-maker`、`legacyDbFilePrefixes` | 首次登录从旧 `xdmaker-meka` 目录**只读**迁移 |
| migration 冻结 `0082`–`0095` + 上游 `0096`–`0107` | 不重写已发布编号（D4） |
| `workspace_kind='meka'` + `meka_*` 列/表/索引 + `sessionCreateToRow` 仅 meka 绑身份 | Meka 项目/角色/正式事项/能力快照本地事实源 |
| `scheduler-host/storage.ts` 5 处跳过 meka 会话；`normalizeScheduleWorkspaceKind()` 不返回 `'meka'` | Meka 会话不被当成 legacy cron 任务认领，`'meka'` 不泄漏进 scheduler 域 |
| `recentSessions.ts` 跳过 `'meka'` | Meka 项目工作区不进 IM `/sessions` 选择器 |
| Meka 技能链独立 provenance、`!isMekaEntry` 13 处守卫、MCPRouter 市场投影 | Meka 技能不被 Cindy 市场动作命中 |
| Meka 渠道独立账本 + `ignoredRoundStorageKey` 分桶（**旧键 `cindy.pluginUpdates.ignoredRound.<mode>.<owner>` 保持不变**） | 插件基座向下兼容：老用户「忽略本轮」不被换键丢弃 |
| `PRODUCT_EDITION_KEY`、运行期 `edition`/`CURRENT_CINDY_REGION` 选择器 | 区域分支与已有 edition 持久化兼容 |
| `SidebarTopNav` 的 `mekaRow`、`CCAgentSidebarUpper` 的 `MekaAssistantSection` 与 `/cc-agent/meka/*` 路由 | Meka 插件/Skill 管理与项目入口可达 |
| `mekaDevPlugins` 开发插件链路 + `MekaDevInstallReview` 确认面 | Meka 开发模式装载仍逐项展示新增能力 |
| `meka-formal/*`、`authorizeMekaHighRiskCallViaDesktop` | Meka 正式工作流与 Host 高危操作 fail-closed 授权 |
| `onLocalRenamed` 的 Meka 实现（`newId`/`newUrl` + 失效刷新） | 与新 scanner 的 id/路由自洽 |
| `transcript`/`subagents` 等 Meka 侧 i18n 条目 | 五语 key 一致性 |

## 6. 已知问题与未决事项

1. **`check:design-colors` 在纯上游上就是红的（(c) 类，未修）**。用 `merge-base → MERGE_HEAD`
   这个**纯上游区间**跑同一门禁，同样报 3 条 `block bare-color`
   （`chat/GhostToolCard.tsx:101` 的 `#262626`/`#ffffff`、`settings/RemoteSection.tsx:566`
   的 `#f5f5f5`）——触发门禁的窄作用域正是上游本批次的
   `881f07acf8 ci(design-system): DS-7 启用成熟范围的设计检查` 打开的。
   按「非本次修改引入的存量问题不擅自修复」保持现状；**需要用户决定**是否在本轮顺手修
   （涉及设计 token 决策，须走 `docs/design-rules/design-governance.md` 的评审），
   还是留待上游自修。CI 只在 `pull_request` 与 push 到 `main` 时跑该门禁，
   `meka/main` 直推不触发，但若以 PR 形式交付会命中。
2. **`guard` tier 在上游自身就是红的（(c) 类，未修）**。
   `pnpm test:guard` 跑 `src/main/__tests__/makerSendToSessionOrdering.test.ts` 的 3 条
   源码契约断言，而这三条针脚在 **上游自己的 `register.ts`** 里已不存在
   （上游插入 `bot-authorization-resume` 分支、把 `pendingAgentSwitchApplyHolder` 改成
   3 参、把 `planMode: false,` 改成 `inheritTargetPlanMode ? … : false`），
   同一断言也写在上游自己的测试文件里 → 上游本批次自相矛盾。unit tier 与 CI 都不跑
   guard tier；按规则未修改。**需要用户决定**是否在本轮同步修正上游遗留断言。
   （注意：`planMode` 的默认值仍是 `false`，即「非 composer 直发不继承 plan mode」这条
   Meka 不变量**未被破坏**。）
3. **真机启动验收已通过（2026-09-11，隔离沙箱）**：
   `pnpm restart:desktop:remote`（默认 `--isolated=dev`）→
   `DESKTOP_DEV_VERDICT=ready`，`mode=isolated`、`region=global`、`root=C:\Workspace\cindy`、
   `pid=98636`、`userData=CindyMeka-dev2-dev`；`desktop:whoami` 报告 `Desktop source: MATCH`。
   沙箱 DB（`cindy-meka-<machineId>.db`）的 `migration_history` 已应用到
   `0107_schedule-model-harness.sql`（`applied_at=1789109524171`），即上游顺移后的
   `0096`–`0107` 全部在真实库上跑通；启动日志无 FATAL / unhandled rejection /
   缺 handler / renderer crash。
   **说明**：隔离沙箱按设计**不触发**首登 `xdmaker-meka` 旧数据只读迁移（mToc），
   因此「旧目录只读迁移」「`cindy-meka://` 深链唤起」「更新渠道真实升级」这三条
   **仍未在本轮验证**，需在共享/正式 profile 上单独做，或由用户接受留待后续。
4. **上游新工具 `tools/codex-package/update.mjs` 在 Windows 上有 promote 竞态**
   （本批次新增，非本项目改动引入，但会挡住 dev 启动）：
   `promoteOnePlatform` 在 `writeDirDistManifest` / `verifyDirDistManifest` 刚读完
   ~368 MB 的 `codex.exe` 之后**立即** `replaceDirectory`（rename 目录），Windows 上
   该 rename 稳定返回 `EPERM`；实测同一目录推迟 3 秒再 rename 即成功。
   本次环境同时存在第二个诱因：`apps/codex-package-bin/win32-x64`（gitignore 的构建产物）
   在本 checkout 里只有空目录、缺 `.version` 与 `.manifest`，于是每次启动都强制走 promote
   分支并踩中上述竞态。已用仓库自身的 `writeDirDistManifest` 补齐该目录
   （8 条清单项、`verifyDirDistManifest` 通过），启动随即可用。
   **已处理（2026-09-16）**：按上述建议的"重试/退避"路线做了修复，不再依赖本机时序。
   - `tools/shared/rename-with-retry.mjs`：目录改名有界退避（落位预算累计 ≥3.75s；
     换下旧目录预算刻意短，因为那里多半是"应用正在运行"这种不会自愈的锁）。
   - `tools/codex-package/update.mjs`：`replaceDirectory` 两处改名都走重试；"落位已成功、
     旧备份删不掉"从失败降级为告警。
   - `tools/shared/runtime-install-error.mjs` + `scripts/ensure-agent-binaries.mjs`：错误按
     `download`/`promote` 阶段标注，只有下载阶段才考虑网络/CDN 兜底；本地落位失败**不再**
     被包装成 `Failed to download ... from upstream`。
   - **根因收窄（对照实验）**：触发条件是"**目录里含刚写入的 `.exe`**"被系统级安全扫描/预读
     组件短暂持有句柄——同一字节改名成 `data.bin`、内容清零、单文件 rename 都不复现；失败
     瞬间仍能往目录里写新文件、也能删除目录。因此它与"应用是否在运行"无关：2026-09-16
     `release:windows:canary` 失败时 `apps/codex-package-bin/win32-x64` 根本不存在（本 job
     的 worktree 是新建的），CI 侧 `target locked (probably running)` 的归因据此纠正
     （cicd 仓 `docs/setup.md` §2.1 同步改写）。
   - **端到端验证**：在"干净 checkout"条件下（目标目录不存在）跑真实
     `ensure-agent-binaries --kinds=codex --platform=win32-x64`，修复前 0/3 成功并复现同一条
     CI 报错文案，修复后 3/3 成功落地 `0.153.4`；再对目标目录里的 `codex.exe` 施加
     `FileShare.None` 独占句柄，修复后报错为
     `local install failed, not a download problem`（带 errno/路径/尝试次数）。规则与实测
     数据见 `docs/dev-rules/agent-runtime-release.md`「本地落位（promote）与 Windows 目录改名」。
5. **未验证真实 MCPRouter 市场下载/安装**（D3 解耦后客户端不再弹二次确认）与
   **Meka 技能链真实分发**。
6. **插件基座白名单批准**：D3 属插件基座改动（能力 slot / 装入与权限确认 UI / 已装列表
   投影），按 `AGENTS.md` 与 `docs/dev-rules/plugin-security-and-authoring.md` 仍需仓库
   指定把关人明确 Approve 才能合并。§4.7 的修复同样落在插件打包判据上（派生包 manifest
   格式），按同一条白名单门**一并需要 Approve**——它不因“是 bugfix”豁免。
7. **`pnpm check:dco` 报 9 个未签名提交（全部是 meka 侧历史，非本次合并引入）**：
   `bbcef9d6`、`298a3991`、`1303745e`、`fc7a77b6`、`50e98ebf`、`33348870`、`fed5702c`、
   `775bce95`、`f6a5025f` —— 均已确认为**合并前 HEAD `5917437271` 的祖先**、且**不在
   上游侧**（Meka 迁移基线提交）。本次 merge commit 自身**已带 `Signed-off-by`**
   且与 author/committer 一致。修复需要 `git rebase --signoff` 重写这 9 个已存在的提交
   （会改变历史与其它 clone），按「非本次修改引入的存量问题不擅自修复」**未处理**，
   需用户决定是否单独整改。
8. **工作区有大量上一轮遗留的未跟踪脚手架**（`.tmp-*` 约 590 个，另有 `out.txt`、
   `10`、`14`）。它们未被 stage、不在 merge commit 内，建议清理或加入 ignore。
   （已处理：清理 593 项并补 ignore 规则，见 `daf9db31b0`。）
9. **`scripts/desktop-whoami.mjs` 的进程父子图缺环保护（存量，上游与本仓共有的同一实现，
   非本次引入）**：`descendants()` 只用 `queue`/`byParent` 做向下遍历，没有 visited 集合。
   Windows 上父进程退出后 PID 被复用、或 `ParentProcessId` 自指/互指时（`Get-CimInstance
   Win32_Process` 如实返回），遍历进入环 → `result.push` 无限增长 → 抛
   `RangeError: Invalid array length`（实测栈：`desktop-whoami.mjs:136` → `:168`
   → `collectDesktopWhoamiReport`）。后果是 `pnpm restart:desktop:remote` 在**应用已
   `state:'ready'`** 的情况下仍打印 `DESKTOP_DEV_VERDICT=failed / code=STARTUP_FAILED`，
   属工具假红；`node scripts/desktop-whoami.mjs` 可独立复现（exit 2）。`descendants` 在
   `5917437271`（Meka 合并前）与 `4f03ea9a7b`（上游）中**逐字节相同**，故既非本轮合并引入、
   也非本轮解错。建议修法是遍历时带 visited 集合（或在 `identifyDesktopProcesses` 里跳过
   `ppid === pid` 与 `ppid === 0` 的条目），并补一条成环夹具的自测。按「非本次修改引入的
   存量问题不擅自修复」**未处理**，待用户决定是否纳入。
9. **`tools/codex-package/updates/0.154.0/` 有约 573 MB 的未完成下载**（gitignore，
   不进入提交）。这是本轮诊断时误触 `tools/codex-package/update.mjs`（它忽略 `--help`
   直接抓最新版）留下的；`latest.json` 仍锁定 `0.153.4`，不受影响。可安全删除。
10. **存量 lint 债（合并前后都存在，未修）**：`NewMakerDraftRoute.tsx` 的
    `RightSidebarToggle`、`CCAgentSidebarUpper.tsx` 的 `clearComposerDraft` /
    `isLoadingSidebarSessions` / `setDialogueSortBy`、`GhostPluginPage.tsx` 的 `displayId`
    未使用；`apps/desktop/eslint.config.mjs` 自身报
    `Definition for rule 'react-hooks/exhaustive-deps' was not found`。
11. **存量注释过期（未修）**：`codex-local-sessions.ts`、`skillhub/usageIndexer.ts` 仍写
    「global=CindyGlobal, cn=Cindy」，实际代码走 `brandUserDataDirName(...)` / Meka 目录名。
12. **latent 夹具失修（未修）**：db tier 里另有若干手写 `sessions` DDL 缺
    `list_preview*`/`writable_dirs` 的测试（`sessionListProjection`、`messagesListCursor`、
    `workingDirHistoryFilter`、`latestMessageText`），当前绿但同形态改动即假红，建议单开工单。
13. **改动文档**：`AGENTS.md` 与 `docs/dev-rules/protocol-and-submodules.md` 已按 D1 改写
    协议包归属与准入（不再是 submodule）；`docs/migrations/xdmaker-meka-to-cindy.md` 已追加
    §11.25 本轮同步记录。`docs/migrations/2026-08-origin-main-to-meka-main.md` 中「保留
    Meka `cindy-protocol` submodule」的旧裁决已被本轮 D1 推翻，属历史记录（未改写历史）。
14. **`tools/pi/update.mjs` 与 `tools/codex-package/update.mjs` 的 release 元数据依赖
    `api.github.com`（2026-09-16 已修）**：未认证的 GitHub API 配额是**每出口 IP 60 次/小时**，
    Windows runner 与开发机同机同 IP，2026-09-16 第二个 `release:windows:canary` 在同一个 job
    内耗尽配额后，release 步骤解析 pin 元数据直接 403
    （`HTTP 403 rate limit exceeded: https://api.github.com/repos/openai/codex/releases/tags/rust-v0.153.4`），
    codex 与 pi 都装不上、发布再次被阻断（此时 §6.4 的 promote 问题已修复，失败点已前移）。
    **已处理**：安装链路的信任锚回到**已复核的 pin**——新增
    `tools/shared/github-release-pin.mjs`（`isGitHubRateLimitError` / `pinnedAssetDescriptor` /
    `resolveInstallReleaseMeta`），codex-package 与 pi 的 `ensurePlatform` 在**仅限流**时降级为
    pin 直链（内容仍按 pin 的 sha256 强制校验，来源仍限 `https://github.com/…`），404 / digest
    漂移 / pin 不完整一律 fail closed；`fetch-with-timeout.mjs` 的非 2xx 错误现在带 `status`。
    同时发现并纠正了 CI 侧的一处浪费：`release:windows:canary` 是唯一没有在 `pnpm install` 前
    设 `XDT_SKIP_AGENT_BIN_INSTALL=1` 的 job，postinstall 会多下 ~380 MB（claude/codex/pi）并
    为 codex/pi 各花一次 API 配额——正是在同一个 job 内把配额花掉的直接原因（cicd 仓已补）。
    规则见 `docs/dev-rules/agent-runtime-release.md`「pin 是下载信任锚：上游 API 限流不得阻断安装」。

## 7. 验证记录

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 冲突清零 | `git diff --name-only --diff-filter=U` | 空 |
| 冲突标记 | index 内 `<<<<<<<`/`>>>>>>>` 扫描 | 无（仅既有行尾空白告警） |
| **静默丢失审计** | `pnpm audit:merge -- --merge-commit HEAD` | blockers=0；dropped=8 已逐条确认合理（见 §4.5）；review=53；1.7s |
| 审计工具单测 | `node --test scripts/__tests__/audit-merge-resolution.test.mjs` | 23 pass / 0 fail |
| 全量单元测试（提交前门禁） | `pnpm test:unit` | **PASS 56 / FAIL 0**（含 `apps/desktop`、`apps/mobile`、全部 required unit workspace） |
| runner 自测 | `pnpm test:runner` | 554 pass / 0 fail |
| Desktop 类型 | `pnpm --filter desktop typecheck` | exit 0，0 个 TS 错误 |
| Mobile 类型 | `pnpm --filter mobile typecheck` | exit 0 |
| 数据库门禁 | `pnpm --filter desktop run db:validate` | 6/6 步通过（108 SQL `0000..0107`、journal/snapshot 对齐、无 schema drift、脚本 CJS、历史身份冻结） |
| 真机启动（隔离沙箱） | `pnpm restart:desktop:remote` | **`DESKTOP_DEV_VERDICT=ready`**（isolated / global / root 匹配 / pid 98636） |
| 沙箱 migration 实跑 | `migration_history` 查询 | 已应用到 `0107_schedule-model-harness.sql` |
| 手工 db tier | 112 文件（同 runner include/exclude 集合） | 112 passed / 1331 passed + 6 skipped |
| hook-control 定向 | `vitest run src/main/hook-control` | 22 文件 / 627 通过 |
| 模型可见性（§4.6） | `vitest run src/renderer/__tests__/modelVisibilityPrefs.test.ts` | 64 通过 / 0 失败 |
| 模型选择器相关（§4.6） | `vitest run src/renderer/__tests__/{unifiedModelList,unifiedModelPanelRendering,modelSelectorProviderGroups,gatewayModelArrival,localCatalogSnapshot,modelSelectorTriggerVariant}` | 6 文件 / 256 通过 |
| 开发插件派生包（§4.7） | `vitest run src/main/cindy-brain/__tests__/{mekaDevPlugins,marketGhostSessionBoundary,forge}` + `src/shared/__tests__/ghost` | 4 文件 / 306 tests（304 通过 + 2 skipped） |
| 开发插件实机装载（§4.7） | 沙箱登记真实插件 `meka-unity` + `pnpm restart:desktop:remote` | 修复前 `main-2026-09-11.log:3278` 报 slots 拒装；修复后 20:04 `ghost installed { id: 'meka-dev-meka-unity-02ef16d0' }`，派生清单逐字段核对只改身份字段 |
| Windows 目录落位重试（§6.4 跟进） | `node --test scripts/__tests__/rename-with-retry.test.mjs scripts/__tests__/codex-package-update-layout.test.mjs scripts/__tests__/ensure-binary-fallback.test.mjs` | 7 + 16 + 6 用例全通过：瞬时锁重试与预算、退避耗尽后保 errno、不可重试快速失败、落位失败回滚、"备份删不掉不算失败"、阶段化归因、限流降级与 fail-closed |
| Windows promote 端到端（修复前/后，§6.4） | 干净 checkout 条件下跑 `ensure-agent-binaries --kinds=codex --platform=win32-x64` | 修复前 0/3 成功（复现 CI 原文案 `target locked (probably running)`）；修复后 3/3 落地 `0.153.4` |
| Windows promote 真实占用归因（§6.4） | 对目标 `codex.exe` 施加 `FileShare.None` 后重跑 | 报错为 `local install failed, not a download problem`（含 errno/路径/尝试次数/耗时），不再误报下载失败 |
| GitHub API 限流降级（§6.15） | `node --test scripts/__tests__/github-release-pin.test.mjs` | 7/7：限流（403+rate limit / 429）降级为 pin 直链；404/digest 漂移/坏 pin 一律 fail closed |
| 限流下端到端安装（§6.15） | 把 `api.github.com` 强制成 403 后跑真实 `ensureBinary`（清空缓存，从 pin 直链下载） | codex 与 pi 均 `RESULT ok`：下载完成 + `sha256 ok` + 落位成功（`.version` = pin 版本） |
| 提交门禁复跑（§7 注） | tier 同命令复跑 `apps/desktop` unit（`--pool=forks --maxWorkers=8` + 同组 `--exclude`） | **2609/2609 文件通过、35708 通过 / 0 失败**：确认 `unsupportedBrowserPrompt.test.ts` 的 20s 超时是负载型临界超时，非本次回归 |
| 提交前门禁（相关单测） | `pnpm test:unit:related`（PATH 前置 Git Bash） | 见下方 §7.2 本轮记录 |
| i18n | `pnpm check:i18n` | ✅ 五语 9946 key 全一致 |
| 术语表 | `pnpm check:i18n-glossary` | ✅ 无新增违规 |
| 品牌术语 | `pnpm check:brand-terminology` | ✅ PASS |
| 端点字面量 | `pnpm check:endpoints` | ✅ PASS |
| 设计台账 | `pnpm check:design-inventory` | ✅ GENERATED 最新（53 surface） |
| 文档契约 | `pnpm check:dev-docs` | ✅ 9/9 |
| 设计颜色 | `pnpm check:design-colors` | ❌ 3 条 block —— **纯上游区间同样红**，见 §6.1 |
| guard tier | `pnpm test:guard` | ❌ 3 条 —— **上游自身红**，见 §6.2 |
| DCO 自查 | `pnpm check:dco` | ❌ 9 个历史提交未签名 —— **合并前既存**，见 §6.7；本次 merge commit 已签名 |

> 注：`pnpm test:unit` 的 runner 阶段有两条依赖 `bash` 的子测试。在 Windows 上若 PATH 中的
> `bash` 解析到 WSL（`C:\Windows\system32\bash.exe`，不继承 Windows 环境变量）会假红；
> 把 Git 的 `bash.exe` 放到 PATH 前面即可通过（`bash -c 'echo $FOO'` 可自查）。
> 另有一次 `restart-desktop-remote.test.mjs` 因 Windows 文件锁瞬时 EPERM 假红，
> 单独重跑 71/71 通过。二者均非仓库缺陷。
>
> **2026-09-16 复现同一类假红（本机负载型临界超时，非回归）**：合并 §6.4/§6.14 两条修复后跑
> `pnpm test:unit:related`，`apps/desktop` unit 报
> `src/renderer/__tests__/unsupportedBrowserPrompt.test.ts > keeps renderer product code free of
> browser prompt calls` **Test timed out in 20000ms**（该文件 2609 个文件中唯一失败，35742 通过）。
> 判定为**负载型临界超时，不是代码或测试行为回归**，证据链：
> 1. 该用例扫描 `src/renderer` 全部 2633 个 ts/tsx（27.5 MB）并用 TypeScript AST 逐文件解析，
>    隔离复跑稳定通过但耗时 6.96s / 6.56s / 5.81s / 5.41s（预算 20s）——全量 worker 池竞争下
>    再叠加 collect/transform 阶段峰值即被推过阈值；
> 2. 该文件自 `9841caa6a8`（引入）后**从未改动**，两次修复的 diff 也**不含任何 `apps/desktop`
>    或 renderer 文件**（改动集中在 `tools/**` 与 `scripts/**`）；
> 3. 用与 tier 完全相同的 vitest 命令（同一组 `--exclude`、`--pool=forks --maxWorkers=8`）
>    复跑整个 desktop unit workspace：**2609/2609 文件通过、35708 通过 / 0 失败**；
> 4. 同类超时在本仓已有两次先例与一致裁决：`2026-08-origin-main-to-meka-main.md` §5.10
>    （2026-08-05：该文件单独复跑 2/2 通过、串行全量通过，归因全量并发下的资源/扫描时延波动）
>    与 `xdmaker-meka-to-cindy.md`（2026-08-21 同一结论）。
>
> 因此**未修改测试超时、未降低覆盖率**（与 §5.10 的处置一致），也不把该次超时算作本次回归；
> 提交以复跑结果为准。若后续希望根治，应按 §5.10 同样的方式单独立项（例如给该扫描用例放宽
> 单文件超时或缓存解析结果），不属本次修复范围。

### 7.1 白名单实跑记录（2026-09-11，首次按 `meka-whitelist-verification.md` 执行）

**规范**：按白名单清单 §2，合并完成后必须**实际运行**清单并逐项记录结论，只有全部通过
（或明确登记「未验证 + 原因」并经维护者书面接受）才允许宣告合并完成。本节是该次执行的原始
记录，写在这里而不是「凭印象通过」。

#### 阶段 A — 结构审计

`pnpm audit:merge -- --merge-commit bdc8397a7e` 首跑 → `paths=10406 blockers=0 dropped=8
review=51 generated=14`，`verdict: FAIL`（DROPPED 阻断）。8 条逐条确认后以 `--allow` 记账，
复跑 → **`verdict: PASS`**（`blockers=0 dropped=0`；`review=51` 与 `generated=14` 为非阻断提示）。

| DROPPED 路径 | 形态 | 逐条确认结论 |
| --- | --- | --- |
| `.gitmodules` | ours 整文件被丢 | D1 移除 `cindy-protocol` submodule；上游无此文件，协议包已在 `packages/{plugin,slack-hook,device-link}-protocol` |
| `apps/desktop/src/main/updateVersion.ts`<br>`…/__tests__/updateVersion.test.ts` | ours 整文件被丢 | 被上游 `updateVersionPolicy.ts`（`compareAppUpdateVersions`）与其同名测试取代 |
| `apps/desktop/src/shared/cindyVersion.ts` | ours 整文件被丢 | 被 `@cindy/plugin-protocol` 的 `supportsCindyVersion`（`manifest.ts:1123`）取代 |
| `docs/dev-rules/protocol-and-submodules.md` | 51/94 行缺失 | D1 规则重写（去掉 submodule 权威与 Meka 私仓地址） |
| `scripts/test-workspaces.config.mjs` | 6/6 行缺失 | 子模块路径 → `packages/*`（实测已登记 `packages/plugin-protocol`、`packages/device-link-protocol`） |
| `…/features/plugin/lib/updateAllController.ts` | 59/91 行缺失 | D3 解耦：`diffGhostPermissionItems`、`PluginMarketPackageReview` 全仓归零；`channel: 'cindy' \| 'meka'` 账本逻辑保留 |
| `…/maker-host/__tests__/codex-subagent-config.test.ts` | 49/49 行缺失 | 结构性合法（被上游重设计取代），**但伴随一处未登记的用户可见能力移除 → 见下** |

#### 🔴 阶段 A 带出：一处**未登记**的用户可见能力移除（阻断完成判定）

- **事实**：合并前 Meka 的 `SubagentModelSettings` 有 7 个字段 —— `codex` / `codexProviderId` /
  `codexEffort` / `codexSubagentsEnabled`（默认 **true**）/ `codexUseCindySubagentPolicy`
  （默认 **true**）/ `codexMaxConcurrentSubagents` / `codexAllowNestedSubagents`；现在只剩
  `codexSmartSubagentRouting`（默认 **false** = Codex 原生）。`maker-host/codex-subagent-config.ts`
  从 203 行缩到 68 行（= 上游版本），`resolveCodexSubagentHostCredentialPlan`（oauth-passthrough
  路由的 fail-fast 凭据闸）、`forceDisableSubagents`、`MODEL_OVERRIDE_PREFIX` 全仓归零。
- **迁移是刻意且带测试的**：`subagent-model-settings-store.test.ts:121`「removes retired Codex
  fixed-route and guardrail keys when settings are opened」断言旧键被丢弃、仅含旧键时设置文件被
  删除；`shared/subagentModelSettings.ts` 头注写明「旧版 Codex 固定模型、固定来源、固定 effort
  与护栏字段不再属于有效设置协议」。
- **但它没有被登记**：同步报告、迁移总账、D1–D4 决策里都没有这条（`grep -E
  'forceDisableSubagents|codexSmartSubagentRouting|固定模型|智能调配'` 在两份迁移文档中零命中）。
- **用户可见影响**：① 配过 Codex 子代理模型/来源/effort/并发/嵌套开关的 Meka 用户，这些设置被
  静默丢弃（设置文件被删）；② **默认行为翻转**（Meka 原默认 Cindy 策略开 → 现默认 Codex 原生
  Sol/Terra 调配）；③ `agents.enabled=false` 硬闸、`agents.max_depth`、并发上限不再可注入。
- **未受影响的相邻能力**：SAGA2 远端只读 worker 的硬禁用仍在链路里 ——
  `mekaRuntimeInjection.ts:622` 设 `codexNativeSubagentsDisabled` → `maker-host/index.ts:1618`
  读取 → `:1831` 走 `buildCodexSubagentSpawnArgs`（WL-4.2.3 不因此失效）。
- **需裁决**：接受上游重设计并补登为一条决策（承认默认翻转与设置退场），**或**把 Meka 的
  子代理策略移植到上游新的 `codexSmartSubagentRouting` 机制上。

#### 阶段 B — 最小自动化集合（逐条实跑）

| 命令 | 结果 |
| --- | --- |
| `pnpm audit:merge -- --merge-commit <sha>` | ✅ PASS（8 条豁免，`blockers=0 dropped=0`） |
| `pnpm test:runner` | ✅ 596 tests / 589 pass / 0 fail / 7 skipped |
| `pnpm --filter desktop run db:validate` | ✅ 6/6（108 SQL `0000..0107`、journal/snapshot 对齐、无 schema drift、companion CJS、固定基线 80 SQL+23 脚本 / canonical 基线 108 SQL+43 脚本） |
| `pnpm check:i18n` | ✅ 五语 9946 key 一致（1234 处告警，非失败） |
| `pnpm check:i18n-glossary` | ✅ 无新增违规（33 条已裁决 / 79 条待讨论） |
| `pnpm check:brand-terminology` | ✅ PASS |
| `pnpm check:endpoints` | ✅ endpoint source guard passed |
| `pnpm check:design-inventory` | ✅ GENERATED 最新（53 surface） |
| `pnpm check:dev-docs` | ✅ 9/9 |
| `pnpm test:unit` | ⚠️ 首跑 `apps/desktop unit` 红 → 定位为**端口偶发**（见下）；**第二次全量 ✅ PASS**（`EXIT=0`，runner 596/589/0，desktop unit 2609 文件 / 35704 通过） |
| `pnpm --filter desktop typecheck` | ✅ `EXIT=0` |
| `pnpm test:db` | ⚠️ **本机无法稳定全绿**：同一用例两次在 tier 内超时（`codexLocalSessions.test.ts:316`「applies the import cap after filtering subagent threads」15000ms），隔离复跑该文件 ✅ 122/122、**单用例隔离耗时实测 8617ms / 预算 15000ms** → 属**临界超时**在 tier 并行下被推过阈值；该用例在 merge-base、合并前 Meka、上游三处都存在，**非本次引入** |
| `pnpm test:guard` | ❌ 3 条（`makerSendToSessionOrdering.test.ts`）—— 与 §6.2 记录的**上游自身红**一致，非本次引入，且不在 §4 最小集合内 |

**三处环境性偶发（非仓库缺陷，均已在隔离环境复现通过）**：

1. `codexHttpBridge.test.ts` 两条用例 `TypeError: fetch failed` → `Caused by: Error: bad port`。
   根因：`codexHttpBridge.ts:429` 用 `httpServer.listen(0)` 取随机端口，而**本机 Windows 动态
   端口范围是 `1024..15000`**（`netsh` 实测 1024 + 13977），其中 19 个端口落在 undici 的受限
   端口黑名单内（1719/1720/1723/2049/3659/4045/4190/5060/5061/6000/6566/6665–6669/6679/6697/10080）。
   命中即 `fetch` 报 `bad port`。隔离复跑 25/25 通过两次，desktop unit 定向复跑 ✅ PASS。
   该模式上游与合并前一致，属**既存**的测试健壮性问题（建议避开受限端口或对 `bad port` 重试）。
2. `packages/lizi-mcps` 一次 `COMMAND_FAILED`（11.2s 死亡，正常 31.8s）：单独复跑 56 文件 /
   769 通过 / 3 skipped 正常，全量复跑亦绿。
3. `apps/desktop` db tier 同一用例超时两次（`codexLocalSessions.test.ts:316` 的 15000ms 上限）：
   隔离复跑 122/122 通过，且**单用例隔离耗时实测 8617ms**（预算 15000ms）→ 临界超时，tier 并行
   时被推过阈值。该用例在 merge-base / 合并前 Meka / 上游三处都存在，非本次引入。
   前两处共同点是**在机器同时跑其它重型任务时发生**——全量门禁应在机器空闲时跑，或修掉这几处
   对负载/端口敏感的用例（属独立工单，不在本次合并范围）。

#### 阶段 C — 实机验收

隔离沙箱（`pnpm restart:desktop:remote`）：`DESKTOP_DEV_VERDICT=ready`、`mode=isolated`、
`sandbox=dev`、`region=global`、`commit=60f2d99d04`、`pid=64216`。

日志级证据（`apps/desktop/logs/main-2026-09-11.log`）：

- **WL-11 / migration 谱系**：沙箱库已应用到 `0107_schedule-model-harness.sql`
  （`localDb.migrate.scan currentVersion=95 pendingCount=12` → 逐条应用到 `seq=107`），
  即 Meka 谱系 `0082`–`0095` 与上游追加的 `0096`–`0107` 在真实节点上串成一条链。
- **WL-9 开发插件链**：两个真实开发副本成功装载 ——
  `ghost installed { id: 'meka-dev-meka-unity-02ef16d0', version: '1.0.15' }`（20:04）
  与 `ghost installed { id: 'meka-dev-meka-p4-865543f5', version: '1.0.61' }`（20:30）。
  这是本轮 §4.7 修复（派生包必须是作者格式）之后的真实端到端证据。
- **WL-6.1 身份**：`dbPath = …\CindyMeka-dev2-dev\cindy-meka-<owner>.db` ——
  userData 用 `CindyMeka`、库文件用 `cindy-meka` 前缀，与 `brandIdentity` 一致。

**逐项结论**：WL-1…WL-14 的「自动化门禁」一栏已由本次 `pnpm test:unit`（2609 文件 / 35704
通过）+ `db:validate` + `test:runner` + 6 项 `check:*` 覆盖并通过。

GUI 项本轮**改为程序化验收**（不再靠手点）：新增 `scripts/meka-ui-smoke.mjs`
（`pnpm desktop:ui-smoke`），用 CDP 连到 dev 实例的调试端口、以**真实鼠标事件**
（`Input.dispatchMouseEvent`）驱动 UI，15 项检查全部 PASS：

| 检查 | 结果与证据 |
| --- | --- |
| WL-2.1 侧栏 Meka 入口 | ✅ 位次 `["新建","自动化","Meka","插件","伙伴","站点","搜索"]`；点击后 `#/cc-agent/meka/plugins`；`aria-current=page` 且带 `sidebar-item-active` |
| WL-2.2 折叠态入口 | ✅ rail 态仍有 `aria-label="Meka"` 按钮 |
| WL-2.3 三页签与路由 | ✅ `["插件","技能","项目"]`；`plugins→#/cc-agent/meka/plugins`、`技能→#/cc-agent/meka/skills`、`项目→#/cc-agent/meka` |
| WL-2.4 旧深链重定向 | ✅ `#/meka-plugins → #/cc-agent/meka/plugins` |
| WL-1.2 MCPRouter 配置对话框 | ✅ 点「配置」弹出 `[role=dialog]`「连接 MCPRouter」，含 url/账号/密码三输入；URL 占位符=`https://mcpr.meka.pawdy.fun/`（**HTTPS 生产默认地址**，与 `config.ts` 一致）；Esc 可关 |
| WL-1.3 MekaDesign 配置对话框 | ✅ 独立对话框「连接 MekaDesign」，含链接输入，可关 |
| WL-1.5 插件打开方式开关 | ✅ `button[role=switch]` `aria-checked false→true→false`（真实点击并还原） |
| WL-2.5+WL-3.3 段头折叠 | ✅ `aria-expanded true→false`（折叠控件 label=`收起 Meka 对话`） |
| WL-3.2 分组树 | ✅ 「Meka 助理」段存在，可见子分组 `["正式流程","普通对话"]` |
| WL-1.1 设置页签与面板 | ✅ `#settings-panel-meka-assistant` 渲染；导航位次=3/17（在「模型供应商」之后） |
| WL-1.2-1.5 面板四卡 | ✅ 插件默认打开方式 / P4 功能路径 / MCPRouter 连接 / MekaDesign 齐全；P4 已匹配 5 个 `saga2_*` 子目录 |
| WL-5.5+WL-6.1 版本行 | ✅ `Global · 0.0.0 · meka/main@51fe4c4` 与 `HEAD=51fe4c4` 一致（该检查曾正确报出「实例跑在旧 commit」并 FAIL，重启后通过） |
| WL-6.5 Beta 渠道徽标 | ✅ 可见 |
| WL-10 模型选择器（P0 回归点） | ✅ 触发器 label=`选择模型。当前：GLM 5.3 Flash，推理强度：最高`；展开后**选项数=11** |
| WL-13 五语横切 | ✅ `English→「Meka Assistant」`、`简体中文/繁体中文→「Meka 助理」`、`日本語→「Meka アシスタント」`、`한국어→「Meka 어시스턴트」`；各语言下面板均渲染且无裸 i18n key；结束切回「跟随系统」 |

**仍无法由执行者完成的实机项**（如实登记，不得记为通过）：

| 分组 | 状态 |
| --- | --- |
| WL-4.1.4 / 4.1.5 / 4.1.7 / 4.2.2 / 4.2.3 端到端 | ⏳ **未验证 —— 缺 MCPRouter 账号、实例与 Gateway key** |
| WL-6.4 签名、WL-6.5 真实更新拉取、WL-6.6 旧库只读迁移 | ⏳ **未验证 —— 需真实签名/发布授权与共享 profile** |
| 纯视觉观感（配色/间距/Light-Dark 目检） | ⏳ 未验证 —— CDP 检查断言结构与状态，不做像素判读 |
| WL-8/WL-9/WL-10/WL-11/WL-12 的自动化面 | ✅ 由 unit/db/runner 定向覆盖并通过 |

#### 阶段 D — 结论

**本次合并尚不能宣告完成**，依据（按白名单 §2 的完成判定）：

1. **🔴 阻断**：§7.1 记录的「Codex 子代理策略被上游重设计取代」是**未登记的用户可见能力移除**
   （7 个设置字段退场、默认行为翻转、fail-fast 凭据闸消失）。必须先裁决「接受并补登决策」或
   「把 Meka 策略移植回上游机制」。
2. **⚠️ 需维护者书面接受**：`pnpm test:db` 在本机因一条既有的临界超时用例（8617ms/15000ms）
   无法稳定全绿——隔离可过，tier 并行不过。
3. **⏳ 未验证**：清单中依赖人工 GUI 与外部前置的实机项（上表），需在具备条件时补齐；
   未补齐前不得声称发布就绪。

**已确认通过的部分**（可安全作为本次交付的证据）：阶段 A 结构审计（8 条豁免逐条确认）、
`test:unit`、`test:runner`、`typecheck`、`db:validate`、6 项 `check:*`、沙箱启动裁决；
WL-7 于本次复核中被移除（非业务能力）。

### 7.2 Meka 会话端到端实跑记录（2026-09-14）

§7.1 的 WL-3.2 / WL-11 当时**没有被真正执行**：`ui-smoke` 对 WL-3.2 只断言了段头与子组文案，
WL-11 全部落在「自动化面由 unit/db 覆盖」上，**从未开启过一个真实 Meka 会话**。因此本轮补做
运行期验收，并把它固化成可重复执行的工具。

**新增工具**：`scripts/meka-session-smoke.mjs`（`pnpm desktop:session-smoke`，9 项检查，
CDP 真实鼠标事件 + 真实模型轮次，交叉核对库行 / main 日志 / 技能快照）。

**实跑结果：9/9 PASS**（命令：`pnpm desktop:session-smoke`；实例先经 `pnpm restart:desktop:remote`
重启，版本行 `Global · 0.0.0 · meka/main@9dbb938` 与 `HEAD=9dbb938` 一致）

| 检查 | 证据 |
| --- | --- |
| WL-3.2 | `项目=SAGA2；新建入口=["在 SAGA2 中新建正式流程对话","在 SAGA2 中新建普通对话"]` |
| WL-11.1 | 真实重挂载后 `项目=SAGA2 默认角色=通用开发`（= 该项目 `roles[0]`） |
| WL-11.2 | 角色选项 2 个（含各自 description）；切换为「战斗开发」 |
| WL-11.3 | `session=<每次新建> workspace_kind=meka project=saga2 role=combat-development is_formal=0 workdir=C:/Workspace/saga2/saga2_project` |
| WL-11.4 | `回复="收到"`（真实模型轮次完成，`stopReason=stop`，tokens 计入） |
| WL-11.5 | 运行中会话回显 `projectId=saga2 roleId=combat-development displayName="战斗开发"` |
| WL-11.6 | `workflow=saga2-combat-development-v1 mcp=mcp-router,project-agent skillsCount=2 快照技能=combat-skill-configuration,platform-capabilities` |
| WL-11.7 | 会话在项目「SAGA2」DOM 容器内；普通「对话」分组已核对不含该行 |
| WL-11.8 | `fresh 默认=「通用开发」；切到「战斗开发」后同项目重进仍为「战斗开发」` |

**首次真机运行还暴露了 3 个「断言写法」问题（均已修，不是产品缺陷）**：

1. **陈旧实例**：首跑时实例仍是 `51fe4c4` 而 `HEAD` 已到 `9dbb938`（差一个只改
   `scripts/meka-ui-smoke.mjs` 的提交）。已把「版本行 commit 必须等于 HEAD」做成
   `session-smoke` 的**硬前置**（不一致直接退出码 2），避免拿旧代码的结论冒充 HEAD 的结论。
2. **`WL-11.7` 曾假通过**：首版用「文本包含项目名」判断侧栏归属，实际匹配到的是会话正文里的
   `projectId: saga2`。现改为 DOM 容器包含关系（`项目行.parentElement.contains(会话行)`）并
   轮询等待侧栏刷新。
3. **`WL-11.5` 不能断言模型逐字复述**：实测模型会把注入内容**按输出语言改写**
   （`displayName: 战斗开发` → `Combat Development`，中文说明句译成英文）。身份判定改为锚在
   不可翻译的 `projectId` / `roleId` 上。

**过程中被工具抓出的两个产品侧行为**（已登记，见白名单 §8.2 第 6 条）：同路径 `navigate` 不
重挂载，导致同一项目内重进「新建」入口会保留草稿已选角色（WL-11.8 显式钉住该行为）。

**角色维度对照**（同一配置、两个角色，证明角色不是装饰）：

| | `general-development` | `combat-development` |
| --- | --- | --- |
| 运行期 `workflow` | `null` | `saga2-combat-development-v1` |
| 运行期 `mcpProviderIds` | `mcp-router, project-agent, meka-design` | `mcp-router, project-agent` |
| 该会话技能快照 | 12 个（含角色声明的 3 个） | 2 个（含角色声明的 1 个） |
| `skillRevision` | `73d69fa9…` | `fd5891aa…` |

**本轮仍未验证**（同 §7.1 表，未变）：MCPRouter 端到端、真实签名与更新拉取、旧库只读迁移、
纯视觉目检；WL-11 新增未覆盖面：自定义项目/角色创建、项目删除后落「不可用」组、
`meka-formal` provider/auth/issue 全链路（需 Jira/GitLab 凭据）。

**阶段 D 结论未变**：合并仍**不能**宣告完成（阻断项见下）。

## 8. 交接状态

- **已完成**：133 个冲突全部语义解决；上述能力组与 typecheck/测试断链全部修复；
  `pnpm test:unit`（56/56 workspace）、Desktop 与 Mobile typecheck、`db:validate`、
  隔离沙箱真机启动与沙箱 migration 实跑、i18n/术语/品牌/端点/设计台账/文档契约门禁通过；
  迁移总账与协议规则文档已同步；merge 已提交（merge commit 的两个父为 `5917437271` 与 `4f03ea9a`，带 DCO 签名）。
- **未执行**：`git push`、创建 PR（均需用户单独授权）。
- **待用户决定**：§6.1 设计颜色门禁（上游红）、§6.2 guard tier（上游红）、
  §6.7 9 个历史提交的 DCO 补签（需重写历史）、D3 插件基座白名单批准、
  §6.3 中「旧 `xdmaker-meka` 只读迁移 / 深链 / 更新渠道」三条真实升级验证。
