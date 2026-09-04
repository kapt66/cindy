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

Meka Skill 分为两层：平台层说明能力类型、选择顺序、配置层级、恢复和安全边界；业务层说明项目工作面、证据优先级和业务流程。平台层不包含 SAGA2 服务器等业务名称，业务层不重新定义 MCP、远程 Agent 或 Orca transport。Desktop Host 在每个普通 Meka 任务启动时动态加入 `mcp-router` 能力引用，但只有明确的服务器任务才注入主动读取/登录契约；其它任务通过 Ghost 被动发现。专用远端 Worker 仍保持窄能力隔离。需要交互式 Router 登录时，Host 等待主壳登录框的完成回执并继续原工具，取消或超时后才向 Agent 返回恢复动作。完整契约见 [`meka-capability-layers.md`](meka-capability-layers.md)。

MCPRouter 绑定的远程项目可以作为当前项目的外部参考工作面。真实 Router 读取发现会话或 client key 缺失时，Router Service 先使用 Host 加密保存的账号材料单飞重连。业务请求依赖远程项目时，Host 再复用并绑定唯一匹配实例，或从唯一匹配模板创建并绑定；成功后默认优先使用远程项目只读 route。只有自动恢复返回 `fallbackUserAction` 或失败，才向用户提示最小必要动作；只有只读能力不足，或用户明确需要持续执行、独立历史、远程命令、结构化报告或人工接管时，才升级为远程 Agent/Orca Worker。远程项目只读能力与远程 Agent runtime 分开检查。

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
相关 Skill，避免无关内容占用上下文。战斗开发固定包含内置 `combat-skill-configuration`
Skill，负责把模块节点模型、JSON 导入和逐字段验证串成配置闭环；客户端项目内的
`editor-skill-editor-module`、Timeline、Effect 与服务器 Skill 仍是字段和运行时事实源。
该选择机制只决定项目内标准 Skill 的运行时投影，
不改变 Skill 内联格式，也不把市场技能自动加入角色。

普通任务通过 Ghost 清单/信息链被动发现插件，P4 插件缺失时由 P4 技能回退命令行诊断；
Host 不在会话启动阶段主动选择或引导某个业务插件。

战斗开发角色按“只读探索 → 集中澄清 → 内部方案检查 → 执行验证”四阶段工作。用户明确要求
实施时，结构化方案是 Agent 内部检查点，不再要求额外方案审批交互；只有范围不明、证据冲突
或高风险越界时才暂停。仅在实际调用依赖
工具时按当次只读证据确认：Meka P4 插件能操作当前 SAGA2 工作区且
预期客户端文件具备 edit/checkout 路径；Meka Unity 官方 CLI 已可检查正确的 SAGA2 Unity 项目；MCPRouter
已连接且绑定的 SAGA2 服务器远程项目可达、可用。仅有配置项、缓存状态、Unity 可见窗口或
上一轮成功记录不算当前可用证据。客户端资产或代码编辑必须有可用 P4，不允许直接改受管文件
绕过 checkout。

`saga2_design` 战斗策划库的待修改项与冲突口径单独记录在
[`saga2-design-combat-skill-followups.md`](saga2-design-combat-skill-followups.md)。该清单只供审查，
不构成写入授权；当前任务对 `saga2_design/planning` 保持只读。

Meka Unity 的 Unity Editor 通常由用户长期保持打开。需要启动目标工程时，插件先检查 status 并复用
匹配的 ready Editor；明确没有可用 Editor/Pipeline 实例时，Host 在公共工具入口弹出 Cindy 通用确认框。
确认框不写入 Agent 对话正文，只有用户点击同意后 Host 才在同一工具调用内执行一次
`meka-unity/unity_execute(action=open)`。取消、超时、启动失败或状态无法证明“无实例”时均 fail closed，
不得循环重试或静默启动。插件内部仍保留 status 后复用作为兼容性最后一道保护，避免 Unity“项目已有
进程”弹窗及重复实例登记。

Meka 插件源码可以来自独立的 `cindy-meka-plugins` checkout。`ghost_forge_pack` 只有在创建入口
明确传 `channel: "meka"` 时，才使用 Host 配置的 Meka 源码根白名单；普通插件制作仍要求源码位于
当前任务工作目录。白名单只覆盖源码根下的具体插件子目录，不覆盖源码根本身，并继续与已安装插件根、
批准状态根和 seed 根互斥。该渠道字段只影响 Host 归属，不写入 `ghost.json`，也不扩大任何插件运行时
文件权限。

战斗技能配置的默认验收是静态闭环，不要求进入游戏、Play Mode 或启动服务器。Agent 应以客户端
消费者、老版模块编辑器导出 JSON、MCPRouter 服务器权威代码和 P4 范围为事实源，使用官方 CLI
的 `legacy_module_export_json` / `legacy_module_import_json` 完成字段回读与 round-trip。通用
Unity CLI 仍完整暴露所有工具和接口，但战斗角色不应为发现命令而反复调用 `unity_inspect(action=list)`
并把完整清单灌入上下文；已知命令直接调用，只有名称未知时才窄范围筛选清单。当前官方 CLI
模块回读不得编造或重试未登记的模块查询接口。只有用户明确提出运行时联调时，
才追加运行时命令与运行入口检查；静态任务不得自行进入 Play Mode。

