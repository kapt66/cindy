/**
 * 工作区 → Meka 助理绑定的解析端口。
 *
 * `localDb`（以及复用它、不依赖 Electron 的 `apps/host`）不能直接依赖 Meka 设置与项目
 * 注册表，所以由 Desktop main 在组合根安装实现（`registerLocalDbIpc`）。端口未安装时
 * 一律返回 null = 不隐式绑定，普通会话行为不变。
 *
 * 规则正本：`docs/dev-rules/meka-assistant-session-binding.md`。
 */

export interface WorkspaceBindingResolution {
  projectId: string;
  roleId: string;
  /** 规范化后的 Meka 项目工作目录；调用方应把它写成会话的 `projectDir`。 */
  workspacePath: string;
}

export interface WorkspaceBindingResolveInput {
  workingDir: string | null;
  projectDir: string | null;
  remoteHostId?: string | null;
  agentDeviceId?: string | null;
}

export type WorkspaceBindingResolver = (
  input: WorkspaceBindingResolveInput,
) => Promise<WorkspaceBindingResolution | null>;

let resolver: WorkspaceBindingResolver | null = null;

/** 由 Desktop main 的 localDb IPC 组合根安装；传 null 撤销（测试用）。 */
export function setWorkspaceBindingResolver(next: WorkspaceBindingResolver | null): void {
  resolver = next;
}

export function hasWorkspaceBindingResolver(): boolean {
  return resolver !== null;
}

/**
 * 解析会话工作区对应的 Meka 绑定。
 *
 * 解析失败按「不绑定」处理，避免普通任务因为 Meka 项目注册表 / 设置暂时不可用而建不出来；
 * 真正需要 Meka 的显式创建路径不走这里，仍由 `createUserSession` 直接报错。
 */
export async function resolveSessionWorkspaceBinding(
  input: WorkspaceBindingResolveInput,
): Promise<WorkspaceBindingResolution | null> {
  if (!resolver) return null;
  try {
    return await resolver(input);
  } catch (error) {
    console.warn('[meka] workspace binding resolution failed; keeping ordinary session', {
      workingDir: input.workingDir,
      projectDir: input.projectDir,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
