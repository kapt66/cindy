/**
 * PSB「待释放占用」常驻提示条 —— 非阻塞、可重试、可稍后（2026-11-27，T3）。
 *
 * ## 为什么是常驻 / 非阻塞
 *
 * PSB 协作锁没有 TTL：释放失败（网络 / 鉴权 / 5xx）后，锁可能仍在用户名下，而用户完全
 * 不知道（旧实现只有一行 `log.warn`）。产品 §2.5 / §2.7 / §8 要求「不阻塞离开，但不能
 * 静默」：给一条常驻提示 + 显式重试入口，不弹模态、不拦输入。
 *
 * ## 数据源与交互
 *
 * 订阅与合并都在 `pendingReleaseNoticeStore.ts`：main 账本（会话结束释放失败，经
 * `PENDING_RELEASES_CHANGED` 推送 / `pending-workspace-releases` 读一次）+ 工作区级账本
 * （picker 放弃草稿 / 在途取消失败）。两本账本不合并（产品 §2.5），只在展示层按 `workspaceId`
 * 去重合并（main 条目优先，工作区级补充；main 内部同一工作区留最近一次失败）——同一把工作区
 * 锁只出现一条，计数 = 可能仍被占住的工作区数。
 *
 * - 「重试」= **唯一**入口 `retryPendingPsbReleasesEverywhere()`：main 账本与工作区级账本
 *   各重试一次；同一工作区两本账并存时由 main 那次代表，工作区级重复条目出账（不重复打同一把
 *   锁）；账本清空后提示条自动消失。
 * - 「关闭」= 本会话不显示当前这一批（`dismissPendingReleaseNotice`）；账本仍在，新的失败
 *   会重新出现。
 * - 重试失败：提示条保留，正文换成 `releaseRetained`（「占用可能仍未解除」），每行给出
 *   可读原因（`psbFailureText` 的本地化文案 + PSB 原文诊断行；main 账本的 PSB 原始码先在
 *   store 里归一到共享单表的描述符，所以已知失败不会是 PSB 原文 / 通用文案）。
 *
 * ## 位置（避开窗口按钮 / 拖拽条 / Toast / 输入）
 *
 * 固定悬浮在**右下角**（与 VCS advisory 宿主同一角落）：右上角是窗口按钮与标题行拖拽区、
 * 顶部中间 / 右上分别是 ToastContainer 的落点；底部中间是聊天输入区。外层
 * `pointer-events-none` + 内层 `pointer-events-auto`，不遮断输入。
 *
 * 与 VCS advisory 同时出现时：本提示条 `z-50`（VCS 宿主 `z-40`）恒在它之上——待释放提示带
 * 的是「远端锁可能还挂着」的唯一重试入口，不能被一条「操作已成功」的建议条盖住；VCS 建议可
 * 先关掉再处理（它自己也有关闭 / 继续）。两者仍共用右下角同一坐标，真正的上下堆叠需要一个共享
 * 的右下角容器（VCS 横幅高度是变量，单方面猜 bottom 偏移会把提示条放到不对的位置），登记为
 * 后续 UI 收敛项，不在本提示条里继续堆 z-index 补丁。
 *
 * ## 窗口与桥
 *
 * App 只在主窗挂（`!isSecondaryWindow() && !isSidebarWindow()`）；本组件再自挡一次，防止
 * 将来在副窗 / 侧栏窗误挂时同一账本渲染多份。旧 preload / 无 bridge 时：订阅是 no-op、
 * 读取保持空快照、重试不假成功——页面降级成「没有提示」而不是崩。
 *
 * i18n：本批不改 locale，正文只用已存在的两条 PSB 键（`releasePending` / `releaseRetained`）
 * 与通用动作键（`commonUi.retry` / `common.dismiss`）。「N 个远程工作区」的带数量文案键
 * （如 `remoteWorkspace.draft.releaseSummary`）留给 i18n Wave 2，当前用中性计数徽标表达 N。
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';

import { watchPendingWorkspaceReleases } from '@/features/cc-agent/psbOccupancyRelease';
import { Button } from '@/components/ui/button';
import { isSecondaryWindow } from '@/lib/secondaryWindow';
import { isSidebarWindow } from '@/lib/sidebarWindow';
import {
  PSB_PENDING_RELEASE_NOTICE_KEY,
  PSB_PENDING_RELEASE_RETAINED_KEY,
} from '../draft/psbPendingReleaseLedger';
import { psbFailureText } from '../psbFailureText';
import {
  dismissPendingReleaseNotice,
  readPendingReleaseNoticeSnapshot,
  retryPendingPsbReleasesEverywhere,
  subscribePendingReleaseNotice,
  type PendingReleaseNoticeItem,
} from './pendingReleaseNoticeStore';

/** 原因行上限：账本最多 64 条，横幅不能无限长（剩余条数用 `+N` 表达）。 */
const MAX_REASON_ROWS = 3;

