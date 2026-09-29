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

- **代码锚点**：`apps/desktop/src/renderer/lib/tabLabels.ts:16,39,80`（页签名 `'meka-assistant'` 与 i18n key `settings.tabs.mekaAssistant`）、`apps/desktop/src/renderer/components/settings/SettingsSidebarNav.tsx:76`（图标）、`apps/desktop/src/renderer/components/settings/SettingsView.tsx:572-581`（`activeTab === 'meka-assistant'` 分支渲染 `<MekaAssistantSettingsSection />`，**无任何门控**；组件标签实体在 `:579`）
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

- **代码锚点**（行号为 2026-09-23 第三轮同步后逐条打开文件实测；本仓有锚点漂移史，**引用时以符号名为准**）：
  `apps/desktop/src/renderer/features/cc-agent/CCAgentSidebarUpper.tsx` 的 `onMekaMatch`（`useMatch('/cc-agent/meka/*')`，约 `:4090`）、rail Meka 按钮（`SidebarIconButton` + `BriefcaseBusiness` + `active={Boolean(onMekaMatch)}`，约 `:4137-4145`）
- **不变量**：位置在 `GhostMainViewNavEntries`（`variant="rail"`，约 `:4134`）之后、插件 rail 入口（约 `:4146-4153`）之前
- **自动化门禁**：**无自动化覆盖**
- **实机验证**：把左侧栏拖到 rail 态 → 图标列含公文包（Meka）；点击进入 Meka 插件页；处于 `/cc-agent/meka/*` 时为 active 态
- **历史回归**：源码注释记录过「折叠 rail 之前漏了这颗按钮」的对称性缺口（当前在 `:4135-4136` 的注释里）

#### WL-2.3 三页签管理页骨架（插件 / 技能 / 项目）

- **代码锚点**（行号为 2026-09-23 第三轮同步后实测；**以符号名为准**）：`apps/desktop/src/renderer/features/plugin/PluginManagementLayout.tsx:21-22`（`PluginManagementTab` 含 `meka-*` 三项）、`:129-130`（`isMekaTab`）、`:161-189`（`tabItems`：Meka 分支目标路由 `/cc-agent/meka/plugins`、`/cc-agent/meka/skills`、`/cc-agent/meka`；非 Meka 分支才是 `/plugins`、`/skillhub/local`）、`:191-212`（`showPrimaryTabs` 的渲染分支）
- **结构（2026-09-23 第三轮同步更正）**：页签控件**已由 Meka 自建的 `div` pill + 独立 `TabButton` 换成上游共享组件 `SegmentedControl`**（`@/components/ui/segmented-control`，`:17` 导入、`:192-211` 使用；`role="tablist"`、`height={38}`、`optionHeight={32}`、`optionClassName="plugin-management-tab min-w-[88px] px-4 text-13"`）。Meka 三个页签与上游 Plugin / Skill 两个页签**共用同一控件**，只有 `value → 目标路由` 的映射不同：`:202-209` 的 `onValueChange` 里非 Meka 页签先走 `onSelectTab`（设置页内切换），Meka 页签才 `navigate(target.to)`。**不得**退回「Meka 一套 pill、上游一套 pill」的双实现。
- **自动化门禁**：`pnpm --filter desktop exec vitest run src/renderer/features/plugin/__tests__/PluginManagementLayout.test.tsx`
- **实机验证**：Meka 管理页顶部三个分段控件页签（与插件/技能页同一组件、同一视觉）；逐个点击 URL 依次为三个 Meka 路由；「项目」页先进项目库列表，不默认选中某个项目
- **历史回归**：`xdmaker-meka-to-cindy.md` §4.6（三页签同级、复用上游宽度/胶囊 Tab）

#### WL-2.4 Meka 路由族与旧深链重定向

- **代码锚点**：`apps/desktop/src/renderer/router.tsx:115-118`（四条 `meka/*` 子路由）、`:194-197`（`/meka-plugins` → `/cc-agent/meka/plugins` 重定向）
- **不变量**：四条路由必须排在 `:sessionId` 通配之前
- **自动化门禁**：部分覆盖（`PluginManagementLayout.test.tsx`、`MekaProjectRoleEditorRoute.test.tsx`、`MekaSkillHomeView.test.tsx`、`MekaSkillMarketListView.test.tsx`）；**旧路径 `/meka-plugins` 重定向无用例**
- **实机验证**：直接导航 `/meka-plugins` → 落到 `/cc-agent/meka/plugins`；四个 Meka 页面均正常渲染

#### WL-2.5 Meka 段在侧栏的位次

- **代码锚点**（行号为 2026-09-23 第三轮同步后实测；**以符号名为准**）：`apps/desktop/src/renderer/features/cc-agent/CCAgentSidebarUpper.tsx` 的 `<MekaAssistantSection>`（约 `:3779`）、`<PinnedSection>`（约 `:3817`）、`<ProjectsSection>`（约 `:3883`）
- **自动化门禁**：`pnpm --filter desktop exec vitest run src/renderer/__tests__/mekaSidebarOrder.test.ts`（断言 Meka 段在置顶段与项目段之前）
- **缺口**：该断言**不覆盖** `DialogueSection`（文件仍在但已不在渲染路径）与 `SidebarTopNav section="scrollable"`（约 `:3696`）的相对位次
- **实机验证**：Meka 段位于「置顶」「项目」之上，一级产品区不被挤到 Cindy 任务之后

### WL-3 Meka 代理对话的单独分类

**保护的不变量**：Meka 会话（`workspaceKind === 'meka'`）是**与项目/对话同级的一级分类**，
按 `(mekaProjectId, mekaRoleId)` 归属而不是按 workingDir；它**只**出现在 Meka 段，
不重复出现在普通项目/对话列表，也不进 IM 选择器与 scheduler 域。

#### WL-3.1 互斥取数（`visibleMekaSessions` / `nonMeka*`）

- **代码锚点**（行号为 2026-09-23 第三轮同步后实测；**以符号名为准**）：`apps/desktop/src/renderer/features/cc-agent/CCAgentSidebarUpper.tsx` 的 `visibleMekaSessions`（按 `workspaceKind === 'meka'` 取，约 `:1798-1803`）、`nonMekaSidebarSessions` / `nonMekaActivitySessions`（约 `:1446-1449` / `:1450-1453`）、普通项目分组派生（`allGroups` / `allProjectGroups` / `groups` / `groupsWithPinnedProjects` **全部**由 `nonMeka*` 派生，约 `:1454-1494`）、`unfilteredProjectSessions`（排除 meka，使 `projectUniverse` 不含 Meka 项目，约 `:1509-1515`）
- **自动化门禁**：**无自动化覆盖**（`mekaSessionPresentation.test.ts` 只覆盖纯分组函数，不覆盖这两个 filter 的互斥性）
- **已知边界（存量缺口，三侧一致、非本轮同步引入）**：`apps/desktop/src/renderer/features/cc-agent/lib/sidebarProjectVisibility.ts` 的 `sidebarSessionsWithHiddenProjectsAsDialogues`（约 `:145-165`；改写点在 `:162` 的 `{ ...session, workspaceKind: 'dialogue' }`）会把落在**已隐藏项目** key 内的会话整体改写成 `workspaceKind: 'dialogue'`，而豁免条件仍只看 `'dialogue'`（`:40` / `:87` / `:101`），**不豁免 `'meka'`**。后果：Meka 项目的 workingDir 恰好等于用户已从侧栏隐藏（墓碑）的 Cindy 项目目录时，该目录下的 Meka 会话被改写 ⇒ ① 被 `visibleMekaSessions`（按 `workspaceKind === 'meka'` 过滤）**丢弃，从 Meka 段消失**；② 被 `nonMekaSidebarSessions` 收下，**出现在普通对话分组**。同一 Meka 项目里 workingDir 未被隐藏的其它会话仍在 Meka 段 ⇒ 该项目会**同时**出现在 Meka 段与普通对话列表 —— 即本条的「只出现在 Meka 段」在**该组合条件下不成立**。详见 §8.4；修法（补 `'meka'` 豁免 + 用例）待用户裁决，本轮不动。
- **实机验证**：同目录下建普通项目会话 + Meka 会话 → Meka 会话**只**出现在「Meka 助理」段；切换侧栏项目筛选不影响 Meka 段、也不产生重复行；`@` 项目引用不指向 Meka 项目。**负向补充**：把 Meka 项目目录加入侧栏「隐藏项目」后再看两段归属（当前预期命中上一条已知边界，即出现重复或降级——这是存量行为，不是本轮回归）

#### WL-3.2 项目树与「正式 / 普通」子分组

- **代码锚点**（**认函数体不认行号**——本文件随段头/树渲染改动持续漂移，行号只作参考；以下为 2026-09-23 第三轮同步后实测）：`apps/desktop/src/renderer/features/cc-agent/sidebar/sections/MekaAssistantSection.tsx` 的 `buildMekaProjectSessionGroups`（**符号名优先，约 `:152`**；按 `mekaProjectId` 建桶、已配置项目在前、孤儿桶在后；`formalWorkflowActive` 判据 = 启用且 `jira+jiraProjectKey` 或 `gitlab+gitlabProjectUrl`）、`MekaAssistantSection` 的树渲染 JSX（`return (` 起，约 `:336-552`；段头标题 `meka.sessionListTitle` 约 `:350`）、不可用项目 / 旧版会话分组标题三元（约 `:431`，`meka.unavailableProject` / `meka.legacySessions`）、`resolveMekaFoldState`（约 `:139`）、`sessionActivityMs` 导入（`:28`）
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

- **代码锚点**（2026-09-23 第三轮同步后实测；**以符号名为准**）：`apps/desktop/src/renderer/features/cc-agent/SessionContentHeader.tsx` 的 meka scope 取值（仅 `workspaceKind === 'meka'` 时取，约 `:145-155`）、可点 chip（条件 `workspaceKind === 'meka' && mekaSessionScope && mekaRoleEditorRoute`，约 `:604-617`）、旧版只读 chip（`!mekaRoleEditorRoute && legacyMekaRoleLabel`，约 `:619-630`）；`apps/desktop/src/renderer/features/cc-agent/useMekaSessionScope.ts:7-18`（`resolveMekaSessionScope`、`buildMekaRoleEditorRoute`；hook 本体在 `:20`）
- **不变量**：角色被删/项目为 null → scope 为 `null`，**不显示过期角色名**；旧会话（只有 `mekaRole`）走只读映射
- **自动化门禁**：`mekaSessionPresentation.test.ts` 的 `shows only the role name in the session header`、`builds a direct role-editor route with encoded frozen identities`
- **实机验证**：会话头出现角色名 chip → 点击跳到 `/cc-agent/meka?projectId=…&roleId=…` 且已直选；删角色后 chip 消失

#### WL-3.6 `'meka'` 跨层身份契约

- **代码锚点**（行号为 2026-09-23 第三轮同步后逐条打开文件实测；**以符号名为准**）：`packages/maker-core/src/types/common.ts:9`（`WorkspaceKind`）、`apps/desktop/src/renderer/lib/ccAgent.types.ts:13`（`WorkspaceKind`）、`apps/desktop/src/main/localDb/schema.ts:103`（`workspace_kind` 枚举）、`apps/desktop/src/main/localDb/client/tx/types.ts:833`（tx 层——本轮同步曾在这里**反向补** `'meka'`）、`apps/desktop/src/main/localDb/ipc/sessions.ts` 的 `ALLOWED_WORKSPACE_KINDS`（`:1380`）与 `workspaceKind` 取值联合（`:1395-1396`），另有「meka 必须同时带 project+role」的创建期校验（`:1404-1410`）、resume 期 `expected.workspaceKind` 校验（`:1746-1758`）与 `sessions:update` 拒绝把普通会话改成 `'meka'` 的守卫（`:1905-1935`）、`apps/desktop/src/shared/conversationSearch.ts:6`
- **不变量**：`'meka'` 是持久化合法值（DB enum + 跨进程类型联合）；`workspaceKind === 'meka'` 必须**同时**带 `mekaProjectId` + `mekaRoleId`，反之亦然
- **自动化门禁**：`pnpm --filter desktop exec vitest run src/main/localDb/__tests__/mapperMekaFormal.test.ts src/main/maker-ipc/__tests__/sessionCreateHandler.test.ts src/main/maker-ipc/__tests__/sessionRequest.test.ts src/renderer/features/cc-agent/__tests__/collaborationEligibility.test.ts`
- **实机验证**：建 Meka 会话 → 重启仍在 Meka 段且项目/角色不变；IM 侧 `/new` rotate 后该会话**未被截断**成普通会话
- **历史回归**：上游新增 `im.rotateSession` tx 的 `workspaceKind` 只写 `'project' | 'dialogue'`，本轮在 `tx/types.ts` 反向补 `'meka'`（[`2026-09-origin-main-to-meka-main.md`](../migrations/2026-09-origin-main-to-meka-main.md) §4.1）

#### WL-3.7 Meka 段文案五语齐备

- **代码锚点**：五语 `common.json` 的 `meka.*` 命名空间（`sessionListTitle` / `formalSessions` / `regularSessions` / `noSessions` / `unavailableProject` / `legacySessions` / `legacySessionScope` / `legacyRoles.*` / `openManagement` / `expandSessions` / `collapseSessions`）
- **品牌与通用文案属刻意差异（2026-09-23 第三轮同步登记，本轮合并必须保留 Meka 侧文本）**：`{{appName}}` 占位符的品牌插值结果必须是 Meka 品牌名（`BRAND_NAME`），**不得**被上游文案替换成 `Cindy`；「主机安全策略」类报错是**任务通用**文案（不得夹带 iOS / 模拟器这类平台专属措辞，五语皆然）。这两条各有自动化门禁钉住：`apps/desktop/src/renderer/__tests__/i18nBrandPlaceholder.test.ts`（`{{appName}}` 渲染后不得残留占位符）与 `apps/desktop/src/renderer/__tests__/errorMessageRestore.test.ts:39-45`（`logic.errors.hostShellCommandBlocked` 在五语中均非空且不含 `iOS|模拟器|シミュレータ|시뮬레이터`）。⇒ 合并时若上游改写了同一批 key，**以 Meka 侧文本为准**，并把断言保持在上述两个文件里；把它们当成「上游共有的展示命名」按 §7 处理会直接打破 WL-6/WL-13 的品牌口径。
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

- **代码锚点**（**2026-09-29 Meka 最小随包交付后逐条打开文件复核**；**以符号名为准**）：`apps/desktop/src/main/maker-ipc/register.ts` 的 `ensureRemoteReadyForSessionStart`（session-start / lazy resume 前置，函数体约 `:7694` 起）内 —— **MCPRouter guard 必须在 `ensureRemoteHostReady` 之前**（mcpr 早返回 `:7758`、`await ensureRemoteHostReady(...)` `:7760`；`:7757` 是「逻辑 `mcpr:<instanceId>` 永远不是 SSH pool key」的原因注释）、`refreshRemoteCodexMcpOnTurnSettledHolder`（turn-settled holder，声明 `:3496`、赋值 `:7942`、mcpr 过滤 `:7950`）、Meka 远端 bundle 块（`mcprInstanceId` / `buildMekaRemoteCodexBundle` / `ensureRemoteCodexCapability` → `bindSessionRemoteCodex` → 成功 `releaseRemoteCodexCapability`、失败 `unbindSessionRemoteCodex` + 恢复，约 `:7145-7205`；`applyMekaRuntimeConfig` 调用在 `:7054`，普通 SSH 明确抛 `Meka native Skills are not available on legacy SSH sessions` 在 `:7159`）；`apps/desktop/src/main/maker-host/index.ts` 的 `remoteCcQueryFactory`（约 `:1309` 起）里 mcpr 分支（约 `:1323-1347`）之后的 SSH pool 查询与 `remote ssh host not ready` 原文（约 `:1348-1350`）
  > **锚点更正（2026-09-29）**：原文的 `:7660-7726` / `:7724` / `:7726` / `:7666-7668` / `:7908` / `:7916` / `:7099-7150` 与 `maker-host/index.ts:1321-1323` / `:1290-1325` 均已过期（`register.ts` 本批删掉战斗 IPC 口子后行号整体移动）。上列是复核后的当前值。
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

- **代码锚点**（**2026-09-29 逐条打开文件复核**）：`maker-ipc/register.ts` 的三处 mcpr 早返回 ——
  `ensureRemoteReadyForSessionStart` 内（`:7757-7758`，先于 `:7760` 的 pool 前置）、
  `refreshRemoteCodexMcpOnTurnSettledHolder` 内（`:7950`）、模型路由探测旁（`:6991-6997`）；
  `apps/desktop/src/main/maker-host/remote-codex-mcp-recovery.ts`（自身不分类，依赖调用方保证）：
  `refreshRemoteCodexMcpAfterBridgeRecreate`（`:54`）、`invalidateRemoteCcQueriesForMcpGenerationChange`
  （`:110`）、`maybeDetachStaleRemoteCcQuery`（`:144`）
  > **锚点更正（2026-09-29）**：原文的 `register.ts:7471-7476` / `:7409-7419` / `:7443-7463` 与
  > `remote-codex-mcp-recovery.ts:91-116` 均已过期（前者因本批删除整体移动，后者本就该按符号名引用）。
  > `remote-codex-mcp-recovery.ts` **本批未被改动**。
- **自动化门禁**：`remoteCcQueryFactory.test.ts` 的 SSH shutdown 用例；**turn-settled / shutdown 的 mcpr 过滤无自动化覆盖**
- **实机验证**：MCPRouter 任务 turn 运行中触发 bridge 重建（改全局插件或 Maker Memory 开关），turn 结束后无 pool 报错且可继续下一轮

##### WL-4.1.4 Claude 隧道先于 SSH pool，且共享 cc-manager client 双形态

- **代码锚点**（**2026-09-29 逐条打开文件复核**；**以符号名为准**）：`apps/desktop/src/main/maker-host/index.ts` 的 `remoteCcQueryFactory`：`classifyRemoteSessionTransport(remoteHostId) === 'mcpr'` 分支（`:1323`）里 `openMcprTunnel`（`:1324`）→ `openCcManagerSession({ stream, transportId: remoteHostId, … })`（`:1325-1342`），**整体先于** SSH 分支的 `getRemoteSshPool().get(remoteHostId)`（`:1348`；`host?.getStatus() !== 'ready'` 即抛 `remote ssh host not ready`，`:1349-1350`）；`apps/desktop/src/main/maker-host/cc-manager-client.ts:293-294`（`host?` 与 `stream?` 并列）、`:67-92`、`:389-397`（approval request handler；未注册时的拒绝在 `:411`）、`:415`（`SUBAGENT_MODEL_ACCESS`）、`:447`（`MCP_TUNNEL_CALL`）
  > **锚点更正（2026-09-29）**：原文的 `:1296` / `:1297` / `:1298-1315` / `:1321` / `:1322-1324` 均已过期；
  > `cc-manager-client.ts` **本批未被改动**，其锚点未变。
- **不变量**：两种 transport 上都要保留 approval、subagent model access（protocol 4）、bundle hello 与 MCP tunnel 投影
- **自动化门禁**：`remoteCcQueryFactory.test.ts` 的 `routes Claude through the MCPRouter tunnel before any SSH pool lookup` 与 `keeps byte-stream MCP projection and v4 model access on the shared cc-manager client`；`mcprTunnelMeka.test.ts`
- **实机验证**：MCPRouter 实例跑 Claude 任务并触发远端 subagent 与远端 MCP 调用；审批卡正常弹出

##### WL-4.1.5 Codex MCPRouter 分支必须**成组**保留

- **不变量**：transport + remote credential mode（固定 `gateway-key`）+ capability thread register/unregister 三项**缺一即在启动鉴权或远端 Skill 路由阶段失败**；不得在 maker-core 解析 `mcpr:` 前缀
- **代码锚点**（**2026-09-29 逐条打开文件复核**；**以符号名为准**）：`apps/desktop/src/main/maker-host/index.ts` 的 `getRemoteCodexTransport`（`:2146`）：mcpr 分支里 `parseMcprRemoteHostId` 失败即抛 `[MCPR_INSTANCE_NOT_READY] Invalid MCPRouter Worker target`（`:2147-2152`，抛点在 `:2151`）、`createMcprCodexTransport({ instanceId, buildHeader, logger })`（`:2154-2158`）、SSH 分支的 `getRemoteSshPool().get` + `createSshDaemonTransport`（`:2171` 起）、`resolveRemoteCodexCredentialMode`（注入同一 deps 对象，`:2194`）；capability thread register/unregister 走 `routeCodexThreadRegister`（`:2022`）/ `routeCodexThreadUnregister`（`:2041`）；`maker-host/remote-session-routing.ts:25`（`resolveRemoteCodexCredentialMode`，同文件的 `classifyRemoteSessionTransport` 在 `:9`）；`maker-host/mcpr-codex-capability.ts:198-217`（`bindSessionRemoteCodex` / `unbindSessionRemoteCodex`）、`:226-262`；`maker-ipc/register.ts:7145-7205`（ensure → bind → 成功 release 旧 handle / 失败 unbind + 恢复）
  > **锚点更正（2026-09-29）**：原文的 `:2122` / `:2124-2129` / `:2127` / `:2130-2134` / `:2136-2168` /
  > `:2170` / `:1998` / `:2016-2019` 与 `register.ts:7102-7152` 均已过期。`mcpr-codex-capability.ts` 与
  > `remote-session-routing.ts` **本批未被改动**，其锚点未变。
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
- **代码锚点**（**2026-09-29 逐条打开文件复核**；**以符号名为准**）：`maker-host/meka-remote-codex-bundle.ts:13`（`buildMekaRemoteCodexBundle`）；`maker-ipc/register.ts:7145-7205`（远端 bundle 块；普通 SSH 明确抛 `Meka native Skills are not available on legacy SSH sessions`，抛点在 `:7159`；`ensureRemoteCodexCapability` 在 `:7164`、`bindSessionRemoteCodex` 在 `:7169`、失败 `unbindSessionRemoteCodex` 在 `:7197`、成功 `releaseRemoteCodexCapability` 在 `:7199`）；`maker-host/mcpr-codex-capability.ts:118-149`（失败回滚 `bundleRelease`，`:136`）、`:151-165`、`:220-224`
  > **锚点更正（2026-09-29）**：原文的 `register.ts:7102-7132` / `:7106` / `:7107-7110` 已过期。
  > `meka-remote-codex-bundle.ts` 与 `mcpr-codex-capability.ts` **本批未被改动**，其锚点未变。
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
- **代码锚点**（**2026-09-29 逐条打开文件复核**；`orcaWorkerCreationService.ts` 与
  `mcpr-codex-capability.ts` **本批未被改动**，行号不变）：`maker-ipc/orcaWorkerCreationService.ts:1106-1110`（remoteHostId 存在才 ensure）、`:848-877`（无 key 失败；必须 provider `xd`；强制 `providerId = 'xd'`）、`:1084`、`:1175`；`maker-ipc/register.ts` 的 worker 创建接线 —— `resolveMekaWorkerTarget` 构造点 `:11603`、`resolveWorkerTarget` dep `:11647`、remoteHostId/SSH 分类判据 `:11672`、`persistMekaWorkerBinding` `:11686`（原文的 `:7264-7290` 已过期：那里现在是 worktree 快照回填，与 worker 无关）；`maker-host/mcpr-codex-capability.ts:275-316`（`:289-294` 抛 `[REMOTE_CODEX_GATEWAY_KEY_REQUIRED]`）
- **自动化门禁**：`orcaWorkerCreationService.test.ts` 的四条（gateway 路由 / 缺 key 拒绝 / 远端 lead 才 ensure / remoteHostId 继承）
- **实机验证**：Gateway key 有效时 worker 启动、远端 Skill 与协同工具面可用；清空 key 时必须明确报错，**不得静默回落本机 OAuth**

##### WL-4.2.3（已退役：2026-09-29 Meka 最小随包交付）

> **已退役，编号保留为空缺、不得复用。** 本项能力 = 「SAGA2 战斗 Lead 的服务器只读 Worker（第三条独立通路）」，它是 **workflow 机制**的组成部分，已随该机制整体删除。退役原因与同批退役条目一览见 **§8.12**。
>
> - **删除内容**：`meka-projects/combatWorkflowPolicy.ts` 的派发前再授权、`meka-injection/mekaResolvePlan.ts` 的 `prepareCombatFollowupRuntimeContext` 与 `isCombatServerWorker` 分支、战斗独占注入段、`maker-ipc/register.ts` 的对应调用点；`mekaCombatPrompts.ts`（含 `combatServerTargetPrompt` / `COMBAT_SERVER_WORKER_PROMPT`）整文件删除，存活的两个纯函数改名为 `meka-injection/mekaPrompts.ts`。
> - **残留但已无调用方（如实登记，不是仍生效的能力）**：`maker-ipc/mekaWorkerTarget.ts` 的 `resolveUniqueBoundMekaServerTarget` / `MekaCombatServerWorkerTarget`（`:23-79`）、`maker-host/mcpr-codex-capability.ts` 的 `probeRemoteCodexCapability`（`:114`）、`maker-host/mcpr-claude-capability.ts` 的 `probeRemoteClaudeCapability`（`:43`）都还在文件里，但**生产侧零调用方**（`maker-ipc/register.ts` 已无 import 与调用）⇒ 该通路不可达。
> - **复核方式**：`git grep -nE "resolveUniqueBoundMekaServerTarget|probeRemoteCodexCapability|probeRemoteClaudeCapability" -- apps packages scripts`（2026-09-29 只读复核：命中只剩上述定义处与仍把它们当 deps 注入的单测文件，`maker-ipc/register.ts` 零命中）。
> - **不得据此条目执行任何验证**：原文引用的 `mekaRuntimeInjection.test.ts` / `combatWorkflowPolicy.ts` 路径与断言已不存在或已失效（见 §8.12 的测试侧残留）。

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
- **代码锚点（以符号名为准；行号为本轮合并后实测参考值，`authManager.ts` 已多次漂移）**：
  - key 声明：`apps/desktop/src/main/authManager.ts` 的 `const PRODUCT_EDITION_KEY = 'cindy_product_edition_v1'`（约 `:211`）
  - 初值：模块级 `let activeProductEdition: CindyRegion = CURRENT_CINDY_REGION`（约 `:388`）
  - 读持久化：`readPersistedProductEdition()`（定义约 `:1952-1955`；调用点即重启恢复）
  - 重启恢复：`initialize()` 里的 `activeProductEdition = readPersistedProductEdition() ?? CURRENT_CINDY_REGION`（约 `:4677`）
  - 登录成功写：`acceptLoginOutcome` 里的 `writeSafe(PRODUCT_EDITION_KEY, activeProductEdition)`（约 `:5215`）
  - 登出清 + 恢复构建区：`clearAuth()` 的 `removeSafe(PRODUCT_EDITION_KEY)`（约 `:3733`）与紧随其后的 `resetActiveAuthRealmToBuild()`（约 `:3739`，函数体内 `activeProductEdition = CURRENT_CINDY_REGION` 在 `:3643`；另有 `:4617` 的同一 `removeSafe`）
  - realm ↔ edition：`authRealmForEdition`（约 `:5001`）、`selectLoginRealm`（约 `:5035`，同时落 `pendingAuthRealm` 与 `activeProductEdition`）
  - 渲染侧：`apps/desktop/src/renderer/contexts/AuthContext.tsx:73,138,234`
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
- **第三轮同步（2026-09-24）新增同类回归与收口**：上游本轮新增/大改的子系统在 `meka/main` 上**零适配**，
  因而把上游身份字面量当唯一合法值（**测试也写死上游名，自洽通过 ⇒ 只有语义验收能拦**）。已修四处：
  `cindy-make/versionStartup.ts`（身份白名单 + marker 词表 + 默认名，**不修则个人版版本启动/重启整体失效**）、
  `cindy-make/__tests__/personalBuild.test.ts`（上游用例写死 `Cindy-*`/`Cindy.app`）、
  `main/linuxInstallation.ts`（`basename(exe) !== 'Cindy'` ⇒ 用户级安装识别永不命中；**该行 merge-base 已存在，属存量**）、
  `main/index.ts`（钥匙串处置文案指示写上游名）。四处统一为「**从 `brandExecutableName()` 正本派生 +
  上游名仅 legacy 只读闭集**」，并各自补了反例断言与回归守卫实证。逐条见
  [`2026-09-24-origin-main-to-meka-main.md`](../migrations/2026-09-24-origin-main-to-meka-main.md) §6.17。
  **已知未修（存量，用户裁决只登记）**：Linux 用户级安装链路身份不一致——`forge-linux.ts:14` 的 build-info
  executable 仍写死 `Cindy`/`CindyDev`，`resources/linux/install-user.sh:69/:104/:110` 与
  `install-omarchy.sh:61/:69/:194` 要求 `$payload/Cindy`，而打包产物是 `CindyMeka`
  ⇒ **Linux 用户级安装会以 `Incomplete application.` / `Unexpected executable identity.` 失败**。
  `brand-identity-sync` 的镜像断言**未覆盖** `forge-linux.ts` 与这两个脚本，故门禁不报。修复方向见报告 §6.17。

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
- **交叉引用（2026-09-23 第三轮同步裁决，方案 A）**：Windows 热更的
  `apps/desktop/cindy-updater/src-tauri/src/installer.rs` 已**完整接纳上游 `5b10e9babc` 对 #4502 的回退**
  （安装目录身份钉扎、`.updating` 独占锁、High-IL staging ACL 等全部随上游删除），只投影回两项自包含
  Meka 能力。**这不是静默回归**；裁决理由、逐项清单与实测行数见 **§8.11**，同批落点还有
  [`cindy-updater.md`](cindy-updater.md) 与
  [`../migrations/2026-09-24-origin-main-to-meka-main.md`](../migrations/2026-09-24-origin-main-to-meka-main.md) UP-05。
  本条的产物名 / 更新器落点不变量**不受该回退影响**

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
- **2026-09-25 第四轮上游同步新增面：Agent 侧「检查应用更新」入口**。本轮上游引入了给 Agent 用的
  `check_app_update` 工具（`packages/lizi-mcps/src/xdt-helper/app_update.ts` → Host
  `apps/desktop/src/main/mcp-integrations/mcp-providers.ts:418` →
  `apps/desktop/src/main/updateService.ts` 的 `checkAppUpdateForAgent()` /
  `agentUpdateApplyBlockReason()`），即更新检查多了**第二条调用链**。登记要求：
  ① 它必须复用与本项同源的结论码真值（**不得**自造「已经是最新」）；
  ② 其中的 macOS 引导文案必须走 `BRAND_NAME`（Meka 展示名），**不得**写死上游 `Cindy`；
  ③ Linux 的 `installation.region !== CURRENT_CINDY_REGION` 是**构建期 build-region 门**，
     与「区域运行期可选」不冲突。
  规则正文见 [`cindy-updater.md`](cindy-updater.md) 的「Agent 侧的『检查应用更新』入口」一节。
  **验证现状**：随交付门禁跑 `updateService.test.ts` 与 lizi-mcps 相关套件；**未做真机更新验收**（需真实签名与发布渠道）。

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

