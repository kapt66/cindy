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
