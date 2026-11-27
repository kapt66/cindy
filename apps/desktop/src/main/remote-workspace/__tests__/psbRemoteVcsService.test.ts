/**
 * CINDY-RW-10 main 服务层单测：advisory / 旧版 409 兼容 / 处置动作执行。
 *
 * 测试价值
 * - 生产入口与可观察结果：`createPsbRemoteService` 的 `occupyWorkspace` /
 *   `releaseWorkspace` / `readWorkspaceVcsNotice` / `runWorkspaceVcsAction` 是渲染层唯一能
 *   观察到的服务面。用户可观察结果：占用成功后是否出现「检出脏」提示（advisory 广播）、
 *   旧版 409 是否仍被当作错误处理、点「一键清理」是否真的按服务端给的 method/path/body
 *   发出请求并返回 202 operationId。
 * - Bug／规则依据：2026-11-26 20:4x 再更正（PSB 0.1.180）：占用/释放恒成功 + advisory；
 *   旧 409 是兼容路径不能删；`clean-workspace` 202 异步、不猜轮询端点。
 * - 现有覆盖缺口：此前的服务单测只覆盖占用闸门与串流，没有任何运行期断言证明
 *   `data.vcs` 真被解析、广播、缓存，也没有断言渲染层只传 kind 时 main 用的是服务端 path。
 * - 最小失败输入：占用 200 带 advisory（应广播）；释放 200 无 vcs（应清掉）；占用 409 带
 *   `details.vcs`（应广播错误形态）；`runWorkspaceVcsAction(clean-workspace)` 缺 confirm
 *   （应 INVALID_PARAMS 且不发请求）。
 * - tier：unit（进程内假 fetch / 假 token / 假 emitter，无网络与 Electron）。
 */

import { describe, expect, it, vi } from 'vitest';

import type { AuthState } from '../../authManager';
import { createPsbRemoteService } from '../index';
import { PsbClientError } from '../psbClient';

const AUTH_STATE = {
  isAuthenticated: true,
  user: { id: 'membership-1', membershipKind: 'org', orgSlug: 'xd' },
} as unknown as AuthState;

function workspaceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ws-1',
    title: 'saga2_project',
    clientId: 'client-pack',
    clientName: '打包机',
    clientOnline: true,
    clientPlatform: 'win32',
    state: 'ready',
    templateKey: 'saga2',
    templateTitle: 'Saga2',
    directoryName: 'saga2_project-2',
    clientPath: 'D:/psb/saga2_project-2',
    occupancy: { occupied: true, byMe: true, personId: '7', personName: '我', occupiedAt: 1 },
    usable: true,
    unusableReason: null,
    sessionCount: 0,
    webUrl: null,
    sessionsWebUrl: null,
    ...overrides,
  };
}

