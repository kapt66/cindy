# `origin/main` → `meka/main` 同步报告（2026-09-24）

> 本轮在 `C:\Workspace\cindy`（主 worktree）把上游 `origin/main` 语义合并进 `meka/main`。
>
> | 项 | 值 |
> | --- | --- |
> | 目标分支 | `meka/main`（合并前 `09e8bb613247d03478cba2b58170d2d48e9e48e8`） |
> | 来源 | `origin/main` = `2f169d6aeb4428ab57020cf925e10a3a80414391` |
> | merge-base | `0f65d982317d81f979d0c4de4b66606c21c8bc60`（= 上一轮同步 `2026-09-18` 带上来的上游提交） |
> | 规模 | 上游独有 **476** 提交 / 1016 新增路径；Meka 独有 **164** 提交 |
> | Git 冲突 | **65** 路径（62 `UU` + 3 `AA`） |
> | 上游删除 | **22** 路径（Git 干净接纳，逐条核对无悬挂引用，见 §4.3） |
> | 上游新增文件缺失 | **0**（唯一 5 条为 D4 有意改号，见 §4.2） |
> | merge 状态 | 见 §8 交付状态 |
> | push / PR | **未 push、未创建 PR**（需用户单独授权） |

**命名说明**：白名单清单 §2 给的模板是 `docs/migrations/<年>-<月>-origin-main-to-meka-main.md`；
2026-09 已有 `2026-09-origin-main-to-meka-main.md`（第一轮，09-10）与
`2026-09-18-origin-main-to-meka-main.md`（第二轮），故本期用带日期的
`2026-09-24-...` 区分。

## 1. 范围与基线

- 工作区：`C:\Workspace\cindy`（主 worktree，分支 `meka/main`），merge 前 `git status`
  **干净**（仅有上一轮遗留的未跟踪工作目录 `_analysis/`，与上游无路径交集，
  上游 `origin/main` 不含任何 `_analysis/**`，已在 merge 前确认）。
- 只处理客户端仓；未修改服务端仓库、未修改已发布 migration、未执行任何破坏性 Git 命令、
  未使用 `-X ours` / `-X theirs` 或同类全局策略。
- 三方证据一律取 index stage：`git show :1:`（merge-base）/`:2:`（ours=meka/main）/
  `:3:`（theirs=origin/main）；`AA` 冲突按阶段可用性取用。

## 2. 执行方式

本轮由一个调度／管理／审查者统一负责，实际执行分派给**按能力组切分的并行子代理**，
遵循 `cindy-meka-upstream-sync` skill 的波次要求，并遵守 `docs/dev-rules/development-workflow.md`
§6「门禁时机」：**迭代期不跑门禁，交付时一次性跑完**。

| 组 | 范围 | 波次 |
| --- | --- | --- |
| GOV | 治理规则文本（`AGENTS.md`、`design-inventory.md`、`credentials-and-local-storage.md`） | 0 |
| DB | 数据库谱系（drizzle journal / snapshot / 迁移编号顺移）与 DB 相邻 main | 1 → 6 |
| UPD | 更新器／打包／安装身份（`updateService`、`forge.config`、installer、`cindy-updater`） | 1 → 2 → 6 |
| AUTH | 身份与区域（`authManager`、`bootstrap-electron`、`UserInfoSection`） | 1 |
| DBCORE | DB 相邻 main（`localDb` registerAll/sessions/mapper + 测试） | 1 |
| ORCA | Agent／Orca／MCPRouter（`maker-host/index`、`maker-ipc/*`） | 1 → 3 |
| CORE | `maker-core` 基线 agent 与 Pi harness | 1 → 3 |
| PLUGIN-MAIN | 插件与技能（main 侧：`cindy-brain`、`plugin-market`、`skillhub`） | 3 |
| PLUGIN-UI | 插件与技能（Renderer 侧：plugin / skillhub 视图 + `MarketCard`） | 3 |
| RENDER | Renderer 设置／侧栏／会话头／模型可见性 | 4 |
| I18N | 五语 `common.json` | 4 |
| BUILD | 构建与工具链（根 `package.json`、`scripts/*`、`vitest.config.ts`） | 2 → 3 → 6 |
| MISC | 其余普通实现（`agent-island`、`anthropic-compat-proxy`、`file-browser-core`、`session-share` 测试） | 2 |

**并发约束**：所有 index 写入（`git add`）与提交由调度者统一执行；子代理只允许读 git
与编辑文件，禁止 `git add` / `git commit` / `git stash` / `git checkout` / `git reset` /
`git merge` / `git clean`，避免并行写 index 互相破坏。

## 3. 冲突清册与分类

Git 报告 65 个冲突路径。分类（由
`cindy-meka-upstream-sync/scripts/classify-conflicts.ps1` 输出）：

- 文件角色：产品代码 18、UI 代码 14、测试 12、本地化 5、其他 4、数据库生成物 3、
  治理规则 3、自动化脚本 3、构建配置 2、文档 1。
- 产品域：普通实现 16、插件与技能 13、Agent/MCP/Orca 8、数据库 7、Renderer 设计 7、
  国际化 5、更新与发布 4、治理文档 3、身份/区域/数据 1、Electron 边界 1。
- 波次：第 0 波 3、第 1 波 13、第 2 波 12、第 3 波 21、第 4 波 12、第 6 波 4。

**三方阶段检查**（`git ls-files -u`）：62 个 `1,2,3` 真实三向冲突 + 3 个 `AA`
（`0110`–`0112` drizzle snapshot，双方各自新增同号文件，见 §4.1）。
**没有**「一侧未改」的伪冲突 —— 每个冲突都需要语义判断。

## 4. 结构层面的静默丢失审计（Git 不报的那些）

> 这是白名单清单 §1 点名的失败形态：冲突清单不是完整迁移范围。

### 4.1 数据库谱系：同号双方新增（3 个 `AA`）+ journal 自动合并成非法状态（P0 形态）

**现象**：merge 后 `apps/desktop/drizzle/` 同时出现 Meka 的 `0110_sudden_ultron` /
`0111_lowly_scarlet_witch` / `0112_deep_wolfpack` 与上游的 `0110_abandoned_scarlet_witch` /
`0111_messy_newton_destine` / `0112_backfill_task_tag_order` / `0113_grey_cannonball` /
`0114_shared_task_events`；`meta/_journal.json` **无冲突标记但被自动合并成重复 idx**
（`110,111,112,110,111,112,113,114`）。若不处理，`db:validate` 与运行期迁移都会失败。

**编号事实（逐字节比对得出，不是按名字猜的）**：

| 事实 | 证据 |
| --- | --- |
| Meka 已发布谱系为 `0000..0112`，其中 `0082`–`0088` 为 Meka 迁仓谱系槽（`.sql` 为 `SELECT 1;` + 部分带 runtime script），`0089`–`0092` 为 Meka 真实 SQL，`0093..0112` 为上游内容 | 内容哈希比对：`MEKA 0106_bot_mode == BASE 0103_bot_mode`、`MEKA 0110_sudden_ultron == BASE 0107_sudden_ultron`、`MEKA 0112_deep_wolfpack == BASE 0109_deep_wolfpack`（逐字节相同） |
| 上游 `0107..0109` 早已以 Meka `0110..0112` 的身份存在于 `meka/main` | 同上 |
| 上游本轮**真正新增**的是 `0110..0114`（5 条） | `0110 session_task_tags` / `0111 task_tags.sort_order` / `0112 task_tags 回填` / `0113 task_tags.name_customized` / `0114 shared_task_events` 在 merge-base 中不存在 |
| Meka 已发布谱系不得改号（append-only） | `docs/dev-rules/database-and-migrations.md`「Append-only 不变量」 |

**处置（D4：冻结 Meka 编号、上游顺移追加）**：

1. 恢复 `meta/_journal.json` 与 `0110..0112_snapshot.json` 为 `meka/main` 版本，
   使冻结段 `0000..0112`（SQL + companion + journal + snapshot）与 `meka/main` 逐字节一致。
2. 删除上游原号的 5 个 `.sql`，以 Meka 号 `0113..0117` 重建，**SQL 正文取上游逐字节内容**
   （无新增 companion；上游这 5 条本身也没有 companion）。
3. `meta/0113..0117_snapshot.json` 由上游同序号 snapshot 经 **Meka delta 变换**得到。
   delta 由 `MEKA 0112` 与 `UP 0109` 的结构化比对推出，**是纯增量**：
   - 新增表 `meka_projects`、`meka_roles`；
   - `sessions` 新增 10 列（`meka_role`/`meka_target_json`/`meka_project_id`/`meka_role_id`/
     `is_formal`/`formal_type`/`formal_link`/`formal_ref`/`formal_content_json`/
     `capability_snapshot_json`）+ 2 索引（`idx_sessions_meka_project_id`/
     `idx_sessions_meka_role_id`）+ 1 外键（`sessions_meka_role_id_meka_roles_id_fk`）；
   - `_meta` 无差异；`views` 无差异。
   变换脚本对每个目标快照**断言**「`sessions` 去掉 Meka 增量后与上游 `0109` 的 `sessions`
   规范化后相等」，不成立即拒绝写入（防止把 delta 硬套到形态不同的快照上）。
4. snapshot 链 `id`/`prevId` 重连：`0112.id → 0113.prevId → … → 0117`。

**验证（实跑，三重）**：

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 静态完整性 + 冻结 | `pnpm --filter desktop db:validate` | ✅ 6/6 步全过：`0000..0117` 118 个 SQL、journal/snapshot 全对齐、`drizzle-kit check` 通过、44 个 companion 均 CommonJS、固定基线 80 条 SQL + 23 脚本、canonical 基线 113 条 SQL + 44 脚本（= Meka `0000..0112` 未被改写） |
| **无残留 schema drift** | `pnpm --filter desktop exec drizzle-kit generate` | ✅ `No schema changes, nothing to migrate` —— 证明 **`0117_snapshot.json` 与合并后的 `schema.ts` 完全一致**，且 Meka 谱系不需要任何额外迁移 |
| 生成物计数 | `dir` 计数 | ✅ 118 SQL / 118 snapshot / 118 journal entries |

**结论**：上游 `0110..0114` 的 schema 意图已完整、逐字节地进入 Meka 谱系 `0113..0117`；
Meka 已发布编号未被改写；无手写伪造元数据（snapshot 由 delta 变换 + drizzle 自身校验双重确认）。

### 4.2 上游新增文件的整体存在性（1016 条）

对 `git diff --name-only --diff-filter=A <merge-base>..origin/main` 的 1016 个路径逐个检查
工作区存在性：

- 唯一「不存在」的 5 个正是 §4.1 有意改号的上游 `0110..0114`（内容已按 Meka 号落盘）。
- **其余 1011 条全部存在**，且其中**没有任何一条同时被 Meka 侧改动过**
  （即不存在 modify/delete 被静默接受的风险）。

### 4.3 上游删除（22 条）的逐条确认

Git 干净接纳、按上游删除处理；逐条核对**全仓无悬挂引用**（`grep` 覆盖
`apps/desktop/src`、`packages/*/src`）：

| 上游删除的路径 | 性质 | 悬挂引用核对 |
| --- | --- | --- |
| `main/updateLockWait.ts`（+ 测试） | 上游更新等待机制重构 | 无引用 |
| `main/localDb/codexHistoryOversizedUpgrade.ts`（+ 测试） | 上游把 codex 历史超限修复并入别处 | 无引用 |
| `main/maker-host/claude-credentials-blob.ts`、`claude-credentials-store.ts`、`claude-oauth-login.ts`、`claude-oauth-refresh.ts`、`claude-oauth-spawn-env.ts`（+ 4 个测试） | 上游把 Claude OAuth 凭证链路整体搬迁 | 无引用（残留的 `claudeSubscriptionUsage*` 命中全部指向仍存在的 `src/shared/claudeSubscriptionUsage.ts` 与 `usage/usageHistory.ts` 的 `claudeSubscriptionUsageModelKey`） |
| `main/usage/claudeSubscriptionUsage.ts`、`claudeSubscriptionUsageRefresh.ts`（+ 2 个测试） | 上游把 main 侧实现搬到 `src/shared/` | 无引用（消费方均 import `shared/claudeSubscriptionUsage`） |
| `main/workdir-probe-host/WorkdirProbeHostClient.ts`、`workdirProbeHostProcess.ts`（+ 2 个测试） | 上游 workdir 探针架构重构 | 无引用；残留命中是 `WorkdirProbeHostPackaging.test.ts` 断言 forge **不含** `workdir-probeHostProcess.ts`（断言仍然成立） |
| `renderer/components/settings/SettingsSegmentedControl.tsx` | 上游设置控件重构 | 无引用 |

### 4.4 「两侧都改过、但 Git 自动合并成功」的全量审计

`git diff --name-only <merge-base>..origin/main` 与 `...HEAD` 的交集为 **182** 个路径，
其中 64 个是冲突路径，**118 个是「两侧都改过却无冲突标记」**——这正是上一轮两起 P0
的形态所在。

对其中的 **116** 个（跳过 2 个生成物/二进制：`pnpm-lock.yaml`、drizzle meta）做了
**行集合包含性比对**（三方 `git show` + 工作区归一化行多重集）：

- 多重集口径初判 3 个「缺失候选」，逐条复核后**全部证伪**为计数伪影：

| 路径 | 初判 | 复核结论 |
| --- | --- | --- |
| `main/maker-host/__tests__/codexProxyHost.test.ts` | 缺 1 行 `await new Promise…upstream.listen…` | 该行是 Meka 有意改写点（Meka 用 `listenOnFetchSafePort(upstream)` 替代手写 `listen`）。上游新增的 **9 个 `it` 标题、19 个声明全部存在**；上游新增行「整行不存在」数 = **0** |
| `main/plugin-market/__tests__/download.test.ts` | 缺 1 行 `target(),` | 上游新增 **10 个 `it`、1 个 import、7 个声明全部存在**；上游新增行整行缺失 = **0**。差异来自 Meka 自己的新增用例用 `const file = target()` 而非 `target()` 作实参 |
| `packages/maker-core/src/agents/codex/index.test.ts` | 缺 2 行 `cwd: '/repo',` | 上游新增 **29 个 `it`、4 个 import、33 个声明全部存在**；上游新增行整行缺失 = **0** |

- 复核方法：不按「行出现次数」推断（同一字面行两侧新增条数不同即误报），改为
  取上游相对基线**新增的标识性内容**（`describe`/`it` 标题、import 符号名、
  函数/常量/类型声明名）逐个做**存在性**检查，并额外统计「上游新增且在工作区整行
  不存在」的行数。
- **结论：自动合并面上「上游新增内容被静默丢弃」= 0。**

### 4.5 需要重新生成的生成物

| 生成物 | 处理 |
| --- | --- |
| `apps/desktop/drizzle/meta/*` + `drizzle/*.sql` | 已按 §4.1 处置并三重验证 |
| `pnpm-lock.yaml` | **已由 `pnpm install` 重建**（交付门禁实跑阶段执行；未手解）。重建后与 Git 自动合并结果一致，二跑 `pnpm install` 无新变更 |
| `docs/design-rules/design-inventory.md` | 由 `pnpm check:design-inventory` 校验；如需重新生成由调度者在交付门禁阶段处理 |

## 5. 迁移能力审计（`cindy-meka-upstream-sync` 模板）

### 5.1 能力清单

