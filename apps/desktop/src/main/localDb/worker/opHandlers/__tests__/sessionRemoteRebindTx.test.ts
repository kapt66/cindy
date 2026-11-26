/**
 * `session.remoteRebind` 事务（`localDb/worker/opHandlers/tx.ts`）。
 *
 * 规则依据：审查 r7 P1 —— psb 会话透明重建后只清 `sdk_session_id`、不写 context rebuild
 * 交接，界面看起来「重连成功」但模型已经失忆。修正把「换远端身份 + 清旧原生绑定 + 写隐藏
 * 交接标记」收进**同一事务**：任一步缺失都是静默错误，不能靠两次写拼出来。
 *
 * 最小失败输入：CAS 期望的 `remote_host_id` 与库里的现值不一致（另一实例先重绑了）→
 * 整单不写，返回值是 `conflict`，且**不**插入交接标记。
 */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { tx } from '../tx.js';

const databases: Database.Database[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function createDb(): Database.Database {
  const db = new Database(':memory:');
  databases.push(db);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY NOT NULL,
      remote_host_id TEXT,
      sdk_session_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY NOT NULL,
      client_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      rewind_at INTEGER
    );
  `);
  db.prepare(
    "INSERT INTO sessions (id, remote_host_id, sdk_session_id, status) VALUES ('s1', 'psb:old', 'native-old', 'active')",
  ).run();
  return db;
}

function rebindArgs(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 's1',
    expectedRemoteHostId: 'psb:old',
    remoteHostId: 'psb:new',
    workspaceId: 'ws-1',
    clearNativeSession: true,
    marker: {
      id: 'marker-1',
      clientId: 'context-rebuild:1',
      content: JSON.stringify({
        handoff: 'earlier history',
        consumed: false,
        reason: 'remote-session-rebind',
        sourceUserClientId: null,
      }),
      createdAt: 42,
    },
    updatedAt: 123,
    ...overrides,
  };
}

function readSession(db: Database.Database) {
  return db.prepare(
    'SELECT remote_host_id AS remoteHostId, sdk_session_id AS sdkSessionId, updated_at AS updatedAt FROM sessions WHERE id = ?',
  ).get('s1') as { remoteHostId: string | null; sdkSessionId: string | null; updatedAt: number };
}

function readMarkers(db: Database.Database) {
  return db.prepare(
    "SELECT id, client_id AS clientId, role, content, created_at AS createdAt, rewind_at AS rewindAt FROM messages WHERE role = 'context_rebuild'",
  ).all() as Array<{
    id: string;
    clientId: string;
    role: string;
    content: string;
    createdAt: number;
    rewindAt: number;
  }>;
}

describe('session.remoteRebind transaction', () => {
  it('rebinds the identity, clears the native session and stores the handoff marker atomically', () => {
    const db = createDb();
    const result = tx(db, { name: 'session.remoteRebind', args: rebindArgs() });

    expect(result).toEqual({ status: 'persisted' });
    expect(readSession(db)).toEqual({
      remoteHostId: 'psb:new',
      sdkSessionId: null,
      updatedAt: 123,
    });
    const markers = readMarkers(db);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ id: 'marker-1', clientId: 'context-rebuild:1', createdAt: 42 });
    // 隐藏行：rewind_at 固定非空（普通历史读取按它过滤），交接内容与 reason 原样落库。
    expect(markers[0]!.rewindAt).toBe(42);
    expect(JSON.parse(markers[0]!.content)).toMatchObject({
      handoff: 'earlier history',
      consumed: false,
      reason: 'remote-session-rebind',
    });
  });

  it('writes nothing when the CAS sees a different remote identity (concurrent rebind)', () => {
    const db = createDb();
    // 另一实例已经把身份换成了 psb:other。
    db.prepare("UPDATE sessions SET remote_host_id = 'psb:other' WHERE id = 's1'").run();

    expect(tx(db, { name: 'session.remoteRebind', args: rebindArgs() })).toEqual({ status: 'conflict' });
    expect(readSession(db)).toMatchObject({ remoteHostId: 'psb:other', sdkSessionId: 'native-old' });
    expect(readMarkers(db)).toEqual([]);
  });

  it('keeps the native session when the caller explicitly does not clear it (and stores no handoff)', () => {
    const db = createDb();
    expect(tx(db, {
      name: 'session.remoteRebind',
      args: rebindArgs({ clearNativeSession: false, marker: null }),
    })).toEqual({ status: 'persisted' });
    expect(readSession(db)).toMatchObject({ remoteHostId: 'psb:new', sdkSessionId: 'native-old' });
    expect(readMarkers(db)).toEqual([]);
  });

  it('refuses to rebind a deleted task', () => {
    const db = createDb();
    db.prepare("UPDATE sessions SET status = 'deleted' WHERE id = 's1'").run();
    expect(tx(db, { name: 'session.remoteRebind', args: rebindArgs() })).toEqual({ status: 'conflict' });
    expect(readMarkers(db)).toEqual([]);
  });
});
