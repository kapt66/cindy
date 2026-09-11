import type Database from 'better-sqlite3';

function tableHasColumns(
  db: Database.Database,
  name: string,
  requiredColumns: readonly string[],
): boolean {
  const table = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  if (!table) return false;
  const rows = db.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name?: unknown }>;
  const columns = new Set(rows.map((row) => row.name));
  return requiredColumns.every((column) => columns.has(column));
}

function run(db: Database.Database): void {
  if (
    !tableHasColumns(db, 'skill_usage_exposures', [
      'skill_name',
      'analyzer_version',
      'seen_at',
      'raw_file_path',
    ])
  ) {
    return;
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_skill_usage_exposures_skill_recent
      ON skill_usage_exposures (skill_name, analyzer_version, seen_at);
    CREATE INDEX IF NOT EXISTS idx_skill_usage_exposures_skill_recent_any_version
      ON skill_usage_exposures (skill_name, seen_at);
    CREATE INDEX IF NOT EXISTS idx_skill_usage_exposures_analyzer_recent_source
      ON skill_usage_exposures (analyzer_version, seen_at, raw_file_path);
  `);
}

module.exports = { run };
