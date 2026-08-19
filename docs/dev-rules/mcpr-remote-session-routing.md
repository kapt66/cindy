# MCPRouter 远程任务路由契约

> **状态**：权威开发规则（authoritative）
> **读取时机**：修改 Desktop 远程任务启动、恢复、SSH preflight、MCPRouter tunnel 或
> `remoteHostId` 处理时。

## 1. 两种远程身份

`remoteHostId` 不是统一的 SSH 主机名字段，而是两种 transport 身份的联合：

- `mcpr:<instance-id>`：MCPRouter 账号隧道的逻辑实例身份。这里的值必须是服务端实例记录的
  稳定 `id`（不是可变的显示/业务名称 `instanceId`）。`routerService.normalizeInstance()`
  用同一个 `id` 构造 `remoteHostId`，MCPRouter bridge 查询也必须按 `instance.id` 匹配；两处
  不得混用，否则实例列表明明存在仍会报 `MCPR_INSTANCE_NOT_READY`。分类器按
  `MCPR_REMOTE_HOST_PREFIX` 识别，具体实例值再由 `parseMcprRemoteHostId` 校验；它必须
  进入 `openMcprTunnel`、`remoteCcQueryFactory` 或 `createMcprCodexTransport`，不能查 SSH
  pool。即使值是不完整的 `mcpr:`，也不能降级成 SSH host。
- 其它非空值：SSH Remote 的 host id，才允许进入 `ensureRemoteHostReady`、
  `ensureRemoteAgentInstalledOrInstall`、`getRemoteSshPool().get` 以及 SSH MCP bridge
  的注入/恢复逻辑。

空值表示本地任务，不进入任一远程 preflight。

## 2. 启动与恢复不变量

所有会话创建、lazy resume、send 前置和 Main 发起的 Worker bootstrap 都必须先完成
transport 分类，再执行 transport 专属动作。MCPRouter 会话不得因为“远程”这个共同字段
而经过 SSH preflight；恢复路径也必须在进入 SSH pool 前过滤 `mcpr:`。

`apps/desktop/src/main/maker-host/remote-session-routing.ts` 是分类的唯一纯函数入口。新增
远程路径时复用 `classifyRemoteSessionTransport`，不要复制 `startsWith('mcpr:')` 或直接
把 `remoteHostId` 传给 SSH API。

## 3. 合并防回归

同步 `origin/main` 到 `meka/main` 时，冲突解决必须逐项核对上述不变量。特别检查：

1. `register.ts` 的 MCPRouter guard 仍位于 `ensureRemoteHostReady` 之前；
2. `maker-host/index.ts` 的 Claude/Codex transport factory 仍保留 MCPRouter 分支；
3. bridge shutdown、turn-settled、bridge-recreate 等 SSH-only recovery 不会把
   `mcpr:<instanceId>` 放入 SSH pool；
4. 运行 `remote-session-routing` 与 `remoteSessionMakerMemory` 回归测试，并检查最终
   合并结果，而不是只检查某一个父提交。

这条契约源自 2026-08-04 的回归：`4d1e01b7f` 合并 `origin/main` 时，第一父提交已有的
MCPRouter preflight 分支被上游版本覆盖，最终把 `mcpr:<id>` 送进 SSH pool，产生
`SSH_HOST_NOT_FOUND`。

2026-08-05 又发现一类独立回归：MCPRouter 返回的 `id` 与 `instanceId` 不同时，Codex
bridge 曾按后者查找，而 `remoteHostId` 按前者构造；同时实例规范化只把 `claude` 标成
supported，导致合法 Codex 实例在 bootstrap 阶段被误报为不可用。修复要求：`id` 是唯一
transport 身份，`agentType` 为 `claude` 或 `codex` 时才进入支持判断，UI/Main 的 Agent
选择与实例类型保持一致。

## 4. 远端运行时版本门禁

- Claude 的 MCPRouter/SSH cc-mgr `protocol/hello` 必须携带
  `CC_MGR_BUNDLE_VERSION`。客户端可以兼容旧 daemon 不回显 bundle 字段，但不能省略请求
  参数；否则新版本 daemon 会返回 `[INVALID_PARAMS] bundleVersion is required (string)`。
- 当前 bundle `0.0.7` 的 daemon 自报最高 protocol `3`，并按连接协商版本隔离能力：protocol
  `2` 保留 Claude query/session 与 host `toolGuards`；protocol `3` 才开放 immutable
  bundle、Codex revision/thread routing 和 tunneled MCP。manager version 相同但 protocol
  不同同样属于不可部署的 pin mismatch，MCPRouter 构建期和 tunnel 启动前都必须阻断。
- `0.0.7/protocol 3` 的 immutable bundle 文件可二选一携带 UTF-8 `content` 或规范
  `contentBase64`；后者用于完整投递角色 Skill 的脚本、引用和二进制资产。daemon 必须先解码、
  校验规范 base64 与文件 SHA-256，再原子物化。Desktop 使用任务快照的 revision 和原始字节，
  不在远端重建 `SKILL.md`。
- MCPRouter 角色 Skill 启动先 `bundle/ensure`、再注册 revision，然后把返回的远端 plugin
  路径交给 Claude/Codex 原生加载；会话关闭、启动失败或 revision 替换时成对 release。
  恢复必须继续使用任务绑定的原 revision。空选择仍冻结任务绑定，但不投递空 bundle；普通
  SSH 没有这条投影契约，仅在快照实际含 Meka 角色 Skill 时明确失败，不能把正文退化为
  prompt。
- Codex capability routing 依赖 app-server `0.145.0` 引入的协议能力。远程
  `codex-appserver` tunnel 使用 MCPRouter 打包的 Codex 可执行文件；当远端版本低于
  `0.145.0` 时必须 fail closed 并提示升级 MCPRouter runtime，不得为了让会话启动而关闭
  capability routing。

这条版本契约源自 2026-08-05 的两次现场错误：Claude 握手漏传 bundleVersion，以及
MCPRouter Worker 使用 `cindy/0.144.1` Codex runtime。

同日第三次现场错误暴露了 bundle 只校验 manager version 的漏洞：当时 MCPRouter 期待
`0.0.6/protocol 3`，实际镜像仍携带 Cindy 迁移初期的 `0.0.6/protocol 2`。因此不得只 bump
字符串版本；Cindy 的 `maker-cc-manager` 是 bundle 源码真源，MCPRouter 完整版必须通过
`build:cc-mgr-bundle` 重新构建并探测 pin；按需 runtime manifest/cache 链路校验 Codex
最低版本。部署后还必须重启 runtime。
