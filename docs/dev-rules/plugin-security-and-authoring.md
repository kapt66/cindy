# 插件运行时安全与作者契约

> **状态**：权威开发规则（authoritative）
> **读取时机**：新增或修改插件（`.cindy`）的运行时、沙箱、权限、能力 slot、面板供片、
> 网络／凭证／文件交接，或插件作者可见的身份卡、管子协议、打包与编写手册之前

本文治理 Cindy 中运行的插件——以 `ghost.json` 为身份卡的 `.cindy` 包。它同时约束两件
互为一半的事：**运行时权限安全**（宿主如何隔离并授权插件）和**作者契约同步**（改了
作者可见的能力，必须同步编写手册与校验）。Electron 进程与协议安全另见
[`electron-security-and-process-boundaries.md`](electron-security-and-process-boundaries.md)，
媒体字节交接另见 [`media-storage-and-protocols.md`](media-storage-and-protocols.md)，插件在
产品中的定位见 [`../product-rules/core-product-principles.md`](../product-rules/core-product-principles.md)。

> **术语**：产品与对外措辞统一为「插件」，`.cindy` 即插件包；不再使用旧的概念称呼。
> 代码标识仍沿用历史 `Ghost` / `cindy-brain` 命名（目录 `cindy-brain/`、`GhostRuntime`、
> `ghost.json`、`cindy-ghost://`、`ghost_forge_guide` 等），与产品术语「插件」指同一事物；
> 引用代码时照实使用这些标识，不因措辞改写。

> **增量适用原则**：运行时沙箱与权限的安全不变量（下节 2–4）对**所有**触及相关路径的
> 改动都生效，不因是存量代码而豁免。作者契约同步（下节 5）在改动命中作者可见契约时
> 触发；不要求为统一形式专项重构无关存量。

## 事实来源

| 内容                                            | 权威来源                                                                                                         |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 编写手册（作者唯一教材，现拿现读）              | `apps/desktop/src/main/cindy-brain/forge.ts` 的 `FORGE_GUIDE`，经 `ghost_forge_guide` 工具下发                   |
| 身份卡字段与校验、管子协议类型                  | `apps/desktop/src/shared/ghost.ts`（`validateGhostManifest`、`cindy.send` / `cindy.onHostMessage` 类型）         |
| 打包限制                                        | `apps/desktop/src/main/cindy-brain/forge.ts` 的 `packGhostDir`                                                   |
| 运行时、沙箱进程与生命周期                      | `apps/desktop/src/main/cindy-brain/runtime/GhostRuntime.ts`、`GhostManager.ts`                                   |
| 能力 slot（网络／通知／文件系统／文件定位／技能／宿主等） | `apps/desktop/src/main/cindy-brain/networkSlot.ts`、`notifySlot.ts`、`fsSlot.ts`、`revealSlot.ts`、`cindySlot.ts`、`skillSlot.ts` |
| 面板供片、注入主题 token 与协议                 | `apps/desktop/src/renderer/cindy-brain/ghostPanelTheme.ts`、`cindy-ghost://` 分支                                |
| 权限注入／更新确认 UI                           | `apps/desktop/src/renderer/cindy-brain/GhostPermissionList.tsx`                                                  |
| 远程／手机版能力准入白名单                      | `packages/device-link/src/allowlist.ts`                                                                          |
| 行为与安全不变量                                | `apps/desktop/src/main/cindy-brain/__tests__/`、`forge.test.ts`                                                  |

文档与实现冲突时以代码为准，但必须在同一改动内同步修正本文与手册。

## 1. 插件形态与代码术语

- `.cindy` 是以 `ghost.json` 为身份卡的插件包，现行唯一形态为 `kind: 'chip'`。
- 代码目录与运行时使用 `cindy-brain` / `Ghost` 命名，**不得重新引入已退役的 cartridge
  声明型兼容层**。
- `cindy-` id 前缀保留给随包官方插件，第三方插件不得占用。

## 2. 运行时沙箱与进程隔离

- 每个运行中的插件使用独立 Electron 沙箱进程与专属 session partition。沙箱禁止直接访问
  Node、宿主文件系统和网络。
