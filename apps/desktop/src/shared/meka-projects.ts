/** Pure shared contracts for Meka projects and roles. Main owns DB and files. */

import type Database from 'better-sqlite3';

import combatDevelopmentRole from '../../resources/meka/roles/combat-development.json';

export type MekaProjectMetadataItemType = 'agents-md' | 'skill' | 'rule' | 'mcp';

export interface MekaRoleRule {
  id: string;
  text: string;
  enabled: boolean;
}

export interface MekaRoleSkillSelection {
  skillId: string;
  enabled: boolean;
}

export interface MekaSkillCatalogEntry {
  skillId: string;
  displayName?: string;
  category: string;
  subCategory: string;
  description: string;
  purpose?: string;
  filePath: string;
}

/** @deprecated Read-only compatibility for old path-based role manifests. */
export interface MekaRoleSkillEntry {
  id: string;
  path: string;
  description?: string;
}

/** @deprecated New role manifests use the inline prompt field. */
export interface MekaRolePromptFragment {
  id: string;
  path: string;
}

export interface MekaProjectMetadataSelection {
  /** Absolute metadata root; omitted for the primary project path. */
  rootPath?: string;
  sourcePath: string;
  itemType: MekaProjectMetadataItemType;
  enabled: boolean;
}

/** 一条项目参考文件的投递单元。正文刻意不在其中（渐进披露：只给地址 + 描述）。 */
export interface MekaProjectReference {
  /**
   * 作用范围：该文档治理的目录（posix 路径，`''` 表示该项 root 本身）。
   *
   * 参照系是**该条目自己的 root**，不是永远相对 `projectRoot`：主项目元数据（未写 `rootPath`）
   * 的原点就是 `projectRoot`；来自 `additionalPaths` 附加根的条目（写有 `rootPath`）原点则是该
   * 附加根。作用范围只描述相对位置，文件本身的位置一律以 `path` 为准。
   */
  scope: string;
  /** 参考文件的绝对路径。 */
  path: string;
  /** 有界、确定性的描述（≤300 字符）；不得由模型生成。 */
  description: string;
  itemType: 'agents-md' | 'rule';
}

export interface MekaRoleMcpProviderRef {
  id: string;
  providerId: string;
  enabled?: boolean;
}

export interface MekaRoleMcpInlineConfig {
  id: string;
  transport: 'stdio' | 'sse' | 'http';
  enabled?: boolean;
  command?: string;
  args?: string[];
  url?: string;
  /** Values must use `{{secret:name}}`; raw credentials are rejected at the Main boundary. */
  env?: Record<string, string>;
}

export type MekaRoleMcpEntry = MekaRoleMcpProviderRef | MekaRoleMcpInlineConfig;

export type MekaRoleWorkflow = 'saga2-combat-development-v1';

export interface MekaProjectDefaultMetadataSelection {
  /** Absolute metadata root; omitted for the primary project path. */
  rootPath?: string;
  sourcePath: string;
  itemType: MekaProjectMetadataItemType;
}

export interface MekaRoleExcludeDefaults {
  rules?: string[];
  skills?: string[];
  mcp?: string[];
  metadata?: MekaProjectDefaultMetadataSelection[];
}

export interface MekaRoleConfig {
  id: string;
  name: string;
  displayName: string;
  description?: string;
  tags?: string[];
  policyProviderRefs?: string[];
  /** Host-enforced workflow attached automatically with the role. */
  workflow?: MekaRoleWorkflow;
  prompt?: string;
  rules?: MekaRoleRule[];
  skills: Array<MekaRoleSkillSelection | MekaRoleSkillEntry>;
  projectMetadataSelection?: MekaProjectMetadataSelection[];
  promptFragments: MekaRolePromptFragment[];
  mcp: MekaRoleMcpEntry[];
  useProjectDefaults?: boolean;
  /** Include every currently enabled project metadata item before applying explicit selections. */
  includeAllProjectMetadata?: boolean;
  /**
   * Include every skill the bundled catalog currently scans before applying explicit selections.
   *
   * Generic on purpose: it names no skill id, so adding a bundled skill to
   * `resources/meka/skills/**` reaches every role that opts in without touching a role manifest.
   */
  includeAllBundledSkills?: boolean;
  excludeDefaults?: MekaRoleExcludeDefaults;
}

