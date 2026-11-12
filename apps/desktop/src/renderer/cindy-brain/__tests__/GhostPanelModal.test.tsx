// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../ghostPanelBody', () => ({
  GhostChipPanelBody: ({ autoFocusWebview }: { autoFocusWebview?: boolean }) => (
    <div
      data-testid="shared-plugin-panel-body"
      data-auto-focus-webview={String(Boolean(autoFocusWebview))}
    />
  ),
  GhostPanelError: () => <div data-testid="plugin-panel-error" />,
}));

vi.mock('../runtimeStates', () => ({
  useGhostRuntimeState: () => 'running',
}));

import {
  __resetGhostPanelPresentationPreferenceForTest,
  setGhostPanelModalPresentationEnabled,
  setGhostPanelPresentationOverride,
} from '@/lib/ghostPanelPresentationPreference';

import type { InstalledGhost } from '../../../shared/ghost';
import { GhostPanelModal } from '../GhostPanelModal';

const ghost: InstalledGhost = {
  enabled: true,
  dir: '/fake/modal-plugin',
  approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
  manifest: {
    schemaVersion: 2,
    id: 'modal-plugin',
    name: 'Modal Plugin',
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    slots: ['panel'],
    panel: {
      title: 'Modal Plugin UI',
      html: 'panel.html',
      allowUserPresentationOverride: true,
    },
  },
};

beforeEach(() => {
  window.localStorage.clear();
  __resetGhostPanelPresentationPreferenceForTest();
  // 护栏(T8)只在有效呈现 = modal 时渲染宿主:走真实偏好路径打开,不加测试专用 prop。
  setGhostPanelModalPresentationEnabled(true);
});

afterEach(() => {
  cleanup();
  __resetGhostPanelPresentationPreferenceForTest();
});

describe('GhostPanelModal', () => {
  it('reuses the Plugin panel body inside a 90% viewport modal', () => {
    render(<GhostPanelModal ghost={ghost} open onOpenChange={vi.fn()} />);

    const modal = screen.getByTestId('ghost-panel-modal');
    const header = screen.getByTestId('ghost-panel-modal-header');
    expect(modal.className).toContain('h-[90vh]');
    expect(modal.className).toContain('w-[90vw]');
    expect(header.className).toContain('cursor-default');
    expect(screen.getByRole('heading', { name: 'Modal Plugin UI' })).toBeTruthy();
    expect(screen.getByTestId('shared-plugin-panel-body').dataset.autoFocusWebview).toBe('true');
    expect(screen.getByRole('button', { name: 'settings.ghosts.detail.closePanel' })).toBeTruthy();
  });

  it('keeps the panel body mounted while the modal is closed', () => {
    const { rerender } = render(<GhostPanelModal ghost={ghost} open onOpenChange={vi.fn()} />);
    const body = screen.getByTestId('shared-plugin-panel-body');

    rerender(<GhostPanelModal ghost={ghost} open={false} onOpenChange={vi.fn()} />);

    expect(screen.getByTestId('shared-plugin-panel-body')).toBe(body);
    expect(screen.getByTestId('shared-plugin-panel-body').dataset.autoFocusWebview).toBe('false');
    expect(screen.getByTestId('ghost-panel-modal').className).toContain(
      'data-[state=closed]:invisible',
    );
  });

  // T8:I1 的第三道保险 —— 呈现方式切回 docked 时组件自卸载(webview 一并卸载),
  // 不允许与页签宿主并存(两个 webview 会各存整份插件数据并互相覆写)。
  it('unmounts itself once the effective presentation is no longer modal', () => {
    const { rerender } = render(<GhostPanelModal ghost={ghost} open onOpenChange={vi.fn()} />);
    expect(screen.getByTestId('ghost-panel-modal')).toBeTruthy();

    act(() => setGhostPanelPresentationOverride('modal-plugin', 'docked'));
    rerender(<GhostPanelModal ghost={ghost} open onOpenChange={vi.fn()} />);

    expect(screen.queryByTestId('ghost-panel-modal')).toBeNull();
    expect(screen.queryByTestId('shared-plugin-panel-body')).toBeNull();
  });

  // 停用的插件不得继续挂 Modal 宿主(停用即释放面板实例)。
  it('unmounts itself when the Plugin is disabled', () => {
    render(
      <GhostPanelModal ghost={{ ...ghost, enabled: false }} open onOpenChange={vi.fn()} />,
    );
    expect(screen.queryByTestId('ghost-panel-modal')).toBeNull();
  });

  // `position:'tab'` 由 manifest 固定:即使全局开关打开也不得开 Modal(Q-B① 不回 Modal 兜底)。
  it('never renders for tab-form panels', () => {
    const tabGhost: InstalledGhost = {
      ...ghost,
      manifest: { ...ghost.manifest, panel: { html: 'panel.html', position: 'tab' } },
    };
    render(<GhostPanelModal ghost={tabGhost} open onOpenChange={vi.fn()} />);
    expect(screen.queryByTestId('ghost-panel-modal')).toBeNull();
  });
});
