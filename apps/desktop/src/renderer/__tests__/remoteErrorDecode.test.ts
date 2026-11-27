import { describe, expect, it, vi } from 'vitest';

import { decodeRemoteErrorMessage, remoteErrorMessageForBanner, makerChatStore } from '@/lib/makerChatStore';
import { sharedTaskRecoveryError, sharedTaskRecoveryFor } from '../../shared/sharedTaskRecovery';
import { i18n } from '@/i18n';

describe('decodeRemoteErrorMessage', () => {
  // #10796, unit: the enqueue boundary must keep the transport cause for live
  // localization and diagnostics; reporting failure must not resend the input.
  it.each(['TIMEOUT', 'LINK_BUSY', 'UNRESPONSIVE'])('retains remote %s through an enqueue rejection without replay', async cause => {
    const code = `REMOTE_AGENT_${cause}`;
    const raw = `LAZY_CREATE_FAILED: [${code}] transport diagnostic`;
    const enqueue = vi.fn().mockRejectedValue(new Error(raw));
    vi.stubGlobal('window', { dispatchEvent: vi.fn(), electronAPI: { maker: { input: { enqueue },
      autoTitle: vi.fn().mockResolvedValue({ applied: true, done: true }) } } });
    try {
      const id = `remote-transport-${cause}`;
      expect(await makerChatStore.sendMessage(id, 'continue', 'test-model', 'medium', 'auto', '/test')).toBe(false);
      expect(makerChatStore.getSnapshot(id).error).toBe(raw);
      expect(decodeRemoteErrorMessage(raw)).toBe(i18n.t(`chat.remoteError.${code}`));
      expect(sharedTaskRecoveryFor(raw, 'share:provider')).toBe(cause === 'LINK_BUSY' ? 'rate' : 'timeout');
      expect(enqueue).toHaveBeenCalledOnce();
    } finally { vi.unstubAllGlobals(); }
  });
  // Unit: a real lazy-create rejection must retain the account code and reset
  // metadata until the banner translates them in its active locale.
  it('preserves subscription guidance through the actual enqueue rejection', async () => {
    const raw = 'LAZY_CREATE_FAILED: [SUBSCRIPTION_ACCOUNT_LIMITED] waiting for reset\nresetAtMs=1900000000000';
    const enqueue = vi.fn().mockRejectedValue(new Error(raw));
    vi.stubGlobal('window', { dispatchEvent: vi.fn(), electronAPI: { maker: { input: { enqueue },
      autoTitle: vi.fn().mockResolvedValue({ applied: true, done: true }) } } });
    try {
      const id = 'local-task-subscription-reject';
      expect(await makerChatStore.sendMessage(id, 'continue', 'test-model', 'medium', 'auto', '/test')).toBe(false);
      expect(makerChatStore.getSnapshot(id).error).toBe(raw);
      expect(decodeRemoteErrorMessage(raw)).toBe(i18n.t('chat.subscriptionAccountError.limitedUntil', {
        resetAt: new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(1900000000000),
      }));
    } finally { vi.unstubAllGlobals(); }
  });

  // Unit: local task storage can run a shared provider through main. Its
  // lazy-create rejection does not use the device-link optimistic outbox.
  it('preserves recovery reason and stage through the actual enqueue rejection', async () => {
    const error = sharedTaskRecoveryError('capability', 'unsupported');
    const enqueue = vi.fn().mockRejectedValue(error);
    vi.stubGlobal('window', { dispatchEvent: vi.fn(), electronAPI: { maker: { input: { enqueue },
      autoTitle: vi.fn().mockResolvedValue({ applied: true, done: true }) } } });
    try {
      const id = 'local-task-shared-provider-reject';
      expect(await makerChatStore.sendMessage(id, 'continue', 'test-model', 'medium', 'auto', '/test')).toBe(false);
      expect(enqueue).toHaveBeenCalledTimes(1);
      const message = makerChatStore.getSnapshot(id).error!;
      expect(message).toBe(error.message);
      expect(sharedTaskRecoveryFor(message, 'share:provider')).toBe('unsupported');
    } finally { vi.unstubAllGlobals(); }
  });
  it.each([
    ['MCP_APPROVAL_AUTO_BLOCKED', 'Automatic approval review blocked this tool call. No manual rejection was received.'],
    ['MCP_APPROVAL_CONFIRMATION_TIMEOUT', 'The permission request timed out without a confirmed decision. A timeout does not show whether you clicked a button.'],
    ['MCP_APPROVAL_CONFIRMATION_UNAVAILABLE', 'Permission confirmation could not be completed. No manual rejection was received.'],
  ])('explains %s without blaming the user', (code, text) => {
    expect(decodeRemoteErrorMessage(`[${code}] fallback`)).toBe(text);
  });

  it('maps user-facing device-link chat errors to i18n text', () => {
    expect(decodeRemoteErrorMessage('[DEVICE_LINK_CONTROL_DISABLED] device control is disabled locally')).toBe(
      'Control for this device is off; the message was not sent.',
    );
    expect(decodeRemoteErrorMessage('[DEVICE_LINK_MEDIA_TRANSFER_FAILED] upload failed')).toBe(
      'Attachment transfer failed; the message was not sent. Please try again.',
    );
  });

  it('maps Electron-wrapped device-link chat errors to i18n text', () => {
    expect(
      decodeRemoteErrorMessage(
        'Error invoking remote method device-link:invoke: Error: [DEVICE_LINK_CONTROL_DISABLED] device control is disabled locally',
      ),
    ).toBe('Control for this device is off; the message was not sent.');
  });

  it('keeps non-chat device-link IPC codes unchanged', () => {
    expect(decodeRemoteErrorMessage('[DEVICE_LINK_ACCESS_REVOKED] access revoked')).toBe(
      '[DEVICE_LINK_ACCESS_REVOKED] access revoked',
    );
  });

  it('summarizes unknown remote codes in the interface language instead of upstream fallback text', () => {
    const summary = i18n.t('ipcError.INTERNAL');
    expect(decodeRemoteErrorMessage('[REMOTE_UNKNOWN] fallback message')).toBe(summary);
    expect(remoteErrorMessageForBanner('[REMOTE_UNKNOWN] fallback message')).toBe(summary);
    expect(summary).not.toContain('fallback message');
  });

  it('keeps an explicit fallback for missing keys that are not error copy', () => {
    expect(i18n.t('not.a.real.key', { defaultValue: 'keep me' })).toBe('keep me');
    expect(i18n.t('models.options.effortLevels.not-a-real-effort', { defaultValue: '' })).toBe('');
  });

  it('keeps known codes available to live and tail banners while other callers still get translated text', () => {
    const raw = '[REMOTE_LOCAL_ONLY_PROVIDER] use a different provider';
    expect(remoteErrorMessageForBanner(raw)).toBe(raw);
    expect(decodeRemoteErrorMessage(raw)).not.toBe(raw);
  });

  // #8963: first send may reject from the host lazy-create boundary. The
  // wrapper must retain the known provider code so the live banner can show
  // the actionable remote-host guidance instead of "reply failed".
  it('keeps actionable guidance for lazy-create remote provider failures', () => {
    const raw = 'LAZY_CREATE_FAILED: [REMOTE_COMPAT_MODE_UNSUPPORTED] local provider';
    expect(remoteErrorMessageForBanner(raw)).toBe(raw);
    expect(decodeRemoteErrorMessage(raw)).toBe(i18n.t('chat.remoteError.REMOTE_COMPAT_MODE_UNSUPPORTED'));
  });

  // #9855, unit: keep the metadata diagnostic marker through the real store's
  // decoder so ErrorBanner can show recovery before raw details are expanded.
  it('preserves the Pi cloud-file startup diagnostic through lazy-create decoding', () => {
    const raw = 'LAZY_CREATE_FAILED: [PI_STARTUP_CLOUD_CONTEXT_FILE] Download ~/Desktop/AGENTS.md in Finder.\npi rpc timeout after 30000ms: set_thinking_level';
    expect(remoteErrorMessageForBanner(raw)).toBe(raw);
  });

  it('maps a missing auto-review confirmation to i18n text, not a user rejection', () => {
    expect(
      decodeRemoteErrorMessage(
        '[AUTO_REVIEW_CONFIRM_UNDELIVERED] Automatic review was unavailable, and the confirmation request was not completed.',
      ),
    ).toBe(
      'Automatic review was unavailable, and the confirmation request was not completed. This is not a user rejection.',
    );
  });

  // 2026-11-26 用户口径：PSB 工作区写操作被占用闸门拒绝时，会话页横幅必须显示可行动文案，
  // 而不是 Electron 的 `Error invoking remote method … [PSB_…] …` 包装串或裸码。
  it('decodes PSB write-gate failures to actionable workspace copy', () => {
    expect(
      decodeRemoteErrorMessage(
        "Error invoking remote method 'maker:input:enqueue': Error: [PSB_WORKSPACE_OCCUPIED_BY_OTHER] 张三",
      ),
    ).toBe(i18n.t('remoteWorkspace.error.workspaceOccupied'));
    expect(decodeRemoteErrorMessage('[PSB_CLIENT_OFFLINE] 远端客户端当前离线。')).toBe(
      i18n.t('remoteWorkspace.error.clientOffline'),
    );
    // CINDY-RW-17：agent-tunnel Upgrade 拒绝会把外层 FORBIDDEN/CONFLICT 提升成业务码，会话页
    // 横幅必须同样解码成可行动文案（不要显示泛化的 FORBIDDEN 或原始码）。
    expect(decodeRemoteErrorMessage('[PSB_WORKSPACE_NOT_OCCUPIED] 先占用工作区再启动访问。')).toBe(
      i18n.t('remoteWorkspace.error.occupyRequired'),
    );
    expect(decodeRemoteErrorMessage('[PSB_AGENT_SESSION_ACTIVE] 会话正在输出。')).toBe(
      i18n.t('remoteWorkspace.error.agentSessionActive'),
    );
    expect(decodeRemoteErrorMessage('[PSB_TOO_MANY_TUNNELS] 隧道数量已达上限。')).toBe(
      i18n.t('remoteWorkspace.error.tooManyTunnels'),
    );
    // 未登记的 PSB 码不猜文案（保持原串，交给诊断）。
    expect(decodeRemoteErrorMessage('[PSB_SOMETHING_NEW] 未知失败')).toBe(
      '[PSB_SOMETHING_NEW] 未知失败',
    );
  });
  // 2026-11-27 用户复测：工作区空闲时 main 的占用闸门**不替用户占用**，返回
  // `PSB_WORKSPACE_NOT_OCCUPIED`（与 PSB 守卫契约同码）。渲染层必须先让用户确认、显式占用，
  // 成功后才**重试同一次发送**（同一份载荷）；取消 → 不占用、不发送、失败落到错误横幅。
  it('PSB 占用待确认：确认+占用后重试同一次发送；取消则不占用不重试', async () => {
    const occupiedRequired = () =>
      new Error(
        "Error invoking remote method 'maker:input:enqueue': Error: [PSB_WORKSPACE_NOT_OCCUPIED] 空闲",
      );
    const projection = (sessionId: string) => ({
      sessionId,
      pendingQueue: [],
      steeringQueueClientIds: [],
      queuePaused: false,
      queueExpanded: false,
      queueInteractionLocks: [],
      queueEditLocks: [],
      queueAbortPending: false,
      error: null,
      recovery: null,
      errorRetryText: null,
      credentialSwitchWait: null,
    });
    const enqueue = vi.fn();
    vi.stubGlobal('window', {
      dispatchEvent: vi.fn(),
      electronAPI: {
        maker: {
          input: { enqueue },
          autoTitle: vi.fn().mockResolvedValue({ applied: true, done: true }),
        },
      },
    });
    const { registerPsbOccupyConfirmationResolver } = await import(
      '@/features/remote-workspace/occupyRequired'
    );
    try {
      // ① 用户取消：不占用、不重发，失败照常落到错误横幅（composer 由调用方恢复草稿）。
      const unregisterDeclined = registerPsbOccupyConfirmationResolver(async () => false);
      enqueue.mockRejectedValueOnce(occupiedRequired());
      expect(
        await makerChatStore.sendMessage('psb-declined', 'continue', 'm', 'medium', 'auto', '/test'),
      ).toBe(false);
      expect(enqueue).toHaveBeenCalledOnce();
      expect(makerChatStore.getSnapshot('psb-declined').error).toBe(
        i18n.t('remoteWorkspace.error.occupyRequired'),
      );
      unregisterDeclined();

      // ② 用户确认并占用成功：用**同一份载荷**重发一次，成功后视为已受理。
      const unregisterAccepted = registerPsbOccupyConfirmationResolver(async () => true);
      enqueue.mockReset();
      enqueue.mockRejectedValueOnce(occupiedRequired()).mockResolvedValueOnce(projection('psb-occupied'));
      expect(
        await makerChatStore.sendMessage('psb-occupied', 'continue', 'm', 'medium', 'auto', '/test'),
      ).toBe(true);
      expect(enqueue).toHaveBeenCalledTimes(2);
      // 两次都是同一条消息（同 clientId）——这是「重试同一次发送」而不是新消息。
      expect(enqueue.mock.calls[1][1].clientId).toBe(enqueue.mock.calls[0][1].clientId);
      expect(makerChatStore.getSnapshot('psb-occupied').error).toBeNull();
      unregisterAccepted();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('remote session limit guidance', () => {
  it.each(['DEVICE_LIMIT', 'TOTAL_LIMIT'])('decodes %s inside lazy-create failures', reason => {
    const message = 'LAZY_CREATE_FAILED: [REMOTE_AGENT_BUSY] [' + reason + '] limit reached';
    expect(decodeRemoteErrorMessage(message)).toBe(i18n.t('chat.remoteError.REMOTE_AGENT_' + reason));
    expect(remoteErrorMessageForBanner(message)).toBe(message);
  });
});

// #10187: exercise the actual queue rejection projection. The old code kept
// reporting a communication/update error and never offered shared-task recovery.
it('preserves rejected shared history and exposes context handoff recovery', async () => {
  const raw = 'LAZY_CREATE_FAILED: [REMOTE_AGENT_INVALID] this conversation cannot be resumed on this computer';
  const enqueue = vi.fn().mockRejectedValue(new Error(raw));
  vi.stubGlobal('window', { dispatchEvent: vi.fn(), electronAPI: { maker: { input: { enqueue },
    autoTitle: vi.fn().mockResolvedValue({ applied: true, done: true }) } } });
  try {
    const id = 'shared-history-10187';
    expect(await makerChatStore.sendMessage(id, 'continue', 'test-model', 'medium', 'auto', '/test')).toBe(false);
    expect(makerChatStore.getSnapshot(id).error).toBe(raw);
    expect(sharedTaskRecoveryFor(raw, 'share:provider')).toBe('history');
    expect(sharedTaskRecoveryFor(raw, 'same-account-device')).toBeUndefined();
    expect(decodeRemoteErrorMessage(raw)).toBe(i18n.t('chat.remoteError.REMOTE_AGENT_RESUME_UNAVAILABLE'));
    expect(decodeRemoteErrorMessage(raw)).not.toBe(i18n.t('chat.remoteError.REMOTE_AGENT_INVALID'));
    expect(enqueue).toHaveBeenCalledOnce();
  } finally { vi.unstubAllGlobals(); }
});
