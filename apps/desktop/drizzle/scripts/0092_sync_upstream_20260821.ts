import type Database from 'better-sqlite3';

interface MessageSpendRow {
  created_at: number | null;
  agent_meta: string | null;
}

interface ExistingSpendRow {
  day: string;
  cost_currency: string;
  cost_amount: number;
  cost_is_approximate: number;
}

interface SpendBucket {
  amount: number;
  approximate: boolean;
  updatedAt: number;
}

function tableExists(db: Database.Database, tableName: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName),
  );
}

function tableColumnNames(db: Database.Database, tableName: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info('${tableName}')`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function localDayKey(ts: number): string {
  const date = new Date(ts);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function readMoney(
  value: unknown,
): { amount: number; currency: string; approximate: boolean } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const money = value as { amount?: unknown; currency?: unknown; approximate?: unknown };
  if (typeof money.amount !== 'number' || !Number.isFinite(money.amount) || money.amount <= 0) {
    return null;
  }
  if (money.currency !== 'CNY' && money.currency !== 'USD') return null;
  return {
    amount: money.amount,
    currency: money.currency,
    approximate: money.approximate === true,
  };
}

function collectSpendFromMessages(db: Database.Database): Map<string, SpendBucket> {
  const buckets = new Map<string, SpendBucket>();
  if (!tableExists(db, 'messages')) return buckets;
  const columns = tableColumnNames(db, 'messages');
  if (!columns.has('agent_meta') || !columns.has('created_at')) return buckets;
  const rewindGuard = columns.has('rewind_at') ? 'AND rewind_at IS NULL' : '';
  const rows = db
    .prepare(
      `SELECT created_at, agent_meta FROM messages
       WHERE agent_meta LIKE '%"turnCost"%' ${rewindGuard}`,
    )
    .all() as MessageSpendRow[];
  for (const row of rows) {
    if (typeof row.created_at !== 'number' || !Number.isFinite(row.created_at)) continue;
    if (!row.agent_meta) continue;
    let meta: Record<string, unknown>;
    try {
      const parsed = JSON.parse(row.agent_meta) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      meta = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    const money = readMoney(meta.turnCost);
    if (!money) continue;
    const day = localDayKey(row.created_at);
    const key = `${day}\u0000${money.currency}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.amount += money.amount;
      existing.approximate = existing.approximate || money.approximate;
      existing.updatedAt = Math.max(existing.updatedAt, row.created_at);
    } else {
      buckets.set(key, {
        amount: money.amount,
        approximate: money.approximate,
        updatedAt: row.created_at,
      });
    }
  }
  return buckets;
}

function rebuildDailySpend(db: Database.Database): void {
  if (!tableExists(db, 'daily_spend')) return;
  const columns = tableColumnNames(db, 'daily_spend');
  if (!columns.has('day') || !columns.has('cost_currency') || !columns.has('cost_amount')) return;
  const buckets = collectSpendFromMessages(db);
  if (buckets.size === 0) return;

  const existingRows = db
    .prepare('SELECT day, cost_currency, cost_amount, cost_is_approximate FROM daily_spend')
    .all() as ExistingSpendRow[];
  const existing = new Map<string, ExistingSpendRow>(
    existingRows.map((row) => [`${row.day}\u0000${row.cost_currency}`, row] as const),
  );
  const insert = db.prepare(
    `INSERT INTO daily_spend (day, cost_usd, cost_amount, cost_currency, cost_is_approximate, updated_at)
     VALUES (?, 0, ?, ?, ?, ?)
     ON CONFLICT(day, cost_currency) DO UPDATE SET
       cost_amount = excluded.cost_amount,
       cost_is_approximate = excluded.cost_is_approximate,
       updated_at = excluded.updated_at`,
  );
  for (const [key, bucket] of buckets) {
    const separator = key.indexOf('\u0000');
    const day = key.slice(0, separator);
    const currency = key.slice(separator + 1);
    const current = existing.get(key);
    if ((current?.cost_amount ?? 0) >= bucket.amount) continue;
    insert.run(
      day,
      bucket.amount,
      currency,
      bucket.approximate || current?.cost_is_approximate === 1 ? 1 : 0,
      bucket.updatedAt,
    );
  }
}

