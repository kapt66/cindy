/** ghostConfirmDialogBridge.test — confirm 槽 main↔renderer 往返桥的单测。
 *
 * 测试价值
 * - 生产入口与可观察结果:`createGhostConfirmWindowSender` 的广播投递与
 *   `GhostConfirmDialogBridge.request/acknowledge/resolve` 的结算/收卡/ack 诊断。
 *   用户可见结果:所有可承载窗口都弹框、只结算第一个答案、其余窗口的框被收起、
 *   ack 缺失时只把主窗口带到前台而不结算。
 * - Bug／规则依据:2026-11-19 用户复测(会话 8f94e843)第一次 `submit_confirm` 90s
 *   超时——单窗口投递落到用户没在看的窗口,且当时没有 ack 兜底与诊断日志。
 * - 现有覆盖缺口:原用例只锁单窗口投递 + 8s 改投,没有广播、首答收卡与 ack 缺失兜底。
 * - 最小失败输入:两个可承载窗口但用户只点了其中一个;或 8s 内 0 个 ack。
 * - tier:unit(纯依赖注入,无 Electron、无真实等待)。
 * - 实测耗时:本机单独运行约 7.7s,其中 runner setup 约 7.0s、用例执行约 20ms。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  createGhostConfirmWindowSender,
  GhostConfirmDialogBridge,
  selectGhostConfirmWindow,
  type GhostConfirmDeliveredTarget,
  type GhostConfirmDialogBridgeDeps,
  type GhostConfirmPush,
  type GhostConfirmTargetWindow,
} from '../ghostConfirmDialogBridge';

const ASK = {
  ghostId: 'g1',
  ghostName: '确认插件',
  body: '要切分支吗?',
  confirmText: null,
  cancelText: null,
  danger: false,
};

const PUSH: GhostConfirmPush = { requestId: 'request-1', ...ASK };

function makeBridge(overrides: Partial<GhostConfirmDialogBridgeDeps> = {}) {
  const sent: GhostConfirmPush[] = [];
  const deps: GhostConfirmDialogBridgeDeps = {
    sendToWindow: (payload) => {
      sent.push(payload);
      return { delivered: true };
    },
    timeoutMs: 50,
    ...overrides,
  };
  return { bridge: new GhostConfirmDialogBridge(deps), sent };
}

function makeTarget(id: number): GhostConfirmDeliveredTarget & {
  dismiss: ReturnType<typeof vi.fn>;
  stopAttention: ReturnType<typeof vi.fn>;
} {
  return { id, dismiss: vi.fn(), stopAttention: vi.fn() };
}

describe('ghostConfirmDialogBridge · 正常往返', () => {
  it('投出去 → renderer 回包 → resolve 用户的点击', async () => {
    const { bridge, sent } = makeBridge();
    const pending = bridge.request(ASK);
    expect(sent).toHaveLength(1);
    expect(sent[0].requestId).toMatch(/[0-9a-f-]{36}/);
    expect(sent[0].body).toBe('要切分支吗?');
    expect(bridge.pendingCount).toBe(1);

    expect(bridge.resolve(sent[0].requestId, true)).toBe(true);
    expect(await pending).toBe(true);
    expect(bridge.pendingCount).toBe(0);
  });

  it('取消回包 → false', async () => {
    const { bridge, sent } = makeBridge();
    const pending = bridge.request(ASK);
    bridge.resolve(sent[0].requestId, false);
    expect(await pending).toBe(false);
  });
});

describe('ghostConfirmDialogBridge · fail closed', () => {
  it('没有可投窗口 → reject(区别于"用户拒绝")', async () => {
    const { bridge } = makeBridge({ sendToWindow: () => ({ delivered: false }) });
    await expect(bridge.request(ASK)).rejects.toThrow('没有可挂靠的宿主窗口');
    expect(bridge.pendingCount).toBe(0);
  });

  it('投递本身抛错 → 同样 reject,不崩', async () => {
    const warn = vi.fn();
    const { bridge } = makeBridge({
      sendToWindow: () => {
        throw new Error('window destroyed');
      },
      log: { warn },
    });
    await expect(bridge.request(ASK)).rejects.toThrow('没有可挂靠的宿主窗口');
    expect(bridge.pendingCount).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('delivery threw'),
      expect.objectContaining({ ghostId: 'g1', err: 'window destroyed' }),
    );
  });

  it('没人应答到超时 → 当成没同意(false),并清掉 pending', async () => {
    vi.useFakeTimers();
    try {
      const warn = vi.fn();
      const { bridge, sent } = makeBridge({ timeoutMs: 90_000, log: { warn } });
      const pending = bridge.request(ASK);
      await vi.advanceTimersByTimeAsync(90_000);
      expect(await pending).toBe(false);
      expect(bridge.pendingCount).toBe(0);
      expect(warn).toHaveBeenCalledWith(
        'ghost confirm timed out (treated as declined)',
        expect.objectContaining({ requestId: sent[0].requestId, ackCount: 0 }),
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('回包不是布尔 → 一律按没同意兜底(不给靠畸形回包骗到同意的路)', async () => {
    const warn = vi.fn();
    const { bridge, sent } = makeBridge({ log: { warn } });
    const pending = bridge.request(ASK);
    bridge.resolve(sent[0].requestId, 'true');
    expect(await pending).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it('陌生 / 重复的 requestId 直接忽略(返回 false,不抛)', async () => {
    const { bridge, sent } = makeBridge();
    expect(bridge.resolve('not-a-real-id', true)).toBe(false);
    const pending = bridge.request(ASK);
    expect(bridge.resolve(sent[0].requestId, true)).toBe(true);
    expect(bridge.resolve(sent[0].requestId, false)).toBe(false); // 二次回包无效
    expect(await pending).toBe(true);
  });

  it('cancelAll 清在途:全清 / 只清某个插件', async () => {
    const { bridge } = makeBridge({ timeoutMs: 60_000 });
    const a = bridge.request(ASK);
    // 第一单还在场时桥本身不拦(单飞在 confirmSlot),这里直接再投一单验证按 ghostId 清
    const b = bridge.request({ ...ASK, ghostId: 'g2' });
    expect(bridge.pendingCount).toBe(2);

    bridge.cancelAll('g1');
    expect(await a).toBe(false);
    expect(bridge.pendingCount).toBe(1);

    bridge.cancelAll();
    expect(await b).toBe(false);
    expect(bridge.pendingCount).toBe(0);
  });
});

interface FakeConfirmWindow extends GhostConfirmTargetWindow {
  label: string;
  id: number;
  /** 可见性动作与推送的调用顺序(锁「只对置前窗口 bring to front,再 send」)。 */
  calls: string[];
}

