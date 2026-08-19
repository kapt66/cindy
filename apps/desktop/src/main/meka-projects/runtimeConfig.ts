import { promises as fs } from 'node:fs';
import path from 'node:path';

import { app } from 'electron';
import matter from 'gray-matter';

import type {
  MekaProjectDefaultMetadataSelection,
  MekaProjectFile,
  MekaProjectMetadataSelection,
  MekaProjectRoleDefaults,
  MekaRoleFile,
  MekaRoleMcpEntry,
  MekaRoleRule,
  MekaRoleSkillEntry,
  MekaRoleSkillSelection,
} from '../../shared/meka-projects.js';
import { getDbClient } from '../localDb/client/current.js';
import { createLogger } from '../logger.js';
import { getMekaP4SettingsService } from '../meka-settings/ipc.js';
import {
  SECRET_REFERENCE_RE,
  readBuiltinRoleManifest,
  readCustomRoleManifest,
  readEffectiveProjectConfig,
} from './projectConfig.js';
import { bundledMekaRolesRoot, bundledMekaSkillsRoot } from './resourcePaths.js';

const log = createLogger('meka-projects:runtime-config');
const SAFE_SKILL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_DISCOVERED_SKILL_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KNOWN_POLICY_PROVIDER_REFS = new Set(['meka-host-risk-policy', 'meka-p4-boundary-policy']);

interface ProjectRow {
  id: string;
  path: string | null;
  is_builtin: number;
}

interface RoleRow {
  id: string;
  project_id: string;
  is_builtin: number;
  file_path: string;
}

export interface MekaRuntimeSkill {
  id: string;
  name: string;
  description: string;
  content: string;
  sourceDirectory: string;
  sourceEntryPath: string;
}