export interface MekaRoleFile extends MekaRoleConfig {
  schemaVersion: 1;
}

export interface MekaRoleManifestFile extends MekaRoleFile {
  projectId: string;
}

export const MEKA_GENERAL_DISCIPLINE = '通用';

/**
 * Display name of the shared built-in default role. Bundled role names are Chinese-only
 * data (see `resources/meka/roles/*.json`), so this follows the same convention instead of
 * introducing a per-locale name that the stored manifest cannot carry.
 */
export const MEKA_DEFAULT_ROLE_DISPLAY_NAME = '默认角色';

const MEKA_DEFAULT_ROLE_ID_SUFFIX = '-default-role';

/**
 * Sort order of the shared default role. Every project-owned role is created with a
 * non-negative order, so this keeps the default role first in every project role list.
 */
export const MEKA_DEFAULT_ROLE_SORT_ORDER = -1;

/**
 * Row id of a project's default role. `meka_roles.id` is a primary key, so the single
 * conceptual "default role of every project" is stored as one row per project with a
 * deterministic id derived from the project id.
 */
export function mekaDefaultRoleId(projectId: string): string {
  return `${projectId}${MEKA_DEFAULT_ROLE_ID_SUFFIX}`;
}

/**
 * Behavior contract of the shared default role: identify the kind of work, settle the contracts
 * first, integrate across the affected layers and close with tests plus an acceptance check; take
 * business intent as the input contract; and diagnose and contain a failing dependency call
 * instead of aborting the whole task.
 *
 * It is the retired "general development" prompt minus its SAGA2 combat-workflow paragraph: this
 * role never carries a `workflow`, so combat-only instructions (bundled combat skills, the legacy
 * module editor import/export path, "no Play Mode") would be dangling orders with no host gate
 * behind them.
 */
const MEKA_DEFAULT_ROLE_PROMPT = `Identify whether the target needs design, local project, configuration, or remote-service work. Establish the relevant contracts first, integrate changes across affected layers, and finish with focused tests plus an acceptance check appropriate to the request.

For any SAGA2 gameplay request, treat the user's natural-language business intent as the input contract. The user should only need to describe desired player-facing behavior, trigger, target, timing, effect, repetition, stacking, termination, and relevant balance or presentation goals. Do not ask the user for module types, target arrays, protocol fields, JSON, editor commands, P4 operations, server paths, or Unity CLI commands. Translate the business intent into technical work internally, infer details from project evidence, and ask only one focused business question when an unresolved choice would change gameplay. If a client/server capability is missing, report the business effect that cannot be guaranteed and the smallest business-level alternatives; never invent a field or make the user design the implementation.

When a concrete dependency call fails, perform the safe diagnostics and recovery actions exposed by its receipt before asking the user; block only that dependency, preserve completed work, and give an exact user action plus retry point when credentials, network, or deployment work cannot be handled by the Agent.`;

/**
 * The shared built-in default role: factory-inclusive, progressively delivered.
 *
 * Everything the role can offer is already on by default — the project's role defaults
 * (`useProjectDefaults`: prompt framework, skills, MCP, metadata selections), every enabled
 * project metadata item (`includeAllProjectMetadata`) and every skill the bundled catalog scans
 * (`includeAllBundledSkills`) — so a new draft configured nothing and still sees the whole
 * project plus the whole bundled catalog. Nothing large is inlined: `agents-md` / `rule` items are
 * handed over as bounded address + description references (`MekaProjectReference`) that the agent
 * reads on demand, and skills ride the harness-native catalog (never this prompt).
 *
 * It deliberately carries no `workflow`: the injection layer enters combat only through
 * `workflow === 'saga2-combat-development-v1'`, and no combat prompt fragments are attached
 * either (they all assume that workflow's injected keys).
 */
