/**
 * 「这个工作区还没被你占用」确认宿主（2026-11-27 用户复测：占用一律由用户确认）。
 *
 * ## 为什么需要一个常驻宿主
 *
 * 发送消息的失败点不在任何 React 组件里：`makerChatStore.sendMessage` 的 enqueue 被
 * `PSB_WORKSPACE_NOT_OCCUPIED` 拒绝时，只有 store 手上有这次发送的全部载荷（草稿 / 附件 /
 * 队列语义），也只有它能**原样重试同一次发送**。但确认框必须走 `useConfirmDialog`（模态队列 /
 * 焦点陷阱 / 主题），那是 React 上下文。
 *
 * 所以：store 在失败时向这里注册的 resolver 请求「用户同意并已占用」，期间这次发送保持挂起
 * （composer 仍显示发送中，草稿没被清）；用户确认 → 这里解析工作区、弹确认框、调显式占用 →
 * resolver 回 `true` → store 用同一份载荷重发一次。取消 / 占用失败 → `false` → store 照旧把
 * 失败落到错误横幅并恢复草稿。
 *
 * ## 边界
 *
 * - **只挂主窗**（副窗 / 侧栏窗没有会话生命周期，同一对话框会在每个窗口各弹一份），且桥缺失时
 *   注册的是「永远拒绝」的 resolver：旧 preload 下不假装占用成功。
 * - 不在这里重试任何动作：重试是发起方的事实（发送由 store 自己重发，启动串流由它的 hook 重试）。
 * - 工作区名与 workspaceId 一律来自 main 的 `adminContext`（渲染层不持有 workspaceId，也不猜）。
 */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { isSecondaryWindow } from '@/lib/secondaryWindow';
import { isSidebarWindow } from '@/lib/sidebarWindow';

import { tryGetPsbRemoteBridge } from './bridge';
import {
  confirmAndOccupyPsbWorkspace,
  registerPsbOccupyConfirmationResolver,
  registerPsbOccupyWorkspaceConfirmationResolver,
  resolvePsbWorkspaceForOccupyConfirmation,
} from './occupyRequired';

function PsbOccupyRequiredConfirmationHost() {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();

  useEffect(() => {
    const bridge = tryGetPsbRemoteBridge();
    const unregisterSession = registerPsbOccupyConfirmationResolver(async (sessionId) => {
      const resolved = await resolvePsbWorkspaceForOccupyConfirmation(bridge, sessionId);
      // 解析不到工作区（工作区已不可见 / 只有占位身份 / 旧 preload）：不弹一个指不到工作区的
      // 确认框，也不占用。发送失败照旧落到错误横幅，由用户重试或从网页处理。
      if (!resolved) return false;
      const outcome = await confirmAndOccupyPsbWorkspace({
        t,
        confirm,
        bridge,
        workspaceId: resolved.workspaceId,
        workspaceName: resolved.workspaceName,
      });
      return outcome === 'occupied';
    });
    // 懒建 PSB 会话（草稿页首条消息）只有工作区事实、还没有本地任务：同一段确认 + 占用。
    const unregisterWorkspace = registerPsbOccupyWorkspaceConfirmationResolver(
      async ({ workspaceId, workspaceName }) => {
        const outcome = await confirmAndOccupyPsbWorkspace({
          t,
          confirm,
          bridge,
          workspaceId,
          workspaceName,
        });
        return outcome === 'occupied';
      },
    );
    return () => {
      unregisterSession();
      unregisterWorkspace();
    };
  }, [confirm, t]);

  return null;
}

/**
 * 主窗入口：App 挂载一次。副窗 / 侧栏窗不挂（同一会话的确认框只应出现一份）。
 */
export function PsbOccupyRequiredConfirmation() {
  if (isSecondaryWindow() || isSidebarWindow()) return null;
  return <PsbOccupyRequiredConfirmationHost />;
}
