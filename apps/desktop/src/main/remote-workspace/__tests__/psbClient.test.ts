/**
 * psbClient 单测 —— PSB HTTP 客户端的失败映射与外壳解析。
 *
 * 测试价值
 * - 生产入口与可观察结果：`createPsbApi(deps)` 是 main 进程访问 PSB 的唯一出口（`psbClient.ts`）。
 *   经它发出请求后，渲染层能观察到的结果是「成功 DTO」或 `PsbClientError.failure`
 *   （`code` / `messageKey` / 占用人名 message）——决定界面显示哪句可行动文案。
 * - Bug／规则依据：`docs/dev-rules/psb-remote-session-transport.md` §3
 *   （外壳 `{data}` / 401 只重签一次 / `403 IDENTITY_NOT_LINKED` 不重签 / 网络失败记
 *   `PSB_UNREACHABLE` / 409 占用人名可插值）。
 * - 现有覆盖缺口：`main/remote-workspace/` 是本轮新增的两个文件的直接单测（此前无覆盖）；
 *   2026-11-26 PSB 给 `stream/status` 加了 `desktopSession` / `reasonCode` 两个加性字段，
 *   旧用例只钉了 `capability` 外壳，没有证明这两个字段真的穿过 HTTP 解析层、也没证明旧服务端
 *   （缺字段）仍可用。
 * - 最小失败输入：假 fetch 依次返回 401 `AUTH_INVALID`、409
 *   `WORKSPACE_OCCUPIED_BY_OTHER(details.name)`、或直接 reject（对应三条失败分支）；
 *   `stream/status` 分别带/不带 `desktopSession` / `reasonCode`（加性字段透传与缺省回退）。
 * - tier：unit（进程内假 fetch / 假 token，无真实网络与 Electron）。
 * - 实测耗时：单独运行 1.95s（其中用例 11ms；其余为 vitest 启动与模块加载）。
 */

import { describe, expect, it, vi } from 'vitest';

import type { AuthState } from '../../authManager';
import { createIpcError } from '../../../shared/ipc-errors';
import {
  PSB_FAILURE_DESCRIPTORS,
  psbBannerMessageKeyForIpcCode,
  psbFailureMessageKeyForIpcCode,
  psbIpcCodeForFailure,
  psbRemoteFailureFromIpcError,
  type PsbFailureDescriptor,
} from '../../../shared/psb-remote-workspace';
import {
  createPsbApi,
  PsbClientError,
  PSB_HTTP_MAX_RESPONSE_BYTES,
  psbMessageKeyForErrorCode,
  readWorkspaceWebUrl,
} from '../psbClient';
import type { PsbConnectionTokenPort } from '../psbAuth';

const AUTH_STATE = {
  isAuthenticated: true,
  user: { id: 'membership-1', membershipKind: 'org', orgSlug: 'xd' },
} as unknown as AuthState;

const LOGGER = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };

interface TokenHarness {
  readonly port: PsbConnectionTokenPort;
  readonly tokenCalls: number[];
  readonly invalidated: number[];
}