function fakeWindow(
  label: string,
  options: { id?: number; minimized?: boolean; focused?: boolean; visible?: boolean; destroyed?: boolean } = {},
): FakeConfirmWindow {
  let focused = options.focused === true;
  const calls: string[] = [];
  return {
    label,
    id: options.id ?? 1,
    calls,
    isDestroyed: () => options.destroyed === true,
    isMinimized: () => options.minimized === true,
    isVisible: () => options.visible ?? options.minimized !== true,
    isFocused: () => focused,
    restore: () => {
      calls.push('restore');
    },
    show: () => {
      calls.push('show');
    },
    focus: () => {
      focused = true;
      calls.push('focus');
    },
    moveTop: () => {
      calls.push('moveTop');
    },
    flashFrame: (flag) => {
      calls.push(flag ? 'flash' : 'unflash');
    },
  };
}

interface SenderHarnessOptions {
  focused?: FakeConfirmWindow | null;
  main?: FakeConfirmWindow | null;
  all?: FakeConfirmWindow[];
  /** 哪些窗口「能承载确认框」;判据在生产是 isModalConfirmHostWindow。 */
  hostable?: (window: FakeConfirmWindow) => boolean;
  throwOnSend?: (window: FakeConfirmWindow) => boolean;
  deliveryTarget?: (window: FakeConfirmWindow) => GhostConfirmDeliveredTarget | undefined;
}

