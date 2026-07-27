import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { BUILTIN_MEKA_PROJECTS, seedBuiltinMekaProjects } from '../../../shared/meka-projects.js';

const databases: Database.Database[] = [];

function createDb(): Database.Database {
  const db = new Database(':memory:');
  databases.push(db);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE meka_projects (
      id text PRIMARY KEY NOT NULL,
      name text NOT NULL,
      path text,
      tags text,
      is_builtin integer DEFAULT 0 NOT NULL,
      sort_order integer DEFAULT 0 NOT NULL,
      created_at integer,
      updated_at integer
    );
    CREATE TABLE meka_roles (
      id text PRIMARY KEY NOT NULL,
      project_id text NOT NULL REFERENCES meka_projects(id),
      name text NOT NULL,
      display_name text NOT NULL,
      description text,
      tags text,
      file_path text NOT NULL,
      is_builtin integer DEFAULT 0 NOT NULL,
      content_digest text,
      sort_order integer DEFAULT 0 NOT NULL,
      created_at integer,
      updated_at integer
    );
    CREATE TABLE sessions (
      id text PRIMARY KEY NOT NULL,
      workspace_kind text NOT NULL,
      meka_project_id text REFERENCES meka_projects(id),
      meka_role_id text REFERENCES meka_roles(id)
    );
  `);
  return db;
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe('builtin Meka project registry', () => {
  it('seeds SAGA2 and its six roles idempotently and backfills Meka sessions', () => {
    const db = createDb();
    db.prepare("INSERT INTO sessions (id, workspace_kind) VALUES ('meka-session', 'meka')").run();

    seedBuiltinMekaProjects(db, 100);
    seedBuiltinMekaProjects(db, 200);

    expect(BUILTIN_MEKA_PROJECTS).toHaveLength(1);
    expect(db.prepare('SELECT id, path, is_builtin FROM meka_projects').all()).toEqual([
      { id: 'saga2', path: 'saga2', is_builtin: 1 },
    ]);
    expect(
      db
        .prepare('SELECT id, file_path FROM meka_roles WHERE project_id = ? ORDER BY sort_order')
        .all('saga2'),
    ).toEqual([
      { id: 'general-development', file_path: 'meka/roles/general-development.json' },
      { id: 'combat-debug', file_path: 'meka/roles/combat-debug.json' },
      { id: 'combat-config', file_path: 'meka/roles/combat-config.json' },
      { id: 'system-development', file_path: 'meka/roles/system-development.json' },
      { id: 'system-overview', file_path: 'meka/roles/system-overview.json' },
      { id: 'system-debug', file_path: 'meka/roles/system-debug.json' },
    ]);
    expect(
      db
        .prepare('SELECT meka_project_id, meka_role_id FROM sessions WHERE id = ?')
        .get('meka-session'),
    ).toEqual({ meka_project_id: 'saga2', meka_role_id: null });
  });

  it('does not overwrite a user-owned project with the reserved builtin id', () => {
    const db = createDb();
    db.prepare(
      `INSERT INTO meka_projects
        (id, name, path, tags, is_builtin, sort_order)
       VALUES ('saga2', 'personal', 'C:/personal', '[]', 0, 4)`,
    ).run();

    seedBuiltinMekaProjects(db, 100);

    expect(
      db
        .prepare('SELECT name, path, is_builtin, sort_order FROM meka_projects WHERE id = ?')
        .get('saga2'),
    ).toEqual({
      name: 'personal',
      path: 'C:/personal',
      is_builtin: 0,
      sort_order: 4,
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM meka_roles').get()).toEqual({
      count: 0,
    });
  });
});
