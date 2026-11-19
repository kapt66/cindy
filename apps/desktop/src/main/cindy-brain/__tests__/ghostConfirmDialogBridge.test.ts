/** ghostConfirmDialogBridge.test — confirm 槽 main↔renderer 往返桥的单测。 */

import { describe, expect, it, vi } from 'vitest';

import {
  createGhostConfirmMainWindowRedelivery,
  createGhostConfirmWindowSender,
  GhostConfirmDialogBridge,
  type GhostConfirmDeliveredTarget,
  type GhostConfirmPush,
  type GhostConfirmDialogBridgeDeps,
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

function makeBridge(overrides: Partial<GhostConfirmDialogBridgeDeps> = {}) {
  const sent: GhostConfirmPush[] = [];
  const deps: GhostConfirmDialogBridgeDeps = {
    sendToWindow: (payload) => {
      sent.push(payload);
      return true;
    },
    timeoutMs: 50,
    ...overrides,
  };
  return { bridge: new GhostConfirmDialogBridge(deps), sent };
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
    const { bridge } = makeBridge({ sendToWindow: () => false });
    await expect(bridge.request(ASK)).rejects.toThrow('没有可挂靠的宿主窗口');
    expect(bridge.pendingCount).toBe(0);
  });

  it('投递结果对象 delivered:false 同样 reject(fail closed)', async () => {
    const { bridge } = makeBridge({
      sendToWindow: () => ({ delivered: false, targetIsMainWindow: false }),
    });
    await expect(bridge.request(ASK)).rejects.toThrow('没有可挂靠的宿主窗口');
  });

  it('没人应答到超时 → 当成没同意(false),并清掉 pending', async () => {
    const warn = vi.fn();
    const { bridge } = makeBridge({ timeoutMs: 10, log: { warn } });
    expect(await bridge.request(ASK)).toBe(false);
    expect(bridge.pendingCount).toBe(0);
    expect(warn).toHaveBeenCalled();
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

const PUSH: GhostConfirmPush = { requestId: 'request-1', ...ASK };

interface FakeConfirmWindow extends GhostConfirmTargetWindow {
  label: string;
  /** 可见性动作与推送的调用顺序(锁「先 bring to front,再 send」)。 */
  calls: string[];
}

function fakeWindow(
  label: string,
  options: { minimized?: boolean; focused?: boolean; destroyed?: boolean } = {},
): FakeConfirmWindow {
  const calls: string[] = [];
  return {
    label,
    calls,
    isDestroyed: () => options.destroyed === true,
    isMinimized: () => options.minimized === true,
    restore: () => {
      calls.push('restore');
    },
    show: () => {
      calls.push('show');
    },
    isFocused: () => options.focused === true,
    focus: () => {
      calls.push('focus');
    },
  };
}

interface SenderHarnessOptions {
  focused?: FakeConfirmWindow | null;
  main?: FakeConfirmWindow | null;
  all?: FakeConfirmWindow[];
  /** 哪些窗口「能承载确认框」;判据在生产是 isModalConfirmHostWindow。 */
  hostable?: (window: FakeConfirmWindow) => boolean;
  throwOnSend?: boolean;
  deliveryTarget?: (window: FakeConfirmWindow, payload: GhostConfirmPush) => GhostConfirmDeliveredTarget | undefined;
}

function makeSender(options: SenderHarnessOptions = {}) {
  const main = options.main === undefined ? fakeWindow('main') : options.main;
  const focused = options.focused === undefined ? main : options.focused;
  const all = options.all ?? [focused, main].filter((win): win is FakeConfirmWindow => Boolean(win));
  const sentTo: FakeConfirmWindow[] = [];
  const send = vi.fn((window: FakeConfirmWindow, _payload: GhostConfirmPush) => {
    if (options.throwOnSend) throw new Error('Object has been destroyed');
    window.calls.push('send');
    sentTo.push(window);
  });
  const warn = vi.fn();
  const sender = createGhostConfirmWindowSender({
    getFocusedWindow: () => focused,
    getMainWindow: () => main,
    getAllWindows: () => all,
    isHostable: options.hostable ?? (() => true),
    send,
    deliveryTarget: options.deliveryTarget,
    log: { warn },
  });
  return { sender, send, warn, main, focused, sentTo };
}

describe('createGhostConfirmWindowSender · 选窗口径(2026-11-19 只投完整主壳)', () => {
  it('focused 是侧栏轻量窗(不可承载)→ 投主窗口,绝不投它', () => {
    const sidebar = fakeWindow('sidebar', { focused: true });
    const main = fakeWindow('main');
    const h = makeSender({
      focused: sidebar,
      main,
      all: [sidebar, main],
      hostable: (window) => window === main,
    });
    expect(h.sender(PUSH)).toEqual({ delivered: true, targetIsMainWindow: true });
    expect(h.sentTo).toEqual([main]);
    expect(sidebar.calls).toEqual([]);
  });

  it('focused 是可承载的完整会话副窗 → 投它(targetIsMainWindow:false),不抢主窗口', () => {
    const session = fakeWindow('session', { focused: true });
    const main = fakeWindow('main');
    const h = makeSender({ focused: session, main, all: [main, session] });
    expect(h.sender(PUSH)).toEqual({ delivered: true, targetIsMainWindow: false });
    expect(h.sentTo).toEqual([session]);
    expect(main.calls).toEqual([]);
  });

  it('focused 不可承载且主窗口也 destroyed → 回落到其它可承载的完整会话窗', () => {
    const sidebar = fakeWindow('sidebar', { focused: true });
    const destroyedMain = fakeWindow('main', { destroyed: true });
    const session = fakeWindow('session');
    const h = makeSender({
      focused: sidebar,
      main: destroyedMain,
      all: [sidebar, destroyedMain, session],
      hostable: (window) => window === session,
    });
    expect(h.sender(PUSH)).toEqual({ delivered: true, targetIsMainWindow: false });
    expect(h.sentTo).toEqual([session]);
    expect(sidebar.calls).toEqual([]);
    expect(destroyedMain.calls).toEqual([]);
  });

  it('只有辅助窗口可承载判定为空 → delivered:false,不投任何窗口(fail closed)', () => {
    const sidebar = fakeWindow('sidebar', { focused: true });
    const usage = fakeWindow('usage');
    const h = makeSender({ focused: sidebar, main: null, all: [sidebar, usage], hostable: () => false });
    expect(h.sender(PUSH)).toEqual({ delivered: false, targetIsMainWindow: false });
    expect(h.send).not.toHaveBeenCalled();
    expect(sidebar.calls).toEqual([]);
    expect(usage.calls).toEqual([]);
  });

  it('目标窗口最小化且在后台:restore → show → focus 之后才 send', () => {
    const main = fakeWindow('main', { minimized: true });
    const h = makeSender({ focused: null, main, all: [main] });
    expect(h.sender(PUSH)).toEqual({ delivered: true, targetIsMainWindow: true });
    expect(main.calls).toEqual(['restore', 'show', 'focus', 'send']);
  });

  it('目标窗口已聚焦:不重复 show/focus,仍照常投递(不每次抢焦点)', () => {
    const main = fakeWindow('main', { focused: true });
    const h = makeSender({ focused: main, main, all: [main] });
    expect(h.sender(PUSH)).toEqual({ delivered: true, targetIsMainWindow: true });
    expect(main.calls).toEqual(['send']);
  });

  it('可见性动作抛错只 warn,不阻断投递', () => {
    const main = fakeWindow('main', { minimized: true });
    main.restore = () => {
      throw new Error('restore failed');
    };
    const h = makeSender({ focused: null, main, all: [main] });
    expect(h.sender(PUSH)).toEqual({ delivered: true, targetIsMainWindow: true });
    expect(main.calls).toEqual(['show', 'focus', 'send']);
    expect(h.warn).toHaveBeenCalledWith(
      expect.stringContaining('restore'),
      expect.objectContaining({ ghostId: 'g1', requestId: 'request-1', err: 'restore failed' }),
    );
  });

  it('推送抛错 → delivered:false(fail closed),不崩', () => {
    const main = fakeWindow('main');
    const h = makeSender({ focused: main, main, all: [main], throwOnSend: true });
    expect(h.sender(PUSH)).toEqual({ delivered: false, targetIsMainWindow: true });
    expect(h.warn).toHaveBeenCalledWith(
      expect.stringContaining('push'),
      expect.objectContaining({ ghostId: 'g1', requestId: 'request-1' }),
    );
  });

  it('登记收卡句柄:投递结果带上目标窗口 id 与 dismissed 动作', () => {
    const main = fakeWindow('main');
    const h = makeSender({
      focused: main,
      main,
      all: [main],
      deliveryTarget: (window) => ({ id: 7, dismiss: () => window.calls.push('dismiss') }),
    });
    const result = h.sender(PUSH);
    expect(result).toMatchObject({ delivered: true, targetIsMainWindow: true });
    expect(result.target?.id).toBe(7);
    result.target?.dismiss();
    expect(main.calls).toEqual(['show', 'focus', 'send', 'dismiss']);
  });

  it('收卡句柄注册抛错只 warn:已经投出去的框不能报成"没投成"', () => {
    const main = fakeWindow('main');
    const h = makeSender({
      focused: main,
      main,
      all: [main],
      deliveryTarget: () => {
        throw new Error('no webContents');
      },
    });
    expect(h.sender(PUSH)).toEqual({ delivered: true, targetIsMainWindow: true });
    expect(h.warn).toHaveBeenCalledWith(
      expect.stringContaining('dismiss handle'),
      expect.objectContaining({ requestId: 'request-1' }),
    );
  });
});

describe('createGhostConfirmMainWindowRedelivery · ack 超时改投主窗口', () => {
  it('主窗口可承载:带到前台后投递', () => {
    const main = fakeWindow('main', { minimized: true });
    const sentTo: FakeConfirmWindow[] = [];
    const redeliver = createGhostConfirmMainWindowRedelivery({
      getMainWindow: () => main,
      isHostable: () => true,
      send: (window) => {
        window.calls.push('send');
        sentTo.push(window);
      },
    });
    expect(redeliver(PUSH)).toMatchObject({ delivered: true, targetIsMainWindow: true });
    expect(main.calls).toEqual(['restore', 'show', 'focus', 'send']);
    expect(sentTo).toEqual([main]);
  });

  it('没有主窗口 / 主窗口不可承载 / 推送抛错 → delivered:false(不扩散成广播)', () => {
    const noMain = createGhostConfirmMainWindowRedelivery({
      getMainWindow: () => null,
      isHostable: () => true,
      send: vi.fn(),
    });
    expect(noMain(PUSH).delivered).toBe(false);

    const main = fakeWindow('main');
    const notHostable = createGhostConfirmMainWindowRedelivery({
      getMainWindow: () => main,
      isHostable: () => false,
      send: vi.fn(),
    });
    expect(notHostable(PUSH).delivered).toBe(false);

    const throwing = createGhostConfirmMainWindowRedelivery({
      getMainWindow: () => main,
      isHostable: () => true,
      send: () => {
        throw new Error('closed');
      },
    });
    expect(throwing(PUSH).delivered).toBe(false);
  });

  it('改投成功时带上主窗口的收卡句柄(供 settle 收起重复框)', () => {
    const main = fakeWindow('main');
    const dismiss = vi.fn();
    const redeliver = createGhostConfirmMainWindowRedelivery({
      getMainWindow: () => main,
      isHostable: () => true,
      send: vi.fn(),
      deliveryTarget: () => ({ id: 2, dismiss }),
    });
    const result = redeliver(PUSH);
    expect(result.target?.id).toBe(2);
    result.target?.dismiss();
    expect(dismiss).toHaveBeenCalledOnce();
  });
});

describe('ghostConfirmDialogBridge · renderer 回执与改投主窗口', () => {
  it('8s 内没有回执且首次不是主窗口 → 改投主窗口一次(同一 requestId)', async () => {
    vi.useFakeTimers();
    try {
      const sent: GhostConfirmPush[] = [];
      const redelivered: GhostConfirmPush[] = [];
      const bridge = new GhostConfirmDialogBridge({
        sendToWindow: (payload) => {
          sent.push(payload);
          return { delivered: true, targetIsMainWindow: false };
        },
        redeliverToMainWindow: (payload) => {
          redelivered.push(payload);
          return true;
        },
        ackTimeoutMs: 8_000,
        timeoutMs: 90_000,
      });
      const pending = bridge.request(ASK);
      expect(sent).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(7_999);
      expect(redelivered).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(redelivered).toHaveLength(1);
      expect(redelivered[0].requestId).toBe(sent[0].requestId);
      // 改投不结算本单:答案仍由用户点击决定。
      expect(bridge.resolve(sent[0].requestId, true)).toBe(true);
      expect(await pending).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('收到 renderer 回执 → 取消改投,答案照常结算', async () => {
    vi.useFakeTimers();
    try {
      let requestId = '';
      const redeliver = vi.fn(() => true);
      const bridge = new GhostConfirmDialogBridge({
        sendToWindow: (payload) => {
          requestId = payload.requestId;
          return { delivered: true, targetIsMainWindow: false };
        },
        redeliverToMainWindow: redeliver,
        ackTimeoutMs: 8_000,
        timeoutMs: 90_000,
      });
      const pending = bridge.request(ASK);
      expect(bridge.acknowledge(requestId)).toBe(true);
      await vi.advanceTimersByTimeAsync(8_000);
      expect(redeliver).not.toHaveBeenCalled();
      bridge.resolve(requestId, false);
      expect(await pending).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('首次已投主窗口 → 不回执也不改投(没有第二处可投)', async () => {
    vi.useFakeTimers();
    try {
      const redeliver = vi.fn(() => true);
      const bridge = new GhostConfirmDialogBridge({
        sendToWindow: () => ({ delivered: true, targetIsMainWindow: true }),
        redeliverToMainWindow: redeliver,
        ackTimeoutMs: 8_000,
        timeoutMs: 90_000,
      });
      const pending = bridge.request(ASK);
      await vi.advanceTimersByTimeAsync(8_000);
      expect(redeliver).not.toHaveBeenCalled();
      bridge.cancelAll();
      expect(await pending).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('旧装配(boolean 投递结果)不启用改投,行为与旧版一致', async () => {
    vi.useFakeTimers();
    try {
      const redeliver = vi.fn(() => true);
      const bridge = new GhostConfirmDialogBridge({
        sendToWindow: () => true,
        redeliverToMainWindow: redeliver,
        ackTimeoutMs: 8_000,
        timeoutMs: 90_000,
      });
      const pending = bridge.request(ASK);
      await vi.advanceTimersByTimeAsync(8_000);
      expect(redeliver).not.toHaveBeenCalled();
      bridge.cancelAll();
      expect(await pending).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('回执只取消改投、不结算本单;陌生 id 回执直接忽略', async () => {
    let requestId = '';
    const bridge = new GhostConfirmDialogBridge({
      sendToWindow: (payload) => {
        requestId = payload.requestId;
        return { delivered: true, targetIsMainWindow: false };
      },
      redeliverToMainWindow: () => true,
      ackTimeoutMs: 60_000,
      timeoutMs: 60_000,
    });
    const pending = bridge.request(ASK);
    expect(bridge.acknowledge(requestId)).toBe(true);
    expect(bridge.acknowledge('not-a-real-id')).toBe(false);
    expect(bridge.pendingCount).toBe(1);
    bridge.cancelAll();
    expect(await pending).toBe(false);
  });

  it('cancelAll / 超时结算会清掉改投闹钟(不留悬挂 timer)', async () => {
    vi.useFakeTimers();
    try {
      const redeliver = vi.fn(() => true);
      const bridge = new GhostConfirmDialogBridge({
        sendToWindow: () => ({ delivered: true, targetIsMainWindow: false }),
        redeliverToMainWindow: redeliver,
        // 兜底超时(10s)先于改投闹钟(20s)到:结算必须把改投闹钟一起清掉。
        ackTimeoutMs: 20_000,
        timeoutMs: 10_000,
      });
      const pending = bridge.request(ASK);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await pending).toBe(false);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(redeliver).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * 8s 没回执会改投主窗口:原窗口只是慢/阻塞时,同一 requestId 会在两个窗口各有一个
 * 模态框。桥要记住每一次成功投递,settle 时向除作答窗口外的已投窗口补发 dismissed。
 */
describe('ghostConfirmDialogBridge · 改投后的重复模态框收卡', () => {
  /** 首次投副窗(id=1);8s 无回执改投主窗(id=2);两个窗口都登记了收卡动作。 */
  function makeMultiWindowBridge() {
    const sent: GhostConfirmPush[] = [];
    const dismissed: string[] = [];
    let latestRequestId = '';
    const bridge = new GhostConfirmDialogBridge({
      sendToWindow: (payload) => {
        latestRequestId = payload.requestId;
        sent.push(payload);
        return {
          delivered: true,
          targetIsMainWindow: false,
          target: { id: 1, dismiss: () => dismissed.push(`secondary:${payload.requestId}`) },
        };
      },
      redeliverToMainWindow: (payload) => {
        sent.push(payload);
        return {
          delivered: true,
          targetIsMainWindow: true,
          target: { id: 2, dismiss: () => dismissed.push(`main:${payload.requestId}`) },
        };
      },
      ackTimeoutMs: 8_000,
      timeoutMs: 90_000,
    });
    return { bridge, sent, dismissed, requestId: () => latestRequestId };
  }

  it('慢窗口迟到回执后作答:只结算一次,改投的主窗口收到 dismissed', async () => {
    vi.useFakeTimers();
    try {
      const h = makeMultiWindowBridge();
      const pending = h.bridge.request(ASK);
      await vi.advanceTimersByTimeAsync(8_000);
      expect(h.sent).toHaveLength(2);
      // 原窗口只是慢:回执在改投之后才到,不再取消改投(闹钟已触发),但答案仍有效。
      expect(h.bridge.acknowledge(h.requestId())).toBe(true);
      expect(h.bridge.resolve(h.requestId(), true, 1)).toBe(true);
      expect(h.dismissed).toEqual([`main:${h.requestId()}`]);
      expect(await pending).toBe(true);
      // 主窗口被收卡后回的迟到答案 handled:false,不改变已结算的 true。
      expect(h.bridge.resolve(h.requestId(), false, 2)).toBe(false);
      expect(h.bridge.pendingCount).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('用户在改投窗口作答:原窗口被收起,答案只结算一次', async () => {
    vi.useFakeTimers();
    try {
      const h = makeMultiWindowBridge();
      const pending = h.bridge.request(ASK);
      await vi.advanceTimersByTimeAsync(8_000);
      expect(h.bridge.resolve(h.requestId(), false, 2)).toBe(true);
      expect(h.dismissed).toEqual([`secondary:${h.requestId()}`]);
      expect(await pending).toBe(false);
      // 原窗口的迟到点击不改变答案,也不产生新的 confirmed:true。
      expect(h.bridge.resolve(h.requestId(), true, 1)).toBe(false);
      expect(await pending).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('兜底超时结算同时收起两个窗口,迟到的 confirmed:true 不生效', async () => {
    vi.useFakeTimers();
    try {
      const h = makeMultiWindowBridge();
      const pending = h.bridge.request(ASK);
      await vi.advanceTimersByTimeAsync(8_000);
      await vi.advanceTimersByTimeAsync(82_000);
      expect(h.dismissed).toEqual([
        `secondary:${h.requestId()}`,
        `main:${h.requestId()}`,
      ]);
      expect(await pending).toBe(false);
      expect(h.bridge.resolve(h.requestId(), true)).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('作答窗口不收自己的 dismissed(只有其它已投窗口才补发)', async () => {
    const dismiss = vi.fn();
    let requestId = '';
    const bridge = new GhostConfirmDialogBridge({
      sendToWindow: (payload) => {
        requestId = payload.requestId;
        return { delivered: true, targetIsMainWindow: true, target: { id: 5, dismiss } };
      },
      timeoutMs: 60_000,
    });
    const pending = bridge.request(ASK);
    expect(bridge.resolve(requestId, true, 5)).toBe(true);
    expect(await pending).toBe(true);
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('清理(cancelAll)没有作答窗口:已投窗口全部补发一次 dismissed', async () => {
    const dismissed: number[] = [];
    const bridge = new GhostConfirmDialogBridge({
      sendToWindow: () => ({
        delivered: true,
        targetIsMainWindow: true,
        target: { id: 9, dismiss: () => dismissed.push(9) },
      }),
      timeoutMs: 60_000,
    });
    const pending = bridge.request(ASK);
    bridge.cancelAll();
    expect(await pending).toBe(false);
    expect(dismissed).toEqual([9]);
  });
});
