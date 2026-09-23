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
 */
export type LocalDbFatalView =
  | 'install-update'
  | 'preparing-update'
  | 'apply-exhausted'
  | 'no-update';

export type UpdateStatusValue = UpdateStatusPayload['status'];

export function resolveLocalDbFatalView(
  status: UpdateStatusValue | undefined,
  errorCode?: string,
): LocalDbFatalView {
  if (status === 'error' && errorCode === UPDATE_APPLY_EXHAUSTED_ERROR_CODE) return 'apply-exhausted';
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