若 `unity_inspect(action=status)` 返回没有实例、未就绪或 Pipeline 缺失，Agent 不得自行安装
Pipeline、打开或重启 Unity。对明确依赖 Editor 的原子操作，Meka Unity 插件返回结构化的
`UNITY_EDITOR_START_CONFIRM_REQUIRED`，由 Host 统一弹出启动确认；用户同意后 Host 只执行一次
`unity_execute(action=open)` 并重试原操作，取消、超时或启动失败均返回结构化失败，不在对话正文中
追加一条“是否启动 Unity”的业务询问。若用户未同意或导出传输仍失败，Unity 部分标记为 `uncertain`，
不允许进入写入阶段，随后继续不依赖 Unity 的服务器只读核查。

老版模块资产的导入成功必须经过磁盘持久化验证，不能以同一 Editor 内存中的即时导出代替。
`legacy_module_import_json` 保存后强制重新导入目标资产，并逐字段比较协议 JSON；只有返回
`persistenceVerified=true` 且 `persistedNodeCount` 与导入数一致才算成功。导入前，已有资产
必须通过 Meka P4 插件实际执行 `p4_edit`；新资产先用 `legacy_module_prepare_asset` 创建空白
`.asset`/`.meta`，再对两者执行 `p4_add`。仅查看 P4 状态不能替代这些动作。战斗任务的导入源
和回读 JSON 只允许使用操作系统临时目录或 `saga2_unity`，不得写入 `saga2_json`、
`saga2_design` 或其它目录。上述目标技能 ID、老版模块命令参数和 JSON 路径裁决必须同时覆盖
直连 Meka MCP 与公共 `cindy.ghost_call` 路由；公共入口在插件 setup、附件授权、目录票据和真实
派发前执行同一战斗策略。普通角色、非战斗插件和未启用该 workflow 的任务不受此专用裁决影响。

技能 ID 允许在同一任务内按“首轮纯业务需求 → Agent 追问 → 用户补充 ID”的方式提供。Host
不得只在任务创建或恢复时解析 ID；每条真实用户消息在进入模型前都要重新检查明确标注的技能 ID，
并在数据库确认当前任务属于 `saga2/combat-development` 后刷新在线会话的目标绑定。没有标注 ID
的普通续聊保留既有绑定，多个 ID 切换到歧义态并停止工具调用。用户补充了唯一 ID 后，无需重开
任务、重启 Agent 或重复完整业务描述，当前回合的公共 Ghost 与直连工具门禁必须立即看到新值。
一个战斗任务只允许用户提供的这一个目标技能 ID。参考技能、历史样例、第二个 ID 及
`[SAGA2_REFERENCE_SKILL_ID: ...]` marker 均不得进入读取、导出、Worker 任务或结论；需要判断
模块组合时，以当前目标导出、最窄客户端消费者和当前服务器 HEAD 为证据。

三项聚合 `ready=false` 只作为 Host 内部预警，不是任务级开关，也不要求角色先向用户播报环境
状态。角色继续加载相关 Skill、澄清需求、读取本地代码/表格并使用仍然可用链路上的工具。Host 只在具体
工具实际依赖故障链路时阻止该次调用：受管本地写入依赖 P4，Unity 工具依赖 Meka Unity 官方 CLI，服务器
查询和远程 Worker 依赖 MCPRouter；一个依赖失败不得冻结其它表面。拒绝回执必须明确依赖、当前
原因和可执行解决方案，并说明其它独立工作仍可继续。不能退化为本地猜测、用 Unity 文件代替
服务器证据、用 SSH 或本地路径代替 MCPR。

普通角色或缺少战斗 workflow 的任务误调用 `check_combat_environment` 时，只返回
`status=advisory`、`workflowActive=false` 和 `dependencyChecksRun=false` 的非错误提醒；不得把
“未绑定战斗工作流”描述成 P4、Meka Unity 官方 CLI 或 MCPRouter 不可用，也不得因此结束回合。三项依赖的
真实失败仍只在对应工具实际调用时按该工具回执处理。

每次阶段切换、具体实施前，以及出现真实工具/transport 连接错误或任一连接过期、断开、不可用、
项目错配迹象时，统一重新校验三条链路并刷新各自状态。复检后只按当前工具的实际依赖决定是否
放行，不要求三项全部恢复才能继续其它表面。普通无匹配、文件不存在或证据不足不触发复检。

