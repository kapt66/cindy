/**
 * 崩溃判定 —— 只回答「这个退出原因算不算致命崩溃」。
 *
 * **Meka 口径（WL-26）**：本仓**不启用任何客户端日志上报通道**，因此上游同名模块里的
 * 补传专用函数（`shouldBackfillForReportKind` / `crashAtFromMarker` /
 * `selectBackfillGrouping`）与待补传标记已随上报面删除，**不要再加回来**。
 * 这里只保留 `isFatalCrashReason`，它唯一的消费者是**纯本地**的崩溃诊断
 * （`main/crash-diagnosis.ts` → 启动后提示「上次异常退出」并打开本地日志目录），
 * 没有任何网络副作用。
 *
 * 两条不变量（沿用上游）：
 *
 *  1. **复用生命周期模块已有的结论，不另立一套**。自挂 `process` 事件会漏掉渲染进程崩溃
 *     （白屏），并把可恢复的悬空 promise 误报成崩溃。这里只吃 `lifecycle.beginShutdown`
 *     的 `reason` 字符串。
 *  2. **原生崩溃靠启动尸检兜底**。segfault / 被系统 kill / 主线程 hang 时 JS 层根本没机会
 *     反应，只有下次启动扫 run marker 才能知道「上次运行异常退出且无任何退出记录」。
 *
 * 纯逻辑：不 import electron、不 import lifecycle（避免与 lifecycle 形成循环——接线由
 * `crash-diagnosis.ts` 用回调完成）。
 */

/**
 * `beginShutdown` 的 reason 是否算致命崩溃。
 *
 * 放行两类：
 *  - `uncaughtException` —— main 进程未捕获异常。注意 lifecycle 在进入 `beginShutdown`
 *    之前已经把 broken stdio（EIO/EPIPE）与瞬时网络错误（ETIMEDOUT 等）分流掉了，
 *    所以能走到这里的都是真致命。
 *  - `render-process-gone:<reason>` —— 渲染进程崩溃（白屏）。同样地，意识沙箱与
 *    `<webview>` guest 的崩溃在 lifecycle 里已经 return，不会进入 `beginShutdown`。
 *
 * 不放行：`before-quit`（用户主动退出）、`signal:*`（Ctrl+C / kill）、
 * `update-relaunch`（更新重启）以及任何未来新增的正常退出入口——**未知 reason 一律不算
 * 崩溃**，方向与来源白名单一致（宁可漏报一次崩溃，也不要把正常退出当崩溃）。
 */
export function isFatalCrashReason(reason: string): boolean {
  if (reason === 'uncaughtException') return true;
  if (reason.startsWith('render-process-gone:')) return true;
  return false;
}