- 插件只允许读取自身安装目录内、经安全相对路径校验的静态资源，不得越权读取其它目录。
- 逻辑页只能经最小 `contextBridge` 管子申请主机能力；面板 webview 保持零特权桥。
- 主机按 `webContents` 绑定反查真实 ghostId，**不信任 sender 自报身份**。
- 沉睡、抽离和主机退出必须终止对应沙箱；沙箱崩溃只由 `GhostRuntime` 收敛，不得带崩
  主应用。

## 3. 权限即授权边界

- 所有能力必须先在 manifest 声明 slot，通过同一套校验，并在注入／更新确认框中逐项
  如实展示，再由 host 代码强制授权。**prompt 不构成安全边界**，前端展示与确认框文案
  也不构成授权。
- 新增或修改 slot 时，除同步编写手册与校验（下节 5）外，还必须同步 shared 类型、
  preload／host handler、权限 UI（`GhostPermissionList.tsx`）、错误边界和测试。
- `reveal` 槽只允许插件请求 Host 在系统文件管理器中定位一个已存在的本机普通文件或目录。
  请求中的绝对路径由 Host 重新 `realpath` / `stat` 校验；文件夹通过系统文件管理器打开其
  父目录并选中该文件夹。路径不存在、来自远程工作区或无法交给 OS 时 fail closed；结果不
  回传规范化路径，也不授予读写权限。
  这是独立的安装权限，不能通过 `fs` 槽或面板 Renderer 的 `window.electronAPI` 绕过。
- `pick` 槽支持 `mode: "file"` 与 `mode: "directory"`。两者都必须由用户在系统选择框
  中亲选后才返回；`file` 模式不支持 `deposit`，目录票据仍只适用于 `directory` 模式。
  绝对路径仅提供给声明 `node` 或 `reveal` 的插件，未声明两者的插件必须使用目录票据。
- `skill` 槽是唯一**越出沙箱**的能力：技能指令由主 Agent 以用户全部权限执行、全局
  生效、不随 workdir 级停用隐藏。其安全边界是**声明一致性**（manifest 里的
  name／description 必须与 SKILL.md frontmatter 逐字一致，`skillSlot.ts` 的
  `checkSkillMdConsistency` 是唯一裁判，打包与装入两侧共用）+ **链接对账**
  （`reconcileGhostSkillLinks` 只增删"目标落在 cindy-brain 安装根内的
  symlink／junction"，绝不触碰真实目录与外来链接；启用挂链、停用／卸载撤链、
  断链自愈）。改动技能落链、命名（`<id>--<name>`，name 侧禁 `--`）或对账判据前，
  必须先读 `skillSlot.ts` 头注释并保持上述不变量。

## 4. 网络、凭证与资源交接

- network 只允许 manifest 白名单域名；凭证由主机保险库注入，**无明文读回**给沙箱。
- 插件 setup 的完成状态只由 Host 读取真实持久化状态后判定。简单的
  `source: "user"` Secret 可由 Host 在聊天 Setup 卡中生成 `inline_form` 并直接写入
  保险库；插件详情页的 `settings.js` 仍可通过 `/oauth`、`/kv`、`/secrets`、
  `/connections` 完成正常保存。两条路径都不得自行向聊天卡回调“已完成”，Renderer
  也不得以轮询或 `BroadcastChannel` 事件替代 Host 判定。
- Agent 可编排 setup 卡片的说明与步骤，但只能引用 Host 下发的 requirement / action；
  插件身份、字段 schema、字段与存储目标的绑定、Action 执行、完成状态和原
  `ghost_call` 恢复均由 Host 掌控。Secret、Token、OAuth code 和连接凭证不得进入
  Agent、Ghost、interaction / pending snapshot、会话历史、日志或分析事件。内联 Secret
  只允许短暂存在于本地 Desktop 输入组件和一次性的 trusted Renderer → Main 专用 IPC；
  不得走通用 interaction response、device-link 或其它远程通道，也不得写入 Renderer
  store。提交成功、取消、request / revision 替换和组件卸载时必须清空。
- Host 必须把每个未满足 `any_of` 组的全部可执行 item 投影到卡片，Agent plan
  不能隐藏合法配置路径。Renderer 统一按组展示选项并复用 Ask 卡片的正文限高与纵向
  滚动，不得为 Brave、Tavily、Gmail 等具体插件增加分支。
