# Meka 能力白名单与合并后验证清单

> **状态**：权威开发规则（authoritative）。本文是「Meka 专属能力」的**唯一验收清单**，
> 也是每次上游同步后的验证范围定义。
> **读取时机**：把 `origin/main` 同步进 `meka/main` 之后、在任何交付或发布结论之前；
> 以及新增、修改或删除任何 Meka 专属能力时。

## 1. 白名单机制：为什么是「清单内全绿即可接纳上游」

本仓对上游的默认策略是**完整接纳**（重构、重命名、替换、删除都接），只有经审计的 Meka
能力与兼容不变量才保留差异（见 `cindy-meka-upstream-sync` skill 的「执行上游接纳策略」）。
这条策略要成立，前提是能回答一个问题：**接纳之后，怎么知道 Meka 侧没有被打坏？**

Git 的冲突清单回答不了这个问题。本仓 2026-09 同步实测的两类 P0 都不产生冲突：

| 事故 | 形态 |
| --- | --- |
| 合并后 Meka 老用户模型选择器整张清空 | 上游改了决策函数语义（无初始化清单 ⇒ 一律不可见），Meka 侧调用点前提失效。文件全部合并成功，`isModelEnabled` 与上游逐字节相同 |
| 合并后开发插件「从目录加载」直接报错 | 上游把 v2 `slots` 从归一化产物里移除，Meka 侧「把归一化清单当作者清单」的调用点随即失效。两边各自都自洽 |

两者都不是「解冲突解错」，而是**上游改语义、Meka 侧调用点前提被静默覆盖**。这类回归的
特征是：代码都在、测试可能全绿（当实现和它的测试一起被覆盖时）、冲突标记为零。

所以验收范围必须反向定义成**白名单**：

- 清单内的能力，逐项验证；**全部通过即判定「可以安全接纳这批上游」**。
- 清单外的差异一律按上游处理；如果某处差异需要保留，**它必须先被登记成清单项**，
  否则不构成「需要保留的差异」。
- 清单是**工程契约**，不是产品文档：每一项都必须能落到代码锚点、可执行门禁或可操作的
  实机步骤上。无法验证的条目等于没有条目。

### 与既有门禁的分工（不可互相替代）

| 门禁 | 抓什么 | 抓不到什么 |
| --- | --- | --- |
| `pnpm audit:merge` | **结构层面的静默丢失**：上游新增文件/整块代码在解决结果里不存在、整体取了单侧、生成物被手改 | 代码都在但语义被覆盖 |
| 本文清单 | **语义层面的静默覆盖**：行为、契约、持久化语义发生变化 | 文件被整块丢弃 |
| `pnpm test:unit` / `test:db` / `test:guard` | 实现与测试自身的一致性 | 两者一起被覆盖的情况 |

## 2. 每次同步后的执行顺序

> **硬性规范（2026-09-11 定）：合并完成后必须**实际运行**本节的检查，而不是阅读清单或
> 凭印象判断。逐项给出结论并落到当期同步报告；**只有全部通过（或明确登记「未验证 + 原因」
> 并经维护者书面接受）才允许宣告本次合并完成**。只看 diff、只跑 `test:unit`、或把清单当
> 参考资料读过一遍，都不构成完成。没有实跑记录就宣告完成，等同于虚报。

四阶段，顺序固定；每个阶段的证据都写进当期同步报告
（`docs/migrations/<年>-<月>-origin-main-to-meka-main.md`）。

1. **阶段 A — 结构审计**：`pnpm audit:merge -- --merge-commit <merge-sha>`。
   `BLOCKER` / `DROPPED` 必须为 0，或有逐条书面确认（哪些是合理形态、为什么）。
2. **阶段 B — 自动化验收**：跑完 §4 的「最小自动化集合」，全绿。任何一项红都不得进入
   阶段 C 之后的下结论。
3. **阶段 C — 实机验收**：先跑 §5 的一键序列（`desktop:ui-smoke` + `desktop:session-smoke`），
   再按 §3 每一项的「实机验证」逐项走一遍，记录现象而不是结论。
   无法在本机验证的（缺账号、缺远端实例、需正式签名、需特定 profile 数据）必须显式标注
   「未验证 + 原因 + 风险」，不得含糊成「已通过」。
   **「要人手点 GUI」不再是可接受的理由**：GUI 项已有 §5 的程序化驱动工具，应当扩检查表而不是
   退回人工目检（见 §6）。
4. **阶段 D — 结论**：任一项失败 ⇒ 本次同步**不可交付**。要么修，要么在当期报告里登记
   「已知未修 + 用户可见影响 + 是否阻断 + 由谁决定」。不存在「先合了再说」。

证据要求：命令 + 结果 + 现象。不接受「看起来没坏」「复用了同一套实现所以应该没问题」。
报告里的每一行都必须是**跑出来的**，不是推断出来的；跑不动就写跑不动。

## 3. Meka 能力白名单

每一项给出：**保护的不变量**、**代码锚点**、**自动化门禁**、**实机验证**、
**历史回归**（有则写）。编号稳定，删除能力时同步删除条目并写明理由，不得复用编号。

### WL-1 设置页的 Meka 相关设置

**保护的不变量**：设置页有独立的「Meka 助理」分区，承载 MCPRouter 连接、MekaDesign 连接、
P4 项目根、插件面板呈现方式等 Meka 专属配置；这些配置落盘在 `userData/meka-assistant-settings.json`
（**设备级**，且旧身份迁移会把它一并带过来），上游同步不得把这套设置面并回上游的
插件/技能设置或改掉落盘文件名。

#### WL-1.1 设置侧栏入口与分区渲染

- **代码锚点**：`apps/desktop/src/renderer/lib/tabLabels.ts:16,39,80`（页签名 `'meka-assistant'` 与 i18n key `settings.tabs.mekaAssistant`）、`apps/desktop/src/renderer/components/settings/SettingsSidebarNav.tsx:74`（图标）、`apps/desktop/src/renderer/components/settings/SettingsView.tsx:548-555`（渲染 `MekaAssistantSettingsSection`，**无任何门控**）
- **不变量**：「Meka 助理」页签必须留在模型供应商与计费**之间**的固定位次；深链 `?tab=meka-assistant` 可直达
- **自动化门禁**：`pnpm --filter desktop exec vitest run src/renderer/lib/__tests__/tabLabels.test.ts`（`keeps the Meka assistant between model providers and billing`）
- **实机验证**：设置 → 左侧可见「Meka 助理」且位次正确；`/settings?tab=meka-assistant` 直达该分区

#### WL-1.2 MCPRouter 连接 / 注册 / 实例 / 工具 / route / 模板

- **代码锚点**：`apps/desktop/src/renderer/components/settings/MekaAssistantSettingsSection.tsx:93`（组件）、`:408-560`（MCPRouter 区块）；`apps/desktop/src/renderer/components/settings/MekaRouterConnectDialog.tsx:27`；`apps/desktop/src/renderer/components/settings/mekaRouterSettingsModel.ts`（客户端分组与模板分组展示）；`apps/desktop/src/main/meka-settings/ipc.ts:19-35`（channel 常量：`get-p4`/`set-p4-root`/`router:{get,connect,register,login-state,disconnect,list-tools,set-route,list-instances,list-templates,create-instance}`/`design:{connect,use-router,disconnect}`/`project:{get-bindings,set-bindings}`）；`apps/desktop/src/main/meka-settings/routerLoginWindow.ts:8`（`meka-settings:router:open-login`）
- **不变量**：未连接时提供原位「配置登录」；连接对话框支持登录与**注册**两种模式；已连接显示账号、客户端工具数与实例/模板分组；系统客户端**只读**；`instanceId` 只作显示
- **安全不变量**：Router 地址必须是**无凭证的 HTTPS**；HTTP / 裸 IP 在运行期被强制迁移到生产域名（`apps/desktop/src/main/meka-settings/config.ts:6` 的 `PRODUCTION_MEKA_MCPROUTER_URL`）；凭证走 OS 加密存储，旧 `.plain` 明文只被一次性消费；断开时清 `routeEnabledCache`
- **登录窗口**：复用受信主壳（校验来源）、并发去重、5 分钟超时（`apps/desktop/src/main/meka-settings/routerLoginWindow.ts:39-58,64-99`）
- **配置落盘**：`userData/meka-assistant-settings.json`（`meka-settings/ipc.ts:97,110`）
- **自动化门禁**：`pnpm --filter desktop exec vitest run src/renderer/components/settings/__tests__/mekaRouterSettingsModel.test.ts src/main/meka-settings/__tests__/service.test.ts src/main/meka-settings/__tests__/routerService.test.ts src/main/meka-settings/__tests__/routerLoginWindow.test.ts`
- **实机验证**：用真实账号走「连接 → 实例列表出现 → 工具计数正确 → 断开」；注册模式能建号并落盘；重启后仍保持连接。**负向**：把地址改成 `http://` 或裸 IP → 必须被迁移/拒绝，不得带着明文凭证连出去

#### WL-1.3 MekaDesign 连接

- **代码锚点**：`MekaAssistantSettingsSection.tsx:574-600`（MekaDesign 区块：连接/断开/显示 URL）、`:163-176`（`mekaDesignConflict` 冲突提示与「替换/保留」选择）；`apps/desktop/src/main/meka-settings/routerService.ts:86-96,98-127,263-295,370-384`；`apps/desktop/src/main/meka-settings/routerClient.ts:99-111`
- **不变量**：MekaDesign 有**独立 endpoint**，与 MCPRouter 的连接状态分开呈现、生命周期独立；出现冲突时必须让用户选择而不是静默覆盖；**URL 必须保留 query 只删 fragment**（`?key=` 这类参数曾被误删，属真实回归）
- **持久化 key**：`mekadesignConfigured`、`mekaDesignRouterSyncSuppressed`（**都不存 endpoint 与凭证本体**）
- **自动化门禁**：`pnpm --filter desktop exec vitest run src/main/meka-settings/__tests__/routerService.test.ts`（MekaDesign 集群）
- **实机验证**：连接一个 MekaDesign URL → 显示已连接与 URL；制造冲突时出现「替换/保留」对话框；带 query 的 URL 连接后 query 仍在

#### WL-1.4 P4 项目根设置

- **代码锚点**：`MekaAssistantSettingsSection.tsx:331-396`（选择目录、刷新、匹配到的 saga2 子目录、未来 schema 只读提示）；`apps/desktop/src/shared/meka-settings.ts:12`（`MekaP4Settings`）
- **不变量**：目录不存在/无匹配时给明确空态，不留白屏；该根目录是本地开发目录白名单的来源（与 WL-4.2.1 的本地 worker 目标解析同源）
- **自动化门禁**：`pnpm --filter desktop exec vitest run src/main/meka-settings/__tests__/service.test.ts`
- **实机验证**：选一个含 `saga2_*` 子目录的根 → 列表显示匹配项；选空目录 → 显示空态

#### WL-1.5 插件面板呈现方式开关

- **代码锚点**：`MekaAssistantSettingsSection.tsx:291-326`（`settings.meka.pluginPanel.title` / `toggleAria`）；`apps/desktop/src/renderer/lib/ghostPanelPresentationPreference.ts:15-16,101-107,119-129`
- **持久化 key**：`xdt:ghostPanelPresentation:v1`（全局默认）与 `xdt:ghostPanelPresentationOverrides:v1`（逐插件覆盖）。**不变量**：关闭时**移除**存储项而不是写 `false`（保持「未设置 = 跟随默认」的语义）
- **不变量**：该开关只改变插件面板的呈现方式（Modal/停靠），**不改变逻辑沙箱与 Node worker 的生命周期**（`plugin-security-and-authoring.md`：隐藏态不得改变后台生命周期）
- **自动化门禁**：`pnpm --filter desktop exec vitest run src/renderer/lib/__tests__/ghostPanelPresentationPreference.test.ts src/renderer/__tests__/pluginPanelPresentationPreference.test.tsx`
- **实机验证**：切换开关后打开插件面板，呈现方式改变但插件后台仍在运行；关闭开关后 localStorage 里该键**不存在**

#### WL-1.6 Meka 工具风险分级策略

- **代码锚点**：`apps/desktop/src/main/meka-settings/mekaRiskPolicy.ts:2,4,28-30,41,45-75`（`MekaToolRisk` 四档；高危动作集合、变更动作、生产环境识别、`classifyMekaRouterToolRisk`）
- **不变量**：风险分级是 MCPRouter 工具调用的**授权前置**（高危/生产环境写入必须触发确认），不能被上游的工具列表覆盖成无分级
- **自动化门禁**：**无独立自动化门禁**（当前无 `mekaRiskPolicy` 专项测试）
- **实机验证**：调用一个带 `action=write` + `environment=prod` 的 MCPRouter 工具 → 必须出现确认；只读工具不得弹确认

#### WL-1.7 P4 未配置时的发送前门

- **代码锚点**：`apps/desktop/src/renderer/hooks/useMekaConfigGate.ts:12`（`isMekaP4ConfigComplete`）、`:22`（`useMekaConfigGate`）、`:46`（`navigate('/settings?tab=meka-assistant')`）
- **不变量**：Meka 会话在 P4 路径未配置时必须**在发送前**拦截并引导到设置，而不是发出去再失败；读取 P4 配置失败时 fail-open（不阻断用户）
- **自动化门禁**：**无自动化覆盖**（确认框文案与跳转行为无用例）
- **实机验证**：清掉 P4 路径 → 在 Meka 草稿里发送 → 出现配置确认框，确认后跳到 `/settings?tab=meka-assistant`

#### WL-1.8 `meka-assistant-settings.json` 多域字段级共存

- **代码锚点**：`apps/desktop/src/main/meka-settings/ipc.ts:97` 与 `:110`（P4 与 Router **共用同一文件路径**）、`meka-settings/service.ts:133-140`、`meka-settings/routerService.ts:212-229,328-335,558-563`
- **不变量**：同一文件承载多域字段，**任何一域写入都不得整表覆写其它域**；`schemaVersion` 是只读闸（未来版本只读、不降级改写）
- **key 全量**：`schemaVersion` / `p4RootPath` / `subfolders` / `routerUrl` / `routerUsername` / `mekadesignConfigured` / `mekaDesignRouterSyncSuppressed` / `routeEnabledCache` / `projectRemoteInstanceIds`
- **交叉风险**：`projectRemoteInstanceIds`（项目 ↔ 实例绑定）的 UI 在**项目详情页**而非设置页 —— 设置侧操作不得覆盖它
- **自动化门禁**：`pnpm --filter desktop exec vitest run src/main/meka-settings/__tests__/service.test.ts src/main/meka-settings/__tests__/routerService.test.ts`
- **实机验证**：先设 P4 根目录 → 再连接 MCPRouter → 回到 P4 卡片确认根目录**仍在**（反之亦然）

#### WL-1.9 旧 `xdmaker-meka` 设置文件只读迁移

- **代码锚点**：`apps/desktop/src/main/legacyUserDataMigration.ts:63`（`MEKA_SETTINGS_FILE_NAME = 'meka-assistant-settings.json'`）、`:709-723`（目标侧缺失才写、源文件不删不改）
- **不变量**：只在目标不存在时复制；**不删除、不改写**旧文件（与 WL-6.6 同一只读口径）
- **自动化门禁**：`pnpm --filter desktop exec vitest run src/main/__tests__/legacyUserDataMigration.test.ts`
- **实机验证**：见 WL-6.6 的 CN 构建实机步骤（同一前置）

> 交叉引用：更新渠道的渠道身份属 WL-6.5；运行期区域 / `edition` 在**登录页**而非设置页，属 WL-5；
> 设置页里模型开关的开关态与「未启用」沉底区是 WL-10 的表现面，编号归 WL-10。本节不重复。



### WL-2 首页左侧栏 Meka 入口

**保护的不变量**：左侧栏有**常驻且高亮**的 Meka 入口，通往 Meka 插件／技能／项目三个页面；
展开态与收窄（rail）态**都有**入口；旧深链仍能落到新路由。上游侧栏只有 `botsRow`、没有
`mekaRow`，router 里也没有任何 `meka` 命中——这一整域必须靠并集（不是取单侧）保住。

#### WL-2.1 顶部导航 Meka 入口行（`mekaRow`）

- **代码锚点**：`apps/desktop/src/renderer/components/sidebar/SidebarTopNav.tsx:66`（`useMatch('/cc-agent/meka/*')`）、`:109-126`（`mekaRow` 定义）、`:189`（scrollable 段渲染）、`:232`（all 段渲染）
- **自动化门禁**：**无自动化覆盖**（`mekaSidebarOrder.test.ts` 只读 `CCAgentSidebarUpper.tsx`，不覆盖 `SidebarTopNav.tsx`）。上游在 `:189/:232` 各有一处渲染分支，改侧栏结构时必须两处都查
- **实机验证**：展开左侧栏 → 自上而下可见「新建 / 自动任务 / **Meka 管理**（公文包图标）/ 插件 / 伙伴 / 搜索」；点「Meka 管理」进入 Meka 插件页，该行呈选中态；进入 `/cc-agent/meka/skills`、`/cc-agent/meka` 时**仍保持高亮**
- **历史回归**：本轮同步 `SidebarTopNav.tsx` 的 lucide `Bot` import 丢失 —— 根因就是 `mekaRow`（Meka）与上游新增 `botsRow` 需要**并集**（[`2026-09-origin-main-to-meka-main.md`](../migrations/2026-09-origin-main-to-meka-main.md) §4.3）

#### WL-2.2 折叠（rail）态 Meka 入口图标

- **代码锚点**：`apps/desktop/src/renderer/features/cc-agent/CCAgentSidebarUpper.tsx:3852`（`onMekaMatch`）、`:3915-3923`（`SidebarIconButton` + `BriefcaseBusiness` + `active={Boolean(onMekaMatch)}`）
- **不变量**：位置在 `GhostMainViewNavEntries`（`:3912`）之后、插件入口（`:3924-3932`）之前
- **自动化门禁**：**无自动化覆盖**
- **实机验证**：把左侧栏拖到 rail 态 → 图标列含公文包（Meka）；点击进入 Meka 插件页；处于 `/cc-agent/meka/*` 时为 active 态
- **历史回归**：源码注释记录过「折叠 rail 之前漏了这颗按钮」的对称性缺口（`CCAgentSidebarUpper.tsx:3853-3854`）

#### WL-2.3 三页签管理页骨架（插件 / 技能 / 项目）

- **代码锚点**：`apps/desktop/src/renderer/features/plugin/PluginManagementLayout.tsx:20-21`（`PluginManagementTab` 含 `meka-*` 三项）、`:128-129`（`isMekaTab`）、`:160-185`（Meka 分支目标路由 `/cc-agent/meka/plugins`、`/cc-agent/meka/skills`、`/cc-agent/meka`；非 Meka 分支才是 `/plugins`、`/skillhub/local`）、`:200-208`（独立渲染分支）
- **自动化门禁**：`pnpm --filter desktop exec vitest run src/renderer/features/plugin/__tests__/PluginManagementLayout.test.tsx`
- **实机验证**：Meka 管理页顶部三个 pill 页签；逐个点击 URL 依次为三个 Meka 路由；「项目」页先进项目库列表，不默认选中某个项目
- **历史回归**：`xdmaker-meka-to-cindy.md` §4.6（三页签同级、复用上游宽度/胶囊 Tab）

#### WL-2.4 Meka 路由族与旧深链重定向

- **代码锚点**：`apps/desktop/src/renderer/router.tsx:115-118`（四条 `meka/*` 子路由）、`:194-197`（`/meka-plugins` → `/cc-agent/meka/plugins` 重定向）
- **不变量**：四条路由必须排在 `:sessionId` 通配之前
- **自动化门禁**：部分覆盖（`PluginManagementLayout.test.tsx`、`MekaProjectRoleEditorRoute.test.tsx`、`MekaSkillHomeView.test.tsx`、`MekaSkillMarketListView.test.tsx`）；**旧路径 `/meka-plugins` 重定向无用例**
- **实机验证**：直接导航 `/meka-plugins` → 落到 `/cc-agent/meka/plugins`；四个 Meka 页面均正常渲染

#### WL-2.5 Meka 段在侧栏的位次

- **代码锚点**：`apps/desktop/src/renderer/features/cc-agent/CCAgentSidebarUpper.tsx:3545`（`MekaAssistantSection`）、`:3577`（`PinnedSection`）、`:3641`（`ProjectsSection`）
- **自动化门禁**：`pnpm --filter desktop exec vitest run src/renderer/__tests__/mekaSidebarOrder.test.ts`（断言 Meka 段在置顶段与项目段之前）
- **缺口**：该断言**不覆盖** `DialogueSection`（文件仍在但已不在渲染路径）与 `SidebarTopNav section="scrollable"`（`:3469`）的相对位次
- **实机验证**：Meka 段位于「置顶」「项目」之上，一级产品区不被挤到 Cindy 任务之后

### WL-3 Meka 代理对话的单独分类

**保护的不变量**：Meka 会话（`workspaceKind === 'meka'`）是**与项目/对话同级的一级分类**，
按 `(mekaProjectId, mekaRoleId)` 归属而不是按 workingDir；它**只**出现在 Meka 段，
不重复出现在普通项目/对话列表，也不进 IM 选择器与 scheduler 域。

#### WL-3.1 互斥取数（`visibleMekaSessions` / `nonMeka*`）

- **代码锚点**：`apps/desktop/src/renderer/features/cc-agent/CCAgentSidebarUpper.tsx:1639-1644`（`visibleMekaSessions` 按 `workspaceKind === 'meka'` 取）、`:1371-1378`（`nonMekaSidebarSessions` / `nonMekaActivitySessions`）、`:1379-1391`（普通项目分组**全部**由 `nonMeka*` 派生）、`:1402-1408`（`unfilteredProjectSessions` 排除 meka，使 `projectUniverse` 不含 Meka 项目）
- **自动化门禁**：**无自动化覆盖**（`mekaSessionPresentation.test.ts` 只覆盖纯分组函数，不覆盖这两个 filter 的互斥性）
- **实机验证**：同目录下建普通项目会话 + Meka 会话 → Meka 会话**只**出现在「Meka 助理」段；切换侧栏项目筛选不影响 Meka 段、也不产生重复行；`@` 项目引用不指向 Meka 项目

#### WL-3.2 项目树与「正式 / 普通」子分组

- **代码锚点**：`apps/desktop/src/renderer/features/cc-agent/sidebar/sections/MekaAssistantSection.tsx:125-164`（`buildMekaProjectSessionGroups`：按 `mekaProjectId` 建桶、已配置项目在前、孤儿桶在后；`formalWorkflowActive` 判据 = 启用且 `jira+jiraProjectKey` 或 `gitlab+gitlabProjectUrl`）、`:313-457`（树渲染）、`:344-346`（不可用项目 / 旧版会话分组标题）
- **不变量**：`mekaProjectId` 是**历史软引用**，项目删除后不清空（否则历史会话整条消失）
- **自动化门禁**：`pnpm --filter desktop exec vitest run src/renderer/features/cc-agent/__tests__/mekaSessionPresentation.test.ts`（6 条：正式/普通分组、无会话项目可见、无正式流程时扁平、项目删除后进「不可用」组、旧版会话可见且置顶在前、会话头只显示角色名）；**实机项已自动化**：`pnpm desktop:session-smoke` 的 `WL-3.2` 用真实鼠标事件展开 Meka 段与项目行，断言项目行可见、hover 出的项目作用域入口存在且标签带项目名（`在 <项目> 中新建正式流程对话` / `在 <项目> 中新建普通对话`）
- **实机验证**：新建项目（无会话也应显示）→ 配 Jira Key/GitLab URL 并启用正式流程 → 出现「正式 / 普通」子分组；删除项目后其会话仍在「不可用的 Meka 项目」下
- **执行记录**（2026-09-14）：`pnpm desktop:session-smoke` 9/9 PASS，`WL-3.2` 证据 = `项目=SAGA2；新建入口=["在 SAGA2 中新建正式流程对话","在 SAGA2 中新建普通对话"]`
- **基线变更（2026-09-22）**：内置 SAGA2 的 `workflowType` 由 `jira` 改为 `none`（`formalWorkflowEnabled` 随之由派生逻辑变为 `false`），因此**内置基线下 SAGA2 不再有正式流程**：侧栏项目行不再出现「正式流程 / 普通对话」子分组，新建入口只剩「在 SAGA2 中新建普通对话」。
  - 上一条 2026-09-14 的实机证据是**改动前**的事实，已在括号内保留；`WL-3.2` 的**不变量本身未变**（分组/入口仍由 `formalWorkflowEnabled` + `workflowType` 决定），变的是内置项目取到的值。
  - 自动化门禁 `mekaSessionPresentation.test.ts` 使用自带 fixture（`jiraProjectKey: 'APP'`），**不读**内置 SAGA2 配置，因此仍覆盖「启用正式流程 → 分两组」与「未启用 → 扁平」两侧，无需改动。
  - `pnpm desktop:session-smoke` 的 `WL-3.2` 只断言「至少存在一个项目作用域入口」，故不会因该变更变红；但它记录的入口清单会收敛为只剩普通对话，重跑时需按新证据更新。
  - **仅影响内置基线**：若用户已在 `<P4 根>/.meka/project.json` 保存过 SAGA2 项目配置，该文件仍优先（`readProjectConfigState` 的 project 源），其 `workflowType` 不会被本次改动覆盖，需用户显式保存或「重置项目」才会跟随基线。

#### WL-3.3 段头、折叠与管理按钮

