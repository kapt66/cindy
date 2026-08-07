import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

import {
  LocalServerRuntime,
  type LocalServerArtifactDescriptor,
  type LocalServerRuntimeDeps,
} from './localServerRuntime.js';

export type LocalServerRunStatus = 'stopped' | 'preparing' | 'starting' | 'running' | 'stopping' | 'failed';

export interface LocalServerRunView {
  instanceId: string;
  taskId: string;
  runId: string;
  programId?: string;
  programName?: string;
  status: LocalServerRunStatus;
  phase?: string;
  startedAt?: number;
  finishedAt?: number;
  exitCode?: number | null;
  logs: string[];
  error?: string;
}

export interface LocalServerBuildMetadata {
  taskId: string;
  builtAt: number;
  sourceRef?: string;
  commitSha?: string;
  commitMessage?: string;
}

type RuntimeContract = Record<string, unknown> & {
  apiVersion?: unknown;
  run?: Record<string, unknown>;
  config?: Record<string, unknown>;
};

type RuntimeProgram = {
  id: string;
  name: string;
  run: Record<string, unknown>;
  directories?: unknown;
  health?: Record<string, unknown>;
  config?: Record<string, unknown>;
};

export interface LocalServerProgramView {
  id: string;
  name: string;
  prepared: boolean;
  status: LocalServerRunStatus;
  phase?: string;
  runId?: string;
  taskId?: string;
  logs?: string[];
  error?: string;
}

export interface LocalServerDescription {
  instanceId: string;
  configConfigured: boolean;
  configLabel?: string;
  configInputs: LocalServerConfigInputView[];
  prepared: boolean;
  taskId?: string;
  build?: LocalServerBuildMetadata;
  programs: LocalServerProgramView[];
}

export interface LocalServerConfigInputView {
  id: string;
  type: 'directory' | 'text';
  label: string;
  required: boolean;
  configured: boolean;
  value: string;
  placeholder?: string;
  suggestions?: string[];
}

type RuntimeConfigInput = LocalServerConfigInputView & { defaultValue?: string; selectTitle?: string };

type InternalRun = LocalServerRunView & {
  runDir: string;
  baselineDir?: string;
  pid?: number;
  executablePath?: string;
  port?: number;
  child?: ChildProcess;
  build?: LocalServerBuildMetadata;
};

export interface LocalServerSupervisorDeps {
  userDataPath: string;
  downloadArtifact: LocalServerRuntimeDeps['downloadArtifact'];
  getArtifact: (instanceId: string, taskId: string) => Promise<{ taskId: string; artifact: LocalServerArtifactDescriptor }>;
  getBuildMetadata: (instanceId: string, taskId: string) => Promise<LocalServerBuildMetadata>;
  getRuntimeContract: (instanceId: string) => Promise<RuntimeContract>;
  selectConfigDirectory?: (instanceId: string, inputId?: string, title?: string) => Promise<string | null>;
  platform?: NodeJS.Platform;
  killProcessTree?: (pid: number) => Promise<void>;
}

const MAX_LOG_LINES = 500;
const MAX_CONFIG_STEPS = 64;
const MAX_CONFIG_FILE_BYTES = 4 * 1024 * 1024;
const OPAQUE_ID = /^[-A-Za-z0-9._]{1,128}$/;
const CONFIG_INPUT_ID = /^[A-Za-z0-9._-]{1,64}$/;

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function relativePath(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024 || value.includes('\0')) {
    throw new Error(`Invalid runtime contract ${field}`);
  }
  const normalized = value.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || normalized.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`Runtime contract ${field} must be a relative path`);
  }
  return normalized;
}

function stringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 128 || value.some(item => typeof item !== 'string' || item.length > 4096 || item.includes('\0'))) {
    throw new Error(`Invalid runtime contract ${field}`);
  }
  return value as string[];
}

function programId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(value)) throw new Error('Invalid runtime contract run.programs.id');
  return value;
}

function programSpecs(contract: RuntimeContract): RuntimeProgram[] {
  const run = record(contract.run) ? contract.run : null;
  const programs = run && Array.isArray(run.programs) ? run.programs : null;
  if (programs) {
    if (!programs.length || programs.length > 128) throw new Error('Invalid runtime contract run.programs');
    return programs.map((raw, index) => {
      if (!record(raw)) throw new Error(`Invalid runtime contract run.programs[${index}]`);
      const id = programId(raw.id);
      const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 128) : id;
      return { id, name, run: raw, directories: raw.directories ?? (run?.directories), health: record(raw.health) ? raw.health : (record(contract.health) ? contract.health : undefined), config: record(raw.config) ? raw.config : (record(contract.config) ? contract.config : undefined) };
    });
  }
  if (!run || typeof run.executable !== 'string') throw new Error('Runtime contract has no run specification');
  return [{ id: 'default', name: '服务器', run, directories: run.directories, health: record(contract.health) ? contract.health : undefined, config: record(contract.config) ? contract.config : undefined }];
}

