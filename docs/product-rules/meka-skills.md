# Meka 技能：产品与分发方案

> 状态：实施中
>
> 本文是 Cindy Meka 技能入口、标准技能兼容边界和 MCPRouter 独立分发链的事实文档。
> 客户端迁移状态同时登记在
> [`../migrations/xdmaker-meka-to-cindy.md`](../migrations/xdmaker-meka-to-cindy.md)。

## 1. 产品定位

Meka 技能与 Cindy 上游 SkillHub 使用同一种 Agent Skill：

- 技能是以根目录 `SKILL.md` 为入口的文件夹；
- 安装后进入现有 `.agents/skills` 发现链，并继续兼容 Claude Code 与 Codex；
- 技能内容中不写 Meka 渠道、MCPRouter 资源 ID、发布者或访问权限。

Meka 只建立独立的创建和分发渠道。它不代理、不聚合，也不改写 Cindy 上游 SkillHub。
顶部导航固定为“插件 / 技能 / 项目”，Meka 技能位于 Meka 插件之后。

客户端可能先于 MCPRouter 技能服务部署。当前 Router 对 `/api/skills` 返回 404 时，页面
进入明确的“服务端需要升级”空状态，不抛通用加载错误，也不回退到上游 SkillHub；网络
中断、5xx 和畸形响应仍按真实故障提示。

## 2. UI 与交互

Meka 技能不得维护一套独立的 Renderer 设计。页面直接复用 Cindy 上游技能首页的布局与
交互组件，包括标题和副标题层级、搜索、推荐技能卡、本地技能的全局／项目分组、右侧文件
预览侧板以及全局／项目／其他目录安装目标选择器。上游共享组件发生交互或样式调整时，
Meka 页面应自然同步，禁止复制一份样式近似但后续会漂移的卡片、详情 Dialog 或安装流程。

首页保留与上游一致的 “Skill Hub” 下钻入口，目标为 Meka 自己的 Skill Hub 页面；该页面
复用上游市场工具栏、排序／可获取／全部／我的发布筛选、市场卡、预览侧板和安装选择器，
但目录只读取 MCPRouter。首页“本地技能”也不是整机技能总览，只显示本地 registry 中
`origin = "installed"` 且 `distribution.channel = "meka"` 的下载技能；用户手写技能和
Cindy SkillHub 安装项只在
上游技能页显示。

允许存在的差异仅限渠道事实：目录与预览数据来自 MCPRouter，安装调用 Meka 下载通道并
写入 `distribution.channel = "meka"` provenance，渠道来源文案显示 MCPRouter。颜色继续
使用共享组件的语义 token，Light／Dark 与四语言能力随上游组件共同交付。

文件预览必须读取 MCPRouter 当前 release ZIP 中的真实文件内容，不能用 manifest 重建
`SKILL.md`，也不能给非 manifest 文件返回空字符串。Main 获取签名下载授权后把包限制在
10 MiB 内，校验 release 大小与 SHA-256，再逐文件校验索引大小与 SHA-256；单文件最多向
Renderer 返回前 1 MiB 文本并标记截断。同一 release 可在 Main 内按 Router／client-key
访问身份缓存，身份或 release 变化后不得复用；签名 URL 和 ZIP 字节不进入 Renderer。

Meka 技能入口的目标完整形态提供：

1. 创建 Meka 技能：创建标准技能目录；
2. 发布：在发布窗口中选择目录、版本、访问范围和可选的版本说明；
3. 从技能包安装：审查标准 ZIP 后安装；
4. 浏览和安装 MCPRouter 当前账号可访问的技能；
5. 对自己发布的技能上传新版本、修改访问范围或停止分发。

当前已落地的浏览安装切片包括 Meka Skill Hub、首页推荐、Meka 渠道本地技能、共享右侧
文件预览、全局／项目／其他目录安装、渠道 provenance 和显式同名替换。创建任务、一次性
目录选择、私有／指定用户／公开发布的 Main／IPC 分发链已经实现。技能首页在共享搜索栏
后使用与 Meka 插件相同的“添加技能”动作按钮，菜单提供“创建 Meka 技能”和“发布”；
创建进入 Cindy 原生新任务草稿，“发布”先打开发布窗口，用户在窗口内选择目录、权限、
发布版本和可选额外描述。目录审查后客户端查询 MCPRouter：首次发布默认 `1.0.0`，已有
技能默认把当前 SemVer 的 patch 加一；版本可在发布前调整并继续接受 SemVer 校验。直接
安装现成 ZIP、卸载和持久开发来源管理仍属于后续增量。

