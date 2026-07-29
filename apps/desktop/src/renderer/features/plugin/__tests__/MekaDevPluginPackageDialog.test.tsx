/**
 * Development Plugin package modal capability gating.
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { confirmMock } = vi.hoisted(() => ({
  confirmMock: vi.fn(async () => true),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: confirmMock }),
}));
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { MekaDevPluginPackageDialog } from '../MekaDevPluginPackageDialog';

const item = {
  runtimeId: 'meka-dev-demo-12345678',
  pluginId: 'demo-plugin',
  sourceDir: 'C:\\plugins\\demo',
  status: 'watching' as const,
};

describe('MekaDevPluginPackageDialog', () => {
  const getRouter = vi.fn();
  const connectRouter = vi.fn();
  const getUploadInfo = vi.fn();
  const packagePlugin = vi.fn();
  const uploadPlugin = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    confirmMock.mockResolvedValue(true);
    connectRouter.mockResolvedValue(undefined);
    packagePlugin.mockResolvedValue({ canceled: true });
    uploadPlugin.mockResolvedValue({
      pluginId: 'demo-plugin',
      version: '1.0.0',
      visibility: 'private',
      releasePublished: true,
    });
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        mekaSettings: { router: { get: getRouter, connect: connectRouter } },
        mekaDevPlugins: {
          package: packagePlugin,
          uploadInfo: getUploadInfo,
          upload: uploadPlugin,
        },
      },
    });
  });

  it('configures MCPRouter in place and keeps the package flow open for upload', async () => {
    getRouter
      .mockResolvedValueOnce({
        configured: false,
        routerUrl: null,
        defaultRouterUrl: 'https://router.example/',
        routerUsername: null,
      })
      .mockResolvedValue({
        configured: true,
        routerUrl: 'https://router.example/',
        defaultRouterUrl: 'https://router.example/',
        routerUsername: 'meka-user',
      });
    getUploadInfo.mockResolvedValue({
      pluginId: 'demo-plugin',
      version: '1.0.0',
      existing: null,
    });
    const onOpenChange = vi.fn();
    render(
      <MekaDevPluginPackageDialog
        item={item}
        pluginName="Demo"
        pluginVersion="1.0.0"
        open
        onOpenChange={onOpenChange}
        onUploaded={vi.fn()}
      />,
    );

    await screen.findByText('settings.ghosts.meka.dev.packageLocalOnly');
    expect(
      screen.getByRole('button', { name: 'settings.ghosts.meka.dev.packageLocal' }),
    ).toBeTruthy();
    expect(
      (
        screen.getByRole('button', {
          name: 'settings.ghosts.meka.dev.upload',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    fireEvent.click(
      screen.getByRole('button', { name: 'settings.ghosts.meka.dev.configureRouter' }),
    );
    await screen.findByText('settings.meka.router.dialogTitle');
    fireEvent.change(screen.getByLabelText('settings.meka.router.username'), {
      target: { value: 'meka-user' },
    });
    fireEvent.change(screen.getByLabelText('settings.meka.router.password'), {
      target: { value: 'secret' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'settings.meka.router.connect' }));

    await waitFor(() =>
      expect(connectRouter).toHaveBeenCalledWith({
        routerUrl: 'https://router.example/',
        username: 'meka-user',
        password: 'secret',
      }),
    );
    await waitFor(() =>
      expect(
        (
          screen.getByRole('button', {
            name: 'settings.ghosts.meka.dev.upload',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    expect(screen.getByTestId('meka-dev-plugin-package-dialog')).not.toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.meka.dev.upload' }));
    await waitFor(() =>
      expect(uploadPlugin).toHaveBeenCalledWith({
        id: item.runtimeId,
        visibility: 'private',
        sharedUsernames: [],
        expectedCurrentReleaseId: null,
      }),
    );
  });

  it('loads backend access and confirms publishing a newer version', async () => {
    getRouter.mockResolvedValue({ configured: true });
    getUploadInfo.mockResolvedValue({
      pluginId: 'demo-plugin',
      version: '2.0.0',
      existing: {
        pluginResourceId: 'plugin-resource',
        currentReleaseId: 'release-1',
        currentVersion: '1.0.0',
        visibility: 'shared',
        sharedUsernames: ['alice', 'bob'],
      },
    });
    uploadPlugin.mockResolvedValue({
      pluginId: 'demo-plugin',
      version: '2.0.0',
      visibility: 'shared',
      releasePublished: true,
    });
    const onUploaded = vi.fn();
    render(
      <MekaDevPluginPackageDialog
        item={item}
        pluginName="Demo"
        pluginVersion="2.0.0"
        open
        onOpenChange={vi.fn()}
        onUploaded={onUploaded}
      />,
    );

    const upload = await screen.findByRole('button', {
      name: 'settings.ghosts.meka.dev.upload',
    });
    fireEvent.click(upload);

    await waitFor(() =>
      expect(confirmMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'settings.ghosts.meka.dev.updateConfirmTitle',
        }),
      ),
    );
    await waitFor(() =>
      expect(uploadPlugin).toHaveBeenCalledWith({
        id: item.runtimeId,
        visibility: 'shared',
        sharedUsernames: ['alice', 'bob'],
        expectedCurrentReleaseId: 'release-1',
      }),
    );
    await waitFor(() => expect(onUploaded).toHaveBeenCalledTimes(1));
    expect(
      screen.queryByRole('button', { name: 'settings.ghosts.meka.dev.configureRouter' }),
    ).toBeNull();
  });

  it('treats an empty owned Plugin list as a first publish instead of a read failure', async () => {
    getRouter.mockResolvedValue({ configured: true });
    getUploadInfo.mockResolvedValue({
      pluginId: 'demo-plugin',
      version: '1.0.0',
      existing: null,
    });
    render(
      <MekaDevPluginPackageDialog
        item={item}
        pluginName="Demo"
        pluginVersion="1.0.0"
        open
        onOpenChange={vi.fn()}
        onUploaded={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(
        (
          screen.getByRole('button', {
            name: 'settings.ghosts.meka.dev.upload',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    expect(screen.queryByText('settings.ghosts.meka.dev.publishInfoFailed')).toBeNull();
  });

  it('offers in-place login when the saved MCPRouter session has expired', async () => {
    getRouter.mockResolvedValue({
      configured: true,
      routerUrl: 'https://router.example/',
      defaultRouterUrl: 'https://router.example/',
      routerUsername: 'meka-user',
    });
    getUploadInfo.mockRejectedValue(
      new Error(
        "Error invoking remote method 'meka-dev-plugins:upload-info': Error: [PERMISSION_DENIED] MCPRouter session expired",
      ),
    );
    render(
      <MekaDevPluginPackageDialog
        item={item}
        pluginName="Demo"
        pluginVersion="1.0.0"
        open
        onOpenChange={vi.fn()}
        onUploaded={vi.fn()}
      />,
    );

    await screen.findByText('settings.ghosts.meka.dev.packageLoginRequired');
    expect(
      screen.getByRole('button', { name: 'settings.ghosts.meka.dev.configureRouter' }),
    ).toBeTruthy();
    expect(screen.queryByText('settings.ghosts.meka.dev.publishInfoFailed')).toBeNull();
  });

  it('syncs access without overwriting an immutable existing version', async () => {
    getRouter.mockResolvedValue({ configured: true });
    getUploadInfo.mockResolvedValue({
      pluginId: 'demo-plugin',
      version: '1.0.0',
      existing: {
        pluginResourceId: 'plugin-resource',
        currentReleaseId: 'release-1',
        currentVersion: '1.0.0',
        visibility: 'private',
        sharedUsernames: [],
      },
    });
    uploadPlugin.mockResolvedValue({
      pluginId: 'demo-plugin',
      version: '1.0.0',
      visibility: 'public',
      releasePublished: false,
    });
    render(
      <MekaDevPluginPackageDialog
        item={item}
        pluginName="Demo"
        pluginVersion="1.0.0"
        open
        onOpenChange={vi.fn()}
        onUploaded={vi.fn()}
      />,
    );

    await screen.findByText('settings.ghosts.meka.dev.versionAlreadyExists');
    fireEvent.change(screen.getByLabelText('settings.ghosts.meka.dev.permissionLabel'), {
      target: { value: 'public' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.meka.dev.syncAccess' }));

    await waitFor(() =>
      expect(uploadPlugin).toHaveBeenCalledWith({
        id: item.runtimeId,
        visibility: 'public',
        sharedUsernames: [],
        expectedCurrentReleaseId: 'release-1',
      }),
    );
    expect(confirmMock).not.toHaveBeenCalled();
  });
});
