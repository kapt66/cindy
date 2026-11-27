import { CONTRIBUTION_ERROR_CODES } from './pluginContributionContract';
import { WRITABLE_DIRECTORY_GRANT_ERROR_CODES } from './writableDirectoryGrantError';
import { BROWSER_OPEN_FOR_LOGIN_ERROR_CODES } from './browserBackend';

/** main / preload / renderer 共用的 IPC 错误类型。 */

// Local companion-import errors. Remote Resource keeps its existing wire codes.
export const COMPANION_IMPORT_ERROR_CODES = [
  'AUTOMATION_CANCELLED',
  'AUTOMATION_COMMAND_FAILED',
  'AUTOMATION_DATA_READ_FAILED',
  'AUTOMATION_DEPENDENCY_NOT_SELECTED',
  'AUTOMATION_HANDOVER_REQUIRED',
  'AUTOMATION_NOT_FOUND',
  'AUTOMATION_OUTPUT_TOO_LARGE',
  'AUTOMATION_SCRIPT_MISSING',
  'AUTOMATION_TIMEOUT',
  'AUTOMATION_TIME_PASSED',
  'COMPANION_DELETED',
  'CONNECTION_CANCELLED',
  'CONNECTION_FAILED',
  'CONNECTION_LIMIT',
  'CONNECTION_TIMEOUT',
  'CREDENTIAL_STORAGE_FAILED',
  'CREDENTIAL_STORAGE_INVALID',
  'CREDENTIAL_STORAGE_UNAVAILABLE',
  'DELIVERY_CREDENTIAL_MISSING',
  'DELIVERY_FAILED',
  'DELIVERY_NOT_VERIFIED',
  'IMPORT_CALLER_UNAVAILABLE',
  'IMPORT_CANCELLED',
  'IMPORT_FAILED',
  'IMPORT_NAME_EXISTS',
  'INVALID_COMPANION',
  'INVALID_REQUEST',
  'INVALID_PACKAGE',
  'INVALID_SELECTION',
  'INVALID_TARGET',
  'OWNER_CHANGED',
  'PREVIEW_EXPIRED',
  'PROFILE_TEXT_TOO_LARGE',
  'REQUEST_ALREADY_USED',
  'SELECTION_CHANGED',
  'SOURCE_AGENT_INVALID',
  'SOURCE_AUTOMATIONS_INVALID',
  'SOURCE_AUTOMATION_CHANGED',
  'SOURCE_AUTOMATION_INVALID',
  'SOURCE_AUTOMATION_RUNNING',
  'SOURCE_CHANGED',
  'SOURCE_COMMAND_UNAVAILABLE',
  'SOURCE_CONFIG_INCLUDE_CYCLE',
  'SOURCE_CONFIG_INVALID',
  'SOURCE_CREDENTIAL_INVALID',
  'SOURCE_DATABASE_UNAVAILABLE',
  'SOURCE_DATABASE_DRIVER_UNAVAILABLE',
  'SOURCE_DATABASE_TOO_LARGE',
  'SOURCE_DATABASE_INVALID',
  'SOURCE_FILE_TOO_LARGE',
  'SOURCE_HANDOVER_COMMAND_FAILED',
  'SOURCE_HANDOVER_NOT_CONFIRMED',
  'SOURCE_HANDOVER_PENDING',
  'SOURCE_HANDOVER_UNCERTAIN',
  'SOURCE_ITEM_TOO_LARGE',
  'SOURCE_LINK_CYCLE',
  'SOURCE_LINK_OUTSIDE_FOLDER',
  'SOURCE_NOT_REGULAR_FILE',
  'SOURCE_SNAPSHOT_TOO_LARGE',
  'SOURCE_TOO_MANY_FILES',
  'SOURCE_TOO_MANY_ITEMS',
  'TARGET_AUTOMATION_CHANGED',
  'TARGET_HANDOVER_UNCERTAIN',
] as const;

/**
 * MCPRouter 读取／发布链(如 `meka-dev-plugins:upload-info`、`meka-dev-plugins:upload`)
 * 的可区分失败原因。
 *
 * 这些原因的下一步动作互不相同(重新连接／升级 MCPRouter／检查网络／提升版本号／稍后重试),
 * 所以不能合并成一句泛化文案;集中定义在这里,Main 只抛码、Renderer 只按码选文案。
 */