当前账号自己发布的技能在“可获取／全部／我的发布”卡片及预览侧板中直接显示“管理”
动作。管理弹窗在客户端内完成三类操作：选择并审查同一技能目录后发布新版本、切换
“仅自己／指定用户／公开”访问范围，以及停止远端分发。新版本仍复用发布窗口和一次性
目录授权，所选目录必须解析到同一个远端技能资源；同版本重试不得覆盖不可变 release，只
同步访问范围。权限修改与停止分发都由 Main 使用
MCPRouter owner session 重新读取资源，并以弹窗加载时的 current release ID 作为并发前提，
owner 或 release 已变化时拒绝写入并要求刷新。停止分发只删除远端发布记录，不卸载或
自动删除已经落到任意用户本机的副本。弹窗各操作区的按钮统一右对齐；停止分发入口不在
按钮上方重复展示标题或说明，只在用户点击后显示不可撤销确认。

技能详情侧板是首页推荐与 Skill Hub 共用的唯一详情实现，详情动作不得由入口、列表筛选或
页面自行传入互斥的“主操作”决定。只要入口提供安装能力就显示 Clone；当前账号是发布者且
提供管理能力时，同时显示 Clone 与管理，非本人发布的技能只显示 Clone。Meka 管理组件
自身承接新版本目录选择、同资源校验和发布弹窗，首页与 Skill Hub 不得分别复制这段流程。

发布窗口的访问范围控件与 Meka 插件保持同一交互和样式：使用“仅自己／指定用户／公开”
下拉选择；选择“指定用户”后显示相同层级的用户名输入与必填提示。目录尚未通过 Main 审查
时控件禁用，审查完成后三个选项全部可用。

发布失败时，MCPRouter 的 HTTP 错误状态会映射到客户端 IPC 错误码；409（资源已被其他
账号认领）使用 `ALREADY_EXISTS`，并保留服务端返回的截断原因。发布弹窗顶部提示优先显示
该原因；其它可读的异常也保留错误原因，只有没有可用原因时才回退到通用“上传插件失败”，
避免把可处理的归属冲突或网络故障隐藏为内部错误。

目录选择授权只保存在 Desktop Main 内存中，绑定当前数据 owner 与 app-session generation，
15 分钟后失效。Renderer 只得到来源 ID、用户刚选择的展示路径和审查元数据；Main 在打包
前后计算目录哈希，内容变化时拒绝授权，并把该次生成的 ZIP 作为授权快照留在 Main。发布
只能使用这份已审查字节，不得再次读取或打包可能已经变化的源目录。

## 3. 技能包契约

发布包是 ZIP，ZIP 根目录直接包含 `SKILL.md`，不得再包一层同名目录。

发布时必须满足：

- 用户源目录的 `SKILL.md` frontmatter 只要求非空 `name` 和 `description`，兼容不带
  `version` 的 Cindy 标准技能；发布版本属于 Meka release 元数据，不以源文件为事实来源；
- Main 打包后只在待上传 ZIP 的 `SKILL.md` 中注入本次 SemVer，绝不改写用户源文件；
- `name` 在首次发布后成为不可变 slug；
- release 不可变，同一技能下相同版本不得覆盖；
- 可选额外描述按 release 存入 MCPRouter `meka_skill_releases.publish_description`，不写回
  `SKILL.md`，最长 2000 字符；
- 禁止绝对路径、`..`、反斜杠逃逸、符号链接、大小写折叠冲突和重复条目；
- 不打包 `.git`、`.env`、`node_modules`、系统临时文件和宿主凭证；
- 第一阶段压缩包上限 10 MiB、解压后上限 50 MiB、ZIP 条目数上限 1000。

目录授权、安装和预览都必须执行上述压缩大小、解压大小和条目数边界。安装取得的短期下载
授权必须与用户确认的不可变 release 大小及 SHA-256 一致；预览还必须在解压前确认 ZIP
文件集合与 MCPRouter 文件索引一致。越界、授权变化或索引不一致时不得安装或向 Renderer
返回内容。

技能中的脚本在 Agent 会话权限内执行，不具备 `.cindy` 插件的独立沙箱。安装和更新前
必须展示 frontmatter、文件树和差异；包含脚本或二进制内容时额外提示风险。

## 4. 渠道隔离

Meka 技能的远端事实只属于 MCPRouter：

- 管理接口使用 MCPRouter session；
- 私有／指定用户／公开权限与 Meka 插件一致；
- 指定用户共享使用精确用户名，不引入上游团队、部门或组织可见性；
- 下载接口使用绑定到用户的 MCPRouter client key；公开技能允许匿名目录与下载授权；
- 包对象使用独立对象空间，不能与 Meka 插件或上游 SkillHub 混用；
- 生产上传参照 Meka 插件：Desktop 从 MCPRouter 申请短期 RustFS PUT，直接上传到独立
  `mcp-router-skills` bucket，再调用 finalize；MCPRouter 校验 owner、长度、内容类型、
  失效时间与完整技能包后才提交不可变 release；直传和 finalize 均受上传超时约束，网络
  停滞不得无限占用发布流程；
