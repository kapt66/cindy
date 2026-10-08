// [Meka divergence] 客户端日志上报(SLS)已在 meka/main 上移除（第 5 轮同步后移除）：
// 上游本文件是跨进程的上报契约（IPC 方法、设置载荷、上传编号、变更广播频道）。Meka 只保留
// `LogUploadReason` —— 「报告问题」流程的日志采集（main/log-upload/collect.ts / types.ts）把它
// 当作采集原因标签，仍在使用。下次同步若上游在此新增上报契约，按本注释保留「不引入」。
// 口径见 docs/dev-rules/log-upload-and-redaction.md。

/** 采集日志的原因标签（保留：报告问题流程在用）。 */
export type LogUploadReason = 'manual' | 'crash-immediate' | 'crash-backfill';
