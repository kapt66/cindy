import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createMekaP4SettingsService } from '../service';

function createHarness(
  initial?: Record<string, unknown>,
  directoryEntries = ['saga2_design', 'saga2_unity', 'saga2_pm', 'unrelated'],
) {
  const files = new Map<string, string>();
  const configPath = path.resolve('C:\\meka-user-data', 'meka-assistant-settings.json');
  if (initial) files.set(configPath, JSON.stringify(initial));
  const service = createMekaP4SettingsService({
    configPath,
    readFile: vi.fn(async (filePath) => files.get(filePath) ?? null),
    writeFile: vi.fn(async (filePath, content) => {
      files.set(filePath, content);
    }),
    mkdir: vi.fn(async () => undefined),
    rename: vi.fn(async (from, to) => {
      const content = files.get(from);
      if (content === undefined) throw new Error('missing temp file');
      files.set(to, content);
      files.delete(from);
    }),
    unlink: vi.fn(async (filePath) => {
      files.delete(filePath);
    }),
    statDirectory: vi.fn(async () => true),
    readdir: vi.fn(async () => directoryEntries),
  });
  return { service, files, configPath };
}

describe('Meka P4 settings compatibility', () => {
  it('reads the original Meka file shape and resolves matched directories', async () => {
    const { service } = createHarness({
      schemaVersion: 1,
      p4RootPath: 'C:\\P4',
      subfolders: { saga2_design: true, saga2_json: false },
    });

    await expect(service.get()).resolves.toMatchObject({
      p4RootPath: 'C:\\P4',
      subfolders: [
        { name: 'saga2_design' },
        { name: 'saga2_json' },
        { name: 'saga2_unity' },
        { name: 'saga2_pm' },
      ],
      readOnlyBecauseFutureSchema: false,
    });
  });

  it('updates only P4-owned fields and preserves deferred Router/Design data', async () => {
    const { service, files, configPath } = createHarness({
      schemaVersion: 1,
      routerUrl: 'https://router.example',
      routerUsername: 'meka-user',
      mekadesignConfigured: true,
      projectRemoteInstanceIds: { p1: ['remote-1'] },
    });

    await service.setP4RootPath('C:\\P4');
    const persisted = JSON.parse(files.get(configPath)!);
    expect(persisted).toMatchObject({
      schemaVersion: 1,
      p4RootPath: 'C:\\P4',
      subfolders: { saga2_design: true, saga2_unity: true, saga2_pm: true },
      routerUrl: 'https://router.example',
      routerUsername: 'meka-user',
      mekadesignConfigured: true,
      projectRemoteInstanceIds: { p1: ['remote-1'] },
    });
  });

  it('discovers saga2_pm for an already-configured P4 root without requiring reselection', async () => {
    const { service, files, configPath } = createHarness({
      schemaVersion: 1,
      p4RootPath: 'C:\\P4',
      subfolders: {
        saga2_design: true,
        saga2_json: true,
        saga2_unity: true,
      },
    });
    const before = files.get(configPath);

    await expect(service.get()).resolves.toMatchObject({
      subfolders: [
        { name: 'saga2_design' },
        { name: 'saga2_json' },
        { name: 'saga2_unity' },
        { name: 'saga2_pm' },
      ],
      extraDirs: expect.arrayContaining([path.join('C:\\P4', 'saga2_pm')]),
    });
    expect(files.get(configPath)).toBe(before);
  });

  it('keeps future-schema files read-only and byte-identical', async () => {
    const { service, files, configPath } = createHarness({
      schemaVersion: 2,
      futureOnly: { keep: true },
    });
    const original = files.get(configPath);

    await expect(service.setP4RootPath('C:\\P4')).rejects.toThrow('read-only');
    expect(files.get(configPath)).toBe(original);
  });
});