function makeSender(options: SenderHarnessOptions = {}) {
  const main = options.main === undefined ? fakeWindow('main', { id: 1 }) : options.main;
  const focused = options.focused === undefined ? main : options.focused;
  const all = options.all ?? [focused, main].filter((win): win is FakeConfirmWindow => Boolean(win));
  const sentTo: FakeConfirmWindow[] = [];
  const send = vi.fn((window: FakeConfirmWindow, _payload: GhostConfirmPush) => {
    if (options.throwOnSend?.(window)) throw new Error('Object has been destroyed');
    window.calls.push('send');
    sentTo.push(window);
  });
  const info = vi.fn();
  const warn = vi.fn();
  const sender = createGhostConfirmWindowSender({
    getFocusedWindow: () => focused,
    getMainWindow: () => main,
    getAllWindows: () => all,
    isHostable: options.hostable ?? (() => true),
    send,
    deliveryTarget: options.deliveryTarget,
    windowId: (window) => window.id,
    log: { info, warn },
  });
  return { sender, send, info, warn, main, focused, sentTo };
}

describe('createGhostConfirmWindowSender · 本地模式广播(2026-11-19 复测)', () => {
  it('广播到两个可承载窗口;只把置前窗口 restore/show/focus/moveTop/flash,其余只 push', () => {
    const sidebar = fakeWindow('sidebar', { focused: true, id: 9 });
    const main = fakeWindow('main', { id: 2, minimized: true });
    const session = fakeWindow('session', { id: 3 });
    const h = makeSender({
      focused: sidebar,
      main,
      all: [sidebar, session, main],
      hostable: (window) => window !== sidebar,
      deliveryTarget: (window) => makeTarget(window.id),
    });

    const result = h.sender(PUSH);

    expect(result.delivered).toBe(true);
    expect(result.targets?.map((target) => target.id)).toEqual([3, 2]);
    expect(h.sentTo).toEqual([session, main]);
    // 侧栏窗不可承载:既不 push,也不做任何可见性动作。
    expect(sidebar.calls).toEqual([]);
    // 置前窗口(聚焦的侧栏不可承载 → 主窗口)先带到前台,再推送。
    expect(main.calls).toEqual(['restore', 'show', 'focus', 'moveTop', 'flash', 'send']);
    // 其余可承载窗口只 push,不抢焦点。
    expect(session.calls).toEqual(['send']);

    expect(h.info).toHaveBeenCalledWith('ghost confirm: delivered', {
      ghostId: 'g1',
      requestId: 'request-1',
      windowCount: 2,
      primary: 2,
      windows: [
        { id: 3, isMain: false, visible: true, focused: false, minimized: false, delivered: true },
        // 置前窗口被 focus 后日志如实记 focused:true(它已经被带到最前)。
        { id: 2, isMain: true, visible: false, focused: true, minimized: true, delivered: true },
      ],
    });
    // 诊断日志不带插件正文。
    expect(JSON.stringify(h.info.mock.calls)).not.toContain('要切分支吗?');
  });

  it('聚焦的可承载会话副窗也参与广播:两处都 push,只有它不被抢焦点', () => {
    const session = fakeWindow('session', { focused: true, id: 3 });
    const main = fakeWindow('main', { id: 2 });
    const h = makeSender({ focused: session, main, all: [main, session] });

    const result = h.sender(PUSH);

    expect(result.delivered).toBe(true);
    expect(h.sentTo).toEqual([main, session]);
    expect(main.calls).toEqual(['send']);
    expect(session.calls).toEqual(['send']);
    const delivered = h.info.mock.calls.find(([message]) => message === 'ghost confirm: delivered');
    expect(delivered?.[1]).toMatchObject({
      windowCount: 2,
      primary: 3,
      windows: [
        { id: 2, isMain: true, focused: false, delivered: true },
        { id: 3, isMain: false, focused: true, delivered: true },
      ],
    });
  });

  it('都没有聚焦且主窗口不可承载 → 第一个可承载窗口被带到前台', () => {
    const session = fakeWindow('session', { id: 3 });
    const h = makeSender({ focused: null, main: null, all: [session] });

    expect(h.sender(PUSH)).toMatchObject({ delivered: true });
    expect(session.calls).toEqual(['show', 'focus', 'moveTop', 'flash', 'send']);
  });

  it('只有辅助/不可承载窗口 → delivered:false,不 push 也不抢焦点(fail closed)', () => {
    const sidebar = fakeWindow('sidebar', { focused: true });
    const usage = fakeWindow('usage');
    const h = makeSender({
      focused: sidebar,
      main: null,
      all: [sidebar, usage],
      hostable: () => false,
    });

    expect(h.sender(PUSH)).toEqual({ delivered: false });
    expect(h.send).not.toHaveBeenCalled();
    expect(sidebar.calls).toEqual([]);
    expect(usage.calls).toEqual([]);
    expect(h.warn).toHaveBeenCalledWith(
      'ghost confirm: no host window to deliver the dialog',
      expect.objectContaining({ ghostId: 'g1', requestId: 'request-1' }),
    );
  });

  it('部分窗口推送失败:另一处投成功就算投递成功,失败窗口只 warn', () => {
    const main = fakeWindow('main', { id: 2, minimized: true });
    const session = fakeWindow('session', { id: 3 });
    const h = makeSender({
      focused: null,
      main,
      all: [main, session],
      throwOnSend: (window) => window === main,
      deliveryTarget: (window) => makeTarget(window.id),
    });

    const result = h.sender(PUSH);

    expect(result.delivered).toBe(true);
    expect(result.targets?.map((target) => target.id)).toEqual([3]);
    expect(h.sentTo).toEqual([session]);
    expect(h.warn).toHaveBeenCalledWith(
      expect.stringContaining('failed to push the dialog'),
      expect.objectContaining({ requestId: 'request-1' }),
    );
    const delivered = h.info.mock.calls.find(([message]) => message === 'ghost confirm: delivered');
    expect(delivered?.[1]).toMatchObject({
      windowCount: 1,
      windows: [
        { id: 2, isMain: true, delivered: false },
        { id: 3, isMain: false, delivered: true },
      ],
    });
  });

  it('所有窗口都推送失败 → delivered:false(fail closed)', () => {
    const h = makeSender({ all: [fakeWindow('main'), fakeWindow('session')], throwOnSend: () => true });
    expect(h.sender(PUSH)).toEqual({ delivered: false });
  });

  it('可见性动作抛错只 warn,不阻断投递', () => {
    const main = fakeWindow('main', { minimized: true });
    main.restore = () => {
      throw new Error('restore failed');
    };
    const h = makeSender({ focused: null, main, all: [main] });

    expect(h.sender(PUSH)).toMatchObject({ delivered: true });
    expect(main.calls).toEqual(['show', 'focus', 'moveTop', 'flash', 'send']);
    expect(h.warn).toHaveBeenCalledWith(
      expect.stringContaining('restore'),
      expect.objectContaining({ ghostId: 'g1', requestId: 'request-1', err: 'restore failed' }),
    );
  });

  it('收卡句柄注册抛错只 warn:已经投出去的框不能报成"没投成"', () => {
    const main = fakeWindow('main');
    const h = makeSender({
      focused: null,
      main,
      all: [main],
      deliveryTarget: () => {
        throw new Error('no webContents');
      },
    });

    const result = h.sender(PUSH);

    expect(result.delivered).toBe(true);
    expect(result.targets).toBeUndefined();
    expect(h.warn).toHaveBeenCalledWith(
      expect.stringContaining('dismiss handle'),
      expect.objectContaining({ requestId: 'request-1' }),
    );
  });
});