> **2026-09-29 澄清（本项不变量不变，只澄清一处易混点）**：本批把随包 `resources/meka/skills/**`
> 从 10 个减到 1 个（见 WL-11.17 第 1b 条与 §8.12），那只影响**内置 catalog 的规模**；
> 本项的 **Meka 技能 provenance / 渠道账本 / 市场分发**机制与全部锚点**逐条实测仍在**，
> 因此**本项不退役**。（此前某次规划曾把 WL-8 列为待退役，理由不成立，见 §8.12 第 2 条。）

### WL-9 Meka 插件链（市场渠道 + 开发目录模式）

**保护的不变量**
1. 插件市场按 **surface / channel** 分叉：Meka 面板用自己的 endpoint 与凭证，Meka 渠道
   有**独立账本**；`ignoredRoundStorageKey` 的**旧键形态必须保持**
   （`cindy.pluginUpdates.ignoredRound.<mode>.<owner>`），否则老用户「忽略本轮」被换键丢弃。
2. 「从目录加载（开发模式）」整条链路可用，且派生包的 `ghost.json` 是**作者格式**、
   只改身份字段（`id` + 派生 `command`）。
3. 开发副本占用 `meka-dev-*` 派生 runtime ID，不占正式插件 ID，也不改变正式安装状态。
4. `.cindy` 文件关联与安装渠道归 Meka（`channel: 'meka'`）。
5. Meka 渠道必须上报**真实客户端版本**（`x-cindy-version`）；恒发 `0.0.0` 时协议的
   versionless 判据会让它在 Meka 版本空间里的兼容门**整体失效**（正式 `0.0.x` 包也会被
   当成 dev 占位）。版本兼容下限只在 Meka 自己的版本空间里表达，不借用上游渠道的读取器。
   **边界**：源码仓 / 版本无关打包按设计就是 `0.0.0` 占位（`isVersionlessAppVersion`），
   此时两个渠道都发 `0.0.0` 是预期行为；本条要保证的是发布包（已写入真实版本）不再
   「恒发 `0.0.0`」。

**代码锚点**
- `apps/desktop/src/main/cindy-brain/mekaDevPlugins.ts`（派生包、注册表、watcher、打包）
- `apps/desktop/src/main/cindy-brain/index.ts:6862-7080`（`meka-dev-plugins:*` IPC）
- `apps/desktop/src/main/plugin-market/registerIpc.ts:314,326`（channel 校验）
- `apps/desktop/src/main/plugin-market/clientIdentity.ts`（插件分发身份的**唯一**解析入口：
  `resolvePluginClientIdentity` / `readPluginClientIdentity` / `pluginClientVersionReader`；
  `app.getVersion()` 在本模块之外不再被任何渠道读取）
- `apps/desktop/src/main/plugin-market/registerIpc.ts:56-62`（`mekaService()` 构造点传
  `pluginClientVersionReader('meka')`）与 `apps/desktop/src/main/plugin-market/service.ts:649`
  （上游渠道 `new PluginMarketApi(undefined, pluginClientVersionReader('cindy'))`）同构——
  两个渠道各取自己 edition 的身份，不再各写一份 getter
- `apps/desktop/src/main/plugin-market/api.ts:198-211`（`MekaPluginMarketApi` 的版本读取器是
  **必填**构造参数，见 `:210-211` 的构造签名与 `super(mekaFetcher, identityVersionReader)`；
  "漏传 ⇒ 落到默认 `0.0.0`"这条路径已在结构上不存在；`isConfigured()` 仍覆写为
  `mekaConfigured()`，与版本读取器无关）
- `packages/plugin-protocol/src/manifest.ts:1087-1089,1131`（`0.0.0` = versionless 的协议
  判据，跨端协议只读引用，不在本仓修改）
- `apps/desktop/src/main/updateService.ts:1435`、`apps/desktop/scripts/ci/package-lib.mjs:14`
  （`0.0.0` 是本仓「版本无关构建」的占位哨兵，不是真实版本）
- `apps/desktop/src/renderer/features/plugin/lib/pluginMarketSurface.ts:7,19`
- `apps/desktop/src/renderer/features/plugin/lib/updateAllModel.ts:95-100`
- `apps/desktop/src/main/plugin-market/mekaDownloadPolicy.ts`
- `apps/desktop/src/main/cindy-brain/openFileInstall.ts:29`

**自动化门禁**
- `pnpm --filter desktop exec vitest run src/main/cindy-brain/__tests__/mekaDevPlugins.test.ts`
- `pnpm --filter desktop exec vitest run src/renderer/features/plugin`
- `pnpm --filter desktop exec vitest run src/main/plugin-market`
- `pnpm --filter desktop exec vitest run src/main/plugin-market/__tests__/api.test.ts`
  （Meka 渠道的 `x-cindy-version` 为读取器给的真实版本且不是 `0.0.0`；同一轮里 Cindy 渠道
  仍由自己的读取器决定版本头；Meka `isConfigured()` 仍只认 MCPRouter 绑定）
- `pnpm --filter desktop exec vitest run src/main/plugin-market/__tests__/ipcErrorBoundary.test.ts`
  （源码级守卫：`mekaService()` 构造点必须显式传版本，防「退回无参构造」的静默回归）
- `pnpm --filter desktop exec vitest run src/shared/__tests__/ghost.test.ts src/main/cindy-brain/__tests__/forge.test.ts`

**实机验证**：Meka 插件页登记一个真实源码目录 → 卡片出现且带 `DEV` 角标 → 打开界面/使用
可用 → 自动同步（改源码）生效 → 「打包」产出作者身份的 `.cindy` → 移除后正式插件不受影响。
Meka 市场与 Cindy 市场的列表/凭证/忽略本轮互不串台；Meka 渠道请求头 `x-cindy-version`
是当前客户端真实版本（抓包或服务端日志确认，不是 `0.0.0`）。

**本轮同步对 WL-9 四类契约的复核（2026-09-23 第三轮同步，逐条实查）**：
1. **批准状态 schema 未动**：`RECEIPT_SCHEMA_VERSION` 仍为 **2**（上游本轮未改）；
2. **内容指纹格式未动**：`cindy-ghost-content-v2` 未被改写；
3. **安装布局 / 包格式未动**：尺寸常量数值不变；
4. **`validateGhostManifest` 只被放宽**：本轮删掉了「未知字段 / 未知能力类目即拒装」这条口径
   （`apps/desktop/src/shared/ghost.ts:3803` 起的 `validateGhostManifest`；`panel.systemButtons`
   的「只认白名单键，未知键即拒」分支被移除，未知键改由 `unknownDeclarationFields` 保留为声明数据）。
   实测 `git diff 0f65d9823 origin/main -- apps/desktop/src/shared/ghost.ts`：**删除 13 处 `ok: false`
   拒绝点、新增 0 处** ⇒ net 放宽，不存在「老包被新判据拒装」的兼容风险。
   按 `plugin-security-and-authoring.md` 的存量兼容红线，这是**允许**方向；但**放宽即为插件基座改动**，
   仍需白名单放行门（需 Approve）。
5. **上游 `b8b90eb536`（`feat(plugins): add remote authorization and private setup cards (#4813)`）
   新增了插件基座新面**：remote 私有 setup 卡 / 设备码 / 私有连接提交 —— 落点为
   `apps/desktop/src/main/plugin-oauth/*`（`deviceCard.ts`、`deviceCodeSessions.ts`、
   `deviceCodeClipboard.ts`、`authorizationAdapters.ts` 等）、
   `cindy-brain/ghostSetupConnectionExecutor.ts`（`executeGhostSetupConnectionSubmission`）与
   `cindy-brain/index.ts:5301` 的 `bindGhostSetupConnectionAction`（注入点 `maker-ipc/register.ts:2655`
   的 `bindConnection`）、以及 `GhostNodeRuntimeBroker` 的新回调。
   它属**插件基座新面**（不是 Meka 能力，也不与 Meka 渠道冲突），按 §7 走「上游共有能力」，
   但**仍须走白名单放行门（需 Approve）**后才能合并——登记在案以免被当成「纯上游技术改动」豁免。

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
  `profilePrecedesVisibilityInitialization` + `needsMekaSeed`）：对「**这份配置从来没写过
  初始化记录**」（判据 `stored === null`）的既有配置写一次性标记，并把升级那一刻的目录基线
  冻结进 `initialization.defaults`，随后重新镜像整表。它的定位是**基线留痕 + 已初始化判定输入**
  （记录该配置升级时看到过什么、供诊断与采纳合并），**不决定可见性**，也不覆盖显式 override。
  > **命中条件已收窄（2026-09-24 第三轮同步）**：原判据还把「**已经存在但 `defaults` 为空的
  > 记录**」算作命中，于是补种会把外部写下的 `eligibleForDefaults: false` 提升为 `true`，
  > 被上游本轮新增的 `modelVisibilityPrefs.test.ts`「外部修好损坏 initialization 后，同一生命周期内
  > 重新加载可恢复目录」拦截。现在**已有记录一律权威、不被补种改写**；「无记录」这一支逐字不变。
  > 安全性依据：可见性恒为 `override ?? defaultEnabled`、**不读 `defaults`**（见下条），
  > 故该支补种无承重作用，上一轮 P0 形态不回归。详见
  > `docs/migrations/2026-09-24-origin-main-to-meka-main.md` §6.16 第 3 条。
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
> **2026-09-29 修正（Meka 最小随包交付）**：「资源树随包发布」**仍然成立，但内容已最小化**：
> `resources/meka` = `README.md` + `projects/saga2/project.json` +
> `skills/通用/platform/platform-capabilities/SKILL.md`（**`roles/` 为空、不再随包任何内置角色清单**，
> 也不再随包战斗提示词正文与另外 9 份 SKILL.md）。项目的 `basic` 身份与 `metadata` 扫描清单、
> 以及 `roleDefaults.mcp` / `roleDefaults.projectMetadataSelection` **保留在随包 project.json 里**。
> 逐条见 **§8.12**。

**代码锚点**
- `apps/desktop/drizzle/scripts/0082_meka_product_schema.ts:68-96`（建 `meka_projects` /
  `meka_roles` 与 `sessions` 的 `meka_project_id` / `meka_role_id` / `is_formal` /
  `formal_*` 列及索引）、`apps/desktop/drizzle/scripts/0088_bridge_meka_0_0_11_lineage.ts:286-366`（0.0.11 谱系桥接）
- `apps/desktop/src/main/localDb/schema.ts:103`（`workspace_kind` 枚举含 `'meka'`）、`localDb/mapper.ts` 的 `sessionCreateToRow`（`workspaceKind === 'meka'` 时才落 meka 身份：判据 `:407-412`、`mekaRole` 遗留分支 `:420-426`；函数体约 `:367-473`）
- `apps/desktop/src/main/localDb/ipc/mekaProjects.ts`、`mekaRoles.ts`、`mekaProjectMetadata.ts`
- 配置不可用项目的**状态投影与恢复入口**（WL-11.9；**2026-09-29 重核锚点**）：`apps/desktop/src/shared/meka-projects.ts`
  （`MekaProject.configUnavailable` 在 `:348`、`mekaProjectRegistrationName` 在 `:616`）、
  `apps/desktop/src/main/localDb/ipc/mekaProjects.ts`（`toProject` 的 `configUnavailable: file === null` 置位在 `:251`、`fallbackForRow` 的 `configUnavailable: true` 置位在 `:280`、`fallbackForRow` 本体在 `:288`，调用点 `:329` / `:346` / `:403`）、
  `apps/desktop/src/renderer/features/cc-agent/MekaProjectRoleEditorRoute.tsx`
  （`projectCardSubtitle`、项目卡片「配置不可用」标识、失败分支的「移除项目注册」）
- `apps/desktop/src/main/localDb/ipc/mekaFormal.ts:9-12`（`meka-formal:*` 四个 channel）
- `apps/desktop/src/main/localDb/ipc/mekaSkillCatalog.ts:5`
- `apps/desktop/src/shared/meka-formal.ts`、`apps/desktop/src/shared/meka-projects.ts`
- `apps/desktop/src/main/meka-projects/`（`projectConfig.ts:451`、`resourcePaths.ts:21`）
- `apps/desktop/src/main/localDb/ipc/sessions.ts:1287,1317,1725`
- 项目/角色**绑定链**（WL-11.1–11.3）：`apps/desktop/src/renderer/features/cc-agent/CCAgentSidebarUpper.tsx:2404-2416`（项目入口 → `makeNewMakerRouteState('meka')` + `mekaProjectId`）、`apps/desktop/src/renderer/features/cc-agent/NewMakerDraftRoute.tsx:868-887`（`mekaSelection` 的 `useState` 初值）与 `:893-918`（依赖 `[routeMekaDraft.mekaProjectId, routeMekaDraft.mekaRoleId]` 的同步 effect）；两处默认角色都 = `roles.find(routeMekaDraft.mekaRoleId) ?? pickDefaultMekaRole(roles)`，即显式优先共享默认角色 `<projectId>-default-role`（见 `shared/meka-projects.ts` 的 `pickDefaultMekaRole`）、`:579-699`（角色选择器 `MekaRolePicker`）、`:4532-4533`（发送时写入 project/role）
- 角色**运行期注入链**（WL-11.5–11.6，锚点为 2026-09-29 Meka 最小随包交付后逐条复核的快照；**以符号名为准**）：`apps/desktop/src/main/meka-injection/mekaResolvePlan.ts` 的
  `resolveBootstrapInjection`（约 `:240-400`：hydrate 持久绑定 → 非 meka 零写入 → 遗留角色回填到
  `mekaDefaultRoleId(projectId)`（约 `:298-301`）→ 强制「项目+角色都必须有」（约 `:302-304`））、
  `resolveFrozenInjection`（约 `:195-232`，resume 短路；分派在约 `:418-425`）、
  `mergePlatformSkills`（`:170-177`）与 `mergePlatformMcp`（`:179-184`，调用点约 `:333-334`）、
  技能快照物化（约 `:351`）+ `nativeSkillMount`（`:156-162`）+ `meka-injection/mekaApplyPlan.ts` 的
  `writeNativeSkill`（`:92-96`，写 `nativeSkillPluginPath` / `nativeSkillRevision`）、三段注入
  （角色 prompt 约 `:353-356`、order 65 约 `:357-362`、`roleContextPrompt` 约 `:363`）+
  `meka-injection/mekaPrompts.ts` 的 `roleContextPrompt`（`:23-32`，`[MEKA_ROLE_CONTEXT]` 区块）+
  `meka-injection/mekaApplyPlan.ts` 的 `renderMekaPromptSegments`（`:51-75`，按 order 渲染上提）、
  `vendorOptions` patch（`mekaResolvePlan.ts` 约 `:365-380`：`source` / `mekaRuntimeResolved` /
  `mekaProjectId` / `mekaRoleId` / `mekaMcpProviderIds` / `mekaMcpInlineConfigs` /
  `mekaPolicyProviderRefs`）+ `mekaApplyPlan.ts`（`:84-87` 写入）
  > **锚点更正（2026-09-29 Meka 最小随包交付，逐条打开文件复核）**：本行原先的
  > `mekaCombatPrompts.ts:309-318` / `:152-161` 与「`mekaWorkflow` 进 `vendorOptions` patch」都已随
  > **workflow 机制**与**内置提示词正文**的删除而消失；`mekaCombatPrompts.ts` 已**改名为
  > `mekaPrompts.ts`**（只剩 `roleContextPrompt` 与 `mekaProjectReferencesPrompt` 两个纯函数，
  > 全文件 73 行）。段集合现为 **3 段**（60 `meka.role-context` / 65 `meka.project-references` /
  > 70 `meka.role-prompt`，见 `mekaInjectionTypes.ts` 的 `MEKA_PROMPT_SEGMENT_ORDER`，`:68-72`），
  > `MekaRuntimeConfig` 上**没有** `workflow` 字段。**`codexNativeSubagentsDisabled` 也不再由本层产出**
  > （原判据 `runtime.workflow === 'saga2-combat-development-v1' || isCombatServerWorker` 两个判据都已删除；
  > 键位与理由写在 `mekaResolvePlan.ts` 约 `:373-379` 的注释里，生产者交还宿主策略）。
- 角色清单**事实源（2026-09-29 起）**：随包 `resources/meka/roles/` **已空**（不再随附任何内置角色清单，
  git 不跟踪空目录 ⇒ 新 clone 下该目录不存在，由 T3 容错兜住，见 WL-21）；实际来源按优先级为
  ① 项目文件 `<project-root>/.meka/project.json` 的 `builtinRoles` 角色快照（用户可编辑/可导入）、
  ② `userData/meka-roles/<id>.json`（自定义角色）、③ 内存函数 `mekaDefaultRoleManifest(projectId)`
  （共享默认角色，从不落盘）。**已删除**的 `resources/meka/roles/combat-development.json` 与
  `roles/prompts/*.md`（5 份）不再是事实源；孤儿内置角色行的读时回落见 **WL-20**。
- **请求范围 / 战斗段 / 表范围门禁的注入链（WL-11.11–11.14）已整体退役**（2026-09-29 Meka 最小随包交付）：
  原文所列的 `meka-injection/mekaCombatPrompts.ts`（`classifyCombatRequestScope` /
  `isCombatScopeAffirmation` / `combatRequestScopeApprovalPatch` / `combatSkillIdVendorPatchFromUserPrompt` /
  `combatScopePrompt` / `combatTargetPrompt` / `resolveCombatProjectRefPaths` / `combatProjectPathsPrompt` /
  `COMBAT_READ_ONLY_UNITY_PIPELINE_COMMANDS` / 标注模式负向先行）、
  `meka-injection/mekaResolvePlan.ts` 的 `combatProjectReferencePatch` / A2 guard /
  `prepareCombatFollowupRuntimeContext`，以及 `meka-projects/combatWorkflowPolicy.ts` 的
  A3 会话级镜像、`CombatVendorOptions`、表范围目标门禁、精确路径放行、`recordCombatScopeSkillIds`（A4）、
  证据依据与只读 Unity 查询判据 —— **全部随三个文件（`combatWorkflowPolicy.ts` /
  `combatEnvironmentGate.ts` / `combatServerCapabilityState.ts`）的删除而消失**。
  逐条退役说明见 **§8.12**；`mekaCombatPrompts.ts` 的存活部分改名为
  `meka-injection/mekaPrompts.ts`。**保留的 order 65 段**（`meka.project-references`）不是战斗能力，
  它的现行锚点见 **WL-11.17**。
- **原「冻结技能与角色契约」已随 bundled skill 清理删除**（2026-09-29）：`resources/meka/skills/程序/unity/combat-skill-configuration/SKILL.md`、
  `resources/meka/skills/程序/unity/saga2-entry-model/SKILL.md` 等 9 份 SKILL.md 全部删除，随包
  `resources/meka/skills/**` 只剩 `通用/platform/platform-capabilities/SKILL.md`（36 行 / ~1,349 字符）。
  因此「导入/导出回执字段」「只读通道与插件侧 9 项白名单」「`table-scope` 不逐目标派发」这些契约
  **不再有随包正文载体**；跨仓的 meka-unity / meka-p4 插件白名单仍在（见下方「插件侧（跨仓，不在本仓）」）。
- Pi 空回合兜底（WL-11.15）：`packages/maker-core/src/agents/pi/translator.ts:1034-1081`
  （`silentStop` 判定 `:1054-1059`、`done.data` 附加 `:1081`；Host Stop 锁存 `hostStopSeenGeneration`
  与 `isCurrentTurnHostStopSeen` 在 `:275-327`）；
  `apps/desktop/src/main/agent-island/state.ts`（`AGENT_ISLAND_SILENT_STOP_HOLD_MS = 10_000` 在 `:86`；
  进入挂起 `holdSilentStopForResume` 约 `:1572-1579`、到期补回 `expireSilentStopHolds` 的判定约 `:1615-1623`；
  两个 producer 入口：`status` 分支约 `:702-705`、`done` 分支约 `:794-797`；单调锚点
  `silentStopHoldMonoUntil` 字段与说明约 `:178-185`）与
  `packages/maker-core/src/agents/claude-code/translator.ts:2394-2395`（把同一标记挂到配对的
  turn-end `status` 上，使判定与事件顺序无关）；
  `apps/desktop/src/main/maker-ipc/silentStopAutoResume.ts`、`register.ts` 的
  `handleSilentStopTurnEnd`（约 `:4522` 起）、`settleSilentStopDone`（`:4443`）、
  `surfaceSilentStopExhaustedBanner`（`:4483`）、guard 实例化（`:1274`）、
  `renderer/components/chat/errorReasonI18n.ts:20`
  > **锚点更正（2026-09-29，`register.ts` 行号随本批删除整体漂移）**：原文的
  > `register.ts:4298-4460` 已失效，上列是复核后的当前值。`translator.ts` / `agent-island/state.ts` /
  > `silentStopAutoResume.ts` / `errorReasonI18n.ts` 本批未被改动，锚点不动。
- 插件侧（跨仓，不在本仓）：`C:\Workspace\cindy-meka-plugins\meka-unity\node\worker.cjs:49-59`
  （9 项只读命令白名单，拒绝码 `INSPECT_COMMAND_NOT_READ_ONLY` 在 `:154`）、`meka-unity/ghost.json`
  （`unity_inspect.action` 含 `command`，版本 **1.0.20**）、`meka-p4/ghost.json:34-57`
  （只读 `p4_opened` / `p4_fileinfo`；写入面含 `p4_checkout:120`、`p4_add:132`、`p4_submit:84`，
  版本 **1.0.63**）
- **原「表范围审批的第二个来源：`ask_user_question` 卡片答案」（WL-11.11 的一部分）已随 workflow 机制删除**
  （2026-09-29）：原文所列的 `mekaCombatPrompts.ts` 判据（`isCombatScopeAnswerApproval` /
  `combatRequestScopeAnswerApprovalPatch` / `combatScopeApprovedVendorPatch`）与
  `register.ts` 的交互 resolve 消费点都在删除范围内。逐条退役说明见 **§8.12**。**不得据此条目执行任何验证。**

**自动化门禁**
- `pnpm --filter desktop run db:validate`（meka 表与列存在、`0000..0107` 完整、journal/snapshot
  对齐、无 schema drift、companion CJS、历史身份冻结）
- `pnpm test:db`（db tier 整体仍不在 CI 执行；**但 `builtinMekaSeed.test.ts` 是例外**：
  `.github/workflows/ci.yml` 的两处「Run companion database regressions」步骤（linux shard 1 /
  windows shard 1 各一处）已把它写进硬编码路径清单 ⇒ **CI 会执行它**。本地要单独复现该文件，
  仍是显式跑 `pnpm test:db` 或直接 `vitest run <该文件>`。详见 WL-11.10「tier 提醒」与迁移总账
  §11.26 / §11.27 的验证现状）
- `pnpm --filter desktop exec vitest run src/main/meka-projects src/main/localDb/__tests__/mekaWorkspace.test.ts`
- `pnpm --filter desktop exec vitest run src/main/localDb/__tests__/mapperMekaFormal.test.ts src/main/localDb/__tests__/builtinMekaSeed.test.ts`
- `pnpm --filter desktop exec vitest run src/main/__tests__/forgeMekaResources.test.ts`
- `pnpm --filter desktop exec vitest run src/main/localDb/__tests__/meka0011MigrationLineageBridge.test.ts`
- 配置不可用项目的投影与移除入口（WL-11.9）：
  `pnpm --filter desktop exec vitest run src/main/meka-projects/__tests__/mekaProjectsImport.test.ts src/renderer/features/cc-agent/__tests__/MekaProjectRoleEditorRoute.test.tsx`
  （断言 `configUnavailable` 的两种置位路径与列表标记、失败页「移除项目注册」可达、内置项目
  不提供移除、新建项目的注册名不落生成 id）