function makeTokens(): TokenHarness {
  const tokenCalls: number[] = [];
  const invalidated: number[] = [];
  return {
    port: {
      getToken: async () => {
        tokenCalls.push(tokenCalls.length + 1);
        return `token-${tokenCalls.length}`;
      },
      invalidate: () => {
        invalidated.push(invalidated.length + 1);
      },
    },
    tokenCalls,
    invalidated,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeApi(
  fetchImpl: (input: string, init: RequestInit) => Promise<Response>,
  tokens: PsbConnectionTokenPort,
  overrides: Partial<Parameters<typeof createPsbApi>[0]> = {},
) {
  return createPsbApi({
    fetch: fetchImpl,
    getAuthState: () => AUTH_STATE,
    tokens,
    logger: LOGGER,
    ...overrides,
  });
}

describe('psbClient 请求外壳与错误映射', () => {
  it('解析 { data } 外壳里的工作区行，并丢弃没有 id 的行', async () => {
    const tokens = makeTokens();
    const api = makeApi(
      async () =>
        jsonResponse(200, {
          data: {
            workspaces: [
              { id: 'ws-1', title: 'SAGA2 设计', clientName: '设计机-01', state: 'ready' },
              { title: '缺 id 的行' },
            ],
          },
        }),
      tokens.port,
    );

    const workspaces = await api.listWorkspaces();

    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]).toMatchObject({ id: 'ws-1', title: 'SAGA2 设计', clientName: '设计机-01' });
  });

  it('响应缺少 { data } 外壳时判协议错，不静默回落默认值（2026-11-26 联调事故）', async () => {
    // 真实事故：PSB 的 `stream/status` 曾返回**裸状态对象**（少了 `{data: …}` 一层），
    // 宽松解析器把 `undefined` 静默回落成 `{capability:false, lastErrorZh:null}`，HTTP 200 看不出
    // 任何异常——最终表现为「客户端明明声明支持串流，Cindy 却显示不支持」，只能人肉比对 /clients
    // 才能发现。外壳缺失是契约违约，必须响亮失败（PSB_PROTOCOL），而不是猜默认值。
    const tokens = makeTokens();
    const api = makeApi(
      async () => jsonResponse(200, { capability: true, active: false, encoder: 'h264' }),
      tokens.port,
    );

    const error = await api.getStreamStatus('session-1').catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(PsbClientError);
    expect((error as PsbClientError).failure.code).toBe('PSB_PROTOCOL');
    expect(LOGGER.warn).toHaveBeenCalledWith(
      'psb response is missing the data envelope',
      expect.objectContaining({ label: 'stream-status' }),
    );
  });

  it('响应体超过上限时按协议错拒绝（不是网络失败，也不重试）', async () => {
    const tokens = makeTokens();
    let calls = 0;
    const api = makeApi(async () => {
      calls += 1;
      return jsonResponse(200, {
        data: { workspaces: [] },
        padding: 'x'.repeat(PSB_HTTP_MAX_RESPONSE_BYTES + 16),
      });
    }, tokens.port);

    const error = await api.listWorkspaces().catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(PsbClientError);
    // 超限是契约违约（用户查网络没有意义），且不得按网络失败重签/重试。
    expect((error as PsbClientError).failure.code).toBe('PSB_PROTOCOL');
    expect(calls).toBe(1);
    expect(tokens.invalidated).toHaveLength(0);
    expect(LOGGER.warn).toHaveBeenCalledWith(
      'psb response exceeded the size limit',
      expect.objectContaining({ label: 'list-workspaces', limit: PSB_HTTP_MAX_RESPONSE_BYTES }),
    );
  });

  it('透传 stream/status 的 reasonCode / desktopSession；缺字段回退 null（旧服务端兼容）', async () => {
    const tokens = makeTokens();
    let body: unknown = {
      data: {
        capability: true,
        active: false,
        width: 2560,
        height: 1440,
        fps: 60,
        encoder: null,
        lastErrorZh: '该工作区没有正在运行的桌面会话，请先到 PSB 网页「远程控制」页签启动。',
        desktopSession: 'none',
        reasonCode: 'NO_DESKTOP_SESSION',
      },
    };
    const api = makeApi(async () => jsonResponse(200, body), tokens.port);

    // 2026-11-26 加性字段：渲染层靠它们区分「去启动桌面会话」与「等首帧」，不能被解析层吞掉。
    expect(await api.getStreamStatus('session-1')).toMatchObject({
      capability: true,
      active: false,
      desktopSession: 'none',
      reasonCode: 'NO_DESKTOP_SESSION',
    });

    // 0.1.158 之前的 PSB 不带这两个字段：解析成 null（未知），不猜 'none'、不报协议错。
    body = { data: { capability: true, active: true, encoder: 'h264', lastErrorZh: null } };
    expect(await api.getStreamStatus('session-2')).toMatchObject({
      capability: true,
      active: true,
      desktopSession: null,
      reasonCode: null,
    });
  });

  it('401 AUTH_INVALID 只重签一次，第二次请求改用新 token', async () => {
    const tokens = makeTokens();
    const authorizationHeaders: string[] = [];
    const api = makeApi(async (_input, init) => {
      authorizationHeaders.push(String((init.headers as Record<string, string>)['authorization']));
      if (authorizationHeaders.length === 1) {
        return jsonResponse(401, { error: { code: 'AUTH_INVALID', message: 'expired' } });
      }
      return jsonResponse(200, { data: { workspaces: [] } });
    }, tokens.port);

    await api.listWorkspaces();

    expect(authorizationHeaders).toEqual(['Bearer token-1', 'Bearer token-2']);
    expect(tokens.invalidated).toHaveLength(1);
  });

  it('401 在重签后仍失败就停：不再循环签发', async () => {
    const tokens = makeTokens();
    const api = makeApi(
      async () => jsonResponse(401, { error: { code: 'AUTH_INVALID', message: 'nope' } }),
      tokens.port,
    );

    const error = await api.listWorkspaces().catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(PsbClientError);
    expect((error as PsbClientError).status).toBe(401);
    // AUTH_INVALID 与 AUTH_EXPIRED 在单表里同一个 IPC 码 / 文案键（凭证失效 → 重新登录），
    // main 的 messageKey 必须与渲染层按 IPC 码查到的键一致，否则同一条失败会出现两套文案。
    expect((error as PsbClientError).failure).toEqual({
      code: 'AUTH_INVALID',
      messageKey: 'remoteWorkspace.error.authExpired',
      message: 'nope',
    });
    expect(tokens.tokenCalls).toHaveLength(2);
  });

  it('403 IDENTITY_NOT_LINKED 不是「token 坏了」，不重签', async () => {
    const tokens = makeTokens();
    const api = makeApi(
      async () =>
        jsonResponse(403, { error: { code: 'IDENTITY_NOT_LINKED', message: '通讯录无人' } }),
      tokens.port,
    );

    const error = (await api.listWorkspaces().catch((cause: unknown) => cause)) as PsbClientError;

    expect(tokens.tokenCalls).toHaveLength(1);
    expect(tokens.invalidated).toHaveLength(0);
    expect(error.failure).toMatchObject({
      code: 'IDENTITY_NOT_LINKED',
      messageKey: 'remoteWorkspace.error.identityNotLinked',
    });
  });

  it('409 占用冲突保留占用人名，供文案插值', async () => {
    const tokens = makeTokens();
    const api = makeApi(
      async () =>
        jsonResponse(409, {
          error: {
            code: 'WORKSPACE_OCCUPIED_BY_OTHER',
            message: '这个工作区正被「张三」占用。',
            details: { workspaceId: 'ws-1', name: '张三', occupiedAt: 1 },
          },
        }),
      tokens.port,
    );

    const error = (await api.occupyWorkspace('ws-1').catch((cause: unknown) => cause)) as PsbClientError;

    expect(error.status).toBe(409);
    expect(error.failure).toEqual({
      code: 'WORKSPACE_OCCUPIED_BY_OTHER',
      messageKey: 'remoteWorkspace.error.occupiedByOther',
      message: '张三',
    });
  });

  it('网络层失败收敛成 PSB_UNREACHABLE（与业务失败分开）', async () => {
    const tokens = makeTokens();
    const api = makeApi(async () => {
      throw new TypeError('fetch failed');
    }, tokens.port);

    const error = (await api.listClients().catch((cause: unknown) => cause)) as PsbClientError;

    expect(error).toBeInstanceOf(PsbClientError);
    expect(error.status).toBeNull();
    expect(error.failure).toEqual({
      code: 'PSB_UNREACHABLE',
      messageKey: 'remoteWorkspace.error.unreachable',
      message: 'fetch failed',
    });
  });
});