| ID | 能力 | Meka 不变量 | 上游对应能力 | 关系 | 共享底层 | Meka 专属投影 | 责任代码与测试 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `CAP-IDENTITY` | 产品与安装身份 | `CindyMeka` 目录 / `cindy-meka` 协议与渠道 / 同一 `appId` | `brandIdentity` 单点 | `适配接纳` | `packages/maker-shared/src/brandIdentity.ts` | Meka 字面值与发布渠道 | WL-6.1/6.3/6.4/6.5/6.7 | 已解决 |
| `CAP-REGION` | 区域与运行期 edition | 运行期可切区；安装身份不随 edition 变 | 构建期区域 + 端点清单 | `保留例外`（WL-5.6） | `shared/brandRegion.ts`、`endpoints` | 运行期 edition override + SSO 跨区确认 | WL-5 全节 | 已解决（有意保留分歧） |
| `CAP-LEGACY` | 旧 `xdmaker-meka` 数据只读迁移 | 只读、目标缺失才写、不删源 | 无 | `Meka 专属` | `legacyUserDataMigration.ts` | 迁移清单与深链解析 | WL-1.9 / WL-6.6 | 已解决 |
| `CAP-DBLINEAGE` | 数据库谱系冻结 | Meka `0000..0112` 不可改号 | 上游 append-only | `共享`（同一机制） | `drizzle-kit` + `db:validate` | Meka 谱系槽与顺移追加 | §4.1 | 已解决 |
| `CAP-MEKASESSION` | `'meka'` 会话一级分类 | `workspaceKind==='meka'` 与 `mekaProjectId`/`mekaRoleId` 双向绑定；不进 IM/scheduler | 普通 project/dialogue 分类 | `保留例外` | `localDb` schema/tx、侧栏派生 | Meka 段、角色 scope、软引用 | WL-3 全节 / WL-11 / WL-12 | 已解决（有意保留分歧） |
| `CAP-MCPR` | MCPRouter 远程会话 | `mcpr:` 与 SSH 是不同 transport，分类先于 transport 动作 | 上游 SSH/cc-manager 链路 | `适配接纳` | `remote-session-routing.ts`、`cc-manager-client.ts` | Meka worker 目标解析与战斗 Lead 通路 | WL-4 全节 | 已解决（有意保留分歧） |
| `CAP-MEKAPLUGIN` | Meka 插件链 | 市场渠道 + 开发目录模式；存量插件向下兼容 | 上游插件基座（批准/指纹/manifest） | `平行`（渠道身份隔离） | `cindy-brain`、`plugin-market` | Meka 渠道与开发目录 | WL-9 / `plugin-security-and-authoring.md` | 待验证 |
| `CAP-MEKASKILL` | Meka 技能链 | 技能入口 / 标准包兼容 / MCPRouter 分发 / 安装来源 | 上游 skillhub | `适配接纳` | `skillhub/installService.ts` | Meka 市场视图模型与项目角色关系 | WL-8 | 已解决 |
| `CAP-SETTINGS` | 设置页 Meka 分区 | 独立页签、位次固定、`meka-assistant-settings.json` 字段级共存 | 上游 settings 结构 | `Meka 专属` | `SettingsView.tsx`、`tabLabels.ts` | Meka 助理分区 | WL-1 全节 | 已解决（有意保留分歧） |
| `CAP-SIDEBAR` | 侧栏 Meka 入口与会话分类 | `mekaRow` + rail 图标 + 互斥取数 + 位次 | 上游 `botsRow` / `projectsRow` | `并集` | `SidebarTopNav.tsx`、`CCAgentSidebarUpper.tsx` | Meka 段与三页签管理页 | WL-2 / WL-3 | 已解决 |
| `CAP-MODELVIS` | 模型可见性 | 老用户可见性偏好不得被清空 | 上游可见性决策函数 | `适配接纳` | `modelVisibilityPrefs` | Meka 未启用沉底 | WL-10 | 已解决（有意保留分歧） |
| `CAP-MEKAINJECT` | Meka 注入层与角色技能载体 | 分段顺序、能力矩阵、非 argv 技能载体 | 上游 Pi/Codex 注入面 | `保留例外` | `meka-injection/**`、`maker-core` | 角色级 MCP/技能落地 | WL-15 / WL-16 / WL-18 | 已解决（有意保留分歧） |
| `CAP-PI` | Pi 原生能力非退化 | Cindy 不得让 Pi 比原生更难用 | 上游 Pi harness | `共享` | `pi/**`、`pi-host.ts` | 只加可跳过提示与 GUI | `pi-harness.md` | 已解决 |
| `CAP-UPDATER` | 自动更新链路 | Meka 渠道身份与根地址 | 上游更新器重构 | `适配接纳` | `updateService.ts`、`cindy-updater` | Meka 渠道身份 | WL-6.5 | 已解决（有意保留分歧） |

**状态列取值口径（本轮，2026-09-24）**：

- `已解决`：该能力的冲突与上游变化已按上游当前架构收敛；纯 Meka 专属且上游无对应面的能力同样记此值。
- `已解决（有意保留分歧）`：该能力本身是对上游语义的刻意例外（「关系」列为 `保留例外` / `平行` / `Meka 专属`），
  或本轮上游确有对应变化、但按已登记的 Meka 不变量保留差异（差异逐条写在 §5.2 与 §6）。
- `待验证`：仍依赖本轮未完成的交付项（**插件基座白名单放行门**），**不得**宣告收敛。
  （`pnpm-lock.yaml` 重建原属本条理由，已在交付门禁实跑中完成，见 §7.1 与 §8 第 1 条，不再是待验证原因。）
- **本列只表示「冲突与语义收敛」状态，不表示「已验证」。** 能力级语义验收（WL-1…WL-18）、门禁与实机结果
  一律由调度者在 §7 登记；本报告全文不使用「已验证」表述。

### 5.2 上游变化审计

> 口径：**Git 冲突清单不是完整迁移范围**。下表除 65 个冲突路径外，还登记「无冲突标记但两侧都改过」
> 与「上游删除 / 上游新增」面上的实质变化。`接纳方式` 取值 `接纳` / `适配接纳` / `保留例外` / `退役`
> 与 root `AGENTS.md`、`cindy-meka-upstream-sync` skill 的口径一致。
> `验证` 列只写**本轮实际做过**的检查；标注「代码级证据」「静态核对」的条目**没有**实跑测试，
> 不得据此宣称已验收（语义验收见 §7）。