- **原「两请求类 / 表范围门禁 / 项目参考路径白名单（WL-11.11–WL-11.14）」的门禁已作废**（2026-09-29）：
  `combatWorkflowPolicy.test.ts` / `combatServerCapabilityState.test.ts` / `combatEnvironmentGate.test.ts`
  对应的**被测模块已删除**，因此这三条命令（连同下面那组计数与注释）**不得再执行、不得据其结论**；
  退役说明见 **§8.12**。项目参考投递的现行门禁见 **WL-11.17**，Pi 注入基线见 **WL-16**。
  > **测试侧残留（未修，属他人工作项）**：上述三个被测模块的**测试文件仍在仓内**
  > （`src/main/meka-projects/__tests__/combatWorkflowPolicy.test.ts`、
  > `combatServerCapabilityState.test.ts`、`combatEnvironmentGate.test.ts`），会因 import 已删除模块而
  > **必然失败/无法收集**；`mekaRuntimeInjection.test.ts` / `mekaRuntimeInjectionBaseline.test.ts` 里
  > 仍有 `probeRemoteCodexCapability` / `probeRemoteClaudeCapability` / `codexNativeSubagentsDisabled`
  > 等**已不存在于注入层 deps / 输出契约**的字段，`builtinMekaSeed.test.ts` 仍 import 已删除的
  > `resources/meka/roles/combat-development.json`。这些都需要在交付时一并清理（见 §8.12 第 4 条），
  > 本清单**未代为修改任何测试**。
- Pi 空回合与网关发现（WL-11.15）：
  `pnpm --filter @cindy/maker-core exec vitest run src/agents/pi/__tests__/pi-translator.test.ts src/agents/pi/__tests__/pi-mcp-client.test.ts src/agents/pi/__tests__/cindyBridgeSource.test.ts`
  （断言 cancelled + 空正文 + 非 Host abort 才附 `silentStop`、未披露错误自带 schema、
  未知 server 优先于 per-tool 且点明插件不是 MCP 服务器）
- **人工实机验收命令（不属自动化门禁）**：`pnpm desktop:session-smoke`（CDP 真实鼠标事件 +
  真实模型轮次，覆盖 WL-11.1–WL-11.8，见下）。**它没有任何自动化执行**：根 `package.json` 只有
  `desktop:session-smoke` 别名，`apps/desktop/package.json`、`.github/workflows/**`、
  `scripts/__tests__/**`、`test-workspaces*.mjs`、`test-related.mjs` 里**零引用**
  ⇒ 它**不是**本节「最小自动化集合」的一员，只能由人手动跑。

**实机验证**（已自动化，2026-09-14 实跑 9/9 PASS）

> **待重跑（2026-09-22）**：项目/角色编辑改为“有变更才出现保存/取消”，并新增共享默认角色，
> 因此下表 **WL-11.1 / WL-11.2 / WL-11.6 / WL-11.8** 的期望值与断言口径已按新契约更新，
> 但**尚未重新实跑**取得新证据；下表的 2026-09-14 证据行保留为改动前的事实。
> 重跑需要**两条命令**：
> - `pnpm desktop:session-smoke` —— WL-11.1/11.2/11.8 的新期望值；
> - `pnpm desktop:session-smoke -- --role 默认角色` —— 只有指定该角色才会命中 WL-11.6 的
>   默认角色反向断言（默认路径落到「通用开发」，该分支不执行；见脚本 `defaultRoleOf` 说明）。
>
> **2026-09-23 修正（脚本已重写，此段是当日事实）**：`scripts/meka-session-smoke.mjs` 的**默认路径
> 已改为用共享默认角色建会话** ⇒ 第一条命令现在**就**命中 WL-11.6 的默认角色契约，第二条命令不再是
> 必要条件；`--role <角色 id 或显示名>` 仍可用于指定其它角色（如 `combat-development`）。上面两条
> 命令在本批**依然都没跑**（见下）。
>
> 另需目检：默认角色面板只读且无保存/取消按钮、未编辑的项目/角色页无保存/取消按钮。
> 详见迁移总账 §6.50。
>
> **第二次更新（2026-09-23，仍未实跑）**：默认角色由「零注入」改为「出厂全量 + 渐进披露」、
> 「通用开发」退役（其会话重绑到 `<projectId>-default-role`、选项数从 3 降到 2），并新增
> order 65 段。本次据此**第三次**调整 WL-11.1 / WL-11.2 / WL-11.6 / WL-11.8 的期望值：
> WL-11.1 / WL-11.8 的**选中值不变**（仍是「默认角色」），变的是 WL-11.2 的选项数与 WL-11.6 的
> **反向断言口径**（见下表）。`scripts/meka-session-smoke.mjs` 已按新契约更新（含 WL-11.6 的新口径
> 与 WL-11.17 的两行检查），但**上述两条命令在本批依然没有跑**（本批未执行任何门禁，见 §8.5），
> 因此这里的新期望全部标注「待实跑」。
>
> **第三次更新（2026-09-23 同日后半段行为变更，仍未实跑）**：默认角色新增第三个开关
> **`includeAllBundledSkills`（内置 catalog 全量）**、**恢复 `meka-design` MCP**；`read-manifest`
> 对带开关的角色改为返回**展开后的有效清单**；F1 容错边界（全量展开项 warn+跳过、显式选择仍
> fail-closed）、F2 重绑守卫、F3 战斗角色仍内联、F5 `scope` 校验一并落地。这些**都会改变 WL-11.6
> 该看到的角色级技能／MCP 集合**（catalog 全量 ⇒ 角色级技能数进一步上升、`mcpProviderIds` 会重新
> 出现 `meka-design`），且**默认路径的会话仍以默认角色建立**。
>
> **第四次更新（2026-09-23 第二批，口径已定，仍未实跑）——以下为确定表述，取代上文「待实跑，
> 且可能需要第四次更新」这类含糊说法**：`scripts/meka-session-smoke.mjs`**已按新契约重写**
> （含 order 65 段检查与 WL-11.6 的**新正向口径**），**但未同步 `includeAllBundledSkills` 与
> `meka-design` 这两项期望**（它们**只由 unit 层断言覆盖**，smoke 的期望值里没有它们），
> **且本次未实跑 smoke**（`pnpm desktop:session-smoke` 与 `-- --role 默认角色` 两条都没跑）。
> ⇒ 本表与 WL-11.6 的现行期望按「**脚本已重写、未实跑、且有两个已知未被 smoke 覆盖的项**」读，
> **不得**当作已核对，**也**不要再用「可能需要第四次更新」这种无法判定的措辞。
>
> **（2026-09-23 第二批追加）`--dry-run` 不是安全空跑**：脚本只给 6 处检查加了 `dryRun` 守卫，
> `WL-3.2` / `WL-11.1` / `WL-11.2` / `WL-11.8` **四处没有守卫**，会派发**真实 CDP 鼠标事件并改 hash**；
> §5 里原先「用 `--dry-run` 可只跑前 3 项草稿断言而不建会话」的说法**已按此更正**。
> 另如实注明：**本次交付过程中曾执行过一次 `--dry-run`，按上述事实它并非纯只读**。
> **⚠️ W25 批次更正（2026-09-23，只追加不改原句）**：`WL-3.2` / `WL-11.1` / `WL-11.2` /
> `WL-11.8` **四处现已补上 `dryRun` 守卫**，dry-run 下返回 **`unverified`**（证据串以
> 「`--dry-run：未执行`」开头），**不再伪造 PASS**。⇒ 把 `--dry-run` 说成「只读预览 / 安全空跑」
> **现在成立**，但必须写清：dry-run 下**真正执行的只剩只读检查**（`WL-11.17/退役重绑`：只读库与
> 清单），上述四项是 **UNVERIFIED**。缺口与详情见 §8.8。
>
> **⚠️ 2026-09-29（Meka 最小随包交付；脚本未改，口径必须先对齐）**：`scripts/meka-session-smoke.mjs`
> 里仍硬编码**战斗角色**：`COMBAT_ROLE_ID = 'combat-development'`（脚本 `:415`；其上方 `:409` 的注释
> 还在引用已删除的 `BUILTIN_MEKA_ROLES`）、退役左值表 `RETIRED_BUILTIN_ROLE_IDS`（`:422-429`，含
> `combat-config` / `combat-debug`，而它们当年的重绑目标 `combat-development` 已**没有随包清单**）、
> `combatRoleOf()`（`:448-450`）、项目内置阵容期望（`:875-888`）与「切到战斗角色」的目标选择（`:901-903`）。
> ⇒ **`pnpm desktop:session-smoke -- --role 战斗开发`（或任何落到该角色的分支）现在会自报失败**：
> `declaredRoleSkills()`（`:573-586`）读 `<repo>/apps/desktop/resources/meka/roles/combat-development.json`
> 得到 `null`，而该角色不是共享默认角色 ⇒ WL-11.6 检查 push
> `未找到角色清单 apps/desktop/resources/meka/roles/combat-development.json`（`:1041` + `:1057-1058`）并 FAIL。
> 另有一处**假通过**：`config.workflow` 已不在 main 日志的运行期块里（`:559` 的 `pick('workflow')`
> 取不到 ⇒ 返回 `null`），因此「默认角色绝不带 workflow」这条断言断言的是一个**已不存在的字段**。
> **`scripts/**` 不属本清单的编辑范围**，登记为**待改**（见 §8.12 第 4 条第 7 项）：战斗角色分支应
> **按 `defaultRoleOf()` 重指到共享默认角色**，并删掉 `COMBAT_ROLE_ID` / `combatRoleOf()` /
> 阵容期望里的战斗项，把 workflow 断言改成「运行期配置里**不存在** workflow 字段」。
> **脚本改完并实跑之前，WL-11.1–11.8 一律不得记为通过。**

`pnpm desktop:session-smoke` 用真实鼠标事件从侧栏项目入口建草稿、切角色、发消息，并交叉核对
运行期件（库行 / main 日志 / 技能快照），逐项结论：

| 检查 | 断言的不变量 | 实跑证据 |
| --- | --- | --- |
| WL-11.1 | 真实重挂载后，草稿绑定该项目并默认选中该项目的共享默认角色（`<projectId>-default-role`，由 `pickDefaultMekaRole()` 显式指定，不再只靠 `roles[0]` 排序） | 改动前：`项目=SAGA2 默认角色=通用开发`；**第二次更新（2026-09-23）期望不变：`项目=SAGA2 默认角色=默认角色`（待实跑）** |
| WL-11.2 | 角色选择器列出该项目全部角色，切换后草稿角色随之变化 | 改动前：选项 2 个（通用开发/战斗开发）；**第三次更新（2026-09-29）期望改为：选项与库里角色一一对应、共享默认角色（`<projectId>-default-role`）排第一；随包内置阵容 = 该项目共享默认角色（`saga2-default-role`）**——「通用开发」于 2026-09-23 退役，「战斗开发」的业务清单于 2026-09-29 移出随包（其 DB 行作为孤儿保留，见 WL-20/T2），故**不再是随包内置角色**（**待实跑**） |
| WL-11.3 | 会话行绑定 project/role、工作目录解析为存在的绝对路径、`is_formal=0` | `workspace_kind=meka project=saga2 role=combat-development is_formal=0 workdir=C:/Workspace/saga2/saga2_project` |
| WL-11.4 | Agent 真实跑完一轮并产出回复 | `回复="收到"` |
| WL-11.5 | 角色上下文注入运行期（由运行中会话回显字段行证明；身份判定锚在 `projectId`/`roleId`，`displayName` 可能被模型按输出语言改写，见 §6） | `projectId=saga2 roleId=combat-development displayName="战斗开发"`（该次逐字复述；另一次实测被改写为 `Combat Development`，仍判通过） |
| WL-11.6 | 运行期按角色解析**角色级 MCP / 技能快照含角色声明的技能**（**workflow 已随机制删除：`MekaRuntimeConfig` 上没有该字段，运行期不再解析它**，见 §8.12）；**默认角色正向断言**（2026-09-23 重写口径，smoke 默认路径即命中）：**默认角色确实贡献角色级技能与项目元数据**——`skillsCount > platformSkillsCount`、MCP 集合 ⊇ 平台基线（`mcp-router`）**且** ⊇ 项目 `roleDefaults` 的 provider、快照技能 ⊇ 项目默认技能且总数 > 平台基线（旧口径「`skillsCount === platformSkillsCount`、平台基线外 MCP 为空、快照技能数 === platformSkillsCount」**已作废**，它断言的是「刻意零注入」）；**并断言会话 system 前缀里出现 `[MEKA_PROJECT_REFERENCES]`（order 65）且不含任何 `agents-md` / `rule` 正文**（该项目没有有效规范类元数据时该段不出现——空集合不渲染，这一支另行处理）。**不得**断言 mcp/skills 为空或无快照——Host 平台基线对每个普通 Meka 任务都存在。**⚠️ 本条的战斗角色分支与 workflow 断言已失效，脚本待改，见上文 2026-09-29 块与 §8.12 第 4 条第 7 项** | `workflow=saga2-combat-development-v1 mcp=mcp-router,project-agent skillsCount=2 快照技能=combat-skill-configuration,platform-capabilities`（**2026-09-14 历史证据**；其中 `workflow` 字段与 `combat-skill-configuration` 技能随本次交付消失）。**2026-09-29 起：随包 saga2 基线的 `roleDefaults.mcp` 已清空**（它此前贡献的 `project-agent` 只是 `mcp-router` 的冗余别名，见 `meka-capability-layers.md` §3）⇒ **干净机器上默认角色的 MCP 集合应为 `mcp-router,meka-design`**；本机因项目根 override 仍声明该别名，实跑仍会显示三个 —— 两者都对，差别在 override 而不在基线。 |
| WL-11.7 | 新会话在 Meka 分区该项目容器内，且不在普通「对话」分组内 | `会话在项目「SAGA2」容器内；普通对话分组排除=已核对` |
| WL-11.8 | 同一项目内再次点击新建入口时保留当前草稿已选角色（现行行为，裁决见 §8.2 第 6 条） | 改动前：`fresh 默认=「通用开发」；切到「战斗开发」后同项目重进仍为「战斗开发」`；**第二次更新（2026-09-23）期望不变：`fresh 默认=「默认角色」…`（待实跑）** |

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
>
> **就地更正（2026-09-29，不改写上表原值）**：上表是 2026-09-14 的实测快照，其中两个角色
> （`general-development` / `combat-development`）与 `project-agent` 声明**均已不在随包**。
> 上表对照力仍在（「角色级 MCP 按角色取并集」这条不变），但**数值不可当作现行期望**：
> `project-agent` 只是 `mcp-router` 的兼容别名，已从随包基线移除；`workflow` 行整行作废。
> 现行期望以 WL-11.6 行为准。
>
> **时效（2026-09-23）**：上表是 **2026-09-14** 的实测快照，左列的对照角色
> `general-development`（通用开发）**已退役**（行与会话重绑到 `<projectId>-default-role`，
> 包内清单文件已删除），因此这份对照**不可复现、必须重跑**。重跑时左列换成
> `combat-development` 之外的一个**项目自有角色**（或直接用默认角色做「出厂全量」一侧的对照），
> 且默认角色一侧的新期望见 WL-11.6（不再等于平台基线）。上表的 `mcpProviderIds` / 技能数 /
> revision 数字**保留为历史事实，不改写**。
>
> **时效补充（2026-09-29）**：上表的**「运行期 `workflow`」这一行已不可复现** —— `workflow` 字段与
> 整个 workflow 机制（含 `saga2-combat-development-v1`）已删除，右列 `combat-development` 的随包清单
> 也已删除；该行只作历史记录。同批删除的还有它引用的冻结技能（`combat-skill-configuration` /
> `saga2-entry-model`）与另外 7 份随包 SKILL.md。见 §8.12。

> **WL-11.6 的旧反向断言原句（逐字取自 `git show HEAD` 的 WL-11.6 行，已被本批反转，保留备查）**：
> 原文写的是 ——「运行期按角色解析 workflow / 角色级 MCP / 技能快照含角色声明的技能；
> **默认角色反向断言**（仅 `--role 默认角色` 时命中）：`workflow=null`、**`skillsCount ===
> platformSkillsCount`**、**MCP 集合除平台基线（`mcp-router`）外为空**、**快照技能数 ===
> `platformSkillsCount`**。**不得**断言 mcp/skills 为空或无快照——Host 平台基线对每个普通 Meka
> 任务都存在」。
> **这三条等式断言已全部作废**（本节 WL-11.6 现行口径改为**正向**断言：`skillsCount >
> platformSkillsCount`、MCP 集合 ⊇ 平台基线 **且** ⊇ 项目 `roleDefaults` 的 provider、快照技能 ⊇
> 项目默认技能且总数 > 平台基线）。**作废原因**：它们断言的是默认角色「**刻意零注入**」时代的
> 「总集合恰等于平台基线」，而默认角色已改为**出厂全量** ⇒ 等式必然不再成立。
> **此处只保留原句备查**，不改写其所属条目与日期。

> **WL-11.10 的原口径（逐字取自 `git show HEAD` 的 WL-11.10，已被本批反转，保留备查）**：
> 原文第 3 条 bullet 写的是 ——「每个项目的共享默认角色（`<projectId>-default-role`）必须**内置、
> 只读、不可删除**：`meka-role:update` 返回 `MEKA_BUILTIN_READ_ONLY`，渲染侧全部字段 `disabled`
> 且不出现保存按钮。**它不得注入提示词／规则／技能／MCP／项目元数据，也不得 opt-in 项目
> `roleDefaults`；在同一份带 `roleDefaults` 的项目配置下，默认角色解析出的 `promptText` 为空、
> 技能与 MCP 为空，而 `general-development` 仍读到项目默认规则（反向对照，防空跑）。**」
> 原文第 5 条 bullet（自动化锚点）里另有一句「默认角色只读契约：**读清单走内存**、update 抛
> `MEKA_BUILTIN_READ_ONLY`、delete 按内置角色拒绝」，以及「**未自动化**：默认角色的 Light/Dark
> 实机目检与升级库首次启动」。
> **这四处旧口径（零注入、不得 opt-in `roleDefaults`、`promptText` 为空、读清单走内存）已全部
> 反转**；**反转原因**是默认角色改为承接已退役「通用开发」的职能（出厂全量），且面板必须显示
> **展开后的有效清单**（`read-manifest` 从「返回内存 manifest」反转为**配置 IO 路径**，见
> WL-11.10 第 3 条与迁移总账 §11.27 W10/F4）。**本节正文已按新契约重写，此处只保留原口径备查**，
> 不改写任何历史日期条目的日期与结论。

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

**WL-11.10 项目/角色编辑的「有变更才出现保存/取消」与共享默认角色**（不变量，2026-09-22 登记；
**注入部分 2026-09-23 反转重写**；**落盘侧「只留开关、不枚举 id」2026-09-23 追加，见第 7 条**）：

- **保护的不变量**：
  1. 项目详情与角色详情在草稿相对上次读取／保存的有效值**没有变更**时，**不得**渲染“保存”或
     “取消”；有变更时两者同时出现。判断必须对属性键序不敏感（草稿由项目文件、项目行、元数据
     列表多源拼装），否则同值不同键序会误判成“有变更”而让按钮常驻。保存成功后必须把服务端返回的
     文件安装为新的有效值，使按钮立刻回到未编辑状态；取消必须恢复有效值且不写库。
  2. 每个项目的共享默认角色（`<projectId>-default-role`）必须**内置、只读、不可删除**：
     `meka-role:update` 返回 `MEKA_BUILTIN_READ_ONLY`，渲染侧全部字段 `disabled` 且不出现保存
     按钮；删除守卫仍是「所有 `is_builtin = 1` 都不可删」。它仍必须对**所有**已登记项目存在。
  3. **注入部分（2026-09-23 由「零注入」反转为「出厂即全量」）**：默认角色 manifest 置
     `useProjectDefaults: true` + `includeAllProjectMetadata: true` + **`includeAllBundledSkills: true`**，
     因此承接项目 `roleDefaults` 与项目当前**全部有效**元数据（项目侧 `enabled === false` 仍优先排除），
     并把 `resources/meka/skills/**` 扫到的**全部内置 catalog skill**纳入本角色；`skills` / `rules` /
     `promptFragments` / `projectMetadataSelection` 的显式列表**刻意留空**（避免两套来源漂移），
     但 **`mcp` 不空**——它显式声明 `{ id: 'meka-design', providerId: 'meka-design' }`
     （项目侧推不出这条 provider，退役角色原先 pin 的正是它）。**第三个开关的理由**：退役的
     `general-development` 曾**显式 pin 3 个内置 skill 与 `meka-design`**，只覆盖项目侧元数据会
     **静默丢掉那部分能力面**。**规范类元数据（`agents-md` / `rule`）的正文不得内联**：只以
     「**作用范围 + 绝对路径 + 描述**」的形式经 order 65 段 `[MEKA_PROJECT_REFERENCES]` 投递，
     正文由 Agent 在工作涉及该目录时用原生 read 工具按需读取（描述必须**确定性**产出，不得由模型
     生成）。**该段禁止句只约束规范文件**（`AGENTS.md` / `.cursorrules` / `rules.md`）：
     **技能正文 `SKILL.md` 不受限**，它走 harness 原生 catalog、正文必须按需读取——把 `SKILL.md`
     也圈进禁止句会与技能通道正面矛盾（初版从 WL-15 的「只读这一份冻结正文」语境搬运、语义被放大，
     2026-09-23 修正）。**`roleDefaults.rules[].text` 仍有内联通道**，属「角色默认提示词」而非 `rule`
     元数据，合并后内联进 order 70，是这条契约的**显式例外**：对外只能说「**元数据通道**零规范正文
     内联」。默认角色**不得带 `workflow`**、**不得注入任何战斗 promptFragments**（注入层进入战斗
     的唯一判据是 `runtime.workflow === 'saga2-combat-development-v1'`）。
     > **2026-09-29 更正**：`workflow` 字段与「注入层进入战斗」的整条判据已随 workflow 机制删除 ⇒
     > 这两句现在是**结构性恒真**（`MekaRuntimeConfig` 上根本没有 `workflow`，注入层也没有战斗分支），
     > 它们不再需要作为「运行期必须断言」的项去守；保留原句是因为它仍是「默认角色=零业务契约」这一
     > 设计意图的最短表述。
     **`meka-role:read-manifest` 现在是「有效清单」**（2026-09-23 反转，上一版「对默认角色直接返回
     内存 manifest、不做运行期展开」的说法**已作废**）：面板读清单对带展开开关的角色走
     `expandRoleManifest`，**复用运行期那几个既有纯函数**按同一顺序展开
     （`mergeMekaProjectRoleDefaults` → `resolveRoleProjectMetadataSelections` →
     `resolveBundledSkillSelections`，**没有第二套展开逻辑**）。它因此是**配置 IO 路径**，但 IO 被
     **flag 门**限制在 opt-in 角色（三个开关任一为 true 才读项目配置；不命中 ⇒ 零额外 IO 直接返回），
     且**失败时三层回退、不抛错**：① flag 门不命中；② 项目配置不可用 ⇒ 返回角色自身 manifest；
     ③ 展开抛错 ⇒ `log.warn` + 返回角色自身 manifest。该路径**不读 skill 正文**（只要 id 清单），
     结果**只服务面板呈现**，不写库、不落盘、不参与运行期解析。
  4. **反向对照（防空跑，2026-09-23 换对照物）**：同一份带 `roleDefaults` 的项目配置下，必须能
     观察到默认角色**确实**贡献了角色级技能与元数据（展开后技能数 > 平台基线），**同时**确认
     规范类正文一个字节都不在会话 system 前缀里（只有 order 65 的路径+描述清单）。
     **对照角色改用 `combat-development` 或一个项目自有角色**——`general-development`（通用开发）
     已于 2026-09-23 退役（行与会话重绑到 `<projectId>-default-role`、包内清单文件已删除），
     不再能充当对照物。
     > **2026-09-29 追加**：`combat-development` 也**不再能充当对照物** —— 它的随包清单已在本次交付删除，
     > 存量的 `is_builtin=1` 孤儿行在读取时由 **T2**（WL-20）回落到该项目默认角色 ⇒ 它与默认角色
     > 解析出**同一份清单**，对照恒等于空跑。可行的对照物只剩：**项目自有角色**（
     > `<project-root>/.meka/project.json` 的 `builtinRoles` / `meka-roles/<id>.json`）、或
     > **挂载了插件技能等额外技能来源**的角色。
  5. **只读面板必须显示「有效清单」，并让「出厂全量」可见**（2026-09-23 扩写）：
     - 面板拿到的必须是**展开后的有效清单**（见第 3 条的 `read-manifest`），否则空的显式列表会被
       读成「这个角色什么都没有」——那正好是旧契约的语义，与现状相反。
     - 来源徽标按开关逐个渲染，**三个**都要有：`useProjectDefaults` → 「已继承项目默认值」、
       `includeAllProjectMetadata` → 「已包含全部项目元数据」、`includeAllBundledSkills` →
       「已包含全部内置技能」（`i18n` 键 `meka.roleInheritsProjectDefaults` /
       `meka.roleIncludesAllProjectMetadata` / `meka.roleIncludesAllBundledSkills`）。
     - 说明句必须用「**带以上标记的条目…**」**指代上方徽标**，**不得**再说「以下条目」：列表里
       继承项与显式项是**混排**的，指代整个列表是错的。
     - 说明句的**只读分句按 `roleReadOnly` 二选一取键**（`meka.roleInheritedSourcesNote` 带
       「本角色只读」/ `meka.roleInheritedSourcesNoteEditable` 不带）。**理由**：**复制默认角色
       会保留三个开关**（renderer 的 `roleFileForCreate` 只剥 `id` / `name` / `projectId`），
       而**副本是可编辑的**——把「本角色只读」绑在开关上会对副本说假话。这是一条**按角色可编辑性
       取措辞**的不变量，不是文案偏好。
     - **W25 批次语义修正（2026-09-23）**：这两句现在写「来自**项目配置或应用内置技能目录**、
       随**项目或应用版本**变化」。原文只说「项目配置」——对第三枚「已包含全部内置技能」徽标
       **说错了**（内置 catalog 技能来自包内 `resources/meka/skills/**`，不来自项目配置）。
       可编辑变体（`…Editable`）另给出「**取消勾选即可排除对应条目**」的指引，与下面第 8 条的
       「只有 `enabled: false` 才是有效排除」一致。五语（zh-CN / zh-TW / en / ja / ko）均已改。
  6. 该行必须对**所有**已登记项目存在（内置项目由启动播种收敛，用户新建项目在创建时立即建行），
     且播种的冲突子句只在 `is_builtin = 1` 时生效，不得接管用户自有的同名角色行。**唯一的例外
     是派生 id 已被用户自有行占用**：此时 upsert 静默跳过，该项目没有默认角色——这是刻意的
     「宁可不建，也不夺用户的行」，不是缺陷（见下条锚点）。
   7. **「展开只用于显示」的落盘契约（2026-09-23 追加，配第 3 条的 `read-manifest` 反转）**：
      面板读到的是**展开态**，但**落盘必须保持「开关即真相、不枚举 id」**——磁盘上的角色清单只留
      三个开关，不写派生条目。`createMekaRole`（官方文案引导的「复制默认角色成项目角色」路径）与
      `updateMekaRole`（自定义角色分支与 `builtinRoles` 项目文件分支共用同一份 manifest）都必须
      **在 `normalizeMekaRoleManifest` 之前**调 `stripSelectAllDerivedEntries`
      （`meka-projects/runtimeConfig.ts` 的纯函数；IO 门与降级在 `localDb/ipc/mekaRoles.ts` 的私有包装
      `stripSelectAllDerivedForSave` 里）：三开关全非 `true` ⇒ 零 IO / 零 catalog 扫描原样返回；否则以
      「开关不变、四个列表清空」的清单走**与运行期同一条**展开漏斗得到 `derived`，只删「与 `derived`
      同 key 且 `isDeepStrictEqual`（深度相等）」的项；**不等价条目一律保留**——作者改 `enabled: false`
      或改任何字段就是**精确排除意图**，`derived` 里没有的 key（作者新增项）同样保留；**除四个列表之外，
      `prompt` 上由项目 `roleDefaults.promptFramework` 派生的前缀**（2026-09-23 第二批修复）也要剥——
      只对 `useProjectDefaults === true` 生效：`prompt === framework` ⇒ 作者 own 为空 ⇒ 写回空串；
      以 `framework + '\n\n'` 开头 ⇒ 剥掉该前缀；其余（作者改写过的前缀、framework 为空/纯空白）原样
      保留；剥掉后运行期会**再前置一次** ⇒ 有效 prompt 与第一次展开**逐字相等**（幂等，「打开面板 →
      保存」不再每次叠一份 framework）。剩下的字段（`policyProviderRefs` / `displayName` /
      三个开关本身…）不动 —— **原文这里还列过 `workflow`，该字段已随 workflow 机制删除（2026-09-29）**。**项目导入/克隆路径**（`localDb/ipc/mekaProjects.ts` 的角色克隆循环）写进新
      项目文件 `builtinRoles` 的那份快照同口径剥离（用当前作用域的 `file` 作 projectFile；**不得**改用
      需要读盘的 `stripSelectAllDerivedForSave`）。
      **降级契约**：项目配置 / catalog 取不到或抛错 ⇒ `log.warn` + **原样落盘，保存不得因此失败**。
      **反向（失败半径，正是物化会重新引入的 P1）**：物化会把全量展开项变成「作者显式选择」而
      fail-closed（运行期 `explicitMetadataKeys` 取自角色清单自己声明的 `projectMetadataSelection`）
      ⇒ 项目里任何一个无法解析的第三方 `SKILL.md` / `.mcp.json` 都会把该角色**新建会话**顶成
      `INVALID_PARAMS`（F1 回归，见 WL-11.17 第 7 条）。
      **维护不变量**：新增 select-all 开关或新增可派生列表时必须同步 `stripSelectAllDerivedEntries`
      的列表与 key 口径（skills `isLegacySkill ? id : skillId`、metadata `metadataKey`、
      rules `rule.id`、mcp `entry.id`）——**漏加不报错，只会静默失去剥离**。
   8. **派生行不可删除：`derivedEntryKeys` 展示字段（2026-09-23 W25 批次落地）**：
      `meka-role:read-manifest` 在**展开确有派生项时**额外返回一个**只用于展示**的字段
      `derivedEntryKeys: { rules, skills, mcp, metadata }`（源码 `localDb/ipc/mekaRoles.ts` 的
      `MekaRoleDerivedEntryKeys` / `derivedEntryKeysOf` / `hasDerivedEntryKeys`）。算法 = 以
      「开关不变、显式列表清空」的清单跑**同一个** `stripSelectAllDerivedEntries`，**取展开态与
      剥离结果的差集**（key 口径与剥离函数一致：rules `rule.id`、
      skills `isLegacySkill ? id : skillId`、mcp `entry.id`、metadata `metadataKey`）；
      **无派生项时该字段整体不出现**（保持旧形状）。两条降级路径（flag 门不命中 / 项目配置或
      catalog 取不到）返回存储的 manifest，同样**不带**该字段。
      - **它解决的是什么**：派生行在每次解析时都会被运行期 `mergeMekaProjectRoleDefaults`
        （以及元数据 / catalog 展开）**重新加回** ⇒「删除」只改草稿、保存后行还会回来
        （删了等于没删）。面板据此**对派生行不渲染删除按钮**，只保留勾选框。落地四处
        （`MekaProjectRoleEditorRoute.tsx`）：**rules**（`!roleReadOnly &&
        !derivedRuleKeys.has(ruleItem.id)`）、**mcp**（`!disabled &&
        !derivedEntryIds.has(entry.id)`）、**技能 legacy 项**（`!disabled &&
        !derivedSkillKeys.has(item.skillId)`）与**技能未识别/普通项**（`!disabled &&
        !derivedSkillKeys.has(item.id)`）。同文件里项目 `roleDefaults` 编辑区的两个同名
        `Trash2` 按钮**不属于**这四处（那是项目配置编辑，不是角色派生行）。
      - **唯一有效的排除方式是勾选框的 `enabled: false`**：这样的条目与派生条目**不深度相等**，
        因此会被 `stripSelectAllDerivedEntries` 保留下来。
      - **该字段绝不落盘**：`normalizeMekaRoleManifest`（`meka-projects/projectConfig.ts`）是
        **白名单式重建**，即使 payload 带着它也不会写盘；`update` 与 `create` 两条写盘入口
        各有用例锁住（`mekaRoleSelectAllPersistence.test.ts` 第 4 组
        `derived entry keys are reported for the panel and never persisted`，3 条）。
      - **本条取代**「派生行仍渲染删除按钮 = 已知坏交互、本批不修」的旧登记（迁移总账 §11.27
        的 B7）：W25 已按「对派生项裁剪删除入口」这一修法方向落地。**仍需人工目检**——
        **Light / Dark 两种模式都未目检**，本次也未跑任何门禁。
