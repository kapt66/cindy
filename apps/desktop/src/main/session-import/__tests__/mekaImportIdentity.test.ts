/**
 * 测试价值
 * - 生产入口与可观察结果：真实 better-sqlite3 + 生产 `sessionImportTx` 事务体
 *   （`sessionImport.execute`）和 `relocateImportedSession`，观察 sessions 行落库结果。
 * - Bug / 规则依据：docs/dev-rules/meka-assistant-session-binding.md §2/§3 —— 「Meka 项目
 *   目录里的任务」创建瞬间就要带普通 kind + 成对绑定；已绑定会话的工作区不可再改
 *   （与 sessions:update 同一口径）。此前导入任务只写 kind、relocate 可随意换目录。
 * - 现有覆盖缺口：executorNotifications 的 writer 是 mock，看不到真实 INSERT 列；
 *   tx.test.ts 的 sessionImport 用例不覆盖 Meka 身份与 relocate 守卫。
 * - 最小失败输入：begin 只带 mekaProjectId（半绑定）→ 必须拒绝；已绑定行 relocate →
 *   必须拒绝且 working_dir 不变；未绑定行移到 Meka 项目目录 → 同事务补成对绑定。
 * - tier：unit（内存 SQLite + 真实事务体，mock 只限 Electron/模型路由/媒体等叶子依赖）。
 */
import Database from 'better-sqlite3';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DbClient } from '../../localDb/client/DbClient.js';
import { runSessionImportTransaction } from '../../localDb/worker/opHandlers/sessionImportTx.js';
import {
  setWorkspaceBindingResolver,
  type WorkspaceBindingResolveInput,
} from '../../localDb/workspaceBindingResolver.js';
import { normalizeWorkingDirForStorage } from '../../../shared/workingDir.js';

const h = vi.hoisted(() => ({
  client: null as unknown,
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => 'owner-a',
  getActiveDataOwnerPushStamp: () => ({ dataOwnerId: 'owner-a', ownerGeneration: 1 }),
  ownerScopedUserDataPath: () => 'unused-memory-receipts',
}));
vi.mock('../../localDb/client/current.js', () => ({
  getCurrentDbClientSnapshot: () => ({ clientEpoch: 1, userId: 'owner-a' }),
  getDbClient: () => h.client,
}));
vi.mock('../../git-context/prRefsStore.js', () => ({
  recordPrRefsForImportedMessages: async () => {},
}));
vi.mock('../../localDb/ipc/sessionCreatedBroadcast.js', () => ({
  emitSessionCreated: () => {},
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../maker-host/model-route-guard-live.js', () => ({
  resolveDefaultScheduleRoute: async () => null,
  resolveNewTaskDefaultModelRoute: async () => null,
}));
vi.mock('../../maker-host/newMakerDefaultsCache.js', () => ({
  getSelectedNewMakerRoute: () => null,
  getRemoteNewMakerDefaults: () => ({}),
  getNewMakerModelTuning: () => ({}),
}));
vi.mock('../../utils/atomicWriteFile.js', () => ({
  atomicWriteFileSync: vi.fn(),
  readAtomicFileSync: vi.fn(),
}));
vi.mock('../scan.js', () => ({
  resolveSourceSessions: async () => new Map(),
  invalidateImportScan: vi.fn(),
}));
vi.mock('../sources/index.js', () => ({ adapterFor: () => null }));
vi.mock('../handoff.js', () => ({ buildImportHandoffMarker: async () => undefined }));
vi.mock('../../cindy-media/ingest.js', () => ({ ingestMedia: vi.fn() }));
vi.mock('../../cindy-media/chatAttachments.js', () => ({ commitMessageMediaRefs: vi.fn() }));

const { relocateImportedSession } = await import('../executor.js');

let rawDb: Database.Database;
let tempDirs: string[] = [];

