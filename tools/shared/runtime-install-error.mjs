/**
 * runtime-install-error —— agent runtime 落位链路的阶段化错误。
 *
 * 为什么需要：`scripts/ensure-agent-binaries.mjs` 只有知道失败发生在「上游下载」还是
 * 「本地落位」才能给出正确处置——下载慢/失败可以回退公司 CDN；本地 promote 失败（目标目录
 * 被运行中实例或安全扫描占用）下载多少次都一样。2026-09-16 Windows canary 发布失败时
 * 下载其实命中缓存、真正失败的是本地目录 promote，却被包装成
 * "Failed to download ... from upstream"，把排查引向网络与「应用是否在运行」。
 *
 * 契约：`tools/<kind>/update.mjs` 的 `ensurePlatform` 在阶段边界抛出本类错误；上层用
 * `runtimeInstallStageOf` 决定是否值得走网络兜底，并用 `describeErrorChain` 把底层 errno
 * 与路径原样带进日志。新增 runtime kind 时沿用同一契约。
 */

export const RUNTIME_INSTALL_STAGES = Object.freeze(['download', 'promote']);

export function isRuntimeInstallStage(value) {
  return RUNTIME_INSTALL_STAGES.includes(value);
}

export class RuntimeInstallError extends Error {
  /**
   * @param {'download'|'promote'} stage
   * @param {string} message
   * @param {{ cause?: unknown }} [options]
   */
  constructor(stage, message, { cause } = {}) {
    if (!isRuntimeInstallStage(stage)) {
      throw new Error(`Unknown runtime install stage: ${String(stage)}`);
    }
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'RuntimeInstallError';
    this.stage = stage;
    // 保留底层 errno（EPERM/EBUSY…），既有 isTargetLockError 之类的判定继续可用。
    if (typeof cause?.code === 'string') this.code = cause.code;
  }
}

/**
 * 把任意错误标注成某个阶段。已经是本类错误时原样返回，避免多层包裹把真实阶段覆盖掉。
 * @param {'download'|'promote'} stage
 * @param {unknown} error
 */
export function asRuntimeInstallError(stage, error) {
  if (error instanceof RuntimeInstallError) return error;
  return new RuntimeInstallError(stage, `${stage} failed: ${describeErrorChain(error)}`, { cause: error });
}

/** 读阶段标签；未标注（或非本契约错误）返回 null，调用方按"未知阶段"保守处理。 */
export function runtimeInstallStageOf(error) {
  return isRuntimeInstallStage(error?.stage) ? error.stage : null;
}

/**
 * 错误链摘要（含 errno）。日志/CI 必须能看到真实原因（errno + 路径），
 * 而不是被上层归纳成一句"下载失败"。
 */
export function describeErrorChain(error, { maxDepth = 4 } = {}) {
  const parts = [];
  let current = error;
  for (let depth = 0; current !== undefined && current !== null && depth < maxDepth; depth += 1) {
    const message = current instanceof Error ? current.message : String(current);
    const code = typeof current?.code === 'string' ? ` [${current.code}]` : '';
    parts.push(`${depth === 0 ? '' : 'caused by: '}${message}${code}`);
    current = current?.cause;
  }
  return parts.length > 0 ? parts.join(' | ') : String(error);
}
