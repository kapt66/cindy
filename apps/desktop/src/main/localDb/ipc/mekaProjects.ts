import { unlink } from 'node:fs/promises';
import path from 'node:path';

import { createId } from '@paralleldrive/cuid2';
import { app, ipcMain } from 'electron';

import type {
  MekaProject,
  MekaProjectFile,
  MekaRole,
  ProjectConfigLocator,
} from '../../../shared/meka-projects.js';
import { isIpcError } from '../../../shared/ipc-errors.js';
import {
  createProjectConfigExclusive,
  readEffectiveProjectConfig,
  readProjectConfigAtRoot,
  readProjectConfigState,
  resolveProjectConfigPath,
  saveProjectConfig,
} from '../../meka-projects/projectConfig.js';
import { getMekaP4SettingsService } from '../../meka-settings/ipc.js';
import { assertTrustedAppRendererEvent } from '../../security/trustedAppRenderer.js';
import { requireObject, requireString, throwIpcError } from '../../utils/ipcValidate.js';
import { getDbClient } from '../client/current.js';
import { ensureDefaultMekaRole } from './mekaRoles.js';

export const MEKA_PROJECT_LIST = 'meka-project:list';
export const MEKA_PROJECT_GET = 'meka-project:get';
export const MEKA_PROJECT_CREATE = 'meka-project:create';
export const MEKA_PROJECT_UPDATE = 'meka-project:update';
export const MEKA_PROJECT_DELETE = 'meka-project:delete';
export const MEKA_PROJECT_RESOLVE_PATH = 'meka-project:resolve-path';
export const MEKA_PROJECT_INSPECT_PATH = 'meka-project:inspect-path';
export const MEKA_PROJECT_RESET_BUILTIN = 'meka-project:reset-builtin';

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

interface ProjectRow {
  id: string;
  name: string;
  path: string | null;
  tags: string | null;
  is_builtin: number;
  sort_order: number;
  created_at: number | null;
  updated_at: number | null;
}

interface RoleRow {
  id: string;
  project_id: string;
  name: string;
  display_name: string;
  description: string | null;
  tags: string | null;
  file_path: string;
  is_builtin: number;
  content_digest: string | null;
  sort_order: number;
  created_at: number | null;
  updated_at: number | null;
}

function safeId(value: unknown, name: string): string {
  const id = requireString(value, name).trim();
  if (!SAFE_ID_RE.test(id))
    throwIpcError('INVALID_PARAMS', `${name} contains unsupported characters`);
  return id;
}

function displayName(value: unknown): string {
  const name = requireString(value, 'displayName').trim();
  if (name.length > 120) throwIpcError('INVALID_PARAMS', 'displayName is too long');
  return name;
}

function absoluteProjectPath(value: unknown): string {
  const input = requireString(value, 'path').trim();
  if (!path.isAbsolute(input)) throwIpcError('INVALID_PARAMS', 'path must be absolute');
  return path.normalize(input);
}

function tags(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throwIpcError('INVALID_PARAMS', 'tags must be an array of strings');
  }
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

function optionalTrimmed(value: unknown, name: string, max = 2048): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throwIpcError('INVALID_PARAMS', `${name} must be a string`);
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length > max) throwIpcError('INVALID_PARAMS', `${name} is too long`);
  return normalized;
}

function formalBasicPatch(
  patch: Record<string, unknown>,
  current: MekaProjectFile['basic'],
): Pick<
  MekaProjectFile['basic'],
  'formalWorkflowEnabled' | 'workflowType' | 'jiraProjectKey' | 'gitlabProjectUrl'