function createDbClient(): DbClient {
  rawDb = new Database(':memory:');
  rawDb.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      working_dir TEXT,
      project_dir TEXT,
      workspace_kind TEXT NOT NULL,
      model TEXT,
      provider_id TEXT,
      effort TEXT,
      permission_mode TEXT,
      status TEXT NOT NULL,
      sdk_session_id TEXT,
      total_token_usage INTEGER,
      total_cost_usd REAL,
      context_tokens INTEGER,
      context_window INTEGER,
      fast_mode INTEGER,
      user_send_at INTEGER,
      agent_kind TEXT,
      source TEXT,
      used_project_context INTEGER,
      extra_dirs TEXT,
      codex_history_has_product_prompt INTEGER,
      meka_project_id TEXT,
      meka_role_id TEXT,
      meka_role TEXT,
      hidden_at INTEGER,
      remote_host_id TEXT,
      agent_device_id TEXT,
      list_preview TEXT,
      list_preview_role TEXT,
      list_message_count INTEGER,
      created_at INTEGER,
      updated_at INTEGER
    );
    CREATE TABLE session_imports (
      session_id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      source_session_id TEXT NOT NULL,
      source_fingerprint TEXT,
      source_version TEXT,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      issue TEXT,
      original_cwd TEXT,
      request_id TEXT,
      imported_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  return {
    query: async <T = unknown>(sql: string, params: unknown[] = []) =>
      rawDb.prepare(sql).all(...params) as T[],
    queryOne: async <T = unknown>(sql: string, params: unknown[] = []) =>
      rawDb.prepare(sql).get(...params) as T | undefined,
    exec: async (sql: string, params: unknown[] = []) => rawDb.prepare(sql).run(...params),
    tx: (async (name: string, args: unknown) => {
      if (name !== 'sessionImport.execute') throw new Error(`unexpected tx: ${name}`);
      return runSessionImportTransaction(rawDb, args);
    }) as DbClient['tx'],
    drizzle: undefined as never,
    vecAvailable: false,
    dispose: async () => {},
  } as DbClient;
}

function insertImportedSession(params: {
  id: string;
  workingDir: string;
  projectDir?: string | null;
  workspaceKind?: string;
  mekaProjectId?: string | null;
  mekaRoleId?: string | null;
  mekaRole?: string | null;
  remoteHostId?: string | null;
  source?: string;
}): void {
  rawDb.prepare(`
    INSERT INTO sessions (
      id, title, working_dir, project_dir, workspace_kind, model, provider_id, effort,
      permission_mode, status, sdk_session_id, total_token_usage, total_cost_usd,
      context_tokens, context_window, fast_mode, user_send_at, agent_kind, source,
      used_project_context, extra_dirs, codex_history_has_product_prompt,
      meka_project_id, meka_role_id, meka_role, hidden_at, remote_host_id, agent_device_id,
      list_preview, list_preview_role, list_message_count, created_at, updated_at
    ) VALUES (?, 'imported', ?, ?, ?, 'claude', NULL, 'high', 'auto', 'active', NULL,
      0, 0, 0, 0, 0, 1, 'cc', 'desktop', 0, '[]', NULL, ?, ?, ?, NULL, ?, NULL,
      NULL, NULL, NULL, 1, 2)
  `).run(
    params.id,
    params.workingDir,
    params.projectDir ?? null,
    params.workspaceKind ?? 'project',
    params.mekaProjectId ?? null,
    params.mekaRoleId ?? null,
    params.mekaRole ?? null,
    params.remoteHostId ?? null,
  );
  rawDb.prepare(`
    INSERT INTO session_imports (
      session_id, source, source_session_id, source_fingerprint, source_version,
      mode, status, issue, original_cwd, request_id, imported_at, updated_at
    ) VALUES (?, ?, 'source-1', NULL, NULL, 'handoff', 'ready', 'missing-dir', '/old', 'req-1', 1, 2)
  `).run(params.id, params.source ?? 'cursor');
}

