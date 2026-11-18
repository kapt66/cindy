// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 三分支 resolver 的行为在这里钉:tab → 插件页宿主(回调),docked → 上游右侧栏页签,
// modal → Modal 宿主。偏好读取用真实 store(见下方 mock 的 resolver 实现)。
const presentation = vi.hoisted(() => ({ modal: false }));

// docked 分支的成败由右侧栏真实状态决定:launcher 会回查页签是否真的建了出来
// (`addGlobalPluginTab` 在全局页签达到上限时返回 null,`openPluginInSidebar` 静默返回)。
const placement = vi.hoisted(() => ({
  /** 模拟 addGlobalPluginTab 是否建出了页签。 */
  tabCreated: true,
  /** 模拟打开右侧栏链路上的抛错(布局树/交回窗口失败)。 */
  throwOnOpen: false,
  /** `findGlobalTabByInstance` 的返回表:opener 成功时才登记。 */
  tabs: new Map<string, { id: string }>(),
}));

vi.mock('@/cindy-brain/GhostPanelModal', () => ({
  GhostPanelModal: ({ ghost, open }: { ghost: { manifest: { id: string } }; open: boolean }) => (
    <div
      data-testid="plugin-panel-modal-host"
      data-ghost-id={ghost.manifest.id}
      data-open={String(open)}
    />
  ),
}));

