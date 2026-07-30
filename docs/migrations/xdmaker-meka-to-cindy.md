# XDMaker Meka → Cindy Meka 严格迁移总账

> 状态：正在把 `origin/main@e4b464a2e` 合入 `meka/main@9ddf4d662`；冲突已完成
> 语义收敛，等待本轮迁移、类型与单测门禁
> 最后更新：2026-07-30
> 目标仓库：`C:\Workspace\cindy`，分支 `meka/main`
> 来源仓库：远端 `xdmaker`（`git@github.com:kapt66/XDMaker.git`），分支
> `xdmaker/meka/main`
> 目标基线：Cindy `origin/main` 的自然演化，不把 XDMaker 仓库整体合并进来

## 1. 迁移目标

本次不是 Git 意义上的整分支合并，而是一次按产品模块审核的严格迁移：

1. 保持 Cindy 在仓库拆分、前后端边界、协议子仓库和现有 UI/架构上的自然演化。
2. 只迁移 XDMaker `meka/main` 中属于 Meka 产品意图的新增、修改和删除。
3. 不恢复已经从 Cindy 客户端仓迁出的服务器代码，不覆盖 Cindy 后续演化。
4. 不把 XDMaker 历史合并、上游漂移和非主观修改当成 Meka 功能迁入。
5. 每个进入 Cindy 的模块都按大模块确认；确认需要后再细分到具体实现。
6. Cindy Meka 使用新的应用、数据和更新渠道身份，从 `xdmaker-meka` 只读迁移用户数据。

因此，`xdmaker/meka/main` 只作为对照源和功能证据，不作为可直接 merge/cherry-pick
的目标。来源分支相对 XDMaker 自身基线包含数百个提交和大量仓库演化，直接合并会把
无关代码、已拆出的服务端和旧架构重新引入 Cindy。

## 2. 已确认的顶层决策

| 决策项             | 结论                     | 当前实现                                                              |
| ------------------ | ------------------------ | --------------------------------------------------------------------- |
| S1 通用能力包      | 暂不迁移，后续按需迁移   | 不引入 Meka 内置插件/能力包运行时和整套 capability snapshot 系统      |
| S3 主观改动        | 没有 Meka 主观修改，丢弃 | 不迁移 XDMaker 的移动端/device-link 主观改造                          |
| Meka 设置          | 迁移                     | P4、MCPRouter、MekaDesign 兼容设置                                    |
| Meka 会话          | 迁移                     | 独立 workspace、项目/角色绑定、正式流程、侧栏分组                     |
| 远程 MCPR          | 迁移                     | Router 登录、实例、绑定、隧道和 Worker 目标                           |
| 远程 Codex Worker  | 已恢复                   | MCPRouter protocol 3 / bundle 0.0.6 控制通道与 app-server 隧道        |
| Orca Worker 微调   | 迁移                     | 仅迁入 Meka 目标选择和远程约束所需改动                                |
| 打包发布           | 已迁移                   | 打包/发布分层；RustFS 上传、canary、stable promote 与 rollback 已接入 |
| 项目与角色         | 迁移                     | 项目、角色、元数据、内置 SAGA2 与 6 个角色                            |
| 原 Meka 用户数据   | 必须兼容                 | 新建 `CindyMeka`，从 `xdmaker-meka` 只读复制并运行 lineage bridge     |
| Windows/macOS 签名 | 沿用原证书/服务          | Windows 原签名服务；macOS 原证书私钥和 self-signed 模式               |
| 热更新             | 新建 Cindy Meka 渠道     | 不承诺旧 Meka 原地热更新；新应用安装后迁移旧数据                      |
| device-link        | 继续使用 `cindy://`      | OS 应用身份独立，跨端 wire protocol 不分叉                            |
| 本地 Desktop 深链  | 使用 `cindy-meka://`     | 只有带 `deviceId` 的跨设备链接切换到 `cindy://`                       |
| 默认区域/占位版本  | 跟随上游                 | 默认 `global`；`apps/desktop/package.json` 使用 `0.0.0`               |
| 项目协同策略       | Meka 例外                | 普通 Cindy 项目遵守策略开关；Meka 保持既有协同行为并绕过该开关        |
| 服务端             | 不在本仓迁移             | 保持 Cindy 已拆分后的仓库边界和协议子仓库                             |

## 3. 当前总体状态

### 3.1 已实现

- Meka 应用安装身份、userData、DB lineage，以及本地打包身份和 Windows 产物命名。
- Cindy Meka Desktop 的服务端 deviceId 使用 `cindy-meka-` 产品前缀；普通 Cindy、
  旧 XDMaker Meka 与显式隔离 sandbox 各占独立设备槽，登录/续期不会互相轮换
  refresh token。
- Meka 设置：P4、MCPRouter、MekaDesign。
- Meka 项目、角色、项目元数据和内置 SAGA2 数据。
- SAGA2 内置项目采用“包内基线 + 已配置 P4 根目录下 `.meka/project.json` 覆盖层”；
  项目字段与元数据可编辑，包内资源和内置角色 manifest 保持只读。
- 项目/角色配置直达 Agent 运行时：项目默认项、角色提示词/规则、Skill、项目元数据和
  MCP 均从当前项目与角色配置解析，不经过 capability snapshot。
- 内置项目、角色与 Skill 统一从 `resources/meka/` 分发；正式包使用
  `process.resourcesPath/meka`，并在 Forge 打包后校验源码树与包内树的文件和内容一致。
- Meka 普通会话与 Jira/GitLab 正式流程会话。
- Meka 会话侧栏、项目层级、正式流程/普通会话二级分组。
- 侧栏“Meka 助理”区固定在滚动列表首位；会话顶部的项目/角色绑定胶囊只显示角色名，
  点击后携带冻结的项目与角色 ID 直达角色配置。
- 侧栏新建 Meka 会话入口和按项目新建入口。
- 项目/角色管理详情页按 Cindy 插件详情页的页面层级和视觉语言重构。
- 远程 MCPRouter 项目实例绑定和会话隧道。
- Orca Worker 的本地 P4/远程 MCPRouter 目标解析与安全约束。
- XDMaker Meka 0.0.11 数据库 migration lineage 兼容桥。
- 已完成 `origin/main@24604ae4b` 向本地 `meka/main@33348870c` 的同步冲突裁决；
  结果由 2026-07-27 的本地 merge commit 收口，未推送。
- Meka 开发启动跟随上游默认使用产品 userData；未 canonical 的 migration 开发才显式
  使用命名隔离 sandbox，避免触碰共享数据。
- Cindy Meka Desktop 发布侧已补齐 RustFS(S3 API)上传、版本化产物 immutable guard、
  canary manifest、stable promote/备份与 rollback；发布配置和凭证与 Cindy 渠道隔离。
- Meka 本地 canary 名单已迁入 Cindy 当前的异步 feature-flags 同步链：最终通道取
  “服务端标记或本地名单”的并集，本地名单命中不会被服务端 `false` 降级。
- 更新链已补严格 SemVer 只升不降、Windows 解压后主程序校验，以及 macOS bundle
  身份/架构/签名校验和启动失败回滚。

### 3.2 明确未迁移

- XDMaker 原有服务端及任何已从 Cindy 客户端仓迁出的服务端代码。
- S1 通用能力包：
  - `resources/builtin-plugins/meka/`
  - capability pack loader/activation/recovery/snapshot/inspector
  - 通用 capability pack 的 Claude/Codex delivery 全链
  - Meka 插件化能力包 UI

这里的“暂不迁移 S1”不包括项目和角色配置。项目/角色是 Meka 核心配置，已用独立的
直接运行时链路接入；被排除的只是通用能力包注册、激活、状态、白名单、快照、恢复和
检查器体系。

- S3 移动端/device-link 主观改造。
- 与 Meka 无关的 XDMaker 历史合并、通用修复、旧 UI 和仓库基础设施改动。
- XDMaker 中已有但 Cindy 已采用不同实现的模块。

### 3.3 等待手测或发布环境验证

- 真实旧 Meka userData 副本到 `CindyMeka` 的只读迁移。
- 真实 Jira/GitLab 账号和 Issue 创建流程。
- 真实 MCPRouter 登录、实例创建、绑定和远程会话。
- Orca Worker 对真实 P4 根目录和远程实例的运行。
- Windows 原签名服务产出的安装包升级。
- macOS 原证书私钥签名后的升级与钥匙串体验。
- Cindy Meka 新安装包与独立更新渠道的完整升级。
- 同机同时运行普通 Cindy 与 Cindy Meka，分别登录同一账号并跨越至少一个 token
  刷新周期，确认两边登录态都保持有效。
- 本轮新会话入口、二级分组和项目/角色详情页的视觉、交互手测。

## 4. 各模块迁移明细

### 4.1 应用身份、安装与本地数据

目标是“安装不与原版 Cindy 冲突、数据目录独立，同时认领原 Meka 用户”。

当前身份锚点：

- Windows/macOS 可执行文件名：`CindyMeka`
- CN appId/AUMID/bundle id：`com.xd.cindy.meka`
- userData：`CindyMeka`
- global/dev 使用各自的 `-global` / `-dev` 派生身份，避免同机覆盖。
- Desktop deviceId：正式包与普通 dev 为 `cindy-meka-<machineId>`；显式隔离 sandbox
  为 `cindy-meka-dev-[<sandbox>-]<machineId>`，统一限制在 64 字符内。普通 Cindy
  继续使用裸机器指纹，旧 XDMaker Meka 使用 `meka-`，三者互不覆盖服务端
  `(userId, deviceId)` 设备槽。
- 自动验证：身份派生与启动顺序回归、Desktop typecheck、变更文件 ESLint 及根目录
  `pnpm test:unit` 已通过；仍需用正式 Cindy 与 Cindy Meka 同账号跨 token 刷新周期
  完成一次双开实机验证。
- DB 文件前缀：`cindy-meka`
- 更新器名：`cindy-meka-updater`
- 更新/CDN 前缀：`cindy-meka`
- `.cindy` 文件关联在 CN 区使用 `CindyMeka.CindyGhost`。
- Desktop 正式应用图标使用 Cindy 原画叠加左上 `MEKA` 斜角标签：荧光黄绿
  `#C7FF00`、深海军蓝 `#10182F`，标签顶边固定为画布宽度 50%、左边固定为画布高度
  44%（三角区域约 11%），所有尺寸共享同一几何比例。权威母版为
  `apps/desktop/resources/icon-master-1024.png`；Windows 由
  `scripts/generate-win-ico.mjs` 派生 16/24/32/48/64/128/256 七档 ICO 和 512 PNG，
  并同步 updater 的 PNG/ICO；macOS 由 `scripts/generate-mac-icns.mjs` 生成十档 ICNS
  与 Dock PNG。小尺寸仅允许像素取整和抗锯齿差异，不另设角标占比。

旧数据迁移锚点：

- 来源目录：`xdmaker-meka`，全程只读、不删除。
- 来源数据库：`xdt-maker-<userId>.db`（包含 `-wal` / `-shm`）。
- 目标数据库：`cindy-meka-<userId>.db`。
- 新旧账号系统 UID 不同时，优先复用 `xdmaker/meka/main` 已落盘的
  `migration/identity-anchor.json`，按当前 email 唯一匹配旧 UID；没有身份锚时只接受
  唯一一个非 smoke 主库。多账号、损坏锚或多候选均失败并保留重试，不按 mtime 猜测。
- `xdt-maker-__smoke_test__.db` 永不参与真实用户迁移；早期测试包若已误迁该库，会在
  目标库、sidecar 与 migration runtime identity 文件留下
  `*.before-smoke-repair.bak` 后重新认领真实旧库。
- 主库使用 SQLite online backup 复制，把 WAL 中已提交事务合入完整目标库，并在落位前
  通过 `quick_check` 和核心表检查；不把旧 WAL/SHM 与新主库直接拼接。
- 同步迁移媒体、dialogues、受管浏览器 profile、`meka-assistant-settings.json` 与
  `meka-roles/`；目标已有配置不覆盖。
- `safe-storage` 不跨应用身份复制；用户在 Cindy Meka 中重新登录/授权。
- 早期 Cindy Meka 测试包曾使用裸机器指纹；升级到产品前缀后，旧 refresh token
  不能跨 deviceId 续期，测试用户可能需要一次重新登录。Cindy Meka 尚未正式发布，
  首发必须直接携带新 deviceId 身份，不能继续发行裸指纹版本。

深链边界：

- Desktop 主 scheme 为 `cindy-meka://`。
- OS 注册 `cindy-meka://`、`xdmaker-meka://`、`xdt-maker://`，不注册 `cindy://`。
- 内部解析额外兼容 `cindy://`，复用上游链接语义且不抢占同机 Cindy 的协议关联。
- device-link 和移动端跨端 wire protocol 固定使用 Cindy 互操作常量，不随 Desktop
  安装身份变化。

关键实现：

- `packages/maker-shared/src/brandIdentity.ts`
- `packages/maker-shared/src/branding.ts`
- `apps/desktop/forge.config.ts`
- `apps/desktop/src/main/bootstrap-electron.ts`
- `apps/desktop/src/main/index.ts`
- `apps/desktop/src/shared/deepLinkSchemes.ts`

