import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const migration0088 =
  require('../../../../drizzle/scripts/0088_bridge_meka_0_0_11_lineage.ts') as {
    run(db: Database.Database): void;
  };

const LEGACY_LINEAGE = [
  [73, '0073_red_anthem.sql', '5f1aa9edaa89255775b411fac5c6262854db5e0bcde5a2e739c8a9f9e0fae5bf'],
  [74, '0074_peaceful_misty_knight.sql', '72d324ffe0537a641f0cc88377c8730dca0455ffa5485964c91242b3a935e3cb'],
  [75, '0075_careful_nuke.sql', '20269433cb087255238cf74df6ac09fa9dae090b7311e22b0a0e3a0e11cc1636'],
  [76, '0076_slim_sleepwalker.sql', '8e4ad9b0870b2733d1d733a2c062c111b024e7f3986752c6a6e5640a0f2a6c2c'],
  [77, '0077_stiff_jetstream.sql', '1171381e7871bae212398fd40513515a3b31114ca81880bd6be69c85f9c5a833'],
  [78, '0078_useful_puff_adder.sql', 'f32714a25436cf426885618d83d3f07c1f69d0de7f32fcd7edfb2e4c36481e98'],
  [79, '0079_fuzzy_katie_power.sql', 'ab6a526ae481535bddbb2985495d74891afdc5cba4233f5d22c9632f2770a816'],
  [80, '0080_right_snowbird.sql', '393852475c44bed128cf83353b18bc9200ab90961ecdc3f624d03ccf4d84eab4'],
  [81, '0081_broken_luckman.sql', 'a072deef355eb32feabb0b50375783cc45741ac2a46c937baf71419004f197c0'],
  [82, '0082_lowly_solo.sql', 'df5d0ee1355b13fbe6a834cddfa6d9e8f19dd9ded1b4752eba78d0d9f30a3d3c'],
  [83, '0083_purple_mac_gargan.sql', '289975f8f5c1df4a229802ab8d0a937193af07e3084ff94bcdbe5833d8cb6209'],
  [84, '0084_curious_ogun.sql', 'be83f55789e69babccad6f85e9735c1fbe6bde3311790ab39f516a40c343dcb9'],
  [85, '0085_minor_cammi.sql', '7c538b357d5c880a3206168798a2e704d4cfebc8ab0358719c4978a1ecc9eb68'],
  [86, '0086_goofy_black_knight.sql', '493ff0de8f54fd63a50f940f3867bba87334516bf964b08cf764519675a2c8b3'],
  [87, '0087_shallow_doctor_octopus.sql', '411afaef7eb0458c558b3343b80ff422094d7f2f5f97d7868e71501df3b53c66'],
] as const;

const PRE_RELEASE_DRIFT_HASHES = {
  78: 'cd8e8f264032d25c54be712f7bce6388b8cd8dbaed6427bd054f32db2e0e9e47',
  82: 'a46756c96a24c3414eb3571deb5fe854a4c0e86c9b2a581aae2a813f588ac3ed',
} as const;

const CANONICAL_FILE_NAMES = [
  '0073_thankful_hex.sql',
  '0074_bridge_legacy_migration_lineage.sql',
  '0075_complex_strong_guy.sql',
  '0076_melted_post.sql',
  '0077_nebulous_veda.sql',
  '0078_same_juggernaut.sql',
  '0079_futuristic_hercules.sql',
  '0080_peaceful_baron_strucker.sql',
  '0081_meka_lineage_slot_81.sql',
  '0082_meka_lineage_slot_82.sql',
  '0083_meka_lineage_slot_83.sql',
  '0084_meka_lineage_slot_84.sql',
  '0085_meka_lineage_slot_85.sql',
  '0086_meka_lineage_slot_86.sql',
  '0087_meka_lineage_slot_87.sql',
] as const;

