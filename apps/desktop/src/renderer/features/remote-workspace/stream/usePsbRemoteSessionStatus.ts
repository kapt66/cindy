/**
 * 当前 PSB 会话 + 所属工作区的状态快照（会话页输入置灰、串流面板「详情」共用）。
 *
 * ## 为什么需要它
 *
 * 「工作区被他人占用 / 客户端离线 / 工作区未就绪」三种情况下输入框要置灰并给出原因
 * （产品正本 `docs/product-rules/psb-remote-workspace-sessions.md` §2.4）；PSB 会话终态
 * **不再**是置灰原因 —— 那种情况下发送会透明重建远程会话（主进程重绑 + 推送
 * `psbRemote.sessionsRebound`，见 `psbSessionRebind.ts`），和本地任务一样可以继续发消息。
 * 判据必须由 PSB 算（同一份判据在网页上已经存在），Cindy 只读 `sessionStatus` 后交给共享
 * 纯函数 `psbSessionInputAllowed()` 翻译成 i18n key。
 *
 * ## 刷新口径（通道评审要求）
 *
 * - 进入页面读一次；窗口重新聚焦时补读；后台每 30s 一次，页面隐藏时跳过（不为看不见的
 *   页面发请求）。
 * - 同一时刻最多一个在途请求（`inFlightRef`），迟到的旧代次结果直接丢弃。
 * - 会话终态**继续**按同一间隔轮询：终态后用户下一条消息会触发远端重建，重绑事件会把
 *   `psbSessionId` 换成新会话并自动重读；保留轮询是事件之外的第二条发现路径（推送丢失、
 *   页面长时间停在同一任务上时也能跟上）。
 * - 「远程工作区」页签**不再消费本 hook**：它读工作区级 `adminContext`（
 *   `shared/psb-workspace-admin.ts`），Agent 任务终态不影响页面。本 hook 只服务会话页
 *   （输入判据与重绑后的远端身份）。
 *
 * ## 读取失败怎么办
 *
 * 保留上一次快照（不回退成"未知"）：
 * - 从没读到过 → `allowed: true`（不拿网络抖动锁死输入，与既有 remote 写保护判据同口径）；
 * - 读到过 → 继续按最后一次已知状态禁用，避免"PSB 断了反而放开写"。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  psbSessionInputAllowed,
  psbSessionNeedsRebind,
  type PsbRemoteSession,
  type PsbRemoteWorkspace,
} from '../../../../shared/psb-remote-workspace';
import { tryGetPsbRemoteBridge } from '../bridge';

/** 后台刷新间隔：30s（占用/在线状态不是高频数据，不需要更密）。 */
export const PSB_SESSION_STATUS_REFRESH_MS = 30_000;

export interface PsbRemoteSessionSnapshot {
  readonly session: PsbRemoteSession;
  readonly workspace: PsbRemoteWorkspace;
}

export interface PsbRemoteSessionStatus {
  /** 最近一次成功读取的快照；从未读到 / 会话切换中为 `null`。 */
  readonly snapshot: PsbRemoteSessionSnapshot | null;
  /** 输入是否允许。没有快照时为 `true`（见文件头「读取失败怎么办」）。 */
  readonly inputAllowed: boolean;
  /** `inputAllowed: false` 时的 i18n key（`remoteWorkspace.input.*`）。 */
  readonly inputBlockedReasonKey: string | null;
  /**
   * 已结束的 PSB 会话（终态）——此时不是锁死输入，而是**下一条消息会透明重建**远程会话。
   *
   * 会话页用它做终态窗口内的措辞校验；「远程工作区」页已改为工作区级 `adminContext`，
   * 不再消费这个字段（历史字段保留，避免会话页调用点与既有测试一起改）。重绑后快照换成
   * 新会话，本字段自然回到 `false`。
   */
  readonly needsRebind: boolean;
  /** 立即重读一次（用户聚焦 / 终端入口打开时用）。 */
  readonly refresh: () => void;
  /**
   * 最近一次读取**失败**且还没有任何快照。
   *
   * 只给「读不到」比「读取中」更诚实的展示位置用：会话已结束或没有访问权时 PSB 会拒绝
   * `sessionStatus`，一直显示「正在读取」会让用户以为还在等网络。有快照之后的失败仍按文件
   * 头的口径保留旧快照，本字段回到 `false`。
   */
  readonly readFailed: boolean;
}

/**
 * @param psbSessionId PSB 会话 id（`psb:` 前缀后的部分）；`null` = 不是远程工作区会话。
 * @param options.enabled false 时不发请求（只读实例 / 内嵌窗格不重复轮询）。
 */
export function usePsbRemoteSessionStatus(
  psbSessionId: string | null,
  options: { readonly enabled?: boolean } = {},
): PsbRemoteSessionStatus {
  const enabled = options.enabled !== false;
  const [snapshot, setSnapshot] = useState<PsbRemoteSessionSnapshot | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const snapshotRef = useRef<PsbRemoteSessionSnapshot | null>(null);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const trimmedSessionId = psbSessionId?.trim() || null;
  snapshotRef.current = snapshot;

  const load = useCallback(() => {
    if (!enabled || !trimmedSessionId) return;
    if (inFlight.current) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    const bridge = tryGetPsbRemoteBridge();
    // 没有桥（旧 preload / 单测 / 非主窗口）：保持"未知"，不发请求也不报错。
    if (!bridge) return;
    const token = ++generation.current;
    inFlight.current = true;
    void bridge
      .sessionStatus({ sessionId: trimmedSessionId })
      .then((result) => {
        if (token !== generation.current) return;
        setSnapshot(result);
        setReadFailed(false);
      })
      .catch(() => {
        // 读取失败保留最后一份快照（理由见文件头）；一次都没读到过时标记「读不到」，
        // 让消费方能说「读不到」而不是一直说「正在读取」。
        if (token !== generation.current) return;
        if (!snapshotRef.current) setReadFailed(true);
      })
      .finally(() => {
        if (token === generation.current) inFlight.current = false;
      });
  }, [enabled, trimmedSessionId]);

  // 会话切换：丢掉旧快照，重新读一次。
  useEffect(() => {
    generation.current += 1;
    inFlight.current = false;
    setSnapshot(null);
    setReadFailed(false);
    load();
  }, [load]);

  useEffect(() => {
    if (!enabled || !trimmedSessionId) return undefined;
    const onFocus = () => load();
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') load();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);
    // 终态不跳过轮询：终态后发送会触发远端重建，重绑事件把会话 id 换成新会话并自动重读，
    // 这里保留轮询作为第二条发现路径（见文件头「刷新口径」）。
    const timer = window.setInterval(() => {
      load();
    }, PSB_SESSION_STATUS_REFRESH_MS);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.clearInterval(timer);
    };
  }, [enabled, load, trimmedSessionId]);

  const gate = snapshot
    ? psbSessionInputAllowed({ session: snapshot.session, workspace: snapshot.workspace })
    : null;

  return {
    snapshot,
    inputAllowed: gate?.allowed ?? true,
    inputBlockedReasonKey: gate?.reason ?? null,
    needsRebind: psbSessionNeedsRebind(snapshot?.session.status),
    refresh: load,
    readFailed,
  };
}