- 访问撤销不自动删除用户已经安装到本机的副本；
- 不自动安装、不自动更新、不跨渠道静默替换。

客户端保留渠道 provenance。Cindy 与 Meka 出现同名技能时，本机同一安装目标只能激活
其中一个版本；跨渠道替换必须由用户确认，并通过临时目录、校验、备份和原子切换完成。
渠道信息只写本地 registry，不写回 `SKILL.md`。

## 5. 与 Meka 项目角色的关系

第一阶段仍不把市场技能自动并入 `meka-projects/skillCatalog.ts` 的内置角色技能目录。
安装后的市场技能继续由 Claude Code、Codex 与 Cindy 的常规原生发现链使用；以后若增加
角色绑定市场技能，必须保存渠道、远端资源 ID 和 release ID／版本约束，不得只保存可冲突
的技能名称。

项目角色显式选择的内置、旧式路径和项目元数据 Skill 则使用任务级不可变快照：

- 首次启动任务时，把每个 Skill 的完整目录（`SKILL.md`、`scripts/`、`references/`、
  `assets/` 及二进制文件）复制到
  `<userData>/meka-skill-snapshots/revisions/<revision>/claude-plugin`；revision 对排序后的
  逻辑路径和文件 SHA-256 内容寻址，任务绑定写在 `bindings/<sessionId>.json`。空 Skill
  选择也会冻结为空 catalog，避免以后修改角色时改变旧任务；空快照不挂载原生插件、不创建
  Codex revision host，也不做远程 bundle 投递。
- 快照不写入用户 P4／自定义项目，也不生成项目内 `.agents` 或 `.claude` 目录。稳定、唯一的
  kebab-case Skill 名称和角色描述以结构化 YAML frontmatter 写入快照入口，其它 frontmatter
  与正文保留。
- Claude 通过 SDK local plugin 加载快照；Codex 通过 app-server
  `skills/extraRoots/set` 注册快照的 `skills` 根。两者启动上下文只暴露原生 Skill catalog
  元数据，完整 `SKILL.md` 和资源只在 Agent 选中 Skill 后读取；禁止把全部 Skill 正文内联
  到 `userPrompt` 或 system/developer prompt。
- 角色修改只影响新任务。已有任务恢复时必须读取原绑定并重新校验 manifest、文件集合、
  大小和 SHA-256；源目录后来变化或消失不改变快照。绑定、快照缺失或被篡改时明确阻断，
  不得按当前角色重新解析后静默漂移。
- 单个任务快照最多 4096 个文件、解码后共 64 MiB；拒绝绝对路径、`..`、反斜杠逻辑路径、
  符号链接、特殊文件、重复路径和同一 Skill 根中的歧义 `SKILL.md`。
- MCPRouter Worker 通过 cc-manager `bundle/ensure` 接收同一组已验证字节，并按 revision
  retain/release；普通 SSH 尚无等价的安全投影能力，带角色 Skill 的任务必须明确失败，
  不得退回全文 prompt。

SAGA2 当前只保留“通用开发”和“战斗开发”两个内置角色。通用开发通过
`includeAllProjectMetadata` 自动选择项目当前全部有效元数据；战斗开发继续显式选择战斗
相关 Skill，避免无关内容占用上下文。该选择机制只决定项目内标准 Skill 的运行时投影，
不改变 Skill 内联格式，也不把市场技能自动加入角色。

战斗开发角色先执行“环境门”，再按“只读探索 → 集中澄清 → 方案确认 → 执行验证”四阶段
工作。环境门必须用当次只读证据同时确认：Meka P4 或命令行 `p4` 能操作当前 SAGA2 工作区且
预期客户端文件具备 edit/checkout 路径；UnityMCP 已连接正确的 SAGA2 Unity 项目；MCPRouter
已连接且绑定的 SAGA2 服务器远程项目可达、可用。仅有配置项、缓存状态、Unity 可见窗口或
上一轮成功记录不算当前可用证据。客户端资产或代码编辑必须有可用 P4，不允许直接改受管文件
绕过 checkout。

