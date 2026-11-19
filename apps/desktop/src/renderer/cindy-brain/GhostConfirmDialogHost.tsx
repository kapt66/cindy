import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';

/**
 * GhostConfirmDialogHost —— confirm 槽的 renderer 落地(2026-07-31)。
 *
 * 插件经管子请主机弹确认框(main:confirmSlot → ghostConfirmDialogBridge),这里
 * 把它接到**基座自己在用的那套** ConfirmDialogProvider 上,所以插件的确认框与
 * Cindy 自己的确认框长得一模一样、排队规则也一致(useConfirmDialog 自带队列)。
 *
 * 信任边界(与 Toast 的来源身份头同款):
 * - 标题是**主机文案**(带插件名),插件写不了;
 * - 身份头(图标 + 名字)由这里画,数据来自 main 的已装清单(不是插件自报);
 * - 插件只供 body 与按钮字,main 侧已净化 + 卡长度;这里作纯文本渲染(description
 *   与 content 都是文本节点,不注入 HTML);
 * - 用户的点击才是答案:确认 true、取消/Esc/点外部 false,原样回给 main。
 *
 * main 在本地模式把同一 requestId **广播**给所有能承载确认框的窗口(主窗口 + 完整会话
 * 副窗),并只把用户当前聚焦的那一个带到前台;client-mode 仍只投一个窗口。每个收到
 * push 的窗口各弹一个,首个用户点击经 resolve 结算,其余窗口收到 dismissed 后收起。
 *
 * 挂载点:App.tsx 的 ConfirmDialogProvider 内部(要用 context,不能挂在 store 里)。
 */
export function GhostConfirmDialogHost() {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();

  useEffect(() => {
    const pending = new Map<string, AbortController>();
    let dismiss: (() => void) | undefined;
    let disconnect: (() => void) | undefined;
    const off = window.electronAPI.ghosts?.onConfirmRequest?.((payload) => {
      if (!payload || typeof payload.requestId !== 'string' || typeof payload.body !== 'string') {
        return;
      }
      const { requestId, ghostName, iconDataUrl, body, confirmText, cancelText, danger } = payload;
      // 先回执再弹:main 用 ack 判断「至少一个窗口画出来了」;一个 ack 都没有时会把
      // 主窗口带到前台 + 闪任务栏并记 warn。回执不结算本单(用户还没点),失败也不
      // 影响本窗口继续弹框。
      try {
        void window.electronAPI.ghosts?.ackConfirm?.(requestId)?.catch(() => {});
      } catch {
        // 旧 preload / client-mode 无此桥:main 侧 8s 兜底仍会按原窗口答案结算。
      }
      if (pending.has(requestId)) return;
      const abort = new AbortController(); pending.set(requestId, abort);
      dismiss ??= window.electronAPI.ghosts?.onConfirmDismissed?.(({ requestId }) => pending.get(requestId)?.abort());
      if (window.electronAPI.hostConnection?.client === 'browser') {
        disconnect ??= window.electronAPI.hostConnection.onStateChanged(state => {
          if (state.status !== 'connected') for (const pendingAbort of pending.values()) pendingAbort.abort();
        });
      }
      void (async () => {
        let confirmed = false;
        try {
          confirmed = await confirm({
            // 主机文案:插件名只作插值,伪装不了这句话本身
            title: t('settings.ghosts.confirm.dialogTitle', { name: ghostName }),
            description: body,
            // 身份头:与 Toast 的来源头同款视觉(语义 token,明暗两档自动跟随)
            content: (
              <span className="inline-flex items-center gap-1.5">
                {iconDataUrl && (
                  <img
                    src={iconDataUrl}
                    alt=""
                    draggable={false}
                    className="h-4 w-4 rounded-[4px] object-cover"
                  />
                )}
                <span className="max-w-[220px] truncate text-13 font-medium leading-snug text-[var(--text-tertiary)]">
                  {ghostName}
                </span>
              </span>
            ),
            ...(confirmText ? { confirmText } : {}),
            ...(cancelText ? { cancelText } : {}),
            ...(danger ? { confirmVariant: 'destructive' as const } : {}),
          }, abort.signal);
          confirmed = confirmed && !abort.signal.aborted;
        } finally {
          pending.delete(requestId);
          if (!pending.size) { dismiss?.(); dismiss = undefined; disconnect?.(); disconnect = undefined; }
          // 无论如何都要回包:不回的话插件那侧会一直挂到 main 的 90 秒兜底超时。
          // 回包失败(窗口正在关等)也不额外处理——那条超时就是为此存在的。
          try {
            await window.electronAPI.ghosts?.resolveConfirm?.(requestId, confirmed);
          } catch {
            // 忽略:main 侧超时会兜底成「没同意」
          }
        }
      })();
    });
    return () => { off?.(); dismiss?.(); dismiss = undefined; disconnect?.(); disconnect = undefined; for (const abort of pending.values()) abort.abort(); };
  }, [confirm, t]);

  return null;
}
