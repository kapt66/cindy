/** Pure shared contracts for Meka projects and roles. Main owns DB and files. */

import type Database from 'better-sqlite3';

import combatDevelopmentRole from '../../resources/meka/roles/combat-development.json';
import generalDevelopmentRole from '../../resources/meka/roles/general-development.json';

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
 * The shared built-in default role: no prompt, rule, skill, MCP or project-metadata
 * selection. A task started with it stays bound to the project workspace but receives no
 * role-level injection, which is the closest Meka equivalent of a plain session.
 */
export function mekaDefaultRoleManifest(projectId: string): MekaRoleManifestFile {
  const id = mekaDefaultRoleId(projectId);
  return {
    schemaVersion: 1,
    id,
    projectId,
    name: id,
    displayName: MEKA_DEFAULT_ROLE_DISPLAY_NAME,
    policyProviderRefs: [],
    rules: [],
    skills: [],
    promptFragments: [],
    mcp: [],
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

type BuiltinRoleId = 'general-development' | 'combat-development';

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
}[] = [
  { id: 'general-development', manifest: generalDevelopmentRole },
  { id: 'combat-development', manifest: combatDevelopmentRole },
];

export const RETIRED_BUILTIN_MEKA_ROLE_MAPPINGS = [
  ['combat-config', 'combat-development'],
  ['combat-debug', 'combat-development'],
  ['system-development', 'general-development'],
  ['system-overview', 'general-development'],
  ['system-debug', 'general-development'],
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
 * including user-created ones, so the "no injection" baseline exists in projects that
 * predate the feature.
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
  const migrateRetiredSessionRole = db.prepare(`
    UPDATE sessions
    SET meka_role_id = ?
    WHERE meka_role_id = ?
      AND workspace_kind = 'meka'
      AND (meka_project_id = 'saga2' OR meka_project_id IS NULL)
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