function reasonFor(
  t: ReturnType<typeof useTranslation>['t'],
  item: PendingReleaseNoticeItem,
): { readonly text: string; readonly detail: string | null } {
  const text = psbFailureText(t, item.failure);
  return {
    text,
    // PSB 原文是诊断行：已知码 + 本地化正文时仍保留它（与 VCS notice 的详情行同口径）；
    // 与正文相同（旧 main / 无码时正文就是原文）则不重复显示。
    detail: item.detail && item.detail !== text ? item.detail : null,
  };
}

function PsbPendingReleaseNoticeHost() {
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(
    subscribePendingReleaseNotice,
    readPendingReleaseNoticeSnapshot,
    readPendingReleaseNoticeSnapshot,
  );
  const [retrying, setRetrying] = useState(false);
  /** 用户点过重试、且重试后仍剩这一批条目时记下指纹 → 正文换成「占用可能仍未解除」。 */
  const [retriedFingerprint, setRetriedFingerprint] = useState<string | null>(null);

  // main 账本的快照 / 订阅只活在这个宿主里（只在主窗挂载一次）。App 仍负责启动 / 可见 /
  // pagehide 时的「本地结束事件补投 + 账本读一次」，但不再重复订阅推送。
  useEffect(() => watchPendingWorkspaceReleases(), []);

  if (snapshot.count === 0 || snapshot.dismissed) return null;

  const retained = retriedFingerprint === snapshot.fingerprint;
  const messageKey = retained
    ? PSB_PENDING_RELEASE_RETAINED_KEY
    : PSB_PENDING_RELEASE_NOTICE_KEY;
  const visibleItems = snapshot.items.slice(0, MAX_REASON_ROWS);
  const hiddenCount = snapshot.count - visibleItems.length;

  const retry = async (): Promise<void> => {
    setRetrying(true);
    try {
      // 唯一重试入口：main 账本 + 工作区级账本各一次（不在此另排后台重试）。
      const result = await retryPendingPsbReleasesEverywhere();
      const after = readPendingReleaseNoticeSnapshot();
      setRetriedFingerprint(result.remaining > 0 && after.count > 0 ? after.fingerprint : null);
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div
      data-testid="psb-pending-release-notice-host"
      data-placement="bottom-right"
      className="pointer-events-none fixed bottom-4 right-4 z-50 w-[min(440px,calc(100vw-2rem))]"
    >
      <div className="pointer-events-auto">
        <section
          data-testid="psb-pending-release-notice"
          data-retained={retained ? 'true' : 'false'}
          // 常驻状态提示，不是模态：读屏按 status/polite 播报，不打断当前操作。
          role="status"
          aria-live="polite"
          className="flex items-start gap-2 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 py-2 shadow-[shadow:var(--shadow-menu)]"
        >
          <span className="mt-0.5 inline-flex shrink-0 text-[var(--error-fg)]" aria-hidden>
            <AlertTriangle size={15} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-start gap-2">
              <span
                data-testid="psb-pending-release-count"
                className="mt-px inline-flex min-w-[20px] shrink-0 items-center justify-center rounded-full bg-[var(--surface-chip)] px-1.5 py-0.5 text-11 font-medium text-[var(--text-secondary)]"
              >
                {snapshot.count}
              </span>
              <p
                data-testid="psb-pending-release-message"
                className="min-w-0 break-words text-13 font-medium leading-[1.54] text-[var(--text-primary)]"
              >
                {t(messageKey)}
              </p>
            </div>
            {visibleItems.length > 0 ? (
              <ul
                data-testid="psb-pending-release-reasons"
                className="mt-1 list-none space-y-0.5 text-12 leading-[1.6] text-[var(--text-secondary)]"
              >
                {visibleItems.map((item) => {
                  const reason = reasonFor(t, item);
                  return (
                    <li
                      key={item.id}
                      data-source={item.source}
                      data-identity={item.identity}
                      data-workspace-id={item.workspaceId ?? undefined}
                      title={item.identity}
                      className="break-words"
                    >
                      <span>{reason.text}</span>
                      {reason.detail ? (
                        <span className="block text-11 text-[var(--text-tertiary)]">
                          {reason.detail}
                        </span>
                      ) : null}
                    </li>
                  );
                })}
                {hiddenCount > 0 ? (
                  <li data-testid="psb-pending-release-more">+{hiddenCount}</li>
                ) : null}
              </ul>
            ) : null}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                compact
                loading={retrying}
                onClick={() => void retry()}
              >
                {t('commonUi.retry')}
              </Button>
              <Button
                type="button"
                size="sm"
                compact
                tone="quiet"
                disabled={retrying}
                onClick={dismissPendingReleaseNotice}
              >
                {t('common.dismiss')}
              </Button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

/**
 * 主窗的常驻提示条入口：App 挂一次。副窗 / 侧栏窗没有会话生命周期，且同一账本会在每个
 * 窗口各渲染一份，因此这里自己再挡一次（App 挂载点也 gate 了，双保险）。
 */
export function PsbPendingReleaseNotice() {
  if (isSecondaryWindow() || isSidebarWindow()) return null;
  return <PsbPendingReleaseNoticeHost />;
}
