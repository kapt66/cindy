/**
 * 「远程工作区」页头右侧的通用工作区操作：占用 / 解除占用 / 在网页打开。
 *
 * - 动作按**工作区**执行（`workspaceId`），不依赖当前任务的 Agent 状态；成功后就地刷新
 *   `adminContext`（占用者 / 状态以主进程事实为准，不自己猜）。
 * - 占用与解除按 `adminContext.occupancy.byMe` 切换：自己占着显示「解除占用」，否则显示
 *   「占用」。按钮状态是**事实**而不是授权：远端被他人占用 / 客户端离线 / 工作区未就绪时
 *   仍允许点击，由 PSB 的 `PSB_*` 失败码给出可行动错误（被占用带占用人名）。
 * - **stale 上下文（2026-11-26 真机事故）**：工作区已不可见 / 暂时连不上时，固定信息照旧显示，
 *   但占用 / 解除占用是工作区写操作：点击直接给「工作区已不可见 / 连不上」的可行动提示，
 *   不再先打一次注定失败的 PSB 请求。占用人未知时不猜按钮语义之外的任何状态。
 *   「在网页打开」不拦：那是用户确认工作区是否还在的出口，失败也有专门文案
 *   （`openWebGone`）。
 * - 失败一律走 toast：PSB 失败码 → i18n（`PSB_IPC_FAILURE_MESSAGE_KEYS` 唯一映射），
 *   非 PSB 失败显示 IPC 原文或通用文案；不做静默失败。
 * - 视觉：28px 高共享 Button；占用 / 解除占用是带图标与文字的紧凑按钮（可见文字即无障碍
 *   名字），在网页打开是图标方按钮（按 DESIGN §14.6 带 `Tip` 与 aria-label）。
 *
 * ## 版本控制检查通知（CINDY-RW-10）
 *
 * 占用 / 解除占用成功后 main 会把 0.1.180 的 advisory（`data.vcs`）缓存并广播；这里再
 * `hydrateWorkspaceVcsNotice` 兜底读一次（推送与 invoke 失败的到达顺序不可依赖，重复读幂等）。
 * 通知本身的展示在页面版本控制分类的内联 View 里，不在页头加提示条（页头保持单行 ≤40px）。
 */