const ADVISORY_VCS = {
  code: 'WORKSPACE_VCS_DIRTY',
  advisory: true,
  messageZh: '检测到未提交修改（2 个检出）',
  dirty: true,
  projects: [{ projectId: 1, pathInWorkspace: '.', kind: 'p4', changes: 3 }],
  actions: [
    {
      kind: 'inspect-vcs',
      method: 'GET',
      path: '/api/cindy/remote/workspaces/ws-1/vcs',
      descriptionZh: '查看未提交修改详情',
    },
    {
      kind: 'clean-workspace',
      method: 'POST',
      path: '/api/cindy/remote/workspaces/ws-1/vcs/revert',
      body: { projectIds: [1], confirm: 'revert' },
      descriptionZh: '一键清理',
    },
    { kind: 'continue', descriptionZh: '忽略提示，继续使用工作区' },
  ],
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface Harness {
  readonly service: ReturnType<typeof createPsbRemoteService>;
  readonly calls: { url: string; method: string; body: string | null }[];
  readonly emitted: unknown[];
  readonly cleared: unknown[];
}

function createHarness(
  responses: Array<(input: { url: string; method: string }) => Response>,
): Harness {
  const calls: Harness['calls'] = [];
  const emitted: unknown[] = [];
  const cleared: unknown[] = [];
  let index = 0;
  const service = createPsbRemoteService({
    getAuthState: () => AUTH_STATE,
    getConnectionTokenProvider: () => ({
      getToken: async () => 'token-1',
      invalidate: () => undefined,
    }),
    fetch: async (url, init) => {
      const method = init.method ?? 'GET';
      calls.push({
        url,
        method,
        body: typeof init.body === 'string' ? init.body : null,
      });
      const next = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return next({ url, method });
    },
    createHttpAgent: async () => undefined,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    emitWorkspaceChanged: vi.fn(),
    emitWorkspaceVcsNotice: (event) => {
      if (event.notice) emitted.push(event);
      else cleared.push(event);
    },
  });
  return { service, calls, emitted, cleared };
}

describe('占用 / 释放的 advisory（0.1.180 主路径）', () => {
  it('占用成功响应里的 data.vcs 被解析、缓存并广播为 advisory（非错误）', async () => {
    const harness = createHarness([
      () => jsonResponse(200, { data: { workspace: workspaceRow(), vcs: ADVISORY_VCS } }),
    ]);

    const workspace = await harness.service.occupyWorkspace('ws-1');

    expect(workspace.id).toBe('ws-1');
    expect(harness.calls[0]).toMatchObject({
      url: expect.stringContaining('/api/cindy/remote/workspaces/ws-1/occupy'),
      method: 'POST',
    });
    expect(harness.emitted).toHaveLength(1);
    expect(harness.emitted[0]).toMatchObject({
      workspaceId: 'ws-1',
      operation: 'occupy',
      notice: { code: 'WORKSPACE_VCS_DIRTY', advisory: true, dirty: true },
    });
    expect(harness.service.readWorkspaceVcsNotice('ws-1')).toMatchObject({
      advisory: true,
      dirty: true,
    });
  });

  it('释放成功且没有 advisory → 广播 notice:null（提示条撤掉）', async () => {
    const harness = createHarness([
      () => jsonResponse(200, { data: { workspace: workspaceRow(), vcs: ADVISORY_VCS } }),
      () => jsonResponse(200, { data: { workspace: workspaceRow() } }),
    ]);

    await harness.service.occupyWorkspace('ws-1');
    await harness.service.releaseWorkspace('ws-1');

    expect(harness.calls[1]).toMatchObject({ method: 'DELETE' });
    expect(harness.cleared).toEqual([
      { workspaceId: 'ws-1', operation: 'occupy', notice: null },
    ]);
    expect(harness.service.readWorkspaceVcsNotice('ws-1')).toBeNull();
  });

  it('显式允许的占用（ensureWorkspaceLocked + allowAutoOccupy）同样把 advisory 广播出去（operation=ensure）', async () => {
    const harness = createHarness([
      // ensure 先读工作区列表：空闲 → 用户已确认的那条路径才自动占用并返回 advisory。
      () => jsonResponse(200, { data: { workspaces: [workspaceRow({ occupancy: { occupied: false, byMe: false, personId: null, personName: '', occupiedAt: null } })] } }),
      () => jsonResponse(200, { data: { workspace: workspaceRow(), vcs: ADVISORY_VCS } }),
    ]);

    await harness.service.ensureWorkspaceLocked('ws-1', { allowAutoOccupy: true });

    expect(harness.emitted).toHaveLength(1);
    expect(harness.emitted[0]).toMatchObject({ operation: 'ensure', notice: { advisory: true } });
  });

  it('隐式写路径（缺省 ensureWorkspaceLocked）在空闲工作区上不占用：0 次 occupy 请求 + OCCUPY_REQUIRED', async () => {
    const harness = createHarness([
      () => jsonResponse(200, { data: { workspaces: [workspaceRow({ occupancy: { occupied: false, byMe: false, personId: null, personName: '', occupiedAt: null } })] } }),
    ]);

    const error = await harness.service.ensureWorkspaceLocked('ws-1').catch((cause: unknown) => cause);

    expect((error as PsbClientError).failure).toMatchObject({
      code: 'WORKSPACE_NOT_OCCUPIED',
      messageKey: 'remoteWorkspace.error.occupyRequired',
    });
    // 用户没确认 = 不得发 `POST …/occupy`；只有那一次列表读取。
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });
});

describe('旧版 409（兼容路径）', () => {
  it('占用被 409 WORKSPACE_VCS_DIRTY 拒绝时仍缓存并广播错误形态，且照常抛错', async () => {
    const harness = createHarness([
      () =>
        jsonResponse(409, {
          error: {
            code: 'WORKSPACE_VCS_DIRTY',
            message: '',
            details: { vcs: { ...ADVISORY_VCS, advisory: false } },
          },
        }),
    ]);

    const error = await harness.service.occupyWorkspace('ws-1').catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(PsbClientError);
    expect((error as PsbClientError).failure).toMatchObject({
      code: 'WORKSPACE_VCS_DIRTY',
      messageKey: 'remoteWorkspace.vcs.dirty',
      // PSB 的 error.message 为空 → 用 details.vcs.messageZh 兜底（十字段可读）。
      message: '检测到未提交修改（2 个检出）',
    });
    expect(harness.emitted[0]).toMatchObject({
      workspaceId: 'ws-1',
      operation: 'occupy',
      notice: { advisory: false, dirty: true },
    });
  });

  it('旧版 actions（revert-then-release / retry）仍能通过 runWorkspaceVcsAction 执行', async () => {
    const harness = createHarness([
      () =>
        jsonResponse(409, {
          error: {
            code: 'WORKSPACE_VCS_DIRTY',
            message: '',
            details: {
              vcs: {
                ...ADVISORY_VCS,
                advisory: false,
                actions: [
                  {
                    kind: 'revert-then-release',
                    method: 'DELETE',
                    path: '/api/cindy/remote/workspaces/ws-1/occupy',
                    body: { revert: true },
                  },
                  {
                    kind: 'retry',
                    method: 'POST',
                    path: '/api/cindy/remote/workspaces/ws-1/vcs/check',
                  },
                ],
              },
            },
          },
        }),
      () => jsonResponse(200, { data: { workspace: workspaceRow() } }),
    ]);

    await harness.service.occupyWorkspace('ws-1').catch(() => undefined);
    const result = await harness.service.runWorkspaceVcsAction({
      workspaceId: 'ws-1',
      kind: 'revert-then-release',
      confirm: true,
    });

    expect(harness.calls[1]).toMatchObject({
      method: 'DELETE',
      url: expect.stringContaining('/api/cindy/remote/workspaces/ws-1/occupy'),
      body: JSON.stringify({ revert: true }),
    });
    expect(result).toMatchObject({ kind: 'revert-then-release', accepted: false, operationId: null });
  });
});

describe('runWorkspaceVcsAction：只传 kind，路径由服务端 notice 决定', () => {
  it('clean-workspace 必须 confirm:true；缺确认直接拒绝且不发请求', async () => {
    const harness = createHarness([
      () => jsonResponse(200, { data: { workspace: workspaceRow(), vcs: ADVISORY_VCS } }),
    ]);
    await harness.service.occupyWorkspace('ws-1');
    const callsBefore = harness.calls.length;

    const error = await harness.service
      .runWorkspaceVcsAction({ workspaceId: 'ws-1', kind: 'clean-workspace' })
      .catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: 'INVALID_PARAMS' });
    expect(harness.calls).toHaveLength(callsBefore);
    // 未确认不应清掉提示：用户可能点错了，按钮还要在。
    expect(harness.service.readWorkspaceVcsNotice('ws-1')).not.toBeNull();
  });

  it('clean-workspace 确认后按服务端 method/path/body 执行；202 operationId → accepted 并清提示', async () => {
    const harness = createHarness([
      () => jsonResponse(200, { data: { workspace: workspaceRow(), vcs: ADVISORY_VCS } }),
      () => jsonResponse(202, { data: { operationId: 'op-42' } }),
      () => jsonResponse(200, { data: { workspaces: [workspaceRow()] } }),
    ]);
    await harness.service.occupyWorkspace('ws-1');

    const result = await harness.service.runWorkspaceVcsAction({
      workspaceId: 'ws-1',
      kind: 'clean-workspace',
      confirm: true,
    });

    expect(harness.calls[1]).toMatchObject({
      method: 'POST',
      url: expect.stringContaining('/api/cindy/remote/workspaces/ws-1/vcs/revert'),
      body: JSON.stringify({ projectIds: [1], confirm: 'revert' }),
    });
    expect(result).toMatchObject({
      workspaceId: 'ws-1',
      kind: 'clean-workspace',
      accepted: true,
      operationId: 'op-42',
    });
    expect(harness.service.readWorkspaceVcsNotice('ws-1')).toBeNull();
    expect(harness.cleared).toHaveLength(1);
    // 成功后补一次工作区快照（各窗口的占用/会话数不用等自己轮询）。
    expect(harness.calls[2].url).toContain('/api/cindy/remote/workspaces');
  });

  it('continue 不发请求，只清 main 缓存并广播 notice:null（幂等）', async () => {
    const harness = createHarness([
      () => jsonResponse(200, { data: { workspace: workspaceRow(), vcs: ADVISORY_VCS } }),
    ]);
    await harness.service.occupyWorkspace('ws-1');
    const callsBefore = harness.calls.length;

    const result = await harness.service.runWorkspaceVcsAction({
      workspaceId: 'ws-1',
      kind: 'continue',
    });

    expect(result).toMatchObject({ kind: 'continue', accepted: false, operationId: null });
    expect(harness.calls).toHaveLength(callsBefore);
    expect(harness.service.readWorkspaceVcsNotice('ws-1')).toBeNull();
    // 广播 notice:null：别的窗口 / 兜底 hydrate 不会把已忽略的提示复现。
    expect(harness.cleared).toHaveLength(1);

    // 幂等：再点一次没有缓存时也不抛、不发请求、不重复广播。
    await expect(
      harness.service.runWorkspaceVcsAction({ workspaceId: 'ws-1', kind: 'continue' }),
    ).resolves.toMatchObject({ kind: 'continue' });
    expect(harness.calls).toHaveLength(callsBefore);
    expect(harness.cleared).toHaveLength(1);
  });

  it('inspect-vcs 返回详情并保留提示（用户看完还可能清理）', async () => {
    const harness = createHarness([
      () => jsonResponse(200, { data: { workspace: workspaceRow(), vcs: ADVISORY_VCS } }),
      () => jsonResponse(200, { data: { changes: 3, branch: 'main' } }),
    ]);
    await harness.service.occupyWorkspace('ws-1');

    const result = await harness.service.runWorkspaceVcsAction({
      workspaceId: 'ws-1',
      kind: 'inspect-vcs',
    });

    expect(harness.calls[1]).toMatchObject({
      method: 'GET',
      url: expect.stringContaining('/api/cindy/remote/workspaces/ws-1/vcs'),
    });
    expect(result.data).toEqual({ changes: 3, branch: 'main' });
    expect(harness.service.readWorkspaceVcsNotice('ws-1')).not.toBeNull();
  });
});