战斗角色的环境门由 Host 在任务启动时实际执行，不是只写在提示词里的约定：P4 检查当前
工作区映射、客户端信息和目标客户端路径的写权限；Meka Unity 官方 CLI 检查项目根目录
和 `/health`；MCPRouter 检查当前项目绑定且可用的服务器实例是否可作为远程项目参考工作面。
只有真正创建远程 Agent/Worker 时才执行 capability hello，确认 cc-manager bundle 与 protocol
和当前客户端精确匹配。实例在线或项目已绑定不能单独判定为 Worker ready；远程项目只读参考
能力与 Worker runtime 分开判断。版本不匹配必须阻止实际创建 MCPR Worker，不得阻止已可用
的远程项目只读 route 或本地工作，并在不暴露 endpoint、实例 ID 或凭证的前提下回显客户端
与远端 bundle 版本，但不得阻止不依赖 MCPR 的本地探索或 Unity/P4 工作。任一项失败，Host 在
内部检查回执中保存不含凭证的状态和下一步恢复动作；不要求首轮固定回显。任务运行期间可通过
角色自动挂载的 `mcp_router.check_combat_environment` 重跑同一检查并
刷新三项状态。该工具随角色工作流自动启用，不需要用户额外选择插件。
`mcp_router.list_tools` 和只读控制面查询在实际调用时才访问 MCPRouter；MCPR 已知不可用时 Host
只阻止该次调用并返回原因和恢复方案，不影响本地或 Unity 工具。这项拒绝不得在完全访问下描述为
“用户拒绝”，也不授权执行远端升级、重启或其它有副作用操作。所有 MCPRouter 工具文本回执在
交给 Agent 前必须脱敏，带敏感 query 的完整 URL、
API key、token、物理路径不得进入任务消息或 rollout。
启动回执不得要求首条用户可见消息先回显角色身份或 P4、Unity CLI、MCPR 三项状态。用户请求
依赖服务器时先自动确保并读取；只有自动处理返回 `fallbackUserAction` 时才提示用户。
启动门已经由 Host 执行，完全访问下不得把这项检查再次包装成权限请求。恢复阶段的 Host 拒绝
是工作流阶段限制，不是用户拒绝；模型不得改传 `sandbox_permissions`、换参数重试或要求提权。
远端 runtime/bundle/protocol 不匹配没有客户端自动升级入口，必须明确要求部署方升级并重启；
实际使用 MCPR 工具时阻止该次调用，解决前仍可继续其它表面。

战斗角色在只读探索阶段加载任务级原生 Skill 时，Host 只额外放行两种 Codex 生成的固定
PowerShell 形态：读取单个内容寻址快照中的 `SKILL.md` 并输出长度与完整正文；或对同一类
快照入口执行固定 `$paths` / `Test-Path` / `Get-Content | Measure-Object -Line` 行数统计循环；或
对单个同类入口执行 `(Get-Content -LiteralPath '<snapshot>/SKILL.md').Count`。
路径必须全部位于 `meka-skill-snapshots/revisions/<revision>/claude-plugin/skills/<skill>/SKILL.md`，
数量有上限，且不允许路径穿越、其它文件、写入、重定向、附加命令或脚本变体。完全访问下
符合该契约的读取不得显示为用户拒绝；任何不匹配形态仍由普通 Host 策略拒绝。

允许的 MCP 只读白名单包含 Host 启动诊断（`cindy.ghost_list`、Meka Unity 官方 CLI
`unity_inspect(action=status)`）和 MCPRouter 控制面发现。
聚合状态 blocked 时仍按具体工具依赖裁决；任何阶段都不放行 key、route、grant 或其它
未经授权的变更调用。MCPRouter
`list_tools`、实例查询或业务只读调用发生连接/传输错误，
Host 必须立即将 MCPR 这一条依赖标记为失效；后续 MCPR 调用给出原因与解决方案，但本地业务
探索可继续。模型不能用本地 Glob/Grep/Read 冒充缺失的远端证据。
业务 Shell 查询无匹配、文件不存在、路径或引号错误、非零退出、Unity 临时锁文件读取失败，
以及单项证据不足均不属于环境断线，不得触发统一环境复检；Lead 只可修正或收窄一次查询，仍
失败则把对应证据标为不确定。只有 P4、Unity CLI 或 MCPR 的连接、认证、传输错误，或 Host 明确
将门禁状态置为失效时，才重新执行三项环境恢复流程。

任务启动时还会从本次已解析角色配置注入 `[MEKA_ROLE_CONTEXT]`，明确提供 `projectId`、稳定
`roleId` 与展示名；模型不得用其它项目的自定义角色、用户数据缓存或当前窗口覆盖这组绑定。
Host 不在任务启动时执行聚合战斗环境门禁；角色/工作流只用于选择实际工具调用策略，依赖失败
时按调用点自动引导或阻塞，并优先识别独立的服务器 Worker workflow。缺少
workflow 元数据的旧版项目内置战斗角色快照会在任务启动时按稳定项目/角色 ID 恢复当前包内
战斗 workflow、中文提示词及必需 Skill/MCP；项目额外添加的规则、MCP 和非旧版辅助 Skill 继续
保留，旧版战斗角色曾内置的通用导航、P4、Orca、远程操作、服务器参考、EntryModel 辅助 Skill
以及模块编辑器元数据选择会按当前精简契约在内存中移除，P4 下的 `.meka/project.json` 不被后台
改写。检查回执只在实际依赖工具调用时生成，必须同时
携带权威角色身份、workflow 是否由旧快照恢复
及三条链路状态，禁止通过扫描角色缓存自行判断当前角色。SAGA2 战斗角色的已知 bundled Skill
重命名（当前 `skill-entry-model` → `saga2-entry-model`）也只在运行时按项目/角色范围做内存
迁移，保留旧快照以便用户编辑和回退。Main 启动日志只记录这组非敏感状态，
不记录 endpoint、实例标识、路径或凭证。