import { useCallback, useState } from 'react';
import { Globe, Lock, LockOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { extractIpcError } from '../../../../shared/ipcError';
import {
  psbAdminContextActionBlockedKey,
  psbAdminContextCanOperate,
  type PsbWorkspaceAdminContext,
} from '../../../../shared/psb-workspace-admin';
import { toast } from '@/lib/toast';
import { psbFailureText } from '../psbFailureText';
import { hydrateWorkspaceVcsNotice } from '../vcs/vcsNoticeStore';
import { tryGetPsbWorkspaceAdminBridge } from './psbWorkspaceAdminBridge';

/**
 * PSB 失败 → 用户可读的一句话。
 *
 * 「在网页打开」遇到工作区已不存在时给专门的可行动文案（`PSB_NOT_FOUND`；否则通用「操作失败」），
 * 其它失败统一走 `psbFailureText`（PSB 码 → 本地化文案；未知才用通用兜底）。
 */
function actionFailureMessage(
  t: ReturnType<typeof useTranslation>['t'],
  error: unknown,
  kind: 'occupy' | 'release' | 'web',
): string {
  const ipc = extractIpcError(error);
  // `PSB_NOT_FOUND` 是 main 对「工作区/会话不存在或无权限」的稳定失败码；`NOT_FOUND`
  // 是防御性兜底（旧 main / 其它路径），两者都给同一句可行动文案。
  if (kind === 'web' && ipc && (ipc.code === 'PSB_NOT_FOUND' || ipc.code === 'NOT_FOUND')) {
    return t('remoteWorkspace.admin.openWebGone');
  }
  return psbFailureText(t, error);
}

export function RemoteWorkspaceAdminActions({
  context,
  onChanged,
}: {
  readonly context: PsbWorkspaceAdminContext;
  /** 动作成功后刷新工作区上下文（不自行拼状态）。 */
  readonly onChanged: () => void;
}) {
  const { t } = useTranslation();
  const bridge = tryGetPsbWorkspaceAdminBridge();
  const [busy, setBusy] = useState<'occupy' | 'release' | 'web' | null>(null);
  const byMe = context.occupancy.byMe;
  // stale / 占位身份：占用与解除占用是工作区写操作，点击直接给可行动错误（不静默、不空转）。
  const canOperate = psbAdminContextCanOperate(context);
  const blockedKey = psbAdminContextActionBlockedKey(context);

  const runAction = useCallback(
    async (
      kind: 'occupy' | 'release' | 'web',
      action: (input: { workspaceId: string }) => Promise<unknown>,
      successMessage: string | null,
    ) => {
      if (!bridge || busy) return;
      // 只在「回显过的工作区事实已经不可用」时拦写操作；「在网页打开」留给用户自己确认。
      if (kind !== 'web' && !canOperate) {
        toast.error(t(blockedKey ?? 'remoteWorkspace.admin.staleUnavailableAction'));
        return;
      }
      setBusy(kind);
      try {
        await action({ workspaceId: context.workspaceId });
        if (successMessage) toast.success(successMessage);
        onChanged();
        // 占用 / 解除占用成功：main 已把 advisory（检出脏）缓存并广播；这里兜底读一次，
        // 补上「推送还没到」的窗口（幂等，读不到通知不会清掉刚到的那个）。
        if (kind === 'occupy' || kind === 'release') {
          void hydrateWorkspaceVcsNotice(context.workspaceId);
        }
      } catch (error) {
        toast.error(actionFailureMessage(t, error, kind));
      } finally {
        setBusy(null);
      }
    },
    [blockedKey, bridge, busy, canOperate, context.workspaceId, onChanged, t],
  );

  return (
    <div
      data-testid="remote-workspace-admin-actions"
      className="flex shrink-0 items-center gap-1"
    >
      {byMe ? (
        <Button
          type="button"
          size="sm"
          compact
          variant="secondary"
          tone="quiet"
          loading={busy === 'release'}
          disabled={busy !== null && busy !== 'release'}
          onClick={() =>
            void runAction(
              'release',
              (input) => {
                if (!bridge) return Promise.reject(new Error('missing bridge'));
                return bridge.releaseWorkspace(input);
              },
              t('remoteWorkspace.admin.actionReleaseDone'),
            )
          }
        >
          <LockOpen size={13} aria-hidden />
          {t('remoteWorkspace.admin.actionRelease')}
        </Button>
      ) : (
        <Button
          type="button"
          size="sm"
          compact
          variant="secondary"
          tone="quiet"
          loading={busy === 'occupy'}
          disabled={busy !== null && busy !== 'occupy'}
          onClick={() =>
            void runAction(
              'occupy',
              (input) => {
                if (!bridge) return Promise.reject(new Error('missing bridge'));
                return bridge.occupyWorkspace(input);
              },
              t('remoteWorkspace.admin.actionOccupyDone'),
            )
          }
        >
          <Lock size={13} aria-hidden />
          {t('remoteWorkspace.admin.actionOccupy')}
        </Button>
      )}
      <Tip text={t('remoteWorkspace.admin.actionOpenWeb')} side="bottom">
        <Button
          type="button"
          size="sm"
          compact
          variant="secondary"
          tone="quiet"
          className="w-7 px-0"
          aria-label={t('remoteWorkspace.admin.actionOpenWeb')}
          loading={busy === 'web'}
          disabled={busy !== null && busy !== 'web'}
          onClick={() =>
            void runAction(
              'web',
              (input) => {
                if (!bridge) return Promise.reject(new Error('missing bridge'));
                return bridge.openWebWorkspace(input);
              },
              null,
            )
          }
        >
          <Globe size={14} aria-hidden />
        </Button>
      </Tip>
    </div>
  );
}
