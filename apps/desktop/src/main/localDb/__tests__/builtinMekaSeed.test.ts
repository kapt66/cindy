import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import combatDevelopmentRole from '../../../../resources/meka/roles/combat-development.json';
import generalDevelopmentRole from '../../../../resources/meka/roles/general-development.json';

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
      meka_role_id text REFERENCES meka_roles(id) ON DELETE SET NULL
    );
  `);
  return db;
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe('builtin Meka project registry', () => {
  it('keeps SAGA2 gameplay roles business-first for non-technical planners', () => {
    expect(combatDevelopmentRole.prompt).toContain('面向策划的工作契约');
    expect(combatDevelopmentRole.prompt).toContain('不得要求策划填写 typ');
    expect(combatDevelopmentRole.prompt).toContain('只有以下情况可以向策划提问');
    expect(combatDevelopmentRole.promptFragments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'combat-evidence-budget',
          path: 'prompts/combat-evidence-budget.md',
        }),
      ]),
    );
    expect(generalDevelopmentRole.prompt).toContain(
      'natural-language business intent as the input contract',
    );
    expect(generalDevelopmentRole.prompt).toContain('Do not ask the user for module types');
    expect(generalDevelopmentRole.includeAllProjectMetadata).toBe(false);
    expect(generalDevelopmentRole.promptFragments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'combat-evidence-budget',
          path: 'prompts/combat-evidence-budget.md',
        }),
      ]),
    );
  });

  it('seeds SAGA2, its default role and its two gameplay roles idempotently and backfills Meka sessions', () => {
    const db = createDb();
    db.prepare("INSERT INTO sessions (id, workspace_kind) VALUES ('meka-session', 'meka')").run();

    seedBuiltinMekaProjects(db, 100);
    seedBuiltinMekaProjects(db, 200);

    expect(BUILTIN_MEKA_PROJECTS).toHaveLength(1);
    expect(db.prepare('SELECT id, path, is_builtin FROM meka_projects').all()).toEqual([
      { id: 'saga2', path: 'saga2', is_builtin: 1 },
    ]);
    // The shared default role sorts first so a new draft starts on it in every project.
    expect(
      db
        .prepare('SELECT id, file_path FROM meka_roles WHERE project_id = ? ORDER BY sort_order')
        .all('saga2'),
    ).toEqual([
      { id: 'saga2-default-role', file_path: 'meka/roles/saga2-default-role.json' },
      { id: 'general-development', file_path: 'meka/roles/general-development.json' },
      { id: 'combat-development', file_path: 'meka/roles/combat-development.json' },
    ]);
    expect(
      db
        .prepare('SELECT meka_project_id, meka_role_id FROM sessions WHERE id = ?')
        .get('meka-session'),
    ).toEqual({ meka_project_id: 'saga2', meka_role_id: null });
  });

  it('gives every registered project a default role without touching user-owned roles', () => {
    const db = createDb();
    db.prepare(
      `INSERT INTO meka_projects
        (id, name, path, tags, is_builtin, sort_order)
       VALUES ('custom', 'custom', 'C:/custom', '[]', 0, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO meka_roles
        (id, project_id, name, display_name, file_path, is_builtin, sort_order)
       VALUES ('custom-role', 'custom', 'custom-role', 'My role', 'meka-roles/custom-role.json', 0, 0)`,
    ).run();

    seedBuiltinMekaProjects(db, 100);

    expect(
      db
        .prepare('SELECT id, is_builtin FROM meka_roles WHERE project_id = ? ORDER BY sort_order')
        .all('custom'),
    ).toEqual([
      { id: 'custom-default-role', is_builtin: 1 },
      { id: 'custom-role', is_builtin: 0 },
    ]);
    // Idempotent: a second pass must not duplicate or re-own the row.
    seedBuiltinMekaProjects(db, 200);
    expect(
      db
        .prepare('SELECT id, is_builtin FROM meka_roles WHERE project_id = ? ORDER BY sort_order')
        .all('custom'),
    ).toEqual([
      { id: 'custom-default-role', is_builtin: 1 },
      { id: 'custom-role', is_builtin: 0 },
    ]);
  });

  it('never adopts or overwrites a user-owned row sitting on the derived default-role id', () => {
    const db = createDb();
    db.prepare(
      `INSERT INTO meka_projects
        (id, name, path, tags, is_builtin, sort_order)
       VALUES ('custom', 'custom', 'C:/custom', '[]', 0, 1)`,
    ).run();
    // A user-owned role occupying the id the seed derives. This is the branch the
    // `WHERE ... AND meka_roles.is_builtin = 1` guard exists for: without the guard the
    // DO UPDATE would rewrite the user's role into a read-only built-in one.
    db.prepare(
      `INSERT INTO meka_roles
        (id, project_id, name, display_name, description, tags, file_path,
         is_builtin, sort_order)
       VALUES ('custom-default-role', 'custom', 'mine', 'My precious role', 'keep me',
               '["user"]', 'meka-roles/mine.json', 0, 7)`,
    ).run();

    seedBuiltinMekaProjects(db, 100);

    expect(
      db
        .prepare(
          `SELECT display_name, description, tags, is_builtin, sort_order
             FROM meka_roles WHERE id = 'custom-default-role'`,
        )
        .get(),
    ).toEqual({
      display_name: 'My precious role',
      description: 'keep me',
      tags: '["user"]',
      is_builtin: 0,
      sort_order: 7,
    });
    // The guard skipping the update is a silent no-op, not an error: seeding still succeeds
    // and the project's own roles are untouched (no duplicate built-in row was added for it).
    expect(
      db.prepare('SELECT id, is_builtin FROM meka_roles WHERE project_id = ?').all('custom'),
    ).toEqual([{ id: 'custom-default-role', is_builtin: 0 }]);
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
    // The bundled SAGA2 gameplay roles must not be injected into a user-owned project. The
    // shared default role is the one exception: it belongs to every project by contract.
    expect(db.prepare('SELECT id, is_builtin FROM meka_roles ORDER BY id').all()).toEqual([
      { id: 'saga2-default-role', is_builtin: 1 },
    ]);
  });

  it('migrates sessions from retired SAGA2 roles before removing those builtin rows', () => {
    const db = createDb();
    db.prepare(
      `INSERT INTO meka_projects
        (id, name, path, tags, is_builtin, sort_order)
       VALUES ('saga2', 'saga2', 'saga2', '[]', 1, 0)`,
    ).run();
    const insertRole = db.prepare(
      `INSERT INTO meka_roles
        (id, project_id, name, display_name, file_path, is_builtin, sort_order)
       VALUES (?, 'saga2', ?, ?, ?, 1, ?)`,
    );
    const retired = [
      ['combat-config', 'combat-development'],
      ['combat-debug', 'combat-development'],
      ['system-development', 'general-development'],
      ['system-overview', 'general-development'],
      ['system-debug', 'general-development'],
    ] as const;
    retired.forEach(([id], index) => {
      insertRole.run(id, id, id, `meka/roles/${id}.json`, index);
      db.prepare(
        `INSERT INTO sessions
          (id, workspace_kind, meka_project_id, meka_role_id)
         VALUES (?, 'meka', 'saga2', ?)`,
      ).run(`session-${id}`, id);
    });
    db.prepare(
      `INSERT INTO sessions
        (id, workspace_kind, meka_project_id, meka_role_id)
       VALUES ('non-meka-session', 'chat', 'saga2', 'combat-config')`,
    ).run();
    db.prepare(
      `INSERT INTO sessions
        (id, workspace_kind, meka_role_id)
       VALUES ('unbound-combat-session', 'meka', 'combat-config')`,
    ).run();

    seedBuiltinMekaProjects(db, 100);

    expect(
      db.prepare('SELECT id FROM meka_roles WHERE project_id = ? ORDER BY sort_order').all('saga2'),
    ).toEqual([
      { id: 'saga2-default-role' },
      { id: 'general-development' },
      { id: 'combat-development' },
    ]);
    const expectedSessions: Array<{ id: string; meka_role_id: string | null }> = retired.map(
      ([retiredId, replacementId]) => ({
        id: `session-${retiredId}`,
        meka_role_id: replacementId,
      }),
    );
    expectedSessions.push({ id: 'non-meka-session', meka_role_id: null });
    expectedSessions.push({ id: 'unbound-combat-session', meka_role_id: 'combat-development' });
    expect(db.prepare('SELECT id, meka_role_id FROM sessions ORDER BY id').all()).toEqual(
      expectedSessions.sort((left, right) => left.id.localeCompare(right.id)),
    );
  });
});