- **代码锚点（2026-09-29 Meka 最小随包交付后逐条打开文件复核；`runtimeConfig.ts` 与 `mekaRoles.ts`
  本批被改动最多，行号只是快照，引用时以符号名为准）**：
  `apps/desktop/src/shared/meka-projects.ts:155`（`mekaDefaultRoleId`）、
  `:186-213`（`mekaDefaultRoleManifest`：三个开关 + `mcp: [{meka-design}]` + 两段 prompt，
  `includeAllBundledSkills` 在 `:203`、`MEKA_DEFAULT_ROLE_PROMPT` 常量在 `:168-170`、
  `prompt` 赋值在 `:204`）、
  `:360-363` / `:372-377`（固定目标映射表与 `<projectId>-default-role` 别名表的**分工**）、
  `:437` + `:520-566`（`seedBuiltinMekaProjects` 的播种顺序：默认角色行 → `backfillSessions`
  （`:468`）→ 别名重绑 / 删行 → 固定映射，顺序是承重的：先建行再重绑，否则删行会让
  `ON DELETE SET NULL` 清空会话角色列；**重绑语句在 `:513`，带
  `AND meka_project_id IN (SELECT id FROM meka_projects)` 守卫**）、
  `localDb/ipc/mekaRoles.ts:614-631`（`readRoleManifest`：三个内置分派都过
  `expandRoleManifest`，**内置清单缺失时走 `readBuiltinRoleManifestOrProjectDefault`（T2）**）、
  `:315-378`（`expandRoleManifest`：flag 门 + 三层回退 + `log.warn`）、
  `:516`（update 对默认角色抛 `MEKA_BUILTIN_READ_ONLY`）与 `:565`（delete 的内置行守卫）；
  `meka-projects/runtimeConfig.ts:725-741`（`resolveRoleFile` 的默认角色分支**不是「零注入」
  短路**，返回后仍走 `mergeMekaProjectRoleDefaults` → `resolveRoleProjectMetadataSelections`
  的完整漏斗；**其余内置角色走 `readBuiltinRoleManifestOrProjectDefault` 的 T2 回落**；
  `upgradeLegacyBundledWorkflowRole` / `migrateSAGA2CombatRoleSkills` 与两段 SAGA2 内存迁移
  **已整体删除**）、`:585-594`（`resolveBundledSkillSelections`：
  `includeAllBundledSkills` 的唯一展开点，运行期与面板共用）、`:410-431`（`projectReferenceScope`
  的 `..` / 绝对路径校验）、`:438-457`（描述派生）、`:460-467`（`compareProjectReferences` 的确定性
  排序）、`:910-921`（`agents-md` / `rule` 分支：**只写 `projectReferences`**，F3 内联分支已删除）、
  `:967-982`（容错边界 catch：全量展开项跳过并 `log.warn`，显式选择项继续上抛）、`:1000`
  （按确定性顺序返回）、`:876-884`（`itemType` 穷尽性与路径契约校验，在容错边界之外，任何来源都抛）；
  `meka-injection/mekaResolvePlan.ts:357-362`（order 65 推入，空集合不入 plan）、
  `meka-injection/mekaPrompts.ts:55-73`（段文本唯一常量，marker 在 `:35`）；
  `meka-projects/metadataScanner.ts:145-171`（上限与折叠、首句）、`:186-228`
  （frontmatter / 正文探测）、`:230-282`（`describe` 对 `agents-md` / `rule` 走新分支）；
  `meka-projects/projectConfig.ts:309-376`（`normalizeMekaRoleManifest` 白名单式重建，
  `includeAllBundledSkills` 透传在 `:371-373`）、`:545-548`（退役 id 并集）与 `:559-560`
  （「只对 saga2 生效」的过滤作用域）、`:550-576`（`mergeBundledRoleFallbacks`，其
  `includeAllProjectMetadata` 回填分支当前不可达但刻意保留）；
  `localDb/ipc/mekaProjects.ts`（导入路径**不跑**退役过滤 ⇒ 旧角色被克隆成新 id、`is_builtin=0`、
  显示名仍是「通用开发」的自定义角色，属用户数据必须保留）；
  `renderer/features/cc-agent/MekaProjectRoleEditorRoute.tsx:608`（`InheritedRoleSourceBadge`）/
  `:633-679`（`InheritedRoleSourcesNotice`：三个徽标 + 按 `roleReadOnly` 二选一取键）、
  `:161-169`（`roleFileForCreate` 只剥 `id` / `name` / `projectId` ⇒ 副本保留开关但可编辑）、
  `:1942-1949`（`selectionReadOnly` 恒 `false` ⇒ `roleReadOnly ≡ isMekaDefaultRole`）。
  **第 7 条的锚点（2026-09-29 Meka 最小随包交付后重核）**：
  `localDb/ipc/mekaRoles.ts:380-405`（`stripSelectAllDerivedForSave`：flag 门 + 「取不到即原样落盘」
  的降级）、`:472` 与 `:509`（两条写盘入口的调用点，都在 `normalizeMekaRoleManifest` **之前**）、
  `:252-278`（`derivedEntryKeysOf`）与 `:279-291`（`hasDerivedEntryKeys`）；
  `meka-projects/runtimeConfig.ts:646-723`（`stripSelectAllDerivedEntries`）、`:605-615`
  （`withoutDerivedEntries` 的 `isDeepStrictEqual` 判据）、`:597-599`（`skillSelectionKey`）、
  `:787-789` 与 `:868`（`explicitMetadataKeys` 快照与 `isExplicitSelection` 判据）、
  `:802-804`（`roleDefaults.rules[].text` 的内联通道——**仍在**，是该契约的显式例外）；
  回归锁 `meka-projects/__tests__/mekaRoleSelectAllPersistence.test.ts`（**23 条 `it` / 4 个
  `describe`**，W25 逐条重数；逐组为 6 / 7 / 3 / 7）。**一律以文件实际为准。**
  > **锚点漂移更正之四（2026-09-29 Meka 最小随包交付，本条取代上面三条「漂移更正」）**：
  > 上面三条注（更正 / 之二 / 之三）给出的 `runtimeConfig.ts` / `mekaRoles.ts` 行号**全部过期** ——
  > 本次交付把 workflow 机制、两段 SAGA2 内存迁移、`inlineProjectDocumentation` 内联分支与
  > `upgradeLegacyBundledWorkflowRole` 从 `runtimeConfig.ts` 整体删除，行号整体前移。
  > 因此上面正文（以及三条更正注）里的 `inlineProjectDocumentation`、`resolveRoleFile :855-880`、
  > `migrateSAGA2CombatRoleSkills`、`mekaCombatPrompts.ts` 等锚点**已不存在或已改名**
  > （段文本文件现为 `mekaPrompts.ts`）。**其余未被本注逐条列出的 `runtimeConfig.ts` /
  > `mekaRoles.ts` 锚点，一律打开文件按符号名重新核对，不要沿用任何旧数字。**
- **自动化门禁**：`pnpm --filter desktop exec vitest run src/main/meka-projects src/main/localDb/__tests__/builtinMekaSeed.test.ts`
  （`mekaDefaultRole.test.ts` 的只读契约与出厂清单形状、`runtimeConfig.test.ts` 的两条纯展开函数、
  `runtimeConfig.projectReferences.test.ts` 的生产侧 `projectReferences` 契约、
  `projectConfig.test.ts` 的 `normalizeMekaRoleManifest` 透传、`mekaProjectsImport.test.ts` 的导入
  保留同名克隆角色、`builtinMekaSeed.test.ts` 的播种顺序 / 重绑守卫与「派生 id 被用户自有行占用时
  不得接管」）；
  `pnpm --filter desktop exec vitest run src/renderer/features/cc-agent/__tests__/MekaProjectRoleEditorRoute.test.tsx`
  （只读面板、三种来源徽标与按 `roleReadOnly` 二选一的说明句，以及
  `Meka role switch-derived entries cannot be removed` 一组；**25 条 `it` / 5 个 `describe`**，
  W25 逐条重数）；
  **`pnpm test:db`**（必跑：`builtinMekaSeed.test.ts` 在 `unit` 层被排除、
  被 `scripts/test-workspaces.config.mjs` 归入 `status: 'manual'` 的 `db` 层 ⇒
  `pnpm test:unit:related` / `pnpm test:unit` 都不执行它；默认角色的建行、**F2 重绑守卫**与
  删除守卫只有这一层在守。**W25 终核更正：CI 会执行它**——见下方「tier 提醒」的 CI 段）；
  `pnpm --filter desktop run typecheck`。
  **W25 批次补计数**：`mekaDefaultRole.test.ts` **7 条 `it` / 2 个 `describe`**（含
  `Meka role manifest read expansion` 一组 4 条）、`builtinMekaSeed.test.ts` **11 条 `it`**、
  `runtimeConfig.projectReferences.test.ts` **19 条 `it`**、`runtimeConfigProjectFiles.test.ts`
  **7 条 `it`**（均为逐条重数）。
  **门禁状态**：用例期望**已同步**（含只读面板的来源标识断言），但**本批没有执行任何门禁**，
  上述命令在本批**一次都没跑**（见 §8.5）。
  > **⚠️ 2026-09-29（Meka 最小随包交付）：这条命令当前会红，且不是「期望未同步」而是「测试侧尚未清理」。**
  > 该 glob `src/main/meka-projects` 会收进 `__tests__/combatWorkflowPolicy.test.ts` /
  > `combatServerCapabilityState.test.ts` / `combatEnvironmentGate.test.ts`（**被测模块已删除**），
  > 而 `src/main/localDb/__tests__/builtinMekaSeed.test.ts` 仍 `import` 已删除的
  > `resources/meka/roles/combat-development.json` 并断言内置阵容 = `['saga2-default-role',
  > 'combat-development']`。**这些都必须由交付方在本次一并清理**（见 §8.12 第 4 条）；
  > 清理完成前，本条**不得记为通过**，`pnpm --filter desktop run typecheck` 同样会红。
  > **tier 提醒（2026-09-23 增补，防「有覆盖」被读成「CI 真跑」）**：本批核心的
  > `projectReferences` 生产侧断言**已从没有 tier 归属的
  > `src/main/meka-projects/__tests__/runtimeConfig.integration.test.ts` 移到 unit 层的新文件
  > `src/main/meka-projects/__tests__/runtimeConfig.projectReferences.test.ts`**（真实
  > `resolveMekaRuntimeConfig` + 临时目录夹具，16 条 `it`；**W25 批次终核为 19 条**）。原因是 desktop 的 `unit` 层 exclude 里写着
  > `**/*.integration.test.ts`，而 desktop **没有 integration tier**（tiers 只有 unit /
  > git-integration / e2e / db / migration / db-perf / guard）⇒ 那个 `*.integration.test.ts` 在
  > `test:unit` / `test:unit:related` / `test:db` / CI 里**都不会被执行**。
  > **（2026-09-23 第二批更正，取代原先「只有全量 `test:all` 才可能碰到」的说法）**：用 runner 自己的
  > `selectFilesForTier` / `discoverTestFiles` 实测，该文件的 `matchedTiers = (NONE — never runs)` ——
  > desktop 的 **7 个 tier 没有任何一个**的 include 匹配 `*.integration.test.ts` 后缀，而 `--all`
  > 只是把 manual tier 纳入、并不放宽 include ⇒ **`test:all` 同样不执行它**。
  > **唯一执行途径**是人工 `pnpm --filter desktop test`（无参全量，会收 standard project）
  > 或显式 `vitest run <路径>`。⇒ 该文件里的用例（含本批新增的那些）**在本批与 CI 中都不会被执行**，
  > 只能当作**纯代码级证据**，**不可当作已验证**。
  > **末态更正（2026-09-23，文档同步进行中该交付又被改动）**：
  > ① `src/main/meka-projects/__tests__/runtimeConfig.integration.test.ts` **已不再存在**
  > （本次核对该目录时文件清单里没有它：该文件**已于 2026-09-23 更名为**
  > `runtimeConfigProjectFiles.test.ts`；另一部分生产侧断言被拆到 unit 层的
  > `runtimeConfig.projectReferences.test.ts`）。
  > ② `runtimeConfig.projectReferences.test.ts` 的 `it` 数**已从 16 增至 19**（本次逐条计数）。
  > ③ 上面「`test:all` 也不执行 `*.integration.test.ts`」的**机制结论仍然成立**（desktop 7 个 tier
  > 无 include 匹配该后缀），但它已不再是本批核心断言的落点 —— 本批核心断言现在就在 unit 层的
  > 那两个新文件里，**会**被 `test:unit:related` / CI 执行（前提是文件真的被 glob 覆盖）。
  > ④ 上述三点都发生在**本次文档同步过程中**，属**本批末态**；数字以文件实际为准。
  > ⑤ **W25 批次终核（新增事实，2026-09-23）**：`runtimeConfigProjectFiles.test.ts` 已用 runner
  > 自己的 `selectFilesForTier` 逐 tier 实测命中 desktop **`unit`(required) tier** ⇒ 它**会**被
  > `pnpm test:unit` / `pnpm test:unit:related` 与 CI 的 unit 分片执行。`git mv` 改名（而不是新建
  > 一份）的**唯一目的**就是这一点：旧名 `runtimeConfig.integration.test.ts` 原先「7 个 tier 无一
  > include 匹配该后缀、连 `test:all` 都不执行」。旧名路径实测**仍为 `NO TIER`**（文件已不存在）。
  > 计数：`runtimeConfigProjectFiles.test.ts` = **7 条 `it`**；
  > `runtimeConfig.projectReferences.test.ts` = **19 条 `it`**（两者均为 W25 逐条重数）。
  > 因此引用「有覆盖」时必须指明**是哪一层的文件**：unit 层的新文件才是提交前门禁与 CI 真跑的那一份。
  > 附带提醒：`builtinMekaSeed.test.ts` 位于 `src/main/localDb/**`（被 `unit` tier 排除）
  > 且被归入 `status: 'manual'` 的 `db` 层 ⇒ `test:unit` / `test:unit:related` 不执行它。
  > **（2026-09-23 晚些时候的事实更正）CI 现在会跑它**：`.github/workflows/ci.yml` 的
  > 「Run companion database regressions」步骤（linux shard 1 与 windows shard 1 各一处）
  > 已把 `src/main/localDb/__tests__/builtinMekaSeed.test.ts` 加进写死路径清单。
  > ⇒ 准确表述是「**`test:unit` 与提交前 `test:unit:related` 不跑它；CI 通过那条写死路径跑它；
  > 本地要复现必须显式 `pnpm test:db` 或显式 `vitest run <该文件>`**」。
  > **本条与 §8.5 里「必须显式 `pnpm test:db`，否则 CI 也不跑」的旧口径冲突时，以本条为准**
  > （该 CI 改动发生在本次文档同步进行中，属本批末态）。
  > 因此**只读契约的守护测试刻意放在
  > `src/main/meka-projects/__tests__/`**（unit tier），以免该不变量在 CI 与提交前门禁里无人守护。
  **第 7 条的回归锁（2026-09-23 追加）**：`src/main/meka-projects/__tests__/mekaRoleSelectAllPersistence.test.ts`
  （**本轮逐条重数（2026-09-23，打开文件数 `it(`）为 20 条 `it` / 3 个 `describe`**：
  `stripSelectAllDerivedEntries` 6 条 + `select-all persistence at the write boundaries` 7 条 +
  `derived prompt framework is stripped before it can stack up` 7 条。**此前登记的「19 条（原 12 条 +
  第二批 7 条）」与本次重数不符** —— 该文件在本批中仍被继续编辑，**一律以文件实际为准**）
  > **W25 批次终核（2026-09-23，只追加不改写上面的原句）**：该文件在本轮**又增至 23 条 `it` /
  > 4 个 `describe`** —— 新增第 4 组
  > `describe('derived entry keys are reported for the panel and never persisted')`（3 条），
  > 锁住 `meka-role:read-manifest` 的展示字段 `derivedEntryKeys` 与「绝不落盘」两条写盘入口。
  > 逐组为 6 / 7 / 3 / 7。
  就在上面那条 `src/main/meka-projects` glob
  的覆盖范围内，属 **unit 层**。它**刻意
  不放在被测模块旁边的 `src/main/localDb/ipc/__tests__/`**：desktop `unit` tier 的 `exclude` 含
  `src/main/localDb/**`（`scripts/test-workspaces.config.mjs:161`），而 `db` tier 是
  `status: 'manual'`（同文件 `:190-201`）⇒ 放在那里**提交前门禁（`pnpm test:unit:related`）与 CI
  都不会执行**，等于没有这条 P1 回归锁。先例与逐字理由见
  `apps/desktop/src/main/meka-projects/__tests__/mekaDefaultRole.test.ts:22-26`（同样 mock
  `../../localDb/client/current.js`、同样驱动真实注册的 IPC handler，因此留在 unit tier）。
  **门禁状态**：该文件**本次也没有实跑**（本批未执行任何门禁）。第二批（2026-09-23 `prompt` 修复）
  **为取证单独实跑过这个文件**：`pnpm --filter desktop exec vitest run
  src/main/meka-projects/__tests__/mekaRoleSelectAllPersistence.test.ts` ⇒ **19 passed / 0 failed**
  （同时为取证跑了 `mekaProjectsImport.test.ts`：6 passed，用于确认克隆路径改动不破坏导入；
  两条都是**定向取证，不是门禁**）。**提交前门禁与 CI 仍未跑**。
  > **W25 批次补充（只追加不改写上面的取证记录）**：该 19 passed 对应的是**文件还在 19/20 条时**
  > 的状态；该文件此后继续被编辑到 **23 条**，因此**当前条数下仍然没有实跑证据**。W25 批次
  > **同样未跑任何门禁**。
- **实机验证**：`pnpm desktop:session-smoke` 与 `pnpm desktop:session-smoke -- --role 默认角色`
  （见上文「待重跑」块：WL-11.1 / WL-11.2 / WL-11.6 / WL-11.8 的第三次期望更新）。
  **本批未跑（未验证）**：两条命令都没执行；另需目检默认角色面板只读且**显示**「出厂全量」来源标识
  （**三个**徽标齐全）、说明句按副本可编辑性取到不带「本角色只读」的那一句，以及会话 system 前缀里
  只有 order 65 的路径清单而没有规范类正文。**Light / Dark 两种模式的目检未做**（未声称复用既有
  主题即等于已验证）。
- **第 7 条新增的语义验收项（2026-09-23 追加，可实跑判据）**：
  1. **正向（落盘只留开关）**：在面板里保存一个带 select-all 开关的角色——**含「复制默认角色」得到的
     副本**（这是官方文案引导的路径）——重开面板后**勾选状态不变**，但**磁盘上的角色清单只留开关、
     不含派生条目**：自定义角色看 `<userData>/meka-roles/<id>.json`，`builtinRoles` 分支看项目
     `.meka/project.json` 里对应的 role 条目（两条入口共用同一条剥离逻辑）。
  2. **反向（失败半径，物化会重新引入的 P1/F1）**：在项目里放一个**无法解析的第三方 `SKILL.md`**
     （frontmatter 非法）或**声明不全的 `.mcp.json`**，该角色的**新建会话不得失败**。若保存把展开态
     物化成了显式选择，这一项就会以 `INVALID_PARAMS` 转红——这条正是第 7 条的判据本体。
  3. **降级**：项目配置不可读（或 catalog 不可扫）时保存仍成功，清单**原样落盘**（`log.warn`，不抛错）。
  **取证状态（如实登记）**：上述正向 / 反向 / 降级**目前只有 unit 层代码与用例声明，没有实机复跑**；
  面板往返后的勾选状态目检、磁盘清单目检、以及「坏文件不顶掉新建会话」的实机观测**均未执行**。
  它们同样未被 `pnpm desktop:session-smoke` 覆盖：该脚本不驱动角色面板的保存流程，也不断言保存后的
  落盘清单形状（它只读角色列表、包内 `resources/meka/roles/<id>.json`、项目配置与会话运行期配置）。

**WL-11.11（已退役：2026-09-29 Meka 最小随包交付）**

> **已退役，编号保留为空缺、不得复用。** 本项能力 = 「战斗请求的两请求类（`single-skill` /
> `table-scope`）与『启发式不得产生 confirmed』」，它是 **workflow 机制 + 内置提示词正文**的组成部分，
> 已整体删除。退役原因与同批条目一览见 **§8.12**。
>
> - **删除内容**：`mekaCombatRequestScope` 分类、`COMBAT_CURRENT_TARGET_DEMONSTRATIVE_PATTERN` 等
>   战斗正则、`suppressTableScopePatchForConfirmedBinding`、用户提示里的技能 ID 补丁、成员清单
>   （A4：`recordCombatScopeSkillIds` / `COMBAT_SCOPE_SKILL_IDS_LIMIT`）、会话级状态镜像（A3）、
>   卡片答案审批（D8）与其 `register.ts` 交互 resolve 消费点，以及承载它们的
>   `mekaCombatPrompts.ts` / `combatWorkflowPolicy.ts` / `combatServerCapabilityState.ts`。
> - **原始正文里的语义验收步骤、自动化锚点与「未实机验证」登记全部作废**：它们指向的文件、工具与
>   用例已不存在（或已失效），**不得据此条目执行任何验证**。
> - 历史正文（2026-09-22 至 2026-09-23 的逐轮登记）保留在 Git 历史上；本批交付记录见迁移总账 §11.32。

**WL-11.12（已退役：2026-09-29 Meka 最小随包交付）**

> **已退役，编号保留为空缺、不得复用。** 本项能力 = 「`[SAGA2_PROJECT_PATHS]` 项目参考路径注入与
> 策略层精确路径白名单」，它是 **workflow 机制 + 内置提示词正文**的组成部分，已整体删除
> （`resolveCombatProjectRefPaths` / `combatProjectPathsPrompt` / `mekaCombatProjectRefPaths` /
> `combatEvidenceBasisPatch` / 表范围服务器派发边界全部随三个文件删除）。退役原因与同批条目一览见
> **§8.12**；原始正文里的语义验收步骤与自动化锚点**全部作废**，不得据此条目执行任何验证。
> **注意区分**：本次交付**保留**的是**通用**的项目参考投递段 `meka.project-references`（order 65，
> 投递「作用范围 + 绝对路径 + 描述」），其不变量与锚点见 **WL-11.17**；它是平台机制，不是战斗白名单。


