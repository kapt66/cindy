import { describe, expect, it } from 'vitest';

import {
  resolveLocalDbFatalView,
  type UpdateStatusValue,
} from '../components/error/localDbFatalView';

describe('resolveLocalDbFatalView', () => {
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

  it('error + update_apply_exhausted → apply-exhausted（手动安装，不再是死按钮）', () => {
    // 落入 no-update 时主按钮是「检查更新」，而主进程对已放弃版本只会返回同一结论、
    // 不下载，结果又被 .catch 吞掉 ⇒ 按钮点了永远没反应，且页面没有任何手动安装入口。
    expect(resolveLocalDbFatalView('error', 'update_apply_exhausted')).toBe('apply-exhausted');
  });

  it('其它 errorCode 仍按 status 归类（专用终态不吞掉既有恢复路径）', () => {
    expect(resolveLocalDbFatalView('error', 'updater_spawn_failed')).toBe('no-update');
    expect(resolveLocalDbFatalView('error', 'translocated')).toBe('no-update');
    expect(resolveLocalDbFatalView('ready', 'update_apply_exhausted')).toBe('install-update');
    expect(resolveLocalDbFatalView('downloading', 'update_apply_exhausted')).toBe('preparing-update');
  });
});
