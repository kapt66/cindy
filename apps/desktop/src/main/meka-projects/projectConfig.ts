import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  MEKA_GENERAL_DISCIPLINE,
  parseMekaEditableMetadata,
  type MekaProjectFile,
  type MekaProjectMetadataConfigItem,
  type MekaProjectMetadataItemType,
  type MekaRoleMcpEntry,
  type MekaRoleManifestFile,
  type ProjectConfigLocator,
} from '../../shared/meka-projects.js';
import { bundledMekaProjectsRoot, bundledMekaRolesRoot } from './resourcePaths.js';

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const ITEM_TYPES = new Set<MekaProjectMetadataItemType>(['agents-md', 'skill', 'rule', 'mcp']);
export const SECRET_REFERENCE_RE = /^\{\{secret:([A-Za-z0-9][A-Za-z0-9._-]*)\}\}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SAFE_ID_RE.test(value.trim())) {
    throw new Error(`${label} contains unsupported characters`);
  }
  return value.trim();
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be non-empty`);
  return value.trim();
}

function cleanStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function canonicalRelativePath(value: unknown, label: string): string {
  const sourcePath = nonEmptyString(value, label);
  const slashed = sourcePath.replaceAll('\\', '/');
  const normalized = path.posix.normalize(slashed);
  if (
    sourcePath !== slashed ||
    normalized !== sourcePath ||
    path.posix.isAbsolute(sourcePath) ||
    path.win32.isAbsolute(sourcePath) ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    sourcePath.includes('\0')
  ) {
    throw new Error(`${label} must be a canonical relative POSIX path`);
  }
  return sourcePath;
}

function normalizeMetadata(input: unknown): MekaProjectMetadataConfigItem {
  if (!isRecord(input)) throw new Error('project metadata item must be an object');
  const itemType = input.itemType;
  if (typeof itemType !== 'string' || !ITEM_TYPES.has(itemType as MekaProjectMetadataItemType)) {
    throw new Error(`unsupported project metadata item type: ${String(itemType)}`);
  }
  const editable = parseMekaEditableMetadata(input);
  const subProjectPath =
    input.subProjectPath === null
      ? null
      : typeof input.subProjectPath === 'string' && input.subProjectPath.trim()
        ? canonicalRelativePath(input.subProjectPath, 'metadata subProjectPath')
        : undefined;
  return {
    sourcePath: canonicalRelativePath(input.sourcePath, 'metadata sourcePath'),
    itemType: itemType as MekaProjectMetadataItemType,
    disciplines: cleanStrings(input.disciplines),
    domains: cleanStrings(input.domains),
    ...(typeof input.enabled === 'boolean' ? { enabled: input.enabled } : {}),
    ...(typeof input.name === 'string' && input.name.trim() ? { name: input.name.trim() } : {}),
    ...(typeof input.contentFingerprint === 'string' && input.contentFingerprint.trim()
      ? { contentFingerprint: input.contentFingerprint.trim() }
      : {}),
    ...(subProjectPath !== undefined ? { subProjectPath } : {}),
    ...(editable ?? {}),
  };
}

function validateMcpEntry(value: unknown): MekaRoleMcpEntry {
  if (!isRecord(value)) throw new Error('role mcp entry must be an object');
  const id = safeId(value.id, 'role mcp id');
  if (typeof value.providerId === 'string') {
    return {
      id,
      providerId: safeId(value.providerId, 'role mcp providerId'),
      ...(typeof value.enabled === 'boolean' ? { enabled: value.enabled } : {}),
    };
  }
  if (!['stdio', 'sse', 'http'].includes(String(value.transport))) {
    throw new Error(`role mcp ${id} has unsupported transport`);
  }
  const transport = value.transport as 'stdio' | 'sse' | 'http';
  const env: Record<string, string> = {};
  if (value.env !== undefined) {
    if (!isRecord(value.env)) throw new Error(`role mcp ${id} env must be an object`);
    for (const [key, raw] of Object.entries(value.env)) {
      if (typeof raw !== 'string' || !SECRET_REFERENCE_RE.test(raw)) {
        throw new Error(`role mcp ${id} env.${key} must use {{secret:name}}`);
      }
      env[key] = raw;
    }
  }
  const args = Array.isArray(value.args)
    ? value.args.map((arg) => {
        if (typeof arg !== 'string') throw new Error(`role mcp ${id} args must be strings`);
        return arg;
      })
    : undefined;
  if (transport === 'stdio' && (typeof value.command !== 'string' || !value.command.trim())) {
    throw new Error(`role mcp ${id} command is required`);
  }
  if (transport !== 'stdio' && (typeof value.url !== 'string' || !value.url.trim())) {
    throw new Error(`role mcp ${id} url is required`);
  }
  return {
    id,
    transport,
    ...(typeof value.enabled === 'boolean' ? { enabled: value.enabled } : {}),
    ...(typeof value.command === 'string' && value.command.trim()
      ? { command: value.command.trim() }
      : {}),
    ...(args ? { args } : {}),
    ...(typeof value.url === 'string' && value.url.trim() ? { url: value.url.trim() } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}

function normalizeDefaultMetadataSelections(
  value: unknown,
): NonNullable<MekaProjectFile['roleDefaults']>['projectMetadataSelection'] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((item) => {
    if (
      typeof item.itemType !== 'string' ||
      !ITEM_TYPES.has(item.itemType as MekaProjectMetadataItemType)
    ) {
      throw new Error(`unsupported project metadata item type: ${String(item.itemType)}`);
    }
    return {
      sourcePath: canonicalRelativePath(item.sourcePath, 'role metadata sourcePath'),
      itemType: item.itemType as MekaProjectMetadataItemType,
    };
  });
}

function normalizeRoleDefaults(value: unknown): MekaProjectFile['roleDefaults'] {
  if (!isRecord(value)) return undefined;
  return {
    ...(typeof value.promptFramework === 'string' && value.promptFramework.trim()
      ? { promptFramework: value.promptFramework }
      : {}),
    skills: cleanStrings(value.skills),
    mcp: Array.isArray(value.mcp) ? value.mcp.map(validateMcpEntry) : [],
    projectMetadataSelection: normalizeDefaultMetadataSelections(value.projectMetadataSelection),
  };
}

export function normalizeMekaProjectFile(
  input: unknown,
  expectedProjectId: string,
): MekaProjectFile {
  if (!isRecord(input) || input.schemaVersion !== 1) throw new Error('invalid project file header');
  const projectId = safeId(input.projectId, 'projectId');
  if (projectId !== safeId(expectedProjectId, 'expected projectId')) {
    throw new Error(`projectId mismatch: expected ${expectedProjectId}, got ${projectId}`);
  }
  if (!isRecord(input.basic) || !Array.isArray(input.metadata)) {
    throw new Error('project basic/metadata shape is invalid');
  }
  const workflowType = ['none', 'jira', 'gitlab'].includes(String(input.basic.workflowType))
    ? (input.basic.workflowType as 'none' | 'jira' | 'gitlab')
    : input.basic.formalWorkflowEnabled === true
      ? 'jira'
      : undefined;
  const metadata = new Map<string, MekaProjectMetadataConfigItem>();
  for (const raw of input.metadata) {
    const item = normalizeMetadata(raw);
    metadata.set(`${item.sourcePath}|${item.itemType}`, item);
  }
  const disciplines = cleanStrings(input.basic.disciplines).filter(
    (item) => item !== MEKA_GENERAL_DISCIPLINE,
  );
  return {
    schemaVersion: 1,
    projectId,
    basic: {
      ...(typeof input.basic.name === 'string' && input.basic.name.trim()
        ? { name: input.basic.name.trim() }
        : {}),
      displayName: nonEmptyString(input.basic.displayName, 'project displayName'),
      ...(typeof input.basic.description === 'string' && input.basic.description.trim()
        ? { description: input.basic.description.trim() }
        : {}),
      path: nonEmptyString(input.basic.path, 'project path'),
      ...(workflowType ? { workflowType } : {}),
      formalWorkflowEnabled: workflowType !== undefined && workflowType !== 'none',
      ...(typeof input.basic.jiraProjectKey === 'string' && input.basic.jiraProjectKey.trim()
        ? { jiraProjectKey: input.basic.jiraProjectKey.trim() }
        : {}),
      ...(typeof input.basic.gitlabProjectUrl === 'string' && input.basic.gitlabProjectUrl.trim()
        ? { gitlabProjectUrl: input.basic.gitlabProjectUrl.trim() }
        : {}),
      disciplines: [MEKA_GENERAL_DISCIPLINE, ...disciplines],
      domains: cleanStrings(input.basic.domains),
    },
    metadata: [...metadata.values()],
    ...(normalizeRoleDefaults(input.roleDefaults)
      ? { roleDefaults: normalizeRoleDefaults(input.roleDefaults) }
      : {}),
  };
}

export function normalizeMekaRoleManifest(
  input: unknown,
  expectedRoleId: string,
  expectedProjectId?: string,
): MekaRoleManifestFile {
  if (!isRecord(input) || input.schemaVersion !== 1) throw new Error('invalid role file header');
  const id = safeId(input.id, 'role id');
  if (id !== safeId(expectedRoleId, 'expected role id')) throw new Error('role id mismatch');
  const projectId = safeId(input.projectId ?? expectedProjectId, 'role projectId');
  if (expectedProjectId && projectId !== expectedProjectId)
    throw new Error('role projectId mismatch');
  if (!Array.isArray(input.skills) || !Array.isArray(input.mcp)) {
    throw new Error('role skills/mcp must be arrays');
  }
  const excludeDefaults = isRecord(input.excludeDefaults)
    ? {
        skills: cleanStrings(input.excludeDefaults.skills),
        mcp: cleanStrings(input.excludeDefaults.mcp),
        metadata: normalizeDefaultMetadataSelections(input.excludeDefaults.metadata),
      }
    : undefined;
  return {
    schemaVersion: 1,
    id,
    projectId,
    name: id,
    displayName: nonEmptyString(input.displayName, 'role displayName'),
    ...(typeof input.description === 'string' && input.description.trim()
      ? { description: input.description.trim() }
      : {}),
    tags: cleanStrings(input.tags),
    policyProviderRefs: cleanStrings(input.policyProviderRefs),
    ...(typeof input.prompt === 'string' && input.prompt.trim() ? { prompt: input.prompt } : {}),
    rules: Array.isArray(input.rules)
      ? input.rules.filter(isRecord).map((rule) => ({
          id: safeId(rule.id, 'role rule id'),
          text: nonEmptyString(rule.text, 'role rule text'),
          enabled: rule.enabled !== false,
        }))
      : [],
    skills: input.skills as MekaRoleManifestFile['skills'],
    promptFragments: Array.isArray(input.promptFragments)
      ? (input.promptFragments as MekaRoleManifestFile['promptFragments'])
      : [],
    mcp: input.mcp.map(validateMcpEntry),
    projectMetadataSelection: Array.isArray(input.projectMetadataSelection)
      ? input.projectMetadataSelection.filter(isRecord).map((item) => ({
          sourcePath: canonicalRelativePath(item.sourcePath, 'role metadata sourcePath'),
          itemType: item.itemType as MekaProjectMetadataItemType,
          enabled: item.enabled !== false,
        }))
      : [],
    ...(typeof input.useProjectDefaults === 'boolean'
      ? { useProjectDefaults: input.useProjectDefaults }
      : {}),
    ...(excludeDefaults ? { excludeDefaults } : {}),
  };
}

function bundledProjectFilePath(locator: ProjectConfigLocator): string {
  return path.join(
    bundledMekaProjectsRoot(),
    safeId(locator.projectId, 'project id'),
    'project.json',
  );
}

function writableProjectFilePath(locator: ProjectConfigLocator): string {
  if (locator.isBuiltin) {
    if (!path.isAbsolute(locator.projectRoot)) {
      throw new Error('builtin Meka project override requires an absolute project root');
    }
    return path.join(locator.projectRoot, '.meka', 'project.json');
  }
  if (!path.isAbsolute(locator.projectRoot)) throw new Error('project root must be absolute');
  return path.join(locator.projectRoot, '.meka', 'project.json');
}

function mergeProjectFiles(
  base: MekaProjectFile | null,
  override: MekaProjectFile | null,
): MekaProjectFile | null {
  if (!base) return override;
  if (!override) return base;
  const metadata = new Map<string, MekaProjectMetadataConfigItem>();
  for (const item of [...base.metadata, ...override.metadata]) {
    metadata.set(`${item.itemType}:${item.sourcePath}`, item);
  }
  return {
    schemaVersion: 1,
    projectId: base.projectId,
    basic: { ...override.basic },
    metadata: [...metadata.values()],
    ...(override.roleDefaults !== undefined
      ? { roleDefaults: override.roleDefaults }
      : base.roleDefaults !== undefined
        ? { roleDefaults: base.roleDefaults }
        : {}),
  };
}

function customRolePath(roleId: string, userData: string): string {
  return path.join(path.resolve(userData), 'meka-roles', `${safeId(roleId, 'role id')}.json`);
}

function builtinRolePath(roleId: string): string {
  return path.join(bundledMekaRolesRoot(), `${safeId(roleId, 'role id')}.json`);
}

async function readJson(filePath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(tempPath, filePath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

export async function readEffectiveProjectConfig(
  locator: ProjectConfigLocator,
): Promise<MekaProjectFile | null> {
  if (!locator.isBuiltin) {
    const input = await readJson(writableProjectFilePath(locator));
    return input === null ? null : normalizeMekaProjectFile(input, locator.projectId);
  }
  const baseInput = await readJson(bundledProjectFilePath(locator));
  const base = baseInput === null ? null : normalizeMekaProjectFile(baseInput, locator.projectId);
  if (!path.isAbsolute(locator.projectRoot)) return base;
  const overrideInput = await readJson(writableProjectFilePath(locator));
  const override =
    overrideInput === null ? null : normalizeMekaProjectFile(overrideInput, locator.projectId);
  return mergeProjectFiles(base, override);
}

export async function saveProjectConfig(
  locator: ProjectConfigLocator,
  draft: MekaProjectFile,
): Promise<MekaProjectFile> {
  const normalized = normalizeMekaProjectFile(draft, locator.projectId);
  await atomicWriteJson(writableProjectFilePath(locator), normalized);
  return normalized;
}

export async function createProjectConfigExclusive(
  locator: ProjectConfigLocator,
  draft: MekaProjectFile,
): Promise<MekaProjectFile> {
  if (locator.isBuiltin) throw new Error('builtin Meka project is read-only');
  const normalized = normalizeMekaProjectFile(draft, locator.projectId);
  const filePath = writableProjectFilePath(locator);
  await mkdir(path.dirname(filePath), { recursive: true });
  const handle = await open(filePath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  } finally {
    await handle.close();
  }
  return normalized;
}

export function resolveProjectConfigPath(locator: ProjectConfigLocator): string {
  return writableProjectFilePath(locator);
}

export async function readBuiltinRoleManifest(
  roleId: string,
  projectId?: string,
): Promise<MekaRoleManifestFile> {
  const safeRoleId = safeId(roleId, 'role id');
  const input = await readJson(builtinRolePath(safeRoleId));
  if (input === null) throw new Error(`builtin Meka role ${safeRoleId} not found`);
  return normalizeMekaRoleManifest(input, safeRoleId, projectId);
}

export async function readCustomRoleManifest(
  roleId: string,
  userData: string,
  projectId?: string,
): Promise<MekaRoleManifestFile | null> {
  const input = await readJson(customRolePath(roleId, userData));
  return input === null ? null : normalizeMekaRoleManifest(input, roleId, projectId);
}

export async function writeCustomRoleManifest(
  roleId: string,
  draft: MekaRoleManifestFile,
  userData: string,
): Promise<MekaRoleManifestFile> {
  const normalized = normalizeMekaRoleManifest(draft, roleId, draft.projectId);
  await atomicWriteJson(customRolePath(roleId, userData), normalized);
  return normalized;
}

export async function createCustomRoleManifestExclusive(
  roleId: string,
  draft: MekaRoleManifestFile,
  userData: string,
): Promise<MekaRoleManifestFile> {
  const normalized = normalizeMekaRoleManifest(draft, roleId, draft.projectId);
  const filePath = customRolePath(roleId, userData);
  await mkdir(path.dirname(filePath), { recursive: true });
  const handle = await open(filePath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  } finally {
    await handle.close();
  }
  return normalized;
}

export function resolveCustomRoleManifestPath(roleId: string, userData: string): string {
  return customRolePath(roleId, userData);
}