**WL-11.13（已退役：2026-09-29 Meka 最小随包交付）**

> **已退役，编号保留为空缺、不得复用。** 本项能力 = 「表范围解析的只读通道（Unity 查询白名单）与
> P4 写边界」，它是 **workflow 机制**的组成部分，已整体删除：Cindy 侧的只读 Unity 命令白名单
> （`mekaCombatReadOnlyUnityCommands`）、`isPlanningMutation` 的 `saga2_design/planning` 拒绝、
> `p4_status` 只读豁免都随 `combatWorkflowPolicy.ts` 删除；**被它们约束的冻结 SKILL.md 正文
> （`roles/prompts/*.md`、9 份随包 SKILL.md）也一并删除**。退役原因与同批条目一览见 **§8.12**；
> 原始正文里的语义验收步骤与自动化锚点**全部作废**，不得据此条目执行任何验证。
>
> **跨仓事实仍成立、但不属本仓白名单项（登记在此以免随条目一起丢失）**：meka-p4 插件的四个不可逆
> 工具仍走「预览 → `cindy.confirm` → 带 `expectedPreviewToken` 执行」三步，`requestConfirmation`
> 在 `cindy.confirm` 不可用时返回 `CONFIRMATION_UNAVAILABLE` 并**拒绝执行**（fail-closed）——
> 锚点为跨仓 `cindy-meka-plugins/meka-p4/main.js`（`p4_submit` / `p4_revert` / `p4_clean` /
> `p4_force_sync` 与 `requestConfirmation`），本仓**没有任何锚点或门禁**，也**没有实机验证**。
> 本次交付**未改动**该插件（不在本仓）。


**WL-11.14（已退役：2026-09-29 Meka 最小随包交付）**

> **已退役，编号保留为空缺、不得复用。** 本项登记的是「Host 侧战斗证据预算／配额／时限已删除、
> 不得复活」，而这套判据的**全部承载体**（`combatWorkflowPolicy.ts` / `combatServerCapabilityState.ts`
> 两个被删文件 + `combatServerCapabilityState.test.ts` / `combatWorkflowPolicy.test.ts` 这两个随之
> 失效的用例文件）以及它刻意保留对照的**提示词层收敛纪律**（`roles/prompts/combat-evidence-budget.md`）
> 都已在本次交付中**整体删除**（属「workflow 机制 + 内置提示词正文」两类）。退役原因与同批条目一览见
> **§8.12**；原始正文里的语义验收步骤（含那条 `git grep` 命令）与自动化锚点**全部作废**，不得据此
> 条目执行任何验证。
>
> **唯一需要保留的判断**：本条**不得**被读成「以后可以重新引入 Host 侧证据预算」。原判据已随机制消失，
> 但若将来重新引入战斗类收敛机制，**必须先按本清单第 6 节的判据新登记一条 WL 项**，而不是复活本编号。


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

**WL-11.16（已退役：2026-09-29 Meka 最小随包交付）**

> **已退役，编号保留为空缺、不得复用。** 本项能力 = 「战斗写入门禁的三层（范围绑定 / 命令面白名单 /
> 写后对账）」，它是 **workflow 机制**的组成部分，已整体删除：`combatWorkflowPolicy.ts` 的
> `legacyModuleWriteCommandReason` / `observeCombatLegacyModuleResult` / `settleCombatModuleReadBack` /
> `combatModuleWriteReconciliationReason` 与本条依赖的**冻结 SKILL 正文**（写入顺序与对账契约的唯一
> 表达处）都已删除；`ghost.ts` / `meka-runtime-mcp.ts` 的基线建立点与 MCP/Shell 两侧门禁接入也已删除。
> 退役原因与同批条目一览见 **§8.12**；原始正文里的语义验收步骤与自动化锚点**全部作废**，不得据此
> 条目执行任何验证。

**WL-11.17 规范类元数据的渐进披露（order 65 段）与内置角色退役重绑**（不变量，2026-09-23 登记）：

- **保护的不变量**：
  1. 项目规范类元数据（`agents-md` / `rule`）**不得把正文内联进任何 prompt 段**。它们的交付形态是
     `MekaRuntimeConfig.projectReferences` 里的一条 `MekaProjectReference`
     （`scope` / `path` / `description` / `itemType`，**正文刻意不在其中**），由**唯一**新段
     `meka.project-references`（order **65**、marker `[MEKA_PROJECT_REFERENCES]`）渲染成
     「**作用范围 | 绝对路径 | 描述**」清单；正文由 Agent 在工作涉及该 `scope` 目录（及其子目录）
     时用原生 read 工具**按需读取**。段文本与 marker 的常量唯一来源是
     `meka-injection/mekaPrompts.ts` 的 `mekaProjectReferencesPrompt`（**2026-09-29 改名**：原
     `mekaCombatPrompts.ts`；marker 常量在同文件 `:35`，段文本函数在 `:55-73`），测试与文档共用同一份
     模板，不得在别处再拼一遍。**段文本最终形态 = 6 + N 行**（marker / 两条独立成行的读取规则句 /
     格式行 / N 条 `- <scope> | <绝对路径> | <描述>` / 禁止句 / 闭合 marker）。
     **两条必须一起写的边界**：① 末行**禁止句只约束规范文件**（`AGENTS.md` / `.cursorrules` /
     `rules.md`），**技能正文 `SKILL.md` 不受限**——技能走 harness 原生 catalog、正文必须按需读取，
     把 `SKILL.md` 圈进禁止句会与技能通道正面矛盾（2026-09-23 修正）；② **`roleDefaults.rules[].text`
     仍有内联通道**（属「角色默认提示词」，合并后进 order 70），是该契约的**显式例外**：对外只能说
     「**元数据通道**零规范正文内联」。
  1b. **`includeAllBundledSkills`（第三个通用开关）**：默认角色置 `true`，把
     `resources/meka/skills/**` 扫到的**全部内置 catalog skill**纳入该角色；展开点
     `resolveBundledSkillSelections`（运行期与面板读清单**共用同一个函数**，禁止第二套逻辑）——
     运行期与 `read-manifest` 都从它取，**技能 id 清单与正文都不得进 `promptText`**。
     理由：退役的 `general-development` 曾显式 pin 3 个内置 skill + `meka-design` MCP，只覆盖项目侧
     元数据会**静默丢掉那部分能力面**。**维护不变量**：新增角色 manifest 字段必须同步
     `normalizeMekaRoleManifest` 的透传（白名单式重建，漏加不报错、只静默丢字段）。
     > **2026-09-29 规模变更（必须知道）**：随包 skill **从 10 个减到 1 个**（只剩
     > `通用/platform/platform-capabilities/SKILL.md`）⇒ `includeAllBundledSkills` 现在只会铺进
     > **`platform-capabilities` 这一个 id**（它与平台基线技能是同一个，`resolveMekaPlatformRuntimeSkills`
     > 也读它，合并后不重复）。开关与展开逻辑**未改**（机制不动），变的是 catalog 的规模；
     > 因此「默认角色技能数明显多于平台基线」这条旧期望在**随包默认**下不再成立 ——
     > 若非要对照，需用挂载了插件技能/项目自有技能的角色。`runtimeConfig.projectReferences.test.ts`
     > 里 `expect(catalog).toHaveLength(10)` 这类**计数断言已过期**（见下方门禁注）。
  2. **空集合 ⇒ 整段不渲染**（完全不入 plan，与「`meka.role-prompt` 文本为空不入 plan」同口径）；
     条目顺序 = `scope` 升序 → `path` 升序（**确定性**，否则 system 前缀会漂移）；`scope === ''`
     渲染为 `(项目根)`；解析不到正文的条目（ENOENT）直接跳过，**不得**产出悬空引用。
  3. **只在 bootstrap（新建会话）路径注入**：`resolveFrozenInjection` 的 resume 短路**不注入该段**，
     它与角色段 60 / 70 **同进同出**（I4：resume 不重解析项目/角色、不重算 MCP）；远端服务器 Worker
     分支同样不注入任何角色段。禁止为了 resume 注入它而在 frozen 路径上新增 `resolveRuntimeConfig`
     调用。
  4. **描述有界且来源确定**：扫描期按 `frontmatter.description` → `frontmatter.title` → 正文首个
     **结构元素**（先出现的 ATX 标题；若先出现的是非空段落则取该段首句，其后的标题不顶掉它 ——
     `metadataScanner.ts:probeReferenceBody`）的顺序产出（折叠空白、≤300 字符、按码点截断），运行期再按
     `description` → `displayName` → `name` → 相对 `sourcePath` 兜底并同样有界化。
     **绝不由模型生成**——那会让 `promptText` 非确定，破坏 system 前缀稳定性与缓存率。
  4b. **F5 `scope` 校验与参照系**：`subProjectPath` 只在它是**根内相对路径**时才被采用——
     绝对路径 / 盘符 / UNC / 任何含 `..` 段的值一律**不采用**（`log.warn`），回落到文档自身所在目录
     （`path.posix.dirname(selection.sourcePath)`），**绝不原样输出**。`scope` 的参照系是
     **该条目自己的 root**（主项目元数据 = `projectRoot`；`rootPath` 非空的附加根条目 = 该附加根），
     不是永远相对 `projectRoot`——这条同时决定了注入文本里那一列的读法。
  5. **退役别名重绑 + F2 重绑守卫**：`general-development` / `system-development` / `system-overview` /
     `system-debug`（`RETIRED_BUILTIN_MEKA_DEFAULT_ROLE_ALIASES`）的**会话绑定**在启动播种事务内
     重绑到 `<projectId>-default-role`，之后才删除 saga2 的内置行；固定目标映射
     （`combat-config` / `combat-debug` → `combat-development`）继续走原有 `[旧 id, 新 id]` 表。
     两张表的分工不得合并：别名依赖会话所属项目，表达不成二元组。
     **重绑语句必须带 `AND meka_project_id IN (SELECT id FROM meka_projects)`**：目标
     `<projectId>-default-role` 行只对**已登记项目**存在，而 `sessions.meka_project_id` 没有外键、
     会话可以在项目注册被移除后存活（历史软引用语义）。**理由是启动阻断**——orphan 项目的会话一旦被
     改绑就命中 FK violation ⇒ 整个播种事务失败 ⇒ `MIGRATE_FAILED` ⇒ **应用完全无法启动**。
     加守卫后这类会话的退役行随后被删、角色列由既有的 `ON DELETE SET NULL` 置空（与删项目／删角色
     同语义）；已登记项目（内置 `saga2` 与用户自建）都命中子查询，行为不变，**不得**为了「清理干净」
     去掉该守卫或放宽为项目无关。退役过滤**只在 saga2 的项目文件里生效**，导入路径**不跑**该过滤 ⇒
     导入含旧角色的配置会克隆成**新 id、`is_builtin=0`、显示名仍是「通用开发」**的自定义角色，
     属用户数据必须保留。
  6. **原 F3「战斗 workflow 的规范类元数据仍内联」（有意差异）已删除（2026-09-29）**：
     workflow 机制整体删除后，`roleFile.workflow` 字段与 `'saga2-combat-development-v1'` 判据都不复
     存在，`runtimeConfig.ts` 的 `agents-md` / `rule` 分支现在**只有一条路径**——一律产出
     `projectReferences`（地址 + 描述），**没有任何角色会走内联**。因此本项不再是「有意差异」，
     而是**唯一形态**；伴随它一起消失的还有那条 argv 代价（战斗角色内联大体积 `AGENTS.md`）的例外。
     退役说明见 **§8.12**。
     > **测试侧残留（未修，属他人工作项）**：`runtimeConfig.projectReferences.test.ts` 仍留着 F3 用例
     > `inlines project documentation for the combat workflow and references it otherwise`，
     > 它读取**已删除**的 `resources/meka/roles/combat-development.json` 并断言
     > `combat.workflow === 'saga2-combat-development-v1'`、`combat.projectReferences === []`
     > ⇒ 该用例**必然失败**，必须删掉或改写成「任何角色都走引用」的单形态断言。
  7. **F1 容错边界（故意的，反直觉）**：默认角色的 `includeAllProjectMetadata: true` 让项目**全部
     enabled 元数据**进入解析漏斗，因此失败半径按来源分岔——**仅由全量展开而来的项**解析失败
     ⇒ `log.warn` + **跳过该项**；**角色清单或项目 `roleDefaults.projectMetadataSelection` 显式选择的
     项**（含同一物理文件的两种情况）⇒ **仍然抛错**，不放宽作者配置的 fail-closed 契约。
     **任何来源都抛**：`rootPath` 不在允许根、`..` 逃逸、未知 `itemType` —— 这三项校验**位于容错边界
     之外**，不得被吞。原失败模式是「项目里一个坏文件让该项目**所有新建会话**无法创建」（默认角色是
     新会话默认选中项）。**这条边界只在「派生项没有被物化」时成立**：面板读到展开态后原样回传保存会
     把全量展开项写成作者显式选择，从而整批落进 fail-closed 一侧——写盘侧的剥离契约（两条入口在
     `normalizeMekaRoleManifest` 之前剥掉与派生结果深度相等的条目）与它的正向 / 反向 / 降级语义验收项
     见 **WL-11.10 第 7 条**。
- **代码锚点**（**2026-09-29 Meka 最小随包交付后逐条打开文件复核**；`runtimeConfig.ts` 本批被改动
  最多，行号漂移严重，**引用时以符号名为准**）：
  `apps/desktop/src/shared/meka-projects.ts:50-64`（`MekaProjectReference` 冻结接口，
  `scope` 的参照系注释在 `:51-57`）、`:372-377`（`RETIRED_BUILTIN_MEKA_DEFAULT_ROLE_ALIASES`）与
  `:360-363`（固定映射表 `RETIRED_BUILTIN_MEKA_ROLE_MAPPINGS`）、`:513`（别名重绑语句，含
  `AND meka_project_id IN (SELECT id FROM meka_projects)` 守卫）、`:561-566`（重绑 / 删行 /
  固定映射的循环顺序，`seedBuiltinMekaProjects` 本体在 `:437`）；
  `meka-projects/runtimeConfig.ts:83`（`MekaRuntimeConfig.projectReferences`）、
  `:390-397`（`isUsableScopePath`）、`:410-431`（`projectReferenceScope`）、
  `:438-457`（`projectReferenceDescription`）、`:460-467`（`compareProjectReferences`）、
  `:585-594`（`resolveBundledSkillSelections`）、
  `:910-921`（`agents-md` / `rule` 分支：**现在唯一形态就是写 `projectReferences`**，
  `inlineProjectDocumentation` 判据与函数**已删除**）、
  `:967-982`（F1 容错边界 catch）、`:1000`（按确定性顺序返回）、`:876-884`（`itemType` 穷尽性与
  路径契约校验，在容错边界之外）、`:485`（项目 metadata 的 Unity CLI-only 守卫）、
  `:857`（角色 manifest 的 Unity CLI-only 守卫）；
  **`migrateSAGA2CombatRoleSkills` 判据（原 `:104`）与它引用的两段 SAGA2 内存迁移已整体删除**；
  `meka-injection/mekaInjectionTypes.ts:57-60`（段 id 联合 = 3 个）与 `:68-72`
  （`MEKA_PROMPT_SEGMENT_ORDER`，order 65 在 `:70`）；
  `meka-injection/mekaPrompts.ts:35`（marker 常量 `MEKA_PROJECT_REFERENCES_MARKER`）与
  `:55-73`（段文本唯一来源，**禁止句含 `SKILL.md` 豁免的那一行在 `:70`**）、
  `meka-injection/mekaResolvePlan.ts:357-362`（bootstrap-only 推入，空集合不入 plan）；
  `meka-projects/metadataScanner.ts:55-97`（排除目录与 glob 列表，**本批未改**）、
  `:145-171`（描述上限与折叠、首句）、`:186-228`（frontmatter / 正文探测 `probeReferenceBody`）、
  `:230-282`（`describe` 的 `agents-md` / `rule` 分支）；
  `meka-projects/projectConfig.ts:309-376`（`normalizeMekaRoleManifest` 白名单式重建，
  `includeAllBundledSkills` 透传在 `:371-373`）、`:545-548`（退役 id 并集）、
  `:550-576`（`mergeBundledRoleFallbacks`，只对 saga2 生效的过滤在 `:559-560`）、
  `:505-530`（`readBundledRoleManifests` 的 **T3** 目录容错）、
  `:755-767`（`readBuiltinRoleManifestOrProjectDefault` 的 **T2** 回落）。
- **自动化门禁**：`pnpm --filter desktop exec vitest run src/main/meka-projects src/main/maker-ipc/__tests__/mekaRuntimeInjectionBaseline.test.ts src/main/maker-ipc/__tests__/mekaRuntimeInjection.test.ts`
  —— 断言 `projectReferences` 的 scope/path/描述有界与确定性排序（含 **F5** 的 `..` / 绝对路径拒收与
  「按条目自己的 root 计算 scope」）、**F1** 容错边界（全量展开项 warn+跳过、显式选择仍 fail-closed、
  root 越界 / `..` / 未知 `itemType` 任何来源都抛）、**`includeAllBundledSkills`** 的 catalog 全量展开
  与单条显式排除、`agents-md` / `rule` **正文不得
  出现**在注入文本里（反向断言，marker 与路径必须出现）、空集合不渲染、frozen 路径不含 order 65、
  退役别名重绑与「导入的同名克隆角色被保留」。
  > **2026-09-29 门禁口径变更（Meka 最小随包交付）**：原列表里的 **F3 战斗 workflow 内联旁路**断言
  > 已随 F3 本身删除（见上文第 6 条）。同时**这两条命令当前会红**，原因是**测试侧尚未清理**（属他人
  > 工作项，本清单**未代改任何测试**）：
  > ① `runtimeConfig.projectReferences.test.ts` 的 `expect(catalog).toHaveLength(10)`（随包 skill 现为
  > **1**）与 F3 用例（读已删除的 `resources/meka/roles/combat-development.json`）必然失败；
  > ② `mekaRuntimeInjectionBaseline.test.ts` / `mekaRuntimeInjection.test.ts` 仍在注入层 deps 里传
  > `probeRemoteCodexCapability` / `probeRemoteClaudeCapability`，并期望 `codexNativeSubagentsDisabled`
  > 出现在 `vendorOptions` —— 这两个 deps 与该键**已不存在于注入层契约**（typecheck 与运行期都会红）。
  > ⇒ **测试清理完成前，本项不得记为通过**；`order 65` 段本身的纯函数断言（段文本形态、`60 < 65 < 70`、
  > 空集合不渲染）不受影响，锚点见 `mekaPrompts.ts` 与 `mekaInjectionTypes.ts`。
  **这批生产侧断言落在 unit 层的新文件**
  `apps/desktop/src/main/meka-projects/__tests__/runtimeConfig.projectReferences.test.ts`
  （真实 `resolveMekaRuntimeConfig` + 临时目录夹具，16 条 `it`；**W25 批次终核为 19 条**）；**不得**把「有覆盖」读成
  「CI 真跑」——原先承载它们的 `runtimeConfig.integration.test.ts` 属于 `*.integration.test.ts`，
  而 desktop **没有 integration tier**，在 `test:unit` / `test:unit:related` / `test:db` / CI 里
  **都不会被执行**（详见 WL-11.10「自动化门禁」的 tier 提醒）。
  > **W25 批次更正（2026-09-23，只追加不改写上面的原句）**：① 计数由 16 增至 **19 条**（W25 逐条重数）；
  > ② 「原先承载它们的 `runtimeConfig.integration.test.ts` 不会被任何门禁执行」这句已**不适用于
  > 更名后的文件**——该文件**已于 2026-09-23 更名为 `runtimeConfigProjectFiles.test.ts`**，实测命中
  > desktop **`unit`(required) tier**，因此**会被** `test:unit` / `test:unit:related` 与 CI 执行；
  > 上面这批 `projectReferences` 生产侧断言所在的 `runtimeConfig.projectReferences.test.ts` 本来
  > 就在 unit tier，也**会**被执行。⇒ 当前准确的表述是「这批断言**有** CI 与提交前门禁覆盖」，
  > 而**不是**「有覆盖但没人跑」。旧名 `runtimeConfig.integration.test.ts` 实测仍为 `NO TIER`
  > （文件已不存在）。
  注入层的 `order 65` 段契约（文本形态、`60 < 65 < 70`、空集合不渲染、frozen 同进同出、正文负向断言）
  由 `mekaRuntimeInjectionBaseline.test.ts` 的第 16 组 9 条覆盖。
  **退役迁移的断言只在 `db` 层**：`mergeBundledRoleFallbacks` 的过滤、别名表的并集、重绑顺序
  （先建默认角色行 → `backfillSessions` → 重绑 / 删行 → 固定映射）、**F2 重绑守卫**
  （orphan 项目的会话不被改绑 ⇒ 播种事务不因 FK violation 失败）与幂等性都由
  `apps/desktop/src/main/localDb/__tests__/builtinMekaSeed.test.ts` 覆盖，而该文件被
  `scripts/test-workspaces.config.mjs` 归入 **`status: 'manual'` 的 `db` 层**
  （`desktopDbInclude` 的 `src/main/localDb/**/__tests__/*.test.ts`，且 `src/main/localDb/**`
  被 `unit` 层 exclude）⇒ **`pnpm test:unit:related` 与 `pnpm test:unit` 不跑它**。
  本项必须显式执行 **`pnpm test:db`**（外加
  `pnpm --filter desktop run typecheck`），否则「退役迁移有覆盖」这句话是假的。
  > **W25 批次更正（2026-09-23，只追加不改原句）**：原句说「与 CI 都不会跑它」**已过期** ——
  > `.github/workflows/ci.yml` 的两处「Run companion database regressions」步骤（linux shard 1 /
  > windows shard 1）已把 `src/main/localDb/__tests__/builtinMekaSeed.test.ts` 写进硬编码路径清单
  > ⇒ **CI 会执行它**。准确表述：`pnpm test:unit` / `test:unit:related` 不跑它（它不属 unit tier），
  > **CI 通过那条写死路径跑它**，本地要单独复现仍应显式 `pnpm test:db`。
  **本批未跑（未验证）**：上述期望**已同步**（新增 9 条见注入层文档 §6 第 16 组，**W25 终核为 10 条、
  该文件合计 28 条**；原有 10 条逐字节
  期望一个字符未改），但命令在本批**一次都没执行**（见 §8.5）。
- **实机验证**：`pnpm desktop:session-smoke` **输出两行本编号的检查结果**（脚本已按新契约重写、
  与 WL-11.17 对齐，未新增编号）——**本轮未实跑**：
  1. **`WL-11.17`（段注入检查）**：探针让运行中会话把 `[MEKA_PROJECT_REFERENCES]` …
     `[/MEKA_PROJECT_REFERENCES]` 之间的内容**逐行原样回显**；断言 marker 对齐、格式行逐字在场、
     每一行只能是模板行或 `- <scope> | <绝对路径> | <描述>` 条目行、条目路径 `path.isAbsolute`
     且 `fs.existsSync`、`scope` 非空且不是绝对路径。**负向硬失败**：段内出现任何 `#` 开头的
     Markdown 标题行、或任何既非模板也非条目的文本行；并从回显出的**真实地址**读前 8 KiB 取正文
     标志串，断言它**不出现**在段文本里。
  2. **`WL-11.17/退役重绑`（DB 检查）**：直接读 `meka_roles` 全表，对 6 个退役 id
     （`general-development` / `system-development` / `system-overview` / `system-debug` +
     `combat-config` / `combat-debug`）中 `is_builtin = 1` 的行报 FAIL；同 id 的**非内置**行按
     接受边界只登记、不报错（导入克隆的同名自定义角色是用户数据）。
     **覆盖边界（如实登记）**：这条 DB 检查只看 `meka_roles` 表，**看不到 F2 重绑守卫**
     （orphan 项目会话不被改绑、播种事务不因 FK violation 失败）——那条只有
     `builtinMekaSeed.test.ts` 在 `pnpm test:db` 里守；本批新增了该守卫，**未实跑**。
- **脚本自己声明的未覆盖项（如实登记）**：① **resume / frozen 不注入 order 65 段**需要旧会话，
  smoke 跑不出来（只有单测的第 16 组覆盖）；② 「模型没读清单里的文件就动手」这类 **WL-15 式负向
  断言仍然缺失**（语义降级风险没有任何实机断言）；③ **只读面板与不可删除的实机目检**属 WL-11.10，
  smoke 不覆盖；④ **Light / Dark 两种模式的目检未做**（也未声称复用既有主题即等于已验证）。

**未自动化 / 未覆盖的实机项**：新建**自定义**项目与角色（本机 profile 只有内置 SAGA2）、
删除项目后落入「不可用的 Meka 项目」组、正式事项（`meka-formal`）的 provider/auth/issue
全链路（需 Jira/GitLab 凭据），以及 WL-11.9 的界面实机路径（把项目目录移走后走一遍
「配置不可用 → 移除项目注册」）。WL-11.15 与 **WL-11.17** 的**端到端**部分（真实断流下的空回合、
以及**默认角色的 order 65 段里只出现路径+描述而 Agent 真的按需读了正文**）同样**尚未实跑**。
**原 WL-11.11–11.14 / WL-11.16 / WL-4.2.3 / WL-15 的端到端项（表范围全链路、插件侧白名单一致性、
P4 写边界、写入对账的真机封套核验、A3 镜像重启后为空、A4 成员清单真实会话登记）已随条目退役作废**
（2026-09-29，见 §8.12）；**其中 A3 / A4 涉及的机制本身也已删除**，不再是「未验证的存量项」。
这些仍按上文「实机验证」人工执行。

> migration 编号与冻结**不单列为白名单项**：那部分是上游自己的机制（`db:validate` +
> `migration-baseline.json` + Git 基线冻结）加上本仓工程规则，见 §7。

### WL-12 Meka 会话在横切域的守卫

**保护的不变量**：`'meka'` 会话**不被上游的横切能力误认领**：不进 scheduler / legacy cron
认领、不进 IM `/sessions` 选择器、`'meka'` 不泄漏进 scheduler 域；同时协同（Orca）资格
与远程 worker 目标对 Meka 正确成立。

**代码锚点**（2026-09-23 第三轮同步后实测；`scheduler-host/storage.ts` 的五处 `meka` 跳过为
`:826` / `:896` / `:1425` / `:1475` / `:1561`，其余锚点符号核对通过）
- `apps/desktop/src/main/scheduler-host/storage.ts:826,896,1425,1475,1561`
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
- `renderer/features/cc-agent/lib/sidebarProjectVisibility.ts` 的
  `sidebarSessionsWithHiddenProjectsAsDialogues`（约 `:145-165`）会把落在隐藏项目下的
  会话改写成 `'dialogue'`（改写点 `:162`），豁免只看 `'dialogue'`（`:40`、`:87`、`:101`）
  ——Meka 会话会被「降级」出 Meka 段并出现在普通对话分组（见 §8.4 与 WL-3.1 的「已知边界」）。

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

