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
  unityCli: CombatEnvironmentCheck;
  mcpr: CombatEnvironmentCheck;
};

export type CombatEnvironmentAvailability = Pick<
  CombatEnvironmentGateResult,
  'p4' | 'unityCli' | 'mcpr'
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
    unityCli: safeCheck(gate.unityCli),
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

async function checkUnityCli(deps: CombatEnvironmentGateDeps): Promise<CombatEnvironmentCheck> {
  const root = deps.p4.p4RootPath;
  if (!root)
    return result('blocked', '无法定位 Unity 工程', 'P4 根目录未配置', '先完成 P4 环境配置');
  return result(
    'ready',
    'Meka Unity 官方 CLI 已纳入当前工作流',
    `projectRoot=${path.resolve(path.join(root, 'saga2_unity'))}`,
    '需要 Unity 证据时先调用 unity_inspect status；执行编辑器操作使用 unity_execute',
  );
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
  const [p4, unityCli, mcpr] = await Promise.all([
    checkP4(deps),
    checkUnityCli(deps),
    checkMcpr(deps),
  ]);
  return {
    checkedAt: (deps.now ?? (() => new Date()))().toISOString(),
    ready: [p4, unityCli, mcpr].every((item) => item.status === 'ready'),
    p4,
    unityCli,
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
    line('unityCli', gate.unityCli),
    line('mcpr', gate.mcpr),
    'Startup order: this Host check completed before the Agent started. Use unity_inspect for Unity evidence and MCPRouter reads for server evidence.',
    'Do not ask the user to authorize this environment check. Full access still does not bypass the Host workflow gate.',
    gate.ready
      ? 'Continue with Skill loading and read-only exploration. Re-run the environment check only at phase transitions or after a real dependency transport failure.'
      : 'DEGRADED EXPLORATION CONTRACT: continue local exploration and use tools backed by dependencies that remain ready. A concrete dependency failure must name the dependency, reason and recovery action; ordinary missing files or inconclusive evidence do not trigger a full environment recheck.',
    '[/SAGA2_COMBAT_ENVIRONMENT_GATE]',
  ].join('\n');
}