- **代码锚点**：`MekaAssistantSection.tsx:338-394`（段头；`:340-351` 标题（`:348` 截断类）、`:352-371` 整段折叠、`:374-376` 「收起所有分组」、`:377-382` 「侧边栏显示设置」、`:383-392` 管理按钮 → `/cc-agent/meka/plugins`）、`:139-151`（`resolveMekaFoldState`）、`:248-256`（四层折叠 state）
- **不变量**：折叠状态是组件内 state、**不持久化**（刻意：重挂载即展开）；段头右侧两个按钮与「全部任务」段头**共用实现**（`sidebar/SidebarHeaderActions.tsx` 的 hover 规则 + `SidebarFoldAllButton`），两处不得各写一套；显示设置打开的是**全局**侧栏菜单（`SidebarFilterPopover`），不是 Meka 专属菜单——它**只**新增入口，不改写分组 / 排序 / 筛选中与 WL-3.4 冲突的语义；「收起所有分组」的作用域只到 Meka 自己的项目分组（含孤儿桶），整段已收起或没有项目分组时退场；段头标题必须带 `min-w-0 truncate`（与「全部任务」标题同款）——右侧三个 28px 动作钮把 Meka 段头压到侧栏最小展开宽（`useSidebarResize` 的 `MIN_WIDTH = 180`，rail 阈值 120）只剩 44px 给标题文案，缺截断就会在 `h-6` 行里折行盖住项目树
- **自动化门禁**：`mekaSessionPresentation.test.ts` 的 `applies the shared sidebar list style without changing Meka grouping`、`mirrors the main-list header actions in the Meka section header`（含父层 prop 传递）、`offers the fold-all action only while Meka project groups are actually visible`（纯函数状态机）；`projectsSidebarSection.test.ts` 的 `only shows project header actions while hovering or focusing the Projects header row`（hover 规则正本在共用模块）
- **实机验证**：段头可见并可整段收起/展开；hover 出的管理按钮进入 `/cc-agent/meka/plugins`；hover 出的「收起所有分组」收齐全部项目行（含「不可用项目」/「旧版 Meka 会话」）后图标与 tooltip 切「展开所有分组」；「侧边栏显示设置」出现主列表段头那一份全局菜单，菜单展开期间该排按钮保持可见

#### WL-3.4 组内排序与置顶语义

- **代码锚点**：`MekaAssistantSection.tsx:171-174`（置顶优先 → 活动时间 → id 稳定序三级排序——行号随段头改动移动，认函数体不认行号）、`:28`（复用 `sessionActivityMs`）
- **不变量**：Meka 段**不消费** `filter.sortBy` 与 `filter.manualPinnedOrder`（有意分歧）。段头新增的「侧边栏显示设置」入口**不改变**这条：那份全局菜单里的分组三开关、任务排序与项目顺序仍不作用于 Meka 段
- **自动化门禁**：`mekaSessionPresentation.test.ts` 的 `keeps legacy sessions visible and pinned sessions first within their project`
- **实机验证**：置顶较早的会话排到最前；切换侧栏排序与手动拖拽序时 Meka 段内顺序**不变**

#### WL-3.5 会话头的角色 scope 与角色编辑直达

- **代码锚点**：`apps/desktop/src/renderer/features/cc-agent/SessionContentHeader.tsx:152-162`（仅 `workspaceKind === 'meka'` 时取 scope）、`:599-612`（可点 chip）、`:614-625`（旧版只读标签）；`apps/desktop/src/renderer/features/cc-agent/useMekaSessionScope.ts:7-18`
- **不变量**：角色被删/项目为 null → scope 为 `null`，**不显示过期角色名**；旧会话（只有 `mekaRole`）走只读映射
- **自动化门禁**：`mekaSessionPresentation.test.ts` 的 `shows only the role name in the session header`、`builds a direct role-editor route with encoded frozen identities`
- **实机验证**：会话头出现角色名 chip → 点击跳到 `/cc-agent/meka?projectId=…&roleId=…` 且已直选；删角色后 chip 消失

#### WL-3.6 `'meka'` 跨层身份契约

- **代码锚点**：`packages/maker-core/src/types/common.ts:9`、`apps/desktop/src/renderer/lib/ccAgent.types.ts:12`、`apps/desktop/src/main/localDb/schema.ts:86`、`apps/desktop/src/main/localDb/client/tx/types.ts:757`（tx 层——本轮同步曾在这里**反向补** `'meka'`）、`apps/desktop/src/main/localDb/ipc/sessions.ts:1287,1317-1320`、`apps/desktop/src/shared/conversationSearch.ts:6`
- **不变量**：`'meka'` 是持久化合法值（DB enum + 跨进程类型联合）；`workspaceKind === 'meka'` 必须**同时**带 `mekaProjectId` + `mekaRoleId`，反之亦然
- **自动化门禁**：`pnpm --filter desktop exec vitest run src/main/localDb/__tests__/mapperMekaFormal.test.ts src/main/maker-ipc/__tests__/sessionCreateHandler.test.ts src/main/maker-ipc/__tests__/sessionRequest.test.ts src/renderer/features/cc-agent/__tests__/collaborationEligibility.test.ts`
- **实机验证**：建 Meka 会话 → 重启仍在 Meka 段且项目/角色不变；IM 侧 `/new` rotate 后该会话**未被截断**成普通会话
- **历史回归**：上游新增 `im.rotateSession` tx 的 `workspaceKind` 只写 `'project' | 'dialogue'`，本轮在 `tx/types.ts` 反向补 `'meka'`（[`2026-09-origin-main-to-meka-main.md`](../migrations/2026-09-origin-main-to-meka-main.md) §4.1）

#### WL-3.7 Meka 段文案五语齐备

- **代码锚点**：五语 `common.json` 的 `meka.*` 命名空间（`sessionListTitle` / `formalSessions` / `regularSessions` / `noSessions` / `unavailableProject` / `legacySessions` / `legacySessionScope` / `legacyRoles.*` / `openManagement` / `expandSessions` / `collapseSessions`）
- **不变量**：`meka.*` **不得**与上游 `sidebar.*` / `settings.ghosts.*` 合并
- **自动化门禁**：`pnpm check:i18n`（无专门针对 `meka.*` 存在性的单测）
- **实机验证**：五语各切一遍，侧栏不出现裸 key
- **历史回归**：本轮合并丢过 4 条 Meka 独有 key + 23 条 zh-TW 条目（`xdmaker-meka-to-cindy.md` §11.25）

> 横切域守卫（IM `/sessions` 投影、scheduler 域、协同资格）见 **WL-12**，不在本节重复。

### WL-4 MCPRouter 远程会话

> **实机前置**：本节多数项的端到端验证需要 MCPRouter 账号 + 已绑定到 Meka 项目的实例
> （Claude 与 Codex 各一更佳）+ 有效的 Cindy AI Gateway key，且 MCPRouter 侧部署的 bundle pin
> 与 Cindy 当前 pin 一致。前置不满足时必须标注「未验证 + 缺账号/缺实例」，不得记为通过。
> 规则正本：[`mcpr-remote-session-routing.md`](mcpr-remote-session-routing.md)（含 §3 合并防回归 6 条）。

**保护的不变量**（全节共用）：`remoteHostId` 是**两种 transport 的联合身份**，不是主机名字段；
`mcpr:<instance.id>` 永不进入 SSH pool；分类必须先于任何 transport 专属动作；新增远程路径
必须复用 `classifyRemoteSessionTransport`，不得复制 `startsWith('mcpr:')`。

#### WL-4.1 启动会话支持远程 MCPR 实例会话

##### WL-4.1.1 双 transport 分类

- **代码锚点**：`apps/desktop/src/main/maker-host/remote-session-routing.ts:9-16`（唯一纯函数入口：`'local' | 'ssh' | 'mcpr'`；malformed `mcpr:` 保持 MCPRouter 错误路径）；`apps/desktop/src/shared/meka-router.ts:32-48`（`id` 是唯一 transport 身份，`instanceId` 只是显示名）、`:52-62`（前缀、构造与解析）；`apps/desktop/src/main/meka-settings/routerService.ts:148-173`（supported 判定与 `buildMcprRemoteHostId(id)`）
- **自动化门禁**：`pnpm --filter desktop exec vitest run src/main/maker-host/__tests__/remote-session-routing.test.ts src/main/maker-host/__tests__/mcprCodexCapability.test.ts`
- **实机验证**：新建任务 → 位置渠道选 MCPRouter 实例 → 发送；无 `SSH_HOST_NOT_FOUND` / `MCPR_INSTANCE_NOT_READY`。**显示名被改过（`id ≠ instanceId`）仍能启动才算真过**
- **历史回归**：`4d1e01b7f` 把 `mcpr:<id>` 送进 SSH pool → `SSH_HOST_NOT_FOUND`；2026-08-05 `id`/`instanceId` 混用 + 只认 `claude` 为 supported

##### WL-4.1.2 四条路径都先分类（创建 / lazy resume / send 前置 / worker bootstrap）

- **代码锚点**：`apps/desktop/src/main/maker-ipc/register.ts:7292-7294`（**MCPRouter guard 必须在 `ensureRemoteHostReady` 之前**）、`:7231-7257`、`:7467-7476`（turn-settled holder）、`:7401`；`apps/desktop/src/main/maker-host/index.ts:1225-1227`（SSH pool 查询与 `remote ssh host not ready` 原文）、`:1186-1228`
- **自动化门禁**：`pnpm --filter desktop exec vitest run src/main/maker-ipc/__tests__/remoteSessionMakerMemory.test.ts src/main/maker-host/__tests__/remoteCcQueryFactory.test.ts src/main/maker-host/__tests__/mcprRemoteFileOps.test.ts`
- **覆盖缺口**：`register.ts` 侧仍以**源码文本序**（`indexOf`）断言为主。**但 2026-09-18 同步已补上行为级断言**：
  `mcprRemoteFileOps.test.ts` 逐字提取真实的 `getRemoteAgentFileOps` 钩子体、注入 spy 依赖后 `new Function` **实际执行**，
  断言 `mcpr:` 时被 mock 的 SSH pool `get` **零调用**且不抛 `remote SSH host …`，并含反向保护（SSH host 仍走 pool、
  不在 pool 仍 fail loud）。该文件的 `stripTypeScriptSyntax` helper 用 **`ts.transpileModule`** 实现（不要回退成逐条正则，
  否则实现侧写法一改就会假红）。
  **已知未修复**：MCPRouter（`mcpr:`）**Claude** 会话的远端 Skill 发现仍不可用 —— 本轮的修复只是把误导性的
  `remote SSH host "mcpr:…" not found in pool` 改成 `[MCPR_FILE_OPS_UNAVAILABLE]`（**归因修正，失败语义不变**），
  真正的修复需要在 MCPRouter 侧为 cc-manager 协议新增 file-ops 能力（跨仓协议变更）。Codex 侧则已按 transport 分类
  返回空 reader（下游 `hasCurrentTeammateInstructions` 的契约为「不可读 ⇒ 重新投递」，安全）。
  **存量残留（本轮未修，需先定契约）**：`maker-host/index.ts` 的 `fingerprintSkillSource` / `readSkillSource`
  仍是 SSH-only，Meka bot 跑在 MCPRouter **Codex** 会话且配了 Skill 时静态可达；修法取决于「降级为
  `unavailableSkills`」还是「fail closed」的产品口径。
- **实机验证**：MCPRouter Claude 任务**首次发送**（lazy create）＋ 重启 Desktop 后续聊（恢复路径），**两条都要走**
- **历史回归**：2026-08-25 `LAZY_CREATE_FAILED: remote ssh host not ready: mcpr:<id>`

##### WL-4.1.3 SSH-only recovery 路径过滤 `mcpr:`

- **代码锚点**：`maker-ipc/register.ts:7471-7476`（早返回先于 pool 查询）、`:7409-7419`、`:7443-7463`；`apps/desktop/src/main/maker-host/remote-codex-mcp-recovery.ts:91-116`（自身不分类，依赖调用方保证）
- **自动化门禁**：`remoteCcQueryFactory.test.ts` 的 SSH shutdown 用例；**turn-settled / shutdown 的 mcpr 过滤无自动化覆盖**
- **实机验证**：MCPRouter 任务 turn 运行中触发 bridge 重建（改全局插件或 Maker Memory 开关），turn 结束后无 pool 报错且可继续下一轮

##### WL-4.1.4 Claude 隧道先于 SSH pool，且共享 cc-manager client 双形态

- **代码锚点**：`maker-host/index.ts:1200-1223`（`openMcprTunnel` → `openCcManagerSession({ stream, transportId })`；SSH 分支 `:1225-1228` 在其后）；`apps/desktop/src/main/maker-host/cc-manager-client.ts:292-294`（`host?` 与 `stream?` 并列）、`:67-92`、`:363-368`、`:391`（approval）、`:415`（`SUBAGENT_MODEL_ACCESS`）、`:447`（`MCP_TUNNEL_CALL`）
- **不变量**：两种 transport 上都要保留 approval、subagent model access（protocol 4）、bundle hello 与 MCP tunnel 投影
- **自动化门禁**：`remoteCcQueryFactory.test.ts` 的 `routes Claude through the MCPRouter tunnel before any SSH pool lookup` 与 `keeps byte-stream MCP projection and v4 model access on the shared cc-manager client`；`mcprTunnelMeka.test.ts`
- **实机验证**：MCPRouter 实例跑 Claude 任务并触发远端 subagent 与远端 MCP 调用；审批卡正常弹出

##### WL-4.1.5 Codex MCPRouter 分支必须**成组**保留

- **不变量**：transport + remote credential mode（固定 `gateway-key`）+ capability thread register/unregister 三项**缺一即在启动鉴权或远端 Skill 路由阶段失败**；不得在 maker-core 解析 `mcpr:` 前缀
- **代码锚点**：`maker-host/index.ts:1975-1988`（`:1980` 抛 `[MCPR_INSTANCE_NOT_READY] Invalid MCPRouter Worker target`；`:1983-1987` `createMcprCodexTransport`）、`:2023`；`maker-host/remote-session-routing.ts:25-31`；`maker-host/mcpr-codex-capability.ts:198-217,226-262`；`maker-ipc/register.ts:6680-6717`（ensure → bind → 成功 release 旧 handle / 失败 unbind + 恢复）
- **自动化门禁**：`pnpm --filter desktop exec vitest run src/main/maker-host/__tests__/mcprCodexCapability.test.ts src/main/maker-host/__tests__/mcprCodexTransport.test.ts`
- **实机验证**：MCPRouter Codex 实例任务需 `lizi_capabilities` 可用 + Gateway key 有效。**关键负向**：本机 Codex OAuth 处于 `token_revoked` 恢复态时，`mcpr:` Codex 任务**仍应正常启动**（证明未回落本机 OAuth）
- **历史回归**：2026-08-25 的 `/v1/responses stream disconnected before completion` 是上游瞬时失败，**不得**归因为 transport 回归或据此回退 capability routing

##### WL-4.1.6 远端运行时版本门禁（pin + protocol 协商 + fail closed）

- **不变量**：`protocol/hello` 必带 `bundleVersion`（可兼容旧 daemon 不回显，但不得省略请求参数）；manager version 相同但 protocol 不同同属不可部署的 pin mismatch
- **当前 pin**：bundle `0.0.10` / protocol `5` —— `packages/maker-cc-manager/src/protocol.ts:42,51`；v5 语义 = root-only `toolGuards` 接受原生 `AskUserQuestion`
- **代码锚点**：`packages/maker-cc-manager/src/server.ts:215-256`（bundleVersion 必填、`INVALID_BUNDLE_VERSION` / `INVALID_PROTOCOL_VERSION`、protocol ≥ 3 才广告 capability endpoint）；`maker-host/cc-manager-client.ts:369-371,382`；`maker-host/mcpr-codex-capability.ts:33,72-77`；`apps/desktop/src/main/remote-ssh/cc-manager-install.ts:384-391,408-449`
- **自动化门禁**：`pnpm --filter @cindy/maker-cc-manager exec vitest run __tests__/protocol.test.ts __tests__/server.test.ts`（`protocol.test.ts:23,27` 硬断言 5 与 `'0.0.10'`）
- **⚠️ 已知测试缺口**：`mcprCodexCapability.test.ts` 把 `CC_MGR_BUNDLE_VERSION` mock 成 `'0.0.7'` 并断言同名用例，**不随真实 bundle 漂移变红**，只守客户端装配形状
- **实机验证**：MCPRouter 侧 bundle pin 与 Cindy 一致；**部署新 bundle 后必须重启 runtime**。跨仓：MCPRouter 完整构建会静态核对构建脚本/daemon/smoke 三处 pin 并探测从 `CINDY_SRC` 生成的真实 bundle
- **历史回归**：2026-08-05 三次（漏传 bundleVersion、`cindy/0.144.1`、`expected 0.0.6/protocol 3, got 0.0.6/protocol 2`）；2026-08-24 跨仓发布漏项。**本轮同步把 pin 提到 `0.0.10/protocol 5` 时本清单与规则正文都曾落后一版**（已修）

##### WL-4.1.7 Codex 最低运行时 fail closed

- **不变量**：远端 `codex-appserver` 低于 `0.145.0` 时必须 fail closed 并提示升级 MCPRouter runtime，**不得为了让会话启动而关闭 capability routing**
- **代码锚点**：`maker-host/mcpr-codex-capability.ts:84-88`（抛 `[MCPR_CAPABILITY_UNAVAILABLE]`）、`:114-116`；`packages/maker-cc-manager/src/server.ts:248-253`；`maker-host/capability-routing.ts:191`
- **自动化门禁**：`mcprCodexCapability.test.ts` 的 probe 用例；**0.145.0 的显式版本比较无自动化覆盖**（当前靠 capability endpoint 缺失副作用 fail closed）
- **实机验证**：远端 `lizi_capabilities` 的 `list_skills` / `read_skill` 与 dynamic tool 均可用；低于 0.145.0 时必须给出明确升级提示

##### WL-4.1.8 远端角色 Skill bundle 的 revision 契约与成对 release

- **不变量**：`bundle/ensure` → 注册 revision → 远端 plugin 路径交原生加载；关闭/失败/revision 替换时**成对 release**；恢复继续用任务绑定的原 revision；Desktop 不在远端重建 `SKILL.md`；普通 SSH + Meka native Skills **明确失败**，不退化成 prompt
- **代码锚点**：`maker-host/meka-remote-codex-bundle.ts:13`；`maker-ipc/register.ts:6667-6700`（`:6674-6679` 普通 SSH 明确抛 `Meka native Skills are not available on legacy SSH sessions`）；`maker-host/mcpr-codex-capability.ts:118-149`（失败回滚 `bundleRelease`）、`:151-165`、`:220-224`
- **自动化门禁**：`pnpm --filter desktop exec vitest run src/main/maker-host/__tests__/mekaRemoteCodexBundle.test.ts src/main/maker-ipc/__tests__/mekaRuntimeInjection.test.ts`
- **实机验证**：Meka 角色配含脚本/二进制资产的 Skill → MCPRouter 远端任务可原生加载并读取资产；关闭会话后远端 bundle 已释放

#### WL-4.2 ORCA worker 支持远程 MCPR 实例会话

##### WL-4.2.1 Host 解析远程 worker 目标（模型不得自拼 `mcpr:`）

- **不变量**：`remoteHostId` 与 `workerAgent` 是**任务级可信字段**，由 Host 注入；模型必须原样传递；创建入口**重新核对**稳定 `id`、项目绑定、在线状态、实例 `agentType` 与 capability，**不得把 prompt 字段当授权事实**；resolver 返回**注册表值而非请求值**（伪造 `workingDir` 被丢弃）
- **代码锚点**：`apps/desktop/src/main/maker-ipc/mekaWorkerTarget.ts:90-195`（仅 claude-code/codex；严格 parse；项目 binding；稳定 id；supported+available；`:159-163` 返回注册表值；本地分支走 P4 root 白名单）、`:32-38`；`maker-ipc/orcaWorkerCreationService.ts:703-709`；`packages/lizi-mcps/src/xdt-helper/create_worker.ts:104-108,206`
- **自动化门禁**：`pnpm --filter desktop exec vitest run src/main/maker-ipc/__tests__/mekaWorkerTarget.test.ts src/main/maker-ipc/__tests__/orcaWorkerCreationService.test.ts`（含伪造 `/forged` 被拒的用例）
- **实机验证**：Meka 项目绑定 MCPRouter 实例 → 发起协同 → Lead 派发远端 worker；worker 在目标实例启动，且 Lead 未自行发现目标。负向：派往未绑定实例必须被拒

##### WL-4.2.2 worker bootstrap 的 remote ensure 与 gateway 路由

- **不变量**：`mcpr:` worker 不做完整 SSH preflight（但 remoteHostId 写入、makerMemory 回填、agentKind 解析仍要执行）；MCPRouter Codex 的 provider 强制 `'xd'`（Gateway key），session state 与 UI 都必须显示 gateway 路由
- **代码锚点**：`maker-ipc/orcaWorkerCreationService.ts:1106-1110`（remoteHostId 存在才 ensure）、`:848-877`（无 key 失败；必须 provider `xd`；强制 `providerId = 'xd'`）、`:1084`、`:1175`；`maker-ipc/register.ts:7264-7290`；`maker-host/mcpr-codex-capability.ts:275-316`（`:289-294` 抛 `[REMOTE_CODEX_GATEWAY_KEY_REQUIRED]`）
- **自动化门禁**：`orcaWorkerCreationService.test.ts` 的四条（gateway 路由 / 缺 key 拒绝 / 远端 lead 才 ensure / remoteHostId 继承）
- **实机验证**：Gateway key 有效时 worker 启动、远端 Skill 与协同工具面可用；清空 key 时必须明确报错，**不得静默回落本机 OAuth**

##### WL-4.2.3 SAGA2 战斗 Lead 的服务器只读 Worker（第三条独立通路）

- **不变量**：目标由 Host 筛选（绑定 + supported + available + server 类 + 有 workerAgent），**零个或多个 capability-ready 候选都不猜选**（`ready.length === 1`）；派发前**再授权**（`remoteHostId` / `workerAgent` / 实例实际 `agentType` 三者全等）；远端只读 worker 隔离本地平台状态与本地 skill 路径；`initial_task` 只带逻辑证据，不带 Lead 主机绝对路径
- **代码锚点**：`mekaWorkerTarget.ts:23-25,40-79`（`:78` 唯一命中判定）；
  `apps/desktop/src/main/meka-injection/mekaCombatPrompts.ts:134-150`（`combatServerTargetPrompt`：unavailable 时明确禁止自行拼 `mcpr:`）、`:26-39`（`COMBAT_SERVER_WORKER_PROMPT`，worker 独占段）；
  `meka-injection/mekaResolvePlan.ts:643-696`（形态 C 每轮续聊的 `prepareCombatFollowupRuntimeContext`）、`:222-248`（服务器目标解析，unavailable 也注入）、`:568-577`（常规创建的服务端目标注入点）；
  `meka-injection/mekaResolvePlan.ts:445-506`（强制项目+角色 → 平台技能/MCP 合并 → 快照物化）、`:508-554`（worker/角色段 + `vendorOptions` patch）；
  `maker-ipc/register.ts:6569-6576,12204-12210`；**派发前再授权** `apps/desktop/src/main/meka-projects/combatWorkflowPolicy.ts:1291-1327`（`:1311-1321` 三者全等）、`:1270-1275`
- **自动化门禁**：`pnpm --filter desktop exec vitest run src/main/maker-ipc/__tests__/mekaWorkerTarget.test.ts src/main/maker-ipc/__tests__/mekaRuntimeInjection.test.ts`（含「多于一个合格候选 ⇒ unavailable」）
- **实机验证**：SAGA2 项目绑定 server 类实例 → 战斗角色任务给技能 ID → 远端只读 worker 落在绑定实例并返回能力报告。负向：绑定两个合格实例时必须走 unavailable 分支

##### WL-4.2.4 实例选择与 `agentType` 决定 vendor

- **不变量**：`agentType` 是契约、`instanceId` 只是显示数据；UI 选中实例后引擎必须与实例类型一致
- **代码锚点**：`apps/desktop/src/renderer/features/cc-agent/NewMakerDraftRoute.tsx:3431-3461`（`:3446` `instance.agentType === 'codex' ? 'codex' : 'cc'`、`:3452` 直接取 `instance.remoteHostId`）、`:1470-1475`、`:1045`、`:6222`；`meka-settings/routerService.ts:157`
- **自动化门禁**：**无自动化覆盖**（未找到覆盖 `handleSelectRemoteSession` 的用例）
- **实机验证**：选 Claude 实例应切到 cc、选 Codex 实例应切到 codex；未连接 Router 时能看到连接恢复入口

### WL-5 登录页 CN / GLOBAL 与实际链路

**保护的不变量**：区域有**三层**语义，必须分清——① 构建期区域（烘焙进包，决定默认
edition 与端点自举）；② 登录页实际认证的 **realm**;③ 运行期产品 **edition**
（决定目录、法务链接、货币、区域标注等产品能力）。**切区不改变安装身份**：
`brandIdentity` 里 cn/global 返回同一 `appId` / `userDataDirName` / `executableName`
（见 WL-6.1），只有 `dev` 独立。规则正本：
[`region-and-editions.md`](../product-rules/region-and-editions.md)（**无限定词身份归 Global，
未显式指定区域一律落 `global`，只标注中国大陆版**）。

> ⚠️ **本节的第 6 项最容易被合并吃掉**：上游把区域当构建期维度、运行期不可切换（该文件 §2.4），
> 而 Meka 必须允许运行期切换（见 WL-5.6）。区域相关的消费点一律走**运行期 edition**，
> 不得回退 `CURRENT_CINDY_REGION`。

#### WL-5.1 构建期区域烘焙与默认落区

- **不变量**：未注入区域一律默认 `global`；非法值**抛错**（宁可构建失败也不打出身份错误的包）
- **代码锚点**：`apps/desktop/src/shared/brandRegion.ts:22`（`CURRENT_CINDY_REGION = resolveCindyRegion(import.meta.env.VITE_CINDY_AUTH_REGION)`）、`:27`（`CURRENT_APP_ID`，AUMID 三位一体）；`packages/maker-shared/src/brandIdentity.ts:44-61`（`DEFAULT_CINDY_REGION = 'global'`、`resolveCindyRegion` 非法值抛错）
- **自动化门禁**：`pnpm test:runner` 内 `scripts/__tests__/desktop-dev-region.test.mjs`；`pnpm --filter desktop exec vitest run src/renderer/components/login/__tests__/LoginPage.region.harness.test.tsx`
- **实机验证**：不传区域起 dev → 落在 global（`DESKTOP_DEV_VERDICT` 的 `region=global`）