describe('selectGhostConfirmWindow · client-mode 单窗口口径', () => {
  it('聚焦可承载 → 主窗口 → 第一个可承载 → null', () => {
    const sidebar = fakeWindow('sidebar', { focused: true, id: 9 });
    const main = fakeWindow('main', { id: 2 });
    const session = fakeWindow('session', { id: 3 });
    const candidates = (
      focused: FakeConfirmWindow | null,
      mainWindow: FakeConfirmWindow | null,
      all: FakeConfirmWindow[],
      hostable: (window: FakeConfirmWindow) => boolean,
    ) => ({
      getFocusedWindow: () => focused,
      getMainWindow: () => mainWindow,
      getAllWindows: () => all,
      isHostable: hostable,
    });

    expect(selectGhostConfirmWindow(candidates(session, main, [main, session], () => true))).toBe(session);
    expect(selectGhostConfirmWindow(candidates(sidebar, main, [sidebar, session, main], (window) => window !== sidebar))).toBe(main);
    const destroyedMain = fakeWindow('main', { destroyed: true });
    expect(selectGhostConfirmWindow(
      candidates(sidebar, destroyedMain, [sidebar, session, destroyedMain], (window) => window === session),
    )).toBe(session);
    expect(selectGhostConfirmWindow(candidates(sidebar, null, [sidebar], () => false))).toBeNull();
  });
});