function configInputs(contract: RuntimeContract): RuntimeConfigInput[] {
  const config = record(contract.config) ? contract.config : null;
  if (!config || config.inputs === undefined) {
    return [{ id: 'configDirectory', type: 'directory', label: '配置表位置', required: true, configured: false, value: '' }];
  }
  if (!Array.isArray(config.inputs) || !config.inputs.length || config.inputs.length > 16) {
    throw new Error('Invalid runtime contract config.inputs');
  }
  const seen = new Set<string>();
  return config.inputs.map((raw, index) => {
    if (!record(raw) || typeof raw.id !== 'string' || !CONFIG_INPUT_ID.test(raw.id) || seen.has(raw.id)) {
      throw new Error(`Invalid runtime contract config.inputs[${index}].id`);
    }
    seen.add(raw.id);
    if (raw.type !== 'directory' && raw.type !== 'text') throw new Error(`Invalid runtime contract config.inputs[${index}].type`);
    if (typeof raw.label !== 'string' || !raw.label.trim() || raw.label.length > 128) throw new Error(`Invalid runtime contract config.inputs[${index}].label`);
    const optionalStrings = ['default', 'placeholder', 'selectTitle'] as const;
    if (optionalStrings.some(key => raw[key] !== undefined && (typeof raw[key] !== 'string' || String(raw[key]).length > 4096 || String(raw[key]).includes('\0')))) {
      throw new Error(`Invalid runtime contract config.inputs[${index}]`);
    }
    if (raw.type === 'directory' && raw.default !== undefined) throw new Error(`Invalid runtime contract config.inputs[${index}].default`);
    const suggestions = raw.suggestions === undefined ? undefined : raw.suggestions;
    if (suggestions !== undefined && (!Array.isArray(suggestions) || suggestions.length > 64 || suggestions.some(item => typeof item !== 'string' || item.length > 512 || item.includes('\0')))) {
      throw new Error(`Invalid runtime contract config.inputs[${index}].suggestions`);
    }
    const defaultValue = typeof raw.default === 'string' ? raw.default : undefined;
    return {
      id: raw.id,
      type: raw.type,
      label: raw.label.trim(),
      required: raw.required !== false,
      configured: false,
      value: '',
      ...(defaultValue !== undefined ? { defaultValue } : {}),
      ...(typeof raw.placeholder === 'string' ? { placeholder: raw.placeholder } : {}),
      ...(typeof raw.selectTitle === 'string' ? { selectTitle: raw.selectTitle } : {}),
      ...(suggestions ? { suggestions: [...new Set(suggestions as string[])] } : {}),
    };
  });
}

function relativeDirectory(value: unknown, field: string): string {
  return value === '.' ? '.' : relativePath(value, field);
}

function publicRun(run: InternalRun): LocalServerRunView {
  return {
    instanceId: run.instanceId,
    taskId: run.taskId,
    runId: run.runId,
    programId: run.programId,
    programName: run.programName,
    status: run.status,
    phase: run.phase,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    exitCode: run.exitCode,
    logs: [...run.logs],
    error: run.error,
  };
}

function buildMetadata(value: unknown): LocalServerBuildMetadata | undefined {
  if (!record(value) || typeof value.taskId !== 'string' || !OPAQUE_ID.test(value.taskId) ||
    !Number.isSafeInteger(value.builtAt) || Number(value.builtAt) <= 0) return undefined;
  const optional = ['sourceRef', 'commitSha', 'commitMessage'] as const;
  if (optional.some(key => value[key] !== undefined && (typeof value[key] !== 'string' || String(value[key]).length > 4096))) return undefined;
  if (value.commitSha !== undefined && !/^[0-9a-f]{40}$/i.test(String(value.commitSha))) return undefined;
  return {
    taskId: value.taskId,
    builtAt: Number(value.builtAt),
    ...(typeof value.sourceRef === 'string' ? { sourceRef: value.sourceRef } : {}),
    ...(typeof value.commitSha === 'string' ? { commitSha: value.commitSha } : {}),
    ...(typeof value.commitMessage === 'string' ? { commitMessage: value.commitMessage } : {}),
  };
}

async function defaultKillProcessTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await new Promise<void>(resolve => {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('close', () => resolve());
      killer.once('error', () => resolve());
    });
    return;
  }
  try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* already stopped */ } }
}

async function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function spawnRuntimeProcess(relativeExecutable: string, executablePath: string, args: string[], options: Parameters<typeof spawn>[2]): ChildProcess {
  const lower = relativeExecutable.toLowerCase();
  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', executablePath, ...args], options);
  if (lower.endsWith('.ps1')) return spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', executablePath, ...args], options);
  return spawn(executablePath, args, options);
}

export class LocalServerSupervisor {
  private readonly runs = new Map<string, InternalRun>();
  private readonly statePath: string;
  private readonly runtime: LocalServerRuntime;
  private readonly preparedDirs = new Map<string, { taskId: string; runDir: string; baselineDir?: string; configFingerprint?: string; build?: LocalServerBuildMetadata }>();
  private readonly configDirectories = new Map<string, string>();
  private readonly configValues = new Map<string, Map<string, string>>();
  private writeChain: Promise<void> = Promise.resolve();
  private loaded = false;

  constructor(private readonly deps: LocalServerSupervisorDeps) {
    this.statePath = path.join(deps.userDataPath, 'local-server-supervisor.json');
    this.runtime = new LocalServerRuntime({
      tempRoot: () => path.join(deps.userDataPath, 'local-server-runtimes'),
      downloadArtifact: deps.downloadArtifact,
    });
  }