| ID | 上游提交 / 行为 | 能力 ID | 受影响路径 | 接纳方式 | Meka 动作 | 兼容 / 风险门 | 决定人 | 验证 | 文档 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| UP-01 | 上游本轮新增 5 条 migration：`0110_abandoned_scarlet_witch`（建 `session_task_tags`）、`0111_messy_newton_destine`（`task_tags` 加 `sort_order`）、`0112_backfill_task_tag_order`（纯回填）、`0113_grey_cannonball`（`task_tags` 加 `name_customized`）、`0114_shared_task_events`（建 `shared_task_events`） | `CAP-DBLINEAGE` | `apps/desktop/drizzle/*.sql`、`drizzle/meta/*_snapshot.json`、`meta/_journal.json` | 适配接纳（D4 顺移追加） | 恢复冻结段 `0000..0112`；删上游原号 5 个 `.sql`，以 Meka 号 `0113..0117` 重建（SQL 正文逐字节取上游，无新增 companion）；`meta/0113..0117_snapshot.json` 由上游同序号 snapshot 经 Meka delta 变换（变换脚本断言「`sessions` 去掉 Meka 增量后与上游 `0109` 规范化相等」）；journal 追加 idx 113–117；snapshot 链 `id/prevId` 重连 | 已发布编号 append-only，禁止改号与手改 snapshot；固定基线计数必须仍为 80 条 SQL + 23 脚本、canonical 113 条 SQL + 44 脚本 | 调度者（D4） | **实跑**：`pnpm --filter desktop db:validate` **6/6 步全过**；`pnpm --filter desktop exec drizzle-kit generate` → `No schema changes, nothing to migrate` | §4.1；总账 §5、§11.29 | 已解决 |
| UP-02 | 上游新增 `task_tags` / `session_task_tags` 数据面与 `mapper.ts` 的 `source: 'cindy-make-merge'` | `CAP-MEKASESSION` | `main/localDb/ipc/registerAll.ts`、`main/localDb/mapper.ts`、`main/localDb/ipc/sessions.ts`、`main/localDb/__tests__/DbClient.inproc.test.ts` | 适配接纳 | `registerAll.ts` 并集（上游 `registerTaskTagsIpc()` + Meka 5 个 `registerMeka*Ipc()`）；`mapper.ts` 并集（上游 `source` + Meka 5 字段）；`sessions.ts` 两处分别判（Meka `validatedCreateBody` **且**保留上游新增 `const gitSafety`；`recentWorkdirs` 判据并集为 `(project \|\| meka) && … && isRetainableProjectSession`）；`DbClient.inproc.test.ts` 并集（Meka 真实 `0000_init.sql` fixture + 上游 `task_tags`/`session_task_tags`） | `'meka'` 契约复查：4 个声明点全含 `'meka'`，新发现漏点 = **0**；未发现上游引入的降级或漏分类路径 | 调度者（DBCORE 组） | 契约静态复查（4 个声明点）；本轮**未跑** `DbClient.inproc.test.ts` | §6「DBCORE」 | 已解决 |
| UP-03 | 上游 `340888c77d` 新增 SSH-only 探针 `readSshCodexModelList` | `CAP-MCPR` | `main/maker-ipc/register.ts`（`:6937`、`:11418`、`:16797`）、`main/maker-host/index.ts`、`main/remote-ssh/codex-model-list.ts` | 适配接纳 + **Meka 修复** | 三个 `mcpr:` 可达调用点统一加 `classifyRemoteSessionTransport(...) === 'ssh'` 前置（`assertModelRouteUsable`、`getProviderRoutingContext` 的 dep、`SET_MODEL` 的 `sshCodexProviders`） | **本轮高危发现**：该探针是 SSH-only（失败即折叠成 `SSH_EXEC_FAILED`），漏按 transport 分类会让 MCPRouter Codex 的**会话创建 / 改模型 / Orca 远端 worker 创建全部硬失败**；WL-4.1.2 四条路径共用一个漏斗 | 调度者（ORCA 组） | 代码级证据（三处同一判据，`grep` 复核 `register.ts:6937,11418,16797`）；本轮**未跑** ORCA 定向套件 | §6「ORCA」；`docs/dev-rules/mcpr-remote-session-routing.md` | 已解决 |
| UP-04 | 共享下载器缺省上限从 8 MiB 提到 128 MiB（`packages/plugin-protocol/src/memberUpload.ts:24`） | `CAP-MEKAPLUGIN` | `packages/plugin-protocol/src/memberUpload.ts`、`main/plugin-market/mekaDownloadPolicy.ts`、`main/plugin-market/registerIpc.ts`、`main/plugin-market/__tests__/download.test.ts` | 适配接纳 | 按 `plugin-security-and-authoring.md` §4.2 改回**显式注入**：`MEKA_PLUGIN_MAX_DOWNLOAD_BYTES` = 8 MiB（普通）/ `MEKA_NODE_PLUGIN_MAX_DOWNLOAD_BYTES` = 128 MiB（node），`resolveMekaPluginMaxDownloadBytes` 总是返回数值（不再返回 `undefined` 交给缺省）；删掉与上游新语义互斥的 `keeps the default 8 MiB ceiling before starting a download` 用例 | **静默放宽是安全口径回归**：Meka 侧「普通插件返回 `undefined` 交给缺省」的前提失效 ⇒ 普通 Meka 插件下载上限被静默抬到 128 MiB；显式注入后普通/node 两档与规则正文一致 | 调度者（PLUGIN-MAIN 组） | 定向：`download.test.ts`（上游自己的 `accepts a package above the former 8 MiB market limit` 覆盖新缺省）；`mekaDownloadPolicy.test.ts` 断言 `MEKA_PLUGIN_MAX_DOWNLOAD_BYTES === MAX_BASIC_CINDY_FILE_BYTES` | §6「PLUGIN-MAIN」；`docs/dev-rules/plugin-security-and-authoring.md` §4.2 | 已解决 |
| UP-05 | 上游 `5b10e9babc` 把 #4502 的 Windows 热更机制**整体回退** | `CAP-UPDATER` | `cindy-updater/src-tauri/src/installer.rs`、`Cargo.toml`、`installer.nsh`、`installer-directory.nsh`、`forge.config.ts`、`scripts/package-desktop.mjs`、`main/updateService.ts`（+ 测试） | **保留例外**（用户裁决方案 A：完整接纳上游回退，只保留 2 项 Meka 投影） | `installer.rs` 取上游 + 投影回 `notify_shell_associations_changed()`（`SHChangeNotify` Shell 刷新）与 `validate_extracted_main_executable()`（热更包结构校验）= 上游 1217 行 + 161 行 / 0 删除；`Cargo.toml` 取上游（删 `sha2` 与 5 个 windows-sys feature）；两个 NSIS include 取上游 `${BUILD_RESOURCES_DIR}` 形态；`forge.config.ts` 8 处冲突 6 取 Meka / 2 取上游；`package-desktop.mjs` 并集（保 Meka `--no-sign`，同时删 `CINDY_WIN_SIGN_CMD` 与 `NPKG_TOKEN`）；`updateService.ts` 并集；`updateService.test.ts` 保留 **24 条 Meka 不变量断言**（18 条预算封顶 + 6 条结论码/渠道）+ 7 条上游新增用例，删 10 条断言已删机制的用例，**并把上游新用例里写死的 `resources/cindy-updater.exe` 改成 `BRAND_IDENTITY.updaterName`**（否则 Meka 落点 `cindy-meka-updater.exe` 必然失败） | 随上游删除：`InstallDirIdentity`/`capture_install_dir_identity`/`install_dir_identity_unchanged`/`copy_tree_into_pinned`/`pinned_join`、`.updating` 独占锁 `acquire_update_lock`、High-IL staging ACL、`InstallerFailure`、`--zip-sha256`/`--install-writable`；**仅保留** Shell 刷新与热更包结构校验两项。`cindy-updater` 链路改动仍需维护者确认；总账 §6.59 的「不整体回退」表述已被本轮取代 | 用户（方案 A 裁决） | 定向：`updateService.test.ts` **107/107**；三个 NSIS include 规则测试 **8/8** | §6「UPD」；总账 §6.59 后续修订、§11.29；`docs/dev-rules/cindy-updater.md` | 已解决 |
| UP-06 | 上游把 `SkillhubMarketPreviewPanel` 重命名为 `SkillhubMarketDetailView` | `CAP-MEKASKILL` | `renderer/features/skillhub/**`（2 个 Meka 视图 + 3 个测试的 `vi.mock`） | 适配接纳 | 收尾上游重命名留下的 **7 处悬挂引用**（Meka 侧旧名引用全部改到新名） | 漏改即 Meka 技能市场页与相关测试整片失败；`design-inventory.md` 同一批重生成 | 调度者（PLUGIN-UI 组，经调度者授权） | 定向：`PluginManagementLayout.test.tsx` **21/21**、`MekaSkillMarketListView.test.tsx` **2/2** | §6「PLUGIN-UI」 | 已解决 |
| UP-07 | 五语 `common.json` 的上游新增 / 删除 key | 横切（WL-14 文案与 i18n） | `renderer/i18n/locales/{zh-CN,zh-TW,en,ja,ko}/common.json` | 接纳（按 key 并集） | 按 key 三方合并；上游新增全接、上游删的 7 条接受；Meka 取值的 41 处保留（其中 2 条**必须**取 Meka） | 合并后 en **11196** / 其余四语各 **11177** 叶子 key（I18N 组口径；`check:i18n` 的公共 key 集口径为 11101，见 §7.2）；相对 `meka/main` +779 / +777 −7；相对 `origin/main` +574 −1；**真冲突 0 条**（`bothChangedDiff = 0`）；Meka 命名空间五语 0 缺失（`meka.*` 198、`mekaSkills.*` 84、`settings.meka.*` 71、`settings.tabs.mekaAssistant` 1、`settings.ghosts.meka.*` 56）；必须取 Meka 的两条：`localDbFatal.*` 的 `{{appName}}`、`logic.errors.hostShellCommandBlocked`（均有仓内测试钉住） | 调度者（I18N 组） | 计数与三方差值核对（`bothChangedDiff = 0`）；`pnpm check:i18n` **已跑：五语共 11101 个 key 全部一致，exit 0**（§7.2）；`creditParity*` 死文案删除后 11103 → 11101（§6.15 第 3 条） | §6「I18N」 | 已解决 |
| UP-08 | 上游改动构建 / 工具链（根 `package.json`、`scripts/*`） | 横切（构建与测试调度） | `package.json`、`scripts/ensure-agent-binaries.mjs`、`scripts/restart-desktop-remote.mjs`、两个脚本测试 | 接纳（并集） | `scripts.test:runner` 取 Meka 的 40 个测试文件 + 上游追加 `&& node apps/desktop/scripts/check-windows-atomic-rename.mjs`；`ensure-agent-binaries.mjs` 并集（上游 `tryReuseDirDistFromSiblingWorktree` + Meka `codex-single` / `planEnsurePlatformFailure` / `ENSURE_FAILURE_ACTIONS`）；`restart-desktop-remote.mjs` 并集（上游 `XDT_CINDY_MAKE_TEST` 透传 + Meka 身份/区域/沙箱不变量） | 两侧都改了 workspace manifest，且根 `patchedDependencies` 新增 `@expo/cli@57.0.25` ⇒ **`pnpm-lock.yaml` 必须重建**（`patch_hash` 只能由 pnpm 重算），**不得手解** | 调度者（BUILD 组） | `dependencies` / `devDependencies` / `pnpm.overrides` 三方逐字一致（静态）；**lockfile 已由 `pnpm install` 重建**（§7.1） | §4.5、§6「BUILD」、§8 | 已解决 |
| UP-09 | 上游 `apps/desktop/vitest.config.ts` 增加 Windows 超时档 | 横切（测试调度） | `apps/desktop/vitest.config.ts` | 接纳（并集） | 并集：`testTimeout: process.platform === 'win32' ? 60_000 : 5_000` 与 `hookTimeout: process.platform === 'win32' ? 60_000 : 10_000`（`:87-88`），保留 Meka 的实测注释 | 不改 tier 归属与测试选择，只抬 Windows 上的超时预算，用于抑制并行负载下的假失败 | 调度者（BUILD 组） | 静态并集核对（`vitest.config.ts:87-88`） | §6「BUILD」 | 已解决 |
| UP-10 | 上游治理文本改动（`AGENTS.md`、`design-inventory.md`、`credentials-and-local-storage.md`） | 横切（GOV） | `AGENTS.md`、`docs/design-rules/design-inventory.md`、`docs/dev-rules/credentials-and-local-storage.md` | 适配接纳 | `AGENTS.md` 并集（上游 `shared-task-mode.md` 索引 + Meka `meka-skills.md` 索引都留；45 条索引引用路径全部存在）；`design-inventory.md` 取上游基底 + 补回 4 个 `desktop.meka.*` surface 与 Meka 路由/重定向行（surface 51 → 55）；`credentials-and-local-storage.md` 取上游 + 保留 3 条 Meka 条目（运行期切区、`CindyMeka Safe Storage`、MCPRouter 凭证脱敏） | **关键核对**：上游本轮**没改** `AGENTS.md` 的「提交前测试门禁」措辞与「门禁时机」段落（上游 `:3:` 没有「文档同步」「审查与问题范围」两节）⇒ 保留 Meka 措辞；`scripts/test-related.mjs` 的 `GIT_BASE_REFS = ["origin/meka/main","meka/main","origin/main"]` 与 Meka 措辞一致 | 调度者（GOV 组） | 45 条索引引用路径存在性核对；`design-inventory` GENERATED 区重生成（校验 `pnpm check:design-inventory` 由调度者门禁统一跑） | §6「GOV」；总账 §4.6、§11.29 | 已解决 |
| UP-11 | 上游身份与凭证链路变化（登录 realm、凭证库健康守卫） | `CAP-REGION`、`CAP-IDENTITY` | `main/maker-host/authManager.ts`、`main/bootstrap-electron.ts`、`renderer/.../UserInfoSection.tsx`、`userInfoSectionUpdateFlame.test.tsx` | 适配接纳 | `authManager.ts` 并集（上游凭证库健康守卫放回上游原位置 + Meka `select-realm`；该错误态选择器不可达，两种顺序等价）；`bootstrap-electron.ts` 取上游（含 Meka 每一步的 `finishXaiLogin`）；`UserInfoSection.tsx` import 并集；测试并集 | WL-5.4 五条不变量与 `PRODUCT_EDITION_KEY`（声明 `:211` + 4 处引用：读 / 写 / 登出清 / relogin 清）齐备；上一轮「只剩引用」的形态本轮**未复现** | 调度者（AUTH 组） | 定向：4 个文件 **37 / 6 / 25 / 11** 全过 | §6「AUTH」 | 已解决 |
| UP-12 | 上游 `base-agent.ts` 的 7 处 additive 与 `cindyBridgeSource.test.ts` 的 library 映射套件 | `CAP-PI`、`CAP-MEKAINJECT` | `packages/maker-core/src/agents/base-agent.ts`、`.../__tests__/cindyBridgeSource.test.ts`、`.../pi/__tests__/project-resource-cli.test.ts` | 接纳（并集） | `base-agent.ts` 并集（上游 7 处 additive 全接，Meka 扩展保留）；`cindyBridgeSource.test.ts` 并集（Meka vm 执行式套件 8 it + 上游 library 映射套件）；`project-resource-cli.test.ts` 取 Meka（两侧同一语义改动，Meka 版多 4 行注释） | Pi 原生能力非退化红线；Meka 注入层分段顺序与能力矩阵不因 additive 变更改变；`engineering-conventions.md` §4「测试里造目录符号链接必须按平台分派」 | 调度者（CORE 组） | 定向：`cindyBridgeSource.test.ts` **47 passed / 4 skipped** | §6「CORE」；`docs/dev-rules/pi-harness.md`、`meka-injection-layer.md` | 已解决 |
| UP-13 | 上游插件基座变化（含 `b8b90eb536` 新增 remote 私有 setup 卡 / 设备码） | `CAP-MEKAPLUGIN` | `main/cindy-brain/**`、`main/plugin-market/**`、`packages/plugin-protocol/**` | 接纳（并集） | 5 个 main 侧文件全并集 | **存量插件兼容结论**：本轮**未改**批准状态 schema（`RECEIPT_SCHEMA_VERSION = 2` 未动）、**未改**指纹格式（`cindy-ghost-content-v2` 未动）、**未改**安装布局 / 包格式（尺寸常量数值不变）；`validateGhostManifest` 仅放宽（新增 `ok:false` 拒绝点 = 0）⇒ **无 P0、无需新增迁移**。上游新增的 remote 私有 setup 卡 / 设备码属插件基座**新面**，仍需白名单放行门 | 调度者（PLUGIN-MAIN 组） | 契约静态核对（schema / 指纹常量 / 尺寸常量 / 拒绝点计数）；白名单放行门待 §7 | §6「PLUGIN-MAIN」；`docs/dev-rules/plugin-security-and-authoring.md` §5 | 待验证 |
| UP-14 | 上游设置与技能页控件重构（新 `SegmentedControl`、`SkillhubMarketListView` 路由化、`MarketCard` / `outdated` 语义） | `CAP-SETTINGS`、`CAP-SIDEBAR`、`CAP-MEKASKILL` | `renderer/features/plugin/PluginManagementLayout.tsx`、`skillhub/SkillhubDetailView.tsx`、`skillhub/components/MarketCard.tsx`、`skillhub/MekaSkillMarketListView.tsx` 等 8 + 5 个文件 | 适配接纳 | 全并集；Meka 三页签**重挂到上游新 `SegmentedControl`**（`PluginManagementLayout.tsx:17,192`）；`SkillhubDetailView` 的 13 处 `isMekaEntry` 全保、`outdated` 谓词与 `onLocalRenamed` 取上游语义；`MarketCard` 保留 Meka 渠道管理入口 `onManage` / `ManageButton` | Meka 三页签位次、路由与「插件 / 技能 / 项目」三入口不因控件替换改变；`SkillhubMarketListView` 取上游路由化重构后，Meka 曾加在该列表上的页内预览与选中态（`hooks/useMarketSelection.ts`、`lib/marketPreviewSelection.ts`、`lib/marketPreviewSync.ts`）不再有生产消费方（只剩各自单测），Meka 自己的 Skill Hub 仍用同一详情组件做页内预览 ⇒ **登记为有意接纳的上游重构**，功能未丢 | 调度者（PLUGIN-UI 组） | 定向：`PluginManagementLayout.test.tsx` **21/21**、`MekaSkillMarketListView.test.tsx` **2/2** | §6「PLUGIN-UI」；总账 §4.6 | 已解决 |
| UP-15 | 上游 Renderer 设置 / 侧栏 / 会话头与模型可见性变化 | `CAP-MODELVIS`、`CAP-SIDEBAR` | `packages/model-providers/src/sections.ts`、`packages/model-providers/src/modelVisibilityPrefs.ts`、`renderer/.../CCAgentSidebarUpper.tsx` + 2 个渲染文件 | 适配接纳 | 5 个文件全并集 / 取上游；`CCAgentSidebarUpper.tsx` 逐段核对「合并结果 = 上游当前架构 + 全部 Meka 增量」；纠正 Meka 侧 2 处静默回退上游（`canExportShare` 谓词、`openSessionInNewWindow` 丢第 2 参）并补回被删的 `useEffect` import | **WL-10 P0 复查通过**：`isModelVisible` 与 `isModelEnabled` 的兜底仍是 `override ?? defaultEnabled`，**没有「无初始化清单 ⇒ 不可见」分支**，且本轮上游未改该决策函数 ⇒ 老用户模型选择器不会清空 | 调度者（RENDER 组） | 代码级复查（决策函数兜底形态 + 逐段核对）；本轮**未跑** renderer 定向套件 | §6「RENDER」；`docs/dev-rules/meka-whitelist-verification.md` WL-10 | 已解决 |
| UP-16 | 上游删除 22 条路径（Claude OAuth 凭证链路搬迁、workdir 探针重构、`updateLockWait`、`SettingsSegmentedControl` 等） | 横切 | `main/maker-host/claude-*`、`main/usage/claudeSubscriptionUsage*`、`main/workdir-probe-host/*`、`main/localDb/codexHistoryOversizedUpgrade.ts`、`main/updateLockWait.ts`、`renderer/components/settings/SettingsSegmentedControl.tsx`（+ 测试） | 退役（接纳上游删除） | Git 干净接纳，按上游删除处理；逐条 `grep` 全仓确认无悬挂引用 | 无悬挂引用；`WorkdirProbeHostPackaging.test.ts` 的「forge 不含 `workdirProbeHostProcess.ts`」断言仍成立 | 调度者 | `grep` 覆盖 `apps/desktop/src`、`packages/*/src`；逐条清单见 §4.3 | §4.3 | 已解决 |
| UP-17 | 上游杂项 additive（`agent-island/state.ts`、`sessionShareImport.test.ts`、`anthropic-compat-proxy`、`file-browser-core` 平台分派） | 横切 | `renderer/features/agent-island/state.ts`、`main/__tests__/sessionShareImport.test.ts`、`packages/anthropic-compat-proxy/src/index.ts`、`packages/file-browser-core/.../completeDirectory.test.ts` | 接纳（并集）+ 保留例外（1 处） | 三个文件并集（Meka `isFetchBlockedPort` / `listenOnFetchSafePort` + 上游 `recoverInlineAttachments`；WL-17 十条 Meka 绑定断言全留 + 上游 4 条）；`completeDirectory.test.ts` 取 Meka 的平台分派写法 | 有意登记的 **1 行分歧**：Meka 的平台分派写法与 `engineering-conventions.md` §4「测试里造目录符号链接必须按平台分派」一致 | 调度者（MISC 组） | 静态核对 | §6「MISC」；`docs/dev-rules/engineering-conventions.md` §4 | 已解决 |

## 6. 分组解决结果

> 每组给「口径 + 证据 + 保留的不变量 + 定向取证结果」。`定向取证` 只登记**本轮实际跑过**的命令与结果；
> 写「代码级证据」「静态核对」的组**没有**实跑测试。分组与 §5.2 的 `UP-*` 行、§5.1 的能力 ID 相互对应。

### 6.1 GOV（3 文件）

- **口径**：治理文本取上游基底，Meka 索引与管理面按并集补回。
- **证据**：`AGENTS.md` 并集（上游 `shared-task-mode.md` 索引 + Meka `meka-skills.md` 索引都留，
  45 条索引引用路径全部存在）；`design-inventory.md` 取上游基底 + 补回 4 个 `desktop.meka.*` surface
  与 Meka 路由 / 重定向行；`credentials-and-local-storage.md` 取上游 + 保留 3 条 Meka 条目。
- **保留的不变量**：上游本轮**没改** `AGENTS.md` 的「提交前测试门禁」措辞与「门禁时机」段落
  （上游 `:3:` 根本没有「文档同步」「审查与问题范围」两节）⇒ 保留 Meka 措辞；
  `scripts/test-related.mjs` 的 `GIT_BASE_REFS = ["origin/meka/main","meka/main","origin/main"]` 与 Meka 措辞一致。
- **定向取证**：45 条索引引用路径存在性核对（静态）；`design-inventory` GENERATED 区重生成后登记 **55** 个 surface。

### 6.2 DB（5 文件，含 drizzle 生成物）

- **口径**：D4 —— 冻结 Meka 已发布编号，上游新增顺移追加。
- **证据**：上游真正新增 `0110..0114`（5 条）→ Meka 号 `0113..0117`；SQL 正文逐字节取上游；
  `meta/0113..0117_snapshot.json` 由上游同序号 snapshot 经 **Meka delta 变换**得到
  （delta = `MEKA 0112` vs `UP 0109` 结构化比对，纯增量：新增表 `meka_projects` / `meka_roles`，
  `sessions` 新增 10 列 + 2 索引 + 1 外键，`_meta` / `views` 无差异）；journal 追加 idx 113–117；`id/prevId` 重连。
- **保留的不变量**：`0000..0112` 逐字节不变；固定基线 80 条 SQL + 23 脚本、canonical 113 条 SQL + 44 脚本不变；
  Meka 的 drizzle `*_snapshot.json` 按目录既有风格写 **CRLF**（`core.autocrlf=true`，blob 为 LF）。
- **定向取证（实跑）**：`pnpm --filter desktop db:validate` **6/6 步全过**（`0000..0117` 118 个 SQL、
  journal/snapshot 全对齐、`drizzle-kit check` 通过、44 个 companion 均 CommonJS、两处基线计数吻合）；
  `pnpm --filter desktop exec drizzle-kit generate` → **`No schema changes, nothing to migrate`**。

### 6.3 DBCORE（4 文件）

- **口径**：`registerAll` / `mapper` / `sessions` / `DbClient.inproc.test.ts` 以并集为默认判据，两处
  `sessions.ts` 冲突分别判（不做整文件 pick）。
- **证据**：`registerAll.ts` = 上游 `registerTaskTagsIpc()` + Meka 5 个 `registerMeka*Ipc()`；
  `mapper.ts` = 上游 `source: 'cindy-make-merge'` + Meka 5 字段；`sessions.ts` 第一处取 Meka
  `validatedCreateBody` **且**保留上游新增 `const gitSafety`，第二处 `recentWorkdirs` 判据并集为
  `(project || meka) && … && isRetainableProjectSession`；测试文件并集（Meka 真实 `0000_init.sql` fixture
  + 上游 `task_tags` / `session_task_tags`）。
- **保留的不变量**：`'meka'` 契约 4 个声明点全含 `'meka'`，**新发现漏点 = 0**；未发现上游引入的
  降级 / 漏分类路径（即不存在把 Meka 会话降级成普通 project/dialogue 的新分支）。
- **定向取证**：契约静态复查（4 个声明点 + 上游新增路径分类）；本轮**未跑** `DbClient.inproc.test.ts`。

### 6.4 UPD（9 文件）

- **口径**：**installer.rs 取上游（用户裁决方案 A）**，只把两项 Meka 投影加回去；其余文件按「取上游 / 取 Meka / 并集」逐处判。
- **证据**：`installer.rs` = 上游 1217 行 + 161 行 / 0 删除，加回 `notify_shell_associations_changed()`
  （`SHChangeNotify` Shell 刷新）与 `validate_extracted_main_executable()`（热更包结构校验，来自上游笔误名
  `validate_extracted_main_main_executable()` 的正确名）；`Cargo.toml` 取上游（删 `sha2` 与 5 个 windows-sys feature）；
  `installer.nsh` / `installer-directory.nsh` 取上游 `${BUILD_RESOURCES_DIR}` 形态；`forge.config.ts`
  8 处冲突 6 取 Meka（`resolveWindowsSignCommand()`、`BRAND_IDENTITY.displayName`、
  `cindy_meka_windows_desktop_host_napi.dll`、Cindy Meka schemes、打包名、NSIS 签名日志文案）2 取上游；
  `package-desktop.mjs` 并集（保 Meka `--no-sign`，同时删 `CINDY_WIN_SIGN_CMD` 与 `NPKG_TOKEN`）；
  `updateService.ts` 并集；`updateService.test.ts` 保留 24 条 Meka 不变量断言 + 7 条上游新增，删 10 条
  断言已删机制的用例。
