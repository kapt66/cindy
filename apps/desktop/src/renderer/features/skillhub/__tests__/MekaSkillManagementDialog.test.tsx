/** @vitest-environment jsdom */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  managementInfo,
  updateAccess,
  deletePublished,
  pickSource,
  toastSuccess,
  toastError,
  translate,
} = vi.hoisted(() => ({
  managementInfo: vi.fn(),
  updateAccess: vi.fn(),
  deletePublished: vi.fn(),
  pickSource: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  translate: (key: string, options?: { name?: string; version?: string }) =>
    ({
      'mekaSkills.manageTitle': `Manage ${options?.name ?? ''}`,
      'mekaSkills.manageDescription': 'Manage locally',
      'mekaSkills.close': 'Close',
      'mekaSkills.managementLoadFailed': 'Load failed',
      'mekaSkills.retry': 'Retry',
      'mekaSkills.publishUpdate': 'Publish new version',
      'mekaSkills.publishUpdateDescription': `Current ${options?.version ?? ''}`,
      'mekaSkills.visibility': 'Access',
      'mekaSkills.accessDescription': 'Choose access',
      'mekaSkills.private': 'Only me',
      'mekaSkills.sharedVisibility': 'Selected users',
      'mekaSkills.publicVisibility': 'Public',
      'mekaSkills.sharedUsers': 'Shared users',
      'mekaSkills.sharedUsersPlaceholder': 'Usernames',
      'mekaSkills.sharedUsersRequired': 'Required',
      'mekaSkills.saveAccess': 'Save access',
      'mekaSkills.accessSuccess': 'Access updated',
      'mekaSkills.accessFailed': 'Access failed',
      'mekaSkills.deletePublish': 'Delete publication',
      'mekaSkills.deleteWarning': `Delete ${options?.name ?? ''}?`,
      'mekaSkills.deleteConfirm': 'Delete now',
      'mekaSkills.deleteSuccess': 'Deleted',
      'mekaSkills.deleteFailed': 'Delete failed',
      'mekaSkills.cancel': 'Cancel',
    })[key] ?? key,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: translate,
  }),
}));
vi.mock('@/lib/toast', () => ({
  toast: { success: toastSuccess, error: toastError },
}));

import { MekaSkillManagementDialog } from '../components/MekaSkillManagementDialog';

const skill = {
  id: 'skill-resource',
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
  managementInfo.mockResolvedValue({
    skillResourceId: 'skill-resource',
    slug: 'release-notes',
    name: 'Release notes',
    currentReleaseId: 'release-1',
    currentVersion: '1.0.0',
    visibility: 'private',
    sharedUsernames: [],
  });
  updateAccess.mockImplementation(async (request) => ({
    skillResourceId: 'skill-resource',
    slug: 'release-notes',
    name: 'Release notes',
    currentReleaseId: 'release-1',
    currentVersion: '1.0.0',
    visibility: request.visibility,
    sharedUsernames: request.sharedUsernames,
  }));
  deletePublished.mockResolvedValue({ ok: true });
  pickSource.mockResolvedValue(null);
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { mekaSkills: { managementInfo, updateAccess, deletePublished, pickSource } },
  });
});

describe('MekaSkillManagementDialog', () => {
  it('saves exact-user access and deletes only after inline confirmation', async () => {
    const onChanged = vi.fn();
    const onDeleted = vi.fn();
    const onOpenChange = vi.fn();
    let resolvePickSource: ((value: null) => void) | undefined;
    pickSource.mockImplementation(
      () =>
        new Promise<null>((resolve) => {
          resolvePickSource = resolve;
        }),
    );
    render(
      <MekaSkillManagementDialog
        open
        skill={skill}
        onOpenChange={onOpenChange}
        onChanged={onChanged}
        onDeleted={onDeleted}
      />,
    );

    expect(await screen.findByRole('heading', { name: 'Manage Release notes' })).toBeTruthy();
    const publishButton = screen.getByRole('button', { name: 'Publish new version' });
    fireEvent.click(publishButton);
    expect(publishButton).toHaveProperty('disabled', true);
    fireEvent.click(publishButton);
    expect(pickSource).toHaveBeenCalledOnce();
    resolvePickSource?.(null);
    await waitFor(() => expect(publishButton).toHaveProperty('disabled', false));
    expect(screen.queryByText('Remote only')).toBeNull();

    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'shared' } });
    fireEvent.change(await screen.findByPlaceholderText('Usernames'), {
      target: { value: 'alice, bob\nalice' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save access' }));

    await waitFor(() =>
      expect(updateAccess).toHaveBeenCalledWith({
        skillId: 'skill-resource',
        expectedCurrentReleaseId: 'release-1',
        visibility: 'shared',
        sharedUsernames: ['alice', 'bob'],
      }),
    );
    expect(onChanged).toHaveBeenCalledOnce();

    const deleteButton = screen.getByRole('button', { name: 'Delete publication' });
    expect(deleteButton.parentElement?.className).toContain('justify-end');
    fireEvent.click(deleteButton);
    expect(deletePublished).not.toHaveBeenCalled();
    const deleteConfirmButton = screen.getByRole('button', { name: 'Delete now' });
    expect(deleteConfirmButton.parentElement?.className).toContain('justify-end');
    fireEvent.click(deleteConfirmButton);

    await waitFor(() =>
      expect(deletePublished).toHaveBeenCalledWith({
        skillId: 'skill-resource',
        expectedCurrentReleaseId: 'release-1',
      }),
    );
    expect(onDeleted).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
