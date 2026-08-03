/**
 * MCPRouter adapter coverage for the Cindy Skill home presentation.
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  snapshot,
  files,
  file,
  install,
  pickSource,
  publishSource,
  refreshSkillhub,
  plainTextToTiptapDoc,
  saveComposerDraft,
  patchDraft,
  skillhubState,
} = vi.hoisted(() => ({
  snapshot: vi.fn(),
  files: vi.fn(),
  file: vi.fn(),
  install: vi.fn(),
  pickSource: vi.fn(),
  publishSource: vi.fn(),
  refreshSkillhub: vi.fn(),
  plainTextToTiptapDoc: vi.fn(() => ({ type: 'doc', content: [] })),
  saveComposerDraft: vi.fn(),
  patchDraft: vi.fn(),
  skillhubState: {
    skills: [] as SkillhubSkill[],
    projects: [] as Array<{ projectRoot: string; displayName: string }>,
  },
}));

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string) =>
        ({
          'settings.ghosts.title': 'Plugins',
          'sidebar.tabs.projects': 'Projects',
          'sidebar.horizontalTabbarAria': 'Meka navigation',
          'skillhub.home.title': 'Skills',
          'skillhub.home.description': 'Manage local skills',
          'skillhub.home.search': 'Search skills',
          'skillhub.home.clearSearch': 'Clear skill search',
          'skillhub.home.recommended': 'Recommended',
          'skillhub.home.browseTitle': 'Browse Skill Hub',
          'skillhub.home.recommendedEmpty': 'No recommendations',
          'skillhub.home.local': 'Local skills',
          'skillhub.home.localEmpty': 'No local skills',
          'skillhub.home.globalScope': 'Global',
          'skillhub.home.sourceLocal': 'Local',
          'skillhub.home.sourceSkillhub': 'SkillHub',
          'skillhub.home.noSearchResults': 'No matching skills',
          'mekaSkills.description': 'Skills distributed by MCPRouter',
          'mekaSkills.add': 'Add skill',
          'mekaSkills.create': 'Create Meka Skill',
          'mekaSkills.publishDirectory': 'Publish folder',
          'mekaSkills.createPrompt': 'Create a Meka Skill',
          'mekaSkills.browseDescription': 'Discover MCPRouter skills',
          'mekaSkills.sourceMeka': 'MCPRouter',
          'mekaSkills.serverUpgradeRequired': 'MCPRouter upgrade required',
          'mekaSkills.serverUpgradeRequiredDescription': 'Deploy the Skill API',
          'mekaSkills.unavailable': 'MCPRouter unavailable',
          'mekaSkills.unavailableDescription': 'Check MCPRouter',
          'mekaSkills.loadFailed': 'Could not load catalog',
          'mekaSkills.installUnavailable': 'Skill unavailable',
          'mekaSkills.publishTitle': 'Publish Meka Skill',
          'mekaSkills.publishDescription': 'Review and publish through MCPRouter',
          'mekaSkills.selectDirectory': 'Select folder',
          'mekaSkills.changeDirectory': 'Change folder',
          'mekaSkills.directoryEmpty': 'Select a Skill folder',
          'mekaSkills.packageSummary': '2 files, 200 bytes',
          'mekaSkills.firstRelease': 'First release',
          'mekaSkills.publishVersion': 'Release version',
          'mekaSkills.versionDefaultHint': 'Starts at 1.0.0',
          'mekaSkills.versionIncrementHint': 'Patch incremented',
          'mekaSkills.versionInvalid': 'Invalid version',
          'mekaSkills.visibility': 'Visibility',
          'mekaSkills.private': 'Private',
          'mekaSkills.sharedVisibility': 'Shared',
          'mekaSkills.publicVisibility': 'Public',
          'mekaSkills.extraDescription': 'Additional description (optional)',
          'mekaSkills.extraDescriptionPlaceholder': 'Release notes',
          'mekaSkills.publish': 'Publish',
          'mekaSkills.cancel': 'Cancel',
          'mekaSkills.close': 'Close',
          'mekaSkills.publishSuccess': 'Published',
          'skillhub.marketCard.relativeTime.justNow': 'just now',
        })[key] ?? key,
    }),
  };
});

vi.mock('../hooks/useSkillhubProjectBootstrap', () => ({
  useSkillhubProjectBootstrap: vi.fn(),
}));
vi.mock('@/lib/composerDraftStore', () => ({
  plainTextToTiptapDoc,
  saveDraft: saveComposerDraft,
}));
vi.mock('@/state/newMakerDraft', () => ({ patchDraft }));
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('../hooks/useSkillhub', () => ({
  refresh: refreshSkillhub,
  useSkillhub: () => ({
    skills: skillhubState.skills,
    projects: skillhubState.projects,
    bootstrapped: true,
    syncResults: new Map(),
  }),
}));
vi.mock('../SkillhubMarketPreviewPanel', () => ({
  SkillhubMarketPreviewPanel: ({
    open,
    skill,
    onClone,
    onManage,
    loadFiles,
  }: {
    open: boolean;
    skill: { name: string; displayName: string; isMine: boolean } | null;
    onClone?: (skill: { name: string; displayName: string }) => void;
    onManage?: (skill: { name: string; displayName: string; isMine: boolean }) => void;
    loadFiles?: (skill: { name: string; displayName: string }) => Promise<unknown>;
  }) =>
    open && skill ? (
      <div role="dialog" aria-label="Skill preview">
        <span>{skill.displayName}</span>
        <button type="button" onClick={() => void loadFiles?.(skill)}>
          Load preview
        </button>
        <button type="button" onClick={() => onClone?.(skill)}>
          Clone
        </button>
        {skill.isMine && onManage ? (
          <button type="button" onClick={() => onManage(skill)}>
            Manage
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

import { MekaSkillHomeView } from '../MekaSkillHomeView';

const item = {
  id: 'skill-1',
  slug: 'release-notes',
  name: 'Release notes',
  description: 'Prepare release notes',
  scope: 'personal' as const,
  access: 'owner' as const,
  currentRelease: {
    id: 'release-1',
    version: '1.0.0',
    sha256: 'a'.repeat(64),
    sizeBytes: 100,
    uncompressedSizeBytes: 200,
    publishedAt: '2026-07-31T00:00:00.000Z',
  },
  installed: false,
  updateAvailable: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  skillhubState.skills = [];
  skillhubState.projects = [];
  snapshot.mockResolvedValue({ configured: true, items: [item] });
  files.mockResolvedValue([
    {
      path: 'SKILL.md',
      size: 100,
      language: 'markdown',
      truncated: false,
    },
  ]);
  file.mockResolvedValue({
    path: 'SKILL.md',
    size: 100,
    language: 'markdown',
    truncated: false,
    content: '# Release notes',
  });
  install.mockResolvedValue({ success: true, absolutePath: 'C:\\skills\\release-notes' });
  pickSource.mockResolvedValue(null);
  publishSource.mockResolvedValue({
    skillId: 'skill-1',
    version: '1.0.0',
    visibility: 'private',
    releasePublished: true,
  });
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      mekaSkills: { snapshot, files, file, install, pickSource, publishSource },
    },
  });
});

describe('MekaSkillHomeView', () => {
  it('keeps the Cindy Skill home hierarchy while sourcing recommendations from MCPRouter', async () => {
    render(
      <MemoryRouter initialEntries={['/cc-agent/meka/skills']}>
        <MekaSkillHomeView />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'Skills' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Browse Skill Hub/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add skill' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Recommended' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Local skills' })).toBeTruthy();

    const card = (await screen.findByText('Release notes')).closest('button');
    expect(card).toBeTruthy();
    fireEvent.click(card!);

    expect(await screen.findByRole('dialog', { name: 'Skill preview' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Clone' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Manage' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Load preview' }));
    await waitFor(() => expect(files).toHaveBeenCalledWith('skill-1'));

    fireEvent.click(screen.getByRole('button', { name: 'Clone' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Install globally' }));
    await waitFor(() => {
      expect(install).toHaveBeenCalledWith({
        skillId: 'skill-1',
        expectedReleaseId: 'release-1',
      });
    });
    expect(refreshSkillhub).toHaveBeenCalledOnce();
    expect(snapshot).toHaveBeenCalledTimes(2);
  });

  it('creates with Cindy or publishes a selected directory through MCPRouter', async () => {
    pickSource.mockResolvedValue({
      source: {
        sourceId: 'source-1',
        directoryPath: 'C:\\skills\\release-notes',
        name: 'release-notes',
        description: 'Prepare release notes',
        fileCount: 2,
        packageSizeBytes: 200,
      },
      suggestedVersion: '1.0.0',
      existing: null,
    });
    render(
      <MemoryRouter initialEntries={['/cc-agent/meka/skills']}>
        <MekaSkillHomeView />
      </MemoryRouter>,
    );

    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Add skill' }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByText('Create Meka Skill'));
    expect(saveComposerDraft).toHaveBeenCalledOnce();
    expect(patchDraft).toHaveBeenCalledOnce();

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Add skill' }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByText('Publish'));
    expect(await screen.findByRole('heading', { name: 'Publish Meka Skill' })).toBeTruthy();
    expect(pickSource).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Select folder' }));
    await waitFor(() => expect(pickSource).toHaveBeenCalledOnce());
    expect(await screen.findByText('C:\\skills\\release-notes')).toBeTruthy();
    const visibility = screen.getByLabelText('Visibility') as HTMLSelectElement;
    expect(screen.getByRole('option', { name: 'Shared' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Public' })).toBeTruthy();
    fireEvent.change(visibility, { target: { value: 'public' } });
    expect(visibility.value).toBe('public');
    fireEvent.change(visibility, { target: { value: 'private' } });
    fireEvent.change(screen.getByLabelText('Additional description (optional)'), {
      target: { value: 'First Meka release' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));

    await waitFor(() =>
      expect(publishSource).toHaveBeenCalledWith({
        sourceId: 'source-1',
        version: '1.0.0',
        extraDescription: 'First Meka release',
        visibility: 'private',
        sharedUsernames: [],
        expectedCurrentReleaseId: null,
      }),
    );
  });

  it('lists only local skills installed from the Meka channel', async () => {
    const baseSkill = {
      id: 'skill:global:release-notes',
      urlKey: 'skill/global/release-notes',
      engine: 'codex' as const,
      linkedEngines: [{ engine: 'codex' as const, label: 'Codex' }],
      kind: 'skill' as const,
      scope: 'global' as const,
      description: 'Prepare release notes',
      absolutePath: 'C:\\skills\\release-notes',
      mdPath: 'C:\\skills\\release-notes\\SKILL.md',
      files: [],
    };
    skillhubState.skills = [
      {
        ...baseSkill,
        name: 'release-notes',
        registryEntry: {
          version: '1.0.0',
          authorId: 'meka:skill-1',
          folderHash: 'hash',
          installedAt: 1,
          updatedAt: 1,
          origin: 'installed',
          distribution: {
            channel: 'meka',
            resourceId: 'skill-1',
            releaseId: 'release-1',
          },
        },
      },
      {
        ...baseSkill,
        id: 'skill:global:local-only',
        urlKey: 'skill/global/local-only',
        name: 'local-only',
        registryEntry: null,
      },
    ];

    render(
      <MemoryRouter initialEntries={['/cc-agent/meka/skills']}>
        <MekaSkillHomeView />
      </MemoryRouter>,
    );

    expect(await screen.findByText('release-notes')).toBeTruthy();
    expect(screen.queryByText('local-only')).toBeNull();
    expect(screen.getAllByText('MCPRouter').length).toBeGreaterThan(0);
  });

  it('shows the server-upgrade state in the shared recommendation section', async () => {
    snapshot.mockResolvedValue({
      configured: false,
      unavailableReason: 'registry-not-supported',
      items: [],
    });

    render(
      <MemoryRouter initialEntries={['/cc-agent/meka/skills']}>
        <MekaSkillHomeView />
      </MemoryRouter>,
    );

    expect(await screen.findByText('MCPRouter upgrade required')).toBeTruthy();
    expect(screen.getByText('Deploy the Skill API')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Recommended' })).toBeTruthy();
  });
});