export function mekaDefaultRoleManifest(projectId: string): MekaRoleManifestFile {
  const id = mekaDefaultRoleId(projectId);
  return {
    schemaVersion: 1,
    id,
    projectId,
    name: id,
    displayName: MEKA_DEFAULT_ROLE_DISPLAY_NAME,
    // Same host policies the retired general-development role declared.
    policyProviderRefs: ['meka-host-risk-policy', 'meka-p4-boundary-policy'],
    // Absorb the project's roleDefaults and select every enabled project metadata item instead
    // of listing them here; the selections stay empty so the two sources cannot drift apart.
    useProjectDefaults: true,
    includeAllProjectMetadata: true,
    // Third source: the skills under `resources/meka/skills/**` are *scanned* resources, so they
    // are "scanned skills" too and belong to this role. Naming them here would drift the moment
    // the package ships another one, hence the generic switch instead of an id list.
    includeAllBundledSkills: true,
    prompt: MEKA_DEFAULT_ROLE_PROMPT,
    rules: [],
    skills: [],
    promptFragments: [],
    // The MCP the retired general-development role pinned. Unlike the project-sourced entries
    // above it cannot be re-derived from the project, so it is declared explicitly.
    mcp: [{ id: 'meka-design', providerId: 'meka-design', enabled: true }],
    projectMetadataSelection: [],
  };
}

/** True only for the shared built-in default role of `role.projectId`. */
export function isMekaDefaultRole(role: {
  id: string;
  projectId: string;
  isBuiltin: boolean;
}): boolean {
  return role.isBuiltin && role.id === mekaDefaultRoleId(role.projectId);
}

/**
 * The role a new Meka draft starts on: the project's shared default role when it has one,
 * otherwise its first role. Selection is explicit rather than positional so it does not
 * depend on the default role's sort order surviving every write path.
 */
export function pickDefaultMekaRole<
  T extends { id: string; projectId: string; isBuiltin: boolean },
>(roles: readonly T[]): T | undefined {
  return roles.find((role) => isMekaDefaultRole(role)) ?? roles[0];
}

export interface MekaProjectMetadataEditable {
  displayName?: string;
  description?: string;
  notes?: string;
}

export interface MekaProjectMetadataConfigItem extends MekaProjectMetadataEditable {
  /** Absolute metadata root; omitted for the primary project path. */
  rootPath?: string;
  sourcePath: string;
  itemType: MekaProjectMetadataItemType;
  disciplines?: string[];
  domains?: string[];
  enabled?: boolean;
  name?: string;
  contentFingerprint?: string;
  subProjectPath?: string | null;
}

export interface MekaProjectRoleDefaults {
  promptFramework?: string;
  rules?: MekaRoleRule[];
  skills?: string[];
  mcp?: MekaRoleMcpEntry[];
  projectMetadataSelection?: MekaProjectDefaultMetadataSelection[];
}

export type MekaWorkflowType = 'none' | 'jira' | 'gitlab';

export interface MekaProjectFile {
  schemaVersion: 1;
  projectId: string;
  basic: {
    name?: string;
    displayName: string;
    description?: string;
    path: string;
    /** Additional read-only roots searched for metadata and attached to Meka sessions. */
    additionalPaths?: string[];
    formalWorkflowEnabled?: boolean;
    jiraProjectKey?: string;
    workflowType?: MekaWorkflowType;
    gitlabProjectUrl?: string;
    disciplines?: string[];
    domains?: string[];
  };
  metadata: MekaProjectMetadataConfigItem[];
  roleDefaults?: MekaProjectRoleDefaults;
  /** Full portable role snapshots materialized when importing a project-owned configuration. */
  builtinRoles?: MekaRoleManifestFile[];
}

export type MekaProjectConfigSource = 'builtin' | 'project';

export interface ProjectConfigLocator {
  projectId: string;
  isBuiltin: boolean;
  projectRoot: string;
  appIsPackaged: boolean;
}

export interface MekaProjectMetadataOverride extends MekaProjectMetadataEditable {
  disciplines: string[];
  domains: string[];
  enabled: boolean;
}

export interface MekaProjectMetadata extends MekaProjectMetadataOverride {
  projectId: string;
  itemType: MekaProjectMetadataItemType;
  sourcePath: string;
  rootPath?: string;
  subProjectPath: string | null;
  name: string;
  contentFingerprint: string;
  content?: string;
}

export interface MekaRole {
  id: string;
  projectId: string;
  name: string;
  displayName: string;
  description: string | null;
  tags: string[];
  filePath: string;
  isBuiltin: boolean;
  contentDigest: string | null;
  sortOrder: number;
  createdAt: number | null;
  updatedAt: number | null;
}