- `network.secrets[].url` 可由 Host 作为 Setup 字段旁的辅助获取入口展示。该地址必须
  继续满足 manifest 安装期的 `https`、无内嵌凭证校验；它不是 Agent 文案或 plan
  的一部分，插件也不能通过 `settings.js` 动态替换 Setup 卡地址。
- 模型调用一律走 Cindy 统一通道，不允许插件自建绕过通道的推理请求。
- 插件声明 `cindy.image` / `cindy.video` 后，详情配置、override 校验、实际代办和付费
  派发前复查必须共用同一份运行时媒体目录。Cindy Meka 的目录按认证快照中的有效
  `edition` 投影 CN / Global 能力，不能按安装包构建区域投影；因此登录页切换服务区后，
  插件图像与视频能力须和普通供应商目录同步变化。用户停用供应商或媒体模型后，所有上述
  入口也必须同时失效，不能只隐藏详情页选项。
- 附件、媒体、目录和保存路径通过归属校验后的 grant／deposit／ledger 交接，**禁止把
  宿主绝对路径或不必要的字节暴露给沙箱**。媒体字节须走
  [`media-storage-and-protocols.md`](media-storage-and-protocols.md) 的统一入库。
- 面板供片与注入的主题 token 只用 `ghostPanelTheme.ts` 白名单内的值，不扩大暴露面。
- 已安装且声明 `panel` 的插件在列表卡片与详情页统一显示「打开界面」。默认仍按 manifest 的
  `panel.position` 使用既有停靠／页签宿主；Meka 助理设置可写入本机界面 override，把停靠
  面板改为覆盖主页面 90% 宽高的 Modal。Modal 必须复用 `GhostChipPanelBody`、原插件专属
  partition、`cindy-ghost://` 供片、主题注入、崩溃接管和媒体右键链路，不得另建放宽权限的
  WebView。Modal 模式只隐藏停靠面板与气泡，布局树、最小化位置和重装复活记忆保持不变；
  关闭 override 后原位恢复。Modal 内的面板 WebView 必须在 `dom-ready` 后接管键盘焦点，
  确保插件内的树、列表及快捷键能收到真实键盘输入；停靠与页签宿主不得在重载时主动抢焦点。
  用户关闭一个已经打开的 Modal 时，宿主只把 Modal 与遮罩切为不可见、不可交互，必须保留
  原沙箱 WebView 的挂载，使插件内选择、滚动、输入和在途请求继续存在；再次打开同一插件
  复用该实例。插件被停用／卸载、内容 revision 更新或所属页面真正卸载时仍按原生命周期
  销毁并重建。逻辑沙箱与 Node worker 本来独立于面板 WebView，Modal 显隐不得改变其后台
  生命周期。隐藏态内容更新不得抢走宿主焦点；重新显示时应把焦点交回已保活的 WebView，
  不要求用户先点击面板才能继续键盘操作。该设置不改变 `ghost.json` 作者契约。

### 4.1 Meka 开发目录模式

- “Meka 插件”页可由用户显式选择一个本地源码目录并登记为开发插件。目录绝对路径只写入
  当前 data owner 的 `cindy-brain/.meka-dev-plugins.json`，不写市场来源账本、不上传
  MCPRouter，也不进入插件 manifest；普通 Cindy“插件”页不提供该入口。
- 开发副本不得占用源码 manifest 的原始插件 ID。Host 为其派生不超过 32 字符的稳定
  `meka-dev-*` runtime ID，并在临时包内只改写 `id`；若源码声明 slash command，则同步
  派生带摘要的独立 DEV command。注册表同时保存 `pluginId` 与 `runtimeId`，Renderer 只用
  runtime ID 做运行时操作，展示仍使用原始 plugin ID。由此远端未安装卡、正式安装卡和
  开发卡可按原市场规则共存：开发副本既不把远端版本判成“已安装”，也不覆盖或隐藏正式版。
  开发卡片、快捷入口和详情图标必须显示使用语义颜色 token 的斜向 `DEV` 角标。
