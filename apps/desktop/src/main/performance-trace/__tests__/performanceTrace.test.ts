import { afterEach, describe, expect, it, vi } from 'vitest';
import { PerformanceTraceController, type TraceControllerDeps } from '../controller';
import { projectCpuProfile, projectTraceEvent, type TraceReport } from '../report';
import { measureTraceOperation, setTraceOperationObserver } from '../measure';
import { createTraceCommandHandler, createTraceStatePublisher } from '../ipc';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { PERFORMANCE_TRACE_STATE_CHANNEL } from '../../../shared/performanceTrace';
import { mkdtemp, writeFile, rm, mkdir, utimes, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cleanupTraceReports, startTraceRetention, TRACE_RETENTION_MS } from '../retention';
import { generateTraceReportId, TRACE_REPORT_ID_PATTERN } from '../reportId';

/** Test value: production recording lifecycle and local-only retention.
 * WL-26（Meka 不启用客户端日志上报）把性能跟踪收敛为本地录制：录制 → 本地保存 → 查看目录 →
 * 7 天保留期，上传动作/命令/界面均已移除。这些用例锁住 start/stop/60s 自动停止、账号代次隔离、
 * reveal 与保留期清理，并守住「命令面不得重新出现 upload」这条 WL-26 边界。
 * 现有覆盖缺口：原生采集（Chromium contentTracing / CPU profiler）只在隔离 Electron 冒烟里验证，
 * 本文件用注入的 capture 替身；渲染层走 MenuButton.test.tsx 与 ui:check fixture。
 * 最小失败输入：并发 start/stop、保存期间换账号、销毁源窗口后从主窗口接管、过期目录含活动报告。
 * Tier: unit，注入时钟/采集器，文件固定在一个 OS 临时目录，无真实等待。
 */
function fixture() {
  let now = 1000,
    owner = 'alice:1';
  const reports: TraceReport[] = [];
  const stop = vi.fn(async () => ({ profiles: [], partial: false }));
  const deps: TraceControllerDeps = {
    now: () => now,
    owner: () => owner,
    reportId: () => 'ABCD-EFGH',
    environment: () => ({ appVersion: 'test', platform: 'win32', arch: 'x64' }),
    begin: vi.fn(async () => ({ stop })),
    save: vi.fn(async (report) => {
      reports.push(structuredClone(report));
    }),
    reveal: vi.fn(async () => {}),
    changed: vi.fn(),
  };
  return {
    controller: new PerformanceTraceController(deps),
    deps,
    stop,
    reports,
    advance: (value: number) => {
      now += value;
    },
    owner: (value: string) => {
      owner = value;
    },
  };
}
afterEach(() => {
  setTraceOperationObserver(null);
  vi.useRealTimers();
});