function installGroupMessageSearch(db: Database.Database): void {
  if (!tableExists(db, 'hook_group_messages')) return;
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS hook_group_messages_fts USING fts5(
      text,
      author,
      file_names,
      content='hook_group_messages',
      content_rowid='id',
      tokenize='porter unicode61'
    );
    INSERT INTO hook_group_messages_fts(hook_group_messages_fts) VALUES('rebuild');
    CREATE TRIGGER IF NOT EXISTS hook_group_messages_fts_insert
    AFTER INSERT ON hook_group_messages BEGIN
      INSERT INTO hook_group_messages_fts(rowid, text, author, file_names)
      VALUES (new.id, new.text, new.author, new.file_names);
    END;
    CREATE TRIGGER IF NOT EXISTS hook_group_messages_fts_delete
    AFTER DELETE ON hook_group_messages BEGIN
      INSERT INTO hook_group_messages_fts(hook_group_messages_fts, rowid, text, author, file_names)
      VALUES ('delete', old.id, old.text, old.author, old.file_names);
    END;
    CREATE TRIGGER IF NOT EXISTS hook_group_messages_fts_update
    AFTER UPDATE ON hook_group_messages BEGIN
      INSERT INTO hook_group_messages_fts(hook_group_messages_fts, rowid, text, author, file_names)
      VALUES ('delete', old.id, old.text, old.author, old.file_names);
      INSERT INTO hook_group_messages_fts(rowid, text, author, file_names)
      VALUES (new.id, new.text, new.author, new.file_names);
    END;
    INSERT INTO hook_group_message_stats (provider, row_count, text_bytes)
    SELECT provider, count(*), coalesce(sum(length(CAST(text AS BLOB))), 0)
    FROM hook_group_messages
    GROUP BY provider
    ON CONFLICT(provider) DO UPDATE SET
      row_count = excluded.row_count,
      text_bytes = excluded.text_bytes;
    CREATE TRIGGER IF NOT EXISTS hook_group_message_stats_insert
    AFTER INSERT ON hook_group_messages BEGIN
      INSERT INTO hook_group_message_stats (provider, row_count, text_bytes)
      VALUES (new.provider, 1, length(CAST(new.text AS BLOB)))
      ON CONFLICT(provider) DO UPDATE SET
        row_count = row_count + 1,
        text_bytes = text_bytes + excluded.text_bytes;
    END;
    CREATE TRIGGER IF NOT EXISTS hook_group_message_stats_delete
    AFTER DELETE ON hook_group_messages BEGIN
      UPDATE hook_group_message_stats
      SET row_count = row_count - 1,
          text_bytes = max(0, text_bytes - length(CAST(old.text AS BLOB)))
      WHERE provider = old.provider;
      DELETE FROM hook_group_message_stats
      WHERE provider = old.provider AND row_count <= 0;
    END;
    CREATE TRIGGER IF NOT EXISTS hook_group_message_stats_update
    AFTER UPDATE ON hook_group_messages BEGIN
      UPDATE hook_group_message_stats
      SET row_count = row_count - 1,
          text_bytes = max(0, text_bytes - length(CAST(old.text AS BLOB)))
      WHERE provider = old.provider;
      DELETE FROM hook_group_message_stats
      WHERE provider = old.provider AND row_count <= 0;
      INSERT INTO hook_group_message_stats (provider, row_count, text_bytes)
      VALUES (new.provider, 1, length(CAST(new.text AS BLOB)))
      ON CONFLICT(provider) DO UPDATE SET
        row_count = row_count + 1,
        text_bytes = text_bytes + excluded.text_bytes;
    END;
  `);
}

function run(db: Database.Database): void {
  db.transaction(() => rebuildDailySpend(db))();
  installGroupMessageSearch(db);
  if (tableExists(db, 'right_sidebar_tabs')) {
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS right_sidebar_tabs_subagents_singleton_idx
         ON right_sidebar_tabs (session_id)
        WHERE kind = 'subagents'`,
    );
  }
  if (tableExists(db, 'sessions')) {
    const sessionColumns = db
      .prepare(`PRAGMA table_info('sessions')`)
      .all()
      .map((row) => String((row as { name: unknown }).name));
    if (!sessionColumns.includes('codex_plan_json')) {
      db.exec('ALTER TABLE sessions ADD COLUMN codex_plan_json text');
    }
  }
}

module.exports = { run };
