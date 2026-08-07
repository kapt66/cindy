import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { create as createTar } from 'tar';
import { describe, expect, it } from 'vitest';
import { parse as parseToml } from 'smol-toml';

import {
  LocalServerRuntime,
  type LocalServerArtifactDescriptor,
} from '../localServerRuntime';
import { LocalServerSupervisor } from '../localServerSupervisor';

async function makeArtifact(): Promise<{ bytes: Buffer; descriptor: LocalServerArtifactDescriptor }> {
  const source = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-runtime-source-'));
  await fs.mkdir(path.join(source, '.mcp-runtime'), { recursive: true });
  await fs.writeFile(path.join(source, '.mcp-runtime', 'runtime-manifest.json'), JSON.stringify({ apiVersion: 1, runtimeType: 'test' }));
  await fs.writeFile(path.join(source, 'server.bin'), Buffer.from('server'));
  const archive = path.join(source, 'artifact.tar.gz');
  await createTar({ gzip: true, file: archive, cwd: source }, ['.mcp-runtime', 'server.bin']);
  const bytes = await fs.readFile(archive);
  return {
    bytes,
    descriptor: { fileName: 'artifact.tar.gz', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), expiresAt: Date.now() + 60_000 },
  };
}

describe('LocalServerRuntime', () => {
  it('streams, verifies and extracts an artifact into an isolated directory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-runtime-test-'));
    const artifact = await makeArtifact();
    const runtime = new LocalServerRuntime({
      tempRoot: () => root,
      downloadArtifact: async () => new Response(artifact.bytes as unknown as BodyInit),
    });

    const prepared = await runtime.prepare({ instanceId: 'instance-1', taskId: 'task-1', artifact: artifact.descriptor });
    expect(prepared.manifest).toMatchObject({ apiVersion: 1, runtimeType: 'test' });
    await expect(fs.readFile(path.join(prepared.runDir, 'server.bin'))).resolves.toEqual(Buffer.from('server'));
    await runtime.cleanup(prepared.runDir);
    await expect(fs.stat(prepared.runDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes the temporary run directory when digest verification fails', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-runtime-test-'));
    const artifact = await makeArtifact();
    await expect(new LocalServerRuntime({
      tempRoot: () => root,
      downloadArtifact: async () => new Response(artifact.bytes as unknown as BodyInit),
    }).prepare({
      instanceId: 'instance-1', taskId: 'task-1',
      artifact: { ...artifact.descriptor, sha256: '0'.repeat(64) },
    })).rejects.toThrow('digest or size mismatch');
    expect((await fs.readdir(root))).toEqual([]);
  });

  it('downloads indexed files individually without requiring an archive', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-runtime-test-'));
    const manifest = Buffer.from(JSON.stringify({ apiVersion: 1, runtimeType: 'indexed' }));
    const server = Buffer.from('server');
    const files = [
      { path: '.mcp-runtime/runtime-manifest.json', data: manifest },
      { path: 'server.bin', data: server },
    ];
    const indexedFiles = files.map(file => ({ path: file.path, size: file.data.length, sha256: createHash('sha256').update(file.data).digest('hex') }));
    const descriptor = {
      fileName: 'artifact-manifest', size: manifest.length + server.length,
      sha256: createHash('sha256').update(indexedFiles.slice().sort((a, b) => a.path.localeCompare(b.path)).map(file => `${file.path}\0${file.sha256}\0${file.size}`).join('\n')).digest('hex'), expiresAt: Date.now() + 60_000,
      files: indexedFiles,
    };
    const runtime = new LocalServerRuntime({
      tempRoot: () => root,
      downloadArtifact: async (_instance, _task, relativePath) => new Response(files.find(file => file.path === relativePath)?.data as unknown as BodyInit),
    });
    const prepared = await runtime.prepare({ instanceId: 'instance-1', taskId: 'task-1', artifact: descriptor });
    expect(prepared.manifest).toMatchObject({ runtimeType: 'indexed' });
    await expect(fs.readFile(path.join(prepared.runDir, 'server.bin'))).resolves.toEqual(server);
  });

  it('uses the template contract supplied by Host without requiring a repository manifest', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-runtime-test-'));
    const server = Buffer.from('server');
    const file = { path: 'server.bin', size: server.length, sha256: createHash('sha256').update(server).digest('hex') };
    const descriptor = {
      fileName: 'artifact-manifest', size: server.length,
      sha256: createHash('sha256').update(`${file.path}\0${file.sha256}\0${file.size}`).digest('hex'), expiresAt: Date.now() + 60_000,
      files: [file],
    };
    const runtime = new LocalServerRuntime({
      tempRoot: () => root,
      downloadArtifact: async () => new Response(server as unknown as BodyInit),
    });
    const prepared = await runtime.prepare({ instanceId: 'instance-1', taskId: 'task-1', artifact: descriptor, runtimeContract: { apiVersion: 1, run: { executable: 'server.bin' } } });
    expect(prepared.manifest).toMatchObject({ apiVersion: 1, run: { executable: 'server.bin' } });
  });

  it('creates the managed runtime parent before creating an isolated directory', async () => {
    const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-runtime-parent-'));
    const root = path.join(userData, 'missing', 'local-server-runtimes');
    const artifact = await makeArtifact();
    const runtime = new LocalServerRuntime({
      tempRoot: () => root,
      downloadArtifact: async () => new Response(artifact.bytes as unknown as BodyInit),
    });

    const prepared = await runtime.prepare({ instanceId: 'instance-1', taskId: 'task-1', artifact: artifact.descriptor });
    await expect(fs.stat(prepared.runDir)).resolves.toMatchObject({});
  });

  it('requires a non-empty config directory and restores downloaded build identity after restart', async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-supervisor-test-'));
    const configPath = path.join(userDataPath, 'tables');
    await fs.mkdir(configPath);
    await fs.writeFile(path.join(configPath, 'table.json'), '{}');
    const server = Buffer.from('server');
    const file = { path: 'server.exe', size: server.length, sha256: createHash('sha256').update(server).digest('hex') };
    const artifact = {
      fileName: 'artifact-manifest', size: server.length,
      sha256: createHash('sha256').update(`${file.path}\0${file.sha256}\0${file.size}`).digest('hex'),
      expiresAt: Date.now() + 60_000, files: [file],
    };
    const deps = {
      userDataPath,
      downloadArtifact: async () => new Response(server as unknown as BodyInit),
      getArtifact: async () => ({ taskId: 'task-1', artifact }),
      getBuildMetadata: async () => ({ taskId: 'task-1', builtAt: 1_722_862_800_000, commitSha: 'a'.repeat(40), commitMessage: 'Build local server' }),
      getRuntimeContract: async () => ({ apiVersion: 1, run: { programs: [{ id: 'server', name: 'Server', executable: 'server.exe' }] } }),
      selectConfigDirectory: async () => configPath,
    };
    const supervisor = new LocalServerSupervisor(deps);

    await supervisor.prepare('instance-1', 'task-1', 'server');
    await expect(supervisor.describe('instance-1')).resolves.toMatchObject({ configConfigured: false, prepared: true, programs: [{ prepared: true, status: 'stopped' }] });
    await expect(supervisor.start('instance-1', 'task-1', 'server')).rejects.toThrow('请先配置配置表位置');
    await supervisor.configure('instance-1');
    await supervisor.prepare('instance-1', 'task-1', 'server');
    await expect(supervisor.describe('instance-1')).resolves.toMatchObject({
      configConfigured: true,
      configLabel: 'tables',
      prepared: true,
      taskId: 'task-1',
      build: { commitSha: 'a'.repeat(40), commitMessage: 'Build local server' },
      programs: [{ id: 'server', prepared: true, status: 'stopped', phase: 'ready' }],
    });

    const restored = new LocalServerSupervisor(deps);
    await expect(restored.describe('instance-1')).resolves.toMatchObject({
      configConfigured: true,
      prepared: true,
      build: { taskId: 'task-1', builtAt: 1_722_862_800_000 },
      programs: [{ id: 'server', prepared: true, status: 'stopped' }],
    });
  });

  it('rejects a downloaded artifact when a contract entry executable is missing', async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-missing-program-test-'));
    const server = Buffer.from('server');
    const file = { path: 'server.exe', size: server.length, sha256: createHash('sha256').update(server).digest('hex') };
    const artifact = {
      fileName: 'artifact-manifest', size: file.size,
      sha256: createHash('sha256').update(`${file.path}\0${file.sha256}\0${file.size}`).digest('hex'),
      expiresAt: Date.now() + 60_000, files: [file],
    };
    const supervisor = new LocalServerSupervisor({
      userDataPath,
      downloadArtifact: async () => new Response(server as unknown as BodyInit),
      getArtifact: async () => ({ taskId: 'task-1', artifact }),
      getBuildMetadata: async () => ({ taskId: 'task-1', builtAt: Date.now() }),
      getRuntimeContract: async () => ({ apiVersion: 1, run: { programs: [
        { id: 'server', executable: 'server.exe' },
        { id: 'missing', executable: 'missing.exe' },
      ] } }),
    });

    await expect(supervisor.prepare('instance-1', 'task-1', 'server')).rejects.toThrow('构建产物缺少运行程序：missing.exe');
  });

  it('describes the newest prepared build and ignores programs removed from the contract', async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-current-build-test-'));
    const oldDir = path.join(userDataPath, 'local-server-runtimes', 'runtime-instance-1-old');
    const newDir = path.join(userDataPath, 'local-server-runtimes', 'runtime-instance-1-new');
    await fs.mkdir(oldDir, { recursive: true });
    await fs.mkdir(newDir, { recursive: true });
    await fs.writeFile(path.join(newDir, 'server.exe'), 'server');
    await fs.writeFile(path.join(userDataPath, 'local-server-supervisor.json'), JSON.stringify({
      runs: [
        { instanceId: 'instance-1', taskId: 'task-old', runId: 'run-old', programId: 'removed', programName: 'removed', status: 'stopped', logs: [], runDir: oldDir, build: { taskId: 'task-old', builtAt: 200 } },
        { instanceId: 'instance-1', taskId: 'task-new', runId: 'run-new', programId: 'server', programName: 'server', status: 'stopped', logs: [], runDir: newDir, build: { taskId: 'task-new', builtAt: 300, commitSha: 'a'.repeat(40) } },
      ],
      configDirectories: [],
      configValues: [],
    }));
    const supervisor = new LocalServerSupervisor({
      userDataPath,
      downloadArtifact: async () => new Response(),
      getArtifact: async () => { throw new Error('not used'); },
      getBuildMetadata: async () => { throw new Error('not used'); },
      getRuntimeContract: async () => ({ apiVersion: 1, run: { programs: [{ id: 'server', executable: 'server.exe' }] } }),
    });

    await expect(supervisor.describe('instance-1')).resolves.toMatchObject({
      taskId: 'task-new',
      build: { taskId: 'task-new', builtAt: 300, commitSha: 'a'.repeat(40) },
      programs: [{ id: 'server', taskId: 'task-new' }],
    });
  });

  it('applies template-declared config steps without exposing project-specific logic', async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-config-steps-test-'));
    const configPath = path.join(userDataPath, 'selected-config');
    await fs.mkdir(configPath);
    await fs.writeFile(path.join(configPath, 'table.json'), '{"id":1}');
    const files = [
      { path: 'server.exe', data: Buffer.from('server') },
      { path: 'etc/common/common.toml', data: Buffer.from('[base]\ndatapath = ""\n[network]\nport = 9000\n') },
      { path: 'etc/data/original.txt', data: Buffer.from('original') },
    ];
    const indexedFiles = files.map(file => ({ path: file.path, size: file.data.length, sha256: createHash('sha256').update(file.data).digest('hex') }));
    const artifact = {
      fileName: 'artifact-manifest', size: indexedFiles.reduce((total, file) => total + file.size, 0),
      sha256: createHash('sha256').update(indexedFiles.slice().sort((a, b) => a.path.localeCompare(b.path)).map(file => `${file.path}\0${file.sha256}\0${file.size}`).join('\n')).digest('hex'),
      expiresAt: Date.now() + 60_000, files: indexedFiles,
    };
    const contract = {
      apiVersion: 1,
      run: { programs: [{ id: 'server', executable: 'server.exe' }] },
      config: { steps: [
        { type: 'set-toml', path: 'etc/common/common.toml', key: 'base.datapath', value: 'etc/data/tables' },
        { type: 'mount-config', target: 'etc/data/tables', mode: 'junction' },
      ] },
    };
    const supervisor = new LocalServerSupervisor({
      userDataPath,
      downloadArtifact: async (_instance, _task, relativePath) => new Response(files.find(file => file.path === relativePath)?.data as unknown as BodyInit),
      getArtifact: async () => ({ taskId: 'task-1', artifact }),
      getBuildMetadata: async () => ({ taskId: 'task-1', builtAt: Date.now() }),
      getRuntimeContract: async () => contract,
      selectConfigDirectory: async () => configPath,
    });

    await supervisor.configure('instance-1');
    await supervisor.prepare('instance-1', 'task-1', 'server');
    const runtimeRoot = path.join(userDataPath, 'local-server-runtimes');
    const [runtimeName] = await fs.readdir(runtimeRoot);
    const runDir = path.join(runtimeRoot, runtimeName);
    const configured = parseToml(await fs.readFile(path.join(runDir, 'etc/common/common.toml'), 'utf8')) as { base: { datapath: string }; network: { port: number } };
    expect(configured).toMatchObject({ base: { datapath: 'etc/data/tables' }, network: { port: 9000 } });
    await expect(fs.realpath(path.join(runDir, 'etc/data/tables'))).resolves.toBe(await fs.realpath(configPath));
    await expect(fs.readFile(path.join(runDir, 'etc/data/tables/table.json'), 'utf8')).resolves.toBe('{"id":1}');
  });

  it('persists template-declared directory and text inputs and applies text replacement', async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-config-inputs-test-'));
    const configPath = path.join(userDataPath, 'saga2_json');
    await fs.mkdir(configPath);
    await fs.writeFile(path.join(configPath, 'table.json'), '{"id":1}');
    const files = [
      { path: 'server.exe', data: Buffer.from('server') },
      { path: 'etc/common/common.toml', data: Buffer.from('[base]\ndatapath = ""\n[redis]\naddr = "[[REDIS_ADDR]]"\n') },
      { path: 'etc/other.toml', data: Buffer.from('addr = "[[REDIS_ADDR]]"\n') },
    ];
    const indexedFiles = files.map(file => ({ path: file.path, size: file.data.length, sha256: createHash('sha256').update(file.data).digest('hex') }));
    const artifact = {
      fileName: 'artifact-manifest', size: indexedFiles.reduce((total, file) => total + file.size, 0),
      sha256: createHash('sha256').update(indexedFiles.slice().sort((a, b) => a.path.localeCompare(b.path)).map(file => `${file.path}\0${file.sha256}\0${file.size}`).join('\n')).digest('hex'),
      expiresAt: Date.now() + 60_000, files: indexedFiles,
    };
    const contract = {
      apiVersion: 1,
      run: { programs: [{ id: 'server', executable: 'server.exe' }] },
      config: {
        inputs: [
          { id: 'databaseAddress', type: 'text', label: '数据库地址', default: 'localhost:13000', suggestions: ['localhost:13000'], required: true },
          { id: 'dataTables', type: 'directory', label: '配置表位置', required: true },
        ],
        steps: [
          { type: 'set-toml', path: 'etc/common/common.toml', key: 'base.datapath', value: 'etc/data/saga2_json' },
          { type: 'replace-text', path: 'etc', find: '[[REDIS_ADDR]]', valueFrom: 'databaseAddress', recursive: true },
          { type: 'mount-config', inputId: 'dataTables', target: 'etc/data/saga2_json', mode: 'junction' },
        ],
      },
    };
    const deps = {
      userDataPath,
      downloadArtifact: async (_instance: string, _task: string, relativePath?: string) => new Response(files.find(file => file.path === relativePath)?.data as unknown as BodyInit),
      getArtifact: async () => ({ taskId: 'task-1', artifact }),
      getBuildMetadata: async () => ({ taskId: 'task-1', builtAt: Date.now() }),
      getRuntimeContract: async () => contract,
      selectConfigDirectory: async () => configPath,
    };
    const supervisor = new LocalServerSupervisor(deps);

    await expect(supervisor.describe('instance-1')).resolves.toMatchObject({
      configConfigured: false,
      configInputs: [
        { id: 'databaseAddress', configured: true, value: 'localhost:13000', suggestions: ['localhost:13000'] },
        { id: 'dataTables', configured: false, value: '' },
      ],
    });
    await supervisor.configure('instance-1', 'dataTables');
    await supervisor.configure('instance-1', 'databaseAddress', '127.0.0.1:13000');
    await supervisor.prepare('instance-1', 'task-1', 'server');

    const runtimeRoot = path.join(userDataPath, 'local-server-runtimes');
    const [runtimeName] = await fs.readdir(runtimeRoot);
    const runDir = path.join(runtimeRoot, runtimeName);
    const common = await fs.readFile(path.join(runDir, 'etc/common/common.toml'), 'utf8');
    const other = await fs.readFile(path.join(runDir, 'etc/other.toml'), 'utf8');
    expect(common).toContain('datapath = "etc/data/saga2_json"');
    expect(common).toContain('addr = "127.0.0.1:13000"');
    expect(other).toContain('addr = "127.0.0.1:13000"');
    await expect(fs.realpath(path.join(runDir, 'etc/data/saga2_json'))).resolves.toBe(await fs.realpath(configPath));

    await supervisor.configure('instance-1', 'databaseAddress', 'localhost:13000');
    await supervisor.prepare('instance-1', 'task-1', 'server');
    expect(await fs.readFile(path.join(runDir, 'etc/common/common.toml'), 'utf8')).toContain('addr = "localhost:13000"');
    expect(await fs.readFile(path.join(runDir, 'etc/other.toml'), 'utf8')).toContain('addr = "localhost:13000"');

    const restored = new LocalServerSupervisor(deps);
    await expect(restored.describe('instance-1')).resolves.toMatchObject({
      configConfigured: true,
      configInputs: [
        { id: 'databaseAddress', value: 'localhost:13000' },
        { id: 'dataTables', value: configPath },
      ],
    });
  });

  it.skipIf(process.platform !== 'win32')('creates declared run directories before starting every server program and stops them as a group', async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-multi-program-test-'));
    const configPath = path.join(userDataPath, 'tables');
    await fs.mkdir(configPath);
    await fs.writeFile(path.join(configPath, 'table.json'), '{}');
    const programIds = ['zagent', 'zbattle', 'zbroker', 'zchat', 'zgame', 'zguild', 'zlogin', 'zmaster', 'zsocial'];
    const files = programIds.map(id => ({
      path: `${id}.cmd`,
      data: Buffer.from(`@echo ready ${id}\r\necho pid>run/${id}.pid\r\nping -n 30 127.0.0.1 >nul\r\n`, 'utf8'),
    }));
    const indexedFiles = files.map(file => ({ path: file.path, size: file.data.length, sha256: createHash('sha256').update(file.data).digest('hex') }));
    const artifact = {
      fileName: 'artifact-manifest',
      size: indexedFiles.reduce((total, file) => total + file.size, 0),
      sha256: createHash('sha256').update(indexedFiles.slice().sort((a, b) => a.path.localeCompare(b.path)).map(file => `${file.path}\0${file.sha256}\0${file.size}`).join('\n')).digest('hex'),
      expiresAt: Date.now() + 60_000,
      files: indexedFiles,
    };
    const contract = {
      apiVersion: 1,
      run: {
        directories: ['run'],
        programs: programIds.map(id => ({ id, name: id, executable: `${id}.cmd`, args: [], workingDir: '.' })),
      },
      config: { inputs: [
        { id: 'databaseAddress', type: 'text', label: '数据库地址', default: '127.0.0.1:13000', required: true },
        { id: 'dataTables', type: 'directory', label: '配置表位置', required: true },
      ] },
    };
    const supervisor = new LocalServerSupervisor({
      userDataPath,
      platform: 'win32',
      downloadArtifact: async (_instance, _task, relativePath) => new Response(files.find(file => file.path === relativePath)?.data as unknown as BodyInit),
      getArtifact: async () => ({ taskId: 'task-1', artifact }),
      getBuildMetadata: async () => ({ taskId: 'task-1', builtAt: Date.now() }),
      getRuntimeContract: async () => contract,
      selectConfigDirectory: async () => configPath,
    });

    await supervisor.configure('instance-1', 'dataTables');
    await supervisor.prepare('instance-1', 'task-1', 'zagent');
    try {
      const started = await supervisor.startAll('instance-1', 'task-1');
      expect(started.programs).toHaveLength(programIds.length);
      expect(started.programs.every(program => program.status === 'running')).toBe(true);
      const runtimeRoot = path.join(userDataPath, 'local-server-runtimes');
      const [runtimeName] = await fs.readdir(runtimeRoot);
      const runDir = path.join(runtimeRoot, runtimeName, 'run');
      await expect(fs.stat(runDir)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
      await new Promise(resolve => setTimeout(resolve, 500));
      for (const id of programIds) {
        await expect(fs.readFile(path.join(runDir, `${id}.pid`), 'utf8')).resolves.toContain('pid');
      }
      const described = await supervisor.describe('instance-1');
      expect(described.programs.every(program => program.logs?.some(line => line.includes('ready')))).toBe(true);
    } finally {
      await supervisor.stopAll();
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    const stopped = await supervisor.describe('instance-1');
    expect(stopped.programs.every(program => program.status === 'stopped')).toBe(true);
  });
});