describe('performance recording', () => {
  it.each([false, true])(
    'discards a report when ownership changes during saving (save fails: %s)',
    async (fails) => {
      const f = fixture();
      let finish!: () => void;
      let entered!: () => void;
      const saving = new Promise<void>((resolve) => {
        entered = resolve;
      });
      vi.mocked(f.deps.save).mockImplementationOnce(
        () =>
          new Promise<void>((resolve, reject) => {
            finish = () => (fails ? reject(new Error('save failed')) : resolve());
            entered();
          }),
      );
      await f.controller.start();
      const stopping = f.controller.stop();
      await saving;
      f.owner('bob:2');
      finish();
      expect((await stopping).phase).toBe('idle');
      // A discarded result must not merely be hidden by snapshot's owner filter.
      f.owner('alice:1');
      expect(f.controller.snapshot()).toMatchObject({ phase: 'idle', reportId: null });
      await expect(f.controller.reveal()).rejects.toThrow('PRECONDITION_FAILED');
      expect(f.deps.reveal).not.toHaveBeenCalled();
    },
  );

  it('publishes automatic stop completion to the replacement main window without moving the capture', async () => {
    const f = fixture();
    const originalSend = vi.fn(),
      replacementSend = vi.fn();
    let destroyed = false,
      trusted = true;
    const original = {
      isDestroyed: () => destroyed,
      webContents: { isDestroyed: () => destroyed, send: originalSend },
    } as unknown as BrowserWindow;
    const replacement = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: replacementSend },
    } as unknown as BrowserWindow;
    let current: BrowserWindow | null = original;
    const publish = createTraceStatePublisher({
      getMainWindow: () => current,
      isTrustedWindow: () => trusted,
    });
    f.deps.changed = publish;
    let finish!: () => void;
    f.stop.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ profiles: [], partial: true });
        }),
    );
    await f.controller.start();
    destroyed = true;
    current = replacement;
    // Native capture calls close on source destruction. The new renderer can
    // mount while it is saving; it needs a later push without another IPC command.
    const closing = f.controller.close();
    expect(f.controller.snapshot().phase).toBe('saving');
    expect(replacementSend).toHaveBeenLastCalledWith(
      PERFORMANCE_TRACE_STATE_CHANNEL,
      expect.objectContaining({ phase: 'saving' }),
    );
    finish();
    await closing;
    expect(replacementSend).toHaveBeenLastCalledWith(
      PERFORMANCE_TRACE_STATE_CHANNEL,
      expect.objectContaining({ phase: 'ready', reportId: 'ABCD-EFGH', partial: true }),
    );
    expect(originalSend).toHaveBeenCalledTimes(2); // starting, recording only
    expect(f.deps.begin).toHaveBeenCalledOnce();
    replacementSend.mockClear();
    trusted = false;
    publish(f.controller.snapshot());
    current = original; // destroyed windows are never recipients
    trusted = true;
    publish(f.controller.snapshot());
    current = null;
    publish(f.controller.snapshot());
    expect(replacementSend).not.toHaveBeenCalled();
    expect(originalSend).toHaveBeenCalledTimes(2);
  });
  // Session invalidation fires before the new generation is committed. The callback passed
  // to native startup must already reject this old operation at that boundary.
  it('invalidates pending startup and discards the capture without saving across accounts', async () => {
    const f = fixture();
    let finish!: () => void;
    let isCurrent!: () => boolean;
    vi.mocked(f.deps.begin).mockImplementationOnce((_id, _at, current) => {
      isCurrent = current;
      return new Promise((resolve) => {
        finish = () => resolve({ stop: f.stop });
      });
    });
    const starting = f.controller.start();
    const rejected = expect(starting).rejects.toThrow('PRECONDITION_FAILED');
    expect(isCurrent()).toBe(true);
    const closing = f.controller.invalidate();
    expect(isCurrent()).toBe(false);
    f.owner('bob:2');
    finish();
    await Promise.all([rejected, closing]);
    expect(f.stop).toHaveBeenCalledWith({ discard: true });
    expect(f.reports).toEqual([]);
    expect(f.controller.snapshot().phase).toBe('idle');
  });
  // Review: a close during pending begin used to return before capture.stop/save.
  // Unit: deferred native start (success and failure), no real waits or profiler.
  it.each([false, true])(
    'waits for pending startup before closing (start fails: %s)',
    async (fails) => {
      const f = fixture();
      let finish!: () => void;
      vi.mocked(f.deps.begin).mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            finish = () => (fails ? reject(new Error('start failed')) : resolve({ stop: f.stop }));
          }),
      );
      const starting = f.controller.start().catch(() => undefined);
      let closed = false;
      const closing = f.controller.close().then(() => {
        closed = true;
      });
      await Promise.resolve();
      expect(closed).toBe(false);
      finish();
      await Promise.all([starting, closing]);
      expect(closed).toBe(true);
      expect(f.stop).toHaveBeenCalledTimes(fails ? 0 : 1);
      expect(f.reports).toHaveLength(fails ? 0 : 1);
      expect(f.controller.snapshot().phase).toBe(fails ? 'idle' : 'ready');
    },
  );
  // Retention must not delete an active capture or resurrect an expired in-memory report.
  it('releases completed reports for retention while protecting captures and reveal', async () => {
    const f = fixture();
    await f.controller.start();
    expect(f.controller.releaseExpiredReport('ABCD-EFGH')).toBe(false);
    await f.controller.stop();
    let finish!: () => void;
    vi.mocked(f.deps.save).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const revealing = f.controller.reveal();
    expect(f.controller.releaseExpiredReport('ABCD-EFGH')).toBe(false);
    expect(f.controller.canStart()).toBe(false);
    finish();
    await revealing;
    expect(f.controller.releaseExpiredReport('ABCD-EFGH')).toBe(true);
    expect(f.controller.snapshot().phase).toBe('idle');
    await expect(f.controller.reveal()).rejects.toThrow('PRECONDITION_FAILED');
  });
  it('records only during a capture, preserves timeline data, and saves once on concurrent stops', async () => {
    const f = fixture();
    const event = {
      at: 1000,
      kind: 'input',
      label: 'keydown',
      durationMs: 80,
      text: 'private text',
    };
    f.controller.events([event]);
    await f.controller.start();
    f.controller.events([event]);
    f.advance(100);
    await Promise.all([f.controller.stop(), f.controller.stop()]);
    expect(f.stop).toHaveBeenCalledOnce();
    expect(f.reports).toHaveLength(1);
    expect(f.reports[0]).toMatchObject({
      durationMs: 100,
      scope: 'local-desktop',
      remoteHostCaptured: false,
      events: [{ at: 1000, kind: 'input', label: 'keydown', durationMs: 80 }],
    });
    expect(JSON.stringify(f.reports)).not.toContain('private text');
  });
  it('rejects overlapping starts and stops automatically at the 60 second limit', async () => {
    vi.useFakeTimers();
    const f = fixture();
    vi.mocked(f.deps.begin).mockImplementationOnce(async () => {
      f.advance(10_000);
      return { stop: f.stop };
    });
    await f.controller.start();
    await expect(f.controller.start()).rejects.toThrow('PRECONDITION_FAILED');
    f.advance(50_000);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(f.controller.snapshot()).toMatchObject({ phase: 'ready', durationMs: 60_000 });
  });
  it('waits for an already-saving capture when the application closes', async () => {
    const f = fixture();
    let finish!: () => void;
    f.stop.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ profiles: [], partial: false });
        }),
    );
    await f.controller.start();
    const stopping = f.controller.stop();
    let closed = false;
    const closing = f.controller.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    finish();
    await Promise.all([stopping, closing]);
    expect(f.reports).toHaveLength(1);
    expect(closed).toBe(true);
  });
  it('hides old-owner results and rejects reveal after switching accounts', async () => {
    const f = fixture();
    await f.controller.start();
    f.owner('bob:2');
    await f.controller.close();
    expect(f.controller.snapshot()).toMatchObject({ phase: 'idle', reportId: null });
    await expect(f.controller.reveal()).rejects.toThrow('PRECONDITION_FAILED');
    expect(f.deps.reveal).not.toHaveBeenCalled();
  });
  // Review regression: reveal must not open the old owner's files after an awaited save.
  // The preceding owner test only switches before invocation; this unit suspends the save.
  it('rejects revealing old-owner files when the account changes during saving', async () => {
    const f = fixture();
    await f.controller.start();
    await f.controller.stop();
    let finishSave!: () => void;
    vi.mocked(f.deps.save).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve;
        }),
    );
    const revealing = f.controller.reveal();
    const rejected = expect(revealing).rejects.toThrow('PRECONDITION_FAILED');
    f.owner('bob:2');
    finishSave();
    await rejected;
    expect(f.deps.reveal).not.toHaveBeenCalled();
    expect(f.controller.snapshot()).toMatchObject({ phase: 'idle', reportId: null });
  });
  it('recovers a failed start and retains partial results if a profiler fails at stop', async () => {
    const f = fixture();
    vi.mocked(f.deps.begin).mockRejectedValueOnce(new Error('busy'));
    await expect(f.controller.start()).rejects.toThrow('busy');
    expect(f.controller.snapshot().phase).toBe('idle');
    await f.controller.start();
    f.stop.mockRejectedValueOnce(new Error('renderer gone'));
    await f.controller.stop();
    expect(f.reports[0].partial).toBe(true);
    expect(f.controller.snapshot().phase).toBe('ready');
  });
  it('retries saving the in-memory report after disk write failure', async () => {
    const f = fixture();
    await f.controller.start();
    vi.mocked(f.deps.save).mockRejectedValueOnce(new Error('disk full'));
    await expect(f.controller.stop()).rejects.toThrow('disk full');
    expect(f.controller.snapshot()).toMatchObject({ phase: 'ready', partial: true });
    await f.controller.reveal();
    expect(f.reports).toHaveLength(1);
  });
});