> **`pnpm test:runner` 的末尾新增一步（2026-09-23 第三轮同步登记）**：`test:runner` 在跑完
> `scripts/__tests__/**.test.mjs` 清单后，**末尾还会执行**
> `node apps/desktop/scripts/check-windows-atomic-rename.mjs`（见根 `package.json` 的
> `test:runner` 定义，`&&` 连接）。该脚本的行为是平台相关的：
> **win32 需要 `rustc`**（它用 `rustc --edition=2021` 现场编译
> `apps/desktop/native/windows-atomic-rename/main.rs` 并验证 junction 原子替换语义；`rustc` 缺失
> 或编译失败即红）；**非 win32 直接 skip 并以退出码 0 结束**（脚本第一段 `process.platform !== 'win32'`
> 即 `console.log('Windows atomic rename check skipped on this platform.')` + `process.exit(0)`）。
> ⇒ 在 macOS / Linux 上 `test:runner` 不受它影响；在 Windows 开发机上**必须装 `rustc`**，
> 否则 `test:runner`（连带 `test:unit` / `test:db` / `test:all` 等以 `pnpm test:runner &&` 开头的
> 根脚本）会因这一步失败。读红时先按此归类，不要当成本轮同步引入的失败。

**实机验证**：`pnpm audit:merge` 对历史事故提交 `01391448e9` 仍报出 `DROPPED`（含
hook-control 相关丢失）—— 证明门禁不是空转。

### WL-15（已退役：2026-09-29 Meka 最小随包交付）

> **已退役，编号保留为空缺、不得复用。** 本项能力 = 「Meka 角色 Skill 注入必须走非 argv 载体」，
> 它的**唯一锚点**是战斗总控 Skill 正文的路径化注入（`combatControllerSkillPrompt` /
> `[SAGA2_COMBAT_CONTROLLER_SKILL]` / `combat-skill-configuration` 冻结快照），已随
> **workflow 机制 + 内置提示词正文 + bundled skill** 三类删除一并消失。退役原因与同批条目一览见
> **§8.12**；原始正文里的代码锚点、自动化门禁与实机证据**全部作废**，不得据此条目执行任何验证。
> 事故本体与修复记录仍保留在
> [`../migrations/xdmaker-meka-to-cindy.md`](../migrations/xdmaker-meka-to-cindy.md) §6.43 与
> [`pi-harness.md`](pi-harness.md) 第 4 节不变量 12（那是历史事实，不是本清单的现行验证项）。
>
> **仍然成立的那一半不变量（改挂 WL-11.17）**：「体积不可控的静态文本必须走非 argv 载体」这条判据
> 没有消失 —— 项目规范类元数据（`agents-md` / `rule`）仍**不得把正文内联进任何 prompt 段**，
> 交付形态仍是 order 65 段 `[MEKA_PROJECT_REFERENCES]` 的「作用范围 + 绝对路径 + 描述」。
> 该不变量、代码锚点与门禁现**全部登记在 WL-11.17**。**本编号不再承载任何断言。**

### WL-16 Meka 注入层契约与 Agent 能力矩阵

**保护的不变量**：Meka 会话注入收束为显式三层（解析 → 计划 → 落地）后，各入口形态
**各自只有一个入口**（形态 A `applyMekaRuntimeConfig` / 形态 B `registerMekaCapabilities`，
无第二入口、无 re-export 双入口）。
> **2026-09-29 更正（Meka 最小随包交付）**：**形态 C（`prepareCombatFollowupRuntimeContext`，
> 每轮续聊的战斗契约）已随 workflow 机制整体退役** —— `meka-injection/index.ts` 的文件头注释与
> `meka-injection-layer.md` §2 都写明「本层不再有第二个入口」。原文「计划文本写作『四种入口』而
> 实现是 3 个形态 + 1 组共享解析入口」这句随之为**2 个形态 + 1 组共享解析入口**（形态 A 的
> `resolveMekaInjection` + `applyMekaInjection` 两个子步骤）。

`MEKA_PROMPT_SEGMENT_ORDER` 是**契约不是实现细节**——新增段落只能插空档（如 15/25/45/55/75），
**不得重排既有段落**；段集合**现为 3 段**：`meka.role-context: 60` / `meka.project-references: 65`
（只在 bootstrap 注入、空集合不渲染，**WL-11.17**）/ `meka.role-prompt: 70`；
**批注（2026-09-29）**：原文的「2026-09-23 起段集合多了一段」是在当时 **10 段**的集合里插入 65，
本次交付把另外 7 个战斗段与 order 行一并删除 ⇒ 引用段数/段序时必须按**当前的 3 段**写，
改段集合或 order 必须同一次交付里更新本条与
[`meka-injection-layer.md`](meka-injection-layer.md) §3 的段序表；`MEKA_AGENT_CAPABILITIES`
必须**覆盖全量 `AgentKind`**，且声明必须与
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
不变量 I1 的对照范围仍是「与重构前逐字节一致」，**新增的 order 65 段不参与该对照**（它是新段，
没有「重构前」形态），但它与其它段一样必须从 `mekaPrompts.ts` 取文本、必须确定性渲染。
有意差异登记在 [`meka-injection-layer.md`](meka-injection-layer.md) §7（2026-09-23 起多一条 **D2.4**；
**2026-09-29 追加**：7 个战斗段与其 order 行、形态 C、`MekaInjectionPlan.diagnostics` 的三个
workflow 成员一并删除 —— 后者见 `mekaInjectionTypes.ts:130-133` 的注释）。

**代码锚点**（**2026-09-29 逐条打开文件复核**；以符号名为准）
- 分层与入口：`apps/desktop/src/main/meka-injection/index.ts:42`（形态 A `applyMekaRuntimeConfig`，全文件 53 行）、`mekaMcpRegistration.ts:53`（形态 B，生产唯一调用点 `maker-host/index.ts:2367`，位于 `_mcpProviders.pi` 赋值 `:2362` 之后）；**形态 C 已不存在**
- order 表与段落工厂：`meka-injection/mekaInjectionTypes.ts:68-72`（`MEKA_PROMPT_SEGMENT_ORDER`，3 段；order 65 在 `:70`）、`:82-84`（`createMekaPromptSegment`，调用方不得手写 order）；渲染 `mekaApplyPlan.ts:51-75`；order 65 的推入点 `mekaResolvePlan.ts:357-362`
- 能力矩阵：`meka-injection/mekaAgentMatrix.ts:41-63`（`claude-code`/`codex`/`pi` 三列全为 `true`，pi 在 `:62`）、`:74-76`（`MEKA_AGENT_KINDS` 冻结）、矩阵与能力条目三层 `Object.freeze`、`:79-81`（`mekaRuntimeMcpAgentKinds`）
- 漏传硬失败：`mcp-integrations/meka-runtime-mcp.ts:1071`（`declareMekaRuntimeMcpAgents`：必须覆盖全量 `AgentKind`，否则抛）；`meka-injection/mekaMcpRegistration.ts:66-72`（`runtimeMcp:true` 取不到数组直接抛；`runtimeMcp:false` 的 `skipped` 分支保留在 `:60-63`，当前无人走到）
- 入口导出面收紧：`meka-injection/index.ts:30-34` 只转出公共签名类型（三个），形态入口只有 `applyMekaRuntimeConfig`；形态 A 的两个子步骤与层内计划类型**不再转出**（`meka-injection-layer.md` §2）
- 旧路径已删除：`maker-ipc/mekaRuntimeInjection.ts` **不存在**（原 688 行已拆分到 `meka-injection/`），`maker-ipc/register.ts:623` 仅改 import 路径；`meka-injection/mekaCombatPrompts.ts` 已改名为 `mekaPrompts.ts`
  > **锚点更正（2026-09-29，`meka-runtime-mcp.ts` 因删除两个战斗工具与战斗依赖恢复整体前移）**：
  > 原文的 `meka-runtime-mcp.ts:1446` / `:1458-1465` / `:1466-1475` / `meka-injection/index.ts:51` /
  > `:28-42` / `mekaResolvePlan.ts:816` / `mekaAgentMatrix.ts:38` / `:71` / `:76` /
  > `maker-host/index.ts:2303` / `:2308` / `register.ts:583-584` 均已过期，上列是复核后的当前值。

**自动化门禁**
- `pnpm --filter desktop exec vitest run src/main/meka-injection src/main/maker-ipc/__tests__/mekaRuntimeInjectionBaseline.test.ts src/main/maker-ipc/__tests__/mekaRuntimeInjection.test.ts`
  —— 矩阵穷尽性、Pi 两列 `true` 与三层冻结（`agentMatrix.test.ts` 4 用例）、注册漏传/矛盾硬失败与 maker-host 接线形状（`mcpRegistration.test.ts` 12 用例）、注入文本逐字节基线（`mekaRuntimeInjectionBaseline.test.ts` **共 28 条**（W25 批次终核；本轮之前的记录写 27 条）：原有 10 条快照用例钉住 `opts.userPrompt` 全文、`vendorOptions` 全量键值及键顺序、`nativeSkillPluginPath`/`nativeSkillRevision`；另加 4 组重构后追加用例各 1–3 条 —— 第 11 组（2 例）钉住非字符串 `userPrompt` 在 Meka 路径显式报错（D2.1），第 12 组钉住非 Meka 路径零影响（I6），第 13 组钉住 resume 短路下 `Object.keys(opts)` 新增键顺序（D2.2，不可观测、仅锁现状），第 14 组补 frozen + target 补丁的 `vendorOptions` 键序，第 15 组（3 例）钉住解析／物化抛错时 opts 零写入（D2.3）；**第 16 组 10 条**（8 个逐个 `it` + 1 组 `it.each`（2 条））钉住 order 65 段，见注入层文档 §6）
  > **⚠️ 2026-09-29（Meka 最小随包交付）**：这套命令**当前会红**，原因是**测试侧尚未清理**（属他人
  > 工作项，本清单未代改任何测试）：`mekaRuntimeInjection.test.ts` / `mekaRuntimeInjectionBaseline.test.ts`
  > 仍在注入层 deps 里传 `probeRemoteCodexCapability` / `probeRemoteClaudeCapability`，并期望
  > `codexNativeSubagentsDisabled` 出现在 `vendorOptions`（`mekaRuntimeInjectionBaseline.test.ts`
  > 约 `:462` / `:518` / `:547` / `:615` / `:664` / `:797` / `:812` 一带，`mekaRuntimeInjection.test.ts`
  > 约 `:1534` / `:1644`）—— 这两个 deps 与那个键**已不存在于注入层契约**（`ApplyMekaRuntimeConfigDeps`
  > 里没有它们，`mekaResolvePlan.ts` 也不再产出该键）。**清理前本项不得记为通过**，counts（28 条等）
  > 也**不再是当前文件的条数**。
  > **本批（2026-09-23）的状态**：默认角色由零注入改为出厂全量、新增 order 65、`agents-md` /
  > `rule` 改引用投递（§7 D2.4）——期望值**已同步**（`mekaRuntimeInjectionBaseline.test.ts` 新增
  > `meka project references segment (order 65)` 一组 9 条，见注入层文档 §6 第 16 组；原有 10 条
  > 逐字节期望因空集合不渲染而**一个字符未改**），但这套命令**在本次交付里一次都没跑**。
  > **未验证，不得当作已通过。**
  > **（W25 批次终核，只追加不改写上面的当轮记录）**：该组现为 **10 条**（8 个逐个 `it` +
  > 1 组 `it.each`（2 条）），该文件合计 **28 条**，上文「一组 9 条」与「共 27 条」是 W25 重数前的
  > 数字；**W25 批次同样一次都没跑这套命令**，未验证状态不变。
- `pnpm test:runner`（含 `scripts/__tests__/meka-whitelist-contract.test.mjs` 的本文档结构契约：字段完整、命令可解析、编号唯一升序、被索引）
- `pnpm --filter desktop typecheck`（矩阵是 `Readonly<Record<AgentKind, …>>`，maker-core 新增 `AgentKind` 而矩阵未填 ⇒ 编译失败）

**实机验证**：`pnpm desktop:session-smoke` 的 **WL-11.1–WL-11.8**（真实建会话并调用模型，
交叉核对库行 / main 日志里的运行期配置 / 技能快照）—— 注入层是这 8 项的共同运行期前置，
矩阵或 order 表被改坏会在 WL-11.4（真实跑完一轮）/ WL-11.5（`[MEKA_ROLE_CONTEXT]` 回显）/
WL-11.6（角色级 MCP / 快照技能）先红（**2026-09-29 更正**：原文写的「workflow」已不再是 WL-11.6
的断言对象，见 WL-11.6 与 §8.12）。**本轮（2026-09-20 注入层重构）未实机跑**：
worktree 内无宿主运行实例，登记为「未验证 + 原因」，由合入后在 base repo 实跑；
本轮已跑的自动化证据见上行。
**2026-09-23（order 65 / 默认角色反转）同样未实机跑**：`pnpm desktop:session-smoke` 与
`pnpm desktop:session-smoke -- --role 默认角色` 都没执行，尽管 `scripts/meka-session-smoke.mjs`
**已按新契约重写**（WL-11.6 的新反向断言 + WL-11.17 的两行检查）。
**2026-09-29（Meka 最小随包交付）仍然没跑，并且 smoke 脚本本身现在需要先改**（战斗角色分支会自报
「未找到角色清单」，见 WL-11 的 2026-09-29 块与 §8.12 第 4 条第 7 项）。

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
`legacyRole` **携带但不恢复**（运行期对**该项目**的共享默认角色
`<projectId>-default-role` 会自行派生 —— 2026-09-23 之前写死为 saga2 的 `general-development`，
该角色已退役，见 `shared/meka-projects.ts` 的 `RETIRED_BUILTIN_MEKA_DEFAULT_ROLE_ALIASES`；
导入端刻意不复制）。

**代码锚点**：`session-share/xdtshareFormat.pure.ts:260`（`XdtshareMekaManifest`）、`:243`、`:246`、`:297`、`:438`（`validateMekaSection`，坏字段 ⇒ `SHARE_FILE_INVALID`）、`:47`/`:49`（版本常量）；
`session-share/sessionShareExport.ts:694-695`（仅 Meka 行构造该段）、`:817`（`coarseWorkspaceKind`；`manifest` 在 `:711`、`session.json` 在 `:786` 写同一口径）、`:699-705`（formatVersion 2 / minReaderVersion 不抬）；
`session-share/mekaShareBinding.ts:125`（只读解析）、`:150`、`:155-171`、`:175-177`、`:203-211`、`:32-42`（五种降级原因）；
`session-share/sessionShareImport.ts:421-427`（导入前解析）、`:429-430`（忽略传入 workingDir）、`:630`/`:1466`（损失 note）、`:660`（不套 worktree）、`:960`（route lock）、`:992`/`:1483`（提交后一条 UPDATE 落绑定）；
`meka-injection/mekaResolvePlan.ts:302-304`（半绑定行的运行期拒绝：`throwIpcError('INVALID_PARAMS', 'Meka session requires a project and role')`）、`:351`（首次启动按本机角色重新冻结快照的物化点；`nativeSkillMount` 在 `:156-162`）；**注入层现在完全不读 `opts.workingDir`**（该文件全文零命中）
> **锚点更正（2026-09-29）**：本行原文的 `:587-589` / `:645` / `:194-199` / `:721` 与
> 「`combatProjectPathsPrompt(opts.workingDir)` 注入项目路径段」都已过期 —— 该函数已随战斗段删除，
> 项目根改由 `resolveMekaRuntimeConfig` 从**项目行**（`meka_projects.path`，`'saga2'` 走 P4 根
> sentinel）解析，不再经注入层传入。上列是复核后的当前值。
> `session-share/**` 与 `localDb/mekaWorkspace.ts` **本批未被改动**，其锚点未变。
`localDb/mekaWorkspace.ts:26`（工作目录解析器本体，导入端与新建 Meka 任务共用；新建任务侧调用点 `localDb/ipc/sessions.ts:1360`）；
`SessionShareImportWizard.tsx:200-203`（绑定可恢复则不需要用户选目录）。

**已知限制（有意取舍，可选后续项）**：绑定由导入事务**提交之后**的一条 `UPDATE` 写成，未进入
事务 INSERT 的固定列清单——`localDb/worker/opHandlers/tx.ts:2731-2737`、
`localDb/client/WorkerThreadTransport.ts:1181-1182`、`localDb/client/tx/types.ts:482-513`
三处在本次改动范围之外。窗口内崩溃留下的是**完整普通任务**，不是脏行。

**自动化门禁**：`pnpm --filter desktop exec vitest run src/main/session-share`
—— `sessionShareImport.test.ts`（**Meka 绑定断言自 `:1767` 起共 10 条**（2026-09-23 第三轮同步实测；
此前记 `:1731` 起）：`:1767` 可解析包导入真 Meka 任务 / `:1815` 项目缺失 /
`:1829` 角色缺失 / `:1845` 角色属于别的项目 / `:1860` P4 根未配置 / `:1876` 遗留包 /
`:1903` 绑定写入失败 / `:1913` 无 `meka` 段的包行为不变 /
`:1935` 导出→导入往返保住绑定 / `:2020` 协同包只绑 lead）、`sessionShareExport.test.ts`（3 条）、
`xdtshareFormat.pure.test.ts`（2 条）。
**验证状态（2026-09-22 登记）**：用例已随改动落地，但**登记人未运行**（未跑任何仓库门禁）；
本项全部锚点由阅读当前源码得出，属 documented-only。
> **夹具更正（2026-09-23 W25 批次，只追加不改写上面的原句）**：上面「角色缺失」那条用例的角色行
> 夹具原先**手写字面量**（硬编码 `general-development` 等可能已不存在的角色行）⇒ 夹具本身掩盖了
> 「角色被删/改名后导入应走 `role-missing`」这条行为（假绿）。现已改为**从包内注册表派生**
> （`BUILTIN_MEKA_PROJECTS` + `mekaDefaultRoleId`，`sessionShareImport.test.ts` 的
> `bundledDefaultRoleRow`）：注册表里查不到 ⇒ 夹具**不再提供该行**，导入端会真的走 `role-missing`。
> 登记的是**夹具现在派生自注册表**，**不声称这些用例已实跑**（W25 未跑任何门禁）。

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

**代码锚点**（**2026-09-29 逐条打开文件复核；`meka-runtime-mcp.ts` 因删除两个战斗工具与战斗依赖恢复
而整体前移**）：`meka-injection/mekaAgentMatrix.ts:41-63`（三层冻结矩阵）、`:62`（pi 两列 `true`）、
`:74-76`、`:79-81`；
`mcp-integrations/meka-runtime-mcp.ts:77-80`（`isHarnessBridgeBootstrapContext`；两个 agent 的判定在
同一行 `:79` 的 `return context.agentKind === 'codex' || context.agentKind === 'pi'`）、`:870-887`（`routerProvider`，`name: 'mcp_router'` 在 `:871`）、`:931-950`（`mekaDesignProvider`）、`:952-1037`（`InlineMekaMcpProvider`）；
`maker-host/index.ts:2362`（`_mcpProviders.pi` 赋值）与 `:2367`（注册调用点，在其之后）；
`packages/maker-core/src/agents/pi/host-skill-mount.ts:69`（`:76` 远端会话、`:77` review、`:51-60` 入口判定、`:83-85` 隐藏项与 symlink、`:89`/`:94-96` 降级、`:62-68` 稳定性要求）；
`packages/maker-core/src/agents/pi/index.ts:205`（import）、`:3727`（调用）、`:3732-3738`（unavailable 留痕）、`:3764`（argv 注入，排在 `:3765-3767` 的项目/Bot Skill 之前）、`:3770`（argv 预算守卫）；
`meka-injection/mekaInjectionTypes.ts:96-99`（`MekaNativeSkillMount`）、`meka-injection/mekaMcpRegistration.ts:26-52`（注释块）与 `:60-63`（`skipped` 保留分支）。
> **锚点更正（2026-09-29）**：原文的 `mekaAgentMatrix.ts:38` / `:59` / `:71` / `:76`、
> `meka-runtime-mcp.ts:180` / `:1193` / `:1254` / `:1274`、`maker-host/index.ts:2303` / `:2308`、
> `mekaInjectionTypes.ts:117-123` 均**已漂移**，上列是复核后的当前值。**注意**：本次交付**没有**删除
> `isHarnessBridgeBootstrapContext`（它仍必须同时含 `codex` 与 `pi`，`codex`/`pi` 判定在 `:79`）——
> 该不变量原样成立，只是行号变了（见本文 §8 的禁止事项）。

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

**实机验证**：**未实机验证**。待跑：真实 Electron 建一个**配了角色级技能**的 Pi Meka 任务，确认角色技能
快照被 Pi 加载且 `mcp_router` 工具可真实调用；确认远端（SSH / MCPRouter worker）Pi 会话不挂本地
快照；确认普通 Pi 会话调 `mcp_router` 时 fail closed 的报错文案。
`desktop:session-smoke` 未跑。
> **2026-09-29 更正**：原文写「Pi 的 Meka **战斗**角色任务」——战斗角色（`combat-development`）与其
> 随包清单已删除，这类任务只能用**项目自有角色 / 默认角色 + 项目或插件技能**来构造（见 §8.12）。

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

**代码锚点**（**2026-09-29 逐条打开文件复核；三道守卫全部仍在，但行号已漂移**
——`runtimeConfig.ts` 本批被大改）：三道守卫 `meka-projects/runtimeConfig.ts:480-487`（项目 metadata）、
`:853-858`（角色 manifest）、`mcp-integrations/meka-runtime-mcp.ts:1123-1125`（inline transport，
抛点在 `:1124`）；
产品口径正文 [`../product-rules/meka-skills.md`](../product-rules/meka-skills.md) 的 Unity 段；
SAGA2 工作区清理与未完成项见
[`../migrations/xdmaker-meka-to-cindy.md`](../migrations/xdmaker-meka-to-cindy.md) §6.55。
> **锚点更正（2026-09-29）**：原文的 `runtimeConfig.ts:403-409` / `:644-647` 与
> `meka-runtime-mcp.ts:1496-1500` 均已过期。**本次交付明确禁止删除这三道守卫**（它们属机制，
> 不属 workflow / 提示词 / skill 三类），实测仍在：项目 metadata 守卫在
> `Meka project metadata entry is not supported` 一带（`:485`）、角色 manifest 守卫在
> `a Unity MCP role entry is not supported`（`:857`）、inline transport 守卫在
> `prepareMekaRuntimeMcp` 内（`:1124`）。

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

### WL-20 孤儿内置角色行的读时回落（T2，2026-09-29 登记）

**保护的不变量**：用户库里 `is_builtin = 1` 的角色行**指向的随包清单文件可能已经不存在**（本次交付
删掉了 `resources/meka/roles/combat-development.json`，而**明确不做 DB 迁移**，孤儿行因此**必然
残留**）。这种行**不得**让会话打不开或让面板僵尸行报错：读取侧必须**回落到该项目自己的**共享默认
角色 `<projectId>-default-role`（由内存函数 `mekaDefaultRoleManifest()` 提供、从不落盘）并
`log.warn` 留痕。**只对「清单文件不存在」回落**——文件在而内容非法仍抛错（那是真实配置错误，
不得伪装成默认角色）。回落必须**两处共用同一条实现**：会话解析（`resolveRoleFile`，抛错 =
台账打不开）与面板读清单（`readRoleManifest`，抛错 = 僵尸行点开就报错）。

**代码锚点**：`apps/desktop/src/main/meka-projects/projectConfig.ts:755-767`
（`readBuiltinRoleManifestOrProjectDefault`：`tryReadBuiltinRoleManifest` → 缺失则 `log.warn` +
`mekaDefaultRoleManifest(projectId)`；**严格的 `readBuiltinRoleManifest`（`:732-739`）原样保留、仍是
唯一的事实源**）；消费点 `meka-projects/runtimeConfig.ts:732-737`（`resolveRoleFile` 的
`row.is_builtin === 1` 分支）与 `localDb/ipc/mekaRoles.ts:614-631`（`readRoleManifest` 的
内置行分派，import 在 `:27`）。

**自动化门禁**：`pnpm --filter desktop exec vitest run src/main/meka-projects src/main/localDb/__tests__/builtinMekaSeed.test.ts`
（`projectConfig.test.ts` 的「内置清单存在时仍读文件」与「文件缺失 ⇒ 回落、不抛」两侧、
`mekaDefaultRole.test.ts` 的 mock 契约、`builtinMekaSeed.test.ts` 的播种后孤儿行仍在）
—— **⚠️ 这条命令当前会红**，原因与本项无关（测试侧残留，见 §8.12 第 4 条）；
`pnpm --filter desktop run typecheck`。

**实机验证**：**未实机验证**。待跑（升级库形态）：在库里留一行 `is_builtin = 1` 的
`combat-development`（模拟存量用户），然后 ① 用该角色**新建 Meka 会话必须成功**，注入退化为
「该项目默认角色 + 平台基线 + order 65 引用清单」；② 在项目/角色面板点开该角色行**不得报错**
（显示的是回落后的默认角色清单），且 main 日志出现 `builtin Meka role manifest is missing; falling
back to the project default role`；③ **负向**：把该角色的清单文件放回但写成非法 JSON，必须**仍然抛错**
（回落只覆盖「文件不存在」）。

**不得据此做反向动作（红线）**：本项**不允许**在读取侧或迁移侧删除/降级用户库里的孤儿行 ——
「不清理孤儿行、只在读时容错」是维护者裁定的范围（不动项目/角色机制），见 §8.12 第 1 条。

### WL-21 空的随包内置角色目录（T3，2026-09-29 登记）

**保护的不变量**：`apps/desktop/resources/meka/roles/` 现在**没有任何随包角色清单**，而 **git 不跟踪
空目录** ⇒ 新 clone / CI / 干净 checkout 下该目录**不存在**。`readBundledRoleManifests` 的 `readdir`
遇到 `ENOENT` **不得抛错**，必须按「没有内置角色」返回 `[]` 并 `log.warn`；**其余 errno 照旧上抛**
（目录在但读不了是真实故障，不得静默当成「没有内置角色」）。`resources/meka` 本身**仍非空**
（`README.md` + 1 个 skill），打包前的资源树门禁因此仍然通过。

**代码锚点**：`apps/desktop/src/main/meka-projects/projectConfig.ts:505-530`
（`readBundledRoleManifests`：`try { readdir } catch { errno !== 'ENOENT' ⇒ throw; log.warn; return [] }`，
`:507-509` 是理由注释）；消费点 `readProjectConfigState`（`:637`）与 `saveProjectConfig`（`:694`）；
随包资产现状 `apps/desktop/resources/meka/`（`README.md`、`projects/saga2/project.json`、
`skills/通用/platform/platform-capabilities/SKILL.md`）；资源树门禁
`apps/desktop/src/main/__tests__/forgeMekaResources.test.ts`。

**自动化门禁**：`pnpm --filter desktop exec vitest run src/main/meka-projects src/main/__tests__/forgeMekaResources.test.ts`
（`projectConfig.test.ts` 的「目录缺失 ⇒ `[]` 且不抛」与「非 ENOENT ⇒ 抛」两侧；`forgeMekaResources.test.ts`
的「`resources/meka` 非空 ⇒ 打包门通过」）。

**实机验证**：**未实机验证**。待跑：在**干净 checkout**（`roles/` 目录不存在）里启动应用并读一次项目
配置 —— 必须没有任何 ENOENT 报错，且 `resources/meka/roles` 缺失被记为一次 `warn`；打包产物里
`process.resourcesPath/meka` 下有 `README.md` 与那一个 skill。

**边界（如实登记）**：本项只保证「目录不存在」被容错，**不保证**该目录存在；`resources/meka/README.md`
已写明 `roles/` 是「预留给随包角色清单、当前不存在」，**不得**为了让门禁有东西可读而随包一个占位角色。

### WL-22 角色显式选择的未知 bundled skill 的读时回落（T1，2026-09-29 登记）

