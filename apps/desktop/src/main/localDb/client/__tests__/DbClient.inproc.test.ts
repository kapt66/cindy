import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name !== 'userData') throw new Error(`unexpected app.getPath(${name})`);
      const dir = process.env.XDT_INPROC_TEST_USER_DATA;
      if (!dir) throw new Error('XDT_INPROC_TEST_USER_DATA is not set');
      return dir;
    },
    isPackaged: true,
    exit: vi.fn(),
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
  dialog: {
    showMessageBoxSync: vi.fn(),
  },
}));

const INIT_SQL = `
${fs.readFileSync(path.resolve(__dirname, '../../../../../drizzle/0000_init.sql'), 'utf8')}
ALTER TABLE sessions ADD COLUMN workspace_kind TEXT NOT NULL DEFAULT 'project';
ALTER TABLE sessions ADD COLUMN meka_role TEXT;
ALTER TABLE sessions ADD COLUMN meka_target_json TEXT;
ALTER TABLE sessions ADD COLUMN meka_project_id TEXT;
ALTER TABLE sessions ADD COLUMN meka_role_id TEXT;
ALTER TABLE sessions ADD COLUMN is_formal INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN formal_type TEXT;
ALTER TABLE sessions ADD COLUMN formal_link TEXT;
ALTER TABLE sessions ADD COLUMN formal_ref TEXT;
ALTER TABLE sessions ADD COLUMN formal_content_json TEXT;
ALTER TABLE sessions ADD COLUMN total_cost_amount REAL NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN total_cost_currency TEXT;
ALTER TABLE sessions ADD COLUMN total_cost_is_approximate INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN plan_mode_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN summary TEXT;
ALTER TABLE sessions ADD COLUMN provider_id TEXT;
ALTER TABLE sessions ADD COLUMN user_send_at INTEGER;
ALTER TABLE sessions ADD COLUMN agent_kind TEXT NOT NULL DEFAULT 'cc';
ALTER TABLE sessions ADD COLUMN orca_role TEXT;
ALTER TABLE sessions ADD COLUMN parent_session_id TEXT;
ALTER TABLE sessions ADD COLUMN forked_at_message_id TEXT;
ALTER TABLE sessions ADD COLUMN worktree_path TEXT;
ALTER TABLE sessions ADD COLUMN source TEXT NOT NULL DEFAULT 'desktop';
ALTER TABLE sessions ADD COLUMN feishu_open_id TEXT;
ALTER TABLE sessions ADD COLUMN feishu_bot_app_id TEXT;
ALTER TABLE sessions ADD COLUMN im_bot_context_id TEXT;
ALTER TABLE sessions ADD COLUMN im_user_id TEXT;
ALTER TABLE sessions ADD COLUMN used_project_context INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN codex_history_has_product_prompt INTEGER;
ALTER TABLE sessions ADD COLUMN codex_plan_json TEXT;
ALTER TABLE sessions ADD COLUMN extra_dirs TEXT NOT NULL DEFAULT '[]';
ALTER TABLE sessions ADD COLUMN remote_host_id TEXT;
ALTER TABLE sessions ADD COLUMN capability_snapshot_json TEXT;
ALTER TABLE sessions ADD COLUMN active_turn_started_at INTEGER;
ALTER TABLE sessions ADD COLUMN active_turn_pid INTEGER;
ALTER TABLE sessions ADD COLUMN last_turn_ended_at INTEGER;
CREATE TABLE IF NOT EXISTS embedding_jobs (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL DEFAULT 0,
  model_id TEXT NOT NULL,
  vec_table TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  scheduled_at INTEGER NOT NULL,
  locked_at INTEGER,
  UNIQUE(source, source_id, chunk_index, model_id)
);
CREATE TABLE meka_projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT,
  tags TEXT,
  is_builtin INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER,
  updated_at INTEGER
);
CREATE TABLE meka_roles (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  tags TEXT,
  file_path TEXT NOT NULL,
  is_builtin INTEGER NOT NULL DEFAULT 0,
  content_digest TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER,
  updated_at INTEGER
);
`;

describe('DbClient in-proc fallback', () => {
  let previousResourcesPath: string | undefined;

  afterEach(async () => {
    const { closeDb } = await import('../../index.js');
    closeDb();
    if (previousResourcesPath === undefined) {
      Reflect.deleteProperty(process, 'resourcesPath');
    } else {
      Object.defineProperty(process, 'resourcesPath', {
        configurable: true,
        value: previousResourcesPath,
      });
    }
    previousResourcesPath = undefined;
    delete process.env.XDT_DB_INPROC;
    const userDataDir = process.env.XDT_INPROC_TEST_USER_DATA;
    delete process.env.XDT_INPROC_TEST_USER_DATA;
    if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  it('routes query/queryOne/exec/tx through the legacy localDb handle', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-db-inproc-'));
    const drizzleDir = path.join(userDataDir, 'drizzle');
    fs.mkdirSync(drizzleDir);
    fs.writeFileSync(path.join(drizzleDir, '0000_init.sql'), INIT_SQL, 'utf-8');
    process.env.XDT_INPROC_TEST_USER_DATA = userDataDir;
    process.env.XDT_DB_INPROC = 'true';
    previousResourcesPath = process.resourcesPath;
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: userDataDir,
    });

    const { createDbClient } = await import('../DbClient.js');
    const client = await createDbClient({ userId: `inproc-test-${Date.now()}` });

    await client.exec('CREATE TEMP TABLE inproc_fallback_test (id INTEGER PRIMARY KEY, name TEXT)');
    const inserted = await client.exec('INSERT INTO inproc_fallback_test (name) VALUES (?)', [
      'alice',
    ]);
    expect(inserted.changes).toBe(1);

    await expect(
      client.query<{ id: number; name: string }>(
        'SELECT id, name FROM inproc_fallback_test WHERE name = ?',
        ['alice'],
      ),
    ).resolves.toEqual([{ id: 1, name: 'alice' }]);
    await expect(
      client.queryOne<{ id: number; name: string }>(
        'SELECT id, name FROM inproc_fallback_test WHERE id = ?',
        [1],
      ),
    ).resolves.toEqual({ id: 1, name: 'alice' });

    const sourceId = `inproc-source-${Date.now()}`;
    await expect(
      client.tx('embedding.enqueue', {
        source: 'chat',
        now: Date.now(),
        items: [{ sourceId, modelId: 'test-model', vecTable: 'chat_vec' }],
      }),
    ).resolves.toEqual({ inserted: 1, skipped: 0 });
  }, 60_000);
});
