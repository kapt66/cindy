import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  MEKA_DEFAULT_PLUGINS_MAX_COUNT,
  parseMekaDefaultPluginsManifest,
  readMekaDefaultPlugins,
  resolveMekaDefaultPluginsPath,
} from '../mekaDefaultPlugins';

const VALID_MANIFEST = {
  schemaVersion: 1,
  plugins: [
    { ghostId: 'mcpr-project-manager', name: 'Meka 服务器管理' },
    { ghostId: 'meka-submit', name: 'Meka 提交' },
    { ghostId: 'meka-unity', name: 'Meka Unity' },
    { ghostId: 'meka-p4', name: 'Meka P4' },
  ],
};

function writeTempManifest(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meka-default-plugins-'));
  const file = path.join(dir, 'default-plugins.json');
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

describe('Meka bundled default plugins manifest', () => {
  it('reads the four shipped default plugin ids from the packaged path', () => {
    // 随包清单的事实源：resources/meka/default-plugins.json 必须能解析出这四个 id。
    const repoManifest = fileURLToPath(new URL(
      '../../../../resources/meka/default-plugins.json',
      import.meta.url,
    ));
    const parsed = parseMekaDefaultPluginsManifest(VALID_MANIFEST);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.ghostIds).toEqual([
        'mcpr-project-manager',
        'meka-submit',
        'meka-unity',
        'meka-p4',
      ]);
    }
    const read = readMekaDefaultPlugins(repoManifest);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.ghostIds).toEqual(parsed.ok ? parsed.ghostIds : []);
  });

  it('resolves packaged and dev paths without touching process.resourcesPath in tests', () => {
    expect(resolveMekaDefaultPluginsPath({
      isPackaged: true,
      appPath: 'C:/app',
      resourcesPath: 'C:/app/resources',
    })).toBe(path.join('C:/app/resources', 'meka', 'default-plugins.json'));
    expect(resolveMekaDefaultPluginsPath({
      isPackaged: false,
      appPath: 'C:/repo/apps/desktop',
      resourcesPath: 'C:/electron/resources',
    })).toBe(path.join('C:/repo/apps/desktop', 'resources', 'meka', 'default-plugins.json'));
  });

  it('fails closed on duplicate ids, invalid ids and oversized lists', () => {
    expect(parseMekaDefaultPluginsManifest({
      ...VALID_MANIFEST,
      plugins: [{ ghostId: 'meka-p4' }, { ghostId: 'meka-p4' }],
    })).toMatchObject({ ok: false });
    expect(parseMekaDefaultPluginsManifest({
      ...VALID_MANIFEST,
      plugins: [{ ghostId: 'Meka P4' }],
    })).toMatchObject({ ok: false });
    expect(parseMekaDefaultPluginsManifest({
      ...VALID_MANIFEST,
      plugins: Array.from({ length: MEKA_DEFAULT_PLUGINS_MAX_COUNT + 1 }, (_, index) => ({
        ghostId: `plugin-${index}`,
      })),
    })).toMatchObject({ ok: false });
  });

  it('reports a missing manifest as absent instead of throwing', () => {
    // 旧安装/裁剪包没有清单是正常状态：不能因此阻塞启动，也不能装任何默认插件。
    const read = readMekaDefaultPlugins(path.join(os.tmpdir(), 'meka-default-plugins-missing.json'));
    expect(read).toMatchObject({ ok: false, reason: 'missing' });
  });

  it('rejects malformed JSON and unsupported schema versions', () => {
    const malformed = writeTempManifest('{ not json');
    expect(readMekaDefaultPlugins(malformed)).toMatchObject({ ok: false, reason: 'invalid' });
    expect(parseMekaDefaultPluginsManifest({ schemaVersion: 2, plugins: [] }))
      .toMatchObject({ ok: false });
  });
});
