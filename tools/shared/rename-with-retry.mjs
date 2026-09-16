/**
 * rename-with-retry —— 同卷原子改名的有界退避重试（Windows 目录落位专用）。
 *
 * 背景（2026-09-16 在本机 XINDONG-PC 实测复现）：Windows 上刚创建/刚读过的 `.exe` 会被
 * 系统级安全扫描或预读组件短暂持有句柄，此时 rename 一个**包含它的目录**会返回
 * `EPERM`/`EACCES`；改名单个文件、或往目录里写新文件都不受影响。目录分发的 agent runtime
 * （`tools/codex-package/update.mjs`）用「staging 目录 → 最终目录」的原子改名落位，于是这一步在
 * 发布机上会间歇性失败（实测同一路径连续尝试 50%~100% 失败），本轮 Windows canary 发布
 * 因此失败并被上层误报成「应用在运行」。
 *
 * 实测同一目录在触发后约 1s 再 rename 即成功，故用有界退避覆盖这段瞬时窗口；真正被
 * 运行中镜像占用（应用没关）时仍会在重试耗尽后失败，由调用方给出「关闭应用」的提示。
 * 逐条实测数据与复现口径见 docs/dev-rules/agent-runtime-release.md。
 *
 * 注意：调用方全是同步流程（promote 不能改成 async），所以退避用同步 sleep。
 */
import fs from 'node:fs';

import { describeErrorChain } from './runtime-install-error.mjs';

/** Windows 上 rename 被瞬时占用挡住时返回的 errno；其余错误（ENOENT/EEXIST…）立即失败。 */
const RETRYABLE_RENAME_CODES = Object.freeze(['EPERM', 'EACCES', 'EBUSY', 'ETXTBSY']);

/**
 * 落位改名（staging → 目标）的退避预算：锁来自刚写入目标目录的 `.exe`，是瞬时窗口，
 * 给足预算（累计 7.75s）。CI 发布失败一次的代价远高于多等几秒。
 */
export const PLACEMENT_RENAME_RETRY_DELAYS_MS = Object.freeze([250, 500, 1000, 2000, 4000]);

/**
 * 换下旧目录（目标 → 备份）的退避预算：这里的锁更可能来自旧目录里**正在运行的镜像**
 * （应用没关），那不是一个会自动消失的窗口，所以只覆盖扫描窗口后尽快失败，避免每次
 * dev 启动都要白等十几秒。
 */
export const SWAP_RENAME_RETRY_DELAYS_MS = Object.freeze([250, 750]);

export function isRetryableRenameError(error) {
  return typeof error?.code === 'string' && RETRYABLE_RENAME_CODES.includes(error.code);
}

/**
 * 同步 sleep。promote 全程同步，不能为退避把调用链改成 async；`Atomics.wait` 是主线程上
 * 唯一可靠的同步等待方式（不烧 CPU）。
 */
export function sleepSync(ms) {
  if (!(ms > 0)) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameFailure(error, { fromPath, toPath, attempts, elapsedMs }) {
  const cause = error instanceof Error ? error : new Error(String(error));
  const wrapped = new Error(
    `rename failed after ${attempts} attempt(s) over ${elapsedMs}ms: ${fromPath} -> ${toPath}: ${describeErrorChain(cause)}`,
    { cause },
  );
  // 保留 errno：调用方（isTargetLockError 等）的既有判定继续生效。
  if (typeof cause.code === 'string') wrapped.code = cause.code;
  wrapped.attempts = attempts;
  wrapped.elapsedMs = elapsedMs;
  return wrapped;
}

/**
 * 执行 `fromPath -> toPath` 的同卷改名，遇到可重试 errno 时按 `delaysMs` 退避重试。
 *
 * @param {string} fromPath
 * @param {string} toPath
 * @param {object} [options]
 * @param {readonly number[]} [options.delaysMs] 每次失败后的等待时长；长度即重试次数上限。
 * @param {(from: string, to: string, options?: object) => void} [options.rename] 注入缝（单测用）。
 * @param {(ms: number) => void} [options.sleep] 注入缝（单测用）。
 * @returns {{ attempts: number, elapsedMs: number }}
 * @throws 重试耗尽或不可重试时抛出带 `code` / `attempts` / `elapsedMs` / `cause` 的错误。
 */
export function renameWithRetry(fromPath, toPath, options = {}) {
  const {
    delaysMs = PLACEMENT_RENAME_RETRY_DELAYS_MS,
    rename = fs.renameSync,
    sleep = sleepSync,
  } = options;

  const startedAt = Date.now();
  let attempts = 0;
  for (;;) {
    attempts += 1;
    try {
      rename(fromPath, toPath);
      return { attempts, elapsedMs: Date.now() - startedAt };
    } catch (error) {
      const delayMs = delaysMs[attempts - 1];
      if (delayMs === undefined || !isRetryableRenameError(error)) {
        throw renameFailure(error, {
          fromPath,
          toPath,
          attempts,
          elapsedMs: Date.now() - startedAt,
        });
      }
      sleep(delayMs);
    }
  }
}