#### WL-5.2 端点清单按区域选择（实际链路）

- **不变量**：cn 与 global 走**不同的端点清单文件**，主进程经
  `XDT_ENDPOINT_MANIFEST_FILE` 读文件模式；`dev` 是内部构建身份、行为语义归 cn 系
- **代码锚点**：`scripts/shared/client-endpoint-build-env.mjs:27`（`{ cn: 'endpoint.json', global: 'endpoint.global.json', dev: 'endpoint.dev.json' }`）、`scripts/shared/endpoint-local-file.mjs:38-39`、`scripts/shared/desktop-dev-region.mjs:125-126,138-140`；`config/endpoint.json`（CN 正本：`*.cindy.com.cn`）、`config/endpoint.global.json`（Global 正本：`*.cindy.app`）；`apps/desktop/scripts/publish-desktop.mjs:29-30,117`（发布时把对应清单推到 CDN 根）
- **不变量**：`cdnBaseUrl` 决定更新/hotfix 链，**不同渠道靠不同 OSS bucket 区分、不靠路径前缀**（`brandIdentity.ts:113-119`）
- **自动化门禁**：`pnpm test:runner` 内 `scripts/__tests__/client-endpoint-build-env.test.mjs`、`endpoint-local-file.test.mjs`、`endpoint-consistency.test.mjs`；`pnpm check:endpoints`；`pnpm --filter desktop exec vitest run src/main/__tests__/clientEndpointsService.test.ts`
- **实机验证**：分别以 `--endpoints-cdn` 与仓内清单启动，确认登录请求打到对应域
  （`*.cindy.com.cn` vs `*.cindy.app`）

#### WL-5.3 登录页区域呈现与 SSO 跨区确认

- **不变量**：provider 集合按**发现到的 realm** 呈现（不冒充构建区域）；企业 SSO 跨区发现时
  必须让用户**显式确认**目标区域，不得静默切换；区域徽标**只标注中国大陆版**（无限定词归 Global）
- **代码锚点**：`apps/desktop/src/renderer/components/login/LoginPage.tsx:344`（`loginState.providers.region`）、`:1476`（`realmConfirmation.targetRegion === 'cn'`）；`apps/desktop/src/renderer/components/login/LoginControls.tsx:95-149`（`regionPill` / `data-testid="login-region-pill"`）；Host 侧 `apps/desktop/src/main/authManager.ts:5223`（`pendingAuthRealm !== confirmation.targetRegion`）、`:5296`（`targetRegion: discovery.region`）
- **自动化门禁**：`pnpm --filter desktop exec vitest run src/renderer/components/login/__tests__/LoginPage.region.harness.test.tsx src/renderer/components/login/__tests__/LoginPage.regionPill.test.tsx src/renderer/components/login/__tests__/LoginPage.harness.test.tsx`
- **实机验证**：global 构建登录页**无**区域徽标；cn 构建显示「中国大陆版」徽标；
  用跨区 SSO 账号登录时出现区域确认对话框，确认后落到对应 realm

#### WL-5.4 运行期 edition 与安装身份解耦

- **不变量**：`edition` 是**内存态登录会话 override**，随登录所在 realm 落定
  （`global` → global，其余 → cn），成功后持久化供重启恢复；**登出会清掉它并恢复构建区域**；
  企业 SSO 跨区发现**不改变** edition；**安装身份（appId/userDataDirName/executableName）永不随 edition 变化**
- **持久化 key**：`cindy_product_edition_v1`（`PRODUCT_EDITION_KEY`）
- **代码锚点**：`apps/desktop/src/main/authManager.ts:208`（key）、`:382-383`（`activeProductEdition` 初值 = 构建区域）、`:1875-1879`（读持久化）、`:4582`（重启恢复）、`:4905-4906`（`authRealmForEdition`）、`:4940`（按 realm 落定）、`:5097-5099`（成功后写入）、`:3560-3564` 与 `:3651`（登出清掉并恢复）；渲染侧 `apps/desktop/src/renderer/contexts/AuthContext.tsx:73,138,234`
- **自动化门禁**：`pnpm --filter desktop exec vitest run src/main/__tests__/authLoginFlowReset.test.ts`（含「登出后恢复构建 edition」「成功后写入 edition」「登出清 key」三条源码序断言）
- **实机验证**：global 包 → 登录页选 CN 区域登录 → 重启后仍是 CN edition；
  登出后回到构建区域（global）
- **历史回归**：本轮同步在 `authManager` 的 `PRODUCT_EDITION_KEY` 上出过 typecheck 断链（
  [`2026-09-origin-main-to-meka-main.md`](../migrations/2026-09-origin-main-to-meka-main.md) §4.2）

#### WL-5.5 edition 的消费面（切区后真正变的东西）

- **不变量**：edition 影响**产品能力投影**，不影响安装身份与本地数据归属
- **代码锚点（每个消费面）**：
  - 模型/供应商目录投影：`apps/desktop/src/main/cindy-brain/index.ts:3560`（`getAuthState().edition`）、`:8147`；`apps/desktop/src/main/maker-host/active-catalog.ts:1086-1103`
  - 法务链接：`apps/desktop/src/shared/legalLinks.ts:31`
  - 货币/计价：`apps/desktop/src/renderer/features/billing/money.ts:14`、`apps/desktop/src/shared/regionalMoney.ts:81`
  - 版本行区域标注：`apps/desktop/src/renderer/components/sidebar/UserInfoSection.tsx:70-80,139-146`
  - 日志上报目标：`apps/desktop/src/main/log-upload/logUploadTarget.ts:117`
  - 埋点项目：`apps/desktop/src/renderer/analytics/tapdbClient.ts:94`
- **自动化门禁**：`pnpm --filter desktop exec vitest run src/main/cindy-brain/__tests__/cindyMediaCatalogEditionWiring.test.ts src/renderer/__tests__/regionCode.consistency.test.ts src/renderer/__tests__/userInfoSectionHover.test.ts`
  - `cindyMediaCatalogEditionWiring` 显式断言目录投影**必须**用 `getAuthState().edition` 而**不得**用构建常量 `CURRENT_CINDY_REGION`
  - `regionCode.consistency.test.ts` 要求新增区域消费链路时把它的 i18n 命名空间登记进去
- **实机验证**：切到 CN edition 后，版本行前缀、货币、法务链接、可用供应商集合同步改变；
  用户数据目录不变（仍是 `CindyMeka`，dev 为 `CindyMekaDev`）
- **已知未收敛的消费点**（上游同步不要误以为它们已改好）：供应商空态引导
  `apps/desktop/src/renderer/hooks/useProviderOnboarding.ts:166,184` 与 IM 机器人可见性
  `apps/desktop/src/renderer/components/settings/ImBotSection.tsx:121` **仍读构建期**
  `CURRENT_CINDY_REGION`。改它们前先按 `region-and-editions.md` §1.2 确认产品意图

#### WL-5.6 运行期切区是 Meka 的刻意分歧（必须保留）

- **不变量**：**上游把区域当构建期维度、运行期不可切换**（`region-and-editions.md` §2.4）；
  **Meka 必须在登录页提供运行期服务区切换**，因为不同区**暴露的模型能力不同**，用户要按
  可用模型选服务区。上游同步若把区域收敛回「只由安装包决定」——例如删掉
  `LoginRealmSelector`、把 `activeProductEdition` 退回只读构建常量、或把
  `getAuthState().edition` 的消费点改回 `CURRENT_CINDY_REGION`——即为**回归**，不得接纳。
- **配套不变量（同一设计）**：跨区既有会话一律可恢复 ——
  `apps/desktop/src/main/authRealmPolicy.ts:7-15` 恒返回 `true`，否则用户切区后另一区凭证
  被静默作废、被迫重新登录；它使 `authManager.ts:4814-4820` 与 `:5712-5717` 的跨区拒绝分支
  成为死代码，这是**有意**的，不是遗漏。
- **代码锚点**：`apps/desktop/src/renderer/components/login/LoginRealmSelector.tsx:5,8,33,41`（只呈现 `cn` / `global`，**不暴露内部 `dev`**）；`LoginPage.tsx:702-710`（`select-realm` 动作）；`authManager.ts:4937-4942`（`selectLoginRealm` 同时落 `pendingAuthRealm` 与 `activeProductEdition`）、`:4944-4979`（企业 SSO 发现**只改 realm、不改 edition**）、`:5219-5255`（确认/取消只回写发现结果与 pending realm）；`authRealmPolicy.ts:7-15`
- **自动化门禁**：`pnpm --filter desktop exec vitest run src/renderer/components/login/__tests__/LoginPage.regionPill.test.tsx src/main/__tests__/authRealmPolicy.test.ts src/main/__tests__/authLoginFlowReset.test.ts`（含 `点击另一区派发显式 select-realm 动作`、`requires confirmation only when enterprise discovery crosses the selected realm`、`canRestoreAuthSessionForMembership` 三条恒真断言）
- **覆盖缺口**：现有门禁以**源码形态断言**为主（实现与断言可被同时覆盖）；建议补一条行为级用例：驱动 `select-realm` 后断言 `activeProductEdition`、`pendingAuthRealm`、生效 `authApiBaseUrl` 三者同时变、而 `getBuildClientEndpoint('cdnBaseUrl')` 不变
- **文档落点**：`region-and-editions.md` §1.2（Meka 例外）+ 本节；**改这两处前不要按 §2.4 删掉选择器**
- **实机验证**：① 默认 Global 启动 → 登录页显式选 CN → 登录后得 **CN 模型目录**；
  ② 登录页选 Global 后走**企业 SSO 登录进 CN 组织** → 产品 edition **仍为 Global**（模型目录仍
  Global），只有认证/账号业务端点走 CN；③ 侧栏版本行在 dev 构建显示 `Global · <版本>`，
  正式 Global 构建只有版本号
- **历史回归**：本轮同步后 `UserInfoSection.tsx` 的源码形态断言因 Meka 保留「运行期
  edition 解构」而无法匹配单行 needle，断言被迫改为格式无关 —— 即这条分歧确实会让上游形态的
  断言失败，**不要据此把 Meka 改回构建期常量**

### WL-6 构建、更新链路与项目标识

**保护的不变量**：Cindy Meka 是**独立新应用**——安装身份、磁盘身份、协议身份、更新渠道
全部独立于上游 Cindy；上游同步不得把任何一项改回 `cindy` 系列。身份字面值的**单一事实源**
是 `packages/maker-shared/src/brandIdentity.ts`，脚本侧只能**镜像**（`.mjs` 无法 import TS）。

#### WL-6.1 身份字面值单点与镜像一致性

- **字面值（`brandIdentity.ts:137-172`，改动即兼容红线）**：
  `executableName: 'CindyMeka'`（cn/global 同、dev `'CindyMekaDev'`）；
  `appIdByRegion` cn/global `'com.xd.cindy.meka'`、dev `'com.xd.cindy.meka.dev'`；
  `primaryScheme: 'cindy-meka'`；`legacySchemes: ['xdmaker-meka','xdt-maker']`；
  `acceptedUnregisteredSchemes: ['cindy']`；`userDataDirName: 'CindyMeka'`；
  `legacyUserDataDirNames: ['xdmaker-meka','xdt-maker']`；`desktopDeviceIdPrefix: 'cindy-meka-'`；
  `cdnPrefix: 'cindy-meka'`；`updaterName: 'cindy-meka-updater'`；`dbFilePrefix: 'cindy-meka'`；
  `legacyDbFilePrefixes: ['xdt-maker']`；`fileAssociationProgIdByRegion` `'CindyMeka.CindyGhost'` / dev `'CindyMekaDev.CindyGhost'`
- **不变量**：`legacy*` 三组**只增不减**（老用户机器上的存量注册与文件可能永远带旧值）；
  `cn`/`global` 返回**同一** appId / userDataDirName / executableName（切区不改安装身份）；
  永久不随本配置变化的标识符（`xdtMaker.*` settings 键、`xdt-image://`、`.cshare`、
  localStorage 键）由各自模块维护，**不要从这里派生**
- **代码锚点**：`packages/maker-shared/src/brandIdentity.ts:137-172`、`:44-61`（`DEFAULT_CINDY_REGION='global'` 与 `resolveCindyRegion` 非法值抛错）；消费方 `apps/desktop/forge.config.ts:48,1340-1342,1383`、`apps/desktop/src/main/devKeychainName.ts:191`、`apps/desktop/src/main/legacyUserDataMigration.ts:972-973`、`apps/desktop/src/main/localDb/dialogueWorkdirSelfHeal.ts:67-70`
- **自动化门禁**：`pnpm test:runner` 内的 `scripts/__tests__/brand-identity-sync.test.mjs`（逐个比对 `.mjs` 镜像：`ci/lib.mjs`、`smoke-packaged.mjs`、`restart-desktop-remote.mjs`、desktop dev userData 区域表、`package.json` productName）与 `scripts/__tests__/meka-release-identity.test.mjs`
- **实机验证**：`pnpm restart:desktop:remote` 起的是 `CindyMekaDev` 身份、userData 落在
  `CindyMeka-dev2-*`；打包后产物名为 `CindyMeka`（见 WL-6.3）
- **历史回归**：本轮同步在 main 侧身份/edition 上出过 35 个 typecheck 断链（`PRODUCT_EDITION_KEY`、重复 `BRAND_IDENTITY` 等，[`2026-09-origin-main-to-meka-main.md`](../migrations/2026-09-origin-main-to-meka-main.md) §4.2）

#### WL-6.2 深链：注册主 scheme 与历史 scheme，只解析不注册 `cindy://`

- **不变量**：向 OS 注册 `cindy-meka` **与**两个历史 scheme（老链接仍能唤起新应用）；
  `cindy://` **只解析不注册**——不能抢占同机上游 Cindy 的系统协议所有权
- **代码锚点**：`apps/desktop/src/main/deepLink.ts:27,38,538-554`（packaged 直接 `setAsDefaultProtocolClient(scheme)`，dev 带 execPath 与脚本路径）；`apps/desktop/forge.config.ts:1342`（`allDeepLinkSchemes()` → `x-scheme-handler/*` mimeType 注册）
- **自动化门禁**：`apps/desktop/src/main/__tests__/deepLink.test.ts`；scheme 字面值由 `brand-identity-sync` 与 `brandIdentity.test.ts` 覆盖
- **实机验证**：打包后检查 OS 注册表/`.desktop` 只含 Meka scheme；用 `cindy-meka://` 链接可唤起；
  用 `cindy://` 链接应被**解析**但不构建出注册项

#### WL-6.3 打包产物名与更新器身份

- **不变量**：产物基名 `cindy-meka-<version>`（versionless 为 `cindy-meka-unversioned`）、
  build-info `product = 'cindy-meka-desktop'`；更新器源 bin 名保持 `cindy-updater`（Cargo 产物名）
  但**打包落点**是 `cindy-meka-updater`；ZIP 命名保持 Meka 既有形态（Windows 无 arch 后缀、
  macOS 带 arch 后缀），**不得**重新引入 `-hotfix.zip`
- **代码锚点**：`apps/desktop/scripts/ci/package-lib.mjs`（`artifactBaseName` / `buildBuildInfo`）、`apps/desktop/scripts/ci/lib.mjs`（`PACKAGED_APP_NAME = 'CindyMeka'`）、`apps/desktop/scripts/smoke-packaged.mjs`、`apps/desktop/forge.config.ts`（`cindy-updater.exe` → `resources/${UPDATER_EXE}`）、`apps/desktop/scripts/package-desktop.mjs`（ZIP 命名）
- **自动化门禁**：`scripts/__tests__/meka-release-identity.test.mjs` 的前两条用例（`artifactBaseName` / `buildBuildInfo` / 五个镜像字面量）；`scripts/__tests__/meka-release-flow.test.mjs`（发布顺序、canary manifest、RustFS 前缀与 bucket、HTTPS-only 根、版本不可降级）
- **实机验证**：跑一次 `pnpm release:package`（或读 build-info）确认产物名与 `product` 字段；
  **注意**：真实发布与签名属外部写入操作，需用户明确授权

#### WL-6.4 签名：Windows 旧 Meka 签名服务、macOS 既有 Meka 证书

- **不变量**：Windows 走既有 Meka 签名服务且**不把 `NPKG_TOKEN` 泄漏进命令行**
  （token 经环境变量传给 `sign.py`，不得出现在 argv）；macOS 接受既有 Meka 证书、
  **不强制** notarization 凭证（`self-signed` + `timestamp: false`）
- **代码锚点**：`apps/desktop/forge.config.ts:97-111` 一带（`process.env.NPKG_TOKEN?.trim()`、`python "${signScript}" {file}`）、`apps/desktop/scripts/package-desktop.mjs`（`delete forgeEnv.NPKG_TOKEN`；`requestedSigningMode === 'self-signed'`）、`apps/desktop/scripts/sign.py`（`os.environ.get("NPKG_TOKEN")`，不读 `sys.argv[2]`）
- **自动化门禁**：`scripts/__tests__/meka-release-identity.test.mjs` 的后两条用例
- **实机验证**：需真实签名服务/证书与发布授权，**不在沙箱内做**；未验证时必须标注

#### WL-6.5 更新通道的 Meka 渠道身份

- **先分清哪些不是 Meka 分歧**：`canary > beta > release` 的优先级、`Beta 测试渠道` 设置卡片、
  `updateChannelStore` / `updateChannelCapability` 与上游**逐字节相同**，按上游处理即可（见 §7）。
  本项只保护**渠道身份与根地址**这层 Meka 专属差异。
- **不变量**：更新器产物名是 `cindy-meka-updater`（**不是** `xdt-updater`，也不复用上游名）；
  发布根是 Meka 的 RustFS 前缀与专用 bucket；所有发布根**必须 HTTPS**；
  CN 与 Global 靠**不同 bucket** 区分而**不是**路径前缀；canary manifest 必须记录每个
  已发布的 runtime 资产（`claudeCode` / `codex` 单文件 / `codexPackage` 目录分发 / `ripgrep`
  / `pi` 目录分发 五段齐全——`codexPackage` 是 ≥0.0.21 桌面端启动消费的段，漏发即「环境初始化
  失败」；`pi` 是 Pi agent 的**唯一** runtime 来源（安装包不内置、客户端无本地回退），漏发即
  packaged 包里 Pi agent 不存在、只在 pi 路由上默认开启的模型集体消失）；
  发布顺序 SemVer 感知且**拒绝稳定版降级**
- **代码锚点**：`packages/maker-shared/src/brandIdentity.ts:113-121`（`cdnPrefix` / `updaterName` 与「两区共用前缀、靠 bucket 区分」的注释）；`apps/desktop/forge.config.ts`（`resources/${UPDATER_EXE}`）；`apps/desktop/scripts/publish-desktop.mjs`（`collectPinnedDirDistAssets` / `publishDirDistAssets` / `buildCanaryManifest` 接线）；`apps/desktop/scripts/ci/runtime-release.mjs`（`DIR_DIST_RUNTIME_DEFINITIONS` / `RELEASE_RUNTIME_DEFINITIONS` / `PI_DIR_DIST_DEFINITION`——pi 由 pin 下载后**重打包**，不是原样转发）；`tools/shared/dir-dist-archive.mjs`（重打包的确定性来源）；`apps/desktop/scripts/reset-canary-desktop.mjs`（`allowMissing: ['ripgrep','codexPackage','pi']`）
- **持久化 / 配置 key**：`userData/update-channel-settings.json`（设备级）、`userData/canary-flag.json`（账号级）
- **自动化门禁**：`pnpm test:runner` 内 `scripts/__tests__/meka-release-flow.test.mjs`（`Cindy Meka release roots are HTTPS-only`、`RustFS object keys stay inside the Cindy Meka prefix`、`dedicated cindy-meka bucket may publish at bucket root without a duplicate prefix`、`release ordering is SemVer-aware and refuses stable downgrade`、`published endpoint manifest keeps CN services but does not inherit Cindy updates`、`canary manifest records every published runtime asset`——该用例同时断言缺 `codexPackage` 与缺 `pi` 必须报错）、`scripts/__tests__/codex-package-cdn-release.test.mjs`（目录分发段的 pin 锚定、上传校验与不可覆盖）与 `scripts/__tests__/pi-cdn-release.test.mjs`（pi 段的 pin 锚定、重打包布局/主题补齐/字节确定性、`pinned-sha256` 元数据、幂等复用与拒绝覆盖）
- **实机验证**：打包后确认更新器落点名为 `cindy-meka-updater`；更新检查请求打到 Meka 渠道根
  而非上游 `cindy` 根；装包启动后日志出现 `pi agent enabled { binaryPath: ... }`（不是
  `pi runtime not ready: asset_missing`），且 `maker:get-capabilities` 回报三个 agent（含 `pi`）
- **历史回归**：`canaryFlagStore.clear()` 必须留在 passive 实例守卫之后（`authPassiveSharedInstance` 用例）

#### WL-6.6 旧身份只读迁移与 legacy 前缀扫描

- **不变量**：首次登录从旧 `xdmaker-meka` 目录**只读**导入（**不写回、不删除**旧目录）；
  `xdt-maker` 更早期身份继续被 orphan reaper / Codex HOME 接管 / owner namespace 逻辑识别
- **代码锚点**：`apps/desktop/src/main/legacyUserDataMigration.ts:972-973`（`legacyUserDataDirNames` / `legacyDbPrefixes`）；`apps/desktop/src/main/localDb/dialogueWorkdirSelfHeal.ts:67-70,205`；`apps/desktop/src/main/bootstrap-electron.ts:8634`
- **自动化门禁**：`pnpm --filter desktop exec vitest run src/main/__tests__/legacyUserDataMigration.test.ts src/main/localDb/__tests__/dialogueWorkdirSelfHeal.test.ts`
- **实机验证**：`pnpm demo:legacy-migration` 走一遍只读迁移演示；真实升级验证见 §8.2 第 4 条，
  且该验证的预期行为取决于 §8.2 第 2 条（迁移门跟构建区还是跟运行期 edition）的裁决

#### WL-6.7 应用 icon 与打包资源

- **不变量**：应用 icon 走 Meka 自己的资源目录，不随上游品牌资源被替换
- **代码锚点**：`apps/desktop/resources/icon.png`、`icon.ico`、`icon.icns`；`apps/desktop/forge.config.ts:786,1340`（`icon: path.join(__dirname, 'resources', 'icon.png')`）
- **自动化门禁**：**无自动化覆盖**（`forgeMekaResources` 覆盖的是随包 Meka 资源树，不是应用 icon）
- **实机验证**：打包后看 exe/dmg/窗口/托盘图标为 Meka 图标；`resources/icon.*` 三个文件都存在且非空

### WL-8 Meka 技能链与技能市场

**保护的不变量**：Meka 技能有**独立 provenance 与分发渠道**，不被上游 Cindy 技能市场动作
命中；技能安装来源记录为 `channel: 'meka'`；项目角色技能快照按 Meka 语义生成。

**代码锚点**
- `apps/desktop/src/main/meka-skills/service.ts:76,202`（只认 `channel === 'meka'`）
- `apps/desktop/src/main/skillhub/installService.ts:120`、`skillhub/registry/types.ts:45`
- `apps/desktop/src/main/meka-projects/skillSnapshot.ts:305`
- `apps/desktop/src/shared/mekaSkillMarket.ts`
- `apps/desktop/src/renderer/features/skillhub/lib/mekaSkillMarketViewModel.ts`
- `apps/desktop/src/renderer/features/cc-agent/lib/collaborationEligibility.ts:20,41`

**自动化门禁**
- `pnpm --filter desktop exec vitest run src/main/meka-skills src/main/skillhub src/main/meka-projects`
- `pnpm --filter desktop exec vitest run src/renderer/features/skillhub`

**实机验证**：技能页可见 Meka 技能来源标识与计数；从 MCPRouter 技能市场分发一个技能后，
安装记录归属 Meka 渠道而非 Cindy 渠道；Cindy 侧市场动作不改变 Meka 技能状态。

**历史回归**：合并丢过 4 条 Meka SkillHub i18n key 与 23 条 zh-TW 条目（见
[`2026-09-origin-main-to-meka-main.md`](../migrations/2026-09-origin-main-to-meka-main.md)）。

### WL-9 Meka 插件链（市场渠道 + 开发目录模式）

**保护的不变量**
1. 插件市场按 **surface / channel** 分叉：Meka 面板用自己的 endpoint 与凭证，Meka 渠道
   有**独立账本**；`ignoredRoundStorageKey` 的**旧键形态必须保持**
   （`cindy.pluginUpdates.ignoredRound.<mode>.<owner>`），否则老用户「忽略本轮」被换键丢弃。
2. 「从目录加载（开发模式）」整条链路可用，且派生包的 `ghost.json` 是**作者格式**、
   只改身份字段（`id` + 派生 `command`）。
3. 开发副本占用 `meka-dev-*` 派生 runtime ID，不占正式插件 ID，也不改变正式安装状态。
4. `.cindy` 文件关联与安装渠道归 Meka（`channel: 'meka'`）。

**代码锚点**
- `apps/desktop/src/main/cindy-brain/mekaDevPlugins.ts`（派生包、注册表、watcher、打包）
- `apps/desktop/src/main/cindy-brain/index.ts:6862-7080`（`meka-dev-plugins:*` IPC）
- `apps/desktop/src/main/plugin-market/registerIpc.ts:314,326`（channel 校验）
- `apps/desktop/src/renderer/features/plugin/lib/pluginMarketSurface.ts:7,19`
- `apps/desktop/src/renderer/features/plugin/lib/updateAllModel.ts:95-100`
- `apps/desktop/src/main/plugin-market/mekaDownloadPolicy.ts`
- `apps/desktop/src/main/cindy-brain/openFileInstall.ts:29`

**自动化门禁**
- `pnpm --filter desktop exec vitest run src/main/cindy-brain/__tests__/mekaDevPlugins.test.ts`
- `pnpm --filter desktop exec vitest run src/renderer/features/plugin`
- `pnpm --filter desktop exec vitest run src/main/plugin-market`
- `pnpm --filter desktop exec vitest run src/shared/__tests__/ghost.test.ts src/main/cindy-brain/__tests__/forge.test.ts`

