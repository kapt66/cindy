/**
 * Regression coverage for signed Plugin icon failure and recovery.
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { GhostPluginIcon } from '../GhostPluginIcon';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => (key === 'settings.ghosts.meka.dev.ribbon' ? 'DEV' : key),
  }),
}));

describe('GhostPluginIcon', () => {
  it('renders a diagonal DEV ribbon only for development Plugin identities', () => {
    const { rerender } = render(
      <GhostPluginIcon iconId="meka-dev-demo" iconName="Demo" development />,
    );
    const ribbon = screen.getByTestId('plugin-dev-ribbon');
    expect(ribbon.textContent).toBe('DEV');
    expect(ribbon.className).toContain('-rotate-45');

    rerender(<GhostPluginIcon iconId="demo" iconName="Demo" />);
    expect(screen.queryByTestId('plugin-dev-ribbon')).toBeNull();
  });

  it('requests metadata renewal after a signed URL fails and accepts the replacement URL', () => {
    const onIconLoadError = vi.fn();
    const { container, rerender } = render(
      <GhostPluginIcon
        iconDataUrl="https://oss.example/old-icon?signature=old"
        iconId="cindy-github"
        iconName="Cindy GitHub"
        onIconLoadError={onIconLoadError}
      />,
    );

    fireEvent.error(container.querySelector('img')!);
    expect(onIconLoadError).toHaveBeenCalledTimes(1);
    expect(container.querySelector('img')).toBeNull();

    rerender(
      <GhostPluginIcon
        iconDataUrl="https://oss.example/new-icon?signature=new"
        iconId="cindy-github"
        iconName="Cindy GitHub"
        onIconLoadError={onIconLoadError}
      />,
    );
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'https://oss.example/new-icon?signature=new',
    );
  });
});
