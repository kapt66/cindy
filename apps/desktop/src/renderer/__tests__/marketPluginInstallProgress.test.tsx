// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PluginMarketDetail } from '../../shared/pluginMarket';
import { MarketPluginDetailView } from '../features/plugin/MarketPluginDetailView';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.percent === undefined ? key : `${key}:${String(options.percent)}`,
  }),
}));

vi.mock('../features/plugin/GhostPluginIcon', () => ({
  GhostPluginIcon: () => <div data-testid="plugin-icon" />,
}));

afterEach(cleanup);

const detail: PluginMarketDetail = {
  pluginId: `c${'a'.repeat(24)}`,
  ghostId: 'meka-docs',
  name: 'Meka Docs',
  description: 'Documents',
  author: 'Meka',
  scope: 'public',
  organizationId: null,
  defaultInstall: false,
  releaseId: 'release-1',
  version: '1.0.0',
  publishedAt: '2026-07-30T00:00:00.000Z',
  icon: null,
  installState: 'not-installed',
  enabled: null,
  manifest: {
    schemaVersion: 2,
    id: 'meka-docs',
    name: 'Meka Docs',
    description: 'Documents',
    author: 'Meka',
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    slots: ['notify'],
  },
};

describe('MarketPluginDetailView install progress', () => {
  it('keeps the busy CTA emphasized and exposes byte percentage in its label and track', () => {
    const { container } = render(
      <MarketPluginDetailView
        detail={detail}
        busy
        progress={{
          operationId: '2b3fe88f-ef65-4389-a84c-62f626657e85',
          pluginId: detail.pluginId,
          phase: 'downloading',
          downloadedBytes: 37,
          totalBytes: 100,
        }}
        onBack={vi.fn()}
        onInstall={vi.fn()}
        onIconLoadError={vi.fn()}
      />,
    );

    const button = screen.getByRole('button', {
      name: 'settings.ghosts.market.downloading:37',
    });
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.classList.contains('opacity-40')).toBe(false);
    expect(
      container.querySelector<HTMLElement>('[style="width: 37%;"]'),
    ).not.toBeNull();
  });

  it('uses the updating phase for an installed release replacement', () => {
    render(
      <MarketPluginDetailView
        detail={{ ...detail, installState: 'update-available' }}
        busy
        progress={{
          operationId: '2b3fe88f-ef65-4389-a84c-62f626657e85',
          pluginId: detail.pluginId,
          phase: 'installing',
          downloadedBytes: 100,
          totalBytes: 100,
        }}
        onBack={vi.fn()}
        onInstall={vi.fn()}
        onIconLoadError={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('button', { name: 'settings.ghosts.market.updating' }),
    ).not.toBeNull();
  });
});