**实机验证**：Meka 插件页登记一个真实源码目录 → 卡片出现且带 `DEV` 角标 → 打开界面/使用
可用 → 自动同步（改源码）生效 → 「打包」产出作者身份的 `.cindy` → 移除后正式插件不受影响。
Meka 市场与 Cindy 市场的列表/凭证/忽略本轮互不串台。

**历史回归**
- 开发目录 `EXDEV`（跨卷）与 workdir 安全门（见 `xdmaker-meka-to-cindy.md` §开发目录相关）。
- 重启后旧快照重复启动服务器（同上，§6.30）。
- 本轮同步：派生包写成归一化清单导致「从目录加载」整条不可用（
  [`2026-09-origin-main-to-meka-main.md`](../migrations/2026-09-origin-main-to-meka-main.md) §4.7）。

### WL-10 模型可见性与模型目录

**保护的不变量**：Meka 存量用户升级后**仍能看到合并前的可见模型集合**；显式 override
永远最高优先；「恢复默认」路线继续跟随目录；桌面 / IM / 远端模型列表使用**同一套有效开关**
（override 表或初始化清单变化必须重新镜像给 main，两端不得出现不同口径）。

**代码锚点**
- `apps/desktop/src/renderer/state/modelVisibilityPrefs.ts`（`isModelEnabled` =
  `显式 override ?? 当前目录 defaultEnabled`；`MEKA_UPGRADE_SEED_KEY_PREFIX` 一次性补种
  留痕 + `mirrorToMain`）
- `packages/model-providers/src/sections.ts`（`isModelVisible(override, defaultEnabled)` ——
  两侧共用的**唯一**可见性决策纯函数）
- `apps/desktop/src/main/localDb/modelDefaultsProfile.ts`（`profileOrigin` 定性）
- `apps/desktop/src/main/maker-host/model-visibility-mirror.ts`（非 strict 策略：未知路线
  `getModelVisibilityOverride` 返回 `undefined` ⇒ main 侧跟随目录；仅本地 override 表无法
  解析时渲染进程才请求 `fallback: false` 失败关闭）
- `apps/desktop/src/renderer/components/settings/UnifiedModelList.tsx`（行渲染只看准入轴）
- `apps/desktop/src/renderer/components/new-chat/ModelSelector.tsx`
- `packages/model-providers/src/unifiedSelection.ts`、`packages/model-providers/src/modelList.ts`

**自动化门禁**
- `pnpm --filter desktop exec vitest run src/renderer/__tests__/modelVisibilityPrefs.test.ts`
- `pnpm --filter desktop exec vitest run src/renderer/__tests__/unifiedModelList.test.ts src/renderer/__tests__/unifiedModelPanelRendering.test.ts`

**实机验证**：用**合并前的既有 profile** 启动 → 新建任务草稿的模型选择器**非空**且与
设置页开关一致 → IM `/model` 卡片列出的模型与应用内一致（含目录后来新增的默认开模型）→
手动关掉一个模型后重启仍保持关闭。

**最终有效语义（2026-09-18 同步，用户裁决 A = 接纳上游）**
- 可见性恒为 `显式 override ?? 当前目录 defaultEnabled`；初始化清单 `defaults`
  **不再参与可见性判定**，目录后来新增的默认开模型会直接显示。**登记：这是接纳上游本轮语义
  的结果**，也**取代了本条此前的「补种后新增模型不自动开启」表述** —— 该表述已过时。
- 为什么这不违反上面的不变量：Meka 在上一轮同步**之前**的原生口径就是
  `override ?? isModelVisible(undefined, model.defaultEnabled)`，与上游本轮语义**逐字相同**
  （可复核的历史证据：`git show 053b000be7^:apps/desktop/src/renderer/state/modelVisibilityPrefs.ts`
  与 `git show bb3f71d084:apps/desktop/src/renderer/state/modelVisibilityPrefs.ts` 的
  `isModelEnabled` 都只有一句 `return isModelVisible(load()[keyOf(...)], model.defaultEnabled);`
  —— 即「override ?? 目录 `defaultEnabled`」，本轮 `0f65d98231` 只是把同一函数拆成提前
  return 的等价写法）。
  所以「存量 Meka 用户升级后仍能看到合并前的可见集合」由**上游原生满足**；上一轮的补种
  本来就是为这套语义当时缺失而打的补丁，而不是 Meka 需要长期固化的产品分歧。
- Meka 一次性补种**仍然保留**（`MEKA_UPGRADE_SEED_KEY_PREFIX` +
  `profilePrecedesVisibilityInitialization` + `needsMekaSeed`）：对「没有任何有效初始化
  清单」的既有配置写一次性标记，并把升级那一刻的目录基线冻结进 `initialization.defaults`，
  随后重新镜像整表。它的定位是**基线留痕 + 已初始化判定输入**（记录该配置升级时看到过什么、
  供诊断与采纳合并），**不决定可见性**，也不覆盖显式 override。
- 镜像与「恢复默认」都**不读** `defaults`：`mirrorToMain` 推的是
  `effectiveMap(map) => ({ ...map })`（**override 表**）加上**不含 `fallback: false`** 的策略，
  main 侧对未知 key 返回 `undefined` ⇒ 由共享 `isModelVisible` 回落目录 —— 这才是
  IM `/model` 不为空的机制。若把 `defaults` 塞进快照或请求 `fallback: false`，就会退回
  「无记录 ⇒ 整张清空」的上游旧语义（上一轮 P0 形态），故二者都不得做。「恢复默认」写的是
  `followCatalogKeys`（点名路线跟随目录），与 `defaults` 无关。
- 自动化证据：`modelVisibilityPrefs.test.ts` 的
  `mirrors the seeded owner snapshot to main so IM /model is not left empty` 把渲染进程真正
  推给 main 的 `(snapshot, policy)` 喂进**真实** `model-visibility-mirror`，端到端断言 main 侧
  判定与应用内 `isModelEnabled` 逐条一致且未知路线 `undefined`（⇒ 非空）。

**历史回归**：本轮同步 P0，存量用户选择器整张清空（§4.6 同上）。规则见
[`configuration-and-overrides.md`](configuration-and-overrides.md) §2「Meka 谱系条款」。

### WL-11 Meka 项目、角色与正式事项

**保护的不变量**：Meka 原生项目/角色/正式事项是**本地事实源**，其 schema、IPC 与 UI 入口
独立于上游；`'meka'` 会话必须绑定项目+角色身份；Meka 资源树随包发布。

**代码锚点**
- `apps/desktop/drizzle/scripts/0082_meka_product_schema.ts:68-96`（建 `meka_projects` /
  `meka_roles` 与 `sessions` 的 `meka_project_id` / `meka_role_id` / `is_formal` /
  `formal_*` 列及索引）、`apps/desktop/drizzle/scripts/0088_bridge_meka_0_0_11_lineage.ts:286-366`（0.0.11 谱系桥接）
- `apps/desktop/src/main/localDb/schema.ts:86`（`workspace_kind` 枚举含 `'meka'`）、`localDb/mapper.ts:396-409`（meka 身份只对 `'meka'` 绑定）
- `apps/desktop/src/main/localDb/ipc/mekaProjects.ts`、`mekaRoles.ts`、`mekaProjectMetadata.ts`
- 配置不可用项目的**状态投影与恢复入口**（WL-11.9）：`apps/desktop/src/shared/meka-projects.ts`
  （`MekaProject.configUnavailable`、`mekaProjectRegistrationName`）、
  `apps/desktop/src/main/localDb/ipc/mekaProjects.ts:220-260`（`toProject` 的 `file === null` 与
  `fallbackForRow` 两条置位路径）、`apps/desktop/src/renderer/features/cc-agent/MekaProjectRoleEditorRoute.tsx`
  （`projectCardSubtitle`、项目卡片「配置不可用」标识、失败分支的「移除项目注册」）
- `apps/desktop/src/main/localDb/ipc/mekaFormal.ts:9-12`（`meka-formal:*` 四个 channel）
- `apps/desktop/src/main/localDb/ipc/mekaSkillCatalog.ts:5`
- `apps/desktop/src/shared/meka-formal.ts`、`apps/desktop/src/shared/meka-projects.ts`
- `apps/desktop/src/main/meka-projects/`（`projectConfig.ts:451`、`resourcePaths.ts:21`）
- `apps/desktop/src/main/localDb/ipc/sessions.ts:1287,1317,1725`
- 项目/角色**绑定链**（WL-11.1–11.3）：`apps/desktop/src/renderer/features/cc-agent/CCAgentSidebarUpper.tsx:2404-2416`（项目入口 → `makeNewMakerRouteState('meka')` + `mekaProjectId`）、`apps/desktop/src/renderer/features/cc-agent/NewMakerDraftRoute.tsx:868-887`（`mekaSelection` 的 `useState` 初值）与 `:893-918`（依赖 `[routeMekaDraft.mekaProjectId, routeMekaDraft.mekaRoleId]` 的同步 effect）；两处默认角色都 = `roles.find(routeMekaDraft.mekaRoleId) ?? pickDefaultMekaRole(roles)`，即显式优先共享默认角色 `<projectId>-default-role`（见 `shared/meka-projects.ts` 的 `pickDefaultMekaRole`）、`:579-699`（角色选择器 `MekaRolePicker`）、`:4532-4533`（发送时写入 project/role）
- 角色**运行期注入链**（WL-11.5–11.6）：`apps/desktop/src/main/meka-injection/mekaResolvePlan.ts:388-449`（hydrate 持久绑定 → 非 meka 零写入 → 遗留角色回填 → 强制「项目+角色都必须有」；resume 短路分支在 `:286-386`）、`:468-501`（worker 判定 + 平台技能解析 + `mergePlatformMcp`/`mergePlatformSkills`，合并实现 `:200-212`）、`:506`（技能快照物化）+ `:186-193`（`nativeSkillMount`）+ `meka-injection/mekaApplyPlan.ts:96-100`（写 `nativeSkillPluginPath`/`nativeSkillRevision`）、`mekaResolvePlan.ts:508-520`（角色 prompt + 角色上下文注入）+ `meka-injection/mekaCombatPrompts.ts:152-161`（`[MEKA_ROLE_CONTEXT]` 区块）+ `meka-injection/mekaApplyPlan.ts:55-80`（按 order 渲染上提）、`mekaResolvePlan.ts:526-554`（`mekaMcpProviderIds` / `mekaWorkflow` 进 `vendorOptions` patch）+ `mekaApplyPlan.ts:88-91`（写入）
- 角色清单事实源：`apps/desktop/resources/meka/roles/*.json`（`prompt` / `skills[]` / `mcp[]` / `workflow` / `policyProviderRefs`）、`roles/prompts/combat-*.md`（含改名后的 `combat-evidence-budget.md`「证据纪律与收敛」）
- 请求范围与项目参考注入链（WL-11.11–WL-11.15）：
  `apps/desktop/src/main/meka-injection/mekaCombatPrompts.ts`（`classifyCombatRequestScope:461-481`、
  `isCombatScopeAffirmation:495-503`、`combatRequestScopeApprovalPatch:521-544`、
  `combatSkillIdVendorPatchFromUserPrompt:570-611`、`combatScopePrompt:125-175`、
  `combatTargetPrompt:104-117`、`resolveCombatProjectRefPaths:221-246`、
  `combatProjectPathsPrompt:248-284`、`COMBAT_READ_ONLY_UNITY_PIPELINE_COMMANDS:211-214`、
  标注模式与 `技能 N 段/级` 负向先行 `:325-350`）、
  `meka-injection/mekaInjectionTypes.ts:91-101`（`MEKA_PROMPT_SEGMENT_ORDER` 含 `meka.combat.scope: 35`）、
  `meka-injection/mekaResolvePlan.ts:262-269`（`combatProjectReferencePatch`）、`:281-400`（A2 guard、
  目标/范围补丁与证据依据定稿）、`:805-925`（`prepareCombatFollowupRuntimeContext`）、
  `meka-projects/combatWorkflowPolicy.ts:36-88`（会话级 vendorOptions 镜像，A3）、
  `:131-174`（`CombatVendorOptions` 新键）、`:356-413`（表范围目标门禁）、
  `:1030-1049`（精确路径放行）、`:1062-1064`（表范围判定）、
  `:1074-1088`（已批准成员集与截断口径）、`:1165-1188`（`recordCombatScopeSkillIds`，A4）、
  `:1203-1209`（证据依据）、`:1217-1249`（`isCombatScopeResolutionRead`）、
  `:1295-1311`（`isCombatScopeResolutionUnityQuery`）
- 冻结技能与角色契约：`apps/desktop/resources/meka/skills/程序/unity/combat-skill-configuration/SKILL.md`
  （导入/导出回执字段 `:163-167`、只读通道与插件侧 9 项白名单 `:78-84`、`table-scope` 不逐目标派发 `:110-112`）、
  `apps/desktop/resources/meka/skills/程序/unity/saga2-entry-model/SKILL.md:56-59`
- Pi 空回合兜底（WL-11.15）：`packages/maker-core/src/agents/pi/translator.ts:1034-1081`
  （`silentStop` 判定 `:1054-1059`、`done.data` 附加 `:1081`；Host Stop 锁存 `hostStopSeenGeneration`
  与 `isCurrentTurnHostStopSeen` 在 `:275-327`）；
  `apps/desktop/src/main/agent-island/state.ts:84,671-690,752-764`（`AGENT_ISLAND_SILENT_STOP_HOLD_MS = 10_000`
  的挂起兜底；单调锚点 `silentStopHoldMonoUntil` 在 `:172-181`）与
  `packages/maker-core/src/agents/claude-code/translator.ts:2394-2395`（把同一标记挂到配对的
  turn-end `status` 上，使判定与事件顺序无关）；
  `apps/desktop/src/main/maker-ipc/silentStopAutoResume.ts`、`register.ts:4298-4460`、
  `renderer/components/chat/errorReasonI18n.ts:20`
- 插件侧（跨仓，不在本仓）：`C:\Workspace\cindy-meka-plugins\meka-unity\node\worker.cjs:49-59`
  （9 项只读命令白名单，拒绝码 `INSPECT_COMMAND_NOT_READ_ONLY` 在 `:154`）、`meka-unity/ghost.json`
  （`unity_inspect.action` 含 `command`，版本 **1.0.20**）、`meka-p4/ghost.json:34-57`
  （只读 `p4_opened` / `p4_fileinfo`；写入面含 `p4_checkout:120`、`p4_add:132`、`p4_submit:84`，
  版本 **1.0.63**）
- **表范围审批的第二个来源：`ask_user_question` 卡片答案（WL-11.11，2026-09-22 登记）**：
  `apps/desktop/src/main/meka-injection/mekaCombatPrompts.ts` 的
  `isCombatScopeAnswerApproval:592-598`（首词判定；拒绝词表 `:580-581` 优先且**锚定开头**，肯定词
  `:582-583`）与 `combatRequestScopeAnswerApprovalPatch:668-683`（**强制**已知会话处于表范围提案态，
  `:675`），与聊天路径共用补丁尾部 `combatScopeApprovedVendorPatch:606-615` ⇒ 两条路径产出的补丁
  **逐键相同**。消费点唯一：`apps/desktop/src/main/maker-ipc/register.ts:2846-2887`（交互 resolve 口，
  紧跟既有 `goalAskAnswerObserver` 块），对外唯一转出点 `meka-injection/index.ts:31`。
  **同批复核后失效的旧锚点**：`isCombatScopeAffirmation` 现为 `:558-566`（原记 `:495-503`）、
  `combatRequestScopeApprovalPatch` 现为 `:633-649`（原记 `:521-544`）。

**自动化门禁**
- `pnpm --filter desktop run db:validate`（meka 表与列存在、`0000..0107` 完整、journal/snapshot
  对齐、无 schema drift、companion CJS、历史身份冻结）
- `pnpm test:db`（db tier，CI 不跑，必须本地跑）
- `pnpm --filter desktop exec vitest run src/main/meka-projects src/main/localDb/__tests__/mekaWorkspace.test.ts`
- `pnpm --filter desktop exec vitest run src/main/localDb/__tests__/mapperMekaFormal.test.ts src/main/localDb/__tests__/builtinMekaSeed.test.ts`
- `pnpm --filter desktop exec vitest run src/main/__tests__/forgeMekaResources.test.ts`
- `pnpm --filter desktop exec vitest run src/main/localDb/__tests__/meka0011MigrationLineageBridge.test.ts`
- 配置不可用项目的投影与移除入口（WL-11.9）：
  `pnpm --filter desktop exec vitest run src/main/meka-projects/__tests__/mekaProjectsImport.test.ts src/renderer/features/cc-agent/__tests__/MekaProjectRoleEditorRoute.test.tsx`
  （断言 `configUnavailable` 的两种置位路径与列表标记、失败页「移除项目注册」可达、内置项目
  不提供移除、新建项目的注册名不落生成 id）
- 两请求类 / 表范围门禁 / 项目参考路径白名单（WL-11.11–WL-11.14）：
  `pnpm --filter desktop exec vitest run src/main/meka-projects/__tests__/combatWorkflowPolicy.test.ts src/main/meka-projects/__tests__/combatServerCapabilityState.test.ts`
  与
  `pnpm --filter desktop exec vitest run src/main/maker-ipc/__tests__/mekaRuntimeInjection.test.ts src/main/maker-ipc/__tests__/mekaRuntimeInjectionBaseline.test.ts`
  （断言请求分类与补丁形状、未批准表范围只放行有界只读解析与白名单 Unity 命令、
  成员清单由 Agent 自己的只读查询登记且批准后冻结、逐目标只接受已批准范围内的 ID、
  `[SAGA2_PROJECT_PATHS]` 全文与 `vendorOptions` 键序）
  > **规模（2026-09-22 以 `it(` 计数）**：`combatWorkflowPolicy.test.ts` **55** 条
  > （本批交付前 HEAD 为 46 条）、`mekaRuntimeInjection.test.ts` **38** 条（另有 2 组 `it.each`）、
  > `mekaRuntimeInjectionBaseline.test.ts` **18** 条（10 + 8）。这些是**声明数**，不是通过数；
  > 本批交付**没有**重跑这三条命令（见 §8.5 与本条「未实机验证」）。
- Pi 空回合与网关发现（WL-11.15）：
  `pnpm --filter @cindy/maker-core exec vitest run src/agents/pi/__tests__/pi-translator.test.ts src/agents/pi/__tests__/pi-mcp-client.test.ts src/agents/pi/__tests__/cindyBridgeSource.test.ts`
  （断言 cancelled + 空正文 + 非 Host abort 才附 `silentStop`、未披露错误自带 schema、
  未知 server 优先于 per-tool 且点明插件不是 MCP 服务器）
- **实机项已自动化**：`pnpm desktop:session-smoke`（CDP 真实鼠标事件 + 真实模型轮次，覆盖
  WL-11.1–WL-11.8，见下）

**实机验证**（已自动化，2026-09-14 实跑 9/9 PASS）

> **待重跑（2026-09-22）**：项目/角色编辑改为“有变更才出现保存/取消”，并新增共享默认角色，
> 因此下表 **WL-11.1 / WL-11.2 / WL-11.6 / WL-11.8** 的期望值与断言口径已按新契约更新，
> 但**尚未重新实跑**取得新证据；下表的 2026-09-14 证据行保留为改动前的事实。
> 重跑需要**两条命令**：
> - `pnpm desktop:session-smoke` —— WL-11.1/11.2/11.8 的新期望值；
> - `pnpm desktop:session-smoke -- --role 默认角色` —— 只有指定该角色才会命中 WL-11.6 的
>   默认角色反向断言（默认路径落到「通用开发」，该分支不执行；见脚本 `defaultRoleOf` 说明）。
>
> 另需目检：默认角色面板只读且无保存/取消按钮、未编辑的项目/角色页无保存/取消按钮。
> 详见迁移总账 §6.50。

`pnpm desktop:session-smoke` 用真实鼠标事件从侧栏项目入口建草稿、切角色、发消息，并交叉核对
运行期件（库行 / main 日志 / 技能快照），逐项结论：

| 检查 | 断言的不变量 | 实跑证据 |
| --- | --- | --- |
| WL-11.1 | 真实重挂载后，草稿绑定该项目并默认选中该项目的共享默认角色（`<projectId>-default-role`，由 `pickDefaultMekaRole()` 显式指定，不再只靠 `roles[0]` 排序） | 改动前：`项目=SAGA2 默认角色=通用开发`；**新期望：`项目=SAGA2 默认角色=默认角色`（待实跑）** |
| WL-11.2 | 角色选择器列出该项目全部角色，切换后草稿角色随之变化 | 改动前：选项 2 个；**新期望：SAGA2 选项 3 个（默认角色/通用开发/战斗开发）（待实跑）** |
| WL-11.3 | 会话行绑定 project/role、工作目录解析为存在的绝对路径、`is_formal=0` | `workspace_kind=meka project=saga2 role=combat-development is_formal=0 workdir=C:/Workspace/saga2/saga2_project` |
| WL-11.4 | Agent 真实跑完一轮并产出回复 | `回复="收到"` |
| WL-11.5 | 角色上下文注入运行期（由运行中会话回显字段行证明；身份判定锚在 `projectId`/`roleId`，`displayName` 可能被模型按输出语言改写，见 §6） | `projectId=saga2 roleId=combat-development displayName="战斗开发"`（该次逐字复述；另一次实测被改写为 `Combat Development`，仍判通过） |
| WL-11.6 | 运行期按角色解析 workflow / 角色级 MCP / 技能快照含角色声明的技能；**默认角色反向断言**（仅 `--role 默认角色` 时命中）：`workflow=null`、`skillsCount === platformSkillsCount`、MCP 集合除平台基线（`mcp-router`）外为空、快照技能数 === `platformSkillsCount`。**不得**断言 mcp/skills 为空或无快照——Host 平台基线对每个普通 Meka 任务都存在 | `workflow=saga2-combat-development-v1 mcp=mcp-router,project-agent skillsCount=2 快照技能=combat-skill-configuration,platform-capabilities` |
| WL-11.7 | 新会话在 Meka 分区该项目容器内，且不在普通「对话」分组内 | `会话在项目「SAGA2」容器内；普通对话分组排除=已核对` |
| WL-11.8 | 同一项目内再次点击新建入口时保留当前草稿已选角色（现行行为，裁决见 §8.2 第 6 条） | 改动前：`fresh 默认=「通用开发」；切到「战斗开发」后同项目重进仍为「战斗开发」`；**新期望：`fresh 默认=「默认角色」…`（待实跑）** |

**同一配置下角色差异必须真实生效**（WL-11.6 的对照证据，2026-09-14 实测）：

| | `general-development`（通用开发） | `combat-development`（战斗开发） |
| --- | --- | --- |
| 运行期 `workflow` | `null` | `saga2-combat-development-v1`（角色清单声明，运行期生效） |
| 运行期 `mcpProviderIds` | `mcp-router, project-agent, meka-design` | `mcp-router, project-agent` |
| 该会话技能快照 | 12 个（含角色声明的 3 个） | 2 个（含角色声明的 1 个） |
| `skillRevision` | `73d69fa9…` | `fd5891aa…` |

> 只验「能建会话」不足以证明角色机制：角色级 MCP 是**按角色取并集**而非全量继承，技能是
> **按角色 + 平台合并后固化到该会话快照**。上表的差异正是这两条的实测对照。
> 角色取值也不是硬编码：`general-development` 的 `mcpProviderIds` 里出现 `meka-design`
> 只能来自该角色清单的 `mcp[0].providerId`。

**WL-11.9 「配置不可用」项目必须可识别、可移除**（不变量，2026-09-21 登记）：

- 非内置项目读不到有效配置（`.meka/project.json` 缺失／不可读／非法）时，项目投影必须
  `configUnavailable === true`。**不得**把它降级成一个字段齐全、看起来正常的项目——那会让
  `listProjects` 的兜底分支永不执行，并把问题推迟成一个用户在界面上无法自救的死胡同
  （见迁移总账 §6.48）。
- 列表侧：项目卡片显示「配置不可用」标识，副标题改用注册路径（此时描述已不可信）。
- 详情侧：失败分支必须给出原因、下一步和「移除项目注册」出口；内置项目（`isBuiltin`）
  不提供该出口。删除仍只删注册行，`sessions.meka_project_id` 保留（WL-3.2 的历史软引用
  语义不变），因此**不得**把“顺手清理会话引用”当成修复的一部分。
- 注册行 `name` 只作显示兜底，必须写用户可见名称；不得写入生成的 cuid。

**WL-11.10 项目/角色编辑的「有变更才出现保存/取消」与共享默认角色**（不变量，2026-09-22 登记）：

- 项目详情与角色详情在草稿相对上次读取／保存的有效值**没有变更**时，**不得**渲染“保存”或
  “取消”；有变更时两者同时出现。判断必须对属性键序不敏感（草稿由项目文件、项目行、元数据
  列表多源拼装），否则同值不同键序会误判成“有变更”而让按钮常驻。
- 保存成功后必须把服务端返回的文件安装为新的有效值，使按钮立刻回到未编辑状态；取消必须
  恢复有效值且不写库。
- 每个项目的共享默认角色（`<projectId>-default-role`）必须**内置、只读、不可删除**：
  `meka-role:update` 返回 `MEKA_BUILTIN_READ_ONLY`，渲染侧全部字段 `disabled` 且不出现保存
  按钮。它不得注入提示词／规则／技能／MCP／项目元数据，也不得 opt-in 项目 `roleDefaults`；
  在同一份带 `roleDefaults` 的项目配置下，默认角色解析出的 `promptText` 为空、技能与 MCP
  为空，而 `general-development` 仍读到项目默认规则（反向对照，防空跑）。
- 该行必须对**所有**已登记项目存在（内置项目由启动播种收敛，用户新建项目在创建时立即建行），
  且播种的冲突子句只在 `is_builtin = 1` 时生效，不得接管用户自有的同名角色行。**唯一的例外
  是派生 id 已被用户自有行占用**：此时 upsert 静默跳过，该项目没有默认角色——这是刻意的
  「宁可不建，也不夺用户的行」，不是缺陷（见下条锚点）。
