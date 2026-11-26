/**
 * `psb:` transport 的隧道分派与 URL 参数契约（2026-11-25 第三种 transport 接入）。
 *
 * 两条价值各异的断言，都在**真实生产入口**上：
 *
 * 1. `openRemoteTunnel` 必须按 transport 选隧道来源，且**不回落 SSH**。
 *    Bug 依据：`mcpr:` 历史上多次被喂进 SSH pool（`LAZY_CREATE_FAILED: remote SSH host … not found`，
 *    见 `docs/dev-rules/mcpr-remote-session-routing.md` §2/§8）；新增 `psb:` 时若分派写错，
 *    失败会表现为「SSH 主机没连」，把 transport 缺失误报成连接问题。
 *    最小失败输入：`openRemoteTunnel('psb:<id>', 'cc-mgr')` 若走到 MCPR opener 即失败。
 *    现有覆盖缺口：既有 hook 测试只覆盖「钩子传下去的是哪个 opener」，不覆盖分派本身。
 *    tier：unit（跨文件 transport 分派契约）。
 *
 * 2. `buildPsbTunnelUrl` 的参数白名单：`mode` 缺省不写、`bundleVersion` 只在消费 cc-mgr 产物的
 *    两种 mode 上带、值取自 `CC_MGR_BUNDLE_VERSION`、鉴权不进 URL。
 *    Bug 依据：MCPRouter 侧同类契约由 `mcprExec.test.ts` / `mcprTunnelMeka.test.ts` 钉住；
 *    PSB 是新的隧道实现，漏一条就会让服务端白做 bundle 物化，或把 token 写进可被日志/代理记录的
 *    URL。最小失败输入：`pi`/`exec` 上出现 `bundleVersion=`，或 URL 里出现 `token=`。
 *    tier：unit（协议契约）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// `vi.mock` 会被提升到文件顶部，共享的 spy 必须先经 `vi.hoisted` 创建。
const { psbOpen, mcprOpen } = vi.hoisted(() => ({
  psbOpen: vi.fn(async () => ({ psbStream: true })),
  mcprOpen: vi.fn(async () => ({ mcprStream: true })),
}));

vi.mock('../psb-agent-tunnel.js', () => ({ openPsbAgentTunnel: psbOpen }));
vi.mock('../mcpr-tunnel.js', () => ({ openMcprTunnel: mcprOpen }));

import { CC_MGR_BUNDLE_VERSION } from '@cindy/maker-cc-manager';

import { buildPsbTunnelUrl } from '../../remote-workspace/psbTunnel.js';
import { openRemoteTunnel } from '../remote-tunnel-dispatch.js';

describe('openRemoteTunnel：按 transport 选隧道来源，不回落 SSH', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('`psb:` 走 PSB 隧道（mode 直传），`mcpr:` 走 MCPRouter 隧道（opts 形态）', async () => {
    await expect(openRemoteTunnel('psb:session-1', 'exec')).resolves.toEqual({ psbStream: true });
    expect(psbOpen).toHaveBeenCalledWith('psb:session-1', 'exec');
    expect(mcprOpen).not.toHaveBeenCalled();

    await expect(openRemoteTunnel('mcpr:instance-1', 'codex-appserver')).resolves.toEqual({
      mcprStream: true,
    });
    expect(mcprOpen).toHaveBeenCalledWith('mcpr:instance-1', { mode: 'codex-appserver' });
    expect(psbOpen).toHaveBeenCalledTimes(1);
  });

  it('malformed `psb:` / `mcpr:` stay on their own tunnel (never treated as SSH ids)', async () => {
    await openRemoteTunnel('psb:', 'pi');
    expect(psbOpen).toHaveBeenCalledWith('psb:', 'pi');
    expect(mcprOpen).not.toHaveBeenCalled();

    await openRemoteTunnel('mcpr:', 'pi');
    expect(mcprOpen).toHaveBeenCalledWith('mcpr:', { mode: 'pi' });
  });

  it('fails loud for local / SSH identities instead of opening a tunnel', async () => {
    for (const remoteHostId of ['', 'ssh-host-1'] as const) {
      await expect(openRemoteTunnel(remoteHostId, 'cc-mgr')).rejects.toThrow(
        /\[REMOTE_TUNNEL_INVALID\]/,
      );
    }
    expect(psbOpen).not.toHaveBeenCalled();
    expect(mcprOpen).not.toHaveBeenCalled();
  });
});

describe('buildPsbTunnelUrl：mode 必填、bundleVersion 声明与就绪帧 opt-in', () => {
  const basePath = '/api/cindy/remote/sessions';

  it('cc-mgr 也必须显式写 mode（PSB 侧 mode 必填，缺省值不等于 MCPR 的默认）', () => {
    const url = new URL(buildPsbTunnelUrl('session-1', 'cc-mgr'));

    expect(url.pathname).toBe(`${basePath}/session-1/agent-tunnel`);
    expect(url.protocol).toBe('wss:');
    // 2026-11-26 联调：PSB 对缺 mode 的 Upgrade 回 400「mode 必须是 … 之一（收到 空）」，
    // 直接把 cc-mgr 控制通道与 codex-appserver 的 bootstrap 全挡掉。
    expect(url.searchParams.get('mode')).toBe('cc-mgr');
    expect(url.searchParams.get('bundleVersion')).toBe(CC_MGR_BUNDLE_VERSION);
    // 参数白名单：不出现任何计划外参数（尤其 token / 凭据一律不进 URL）。
    expect([...url.searchParams.keys()].sort()).toEqual(['bundleVersion', 'mode', 'readyFrame']);
    expect(url.hash).toBe('');
  });

  it('codex-appserver 写 mode 且声明 bundle 版本（同一份 cc-mgr 产物）', () => {
    const url = new URL(buildPsbTunnelUrl('session-1', 'codex-appserver'));
    expect(url.searchParams.get('mode')).toBe('codex-appserver');
    expect(url.searchParams.get('bundleVersion')).toBe(CC_MGR_BUNDLE_VERSION);
  });

  it.each(['pi', 'exec'] as const)(
    '%s 不带 bundleVersion（不消费 cc-mgr 产物，声明版本只会让服务端白做物化）',
    (mode) => {
      const url = new URL(buildPsbTunnelUrl('session-1', mode));
      expect(url.searchParams.get('mode')).toBe(mode);
      expect(url.searchParams.has('bundleVersion')).toBe(false);
      expect([...url.searchParams.keys()].sort()).toEqual(['mode', 'readyFrame']);
    },
  );

  it.each(['cc-mgr', 'codex-appserver', 'pi', 'exec'] as const)(
    '%s 都声明 readyFrame=1（PSB 0.1.160+ 就绪帧 opt-in，不写默认不发）',
    (mode) => {
      const url = new URL(buildPsbTunnelUrl('session-1', mode));
      // 服务端只认字面量 `1`：'true' / 'yes' 都等于没声明，隧道会固定等满 5s / 1.2s 兜底。
      expect(url.searchParams.get('readyFrame')).toBe('1');
      // 写 readyFrame 不得破坏既有 mode / bundleVersion 语义。
      expect(url.searchParams.get('mode')).toBe(mode);
      expect(url.searchParams.has('bundleVersion')).toBe(
        mode === 'cc-mgr' || mode === 'codex-appserver',
      );
    },
  );

  it('协议违约的 session id（含 / \\ % 空白）直接拒绝：不让编码分隔符进路径', () => {
    // 2026-11-27 复审 P2：URL 路径校验拒绝 `%2F` / `%5C`（服务端解码后是 `../`，能绕出 Cindy
    // 命名空间）。旧实现把 `sess 1/2` 编成 `sess%201%2F2` 当成合法路径；真实 PSB 会话 id 是
    // UUID / 短标识，含这些字符只可能是注入 / 拼接错误 —— 在拼 URL 前拒绝，而不是放行编码分隔符。
    for (const sessionId of ['sess 1/2', 'sess%2F1', 'sess\\1', 'sess?x=1', ' ']) {
      expect(() => buildPsbTunnelUrl(sessionId, 'pi'), sessionId).toThrow(/PSB path rejected/);
    }
    // 合法 id（UUID / 短标识）照常构造。
    expect(new URL(buildPsbTunnelUrl('sess-1_2.a', 'pi')).pathname).toBe(
      `${basePath}/sess-1_2.a/agent-tunnel`,
    );
  });
});