生成、修改或检查技能时，用户明确提供正整数技能 ID 之前不得开始任何探索：不读取通用文档、
表结构、代码、模块或编辑器上下文，也不调用 Unity CLI、P4、MCPRouter 或其它项目工具；只原样
回复“请提供要生成、修改或检查的正整数技能 ID。”，不追加技术解释或其它问题。不得把 Unity 当前窗口、当前选中项、缓存或历史技能当作目标，
也不得向目标专属工具传入由这些状态推断的 ID。
ID 一旦由 Host 绑定到当前任务，后续业务澄清回复不要求重复携带；一个任务始终只有一个目标
技能 ID。用户一次给出多个 ID 时仍只返回同一句单目标追问，不选择其中一个，也不批量处理。
探索后必须集中确认目标 ID 对应的新建/整段重建/增量修改方式、允许修改的层面及尚未被证据解决的
空间、时序、目标、伤害、资源、叠加和生命周期语义；关键信息缺失时不得修改资产、表格、
JSON、P4、分支或客户端/服务器代码。用户已经明确要求生成、修改、导入、导出或验证时，
该请求本身提供实施授权；角色在内部完成模块、Timeline、客户端代码、服务器代码、表格/导出的
组合结论和验证计划后直接实施。Host 仍强制目标技能导出、服务器 supported 回执、P4 和写入范围
门禁，不因该授权跳过证据或把服务器只读能力变成写权限。

SAGA2 战斗的默认实现面是技能的 `skill-entry-model` 模块图；项目文档和 Agent Skill 只负责
导航，不能单独证明运行时能力。技能 ID 确认后，Lead 先校验 Meka Unity 官方 CLI 的常驻实例，
第一条内容证据必须是目标技能的老版编辑器 JSON 导出；只有该结构化回执能判定目标资产是否
存在。随后只读取最窄客户端消费者，
把被动入口、周期、位置、随机落点、NavMesh、目标继承、延迟、范围、伤害、特效和清理拆成原子
能力，并标记“已有模块直接支持 / 可由模块组合支持 / 仍需服务器核查 / 未知”。能力描述不明确时，
继续核对权威表/Schema 与导出格式、客户端运行时消费代码以及当前服务器实现；Unity 编辑、预览、
资产保存或 JSON 导出成功都不能证明服务端已实现。生成、修改和检查任务都必须为当前技能 ID
取得本任务、当前远端 HEAD 的服务器证据，即使现有资产已经完全符合需求也不能省略。历史任务、
本地客户端代码或旧 revision 只能作为候选线索，不能作为本轮 `supported` 结论。证据不足时应报告能力
缺口并提出补能力方案，不得因为某个 Timeline 可编辑或缺少完整专用函数就否定已有模块组合。Router 实例与远端
Host 标识按不透明值处理，不得在回复或项目内容中暴露 endpoint、API key 或凭证。

内置 Skill 使用稳定英文 `name` / `skillId` 作为运行时契约，并在标准 frontmatter 的
`metadata.display-name` 中提供中文展示名；角色编辑器优先显示中文名，描述也使用中文，
但保存与解析仍使用稳定 ID。SAGA2 战斗开发的角色 manifest 只显式选择一个总控
`combat-skill-configuration` Skill，并显式启用业务层的 `project-agent`；P4、Orca、MCPRouter、
Meka Unity 官方 CLI 和全部通用工具接口仍由 Host/插件照常暴露，不通过重复 Skill 正文提供。平台层的
`platform-capabilities` / `mcp-router` 不写入角色 manifest 或项目默认项，由 Host 动态注入。
角色编辑器只表达业务能力选择，不承担平台基线开关。
战斗任务运行时不得再读取 `saga2_unity/.agents/skills`、用户 Skill、插件 Skill 或其它位置的
`SKILL.md`，也不得调用 `ghost_info`、Skill 列表或项目管理 `list_tools` 发现辅助 Skill。不得使用
历史导出或共享 `skill_entry_model_editor.json` 代替目标技能导出，也不得扫描 `Library`、`Temp`、
`Logs` 或整个 Unity 根目录；这些限制只改变战斗流程的工具选择，不隐藏通用工具接口。

战斗策划发现 Unity 现有模块不足或需要核对服务端能力时，战斗开发角色必须通过已绑定的
MCPR 远程项目进入服务器仓，并先读取该仓 `AGENTS.md`。远端 Worker 在整个任务中永久只读，
不加载战斗策划服务器 Skill，不修改服务器文件、不创建或切换分支、不改 Excel、不生成文件，
只允许文件读取和 Host 可证明只读的命令，业务/项目 MCP 全部拒绝。Worker 不依赖
`orca_worker_bridge`，不得搜索或重试该工具；它把结构化报告作为
唯一一次终态回复输出，由 Orca auto-bridge 可靠投递给 Lead。服务器 Worker 不继承 Lead 角色
选中的任何 Meka Skill、Skill snapshot 或项目 MCP，只注入专用只读 Worker 提示词；
避免本地 Skill 根路径被投递到远端 Runtime，也避免服务器会话暴露本地 P4、Unity 或项目管理工具。
远端只返回当前 HEAD 的能力结论与代码证据；创建或派发 Worker 本身不代表核查完成。
Host 在每次创建前精确校验目标实例属于当前 SAGA2 绑定、在线、具备服务器项目语义、Agent 类型
与请求一致且通过该 Agent 的 capability hello，不能只检查 `mcpr:` 前缀。已有 Worker 只有在当前 Lead 生命周期中曾由
Host 在该合格实例上验证并记录 worker/session 身份时才可复用；未知、本地或其它任务的 Worker
必须拒绝并新建合格的远端 Worker。

