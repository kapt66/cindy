// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 三分支 resolver 的行为在这里钉:tab → 插件页宿主(回调),docked → 上游右侧栏页签,
// modal → Modal 宿主。偏好读取用真实 store(见下方 mock 的 resolver 实现)。
const presentation = vi.hoisted(() => ({ modal: false }));

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

const openPluginInSidebar = vi.hoisted(() =>
  vi.fn(async (_ghost: unknown, _view?: string): Promise<void> => undefined),
);
vi.mock('@/features/right-sidebar/pluginPlacement', () => ({
  openPluginInSidebar: (ghost: unknown, view?: string) => openPluginInSidebar(ghost, view),
}));

import type { NavigateFunction } from 'react-router-dom';

import type { InstalledGhost } from '../../../../shared/ghost';
import { useGhostPanelLauncher, type GhostPanelLauncher } from '../useGhostPanelLauncher';

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
  navigateMock = vi.fn();
  openPageHostMock = vi.fn();
  openPluginInSidebar.mockClear();
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

    await act(async () => {
      await launcher.openPanel('meka-p4', document.createElement('button'));
    });

    expect(requestAnimationFrame).not.toHaveBeenCalled();
    expect(openPluginInSidebar).toHaveBeenCalledTimes(1);
    expect(openPluginInSidebar.mock.calls[0]?.[1]).toBe('panel');
    expect(navigateMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('plugin-panel-modal-host')).toBeNull();
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

    await act(async () => {
      await launcher.openPanel('tab-plugin', document.createElement('button'));
    });

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
