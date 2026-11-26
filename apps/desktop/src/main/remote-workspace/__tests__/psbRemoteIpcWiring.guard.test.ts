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
  { method: 'streamStatus', channel: 'STREAM_STATUS', invoke: true },
  { method: 'streamStart', channel: 'STREAM_START', invoke: true },
  { method: 'streamStop', channel: 'STREAM_STOP', invoke: true },
  { method: 'streamInput', channel: 'STREAM_INPUT', invoke: true },
  { method: 'onStreamEvent', channel: 'STREAM_EVENT', invoke: false },
  { method: 'onWorkspaceChanged', channel: 'WORKSPACE_CHANGED', invoke: false },
  // 发送时透明重建 PSB 会话后 main → renderer 的「这个任务换了一条会话」推送。
  { method: 'onSessionsRebound', channel: 'SESSIONS_REBOUND', invoke: false },
  // CINDY-RW-10：版本控制检查通知的兜底读取 / 处置动作 invoke，以及通知推送。
  { method: 'workspaceVcsNotice', channel: 'WORKSPACE_VCS_NOTICE_GET', invoke: true },
  { method: 'runWorkspaceVcsAction', channel: 'WORKSPACE_VCS_ACTION', invoke: true },
  { method: 'onWorkspaceVcsNotice', channel: 'WORKSPACE_VCS_NOTICE', invoke: false },
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
      'satisfies PsbStreamStartResult',
      // 管理页（工作区级）的三个返回值同样锁形：`{context}` / `{status,…}` / `{status:null}`
      // 都是渲染层直接解构的形状，裸返回会让页面永远停在「读取中」。
      'satisfies PsbWorkspaceAdminContextResult',
      'satisfies PsbWorkspaceAdminStreamStartResult',
      'satisfies PsbWorkspaceAdminStreamStatusResult',
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
    const streamStartAt = adminSource.indexOf('async function streamStart(');
    const streamEnsure = adminSource.indexOf('await remote().ensureWorkspaceLocked(id)');
    const streamBind = adminSource.indexOf('await startStreamWithRecovery(id)');
    expect(streamEnsure, 'adminService 启动串流前未 ensure 工作区锁定').toBeGreaterThan(
      streamStartAt,
    );
    expect(streamBind).toBeGreaterThan(streamEnsure);

    // 2b) 会话级启动串流（当前无渲染层消费方）也必须走同一闸门，不能成为绕过占用检查的
    //     第二条路径：handler 先 ensure 该会话所属工作区，再 true 启动。
    const sessionStreamStartAt = ipcSource.indexOf('PSB_REMOTE_CHANNELS.STREAM_START');
    const sessionGate = ipcSource.indexOf(
      'await service().ensureWorkspaceLockedForSession(sessionId)',
      sessionStreamStartAt,
    );
    const sessionStart = ipcSource.indexOf('service().startStream(sessionId)', sessionStreamStartAt);
    expect(sessionGate, '会话级启动串流缺少占用闸门').toBeGreaterThan(sessionStreamStartAt);
    expect(sessionStart, '会话级启动串流未真正调用 PSB').toBeGreaterThan(sessionGate);

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
});
