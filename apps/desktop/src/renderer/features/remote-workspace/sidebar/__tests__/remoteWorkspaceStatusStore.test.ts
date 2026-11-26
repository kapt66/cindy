// @vitest-environment jsdom

/**
 * 测试价值
 * - 生产入口与可观察结果：`remoteWorkspaceStatusStore`（侧栏会话行的状态缓存）在批量刷新 /
 *   推送 / 释放引用后的**可观察快照**：行快照的对象引用是否稳定（React 是否重渲染该行）、
 *   引用释放后是否通知订阅者（清空 publish）、TTL 节流是否真的阻止重复请求。
 * - Bug／规则依据：`remoteWorkspaceStatusStore.ts` 文件头（行快照稳定 = `SessionItem` 的
 *   memo 红线；一次 IPC 批量拉取，不逐行请求）；2026-11-26 独立审查三项：
 *   ① 手列 14 字段做逐字段比较（新增字段容易漏、与渲染无关的变化会整行重渲染）→ 改为行投影比较；
 *   ② TTL 与轮询间隔是同一个常量（轮询卡在边界上会被节流吞掉）→ 拆开；
 *   ③ 释放引用后清空缓存却**不 publish**，行上残留旧占用标签 → 清空后必须通知。
 * - 现有覆盖缺口：侧栏渲染测试只覆盖「有没有标签」，没钉住「哪些字段变化才替换引用」。
 * - 最小失败输入：只改 `sessionCount` / `webUrl`（不渲染）却替换了行快照；释放后不通知订阅者。
 * - tier：unit（jsdom + 内存 fake bridge，无网络/进程）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installPsbBridge, makePsbWorkspace, uninstallPsbBridge } from '../../__tests__/psbTestFixtures';
import {
  refreshRemoteWorkspaces,
  resolveRemoteWorkspaceForSession,
  retainRemoteWorkspaceStatus,
  resetRemoteWorkspaceStatusForTest,
  subscribeRemoteWorkspaceList,
} from '../remoteWorkspaceStatusStore';

const SESSION = {
  id: 'psb-session-1',
  remoteHostId: 'psb:psb-session-1',
  workingDir: '/psb-remote/saga2_design',
};

beforeEach(() => {
  resetRemoteWorkspaceStatusForTest();
});

afterEach(() => {
  vi.useRealTimers();
  resetRemoteWorkspaceStatusForTest();
  uninstallPsbBridge();
});

describe('remoteWorkspaceStatusStore：行投影比较', () => {
  it('只改不渲染的字段（sessionCount / webUrl）时保留旧对象引用，行不重渲染', async () => {
    const base = makePsbWorkspace();
    const bridge = installPsbBridge({
      refreshWorkspaces: vi.fn(async () => ({ workspaces: [base] })),
    });
    await refreshRemoteWorkspaces(true);
    const first = resolveRemoteWorkspaceForSession(SESSION);
    expect(first).not.toBeNull();

    bridge.refreshWorkspaces.mockResolvedValueOnce({
      workspaces: [
        {
          ...base,
          // 这些字段不进侧栏行（行只消费名称/状态/占用/目录等），变化不应替换行快照。
          sessionCount: 7,
          webUrl: 'https://psb.example/remote/workspaces/workspace-1',
          sessionsWebUrl: 'https://psb.example/remote/workspaces/workspace-1/sessions',
          clientPath: 'D:/moved',
        },
      ],
    });
    await refreshRemoteWorkspaces(true);
    expect(resolveRemoteWorkspaceForSession(SESSION)).toBe(first);
  });

  it('改渲染字段（占用）时替换为新快照', async () => {
    const base = makePsbWorkspace();
    const bridge = installPsbBridge({
      refreshWorkspaces: vi.fn(async () => ({ workspaces: [base] })),
    });
    await refreshRemoteWorkspaces(true);
    const first = resolveRemoteWorkspaceForSession(SESSION);

    bridge.refreshWorkspaces.mockResolvedValueOnce({
      workspaces: [
        makePsbWorkspace({
          occupancy: {
            occupied: true,
            byMe: false,
            personId: 'other',
            personName: '张三',
            occupiedAt: 9,
          },
        }),
      ],
    });
    await refreshRemoteWorkspaces(true);
    const next = resolveRemoteWorkspaceForSession(SESSION);
    expect(next).not.toBe(first);
    expect(next?.occupancy.personName).toBe('张三');
  });
});

describe('remoteWorkspaceStatusStore：TTL 节流与轮询节奏分开', () => {
  it('TTL 内重复 refresh（force=false）不再发请求；超过 TTL 才允许下一次', async () => {
    const bridge = installPsbBridge({
      refreshWorkspaces: vi.fn(async () => ({ workspaces: [makePsbWorkspace()] })),
    });
    vi.useFakeTimers();
    await refreshRemoteWorkspaces(true);
    expect(bridge.refreshWorkspaces).toHaveBeenCalledTimes(1);

    await refreshRemoteWorkspaces(false);
    await refreshRemoteWorkspaces(false);
    expect(bridge.refreshWorkspaces).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(12_000);
    await refreshRemoteWorkspaces(false);
    expect(bridge.refreshWorkspaces).toHaveBeenCalledTimes(2);
  });
});

describe('remoteWorkspaceStatusStore：引用释放', () => {
  it('释放引用后清空缓存并 publish（行上的占用标签必须消失）', async () => {
    installPsbBridge({
      refreshWorkspaces: vi.fn(async () => ({
        workspaces: [
          makePsbWorkspace({
            occupancy: {
              occupied: true,
              byMe: false,
              personId: 'other',
              personName: '张三',
              occupiedAt: 1,
            },
          }),
        ],
      })),
    });
    const release = retainRemoteWorkspaceStatus();
    await vi.waitFor(() => expect(resolveRemoteWorkspaceForSession(SESSION)).not.toBeNull());

    const listener = vi.fn();
    const unsubscribe = subscribeRemoteWorkspaceList(listener);
    release();
    // 清空即通知：订阅者（行上的 useSyncExternalStore）重新取快照 → 标签/锁消失。
    expect(listener).toHaveBeenCalled();
    expect(resolveRemoteWorkspaceForSession(SESSION)).toBeNull();
    unsubscribe();
  });
});
