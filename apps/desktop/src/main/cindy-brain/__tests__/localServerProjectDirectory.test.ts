import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveLocalServerProjectDirectory } from '../localServerProjectDirectory';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('resolveLocalServerProjectDirectory', () => {
  it('returns a non-empty direct child of a Host-owned local task directory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-local-server-project-'));
    roots.push(root);
    const candidate = path.join(root, 'saga2_json');
    await fs.mkdir(candidate);
    await fs.writeFile(path.join(candidate, 'table.json'), '{}');

    await expect(resolveLocalServerProjectDirectory('session-1', 'saga2_json', async () => ({
      workingDir: root,
      remoteHostId: null,
    }))).resolves.toBe(await fs.realpath(candidate));
  });

  it('fails closed for remote tasks, traversal, empty directories, and missing tasks', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-local-server-project-'));
    roots.push(root);
    await fs.mkdir(path.join(root, 'saga2_json'));
    const local = async () => ({ workingDir: root, remoteHostId: null });

    await expect(resolveLocalServerProjectDirectory('session-1', '../saga2_json', local)).resolves.toBeNull();
    await expect(resolveLocalServerProjectDirectory('session-1', 'saga2_json', local)).resolves.toBeNull();
    await expect(resolveLocalServerProjectDirectory('session-1', 'saga2_json', async () => ({ workingDir: root, remoteHostId: 'mcpr:instance-1' }))).resolves.toBeNull();
    await expect(resolveLocalServerProjectDirectory('session-1', 'saga2_json', async () => null)).resolves.toBeNull();
  });

  it('rejects a direct-child link whose real path escapes the task directory', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-local-server-project-'));
    roots.push(base);
    const root = path.join(base, 'project');
    const outside = path.join(base, 'outside');
    await fs.mkdir(root);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'table.json'), '{}');
    await fs.symlink(outside, path.join(root, 'saga2_json'), process.platform === 'win32' ? 'junction' : 'dir');

    await expect(resolveLocalServerProjectDirectory('session-1', 'saga2_json', async () => ({
      workingDir: root,
      remoteHostId: null,
    }))).resolves.toBeNull();
  });
});
