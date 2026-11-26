import { describe, expect, it } from 'vitest';

import { classifyRemoteSessionTransport } from '../../../main/maker-host/remote-session-routing';
import {
  asSshRemoteHostId,
  resolveRemoteCodexModelHostId,
  resolveSshCodexCatalogHostId,
} from '../remoteCodexModelHost';

/**
 * 这条规则是 2026-10-08 与 2026-11-23 两次实机故障的唯一判定点：
 * MCPRouter 的 Codex 会话 / 草稿被当成 SSH 执行主机，于是 main 的 SSH-only 模型清单探针
 * （`maker:remote-ssh:list-codex-models`）把「这不是 SSH 主机」变成失败事实，渲染层随即弹出
 * 「无法读取远程设备上的模型」（2026-10-08 还经 `remoteModelListBlocked` **禁止发送**，
 * 2026-11-23 则让草稿用空清单当远端模型面、丢掉本机目录里的 codex 型号）。
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

  it('PSB 远程工作区身份同样永不进入 SSH 探针（同一份 gateway-key 口径）', () => {
    expect(
      resolveRemoteCodexModelHostId({
        remoteHostId: 'psb:9d8b8f6e-0f3a-4d6b-8a1d-2f6c3a4b5c6d',
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

  it('畸形 psb 值留在 PSB 路径上，不被误判成 SSH 主机', () => {
    expect(
      resolveRemoteCodexModelHostId({ remoteHostId: 'psb:', agentKind: 'codex' }),
    ).toBeNull();
  });
});

/**
 * `asSshRemoteHostId` 是 `useSshCodexProviders` 品牌类型的产出点：SSH-only 探针的每个调用点
 * 都必须经过它。这里把边界值单独钉住，避免将来为了「兼容某个前缀」放宽判据。
 */
describe('asSshRemoteHostId', () => {
  it('空值表示本地目标，不是 SSH 主机', () => {
    expect(asSshRemoteHostId(null)).toBeNull();
    expect(asSshRemoteHostId(undefined)).toBeNull();
    expect(asSshRemoteHostId('')).toBeNull();
  });

  it('MCPRouter 身份（含畸形 mcpr: 与带空格的实例值）一律不是 SSH 主机', () => {
    expect(asSshRemoteHostId('mcpr:')).toBeNull();
    expect(asSshRemoteHostId('mcpr:f235de4c-bed5-4486-a83e-71baa3f22a46')).toBeNull();
    expect(asSshRemoteHostId('mcpr: id with space')).toBeNull();
  });

  it('PSB 远程工作区身份（含畸形 psb: 与带空格的会话值）一律不是 SSH 主机', () => {
    expect(asSshRemoteHostId('psb:')).toBeNull();
    expect(asSshRemoteHostId('psb:9d8b8f6e-0f3a-4d6b-8a1d-2f6c3a4b5c6d')).toBeNull();
    expect(asSshRemoteHostId('psb: id with space')).toBeNull();
  });

  it('普通 host id 原样返回，大小写按主进程口径处理', () => {
    expect(asSshRemoteHostId('builder')).toBe('builder');
    expect(asSshRemoteHostId('host-with-dash.example')).toBe('host-with-dash.example');
    // 主进程只认小写 `mcpr:` / `psb:` 前缀，`MCPr:` / `PSB:` 因此是 SSH 主机；
    // 两侧必须一致（见下方矩阵）。
    expect(asSshRemoteHostId('MCPr:upper-case-is-an-ssh-host')).toBe(
      'MCPr:upper-case-is-an-ssh-host',
    );
    expect(asSshRemoteHostId('PSB:upper-case-is-an-ssh-host')).toBe(
      'PSB:upper-case-is-an-ssh-host',
    );
  });
});

/**
 * 新建任务草稿的 SSH Codex 目录判据。2026-11-23 的假告警正是这里少了 mcpr 分支：
 * 草稿把 `mcpr:<instanceId>` 当成 SSH 主机去读远端清单，主进程 `LIST_CODEX_MODELS` 按
 * transport 分类抛 `INVALID_PARAMS`，选择器顶部因此出现「无法读取远程设备上的模型」。
 */
