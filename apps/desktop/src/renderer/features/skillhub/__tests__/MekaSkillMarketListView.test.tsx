/** @vitest-environment jsdom */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { snapshot, files, file, install, refreshSkillhub } = vi.hoisted(() => ({
  snapshot: vi.fn(),
  files: vi.fn(),
  file: vi.fn(),
  install: vi.fn(),
  refreshSkillhub: vi.fn(),
}));

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, options?: { error?: string }) =>
        ({
          'skillhub.market.searchPlaceholder': 'Search Skill Hub',
          'skillhub.market.sortTrending': 'Trending',
          'skillhub.market.sortDownloads': 'Downloads',
          'skillhub.market.sortLatest': 'Latest',
          'skillhub.market.sortCreated': 'Created',
          'skillhub.market.chipAvailable': 'Available',
          'skillhub.market.chipAll': 'All',
          'skillhub.market.chipMine': 'Mine',
          'skillhub.market.loading': 'Loading',
          'skillhub.market.noResults': 'No results',
          'skillhub.market.loadFailed': `Load failed: ${options?.error ?? ''}`,
          'skillhub.sidebar.backToLocal': 'Back to local skills',
          'skillhub.marketCard.relativeTime.justNow': 'just now',
          'mekaSkills.sourceMeka': 'MCPRouter',
          'mekaSkills.loadFailed': 'Could not load catalog',
          'mekaSkills.installUnavailable': 'Skill unavailable',
          'mekaSkills.serverUpgradeRequired': 'MCPRouter upgrade required',
          'mekaSkills.unavailable': 'MCPRouter unavailable',
        })[key] ?? key,
      i18n: { language: 'en', resolvedLanguage: 'en' },
    }),
  };
});
vi.mock('../hooks/useSkillhub', () => ({ refresh: refreshSkillhub }));
vi.mock('../components/MarketCard', () => ({
  MarketCard: ({
    skill,
    onClick,
    onClone,
    onManage,
    primaryAction,
  }: {
    skill: { name: string; displayName: string };
    onClick?: (skill: { name: string; displayName: string }) => void;
    onClone: (skill: { name: string; displayName: string }) => void;
    onManage?: (skill: { name: string; displayName: string }) => void;
    primaryAction: string;
  }) => (
    <article>
      <button type="button" onClick={() => onClick?.(skill)}>
        {skill.displayName}
      </button>
      {primaryAction === 'clone' ? (
        <button type="button" onClick={() => onClone(skill)}>
          Clone {skill.displayName}
        </button>
      ) : null}
      {primaryAction === 'manage' ? (
        <button type="button" onClick={() => onManage?.(skill)}>
          Manage {skill.displayName}
        </button>
      ) : null}
    </article>
  ),
}));
vi.mock('../components/MekaSkillManagementDialog', () => ({
  MekaSkillManagementDialog: ({
    open,
    skill,
  }: {
    open: boolean;
    skill: { name: string } | null;
  }) => (open && skill ? <div role="dialog">Managing {skill.name}</div> : null),
}));
vi.mock('../components/MekaSkillPublishDialog', () => ({
  MekaSkillPublishDialog: () => null,
}));
vi.mock('../SkillhubMarketPreviewPanel', () => ({
  SkillhubMarketPreviewPanel: ({
    open,
    skill,
    onClone,
    onManage,
  }: {
    open: boolean;
    skill: { name: string; displayName: string; isMine: boolean } | null;
    onClone?: (skill: { name: string; displayName: string; isMine: boolean }) => void;
    onManage?: (skill: { name: string; displayName: string; isMine: boolean }) => void;
  }) =>
    open && skill ? (
      <div role="dialog" aria-label="Meka Skill preview">
        <button type="button" onClick={() => onClone?.(skill)}>
          Install from preview
        </button>
        {skill.isMine && onManage ? (
          <button type="button" onClick={() => onManage(skill)}>
            Manage from preview
          </button>
        ) : null}
      </div>
    ) : null,
}));
vi.mock('../components/InstallTargetPicker', () => ({
  InstallTargetPicker: ({
    open,
    skill,
    installSkill,
    onInstallComplete,
  }: {
    open: boolean;
    skill: { name: string } | null;
    installSkill?: (request: { name: string }) => Promise<{ success: boolean }>;
    onInstallComplete: () => void;
  }) =>
    open && skill ? (
      <button
        type="button"
        onClick={async () => {
          const result = await installSkill?.({ name: skill.name });
          if (result?.success) onInstallComplete();
        }}
      >
        Install globally
      </button>
    ) : null,
}));

import { MekaSkillMarketListView } from '../MekaSkillMarketListView';

const publicSkill = {
  id: 'skill-public',
  slug: 'release-notes',
  name: 'Release notes',
  description: 'Prepare release notes',
  scope: 'public' as const,
  access: 'public' as const,
  currentRelease: {
    id: 'release-public',
    version: '1.0.0',
    sha256: 'a'.repeat(64),
    sizeBytes: 100,
    uncompressedSizeBytes: 200,
    publishedAt: '2026-07-31T00:00:00.000Z',
  },
  installed: false,
  updateAvailable: false,
};
const ownedInstalledSkill = {
  ...publicSkill,
  id: 'skill-owned',
  slug: 'owned-skill',
  name: 'Owned skill',
  access: 'owner' as const,
  scope: 'personal' as const,
  currentRelease: { ...publicSkill.currentRelease, id: 'release-owned' },
  installed: true,
  installedPath: 'C:\\skills\\owned-skill',
};

beforeEach(() => {
  vi.clearAllMocks();
  snapshot.mockResolvedValue({
    configured: true,
    items: [publicSkill, ownedInstalledSkill],
  });
  files.mockResolvedValue([]);
  file.mockResolvedValue({});
  install.mockResolvedValue({ success: true, absolutePath: 'C:\\skills\\release-notes' });
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { mekaSkills: { snapshot, files, file, install } },
  });
});

describe('MekaSkillMarketListView', () => {
  it('uses the Cindy Skill Hub filters with the MCPRouter catalog and installer', async () => {
    render(
      <MemoryRouter initialEntries={['/cc-agent/meka/skills/market']}>
        <MekaSkillMarketListView />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('button', { name: 'Release notes' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Owned skill' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(await screen.findByRole('button', { name: 'Owned skill' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Mine' }));
    expect(screen.queryByRole('button', { name: 'Release notes' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Owned skill' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Owned skill' }));
    expect(screen.getByRole('button', { name: 'Install from preview' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Manage from preview' }));
    expect(screen.getByText('Managing Owned skill')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Available' }));
    fireEvent.click(screen.getByRole('button', { name: 'Release notes' }));
    expect(screen.queryByRole('button', { name: 'Manage from preview' })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Install from preview' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Install globally' }));

    await waitFor(() =>
      expect(install).toHaveBeenCalledWith({
        skillId: 'skill-public',
        expectedReleaseId: 'release-public',
      }),
    );
    expect(refreshSkillhub).toHaveBeenCalledOnce();
  });

  it('shows the MCPRouter upgrade requirement inside Meka Skill Hub', async () => {
    snapshot.mockResolvedValue({
      configured: false,
      unavailableReason: 'registry-not-supported',
      items: [],
    });

    render(
      <MemoryRouter initialEntries={['/cc-agent/meka/skills/market']}>
        <MekaSkillMarketListView />
      </MemoryRouter>,
    );

    expect(await screen.findByText('MCPRouter upgrade required')).toBeTruthy();
  });
});