function sessionsRow(id: string) {
  return rawDb.prepare(`
    SELECT working_dir AS workingDir, project_dir AS projectDir, workspace_kind AS workspaceKind,
      meka_project_id AS mekaProjectId, meka_role_id AS mekaRoleId, meka_role AS mekaRole
    FROM sessions WHERE id = ?
  `).get(id) as {
    workingDir: string;
    projectDir: string | null;
    workspaceKind: string;
    mekaProjectId: string | null;
    mekaRoleId: string | null;
    mekaRole: string | null;
  };
}

beforeEach(() => {
  setWorkspaceBindingResolver(null);
  h.client = createDbClient();
});

afterEach(async () => {
  setWorkspaceBindingResolver(null);
  rawDb?.close();
  await Promise.all(tempDirs.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

describe('sessionImportTx begin Meka identity', () => {
  it('writes the resolved pairing, project dir and ordinary kind into the hidden row', async () => {
    await (h.client as DbClient).tx('sessionImport.execute', {
      action: 'begin',
      now: 1000,
      session: {
        id: 'imp-bound',
        title: 'imported',
        workingDir: '/meka/project-a',
        workspaceKind: 'project',
        projectDir: '/meka/project-a',
        mekaProjectId: 'saga2',
        mekaRoleId: 'saga2-default-role',
        model: 'claude-opus-5-5',
        agentKind: 'cc',
        userSendAt: 1,
        createdAt: 1,
        updatedAt: 2,
      },
      record: { source: 'cursor', sourceSessionId: 'source-1' },
    });

    expect(sessionsRow('imp-bound')).toEqual({
      workingDir: '/meka/project-a',
      projectDir: '/meka/project-a',
      workspaceKind: 'project',
      mekaProjectId: 'saga2',
      mekaRoleId: 'saga2-default-role',
      mekaRole: null,
    });
  });

  it('rejects a half binding instead of persisting a half-identity row', async () => {
    await expect((h.client as DbClient).tx('sessionImport.execute', {
      action: 'begin',
      now: 1000,
      session: {
        id: 'imp-half',
        title: 'imported',
        workingDir: '/meka/project-a',
        workspaceKind: 'project',
        projectDir: '/meka/project-a',
        mekaProjectId: 'saga2',
        model: 'claude-opus-5-5',
        agentKind: 'cc',
        userSendAt: 1,
        createdAt: 1,
        updatedAt: 2,
      },
      record: { source: 'cursor', sourceSessionId: 'source-1' },
    })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    expect(rawDb.prepare('SELECT id FROM sessions WHERE id = ?').get('imp-half')).toBeUndefined();
  });

  it('keeps an unresolved import an ordinary project task', async () => {
    await (h.client as DbClient).tx('sessionImport.execute', {
      action: 'begin',
      now: 1000,
      session: {
        id: 'imp-plain',
        title: 'imported',
        workingDir: '/ordinary/work',
        workspaceKind: 'project',
        projectDir: null,
        mekaProjectId: null,
        mekaRoleId: null,
        model: 'claude-opus-5-5',
        agentKind: 'cc',
        userSendAt: 1,
        createdAt: 1,
        updatedAt: 2,
      },
      record: { source: 'cursor', sourceSessionId: 'source-1' },
    });
    expect(sessionsRow('imp-plain')).toEqual({
      workingDir: '/ordinary/work',
      projectDir: null,
      workspaceKind: 'project',
      mekaProjectId: null,
      mekaRoleId: null,
      mekaRole: null,
    });
  });
});

describe('relocateImportedSession Meka guard', () => {
  const boundVariants: Array<{
    label: string;
    extra: {
      workspaceKind?: string;
      mekaProjectId?: string | null;
      mekaRoleId?: string | null;
      mekaRole?: string | null;
    };
    expected: {
      workspaceKind: string;
      mekaProjectId: string | null;
      mekaRoleId: string | null;
      mekaRole: string | null;
    };
  }> = [
    {
      label: 'paired binding',
      extra: { mekaProjectId: 'saga2', mekaRoleId: 'saga2-default-role' },
      expected: {
        workspaceKind: 'project',
        mekaProjectId: 'saga2',
        mekaRoleId: 'saga2-default-role',
        mekaRole: null,
      },
    },
    {
      label: 'legacy kind',
      extra: { workspaceKind: 'meka' },
      expected: { workspaceKind: 'meka', mekaProjectId: null, mekaRoleId: null, mekaRole: null },
    },
    {
      label: 'legacy role marker',
      extra: { mekaRole: 'planner' },
      expected: { workspaceKind: 'project', mekaProjectId: null, mekaRoleId: null, mekaRole: 'planner' },
    },
  ];

  it.each(boundVariants)('rejects a bound row ($label) before moving its working dir', async ({ extra, expected }) => {
    const target = await fsp.mkdtemp(path.join(os.tmpdir(), 'cindy-import-meka-'));
    tempDirs.push(target);
    insertImportedSession({ id: 'imp-bound-move', workingDir: '/old/dir', ...extra });

    await expect(relocateImportedSession('imp-bound-move', target))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    // 硬拒绝：目录与绑定必须保持原样，不产生「目录与绑定不一致」的半身份行。
    expect(sessionsRow('imp-bound-move')).toEqual({
      workingDir: '/old/dir',
      projectDir: null,
      ...expected,
    });
  });

  it('binds an unbound imported task moved into a Meka project directory', async () => {
    const target = await fsp.mkdtemp(path.join(os.tmpdir(), 'cindy-import-meka-'));
    tempDirs.push(target);
    const normalizedTarget = normalizeWorkingDirForStorage(target) ?? target;
    insertImportedSession({ id: 'imp-unbound-move', workingDir: '/old/dir' });
    const resolver = vi.fn(async (_input: WorkspaceBindingResolveInput) => ({
      projectId: 'saga2',
      roleId: 'saga2-default-role',
      workspacePath: normalizedTarget,
    }));
    setWorkspaceBindingResolver(resolver);

    await relocateImportedSession('imp-unbound-move', target);

    // 主进程在写库前按新目录解析（远端工作区不参与）。
    expect(resolver).toHaveBeenCalledWith(expect.objectContaining({
      workingDir: normalizedTarget,
      remoteHostId: null,
    }));
    expect(sessionsRow('imp-unbound-move')).toEqual({
      workingDir: normalizedTarget,
      projectDir: normalizedTarget,
      workspaceKind: 'project',
      mekaProjectId: 'saga2',
      mekaRoleId: 'saga2-default-role',
      mekaRole: null,
    });
  });

  it('moves an unbound imported task to an ordinary folder without inventing a binding', async () => {
    const target = await fsp.mkdtemp(path.join(os.tmpdir(), 'cindy-import-plain-'));
    tempDirs.push(target);
    const normalizedTarget = normalizeWorkingDirForStorage(target) ?? target;
    insertImportedSession({ id: 'imp-plain-move', workingDir: '/old/dir' });
    setWorkspaceBindingResolver(async () => null);

    await relocateImportedSession('imp-plain-move', target);

    expect(sessionsRow('imp-plain-move')).toEqual({
      workingDir: normalizedTarget,
      projectDir: null,
      workspaceKind: 'project',
      mekaProjectId: null,
      mekaRoleId: null,
      mekaRole: null,
    });
  });

  it('does not resolve a remote imported workspace against the local Meka project table', async () => {
    const target = await fsp.mkdtemp(path.join(os.tmpdir(), 'cindy-import-remote-'));
    tempDirs.push(target);
    insertImportedSession({ id: 'imp-remote-move', workingDir: '/old/dir', remoteHostId: 'device-b' });
    const resolver = vi.fn(async (_input: WorkspaceBindingResolveInput) => ({
      projectId: 'saga2',
      roleId: 'saga2-default-role',
      workspacePath: target,
    }));
    setWorkspaceBindingResolver(resolver);

    await relocateImportedSession('imp-remote-move', target);

    expect(resolver).not.toHaveBeenCalled();
    expect(sessionsRow('imp-remote-move').mekaProjectId).toBeNull();
  });
});