  async init(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(await fs.readFile(this.statePath, 'utf8')) as unknown;
      if (!record(parsed) || !Array.isArray(parsed.runs)) return;
      if (Array.isArray(parsed.configDirectories)) {
        for (const item of parsed.configDirectories) {
          if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string' || !OPAQUE_ID.test(item[0]) ||
            typeof item[1] !== 'string' || !path.isAbsolute(item[1]) || item[1].includes('\0')) continue;
          this.configDirectories.set(item[0], item[1]);
        }
      }
      if (Array.isArray(parsed.configValues)) {
        for (const item of parsed.configValues) {
          if (!Array.isArray(item) || item.length !== 3 || typeof item[0] !== 'string' || !OPAQUE_ID.test(item[0]) ||
            typeof item[1] !== 'string' || !CONFIG_INPUT_ID.test(item[1]) || typeof item[2] !== 'string' || item[2].length > 4096 || item[2].includes('\0')) continue;
          const values = this.configValues.get(item[0]) ?? new Map<string, string>();
          values.set(item[1], item[2]);
          this.configValues.set(item[0], values);
        }
      }
      for (const raw of parsed.runs) {
        if (!record(raw) || typeof raw.instanceId !== 'string' || typeof raw.taskId !== 'string' || typeof raw.runId !== 'string') continue;
        if (!OPAQUE_ID.test(raw.instanceId) || !OPAQUE_ID.test(raw.taskId) || !OPAQUE_ID.test(raw.runId)) continue;
        const pid = typeof raw.pid === 'number' && Number.isSafeInteger(raw.pid) ? raw.pid : undefined;
        if (pid) await (this.deps.killProcessTree ?? defaultKillProcessTree)(pid).catch(() => undefined);
        if (typeof raw.runDir !== 'string' || !raw.runDir || !await this.isPreparedDirectory(raw.runDir)) continue;
        const program = typeof raw.programId === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(raw.programId) ? raw.programId : 'default';
        const restored: InternalRun = {
          instanceId: raw.instanceId,
          taskId: raw.taskId,
          runId: raw.runId,
          programId: program,
          programName: typeof raw.programName === 'string' ? raw.programName.slice(0, 128) : program,
          status: 'stopped',
          phase: 'ready',
          logs: Array.isArray(raw.logs) ? raw.logs.filter(item => typeof item === 'string').slice(-MAX_LOG_LINES) : [],
          runDir: raw.runDir,
          baselineDir: typeof raw.baselineDir === 'string' && await this.isPreparedDirectory(raw.baselineDir) ? raw.baselineDir : undefined,
          port: typeof raw.port === 'number' && Number.isSafeInteger(raw.port) ? raw.port : undefined,
          build: buildMetadata(raw.build),
        };
        this.append(restored, '已恢复本地服务器文件，残留进程已停止');
        this.runs.set(this.key(restored.instanceId, program), restored);
        this.preparedDirs.set(`${restored.instanceId}:${restored.taskId}`, { taskId: restored.taskId, runDir: restored.runDir, baselineDir: restored.baselineDir, build: restored.build, configFingerprint: typeof raw.configFingerprint === 'string' ? raw.configFingerprint : undefined });
      }
      await this.persist();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') await this.persist();
    }
  }

  async prepare(instanceId: string, taskId: string, selectedProgramId = 'default'): Promise<LocalServerRunView> {
    const contract = await this.deps.getRuntimeContract(instanceId);
    const spec = programSpecs(contract).find(item => item.id === selectedProgramId);
    if (!spec) throw new Error('Unknown local server program');
    return this.prepareProgram(instanceId, taskId, spec.id, contract);
  }

  async configure(instanceId: string, inputId?: string, value?: string): Promise<LocalServerDescription> {
    await this.init();
    if (!OPAQUE_ID.test(instanceId)) throw new Error('Invalid local server identity');
    const contract = await this.deps.getRuntimeContract(instanceId);
    const inputs = configInputs(contract);
    const selectedInput = inputs.find(input => input.id === (inputId || inputs.find(item => item.type === 'directory')?.id));
    if (!selectedInput) throw new Error('Unknown local server config input');
    let nextValue = value;
    if (selectedInput.type === 'directory') {
      if (value !== undefined) throw new Error('目录配置必须通过系统选择窗口设置');
      if (!this.deps.selectConfigDirectory) throw new Error('配置表目录选择能力不可用');
      const selected = await this.deps.selectConfigDirectory(instanceId, selectedInput.id, selectedInput.selectTitle || `选择${selectedInput.label}`);
      if (!selected) return this.describe(instanceId);
      const resolved = await fs.realpath(selected);
      const stat = await fs.stat(resolved);
      if (!stat.isDirectory()) throw new Error(`请选择${selectedInput.label}`);
      if ((await fs.readdir(resolved)).length === 0) throw new Error(`${selectedInput.label}不能为空`);
      nextValue = resolved;
    } else if (typeof value !== 'string' || value.length > 4096 || value.includes('\0') || (selectedInput.required && !value.trim())) {
      throw new Error(`${selectedInput.label}无效`);
    }
    const values = this.configValues.get(instanceId) ?? new Map<string, string>();
    values.set(selectedInput.id, nextValue ?? '');
    this.configValues.set(instanceId, values);
    if (selectedInput.type === 'directory') this.configDirectories.set(instanceId, nextValue!);
    await this.persist();
    return this.describe(instanceId);
  }

  async describe(instanceId: string): Promise<LocalServerDescription> {
    await this.init();
    const contract = await this.deps.getRuntimeContract(instanceId);
    const config = await this.configView(instanceId, contract);
    const specs = programSpecs(contract);
    const preparedRun = specs
      .map(spec => this.runs.get(this.key(instanceId, spec.id)))
      .filter((run): run is InternalRun => !!run?.runDir)
      .sort((left, right) => (right.build?.builtAt ?? 0) - (left.build?.builtAt ?? 0))[0];
    return {
      instanceId,
      ...config,
      prepared: !!preparedRun,
      ...(preparedRun ? { taskId: preparedRun.taskId, ...(preparedRun.build ? { build: preparedRun.build } : {}) } : {}),
      programs: specs.map(spec => {
        const run = this.runs.get(this.key(instanceId, spec.id));
        return run
          ? { id: spec.id, name: spec.name, prepared: !!run.runDir, status: run.status, phase: run.phase, runId: run.runId, taskId: run.taskId, logs: [...run.logs], error: run.error }
          : { id: spec.id, name: spec.name, prepared: false, status: 'stopped' as const };
      }),
    };
  }

  async prepareProgram(instanceId: string, taskId: string, selectedProgramId = 'default', suppliedContract?: RuntimeContract): Promise<LocalServerRunView> {
    await this.init();
    this.assertIdentity(instanceId, taskId);
    const contract = suppliedContract ?? await this.deps.getRuntimeContract(instanceId);
    const spec = programSpecs(contract).find(item => item.id === selectedProgramId);
    if (!spec) throw new Error('Unknown local server program');
    const key = this.key(instanceId, spec.id);
    const existing = this.runs.get(key);
    const reusable = [...this.runs.values()].find(item => item.instanceId === instanceId && item.taskId === taskId && item.runDir && item.status !== 'failed');
    if (existing && !['stopped', 'failed'].includes(existing.status)) throw new Error('A local server program is already active');
    if (existing?.runDir && existing.runDir !== reusable?.runDir && ![...this.runs.values()].some(item => item !== existing && item.runDir === existing.runDir)) await this.cleanupPrepared(existing.runDir, existing.baselineDir);
    const run: InternalRun = { instanceId, taskId, runId: randomUUID(), programId: spec.id, programName: spec.name, status: 'preparing', phase: 'downloading', logs: [], runDir: '' };
    this.runs.set(key, run);
    await this.persist();
    try {
      if (reusable?.runDir) {
        run.runDir = reusable.runDir;
        run.baselineDir = reusable.baselineDir;
        run.build = reusable.build;
        run.port = this.contractPort(spec.run);
        run.status = 'stopped';
        run.phase = 'ready';
        this.append(run, '复用已准备的本地运行目录');
        const configView = await this.configView(instanceId, contract);
        if (configView.configConfigured) {
          const values = new Map(configView.configInputs.map(input => [input.id, input.value]));
          await this.ensureConfigApplied(run, spec.config, this.primaryConfigDirectory(contract, values) ?? run.runDir, values);
        }
      } else {
        const preparedKey = `${instanceId}:${taskId}`;
        const preparedExisting = this.preparedDirs.get(preparedKey);
        if (preparedExisting) { run.runDir = preparedExisting.runDir; run.baselineDir = preparedExisting.baselineDir; run.build = preparedExisting.build; }
        else {
          const [artifactResult, metadata] = await Promise.all([
            this.deps.getArtifact(instanceId, taskId),
            this.deps.getBuildMetadata(instanceId, taskId),
          ]);
          if (artifactResult.taskId !== taskId || metadata.taskId !== taskId) throw new Error('构建产物与任务不匹配');
          const prepared = await this.runtime.prepare({ instanceId, taskId, artifact: artifactResult.artifact, runtimeContract: contract });
          run.runDir = prepared.runDir;
          run.build = metadata;
          run.baselineDir = `${prepared.runDir}-baseline`;
          await fs.cp(prepared.runDir, run.baselineDir, { recursive: true, errorOnExist: true });
          this.preparedDirs.set(preparedKey, { taskId, runDir: prepared.runDir, baselineDir: run.baselineDir, build: metadata });
        }
        for (const declaredProgram of programSpecs(contract)) {
          const executable = relativePath(declaredProgram.run.executable, 'run.executable');
          const executableStat = await fs.stat(path.resolve(run.runDir, executable)).catch(() => null);
          if (!executableStat?.isFile()) throw new Error(`构建产物缺少运行程序：${executable}`);
        }
        run.port = this.contractPort(spec.run);
        // Downloading a build is independent from local runtime inputs. Apply
        // declared config steps opportunistically when all inputs are already
        // configured; startup performs the mandatory validation again.
        const configView = await this.configView(instanceId, contract);
        if (configView.configConfigured) {
          const values = new Map(configView.configInputs.map(input => [input.id, input.value]));
          await this.runConfigAdapter(run, spec.config, this.primaryConfigDirectory(contract, values), values);
          const prepared = this.preparedDirs.get(preparedKey);
          if (prepared) prepared.configFingerprint = this.configFingerprint(values, spec.config);
        }
        run.status = 'stopped';
        run.phase = 'ready';
        this.append(run, '本地运行目录已准备');
      }
      await this.persist();
      return publicRun(run);
    } catch (error) {
      run.status = 'failed'; run.finishedAt = Date.now(); run.error = this.safeError(error); this.append(run, run.error); await this.persist();
      throw error;
    }
  }

  async startAll(instanceId: string, taskId?: string): Promise<LocalServerDescription> {
    const contract = await this.deps.getRuntimeContract(instanceId);
    const downloaded = await this.describe(instanceId);
    if (!downloaded.prepared || !downloaded.taskId) throw new Error('请先下载本地服务器');
    if (taskId && taskId !== downloaded.taskId) throw new Error('当前构建尚未下载到本地');
    try {
      for (const spec of programSpecs(contract)) {
        const run = this.runs.get(this.key(instanceId, spec.id));
        const effectiveTaskId = downloaded.taskId;
        if (!run || !effectiveTaskId || ['stopped', 'failed'].includes(run.status)) {
          if (!effectiveTaskId) throw new Error('Local server runtime is not prepared');
          await this.prepareProgram(instanceId, effectiveTaskId, spec.id, contract);
        }
        await this.start(instanceId, effectiveTaskId, spec.id);
      }
    } catch (error) {
      await this.stop(instanceId).catch(() => undefined);
      throw error;
    }
    return this.describe(instanceId);
  }

  async start(instanceId: string, taskId?: string, selectedProgramId = 'default'): Promise<LocalServerRunView> {
    await this.init();
    let run = this.runs.get(this.key(instanceId, selectedProgramId));
    if (!run && taskId) {
      const reusable = [...this.runs.values()].some(item => item.instanceId === instanceId && item.taskId === taskId && !!item.runDir);
      if (!reusable) throw new Error('请先下载本地服务器');
      await this.prepareProgram(instanceId, taskId, selectedProgramId);
      run = this.runs.get(this.key(instanceId, selectedProgramId));
    }
    if (!run || (taskId && run.taskId !== taskId)) throw new Error('Local server runtime is not prepared');
    if (run.status === 'running' || run.status === 'starting') return publicRun(run);
    if (run.status !== 'preparing' && run.status !== 'stopped' && run.status !== 'failed' && !run.runDir) throw new Error('Local server runtime is not prepared');
    const contract = await this.deps.getRuntimeContract(instanceId);
    const spec = programSpecs(contract).find(item => item.id === selectedProgramId);
    if (!spec) throw new Error('Unknown local server program');
    const runSpec = spec.run;
    const executable = relativePath(runSpec.executable, 'run.executable');
    const args = stringArray(runSpec.args, 'run.args');
    const workingDir = runSpec.workingDir === undefined ? '.' : relativeDirectory(runSpec.workingDir, 'run.workingDir');
    const executablePath = path.resolve(run.runDir, executable);
    const cwd = path.resolve(run.runDir, workingDir);
    if (!cwd.startsWith(`${run.runDir}${path.sep}`) && cwd !== run.runDir) throw new Error('Invalid runtime working directory');
    const configValues = await this.requireConfigInputs(instanceId, contract);
    const configRoot = this.primaryConfigDirectory(contract, configValues) ?? run.runDir;
    run.phase = 'configuring';
    try {
      await this.ensureConfigApplied(run, spec.config, configRoot, configValues);
      await this.ensureRunDirectories(run.runDir, spec.directories);
    } catch (error) {
      run.status = 'failed'; run.phase = 'failed'; run.error = this.safeError(error); run.finishedAt = Date.now();
      this.append(run, run.error); await this.persist();
      throw error;
    }
    run.status = 'starting'; run.phase = 'starting'; run.startedAt = Date.now(); run.finishedAt = undefined; run.error = undefined; run.exitCode = undefined; run.executablePath = executablePath;
    if (!run.port) run.port = Number.isSafeInteger(runSpec.port) && Number(runSpec.port) > 0 ? Number(runSpec.port) : await freeLoopbackPort();
    const env = {
      ...process.env,
      MCP_LOCAL_SERVER_RUN_DIR: run.runDir,
      MCP_LOCAL_SERVER_ARTIFACT_DIR: run.runDir,
      MCP_LOCAL_SERVER_CONFIG_ROOT: configRoot,
      MCP_LOCAL_SERVER_PORT: String(run.port),
    };
    const child = spawnRuntimeProcess(executable, executablePath, args, { cwd, env, windowsHide: true });
    run.child = child; run.pid = child.pid;
    this.attachOutput(run, child);
    const spawned = new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.once('close', (code, signal) => { run.exitCode = code; run.finishedAt = Date.now(); run.status = run.status === 'stopping' ? 'stopped' : code === 0 ? 'stopped' : 'failed'; run.phase = run.status; if (signal) this.append(run, `进程已结束 (${signal})`); void this.persist(); });
    try {
      await spawned;
      if (run.status !== 'starting') throw new Error('Local server process exited before becoming ready');
      if (spec.health) {
        run.phase = 'health_checking';
        await this.waitForHealth(run, spec.health);
      }
      if (run.status !== 'starting') throw new Error('Local server process exited before becoming ready');
      run.status = 'running'; run.phase = 'running';
    } catch (error) {
      run.status = 'failed'; run.phase = 'failed'; run.error = this.safeError(error); run.finishedAt = Date.now(); this.append(run, run.error);
      if (run.pid) await (this.deps.killProcessTree ?? defaultKillProcessTree)(run.pid);
      await this.persist();
      throw error;
    }
    await this.persist();
    return publicRun(run);
  }

  async stop(instanceId: string, selectedProgramId?: string): Promise<LocalServerRunView | LocalServerDescription> {
    await this.init();
    if (!selectedProgramId) {
      await Promise.all([...this.runs.keys()].filter(key => key.startsWith(`${instanceId}:`)).map(key => this.stop(instanceId, key.slice(instanceId.length + 1))));
      return this.describe(instanceId);
    }
    const run = this.runs.get(this.key(instanceId, selectedProgramId));
    if (!run) return { instanceId, taskId: '', runId: '', status: 'stopped', logs: [] };
    if (['stopped', 'failed'].includes(run.status)) return publicRun(run);
    run.status = 'stopping'; run.phase = 'stopping'; await this.persist();
    if (run.pid) await (this.deps.killProcessTree ?? defaultKillProcessTree)(run.pid);
    else run.child?.kill();
    return publicRun(run);
  }

  async status(instanceId: string, selectedProgramId?: string): Promise<LocalServerRunView | LocalServerDescription> {
    await this.init();
    if (!selectedProgramId) {
      const runs = [...this.runs.values()].filter(item => item.instanceId === instanceId);
      if (runs.length > 1) return this.describe(instanceId);
      const run = runs[0];
      return run ? publicRun(run) : { instanceId, taskId: '', runId: '', status: 'stopped', logs: [] };
    }
    const run = this.runs.get(this.key(instanceId, selectedProgramId));
    return run ? publicRun(run) : { instanceId, taskId: '', runId: '', status: 'stopped', logs: [] };
  }

  async logs(instanceId: string, selectedProgramId?: string): Promise<LocalServerRunView | LocalServerDescription> { return this.status(instanceId, selectedProgramId); }

  async stopAll(): Promise<void> {
    await this.init();
    await Promise.all([...new Set([...this.runs.values()].map(run => run.instanceId))].map(instanceId => this.stop(instanceId).catch(() => undefined)));
  }

  private key(instanceId: string, programId: string): string { return `${instanceId}:${programId}`; }
  private contractPort(runSpec: Record<string, unknown>): number {
    return Number.isSafeInteger(runSpec.port) && Number(runSpec.port) > 0 ? Number(runSpec.port) : 0;
  }

  private async ensureRunDirectories(runDir: string, value: unknown): Promise<void> {
    if (value === undefined) return;
    if (!Array.isArray(value) || value.length > 64) throw new Error('Invalid runtime contract run.directories');
    for (const item of value) {
      const directory = relativeDirectory(item, 'run.directories');
      const target = path.resolve(runDir, directory);
      await this.ensureRuntimeParent(runDir, directory === '.' ? 'runtime-directory' : `${directory}/.runtime-directory`);
      const existing = await fs.lstat(target).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      });
      if (!existing) await fs.mkdir(target);
      else if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error('Runtime contract run directory is not a managed directory');
    }
  }

  private attachOutput(run: InternalRun, child: ChildProcess): void {
    const consume = (stream: NodeJS.ReadableStream | null) => stream?.on('data', chunk => this.append(run, String(chunk).replace(/\r?\n/g, '').slice(0, 4096)));
    consume(child.stdout); consume(child.stderr);
  }

  private async runConfigAdapter(run: InternalRun, configSpec?: Record<string, unknown>, suppliedConfigRoot?: string, suppliedValues?: Map<string, string>): Promise<void> {
    const config = configSpec ?? null;
    if (!config) return;
    const contract = await this.deps.getRuntimeContract(run.instanceId);
    const values = suppliedValues ?? await this.requireConfigInputs(run.instanceId, contract);
    const configRoot = suppliedConfigRoot ?? this.primaryConfigDirectory(contract, values) ?? run.runDir;
    await this.runConfigSteps(run, config, configRoot, values);
    if (config.adapter === undefined) return;
    const executable = relativePath(config.adapter, 'config.adapter');
    const args = stringArray(config.args, 'config.args');
    const env = { ...process.env, MCP_LOCAL_SERVER_RUN_DIR: run.runDir, MCP_LOCAL_SERVER_ARTIFACT_DIR: run.runDir, MCP_LOCAL_SERVER_CONFIG_ROOT: configRoot, MCP_LOCAL_SERVER_CONFIG_VALUES: JSON.stringify(Object.fromEntries(values)), MCP_LOCAL_SERVER_PORT: String(run.port ?? 0) };
    const executablePath = path.resolve(run.runDir, executable);
    await new Promise<void>((resolve, reject) => {
      const child = spawnRuntimeProcess(executable, executablePath, args, { cwd: run.runDir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      this.attachOutput(run, child);
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve() : reject(new Error(`Config adapter exited with ${code ?? 'unknown status'}`)));
    });
  }

  private configFingerprint(values: Map<string, string>, configSpec?: Record<string, unknown>): string {
    return JSON.stringify({ values: [...values.entries()].sort(([left], [right]) => left.localeCompare(right)), config: configSpec ?? null });
  }

  private async ensureConfigApplied(run: InternalRun, configSpec: Record<string, unknown> | undefined, configRoot: string, values: Map<string, string>): Promise<void> {
    const prepared = this.preparedDirs.get(`${run.instanceId}:${run.taskId}`);
    const fingerprint = this.configFingerprint(values, configSpec);
    if (prepared?.configFingerprint === fingerprint) return;
    if (prepared?.baselineDir && await this.isPreparedDirectory(prepared.baselineDir)) {
      await fs.rm(run.runDir, { recursive: true, force: true });
      await fs.cp(prepared.baselineDir, run.runDir, { recursive: true, errorOnExist: true });
    }
    await this.runConfigAdapter(run, configSpec, configRoot, values);
    if (prepared) prepared.configFingerprint = fingerprint;
  }

  private async runConfigSteps(run: InternalRun, config: Record<string, unknown>, configRoot: string, values: Map<string, string>): Promise<void> {
    if (config.steps === undefined) return;
    if (!Array.isArray(config.steps) || config.steps.length > MAX_CONFIG_STEPS) throw new Error('Invalid runtime contract config.steps');
    for (let index = 0; index < config.steps.length; index += 1) {
      const step = config.steps[index];
      if (!record(step) || typeof step.type !== 'string') throw new Error(`Invalid runtime contract config.steps[${index}]`);
      if (step.type === 'mount-config') {
        const target = relativePath(step.target, `config.steps[${index}].target`);
        const mode = step.mode === undefined ? 'junction' : step.mode;
        if (mode !== 'junction' && mode !== 'copy') throw new Error(`Invalid runtime contract config.steps[${index}].mode`);
        const source = step.inputId === undefined ? configRoot : this.configStepValue(step, values, index, 'inputId');
        const sourceStat = await fs.stat(source).catch(() => null);
        if (!sourceStat?.isDirectory()) throw new Error(`Runtime config directory is invalid for config.steps[${index}]`);
        const targetPath = path.resolve(run.runDir, target);
        await this.ensureRuntimeParent(run.runDir, target);
        const existing = await fs.lstat(targetPath).catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw error;
        });
        if (existing?.isSymbolicLink() && mode === 'junction') {
          const [linked, selected] = await Promise.all([fs.realpath(targetPath), fs.realpath(source)]);
          if (path.resolve(linked) === path.resolve(selected)) continue;
        }
        if (existing?.isSymbolicLink()) await fs.unlink(targetPath);
        else if (existing) await fs.rm(targetPath, { recursive: true, force: true });
        if (mode === 'copy') await fs.cp(source, targetPath, { recursive: true, force: false, errorOnExist: true });
        else await fs.symlink(source, targetPath, (this.deps.platform ?? process.platform) === 'win32' ? 'junction' : 'dir');
        continue;
      }
      if (step.type === 'set-toml') {
        const target = relativePath(step.path, `config.steps[${index}].path`);
        const key = typeof step.key === 'string' ? step.key : '';
        const keyParts = key.split('.');
        if (!key || key.length > 512 || keyParts.length > 16 || keyParts.some(part => !/^[A-Za-z0-9_-]{1,64}$/.test(part))) {
          throw new Error(`Invalid runtime contract config.steps[${index}].key`);
        }
        const stepValue = step.valueFrom === undefined ? step.value : this.configStepValue(step, values, index, 'valueFrom');
        if (!['string', 'number', 'boolean'].includes(typeof stepValue)) throw new Error(`Invalid runtime contract config.steps[${index}].value`);
        const targetPath = path.resolve(run.runDir, target);
        const realTarget = await fs.realpath(targetPath);
        const resolvedRunDir = path.resolve(run.runDir);
        if (!realTarget.startsWith(`${resolvedRunDir}${path.sep}`)) throw new Error('Runtime config target escapes the managed directory');
        const stat = await fs.stat(realTarget);
        if (!stat.isFile() || stat.size > MAX_CONFIG_FILE_BYTES) throw new Error('Runtime TOML config file is invalid');
        const parsed: unknown = parseToml(await fs.readFile(realTarget, 'utf8'));
        if (!record(parsed)) throw new Error('Runtime TOML config root must be a table');
        let cursor = parsed;
        for (const part of keyParts.slice(0, -1)) {
          const next = cursor[part];
          if (next === undefined) cursor[part] = {};
          else if (!record(next)) throw new Error(`Runtime TOML key is not a table: ${part}`);
          cursor = cursor[part] as Record<string, unknown>;
        }
        cursor[keyParts.at(-1)!] = stepValue;
        const temporary = `${realTarget}.${process.pid}.${randomUUID()}.tmp`;
        await fs.writeFile(temporary, stringifyToml(parsed), { mode: stat.mode });
        await fs.rename(temporary, realTarget).catch(async error => {
          await fs.rm(temporary, { force: true });
          throw error;
        });
        continue;
      }
      if (step.type === 'replace-text') {
        const target = relativePath(step.path, `config.steps[${index}].path`);
        if (typeof step.find !== 'string' || !step.find || step.find.length > 4096 || step.find.includes('\0')) throw new Error(`Invalid runtime contract config.steps[${index}].find`);
        const replacement = step.valueFrom === undefined ? step.value : this.configStepValue(step, values, index, 'valueFrom');
        if (typeof replacement !== 'string' || replacement.length > 4096 || replacement.includes('\0')) throw new Error(`Invalid runtime contract config.steps[${index}].value`);
        await this.replaceTextInTarget(run.runDir, target, step.find, replacement, step.recursive === true);
        continue;
      }
      throw new Error(`Unsupported runtime contract config step: ${step.type}`);
    }
  }

  private configStepValue(step: Record<string, unknown>, values: Map<string, string>, index: number, field: 'inputId' | 'valueFrom'): string {
    const id = step[field];
    if (typeof id !== 'string' || !CONFIG_INPUT_ID.test(id) || !values.has(id)) throw new Error(`Invalid runtime contract config.steps[${index}].${field}`);
    return values.get(id)!;
  }

  private async replaceTextInTarget(runDir: string, target: string, find: string, replacement: string, recursive: boolean): Promise<void> {
    const root = path.resolve(runDir);
    const targetPath = path.resolve(runDir, target);
    const realTarget = await fs.realpath(targetPath);
    if (realTarget !== root && !realTarget.startsWith(`${root}${path.sep}`)) throw new Error('Runtime config target escapes the managed directory');
    let visited = 0;
    const visit = async (current: string): Promise<void> => {
      if (++visited > 2048) throw new Error('Runtime text replacement exceeds file limit');
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) return;
      if (stat.isDirectory()) {
        if (!recursive && current === realTarget) throw new Error('Runtime text replacement directory requires recursive=true');
        for (const entry of await fs.readdir(current)) await visit(path.join(current, entry));
        return;
      }
      if (!stat.isFile()) return;
      if (stat.size > MAX_CONFIG_FILE_BYTES) throw new Error('Runtime text config file is too large');
      const buffer = await fs.readFile(current);
      if (buffer.includes(0)) return;
      const content = buffer.toString('utf8');
      const updated = content.split(find).join(replacement);
      if (updated === content) return;
      const temporary = `${current}.${process.pid}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, updated, { mode: stat.mode });
      await fs.rename(temporary, current).catch(async error => { await fs.rm(temporary, { force: true }); throw error; });
    };
    await visit(realTarget);
  }

  private async ensureRuntimeParent(runDir: string, relativeTarget: string): Promise<void> {
    const parts = relativeTarget.replace(/\\/g, '/').split('/').slice(0, -1);
    let current = path.resolve(runDir);
    for (const part of parts) {
      current = path.join(current, part);
      const stat = await fs.lstat(current).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      });
      if (!stat) await fs.mkdir(current);
      else if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Runtime config target parent is not a managed directory');
    }
  }

  private async waitForHealth(run: InternalRun, health: Record<string, unknown>): Promise<void> {
    if (health.type !== 'http' || typeof health.path !== 'string' || !health.path.startsWith('/') || health.path.length > 1024 || /[\r\n]/.test(health.path)) {
      throw new Error('Invalid runtime contract health check');
    }
    const timeoutMs = Number.isSafeInteger(health.timeoutMs) ? Math.min(120_000, Math.max(1_000, Number(health.timeoutMs))) : 30_000;
    const deadline = Date.now() + timeoutMs;
    const url = `http://127.0.0.1:${run.port}${health.path}`;
    while (Date.now() < deadline && run.status === 'starting') {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
        if (response.ok) return;
      } catch { /* server is still starting */ }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error('Local server health check timed out');
  }

  private append(run: InternalRun, line: string): void {
    const value = String(line);
    let bytes = 0;
    let end = 0;
    for (const char of value) {
      const size = Buffer.byteLength(char, 'utf8');
      if (bytes + size > 16 * 1024) break;
      bytes += size;
      end += char.length;
    }
    run.logs.push(value.slice(0, end));
    if (run.logs.length > MAX_LOG_LINES) run.logs.splice(0, run.logs.length - MAX_LOG_LINES);
  }
  private safeError(error: unknown): string { return error instanceof Error ? error.message.slice(0, 1000) : 'Local server failed'; }
  private assertIdentity(instanceId: string, taskId: string): void { if (!OPAQUE_ID.test(instanceId) || !OPAQUE_ID.test(taskId)) throw new Error('Invalid local server identity'); }
  private async isPreparedDirectory(runDir: string): Promise<boolean> {
    const root = path.resolve(this.deps.userDataPath, 'local-server-runtimes');
    const resolved = path.resolve(runDir);
    if (!resolved.startsWith(`${root}${path.sep}`)) return false;
    try { return (await fs.stat(resolved)).isDirectory(); } catch { return false; }
  }
  private async cleanupPrepared(runDir: string, baselineDir?: string): Promise<void> {
    await this.runtime.cleanup(runDir).catch(() => undefined);
    if (baselineDir) await fs.rm(baselineDir, { recursive: true, force: true }).catch(() => undefined);
  }
  private async configView(instanceId: string, contract: RuntimeContract): Promise<{ configConfigured: boolean; configLabel?: string; configInputs: LocalServerConfigInputView[] }> {
    const definitions = configInputs(contract);
    const stored = this.configValues.get(instanceId) ?? new Map<string, string>();
    const legacy = this.configDirectories.get(instanceId);
    const views: LocalServerConfigInputView[] = [];
    for (const definition of definitions) {
      let value = stored.get(definition.id) ?? definition.defaultValue ?? '';
      if (!value && definition.type === 'directory' && legacy) value = legacy;
      let configured = !definition.required || !!value.trim();
      if (configured && definition.type === 'directory') {
        try { configured = (await fs.stat(value)).isDirectory() && (await fs.readdir(value)).length > 0; } catch { configured = false; }
      }
      views.push({
        id: definition.id, type: definition.type, label: definition.label, required: definition.required, configured,
        value, ...(definition.placeholder ? { placeholder: definition.placeholder } : {}),
        ...(definition.suggestions?.length ? { suggestions: definition.suggestions } : {}),
      });
    }
    const firstDirectory = views.find(input => input.type === 'directory' && input.value);
    return {
      configConfigured: views.every(input => input.configured),
      ...(firstDirectory ? { configLabel: path.basename(firstDirectory.value) || firstDirectory.value } : {}),
      configInputs: views,
    };
  }
  private async requireConfigInputs(instanceId: string, contract: RuntimeContract): Promise<Map<string, string>> {
    const view = await this.configView(instanceId, contract);
    const invalid = view.configInputs.find(input => !input.configured);
    if (invalid) throw new Error(`请先配置${invalid.label}`);
    return new Map(view.configInputs.map(input => [input.id, input.value]));
  }
  private primaryConfigDirectory(contract: RuntimeContract, values: Map<string, string>): string | undefined {
    const input = configInputs(contract).find(item => item.type === 'directory');
    return input ? values.get(input.id) : undefined;
  }
  private async persist(): Promise<void> {
    this.writeChain = this.writeChain.then(async () => { await fs.mkdir(path.dirname(this.statePath), { recursive: true }); const tmp = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`; const rows = [...this.runs.values()].map(run => { const prepared = this.preparedDirs.get(`${run.instanceId}:${run.taskId}`); return { ...publicRun(run), runDir: run.runDir, baselineDir: run.baselineDir, configFingerprint: prepared?.configFingerprint, pid: run.pid, executablePath: run.executablePath, port: run.port, build: run.build }; }); const configValues = [...this.configValues].flatMap(([instanceId, values]) => [...values].map(([inputId, value]) => [instanceId, inputId, value])); await fs.writeFile(tmp, JSON.stringify({ runs: rows, configDirectories: [...this.configDirectories.entries()], configValues }), { mode: 0o600 }); await fs.rename(tmp, this.statePath).catch(async error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' && (error as NodeJS.ErrnoException).code !== 'EPERM') throw error; await fs.copyFile(tmp, this.statePath); await fs.rm(tmp, { force: true }); }); });
    return this.writeChain;
  }
}
