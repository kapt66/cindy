/** Pure shared contracts for Meka projects and roles. Main owns DB and files. */

import type Database from 'better-sqlite3';

import combatConfigRole from '../../resources/meka/roles/combat-config.json';
import combatDebugRole from '../../resources/meka/roles/combat-debug.json';
import generalDevelopmentRole from '../../resources/meka/roles/general-development.json';
import systemDebugRole from '../../resources/meka/roles/system-debug.json';
import systemDevelopmentRole from '../../resources/meka/roles/system-development.json';
import systemOverviewRole from '../../resources/meka/roles/system-overview.json';

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

export interface MekaProjectDefaultMetadataSelection {
  sourcePath: string;
  itemType: MekaProjectMetadataItemType;
}

export interface MekaRoleExcludeDefaults {
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
  prompt?: string;
  rules?: MekaRoleRule[];
  skills: Array<MekaRoleSkillSelection | MekaRoleSkillEntry>;
  projectMetadataSelection?: MekaProjectMetadataSelection[];
  promptFragments: MekaRolePromptFragment[];
  mcp: MekaRoleMcpEntry[];
  useProjectDefaults?: boolean;
  excludeDefaults?: MekaRoleExcludeDefaults;
}

export interface MekaRoleFile extends MekaRoleConfig {
  schemaVersion: 1;
}

export interface MekaRoleManifestFile extends MekaRoleFile {
  projectId: string;
}

export const MEKA_GENERAL_DISCIPLINE = '通用';

export interface MekaProjectMetadataEditable {
  displayName?: string;
  description?: string;
  notes?: string;
}

export interface MekaProjectMetadataConfigItem extends MekaProjectMetadataEditable {
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
    formalWorkflowEnabled?: boolean;
    jiraProjectKey?: string;
    workflowType?: MekaWorkflowType;
    gitlabProjectUrl?: string;
    disciplines?: string[];
    domains?: string[];
  };
  metadata: MekaProjectMetadataConfigItem[];
  roleDefaults?: MekaProjectRoleDefaults;
}

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
  formalWorkflowEnabled?: boolean;
  jiraProjectKey?: string;
  workflowType?: MekaWorkflowType;
  gitlabProjectUrl?: string;
  tags: string[];
  isBuiltin: boolean;
  sortOrder: number;
  createdAt: number | null;
  updatedAt: number | null;
  roles: readonly MekaRole[];
}

type BuiltinRoleId =
  | 'general-development'
  | 'combat-debug'
  | 'combat-config'
  | 'system-development'
  | 'system-overview'
  | 'system-debug';

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
  { id: 'combat-debug', manifest: combatDebugRole },
  { id: 'combat-config', manifest: combatConfigRole },
  { id: 'system-development', manifest: systemDevelopmentRole },
  { id: 'system-overview', manifest: systemOverviewRole },
  { id: 'system-debug', manifest: systemDebugRole },
];

const BUILTIN_MEKA_ROLES: readonly MekaRole[] = BUILTIN_ROLE_FILES.map(
  ({ id, manifest }, sortOrder) => ({
    id,
    projectId: manifest.projectId,
    name: manifest.name,
    displayName: manifest.displayName,
    description: manifest.description,
    tags: [...(manifest.tags ?? [])],
    filePath: `meka/roles/${id}.json`,
    isBuiltin: true,
    contentDigest: null,
    sortOrder,
    createdAt: null,
    updatedAt: null,
  }),
);

export const BUILTIN_MEKA_PROJECTS: readonly MekaProject[] = [
  {
    id: 'saga2',
    name: 'saga2',
    displayName: 'SAGA2',
    description: 'SAGA2 项目',
    path: 'saga2',
    tags: ['builtin', 'saga2'],
    isBuiltin: true,
    sortOrder: 0,
    createdAt: null,
    updatedAt: null,
    roles: BUILTIN_MEKA_ROLES,
  },
];

/**
 * Converge the read-only builtin registry without overwriting user-owned rows.
 * This runs after migrations on writable startup so clean Cindy databases and
 * databases upgraded from an older Meka build see the same builtin catalog.
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
    SET meka_project_id = 'saga2', meka_role_id = NULL
    WHERE workspace_kind = 'meka' AND meka_project_id IS NULL
  `);

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
    backfillSessions.run();
  })();
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