### 4.2 发布、签名与热更新

新 Cindy Meka 渠道的产物语义：

- 版本产物基名：`cindy-meka-<version>`
- Windows 安装包：`cindy-meka-<version>-Setup.exe`
- Windows 热更 ZIP：`cindy-meka-<version>.zip`
- macOS DMG/ZIP：`cindy-meka-<version>-<arch>.dmg/.zip`
- 构建信息 product：`cindy-meka-desktop`
- CN 有版本构建要求显式提供 Cindy Meka CDN 基地址。

Windows：

- 支持原 `NPKG_TOKEN` 签名服务。
- Token 只从环境读取，不进入命令行参数、仓库或构建产物。
- 包内 exe、installer 和 uninstaller 走统一签名入口。

macOS：

- 支持 `developer-id`、`self-signed`、`adhoc` 三种模式。
- 原 Meka 证书可通过 `APPLE_SIGN_IDENTITY` 继续使用。
- `self-signed` 模式关闭 timestamp，不要求 notarization 账号。
- 有版本发布默认不允许无意间产出未签名包；显式放行需使用对应参数。

打包入口只产出本地安装包、热更 ZIP 和 `build-info.json`，不会上传 OSS/CDN。发布侧由
`publish-desktop.mjs` 读取该文件，重新校验签名状态、文件大小与 SHA256 后，把 installer/
hotfix 上传到 Cindy Meka 独立 RustFS bucket，最后写 canary manifest；经真实验收后由
`promote-desktop.mjs` 备份并推进 stable，`rollback-desktop.mjs` 可恢复指定 stable 备份。
版本化产物在正常发布链路中保持不可变；同路径内容不同的同版本重发会被拒绝。
内网 RustFS 撤回 canary 时，`reset-canary-desktop.mjs` 会先校验 stable 引用资产，按
版本与内容哈希备份当前 canary manifest，将 canary 指针对齐到 stable 并完成反向校验，
再删除被撤回版本的 installer/hotfix；删除前确认最终 stable/canary 均不引用目标，且
Claude/Codex runtime 不参与清理。脚本自动扫描并清理当前架构中版本高于 stable 的标准
installer/hotfix，因此指针已提前对齐时仍可直接重复运行同一 reset 命令处理遗留对象。
该操作不会让已安装更高 canary 的客户端降级。
正式 S3 API 与公开对象入口为 `https://s3.meka.pawdy.fun/`，管理控制台为
`https://s3-admin.meka.pawdy.fun/`；控制台地址不进入客户端或发布脚本配置。发布 S3 与
客户端下载均强制 HTTPS，不再保留内网 HTTP 放行开关。
Windows 热更不会重新执行 NSIS；为使图标资源替换后任务栏 AppUserModelID 分组与文件
关联不继续显示旧缓存，更新器只在新进程启动验证成功后 best-effort 发送
`SHChangeNotify(SHCNE_ASSOCCHANGED)`。通知不改变更新成功判定，失败／回滚路径不发送。
热更由更新前版本的 updater 执行，首次引入该通知的版本被旧 updater 安装时不会触发；
验证和发布评估必须覆盖“已带新 updater 的版本再更新到更高版本”的第二跳。
详细配置和操作见 `docs/migrations/cindy-meka-release.md`。

关键实现：

- `apps/desktop/scripts/package-desktop.mjs`
- `apps/desktop/scripts/ci/package-lib.mjs`
- `apps/desktop/scripts/sign.py`
- `apps/desktop/.env.example`
- `scripts/__tests__/meka-release-identity.test.mjs`

旧 XDMaker Meka 不直接热更新到 Cindy Meka；用户安装新应用后由首次登录迁移接走数据。
新渠道发布代码已补齐，但首次正式发布仍必须在真实 RustFS/CDN、Windows 原签名服务和
macOS 原证书环境做 canary → stable 全链验收；代码级门禁不能替代真实安装升级验证。

### 4.3 Meka 设置

已迁移：

- 插件界面显示方式：默认沿用现有停靠面板；「设置 → Meka 助理 → 插件默认打开方式」
  可切换全局默认。该布尔偏好属于本机 Renderer 界面 override，默认 `false` 不落盘，用户
  开启时仅在 localStorage 的 `xdt:ghostPanelPresentation:v1` 记录 `true`，关闭即删除
  override、重新跟随停靠产品默认。声明 `panel.allowUserPresentationOverride: true` 的
  停靠插件还会在自身详情「配置」区获得“跟随默认／停靠在对话窗口／弹窗打开”三态设置；
  显式值按 runtime plugin ID 写入 `xdt:ghostPanelPresentationOverrides:v1`，选择跟随默认
  即删除该项。有效优先级为插件级用户 override → 全局默认 → 停靠产品默认；`tab` 插件
  保持 manifest 页签语义，不开放覆盖。Meka P4 是首个示例声明。
  2026-07-30 定向验证覆盖 manifest 收词与拒装、全局/插件级优先级和继承恢复、气泡过滤、
  宿主设置组件及 Forge 作者手册，共 172 项测试通过；Desktop typecheck、变更文件 ESLint、
  i18n key 一致性及术语门禁通过。
  插件目录的列表与详情“打开界面”统一改由同一个 launcher 解析上述优先级和承载形态；
  Modal 目标先以关闭态挂载，下一 animation frame 再打开，修复详情页首次可信点击同时
  创建 Dialog 时被 outside interaction 立即关闭、而列表再次点击才生效的不一致。切换
  目标、离开详情或停用插件会取消待执行的打开请求；4 项 launcher 回归测试及原有 Modal
  测试通过。
  Modal 覆盖主页面 90% 宽高，并直接复用原沙箱面板内核；开启后相应插件的停靠
  面板和最小化气泡只在视图层隐藏，布局树、气泡位置和重装位置记忆不改写。插件列表卡片
  与详情页对所有声明 `panel` 且已启用的插件提供「打开界面」；停靠型插件在关闭 Modal
  override 时返回工作区并恢复原面板，插件目录没有具体会话宿主时，`position: "tab"` 的显式打开
  使用同一 Modal 兜底。列表卡片沿用原插件卡片布局；存在「打开界面」时，按钮操作区改为
  纵向排列以避免挤压来源、版本和插件 ID，元信息保持单行并只截断 ID。打开按钮是独立操作，
  不改变当前详情选择状态。Modal 面板的 WebView 在 `dom-ready` 后接管键盘焦点，以避免
  Radix 对话框初始焦点停留在关闭按钮、导致插件内部树／列表收不到真实方向键；停靠与页签
  面板仍保持被动焦点策略，不在重载或热更新时抢走宿主输入。Modal 首次打开后，关闭只把
  宿主内容与遮罩切为不可见、不可交互，不卸载沙箱 WebView；再次打开同一插件会恢复原有
  选择、滚动、输入和在途命令界面。插件逻辑页与 Node worker 继续沿用独立后台生命周期，
  不因 Modal 显隐启动或终止；停用、卸载、内容 revision 更新或插件页真正卸载仍会按原规则
  清理／重建对应面板实例。隐藏态 WebView 不抢宿主焦点，重新打开时复用实例并重新接管
  键盘焦点。实机用 Meka P4 在扫描进行中关闭 Modal，关闭态 WebView target
  保持存活并在后台完成扫描；重新打开后 target 身份与关闭前内存标记均保持不变。
- P4 根目录读取、保存和 `saga2_design` / `saga2_json` / `saga2_unity` /
  `saga2_pm` 目录发现。`saga2_pm` 是项目管理工作区，包含长期 PM 治理规范、
  AI 开发流程看板、用于交付评估的可复用 Agent Skill，以及版本交付和收尾记录。
  已经保存过 P4 根目录的用户无需重新选择路径，读取设置时会补充识别
  `saga2_pm`，且不会因此改写配置文件。
- MCPRouter 登录、断开、工具路由、项目实例和项目绑定。
- MCPRouter 地址默认预填经 Caddy 终止 TLS 的正式域名
  `https://mcpr.meka.pawdy.fun/`，并允许通过 `VITE_MEKA_MCPROUTER_URL` 覆盖为另一个
  无凭据 HTTPS 地址；HTTP 或非法 override 会回落正式域名。Caddy
  使用 DNS-01 为该仅解析到内网地址的域名申请公开信任证书，Cindy 与浏览器无需安装私有
  根 CA。MCPRouter 已全面停用 HTTP 与裸 IP 入口；任何历史 HTTP 或裸 IP base 都在
  运行期统一迁移到该生产 HTTPS 地址，其他 HTTPS 域名 endpoint 仍保持原值。登录继续
  使用 Electron Chromium 网络栈，使系统代理、公开证书校验与插件 API 保持一致，不关闭
  或绕过全局证书验证。
- MekaDesign 支持不依赖 MCPRouter 的独立 HTTP(S) endpoint 配置；完整 endpoint
  （包括 query 中的授权参数）只持久化在 OS 加密存储。
- 登录或刷新已认证的 MCPRouter 时读取 Router 中已有的 MekaDesign 路由作为地址候选：
  本地未配置时自动采用；与本地地址不一致时由设置页询问“替换地址/保留当前地址”，
  未确认前不覆盖本地配置。路由读取失败不影响 Router 登录，保留本地状态并在后续刷新
  重试。
- MekaDesign 和 MCPRouter 的连接生命周期相互独立：断开 Router 保留 MekaDesign；
  主动断开 MekaDesign 后记录本地 override，不会在下一次刷新时被同一 Router 路由
  自动恢复。
- OS 加密存储中的 Router 凭证。
- 旧 Meka 设置文件形状兼容。
- 新版本配置文件的只读保护，避免旧客户端降级覆盖未来 schema。

边界：

- 保存 P4 字段时不覆盖 Router/Design 或未知字段。
- Router 写入不覆盖 P4 和未知字段。
- 非敏感配置文件中的 `mekadesignConfigured` 只表示 endpoint 是否已配置；
  `mekaDesignRouterSyncSuppressed=true` 表示用户曾主动断开并覆盖 Router 自动同步。
  该字段缺失/`false` 时允许自动采用候选，重新手工配置或确认替换后恢复为 `false`；
  两个字段都不保存 endpoint 或凭证。
- MekaDesign 的本地 endpoint 是代理会话唯一使用的设计工具入口。MCPRouter 只提供
  地址发现候选和其他 Router 工具，不能作为第二条 MekaDesign 调用通道。
- 地址冲突状态只向 Renderer 返回不可逆 conflict ID；确认替换时由 Main 重新读取
  Router 候选，不为本功能新增将候选完整 endpoint 下放 Renderer 的路径。
- 原始凭证不进入 renderer、项目文件或 Git。

关键实现：

- `apps/desktop/src/main/meka-settings/`
- `apps/desktop/src/renderer/components/settings/MekaAssistantSettingsSection.tsx`
- `apps/desktop/src/shared/meka-settings.ts`
- `apps/desktop/src/shared/meka-router.ts`

### 4.4 项目、角色和内置内容

已迁移：

- `meka_projects` / `meka_roles` 注册表。
- 项目配置的加载、原子保存、路径校验和身份校验。
- 编辑采用“有效值 + 草稿”双状态：无变更时保存/取消不可用，取消恢复有效值，保存完整
  `project.json` 或角色 manifest 后重新读取并刷新有效值，避免 Renderer 分两步写出
  项目表和配置文件的不一致中间态。
- SAGA2 项目配置只锁定内置项目路径和删除操作；名称、描述、正式流程、学科/领域及
  元数据保持 XDMaker 原有可编辑语义。保存写入已配置 P4 根目录的
  `.meka/project.json`，运行时读取时与包内 SAGA2 基线合并，不修改应用资源。
- 角色 manifest 的创建、读取、更新和删除。
- 角色左侧导航只显示标题；内置角色仍只读，但可复制为自定义角色后编辑。
- 项目元数据扫描：rules、skills、MCP、`AGENTS.md`。
- 角色技能恢复为 XDMaker 的内置技能目录选择，不再要求手工输入 Skill ID；旧版路径引用
  和目录中无法识别的历史 ID 仍可见、可保留或移除。
- 项目正式流程配置恢复 Jira 链接剪贴板识别和 GitLab URL 从项目 Git Remote 读取。
- 项目配置文本框统一使用 Cindy Settings 输入 token；静止状态只显示普通边框，只有
  获得焦点时使用 focus border，Light/Dark 共用设计变量。
- 原始 MCP 凭证拒绝写入；只允许 `{{secret:name}}` 引用。
- 内置 SAGA2 项目。
- 6 个内置角色：
  - 通用开发
  - 战斗配置
  - 战斗调试
  - 系统开发
  - 系统调试
  - 系统总览
- 内置项目/角色幂等播种。
- 旧 Meka 会话缺少项目绑定时回填到 SAGA2。

项目与角色配置的运行时契约：

- SAGA2 `project.json` 与 6 个内置角色 manifest 已按 JSON 结构逐项核对，与
  `xdmaker/meka/main` 当前内容一致；迁移只改变 Cindy 内的资源落点和直接运行时适配，
  不重新解释或删减角色选择。
