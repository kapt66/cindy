import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  MEKA_GENERAL_DISCIPLINE,
  parseMekaEditableMetadata,
  type MekaProjectFile,
  type MekaProjectMetadataConfigItem,
  type MekaProjectMetadataItemType,
  type MekaRoleMcpEntry,
  type MekaRole,
  type MekaRoleManifestFile,
  type MekaProjectConfigSource,
  type ProjectConfigLocator,
} from '../../shared/meka-projects.js';
import { bundledMekaProjectsRoot, bundledMekaRolesRoot } from './resourcePaths.js';

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const ITEM_TYPES = new Set<MekaProjectMetadataItemType>(['agents-md', 'skill', 'rule', 'mcp']);
const MAX_ADDITIONAL_PATHS = 10;
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

function canonicalAbsolutePath(value: unknown, label: string): string {
  const raw = nonEmptyString(value, label);
  if (!path.isAbsolute(raw) || raw.includes('\0')) {
    throw new Error(`${label} must be an absolute path`);
  }
  return path.normalize(raw);
}

function absolutePathKey(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function cleanAbsolutePaths(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array of absolute paths`);
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const normalized = canonicalAbsolutePath(item, label);
    const key = absolutePathKey(normalized);
    if (!seen.has(key)) {
      seen.add(key);
      paths.push(normalized);
    }
  }
  if (paths.length > MAX_ADDITIONAL_PATHS) {
    throw new Error(`${label} cannot contain more than ${MAX_ADDITIONAL_PATHS} paths`);
  }
  return paths;
}

function normalizeMetadata(input: unknown): MekaProjectMetadataConfigItem {
  if (!isRecord(input)) throw new Error('project metadata item must be an object');
  const itemType = input.itemType;
  if (typeof itemType !== 'string' || !ITEM_TYPES.has(itemType as MekaProjectMetadataItemType)) {
    throw new Error(`unsupported project metadata item type: ${String(itemType)}`);
  }
  const editable = parseMekaEditableMetadata(input);
  const rootPath =
    input.rootPath === undefined || input.rootPath === null || input.rootPath === ''
      ? undefined
      : canonicalAbsolutePath(input.rootPath, 'metadata rootPath');
  const subProjectPath =
    input.subProjectPath === null
      ? null
      : typeof input.subProjectPath === 'string' && input.subProjectPath.trim()
        ? canonicalRelativePath(input.subProjectPath, 'metadata subProjectPath')
        : undefined;
  return {
    ...(rootPath ? { rootPath } : {}),
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
      ...(item.rootPath === undefined || item.rootPath === null || item.rootPath === ''
        ? {}
        : { rootPath: canonicalAbsolutePath(item.rootPath, 'role metadata rootPath') }),
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
    metadata.set(`${item.rootPath ?? ''}|${item.sourcePath}|${item.itemType}`, item);
  }
  const projectPath = nonEmptyString(input.basic.path, 'project path');
  const normalizedProjectPath = path.isAbsolute(projectPath) ? path.normalize(projectPath) : null;
  const additionalPaths = cleanAbsolutePaths(
    input.basic.additionalPaths,
    'project additionalPaths',
  ).filter(
    (candidate) =>
      normalizedProjectPath === null ||
      absolutePathKey(candidate) !== absolutePathKey(normalizedProjectPath),
  );
  const disciplines = cleanStrings(input.basic.disciplines).filter(
    (item) => item !== MEKA_GENERAL_DISCIPLINE,
  );
  const builtinRoles = Array.isArray(input.builtinRoles)
    ? [
        ...new Map(
          input.builtinRoles.map((role) => {
            if (!isRecord(role)) throw new Error('builtin project role must be an object');
            const roleId = safeId(role.id, 'builtin role id');
            return [roleId, normalizeMekaRoleManifest(role, roleId, projectId)] as const;
          }),
        ).values(),
      ]
    : undefined;
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
      path: projectPath,
      ...(additionalPaths.length > 0 ? { additionalPaths } : {}),
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
    ...(builtinRoles ? { builtinRoles } : {}),
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
          ...(item.rootPath === undefined || item.rootPath === null || item.rootPath === ''
            ? {}
            : { rootPath: canonicalAbsolutePath(item.rootPath, 'role metadata rootPath') }),
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

export function cloneMekaRoleManifestForProject(
  role: MekaRoleManifestFile,
  projectId: string,
  roleId: string,
): MekaRoleManifestFile {
  return normalizeMekaRoleManifest(
    { ...role, id: roleId, projectId, name: roleId },
    roleId,
    projectId,
  );
}

export function renameImportedProjectOnConflict(
  file: MekaProjectFile,
  projectRoot: string,
  registeredDisplayNames: readonly string[],
): MekaProjectFile {
  const keys = new Set(registeredDisplayNames.map((name) => name.trim().toLocaleLowerCase()));
  if (!keys.has(file.basic.displayName.trim().toLocaleLowerCase())) return file;

  const directoryName = path.basename(path.resolve(projectRoot)).trim() || file.basic.displayName;
  let suffix = '';
  let index = 1;
  let candidate = directoryName.slice(0, 120);
  while (keys.has(candidate.toLocaleLowerCase())) {
    index += 1;
    suffix = ` (${index})`;
    candidate = `${directoryName.slice(0, 120 - suffix.length)}${suffix}`;
  }
  return {
    ...file,
    basic: { ...file.basic, name: candidate, displayName: candidate },
  };
}

export function sortImportedRoleManifests(
  roles: readonly MekaRoleManifestFile[],
  referenceRoles: readonly MekaRole[],
): MekaRoleManifestFile[] {
  const byId = new Map<string, number>();
  const byDisplayName = new Map<string, number>();
  for (const role of [...referenceRoles].sort((left, right) => left.sortOrder - right.sortOrder)) {
    if (!byId.has(role.id)) byId.set(role.id, role.sortOrder);
    const displayNameKey = role.displayName.trim().toLocaleLowerCase();
    if (!byDisplayName.has(displayNameKey)) byDisplayName.set(displayNameKey, role.sortOrder);
  }
  return roles
    .map((role, index) => ({
      role,
      index,
      order:
        byId.get(role.id) ??
        byDisplayName.get(role.displayName.trim().toLocaleLowerCase()) ??
        Number.MAX_SAFE_INTEGER,
    }))
    .sort((left, right) => left.order - right.order || left.index - right.index)
    .map(({ role }) => role);
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

function anchoredProjectFile(file: MekaProjectFile, projectRoot: string): MekaProjectFile {
  if (!path.isAbsolute(projectRoot)) return file;
  const resolvedRoot = path.resolve(projectRoot);
  const rootKey = absolutePathKey(resolvedRoot);
  const additionalPaths = file.basic.additionalPaths?.filter(
    (candidate) => absolutePathKey(candidate) !== rootKey,
  );
  return {
    ...file,
    basic: {
      ...file.basic,
      path: resolvedRoot,
      ...(additionalPaths && additionalPaths.length > 0
        ? { additionalPaths }
        : { additionalPaths: undefined }),
    },
  };
}

async function readBundledRoleManifests(projectId: string): Promise<MekaRoleManifestFile[]> {
  const root = bundledMekaRolesRoot();
  const entries = await readdir(root, { withFileTypes: true });
  const manifests: MekaRoleManifestFile[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.json') continue;
    const input = await readJson(path.join(root, entry.name));
    if (!isRecord(input) || input.projectId !== projectId) continue;
    const roleId = path.basename(entry.name, '.json');
    manifests.push(normalizeMekaRoleManifest(input, roleId, projectId));
  }
  return manifests;
}

function assertCompleteBuiltinRoles(
  actual: readonly MekaRoleManifestFile[],
  expected: readonly MekaRoleManifestFile[],
): void {
  const actualIds = new Set(actual.map((role) => role.id));
  const expectedIds = new Set(expected.map((role) => role.id));
  if (
    actualIds.size !== expectedIds.size ||
    [...expectedIds].some((roleId) => !actualIds.has(roleId))
  ) {
    throw new Error('builtin project file must contain every bundled role exactly once');
  }
}

function normalizeProjectFileAtRoot(
  input: unknown,
  expectedProjectId: string,
  projectRoot: string,
  rewriteIdentity = false,
): MekaProjectFile {
  if (!isRecord(input)) throw new Error('invalid project file header');
  const builtinRoles = Array.isArray(input.builtinRoles)
    ? input.builtinRoles.map((role) =>
        rewriteIdentity && isRecord(role) ? { ...role, projectId: expectedProjectId } : role,
      )
    : input.builtinRoles;
  const anchoredInput = {
    ...input,
    ...(rewriteIdentity ? { projectId: expectedProjectId } : {}),
    basic: {
      ...(isRecord(input.basic) ? input.basic : {}),
      path: path.resolve(projectRoot),
    },
    ...(builtinRoles === undefined ? {} : { builtinRoles }),
  };
  return anchoredProjectFile(
    normalizeMekaProjectFile(anchoredInput, expectedProjectId),
    projectRoot,
  );
}

export interface EffectiveProjectConfigState {
  file: MekaProjectFile | null;
  source: MekaProjectConfigSource;
}

export async function readProjectConfigAtRoot(
  projectRoot: string,
  targetProjectId?: string,
): Promise<MekaProjectFile | null> {
  if (!path.isAbsolute(projectRoot)) throw new Error('project root must be absolute');
  const input = await readJson(path.join(path.resolve(projectRoot), '.meka', 'project.json'));
  if (input === null) return null;
  if (!isRecord(input)) throw new Error('invalid project file header');
  const projectId = safeId(targetProjectId ?? input.projectId, 'projectId');
  return normalizeProjectFileAtRoot(input, projectId, projectRoot, true);
}

export async function readProjectConfigState(
  locator: ProjectConfigLocator,
): Promise<EffectiveProjectConfigState> {
  if (!locator.isBuiltin) {
    const input = await readJson(writableProjectFilePath(locator));
    return {
      file:
        input === null
          ? null
          : normalizeProjectFileAtRoot(input, locator.projectId, locator.projectRoot),
      source: 'project',
    };
  }

  const baseInput = await readJson(bundledProjectFilePath(locator));
  const bundledRoles = await readBundledRoleManifests(locator.projectId);
  const base =
    baseInput === null
      ? null
      : anchoredProjectFile(
          {
            ...normalizeMekaProjectFile(baseInput, locator.projectId),
            builtinRoles: bundledRoles,
          },
          locator.projectRoot,
        );
  if (!path.isAbsolute(locator.projectRoot)) return { file: base, source: 'builtin' };

  const projectPath = writableProjectFilePath(locator);
  const projectInput = await readJson(projectPath);
  if (projectInput === null) return { file: base, source: 'builtin' };

  let projectFile = normalizeProjectFileAtRoot(
    projectInput,
    locator.projectId,
    locator.projectRoot,
  );
  if (projectFile.builtinRoles === undefined) {
    projectFile = { ...projectFile, builtinRoles: bundledRoles };
    await atomicWriteJson(projectPath, projectFile);
  } else {
    assertCompleteBuiltinRoles(projectFile.builtinRoles, bundledRoles);
  }
  return { file: projectFile, source: 'project' };
}

export async function readEffectiveProjectConfig(
  locator: ProjectConfigLocator,
): Promise<MekaProjectFile | null> {
  return (await readProjectConfigState(locator)).file;
}

export async function saveProjectConfig(
  locator: ProjectConfigLocator,
  draft: MekaProjectFile,
): Promise<MekaProjectFile> {
  let normalized = normalizeMekaProjectFile(
    anchoredProjectFile(draft, locator.projectRoot),
    locator.projectId,
  );
  if (locator.isBuiltin) {
    const bundledRoles = await readBundledRoleManifests(locator.projectId);
    if (normalized.builtinRoles === undefined) {
      normalized = { ...normalized, builtinRoles: bundledRoles };
    } else {
      assertCompleteBuiltinRoles(normalized.builtinRoles, bundledRoles);
    }
  }
  await atomicWriteJson(writableProjectFilePath(locator), normalized);
  return normalized;
}

export async function createProjectConfigExclusive(
  locator: ProjectConfigLocator,
  draft: MekaProjectFile,
): Promise<MekaProjectFile> {
  if (locator.isBuiltin) throw new Error('builtin Meka project is read-only');
  const normalized = normalizeMekaProjectFile(
    anchoredProjectFile(draft, locator.projectRoot),
    locator.projectId,
  );
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