- **保留的不变量**：`cindy-meka` 渠道身份与根地址；热更包结构校验；Shell 刷新（含「第二跳才生效」的发布评估要求）；
  `updateService.test.ts` 里资源文件名一律走 `BRAND_IDENTITY.updaterName`（**上游新用例的写死名已改**，
  否则 Meka 落点 `cindy-meka-updater.exe` 必然失败）。
- **随上游退役（登记）**：`InstallDirIdentity` / `capture_install_dir_identity` / `install_dir_identity_unchanged` /
  `copy_tree_into_pinned` / `pinned_join`、`.updating` 独占锁 `acquire_update_lock`、High-IL staging ACL、
  `InstallerFailure`、`--zip-sha256` / `--install-writable`。
- **定向取证**：`updateService.test.ts` **107/107**；三个 NSIS include 规则测试 **8/8**。

### 6.5 AUTH（4 文件）

- **口径**：身份 / 区域面按并集，`bootstrap-electron.ts` 取上游但逐点补回 Meka 登录收尾。
- **证据**：`authManager.ts` 并集（上游凭证库健康守卫放回上游原位置 + Meka `select-realm`；
  该错误态选择器不可达 ⇒ 两种顺序等价）；`bootstrap-electron.ts` 取上游（含 Meka 每一步的 `finishXaiLogin`）；
  `UserInfoSection.tsx` import 并集；`userInfoSectionUpdateFlame.test.tsx` 并集。
- **保留的不变量**：WL-5.4 五条不变量；`PRODUCT_EDITION_KEY` 声明 `:211` + 4 处引用（读 / 写 / 登出清 / relogin 清）齐备
  —— 上一轮「只剩引用」的形态本轮未复现。
- **定向取证**：4 个文件 **37 / 6 / 25 / 11** 全过。

### 6.6 ORCA（6 文件）

- **口径**：6 个文件全并集；本组额外承担「上游新增面是否与 Meka transport 分类契约冲突」的复核。
- **证据（本轮高危发现并修复）**：上游 `340888c77d` 新增的 SSH-only 探针 `readSshCodexModelList` 在
  3 个 `mcpr:` 可达调用点漏按 transport 分类 —— `assertModelRouteUsable`、`getProviderRoutingContext` 的 dep、
  `SET_MODEL` 的 `sshCodexProviders`（`main/maker-ipc/register.ts:6937,11418,16797`）；三处统一加
  `classifyRemoteSessionTransport(...) === 'ssh'`。不修则 MCPRouter Codex 的**会话创建 / 改模型 /
  Orca 远端 worker 创建全部硬失败**（探针把一切失败折叠成 `SSH_EXEC_FAILED`）。
- **保留的不变量**：WL-4.1.2 四条路径共用一个漏斗（`register.ts` 的 guard 先于 SSH preflight）；
  `mcpr:` 过滤点全量 **17 处**已列；`mcpr:` 与 SSH 是不同 transport，不能共享 SSH pool 前置。
- **定向取证**：三处判据 `grep` 复核（代码级证据）；本轮**未跑** ORCA 定向测试套件。

### 6.7 CORE（3 文件）

- **口径**：`base-agent.ts` 与测试按并集；`project-resource-cli.test.ts` 取 Meka。
- **证据**：`base-agent.ts` 并集（上游 7 处 additive 全接，Meka 扩展保留）；
  `cindyBridgeSource.test.ts` 并集（Meka vm 执行式套件 8 it + 上游 library 映射套件）；
  `project-resource-cli.test.ts` 取 Meka（两侧同一语义改动，Meka 版多 4 行注释，且与本仓
  `engineering-conventions.md` §4「测试里造目录符号链接必须按平台分派」一致）。
- **保留的不变量**：Pi 原生能力非退化；Meka 注入层分段顺序 `MEKA_PROMPT_SEGMENT_ORDER` 与
  `MEKA_AGENT_CAPABILITIES` 能力矩阵不因 additive 变更改变。
- **定向取证**：`cindyBridgeSource.test.ts` **47 passed / 4 skipped**。

### 6.8 PLUGIN-MAIN（5 文件）

- **口径**：5 个 main 侧文件全并集；本组额外承担存量插件兼容复核与下载上限回归修复。
- **证据**：全并集；下载上限按 UP-04 显式注入（普通 8 MiB / node 128 MiB），并删掉与上游新语义互斥的用例。
- **保留的不变量（存量插件兼容，红线）**：本轮上游**未改**批准状态 schema（`RECEIPT_SCHEMA_VERSION = 2`）、
  **未改**指纹格式（`cindy-ghost-content-v2`）、**未改**安装布局 / 包格式（尺寸常量数值不变）；
  `validateGhostManifest` 仅放宽（新增 `ok:false` 拒绝点 = 0）⇒ **无 P0、无需新增迁移**，用户升级后
  已装 / 已批准 / 已启用插件照旧可用。
- **风险门**：上游 `b8b90eb536` 新增 remote 私有 setup 卡 / 设备码属**插件基座新面**，仍需白名单放行门
  （→ §5.1 `CAP-MEKAPLUGIN` 记 `待验证`）。
- **定向取证**：`download.test.ts` 与 `mekaDownloadPolicy.test.ts`（静态核对路径与断言）。

### 6.9 PLUGIN-UI（8 + 5 文件）

- **口径**：全并集；Meka 三页签与渠道入口必须挂在**上游当前控件**上，不得自建平行控件。
- **证据**：`PluginManagementLayout` 的 Meka 三页签重挂到上游新 `SegmentedControl`
  （`PluginManagementLayout.tsx:17,192`）；`SkillhubDetailView` 的 13 处 `isMekaEntry` 全保、
  `outdated` 谓词与 `onLocalRenamed` 取上游语义；`MarketCard` 保留 Meka 渠道管理入口 `onManage` / `ManageButton`。
- **保留的不变量**：Meka 三页签位次与「插件 / 技能 / 项目」三入口、`/cc-agent/meka/*` 路由不因控件替换改变。
- **另按调度者授权收尾**：上游重命名 `SkillhubMarketPreviewPanel` → `SkillhubMarketDetailView` 留下的
  **7 处悬挂引用**（2 个 Meka 视图 + 3 个测试的 `vi.mock`）。
- **定向取证**：`PluginManagementLayout.test.tsx` **21/21**、`MekaSkillMarketListView.test.tsx` **2/2**。

### 6.10 RENDER（5 文件）

- **口径**：全并集 / 取上游；对 Meka 增量逐段核对，并对模型可见性做 P0 复查。
- **证据**：`CCAgentSidebarUpper.tsx` 逐段核对「合并结果 = 上游当前架构 + 全部 Meka 增量」；
  纠正了 Meka 侧 2 处静默回退上游（`canExportShare` 谓词、`openSessionInNewWindow` 丢第 2 参）
  并补回被删的 `useEffect` import。
- **保留的不变量（WL-10 P0 复查通过）**：`packages/model-providers/src/sections.ts` 的 `isModelVisible` 与
  `modelVisibilityPrefs.ts` 的 `isModelEnabled` 兜底仍是 `override ?? defaultEnabled`，
  **没有「无初始化清单 ⇒ 不可见」分支**；本轮上游未改该决策函数 ⇒ **老用户模型选择器不会被清空**。
- **定向取证**：代码级复查（决策函数兜底形态 + 逐段核对）；本轮**未跑** renderer 定向套件。

### 6.11 I18N（5 文件）

- **口径**：按 **key** 三方合并（不按文件 pick），Meka 命名空间必须五语齐备。
- **证据**：合并后 en **11196** / 其余四语各 **11177** 叶子 key（**本行是 I18N 组的「叶子 key」口径**，
  含复数变体等；`pnpm check:i18n` 用的是「五语公共 key 集」口径，实跑为 **11101**，两者口径不同、不矛盾，
  见 §7.2）；相对 `meka/main` +779 / +777 −7
  （上游新增全接、上游删的 7 条接受）；相对 `origin/main` +574 −1（Meka 新增全留、Meka 有意删的 1 条保留）；
  **真冲突 0 条**（`bothChangedDiff = 0`）。
- **保留的不变量**：Meka 命名空间五语 0 缺失（`meka.*` 198、`mekaSkills.*` 84、`settings.meka.*` 71、
  `settings.tabs.mekaAssistant` 1、`settings.ghosts.meka.*` 56）；取 Meka 的 41 处「仅 Meka 改过」里包含
  2 条**必须取 Meka**的（`localDbFatal.*` 的 `{{appName}}`、`logic.errors.hostShellCommandBlocked` 的
  通用安全策略文案，均有仓内测试钉住）。
- **定向取证**：计数与三方差值核对；本轮**未跑** `pnpm check:i18n`（门禁由调度者一次性执行）。

### 6.12 BUILD（6 文件）

- **口径**：`package.json` / 脚本 / `vitest.config.ts` 全并集，两侧测试调度与不变量都留。
- **证据**：`scripts.test:runner` 取 Meka 的 40 个测试文件 + 上游追加
  `&& node apps/desktop/scripts/check-windows-atomic-rename.mjs`；`resolveWindowsSignCommand` 等
  `forge.config` 项按 §6.4；`ensure-agent-binaries.mjs` 并集；`restart-desktop-remote.mjs` 并集；
  两个脚本测试并集；`vitest.config.ts` 并集（上游 `testTimeout: 60_000` + `hookTimeout`，保留 Meka 实测注释）。
- **保留的不变量**：`dependencies` / `devDependencies` / `pnpm.overrides` 三方逐字一致；
  Meka 的 40 文件测试调度与脚本不变量（`codex-single` / `planEnsurePlatformFailure` / `ENSURE_FAILURE_ACTIONS`、
  身份 / 区域 / 沙箱）保留。
- **`pnpm-lock.yaml`：已重建**（交付门禁实跑阶段执行 `pnpm install`；未手解）。两侧都改了 workspace manifest，
  且根 `patchedDependencies` 新增 `@expo/cli@57.0.25`，`patch_hash` 只能由 pnpm 重算 —— 已由 pnpm 重算完成。
- **定向取证**：`package.json` 三方逐字一致（静态）；lockfile 已由 `pnpm install` 重建并经 `pnpm licenses:generate`
  重新生成声明文件（`THIRD-PARTY-NOTICES.txt` 的 npm 包数 1442 → **1447**，见 §6.15 第 5 条、§7.1）。

### 6.13 MISC（4 文件）

- **口径**：并集；测试写法分歧取与本仓工程规范一致的一侧。
- **证据**：`agent-island/state.ts` 并集；`sessionShareImport.test.ts` 并集（WL-17 十条 Meka 绑定断言全留 +
  上游 4 条）；`anthropic-compat-proxy/src/index.ts` 并集（Meka `isFetchBlockedPort` / `listenOnFetchSafePort`
  + 上游 `recoverInlineAttachments`）；`file-browser-core/.../completeDirectory.test.ts` 取 Meka 的平台分派写法。
- **保留的不变量 / 有意分歧**：登记的 **1 行分歧** = 平台分派写法，与
  `engineering-conventions.md` §4「测试里造目录符号链接必须按平台分派」一致。
- **定向取证**：静态核对；本轮未跑 MISC 定向套件。

### 6.14 另有三处需要单独登记的实质发现

1. **共享下载器缺省上限被上游从 8 MiB 提到 128 MiB**（`packages/plugin-protocol/src/memberUpload.ts:24`），
   使 Meka 侧「普通插件返回 `undefined` 交给缺省」的调用点前提失效 ⇒ 普通 Meka 插件下载上限被**静默放宽**。
   已按 `plugin-security-and-authoring.md` §4.2 改回显式注入（见 UP-04）。
2. **上游 `5b10e9babc` 把 #4502 的 Windows 热更机制整体回退**，用户裁决方案 A：完整接纳（见 UP-05），
   只保留 `SHChangeNotify` Shell 刷新与热更包结构校验两项。
3. **`SkillhubMarketListView` 取上游路由化重构**后，Meka 曾给「Cindy 市场列表」加的页内预览与选中态
   （`hooks/useMarketSelection.ts`、`lib/marketPreviewSelection.ts`、`lib/marketPreviewSync.ts`）在该列表上
   不再有生产消费方（只剩各自单测）；Meka 自己的 Skill Hub 仍用同一详情组件做页内预览，功能未丢。
   登记为**有意接纳的上游重构**。

## 6.15 交付门禁实跑中发现的缺陷与修复（2026-09-24）

> §1–§6 记录的是**冲突解决当时**的事实。本节补记其后**交付门禁实跑**（`pnpm audit:merge`、
> `pnpm test:runner`、`pnpm --filter desktop typecheck`、Windows 安装器检查、`db:validate`、
> `drizzle-kit generate`、i18n / licenses 等）暴露并**当场修复**的 6 处缺陷，
> 每条固定按「现象 → 证据 → 根因（谁引入）→ 修法 → 实跑验证」写。门禁命令的完整实跑结果见 §7；
> 本节登记的修复是 §7 阶段 B 全绿的前提。
>
> **性质分布**：第 1、2、4 条是**本轮合并引入**（含上游语义覆盖）；第 3 条一半是上游刷新触发、
> 一半是 Meka 存量内容缺陷；第 5、6 条是**Meka 侧存量缺陷**，按 `AGENTS.md`「审查与问题范围」
> 先报告证据与影响，由用户裁决纳入本次。节末另有 2 条「接纳上游但需明知」的事实登记。

### 6.15.1 `pnpm --filter desktop typecheck` 8 个错误（合并产物缺陷）

- **现象**：交付门禁首跑 `pnpm --filter desktop typecheck` 报 **8 个错误**，分布在 6 个文件：
  `SessionImportSection.tsx(67,7)` TS2322、`SessionImportSection.tsx(68,15)` TS2345、
  `CCAgentSidebarUpper.tsx(4142,9)` TS2322、`MekaSkillHomeView.tsx(373,22)` TS2741、
  `MekaSkillHomeView.tsx(390,22)` TS2741、`SkillhubMarketListView.tsx(111,18)` TS2304 + TS7006、
  `maker-ipc/__tests__/orcaWorkerCreationService.test.ts(29,7)` TS2322。
- **证据**：以上 6 文件 / 8 个诊断即 typecheck 首跑输出；逐处根因见下，均为「两侧写法与新结构错配」
  的合并产物（各自单独存在时都成立）。
