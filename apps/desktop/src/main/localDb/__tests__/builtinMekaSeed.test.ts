import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import combatDevelopmentRole from '../../../../resources/meka/roles/combat-development.json';

import {
  BUILTIN_MEKA_PROJECTS,
  mekaDefaultRoleManifest,
  RETIRED_BUILTIN_MEKA_DEFAULT_ROLE_ALIASES,
  RETIRED_BUILTIN_MEKA_ROLE_MAPPINGS,
  seedBuiltinMekaProjects,
} from '../../../shared/meka-projects.js';

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
  it('keeps the bundled SAGA2 combat role business-first for non-technical planners', () => {
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
  });

  it('gives the seeded default role a factory-inclusive manifest that stays out of combat', () => {
    const manifest = mekaDefaultRoleManifest('saga2');

    expect(manifest).toMatchObject({
      id: 'saga2-default-role',
      projectId: 'saga2',
      displayName: '默认角色',
      policyProviderRefs: ['meka-host-risk-policy', 'meka-p4-boundary-policy'],
      // All three opt-in flags: project role defaults, every enabled project metadata item and every
      // skill the bundled catalog scans. The explicit lists below stay empty so those flags remain
      // the single source — except `mcp`, which the manifest declares because the pinned
      // `meka-design` entry cannot be re-derived from the project.
      useProjectDefaults: true,
      includeAllProjectMetadata: true,
      includeAllBundledSkills: true,
      rules: [],
      skills: [],
      promptFragments: [],
      mcp: [{ id: 'meka-design', providerId: 'meka-design', enabled: true }],
      projectMetadataSelection: [],
    });
    // `workflow` is the single key the injection layer enters the combat contract through, so a
    // default role carrying it would attach the combat host gate to every new draft.
    expect(manifest.workflow).toBeUndefined();
    // The prompt keeps the three capability contracts ...
    expect(manifest.prompt).toContain('Establish the relevant contracts first');
    expect(manifest.prompt).toContain('natural-language business intent as the input contract');
    expect(manifest.prompt).toContain('When a concrete dependency call fails');
    // ... and drops the retired general-development SAGA2 combat-escalation paragraph, whose
    // bundled skills and legacy module-editor workflow this role no longer carries.
    expect(manifest.prompt).not.toContain('legacy_module_export_json');
    expect(manifest.prompt).not.toContain('saga2-entry-model');
  });

  it('declares only the fixed retired-role mappings plus the default-role aliases', () => {
    expect(RETIRED_BUILTIN_MEKA_ROLE_MAPPINGS).toEqual([
      ['combat-config', 'combat-development'],
      ['combat-debug', 'combat-development'],
    ]);
    expect(RETIRED_BUILTIN_MEKA_DEFAULT_ROLE_ALIASES).toEqual([
      'general-development',
      'system-development',
      'system-overview',
      'system-debug',
    ]);

    const bundledRoleIds = BUILTIN_MEKA_PROJECTS.flatMap((project) =>
      project.roles.map((role) => role.id),
    );
    // The shared default role plus the one remaining bundled gameplay role. A bundled
    // `general-development` row must not come back: its manifest file is gone, so any session
    // bound to it would hard-fail in `readBuiltinRoleManifest`.
    expect(bundledRoleIds).toEqual(['saga2-default-role', 'combat-development']);

    const mappedIds = RETIRED_BUILTIN_MEKA_ROLE_MAPPINGS.map(([roleId]) => roleId);
    const retiredIds = new Set<string>([...mappedIds, ...RETIRED_BUILTIN_MEKA_DEFAULT_ROLE_ALIASES]);
    for (const roleId of bundledRoleIds) expect(retiredIds.has(roleId)).toBe(false);
    // Every fixed replacement still exists in the bundled catalog, so a rebind cannot dangle.
    for (const [, replacementRoleId] of RETIRED_BUILTIN_MEKA_ROLE_MAPPINGS) {
      expect(bundledRoleIds).toContain(replacementRoleId);
    }
    // Aliases are rebound to `<projectId>-default-role` by a dedicated statement, so no alias may
    // also carry a fixed replacement — the two tables must stay disjoint.
    for (const alias of RETIRED_BUILTIN_MEKA_DEFAULT_ROLE_ALIASES) {
      expect(mappedIds).not.toContain(alias);
    }
  });

  it('seeds SAGA2, its default role and its one bundled gameplay role idempotently and backfills Meka sessions', () => {
    const db = createDb();
    db.prepare("INSERT INTO sessions (id, workspace_kind) VALUES ('meka-session', 'meka')").run();

    seedBuiltinMekaProjects(db, 100);
    seedBuiltinMekaProjects(db, 200);

    expect(BUILTIN_MEKA_PROJECTS).toHaveLength(1);
    expect(db.prepare('SELECT id, path, is_builtin FROM meka_projects').all()).toEqual([
      { id: 'saga2', path: 'saga2', is_builtin: 1 },
    ]);
    // Two rows only: the shared default role (always first, `sort_order` -1, so a new draft starts
    // on it in every project) and the one bundled gameplay role. The retired general-development
    // row is never seeded back.
    expect(
      db
        .prepare(
          `SELECT id, display_name, file_path, is_builtin, tags, sort_order
             FROM meka_roles WHERE project_id = ? ORDER BY sort_order`,
        )
        .all('saga2'),
    ).toEqual([
      {
        id: 'saga2-default-role',
        display_name: '默认角色',
        file_path: 'meka/roles/saga2-default-role.json',
        is_builtin: 1,
        tags: '["builtin","default"]',
        sort_order: -1,
      },
      {
        id: 'combat-development',
        display_name: '战斗开发',
        file_path: 'meka/roles/combat-development.json',
        is_builtin: 1,
        tags: '[]',
        sort_order: 0,
      },
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

  it('rebinds sessions of retired builtin roles to the saga2 default role, then deletes those rows', () => {
    const db = createDb();
    db.prepare(
      `INSERT INTO meka_projects
        (id, name, path, tags, is_builtin, sort_order)
       VALUES ('saga2', 'saga2', 'saga2', '[]', 1, 0)`,
    ).run();
    const insertRole = db.prepare(
      `INSERT INTO meka_roles
        (id, project_id, name, display_name, file_path, is_builtin, sort_order)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
    );
    const saga2RetiredIds = [
      'general-development',
      'system-development',
      'system-overview',
      'system-debug',
      'combat-config',
      'combat-debug',
    ];
    saga2RetiredIds.forEach((id, index) => {
      insertRole.run(id, 'saga2', id, id, `meka/roles/${id}.json`, index);
    });

    const insertSession = db.prepare(
      `INSERT INTO sessions (id, workspace_kind, meka_project_id, meka_role_id)
       VALUES (?, ?, ?, ?)`,
    );
    for (const id of saga2RetiredIds) insertSession.run(`saga2-${id}`, 'meka', 'saga2', id);
    // Sessions whose project was never persisted must be backfilled to saga2 *before* the rebind:
    // with the rebind first, the deleted rows would clear the binding through ON DELETE SET NULL.
    insertSession.run('unbound-alias-session', 'meka', null, 'system-debug');
    insertSession.run('unbound-combat-session', 'meka', null, 'combat-config');
    // A non-Meka workspace is never rebound, so its binding is lost with the deleted row instead of
    // being moved onto the session's project default role.
    insertSession.run('chat-saga2-session', 'chat', 'saga2', 'combat-config');

    seedBuiltinMekaProjects(db, 100);

    expect(
      db
        .prepare('SELECT id FROM meka_roles WHERE project_id = ? ORDER BY sort_order, id')
        .all('saga2'),
    ).toEqual([{ id: 'saga2-default-role' }, { id: 'combat-development' }]);

    expect(
      db.prepare('SELECT id, meka_project_id, meka_role_id FROM sessions ORDER BY id').all(),
    ).toEqual([
      { id: 'chat-saga2-session', meka_project_id: 'saga2', meka_role_id: null },
      { id: 'saga2-combat-config', meka_project_id: 'saga2', meka_role_id: 'combat-development' },
      { id: 'saga2-combat-debug', meka_project_id: 'saga2', meka_role_id: 'combat-development' },
      {
        id: 'saga2-general-development',
        meka_project_id: 'saga2',
        meka_role_id: 'saga2-default-role',
      },
      { id: 'saga2-system-debug', meka_project_id: 'saga2', meka_role_id: 'saga2-default-role' },
      {
        id: 'saga2-system-development',
        meka_project_id: 'saga2',
        meka_role_id: 'saga2-default-role',
      },
      {
        id: 'saga2-system-overview',
        meka_project_id: 'saga2',
        meka_role_id: 'saga2-default-role',
      },
      { id: 'unbound-alias-session', meka_project_id: 'saga2', meka_role_id: 'saga2-default-role' },
      {
        id: 'unbound-combat-session',
        meka_project_id: 'saga2',
        meka_role_id: 'combat-development',
      },
    ]);
    // No Meka session may end up bound to a role of a *different* project: the replacement is
    // derived from the session's own `meka_project_id`.
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS mismatched
             FROM sessions s JOIN meka_roles r ON r.id = s.meka_role_id
            WHERE s.workspace_kind = 'meka' AND r.project_id <> s.meka_project_id`,
        )
        .get(),
    ).toEqual({ mismatched: 0 });
  });

  it('keeps an unregistered project session out of the rebind instead of failing the whole seed', () => {
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
    insertRole.run('general-development', 'general-development', '通用开发', 'meka/roles/general-development.json', 0);
    insertRole.run('combat-config', 'combat-config', '战斗配置', 'meka/roles/combat-config.json', 1);

    const insertSession = db.prepare(
      `INSERT INTO sessions (id, workspace_kind, meka_project_id, meka_role_id)
       VALUES (?, 'meka', ?, ?)`,
    );
    // 已登记项目：重绑目标真的存在，必须逐条照旧。
    insertSession.run('saga2-alias-session', 'saga2', 'general-development');
    insertSession.run('saga2-combat-session', 'saga2', 'combat-config');
    // 未登记项目：`sessions.meka_project_id` 在生产 schema 里**没有**外键
    // (`localDb/schema.ts` 只给 `meka_role_id` 加了 `ON DELETE SET NULL`)，项目登记可以被删除
    // 而 Meka 会话历史保留。夹具里那个外键是为别的用例加的，这里临时关掉它以构造该真实状态；
    // 重绑语句自己的 `meka_role_id` 外键仍然生效，这正是原实现失败的地方。
    db.pragma('foreign_keys = OFF');
    insertSession.run('orphan-alias-session', 'ghost-project', 'general-development');
    insertSession.run('orphan-combat-session', 'ghost-project', 'combat-config');
    db.pragma('foreign_keys = ON');

    // 原实现会把这两行重绑到 `ghost-project-default-role`（该行不存在）⇒ `meka_role_id` 外键违约
    // ⇒ 整个 `seedBuiltinMekaProjects` 事务失败 ⇒ 应用启动失败。守卫（`meka_project_id IN
    // (SELECT id FROM meka_projects)`）必须让它们原样穿过，且不抛错。
    expect(() => seedBuiltinMekaProjects(db, 100)).not.toThrow();

    // 未登记项目不会长出默认角色行：这正是"目标不存在"的证据。
    expect(
      db.prepare("SELECT id FROM meka_roles WHERE id = 'ghost-project-default-role'").all(),
    ).toEqual([]);
    expect(
      db.prepare('SELECT id, meka_project_id, meka_role_id FROM sessions ORDER BY id').all(),
    ).toEqual([
      // 未登记项目的会话：重绑被守卫跳过，随后退役行被删时由 `ON DELETE SET NULL` 清空角色列
      // （与删除项目/角色时的既有语义一致），绝不产生悬空引用。
      { id: 'orphan-alias-session', meka_project_id: 'ghost-project', meka_role_id: null },
      { id: 'orphan-combat-session', meka_project_id: 'ghost-project', meka_role_id: null },
      // 已登记项目的会话：重绑结果逐条与改动前一致。
      { id: 'saga2-alias-session', meka_project_id: 'saga2', meka_role_id: 'saga2-default-role' },
      { id: 'saga2-combat-session', meka_project_id: 'saga2', meka_role_id: 'combat-development' },
    ]);
    // 幂等：第二次播种不会因为那两行孤儿会话而改写任何东西。
    seedBuiltinMekaProjects(db, 200);
    expect(
      db.prepare('SELECT id, meka_project_id, meka_role_id FROM sessions ORDER BY id').all(),
    ).toEqual([
      { id: 'orphan-alias-session', meka_project_id: 'ghost-project', meka_role_id: null },
      { id: 'orphan-combat-session', meka_project_id: 'ghost-project', meka_role_id: null },
      { id: 'saga2-alias-session', meka_project_id: 'saga2', meka_role_id: 'saga2-default-role' },
      { id: 'saga2-combat-session', meka_project_id: 'saga2', meka_role_id: 'combat-development' },
    ]);
  });

  it("rebinds retired default-role aliases in a user-created project to that project's default role", () => {
    const db = createDb();
    db.prepare(
      `INSERT INTO meka_projects
        (id, name, path, tags, is_builtin, sort_order)
       VALUES ('custom', 'custom', 'C:/custom', '[]', 0, 1)`,
    ).run();
    const insertRole = db.prepare(
      `INSERT INTO meka_roles
        (id, project_id, name, display_name, file_path, is_builtin, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    // `meka_roles.id` is globally unique, so the alias rows of this test can only live here — they
    // are legacy builtin rows no build ever seeded into a user project. `deleteRetiredBuiltinRole`
    // is scoped to `project_id = 'saga2'`, so surviving them is the accepted boundary rather than
    // an oversight; a user-owned row must obviously survive too.
    const aliasIds = [...RETIRED_BUILTIN_MEKA_DEFAULT_ROLE_ALIASES];
    aliasIds.forEach((id) => {
      insertRole.run(id, 'custom', id, id, `meka/roles/${id}.json`, 1, 0);
    });
    insertRole.run('custom-role', 'custom', 'custom-role', 'My role', 'meka-roles/mine.json', 0, 9);

    const insertSession = db.prepare(
      `INSERT INTO sessions (id, workspace_kind, meka_project_id, meka_role_id)
       VALUES (?, ?, ?, ?)`,
    );
    for (const id of aliasIds) insertSession.run(`custom-${id}`, 'meka', 'custom', id);
    insertSession.run('custom-owned-role-session', 'meka', 'custom', 'custom-role');
    // Load-bearing probe for the `workspace_kind = 'meka'` guard: this row survives the seed, so a
    // guard-less statement would silently move the chat session onto custom-default-role.
    insertSession.run('chat-retired-role-session', 'chat', 'custom', 'system-development');

    seedBuiltinMekaProjects(db, 100);

    expect(
      db
        .prepare('SELECT id FROM meka_roles WHERE project_id = ? ORDER BY sort_order, id')
        .all('custom'),
    ).toEqual([
      { id: 'custom-default-role' },
      { id: 'general-development' },
      { id: 'system-debug' },
      { id: 'system-development' },
      { id: 'system-overview' },
      { id: 'custom-role' },
    ]);

    expect(
      db.prepare('SELECT id, meka_project_id, meka_role_id FROM sessions ORDER BY id').all(),
    ).toEqual([
      {
        id: 'chat-retired-role-session',
        meka_project_id: 'custom',
        meka_role_id: 'system-development',
      },
      {
        id: 'custom-general-development',
        meka_project_id: 'custom',
        meka_role_id: 'custom-default-role',
      },
      { id: 'custom-owned-role-session', meka_project_id: 'custom', meka_role_id: 'custom-role' },
      {
        id: 'custom-system-debug',
        meka_project_id: 'custom',
        meka_role_id: 'custom-default-role',
      },
      {
        id: 'custom-system-development',
        meka_project_id: 'custom',
        meka_role_id: 'custom-default-role',
      },
      {
        id: 'custom-system-overview',
        meka_project_id: 'custom',
        meka_role_id: 'custom-default-role',
      },
    ]);
  });

  it('converges retired sessions and default roles idempotently', () => {
    const db = createDb();
    db.prepare(
      `INSERT INTO meka_projects
        (id, name, path, tags, is_builtin, sort_order)
       VALUES ('saga2', 'saga2', 'saga2', '[]', 1, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO meka_projects
        (id, name, path, tags, is_builtin, sort_order)
       VALUES ('custom', 'custom', 'C:/custom', '[]', 0, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO meka_roles
        (id, project_id, name, display_name, file_path, is_builtin, sort_order)
       VALUES ('general-development', 'saga2', 'general-development', '通用开发',
               'meka/roles/general-development.json', 1, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO meka_roles
        (id, project_id, name, display_name, file_path, is_builtin, sort_order)
       VALUES ('system-overview', 'custom', 'system-overview', '系统总览',
               'meka/roles/system-overview.json', 1, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO sessions (id, workspace_kind, meka_project_id, meka_role_id)
       VALUES ('saga2-alias-session', 'meka', 'saga2', 'general-development')`,
    ).run();
    db.prepare(
      `INSERT INTO sessions (id, workspace_kind, meka_project_id, meka_role_id)
       VALUES ('custom-alias-session', 'meka', 'custom', 'system-overview')`,
    ).run();
    db.prepare(
      `INSERT INTO sessions (id, workspace_kind, meka_role_id)
       VALUES ('unbound-session', 'meka', 'general-development')`,
    ).run();

    // `updated_at` is bumped on every converging pass by design, so it is excluded; everything
    // else — including `created_at`, which the upserts must preserve — has to be stable.
    const snapshot = () =>
      JSON.stringify({
        projects: db
          .prepare(
            'SELECT id, name, path, tags, is_builtin, sort_order, created_at FROM meka_projects ORDER BY id',
          )
          .all(),
        roles: db
          .prepare(
            `SELECT id, project_id, name, display_name, description, tags, file_path, is_builtin,
                    content_digest, sort_order, created_at
               FROM meka_roles ORDER BY id, project_id`,
          )
          .all(),
        sessions: db
          .prepare(
            'SELECT id, workspace_kind, meka_project_id, meka_role_id FROM sessions ORDER BY id',
          )
          .all(),
      });

    seedBuiltinMekaProjects(db, 100);
    const afterFirstPass = snapshot();
    seedBuiltinMekaProjects(db, 200);
    expect(snapshot()).toBe(afterFirstPass);

    // Prove the second pass really converged the rows (rather than skipping the migration) and did
    // not re-create what it just deleted.
    expect(
      db.prepare("SELECT updated_at FROM meka_roles WHERE id = 'saga2-default-role'").get(),
    ).toEqual({ updated_at: 200 });
    expect(
      db
        .prepare("SELECT COUNT(*) AS rows FROM meka_roles WHERE project_id = 'saga2'")
        .get(),
    ).toEqual({ rows: 2 });
    // The saga2 alias row is gone while the identically-retired custom row survives.
    expect(
      db.prepare("SELECT project_id FROM meka_roles WHERE id = 'system-overview'").all(),
    ).toEqual([{ project_id: 'custom' }]);
    expect(
      db.prepare('SELECT id, meka_project_id, meka_role_id FROM sessions ORDER BY id').all(),
    ).toEqual([
      {
        id: 'custom-alias-session',
        meka_project_id: 'custom',
        meka_role_id: 'custom-default-role',
      },
      {
        id: 'saga2-alias-session',
        meka_project_id: 'saga2',
        meka_role_id: 'saga2-default-role',
      },
      { id: 'unbound-session', meka_project_id: 'saga2', meka_role_id: 'saga2-default-role' },
    ]);
  });
});
