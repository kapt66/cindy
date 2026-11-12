import { UPDATE_APPLY_EXHAUSTED_ERROR_CODE } from '../../../shared/updateErrorCodes';

/**
 * LocalDbFatalScreen 的视图态映射（纯函数，便于单测）。
 *
 * 本地数据库启动失败（典型 MIGRATE_FAILED：旧版本打开被更新代码升级过的库）时，
 * 恢复路径取决于应用更新补丁的暂存状态：
 * - `install-update`：补丁已就绪（ready）——主按钮「重启并安装更新」。
 * - `preparing-update`：正在检查/下载，或旧补丁正被更新版本替换（superseding，
 *   与 UpdateBanner 一致此时禁止 relaunch，防止装到旧补丁）——按钮转圈等待。
 * - `apply-exhausted`：自动更新已对该版本放弃（error + `update_apply_exhausted`
 *   专用 errorCode）——主进程不会再下载，重新检查只会原样返回同一结论，
 *   所以主按钮改为「手动下载安装包」打开官网。若不单独成态，它会落进
 *   `no-update` 的「检查更新」死按钮（结果被 .catch 吞掉，点了永远没反应），
 *   而这条恢复路径通常正是库被升级后的唯一出路。
 * - `no-update`：无补丁可装（idle/error）——引导「重新检查更新」。
 * - `init-failed`：DB_INIT_FAILED（如插件目录 EPERM）——不引导更新，给中性说明与「重试」。
 * - `retry-local-db`：DB_SCHEMA_LOCKED（另一个实例持锁）——直接给「重试」。
 * - `corrupt`：DB_CORRUPT_NO_BACKUP——可能是自动恢复已耗尽，也可能是共享库被其它实例占用
 *   （关闭后重试可恢复），故保留「重试」，并额外提供复制技术细节的求助入口。
 */
export type LocalDbFatalView =
  | 'install-update'
  | 'preparing-update'
  | 'apply-exhausted'
  | 'no-update'
  | 'retry-local-db'
  | 'init-failed'
  | 'corrupt';

export type UpdateStatusValue = UpdateStatusPayload['status'];

/**
 * 两个「错误码」是两个不同来源，不能共用一个位置参数（W28 同步的冲突点）：
 * - `code`：本地库启动失败的**故障码**（`DB_SCHEMA_LOCKED` / `DB_CORRUPT_NO_BACKUP` /
 *   `DB_INIT_FAILED` …），由 LocalDbGate 从 main 传入；
 * - `updateErrorCode`：**更新器**的 errorCode（`update_apply_exhausted` …），来自 update-status。
 */
export function resolveLocalDbFatalView(
  status: UpdateStatusValue | undefined,
  code?: string,
  updateErrorCode?: string,
): LocalDbFatalView {
  if (status === 'error' && updateErrorCode === UPDATE_APPLY_EXHAUSTED_ERROR_CODE) {
    return 'apply-exhausted';
  }
  if (code === 'DB_SCHEMA_LOCKED') return 'retry-local-db';
  // 错误码是第一决策维度：只有 MIGRATE_FAILED（或未知码，保持旧行为）才走更新链路。
  if (code === 'DB_CORRUPT_NO_BACKUP') return 'corrupt';
  if (code === 'DB_INIT_FAILED') return 'init-failed';
  switch (status) {
    case 'ready':
      return 'install-update';
    case 'checking':
    case 'downloading':
    case 'superseding':
      return 'preparing-update';
    default:
      return 'no-update';
  }
}
