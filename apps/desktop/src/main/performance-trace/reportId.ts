/**
 * 本地录制编号（`diagnostics/performance-traces/<编号>/` 的目录名）。
 *
 * WL-26：Meka 不启用客户端日志上报，性能跟踪只保留本地录制，因此本模块不再复用
 * `log-upload/uploadCode`，改用自己的生成器。
 *
 * 字符集与 `<4>-<4>` 形状**保持不变**：`retention.ts` 用它判断该目录下哪些子目录是本功能
 * 生成的、可以按保留期清理；形状一变，升级前录制的旧报告就再也不会被清理。
 */

/** 只有这种形状的目录才由本功能生成，`retention.ts` 据此清理（见模块注释）。 */
export const TRACE_REPORT_ID_PATTERN =
  /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$/;

/** 去掉 0/1/I/L/O/U（字形或读音冲突），用户口述/工单里不会读错。 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const LENGTH = 8;

/** 注入随机字节，便于单测给定序列。rejection sampling 避免取模偏置。 */
export function generateTraceReportId(randomBytes: (size: number) => Uint8Array): string {
  const limit = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
  const chars: string[] = [];
  while (chars.length < LENGTH) {
    for (const byte of randomBytes(LENGTH * 2)) {
      if (byte >= limit) continue;
      chars.push(ALPHABET[byte % ALPHABET.length]);
      if (chars.length >= LENGTH) break;
    }
  }
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}