describe('PSB 失败形状 ↔ IPC 失败码', () => {
  it('失败形状映射成 PSB_ 命名空间码，渲染层能反查回文案键（占用/离线/鉴权各归各）', () => {
    const cases = [
      [
        { code: 'WORKSPACE_OCCUPIED_BY_OTHER', messageKey: 'remoteWorkspace.error.occupiedByOther', message: '张三' },
        'PSB_WORKSPACE_OCCUPIED_BY_OTHER',
        'remoteWorkspace.error.occupiedByOther',
      ],
      [
        { code: 'CLIENT_OFFLINE', messageKey: 'remoteWorkspace.error.clientOffline', message: null },
        'PSB_CLIENT_OFFLINE',
        'remoteWorkspace.error.clientOffline',
      ],
      [
        { code: 'AUTH_REQUIRED', messageKey: 'remoteWorkspace.status.needOrg', message: null },
        'PSB_ORG_REQUIRED',
        'remoteWorkspace.error.orgRequired',
      ],
      [
        { code: 'AUTH_REQUIRED', messageKey: 'remoteWorkspace.status.needLogin', message: null },
        'PSB_AUTH_REQUIRED',
        'remoteWorkspace.error.auth',
      ],
      [
        { code: 'PSB_UNREACHABLE', messageKey: 'remoteWorkspace.error.unreachable', message: 'fetch failed' },
        'PSB_UNREACHABLE',
        'remoteWorkspace.error.unreachable',
      ],
    ] as const;

    for (const [failure, expectedCode, expectedKey] of cases) {
      expect(psbIpcCodeForFailure(failure)).toBe(expectedCode);
      expect(psbFailureMessageKeyForIpcCode(expectedCode)).toBe(expectedKey);
    }
  });

  it('错误横幅文案键走共享表：被他人占用用无名字兜底键，其它码与操作失败表一致', () => {
    // 同一个事实的两个消费面：操作 / 按钮失败可插值占用人名；错误横幅只有 code+可能为空的名字。
    // 映射必须都来自共享契约（渲染层不手写 if），否则同一条失败会出现两套文案。
    expect(psbBannerMessageKeyForIpcCode('PSB_WORKSPACE_OCCUPIED_BY_OTHER')).toBe(
      'remoteWorkspace.error.workspaceOccupied',
    );
    for (const code of [
      'PSB_AUTH_REQUIRED',
      'PSB_CLIENT_OFFLINE',
      'PSB_WORKSPACE_NOT_READY',
      'PSB_NOT_FOUND',
      'PSB_UNREACHABLE',
      'PSB_STREAM_NOT_ACTIVE',
    ]) {
      expect(psbBannerMessageKeyForIpcCode(code)).toBe(psbFailureMessageKeyForIpcCode(code));
    }
    expect(psbBannerMessageKeyForIpcCode('PSB_SOMETHING_NEW')).toBeNull();
  });

  it('PSB 原始码 → 文案键由共享单表派生（客户端不再手写 switch / 字面键）', () => {
    for (const [ipcCode, rawDescriptor] of Object.entries(PSB_FAILURE_DESCRIPTORS)) {
      const descriptor = rawDescriptor as PsbFailureDescriptor;
      // 串流访问三档与组织鉴别条目有自己的入口，跳过其原始码的默认反查。
      if (descriptor.state !== null || descriptor.whenMessageKey !== undefined) continue;
      expect(psbMessageKeyForErrorCode(descriptor.psbCode), `${ipcCode} 的 PSB 码没映射`).toBe(
        descriptor.messageKey,
      );
      for (const alias of descriptor.alsoPsbCodes ?? []) {
        expect(psbMessageKeyForErrorCode(alias), `${ipcCode} 的别名 ${alias} 没映射`).toBe(
          descriptor.messageKey,
        );
      }
    }
    // 未知码仍回落通用文案（原始码保留在 failure.code，诊断用）。
    expect(psbMessageKeyForErrorCode('NOT_A_PSB_CODE')).toBe('remoteWorkspace.error.unknown');
  });

  it('渲染层从 IPC 错误里取回失败形状；不是 PSB 码的失败返回 null', () => {    // Electron 跨进程后只保留 message：渲染层拿到的就是 `[CODE] message` 这一串。
    const fromRenderer = new Error('[PSB_WORKSPACE_OCCUPIED_BY_OTHER] 张三');
    expect(psbRemoteFailureFromIpcError(fromRenderer)).toEqual({
      code: 'PSB_WORKSPACE_OCCUPIED_BY_OTHER',
      messageKey: 'remoteWorkspace.error.occupiedByOther',
      message: '张三',
    });

    // 参数校验等本地失败不是 PSB 失败码，调用方回落通用文案。
    const local = createIpcError('INVALID_PARAMS', 'payload must be an object');
    expect(psbRemoteFailureFromIpcError(local)).toBeNull();
    expect(psbRemoteFailureFromIpcError(new Error('boom'))).toBeNull();
  });

  it('协议错 / 未知码不给 PSB 失败码（落通用 INTERNAL），避免把技术失败当用户可行动原因', () => {
    expect(
      psbIpcCodeForFailure({ code: 'PSB_PROTOCOL', messageKey: 'remoteWorkspace.error.unknown', message: null }),
    ).toBeNull();
    expect(
      psbIpcCodeForFailure({ code: 'PSB_UNKNOWN', messageKey: 'remoteWorkspace.error.unknown', message: 'x' }),
    ).toBeNull();
  });
});

