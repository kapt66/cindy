# MCPRouter 远程项目会话

## 用户流程

已连接 MCPRouter 的 Cindy 桌面端在新建任务的“项目”选择器中展示当前账号可用的远程项目实例。用户选择实例后，草稿保存经 Host 校验过的 `remoteHostId` 与虚拟 `workingDir`，并清除本机目录、设备互联目标、附加目录和路径型附件；首条消息仍由正常的新建任务流程创建。

当账号有可访问的远程项目模板时，选择器同时提供“从模板创建远程实例”。弹窗要求选择模板和实例名称，名称遵守 MCPRouter 的 `[A-Za-z0-9][A-Za-z0-9._-]{1,63}` 规则。创建请求只传模板 ID 和名称，不向 Renderer 暴露凭证或远端物理路径。创建成功后刷新实例列表并自动选中返回的实例；取消、鉴权失败、网络失败或实例不可用时保留原草稿目标。

当前 MCPRouter Host 把 `agentType=claude` 或 `agentType=codex` 且状态为 `ready`、`running` 或
`online` 的实例投影为可用目标。选择远程实例时，新建任务引擎按实例的 `agentType` 收敛到
Claude（`cc`）或 Codex（`codex`）；其它 Agent 类型保留在服务端，但不出现在新建任务选择器中。
实例身份使用服务端稳定 `id`，`instanceId` 仅用于显示。

## 安全与兼容边界

- Renderer 只消费 Host 投影的实例 ID、显示名和虚拟工作区引用；Main 在创建会话和建立隧道时再次校验实例归属、绑定关系、支持状态和可用状态。
- MCPRouter session cookie 继续只存放在 Host/OS 加密存储中；模板创建复用现有 `meka-settings:router:create-instance` IPC。
- 远程目标不支持本机 worktree、路径型附件或本机 extra dirs；图片附件仍可按现有缓存交接规则发送。
- device-link 与 MCPRouter 目标互斥。手机版和 device-link 控制端不新增 MCPRouter API；它们继续通过被控桌面的既有流程工作。

## 验收标准

1. 未连接 MCPRouter 或没有可用实例/模板时，选择器不显示远程区，不影响本地项目和对话。
2. 选择可用实例后，草稿显示远程项目标签，切换到对话会清除该远程目标。
3. 模板创建弹窗校验名称，提交期间禁止重复提交；成功后自动选中新实例并关闭弹窗，失败时显示错误且原目标不变。
4. 新建任务首条消息使用所选实例的 `remoteHostId` 和虚拟 `workingDir`；服务端拒绝伪造或失效实例。
5. Codex MCPRouter 任务通过专用 `codex-appserver` tunnel 和 AI Gateway 路由启动，不得进入 SSH host pool。
6. 远端 Codex runtime 低于 `0.145.0` 时显示可操作的升级错误；不通过关闭 capability routing 来绕过版本门禁。
