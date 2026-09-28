import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import { createMekaP4SettingsService } from '../service';

/**
 * Real, self-built P4 root fixture.
 *
 * `setP4RootPath` validates with `path.isAbsolute` plus a directory stat, i.e.
 * with the *host* platform semantics. A hard-coded literal such as `C:\P4` is
 * only absolute on Windows (on POSIX `\` is an ordinary character), so these
 * cases failed on the Linux CI runner before the root became a real directory
 * created here. The temp dir is also guaranteed not to exist beforehand, so the
 * suite can never pick up a developer's actual SAGA2 P4 checkout.
 */
const p4Root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-meka-p4-settings-'));
/** Mirrors a checked-out SAGA2 P4 root; `unrelated` proves unrelated dirs are ignored. */
const P4_ROOT_SUBFOLDERS = ['saga2_design', 'saga2_unity', 'saga2_pm', 'unrelated'];
for (const name of P4_ROOT_SUBFOLDERS) fs.mkdirSync(path.join(p4Root, name));

afterAll(() => {
  fs.rmSync(p4Root, { recursive: true, force: true });
});

function createHarness(initial?: Record<string, unknown>) {
  const files = new Map<string, string>();
  // The settings file is purely in-memory: every file operation is injected, so
  // this path is never touched on disk.
  const configPath = path.join(
    os.tmpdir(),
    'cindy-meka-settings-user-data',
    'meka-assistant-settings.json',
  );
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
    // `statDirectory` and `readdir` deliberately use the production defaults:
    // the fixture root is a real directory under the OS temp dir, so the
    // "existing absolute directory" validation and the subfolder discovery stay
    // under test instead of being stubbed into always-true.
  });
  return { service, files, configPath };
}

describe('Meka P4 settings compatibility', () => {
  it('reads the original Meka file shape and resolves matched directories', async () => {
    const { service } = createHarness({
      schemaVersion: 1,
      p4RootPath: p4Root,
      subfolders: { saga2_design: true, saga2_json: false },
    });

    await expect(service.get()).resolves.toMatchObject({
      p4RootPath: p4Root,
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

    await service.setP4RootPath(p4Root);
    const persisted = JSON.parse(files.get(configPath)!);
    expect(persisted).toMatchObject({
      schemaVersion: 1,
      p4RootPath: p4Root,
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
      p4RootPath: p4Root,
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
      extraDirs: expect.arrayContaining([path.join(p4Root, 'saga2_pm')]),
    });
    expect(files.get(configPath)).toBe(before);
  });

  it('rejects a relative path or a directory that does not exist', async () => {
    const { service, files, configPath } = createHarness({
      schemaVersion: 1,
      p4RootPath: p4Root,
    });
    const before = files.get(configPath);
    const missingRoot = path.join(p4Root, 'saga2_json_not_checked_out');

    expect(fs.existsSync(missingRoot)).toBe(false);
    await expect(service.setP4RootPath(missingRoot)).rejects.toThrow(
      'P4 root must be an existing absolute directory',
    );
    await expect(service.setP4RootPath(path.join('relative', 'saga2_project'))).rejects.toThrow(
      'P4 root must be an existing absolute directory',
    );
    expect(files.get(configPath)).toBe(before);
  });

  it('keeps future-schema files read-only and byte-identical', async () => {
    const { service, files, configPath } = createHarness({
      schemaVersion: 2,
      futureOnly: { keep: true },
    });
    const original = files.get(configPath);

    await expect(service.setP4RootPath(p4Root)).rejects.toThrow('read-only');
    expect(files.get(configPath)).toBe(original);
  });
});