> {
  const formalWorkflowEnabled =
    patch.formalWorkflowEnabled === undefined
      ? current.formalWorkflowEnabled
      : patch.formalWorkflowEnabled === true;
  const workflowType = patch.workflowType === undefined ? current.workflowType : patch.workflowType;
  if (workflowType !== undefined && !['none', 'jira', 'gitlab'].includes(String(workflowType))) {
    throwIpcError('INVALID_PARAMS', 'workflowType must be none, jira or gitlab');
  }
  const jiraProjectKey =
    patch.jiraProjectKey === undefined
      ? current.jiraProjectKey
      : optionalTrimmed(patch.jiraProjectKey, 'jiraProjectKey', 64)?.toUpperCase();
  if (jiraProjectKey && !/^[A-Z][A-Z0-9]+$/.test(jiraProjectKey)) {
    throwIpcError('INVALID_PARAMS', 'jiraProjectKey is invalid');
  }
  const gitlabProjectUrl =
    patch.gitlabProjectUrl === undefined
      ? current.gitlabProjectUrl
      : optionalTrimmed(patch.gitlabProjectUrl, 'gitlabProjectUrl');
  if (gitlabProjectUrl) {
    let parsed: URL;
    try {
      parsed = new URL(gitlabProjectUrl);
    } catch {
      throwIpcError('INVALID_PARAMS', 'gitlabProjectUrl must be an absolute HTTPS URL');
    }
    if (parsed.protocol !== 'https:' || parsed.port || !parsed.pathname.replace(/\//g, '')) {
      throwIpcError('INVALID_PARAMS', 'gitlabProjectUrl must be HTTPS without a custom port');
    }
  }
  if (formalWorkflowEnabled && workflowType === 'jira' && !jiraProjectKey) {
    throwIpcError('INVALID_PARAMS', 'Jira formal workflow requires jiraProjectKey');
  }
  if (formalWorkflowEnabled && workflowType === 'gitlab' && !gitlabProjectUrl) {
    throwIpcError('INVALID_PARAMS', 'GitLab formal workflow requires gitlabProjectUrl');
  }
  return {
    formalWorkflowEnabled,
    workflowType: workflowType as MekaProjectFile['basic']['workflowType'],
    jiraProjectKey,
    gitlabProjectUrl,
  };
}

function parseTags(value: string | null): string[] {
  try {
    const parsed: unknown = JSON.parse(value ?? '[]');
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : [];
  } catch {
    return [];
  }
}

function roleFromRow(
  row: RoleRow,
  manifest?: NonNullable<MekaProjectFile['builtinRoles']>[number],
): MekaRole {
  return {
    id: row.id,
    projectId: row.project_id,
    name: manifest?.name ?? row.name,
    displayName: manifest?.displayName ?? row.display_name,
    description: manifest?.description ?? row.description,
    tags: manifest?.tags ?? parseTags(row.tags),
    filePath: row.file_path,
    isBuiltin: row.is_builtin === 1,
    contentDigest: row.content_digest,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function locator(row: ProjectRow, root = row.path): ProjectConfigLocator {
  if (row.is_builtin === 1) {
    return {
      projectId: row.id,
      isBuiltin: true,
      projectRoot: root && path.isAbsolute(root) ? path.resolve(root) : '',
      appIsPackaged: app.isPackaged,
    };
  }
  if (!root) throwIpcError('INVALID_PARAMS', 'project path is required');
  return {
    projectId: row.id,
    isBuiltin: false,
    projectRoot: absoluteProjectPath(root),
    appIsPackaged: app.isPackaged,
  };
}

async function projectRow(id: string): Promise<ProjectRow | undefined> {
  return getDbClient().queryOne<ProjectRow>('SELECT * FROM meka_projects WHERE id = ?', [id]);
}

async function rolesFor(projectId: string, file?: MekaProjectFile | null): Promise<MekaRole[]> {
  const builtinRoles = new Map((file?.builtinRoles ?? []).map((role) => [role.id, role]));
  return (
    await getDbClient().query<RoleRow>(
      'SELECT * FROM meka_roles WHERE project_id = ? ORDER BY sort_order, display_name',
      [projectId],
    )
  ).map((row) => roleFromRow(row, row.is_builtin === 1 ? builtinRoles.get(row.id) : undefined));
}

async function toProject(row: ProjectRow): Promise<MekaProject> {
  const builtinRoot =
    row.is_builtin === 1 ? (await getMekaP4SettingsService().get()).p4RootPath : null;
  const state = await readProjectConfigState(locator(row, builtinRoot ?? row.path));
  const file = state.file;
  const basic = file?.basic;
  return {
    id: row.id,
    name: basic?.name ?? row.name,
    displayName: basic?.displayName ?? row.name,
    description: basic?.description ?? null,
    path:
      row.is_builtin === 1 && builtinRoot && path.isAbsolute(builtinRoot)
        ? path.resolve(builtinRoot)
        : (basic?.path ?? row.path),
    additionalPaths: basic?.additionalPaths ?? [],
    formalWorkflowEnabled: basic?.formalWorkflowEnabled,
    jiraProjectKey: basic?.jiraProjectKey,
    workflowType: basic?.workflowType,
    gitlabProjectUrl: basic?.gitlabProjectUrl,
    tags: parseTags(row.tags),
    isBuiltin: row.is_builtin === 1,
    configSource: state.source,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    roles: await rolesFor(row.id, file),
  };
}

function rethrow(error: unknown, action: string): never {
  if (isIpcError(error)) throw error;
  if (/FOREIGN KEY constraint failed/i.test(String(error))) {
    throwIpcError('MEKA_PROJECT_IN_USE', `cannot ${action} a project that is still referenced`);
  }
  if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
    throwIpcError('ALREADY_EXISTS', 'the selected directory already contains .meka/project.json');
  }
  throwIpcError('INTERNAL', `failed to ${action} Meka project: ${String(error)}`);
}

async function listProjects(): Promise<MekaProject[]> {
  const rows = await getDbClient().query<ProjectRow>(
    'SELECT * FROM meka_projects ORDER BY sort_order, name',
  );
  return Promise.all(rows.map(toProject));
}

async function getProject(idInput: unknown): Promise<MekaProject | null> {
  const id = safeId(idInput, 'project id');
  const row = await projectRow(id);
  return row ? toProject(row) : null;
}

/** Trusted Main-side lookup used by formal workflow providers. */
export async function getMekaProjectById(id: string): Promise<MekaProject | null> {
  return getProject(id);
}

async function createProject(input: unknown): Promise<MekaProject> {
  try {
    const body = requireObject(input);
    const root = absoluteProjectPath(body.path);
    const configuredBuiltinRoot = (await getMekaP4SettingsService().get()).p4RootPath;
    const duplicate = (
      await getDbClient().query<ProjectRow>('SELECT * FROM meka_projects WHERE path IS NOT NULL')
    ).find((candidate) => {
      const candidateRoot = candidate.is_builtin === 1 ? configuredBuiltinRoot : candidate.path;
      if (!candidateRoot || !path.isAbsolute(candidateRoot)) return false;
      const left = path.resolve(candidateRoot);
      const right = path.resolve(root);
      return process.platform === 'win32'
        ? left.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0
        : left === right;
    });
    if (duplicate) {
      throwIpcError('ALREADY_EXISTS', 'the selected directory is already registered');
    }

    const existingFile = await readProjectConfigAtRoot(root);
    const id = existingFile?.projectId ?? safeId(createId(), 'generated project id');
    if (await projectRow(id)) {
      throwIpcError('ALREADY_EXISTS', `Meka project ${id} is already registered`);
    }
    const requestedName = displayName(body.displayName);
    const description =
      typeof body.description === 'string' && body.description.trim()
        ? body.description.trim()
        : undefined;
    const projectTags = tags(body.tags);
    const now = Date.now();
    const file: MekaProjectFile =
      existingFile ??
      ({
        schemaVersion: 1,
        projectId: id,
        basic: {
          name: id,
          displayName: requestedName,
          ...(description ? { description } : {}),
          path: root,
          ...(body.additionalPaths === undefined ? {} : { additionalPaths: body.additionalPaths }),
        },
        metadata: [],
      } as MekaProjectFile);
    const row: ProjectRow = {
      id,
      name: file.basic.name ?? id,
      path: root,
      tags: JSON.stringify(projectTags),
      is_builtin: 0,
      sort_order: 0,
      created_at: now,
      updated_at: now,
    };
    const target = locator(row, root);
    let createdProjectFile = false;
    if (!existingFile) {
      await createProjectConfigExclusive(target, file);
      createdProjectFile = true;
    }
    try {
      await getDbClient().exec(
        `INSERT INTO meka_projects
          (id, name, path, tags, is_builtin, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, 0, ?, ?)`,
        [id, row.name, root, JSON.stringify(projectTags), now, now],
      );
      await ensureDefaultMekaRole(id);
    } catch (error) {
      await getDbClient()
        .exec('DELETE FROM meka_roles WHERE project_id = ?', [id])
        .catch(() => undefined);
      await getDbClient()
        .exec('DELETE FROM meka_projects WHERE id = ?', [id])
        .catch(() => undefined);
      if (createdProjectFile) {
        await unlink(resolveProjectConfigPath(target)).catch(() => undefined);
      }
      throw error;
    }
    return toProject((await projectRow(id))!);
  } catch (error) {
    rethrow(error, 'create');
  }
}

async function resetBuiltinProject(idInput: unknown): Promise<MekaProject> {
  try {
    const id = safeId(idInput, 'project id');
    const row = await projectRow(id);
    if (!row) throwIpcError('MEKA_PROJECT_NOT_FOUND', `Meka project ${id} not found`);
    if (row.is_builtin !== 1) {
      throwIpcError('INVALID_PARAMS', 'only builtin projects can be reset');
    }
    const root = (await getMekaP4SettingsService().get()).p4RootPath;
    if (!root || !path.isAbsolute(root)) {
      throwIpcError('INVALID_PARAMS', 'configure the Meka P4 root before resetting the project');
    }
    await unlink(resolveProjectConfigPath(locator(row, root))).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      },
    );
    return toProject(row);
  } catch (error) {
    rethrow(error, 'reset');
  }
}

