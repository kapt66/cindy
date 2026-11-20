/**
 * 测试价值
 * - 生产入口与可观察结果：`createUserSession` 是 `local-db:sessions:create` 与 Host 共用创建
 *   服务，也是桌面显式 Meka 创建（左侧 Meka 助理 → Meka 项目）的唯一入口。2026-11-20 起它
 *   必须把显式绑定归一成普通 kind：有项目目录 → `project`，只有兜底目录 → `dialogue`，同时
 *   写 `project_dir` 与成对绑定；绝不能再写 `workspace_kind='meka'` 或半绑定行。
 * - Bug／规则依据：`docs/dev-rules/meka-assistant-session-binding.md` §1/§3（新会话不再写第三
 *   态；写入侧拒绝半绑定）。
 * - 现有覆盖缺口：本仓没有任何 createUserSession 行为测试（既有测试只做源码字符串接线断言），
 *   显式创建的 kind / projectDir / 无法解析路径时的兜底没有任何回归保护。
 * - 最小失败输入：`{ workspaceKind: 'meka', mekaProjectId, mekaRoleId }` 旧实现落
 *   `workspace_kind='meka'` 且没有 `project_dir`；`{ workspaceKind: 'project', 绑定 }` 旧实现会
 *   在 mapper 里把绑定清空。
 * - tier：unit（进程内 fake DB / 项目注册表 / 目录服务，无真实 I/O）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  owner: null as { client: { drizzle: unknown } } | null,
  inserted: [] as Record<string, unknown>[],
  queryOne: vi.fn(),
  getProjectById: vi.fn(),
  resolveProjectWorkspacePath: vi.fn(),
  ensureMekaWorkspaceDir: vi.fn((id: string) => `/meka-assistants/${id}`),
  notifyPluginSessionCreated: vi.fn(),
  upsertRecentWorkdir: vi.fn(async () => true),
}));

vi.mock('../client/current', () => ({
  getCurrentDbClientSnapshot: () => h.owner,
  getDbClient: () => ({
    drizzle: h.owner?.client.drizzle,
    queryOne: h.queryOne,
  }),
}));
vi.mock('../dialogueWorkspace', () => ({
  ensureDialogueWorkspaceDir: (id: string) => `/dialogues/${id}`,
}));
vi.mock('../../git-snapshot/projectGitBootstrap', () => ({
  ensureProjectGitInitialized: vi.fn(async () => undefined),
}));
vi.mock('../../maker-host/git-safety-settings-store', () => ({
  readGitSafetySettings: () => ({ autoSnapshotEnabled: false, autoInitProjectGit: false }),
}));
vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../ipc/mekaProjects.js', () => ({
  getMekaProjectById: h.getProjectById,
}));
vi.mock('../mekaWorkspace.js', () => ({
  ensureMekaWorkspaceDir: h.ensureMekaWorkspaceDir,
  resolveMekaProjectWorkspacePath: h.resolveProjectWorkspacePath,
}));
vi.mock('../../meka-formal/registry.js', () => ({ getFormalProvider: vi.fn(() => null) }));
vi.mock('../../meka-formal/providers.js', () => ({
  registerBuiltInFormalProviders: vi.fn(),
}));
vi.mock('../../meka-settings/ipc.js', () => ({
  getMekaP4SettingsService: () => ({ get: async () => ({ p4RootPath: null }) }),
}));
vi.mock('../ipc/recentWorkdirsCore.js', () => ({ upsertRecentWorkdir: h.upsertRecentWorkdir }));
vi.mock('../../worktree/resourceLock.js', () => ({
  withWorktreeResourceLocks: async <T,>(_values: readonly string[], task: () => Promise<T>) => task(),
}));
vi.mock('../../worktree/managedResourcePath.js', () => ({ managedWorktreeRoot: () => null }));

import { createUserSession } from '../ipc/createUserSession.js';
import { setSessionOpeningModelAdmission } from '../sessionOpening.js';
import { setWorkspaceBindingResolver } from '../workspaceBindingResolver.js';

function project(overrides: Record<string, unknown> = {}) {
  return {
    id: 'project-a',
    name: 'project-a',
    displayName: 'Project A',
    path: 'C:/P4/project-a',
    additionalPaths: [],
    configUnavailable: false,
    ...overrides,
  };
}

const ports = () => ({
  senderId: 7,
  userDataDir: '/user-data',
  notifyPluginSessionCreated: h.notifyPluginSessionCreated,
});

function installCreateSeams() {
  const drizzle = {
    insert: () => ({
      values: async (row: Record<string, unknown>) => {
        h.inserted.push(row);
      },
    }),
    select: () => ({
      from: () => ({
        where: async () => (h.inserted.length ? [h.inserted[h.inserted.length - 1]] : []),
      }),
    }),
  };
  h.owner = { client: { drizzle } };
  h.queryOne.mockResolvedValue({ project_id: 'project-a' });
  h.getProjectById.mockResolvedValue(project());
  h.resolveProjectWorkspacePath.mockResolvedValue('C:/P4/project-a');
  setSessionOpeningModelAdmission(async body => body);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.inserted.length = 0;
  setWorkspaceBindingResolver(null);
  installCreateSeams();
});

afterEach(() => {
  setWorkspaceBindingResolver(null);
});

describe('createUserSession explicit Meka binding (2026-11-20)', () => {
  it('stores an explicit Meka create as an ordinary project task with the binding', async () => {
    const session = await createUserSession(
      {
        id: 'meka-task',
        workspaceKind: 'meka',
        mekaProjectId: 'project-a',
        mekaRoleId: 'project-a-default-role',
        agentKind: 'codex',
      },
      ports(),
    );

    expect(h.getProjectById).toHaveBeenCalledWith('project-a');
    expect(session).toMatchObject({
      id: 'meka-task',
      workspaceKind: 'project',
      workingDir: 'C:/P4/project-a',
      projectDir: 'C:/P4/project-a',
      mekaProjectId: 'project-a',
      mekaRoleId: 'project-a-default-role',
      mekaRole: null,
    });
    // 返回值与落库行必须一致：不是只把返回对象投影成普通 kind。
    expect(h.inserted.at(-1)).toMatchObject({
      workspaceKind: 'project',
      workingDir: 'C:/P4/project-a',
      projectDir: 'C:/P4/project-a',
      mekaProjectId: 'project-a',
      mekaRoleId: 'project-a-default-role',
    });
  });

  it('keeps an explicit binding even when the caller already requested the ordinary project kind', async () => {
    const session = await createUserSession(
      {
        id: 'explicit-ordinary',
        workspaceKind: 'project',
        mekaProjectId: 'project-a',
        mekaRoleId: 'project-a-default-role',
      },
      ports(),
    );

    expect(session).toMatchObject({
      workspaceKind: 'project',
      projectDir: 'C:/P4/project-a',
      mekaProjectId: 'project-a',
      mekaRoleId: 'project-a-default-role',
    });
  });

  it('falls back to the dialogue kind when the project has no resolvable workspace path', async () => {
    h.getProjectById.mockResolvedValue(project({ path: null }));
    h.resolveProjectWorkspacePath.mockResolvedValue(null);

    const session = await createUserSession(
      {
        id: 'meka-fallback',
        workspaceKind: 'meka',
        mekaProjectId: 'project-a',
        mekaRoleId: 'project-a-default-role',
      },
      ports(),
    );

    expect(h.ensureMekaWorkspaceDir).toHaveBeenCalledWith('meka-fallback', expect.any(Number));
    expect(session).toMatchObject({
      workspaceKind: 'dialogue',
      workingDir: '/meka-assistants/meka-fallback',
      projectDir: null,
      mekaProjectId: 'project-a',
      mekaRoleId: 'project-a-default-role',
    });
  });

  it('rejects half bindings and roles from another project before writing any row', async () => {
    await expect(
      createUserSession({ id: 'half-bound', mekaProjectId: 'project-a' }, ports()),
    ).rejects.toThrow('Meka session requires both a project and a role');

    h.queryOne.mockResolvedValue({ project_id: 'other-project' });
    await expect(
      createUserSession(
        {
          id: 'foreign-role',
          workspaceKind: 'meka',
          mekaProjectId: 'project-a',
          mekaRoleId: 'other-project-default-role',
        },
        ports(),
      ),
    ).rejects.toThrow('Meka role does not belong to the selected project');

    expect(h.inserted).toHaveLength(0);
  });
});
