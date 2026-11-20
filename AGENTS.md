# Cindy 客户端仓：Agent 工作入口

Cindy 是面向大众用户的开源 AI 助手，连接模型、工具与设备，帮助用户在自己的文件和
应用中完成工作。

> 本文件是 Codex 与 Claude Code 共用的项目指令正本。`CLAUDE.md` 只保留 `@AGENTS.md`，
> 不要在两处重复维护规则。

## 首要背景：Meka 私有产品线

- XDMaker 是最初的开源项目；本仓维护者先 fork 了 XDMaker，并在该 fork 的
  `meka/main` 上独立开发 XDMaker Meka。当前 Git 中保留的对照来源是
  `xdmaker/meka/main`。
- 上游后来把 XDMaker 迁移为新仓库 Cindy，并同时完成前后端拆分等仓库重组；因此
  Cindy 是 XDMaker 的后继代码库，但两者不是可以按普通连续 Git 历史处理的同一仓。
- 当前仓库是 Cindy 的私有 fork；本仓的 `meka/main` 是 Meka 的主开发分支，与上游
  Cindy 独立演化。原 XDMaker `meka/main` 的 Meka 产品能力已经按 Cindy 当前架构迁入
  本仓 `meka/main`，不是通过整分支 merge 得到。
- 当前产品身份已经确定为 **Cindy Meka**：新包的程序与用户数据目录使用
  `CindyMeka`，协议、数据库与更新渠道使用 `cindy-meka`；首次登录从旧
  `xdmaker-meka` 目录只读迁移数据；主深链为
  `cindy-meka://`，内部兼容解析但不向 OS 注册上游 `cindy://`。
- 处理 Meka 任务时，以 Cindy 当前代码、仓库边界和规则作为实现宿主，以
  `xdmaker/meka/main` 作为原 Meka 产品意图、历史用户数据、安装身份、签名和更新兼容的
  对照证据。不得把旧分支整体 merge/cherry-pick 进来，也不得恢复已拆出的服务端代码。
- 开始任何 Meka 迁移、数据兼容、打包或更新工作前，必须先读
  `docs/migrations/xdmaker-meka-to-cindy.md`；该文档是迁移范围、决策、状态和风险的事实
  总账。

## 仓库边界与安全底线

- 本仓库只负责 desktop、mobile 及其共享 packages。
- 服务端位于独立仓库；除非用户明确要求，不要跨仓修改服务端。
- 开始工作前先检查工作区状态，不覆盖、不回退用户已有改动。
- 先读实际代码和测试，再决定实现；不要只依赖文档猜测现状。
- 用户凭证、令牌、授权文件和密钥不得写入仓库或任何可能被 Git 跟踪的路径。
- 未经用户明确授权，不执行删除数据、覆盖改动、推送、发布、合并等外部或难以
  恢复的操作。
- 发现任务会触及系统提示词、更新器、协议兼容、数据库历史 migration、权限边界
  或用户数据安全时，必须先停下来核对专项规则，并在动手前向用户说明风险或
  请求确认。

## 产品方向

Cindy 面向大众用户，让人以简单高效的方式用 AI 完成工作。我们追求极致的体验：
用户面前的每一分简单，都是产品在背后承担的复杂和匠心。产品、UI 与架构的取舍，以
[产品原则](docs/product-rules/core-product-principles.md)、[设计规范](docs/design-rules/DESIGN.md)
与[架构原则](docs/dev-rules/architecture-invariants.md)为准。

## 按模块进入

