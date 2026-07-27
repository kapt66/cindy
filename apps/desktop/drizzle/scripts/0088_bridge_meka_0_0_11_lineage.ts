import type Database from 'better-sqlite3';

// Migration companion scripts are loaded as CommonJS at runtime. Reuse the
// frozen upstream 0080/0081 semantics so an XDMaker Meka v0.0.11 database,
// which arrives at schema version 87, receives the same money migration as a
// fresh Cindy database before its history is canonicalized.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const regionalMoneyMigration = require('./0080_regional_money.ts') as {
  run(db: Database.Database): void;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const preserveGatewayCurrencyMigration = require('./0081_preserve_gateway_currency.ts') as {
  run(db: Database.Database): void;
};

interface LineageEntry {
  seq: number;
  legacyFileName: string;
  legacyHash: string;
  legacyAlternateHashes?: readonly string[];
  canonicalFileName: string;
  canonicalHash: string;
}

interface MigrationHistoryRow {
  seq: number;
  file_name: string;
  content_hash: string;
}

interface WorkerLabelRow {
  id: string;
  teamId: string;
  label: string;
}

const MEKA_0_0_11_LINEAGE: readonly LineageEntry[] = [
  {
    seq: 73,
    legacyFileName: '0073_red_anthem.sql',
    legacyHash: '5f1aa9edaa89255775b411fac5c6262854db5e0bcde5a2e739c8a9f9e0fae5bf',
    canonicalFileName: '0073_thankful_hex.sql',
    canonicalHash: '45204245bf226cd740b99b013f73df0ca52e9254764f86dde5f182cc4151ad8a',
  },
  {
    seq: 74,
    legacyFileName: '0074_peaceful_misty_knight.sql',
    legacyHash: '72d324ffe0537a641f0cc88377c8730dca0455ffa5485964c91242b3a935e3cb',
    canonicalFileName: '0074_bridge_legacy_migration_lineage.sql',
    canonicalHash: '51742f4eb58ad542be550d2a698a0e61cfca1a9fbb0074be98e7f31a6749c75e',
  },
  {
    seq: 75,
    legacyFileName: '0075_careful_nuke.sql',
    legacyHash: '20269433cb087255238cf74df6ac09fa9dae090b7311e22b0a0e3a0e11cc1636',
    canonicalFileName: '0075_complex_strong_guy.sql',
    canonicalHash: '1880cc34e5af4a684828a9eeb95737f03bd3f3f4c98265af8be0b694d8dd204d',
  },
  {
    seq: 76,
    legacyFileName: '0076_slim_sleepwalker.sql',
    legacyHash: '8e4ad9b0870b2733d1d733a2c062c111b024e7f3986752c6a6e5640a0f2a6c2c',
    canonicalFileName: '0076_melted_post.sql',
    canonicalHash: '912e6d75166ee0bfaf51942d34ab527042d1803971db7929cf90429a8c2cebe8',
  },
  {
    seq: 77,
    legacyFileName: '0077_stiff_jetstream.sql',
    legacyHash: '1171381e7871bae212398fd40513515a3b31114ca81880bd6be69c85f9c5a833',
    canonicalFileName: '0077_nebulous_veda.sql',
    canonicalHash: '6d54ca60ebe0a0d2d23a88cc266b726bddf10f3a9b80dce07a3fa71d13418804',
  },
  {
    seq: 78,
    legacyFileName: '0078_useful_puff_adder.sql',
    legacyHash: 'f32714a25436cf426885618d83d3f07c1f69d0de7f32fcd7edfb2e4c36481e98',
    legacyAlternateHashes: [
      'cd8e8f264032d25c54be712f7bce6388b8cd8dbaed6427bd054f32db2e0e9e47',
    ],
    canonicalFileName: '0078_same_juggernaut.sql',
    canonicalHash: 'ac078c551e24c0f422898f14e12ecc4ea29d09ab43f43e8b1272c79eee65f24b',
  },
  {
    seq: 79,
    legacyFileName: '0079_fuzzy_katie_power.sql',
    legacyHash: 'ab6a526ae481535bddbb2985495d74891afdc5cba4233f5d22c9632f2770a816',
    canonicalFileName: '0079_futuristic_hercules.sql',
    canonicalHash: '9a631fc8e6985c750971777332fdccfcfd7f47fa2e88dc9746d1bc64415db97f',
  },
  {
    seq: 80,
    legacyFileName: '0080_right_snowbird.sql',
    legacyHash: '393852475c44bed128cf83353b18bc9200ab90961ecdc3f624d03ccf4d84eab4',
    canonicalFileName: '0080_regional_money.sql',
    canonicalHash: 'b4e0497804e46e0a0b0b8c31975b062152d551bac49c3c2e80932567b4085dcd',
  },
  {
    seq: 81,
    legacyFileName: '0081_broken_luckman.sql',
    legacyHash: 'a072deef355eb32feabb0b50375783cc45741ac2a46c937baf71419004f197c0',
    canonicalFileName: '0081_preserve_gateway_currency.sql',
    canonicalHash: 'b4e0497804e46e0a0b0b8c31975b062152d551bac49c3c2e80932567b4085dcd',
  },
  {
    seq: 82,
    legacyFileName: '0082_lowly_solo.sql',
    legacyHash: 'df5d0ee1355b13fbe6a834cddfa6d9e8f19dd9ded1b4752eba78d0d9f30a3d3c',
    legacyAlternateHashes: [
      'a46756c96a24c3414eb3571deb5fe854a4c0e86c9b2a581aae2a813f588ac3ed',
    ],
    canonicalFileName: '0082_meka_product_schema.sql',
    canonicalHash: 'b4e0497804e46e0a0b0b8c31975b062152d551bac49c3c2e80932567b4085dcd',
  },
  {
    seq: 83,
    legacyFileName: '0083_purple_mac_gargan.sql',
    legacyHash: '289975f8f5c1df4a229802ab8d0a937193af07e3084ff94bcdbe5833d8cb6209',
    canonicalFileName: '0083_meka_lineage_slot_83.sql',
    canonicalHash: 'b4e0497804e46e0a0b0b8c31975b062152d551bac49c3c2e80932567b4085dcd',
  },
  {
    seq: 84,
    legacyFileName: '0084_curious_ogun.sql',
    legacyHash: 'be83f55789e69babccad6f85e9735c1fbe6bde3311790ab39f516a40c343dcb9',
    canonicalFileName: '0084_meka_lineage_slot_84.sql',
    canonicalHash: 'b4e0497804e46e0a0b0b8c31975b062152d551bac49c3c2e80932567b4085dcd',
  },
  {
    seq: 85,
    legacyFileName: '0085_minor_cammi.sql',
    legacyHash: '7c538b357d5c880a3206168798a2e704d4cfebc8ab0358719c4978a1ecc9eb68',
    canonicalFileName: '0085_meka_lineage_slot_85.sql',
    canonicalHash: 'b4e0497804e46e0a0b0b8c31975b062152d551bac49c3c2e80932567b4085dcd',
  },
  {
    seq: 86,
    legacyFileName: '0086_goofy_black_knight.sql',
    legacyHash: '493ff0de8f54fd63a50f940f3867bba87334516bf964b08cf764519675a2c8b3',
    canonicalFileName: '0086_meka_lineage_slot_86.sql',
    canonicalHash: 'b4e0497804e46e0a0b0b8c31975b062152d551bac49c3c2e80932567b4085dcd',
  },
  {
    seq: 87,
    legacyFileName: '0087_shallow_doctor_octopus.sql',
    legacyHash: '411afaef7eb0458c558b3343b80ff422094d7f2f5f97d7868e71501df3b53c66',
    canonicalFileName: '0087_meka_lineage_slot_87.sql',
    canonicalHash: 'b4e0497804e46e0a0b0b8c31975b062152d551bac49c3c2e80932567b4085dcd',
  },
];