战斗 Lead 和服务器 Worker 的 Shell 只读探索契约统一使用可审计的单一命令：本地为范围明确的
`rg`、`Get-Content` 或 Git 只读查询；远端只允许 `git show`、`git grep`、`git status`、
`git diff`，不得调用 `Read` 或 `rg`，也不得读取 Claude 为超长工具输出生成的临时结果文件。
变量、管道、重定向、命令串联和自行拼装脚本一律拒绝；远端 Codex
Runtime 自动生成的标准 `/bin/bash -c`、`/bin/bash -lc` 单命令包装除外。Codex
`getShellCommandPolicy` 已传入任务上下文并由 Desktop 注入 `combatWorkflowPolicy`，因此缺 ID、
根 `AGENTS.md`、AGENTS 枚举、客户端 Assets 根搜索、其它 Skill、开发中编辑器实现和共享 JSON
都会在执行前被 Host 拒绝。普通角色仍保留全部通用 Shell 与工具接口。证据命令失败时不得改走
Web、计算器、SSH 或其它无关工具，应按证据不确定停止并报告。
服务器 Worker 的 `git grep` 必须显式指定 `HEAD`，不得读取远端工作树状态作为权威语义。默认
先用 `git grep -l -E <精确符号> HEAD -- internal/battle` 取得真实路径，再在最多三条路径上用
`git grep -n -C 24 -E <精确符号> HEAD -- <path>` 读取定义、注册和执行分支附近的有限上下文；
禁止用 `git show` 打开会被工具截断的大型实现文件。Host 只允许最多 40 行上下文。普通伤害、
攻击力百分比、等待/重复和技能目标锁定可由战斗总控 Skill 提供
`entryTypeDamageHit`、`dataFunRoleAtk`、`entryTypeTimeWait`、`entryTypeSetSkillTarget` 作为候选
搜索锚点；它们仍须在本轮远端 HEAD 逐项验证，不能作为历史免检事实。策划只需提供业务需求和
正整数技能 ID，不承担任何服务器符号或协议字段输入。
环境 ready 且需求已足以描述待核查的服务器语义后，Lead 必须先完成上述模块优先证据包，再
创建服务器 Worker；不得在没有目标技能老版导出和原子能力矩阵时派发。Worker 任务正文必须包含
`[SAGA2_MODULE_FIRST]`，明确列出本地模块证据和当前技能仍需服务器确认的目标、时序、数据函数、
条件及生命周期语义；Worker 只核查该原子矩阵，不扩大到无关能力，也不能把“没有完整专用函数”
推导成整组技能不支持。客户端查询从已知配置、导出和消费者路径开始，必须
限定文本文件或具体目录，不递归读取 Unity 根目录、Library、Temp、Logs、二进制资源或锁文件。

远端结果使用简短 `serverCapabilityReport`，至少包含与当前任务绑定值一致的正整数
`targetSkillId`、`supportStatus`、`readOnlyConfirmed`、
`repository`、`head`、`codeEvidence`、`capabilityGap`、`programmerAction`、
`affectedSurfaces` 和 `validationSuggestion`。Lead 必须调用
`mcp_router.validate_server_capability_report` 校验。`supported` 可作为现有服务器能力证据；
`unsupported` 或 `uncertain` 会把任务切到程序交接阻断状态，Lead 必须停止当前实现并把报告
交给服务器程序，不能继续修改客户端、配置或服务器内容。服务器程序后续实现属于独立开发流程，
不由战斗开发角色代办。
Host 在消费可信 auto-bridge 回执前校验 `targetSkillId`；错误或缺失的 ID 会被拒绝且不消费回执，
防止其它技能的服务器结论污染当前任务。

其中 `codeEvidence` 允许使用简短字符串，或使用带 `path`、`symbols`、`details` 的结构化证据
对象；Host 会在严格字段校验后规范化为可审计文本，避免真实 Worker 使用结构化取证时被误判为
无效报告。

Worker 工具调用获准时，Host 先记录与 Lead、任务正文和目标绑定的 `dispatching` 状态；只有
`create_worker` 返回 `dispatched=true`、队列句柄或 accepted dispatch outcome，或
`send_to_worker` 返回成功唤醒状态后，才进入 `pending`。创建失败、首任务未派发、Host 调用异常
都回滚为 `retry-required`，不能留下永久 pending，也不能当作正常消费。`dispatching` / `pending`
状态下方案审批、客户端读取、Shell、业务 MCP、环境复检和 Orca 主动轮询全部拒绝；Lead 结束
当前回合并等待 auto-bridge 投递。只有派发回滚为 `retry-required`、任务明确处于
`environment-recovery`，或具体工具返回真实传输失败时，才允许调用
`check_combat_environment` 清理未结算派发并重新执行 P4、Unity CLI、MCPR 三项门禁；环境恢复后
必须重新派发。普通无匹配、文件不存在、业务字段待澄清或证据不足均不触发环境复检。