describe('ghostConfirmDialogBridge · 广播后的首答结算与收卡', () => {
  it('第一个 resolve 结算答案,其它已投窗口收到 dismissed 并停掉任务栏闪烁', async () => {
    const targets = [makeTarget(1), makeTarget(2)];
    const info = vi.fn();
    let requestId = '';
    const bridge = new GhostConfirmDialogBridge({
      sendToWindow: (payload) => {
        requestId = payload.requestId;
        return { delivered: true, targets };
      },
      timeoutMs: 60_000,
      log: { info, warn: vi.fn() },
    });
    const pending = bridge.request(ASK);

    expect(bridge.resolve(requestId, true, 1)).toBe(true);
    expect(await pending).toBe(true);
    expect(targets[1].dismiss).toHaveBeenCalledOnce();
    expect(targets[0].dismiss).not.toHaveBeenCalled();
    expect(targets[0].stopAttention).toHaveBeenCalledOnce();
    expect(targets[1].stopAttention).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledWith('ghost confirm: settle', {
      ghostId: 'g1',
      requestId,
      answeredBy: 1,
      confirmed: true,
      dismissed: 1,
    });
    // 迟到的第二个答案一律 handled:false,不改变已结算的 true。
    expect(bridge.resolve(requestId, false, 2)).toBe(false);
    expect(bridge.pendingCount).toBe(0);
  });

  it('清理(cancelAll)没有作答窗口:已投窗口全部收卡,答案 false', async () => {
    const targets = [makeTarget(1), makeTarget(2)];
    const bridge = new GhostConfirmDialogBridge({
      sendToWindow: () => ({ delivered: true, targets }),
      timeoutMs: 60_000,
    });
    const pending = bridge.request(ASK);
    bridge.cancelAll();
    expect(await pending).toBe(false);
    expect(targets.every((target) => target.dismiss.mock.calls.length === 1)).toBe(true);
  });
});