**保护的不变量**：角色清单（**含用户项目文件 `builtinRoles` 里的快照**）显式选择的 skill id 若在
随包 catalog 里查不到，`resolveMekaRuntimeConfig` 的 skill 循环**不得**让整个会话解析失败，必须
`log.warn` + 跳过该 id。**平台基线 id（`MEKA_PLATFORM_SKILL_IDS`）例外：取不到仍然硬失败** ——
那是包损坏而非历史残留，静默降级会让平台能力悄悄消失。

**为什么必需**：`resolveRoleFile` 里**用户项目文件的 `builtinRoles` 快照优先于 T2 回落**，而旧版
角色编辑器 / `mergeBundledRoleFallbacks` 会把随包角色（含其 `skills` 选择）整份写进该快照 ⇒ 一个
仍列着 `combat-skill-configuration`（已随包删除）的存量快照会让**新会话建不出、存量会话打不开**。

**代码锚点**：`apps/desktop/src/main/meka-projects/runtimeConfig.ts` 的 skill 循环
（`~:848-860`：`if (!catalog.has(id) && !isMekaPlatformSkillId(id)) { log.warn; continue; }`）、
辅助判据 `isMekaPlatformSkillId`（`~:38-41`）、平台白名单 `MEKA_PLATFORM_SKILL_IDS`（`:37`）、
严格读取 `readBundledRuntimeSkill`（`~:265-281`，仍对平台 id 抛 `unknown bundled Meka skill`）。

**自动化门禁**：`pnpm --filter desktop exec vitest run src/main/meka-projects`（未知 id 跳过、
平台 id 仍抛两侧）。

**实机验证**：**未实机验证**。待跑：在库里放一个 `builtinRoles` 快照（含一个不存在的 skill id）的
项目上建新会话 —— 必须能建出并只记一次 `warn`；再把 `platform-capabilities` 从资源树移走 ——
必须仍然硬失败。

**边界（如实登记）**：只容忍「catalog 里查不到」；id 在 catalog 里但读取失败 / frontmatter 非法仍
上抛（那是包损坏）。清空 `saga2/project.json` 的 `roleDefaults.skills` 是**另一层**内容修正
（消除随包内引用），**不能替代**本项。

### WL-23 角色 prompt fragment 文件缺失的读时回落（T4，2026-09-29 登记）

**保护的不变量**：角色清单里的 `promptFragments[].path` 解析出的文件**不存在**时，`promptText`
组装**不得**让整个会话解析失败，必须跳过该条 + `log.warn`；**路径逃逸 / 非法编码 / 空 path 等真实
配置错误照旧上抛**（只容忍 `ENOENT`）。

**为什么必需**：`combat-development` 的内置快照携带 5 条 `promptFragments`（`prompts/combat-*.md`
×5，已随包删除），而快照优先于 T2 且按「内置行」解析 ⇒ fragment 根仍是 `resources/meka/roles/`
⇒ **ENOENT**。曾一度判断「唯一声明 fragment 的角色已随包删除 ⇒ 没有触发路径」并回退本项，
**该判断是错的** —— 它漏了用户项目文件里的快照，会让这类项目新会话建不出、存量会话打不开。

**代码锚点**：`apps/desktop/src/main/meka-projects/runtimeConfig.ts` 的 fragment 循环
（`~:809-834`：`try { readRoleRelativeFile } catch { code !== 'ENOENT' ⇒ throw; log.warn; continue }`）；
解析与逃逸校验 `readRoleRelativeFile` / `resolveRoleRelativePath`；空 path 的显式错误不变。

**自动化门禁**：`pnpm --filter desktop exec vitest run src/main/meka-projects`（ENOENT ⇒ 跳过 +
一条 `warn`；逃逸路径 ⇒ 仍抛两侧）。

**实机验证**：**未实机验证**。待跑：在库里放一个带已删 fragment 路径的 `builtinRoles` 快照的项目上
建新会话 —— 必须能建出、跳过该 fragment、并记一次 `warn`。

**边界（如实登记）**：仅容忍 `ENOENT`；不得把真实的逃逸 / 编码错误也吞掉。**T5（合成默认项目配置）
有意未落地** —— `saga2/project.json` 继续随包 ⇒ 项目配置缺失不触发，且合成默认配置属动机制。

### WL-24 随包 SAGA2 元数据基线与真实工作区的一致性（2026-09-29 登记）

**保护的不变量**：`apps/desktop/resources/meka/projects/saga2/project.json` 的 `metadata[]` 是**随包出厂基线**，
它是「没有项目根 override 时」的 order-65 项目参考清单正本。它的每一条必须满足：

1. **机械字段与真实工作区一致** —— `sourcePath` / `itemType` / `name` / `contentFingerprint`
   （`sha256(file bytes)`）/ `subProjectPath` 必须与 <P4 根> 上现行文件逐一对应；
2. **策展字段是人写的且不注入失效信息** —— `description` 是**注入给模型的提示词内容**，必须
   （a）长度 ≤ 300 码点（超限会在运行期被截断补 `…`，超出部分等于死文本）、（b）不含换行 / 竖线 /
   反引号（否则破坏 `作用范围 | 绝对路径 | 用途` 的行格式）、（c）描述**文件当下真实内容**，
   文件正文自身失真时以事实为准而不是照抄；
3. **`basic.path` 必须保持 token `saga2`** —— 写成绝对路径会把基线绑死到某台机器；
4. **`enabled: false` 的条目不得被重扫翻回 true**（本次为 5 条），且**每条禁用都必须在 `notes` 里
   留痕**（为什么禁用 + 权威副本在哪）—— `notes` 不进 prompt，是唯一既持久又不花 token 的登记处；
5. **别名只有两种合规形态** —— 同目录 `CLAUDE.md` 与 `AGENTS.md` **逐字节相同**，或
   `CLAUDE.md` 一侧内容仅为 `@AGENTS.md` 一行。内容副本即视为漂移（见 §6 的真实事故）。

**为什么需要它**：项目根 override 存在时随包基线被**整体遮蔽**（metadata 数组不与 override 合并），
但**新机器、干净 profile、override 解析失败回落**时它以正本身份生效；且 `description` 会作为
order-65 段的「用途」列进入模型上下文，属于**随包注入内容**，正是本仓「随包只留平台机制、内容摆在
台面上」这条边界的落点。

**代码锚点**：`apps/desktop/src/main/meka-projects/metadataScanner.ts:338`（`sha256` 指纹）、
`:21-46`（重扫写什么、留什么：保留 `description`/`displayName`/`notes`/`enabled`/`disciplines`/`domains`，
重写 `name`/`contentFingerprint`/`subProjectPath`/`sourcePath`）、`:293`/`:309`/`:329`/`:420`
（别名漂移检测的判定与调用）、`projectConfig.ts:633-678`
（随包基线 → 项目根 override 的读取优先级，metadata 不合并）、`projectConfig.ts:686-698`
（写盘只写 `<projectRoot>/.meka/project.json`，**从不写随包文件**）、`runtimeConfig.ts`
（order-65 `projectReferences` 的构造与 300 码点折叠、`:204-226` 重名 skill 的 `-2` 消歧）。

**自动化门禁**：`pnpm --filter desktop exec vitest run src/main/meka-projects`。其中：
- `runtimeConfigProjectFiles.test.ts` **直接读取本文件**（随包真实基线）解析角色与项目默认 MCP；
- `projectConfig.test.ts` 断言 `metadata.length > 30`；
- **`saga2BundledBaseline.test.ts`（本项专用守卫，8 例）**：严格 `JSON.parse`、头部身份、
  `basic.path` 非绝对、逐条字段完整性（含 `enabled` 必须是 boolean、`rootPath` 必须缺省）、
  键唯一、描述 ≤ 300 码点且不含 `|` / 反引号 / 换行、**禁用条目必须带 `notes`**、
  `projectMetadataSelection` 无悬空引用。已做变异咬合证明（指向坏副本 ⇒ 相应断言变红并点名条目）。
- **禁止**用 PowerShell 的 `ConvertFrom-Json` 代替严格解析：它容忍尾随逗号，Node/Electron 不容忍
  —— 本仓真实发生过一次（尾随逗号 ⇒ 31 个单测红）。

**实机验证**：**未实机验证**（本次只做了静态 + 严格解析 + 单测 + 对真实工作区只读实跑别名谓词）。
待跑：在**没有**项目根 `.meka/project.json` 的干净环境里启动应用，读一次项目配置，确认 order-65
参考清单为 66 条、描述未出现截断 `…`、`enabled=false` 的 5 条未被注入；并在打包产物上确认别名
漂移告警按预期出现。

**边界（如实登记）**：本项目根的 override 是**用户数据**，本仓既不读写它也不为其背书；本项只保证
**随包出厂基线**自身正确。若某台机器上项目的 skill 清单与随包基线不同，以该机器 override 为准。
**同名不同路径是合法的**（见治理文档 §4 第 4 条）：重名时 `normalizeDiscoveredSkillId` 依次加
`-2`/`-3` 消歧是设计行为，**不要**把它当成需要合并或警告的对象。

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

> **⚠️ 2026-09-29 现状（Meka 最小随包交付）——本节的集合目前不可能全绿，原因已定位**：
> 本批**没有跑任何门禁**（交付方被明确要求静态推理），且工作树里存在**必然失败的测试侧残留**
> （`src/main/meka-projects/__tests__/combatWorkflowPolicy.test.ts` 等三个文件 import 已删除模块、
> `mekaRuntimeInjection*.test.ts` 传已删除的 deps / 断言已删除的键、`builtinMekaSeed.test.ts`
> import 已删除的 `resources/meka/roles/combat-development.json`、`runtimeConfig.projectReferences.test.ts`
> 的 `toHaveLength(10)` 与 F3 用例）。⇒ **清理这些残留之前，不得用本节的任一项当作本交付的通过证据**；
> 逐条清单与责任归属见 **§8.12 第 4 条**。

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
  （刻意如此：项目/角色机制的语义只在真实运行期成立）。
  **它是人工实机验收命令，没有任何自动化执行**（见 §3 WL-11 的「人工实机验收命令」条）；
  退出码同 `ui-smoke`（0 无 FAIL / 1 有 FAIL / 2 前置不满足）。
  > **`--dry-run` 不是「只读预览 / 安全空跑」（2026-09-23 更正）**：原先此处写「用 `--dry-run` 可只跑
  > 前 3 项草稿断言而不建会话」，**这句话是错的**。脚本只给 **6 处**检查加了 `dryRun` 守卫，
  > 而 **`WL-3.2` / `WL-11.1` / `WL-11.2` / `WL-11.8` 四处没有守卫**，会经 `createMekaDraft()`
  > 派发**真实 CDP 鼠标事件并改 hash**（不建会话、不调模型，但**不是纯只读**）。
  > **本次交付过程中曾执行过一次 `--dry-run`，按上述事实它并非纯只读。**
  > **⚠️ W25 批次更正（2026-09-23，只追加不改原句）**：`WL-3.2` / `WL-11.1` / `WL-11.2` /
  > `WL-11.8` **四处现已补上 `dryRun` 守卫**，dry-run 下返回 **`unverified`**，**不再伪造 PASS**
  > ⇒ 把 `--dry-run` 说成「只读预览 / 安全空跑」**现在成立**（dry-run 下真正执行的只剩只读检查
  > `WL-11.17/退役重绑`）。⚠️ 但**缺口仍在**：`main()` 末尾仍无条件 `pressEscape()` + 改
  > `location.hash`；marker 漂移仍是「漏报」路径（`unverified` ⇒ 退出码 0、横幅 `PASSED`）；
  > 陈旧实例 preflight 找不到版本行时返回 ok。**真实核对必须看 `unverified === 0`**。见 §8.8。
  > 另：**「通过」不等于「已核对」** —— marker 漂移等情形走 `ctx.unverified`，
  > **退出码仍为 0、横幅仍打印 `PASSED`**（`failed.length` 是唯一决定退出码的量）。
  > 必须**一并读 `unverified=N`**，真实核对依赖 **`unverified === 0`**。
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
  **当前空号一览（2026-09-29 更新）**：
  - **WL-7** —— 初版曾占位「数据谱系与 migration 冻结」，2026-09-11 复核后移除，理由见 §8.3。
  - **WL-4.2.3**（子编号空号）—— SAGA2 战斗 Lead 的服务器只读 Worker，随 workflow 机制删除（§8.12）。
  - **WL-11.11 / 11.12 / 11.13 / 11.14 / 11.16** —— 战斗请求范围、项目参考路径白名单、表范围只读
    通道与 P4 写边界、Host 侧证据预算墓碑、战斗写入门禁三层；全部随 workflow 机制 / 内置提示词正文
    删除（§8.12）。**11.15 与 11.17 仍然有效**，不要连号一起当空号。
  - **WL-15** —— Meka 角色 Skill 注入必须走非 argv 载体（唯一锚点是战斗总控 Skill 正文），
    随三类删除消失，**仍然成立的那一半不变量改挂 WL-11.17**（§8.12）。
  - `WL-8` **不是**空号：本批**没有**退役它（其 provenance / 渠道账本机制与全部锚点都存活）——
    2026-09-23 前的某次规划曾把它列为待退役，那一条**不成立**，见 §8.12 第 2 条。
  结构契约测试只要求编号唯一且升序，不要求连续。
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
   **未受影响**：SAGA2 远端只读 worker 的硬禁用仍在链路里（`meka-injection/mekaResolvePlan.ts`
   的 `isCombatServerWorker` 判定 `:607-611` 与 `codexNativeSubagentsDisabled` 补丁 `:685-687`
   —— 原先写的 `:531-533` 已漂移 → `maker-host/index.ts:1618` 读取 → `:1831`
   `buildCodexSubagentSpawnArgs`），WL-4.2.3 不因此失效。
   > **⚠️ 2026-09-29 更正（Meka 最小随包交付，只追加不改写上面原句）**：上面这句「未受影响」的
   > 前提**已不成立** —— `isCombatServerWorker` 判定与注入层的 `codexNativeSubagentsDisabled` 补丁
   > 都随 workflow 机制删除（`mekaResolvePlan.ts` 现在**不再产出该键**，理由写在约 `:373-379` 的
   > 注释里），**WL-4.2.3 已整体退役**（§8.12）。仍存活的是 **maker-core / maker-host 的消费侧**
   > （`packages/maker-core/src/agents/codex/index.ts` 的 `codexNativeSubagentsDisabled` 分支、
   > `maker-host/index.ts:1731` 的 `ctx.codexNativeSubagentsDisabled === true`），但
   > **当前没有任何仓内生产者**：该键的生产者交还宿主策略（同 `packages/lizi-mcps/src/xdt-helper/
   > start_team.ts` 的中立键 `mekaLockWorkerPermissionMode` 写法）。⇒ 本条待裁决的**范围变大**：
   > 若要恢复「远端只读 worker 硬关子代理」，必须**先有新的生产者**（宿主策略或新机制），
   > 不能靠复活已删除的注入层补丁。
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

`apps/desktop/src/renderer/features/cc-agent/lib/sidebarProjectVisibility.ts` 的
`sidebarSessionsWithHiddenProjectsAsDialogues`（约 `:145-165`）会把落在「已隐藏项目」key 内的会话改写成
`{ ...session, workspaceKind: 'dialogue' }`（改写点在 `:162`），而豁免条件只有
`workspaceKind === 'dialogue'`（`:40`、`:87`、`:101`），**不豁免 `'meka'`**。

调用点 `CCAgentSidebarUpper.tsx` 的 `sidebarSessions` useMemo（约 `:1418-1426`，调用在 `:1420`）
在 Meka 分流（`nonMekaSidebarSessions` 约 `:1446`、`visibleMekaSessions` 约 `:1798`）**之前**执行，
于是被隐藏项目目录下的 Meka 会话会被：① `visibleMekaSessions`（按 `workspaceKind === 'meka'`
过滤）丢弃 ⇒ **从「Meka 助理」段消失**；② `nonMekaSidebarSessions` 收下 ⇒ **出现在普通对话
分组**。触发条件是 Meka 项目的 workingDir 恰好等于用户已从侧栏隐藏（墓碑）的 Cindy 项目目录。

该函数在上游 `4f03ea9a7b` 与合并前 `5917437271` 中**逐字相同**——它是 Meka 侧新增
`'meka'` kind 后没有同步补豁免留下的缺口（上游域内不存在该 kind，故上游代码自洽）。
按「非本次修改引入的存量问题不擅自修复」**未处理**，需用户决定是否纳入；
修法是加 `session.workspaceKind === 'meka'` 豁免并补一条用例。

**本轮复核（2026-09-23 第三轮同步）：仍未修，且上游没有修。** 取证：`sidebarProjectVisibility.ts`
在 `git diff --stat <merge-base 0f65d9823> origin/main -- apps/desktop/src/renderer/features/cc-agent/lib/sidebarProjectVisibility.ts`
下**输出为空（零 diff）**，即上游在 `base..origin/main` 区间对它在内的任何一侧都没有改动；
当前文件的豁免条件实测仍是 `workspaceKind === 'dialogue'`（`:40` / `:87` / `:101`），改写点仍是
`:162` 的 `{ ...session, workspaceKind: 'dialogue' }`。⇒ 本缺口在合并后**照旧存在**，
是**存量缺口**（三侧一致、非本轮引入），**本轮未修**；已在 WL-3.1 的「已知边界」处同步登记。

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
| WL-11.17 规范类元数据渐进披露（order 65）与内置角色退役重绑 | **零实跑覆盖（本批交付的如实登记）**：① **门禁未跑** —— 本批**没有执行任何门禁**（未跑 `pnpm test:unit` / `test:unit:related`、未跑 `pnpm --filter desktop run typecheck`、未跑 `pnpm test:db`、未跑 `pnpm check:i18n-glossary`、未跑白名单实跑）；② **smoke 未跑** —— `pnpm desktop:session-smoke`（含 `-- --role 默认角色`）**未执行**，虽然 `scripts/meka-session-smoke.mjs` **已按新契约重写**（WL-11.17 段注入检查 + WL-11.17/退役重绑 DB 检查两行）；③ **用例期望已同步、但未跑**（注入层基线新增第 16 组 9 条，**W25 终核为 10 条、该文件合计 28 条**，原有 10 条逐字节期望一个字符未改；生产侧 `projectReferences` 断言已移到 unit 层新文件 `runtimeConfig.projectReferences.test.ts`，**19 条**（当轮写 16 条，W25 逐条重数更正））；④ **退役迁移与 F2 重绑守卫的断言只在 `db` 层**（`builtinMekaSeed.test.ts` 被 `scripts/test-workspaces.config.mjs` 的 `status:'manual'` db 层收录、被 unit 层 exclude）⇒ **`pnpm test:unit` / `test:unit:related` 不执行它**；**但 CI 会执行它**——`.github/workflows/ci.yml` 两处「Run companion database regressions」步骤（linux shard 1 / windows shard 1）已把 `src/main/localDb/__tests__/builtinMekaSeed.test.ts` 写进硬编码路径清单（W25 终核更正了原文的「CI 永远不会执行它」）；本地要单独复现仍是显式 `pnpm test:db` 或 `vitest run <该文件>`；⑤ **owner 确认**：本改动改变了最常见角色的 system 前缀，属 `maker-core-and-agent-behavior.md` §4 门禁——**维护者已直接指示提交并推送本次改动**（授权本次交付），**没有书面签名**；该节如实登记为「维护者直接指示（授权本次交付提交/推送）」，而**缓存率影响仍未实测**；⑥ **Light / Dark 两种模式的目检未做**；⑦ **Pi argv 余量为算术推演、非实测**（约 114 条 skill 才越界、实际 42–51 条 ⇒ 余量约 2×，判据仍以 argv 实测总长为准）；⑧ 接受边界：描述退化为文件名/相对路径（存量项目未重跑发现）、resume 旧会话拿不到 order 65、**F1 容错边界**（全量展开项 warn+跳过、显式选择仍 fail-closed）、**F3 战斗角色仍内联**（大体积 `AGENTS.md` 仍可能逼近 argv 预算）、**F5 scope 拒收绝对路径/`..` 并回落到文档目录**、非 saga2 残留内置别名行不清理、`mergeBundledRoleFallbacks` 的 `includeAllProjectMetadata` 回填分支当前不可达（刻意保留）——见迁移总账 §11.26 与注入层 §8 |

补测试时应优先覆盖**本轮同步真实坏过**的位置（WL-2.1、WL-9 派生包、WL-10 补种、WL-12），
而不是平均用力。

> **2026-09-29 更新（Meka 最小随包交付，只追加不改写上表）**：上表里 **WL-11.11 / 11.12 / 11.13 /
> 11.14 / 11.16 五行已随条目退役**（其机制被删除，不再是「未覆盖」而是「不存在」，见 §8.12）；
> **WL-16 行里的 `maker-host/index.ts:2308`** 应为 `:2367`（`_mcpProviders.pi` 赋值在 `:2362`）；
> **WL-11.17 行第 ⑧ 条里的「F3 战斗角色仍内联」已作废**（F3 已删除，见 WL-11.17 第 6 条）；
> 本批新增 **WL-20 / WL-21** 两项，其覆盖现状是「单测已落地、**本批一次都没跑**」。

### 8.6 本轮顺带修掉的门禁缺口（记录在案）

`scripts/__tests__/meka-release-identity.test.mjs`（7 条，覆盖打包产物名、更新器落点、
端点自举、签名服务与 macOS 证书）此前**没有被任何门禁引用**——它自己通过，但永远不会在
CI 或本地 `test:unit` 里跑。今回把它与新增的
`scripts/__tests__/meka-whitelist-contract.test.mjs` 一并登记进 `pnpm test:runner`，
本清单 §4 声称的覆盖面才成立。改动 `test:runner` 名单时两者都不应被移除。

**另一处本轮修掉的「假绿」（2026-09-23 W25 批次）**：`session-share` 的角色行**测试夹具**原先
**手写字面量**（硬编码 `general-development` 等可能已不存在的角色行），于是「角色被删/改名后导入
应走 `role-missing` 降级」这条行为被夹具掩盖成假绿。现已改为**从包内注册表派生**
（`BUILTIN_MEKA_PROJECTS` + `mekaDefaultRoleId`，见
`session-share/__tests__/sessionShareImport.test.ts` 的 `bundledDefaultRoleRow`）：注册表里查不到
⇒ 夹具**不再提供该行**，导入端会真的走 `role-missing`。登记的是夹具**现在派生自注册表**，
**不声称这些用例已实跑**（W25 未跑任何门禁）。

### 8.7 已知机制缺口：被 `exclude` 但没有 tier 接管的测试文件（存量，本次未修）

`scripts/test-workspaces.mjs` 的覆盖校验（`checkIncludeCoverage`）只报「**既没被当前 tier 选中、
也没被该 tier 的 `exclude` 命中**」的文件 ⇒ **被 `exclude` 但没有任何 tier 接管的文件会被静默
放过**：它不属于任何 tier，`pnpm test:unit` / `test:unit:related` / `test:all` 与 CI 都不会执行它，
而 runner **不会报错**。

**本次（2026-09-23 W25 批次）用仓内 `selectFilesForTier` 对 desktop 的 7 个 tier 逐 tier 试配，
实测的存量孤儿文件清单**：

| 文件 | 实测 tier 归属 |
| --- | --- |
| `apps/desktop/src/main/maker-host/__tests__/modelMetadataLayers.integration.test.ts` | **无任何 tier**（`NO TIER`）：`unit` 层按 `**/*.integration.test.ts` exclude，其余 6 个 tier 的 include 都不匹配 |
| `apps/desktop/src/main/maker-host/__tests__/piRemoteFileOps.integration.test.ts` | **无任何 tier**（同上） |
| `apps/desktop/src/main/localDb/__tests__/cjkFtsMatch.integration.test.ts` | `db`(**manual**)：会跑，但只在显式 `pnpm test:db` 时跑，**不在 CI** |

**同批次实测的对照事实**：`runtimeConfigProjectFiles.test.ts` = `unit`(required)（改名后已进入 CI
与提交前门禁）；旧名 `runtimeConfig.integration.test.ts` = `NO TIER`（文件已不存在，仅作机制对照）；
`builtinMekaSeed.test.ts` = `db`(manual)（另有 `.github/workflows/ci.yml` 的写死路径在 CI 里跑它）。

**这是存量机制缺口，非本次引入，本次也未修**：改 `test-workspaces.mjs` 的覆盖校验会影响全仓所有
workspace，需单独决策。本条只登记「机制缺口 + 孤儿文件清单」，**不声称已修复，也不声称这三个文件
已被任何门禁执行**。

### 8.8 `scripts/meka-session-smoke.mjs` 的 W25 批次变化与仍存缺口（人工实机命令，不属自动化门禁）

该脚本**没有任何自动化执行**（见 WL-11「人工实机验收命令」）。W25 批次对它的改动与仍然存在的缺口
如下，**全部为代码级核对结论，本次未实跑该脚本**：

1. **`WL-3.2` / `WL-11.1` / `WL-11.2` / `WL-11.8` 四处补了 `dryRun` 守卫**：dry-run 下这四项现在返回
   **`unverified`**，证据串以「`--dry-run：未执行`」开头，**不再伪造 PASS**。⇒ 把 `--dry-run` 描述成
   「只读预览 / 安全空跑」的说法**现在成立**：dry-run 下**真正执行的只剩只读检查**
   （`WL-11.17/退役重绑`：只读库与清单），上述四项一律登记为 **UNVERIFIED**。别读成「dry-run 什么
   都没做」——它仍会读库、读项目配置与包内清单。
2. **6 处 PASS 证据串里的「（新期望，待实跑）」「（新增检查，本轮未实跑）」已移除**（改为脚本内注释）。
   ⇒ **不得再说「脚本输出里会打印『待实跑』」**；反过来，输出里**没有**这些字样**也不能**证明已实跑
   （它从来不打印）。
3. **仍存在的缺口（登记，不声称已修）**：
   ① `main()` 末尾仍**无条件**执行 `session.pressEscape()` 与设置 `location.hash`（dry-run 下也会
   派发一次输入事件并改 renderer hash；不写库、不写文件）；
   ② **marker 漂移仍走「漏报」路径**：回声里缺 `[MEKA_PROJECT_REFERENCES]` marker ⇒ 走
   `ctx.unverified` ⇒ **退出码仍为 0、横幅仍打印 `PASSED`**（`failed.length` 是唯一决定退出码的量，
   `unverified` 不计入）⇒ 真实核对**必须一并看 `unverified === 0`**；
   ③ **陈旧实例 preflight 已被降级**：找不到版本行时返回 `ok` ⇒ 对着旧构建也可能打印 `PASSED`。

### 8.9 门禁实跑结果（2026-09-23 交付时一次性执行，权威）

> 上文（含 §8.5、各 WL 的「门禁状态」、§8.7/§8.8）凡写「本批未跑任何门禁」「没有执行任何门禁」的，
> 指的是**写作时**的状态。交付时已**一次性**实跑，结果如下；**以本块为准**。

