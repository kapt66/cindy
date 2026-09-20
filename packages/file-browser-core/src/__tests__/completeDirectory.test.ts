import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listDir } from '../scanner';
import { loadIgnoreMatcher } from '../ignore';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

it('separates complete enumeration from tree presentation filters', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'complete-dir-'));
  roots.push(root);
  for (const name of ['dist', 'build', 'vendor']) await fs.mkdir(path.join(root, name));
  for (const name of ['.env', 'asset.meta', 'index.html']) await fs.writeFile(path.join(root, name), 'fixture');
  await fs.writeFile(path.join(root, 'dist/app.js'), 'fixture');
  expect((await listDir(root, '')).map(e => e.name).sort()).toEqual(
    ['.env', 'asset.meta', 'build', 'dist', 'index.html', 'vendor'],
  );
  const matcher = await loadIgnoreMatcher(root, { hideMetaFiles: true, honorVcsIgnore: false });
  expect((await listDir(root, '', matcher)).map(e => e.name)).toEqual(['.env', 'index.html']);
  expect((await listDir(root, 'dist')).map(e => e.relPath)).toEqual(['dist/app.js']);
  await expect(listDir(root, '', null, { maxEntries: 2 })).rejects.toThrow('DIRECTORY_TOO_LARGE');
  await expect(listDir(root, '', null, { maxEntries: NaN })).rejects.toThrow('Invalid');
  await expect(listDir(root, '../')).rejects.toThrow('escapes');
});

it('retains realpath boundaries when listing without presentation filters', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'complete-dir-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'complete-outside-'));
  roots.push(root, outside);
  // 目录符号链接按平台分派:Windows 上默认的 'file' 类型需要
  // SeCreateSymbolicLinkPrivilege(普通账号没有,CI 机器也未必给),而 junction 是同一类
  // 重解析点、同样指到 root 之外,逃生语义完全一致。仓库既有约定见
  // apps/desktop/src/main/__tests__/codexGlobalSkills.test.ts 等。
  await fs.symlink(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  expect(await listDir(root, '')).toEqual([]);
  await expect(listDir(root, 'link')).rejects.toThrow('escapes');
});