- **根因（谁引入）与修法（逐处）**：
  1. `vite-env.d.ts`（preload 镜像的 `workspaceKind`）—— 上游把镜像从字面量两值改成
     `import('@/lib/ccAgent.types').WorkspaceKind`；上游的 `WorkspaceKind` 恰为两值，故在上游等价，
     但 **Meka 的 `WorkspaceKind` 含 `'meka'`**（WL-3.6）⇒ 镜像被**静默放宽**，产出侧的窄类型随即在
     `SessionImportSection.tsx` 撞出 TS2322 / TS2345。产出侧（`main/localDb/ipc/session-import.ts:40`、
     `maker-host/codex-local-sessions.ts` 的 cwd 归类、Claude 分支硬编码 `'project'`）**永不产 `'meka'`**，
     故按「产出 / 消费边界显式收窄」把镜像恢复为 `'project' | 'dialogue'` 并加注释；
     **未放宽渲染层**（放宽等于谎称渲染层能处理 `'meka'`），`WorkspaceKind` 本体未动。
     `SessionImportSection.tsx` 本身无需改。
  2. `CCAgentSidebarUpper.tsx(4142,9)` —— 上游退役了 `SidebarIconButton` 的 34px grid 形态并删除其
     `variant` prop（`docs/design-rules/DESIGN.md:270`）；Meka 的 rail Meka 按钮是从旧版写法带来、
     合并时**漏删** → 只删 `variant="rail"`，WL-2.2 的位置与 `active` / `aria-current` 原样保留。
  3. `MekaSkillHomeView.tsx(373,22)/(390,22)` —— 上游给 `LocalGroup` 新增**必填** `active: boolean`
     （语义 = 本 Skill home 当前是否可见，由 `SkillhubLocalLayout` 的 `visibility:hidden + inert` 保活下发）。
     Meka 路由**没有保活层**（`router.tsx` 同级路由、`CCAgentFeatureLayout` 直渲染 `Outlet`、
     `SplitGroup.tsx:131` 不缓存）⇒ 挂载期恒为可见，两处传 `active` 并加注释。
  4. `SkillhubMarketListView.tsx(111,18)` TS2304 + TS7006 —— 本仓已把该常量改名导出为
     `SKILLHUB_MARKET_SORT_OPTIONS`（供 Meka 列表复用），合并时第 111 行仍引用上游旧名 `SORT_OPTIONS`
     → 改回实际存在的常量；`option` 由 `Array<{value: SortBy; labelKey: string}>` 自动推断，
     **未用 `any` / `as`**。
  5. `maker-ipc/__tests__/orcaWorkerCreationService.test.ts(29,7)` —— `OrcaLeadSessionSnapshot.mekaProjectId`
     是 **Meka 侧**新增的必填可空字段（上游对该文件的 `mekaProjectId` 零命中），而上游本轮新增的
     `SSH Codex Worker catalog` 用例夹具写在上游旧类型之上 → 补夹具 `mekaProjectId: null`
     （该用例是普通 `workspaceKind: 'project'` 的 SSH Codex lead，与 WL-3.6 自洽）；
     **未**把该字段改成可选。
- **实跑验证**：`pnpm --filter desktop typecheck` **exit 0**；定向 `orcaWorkerCreationService.test.ts`
  **123/123**；4 个渲染层测试 **28/28**。

### 6.15.2 Windows 安装器检查在合并后失败（合并引入，两处）

- **现象 A**：`node apps/desktop/scripts/check-windows-installer.mjs` 在 electron-builder 编译阶段失败：
  `!include: could not find: "…\build\winget-shortcuts.nsh"`（`installer.nsh:16`）。
- **现象 B**（修掉 A 后暴露）：native harness 的 `missing` 场景以 `0xC0000005`（ACCESS_VIOLATION）崩溃，
  `check-windows-installer.mjs:163` 断言 `undefined !== '0'`。
- **根因**：
  - A：上游 `7582de5f20` 在 `forge.config.ts:1761` 显式设了 `directories.buildResources = resources`，
    并把两个 `.nsh` 的 include 改成 `${BUILD_RESOURCES_DIR}`；而两个 native 检查脚本在**上一轮 Meka 的
    修复**里被刻意改成**不覆盖** `buildResources`（当时理由成立：那时生产也没设）⇒ 现在脚本与生产形状
    不一致，`${BUILD_RESOURCES_DIR}` 指到不存在的 `<projectDir>/build`。
    → **修法**：两个脚本都补 `buildResources: path.join(desktop, 'resources')`，与**新的**生产形状对齐。
  - B：上游把 `installer-directory-messages.nsh` 的 include 从**顶层**移进 `!macro customHeader` 宏体内。
    宏体内的 `!include` 要到 `!insertmacro customHeader` 的**插入点**才展开。已实测：换回合并前 Meka 的
    `installer-directory.nsh` 即 14 个 native 场景全 exit 0；换回上游版即 `missing` 崩溃。
    → **修法**：**取并集** —— 保留上游的 `${BUILD_RESOURCES_DIR}` 限定（`makensis -D` 常量，
    宏内 / 宏外取值一致），但把 include 放回**顶层**；两层理由都保留在文件注释里。
- **实跑验证**：`check-windows-installer.mjs` **exit 0**（生产安装器 / 卸载器编译 + **14 个 native 场景全
  exit 0**）；`test-winget-shortcuts.mjs` **exit 0**；`cargo build --release` **exit 0**。
- **附加**：`apps/desktop/scripts/installer-include-resolution.test.mjs` 的**说明性注释**已按新形态改写
  （规则本身只禁「裸相对名」，两种限定写法都放行 ⇒ 测试逻辑未变、仍全绿）。

### 6.15.3 `pnpm test:runner` 2 个红（i18n 术语）

- **现象**：`not ok 284 - Desktop billing: 金额和余额文案不得恢复 Credits / 点数`；
  `not ok 289 - glossary.json: 声明的译法必须是现状主流，否则要写明为何有意偏离`。
- **根因 A（ko `turn`；上游刷新文案 × Meka 术语表）**：上游本轮刷新了 ko 文案，把
  `chat.remoteError.REMOTE_DAEMON_CLOSED`、`logic.errors.codexCompactionNotConverging`、
  `logic.errors.codexCompactionNotConvergingModelSwitch` 三个 key 的 ko 从「턴」改成「차례」，
  而**同一批的 ja 仍用「ターン」**。实测 ko 覆盖率由 HEAD 的 37/95（38.9%）降到合并后的
  33/95（34.7%），低于门禁的 35% 阈值（上游自身是 33/93 = 35.5%，刚好在上限之上）。
  → **修法**：把这 3 处 ko 的「차례」改回术语表为 ko 声明的「턴」，与 ja 的平行处理一致
  （`i18n/glossary.json` 的 `turn` 条目：zh-CN 轮 / zh-TW 輪 / ja ターン / ko 턴）。
  修后 **36/95 = 37.9%**，`glossary-rules.test.mjs` **71/71** 全绿。
- **根因 B（`credits`）—— Meka 侧存量内容缺陷**：上游本轮**收紧**了
  `scripts/__tests__/glossary-rules.test.mjs` 的匹配器（注释明写「单数 Credit 能同时覆盖 Credit /
  Credits……8 个 key 原先完全不受约束」），于是 Meka 独有的死文案 `billing.balance.creditParityCny` /
  `creditParityUsd`（base 与 `origin/main` 都没有，Meka 单侧新增）在 **en / ja / ko** 的
  Credit / クレジット / 크레딧 用词被拦下 —— `i18n/glossary.json` 的 `credits` 条目已裁决
  「Desktop billing 弃用点数概念（PR #1053），新增计费文案一律用金额 / 余额措辞，en 源不再引入
  Credit/Credits 用词」。该 2 个 key **全仓无任何代码引用**（`git grep creditParity` 只命中 5 个
  locale 文件）⇒ 用户裁决**删除**，已从五语同步移除（`check:i18n` 五语 key 数由 **11103 → 11101**，
  仍全部一致）。**性质登记**：合并前已存在但未被拦，本轮因接纳上游收紧后的门禁而暴露。
- **实跑验证**：`pnpm test:runner` → `# tests 684 / pass 677 / fail 0`，**exit 0**（见 §7.2）。

### 6.15.4 插件下载缺省上限被静默放宽（语义被上游覆盖，白名单清单 §1 的形态）

- **现象**：上游把共享缺省 `PLUGIN_MEMBER_UPLOAD_MAX_ARCHIVE_BYTES` 从 8 MiB 提到 **128 MiB**
  （`packages/plugin-protocol/src/memberUpload.ts:24`），Meka 的 `resolveMekaPluginMaxDownloadBytes`
  对非 `node` 包返回 `undefined`「交给缺省」⇒ 普通 Meka 插件的下载上限被**静默放宽**到 128 MiB
  （白下之后才在 `cindy-brain/GhostManager.ts:2325` 的安装期被判超限拒绝）。
- **证据 / 根因（谁引入）**：§6.14 第 1 条已登记同一发现（该处结论不变）；根因是**上游改了共享缺省**，
  Meka 侧「返回 `undefined` 交给缺省」的调用点前提失效 —— 属「代码都在、语义被上游覆盖」的静默回归。
- **修法**：按 `docs/dev-rules/plugin-security-and-authoring.md` §4.2 既有口径「由 Meka 市场实例
  **显式注入**」—— `mekaDownloadPolicy.ts` 改为显式返回 `MEKA_PLUGIN_MAX_DOWNLOAD_BYTES = 8 MiB`
  （普通）/ `MEKA_NODE_PLUGIN_MAX_DOWNLOAD_BYTES = 128 MiB`（已通过共享 `validateGhostManifest`
  且声明 `node`），函数不再返回 `undefined`；新增漂移守卫单测（普通上限 == 安装期 basic 上限
  `MAX_BASIC_CINDY_FILE_BYTES`）于 `main/plugin-market/__tests__/mekaDownloadPolicy.test.ts`；
  删除 `plugin-market/__tests__/download.test.ts` 里与上游新缺省互斥的旧用例
  `keeps the default 8 MiB ceiling before starting a download`（上游自己的
  `accepts a package above the former 8 MiB market limit` 覆盖新缺省）。
- **实跑验证**：调度者已定向实跑 ——
  `pnpm --filter desktop exec vitest run src/main/plugin-market/__tests__/mekaDownloadPolicy.test.ts
  src/main/plugin-market/__tests__/download.test.ts` ⇒ **通过**（含上游新缺省用例与新增的漂移守卫；
  三个文件合计 27 用例全绿，另含 `i18nBrandPlaceholder.test.ts`）。§7.1 的 `audit:merge` 亦确认
  该文件不在 DROPPED 列表。

### 6.15.5 `pnpm licenses:generate` 因入库的 `cindy-meka-updater.exe` 失败（存量，用户裁决纳入本次）

- **现象**：`pnpm licenses:generate` 失败，报出被 Git 跟踪的 `.exe` 产物。
- **证据**：`apps/desktop/resources/cindy-meka-updater.exe`（4.6 MB）由 Meka 提交 `298a39912b` 入库
  （merge-base 没有），而 `.gitignore:46` 只拦上游名 `cindy-updater.exe`；上游
  `scripts/generate-third-party-notices.mjs` 的 `assertTrackedBinariesRegistered()`（**base 就有**，
  本轮只 +27/−1 行）会把所有 tracked 的 `.exe` 报出来 ⇒ **合并前的 `meka/main` 上
  `pnpm licenses:generate` 就是红的**（但不阻断门禁：`third-party-notices.test.mjs` 不走该断言，
  **13/13 绿**）。另证：`forge.config.ts:482` 的 `buildCindyUpdater()` 在 prePackage 现场
  `cargo build --release` 并拷到 `resources/cindy-meka-updater.exe` ⇒ 它是**产物**而非输入。
- **根因（谁引入）**：**Meka 侧存量缺陷**（`298a39912b` 起即在），非本轮合并引入；
  按 `AGENTS.md`「审查与问题范围」先报告证据与影响，用户裁决**纳入本次**。
- **修法**：`.gitignore` 补 `apps/desktop/resources/cindy-meka-updater.exe`（并写明理由）；
  `git rm --cached` 该文件（本地文件保留，将来由 forge 现场重建）。
- **实跑验证**：`pnpm licenses:generate` **exit 0**，重新生成 11 个声明 / SBOM 文件
  （其中 `docs/legal/notices/THIRD-PARTY-NOTICES.txt` 的 npm 包数由 **1442 → 1447**，证明合并后
  暂存版声明已与 lockfile 脱节，必须重生成）；`third-party-notices.test.mjs` **13/13 绿**；
  上游新增的 `OpenAI Codex skill-creator (adapted)` 与 `PyYAML` 条目仍在。

### 6.15.6 zh-TW 品牌占位（存量，用户裁决纳入本次）

- **现象**：zh-TW 的 `localDbFatal.preparing.description` / `localDbFatal.updateReady.description`
  硬编码 `Cindy`，其余四语用 `{{appName}}` ⇒ 繁体用户在数据库版本恢复页看到的不是展示名
  **Cindy Meka**。
- **证据**：该两条在 base / `meka/main` / `origin/main` **三侧完全一致**（**非本轮引入**）；
  两道门都拦不住（`i18nBrandPlaceholder.test.ts` 的 locale 列表只循环 4 语；
  `scripts/brand-terminology-guard.mjs` 只拒 `XDMaker|XD Maker|xdt-maker`）⇒ 假绿。
- **根因（谁引入）**：**存量缺陷**（该两条在 base / `meka/main` / `origin/main` 三侧一致地存在，
  即上游也有、非 Meka 单侧新增，也非本轮引入），按用户裁决纳入本次。
- **修法**：zh-TW 两条改用 `{{appName}}`；`apps/desktop/src/renderer/__tests__/i18nBrandPlaceholder.test.ts`
  的 locale 列表由 4 语补成 **5 语**（测试名同步改为「在五种语言中」），把这道假绿一起堵上。
- **实跑验证**：`pnpm check:brand-terminology` **PASS**（§7.2）；调度者另定向实跑
  `pnpm --filter desktop exec vitest run src/renderer/__tests__/i18nBrandPlaceholder.test.ts` ⇒ **通过**
  （该文件现覆盖五语，`localDbFatal` 三条 description 均断言渲染结果含 `BRAND_NAME`）。

### 6.15 附：另两条必须登记的「接纳上游但需明知」事实（非缺陷）

1. **端点备源链路 = 渠道耦合（当前无身份风险）**：`docs/auth-realm-routing.md` +
   `packages/maker-shared/src/clientEndpointResilience.ts` + `config/endpoint-manifest-mirrors.json`
   是上游本轮新增的**端点备源**链路。Meka 的 `config/endpoint.json` / `config/endpoint.global.json`
   与上游**逐字节相同**（三侧同 blob），备源指向上游公开仓
   `raw.githubusercontent.com/makecindy/cindy/main/config/endpoint*.json`，且只在
   「主源 URL == 随包清单的 `cdnBaseUrl` + `/endpoint.json`」时启用（最多取 1 个备源，
   另有 region 匹配 + 可信域检查）。⇒ **当前无身份风险**（备源内容与随包清单一致），
   但登记为**渠道耦合**：若将来 Meka 的端点清单与上游分叉（换域 / 换 bucket），必须同步核对
   `config/endpoint-manifest-mirrors.json`，否则备源仍会吐上游清单。关联 WL-5.2。
2. **`SkillhubMarketListView` 采纳上游路由化详情重构 = 有意接纳**：Meka 曾给「Cindy 市场列表」加的
   页内预览与选中态（`hooks/useMarketSelection.ts`、`lib/marketPreviewSelection.ts`、
   `lib/marketPreviewSync.ts`）在该列表上不再有生产消费方（只剩各自单测）；Meka 自己的 Skill Hub
   仍用同一详情组件做页内预览 ⇒ 功能未丢。与 §6.14 第 3 条为同一事实，此处按「需明知」汇总，
   登记为**有意接纳的上游重构**。
3. **zh-TW 之外的同类品牌占位缺口（存量、未修、未纳入本次）**：
   `localDbFatal.databaseCleanup.recoveryFailedDescription` 在**五语全部**以固定字符串写出
   `Cindy`（en / zh-CN / zh-TW / ja / ko 同形，不是占位符漏改，因此不产生跨语不一致），
   与本次修的 §6.15 第 6 条（zh-TW 两条**占位符漂移**）**不是同一形态**。
   现有门禁都拦不住它：`i18nBrandPlaceholder.test.ts` 只覆盖 `updateReady` / `preparing` /
   `applyExhausted` 三条 description；`brand-terminology-guard.mjs` 只拒 `XDMaker|XD Maker|xdt-maker`。
   ⇒ 按 `AGENTS.md`「非本次修改引入的存量问题不擅自修」**保持原状**，登记待维护者裁决
   （若要收口，做法与第 6 条同类：五语改用 `{{appName}}` 并把该 key 纳入
   `i18nBrandPlaceholder.test.ts` 的断言集合）。

## 6.16 `pnpm test:unit` 首跑 6 处失败：逐条定性与处置

首跑（**并行跑门禁**的窗口内）结果：`apps/desktop` 4 个测试文件失败、`packages/maker-remote-ssh` 10 条、`packages/lizi-mcps` 1 条 `COMMAND_FAILED`。逐条定性后，**4 处是真实红**（已修）、**2 处是环境性假红**（登记 remedy，未改仓库）。

### 真实红（均已修，各自实跑全绿）

