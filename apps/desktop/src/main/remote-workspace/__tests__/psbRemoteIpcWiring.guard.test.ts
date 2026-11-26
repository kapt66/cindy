/**
 * psbRemoteIpcWiring.guard.test.ts — 远程工作区 IPC 面的跨文件接线契约。
 *
 * ## 为什么是 guard 而不是 unit
 *
 * 这里验证的是「共享通道常量 ↔ main handler ↔ preload 桥 ↔ 渲染层窄入口」四处是否仍一一对应。
 * 不启动 Electron 就没有任何运行期入口能同时观察 main 与 preload 两侧，所以只能做源级断言；
 * 缺一处都是用户可见的硬故障，且没有恢复路径：
 *
 *   - handler 未注册 → renderer 的 invoke 收到 `No handler registered for 'psb-remote:…'`；
 *   - preload 缺方法 → `getPsbRemoteBridge()` 返回的对象缺键，调用点直接 TypeError；
 *   - 只改一半通道名 → 调用永远等不到结果，表现为「点了没反应」。
 *
 * 规则依据：`docs/dev-rules/psb-remote-session-transport.md` §4（通道唯一来源是
 * `PSB_REMOTE_CHANNELS`、main/preload/类型三处同步、来源校验与失败形状约定）。
 * 「编译期能保证」的部分（preload 实现 `PsbRemoteBridge` 的签名）由 typecheck 承担，
 * 本文件只补 typecheck 看不见的通道名与方法名对应关系。
 *
 * 测试价值
 * - 生产入口与可观察结果：`registerPsbRemoteIpc` / `createPsbRemoteBridge` / `PsbRemoteBridge`
 *   三处接线；用户看到的是 invoke 能返回、推送能到达，缺一处即硬故障。
 * - Bug／规则依据：见上（传输契约 §4）；`apps/desktop/src/main/remote-workspace/` 的
 *   并行开发中最容易出现的正是「通道加了、某一侧没接」。
 * - 现有覆盖缺口：typecheck 只能保证 preload↔bridge 签名一致，看不到「方法名 ↔ 通道名」
 *   与「main 返回值包装形状」；运行期验证要启动 Electron。
 * - 最小失败输入：把 `listWorkspaces` 从 preload 桥里删掉，或让 main 返回裸数组——两种改动
 *   在运行期的表现分别是 invoke 不存在与列表永远空，均由本文件断言拦下。
 * - tier：guard（纯源级跨文件契约；已在 `scripts/test-workspaces.config.mjs` 的
 *   `desktopGuardInclude` 登记，普通 unit tier 排除本文件）。
 * - 实测耗时：单独运行 2.29s（其中 8 条用例 16ms；其余为 vitest 启动与文件读取）。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { PSB_REMOTE_CHANNELS } from '../../../shared/psb-remote-workspace';
import { PSB_ADMIN_CHANNELS } from '../../../shared/psb-workspace-admin';

const DESKTOP_ROOT = process.cwd().toLowerCase().endsWith(`${path.sep}apps${path.sep}desktop`)
  ? process.cwd()
  : path.join(process.cwd(), 'apps', 'desktop');

function readSource(relativePath: string): string {
  return readFileSync(path.join(DESKTOP_ROOT, relativePath), 'utf-8').replace(/\r\n/g, '\n');
}

/** 取一个顶层 `function name(` 或 `interface Name {` 之后的声明块（到行首 `}` 为止）。 */
function readTopLevelBlock(source: string, marker: string): string | null {
  const start = source.indexOf(marker);
  if (start < 0) return null;
  const end = source.indexOf('\n}\n', start);
  if (end < 0) return null;
  return source.slice(start, end + 3);
}

/**
 * 「bridge 方法 → IPC 通道」的唯一映射表。
 *
 * 新增通道必须同时改这张表、`PSB_REMOTE_CHANNELS`、main handler 与 preload——本用例的
 * 第一断言会检查两边键集合完全一致，只在共享契约里加通道会被立刻拦下。
 */
