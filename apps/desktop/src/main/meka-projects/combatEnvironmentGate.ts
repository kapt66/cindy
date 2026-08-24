import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { MekaP4Settings } from '../../shared/meka-settings.js';
import type { MekaRouterInstance } from '../../shared/meka-router.js';

const execFileAsync = promisify(execFile);

export type CombatEnvironmentCheck = {
  status: 'ready' | 'blocked';
  summary: string;
  evidence?: string;
  nextAction?: string;
};

export type CombatEnvironmentGateResult = {
  checkedAt: string;
  ready: boolean;
  p4: CombatEnvironmentCheck;
  unityMcp: CombatEnvironmentCheck;
  mcpr: CombatEnvironmentCheck;
};

export type CombatEnvironmentAvailability = Pick<
  CombatEnvironmentGateResult,
  'p4' | 'unityMcp' | 'mcpr'
>;

export function combatEnvironmentAvailability(
  gate: CombatEnvironmentGateResult,
): CombatEnvironmentAvailability {
  const safeCheck = (check: CombatEnvironmentCheck): CombatEnvironmentCheck => ({
    status: check.status,
    summary: check.summary,
    ...(check.nextAction ? { nextAction: check.nextAction } : {}),
  });
  return {
    p4: safeCheck(gate.p4),
    unityMcp: safeCheck(gate.unityMcp),
    mcpr: safeCheck(gate.mcpr),
  };
}

export type CombatEnvironmentReceiptContext = {
  projectId: string;
  roleId: string;
  displayName: string;
  workflow: string | null;
  workflowRecoveredFromRole: boolean;
};

export interface CombatEnvironmentGateDeps {
  p4: Pick<MekaP4Settings, 'p4RootPath'>;
  p4Command?: string;
  execFile?: typeof execFileAsync;
  readFile?: (filePath: string) => Promise<string>;
  fetch?: typeof globalThis.fetch;
  isProcessRunning?: (pid: number) => boolean;
  listInstances: () => Promise<readonly MekaRouterInstance[]>;
  listProjectBindings: (projectId: string) => Promise<readonly string[]>;
  probeRemoteCodexCapability: (instanceId: string) => Promise<void>;
  projectId: string;
  now?: () => Date;
}