export interface MekaRuntimeConfig {
  projectId: string;
  roleId: string;
  promptText: string;
  skills: MekaRuntimeSkill[];
  mcp: MekaRoleMcpEntry[];
  policyProviderRefs: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function metadataKey(
  selection: Pick<MekaProjectDefaultMetadataSelection, 'rootPath' | 'sourcePath' | 'itemType'>,
): string {
  return `${selection.rootPath ?? ''}\0${selection.sourcePath}\0${selection.itemType}`;
}

function isLegacySkill(
  value: MekaRoleSkillSelection | MekaRoleSkillEntry,
): value is MekaRoleSkillEntry {
  return 'path' in value;
}

/** Project defaults are part of the project/role contract, not a separate capability state. */
export function mergeMekaProjectRoleDefaults(
  role: MekaRoleFile,
  defaults: MekaProjectRoleDefaults,
): MekaRoleFile {
  if (role.useProjectDefaults !== true) return role;
  const excludedSkills = new Set(role.excludeDefaults?.skills ?? []);
  const excludedRules = new Set(role.excludeDefaults?.rules ?? []);
  const excludedMcp = new Set(role.excludeDefaults?.mcp ?? []);
  const excludedMetadata = new Set((role.excludeDefaults?.metadata ?? []).map(metadataKey));

  const skills = new Map<string, MekaRoleSkillSelection | MekaRoleSkillEntry>();
  for (const skillId of defaults.skills ?? []) {
    if (!excludedSkills.has(skillId)) skills.set(skillId, { skillId, enabled: true });
  }
  for (const entry of role.skills) {
    skills.set(isLegacySkill(entry) ? entry.id : entry.skillId, entry);
  }

  const rules = new Map<string, MekaRoleRule>();
  for (const rule of defaults.rules ?? []) {
    if (!excludedRules.has(rule.id)) rules.set(rule.id, rule);
  }
  for (const rule of role.rules ?? []) rules.set(rule.id, rule);

  const mcp = new Map<string, MekaRoleMcpEntry>();
  for (const entry of defaults.mcp ?? []) {
    if (!excludedMcp.has(entry.id)) mcp.set(entry.id, entry);
  }
  for (const entry of role.mcp) mcp.set(entry.id, entry);

  const metadata = new Map<string, MekaProjectMetadataSelection>();
  for (const entry of defaults.projectMetadataSelection ?? []) {
    if (!excludedMetadata.has(metadataKey(entry))) {
      metadata.set(metadataKey(entry), { ...entry, enabled: true });
    }
  }
  for (const entry of role.projectMetadataSelection ?? []) {
    metadata.set(metadataKey(entry), entry);
  }

  const framework = defaults.promptFramework?.trim();
  const ownPrompt = role.prompt?.trim();
  return {
    ...role,
    ...(framework ? { prompt: ownPrompt ? `${framework}\n\n${ownPrompt}` : framework } : {}),
    rules: [...rules.values()],
    skills: [...skills.values()],
    mcp: [...mcp.values()],
    projectMetadataSelection: [...metadata.values()],
  };
}

function parseSkillMetadata(
  content: string,
  fallbackId: string,
): {
  name: string;
  description: string;
} {
  let data: Record<string, unknown>;
  try {
    data = matter(content).data as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `invalid Meka Skill frontmatter for ${fallbackId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : fallbackId;
  const description = typeof data.description === 'string' ? data.description.trim() : '';
  return { name, description };
}

function normalizeDiscoveredSkillId(
  name: string,
  sourcePath: string,
  usedIds: ReadonlySet<string>,
): string {
  const normalize = (value: string) =>
    value
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  const fallback = normalize(sourcePath) || 'project-skill';
  const base = (normalize(name) || fallback).slice(0, 64).replace(/-+$/g, '') || 'project-skill';
  let candidate = base;
  for (let duplicateIndex = 2; usedIds.has(candidate); duplicateIndex += 1) {
    const suffix = `-${duplicateIndex}`;
    candidate = `${base.slice(0, 64 - suffix.length).replace(/-+$/g, '')}${suffix}`;
  }
  if (!SAFE_DISCOVERED_SKILL_ID_RE.test(candidate)) {
    throw new Error(`invalid discovered Meka skill id: ${candidate}`);
  }
  return candidate;
}

async function listBundledSkills(): Promise<Map<string, string>> {
  const root = bundledMekaSkillsRoot();
  const result = new Map<string, string>();

  async function walk(directory: string): Promise<void> {
    let entries: Array<{
      name: string;
      isDirectory(): boolean;
      isFile(): boolean;
    }>;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile() && entry.name === 'SKILL.md') {
        const id = path.basename(path.dirname(absolute));
        if (!SAFE_SKILL_ID_RE.test(id)) {
          throw new Error(`invalid bundled Meka skill id: ${id}`);
        }
        if (result.has(id)) throw new Error(`duplicate bundled Meka skill id: ${id}`);
        result.set(id, absolute);
      }
    }
  }

  await walk(root);
  return result;
}

async function resolveProjectWorkspace(project: ProjectRow): Promise<string | null> {
  const configuredPath = project.path?.trim();
  if (!configuredPath) return null;
  if (configuredPath === 'saga2') {
    return (await getMekaP4SettingsService().get()).p4RootPath;
  }
  return path.isAbsolute(configuredPath) ? path.resolve(configuredPath) : null;
}

async function readProjectMetadataContent(
  projectRoot: string | null,
  additionalRoots: readonly string[],
  selection: MekaProjectMetadataSelection,
): Promise<string | null> {
  if (!projectRoot) return null;
  const roots = [path.resolve(projectRoot), ...additionalRoots.map((root) => path.resolve(root))];
  const root = path.resolve(selection.rootPath ?? projectRoot);
  const rootKey = (candidate: string) =>
    process.platform === 'win32'
      ? path.normalize(candidate).toLowerCase()
      : path.normalize(candidate);
  if (!roots.some((candidate) => rootKey(candidate) === rootKey(root))) {
    throw new Error(`Meka project metadata root is not configured: ${root}`);
  }
  const candidate = path.resolve(root, ...selection.sourcePath.split('/'));
  const relative = path.relative(root, candidate);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`Meka project metadata escapes the project root: ${selection.sourcePath}`);
  }
  try {
    return await fs.readFile(candidate, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      log.warn('selected Meka project metadata is missing', {
        sourcePath: selection.sourcePath,
        itemType: selection.itemType,
      });
      return null;
    }
    throw error;
  }
}

function parseDiscoveredMcp(content: string, fallbackId: string): MekaRoleMcpEntry[] {
  const parsed: unknown = JSON.parse(content);
  if (!isRecord(parsed)) throw new Error(`Meka MCP metadata ${fallbackId} must be an object`);
  const container = isRecord(parsed.mcpServers)
    ? parsed.mcpServers
    : isRecord(parsed.servers)
      ? parsed.servers
      : { [fallbackId]: parsed };
  return Object.entries(container).map(([id, raw]) => {
    if (!isRecord(raw)) throw new Error(`Meka MCP metadata ${id} must be an object`);
    if (!SAFE_SKILL_ID_RE.test(id)) throw new Error(`Meka MCP metadata has an invalid id: ${id}`);
    if (typeof raw.providerId === 'string') {
      if (!SAFE_SKILL_ID_RE.test(raw.providerId)) {
        throw new Error(`Meka MCP metadata ${id} has an invalid providerId`);
      }
      return { id, providerId: raw.providerId, enabled: true };
    }
    const transport =
      raw.transport === 'stdio' || raw.transport === 'sse' || raw.transport === 'http'
        ? raw.transport
        : typeof raw.command === 'string'
          ? 'stdio'
          : 'http';
    if (
      raw.args !== undefined &&
      (!Array.isArray(raw.args) || raw.args.some((item) => typeof item !== 'string'))
    ) {
      throw new Error(`Meka MCP metadata ${id} args must be an array of strings`);
    }
    if (transport === 'stdio' && (typeof raw.command !== 'string' || !raw.command.trim())) {
      throw new Error(`Meka MCP metadata ${id} requires command for stdio transport`);
    }
    if (transport !== 'stdio' && (typeof raw.url !== 'string' || !raw.url.trim())) {
      throw new Error(`Meka MCP metadata ${id} requires url for ${transport} transport`);
    }
    if (raw.env !== undefined && !isRecord(raw.env)) {
      throw new Error(`Meka MCP metadata ${id} env must be an object`);
    }
    if (isRecord(raw.env)) {
      for (const [name, value] of Object.entries(raw.env)) {
        if (typeof value !== 'string' || !SECRET_REFERENCE_RE.test(value)) {
          throw new Error(
            `Meka MCP metadata ${id} env.${name} contains a raw value; use {{secret:name}}`,
          );
        }
      }
    }
    return {
      id,
      transport,
      enabled: true,
      ...(typeof raw.command === 'string' ? { command: raw.command } : {}),
      ...(Array.isArray(raw.args) && raw.args.every((item) => typeof item === 'string')
        ? { args: raw.args as string[] }
        : {}),
      ...(typeof raw.url === 'string' ? { url: raw.url } : {}),
      ...(isRecord(raw.env) && Object.values(raw.env).every((item) => typeof item === 'string')
        ? { env: raw.env as Record<string, string> }
        : {}),
    };
  });
}

function roleManifestDirectory(row: RoleRow): string {
  if (row.is_builtin === 1) return bundledMekaRolesRoot();
  const configured = row.file_path.trim();
  if (path.isAbsolute(configured)) return path.dirname(path.resolve(configured));
  return path.dirname(path.resolve(app.getPath('userData'), configured));
}

async function readRoleRelativeFile(row: RoleRow, relativePath: string): Promise<string> {
  return fs.readFile(resolveRoleRelativePath(row, relativePath), 'utf8');
}

function resolveRoleRelativePath(row: RoleRow, relativePath: string): string {
  const root = path.resolve(roleManifestDirectory(row));
  const candidate = path.resolve(root, relativePath);
  const relative = path.relative(root, candidate);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`Meka role resource escapes the role directory: ${relativePath}`);
  }
  return candidate;
}

async function resolveRoleFile(row: RoleRow, projectFile: MekaProjectFile): Promise<MekaRoleFile> {
  const manifest =
    row.is_builtin === 1
      ? (projectFile.builtinRoles?.find((role) => role.id === row.id) ??
        (await readBuiltinRoleManifest(row.id, row.project_id)))
      : await readCustomRoleManifest(row.id, app.getPath('userData'), row.project_id);
  if (!manifest) throw new Error(`Meka role manifest is missing: ${row.id}`);
  return manifest;
}

/**
 * Resolve the current project and role files directly into runtime inputs.
 * There is deliberately no capability-status, whitelist, activation, or snapshot layer here.
 */
export async function resolveMekaRuntimeConfig(
  projectId: string,
  roleId: string,
): Promise<MekaRuntimeConfig> {
  const db = getDbClient();
  const [project, role] = await Promise.all([
    db.queryOne<ProjectRow>('SELECT id, path, is_builtin FROM meka_projects WHERE id = ?', [
      projectId,
    ]),
    db.queryOne<RoleRow>(
      'SELECT id, project_id, is_builtin, file_path FROM meka_roles WHERE id = ?',
      [roleId],
    ),
  ]);
  if (!project) throw new Error(`Meka project not found: ${projectId}`);
  if (!role) throw new Error(`Meka role not found: ${roleId}`);
  if (role.project_id !== project.id) {
    throw new Error(`Meka role ${roleId} does not belong to project ${projectId}`);
  }

  const projectRoot = await resolveProjectWorkspace(project);
  const projectFile = await readEffectiveProjectConfig({
    projectId: project.id,
    isBuiltin: project.is_builtin === 1,
    projectRoot: projectRoot ?? '',
    appIsPackaged: app.isPackaged,
  });
  if (!projectFile) throw new Error(`Meka project config is missing: ${projectId}`);

  const roleFile = mergeMekaProjectRoleDefaults(
    await resolveRoleFile(role, projectFile),
    projectFile.roleDefaults ?? {},
  );
  const catalog = await listBundledSkills();
  const skills = new Map<string, MekaRuntimeSkill>();
  const prompts: string[] = [];
  const mcp = new Map<string, MekaRoleMcpEntry>();
  const additionalRoots = projectFile.basic.additionalPaths ?? [];
  const projectMetadata = new Map(projectFile.metadata.map((item) => [metadataKey(item), item]));

  if (roleFile.prompt?.trim()) prompts.push(roleFile.prompt.trim());
  for (const rule of roleFile.rules ?? []) {
    if (rule.enabled && rule.text.trim()) prompts.push(rule.text.trim());
  }
  for (const fragment of roleFile.promptFragments ?? []) {
    if (!fragment.path.trim()) {
      throw new Error(`Meka role prompt fragment ${fragment.id} has an empty path`);
    }
    prompts.push((await readRoleRelativeFile(role, fragment.path)).trim());
  }

  for (const selected of roleFile.skills) {
    if (isLegacySkill(selected)) {
      if (!SAFE_SKILL_ID_RE.test(selected.id)) {
        throw new Error(`invalid path-based Meka role skill id: ${selected.id}`);
      }
      const source = resolveRoleRelativePath(role, selected.path);
      const content = await fs.readFile(source, 'utf8');
      const metadata = parseSkillMetadata(content, selected.id);
      skills.set(selected.id, {
        id: selected.id,
        name: metadata.name,
        description: selected.description ?? metadata.description,
        content,
        sourceDirectory: path.dirname(source),
        sourceEntryPath: source,
      });
      continue;
    }
    if (!selected.enabled) continue;
    const source = catalog.get(selected.skillId);
    if (!source) throw new Error(`unknown bundled Meka skill: ${selected.skillId}`);
    const content = await fs.readFile(source, 'utf8');
    const metadata = parseSkillMetadata(content, selected.skillId);
    skills.set(selected.skillId, {
      id: selected.skillId,
      name: metadata.name,
      description: metadata.description,
      content,
      sourceDirectory: path.dirname(source),
      sourceEntryPath: source,
    });
  }

  for (const entry of roleFile.mcp) {
    if (entry.enabled !== false) mcp.set(entry.id, entry);
  }

  for (const selection of roleFile.projectMetadataSelection ?? []) {
    if (!selection.enabled) continue;
    const configuredMetadata = projectMetadata.get(metadataKey(selection));
    if (configuredMetadata?.enabled === false) continue;
    const content = await readProjectMetadataContent(projectRoot, additionalRoots, selection);
    if (content === null) continue;
    switch (selection.itemType) {
      case 'agents-md':
      case 'rule':
        prompts.push(content.trim());
        break;
      case 'skill': {
        const fallbackId = path.posix.basename(path.posix.dirname(selection.sourcePath));
        const metadata = parseSkillMetadata(content, fallbackId);
        const id = normalizeDiscoveredSkillId(
          configuredMetadata?.name ?? metadata.name,
          selection.sourcePath,
          new Set(skills.keys()),
        );
        skills.set(id, {
          id,
          name: configuredMetadata?.displayName ?? metadata.name,
          description:
            configuredMetadata?.description ?? metadata.description ?? selection.sourcePath,
          content,
          sourceDirectory: path.dirname(
            path.resolve(
              selection.rootPath ?? projectRoot ?? '',
              ...selection.sourcePath.split('/'),
            ),
          ),
          sourceEntryPath: path.resolve(
            selection.rootPath ?? projectRoot ?? '',
            ...selection.sourcePath.split('/'),
          ),
        });
        break;
      }
      case 'mcp':
        for (const entry of parseDiscoveredMcp(
          content,
          configuredMetadata?.name ?? path.posix.basename(selection.sourcePath),
        )) {
          if (mcp.has(entry.id)) {
            throw new Error(`duplicate discovered Meka MCP id: ${entry.id}`);
          }
          mcp.set(entry.id, entry);
        }
        break;
      default: {
        const exhaustive: never = selection.itemType;
        throw new Error(`unsupported Meka project metadata type: ${String(exhaustive)}`);
      }
    }
  }

  const policyProviderRefs = [...(roleFile.policyProviderRefs ?? [])];
  for (const ref of policyProviderRefs) {
    if (!KNOWN_POLICY_PROVIDER_REFS.has(ref)) {
      throw new Error(`unknown Meka policy provider: ${ref}`);
    }
  }

  return {
    projectId,
    roleId,
    promptText: prompts.filter(Boolean).join('\n\n'),
    skills: [...skills.values()],
    mcp: [...mcp.values()],
    policyProviderRefs,
  };
}