describe('local report id', () => {
  // WL-26：录制编号不再复用 log-upload 的上传编号；但目录名形状是 retention 的清理判据，
  // 两者必须同时成立，否则升级后旧报告永远不会被清理。
  // Minimal regression: 生成器改用 `%` 取模或改了字符集 ⇒ retention 不再识别新目录。
  it('generates the directory shape retention uses, without an upload-code dependency', () => {
    const id = generateTraceReportId((size) => Uint8Array.from({ length: size }, (_, i) => i));
    expect(TRACE_REPORT_ID_PATTERN.test(id)).toBe(true);
    // rejection sampling：>= limit（240）的字节被丢弃，不直接取模。
    const rejected = generateTraceReportId(() =>
      Uint8Array.from([240, ...Array.from({ length: 15 }, () => 0)]),
    );
    expect(rejected).toBe('2222-2222');
  });
});

describe('performance report retention', () => {
  // Review: expired raw profiles survived indefinitely without another recording.
  // Real cleanup entry, bounded OS temp fixtures; the former tests covered no retention.
  it('removes only expired generated directories and preserves active/new/exported files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-trace-retention-'));
    const now = Date.now();
    const old = new Date(now - TRACE_RETENTION_MS - 1);
    try {
      for (const name of ['2345-6789', 'BCDE-FGHJ', 'K M N', 'PQRS-TVWX']) {
        const dir = path.join(root, name);
        await mkdir(dir);
        await writeFile(path.join(dir, 'chromium-trace.json'), '{}');
        if (name !== 'PQRS-TVWX') await utimes(dir, old, old);
      }
      await writeFile(path.join(root, 'YZ23-4567'), 'not a directory');
      await cleanupTraceReports(root, (id) => id !== 'BCDE-FGHJ', now);
      expect((await readdir(root)).sort()).toEqual([
        'BCDE-FGHJ',
        'K M N',
        'PQRS-TVWX',
        'YZ23-4567',
      ]);
      await cleanupTraceReports(root, () => true, now);
      expect(await readdir(root)).not.toContain('BCDE-FGHJ');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('sweeps at startup and hourly without recordings, avoids overlaps, and stops on disposal', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const sweep = vi.fn(async () => {});
    sweep.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const dispose = startTraceRetention(sweep);
    expect(sweep).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(3600_000);
    expect(sweep).toHaveBeenCalledOnce();
    finish();
    await vi.advanceTimersByTimeAsync(3600_000);
    expect(sweep).toHaveBeenCalledTimes(2);
    dispose();
    await vi.advanceTimersByTimeAsync(3600_000);
    expect(sweep).toHaveBeenCalledTimes(2);
  });
});

