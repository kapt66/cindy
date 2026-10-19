// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const presentation = vi.hoisted(() => ({ modal: true }));

vi.mock('@/cindy-brain/GhostPanelModal', () => ({
  GhostPanelModal: ({ ghost, open }: { ghost: { manifest: { id: string } }; open: boolean }) => (
    <div
      data-testid="plugin-panel-modal-host"
      data-ghost-id={ghost.manifest.id}
      data-open={String(open)}
    />
  ),
}));

vi.mock('@/lib/ghostPanelBubbleState', () => ({
  restoreGhostPanel: vi.fn(),
}));

vi.mock('@/lib/ghostPanelPresentationPreference', () => ({
  isGhostPanelModalPresentationEnabled: () => presentation.modal,
}));

import type { NavigateFunction } from 'react-router-dom';

import type { InstalledGhost } from '../../../../shared/ghost';
import { createDefaultLayout } from '../../../../shared/layoutTree';
import { useGhostPanelLauncher, type GhostPanelLauncher } from '../useGhostPanelLauncher';

const ghost = (id: string): InstalledGhost => ({
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
      position: 'left',
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
let layoutSetMock: ReturnType<typeof vi.fn>;
let setDetachedMock: ReturnType<typeof vi.fn>;

function Harness({ ghosts }: { ghosts: InstalledGhost[] }) {
  launcher = useGhostPanelLauncher({
    ghosts,
    navigate: navigateMock as unknown as NavigateFunction,
  });
  return <>{launcher.modalHost}</>;
}

beforeEach(() => {
  presentation.modal = true;
  navigateMock = vi.fn();
  layoutSetMock = vi.fn(async () => ({ ok: true }));
  setDetachedMock = vi.fn(async () => ({ ok: true }));
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
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      layout: {
        getStateSync: () => ({ layout: createDefaultLayout() }),
        set: layoutSetMock,
      },
      ghostPanelWindow: {
        setDetached: setDetachedMock,
      },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, 'electronAPI');
});

describe('useGhostPanelLauncher', () => {
  it('mounts the target closed before opening it on the next frame', async () => {
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
    render(<Harness ghosts={[ghost('meka-p4')]} />);
    await act(async () => {
      await launcher.openPanel('meka-p4', document.createElement('button'));
    });

    act(() => launcher.resetPanelModal());

    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(screen.queryByTestId('plugin-panel-modal-host')).toBeNull();
  });

  it('resolves the physical instance key of a new-layout root install', async () => {
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

  it('uses the same launcher for the inherited docked presentation', async () => {
    presentation.modal = false;
    render(<Harness ghosts={[ghost('meka-p4')]} />);

    await act(async () => {
      await launcher.openPanel('meka-p4', document.createElement('button'));
    });

    expect(requestAnimationFrame).not.toHaveBeenCalled();
    expect(layoutSetMock).toHaveBeenCalledTimes(1);
    expect(setDetachedMock).toHaveBeenCalledWith('meka-p4', false);
    expect(navigateMock).toHaveBeenCalledWith('/cc-agent/new');
    expect(screen.queryByTestId('plugin-panel-modal-host')).toBeNull();
  });
});