任一环境检查失败时，角色先停止业务探索，并通过 Meka 设置、连接/绑定流程、UnityMCP 启动
引导或 P4 诊断主动协助恢复；不能退化为本地猜测、用 Unity 文件代替服务器证据、用 SSH 或
本地路径代替 MCPR。每次阶段切换、首次写操作前，以及出现工具/transport 错误或任一连接过期、
断开、不可用、项目错配迹象时，都重新校验三条链路。中途失败立即停止后续业务操作，保留已
完成证据并返回环境门；恢复后必须重跑全部三项，而非只复查失败项，并刷新停机期间可能变化的
revision 或运行时证据，完整通过后才从中断阶段继续。

战斗角色的环境门由 Host 在任务启动时实际执行，不是只写在提示词里的约定：P4 检查当前
工作区映射、客户端信息和目标客户端路径的写权限；UnityMCP 检查项目发现文件、项目根目录
和 `/health`；MCPRouter 不只检查当前项目绑定且可用的服务器实例，还必须对候选服务器执行
远端 Agent capability hello，确认 cc-manager bundle 与 protocol 和当前客户端精确匹配并且
可启动远端 Codex Worker。实例在线或项目已绑定不能单独判定为 ready；版本不匹配必须在加载
Skill、创建 Worker 或业务探索前阻断，并在不暴露 endpoint、实例 ID 或凭证的前提下回显
客户端与远端 bundle 版本。任一项失败，Host 把任务置于
仅环境恢复状态并返回不含凭证的检查回执和下一步恢复动作。首轮只回显身份、三项状态和恢复
动作后结束，不调用工具；用户后续明确要求恢复时只执行一次统一复检。该阶段不得加载任何
Agent Skill、读取 AGENTS/业务文件、扫描工具全集、调用 Ghost/Worker/Unity 业务能力或开始
需求探索。任务运行期间可通过角色自动挂载的
`mcp_router.check_combat_environment` 重跑同一门禁；工具/传输错误后不得继续业务操作，必须
恢复三项并重新检查。该工具随角色工作流自动启用，不需要用户额外选择插件。
环境恢复阶段不依赖 `mcp_router.list_tools` 或 `ALL_TOOLS` 发现能力；若旧上下文仍调用
`list_tools`，Host 只返回统一复检与安全实例投影的固定恢复契约，不访问上游控制面。这项查询
不得在完全访问下被描述为“用户拒绝”，也不等于授权执行远端升级、重启或其它有副作用操作。
战斗环境 blocked 时该工具只返回恢复态说明，不投影通用 Router 控制面清单；旧上下文直接调用
`mcp_list_instances` 等通用控制面查询时也不访问上游，而应引导使用安全的项目实例投影和统一
环境复检。所有 MCPRouter 工具文本回执在交给 Agent 前必须脱敏，带敏感 query 的完整 URL、
API key、token、物理路径不得进入任务消息或 rollout。
启动回执还必须规定首条用户可见消息先回显“战斗开发”身份及 P4、UnityMCP、MCPR 三项
状态；blocked 时该条消息后立即结束，不能加载 Skill、创建 Worker、扫描工具或重复复检。
启动门已经由 Host 执行，完全访问下不得把这项检查再次包装成权限请求。恢复阶段的 Host 拒绝
是工作流阶段限制，不是用户拒绝；模型不得改传 `sandbox_permissions`、换参数重试或要求提权。
远端 runtime/bundle/protocol 不匹配没有客户端自动升级入口，必须明确要求部署方升级并重启，
随后由用户触发一次统一复检。

战斗角色在只读探索阶段加载任务级原生 Skill 时，Host 只额外放行两种 Codex 生成的固定
PowerShell 形态：读取单个内容寻址快照中的 `SKILL.md` 并输出长度与完整正文；或对同一类
快照入口执行固定 `$paths` / `Test-Path` / `Get-Content | Measure-Object -Line` 行数统计循环；或
对单个同类入口执行 `(Get-Content -LiteralPath '<snapshot>/SKILL.md').Count`。
路径必须全部位于 `meka-skill-snapshots/revisions/<revision>/claude-plugin/skills/<skill>/SKILL.md`，
数量有上限，且不允许路径穿越、其它文件、写入、重定向、附加命令或脚本变体。完全访问下
符合该契约的读取不得显示为用户拒绝；任何不匹配形态仍由普通 Host 策略拒绝。

环境 ready 后允许的 MCP 只读白名单包含 Host 启动诊断（`cindy.ghost_list`、Unity
`manage_editor(telemetry_ping/get_status/get_current_context)`）和 MCPRouter 控制面发现。
环境 blocked 时只放行统一复检和必要的安全实例投影，旧上下文的通用控制面调用由本地安全回执
截断，不能访问上游；任何阶段都不放行 key、route、grant 或其它变更调用。MCPRouter
`list_tools`、实例查询或业务只读调用发生连接/传输错误，
Host 必须立即将环境标记为失效并禁止后续本地业务探索；模型只能回到环境恢复流程，不能改用
本地 Glob/Grep/Read 绕过远端证据要求。
业务 Shell 查询无匹配、文件不存在、路径或引号错误、非零退出、Unity 临时锁文件读取失败，
以及单项证据不足均不属于环境断线，不得触发统一环境复检；Lead 只可修正或收窄一次查询，仍
失败则把对应证据标为不确定。只有 P4、UnityMCP 或 MCPR 的连接、认证、传输错误，或 Host 明确
将门禁状态置为失效时，才重新执行三项环境恢复流程。