Lead 收到有效派发信号后必须立即结束当前回合，不输出等待说明，也不调用 `list_workers`、
`read_worker` 或 `worker_status`。Worker 终态使用可直接解析的原始 JSON 对象；Orca auto-bridge
成功投递给 Lead 后，Host 才按 Lead、Worker ID、Worker session 和本次派发记录进入
`report-ready`。校验器只接受与 auto-bridge 实际 JSON 结构完全一致的报告，并在成功后一次性
消费；回传前伪造、改写字段、串用其它 Worker 报告或重复提交都会拒绝。无效 JSON 回传进入
`retry-required`，不会解锁本地实施。Lead 不能自行代写报告；报告 `head` 必须是远端当前仓库
真实 Git SHA，“未取得回执”等占位内容不能通过 `validate_server_capability_report`。只有工具返回
`reportValidated: true` 才算真正消费远端结果。
首次建 Team 必须显式请求 `worker_permission_mode=auto`。Host 对
`saga2-combat-development-v1` 再做确定性收敛：即使模型传入 `bypassPermissions`，实际交给 Orca
生命周期服务的模式仍为 `auto`，不弹出 Full access 升级确认；其它角色和普通 Orca 任务继续使用
用户保存的通用权限偏好。
只有 Worker 的 `done` 终态可进入 `report-ready`；`error` 终态即使包含结构合法的 JSON 也转为
`retry-required`。auto-bridge 投递暂时失败时保持 pending，允许 Orca 重试同一终态投递；不得把
尚未送达的文本提前登记成可信报告。

战斗任务新建或恢复时，Host 将服务器能力状态显式初始化为 `unchecked`。该状态允许读取当前技能、
客户端消费者、同类配置，以及通过老版编辑器执行 `legacy_module_export_json`，从而形成模块优先
证据包；但禁止 P4 checkout/add、资产创建、`legacy_module_import_json` 和其它实施操作。只有
auto-bridge 报告经 `validate_server_capability_report` 一次性消费并得到 `supported` 后才解锁写入。
结构化方案同样要求该状态，避免 autonomous execution 绕过服务器事实源。最终回复宣称
`serverCompatibility: supported` 时必须带本轮远端 `head` 和具体 `codeEvidence`；没有验证回执时
只能写 `uncertain`，且不得把 `remainingRisks` 写成 `none`。

服务器核查 Worker 使用 Host 从唯一合格实例解析并注入的 Agent：Claude 实例使用
`claude-code`，Codex 实例使用 `codex`；模型省略并走 Host 对应 Agent 的默认路由。Lead 不得自行
选择 Agent，Host 会拒绝 Agent 与实例或注入值不一致的请求。核查采用最多 6 次只读调用内的最小充分证据，并覆盖当前原子能力矩阵
要求的直接消费者；不得自行缩成“一次搜索 + 一次读取”而制造不必要的 `uncertain`。任一剩余
原子语义有具体代码证据证明不支持时才返回 `unsupported`；如果模块图已经通过组合表达需求，
即使没有同名完整服务器函数也应返回 `supported`。不为补齐其它能力做穷尽扫描；仅在证据冲突、
读取失败或 6 次调用后仍无法判定时使用 `uncertain`。

业务平衡参数尚未由策划决定，不是服务器能力缺失。如果服务器消费者和数据函数已经证明某种
伤害、倍率、时序或条件编码可执行，Worker 应返回 `supported`，并把待定比例或数值留给 Lead 用
业务语言集中询问；不得仅因需求写了“较低伤害”“短暂”或其它相对描述就返回 `uncertain`，更
不得把它升级为程序修改阻断。只有运行时语义本身缺少代码证据或证据冲突时才使用
`uncertain`。

服务器能力报告的 `codeEvidence`、`affectedSurfaces` 必须是数组，`capabilityGap`、
`programmerAction`、`validationSuggestion` 必须是非空字符串；即使没有能力缺口也写明确字符串，
不能用 `[]` 或 `null`，否则 Host 校验会拒绝该报告并保持实施阻断。

这 6 次调用的默认顺序是 `git show HEAD:AGENTS.md`、读取 HEAD SHA、一次只包含任务精确
typ 数字/枚举名/数据函数名的 `internal/battle` 定向搜索，以及最多三次命中消费者读取。搜索中
禁止加入 `time`、`target`、`skill`、`damage`、`next`、`trigger` 或中文描述等通用词；后续
路径必须真实出现在搜索回执中，不能按目录印象猜测。空查询、重复读取 AGENTS、先读架构总览或通用生命周期文件都不属于有效预算使用；只有具体符号完全无命中时才能
转查行为注册表或相邻枚举。战斗任务同时由 Host 注入从真实 `workingDir` 解析出的
`projectRoot` 与 `unityClientRoot`，Agent 不自行拼接或猜测 `C:\Workspace\saga2` 下的其它路径。