async function updateProject(input: unknown): Promise<MekaProject> {
  try {
    const body = requireObject(input);
    const id = safeId(body.id, 'project id');
    const patch = requireObject(body.patch, 'patch');
    const current = await projectRow(id);
    if (!current) throwIpcError('MEKA_PROJECT_NOT_FOUND', `Meka project ${id} not found`);
    const configuredRoot =
      current.is_builtin === 1 ? (await getMekaP4SettingsService().get()).p4RootPath : current.path;
    const projectLocator = locator(current, configuredRoot ?? current.path);
    if (!path.isAbsolute(projectLocator.projectRoot)) {
      throwIpcError(
        'INVALID_PARAMS',
        'configure the Meka P4 root before updating the builtin project',
      );
    }
    const currentFile = await readEffectiveProjectConfig(projectLocator);
    if (!currentFile) throwIpcError('INTERNAL', 'project.json is missing');
    // Moving a registered project would require a two-root transactional copy.
    // Keep update safe and explicit; path migration can be added as a separate operation.
    if (
      patch.path !== undefined &&
      absoluteProjectPath(patch.path) !== projectLocator.projectRoot
    ) {
      throwIpcError('MEKA_PROJECT_MOVE_UNSUPPORTED', 'project path cannot be changed in-place');
    }
    const nextName =
      patch.displayName === undefined
        ? currentFile.basic.displayName
        : displayName(patch.displayName);
    const nextDescription =
      patch.description === undefined
        ? currentFile.basic.description
        : typeof patch.description === 'string' && patch.description.trim()
          ? patch.description.trim()
          : undefined;
    const nextTags = patch.tags === undefined ? parseTags(current.tags) : tags(patch.tags);
    const nextFormal = formalBasicPatch(patch, currentFile.basic);
    const nextFile: MekaProjectFile = {
      ...currentFile,
      basic: {
        ...currentFile.basic,
        displayName: nextName,
        ...(nextDescription ? { description: nextDescription } : { description: undefined }),
        ...nextFormal,
      },
    };
    await saveProjectConfig(projectLocator, nextFile);
    try {
      await getDbClient().exec('UPDATE meka_projects SET tags = ?, updated_at = ? WHERE id = ?', [
        JSON.stringify(nextTags),
        Date.now(),
        id,
      ]);
    } catch (error) {
      await saveProjectConfig(projectLocator, currentFile);
      throw error;
    }
    return toProject((await projectRow(id))!);
  } catch (error) {
    rethrow(error, 'update');
  }
}

