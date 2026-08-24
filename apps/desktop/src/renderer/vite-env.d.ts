/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CINDY_AUTH_REGION: 'cn' | 'global' | 'dev';
  readonly VITE_ENDPOINT_MANIFEST_BASE_URL: string;
  readonly VITE_ENDPOINT_MANIFEST_PEER_BASE_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

type AgentProxyPrefPayload = import('../shared/agentProxyConfig').SshHostAgentProxyPref;
type AgentProxyTunnelStatePayload = import('../shared/agentProxyConfig').AgentProxyTunnelState;
type ModelAccessStatusPayload = import('../shared/modelAccess').ModelAccessStatus;
type AnalyticsSettingsPayload = import('../shared/analyticsSettings').AnalyticsSettingsPayload;
type RsbWindowCommand = import('../shared/rightSidebarWindow').RsbWindowCommand;
type VoiceInputPowerStatePayload =
  import('../shared/voiceInputPowerIpc').VoiceInputPowerStatePayload;
type VoiceInputConnectionTestResult =
  import('../shared/voiceInputConnectionTest').VoiceInputConnectionTestResult;
type DesktopLoginAction = import('../shared/authIpc').DesktopLoginAction;
type DesktopLoginActionResult = import('../shared/authIpc').DesktopLoginActionResult;
type UtilityTextFailure = import('../shared/utilityTextResult').UtilityTextFailure;
type MakerSessionTreeSnapshot = import('@cindy/maker-core').SessionTreeSnapshot;
type BrowserBackendHealth = import('../shared/browserBackend').BrowserBackendHealth;
type BrowserBackendRecoveryResult = import('../shared/browserBackend').BrowserBackendRecoveryResult;
type DesktopAccountDeletionConfirmInput =
  import('../shared/authIpc').DesktopAccountDeletionConfirmInput;
type DesktopAccountDeletionAvailabilityResult =
  import('../shared/authIpc').DesktopAccountDeletionAvailabilityResult;
type DesktopAccountDeletionChallengeResult =
  import('../shared/authIpc').DesktopAccountDeletionChallengeResult;
type DesktopAccountDeletionConfirmResult =
  import('../shared/authIpc').DesktopAccountDeletionConfirmResult;
type DesktopAccountDeletionStatusResult =
  import('../shared/authIpc').DesktopAccountDeletionStatusResult;
type PendingRemotePrecreatedWorktree =
  import('../shared/remotePrecreatedWorktreeLedger').PendingRemotePrecreatedWorktree;
type PendingRemotePrecreatedWorktreeTarget =
  import('../shared/remotePrecreatedWorktreeLedger').PendingRemotePrecreatedWorktreeTarget;
type RemotePrecreatedWorktreeLedgerSnapshot =
  import('../shared/remotePrecreatedWorktreeLedger').RemotePrecreatedWorktreeLedgerSnapshot;

/* ── Environment check ── */

interface EnvCheckResult {
  claudeCode: {
    status: 'passed' | 'failed';
    path?: string;
    error?: string;
  };
  codex: {
    status: 'passed' | 'failed' | 'skipped';
    path?: string;
    error?: string;
  };
  pi?: {
    status: 'passed' | 'failed' | 'skipped';
    path?: string;
    error?: string;
  };
  ripgrep?: { status: 'passed' | 'failed' | 'skipped'; error?: string };
  allPassed: boolean;
  platform: 'darwin' | 'win32' | 'linux';
}

// Voice-input wire types: re-export from voice-input-core to keep the IPC
// surface and the core package's contract in sync. `VoiceInputShortcut` is
// renderer-only (defined in voice-input/shortcut.ts) so it stays inline.
// HostSnapshot 来自 transport-only package; desktop main 端 wrap 时附加
// autoConnect / agentProxy 偏好字段 (本地 prefs, 不写入 ~/.ssh/config), 渲染层统一用
// 这个扩展类型即可一次拿到完整信息, 不必再为单个字段单独 IPC。
type RemoteHostSnapshot = import('@cindy/maker-remote-ssh').HostSnapshot & {
  autoConnect: boolean;
  /** Agent 流量经 SSH 隧道走本地 Proxy 的 per-host 配置; 未开启 → null。 */
  agentProxy: AgentProxyPrefPayload | null;
  /** 隧道实时状态 (main 进程内存态); 无记录 → null。 */
  agentProxyTunnel: AgentProxyTunnelStatePayload | null;
};
/** 设备互联:REST 设备视图(同 shared/deviceLinkIpc.ts DeviceLinkDeviceView) */
interface DeviceLinkDeviceInfo {
  cpuLabel?: string;
  memoryGb?: number;
  osVersion?: string;
  modelLabel?: string;
}

interface DeviceLinkDeviceView {
  deviceId: string;
  name: string;
  selfName?: string | null;
  deviceInfo?: DeviceLinkDeviceInfo | null;
  platform: string | null;
  appVersion: string | null;
  lastSeenAt: string | null;
  online: boolean;
  busy: boolean;
  remoteControlEnabled: boolean;
  controlEnabled: boolean;
  isSelf: boolean;
}

/** 设备互联:relay 连接问题(镜像 @cindy/device-link 的 DeviceLinkConnectionIssue) */
interface DeviceLinkConnectionIssuePayload {
  kind: 'auth-failed' | 'replaced' | 'too-many-connections' | 'version-mismatch' | 'unstable';
  closeCode?: number;
  detail?: string;
  at: number;
}

/** 设备互联:presence 推送快照 */
interface DeviceLinkPresenceSnapshot {
  deviceId: string;
  online: boolean;
  deviceName: string;
  selfName?: string | null;
  deviceInfo?: DeviceLinkDeviceInfo | null;
  platform: string;
  appVersion: string;
  lastSeenAt: number;
  remoteControlEnabled: boolean;
  busy: boolean;
}

/** .cshare 导入向导的预览数据(main 侧 SharePreview 的镜像)。 */
interface SessionSharePreview {
  title: string;
  agentKind: 'cc' | 'codex' | 'pi';
  workspaceKind: 'project' | 'dialogue';
  originalWorkingDir: string | null;
  exportedAt: string;
  appVersion: string;
  fidelity: 'full' | 'partial' | 'db-only';
  messageCount: number;
  mediaCount: number;
  orcaWorkerCount: number;
}

interface LocalSshKeyInfo {
  privateKeyPath: string;
  pubkeyPath: string;
  type: string;
  comment: string;
  fingerprintSha256: string | null;
  inAgent: boolean;
  mtimeIso: string | null;
}
type AgentFailureReason = 'agent_unavailable' | 'bad_passphrase' | 'no_such_file' | 'other';
type RemoteAgentKind = import('@cindy/maker-remote-ssh').RemoteAgentKind;
type RemoteAgentProbe = import('@cindy/maker-remote-ssh').ProbeResult;
type RemoteAgentInstallResult = import('@cindy/maker-remote-ssh').InstallResult;
type RemoteAgentInstallProgress = import('@cindy/maker-remote-ssh').InstallProgressEvent;

interface RemoteAgentInstallProgressPush {
  hostId: string;
  agentKind: RemoteAgentKind;
  event: RemoteAgentInstallProgress;
}

interface RemoteAgentSilentInstallStatusPush {
  hostId: string;
  agentKind: RemoteAgentKind;
  phase: 'started' | 'progress' | 'done' | 'failed';
  eventKind?: RemoteAgentInstallProgress['kind'];
  message?: string;
}

/** cc-mgr 版本升级 push payload。available=null 表示该 host 的 pending 已清空。 */
interface RemoteAgentCcMgrUpgradeAvailablePush {
  hostId: string;
  available: {
    currentVersion: string;

    availableVersion: string;
  } | null;
  agent: 'cc' | 'pi';
}

interface RemoteAgentExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
}

interface RemoteAgentOneShotResult extends RemoteAgentExecResult {
  durationMs: number;
}

type VoiceInputState = import('@cindy/voice-input-core').VoiceInputState;
type VoiceAudioTrace = import('@cindy/voice-input-core').AudioTrace;
type VoiceSpeechSegment = import('@cindy/voice-input-core').SpeechSegment;
type VoiceInputGlobalErrorCode =
  'empty' | 'unavailable' | 'unconfirmed' | 'permission' | 'failed' | 'superseded';
type VoiceInputGlobalResult =
  { ok: true } | { ok: false; error: string; errorCode?: VoiceInputGlobalErrorCode };
type VoiceEditableRange = import('@cindy/voice-input-core').EditableRange;
type VoiceRefinementContext = import('@cindy/voice-input-core').DictationRefinementContext;
type VoiceInputDraftSource = import('@cindy/voice-input-core').VoiceInputDraftSource;
type VoiceInputRendererEvent = import('@cindy/voice-input-core').VoiceInputRendererEvent;
type VoiceInputDictionaryAdviceInput =
  import('@cindy/voice-input-core').DictationDictionaryAdviceInput;
type VoiceInputDictionaryLearningAction =
  import('@cindy/voice-input-core').DictationDictionaryLearningAction;
type VoiceInputSettingsData = import('../shared/voiceInputData').VoiceInputSettings;
type VoiceInputHistoryEntryData = import('../shared/voiceInputData').VoiceInputHistoryEntry;
type VoiceInputDataSnapshot = import('../shared/voiceInputData').VoiceInputDataSnapshot;
type VoiceInputProviderKindData = import('../shared/voiceInputAsrProfiles').VoiceInputProviderKind;
type VoiceInputAsrModeData = import('../shared/voiceInputAsrProfiles').VoiceInputAsrMode;
type VoiceInputRefinerProviderKindData =
  import('../shared/voiceInputRefinerProfiles').VoiceInputRefinerProviderKind;
type VoiceInputRefinerTransportData =
  import('../shared/voiceInputRefinerProfiles').VoiceInputRefinerTransport;
type VoiceInputServiceModeData = 'cindy' | 'byok';
type VoiceInputModelSelectionResultData = {
  selection: {
    serviceMode: VoiceInputServiceModeData;
    serviceModeConfigured: boolean;
    asrProvider: VoiceInputProviderKindData;
    asrProviderChain: VoiceInputProviderKindData[];
    asrProviderChainSource: 'default' | 'configured';
    customAsr?: {
      protocol: 'openai-realtime' | 'qwen-realtime';
      websocketUrl: string;
      model: string;
    };
    refinerProvider: VoiceInputRefinerProviderKindData;
    refinerModel?: string;
    /** Effective refiner chain, head first; length 1 = no fallback (BYOK default). */
    refinerProviderChain: VoiceInputRefinerProviderKindData[];
    refinerProviderChainSource: 'default' | 'configured';
    configPath: string;
  };
  asrProfiles: Array<{
    id: VoiceInputProviderKindData;
    model: string;
    mode: VoiceInputAsrModeData;
    auth: 'api-key' | 'codex';
  }>;
  refinerProfiles: Array<{
    id: VoiceInputRefinerProviderKindData;
    model: string;
    transport: VoiceInputRefinerTransportData;
    auth: 'api-key' | 'codex';
  }>;
  readiness: {
    ok: boolean;
    provider: VoiceInputProviderKindData;
    providerModel: string;
    auth: 'api-key' | 'codex';
    settingsTab: 'api-keys' | 'connections' | 'providers';
    error?: string;
    failureReason?:
      'custom-asr-config-missing' | 'custom-asr-key-missing' | 'codex-realtime-unsupported';
  };
  customAsrApiKeyConfigured: boolean;
};
type LocalThemeOpenDirResult = import('../shared/local-themes').LocalThemeOpenDirResult;
type LocalThemesResult = import('../shared/local-themes').LocalThemesResult;
type LocalThemeWriteRequest = import('../shared/local-themes').LocalThemeWriteRequest;
type LocalThemeWriteResult = import('../shared/local-themes').LocalThemeWriteResult;
type ImDefaultSettingsPatch = import('../shared/imDefaultSettings').ImDefaultSettingsPatch;
type ImDefaultSettingsState = import('../shared/imDefaultSettings').ImDefaultSettingsState;
type ImDefaultSettingsChannel = import('../shared/imDefaultSettings').ImDefaultSettingsChannel;
type SubagentModelSettingsPatch =
  import('../shared/subagentModelSettings').SubagentModelSettingsPatch;
type SubagentModelSettingsState =
  import('../shared/subagentModelSettings').SubagentModelSettingsState;
type SubagentModelSettingsWriteResult =
  import('../shared/subagentModelSettings').SubagentModelSettingsWriteResult;

/** Agent 资源占用设置的 IPC wire 形状(main 侧 agentResourceSettingsWire)。 */
type AgentResourceProcessPriority = 'normal' | 'low' | 'lowest';
type AgentResourceSettingsWire = {
  maxConcurrentCommands: number;
  processPriority: AgentResourceProcessPriority;
  capToolchainThreads: boolean;
  isCustomized: boolean;
  customizedKeys: string[];
  defaults: {
    maxConcurrentCommands: number;
    processPriority: AgentResourceProcessPriority;
    capToolchainThreads: boolean;
  };
};

interface VoiceInputShortcut {
  trigger?: 'keyboard' | 'modifier';
  code: string;
  key: string;
  modifiers: {
    meta: boolean;
    ctrl: boolean;
    alt: boolean;
    shift: boolean;
    fn: boolean;
  };
}

interface ComputerDriverStatus {
  installed: boolean;
  executablePath: string | null;
  version: string | null;
  daemonRunning: boolean;
  daemonStatus?: string;
  doctor?: unknown;
  permissions?: unknown;
  permissionState?: ComputerDriverPermissionState;
  installCommand: string;
  docsUrl: string;
  error?: string;
}

interface ComputerDriverStatusOptions {
  includeDoctor?: boolean;
  forcePermissionProbe?: boolean;
  skipPermissionProbe?: boolean;
  freshPermissionProbe?: boolean;
  bypassPermissionProbeCache?: boolean;
  passivePermissionProbeOnly?: boolean;
}

type ComputerDriverPermissionPlatform = 'macos' | 'windows' | 'linux' | 'unsupported';
type ComputerDriverPermissionStatus = 'granted' | 'missing' | 'unknown' | 'not_required';
type ComputerDriverPermissionGrant = 'granted' | 'missing' | 'unknown' | 'not_required';

interface ComputerDriverPermissionState {
  platform: ComputerDriverPermissionPlatform;
  required: boolean;
  status: ComputerDriverPermissionStatus;
  accessibility?: ComputerDriverPermissionGrant;
  screenRecording?: ComputerDriverPermissionGrant;
  screenRecordingCapturable?: ComputerDriverPermissionGrant;
  source?: string;
  reason?: string;
  canGrant: boolean;
}

interface ComputerDriverInstallResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: ComputerDriverStatus;
}

type ComputerDriverPermissionGrantResult = ComputerDriverInstallResult;

interface ComputerDriverUpdateCheck {
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  updating: boolean;
}

interface ComputerDriverUpdateProgress {
  phase: 'downloading' | 'installing' | 'done';
  downloadedBytes: number | null;
  totalBytes: number | null;
}

/* ── CCD Progress ── */

interface BinaryDownloadProgressPayload {
  progress: number;
  speed?: string;
  downloaded?: string;
  total?: string;
  failed?: boolean;
  error?: string;
  step?: 1 | 2 | 3;
  totalSteps?: 2 | 3;
  reset?: boolean;
  vendor?: 'claude' | 'codex' | 'pi';
}

/* ── App Update Progress ── */

interface AppUpdateProgressPayload {
  progress: number;
  received: number;
  total: number;
  speed?: string;
  failed?: boolean;
  error?: string;
}

/* ── Auth types ── */

interface AuthUser {
  id: string;
  name: string;
  avatar: string | null;
  email: string | null;
  defaultModel: string;
  defaultEffort: string;
  membershipKind: 'personal' | 'org';
  membershipRole: 'owner' | 'admin' | 'member';
  orgId: string | null;
  orgName: string | null;
  orgSlug: string | null;
  orgLogoUrl: string | null;
  passportId: string;
}

/* ── Google integration ── */

type GoogleAuthStatus = 'not_connected' | 'connecting' | 'connected' | 'reconnect_required';

type FeishuBotStatus = 'idle' | 'testing' | 'connected' | 'reconnecting' | 'conflict' | 'error';

/** @cindy/im DiscordIM 的 transport 状态(IMStatus union 的 mirror)。 */
type DiscordBotTransportStatus =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'connected'; appId: string }
  | { kind: 'conflict'; appId: string }
  | { kind: 'error'; reason: string };

/** @cindy/im TelegramIM 的 transport 状态(IMStatus union 的 mirror)。 */
interface TelegramBotBehavior {
  emojiReactions: 'off' | 'minimal' | 'expressive';
  replyQuoteGroup: 'off' | 'first' | 'all';
  replyQuoteDm: 'off' | 'first';
}

type TelegramBotTransportStatus =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'connected'; appId: string }
  | { kind: 'conflict'; appId: string }
  /** 凭证保留、用户主动下线(不轮询); 与 idle=未配置 严格区分。 */
  | { kind: 'offline'; appId: string }
  | { kind: 'error'; reason: string; code?: TelegramBotErrorCode };

/** 稳定错误分类;renderer 据此取 i18n 文案,不直接展示 main 层 reason。 */
type TelegramBotErrorCode = 'invalid-token' | 'provider-api' | 'network' | 'secret-unavailable';

type DingTalkBotTransportStatus = DiscordBotTransportStatus;
type WecomBotTransportStatus =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'connected'; appId: string }
  | { kind: 'conflict'; appId: string }
  | { kind: 'error'; reason: string };

type WechatBotPhase =
  | 'disconnected'
  | 'authorizing'
  | 'waiting_confirmation'
  | 'connected'
  | 'reconnecting'
  | 'needs_reauth'
  | 'disabled_by_policy'
  | 'error';

interface WechatBotState {
  phase: WechatBotPhase;
  bound: boolean;
  connectedAt?: number;
  lastInboundAt?: number;
  queuedTasks: number;
  errorCode?: string;
}

interface WechatChannelSettingsState {
  version: 1;
  workingDir: string | null;
  workingDirAvailable: boolean;
}

type DiscordBotSessionAuthCheckResult = {
  ok: boolean;
  missing: 'gateway-key' | 'agent-oauth' | 'provider-key' | 'provider-disconnected' | null;
  agentKind: 'claude-code' | 'codex' | 'pi';
  model: string;
  providerId: string | null;
  providerLabel: string | null;
};

interface FeishuBotRegistrationBeginResult {
  ok: boolean;
  deviceCode?: string;
  userCode?: string;
  verificationUrl?: string;
  expiresIn?: number;
  interval?: number;
  error?: string;
}

interface FeishuBotRegistrationStatusPayload {
  status: 'pending' | 'success' | 'expired' | 'cancelled' | 'error';
  appId?: string;
  ownerOpenId?: string | null;
  verdict?: 'connected' | 'conflict' | 'error' | 'pending';
  error?: string;
}

/** Auth state pushed from main → renderer via 'auth:state-change'. */
interface AuthStateChangePayload {
  user: AuthUser | null;
  mode: 'signed-out' | 'local' | 'cloud';
  dataOwnerId: string | null;
  ownerGeneration: number;
  canEnterApp: boolean;
  isAuthenticated: boolean;
  isCanary: boolean;
  deviceId: string;
  hasAccountDeletionReceipt: boolean;
  accountDeletionRestored: boolean;
  credentialStoreUnavailable?: boolean;
  edition: 'cn' | 'global' | 'dev';
}

/**
 * 会话失效的客户端内部分类(镜像 main/authRefreshFailure.ts 的 SessionExpiredReason;
 * main 不透传服务端原文,renderer 按此映射本地化文案)。
 */
type AuthSessionExpiredReason =
  | 'replaced-elsewhere'
  | 'expired'
  | 'device-mismatch'
  | 'account-unavailable'
  | 'credential-lost'
  | 'unknown';

interface AuthSessionExpiredPayload {
  message: string;
  reason?: AuthSessionExpiredReason;
}

/** chat-data-localization F1 V0.4: corruption-restored toast payload (C10). */
interface CorruptionRestoredPayload {
  source: 'clean' | 'iso';
  backupMtime: string;
}

/** #37: release 端检测到 schema drift 的 toast payload。 */
interface SchemaDriftWarningPayload {
  driftedFiles: string[];
}