vi.mock('@/lib/ghostPanelPresentationPreference', () => ({
  resolveGhostPanelPresentation: (ghost: { manifest: { panel?: { position?: string } } }) =>
    ghost.manifest.panel?.position === 'tab' ? 'docked' : presentation.modal ? 'modal' : 'docked',
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

import type { NavigateFunction } from 'react-router-dom';

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
let frames: Map<number, FrameRequestCallback>;
let nextFrameId: number;
let navigateMock: ReturnType<typeof vi.fn>;
let openPageHostMock: ReturnType<typeof vi.fn>;

function Harness({ ghosts }: { ghosts: InstalledGhost[] }) {
  launcher = useGhostPanelLauncher({
    ghosts,
    navigate: navigateMock as unknown as NavigateFunction,
    openPageHost: openPageHostMock,
  });
  return <>{launcher.modalHost}</>;
}

beforeEach(() => {
  presentation.modal = false;
  placement.tabCreated = true;
  placement.throwOnOpen = false;
  placement.tabs.clear();
  navigateMock = vi.fn();
  openPageHostMock = vi.fn();
  openPluginInSidebar.mockReset().mockImplementation(async (ghost: unknown) => {
    if (placement.throwOnOpen) throw new Error('sidebar layout tree unavailable');
    // 真实 opener 的分支:全局页签达到上限时 `addGlobalPluginTab` 返回 null、它静默返回;
    // 成功时页签真的进了 store。
    if (placement.tabCreated) {
      placement.tabs.set(installedGhostStoragePart(ghost as InstalledGhost), { id: 'global-tab' });
    }
  });
  frames = new Map();
  nextFrameId = 0;
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => {
      const id = ++nextFrameId;
      frames.set(id, callback);
      return id;
    }),
  );
  vi.stubGlobal(
    'cancelAnimationFrame',
    vi.fn((id: number) => {
      frames.delete(id);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useGhostPanelLauncher', () => {
  it('mounts the modal target closed before opening it on the next frame', async () => {
    presentation.modal = true;
    render(<Harness ghosts={[ghost('meka-p4')]} />);
    const trigger = document.createElement('button');

    await act(async () => {
      await launcher.openPanel('meka-p4', trigger);
    });

    expect(screen.getByTestId('plugin-panel-modal-host').dataset).toMatchObject({
      ghostId: 'meka-p4',
      open: 'false',
    });
    expect(frames.size).toBe(1);

    act(() => frames.get(1)?.(0));

    expect(screen.getByTestId('plugin-panel-modal-host').dataset.open).toBe('true');
  });

  it('cancels an older launch when another entry point selects a new target', async () => {
    presentation.modal = true;
    render(<Harness ghosts={[ghost('first-plugin'), ghost('second-plugin')]} />);

    await act(async () => {
      await launcher.openPanel('first-plugin', document.createElement('button'));
      await launcher.openPanel('second-plugin', document.createElement('button'));
    });

    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(screen.getByTestId('plugin-panel-modal-host').dataset).toMatchObject({
      ghostId: 'second-plugin',
      open: 'false',
    });

    act(() => frames.get(2)?.(0));
    expect(screen.getByTestId('plugin-panel-modal-host').dataset.open).toBe('true');
  });

  it('reset cancels a pending open and removes the shared host', async () => {
    presentation.modal = true;
    render(<Harness ghosts={[ghost('meka-p4')]} />);
    await act(async () => {
      await launcher.openPanel('meka-p4', document.createElement('button'));
    });

    act(() => launcher.resetPanelModal());

    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(screen.queryByTestId('plugin-panel-modal-host')).toBeNull();
  });

  it('resolves the physical instance key of a new-layout root install', async () => {
    presentation.modal = true;
    render(<Harness ghosts={[rootInstance('meka-p4')]} />);

    await act(async () => {
      await launcher.openPanel('_root__meka-p4', document.createElement('button'));
    });

    // 逻辑 id 与实例键不同：按 `manifest.id === id` 解析会找不到实例、面板静默不开。
    expect(screen.getByTestId('plugin-panel-modal-host').dataset).toMatchObject({
      ghostId: 'meka-p4',
      open: 'false',
    });

    act(() => frames.get(1)?.(0));
    expect(screen.getByTestId('plugin-panel-modal-host').dataset.open).toBe('true');
  });

  // 上游停靠路径:modal 未生效时不再写布局树、不再跳任务页,而是走右侧栏全局页签。
  it('opens the upstream right-sidebar tab for the docked presentation', async () => {
    render(<Harness ghosts={[ghost('meka-p4')]} />);

    let result: GhostPanelOpenResult | undefined;
    await act(async () => {
      result = await launcher.openPanel('meka-p4', document.createElement('button'));
    });

    expect(result).toBe('docked');
    expect(requestAnimationFrame).not.toHaveBeenCalled();
    expect(openPluginInSidebar).toHaveBeenCalledTimes(1);
    expect(openPluginInSidebar.mock.calls[0]?.[1]).toBe('panel');
    expect(navigateMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('plugin-panel-modal-host')).toBeNull();
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
      result = await launcher.openPanel('meka-p4', document.createElement('button'));
    });

    expect(openPluginInSidebar).toHaveBeenCalledTimes(1);
    expect(result).toBe('unavailable');
  });

  it('reports unavailable when the sidebar opener throws instead of swallowing it', async () => {
    placement.throwOnOpen = true;
    render(<Harness ghosts={[ghost('meka-p4')]} />);

    let result: GhostPanelOpenResult | undefined;
    await act(async () => {
      result = await launcher.openPanel('meka-p4', document.createElement('button'));
    });

    expect(result).toBe('unavailable');
  });

  // T9 深链无 trigger:触发元素可省略,Modal 分支仍按「先关后开」挂载。
  it('opens from a deep link without a trigger element', async () => {
    presentation.modal = true;
    render(<Harness ghosts={[ghost('meka-p4')]} />);

    await act(async () => {
      await launcher.openPanel('meka-p4');
    });

    expect(screen.getByTestId('plugin-panel-modal-host').dataset.open).toBe('false');
    act(() => frames.get(1)?.(0));
    expect(screen.getByTestId('plugin-panel-modal-host').dataset.open).toBe('true');
  });

  // tab 形态由 manifest 固定:不抢宿主,交给插件页里的 GhostPagePanelHost(Q-B①)。
  it('hands tab-form panels to the page host instead of opening a modal', async () => {
    presentation.modal = true;
    render(<Harness ghosts={[ghost('tab-plugin', 'tab')]} />);

    let result: GhostPanelOpenResult | undefined;
    await act(async () => {
      result = await launcher.openPanel('tab-plugin', document.createElement('button'));
    });

    expect(result).toBe('page');
    expect(openPageHostMock).toHaveBeenCalledWith('tab-plugin');
    expect(openPluginInSidebar).not.toHaveBeenCalled();
    expect(screen.queryByTestId('plugin-panel-modal-host')).toBeNull();
  });

  // 关闭全局页签后点入口:页签重建由 openPluginInSidebar 负责(清 dismissed)。
  it('rebuilds a dismissed docked tab through the sidebar opener', async () => {
    render(<Harness ghosts={[ghost('meka-p4')]} />);

    await act(async () => {
      await launcher.openPanel('meka-p4');
    });

    expect(openPluginInSidebar).toHaveBeenCalledTimes(1);
  });
});