| # | 失败位置 | 定性 | 处置 |
| --- | --- | --- | --- |
| 1 | `renderer/features/plugin/__tests__/MarketPluginDetailView.test.tsx`：`replaces the install action with a spinner while busy` | **合并引入**：测试文件三侧 hash **完全相同**（既非上游本轮新增、也非 Meka 改写），断言写的是「裸 `<button>` 把子节点整个换成 Spinner」时代的实现细节；合并把上游**共享 `Button`** 结构接进来后，`loading` 是「子节点收进 `opacity-0` 遮罩」而非删除子节点 | **只改测试、组件零改动**（Meka 的 `loading={busy && !progress}` + `progress` 渲染分支是必须保留的产品差异）。断言改为**两态覆盖**：忙且无 `progress`（spinner 生效、install 文案在 `opacity-0` 遮罩内、可访问名称保留）；忙且有 `progress`（**新增用例**：进度文案可寻址且可见、`.animate-spinner`/`.opacity-0` 均不存在、进度条 `width: 25%`）。变异复核证明新断言非空转（删进度分支 / `loading={false}` 各触发一条失败）。**保留 `aria-label={busy && progress ? undefined : t(actionKey)}`**：若改为恒取 action 文案，`aria-label` 会覆盖子节点文本，而主操作此刻唯一的进度播报通道就是该文本（本组件无 `role="status"`），且 `GhostPluginPage.tsx` 同口径；改后会让列表/详情语义分叉。实跑 **7/7** |
| 2 | `renderer/components/settings/__tests__/settingsSearchCatalog.test.ts`：`keeps the declaration catalog complete and unique`（`meka-assistant: expected false to be true`） | **合并引入的空缺**：上游 `cae5f1796b`（#4973）新增整套设置搜索基建（catalog + `*.settings-search.ts` sidecar + 完整性守卫），在 merge-base **不存在**；而 `meka-assistant` 只存在于 Meka 的 `TAB_IDS`，上游 29 个 sidecar 里没有任何 meka 声明 | **补声明**：新增 `MekaAssistantSettingsSection.settings-search.ts`（1 条 tab 级 + 4 条卡片级，指向 `SettingsView.tsx` 已有的 `settings-panel-meka-assistant` 与新增的 `settings-search-target-meka-assistant-*` 真实锚点）；新增唯一 i18n key `settings.meka.design.title`（五语齐备）；`MekaAssistantSettingsSection.tsx` **只加同行 id 属性**（文件仍 648 行，白名单文档的既有行号锚点全部继续有效）。`tabLabels.ts` 一行未动（WL-1.1 位次不变）。实跑 catalog **12/12**、`tabLabels.test.ts` **4/4**、`pnpm check:i18n` 五语 **11102** key 一致 |
| 3 | `renderer/__tests__/modelVisibilityPrefs.test.ts`：`初始化 failure diagnostics > 外部修好损坏 initialization 后，同一生命周期内重新加载可恢复目录` | **上游新用例 × Meka 上一轮差异化实现**：用例是上游本轮新增（HEAD/merge-base 零命中）；实现侧 Meka 的补种（`28b97ee52e`，上一轮 P0 修复）把「**存在但空清单的既有记录**」也算命中，于是 `state = { ...base, eligibleForDefaults: true, … }` **覆盖**外部判定 | **修实现、收窄补种条件**：`needsMekaSeed` 增加主判据 `stored === null` —— **只有「这份配置从来没写过初始化记录」才补种**，已有记录一律权威。依据：本轮语义下可见性**不读** `initialization.defaults`（`isModelEnabled` 最终仍是 `override ?? defaultEnabled`），空清单不再隐藏任何路线，故该支补种不承重；而「无记录」这一支（真正的合并前老 Meka 用户）补种逐字不变。测试侧改名 + **新增**「记录不被改写、不写补种标记」断言。**WL-10 回归判据**：`packages/model-providers/src/sections.ts` 与 `modelVisibilityPrefs.ts:842-857` 的兜底仍是 `override ?? defaultEnabled`，**没有「无清单 ⇒ 不可见」分支**；`effectiveMap` 只推 override 表、仅损坏态带 `fallback:false` ⇒ 上一轮 P0 形态未回归。实跑：`modelVisibilityPrefs.test.ts` **88/88**、同列 WL-10 套件 **251/251**、`model-visibility-mirror.test.ts` **16/16**、`@cindy/model-providers` **115/115** |
| 4 | `main/cindy-make/__tests__/personalBuild.test.ts`：`retains the app from personal and cleans unpublished copies`（期望 `out\Cindy-win32-x64`、实得 `out\CindyMeka-win32-x64`） | **上游新用例硬编码产品名**：期望值是测试字面量，实际值由 `personalBuild.ts:501 brandExecutableName(region)` **从身份正本派生**（上游实现本来就对） —— 即上游用例写死 `'Cindy-'`/`'Cindy.app'`，Meka 的产品名是 `CindyMeka` | **改测试**：期望值改为从正本派生（`brandExecutableName('global')`），并**加强**一条 `expect(input.appName).toBe(appName)`；新增代码不写 `'CindyMeka'` 字面量（WL-6.1 单点）。实跑 **32/32** |

### 环境性假红（未改仓库，登记 remedy）

1. **`packages/maker-remote-ssh` 10 条**（`remote-agent-installer.test.ts`）：报告的错**全是 teardown 的 `EBUSY`**（`rmdir` 撞占用），而 JS 里 `finally` 抛错会**替换**正在传播的断言异常 ⇒ 真状态被掩盖。
   根因是**本机 `bash` 解析到 `C:\Windows\system32\bash.exe`（WSL 启动器）**，两处独立破坏：
   (a) WSL 会把 `bash -c` 参数里的 `$VAR` / `$(...)` **再展开一遍**（实测 `declare -f verify_codex_layout` 里 `root` 已变成 `"."`、`uname` 覆写被吃掉），于是 layout guard 恒返回 1；
   (b) WSL 进程退出后短暂持有 fixture 目录 cwd，`rmSync` 立即 `rmdir` 撞 `EBUSY`（实测 Node 22 下 **async `rm` 的 `maxRetries` 会重试、`rmSync` 的完全不重试**）。
   **决定性证据**：把 `C:\Program Files\Git\bin` 前置到 PATH 后，**未改动的上游原文件 18/18 全绿**，整包 **238 passed / 3 skipped**。
   这与本仓**已登记 3 次**的同一类环境事实一致（`docs/migrations/2026-09-18-...md:325,330`、`docs/migrations/2026-09-...md:645,657`、`meka-whitelist-verification.md:2622`、`meka-injection-layer.md:824`，原文口径即「必须把 Git Bash 置于 PATH 之前」）。
   ⇒ **处置：不改仓库代码/夹具**（根因在环境；改上游测试会在 synced 文件上制造需登记的 Meka 偏离）。最终门禁按既有口径**前置 Git Bash** 执行。
   （可选硬化补丁已验证存在但**未落地**：layout guard 由 `bash -c` 改 `bash -s` + stdin、两处 teardown 换 async `rm(..., { maxRetries: 10, retryDelay: 100 })`；若维护者希望「即使用 WSL bash 也全绿」再单独立项。）
2. **`packages/lizi-mcps` 的 `COMMAND_FAILED`**：**并发资源争用的假故障**。无并发下按同一条门禁命令该 workspace **4/4 全绿**（61.5–82.8s，`67 files / 897 passed / 3 skipped`），而失败那次只有 **14.0s ≈ 正常时长 1/5**，且 `classifyFailure` 只在「exit≠0 且输出不含任何断言/收集/超时关键字」时才归 `COMMAND_FAILED` —— 符合子进程在启动/取资源阶段被打死。当时确实是 `pnpm test:runner` + `pnpm test:unit` + `pnpm test:db` 三路并发。
   ⇒ **处置：不改仓库代码**；最终门禁**独占串行**执行（本节同时也是「为何要独占跑」的记录）。
3. **`src/main/skillhub/__tests__/localSkillTarget.test.ts` 的 1 条**（`detects replacement of a directory after the confirmation snapshot`）：
   首跑红（`localSkillTarget.test.ts:93`：`expect(isLocalSkillTargetCurrent(target)).toBe(false)` 得 `true`），
   **隔离单跑 25/25 全绿、最终独占全量跑亦全绿** ⇒ **flaky**。
   定性与出处：**非本轮引入**——该测试文件与其被测实现 `localSkillTarget.ts` 在
   `base..origin/main` 与 `base..HEAD` **两侧都零改动**；检测信号是
   `JSON.stringify([source, entry.dev, entry.ino, physical.dev, physical.ino])`（`localSkillTarget.ts:37`），
   而用例做的是「`renameSync` 掉目录 → 同路径重建 → 断言 inode 已变」。**Windows/NTFS 会复用目录的
   文件 ID**，在整包高并发下这个窗口更容易命中，故表现为只在全量运行中偶发。
   ⇒ **处置：只登记不改**（改上游-owned 的测试/实现会制造需登记的 Meka 偏离；且本轮最终全量已绿）。
   建议维护者后续若频繁命中，可把该断言改为「快照与当前不一致」的等价但更稳的判据（例如同时比对
   `birthtimeMs` 或先制造一个可区分的次级差异），而不是依赖 NTFS 不复用文件 ID。

### 顺带登记的存量项（未修，非本轮引入）

- `scripts/shared/pnpm-invocation.mjs:28-30` 的 `resolvePnpmInvocation` **裸信任 `npm_execpath`**，而 `scripts/test-workspaces.mjs:861/909` 调用它时**没套**已存在的 `usablePnpmExecPath` 校验（`desktop-dev-runner.mjs`、`ensure-deps.mjs` 都套了）。于是**不经 pnpm 直跑门禁**会调起 npm 并得到**同形态的假 `COMMAND_FAILED`**：
  `node scripts/test-workspaces.mjs --tier unit --workspace packages/lizi-mcps` → `Unknown command: "…\packages\lizi-mcps"` → `FAIL COMMAND_FAILED (297ms)`。
  三侧（merge-base / `origin/main` / HEAD）该实现完全一致 ⇒ 存量。**影响**：任何用 `node scripts/test-workspaces.mjs` 直跑门禁的人都会看到与本次同形态的假红，容易被误判成业务失败。
- `packages/lizi-mcps/src/__tests__/sessionContext.test.ts:92/:102` 重复键 `idleWorker`（esbuild warning，HEAD 已有）。
- `packages/model-providers/node_modules/@cindy/model-access-protocol` 是指向已移除子模块的**悬空 junction**（安装残留；全仓无源码 import 它）。⇒ 最终门禁前应跑一次 `pnpm install` 刷新（本轮已执行过 `pnpm install`，若仍在则属 node_modules 残留，不影响门禁）。
- `apps/desktop/src/renderer/state/modelVisibilityPrefs.ts:819-822` 的注释仍称「main 侧可见性快照由 `effectiveMap` 从 `initialization.defaults` 派生」，与当前语义相反（测试明确断言 defaults 不进载荷）。存量过期注释，未改。

## 6.17 身份字面值硬编码：本轮接纳上游新增子系统后暴露的一类回归（WL-6.1）

上游本轮新增/大改的子系统在 `meka/main` 上**零 Meka 适配**（`git diff origin/main -- <目录>` 为空），
于是把**上游身份字面量**当成唯一合法值，与 Meka 由身份正本派生的 `CindyMeka` / `CindyMekaDev` 不符。
这类回归的共性是：**代码都在、测试也绿**（配套测试的 fixture 同样写死上游名，自洽通过），
只有语义验收能拦——正是白名单清单 §1 点名的形态。逐条如下。

### 已修（用户逐项裁决纳入）

| # | 位置 | 症状 | 修法 |
| --- | --- | --- | --- |
| 1 | `main/cindy-make/__tests__/personalBuild.test.ts` | 上游新用例写死 `out/Cindy-<plat>-<arch>` / `'Cindy.app'`，而实现 `personalBuild.ts:501 brandExecutableName(region)` 派生 `CindyMeka` ⇒ 红 | 期望值改为从正本派生 + **加强**一条 `expect(input.appName).toBe(appName)`；不写 `CindyMeka` 字面量。实跑 **32/32** |
| 2 | `main/cindy-make/versionStartup.ts:175/181/185` | **功能整体失效**：身份白名单 `['Cindy','CindyDev']`、marker 词表与默认名都写死上游名；Meka 的 profile 被自己拒绝 → 版本交接（`:242`）与「双击已保存版本」（`:279`）抛 `versionError('unavailable')`，而 `index.ts:53` 每次启动都调用 ⇒ **个人版版本启动/重启在 Meka 下不可用** | 身份名改为 `brandExecutableName()` / `brandExecutableName('dev')` 派生；上游名作 legacy 只读保留（`APP_NAMES`）；无 marker 分支改为显式 `UNMARKED_APP_NAMES` 闭集（**未**放宽成「任何名字都接受」）。测试新增 6 段断言（当前默认名 / 当前 dev 名 / legacy dev / legacy 默认名被接受 + **两条反例**：词表外名字、未认领 dev 仍拒绝）；**回归守卫实证**：临时换回上游白名单 → 新用例红，改回后 **22/22** |
| 3 | `main/linuxInstallation.ts:33` | **存量**（该行 merge-base / `origin/main` 逐字相同，Meka 从未适配）：`basename(exe) !== 'Cindy'` ⇒ `recognizeLinuxUserInstallation()` 在 Meka 下永不命中 | 改为 `INSTALLED_EXECUTABLE_NAMES` 闭集（正本默认名 + 正本 dev 名 + legacy `Cindy`/`CindyDev`）；**保留闭集语义**。测试 fixture 改派生 + 新增用例（当前名 / legacy 名被识别、`CindyMekaImpostor`/`cindymeka`/未知名被拒）；**回归守卫实证**：换回上游写法 → **9 failed / 3 passed**，改回后 **12 passed** |
| 4 | `main/index.ts:200-203` | **存量**：钥匙串标记处置提示指示用户把 marker 修成 `"Cindy"` / `"CindyDev"`（用户可见的上游身份副本） | 身份名改为 `BRAND_IDENTITY.executableName` / `.executableNameByRegion.dev` 插值；并补一句「上游旧身份名同样可读，标记内容已是其中任一个都无需改动」。仅此一处 hunk，未动周围诊断逻辑与 `interpretMarker` 的 legacy 读取语义 |

**身份单点核对（WL-6.1）**：上述三处实现侧身份名**全部经 `brandExecutableName()` 从
`packages/maker-shared/src/brandIdentity.ts` 派生**，被改文件中不再有 `CindyMeka` 字面量；
上游名只出现在「命名即声明 legacy 只读」的常量里（与既有先例 `devCliFlags.ts:118-124`
的 `OFFICIAL_USER_DATA_DIR_NAMES`、`devKeychainName.ts` 的 legacy 词表同构）。
读侧词表与写侧（`devKeychainName.ts` 认领 marker）**取值同源**，不再出现「写 `CindyMeka`、只认 `Cindy`」。

### 只登记、未修（用户裁决 B：不动 Linux 安装链路）

**Linux 用户级安装链路在 Meka 下会直接装不上**（比上面第 3 条更严重：不是「识别不到」而是「装不上」）。
- 证据链：
  - **打包侧用正本**：`forge.config.ts:105 CINDY_EXE = brandExecutableName(CINDY_REGION)`；
    `ci/lib.mjs:70 PACKAGED_APP_NAME='CindyMeka'`、`:79-83 PACKAGED_APP_NAME_BY_REGION`；
    `package-desktop.mjs:811` → `out/CindyMeka-<platform>-<arch>`。
  - **build-info 与安装脚本写死上游名**：`forge-linux.ts:14` 的 `stageLinuxBuildInfo` 写
    `region === 'dev' ? 'CindyDev' : 'Cindy'`（**与上游逐字相同，merge-base 已存在**，由
    `forge.config.ts:2050` 在 linux postPackage 调用）；`resources/linux/install-user.sh:69/:104/:110`
    要求 `$payload/Cindy`；`install-omarchy.sh:61/:69/:194` 的 `${fields[4]} == Cindy` 同理。
  - **后果**：Meka 载荷二进制是 `CindyMeka`，build-info 声明 `Cindy`、安装器要求 `$payload/Cindy`
    ⇒ 以 `Incomplete application.` / `Unexpected executable identity.` 失败。
  - **门禁为何没拦**：`scripts/__tests__/brand-identity-sync.test.mjs` 的镜像一致性断言只覆盖
    `ci/lib.mjs`、`smoke-packaged.mjs`、`restart-desktop-remote.mjs`、`desktop-dev-region.mjs`、
    `apps/desktop/package.json`，**不含 `forge-linux.ts` 与这两个 shell 脚本**。
