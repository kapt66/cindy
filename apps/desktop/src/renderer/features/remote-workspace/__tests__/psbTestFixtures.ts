/**
 * PSB 远程工作区渲染层测试的共享夹具（弹窗 / 草稿页下拉 / 侧栏共用）。
 *
 * 2026-11-26 独立审查：`RemoteWorkspacePickerDialog.test.tsx` 与 `PsbWorkspacePicker.test.tsx`
 * 各自复制了一份 `makeWorkspace` / `FakeBridge`，两份在字段集合上已经漂移（旧桥里还留着
 * 会话级串流的死方法）。夹具统一放这里，测试只断言行为。
 *
 * 这里**只放数据与假实现**，不放 `vi.mock` 工厂：mock 由各测试文件按自己的翻译桩声明。
 */

import { vi } from 'vitest';

import type {
  PsbCreateWorkspaceResult,
  PsbListClientsResult,
  PsbListTemplatesResult,
  PsbListWorkspacesResult,
  PsbOccupyWorkspaceResult,
  PsbProjectTemplate,
  PsbRemoteClient,
  PsbRemoteWorkspace,
  PsbSessionStatusResult,
} from '../../../../shared/psb-remote-workspace';
import type { WorkspaceVcsNotice } from '../../../../shared/psb-workspace-vcs';

/** 一次可手动落地的异步结果（测「在途」行为用）。 */
export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 一个可用的 PSB 工作区行（默认 ready / 在线 / 未占用）。 */
export function makePsbWorkspace(
  overrides: Partial<PsbRemoteWorkspace> = {},
): PsbRemoteWorkspace {
  return {
    id: 'workspace-1',
    title: 'SAGA2 设计',
    clientId: 'client-1',
    clientName: '设计机-01',
    clientOnline: true,
    clientPlatform: 'windows',
    state: 'ready',
    templateKey: 'saga2_design',
    templateTitle: 'SAGA2 设计',
    directoryName: 'saga2_design',
    clientPath: 'C:/work/saga2_design',
    occupancy: {
      occupied: false,
      byMe: false,
      personId: null,
      personName: '',
      occupiedAt: null,
    },
    usable: true,
    unusableReason: null,
    sessionCount: 0,
    webUrl: null,
    sessionsWebUrl: null,
    ...overrides,
  };
}

/** 被「张三」占用（不可用）的工作区行。 */
export function makeOccupiedByOtherWorkspace(
  overrides: Partial<PsbRemoteWorkspace> = {},
): PsbRemoteWorkspace {
  return makePsbWorkspace({
    id: 'workspace-other',
    title: '别人的工作区',
    occupancy: {
      occupied: true,
      byMe: false,
      personId: 'other',
      personName: '张三',
      occupiedAt: 2,
    },
    usable: false,
    unusableReason: 'occupied-by-other',
    ...overrides,
  });
}

/** 已被「我」占用、可以直接使用（不弹占用确认）的工作区行。 */
export function makeOccupiedByMeWorkspace(
  overrides: Partial<PsbRemoteWorkspace> = {},
): PsbRemoteWorkspace {
  return makePsbWorkspace({
    occupancy: {
      occupied: true,
      byMe: true,
      personId: 'me',
      personName: '我',
      occupiedAt: 1,
    },
    usable: true,
    unusableReason: null,
    ...overrides,
  });
}

export function makePsbClient(overrides: Partial<PsbRemoteClient> = {}): PsbRemoteClient {
  return {
    id: 'client-1',
    name: '设计机-01',
    online: true,
    platform: 'windows',
    capabilities: { workspace: true, agent: true, streaming: true, exec: true, windows: true },
    agents: [{ kind: 'claude-code', available: true, version: '0.0.12' }],
    ...overrides,
  };
}

export function makePsbTemplate(
  overrides: Partial<PsbProjectTemplate> = {},
): PsbProjectTemplate {
  return { key: 'saga2_design', title: 'SAGA2 设计', description: null, checkoutCount: 2, ...overrides };
}