export const MEKA_ROUTER_ERROR_CODES = [
  /** 未配置,或本地保存的地址／session／client key 不完整。 */
  'MEKA_ROUTER_NOT_CONFIGURED',
  /** session 过期或该账号没有权限(HTTP 401／403)。 */
  'MEKA_ROUTER_SESSION_EXPIRED',
  /** 当前 MCPRouter 版本没有这个管理接口(HTTP 404／405)。 */
  'MEKA_ROUTER_ENDPOINT_UNSUPPORTED',
  /** 网络不可达、连接被拒绝或请求超时。 */
  'MEKA_ROUTER_UNREACHABLE',
  /** 接口有响应,但回包形状不是本客户端认识的结构。 */
  'MEKA_ROUTER_RESPONSE_INVALID',
  /**
   * 要发布的版本不高于线上已发布的版本。MCPRouter 的 Release 不可覆盖,
   * 这类请求必然失败,Main 在发起上传**之前**就拒绝(2026-11-18)。
   */
  'MEKA_ROUTER_VERSION_NOT_NEWER',
  /**
   * 服务端仍以「该版本已发布」拒绝(409 already published)。正常路径已被
   * `MEKA_ROUTER_VERSION_NOT_NEWER` 前置拦住,这条只剩并发窗口:用户看预览后,
   * 该版本被另一处发布。
   */
  'MEKA_ROUTER_VERSION_ALREADY_PUBLISHED',
] as const;

export type MekaRouterErrorCode = (typeof MEKA_ROUTER_ERROR_CODES)[number];

/**
 * 把「码数组」折叠成 IPC 码表项：保留字面量键（`keyof` 才能派生联合类型），值恒为 `true`。
 *
 * 域的码集合仍在各自模块里（一个码一个来源），这里只把它们并进唯一的 IPC 表。
 */
function ipcCodeEntries<const T extends readonly string[]>(
  codes: T,
): { readonly [K in T[number]]: true } {
  const table: Partial<Record<string, true>> = {};
  for (const code of codes) table[code] = true;
  return table as { readonly [K in T[number]]: true };
}

/**
 * IPC 错误码**单表**（main / preload / renderer 共用）。
 *
 * ## 为什么只有一张表
 *
 * 跨进程错误只有 `Error.message` 能过 IPC（`code` 字段会丢，见
 * `docs/dev-rules/engineering-conventions.md` §2），所以 `[CODE] message` 里的码名就是
 * **协议**：main 抛的码名必须在渲染层被认出（`extractIpcError` → `isIpcErrorCode`），否则
 * 渲染层只能回落到「操作失败」并可能把英文 IPC 原文直接显示给用户。
 *
 * 历史上这里是两份手写清单（`IpcErrorCode` union + `IPC_ERROR_CODES` Set），漏改一处没有
 * 任何编译错误，只在运行期静默降级。现在**类型与运行时白名单同源**：
 *
 *   - 表（本对象）是唯一手写处；`IpcErrorCode = keyof typeof IPC_ERROR_CODES` 由它派生；
 *   - `isIpcErrorCode` 查同一张表，因此「类型允许」与「运行期认出」不可能再漂移；
 *   - 外部域码集合（插件贡献 / 伴侣导入 / 可写目录授权 / MekaRouter / 浏览器登录）由各自模块
 *     的数组折叠进来（`ipcCodeEntries`），新增一个码只改那个数组，两边一起生效。
 *
 * 新增码时：在对应分组里加一行 `CODE: true,`。值恒为 `true`；表只表达「这个码存在」。
 *
 * 上报错误码已移除（Meka divergence，第 5 轮同步后移除）：上游此处定义
 * LOG_UPLOAD_UNAVAILABLE / PRIVACY_CONSENT_REQUIRED / LOG_UPLOAD_EMPTY / LOG_UPLOAD_FAILED / LOG_UPLOAD_BUSY。
 */