describe('report boundary', () => {
  it('rejects start from a trusted secondary window without replacing the current report', async () => {
    const f = fixture();
    const main = {} as IpcMainInvokeEvent,
      secondary = {} as IpcMainInvokeEvent;
    let source: IpcMainInvokeEvent | null = null;
    const handler = createTraceCommandHandler({
      controller: f.controller,
      authorize: () => {},
      isSource: (event) => event === source,
      isSourceDestroyed: () => false,
      isMainWindow: (event) => event === main,
      selectSource: (event) => {
        source = event;
      },
      showFolder: vi.fn(async () => {}),
    });
    await expect(handler(secondary, 'start')).rejects.toThrow('PRECONDITION_FAILED');
    expect(source).toBeNull();
    expect(f.deps.begin).not.toHaveBeenCalled();
    await handler(main, 'start');
    await handler(main, 'stop');
    const report = f.controller.snapshot();
    await expect(handler(secondary, 'start')).rejects.toThrow('PRECONDITION_FAILED');
    expect(source).toBe(main);
    expect(f.controller.snapshot()).toEqual(report);
    expect(f.deps.begin).toHaveBeenCalledOnce();
  });
  it('checks sender authorization and recording window before starting or reading files', async () => {
    const f = fixture();
    let source = false;
    const authorize = vi.fn<() => void>(() => {
      throw new Error('untrusted sender');
    });
    const showFolder = vi.fn(async () => {});
    const handler = createTraceCommandHandler({
      controller: f.controller,
      authorize,
      isSource: () => source,
      isSourceDestroyed: () => false,
      isMainWindow: () => true,
      selectSource: () => {
        source = true;
      },
      showFolder,
    });
    const event = {} as IpcMainInvokeEvent;
    await expect(handler(event, 'start')).rejects.toThrow('untrusted sender');
    expect(f.deps.begin).not.toHaveBeenCalled();
    authorize.mockImplementation(() => {});
    await expect(handler(event, { toString: () => 'start' })).rejects.toThrow('INVALID_PARAMS');
    await handler(event, 'show-local');
    expect(showFolder).toHaveBeenCalledOnce();
    await handler(event, 'start');
    source = false;
    await expect(handler(event, 'stop')).rejects.toThrow('PRECONDITION_FAILED');
    source = true;
    await handler(event, 'stop');
    vi.mocked(f.deps.reveal).mockRejectedValueOnce(new Error('/Users/private/report.json'));
    await expect(handler(event, 'show-local')).rejects.toThrow(
      '[INTERNAL] Performance recording operation failed',
    );
  });
  it.each(['state', 'show-local'])(
    'restores a completed report through %s after its source window is destroyed',
    async (command) => {
      const f = fixture();
      const original = {} as IpcMainInvokeEvent;
      const replacement = {} as IpcMainInvokeEvent;
      let source = original;
      let main = original;
      let destroyed = false;
      const handler = createTraceCommandHandler({
        controller: f.controller,
        authorize: () => {},
        isSource: (event) => event === source,
        isSourceDestroyed: () => destroyed,
        isMainWindow: (event) => event === main,
        selectSource: (event) => {
          source = event;
          destroyed = false;
        },
        showFolder: vi.fn(async () => {}),
      });
      await handler(original, 'start');
      await handler(original, 'stop');
      // Reloading the same WebContents already works without transferring ownership.
      await handler(original, 'show-local');
      destroyed = true;
      main = replacement;
      const state = await handler(replacement, command);
      expect(state.phase).toBe('ready');
      expect(state.reportId).toBe('ABCD-EFGH');
      expect(source).toBe(replacement);
      await handler(replacement, 'show-local');
      expect(f.deps.reveal).toHaveBeenLastCalledWith('ABCD-EFGH');
      expect(f.deps.begin).toHaveBeenCalledOnce();
    },
  );

  it('does not transfer reports to another window during capture or across owner boundaries', async () => {
    const f = fixture();
    const original = {} as IpcMainInvokeEvent;
    const replacement = {} as IpcMainInvokeEvent;
    let source = original;
    let destroyed = true;
    let main = true;
    let trusted = true;
    const handler = createTraceCommandHandler({
      controller: f.controller,
      authorize: () => {
        if (!trusted) throw new Error('untrusted sender');
      },
      isSource: (event) => event === source,
      isSourceDestroyed: () => destroyed,
      isMainWindow: () => main,
      selectSource: (event) => {
        source = event;
      },
      showFolder: vi.fn(async () => {}),
    });
    await handler(original, 'start');
    expect((await handler(replacement, 'state')).phase).toBe('recording');
    await expect(handler(replacement, 'stop')).rejects.toThrow('PRECONDITION_FAILED');
    expect(source).toBe(original);
    await handler(original, 'stop');
    destroyed = false;
    await expect(handler(replacement, 'show-local')).rejects.toThrow('PRECONDITION_FAILED');
    destroyed = true;
    main = false;
    await expect(handler(replacement, 'show-local')).rejects.toThrow('PRECONDITION_FAILED');
    main = true;
    trusted = false;
    await expect(handler(replacement, 'show-local')).rejects.toThrow('untrusted sender');
    trusted = true;
    f.owner('bob:2');
    expect((await handler(replacement, 'state')).phase).toBe('idle');
    // 新账号只能看到「没有报告」，打不开上一个账号的文件。
    expect((await handler(replacement, 'show-local')).phase).toBe('idle');
    expect(f.deps.reveal).not.toHaveBeenCalled();
  });
  // WL-26 反回归门：Meka 不启用客户端日志上报，录制结果只留在本机。
  // 若有人把上传命令/接线带回来，这条会先失败（而不是靠人工 review）。
  it('rejects the removed upload command on the local-only IPC surface', async () => {
    const f = fixture();
    let source = false;
    const handler = createTraceCommandHandler({
      controller: f.controller,
      authorize: () => {},
      isSource: () => source,
      isSourceDestroyed: () => false,
      isMainWindow: () => true,
      selectSource: () => {
        source = true;
      },
      showFolder: vi.fn(async () => {}),
    });
    const event = {} as IpcMainInvokeEvent;
    await expect(handler(event, 'upload')).rejects.toThrow('INVALID_PARAMS');
    expect(f.deps.begin).not.toHaveBeenCalled();
    expect(f.deps.reveal).not.toHaveBeenCalled();
  });
  it('projects only fixed event labels and bounded numeric timings', () => {
    const input = {
      at: 1200,
      kind: 'input',
      label: 'keydown',
      durationMs: 80,
      inputDelayMs: 50,
      processingMs: 10,
      key: 'secret',
      target: '/Users/private',
    };
    expect(projectTraceEvent(input, 1000, 2000)).toEqual({
      at: 1200,
      kind: 'input',
      label: 'keydown',
      durationMs: 80,
      inputDelayMs: 50,
      processingMs: 10,
    });
    for (const extra of [
      { label: 'secret' },
      { at: 0 },
      { durationMs: NaN },
      { kind: '__proto__' },
    ])
      expect(projectTraceEvent({ ...input, ...extra }, 1000, 2000)).toBeNull();
  });
  it('keeps bundled CPU stack locations and sample timing while removing external paths and arbitrary fields', () => {
    const profile = projectCpuProfile(
      {
        startTime: 100,
        endTime: 300,
        samples: [1, 2],
        timeDeltas: [100, 100],
        nodes: [
          {
            id: 1,
            callFrame: {
              functionName: 'parseMarkdown',
              url: 'http://localhost:5173/src/app.ts?secret=abc',
              lineNumber: 10,
              columnNumber: 5,
            },
            children: [2],
          },
          {
            id: 2,
            callFrame: {
              functionName: 'secretFunction',
              url: 'https://private.example/secret.js',
              lineNumber: 42,
              columnNumber: 7,
            },
          },
        ],
      },
      process.cwd(),
      'http://localhost:5173',
    );
    expect(profile.nodes[0].callFrame).toEqual({
      functionName: 'parseMarkdown',
      url: 'app.ts',
      lineNumber: 10,
      columnNumber: 5,
    });
    expect(profile.nodes[1].callFrame).toEqual({
      functionName: '(external or anonymous)',
      url: '',
      lineNumber: -1,
      columnNumber: -1,
    });
    expect(profile.samples).toEqual([1, 2]);
    expect(profile.timeDeltas).toEqual([100, 100]);
    expect(JSON.stringify(profile)).not.toMatch(/secret|private|localhost/);
  });
  it('measures selected IPC calls without changing return values, rejections or exposing arguments', async () => {
    const events: unknown[] = [];
    setTraceOperationObserver((e) => events.push(e));
    expect(measureTraceOperation('local-db:sessions:list', () => 42)).toBe(42);
    const error = new Error('original');
    await expect(
      measureTraceOperation('maker:list-agent-skills', () => Promise.reject(error)),
    ).rejects.toBe(error);
    // Skill subphases distinguish preparation from scan time without recording
    // workdirs, skill contents or results in the diagnostic report.
    await expect(measureTraceOperation('maker:list-agent-skills:identity',
      () => Promise.resolve('private-skill-result'))).resolves.toBe('private-skill-result');
    measureTraceOperation('private-channel-name', () => 0);
    expect(events).toHaveLength(3);
    expect(projectTraceEvent(events[2], 0, Date.now())).toMatchObject({
      label: 'maker:list-agent-skills:identity', kind: 'ipc',
    });
    expect(JSON.stringify(events)).not.toMatch(/original|private-channel|private-skill-result/);
  });
});