function result(
  status: CombatEnvironmentCheck['status'],
  summary: string,
  evidence?: string,
  nextAction?: string,
): CombatEnvironmentCheck {
  return {
    status,
    summary,
    ...(evidence ? { evidence } : {}),
    ...(nextAction ? { nextAction } : {}),
  };
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function ztagValue(output: string, tag: string): string | null {
  const prefix = `... ${tag} `;
  const line = output.split(/\r?\n/).find((candidate) => candidate.startsWith(prefix));
  return line?.slice(prefix.length).trim() || null;
}

function sameOrChildPath(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  );
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.normalize(path.resolve(value));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

async function checkP4(deps: CombatEnvironmentGateDeps): Promise<CombatEnvironmentCheck> {
  const root = deps.p4.p4RootPath;
  if (!root) {
    return result(
      'blocked',
      'P4 工作区未配置',
      '未读取到 P4 根目录',
      '在 Meka 设置中配置 SAGA2 P4 根目录',
    );
  }
  const run = deps.execFile ?? execFileAsync;
  const command = deps.p4Command ?? 'p4';
  try {
    const commandOptions = { timeout: 5000, windowsHide: true } as const;
    const [info, where, client, protects] = await Promise.all([
      run(command, ['-ztag', 'info'], commandOptions),
      run(command, ['-ztag', 'where', path.join(root, 'saga2_unity', '...')], commandOptions),
      run(command, ['-ztag', 'client', '-o'], commandOptions),
      run(
        command,
        ['-ztag', 'protects', '-m', path.join(root, 'saga2_unity', '...')],
        commandOptions,
      ),
    ]);
    if (
      !info.stdout ||
      !where.stdout ||
      !client.stdout ||
      !/permMax\s+(?:write|review|admin|super)\b/i.test(protects.stdout)
    ) {
      throw new Error('p4 returned incomplete mapping or write-permission evidence');
    }
    const infoRoot = ztagValue(info.stdout, 'clientRoot');
    const mappedPath = ztagValue(where.stdout, 'path');
    const clientRoot = ztagValue(client.stdout, 'Root');
    if (
      !infoRoot ||
      !clientRoot ||
      !mappedPath ||
      !samePath(infoRoot, root) ||
      !samePath(clientRoot, root) ||
      !sameOrChildPath(mappedPath.replace(/\.\.\.$/, ''), path.join(root, 'saga2_unity'))
    ) {
      throw new Error(
        'p4 client root or local mapping does not match the configured SAGA2 workspace',
      );
    }
    return result(
      'ready',
      'P4 可用且已解析 SAGA2 客户端映射',
      `root=${root}; where/client 已返回`,
      '编辑前使用 p4 edit/checkout 打开目标文件',
    );
  } catch (error) {
    return result(
      'blocked',
      'P4 命令或工作区映射不可用',
      error instanceof Error ? error.message : String(error),
      '检查 p4 登录、P4CLIENT、根目录映射和客户端文件权限',
    );
  }
}

async function checkUnityMcp(deps: CombatEnvironmentGateDeps): Promise<CombatEnvironmentCheck> {
  const root = deps.p4.p4RootPath;
  if (!root)
    return result('blocked', '无法定位 UnityMCP 项目', 'P4 根目录未配置', '先完成 P4 环境配置');
  const readFile = deps.readFile ?? ((filePath) => fs.readFile(filePath, 'utf8'));
  const discoveryPath = path.join(root, 'saga2_unity', 'Temp', 'UnityMcpDiscovery.json');
  try {
    const parsed = JSON.parse(await readFile(discoveryPath)) as Record<string, unknown>;
    const projectRoot =
      typeof parsed.projectRoot === 'string' ? path.resolve(parsed.projectRoot) : '';
    const mcpUrl = typeof parsed.mcpUrl === 'string' ? parsed.mcpUrl : '';
    const unityPid = typeof parsed.unityPid === 'number' ? parsed.unityPid : 0;
    if (projectRoot !== path.resolve(path.join(root, 'saga2_unity')) || !mcpUrl) {
      return result(
        'blocked',
        'UnityMCP 已发现但项目不匹配',
        `discovery=${discoveryPath}`,
        '打开目标 SAGA2 Unity 工程并启动其 UnityMCP 服务',
      );
    }
    if (!unityPid || !(deps.isProcessRunning ?? processIsRunning)(unityPid)) {
      return result(
        'blocked',
        'UnityMCP 项目发现记录已失效',
        `discovery=${discoveryPath}`,
        '重新打开目标 SAGA2 Unity 工程并启动其 UnityMCP 服务',
      );
    }
    const fetchImpl = deps.fetch ?? globalThis.fetch;
    if (!fetchImpl) throw new Error('fetch unavailable');
    const healthUrl = new URL('/health', mcpUrl).href;
    const response = await fetchImpl(healthUrl, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error(`UnityMCP health HTTP ${response.status}`);
    const health = (await response.json()) as { status?: unknown };
    if (health.status !== 'healthy') throw new Error('UnityMCP health response is not healthy');
    return result(
      'ready',
      'UnityMCP 已连接到目标 SAGA2 Unity 工程',
      `projectRoot=${projectRoot}; health=${response.status}`,
      '使用 UnityMCP 进行 Unity 资产和编辑器操作',
    );
  } catch (error) {
    return result(
      'blocked',
      'UnityMCP 不可用或未连接目标工程',
      error instanceof Error ? error.message : String(error),
      '启动 SAGA2 Unity 工程中的 MCP 服务后重新检查',
    );
  }
}

function looksLikeServer(instance: MekaRouterInstance): boolean {
  return /server|服务器|saga2[-_ ]?server/i.test(
    `${instance.projectName} ${instance.projectDescription ?? ''}`,
  );
}

async function checkMcpr(deps: CombatEnvironmentGateDeps): Promise<CombatEnvironmentCheck> {
  try {
    const [bindings, instances] = await Promise.all([
      deps.listProjectBindings(deps.projectId),
      deps.listInstances(),
    ]);
    const bound = instances.filter((instance) => bindings.includes(instance.id));
    const available = bound.filter((instance) => instance.available && looksLikeServer(instance));
    if (available.length === 0) {
      return result(
        'blocked',
        'MCPRouter 未找到可用的 SAGA2 服务器远程项目',
        `bound=${bound.length}`,
        '当请求需要服务器证据时，直接调用 mcp_router.list_remote_directory、read_remote_file 或 search_remote_files；读取工具内部自动恢复、创建或绑定',
      );
    }
    return result(
      'ready',
      'MCPRouter 已连接，且 SAGA2 服务器远程项目可作为只读参考工作面',
      `available=${available.length}`,
      '优先使用远程项目只读能力；创建 MCPR Agent/Worker 时再单独检查远端 runtime capability',
    );
  } catch (error) {
    return result(
      'blocked',
      'MCPRouter 连接或项目绑定不可用',
      error instanceof Error ? error.message : String(error),
      '当请求需要服务器证据时，直接调用对应远程读取工具自动恢复；仅按读取工具的 fallbackUserAction 提示人工处理',
    );
  }
}

export async function runCombatEnvironmentGate(
  deps: CombatEnvironmentGateDeps,
): Promise<CombatEnvironmentGateResult> {
  const [p4, unityMcp, mcpr] = await Promise.all([
    checkP4(deps),
    checkUnityMcp(deps),
    checkMcpr(deps),
  ]);
  return {
    checkedAt: (deps.now ?? (() => new Date()))().toISOString(),
    ready: [p4, unityMcp, mcpr].every((item) => item.status === 'ready'),
    p4,
    unityMcp,
    mcpr,
  };
}

/** Stable model-facing receipt. Evidence stays in Main logs and never exposes endpoints or credentials. */
export function formatCombatEnvironmentGateReceipt(
  gate: CombatEnvironmentGateResult,
  context?: CombatEnvironmentReceiptContext,
): string {
  const line = (name: string, check: CombatEnvironmentCheck) =>
    `- ${name}: ${check.status}; ${check.summary}${check.nextAction ? `; next=${check.nextAction}` : ''}`;
  return [
    '[SAGA2_COMBAT_ENVIRONMENT_GATE]',
    ...(context
      ? [
          `projectId: ${context.projectId}`,
          `roleId: ${context.roleId}`,
          `displayName: ${context.displayName}`,
          `workflow: ${context.workflow ?? 'missing'}`,
          `workflowRecoveredFromRole: ${context.workflowRecoveredFromRole}`,
        ]
      : []),
    `checkedAt: ${gate.checkedAt}`,
    `ready: ${gate.ready}`,
    line('p4', gate.p4),
    line('unityMcp', gate.unityMcp),
    line('mcpr', gate.mcpr),
    'Startup order: this Host check completed before the Agent started. Do not merely repeat a blocked status. If the user asks whether the SAGA2 server is accessible, call mcp_router.list_remote_directory and use the real root read as evidence. For specific evidence, call read_remote_file or search_remote_files directly. These tools automatically recover and bind the remote project. Report a configuration action only when the read returns a user-action fallback. Do not spawn a Worker for ordinary reference reads.',
    'Do not ask the user to authorize this environment check. Full access still does not bypass the Host workflow gate.',
    gate.ready
      ? 'Continue with Skill loading and read-only exploration without a fixed environment-status preamble. Treat this receipt as the authoritative startup result; do not repeat separate P4, Unity, or Router probes. Re-run only mcp_router.check_combat_environment at every phase transition and after a real P4, UnityMCP, or MCPRouter connection/transport failure.'
      : 'DEGRADED EXPLORATION CONTRACT: do not turn this aggregate warning into a user-facing preamble or task gate. Load relevant Skills, clarify requirements, read local files/code/tables, and use tools backed by dependencies that remain ready. When the request depends on the SAGA2 server, call list_remote_directory, read_remote_file, or search_remote_files directly; report only a fallbackUserAction that remains after the read tool automatic recovery. Host blocks only a concrete tool call whose own dependency is unavailable (or whose ordinary plan/risk approval is missing), and that denial must name the dependency, reason, and recovery action. Do not substitute local guesses for missing server evidence. Re-run mcp_router.check_combat_environment only at a phase transition, before implementation, or after a real P4, UnityMCP, or MCPRouter connection or transport failure; do not repeat it for ordinary missing files or inconclusive evidence. A runtime/protocol version mismatch has no client-side automatic upgrade path, but does not block independent local exploration. Never pass sandbox_permissions, request elevation, describe a Host phase denial as user rejection, or retry a denied action with different parameters.',
    '[/SAGA2_COMBAT_ENVIRONMENT_GATE]',
  ].join('\n');
}
