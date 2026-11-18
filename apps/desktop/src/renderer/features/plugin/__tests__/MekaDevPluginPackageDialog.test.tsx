/**
 * Development Plugin package modal capability gating, version wording and
 * MCPRouter failure classification.
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
import { toast } from '@/lib/toast';

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
        "Error invoking remote method 'meka-dev-plugins:upload-info': Error: [MEKA_ROUTER_SESSION_EXPIRED] MCPRouter session expired or has no permission (HTTP 401) at /api/meka-plugins",
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
      screen.getByText('settings.ghosts.meka.dev.publishInfoFailures.sessionExpired'),
    ).toBeTruthy();
    // 补充信息只展示可公开的 HTTP 状态码与端点。
    expect(screen.getByText(/HTTP 401/)).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'settings.ghosts.meka.dev.configureRouter' }),
    ).toBeTruthy();
    expect(screen.queryByText('settings.ghosts.meka.dev.publishInfoFailed')).toBeNull();
  });

  /*
   * 测试价值
   * - 生产入口与可观察结果:渲染 `MekaDevPluginPackageDialog`,打开即静默预读
   *   `meka-dev-plugins:upload-info`;失败时按 Main 的分类码渲染不同中文引导。
   * - Bug／规则依据:2026-11-18 用户报告——除 PERMISSION_DENIED 外所有失败都渲染同一句
   *   「无法读取 MCPRouter 中的版本和权限」,上传按钮不可用且没有重试入口。
   * - 现有覆盖缺口:原用例只覆盖 401 与成功路径,没有网络／接口不支持／回包非法三类。
   * - 最小失败输入:upload-info 分别以 MEKA_ROUTER_UNREACHABLE /
   *   MEKA_ROUTER_ENDPOINT_UNSUPPORTED / MEKA_ROUTER_RESPONSE_INVALID 拒绝。
   * - tier:unit(jsdom + mocked preload bridge)。
   */
  it.each([
    {
      code: 'MEKA_ROUTER_UNREACHABLE',
      copyKey: 'settings.ghosts.meka.dev.publishInfoFailures.unreachable',
      detail: 'MCPRouter is unreachable at /api/meka-plugins',
    },
    {
      code: 'MEKA_ROUTER_ENDPOINT_UNSUPPORTED',
      copyKey: 'settings.ghosts.meka.dev.publishInfoFailures.endpointUnsupported',
      detail: 'MCPRouter does not support /api/meka-plugins (HTTP 404)',
    },
    {
      code: 'MEKA_ROUTER_RESPONSE_INVALID',
      copyKey: 'settings.ghosts.meka.dev.publishInfoFailures.responseInvalid',
      detail: 'MCPRouter returned an invalid response from /api/meka-plugins',
    },
  ])(
    'renders the reason-specific notice and keeps local packaging available for $code',
    async ({ code, copyKey, detail }) => {
      getRouter.mockResolvedValue({ configured: true });
      getUploadInfo.mockRejectedValue(
        new Error(
          `Error invoking remote method 'meka-dev-plugins:upload-info': Error: [${code}] ${detail}`,
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

      await screen.findByText(copyKey);
      expect(screen.getByText(detail)).toBeTruthy();
      // 本地打包不读线上信息,失败时也必须可用。
      const packageButton = screen.getByRole('button', {
        name: 'settings.ghosts.meka.dev.packageLocal',
      }) as HTMLButtonElement;
      expect(packageButton.disabled).toBe(false);
      fireEvent.click(packageButton);
      await waitFor(() => expect(packagePlugin).toHaveBeenCalledWith(item.runtimeId));
      expect(
        (
          screen.getByRole('button', {
            name: 'settings.ghosts.meka.dev.upload',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      // 非凭证类失败不给「配置登录」,给重试。
      expect(
        screen.queryByRole('button', { name: 'settings.ghosts.meka.dev.configureRouter' }),
      ).toBeNull();
      expect(
        screen.getByRole('button', { name: 'settings.ghosts.meka.dev.publishInfoRetry' }),
      ).toBeTruthy();
    },
  );

  it('retries the publish-info read in place and enables upload again after success', async () => {
    getRouter.mockResolvedValue({ configured: true });
    getUploadInfo
      .mockRejectedValueOnce(
        new Error(
          "Error invoking remote method 'meka-dev-plugins:upload-info': Error: [MEKA_ROUTER_UNREACHABLE] MCPRouter is unreachable at /api/meka-plugins",
        ),
      )
      .mockResolvedValue({ pluginId: 'demo-plugin', version: '1.0.0', existing: null });
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

    fireEvent.click(
      await screen.findByRole('button', { name: 'settings.ghosts.meka.dev.publishInfoRetry' }),
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
    expect(screen.queryByTestId('meka-dev-plugin-publish-info-failure')).toBeNull();
    expect(getUploadInfo).toHaveBeenCalledTimes(2);
  });

  it('shows the version that will be packaged, and names the running version when they differ', async () => {
    getRouter.mockResolvedValue({ configured: true });
    getUploadInfo.mockResolvedValue({
      pluginId: 'demo-plugin',
      version: '0.11.1',
      existing: null,
    });
    render(
      <MekaDevPluginPackageDialog
        item={{
          ...item,
          sourceVersion: '0.11.1',
          installedVersion: '0.9.1',
        }}
        pluginName="Demo"
        pluginVersion="0.9.1"
        open
        onOpenChange={vi.fn()}
        onUploaded={vi.fn()}
      />,
    );

    // 上传版本来自源码打包结果,不是已装开发副本的版本。
    await screen.findByText('v0.11.1');
    expect(screen.getByText('settings.ghosts.meka.dev.uploadVersionLabel')).toBeTruthy();
    expect(screen.getByText('settings.ghosts.meka.dev.versionChanged')).toBeTruthy();
  });

  it('does not compare versions when the running copy already matches the source', async () => {
    getRouter.mockResolvedValue({ configured: true });
    getUploadInfo.mockResolvedValue({
      pluginId: 'demo-plugin',
      version: '1.0.0',
      existing: null,
    });
    render(
      <MekaDevPluginPackageDialog
        item={{ ...item, sourceVersion: '1.0.0', installedVersion: '1.0.0' }}
        pluginName="Demo"
        pluginVersion="1.0.0"
        open
        onOpenChange={vi.fn()}
        onUploaded={vi.fn()}
      />,
    );

    await screen.findByText('v1.0.0');
    expect(screen.queryByText('settings.ghosts.meka.dev.versionChanged')).toBeNull();
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

  it('shows the Router reason when publishing is rejected', async () => {
    getRouter.mockResolvedValue({ configured: true });
    getUploadInfo.mockResolvedValue({
      pluginId: 'demo-plugin',
      version: '1.0.0',
      existing: null,
    });
    uploadPlugin.mockRejectedValue(
      new Error(
        "Error invoking remote method 'meka-dev-plugins:upload': Error: [ALREADY_EXISTS] MCPRouter upload Meka Plugin failed (409): {\"error\":\"Another user already owns this plugin id\"}",
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

    fireEvent.click(
      await screen.findByRole('button', { name: 'settings.ghosts.meka.dev.upload' }),
    );

    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        expect.stringContaining('Another user already owns this plugin id'),
      ),
    );
  });

  /*
   * 测试价值
   * - 生产入口与可观察结果:线上已发布 v1.0.66、本地源码 v1.0.65 时,渲染
   *   `MekaDevPluginPackageDialog` 把「上传到 MCPRouter」按钮置为 disabled,渲染
   *   「当前线上版本更高、必须提升版本号」的可操作文案,并**不再**显示
   *   「MCPRouter 当前为 v1.0.66，将发布 v1.0.65」这种自相矛盾的更新提示;
   *   「打包到本地」不读线上状态,回退时仍然可用。
   * - Bug／规则依据:2026-11-18 用户实测——本地版本低于线上已发布版本时仍被当成
   *   「更新」上传,MCPRouter 的 Release 不可覆盖,必然 409,toast 原样抛出
   *   `{"error":"This plugin version is already published"}`。
   * - 现有覆盖缺口:原用例只有「更高 = 更新」与「相等 = 仅同步权限」两态,
   *   没有「更低 = 禁止上传」。
   * - 最小失败输入:upload-info 返回 version 1.0.65 + existing.currentVersion 1.0.66。
   * - tier:unit(jsdom + mocked preload bridge)。
   */
  it('blocks publishing a lower version and explains what to change', async () => {
    getRouter.mockResolvedValue({ configured: true });
    getUploadInfo.mockResolvedValue({
      pluginId: 'demo-plugin',
      version: '1.0.65',
      existing: {
        pluginResourceId: 'plugin-resource',
        currentReleaseId: 'release-66',
        currentVersion: '1.0.66',
        visibility: 'private',
        sharedUsernames: [],
      },
    });
    render(
      <MekaDevPluginPackageDialog
        item={item}
        pluginName="Demo"
        pluginVersion="1.0.65"
        open
        onOpenChange={vi.fn()}
        onUploaded={vi.fn()}
      />,
    );

    await screen.findByText('settings.ghosts.meka.dev.publishVersionTooOld');
    expect(screen.getByTestId('meka-dev-plugin-version-too-old')).toBeTruthy();
    // 回退状态下不能出现「将发布更低版本」这种自相矛盾但看似可执行的表述。
    expect(screen.queryByText('settings.ghosts.meka.dev.versionUpdate')).toBeNull();
    const upload = screen.getByRole('button', {
      name: 'settings.ghosts.meka.dev.upload',
    }) as HTMLButtonElement;
    expect(upload.disabled).toBe(true);
    fireEvent.click(upload);
    expect(uploadPlugin).not.toHaveBeenCalled();
    expect(
      (
        screen.getByRole('button', {
          name: 'settings.ghosts.meka.dev.packageLocal',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  /*
   * 测试价值
   * - 生产入口与可观察结果:上传被 `MEKA_ROUTER_VERSION_ALREADY_PUBLISHED` 拒绝时,
   *   toast 显示可操作的本地化文案,而不是 Main 的英文诊断句或响应体 JSON。
   * - Bug／规则依据:2026-11-18 用户实测 toast 原文是
   *   `MCPRouter upload Meka Plugin failed (409): {"error":"This plugin version is already published"}`。
   * - 现有覆盖缺口:原用例只断言「Router 原因」被透传,没有覆盖版本类稳定码的文案映射。
   * - 最小失败输入:upload 以 `[MEKA_ROUTER_VERSION_ALREADY_PUBLISHED]` 拒绝(版本已被
   *   另一处发布的并发窗口)。
   * - tier:unit(jsdom + mocked preload bridge)。
   */
  it('shows actionable copy instead of the raw Router conflict body', async () => {
    getRouter.mockResolvedValue({ configured: true });
    getUploadInfo.mockResolvedValue({
      pluginId: 'demo-plugin',
      version: '1.0.0',
      existing: null,
    });
    uploadPlugin.mockRejectedValue(
      new Error(
        "Error invoking remote method 'meka-dev-plugins:upload': Error: [MEKA_ROUTER_VERSION_ALREADY_PUBLISHED] MCPRouter already published v1.0.0 (HTTP 409). Bump the version and publish again.",
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

    fireEvent.click(
      await screen.findByRole('button', { name: 'settings.ghosts.meka.dev.upload' }),
    );

    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        'settings.ghosts.meka.dev.publishVersionAlreadyPublished',
      ),
    );
  });

  it('shows the detailed IPC reason for an otherwise internal upload failure', async () => {
    getRouter.mockResolvedValue({ configured: true });
    getUploadInfo.mockResolvedValue({
      pluginId: 'demo-plugin',
      version: '1.0.0',
      existing: null,
    });
    uploadPlugin.mockRejectedValue(
      new Error(
        "Error invoking remote method 'meka-dev-plugins:upload': Error: [INTERNAL] Meka development Plugin operation failed: request timed out",
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

    fireEvent.click(
      await screen.findByRole('button', { name: 'settings.ghosts.meka.dev.upload' }),
    );

    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        expect.stringContaining('request timed out'),
      ),
    );
  });
});