/** 旧版 PSB（<0.1.180）409 携带的版本控制检查通知：`advisory:false` = 操作被拒。 */
export function makeLegacyVcsNotice(workspaceId = 'workspace-1'): WorkspaceVcsNotice {
  return {
    code: 'WORKSPACE_VCS_DIRTY',
    advisory: false,
    messageZh: '工作区有未提交修改：1 个检出',
    dirty: true,
    projects: [{ projectId: 1, pathInWorkspace: '.', kind: 'p4', changes: 3 }],
    actions: [
      {
        kind: 'inspect-vcs',
        method: 'GET',
        path: `/api/cindy/remote/workspaces/${workspaceId}/vcs`,
        descriptionZh: '查看详情',
      },
      {
        kind: 'retry',
        method: 'POST',
        path: `/api/cindy/remote/workspaces/${workspaceId}/vcs/check`,
        descriptionZh: '重试检查',
      },
    ],
  };
}

/** 测试用的 PSB 桥：只包含渲染层真实消费的方法（会话级串流五通道已死，不在这里出现）。 */
export interface FakePsbBridge {
  status: ReturnType<typeof vi.fn>;
  listWorkspaces: ReturnType<typeof vi.fn>;
  listClients: ReturnType<typeof vi.fn>;
  listProjectTemplates: ReturnType<typeof vi.fn>;
  createWorkspace: ReturnType<typeof vi.fn>;
  occupyWorkspace: ReturnType<typeof vi.fn>;
  releaseWorkspace: ReturnType<typeof vi.fn>;
  createSession: ReturnType<typeof vi.fn>;
  refreshWorkspaces: ReturnType<typeof vi.fn>;
  sessionStatus: ReturnType<typeof vi.fn>;
  stopSession: ReturnType<typeof vi.fn>;
  openWebWorkspace: ReturnType<typeof vi.fn>;
  onWorkspaceChanged: ReturnType<typeof vi.fn>;
  workspaceVcsNotice: ReturnType<typeof vi.fn>;
  onWorkspaceVcsNotice: ReturnType<typeof vi.fn>;
  runWorkspaceVcsAction: ReturnType<typeof vi.fn>;
}

/** 安装一个假 PSB 桥到 `window.electronAPI.psbRemote`，返回可继续断言/覆盖的句柄。 */
export function installPsbBridge(overrides: Partial<FakePsbBridge> = {}): FakePsbBridge {
  const bridge: FakePsbBridge = {
    status: vi.fn(async () => ({
      ready: true,
      reasonKey: null,
      host: 'mekabot-test',
      testHost: true,
    })),
    listWorkspaces: vi.fn(async (): Promise<PsbListWorkspacesResult> => ({ workspaces: [] })),
    listClients: vi.fn(async (): Promise<PsbListClientsResult> => ({ clients: [makePsbClient()] })),
    listProjectTemplates: vi.fn(
      async (): Promise<PsbListTemplatesResult> => ({ templates: [makePsbTemplate()] }),
    ),
    createWorkspace: vi.fn(),
    occupyWorkspace: vi.fn(),
    releaseWorkspace: vi.fn(
      async (): Promise<PsbOccupyWorkspaceResult> => ({ workspace: makePsbWorkspace() }),
    ),
    // 选择器**不应**调用：PSB 会话在草稿页首条消息发送时才懒建。留 spy 用于断言零调用。
    createSession: vi.fn(),
    refreshWorkspaces: vi.fn(async (): Promise<PsbListWorkspacesResult> => ({ workspaces: [] })),
    sessionStatus: vi.fn(async () => ({}) as PsbSessionStatusResult),
    stopSession: vi.fn(async () => undefined),
    openWebWorkspace: vi.fn(async () => undefined),
    onWorkspaceChanged: vi.fn(() => () => undefined),
    workspaceVcsNotice: vi.fn(async () => ({ workspaceId: 'workspace-1', notice: null })),
    onWorkspaceVcsNotice: vi.fn(() => () => undefined),
    runWorkspaceVcsAction: vi.fn(),
    ...overrides,
  };
  (window as unknown as { electronAPI?: { psbRemote?: FakePsbBridge } }).electronAPI = {
    psbRemote: bridge,
  };
  return bridge;
}

/** 卸载假桥（`afterEach`）。 */
export function uninstallPsbBridge(): void {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
}

/** 占用成功的返回值（占用人 = 自己）。 */
export function occupiedByMeResult(workspace: PsbRemoteWorkspace): PsbOccupyWorkspaceResult {
  return {
    workspace: {
      ...workspace,
      occupancy: {
        occupied: true,
        byMe: true,
        personId: 'me',
        personName: '我',
        occupiedAt: 1,
      },
    },
  };
}

/** 新建工作区成功的返回值。 */
export function createdWorkspaceResult(workspace: PsbRemoteWorkspace): PsbCreateWorkspaceResult {
  return { workspace };
}
