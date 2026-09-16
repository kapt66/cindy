// renameWithRetry 的单测。
//
// 背景：Windows 上刚写入的 `.exe` 会被安全扫描/预读组件短暂持有句柄，rename 一个包含它的
// 目录会返回 EPERM（2026-09-16 Windows canary 发布失败的真因）。这里用注入的 rename/sleep
// 固定住「重试语义 + 预算 + 错误保真」，不依赖机器上真的存在占用，也不会真的等待。
// node 内置 test runner，无 vitest 依赖：`node --test scripts/__tests__/rename-with-retry.test.mjs`。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  PLACEMENT_RENAME_RETRY_DELAYS_MS,
  SWAP_RENAME_RETRY_DELAYS_MS,
  isRetryableRenameError,
  renameWithRetry,
  sleepSync,
} from '../../tools/shared/rename-with-retry.mjs';

function lockedError(code = 'EPERM') {
  return Object.assign(new Error(`EPERM: operation not permitted, rename 'from' -> 'to'`), { code });
}

test('renameWithRetry: retries a transient Windows lock and reports attempts', () => {
  const slept = [];
  let calls = 0;
  const rename = () => {
    calls += 1;
    if (calls <= 2) throw lockedError();
  };
  const result = renameWithRetry('from', 'to', {
    delaysMs: [10, 20, 30],
    rename,
    sleep: (ms) => slept.push(ms),
  });
  assert.deepEqual(slept, [10, 20]);
  assert.equal(calls, 3);
  assert.equal(result.attempts, 3);
});

test('renameWithRetry: gives up after the delay budget and keeps errno + diagnosis', () => {
  const slept = [];
  let calls = 0;
  const rename = () => {
    calls += 1;
    throw lockedError('EBUSY');
  };
  assert.throws(
    () => renameWithRetry('from', 'to', { delaysMs: [1, 2], rename, sleep: (ms) => slept.push(ms) }),
    (error) => {
      assert.equal(error.code, 'EBUSY');
      assert.equal(error.attempts, 3);
      assert.equal(error.cause?.code, 'EBUSY');
      assert.match(error.message, /rename failed after 3 attempt\(s\)/);
      assert.match(error.message, /from -> to/);
      assert.match(error.message, /EPERM: operation not permitted/);
      return true;
    },
  );
  assert.deepEqual(slept, [1, 2]);
  assert.equal(calls, 3);
});

test('renameWithRetry: non-retryable errors fail immediately without sleeping', () => {
  const slept = [];
  assert.throws(
    () => renameWithRetry('from', 'to', {
      rename: () => { throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }); },
      sleep: (ms) => slept.push(ms),
    }),
    /ENOENT: no such file/,
  );
  assert.deepEqual(slept, []);
});

test('isRetryableRenameError: only transient in-use errnos are retried', () => {
  for (const code of ['EPERM', 'EACCES', 'EBUSY', 'ETXTBSY']) {
    assert.equal(isRetryableRenameError(Object.assign(new Error(code), { code })), true);
  }
  for (const code of ['ENOENT', 'EEXIST', 'ENOTEMPTY', 'EINVAL']) {
    assert.equal(isRetryableRenameError(Object.assign(new Error(code), { code })), false);
  }
  assert.equal(isRetryableRenameError(new Error('no code')), false);
});

test('retry budgets match the contract: placement >= 3s total, swap deliberately short', () => {
  assert.deepEqual([...SWAP_RENAME_RETRY_DELAYS_MS], [250, 750]);
  assert.ok(
    PLACEMENT_RENAME_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0) >= 3000,
    'placement retry budget must cover the measured ~1s lock window with margin',
  );
  // 备份改名面对的是"应用没关"这种真锁，不能把 dev 启动拖成十几秒。
  assert.ok(SWAP_RENAME_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0) <= 2000);
});

test('renameWithRetry: really moves a directory once the injected lock clears', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rename-retry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const from = path.join(root, 'win32-x64.staging');
  const to = path.join(root, 'win32-x64');
  fs.mkdirSync(path.join(from, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(from, 'bin', 'codex.exe'), 'codex');

  let calls = 0;
  const rename = (source, destination) => {
    calls += 1;
    if (calls === 1) throw lockedError(); // 第一次模拟"目录里有刚写入的 .exe 被占用"
    fs.renameSync(source, destination);
  };
  const result = renameWithRetry(from, to, { rename, sleep: () => {} });

  assert.equal(result.attempts, 2);
  assert.equal(fs.existsSync(from), false);
  assert.equal(fs.readFileSync(path.join(to, 'bin', 'codex.exe'), 'utf8'), 'codex');
});

test('sleepSync: actually waits without spinning the event loop', () => {
  const started = Date.now();
  sleepSync(40);
  assert.ok(Date.now() - started >= 30, 'sleepSync must block for the requested time');
});