- **未修的理由（用户裁决 B + 本机约束）**：相关 6 个用例是 `skipIf(process.platform !== 'linux')`，
  本机（Windows）**改完无法实跑自证**；只改 fixture 而不修整条 chain 会让这些用例在 Linux CI 转红。
  按 `AGENTS.md`「非本次修改引入的存量问题不擅自修」保持现状。
- **建议下一单的修复方向**（供维护者直接采用）：`forge-linux.ts` 的 build-info executable 改为从
  `executableNameByRegion` 取值；`install-user.sh` / `install-omarchy.sh` 改为**只读 build-info 的
  executable 字段**而不是写死 `Cindy`；同批更新 `linuxInstallation.test.ts` 的 `'Cindy'` fixture；
  并把 `forge-linux.ts` 纳入 `brand-identity-sync` 的镜像一致性断言（否则同类漏配会再次静默通过）。

## 6.18 `pnpm test:db`：先是 Windows 命令行长度失效，修好后暴露出 6 个失败

### 6.18.1 门禁失效本身（合并引入）与修复

- **现象**：Windows 上 `pnpm test:db` 直接 `FAIL COMMAND_FAILED apps/desktop db (1.8s)`，
  子进程输出是 GBK 乱码 `������̫����` = 中文 Windows 的 **「命令行太长」**。
- **机制**：该 tier 的 `vitest run` **显式列出 125 个文件**（+ 2 个 `--exclude`），
  参数串 **7422** 字符、完整 invocation **7519** 字符；超限发生在 **pnpm → vitest** 那一层
  （vitest 的 Windows `.cmd` shim 走 cmd.exe，硬上限 8191，本机实测有效上限约 7.2k：
  用等长假 filter 直接测 vitest，`approxLen≈7100` 正常启动、`≈7436` 报 `The command line is too long.`）。
  注意最外层不是 cmd.exe —— `pnpm-invocation.mjs` 对 JS 入口（`pnpm.cjs`）返回 `shell: false`。
- **为什么是合并引入**：上一轮（`2026-09-18`）该 tier 为 PASS；本轮上游新增了一批 db 测试文件
  （`taskTags.test.ts`、`taskTagsBroadcast.test.ts`、`sharedTasks.test.ts`、`botRemoteEditors.test.ts`、
  `botRemoteSettingsResource.test.ts` 等）把清单顶过上限。**即此前该 tier 根本没跑到 vitest 那一层**，
  这也解释了为什么本轮早期看到的 `test:db` 红全是同一个 `COMMAND_FAILED`。
- **修复**（`scripts/test-workspaces.mjs`，+277/−56）：把 pnpm 参数拆成
  「可重复前缀 / 文件列表 / 必须保留的后缀（全部 `--exclude`）」，新增
  `commandLineLength` / `maxInlineCommandLength(platform)`（win32 = **6000**、POSIX = 120000）/
  `planPnpmArgBatches`，**超限时分块顺序执行并聚合结果**，任一失败 ⇒ tier 失败（失败不提前中断，
  保证日志完整）；**不超限时恰好 1 批、行为与旧实现逐字节相同**（其余 36 个 tier 全部 1 批）。
  带 `--shard` 的 tier 刻意**不分块**（逐批 shard 会跑到与请求不同的子集）。
- **未削弱门禁的证据**：125 个文件 → 2 批（99 + 26），并集与顺序与原选择完全一致、每批都带两个
  `--exclude`；真机扰动验证「分块失败不会被吞」（把第 2 批一个文件改错 ⇒ 该批 `3 failed → 4 failed`、
  标记与 `文件:行号` 出现在 `chunk 2/2` 块内、tier FAIL/exit 1；扰动已按 SHA256 证明还原）；
  `node --test scripts/__tests__/test-workspaces.test.mjs` **86/86 pass**。
- **文档**：新增/补充 `docs/dev-rules/desktop-unit-test-performance.md` 的「Windows 命令行长度预算与
  tier 分块」一节（含阈值、不变量、取证方式与未覆盖项）。

### 6.18.2 修好后暴露的 6 个失败：逐条定性

| # | 文件 | 定性 | 处置 |
| --- | --- | --- | --- |
| 1 | `localDb/__tests__/taskTags.test.ts`（12/12） | **合并引入**：fixture 按**上游原号**引用 `0110_abandoned_scarlet_witch.sql` / `0111_messy_newton_destine.sql` / `0112_backfill_task_tag_order.sql` / `0113_grey_cannonball.sql`，而 D4 顺移后本仓文件名是 `0113`/`0114`/`0115`/`0116` | 改为真实 Meka 号（映射用 blob SHA 与 `origin/main` 原号文件逐一比对，**5 条全部 IDENTICAL** ⇒ 改到的是「正确那一条」而非「碰巧存在的一条」）。**易错点**：`0113_grey_cannonball.sql` 这个名字在磁盘上**不存在**（当前 `0113` 是 `abandoned_scarlet_witch`），故漏改是 **ENOENT 硬失败**；即便把第 4 槽误指向 `0113_abandoned_scarlet_witch.sql` 也会抛 `table session_task_tags already exists`，指向其它可加载的错文件则挂在该用例自身的 `nameCustomized` 断言上 ⇒ **每种错法都是硬失败，不存在「静默通过」**（此点由子代理实测纠正了本报告初稿的措辞） |
| 2 | `localDb/__tests__/taskTagPresetMigration.test.ts`（2/2） | 同上 | 同上 |
| 3 | `localDb/__tests__/sharedTasks.test.ts`（9/9） | 同上（引用 `0114_shared_task_events.sql` ⇒ 本仓 `0117_shared_task_events.sql`） | 同上 |
| 4 | `localDb/worker/__tests__/sessionImportShareTx.test.ts`（9/9） | 同上（`0114_shared_task_events.sql`） | 同上 |
| 5 | `localDb/__tests__/dbSlimmingUpgradeOrder.test.ts`（1/2） | **合并引入**：源码形态契约断言期望字面量 `await runMigrations(db, filePath)` 且位于 `runSchemaStartupPolicy` 之后，而合并后的 `localDb/index.ts:356` 已改为**回调** `runMigrations: () => runMigrations(db, filePath)` ⇒ `indexOf` 得 −1 | 把断言的**文本形态**更新到回调写法，并**保住它守护的不变量**（迁移必须在 startup policy 决策之后执行），优先改为符号优先判据以免下次格式微调又假红 |
| 6 | `localDb/__tests__/backup.test.ts`（3/16） | **宿主环境**：该用例用 `ftruncateSync` 造 3 个 13 GiB 备份文件（`openSync(p,'w')` 未设 sparse ⇒ NTFS 真分配），本机 C: 仅剩约 10.5 GB ⇒ `ENOSPC`。不是代码问题（APFS 上 ftruncate 是真稀疏，故历史上不报） | **登记为「未验证 + 原因：宿主磁盘不足（需约 39 GB，本机剩约 10.5 GB）」**，不改代码、不删用例 |

- **已证明这 6 条与分块修复无关**：用**单次 324 字符**命令（远低于阈值 ⇒ 规划器只出 1 批）直接跑这
  6 个文件，**以完全相同的错误全部失败** ⇒ 既不是分块引入，也不会被分块掩盖。
- **第 3 项与 §6.18.1 的关系**：这正是「修好门禁后才看见的真问题」——长度失败把整层 `db` tier 的
  真实结果**掩盖**了整整一段时间，与 §6.15.2 的「`buildResources` 掩盖层」是同一类教训。

### 6.18.3 修复后的最终结果（实跑）

```
CHUNK 1/2 apps/desktop db test (99 files, 5965 chars)
  Test Files  1 failed | 98 passed (99)
  Tests       3 failed | 1318 passed (1321)      ← 3 条全部是 backup.test.ts 的 ENOSPC
CHUNK 2/2 apps/desktop db test (26 files, 1632 chars)   ← 全过
FAIL TEST_ASSERTION_FAILED apps/desktop db (215.6s)
chunks: 2 sequential invocations (explicit file list split to fit the 6000 character command-line budget)
```

- **第 1–5 项已全部修好**（4 个迁移文件名引用 + 1 条源码契约断言）；`backup.test.ts` 是**唯一**残留，
  且定性为宿主磁盘不足。`backup.test.ts` 在 `base..origin/main` 与 `base..HEAD` **两侧都零改动**
  ⇒ 该红**不是本轮引入**，也与分块无关（分块前该 tier 根本没跑到 vitest 层，所以它此前一直被
  长度失败掩盖）。
- **配套常驻回归测试**：`scripts/__tests__/test-workspaces.test.mjs` **+588 行 / 9 条新用例**
  （真实 tier 的「batch=1 与旧实现逐字节相同」、真实 db tier 在 win32 阈值下分块而 POSIX 不分块、
  并集与顺序不重不漏、每批带全量 `--exclude`、前缀逐字节相同、贪心紧致性、退化单文件不丢、
  `--shard`/`packageScript` 不分块、related 模式、失败传播与单批输出逐字节一致）
  ⇒ `node --test scripts/__tests__/test-workspaces.test.mjs` **95/95 pass**（原 86）。
  反向验证：把 win32 阈值临时降到 2000 时「只有常量钉死那条失败、全部分块断言照过」；
  降到 100 时退化分支被合法触发（由专门的退化用例覆盖）——**证明新断言不是空转**，扰动后已按
  SHA256 完整还原。
- **文档**：`docs/dev-rules/desktop-unit-test-performance.md` **+63/−0**，新增
  「Windows 命令行长度预算与 tier 分块（2026-09-24 第三轮上游同步后实查）」一节，
  写明事实（cmd.exe 上限、本机约 7.2k 有效上限、db tier 125 文件/约 7.4k 字符）、机制
  （三段拆分 + `maxInlineCommandLength` win32 6000 / POSIX 120000 + 超限贪心分批并聚合）、
  不变量（不得减少被跑文件、每批全量 `--exclude`、任一失败即 tier 失败且不提前中断、
  `--shard` 不分块）、取证方式与**未覆盖项**（POSIX 上该保护惰性、related 分支无真实 tier 触发）。

## 7. 白名单验证（阶段 A–D）

> 依据 `docs/dev-rules/meka-whitelist-verification.md` §2 的四阶段口径：
> **阶段 A = 结构审计** `/ **阶段 B = 自动化验收（§4 最小自动化集合）** / **阶段 C = 实机验收（§5）** /
> **阶段 D = 结论**。本节只登记**实际跑过**的命令与输出；未跑项逐条标注「未跑 / 待跑」，
> 不得据本节宣告合并已验收。阶段 C、D 由调度者回填。

### 7.1 阶段 A — 结构审计（实跑）

命令：`pnpm audit:merge -- --worktree`

| 轮次 | 结果 |
| --- | --- |
| 首跑 | `blockers=0 dropped=8 review=0 generated=46`，`verdict: FAIL`（因 DROPPED > 0） |
| 二跑（含逐条确认后的 `--allow` 豁免） | `blockers=0 dropped=0 review=0`，`verdict: PASS (有待确认项)` |

**8 个 DROPPED 的逐条确认与豁免理由**：

1.–5. `apps/desktop/drizzle/0110_abandoned_scarlet_witch.sql`、`0111_messy_newton_destine.sql`、
   `0112_backfill_task_tag_order.sql`、`0113_grey_cannonball.sql`、`0114_shared_task_events.sql`
   —— 上游原号被**有意**按 D4 顺移为 Meka `0113..0117`，SQL 正文**逐字节保留**；见 §4.1。
6. `apps/desktop/scripts/check-windows-installer.mjs` —— Meka 侧旧注释里「forge.config.ts 未设
   `buildResources`」的前提被上游 `7582de5f20` 推翻，注释已改写（**纯注释**，见 §6.15.2）。
7. `apps/desktop/src/renderer/components/new-chat/VendorSegmentedSwitcher.tsx` —— Meka 侧新增的
   `disabledVendors` prop 是**死代码**（全仓 `git grep disabledVendors` 零命中），随上游薄适配器重写
   一并消失，**无行为损失**。
8. `apps/desktop/src/renderer/features/plugin/MarketPluginDetailView.tsx` —— Meka 的 `progress` 语义已在
   **上游 `Button` 新结构**上保留（`loading={busy && !progress}`、
   `aria-label={busy && progress ? undefined : …}`、`progress` 渲染分支），消失的只是上游结构已替换掉的
   旧标记行。

**`GENERATED` 46 项的说明**：34 个 drizzle snapshot（§4.1 的 delta 变换 + `drizzle-kit generate`
无 drift）、11 个第三方声明文件（已跑 `pnpm licenses:generate` 重新生成）、`pnpm-lock.yaml`
（已 `pnpm install` 重建）。

### 7.2 阶段 B — 最小自动化集合（逐项实跑）

| 命令 | 结果 |
| --- | --- |
| `pnpm audit:merge -- --worktree`（含上述 `--allow`） | ✅ PASS（blockers 0 / dropped 0 / review 0） |
| `pnpm test:runner` | ✅ `# tests 684 / pass 677 / fail 0`，exit 0（注：§8.1 记录的 3 个存量红灯本轮**已全部转绿**） |
| `pnpm --filter desktop typecheck` | ✅ exit 0（首跑 8 个错误已全部修掉，见 §6.15.1） |
| `pnpm --filter desktop run db:validate` | ✅ 6/6 步：`0000..0117` **118 个 SQL**、journal/snapshot 对齐、`drizzle-kit check` 通过、**44 个 companion 均 CJS**、固定基线 80 SQL + 23 脚本、canonical 基线 113 SQL + 44 脚本 |
| `pnpm --filter desktop exec drizzle-kit generate` | ✅ `No schema changes, nothing to migrate`（证明 `0117_snapshot.json` 与合并后 `schema.ts` 一致） |
| `pnpm check:i18n` | ✅ 五语共 **11101** 个 key 全部一致，exit 0 |
| `pnpm check:i18n-glossary` | ✅ exit 0（待裁决术语告警 20 处，不阻断） |
| `pnpm check:brand-terminology` | ✅ PASS |
| `pnpm check:endpoints` | ✅ PASS |
| `pnpm check:design-inventory` | ✅ exit 0（`GENERATED 区块最新（55 个 surface）`） |
| `pnpm check:dev-docs` | ✅ 9/9 pass，exit 0 |
| `cargo build --release --manifest-path apps/desktop/cindy-updater/src-tauri/Cargo.toml` | ✅ exit 0 |
| `node apps/desktop/scripts/check-windows-installer.mjs` | ✅ exit 0：生产安装器 / 卸载器编译（warnings as errors）+ **14 个 native 场景全 exit 0** |
| `node apps/desktop/scripts/test-winget-shortcuts.mjs` | ✅ exit 0 |
| `pnpm licenses:generate` | ✅ exit 0（此前因入库的 `cindy-meka-updater.exe` 失败，见 §6.15.5） |
| `pnpm test:unit` | ✅ **exit 0**（独占串行 + PATH 前置 Git Bash）：24 个 workspace 全部 `PASS`（含 `apps/desktop unit (648.1s)`、`apps/mobile unit`、`packages/lizi-mcps`、`packages/maker-remote-ssh`），段内 `test:runner` `# tests 684 / pass 677 / fail 0`。首跑的 4 处真实红与 2 处环境性假红见 §6.16 |
| `pnpm test:db` | ⚠️ **修好命令行长度后仍 exit 1，但只剩宿主环境限制**：该 tier 现按 §6.18.1 分 2 批执行（`CHUNK 1/2 … 99 files, 5965 chars` / `CHUNK 2/2 … 26 files, 1632 chars`），
`98 passed (99)` + 第二批全过；唯一失败是 `localDb/__tests__/backup.test.ts` 的 3 条 **`ENOSPC`**（该用例要造 3 个 13 GiB 备份文件、需约 39 GB，本机 C: 仅剩约 10.5 GB）⇒ **登记为「未验证 + 原因：宿主磁盘不足」**，非代码失败（见 §6.18.2 第 6 条） |