interface OrcaTeamRecord {
  id: string;
  leadSessionId: string;
  status: 'active' | 'completed' | 'cancelled' | 'failed';
  workerPermissionMode: 'auto' | 'bypassPermissions';
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface OrcaWorkerRecord {
  id: string;
  teamId: string;
  leadSessionId: string;
  sessionId: string;
  status: 'idle' | 'running' | 'done' | 'error';
  label: string | null;
  worktreeBranch: string | null;
  role: string;
  focused: boolean;
  idleSince: string | null;
  createdAt: string;
  updatedAt: string;
  session: {
    id: string;
    title: string;
    agentKind: 'claude-code' | 'codex' | 'pi';
    workingDir: string;
    model: string;
    effort: string;
    permissionMode: string;
    fastMode: boolean;
    sdkSessionId?: string;
    remoteHostId?: string | null;
  };
}

/* ── Codex vendor auth types (Boss 4 M22) ── */

/** Codex OAuth auth state from main process / auth.json */
interface CodexAuthState {
  authenticated: boolean;
  identity?: string;
  expiresAt?: number;
  errorReason?: string;
  authSource?: 'oauth' | 'api-key';
  credentialScope?: 'system-shared' | 'instance-isolated' | 'unknown';
  recoveryRequiredReason?: string;
}

/** Codex progress event payload (binary download + login phases) */
interface CodexOAuthProgressPayload {
  phase: 'downloading' | 'extracting' | 'ready' | 'login-pending' | 'login-error';
  received?: number;
  total?: number;
  detail?: string;
}

/** Codex event stream payload — from main via CODEX_OAUTH_CHANNEL (M14) */
interface CodexEventPayload {
  sessionId: string;
  event: {
    type: string;
    text?: string;
    delta?: string;
    message?: string;
    [key: string]: unknown;
  };
}

/** M40: Codex 今日 token 累计 snapshot（与 main/vendor/codex/types.ts 对齐）*/
interface CodexUsageSnapshot {
  day: string;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  total: number;
}

/* ── ElectronAPI ── */

/* ── CC Agent stream event types ── */

interface CCAgentStreamEvent {
  sessionId: string;
  type:
    | 'text'
    | 'tool_use'
    | 'tool_result'
    | 'tool_result_full'
    | 'agent_task_update'
    | 'status'
    | 'done'
    | 'error'
    | 'permission_request'
    | 'permission_dismissed'
    | 'ask_user_question'
    | 'plan_review'
    | 'thinking'
    | 'compact_boundary';
  data: unknown;
  source?: 'claude-code' | 'codex' | 'pi' | 'vision-bridge';
  agentMeta?: import('@/lib/ccAgent.types').AgentMeta;
  turnContinuationId?: number;
  persistId?: string;
  resolvedContent?: string;
}

/**
 * Thinking block streaming payload (extended thinking from Anthropic API).
 *
 *  - 'start':    First sign of a thinking block in this API call. Renderer
 *                creates a new in-progress card. `startedAt` is the wall clock
 *                when the first delta arrived.
 *  - 'delta':    Append `text` to the card identified by `blockId`.
 *  - 'final':    Authoritative full text from the assistant message. Renderer
 *                replaces accumulated text and freezes the card with `durationMs`.
 *  - 'redacted': Server-side redacted reasoning. No text — show locked card.
 */
interface CCAgentThinkingPayload {
  sessionId: string;
  type: 'thinking';
  data:
    | { stage: 'start'; blockId: string; startedAt: number }
    | { stage: 'delta'; blockId: string; text: string }
    | { stage: 'final'; blockId: string; text: string; durationMs: number }
    | { stage: 'redacted'; blockId: string };
}

/* ── Permission prompt types (F-PERM-1) ── */

interface CCAgentPermissionRequestPayload {
  sessionId: string;
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  title?: string;
  displayName?: string;
  description?: string;
  suggestions?: unknown[];
  autoReviewUnavailable?: boolean;
}

interface CCAgentPermissionResult {
  behavior: 'allow' | 'deny';
  message?: string;
  updatedPermissions?: unknown[];
  decisionClassification?: string;
}

/**
 * Sent from main → renderer when an in-flight permission prompt is auto-resolved
 * (e.g. user switched permissionMode mid-prompt). Renderer should clear its
 * pendingPermission state and close any open dialog matching `requestId`.
 */
interface CCAgentPermissionDismissedPayload {
  sessionId: string;
  requestId: string;
  reason:
    'mode_changed_to_bypassPermissions' | 'mode_changed_to_acceptEdits' | 'mode_changed_to_plan';
  resolvedAs: 'allow' | 'deny';
}

interface CCAgentStatusUpdate {
  sessionId: string;
  status: string;
  tokenUsage: number;
  costUsd?: number;
  contextTokens: number;
  contextWindow: number;
  isRunning: boolean;
  turnContinuationId?: number;
  skipTurnReset?: boolean;
}

/**
 * agent-meta: user 消息持久化结果回推 payload。
 *  - 成功：message 含完整 row；renderer 据此把乐观 pending 转正
 *  - 失败：error 非空且 message 为 null；renderer 据此回滚乐观显示并提示
 *
 * user-message-persist-race 修复后，main 在 sendMessage 入口同步落库后立刻
 * fire 一次（不再等 SDK 回显）；SDK 回显路径只补 agent_meta 不再 fire。
 */
interface CCAgentUserMessagePersistedPayload {
  sessionId: string;
  pendingId: string;
  message: import('@/lib/ccAgent.types').Message | null;
  error?: string;
}

/* ── AskUserQuestion types (F7.1) ── */

interface CCAgentAskUserQuestionOption {
  label: string;
  description?: string;
}

interface CCAgentAskUserQuestionItem {
  question: string;
  header?: string;
  options?: CCAgentAskUserQuestionOption[];
  multiSelect?: boolean;
}

/**
 * Payload sent from main → renderer with ALL questions at once.
 * The renderer manages the wizard (Back/Next/animation) locally.
 */
interface CCAgentAskUserQuestionPayload {
  sessionId: string;
  requestId: string;
  questions: CCAgentAskUserQuestionItem[];
}

/**
 * All answers sent back from renderer → main in one shot.
 */
interface CCAgentAnswerUserQuestionParams {
  sessionId: string;
  requestId: string;
  answers: Record<string, string>;
}

/* ── Plan Review types (FP-2) ── */

/**
 * Payload sent from main → renderer when the SDK requests ExitPlanMode.
 * Mirrors AskUserQuestion contract.
 */
interface CCAgentPlanReviewPayload {
  sessionId: string;
  requestId: string;
  plan: string;
  planFilePath: string;
  // Absolute path of the plan file on disk
}

/**
 * Plan-review decision sent back from renderer → main.
 */
interface CCAgentPlanReviewResponseParams {
  sessionId: string;
  requestId: string;
  approved: boolean;
  feedback?: string;
  latestPlan?: string;
}

/**
 * FP-edit: write the edited plan back to disk via main process.
 */
interface CCAgentWritePlanFileParams {
  requestId: string;
  planFilePath: string;
  content: string;
}

interface CCAgentSdkSessionIdPayload {
  sessionId: string;
  sdkSessionId: string;
}

/**
 * rewind-session: SDK rewindFiles 返回的结构（与 SDK 端 RewindFilesResult 同型）。
 * 不直接 re-export SDK 类型——避免在 renderer 端拉 main-only 包的 d.ts 编译开销。
 */
interface RewindFilesResultPayload {
  canRewind: boolean;
  error?: string;
  filesChanged?: string[];
  insertions?: number;
  deletions?: number;
}

/* ── App Update status ── */

interface UpdateStatusPayload {
  status: 'idle' | 'checking' | 'downloading' | 'ready' | 'superseding' | 'error';
  version?: string;
  progress?: number;
  errorCode?: string;
}

interface AutoUpdateSettingsPayload {
  autoRelaunchOnIdle: boolean;
  isCustomized?: boolean;
  defaultAutoRelaunchOnIdle?: boolean;
}

/* ── 跨 Agent 工作区互转 wire 类型（同 main/cross-agent-convert/types.ts） ── */
type CrossAgentMigrationKind = 'agents-md' | 'agents' | 'hooks' | 'mcp';
type CrossAgentDirection = 'to-claude' | 'to-codex';
type CrossAgentStepStatus = 'pending' | 'running' | 'success' | 'skipped' | 'failed';

interface CrossAgentMigrationItem {
  id: string;
  kind: CrossAgentMigrationKind;
  direction: CrossAgentDirection;
  label: string;
  source: string;
  target: string;
  subItems?: { name: string; sourcePath: string; targetPath: string }[];
}

interface CrossAgentStepEvent {
  itemId: string;
  status: CrossAgentStepStatus;
  detail?: string;
}

interface PluginListItem {
  id: string;
  name: string;
  description: string;
  source: 'builtin' | 'hub' | 'local';
  essential: boolean;
  effectiveEnabled: boolean;
  productDefaultEnabled: boolean;
  projectOverride?: { enabled: boolean; workingDir: string } | null;
  userOverride?: { enabled: boolean } | null;
  globalOverride?: { enabled: boolean } | null;
}

interface PluginEnableState {
  effectiveEnabled: boolean;
  productDefaultEnabled: boolean;
  projectOverride?: { enabled: boolean; workingDir: string } | null;
  userOverride?: { enabled: boolean } | null;
  globalOverride?: { enabled: boolean } | null;
  collabWorkspaceKind?: 'project' | 'dialogue';
}

interface PluginEnableUpdateResult {
  codexMcpRefreshed: boolean;
}

interface BrowserAvailability {
  detected: boolean;
  browserKind: string | null;
  executablePath: string | null;
}

type AndroidMcpErrorCode =
  | 'ADB_NOT_FOUND'
  | 'NO_DEVICE'
  | 'MULTIPLE_DEVICES'
  | 'DEVICE_UNAUTHORIZED'
  | 'DEVICE_OFFLINE'
  | 'UI_DUMP_FAILED'
  | 'SCREENSHOT_FAILED'
  | 'INVALID_NODE'
  | 'ANDROID_DRIVER_ERROR';

type AndroidAdbPathSource = 'custom' | 'env' | 'prepared' | 'bundled' | 'sdk' | 'path' | 'fallback';

interface AndroidConnectedDevice {
  device_serial: string;
  state: string;
  product?: string;
  model?: string;
  device?: string;
  transport_id?: string;
  usb?: string;
}

interface AndroidAdbPreparationState {
  supported: boolean;
  ready: boolean;
  platform: string;
  path: string | null;
  source: AndroidAdbPathSource | null;
  error?: string;
}

interface AndroidStatusSummary {
  adb_available: boolean;
  adb_path: string | null;
  adb_path_source?: AndroidAdbPathSource | null;
  adb_preparation?: AndroidAdbPreparationState;
  version: string | null;
  devices: AndroidConnectedDevice[];
  default_device_serial?: string | null;
  configured_default_device_serial?: string | null;
  issue?: AndroidMcpErrorCode | null;
  error?: string;
}

interface AndroidAutomationSettings {
  defaultDeviceSerial: string | null;
  adbPathOverride: string | null;
}

interface AndroidAutomationConfigState {
  value: AndroidAutomationSettings;
  isCustomized: boolean;
  defaults: AndroidAutomationSettings;
  customizedKeys: string[];
}

interface ProjectAutomationConsent {
  workingDir: string;
  consentedAt: number;
  configHash: string;
}

interface ProjectAutomationReconcileResult {
  workingDir: string;
  inserted: number;
  updated: number;
  deleted: number;
  skipped: 'no-file' | 'parse-error' | null;
}

type ProjectAutomationEvent = {
  type: 'reconciled';
  workingDir: string;
  inserted: number;
  updated: number;
  deleted: number;
  isFirstTime: boolean;
  hashChanged: boolean;
};

type ApplicationMenuCommand = import('../shared/applicationMenuCommands').ApplicationMenuCommand;
type ApplicationMenuLocale = import('../shared/locale').SupportedLocale;
type AgentIslandDisplayOption = import('../shared/agentIsland').AgentIslandDisplayOption;
type AgentIslandDisplayTarget = import('../shared/agentIsland').AgentIslandDisplayTarget;
type AgentIslandMascotSkin = import('../shared/agentIsland').AgentIslandMascotSkin;
type AgentIslandSoundChoice = import('../shared/agentIsland').AgentIslandSoundChoice;
type AgentIslandSoundSettings = import('../shared/agentIsland').AgentIslandSoundSettings;
type AgentIslandSessionActivity = import('../shared/agentIsland').AgentIslandSessionActivity;

/** 会话内 /goal 状态扁平 payload(main goal-host → renderer)。 */
interface GoalStatusPayload {
  sessionId: string;
  status: 'active' | 'paused' | 'blocked' | 'complete' | 'budgetLimited' | 'usageLimited';
  objective: string;
  turnsUsed: number;
  tokensUsed: number;
  maxTurns: number | null;
  noProgressLimit: number | null;
  budgetTokens: number | null;
  usageResetAt: number | null;
  startedAt: number;
  lastReason: string | null;
}

interface ElectronAPI {
  platform: string;
  osRelease: string;
  appVersion: string;
  clientEndpoints: {
    websiteUrl: string;
  };
  appDisplayVersion: string;
  appDisplayVersionDetail: string;
  preferredSystemLocale: ApplicationMenuLocale;
  onLocaleChanged?: (
    cb: (locale: import('../shared/locale').SupportedLocale) => void,
  ) => () => void;
  getDeviceId: () => Promise<string>;
  windowMinimize: () => void;
  windowMaximize: () => void;
  windowClose: () => void;
  windowDragMoveStart: () => void;
  windowDragMoveStop: () => void;
  windowCloseSelf: () => void;
  anySessionInTurn: () => Promise<boolean>;
  pageZoomIn: () => Promise<{ ok: true; zoomFactor: number }>;
  pageZoomOut: () => Promise<{ ok: true; zoomFactor: number }>;
  pageZoomReset: () => Promise<{ ok: true; zoomFactor: number }>;
  appearanceSettings: {
    getSync: () => import('../shared/appearanceSettings').AppearanceSettings | null;
    get: () => Promise<unknown>;
    setPatch: (
      patch: Partial<import('../shared/appearanceSettings').AppearanceSettings>,
    ) => Promise<import('../shared/appearanceSettings').AppearanceSettings>;
    reset: () => Promise<import('../shared/appearanceSettings').AppearanceSettings>;
    onChanged: (
      callback: (settings: import('../shared/appearanceSettings').AppearanceSettings) => void,
    ) => () => void;
  };
  onApplicationMenuCommand: (callback: (command: ApplicationMenuCommand) => void) => () => void;
  setApplicationMenuLocale: (locale: ApplicationMenuLocale) => Promise<{ ok: true }>;
  billing: import('../shared/billing').BillingRendererApi;
  onSystemTransientNetworkError: (
    callback: (payload: { code: string; address?: string; port?: number }) => void,
  ) => () => void;
  logToMain: (
    level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal',

    scope: string,

    msg: string,
  ) => void;
  localThemes: {
    listSync: () => LocalThemesResult;
    list: () => Promise<LocalThemesResult>;
    write: (req: LocalThemeWriteRequest) => Promise<LocalThemeWriteResult>;
    openDir: () => Promise<LocalThemeOpenDirResult>;
    importExternal: () => Promise<import('../shared/theme-import/types').LocalThemeImportResult>;
  };
  terminal: import('../shared/terminal-bridge').TerminalBridge;
  appShortcuts: {
    getState: () => {
      overrides: import('../shared/appShortcuts').AppShortcutOverrides;

      platform: string;
    };
    setOverride: (
      id: import('../shared/appShortcuts').AppShortcutId,

      combo: import('../shared/appShortcuts').AppShortcutCombo | null,
    ) => Promise<{ overrides: import('../shared/appShortcuts').AppShortcutOverrides }>;
    clearOverride: (
      id: import('../shared/appShortcuts').AppShortcutId,
    ) => Promise<{ overrides: import('../shared/appShortcuts').AppShortcutOverrides }>;
    resetAll: () => Promise<{ overrides: import('../shared/appShortcuts').AppShortcutOverrides }>;
    setRecording: (active: boolean) => void;
    onChanged: (
      callback: (payload: {
        overrides: import('../shared/appShortcuts').AppShortcutOverrides;
      }) => void,
    ) => () => void;
  };
  layout: {
    getStateSync: () => { layout: import('../shared/layoutTree').Layout };
    set: (
      layout: import('../shared/layoutTree').Layout,
    ) => Promise<{ layout: import('../shared/layoutTree').Layout; persisted: boolean }>;
    reset: () => Promise<{
      layout: import('../shared/layoutTree').Layout;

      persisted: boolean;
    }>;
    onChanged: (
      callback: (payload: { layout: import('../shared/layoutTree').Layout }) => void,
    ) => () => void;
  };
  ghosts: {
    listSync: () => { ghosts: import('../shared/ghost').InstalledGhost[] };
    recentUsageSync: () => { ids: string[] };
    markUsed: (id: string) => Promise<{ ids: string[] }>;
    setupStatus: (id: string) => Promise<import('../shared/ghost').GhostSetupStatus>;
    onRecentUsageChanged: (callback: (payload: { ids: string[] }) => void) => () => void;
    install: (
      lizFilePath: string,

      /** enable:装入后立即开启(确认框勾选决定;缺省沉睡)。 */

      opts: { enable?: boolean; expectedPackageSha256: string },
    ) => Promise<{ ghost: import('../shared/ghost').InstalledGhost }>;
    update: (
      lizFilePath: string,

      opts: {
        expectedPackageSha256: string;

        expectedInstalledApproval: string;
      },
    ) => Promise<{ ghost: import('../shared/ghost').InstalledGhost }>;
    cindyPrefsSync: (id: string) => {
      overrides: Record<string, string>;

      image: CindyMediaPreferenceKind;

      imageEdit: CindyMediaPreferenceKind;

      video: CindyMediaPreferenceKind;

      videoEdit: CindyMediaPreferenceKind;

      /** 文本类(快问快答):选项是当前供应商目录的全部文本模型(cat: 编码钉值,

           *  带供应商/模型/徽标等结构化字段供富列表渲染);declaredModel = 身份卡声明

           *  的偏好模型(目录里解析得到才给,"跟随默认"行据此如实展示实际路由)。 */

      text: {
        options: Array<{
          id: string;

          label: string;

          group: string;

          providerId: string;

          agentKind: string;

          modelId: string;

          modelName: string;

          icon?: string;

          budget: boolean;

          subscription: boolean;

          routing?: ProviderRoutingPayload;

          agentSuffix?: string;
        }>;

        defaultModel: { id: string; label: string } | null;

        declaredModel?: { id: string; label: string } | null;

        /** 存量轻量档位钉(目录扩展前的合法钉值)的展示名表,老钉值回显友好名用。 */

        utilityProfiles?: Array<{ id: string; label: string }>;
      };

      /** 向量类(文本转向量):同 image/video 走目录派生。 */

      embed: {
        options: Array<{ id: string; label: string }>;

        defaultModel: { id: string; label: string } | null;
      };
    };
    setCindyPref: (
      id: string,

      capability: string,

      model: string | null,
    ) => Promise<{ overrides: Record<string, string> }>;
    errandPrefsSync: (id: string) => { config: Record<string, unknown> };
    setErrandConfig: (
      id: string,

      config: Record<string, unknown> | null,
    ) => Promise<{ config: Record<string, unknown> }>;
    pickFile: () => Promise<{ canceled: true } | { filePath: string }>;
    inspect: (lizFilePath: string) => Promise<{
      manifest: import('../shared/ghost').GhostManifest;

      trust: import('../shared/ghost').GhostTrustInfo;

      /** 本次检查的整包指纹；安装/更新时回传，防止确认后文件被替换。 */

      packageSha256: string;

      iconDataUrl?: string;
    }>;
    reapproveInspect: (id: string) => Promise<{
      manifest: import('../shared/ghost').GhostManifest;

      trust: import('../shared/ghost').GhostTrustInfo;

      /** 确认卡展示时的清单字节指纹;确认时回传,防确认间隙清单被换。 */

      manifestSha256: string;

      /** 确认卡展示时的完整批准投影指纹;覆盖技能、locale、icon、trust。 */

      approvalProjectionSha256: string;

      /** 升级前的启停偏好(.disabled 镜像读数):确认卡勾选默认值。 */

      previouslyEnabled: boolean;

      /** 一次性票据(Host 进程内钉住 inspect 时点的 owner 与事实,confirm 原子消费)。 */

      inspectTicket: string;
    }>;
    reapproveInstalled: (
      id: string,

      opts: {
        enable: boolean;

        expectedManifestSha256: string;

        expectedApprovalProjectionSha256: string;

        expectedInstalledApproval: string;

        inspectTicket: string;
      },
    ) => Promise<{ ghost: import('../shared/ghost').InstalledGhost }>;
    uninstall: (id: string) => Promise<{ ok: true }>;
    export: (
      id: string,
    ) => Promise<{ status: 'saved'; savedPath: string } | { status: 'canceled' }>;
    setEnabled: (id: string, enabled: boolean) => Promise<{ ok: true }>;
    workdirPrefsSync: (workdir: string) => { disabled: string[] };
    setWorkdirDisabled: (
      workdir: string,

      id: string,

      disabled: boolean,
    ) => Promise<{ disabled: string[] }>;
    takePendingInstall: () => Promise<{ filePath: string | null; channel: 'meka' | null }>;
    onChanged: (
      callback: (payload: { ghosts: import('../shared/ghost').InstalledGhost[] }) => void,
    ) => () => void;
    onSetupNavigate: (
      callback: (
        payload:
          | { sessionId: string; target: 'plugin_settings'; ghostId: string }
          | { sessionId: string; target: 'client_settings' },
      ) => void,
    ) => () => void;
    onInstallRequested: (callback: () => void) => () => void;
    onRuntimeChanged: (
      callback: (payload: { states: Record<string, string> }) => void,
    ) => () => void;
    onPreviewMedia: (
      callback: (payload: { ghostId: string; src: string; kind: 'image' | 'video' }) => void,
    ) => () => void;
    resolvePanelMedia: (
      uri: string,

      purpose?: 'attach' | 'menu',
    ) => Promise<
      | { url: string; kind?: 'image' }
      | {
          url: string;

          kind: 'video';

          absPath: string;

          size: number;

          name: string;

          ext: string;

          mimeType: string;
        }
    >;
    onCardUpdated: (
      callback: (payload: {
        callId: string;

        ghostId: string;

        toolUseId: string | null;

        /** 静态版(settle 后 / 历史回放;与落库一致)。 */

        html: string;

        /** 意识自绘动画版(白名单校验通过才有;仅 running 装载,不落库)。 */

        animatedHtml: string | null;

        height: number;

        /** 意识声明的后台活动状态(card-action 干活):'working' 过程态 /

             *  'done' 终版 / null 未声明。不落库,历史回放恒无。 */

        state?: 'working' | 'done' | null;
      }) => void,
    ) => () => void;
    onSessionActivity: (
      callback: (payload: { sessionId: string; busy: boolean }) => void,
    ) => () => void;
    getCard: (callId: string) => Promise<{
      card: { callId: string; ghostId: string; html: string; height: number; v: number } | null;
    }>;
    reportCardHeight: (callId: string, height: number) => Promise<{ ok: true }>;
    dispatchCardAction: (
      callId: string,

      actionId: string,

      prompt?: string,
    ) => Promise<{ ok: boolean }>;
    onUserMessageBlocked: (
      callback: (payload: {
        sessionId: string;

        clientId: string;

        ghostId: string;

        ghostName: string;

        reason: string;

        text: string;
      }) => void,
    ) => () => void;
    onUserMessageRewritten: (
      callback: (payload: {
        sessionId: string;

        clientId: string;

        ghostId: string;

        ghostName: string;

        text: string;

        originalText: string;
      }) => void,
    ) => () => void;
    onAssistantMessageRewritten: (
      callback: (payload: {
        sessionId: string;

        clientId: string;

        ghostId: string;

        ghostName: string;

        text: string;
      }) => void,
    ) => () => void;
    onAssistantMessagePending: (
      callback: (payload: { sessionId: string; clientId: string; pending: boolean }) => void,
    ) => () => void;
    listCardsBySession: (sessionId: string) => Promise<{
      cards: Array<{ callId: string; ghostId: string; html: string; height: number; v: number }>;
    }>;
    noteSessionFocused: (sessionId: string | null) => void;
    onHookFused: (callback: (payload: { ghostId: string; name: string }) => void) => () => void;
    onNotify: (
      callback: (payload: {
        ghostId: string;

        name: string;

        iconDataUrl?: string;

        text?: string;

        textKey?: string;

        textArgs?: Record<string, string>;

        tone: 'info' | 'success' | 'warning' | 'error';
      }) => void,
    ) => () => void;
    onBadge: (
      callback: (payload: {
        ghostId: string;

        unread: boolean;

        summary?: string;

        at?: number;
      }) => void,
    ) => () => void;
    onUnreadSnapshot: (
      callback: (payload: {
        entries: Array<{ ghostId: string; summary?: string; at: number }>;
      }) => void,
    ) => () => void;
    unreadSync: () => { entries: Array<{ ghostId: string; summary?: string; at: number }> };
    clearUnread: (id: string, seenAt?: number) => Promise<{ ok: boolean }>;
    onConfirmRequest: (
      callback: (payload: {
        requestId: string;

        ghostId: string;

        ghostName: string;

        iconDataUrl?: string;

        body: string;

        confirmText: string | null;

        cancelText: string | null;

        danger: boolean;
      }) => void,
    ) => () => void;
    resolveConfirm: (requestId: string, confirmed: boolean) => Promise<{ handled: boolean }>;
    onPreviewOpen: (
      callback: (payload: {
        ghostId: string;

        name: string;

        iconDataUrl?: string;

        sessionId: string;

        url: string;
      }) => void,
    ) => () => void;
    onScheduleDraft: (
      callback: (payload: {
        requestId: string;

        ghostId: string;

        ghostName: string;

        iconDataUrl?: string;

        name: string;

        prompt: string;

        intervalMs?: number;
      }) => void,
    ) => () => void;
    runtimeStates: () => Promise<{ states: Record<string, string> }>;
    reload: (id: string) => Promise<{ state: string }>;
    libraryOverview: (id: string) => Promise<import('../shared/ghost').GhostLibraryOverview>;
    libraryPickLocation: (id: string) => Promise<{
      ok: boolean;
      cancelled?: boolean;
      candidate?: string;
      warnings?: string[];
      message?: string;
    }>;
    libraryBind: (
      id: string,
      candidate: string,
    ) => Promise<{ ok: boolean; message?: string; warnings?: string[] }>;
    libraryRelocate: (id: string, candidate: string) => Promise<{ ok: boolean; message?: string }>;
    libraryRevertDefault: (id: string) => Promise<{ ok: boolean; message?: string }>;
    libraryUnbind: (id: string) => Promise<{ ok: boolean; message?: string }>;
    libraryDelete: (id: string) => Promise<{ ok: boolean; cancelled?: boolean; message?: string }>;
    legacyRecoveryStatus: () => Promise<
      import('../shared/legacyGhostRecovery').LegacyGhostRecoveryStatus
    >;
    retryLegacyRecovery: () => Promise<
      import('../shared/legacyGhostRecovery').LegacyGhostRecoveryStatus
    >;
    devRuntime: (
      action: 'status' | 'spawn' | 'stop' | 'crash',

      id?: string,
    ) => Promise<{ states?: Record<string, string>; state?: string }>;
    devCall: (id: string, tool: string, args: Record<string, unknown>) => Promise<unknown>;
    onContentReloaded: (callback: (payload: { id: string }) => void) => () => void;
  };
  pluginMarket: {
    snapshot: () => Promise<import('../shared/pluginMarket').PluginMarketSnapshot>;
    detail: (pluginId: string) => Promise<import('../shared/pluginMarket').PluginMarketDetail>;
    localIcons: (
      requests: import('../shared/pluginMarket').PluginMarketLocalIconRequest[],
    ) => Promise<import('../shared/pluginMarket').PluginMarketLocalIconResult[]>;
    install: (
      pluginId: string,

      options: import('../shared/pluginMarket').PluginMarketInstallOptions,
    ) => Promise<import('../shared/pluginMarket').PluginMarketInstallResult>;
    onPackagePermissionReview: (
      callback: (
        request: import('../shared/pluginMarket').PluginMarketPackageReviewRequest,
      ) => void,
    ) => () => void;
    resolvePackagePermissionReview: (
      requestId: string,

      confirmed: boolean,
    ) => Promise<{ handled: boolean }>;
    uninstall: (pluginId: string) => Promise<{ ok: true }>;
    consumeRemovalNotice: () => Promise<
      import('../shared/pluginMarket').PluginRemovalUserNotice | null
    >;
    onRemovalNoticeAvailable: (callback: () => void) => () => void;
    consumeUpgradeNotice: () => Promise<
      import('../shared/pluginMarket').PluginUpgradeUserNotice | null
    >;
    onUpgradeNoticeAvailable: (callback: () => void) => () => void;
    listSources: () => Promise<import('../shared/pluginMarket').MarketSourceSummary[]>;
    pickLocalSource: (
      defaultPath?: string,
    ) => Promise<
      | { canceled: true }
      | { canceled: false; summary: import('../shared/pluginMarket').MarketSourceSummary }
    >;
    addSource: (input: {
      source: string;

      ref?: string;

      sparsePaths?: string[];
    }) => Promise<import('../shared/pluginMarket').MarketSourceSummary>;
    removeSource: (name: string) => Promise<{ ok: true }>;
    refreshSource: (name: string) => Promise<import('../shared/pluginMarket').MarketSourceSummary>;
    gitPreflight: () => Promise<{ ok: boolean; version: string | null }>;
    markLocalInstall: (ghostId: string, expectedOwnerId: string) => Promise<{ ok: true }>;
  };
  voiceInput: {
    prewarm: (payload?: {
      sourceLanguage?: string;

      refinementEnabled?: boolean;
    }) => Promise<{ ok: true }>;
    getBenchmarkFixtureAudio: () => Promise<
      { ok: true; path: string; wav: ArrayBuffer } | { ok: false }
    >;
    getMicrophonePermissionCached: () =>
      { ok: true; status: string } | { ok: false; status: string; error: string };
    getSystemPermissionsCached: () => {
      microphone: { ok: true; status: string } | { ok: false; status: string; error: string };

      inputMonitoring: { ok: true; status: string } | { ok: false; status: string; error: string };

      accessibility: { ok: true; status: string } | { ok: false; status: string; error: string };
    };
    requestMicrophonePermission: () => Promise<{ ok: true } | { ok: false; error: string }>;
    setRendererMicrophonePermissionVerified: (verified: boolean) => Promise<{ ok: true }>;
    getSystemPermissions: () => Promise<{
      microphone: { ok: true; status: string } | { ok: false; status: string; error: string };

      inputMonitoring: { ok: true; status: string } | { ok: false; status: string; error: string };

      accessibility: { ok: true; status: string } | { ok: false; status: string; error: string };
    }>;
    openMicrophoneSettings: () => Promise<{ ok: true } | { ok: false; error: string }>;
    openInputMonitoringSettings: () => Promise<VoiceInputGlobalResult>;
    requestInputMonitoringPermission: () => Promise<{ ok: true; status: string }>;
    muteSystemAudio: () => Promise<{ ok: true } | { ok: false; error: string }>;
    restoreSystemAudio: () => Promise<{ ok: true } | { ok: false; error: string }>;
    testConnection: () => Promise<VoiceInputConnectionTestResult>;
    getReadiness: () => Promise<{
      ok: boolean;

      serviceMode: VoiceInputServiceModeData;

      provider:
        | 'custom-realtime-asr'
        | 'elevenlabs-scribe-realtime'
        | 'openai-realtime-whisper'
        | 'litellm-gpt-realtime-whisper'
        | 'litellm-qwen3-asr-flash-realtime'
        | 'litellm-volcengine-sauc-asr'
        | 'litellm-batch';

      providerModel: string;

      auth: 'api-key' | 'codex';

      settingsTab: 'api-keys' | 'connections' | 'providers';

      error?: string;

      authErrorReason?: string;

      failureReason?:
        'custom-asr-config-missing' | 'custom-asr-key-missing' | 'codex-realtime-unsupported';
    }>;
    getReadinessCached: () => {
      ok: boolean;

      serviceMode: VoiceInputServiceModeData;

      provider:
        | 'custom-realtime-asr'
        | 'elevenlabs-scribe-realtime'
        | 'openai-realtime-whisper'
        | 'litellm-gpt-realtime-whisper'
        | 'litellm-qwen3-asr-flash-realtime'
        | 'litellm-volcengine-sauc-asr'
        | 'litellm-batch';

      providerModel: string;

      auth: 'api-key' | 'codex';

      settingsTab: 'api-keys' | 'connections' | 'providers';

      error?: string;

      authErrorReason?: string;

      failureReason?:
        'custom-asr-config-missing' | 'custom-asr-key-missing' | 'codex-realtime-unsupported';
    } | null;
    getModelSelection: () => Promise<VoiceInputModelSelectionResultData>;
    setModelSelection: (patch: {
      serviceMode?: VoiceInputServiceModeData | null;

      asrProvider?: string | null;

      refinerProvider?: string | null;

      refinerModel?: string | null;

      customAsr?: {
        protocol: 'openai-realtime' | 'qwen-realtime';

        websocketUrl: string;

        model: string;
      } | null;

      customAsrApiKey?: string | null;

      /** BYOK fallback tail; null clears the override (primary runs alone). */

      refinerProviderChain?: string[] | null;
    }) => Promise<VoiceInputModelSelectionResultData>;
    reloadModelSelection: () => Promise<VoiceInputModelSelectionResultData>;
    openSettings: (tab: 'voice-input' | 'providers') => Promise<{ ok: true }>;
    start: (params?: {
      sourceLanguage?: string;

      refinementEnabled?: boolean;

      refinementCacheScope?: string;

      refinementContext?: VoiceRefinementContext;
    }) => Promise<{ ok: true; runId: string } | { ok: false; error: string }>;
    appendAudio: (chunk: { pcm16k: ArrayBuffer; trace?: VoiceAudioTrace }) => void;
    drainAudioQueue: () => Promise<{ ok: true }>;
    stop: () => Promise<{ ok: true } | { ok: false; error: string }>;
    cancel: (params?: { runId?: string }) => Promise<{ ok: true }>;
    onEvent: (callback: (event: VoiceInputRendererEvent) => void) => () => void;
    getDataSnapshot: () => VoiceInputDataSnapshot;
    migrateLegacyRendererData: (payload: {
      settingsRaw?: string | null;

      historyRaw?: string | null;
    }) => VoiceInputDataSnapshot;
    updateSettings: (patch: Partial<VoiceInputSettingsData>) => Promise<VoiceInputSettingsData>;
    updateShortcutSetting: (shortcut: VoiceInputShortcut | null) => Promise<
      | {
          ok: true;

          settings: VoiceInputSettingsData;

          /** 已存盘但 macOS 监听权限未授权，快捷键要等授权后才生效。 */

          pendingInputMonitoring?: boolean;
        }
      | { ok: false; error: string; errorCode?: VoiceInputGlobalErrorCode }
    >;
    deleteDictionaryEntries: (entryIds: string[]) => Promise<VoiceInputSettingsData>;
    addDictionaryEntry: (text: string) => Promise<VoiceInputSettingsData>;
    importDictionaryEntries: (texts: string[]) => Promise<VoiceInputSettingsData>;
    renameDictionaryEntry: (entryId: string, text: string) => Promise<VoiceInputSettingsData>;
    recordDictionaryLearningActions: (actions: VoiceInputDictionaryLearningAction[]) => Promise<{
      settings: VoiceInputSettingsData;

      newAutomaticEntries: Array<{ id: string; text: string }>;
    }>;
    getHistory: (limit?: number) => VoiceInputHistoryEntryData[];
    getHistoryForRefinement: () => VoiceInputHistoryEntryData[];
    recordHistory: (text: string) => string | null;
    updateHistoryEntry: (id: string, text: string) => void;
    deleteHistoryEntry: (id: string) => void;
    onDataChanged: (callback: (payload: VoiceInputDataSnapshot) => void) => () => void;
    setGlobalShortcut: (
      shortcut: VoiceInputShortcut | null,

      options?: { suspend?: true },
    ) => Promise<VoiceInputGlobalResult>;
    startModifierShortcutRecording: () => Promise<VoiceInputGlobalResult>;
    stopModifierShortcutRecording: () => Promise<VoiceInputGlobalResult>;
    onModifierShortcutKeys: (callback: (payload: { keys: string[] }) => void) => () => void;
    onShortcutRecoveryFailed: (callback: () => void) => () => void;
    consumeShortcutRecoveryFailure: () => Promise<{ failed: boolean }>;
    onGlobalShortcutTrigger: (
      callback: (payload?: { id?: string; phase?: 'start' | 'tap' | 'end' }) => void,
    ) => () => void;
    claimGlobalShortcutTrigger: (id: string) => void;
    onGlobalOverlayCommand: (
      callback: (command: { type: 'start' | 'submit' | 'cancel' }) => void,
    ) => () => void;
    adviseDictionaryLearning: (payload: VoiceInputDictionaryAdviceInput) => Promise<
      | {
          ok: true;

          actions: VoiceInputDictionaryLearningAction[];

          elapsedMs: number;

          ignoreReason?: string | null;
        }
      | { ok: false; error: string }
    >;
    onDictionaryLearningEvidence: (
      callback: (payload: {
        evidence: Pick<
          VoiceInputDictionaryAdviceInput,
          'source' | 'rawTranscriptText' | 'beforeText' | 'afterText' | 'context'
        >;
      }) => void,
    ) => () => void;
    onPowerStateChange: (callback: (payload: VoiceInputPowerStatePayload) => void) => () => void;
    notifyGlobalOverlayReady: () => void;
    pasteIntoFocusedTarget: (
      text: string,

      rawTranscriptText?: string,
    ) => Promise<VoiceInputGlobalResult>;
    restoreGlobalPasteTargetFocus: () => Promise<VoiceInputGlobalResult>;
    closeGlobalOverlay: (options?: { preservePasteTarget?: boolean }) => Promise<{ ok: true }>;
    showGlobalOverlay: () => Promise<VoiceInputGlobalResult>;
    beginGlobalOverlayDrag: () => void;
    moveGlobalOverlayDrag: () => void;
    endGlobalOverlayDrag: () => void;
    resetGlobalOverlayPosition: () => Promise<{ ok: true }>;
    openAccessibilitySettings: () => Promise<VoiceInputGlobalResult>;
    showDictionaryToast: (payload: {
      entryId?: string;

      term?: string;

      entries?: Array<{ entryId: string; term: string }>;
    }) => Promise<{ ok: true } | { ok: false; error: string }>;
    closeDictionaryToast: () => Promise<{ ok: true }>;
  };
  windowBehavior: {
    setSwallowActivationClick: (enabled: boolean) => Promise<{ ok: true }>;
    getWindowsCloseBehavior: () => Promise<'quit' | 'tray' | null>;
    setWindowsCloseBehavior: (behavior: 'quit' | 'tray') => Promise<'quit' | 'tray'>;
    onWindowsCloseBehaviorRequested: (callback: () => void) => () => void;
    notifyWindowsCloseBehaviorPromptShown: () => void;
  };
  workLouderCodex: {
    getState: () => Promise<WorkLouderCodexState>;
    setSettings: (patch: WorkLouderCodexSettingsPatch) => Promise<WorkLouderCodexState>;
    resetSettings: () => Promise<WorkLouderCodexState>;
    openInputMonitoringSettings: () => Promise<void>;
    probe: () => Promise<WorkLouderCodexState>;
    publishTasks: (
      tasks: import('../shared/workLouderCodex').WorkLouderCodexPublishedTask[],
    ) => Promise<void>;
    setLayoutPreviewActive: (active: boolean) => Promise<void>;
    onStateChanged: (callback: (state: WorkLouderCodexState) => void) => () => void;
    onAction: (callback: (action: WorkLouderCodexRendererAction) => void) => () => void;
    onPreviewInput: (
      callback: (input: import('../shared/workLouderCodex').WorkLouderCodexPreviewInput) => void,
    ) => () => void;
    dispatch: (action: unknown) => Promise<unknown>;
    previewInput: (input: unknown) => Promise<unknown>;
    openInputMonitoring: () => Promise<unknown>;
  };
  rightSidebarWindow: {
    getState: () => Promise<{ detached: boolean; lastOpen: boolean; open: boolean }>;
    open: (options?: { userInitiated?: boolean }) => Promise<void>;
    close: () => Promise<void>;
    setDetached: (
      detached: boolean,

      handoff?: import('../shared/rightSidebarWindow').RsbWindowTabHandoff,
    ) => Promise<{ detached: boolean; lastOpen: boolean; open: boolean }>;
    getContext: () => Promise<{
      sessionId: string | null;

      workdir: string | null;

      remoteHostId: string | null;

      deviceLinkDeviceId?: string | null;

      available: boolean;
    } | null>;
    ready: () => Promise<void>;
    rendererReady: () => Promise<void>;
    presentationReady: () => Promise<void>;
    refreshContext: () => Promise<void>;
    onVisibilityChanged: (cb: (payload: { visible: boolean }) => void) => () => void;
    sendCommand: (
      request: import('../shared/rightSidebarWindow').RsbWindowCommandRouteRequest,
    ) => Promise<import('../shared/rightSidebarWindow').RsbWindowCommandRouteResult>;
    setContext: (ctx: {
      sessionId: string | null;

      workdir: string | null;

      remoteHostId: string | null;

      deviceLinkDeviceId?: string | null;

      available: boolean;
    }) => void;
    onStateChanged: (cb: (state: { detached: boolean; open: boolean }) => void) => () => void;
    onContextChanged: (
      cb: (ctx: {
        sessionId: string | null;

        workdir: string | null;

        remoteHostId: string | null;

        deviceLinkDeviceId?: string | null;

        available: boolean;
      }) => void,
    ) => () => void;
    onTabHandoff: (
      callback: (handoff: import('../shared/rightSidebarWindow').RsbWindowTabHandoff) => void,
    ) => () => void;
    onCommand: (cb: (cmd: RsbWindowCommand) => void) => () => void;
  };
  resourceUsageWindow: {
    open: () => Promise<void>;
    close: () => Promise<void>;
    rendererReady: () => Promise<void>;
    presentationReady: () => Promise<void>;
    onSamplingActiveChanged: (cb: (active: boolean) => void) => () => void;
    onLocaleChanged: (
      cb: (locale: import('../shared/locale').SupportedLocale) => void,
    ) => () => void;
    onOpen: (callback: (active: boolean) => void) => () => void;
    onClose: (callback: () => void) => () => void;
    onVisibilityChanged: (callback: (payload: unknown) => void) => () => void;
  };
  ghostPanelWindow: {
    getStateSync: () => import('../shared/ghostPanelWindow').GhostPanelWindowsState;
    getState: () => Promise<import('../shared/ghostPanelWindow').GhostPanelWindowsState>;
    open: (ghostId: string) => Promise<void>;
    setDetached: (
      ghostId: string,

      detached: boolean,
    ) => Promise<import('../shared/ghostPanelWindow').GhostPanelWindowsState>;
    onStateChanged: (
      cb: (state: import('../shared/ghostPanelWindow').GhostPanelWindowsState) => void,
    ) => () => void;
    rendererReady: () => Promise<void>;
    presentationReady: () => Promise<void>;
    onVisibilityChanged: (cb: (payload: { visible: boolean }) => void) => () => void;
    onCloseRequested: (cb: () => void) => () => void;
    onMinimizeRequested: (cb: () => void) => () => void;
    resolveCloseRequest: (approved: boolean) => Promise<void>;
  };
  agentIsland: {
    setVisibleSession: (sessionId: string | string[] | null) => Promise<{ ok: true }>;
    setEnabled: (enabled: boolean) => Promise<{ ok: true }>;
    setSoundSettings: (settings: AgentIslandSoundSettings) => Promise<{ ok: true }>;
    setMascotSkin: (skin: AgentIslandMascotSkin) => Promise<{ ok: true }>;
    setDisplayTarget: (target: AgentIslandDisplayTarget) => Promise<{ ok: true }>;
    getDisplayOptions: () => Promise<{
      ok: true;

      options: AgentIslandDisplayOption[];

      target?: AgentIslandDisplayTarget;
    }>;
    previewSound: (sound: AgentIslandSoundChoice) => Promise<{ ok: true }>;
    selectSoundFile: () => Promise<{ ok: true; path: string | null; name: string | null }>;
    onSessionActivity: (cb: (list: AgentIslandSessionActivity[]) => void) => () => void;
  };
  findInPage: (params: {
    text: string;

    forward?: boolean;

    findNext?: boolean;

    matchCase?: boolean;
  }) => Promise<number | null>;
  stopFindInPage: (action?: 'clearSelection' | 'keepSelection' | 'activateSelection') => void;
  onFindInPageResult: (
    callback: (result: {
      requestId: number;

      activeMatchOrdinal: number;

      matches: number;

      finalUpdate: boolean;
    }) => void,
  ) => () => void;
  onSelectionContextMenuAddToChat: (callback: () => void) => () => void;
  safeStorageStore: (key: string, value: string) => Promise<boolean>;
  safeStorageRead: (key: string) => Promise<string | null>;
  safeStorageRemove: (key: string) => Promise<{ success: boolean; error?: string }>;
  builtinApiKeyHas: (providerId: string) => Promise<boolean>;
  builtinApiKeyStore: (providerId: string, value: string) => Promise<void>;
  builtinApiKeyRemove: (providerId: string) => Promise<void>;
  ccSetDebugNet: (enabled: boolean) => Promise<{ ok: true }>;
  modelAccess: {
    getStatus: () => Promise<ModelAccessStatusPayload>;
    retry: () => Promise<ModelAccessStatusPayload>;
    rotate: () => Promise<ModelAccessStatusPayload>;
    onStatusChange: (callback: (status: ModelAccessStatusPayload) => void) => () => void;
  };
  authHasPersistedSessionHintSync: () => boolean;
  authInitialize: () => Promise<{
    user: AuthUser | null;

    mode: 'signed-out' | 'local' | 'cloud';

    edition: 'cn' | 'global' | 'dev';

    dataOwnerId: string | null;

    ownerGeneration: number;

    canEnterApp: boolean;

    isAuthenticated: boolean;

    isCanary: boolean;

    /** SkillHub 跨设备识别：本机 deviceId，登录前后都有值 */

    deviceId: string;

    hasAccountDeletionReceipt: boolean;

    accountDeletionRestored: boolean;

    /** 持久凭证库(safeStorage)连续多个刷新周期不可用(#1687)。 */

    credentialStoreUnavailable?: boolean;
  }>;
  authGetLoginState: () => Promise<DesktopLoginActionResult>;
  authDispatchLoginAction: (action: DesktopLoginAction) => Promise<DesktopLoginActionResult>;
  authGetCaptchaChallengeUrl: () => Promise<string>;
  authLogout: () => Promise<void>;
  authEnterLocal: () => Promise<AuthStateChangePayload>;
  authExitLocal: () => Promise<AuthStateChangePayload>;
  authRefresh: () => Promise<boolean>;
  authGetAccountDeletionAvailability: () => Promise<DesktopAccountDeletionAvailabilityResult>;
  authRequestAccountDeletionChallenge: () => Promise<DesktopAccountDeletionChallengeResult>;
  authConfirmAccountDeletion: (
    input: DesktopAccountDeletionConfirmInput,
  ) => Promise<DesktopAccountDeletionConfirmResult>;
  authGetAccountDeletionStatus: () => Promise<DesktopAccountDeletionStatusResult>;
  authClearAccountDeletionReceipt: () => Promise<void>;
  authConsumeAccountDeletionRestoredNotice: () => Promise<boolean>;
  onAuthStateChange: (callback: (state: AuthStateChangePayload) => void) => () => void;
  onAuthSessionExpired: (callback: (state: AuthSessionExpiredPayload) => void) => () => void;
  getAnalyticsSettings: () => Promise<AnalyticsSettingsPayload>;
  setAnalyticsEnabled: (enabled: boolean) => Promise<AnalyticsSettingsPayload>;
  resetAnalyticsEnabled: () => Promise<AnalyticsSettingsPayload>;
  acceptPrivacyConsent: () => Promise<AnalyticsSettingsPayload>;
  onAnalyticsSettingsChange: (callback: (payload: AnalyticsSettingsPayload) => void) => () => void;
  getLogUploadSettings: () => Promise<LogUploadSettingsPayload>;
  setLogUploadCrashAuto: (enabled: boolean) => Promise<LogUploadSettingsPayload>;
  resetLogUploadCrashAuto: () => Promise<LogUploadSettingsPayload>;
  uploadLogsNow: () => Promise<LogUploadResult>;
  onLogUploadSettingsChange: (callback: (payload: LogUploadSettingsPayload) => void) => () => void;
  profileGetState: () => Promise<{
    name: string;

    avatarUrl: string | null;
  }>;
  profileChooseAvatar: () => Promise<{
    canceled: boolean;

    filePath?: string;

    previewDataUrl?: string;
  }>;
  profileUpdate: (params: {
    name: string | null;

    avatar: { type: 'keep' } | { type: 'set'; filePath: string } | { type: 'reset' };
  }) => Promise<{ ok: true }>;
  feishuBot: {
    getState: () => Promise<{
      status: FeishuBotStatus;

      appId: string | null;

      appSecret: string | null;

      hasSecret: boolean;

      ownerOpenId: string | null;

      error?: string;

      lifecycleAnnouncement: boolean;

      service: 'feishu' | 'lark';
    }>;
    save: (payload: { appId: string; appSecret: string; service: 'feishu' | 'lark' }) => Promise<{
      verdict: 'connected' | 'conflict' | 'error' | 'pending';
    }>;
    reconnect: () => Promise<{
      verdict: 'connected' | 'conflict' | 'error';
    }>;
    clear: () => Promise<{ ok: true }>;
    setLifecycleAnnouncement: (enabled: boolean) => Promise<{ ok: true }>;
    registrationBegin: (service: 'feishu' | 'lark') => Promise<FeishuBotRegistrationBeginResult>;
    registrationCancel: () => Promise<{ ok: true }>;
    onStatusChange: (
      callback: (update: {
        status: FeishuBotStatus;

        error?: string;

        botAppId: string | null;

        ownerOpenId: string | null;
      }) => void,
    ) => () => void;
    onConflict: (callback: (payload: { appId: string }) => void) => () => void;
    onRegistrationStatus: (
      callback: (payload: FeishuBotRegistrationStatusPayload) => void,
    ) => () => void;
  };
  discordBot: {
    getStatus: () => Promise<{
      status: DiscordBotTransportStatus;

      ownerUserId: string | null;

      lifecycleAnnouncement: boolean;
    }>;
    setConfig: (payload: { token: string; ownerUserId: string }) => Promise<{
      status: DiscordBotTransportStatus;

      saveErrorStatus?: DiscordBotTransportStatus;

      ownerUserId: string | null;
    }>;
    disconnect: () => Promise<{
      status: DiscordBotTransportStatus;
    }>;
    setLifecycleAnnouncement: (enabled: boolean) => Promise<{
      ok: boolean;

      lifecycleAnnouncement: boolean;
    }>;
    checkSessionAuth: () => Promise<DiscordBotSessionAuthCheckResult>;
    onStatusChange: (
      callback: (update: { status: DiscordBotTransportStatus }) => void,
    ) => () => void;
  };
  telegramBot: {
    getStatus: () => Promise<{
      status: TelegramBotTransportStatus;

      ownerUserId: string | null;

      botUsername: string | null;
    }>;
    setConfig: (payload: { token: string; ownerUserId: string }) => Promise<{
      status: TelegramBotTransportStatus;

      saveErrorStatus?: TelegramBotTransportStatus;

      ownerUserId: string | null;

      botUsername: string | null;
    }>;
    disconnect: () => Promise<{
      status: TelegramBotTransportStatus;
    }>;
    setOnline: (payload: { online: boolean }) => Promise<{
      status: TelegramBotTransportStatus;
    }>;
    checkSessionAuth: () => Promise<DiscordBotSessionAuthCheckResult>;
    getBehavior: () => Promise<TelegramBotBehavior>;
    setBehavior: (patch: Partial<TelegramBotBehavior>) => Promise<TelegramBotBehavior>;
    listGroups: () => Promise<{
      groups: Array<{ chatId: string; chatName: string | null; activation: 'mention' | 'always' }>;
    }>;
    setGroupActivation: (payload: {
      chatId: string;

      mode: 'mention' | 'always';
    }) => Promise<unknown>;
    getPersona: () => Promise<{ botName: string; soul: string }>;
    setPersona: (payload: {
      botName?: string;

      soul?: string;

      syncProfile?: boolean;
    }) => Promise<{ persona: { botName: string; soul: string }; profileSynced?: boolean }>;
    onStatusChange: (
      callback: (update: {
        status: TelegramBotTransportStatus;

        botUsername: string | null;
      }) => void,
    ) => () => void;
  };
  dingtalkBot: {
    getState: () => Promise<{
      status: DingTalkBotTransportStatus;

      appKey: string | null;

      hasSecret: boolean;

      ownerUserId: string | null;
    }>;
    save: (payload: { appKey: string; appSecret: string }) => Promise<{
      status: DingTalkBotTransportStatus;

      appKey: string | null;

      hasSecret: boolean;

      ownerUserId: string | null;
    }>;
    reconnect: () => Promise<{
      status: DingTalkBotTransportStatus;

      appKey: string | null;

      hasSecret: boolean;

      ownerUserId: string | null;
    }>;
    clear: () => Promise<{ ok: true }>;
    onStatusChange: (
      callback: (update: { status: DingTalkBotTransportStatus }) => void,
    ) => () => void;
    onOwnerChange: (callback: (update: { ownerUserId: string }) => void) => () => void;
  };
  wecomBot: {
    getStatus: () => Promise<{
      status: WecomBotTransportStatus;

      botId: string | null;

      ownerUserId: string | null;
    }>;
    setConfig: (payload: { botId: string; secret: string }) => Promise<{
      status: WecomBotTransportStatus;

      saveErrorStatus?: WecomBotTransportStatus;

      botId: string | null;

      ownerUserId: string | null;
    }>;
    reconnect: () => Promise<{
      status: WecomBotTransportStatus;

      botId: string | null;

      ownerUserId: string | null;
    }>;
    disconnect: () => Promise<{
      status: WecomBotTransportStatus;

      botId: string | null;

      ownerUserId: string | null;
    }>;
    onStatusChange: (
      callback: (update: {
        status: WecomBotTransportStatus;

        botId: string | null;

        ownerUserId: string | null;
      }) => void,
    ) => () => void;
  };
  wechatBot: {
    getState: () => Promise<WechatBotState>;
    authorize: () => Promise<{ started: true }>;
    cancelAuthorization: () => Promise<{ ok: true }>;
    unbind: () => Promise<{ ok: true }>;
    getChannelSettings: () => Promise<WechatChannelSettingsState>;
    chooseWorkingDirectory: () => Promise<{
      canceled: boolean;

      state: WechatChannelSettingsState;
    }>;
    resetWorkingDirectory: () => Promise<WechatChannelSettingsState>;
    onStateChange: (callback: (state: WechatBotState) => void) => () => void;
  };
  appReadyForBot: () => Promise<{ ok: true }>;
  syncDesktopCcPrefs: (prefs: {
    model: string;

    effort: string;

    permissionMode: string;

    fastMode: boolean;

    providerId: string | null;
  }) => void;
  syncNewMakerDraft: (snapshot: {
    lastByVendor: Partial<
      Record<
        'cc' | 'codex' | 'pi',
        { model?: string; effort?: string; permissionMode?: string; providerId?: string | null }
      >
    >;

    /** 每个 vendor 是否由用户在 New Maker 中明确选过模型；device-link 默认校准据此保护显式选择。 */

    modelChosenByVendor: Partial<Record<'cc' | 'codex' | 'pi', boolean>>;

    fastModeByModel: Record<string, boolean>;

    effortByModel: Record<string, string>;

    /** 「新建会话默认启用 worktree」勾选记忆(vendor 无关根字段,远程草稿播种用)。 */

    worktreeEnabled: boolean;
  }) => void;
  syncWorkerCreationPrefs: (snapshot: {
    workerPermissionMode: 'auto' | 'bypassPermissions';
  }) => void;
  syncProviderModelMemory: (
    snapshot: Record<
      string,
      { effortByModel: Record<string, string>; fastByModel: Record<string, boolean> }
    >,
  ) => void;
  syncSessionModelPref: (pref: {
    sessionId: string;

    agent: 'claude-code' | 'codex' | 'pi';

    providerId: string;

    model: string;

    effort?: string;

    fast?: boolean;
  }) => void;
  onMakerDraftPrefApply: (
    cb: (payload: {
      agent: 'claude-code' | 'codex' | 'pi';

      providerId: string;

      modelId: string;

      active: boolean;

      markModelChoice?: boolean;

      effort?: string;

      fast?: boolean;
    }) => void,
  ) => () => void;
  onMakerWorktreePrefApply: (cb: (payload: { worktreeEnabled: boolean }) => void) => () => void;
  getNewMakerWorktreeBranchPreference: (
    baseRepo: string,
  ) => Promise<NewMakerWorktreeBranchPreferenceSnapshot | null>;
  applyNewMakerWorktreeBranchPreference: (
    baseRepo: string,

    sourceBranch: string,
  ) => Promise<NewMakerWorktreeBranchPreferenceSnapshot>;
  onNewMakerWorktreeBranchChanged: (
    cb: (snapshot: NewMakerWorktreeBranchPreferenceSnapshot) => void,
  ) => () => void;
  onWorkerCreationPrefsApply: (
    cb: (payload: { workerPermissionMode: 'auto' | 'bypassPermissions' }) => void,
  ) => () => void;
  onMakerSessionPrefApply: (
    cb: (payload: {
      sessionId: string;

      agent: 'claude-code' | 'codex' | 'pi';

      providerId: string;

      model: string;

      effort?: string;

      fast?: boolean;
    }) => void,
  ) => () => void;
  binding: {
    resolveSession: (sessionId: string) => Promise<{
      attached: boolean;

      identity?: { channel: string; botContextId: string; userId: string } | null;

      displayName?: string | null;
    }>;
    revoke: (sessionId: string) => Promise<{
      ok: true;

      alreadyDetached?: boolean;
    }>;
    listAttached: () => Promise<{ sessionIds: string[] }>;
    onChanged: (
      callback: (payload: {
        sessionId: string | null;

        attached: boolean;

        channel: string | null;

        userId: string | null;
      }) => void,
    ) => () => void;
  };
  checkEnvironment: () => Promise<EnvCheckResult>;
  onBinaryDownloadProgress: (
    callback: (payload: BinaryDownloadProgressPayload) => void,
  ) => () => void;
  checkAppUpdate: () => Promise<{
    hasUpdate: boolean;

    action?: 'relaunch' | 'none';

    version?: string;

    error?: 'manifest_failed' | 'download_failed';
  }>;
  onAppUpdateProgress: (callback: (payload: AppUpdateProgressPayload) => void) => () => void;
  fileBrowser: {
    listDir: (params: {
      /** 非空 = SSH remote 会话,操作经远端 file-service 执行(main 侧路由)。 */

      remoteHostId?: string | null;

      workdir: string;

      relPath?: string;

      hideMetaFiles?: boolean;

      docMode?: boolean;
    }) => Promise<
      Array<{
        name: string;

        relPath: string;

        type: 'file' | 'directory';

        size: number;

        mtimeMs: number;
      }>
    >;
    listAllFiles: (params: {
      remoteHostId?: string | null;

      workdir: string;

      cap?: number;
    }) => Promise<{
      files: string[];

      truncated: boolean;

      elapsedMs: number;

      error?: string;
    }>;
    readFile: (params: {
      remoteHostId?: string | null;

      workdir: string;

      relPath: string;
    }) => Promise<
      | {
          ok: true;

          data: {
            relPath: string;

            content: string;

            size: number;

            mtimeMs: number;

            truncated: boolean;
          };
        }

      /** OVERSIZE = 远程文本超传输上限(device-link 帧限预判),stat 供"文件过大"占位卡。 */
      | { ok: false; code: 'BINARY_FILE' | 'READ_FAILED'; message?: string }
      | {
          ok: false;

          code: 'OVERSIZE';

          stat: { relPath: string; type: 'file'; size: number; mtimeMs: number };
        }
    >;
    writeFile: (params: {
      remoteHostId?: string | null;

      workdir: string;

      relPath: string;

      content: string;
    }) => Promise<{ ok: true; size: number; mtimeMs: number } | { ok: false; message: string }>;
    createFile: (params: {
      remoteHostId?: string | null;

      workdir: string;

      relPath: string;
    }) => Promise<
      | {
          ok: true;

          stat: { relPath: string; type: 'file' | 'directory'; size: number; mtimeMs: number };
        }
      | { ok: false; message: string }
    >;
    createFolder: (params: {
      remoteHostId?: string | null;

      workdir: string;

      relPath: string;
    }) => Promise<
      | {
          ok: true;

          stat: { relPath: string; type: 'file' | 'directory'; size: number; mtimeMs: number };
        }
      | { ok: false; message: string }
    >;
    deleteEntry: (params: {
      remoteHostId?: string | null;

      workdir: string;

      relPath: string;
    }) => Promise<{ ok: true } | { ok: false; message: string }>;
    renameEntry: (params: {
      remoteHostId?: string | null;

      workdir: string;

      fromRel: string;

      toRel: string;
    }) => Promise<
      | {
          ok: true;

          stat: { relPath: string; type: 'file' | 'directory'; size: number; mtimeMs: number };
        }
      | { ok: false; message: string }
    >;
    stat: (params: { remoteHostId?: string | null; workdir: string; relPath: string }) => Promise<{
      relPath: string;

      type: 'file' | 'directory';

      size: number;

      mtimeMs: number;
    }>;
    startWatch: (params: {
      remoteHostId?: string | null;

      workdir: string;

      hideMetaFiles?: boolean;
    }) => Promise<{ ok: boolean }>;
    stopWatch: (params: {
      remoteHostId?: string | null;

      workdir: string;
    }) => Promise<{ ok: boolean }>;
    onEvent: (
      cb: (event: {
        workdir: string;

        type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';

        relPath: string;
      }) => void,
    ) => () => void;
    fetchRemote: (params: {
      workdir: string;

      relPath: string;

      size: number;

      mtimeMs: number;

      remoteHostId?: string | null;

      deviceId?: string | null;
    }) => Promise<{ ok: true; cachePath: string; stale: boolean } | { ok: false; message: string }>;
    readCached: (params: {
      cachePath: string;
    }) => Promise<
      | { ok: true; kind: 'text'; content: string; truncated: boolean }
      | { ok: true; kind: 'binary' }
      | { ok: false; message: string }
    >;
    cachePut: (params: {
      workdir: string;

      relPath: string;

      size: number;

      mtimeMs: number;

      content: string;

      remoteHostId?: string | null;

      deviceId?: string | null;
    }) => Promise<{ ok: boolean }>;
    onTransferProgress: (
      cb: (event: {
        workdir: string;

        relPath: string;

        received: number;

        total: number;

        phase?: 'upload' | 'download';
      }) => void,
    ) => () => void;
    chatFetch: (params: {
      origin: { kind: 'device'; deviceId: string } | { kind: 'ssh'; remoteHostId: string };

      workdir: string;

      absPath: string;
    }) => Promise<
      | { ok: true; cachePath: string; stale: boolean; size: number }
      | {
          ok: false;

          code: 'BAD_ARGS' | 'OUTSIDE_WORKDIR' | 'NOT_FOUND' | 'FETCH_FAILED';

          message?: string;
        }
    >;
    chatStat: (params: {
      origin: { kind: 'device'; deviceId: string } | { kind: 'ssh'; remoteHostId: string };

      workdir: string;

      absPath: string;
    }) => Promise<{ verdict: 'file' | 'directory' | 'nonfile' | 'unknown' }>;
  };
  search: {
    start: (params: {
      /** 非空 = SSH remote 会话;P3 接远端 rg 前 main 直接拒绝。 */

      remoteHostId?: string | null;

      workdir: string;

      query: string;

      caseSensitive: boolean;

      maxMatches: number;
    }) => Promise<
      | {
          ok: true;

          searchId: string;

          /** 远程搜索启动窗口内 daemon 秒回的事件,随响应带回由 renderer 回放。 */

          replay?: Array<
            | {
                type: 'match';

                searchId: string;

                relPath: string;

                lineNumber: number;

                lineText: string;

                submatches: Array<{ start: number; end: number }>;
              }
            | {
                type: 'end';

                searchId: string;

                truncated: boolean;

                totalMatches: number;

                totalFiles: number;
              }
            | { type: 'error'; searchId: string; message: string }
          >;
        }

      /** code = 稳定错误码(如 RG_UNAVAILABLE),renderer 按码映射友好文案。 */
      | { ok: false; message: string; code?: string }
    >;
    cancel: (params: { searchId: string; remoteHostId?: string | null }) => Promise<{ ok: true }>;
    onEvent: (
      cb: (
        event:
          | {
              type: 'match';

              searchId: string;

              relPath: string;

              lineNumber: number;

              lineText: string;

              submatches: Array<{ start: number; end: number }>;
            }
          | {
              type: 'end';

              searchId: string;

              truncated: boolean;

              totalMatches: number;

              totalFiles: number;
            }
          | { type: 'error'; searchId: string; message: string },
      ) => void,
    ) => () => void;
  };
  showOpenDirectoryDialog: () => Promise<{ canceled: boolean; path?: string }>;
  openExternal: (url: string) => Promise<{ success: boolean }>;
  openChatGPTApp: () => Promise<{ success: boolean }>;
  openFileInBrowser: (filePathOrUrl: string) => Promise<{ success: true }>;
  notificationShowSessionEvent: (payload: {
    sessionId: string;

    title: string;

    kind: 'done' | 'error' | 'needs-reply';

    /**

       * 选择性走哪些通知通道; 缺省 / 未传 → 兼容旧行为(仅桌面)。

       * renderer 侧 gate(localStorage notifications.enabled /

       * notifications.feishuEnabled)后填入。

       * mobile = 手机推送:桌面侧无独立开关(手机端注册/注销 token 决定接收),

       * 发送侧防打扰在 main 的 device-link 模块收口,renderer 恒传 true。

       */

    channels?: { desktop?: boolean; feishu?: boolean; mobile?: boolean };
  }) => Promise<void>;
  notificationSetDesktopEnabled?: (enabled: boolean) => Promise<{ ok: true }>;
  wecomGroupNotification: {
    getState: () => Promise<{ configured: boolean; enabled: boolean; maskedKey?: string }>;
    saveAndTest: (
      webhookUrl: string,

      testMessage: string,
    ) => Promise<{ configured: boolean; enabled: boolean; maskedKey?: string }>;
    test: (testMessage: string) => Promise<{ ok: true }>;
    setEnabled: (
      enabled: boolean,
    ) => Promise<{ configured: boolean; enabled: boolean; maskedKey?: string }>;
    clear: () => Promise<{ configured: boolean; enabled: boolean }>;
  };
  notificationMarkSessionAttention: (sessionId: string) => Promise<void>;
  notificationClearSessionAttention: (
    sessionId: string,

    intent?: 'explicit' | 'passive',
  ) => Promise<void>;
  onSessionAttentionCleared: (callback: (payload: unknown) => void) => () => void;
  onNotificationFocusSession: (callback: (sessionId: string) => void) => () => void;
  onRsbBrowserPopup: (
    callback: (payload: {
      url: string;

      disposition: string;

      openerTabId?: string;

      openerSessionId?: string;

      nativePopupSurfaceId?: string;
    }) => void,
  ) => () => void;
  rsbNativePopup: {
    claim: (
      input: import('../shared/rsbNativePopup').RsbNativePopupClaimInput,
    ) => Promise<import('../shared/rsbNativePopup').RsbNativePopupClaimResult>;
    setBounds: (input: {
      surfaceId: string;

      bounds: import('../shared/rsbNativePopup').RsbNativePopupBounds;

      visible: boolean;
    }) => Promise<{ ok: true }>;
    command: (
      input: { surfaceId: string } & import('../shared/rsbNativePopup').RsbNativePopupCommand,
    ) => Promise<{ ok: true }>;
    close: (input: { surfaceId: string }) => Promise<{ ok: true }>;
    onEvent: (
      callback: (event: import('../shared/rsbNativePopup').RsbNativePopupEvent) => void,
    ) => () => void;
  };
  onRsbBrowserFocusUrlBar: (callback: () => void) => () => void;
  onRsbBrowserCommand: (
    callback: (payload: {
      command:
        'go-back' | 'go-forward' | 'reload' | 'close-tab' | 'right-tab-prev' | 'right-tab-next';
    }) => void,
  ) => () => void;
  onDeepLinkNavigate: (
    callback: (
      payload:
        | { type: 'session'; id: string; messageClientId?: string }
        | { type: 'project'; workingDir: string }
        | { type: 'new-session'; workingDir: string }
        | { type: 'share-import'; filePath: string }
        | { type: 'settings'; tab: 'voice-input' | 'providers'; connect?: string },
    ) => void,
  ) => () => void;
  takePendingDeepLink: () => Promise<
    | { type: 'session'; id: string; messageClientId?: string }
    | { type: 'project'; workingDir: string }
    | { type: 'new-session'; workingDir: string }
    | { type: 'share-import'; filePath: string }
    | { type: 'settings'; tab: 'voice-input' | 'providers'; connect?: string }
    | null
  >;
  readTextFilePreview: (params: { filePath: string }) => Promise<{
    success: boolean;

    error?: string;

    reason?: 'oversize' | 'not_found' | 'forbidden' | 'read_failed';

    data?: string;

    size: number;

    limitMb?: number;
  }>;
  openPath: (filePath: string) => Promise<{ success: boolean; error?: string }>;
  listOpenWithApps: (params: { filePath: string }) => Promise<{
    success: boolean;

    apps: Array<{ id: string; label: string; iconDataUrl?: string }>;

    error?: string;
  }>;
  openFileWithApp: (params: { filePath: string; appId: string }) => Promise<void>;
  stageChatAttachment: (params: { sourcePath: string; suggestedName: string }) => Promise<
    | { success: true; path: string }
    | {
        success: false;

        code:
          | 'invalid_source'
          | 'forbidden'
          | 'not_found'
          | 'not_file'
          | 'unsupported_type'
          | 'copy_failed';
      }
  >;
  cleanupStagedChatAttachments: (filePaths: readonly string[]) => Promise<void>;
  saveChatAttachmentAs: (params: { sourcePath: string; suggestedName: string }) => Promise<
    | { status: 'saved'; savedPath: string }
    | { status: 'canceled' }
    | {
        status: 'error';

        code:
          | 'invalid_source'
          | 'forbidden'
          | 'not_found'
          | 'not_file'
          | 'dialog_failed'
          | 'copy_failed';
      }
  >;
  openLogsDir: () => Promise<{ success: boolean; error?: string }>;
  showItemInFolder: (params: {
    url?: string;

    filePath?: string;
  }) => Promise<{ success: boolean; error?: string }>;
  copyMediaToClipboard: (params: {
    url?: string;

    filePath?: string;
  }) => Promise<{ success: boolean; error?: string }>;
  openMediaWithDefaultApp: (params: { url: string }) => Promise<void>;
  saveMediaAs: (params: { url: string }) => Promise<{ canceled: boolean; savedPath?: string }>;
  cacheMediaForSession: (params: {
    url: string;

    sessionId: string;
  }) => Promise<{ url: string; name: string; ext: string; mimeType: string; size: number }>;
  readImageBytes: (params: { url: string }) => Promise<{ base64: string; mimeType: string }>;
  getFileThumbnail: (params: {
    path: string;

    size: number;

    /** 显式复核:跳过正缓存重新生成(负缓存仍尊重)。焦点复核时传 true。 */

    revalidate?: boolean;
  }) => Promise<{ dataUrl: string | null; byteSize: number } | null>;
  resolvePath: (params: { href: string; workingDir: string }) => Promise<{
    status: 'unique' | 'multiple' | 'none';

    candidates: string[];

    /** unique 命中时的目标类型;缺省按 file 理解(老 main 兼容)。 */

    kind?: 'file' | 'directory';
  }>;
  resolvePathBatch: (params: {
    hrefs: string[];

    workingDir: string;
  }) => Promise<
    Record<
      string,
      { status: 'unique' | 'multiple' | 'none'; candidates: string[]; kind?: 'file' | 'directory' }
    >
  >;
  fsBrowse: {
    listDir: (path: string) => Promise<{
      resolvedPath: string;

      entries: { name: string; kind: 'dir' | 'symlink'; path: string }[];

      parent: string | null;
    }>;
    statPath: (path: string) => Promise<{
      kind: 'dir' | 'file' | 'missing';

      resolvedPath: string;

      mtimeMs?: number;

      birthtimeMs?: number;
    }>;
    mkdirP: (path: string) => Promise<{ resolvedPath: string }>;
  };
  getFilePath: (file: File) => string;
  readFileForAttachment: (params: {
    filePath: string;

    encoding: 'base64' | 'utf8';

    maxSize?: number;
  }) => Promise<{
    success: boolean;

    error?: string;

    data?: string;

    size: number;

    truncated?: boolean;
  }>;
  readFileBytes: (params: {
    filePath: string;

    maxSize?: number;
  }) => Promise<{ bytes: Uint8Array; size: number }>;
  peekFileHeader: (params: { filePath: string; bytes?: number }) => Promise<{
    success: boolean;

    error?: string;

    /** base64-encoded leading bytes; present when actualBytes > 0. */

    data?: string;

    /** Actual number of bytes read (may be < requested for tiny / empty files). */

    actualBytes: number;

    /** Total file size from fs.stat. */

    totalSize: number;
  }>;
  scanAtResources: (params: {
    workingDir: string;

    cap?: number;

    query?: string;

    agentKind?: 'claude-code' | 'codex' | 'pi';
  }) => Promise<{
    success: boolean;

    error?: string;

    items?: Array<
      | { type: 'file'; name: string; relPath: string; description?: string }
      | { type: 'dir'; name: string; relPath: string; description?: string }
      | { type: 'agent'; name: string; relPath: string; description?: string }
    >;

    truncated?: boolean;
  }>;
  learn: {
    start: (req: import('../shared/learnTypes').LearnStartRequest) => Promise<{ runId: string }>;
    listRuns: () => Promise<{
      runs: import('../shared/learnTypes').LearnRunPublic[];

      ready: boolean;
    }>;
    getProposalDiff: (params: {
      runId: string;
    }) => Promise<import('../shared/learnTypes').LearnProposalDiff>;
    apply: (params: {
      runId: string;
    }) => Promise<{ name: string; absolutePath: string; replacedBackupPath?: string }>;
    discard: (params: { runId: string }) => Promise<{ ok: boolean }>;
    cancel: (params: { runId: string }) => Promise<{ ok: boolean }>;
    onEvent: (
      callback: (payload: import('../shared/learnTypes').LearnEventPayload) => void,
    ) => () => void;
  };
  skillhub: {
    scan: (params: { projects?: SkillhubProjectInput[] }) => Promise<{
      success: boolean;

      error?: string;

      skills?: SkillhubSkill[];

      sources?: SkillhubSourceReport[];
    }>;
    readSkill: (params: { mdPath: string }) => Promise<{
      success: boolean;

      error?: string;

      content?: string;
    }>;
    listChildren: (params: { dirPath: string }) => Promise<{
      success: boolean;

      error?: string;

      entries?: SkillhubFileEntry[];
    }>;
    readSiblingFile: (params: { filePath: string }) => Promise<{
      success: boolean;

      error?: string;

      content?: string;
    }>;
    readRaw: (params: { filePath: string }) => Promise<{
      success: boolean;

      error?: string;

      content?: string;
    }>;
    writeFile: (params: { filePath: string; content: string }) => Promise<{
      success: boolean;

      error?: string;
    }>;
    validateFrontmatter: (params: {
      content: string;

      kind: 'skill' | 'command' | 'agent' | 'sibling';
    }) => Promise<
      | { success: true; issues: { field: string; message: string }[] }
      | { success: false; error: string }
    >;
    renameLocal: (params: {
      absolutePath: string;

      newName: string;
    }) => Promise<{ success: true; newAbsolutePath: string } | { success: false; error: string }>;
    sync: (
      params:
        | string[]
        | {
            slugs?: string[];
          },
    ) => Promise<{
      success: boolean;

      error?: string;

      results?: SkillhubSyncResult[];

      availableUninstalledCount?: number;
    }>;
    listMarket: (params?: {
      cursor?: string;

      limit?: number;

      sort?: 'trending' | 'downloads' | 'updated_at' | 'created_at';

      q?: string;

      mine?: boolean;

      /** Legacy: Hub-side available filtering switch. Current renderer keeps this false and filters locally. */

      available?: boolean;

      category?: string;

      /** Legacy: Hub-side available filtering input. Current renderer does not use it. */

      installedSkills?: Array<{ slug: string; version: string }>;
    }) => Promise<{
      success: boolean;

      error?: string;

      items?: Array<{
        name: string;

        displayName: string;

        description: string;

        authorId: string;

        authorName: string;

        /** 飞书登录时拉到的头像 URL,可能为 null。 */

        authorAvatarUrl: string | null;

        isMine: boolean;

        latestVersion: string;

        visibility: 'PUBLIC' | 'DEPARTMENT_SCOPED';

        publishedVisibility?: 'private' | 'shared' | 'public';

        ownerType?: string;

        moderationStatus?: string;

        marketVersion?: string;

        pendingVersion?: {
          version: string;

          status?: string;
        };

        visibleDeptIds: string[];

        categories?: string[];

        publishedAt: string;

        downloads: number;

        /** 跨设备识别：null = pre-feature 历史版本 */

        latestPublishedFromDeviceId: string | null;
      }>;

      nextCursor?: string | null;
    }>;
    info: (name: string) => Promise<{
      success: boolean;

      error?: string;

      info?: SkillhubInfoResult;

      deleted?: boolean;

      errorCode?: string;
    }>;
    getPublishedFiles: (params: { name: string; version?: string }) => Promise<{
      success: boolean;

      slug?: string;

      version?: string;

      files?: Array<{ path: string; size: number; language: string; truncated: boolean }>;

      error?: string;

      errorCode?: string;
    }>;
    readPublishedFile: (params: { name: string; path: string; version?: string }) => Promise<{
      success: boolean;

      file?: { path: string; size: number; language: string; truncated: boolean; content: string };

      error?: string;

      errorCode?: string;
    }>;
    listPublishedVersions: (name: string) => Promise<{
      success: boolean;

      versions?: unknown[];

      error?: string;

      errorCode?: string;
    }>;
    updatePublished: (params: {
      name: string;

      fields: {
        displayName?: string;

        summary?: string;

        description?: string;

        categories?: string[];

        visibility?: 'private' | 'shared' | 'public';

        /** 归属统一参数:团队 slug / od- 部门 id;null = 收回到个人 */

        teamSlug?: string | null;
      };
    }) => Promise<{ success: boolean; result?: unknown; error?: string; errorCode?: string }>;
    deletePublished: (
      name: string,
    ) => Promise<{ success: boolean; result?: unknown; error?: string; errorCode?: string }>;
    unpublishPublished: (
      name: string,
    ) => Promise<{ success: boolean; result?: unknown; error?: string; errorCode?: string }>;
    setPublishedVisibility: (params: {
      name: string;

      visibility: 'private' | 'shared' | 'public';

      teamSlug?: string;

      visibleSlugs?: string[];
    }) => Promise<{ success: boolean; result?: unknown; error?: string; errorCode?: string }>;
    getPublishedVisibility: (name: string) => Promise<{
      success: boolean;

      sharedTeams?: Array<{ id: number; slug: string; name: string }>;

      visibleDepts?: string[];

      error?: string;

      errorCode?: string;
    }>;
    getFolderHash: (absolutePath: string) => Promise<{
      success: boolean;

      error?: string;

      folderHash?: string;

      /** 参与 hash 的文件清单(含每个文件的 sha256) — 用于排查 dirty。 */

      manifest?: Array<{ path: string; sha256: string }>;
    }>;
    getSnapshotDiff: (params: { absolutePath: string; name: string }) => Promise<{
      success: boolean;

      hasSnapshot?: boolean;

      changes?: Array<{
        path: string;

        kind: 'added' | 'removed' | 'modified';

        isBinary: boolean;

        oldContent: string;

        newContent: string;

        oldSize: number;

        newSize: number;
      }>;

      error?: string;
    }>;
    getUsageSummary: (params: {
      name: string;

      mdPath?: string;
    }) => Promise<
      | { success: true; summary: SkillUsageSummary; refreshing: boolean }
      | { success: false; error: string }
    >;
    onUsageAnalyticsRefreshed: (callback: () => void) => () => void;
    getUsageDiagnosisContext: (params: {
      name: string;

      mdPath?: string;
    }) => Promise<
      { success: true; context: SkillUsageDiagnosisContext } | { success: false; error: string }
    >;
    getMyDepts: () => Promise<{
      success: boolean;

      ids: string[];

      names: string[];

      error?: string;
    }>;
    listCategories: () => Promise<{
      success: boolean;

      categories?: import('../shared/skillhubCategory').MarketCategory[];

      totalCount?: number;

      myTotalCount?: number;

      error?: string;
    }>;
    getScanStatus: (params: { slug: string; version?: string }) => Promise<{
      success: boolean;

      status: string;

      gates?: Array<{ name: string; status: string; issues?: unknown[] }>;

      scorecard?: Record<string, unknown>;

      error?: string;
    }>;
    listUserTeams: () => Promise<{
      success: boolean;

      teams: Array<{
        slug: string;

        name: string;

        type: string;

        source?: string | null;

        isPersonal?: boolean;

        myRole?: 'admin' | 'publisher' | 'viewer';
      }>;

      error?: string;
    }>;
    publish: (params: SkillhubPublishParams) => Promise<{
      success: boolean;

      error?: string;

      result?: { name: string; version: string };

      errorCode?: string;
    }>;
    cancelPublish: () => Promise<{ success: boolean }>;
    startScanPoll: (params: { slug: string; version: string }) => Promise<{ success: boolean }>;
    stopScanPoll: () => Promise<{ success: boolean }>;
    onPublishProgress: (callback: (event: SkillhubPublishProgressEvent) => void) => () => void;
    install: (params: {
      name: string;

      version?: string;

      force?: boolean;

      /** 完整安装目标路径。不传 → global scope 默认路径。*/

      installPath?: string;

      /** force 覆盖时跳过 Cindy 持久备份,直接 rmrf 旧目录(完整替换)。 */

      skipBackup?: boolean;
    }) => Promise<
      | { success: true; name: string; version: string; absolutePath: string }
      | { success: false; errorCode: string; message: string }
    >;
    registry: {
      getByName: (params: { name: string }) => Promise<{
        success: boolean;

        manifest?: StoredManifest | null;

        error?: string;
      }>;
    };
    reconcileMineRegistry: (
      items: Array<{
        name: string;

        absolutePath: string;

        version: string;

        authorId: string;

        folderHash?: string;
      }>,
    ) => Promise<{
      success: boolean;

      added: number;

      flipped: number;

      failures: Array<{ name: string; error: string }>;
    }>;
    cancelInstall: (name: string) => Promise<{ success: boolean }>;
    uninstall: (
      absolutePath: string,
    ) => Promise<{ success: true } | { success: false; errorCode: string; message: string }>;
    pickLocal: () => Promise<
      | { success: true; canceled: true }
      | {
          success: true;

          canceled: false;

          grantToken: string;

          name: string;

          description: string;

          version: string;
        }
      | { success: false; errorCode: string; message: string }
    >;
    importLocal: (params: { grantToken: string; installPath?: string; force?: boolean }) => Promise<
      | {
          success: true;

          name: string;

          description: string;

          version: string;

          absolutePath: string;
        }
      | { success: false; errorCode: string; message: string }
    >;
    onInstallProgress: (
      callback: (event: {
        phase:
          | 'fetching-info'
          | 'downloading'
          | 'verifying'
          | 'extracting'
          | 'registering'
          | 'done'
          | 'failed';

        name: string;

        version?: string;

        absolutePath?: string;

        errorCode?: string;

        message?: string;
      }) => void,
    ) => () => void;
  };
  cacheImageFromPath: (params: {
    sessionId: string;

    sourcePath: string;

    originalName: string;
  }) => Promise<{ url: string; filename: string }>;
  cacheImageFromBuffer: (params: {
    sessionId: string;

    buffer: Uint8Array;

    mimeType: string;

    suggestedName?: string;
  }) => Promise<{ url: string; filename: string }>;
  readCachedImageAsBase64: (params: {
    url: string;
  }) => Promise<{ base64: string; mimeType: string }>;
  cleanupSessionImages: (sessionId: string) => Promise<void>;
  cleanupCachedImages: (urls: string[]) => Promise<void>;
  cindyMediaStorage: {
    reportDraftUrls: (urls: string[]) => void;
    stats: () => Promise<{
      success: boolean;

      error?: string;

      blobs: { totalCount: number; totalBytes: number; cacheCount: number; cacheBytes: number };

      legacy: { bytes: number; fileCount: number };

      deadDirs: Array<{
        name: string;

        exists: boolean;

        bytes: number;

        fileCount: number;

        newestMtimeMs: number;

        eligible: boolean;
      }>;
    }>;
    scan: (params: { draftUrls: string[] }) => Promise<{
      success: boolean;

      error?: string;

      zeroRef: { count: number; bytes: number; hashes: string[]; protectedCount: number };

      cache: {
        totalBytes: number;

        count: number;

        limitBytes: number;

        excessBytes: number;

        evictable: Array<{ hash: string; ext: string; bytes: number }>;
      };

      tmpFileCount: number;

      deadDirs: Array<{
        name: string;

        exists: boolean;

        bytes: number;

        fileCount: number;

        newestMtimeMs: number;

        eligible: boolean;
      }>;
    }>;
    cleanup: (params: {
      draftUrls: string[];

      zeroRefHashes: string[];

      evictCacheHashes: string[];

      deadDirNames: string[];

      cleanTmpFiles: boolean;
    }) => Promise<{
      zeroRef: { deleted: number; freedBytes: number; skipped: number };

      cacheEvicted: { deleted: number; freedBytes: number; skipped: number };

      deadDirs: { removed: string[]; skipped: string[]; freedBytes: number };

      tmpFilesRemoved: number;

      freedBytes: number;
    }>;
    reconcile: () => Promise<{
      success: boolean;

      error?: string;

      orphanCount: number;

      orphanBytes: number;

      missingCount: number;

      strayCount: number;

      tmpFileCount: number;

      orphanSamples: string[];

      missingSamples: string[];
    }>;
  };
  onUpdateStatus: (callback: (payload: UpdateStatusPayload) => void) => () => void;
  getUpdateStatus: () => Promise<{ status: string; version?: string; errorCode?: string }>;
  getAutoUpdateSettings: () => Promise<AutoUpdateSettingsPayload>;
  setAutoUpdateSettings: (settings: {
    autoRelaunchOnIdle: boolean;
  }) => Promise<AutoUpdateSettingsPayload>;
  resetAutoUpdateSettings: () => Promise<AutoUpdateSettingsPayload>;
  getUpdateChannelSettings: () => Promise<{
    enableBeta: boolean;

    isCustomized?: boolean;
  }>;
  setUpdateChannelSettings: (settings: { enableBeta: boolean }) => Promise<{
    enableBeta: boolean;

    isCustomized?: boolean;
  }>;
  resetUpdateChannelSettings: () => Promise<{
    enableBeta: boolean;

    isCustomized?: boolean;
  }>;
  relaunchForChannelChange: () => Promise<void>;
  probeBetaChannel: () => Promise<{ available: boolean }>;
  onUpdateChannelSettings: (
    callback: (payload: { enableBeta: boolean; isCustomized?: boolean }) => void,
  ) => () => void;
  setUpdateRelaunchTheme: (theme: 'light' | 'dark') => void;
  theme: {
    applyVibrancy: (familyId: string, isDark: boolean) => void;
  };
  checkForUpdate: () => Promise<{
    result:
      'ready' | 'idle' | 'downloading' | 'manifest_failed' | 'download_failed' | 'manual_download';
  }>;
  anyActivityBlockingRelaunch: () => Promise<boolean>;
  relaunchToUpdate: (theme: 'light' | 'dark') => void;
  autoRelaunchToUpdate: (theme: 'light' | 'dark') => Promise<{
    accepted: boolean;

    blockReason?: string;
  }>;
  moveToApplicationsFolder: () => Promise<{ moved: boolean }>;
  onFullscreenChange: (callback: (isFullscreen: boolean) => void) => () => void;
  getFullscreenState: () => Promise<boolean>;
  onWindowHiddenChange: (callback: (hidden: boolean) => void) => () => void;
  fetchReleaseNotes: (version: string) => Promise<RawReleaseNotesPayload | null>;
  fetchReleaseNotesIndex: () => Promise<string[] | null>;
  deviceLink: {
    getState: () => Promise<{
      remoteControlEnabled: boolean;

      keepAwake: boolean;

      linkStatus: 'stopped' | 'connecting' | 'online';

      connectionIssue: DeviceLinkConnectionIssuePayload | null;

      standby: boolean;

      controlledBy: Array<{ deviceId: string; name: string }>;

      revokedControllers: string[];

      disabledControlDeviceIds: string[];

      unresponsiveDeviceIds: string[];
    }>;
    setEnabled: (enabled: boolean) => Promise<{ remoteControlEnabled: boolean }>;
    setKeepAwake: (enabled: boolean) => Promise<{ keepAwake: boolean }>;
    setDeviceControlEnabled: (
      deviceId: string,

      enabled: boolean,
    ) => Promise<{ deviceId: string; enabled: boolean; disabledControlDeviceIds: string[] }>;
    listDevices: () => Promise<{ devices: DeviceLinkDeviceView[] }>;
    renameDevice: (
      deviceId: string,

      name: string | null,
    ) => Promise<{ deviceId: string; name: string; manualName?: string | null }>;
    deleteDevice: (deviceId: string) => Promise<{ deviceId: string; deleted: boolean }>;
    openLink: (deviceId: string) => Promise<{ appVersion: string; allowlistHash: string }>;
    closeLink: (deviceId: string) => Promise<{ ok: true }>;
    invoke: (deviceId: string, channel: string, args: unknown[]) => Promise<unknown>;
    subscribe: (deviceId: string, topics: string[]) => Promise<{ ok: true }>;
    unsubscribe: (deviceId: string, topics: string[]) => Promise<{ ok: true }>;
    disconnectAll: () => Promise<{ ok: true }>;
    revoke: (deviceId: string) => Promise<{ ok: true }>;
    restore: (deviceId: string) => Promise<{ ok: true }>;
    onPresenceChanged: (cb: (snap: DeviceLinkPresenceSnapshot) => void) => () => void;
    onStatusChanged: (
      cb: (payload: { status: 'stopped' | 'connecting' | 'online' }) => void,
    ) => () => void;
    onConnectionIssue: (
      cb: (payload: { issue: DeviceLinkConnectionIssuePayload | null }) => void,
    ) => () => void;
    onOwnershipChanged: (cb: (payload: { standby: boolean }) => void) => () => void;
    onRemotePush: (
      cb: (
        payload: {
          deviceId: string;

          channel: string;

          payload: unknown;

          ownerStamp?: import('../shared/dataOwnerPush').DataOwnerPushStamp;
        },

        localOwnerStamp?: import('../shared/dataOwnerPush').DataOwnerPushStamp,
      ) => void,
    ) => () => void;
    onControlledState: (
      cb: (payload: { controllers: Array<{ deviceId: string; name: string }> }) => void,
    ) => () => void;
    onAccessRevoked: (cb: (payload: { deviceId: string }) => void) => () => void;
    onControlTargetChanged: (
      cb: (payload: {
        deviceId: string;

        enabled: boolean;

        disabledControlDeviceIds: string[];
      }) => void,
    ) => () => void;
    onKeepAwakeChanged: (cb: (payload: { keepAwake: boolean }) => void) => () => void;
    onResponsivenessChanged: (
      cb: (payload: { deviceId: string; unresponsive: boolean }) => void,
    ) => () => void;
    mirrorCache: {
      getMessages: (
        deviceId: string,

        sessionId: string,
      ) => Promise<{
        messages: Record<string, unknown>[];

        invalidation?: number;

        ownerToken?: string;

        accountCounter?: number;
      }>;
      putMessages: (
        deviceId: string,

        sessionId: string,

        messages: readonly Record<string, unknown>[],

        expectedInvalidation?: number,

        expectedOwnerToken?: string,

        expectedAccountCounter?: number,
      ) => Promise<{ ok: true; invalidation?: number }>;
      getSessionList: () => Promise<{
        devices: Array<{
          deviceId: string;

          deviceName: string;

          sessions: Record<string, unknown>[];
        }>;

        ownerToken?: string;

        accountCounter?: number;
      }>;
      putSessionList: (
        devices: ReadonlyArray<{
          deviceId: string;

          deviceName: string;

          sessions: readonly Record<string, unknown>[];
        }>,

        expectedOwnerToken?: string,

        expectedAccountCounter?: number,
      ) => Promise<{ ok: true }>;
      clear: (deviceId: string) => Promise<{ ok: true }>;
    };
  };
  remoteSsh: {
    list: () => Promise<{ hosts: RemoteHostSnapshot[] }>;
    reloadConfig: () => Promise<{ hosts: RemoteHostSnapshot[] }>;
    add: (host: {
      id: string;

      hostname: string;

      port?: number;

      user: string;

      authMethod?: 'agent' | 'key';

      identityFile?: string;

      /** 「Agent 流量走本地 Proxy」pref; null = 关闭, 缺省 = 不动。 */

      agentProxy?: AgentProxyPrefPayload | null;
    }) => Promise<{ host: RemoteHostSnapshot }>;
    update: (host: {
      id: string;

      hostname: string;

      port?: number;

      user: string;

      authMethod?: 'agent' | 'key';

      identityFile?: string;

      agentProxy?: AgentProxyPrefPayload | null;
    }) => Promise<{ host: RemoteHostSnapshot }>;
    remove: (id: string) => Promise<{ ok: true }>;
    connect: (id: string) => Promise<{ host: RemoteHostSnapshot | null }>;
    disconnect: (id: string) => Promise<{ host: RemoteHostSnapshot | null }>;
    onStatusChanged: (cb: (snap: RemoteHostSnapshot) => void) => () => void;
    probeAgent: (id: string, kind: RemoteAgentKind) => Promise<{ probe: RemoteAgentProbe }>;
    installAgent: (
      id: string,

      kind: RemoteAgentKind,
    ) => Promise<{ result: RemoteAgentInstallResult }>;
    uninstallAgent: (id: string, kind: RemoteAgentKind) => Promise<{ ok: true }>;
    runAgentOneShot: (
      id: string,

      kind: RemoteAgentKind,

      prompt: string,
    ) => Promise<{ result: RemoteAgentOneShotResult }>;
    statRemotePath: (
      id: string,

      path: string,
    ) => Promise<{ kind: 'dir' | 'file' | 'missing'; resolvedPath: string }>;
    mkdirPRemote: (id: string, path: string) => Promise<{ resolvedPath: string }>;
    setAutoConnect: (
      id: string,

      autoConnect: boolean,
    ) => Promise<{ ok: true; autoConnect: boolean }>;
    hasAnyAutoConnectHost: () => Promise<{ hasAny: boolean }>;
    listRemoteDir: (
      id: string,

      path: string,
    ) => Promise<{
      resolvedPath: string;

      entries: Array<{ name: string; kind: 'dir' | 'symlink' }>;
    }>;
    onInstallProgress: (cb: (payload: RemoteAgentInstallProgressPush) => void) => () => void;
    onSilentInstallStatus: (
      cb: (payload: RemoteAgentSilentInstallStatusPush) => void,
    ) => () => void;
    onCcMgrUpgradeAvailable: (
      cb: (payload: RemoteAgentCcMgrUpgradeAvailablePush) => void,
    ) => () => void;
    ccMgrForceUpgrade: (
      hostId: string,

      sessionId?: string,

      agent?: 'cc' | 'pi',
    ) => Promise<{ ok: true; daemonReady: boolean }>;
    ccMgrListPendingUpgrades: () => Promise<{
      pending: Array<{
        hostId: string;
        currentVersion: string;
        availableVersion: string;
        agent: 'cc' | 'pi';
      }>;
    }>;
    ccMgrDismissPendingUpgrade: (hostId: string, agent?: 'cc' | 'pi') => Promise<{ ok: true }>;
    checkCodexAuth: (id: string) => Promise<{
      localExists: boolean;

      remoteExists: boolean;

      remoteMtime: string | null;
    }>;
    syncCodexAuth: (id: string) => Promise<{
      ok: true;

      daemonRestart: { ok: true } | { ok: false; reason: 'pkill_failed'; detail?: string };
    }>;
    listLocalKeys: () => Promise<{ keys: LocalSshKeyInfo[] }>;
    generateKey: (params?: { name?: string; comment?: string; passphrase?: string }) => Promise<{
      result: {
        privateKeyPath: string;

        pubkeyPath: string;

        pubkeyContent: string;

        fingerprintSha256: string | null;
      };

      agentLoaded: boolean;

      agentErrorHint: string | null;

      agentFailureReason: AgentFailureReason | null;
    }>;
    addKeyToAgent: (params: { privateKeyPath: string; passphrase?: string }) => Promise<{
      result: {
        success: boolean;

        failureReason: AgentFailureReason | null;

        errorHint: string | null;

        stderr: string;
      };
    }>;
    readPubkey: (pubkeyPath: string) => Promise<{ content: string }>;
    buildInstallCmd: (
      id: string,

      pubkeyPath: string,
    ) => Promise<{
      command: string;

      platform: NodeJS.Platform;
    }>;
    buildInstallCmdInline: (params: {
      user: string;

      hostname: string;

      port?: number;

      pubkeyPath: string;
    }) => Promise<{
      command: string;

      platform: NodeJS.Platform;
    }>;
  };
  worktreeCreate: (req: {
    sessionId: string;

    baseRepo: string;

    name: string;

    sourceBranch: string;
  }) => Promise<import('@/lib/worktree.types').CreateWorktreeResp>;
  worktreeDetectCwd: (req: {
    cwd: string;
  }) => Promise<import('@/lib/worktree.types').DetectCwdResp>;
  worktreeGetForSession: (
    sessionId: string,
  ) => Promise<import('@/lib/worktree.types').WorktreeMeta | null>;
  worktreeListAll: () => Promise<import('@/lib/worktree.types').WorktreeMeta[]>;
  worktreeReveal: (req: { path: string }) => Promise<import('@/lib/worktree.types').RevealResp>;
  worktreeSuggestName: (req: {
    baseRepo: string;
  }) => Promise<import('@/lib/worktree.types').SuggestNameResp>;
  worktreeListBranches: (req: {
    baseRepo: string;
  }) => Promise<import('@/lib/worktree.types').ListBranchesResp>;
  worktreeRemovalPreview: (sessionId: string) => Promise<{ hasWorktree: boolean; dirty: boolean }>;
  worktreeRestoreStatus: (
    sessionId: string,
  ) => Promise<
    | { state: 'present'; worktreePath: string; hasSnapshot?: boolean }
    | { state: 'no-worktree' }
    | { state: 'restorable'; worktreePath: string; hasSnapshot: boolean }
    | { state: 'gone'; worktreePath: string }
  >;
  worktreeRestoreForSession: (sessionId: string) => Promise<{
    ok: boolean;

    snapshotApplied?: boolean;

    reason?: 'gone' | 'no-worktree' | 'git-error';

    detail?: string;
  }>;
  onWorktreeChanged: (callback: (payload: { sessionId: string }) => void) => () => void;
  hookControl: {
    get: () => Promise<{ hook: import('../shared/hookControlIpc').SlackHookView }>;
    setEnabled: (
      enabled: boolean,
    ) => Promise<{ hook: import('../shared/hookControlIpc').SlackHookView }>;
    setLifecycleAnnouncement: (
      enabled: boolean,
    ) => Promise<{ hook: import('../shared/hookControlIpc').SlackHookView }>;
    setProviderEnabled: (
      provider: 'telegram' | 'x',

      enabled: boolean,
    ) => Promise<{ hook: import('../shared/hookControlIpc').SlackHookView }>;
    setWorkspaces: (
      workspaces: Record<string, string>,
    ) => Promise<{ hook: import('../shared/hookControlIpc').SlackHookView }>;
    setProviderDefaultWorkspace: (
      provider: 'telegram' | 'x',

      alias: string | null,
    ) => Promise<{ hook: import('../shared/hookControlIpc').SlackHookView }>;
    bindStart: () => Promise<{ ok: true }>;
    bindRevoke: () => Promise<{ ok: true }>;
    addBinding: () => Promise<{ hook: import('../shared/hookControlIpc').SlackHookView }>;
    rebindTeam: (
      teamId: string,
    ) => Promise<{ hook: import('../shared/hookControlIpc').SlackHookView }>;
    revokeTeam: (
      teamId: string,
    ) => Promise<{ hook: import('../shared/hookControlIpc').SlackHookView }>;
    cancelPendingBind: () => Promise<{ hook: import('../shared/hookControlIpc').SlackHookView }>;
    providerBindStart: (
      provider: 'telegram' | 'x',
    ) => Promise<{ hook: import('../shared/hookControlIpc').SlackHookView }>;
    providerBindCancel: (
      provider: 'telegram' | 'x',
    ) => Promise<{ hook: import('../shared/hookControlIpc').SlackHookView }>;
    providerBindRevoke: (
      provider: 'telegram' | 'x',
    ) => Promise<{ hook: import('../shared/hookControlIpc').SlackHookView }>;
    openProviderAction: (
      provider: 'telegram' | 'x',

      action: import('../shared/hookControlIpc').ProviderOpenAction,
    ) => Promise<{ ok: true }>;
    getWorkspacePrefs: () => Promise<{
      prefs: import('../shared/hookControlIpc').HookPrefsView;
    }>;
    setWorkspacePrefs: (
      workspace: string,

      patch: import('../shared/hookControlIpc').HookPrefsPatch,

      teamId?: string | null,
    ) => Promise<{ prefs: import('../shared/hookControlIpc').HookPrefsView }>;
    getProviderWorkspacePrefs: (provider: 'telegram' | 'x') => Promise<{
      prefs: import('../shared/hookControlIpc').ProviderPrefsView;
    }>;
    setProviderWorkspacePrefs: (
      provider: 'telegram' | 'x',

      workspace: string,

      patch: import('../shared/hookControlIpc').HookPrefsPatch,
    ) => Promise<{ prefs: import('../shared/hookControlIpc').ProviderPrefsView }>;
    getTelegramBehavior: (bindingId: string) => Promise<{
      behavior: import('../shared/hookControlIpc').TelegramHookBehaviorState;
    }>;
    setTelegramBehavior: (
      bindingId: string,

      patch: import('../shared/hookControlIpc').TelegramHookBehaviorPatch,
    ) => Promise<{
      behavior: import('../shared/hookControlIpc').TelegramHookBehaviorState;
    }>;
    listTelegramGroups: (bindingId: string) => Promise<{
      groups: import('../shared/hookControlIpc').TelegramHookKnownGroup[];
    }>;
    setTelegramGroupActivation: (
      bindingId: string,

      chatId: string,

      mode: import('../shared/hookControlIpc').TelegramHookGroupActivationMode,
    ) => Promise<{
      behavior: import('../shared/hookControlIpc').TelegramHookBehaviorState;
    }>;
    getWorkspaceProviderSources: () => Promise<{
      entries: import('../shared/hookControlIpc').HookWorkspaceProviderSourceEntry[];
    }>;
    setWorkspaceProviderSource: (payload: {
      channel: 'slack' | 'telegram' | 'x';

      teamId: string | null;

      workspace: string;

      providerId: string | null;
    }) => Promise<{
      entries: import('../shared/hookControlIpc').HookWorkspaceProviderSourceEntry[];
    }>;
    onWorkspaceProviderSourcesChanged: (
      listener: (
        entries: import('../shared/hookControlIpc').HookWorkspaceProviderSourceEntry[],
      ) => void,
    ) => () => void;
    onPrefsChanged: (
      cb: (view: import('../shared/hookControlIpc').HookPrefsView) => void,
    ) => () => void;
    onProviderPrefsChanged: (
      cb: (view: import('../shared/hookControlIpc').ProviderPrefsView) => void,
    ) => () => void;
    onTelegramBehaviorChanged: (
      cb: (view: import('../shared/hookControlIpc').TelegramHookBehaviorState) => void,
    ) => () => void;
    onStatusChanged: (
      cb: (view: import('../shared/hookControlIpc').SlackHookView) => void,
    ) => () => void;
  };
  gitContext: {
    get: (workdir: string) => Promise<import('@/lib/gitContext.types').GitContextSnapshot>;
    getForSession: (input: {
      sessionId: string;

      workingDir: string | null;

      worktreePath: string | null;

      remoteHostId?: string | null;
    }) => Promise<import('@/lib/gitContext.types').SessionGitDirResult>;
    findLinkedWorktree: (input: { sessionId: string }) => Promise<{
      workdir: string;

      branch: string | null;
    } | null>;
    watch: (workdir: string) => Promise<void>;
    unwatch: (workdir: string) => Promise<void>;
    listPrRefs: (sessionId: string) => Promise<import('@/lib/gitContext.types').SessionPrRef[]>;
    listAllPrRefs: () => Promise<import('@/lib/gitContext.types').SessionPrRef[] | null>;
    getPrStatuses: (
      queries: Array<{ owner: string; repo: string; prNumber: number }>,
    ) => Promise<import('@/lib/gitContext.types').PrStatusResult[]>;
    onChanged: (
      cb: (data: import('@/lib/gitContext.types').GitContextSnapshot) => void,
    ) => () => void;
    onPrRefsChanged: (cb: (data: { sessionId: string }) => void) => () => void;
  };
  gitReview: {
    get: (params: {
      sessionId: string;

      ignoreWhitespace?: boolean;
    }) => Promise<import('@/lib/gitReview.types').ReviewData>;
    summary: (params: {
      sessionId: string;
    }) => Promise<import('@/lib/gitReview.types').ReviewDirtySummary>;
    commits: (params: {
      sessionId: string;

      baseRef?: string | null;
    }) => Promise<import('@/lib/gitReview.types').ReviewCommitListData>;
    commitDiff: (params: {
      sessionId: string;

      oid: string;

      ignoreWhitespace?: boolean;
    }) => Promise<import('@/lib/gitReview.types').ReviewCommitDiffData>;
    branchDiff: (params: {
      sessionId: string;

      baseRef?: string | null;

      ignoreWhitespace?: boolean;
    }) => Promise<import('@/lib/gitReview.types').ReviewBranchDiffData>;
    fileDiff: (
      params: { sessionId: string } & import('@/lib/gitReview.types').ReviewFileDiffRequest,
    ) => Promise<import('@/lib/gitReview.types').ReviewFileDiffData>;
    imagePreview: (params: {
      sessionId: string;

      diff: import('@/lib/gitReview.types').FileDiff;

      commitOid?: string | null;

      branchBaseRef?: string | null;
    }) => Promise<import('@/lib/gitReview.types').ReviewImagePreviewData>;
    markdownPreview: (params: {
      sessionId: string;

      diff: import('@/lib/gitReview.types').FileDiff;

      commitOid?: string | null;

      branchBaseRef?: string | null;
    }) => Promise<import('@/lib/gitReview.types').ReviewMarkdownPreviewData>;
    openFile: (params: { sessionId: string; path: string }) => Promise<void>;
    stageFile: (params: {
      sessionId: string;

      targets: import('@/lib/gitReview.types').ReviewFileTarget[];
    }) => Promise<import('@/lib/gitReview.types').ReviewStageOperationResult>;
    unstageFile: (params: {
      sessionId: string;

      targets: import('@/lib/gitReview.types').ReviewFileTarget[];
    }) => Promise<import('@/lib/gitReview.types').ReviewStageOperationResult>;
    discardFile: (params: {
      sessionId: string;

      targets: import('@/lib/gitReview.types').ReviewFileTarget[];
    }) => Promise<import('@/lib/gitReview.types').ReviewStageOperationResult>;
    stageHunk: (
      params: import('@/lib/gitReview.types').ReviewHunkOperationRequest,
    ) => Promise<import('@/lib/gitReview.types').ReviewStageOperationResult>;
    unstageHunk: (
      params: import('@/lib/gitReview.types').ReviewHunkOperationRequest,
    ) => Promise<import('@/lib/gitReview.types').ReviewStageOperationResult>;
    discardHunk: (
      params: import('@/lib/gitReview.types').ReviewHunkOperationRequest,
    ) => Promise<import('@/lib/gitReview.types').ReviewStageOperationResult>;
    stageAll: (params: {
      sessionId: string;

      targets: import('@/lib/gitReview.types').ReviewFileTarget[];
    }) => Promise<import('@/lib/gitReview.types').ReviewStageOperationResult>;
    unstageAll: (params: {
      sessionId: string;

      targets: import('@/lib/gitReview.types').ReviewFileTarget[];
    }) => Promise<import('@/lib/gitReview.types').ReviewStageOperationResult>;
    discardAll: (params: {
      sessionId: string;

      targets: import('@/lib/gitReview.types').ReviewFileTarget[];
    }) => Promise<import('@/lib/gitReview.types').ReviewStageOperationResult>;
    commit: (
      params: import('@/lib/gitReview.types').ReviewCommitRequest,
    ) => Promise<import('@/lib/gitReview.types').ReviewCommitResult>;
    push: (params: {
      sessionId: string;

      confirmForce?: import('@/lib/gitReview.types').ReviewPushConfirmForce;
    }) => Promise<import('@/lib/gitReview.types').ReviewPushResult>;
  };
  sidebarSettings: {
    claimLegacyRendererOwner: () => import('../shared/sidebarSettings').SidebarLegacyRendererOwnerClaim;
    loadSnapshot: () => import('../shared/sidebarSettings').SidebarSettingsSnapshot;
    mutatePinnedOrder: (
      mutation: import('../shared/sidebarSettings').SidebarPinnedOrderMutation,

      ownerStamp: import('../shared/dataOwnerPush').DataOwnerPushStamp,
    ) => Promise<string[]>;
    onPinnedOrderChanged: (
      cb: (
        order: string[],

        ownerStamp: import('../shared/dataOwnerPush').DataOwnerPushStamp,
      ) => void,
    ) => () => void;
    setProjectHidden: (
      projectKey: string,

      hidden: boolean,

      ownerStamp: import('../shared/dataOwnerPush').DataOwnerPushStamp,
    ) => Promise<boolean>;
    onHiddenProjectKeysChanged: (
      cb: (
        projectKeys: string[],

        ownerStamp: import('../shared/dataOwnerPush').DataOwnerPushStamp,
      ) => void,
    ) => () => void;
    loadHiddenProjectKeys: () => string[];
  };
  remotePrecreatedWorktreeLedger: {
    list: () => Promise<RemotePrecreatedWorktreeLedgerSnapshot>;
    register: (record: PendingRemotePrecreatedWorktree) => Promise<{ persisted: boolean }>;
    forget: (target: PendingRemotePrecreatedWorktreeTarget) => Promise<{ persisted: boolean }>;
  };
  onUsageSessionSpendChanged: (
    cb: (
      data: {
        sessionId: string;

        totalMoney: import('../shared/regionalMoney').RegionalMoney;

        totalCostUsd?: number;
      },

      ownerStamp?: import('../shared/dataOwnerPush').DataOwnerPushStamp,
    ) => void,
  ) => () => void;
  onUsageSessionTokensChanged: (
    cb: (
      data: { sessionId: string; totalTokens: number },

      ownerStamp?: import('../shared/dataOwnerPush').DataOwnerPushStamp,
    ) => void,
  ) => () => void;
  onUsageMessageTurnCost: (
    cb: (
      data: import('../shared/turnCostPayload').MessageTurnCostPayload,

      ownerStamp?: import('../shared/dataOwnerPush').DataOwnerPushStamp,
    ) => void,
  ) => () => void;
  onUsageMessageModelMismatch: (
    cb: (
      data: {
        sessionId: string;

        clientId: string;

        modelMismatch: import('../shared/modelMismatch').ModelMismatchInfo;
      },

      ownerStamp?: import('../shared/dataOwnerPush').DataOwnerPushStamp,
    ) => void,
  ) => () => void;
  legacyMigration: {
    onState: (
      cb: (data: { phase: 'confirm' | 'running' | 'done' | 'failed' }) => void,
    ) => () => void;
    getState: () => Promise<{ phase: 'confirm' | 'running' | 'done' | 'failed' | null }>;
    confirm: () => Promise<void>;
  };
  localDb: {
    ensureReady: (userId: string) => Promise<
      | { ready: true }
      | {
          ready: false;

          error: {
            code: 'DB_INIT_FAILED' | 'DB_CORRUPT_NO_BACKUP' | 'MIGRATE_FAILED';

            message: string;
          };
        }
    >;
    sessions: {
      list: (
        limit?: number,

        status?: 'active' | 'archived' | 'all',
      ) => Promise<import('@/lib/ccAgent.types').Session[]>;
      create: (body?: {
        id?: string;

        workingDir?: string;

        workspaceKind?: import('@/lib/ccAgent.types').WorkspaceKind;

        model?: string;

        effort?: string;

        permissionMode?: string;

        fastMode?: boolean;

        planModeEnabled?: boolean;

        agentKind?: 'cc' | 'codex' | 'pi';

        orcaRole?: import('@/lib/ccAgent.types').OrcaRole | null;

        /** 附加只读引用目录列表 (绝对路径); main 端 mapper 会 JSON.stringify 后写库。 */

        extraDirs?: string[];
      }) => Promise<import('@/lib/ccAgent.types').Session>;
      get: (id: string) => Promise<import('@/lib/ccAgent.types').Session>;
      resolveReferences: (
        sessionIds: string[],
      ) => Promise<import('../shared/sessionReference').SessionReference[]>;
      restoreIfArchived: (
        id: string,

        expected: {
          workingDir: string | null;

          workspaceKind: import('@/lib/ccAgent.types').WorkspaceKind;

          remoteHostId: string | null;
        },
      ) => Promise<import('@/lib/ccAgent.types').Session | null>;
      update: (
        id: string,

        patch: {
          title?: string;

          workingDir?: string;

          workspaceKind?: import('@/lib/ccAgent.types').WorkspaceKind;

          model?: string;

          effort?: string;

          permissionMode?: string;

          fastMode?: boolean;

          planModeEnabled?: boolean;

          sdkSessionId?: string | null;

          totalTokenUsage?: number;

          totalCostUsd?: number;

          contextTokens?: number;

          contextWindow?: number;

          clearedAt?: string | null;

          pinnedAt?: string | null;

          status?: import('@/lib/ccAgent.types').SessionStatus;

          orcaRole?: import('@/lib/ccAgent.types').OrcaRole | null;

          /** 附加只读引用目录覆盖列表 (绝对路径)。 */

          extraDirs?: string[];
        },
      ) => Promise<import('@/lib/ccAgent.types').Session>;
      touchUserSend: (id: string, atMs?: number) => Promise<void>;
      interruptedPending: () => Promise<string[]>;
      errorTailPending: () => Promise<string[]>;
      dismissPendingAlerts: (
        sessionIds: string[],
      ) => Promise<{ dismissed: number; processed: string[]; failed: string[] }>;
      ackInterrupted: (id: string) => Promise<void>;
    };
    conversations: {
      search: (
        request: import('../shared/conversationSearch').ConversationSearchRequest,
      ) => Promise<import('../shared/conversationSearch').ConversationSearchResponse>;
    };
    recentWorkdirs: {
      list: () => Promise<Array<{ path: string; lastUsedAt: string; exists: boolean }>>;
      remove: (input: { path: string }) => Promise<{ deleted: boolean }>;
      onChanged: (
        callback: (
          data: { path: string },

          ownerStamp?: import('../shared/dataOwnerPush').DataOwnerPushStamp,
        ) => void,
      ) => () => void;
    };
    rightSidebarTabs: {
      list: (input: { sessionId: string }) => Promise<{
        tabs: Array<{
          id: string;

          sessionId: string;

          kind: string;

          position: number;

          state: unknown;

          isActive: boolean;

          createdAt: number;

          updatedAt: number;
        }>;

        activeTabId: string | null;
      }>;
      ensureSingleton: (input: { sessionId: string; kind: string; state?: unknown }) => Promise<{
        tab: {
          id: string;

          sessionId: string;

          kind: string;

          position: number;

          state: unknown;

          isActive: boolean;

          createdAt: number;

          updatedAt: number;
        } | null;

        created: boolean;

        persistable: boolean;
      }>;
      upsert: (input: {
        id: string;

        sessionId: string;

        kind: string;

        position: number;

        state?: unknown;
      }) => Promise<{ ok: true }>;
      close: (input: { id: string }) => Promise<{ ok: true }>;
      setActive: (input: { sessionId: string; id: string | null }) => Promise<{ ok: true }>;
      reorder: (input: { sessionId: string; orderedIds: string[] }) => Promise<{ ok: true }>;
    };
    subagentRuns: {
      list: (
        input: import('@cindy/maker-shared/subagent-workspace').SubagentRunsListRequest,
      ) => Promise<import('@cindy/maker-shared/subagent-workspace').SubagentRunsListResponse>;

      detail: (
        input: import('@cindy/maker-shared/subagent-workspace').SubagentRunDetailRequest,
      ) => Promise<import('@cindy/maker-shared/subagent-workspace').SubagentRunDetailResponse>;

      onChanged: (
        callback: (
          payload: import('@cindy/maker-shared/subagent-workspace').SubagentRunsChangedPayload,

          ownerStamp?: import('../shared/dataOwnerPush').DataOwnerPushStamp,
        ) => void,
      ) => () => void;
    };
    projectAliases: {
      list: () => Promise<import('../shared/projectAliases').ProjectAlias[]>;
      set: (input: {
        projectKey: string;

        alias: string;
      }) => Promise<import('../shared/projectAliases').ProjectAlias | null>;
      delete: (projectKey: string) => Promise<void>;
      onChanged: (cb: () => void) => () => void;
    };
    sessionImport: {
      scan: (request?: { force?: boolean }) => Promise<{
        sources: {
          codexHomes: string[];

          claudeRoots: string[];
        };

        candidates: Array<{
          key: string;

          source: 'codex' | 'claude';

          id: string;

          title: string;

          cwd: string;

          updatedAt: string;

          archived: boolean;

          workspaceKind: 'project' | 'dialogue';

          sidebarBucket: 'project' | 'dialogue';

          projectDir: string | null;
        }>;

        rejected: {
          codex: number;

          claude: number;

          existing: number;
        };

        currentProjectDirs: string[];
      }>;
      importSelected: (
        items: Array<{ source: 'codex' | 'claude'; id: string }>,
      ) => Promise<{ inserted: number; updated: number; scanned: number }>;
      linkCodexProject: (
        workingDir: string,
      ) => Promise<{ matched: number; inserted: number; updated: number; scanned: number }>;
    };
    sessionShare: {
      export: (request: {
        sessionId: string;

        password?: string;

        excludeMedia?: boolean;
      }) => Promise<
        | {
            status: 'ok';

            filePath: string;

            fidelity: 'full' | 'partial' | 'db-only';

            missingTranscripts: string[];

            mediaMissing: number;

            /** 随包携带的协同 Worker 会话数(非协同包为 0)。 */

            orcaWorkers: number;
          }
        | { status: 'canceled' }
        | { status: 'oversize'; totalBytes: number; mediaBytes: number; limitBytes: number }
      >;
      inspect: (request?: {
        filePath?: string;
      }) => Promise<
        | { status: 'canceled' }
        | { draftId: string; encrypted: true }
        | { draftId: string; encrypted: false; preview: SessionSharePreview }
      >;
      unlock: (request: { draftId: string; password: string }) => Promise<SessionSharePreview>;
      commit: (request: {
        draftId: string;

        workingDir?: string;

        /** 导入端 New Maker 草稿默认值(导入语义 = 用草稿新建会话,agent 跟随分享包)。 */

        draftPrefs?: {
          model?: string;

          effort?: string;

          permissionMode?: string;

          planMode?: boolean;

          fastMode?: boolean;

          providerId?: string | null;
        };

        /** 冲突弹窗确认后覆盖导入:软删同 resume id 的旧会话,替换而非叠加。 */

        overwrite?: boolean;

        /** 在 worktree 中创建(仅 project 会话):main 编排建 worktree 后 workingDir 指向它。 */

        useWorktree?: boolean;
      }) => Promise<{
        sessionId: string;

        fidelity: 'full' | 'partial' | 'db-only';

        notes: string[];

        /** 随协同包一并导入的 Worker 会话数;普通包为 0。 */

        orcaWorkers: number;
      }>;
      cancel: (request: { draftId: string }) => Promise<{ ok: boolean }>;
      classifyPath: (request: {
        path: string;
      }) => Promise<{ kind: 'share' | 'directory' | 'other' }>;
    };
    orcaWorkflows: {
      getByLeadSession: (leadSessionId: string) => Promise<OrcaTeamRecord | null>;
      getByWorkerSession: (workerSessionId: string) => Promise<OrcaTeamRecord | null>;
      listWorkersByLead: (leadSessionId: string) => Promise<OrcaWorkerRecord[]>;
      listWorkersByLeads?: (
        leadSessionIds: string[],
      ) => Promise<Record<string, OrcaWorkerRecord[]>>;
      updateWorkerStatus: (
        workerId: string,

        status: 'idle' | 'running' | 'done' | 'error',
      ) => Promise<void>;
      onOrcaWorkerChanged: (cb: (payload: unknown) => void) => () => void;
      createWorker: (input: Record<string, unknown>) => Promise<unknown>;
      switchFocus: (input: Record<string, unknown>) => Promise<unknown>;
      idleWorker: (
        leadSessionId: string,

        workerId: string,

        expectedStatus?: 'done',
      ) => Promise<unknown>;
      archiveWorker: (leadSessionId: string, workerId: string) => Promise<unknown>;
      endTeam: (leadSessionId: string) => Promise<unknown>;
      getCollaborationSettings: () => Promise<unknown>;
      setCollaborationSetting: (key: string, value: number) => Promise<unknown>;
      resetCollaborationSettings: () => Promise<unknown>;
    };
    messages: {
      list: (
        sessionId: string,

        opts?: { limit?: number; before?: string; beforeTs?: number },
      ) => Promise<import('@/lib/ccAgent.types').Message[]>;
      estimatedSessionValue: (sessionId: string) => Promise<{
        totalValueMoney?: import('../shared/regionalMoney').RegionalMoney | null;

        totalValueUsd?: number;

        entries: Array<{
          clientId: string;

          money?: import('../shared/regionalMoney').RegionalMoney;

          costUsd?: number;

          turnUsageDetails?: unknown;
        }>;
      }>;
      around: (
        sessionId: string,

        messageId: string,

        opts?: { radius?: number },
      ) => Promise<import('@/lib/ccAgent.types').Message[]>;
      aroundClientId: (
        sessionId: string,

        clientId: string,

        opts?: { radius?: number },
      ) => Promise<import('@/lib/ccAgent.types').Message[]>;
      create: (
        sessionId: string,

        body: {
          clientId: string;

          role: import('@/lib/ccAgent.types').MessageRole;

          content: unknown;

          toolUseId?: string;

          createdAt?: string;

          /** SDK 元信息，按 session.agentKind 解析。 */

          agentMeta?: import('@/lib/ccAgent.types').AgentMeta | null;
        },
      ) => Promise<import('@/lib/ccAgent.types').Message>;
      updateContent: (
        sessionId: string,

        clientId: string,

        content: unknown,
      ) => Promise<import('@/lib/ccAgent.types').Message>;
      dismissError: (
        sessionId: string,

        clientId: string,
      ) => Promise<import('@/lib/ccAgent.types').Message>;
      onCreated: (
        callback: (
          payload: {
            sessionId: string;

            message: import('@/lib/ccAgent.types').Message;
          },

          ownerStamp?: import('../shared/dataOwnerPush').DataOwnerPushStamp,
        ) => void,
      ) => () => void;
      onDeleted: (
        callback: (
          payload: { sessionId: string; clientId: string },

          ownerStamp?: import('../shared/dataOwnerPush').DataOwnerPushStamp,
        ) => void,
      ) => () => void;
      onErrorPersisted: (
        callback: (
          payload: { sessionId: string },

          ownerStamp?: import('../shared/dataOwnerPush').DataOwnerPushStamp,
        ) => void,
      ) => () => void;
    };
    sessionsPush: {
      onCreated: (
        callback: (
          payload: { sessionId: string },

          ownerStamp?: import('../shared/dataOwnerPush').DataOwnerPushStamp,
        ) => void,
      ) => () => void;
      onPatched: (
        callback: (
          payload: {
            sessionId: string;

            patch: Partial<import('@/lib/ccAgent.types').Session>;
          },

          ownerStamp?: import('../shared/dataOwnerPush').DataOwnerPushStamp,
        ) => void,
      ) => () => void;
    };
    onCorruptionRestored: (cb: (info: CorruptionRestoredPayload) => void) => () => void;
    onSchemaDriftWarning: (cb: (info: SchemaDriftWarningPayload) => void) => () => void;
    mekaProjects: {
      list: () => Promise<import('../shared/meka-projects').MekaProject[]>;

      get: (id: string) => Promise<import('../shared/meka-projects').MekaProject | null>;

      inspectPath: (
        path: string,
      ) => Promise<import('../shared/meka-projects').MekaProjectFile | null>;

      create: (input: {
        displayName: string;

        description?: string | null;

        path: string;

        additionalPaths?: readonly string[];

        tags?: readonly string[];
      }) => Promise<import('../shared/meka-projects').MekaProject>;

      resetBuiltin: (id: string) => Promise<import('../shared/meka-projects').MekaProject>;

      update: (input: {
        id: string;

        patch: {
          displayName?: string;

          description?: string | null;

          path?: string;

          tags?: readonly string[];

          formalWorkflowEnabled?: boolean;

          workflowType?: import('../shared/meka-projects').MekaWorkflowType;

          jiraProjectKey?: string | null;

          gitlabProjectUrl?: string | null;
        };
      }) => Promise<import('../shared/meka-projects').MekaProject>;

      delete: (id: string) => Promise<void>;

      resolvePath: (id: string) => Promise<{ resolvedPath: string | null }>;
    };
    mekaRoles: {
      list: (projectId: string) => Promise<import('../shared/meka-projects').MekaRole[]>;

      create: (input: {
        projectId: string;

        roleFile: Omit<
          import('../shared/meka-projects').MekaRoleManifestFile,
          'id' | 'name' | 'projectId'
        >;

        sortOrder?: number;
      }) => Promise<import('../shared/meka-projects').MekaRole>;

      update: (input: {
        projectId: string;

        roleFile: import('../shared/meka-projects').MekaRoleManifestFile;

        sortOrder?: number;
      }) => Promise<import('../shared/meka-projects').MekaRole>;

      delete: (id: string) => Promise<void>;

      readManifest: (
        id: string,
      ) => Promise<import('../shared/meka-projects').MekaRoleManifestFile | null>;
    };
    mekaProjectMetadata: {
      discover: (
        projectId: string,
      ) => Promise<import('../shared/meka-projects').MekaProjectMetadata[]>;

      list: (projectId: string) => Promise<import('../shared/meka-projects').MekaProjectMetadata[]>;

      loadProject: (
        projectId: string,
      ) => Promise<import('../shared/meka-projects').MekaProjectFile>;

      saveProject: (input: {
        projectId: string;

        project: import('../shared/meka-projects').MekaProjectFile;
      }) => Promise<import('../shared/meka-projects').MekaProjectFile>;

      gitRemote: (projectId: string) => Promise<string | null>;
    };
    mekaSkillCatalog: {
      list: () => Promise<import('../shared/meka-projects').MekaSkillCatalogEntry[]>;
    };
    mekaFormal: {
      providerList: () => Promise<string[]>;

      checkAuth: (input: {
        projectId: string;

        type: 'jira' | 'gitlab';
      }) => Promise<
        { ok: true } | { ok: false; reason: 'NOT_CONNECTED' | 'AUTH_EXPIRED' | 'NETWORK' }
      >;

      fetchIssues: (input: { projectId: string; type: 'jira' | 'gitlab' }) => Promise<
        | {
            ok: true;

            data: Array<{ ref: string; title: string; webUrl: string }>;
          }
        | { ok: false; error: string; detail?: string }
      >;

      prepare: (input: { projectId: string; type: 'jira' | 'gitlab'; link: string }) => Promise<
        | {
            ok: true;

            data: {
              formal: import('../shared/meka-formal').FormalSessionData;

              firstMessage: string;

              titlePrefix: string;
            };
          }
        | { ok: false; error: string; detail?: string }
      >;
    };
  };
  rsbBrowserBridge: {
    report: (input: {
      sessionId: string;

      tabId: string;

      webContentsId: number;
    }) => Promise<{ ok: true }>;
    release: (input: { tabId: string }) => Promise<{ ok: true }>;
    snapshot: (input: { liveTabIds: string[] }) => Promise<{
      ok: true;

      dropped: string[];

      kept: number;

      pinnedTabIds: string[];
    }>;
    captureScreenshot: (input: { tabId: string }) => Promise<{ ok: true }>;
    captureScreenshotData: (input: { tabId: string }) => Promise<{ ok: true; data: Uint8Array }>;
    onPin: (cb: (payload: { tabId: string }) => void) => () => void;
    onUnpin: (cb: (payload: { tabId: string }) => void) => () => void;
    onTabOpRequest: (
      cb: (req: import('../shared/rsbBrowserBridge').RsbBrowserBridgeTabOpRequest) => void,
    ) => () => void;
    tabOpResult: (
      result: import('../shared/rsbBrowserBridge').RsbBrowserBridgeTabOpResult,
    ) => Promise<{ ok: true } | { ok: false; error: string }>;
    setActiveSession: (input: { sessionId: string | null }) => Promise<{ ok: true }>;
    setForeground: (input: { tabId: string | null }) => Promise<{ ok: true }>;
    forceKill: (input: { tabId: string; webContentsId?: number }) => Promise<{ ok: true }>;
    onResourceEvent: (
      cb: (event: import('../shared/rsbBrowserBridge').RsbBrowserBridgeResourceEvent) => void,
    ) => () => void;
  };
  processMonitor: {
    subscribe: () => Promise<void>;
    unsubscribe: () => Promise<void>;
    terminate: (
      request: import('../shared/processMonitor').TerminateAgentProcessRequest,
    ) => Promise<import('../shared/processMonitor').TerminateAgentProcessResult>;
    onSample: (
      cb: (sample: import('../shared/processMonitor').ProcessMonitorSample) => void,
    ) => () => void;
  };
  browserBackend: {
    getState: () => Promise<{
      active: 'external' | 'rsb-webview';

      systemDefault: 'external' | 'rsb-webview';

      isOverride: boolean;
    }>;
    setKind: (kind: 'external' | 'rsb-webview') => Promise<{
      ok: true;

      active: 'external' | 'rsb-webview';
    }>;
    reset: () => Promise<{ ok: true; active: 'external' | 'rsb-webview' }>;
    getHealth: () => Promise<BrowserBackendHealth>;
    recover: () => Promise<BrowserBackendRecoveryResult>;
  };
  dialog: {
    showOpenDirectory: (params?: { defaultPath?: string }) => Promise<{
      success: boolean;

      path: string | null;
    }>;
    showOpenFile: (params?: {
      defaultPath?: string;

      filters?: Array<{ name: string; extensions: string[] }>;
    }) => Promise<{
      success: boolean;

      path: string | null;
    }>;
    showOpenResource: (params?: { defaultPath?: string }) => Promise<{
      success: true;

      path: string | null;

      kind: 'file' | 'directory' | null;
    }>;
  };
  maker: {
    listAvailableAgents: () => Promise<Array<'claude-code' | 'codex' | 'pi'>>;
    getCapabilities: (agentKind: 'claude-code' | 'codex' | 'pi') => Promise<unknown>;
    getWorkflowProgress: (
      sessionId: string,

      taskId: string,
    ) => Promise<import('../shared/workflow-progress').WorkflowProgress | null>;
    listProviders: () => Promise<{
      dataOwnerId: string | null;

      ownerGeneration: number;

      providers: import('@cindy/model-providers').ProviderView[];

      providerOrder: string[];
    }>;
    refreshBuiltinProviderModels: (
      providerId: import('../shared/providerModelRefresh').BuiltinRefreshableProviderId,
    ) => Promise<import('../shared/providerModelRefresh').ProviderModelRefreshResult>;
    requestProviderModelsAutoRefresh: (
      trigger: import('../shared/providerModelRefresh').ProviderModelAutoRefreshRendererTrigger,
    ) => Promise<import('../shared/providerModelRefresh').ProviderModelAutoRefreshResult>;
    createCustomProvider: (
      config: import('@cindy/model-providers').CustomProviderConfig,

      keys: Partial<Record<'claude-code' | 'codex' | 'pi', string>>,
    ) => Promise<{ ok: true }>;
    updateCustomProvider: (
      config: import('@cindy/model-providers').CustomProviderConfig,

      keys: Partial<Record<'claude-code' | 'codex' | 'pi', string>>,
    ) => Promise<{ ok: true }>;
    deleteCustomProvider: (providerId: string) => Promise<{ ok: true }>;
    listProviderPresets: () => Promise<{
      presets: import('@cindy/model-providers').ProviderPreset[];
    }>;
    testProviderConnection: (
      input:
        | { kind: 'saved'; providerId: string; agent: 'claude-code' | 'codex' | 'pi' }
        | {
            kind: 'adhoc';

            spec: {
              agent: 'claude-code' | 'codex' | 'pi';

              baseUrl: string;

              modelId: string;

              authMethod: 'apiKey' | 'oauth' | 'none';

              wireProtocol?: import('@cindy/model-providers').ProviderWireProtocol;

              requestPath?: string;

              apiKey?: string | null;

              headers?: Record<string, string>;
            };
          },
    ) => Promise<{
      ok: boolean;

      code?: import('../shared/providerErrors').ProviderErrorCode;

      status?: number;

      latencyMs: number;

      detail?: string;
    }>;
    fetchProviderModels: (input: {
      agent: 'claude-code' | 'codex' | 'pi';

      baseUrl: string;

      authMethod: 'apiKey' | 'oauth' | 'none';

      wireProtocol?: import('@cindy/model-providers').ProviderWireProtocol;

      modelsUrl?: string | null;

      apiKey?: string | null;

      headers?: Record<string, string>;

      /** 已保存供应商 id:main 侧据此并入 main-only 鉴权请求头(renderer 不回读明文头)。 */

      savedProviderId?: string;
    }) => Promise<{
      ok: boolean;

      models?: { id: string; name: string; contextWindow?: number }[];

      code?: import('../shared/providerErrors').ProviderErrorCode;

      status?: number;

      detail?: string;
    }>;
    scanLocalCli: () => Promise<{
      detections: import('../shared/localCliDetect').LocalCliDetection[];
    }>;
    rediscoverModels: (providerId: string) => Promise<{
      ok: boolean;

      failure?: import('@cindy/model-providers').ProviderModelDiscoveryFailureView;
    }>;
    onProvidersChanged: (cb: () => void) => () => void;
    listCustomMcpServers: () => Promise<{
      servers: import('../shared/customMcp').CustomMcpConfig[];
    }>;
    createCustomMcpServer: (
      config: import('../shared/customMcp').CustomMcpConfig,
    ) => Promise<{ ok: true }>;
    updateCustomMcpServer: (
      config: import('../shared/customMcp').CustomMcpConfig,
    ) => Promise<{ ok: true }>;
    deleteCustomMcpServer: (mcpId: string) => Promise<{ ok: true }>;
    refreshCustomMcpCodex: () => Promise<{ ok: true }>;
    onMcpChanged: (cb: () => void) => () => void;
    providerOAuthLogin: (
      providerId: string,

      options?: { ownerId?: string },
    ) => Promise<{ ok: boolean; reason?: string }>;
    providerOAuthLogout: (providerId: string) => Promise<{ ok: true }>;
    providerOAuthCancel: (
      providerId: string,

      options?: { releaseOwner?: boolean; ownerId?: string },
    ) => Promise<{ ok: true }>;
    onProviderOAuthProgress: (
      cb: (progress: {
        providerId: string;

        phase: 'device-code';

        verificationUrl: string;

        userCode: string;

        expiresAt: number;
      }) => void,
    ) => () => void;
    onProviderUpstreamError: (
      cb: (event: {
        agent: 'claude-code' | 'codex' | 'pi';

        providerId: string;

        providerName?: string;

        code: import('../shared/providerErrors').ProviderErrorCode;

        retryable: boolean;

        status: number;

        detail?: string;

        errorType?: string;

        reqId?: number;
      }) => void,
    ) => () => void;
    onAutoPermissionFallback: (
      cb: (event: {
        sessionId: string;

        from: 'auto';

        to: 'ask';

        reason: 'classifier_unavailable';

        status: number;
      }) => void,
    ) => () => void;
    getSessionBackgroundActivity: (sessionId: string) => Promise<{ active: boolean }>;
    listSessionBackgroundActivity: () => Promise<{ sessionIds: string[] }>;
    stopSessionBackgroundTasks: (sessionId: string) => Promise<{ ok: true }>;
    onSessionBackgroundActivityChanged: (
      cb: (payload: { sessionId: string; active: boolean }) => void,
    ) => () => void;
    stopAgentTask: (sessionId: string, taskId: string) => Promise<{ ok: true }>;
    listSessionBackgroundTasks: (sessionId: string) => Promise<{
      tasks: Array<{ taskId: string; taskType?: string; toolUseId?: string; title?: string }>;

      /** 「任务已终态、wake turn 尚未启动或仍在跑」的 continuation claim 数(桥接对账收口权威依据)。 */

      pendingContinuations?: number;
    }>;
    syncModelVisibility: (
      dataOwnerId: string | null,

      ownerGeneration: number,

      map: Record<string, boolean>,
    ) => Promise<void>;
    claimLegacyModelVisibilityOwner: () => import('../shared/modelVisibility').ModelVisibilityLegacyOwnerClaim;
    setModelDisable: (
      input:
        | { kind: 'model'; providerId: string; modelIds: string[]; disabled: boolean }
        | { kind: 'provider'; providerId: string; disabled: boolean }

        // reset = 恢复默认:删除该供应商整组停用 override(含指向已下架模型的陈旧条目)。
        | { kind: 'reset'; providerId: string },
    ) => Promise<{ ok: true }>;
    setProviderOrder: (
      dataOwnerId: string | null,

      ownerGeneration: number,

      providerIds: string[],
    ) => Promise<{ ok: true }>;
    getModelPriceOverride: (
      target: import('../shared/modelPriceOverride').ModelPriceOverrideTarget,
    ) => Promise<import('../shared/modelPriceOverride').ModelPriceOverrideView>;
    setModelPriceOverride: (
      target: import('../shared/modelPriceOverride').ModelPriceOverrideTarget,

      desired: import('../shared/modelPriceOverride').ModelPriceOverrideDesiredQuote,
    ) => Promise<import('../shared/modelPriceOverride').ModelPriceOverrideView>;
    resetModelPriceOverride: (
      target: import('../shared/modelPriceOverride').ModelPriceOverrideTarget,
    ) => Promise<import('../shared/modelPriceOverride').ModelPriceOverrideView>;
    openSessionInNewWindow: (sessionId: string, deviceId?: string | null) => Promise<void>;
    openSessionInNewWindowIfDroppedOutside: (
      sessionId: string,

      deviceId?: string | null,
    ) => Promise<boolean>;
    beginSessionDragPreview: (
      label: string,

      sessionId: string,

      deviceId: string | null | undefined,

      palette: import('../shared/sessionDragPreview').SessionDragPreviewPalette,
    ) => Promise<void>;
    endSessionDragPreview: (dragEndAtMs?: number) => void;
    listDesktopCommands: () => Promise<{
      success: boolean;

      error?: string;

      commands?: Array<{ kind: 'desktop'; name: string; description: string }>;
    }>;
    executeDesktopCommand: (
      name: string,

      ctx: { sessionId?: string; workingDir?: string; args?: string; deviceId?: string },
    ) => Promise<{ success: boolean; error?: string }>;
    startReview: (input: {
      sourceSessionId: string;

      focus?: string;

      attachments?: import('./lib/fileTypes').SerializedAttachedFile[];
    }) => Promise<{ ok: true; runId: string; reviewerSessionId: string }>;
    listAgentCommands: (
      agentKind: 'claude-code' | 'codex' | 'pi',

      params?: { sessionId?: string; allowManagedPiPackagePreview?: boolean },
    ) => Promise<{
      success: boolean;

      error?: string;

      commands?: Array<{ kind: 'agent-builtin'; name: string; description: string }>;

      runtimeStatus?: import('../shared/piPackages').PiPackageCommandRuntimeStatus;
    }>;
    listAgentSkills: (
      agentKind: 'claude-code' | 'codex' | 'pi',

      params: { workingDir?: string; forceReload?: boolean; sessionId?: string },
    ) => Promise<{
      success: boolean;

      error?: string;

      skills?: Array<{
        kind: 'agent-skill';

        name: string;

        description?: string;

        source: 'user' | 'skill';

        path?: string;

        scope?: string;

        enabled?: boolean;

        runtimeStatus?: 'discovered' | 'approved' | 'loaded' | 'failed' | 'unknown';

        runtimeCommandName?: string;
      }>;
    }>;
    listPiPackages: () => Promise<import('../shared/piPackages').PiPackageListResult>;
    mutatePiPackage: (
      request: import('../shared/piPackages').PiPackageMutationRequest,
    ) => Promise<import('../shared/piPackages').PiPackageMutationResult>;
    onPiPackagesChanged: (handler: () => void) => () => void;
    onDesktopCommandTriggered: (
      handler: (payload: {
        command: string;

        sessionId?: string;

        workingDir?: string;

        args?: string;

        result?: {
          cmdLine: string;

          cwd: string;

          exitCode: number;

          stdout: string;

          stderr: string;

          elapsedMs: number;

          timedOut: boolean;

          spawnError?: string;
        };

        /** /goal、/learn 共用:错误码(goal-usage / goal-no-session / goal-failed;

             *  learn-usage / learn-busy / learn-failed)。 */

        error?: string;

        /** /goal 专用:动作('set'/'cleared'/'open-dialog'=打开新建目标弹窗)。 */

        goalAction?: 'set' | 'cleared' | 'open-dialog';

        /** /learn 专用:启动成功时的 runId(关联 learn:event 状态流)。 */

        learnRunId?: string;
      }) => void,
    ) => () => void;
    setGoal: (input: {
      sessionId: string;

      objective: string;

      limits?: {
        maxTurns: number | null;

        budgetTokens: number | null;

        noProgressLimit: number | null;
      };
    }) => Promise<{ ok: boolean }>;
    clearGoal: (sessionId: string) => Promise<{ ok: boolean }>;
    pauseGoal: (sessionId: string) => Promise<{ ok: boolean }>;
    resumeGoal: (sessionId: string) => Promise<{ ok: boolean }>;
    updateGoal: (
      sessionId: string,

      patch: {
        objective?: string;

        maxTurns?: number | null;

        budgetTokens?: number | null;

        noProgressLimit?: number | null;
      },
    ) => Promise<{ ok: boolean }>;
    getGoalStatus: (sessionId: string) => Promise<GoalStatusPayload | null>;
    onGoalStatusChanged: (
      handler: (payload: { sessionId: string; goal: GoalStatusPayload | null }) => void,
    ) => () => void;
    scanAtResources: (
      agentKind: 'claude-code' | 'codex' | 'pi',

      params: { workingDir: string; cap?: number; query?: string },
    ) => Promise<{
      success: boolean;

      error?: string;

      items?: Array<
        | { type: 'file'; name: string; relPath: string; description?: string }
        | { type: 'dir'; name: string; relPath: string; description?: string }
        | { type: 'agent'; name: string; relPath: string; description?: string }
      >;

      truncated?: boolean;
    }>;
    listAtContext: (params: {
      sessionId?: string;

      workingDir?: string;

      query?: string;

      limit?: number;
    }) => Promise<{
      success: true;

      browserTabs: Array<{ tabId: string; title: string; url: string }>;

      desktopWindows: Array<{
        windowId: number;

        pid: number;

        appName: string;

        title: string;
      }>;

      unavailable: Array<'browser-tabs' | 'desktop-windows'>;
    }>;
    createSession: (opts: {
      /** 可选: 复用外部 sessionId(本端 chat 用 local-db:sessions:create 拿到的 id) */

      id?: string;

      agentKind: 'claude-code' | 'codex' | 'pi';

      workingDir: string;

      model: string;

      title?: string;

      parentSessionId?: string;

      orcaRole?: import('@/lib/ccAgent.types').OrcaRole | null;

      effort?: string;

      fastMode?: boolean;

      permissionMode?: string;

      /** 计划模式一级开关(与 permissionMode 正交)。 */

      planMode?: boolean;

      systemPrompt?: string;

      /** 用户级 system prompt 末段 (lib/userPromptStore 来源, 不持久化到 DB)。 */

      userPrompt?: string;

      /** Maker Memory 启用 flag (lib/memorySettingsStore 来源, mode==='maker' 时透传 true)。 */

      makerMemoryEnabled?: boolean;

      /** 附加只读引用目录列表 (绝对路径)。Codex agent 收到会忽略 (capability=false)。 */

      extraDirs?: string[];

      displayReasoning?: 'off' | 'summarized' | 'full';

      /** 远端 host alias (Codex only) — codex agent 跑在远端机器上, workingDir 是远端路径。 */

      remoteHostId?: string;

      vendorOptions?: Record<string, unknown>;
    }) => Promise<{
      sessionId: string;

      agentKind: string;

      workDir: string;

      capabilities: unknown;

      usedProjectContext?: boolean;
    }>;
    markOrcaRole: (
      sessionId: string,

      role: import('@/lib/ccAgent.types').OrcaRole,
    ) => Promise<void>;
    enableOrca: (
      leadSessionId: string,

      opts: {
        workerAgent: 'claude-code' | 'codex' | 'pi';

        delegateTask?: string;

        role?: string;

        label?: string;

        model?: string;

        effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

        fast?: boolean;

        /** 显式选定的模型来源(标准面板 per-worker 选择);缺省 = 跟随默认路由解析。 */

        providerId?: string | null;

        /** Worker 创建默认权限；缺省沿用当前偏好，显式值会更新偏好。 */

        workerPermissionMode?: 'auto' | 'bypassPermissions';

        /** 新建 Lead 专用：等首条输入 accepted 且可查询后再派任务。 */

        deferDelegateTask?: boolean;
      },
    ) => Promise<{
      teamId: string;

      workerSessionId: string;

      workerId: string;

      dispatched: boolean;

      workerPermissionMode: 'auto' | 'bypassPermissions';

      uiAssignmentSnapshotBeforeMs: number;
    }>;
    dispatchOrcaUiAssignment: (
      leadSessionId: string,

      workerSessionId: string,

      initialTask: string,

      snapshotBeforeMs: number,

      waitForLeadHistory: boolean,
    ) => Promise<unknown>;
    disableOrca: (leadSessionId: string) => Promise<{ ok: true }>;
    send: (
      sessionId: string,

      message:
        string | { type: 'user'; content: string | Array<{ type: string; [k: string]: unknown }> },

      createOpts?: {
        agentKind: 'claude-code' | 'codex' | 'pi';

        workingDir: string;

        model: string;

        orcaRole?: import('@/lib/ccAgent.types').OrcaRole | null;

        effort?: string;

        fastMode?: boolean;

        permissionMode?: string;

        /** 计划模式一级开关(与 permissionMode 正交)。 */

        planMode?: boolean;

        /** 用户级 system prompt 末段; 仅 lazy-create 那一次生效, 已 spawn 的 session 忽略。 */

        userPrompt?: string;

        /** Maker Memory 启用 flag; 仅 lazy-create 那一次生效。 */

        makerMemoryEnabled?: boolean;

        /** 附加只读引用目录列表; 仅 lazy-create 那一次生效, 已 spawn 的 session 走 setExtraDirs。 */

        extraDirs?: string[];

        displayReasoning?: 'off' | 'summarized' | 'full';

        vendorOptions?: Record<string, unknown>;

        resumeSessionId?: string;
      },

      sendOpts?: {
        /** 这条 user 消息的 SDK uuid (renderer 与 messages.agent_meta.uuid 同源, rewind 锚点)。 */

        messageUuid?: string;

        /** 当前用户的展示名 (个人化 turn-start status: "<name> Just Wait ...")。 */

        userName?: string;

        /** Codex renderer 队列路径需要“已接受或已拒绝”的语义,再决定是否落库。 */

        throwOnStartFailure?: boolean;

        /** Direct Continue fallback:执行端在 dispatch 成功后确认旧中断。 */

        ackInterruptedTurnOnDispatch?: boolean;
      },
    ) => Promise<{ accepted: true } | { accepted: false; reason?: string }>;
    steer: (
      sessionId: string,

      message:
        string | { type: 'user'; content: string | Array<{ type: string; [k: string]: unknown }> },

      sendOpts?: {
        /** 这条 user 消息的 SDK uuid (renderer 与 messages.agent_meta.uuid 同源, rewind 锚点)。 */

        messageUuid?: string;

        /** 当前用户的展示名 (个人化 turn-start status: "<name> Just Wait ...")。 */

        userName?: string;
      },
    ) => Promise<void>;
    getContextUsage: (
      sessionId: string,

      createOpts?: {
        agentKind: 'claude-code' | 'codex' | 'pi';

        workingDir: string;

        model: string;

        orcaRole?: import('@/lib/ccAgent.types').OrcaRole | null;

        effort?: string;

        fastMode?: boolean;

        permissionMode?: string;

        /** 计划模式一级开关(与 permissionMode 正交)。 */

        planMode?: boolean;

        userPrompt?: string;

        makerMemoryEnabled?: boolean;

        extraDirs?: string[];

        displayReasoning?: 'off' | 'summarized' | 'full';

        vendorOptions?: Record<string, unknown>;

        remoteHostId?: string;

        resumeSessionId?: string;
      },
    ) => Promise<import('@cindy/maker-core').ContextUsageData>;
    abortSession: (sessionId: string) => Promise<void>;
    closeSession: (sessionId: string, opts?: { preserveWorkspace?: boolean }) => Promise<void>;
    deleteMessage: (
      sessionId: string,

      clientId: string,
    ) => Promise<{ sessionId: string; clientId: string; clientIds: string[] }>;
    listActive: () => Promise<
      Array<{
        sessionId: string;

        agentKind: 'claude-code' | 'codex' | 'pi';

        workDir: string;

        capabilities: unknown;

        isTurnRunning: boolean;
      }>
    >;
    onInputProjection: (
      cb: (payload: import('../shared/agentInputQueue').AgentInputProjection) => void,
    ) => () => void;
    input: {
      getProjection: (
        sessionId: string,
      ) => Promise<import('../shared/agentInputQueue').AgentInputProjection>;
      enqueue: (
        sessionId: string,

        item: import('../shared/agentInputQueue').AgentInputQueuedMessage,

        opts?: { sendAtMs?: number; expectedClearBoundaryMs?: number | null },
      ) => Promise<import('../shared/agentInputQueue').AgentInputProjection>;
      compact: (
        sessionId: string,

        createOpts: import('../shared/agentInputQueue').AgentInputCreateOpts,

        opts?: { userName?: string; expectedClearBoundaryMs?: number | null },
      ) => Promise<import('../shared/agentInputQueue').AgentInputProjection>;
      steer: (
        sessionId: string,

        item: import('../shared/agentInputQueue').AgentInputQueuedMessage,

        opts?: {
          removeFromQueue?: boolean;

          touchUserSend?: boolean;

          expectedClearBoundaryMs?: number | null;
        },
      ) => Promise<boolean>;
      stop: (
        sessionId: string,

        opts?: {
          keepQueue?: boolean;

          pauseQueue?: boolean;

          expectedClearBoundaryMs?: number | null;
        },
      ) => Promise<import('../shared/agentInputQueue').AgentInputProjection>;
      resume: (
        sessionId: string,

        opts?: { expectedClearBoundaryMs?: number | null },
      ) => Promise<import('../shared/agentInputQueue').AgentInputProjection>;
      retryLastError: (
        sessionId: string,

        opts?: { expectedClearBoundaryMs?: number | null },
      ) => Promise<import('../shared/agentInputQueue').AgentInputProjection>;
      clearError: (
        sessionId: string,

        opts?: { expectedClearBoundaryMs?: number | null },
      ) => Promise<import('../shared/agentInputQueue').AgentInputProjection>;
      persistTurnErrorDeferred: (
        sessionId: string,

        errData: Record<string, unknown> | null,

        agentMeta?: import('@/lib/ccAgent.types').AgentMeta | null,
      ) => Promise<void>;
      remove: (
        sessionId: string,

        clientId: string,

        opts?: { expectedClearBoundaryMs?: number | null },
      ) => Promise<import('../shared/agentInputQueue').AgentInputProjection>;
      updateText: (
        sessionId: string,

        clientId: string,

        newText: string,

        sessionRefs?: import('../shared/agentInputQueue').AgentInputSessionRef[],

        trustedContexts?: import('../shared/agentInputQueue').AgentInputSessionReferenceContext[],

        opts?: { expectedClearBoundaryMs?: number | null },
      ) => Promise<import('../shared/agentInputQueue').AgentInputProjection>;
      move: (
        sessionId: string,

        clientId: string,

        targetIndex: number,

        opts?: { expectedClearBoundaryMs?: number | null },
      ) => Promise<import('../shared/agentInputQueue').AgentInputProjection>;
      setExpanded: (
        sessionId: string,

        expanded: boolean,

        opts?: { expectedClearBoundaryMs?: number | null },
      ) => Promise<import('../shared/agentInputQueue').AgentInputProjection>;
      setInteractionLock: (
        sessionId: string,

        lockId: string,

        locked: boolean,

        opts?: { expectedClearBoundaryMs?: number | null },
      ) => Promise<import('../shared/agentInputQueue').AgentInputProjection>;
      setEditLock: (
        sessionId: string,

        clientId: string,

        locked: boolean,

        opts?: { expectedClearBoundaryMs?: number | null },
      ) => Promise<import('../shared/agentInputQueue').AgentInputProjection>;
      clearSession: (
        sessionId: string,

        clearedAt?: string,
      ) => Promise<import('../shared/agentInputQueue').AgentInputProjection>;
    };
    resolveInteraction: (requestId: string, decision: Record<string, unknown>) => Promise<void>;
    submitPluginSetupInline: (request: {
      requestId: string;

      actionId: string;

      expectedRevision: number;

      value: string;
    }) => Promise<void>;
    getPendingInteractions: (sessionId: string) => Promise<
      Array<{
        request: { kind: string; requestId: string; [k: string]: unknown };

        persistId?: string;
      }>
    >;
    setModel: (
      sessionId: string,

      model: string,

      providerId?: string | null,

      expectedAgentSwitchRevision?: number,

      selection?: { effort: string; fastMode: boolean },
    ) => Promise<{ deferred: boolean; superseded?: boolean } | undefined>;
    switchSessionAgent: (
      sessionId: string,

      targetAgentKind: 'claude-code' | 'codex' | 'pi',

      model: string,

      providerId?: string | null,

      effort?: string,

      fastMode?: boolean,
    ) => Promise<{
      switched: boolean;

      agentKind: 'claude-code' | 'codex' | 'pi';

      model: string;

      engineReady: boolean;

      deferred?: boolean;

      sameEngineRevision?: number;

      sameEngineSuperseded?: boolean;
    }>;
    getSessionAgentSwitchIntent: (sessionId: string) => Promise<{
      targetAgentKind: 'claude-code' | 'codex' | 'pi';

      model: string;

      providerId: string | null;

      effort?: string;

      fastMode?: boolean;
    } | null>;
    setEffort: (sessionId: string, effort: string) => Promise<void>;
    setPermissionMode: (sessionId: string, mode: string) => Promise<void>;
    setFastMode: (sessionId: string, enabled: boolean) => Promise<void>;
    setPlanMode: (sessionId: string, enabled: boolean) => Promise<void>;
    exportSessionHtml: (sessionId: string) => Promise<string | null>;
    compactSession: (
      sessionId: string,

      instructions?: string,
    ) => Promise<{ tokensBefore?: number; estimatedTokensAfter?: number; noop?: boolean } | null>;
    getSessionTree: (sessionId: string) => Promise<MakerSessionTreeSnapshot | null>;
    navigateSessionTree: (
      sessionId: string,

      entryId: string,

      options?: { summarize?: boolean; customInstructions?: string },
    ) => Promise<{
      tree: MakerSessionTreeSnapshot;

      draftText?: string;

      cancelled?: boolean;
    } | null>;
    setExtraDirs: (sessionId: string, dirs: string[]) => Promise<void>;
    memoryGet: (agentKind: 'claude-code' | 'codex' | 'pi') => Promise<{
      enabled: boolean;

      source: 'agent-default' | 'host-runtime' | 'user-config';

      stats?: { entryCount?: number; sizeBytes?: number; storagePath?: string };
    }>;
    memorySet: (
      agentKind: 'claude-code' | 'codex' | 'pi',

      enabled: boolean,
    ) => Promise<{
      effective: 'immediate' | 'next-session';

      isCustomized: boolean;

      customizedKeys: string[];

      defaults: { maker: boolean; claudeCode: boolean; codex: boolean; pi: boolean };
    }>;
    memoryReset: (agentKind: 'claude-code' | 'codex' | 'pi') => Promise<{
      removedEntries?: number;

      removedBytes?: number;
    }>;
    makerMemorySetEnabled: (enabled: boolean) => Promise<{
      effective: 'next-session';

      isCustomized: boolean;

      customizedKeys: string[];

      defaults: { maker: boolean; claudeCode: boolean; codex: boolean; pi: boolean };

      /** true = Codex 正忙, 存活会话的软重启在任务结束后自动补做 (设置已生效) */

      codexRestartDeferred: boolean;
    }>;
    makerMemoryReset: () => Promise<{ removedCount: number }>;
    memoryGetSettings: () => Promise<{
      maker: boolean;

      claudeCode: boolean;

      codex: boolean;

      pi: boolean;
    }>;
    memoryGetSettingsState: () => Promise<{
      maker: boolean;

      claudeCode: boolean;

      codex: boolean;

      pi: boolean;

      isCustomized: boolean;

      customizedKeys: string[];

      defaults: { maker: boolean; claudeCode: boolean; codex: boolean; pi: boolean };
    }>;
    memoryPreserveLegacyMakerDisabled: (legacyRendererValue: boolean | null) => Promise<{
      maker: boolean;

      claudeCode: boolean;

      codex: boolean;

      pi: boolean;
    }>;
    memoryResetSettings: () => Promise<{
      maker: boolean;

      claudeCode: boolean;

      codex: boolean;

      pi: boolean;

      isCustomized: boolean;

      customizedKeys: string[];

      defaults: { maker: boolean; claudeCode: boolean; codex: boolean; pi: boolean };

      /** true = Codex 正忙, 存活会话的软重启在任务结束后自动补做 (设置已生效) */

      codexRestartDeferred: boolean;
    }>;
    imDefaultSettingsGet: (channel?: ImDefaultSettingsChannel) => Promise<ImDefaultSettingsState>;
    imDefaultSettingsSet: (
      patch: ImDefaultSettingsPatch,

      channel?: ImDefaultSettingsChannel,
    ) => Promise<ImDefaultSettingsState>;
    imDefaultSettingsReset: (channel?: ImDefaultSettingsChannel) => Promise<ImDefaultSettingsState>;
    subagentModelSettingsGet: () => Promise<SubagentModelSettingsState>;
    subagentModelSettingsSet: (
      patch: SubagentModelSettingsPatch,
    ) => Promise<SubagentModelSettingsWriteResult>;
    subagentModelSettingsReset: () => Promise<SubagentModelSettingsWriteResult>;
    visionBridgeSettingsGet: () => Promise<VisionBridgeSettingsState>;
    visionBridgeSettingsSet: (
      patch: VisionBridgeSettingsPatch,
    ) => Promise<VisionBridgeSettingsState>;
    visionBridgeSettingsReset: () => Promise<VisionBridgeSettingsState>;
    agentResourceSettingsGet: () => Promise<AgentResourceSettingsWire>;
    agentResourceSettingsSet: (
      key: 'maxConcurrentCommands' | 'processPriority' | 'capToolchainThreads',

      value: number | string | boolean,
    ) => Promise<AgentResourceSettingsWire>;
    agentResourceSettingsReset: () => Promise<AgentResourceSettingsWire>;
    silentEncryptedRetryGet: () => Promise<{
      enabled: boolean;

      isCustomized?: boolean;

      defaultEnabled?: boolean;
    }>;
    silentEncryptedRetrySet: (enabled: boolean) => Promise<{
      enabled: boolean;

      isCustomized: boolean;

      defaultEnabled: boolean;

      effective: 'immediate';
    }>;
    silentEncryptedRetryReset: () => Promise<{
      enabled: boolean;

      isCustomized: boolean;

      defaultEnabled: boolean;

      effective: 'immediate';
    }>;
    compactionGetPct: () => Promise<number>;
    compactionGetState: () => Promise<{ pct: number; isCustomized: boolean; defaultPct: number }>;
    compactionSetPct: (
      pct: number,
    ) => Promise<{ pct: number; isCustomized: boolean; defaultPct: number }>;
    compactionResetPct: () => Promise<{ pct: number; isCustomized: boolean; defaultPct: number }>;
    lspModeGet: () => Promise<{ enabled: boolean }>;
    lspModeSet: (enabled: boolean) => Promise<{ effective: 'next-session' }>;
    chatEmbeddingGet: () => Promise<{
      enabled: boolean;

      isCustomized?: boolean;

      defaultEnabled?: boolean;
    }>;
    chatEmbeddingSet: (
      enabled: boolean,
    ) => Promise<{ enabled: boolean; isCustomized: boolean; defaultEnabled: boolean }>;
    chatEmbeddingReset: () => Promise<{
      enabled: boolean;

      isCustomized: boolean;

      defaultEnabled: boolean;
    }>;
    gitSafetyGet: () => Promise<{
      autoSnapshotEnabled: boolean;

      isCustomized: boolean;

      defaultAutoSnapshotEnabled: boolean;
    }>;
    gitSafetySet: (enabled: boolean) => Promise<{
      autoSnapshotEnabled: boolean;

      isCustomized: boolean;

      defaultAutoSnapshotEnabled: boolean;
    }>;
    gitSafetyReset: () => Promise<{
      autoSnapshotEnabled: boolean;

      isCustomized: boolean;

      defaultAutoSnapshotEnabled: boolean;
    }>;
    contacts: {
      settingsGet: () => Promise<{ enabled: boolean; isCustomized: boolean }>;
      settingsSet: (enabled: boolean) => Promise<{ enabled: boolean; codexMcpRefreshed?: boolean }>;
      syncStatusGet: () => Promise<unknown>;
      syncEnabledSet: (enabled: boolean) => Promise<unknown>;
      syncNow: () => Promise<unknown>;
      list: (opts?: unknown) => Promise<unknown[]>;
      get: (id: string) => Promise<unknown>;
      create: (input: unknown) => Promise<unknown>;
      update: (id: string, patch: unknown) => Promise<unknown>;
      delete: (id: string) => Promise<{ deleted: boolean }>;
      merge: (targetId: string, sourceId: string) => Promise<unknown>;
      resolve: (value: string, opts?: unknown) => Promise<unknown[]>;
      search: (query: string, opts?: unknown) => Promise<unknown[]>;
      stats: () => Promise<{ people: number; orgs: number; pending: number; groups: number }>;
      addIdentity: (contactId: string, input: unknown) => Promise<unknown>;
      removeIdentity: (identityId: string) => Promise<{ removed: boolean }>;
      appendEvent: (contactId: string, input: unknown) => Promise<unknown>;
      deleteEvent: (eventId: string) => Promise<{ deleted: boolean }>;
      addRelation: (fromId: string, input: unknown) => Promise<unknown>;
      removeRelation: (relationId: string) => Promise<{ removed: boolean }>;
      groupsList: () => Promise<unknown[]>;
      groupsCreate: (name: string, description?: string) => Promise<unknown>;
      groupsUpdate: (groupId: string, patch: unknown) => Promise<unknown>;
      groupsDelete: (groupId: string) => Promise<{ deleted: boolean }>;
      groupsSetMembers: (
        groupId: string,

        payload: { add?: string[]; remove?: string[] },
      ) => Promise<{ added: number; removed: number }>;
      resetAll: () => Promise<{ removedCount: number }>;
      systemRead: () => Promise<unknown[]>;
      parseVcf: (text: string) => Promise<unknown[]>;
      import: (records: unknown[], opts?: { groupId?: string }) => Promise<unknown>;
      onChanged: (cb: () => void) => () => void;
      onSyncStatusChanged: (cb: (status: unknown) => void) => () => void;
    };
    codexRuntimeRouteGet: () => Promise<{
      authInjection: 'oauth-bearer' | 'env-key' | 'provider-oauth';
    }>;
    onCodexRuntimeRouteChanged: (
      cb: (payload: { authInjection: 'oauth-bearer' | 'env-key' | 'provider-oauth' }) => void,
    ) => () => void;
    onSessionCredentialSwitchApplied: (
      cb: (payload: { sessionId: string; model: string; providerId: string | null }) => void,
    ) => () => void;
    claudeSessionRouteGet: (sessionId: string) => Promise<'gateway' | 'subscription' | null>;
    onClaudeSessionRouteChanged: (
      cb: (payload: { sessionId: string; route: 'gateway' | 'subscription' }) => void,
    ) => () => void;
    claudeOAuthStatus: () => Promise<{ authorized: boolean }>;
    claudeOAuthLogin: () => Promise<{ ok: boolean; authorized: boolean; reason?: string }>;
    claudeOAuthLogout: () => Promise<{ authorized: boolean }>;
    claudeOAuthCancel: () => Promise<{ authorized: boolean }>;
    xaiOAuthLogin: () => Promise<{ ok: boolean; authorized: boolean; reason?: string }>;
    xaiOAuthLogout: () => Promise<{ authorized: boolean }>;
    xaiOAuthCancel: () => Promise<{ authorized: boolean }>;
    listTurnChangeSets: (
      sessionId: string,
    ) => Promise<import('../shared/turnChangeSet').TurnChangeSetSummary[]>;
    getTurnChangeSets: (
      sessionId: string,

      ids: string[],
    ) => Promise<import('../shared/turnChangeSet').TurnChangeSetDetail[]>;
    applyTurnChangeSet: (
      sessionId: string,

      id: string,

      action: import('../shared/turnChangeSet').TurnChangeAction,
    ) => Promise<import('../shared/turnChangeSet').TurnChangeActionResult>;
    onTurnChangeSetUpdated: (cb: (data: unknown, ownerStamp?: unknown) => void) => () => void;
    onEvent: (cb: (data: unknown) => void) => () => void;
    onStatusChanged: (cb: (data: unknown) => void) => () => void;
    onInteractionRequest: (cb: (data: unknown) => void) => () => void;
    onInteractionDismissed: (cb: (data: unknown) => void) => () => void;
    __resetMakerFanOuts: () => void;
    generateTitle: (
      message: string,

      agentKind: 'claude-code' | 'codex' | 'pi',

      sessionId?: string,
    ) => Promise<{ title: string | null }>;
    regenerateSessionTitle: (sessionId: string) => Promise<{ title: string | null }>;
    autoTitle: (request: {
      sessionId: string;

      text: string;

      agentKind: 'claude-code' | 'codex' | 'pi';

      isUserText?: boolean;
    }) => Promise<{ applied: boolean; done: boolean }>;
    predictNextPrompt: (request: {
      sessionId: string;

      agentKind: 'claude-code' | 'codex' | 'pi';

      messages: Array<{ role: string; content: string }>;

      workingDir?: string;

      turnGen: number;
    }) => Promise<{ prompt: string | null }>;
    helpAsk: (
      request: import('../shared/helpTypes').HelpAskRequest,
    ) => Promise<import('../shared/helpTypes').HelpAnswerResult>;
    helpFeedbackCreate: (
      input: import('../shared/helpTypes').HelpFeedbackDraftInput,
    ) => Promise<import('../shared/helpTypes').HelpFeedbackDraft>;
    getMyIssuesSnapshot: () => Promise<import('../shared/myIssues').MyIssuesSnapshot | null>;
    listMyIssues: (options?: { force?: boolean }) => Promise<
      | ({ success: true } & import('../shared/myIssues').MyIssuesResult)
      | {
          success: false;

          /** 稳定脱敏码,不是原始错误文本。 */

          error: import('../shared/myIssues').MyIssuesErrorCode;

          items: [];

          githubEnhancement: null;

          githubEnhancementFailed: false;

          degraded: null;

          truncated: false;
        }
    >;
    writePlanFile: (params: {
      requestId: string;

      planFilePath: string;

      content: string;
    }) => Promise<{ success: boolean; error?: string }>;
    rewindPreview: (sessionId: string, clientId: string) => Promise<RewindFilesResultPayload>;
    rewindCommit: (
      sessionId: string,

      clientId: string,

      opts?: { requireLatestUser?: boolean; stopIfRunning?: boolean },
    ) => Promise<import('@/lib/ccAgent.types').Session>;
    forkStripEncrypted: (sourceSessionId: string) => Promise<import('@/lib/ccAgent.types').Session>;
    fork: (
      sourceSessionId: string,

      messageClientId: string,
    ) => Promise<import('@/lib/ccAgent.types').Session>;
    auth: {
      getState: (agentKind: 'claude-code' | 'codex' | 'pi') => Promise<CodexAuthState>;
      triggerLogin: (
        agentKind: 'claude-code' | 'codex' | 'pi',

        options?: { mode?: 'browser' | 'device-code'; ownerId?: string },
      ) => Promise<CodexAuthState>;
      cancelLogin: (
        agentKind: 'claude-code' | 'codex' | 'pi',

        options?: { releaseOwner?: boolean; ownerId?: string },
      ) => Promise<void>;
      logout: (agentKind: 'claude-code' | 'codex' | 'pi') => Promise<void>;
      onStateChanged: (
        cb: (s: { agentKind: 'claude-code' | 'codex' | 'pi' } & CodexAuthState) => void,
      ) => () => void;
      onLoginProgress: (
        cb: (p: {
          agentKind: 'claude-code' | 'codex' | 'pi';

          phase: string;

          mode?: 'browser' | 'device-code';

          detail?: string;

          verificationUrl?: string;

          userCode?: string;
        }) => void,
      ) => () => void;
    };
    agent: {
      getStatus: (agentKind: 'claude-code' | 'codex' | 'pi') => Promise<{
        binaryReady: boolean;

        binaryPath: string;

        authReady: boolean;

        identity?: string;
      }>;
      getBinaryVersion: (agentKind: 'claude-code' | 'codex' | 'pi') => Promise<{
        kind: 'claude-code' | 'codex' | 'pi';

        binaryPath: string | null;

        version: string | null;

        error?: string;
      }>;
    };
    usage: {
      getToday: (agentKind: 'claude-code' | 'codex' | 'pi') => Promise<{
        day: string;

        money?: import('../shared/regionalMoney').RegionalMoney;

        costUsd?: number;

        totalTokens?: number;

        promptTokens?: number;

        completionTokens?: number;

        reasoningTokens?: number;

        cachedTokens?: number;
      }>;
      getAccount: (agentKind: 'claude-code' | 'codex' | 'pi') => Promise<unknown | null>;
      getCodexRateLimits: () => Promise<
        import('@cindy/maker-shared/device-link-contract').MobileCodexRateLimitsResult
      >;
      getModelPricing: () => Promise<import('../shared/regionalMoney').ModelPricingCatalog | null>;
      onModelPricingChanged: (
        cb: (pricing: import('../shared/regionalMoney').ModelPricingCatalog | null) => void,
      ) => () => void;
      getReferenceModelPricing: () => Promise<
        import('../shared/regionalMoney').ModelPricingCatalog
      >;
      onReferenceModelPricingChanged: (
        cb: (pricing: import('../shared/regionalMoney').ModelPricingCatalog) => void,
      ) => () => void;
      getHistory: (opts?: {
        days?: number;

        forceRefresh?: boolean;
      }) => Promise<import('../main/usage/usageHistory').UsageHistoryPayload>;
      onTodaySpendChanged: (
        cb: (p: {
          day: string;

          money: import('../shared/regionalMoney').RegionalMoney;

          costUsd?: number;
        }) => void,
      ) => () => void;
      onTodayTokensChanged: (cb: (p: CodexUsageSnapshot) => void) => () => void;
      onClaudeAccountChanged: (
        cb: (p: {
          spend: number;

          maxBudget: number;

          currency: import('../shared/regionalMoney').MoneyCurrency;

          budgetResetAt?: string | null;

          todaySpend: number | null;

          fetchedAt: number;
        }) => void,
      ) => () => void;
      onCodexAccountChanged: (
        cb: (p: {
          limitId?: string | null;

          limitName?: string | null;

          primary?: {
            usedPercent: number;

            windowMinutes?: number | null;

            resetsAt?: number | null;
          } | null;

          secondary?: {
            usedPercent: number;

            windowMinutes?: number | null;

            resetsAt?: number | null;
          } | null;

          credits?: {
            hasCredits: boolean;

            unlimited: boolean;

            balance?: string | null;
          } | null;

          planType?: string | null;

          rateLimitReachedType?: string | null;

          source?: 'openai-web' | 'codex-app-server' | string | null;

          updatedAt?: number | null;

          accountId?: string | null;
        }) => void,
      ) => () => void;
      onXaiRateLimitChanged: (
        cb: (
          p: {
            limitRequests?: number;

            remainingRequests?: number;

            limitTokens?: number;

            remainingTokens?: number;

            updatedAt: number;
          } | null,
        ) => void,
      ) => () => void;
      getXaiSubscription: () => Promise<unknown | null>;
      onXaiSubscriptionChanged: (cb: (payload: unknown) => void) => () => void;
    };
    crossAgent: {
      detect: (
        workingDir: string,

        agentKind: 'claude-code' | 'codex' | 'pi',
      ) => Promise<{ items: CrossAgentMigrationItem[] }>;
      convert: (items: CrossAgentMigrationItem[]) => Promise<{
        total: number;

        successCount: number;

        skippedCount: number;

        failedCount: number;
      }>;
      onStep: (cb: (ev: CrossAgentStepEvent) => void) => () => void;
    };
    schedule: {
      list: (filter?: { status?: 'active' | 'paused' | 'expired' }) => Promise<unknown[]>;
      listTemplates: () => Promise<unknown[]>;
      createFromTemplate: (params: {
        templateId: string;

        paramValues?: Record<string, string>;

        overrides?: unknown;
      }) => Promise<unknown>;
      get: (id: string) => Promise<unknown | null>;
      create: (input: unknown) => Promise<unknown>;
      update: (id: string, patch: unknown) => Promise<unknown>;
      delete: (id: string) => Promise<void>;
      pause: (id: string) => Promise<unknown>;
      resume: (id: string) => Promise<unknown>;
      runNow: (id: string) => Promise<{ runId: string }>;
      scriptCapabilityStatus: () => Promise<{
        statuses: Array<{
          capability: string;

          state: 'ok' | 'ghost-missing' | 'ghost-asleep';

          ghostName?: string;
        }>;
      }>;
      testPreRunHook: (params: {
        command: string;

        timeoutMs?: number;

        workingDir?: string;

        /** 绑定会话任务:workingDir 空时 main 按会话 meta.workDir 解析测试 cwd(与生产一致)。 */

        targetSessionId?: string;

        scheduleName?: string;
      }) => Promise<{
        status: 'passed' | 'skipped' | 'failed' | 'timed_out' | 'aborted';

        decision: 'run' | 'skip' | 'block';

        exitCode: number | null;

        durationMs: number;

        stdout: string;

        stderr: string;

        stdoutTruncated: boolean;

        stderrTruncated: boolean;

        timedOut: boolean;

        aborted: boolean;

        spawnError?: string;

        error?: string;
      }>;
      generatePreRunHook: (params: {
        description: string;

        scheduleName?: string;

        workingDir?: string;

        providerId?: string;

        agentKind?: 'claude-code' | 'codex' | 'pi';

        model?: string;

        /** 绑定会话任务:workingDir 空时 main 按会话 meta.workDir 解析落盘/自测目录。 */

        targetSessionId?: string;

        /** 绑定任务的缺省模型/来源维度由 targetSessionId 的会话路由补齐。 */

        resolveBoundSessionRoute?: boolean;

        currentCommand?: string;
      }) => Promise<
        | {
            ok: true;

            command: string;

            filePath: string;

            content: string;

            test: {
              status: 'passed' | 'skipped' | 'failed' | 'timed_out' | 'aborted';

              decision: 'run' | 'skip' | 'block';

              exitCode: number | null;

              durationMs: number;

              stdout: string;

              stderr: string;

              stdoutTruncated: boolean;

              stderrTruncated: boolean;

              timedOut: boolean;

              aborted: boolean;

              spawnError?: string;

              error?: string;
            };
          }
        | UtilityTextFailure
      >;
      listRuns: (id: string, limit?: number) => Promise<unknown[]>;
      listSidebarIndexRuns: () => Promise<unknown>;
      listCostSummaries: () => Promise<unknown[]>;
      deleteRun: (runId: string) => Promise<void>;
      getInflightCount: (id: string) => Promise<number>;
      getRuntimeState: () => Promise<unknown>;
      getUnreadRunCount: () => Promise<number>;
      markRunRead: (runId: string) => Promise<void>;
      markAllRunsRead: () => Promise<number>;
      markScheduleRunsRead: (scheduleId: string) => Promise<number>;
      onEvent: (
        cb: (
          ev: unknown,

          ownerStamp?: import('../shared/dataOwnerPush').DataOwnerPushStamp,
        ) => void,
      ) => () => void;
    };
    projectAutomation: {
      reconcile: (params: { workingDir: string }) => Promise<ProjectAutomationReconcileResult>;
      listConsents: () => Promise<ProjectAutomationConsent[]>;
      revokeConsent: (workingDir: string) => Promise<{ deleted: number }>;
      upsertSchedule: (params: {
        workingDir: string;

        config: unknown;
      }) => Promise<ProjectAutomationReconcileResult>;
      removeSchedule: (params: {
        workingDir: string;

        id: string;
      }) => Promise<ProjectAutomationReconcileResult>;
      onEvent: (cb: (ev: ProjectAutomationEvent) => void) => () => void;
    };
    plugins: {
      list: (workingDir?: string) => Promise<PluginListItem[]>;
      getState: (
        id: string,

        workingDir?: string,

        workspaceKind?: string | null,
      ) => Promise<PluginEnableState>;
      setEnabled: (id: string, enabled: boolean) => Promise<PluginEnableUpdateResult>;
      clearEnabled: (id: string) => Promise<PluginEnableUpdateResult>;
      setProjectEnabled: (workingDir: string, id: string, enabled: boolean) => Promise<void>;
      clearProjectEnabled: (workingDir: string, id: string) => Promise<void>;
    };
    browser: {
      status: () => Promise<BrowserAvailability>;
      openForLogin: () => Promise<{ launched: boolean }>;
    };
    android: {
      status: () => Promise<AndroidStatusSummary>;
      getConfig: () => Promise<AndroidAutomationConfigState>;
      setDefaultDevice: (
        defaultDeviceSerial: string | null,
      ) => Promise<AndroidAutomationConfigState>;
      setAdbPath: (adbPathOverride: string | null) => Promise<AndroidAutomationConfigState>;
      prepareAdb: () => Promise<AndroidAdbPreparationState>;
    };
    iosSimulator: {
      requestAccess: (
        request: IOSSimulatorAccessRequest,
      ) => Promise<IOSSimulatorAccessRequestResult>;

      status: (request: IOSSimulatorStatusRequest) => Promise<IOSSimulatorSessionStatus>;

      call: (request: IOSSimulatorToolRequest) => Promise<IOSSimulatorToolResponse>;

      setAgentControl: (
        request: IOSSimulatorAgentControlRequest,
      ) => Promise<IOSSimulatorToolResponse>;

      setMutationControl: (
        request: IOSSimulatorMutationControlRequest,
      ) => Promise<IOSSimulatorToolResponse>;

      setViewerVisibility: (
        request: IOSSimulatorViewerVisibilityRequest,
      ) => Promise<IOSSimulatorToolResponse>;

      retryNativeRoute: (
        request: IOSSimulatorRetryNativeRouteRequest,
      ) => Promise<IOSSimulatorToolResponse>;

      latestFrame: (request: IOSSimulatorViewerRouteRequest) => Promise<IOSSimulatorToolResponse>;

      setStreamProfile: (
        request: IOSSimulatorStreamProfileRequest,
      ) => Promise<IOSSimulatorToolResponse>;

      liveTouch: (request: IOSSimulatorLiveTouchRequest) => Promise<IOSSimulatorToolResponse>;

      onH264Frame: (callback: (payload: IOSSimulatorH264FramePush) => void) => () => void;

      onRouteStatus: (callback: (payload: IOSSimulatorRouteStatusPush) => void) => () => void;

      onFocusRequest: (callback: (request: IOSSimulatorFocusRequest) => void) => () => void;
    };
    computer: {
      status: (options?: ComputerDriverStatusOptions) => Promise<ComputerDriverStatus>;
      installDriver: () => Promise<ComputerDriverInstallResult>;
      grantPermissions: (options?: {
        showGuide?: boolean;

        openedPaneUrl?: string;
      }) => Promise<ComputerDriverPermissionGrantResult>;
      driverIcon: () => Promise<{ iconDataUrl: string | null }>;
      permissionGuideStatus: () => Promise<ComputerDriverStatus>;
      startPermissionAppDrag: (iconDataUrl: string) => void;
      finishPermissionAppDrag: (didCopy: boolean) => Promise<boolean>;
      cancelPermissionGrant: () => Promise<{ cancelled: boolean }>;
      onPermissionGuideCancelled: (callback: () => void) => () => void;
      onPermissionGuideStatusChanged: (
        callback: (status: ComputerDriverStatus) => void,
      ) => () => void;
      checkUpdate: () => Promise<ComputerDriverUpdateCheck>;
      updateDriver: (opts?: { joinOnly?: boolean }) => Promise<ComputerDriverInstallResult>;
      onUpdateProgress: (callback: (progress: ComputerDriverUpdateProgress) => void) => () => void;
    };
  };
  mekaDevPlugins: {
    list: () => Promise<{ items: import('../shared/mekaDevPlugin').MekaDevPluginItem[] }>;

    pick: () => Promise<import('../shared/mekaDevPlugin').MekaDevPluginPickResult>;

    install: (
      request: import('../shared/mekaDevPlugin').MekaDevPluginInstallRequest,
    ) => Promise<import('../shared/mekaDevPlugin').MekaDevPluginInstallResult>;

    package: (id: string) => Promise<import('../shared/mekaDevPlugin').MekaDevPluginPackageResult>;

    uploadInfo: (id: string) => Promise<import('../shared/mekaDevPlugin').MekaDevPluginUploadInfo>;

    upload: (
      request: import('../shared/mekaDevPlugin').MekaDevPluginUploadRequest,
    ) => Promise<import('../shared/mekaDevPlugin').MekaDevPluginUploadResult>;

    remove: (id: string) => Promise<{ ok: true }>;

    onChanged: (
      callback: (payload: { items: import('../shared/mekaDevPlugin').MekaDevPluginItem[] }) => void,
    ) => () => void;
  };
  mekaPluginMarket: {
    snapshot: () => Promise<import('../shared/pluginMarket').PluginMarketSnapshot>;

    installedGhostIds: () => Promise<string[]>;

    detail: (pluginId: string) => Promise<import('../shared/pluginMarket').PluginMarketDetail>;

    install: (
      pluginId: string,

      options: {
        expectedReleaseId: string;

        allowPermissionExpansion?: boolean;

        reviewedBaseline?: string;

        approvedPackageSha256?: string;

        operationId: string;
      },
    ) => Promise<import('../shared/pluginMarket').PluginMarketInstallResult>;

    onInstallProgress: (
      callback: (payload: import('../shared/pluginMarket').PluginMarketInstallProgress) => void,
    ) => () => void;

    uninstall: (pluginId: string) => Promise<{ ok: true }>;

    markLocalInstall: (ghostId: string, expectedOwnerId: string) => Promise<{ ok: true }>;
  };
  mekaSkills: {
    snapshot: (
      query?: string,
    ) => Promise<import('../shared/mekaSkillMarket').MekaSkillMarketSnapshot>;

    detail: (skillId: string) => Promise<import('../shared/mekaSkillMarket').MekaSkillMarketDetail>;

    files: (skillId: string) => Promise<import('../shared/mekaSkillMarket').MekaSkillPreviewFile[]>;

    file: (
      skillId: string,

      filePath: string,
    ) => Promise<import('../shared/mekaSkillMarket').MekaSkillPreviewFile>;

    install: (
      request: import('../shared/mekaSkillMarket').MekaSkillInstallRequest,
    ) => Promise<import('../main/skillhub/installService').InstallResult>;

    managementInfo: (
      skillId: string,
    ) => Promise<import('../shared/mekaSkillMarket').MekaSkillManagementInfo>;

    updateAccess: (
      request: import('../shared/mekaSkillMarket').MekaSkillAccessUpdateRequest,
    ) => Promise<import('../shared/mekaSkillMarket').MekaSkillManagementInfo>;

    deletePublished: (
      request: import('../shared/mekaSkillMarket').MekaSkillDeleteRequest,
    ) => Promise<{ ok: true }>;

    pickSource: () => Promise<import('../shared/mekaSkillMarket').MekaSkillPublishInfo | null>;

    publishSource: (
      request: import('../shared/mekaSkillMarket').MekaSkillPublishRequest,
    ) => Promise<import('../shared/mekaSkillMarket').MekaSkillPublishResult>;
  };
  sidebarSettingsLoadPinnedOrderSync: () => string[];
  sidebarSettingsSavePinnedOrder: (order: readonly string[]) => Promise<void>;
  sidebarSettingsOnPinnedOrderChanged: (cb: (order: string[]) => void) => () => void;
  mekaSettings: {
    getP4: () => Promise<import('../shared/meka-settings').MekaP4Settings>;

    setP4Root: (directoryPath: string) => Promise<import('../shared/meka-settings').MekaP4Settings>;

    router: {
      get: () => Promise<import('../shared/meka-router').MekaRouterSettingsView>;

      onOpenLogin: (callback: (requestId: string | null) => void) => () => void;

      reportLoginState: (requestId: string, state: 'presented' | 'cancelled') => Promise<boolean>;

      connect: (input: { routerUrl: string; username: string; password: string }) => Promise<void>;

      register: (input: { routerUrl: string; username: string; password: string }) => Promise<void>;

      disconnect: () => Promise<void>;

      listTools: () => Promise<{
        tools: import('../shared/meka-router').MekaRouterTool[];

        routes: import('../shared/meka-router').MekaRouterRoute[];
      }>;

      setRoute: (routeId: string, enabled: boolean) => Promise<void>;

      connectDesign: (endpoint: string) => Promise<void>;

      useRouterDesign: (conflictId: string) => Promise<void>;

      disconnectDesign: () => Promise<void>;

      listInstances: () => Promise<import('../shared/meka-router').MekaRouterInstance[]>;

      listTemplates: () => Promise<import('../shared/meka-router').MekaRouterTemplate[]>;

      createInstance: (
        templateId: string,

        name: string,
      ) => Promise<import('../shared/meka-router').MekaRouterInstance>;

      getProjectBindings: (projectId: string) => Promise<string[]>;

      setProjectBindings: (projectId: string, instanceIds: string[]) => Promise<void>;
    };
  };
}

/* ── Release notes raw payload shape from CDN ── */

/** Author-grouped item: one block per contributor, with their bullets. */
interface RawReleaseNotesItem {
  name: string;
  list: string[];
}

interface RawReleaseNotesSection {
  title: string;
  items: RawReleaseNotesItem[];
}

/** Topic-format (v2) block: one user-facing theme with a short narrative. */
interface RawReleaseNotesTopic {
  emoji?: string;
  title: string;
  text: string;
  contributors?: string[];
}

interface RawReleaseNotesPayload {
  version: string;
  date: string;
  /**
   * Flat contributor list — collective hall-of-fame on top of per-item `by`.
   * Optional: older notice files predate the field (renderer defaults to []).
   */
  contributors?: string[];
  /** Legacy author-grouped sections. Absent on topic-format payloads. */
  sections?: RawReleaseNotesSection[];
  /** Topic-format blocks. Non-empty ⇒ renderer uses the topic layout. */
  topics?: RawReleaseNotesTopic[];
  /** Optional one-line lead above the topics (e.g. PR/commit counts). */
  intro?: string;
}

/* ── SkillHub Registry types (v0.6) ──
 * Mirror of `src/main/skillhub/registry/types.ts`. Renderer uses these
 * for reading registryEntry on SkillhubSkill; no runtime import needed. */

interface StoredInstall {
  version: string;
  authorId: string;
  folderHash: string;
  installedAt: number;
  updatedAt: number;
  origin?: 'installed' | 'published' | 'learned' | 'imported';
  autoSynced?: boolean;
  provenance?: import('../shared/learnTypes').LearnProvenance;
  distribution?: {
    channel: 'cindy' | 'meka';

    resourceId: string;

    releaseId: string;
  };
}

interface StoredManifest {
  schemaVersion: 1;
  skillName: string;
  installs: Record<string, StoredInstall>;
}

/* ── SkillHub (xdt-maker-技能中心 v0.5) ──
 * Mirror of the canonical types in `src/main/skillhub/scanner.ts`. Kept inline
 * here so the renderer doesn't have to import across process boundaries —
 * vite-env.d.ts is the single declaration surface for `window.electronAPI`.
 *
 * v0.5: scope expanded from skills only to all three native Claude Code
 * customization kinds (skill / command / agent). The `kind` field replaces
 * the older `type` field (which was always 'claude-code' in v0.4). */
type SkillhubKind = 'skill' | 'command' | 'agent';
type SkillhubScope = 'global' | 'project';

interface SkillhubFileEntry {
  name: string;
  kind: 'file' | 'dir';
}

interface SkillhubSkill {
  id: string;
  urlKey: string;
  sourceKey?: string;
  requiresSourceKey?: boolean;
  engine: 'claude-code' | 'codex' | 'pi';
  linkedEngines: Array<{
    engine: 'claude-code' | 'codex' | 'pi';

    label: string;

    runtimeStatus?: 'discovered' | 'approved' | 'loaded' | 'failed' | 'unknown';
  }>;
  kind: SkillhubKind;
  scope: SkillhubScope;
  name: string;
  description?: string;
  absolutePath: string;
  discoveredPath?: string;
  mdPath: string;
  files: SkillhubFileEntry[];
  frontmatter?: Record<string, unknown>;
  parseError?: string;
  projectRoot?: string;
  projectHash?: string;
  registryEntry: StoredInstall | null;
}

type SkillhubSourceStatus =
  { state: 'ok'; count: number } | { state: 'missing' } | { state: 'error'; message: string };

interface SkillhubSourceReport {
  kind: SkillhubKind;
  scope: SkillhubScope;
  projectRoot?: string;
  path: string;
  status: SkillhubSourceStatus;
}

interface SkillhubProjectInput {
  projectRoot: string;
  hash: string;
}

interface SkillUsageSourceBreakdown {
  strongActive: number;
  semiActive: number;
  passive: number;
}

interface SkillUsageAgentBreakdown {
  claude: number;
  codex: number;
}

interface SkillUsageReadObservation {
  fileReadCount: number;
  sessionsWithFileRead: number;
  averageFileReadsPerSession: number;
  extraFileReadCount: number;
  shortWindowRereadSessionCount: number;
  shortWindowRereadRate: number | null;
}

interface SkillUsageDocumentSize {
  characterCount: number;
  byteCount: number;
  estimatedTokenCount: number;
}

interface SkillUsageDocumentVersionSummary {
  skillDocumentHash: string;
  useCount: number;
  firstSeenAt: number;
  latestSeenAt: number;
  agentBreakdown: SkillUsageAgentBreakdown;
  sourceBreakdown: SkillUsageSourceBreakdown;
  readObservation: SkillUsageReadObservation;
  toolCallCount: number;
  repeatedToolCallCount: number;
  toolErrorCount: number;
  commandCallCount: number;
  commandFailureCount: number;
  averageToolCalls: number;
  averageRepeatedToolCalls: number;
  commandFailureRate: number | null;
}

interface SkillUsageTrendPoint {
  day: string;
  useCount: number;
  averageToolCalls: number;
  averageRepeatedToolCalls: number;
  commandFailureRate: number | null;
}

interface SkillUsageSummary {
  skillName: string;
  currentDocumentHash: string | null;
  totalUseCount: number;
  currentDocumentVersionUseCount: number;
  unversionedUseCount: number;
  documentVersionCoverageRate: number | null;
  latestSeenAt: number | null;
  agentBreakdown: SkillUsageAgentBreakdown;
  sourceBreakdown: SkillUsageSourceBreakdown;
  readObservation: SkillUsageReadObservation;
  currentDocumentSize: SkillUsageDocumentSize | null;
  documentVersions: SkillUsageDocumentVersionSummary[];
  currentDocumentVersion: SkillUsageDocumentVersionSummary | null;
  trend: SkillUsageTrendPoint[];
}

type SkillUsageEvidenceBucket = 'tool_failed' | 'command_failed' | 'repeated_calls' | 'recent';

interface SkillUsageEvidenceIndex {
  id: string;
  bucket: SkillUsageEvidenceBucket;
  rawFilePath: string;
  rawLineNo: number;
  sessionId: string;
  sdkSessionId: string;
  agentKind: 'claude-code' | 'codex' | 'pi';
  skillName: string;
  skillPath: string | null;
  skillDocumentHash: string | null;
  exposureContentHash: string;
  documentHashSource: 'transcript_skill_content' | 'transcript_file_read' | 'unavailable' | string;
  source: string;
  toolUseId: string | null;
  seenAt: number;
  observation: {
    toolCallCount: number;
    repeatedToolCallCount: number;
    toolErrorCount: number;
    commandCallCount: number;
    commandFailureCount: number;
  };
}

interface SkillUsageDiagnosisContext {
  skillName: string;
  skillPath: string | null;
  currentDocumentHash: string | null;
  summary: SkillUsageSummary;
  evidence: SkillUsageEvidenceIndex[];
  prompt: string;
}

interface NewMakerWorktreeBranchPreferenceSnapshot {
  baseRepo: string;
  sourceBranch: string;
  revision: number;
}

type LogUploadSettingsPayload = import('../shared/logUpload').LogUploadSettingsPayload;

type LogUploadResult = import('../shared/logUpload').LogUploadResult;

type IOSSimulatorSessionStatus = import('../shared/iosSimulatorIpc').IOSSimulatorSessionStatus;

type IOSSimulatorAccessRequest = import('../shared/iosSimulatorIpc').IOSSimulatorAccessRequest;

type IOSSimulatorAccessRequestResult =
  import('../shared/iosSimulatorIpc').IOSSimulatorAccessRequestResult;

type IOSSimulatorStatusRequest = import('../shared/iosSimulatorIpc').IOSSimulatorStatusRequest;

type IOSSimulatorToolRequest = import('../shared/iosSimulatorIpc').IOSSimulatorToolRequest;

type IOSSimulatorToolResponse = import('../shared/iosSimulatorIpc').IOSSimulatorToolResponse;

type IOSSimulatorAgentControlRequest =
  import('../shared/iosSimulatorIpc').IOSSimulatorAgentControlRequest;

type IOSSimulatorFocusRequest = import('../shared/iosSimulatorIpc').IOSSimulatorFocusRequest;

type IOSSimulatorH264FramePush = import('../shared/iosSimulatorIpc').IOSSimulatorH264FramePush;

type IOSSimulatorRouteStatusPush = import('../shared/iosSimulatorIpc').IOSSimulatorRouteStatusPush;

type IOSSimulatorLiveTouchRequest =
  import('../shared/iosSimulatorIpc').IOSSimulatorLiveTouchRequest;

type IOSSimulatorMutationControlRequest =
  import('../shared/iosSimulatorIpc').IOSSimulatorMutationControlRequest;

type IOSSimulatorViewerRouteRequest =
  import('../shared/iosSimulatorIpc').IOSSimulatorViewerRouteRequest;

type IOSSimulatorViewerVisibilityRequest =
  import('../shared/iosSimulatorIpc').IOSSimulatorViewerVisibilityRequest;

type IOSSimulatorRetryNativeRouteRequest =
  import('../shared/iosSimulatorIpc').IOSSimulatorRetryNativeRouteRequest;

type IOSSimulatorStreamProfileRequest =
  import('../shared/iosSimulatorIpc').IOSSimulatorStreamProfileRequest;

type ProviderRoutingPayload = import('@cindy/model-providers').Provider['routing'];

type RawReleaseNotesPayload = import('../shared/releaseNotesContent').RawReleaseNotes;

type WorkLouderCodexSettingsPatch =
  import('../shared/workLouderCodex').WorkLouderCodexSettingsPatch;

type WorkLouderCodexState = import('../shared/workLouderCodex').WorkLouderCodexState;

type WorkLouderCodexRendererAction =
  import('../shared/workLouderCodex').WorkLouderCodexRendererAction;

type VisionBridgeSettingsPatch = import('../shared/visionBridgeSettings').VisionBridgeSettingsPatch;

type VisionBridgeSettingsState = import('../shared/visionBridgeSettings').VisionBridgeSettingsState;

type CindyMediaPreferenceOption = {
  id: string;
  label: string;
  group: string;
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
  routing?: import('@cindy/model-providers').Provider['routing'];
};

type CindyMediaPreferenceKind = {
  options: CindyMediaPreferenceOption[];
  defaultModel: CindyMediaPreferenceOption | null;
};

/* ── SkillHub v0.2.1 publish types ── */

type SkillhubSyncResult =
  | { name: string; exists: false }
  | {
      name: string;
      exists: true;
      isMine: boolean;
      /** server 权威 authorId,用于本地 registry 回填及离线归属判定。 */
      authorId?: string;
      authorName?: string;
      latestVersion: string;
      folderHash: string;
      visibility: 'PUBLIC' | 'DEPARTMENT_SCOPED';
      marketVersion?: string;
      pendingVersion?: {
        version: string;
        status?: string;
      };
      publishedAt: string;
      downloads: number;
      /** 跨设备识别：null = pre-feature 历史版本 */
      latestPublishedFromDeviceId: string | null;
    };

interface SkillhubInfoResult {
  name: string;
  displayName: string;
  description: string;
  authorId: string;
  authorName: string;
  isMine: boolean;
  latestVersion: string;
  folderHash: string;
  visibility: 'PUBLIC' | 'DEPARTMENT_SCOPED';
  publishedVisibility?: 'private' | 'shared' | 'public';
  ownerType?: string;
  moderationStatus?: string;
  marketVersion?: string;
  pendingVersion?: {
    version: string;
    status?: string;
  };
  visibleDeptIds: string[];
  visibleDeptNames?: string[];
  categories?: string[];
  changelog?: string;
  publishedAt: string;
  downloads: number;
  currentUserDeptIds?: string[];
  currentUserDeptNames?: string[];
  latestPublishedFromDeviceId: string | null;
}

interface SkillhubPublishParams {
  absolutePath: string;
  name: string;
  isFirstPublish: boolean;
  version?: string;
  displayName?: string;
  summary?: string;
  description?: string;
  categoryMode?: 'auto' | 'manual';
  categories?: string[];
  visibility?: 'PUBLIC' | 'DEPARTMENT_SCOPED' | 'PRIVATE';
  visibleSlugs?: string[];
  deptTeamSlug?: string;
  teamSlug?: string;
  changelog?: string;
}

type SkillhubPublishErrorCode =
  | 'NAME_TAKEN'
  | 'INVALID_DEPT'
  | 'INVALID_NAME'
  | 'CATEGORY_REQUIRED'
  | 'MANIFEST_INVALID'
  | 'VERSION_RACE'
  | 'CHECKSUM_MISMATCH'
  | 'NOT_AUTHOR'
  | 'PACK_FAILED'
  | 'OSS_PUT_FAILED'
  | 'OSS_PUT_EXPIRED'
  | 'OSS_OBJECT_NOT_FOUND'
  | 'API_KEY_MISSING'
  | 'CANCELLED'
  | 'INTERNAL';

type SkillhubPublishProgressEvent =
  | { phase: 'packing' }
  | { phase: 'init' }
  | { phase: 'uploading' }
  | { phase: 'commit' }
  | { phase: 'done'; name: string; version: string }
  | {
      phase: 'scan-status';
      name: string;
      version: string;
      status: string;
      gates?: Array<{
        name: string;
        label?: Record<string, string>;
        status: string;
        issues?: unknown[];
      }>;
    }
  | {
      phase: 'scan-result';
      name: string;
      version: string;
      status: string;
      gates?: Array<{
        name: string;
        label?: Record<string, string>;
        status: string;
        issues?: unknown[];
      }>;
    }
  | { phase: 'failed'; name?: string; errorCode: SkillhubPublishErrorCode; message: string };

interface Window {
  electronAPI: ElectronAPI;
}