- **自动化锚点**：`src/main/localDb/__tests__/builtinMekaSeed.test.ts`（含「派生 id 被用户
  自有行占用时不得接管」的守卫分支用例）、
  `src/main/meka-projects/__tests__/mekaDefaultRole.test.ts`（默认角色只读契约：读清单走内存、
  update 抛 `MEKA_BUILTIN_READ_ONLY`、delete 按内置角色拒绝）、
  `src/main/meka-projects/__tests__/runtimeConfig.integration.test.ts`、
  `src/main/meka-projects/__tests__/mekaProjectsImport.test.ts`、
  `src/renderer/features/cc-agent/__tests__/MekaProjectRoleEditorRoute.test.tsx`。
  **未自动化**：默认角色的 Light/Dark 实机目检与升级库首次启动。
  > **tier 提醒**：`builtinMekaSeed.test.ts` 与 `runtimeConfig.integration.test.ts` 分别位于
  > `src/main/localDb/**`（被 `unit` tier 排除）与 `*.integration.test.ts`（被排除），二者只在
  > 显式 `pnpm test:db` / 全量下运行。因此**只读契约的守护测试刻意放在
  > `src/main/meka-projects/__tests__/`**（unit tier），以免该不变量在 CI 与提交前门禁里无人守护。

**WL-11.11 战斗请求的两请求类与「启发式不得产生 confirmed」不变量**（不变量，2026-09-22 登记）：

- 一条用户消息必须**在任何工具调用之前**被分成 `single-skill` 或 `table-scope`
  （`mekaCombatRequestScope`）：用户明确给出正整数技能 ID ⇒ `single-skill/confirmed`；
  一次给出多个标注 ID ⇒ `single-skill/missing`（歧义，只回同一句单目标追问）；
  表范围形状而无标注 ID ⇒ `table-scope/proposed`。整条消息只有一个裸正整数仍算用户明确提供
  （追问后的标准回复），是 `confirmed`，**不要求**重复「技能 ID」标签。
- **硬不变量**：正则启发式或上下文推断**永远不能**产出 `confirmed`；能产生 `confirmed` 的只有
  「用户明确标注的单个技能 ID」与「用户对已解析范围的显式确认」两条路径。
- 表范围提案后，整条消息只由肯定词与标点组成（`确认/确定/可以/同意/执行/继续/没问题/好的/好/行/
  开始/ok/yes` 的重复组合）⇒ `confirmed` + `mekaCombatScopeApproved=true` +
  `mekaCombatEvidenceBasis='project-reference'`；带业务内容的回复按新指令重新分类，
  不得被当成范围审批（`previousVendorOptions` 已知且非表范围时**不动**任何状态）。
- 进入表范围与切换目标同样作废上一个证据代次，并**显式置空** `mekaCombatTargetSkillId` /
  `mekaCombatTargetSkillIds`（歧义载体不是范围载体）。
- **语义验收步骤**：① 用真事故文本
  「编辑模块:把目前所有怪物技能(怪物配置表里配置的正在使用的)使用的伤害行为10000的data都改成取
  100%的怪物攻击力。补充说明：4 取攻击力百分比 -101 技能表参数1」构造会话，断言**没有**
  `targetSkillId=101`、也**没有** `10000`，而是 `table-scope/proposed` 且
  `targetSkillId` 为 undefined；② 下一轮只回 `确认`，断言状态翻成 `confirmed` +
  `approved=true`；③ 单技能回归：只有 `技能 ID：1009` 时是 `confirmed`、`1009`；
  只回 `1009` 一条裸数字时同样是 `confirmed`、`1009`；`技能ID：1009 技能ID：1010` 是
  `missing` 且不改绑定。
- 范围分类的三道启发式边界（2026-09-22 本批）：① 指代当前目标的限定词「这个/该/当前/本/此 +
  技能」（`COMBAT_CURRENT_TARGET_DEMONSTRATIVE_PATTERN`，排除「这个技能表」）一律按**单技能
  上下文**处理，不判表范围；② 会话**已有用户确认的单技能绑定**时，只有**无歧义表范围**表述
  （显式点名表/清单，或「某类技能」这类按类划分）才允许覆盖该绑定，其余范围量词按「本轮没有目标
  变化」处理（计划层 `suppressTableScopePatchForConfirmedBinding`，`mekaResolvePlan.ts:313-345`）；
  ③ `技能 N 段` / `技能 N 级` 这类数字后紧跟单位/量词的写法**不得**绑成技能 ID（负向先行，
  `mekaCombatPrompts.ts:337`）。
- **自动化锚点**：`src/main/maker-ipc/__tests__/mekaRuntimeInjection.test.ts`（分类与补丁形状）、
  `src/main/meka-projects/__tests__/combatWorkflowPolicy.test.ts`（门禁放行/拒绝）。
- **成员清单：一致性 guard，不是授权边界（A4）**：范围段要求 Agent 在用户批准前先用白名单只读查询
  `legacy_module_query_nodes` 取回「在用集合」，Host 在**未批准**时把该查询里**显式传入**的
  `skill_ids` 记进 `vendorOptions.mekaCombatScopeSkillIds`（`recordCombatScopeSkillIds`，
  `combatWorkflowPolicy.ts:1165-1188`；只在放行路径上调用，见 `:2176-2179`）：去重、按数值升序、
  只留 `/^[1-9]\d*$/`，超过 `COMBAT_SCOPE_SKILL_IDS_LIMIT = 200` 只保留前 200 个并写
  `mekaCombatScopeSkillIdsTruncated=true` 的**诚实标记**（截断的清单不是完整成员集，比对回落到
  「无清单」口径）。**用户确认后不再登记**（清单冻结，防止已批准会话靠再次查询自行扩大成员集）。
  因此「逐目标只接受已批准范围内的 ID」在正常路径上**真的会做成员比对**；`isApprovedCombatTableScopeWithoutList`
  分支（`combatWorkflowPolicy.ts:1097-1103`）只在「用户直接批准、Agent 没查询」或清单被截断时出现，
  那时退化为「每次调用只允许一个已确认范围内的 ID」+ 其余写入门禁约束。
  **强度提醒**：它只证明这些 ID 被 Agent 明确查询过、且整个范围经用户确认，**不证明**它们属于业务
  范围；真正的授权边界仍是 P4 边界、路径白名单、审批位、证据依据与依赖门禁。审批补丁本身
  （`combatRequestScopeApprovalPatch`）仍然只写 `mekaCombatRequestScopeState` / `mekaCombatScopeApproved` /
  `mekaCombatEvidenceBasis`，不写成员清单——成员清单的唯一写入方就是上面那条只读查询路径。
- **卡片答案构成第二个审批来源（2026-09-22 登记，真实缺陷 D8）**：范围审批原本**只**由用户手打的
  聊天消息驱动（`input.prompt` → `combatRequestScopeApprovalPatch`，判据是整条消息只由肯定词与标点
  组成）。用户经 `ask_user_question` 卡片给出的确认走另一条通道（renderer → `RESOLVE_INTERACTION`
  → `register.ts` 的 `resolvePendingInteraction`），**门禁永远看不到** ⇒ 策略层继续按「本轮是表范围
  请求…（尚未确认任何技能）」拒掉每一次调用，连门禁自己要求的那两次 `legacy_module_export_json` 也被
  拒；真实会话 `6811f297-9e32-4d8d-b5d0-0e2be39184b4` 里用户**全程只发过最初那一条聊天消息**，Agent
  无法让卡片确认生效，只能请用户重打同一句话（同批 `a262a888-9db2-45cf-9741-e1463806481b` 同样命中，
  2 / 2）。现行契约：卡片选项**以肯定词开头**即算审批（`isCombatScopeAnswerApproval`，**首词**判定；
  拒绝词优先且锚定开头——确认项标签本身含「先不动」这类子串，子串搜索会把确认判成拒绝），但调用方
  **必须**已知会话处于表范围提案态（`previousVendorOptions.mekaCombatRequestScope === 'table-scope'`）；
  镜像缺失、非表范围、卡片 dismissal（系统空答）或以拒绝词开头一律**不写任何键**（**比聊天路径更
  严**：聊天路径在会话现状未知时仍会写三个状态键）。两条路径产出**逐键相同**的补丁。
  **语义验收步骤**：① 会话为 `table-scope/proposed` 时，用卡片选项原文
  `确认：只改这 15 个伤害节点，技能表参数先不动` 断言产出 `confirmed` + `approved=true` +
  `evidenceBasis=project-reference`；② 同一答案在 `single-skill` 会话、镜像缺失（`undefined`）与空对象
  （`{}`）三种现状下都断言**不产出补丁**；③ 拒绝项 `先不执行，我要调整范围或数值`、空答案与自由文本
  （`把范围改成只改 3001064`）断言不产出补丁；④ 断言卡片路径与聊天路径对同一现状产出**逐键相同**
  的补丁（用例用 `toEqual` 深比较，不是同一对象引用）；
  ⑤ 策略层端到端：未审批时表范围导出被拒（理由含「尚未确认任何技能」）→ 卡片确认补丁写入后**同一轮**
  同一次导出调用放行 → 拒绝项仍然被拒。
  **自动化锚点**：`mekaRuntimeInjection.test.ts` 的卡片判据用例与表格范围前提用例（含
  `treats a card option label as scope approval by its first word, refusal wins (card path)`、
  `requires a table-scope session before a card answer becomes scope approval (card path)`）以及
  `wires the card-answer scope approval into the interaction resolve without touching chat (D8)` 的
  `register.ts` **源码形状断言**；`combatWorkflowPolicy.test.ts` 的
  `lets an ask_user_question card answer unlock the table scope the user actually confirmed (D8)`
  （实现者报告的红→绿证据：把卡片判据换回聊天判据，新用例即以 `expected null to match object` 转红；
  本节登记人**未复跑**）。
  **未实机验证**：`renderer → RESOLVE_INTERACTION → resolvePendingInteraction → agent 继续` 这条真实
  链路**没有**现成 harness，卡片路径只有单测（注入层判据 + 策略层端到端）加一条源码形状断言，
  **无端到端实跑**；多问题卡片只要任一答案文本以肯定词开头即可批准（问题文本不过滤，与聊天路径
  同样的松度）；resolve 时取不到实时 Session 则只写镜像、同一轮可见性顺延到下次派发；每 runtime
  「`Object.assign` 早于首个 `await`」是源码阅读结论，无集成用例钉死。
- **会话级状态在应用重启后为空（A3）**：审批门禁要知道「当前是不是表范围」，而 maker-core 的
  `Session` 只有写入口，因此 Host 维护一份只镜像 `mekaCombat*` 键的会话级 vendorOptions 镜像
  （`combatWorkflowPolicy.ts:36-88`；计划层 bootstrap/resume 记录、`register.ts:12723` 的 `onAccepted`
  记录真正落地的补丁，消费点是 `prepareCombatFollowupRuntimeContext` 的 `previousVendorOptions` 回落值）。
  **它只活在 Desktop 进程内、不进 DB，重启即空**：此时语义是「状态未知」，只写合法的范围键，
  不得把未知当成「非表范围」或「可以审批」。`forgetCombatVendorOptions` 目前没有生产调用方，
  会话结束不清镜像。**卡片路径的 `previousVendorOptions` 取自同一份镜像**
  （`register.ts:2858` 的 `readCombatVendorOptions`），因此它比聊天路径**更严**：镜像为 `null` 或镜像里
  不是表范围时**一律不写**（见上条）。
- **未实机验证**：真实会话里该文本走完一次「解析 → 只读查询登记成员 → 确认 → 逐目标实施」的全链路；
  成员清单（A4）与镜像（A3）都只有单测，**没有端到端实跑**，也没有跨进程/重启后的实测证据。
  见迁移总账 §6.56「已知不一致与强度提醒」（证据依据那一条已于 2026-09-22 同日后修订解决，见 WL-11.12）。

**WL-11.12 项目参考路径注入与精确路径白名单**（不变量，2026-09-22 登记）：

- `[SAGA2_PROJECT_PATHS]` 必须注入 `moduleEditorSkillPath`、`damageEncodingRulePath` 的**绝对
  路径 + ReadCommand**（`moduleEditorSkillReadCommand` / `damageEncodingRuleReadCommand`），
  取值唯一来源 `resolveCombatProjectRefPaths`；两条路径必须由 Host 从 `workingDir` 解析，
  **不得**由模型二次拼接或在代码里硬编码任何机器路径。
- 策略层的精确路径白名单唯一来源是 `vendorOptions.mekaCombatProjectRefPaths`；**未注入 = 空 =
  一律不放行**（fail-closed）。放行粒度是**单文件全等路径**：通配、`?`/`*`/`[`、目录、
  路径穿越、`-Recurse`、`Get-ChildItem`、`Select-String -Path $files` 与
  `01-治理规范-governance/` 仍然拒绝；`ModuleV2` 与共享 `skill_entry_model_editor.json`
  仍被禁止。
- 领域事实分层不得回退：冻结 Skill 只写**流程与权限**，模块字段/编码/类型字典/伤害规则一律从
  注入的项目资料读取。把领域表重新写回 Cindy 冻结 Skill = 重新引入必然漂移（§6.56 根因 7）。
- **语义验收步骤**：① 在注入路径上做一次单文件读取，断言放行；② 对同一目录做
  `Get-ChildItem -Recurse`、对同目录**另一个** `SKILL.md` 做读取、对
  `01-治理规范-governance/` 做读取，断言三者都被拒；③ 把 `mekaCombatProjectRefPaths` 从
  vendorOptions 移除后重跑 ①，断言变成拒绝。
- **已知边界（登记，不是 bug）：`table-scope` 无法派发服务器 Worker**。服务器路由键只在存在唯一合法
  `mekaCombatTargetSkillId` 时注入（`mekaResolvePlan.ts:229-260`；表范围分支显式置 `undefined`，
  `:874-875`），`authorizeCombatServerDispatch` 又要求请求的 `remote_host_id` 与注入值全等
  （`combatWorkflowPolicy.ts:1785-1821`）⇒ 表范围的 `create_worker` 恒被拒，
  `validate_server_capability_report` 的期望目标也是空串（`meka-runtime-mcp.ts:873`）。因此参考
  未覆盖/冲突时，表范围的出口是**改绑单技能 ID 后核查**（该路径完整可用），或由 owner 决定新增按目标
  派发/回报通道。角色片段与冻结 SKILL.md 已按这条边界改成「`table-scope` **不逐目标派发**、改绑一个
  已确认 ID 退回单技能流程」（`combat-skill-configuration/SKILL.md:110-112`），不得再写回「逐目标
  派发」。见迁移总账 §6.56 与 `meka-injection-layer.md` §3.2。
- **统一口径（2026-09-22 同日后修订）**：`combatEvidenceBasisIsProjectReference`
  （`combatWorkflowPolicy.ts:1203-1209`）现在是「`project-reference` **且** 两条参考路径已注入
  **且**（`table-scope` ⇒ `approved === true`，否则 ⇒ `TargetSkillIdState === 'confirmed'`）」⇒
  **两类请求共用同一豁免语义**，单技能不再被无条件要求 `supported` 回执。该键由 Host 经
  `combatEvidenceBasisPatch` 依据注入情况写入，**不是** Agent 判断（旧文「单技能仍须 `supported`、
  与提示词冲突」的观察已作废，历史保留在迁移总账 §6.56）。
- **语义验收步骤（两类都要走，不得只测一类）**：① `single-skill` 且 `TargetSkillIdState='confirmed'`
  + `mekaCombatEvidenceBasis='project-reference'` + 两条参考已注入 ⇒ 老版模块导入
  `unity_execute(legacy_module_import_json, <该 ID>, <绝对 JSON 路径>, true)` 断言**放行**（其余门禁
  照旧，环境/P4 边界不因该键豁免）；
  ② 保持同一形态，分别把 `TargetSkillIdState` 改为 `ambiguous`、把 `mekaCombatProjectRefPaths` 置空、
  把 `mekaCombatEvidenceBasis` 置 `undefined` ⇒ 三者都必须断言**被 `supported` 回执门禁拒绝**；
  ③ `unsupported` / `uncertain` 任一 ⇒ 仍拒绝实施调用；④ 已批准 `table-scope`（`approved=true` +
  `project-reference` + 参考已注入）⇒ 用**一个显式 ID** 做同一次导入调用断言放行，`approved` 归零
  （或范围状态回到 `proposed`）后断言回到拒绝。
- **自动化锚点**：`combatWorkflowPolicy.test.ts` 的
  `requires the server supported report only when the evidence basis is not the injected project reference`
  与 `applies the same project-reference evidence basis to a confirmed single skill`；
  `mekaRuntimeInjection.test.ts`（依据补丁形状与 `prepareCombatFollowupRuntimeContext`）、
  `mekaRuntimeInjectionBaseline.test.ts`（`[SAGA2_PROJECT_PATHS]` 全文、`vendorOptions` 键序，
  含「未改目标的 resume 也定稿依据」用例）。
  **未实机验证**：真实项目目录下的完整读取路径（含三段 CJK 目录名的伤害规则文件），以及表范围
  「确认 → 逐目标导出 → P4 编辑 → 导入 → 回读」的端到端往返（**代码可证，未实跑**）。

**WL-11.13 表范围解析的只读通道与 P4 写边界（Unity 查询 + P4）**（不变量，2026-09-22 登记）：

- `table-scope` 解析期的第一条证据是**有界只读范围解析**，不是「先导出单个目标技能」；能被
  放行的形态只有：声明的源表、`saga2_json` 下的表文件、老版模块资产目录
  `Module/Saved Data/Modules` 里的**单个** `.asset`、已注入的项目参考路径，以及
  `unity_inspect(action="command")` + `vendorOptions.mekaCombatReadOnlyUnityCommands` 白名单命令
  （当前两条：`legacy_module_query_nodes`、`legacy_module_audit_coverage`）。
- `projectPath` 必须与注入的 `unityClientRoot` **逐字一致**；`unity_execute`（含
  `legacy_module_import_json` / `legacy_module_export_json`）**不在此列**。命令白名单未注入 = 空 =
  不放行；参数里出现 `;&|<>` 或换行不算单条只读查询。Cindy 侧白名单与 meka-unity 插件侧的
  9 项硬编码只读白名单是**两层**，增删任一命令必须两侧同时核对。
- **审批位只决定写入**：`mekaCombatScopeApproved !== true` 时，只读范围解析**仍然放行**，
  写入门禁一概不动（否则用户一确认范围，范围级只读发现反而被锁死——表范围没有单值目标，
  永远产生不了「目标导出完成」）。
- **P4 写边界（与只读通道成对，必须一起验）**：唯一可写表面是「老版模块编辑器能寻址的
  `Modules/<skillId>.asset`」，且**已有资产必须先经 Meka P4 插件真正完成版本控制**——
  `p4_edit`，磁盘上存在但尚未入库的资产另行 `p4_add`；只查 `p4_status` **不算前置**。
  这是**角色/冻结 Skill 契约 + 用户授权要求**，不是 Cindy 侧 Host 门禁：`combatWorkflowPolicy.ts`
  只把 `p4_status` 当只读豁免（`:662`），任何 P4 变更都要重跑环境门禁（用例
  `combatWorkflowPolicy.test.ts:3360-3404`，`p4_submit` 在其中是**放行**的），Host 侧唯一额外的
  P4 约束是 `saga2_design/planning` 一律拒绝（`isPlanningMutation`，`:616-626` → 拒绝文案 `:1943-1947`）。
- **破坏性守卫实际在插件侧，且是 fail-closed 的**（Host 缺 P4 写白名单 ≠ 无防护，这一层必须一起读）：
  meka-p4 的四个不可逆工具都走「预览 → `cindy.confirm` → 带 `expectedPreviewToken` 执行」三步——
  `p4_submit`（`cindy-meka-plugins/meka-p4/main.js:657-676`：先 `submitPreview` 取得 `previewToken`，
  再确认，再 `submitConfirmed`）、`p4_revert`（`:685-707`）、`p4_clean`（`:709-722`）、
  `p4_force_sync`（`:724-737`）。`requestConfirmation`（`:112-140`）在 `cindy.confirm` 不可用时直接返回
  `CONFIRMATION_UNAVAILABLE` 并**拒绝执行**（fail-closed），未确认时各工具 `toolFail` 提前返回；
  `expectedPreviewToken` 绑定「用户看到并确认的那份预览」与「实际执行的那批文件」，不可被 TOCTOU 替换。
  因此 Agent 自发 `p4_submit` **不是静默提交**，必须经用户点确认；Host 侧无 P4 写白名单是
  **纵深不足**，不是缺失最后一道闸门。不进 `confirm` 的工具（如 `p4_delete`，`:744` 的通用表）
  其后果也由 `p4_submit` 的确认闸门统一兜住——未提交前可恢复。
- **`p4_submit` / revert / sync 永不自动执行**：`p4_submit` 不可逆，属「额外内容」，必须由用户
  **明确要求**才可执行，Agent 不得推断（冻结 SKILL.md `:126-133`）。因此「从不提交」只能靠
  **契约 + 实机核对**证明，不能靠 Host 门禁证明——登记为已知强度边界。
- **本批交付在 SAGA2 Unity 侧的 C# 改动保持本地未入库**：新增的两条只读 CLI 命令与
  `SkillModuleData.Exists()` 守卫是工作区本地编辑，**不进 changelist、不 `p4_add`、不提交**。核对面
  是只读的 `p4_opened` / `p4_fileinfo`（meka-p4 1.0.63）：这些文件**不得**出现在任何 opened
  changelist 里，交付也不得留下新 changelist；任何 `p4_submit` 都必须能对应到用户当前消息里的显式要求。
- **语义验收步骤**：① 未批准的 `table-scope` 下发起白名单内的 Unity 命令，断言放行；
  发起 `unity_execute(legacy_module_import_json …)`、`p4_edit`、`.asset` 写入，断言全部拒绝；
  ② 把 `projectPath` 改成另一个 Unity 根，断言拒绝；③ 用不在白名单的命令名调
  `unity_inspect(action="command")`，断言拒绝（插件侧 `INSPECT_COMMAND_NOT_READ_ONLY`）；
  ④ `single-skill` 会话下重跑 ①，断言只读 Unity 查询**不**因此放行（该通道仅表范围解析期开）；
  ⑤ **P4 写边界**：对一个磁盘已存在、尚未入库的模块资产走一次导入 → 断言导入前实际执行了
  `p4_edit`（必要时 `p4_add`）且仅查 `p4_status` 时导入被判定前置不足；⑥ 断言全程没有 `p4_submit`
  （除用户显式要求外），并用 `p4_opened` 核对本批 Unity C# 改动**不在** opened changelist 中。
- **自动化锚点**：`combatWorkflowPolicy.test.ts` 的
  `keeps writes closed and allows only bounded read-only scope resolution for an unapproved table scope`
  与 `allows only the whitelisted read-only Unity query channel while a table scope is unconfirmed`。
  **P4 写边界本身零自动化覆盖**：`p4_edit` / `p4_add` / `p4_submit` 的顺序与「只查 status 不算前置」
  只由角色片段与冻结 SKILL.md 的正文表达，没有单测；`p4_submit` 在 Host 侧是放行路径，
  其不可逆性由**插件侧 fail-closed 确认闸门**兜住（见上一条，`main.js:657-676` 等），该闸门同样**未实机验证**。
  **跨仓未验证**：meka-unity 插件侧白名单与 Cindy 侧清单的一致性**没有自动化断言**，
  只有两侧源码的当前文本（`cindy-meka-plugins/meka-unity/node/worker.cjs:49-59`）；
  `p4_opened` / `p4_fileinfo` 与「C# 改动未入库」**登记人未核对**（需 SAGA2 工作区与 P4 连接）。

**WL-11.14 Host 侧证据预算／配额／时限已删除（不得复活；提示词层的收敛纪律刻意保留）**（不变量，2026-09-22 登记）：

- **不得**重新引入任何「Lead 最多 N 次成功证据调用」「总探索时间超过约 M 分钟立即停止」
  「服务器 Worker 最多 N 次只读调用」形式的硬上限。删除前的两条常量与两个 helper
  （`COMBAT_LEAD_EVIDENCE_READ_LIMIT` / `COMBAT_SERVER_WORKER_READ_LIMIT`、
  `consume*Budget`、`shouldBoundLeadEvidence` / `leadEvidenceBudgetDecision`）**不得复活**。
- **取代它的是提示词层的收敛纪律，不是新的预算**：每个未决业务原子最多两轮定向核查、同一工具失败后
  只允许安全诊断或一次修正重试、不重复读取同一文件、不递归扫描仓库、足够即收口；仍无结论时立即
  停止探索并交付**业务级结论**，把缺口标为「可实现 / 无法保证 / 待确认业务选择」或程序交接项。
  任何阻塞都必须产出可见结论——这才是该不变量真正要守的东西（防「探索无终点」和「以工具调用
  代替结论」两个方向）。
- **必须分清的两类数字**（本条的判据就在这里，含糊会把「删预算」误读成「一个数字都不能有」）：
  - **Host 侧预算／配额／时限：必须完全不存在** —— 计数器、调用次数上限、墙钟 deadline、
    `consumeCombatServerWorkerReadBudget` 家族。这就是步骤 ① 要核的东西；复活任一形态 = 违规。
  - **提示词层的收敛纪律条数：刻意保留** —— 角色片段 `roles/prompts/combat-evidence-budget.md:3`
    的「每个未决业务原子**最多进行两轮**定向核查」与 `:7` 的「同一工具只允许安全诊断或**一次**
    修正重试」。它们是**每条未决原子**的定性停止规则（告诉 Agent 何时收口并交付部分结论），
    没有 Host 计数器、没有全局配额、没有时间上限，也不阻止用户显式要求继续。**不得**把它们
    当成预算复活，也**不得**为了「正文里不许出现数字」把它们删掉——那会直接毁掉步骤 ③ 依赖的收敛契约。
