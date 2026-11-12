/** Local desktop diagnostics. These channels intentionally do not cross device-link. */
export const PERFORMANCE_TRACE_CHANNEL = 'performance-trace:command';
export const PERFORMANCE_TRACE_EVENTS_CHANNEL = 'performance-trace:events';
export const PERFORMANCE_TRACE_STATE_CHANNEL = 'performance-trace:state';
export const TRACE_MAX_DURATION_MS = 60_000;
export const TRACE_MAX_EVENTS = 3000;

export type PerformanceTracePhase =
  | 'idle'
  | 'starting'
  | 'recording'
  | 'saving'
  | 'ready';
export interface PerformanceTraceState {
  phase: PerformanceTracePhase;
  startedAt: number | null;
  reportId: string | null;
  partial: boolean;
  durationMs: number;
}
/**
 * 本地录制的命令面。WL-26：Meka 不启用客户端日志上报，这里**没有**上传命令；
 * 录制结果只保存在本机，用户通过「查看本地文件」自行取用。
 */
export type PerformanceTraceCommand = 'state' | 'start' | 'stop' | 'show-local';
export interface PerformanceTraceEvent {
  /** Epoch milliseconds; renderer uses performance.timeOrigin + entry.startTime. */
  at: number;
  kind: 'long-task' | 'input' | 'composition' | 'visibility' | 'ipc';
  durationMs: number;
  /** Fixed vocabulary, never DOM text, keys, identifiers or IPC arguments. */
  label: string;
  inputDelayMs?: number;
  processingMs?: number;
}
export interface PerformanceTraceAPI {
  command(command: PerformanceTraceCommand): Promise<PerformanceTraceState>;
  events(events: PerformanceTraceEvent[]): void;
  onState(listener: (state: PerformanceTraceState) => void): () => void;
}