describe('工作区网页地址：列表口优先、单行仅兜底（2026-11-26 真机事故）', () => {
  /**
   * 按路径分流假 fetch 并记录真的打了哪个口（`list` / `single`）。
   *
   * 事故的事实是「Cindy 身份下单行 GET 恒 403」：如果实现又退回单行，`calls` 断言会立刻红，
   * 而不是等到真机上再看到一句误导的失败。
   */
  function routingFetch(routes: { list?: () => Response; single?: () => Response }): {
    fetchImpl: (input: string, init: RequestInit) => Promise<Response>;
    calls: string[];
  } {
    const calls: string[] = [];
    const fetchImpl = async (input: string): Promise<Response> => {
      const isList = new URL(input).pathname.endsWith('/workspaces');
      calls.push(isList ? 'list' : 'single');
      const handler = isList ? routes.list : routes.single;
      if (!handler) throw new TypeError(`unexpected PSB route in test: ${input}`);
      return handler();
    };
    return { fetchImpl, calls };
  }

  const WORKSPACE_ROW = {
    id: 'ws-saga2',
    title: 'saga2_project',
    state: 'ready',
    webUrl: 'https://mekabot-test.meka.pawdy.fun/remote/workspaces/ws-saga2',
    sessionsWebUrl: 'https://mekabot-test.meka.pawdy.fun/remote/workspaces/ws-saga2/sessions',
  };

  it('列表里有该工作区 → 用列表行的 webUrl 且不请求单行口', async () => {
    const tokens = makeTokens();
    const routing = routingFetch({
      list: () => jsonResponse(200, { data: { workspaces: [WORKSPACE_ROW] } }),
      single: () =>
        jsonResponse(403, { error: { code: 'FORBIDDEN', message: '这个 Cindy 身份不能访问该接口。' } }),
    });

    const url = await readWorkspaceWebUrl(makeApi(routing.fetchImpl, tokens.port), 'ws-saga2');

    expect(url).toBe(WORKSPACE_ROW.webUrl);
    expect(routing.calls).toEqual(['list']);
  });

  it('单行口 403/404/405 都按「读口没有答案」→ null，不抛出误导文案', async () => {
    for (const status of [403, 404, 405]) {
      const tokens = makeTokens();
      const routing = routingFetch({
        list: () => jsonResponse(200, { data: { workspaces: [] } }),
        single: () =>
          jsonResponse(status, {
            error: { code: status === 403 ? 'FORBIDDEN' : 'NOT_FOUND', message: '不可用' },
          }),
      });

      const url = await readWorkspaceWebUrl(makeApi(routing.fetchImpl, tokens.port), 'ws-gone');

      expect(url, `单行 ${status} 时应返回 null`).toBeNull();
      expect(routing.calls).toEqual(['list', 'single']);
    }
  });

  it('列表里没有这条工作区、单行口仍能答（旧服务端）→ 用单行行的 webUrl', async () => {
    const tokens = makeTokens();
    const routing = routingFetch({
      list: () => jsonResponse(200, { data: { workspaces: [] } }),
      single: () => jsonResponse(200, { data: { workspace: WORKSPACE_ROW } }),
    });

    const url = await readWorkspaceWebUrl(makeApi(routing.fetchImpl, tokens.port), 'ws-saga2');

    expect(url).toBe(WORKSPACE_ROW.webUrl);
    expect(routing.calls).toEqual(['list', 'single']);
  });

  it('列表行存在但没带 webUrl → null（PSB 没给地址就是没有，不兜底单行）', async () => {
    const tokens = makeTokens();
    const routing = routingFetch({
      list: () => jsonResponse(200, { data: { workspaces: [{ ...WORKSPACE_ROW, webUrl: null }] } }),
    });

    expect(await readWorkspaceWebUrl(makeApi(routing.fetchImpl, tokens.port), 'ws-saga2')).toBeNull();
    expect(routing.calls).toEqual(['list']);
  });

  it('列表鉴权失败仍明确报错（未登录 0 次请求；通讯录未关联不发单行请求）', async () => {
    const tokens = makeTokens();
    const signedOutRouting = routingFetch({ list: () => jsonResponse(200, { data: { workspaces: [] } }) });
    const signedOutApi = createPsbApi({
      fetch: signedOutRouting.fetchImpl,
      getAuthState: () => ({ isAuthenticated: false, user: null }) as unknown as AuthState,
      tokens: tokens.port,
      logger: LOGGER,
    });
    await expect(readWorkspaceWebUrl(signedOutApi, 'ws-1')).rejects.toMatchObject({
      failure: { code: 'AUTH_REQUIRED' },
    });
    expect(signedOutRouting.calls).toEqual([]);

    const notLinkedRouting = routingFetch({
      list: () =>
        jsonResponse(403, { error: { code: 'IDENTITY_NOT_LINKED', message: '通讯录无人' } }),
    });
    await expect(
      readWorkspaceWebUrl(makeApi(notLinkedRouting.fetchImpl, tokens.port), 'ws-1'),
    ).rejects.toMatchObject({ failure: { code: 'IDENTITY_NOT_LINKED' } });
    expect(notLinkedRouting.calls).toEqual(['list']);
  });

  it('网络失败仍明确报错，不静默变成「找不到工作区」', async () => {
    const tokens = makeTokens();
    const api = makeApi(async () => {
      throw new TypeError('fetch failed');
    }, tokens.port);

    await expect(readWorkspaceWebUrl(api, 'ws-1')).rejects.toMatchObject({
      failure: { code: 'PSB_UNREACHABLE' },
    });
  });
});