- **片段文件名与 manifest id 仍叫 `combat-evidence-budget`（有意保留）**：
  `combat-development.json:16` 声明 `{ "id": "combat-evidence-budget", "path": "prompts/combat-evidence-budget.md" }`，
  片段标题是 `## 证据纪律与收敛`（`combat-evidence-budget.md:1`）。**名字保留是为了片段 id / manifest
  路径的稳定性**，正文已不含预算；grep 到 `budget` 这个名字**不代表删除没做完**，判据只看上面两类数字。
  改名会动一个稳定身份，属另案，**不得**为了让文档好看而重命名文件或改 id。
- **语义验收步骤**：① 在**代码/测试/提示词/资源**范围内核对删除后的零命中（docs 会合法地提到这些
  名字，**不要**把仓库根当作搜索面，否则会把本条自身与迁移总账算成命中）：
  ```bash
  git grep -nE "COMBAT_(LEAD_EVIDENCE|SERVER_WORKER)_READ_LIMIT|consumeCombat(ServerWorker|Lead)[A-Za-z]*Budget|shouldBoundLeadEvidence|leadEvidenceBudgetDecision" -- apps packages scripts
  ```
  期望**零命中且退出码 1**（2026-09-22 实测如此；`-- apps packages scripts` 是命令的一部分，
  不能省略）；② 读同一片段，断言标题是 `## 证据纪律与收敛`，且**保留的是收敛纪律、没有 Host 侧
  预算形态**：`:3` 与 `:7` 允许出现「两轮」「一次修正重试」这类**每原子**定性条数，但正文
  **不得**出现全局调用次数上限、累计计数、分钟/小时级停止时限，也不得引用任何 `*_READ_LIMIT` /
  `consume*Budget` 名字；③ 构造一个「两轮定向核查仍无结论」的用例，断言 Agent 侧契约要求交付结论
  而不是继续调用工具 —— 它验的正是 ② 里保留的那条「两轮」纪律，两步互为前提，不得把它们读成矛盾。
- **与其它「额度」机制的区别**：本条删掉的是**战斗证据调用次数／探索时长**这类硬上限，不得复活。
  既有的 silent-stop 续跑自愈额度（`silentStopAutoResume.ts`，属 WL-11.15 的兜底机制）与
  turn 零事件 stall watchdog（`DEFAULT_TURN_STALL_MS = 45 * 60_000`）**不在本条范围内**，
  它们不是战斗流程的收口上限；`COMBAT_SCOPE_SKILL_IDS_LIMIT = 200` 同理只是清单截断的诚实标记
  （见 WL-11.11），不得当成预算复活。
- **自动化锚点**：`combatServerCapabilityState.test.ts`（删除后不再有预算用例）、
  `combatWorkflowPolicy.test.ts`（不再有预算拒绝路径）。本文自身的结构契约由
  `scripts/__tests__/meka-whitelist-contract.test.mjs`（5 条，随 `pnpm test:runner` 跑）守护；
  编排者在本次交付中实测 `node --test scripts/__tests__/meka-whitelist-contract.test.mjs`
  为 **5/5 通过**（**登记人本人未运行**，转述自编排者）。**未实机验证**：真实失控探索场景下
  新纪律是否足以收敛（定性条款，无运行时断言）。

**WL-11.15 Pi 空回合不得静默收尾**（不变量，2026-09-22 登记）：

- 一个 turn 结束时**没有任何用户可见 assistant 正文**，就**不得**以「什么都没发生」收尾。
  `outcome` 分两支：`outcome === 'completed'`（上游用空正文 assistant 消息正常收尾）**无条件**进入
  该判定；`outcome === 'cancelled'`（需 `stopReason='aborted'`、不是 Host abort 请求、无终态 error、
  正文为空）额外要求本 turn **没有出现过** Host 停止登记。
- **seen 锁存只收紧 `cancelled`，不得套到 `completed`**：`cancelled` 支查的是**锁存的
  `hostStopSeenGeneration`**（`isCurrentTurnHostStopSeen`，translator 模块私有，
  `translator.ts:275-327`）而不是 abort 标记——abort RPC 失败会回滚 abort 标记，只看它会把
  「用户按了 Stop → RPC 报错回滚 → Pi 仍发来无 errorMessage 的 aborted 空消息」误判成静默断流，
  从而把一个用户明确停掉的 turn 自动续跑。反方向同样承重：锁存**不随** `agent_settled` 清除，若把它
  一并套到 `completed`，则「用户按 Stop → abort RPC 报错回滚 → Pi 仍以 `stopReason='stop'` +
  空内容正常收尾」这一**既有自愈形态**会退回零输出（`outcome='completed'`、无正文、无终态 error、
  也不补发「继续」）。本批第一版实现犯过这个错，回归用例
  `completed + 锁存命中 + 空正文` 现已存在。
- 真正的 Host Stop（用户点 Stop / 45 分钟 stall watchdog 的 abort，abort 标记未被回滚 ⇒ `outcome`
  仍为 `cancelled`）与已有正文的取消**不得**附 `silentStop` 标记：那是用户或宿主自己的动作，
  watchdog 另有 `turn_no_event_timeout` 终态与自己的续跑通道，再接管会双发。
- 命中后必须交**既有** silent-stop 自愈（补发「继续」，绝不重放原始 prompt 及其副作用）；
  额度/熔断耗尽时弹终态 error `silent-stop-exhausted`（已在 renderer reason 白名单内，带
  「继续」按钮），不得补一条裸 `empty-response` error（那类 reason 的自动重试会克隆原文，
  只对零副作用 turn 安全）。这里的「额度/熔断」是**既有** silent-stop 自愈机制自己的
  （`silentStopAutoResume.ts` 的 `SILENT_STOP_RESUME_BUDGET` / `SILENT_STOP_SESSION_BREAKER_LIMIT`），
  不是 WL-11.14 删掉的战斗证据预算，也不是本轮新增的收口上限。
- **GUI 侧挂起**：宿主拿到 `silentStop` 后，会话在 agent-island 上进入
  `silentStopHold`（`agent-island/state.ts:84,671-690,752-764`，`AGENT_ISLAND_SILENT_STOP_HOLD_MS = 10_000`
  的到期兜底，另有单调锚点 `silentStopHoldMonoUntil`）：这段时间不得把面板落成「已完成」终态，续跑或
  超时才收口。**标记挂在两条收尾上，判定与事件顺序无关**：`done` 与配对的 turn-end `status` **都**带
  `silentStop`（claude-code 是 status 先、done 后；Pi 是 done 先、status 后，见其 `pushStatus(…)`），
  岛面按 `data.silentStop === true` 判定，带标记的那条先到即进挂起，**不得假设两个 provider 对称**。
  修法必须是**预防**而非事后回退：一旦 `status{isRunning:false}` 被当收口，远端未读账本、`attention`
  与完成提醒就已经落地，**岛面撤不回来**——本批第一版只在 `done` 侧挂起，对 claude-code 会先画一次
  假完成，故本节原先「避免闪出假完成」的说法在修复前对 claude-code 是**假的**。挂起期内
  `isRunning === false` 的尾巴也不再要求 `status === 'Done'` 精确匹配（否则非 `Done` 的尾巴会落成
  `running=false` 又不完成，被紧随的 `prune` 整条吞掉、连兜底一起静默丢失）。**已知未覆盖**：
  「status 先到且**不带**标记 + 随后带标记的 `done`」不做配对缓冲（真实生产者不存在：codex 无
  `silentStop`、Pi 是 done 先、claude-code 两条都标；缓冲会推迟**所有** status-Done-only 收口）；
  `service.ts` 的 `!enabledSynced` 会清 publish timer，故在首次 enabled 同步**之前**武装的挂起要等
  下一次 publish 才排期（存量逻辑，窗口极小且自愈）。
- **语义验收步骤**：① 构造 `cancelled` + 空正文 + 非 Host abort 的 turn，断言
  `done.data.silentStop === true` 且守卫被触发；② 构造 Host abort 的同样 turn（abort 标记未被
  回滚 ⇒ `outcome` 仍为 `cancelled`），断言**没有** `silentStop`；②′ **反向对照**：构造 abort RPC
  失败回滚、但 Pi 仍以 `completed` + 空正文收尾的 turn，断言**有** `silentStop` —— 这一格必须与 ②
  相反，否则就是本批第一版回归；③ 构造有正文的取消，断言**没有** `silentStop`；
  ④ 让续跑额度耗尽，断言用户看到 `silent-stop-exhausted` 横幅而不是静默结束；
  ⑤ 断言命中后 10 秒内会话在 agent-island 上不是终态「已完成」，续跑到达或超时才收口；并**分别按两个
  provider 的真实事件序各跑一遍**（claude-code：`status{silentStop}` → `done{silentStop}`；Pi：
  `done{silentStop}` → `status`），断言两条顺序都**不出现假完成**、不写远端未读账本。
- **自动化锚点**：`packages/maker-core/src/agents/pi/__tests__/pi-translator.test.ts`
  （三条新用例）、`apps/desktop/src/main/agent-island/__tests__/state.test.ts`（挂起与到期兜底）、
  `maker-ipc/__tests__/silentStopAutoResume.test.ts`、
  `sessionEventPipeline.test.ts`、`renderer/__tests__/overloadError.test.ts`（reason 白名单）。
  **未实机验证**：真实网络断流下「用户一个字都没拿到」的场景复现，以及 GUI 挂起在真实会话里的
  观感（本批交付**没有**重跑这些用例，登记人只做了代码核对）。

**WL-11.16 战斗写入门禁的三层：范围绑定、命令面白名单、写后对账**（不变量，2026-09-22 登记）：

- **保护的不变量**：一次 `legacy_module_import_json` 是 `clear_existing=true` 的**全量替换**，因此
  ① 它只能写入**用户已确认范围内**的技能——请求里同时出现一个范围内 ID（哪怕只是藏在
  `<tmp>/1019.import.json` 这种 **JSON 文件名**里）**不构成**任何豁免；② 老版模块命令必须**恰好携带一个**
  ID 且该 ID 在已确认范围内（`withoutList`＝已批准但清单被截断／未登记那一支**保持原样**：只要求一个显式
  ID、不做成员比对，这是登记过的折中，不得顺手收紧）；③ 模块写入命令是**命令面白名单**，只有
  `legacy_module_import_json`（唯一登记写入）与 `legacy_module_export_json`（目标取证读）及 Host 注入的
  只读白名单命令可执行，`legacy_module_migrate_layers` 这种**遍历全部模块资产、不携带 `skill_id`** 的
  批量写命令一律拒绝；④ 导入回执的 `importedNodeCount` 必须与**写入前**结构化导出的 `exportedNodeCount`
  一致，否则整轮**除同一技能的一次回读外**一切调用被拒——回执缺失或数值不可解析时**不得伪造通过**，
  同样要求结构化回读。要点是：`importedNodeCount` 只是 payload 自己的节点数，**永远等于 payload 的
  节点数**，它单独不构成任何证据。
- **代码锚点**：`combatWorkflowPolicy.ts:464`（D1 混合 ID 一律拒）、`:477-479`（恰好一个范围内 ID）、
  `:654 legacyModuleWriteCommandReason`（命令面白名单；通道无关解析 `:589`／`:630`）、
  `:53-63` 对账状态、`:694-788` 宽容回执解析、`:820 observeCombatLegacyModuleResult`、
  `:790 settleCombatModuleReadBack`、`:876 combatModuleWriteReconciliationReason`；
  门禁接入 **MCP `:2383` 与 Shell `:1976` 两侧**（缺 Shell 侧可用 Shell 绕过「先回读」）；
  基线只在传输成功路径建立（`ghost.ts:2366`、`meka-runtime-mcp.ts:1350`），
  `markCombatTargetExportAttempted/Completed` **不产生**基线。契约正文见
  `meka-injection-layer.md` §5.1／§5.2。
- **语义验收步骤**：① 构造生产 `ghost_call` 形态：范围 `{1019,1020}` 已批准，positional `skill_id=1021`
  而 JSON 文件名是 `1019.import.json`，断言 **deny** 且理由含 `1021`；② 对照：positional 与文件名同为
  `1019`，断言 **allow**；③ 断言 `legacy_module_migrate_layers` 在单技能 `supported` 与已批准表范围
  两种会话下都 **deny**；④ 有损导入（写入前 `exportedNodeCount=696`、导入回执 `importedNodeCount=669`）
  ⇒ 断言**下一次**调用（MCP 与 **Shell 两条路径都要试**）被拒、理由含两个数值，且换技能／换目标也被拒；
 ⑤ 随后对同一技能做一次 `legacy_module_export_json` 回读到 `669` ⇒ 断言结清后恢复放行；
  ⑥ 无损导入（700→700）断言**不产生**对账义务；⑦ 断言一次**尝试**导出不建立基线。
- **自动化门禁**：`apps/desktop/src/main/meka-projects/__tests__/combatWorkflowPolicy.test.ts`
  （D1／D2／D3 各自用例，把对应门禁临时失效即转红）。**未实机验证**：D2 依赖回执字段名
  `exportedNodeCount` / `importedNodeCount`，依据是冻结 SKILL 的协议契约与迁移总账（有真实回放
  `importedNodeCount=7`），但真实 meka-unity 结果封套的确切嵌套**本仓无法核验**——解析器因此刻意宽容、
  取不到即诚实回落「无基线 ⇒ 要求回读」。**建议真机跑一次「导出 → 导入 → 导出」确认基线被记录。**
  另需注意两条**未闭合**面：最终文字 `[SAGA2_COMBAT_CONFIG_RESULT]` 没有 Host 门禁（模型仍可只回一句话
  收尾，Host 只能掐掉它继续做其它事的一切工具通道）；任一侧回执取不到数值时，节点数的**语义**比对仍靠
  模型与 SKILL 正文。

**未自动化 / 未覆盖的实机项**：新建**自定义**项目与角色（本机 profile 只有内置 SAGA2）、
删除项目后落入「不可用的 Meka 项目」组、正式事项（`meka-formal`）的 provider/auth/issue
全链路（需 Jira/GitLab 凭据），以及 WL-11.9 的界面实机路径（把项目目录移走后走一遍
「配置不可用 → 移除项目注册」）。WL-11.11–WL-11.16 的**端到端**部分（真实 SAGA2 工作区里走完
表范围全链路、真实断流下的空回合、插件侧白名单与 Cindy 清单一致性、P4 写边界与
「本批 Unity C# 改动未入库」、以及写入对账的**真机封套字段核验**）同样**尚未实跑**；A3 镜像的**重启后为空**与 A4 成员清单的
**真实会话登记**也只有代码与单测证据，没有实机观测。这些仍按上文「实机验证」人工执行。

> migration 编号与冻结**不单列为白名单项**：那部分是上游自己的机制（`db:validate` +
> `migration-baseline.json` + Git 基线冻结）加上本仓工程规则，见 §7。

### WL-12 Meka 会话在横切域的守卫

**保护的不变量**：`'meka'` 会话**不被上游的横切能力误认领**：不进 scheduler / legacy cron
认领、不进 IM `/sessions` 选择器、`'meka'` 不泄漏进 scheduler 域；同时协同（Orca）资格
与远程 worker 目标对 Meka 正确成立。

**代码锚点**
- `apps/desktop/src/main/scheduler-host/storage.ts:707,772,1307,1357,1443`
- `apps/desktop/src/main/hook-control/recentSessions.ts:37`
- `apps/desktop/src/main/im/shared/sessionRepo.ts:207-209`、`im/shared/slashCommands.ts:175`
- `apps/desktop/src/main/maker-host/session-storage.ts:42`
- `apps/desktop/src/renderer/features/cc-agent/lib/collaborationEligibility.ts:20,41`
- `apps/desktop/src/main/maker-ipc/orcaWorkerCreationService.ts:710`
- `apps/desktop/src/main/maker-ipc/collabProjectPolicy.ts:59`

**自动化门禁**
- `pnpm --filter desktop exec vitest run src/main/scheduler-host`
- `pnpm --filter desktop exec vitest run src/main/hook-control`
- `pnpm --filter desktop exec vitest run src/renderer/features/cc-agent`
- `pnpm --filter desktop exec vitest run src/main/maker-ipc/__tests__/collabProjectPolicy.test.ts`

**守卫缺口（当前无自动化覆盖，必须人工核对，详见 §8）**
- `scheduler-host/storage.ts` 的 5 处 `meka` 跳过：无任何直接断言。
- `hook-control/recentSessions.ts:37` 的 `meka` 跳过：`recentSessions.test.ts` 的 5 条用例
  没有一条放入 `workspaceKind: 'meka'` 的行。
- `im/shared/controlProjects.ts:26-31` 的 `attachableSessionPredicate()` **只**排除 Orca
  worker，不排除 meka；`listRecentSessionsForPicker`（`:171`）与
  `listSessionsForWorkspace`（`:211`）因此**可能**把带 workingDir 的 Meka 会话列进
  IM `/session` 与 `/ctr`。是否属缺口需产品裁决（见 §8）。
- `renderer/features/cc-agent/lib/sidebarProjectVisibility.ts:125` 会把落在隐藏项目下的
  会话改写成 `'dialogue'`，豁免只看 `'dialogue'`（`:40`、`:71`）——Meka 会话会被「降级」
  出 Meka 段并出现在普通对话分组（见 §8）。

**实机验证**：Meka 会话不出现在 IM `/sessions` 列表；scheduler 不把 Meka 会话当成待执行
任务；Meka 会话可正常发起协同（Orca）且 worker 归属正确。

### WL-13 Meka 文案、术语与 i18n

**保护的不变量**：Meka 产品的用户可见文案在五种 locale 下 key 一致且无缺失；术语遵循
`i18n/GLOSSARY.md`；品牌术语门禁不因上游文案替换而失效。

**代码锚点**
- `apps/desktop/src/renderer/__tests__/mekaPluginOriginI18n.test.ts`
- `i18n/`（五语 key 集合）、`i18n/GLOSSARY.md`、`i18n/glossary.json`
- `scripts/brand-terminology-guard.mjs`

**自动化门禁**
- `pnpm check:i18n`
- `pnpm check:i18n-glossary`
- `pnpm check:brand-terminology`

**实机验证**：切到每种语言各看一遍 Meka 入口、设置页、插件/技能页，无英文残留、无空 key、
无 `settings.meka.*` 字样直接显示。

**历史回归**：本轮合并曾丢 4 条 Meka SkillHub key 与 23 条 zh-TW 条目。

### WL-14 同步流程工具链本身

**保护的不变量**：审计与验证工具自身可用、且在真实历史上确实能抓到事故；本文档与其
结构契约同步存在。

**代码锚点**
- `scripts/audit-merge-resolution.mjs`、`scripts/__tests__/audit-merge-resolution.test.mjs`
- `scripts/__tests__/meka-whitelist-contract.test.mjs`（本文档的结构契约）
- `docs/dev-rules/development-workflow.md` §4（合并静默丢失门禁）

**自动化门禁**
- `pnpm test:runner`（含上述两个自测）
- `pnpm audit:merge -- --merge-commit <sha>`

**实机验证**：`pnpm audit:merge` 对历史事故提交 `01391448e9` 仍报出 `DROPPED`（含
hook-control 相关丢失）—— 证明门禁不是空转。

### WL-15 Meka 角色 Skill 注入必须走非 argv 载体

**保护的不变量**：host 注入 Pi root 任务的文本会经 `--append-system-prompt` 作为**命令行参数**
传给子进程，而命令行有平台硬上限（Windows `CreateProcess` 32767；上游保守预算 30,000，超限由
`assertPiSpawnArgvFitsPlatform` 拦截并抛「项目里 Pi skills 太多」——**文案与真实原因无关**）。
因此 **Meka 注入的任何大段静态文本（尤其是战斗总控 Skill 正文）都不得整篇内联进
`userPrompt` / `runtimeConfig.systemPrompt`**，必须只注入「冻结正文的**唯一绝对路径** + 必须先完整
读完该文件的指令」；路径必须落在运行期**已授权**的目录内（`snapshot.pluginPath` 已作为
`nativeSkillPluginPath` 交给运行期）。语义不变：正文仍是该任务 revision 级冻结的唯一权威正文，
仍然禁止探索/枚举其它 `SKILL.md`。

- **代码锚点**：`apps/desktop/src/main/meka-injection/mekaCombatPrompts.ts:48-82`
  （`combatControllerSkillPrompt:69`：`COMBAT_CONTROLLER_SKILL_ENTRY = 'skills/combat-skill-configuration/SKILL.md'`（`:48`），
  由 `path.join(snapshot.pluginPath, …)` 得到绝对路径；**不再拼接 `entry.contentBase64`**）；
  `meka-projects/skillSnapshot.ts:265-320`（正文冻结落盘到
  `<userData>/meka-skill-snapshots/revisions/<revision>/claude-plugin/…`，已按 digest 校验）；
  `meka-injection/mekaResolvePlan.ts:186-193`（`nativeSkillMount`）+ `:506`（物化）与
  `meka-injection/mekaApplyPlan.ts:96-100`（`opts.nativeSkillPluginPath = skillSnapshot.pluginPath` —— Agent 本就有权读该目录）；
  冻结路径形状门：`meka-projects/combatWorkflowPolicy.ts:665`（`isMekaSkillSnapshotEntrypoint`
  在 `:662-668`，只认
  `…/meka-skill-snapshots/revisions/<sha256>/claude-plugin/skills/combat-skill-configuration/SKILL.md`）；
  上游守卫：`packages/maker-core/src/agents/pi/project-resource-cli.ts:163,177-186` 与
  `packages/maker-core/src/agents/pi/index.ts:3739`（`--append-system-prompt`）/`:3749`（守卫调用）。
- **自动化门禁**：`pnpm --filter desktop exec vitest run src/main/maker-ipc/__tests__/mekaRuntimeInjection.test.ts`
  —— 用例 `injects the frozen combat controller Skill body into new and resumed combat tasks` 断言
  ①prompt 含标记 `[SAGA2_COMBAT_CONTROLLER_SKILL]`、②含**冻结正文的绝对路径**、③含「必须先完整读完」指令、
  ④**反向防线：正文不得出现**（`not.toContain('STATUS_THEN_TARGET_EXPORT')`，一旦有人改回内联即红）。
- **实机验证**：`pnpm desktop:session-smoke` 的 **WL-11.4**（战斗角色真实跑完一轮并产出回复）
  与 **WL-11.5**（角色上下文回显）—— 2026-09-18 修复后实测 **9/9 PASS**
  （WL-11.4 `回复="收到"`；WL-11.5 `projectId=saga2 roleId=combat-development displayName="战斗开发"`）。
  负向（**未验证**）：模型「没读该文件就执行」时行为会退化，尚无负向实机断言。
- **历史回归**：2026-09-18 同步接纳上游新增的 argv 预算守卫后，战斗角色会话在 Windows 上
  被拒（报文误指「项目 Pi skills 过多」，而实测项目 Pi 资源为 0）；实测 argv 30,497 vs 预算 30,000，
  其中战斗正文 24,027 字符占 argv 78.8%。改走文件载体后 argv 降到约 6.5KB。
  规则正文见 [`pi-harness.md`](pi-harness.md) 第 4 节不变量 12。

### WL-16 Meka 注入层契约与 Agent 能力矩阵

**保护的不变量**：Meka 会话注入收束为显式三层（解析 → 计划 → 落地）后，各入口形态
**各自只有一个入口**（形态 A `applyMekaRuntimeConfig` / 形态 B `registerMekaCapabilities` /
形态 C `prepareCombatFollowupRuntimeContext`，无第二入口、无 re-export 双入口；
计划文本写作「四种入口」而实现是 3 个形态 + 1 组共享解析入口，差异见
[`meka-injection-layer.md`](meka-injection-layer.md) §2 注）；
`MEKA_PROMPT_SEGMENT_ORDER` 是**契约不是实现细节**——新增段落只能插空档（如 15/25），
**不得重排既有段落**；`MEKA_AGENT_CAPABILITIES` 必须**覆盖全量 `AgentKind`**，且声明必须与
实际装配两层都成立（2026-09-22 起 **Pi 两列同为 `true`**，取代原 D1「Pi 有意不支持」——
改动与仍然存在的边界见
[`../migrations/xdmaker-meka-to-cindy.md`](../migrations/xdmaker-meka-to-cindy.md) §6.54 与本文 **WL-18**）；
**漏传 provider 数组必须硬失败**（矩阵说支持却取不到数组 ⇒ 启动期抛错），不得退回静默缺能力
（这正是 Pi 丢掉 `mcp-router` / `meka-design` 的形态）。逐字节不变量 I1–I8 的正文与锚点见
[`meka-injection-layer.md`](meka-injection-layer.md) §5。
**命名**：本层模块文件名与跨模块导出名一律带 `meka`（§8），层内私有 helper 不带（理由与
例外面见 [`meka-injection-layer.md`](meka-injection-layer.md) §0）。
**契约的范围**：`opts.vendorOptions` **自己的**键序仍是契约（下游按这些键裁决），但 `opts` 整体的
键插入顺序**不是**（无消费者）；resume 短路下新实现把快照键移到 prompt 之后（D2.2）。
非字符串 `opts.userPrompt` 在 Meka 路径上必须显式 `INVALID_PARAMS`、非 Meka 路径零影响（D2.1）；
解析／物化抛错时 **opts 必须零写入**（D2.3：重构前是逐阶段增量写，会留下半个注入结果）。
三条有意差异登记在 [`meka-injection-layer.md`](meka-injection-layer.md) §7。