function createMeka0011Db(
  hashOverrides: Readonly<Partial<Record<number, string>>> = {},
): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE migration_history (
      seq INTEGER PRIMARY KEY NOT NULL,
      file_name TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
    CREATE TABLE meka_projects (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      path TEXT,
      tags TEXT,
      is_builtin INTEGER DEFAULT 0 NOT NULL
    );
    CREATE TABLE meka_roles (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      display_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      is_builtin INTEGER DEFAULT 0 NOT NULL
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL,
      working_dir TEXT,
      workspace_kind TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      meka_role TEXT,
      meka_target_json TEXT,
      meka_project_id TEXT,
      meka_role_id TEXT,
      is_formal INTEGER DEFAULT 0 NOT NULL,
      formal_type TEXT,
      formal_link TEXT,
      formal_ref TEXT,
      formal_content_json TEXT,
      capability_snapshot_json TEXT
    );
    CREATE TABLE messages (id TEXT PRIMARY KEY NOT NULL);
    CREATE TABLE schedules (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      workspace_kind TEXT NOT NULL,
      working_dir TEXT,
      created_at INTEGER NOT NULL,
      execution_mode TEXT DEFAULT 'agent' NOT NULL,
      script_config TEXT
    );
    CREATE TABLE schedule_runs (id TEXT PRIMARY KEY NOT NULL);
    CREATE TABLE orca_teams (id TEXT PRIMARY KEY NOT NULL);
    CREATE TABLE orca_workers (
      id TEXT PRIMARY KEY NOT NULL,
      team_id TEXT NOT NULL,
      label TEXT,
      created_at INTEGER NOT NULL
    );
    INSERT INTO meka_projects (id, name, path, tags, is_builtin)
      VALUES ('project-1', 'project-1', 'C:/game', '["game"]', 0);
    INSERT INTO meka_roles (id, project_id, name, display_name, file_path, is_builtin)
      VALUES ('role-1', 'project-1', 'role-1', 'Programmer', 'roles/role-1.json', 0);
    INSERT INTO sessions (
      id, title, working_dir, workspace_kind, source, created_at,
      meka_project_id, meka_role_id, formal_type, formal_ref
    ) VALUES (
      'session-1', 'PROJ-1 task', 'C:/game', 'meka', 'desktop', 100,
      'project-1', 'role-1', 'jira', 'PROJ-1'
    );
    INSERT INTO schedules (id, name, workspace_kind, working_dir, created_at)
      VALUES ('schedule-1', 'Daily', 'project', 'C:/game', 200);
    INSERT INTO orca_teams (id) VALUES ('team-1');
    INSERT INTO orca_workers (id, team_id, label, created_at) VALUES
      ('worker-1', 'team-1', 'Tester', 1),
      ('worker-2', 'team-1', 'tester', 2);
  `);
  const insert = db.prepare(
    `INSERT INTO migration_history (seq, file_name, content_hash, applied_at)
     VALUES (?, ?, ?, ?)`,
  );
  for (const [seq, fileName, hash] of LEGACY_LINEAGE) {
    insert.run(seq, fileName, hashOverrides[seq] ?? hash, 1_000 + seq);
  }
  return db;
}

function columnNames(db: Database.Database, tableName: string): string[] {
  return db
    .prepare(`PRAGMA table_info('${tableName}')`)
    .all()
    .map((row) => String((row as { name: unknown }).name));
}

describe('0088 Meka 0.0.11 migration lineage bridge', () => {
  it('preserves Meka data, fills current schema semantics, and canonicalizes exact history', () => {
    const db = createMeka0011Db();
    try {
      migration0088.run(db);

      expect(columnNames(db, 'schedule_runs')).toEqual(
        expect.arrayContaining([
          'pre_run_hook_result',
          'cost_usd',
          'estimated_value_usd',
          'cost_attribution',
        ]),
      );
      expect(columnNames(db, 'messages')).toContain('agent_kind');
      expect(columnNames(db, 'schedules')).toContain('legacy_session_fallback');
      expect(
        db.prepare('SELECT legacy_session_fallback FROM schedules').pluck().get(),
      ).toBe(1);
      expect(
        db.prepare('SELECT id, meka_project_id, meka_role_id, formal_ref FROM sessions').get(),
      ).toEqual({
        id: 'session-1',
        meka_project_id: 'project-1',
        meka_role_id: 'role-1',
        formal_ref: 'PROJ-1',
      });
      expect(
        db.prepare('SELECT label FROM orca_workers ORDER BY created_at').pluck().all(),
      ).toEqual(['tester', 'tester-2']);
      expect(
        db.prepare('SELECT file_name FROM migration_history ORDER BY seq').pluck().all(),
      ).toEqual(CANONICAL_FILE_NAMES);

      const snapshot = db
        .prepare('SELECT seq, file_name, content_hash, applied_at FROM migration_history ORDER BY seq')
        .all();
      migration0088.run(db);
      expect(
        db.prepare('SELECT seq, file_name, content_hash, applied_at FROM migration_history ORDER BY seq')
          .all(),
      ).toEqual(snapshot);
    } finally {
      db.close();
    }
  });

  it('bridges the pre-release 0.0.11 lineage hashes found in existing user databases', () => {
    const db = createMeka0011Db(PRE_RELEASE_DRIFT_HASHES);
    try {
      migration0088.run(db);

      expect(columnNames(db, 'messages')).toContain('agent_kind');
      expect(columnNames(db, 'schedules')).toContain('legacy_session_fallback');
      expect(
        db.prepare('SELECT file_name FROM migration_history ORDER BY seq').pluck().all(),
      ).toEqual(CANONICAL_FILE_NAMES);
    } finally {
      db.close();
    }
  });

  it('leaves an unknown or partially matching lineage untouched', () => {
    const db = createMeka0011Db();
    try {
      db.prepare("UPDATE migration_history SET content_hash = 'unknown' WHERE seq = 84").run();
      migration0088.run(db);

      expect(columnNames(db, 'schedule_runs')).not.toContain('cost_usd');
      expect(
        db.prepare('SELECT file_name FROM migration_history WHERE seq = 73').pluck().get(),
      ).toBe('0073_red_anthem.sql');
      expect(
        db.prepare('SELECT meka_project_id FROM sessions WHERE id = ?').pluck().get('session-1'),
      ).toBe('project-1');
    } finally {
      db.close();
    }
  });
});
