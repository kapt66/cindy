import { resolveSessionWorkspaceBinding } from './workspaceBindingResolver.js';

/**
 * 会话创建时的 Meka 身份解析（唯一创建侧入口）。
 *
 * 规则（见 docs/dev-rules/meka-assistant-session-binding.md §2）：
 * - 显式成对绑定优先；半绑定直接拒绝，绝不落半身份行。
 * - 只有本地工作区才做路径隐式绑定；`remoteHostId` 是远端路径，不能拿本机项目表
 *   去匹配（同路径可能属于另一台电脑）。
 * - `agentDeviceId` 不参与跳过：任务文件与工作区仍在本机，身份按本机工作区解析；
 *   只有 Agent 进程在另一台电脑。
 * - `workspaceKind === 'meka'` 是旧行/旧调用兼容值；命中路径时归一成普通
 *   `project` + 成对绑定，未命中时保持旧值交给 legacy 兼容层。
 */
export interface SessionCreateIdentityInput {
  workspaceKind: 'project' | 'dialogue' | 'meka';
  workingDir?: string | null;
  projectDir?: string | null;
  remoteHostId?: string | null;
  agentDeviceId?: string | null;
  mekaProjectId?: string | null;
  mekaRoleId?: string | null;
}

export interface SessionCreateIdentity {
  workspaceKind: 'project' | 'dialogue' | 'meka';
  mekaProjectId: string | null;
  mekaRoleId: string | null;
  /** 命中隐式项目时是项目根；否则沿用调用方 projectDir。 */
  projectDir: string | null;
}

function normalizeId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function resolveSessionIdentityForCreate(
  input: SessionCreateIdentityInput,
): Promise<SessionCreateIdentity> {
  const explicitProjectId = normalizeId(input.mekaProjectId);
  const explicitRoleId = normalizeId(input.mekaRoleId);
  if (Boolean(explicitProjectId) !== Boolean(explicitRoleId)) {
    throw new Error('Meka session binding requires both a project and a role');
  }
  if (explicitProjectId && explicitRoleId) {
    return {
      // 新会话不再写第三态；旧 kind 只可能是调用方兼容传值。
      workspaceKind: input.workspaceKind === 'meka' ? 'project' : input.workspaceKind,
      mekaProjectId: explicitProjectId,
      mekaRoleId: explicitRoleId,
      projectDir: input.projectDir ?? null,
    };
  }

  // 远端工作区不是本机目录，禁止用本机 Meka 项目路径推断身份。
  if (input.remoteHostId) {
    return {
      workspaceKind: input.workspaceKind,
      mekaProjectId: null,
      mekaRoleId: null,
      projectDir: input.projectDir ?? null,
    };
  }

  const resolution = await resolveSessionWorkspaceBinding({
    workingDir: input.workingDir ?? null,
    projectDir: input.projectDir ?? null,
    remoteHostId: null,
    // 身份按本机工作区解析：Agent 在另一台电脑(agentDeviceId)不影响本机路径。
    agentDeviceId: null,
  });
  if (!resolution) {
    return {
      workspaceKind: input.workspaceKind,
      mekaProjectId: null,
      mekaRoleId: null,
      projectDir: input.projectDir ?? null,
    };
  }
  return {
    workspaceKind: 'project',
    mekaProjectId: resolution.projectId,
    mekaRoleId: resolution.roleId,
    projectDir: resolution.workspacePath,
  };
}