**代码锚点**
- 分层与入口：`apps/desktop/src/main/meka-injection/index.ts:47`（形态 A）、`mekaResolvePlan.ts:643`（形态 C 实现）、`mekaMcpRegistration.ts:53`（形态 B，生产唯一调用点 `maker-host/index.ts:2308`，位于 `_mcpProviders.pi` 赋值 `:2303` 之后）
- order 表与段落工厂：`meka-injection/mekaInjectionTypes.ts:90`（`MEKA_PROMPT_SEGMENT_ORDER`）、`:109`（`createMekaPromptSegment`，调用方不得手写 order）；渲染 `mekaApplyPlan.ts:55-80`
- 能力矩阵：`meka-injection/mekaAgentMatrix.ts:38`（`claude-code`/`codex`/`pi` 三列全为 `true`）、`:71`（`MEKA_AGENT_KINDS` 冻结）、矩阵与能力条目三层 `Object.freeze`、`:76`（`mekaRuntimeMcpAgentKinds`）
- 漏传硬失败：`mcp-integrations/meka-runtime-mcp.ts:1446`（`declareMekaRuntimeMcpAgents`：必须覆盖全量 `AgentKind`，否则抛，`:1458-1465`）、`:1466-1475`（声明与矩阵矛盾也抛）；`meka-injection/mekaMcpRegistration.ts:65-72`（`runtimeMcp:true` 取不到数组直接抛；`runtimeMcp:false` 的 `skipped` 分支保留在 `:60-63`，当前无人走到）
- 入口导出面收紧：`meka-injection/index.ts:28-42` 只转出两个形态入口、两个 ID 解析口子与公共签名类型；形态 A 的两个子步骤与层内计划类型**不再转出**（`meka-injection-layer.md` §2）
- 旧路径已删除：`maker-ipc/mekaRuntimeInjection.ts` **不存在**（原 688 行已拆分到 `meka-injection/`），`maker-ipc/register.ts:583-584` 仅改 import 路径

**自动化门禁**
- `pnpm --filter desktop exec vitest run src/main/meka-injection src/main/maker-ipc/__tests__/mekaRuntimeInjectionBaseline.test.ts src/main/maker-ipc/__tests__/mekaRuntimeInjection.test.ts`
  —— 矩阵穷尽性、Pi 两列 `true` 与三层冻结（`agentMatrix.test.ts` 4 用例）、注册漏传/矛盾硬失败与 maker-host 接线形状（`mcpRegistration.test.ts` 12 用例）、注入文本逐字节基线（`mekaRuntimeInjectionBaseline.test.ts` 共 18 条：原有 10 条快照用例钉住 `opts.userPrompt` 全文、`vendorOptions` 全量键值及键顺序、`nativeSkillPluginPath`/`nativeSkillRevision`；另加 4 组重构后追加用例各 1–3 条 —— 第 11 组（2 例）钉住非字符串 `userPrompt` 在 Meka 路径显式报错（D2.1），第 12 组钉住非 Meka 路径零影响（I6），第 13 组钉住 resume 短路下 `Object.keys(opts)` 新增键顺序（D2.2，不可观测、仅锁现状），第 14 组补 frozen + target 补丁的 `vendorOptions` 键序，第 15 组（3 例）钉住解析／物化抛错时 opts 零写入（D2.3））
- `pnpm test:runner`（含 `scripts/__tests__/meka-whitelist-contract.test.mjs` 的本文档结构契约：字段完整、命令可解析、编号唯一升序、被索引）
- `pnpm --filter desktop typecheck`（矩阵是 `Readonly<Record<AgentKind, …>>`，maker-core 新增 `AgentKind` 而矩阵未填 ⇒ 编译失败）

**实机验证**：`pnpm desktop:session-smoke` 的 **WL-11.1–WL-11.8**（真实建会话并调用模型，
交叉核对库行 / main 日志里的运行期配置 / 技能快照）—— 注入层是这 8 项的共同运行期前置，
矩阵或 order 表被改坏会在 WL-11.4（真实跑完一轮）/ WL-11.5（`[MEKA_ROLE_CONTEXT]` 回显）/
WL-11.6（workflow / 角色级 MCP / 快照技能）先红。**本轮（2026-09-20 注入层重构）未实机跑**：
worktree 内无宿主运行实例，登记为「未验证 + 原因」，由合入后在 base repo 实跑；
本轮已跑的自动化证据见上行。

> 编号说明：WL-16 为新增项；WL-7 与 WL-15 的编号不复用（§6）。本轮把
> `mekaRuntimeInjection.ts` 的三个形态（及两个跨形态共享的解析入口）收编到同一层，并顺手
> 修掉了「全局 MCP 注册漏传 Pi 不报错」这一失效形态（D2）；这不是新能力，而是把既存能力的
> 不变量钉成可执行断言。对抗性审查后的修复（P1-A / P1-B / P1-C）补了两条有意差异 D2.1 / D2.2、
> 段落 id 唯一性断言与 4 组追加用例；**交付前审查又补了 D2.3**（抛错路径的增量写 → 原子写，
> 由 1204 组新旧差分定位）、按 §8 统一模块命名、并修掉两份新文档里失准的代码锚点
> （见 [`meka-injection-layer.md`](meka-injection-layer.md) §7 与
> [`../migrations/xdmaker-meka-to-cindy.md`](../migrations/xdmaker-meka-to-cindy.md) §6.49）。

### WL-17 Meka 会话绑定随 `.cshare` 往返（导入端本机重新解析）

**保护的不变量**：`.cshare` 的 `manifest.meka` 段**只承载绑定身份**（`projectId` / `roleId` /
`legacyRole` / 历史 `target` / 冻结 `formal`），**绝不**承载项目与角色的配置内容、P4 绝对路径、
每会话技能快照或 MCPRouter 凭证；导入端必须在**导入机**用与新建 Meka 任务**同一套**解析口径
（同一个 `getMekaProjectById`、同一个 `resolveMekaProjectWorkspacePath`、角色必须存在且属于该项目）
重新解析绑定，并按**本机**项目配置重取 `additionalPaths`。**全有或全无**：任何一环解析不出来
（项目缺失 / 角色缺失或不属于该项目 / 工作目录解析不出 / 遗留四角色会话 / 解析抛错）一律降级为
**普通任务**并把损失作为 note 回传给用户，**绝不**落出 `workspace_kind='meka'` 但缺 project/role
的半绑定行（运行期对那种行直接抛 `Meka session requires a project and role`）。绑定可恢复时
工作目录由项目解析得出、不再要求用户选目录，且**不套 worktree**。`formatVersion` 标 2，
`minReaderVersion` **保持 1**（该段 additive，旧读端读成普通任务不引入错路径/凭证；抬门槛只会让
旧版本拒读；对照 `orca` 段必须抬到 2）。协同（Orca）包**只绑 lead**，Worker 不被绑定；
`legacyRole` **携带但不恢复**（运行期对 `saga2` 无角色会自行派生 `general-development`，
导入端刻意不复制）。

**代码锚点**：`session-share/xdtshareFormat.pure.ts:260`（`XdtshareMekaManifest`）、`:243`、`:246`、`:297`、`:438`（`validateMekaSection`，坏字段 ⇒ `SHARE_FILE_INVALID`）、`:47`/`:49`（版本常量）；
`session-share/sessionShareExport.ts:694-695`（仅 Meka 行构造该段）、`:817`（`coarseWorkspaceKind`；`manifest` 在 `:711`、`session.json` 在 `:786` 写同一口径）、`:699-705`（formatVersion 2 / minReaderVersion 不抬）；
`session-share/mekaShareBinding.ts:125`（只读解析）、`:150`、`:155-171`、`:175-177`、`:203-211`、`:32-42`（五种降级原因）；
`session-share/sessionShareImport.ts:421-427`（导入前解析）、`:429-430`（忽略传入 workingDir）、`:630`/`:1466`（损失 note）、`:660`（不套 worktree）、`:960`（route lock）、`:992`/`:1483`（提交后一条 UPDATE 落绑定）；
`meka-injection/mekaResolvePlan.ts:448-450`（半绑定行的运行期拒绝）、`:506`/`:593`（首次启动按本机角色重新冻结快照）、`:566`（消费 `opts.workingDir` 注入项目路径段）；
`localDb/mekaWorkspace.ts:26`（工作目录解析器本体，导入端与新建 Meka 任务共用；新建任务侧调用点 `localDb/ipc/sessions.ts:1360`）；
`SessionShareImportWizard.tsx:200-203`（绑定可恢复则不需要用户选目录）。

**已知限制（有意取舍，可选后续项）**：绑定由导入事务**提交之后**的一条 `UPDATE` 写成，未进入
事务 INSERT 的固定列清单——`localDb/worker/opHandlers/tx.ts:2731-2737`、
`localDb/client/WorkerThreadTransport.ts:1181-1182`、`localDb/client/tx/types.ts:482-513`
三处在本次改动范围之外。窗口内崩溃留下的是**完整普通任务**，不是脏行。

**自动化门禁**：`pnpm --filter desktop exec vitest run src/main/session-share`
—— `sessionShareImport.test.ts`（`:1731` 起 10 条：可解析包导入真 Meka 任务 / 项目缺失 /
角色缺失 / 角色属于别的项目 / P4 根未配置 / 遗留包 / 绑定写入失败 / 无 `meka` 段的包行为不变 /
导出→导入往返保住绑定 / 协同包只绑 lead）、`sessionShareExport.test.ts`（3 条）、
`xdtshareFormat.pure.test.ts`（2 条）。
**验证状态（2026-09-22 登记）**：用例已随改动落地，但**登记人未运行**（未跑任何仓库门禁）；
本项全部锚点由阅读当前源码得出，属 documented-only。

**实机验证**：**未实机验证**。待跑：真实 Electron 里导出一个 Meka 任务 → 另一 profile 导入 →
首次启动确认绑定到本机项目/角色并重新冻结技能快照；反向确认项目/角色缺失时提示「按普通任务
导入」且角色提示词、角色技能与角色 MCP 都不生效；跨版本确认旧客户端读同一包得到普通任务。
`desktop:session-smoke` 未跑。

### WL-18 Pi 的宿主技能快照与 Meka 运行时 MCP（取代原 D1）

**保护的不变量**：`MEKA_AGENT_CAPABILITIES` 的 pi 两列都是 `true`，且**声明与实际装配两层都必须
成立**：① **进程级 Meka MCP** —— `mcp-integrations/meka-runtime-mcp.ts` 的
`isHarnessBridgeBootstrapContext` 必须同时包含 `codex` 与 `pi`（工厂阶段 ctx 形状同构：
`agentKind` 是 harness 自己、没有 `sessionId`、带 `getSessionContext`），否则 provider 连 bridge
的 server 工厂表都进不去，会话再怎么声明 `mekaMcpProviderIds` 都拿不到。**放行只到工厂阶段**：
真实可用性仍由 tool-call 时的会话 ctx 按 `vendorOptions` 裁决，因此普通（非 Meka）Pi 会话
**看得到 facade 但调用 fail closed**——与 codex 同形态，既不是 Pi 特例，**也不是**按会话增删
server。② **宿主技能快照** —— Pi 用**既有**的显式 `--skill <目录>` 通道逐个挂
`<pluginPath>/skills/<id>`，排在项目 Skill **之前**；只挂直接含 `SKILL.md` / `skill.md` 的真实
目录，隐藏项与 symlink 跳过；**远端会话（`remoteHostId`）与 review 会话一律不挂**（不把本地
路径透传给远端 harness），根不可用降级为不带 `--skill` 启动并 `logger.warn` 留痕，不抛错。
新增的是**路径**不是正文，argv 预算守卫（`pi-harness.md` §4 不变量 12，
`PI_WINDOWS_SPAWN_ARGV_BUDGET = 30_000`）口径与预算**不变**。**远端（SSH / MCPRouter worker）
Pi 会话仍不获得任何 Meka 技能投递**——Meka 远端技能投递目前只有 codex 通道，这是平台事实。
`mekaPolicyProviderRefs` 仍无消费者。

**代码锚点**：`meka-injection/mekaAgentMatrix.ts:38`（三层冻结矩阵）、`:59`（pi 两列 `true`）、`:71`、`:76`；
`mcp-integrations/meka-runtime-mcp.ts:180`（`isHarnessBridgeBootstrapContext`）、`:1193`（`routerProvider`）、`:1254`（`mekaDesignProvider`）、`:1274`（`InlineMekaMcpProvider`）；
`maker-host/index.ts:2303`（`_mcpProviders.pi` 赋值）与 `:2308`（注册调用点，在其之后）；
`packages/maker-core/src/agents/pi/host-skill-mount.ts:69`（`:76` 远端会话、`:77` review、`:51-60` 入口判定、`:83-85` 隐藏项与 symlink、`:89`/`:94-96` 降级、`:62-68` 稳定性要求）；
`packages/maker-core/src/agents/pi/index.ts:205`（import）、`:3727`（调用）、`:3732-3738`（unavailable 留痕）、`:3764`（argv 注入，排在 `:3765-3767` 的项目/Bot Skill 之前）、`:3770`（argv 预算守卫）；
`meka-injection/mekaInjectionTypes.ts:117-123`、`meka-injection/mekaMcpRegistration.ts:26-52`（注释块）与 `:60-63`（`skipped` 保留分支）。

**自动化门禁**：
`pnpm --filter desktop exec vitest run src/main/meka-injection src/main/mcp-integrations/__tests__/meka-runtime-mcp.test.ts`
—— `agentMatrix.test.ts`（4 条，含 pi 在 `runtimeMcp` 集合里）、`mcpRegistration.test.ts`（12 条，
含「三个 agent 都拿到两个 Meka provider」「inline 扇出到 pi」「没有 agent 走 `skipped` 分支」）、
`meka-runtime-mcp.test.ts:1277` 起 3 条（Pi bridge 真 HTTP 往返 / 普通 Pi 会话 facade 在但工具
fail closed / 工厂 ctx 与会话 ctx 的放行区别）。
`packages/maker-core` 侧：`src/agents/pi/__tests__/host-skill-mount.test.ts`（7 条）、
`pi-startsession-cleanup.test.ts`（宿主 Skill 根排在项目 Skill 之前）、
`pi-rpc-resource-discovery.integration.test.ts`（**真 Pi 二进制**：每个 `skills/<id>` 被加载为独立
Skill、非 Skill 文件不参与发现、不隐式复制进 `configHome/skills`）。
**验证状态（2026-09-22 登记）**：用例已落地，但**登记人未运行**（未跑任何仓库门禁），
真 Pi 二进制用例是否绿**未验证**；锚点全部由阅读当前源码得出。

**实机验证**：**未实机验证**。待跑：真实 Electron 建一个 Pi 的 Meka 战斗角色任务，确认角色技能
快照被 Pi 加载且 `mcp_router` 工具可真实调用；确认远端（SSH / MCPRouter worker）Pi 会话不挂本地
快照；确认普通 Pi 会话调 `mcp_router` 时 fail closed 的报错文案。
`desktop:session-smoke` 未跑。

### WL-19 Unity 只能走 Meka Unity 官方 CLI（拒绝一切 Unity MCP 配置）

**保护的不变量**：客户端**没有** Unity MCP 实现，且**不得**出现一个。项目 metadata、角色
manifest 与 inline transport 三条配置入口都必须**在加载期直接抛错**拒绝任何 id / entry 含
`unity` 的 MCP 配置（文案统一表达「Unity is CLI-only」），因此不存在把 Unity 工作路由回 MCP 的
配置入口；Unity 访问只能经官方 CLI 的 `unity_inspect` / `unity_execute`。
**能力诚实边界（不得含糊）**：官方 CLI 注册的是**九条 Pipeline command**——
`legacy_module_import_json` / `legacy_module_export_json` / `legacy_module_migrate_layers` /
`module_v2_component_catalog` / `module_v2_pattern_catalog` / `module_v2_snapshot` /
`module_v2_arrange` / `module_v2_validate_all` / `module_v2_capture`——加上
`unity_inspect(action=status|list)` 与 `unity_execute(action=open|command)`。**CLI 不是旧 Unity MCP
的超集**：旧 MCP 的编辑器控制面（控制台日志、包管理、菜单项、任意 GameObject / 场景 / 预制体 /
脚本操作，以及旧的 `skill_module` / `skill_effect` / `skill_timeline` 自定义工具）**没有 CLI
等价物**，控制台输出读 `%LOCALAPPDATA%\Unity\Editor\Editor.log`（上一会话 `Editor-prev.log`）。
任何文档不得臆造 CLI 工具名或暗示等价。

**代码锚点**：三道守卫 `meka-projects/runtimeConfig.ts:403-409`（项目 metadata）、`:644-647`
（角色 manifest）、`mcp-integrations/meka-runtime-mcp.ts:1496-1500`（inline transport）；
产品口径正文 [`../product-rules/meka-skills.md`](../product-rules/meka-skills.md) 的 Unity 段；
SAGA2 工作区清理与未完成项见
[`../migrations/xdmaker-meka-to-cindy.md`](../migrations/xdmaker-meka-to-cindy.md) §6.55。

**自动化门禁**：**无自动化覆盖**——全仓测试没有触发这三条拒绝路径的用例（既不实际触发抛错，
也不断言文案）；九条 Pipeline command 与两个动作的清单**没有仓库内代码锚点**（定义在 Meka Unity
插件侧，不在本仓），只能按插件侧事实登记。登记为缺口，补测另开一轮。

**实机验证**：**未实机验证**。待跑：用带 Unity metadata / 角色 manifest / inline 三类配置的项目
实际触发加载期抛错，确认是**拒绝**而不是静默忽略；对照官方 CLI 帮助输出逐项确认九条 Pipeline
command 与两个动作面，并确认旧 MCP 能力确实没有 CLI 等价物。
SAGA2 工作区的 `Assets/Editor/EditorSkillMcpTools/` 删除（Perforce changelist 6055799，94 文件）
与 10 个技能/文档改写**由任务下发方提供，登记人未核对**；其中 4 个被其它 Perforce 客户端
open for edit 的文件（`saga2_unity/AGENTS.md`、`.agents/skills/editor-unity-mcp/SKILL.md`、
`.agents/skills/editor-skill-editor-timeline/SKILL.md`、
`Assets/Editor/EditorMekaDesignImport/docs/2026-08-10-unity-authoritative-prefab-export-design.md`）
**仍指示旧 MCP 路径**，需队友释放文件所有权后才可收口——在它们改完前，「SAGA2 不再指示 Agent
走 Unity MCP」这一结论**不成立**。

## 4. 最小自动化集合

每次同步后的阶段 B 必须全绿。命令与覆盖项：

| 命令 | 覆盖 |
| --- | --- |
| `pnpm audit:merge -- --merge-commit <sha>` | 结构层静默丢失（先决条件） |
| `pnpm test:runner` | WL-14 + 发布/身份自测（`meka-release-flow`、`meka-release-identity`、`brand-identity-sync`） |
| `pnpm --filter desktop typecheck` | 全部 WL 的编译面 |
| `pnpm --filter desktop run db:validate` | WL-11（Meka schema 与列存在；migration 冻结本身是上游机制，见 §7） |
| `pnpm test:db` | WL-11 |
| `pnpm test:unit` | 全量单元（含各 WL 项的定向用例） |
| `pnpm check:i18n` | WL-13 |
| `pnpm check:i18n-glossary` | WL-13 |
| `pnpm check:brand-terminology` | WL-6、WL-13 |
| `pnpm check:endpoints` | WL-5 |
| `pnpm check:design-inventory` | UI 台账（Meka 面板计入） |
| `pnpm check:dev-docs` | 文档契约与内链 |

> 阶段 B 的命令行门禁**不能替代**阶段 C 的实机验收：项目/角色的绑定、注入与侧栏归属
> 都是运行期语义，只有真实起实例才成立（见 §5）。
>
> **`pnpm test:unit:related` 不是 `pnpm test:unit` 的等价缩写**：它由 `scripts/test-workspaces.mjs`
> 驱动，改动集合含 `apps/`、`packages/` 之外的路径时会**先跑一遍 `test:runner`**（机制与
> `test:runner` 当前 3 个存量红灯见 §8.1 第 1 条）。因此它不能替代本节表格里的 `pnpm test:runner`
> 一项，也不得把 `test:runner` 的存量红灯记成「本次交付引入」。

风险追加：跨模块/基础设施改动按 `docs/dev-rules/development-workflow.md` 追加
`pnpm test:all`；插件基座改动另需白名单批准（见 `plugin-security-and-authoring.md`）。

## 5. 实机验收序列

一键部分（隔离沙箱，不碰正式 profile）：

```bash
pnpm restart:desktop:remote
pnpm desktop:whoami
pnpm desktop:ui-smoke
pnpm desktop:session-smoke
```

- `pnpm restart:desktop:remote` → 期望 `DESKTOP_DEV_VERDICT=ready`。
- `pnpm desktop:whoami` → 确认沙箱实例就是本次要验收的 checkout 与 commit。
- `pnpm desktop:ui-smoke` → **程序化 GUI 验收**（CDP 驱动真实鼠标事件），覆盖
  WL-1.1 / WL-1.2 / WL-1.3 / WL-1.5 / WL-1.2-1.5（四卡）/ WL-2.1 / WL-2.2 / WL-2.3 /
  WL-2.4 / WL-2.5+WL-3.3 / WL-3.2 / WL-5.5+WL-6.1 / WL-6.5 / WL-10 / WL-13 共 15 项，
  逐项打印 `PASS / FAIL / UNVERIFIED` 与证据，`FAIL` 时退出码 1。
  它会自行处理两件容易出错的事：① **校验跑着的实例是否就是 HEAD**（版本行里的 commit 与
  `git rev-parse --short HEAD` 比对）——实例陈旧会直接 FAIL，这正是同步验收最容易犯的错；
  ② **把语言归一到简体中文并在结束时还原**，使断言与用户当前语言无关（否则中文文案断言在
  英文界面下会整片假红）。
- `pnpm desktop:session-smoke` → **程序化会话验收**（WL-3.2 + WL-11.1–WL-11.8 共 9 项）：
  从侧栏项目入口建草稿 → 断默认角色 → 切角色 → 真实发消息 → 交叉核对库行 / main 日志里的
  运行期配置 / 该会话的技能快照 / 侧栏归属。**它是唯一会真正建会话并调用模型的验收命令**
  （刻意如此：项目/角色机制的语义只在真实运行期成立）；用 `--dry-run` 可只跑前 3 项草稿
  断言而不建会话。退出码同 `ui-smoke`（0 无 FAIL / 1 有 FAIL / 2 前置不满足）。
- 于是 WL-13 的**五语横切**也进了程序：`ui-smoke` 会逐一切换到 English / 简体中文 / 繁体中文 /
  日本語 / 한국어，断言每种语言下 Meka 页签与面板都渲染、且界面没有裸 i18n key，
  并记录各语言的页签实际文案。
- **仍需人工的部分**：纯视觉观感（配色/间距/暗色模式目检）、MCPRouter/WL-4 的端到端
  （缺账号与实例）、真实签名与发布（需授权）、共享 profile 的旧库只读迁移。
  这些必须如实登记「未验证 + 原因」。

手工部分按 §3 各条「实机验证」逐项过，顺序建议：
WL-5（先确认区域与链路）→ WL-6（身份/更新）→ WL-1（设置）→ WL-2/WL-3（导航与会话分类）
→ WL-11/WL-8/WL-9（项目、技能、插件）→ WL-4（远程）→ WL-10（模型）→ WL-13（文案）。

## 6. 维护契约

- **硬性**：任何 Meka 专属或与上游不同的改动，必须在**同一次交付**里新增或更新清单项；
  没有清单落点的 Meka 能力改动视为未完成（与根 `AGENTS.md`「文档同步」同级）。
- **硬性**：上游同步的完成判定 = **实跑本清单并逐项记录结论**（§2）。除维护者书面接受
  的「未验证 + 原因」外，全部通过才算完成；**未实跑就宣告完成等同于虚报**。
- 删除或放弃某项能力时，同步删除条目并在当期同步报告写明理由；**编号不复用**，允许留空号。
  当前空号：**WL-7**（初版曾占位「数据谱系与 migration 冻结」，2026-09-11 复核后移除，
  理由见 §8.3）。结构契约测试只要求编号唯一且升序，不要求连续。
- **每一项必须同时具备**：可定位的代码锚点、至少一个自动化门禁**或**明确的可操作实机步骤。
  只写「能力名 + 一句描述」的条目会在结构契约测试里失败。
- **GUI 项不得只写「人工目检」**：凡能用 `pnpm desktop:ui-smoke`（CDP 程序化驱动真实鼠标事件）
  覆盖的，必须在条目的「实机验证」里写上该检查项，并把人工部分限定为真正需要人眼的范围
  （如视觉观感、五语逐一目检）。新增 GUI 能力时应同时扩 `scripts/meka-ui-smoke.mjs` 的
  检查表——否则该能力在下一次同步里仍然只能靠手点。
- **运行期语义项同样不得只写「人工点击」**：项目/角色绑定、角色注入、会话落库与侧栏归属
  这类只在真实运行期成立的不变量，归 `pnpm desktop:session-smoke`
  （`scripts/meka-session-smoke.mjs`）；新增或改动这些链路时必须同步扩它的检查表。
- **断言要落在结构上，不要落在文案上**：实机检查里禁止用「某段文本包含项目名」这类判断——
  2026-09-14 的首版 `WL-11.7` 就因此**假通过**过：它比对的字符串是会话回显正文里的
  `projectId: saga2`，而不是侧栏结构。现在它断言的是 DOM 容器包含关系
  （`项目行.parentElement.contains(会话行)`），并且必须同时核对普通「对话」分组不含该行。
  同理，`WL-11.5` 的硬断言只放 `projectId` / `roleId` 两个**不可翻译的标识符**，
  字面标记行 `[MEKA_ROLE_CONTEXT]` 只是附加证据。
- **不要断言模型逐字复述注入内容**：`WL-11.5` 用「让会话吐回 `[MEKA_ROLE_CONTEXT]`」证明角色
  上下文确实注入了运行期，但实测模型会**按输出语言改写**注入文本（`displayName: 战斗开发` →
  `Combat Development`，中文说明句也会被译成英文）。因此身份判定必须锚在 `projectId` /
  `roleId` 这类标识符上；`displayName` 只作为证据记录，允许与清单值不同。
- 新增条目前先按本节第 1 段的判据自问：**它是不是「上游可能覆盖掉的 Meka 业务能力」？**
  如果它其实是上游自带的机制、或只是导入/搬迁留下的实现形态，就不该占白名单编号
  （见 §7 与 §8.3 的判定示例）。
