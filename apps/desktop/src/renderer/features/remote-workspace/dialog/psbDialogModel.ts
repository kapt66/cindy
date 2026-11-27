/**
 * 「新建远程工作区」选择器的纯函数层入口（**兼容再导出**，实现已拆到三个模块）。
 *
 * 2026-11-26 独立审查：原来的 `psbDialogModel.ts` 混了显示口径、失败归因、会话身份三类
 * 事实，且自带第二张失败码表。现在按事实拆分：
 *   - `psbWorkspaceDisplay.ts`：显示名 / 次要行 / 冲突消歧 / 不可用原因；
 *   - `psbFailure.ts`：失败事实归一（`readPsbFailure`），文案统一在根 `psbFailureText.ts`；
 *   - `psbSessionIdentity.ts`：工作区级交接载荷、引擎换算、去重键。
 *
 * 这个文件只为既有调用点保留原 import 路径（`cc-agent/NewMakerDraftRoute`、`new-chat`、
 * 草稿页下拉等）。**新代码请直接从对应模块导入**；Wave 2 迁完调用点后本文件可删除。
 */

export {
  PSB_WORKSPACE_SECONDARY_SEPARATOR,
  psbWorkspaceDisplayName,
  psbWorkspaceInstanceName,
  psbWorkspaceRowDisplayName,
  psbWorkspaceRowLabels,
  psbWorkspaceSecondaryText,
  psbWorkspaceTargetDisplayName,
  psbWorkspaceTemplateMachineText,
  psbWorkspaceUnavailableReason,
  shortPsbWorkspaceId,
  type PsbWorkspaceDisplayParts,
  type PsbWorkspaceRowLabels,
} from './psbWorkspaceDisplay';
export {
  PSB_FAILURE_UNKNOWN_KEY,
  psbFailureWithPersonName,
  psbOccupyTimeoutFailure,
  readPsbFailure,
  type PsbFailureInfo,
} from './psbFailure';
export {
  createPsbClientRequestId,
  psbWorkspaceCreatedPayload,
  vendorToPsbAgentKind,
  type RemoteWorkspacePickerCreated,
} from './psbSessionIdentity';

// 文案唯一实现在根 `psbFailureText.ts`（参数顺序 `(t, error)`）；这里再导出只为让既有
// import 路径先编译，**不是**第二份实现。调用点请按 `(t, error)` 传参。
export { psbFailureText } from '../psbFailureText';