/* ==================== 工作区级串流订阅与 purpose（PSB 0.1.172 新契约） ==================== */

describe('工作区级串流订阅（stream/subscribe）与 purpose', () => {
  /** 会话行（PSB 的 Cindy 入口回答单条会话行，见 `parseSessionRow`）。 */
  function sessionRowJson(): Record<string, unknown> {
    return {
      id: 'psb-session-1',
      workspaceId: 'ws-1',
      clientId: 'client-1',
      title: '用户任务',
      agentKind: 'pi',
      status: 'running',
      createdAt: '2026-11-26T00:00:00.000Z',
      updatedAt: '2026-11-26T00:00:00.000Z',
      createdBy: { personId: '7', personName: '我', source: 'cindy' },
    };
  }

  it('POST 工作区级订阅端点并解析桌面访问会话 id（不创建 Agent 会话）', async () => {
    const tokens = makeTokens();
    const requests: Array<{ url: string; method: string }> = [];
    const api = makeApi(async (input, init) => {
      requests.push({ url: input, method: String(init.method) });
      return jsonResponse(200, {
        data: {
          workspaceId: 'ws-1',
          sessionId: 'desktop-session-1',
          streamPath: '/api/cindy/remote/sessions/desktop-session-1/stream?subscriberId=u4',
          subscriberId: 'u4',
        },
      });
    }, tokens.port);

    const subscription = await api.subscribeWorkspaceStream('ws-1');

    // 端点形状是契约正本（`POST /workspaces/:id/stream/subscribe`）：拼错路径会静默 404。
    expect(requests).toEqual([
      {
        url: expect.stringMatching(/\/api\/cindy\/remote\/workspaces\/ws-1\/stream\/subscribe$/),
        method: 'POST',
      },
    ]);
    // `sessionId` 是**桌面访问会话** id；其余是可选诊断字段（缺 expiresAt 归一成 null）。
    expect(subscription).toEqual({
      sessionId: 'desktop-session-1',
      streamPath: '/api/cindy/remote/sessions/desktop-session-1/stream?subscriberId=u4',
      subscriberId: 'u4',
      expiresAt: null,
    });
  });

  it('订阅响应缺 sessionId → 协议错（不能拿空 id 去开观看端）', async () => {
    const tokens = makeTokens();
    const api = makeApi(async () => jsonResponse(200, { data: { workspaceId: 'ws-1' } }), tokens.port);

    const error = await api
      .subscribeWorkspaceStream('ws-1')
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(PsbClientError);
    expect((error as PsbClientError).failure.code).toBe('PSB_PROTOCOL');
  });

  it('409 NO_RUNNING_SESSION 保留 PSB 可读原因并带上 details.state（调用方转成可行动文案）', async () => {
    const tokens = makeTokens();
    const api = makeApi(
      async () =>
        jsonResponse(409, {
          error: {
            code: 'NO_RUNNING_SESSION',
            message: '该工作区还没有运行中的桌面访问会话，请先在 PSB 网页启动远程桌面。',
            details: { code: 'NO_RUNNING_SESSION', state: 'none' },
          },
        }),
      tokens.port,
    );

    const error = (await api
      .subscribeWorkspaceStream('ws-1')
      .catch((cause: unknown) => cause)) as PsbClientError;

    expect(error).toBeInstanceOf(PsbClientError);
    expect(error.status).toBe(409);
    // 收敛成 Cindy 的结构化失败：PSB 原始码不足以表达「按 state 决定下一步」。
    expect(error.failure.code).toBe('PSB_STREAM_NO_RUNNING_SESSION');
    expect(error.failure.streamAccessState).toBe('none');
    // 原文是用户唯一的可行动线索（「先去 PSB 网页启动」），不能在映射里丢掉。
    expect(error.failure.message).toContain('启动远程桌面');
  });

  it('createSession 省略 purpose 时不带该字段；purpose=internal 时原样带出', async () => {
    const tokens = makeTokens();
    const bodies: Array<Record<string, unknown>> = [];
    const api = makeApi(async (input, init) => {
      if (String(init.method) === 'POST') {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return jsonResponse(200, { data: sessionRowJson() });
      }
      return jsonResponse(200, { data: { workspaces: [{ id: 'ws-1' }] } });
    }, tokens.port);

    await api.createSession({
      workspaceId: 'ws-1',
      agentKind: 'pi',
      clientRequestId: 'req-user-task',
    });
    await api.createSession({
      workspaceId: 'ws-1',
      agentKind: 'pi',
      title: 'Cindy 观看端 · 内部串流订阅',
      purpose: 'internal',
      clientRequestId: 'req-internal',
    });

    // 用户任务保持与旧服务端逐字节一致的请求体（省略 = agent）。
    expect(bodies[0]).not.toHaveProperty('purpose');
    // 过渡兜底必须让 PSB 能把它排除在列表/计数之外（其它值 PSB 会 400）。
    expect(bodies[1]).toMatchObject({
      purpose: 'internal',
      title: 'Cindy 观看端 · 内部串流订阅',
    });
  });
});