- 目录首次登记必须展示与正式安装相同的 manifest、信任等级和权限清单，并取得一次明确
  确认。确认必须绑定到已检查快照的稳定内容指纹（排序后的包内路径与逐文件内容），安装
  前重新打包不一致时以 `PRECONDITION_FAILED` 拒绝并要求用户重新选择；不得仅凭目录路径
  接受确认后的替换。确认还须绑定 data owner 与 session generation，换号或重新登录后不得
  复用旧确认。登记后即表示用户持续信任该目录的后续内容变更；不得把任意外部路径、磁盘
  根目录或同 ID 的正式安装静默转为开发来源。
- watcher 必须运行在既有隔离的 watcher utility process。源码变更经 debounce 后打包到
  OS 临时目录，再交给 `GhostManager.inspect` 与原子 install/update 链路；不得让沙箱直接
  从源码目录执行，也不得为开发模式绕过包大小、manifest、保留 ID、token broker 或权限
  校验。原始源码包须先完成签名／信任检查；Host 改写 runtime ID 与 command 后，原签名已
  不再对应派生包字节，必须移除该失效签名并把派生包按未签名开发快照再次完整检查，不得
  携带虚假的签名信任声明。Main 须静态引用无副作用的 watcher client singleton，真实
  Electron `before-quit` 释放由 Desktop bootstrap 统一接线；不得在 Ghost IPC 注册路径恢复
  运行时动态 import。临时 `.cindy` 必须在每次尝试后清理。
- 开发目录绑定期间插件 ID 固定；若 manifest 改 ID，自动更新 fail closed，用户须移除后
  重新登记。打包或更新失败只把开发条目标为错误，继续保留最后一次成功安装的快照。
- v1 开发注册表曾直接用原始插件 ID 安装快照；读取时须迁移到 v2 双 ID 记录。先成功安装
  独立 runtime 副本，再清理旧 ID 快照，避免迁移失败时先删除最后可用版本。
- 同版本内容更新成功后，逻辑沙箱／Node／Agent slot 按正常更新生命周期重启；已经可见的
  panel/settings WebView 通过专用 content revision 事件重建，确保 HTML/CSS/JS 变化即时
  生效。该事件只负责本机可见界面刷新，不进入 device-link 协议。
- 移除开发插件先停止监听和 debounce，排空该 runtime 已进入队列或正在执行的同步链，再
  走标准卸载与清理，确保卸载是最后一次安装态 mutation；若卸载失败，恢复监听并保留
  注册记录。切换 data owner 时同样必须排空旧 owner 同步并停止 watcher，再加载新 owner
  注册表。
- 开发插件卡片按 manifest 能力显示直接动作：只有声明 `panel` 才显示“打开界面”，只有
  声明 `command` 才显示“使用”；没有直接能力时回落到“详情”。开发卡另显示“打包”，
  打开 Host 托管的打包弹窗。弹窗始终允许把**原始源码身份**（不是 `meka-dev-*` 派生
  身份）打成 `.cindy` 保存到用户选择的位置；上传动作在所有状态下保持同一位置，只有完整
  MCPRouter 绑定存在时才启用。未绑定时弹窗提供“配置登录”，原位复用“设置 → Meka 助理”
  的既有 MCPRouter 配置弹窗；登录完成后不得关闭或跳离打包流程，而应立即启用上传供用户
  继续操作。弹窗展示源码 manifest 版本，并从 MCPRouter owner API 回填“仅自己／部分
  可见／公开”权限及部分可见用户名；发布或单独保存权限后通过 `/access` 将完整权限设置
  同步回后台。远端已存在该插件且源码版本不同时，发布前必须显示当前／目标版本并二次
  确认；版本相同时不得覆盖不可变 Release，只允许同步权限，并提示提升版本后再发布内容。
  owner API 返回空列表表示尚未发布，必须进入首次上传，不得显示读取失败；保存的 Router
  session 返回 401 时表示登录已失效，弹窗应保留本地打包并原位提供“配置登录”。
  上传使用 Main 内的 Router session cookie 经 HTTPS 调管理 API，包字节与凭证均不得进入
  Renderer。MCPRouter 已停用 HTTP 与裸 IP 入口，任何历史 HTTP 或裸 IP base 在运行期统一
  迁移到 `https://mcpr.meka.pawdy.fun/`，不得保留明文认证或证书主机名不匹配的例外。
  每次上传产生不可覆盖的 Release；未配置 Router 时不得尝试远端写操作。