export interface MekaProject {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  path?: string | null;
  additionalPaths?: string[];
  formalWorkflowEnabled?: boolean;
  jiraProjectKey?: string;
  workflowType?: MekaWorkflowType;
  gitlabProjectUrl?: string;
  tags: string[];
  isBuiltin: boolean;
  configSource: MekaProjectConfigSource;
  /**
   * No usable configuration could be loaded for this project: the directory or its
   * `.meka/project.json` is gone, unreadable or invalid. The registration stays listed so the
   * sessions created in it remain reachable, but its name/path are no longer trustworthy —
   * callers must offer removing the registration rather than presenting an editable project.
   */
  configUnavailable: boolean;
  sortOrder: number;
  createdAt: number | null;
  updatedAt: number | null;
  roles: readonly MekaRole[];
}

type BuiltinRoleId = 'combat-development';

interface ImportedBuiltinRoleManifest {
  id: string;
  projectId: string;
  name: string;
  displayName: string;
  description: string;
  tags?: readonly string[];
}

const BUILTIN_ROLE_FILES: readonly {
  id: BuiltinRoleId;
  manifest: ImportedBuiltinRoleManifest;
}[] = [{ id: 'combat-development', manifest: combatDevelopmentRole }];

/**
 * Retired built-in role ids whose replacement is a fixed role id, so the mapping is
 * project-independent. Ids that must be rebound to the *session's own* project default role do
 * not belong here — see {@link RETIRED_BUILTIN_MEKA_DEFAULT_ROLE_ALIASES}.
 */
export const RETIRED_BUILTIN_MEKA_ROLE_MAPPINGS = [
  ['combat-config', 'combat-development'],
  ['combat-debug', 'combat-development'],
] as const;

/**
 * Retired built-in role ids that used to sit next to the shared default role and are now folded
 * into it. Their replacement id is `<projectId>-default-role`, which depends on the session's
 * project and therefore cannot be expressed as a `[retiredId, replacementId]` pair;
 * `seedBuiltinMekaProjects` rebinds them with a dedicated statement derived from
 * `meka_project_id` instead.
 */
export const RETIRED_BUILTIN_MEKA_DEFAULT_ROLE_ALIASES = [
  'general-development',
  'system-development',
  'system-overview',
  'system-debug',
] as const;

const BUILTIN_MEKA_ROLES: readonly MekaRole[] = [
  // The shared default role always sorts first so a new draft in any project starts on it.
  {
    id: mekaDefaultRoleId('saga2'),
    projectId: 'saga2',
    name: mekaDefaultRoleId('saga2'),
    displayName: MEKA_DEFAULT_ROLE_DISPLAY_NAME,
    description: null,
    tags: ['builtin', 'default'],
    filePath: `meka/roles/${mekaDefaultRoleId('saga2')}.json`,
    isBuiltin: true,
    contentDigest: null,
    sortOrder: MEKA_DEFAULT_ROLE_SORT_ORDER,
    createdAt: null,
    updatedAt: null,
  },
  ...BUILTIN_ROLE_FILES.map(({ id, manifest }, index) => ({
    id,
    projectId: manifest.projectId,
    name: manifest.name,
    displayName: manifest.displayName,
    description: manifest.description,
    tags: [...(manifest.tags ?? [])],
    filePath: `meka/roles/${id}.json`,
    isBuiltin: true,
    contentDigest: null,
    sortOrder: index,
    createdAt: null,
    updatedAt: null,
  })),
];

export const BUILTIN_MEKA_PROJECTS: readonly MekaProject[] = [
  {
    id: 'saga2',
    name: 'saga2',
    displayName: 'SAGA2',
    description: 'SAGA2 项目',
    path: 'saga2',
    tags: ['builtin', 'saga2'],
    isBuiltin: true,
    configSource: 'builtin',
    configUnavailable: false,
    sortOrder: 0,
    createdAt: null,
    updatedAt: null,
    roles: BUILTIN_MEKA_ROLES,
  },
];

/**
 * Converge the bundled project registry without overwriting user-owned rows.
 * This runs after migrations on writable startup so clean Cindy databases and
 * databases upgraded from an older Meka build see the same bundled catalog.
 *
 * It also converges the shared built-in default role for *every* registered project,
 * including user-created ones, so the factory-inclusive default role exists in projects that
 * predate the feature. Retired built-in role rows are re-pointed at that default role before
 * they are deleted, so no session loses its role binding to `ON DELETE SET NULL`.
 */
