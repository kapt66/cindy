/**
 * 更新服务的专用 errorCode（main 与 renderer 共用一份字面量）。
 *
 * renderer 不能 import `src/main/**`（进程边界），所以这类「两端必须逐字一致」的
 * 码值放这里：`update_apply_exhausted` 同时被主进程的放弃闸门、侧栏
 * `UpdateBanner` / `UserInfoSection` 与本地库恢复界面 `localDbFatalView` 判定，
 * 任何一处漏改都会让其中一条恢复路径静默失效（改名时只改本文件）。
 */
export const UPDATE_APPLY_EXHAUSTED_ERROR_CODE = 'update_apply_exhausted';