- 进一步以 `xdmaker/meka/main` Git 对象做逐文件 hash/逐行核对：SAGA2 `project.json`
  和 6 个角色 manifest 均逐字节一致；6 个内置 Skill 中 P4 Skill 逐字节一致，其余
  Skill 只保留 Cindy 架构所需的最小术语适配（capability/snapshot → 当前项目与角色配置，
  allowlist → 当前项目实例绑定）。远程操作 Skill 的实例发现、创建模板、绑定确认、
  Remote Orca Worker 目标校验、报告和失败分支已完整保留，不能再压缩成摘要。
- 项目 `roleDefaults` 先与角色 manifest 合并；角色同 id 配置覆盖项目默认项，
  `excludeDefaults` 可精确排除项目默认 Skill、MCP 和项目元数据。
- 角色 `prompt`、已启用规则、选中的 `AGENTS.md`/规则元数据直接追加到该 Meka
  会话的 per-session system prompt。
- 旧 path-based 角色 Skill 与 `promptFragments` 仅作为历史角色文件兼容输入，仍从角色
  manifest 相对目录安全解析；它们不会转换成 snapshot。
- 内置 Meka Skill 与项目内选中的 `SKILL.md` 都由当前项目/角色配置解析。正常的
  P4/自定义项目会话直接把完整 Skill 内容投影到该会话 prompt，不向用户项目写入
  `.claude`、`.agents` 或其他生成文件；只有应用托管的历史兼容 workspace 才投影到
  Claude 的 `.claude/skills` 和 Codex 的 `.agents/skills`，并清理上一版由 Meka
  生成的同类投影。
- 项目元数据总开关优先于角色选择；项目禁用的条目不能被角色重新启用。项目 Skill id
  使用与原版一致的确定性规范化和冲突后缀规则，中文目录名不会导致会话启动失败。
- 角色与项目默认 MCP provider 引用直接决定本会话是否挂载 MCPRouter；
  项目绑定继续限制实例类 Router 工具。项目元数据中的 MCP 配置也参与解析。
- 角色选择 `meka-design` 时挂载独立的 `meka_design` provider，并从 OS 加密存储读取
  当前唯一 endpoint。即使同一角色也启用了 `mcp-router`，Router 的项目级工具发现会
  过滤其 MekaDesign 静态路由，直接调用同类 Router 工具也会拒绝，避免同一会话同时
  访问两个设计地址。
- Claude 会话直接使用 HTTP provider；Codex 的进程级 MCP 集合在首个 thread 前冻结，
  因此无论启动时是否已配置 endpoint 都预注册本地 `meka_design` 动态代理，并在每次
  `tools/list` / `tools/call` 时读取最新加密配置和可信 thread context；运行中新增或替换
  endpoint 不需要重启 Codex host。非 Meka 会话或未选择 `meka-design` 的角色只得到空
  工具列表，不能借进程级 bridge 越权访问 endpoint。
- `meka-host-risk-policy` 与 `meka-p4-boundary-policy` 是当前内置角色允许的 Host
  policy 引用；未知 policy 引用会阻断启动，避免配置被静默忽略。MCPRouter 每次调用
  都重新核对工具、项目实例绑定和风险元数据，高风险调用复用 Cindy permission
  interaction 且每次都需用户显式允许。
- 新建 SAGA2 会话时，项目路径标记 `saga2` 必须解析成当前设置中的绝对 P4 根目录；
  自定义项目也必须提供绝对路径。P4 根目录未配置时阻断创建，不能把 `saga2` 当作相对
  目录启动。某个已选择项目元数据文件在本机缺失时仅记录警告并跳过该条，避免部分仓库
  未同步就阻断所有会话；未知内置 Skill、项目/角色错配、缺失 manifest 等核心配置错误
  则阻断启动，避免静默降级。
- SAGA2 普通会话发送和创建目标前还会先检查 P4 根目录及至少一个已识别子目录；缺失时
  恢复 XDMaker 原确认弹窗，并可跳转“设置 → Meka 助理”。设置 IPC 自身异常沿用原版
  fail-open，避免读取故障误阻断全部会话。
- 配置在每次 session bootstrap 时直接读取，没有 capability snapshot、激活状态或
  白名单作为第二真相源。P4/自定义项目和远程会话都将同一批已解析 Skill 内容随该会话
  prompt 下发。

关键实现：

- `apps/desktop/src/main/meka-projects/runtimeConfig.ts`
- `apps/desktop/src/main/mcp-integrations/meka-runtime-mcp.ts`
- `apps/desktop/resources/meka/skills/`
- `apps/desktop/src/main/maker-ipc/register.ts`
- 保留用户自有的保留 ID，不用内置播种覆盖用户数据。

关键实现：

- `apps/desktop/src/shared/meka-projects.ts`
- `apps/desktop/src/main/meka-projects/`
- `apps/desktop/src/main/localDb/ipc/mekaProjects.ts`
- `apps/desktop/src/main/localDb/ipc/mekaRoles.ts`
- `apps/desktop/src/main/localDb/ipc/mekaProjectMetadata.ts`
- `apps/desktop/resources/meka/projects/`
- `apps/desktop/resources/meka/roles/`
- `apps/desktop/src/main/meka-projects/resourcePaths.ts`
- `apps/desktop/forge-meka-resources.ts`

### 4.5 Meka 会话与正式流程

已迁移的会话字段：

- `workspace_kind = 'meka'`
- `meka_project_id`
- `meka_role_id`
- 旧版 `meka_role`
- `is_formal`
- `formal_type`
- `formal_link`
- `formal_ref`
- `formal_content_json`
- 历史 schema 中仍保留 `capability_snapshot_json` 兼容列，但应用 DTO、创建参数和
  Renderer Session 类型已移除 snapshot 字段；Main 不读取或写入该列，新会话依赖数据库
  默认 `NULL`，项目/角色运行时也不把该列作为配置来源。
- 历史四角色会话没有 `meka_role_id` 时，不改写旧数据库行；启动时只读映射到当前
  SAGA2 角色配置：planner → system-overview、tester → system-debug、
  artist/programmer/未选角色 → general-development。新会话仍必须显式提交项目和角色。

创建时冻结项目、角色和正式流程数据，后续普通 session patch 不能偷偷替换这些身份字段。

正式流程：

- Jira 链接必须属于项目配置的 Jira Key。
- GitLab 链接必须属于项目配置的 HTTPS host/project。
- Issue 内容做大小和结构校验后冻结到会话。
- 首条消息由 provider 以确定性方式生成。
- 兼容旧 Jira 字段向 provider-neutral formal 字段迁移。

侧栏：

- Meka 是 Projects / Dialogues 的同级产品区。
- 项目即使尚无会话也会显示。
- 启用且配置完整的正式流程项目固定显示：
  - 正式流程
  - 普通会话
- 历史 `is_formal = 1` 会话直接归入“正式流程”。
- 正式流程未启用时保持扁平显示，避免旧 formal 标记制造虚假分组。
- 删除或暂时不可用的项目绑定仍显示在“不可用项目”分组。
- 旧版无项目绑定会话保留在“旧版 Meka 会话”分组。
- 置顶和活动时间排序语义沿用 Cindy 现有会话列表。

新建入口：

- Meka 只作为一级产品分类，SAGA2 与用户新建项目是其下平级项目。
- 未配置正式流程时，项目行悬浮提供普通会话新建入口。
- 已配置正式流程时，项目行不再提供含糊的新建动作；“正式流程”和“普通会话”
  二级分组各自悬浮提供对应的新建入口。
- 普通会话沿用 XDMaker Meka 原流程，进入 Cindy 统一 `/cc-agent/new` 草稿页，而不是
  在项目/角色管理页直接建空会话。
- 直接改造并复用草稿页右上角原有的项目/对话选择控件，在同一个弹层中提供普通对话、
  Cindy 项目和 Meka 项目普通会话；Meka 项目不是第二套项目按钮，也不在此暴露正式流程。
  角色选择仅在 Meka 草稿中新增到原项目选择器左侧，保证项目选择器及其右侧
  branch/worktree 控件位置不因会话类型变化；角色控件复用原控件的尺寸、token 和
  Cindy 模型选择弹层的搜索、列表、选中态与空结果交互。正式流程锁定项目但仍允许
  选择角色。
- 正式流程先打开 Jira/GitLab 事项选择器；Main 校验账号、项目归属并冻结事项快照成功后，
  才进入同一个 `/cc-agent/new` 草稿页。
- 正式草稿预填 provider 生成的确定性首条消息，并显示事项 ref；退出正式流程后退回同项目的
  普通 Meka 草稿。
- 项目/角色管理页只负责配置，不再提供普通/正式会话的旁路创建入口。
- Cindy 原有草稿页内容保持不动：顶部模式/分支/worktree、底部模型与权限、快速开始和
  “新建目标”等保留原位置与原行为；Meka 只增加必要的项目/角色上下文。

关键实现：

- `apps/desktop/src/main/localDb/mapper.ts`
- `apps/desktop/src/main/localDb/ipc/sessions.ts`
- `apps/desktop/src/main/localDb/ipc/mekaFormal.ts`
- `apps/desktop/src/main/meka-formal/`
- `apps/desktop/src/renderer/features/cc-agent/MekaFormalIssueModal.tsx`
- `apps/desktop/src/renderer/features/cc-agent/NewMakerDraftRoute.tsx`
- `apps/desktop/src/renderer/features/cc-agent/sidebar/sections/MekaAssistantSection.tsx`
- `apps/desktop/src/renderer/features/cc-agent/useMekaSessionScope.ts`

### 4.6 项目/角色管理 UI

初次迁移把项目切换、项目表单、全部角色、远程 MCPR、项目知识和正式流程一次性铺在
同一长页面中，不符合 Cindy 已有管理页面的渐进式层级。本轮改为：

- 点击顶部 Meka 页签先进入项目库，不默认选中第一个项目、不展示任何配置表单。
- 项目库复用插件页的居中宽度和标题层级；项目卡片直接同步本地 Skill 卡片的网格、
  尺寸、图标容器、阴影、hover、标题行、描述行与右侧进入箭头，不单独设计 Meka 卡片变体。
- 项目卡片展示项目名称与描述/路径；内置项目在 Skill 卡片“本地”来源标识的同一位置
  显示“内置”，当前内置 SAGA2 通过项目数据的 `isBuiltin` 字段识别，不按名称硬编码。
- 项目详情复用 Skill 详情页的 72px 顶栏与“左侧导航 + 右侧内容”骨架。
- 顶栏固定展示返回入口、项目名称、路径与当前内容对应的保存/删除操作。
- 左栏上方固定为“项目信息”，下方为角色列表和新建角色入口。
- 选择“项目信息”时，右侧按 XDMaker 原流程顺序显示：基础信息 → 项目信息
  （项目路径、工作流类型和 Jira/Gitlab 项目标识）→ 远程 MCPR → 职能 / 领域 → 元数据发现。
  正式流程配置属于靠前的“项目信息”，不能放在元数据之后。
- “职能 / 领域”沿用原版标题与说明：「通用」是职能兜底且只读不可删，领域与职能交叉
  打标并允许为空；不得改写成含义不同的“学科”等新文案。
- 元数据发现按原版固定分为 Skill、规则、MCP、`AGENTS.md` 四组，各组独立显示数量、
  空状态和条目编辑，不能把不同来源类型混排成一个项目知识列表。
- 选择某个角色时，右侧按原流程显示基础信息 → 提示词 → 全局规则 → 技能 → MCP；
  规则/技能/MCP 对应位置可选择项目元数据。内置角色只读，可复制成自定义角色后编辑。
- 角色页面与运行时完整使用项目/角色 manifest；不恢复已明确排除的通用 S1 capability
  pack catalog、激活、状态、白名单、快照或 inspector。
- 单行输入和按钮使用 pill；textarea 使用 8px 内层圆角；容器使用 12px 圆角。
- 所有颜色来自 Cindy token，未增加硬编码颜色。
- Light/Dark 共用语义 token。
- 四语言文案同步。
- 移除页面结构层级的阴影，遵循 Cindy flat Surface 规则。

Meka 会话侧栏不建立独立视觉规范，项目行、会话行、二级分组、缩进、hover 和悬浮
动作均复用 Cindy 现有 Projects/SessionItem 的尺寸与 token。

迁移 UI 的长期约束：

- 所有 Meka 页面优先复用 Cindy 已有布局、组件和交互，不建立平行设计系统。
- 新增 Meka 列表页、详情页或配置页前，先在 Cindy 中寻找同层级的现有布局类型：
  集合入口优先复用 Plugin/Skill 卡片列表，单对象配置优先复用 Skill detail 左右分栏，
  不得因来源实现是 XDMaker 就把表单平铺成独立页面。
- 不为了容纳 Meka 而删除、移动或替换 Cindy 页面已有内容；确需增加上下文时，放入
  Cindy 已有的同语义位置。例如草稿页右上角原项目选择器只增补 Meka 项目数据源，
  仍统一负责普通对话/Cindy 项目/Meka 项目普通会话切换；角色选择只能加在其左侧，
  复用相同视觉与弹层语义，不得改变原项目选择器的右侧锚点。
- 新增页面同时使用 Light/Dark 语义 token；不得用只适配单主题的硬编码颜色。
- XDMaker 仅作为产品流程与数据语义的事实来源；呈现层以 Cindy 当前 `DESIGN.md` 为准。