开发、启动、调试或验证对应模块前，先读下表入口，再按改动触发条件读专题；根级规则始终适用。
跨模块行为先从[仓库地图的行为导航](docs/dev-rules/repo-map.md#按用户行为定位)查找公共入口与测试，
不要只修改最先找到的页面或渠道。

| 修改范围 | 模块规则入口 | 开发与架构正本 |
| --- | --- | --- |
| Desktop：main、renderer、preload、数据库、个人 IM / 官方 hook | [apps/desktop/AGENTS.md](apps/desktop/AGENTS.md) | [Desktop 开发](docs/dev-rules/desktop-development.md) |
| Mobile：Expo 页面、远程调用、原生配置与模块；在手机上查看效果 | [apps/mobile/AGENTS.md](apps/mobile/AGENTS.md) | [Mobile 开发与冷更边界](docs/dev-rules/mobile-development.md) |
| maker-core：Agent 编排、prompt、工具、translator、用量 | [packages/maker-core/AGENTS.md](packages/maker-core/AGENTS.md) | [Agent 行为](docs/dev-rules/maker-core-and-agent-behavior.md) |

模块内的触发条件写在嵌套 `AGENTS.md`，正文写在 `docs/dev-rules/` 专题，本文件只保留
仓库级强制规则、风险入口与索引。

## 当前规则索引

修改前按下列场景读取相关正文；涉及多个主题时同时适用。产品、设计、工程的完整导航
分别见 [产品规则](docs/product-rules/README.md)、[设计规则](docs/design-rules/README.md)、
[开发规则](docs/dev-rules/README.md)。

- 首次接触本仓、需要定位功能代码位置或判断新代码归属模块时，先读仓库地图
  `docs/dev-rules/repo-map.md`。
- 只为检查界面而需要启动 Desktop 或 Mobile 模拟器、且不需要真实账号时，用 `--mock`
  免登录模拟数据启动。`--mock` 不阻止 Desktop 调用真实模型（会沿用本机命令行登录），只看
  界面时不要在里面发送消息；新增或修改模拟任务、`--mock` 行为前先读 `docs/dev-rules/ui-mock-data.md`。
- 首次安装、修复依赖或准备新 worktree 时，必须先读
  `docs/dev-rules/environment-setup.md`。
- 首次理解模型配置架构，新增模型／供应商，更新模型窗口／价格／推理档位／默认值／本地推荐，
  或排查目录下发与显示错误前，必须先读 `docs/dev-rules/model-catalog-maintenance.md`：
  先看结构、覆盖顺序与修改位置，再按其中导航读取专题规则和实际代码；Server 正本与客户端
  离线副本需协调更新，客户端已支持、Server 已实现和生产已部署必须分别核验。
- 修改凭证或授权信息处理、文件落盘位置、用户持久数据、临时文件或测试目录前，必须
  先读 `docs/dev-rules/credentials-and-local-storage.md`。
- 新增或修改媒体生成、导入、缓存、附件、持久化、协议解析或回收逻辑前，必须先读
  `docs/dev-rules/media-storage-and-protocols.md`。
- 新增或修改邮件卡（阅读、编辑、草稿同步、发送、头像）或邮箱插件与 Cindy 之间的分工前，
  必须先读 `docs/product-rules/mail-card.md`。
- 新增或调整产品功能、判断能力应进入 Core / Skill / 插件、设计人机交互或多端体验
  前，必须先读 `docs/product-rules/core-product-principles.md`。
- 新增或修改 Agent 管理用户自己的任务、定时任务、项目、伙伴的工具（`cindy_helper` /
  `cindy_scheduler` 等），或调整工具索引、工具的作用范围说明前，必须先读
  `docs/product-rules/agent-user-parity.md`：用户本人能做的（含跨电脑）Agent 也要能做并能在
  索引第一步发现；改完把现状台账写回去。
- 修改「迁移助理」（新电脑从其他电脑迁移）的入口、迁移范围、`maker:setup-snapshot` /
  `maker:setup-transfer` 协议、计划与应用规则或一次性配置清单，或新增一类可迁移的设置前，必须先读
  `docs/product-rules/new-device-setup-migration.md`：密钥只在原电脑的人允许后一次性加密复制，
  OAuth 登录与私钥不复制，写入只走本机原有安装器与设置存储，不覆盖本机已改过的设置。
- 修改开始引导（首次登录后的综合引导）的出现条件、步骤与顺序、各步骤复用的能力，或它与旧版数据
  迁移的衔接前，必须先读 `docs/product-rules/first-run-guide.md`：引导只发现和带路、不代做，
  Global 与中国大陆版流程一致，旧版数据迁移的区域边界是数据归属、不得顺手放开。
- 修改共享任务、跨账号访客邀请、共享上下文或共享成员权限前，必须先读
  `docs/product-rules/shared-task-mode.md`；复用 device-link，同账号远控行为不变。
- 新增或修改 Meka 技能入口、标准技能包兼容、MCPRouter 技能分发、安装来源记录或
  Meka 项目角色与市场技能的关系前，必须先读
  `docs/product-rules/meka-skills.md`。**Meka 私有产品线**的专属产品规则还包括
  `docs/product-rules/meka-capability-layers.md`（能力分层）与
  `docs/product-rules/mcpr-remote-project-sessions.md`（MCPRouter 远程项目会话）。
- 新增或修改 Meka 项目的元数据发现清单（`AGENTS.md` / `CLAUDE.md` / `SKILL.md` /
  `rule` / `.mcp.json`，含面板里的「发现元数据」与 `enabled` 勾选），或处理别名文件、
  重复条目、条目描述与 `notes` 前，必须先读
  `docs/product-rules/meka-project-metadata-governance.md`：它区分「文件该不该存在」与
  「该不该注入」，规定 `enabled:false` 的适用边界（**禁用必须在 `notes` 里留痕**）、
  别名的唯一合规形态（`@AGENTS.md` include 或逐字节相同）与权威副本的标注方式。
- 修改 IM 工具授权、来源消息、多端确认或暂停期间的确认回执，或新增 IM 渠道前，
  必须先读 `docs/product-rules/im-permission-confirmation.md`；Desktop、Mobile 与共享
  packages 共用同一最终决定，渠道收到回答不代表执行已恢复。
- 新增或修改手机通知上的按钮（回答提问、回复、允许一次、拒绝）、哪些通知带按钮、按钮点击在后台的执行、没送到时的提示，
  或登录凭证在钥匙串里的可读时机前，必须先读 `docs/product-rules/notification-actions.md`：按钮是 App 之外的
  作答入口，看不全、说不清或高风险的操作不能在通知上批准，答复只作用于通知描述的那一条请求。
- 新增或修改代输入（`request_input_handoff`、宿主步骤读取与执行、代输入卡、截图扫码、终端 askpass、
  单窗口实时画面、设备码识别，或任何经手主人填写值的路径）前，必须先读
  `docs/product-rules/input-handoff.md`：主人填写的值只交给宿主执行，不进模型、记录、日志、IM 与推送。
- 新增或修改隐私屏（离开时遮住屏幕、远程控制时的遮罩、远程结束后的保护）、物理输入转锁屏、锁屏失败处理、
  屏幕常亮策略，或「离开电脑时」设置与遥控端「安全」面板里的相关开关前，必须先读
  `docs/product-rules/privacy-screen.md`：隐私屏不是认证边界，任何情况下不露出一个没锁的桌面；
  怎么保护只由被控电脑本机决定，遥控端只决定这一次连接什么时候保护。
- 新增或修改自动化任务的 Webhook 触发条件、接收服务、事件排队、密钥或相关界面前，必须先读
  `docs/product-rules/schedule-webhook-trigger.md`：事件只是门铃，正文不进任务，密钥不进任务记录。
- 新增或修改模型组（把模型供应商里已有的来源合成路线与模式）的配置、选路、选择器入口、任务里的说明，
  或要让它在新任务以外的地方生效前，必须先读 `docs/product-rules/model-groups.md`：模型供应商页原样保留、
  模型组只做加法，只决定新任务用哪个已连接的模型，排序与供应商组共用同一把尺子。
- 修改账号用量上限的判定、重置时刻来源，或普通任务／目标模式撞上限额后的等待与自动继续前，
  必须先读 `docs/product-rules/usage-limit-auto-continue.md`。
- 新增或修改自动发送／远程发送消息的路径、消息来源标签，或发给模型的来源说明前，必须先读
  `docs/product-rules/message-source.md`：界面标签与模型说明同源，两侧一起改。
- 新增或修改内置功能的退役、下线或「引导存量用户迁移」链路（`featureRetirements` 登记、
  退役态呈现、退役入口的迁移引导文案）前，必须先读
  `docs/product-rules/feature-retirements.md`：退役必须可发现、可解释、可迁移，
  不得静默消失或让存量用户的入口变成死链。
- 修改伙伴（Bot）的身份、伙伴项目、Session 生命周期、模型 fallback、工作目录、Skill / MCP 装配、
  伙伴间协作或伙伴设置前，必须先读 `docs/product-rules/cindy-bots-runtime.md`。
- 新增或修改只对伙伴生效的工具、提示词规则、回执或定时工作等专属机制前，先读
  `docs/product-rules/teammate-capability-ledger.md`：伙伴的工作方式属于伙伴自己的规则，先判断
  普通任务或项目能力能否做到；做不到时优先补成通用能力。这是引导，不是审批。
- 修改伙伴调用任务写工具的权限（2026-11-08 起不设伙伴专属权限门）、转达主人原话的来源记录，
  或伙伴提示词里对应的说法前，必须先读 `docs/product-rules/teammate-authority.md`。
- 修改伙伴的跨电脑身份、主力电脑（登记、接管、交出、降级）、云端对话层与资料上传，或
  `apps/desktop/src/main/companion-cloud/`、Chat Server 的伙伴 actor／1:1 房间合同前，必须先读
  `docs/product-rules/cloud-companions.md`。
- 新增或修改伙伴群聊的数据、发言编排、群专线 Session、分工（负责人、安排、分工 Session、群工作目录）、
  群聊界面或手机端群聊（`bot-groups` 远程资源、群推送深链）前，必须先读 `docs/product-rules/bot-group-chat.md`。
- 新增或修改 `/review`、Reviewer 任务、成果快照、Finding 协议、复核入口、结果呈现或
  复核生命周期前，必须先读 `docs/product-rules/review-product-direction.md`。
- 新增或修改按区域（`cn` / `global`）分支的逻辑、构建身份与命名、端点选择、区域相关
  UI 标注，或涉及两个版本关系的对外文案前，必须先读
  `docs/product-rules/region-and-editions.md`：**无限定词身份归 Global，未显式指定
  区域一律落在 `global`，只标注中国大陆版**。
- 新增或修改供应商分享（把远程供应商分享给其他账号）、分享链接、分享申请与审批、
  分享管理页，或受邀者使用分享供应商的任何路径前，必须先读
  `docs/product-rules/provider-sharing.md`；它为远程 Agent 通道新增跨账号授权，并允许
  中国大陆版与 Global 互享，与共享任务是两套独立授权。
- 新增或修改供应商组（把多台电脑上的同一个供应商合成一组）、组策略、组内电脑的添加与状态、
  经供应商组的任务分配或转发，或「远程与分享」页的组与用量前，必须先读
  `docs/product-rules/provider-groups.md`：Agent 始终在被选中的组内电脑上运行，组所在电脑
  只选电脑与转发，并负责按使用方隔离。
- 新增或修改任何界面、组件、布局、样式、动效或 UI 文案前，必须先读权威设计规范
  `docs/design-rules/DESIGN.md` 开头的「阅读路由」，再按路由读相关章节与专题，不需要
  通读全文；设计文档索引见 `docs/design-rules/cindy-design-system.md`。
- 做 UI 圆角分类或点击目标尺寸审查时，必须同时读 `docs/design-rules/DESIGN.md §5` 与
  `docs/design-rules/design-governance.md §13`；普通 UI 改动同样适用，不限于设计系统迁移 PR。
- 新增或修改设计 Token、主题系统、标准 UI 组件（primitive / pattern）、视觉类门禁脚本，
  或参与设计系统迁移 PR 前，必须先读治理合同
  `docs/design-rules/design-governance.md`：真相源边界、兼容红线、两级证据合同与
  PR 风险分类均以它为准；视觉规则本身仍以 `DESIGN.md` 为准。
- 新增或修改任何 UI 文案里的**产品术语**前，必须先查术语表 `i18n/GLOSSARY.md`：已裁决
  的术语照用，不自造译法；表里没有或拿不准的，在 `i18n/glossary.json` 加
  `status: "proposed"` 条目再讨论。门禁为 `pnpm check:i18n-glossary`，规则见
  `docs/dev-rules/engineering-conventions.md` §5.1。
- 新增或修改**任一 Telegram bot 的用户可见行为**（命令、消息呈现、收口策略、群行为、
  权限口径、附件与表情）前，必须先读能力台账 `docs/product-rules/telegram-bot-parity.md`：
  两个 bot 是两套架构，差异可以有但必须登记在表里；表里标「有意不同」的行**不要去
  "统一"**，动它要先推翻对应裁决。改完记得把对应行写回去。
- 文案里出现**任务 / 对话 / 消息**这几个词时，必须先读
  `docs/product-rules/task-and-conversation-naming.md`：`session` 面向用户叫「任务」，
  「对话」只用于任务内的交流过程与内容，单条往来叫「消息」；**「任务」与 `task` 同句出现
  时必须消解歧义**。这三个词的边界拿不准会直接做出用户能看见的不一致。
- 所有新增或修改的 UI 必须同时**实现** Light 与 Dark 两种模式（颜色一律走语义 token，
  禁止只适配一种模式的硬编码或条件补丁）；只实现一种模式视为未完成。**两种模式的实机
  目检不是硬性门槛**——能目检更好，做不到时如实写明哪种模式未验证，不得把「复用了 themed
  样式」当成「双模式已验证」。具体要求以 `docs/design-rules/DESIGN.md` 的双模式交付门槛
  为准。
- 修改 Orca 多 Agent 协同时，必须先读
  `docs/dev-rules/orca-team-architecture.md`。
- 新增或修改 Agent 使用多台机器的能力（`list_machines`、机器状态、按机器执行），或要为 Agent 的资源使用加上限前，必须先读
  `docs/product-rules/cindy-machines.md`：**宿主暴露情况，不替大脑做资源决策**，不写死「最多几个」这类决策上限；结果不完整必须明说。
- 修改任何进入模型 system 段的提示词前（无论文件位于哪个模块），必须先读
  `docs/dev-rules/maker-core-and-agent-behavior.md`。
- 修改 Meka 会话注入（`apps/desktop/src/main/meka-injection/**`：prompt 段注入、
  `MEKA_PROMPT_SEGMENT_ORDER`、`MEKA_AGENT_CAPABILITIES` 能力矩阵、角色级 MCP／技能落地、
  技能快照挂载、`vendorOptions` 的 Meka 键，或进程级 Meka 运行时 MCP 注册
  `registerMekaCapabilities` / `declareMekaRuntimeMcpAgents`）前，必须先读
  `docs/dev-rules/meka-injection-layer.md`。
- 修改 Meka 助理会话的身份判定（`workspaceKind` 与 `(mekaProjectId, mekaRoleId)` 绑定）、
  会话创建时按工作区路径隐式绑定项目／角色、IM／伙伴对这类会话的可见性与项目投影，或改动
  「Meka 项目目录里的任务」行为前，必须先读
  `docs/dev-rules/meka-assistant-session-binding.md`（产品口径见
  `docs/product-rules/meka-assistant-session.md`）。
- 修改 PI harness 集成（`packages/maker-core/src/agents/pi/**`、`pi-host.ts`、
  `piEnvironment.ts`）、PI 会话权限／配置／system prompt／桥接，或 PI 相关的上线判断前，
  必须先读 `docs/dev-rules/pi-harness.md`（含设计原则、维护不变量与上线清单）。其中
  **Pi 原生能力非退化是红线**：Pi 原生允许的安装、更新、扩展加载与 Agent 自助修复，Cindy
  不得以静态分析、TUI／RPC 兼容提示、内容指纹、宿主审批或新增的“安全增强”为由拒绝、停用
  或变成不可逆流程；显式用户命令即授权。Cindy 只能增加可跳过的提示和更顺畅的 GUI，不能让
  Cindy Pi 比同版本原生 Pi 更难用。完整裁决见 `docs/dev-rules/pi-harness.md`「Pi 上游 GUI
  非退化红线」。
- 修改插件（`.cindy`）运行时、沙箱、权限、能力 slot、面板供片、网络／凭证／文件交接、
  插件市场分页读取、安装扫描、实例核对、使用统计或远程插件状态读取，或身份卡、管子协议、
  打包与编写手册前，必须先读 `docs/dev-rules/plugin-security-and-authoring.md`。其中**存量插件兼容是红线**：任何
  插件系统改动（含批准状态 schema、指纹格式、manifest 校验、安装布局、包格式）都必须
  向下兼容——用户升级后什么都不做，已装、已批准、已启用的插件必须照旧可用，**绝不允许
  要求用户重新安装、重新确认权限或重新配置**。做不到就必须自带从旧版数据的自动迁移；
  自动迁移也做不到时，必须有明确提示 + 一次性批量恢复入口，且不丢用户已存的凭证与偏好。
  漏迁移 = P0，规则正文见该文件第 5 节。**改到插件基座**（运行时／沙箱、批准状态记录、
  能力 slot、打包与内容判据、manifest 契约、装入与权限确认 UI、已装列表投影）的 PR 一律
  走白名单确认门，需放行人明确 Approve 才能合并，不看 diff 大小、不因「是 bugfix／纯技术
  改动」豁免。**Meka 独立插件渠道**的版本兼容语义（含 `x-cindy-version` 与渠道白名单）
  另见 `docs/dev-rules/plugin-distribution-and-version-compat.md`。
- 新增或修改插件的 `mcpr` 卡槽、MCPRouter route 白名单、Host 鉴权注入或跨仓能力调用时，
  还必须先读 `docs/dev-rules/mcpr-plugin-capability.md`，并同步核对 MCPRouter 仓库的
  `docs/mcpr-plugin-capability-gateway.md` 与 `packages/server/src/capabilities/` 契约。
- 修改插件发现链（花名册注入、`ghost_list` / `ghost_info` / `ghost_call`）、插件运行期
  可见性门禁或 FORGE_GUIDE 作者契约前，必须先读 `docs/ghost-progressive-discovery.md`。
- 新增或修改 Browser Use（专用浏览器、侧边栏、「我的浏览器」）的工具层、配方目录、外链处理
  或任一浏览器后端前，必须先读 `docs/dev-rules/browser-use.md`：优化做在共享层让三端都受益，
  能力不设限、风险交给审批。
- 新增或修改插件持久 Library（library 槽、binding / 目录选择、随时迁移、
  回收站删除、SQLite 语句门或 `/library/` 面板投影）前，必须先读
  `docs/dev-rules/plugin-library-storage.md`。
- 新增或修改文件下载、安装进度或它们的界面前，必须先读 `docs/dev-rules/verified-downloads.md`：
  传输走统一下载器（必须带 SHA-256，自带重试、续传和龟速换连接），给用户看的进度统一为
  `DownloadProgress` 并用标准 `DownloadMeter` 显示，不各自画进度条、格式化速度或处理重试提示。
- 修改客户端自动更新链路（`cindy-updater` 或 Electron 侧更新服务）前，必须先读
  `docs/dev-rules/cindy-updater.md`；**Cindy Meka 使用独立的 `cindy-meka` 更新渠道**，
  不得引用或复用上游 Cindy 的渠道、CDN 前缀与应用身份。
- 新增或修改 Claude/Codex runtime 版本 pin、RustFS 运行时资产发布或 MCPRouter Linux runtime
  交付前，必须先读 `docs/dev-rules/agent-runtime-release.md`。
- 新增或修改 Desktop 日志、IPC 错误处理、main 侧业务逻辑与测试、客户端本地或远程数据读取／
  扫描、变化通知后的刷新、界面频繁触发的持久化写入、缓存与轮询性能、跨平台（macOS／Windows）
  行为，或任何 UI 文案的 i18n 落地前，必须先读 `docs/dev-rules/engineering-conventions.md`；
  在 `meka/main` 上新增命名（目标名、符号名、文件名、资源名）前，必须先读该文件 §10。
- 新增一处每个功能都要来登记的列表、台账、注册表或版本号前，先读
  `docs/dev-rules/engineering-conventions.md` §9：不规定「加在开头／末尾」，不让多个 PR
  改同一行；一项一个文件、按键排序或从内容推导。
- 新增或改写任一测试前，必须先读
  `docs/dev-rules/engineering-conventions.md` §3.2「新增测试的价值门槛」。测试必须通过
  真实生产入口验证可观察结果，并说明 Bug／规则依据、现有覆盖缺口、最小失败输入和 tier；
  没有新的结果、错误、权限、持久化、协议或时序差异时停止增加用例。纯跨文件安全、
  权限、协议或设计契约才进入 guard；不得为了覆盖率、测试数量或复制常量／JSX／CSS／
  源码字面量而新增测试。同时遵守该节「性能预算」：新文件单独运行本机 5 秒内并在 PR
  填实测耗时；被测模块只加载一次，不在 `beforeEach`／逐用例 helper 里 `vi.resetModules()`；
  不做 ≥100ms 真实等待；同一模块的用例并入已有文件。`pnpm check:test-hygiene` 在 CI
  阻断违规，基线只减不增，不得手改基线放行。**保留 Meka 口径**：本仓的唯一自动化门禁是
  `client-ci` 的 `meka/main` push 触发，`check:test-hygiene` 因此必须在推送前本地跑过
  （见下文「提交前测试门禁」），不能指望 PR 阶段兜底。
- 修改客户端日志采集／脱敏／上报链路（`apps/desktop/src/main/log-upload/**`）、`logger.ts`
  的 main 日志行格式、崩溃判定或待补传标记前，必须先读
  `docs/dev-rules/log-upload-and-redaction.md`。其中三条是**不变量**：**记录边界**（写侧
  续行转义与读侧切分是同一条不变量的两半，破坏任一侧即隐私逃逸）、**白名单方向**
  （deny-by-default，不得改成黑名单——调试级别的功能日志是用户内容的主要泄漏源）、
  **标记代次 + 原子清除**（并发实例下仅靠时间戳会误删另一实例刚写的新崩溃标记）。
  脱敏规则**只增不减**，放宽任一条视为隐私变更、需重新评审。
  **Meka 例外（WL-26，2026-10-08 第五轮同步后裁决）**：Meka **不启用**任何客户端日志
  上报通道（无上报目标注入、无上报 API、无「上传日志」入口、无崩溃自动补传），
  `config/log-upload.json` 在 Meka 上不是打包前置条件；但**采集与脱敏必须继续可用**
  （issue 诊断依赖它）。改动不得恢复上报面，也不得把上报重新接回打包要求。
- 修改跨端协议包（`packages/plugin-protocol`、`packages/slack-hook-protocol`、
  `packages/device-link-protocol`）、修改插件分发来源边界或 device-link
  协议／relay／隧道 payload／IPC allowlist，或任何改动跨端 wire protocol 前，必须先读
  `docs/dev-rules/protocol-and-submodules.md`。**非必要不得修改跨端协议；确需修改时，
  必须先向用户说明必要性、替代方案与跨仓影响并取得明确确认。**（2026-09-10 起本仓不再
  使用 `cindy-protocol` submodule，协议包改为上游的仓内 workspace。）
- 修改本地协议 package、插件分发来源边界或 device-link 协议／relay／隧道
  payload／IPC allowlist，或任何改动跨端 wire protocol 前，必须先读
  `docs/dev-rules/protocol-compatibility.md`；协议包的权威来源与修改准入仍以
  `docs/dev-rules/protocol-and-submodules.md` 为准。
- 新增或修改 agent-net（Agent 网络）的传输核心、节点模型、能力清单、加密、中继选择、网络分享或拓扑界面前，
  必须先读 `docs/product-rules/agent-net.md` 与 `docs/agent-net-plan.md`：两节点之间任何路径都必须
  端到端加密、不允许明文降级，用户自建中继是一等能力，现有 device-link 能力不得退化；
  `packages/agent-net-core` 是通用的可靠 UDP 协议层，不得写入 Cindy 专属设计。
- 修改 Device Link 客户端、协议、relay、设备／媒体接口、能力协商或连接恢复行为前，必须先读
  `docs/dev-rules/protocol-compatibility.md` 的「自建中转同步维护」：凡影响自建中转的改动，
  必须在同一次改动中完成必要的同步适配与互通验证，不得留到后续。
- 新增或修改直接／间接的服务器请求、订阅、推送、同步、轮询或重试（包括界面调用方）前，
  必须先读 `docs/dev-rules/server-channel-review.md`：结合通道用途、共享容量与累计压力
  检查调用方式及次数频率；自审与 AI review 按实际严重程度报告问题，不排除 P2 缺陷。
- 修改 package 依赖方向、main 进程模块加载方式、桌面与 Node Host（`apps/host`）共用的业务主体
  （`*.desktop.ts` 装配、工厂端口注入），或主界面布局树结构前，必须先读
  `docs/dev-rules/architecture-invariants.md`；改共用主体后还要跑 Host 的测试和类型检查（§5）。
- 新增或修改 Settings UI、配置文件、本地偏好、运行时 profile，或 agent／MCP／provider
  开关前，必须先读 `docs/dev-rules/configuration-and-overrides.md`。
- 新增或修改涉及 workdir 文件、agent 进程、会话数据的功能，新增 IPC channel／推送事件，
  或修改 device-link 的重试／超时／断链恢复逻辑前，必须先读
  `docs/dev-rules/remote-and-mobile-adaptation.md`；其中恢复路径改动必须回答该文件的
  「故障半径三问」。
- 新增或修改 MCPRouter 远程任务启动、恢复、SSH preflight 或 `remoteHostId` 路由前，
  必须先读 `docs/dev-rules/mcpr-remote-session-routing.md`；`mcpr:<instanceId>` 与 SSH
  host 是不同 transport，不能共享 SSH pool 前置。
- 在 Cindy 内嵌 worktree 会话里工作、准备提交或直推、或做 code review 前，必须先读
  `docs/dev-rules/development-workflow.md`。
- 把上游 `origin/main` 同步进 `meka/main` 前，必须先读
  `docs/dev-rules/development-workflow.md` 第 4 节：冲突清单不是完整的迁移范围，
  交付前必须跑 `pnpm audit:merge` 逐条确认没有静默丢失（该门禁与 `pnpm test:unit`
  并行生效，不能互相替代）。
- 同步完成、得出任何交付或发布结论**之前**，必须**实际运行**并逐项走完
  `docs/dev-rules/meka-whitelist-verification.md`（Meka 能力白名单与合并后验证清单）：
  结构审计抓不到「代码都在、语义被上游覆盖」这类静默回归，只有该清单的语义验收能拦住。
  **只有全部通过（或明确登记「未验证 + 原因」并经维护者书面接受）才允许宣告合并完成**；
  读过清单、只跑 `test:unit`、或凭 diff 判断都不算执行，未实跑就宣告完成等同于虚报。
  新增任何 Meka 专属能力时也必须同一次交付里登记清单项。

## 文档同步（硬性要求）

- 除纯文档修改外，任何代码、测试、配置、资源、UI 文案或产品行为改动，都必须在同一
  次交付中同步更新对应事实文档；没有文档落点的改动视为未完成。
- 文档必须记录最终有效行为、配置层级与 override、兼容边界、风险及验证方式，不能只写
  “已修改”或复制实现细节。仅补充测试而不改变行为时，也必须在相关文档的验证现状中登记。
- 工程契约写入 `docs/dev-rules/`，产品行为写入 `docs/product-rules/`，设计约束写入
  `docs/design-rules/`；Meka 迁移、兼容或产品行为调整还必须同步更新
  `docs/migrations/xdmaker-meka-to-cindy.md`。没有合适文档时，先在对应 `docs/`
  分类下建立事实文档并由本文件索引。
- 根 `AGENTS.md` 只承载仓库级强制规则和索引，不在这里堆叠具体功能实现事实。完成任务
  前必须核对代码、测试与文档三者一致，并在交付说明中列出本次更新的文档。

## 审查与问题范围（硬性要求）

- 准备提交或做 code review 时，必须先判断检测到的问题是否由本次未提交 diff 引入。
- 本次修改引入的问题必须在本次交付中修复，并按“文档同步”规则同步测试和事实文档。
- 非本次修改引入的存量问题，不得擅自修复、重构或扩大当前提交范围；必须先向用户报告
  证据、影响和建议，并明确询问是否纳入本次处理。用户未确认时保持现状；只有该问题
  确实阻断本次修改的安全交付时，才停止提交并说明阻断原因。

## 通用工作流程

1. 先确认用户目标、仓库边界、当前分支、worktree 和工作区状态。
2. 尊重开发者或宿主已经提供的 Git 工作流。已有任务分支或 worktree 时直接复用，
   不嵌套创建；没有隔离方案时，可以建议新功能使用独立分支或 worktree，但不要
   擅自搬动或混用现有工作区。
3. 根据任务类型读取 `docs/dev-rules/`、`docs/product-rules/` 与
   `docs/design-rules/` 中相关规则。
4. 先读实际代码和测试，再决定实现；不要只依赖文档猜测现状。
5. 修改时保持范围最小，保护用户已有改动，不使用破坏性 Git 命令。
6. **迭代期专注改代码，门禁留到交付时一次跑完**：用户要求 commit、push 或最终验收之前，
   默认**不运行**任何门禁——`test:unit:related` / `test:unit` / `test:all`、包级
   `typecheck`、全量套件、design／i18n／白名单等检查都算门禁。改一点就跑一次门禁，时间会
   全花在门禁上，交付反而更慢，而中间态结果对最终提交没有增量证据价值。门禁在准备交付时
   **一次性**跑完即可，细则见 `docs/dev-rules/development-workflow.md` 的「门禁时机」。
   唯一例外是**为决策取证**：某个实现方向依赖尚未确定的运行时行为、不实测就无法决定怎么写
   时，可跑最小定向检查（单个测试文件或一个最小复现脚本），诊断完即停，并在汇报里说明它是
   取证而不是门禁。用户明确要求“跑门禁／验证一下／看下测试”时按用户指定范围立即执行。
7. **「交付」的判据（不得用措辞绕过门禁）**：只要出现以下任一情形，就已经进入交付，必须
   先按第 6 条**一次性跑完整门禁再对外声称完成**——准备 commit／push／提 PR；向用户宣称
   “已完成／改好了／可以验收了”；把改动当作最终结果汇报或结束任务。**不允许**以“用户没说
   要 commit”“我只是报告一下”为由跳过门禁：第 9 项的如实报告是**兜底**，不是替代品。反之，
   纯阶段性进展同步（“已改到 X，还没跑门禁”）不属于交付，不必先跑门禁，但必须写明门禁未跑。
8. 交付时按“文档同步”规则更新对应事实文档，再一次性执行完整提交前门禁与风险追加验证，
   并 review 整体 diff。
9. 如实报告已验证、未验证、风险、已更新文档和需要用户决定的事项。门禁没跑就写没跑，
   不得用“应该没问题”代替。

## Git 与交付

尊重用户与宿主提供的工作流，已有任务分支或 worktree 直接复用，不嵌套创建，
不擅自搬动或混用工作区。本仓默认 PR-first；只有仓库维护者明确选择例外时才允许
直推主干。仓库规则本身不额外授权 commit、push、发布或合并。

每个 commit 必须带与 author 或 committer 一致的 DCO `Signed-off-by`（`git commit -s`）。
DCO 是否通过以 PR 上的 DCO App check 和真实提交范围（`origin/main..PR head`）为准；
自动审阅沙箱里的平台合成 HEAD 跑本地 DCO 检查失败，不构成缺签证据。
提交 PR 遵循 [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md)；
自动审阅是建议性检查，修改 [REVIEW.md](REVIEW.md) 或自动审阅 workflow 前先读其说明。

- **`meka/main` 是直推集成分支，它唯一的自动化门禁是 `client-ci` 的 push 触发**
  （`.github/workflows/ci.yml` 的 `push.branches` 含 `meka/main`）：该分支不开 PR，Meka 的
  发布流水线（独立控制仓）也不自带验证，所以**推送即门禁**。往 `meka/main` 推送前必须先在
  本地跑完本节的提交前门禁；推送后要确认 `client-ci` 通过，不要靠“发布流水线会拦”来兜底。
- **提交前测试门禁（硬性要求）**：无论是提 PR 还是直接 commit，提交前都必须在本地
  跑完仓库根 `pnpm test:unit:related`（只跑这次改动能影响到的单测；基准是产品集成分支
  `origin/meka/main` / `meka/main`，不是上游 `origin/main`；改到测试调度、
  依赖清单、workspace 配置、Vitest 配置或单测 CI 时会自动退回全量 `pnpm test:unit`），
  并对本次改动涉及的每个 package 跑
  `pnpm --filter <包名> run --if-present typecheck`（`<包名>` 用该 package 在
  `package.json` 里的 `name`，如 `desktop`、`@cindy/maker-core`；没有 `typecheck`
  script 的 package 该步自动跳过），全部通过后才允许提交；任何一项失败都不得提交，
  必须先修复。纯文档改动运行 `pnpm check:dev-docs`，不要求无关业务单测。
  GitHub CI 仍跑完整 `pnpm test:unit`。细则与唯一例外（防丢数据的兜底保存）见
  `docs/dev-rules/development-workflow.md`。
  > **保留 Meka 口径（2026-09-25 第四轮上游同步）**：上游同期把本条改写为「**提交前验证**」
  > ——默认选测、已按影响面完成等效定向验证时不要求为 commit 重跑整仓测试，并明确「仓库不强制
  > 多个 session 串行」。**本仓不采纳该放宽**：`meka/main` 是**直推集成分支**且**唯一自动化门禁
  > 是 `client-ci` 的 push 触发**（见上文「Git 与交付」），没有 PR 阶段的 CI 兜底，所以推送前的
  > 本地门禁就是唯一闸门；用户亦明确要求「仓库门禁在最终提交时统一执行」。第六轮
  > （2026-10-16）与第七轮（2026-11-06）同步维持本裁决。
  > 上游那句中真正需要保留的只有「**未执行项和原因须如实记录**」——本仓以
  > `docs/dev-rules/development-workflow.md`「门禁时机」与当期同步报告的「未验证 + 原因」
  > 登记承担同一职责。记录见 `docs/migrations/2026-09-25-origin-main-to-meka-main.md`。
- 在上述门禁之上按风险追加验证：跨模块、高风险或基础设施改动追加更广泛验证（如
  `pnpm test:all`），最终以 CI 门禁为准。不得通过跳过、删除或弱化测试制造通过。
  本机资源预算、并发与跨任务排队由用户或宿主决定，但这些选择不改变上面两条硬性门禁。

可复用的项目知识写进仓库；个人路径、设备标识、账号偏好、凭据和私聊原文留在本地。
整理文档只改组织与索引，Cindy 特有的信息不得丢失或弱化；细则见
[开发工作流](docs/dev-rules/development-workflow.md) §5、§6。
