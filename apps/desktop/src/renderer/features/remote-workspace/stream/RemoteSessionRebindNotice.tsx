/**
 * 远程会话「发送时透明重建」后的轻提示（composer 上方一行淡提示）。
 *
 * 为什么是淡提示而不是警告条：任务并没有结束 —— 主进程已经把本地任务重绑到一个新的 PSB
 * 会话上，用户直接继续发消息即可。「远程会话换了」是**信息**，不是错误；用橙色警告条会让
 * 用户以为任务失败了（这正是「这个任务已经结束」旧行为的问题）。所以沿用仓库既有的
 * 中性引导条视觉语言（`components/onboarding/ConnectProviderBanner`：中性 token + 可关闭），
 * 不新造一套样式。
 *
 * 措辞如实：PSB 不一定支持 resume，所以只说「本轮上下文可能不会延续」，不承诺恢复上下文。
 *
 * 呈现位置由宿主决定（当前是会话页 composer 上方，见 `CCAgentSessionView`）；
 * 本组件只负责一行的视觉与关闭，不自己判断该不该出现。
 */

import { RefreshCw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/** 远程会话重绑提示条（重绑发生后显示，用户可关闭）。 */
export function RemoteSessionRebindNotice({
  onDismiss,
  className,
}: {
  onDismiss: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      data-testid="remote-session-rebound-notice"
      className={[
        'flex w-full select-none items-center gap-1.5 rounded-md px-2.5 py-1.5',
        'border border-[var(--border-default)] bg-[var(--surface-elevated)]',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <RefreshCw
        size={13}
        className="shrink-0 text-[var(--text-secondary)]"
        aria-hidden
      />
      <span className="min-w-0 flex-1 break-words text-12 leading-5 text-[var(--text-secondary)]">
        {t('remoteWorkspace.session.reboundNotice')}
      </span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t('remoteWorkspace.session.reboundNoticeDismiss')}
        className="shrink-0 text-[var(--text-tertiary)] transition-opacity hover:opacity-70"
      >
        <X size={12} />
      </button>
    </div>
  );
}