/* ==================== 订阅 409：按 details.state 分档（PSB 0.1.180） ==================== */

/**
 * 真机事故（2026-11-26）：访问未运行时点「启动串流」只显示「串流失败：操作失败，请稍后重试。」。
 * 根因是 409 的 `details.code` / `details.state` 没有被解析，落到了通用错误。
 */
describe('订阅串流 409 NO_RUNNING_SESSION：state → 可行动失败码', () => {
  /** 期望的状态映射（与 `PSB_NO_RUNNING_SESSION_IPC_CODES` 同口径）。 */
  const STATE_CASES: ReadonlyArray<{
    readonly state: string | null;
    readonly ipcCode: string;
    readonly messageKey: string;
  }> = [
    {
      state: 'none',
      ipcCode: 'PSB_STREAM_NO_RUNNING_SESSION',
      messageKey: 'remoteWorkspace.admin.streamAccessNone',
    },
    {
      state: 'stopped',
      ipcCode: 'PSB_STREAM_NO_RUNNING_SESSION',
      messageKey: 'remoteWorkspace.admin.streamAccessNone',
    },
    {
      state: 'failed',
      ipcCode: 'PSB_STREAM_NO_RUNNING_SESSION',
      messageKey: 'remoteWorkspace.admin.streamAccessNone',
    },
    {
      state: 'starting',
      ipcCode: 'PSB_STREAM_ACCESS_STARTING',
      messageKey: 'remoteWorkspace.admin.streamAccessStarting',
    },
    {
      state: 'stopping',
      ipcCode: 'PSB_STREAM_ACCESS_STOPPING',
      messageKey: 'remoteWorkspace.admin.streamAccessStopping',
    },
    // PSB 给了未知 / 缺省 state：按「去网页启动访问」那一档，不猜「正在启动」。
    { state: null, ipcCode: 'PSB_STREAM_NO_RUNNING_SESSION', messageKey: 'remoteWorkspace.admin.streamAccessNone' },
    {
      state: 'weird-future-state',
      ipcCode: 'PSB_STREAM_NO_RUNNING_SESSION',
      messageKey: 'remoteWorkspace.admin.streamAccessNone',
    },
  ];

  it.each(STATE_CASES)(
    'details.state=$state → $ipcCode（main 失败形状带 state，渲染层按码选文案）',
    async ({ state, ipcCode, messageKey }) => {
      const tokens = makeTokens();
      const api = makeApi(
        async () =>
          jsonResponse(409, {
            error: {
              code: 'NO_RUNNING_SESSION',
              message: '该工作区还没有运行中的桌面访问会话，请先在 PSB 网页启动远程桌面。',
              details: { code: 'NO_RUNNING_SESSION', workspaceId: 'ws-1', state },
            },
          }),
        tokens.port,
      );

      const error = (await api
        .subscribeWorkspaceStream('ws-1')
        .catch((cause: unknown) => cause)) as PsbClientError;
      const failure = error.failure;

      expect(failure.code).toBe('PSB_STREAM_NO_RUNNING_SESSION');
      expect(failure.messageKey).toBe(messageKey);
      expect(failure.message).toContain('启动远程桌面');
      // 状态只在 main 侧保存；跨 IPC 时由 `psbIpcCodeForFailure` 翻成三条码之一。
      expect(psbIpcCodeForFailure(failure)).toBe(ipcCode);
    },
  );

  it('平铺失败外壳（{ code, message, details }）同样解析（PSB 0.1.180 的另一形态）', async () => {
    const tokens = makeTokens();
    const api = makeApi(
      async () =>
        jsonResponse(409, {
          code: 'NO_RUNNING_SESSION',
          message: '工作区访问正在启动（Unity 还没就绪），请稍等再试。',
          details: { code: 'NO_RUNNING_SESSION', state: 'starting' },
        }),
      tokens.port,
    );

    const error = (await api
      .subscribeWorkspaceStream('ws-1')
      .catch((cause: unknown) => cause)) as PsbClientError;

    expect(error.failure.streamAccessState).toBe('starting');
    expect(error.failure.message).toContain('请稍等再试');
    expect(psbIpcCodeForFailure(error.failure)).toBe('PSB_STREAM_ACCESS_STARTING');
  });

  it('其它 409 不被误标成「没有运行中的访问」', async () => {
    const tokens = makeTokens();
    const api = makeApi(
      async () =>
        jsonResponse(409, {
          error: {
            code: 'WORKSPACE_OCCUPIED_BY_OTHER',
            message: '张三',
            details: { name: '张三' },
          },
        }),
      tokens.port,
    );

    const error = (await api
      .subscribeWorkspaceStream('ws-1')
      .catch((cause: unknown) => cause)) as PsbClientError;

    expect(error.failure.code).toBe('WORKSPACE_OCCUPIED_BY_OTHER');
    expect(error.failure.streamAccessState).toBeUndefined();
    expect(psbIpcCodeForFailure(error.failure)).toBe('PSB_WORKSPACE_OCCUPIED_BY_OTHER');
  });
});

/* ==================== 尽力拉起桌面访问（通用网页接口，待 PSB 放行） ==================== */

