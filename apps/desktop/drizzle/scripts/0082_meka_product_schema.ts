import type Database from 'better-sqlite3';

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

function addColumnIfMissing(
  db: Database.Database,
  tableName: string,
  columnName: string,
  definition: string,
): void {
  if (!tableColumnNames(db, tableName).has(columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${definition}`);
  }
}

function run(db: Database.Database): void {
  if (!tableExists(db, 'sessions')) return;

  db.exec(`
    CREATE TABLE IF NOT EXISTS meka_projects (
      id text PRIMARY KEY NOT NULL,
      name text NOT NULL,
      path text,
      tags text,
      is_builtin integer DEFAULT false NOT NULL,
      sort_order integer DEFAULT 0 NOT NULL,
      created_at integer,
      updated_at integer
    );
    CREATE TABLE IF NOT EXISTS meka_roles (
      id text PRIMARY KEY NOT NULL,
      project_id text NOT NULL,
      name text NOT NULL,
      display_name text NOT NULL,
      description text,
      tags text,
      file_path text NOT NULL,
      is_builtin integer DEFAULT false NOT NULL,
      content_digest text,
      sort_order integer DEFAULT 0 NOT NULL,
      created_at integer,
      updated_at integer,
      FOREIGN KEY (project_id) REFERENCES meka_projects(id)
    );
    CREATE INDEX IF NOT EXISTS idx_meka_roles_project_id ON meka_roles (project_id);
  `);

  addColumnIfMissing(db, 'sessions', 'meka_role', 'meka_role text');
  addColumnIfMissing(db, 'sessions', 'meka_target_json', 'meka_target_json text');
  addColumnIfMissing(
    db,
    'sessions',
    'meka_project_id',
    'meka_project_id text REFERENCES meka_projects(id)',
  );
  addColumnIfMissing(
    db,
    'sessions',
    'meka_role_id',
    'meka_role_id text REFERENCES meka_roles(id) ON DELETE SET NULL',
  );
  addColumnIfMissing(
    db,
    'sessions',
    'is_formal',
    'is_formal integer DEFAULT 0 NOT NULL',
  );
  addColumnIfMissing(db, 'sessions', 'formal_type', 'formal_type text');
  addColumnIfMissing(db, 'sessions', 'formal_link', 'formal_link text');
  addColumnIfMissing(db, 'sessions', 'formal_ref', 'formal_ref text');
  addColumnIfMissing(db, 'sessions', 'formal_content_json', 'formal_content_json text');
  addColumnIfMissing(
    db,
    'sessions',
    'capability_snapshot_json',
    'capability_snapshot_json text',
  );

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_meka_project_id ON sessions (meka_project_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_meka_role_id ON sessions (meka_role_id);
  `);
}

module.exports = { run };