关键实现：

- `apps/desktop/src/renderer/features/cc-agent/MekaProjectRoleEditorRoute.tsx`
- `apps/desktop/src/renderer/features/cc-agent/MekaProjectRemoteInstances.tsx`
- `apps/desktop/src/renderer/i18n/locales/*/common.json`

仍待手测：

- 窄窗口响应式布局。
- 项目/角色数量较多时的导航密度。
- Light/Dark 的视觉层级。
- 从侧栏新建、切换角色、保存、创建会话的完整交互。

### 4.7 远程 MCPRouter

已迁移：

- Router 账号连接和 cookie 安全存储。
- 静态工具/路由读取。
- 设置页按 MCP endpoint 聚合并展示“客户端”，不暴露具体工具名称；同一客户端下的
  静态路由按组启停，内置/Worker 工具只读。
- Router 返回的 `clientName=MekaDesign` 元数据用于识别候选 endpoint；兼容旧版没有
  clientName、但保留了唯一 `?key=mcp_...` endpoint 的历史路由。
- Cindy 配置 MekaDesign 时只保存独立 endpoint，不再向 Router discover 或删除
  Router 路由。代理会话通过独立 `meka_design` provider 使用该 endpoint；Router
  provider 会过滤已识别的 MekaDesign 工具名称并拒绝旁路调用。
- 项目实例和模板读取。
- 设置页只读展示“远程模板 → 实例 → 可用状态”概览；创建实例和项目绑定仍归项目详情，
  不在全局设置中修改项目归属。
- 从模板创建实例。
- 项目与实例绑定。
- 经授权 cookie 建立 agent tunnel WebSocket。
- 远程实例的可用性、支持状态和绑定校验。
- 不接受 renderer 伪造的远程目标。

未迁移 S1 的通用 capability bundle。MCPRouter provider 由项目/角色配置直接选择，
并按当前项目的实例绑定过滤工具；这条链路不依赖通用能力包状态或快照。Router
声明高风险或 Host 根据工具名/结构化 action、environment 判定为高风险的调用，会进入
Cindy 现有权限确认；无窗口、无会话监听或未明确允许时一律拒绝。

关键实现：

- `apps/desktop/src/main/meka-settings/routerClient.ts`
- `apps/desktop/src/main/meka-settings/routerService.ts`
- `apps/desktop/src/main/maker-host/mcpr-tunnel.ts`
- `apps/desktop/src/renderer/components/settings/MekaAssistantSettingsSection.tsx`
- `apps/desktop/src/renderer/components/settings/mekaRouterSettingsModel.ts`
- `apps/desktop/src/renderer/features/cc-agent/MekaProjectRemoteInstances.tsx`
- 外部配套仓 `C:\Workspace\ttdbl3\agentic-os\mcp-router`：
  `packages/server/src/management/route-routes.ts`、
  `packages/server/src/db/repos/static-routes.ts`、`packages/server/src/db/schema.ts`、
  `packages/server/src/routing/loader.ts`、`packages/server/src/management/worker-routes.ts`
  和 `packages/web/src/api/workers.ts`

#### 4.7.1 MCPRouter Meka 插件仓库

本轮新增的 Meka 插件分发不依赖上游 Cindy 服务端。公开目录只依赖 MCPRouter 部署地址，
个人与指定用户分享目录复用已绑定 MCPRouter 的身份：

- MCPRouter 同进程加载独立 `@mcp-router/meka-plugin-registry` package；后台新增
  “Meka 插件”页签，普通用户可上传自己的 `.cindy` Release、切换仅自己／公开／指定用户
  分享，并软删除自己的插件。
- 后台管理继续使用 MCPRouter Session Cookie。未绑定客户端使用独立的
  `/api/public/plugins*` 列表、详情和下载授权接口，不发送任何凭证且只能观察
  `visibility=public`；已绑定客户端使用 `/api/plugins*`，携带 Meka 绑定时自动创建并保存到
  OS 加密存储的 client key，可观察公开、自己拥有及明确分享给当前 Router 用户的插件。
  Cindy 登录 access token、Router Session Token 和密码均不进入插件交付请求。
- MCPRouter 内部 `private / shared / public` 对 Cindy plugin delivery v2 分别投影为
  `personal / personal / public`；分享 ACL 不进入 wire protocol。
- `.cindy` 原始字节按 SHA-256 内容寻址写入 MCPRouter 的持久化数据目录；Release
  不可覆盖，修改包内容必须上传新版本。下载继续遵守客户端既有 HTTPS、短期过期、
  Content-Length 和 SHA-256 校验。上游 Cindy 市场继续保持 8 MiB 上限；Meka 市场仅在
  Release manifest 已通过共享校验且声明 `node` 时允许最多 128 MiB，普通 Meka 插件仍为
  8 MiB。该渠道策略只注入 Meka 的独立 service 实例；下载按流写入排他创建的临时文件并
  增量计算 SHA-256，失败清理未验证文件，不在 Main 内存聚合完整大包。内网部署由 Caddy
  在标准 443 端口为
  `https://mcpr.meka.pawdy.fun` 终止 TLS，MCPRouter 容器内的 HTTP 只用于反向代理和部署机
  本地诊断；证书通过 DNS-01 签发且公开受信。客户端继续直接复用
  `@cindy/plugin-protocol` 的单参数、HTTPS-only parser，不修改协议 submodule，也不为
  Meka 渠道增加明文 HTTP 例外。
- Meka 市场显式安装／更新使用 Desktop-local 的 operation-scoped 进度事件：Renderer
  生成 UUID，Main 只向发起安装的可信 WebContents 回传准备完成后的下载字节与安装阶段，
  preload 校验 payload；市场详情安装／更新按钮以及已安装插件详情、列表更新按钮都展示
  准备、下载百分比和安装／更新状态。事件不携带签名 URL、临时路径、凭证或包内容，页面
  关闭不会取消已经开始的安装。Mobile／device-link 不提供插件市场管理入口，因此该事件
  不加入远程 invoke／push allowlist。
- Cindy 原插件市场继续使用 `pluginApiBaseUrl`；Meka 插件市场始终使用 MCPRouter 地址。
  客户端每次请求都重新读取当前绑定状态：完整绑定存在时走鉴权接口，未绑定或断开后走
  匿名公开接口，不以 401 自动回退，也不复用过期的个人目录结果。未保存 Router 地址时使用
  当前版本的 `DEFAULT_MEKA_MCPROUTER_URL`（支持既有构建期 override）；自定义地址在登录
  配置存在期间继续作为 registry origin。两条市场渠道共用 v2 parser、完整
  manifest/runtime 校验、权限扩张确认和原子替换，但使用相互独立的 owner-scoped ledger；
  从页签顶部导入的本地包另由 host 侧渠道账本记录用户选择，
  避免本机插件或 Cindy 市场插件被误归为 Meka，且不信任 `ghost.json` 自报来源。
- 插件管理页把该远端目录独立为最前面的“Meka 插件”一级分类；“Meka 插件”和“插件”
  都保留本机插件的导入、创建、启停与配置，差异只在分发渠道：普通“插件”显示手动安装
  与 Cindy 市场归属项，“Meka 插件”只显示 MCPRouter 目录和由其独立账本确认安装的项；
  从该分类“创建 Meka 插件”时，创作任务明确标记为 Meka 渠道并提示打包后到 MCPRouter
  上传。创建提示要求 `ghost_forge_pack` 显式传 `channel: "meka"`；该一次性渠道上下文
  随待安装事件进入标准确认／安装流程，只有安装或更新成功后才写入 Meka 的
  owner-scoped ledger。它不进入 `ghost.json`，普通 Forge、拖入和双击安装也不会推断为
  Meka。“技能”保持原 SkillHub 页面。
- Meka 分类的“添加插件”菜单另提供“从目录加载（开发模式）”。该入口独立于 Cindy 与
  MCPRouter 两套市场：用户选择源码目录并确认 manifest、信任和权限后，客户端将目录登记
  到当前 data owner 的本地开发注册表，并由隔离 watcher 持续监听。首次确认同时绑定排序
  后的包内路径／逐文件内容指纹、data owner 和 session generation；确认后目录内容变化或
  换号／重新登录均拒绝安装并要求重新选择。每次变更先在 OS 临时目录生成 `.cindy`，再
  复用现有包校验与原子 install/update；运行时仍只执行安装快照，不直接执行源码目录。
  原始源码包先完成签名／信任检查；Host 派生身份后移除已失效的源码签名，再把派生包按
  未签名开发快照重新完整校验。开发包使用由原始 plugin ID 派生的独立
  `meka-dev-*` runtime ID；
  slash command 同样派生 DEV 别名，展示仍保留原始 ID，并在卡片、快捷入口和详情图标上
  覆盖斜向 `DEV` 角标。失败保留最后可用快照，源码改 ID 则拒绝自动迁移。
  远端未安装版本、原始 ID 的正式安装版本和开发 runtime 可以同时存在：原市场仍只按原始
  ID 执行“未安装显示远端卡、安装后以安装卡替换远端卡”的规则，开发卡始终作为额外条目，
  不改变远端／正式版本状态。成功同步会重启对应开发运行时并刷新已打开的
  panel/settings WebView。
  移除开发条目会停止监听并走标准卸载；data owner 边界 teardown 会等待开发安装／同步
  mutation，并在切换前停止旧 owner watcher。普通“插件”分类、两套远端 API 和渠道
  ledger 均不感知此注册表，减少后续合并上游时的交叉修改。
- 开发卡右侧动作按能力声明收敛：`panel`、`command` 分别控制“打开界面”和“使用”，
  无直接能力时回落“详情”；开发卡额外提供“打包”。打包弹窗生成保留源码原始
  plugin ID／command 的正式 `.cindy`，可保存到本地；完整 MCPRouter 绑定存在时还可直接
  用 Main 持有的 session cookie 上传不可变 Release。弹窗在登录前后保持同一组动作；
  未配置 MCPRouter 时上传置灰，并原位复用“设置 → Meka 助理”的既有 MCPRouter 配置
  弹窗。登录完成后保留打包流程并立即启用上传，不跳转设置页。Renderer 不接触包字节、
  Router cookie 或密码。弹窗展示源码 manifest 版本，并通过 owner management API 回填、
  编辑和同步 `private / shared / public` 权限及 shared 用户名。远端存在旧版本时显示当前
  与目标版本并在发布前二次确认；相同版本遵守 Release 不可变约束，不覆盖包内容，只同步
  权限并提示先提升版本号再发布新内容。owner API 空列表按首次发布处理；已保存 session
  返回 401 时按登录失效处理，保留当前弹窗和本地打包，并原位提供重新登录入口。
- 未发布的 v1 开发注册表若已在手测环境产生，会在首次加载时迁移为同时记录
  `pluginId/runtimeId` 的 v2：先装入独立开发 runtime，再清理曾占用原始 ID 的旧开发快照。
- Cindy 与 MCPRouter 市场并存时，详情、安装、更新和卸载请求始终绑定当前页签对应的
  API 与 ledger；跨源 `ghostId` 冲突继续由既有本机安装冲突检查 fail closed。

服务端落地契约见 MCPRouter 仓 `docs/meka-plugin-registry.md`；客户端关键实现：

- `apps/desktop/src/main/meka-settings/routerService.ts`
- `apps/desktop/src/main/plugin-market/api.ts`
- `apps/desktop/src/main/plugin-market/service.ts`
- `apps/desktop/src/main/cindy-brain/mekaDevPlugins.ts`
- `apps/desktop/src/renderer/features/plugin/GhostPluginPage.tsx`

验证覆盖 `ghost_forge_pack` 渠道参数透传、pending 安装请求原子消费、普通安装不推断
Meka、安装与更新成功后写入独立账本、Meka 创建提示的渠道约束，以及开发目录登记、
owner 级持久化、自动同步、失败保留、双 ID 派生、v1 注册表迁移，以及远端／正式／开发
版本共存；Desktop 与 `cindy-tools` 均有对应定向单测和类型检查。

2026-07-29 开发目录模式定向验证：Desktop typecheck 通过；Forge、开发注册表双 ID
迁移、远程／正式／开发版本共存、移除与同步串行、DEV 角标、内容刷新、插件卡片／详情
与 Modal 的定向测试通过；变更文件 ESLint、`pnpm check:i18n` 与
`pnpm check:i18n-glossary` 通过，无新增术语违规。Light／Dark 实机与真实目录热更新仍待
开发者手测。

2026-07-29 未提交交付审查补充：开发目录首次确认已绑定稳定内容指纹与 app session，
data owner teardown 会等待安装／同步并停止旧 watcher；派生 runtime 包移除已失效的源码
签名后按未签名开发快照重新校验。Watcher client singleton 改为无副作用静态模块，由
Desktop bootstrap 在 `before-quit` 释放。渠道归属 IPC 仅接受已安装且合法的插件 ID；
MCPRouter 默认地址和 Meka 插件下载均保持 HTTPS-only。相关定向测试、Desktop typecheck
与 `cindy-tools` build 通过；协议 submodule 无修改。