describe('ghostConfirmDialogBridge · ack 观测(只做诊断,不改投)', () => {
  it('8s 内一个 ack 都没有 → 只把主窗口带到前台,不结算;随后作答照常成功', async () => {
    vi.useFakeTimers();
    try {
      const targets = [makeTarget(1), makeTarget(2)];
      const raiseMainWindow = vi.fn();
      const warn = vi.fn();
      let requestId = '';
      const bridge = new GhostConfirmDialogBridge({
        sendToWindow: (payload) => {
          requestId = payload.requestId;
          return { delivered: true, targets };
        },
        raiseMainWindow,
        ackTimeoutMs: 8_000,
        timeoutMs: 90_000,
        log: { info: vi.fn(), warn },
      });
      const pending = bridge.request(ASK);

      await vi.advanceTimersByTimeAsync(7_999);
      expect(raiseMainWindow).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(raiseMainWindow).toHaveBeenCalledOnce();
      expect(raiseMainWindow).toHaveBeenCalledWith(requestId);
      expect(warn).toHaveBeenCalledWith(
        'ghost confirm: ack missing; forcing main window to front',
        expect.objectContaining({ requestId, targetCount: 2 }),
      );
      // 兜底只影响可见性:不结算、不收卡,用户仍可从任一窗口作答。
      expect(bridge.pendingCount).toBe(1);
      expect(targets[0].dismiss).not.toHaveBeenCalled();

      expect(bridge.resolve(requestId, true, 1)).toBe(true);
      expect(await pending).toBe(true);
      expect(targets[1].dismiss).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('任一窗口 ack 即取消主窗口兜底,并记下窗口 id 与延迟', async () => {
    vi.useFakeTimers();
    try {
      const raiseMainWindow = vi.fn();
      const info = vi.fn();
      let requestId = '';
      const bridge = new GhostConfirmDialogBridge({
        sendToWindow: (payload) => {
          requestId = payload.requestId;
          return { delivered: true, targets: [makeTarget(1), makeTarget(2)] };
        },
        raiseMainWindow,
        ackTimeoutMs: 8_000,
        timeoutMs: 90_000,
        log: { info, warn: vi.fn() },
      });
      const pending = bridge.request(ASK);

      await vi.advanceTimersByTimeAsync(250);
      expect(bridge.acknowledge(requestId, 2)).toBe(true);
      expect(info).toHaveBeenCalledWith('ghost confirm: renderer ack', {
        ghostId: 'g1',
        requestId,
        windowId: 2,
        latencyMs: 250,
      });
      expect(bridge.acknowledge('not-a-real-id', 2)).toBe(false);
      await vi.advanceTimersByTimeAsync(8_000);
      expect(raiseMainWindow).not.toHaveBeenCalled();

      bridge.resolve(requestId, false, 2);
      expect(await pending).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ack 兜底触发后才到的回执仍记日志(标记 afterAckTimeout),不重复提主窗口', async () => {
    vi.useFakeTimers();
    try {
      const raiseMainWindow = vi.fn();
      const info = vi.fn();
      let requestId = '';
      const bridge = new GhostConfirmDialogBridge({
        sendToWindow: (payload) => {
          requestId = payload.requestId;
          return { delivered: true, targets: [makeTarget(1)] };
        },
        raiseMainWindow,
        ackTimeoutMs: 8_000,
        timeoutMs: 90_000,
        log: { info, warn: vi.fn() },
      });
      const pending = bridge.request(ASK);
      await vi.advanceTimersByTimeAsync(8_000);
      expect(raiseMainWindow).toHaveBeenCalledOnce();

      expect(bridge.acknowledge(requestId, 1)).toBe(true);
      expect(info).toHaveBeenCalledWith(
        'ghost confirm: renderer ack',
        expect.objectContaining({ requestId, windowId: 1, afterAckTimeout: true }),
      );
      expect(raiseMainWindow).toHaveBeenCalledOnce();
      bridge.cancelAll();
      expect(await pending).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('超时留痕带 ack 数;已投窗口全部收卡,迟到的 confirmed:true 不生效', async () => {
    vi.useFakeTimers();
    try {
      const targets = [makeTarget(1), makeTarget(2)];
      const warn = vi.fn();
      let requestId = '';
      const bridge = new GhostConfirmDialogBridge({
        sendToWindow: (payload) => {
          requestId = payload.requestId;
          return { delivered: true, targets };
        },
        ackTimeoutMs: 8_000,
        timeoutMs: 10_000,
        log: { info: vi.fn(), warn },
      });
      const pending = bridge.request(ASK);
      expect(bridge.acknowledge(requestId, 1)).toBe(true);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(await pending).toBe(false);
      expect(warn).toHaveBeenCalledWith(
        'ghost confirm timed out (treated as declined)',
        expect.objectContaining({ requestId, ackCount: 1 }),
      );
      expect(targets.every((target) => target.dismiss.mock.calls.length === 1)).toBe(true);
      expect(targets.every((target) => target.stopAttention.mock.calls.length === 1)).toBe(true);
      expect(bridge.resolve(requestId, true)).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