describe('resolveSshCodexCatalogHostId', () => {
  it('MCPRouter 目标不建 SSH Codex 目录（模型面就是本机目录）', () => {
    expect(
      resolveSshCodexCatalogHostId({
        remoteHostId: 'mcpr:f235de4c-bed5-4486-a83e-71baa3f22a46',
      }),
    ).toBeNull();
  });

  it('PSB 远程工作区目标不建 SSH Codex 目录（模型面就是本机目录）', () => {
    expect(
      resolveSshCodexCatalogHostId({
        remoteHostId: 'psb:9d8b8f6e-0f3a-4d6b-8a1d-2f6c3a4b5c6d',
      }),
    ).toBeNull();
    expect(resolveSshCodexCatalogHostId({ remoteHostId: 'psb:' })).toBeNull();
  });

  it('真 SSH 目标照旧按需读取远端 Codex 清单', () => {
    expect(resolveSshCodexCatalogHostId({ remoteHostId: 'builder' })).toBe('builder');
  });

  it('device-link 目标与本地目标都不建 SSH 目录', () => {
    expect(
      resolveSshCodexCatalogHostId({ remoteHostId: 'builder', deviceLinkDeviceId: 'device-1' }),
    ).toBeNull();
    expect(
      resolveSshCodexCatalogHostId({
        remoteHostId: 'mcpr:f235de4c-bed5-4486-a83e-71baa3f22a46',
        deviceLinkDeviceId: 'device-1',
      }),
    ).toBeNull();
    expect(resolveSshCodexCatalogHostId({ remoteHostId: null })).toBeNull();
    expect(resolveSshCodexCatalogHostId({})).toBeNull();
  });
});

/**
 * 渲染层 import 不到主进程的分类器，只能镜像同一个谓词；这条矩阵断言两者**永远一致**，
 * 是本轮故障（主进程已分类、渲染层漏按 transport 分类）不再重演的唯一机制。
 *
 * 注意它同时覆盖 `resolveSshCodexCatalogHostId`：草稿的那条判据与 Codex 探针共用
 * `asSshRemoteHostId`，任何一侧放宽都会在这里红。
 */
describe('渲染层判据与主进程 transport 分类器保持一致', () => {
  const cases = [
    'builder',
    'host-with-dash.example',
    'mcpr:f235de4c-bed5-4486-a83e-71baa3f22a46',
    'mcpr:',
    'mcpr: id with space',
    'MCPr:upper-case-is-an-ssh-host',
    // 第三种 transport（PSB 远程工作区）：与 mcpr 同口径，含畸形值与大小写边界。
    'psb:9d8b8f6e-0f3a-4d6b-8a1d-2f6c3a4b5c6d',
    'psb:',
    'psb: id with space',
    'PSB:upper-case-is-an-ssh-host',
  ];

  it('SSH-only 判据对同一批输入与 classifyRemoteSessionTransport 逐字一致', () => {
    for (const remoteHostId of cases) {
      const sshOnly = asSshRemoteHostId(remoteHostId) !== null;
      expect(sshOnly, `disagreement for ${remoteHostId}`).toBe(
        classifyRemoteSessionTransport(remoteHostId) === 'ssh',
      );
    }
  });

  it('两个入口判据都不会把隧道身份（mcpr / psb）当 SSH 主机', () => {
    for (const remoteHostId of cases) {
      const mainSaysSsh = classifyRemoteSessionTransport(remoteHostId) === 'ssh';
      expect(
        resolveRemoteCodexModelHostId({ remoteHostId, agentKind: 'codex' }) !== null,
        `codex probe disagreement for ${remoteHostId}`,
      ).toBe(mainSaysSsh);
      expect(
        resolveSshCodexCatalogHostId({ remoteHostId }) !== null,
        `draft catalog disagreement for ${remoteHostId}`,
      ).toBe(mainSaysSsh);
    }
  });
});