2026-07-29 MCPRouter 公开目录补充：服务端把匿名 public 与 client-key 用户目录拆为独立
API；Desktop 每次列表、详情和下载授权请求前重新读取绑定状态，已绑定走用户目录，未绑定
或断开后走匿名公开目录且不发送凭证。client key 只有在对应 Router origin 已原子持久化后
才允许使用，避免连接自定义 Router 的保存窗口把 key 误发到默认 origin。Desktop
plugin-market／Router service 共 7 个测试文件、70 个测试及 Desktop typecheck 通过；
MCPRouter registry 24 个测试、Server 72 个测试及两个 package typecheck 通过。两种状态下
真实 Router 的列表切换与安装仍待开发者手测。

2026-07-30 Meka Node 插件大包补充：Meka 独立市场在共享 manifest 校验通过后允许
`node` 插件下载最多 128 MiB，普通 Meka 插件与上游 Cindy 市场继续保持 8 MiB。下载器改为
排他创建临时文件、流式写盘并增量校验大小与 SHA-256，任何未验证结果都在失败路径清理；
不修改协议或服务端。Meka 安装与更新按钮进一步按单次 UUID 隔离展示准备、下载百分比和
安装／更新阶段，覆盖市场详情、已安装插件详情及列表更新入口；Main push 仅返回非敏感字节
状态且不进入 device-link。定向测试、i18n／glossary、变更文件 ESLint 与 Desktop typecheck
均通过；完整 plugin-market 加 shared payload validator、renderer 进度按钮共 9 个测试文件、
67 个测试通过。真实 MCPRouter 下载 Meka Docs 并完成安装仍待开发者手测。

### 4.8 Orca Worker 微调

本模块不能只按“目标选择器”迁移。XDMaker `meka/main` 的 Meka Orca 是一条完整链路：
会话入口 → 建队 → Worker 目标选择 → Main 侧重校验 → Worker 项目/角色继承 →
本地或远程 transport → Worker/Lead 双向桥接 → UI 状态与恢复。以下清单以
`docs/meka-remote-orca-worker-phase2.md`、`docs/meka-remote-codex-worker-transport.md`、
`docs/meka/2026-07-22-project-role-defaults-and-remote-dispatch-design.md` 以及
XDMaker `meka/main` 对应实现为核对正本。

#### 4.8.1 XDMaker 功能清单与 Cindy 迁移核对

| 功能                   | XDMaker 行为                                                                     | 本轮核对时 Cindy 状态                                           | 迁移动作                                                                       |
| ---------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Meka 会话协同入口      | 已有 Meka Lead 会话显示协同开关                                                  | 缺失：仅允许 `workspaceKind=project`                            | 恢复 Meka 会话资格，继续排除 Worker、远程 Lead 和 device-link                  |
| Meka 草稿协同入口      | Meka 新会话草稿可直接开启协同，发送前完成 Lead/首个 Worker 建立                  | 缺失：草稿因无本地 `workingDir` 被隐藏并强制关闭                | 允许 Meka 草稿显示和启用；由 Main 为 Meka 会话分配工作区                       |
| 首个 Worker 目标       | 开启协同时可把本地目录或远程实例交给首个 Worker                                  | 部分：选择器能产出参数，但 `enableOrca` 调用链丢弃参数          | 补齐 Renderer、preload、IPC、lifecycle 全链透传                                |
| 后续 Worker 目标       | 协同侧栏新建 Worker 可选择目标                                                   | 已有 UI 和调用，但需连同 Main/运行时复核                        | 保留 Cindy 现有侧栏布局与选择器                                                |
| 本地 P4 目标           | 默认 P4 根；可选受设置管理的 SAGA2 子目录                                        | 已有 Main allowlist；当前包括 `saga2_design/json/unity/pm`      | 保留绝对路径归一化和 Main 侧精确白名单                                         |
| 远程 MCPRouter 目标    | 仅当前项目已绑定、受支持且 available 的实例可选；远端物理路径不暴露给 Agent      | Main 校验已有；MCP 工具回执缺失                                 | 保留项目绑定重校验，恢复 `remote_host_id` 和安全回执                           |
| Agent 主动建 Worker    | `create_worker` 支持 `working_dir` / `remote_host_id`                            | 缺失：schema 和 adapter 均未暴露目标字段                        | 恢复参数并复用同一个 Main 创建服务                                             |
| 执行位置回执           | `create_worker` 返回 `execution_target`，防止远程请求静默落到本地                | 缺失                                                            | 恢复 local/remote 结构化回执；远程不返回物理路径                               |
| Worker 项目/角色继承   | Worker 继承 Lead 的 Meka 项目、角色和冻结能力                                    | 严重缺失：Worker 只继承 cwd，未继承 `workspaceKind`、项目和角色 | 按 Cindy 已移除 snapshot 的现状，继承项目/角色绑定并重新解析同一直接运行时配置 |
| Worker 目录展示        | Meka Worker 列表显示 P4 根、子目录或远程实例标签                                 | 缺失：Worker view model 未带 cwd/remoteHostId                   | 恢复字段和标签；普通 Cindy Worker 不显示 Meka 目录标签                         |
| Worker→Lead 桥接       | 远程 Claude Worker 注入 `orca_worker_bridge`，结果可回传 Lead                    | 需复核：本地 bridge 已有，MCPRouter transport 投影需核对        | 以 XDMaker `8d2354939` 和 Cindy 当前 transport 对照                            |
| Lead→Worker 调度与队列 | `send_to_worker`、busy queue、恢复、状态广播、错误可见                           | Cindy 上游实现已存在                                            | 不覆盖 Cindy 新实现，只做 Meka 回归                                            |
| 远程 Claude Worker     | 经 MCPRouter tunnel + cc-manager 运行                                            | 已有 tunnel 基础，需端到端复核 bridge/runtime config            | 补定向测试，保留 Main fail-closed                                              |
| 远程 Codex Worker      | Phase 4 经 cc-manager `codex-bridge`、bundle revision、thread routing 运行       | 已恢复；使用直接运行时 Skill 构造最小冻结 bundle                | 保留 gateway-key fail-closed；不为此恢复整套 S1 snapshot                       |
| 远程操作 Skill         | 先发现项目绑定实例，直接 `start_team`，再以 `remote_host_id` 建 Worker并核对回执 | 文案已在，但底层目标参数/回执缺失                               | 底层修复后同步文案和测试                                                       |
| 重启与 idle resume     | 重建 Lead/Worker 关系；Worker resume 保留目标目录和远程宿主                      | Cindy 通用 Orca 已有，Meka 身份继承需补                         | 增加 Meka Worker 持久化/恢复定向测试                                           |

#### 4.8.2 已确认的目标边界

- Meka 会话可选择已配置 P4 根目录或已识别的
  `saga2_design` / `saga2_json` / `saga2_unity` / `saga2_pm` 子目录作为本地
  Worker 目标。
- 可选择当前项目已绑定、可用且受支持的 MCPRouter 实例作为远程目标。
- 远程 MCPRouter Claude Worker 与 Codex Worker 都必须保持完整 transport 契约；
  Codex 使用独立 `codex-appserver` 隧道和 cc-manager 控制通道。
- Worker 创建继续复用 Cindy 标准 `VendorSegmentedSwitcher`；选择 MCPRouter 远程目标
  时 Claude Code 与 Codex 均可选择，不恢复旧的手写 Agent 按钮组。
- 普通 Cindy 会话不能使用 Meka 自定义目标。
- 不信任 renderer 提供的任意本地目录或远程实例 ID；Main 重新解析并校验。
- Worker 创建、session request 和 agent input projection 透传 Main 解析后的目标。
- Cindy 已移除 capability snapshot，因此不能照搬旧快照字段；Worker 必须继承 Lead 的
  `workspaceKind`、`mekaProjectId`、`mekaRoleId`，并从同一项目/角色配置重新生成直接运行时。
- 远程 Worker 不向模型暴露服务端物理路径，只返回经过验证的 `remote_host_id`。

关键实现：

- `apps/desktop/src/main/maker-ipc/mekaWorkerTarget.ts`
- `apps/desktop/src/main/maker-ipc/orcaWorkerCreationService.ts`
- `apps/desktop/src/main/maker-ipc/orcaLifecycleService.ts`
- `apps/desktop/src/main/maker-ipc/sessionCreateHandler.ts`
- `apps/desktop/src/main/maker-ipc/sessionRequest.ts`
- `apps/desktop/src/renderer/features/cc-agent/lib/collaborationEligibility.ts`
- `apps/desktop/src/renderer/features/cc-agent/CreateWorkerPopover.tsx`
- `apps/desktop/src/renderer/features/cc-agent/OrcaWorkerPanel.tsx`
- `apps/desktop/src/renderer/features/cc-agent/hooks/useWorkerDirectoryLabel.ts`
- `packages/lizi-mcps/src/xdt-helper/create_worker.ts`

#### 4.8.3 本轮实际落地结果（2026-07-27）

以下项目已按 XDMaker `meka/main` 的功能文档和对应提交逐项复核，不再只把 Orca
理解成一个目录选择器：

1. **协同入口恢复**
   - 已有 Meka Lead 会话重新显示 Cindy 原协同按钮。
   - Meka 新会话草稿可开启协同；草稿阶段尚未分配 `workingDir` 不再导致按钮消失。
   - Worker、device-link、普通远程会话仍按 Cindy 既有资格规则排除。
2. **首个与后续 Worker 共用同一目标链**
   - `enableOrca` 的首个 Worker 与侧栏后续 `create_worker` 都透传
     `workingDir` / `remoteHostId`。
   - Renderer 只表达选择；Main 重新解析 P4 根、四个识别子目录及当前项目绑定的
     MCPRouter 实例，拒绝任意路径和伪造实例。
3. **Agent 主动创建能力恢复**
   - `create_worker` / `create_workers` 恢复 `working_dir`、`remote_host_id`。
   - 创建结果恢复结构化 `execution_target`；远程结果只返回
     `remote_host_id`，不返回远端物理目录。
4. **项目/角色直接运行时继承**
   - Worker 继承 `workspaceKind=meka`、`mekaProjectId`、`mekaRoleId`，并在
     session 行持久化。
   - Cindy 不恢复 XDMaker 已被本次迁移明确排除的 capability snapshot；Worker
     由相同项目/角色 manifest 重新解析 prompt、规则、Skill、MCP 和项目元数据。
   - Meka Lead 缺少完整项目或角色绑定时创建失败，不静默降级为空配置。
5. **Worker 目标展示**
   - Meka Worker 的列表、tab 与提示显示 P4 根/子目录名或
     “远程：实例名”；普通 Cindy Worker 不新增目录标签。
6. **远程 Claude 协同工具隧道**
   - Cindy 的 cc-manager 协议增加最小 MCP tunnel 版本（protocol v2，
     bundle `0.0.5`），没有带入 S1 的 bundle/revision/capability router。
   - 远端 daemon 为白名单服务建立 stdio `mcp-shim`，经 reverse request 回到
     desktop 的同一个 in-process MCP 实例。
   - 白名单与 XDMaker 最终状态一致：Worker 侧 `orca_worker_bridge`
     （`send_to_lead` / `read_lead` / `lead_status`）和远程 Lead 侧
     `lizi_orca`（建队、建 Worker、派活及诊断工具）。其他 desktop in-process
     MCP 继续被过滤。
   - 未声明服务名、非法名称、与普通 MCP 同名冲突均 fail closed。
7. **远程工作区约束**
   - Router 实例列表、创建回执和 Agent 回执不暴露远端 `workingDir`。
   - 远程 Worker prompt 明确禁止越出 cwd、探测或回传绝对路径，并要求报告使用
     相对路径；这属于 prompt 约束，不宣称为 OS 沙箱。
8. **消息、队列和失败恢复**
   - 保留 Cindy 当前 `OrcaLifecycleService`、`OrcaWorkerCreationService`、
     `OrcaTeamService` 与 dispatcher 的统一边界，不复制旧状态机。
   - Worker 回报可以越过 Lead 失败 turn 的 recovery 门派发，但不会清除用户仍需
     处理的错误横幅和 Retry 入口；普通用户消息仍遵循原 recovery 语义。
   - busy queue、accepted 后副作用、主动 `send_to_lead` 与 auto-bridge 去重、
     手动中断不 auto-bridge、idle resume 和重启关系重建继续复用 Cindy 现有实现。
9. **远程操作 Skill**
   - 与 XDMaker 最终文档一致：先发现项目绑定实例，必要时完成实例/模板/绑定链，
     直接 `start_team`，再以精确 `remote_host_id` 创建 Worker，并核对
     `execution_target`；禁止把 MCPRouter 实例误当 SSH 主机。

远程 Codex Worker 已按完整 transport 契约恢复，而不是单独放开 UI：Desktop 使用
`mode=codex-appserver` 隧道发送 spawn header，并通过独立 cc-manager 控制通道执行
`bundle/ensure`、revision register 和 thread register/unregister。远程侧只允许
gateway-key；本地 OAuth、`auth.json` 与 loopback proxy 不跨机器分发。