任务启动时还会从本次已解析角色配置注入 `[MEKA_ROLE_CONTEXT]`，明确回显 `projectId`、稳定
`roleId` 与展示名；模型不得用其它项目的自定义角色、用户数据缓存或当前窗口覆盖这组绑定。
Host 激活战斗门禁时以 `source=meka + projectId=saga2 + roleId=combat-development` 作为
`mekaWorkflow` 丢失时的 fail-closed 兜底，并优先识别独立的服务器 Worker workflow。缺少
workflow 元数据的旧版项目内置战斗角色快照会在任务启动时按稳定项目/角色 ID 恢复当前包内
战斗 workflow、中文提示词及必需 Skill/MCP；项目额外添加的规则、Skill、MCP 和元数据继续
保留，P4 下的 `.meka/project.json` 不被后台改写。Host 随即执行真实环境门，不允许先启动一个
无门禁任务再由模型自行补救。检查回执必须同时回显权威角色身份、workflow 是否由旧快照恢复
及三条链路状态，禁止通过扫描角色缓存自行判断当前角色。Main 启动日志只记录这组非敏感状态，
不记录 endpoint、实例标识、路径或凭证。

首次探索可以读取
通用文档、表结构和代码路径，但在用户明确技能 ID 前不得把 Unity 当前窗口、当前选中项、
编辑器上下文、缓存或历史技能当作目标，也不得向目标专属工具传入由这些状态推断的 ID。
探索后必须集中确认技能 ID、新建/整段重建/增量修改方式、允许修改的层面及尚未被证据解决的
空间、时序、目标、伤害、资源、叠加和生命周期语义；关键信息缺失时不得修改资产、表格、
JSON、P4、分支或客户端/服务器代码。完成目标专属取证后，角色必须明确给出模块、Timeline、
客户端代码、服务器代码、表格/导出的组合结论和验证计划，并取得用户对方案的明确同意才可
实施。

SAGA2 战斗的默认实现面是技能的 `skill-entry-model` 模块图；项目文档和 Agent Skill 只负责
导航，不能单独证明运行时能力。Lead 必须先读取模块知识、模块导出/资产和至少一个同类模块图，
把被动入口、周期、位置、随机落点、NavMesh、目标继承、延迟、范围、伤害、特效和清理拆成原子
能力，并标记“已有模块直接支持 / 可由模块组合支持 / 仍需服务器核查 / 未知”。能力描述不明确时，
继续核对权威表/Schema 与导出格式、客户端运行时消费代码以及当前服务器实现；Unity 编辑、预览、
资产保存或 JSON 导出成功都不能证明服务端已实现。既有服务器证据只有在能证明与当前远端仓
同一 revision 且定位到具体实现符号时才能复用，否则通过 MCPR 实查。证据不足时应报告能力
缺口并提出补能力方案，不得因为某个 Timeline 可编辑或缺少完整专用函数就否定已有模块组合。Router 实例与远端
Host 标识按不透明值处理，不得在回复或项目内容中暴露 endpoint、API key 或凭证。

内置 Skill 使用稳定英文 `name` / `skillId` 作为运行时契约，并在标准 frontmatter 的
`metadata.display-name` 中提供中文展示名；角色编辑器优先显示中文名，描述也使用中文，
但保存与解析仍使用稳定 ID。SAGA2 战斗开发必须在角色 manifest 中显式选择
`remote-operations`、`orca-coordination`、`saga2-overview`、`p4-operations` 和
`safety-boundaries`，并显式启用 `mcp-router` / `project-agent`；不能只依赖项目默认项，
否则编辑器状态无法表达服务器链路是否完整。项目默认项仍作为其他继承角色的兜底。

