import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { handleIncomingCindyFile, takePendingCindyInstall } from '../openFileInstall';

const cleanupDirs: string[] = [];

afterEach(async () => {
  takePendingCindyInstall();
  await Promise.all(
    cleanupDirs.splice(0).map((dir) => fs.promises.rm(dir, { recursive: true, force: true })),
  );
});

async function createCindyFile(): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-open-file-test-'));
  cleanupDirs.push(dir);
  const filePath = path.join(dir, 'plugin.cindy');
  await fs.promises.writeFile(filePath, 'test');
  return filePath;
}

describe('openFileInstall pending request', () => {
  it('carries an explicit Meka channel once and clears it atomically', async () => {
    const filePath = await createCindyFile();

    await handleIncomingCindyFile(filePath, 'ghost-forge', { channel: 'meka' });

    expect(takePendingCindyInstall()).toEqual({ filePath, channel: 'meka' });
    expect(takePendingCindyInstall()).toBeNull();
  });

  it('keeps ordinary file opens unattributed', async () => {
    const filePath = await createCindyFile();

    await handleIncomingCindyFile(filePath, 'open-file');

    expect(takePendingCindyInstall()).toEqual({ filePath });
  });
});