本次没有因此恢复 S1 snapshot 系统。Cindy 直接运行时已经解析出的项目/角色 Skill 会
被稳定排序并冻结为 `catalog.json + SKILL.md` 最小 bundle；revision 对完整文件集做
内容寻址。MCPRouter 服务端仓的 protocol 3 / bundle 0.0.6、capability MCP 与
`codex-bridge` 已独立验证，客户端仓只携带显式协商参数和 RPC 类型，不把本仓 SSH
Claude daemon 冒充成完整 MCPRouter 服务端。

### 4.9 Mobile 与 device-link

本次不迁移 XDMaker S3 主观改动，但需要让 Mobile 识别 Meka 会话这个既成 workspace：

- 对话/会话共享模型可识别 `workspaceKind = 'meka'`。
- 不建立 Meka 专属 device-link wire protocol。
- device-link 继续使用 `cindy://`。
- 不把 Desktop 的 `cindy-meka` OS 身份传播到移动端协议。

这属于最小兼容适配，不表示 S3 已迁移。

## 5. 数据库 migration 与旧数据兼容

### 5.1 为什么不能直接复用 XDMaker 的 migration 编号

Cindy 和 XDMaker 在共同历史之后分别继续增加 migration。XDMaker Meka 0.0.11 的
73–87 与 Cindy 当前 73–79 已经是不同文件和 hash。直接复制或重编号会产生两类风险：

- 旧 Meka DB 的 `migration_history` 与 Cindy migration 文件不匹配，启动被拒绝。
- 为了“跑起来”修改既有历史 migration，会破坏 Cindy 已发布数据库的不可变历史。

### 5.2 当前方案

Cindy Meka 尚未正式发布，因此本次上游同步允许重排本产品线尚未发布的临时编号，以
`origin/main` 的 canonical migration 为主；本地临时开发数据可以清理，但首发版本仍须
完整支持从 XDMaker Meka 0.0.11 迁移。

- `0080_regional_money.sql` 和 `0081_preserve_gateway_currency.sql` 完整保留上游编号、
  snapshot 和 companion script。
- `0082_meka_product_schema.sql` 是 no-op SQL，由 companion script 幂等补齐 Meka
  表、字段和索引。
- `0083`–`0087` 是 Meka lineage 保留槽，不重复执行旧 XDMaker migration。
- `0088_bridge_meka_0_0_11_lineage` 只在检测到**完全匹配**的 Meka 0.0.11
  migration 历史时运行：
  1. 验证所需表和字段确实存在。
  2. 对旧库补跑上游 `0080/0081` 的区域金额字段与币种保留语义。
  3. 补齐 Cindy 当前 schema 语义。
  4. 规范 Orca Worker label 和必要索引。
  5. 将 73–87 的 migration history 精确映射到 Cindy canonical 文件/hash。
- 未知、部分匹配或被修改过的 lineage 保持原样并拒绝猜测，避免静默损坏数据。

### 5.3 启动时遇到的问题

曾出现：

```text
Shared Cindy userData cannot run migration artifacts that are not canonical on origin/main.
```

原因不是 migration SQL 失败，而是开发启动器的共享数据保护策略：未进入
`origin/main` 的 migration 不允许直接作用于共享 userData。这项保护应保留。

处理：

- Cindy Meka 已使用独立的应用身份和 `%APPDATA%\CindyMeka` userData；开发启动与
  正式安装默认共享这份产品数据，与上游 Cindy 的开发启动语义一致。
- 只有在开发未合入 migration 时才显式传入命名 sandbox；启动器保留共享数据库
  migration 安全门禁，但不再自动切换 sandbox。
- 本私有产品线以 `meka/main` 作为 migration canonical 基线；`origin/main` 继续作为
  上游 Cindy 同步分支。`db:validate` 与共享开发启动保护均优先解析该产品分支；tag 等
  detached checkout 可回退到 `origin/meka/main`。没有 Meka 产品分支的上游 checkout
  仍使用 `origin/main`，单纯 fetch 上游不会改变 Meka 的冻结基线。
- 2026-07-30 复盘：migration freeze 自 Cindy 初始开源提交起只解析 `origin/main`；
  Meka 开发启动保护在 2026-07-27 已切到 `meka/main`，release 校验器当时漏同步。此前
  本地 `origin/main` 尚未包含上游 0082/0083，问题未显现；一次不含 merge 的
  `fetch --prune` 推进远端跟踪引用后才触发误报。修复仅统一 canonical baseline 解析，
  没有恢复、删除、重编号或改写任何 migration runtime identity。

注意：

- 显式隔离 sandbox 只用于未合入 migration 等高风险开发，不等于完成旧用户数据升级验收。
- 真正验收旧数据时，应使用备份副本或签名测试包，不应取消共享数据保护。
- 0080–0088 一旦发布，不得重编号、改内容、改 hash 或删除 companion script。

关键实现：

- `apps/desktop/drizzle/0080_regional_money.sql`
- `apps/desktop/drizzle/scripts/0080_regional_money.ts`
- `apps/desktop/drizzle/0081_preserve_gateway_currency.sql`
- `apps/desktop/drizzle/scripts/0081_preserve_gateway_currency.ts`
- `apps/desktop/drizzle/0082_meka_product_schema.sql`
- `apps/desktop/drizzle/scripts/0082_meka_product_schema.ts`
- `apps/desktop/drizzle/0083_meka_lineage_slot_83.sql` … `0087_*`
- `apps/desktop/drizzle/0088_bridge_meka_0_0_11_lineage.sql`
- `apps/desktop/drizzle/scripts/0088_bridge_meka_0_0_11_lineage.ts`
- `scripts/desktop-restart-runner.mjs`
- `scripts/dev-migration-policy.mjs`

## 6. 迁移过程中遇到的问题与处理

### 6.1 两个仓库已经独立演化

问题：XDMaker 与 Cindy 拆仓、改目录、改进程边界后，文件路径相似不等于职责相同。

处理：以 Cindy 当前代码和规则为宿主，按行为重新接线，不使用整分支 merge 结果作为
最终 diff。

### 6.2 直接合并会恢复已迁出的服务器

问题：XDMaker 的旧单仓内容包含 Cindy 已移出的服务端和旧协议实现。

处理：服务端完全排除；只在 Desktop/Mobile/shared packages 内做最小客户端接线；
协议继续依赖 Cindy 当前协议边界。

### 6.3 历史提交包含大量非 Meka 改动

问题：`xdmaker/meka/main` 相对其共同基线包含大量通用功能、修复、合并提交和基础设施
变化，无法把“分支 diff”直接当成 Meka 主观修改。

处理：建立模块白名单；未在用户确认模块中的文件不因来源分支存在差异而自动迁入。

### 6.4 原 Meka 用户数据与 Cindy 身份冲突

问题：如果沿用 Cindy appId/userData，安装会和原 Cindy 冲突；如果全换新身份，又无法
认领原 Meka 数据和更新链。

处理：显示与互操作仍遵循 Cindy，OS 安装身份和 userData 认领原 Meka。

### 6.5 device-link scheme 与应用唯一化被混在一起

问题：应用安装身份独立并不要求跨端协议也分叉。

处理：拆成两组常量：Desktop identity 生成 `cindy-meka://` 并兼容
`xdmaker-meka://`，跨端 interop 固定 `cindy://`。

### 6.6 migration 编号与共享数据保护冲突

问题：旧 Meka lineage、Cindy canonical history 和开发启动保护同时存在。

处理：上游编号优先 + no-op 槽 + 精确 lineage bridge；未 canonical migration 显式使用
隔离 sandbox，不放宽共享数据保护。

### 6.7 初迁 UI 与 Cindy 当前视觉不一致

问题：项目/角色页沿用了工程设置页式布局，侧栏缺少新建入口，正式/普通分组还被
“有会话才显示”的条件隐藏。

处理：恢复旧 Meka 的产品语义，同时使用 Cindy 当前 Plugin detail 视觉骨架重写呈现。

### 6.9 管理页曾一次性暴露全部配置

问题：进入 Meka 页签即默认选中首个项目，并把项目、全部角色、远程 MCPR、项目知识和
正式流程表单全部摊开。信息层级过深，也与 Cindy 插件卡片列表、Skill 详情的渐进式浏览
方式不一致。

处理：入口改为项目卡片库；点击项目后进入详情。项目详情顶栏展示项目名称，左栏只保留
“项目信息”和角色列表，右栏按当前选择显示单一配置上下文。布局骨架直接对齐 Cindy
Plugin list 与 Skill detail，XDMaker 只提供字段和流程语义。项目库顶部不再重复显示
“Meka”标题，只保留项目列表标题和新建项目操作。

### 6.8 会话创建流程曾被误接到管理页

问题：初次接线让普通/正式会话先进入项目角色管理页，并从管理页直接创建 session，
偏离 `xdmaker/meka/main` 的真实流程，也绕开 Cindy 统一草稿页。

处理：重新逐段核对来源分支。普通会话改回统一草稿；正式流程改回“选择事项 → Main
冻结快照 → 统一草稿”；管理页移除创建旁路。右上角原项目选择器增补 Meka 项目数据源，
角色选择紧邻进入同一控件区，同时保留 Cindy 草稿页原有分支/worktree、快速开始和
底部工具栏。

### 6.10 项目/角色配置初迁曾过度简化

问题：初迁把 SAGA2 项目整体设成只读、把角色 Skill 退化为手填 ID，同时项目保存先改
数据库再写配置文件；这些都与 XDMaker 的实际配置语义不一致。GitLab Remote 读取、
Jira Key 剪贴板识别和本地 Worker 子目录选择也在简化过程中遗漏。

处理：重新以 `xdmaker/meka/main` 的项目/角色编辑器、配置边界和 Worker 选择器逐项核对。
恢复有效值/草稿/取消/完整保存机制、内置技能目录、SAGA2 项目覆盖层、Jira/Git 辅助入口
和 P4 子目录 Worker 目标。内置资源继续作为只读基线，用户改动只落在配置的 P4 项目根。

### 6.11 项目配置输入框出现“未编辑也高亮”

问题：迁入页面混用了普通输入 token、focus ring 和设置页输入 token，导致静止文本框也
看起来像选中或错误状态。

处理：项目与角色页面所有 input/textarea/select 统一到 Cindy Settings 输入 token，
移除常驻 ring，只在实际 focus 时切换边框。该约束作为后续 Meka UI 迁移规则：优先复用
Cindy 已存在布局、组件与状态样式，XDMaker 只作为产品字段和流程语义来源。

### 6.12 MCPRouter 设置曾把工具误当成客户端

问题：初迁直接逐条渲染 `/api/routes`，页面显示的是具体工具名和 endpoint；这既偏离
`xdmaker/meka/main` 的客户端级管理语义，也遗漏了原设置页的远程模板、实例与可用状态
概览。MekaDesign 断开和 MCPRouter 断开还缺少原流程的影响确认。

处理：保留 Main 侧工具列表供运行时调用和项目权限过滤，Renderer 只把静态路由按
endpoint 聚合成客户端；客户端开关一次更新其全部路由，系统内置/Worker 工具作为只读
客户端显示，不再展示具体工具名称。恢复远程模板及实例只读概览，并恢复 MCPRouter /
MekaDesign 断开确认、连接状态、账号和刷新交互。实例创建、绑定仍只在项目详情中操作，
避免全局设置改变项目配置。

追加发现：原 XDMaker 和 MCPRouter 的 `/api/routes/discover` 都只传/收
`endpoint + protocol`，静态路由模型没有客户端名称、描述字段；设置页即使按 endpoint
正确聚合，也只能本地猜测显示名，Router 管理端看到的元数据仍为空。现已同步修改外部
MCPRouter：新增向后兼容的 `client_name/client_description` 可空列，discover 和普通
route API 支持 `clientName/clientDescription`，已有 endpoint 重复 discover 时也更新
旧路由。旧版 Cindy 配置 MekaDesign 时曾固定注册名称 `MekaDesign` 和描述
`MekaDesign 设计平台 MCP 工具`。元数据同时贯穿静态路由启动加载、运行时 RoutingTable、
`/api/workers` 客户端列表和 Router Web 管理页；名称只用于展示，不替换 endpoint 分组键，
避免改变批量暂停、重试和删除语义。当前 Cindy 不再主动 discover MekaDesign，但设置页
仍优先使用 Router 返回的真实元数据识别历史路由并提供地址同步候选。

### 6.13 MekaDesign discover 曾误删 endpoint 授权参数

问题：Cindy 初迁把 MCPRouter 基地址和 MekaDesign MCP endpoint 共用同一个 URL
归一化函数。Router 基地址需要删除 query，但 MekaDesign 链接通常把访问凭证放在
`?key=mcp_XXX`；归一化后 Router 收到的是无 key endpoint，MCP `initialize` 因此返回
HTTP 401，并由 discover 包装为 502。

处理：拆分两套 URL 规则。MCPRouter 基地址继续移除 query/hash；MCP endpoint 只允许
无 URL 用户名/密码的 HTTP(S)，保留完整 pathname 和 query，仅删除不会发送到服务端的
fragment。当前 MekaDesign endpoint 用于独立保存和直接运行时连接；Router 历史路由同步
也按完整 endpoint 比较，不能因丢失 query 而误判成另一地址。

### 6.14 内置 Meka 资源分散导致安装包漏带 Skill

