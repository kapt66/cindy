/**
 * legacyUserDataMigration.test — 首登轻量数据迁移(mToc)核心流程单测。
 *
 * 全部走内存 fs 假体(LegacyMigrationFsDeps 注入),不碰真实磁盘;
 * electron 依赖经 vitest alias 落到 electron-stub(本文件只测纯 DI 入口
 * runLegacyUserDataMigration,不触发默认 electron 实现)。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  copyDatabaseVerified,
  LEGACY_MIGRATION_MARKER_FILENAME,
  runLegacyUserDataMigration,
  SMOKE_MIGRATION_BACKUP_SUFFIX,
  shouldSkipLegacyMigrationForDevSandbox,
  type LegacyMigrationFsDeps,
  type LegacyMigrationPhase,
  type LegacyUserDataMigrationDeps,
} from '../legacyUserDataMigration';
import { createBetterSqliteDatabase } from '../localDb/betterSqliteFactory';

const BASE = path.join(path.sep, 'base');
const USER_DATA = path.join(BASE, 'CindyMeka');
const LEGACY = path.join(BASE, 'xdmaker-meka');

/** 内存 fs 假体:Map 存文件(内容 + mtime),Set 存目录/符号链接;merge 复制不覆盖。 */
function createMemFs() {
  const files = new Map<string, { content: string; mtimeMs: number }>();
  const dirs = new Set<string>();
  const symbolicLinks = new Set<string>();
  const norm = (p: string) => path.normalize(p);

  const addDir = (p: string): void => {
    let cur = norm(p);
    // 逐级登记祖先目录,pathExists 才能命中中间层。
    while (true) {
      dirs.add(cur);
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  };
  const addFile = (p: string, content = 'x', mtimeMs = 0): void => {
    files.set(norm(p), { content, mtimeMs });
    addDir(path.dirname(p));
  };
  const addSymbolicLink = (p: string): void => {
    symbolicLinks.add(norm(p));
    addDir(path.dirname(p));
  };

  const fsDeps: LegacyMigrationFsDeps = {
    pathExists: async (p) => files.has(norm(p)) || dirs.has(norm(p)) || symbolicLinks.has(norm(p)),
    readFile: async (p) => {
      const file = files.get(norm(p));
      if (!file) throw new Error(`ENOENT: ${p}`);
      return file.content;
    },
    listDir: async (dir) => {
      const nd = norm(dir);
      const out: string[] = [];
      for (const f of files.keys()) if (path.dirname(f) === nd) out.push(path.basename(f));
      for (const d of dirs) if (path.dirname(d) === nd && d !== nd) out.push(path.basename(d));
      for (const link of symbolicLinks) {
        if (path.dirname(link) === nd) out.push(path.basename(link));
      }
      return out;
    },
    listDirEntries: async (dir) => {
      const nd = norm(dir);
      const out: Array<{ name: string; isDirectory: boolean; isSymbolicLink: boolean }> = [];
      for (const f of files.keys()) {
        if (path.dirname(f) === nd) {
          out.push({ name: path.basename(f), isDirectory: false, isSymbolicLink: false });
        }
      }
      for (const d of dirs) {
        if (path.dirname(d) === nd && d !== nd) {
          out.push({ name: path.basename(d), isDirectory: true, isSymbolicLink: false });
        }
      }
      for (const link of symbolicLinks) {
        if (path.dirname(link) === nd) {
          out.push({ name: path.basename(link), isDirectory: false, isSymbolicLink: true });
        }
      }
      return out;
    },
    statSize: async (p) => {
      const f = files.get(norm(p));
      if (!f) throw new Error(`ENOENT: ${p}`);
      return f.content.length;
    },
    copyFile: async (src, dest) => {
      const s = files.get(norm(src));
      if (!s) throw new Error(`ENOENT: ${src}`);
      files.set(norm(dest), { ...s });
      addDir(path.dirname(dest));
    },
    rename: async (src, dest) => {
      const s = files.get(norm(src));
      if (!s) throw new Error(`ENOENT: ${src}`);
      if (files.has(norm(dest))) throw new Error(`EEXIST: ${dest}`); // Windows 语义
      files.delete(norm(src));
      files.set(norm(dest), s);
    },
    removeIfExists: async (p) => {
      files.delete(norm(p));
    },
    mkdirp: async (dir) => {
      addDir(dir);
    },
    writeFile: async (p, content) => {
      files.set(norm(p), { content, mtimeMs: 0 });
    },
  };

  return {
    files,
    addDir,
    addFile,
    addSymbolicLink,
    fsDeps,
    read: (p: string) => files.get(norm(p))?.content,
    has: (p: string) => files.has(norm(p)),
  };
}

type MemFs = ReturnType<typeof createMemFs>;

function makeDeps(
  memfs: MemFs,
  overrides: Partial<
    Pick<LegacyUserDataMigrationDeps, 'legacyDirNames' | 'ui' | 'currentUserEmail' | 'copyDatabase'>
  > = {},
): { deps: LegacyUserDataMigrationDeps; phases: LegacyMigrationPhase[] } {
  const phases: LegacyMigrationPhase[] = [];
  const deps: LegacyUserDataMigrationDeps = {
    userDataDir: USER_DATA,
    legacyDirNames: overrides.legacyDirNames ?? ['xdmaker-meka'],
    legacyDbPrefixes: ['xdt-maker'],
    currentDbPrefix: 'cindy-meka',
    currentUserEmail: overrides.currentUserEmail,
    fs: memfs.fsDeps,
    copyDatabase: overrides.copyDatabase,
    now: () => new Date('2026-07-17T08:00:00.000Z'),
    log: { info: vi.fn(), warn: vi.fn() },
    ui: overrides.ui ?? {
      publish: (p) => phases.push(p),
      waitForConfirm: async () => {},
    },
  };
  return { deps, phases };
}

const markerPath = path.join(USER_DATA, LEGACY_MIGRATION_MARKER_FILENAME);

function readMarker(memfs: MemFs): Record<string, unknown> {
  const raw = memfs.read(markerPath);
  expect(raw).toBeTruthy();
  return JSON.parse(raw as string) as Record<string, unknown>;
}

describe('runLegacyUserDataMigration', () => {
  it('marker 已存在 → 直接返回,不弹窗不写盘', async () => {
    const memfs = createMemFs();
    memfs.addDir(USER_DATA);
    memfs.addDir(LEGACY);
    memfs.addFile(markerPath, '{"schemaVersion":1}');
    const writeSpy = vi.spyOn(memfs.fsDeps, 'writeFile');
    const { deps, phases } = makeDeps(memfs);

    const result = await runLegacyUserDataMigration('u1', deps);

    expect(result).toEqual({ status: 'marker-exists' });
    expect(phases).toEqual([]);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('老目录不存在 → 静默写 marker 返回,不弹窗', async () => {
    const memfs = createMemFs();
    memfs.addDir(USER_DATA);
    const { deps, phases } = makeDeps(memfs);

    const result = await runLegacyUserDataMigration('u1', deps);

    expect(result).toEqual({ status: 'no-legacy-dir' });
    expect(phases).toEqual([]);
    expect(readMarker(memfs)).toEqual({
      schemaVersion: 1,
      migratedAt: '2026-07-17T08:00:00.000Z',
      userId: 'u1',
      sourceDb: null,
      mediaCopied: false,
      dialoguesCopied: false,
      browserProfileCopied: false,
      mekaSettingsCopied: false,
      mekaRolesCopied: false,
    });
  });

  it('源库精确命中 <prefix>-<userId>.db 优先于 mtime 更新的其它库', async () => {
    const memfs = createMemFs();
    memfs.addDir(USER_DATA);
    memfs.addFile(path.join(LEGACY, 'xdt-maker-u1.db'), 'db-u1', 100);
    memfs.addFile(path.join(LEGACY, 'xdt-maker-other.db'), 'db-other', 9999);
    const { deps, phases } = makeDeps(memfs);

    const result = await runLegacyUserDataMigration('u1', deps);

    expect(result).toEqual({
      status: 'migrated',
      sourceDb: 'xdt-maker-u1.db',
      mediaCopied: false,
      dialoguesCopied: false,
      browserProfileCopied: false,
      mekaSettingsCopied: false,
      mekaRolesCopied: false,
    });
    expect(memfs.read(path.join(USER_DATA, 'cindy-meka-u1.db'))).toBe('db-u1');
    expect(phases).toEqual(['confirm', 'running', 'done']);
    expect(readMarker(memfs)).toMatchObject({ sourceDb: 'xdt-maker-u1.db', mediaCopied: false });
    // 全程只读老目录:源库仍在。
    expect(memfs.read(path.join(LEGACY, 'xdt-maker-u1.db'))).toBe('db-u1');
  });

  it('直接来源不存在时仍接管更早的 xdt-maker userData', async () => {
    const memfs = createMemFs();
    const olderLegacy = path.join(BASE, 'xdt-maker');
    memfs.addDir(USER_DATA);
    memfs.addFile(path.join(olderLegacy, 'xdt-maker-u1.db'), 'older-db', 100);
    const { deps } = makeDeps(memfs, {
      legacyDirNames: ['xdmaker-meka', 'xdt-maker'],
    });

    const result = await runLegacyUserDataMigration('u1', deps);

    expect(result).toMatchObject({ status: 'migrated', sourceDb: 'xdt-maker-u1.db' });
    expect(memfs.read(path.join(USER_DATA, 'cindy-meka-u1.db'))).toBe('older-db');
    expect(memfs.read(path.join(olderLegacy, 'xdt-maker-u1.db'))).toBe('older-db');
  });

  it('无身份锚且存在多个真实库 → fail closed，不按 mtime 猜测', async () => {
    const memfs = createMemFs();
    memfs.addDir(USER_DATA);
    memfs.addFile(path.join(LEGACY, 'xdt-maker-old.db'), 'db-old', 100);
    memfs.addFile(path.join(LEGACY, 'xdt-maker-new.db'), 'db-new', 200);
    memfs.addFile(path.join(LEGACY, 'unrelated-u1.db'), 'not-mine', 9999);
    memfs.addFile(path.join(LEGACY, 'xdt-maker-new.db-wal'), 'wal', 9999); // 非 .db 结尾,不算候选
    const { deps } = makeDeps(memfs);

    const result = await runLegacyUserDataMigration('u1', deps);

    expect(result).toMatchObject({ status: 'failed' });
    expect(memfs.has(path.join(USER_DATA, 'cindy-meka-u1.db'))).toBe(false);
    expect(memfs.has(markerPath)).toBe(false);
  });

  it('新旧 UID 不同 → 按旧 Meka identity anchor 的 email 精确认领主库', async () => {
    const memfs = createMemFs();
    memfs.addDir(USER_DATA);
    memfs.addFile(
      path.join(LEGACY, 'migration', 'identity-anchor.json'),
      JSON.stringify({
        schemaVersion: 1,
        accounts: [
          {
            userId: 'old-auth-user',
            email: ' User@Example.com ',
            feishuOpenId: 'ou_old',
            lastSeenAt: '2026-07-17T00:00:00.000Z',
          },
        ],
      }),
    );
    memfs.addFile(path.join(LEGACY, 'xdt-maker-old-auth-user.db'), 'anchored-db', 100);
    memfs.addFile(path.join(LEGACY, 'xdt-maker-other-user.db'), 'other-db', 9999);
    memfs.addFile(path.join(LEGACY, 'xdt-maker-__smoke_test__.db'), 'smoke-db', 10000);
    const { deps } = makeDeps(memfs, { currentUserEmail: 'user@example.com' });

    const result = await runLegacyUserDataMigration('new-auth-user', deps);

    expect(result).toMatchObject({
      status: 'migrated',
      sourceDb: 'xdt-maker-old-auth-user.db',
    });
    expect(memfs.read(path.join(USER_DATA, 'cindy-meka-new-auth-user.db'))).toBe('anchored-db');
  });

  it('identity anchor 存在但不匹配当前 email → 不降级猜单库', async () => {
    const memfs = createMemFs();
    memfs.addDir(USER_DATA);
    memfs.addFile(
      path.join(LEGACY, 'migration', 'identity-anchor.json'),
      JSON.stringify({
        schemaVersion: 1,
        accounts: [{ userId: 'old-auth-user', email: 'other@example.com' }],
      }),
    );
    memfs.addFile(path.join(LEGACY, 'xdt-maker-old-auth-user.db'), 'only-db', 100);
    const { deps } = makeDeps(memfs, { currentUserEmail: 'user@example.com' });

    const result = await runLegacyUserDataMigration('new-auth-user', deps);

    expect(result).toMatchObject({ status: 'failed' });
    expect(memfs.has(path.join(USER_DATA, 'cindy-meka-new-auth-user.db'))).toBe(false);
    expect(memfs.has(markerPath)).toBe(false);
  });

  it('无精确命中时永久排除 packaged smoke DB，即使它的 mtime 更新', async () => {
    const memfs = createMemFs();
    memfs.addDir(USER_DATA);
    memfs.addFile(path.join(LEGACY, 'xdt-maker-real-user.db'), 'real-db', 100);
    memfs.addFile(path.join(LEGACY, 'xdt-maker-__smoke_test__.db'), 'empty-smoke-db', 9999);
    const { deps } = makeDeps(memfs);

    const result = await runLegacyUserDataMigration('new-auth-user', deps);

    expect(result).toMatchObject({ status: 'migrated', sourceDb: 'xdt-maker-real-user.db' });
    expect(memfs.read(path.join(USER_DATA, 'cindy-meka-new-auth-user.db'))).toBe('real-db');
  });

  it('已误迁 smoke DB 的 marker 会备份错误目标并从真实旧库修复', async () => {
    const memfs = createMemFs();
    const targetDb = path.join(USER_DATA, 'cindy-meka-new-auth-user.db');
    memfs.addDir(USER_DATA);
    memfs.addFile(
      markerPath,
      JSON.stringify({ schemaVersion: 1, sourceDb: 'xdt-maker-__smoke_test__.db' }),
    );
    memfs.addFile(targetDb, 'copied-smoke-db');
    memfs.addFile(`${targetDb}-wal`, 'copied-smoke-wal');
    memfs.addFile(`${targetDb}.migration-runtime.json`, 'smoke-runtime-identity');
    memfs.addFile(path.join(LEGACY, 'xdt-maker-real-user.db'), 'real-db', 100);
    memfs.addFile(path.join(LEGACY, 'xdt-maker-real-user.db-wal'), 'real-wal', 100);
    memfs.addFile(path.join(LEGACY, 'xdt-maker-__smoke_test__.db'), 'empty-smoke-db', 9999);
    const { deps, phases } = makeDeps(memfs);

    const result = await runLegacyUserDataMigration('new-auth-user', deps);

    expect(result).toMatchObject({ status: 'migrated', sourceDb: 'xdt-maker-real-user.db' });
    expect(memfs.read(targetDb)).toBe('real-db');
    expect(memfs.read(`${targetDb}-wal`)).toBe('real-wal');
    expect(memfs.read(`${targetDb}${SMOKE_MIGRATION_BACKUP_SUFFIX}`)).toBe('copied-smoke-db');
    expect(memfs.read(`${targetDb}-wal${SMOKE_MIGRATION_BACKUP_SUFFIX}`)).toBe('copied-smoke-wal');
    expect(memfs.read(`${targetDb}.migration-runtime.json${SMOKE_MIGRATION_BACKUP_SUFFIX}`)).toBe(
      'smoke-runtime-identity',
    );
    expect(memfs.has(`${targetDb}.migration-runtime.json`)).toBe(false);
    expect(readMarker(memfs)).toMatchObject({ sourceDb: 'xdt-maker-real-user.db' });
    expect(phases).toEqual(['confirm', 'running', 'done']);
  });

  it('smoke 误迁修复找不到真实旧库时保持原 marker 和目标库，留待下次重试', async () => {
    const memfs = createMemFs();
    const targetDb = path.join(USER_DATA, 'cindy-meka-new-auth-user.db');
    const poisonedMarker = JSON.stringify({
      schemaVersion: 1,
      sourceDb: 'xdt-maker-__smoke_test__.db',
    });
    memfs.addDir(USER_DATA);
    memfs.addFile(markerPath, poisonedMarker);
    memfs.addFile(targetDb, 'copied-smoke-db');
    memfs.addFile(path.join(LEGACY, 'xdt-maker-__smoke_test__.db'), 'empty-smoke-db', 9999);
    const { deps, phases } = makeDeps(memfs);

    const result = await runLegacyUserDataMigration('new-auth-user', deps);

    expect(result).toMatchObject({ status: 'failed' });
    expect(memfs.read(targetDb)).toBe('copied-smoke-db');
    expect(memfs.read(markerPath)).toBe(poisonedMarker);
    expect(phases).toEqual(['confirm', 'running', 'failed']);
  });

  it('wal / shm 附属文件跟随复制并按新库名改名', async () => {
    const memfs = createMemFs();
    memfs.addDir(USER_DATA);
    memfs.addFile(path.join(LEGACY, 'xdt-maker-u1.db'), 'db', 1);
    memfs.addFile(path.join(LEGACY, 'xdt-maker-u1.db-wal'), 'wal', 1);
    memfs.addFile(path.join(LEGACY, 'xdt-maker-u1.db-shm'), 'shm', 1);
    const { deps } = makeDeps(memfs);

    await runLegacyUserDataMigration('u1', deps);

    expect(memfs.read(path.join(USER_DATA, 'cindy-meka-u1.db-wal'))).toBe('wal');
    expect(memfs.read(path.join(USER_DATA, 'cindy-meka-u1.db-shm'))).toBe('shm');
  });

  it('生产 copyDatabase 注入口生成完整主库时不混入源 wal/shm', async () => {
    const memfs = createMemFs();
    memfs.addDir(USER_DATA);
    const sourceDb = path.join(LEGACY, 'xdt-maker-u1.db');
    const targetDb = path.join(USER_DATA, 'cindy-meka-u1.db');
    memfs.addFile(sourceDb, 'raw-db', 1);
    memfs.addFile(`${sourceDb}-wal`, 'committed-in-wal', 1);
    const copyDatabase = vi.fn(async (_sourcePath: string, temporaryTargetPath: string) => {
      memfs.addFile(temporaryTargetPath, 'online-backup-db');
    });
    const { deps } = makeDeps(memfs, { copyDatabase });

    const result = await runLegacyUserDataMigration('u1', deps);

    expect(result).toMatchObject({ status: 'migrated', sourceDb: 'xdt-maker-u1.db' });
    expect(copyDatabase).toHaveBeenCalledWith(sourceDb, `${targetDb}.mtoc-tmp`);
    expect(memfs.read(targetDb)).toBe('online-backup-db');
    expect(memfs.has(`${targetDb}-wal`)).toBe(false);
  });

  it('目标库已存在 → 跳过复制不覆盖,media 与 marker 照常', async () => {
    const memfs = createMemFs();
    memfs.addDir(USER_DATA);
    memfs.addFile(path.join(USER_DATA, 'cindy-meka-u1.db'), 'existing-new-db');
    memfs.addFile(path.join(LEGACY, 'xdt-maker-u1.db'), 'legacy-db', 1);
    memfs.addFile(path.join(LEGACY, 'cindy-media', 'a.png'), 'legacy-a');
    const { deps, phases } = makeDeps(memfs);

    const result = await runLegacyUserDataMigration('u1', deps);

    expect(result).toEqual({
      status: 'migrated',
      sourceDb: null,
      mediaCopied: true,
      dialoguesCopied: false,
      browserProfileCopied: false,
      mekaSettingsCopied: false,
      mekaRolesCopied: false,
    });
    expect(memfs.read(path.join(USER_DATA, 'cindy-meka-u1.db'))).toBe('existing-new-db');
    expect(memfs.read(path.join(USER_DATA, 'cindy-media', 'a.png'))).toBe('legacy-a');
    expect(phases).toEqual(['confirm', 'running', 'done']);
    expect(readMarker(memfs)).toMatchObject({ sourceDb: null, mediaCopied: true });
  });

  it('老目录没有任何源库 → 跳过 db 步骤,仍做 media 迁移', async () => {
    const memfs = createMemFs();
    memfs.addDir(USER_DATA);
    memfs.addDir(LEGACY);
    memfs.addFile(path.join(LEGACY, 'cindy-media', 'b.mp4'), 'video');
    const { deps } = makeDeps(memfs);

    const result = await runLegacyUserDataMigration('u1', deps);

    expect(result).toEqual({
      status: 'migrated',
      sourceDb: null,
      mediaCopied: true,
      dialoguesCopied: false,
      browserProfileCopied: false,
      mekaSettingsCopied: false,
      mekaRolesCopied: false,
    });
    expect(memfs.has(path.join(USER_DATA, 'cindy-meka-u1.db'))).toBe(false);
    expect(memfs.read(path.join(USER_DATA, 'cindy-media', 'b.mp4'))).toBe('video');
  });

  it('cindy-media 递归 merge:同名同字节的目标文件不覆盖,缺的补齐', async () => {
    const memfs = createMemFs();
    memfs.addDir(USER_DATA);
    memfs.addDir(LEGACY);
    memfs.addFile(path.join(LEGACY, 'cindy-media', 'blobs', 'a.png'), 'legacy-a');
    memfs.addFile(path.join(LEGACY, 'cindy-media', 'blobs', 'b.png'), 'legacy-b');
    // 同字节数(8)不同内容:视为已存在成品,保留不覆盖。
    memfs.addFile(path.join(USER_DATA, 'cindy-media', 'blobs', 'a.png'), 'newer-a!');
    const { deps } = makeDeps(memfs);

    const result = await runLegacyUserDataMigration('u1', deps);

    expect(result).toMatchObject({ status: 'migrated', mediaCopied: true });
    expect(memfs.read(path.join(USER_DATA, 'cindy-media', 'blobs', 'a.png'))).toBe('newer-a!');
    expect(memfs.read(path.join(USER_DATA, 'cindy-media', 'blobs', 'b.png'))).toBe('legacy-b');
  });

  it('cindy-media 字节数不一致的同名文件 = 截断残留 → 重拷修复', async () => {
    const memfs = createMemFs();
    memfs.addDir(USER_DATA);
    memfs.addDir(LEGACY);
    memfs.addFile(path.join(LEGACY, 'cindy-media', 'blobs', 'a.png'), 'full-content');
    memfs.addFile(path.join(USER_DATA, 'cindy-media', 'blobs', 'a.png'), 'trunc'); // 上次截断
    const { deps } = makeDeps(memfs);

    await runLegacyUserDataMigration('u1', deps);

    expect(memfs.read(path.join(USER_DATA, 'cindy-media', 'blobs', 'a.png'))).toBe('full-content');
  });

  it('db 半成品防线:崩溃残留的 .mtoc-tmp 被清理重拷,最终名一次 rename 入位', async () => {
    const memfs = createMemFs();
    memfs.addDir(USER_DATA);
    memfs.addFile(path.join(LEGACY, 'xdt-maker-u1.db'), 'good-db', 1);
    // 模拟上次拷贝中途崩溃:tmp 残留、最终名不存在。
    memfs.addFile(path.join(USER_DATA, 'cindy-meka-u1.db.mtoc-tmp'), 'trunca');
    const { deps } = makeDeps(memfs);

    const result = await runLegacyUserDataMigration('u1', deps);

    expect(result).toMatchObject({ status: 'migrated', sourceDb: 'xdt-maker-u1.db' });
    expect(memfs.read(path.join(USER_DATA, 'cindy-meka-u1.db'))).toBe('good-db');
    expect(memfs.has(path.join(USER_DATA, 'cindy-meka-u1.db.mtoc-tmp'))).toBe(false);
  });

  it('跨 attempt 孤儿 sidecar:源侧无 wal 时,残留在最终名上的旧 wal 被清掉', async () => {
    const memfs = createMemFs();
    memfs.addDir(USER_DATA);
    memfs.addFile(path.join(LEGACY, 'xdt-maker-u1.db'), 'db', 1); // 源侧无 wal/shm
    // 上次 attempt 在「wal 已入位、db 未入位」窗口崩溃的残留。
    memfs.addFile(path.join(USER_DATA, 'cindy-meka-u1.db-wal'), 'stale-wal');
    const { deps } = makeDeps(memfs);

    const result = await runLegacyUserDataMigration('u1', deps);

    expect(result).toMatchObject({ status: 'migrated', sourceDb: 'xdt-maker-u1.db' });
    expect(memfs.read(path.join(USER_DATA, 'cindy-meka-u1.db'))).toBe('db');
    expect(memfs.has(path.join(USER_DATA, 'cindy-meka-u1.db-wal'))).toBe(false);
  });

  it('目标库已存在时清理崩溃残留的 tmp 文件', async () => {
    const memfs = createMemFs();
    memfs.addDir(USER_DATA);
    memfs.addFile(path.join(USER_DATA, 'cindy-meka-u1.db'), 'existing');
    memfs.addFile(path.join(USER_DATA, 'cindy-meka-u1.db.mtoc-tmp'), 'stale');
    memfs.addFile(path.join(USER_DATA, 'cindy-meka-u1.db-wal.mtoc-tmp'), 'stale-wal');
    memfs.addFile(path.join(LEGACY, 'xdt-maker-u1.db'), 'legacy', 1);
    const { deps } = makeDeps(memfs);

    await runLegacyUserDataMigration('u1', deps);

    expect(memfs.read(path.join(USER_DATA, 'cindy-meka-u1.db'))).toBe('existing');
    expect(memfs.has(path.join(USER_DATA, 'cindy-meka-u1.db.mtoc-tmp'))).toBe(false);
    expect(memfs.has(path.join(USER_DATA, 'cindy-meka-u1.db-wal.mtoc-tmp'))).toBe(false);
  });

  it('复制阶段失败 → 不写 marker、推 failed、返回 failed(不 throw)', async () => {
    const memfs = createMemFs();
    memfs.addDir(USER_DATA);
    memfs.addFile(path.join(LEGACY, 'xdt-maker-u1.db'), 'db', 1);
    memfs.addFile(path.join(LEGACY, 'cindy-media', 'a.png'), 'a');
    vi.spyOn(memfs.fsDeps, 'copyFile').mockRejectedValue(new Error('disk full'));
    const { deps, phases } = makeDeps(memfs);

    const result = await runLegacyUserDataMigration('u1', deps);

    expect(result).toEqual({ status: 'failed', error: 'disk full' });
    expect(memfs.has(markerPath)).toBe(false);
    // 失败时最终名不存在——半成品只可能以 tmp 名残留,不会被下次"已存在跳过"转正。
    expect(memfs.has(path.join(USER_DATA, 'cindy-meka-u1.db'))).toBe(false);
    expect(phases).toEqual(['confirm', 'running', 'failed']);
    expect(deps.log.warn).toHaveBeenCalled();
  });

  it('dialogues 无文件夹对话工作目录整树随迁,老目录只读保留', async () => {
    const memfs = createMemFs();
    memfs.addDir(USER_DATA);
    memfs.addDir(LEGACY);
    memfs.addFile(
      path.join(LEGACY, 'dialogues', '2026-06-22', 'sess-1', 'note.md'),
      'agent-output',
    );
    memfs.addFile(path.join(LEGACY, 'dialogues', '2026-05-20', 'sess-2', 'data.json'), '{}');
    // 空的 dialogue 工作目录(最常见形态)也要随迁成目录。
    memfs.addDir(path.join(LEGACY, 'dialogues', '2026-07-01', 'sess-3'));
    const { deps } = makeDeps(memfs);

    const result = await runLegacyUserDataMigration('u1', deps);

    expect(result).toMatchObject({ status: 'migrated', dialoguesCopied: true });
    expect(memfs.read(path.join(USER_DATA, 'dialogues', '2026-06-22', 'sess-1', 'note.md'))).toBe(
      'agent-output',
    );
    expect(memfs.read(path.join(USER_DATA, 'dialogues', '2026-05-20', 'sess-2', 'data.json'))).toBe(
      '{}',
    );
    // 老目录只读:源文件原样保留。
    expect(memfs.read(path.join(LEGACY, 'dialogues', '2026-06-22', 'sess-1', 'note.md'))).toBe(
      'agent-output',
    );
    expect(readMarker(memfs)).toMatchObject({ dialoguesCopied: true });
  });

  it('dialogues 跳过任意层级 node_modules 与符号链接,其余文件继续迁移', async () => {
    const memfs = createMemFs();
    memfs.addDir(USER_DATA);
    memfs.addDir(LEGACY);
    const workspace = path.join(LEGACY, 'dialogues', '2026-07-06', 'sess-1', 'XDMaker');
    memfs.addFile(path.join(workspace, 'src', 'index.ts'), 'source');
    memfs.addFile(
      path.join(workspace, 'apps', 'desktop', 'node_modules', 'plain-package', 'index.js'),
      'dependency',
    );
    // 复现线上报错形态:pnpm package 目录链接被 Dirent.isDirectory() 判为 false。
    memfs.addSymbolicLink(
      path.join(workspace, 'packages', 'feature', 'node_modules', '@cindy', 'orca-workflow'),
    );
    // node_modules 之外的链接也必须明确跳过，不能解引用到老目录外或形成递归环。
    memfs.addSymbolicLink(path.join(workspace, 'linked-workspace'));
    const listDirEntries = memfs.fsDeps.listDirEntries;
    vi.spyOn(memfs.fsDeps, 'listDirEntries').mockImplementation(async (dir) =>
      (await listDirEntries(dir)).map((entry) =>
        entry.name === 'linked-workspace'
          ? { ...entry, isDirectory: true, isSymbolicLink: true }
          : entry,
      ),
    );
    const copySpy = vi.spyOn(memfs.fsDeps, 'copyFile');
    const { deps } = makeDeps(memfs);

    const result = await runLegacyUserDataMigration('u1', deps);

    expect(result).toMatchObject({ status: 'migrated', dialoguesCopied: true });
    const migratedWorkspace = path.join(USER_DATA, 'dialogues', '2026-07-06', 'sess-1', 'XDMaker');
    expect(memfs.read(path.join(migratedWorkspace, 'src', 'index.ts'))).toBe('source');
    expect(
      memfs.has(
        path.join(
          migratedWorkspace,
          'apps',
          'desktop',
          'node_modules',
          'plain-package',
          'index.js',
        ),
      ),
    ).toBe(false);
    expect(memfs.has(path.join(migratedWorkspace, 'linked-workspace'))).toBe(false);
    expect(copySpy).not.toHaveBeenCalledWith(
      path.join(workspace, 'linked-workspace'),
      expect.any(String),
    );
    expect(readMarker(memfs)).toMatchObject({ dialoguesCopied: true });
  });

  it('老目录无 dialogues → 步骤跳过,dialoguesCopied=false', async () => {
    const memfs = createMemFs();
    memfs.addDir(USER_DATA);
    memfs.addFile(path.join(LEGACY, 'xdt-maker-u1.db'), 'db', 1);
    const { deps } = makeDeps(memfs);

    const result = await runLegacyUserDataMigration('u1', deps);

    expect(result).toMatchObject({ status: 'migrated', dialoguesCopied: false });
    expect(memfs.has(path.join(USER_DATA, 'dialogues'))).toBe(false);
  });

  it('agent 浏览器 profile:browser/XDMaker 复制为 browser/Cindy,缓存目录与 Singleton 锁跳过', async () => {
    const memfs = createMemFs();
    memfs.addDir(USER_DATA);
    memfs.addDir(LEGACY);
    const legacyProfile = path.join(LEGACY, 'browser-runtime', 'browser', 'XDMaker');
    memfs.addFile(path.join(legacyProfile, 'user-data', 'Local State'), 'local-state');
    memfs.addFile(path.join(legacyProfile, 'user-data', 'Default', 'Cookies'), 'cookies');
    memfs.addFile(
      path.join(legacyProfile, 'user-data', 'Default', 'Cache', 'blob0'),
      'cache-bytes',
    );
    memfs.addFile(
      path.join(legacyProfile, 'user-data', 'Default', 'Code Cache', 'js0'),
      'code-cache',
    );
    memfs.addFile(path.join(legacyProfile, 'user-data', 'SingletonLock'), 'lock');
    const { deps } = makeDeps(memfs);

    const result = await runLegacyUserDataMigration('u1', deps);

    expect(result).toMatchObject({ status: 'migrated', browserProfileCopied: true });
    const newProfile = path.join(USER_DATA, 'browser-runtime', 'browser', 'Cindy');
    // 登录态文件随迁到新品牌目录名下。
    expect(memfs.read(path.join(newProfile, 'user-data', 'Local State'))).toBe('local-state');
    expect(memfs.read(path.join(newProfile, 'user-data', 'Default', 'Cookies'))).toBe('cookies');
    // Chrome 重建型缓存与单实例锁不搬。
    expect(memfs.has(path.join(newProfile, 'user-data', 'Default', 'Cache', 'blob0'))).toBe(false);
    expect(memfs.has(path.join(newProfile, 'user-data', 'Default', 'Code Cache', 'js0'))).toBe(
      false,
    );
    expect(memfs.has(path.join(newProfile, 'user-data', 'SingletonLock'))).toBe(false);
    // 老目录只读:源 profile 原样保留。
    expect(memfs.read(path.join(legacyProfile, 'user-data', 'Default', 'Cookies'))).toBe('cookies');
    expect(readMarker(memfs)).toMatchObject({ browserProfileCopied: true });
  });

  it('老目录无 browser-runtime → profile 步骤跳过,browserProfileCopied=false', async () => {
    const memfs = createMemFs();
    memfs.addDir(USER_DATA);
    memfs.addFile(path.join(LEGACY, 'xdt-maker-u1.db'), 'db', 1);
    const { deps } = makeDeps(memfs);

    const result = await runLegacyUserDataMigration('u1', deps);

    expect(result).toMatchObject({ status: 'migrated', browserProfileCopied: false });
    expect(memfs.has(path.join(USER_DATA, 'browser-runtime'))).toBe(false);
  });

  it('迁移 Meka 非敏感设置与自定义角色，保留目标侧已经存在的新配置', async () => {
    const memfs = createMemFs();
    memfs.addDir(USER_DATA);
    memfs.addDir(LEGACY);
    memfs.addFile(path.join(LEGACY, 'meka-assistant-settings.json'), '{"p4Root":"C:\\\\P4"}');
    memfs.addFile(path.join(LEGACY, 'meka-roles', 'legacy-role.json'), '{"id":"legacy-role"}');
    memfs.addFile(path.join(LEGACY, 'meka-roles', 'keep-new.json'), '{"source":"legacy"}');
    memfs.addFile(path.join(USER_DATA, 'meka-roles', 'keep-new.json'), '{"source":"new"}');
    const { deps } = makeDeps(memfs);

    const result = await runLegacyUserDataMigration('u1', deps);

    expect(result).toMatchObject({
      status: 'migrated',
      mekaSettingsCopied: true,
      mekaRolesCopied: true,
    });
    expect(memfs.read(path.join(USER_DATA, 'meka-assistant-settings.json'))).toBe(
      '{"p4Root":"C:\\\\P4"}',
    );
    expect(memfs.read(path.join(USER_DATA, 'meka-roles', 'legacy-role.json'))).toBe(
      '{"id":"legacy-role"}',
    );
    expect(memfs.read(path.join(USER_DATA, 'meka-roles', 'keep-new.json'))).toBe(
      '{"source":"new"}',
    );
    expect(readMarker(memfs)).toMatchObject({
      mekaSettingsCopied: true,
      mekaRolesCopied: true,
    });
    expect(memfs.read(path.join(LEGACY, 'meka-assistant-settings.json'))).toBe(
      '{"p4Root":"C:\\\\P4"}',
    );
  });

  it('确认流程时序:confirm 先推送并阻塞,resolver 放行后才 running', async () => {
    const memfs = createMemFs();
    memfs.addDir(USER_DATA);
    memfs.addFile(path.join(LEGACY, 'xdt-maker-u1.db'), 'db', 1);
    const phases: LegacyMigrationPhase[] = [];
    let releaseConfirm: (() => void) | null = null;
    const { deps } = makeDeps(memfs, {
      ui: {
        publish: (p) => phases.push(p),
        waitForConfirm: () =>
          new Promise<void>((resolve) => {
            releaseConfirm = resolve;
          }),
      },
    });

    const resultPromise = runLegacyUserDataMigration('u1', deps);
    // 让流程推进到等待确认。
    await vi.waitFor(() => {
      expect(phases).toEqual(['confirm']);
      expect(releaseConfirm).not.toBeNull();
    });
    // 确认前:不复制、不写 marker。
    expect(memfs.has(path.join(USER_DATA, 'cindy-meka-u1.db'))).toBe(false);
    expect(memfs.has(markerPath)).toBe(false);

    releaseConfirm!();
    const result = await resultPromise;

    expect(result).toMatchObject({ status: 'migrated', sourceDb: 'xdt-maker-u1.db' });
    expect(phases).toEqual(['confirm', 'running', 'done']);
    expect(memfs.has(markerPath)).toBe(true);
  });
});

describe('shouldSkipLegacyMigrationForDevSandbox', () => {
  it('dev + XDT_USER_DATA_DIR 生效(--isolated 沙箱 / 手动覆写)→ 跳过', () => {
    expect(
      shouldSkipLegacyMigrationForDevSandbox({
        isPackaged: false,
        envUserDataDir: path.join(BASE, 'CindyMeka-dev'),
      }),
    ).toBe(true);
  });

  it('dev 共库(未覆写 userData)→ 不跳过,保持与 packaged 行为一致', () => {
    expect(
      shouldSkipLegacyMigrationForDevSandbox({ isPackaged: false, envUserDataDir: undefined }),
    ).toBe(false);
    expect(shouldSkipLegacyMigrationForDevSandbox({ isPackaged: false, envUserDataDir: '' })).toBe(
      false,
    );
    expect(
      shouldSkipLegacyMigrationForDevSandbox({ isPackaged: false, envUserDataDir: '   ' }),
    ).toBe(false);
  });

  it('packaged 永不跳过(即使残留同名 env)', () => {
    expect(
      shouldSkipLegacyMigrationForDevSandbox({
        isPackaged: true,
        envUserDataDir: path.join(BASE, 'anything'),
      }),
    ).toBe(false);
  });
});

describe('copyDatabaseVerified', () => {
  it('SQLite online backup 会合入活跃 WAL 中的已提交会话并产出完整主库', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-meka-legacy-db-copy-'));
    const sourcePath = path.join(tempDir, 'xdt-maker-old-user.db');
    const targetPath = path.join(tempDir, 'cindy-meka-new-user.db');
    const source = createBetterSqliteDatabase(sourcePath);
    try {
      source.pragma('journal_mode = WAL');
      source.exec(`
        CREATE TABLE migration_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT);
        CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT, content TEXT);
        INSERT INTO migration_meta (key, value) VALUES ('schema_version', '1');
        INSERT INTO sessions (id, title) VALUES ('legacy-session', 'Legacy session');
        INSERT INTO messages (id, session_id, content)
        VALUES ('legacy-message', 'legacy-session', 'from WAL');
      `);
      expect(fs.existsSync(`${sourcePath}-wal`)).toBe(true);

      await copyDatabaseVerified(sourcePath, targetPath);

      const target = createBetterSqliteDatabase(targetPath, {
        readonly: true,
        fileMustExist: true,
      });
      try {
        expect(
          target.prepare(`SELECT title FROM sessions WHERE id = 'legacy-session'`).get(),
        ).toEqual({ title: 'Legacy session' });
        expect(
          target.prepare(`SELECT content FROM messages WHERE id = 'legacy-message'`).get(),
        ).toEqual({ content: 'from WAL' });
        expect(target.pragma('quick_check')).toEqual([{ quick_check: 'ok' }]);
      } finally {
        target.close();
      }
    } finally {
      source.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
