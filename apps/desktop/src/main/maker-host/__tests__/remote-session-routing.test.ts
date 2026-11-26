import { describe, expect, it } from 'vitest';

import {
  classifyRemoteSessionTransport,
  isTunnelRemoteSessionTransport,
  remoteSessionHostOwnsCwd,
  resolveRemoteCodexCredentialMode,
} from '../remote-session-routing.js';

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