const BRIDGE_METHODS: ReadonlyArray<{
  readonly method: string;
  readonly channel: keyof typeof PSB_REMOTE_CHANNELS;
  readonly invoke: boolean;
}> = [
  { method: 'status', channel: 'STATUS', invoke: true },
  { method: 'listWorkspaces', channel: 'LIST_WORKSPACES', invoke: true },
  { method: 'listClients', channel: 'LIST_CLIENTS', invoke: true },
  { method: 'listProjectTemplates', channel: 'LIST_TEMPLATES', invoke: true },
  { method: 'createWorkspace', channel: 'CREATE_WORKSPACE', invoke: true },
  { method: 'occupyWorkspace', channel: 'OCCUPY_WORKSPACE', invoke: true },
  { method: 'releaseWorkspace', channel: 'RELEASE_WORKSPACE', invoke: true },
  { method: 'createSession', channel: 'CREATE_SESSION', invoke: true },
  { method: 'refreshWorkspaces', channel: 'REFRESH_WORKSPACES', invoke: true },
  { method: 'sessionStatus', channel: 'SESSION_STATUS', invoke: true },
  { method: 'stopSession', channel: 'STOP_SESSION', invoke: true },
  { method: 'openWebWorkspace', channel: 'OPEN_WEB_WORKSPACE', invoke: true },
  { method: 'onWorkspaceChanged', channel: 'WORKSPACE_CHANGED', invoke: false },
  { method: 'onSessionsRebound', channel: 'SESSIONS_REBOUND', invoke: false },
  // CINDY-RW-10：版本控制检查通知的兜底读取 / 处置动作 invoke，以及通知推送。
  { method: 'workspaceVcsNotice', channel: 'WORKSPACE_VCS_NOTICE_GET', invoke: true },
  { method: 'runWorkspaceVcsAction', channel: 'WORKSPACE_VCS_ACTION', invoke: true },
  { method: 'onWorkspaceVcsNotice', channel: 'WORKSPACE_VCS_NOTICE', invoke: false },
  // 会话结束释放工作区占用（r6/r7）：报告一次终态 + main 待释放账本的读/重试/推送。
  { method: 'releaseWorkspaceForSession', channel: 'RELEASE_SESSION_WORKSPACE', invoke: true },
  { method: 'pendingWorkspaceReleases', channel: 'PENDING_RELEASES_GET', invoke: true },
  { method: 'retryPendingWorkspaceReleases', channel: 'PENDING_RELEASES_RETRY', invoke: true },
  { method: 'onPendingWorkspaceReleasesChanged', channel: 'PENDING_RELEASES_CHANGED', invoke: false },
];

/**
 * 「远程工作区」管理页（**工作区级**）的桥方法 → 通道映射表。
 *
 * 与上面那张表分开维护：管理页有自己的通道常量（`PSB_ADMIN_CHANNELS`）与语义（页面围绕
 * 工作区而不是任务），合表会让两层的接线契约混在一起，新增一侧时必须改另一侧的断言。
 */
const ADMIN_BRIDGE_METHODS: ReadonlyArray<{
  readonly method: string;
  readonly channel: keyof typeof PSB_ADMIN_CHANNELS;
  readonly invoke: boolean;
}> = [
  { method: 'adminContext', channel: 'CONTEXT', invoke: true },
  { method: 'adminStreamStart', channel: 'STREAM_START', invoke: true },
  { method: 'adminStreamStop', channel: 'STREAM_STOP', invoke: true },
  { method: 'adminStreamStatus', channel: 'STREAM_STATUS', invoke: true },
  // 交互串流：工作区级键鼠输入 + 全屏捕获态（宿主快捷键让路）各一条 invoke。
  { method: 'adminStreamInput', channel: 'STREAM_INPUT', invoke: true },
  { method: 'setAdminStreamCaptureActive', channel: 'STREAM_CAPTURE', invoke: true },
  { method: 'onAdminContextChanged', channel: 'CONTEXT_CHANGED', invoke: false },
  { method: 'onAdminStreamEvent', channel: 'STREAM_EVENT', invoke: false },
];