### 4.2 Meka 独立市场的大包下载边界

- 上游 Cindy 插件市场继续使用 8 MiB 压缩包上限。Meka 的 MCPRouter 市场只在 Release
  manifest 已通过共享 `validateGhostManifest` 且声明 `node` 时，把压缩包下载上限提升到
  128 MiB；普通 Meka 插件仍为 8 MiB。该例外由 Meka 市场实例显式注入，不得改变共享服务
  的默认值，也不得依据插件 ID、名称或服务端自报渠道推断。
- 大包必须流式写入 `app.getPath('temp')` 下调用方生成的唯一临时路径，并在写入过程中同时
  执行 Release 声明大小、渠道上限与增量 SHA-256 校验；禁止为放宽上限而把完整包聚合到
  Main 进程内存。目标使用排他创建，Content-Length 不一致、流超限、字节数／摘要不一致、
  写盘或关闭失败都必须删除本次创建的未验证文件，且不得覆盖调用方路径上已有文件。
- Meka 大包策略只改变客户端接收合法包的上限，不改变 HTTPS-only、短期下载授权、Release
  不可变、manifest／签名／权限确认、原子安装和运行时沙箱边界，也不修改
  `@cindy/plugin-protocol` wire contract 或上游 Cindy 服务端。
- Meka Desktop 的显式安装／更新可通过独立的
  `meka-plugin-market:install-progress` push channel 展示阶段与字节进度。Renderer 为每次
  用户操作生成 UUID，Main 校验后只向发起该 IPC 的可信 WebContents 回传
  `operationId`、`pluginId`、`phase`、`downloadedBytes` 与 `totalBytes`；preload 必须剥离
  Electron event 并运行期校验 payload，Renderer 只接收当前 operation。不得回传签名 URL、
  临时路径、凭证或包内容，进度观察器失败也不得改变安装结果。该入口仅服务 Desktop 本地
  Meka 管理页；市场详情的安装／更新按钮、已安装插件详情与列表更新按钮必须复用同一
  operation 状态，不得为更新另开无隔离的旁路。该事件不加入 device-link invoke／push
  allowlist；Mobile 不提供插件市场安装管理。

### 4.3 插件级界面打开方式

- 停靠面板可在 `panel` 声明 `allowUserPresentationOverride: true`，由 Cindy 在插件详情
  「配置」区自动绘制“跟随默认／停靠在对话窗口／弹窗打开”三态设置。该字段只适用于
  `position: "left"`（或缺省 position）；`position: "tab"` 的页签语义由 manifest 固定，
  声明本字段必须拒装。
- 这是宿主托管的用户界面偏好，不是插件能力、权限或业务参数。插件脚本没有写接口，不得
  在 `settingsHtml` 里另画同名设置，也不得用 `/kv` 特殊键模拟。作者只负责声明是否展示；
  选择、持久化、恢复默认以及 detached／minimized 状态收敛均由宿主负责。
- 有效值优先级固定为“插件级用户 override → Meka 助理的插件默认打开方式 → 停靠产品
  默认”。插件级 `inherit` 通过删除 override 实现；只持久化显式 `docked`／`modal`，
  不能把默认值快照复制到每个插件。插件更新按 runtime plugin ID 保留选择。
- 全局默认和插件级 override 都是本机 Renderer 视图偏好，不改变布局树账本。布局可见性、
  最小化气泡和插件页“打开界面”必须调用同一个 effective resolver，避免同一插件在不同
  入口得到不同形态。插件目录的列表卡片、详情页及后续新增入口还必须复用同一个 launcher，
  不得各自维护 Modal／停靠分支。Modal 首次打开时先以关闭态稳定挂载目标宿主，再于下一
  animation frame 切换为打开，避免创建 Dialog 的同一次可信点击被当作 outside interaction
  立即关闭；切换目标或离开详情时必须取消尚未执行的打开请求。该偏好不进入插件沙箱、
  Main IPC 或 device-link 协议。

## 5. 作者契约与编写手册同步

`FORGE_GUIDE` 是 agent 替用户编写插件的**唯一教材**，由 `ghost_forge_guide` 现拿现读。
**手册过期 = AI 按旧规则写出过不了校验的插件包**（校验拒装只是兜底，用户体验是“AI
反复打包反复被拒”）。

