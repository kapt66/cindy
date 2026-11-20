/**
 * 测试价值
 * - 生产入口与可观察结果：`resolveMekaWorkspaceBinding`（main 组合根装进 localDb 创建缝的
 *   解析器）决定「新建/移动到这个目录的会话是否变成 Meka 助理任务」；解析结果会写进
 *   `sessions.meka_project_id / meka_role_id / project_dir`。`resolveSessionWorkspaceBinding`
 *   是 localDb / Host 用的端口：端口未安装或解析抛错时必须退化为普通会话，不能让创建失败。
 * - Bug／规则依据：`docs/dev-rules/meka-assistant-session-binding.md` §2（只做规范化后精确
 *   匹配、projectDir 是显式归属、远程/跨设备不参与、configUnavailable 不参与、隐式只给项目
 *   默认角色）。
 * - 现有覆盖缺口：两个模块都是本轮新增，没有任何测试；相邻的 mekaWorkspace.test.ts 只覆盖
 *   项目路径 token 解析，不覆盖注册表匹配与端口兜底。
 * - 最小失败输入：项目路径 `C:/P4/saga2` + 会话 workingDir `C:\\P4\\saga2\\` 旧实现不会命中
 *   （未做 storage 规范化）；resolver 抛错时若向上冒泡，普通任务会被 Meka 注册表故障拖死。
 * - tier：unit（进程内 fake 项目清单，无 I/O）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mekaDefaultRoleId } from '../../../shared/meka-projects.js';

const h = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock('../../localDb/ipc/mekaProjects.js', () => ({
  listMekaProjectsForRuntime: h.list,
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { resolveMekaWorkspaceBinding } from '../workspaceBinding.js';
import {
  hasWorkspaceBindingResolver,
  resolveSessionWorkspaceBinding,
  setWorkspaceBindingResolver,
} from '../../localDb/workspaceBindingResolver.js';

function project(overrides: Record<string, unknown> = {}) {
  return {
    id: 'project-a',
    name: 'Project A',
    displayName: 'Project A',
    path: 'C:/P4/project-a',
    configUnavailable: false,
    ...overrides,
  };
}

function resolution() {
  return { projectId: 'project-a', roleId: 'project-a-default-role', workspacePath: 'C:/P4/project-a' };
}

afterEach(() => {
  setWorkspaceBindingResolver(null);
  h.list.mockReset();
});

describe('resolveMekaWorkspaceBinding', () => {
  it('matches the registered project path exactly and binds its default role', async () => {
    h.list.mockResolvedValue([project()]);

    await expect(
      resolveMekaWorkspaceBinding({
        workingDir: 'C:\\P4\\project-a\\',
        projectDir: null,
      }),
    ).resolves.toEqual({
      projectId: 'project-a',
      roleId: mekaDefaultRoleId('project-a'),
      workspacePath: 'C:/P4/project-a',
    });
  });

  it('matches through projectDir when the execution directory is outside every Meka project', async () => {
    h.list.mockResolvedValue([project()]);

    await expect(
      resolveMekaWorkspaceBinding({
        workingDir: 'D:/worktrees/some-feature',
        projectDir: 'C:/P4/project-a',
      }),
    ).resolves.toEqual(resolution());
  });

  it('keeps a task outside every registered project ordinary', async () => {
    h.list.mockResolvedValue([project()]);

    await expect(
      resolveMekaWorkspaceBinding({ workingDir: 'C:/Other/place', projectDir: null }),
    ).resolves.toBeNull();
    // 子目录/前缀不算命中：保留 Meka 目录的精确匹配语义。
    await expect(
      resolveMekaWorkspaceBinding({ workingDir: 'C:/P4/project-a/sub', projectDir: null }),
    ).resolves.toBeNull();
  });

  it.each(['remoteHostId', 'agentDeviceId'] as const)(
    'never binds a task that runs on another computer via %s',
    async key => {
      h.list.mockResolvedValue([project()]);

      const location =
        key === 'remoteHostId' ? { remoteHostId: 'host-1' } : { agentDeviceId: 'device-1' };
      await expect(
        resolveMekaWorkspaceBinding({
          workingDir: 'C:/P4/project-a',
          projectDir: null,
          ...location,
        }),
      ).resolves.toBeNull();
      expect(h.list).not.toHaveBeenCalled();
    },
  );

  it('skips projects whose configuration is unavailable', async () => {
    h.list.mockResolvedValue([
      project({ id: 'broken', path: 'C:/P4/broken', configUnavailable: true }),
    ]);

    await expect(
      resolveMekaWorkspaceBinding({ workingDir: 'C:/P4/broken', projectDir: null }),
    ).resolves.toBeNull();
  });

  it('returns null without asking the registry when the session has no directory', async () => {
    await expect(
      resolveMekaWorkspaceBinding({ workingDir: null, projectDir: null }),
    ).resolves.toBeNull();
    expect(h.list).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === 'win32')(
    'folds Windows path case when matching a registered project',
    async () => {
      h.list.mockResolvedValue([project({ path: 'C:/P4/Project-A' })]);

      await expect(
        resolveMekaWorkspaceBinding({ workingDir: 'c:/p4/project-a', projectDir: null }),
      ).resolves.toMatchObject({ projectId: 'project-a' });
    },
  );

  it.runIf(process.platform !== 'win32')(
    'keeps POSIX paths case-sensitive when matching a registered project',
    async () => {
      h.list.mockResolvedValue([project({ path: 'C:/P4/Project-A' })]);

      await expect(
        resolveMekaWorkspaceBinding({ workingDir: 'c:/p4/project-a', projectDir: null }),
      ).resolves.toBeNull();
    },
  );

  it('keeps the task ordinary when the project registry itself is unavailable', async () => {
    h.list.mockRejectedValue(new Error('settings unavailable'));

    await expect(
      resolveMekaWorkspaceBinding({ workingDir: 'C:/P4/project-a', projectDir: null }),
    ).resolves.toBeNull();
  });
});

describe('resolveSessionWorkspaceBinding port', () => {
  it('does not bind anything until the Desktop composition root installs a resolver', async () => {
    expect(hasWorkspaceBindingResolver()).toBe(false);
    await expect(
      resolveSessionWorkspaceBinding({ workingDir: 'C:/P4/project-a', projectDir: null }),
    ).resolves.toBeNull();
  });

  it('returns the installed resolver result', async () => {
    const installed = { projectId: 'p', roleId: 'p-default-role', workspacePath: 'C:/P4/p' };
    const resolver = vi.fn(async () => installed);
    setWorkspaceBindingResolver(resolver);

    await expect(
      resolveSessionWorkspaceBinding({
        workingDir: 'C:/P4/p',
        projectDir: null,
        remoteHostId: null,
      }),
    ).resolves.toEqual(installed);
    expect(resolver).toHaveBeenCalledWith({
      workingDir: 'C:/P4/p',
      projectDir: null,
      remoteHostId: null,
    });
  });

  // 端口失败必须降级为「不绑定」：Meka 项目注册表/设置暂时不可用不能拖死普通任务创建。
  it('keeps the task ordinary and warns when the installed resolver throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setWorkspaceBindingResolver(async () => {
      throw new Error('registry boom');
    });

    try {
      await expect(
        resolveSessionWorkspaceBinding({ workingDir: 'C:/P4/project-a', projectDir: null }),
      ).resolves.toBeNull();
      expect(warn).toHaveBeenCalledWith(
        '[meka] workspace binding resolution failed; keeping ordinary session',
        expect.objectContaining({ workingDir: 'C:/P4/project-a', error: 'registry boom' }),
      );
    } finally {
      warn.mockRestore();
    }
  });
});
