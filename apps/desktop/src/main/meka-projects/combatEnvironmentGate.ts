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
        '在 MCPRouter 中连接并绑定 SAGA2 服务器项目，然后重新检查',
      );
    }
    const probes = await Promise.allSettled(
      available.map((instance) => deps.probeRemoteCodexCapability(instance.id)),
    );
    const capabilityReady = probes.filter((probe) => probe.status === 'fulfilled').length;
    if (capabilityReady === 0) {
      const firstFailure = probes.find(
        (probe): probe is PromiseRejectedResult => probe.status === 'rejected',
      );
      const message = firstFailure
        ? firstFailure.reason instanceof Error
          ? firstFailure.reason.message
          : String(firstFailure.reason)
        : '';
      const mismatch = message.match(
        /(?:client bundle ([^\s]+) does not match server bundle ([^\s]+)|server bundle ([^\s]+) does not match client bundle ([^\s]+))/i,
      );
      const evidence = mismatch
        ? `cc-manager bundle mismatch: client=${mismatch[1] ?? mismatch[4]}; server=${mismatch[2] ?? mismatch[3]}`
        : '远端 Codex Worker capability 握手失败';
      const versionSummary = mismatch
        ? `（客户端 ${mismatch[1] ?? mismatch[4]}，远端 ${mismatch[2] ?? mismatch[3]}）`
        : '';
      return result(
        'blocked',
        `MCPRouter 已连接，但远端 Agent Runtime 与当前客户端不兼容${versionSummary}`,
        evidence,
        '升级并重启 MCPRouter 远端 runtime，确认 cc-manager bundle 与 protocol 精确匹配后重新检查',
      );
    }
    return result(
      'ready',
      'MCPRouter 已连接，且 SAGA2 服务器项目可启动远端 Codex 只读 Worker',
      `available=${available.length}; capabilityReady=${capabilityReady}`,
      '服务器现有能力只通过带只读标记的 MCPR Worker 核查；本流程不执行服务管理或服务器修改',
    );
  } catch (error) {
    return result(
      'blocked',
      'MCPRouter 连接或项目绑定不可用',
      error instanceof Error ? error.message : String(error),
      '在 Meka 设置中恢复 MCPRouter 连接并确认 SAGA2 服务器项目绑定',
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
    'Startup order: this Host check completed before the Agent started. The first user-visible assistant message must identify the role as "战斗开发" and report all three statuses from this receipt before loading any Skill, spawning any Worker, or using any other tool.',
    'Do not ask the user to authorize this environment check. Full access still does not bypass the Host workflow gate.',
    gate.ready
      ? 'After reporting the ready result, continue with Skill loading and read-only exploration. Treat this receipt as the authoritative startup result; do not repeat separate P4, Unity, or Router probes. Re-run only mcp_router.check_combat_environment at every phase transition and after any tool or transport failure.'
      : 'BLOCKED TURN CONTRACT: report the role, all three statuses, and each next action, then end this turn without any tool call. Do not load Skills or AGENTS.md, read files/code/tables, inspect ALL_TOOLS, call list_tools/Ghost/Worker/Unity business tools, or start business clarification. On a later explicit recovery request, call mcp_router.check_combat_environment exactly once. Only when its reason is a missing or unbound instance may you additionally call list_project_remote_instances once. A runtime/protocol version mismatch has no client-side automatic upgrade path: report the deployment-side upgrade/restart action and end the turn. Never pass sandbox_permissions, request elevation, describe a Host phase denial as user rejection, or retry a denied action with different parameters. Continue only when ready=true.',
    '[/SAGA2_COMBAT_ENVIRONMENT_GATE]',
  ].join('\n');
}