export function seedBuiltinMekaProjects(db: Database.Database, now = Date.now()): void {
  const upsertProject = db.prepare(`
    INSERT INTO meka_projects
      (id, name, path, tags, is_builtin, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      path = excluded.path,
      tags = excluded.tags,
      sort_order = excluded.sort_order,
      updated_at = excluded.updated_at
    WHERE meka_projects.is_builtin = 1
  `);
  const upsertRole = db.prepare(`
    INSERT INTO meka_roles
      (id, project_id, name, display_name, description, tags, file_path,
       is_builtin, content_digest, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      project_id = excluded.project_id,
      name = excluded.name,
      display_name = excluded.display_name,
      description = excluded.description,
      tags = excluded.tags,
      file_path = excluded.file_path,
      content_digest = excluded.content_digest,
      sort_order = excluded.sort_order,
      updated_at = excluded.updated_at
    WHERE meka_roles.is_builtin = 1
  `);
  const projectIsBuiltin = db.prepare('SELECT is_builtin FROM meka_projects WHERE id = ?');
  const backfillSessions = db.prepare(`
    UPDATE sessions
    SET meka_project_id = 'saga2'
    WHERE workspace_kind = 'meka' AND meka_project_id IS NULL
  `);
  // Load-bearing: `backfillSessions` runs before the retirement loop in this transaction, so a
  // Meka session can no longer have a NULL project id and the `OR meka_project_id IS NULL` branch
  // is currently unreachable. It stays so that a path which skips the seeding cannot widen the
  // blast radius. Project-derived replacements do not come through here at all — see
  // `rebindRetiredSessionToDefaultRole` below.
  const migrateRetiredSessionRole = db.prepare(`
    UPDATE sessions
    SET meka_role_id = ?
    WHERE meka_role_id = ?
      AND workspace_kind = 'meka'
      AND (meka_project_id = 'saga2' OR meka_project_id IS NULL)
  `);
  // Derived from `meka_project_id` rather than a parameter: the replacement id *is*
  // `mekaDefaultRoleId(session.meka_project_id)`, so it must stay in step with
  // MEKA_DEFAULT_ROLE_ID_SUFFIX. `meka_project_id IS NOT NULL` is required both to keep the
  // concatenation meaningful and to leave sessions the backfill below did not touch alone.
  //
  // The `IN (SELECT id FROM meka_projects)` guard is load-bearing: the target
  // `<projectId>-default-role` row only exists for **registered** projects, and
  // `sessions.meka_project_id` has no foreign key — a session may legitimately survive the
  // removal of its project registration (`migrationReplay.test.ts` pins that "project
  // registration can be dropped while Meka session history is kept"). Without the guard such
  // an orphan session would be rebound to a role row that does not exist, the UPDATE would
  // violate `sessions.meka_role_id → meka_roles(id)`, and the failure would surface while the
  // whole `seedBuiltinMekaProjects` transaction is being applied — i.e. `localDb/index.ts`
  // would fail closed and **the application would not start at all**. With the guard, such a
  // session keeps its retired role id for one statement longer: if that row is the bundled
  // `saga2` one — the only kind `deleteRetiredBuiltinRole` below covers — it is then set to NULL
  // by `ON DELETE SET NULL`, which is exactly the existing semantics of deleting a project or a
  // role; a residual non-`saga2` alias row is not cleaned up at all (an accepted boundary recorded
  // in `docs/migrations/xdmaker-meka-to-cindy.md` §11.26), so that session keeps a role whose
  // manifest is gone and fails on its own at cold start instead of taking startup down. Sessions
  // of registered projects (bundled `saga2` and user-created ones) always match the subquery, so
  // their behavior is unchanged.
  const rebindRetiredSessionToDefaultRole = db.prepare(`
    UPDATE sessions
    SET meka_role_id = meka_project_id || '${MEKA_DEFAULT_ROLE_ID_SUFFIX}'
    WHERE meka_role_id = ?
      AND workspace_kind = 'meka'
      AND meka_project_id IS NOT NULL
      AND meka_project_id IN (SELECT id FROM meka_projects)
  `);
  const deleteRetiredBuiltinRole = db.prepare(`
    DELETE FROM meka_roles
    WHERE id = ? AND project_id = 'saga2' AND is_builtin = 1
  `);
  const allProjectIds = db.prepare('SELECT id FROM meka_projects');
  const ensureDefaultRole = db.prepare(MEKA_DEFAULT_ROLE_UPSERT_SQL);

  db.transaction(() => {
    for (const project of BUILTIN_MEKA_PROJECTS) {
      upsertProject.run(
        project.id,
        project.name,
        project.path,
        JSON.stringify(project.tags),
        project.sortOrder,
        now,
        now,
      );
      const row = projectIsBuiltin.get(project.id) as { is_builtin?: number } | undefined;
      if (row?.is_builtin !== 1) continue;
      for (const role of project.roles) {
        upsertRole.run(
          role.id,
          project.id,
          role.name,
          role.displayName,
          role.description,
          JSON.stringify(role.tags),
          role.filePath,
          role.contentDigest,
          role.sortOrder,
          now,
          now,
        );
      }
    }
    // Custom projects own their rows, so the shared default role is inserted once here
    // instead of through the bundled-project upsert above.
    for (const { id: projectId } of allProjectIds.all() as Array<{ id: string }>) {
      ensureDefaultRole.run(...mekaDefaultRoleUpsertParams(projectId, now));
    }
    backfillSessions.run();
    // Order is load-bearing: the default role rows above must exist (FK), and every unbound
    // Meka session must already carry a project id before the rebind below — otherwise its role
    // column would be cleared by `ON DELETE SET NULL` and the session would fail to cold-start
    // with `is missing its persisted project binding`.
    for (const retiredRoleId of RETIRED_BUILTIN_MEKA_DEFAULT_ROLE_ALIASES) {
      rebindRetiredSessionToDefaultRole.run(retiredRoleId);
      deleteRetiredBuiltinRole.run(retiredRoleId);
    }
    for (const [retiredRoleId, replacementRoleId] of RETIRED_BUILTIN_MEKA_ROLE_MAPPINGS) {
      migrateRetiredSessionRole.run(replacementRoleId, retiredRoleId);
      deleteRetiredBuiltinRole.run(retiredRoleId);
    }
  })();
}