战斗策划发现 Unity 现有模块不足或需要核对服务端能力时，战斗开发角色必须通过已绑定的
MCPR 远程项目进入服务器仓，并先读取该仓 `AGENTS.md`。远端 Worker 在整个任务中永久只读，
不加载战斗策划服务器 Skill，不修改服务器文件、不创建或切换分支、不改 Excel、不生成文件，
只允许文件读取和 Host 可证明只读的命令，业务/项目 MCP 全部拒绝。MCPR Codex 当前不具备
回连本机 `orca_worker_bridge` 的传输通道，Worker 不得搜索或重试该工具；它把结构化报告作为
唯一一次终态回复输出，由 Orca auto-bridge 可靠投递给 Lead。服务器 Worker 不继承 Lead 角色
选中的任何 Meka Skill、Skill snapshot 或项目 MCP，只注入专用只读 Worker 提示词；
避免本地 Skill 根路径被投递到远端 Runtime，也避免服务器会话暴露本地 P4、Unity 或项目管理工具。
远端只返回当前 HEAD 的能力结论与代码证据；创建或派发 Worker 本身不代表核查完成。
Host 在每次创建前精确校验目标实例属于当前 SAGA2 绑定、在线、具备服务器项目语义且通过
Codex capability hello，不能只检查 `mcpr:` 前缀。已有 Worker 只有在当前 Lead 生命周期中曾由
Host 在该合格实例上验证并记录 worker/session 身份时才可复用；未知、本地或其它任务的 Worker
必须拒绝并新建合格的远端 Worker。

战斗 Lead 和服务器 Worker 的 Shell 只读探索统一使用可审计的单一命令：`rg`、`rg --files`、
`Get-Content`、`cat`、`git status/diff/show`。不得用变量、管道、重定向、命令串联或自行拼装脚本；
远端 Codex Runtime 自动生成的标准 `/bin/bash -c`、`/bin/bash -lc` 单命令包装除外。Host 仅窄解析
无嵌套单引号的 payload，并继续交给既有 shell 安全分类器判定，不因包装放宽写入或运行型命令。
多项证据逐条调用，并通过工具输出上限控制结果。Host 拒绝后不能改走 Web、计算器、SSH 或其它
无关工具；缩成上述形态仍失败时，按证据不确定停止并报告。
环境 ready 且需求已足以描述待核查的服务器语义后，Lead 必须先完成上述模块优先证据包，再
创建服务器 Worker；不得在没有 `skill-entry-model` 原子能力矩阵时派发。Worker 任务正文必须包含
`[SAGA2_MODULE_FIRST]`，明确列出本地模块证据和仅剩的服务器问题；Worker 只核查这些窄缺口，不能
把“没有完整专用函数”推导成整组技能不支持。客户端查询从已知配置、导出和消费者路径开始，必须
限定文本文件或具体目录，不递归读取 Unity 根目录、Library、Temp、Logs、二进制资源或锁文件。

远端结果使用简短 `serverCapabilityReport`，至少包含 `supportStatus`、`readOnlyConfirmed`、
`repository`、`head`、`codeEvidence`、`capabilityGap`、`programmerAction`、
`affectedSurfaces` 和 `validationSuggestion`。Lead 必须调用
`mcp_router.validate_server_capability_report` 校验。`supported` 可作为现有服务器能力证据；
`unsupported` 或 `uncertain` 会把任务切到程序交接阻断状态，Lead 必须停止当前实现并把报告
交给服务器程序，不能继续修改客户端、配置或服务器内容。服务器程序后续实现属于独立开发流程，
不由战斗开发角色代办。

Worker 工具调用获准时，Host 先记录与 Lead、任务正文和目标绑定的 `dispatching` 状态；只有
`create_worker` 返回 `dispatched=true`、队列句柄或 accepted dispatch outcome，或
`send_to_worker` 返回成功唤醒状态后，才进入 `pending`。创建失败、首任务未派发、Host 调用异常
都回滚为 `retry-required`，不能留下永久 pending，也不能当作正常消费。`dispatching` / `pending`
状态下方案审批、客户端读取、Shell、业务 MCP 和 Orca 主动轮询全部拒绝，但始终允许
`check_combat_environment`；该工具会清理未结算派发并重新执行 P4、UnityMCP、MCPR 三项门禁，
环境恢复后必须重新派发。

Lead 收到有效派发信号后必须立即结束当前回合，不输出等待说明，也不调用 `list_workers`、
`read_worker` 或 `worker_status`。Worker 终态使用可直接解析的原始 JSON 对象；Orca auto-bridge
成功投递给 Lead 后，Host 才按 Lead、Worker ID、Worker session 和本次派发记录进入
`report-ready`。校验器只接受与 auto-bridge 实际 JSON 结构完全一致的报告，并在成功后一次性
消费；回传前伪造、改写字段、串用其它 Worker 报告或重复提交都会拒绝。无效 JSON 回传进入
`retry-required`，不会解锁本地实施。Lead 不能自行代写报告；报告 `head` 必须是远端当前仓库
真实 Git SHA，“未取得回执”等占位内容不能通过 `validate_server_capability_report`。只有工具返回
`reportValidated: true` 才算真正消费远端结果。
只有 Worker 的 `done` 终态可进入 `report-ready`；`error` 终态即使包含结构合法的 JSON 也转为
`retry-required`。auto-bridge 投递暂时失败时保持 pending，允许 Orca 重试同一终态投递；不得把
尚未送达的文本提前登记成可信报告。