describe('PSB 远程工作区 IPC 接线', () => {
  const ipcSource = readSource('src/main/remote-workspace/ipc.ts');
  const preloadSource = readSource('src/preload/preload.ts');
  const bridgeSource = readSource('src/renderer/features/remote-workspace/bridge.ts');
  const preloadBridge = readTopLevelBlock(preloadSource, 'function createPsbRemoteBridge(');
  const bridgeInterface = readTopLevelBlock(bridgeSource, 'export interface PsbRemoteBridge {');

  it('共享通道表与方法映射表一一对应，且通道值不重复', () => {
    expect(Object.keys(PSB_REMOTE_CHANNELS).sort()).toEqual(
      BRIDGE_METHODS.map((entry) => entry.channel).sort(),
    );
    const values = Object.values(PSB_REMOTE_CHANNELS);
    expect(new Set(values).size).toBe(values.length);
  });

  it('每个桥方法在渲染层接口、preload 实现与 main handler 里都有对应接线', () => {
    expect(preloadBridge, 'preload 缺少 createPsbRemoteBridge()').not.toBeNull();
    expect(bridgeInterface, 'bridge.ts 缺少 PsbRemoteBridge 接口').not.toBeNull();
    for (const { method, channel, invoke } of BRIDGE_METHODS) {
      expect(bridgeInterface, `PsbRemoteBridge 缺少 ${method}(`).toMatch(
        new RegExp(`\\b${method}\\s*\\(`),
      );
      expect(preloadBridge, `preload 桥缺少 ${method}`).toMatch(new RegExp(`\\b${method}\\s*:`));
      // 推送方法用共享常量建 fanOut（在函数外声明），invoke 方法在函数内直接引用通道。
      expect(preloadSource, `preload 未使用通道常量 ${channel}`).toContain(
        `PSB_REMOTE_CHANNELS.${channel}`,
      );
      if (invoke) {
        expect(ipcSource, `main 未注册通道 ${channel}`).toContain(
          `PSB_REMOTE_CHANNELS.${channel}`,
        );
      }
    }
  });

  it('聚合类返回值锁定共享 DTO 形状（`{workspaces}` 等包装，不是裸数组）', () => {
    // 并行开发的真实事故面：main 返回数组、渲染层按 `{ workspaces }` 解构，列表永远空。
    // 每个聚合 handler 的返回值都用共享 DTO `satisfies` 锁形；这里守它不被顺手删掉。
    for (const marker of [
      'satisfies PsbListWorkspacesResult',
      'satisfies PsbListClientsResult',
      'satisfies PsbListTemplatesResult',
      'satisfies PsbCreateWorkspaceResult',
      'satisfies PsbOccupyWorkspaceResult',
      // 管理页（工作区级）的三个返回值同样锁形：`{context}` / `{status,…}` / `{status:null}`
      // 都是渲染层直接解构的形状，裸返回会让页面永远停在「读取中」。
      'satisfies PsbWorkspaceAdminContextResult',
      'satisfies PsbWorkspaceAdminStreamStartResult',
      'satisfies PsbWorkspaceAdminStreamStatusResult',
      // 会话结束释放：报告结果与待释放账本快照也都是渲染层直接解构的形状。
      'satisfies PsbSessionWorkspaceReleaseResult',
      'satisfies PsbPendingWorkspaceReleasesResult',
      'satisfies PsbPendingWorkspaceReleasesRetryResult',
    ]) {
      expect(ipcSource, `ipc.ts 缺少返回值形状锁定：${marker}`).toContain(marker);
    }
  });

  it('管理页通道表与桥方法映射表一一对应，且通道值不与会话级通道冲突', () => {
    expect(Object.keys(PSB_ADMIN_CHANNELS).sort()).toEqual(
      ADMIN_BRIDGE_METHODS.map((entry) => entry.channel).sort(),
    );
    const adminValues = Object.values(PSB_ADMIN_CHANNELS);
    expect(new Set(adminValues).size).toBe(adminValues.length);
    // 两组常量必须无交集：同名通道会让「管理页推送」被会话级监听器收走（或反过来）。
    const remoteValues = new Set<string>(Object.values(PSB_REMOTE_CHANNELS));
    for (const value of adminValues) {
      expect(remoteValues.has(value), `管理页通道与会话级通道重名：${value}`).toBe(false);
    }
  });

  it('管理页每个桥方法在渲染层接口、preload 实现与 main handler 里都有对应接线', () => {
    for (const { method, channel, invoke } of ADMIN_BRIDGE_METHODS) {
      expect(bridgeInterface, `PsbRemoteBridge 缺少 ${method}(`).toMatch(
        new RegExp(`\\b${method}\\s*\\(`),
      );
      expect(preloadBridge, `preload 桥缺少 ${method}`).toMatch(new RegExp(`\\b${method}\\s*:`));
      expect(preloadSource, `preload 未使用通道常量 ${channel}`).toContain(
        `PSB_ADMIN_CHANNELS.${channel}`,
      );
      if (invoke) {
        expect(ipcSource, `main 未注册管理页通道 ${channel}`).toContain(
          `PSB_ADMIN_CHANNELS.${channel}`,
        );
      }
    }
  });

  it('main handler 统一校验来源、统一映射失败码，且通道名不硬编码', () => {
    // 来源校验必须是 handleInvoke 的唯一入口（每个通道都走它），漏一个 handler 就等于少一道闸。
    expect(ipcSource.match(/assertTrustedAppRendererEvent\(event\)/g)).toHaveLength(1);
    // 失败形状跨 IPC 的唯一映射入口：换掉它渲染层就拿不到 PSB 命名空间错误码（文案键靠它）。
    expect(ipcSource).toContain('psbIpcCodeForFailure(failure)');
    // 通道名只允许来自共享常量（`'psb-remote:` 字面量会与常量漂移，失败是静默的）。
    expect(ipcSource).not.toContain("'psb-remote:");
    expect(preloadSource).not.toContain("'psb-remote:");
  });

  it('交互串流的两个安全闸门没有被绕过：输入事件共享校验、捕获态保留键共享清单', () => {
    // 键鼠输入直接进 PSB 共享中继（网页观看端同一条），渲染层的任意事件必须在 IPC 边界被
    // 共享校验器拒绝；删掉这一处不会有编译错误，只有「垃圾帧进了别人的观看端」。
    expect(ipcSource, 'ipc.ts 未使用共享输入事件校验器').toContain('validatePsbStreamInputEvent');
    // 捕获态的自救允许清单（Esc / F5 / F11 / F12 / 开发者工具）与渲染层同一份判定：main 侧
    // 自己列一遍会让「能不能退全屏 / 能不能自救」取决于哪一侧先改。
    const captureSource = readSource('src/main/remote-workspace/streamCapture.ts');
    expect(captureSource, 'streamCapture 未引用共享自救允许清单').toContain(
      'psbStreamCaptureIsPassthroughInput',
    );
    expect(captureSource, 'streamCapture 未用共享组合匹配器').toContain('matchesElectronInput');
  });

  it('发送前闸门失败保留 PSB 命名空间码（不落通用 INTERNAL）', () => {
    // 2026-11-26 真机：远程工作区按钮弹「操作失败，请稍后重试。」。原因之一是发送闸门把
    // `PsbClientError` 直接抛进 `ipcMain.handle` —— 跨进程只保留 message，渲染层拿不到
    // `PSB_*` 码（CINDY-RW-10 的三个 VCS 码也会一起被吞）。这里钉住 register 的收敛点：
    // 已带码的 IpcError 原样抛，其余走 `psbIpcCodeForFailure`（映射不到才落 INTERNAL）。
    const registerSource = readSource('src/main/maker-ipc/register.ts');
    const gateStart = registerSource.indexOf('preparePsbWorkspaceLock: async (sessionId) =>');
    expect(gateStart).toBeGreaterThanOrEqual(0);
    const gateBlock = registerSource.slice(
      gateStart,
      registerSource.indexOf('\n    },\n', gateStart),
    );
    expect(gateBlock).toContain('if (isIpcError(error)) throw error;');
    expect(gateBlock).toContain('psbIpcCodeForFailure(failure) ?? \'INTERNAL\'');
  });

  it('管理页串流多窗口：引用计数账本与帧定向投递接线在位', () => {
    // 多窗口看同一工作区时，只有最后离开的窗口才能停流；帧/光标只发给登记过的窗口。
    expect(ipcSource, 'ipc.ts 未使用引用计数账本').toContain('createPsbStreamOwnerRegistry()');
    expect(ipcSource, 'ipc.ts 未按「最后离开者」停流').toContain('untrackAdminStreamOwner');
    expect(ipcSource, 'ipc.ts 未登记帧 owner').toContain('registerPsbAdminStreamOwner');
    const pushSource = readSource('src/main/remote-workspace/push.ts');
    expect(pushSource, 'push.ts 帧未按 owner 定向').toContain(
      'adminStreamFrameOwners.owners(event.sessionId)',
    );
    // 状态 / 关闭 / 错误与上下文变化仍是广播（多窗口都要收敛状态）。
    expect(pushSource).toContain('broadcastToTrustedWindows(PSB_ADMIN_CHANNELS.STREAM_EVENT');
  });

  it('写操作前的占用闸门接线齐备（新会话 / 启动串流 / 每次发送 / 重绑）', () => {
    // PSB 服务端对工作区写操作校验占用（2026-11-26 口径）：Cindy 这三个入口都必须先 ensure，
    // 漏一处的后果是「用户在 PSB 侧被拒后只看到一句不可行动的失败」，且没有编译错误。
    const indexSource = readSource('src/main/remote-workspace/index.ts');
    const adminSource = readSource('src/main/remote-workspace/adminService.ts');
    const registerSource = readSource('src/main/maker-ipc/register.ts');
    const transactionSource = readSource('src/main/maker-ipc/makerSendTransaction.ts');

    // 1) 新会话：createSession 必须先 ensure，再打 PSB 的建会话请求（顺序也不能反）。
    const createStart = indexSource.indexOf('async createSession(input) {');
    const createEnsure = indexSource.indexOf('await ensureWorkspaceLocked(input.workspaceId)');
    const createRequest = indexSource.indexOf('await api.createSession(input)');
    expect(createStart, 'index.ts 缺少 createSession').toBeGreaterThanOrEqual(0);
    expect(createEnsure, 'createSession 未在创会话前 ensure 工作区锁定').toBeGreaterThan(
      createStart,
    );
    expect(createRequest, 'createSession 未真正调用 PSB').toBeGreaterThan(createEnsure);

    // 2) 启动串流：先 ensure，再建立观看端绑定（工作区级订阅 / 旧 PSB 过渡回退）并订阅。
    //    2026-11-26 FIX-B：start / stop 改为按工作区串行 + 代次，实际动作在 `startStreamLocked`
    //    里执行（`streamStart` 只做校验、取代次并入队），锚点跟着实现走，但顺序契约不变。
    const streamStartAt = adminSource.indexOf('async function streamStart(');
    const lockedStartAt = adminSource.indexOf('async function startStreamLocked(');
    const streamEnsure = adminSource.indexOf('await remote().ensureWorkspaceLocked(workspaceId)');
    const streamBind = adminSource.indexOf('await startStreamWithRecovery(workspaceId)');
    expect(streamStartAt, 'adminService 缺少 streamStart').toBeGreaterThanOrEqual(0);
    expect(lockedStartAt, 'adminService 缺少 startStreamLocked').toBeGreaterThanOrEqual(0);
    // wrapper 必须经串行队列把动作交给 locked 函数（不能自己直接执行、绕过互斥）。
    const stopLockedAt = adminSource.indexOf('async function stopStreamLocked(');
    const streamStartBlock = adminSource.slice(streamStartAt, stopLockedAt);
    expect(streamStartBlock).toContain('runWorkspaceOperation(');
    expect(streamStartBlock).toContain('startStreamLocked(');
    expect(streamEnsure, 'adminService 启动串流前未 ensure 工作区锁定').toBeGreaterThan(
      lockedStartAt,
    );
    expect(streamBind).toBeGreaterThan(streamEnsure);

    // 2b) 会话级串流通道（STREAM_STATUS/START/STOP/INPUT/EVENT）已删除：渲染层零消费，
    //     main 侧也不能留 handler/推送（否则就是一条没有来源的旁路）。
    expect(ipcSource).not.toContain('PSB_REMOTE_CHANNELS.STREAM');
    const pushSource = readSource('src/main/remote-workspace/push.ts');
    expect(pushSource).not.toContain('PSB_REMOTE_CHANNELS.STREAM_EVENT');

    // 3) 每次发送：事务在远端就绪准备/派发之前调用闸门（不能是可选的成功路径）。
    const lockCall = transactionSource.indexOf(
      'if (deps.preparePsbWorkspaceLock) await deps.preparePsbWorkspaceLock(sessionId)',
    );
    const remoteReady = transactionSource.indexOf(
      'await deps.ensureRemoteReadyForSessionStart({ session: sess, createOpts })',
    );
    expect(lockCall, '发送事务缺少 psb 占用闸门调用').toBeGreaterThanOrEqual(0);
    expect(lockCall).toBeLessThan(remoteReady);

    // 4) 接线：register 里的发送前闸门与发送前重建都走同一个 PSB 服务（重建的建会话因此同样
    //    被 createSession 的闸门覆盖，不另开一条绕过路径）。
    expect(registerSource, 'register 未接线发送前占用闸门').toContain(
      'preparePsbWorkspaceLock: async (sessionId) =>',
    );
    expect(registerSource).toContain('ensureWorkspaceLockedForSession(psbSessionId)');
    expect(registerSource, '重绑建会话未走带闸门的 PSB 服务').toContain(
      'getPsbRemoteService().createSession(input)',
    );
  });

  it('会话结束释放的唯一判据在 main 释放模块，IPC 层只做校验与结果映射', () => {
    // 判据（读 PSB 会话行、确认「由我占用」、记待释放账本）必须留在
    // `maker-host/psb-workspace-session-release.ts` 一处；IPC 层自己再判一遍会让两处漂移
    // （渲染层只看得到本地会话 id，根本判不了占用者）。
    expect(ipcSource, 'ipc.ts 未调用 main 的释放端口').toContain(
      'releasePsbWorkspaceForSession(',
    );
    expect(ipcSource, 'ipc.ts 未读取待释放账本').toContain('listPendingWorkspaceReleases()');
    expect(ipcSource, 'ipc.ts 未重试待释放账本').toContain('retryPendingWorkspaceReleases()');
    expect(ipcSource, 'ipc.ts 未把账本变更推给渲染层').toContain(
      'broadcastPsbPendingReleasesChanged(',
    );
    // 失败形状（main 记账 → IPC 返回 ok:false 而非抛 IPC 错）不在源级 pin：它由 main 的
    // `maker-host/__tests__/psbWorkspaceSessionRelease.test.ts`（失败入账 / 重试 / 出账）与渲染层
    // `features/cc-agent/__tests__/psbOccupancyRelease.test.ts`（ok:false = 已送达、not-wired 留账）
    // 按行为覆盖；通道 ↔ 端口 ↔ DTO 这几层接线已由上方的映射表用例断言。
  });

  it('会话结束释放的触发权威只在 main，渲染层只做旧 main 兼容探测；teardown 清账本', () => {
    // 二轮审查 s5/s8 P1：main 终态 observer 与渲染层对同一次归档各发一次 release =
    // 一次归档两轮 PSB 请求 + 双记账。触发权威必须在 main（终态 observer 注册槽），
    // 渲染层生命周期入口不得直接调 bridge。
    const registerSource = readSource('src/main/maker-ipc/register.ts');
    expect(registerSource, 'register 未注册终态释放 observer').toContain(
      'setTerminalSessionStatusObserver((sessionId, status) => {',
    );
    expect(registerSource, 'observer 未调用 main 的释放端口').toContain(
      'await releasePsbWorkspaceForSession({',
    );
    // 同一工作区还有活动任务时不能提前解锁：端口必须拿到会话表查询与「会话→工作区」映射。
    expect(registerSource, '释放端口未注入活动任务查询').toContain('listActivePsbSessions: async () =>');
    expect(registerSource, '释放端口未注入会话→工作区映射').toContain(
      'workspaceIdForPsbSession: (psbSessionId) =>',
    );

    const lifecycleSource = readSource(
      'src/renderer/features/cc-agent/hooks/useSessionLifecycleActions.ts',
    );
    expect(lifecycleSource, '渲染层生命周期入口不得直接调 releaseWorkspaceForSession').not.toContain(
      'releaseWorkspaceForSession(',
    );
    expect(lifecycleSource, '渲染层必须走带 main-authority 探测的兼容入口').toContain(
      'releasePsbOccupancyForEndedSession(',
    );
    const releaseSource = readSource('src/renderer/features/cc-agent/psbOccupancyRelease.ts');
    expect(releaseSource, '兼容层缺少 main-authority 探测').toContain(
      'psbMainOwnsSessionEndRelease(',
    );

    // 切号 / teardown：PSB 服务 dispose 必须同时清空待释放账本（旧账号的锁只能用旧身份归还）。
    const indexSource = readSource('src/main/remote-workspace/index.ts');
    const disposeAt = indexSource.indexOf('export function disposePsbRemoteService(): void {');
    expect(disposeAt, 'index.ts 缺少 disposePsbRemoteService').toBeGreaterThanOrEqual(0);
    const disposeBlock = indexSource.slice(disposeAt, indexSource.indexOf('\n}', disposeAt));
    expect(disposeBlock, 'disposePsbRemoteService 未清空待释放账本').toContain(
      'clearPendingWorkspaceReleases()',
    );
  });
});
