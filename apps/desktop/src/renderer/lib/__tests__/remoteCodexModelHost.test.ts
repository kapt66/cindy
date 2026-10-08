import { describe, expect, it } from 'vitest';

import { classifyRemoteSessionTransport } from '../../../main/maker-host/remote-session-routing';
import { resolveRemoteCodexModelHostId } from '../remoteCodexModelHost';

/**
 * 这条规则是 2026-10-08 实机故障的唯一判定点：MCPRouter 的 Codex 会话被当成 SSH 执行主机，
 * 于是 main 的 SSH-only 模型清单探针把一切失败折叠成
 * `SSH_EXEC_FAILED: Unable to read remote Codex models; reconnect and retry`，
 * 渲染层随即弹出「无法读取远程设备上的模型」并（通过 `remoteModelListBlocked`）**禁止发送**，
 * 同时模型选择器用一个空清单当远端模型面 —— 表现为「有的模型不存在」。
 */
describe('resolveRemoteCodexModelHostId', () => {
  it('把真正的 SSH 执行主机交给 SSH 模型探针', () => {
    expect(
      resolveRemoteCodexModelHostId({ remoteHostId: 'builder', agentKind: 'codex' }),
    ).toBe('builder');
  });

  it('MCPRouter 隧道身份永不进入 SSH 探针（模型面来自本机网关目录）', () => {
    expect(
      resolveRemoteCodexModelHostId({
        remoteHostId: 'mcpr:f235de4c-bed5-4486-a83e-71baa3f22a46',
        agentKind: 'codex',
      }),
    ).toBeNull();
  });

  it('非 Codex 引擎不走这条探针', () => {
    expect(
      resolveRemoteCodexModelHostId({ remoteHostId: 'builder', agentKind: 'claude-code' }),
    ).toBeNull();
    expect(
      resolveRemoteCodexModelHostId({ remoteHostId: 'builder', agentKind: 'pi' }),
    ).toBeNull();
    expect(resolveRemoteCodexModelHostId({ remoteHostId: 'builder' })).toBeNull();
  });

  it('device-link 的模型面走被控端隧道，与 SSH 主机互斥', () => {
    expect(
      resolveRemoteCodexModelHostId({
        remoteHostId: 'builder',
        agentKind: 'codex',
        deviceLinkDeviceId: 'device-1',
      }),
    ).toBeNull();
  });

  it('本地会话（无 remoteHostId）保持 null', () => {
    expect(resolveRemoteCodexModelHostId({ remoteHostId: null, agentKind: 'codex' })).toBeNull();
    expect(resolveRemoteCodexModelHostId({ agentKind: 'codex' })).toBeNull();
  });

  it('畸形 mcpr 值留在 MCPRouter 路径上，不被误判成 SSH 主机', () => {
    expect(
      resolveRemoteCodexModelHostId({ remoteHostId: 'mcpr:', agentKind: 'codex' }),
    ).toBeNull();
  });

  /**
   * 渲染层 import 不到主进程的分类器，只能镜像同一个谓词；这条矩阵断言两者**永远一致**，
   * 是本轮故障（主进程三处已分类、渲染层漏按 transport 分类）不再重演的唯一机制。
   */
  it('与主进程的 transport 分类器逐字一致', () => {
    const cases = [
      'builder',
      'host-with-dash.example',
      'mcpr:f235de4c-bed5-4486-a83e-71baa3f22a46',
      'mcpr:',
      'mcpr: id with space',
      'MCPr:upper-case-is-an-ssh-host',
    ];
    for (const remoteHostId of cases) {
      const sshOnly = resolveRemoteCodexModelHostId({ remoteHostId, agentKind: 'codex' }) !== null;
      expect(sshOnly, `disagreement for ${remoteHostId}`).toBe(
        classifyRemoteSessionTransport(remoteHostId) === 'ssh',
      );
    }
  });
});