服务器核查 Worker 固定使用 Codex Agent 和 Host 当前 Codex 默认模型路由，避免项目默认 Agent/
模型差异改变流程可靠性。核查采用最小充分证据：任一剩余原子语义有具体代码证据证明不支持时才
返回 `unsupported`；如果模块图已经通过组合表达需求，即使没有同名完整服务器函数也应返回
`supported`。不为补齐其它能力做穷尽扫描；仅在证据冲突或读取失败时使用 `uncertain`。

上述阶段顺序由 Desktop Host 状态机强制执行，不只依赖角色提示词。战斗 Lead 新任务固定进入
原生计划模式；环境门未通过时只允许会话交互、三条链路的检查与恢复诊断，不能读取业务文件。
环境通过但方案未批准时，只允许只读文件、可证明只读的命令与 MCP 调用；方案必须包含
`[SAGA2_COMBAT_SOLUTION]` 包络及 `targetSkillId`、`changeMode`、`surfaces`、`moduleEvidence`、
`capabilityMatrix`、`evidence`、`validation`、`remainingUnknowns` 八个字段，缺字段时 Host 不展示为可批准方案。
`moduleEvidence` 必须引用 `skill-entry-model` 节点/字段或同类真实配置，`capabilityMatrix` 必须逐项
写出模块直接支持、模块组合支持或剩余服务器缺口，不能只写“存在/不存在完整函数”。方案批准只
解锁批准范围内的本地配置、Timeline、导出和客户端写入；非只读 MCPRouter 调用、未识别的 Orca
变更、批量/本地 Worker 和服务器服务管理在批准后仍永久拒绝，不能落入普通“环境复检后放行”分支。
用户通过原生方案字段不能使用“待确认”“当前选择”“unknown”等占位内容，`targetSkillId` 必须是具体 ID，
`changeMode` 只能是 `create`、`rebuild` 或 `incremental`，`surfaces` 必须包含实际实现面。方案
卡批准后，Host 在每次写文件、执行非只读命令或调用有副作用 MCP 前重新执行 P4、UnityMCP
与 MCPR 三项检查；任一失败立即退回环境恢复阶段。该拒绝优先于 Full access、会话记忆授权和
普通工具审批。

服务端探索使用 MCPR Orca Worker，并与本地 Lead 状态隔离。只有任务正文同时包含
`[SAGA2_SERVER_EXPLORATION_READ_ONLY]` 与 `[SAGA2_MODULE_FIRST]` 的远端 Worker 创建或派发可通过；Worker 自身使用
`saga2-combat-server-worker-v1`，不伪造本机 P4/UnityMCP 已就绪状态，并由 Host 在方案前后
永久限制为只读。Lead 批准方案不会扩大 Worker 权限，任何服务器写入、分支、Excel、生成物或
业务/项目 MCP 调用都直接拒绝。若未来某个传输显式暴露 `orca_worker_bridge.send_to_lead`，Host
只精确放行这一终态报告回传工具；当前 MCPR Codex 使用 auto-bridge。
选择战斗开发角色已授权该工作流强制要求的、带上述标记且由 Host 限制为只读的服务器核对；
当目标实例已经绑定且可用时，不再询问“是否允许创建只读 Worker”。这个窄例外不适用于绑定
或创建实例、远端写入、分支、服务管理、提交或推送。本地 Lead 也不能创建本地 Worker 来
替代 MCPR 证据。

战斗 Lead 在方案提交前不创建 Codex 原生子任务、本地子代理或本地 Worker 读取 Skill、规则、
表格或客户端代码；这些本地证据由 Lead 自己收集和整合。唯一允许的独立执行单元是带
`[SAGA2_SERVER_EXPLORATION_READ_ONLY]` 的 MCPR 远程 Worker，用于服务器仓证据。启动环境回执
已经是 Host 的权威结果，ready 时不得再分别调用 P4、Unity 或 Router 工具重复证明；阶段切换或
工具/传输失败后的复检统一调用 `mcp_router.check_combat_environment`。

上述“禁止本地子任务”是运行时能力边界，不只是角色文案。战斗工作流注入
`codexNativeSubagentsDisabled: true`，Codex 为其使用独立 app-server Host 并以
`agents.enabled=false` 关闭原生 `spawn_agent` 工具和 Multi-Agent V2 developer 提示；thread 的
新建、恢复和 profile 切换也重申同一配置，以覆盖 MCPR 远端 Worker。通用开发及普通任务继续
沿用用户的全局子任务设置。这样完全访问任务不会因子任务自动降为只读审批环境，也不会把子任务
命令拒绝错误显示成用户拒绝。