凡改动**插件作者可见的契约**，同一改动内必须同步更新手册对应章节：

- (a) `ghost.json` 身份卡字段或校验规则（`shared/ghost.ts` 的 `validateGhostManifest`）；
- (b) 管子协议（`cindy.send` / `cindy.onHostMessage` 的消息形态，`shared/ghost.ts` 管子类型）；
- (c) 模型能力 slot 的 kind／参数／模型白名单；
- (d) 面板供片协议与注入的主题 token（`cindy-ghost://` 分支、`ghostPanelTheme.ts` 白名单）；
- (e) 打包限制（`forge.ts` 的 `packGhostDir`）。

`ghost_forge_pack` 的可选 `channel: 'meka'` 是 Host 创建入口下发的一次性安装归属，
不是插件能力、权限或身份卡字段。只有明确来自 Meka 创建任务的调用可携带它，且只在
用户确认安装或更新成功后写入 Meka 独立账本；不得写入 `ghost.json`，普通 Forge、
拖入和双击安装也不得自行推断 Meka 归属。

反向同样成立：改校验必须同步手册；改手册宣称的新能力必须真有实现。`forge.test.ts` 的
关键章节存在性测试只是最低闸，不替代逐条人工核对。

**PR 约束**：命中上述任一路径的 PR，Description 必须写明「手册已同步（改了哪节）」或
「无需同步 + 为什么不涉及作者契约」；漏同步 = P1。

## 6. 已知安全／兼容缺口（不得随旧文档删除而视为完成）

以下缺口在触及相关链路时必须一并修复，或在 PR 中保留明确的正式跟踪，不得静默丢弃：

- `networkSlot.ts` 的 `as: 'media'` 不能只信任 Content-Type（GLB 常见
  `application/octet-stream`），需要安全的 magic-byte／扩展名嗅探。
- SSH 远程场景必须让 `LiziMcpSessionContext` 携带 remote 标识；目录过户不得回退读取本机
  同名路径，无法证明来源时 **fail closed**。
- 手机版仍需把历史 mivo 动作按钮降级为纯展示。

## 7. 远程与手机版

插件能力可能运行在 SSH 远程工作区、设备互联远程控制或手机版控制端。新增或修改 IPC
channel 与推送事件时，若手机／远程控制场景需要用到，必须按
`packages/device-link/src/allowlist.ts` 顶部注释的准入判据登记 invoke／push 白名单并同步
topic 路由；产品层多端语义见
[`../product-rules/core-product-principles.md`](../product-rules/core-product-principles.md) 的
「多端连接与任务连续性」。缺登记会让手机／远程控制端永远调不通，且静态检查发现不了。

## Review 清单

1. 沙箱是否保持进程隔离、专属 partition、无 Node／宿主 FS／网络直连？身份是否由主机
   反查而非信任 sender 自报？
2. 新能力是否先在 manifest 声明 slot、走同一套校验、在确认框如实展示后才由 host 授权？
3. 网络是否限白名单域名、凭证无明文读回？附件／媒体／目录是否经归属校验的
   grant／deposit／ledger 交接，未暴露宿主绝对路径？
4. 内联凭证是否只走 trusted Desktop 专用 IPC，未登记 device-link？Main 是否重新校验
   sender、request、revision、action、精确字段集合与 manifest 绑定，且没有把 Renderer
   字段 id 直接当作 Secret key／路径？保险库写失败是否不 emit，写成功后是否仍重新
   assessment，而不是把“提交完成”当作 ready？
5. 改动是否命中作者可见契约（身份卡／管子／模型 slot／面板供片／打包）？命中就必须
   同步 `FORGE_GUIDE` 并在 PR 说明；漏同步 = P1。
6. 第 6 节的已知缺口是否被触及？触及是否一并修复或留了正式跟踪？
7. 新增 IPC／推送是否需要远程／手机版？需要就登记 device-link 白名单与 topic 路由。

最小验证入口：

```bash
pnpm --filter desktop exec vitest run src/main/cindy-brain
pnpm --filter desktop typecheck
```

其余按 [`desktop-development.md`](desktop-development.md) 的分层验证选择；命中媒体、协议或
IPC 时追加对应专项规则要求的验证。