const IPC_ERROR_CODES = {
  SUBSCRIPTION_LOGIN_CANCELLED: true,
  SUBSCRIPTION_ACCOUNT_FAILED: true,
  SUBSCRIPTION_CODEX_PROVIDER_AUTH: true,
  SUBSCRIPTION_CLAUDE_ACCOUNT_MISMATCH: true,
  SUBSCRIPTION_CLAUDE_IDENTITY_UNKNOWN: true,
  ...ipcCodeEntries(WRITABLE_DIRECTORY_GRANT_ERROR_CODES),
  ...ipcCodeEntries(CONTRIBUTION_ERROR_CODES),
  ...ipcCodeEntries(COMPANION_IMPORT_ERROR_CODES),
  // 通用错误
  INVALID_PARAMS: true,
  NOT_FOUND: true,
  INTERNAL: true,
  ALREADY_EXISTS: true,
  PRECONDITION_FAILED: true,
  OFFICIAL_PLUGIN_GITHUB_REQUIRED: true, // 客户端提审限制，不扩展服务端 wire 错误
  VOICE_SPEECH_TIMEOUT: true, // 本机语音合成等待响应或音频读取超时
  VOICE_CONVERSATION_BUSY: true, // 本机已有语音通话、朗读、试听或听写占用麦克风
  PROVIDER_GROUP_CHANGED: true, // 编辑期间组设置已变化，拒绝覆盖，需重新读取
  SHARE_NOT_CONFIGURED: true,
  SHARE_UNAVAILABLE: true,
  SHARE_READ_FAILED: true,
  HTML_PREVIEW_TOO_LARGE: true,
  PROVIDER_IMPORT_FILE_TOO_LARGE: true,
  PROVIDER_IMPORT_FILE_INVALID: true,
  PROVIDER_IMPORT_FILE_READ_FAILED: true,
  HTML_PREVIEW_UNSUPPORTED: true,
  // 本地模型切换窗口保护的可行动失败原因。device-link 继续降级为
  // PRECONDITION_FAILED，避免把新增 Electron IPC code 变成跨版本 wire 契约。
  MODEL_CONTEXT_USAGE_UNKNOWN: true,
  MODEL_VISIBILITY_NOT_READY: true,
  BOT_CREATION_MODEL_UNAVAILABLE: true,
  MODEL_WINDOW_CURRENT_CONTEXT_UNKNOWN: true,
  MODEL_WINDOW_TARGET_CONTEXT_UNKNOWN: true,
  MODEL_WINDOW_REMOTE_REBUILD_UNSUPPORTED: true,
  MODEL_WINDOW_PROTECTION_UNAVAILABLE: true,
  MODEL_SWITCH_TASK_RUNNING: true,
  MODEL_WINDOW_PREPARATION_IN_PROGRESS: true,
  // 远程 Agent 选择准入(选模型时目标电脑不可达 / 目录里没有)。device-link 同样降级为
  // PRECONDITION_FAILED，只在本机窗口给可行动的说明。
  REMOTE_AGENT_DEVICE_UNREACHABLE: true,
  REMOTE_AGENT_MODEL_UNAVAILABLE: true,
  MAKER_MEMORY_NOT_READY: true,
  SCHEDULER_NOT_READY: true,
  PERMISSION_DENIED: true,
  ...ipcCodeEntries(MEKA_ROUTER_ERROR_CODES),
  UNSUPPORTED_CAPABILITY: true,
  SSH_HARNESS_SWITCH_UNSUPPORTED: true,
  MODEL_SELECTION_UNAVAILABLE: true,
  HARNESS_SWITCH_NOT_READY: true,
  SHARED_TASK_HOST_LIMIT: true,
  SHARED_TASK_JOIN_LIMIT: true,
  SHARED_TASK_GUEST_LIMIT: true,
  SHARED_TASK_SELF_JOIN: true,
  // 供应商分享(docs/provider-sharing-contract.md §3.3)
  PROVIDER_SHARE_LINK_USED: true,
  PROVIDER_SHARE_LINK_EXPIRED: true,
  PROVIDER_SHARE_SELF: true,
  PROVIDER_SHARE_ALREADY_MEMBER: true,
  PROVIDER_SHARE_IDENTITY_INVALID: true,
  PROVIDER_SHARE_NOT_HOST_DEVICE: true,
  PROVIDER_SHARE_CROSS_REGION_DISABLED: true,
  REMOTE_AGENT_SHARE_PAUSED: true,
  REMOTE_AGENT_SHARE_REMOVED: true,
  REMOTE_AGENT_SHARE_UNAVAILABLE: true,
  REMOTE_AGENT_SHARE_LEGACY_DISABLED: true,
  APP_SHORTCUTS_WRITE_FAILED: true,
  NO_ACTIVE_TURN: true,
  SESSION_RUNNING: true,
  // 共享 codex 进程要切凭证形态但有其它本地会话在忙(可能等很久)。与 SESSION_RUNNING
  // 分开:后者是"本会话在跑"的短时状态;混用会让「新建会话/切模型」场景弹出误导性的
  // "会话运行中"文案(实际是别的会话挡住了凭证切换)。
  CREDENTIAL_SWITCH_BUSY: true,
  // Pi 热切 SuperGrok 时 switch_session 未确认，任务已终止。
  PI_CATALOG_RELOAD_UNCONFIRMED: true,
  // 远端 Claude 路由 materialization 失败(remote-claude-route.ts):
  // 供应商凭证 mutation 窗口(稍后重试)/ 远端不可表达(换来源)/ 订阅未连接(连接 Claude.ai)。
  REMOTE_PROVIDER_UPDATING: true,
  REMOTE_PROVIDER_UNSUPPORTED: true,
  REMOTE_NATIVE_OAUTH_UNAVAILABLE: true,
  // 工作区 .claude 设置会改写 Claude 订阅会话的上游 / 鉴权 / TLS 信任(workspace-settings-guard),
  // 拒绝启动订阅会话。
  CLAUDE_SUBSCRIPTION_WORKSPACE_OVERRIDE: true,
  // 远端 Pi 会话启动时 Cindy AI gateway endpoint 未就绪(登录后自动下发):
  // renderer 走 logic.errors.remoteError.REMOTE_GATEWAY_ENDPOINT_UNAVAILABLE。
  REMOTE_GATEWAY_ENDPOINT_UNAVAILABLE: true,
  // 远端 Pi 会话选了 baseUrl 指向本机 loopback 的 BYOM provider(Ollama 等):
  // 远端进程连不到本机服务, 创建时拒绝并引导换网关/远端可达 BYOM。
  REMOTE_LOCAL_ONLY_PROVIDER: true,
  // 本机托管 Ollama sidecar 尚未就绪:引导去设置 → 模型供应商 → Ollama。
  LOCAL_OLLAMA_NOT_READY: true,
  // 远端切模/切来源需要不同路由(claude-code setModel 守卫):提示重建会话。
  REMOTE_MODEL_SWITCH_ROUTE_CHANGE: true,
  // 注:MCPRouter 远端会话曾有一个引擎级静态拒绝 `MCPR_AGENT_UNSUPPORTED`(Pi 不得进入
  // `mcpr:`)。2026-10-09 起 Pi 也由 `mode=pi` 隧道承载,该码连同它的可操作文案一并删除
  // (见 `docs/dev-rules/pi-harness.md`「MCPRouter 远端(MCPR)」);Pi 远端能力的**能力级**
  // 缺失不再占用 IPC 码,而是由 `maker-host` 抛出带 marker 的错误文本诊断。
  NO_LIVE_QUERY: true,
  // Meka project / role registry
  MEKA_PROJECT_NOT_FOUND: true,
  MEKA_ROLE_NOT_FOUND: true,
  MEKA_PROJECT_IN_USE: true,
  MEKA_ROLE_IN_USE: true,
  MEKA_ROLE_REQUIRED: true,
  MEKA_BUILTIN_READ_ONLY: true,
  MEKA_PROJECT_MOVE_UNSUPPORTED: true,
  // 已保存账号切换 / 同步 / 新增账号。保留 auth 业务码跨 Electron IPC，
  // renderer 才能区分重新登录、区域不匹配与本地凭证库故障。
  INVALID_AUTH_ACTION: true,
  PASSIVE_AUTH_MUTATION_BLOCKED: true,
  ACCOUNT_NOT_FOUND: true,
  ACCOUNT_REAUTH_REQUIRED: true,
  REGION_MISMATCH: true,
  CREDENTIAL_STORE_UNAVAILABLE: true,
  AUTH_FLOW_SUPERSEDED: true,
  // 新电脑设置(docs/product-rules/new-device-setup-migration.md):那台电脑版本过旧 / 现在读不到 /
  // 回包不合法 / 预览已过期(换号、超时或另一次预览)。
  SETUP_SOURCE_OUTDATED: true,
  SETUP_SOURCE_UNAVAILABLE: true,
  SETUP_SNAPSHOT_INVALID: true,
  SETUP_PLAN_EXPIRED: true,
  // domain-specific
  STALE_DIFF: true,
  PUSH_LEASE_EXPIRED: true,
  PUSH_NO_REMOTE: true,
  MARK_DONE_FAILED: true,
  SOURCE_NEVER_RAN: true,
  NO_PRIOR_ASSISTANT: true,
  CODEX_FORK_STATE_UNAVAILABLE: true,
  FORK_UNSUPPORTED_HISTORY: true,
  REWIND_GIT_CONFLICT: true,
  REWIND_GIT_FAILED: true,
  REWIND_UNSUPPORTED_HISTORY: true,
  REWIND_TARGET_NOT_LATEST: true,
  TURN_CHANGE_GIT_UNAVAILABLE: true,
  // multi-worker
  DUPLICATE_LABEL: true,
  WORKER_CREATION_IN_PROGRESS: true,
  WORKER_LIMIT_HARD_EXCEEDED: true,
  WORKER_NOT_FOUND: true,
  ALREADY_IDLE: true,
  WORKER_STATE_CHANGED: true,
  BUDGET_MODEL_REQUIRES_API_MODE: true,
  NO_PROVIDER_FOR_AGENT: true,
  PROVIDER_ROUTE_UNAVAILABLE: true,
  // AI 重新命名：仅暴露用户可以采取明确行动的失败原因。
  TITLE_NO_MATERIAL: true,
  TITLE_PROVIDER_UNSUPPORTED: true,
  // 会话内 /goal
  GOAL_ALREADY_ACTIVE: true,
  GOAL_NOT_FOUND: true,
  // /learn 蒸馏(learn-host)
  LEARN_BUSY: true, // 已有 learn run 在进行(全局并发 1)
  LEARN_INVALID_STATE: true, // run 状态不允许该操作(如对非 awaiting-review 调 apply)
  // remote-ssh：连接阶段
  SSH_HOST_KEY_MISMATCH: true,
  SSH_CONNECT_FAILED: true,
  SSH_AUTH_FAILED: true,
  SSH_CONFIG_IO_FAILED: true,
  SSH_CONFIG_CONCURRENT_MODIFICATION: true,
  SSH_CONFIG_OWNERSHIP_REQUIRED: true,
  SSH_CONFIG_RELOAD_REQUIRED: true,
  SSH_CONFIG_AUTH_UNSUPPORTED: true,
  SSH_AGENT_UNAVAILABLE: true,
  SSH_HOST_PREFS_WRITE_FAILED: true,
  SSH_HOST_NOT_FOUND: true,
  // remote-ssh：配置的私钥文件在磁盘上不存在/不可读。与 SSH_CONNECT_FAILED 分开——
  // 这是本机路径问题（缺失 / ~ 未展开 / 路径被改写），不是网络或服务器错误，renderer
  // 据此显示明确的路径错误并允许重新选择密钥 / 编辑主机。
  SSH_KEY_FILE_NOT_FOUND: true,
  // remote-ssh：远端 agent 阶段
  SSH_NOT_CONNECTED: true,
  SSH_INSTALL_FAILED: true,
  SSH_EXEC_FAILED: true,
  SSH_AGENT_NOT_INSTALLED: true,
  // remote-ssh：项目选择器远端目录列表
  SSH_REMOTE_LS_FAILED: true,
  // remote-ssh:file-service(SSH 远程会话的文件浏览 daemon)不可用——
  // 连接失败 / 安装失败 / daemon 版本无法对齐 / RPC 通道断开
  REMOTE_FS_UNAVAILABLE: true,
  // hook-control: 连接未处于 connected 状态(Slack 绑定发起/解除要求在线)
  HOOK_NOT_CONNECTED: true,
  // hook-control: 目录偏好读写往返超时 —— server 大概率是不认识 prefs.* 帧的
  // 旧版本(丢帧不应答), 也可能是卡死; renderer 据此显示"服务器版本过旧"
  HOOK_PREFS_TIMEOUT: true,
  // hook-control: server 未宣告 multi-team 能力(多 workspace 绑定操作不可用;
  // renderer 本就按 serverMultiTeam 隐藏入口, 本码是防御性兜底)
  HOOK_MULTI_TEAM_UNSUPPORTED: true,
  // 本机文件系统浏览(项目选择器；device-link 经隧道在被控端执行)
  FS_BROWSE_FAILED: true,
  // device-link(跨设备远程控制)
  DEVICE_LINK_UNAVAILABLE: true, // relay 不可达 / server 未启用该功能
  DEVICE_LINK_NOT_CONNECTED: true, // 本机尚未连上 relay(未登录 / 断线中)
  DEVICE_LINK_BUSY: true, // 请求队列繁忙，连接仍可能正常
  DEVICE_LINK_STANDBY: true, // 本实例处于单持有者仲裁的被动态(同机另一实例持有 relay 连接)
  DEVICE_LINK_DEVICE_OFFLINE: true, // 目标设备离线
  DEVICE_LINK_REMOTE_DISABLED: true, // 目标设备「允许被控」开关关闭
  DEVICE_LINK_CHANNEL_NOT_ALLOWED: true, // channel 不在远程白名单
  DEVICE_LINK_ACCESS_REVOKED: true, // 目标设备已撤销本机的访问权限(逐设备黑名单)
  DEVICE_LINK_CONTROL_DISABLED: true, // 本机已关闭对该目标设备的控制(控制端本地偏好)
  DEVICE_LINK_TIMEOUT: true, // 等待远端响应超时
  DEVICE_LINK_DEVICE_UNRESPONSIVE: true, // 目标设备连续超时被熔断判定无响应(弱网 / 对端卡死),快速失败中
  DEVICE_LINK_VERSION_MISMATCH: true, // 两端协议/版本不匹配
  DEVICE_LINK_MEDIA_TRANSFER_FAILED: true, // 远程媒体经 OSS 中转失败(出方向附件上传 / 入方向取媒体)
  DEVICE_LINK_MEDIA_ACCESS_DENIED: true, // 控制端源附件不可读，需重新添加可访问的副本
  REMOTE_WORKDIR_INVALID: true, // 被控端工作目录路径非法
  REMOTE_WORKDIR_NOT_FOUND: true, // 被控端工作目录不存在
  REMOTE_WORKDIR_NOT_DIRECTORY: true, // 被控端工作路径存在但不是目录
  REMOTE_WORKDIR_UNAVAILABLE: true, // 被控端网络目录不可访问 / 探测超时
  SESSION_REFERENCE_UNAVAILABLE: true, // 会话引用不存在、离线、撤权、预算/形状非法
  SESSION_REFERENCE_UNSUPPORTED: true, // 目标端版本不能消费可信会话引用快照
  // right-sidebar tabs(对标 Codex in-app browser sidebar 多 Tab 容器)
  RIGHT_SIDEBAR_TOO_MANY_TABS: true, // 单 session 超 20 个 tab
  RIGHT_SIDEBAR_UNKNOWN_KIND: true, // kind 不在 plugin registry 里
  RIGHT_SIDEBAR_STATE_TOO_LARGE: true, // 单 tab state JSON 序列化 > 16KB
  INVALID_ARGUMENT: true,
  DEVICE_BUSY: true,
  MUTATION_CANCELLED: true,
  PI_PACKAGE_LIST_FAILED: true,
  PI_PACKAGE_MUTATION_FAILED: true,
  TERMINAL_NOT_FOUND: true, // 指定 ptyId 不存在(可能已 dispose / 从未创建)
  TERMINAL_SPAWN_FAILED: true, // node-pty spawn 抛错(权限 / 路径不可达等)
  TERMINAL_SHELL_NOT_FOUND: true, // 用户偏好的 shell 二进制不在系统上
  TERMINAL_ALREADY_DISPOSED: true, // 在已 dispose 的 session 上调 restart 等操作
  // 意识(.cindy 装入)
  GHOST_FILE_INVALID: true, // 不是合法 zip / 缺 ghost.json / 清单不合格 / 超限
  GHOST_DOWNLOAD_TIMEOUT: true, // 市场包下载总时限或无进展超时
  GHOST_DOWNLOAD_FAILED: true, // 市场包下载网络失败
  GHOST_HOST_UNSUPPORTED: true, // 插件包使用了当前 Cindy 不认识的未来 schema
  GHOST_COMMAND_CONFLICT: true, // 显式指令与已装意识撞名(装入拒绝)
  GHOST_ID_RESERVED: true, // id 属 shared/ghost.ts 登记的官方保留前缀,用户通道拒装(防抢注蹭凭证别名)
  GHOST_BROKER_MANUAL_INSTALL_NOT_AUTHORIZED: true, // 本地 .cindy 来源无权使用授权 broker
  GHOST_BROKER_REDIRECT_PORT_REQUIRED: true, // 新包声明授权 broker 时缺少本机回跳端口
  // 自定义插件市场源(Git / 本地文件夹)
  MARKET_SOURCE_INVALID: true, // 来源格式非法 / 本地路径不是目录 / 参数组合不允许
  MARKET_GIT_UNAVAILABLE: true, // 未安装 Git 或版本 < 2.25(稀疏检出下限)
  MARKET_CLONE_AUTH_FAILED: true, // 克隆被拒绝:私有仓库未配置认证
  MARKET_CLONE_FAILED: true, // 克隆/拉取失败:网络、代理或远端其它错误
  MARKET_REF_NOT_FOUND: true, // 指定的 Git 引用(分支/tag/commit)在远端不存在
  MARKET_MANIFEST_MISSING: true, // 来源内找不到受支持的 marketplace.json
  PLUGIN_NAMESPACE_CLIENT_REQUIRED: true, // 企业插件需要支持 namespace 的客户端
  PLUGIN_ORGANIZATION_CONTEXT_UNAVAILABLE: true, // 暂时无法确认企业身份，可重试
  PLUGIN_NAMESPACE_CONFIG_REQUIRED: true, // 企业插件服务配置不可用
  PLUGIN_LIST_CHANGED: true, // 企业准入在翻页期间变化，需要从头重拉
  // 网关凭据自动下发(model-access)
  MODEL_ACCESS_FAILED: true, // 拉取/轮换失败(网络或服务端错误),可重试
  MODEL_ACCESS_DISABLED: true, // 服务端灰度未启用(503)——走手填兜底
  MODEL_ACCESS_UNSUPPORTED: true, // 企业未接入(403)——XD 网关不可用,不重试
  MODEL_CATALOG_FETCH_DISABLED: true, // 模型目录远程拉取被禁用(XDT_DISABLE_MODELS_FETCH),未发起请求
  PLAN_CHANGE_RENEWAL_PREPAID: true, // 下一期已付未生效，等待本期结束后升级
  PLAN_CHANGE_NOT_AVAILABLE: true, // 当前订阅不能切换到目标套餐，可返回候选列表重选
  RESUME_NOT_AVAILABLE: true, // 当前订阅已到期、渠道协议失效或状态不可恢复
  // 钉钉机器人连接
  DINGTALK_AUTH_FAILED: true, // Client ID / Client Secret 被钉钉拒绝
  DINGTALK_NETWORK_FAILED: true, // 钉钉凭证校验接口不可达
  DINGTALK_STREAM_CONNECTION_FAILED: true, // 凭证有效，但 Stream WebSocket 未建立
  // 个人资料自助修改(settings → 用户卡片;服务端直写)
  PROFILE_AVATAR_UPLOAD_FAILED: true, // 头像经 oss-server 预签名直传失败(presign 或 PUT 阶段)
  PROFILE_UPDATE_FAILED: true, // PATCH /api/me/profile 失败(网络 / 服务端拒绝)
  // 打开 Agent 专用浏览器：只跨 IPC 暴露受控原因，不暴露路径或底层异常。
  ...ipcCodeEntries(BROWSER_OPEN_FOR_LOGIN_ERROR_CODES),
  // 本机 HTML 页面打开到系统浏览器
  BROWSER_FILE_INVALID_TARGET: true,
  BROWSER_FILE_PATH_NOT_ALLOWED: true,
  BROWSER_FILE_UNSUPPORTED_TYPE: true,
  BROWSER_FILE_NOT_FOUND: true,
  BROWSER_FILE_OPEN_FAILED: true,
  HTML_PREVIEW_CANCELLED: true,
  // 会话分享(.cshare 导出/导入)
  SHARE_FILE_INVALID: true, // 不是 .cshare / 头或 manifest 损坏 / payload 不是 zip
  SHARE_PASSWORD_REQUIRED: true, // 文件已加密但未提供密码
  SHARE_PASSWORD_WRONG: true, // GCM tag 校验失败:密码错误或文件被篡改
  SHARE_VERSION_UNSUPPORTED: true, // 包要求的 reader 版本高于本端
  SHARE_CONFLICT: true, // 同 sdkSessionId/threadId 的会话或转录已存在
  SHARE_EXPORT_FAILED: true, // 导出编排失败(含超出体积上限)
  SHARE_IMPORT_FAILED: true, // 导入编排失败(已回滚)
  SHARE_WORKTREE_NOT_GIT: true, // 导入勾选 worktree 但所选目录不在 git 仓库内
  SHARE_WORKTREE_FAILED: true, // 导入时 worktree 创建失败(已中止导入)
  // 主题导入(local-themes:import)
  THEME_NOT_A_FILE: true, // 选中路径不是普通文件
  THEME_FILE_TOO_LARGE: true, // 超 4MB 上限
  THEME_UNSUPPORTED_FILE: true, // 无法识别为 VSCode / Obsidian 主题
  THEME_CONTRAST_UNSUPPORTED: true, // 主题色板无法满足控件对比度约束
  THEME_USES_INCLUDE: true, // VSCode 主题含 include(需基底才能完整解析)
  THEME_WRITE_ERROR: true, // 落盘失败(权限/磁盘)
  THEME_IMPORT_INTERNAL: true, // 意外异常
  // PSB 远程工作区（`psb:` transport）的失败码命名空间：main 用
  // `shared/psb-remote-workspace.ts` 的 `psbIpcCodeForFailure` 产出，渲染层用
  // `psbFailureMessageKeyForIpcCode` / `psbRemoteFailureFromIpcError` 映射文案键。
  // 前缀即来源：不要用 `PSB_` 码承载非 PSB 的失败。
  PSB_AUTH_REQUIRED: true,
  PSB_ORG_REQUIRED: true,
  PSB_AUTH_EXPIRED: true,
  PSB_IDENTITY_NOT_LINKED: true,
  PSB_WORKSPACE_OCCUPIED_BY_OTHER: true,
  PSB_CLIENT_OFFLINE: true,
  // 发送前自动重建 PSB 会话时，远端工作区还没就绪（planned / provisioning / failed /
  // deleting）：等它就绪后重发即可。与「工作区不存在」「客户端离线」是不同的下一步，
  // 所以单独一个码，而不是并进 PSB_NOT_FOUND。
  PSB_WORKSPACE_NOT_READY: true,
  // 工作区此刻空闲，但这**不是用户的显式占用动作**：占用闸门不替用户占用（2026-11-27 用户
  // 复测口径：所有工作区占用都必须由用户确认）。与 PSB 2026-11-27 的守卫契约**同码同形**
  // （`403 WORKSPACE_NOT_OCCUPIED`）：渲染层据此弹确认框 → 用户确认 → 显式占用 → 重试本次动作
  // （发送 / 启动串流 / 建会话）。与「被他人占用」是不同的下一步（那个只能等 / 去网页），所以单列。
  PSB_WORKSPACE_NOT_OCCUPIED: true,
  // 释放占用时该工作区里仍有正在输出的会话（PSB 409 `AGENT_SESSION_ACTIVE`）：先结束 / 停止
  // 那条会话再释放。不是可自动重试的竞态，也不引导用户去 PSB 网页兜底。
  PSB_AGENT_SESSION_ACTIVE: true,
  // 远端客户端没有该 Agent 的运行时（PSB `unusableReason='agent-unsupported'`）：下一步是
  // 升级那台电脑上的客户端，与「等它就绪」（PSB_WORKSPACE_NOT_READY）不同，所以单独一个码。
  PSB_AGENT_UNSUPPORTED: true,
  // 管理页 stale 上下文的三条可行动归因（main `adminService` 构造 `failure.code`）：
  // 工作区已不在列表 / PSB 读不到该工作区 / 只有占位身份 —— 下一步不同，不并进 PSB_NOT_FOUND。
  PSB_WORKSPACE_MISSING: true,
  PSB_WORKSPACE_UNREACHABLE: true,
  PSB_WORKSPACE_ID_UNKNOWN: true,
  // CINDY-RW-10：占用/解除占用那一刻的版本控制检查（含 P4 reconcile）拒绝。三种码都是
  // 「现在不能占用/释放」，但下一步不同：DIRTY 可查看详情/还原后重试，UNAVAILABLE /
  // UNSUPPORTED 只能重试检查（没有 force 分支）。渲染层据此给可行动文案。
  PSB_WORKSPACE_VCS_DIRTY: true,
  PSB_WORKSPACE_VCS_UNAVAILABLE: true,
  PSB_WORKSPACE_VCS_UNSUPPORTED: true,
  PSB_NOT_FOUND: true,
  PSB_UNREACHABLE: true,
  PSB_STREAM_UNAVAILABLE: true,
  // 本端没有活动的串流连接（输入无处可发）：可恢复，先启动观看即可。与
  // PSB_STREAM_UNAVAILABLE（本机/客户端不支持串流）是不同的下一步，因此单独一个码。
  PSB_STREAM_NOT_ACTIVE: true,
  // 订阅串流时工作区没有 running 的桌面访问会话（PSB 409 details.code='NO_RUNNING_SESSION'）：
  // 按 details.state 分三条码，因为下一步动作不同——去 PSB 网页启动访问 / 等启动 / 等结束。
  // 语义与文案正本见 shared/psb-remote-workspace.ts 的 `PSB_NO_RUNNING_SESSION_IPC_CODES`。
  PSB_STREAM_NO_RUNNING_SESSION: true,
  PSB_STREAM_ACCESS_STARTING: true,
  PSB_STREAM_ACCESS_STOPPING: true,
} as const;

export type IpcErrorCode = keyof typeof IPC_ERROR_CODES;

const IPC_ERROR_CODE_SET: ReadonlySet<string> = new Set(Object.keys(IPC_ERROR_CODES));

export function isIpcErrorCode(code: unknown): code is IpcErrorCode {
  return typeof code === 'string' && IPC_ERROR_CODE_SET.has(code);
}

export interface IpcError {
  code: IpcErrorCode;
  message: string;
}

/**
 * 标准 IpcError 构造器 —— main 的 throwIpcError 与 renderer 侧预检共用同一形状
 * (`[code] message` + err.code),避免两处手写漂移。isIpcError 按 err.code 判定,
 * 不依赖 err.name。
 */
export function createIpcError(
  code: IpcErrorCode,
  message: string,
): Error & { code: IpcErrorCode } {
  const err = new Error(`[${code}] ${message}`) as Error & { code: IpcErrorCode };
  err.code = code;
  return err;
}

export function isIpcError(err: unknown): err is Error & { code: IpcErrorCode } {
  return err instanceof Error && isIpcErrorCode((err as { code?: unknown }).code);
}
