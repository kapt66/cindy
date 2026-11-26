import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// Windows CI 以 CRLF 检出源码;下面的锚点含换行,统一成 LF 再匹配。
const source = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'NewMakerDraftRoute.tsx'),
  'utf8',
).replace(/\r\n/g, '\n');

const handoffSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'remoteSessionHandoff.ts'),
  'utf8',
).replace(/\r\n/g, '\n');

/**
 * 远程普通首条不能再依赖 SessionView 挂载来补发:用户发送后马上切走,60s 内存 pending
 * 过期,首条丢失,被控端只剩一个空的「未命名任务」。
 */
describe('NewMakerDraftRoute remote first-message send', () => {
  const remoteFence = source.indexOf(
    '远程普通首条在草稿路由直接交给 makerChatStore 的远程发件队列',
  );
  const remoteSend = source.indexOf(
    'makerChatStore.sendMessage(\n                  remoteSessionId,',
    remoteFence,
  );
  const remotePending = source.indexOf('setPending(remoteSessionId, {', remoteFence);
  const remoteNavigate = source.indexOf('navigate(`/cc-agent/${remoteSessionId}`', remoteFence);

  it('hands ordinary remote text to the store outbox before navigating, not to SessionView', () => {
    expect(remoteFence).toBeGreaterThan(-1);
    expect(remoteSend).toBeGreaterThan(remoteFence);
    expect(remoteNavigate).toBeGreaterThan(remoteSend);
    // 视图交接只剩退路:排在直接发送之后。
    expect(remotePending).toBeGreaterThan(remoteSend);
    expect(source.slice(remoteFence, remoteSend)).toContain(
      'deliverRecoverableHandoff(remoteSessionId',
    );
  });

  it('keeps collaboration and slash-command first messages on the SessionView handoff', () => {
    const gate = source.slice(remoteFence, remoteSend);
    expect(gate).toContain('!shouldEnableCollab && !remoteSlashFirst && !!remoteSendWorkingDir');
    // 空白前缀命令不分 agent 一律交给视图:草稿路由的 Skill 别名改写读本机命令目录,远程不能用。
    expect(gate).toContain('|| !!leadingSlashInvocation(message);');
    expect(gate).not.toContain("capabilityAgentKind === 'pi' && !!leadingSlashInvocation(message)");
    expect(gate).not.toContain('await rewritePiSkillMessageForSend(');
    expect(gate).toContain('if (remoteDirectSend && remoteSendWorkingDir) {');
  });

  it('seeds the chat runtime from the submitted args before the pre-hydration send', () => {
    const seed = source.indexOf('makerChatStore.setSessionRuntime(remoteSessionId, {', remoteFence);
    expect(seed).toBeGreaterThan(remoteFence);
    expect(seed).toBeLessThan(remoteSend);
    const seedBlock = source.slice(seed, source.indexOf('});', seed));
    expect(seedBlock).toContain('agentKind: createArgs.agentKind');
    expect(seedBlock).toContain('sessionProviderId: createArgs.providerId ?? null');
  });

  it('registers the session topic subscription in the outbox preflight, not before navigate', () => {
    const preflight = source.indexOf('beforeEnqueue: async () => {', remoteSend);
    const subscribe = source.indexOf(
      'await window.electronAPI.deviceLink.subscribe(deviceId, [',
      preflight,
    );
    expect(preflight).toBeGreaterThan(remoteSend);
    expect(preflight).toBeLessThan(remoteNavigate);
    expect(subscribe).toBeGreaterThan(preflight);
    expect(source.slice(subscribe, subscribe + 160)).toContain('`session:${remoteSessionId}`');
    // 订阅不得挡在 navigate 前面以 await 的形式出现在发送调用之外。
    expect(source.slice(remoteFence, remoteSend)).not.toContain('deviceLink.subscribe(');
  });

  it('restores an undelivered first message and withdraws both sidebar overlays', () => {
    const failure = source.indexOf('onRemoteOptimisticFailure: (clientId) => {', remoteSend);
    const block = source.slice(failure, remotePending);
    expect(failure).toBeGreaterThan(remoteSend);
    expect(block).toContain('restoreRemoteOptimisticDraft(remoteSessionId, {');
    expect(block).toContain('remoteProjectsStore.clearPendingTitlePreview(remoteSessionId)');
    expect(block).toContain('remoteProjectsStore.clearPendingFirstSend(remoteSessionId)');
  });

  it('marks the first send only for the direct path, before the provisional row and refresh land', () => {
    const mark = handoffSource.indexOf(
      'if (p.markFirstSend) remoteProjectsStore.setPendingFirstSend(p.remoteSessionId, p.nowIso);',
    );
    const provisional = handoffSource.indexOf('buildProvisionalRemoteSession({', mark);
    const refresh = handoffSource.indexOf('void refreshRemoteDeviceSessions(', mark);
    expect(mark).toBeGreaterThan(-1);
    expect(provisional).toBeGreaterThan(mark);
    expect(refresh).toBeGreaterThan(mark);

    // 发送路径按直接发送判据登记;目标路径交给 SessionView,失败分支不在草稿路由手里,不登记。
    const sendCommit = source.slice(
      source.indexOf('commitRemoteSessionHandoff({', remoteFence),
      source.indexOf("logTag: 'draft send'", remoteFence) + 120,
    );
    expect(sendCommit).toContain('markFirstSend: remoteDirectSend');
    const goalCommit = source.slice(
      source.indexOf("logTag: 'draft goal'") - 400,
      source.indexOf("logTag: 'draft goal'") + 40,
    );
    expect(goalCommit).not.toContain('markFirstSend');
  });

  it('withdraws the first-send mark before falling back to the SessionView handoff', () => {
    const fallback = source.indexOf(
      'remoteProjectsStore.clearPendingFirstSend(remoteSessionId);\n            }',
      remoteSend,
    );
    expect(fallback).toBeGreaterThan(remoteNavigate);
    expect(fallback).toBeLessThan(remotePending);
  });

  /**
   * PSB 远程工作区（2026-11-25 产品口径）：弹窗只占用工作区，PSB 会话在首条消息发送时
   * 按草稿当时的 harness 懒建。此处钉住路由侧的两条不变量：
   *   ① 懒建失败**绝不**落到本地 `createSession`（否则会建出一个没有远端身份的会话行）；
   *   ② 懒建成功必须回写 `psbTarget.sessionId`（重试/重发复用同一条，不建第二条）。
   */
  it('creates the PSB session lazily on the first message, and aborts before any local session on failure', () => {
    const lazy = source.indexOf('const psbLazySession: PsbDraftSession | null = isPsbDraft');
    const failFence = source.indexOf('if (isPsbDraft && !psbLazySession) return;', lazy);
    const ensureDecl = source.indexOf('const ensurePsbSessionForSend = useCallback(');
    const writeBack = source.indexOf(
      'patchDraft({ psbTarget: { ...current, sessionId } })',
      ensureDecl,
    );
    const localCreate = source.indexOf('const newSession = await createSession', failFence);
    expect(lazy).toBeGreaterThan(-1);
    expect(failFence).toBeGreaterThan(lazy);
    expect(ensureDecl).toBeGreaterThan(-1);
    // 懒建成功才回写 sessionId（onSessionCreated），重试/重发复用同一条 PSB 会话。
    expect(writeBack).toBeGreaterThan(ensureDecl);
    expect(localCreate).toBeGreaterThan(failFence);
    // 懒建失败到本地建会话之间不得再有 createSession 调用（唯一的入口在 failFence 之后）。
    expect(source.slice(failFence, localCreate)).not.toContain('createSession({');
    expect(source.slice(lazy, failFence)).toContain('ensurePsbSessionForSend(');
  });
});
