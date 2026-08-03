import crypto from 'node:crypto';
import JSZip from 'jszip';
import { describe, expect, it, vi } from 'vitest';

import type { MekaSkillMarketApi } from '../api';
import { MekaSkillMarketService } from '../service';

function serviceWithListError(error: Error): MekaSkillMarketService {
  return new MekaSkillMarketService({
    isConfigured: vi.fn(async () => true),
    listAll: vi.fn(async () => {
      throw error;
    }),
  } as unknown as MekaSkillMarketApi);
}

describe('MekaSkillMarketService snapshot compatibility', () => {
  it('projects a missing MCPRouter Skill API as an upgrade-required state', async () => {
    const missingRoute = Object.assign(new Error('Not found'), { statusCode: 404 });

    await expect(serviceWithListError(missingRoute).snapshot()).resolves.toEqual({
      configured: false,
      unavailableReason: 'registry-not-supported',
      items: [],
    });
  });

  it('does not hide network and server failures as an upgrade requirement', async () => {
    const networkFailure = Object.assign(new Error('Network unavailable'), {
      statusCode: 0,
    });

    await expect(serviceWithListError(networkFailure).snapshot()).rejects.toThrow(
      'Network unavailable',
    );
  });
});

describe('MekaSkillMarketService preview adapter', () => {
  const detail = {
    id: 'skill-1',
    slug: 'release-notes',
    name: 'Release notes',
    description: 'Prepare release notes',
    scope: 'public' as const,
    access: 'public' as const,
    currentRelease: {
      id: 'release-1',
      version: '1.0.0',
      sha256: 'a'.repeat(64),
      sizeBytes: 256,
      uncompressedSizeBytes: 512,
      publishedAt: '2026-07-31T00:00:00.000Z',
      manifest: {
        name: 'release-notes',
        description: 'Prepare release notes',
        version: '1.0.0',
      },
      files: [
        { path: 'SKILL.md', sizeBytes: 120, sha256: 'b'.repeat(64) },
        { path: 'scripts/run.py', sizeBytes: 80, sha256: 'c'.repeat(64) },
      ],
    },
  };

  function previewService(): MekaSkillMarketService {
    return new MekaSkillMarketService({
      detail: vi.fn(async () => detail),
    } as unknown as MekaSkillMarketApi);
  }

  async function contentService() {
    const skillContent = [
      '---',
      'name: release-notes',
      'description: Prepare release notes',
      'version: 1.0.0',
      '---',
      '',
      '# Real instructions',
      '',
      'Use the actual packaged body.',
    ].join('\n');
    const scriptContent = 'print("real file")\n';
    const zip = new JSZip();
    zip.file('SKILL.md', skillContent);
    zip.file('scripts/run.py', scriptContent);
    const bytes = await zip.generateAsync({ type: 'nodebuffer' });
    const sha256 = (value: Buffer | string) =>
      crypto.createHash('sha256').update(value).digest('hex');
    const packageDetail = {
      ...detail,
      currentRelease: {
        ...detail.currentRelease,
        sha256: sha256(bytes),
        sizeBytes: bytes.byteLength,
        uncompressedSizeBytes: Buffer.byteLength(skillContent) + Buffer.byteLength(scriptContent),
        files: [
          {
            path: 'SKILL.md',
            sizeBytes: Buffer.byteLength(skillContent),
            sha256: sha256(skillContent),
          },
          {
            path: 'scripts/run.py',
            sizeBytes: Buffer.byteLength(scriptContent),
            sha256: sha256(scriptContent),
          },
        ],
      },
    };
    const api = {
      access: vi.fn(async () => ({ baseUrl: 'https://router.example', clientKey: 'client-key' })),
      detail: vi.fn(async () => packageDetail),
      download: vi.fn(async () => ({
        url: 'https://s3.example/release.zip?signed=1',
        expiresAt: '2030-01-01T00:00:00.000Z',
        sha256: sha256(bytes),
        sizeBytes: bytes.byteLength,
      })),
    } as unknown as MekaSkillMarketApi;
    const fetchPreview = vi.fn(
      async () =>
        new Response(new Uint8Array(bytes), {
          status: 200,
          headers: { 'content-length': String(bytes.byteLength) },
        }),
    );
    return {
      service: new MekaSkillMarketService(api, fetchPreview),
      fetchPreview,
      skillContent,
      scriptContent,
    };
  }

  it('maps the MCPRouter package index to the shared Cindy preview file model', async () => {
    await expect(previewService().files('skill-1')).resolves.toEqual([
      {
        path: 'SKILL.md',
        size: 120,
        language: 'markdown',
        truncated: false,
      },
      {
        path: 'scripts/run.py',
        size: 80,
        language: 'python',
        truncated: false,
      },
    ]);
  });

  it('reads real packaged file bodies and reuses the verified release for preview', async () => {
    const fixture = await contentService();
    await expect(fixture.service.file('skill-1', 'SKILL.md')).resolves.toEqual(
      expect.objectContaining({
        path: 'SKILL.md',
        language: 'markdown',
        content: fixture.skillContent,
      }),
    );
    await expect(fixture.service.file('skill-1', 'scripts/run.py')).resolves.toEqual(
      expect.objectContaining({
        path: 'scripts/run.py',
        language: 'python',
        content: fixture.scriptContent,
      }),
    );
    expect(fixture.fetchPreview).toHaveBeenCalledOnce();
  });

  it('rejects oversized uncompressed packages before downloading preview bytes', async () => {
    const oversizedDetail = {
      ...detail,
      currentRelease: {
        ...detail.currentRelease,
        uncompressedSizeBytes: 50 * 1024 * 1024 + 1,
      },
    };
    const fetchPreview = vi.fn();
    const service = new MekaSkillMarketService(
      {
        access: vi.fn(async () => ({ baseUrl: 'https://router.example', clientKey: 'client-key' })),
        detail: vi.fn(async () => oversizedDetail),
      } as unknown as MekaSkillMarketApi,
      fetchPreview,
    );

    await expect(service.file('skill-1', 'SKILL.md')).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(fetchPreview).not.toHaveBeenCalled();
  });

  it('rejects an oversized Meka package before starting the general installer', async () => {
    const oversizedDetail = {
      ...detail,
      currentRelease: {
        ...detail.currentRelease,
        uncompressedSizeBytes: 50 * 1024 * 1024 + 1,
      },
    };
    const service = new MekaSkillMarketService({
      access: vi.fn(async () => ({ baseUrl: 'https://router.example', clientKey: 'client-key' })),
      detail: vi.fn(async () => oversizedDetail),
    } as unknown as MekaSkillMarketApi);

    await expect(
      service.install({ skillId: 'skill-1', expectedReleaseId: 'release-1' }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });
});
