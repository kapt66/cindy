/**
 * 选择器的**身份与交接载荷**（工作区级事实，无 sessionId / agentKind）。
 *
 * 产品口径（2026-11-25）：新建远程工作区只选 / 建工作区，Harness 与模型在草稿页按既有链路
 * 选择；PSB 会话在草稿页首条消息发送时才懒创建。所以弹窗、侧栏、草稿页之间交接的只有
 * 工作区级五个字段，`psb:` 会话身份由草稿页懒建后写回。
 *
 * 引擎换算（草稿当前 vendor → PSB `agentKind`）与去重键生成也在这里：它们都属于「这条草稿
 * 将来要建哪条 PSB 会话」的身份事实，不属于显示层。
 */

import type { MakerVendor } from '@/lib/ccAgent.types';

import type { PsbAgentKind, PsbRemoteWorkspace } from '../../../../shared/psb-remote-workspace';

/**
 * 选择器成功回调的载荷（工作区级，**没有** sessionId / agentKind）。
 *
 * 侧栏与草稿页都按这五个字段交接；PSB 会话在草稿页首条消息发送时才懒创建。
 */
export interface RemoteWorkspacePickerCreated {
  workspaceId: string;
  clientId: string;
  clientName: string;
  workspaceTitle: string;
  directoryName: string | null;
}

/** PSB 工作区行 → 交给调用方的工作区级载荷（弹窗与草稿页工作区下拉共用唯一映射）。 */
export function psbWorkspaceCreatedPayload(
  workspace: PsbRemoteWorkspace,
): RemoteWorkspacePickerCreated {
  return {
    workspaceId: workspace.id,
    clientId: workspace.clientId,
    clientName: workspace.clientName,
    workspaceTitle: workspace.title,
    directoryName: workspace.directoryName,
  };
}

/** 草稿 vendor → PSB 会话的 agentKind（首条消息懒建会话时按草稿当前选择换算）。 */
export function vendorToPsbAgentKind(vendor: MakerVendor): PsbAgentKind {
  if (vendor === 'codex') return 'codex';
  if (vendor === 'pi') return 'pi';
  return 'claude-code';
}

/**
 * PSB 会话创建的去重键（每次发送尝试生成一次；重试沿用同一个键）。
 *
 * 双击/重试时同一个键只应建出一条 PSB 会话；渲染层还有在途守卫，这里是第二道
 * （PSB 侧据此去重）。`crypto.randomUUID` 缺席的老 WebView 退回时间戳 + 随机后缀，
 * 仍然满足「进程内不重复」的要求。
 */
export function createPsbClientRequestId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `psb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
