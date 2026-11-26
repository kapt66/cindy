import { describe, expect, it } from 'vitest';

import {
  classifyRemoteSessionTransport,
  isTunnelRemoteSessionTransport,
  remoteSessionHostOwnsCwd,
  remoteTransportErrorCode,
  resolveRemoteCodexCredentialMode,
  resolveRemoteTransportCapabilities,
} from '../remote-session-routing.js';
import { remoteTunnelModeForAgent } from '../remote-tunnel-dispatch.js';
import { resolveRemoteCcTunnelStartParams } from '../remote-cc-start.js';

describe('classifyRemoteSessionTransport', () => {
  it.each([
    [undefined, 'local'],
    [null, 'local'],
    ['', 'local'],
    ['mcpr:', 'mcpr'],
    ['mcpr:instance-1', 'mcpr'],
    // PSB 远程工作区的会话身份。畸形值(`psb:` 无 id)同样留在 psb —— 落回 ssh 会把它报成
    // SSH_HOST_NOT_FOUND,把「这不是 SSH 主机」误报成「SSH 主机没连」。
    ['psb:', 'psb'],
    ['psb:session-1', 'psb'],
    ['psb: id with space', 'psb'],
    ['PSB:upper-case-is-an-ssh-host', 'ssh'],
    ['ssh-host-1', 'ssh'],
  ] as const)('classifies %s as %s', (remoteHostId, expected) => {
    expect(classifyRemoteSessionTransport(remoteHostId)).toBe(expected);
  });
});

describe('isTunnelRemoteSessionTransport', () => {
  it.each([
    [undefined, false],
    [null, false],
    ['', false],
    ['ssh-host-1', false],
    ['mcpr:', true],
    ['mcpr:instance-1', true],
    ['psb:', true],
    ['psb:session-1', true],
    // 大小写按主进程口径处理:`PSB:` 不是隧道身份(SSH host)。
    ['PSB:upper-case-is-an-ssh-host', false],
  ] as const)('classifies %s as tunnel=%s', (remoteHostId, expected) => {
    expect(isTunnelRemoteSessionTransport(remoteHostId)).toBe(expected);
  });

  it('与 classifyRemoteSessionTransport 恒等(单一判据,不是第二套前缀判断)', () => {
    const cases = ['', null, undefined, 'mcpr:', 'mcpr:x', 'psb:', 'psb:y', 'builder', 'PSB:x'];
    for (const value of cases) {
      expect(isTunnelRemoteSessionTransport(value)).toBe(
        classifyRemoteSessionTransport(value) === 'mcpr'
          || classifyRemoteSessionTransport(value) === 'psb',
      );
    }
  });
});

describe('remoteSessionHostOwnsCwd', () => {
  it.each([
    // 只有 PSB：它按服务端会话记录的工作区 spawn 引擎，Cindy 的 workingDir 是虚拟路径。
    [undefined, false],
    [null, false],
    ['', false],
    ['psb:', true],
    ['psb:session-1', true],
    // MCPR / SSH 的 workingDir 是实例/主机上的真实路径，cwd 仍由 Cindy 下发。
    ['mcpr:', false],
    ['mcpr:instance-1', false],
    ['ssh-host-1', false],
    ['PSB:upper-case-is-an-ssh-host', false],
  ] as const)('hostOwnsCwd(%s) = %s', (remoteHostId, expected) => {
    expect(remoteSessionHostOwnsCwd(remoteHostId)).toBe(expected);
  });

  it('与 classifyRemoteSessionTransport 恒等（唯一判据，不手写前缀）', () => {
    for (const value of ['', null, undefined, 'psb:', 'psb:x', 'mcpr:y', 'ssh-host']) {
      expect(remoteSessionHostOwnsCwd(value)).toBe(
        classifyRemoteSessionTransport(value) === 'psb',
      );
    }
  });
});

describe('resolveRemoteCodexCredentialMode', () => {
  it.each([
    // 两条隧道 transport 都只带本机 AI Gateway key:远端没有可复制的 Desktop OAuth。
    ['mcpr:', 'gateway-key'],
    ['mcpr:instance-1', 'gateway-key'],
    ['psb:', 'gateway-key'],
    ['psb:session-1', 'gateway-key'],
    // SSH 保留自己的 CODEX_HOME fallback 语义。
    ['ssh-host-1', undefined],
  ] as const)('maps %s to %s', (remoteHostId, expected) => {
    expect(resolveRemoteCodexCredentialMode(remoteHostId)).toBe(expected);
  });
});

/**
 * 能力描述符是**唯一能力表**：cc 宿主 / pi 隧道 / codex / file ops / 凭证都从它取能力，
 * 不再各自按前缀判断。这组断言锁的是「表本身」，不是某个调用点。
 */