/** Tags recorded on the shared default role row. */
export const MEKA_DEFAULT_ROLE_TAGS = ['builtin', 'default'] as const;

/**
 * Upsert for the shared default role row. Shared with the Main-side provisioning that runs
 * when a project is created, so a project created mid-session and a project converged at
 * startup can never disagree on the row's shape.
 *
 * The conflict clause is guarded on `is_builtin` so a user-owned row can never be adopted
 * or overwritten by the built-in default role.
 */
export const MEKA_DEFAULT_ROLE_UPSERT_SQL = `
  INSERT INTO meka_roles
    (id, project_id, name, display_name, description, tags, file_path,
     is_builtin, content_digest, sort_order, created_at, updated_at)
  VALUES (?, ?, ?, ?, NULL, ?, ?, 1, NULL, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    project_id = excluded.project_id,
    display_name = excluded.display_name,
    updated_at = excluded.updated_at
  WHERE meka_roles.project_id = excluded.project_id AND meka_roles.is_builtin = 1
`;

export function mekaDefaultRoleUpsertParams(projectId: string, now = Date.now()): unknown[] {
  const manifest = mekaDefaultRoleManifest(projectId);
  return [
    manifest.id,
    projectId,
    manifest.name,
    manifest.displayName,
    JSON.stringify(MEKA_DEFAULT_ROLE_TAGS),
    `meka/roles/${manifest.id}.json`,
    MEKA_DEFAULT_ROLE_SORT_ORDER,
    now,
    now,
  ];
}

/**
 * The name stored in `meka_projects.name`. It is read back only as the display fallback used
 * when the portable `.meka/project.json` can no longer be loaded, so it must carry a
 * user-recognizable name — never the generated id a freshly created project keeps in
 * `basic.name`, which would surface as an unidentifiable card once its directory disappears.
 */
export function mekaProjectRegistrationName(file: MekaProjectFile, fallback: string): string {
  return file.basic.displayName.trim() || fallback;
}

export function parseMekaEditableMetadata(input: unknown): MekaProjectMetadataEditable | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const parsed: MekaProjectMetadataEditable = {};
  for (const key of ['displayName', 'description', 'notes'] as const) {
    const value = record[key];
    if (typeof value !== 'string') continue;
    const normalized = value.trim();
    if (normalized) parsed[key] = normalized;
  }
  return Object.keys(parsed).length > 0 ? parsed : null;
}