上述阶段顺序由 Desktop Host 状态机强制执行，不只依赖角色提示词。战斗 Lead 新任务固定进入
原生计划模式；环境检查未全部通过时仍允许读取业务文件、加载 Skill、澄清和使用状态为 ready
的依赖，只在具体工具入口按依赖阻止。方案未批准时仍只允许只读文件、可证明只读的命令与 MCP
调用；方案必须包含
`[SAGA2_COMBAT_SOLUTION]` 包络及 `targetSkillId`、`changeMode`、`surfaces`、`moduleEvidence`、
`capabilityMatrix`、`evidence`、`validation`、`remainingUnknowns` 八个字段，缺字段时 Host 不展示为可批准方案。
`moduleEvidence` 必须引用 `skill-entry-model` 节点/字段或同类真实配置，`capabilityMatrix` 必须逐项
写出模块直接支持、模块组合支持或剩余服务器缺口，不能只写“存在/不存在完整函数”。方案批准只
解锁批准范围内的本地配置、Timeline、导出和客户端写入；非只读 MCPRouter 调用、未识别的 Orca
变更、批量/本地 Worker 和服务器服务管理在批准后仍永久拒绝，不能落入普通“环境复检后放行”分支。
用户通过原生方案字段不能使用“待确认”“当前选择”“unknown”等占位内容，`targetSkillId` 必须是具体 ID，
`changeMode` 只能是 `create`、`rebuild` 或 `incremental`，`surfaces` 必须包含实际实现面。方案
卡批准后，Host 在每次写文件、执行非只读命令或调用有副作用 MCP 前重新执行 P4、Unity CLI
与 MCPR 三项检查；任一失败立即退回环境恢复阶段。该拒绝优先于 Full access、会话记忆授权和
普通工具审批。

依赖级阻断必须同时承担恢复引导，适用于战斗开发和通用 Meka 角色。MCPRouter 远程工具失败时，
Main 先通过不联网的本地连接状态投影区分“未连接/认证失效/项目未绑定/Runtime 不兼容/暂不可用”，再返回
结构化 `reasonCode`、只影响当前调用的 `blockedScope`、用户动作和 `retryTool`；回执不得包含
endpoint、用户名或凭证。`diagnose_mcp_router_connection` 不联网，只读本地连接材料；旧错误缺少
结构化恢复信息时可调用一次，确认未配置后必须直接打开现有登录框。启动环境预检不得主动抢焦点
或弹登录框。具体 Router 工具真实调用失败、用户或 Agent 主动调用 `check_combat_environment`
复检，或恢复诊断确认未配置时，若本地状态确认未连接或认证失效，Host 必须自动聚焦可信 Cindy
主窗口并打开现有 MCPRouter 登录框，同时在回执中记录
`loginPromptAttempted` / `loginPromptOpened`。找不到可信窗口时才退回“设置 → Meka 助理”的手动
入口。实例未绑定时不得误弹登录框，而应继续实例列表、模板和绑定流程，直到真正需要用户选择或确认。
Agent 无法代办登录、网络和部署方升级，但必须保留进度、继续不依赖 MCPR 的本地工作，并注明
恢复后重试哪个工具。P4 失败同样先按 CLI、登录、客户端映射、文件状态和服务连接做只读诊断；
其它链路失败不得误报成 P4 故障。

服务端深度探索在直接远程项目只读能力不足，或用户明确要求独立远程执行时，才使用 MCPR Orca Worker，并与本地 Lead 状态隔离。只有任务正文同时包含
`[SAGA2_SERVER_EXPLORATION_READ_ONLY]` 与 `[SAGA2_MODULE_FIRST]` 的远端 Worker 创建或派发可通过；Worker 自身使用
`saga2-combat-server-worker-v1`，不伪造本机 P4/Unity CLI 已就绪状态，并由 Host 在方案前后
永久限制为只读。Lead 批准方案不会扩大 Worker 权限，任何服务器写入、分支、Excel、生成物或
业务/项目 MCP 调用都直接拒绝。服务器 Worker 不调用 `orca_worker_bridge.send_to_lead`；Host
对该 workflow 确定性拒绝 bridge MCP，Claude 与 Codex 都只输出唯一终态 JSON，由 Orca
auto-bridge 投递。普通 Orca Worker 仍保留原有手动回传能力。
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

Unity 操作统一通过 Meka Unity 插件提供的官方 CLI 工具 `unity_inspect`/`unity_execute`，不注册
HTTP MCP 或旧版 Unity 路由。普通任务按插件发现链使用；战斗任务中仅 `unity_inspect` 的只读动作
按只读处理，`unity_execute` 按用户明确请求执行并受 Host 范围门禁。Unity CLI 连接异常会把 Lead 状态退回环境恢复。
服务器能力报告必须调用 `mcp_router.validate_server_capability_report` 校验。报告仅证明远端
Worker 对当前 HEAD 做过只读核查，不代表实施过服务器修改；`unsupported` 或 `uncertain` 会
设置服务器实施交接阻断状态，Host 只拒绝依赖该缺口的客户端实施调用，不阻止本地探索或其它
远程只读证据。方案 `surfaces` 不得包含
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

开发来源使用 Host 派生的独立 runtime ID，以便与同 ID 正式插件共存；角色和
`ghost_call` 仍使用源码清单中的逻辑 `pluginId`。Host 在可见性、设置门和管子派发
前解析到当前开发 runtime，已安装的正式插件仍优先按原始 ID 精确匹配。该别名只存在
于运行期，不改写源码包、批准回执或发布包身份，也不要求重新安装或授权。

### 阶段 D：生产化

- RustFS 预签名直传与 finalize；
- 公开发布的敏感信息、恶意内容和包结构扫描；
- Windows 与 macOS、Light 与 Dark、四语言和真实 Router 全链手测。

### 暂不包含

- 修改 maker-core system prompt；
- 修改 `cindy-protocol`；
- 自动同步、自动更新或自动删除；
- 将市场技能自动加入 Meka 项目角色。

## 8. SAGA2 战斗任务的目标首证据顺序