describe('ensureWorkspaceAccess：幂等拉起 + 轮询，入口未开放时非致命', () => {
  /** 记录每次请求的 URL 与方法（断言「只打这两条路径」）。 */
  function recordingFetch(
    respond: (input: string, init: RequestInit) => Response,
  ): {
    fetchImpl: (input: string, init: RequestInit) => Promise<Response>;
    requests: Array<{ url: string; method: string }>;
  } {
    const requests: Array<{ url: string; method: string }> = [];
    return {
      requests,
      fetchImpl: async (input, init) => {
        requests.push({ url: input, method: String(init.method) });
        return respond(input, init);
      },
    };
  }

  const POLL_FAST = { attempts: 2, intervalMs: 0 };

  it('200 且已在 running → ok，只 POST 一次、不轮询', async () => {
    const tokens = makeTokens();
    const { fetchImpl, requests } = recordingFetch(() =>
      jsonResponse(200, { data: { state: 'running' } }),
    );
    const api = makeApi(fetchImpl, tokens.port, { accessPoll: POLL_FAST });

    const outcome = await api.ensureWorkspaceAccess('ws-1');

    expect(outcome).toEqual({ ok: true, state: 'running', startedByThisCall: false });
    expect(requests).toEqual([
      {
        url: expect.stringMatching(/\/api\/remote\/workspaces\/ws-1\/access\/start$/),
        method: 'POST',
      },
    ]);
  });

  it('202 受理后轮询 GET …/access 直到 running（走 Cindy 命名空间的读口）', async () => {
    const tokens = makeTokens();
    let polls = 0;
    const { fetchImpl, requests } = recordingFetch((input, init) => {
      if (String(init.method) === 'POST') return jsonResponse(202, {});
      polls += 1;
      return jsonResponse(200, { data: { state: polls >= 2 ? 'running' : 'starting' } });
    });
    const api = makeApi(fetchImpl, tokens.port, { accessPoll: POLL_FAST });

    const outcome = await api.ensureWorkspaceAccess('ws-1');

    expect(outcome).toEqual({ ok: true, state: 'running', startedByThisCall: true });
    expect(requests.map((entry) => entry.method)).toEqual(['POST', 'GET', 'GET']);
    expect(requests[1]?.url).toMatch(/\/api\/cindy\/remote\/workspaces\/ws-1\/access$/);
  });

  it('403（Cindy 白名单未放行）→ cindy-entry-not-open，非致命且不轮询', async () => {
    const tokens = makeTokens();
    const { fetchImpl, requests } = recordingFetch(() =>
      jsonResponse(403, {
        error: { code: 'FORBIDDEN', message: '这个 Cindy 身份不能访问该接口' },
      }),
    );
    const api = makeApi(fetchImpl, tokens.port, { accessPoll: POLL_FAST });

    const outcome = await api.ensureWorkspaceAccess('ws-1');

    expect(outcome).toMatchObject({
      ok: false,
      reason: 'cindy-entry-not-open',
      failure: { code: 'FORBIDDEN' },
    });
    expect(requests).toHaveLength(1);
  });

  it('404（旧 PSB 没有这条路由）→ cindy-entry-not-open，非致命', async () => {
    const tokens = makeTokens();
    const { fetchImpl, requests } = recordingFetch(() =>
      jsonResponse(404, { error: { code: 'NOT_FOUND', message: '接口不存在' } }),
    );
    const api = makeApi(fetchImpl, tokens.port, { accessPoll: POLL_FAST });

    const outcome = await api.ensureWorkspaceAccess('ws-1');

    expect(outcome).toMatchObject({ ok: false, reason: 'cindy-entry-not-open' });
    expect(requests).toHaveLength(1);
  });

  it('轮询预算内没到 running → timeout（不是异常，调用方继续走订阅）', async () => {
    const tokens = makeTokens();
    const { fetchImpl } = recordingFetch((input, init) => {
      if (String(init.method) === 'POST') return jsonResponse(202, {});
      return jsonResponse(200, { data: { state: 'starting' } });
    });
    const api = makeApi(fetchImpl, tokens.port, { accessPoll: POLL_FAST });

    const outcome = await api.ensureWorkspaceAccess('ws-1');

    expect(outcome).toEqual({ ok: false, reason: 'timeout', failure: null });
  });

  it('幂等 ensure 说「没在运行也没在启动」→ 不再轮询，交给订阅的 409 报原因', async () => {
    const tokens = makeTokens();
    const { fetchImpl, requests } = recordingFetch(() =>
      jsonResponse(200, { data: { state: 'none' } }),
    );
    const api = makeApi(fetchImpl, tokens.port, { accessPoll: POLL_FAST });

    const outcome = await api.ensureWorkspaceAccess('ws-1');

    expect(outcome).toMatchObject({ ok: false, reason: 'failed', failure: null });
    expect(requests).toHaveLength(1);
  });

  it('网络失败 → failed（非致命），且永久只打一次（不在增强接口上重试）', async () => {
    const tokens = makeTokens();
    const { fetchImpl, requests } = recordingFetch(() => {
      throw new Error('ECONNRESET');
    });
    const api = makeApi(fetchImpl, tokens.port, { accessPoll: POLL_FAST });

    const outcome = await api.ensureWorkspaceAccess('ws-1');

    expect(outcome).toMatchObject({
      ok: false,
      reason: 'failed',
      failure: { code: 'PSB_UNREACHABLE' },
    });
    expect(requests).toHaveLength(1);
  });

  it('总预算是 deadline：单次请求超时被压到剩余预算内（不再「每次 20s × 次数」）', async () => {
    const tokens = makeTokens();
    const requests: string[] = [];
    // 模拟 PSB 一直不回：只有 `AbortSignal` 结束这次请求。旧实现会等满 20s；总预算是 30ms。
    const api = makeApi(
      async (input, init) => {
        requests.push(input);
        return await new Promise<Response>((_resolve, reject) => {
          const signal = init.signal as AbortSignal | undefined;
          const onAbort = () => reject(new Error('aborted'));
          if (signal?.aborted) onAbort();
          else signal?.addEventListener('abort', onAbort, { once: true });
        });
      },
      tokens.port,
      { accessPoll: { attempts: 5, intervalMs: 0, totalMs: 30 }, timeoutMs: 20_000 },
    );

    const startedAt = Date.now();
    const outcome = await api.ensureWorkspaceAccess('ws-1');
    const elapsed = Date.now() - startedAt;

    expect(outcome).toMatchObject({ ok: false, reason: 'failed' });
    // 总预算 30ms：必须远小于单次默认超时（20s），也远小于旧实现的最坏值。
    expect(elapsed).toBeLessThan(1_000);
    expect(requests).toHaveLength(1);
  });
});

