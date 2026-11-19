export const ORCA_WORKER_PERMISSION_MODES = ['auto', 'bypassPermissions'] as const;

export type OrcaWorkerPermissionMode = (typeof ORCA_WORKER_PERMISSION_MODES)[number];

export const DEFAULT_ORCA_WORKER_PERMISSION_MODE: OrcaWorkerPermissionMode =
  'bypassPermissions';

export function isOrcaWorkerPermissionMode(value: unknown): value is OrcaWorkerPermissionMode {
  return ORCA_WORKER_PERMISSION_MODES.some((mode) => mode === value);
}

export function resolveOrcaWorkerPermissionMode(
  value: unknown,
): OrcaWorkerPermissionMode {
  return isOrcaWorkerPermissionMode(value) ? value : DEFAULT_ORCA_WORKER_PERMISSION_MODE;
}

/** 远程/跨设备 Worker 被主机强制升级权限的原因码；MCP 结果原样透传给 Lead 与用户。 */
export const REMOTE_WORKER_PERMISSION_UPGRADE_REASON =
  'remote-worker-requires-full-access' as const;

export interface OrcaWorkerPermissionForTarget {
  permissionMode: OrcaWorkerPermissionMode;
  permissionModeUpgraded: boolean;
  permissionModeReason?: typeof REMOTE_WORKER_PERMISSION_UPGRADE_REASON;
}

/**
 * Worker 创建时实际应使用的权限模式。
 *
 * Auto（自动审核）要求 owning session 能给出用户原话（userIntent）或经批准插件委派
 * （delegatedTask），两者都没有时只放行只读；远程/跨设备 Worker 由 Lead 派单，没有
 * 用户直接参与，Auto 下写操作必然被拦。因此对远程目标强制以 Full access
 * （bypassPermissions）创建，并把「这不是用户偏好的结果」结构化带出。
 *
 * 只作用于本次创建：不写用户全局 Worker 偏好，也不改 Team 偏好存储；本机 Worker
 * （remote=false）原样返回解析出的模式。
 */
export function resolveOrcaWorkerPermissionForTarget(params: {
  requested: unknown;
  /** true = Worker 目标在远程/另一台电脑（remoteHostId 或 executionDeviceId）。 */
  remote: boolean;
}): OrcaWorkerPermissionForTarget {
  const permissionMode = resolveOrcaWorkerPermissionMode(params.requested);
  if (!params.remote || permissionMode !== 'auto') {
    return { permissionMode, permissionModeUpgraded: false };
  }
  return {
    permissionMode: 'bypassPermissions',
    permissionModeUpgraded: true,
    permissionModeReason: REMOTE_WORKER_PERMISSION_UPGRADE_REASON,
  };
}
