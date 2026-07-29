// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/ghostContentRevision', () => ({
  useGhostContentRevision: () => 0,
}));

vi.mock('../ghostPanelTheme', () => ({
  createGhostThemeInjector: () => ({
    onDomReady: vi.fn(),
    inject: vi.fn(),
    dispose: vi.fn(),
  }),
  observeHostTheme: () => vi.fn(),
}));

import type { GhostManifest } from '../../../shared/ghost';
import { GhostChipPanelBody } from '../ghostPanelBody';

const manifest: GhostManifest = {
  schemaVersion: 2,
  id: 'focus-plugin',
  name: 'Focus Plugin',
  version: '1.0.0',
  kind: 'chip',
  entry: 'main.js',
  slots: ['panel'],
  panel: {
    title: 'Focus Plugin',
    html: 'panel.html',
  },
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderPanel(autoFocusWebview: boolean) {
  const focus = vi.fn();
  const originalCreateElement = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(
    ((tagName: string, options?: ElementCreationOptions) => {
      const element = originalCreateElement(tagName, options);
      if (tagName.toLowerCase() === 'webview') {
        Object.assign(element, { focus });
      }
      return element;
    }) as typeof document.createElement,
  );

  const view = render(
    <GhostChipPanelBody manifest={manifest} autoFocusWebview={autoFocusWebview} />,
  );
  const webview = view.container.querySelector('webview');
  if (!webview) throw new Error('Expected plugin panel webview');
  webview.dispatchEvent(new Event('dom-ready'));
  return focus;
}

describe('GhostChipPanelBody keyboard focus', () => {
  it('focuses the guest after dom-ready when hosted by a modal', () => {
    expect(renderPanel(true)).toHaveBeenCalledTimes(1);
  });

  it('does not steal focus for docked or tab panel hosts', () => {
    expect(renderPanel(false)).not.toHaveBeenCalled();
  });
});