SAGA2 战斗角色继续暴露 Cindy 的通用工具集合。生成、修改和检查都必须先由用户提供一个正整数
技能 ID；缺少 ID 时不得调用任何工具，
只回复“请提供要生成、修改或检查的正整数技能 ID。”。ID 绑定后只允许先读取
`combat-skill-configuration` 总控 Skill、调用 `unity_inspect(action=status)`，再通过老版模块
编辑器对目标 ID 执行 `legacy_module_export_json`。目标导出尝试之前，不得读取项目规则、客户端
源码、其它技能或服务器证据。MCP、公共 Ghost、Orca 直接工具和普通 Shell 均由 Host 的同一战斗
策略按任务上下文确定性裁决；缺少 ID、目标首证据前越序、根规则枚举、Assets 根搜索、其它
Skill、共享 JSON 和开发中编辑器关键词都会在执行前拒绝。普通角色仍保留完整通用工具行为。

战斗角色不通过 `get_workspace_info`、`ghost_info`、`ghost_list` 或 `list_tools` 重新发现 Host
已注入的路径和能力；启动门禁已经是 `ready` 时也不得立即重复
`check_combat_environment`。这些工具没有从 Cindy 或通用角色中移除，只在战斗 workflow 中被
顺序门禁拒绝。目标导出后仍禁止枚举 `AGENTS.md`、读取 `ModuleV2` 或共享
`skill_entry_model_editor.json`；项目规则只读取 Host 注入路径下已知的
`saga2_unity/AGENTS.md`，配置证据始终来自当前技能的老版编辑器导出。

目标导出后，Lead 只按 Host 注入的绝对路径分别完整读取 `saga2_unity/AGENTS.md` 和
`SkillModuleProtocolCodec.cs`。协议文件读取结束后的下一项项目动作固定为
`start_team(worker_permission_mode=auto)`；不得先搜索 `Assets/Editor/SkillEditor`、模块目录或
其它客户端目录来发现伤害、目标、数据函数或模块枚举，这些运行时语义交给当前服务器 HEAD 的
只读 Worker 核实。协议源码中的类型名、命名空间和 `using` 不构成继续搜索客户端的授权；仅当
服务器报告明确留下具体客户端消费者缺口时，才按完整路径读取一个直接消费者。

内容寻址的 Meka Skill 快照白名单同样只接受
`combat-skill-configuration/SKILL.md`。其它 Skill 的批量行数探针、完整读取和项目 Skill
扫描均失败关闭，避免提示词约束被工具调用绕开。

战斗任务在新建和恢复时，Host 还会从该任务已经冻结的内容寻址快照中取出唯一总控 Skill 正文，
以 `[SAGA2_COMBAT_CONTROLLER_SKILL]` 可信段直接注入当前消息。原生 Skill 目录和 Cindy 通用工具
仍完整保留，但 Agent 不再依赖主动读取或发现 Skill 才能获得首证据顺序。若 Codex 仍生成原生
Skill 的完整单文件读取，Host 只接受 `Get-Content '<path>'` 或
`Get-Content -Raw '<path>'`（可由固定 PowerShell `-Command` 包装）；`-First`、管道、串联、
通配符、路径穿越和其它 Skill 一律拒绝。

目标技能导出成功或取得结构化失败回执后，战斗任务仍可用 Shell 做最小客户端证据核查。
Host 静默放行 `saga2_unity` 内单个已知 C# 消费者的完整 `Get-Content`，以及带单一精确
`-Path` / `-LiteralPath` 和字面 `-Pattern` 的 `Select-String`；路径只限
`Assets/Scripts/Hot` 与老版模块协议所在的 `Assets/Editor/SkillEditor/Common`。这些等价的
PowerShell 只读形态不得因为通用审批器返回 `prompt` 而被业务门禁误报为非法 Shell。
通配符、目录枚举、其它 Skill、路径穿越、环境变量、管道、重定向、命令串联和任何写入仍须
拒绝；配置写入继续只走 Meka P4、Meka Unity 官方 CLI 和老版模块编辑器入口。

技能 ID 只由用户提供。中文自然表达中的“技能 1009”“技能ID：1009”“技能编号 1009”以及
“1009技能”都视为明确标注；其它未与“技能”明确绑定的数字仍不得猜作 ID。首轮缺少 ID 时固定零工具追问；用户在追问后只回复一个正整数，也视为
明确绑定，不要求重复“技能 ID”标签。伤害、时长、次数等混在业务描述中的未标注数字仍不得被
猜作 ID。若同一任务后续明确切换到另一个唯一技能 ID，Host 必须清空旧目标的导出尝试、导出完成、
方案批准和服务器能力状态，要求新目标重新完成老版导出与服务器核查；旧目标的状态不能作为新目标证据。

用户绑定技能 ID 后，Host 同时解析当前 SAGA2 项目唯一的 capability-ready 服务器实例，并以
`[SAGA2_COMBAT_SERVER_TARGET]` 注入真实 `serverRemoteHostId` 与 `serverWorkerAgent`。战斗 Lead
创建 Worker 时只能分别原样使用这两个值，不能调用 `get_workspace_info`、按项目名拼
`mcpr:saga2` 或自行选择 Agent；无唯一目标时按服务器证据不可用停止实施。这些字段只帮助模型
正确路由，不是授权：Host 在 `create_worker` 前仍重新核对项目绑定、在线状态、服务器身份、
Agent 类型和 capability hello。
