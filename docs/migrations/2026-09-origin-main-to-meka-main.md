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
   **建议**：把 `replaceDirectory` 的重试/退避（或改成 copy 到位）作为独立上游修复跟进，
   不要依赖本机时序。本轮**未改该工具代码**（超出合并范围）。
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

## 8. 交接状态

- **已完成**：133 个冲突全部语义解决；上述能力组与 typecheck/测试断链全部修复；
  `pnpm test:unit`（56/56 workspace）、Desktop 与 Mobile typecheck、`db:validate`、
  隔离沙箱真机启动与沙箱 migration 实跑、i18n/术语/品牌/端点/设计台账/文档契约门禁通过；
  迁移总账与协议规则文档已同步；merge 已提交（merge commit 的两个父为 `5917437271` 与 `4f03ea9a`，带 DCO 签名）。
- **未执行**：`git push`、创建 PR（均需用户单独授权）。
- **待用户决定**：§6.1 设计颜色门禁（上游红）、§6.2 guard tier（上游红）、
  §6.7 9 个历史提交的 DCO 补签（需重写历史）、D3 插件基座白名单批准、
  §6.3 中「旧 `xdmaker-meka` 只读迁移 / 深链 / 更新渠道」三条真实升级验证。