问题：内置项目、角色和 Skill 曾分别位于 `resources/meka-projects`、
`resources/meka-roles`、`resources/meka-skills`。运行时代码和 Forge 打包清单各自拼接
这些目录；项目与角色进入安装包后，新增 Skill 目录没有同步加入 `extraResource`，导致
安装版能读到 SAGA2 默认 Skill ID，却在首次创建会话时报告
`unknown bundled Meka skill`。

处理：所有只读内置内容统一到 `resources/meka/`，下分 `projects/`、`roles/`、
`skills/`；正式包固定读取 `process.resourcesPath/meka`，开发态读取
`<appPath>/resources/meka`，两者由唯一的 Main 路径模块解析。Forge 只复制整个
`resources/meka` 根；打包前只确认源码资源树可读且非空，打包后递归比较源码树与包内树
的相对文件清单和 SHA-256，避免遗漏、夹带或内容不一致。项目、角色与 Skill 的产品语义
继续由运行时及其集成测试验证，不在 Forge 中重复定义。用户自定义角色继续保存在
userData 的 `meka-roles/`，不迁移、不改写。现有热更新 ZIP 包含完整 packaged 目录，
更新器也会递归覆盖全部新文件，因此
`resources/meka` 会随热更新落地；旧版三个分散目录可能作为未删除的孤儿保留，但新运行时
不再读取它们。本轮不修改更新器或更新服务。

### 6.15 2026-07-27 本地同步 `origin/main`

本地从 `meka/main@33348870c` 合并 `origin/main@24604ae4b`。本节记录冲突裁决的事实，
并随本次本地 merge commit 一并提交；当前结果未推送。

1. **migration 与首发兼容**
   - Cindy Meka 尚未正式发布，本地临时数据库不作为编号冻结依据；上游
     `0080_regional_money`、`0081_preserve_gateway_currency` 保持原编号。
   - Meka schema 顺延到 `0082`，`0083`–`0087` 作为 lineage 槽，
     `0088_bridge_meka_0_0_11_lineage` 负责 XDMaker Meka 0.0.11 精确桥接。
   - bridge 会先补齐上游区域金额语义，再补当前 schema 并 canonicalize 历史；未知或
     部分匹配 lineage 不做猜测。
2. **上游默认值**
   - Desktop 默认区域跟随上游为 `global`。
   - `apps/desktop/package.json` 版本跟随上游占位值 `0.0.0`；Meka 的独立
     productName、appId、userData、更新渠道和旧数据迁移锚保持不变。
3. **协同策略**
   - 普通 Cindy 项目继续受上游“项目协同策略”开关控制。
   - `workspaceKind=meka` 保持既有协同入口与 Main 侧创建能力，不经过该开关。
4. **Worker Agent 选择**
   - UI 同步上游标准 Agent/模型选择组件和 provider/effort/Fast 行为。
   - MCPRouter 目标允许选择 Codex；Main 强制 AI Gateway key 与 `xd` gateway
     provider 路由，其他 provider/OAuth 路由 fail closed。
   - transport 包含 `codex-bridge` spawn header、capability bundle/revision、
     thread routing 和 MCPRouter app-server 字节隧道全链。
5. **深链协议**
   - 本机 Desktop 对话链接使用 `cindy-meka://`。
   - 带 `deviceId` 的跨设备链接使用 `cindy://`；Meka 只解析该互操作 scheme，不向
     OS 注册并抢占普通 Cindy 的协议所有权。
6. **机械合并**
   - 侧栏保留 Meka 独立分组，同时接入上游项目置顶、加载态和键盘操作。
   - 数据映射、preload/IPC 类型、Orca 生命周期、移动端引用测试及四语言新增键均取
     两侧并集；Meka 中文 UI 文案同步上游术语表，将产品 Session 统一为“对话”。

本轮验证结果：migration 结构校验与完整 replay 通过；完整 `pnpm test:unit` 通过；
受影响且提供 `typecheck` script 的 package（Desktop、Mobile 及三个 bridge package）
typecheck 通过；旧 Meka lineage、区域身份、深链、协同策略、Orca Worker
创建/生命周期和 Worker 选择器相关测试通过；术语门禁通过。打包 smoke 与真实环境验收
尚未执行。

### 6.16 MekaDesign 与 MCPRouter 曾形成两个运行时入口

问题：MekaDesign 独立配置后，启用了项目默认 `mcp-router` 的角色会同时得到
`meka_design` 直连工具和 Router 中聚合的 MekaDesign 工具。地址不一致时，即使设置页
选择“保留当前地址”，模型仍可能经 Router 调用另一个地址，实际入口不确定。

处理：把 OS 加密存储中的 MekaDesign endpoint 定义为代理会话唯一入口。设置页的冲突
确认只决定是否用 Router 候选替换该 endpoint；`mcp_router` 的项目工具列表过滤所有已识别
MekaDesign 路由，`call_tool` 也在 Main 边界拒绝同名旁路调用。内置
`meka-design-handbook` 同步要求只使用 Host 提供的 `meka_design` 工具。Codex 通过
thread-context gated 的本地动态代理投影这条唯一入口，Claude 继续直连 HTTP endpoint。
冲突确认只携带不可逆 ID，确认替换由 Main 重新读取候选，避免为本功能新增 Router
候选 endpoint 下放。

### 6.17 2026-07-30 本地同步 `origin/main`

本地从 `meka/main@9ddf4d662` 合并 `origin/main@e4b464a2e`。本节记录本轮冲突处理后的
有效行为；冲突解析与提交前门禁已经完成，本轮只创建本地 merge commit，不推送。

1. **产品身份与能力边界**
   - Desktop 继续从 `BRAND_IDENTITY` 读取 Cindy Meka 的 productName、描述与安装身份，
     不接受上游普通 Cindy 的字面量覆盖。
   - 上游新增的微信 IM、provider 刷新、设备项目选择和插件市场恢复能力按当前架构合入；
     Meka 市场 surface、开发插件面板、项目/角色绑定和正式流程保持独立语义。
2. **migration 编号碰撞**
   - `meka/main` 已发布并冻结的 `0082`–`0088` 历史不改写；上游同号的微信与群消息表
     migration 不直接进入 Meka lineage。
   - 使用 Drizzle custom migration 从最新 Meka snapshot 生成
     `0089_upstream_wechat_and_group_messages`；生成器负责 snapshot 与 journal，SQL 只承载
     上游两条 migration 的等价 DDL，避免重复执行既有 Meka schema。
3. **新建草稿与协同**
   - 普通 Cindy 草稿接入上游 device scope、远程项目浏览、发送中互斥和协同策略刷新；
     `workspaceKind=meka` 继续要求项目与角色，保留正式目标创建，不展示普通 Cindy 的
     DeviceSwitcher。
   - 上游统一的目标解析器成为工作目录与 `remoteHostId` 的事实来源；普通远程 Lead 的
     Worker 继承 SSH host，Meka Worker 继续使用显式 P4/MCPRouter 目标。
4. **插件与远程运行时**
   - 插件页保留 Meka surface、开发态安装和打开面板动作，同时接入上游 locale、
     foreground refresh、同版本更新识别与图标失效恢复。
   - Claude/Codex 远程查询同时保留 Meka 的进程内 MCP/MCPRouter 投影，并接入上游
     provider options、Maker Memory、fresh query 与远程 host 生命周期。
5. **协议子模块**
   - 父仓指针前进到 `cindy-protocol@2520a40`；该提交是 `8303c39` 的后代。
   - 上游父仓提交 `c098d544f` 已记录配套 server 同步到同一指针；最新一步只补
     `turn.reopen` 契约文档，不改变 wire shape 或导出 API，因此不存在单端协议漂移。
6. **冷启动 owner boundary**
   - 合并后的首次 CN remote 启动暴露出 device-link busy timer 仍直接读取动态 Maker
     facade；冷启动 refresh 更换 data owner 时，facade 按新隔离契约抛出的
     `PRECONDITION_FAILED` 逃逸为 `uncaughtException`，导致主进程在窗口 ready 前退出。
   - 对照 merge 两边父提交确认：上述 busy probe 与动态 facade 的组合在合并前的 Meka
     与上游父提交都已存在，owner-boundary fail-closed facade 也已同时存在；因此这是
     原有竞态在合并后首次冷启动时被时序触发，不是冲突解析时误选一侧。
   - busy probe 现以 `null` 表达 owner boundary 期间暂不可读：轮询跳过本拍且不改
     dedupe 基线，握手沿用最后稳定值；Renderer IPC 仍继续收到可重试的
     `PRECONDITION_FAILED`，没有放宽 owner 隔离。

本轮自动化验证结果：

- `pnpm test:unit` 通过，包括根级 runner、Desktop、Mobile、maker-core 及其余 unit
  workspace；Windows `%TEMP%` 位于用户目录所导致的 subagent fixture 污染，以及超大
  64-bit inode 使测试中的 `ino + 1` 失去差异，均仅在测试隔离/断言层修正，未改变生产
  扫描和 netlog 校验语义。
- `pnpm -r --if-present run typecheck` 通过。
- `pnpm --filter desktop db:validate` 与
  `pnpm --filter desktop test:migration-replay` 通过，确认冻结的 `0082`–`0088` 未被
  改写，`0089` 可从当前 Meka lineage 顺序回放。
- `pnpm test:runner` 通过；协议子模块指针祖先关系与最终无 wire/API 漂移已人工核对。
- owner-boundary 回归修复补跑
  `pnpm --filter desktop exec vitest run src/main/__tests__/busyReporter.test.ts --pool=threads --maxWorkers=1`
  （7/7）与 Desktop typecheck；随后以
  `pnpm restart:desktop:remote --region=cn` 重现相同 CN remote 冷启动路径，主进程完成
  owner 切换、`0089` migration、主窗口 ready 与 device-link 上线，未再出现
  `uncaughtException` / `DEV_PROCESS_EXITED`。

真实账号、MCPRouter、远程设备和双主题 UI 仍需后续手测。

## 7. 当前未解决问题与风险

### 7.1 功能未迁移

- S1 通用能力包仍未迁移；这不影响项目/角色配置的 prompt、规则、Skill、项目元数据和
  MCP 直接生效。未迁移的是独立 capability pack 的注册、激活、恢复、快照、检查器及
  插件化 UI。
- 如果未来某个 Meka 角色依赖项目/角色配置之外的 capability pack hook/tool，必须按
  具体需求逐个迁移，不能把整个 S1 目录无审查复制进来。
- 远程 Codex Worker 已恢复，但当前只支持 MCPRouter + AI Gateway key；OAuth、
  provider OAuth、自定义 provider 与 SSH Codex 不在本次扩展范围。能力交付只冻结
  Cindy 直接项目/角色运行时的 Skill，不等同于恢复 S1 通用 capability snapshot。
- 内联 MCP 中带 `{{secret:name}}` 的环境变量目前会因没有对应的 Meka secret 解析器而
  阻断会话启动，避免把占位符或明文当凭证下发。内置角色使用 Host provider 引用；
  `mcp-router` 读取 Router 加密凭证，`meka-design` 读取独立加密 endpoint，均不经过
  内联环境变量。自定义内联 MCP 的凭证配置仍需后续补齐正式密钥入口。

### 7.2 尚未真实环境验收

- 旧 Meka 安装包热更升级。
- 真实旧 userData/DB 原地升级。
- 原 Windows 签名服务。
- 原 macOS 证书私钥、自签名和钥匙串行为。
- 真实 MCPRouter、Jira、GitLab、P4 网络和权限环境。
- Remote Orca Worker 的完整运行。
- MCPRouter 服务端需要以本仓 cc-manager protocol v2 / bundle `0.0.5` 重新构建并部署
  托管 bundle 后，才能真实验收远程 `orca_worker_bridge` / `lizi_orca` 隧道；本轮没有
  发布服务端。
- MCPRouter 客户端名称/描述需要部署
  `C:\Workspace\ttdbl3\agentic-os\mcp-router` 本轮 schema/API/Web 变更后才会持久化；
  服务启动时会给旧数据库自动增加两个可空列。当前 Cindy 不再向 Router discover
  MekaDesign；已有命名路由可直接作为地址候选，旧版无名称路由只在唯一 endpoint
  符合历史 `?key=mcp_...` 形状时兼容识别。
- 正式流程选择器当前复用 Cindy Main 侧内置 Ghost 的 Jira/GitLab 授权；未连接时会提示
  先完成对应 Ghost 配置再重试。XDMaker 原选择器内嵌连接入口没有迁入，是否需要补回
  应由真实账号手测后决定。

### 7.3 UI 待手测

- 普通 Meka 新建是否直接进入统一草稿，且预选项目正确。
- 右上角原项目选择器是否能统一切换普通对话、Cindy 项目和 Meka 项目普通会话，且不
  暴露正式流程；角色是否位于项目左侧，搜索框、列表滚动、选中态和空结果是否与
  Cindy 模型选择弹层一致。
