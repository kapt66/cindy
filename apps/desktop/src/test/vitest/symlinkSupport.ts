import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 本机能否真的创建符号链接 —— 只给测试用的能力探测。
 *
 * 背景：Windows 普通账号（非管理员、未开「开发者模式」）没有
 * `SeCreateSymbolicLinkPrivilege`，`fs.symlink` 一律 `EPERM`；而按仓库约定
 * （docs/dev-rules/engineering-conventions.md §4）**目录**链接在 Windows 上要写
 * `'junction'`（不需要特权），真正无法表达的是**文件**符号链接。所以：
 * - 目录链接：按平台分派 `'junction'` / `'dir'`，照常执行，不走本探测；
 * - 文件链接：用 `it.skipIf(!canCreateSymlinks())` 显式跳过 —— 只有这类用例在
 *   无特权 Windows 上跑不了，CI（Linux）与有权限的机器仍然执行；
 * - 同文件里不需要链接的用例继续执行，不要整文件 skip。
 *
 * 探测只看一次真实文件系统结果，与具体被测模块无关，也不读任何源码文本
 * （`check:test-hygiene` 的 source-read 规则不适用）。结果按 worker 进程缓存：
 * 一次探测约 1 毫秒，但没必要每个用例都建/删临时目录。
 */

// 「环境不支持」的错误码：无特权 Windows 给 EPERM/UNKNOWN，只读或受限文件系统给
// EACCES/ENOTSUP。其它错误（比如 ENOENT、ENOSPC）不是能力问题，按真实缺陷抛出。
const UNSUPPORTED_CODES = new Set(['EPERM', 'EACCES', 'ENOTSUP', 'UNKNOWN']);

interface SymlinkProbe {
  supported: boolean;
  reason: string | null;
}

let cached: SymlinkProbe | undefined;

function probeSymlinks(): SymlinkProbe {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-symlink-probe-'));
  try {
    const target = path.join(root, 'target');
    fs.writeFileSync(target, 'probe');
    // 只探测文件链接：它是这些用例里最严的一档能力。Windows 上创建文件与目录符号链接
    // 用的是同一个特权，而目录链接另有不需要特权的 junction，所以这里探 symlink 本身。
    const link = path.join(root, 'link');
    fs.symlinkSync(target, link);
    if (!fs.lstatSync(link).isSymbolicLink()) {
      return { supported: false, reason: `symlink probe produced a non-link at ${link}` };
    }
    return { supported: true, reason: null };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? '';
    if (UNSUPPORTED_CODES.has(code)) {
      return {
        supported: false,
        reason: `符号链接不可用（${code}）：Windows 普通账号无 SeCreateSymbolicLinkPrivilege（未开开发者模式/非管理员），或文件系统不支持`,
      };
    }
    throw error;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** 本机能否创建文件符号链接；探测一次后缓存（成功与失败都缓存）。 */
export function canCreateSymlinks(): boolean {
  cached ??= probeSymlinks();
  return cached.supported;
}

/**
 * 不能创建符号链接时给出可写进测试报告/日志的原因；能创建时返回 null。
 * 用于本地全量结果的解释（跳过的是环境能力，不是产品行为）。
 */
export function symlinkUnsupportedReason(): string | null {
  cached ??= probeSymlinks();
  return cached.reason;
}
