/** revealSlot.test — 系统文件管理器定位槽的路径与权限守门。 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { InstalledGhost } from '../../../shared/ghost';
import { GhostRevealSlot, type RevealSlotDeps } from '../revealSlot';

function revealGhost(options: { slots?: string[]; enabled?: boolean } = {}): InstalledGhost {
  return {
    manifest: {
      schemaVersion: 2,
      id: 'reveal-ghost',
      name: 'Reveal Ghost',
      version: '1.0.0',
      kind: 'chip',
      entry: 'main.js',
      slots: options.slots ?? ['reveal'],
    },
    dir: '/fake/reveal-ghost',
    enabled: options.enabled ?? true,
  } as InstalledGhost;
}

function makeSlot(overrides: Partial<RevealSlotDeps> = {}) {
  let clock = 0;
  const deps: RevealSlotDeps = {
    getGhost: () => revealGhost(),
    showItemInFolder: vi.fn(),
    now: () => (clock += 2000),
    ...overrides,
  };
  return { slot: new GhostRevealSlot(deps), deps };
}

describe('revealSlot · 资格审与输入校验', () => {
  it('未声明 reveal 槽 / 未启用一律拒绝', () => {
    const noSlot = makeSlot({ getGhost: () => revealGhost({ slots: ['panel'] }) });
    expect(noSlot.slot.handleRequest('reveal-ghost', { path: 'C:\\file.txt' })).toMatchObject({
      ok: false,
      errorCode: 'PERMISSION_DENIED',
    });
    const disabled = makeSlot({ getGhost: () => revealGhost({ enabled: false }) });
    expect(disabled.slot.handleRequest('reveal-ghost', { path: 'C:\\file.txt' })).toMatchObject({
      ok: false,
      errorCode: 'PERMISSION_DENIED',
    });
  });

  it('只接受绝对路径字符串,目录也允许定位到父目录', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-reveal-'));
    try {
      const { slot, deps } = makeSlot();
      expect(slot.handleRequest('reveal-ghost', {})).toMatchObject({ ok: false, errorCode: 'INVALID_REQUEST' });
      expect(slot.handleRequest('reveal-ghost', { path: 'relative.txt' })).toMatchObject({
        ok: false,
        errorCode: 'INVALID_REQUEST',
      });
      const result = slot.handleRequest('reveal-ghost', { path: root });
      expect(result).toEqual({ ok: true });
      expect(deps.showItemInFolder).toHaveBeenCalledWith(root);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('拒绝非原生本机路径形态', () => {
    const { slot, deps } = makeSlot();
    const paths = process.platform === 'win32'
      ? ['/remote/file.txt', '\\\\server\\share\\file.txt', '\\\\?\\C:\\file.txt']
      : ['C:\\\\file.txt', '\\\\server\\share\\file.txt'];
    for (const candidate of paths) {
      expect(slot.handleRequest('reveal-ghost', { path: candidate })).toMatchObject({
        ok: false,
        errorCode: 'INVALID_REQUEST',
      });
    }
    expect(deps.showItemInFolder).not.toHaveBeenCalled();
  });
});

describe('revealSlot · 本机文件定位', () => {
  it('realpath 后调用 showItemInFolder,成功不回传路径', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-reveal-'));
    try {
      const target = path.join(root, 'report.txt');
      await fs.writeFile(target, 'ok');
      const { slot, deps } = makeSlot();
      expect(slot.handleRequest('reveal-ghost', { path: target })).toEqual({ ok: true });
      expect(deps.showItemInFolder).toHaveBeenCalledWith(target);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('不存在文件不调用系统 API,错误不泄露路径', () => {
    const { slot, deps } = makeSlot();
    const result = slot.handleRequest('reveal-ghost', { path: path.join(os.tmpdir(), 'missing-reveal-file.txt') });
    expect(result).toMatchObject({ ok: false, errorCode: 'NOT_FOUND' });
    expect(JSON.stringify(result)).not.toContain('missing-reveal-file');
    expect(deps.showItemInFolder).not.toHaveBeenCalled();
  });

  it('同一插件请求过快时限流', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-reveal-'));
    try {
      const target = path.join(root, 'report.txt');
      await fs.writeFile(target, 'ok');
      let now = 0;
      const { slot } = makeSlot({ now: () => now });
      now = 2000;
      expect(slot.handleRequest('reveal-ghost', { path: target })).toEqual({ ok: true });
      now = 2500;
      expect(slot.handleRequest('reveal-ghost', { path: target })).toMatchObject({
        ok: false,
        errorCode: 'RATE_LIMITED',
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
