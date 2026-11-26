/**
 * 「远程工作区」页头右侧的通用工作区操作：占用 / 解除占用 / 在网页打开。
 *
 * - 动作按**工作区**执行（`workspaceId`），不依赖当前任务的 Agent 状态；成功后就地刷新
 *   `adminContext`（占用者 / 状态以主进程事实为准，不自己猜）。
 * - 占用与解除按 `adminContext.occupancy.byMe` 切换：自己占着显示「解除占用」，否则显示
 *   「占用」。按钮状态是**事实**而不是授权：远端被他人占用 / 客户端离线 / 工作区未就绪时
 *   仍允许点击，由 PSB 的 `PSB_*` 失败码给出可行动错误（被占用带占用人名）。
 * - 失败一律走 toast：PSB 失败码 → i18n（`PSB_IPC_FAILURE_MESSAGE_KEYS` 唯一映射），
 *   非 PSB 失败显示 IPC 原文；不做静默失败。
 * - 视觉：28px 高共享 Button；占用 / 解除占用是带图标与文字的紧凑按钮（可见文字即无障碍
 *   名字），在网页打开是图标方按钮（按 DESIGN §14.6 带 `Tip` 与 aria-label）。
 */

import { useCallback, useState } from 'react';
import { Globe, Lock, LockOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { extractIpcError } from '../../../../shared/ipcError';
import type { PsbWorkspaceAdminContext } from '../../../../shared/psb-workspace-admin';
import { psbFailureMessageKeyForIpcCode } from '../../../../shared/psb-remote-workspace';
import { toast } from '@/lib/toast';
import { tryGetPsbWorkspaceAdminBridge } from './psbWorkspaceAdminBridge';

/**
 * PSB 失败 → 用户可读的一句话。
 *
 * `PSB_WORKSPACE_OCCUPIED_BY_OTHER` 的 IPC message 带占用人名：优先用 PSB 原文的人名，拿不到
 * 时退回「他人」，不把空名字填进句子里。「在网页打开」遇到工作区已不存在时给专门的
 * 可行动文案（`PSB_NOT_FOUND`；主进程修复前旧行为会落成通用「操作失败」），其它失败码映射到
 * `remoteWorkspace.error.*` / `remoteWorkspace.input.*`；非 PSB 失败显示 IPC 原文或通用文案。
 */
function actionFailureMessage(
  t: ReturnType<typeof useTranslation>['t'],
  error: unknown,
  kind: 'occupy' | 'release' | 'web',
): string {
  const ipc = extractIpcError(error);
  if (ipc) {
    // `PSB_NOT_FOUND` 是 main 对「工作区/会话不存在或无权限」的稳定失败码；`NOT_FOUND`
    // 是防御性兜底（旧 main / 其它路径），两者都给同一句可行动文案。
    if (kind === 'web' && (ipc.code === 'PSB_NOT_FOUND' || ipc.code === 'NOT_FOUND')) {
      return t('remoteWorkspace.admin.openWebGone');
    }
    const key = psbFailureMessageKeyForIpcCode(ipc.code);
    const detail = ipc.message.trim();
    if (key) {
      if (key === 'remoteWorkspace.error.occupiedByOther') {
        return t(key, {
          name: detail || t('remoteWorkspace.admin.occupancyTakenByOther'),
        });
      }
      return t(key);
    }
    if (detail) return detail;
  }
  const message = error instanceof Error ? error.message.trim() : '';
  return message || t('remoteWorkspace.error.unknown');
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

  const runAction = useCallback(
    async (
      kind: 'occupy' | 'release' | 'web',
      action: (input: { workspaceId: string }) => Promise<unknown>,
      successMessage: string | null,
    ) => {
      if (!bridge || busy) return;
      setBusy(kind);
      try {
        await action({ workspaceId: context.workspaceId });
        if (successMessage) toast.success(successMessage);
        onChanged();
      } catch (error) {
        toast.error(actionFailureMessage(t, error, kind));
      } finally {
        setBusy(null);
      }
    },
    [bridge, busy, context.workspaceId, onChanged, t],
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
