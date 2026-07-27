import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { app } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => path.join(os.tmpdir(), 'cindy-meka-test-user-data')),
  },
}));

import {
  buildMekaWorkspaceDir,
  ensureMekaWorkspaceDir,
  mekaWorkspaceDayKey,
  resolveMekaProjectWorkspacePath,
} from '../mekaWorkspace.js';

const created: string[] = [];

afterEach(() => {
  for (const directory of created.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('Meka workspace resolution', () => {
  it('resolves the SAGA2 token through the configured P4 root', async () => {
    await expect(
      resolveMekaProjectWorkspacePath('saga2', {
        readP4RootPath: async () => 'C:\\P4\\saga2',
      }),
    ).resolves.toBe('C:/P4/saga2');
  });

  it('fails closed when SAGA2 has no configured P4 root', async () => {
    await expect(
      resolveMekaProjectWorkspacePath('saga2', {
        readP4RootPath: async () => null,
      }),
    ).rejects.toThrow('P4 root path is not configured');
  });

  it('requires an absolute path for custom projects', async () => {
    await expect(
      resolveMekaProjectWorkspacePath('relative-project', {
        readP4RootPath: async () => null,
      }),
    ).rejects.toThrow('must be absolute');
  });

  it('creates an app-owned fallback workspace without seeding legacy role assets', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-meka-workspace-'));
    created.push(root);
    vi.mocked(app.getPath).mockReturnValue(root);
    const now = new Date(2026, 6, 24).getTime();

    const directory = ensureMekaWorkspaceDir('session-1', now);

    expect(directory).toBe(buildMekaWorkspaceDir('session-1', now));
    expect(mekaWorkspaceDayKey(now)).toBe('2026-07-24');
    expect(fs.statSync(directory).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(directory, '.claude'))).toBe(false);
  });
});