- 结构由 `scripts/__tests__/meka-whitelist-contract.test.mjs` 强制：字段完整性、命令可解析、
  编号唯一且升序、本文被 `AGENTS.md` 与 `development-workflow.md` 索引。
- 上游同步报告必须引用本文并逐项给出结论（通过 / 失败 / 未验证+原因）。

## 7. 明确不属于白名单的内容

以下差异不需要逐项验证，按上游处理即可（登记在此以免被误当成漏项）：

- 上游与 Meka **共有的**产品能力（普通会话、模型目录、设计系统、移动端、日志上报等）：
  它们的行为以上游为准。
- 上游自身的重构、重命名与文件搬迁：本仓默认接纳。
- 纯展示层命名（`BRAND_NAME` 之外的展示文案）：由 WL-13 的 i18n 门禁统一覆盖，不分项。
- **更新通道优先级与 Beta 渠道设置卡片**：`canary > beta > release`、`updateChannelStore`、
  `updateChannelCapability`、`BetaChannelCell` 与上游逐字节相同 —— 只有渠道身份与根地址
  是 Meka 分歧（见 WL-6.5）。
- **设置里的区域标注**：`AboutSection` / `ImBotSection` 等的 `CURRENT_CINDY_REGION` 分支
  与上游同形；运行期 edition 才是 Meka 分歧（见 WL-5）。
- **`config/endpoint.json` = CN 的命名反直觉**：无后缀是 CN、带 `.global` 才是 Global，
  与 `region-and-editions.md` §2.1「无后缀归 Global」相反。这是**上游共有的历史例外**，
  不是 Meka 分歧；但因为它与 Meka 的 cn/global 共享安装身份叠加时更容易误用
  （WL-5.2 的映射就依赖它），**任何「顺手统一后缀」的改动都会让 dev 默认区读到 CN 清单**。
- **migration 谱系与冻结**（含 `Meka 谱系 0082`–`0095`、`SELECT 1;` 占位谱系槽、编号不得重排）：
  这不是 Meka 业务能力，而是谱系导入形态；保护它的是**上游自己的机制**
  （`db:validate` + `migration-baseline.json` + Git 基线冻结）与本仓工程规则
  [`database-and-migrations.md`](database-and-migrations.md)。上游仓里没有这些文件，
  不存在被覆盖的风险。业务实质（meka 表与列）已在 **WL-11**；详细复核结论见 §8.3。

## 8. 裁决记录与已知缺口

### 8.1 已裁决（2026-09-11）

1. **提交前测试门禁措辞** → **按上游**。Meka 从未改过这条门禁的核心语义，两边写法不一致
   只是合并时 `AGENTS.md` 没跟着上游更新，因此以上游为准：无参数跑
   `pnpm test:unit:related`（相关单测），改到测试调度/依赖清单/workspace 配置/Vitest 配置/
   单测 CI 时自动退回全量 `pnpm test:unit`。`AGENTS.md` 已逐字对齐上游；
   `development-workflow.md` §2 本来就是上游文本；`cindy-meka-upstream-sync` skill 已同步改写。
   **上游同步交付仍按全量安排时间**：同步必然改动 `package.json` / `pnpm-lock.yaml`
   （相对 `meka/main`），这两个仍是 related 门禁的退回条件，§4 不是特例。
   **日常开发不再等价全量**（2026-09-21 更正）：2026-09-11 在 `meka/main` 上实测
   `RELATED full: wide files changed: … pnpm-lock.yaml`，当时 `scripts/test-related.mjs`
   以**上游** `origin/main` 为基准，merge-base 是上次同步点，区间覆盖整条 Meka 产品线
   （当时 691 个文件，2026-09-21 复测 762 个，含上述宽文件）。该基准已改为优先
   `origin/meka/main` / `meka/main`；在产品分支上改一个 Desktop 源文件应走 Vitest
   `related`，不应再静默退回全量。外层超时：相关门禁按短耗时，只有打印了 `RELATED full`
   才按全量给足（见 `development-workflow.md` §2 的 15 分钟下限）。
   **机制更正（2026-09-22）：`test:unit:related` 会不会连带跑 `test:runner` 不是无条件的，
   但本仓大多数交付会命中它。** 实际链路是：`pnpm test:unit:related` =
   `node scripts/test-workspaces.mjs --tier unit --related`；驱动器在 `scripts/test-workspaces.mjs:1062-1084`
   先执行 `runRootTestRunner()`（实现 `:983-1006`，即 `pnpm run test:runner`），而是否执行由
   `scripts/test-related.mjs:96-103` 的 `shouldRunTestRunner()` 决定 —— **改动集合里出现任何
   `apps/` 与 `packages/` 之外的路径**（根文件、`scripts/`、`docs/`、CI workflow…）就为 true。
   因此：只改 `apps/**` + `packages/**` 的交付**跳过** runner；而**任何带文档/脚本改动的交付
   （包括本次文档同步）一定跑它**。规划时间时按「可能跑 runner」算，别只看 `RELATED related` 那一行。
   **`test:runner` 目前有 3 个存量红灯**：`scripts/__tests__/design-inventory.test.mjs:1158`
   （`CLI --check 在当前台账上通过`）与 `scripts/__tests__/hardcoded-color-audit.test.mjs:216`、
   `:372`（`worktree includes staged, unstaged and untracked source; commit mode excludes them`、
   `CI design commands feed the existing verify job and preserve Windows aggregation`）。
   这三个用例是**存量红灯**：用 `git stash` 在未改动工作树上做基线复跑得到同一结果，**不是本批
   交付引入的**（本次文档同步**没有**重跑它们，也没有改动相关实现）。因此读到 `test:runner` 红时，
   先按这三条归类，任何**新增**的失败才是本次改动的问题。
2. **运行期切换服务区（edition）是 Meka 的刻意分歧**，必须保留：上游把区域当**构建期**维度、
   运行期不可切换；Meka 允许在登录页切换，因为**不同区暴露的模型能力不同**，用户需要按
   可用模型选服务区。→ 已登记为 WL-5.6 的不变量。
3. **`authRealmPolicy` 的放宽是运行期切区的配套**：Meka 让跨区（personal / org）既有会话
   一律可恢复（`authRealmPolicy.ts:7-15` 恒 `true`），否则用户切区后另一区凭证被静默作废、
   被迫重新登录——这与「安装身份固定、运行期可切区」是同一套设计。→ 与 WL-5.6 同处登记。

### 8.2 待裁决

1. **IM `/session` 与 `/ctr` 是否应排除 Meka 会话**：
   `apps/desktop/src/main/im/shared/controlProjects.ts:26-31` 的 `attachableSessionPredicate()`
   只排除 Orca worker；`:186/:229` 的过滤条件是 `source ∈ DESKTOP_VISIBLE_SESSION_SOURCES`
   + `status='active'` + `workingDir NOT NULL`。Meka 会话落库时**有** workingDir
   （`localDb/ipc/sessions.ts:1385-1386`：Meka 项目目录或 `ensureMekaWorkspaceDir`），
   `source` 默认 `'desktop'`（`localDb/mapper.ts:447`）—— 满足全部条件。
   **两条选择器是不同路径**：`hook-control/recentSessions.ts` 的守卫服务的是 **hook 侧**
   `session-picker-v1` 投影（`hook-control/ipc.ts:596` → `manager.ts:2445`），
   而 IM 的 `/session`（`im/shared/slashCommands.ts:480`）与 `/ctr` 走 `controlProjects.ts`
   —— 后者**没有**守卫。因此 §5 表那句「Meka 项目工作区不进 IM `/sessions` 选择器」只覆盖了
   前者的语义，后者是**同一类面上的一致性问题**，不是已裁决的差异。
   **建议**：两条都排除。理由：① 与已登记的 Meka 意图一致（对端选择器不承载 Meka 项目/角色
   身份）；② IM 侧无法呈现 `(mekaProjectId, mekaRoleId)`，用户看不出自己在跟哪个角色说话，
   而 Meka **正式工作流**（Jira/GitLab 冻结事项）对角色敏感，误接管代价高；③ `/ctr` 的项目名
   取 workingDir basename，会把本地路径显示进可能是群聊的渠道。
   实现上是给该谓词加 `workspaceKind != 'meka'`（并同步
   `src/main/__tests__/controlProjects.test.ts:59-61` 对谓词出现次数的断言 + 补一条 meka 用例）。
   若产品反而要「IM 可驱动 Meka 会话」，那应当作为**独立能力**显式设计（含角色展示），
   而不是留着这个缺过滤的副作用。
2. **旧数据迁移的「构建区门」跟不跟随运行期 edition**：
   `apps/desktop/src/main/legacyUserDataMigration.ts:955` 是
   `if (CURRENT_CINDY_REGION !== 'cn') return;` —— 只看**构建区**，其理由是「旧 XDMaker Meka
   数据属于 cn 身份，把 cn 历史数据导进 global 库会跨区串台」。但既然 Meka **允许**运行期
   切到 CN（8.1 第 2 条），「global 构建 = global 身份」这个前提就不成立了：Global 构建 +
   登录页选 CN 的用户，其库就是 CN 库，却既不迁移也无提示。
   **建议**：把门从构建区改为**首次登录时生效的 edition / 已提交 realm**（即 `realm === 'cn'`
   才迁移），并在 `region-and-editions.md` §1.2 写明该组合的行为；同时补一条门级用例
   （当前**完全无覆盖**）。这是**数据迁移行为变更**，需维护者明确批准后才动手。
3. **`apps/desktop/src/main/meka-settings/mekaRiskPolicy.ts`** 的风险档位语义需要补一条
   实机验证路径（当前无独立自动化门禁，已列为 WL-1.6，待补）。
4. **真实升级链路**（旧 `xdmaker-meka` 目录只读迁移、`cindy-meka://` 深链注册、更新渠道
   实际拉取）无法在沙箱内完成，需要一次真实安装/升级验证；未完成前不得声称发布就绪。
   注意 8.2 第 2 条未决时，这条验证的预期行为本身也没定死。
5. **Codex 子代理策略被上游重设计取代（2026-09-11 白名单实跑带出，未登记的能力移除）**：
   合并前 Meka 的 `SubagentModelSettings` 有 7 个字段（`codex` / `codexProviderId` /
   `codexEffort` / `codexSubagentsEnabled` 默认 **true** / `codexUseCindySubagentPolicy`
   默认 **true** / `codexMaxConcurrentSubagents` / `codexAllowNestedSubagents`），现在只剩
   `codexSmartSubagentRouting`（默认 **false** = Codex 原生 Sol/Terra 调配）。
   `apps/desktop/src/main/maker-host/codex-subagent-config.ts` 由 203 行缩到 68 行（= 上游版本），
   `resolveCodexSubagentHostCredentialPlan`（oauth-passthrough 路由的 fail-fast 凭据闸）、
   `forceDisableSubagents`、`MODEL_OVERRIDE_PREFIX` 全仓归零。
   **迁移本身是刻意且有测试的**（`subagent-model-settings-store.test.ts:121`「removes retired
   Codex fixed-route and guardrail keys when settings are opened」断言旧键被丢弃、仅含旧键时
   设置文件被删除）；**但它没有被登记** —— 同步报告、迁移总账与 D1–D4 决策里都没有。
   用户可见影响：① 配过这些项的 Meka 用户设置被静默丢弃；② **默认行为翻转**（Cindy 策略
   开 → Codex 原生）；③ `agents.enabled=false` 硬闸、`agents.max_depth`、并发上限不再可注入。
   **未受影响**：SAGA2 远端只读 worker 的硬禁用仍在链路里（`meka-injection/mekaResolvePlan.ts:531-533` 设
   `codexNativeSubagentsDisabled` → `maker-host/index.ts:1618` 读取 → `:1831`
   `buildCodexSubagentSpawnArgs`），WL-4.2.3 不因此失效。
   **需裁决**：接受上游重设计并补登为一条决策（承认默认翻转与设置退场），**或**把 Meka 的
   子代理策略移植到上游新的 `codexSmartSubagentRouting` 机制上。
   > 注意：本条**暂不占 WL 编号** —— 按 §6 的判据，白名单只登记「当前存在、需要防上游覆盖」
   的能力；若裁决为「恢复」，则应补一条 WL-15 并在其中钉住这些不变量。详细实跑证据见
   [`../migrations/2026-09-origin-main-to-meka-main.md`](../migrations/2026-09-origin-main-to-meka-main.md) §7.1。
6. **同一项目内重进「新建」入口时是否应重置草稿角色（2026-09-14 白名单实跑带出）**：
   `NewMakerDraftRoute` 的项目/角色是 `useState` 初值（`:868-887`）+ 一个依赖
   `[routeMekaDraft.mekaProjectId, routeMekaDraft.mekaRoleId]` 的同步 effect（`:893-918`）。
   侧栏入口走 `navigate('/cc-agent/new', { state: { mekaProjectId } })`
   （`CCAgentSidebarUpper.tsx:2404-2416`）：当用户**已经**停在 `#/cc-agent/new` 时，路由不变、
   组件不重挂载、effect 的两个依赖也不变，于是**草稿里已选的角色被保留**，而不是回到该项目
   的默认角色。实测（2026-09-14，改动前）：真正重挂载时默认 `roles[0]=通用开发`；同路径重进
   时保留已选的 `战斗开发`（`pnpm desktop:session-smoke` 的 WL-11.1 / WL-11.8 对照）。
   **2026-09-22 更新**：默认选中项已改为共享默认角色 `pickDefaultMekaRole(roles)`
   （`<projectId>-default-role`，见 WL-11.1），因此「重挂载回到哪个角色」现在指默认角色而非
   `roles[0]`；本节裁决（保留已选、不重置）不变。
   **我的判断是保留现状**：它等价于「同一草稿里点新建不清空当前选择」，与草稿正文本来也不会
   被清空一致；切换项目时 effect 依赖变化仍会重置为新项目的默认角色，不会跨项目串角色。
   **需要维护者确认**，因为这是用户可见的默认值语义，且实现上更像「effect 依赖缺一个草稿
   实例标识」的副作用而非显式设计。无论怎么定，WL-11.8 已把它钉成可执行断言：**改行为必须
   同步改 WL-11.8**，不允许静默漂移。
   跨项目重置那一半在**本机 profile 无法验证**（只有内置 SAGA2 一个项目），已在
   WL-11.8 的通过证据里如实标注。


### 8.3 已移除：migration 谱系冻结不单列为白名单项（2026-09-11 复核）

初版曾有一条 `WL-7 Meka 数据谱系与 migration 冻结`，复核后**删除**，理由：

1. **它不是 Meka 业务能力**，而是谱系导入的实现形态：Meka 谱系 `0082`–`0095` 里既有真实 SQL
   （`0089`–`0092`），也有占位槽 —— 带同名 runtime script 的（`0082` / `0088` / `0093`–`0095`，
   真实工作在脚本里）和纯编号占位的（`0083`–`0087` 的 `*_meka_lineage_slot_*`）。
   这些文件是「怎么搬进来的」的痕迹，不是用户能感知的能力。
2. **保护它的是上游自己的机制**，不是 Meka 特例：`docs/dev-rules/database-and-migrations.md:36-38`
   写明冻结分两部分 —— 迁仓前的 `0000`–`0079` 由 `migration-baseline.json` 固定 SHA256
   （实测 `sourceCommit=51440f675c`，是上游祖先），**新仓进入 canonical 产品分支的 migration
   由 Git 基线冻结**（`db:validate` 拿当前树与 `meka/main` 对比）。两部分的门禁都是
   `pnpm --filter desktop run db:validate`，§4 已经无条件跑它。
3. **不存在「被上游戏覆盖」的风险**：上游仓里根本没有 `0082`–`0095` 这些文件，冲突解不出来、
   也覆盖不掉。白名单的用途是防上游覆盖 Meka 能力，这一条不属该风险面。

**业务实质已归位**：`meka_projects` / `meka_roles` / `sessions` 的 meka 列是 WL-11
（项目、角色与正式事项）的事实基础，其锚点与 `db:validate` / `pnpm test:db` 门禁已并入 WL-11。
编号工程规则（不得手改文件名/journal/snapshot 强行换号、`origin/main` 新编号与 Meka 已发布
lineage 撞号的处理、migration 文件本体不写注释）留在
[`database-and-migrations.md`](database-and-migrations.md)，那才是它的归属。

**编号留空不复用**：WL-7 从此空缺（见 §6 的编号规则）。

### 8.4 已知缺口：Meka 会被「隐藏项目」降级成普通对话（真实缺陷，无覆盖）

`apps/desktop/src/renderer/features/cc-agent/lib/sidebarProjectVisibility.ts:108-127` 的
`sidebarSessionsWithHiddenProjectsAsDialogues` 会把落在「已隐藏项目」key 内的会话改写成
`{ ...session, workspaceKind: 'dialogue' }`（`:125`），而豁免条件只有
`workspaceKind === 'dialogue'`（`:40`、`:71`），**不豁免 `'meka'`**。

调用点 `CCAgentSidebarUpper.tsx:1354-1362` 在 Meka 分流（`:1371` 与 `:1639`）**之前**执行，
于是被隐藏项目目录下的 Meka 会话会被：① `visibleMekaSessions`（按 `workspaceKind === 'meka'`
过滤）丢弃 ⇒ **从「Meka 助理」段消失**；② `nonMekaSidebarSessions` 收下 ⇒ **出现在普通对话
分组**。触发条件是 Meka 项目的 workingDir 恰好等于用户已从侧栏隐藏（墓碑）的 Cindy 项目目录。

该函数在上游 `4f03ea9a7b` 与合并前 `5917437271` 中**逐字相同**——它是 Meka 侧新增
`'meka'` kind 后没有同步补豁免留下的缺口（上游域内不存在该 kind，故上游代码自洽）。
按「非本次修改引入的存量问题不擅自修复」**未处理**，需用户决定是否纳入；
修法是加 `session.workspaceKind === 'meka'` 豁免并补一条用例。

### 8.5 无自动化覆盖的清单项汇总（人工核对清单）

以下条目当前**只能人工核对**；它们同时是补测试的候选（成本低、价值高）：

| 清单项 | 现状 |
| --- | --- |
| WL-1.1 设置页签位次 | 有 `tabLabels.test.ts` 覆盖 |
| WL-1.2 设置面板本体（648 行 `MekaAssistantSettingsSection.tsx`） | **零渲染测试**：四张卡存在性、断开确认、冲突单次触发、系统内置只读行全无自动化 |
| WL-1.6 `mekaRiskPolicy` | **无独立单测**（Host 词表 / token 启发式 / 取较高者合并均无覆盖） |
| WL-1.7 P4 发送前门 | 无覆盖（确认框文案与跳转行为） |
| WL-2.1 `mekaRow` 存在与顺序、WL-2.2 rail Meka 按钮 | 全仓无测试引用 `mekaRow`（而本轮同步恰好在这里解坏过） |
| WL-2.4 旧深链 `/meka-plugins` 重定向 | 无用例 |
| WL-2.5 侧栏位次断言的覆盖面 | 只断言到 `ProjectsSection`，不含 `DialogueSection` 与 `SidebarTopNav` |
| WL-3.1 `visibleMekaSessions` / `nonMeka*` 互斥 | 无直接覆盖 |
| WL-4.1.2 `mcpr:` 早返回 | **已部分补齐（2026-09-18）**：`src/main/maker-host/__tests__/mcprRemoteFileOps.test.ts` 已是行为级（真实执行钩子体 + 断言 SSH pool `get` 零调用 + 反向保护）；`register.ts` 侧仍为源码文本序 |
| WL-4.1.3 SSH-only recovery 的 mcpr 过滤 | 无覆盖 |
| WL-4.1.6 `mcprCodexCapability.test.ts` 的 bundle pin | mock 固定 `'0.0.7'`，**不随真实 bundle 漂移变红** |
| WL-4.1.7 Codex `0.145.0` 最低版本 | 无显式版本比较断言（靠 capability endpoint 缺失副作用 fail closed） |
| WL-4.2.4 `handleSelectRemoteSession` | 无覆盖 |
| WL-5.4 / WL-5.5 `authLoginFlowReset` 等 | 以**源码形态断言**为主（实现与断言可被同时覆盖，正是 §1 点名的失效形态） |
| WL-6.7 应用 icon | 无覆盖 |
| WL-8 / WL-9 技能与插件的 Meka 渠道账本 | 有间接覆盖，缺「Cindy 忽略本轮不压掉 Meka」这类跨渠道断言 |
| WL-12 scheduler 5 处 `meka` 跳过 | 无直接断言 |
| WL-12 `recentSessions.ts:37` 的 `meka` 跳过 | 现有 5 条用例均未放入 meka 行 |
| WL-12 `im/shared/controlProjects.ts` 的 IM 取数 | 未排除 meka（见 §8.2 第 1 条） |
| WL-16 `maker-host/index.ts:2308` 的注册接线 | **源码级、非行为级**断言（`meka-injection/__tests__/mcpRegistration.test.ts` 的接线契约 describe：剥注释后按**调用形状**匹配 + 三个 `_mcpProviders[*]` 赋值都必须先于注册点）；「漏传即抛」的装配期路径由 `registerMekaCapabilities` 单测覆盖 |
| WL-16 三种 agent 在真实会话里各自拿到的 MCP provider | 矩阵/注册/逐字节基线均有单测；**实机面本轮未跑**（worktree 无运行实例，见 WL-16 实机验证的「未验证 + 原因」） |
| WL-16 D2.3（抛错路径的写入语义） | 只有单测（第 15 组 3 例）钉住「抛错 ⇒ opts 零写入」；**成功路径的逐字段等价**靠 10 条快照用例 + 1204 组新旧差分，不靠实机 |
| WL-17 `.cshare` 的 Meka 绑定往返 | 单测已落地（导入 10 条 / 导出 3 条 / 格式 2 条），但**登记人未运行**；跨版本（旧客户端读同一包）与真实 Electron 往返**零覆盖** |
| WL-18 Pi 技能快照与 Meka 运行时 MCP | 单测已落地（`host-skill-mount` 7 条 / startsession 1 条 / **真 Pi 二进制**集成 1 条 / bridge 3 条 / 矩阵与注册断言），但**登记人未运行**；远端 Pi 不挂快照与普通会话 fail-closed 的**文案**无实机覆盖 |
| WL-19 Unity CLI-only 边界 | **零自动化覆盖**：三道守卫的拒绝路径与文案、九条 Pipeline command 与两个动作的清单、旧 MCP「无 CLI 等价物」均无断言（清单本身也无仓库内代码锚点） |
| WL-11.11 两请求类与「启发式不得 confirmed」 | 单测已落地（`mekaRuntimeInjection.test.ts` 分类/补丁、`combatWorkflowPolicy.test.ts` 门禁），但**登记人未运行**；成员清单（A4）由 Agent 自己的只读查询登记、批准后冻结，**有生产写入方**，但真实会话「解析 → 只读查询登记成员 → 确认 → 逐目标实施」全链路**零覆盖**；会话级镜像（A3）**重启后为空**这一事实也只有代码证据 |
| WL-11.12 项目参考路径注入与精确路径白名单 | 单测已落地（`mekaRuntimeInjectionBaseline.test.ts` 的 `[SAGA2_PROJECT_PATHS]` 全文与 vendorOptions 键序），但**登记人未运行**；真实含 CJK 目录名路径的读取**未实机验证** |
| WL-11.13 表范围只读通道与 P4 写边界（Unity 查询 + P4） | Cindy 侧白名单放行/拒绝有单测（`combatWorkflowPolicy.test.ts` 两条），但**登记人未运行**；**跨仓清单一致性零自动化断言**（靠 `meka-unity/node/worker.cjs:49-59` 与 Cindy 侧清单同时人工核对）；**P4 写边界零自动化覆盖**：`p4_edit`/`p4_add` 前置、从不 `p4_submit`、本批 Unity C# 改动未入库都只由角色/Skill 正文表达（`p4_submit` 在 Host 侧是放行路径），需用 `p4_opened` 人工核对 |
| WL-11.14 Host 侧证据预算／配额／时限已删除（收敛纪律保留） | ① 的静态核对已由编排者实跑通过（代码/测试/提示词/资源范围内 `git grep` 零命中、退出码 1，命令见本条，必须带 `-- apps packages scripts`）；**没有自动化断言禁止复活 Host 侧次数上限**（新加常量的 PR 不会被门禁拦下）；片段文件名/id 仍叫 `combat-evidence-budget` 是有意保留 |
| WL-11.15 Pi 空回合不得静默收尾 | 单测已落地（`pi-translator.test.ts` 三条 + host 守卫用例链 + `agent-island/state.test.ts` 的挂起、两条事件序、五条释放路径与单调时钟 + `claude-code/translator.ts` 的生产者契约），但**登记人未运行**；真实网络断流的复现**零覆盖** |
| WL-11.16 战斗写入门禁三层（范围绑定／命令面白名单／写后对账） | 单测已落地（`combatWorkflowPolicy.test.ts` 的 D1／D2／D3 用例，把对应门禁临时失效即转红；D2 覆盖有损、无损、缺基线、回读不一致、MCP 与 Shell 两条路径），但**登记人未运行**；写入对账所依赖的**真实 meka-unity 回执封套嵌套未核验**（本仓不可核验），且 `[SAGA2_COMBAT_CONFIG_RESULT]` 的最终文字收尾**没有 Host 门禁** |

补测试时应优先覆盖**本轮同步真实坏过**的位置（WL-2.1、WL-9 派生包、WL-10 补种、WL-12），
而不是平均用力。

### 8.6 本轮顺带修掉的门禁缺口（记录在案）

`scripts/__tests__/meka-release-identity.test.mjs`（7 条，覆盖打包产物名、更新器落点、
端点自举、签名服务与 macOS 证书）此前**没有被任何门禁引用**——它自己通过，但永远不会在
CI 或本地 `test:unit` 里跑。今回把它与新增的
`scripts/__tests__/meka-whitelist-contract.test.mjs` 一并登记进 `pnpm test:runner`，
本清单 §4 声称的覆盖面才成立。改动 `test:runner` 名单时两者都不应被移除。