function tableExists(db: Database.Database, tableName: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
      .get(tableName) !== undefined
  );
}

function tableColumnNames(db: Database.Database, tableName: string): Set<string> {
  return new Set(
    db
      .prepare(`PRAGMA table_info('${tableName}')`)
      .all()
      .map((row) => String((row as { name: unknown }).name)),
  );
}

function hasExactMekaLineage(db: Database.Database): boolean {
  const seqs = MEKA_0_0_11_LINEAGE.map((entry) => entry.seq);
  const rows = db
    .prepare(
      `SELECT seq, file_name, content_hash
       FROM migration_history
       WHERE seq IN (${seqs.map(() => '?').join(', ')})
       ORDER BY seq`,
    )
    .all(...seqs) as MigrationHistoryRow[];

  return (
    rows.length === MEKA_0_0_11_LINEAGE.length &&
    MEKA_0_0_11_LINEAGE.every((expected, index) => {
      const actual = rows[index];
      const acceptedHashes = [
        expected.legacyHash,
        ...(expected.legacyAlternateHashes ?? []),
      ];
      return (
        actual?.seq === expected.seq &&
        actual.file_name === expected.legacyFileName &&
        acceptedHashes.includes(actual.content_hash)
      );
    })
  );
}

function requireTables(db: Database.Database, tableNames: readonly string[]): void {
  for (const tableName of tableNames) {
    if (!tableExists(db, tableName)) {
      throw new Error(`Meka 0.0.11 lineage is missing required table ${tableName}`);
    }
  }
}

