// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 呈现方式完全跟随上游 manifest:tab → 插件页宿主(回调),其余停靠形态 → 右侧栏全局页签。
// 这里钉住 launcher 的两个真实分支与「没开成」的如实返回。
const placement = vi.hoisted(() => ({
  /** 模拟 addGlobalPluginTab 是否建出了页签。 */
  tabCreated: true,
  /** 模拟打开右侧栏链路上的抛错(布局树/交回窗口失败)。 */
  throwOnOpen: false,
  /** `findGlobalTabByInstance` 的返回表:opener 成功时才登记。 */
  tabs: new Map<string, { id: string }>(),
}));

vi.mock('@/features/right-sidebar/globalTabs', () => ({
  findGlobalTabByInstance: (instanceId: string) => placement.tabs.get(instanceId) ?? null,
}));

const openPluginInSidebar = vi.hoisted(() =>
  vi.fn(async (_ghost: unknown, _view?: string): Promise<void> => undefined),
);
vi.mock('@/features/right-sidebar/pluginPlacement', () => ({
  openPluginInSidebar: (ghost: unknown, view?: string) => openPluginInSidebar(ghost, view),
}));

import type { InstalledGhost } from '../../../../shared/ghost';
import { installedGhostStoragePart } from '../../../../shared/pluginIdentity';
import { useGhostPanelLauncher, type GhostPanelLauncher, type GhostPanelOpenResult } from '../useGhostPanelLauncher';

const ghost = (id: string, position: 'left' | 'tab' = 'left'): InstalledGhost => ({
  enabled: true,
  dir: `/plugins/${id}`,
  approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
  manifest: {
    schemaVersion: 2,
    id,
    name: id,
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    slots: ['panel'],
    panel: {
      title: id,
      html: 'panel.html',
      position,
    },
  },
});

/**
 * namespace 隔离后的新布局 root 安装：目录是 `_ns/_root/<id>`、实例键是 `_root__<id>`，
 * 与逻辑插件 id 不同。入口一律传实例键，启动器必须按实例解析。
 */
const rootInstance = (id: string): InstalledGhost => ({
  ...ghost(id),
  dir: `/brain/_ns/_root/${id}`,
  instanceKey: `_root__${id}`,
  namespace: null,
  namespaceState: 'confirmed',
});

let launcher: GhostPanelLauncher;
let openPageHostMock: ReturnType<typeof vi.fn>;

function Harness({ ghosts }: { ghosts: InstalledGhost[] }) {
  launcher = useGhostPanelLauncher({
    ghosts,
    openPageHost: openPageHostMock,
  });
  return null;
}

beforeEach(() => {
  placement.tabCreated = true;
  placement.throwOnOpen = false;
  placement.tabs.clear();
  openPageHostMock = vi.fn();
  openPluginInSidebar.mockReset().mockImplementation(async (ghost: unknown) => {
    if (placement.throwOnOpen) throw new Error('sidebar layout tree unavailable');
    // 真实 opener 的分支:全局页签达到上限时 `addGlobalPluginTab` 返回 null、它静默返回;
    // 成功时页签真的进了 store。
    if (placement.tabCreated) {
      placement.tabs.set(installedGhostStoragePart(ghost as InstalledGhost), { id: 'global-tab' });
    }
  });
});

afterEach(() => {
  cleanup();
});

describe('useGhostPanelLauncher', () => {
  // 上游停靠路径:不写布局树、不跳任务页,而是走右侧栏全局页签。
  it('opens the upstream right-sidebar tab for a docked panel', async () => {
    render(<Harness ghosts={[ghost('meka-p4')]} />);

    let result: GhostPanelOpenResult | undefined;
    await act(async () => {
      result = await launcher.openPanel('meka-p4');
    });

    expect(result).toBe('docked');
    expect(openPluginInSidebar).toHaveBeenCalledTimes(1);
    expect(openPluginInSidebar.mock.calls[0]?.[1]).toBe('panel');
  });

  /*
   * 测试价值
   * - 生产入口与可观察结果:`addGlobalPluginTab` 达到全局页签上限时返回 null,
   *   `openPluginInSidebar` 会静默 return(不抛错)。以前 launcher 用
   *   `.catch(() => undefined)` 把整条链路当成功,详情页「使用面板」点下去什么都不会发生。
   *   现在必须回查页签是否存在,并把「没开成」如实返回给调用方。
   * - Bug／规则依据:产品方案 A(2026-11-18)——面板型插件的主 CTA 必须给出明确反馈,
   *   静默失败比没有入口更糟。
   * - 现有覆盖缺口:原有 docked 用例只断言 opener 被调用,没有断言结果。
   * - 最小失败输入:opener 不建页签(页签上限)/ opener 抛错。
   * - tier:unit(jsdom hook 渲染)。
   */
  it('reports unavailable when the docked tab could not be created', async () => {
    placement.tabCreated = false;
    render(<Harness ghosts={[ghost('meka-p4')]} />);

    let result: GhostPanelOpenResult | undefined;
    await act(async () => {
      result = await launcher.openPanel('meka-p4');
    });

    expect(openPluginInSidebar).toHaveBeenCalledTimes(1);
    expect(result).toBe('unavailable');
  });

  it('reports unavailable when the sidebar opener throws instead of swallowing it', async () => {
    placement.throwOnOpen = true;
    render(<Harness ghosts={[ghost('meka-p4')]} />);

    let result: GhostPanelOpenResult | undefined;
    await act(async () => {
      result = await launcher.openPanel('meka-p4');
    });

    expect(result).toBe('unavailable');
  });

  it('resolves the physical instance key of a new-layout root install', async () => {
    render(<Harness ghosts={[rootInstance('meka-p4')]} />);

    let result: GhostPanelOpenResult | undefined;
    await act(async () => {
      result = await launcher.openPanel('_root__meka-p4');
    });

    // 逻辑 id 与实例键不同：按 `manifest.id === id` 解析会找不到实例、面板静默不开。
    expect(result).toBe('docked');
    expect(openPluginInSidebar).toHaveBeenCalledTimes(1);
  });

  // tab 形态由 manifest 固定:不抢宿主,交给插件页里的 GhostPagePanelHost。
  it('hands tab-form panels to the page host instead of opening a sidebar tab', async () => {
    render(<Harness ghosts={[ghost('tab-plugin', 'tab')]} />);

    let result: GhostPanelOpenResult | undefined;
    await act(async () => {
      result = await launcher.openPanel('tab-plugin');
    });

    expect(result).toBe('page');
    expect(openPageHostMock).toHaveBeenCalledWith('tab-plugin');
    expect(openPluginInSidebar).not.toHaveBeenCalled();
  });
});
