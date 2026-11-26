/**
 * `psb:` 隧道取 token 的接缝（`maker-host/psb-agent-tunnel.ts`）。
 *
 * Bug 依据：PSB 的隧道鉴权是**宿主的 Cindy Connection JWT**，而 token 由
 * `ConnectionTokenProvider` 在内存里缓存（有效期 = `expiresIn - 60s`）。若隧道被 401/403 拒后
 * 不失效缓存，接下来最多半小时的每次建连都会拿同一条坏 token 重试 —— 用户看到的是
 * 「重新登录也没用」。`psbClient` 对 HTTP 用的是「401 只重签一次」；隧道这条长连接没有
 * 自动重试，所以至少必须让**下一次**调用重新签发。
 *
 * 覆盖缺口：`remote-workspace/psbTunnel.ts` 的测试只钉 URL 与关闭码归因，不覆盖
 * 「宿主身份 → token deps」的映射，也不覆盖失败时不清凭据的边界。
 * 最小失败输入：`[PSB_TUNNEL_AUTH]` 被拒后 `invalidate` 从未被调用（缓存中毒）。
 * tier：unit（凭据接缝契约）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getAuthState, tokenProvider, getToken, invalidateToken, openTunnel } = vi.hoisted(() => ({
  getAuthState: vi.fn(() => ({ isAuthenticated: true })),
  tokenProvider: { getToken: vi.fn(), invalidate: vi.fn() },
  getToken: vi.fn(),
  invalidateToken: vi.fn(),
  openTunnel: vi.fn(),
}));

// `vi.mock` 的说明符按**测试文件**解析：本文件在 `__tests__/` 下，被测模块在上一级目录。
vi.mock('../../authManager.js', () => ({ getAuthState }));
vi.mock('../../cindy-brain/index.js', () => ({
  getConnectionTokenProvider: () => tokenProvider,
}));
vi.mock('../../remote-workspace/psbAuth.js', () => ({
  getPsbConnectionToken: getToken,
  invalidatePsbConnectionToken: invalidateToken,
}));
vi.mock('../../remote-workspace/psbTunnel.js', () => ({ openPsbTunnel: openTunnel }));

import { openPsbAgentTunnel } from '../psb-agent-tunnel';

/** `openPsbTunnel` 拿到的 deps（生产实现只依赖 `getToken`；其余留给隧道模块自己）。 */
type TunnelDeps = {
  mode?: string;
  getToken?: () => Promise<{ ok: true; token: string } | { ok: false; reasonKey: string }>;
};

function lastTunnelDeps(): TunnelDeps {
  const call = openTunnel.mock.calls.at(-1);
  expect(call, 'openPsbTunnel 应被调用').toBeDefined();
  return call![1] as TunnelDeps;
}

describe('openPsbAgentTunnel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openTunnel.mockResolvedValue({ fakeStream: true });
    getToken.mockResolvedValue({ ok: true, token: 'conn-jwt', audience: 'xd:meka-submit' });
  });

  it('把宿主身份解析出的 Connection JWT 交给隧道，且 mode 原样透传', async () => {
    await expect(openPsbAgentTunnel('psb:session-1', 'pi')).resolves.toEqual({ fakeStream: true });

    expect(openTunnel).toHaveBeenCalledWith(
      'psb:session-1',
      expect.objectContaining({ mode: 'pi' }),
    );
    // 取 token 的依赖只在 main 里组装一次：身份走 authManager，签发/缓存走 ConnectionTokenProvider。
    await expect(lastTunnelDeps().getToken?.()).resolves.toEqual({ ok: true, token: 'conn-jwt' });
    expect(getToken).toHaveBeenCalledWith({ getAuthState, tokens: tokenProvider });
  });

  it('token 取不到时只交出原因键（不把 detail / audience 带进 maker-host 错误串）', async () => {
    getToken.mockResolvedValue({
      ok: false,
      reasonKey: 'remoteWorkspace.status.needOrg',
      detail: 'membership is personal',
    });

    await openPsbAgentTunnel('psb:session-1', 'cc-mgr');

    await expect(lastTunnelDeps().getToken?.()).resolves.toEqual({
      ok: false,
      reasonKey: 'remoteWorkspace.status.needOrg',
    });
  });

  it('隧道鉴权被拒时失效缓存，让下一次调用重新签发一次', async () => {
    openTunnel.mockRejectedValue(new Error('[PSB_TUNNEL_AUTH] authentication rejected (401)'));

    await expect(openPsbAgentTunnel('psb:session-1', 'cc-mgr')).rejects.toThrow(
      '[PSB_TUNNEL_AUTH]',
    );
    expect(invalidateToken).toHaveBeenCalledWith({ getAuthState, tokens: tokenProvider });
  });

  it('其它失败（会话未就绪 / 网络）不动凭据缓存', async () => {
    openTunnel.mockRejectedValue(
      new Error('[PSB_SESSION_NOT_READY] session or workspace is not ready for a tunnel'),
    );

    await expect(openPsbAgentTunnel('psb:session-1', 'codex-appserver')).rejects.toThrow(
      '[PSB_SESSION_NOT_READY]',
    );
    expect(invalidateToken).not.toHaveBeenCalled();
  });
});