function requireColumns(
  db: Database.Database,
  tableName: string,
  columnNames: readonly string[],
): void {
  const columns = tableColumnNames(db, tableName);
  for (const columnName of columnNames) {
    if (!columns.has(columnName)) {
      throw new Error(`Meka 0.0.11 lineage is missing ${tableName}.${columnName}`);
    }
  }
}

function canonicalLabel(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'worker'
  );
}

function nextAvailableLabel(base: string, used: Set<string>): string {
  for (let index = 2; index < 1_000_000; index += 1) {
    const suffix = `-${index}`;
    const candidate = `${base.slice(0, 32 - suffix.length)}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error(`could not allocate unique worker label for ${base}`);
}

function normalizeExistingWorkerLabels(db: Database.Database): void {
  const rows = db
    .prepare(
      `SELECT id, team_id AS teamId, label
       FROM orca_workers
       WHERE label IS NOT NULL
       ORDER BY team_id, created_at, id`,
    )
    .all() as WorkerLabelRow[];
  const canonicalById = new Map<string, string>();
  const firstIdByTeamLabel = new Map<string, string>();
  const usedByTeam = new Map<string, Set<string>>();

  for (const row of rows) {
    const canonical = canonicalLabel(row.label);
    canonicalById.set(row.id, canonical);
    const key = `${row.teamId}\0${canonical}`;
    if (!firstIdByTeamLabel.has(key)) firstIdByTeamLabel.set(key, row.id);
    const used = usedByTeam.get(row.teamId) ?? new Set<string>();
    used.add(canonical);
    usedByTeam.set(row.teamId, used);
  }

  const update = db.prepare('UPDATE orca_workers SET label = ? WHERE id = ?');
  for (const row of rows) {
    const base = canonicalById.get(row.id);
    if (!base) continue;
    const key = `${row.teamId}\0${base}`;
    const used = usedByTeam.get(row.teamId) ?? new Set<string>();
    const next = firstIdByTeamLabel.get(key) === row.id ? base : nextAvailableLabel(base, used);
    used.add(next);
    if (row.label !== next) update.run(next, row.id);
  }
}

function applyCurrentSchemaSemantics(db: Database.Database): void {
  requireTables(db, [
    'sessions',
    'messages',
    'schedules',
    'schedule_runs',
    'orca_teams',
    'orca_workers',
    'meka_projects',
    'meka_roles',
  ]);
  requireColumns(db, 'sessions', [
    'meka_role',
    'meka_target_json',
    'meka_project_id',
    'meka_role_id',
    'is_formal',
    'formal_type',
    'formal_link',
    'formal_ref',
    'formal_content_json',
    'capability_snapshot_json',
  ]);
  requireColumns(db, 'meka_projects', ['id', 'name', 'path', 'tags', 'is_builtin']);
  requireColumns(db, 'meka_roles', [
    'id',
    'project_id',
    'name',
    'display_name',
    'file_path',
    'is_builtin',
  ]);

  const scheduleColumns = tableColumnNames(db, 'schedules');
  if (!scheduleColumns.has('execution_mode')) {
    db.exec("ALTER TABLE schedules ADD COLUMN execution_mode text DEFAULT 'agent' NOT NULL");
  }
  if (!scheduleColumns.has('script_config')) {
    db.exec('ALTER TABLE schedules ADD COLUMN script_config text');
  }

  const runColumns = tableColumnNames(db, 'schedule_runs');
  if (!runColumns.has('pre_run_hook_result')) {
    db.exec('ALTER TABLE schedule_runs ADD COLUMN pre_run_hook_result text');
  }
  if (!runColumns.has('cost_usd')) {
    db.exec('ALTER TABLE schedule_runs ADD COLUMN cost_usd real DEFAULT 0 NOT NULL');
  }
  if (!runColumns.has('estimated_value_usd')) {
    db.exec('ALTER TABLE schedule_runs ADD COLUMN estimated_value_usd real DEFAULT 0 NOT NULL');
  }
  if (!runColumns.has('cost_attribution')) {
    db.exec("ALTER TABLE schedule_runs ADD COLUMN cost_attribution text DEFAULT 'legacy' NOT NULL");
  }

  const messageColumns = tableColumnNames(db, 'messages');
  if (!messageColumns.has('agent_kind')) {
    db.exec('ALTER TABLE messages ADD COLUMN agent_kind text');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS orca_worker_creation_reservations (
      id text PRIMARY KEY NOT NULL,
      team_id text NOT NULL REFERENCES orca_teams(id) ON DELETE CASCADE,
      label text NOT NULL,
      created_at integer NOT NULL,
      expires_at integer NOT NULL
    )
  `);
  normalizeExistingWorkerLabels(db);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_orca_worker_creation_reservations_team_label
      ON orca_worker_creation_reservations (team_id, lower(label));
    CREATE INDEX IF NOT EXISTS idx_orca_worker_creation_reservations_expires_at
      ON orca_worker_creation_reservations (expires_at);
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_orca_workers_team_label
      ON orca_workers (team_id, lower(label));
  `);

  const refreshedScheduleColumns = tableColumnNames(db, 'schedules');
  if (!refreshedScheduleColumns.has('legacy_session_fallback')) {
    db.exec(
      'ALTER TABLE schedules ADD COLUMN legacy_session_fallback integer DEFAULT 0 NOT NULL',
    );
    db.exec(`
      UPDATE schedules
      SET legacy_session_fallback = 1
      WHERE NOT EXISTS (
        SELECT 1
        FROM sessions
        WHERE sessions.source = 'scheduler'
          AND sessions.title = '[Schedule] ' || schedules.name
          AND sessions.workspace_kind = schedules.workspace_kind
          AND (
            schedules.workspace_kind = 'dialogue'
            OR sessions.working_dir IS schedules.working_dir
          )
          AND sessions.created_at < schedules.created_at
      )
    `);
  }
}

function canonicalizeMigrationHistory(db: Database.Database): void {
  for (const entry of MEKA_0_0_11_LINEAGE) {
    const acceptedHashes = [
      entry.legacyHash,
      ...(entry.legacyAlternateHashes ?? []),
    ];
    const update = db.prepare(
      `UPDATE migration_history
       SET file_name = ?, content_hash = ?
       WHERE seq = ? AND file_name = ?
         AND content_hash IN (${acceptedHashes.map(() => '?').join(', ')})`,
    );
    const result = update.run(
      entry.canonicalFileName,
      entry.canonicalHash,
      entry.seq,
      entry.legacyFileName,
      ...acceptedHashes,
    );
    if (result.changes !== 1) {
      throw new Error(`Meka 0.0.11 lineage changed during bridge at seq ${entry.seq}`);
    }
  }
}

function run(db: Database.Database): void {
  if (!hasExactMekaLineage(db)) return;

  db.transaction(() => {
    regionalMoneyMigration.run(db);
    preserveGatewayCurrencyMigration.run(db);
    applyCurrentSchemaSemantics(db);
    canonicalizeMigrationHistory(db);
  })();
}

module.exports = { run };
