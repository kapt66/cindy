# MCPRouter 远程项目会话

## 用户流程

新建任务草稿的一级位置菜单固定提供“本机”和“MCPR远程”两个渠道（有已配对设备时继续列出设备渠道，MCPR紧跟本机之后）。MCPR 未连接时仍保留该渠道，进入二级项目菜单后只显示“连接 MCPRouter”入口；连接动作直接打开与设置页共用的 MCPRouter 连接窗口，不离开当前草稿，也不新增凭证处理流程。未选定 MCPR 实例时，右侧项目胶囊使用“选择项目”占位，不使用“MCPR远程”或“对话”作为项目值。已连接 MCPRouter 的 Cindy 桌面端在“MCPR远程”渠道的二级项目选择器中展示当前账号可用的远程项目实例。用户选择实例后，草稿保存经 Host 校验过的 `remoteHostId` 与虚拟 `workingDir`，并清除本机目录、设备互联目标、附加目录和路径型附件；首条消息仍由正常的新建任务流程创建。

当账号有可访问的远程项目模板时，选择器同时提供“从模板创建远程实例”。弹窗要求选择模板和实例名称，名称遵守 MCPRouter 的 `[A-Za-z0-9][A-Za-z0-9._-]{1,63}` 规则。创建请求只传模板 ID 和名称，不向 Renderer 暴露凭证或远端物理路径。创建成功后刷新实例列表并自动选中返回的实例；取消、鉴权失败、网络失败或实例不可用时保留原草稿目标。

## MCPRouter 连接与注册

设置页和新建任务草稿共用同一个 MCPRouter 连接窗口。窗口打开时必须显示用途说明，并提供
Router URL、账号和密码输入；Tab 在窗口内按交互控件顺序移动焦点，不受应用级 Tab 拦截影响。
底部左侧提供“注册”文本按钮，右侧保持“取消”和主操作按钮；进入注册模式后增加确认密码，
左侧动作切换为“返回登录”，主操作切换为“注册并连接”。

注册由 Main 进程调用 MCPRouter `/api/auth/register`。服务端注册成功返回的 session 直接进入
与登录相同的 client key 初始化、MekaDesign 路由发现和 OS 加密凭证保存流程，不再次发送登录
请求。Renderer 只传递本次表单值，不读取 session cookie、client key 或已保存密码；注册失败、
密码不一致或凭证保存失败时保持窗口打开并显示错误。

当前 MCPRouter Host 把 `agentType=claude` 或 `agentType=codex` 且状态为 `ready`、`running` 或
`online` 的实例投影为可用目标。选择远程实例时，新建任务引擎按实例的 `agentType` 收敛到
Claude（`cc`）或 Codex（`codex`）；其它 Agent 类型保留在服务端，但不出现在新建任务选择器中。
实例身份使用服务端稳定 `id`，`instanceId` 仅用于显示。

## 安全与兼容边界

- Renderer 只消费 Host 投影的实例 ID、显示名和虚拟工作区引用；Main 在创建会话和建立隧道时再次校验实例归属、绑定关系、支持状态和可用状态。
- MCPRouter session cookie 继续只存放在 Host/OS 加密存储中；模板创建复用现有 `meka-settings:router:create-instance` IPC。
- 登录和注册分别使用 `meka-settings:router:connect` 与 `meka-settings:router:register` IPC，二者在 Main 内共用连接收尾流程，不能在 Renderer 复制凭证持久化逻辑。
- 远程目标不支持本机 worktree、路径型附件或本机 extra dirs；图片附件仍可按现有缓存交接规则发送。
- device-link 与 MCPRouter 目标互斥。手机版和 device-link 控制端不新增 MCPRouter API；它们继续通过被控桌面的既有流程工作。

## 验收标准

1. 未连接 MCPRouter 时仍可从一级“MCPR远程”渠道进入二级菜单，并看到“连接 MCPRouter”；本地项目和对话列表不出现 MCPR 实例。
2. 进入“MCPR远程”渠道后，二级菜单只显示一次“MCPR远程项目”标题和连接/实例/模板选项，不显示“对话”；位置渠道由左侧位置菜单独立切换，切回“本机”后再按本机项目菜单的统一逻辑选择对话。该菜单不显示本地项目、“选择其他项目文件夹”或添加其它远程项目入口。
3. 选择可用实例后，草稿显示远程项目标签，切换到对话会清除该远程目标。
4. 模板创建弹窗校验名称，提交期间禁止重复提交；成功后自动选中新实例并关闭弹窗，失败时显示错误且原目标不变。
5. 新建任务首条消息使用所选实例的 `remoteHostId` 和虚拟 `workingDir`；服务端拒绝伪造或失效实例。
6. Codex MCPRouter 任务通过专用 `codex-appserver` tunnel 和 AI Gateway 路由启动，不得进入 SSH host pool。
7. 远端 Codex runtime 低于 `0.145.0` 时显示可操作的升级错误；不通过关闭 capability routing 来绕过版本门禁。
8. 连接窗口显示完整标题和说明；Tab 可依次进入输入与按钮，登录/注册可双向切换，注册成功后窗口关闭且 MCPRouter 立即处于已连接状态。