| 命令 | 结果 | 说明 |
| --- | --- | --- |
| `pnpm --filter desktop run typecheck` | **exit 0** | **首跑失败**并暴露 12 个类型错误（`MekaRoleManifestFile` 未导入、`Pick<…,'prompt'>` 需 `Partial`、新测试文件 shared 导入少一层、mock 联合类型过窄、夹具缺 `enabled`、`prompt` 可能 undefined 等）⇒ 全部修复后复跑 exit 0；定向测试仍 23/23（类型修复未改运行时语义） |
| `pnpm run test:workspaces --tier unit` | **exit 0** | 全部 `required` workspace PASS，含 `apps/desktop unit` |
| `pnpm run test:workspaces --tier db` | **exit 1（非本次引入）** | `1 failed \| 119 passed` 文件、`2 failed \| 1538 passed \| 6 skipped` 用例，两个失败**都在** `main/__tests__/codexLocalSessions.test.ts`；**单独跑该文件 122 passed** ⇒ 并行负载超时抖动。`builtinMekaSeed.test.ts` 单独跑 **11 passed** |
| `pnpm test:runner` | **exit 1（非本次引入）** | `pass 656 / fail 2`，均在**未改动**的 `scripts/__tests__/hardcoded-color-audit.test.mjs` 的 `:287`/`:405`（断言 `spawnSync('bash',…)` 退出码）。最小复现：本机 `bash` 是 WSL 启动器且**不继承 Windows 环境变量**（`PROBE=success` 下 `test "$PROBE" = "success"` 仍退出 1）⇒ 纯环境性；CI 在 ubuntu 跑 bash 不受影响。该文件全部 `ci.yml` 结构断言（含对本次改过的 `Run companion database regressions` 步骤的断言）**通过** |
| `pnpm check:design-inventory` | **exit 0** | `GENERATED 区块最新（54 个 surface）` |
| `node scripts/hardcoded-color-audit.mjs --base-ref HEAD --worktree` | **exit 0** | `{"raw":0,"allowed":0,"unexpected":0,"report":2}`；2 条 `report/visible-layer-radius` = 治理 §13 第 4 条的未决分类上报（不阻断） |
| `check:i18n` / `check:i18n-glossary` / `check:brand-terminology` / `check:dev-docs` | **全 exit 0** | i18n 五语 10334 key 一致；glossary 20 处 `proposed` 告警（不阻断） |

**仍未验证（不得写强）**：`pnpm desktop:session-smoke` **未跑**（含 `--dry-run`）；**Light / Dark 两种模式
均未目检**；**Pi argv 余量仍是算术推演、不是实测**；`pnpm design:inventory` 生成器未复跑
（`--check` 已通过）。WL-11.11–WL-11.17 的**端到端实机**部分仍无实跑证据。

### 8.10 随包内置插件播种已被上游退休：本仓保留机制只用于历史已播种安装的对账（2026-09-24 复核）

**事实（本仓与上游 `origin/main` 同形 —— 是双侧共同的、已被上游退休的遗留，不是 Meka 特有缺陷）**：

- 播种入口 `apps/desktop/src/main/cindy-brain/index.ts` 的 `builtinSeedRootDirs()` 解析两个种子根
  （`official` / `xd`：dev 为 `<appPath>/resources/builtin-ghosts`，packaged 为
  `process.resourcesPath/builtin-ghosts`），调用点是对账（`reconcileBuiltinGhosts`）与设置页取数。
- `apps/desktop/resources/builtin-ghosts` **在磁盘上不存在**；它也**从未**进入
  `apps/desktop/forge.config.ts` 的 `extraResourcesForTarget()` 白名单 ⇒ packaged 之后
  `process.resourcesPath` 下同样没有这个目录。旧注释「forge extraResource 原样拷入」与配置直接矛盾，
  本次已按事实改正（`.gitmodules` 亦不存在）。
- `.gitignore:208-209` 写明「内置插件种子已废弃(改走 plugin-store 安装)」。
- ⇒ **随包不再分发种子，正常安装（dev 与 packaged）下内置插件播种是有意的 no-op**；官方内置插件
  改走 plugin-store 安装。

**为什么不能删播种机制**：改名（`RENAMED_BUILTIN_GHOSTS`）与退役（`RETIRED_BUILTIN_GHOSTS`）驱动的
存量数据对账、墓碑 / seeded 台账都跑在 `builtinGhostProvisioner` 上。删掉等于搁置历史已播种安装的
用户数据（旧设备可能隔很多版本才升级），而今天零收益。因此本次**只**把静默 no-op 改成可观测，
不删播种逻辑、不改 `forge.config.ts`。

**可观测口径（区分「设计如此」与「真的坏了」）**：

- 种子父目录整棵缺失 = **设计状态** ⇒ 记**每进程每父目录至多一次** `info`
  （`builtin ghost seed roots absent by design; builtin provisioning is a no-op`，带解析出的全部根路径），
  **不得**用 `warn`/`error`：这是正常安装的常态，升级成 warn 就是每次启动刷噪声。
- 父目录在、而某个根缺失/为空/不可读 = **打包或提交事故** ⇒ `warn`
  （`builtin seed root missing` / `builtin seed root present but empty` / `builtin seed root unreadable`），
  带根路径与 errno / 原因，区分「仓里真没有」与「读失败」。
- 种子集为空 ⇒ 本轮**不执行孤儿回收**（空集分不清「随包真没有」与「根没 checkout」，宁可留旧包），
  该后果必须在日志里说明（`builtin ghost orphan recovery skipped: …`）——空根那条 `info` 在整轮
  no-op 时到不了，所以全空分支自己带一句。
- 状态台账不可读 ⇒ 沿用既有 fail-closed 分支（不装不删、台账原样、标记下轮重试），并补一条整轮
  后果 `warn`（`builtin provisioning skipped: unreadable state ledger; no seed applied this round`）。
- 上述日志 scope 为 `brain` / `plugin-*`，**不进上传包**
  （`apps/desktop/src/main/log-upload/sourceAllowlist.ts` 的 `NOTABLE_DENIED_ROOTS`）——只保证**本机**
  日志可诊断，不声称可上报。

**代码锚点**
- `apps/desktop/src/main/cindy-brain/index.ts`（`builtinSeedRootDirs()` 与其「种子已退休」注释；
  `RENAMED_BUILTIN_GHOSTS` / `RETIRED_BUILTIN_GHOSTS` 对账）
- `apps/desktop/src/main/cindy-brain/builtinGhostProvisioner.ts`（头注释「观测口径」；
  `observeSeedRoot` / `warnUnusableSeedRoot` / `reportEmptySeedSet`）
- `apps/desktop/forge.config.ts:829-874`（`extraResourcesForTarget()` 白名单，**不含** `builtin-ghosts`）
- `.gitignore:208-209`

**自动化门禁**
- `pnpm --filter desktop exec vitest run src/main/cindy-brain/__tests__/builtinGhostProvisioner.test.ts`
  —— 新增「种子树退休后的观测口径」四条：①父目录整体缺失时**只记一次** info、状态文件逐字节不变、
  已装内置插件不被孤儿回收（第二轮对账不重复刷日志）；②父目录在而某根为空 ⇒ warn 带根路径，
  并说明本轮未执行孤儿回收；③根存在但 `readdir` 失败 ⇒ warn 带 errno，不误报成「根里真的空」；
  ④仍有种子可播时空根只 warn，种子照旧装入、孤儿回收照旧跳过。既有墓碑 / 改名 / 退役 / 孤儿回收 /
  fail-closed 用例**全部保留、未削弱**（同文件内的旧用例一条未改）。

**实机验证**：无独立实机项。本改动只增加日志与注释，正常安装下播种不产生任何用户可见行为；
插件相关的实机面按 §5 的插件条目覆盖。

**编号说明**：本节不是 `WL-*` 能力项（它登记的是「已被上游退休、无需防覆盖」的事实与观测口径），
故不占 WL 编号、不新增 WL 顶层项；若将来重新随包分发种子，应改为新 WL 项并钉住上述不变量。

### 8.11 已裁决：安装目录身份钉扎与 `.updating` 独占锁随上游回退移除（2026-09-23 第三轮同步，方案 A）

**裁决**：**方案 A —— 完整接纳上游回退**（裁决人：用户）。本节登记的是「接纳上游删除」的决定与
理由，防止下一轮同步把它误判成静默回归，或反过来把 Meka 旧版 `installer.rs` 又搬回来。

**事实（本轮逐条实查，行数与 diff 均为实测命令结果）**：

- 上游 `5b10e9babc`（`fix(updater): 恢复原更新权限流程并保留失败重试`）把 #4502 的整套 Windows 热更
  加固**整体回退**。该提交的 diffstat：`apps/desktop/cindy-updater/src-tauri/src/installer.rs`
  `5229` 行变动、`src/main/updateLockWait.ts` **-41**、`src/main/__tests__/updateLockWait.test.ts` **-107**、
  `src-tauri/src/args.rs` **-13**（即两个参数声明）。
- 行数实测：`installer.rs` 在 `meka/main` 侧（合并前 `HEAD` = `09e8bb6132`）**5451** 行；上游
  `origin/main`（`2f169d6aeb`，= 回退后的形态，与 `5b10e9babc` 同）**1218** 行；合并结果 **1379 行**，
  且 `git diff --stat origin/main -- …/installer.rs` = **161 insertions(+) / 0 deletions(-)**
  ⇒ **1379 = 1218 + 161，零删除**。
  > ⚠️ **口径更正（防止照抄错数）**：同批的迁移报告 UP-05 / §6「UPD」与本次任务下发的
  > 偏移表里写的是「上游 **1217** 行 + 161 行」（另有一处写成「回退时 5061 → 1139 行」）。
  > 本轮逐字节实测（含末行换行判定）为：上游 `origin/main` **1218** 行、合并前 Meka 侧 **5451** 行、
  > `5b10e9babc` 的回退是 **5419 → 1218** 行（该提交 diffstat `5229` 行变动）。
  > 三者对「**+161 / 0 删除**」的结论没有分歧；**引用行数时以本节的 1218 / 1379 / 5451 为准**。
- 随上游**删除**的机制（本仓已确认零残留）：
  `InstallDirIdentity` / `capture_install_dir_identity` / `install_dir_identity_unchanged` /
  `copy_tree_into_pinned` / `pinned_join`、`.updating` 独占锁 `acquire_update_lock`
  （退化为 `fs::write(&args.lock, b"updating")`，当前 `installer.rs:355-360`）、High-IL staging ACL、
  `InstallerFailure`、`--zip-sha256` / `--install-writable`；Electron 侧
  `apps/desktop/src/main/updateLockWait.ts` 与其单测同样删除（当前 `Test-Path` 为 false、全仓无引用）。
- **只投影回两个自包含能力**（这两项与上游回退无依赖，属 Meka 侧真实产品价值）：
  1. `notify_shell_associations_changed()`（`installer.rs:565`，SHChangeNotify Shell 关联刷新；
     非 Windows 的 no-op 变体在 `:575`）；
  2. `validate_extracted_main_executable()`（`installer.rs:698`，热更包结构校验）。
- `args.rs` 与 `lib.rs` 与上游**逐字节相同**：`git diff --stat origin/main` 在本组文件里**只**列出
  `installer.rs`。

**为什么必须这样（写进文档，防止下一轮被当成静默回归）**：
`apps/desktop/cindy-updater/src-tauri/src/args.rs` / `lib.rs` **从未被 Meka 改过**，本轮被 Git 自动合并成
上游形态 ⇒ **已不再解析** `--zip-sha256` / `--install-writable`（合并前 Meka 侧 `args.rs` 里有这两条
`#[arg]` 声明，当前工作区已无）。保留 Meka 旧版 `installer.rs` 会去读这两个参数与那批已删除的辅助
类型，**必然编译不过**；「取上游 `installer.rs` 并投影回上面两项」是该文件组合下唯一可编译、
且不丢 Meka 能力的解。若下一轮同步看到 `installer.rs` 与上游同形，**这是预期状态**，不是被覆盖。

**不变量保持**：WL-6.3 的产物名 / 更新器落点（`cindy-meka-updater`）与 WL-6.5 的渠道身份 /
HTTPS-only 发布根**不受本次回退影响**；真实发布与签名验证仍按 WL-6.4 / §8.2 第 4 条登记
「未验证 + 需授权」。

**交叉引用**：WL-6.3、[`cindy-updater.md`](cindy-updater.md)、
[`../migrations/2026-09-24-origin-main-to-meka-main.md`](../migrations/2026-09-24-origin-main-to-meka-main.md)
的 UP-05 与 §6「UPD」；迁移总账 `xdmaker-meka-to-cindy.md` §6.59 的「不整体回退」表述已被本轮裁决取代。

**编号说明**：本条不占 `WL` 编号 —— 按 §6 的判据，白名单只登记「当前存在、需要防上游覆盖」的能力，
而本条登记的是**接纳上游删除**的裁决与理由。**WL-7 仍为空号**，§6 与 §8.3 关于「编号不复用、
允许留空号」的既有说明**不改动**。

### 8.12 已退役：Meka 最小随包交付（2026-09-29）删除的条目与新增的容错项

> **本条是「退役条目 / 空缺编号」的集中记录**，性质同 §8.3（WL-7 的移除记录）。各条目正文处也有
> 就地标记，本条给出**范围、理由与编号去向**，以免下一轮把这些空号误当漏项或复用。

**1）范围裁决与授权（如实登记，不得写成「已签名批准」）**

维护者的**直接指示**（原话）：
① **「可以说除了 workflow 机制，其他的机制完全不动，只是动内容。」**
② **「saga2/project.json 需要继续随包。其他的移除」**
③ **「你理解偏差了，后续审查要更严格，避免动了不该动的内容」**。
⇒ 因此本次**只删三类**：**workflow 机制**、**内置提示词正文**、**bundled skill 文件**；
**项目 / 角色机制一律不动**（不新增 migration、不改 `drizzle/**`、不改 `localDb/schema.ts`、
不删也不降级任何存量行、不改 seed、不改 `RETIRED_*` 兼容表与 `projectConfig.ts:545-576` 的退役过滤
闸门、不改 `'saga2'` → P4 根 sentinel、不改 P4 子目录设置机制、不改 `metadataScanner.ts` 的排除列表）。
**这不是一份签名的书面批准**：它是维护者在会话中的直接指示，范围以 ① ② 两句为准；
`plugin-security-and-authoring.md` 的「插件基座改动需放行人明确 Approve」在这一批**面向本仓代码
不构成触发**（本批未改插件基座：`ghost.ts` / `mcp-providers.ts` 的改动是删除战斗对账块与
战斗调用点，属 workflow 机制删除）。**如果后续评审认为这仍应走书面放行门，请在交付记录里补记，
不要用本条当作已放行的证明。**

**2）退役条目与编号去向（编号保留为空缺，不得复用）**

| 编号 | 退役能力 | 理由（一句话） |
| --- | --- | --- |
| **WL-4.2.3** | SAGA2 战斗 Lead 的服务器只读 Worker（第三条独立通路） | 属 workflow 机制；派发前再授权、形态 C、战斗段与其调用点整体删除 |
| **WL-11.11** | 战斗请求的两请求类与「启发式不得产生 confirmed」 | 分类、正则、技能 ID 补丁、成员清单（A4）、会话镜像（A3）、卡片审批（D8）全部随战斗文件删除 |
| **WL-11.12** | `[SAGA2_PROJECT_PATHS]` 项目参考路径注入与精确路径白名单 | `resolveCombatProjectRefPaths` / `combatProjectPathsPrompt` / `mekaCombatProjectRefPaths` 随战斗文件删除 |
| **WL-11.13** | 表范围解析的只读通道与 P4 写边界 | Cindy 侧白名单与 `isPlanningMutation` 随 `combatWorkflowPolicy.ts` 删除（**跨仓 meka-p4 的三步确认闸门仍成立**，但它不属本仓白名单项，已在条目处留存锚点） |
| **WL-11.14** | Host 侧证据预算已删除的墓碑与「不得复活」判据 | 判据的承载体（两个被删文件 + 两个随之失效的用例文件）与对照物（提示词层收敛纪律 `combat-evidence-budget.md`）都已删除 |
| **WL-11.16** | 战斗写入门禁三层（范围绑定／命令面白名单／写后对账） | `legacyModuleWriteCommandReason` / 对账状态机与冻结 SKILL 正文全部删除 |
| **WL-15** | Meka 角色 Skill 注入必须走非 argv 载体 | 唯一锚点是战斗总控 Skill 正文的路径化注入（`combatControllerSkillPrompt`），已删除；**仍然成立的那一半（规范类元数据不得内联）改挂 WL-11.17** |

**明确没有退役的相邻项（防止下一轮误删）**：**WL-8**（Meka 技能链与技能市场）——其 provenance /
渠道账本机制与**全部锚点逐条实测仍在**，随包 skill 由 10 减到 1 只影响内置 catalog 规模；
**WL-13 / WL-18 / WL-19 的不变量全部原样成立**（WL-18 / WL-19 只有行号漂移，已就地更正）；
**WL-16 只剩 2 个形态**（形态 C 退役）但其余不变量不变；**WL-11.15 与 WL-11.17 不变**。

**3）同步登记的新容错项（机制必需，不是可选优化）**

> 四项共用同一判据：**只容忍「用户数据里对已删随包资产的引用」，不容忍真实配置错误**。
> 机制（解析顺序、fail-closed 口径、退役过滤闸门、快照优先级）**一律未动**。

- **WL-20 = T2**：孤儿内置角色行（`is_builtin=1` 但随包清单已删）读取时回落到该项目默认角色。
  **为什么必需**：本批**明确不做 DB 迁移**，所以存量库里的 `combat-development` 这类行**必然残留**，
  严格读取会抛 `builtin Meka role <id> not found` ⇒ **会话打不开（不是降级）**、面板僵尸行报错。
- **WL-21 = T3**：`readBundledRoleManifests` 的 `readdir` 遇 `ENOENT` 返回 `[]` + `log.warn`。
  **为什么必需**：`resources/meka/roles/` 现在不存在，而 **git 不跟踪空目录** ⇒ 新 clone / CI 下该目录
  不存在，不兜住就会在启动路径上抛错。
- **WL-22 = T1**：角色显式选择的未知 bundled skill 跳过 + `log.warn`；平台基线 id 仍硬失败。
  **为什么必需**：`resolveRoleFile` 里**用户项目文件的 `builtinRoles` 快照优先于 T2 回落**，而旧版
  角色编辑器会把随包角色（含其 `skills`）整份写进该快照 ⇒ 一个仍列着已删 skill（如
  `combat-skill-configuration`）的存量快照会 fail-closed 让会话打不开。
- **WL-23 = T4**：角色 `promptFragments` 文件缺失（`ENOENT`）跳过该条 + `log.warn`；逃逸 / 编码错误
  仍上抛。**为什么必需**：`combat-development` 的内置快照携带 5 条 fragment（`prompts/combat-*.md`
  ×5，已随包删除），快照优先于 T2 且按「内置行」解析 ⇒ fragment 根仍是 `resources/meka/roles/`
  ⇒ ENOENT。**曾判断「没有触发路径」并回退本项，该判断是错的**（漏了用户项目文件里的快照）。
- **T5（合成默认项目配置）没有落地**，这是**有意**的：
  `saga2/project.json` 继续随包 ⇒ 项目配置缺失不触发；且合成默认项目配置属「动机制」。⇒ 引用本批
  容错层时写 **T1 + T2 + T3 + T4 四项**（**WL-20 / WL-21 / WL-22 / WL-23**）。

**4）测试侧残留（✅ 已在同一交付内清理，此处保留为当时的清单与去向）**

下列文件当时引用了**已删除模块 / 已删除资源 / 已删除契约**，会让门禁必然变红。**交付方已在同一次
交付内清理完毕**（`pnpm --filter desktop run typecheck` exit 0；`pnpm test:unit:related` 通过，
唯一失败与本批无关）。保留逐条去向，供回看：

1. `combatWorkflowPolicy.test.ts` / `combatServerCapabilityState.test.ts` / `combatEnvironmentGate.test.ts`
   —— **删除**（被测模块已删）。
2. `localDb/__tests__/builtinMekaSeed.test.ts` —— 去掉对已删 json 的 import，内置阵容断言改为
   **只有 `saga2-default-role`**；两例 FK 重绑用例改为自行插入 `combat-development` 行（模拟升级库）。
3. `meka-projects/__tests__/runtimeConfig.projectReferences.test.ts` —— catalog 计数改
   `['platform-capabilities']`；F3 用例（原地读已删 json）**删除**，其「任何角色都走引用」的一半
   已由该文件首例覆盖。
4. `maker-ipc/__tests__/mekaRuntimeInjection.test.ts` / `mekaRuntimeInjectionBaseline.test.ts` ——
   按当前契约（**3 段、无 workflow 键、无 combat deps**）重写；逐字节非战斗基线与 frozen 键序
   断言**加严**（新增 `Object.keys` 全等钉住）。
5. `mcp-integrations/__tests__/meka-runtime-mcp.test.ts` —— 删除两个已删工具的用例，保留 11 个通用
   远程项目工具、MCPR 恢复文案、`call_tool` 高风险授权 seam 与 Unity-only 守卫。
6. `maker-ipc/__tests__/mekaWorkerTarget.test.ts` —— **保留**，与退役说明一致：`mekaWorkerTarget.ts`
   按维护者裁决属「机制、不动」，其单测随实现一起保留（生产侧当前零调用方，属已登记边界）。
7. `scripts/meka-session-smoke.mjs` —— **已按共享默认角色重写**（`DEFAULT_ROLE_ID`、去掉
   `COMBAT_ROLE_ID`/`combatRoleOf`、workflow 断言改为「键不存在」的可失败断言）。

**5）验证现状（本批交付的如实登记）**

- **本次交付已一次性实跑门禁**：`pnpm --filter desktop run typecheck`（**exit 0**；T4 恢复并新增
  T1/T4 回归用例后**重跑仍 exit 0**）；`pnpm test:unit:related`（desktop 层 **3144 个测试文件通过 /
  44834 例通过**）；`pnpm test:runner`（**699 pass / 0 fail**，含本清单的结构契约与新增的
  WL-22 / WL-23）；`check:i18n`、`check:i18n-glossary`、`check:brand-terminology`、
  `check:design-colors`、`check:design-inventory`、`check:dev-docs`（**全部 exit 0**）。
  `@cindy/maker-core` / `@cindy/mcps` 无 `typecheck` script，按规则该步自动跳过。
- **四例非通过项已逐一取证、均与本批无关**：① `src/main/background-task-output/__tests__/reader.test.ts`
  的两例 `EPERM: operation not permitted, symlink` —— **Windows 符号链接权限**问题，该目录本批未触碰；
  ②③④ 全量并发运行时 `packages/lizi-mcps` 报超时 / `COMMAND_FAILED` —— **单独重跑 67 文件 /
  904 例全过、exit 0**，属并发与进程派发负载所致。
- **本清单的实机验收已执行并通过（2026-09-29）**：`pnpm desktop:session-smoke` 在真实 Desktop dev 实例
  （CDP 9222，`--isolated=dev` 沙箱 `CindyMeka-dev2-dev`，region global，实例版本行与 HEAD `11201bb` 一致）
  上跑出 **`SESSION_SMOKE PASSED — checks=11 pass=11 fail=0 unverified=0`**。逐条真实结果：
  - **WL-3.2 PASS**（扁平布局契约：无子组头、项目级入口挂在项目行上、10 行会话直挂项目行下、落子组容器 0 行）
  - **WL-11.1 PASS**（草稿绑定 `项目=SAGA2` + `默认角色=默认角色`）
  - **WL-11.2 PASS**（选项 `["默认角色","战斗开发"]`，默认角色排第一；切到「战斗开发」生效）
  - **WL-11.3 PASS**（`workspace_kind=meka project=saga2 role=saga2-default-role is_formal=0 workdir=C:/Workspace/saga2/saga2_project`）
  - **WL-11.4 PASS**（Agent 真实跑完一轮，`回复="收到"`）
  - **WL-11.5 PASS**（`[MEKA_ROLE_CONTEXT]` 注入回显 `projectId=saga2 roleId=saga2-default-role displayName="默认角色"`）
  - **WL-11.6 PASS**（**`workflow键=不存在`**；`mcp=mcp-router,project-agent,meka-design`；`skillsCount=46`、`platformSkillsCount=1`）
  - **WL-11.7 PASS**（会话落在 Meka 分区的项目子树内，非普通「对话」分组）
  - **WL-11.8 PASS**（同一入口重进仍保留已选角色）
  - **WL-11.17 PASS**（参考段 4 条目、路径均存在、格式行在场、**无 `#` 标题行、无清单外文本**）
  - **WL-11.17/退役重绑 PASS**（`meka_roles` 无退役内置行）
  **本次实跑同时给出了 T2 / T3 的运行期证据**（不经单测）：
  - **T3**：`main-2026-09-29.log` 多次记录 `bundled Meka role directory is missing; treating the bundled
    role catalog as empty { projectId: 'saga2', root: '…\resources\meka\roles' }` —— 证明 `roles/` 目录
    缺失被正常容错，应用照常启动与建会话。
  - **T2**：以面板只读路径读孤儿角色（路由 `/cc-agent/meka?projectId=saga2&roleId=combat-development`）
    时记录 `builtin Meka role manifest is missing; falling back to the project default role` —— 面板同时
    渲染出 `配置来源: 内置配置` / `角色: 默认角色 | 战斗开发`，即**孤儿角色行可见且可读**，而不是改动前
    会抛 `builtin Meka role not found` 的僵尸行。
  **真实库状态（dev 沙箱，只读查询）**：`meka_projects` 恰 1 行（`saga2` / `is_builtin=1` / `path='saga2'`）；
  `meka_roles` 2 行（孤儿 `combat-development` + `saga2-default-role`）；**8 个 Meka 会话绑定在孤儿的
  `combat-development` 上**、7 个在默认角色上 —— 这就是 WL-20/T2 服务的真实对象。另：真实用户项目
  `saga2_project_git`（id `xm8ecpopxgkmt78sig7cvrqt`）的 6 个 `builtinRoles` 快照中有两个写着
  `skills=meka-design-handbook`（本轮已移出随包）⇒ **WL-22/T1 的触发路径在真实环境里存在**。
- **本轮同时修好了一个存量脚本缺陷（非本批引入）**：`scripts/meka-session-smoke.mjs` 原先无条件假定侧栏
  有「正式流程 / 普通对话」两个子组头；而按维护者口径，**子组头只在项目配了正式工作流时才出现**
  （`MekaAssistantSection.tsx:466` 的扁平分支 vs `:477` 的子组分支），`saga2` 的
  `formalWorkflowEnabled: false` 走扁平是**预期行为**。脚本已改为**运行时 DOM 探测布局**并按该布局断言
  正确契约（扁平分支正面断言「子组头不存在」等，不是「有什么算什么」）。四要素（脚本字符串 / i18n /
  两个组件 / 项目标志）实测均与 HEAD 一致，故该缺陷与本批改动无关。
- **不可逆点**：**DB 侧零不可逆点**（不迁移、不删行、不改 schema）；**唯一对用户可见的不可逆面**是
  **注入的 system prompt 前缀对每个项目都变了**（段集合 10 → 3、随包内容清空、默认角色 prompt 变短）
  —— 对存量会话表现为「降级到共享默认角色 + 平台基线 + order 65 引用清单」，且**旧前缀无法恢复**
  （承载它的随包正文已不在仓内）。缓存率影响**未实测**（属 `maker-core-and-agent-behavior.md` §4）。
- **本次实跑暴露的一条产品后果（登记，非缺陷）**：战斗写入门禁随 workflow 机制删除后，**存量 SAGA2
  会话不再受原写入门禁约束** —— 那些会话现在以「默认角色 + 平台基线」运行。这是维护者裁决
  「连 workflow 机制一起删」的既定后果；若仍需写入约束，须由 SAGA2 侧通过角色/插件重新表达。
- **本条的自我约束**：本节只登记退役/新增与验证现状，不改写任何带日期的历史原句；
  历史正文全部保留在 Git 历史与迁移总账 §11.32 的交付记录里。