async function deleteProject(idInput: unknown): Promise<void> {
  try {
    const id = safeId(idInput, 'project id');
    const row = await projectRow(id);
    if (!row) throwIpcError('MEKA_PROJECT_NOT_FOUND', `Meka project ${id} not found`);
    if (row.is_builtin === 1)
      throwIpcError('MEKA_BUILTIN_READ_ONLY', 'builtin project is read-only');
    // Portable .meka/project.json is intentionally retained. Deleting the app
    // registry must not delete project-owned source or metadata.
    await getDbClient().exec('BEGIN IMMEDIATE');
    try {
      await getDbClient().exec('DELETE FROM meka_roles WHERE project_id = ?', [id]);
      await getDbClient().exec('DELETE FROM meka_projects WHERE id = ?', [id]);
      await getDbClient().exec('COMMIT');
    } catch (error) {
      await getDbClient()
        .exec('ROLLBACK')
        .catch(() => undefined);
      throw error;
    }
  } catch (error) {
    rethrow(error, 'delete');
  }
}

export function registerMekaProjectsIpc(): void {
  ipcMain.handle(MEKA_PROJECT_LIST, () => listProjects());
  ipcMain.handle(MEKA_PROJECT_GET, (_event, id: unknown) => getProject(id));
  ipcMain.handle(MEKA_PROJECT_CREATE, (event, input: unknown) => {
    assertTrustedAppRendererEvent(event);
    return createProject(input);
  });
  ipcMain.handle(MEKA_PROJECT_INSPECT_PATH, (event, root: unknown) => {
    assertTrustedAppRendererEvent(event);
    return readProjectConfigAtRoot(absoluteProjectPath(root));
  });
  ipcMain.handle(MEKA_PROJECT_RESET_BUILTIN, (event, id: unknown) => {
    assertTrustedAppRendererEvent(event);
    return resetBuiltinProject(id);
  });
  ipcMain.handle(MEKA_PROJECT_UPDATE, (event, input: unknown) => {
    assertTrustedAppRendererEvent(event);
    return updateProject(input);
  });
  ipcMain.handle(MEKA_PROJECT_DELETE, (event, id: unknown) => {
    assertTrustedAppRendererEvent(event);
    return deleteProject(id);
  });
  ipcMain.handle(MEKA_PROJECT_RESOLVE_PATH, async (_event, id: unknown) => {
    const row = await projectRow(safeId(id, 'project id'));
    const builtinRoot =
      row?.is_builtin === 1 ? (await getMekaP4SettingsService().get()).p4RootPath : null;
    return {
      resolvedPath:
        row?.is_builtin === 1
          ? builtinRoot && path.isAbsolute(builtinRoot)
            ? path.resolve(builtinRoot)
            : null
          : row?.path && path.isAbsolute(row.path)
            ? path.resolve(row.path)
            : null,
    };
  });
}
