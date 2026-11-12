import { describe, expect, it } from 'vitest';

import {
  resolveLocalDbFatalView,
  type UpdateStatusValue,
} from '../components/error/localDbFatalView';

describe('resolveLocalDbFatalView', () => {
  it.each(['ready', 'downloading', 'idle'] as const)('schema lock failure offers DB retry regardless of update status %s (#7135)', (status) => {
    expect(resolveLocalDbFatalView(status, 'DB_SCHEMA_LOCKED')).toBe('retry-local-db');
  });
  it('ready → install-update（补丁就绪，可一键重启安装）', () => {
    expect(resolveLocalDbFatalView('ready')).toBe('install-update');
  });

  it('checking / downloading / superseding → preparing-update（等待，禁止 relaunch）', () => {
    const preparing: UpdateStatusValue[] = ['checking', 'downloading', 'superseding'];
    for (const status of preparing) {
      expect(resolveLocalDbFatalView(status)).toBe('preparing-update');
    }
  });

  it('idle / error / undefined → no-update（引导重新检查更新）', () => {
    expect(resolveLocalDbFatalView('idle')).toBe('no-update');
    expect(resolveLocalDbFatalView('error')).toBe('no-update');
    expect(resolveLocalDbFatalView(undefined)).toBe('no-update');
  });

  // W28:更新器 errorCode 与本地库故障码是两个不同来源,分别占第二 / 第三位参数
  // (`code` / `updateErrorCode`),因此更新器码一律走第三位。
  it('error + update_apply_exhausted → apply-exhausted（手动安装，不再是死按钮）', () => {
    // 落入 no-update 时主按钮是「检查更新」，而主进程对已放弃版本只会返回同一结论、
    // 不下载，结果又被 .catch 吞掉 ⇒ 按钮点了永远没反应，且页面没有任何手动安装入口。
    expect(resolveLocalDbFatalView('error', undefined, 'update_apply_exhausted')).toBe('apply-exhausted');
  });

  it('其它 errorCode 仍按 status 归类（专用终态不吞掉既有恢复路径）', () => {
    expect(resolveLocalDbFatalView('error', undefined, 'updater_spawn_failed')).toBe('no-update');
    expect(resolveLocalDbFatalView('error', undefined, 'translocated')).toBe('no-update');
    expect(resolveLocalDbFatalView('ready', undefined, 'update_apply_exhausted')).toBe('install-update');
    expect(resolveLocalDbFatalView('downloading', undefined, 'update_apply_exhausted')).toBe('preparing-update');
  });

  it('DB_INIT_FAILED → init-failed、DB_CORRUPT_NO_BACKUP → corrupt（与更新状态无关，不引导更新）', () => {
    const statuses: (UpdateStatusValue | undefined)[] = ['ready', 'checking', 'idle', 'error', undefined];
    for (const status of statuses) {
      expect(resolveLocalDbFatalView(status, 'DB_INIT_FAILED')).toBe('init-failed');
      expect(resolveLocalDbFatalView(status, 'DB_CORRUPT_NO_BACKUP')).toBe('corrupt');
    }
  });

  it('MIGRATE_FAILED / 未知码仍按更新状态映射（保持原行为）', () => {
    expect(resolveLocalDbFatalView('ready', 'MIGRATE_FAILED')).toBe('install-update');
    expect(resolveLocalDbFatalView('idle', 'MIGRATE_FAILED')).toBe('no-update');
    expect(resolveLocalDbFatalView('ready', undefined)).toBe('install-update');
  });
});