describe('resolveRemoteTransportCapabilities', () => {
  it('describes each transport once (tag / cwd / fileOps / credential / tunnel modes)', () => {
    const expected = {
      local: { tag: 'LOCAL', ownsCwd: false, fileOpsMode: 'local', codexCredentialMode: undefined },
      ssh: { tag: 'SSH', ownsCwd: false, fileOpsMode: 'ssh', codexCredentialMode: undefined },
      mcpr: { tag: 'MCPR', ownsCwd: false, fileOpsMode: 'tunnel-exec', codexCredentialMode: 'gateway-key' },
      psb: { tag: 'PSB', ownsCwd: true, fileOpsMode: 'tunnel-exec', codexCredentialMode: 'gateway-key' },
    } as const;
    for (const [remoteHostId, transport] of [
      [undefined, 'local'],
      [null, 'local'],
      ['ssh-host-1', 'ssh'],
      ['mcpr:instance-1', 'mcpr'],
      ['psb:', 'psb'],
      ['psb:session-1', 'psb'],
    ] as const) {
      const capabilities = resolveRemoteTransportCapabilities(remoteHostId);
      expect(capabilities.transport).toBe(transport);
      expect(capabilities).toMatchObject(expected[transport]);
    }
  });

  it('maps every agent to the shared tunnel mode table for tunnel transports only', () => {
    // 隧道 transport 的 agent → mode 表来自共享契约（与 PSB 是同一份 mode 语义）。
    for (const agent of ['claude-code', 'codex', 'pi'] as const) {
      expect(remoteTunnelModeForAgent('mcpr:instance-1', agent)).toBe(
        remoteTunnelModeForAgent('psb:session-1', agent),
      );
      expect(remoteTunnelModeForAgent('ssh-host-1', agent)).toBeNull();
      expect(remoteTunnelModeForAgent(undefined, agent)).toBeNull();
    }
    expect(remoteTunnelModeForAgent('psb:session-1', 'claude-code')).toBe('cc-mgr');
    expect(remoteTunnelModeForAgent('psb:session-1', 'codex')).toBe('codex-appserver');
    expect(remoteTunnelModeForAgent('psb:session-1', 'pi')).toBe('pi');
  });
});

/**
 * 归因码跟着 transport 走：PSB 会话上报 `[MCPR_*]` 会把运维指向错误的系统。
 * 最小失败输入：psb 会话上的 pi 运行时缺失（本应是 `[PSB_PI_BINARY_MISSING]`）。
 */
describe('remoteTransportErrorCode', () => {
  it('tags the code with the transport that actually failed', () => {
    expect(remoteTransportErrorCode('psb:session-1', 'PI_BINARY_MISSING'))
      .toBe('[PSB_PI_BINARY_MISSING]');
    expect(remoteTransportErrorCode('mcpr:instance-1', 'PI_BINARY_MISSING'))
      .toBe('[MCPR_PI_BINARY_MISSING]');
    // SSH / 本地没有隧道命名空间：落中性前缀，不冒用 MCPR / PSB。
    expect(remoteTransportErrorCode('ssh-host-1', 'PI_BINARY_MISSING'))
      .toBe('[REMOTE_PI_BINARY_MISSING]');
  });
});

/**
 * cc 隧道的 cwd 口径（2026-11-26 实报的回归点）。
 *
 * 历史 bug：这里曾用第二个分类器 `parsePsbRemoteHostId` 判 cwd。畸形 `psb:`（空 id）在
 * 分类器里仍是 psb transport，但解析返回 null → 虚拟 `/psb-remote/…` 被原样下发 →
 * daemon 侧 SDK 用不存在的目录 spawn `claude` → query 立即终止、本地会话被自动关闭。
 */
describe('resolveRemoteCcTunnelStartParams', () => {
  it('sends the host-owned cwd (`.`) for every psb identity, including a malformed one', () => {
    for (const remoteHostId of ['psb:session-1', 'psb:']) {
      expect(resolveRemoteCcTunnelStartParams(remoteHostId, { cwd: '/psb-remote/ws' }))
        .toEqual({ cwd: '.' });
    }
  });

  it('keeps the real remote path for mcpr / SSH and does not mutate the input', () => {
    const params = { cwd: '/srv/repo', model: 'x' };
    expect(resolveRemoteCcTunnelStartParams('mcpr:instance-1', params)).toBe(params);
    expect(resolveRemoteCcTunnelStartParams('ssh-host-1', params)).toBe(params);
    expect(params).toEqual({ cwd: '/srv/repo', model: 'x' });
  });
});
