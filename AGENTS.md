# Cindy 客户端仓：Agent 工作入口

> 本文件是 Codex 与 Claude Code 共用的项目指令正本。`CLAUDE.md` 只保留
> `@AGENTS.md`，不要在两处重复维护规则。

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

## 仓库边界

- 本仓库只负责 desktop、mobile 及其共享 packages。
- 服务端位于独立仓库；除非用户明确要求，不要跨仓修改服务端。
- 开始工作前先检查工作区状态和相关源码，不覆盖、不回退用户已有改动。

## 规则组织

- 开发与工程规则统一放在 `docs/dev-rules/`。
- 产品行为与体验规则统一放在 `docs/product-rules/`。
- UI 视觉、交互与内容设计规则统一放在 `docs/design-rules/`，权威视觉规范正文为
  `docs/design-rules/DESIGN.md`（根目录 `DESIGN.md` 仅为跳转入口），目录索引为
  `docs/design-rules/cindy-design-system.md`。
- 根 `AGENTS.md` 只保留所有任务都适用的规则、风险入口和文档索引。
- 目录或模块专属规则优先放到对应目录的嵌套 `AGENTS.md`；需要跨目录复用的
  专题说明放在 `docs/`，并由本文件写明触发条件。

## 当前规则索引

- 首次接触本仓、需要定位功能代码位置或判断新代码归属模块时，先读仓库地图
  `docs/dev-rules/repo-map.md`。
- 首次安装、修复依赖或准备新 worktree 时，必须先读
  `docs/dev-rules/environment-setup.md`。
- 启动、调试或验证 Desktop 时，必须先读 `docs/dev-rules/desktop-development.md`。
- 修改 Desktop Renderer、preload、BrowserWindow、WebView、IPC、CSP、导航或 Electron
  特权能力前，必须先读 `docs/dev-rules/electron-security-and-process-boundaries.md`。
- 修改凭证或授权信息处理、文件落盘位置、用户持久数据、临时文件或测试目录前，必须
  先读 `docs/dev-rules/credentials-and-local-storage.md`。
- 新增或修改媒体生成、导入、缓存、附件、持久化、协议解析或回收逻辑前，必须先读
  `docs/dev-rules/media-storage-and-protocols.md`。
- 修改 Desktop 数据库 schema、migration、companion script 或运行期数据库访问前，必须
  先读 `docs/dev-rules/database-and-migrations.md`。
- 开发、调试或验证 Mobile 时，必须先读 `docs/dev-rules/mobile-development.md`。
- 修改 `apps/mobile` 的原生配置、原生依赖、config plugin 或原生模块（`app.json`、
  `app.config.js`、`eas.json`、`apps/mobile/package.json`、`plugins/`、`modules/` 等会
  进入 runtime fingerprint 的输入）前，必须先读 `docs/dev-rules/mobile-development.md`
  的「冷更边界」：**除非必要，不得提交会改变指纹的改动**；会触发冷更的 PR 与技术框架
  变动同级，必须由仓库指定的把关人针对冷更明确确认后才能合并——不看改动大小，也不看谁
  提的，提交者身份不构成例外。
- 新增或调整产品功能、判断能力应进入 Core / Skill / 插件、设计人机交互或多端体验
  前，必须先读 `docs/product-rules/core-product-principles.md`。
- 新增或修改按区域（`cn` / `global`）分支的逻辑、构建身份与命名、端点选择、区域相关
  UI 标注，或涉及两个版本关系的对外文案前，必须先读
  `docs/product-rules/region-and-editions.md`：**无限定词身份归 Global，未显式指定
  区域一律落在 `global`，只标注中国大陆版**。
- 新增或修改任何界面、组件、布局、样式、动效或 UI 文案前，必须先读权威设计规范
  `docs/design-rules/DESIGN.md`；设计文档索引见
  `docs/design-rules/cindy-design-system.md`。
- 新增或修改任何 UI 文案里的**产品术语**前，必须先查术语表 `i18n/GLOSSARY.md`：已裁决
  的术语照用，不自造译法；表里没有或拿不准的，在 `i18n/glossary.json` 加
  `status: "proposed"` 条目再讨论。门禁为 `pnpm check:i18n-glossary`，规则见
  `docs/dev-rules/engineering-conventions.md` §5.1。
- 所有新增或修改的 UI 必须同时**实现** Light 与 Dark 两种模式（颜色一律走语义 token，
  禁止只适配一种模式的硬编码或条件补丁）；只实现一种模式视为未完成。**两种模式的实机
  目检不是硬性门槛**——能目检更好，做不到时如实写明哪种模式未验证，不得把「复用了 themed
  样式」当成「双模式已验证」。具体要求以 `docs/design-rules/DESIGN.md` 的双模式交付门槛
  为准。
- 修改 Orca 多 Agent 协同时，必须先读
  `docs/dev-rules/orca-team-architecture.md`。
- 修改 `packages/maker-core` 的 Agent 编排、prompt 组装、tool／MCP 暴露、translator、
  model 映射、usage 计量，或任何进入模型 system 段的提示词前，必须先读
  `docs/dev-rules/maker-core-and-agent-behavior.md`。
- 修改插件（`.cindy`）运行时、沙箱、权限、能力 slot、面板供片、网络／凭证／文件交接，
  或身份卡、管子协议、打包与编写手册前，必须先读
  `docs/dev-rules/plugin-security-and-authoring.md`。
