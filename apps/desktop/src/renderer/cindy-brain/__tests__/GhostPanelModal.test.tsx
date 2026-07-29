// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

import type { InstalledGhost } from '../../../shared/ghost';
import { GhostPanelModal } from '../GhostPanelModal';

const ghost: InstalledGhost = {
  enabled: true,
  dir: '/fake/modal-plugin',
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
    },
  },
};

afterEach(cleanup);

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
    expect(
      screen.getByRole('button', { name: 'settings.ghosts.detail.closePanel' }),
    ).toBeTruthy();
  });

  it('keeps the panel body mounted while the modal is closed', () => {
    const { rerender } = render(
      <GhostPanelModal ghost={ghost} open onOpenChange={vi.fn()} />,
    );
    const body = screen.getByTestId('shared-plugin-panel-body');

    rerender(<GhostPanelModal ghost={ghost} open={false} onOpenChange={vi.fn()} />);

    expect(screen.getByTestId('shared-plugin-panel-body')).toBe(body);
    expect(screen.getByTestId('shared-plugin-panel-body').dataset.autoFocusWebview).toBe('false');
    expect(screen.getByTestId('ghost-panel-modal').className).toContain(
      'data-[state=closed]:invisible',
    );
  });
});