Codex code mode 的 MCP 审批可能只带 `toolParams`。Host 对战斗流程只按精确第一方参数结构识别：
带完整远程 Worker 创建字段及只读标记时允许方案前服务器探索；`meka-p4` 的精确
`p4_status` 只读调用可静默通过。缺标记、非 MCPR 目标、P4 写操作或未知参数形态继续拒绝；
Full access 不扩大这些业务白名单。

Codex 原生 Skill 加载可能生成严格形如
`$s=Get-Content -LiteralPath '<snapshot>/SKILL.md'; $s.Length; $s` 的 PowerShell 只读探针。
战斗 Host 只允许读取内容寻址的 Meka Skill 快照内单个 `SKILL.md`，且只允许输出同一变量的
长度和内容；其它路径、扩展名、管道、附加命令、写入或路径穿越仍按非只读操作拒绝。这类
Host 拒绝不得显示成用户主动拒绝。

UnityMCP 的 HTTP 配置通过会话感知代理投影到 Claude/Codex，避免 Codex 进程级 MCP 配置冻结后
跨任务暴露或绕过 Host。普通任务未选择 UnityMCP 时不能调用；战斗任务中的自定义 Unity 工具
仅 `get_`、`list_`、`read_`、`search_`、`find_`、`inspect_`、`query_`、`validate_`、
`describe_` 前缀按只读处理，其余按写操作处理。UnityMCP 连接异常会把 Lead 状态退回环境恢复。
服务器能力报告必须调用 `mcp_router.validate_server_capability_report` 校验。报告仅证明远端
Worker 对当前 HEAD 做过只读核查，不代表实施过服务器修改；`unsupported` 或 `uncertain` 会
设置程序交接阻断状态，Host 随后拒绝业务读取、写入和方案审批。方案 `surfaces` 不得包含
`server`，因为服务器代码不是该角色可实施的表面。

## 6. 目标架构

客户端分为四层：

1. 标准技能包层：frontmatter、ZIP、哈希、路径安全和文件树；
2. 安装层：全局／项目目标、原子替换、兼容链接和本地 registry；
3. 渠道适配层：上游 SkillHub 与 Meka MCPRouter 使用不同 API、鉴权和 provenance；
4. Renderer：同一套 Cindy 技能页面组件，由页面注入对应渠道适配器；不得产生 Meka UI
   fork。

MCPRouter 新增独立 Meka Skill Registry，拥有独立资源、release、共享关系和对象空间。
首个客户端只依赖 MCPRouter 自有 API；不修改 `cindy-protocol` 子仓。以后出现第二个独立
客户端且确有共享 wire contract 的需要时，再按协议变更规则另行评审。

## 7. 分阶段实施与验收

当前进度：阶段 A 已完成；阶段 B 已完成全局／项目／其他目录安装、渠道 provenance 和
显式替换，更新与卸载待补；阶段 C 已完成一次性目录授权、发布窗口、远端版本建议、
源文件无版本兼容、版本级额外描述、打包发布、访问范围，以及 owner 管理弹窗中的新版本、
权限修改和停止分发，持久开发来源待补；
阶段 D 未开始。

### 阶段 A：页面与只读目录

- 增加“插件 / 技能 / 项目”页签和 `/cc-agent/meka/skills` 路由；
- 页面标题、搜索、卡片和状态对齐上游技能；
- 支持读取公开目录与当前 MCPRouter 账号可访问目录；
- 未登录 Router 时只显示公开技能与本地技能。

### 阶段 B：标准包与安装

- 客户端和服务端使用同一组兼容 fixture 验证 ZIP；
- 支持全局／项目安装、更新、卸载和显式跨渠道替换；
- 原子切换失败后保留旧版本；账号切换不串 provenance。

### 阶段 C：创建与发布

- 支持创建目录、登记开发来源、打包和发布；
- 支持私有／指定用户／公开、版本冲突和并发 release 防护；
- 上传字节不经过 Renderer 长期持有，凭证和签名地址不落盘。

### 阶段 D：生产化

- RustFS 预签名直传与 finalize；
- 公开发布的敏感信息、恶意内容和包结构扫描；
- Windows 与 macOS、Light 与 Dark、四语言和真实 Router 全链手测。

### 暂不包含

- 修改 maker-core system prompt；
- 修改 `cindy-protocol`；
- 自动同步、自动更新或自动删除；
- 将市场技能自动加入 Meka 项目角色。