- 修改客户端自动更新链路（`cindy-updater` 或 Electron 侧更新服务）前，必须先读
  `docs/dev-rules/cindy-updater.md`。
- 新增或修改 Desktop 日志、IPC 错误处理、main 侧业务逻辑与测试、跨平台（macOS／
  Windows）行为，或任何 UI 文案的 i18n 落地前，必须先读
  `docs/dev-rules/engineering-conventions.md`。
- 升级或修改 `cindy-protocol`、修改插件分发来源边界或 device-link
  协议／relay／隧道 payload／IPC allowlist，或任何改动跨端 wire protocol 前，必须先读
  `docs/dev-rules/protocol-and-submodules.md`。**非必要不得修改协议子仓；确需修改时，
  必须先向用户说明必要性、替代方案与跨仓影响并取得明确确认，同时核对并纠正子仓
  `origin` 为官方上游后才能动手。**
- 修改 package 依赖方向、main 进程模块加载方式，或主界面布局树结构前，必须先读
  `docs/dev-rules/architecture-invariants.md`。
- 新增或修改 Settings UI、配置文件、本地偏好、运行时 profile，或 agent／MCP／provider
  开关前，必须先读 `docs/dev-rules/configuration-and-overrides.md`。
- 新增或修改涉及 workdir 文件、agent 进程、会话数据的功能，或新增 IPC channel／推送事件
  前，必须先读 `docs/dev-rules/remote-and-mobile-adaptation.md`。
- 在 Cindy 内嵌 worktree 会话里工作、准备提交或直推、或做 code review 前，必须先读
  `docs/dev-rules/development-workflow.md`。

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
6. 开发迭代阶段优先尽快交付可供用户手测的功能与产物，只运行能支撑当前修改和手测的
   定向检查；不要在用户尚未要求 commit、push 或最终交付时，提前运行耗时的全仓测试、
   全量 typecheck 或其它提交门禁。准备 commit、push 或用户明确要求最终验收时，再按
   「Git 与交付」执行完整提交前门禁及风险追加验证。
7. 按“文档同步”规则更新对应事实文档，再运行与当前阶段和风险匹配的检查并 review
   整体 diff。
8. 如实报告已验证、未验证、风险、已更新文档和需要用户决定的事项。

## Git 与交付

- 本仓默认 PR-first。代码和文档通常从非默认分支通过 PR 进入 `main`；只有仓库
  维护者明确选择例外时才允许直推主干。
- commit、push 和创建 PR 的执行时机由开发者或 Codex、Claude Code、Cindy 等宿主
  工作流决定；仓库规则本身不额外授权外部写操作。
- 提交 PR 时遵循 `.github/PULL_REQUEST_TEMPLATE.md`，如实说明改动、验证和风险。
- **DCO 签名（硬性要求）**：本仓每个 commit 都必须带 `Signed-off-by` trailer，且其中的
  名字与邮箱都要与 commit 的 author（或 committer）一致，用 `git commit -s` 生成；
  agent 的自动提交同样适用。PR 上的 DCO check（DCO GitHub App，配置见
  `.github/dco.yml`）会拦下漏签的 commit。`git commit` 没有自动签名的配置项，一次配好
  可跑 `pnpm dco:install-hook` 装 `.githooks/prepare-commit-msg`；提交前自查用
  `pnpm check:dco`。DCO 全文见根目录 `DCO`，贡献者说明见 `CONTRIBUTING.md`。
  对自动 code review 环境的说明：review 沙箱 checkout 出的 HEAD 可能是平台合成的
  瞬时 commit（不存在于本仓库、GitHub 上查不到该 SHA）；对这类合成 SHA 跑
  `check:dco` 的失败结果不构成缺签证据，不要据此报告 DCO 问题。判定 DCO 是否通过，
  一律以 PR 上的 DCO App check 与真实提交范围（`origin/main..PR head`）的结果为准。
- **提交前测试门禁（硬性要求）**：无论是提 PR 还是直接 commit，提交前都必须在本地
  跑完仓库根 `pnpm test:unit`（全部单元测试），并对本次改动涉及的每个 package 跑
  `pnpm --filter <包名> run --if-present typecheck`（`<包名>` 用该 package 在
  `package.json` 里的 `name`，如 `desktop`、`@cindy/maker-core`；没有 `typecheck`
  script 的 package 该步自动跳过），全部通过后才允许提交；任何一项失败都不得提交，
  必须先修复。细则与唯一例外（防丢数据的兜底保存）见
  `docs/dev-rules/development-workflow.md`。
- 在上述门禁之上按风险追加验证：跨模块、高风险或基础设施改动追加更广泛验证（如
  `pnpm test:all`），最终以 CI 门禁为准。不得通过跳过、删除或弱化测试制造通过。

## 绝对安全底线

- 用户凭证、令牌、授权文件和密钥不得写入仓库或任何可能被 Git 跟踪的路径。
- 未经用户明确授权，不执行删除数据、覆盖改动、推送、发布、合并等外部或难以
  恢复的操作。
- 发现任务会触及系统提示词、更新器、协议兼容、数据库历史 migration、权限边界
  或用户数据安全时，必须先停下来核对专项规则，并在动手前向用户说明风险或
  请求确认。