- Cindy 原有顶部模式/分支/worktree、快速开始、底部工具栏是否保持原布局和行为。
- 正式流程事项选择、首条消息预填、项目锁定、角色切换和退出正式流程是否正确。
- 正式流程/普通会话分组是否覆盖用户现有会话。
- 会话顶部角色名是否正确，点击后是否直接打开该项目下的对应角色配置。
- 空项目、删除项目、旧版无绑定会话的侧栏表现。
- 项目/角色详情页的 Light/Dark、窄窗口和大量项目/角色场景。
- Meka 页签首次进入是否只显示项目卡片；进入项目、返回项目库以及项目信息/角色切换时，
  是否没有旧表单闪现或状态串位。
- 当前新建项目/新建角色/创建 Router 实例仍沿用简化输入流程，交互是否需要进一步
  改为 Cindy 标准 Dialog，应以手测反馈决定，不在本轮提前扩展。
- SAGA2 项目覆盖层写在已配置 P4 根目录的 `.meka/project.json`；首次保存和元数据重新
  发现会改动该项目文件。手测前应确认 P4 根目录正确，必要时先备份已有覆盖文件。

### 7.4 当前工作树状态

- 本次迁移尚未提交，工作树包含大量已确认迁移文件和 migration 文件。
- 在进入最终提交前，不应把 `git status` 中所有差异机械视为同一模块。
- 应按本文模块分批 review，特别警惕来源分支带入的通用能力包、服务端和 S3 改动。

## 8. 手测建议

本轮完整代码门禁已经执行；以下真实环境与 UI 手测仍待开发者完成。

### 8.1 启动和数据

1. 使用默认隔离 sandbox 启动开发版。
2. 确认 userData 与原 Cindy 独立。
3. 不要用未 canonical 的 migration 直接写共享生产 userData。
4. 准备旧数据验收时，先完整备份原 Meka userData。

### 8.2 Meka 设置

1. 配置 P4 根目录，确认四类 SAGA2 子目录发现正确；对已经保存过的根目录，确认
   无需重新选择即可补充出现 `saga2_pm`。
2. 重启后确认配置保留。
3. 打开 MCPRouter 登录窗口，确认默认地址已预填；登录/断开后确认凭证不显示在
   renderer 日志。
4. 未连接 MCPRouter 时，用包含 `?key=...` 的 MekaDesign 链接独立配置；确认完整 query
   被保留，新建启用 `meka-design` 的代理会话后只出现 `meka_design` 设计工具。
5. 登录包含 MekaDesign 历史路由的 MCPRouter：本地未配置时确认自动同步 endpoint；
   本地地址不同时确认弹出“替换/保留”，选择保留不改本地地址，选择替换后唯一入口改为
   Router 候选地址。
6. 连接后确认“客户端”列表按 endpoint 每个客户端只显示一行，不出现具体工具名称；
   MekaDesign 显示真实名称和描述；切换一个客户端时，其下全部静态路由同步启停，
   系统内置/Worker 客户端不可切换。
7. 确认远程模板按模板分组显示实例数量、实例 ID 和可用状态；未关联模板的实例进入
   独立分组，设置页不提供创建或绑定操作。
8. 同时配置 MekaDesign 和 MCPRouter 后，在启用两者的 Meka 角色会话中确认 Router
   `list_tools` 不返回 MekaDesign 工具，直接要求 Router 调用同类工具也会被拒绝。
9. 断开 MCPRouter 后确认 MekaDesign 仍保持连接；主动断开 MekaDesign 后刷新设置，
   确认不会被 Router 中仍存在的历史路由立即恢复。
10. 分别创建 Claude 与 Codex Meka 会话，确认两者都能通过唯一 `meka_design` 入口列出
    工具；普通 Codex 会话以及未选择 `meka-design` 的 Meka 角色不能列出或调用这些工具。
11. 检查冲突确认 IPC 回执：不应包含 Router 候选的完整 URL 或 `?key=`；确认替换后由
    Main 重新读取候选并更新唯一入口。

### 8.3 项目、角色和会话

1. 侧栏 Meka 标题右侧能看到新建入口。
2. 项目行右侧能按项目新建。
3. 普通会话入口直接打开 Cindy 统一草稿页并选中预期项目。
4. 草稿页右上角原项目选择器可切换普通对话、Cindy 项目和 Meka 项目普通会话，但不
   出现正式流程入口；Meka 草稿中可切换相邻角色后发送首条消息。
5. 新会话显示在对应项目下。
6. 正式流程项目始终显示“正式流程/普通会话”两组，即使某组为空。
7. 旧 `is_formal` 会话在“正式流程”，普通和无标记会话在“普通会话”。
8. 关闭正式流程后会话保持可见，不因分组消失。
9. 复制一个内置角色，分别修改角色提示词、启用规则、Skill、项目元数据选择和 MCP，
   用该角色新建会话；确认 Agent 行为能体现提示词/规则，且对应 Skill 可被 Claude/Codex
   发现，不能只验证表单保存成功。
10. 修改项目 `roleDefaults` 后，用启用了“使用项目默认项”的角色新建会话；确认项目默认
    prompt、Skill、MCP 和项目元数据生效，角色同 id 覆盖与 `excludeDefaults` 排除正确。
11. 清空 P4 根目录后创建 SAGA2 会话必须明确报错；恢复配置后，新会话的工作目录必须是
    实际 P4 根目录，不能是字面量 `saga2`，且 P4 根目录中不能出现 Meka 生成的
    `.claude/skills` 或 `.agents/skills`。
12. 临时缺少一条已选择元数据时，会话应记录跳过警告但仍可启动；把角色改成未知内置
    Skill 或错配到别的项目时，会话必须明确报错，不能静默以空配置运行。
13. 编辑 SAGA2 的正式流程、学科/领域或元数据后保存并重启；确认
    `<P4 根>/.meka/project.json` 保存了完整草稿，应用资源未变化，运行时使用保存后的
    配置。
14. 清空 P4 配置后从 SAGA2 草稿发送或创建目标，确认出现跳转设置提示；取消时不发送，
    确认跳转后进入 Meka 助理设置。

### 8.4 正式流程

1. Jira Key/GitLab URL 保存后重启仍存在。
2. 从“正式流程”入口先出现事项选择器，不直接创建空 session。
3. 非本项目 Issue 链接被拒绝。
4. 正确链接冻结后进入统一草稿，项目不可切换、角色仍可切换。
5. 草稿预填正式流程首条消息并显示 Issue ref。
6. 关闭 Issue ref 后回到同项目普通草稿。
7. 发送后会话归入“正式流程”分组。

### 8.5 远程和 Orca

1. 列出 Router 实例和模板。
2. 创建实例并绑定到当前项目。
3. 不可用/不支持实例不可选择。
4. Meka Orca Worker 可选 P4 根、四个已识别子目录或已绑定远程实例。
5. 普通 Cindy 会话不能伪造 Meka Worker 目标。
6. 已有 Meka 会话和 Meka 草稿均显示 Cindy 原协同按钮；开启草稿协同时首个 Worker
   使用草稿中选择的本地/远程目标。
7. 从侧栏新建本地 Worker，确认回执 `execution_target.type=local` 且目录只可能是
   P4 根或四个识别子目录；从 Agent 调 `create_worker` 也满足同一规则。
8. 新建远程 Worker，确认回执为 `type=remote` 和精确 `remote_host_id`，回执、Router
   工具结果及模型消息中都不出现远端物理绝对路径。
9. Meka Worker 重启/idle 后继续保留项目、角色、目标和 Lead 关系；项目/角色 prompt、
   Skill、MCP 与元数据仍按同一 manifest 生效。
10. 远程 Claude Worker 可调用 `send_to_lead`，远程 Claude Lead 可调用
    `start_team/create_worker/send_to_worker`；未在白名单的 desktop MCP 不应出现在远端。
11. 让 Lead turn 进入失败 Retry 状态后送达 Worker 报告；报告必须及时派发，同时原错误
    横幅和 Retry 入口不能被清除。
12. 远程 Worker 尝试要求 cwd 外路径时应被 prompt 约束拒绝；这项只验证 Agent 行为，
    不把它误记为 OS 沙箱验收。

### 8.6 UI

1. Light/Dark 各检查一次。
2. 首次打开 Meka 页签只显示项目卡片，不自动打开首个项目。
3. 点击项目后，顶栏展示项目名称；左栏为项目信息和角色列表；右栏只显示当前选择内容。
4. 检查返回项目库、切换项目信息/角色、长项目名、长路径和长角色名。
5. 检查窗口较窄时卡片网格、详情分栏、顶栏操作和正式流程输入。
6. 检查项目/角色保存、删除、新建、加载、错误提示和空状态。

## 9. 最终提交前门禁

本轮未提交改动已完成代码审查与本地自动化门禁；真实安装、升级和 UI 验收仍待完成。

最终至少需要：

1. review 全部迁移 diff，按本文模块确认归属。
2. `pnpm test:unit`
3. 对受影响 package 执行 `typecheck`。
4. `pnpm check:i18n`
5. migration validate/replay/lineage 专项测试。
6. release identity、签名配置和产物命名专项测试。
7. Windows 与 macOS 打包 smoke。
8. Light/Dark UI 验收。
9. 真实旧 Meka 数据副本升级测试。
10. 旧签名版本 → 新版本热更新测试。

本轮最终代码门禁结果：

- `pnpm test:unit` 通过：根级 315 项（308 通过、7 跳过）无失败，Desktop、Mobile 与
  所有 unit workspace 通过。
- `pnpm --filter desktop run --if-present typecheck`、`cindy-tools` build、
  `pnpm check:i18n` 和父仓 `git diff --check` 通过；协议 submodule 无修改。
- `pnpm check:i18n-glossary` 通过，术语表生成物与四语言文案无新增违规。
- 变更文件 ESLint 在排除 HEAD 已存在的 `SupportedLocale` 未使用与
  `throwInstallError`／`throwUninstallError` fallthrough 告警后通过；这些存量问题不是
  本次未提交 diff 引入，未擅自纳入。
- 当前功能尚未 commit，因此不能声称已有 DCO trailer。后续提交必须使用 `git commit -s`；
  当前 `pnpm check:dco` 仍报告本次未提交 diff 之前已有的 6 个 Meka 历史 commit 缺签，
  本轮未重写已发布历史；最终仍以真实提交范围与 PR 上 DCO App 为准。

本轮项目/角色直接运行时接线后的定向结果：

- Desktop TypeScript typecheck 通过。
- 项目/角色解析、默认项合并、项目工作目录、Skill 非污染投影、项目配置、MCPRouter
  client/service、会话映射与创建参数共 10 个测试文件、45 个测试通过。
- 最新项目/角色配置补漏后再次执行 Desktop typecheck 通过；项目覆盖层、运行时解析、
  内置 Skill 目录、P4 会话门禁、MCPRouter 默认地址、Worker 根/子目录目标及 Worker UI
  共 8 个测试文件、32 个测试通过。
- 内置资源统一到 `resources/meka` 后，Desktop typecheck 与定向 lint 通过；开发态/
  安装态根路径、Forge 清单、源码与包内资源树一致性、项目/角色解析和内置播种均有定向
  测试覆盖；侧栏 `workspacePrompt='meka'` 源码契约断言已经同步，当前根级
  `pnpm test:unit` 不再被该项阻断。
- Orca 补漏后 Desktop typecheck、`@cindy/maker-core` build、
  `@cindy/maker-cc-manager` build 通过。
- 协同资格、首个/后续 Worker 目标、Main 校验、项目/角色继承、MCP
  `execution_target`、Worker 目录 UI、远程 MCP tunnel、远程投影白名单、远程路径
  prompt 和 recovery 队列均已有定向测试通过；这些结果是实现阶段验证，不替代真实
  MCPRouter、重启恢复、Light/Dark 和最终全量门禁。

## 10. 后续继续迁移时的硬性注意事项

1. 不直接 merge `xdmaker/meka/main`。
2. 不以“文件有差异”为迁移理由，必须说明 Meka 产品意图。
3. 不恢复服务端代码。
4. 不复制旧协议实现覆盖 Cindy 当前协议/子仓库。
5. 不把 S1 能力包当成“插件目录复制”处理；它涉及 prompt、tool/MCP、权限、快照和恢复。
6. 不改已发布 migration；0080–0088 发布后视为冻结历史。
7. 不用开发版未 canonical migration 直接写共享 userData。
8. 不把 Desktop 安装身份和 device-link wire protocol 再次耦合。
9. 不把 Windows/macOS 证书、Token、密码或授权文件写入仓库。
10. 不因 UI 来自 Meka 就保留旧视觉；进入 Cindy 后必须遵循 `DESIGN.md` 和四语言要求。
11. 不因 Meka 新需求删除、移动或替换 Cindy 页面原有内容；优先在现有同语义布局中增量接入。
12. 新增 Meka IPC、文件落盘、凭证、远程工具或协议字段时，先核对对应 dev rules。
13. 每次手测反馈修复后同步更新本文的状态、风险和验收结果。

## 11. 维护方式

本文是本次严格迁移的事实正本。后续变更应在同一次代码调整中同步更新：

- 模块状态变化：更新第 3、4、7 节。
- 新的迁移事故或兼容处理：更新第 5、6 节。
- 手测完成：在第 7、8 节标记结果和剩余问题。
- S1 某一子模块获批迁移：明确列出子模块，不能把 S1 整体直接改成“已迁移”。
- 最终提交：记录 commit/PR、完整门禁结果和真实升级验证版本。