> 上表「§8.1 记录的 3 个存量红灯」指 `docs/dev-rules/meka-whitelist-verification.md` §8.1 第 1 条
> 登记的三条 `test:runner` 存量红灯（`design-inventory.test.mjs:1158`、
> `hardcoded-color-audit.test.mjs:216`、`:372`）—— 本轮**已全部转绿**。
>
> 不在上表内的定向套件（如 §6.15.4 的 `mekaDownloadPolicy.test.ts`、§6.15.6 的
> `i18nBrandPlaceholder.test.ts`）**未跑**，不得记为通过。

### 7.3 阶段 C — 实机验收（实跑）

一键序列全部实际执行；合并提交为 `1d42753a22`。

| 步骤 | 结果 |
| --- | --- |
| `pnpm restart:desktop:remote` | ✅ `DESKTOP_DEV_VERDICT=ready`，`sandbox=dev`、`region=global`、`commit=1d42753a22…`（= 本次合并提交） |
| `pnpm desktop:whoami` | ✅ `DESKTOP_DEV_VERDICT=ready`，`Desktop source: MATCH`，唯一实例 `commit=1d42753a22…`。（初跑时另有一个**陈旧实例** `03f0d17864` 占同一 userData，已终止后再核） |
| `pnpm desktop:ui-smoke` | ⚠️ **checks=15 / pass=13 / fail=2 / unverified=0**（详见下「①」） |
| `pnpm desktop:session-smoke` | ⚠️ **checks=11 / pass=2 / fail=9 / unverified=0**（详见下「②」）；其中 **`WL-11.4` PASS：真实建会话并调用模型跑完一轮，回复 `"收到"`** |

#### 阶段 C 中发现并修复的 3 处**门禁脚本自身缺陷**（均为合并引入或本轮首次暴露）

1. **`role=combobox` 不再唯一 → WL-13 五语横切整段失效**（`scripts/meka-ui-smoke.mjs`）。
   上游 `cae5f1796b`（#4973）在**通用设置页顶部**新增设置搜索框，它是
   `<input type="text" role="combobox" aria-label="搜索设置">`，且 DOM 顺序排在语言选择器**之前**
   ⇒ 原来的 `'[role=combobox]'` 点到搜索框，语言菜单列不出选项，WL-13 提前 `unverified` 返回
   （**整段五语横切根本没跑**），`main` 里的语言归一也一并失效。
   实测判别：语言触发器是 `<button role=combobox>`（展开 6 个 `[role=option]`），搜索框是 `<input>`
   ⇒ 改为 `'[role=combobox]:not(input)'`（唯一命中）。修好后 WL-13 真正跑完五语并 **PASS**
   （`English→「Meka Assistant」…한국어→「Meka 어시스턴트」`）。
2. **裸 i18n key 检测误报域名 → WL-13 假红**（同文件）。检测正则
   `(settings|meka|sidebar)\.[a-zA-Z][a-zA-Z0-9_.]{3,}` 会命中界面里正常渲染的 MCPRouter 地址
   `https://mcpr.meka.pawdy.fun/` 中的 `meka.pawdy.fun`。改为**与语言目录真实 key 集合求交**
   （`CATALOG_KEYS`，12777 条；`meka.pawdy.fun` 不在其中 ⇒ 不再误报；真实裸 key 必然在目录里
   ⇒ 检测能力**未被削弱**）。该误报此前一直被缺陷 1 掩盖。
3. **主窗口识别漏 `remoteDesktopViewer` → 两个 smoke 脚本整片假红**
   （`scripts/meka-ui-smoke.mjs` **与** `scripts/meka-session-smoke.mjs`）。
   dev 启动会额外开出 `?remoteDesktopViewer=1#/remote-desktop-viewer` 窗口；原排除表只有
   `sidebarWindow|resourceUsageWindow|view=`，脚本会连到查看器窗口 ⇒ ui-smoke 报
   「面板里找不到「配置」按钮」、session-smoke 报「侧栏缺少 Meka 分区：远程桌面 | 连接中…」
   这种**误导性结论**。改为补充排除 `remoteDesktopViewer` 并**优先选择不带查询串的页面目标**。
   > 这条正是 `2026-09-18` 报告 §7.8.7 已登记、**建议改为「URL 无 query = 主窗口」白名单**的
   > 既有缺陷（当时标注「未改」）—— 本轮按该建议实现。

#### ① `ui-smoke` 的 2 处 FAIL：**沙箱已连接**，非回归

`WL-1.2`（MCPRouter「配置」）与 `WL-1.3`（MekaDesign「配置」）：两者都要求**未配置**态才渲染
「配置」按钮（`MekaAssistantSettingsSection.tsx:418-432` / `:583-596`：
`configured` 为真时渲染的是「断开」）。本机唯一已登录沙箱的 MCPRouter 与 MekaDesign
**都已连接**（DOM 实测按钮 = `["","选择目录","","断开","","","","断开"]`，状态胶囊含两处「已连接」），
因此这两项按其原口径**无法在该沙箱上执行**。

**为什么判定不是回归**：合并相对合并前 `09e8bb6132` 对该文件的改动**只有 5 行**
（4 个 `id="settings-search-target-meka-assistant-*"` + MekaDesign 标题改走
`settings.meka.design.title`），**「配置」按钮与对话框的逻辑一字未动**；
`MekaRouterConnectDialog.tsx` 合并前后**零改动**。
未断开的理由：断开会让服务端吊销 MCPRouter 凭证（**不可再生**），破坏 WL-4 后续端到端验收的前提。

⇒ **登记为「未验证 + 原因：唯一已登录沙箱的 MCPRouter/MekaDesign 已连接，配置入口被「断开」替代；
断开将销毁不可再生凭证，故未执行」**，需维护者书面接受。

#### ② `session-smoke` 的 9 处 FAIL：**saga2 是正式流程项目**，与脚本 fixture 不兼容，非回归

失败全部同源：脚本默认在 `saga2` 的**「普通对话」子组**下找项目作用域新建入口
（`createMekaDraft(..., { subgroup: '普通对话' })`），而 `saga2` 的
`C:\Workspace\saga2\saga2_project_git\.meka\project.json`（`basic`，最后改动 2026-08-05）是
**`"formalWorkflowEnabled": true` + `"workflowType": "jira"` + `"jiraProjectKey": "SAGA"`**
⇒ `MekaAssistantSection.tsx:175-178` 的 `formalWorkflowActive === true`
⇒ 该项目的树按**正式流程**渲染，`projectId && !group.formalWorkflowActive` 的项目作用域
「新建普通对话」入口（`:466-473`）**按设计隐藏**。

于是脚本找不到子组头/入口，退化成点通用「新建」→ 建出的是普通对话
（`WL-11.3` 实测 `workspace_kind=dialogue; meka_project_id=null; meka_role_id=null`），
后续 `WL-11.5/11.6/11.7/11.17` 全部是「没有新 Meka 会话」的连锁前置失败。

**为什么判定不是回归**（三条独立证据）：
1. `apps/desktop/src/renderer/features/cc-agent/sidebar/sections/MekaAssistantSection.tsx`
   相对合并前 `09e8bb6132` **零改动**（`git diff` 为空）；
2. `scripts/meka-session-smoke.mjs` 三方比对：`base..origin/main` 空、`base..09e8bb6132`
   为「新增 1695 行」、`09e8bb6132..merge` **空** ⇒ 脚本本轮**未被合并改动**；
3. `formalWorkflowEnabled` 的读取链（`mekaProjects.ts:241 ← normalizeMekaProjectFile(project.json)`）
   中，`mekaProjects.ts` 与 `MekaAssistantSection.tsx` **都不在本轮改动清单内**；
   唯一被本轮改到且提到该字段的 `localDb/ipc/sessions.ts` 是主进程会话创建路径，
   不是渲染判据。⇒ 行为由**项目配置数据**决定，非代码回归。

⇒ **登记为「未验证 + 原因：本机唯一项目的 `project.json` 为正式流程（jira/SAGA），
与 session-smoke 的「普通对话」fixture 不兼容；本轮无可用的非正式流程项目」**，需维护者书面接受。
**可复跑的解除条件**：注册一个非正式流程项目（或临时把 saga2 的 `formalWorkflowEnabled`
置 false）后重跑 `pnpm desktop:session-smoke`。

#### 阶段 C 的正面结论

- **应用能真实启动并运行**（`ready`、commit 与 HEAD 一致、无陈旧实例）。
- **真实会话跑通**：`WL-11.4` PASS —— 建会话 → 发消息 → 模型回复 `"收到"`。
- **15 项程序化 GUI 验收中 13 项 PASS**，覆盖 WL-1.1 / WL-1.2-1.5（四卡齐全）/ WL-1.5 /
  WL-2.1 / WL-2.2 / WL-2.3 / WL-2.4 / WL-2.5+WL-3.3 / WL-3.2 / WL-5.5+WL-6.1 / WL-6.5 /
  WL-10（P0 回归点：草稿模型选择器非空、9 个选项）/ WL-13（五语无裸 key）。
- **未验证项（除上面 2 类）**：WL-4（MCPRouter）端到端仍缺账号/实例（§5 既有登记）、
  Light/Dark 目检、真实签名与发布。

### 7.4 阶段 D — 结论

**阶段 A（结构审计）**：`pnpm audit:merge -- --worktree` → **PASS**（blockers 0 / dropped 0 /
review 0；8 项豁免逐条有据）。上游新增 1016 条中除 D4 **有意改号**的 5 条 migration 外全部在位，
无一条同时被 Meka 改过；上游删除 22 条逐条无悬挂引用 ⇒ **无静默丢失**。

**阶段 B（最小自动化集合）**：除 `pnpm test:db` 仅剩 `backup.test.ts` 的 3 条**宿主磁盘不足**
（`ENOSPC`）外，其余全部实跑通过（逐项见 §7.2）；`pnpm test:unit` 独占串行 **exit 0**。

**阶段 C（实机验收）**：应用启动、身份/提交一致性、真实会话与 13/15 程序化 GUI 检查通过；
3 处**门禁脚本自身缺陷**已在本轮修复（其中两条是上游新增 UI 造成的钩子漂移）；2 类失败
（`ui-smoke` 的 WL-1.2/1.3 与 `session-smoke` 的 WL-11.x）经三条独立证据判定为
**环境/项目配置前置不满足**，不是合并回归，并已按白名单要求**逐条登记「未验证 + 原因」**。

**总体结论**：合并**在结构、实现自洽与语义三个层面均未发现 Meka 能力丢失**；
`audit:merge` PASS、`test:unit` exit 0、typecheck 0、`db:validate` 6/6、
i18n/brand/endpoint/design-inventory/dev-docs 全绿。**但本报告不宣告「全部通过」**：
`pnpm test:db` 有 1 个文件的宿主磁盘 `ENOSPC`、阶段 C 有 2 类前置不满足的实机项，
**均已明确登记为「未验证 + 原因」，需维护者书面接受后才算收敛**（白名单 §2 阶段 D 的既有口径）。

## 8. 交付状态

- **合并已完成并已提交**：65 个冲突路径全部解决；合并提交 **`1d42753a22`**
  （父提交 = `09e8bb6132` + `2f169d6aeb`，带 `Signed-off-by`）。
  **未 push、未创建 PR**（需用户单独授权）。合并后 `git rev-list --left-right --count HEAD...origin/main`
  = **165 / 0** ⇒ **上游没有任何提交未并入**。
- **结构层面的静默丢失审计**：结论见 §4 —— 上游新增 1016 条中除 D4 有意改号的 5 条外全部在位，
  且无一条同时被 Meka 改动过；上游删除 22 条逐条无悬挂引用；118 条「无冲突标记但两侧都改过」的路径
  全量比对后，「上游新增内容被静默丢弃」= **0**。
- **分组解决结果**：见 §5.2 与 §6（逐组给出「口径 + 证据 + 保留的不变量 + 定向取证结果」）。
- **交付门禁实跑与随后修复的缺陷**：见 **§6.15 / §6.16 / §6.17 / §6.18** —— 门禁实跑中又发现并修复
  多批缺陷，每条给出「现象 → 证据 → 根因（谁引入）→ 修法 → 实跑验证」：
  安装器/`buildResources`/i18n 术语与插件下载上限等 6 处（§6.15）；
  `test:unit` 首跑 4 处真实红 + 2 处环境性假红（§6.16）；
  `versionStartup` / `linuxInstallation` / `index.ts` 的身份字面值回归（§6.17）；
  `pnpm test:db` 的 Windows 命令行长度失效 + 5 处被它掩盖的真实红（§6.18）。
  其中 `installer.rs`、`completeDirectory.test.ts`、`cindy-meka-updater.exe`、zh-TW 品牌占位、
  `creditParity*`、两处身份硬编码的**纳入决定均由用户逐项作出**。
- **白名单验证进展**：见 **§7** —— **阶段 A / B / C / D 全部实跑并已登记结论**（含 2 类
  「未验证 + 原因」的登记与解除条件）。
- **未完成的交付项（不得在本报告内宣告收敛）**：
  1. `pnpm-lock.yaml`：已在交付门禁实跑中由 `pnpm install` **重建**（见 §7.1 的 `GENERATED` 说明）
     ⇒ §4.5 / §6.12 / UP-08 里「重建未执行」的措辞已被本节取代，该交付项**已消除**；
  2. 插件基座白名单放行门（UP-13、`CAP-MEKAPLUGIN`）—— `pnpm test:db` 与实机验收已跑，
     该放行门本身仍需放行人明确 Approve，**未完成**；
  3. **需维护者书面接受的「未验证 + 原因」**（白名单 §2 阶段 D 口径）：
     (a) `pnpm test:db` 中 `backup.test.ts` 的 3 条 `ENOSPC`（宿主磁盘不足，需约 39 GB，本机剩约 10.5 GB）；
     (b) `ui-smoke` 的 WL-1.2 / WL-1.3（唯一已登录沙箱的 MCPRouter/MekaDesign 已连接，
         配置入口被「断开」替代；断开将销毁不可再生凭证）；
     (c) `session-smoke` 的 WL-11.1/11.2/11.3/11.5/11.6/11.7/11.8/11.17 与 WL-3.2
         （本机唯一项目 `saga2` 的 `project.json` 为正式流程 jira/SAGA，与脚本「普通对话」fixture 不兼容）；
     (d) WL-4 MCPRouter 端到端（缺账号与实例）、Light/Dark 目检、真实签名与发布、共享 profile 旧库只读迁移。
     前三项的**证据链与「为什么不是回归」的判定**见 §7.3，解除条件亦已写明。
  4. 不在 §7.2 最小集合内的定向套件（§6.15.4 的 `mekaDownloadPolicy.test.ts`、
     §6.15.6 的 `i18nBrandPlaceholder.test.ts`）—— 已在 §6.15 逐条**实跑通过**；
     `pnpm test:unit` 独占串行 **exit 0**、`pnpm test:db` 见上；
  5. **未 push、未创建 PR**（需用户单独授权）。
- **本报告的门禁结论边界**：§6.15–§6.18 与 §7 只登记**实际跑过**的命令与输出，未跑项逐条标注
  「未跑 / 未验证 + 原因」；§1–§6 的「定向取证」栏仍只覆盖冲突解决当时的定向检查（写「代码级证据」
  「静态核对」「本轮未跑」的组没有实跑测试）。**本报告不声称「全部通过」**：
  §7.4 已写明「结构/实现/语义三层未发现 Meka 能力丢失」，同时明确列出
  「需维护者书面接受」的 4 组未验证项。
- **文档同步**：本报告与总账 `docs/migrations/xdmaker-meka-to-cindy.md` §11.29（第三轮同步登记）、
  §6.59 后续修订、§4.6 三页签与台账登记为同一次交付的事实登记；
  另同步 `docs/dev-rules/`（`meka-whitelist-verification.md`、`configuration-and-overrides.md`、
  `desktop-unit-test-performance.md`、`database-and-migrations.md` 等）与
  `docs/product-rules/shared-task-mode.md`。