/* ==================== 归一化 URL 白名单 / 列表契约 / 创建-查询语义分离 ==================== */

describe('resolvePsbUrl 与 readArray：外部路径与列表契约的安全边界', () => {
  it('action 路径的 encoded dot（%2e%2e）在发请求前被拒绝（INVALID_PARAMS）', async () => {
    const tokens = makeTokens();
    const calls: string[] = [];
    const api = makeApi(async (input) => {
      calls.push(input);
      return jsonResponse(200, { data: null });
    }, tokens.port);

    for (const path of [
      '/api/cindy/remote/workspaces/ws-1/%2e%2e/%2e%2e/evil',
      '/api/cindy/remote/workspaces/ws-1/../evil',
    ]) {
      const error = await api
        .runRemoteAction({ method: 'GET', path })
        .catch((cause: unknown) => cause);
      expect((error as { code?: string }).code).toBe('INVALID_PARAMS');
    }
    // 一个越界路径都不该真的发出去。
    expect(calls).toEqual([]);
  });

  it('列表响应缺键是协议错，而不是静默的空列表（2026-11-26 联调事故类）', async () => {
    const tokens = makeTokens();
    const api = makeApi(
      async () => jsonResponse(200, { data: { items: [] } }),
      tokens.port,
    );

    const error = await api.listWorkspaces().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(PsbClientError);
    expect((error as PsbClientError).failure.code).toBe('PSB_PROTOCOL');
    // 合法空数组仍必须是「真的没有」。
    const empty = makeApi(async () => jsonResponse(200, { data: { workspaces: [] } }), tokens.port);
    await expect(empty.listWorkspaces()).resolves.toEqual([]);
  });

  it('createSession 先读工作区再建会话：读失败 → 一个 POST 都不发（不产生孤儿会话）', async () => {
    const tokens = makeTokens();
    const methods: string[] = [];
    const api = makeApi(async (_input, init) => {
      methods.push(String(init.method));
      // 列表协议违约：如果实现先建会话，这里会看到 POST。
      return jsonResponse(200, { data: { items: [] } });
    }, tokens.port);

    const error = await api
      .createSession({ workspaceId: 'ws-1', agentKind: 'pi', clientRequestId: 'req-1' })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(PsbClientError);
    expect((error as PsbClientError).failure.code).toBe('PSB_PROTOCOL');
    expect(methods).toEqual(['GET']);
  });

  it('getSession 的真实请求数是 2（会话行 + 工作区列表，PSB 没有单工作区读口）', async () => {
    const tokens = makeTokens();
    const requests: Array<{ url: string; method: string }> = [];
    const api = makeApi(async (input, init) => {
      requests.push({ url: input, method: String(init.method) });
      if (String(init.method) === 'GET' && input.includes('/sessions/psb-1')) {
        return jsonResponse(200, {
          data: { id: 'psb-1', workspaceId: 'ws-1', agentKind: 'pi', status: 'running' },
        });
      }
      return jsonResponse(200, {
        data: {
          workspaces: [{ id: 'ws-1', title: 'saga2', state: 'ready', clientOnline: true }],
        },
      });
    }, tokens.port);

    const result = await api.getSession('psb-1');

    expect(result.workspace.id).toBe('ws-1');
    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toContain('/sessions/psb-1');
    expect(requests[1]?.url).toMatch(/\/api\/cindy\/remote\/workspaces$/);
  });

  it('createSession 成功时返回创建前读到的工作区快照（列表先于 POST）', async () => {
    const tokens = makeTokens();
    const methods: string[] = [];
    const api = makeApi(async (_input, init) => {
      const method = String(init.method);
      methods.push(method);
      if (method === 'GET') {
        return jsonResponse(200, {
          data: {
            workspaces: [
              { id: 'ws-1', title: 'saga2', state: 'ready', clientOnline: true, usable: true },
            ],
          },
        });
      }
      return jsonResponse(200, {
        data: {
          id: 'psb-1',
          workspaceId: 'ws-1',
          agentKind: 'pi',
          status: 'starting',
        },
      });
    }, tokens.port);

    const result = await api.createSession({
      workspaceId: 'ws-1',
      agentKind: 'pi',
      clientRequestId: 'req-1',
    });

    expect(methods).toEqual(['GET', 'POST']);
    expect(result.session.id).toBe('psb-1');
    expect(result.workspace.id).toBe('ws-1');
  });
});
