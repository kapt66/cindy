import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getPluginRegistryAccess, serverApiFetch } = vi.hoisted(() => ({
  getPluginRegistryAccess: vi.fn(),
  serverApiFetch: vi.fn(),
}));

vi.mock('../../meka-settings/ipc', () => ({
  getMekaRouterService: () => ({ getPluginRegistryAccess }),
}));
// 上游把 serverApiClient 改成工厂（`createServerApiClient`）+ 桌面适配器
// `serverApiClient.desktop.ts` 装配出 `serverApiFetch`；生产入口 `meka-skills/api.ts`
// 现在 import 适配器，所以这层 mock 也要挂在适配器上（否则会去拉真实 electron net）。
vi.mock('../../serverApiClient.desktop', () => ({ serverApiFetch }));

import { MekaSkillMarketApi } from '../api';

const release = {
  id: 'r1',
  version: '1.0.0',
  sha256: 'a'.repeat(64),
  sizeBytes: 256,
  uncompressedSizeBytes: 512,
  publishedAt: '2026-07-31T00:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  getPluginRegistryAccess.mockResolvedValue({
    baseUrl: 'https://router.example',
    clientKey: 'client-key',
  });
});

describe('MekaSkillMarketApi', () => {
  it('uses the independent authenticated skill delivery route', async () => {
    serverApiFetch.mockResolvedValue({
      schemaVersion: 1,
      skills: [
        {
          id: 's1',
          slug: 'release-notes',
          name: 'release-notes',
          description: 'Prepare release notes',
          scope: 'personal',
          access: 'owner',
          currentRelease: release,
        },
      ],
      nextCursor: null,
    });

    await expect(new MekaSkillMarketApi().listAll()).resolves.toHaveLength(1);
    expect(serverApiFetch).toHaveBeenCalledWith(
      '/api/skills?limit=100',
      expect.objectContaining({
        baseUrl: 'https://router.example',
        token: 'client-key',
        skipAutoRefresh: true,
      }),
    );
  });

  it('uses only the explicit public route when no client key exists', async () => {
    getPluginRegistryAccess.mockResolvedValue({
      baseUrl: 'https://router.example',
      clientKey: null,
    });
    serverApiFetch.mockResolvedValue({
      schemaVersion: 1,
      skills: [],
      nextCursor: null,
    });

    await new MekaSkillMarketApi().listAll();

    expect(serverApiFetch).toHaveBeenCalledWith(
      '/api/public/skills?limit=100',
      expect.not.objectContaining({ token: expect.anything() }),
    );
  });

  it('fails closed for a malformed registry payload', async () => {
    serverApiFetch.mockResolvedValue({
      schemaVersion: 1,
      skills: [{ id: 's1' }],
      nextCursor: null,
    });

    await expect(new MekaSkillMarketApi().listAll()).rejects.toThrow('Invalid MCPRouter skill');
  });
});
