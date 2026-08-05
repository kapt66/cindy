import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

import { app, ipcMain } from 'electron';

import type {
  MekaProjectFile,
  MekaProjectMetadata,
  MekaProjectMetadataConfigItem,
  ProjectConfigLocator,
} from '../../../shared/meka-projects.js';
import { isIpcError } from '../../../shared/ipc-errors.js';
import { getRipgrepBinaryPath } from '../../maker-host/runtime-configs.js';
import {
  discoverLocalMekaProjectMetadata,
  type DiscoveredMekaProjectMetadata,
} from '../../meka-projects/metadataScanner.js';
import {
  readEffectiveProjectConfig,
  saveProjectConfig,
} from '../../meka-projects/projectConfig.js';
import { getMekaP4SettingsService } from '../../meka-settings/ipc.js';
import { requireObject, requireString, throwIpcError } from '../../utils/ipcValidate.js';
import { getDbClient } from '../client/current.js';

export const MEKA_PROJECT_METADATA_DISCOVER = 'meka-project-metadata:discover';
export const MEKA_PROJECT_METADATA_LIST = 'meka-project-metadata:list';
export const MEKA_PROJECT_LOAD = 'meka-project:load';
export const MEKA_PROJECT_SAVE = 'meka-project:save';
export const MEKA_PROJECT_GIT_REMOTE = 'meka-project:git-remote';

const execFileAsync = promisify(execFile);
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

interface ProjectRow {
  id: string;
  name: string;
  path: string | null;
  is_builtin: number;
}

function safeId(value: unknown): string {
  const id = requireString(value, 'projectId').trim();
  if (!SAFE_ID_RE.test(id))
    throwIpcError('INVALID_PARAMS', 'projectId contains unsupported characters');
  return id;
}

async function context(
  projectIdInput: unknown,
): Promise<{ row: ProjectRow; locator: ProjectConfigLocator }> {
  const projectId = safeId(projectIdInput);
  const row = await getDbClient().queryOne<ProjectRow>(
    'SELECT id, name, path, is_builtin FROM meka_projects WHERE id = ?',
    [projectId],
  );
  if (!row) throwIpcError('MEKA_PROJECT_NOT_FOUND', `Meka project ${projectId} not found`);
  if (row.is_builtin === 1) {
    const p4RootPath = (await getMekaP4SettingsService().get()).p4RootPath;
    return {
      row,
      locator: {
        projectId,
        isBuiltin: true,
        projectRoot: p4RootPath ?? '',
        appIsPackaged: app.isPackaged,
      },
    };
  }
  if (!row.path || !path.isAbsolute(row.path))
    throwIpcError('INVALID_PARAMS', 'project path must be absolute');
  return {
    row,
    locator: {
      projectId,
      isBuiltin: false,
      projectRoot: path.resolve(row.path),
      appIsPackaged: true,
    },
  };
}

function effectiveItem(
  projectId: string,
  item: MekaProjectMetadataConfigItem,
): MekaProjectMetadata {
  return {
    projectId,
    ...(item.rootPath ? { rootPath: item.rootPath } : {}),
    sourcePath: item.sourcePath,
    itemType: item.itemType,
    subProjectPath: item.subProjectPath ?? null,
    name: item.name ?? path.posix.basename(item.sourcePath),
    contentFingerprint: item.contentFingerprint ?? '',
    disciplines: item.disciplines ?? [],
    domains: item.domains ?? [],
    enabled: item.enabled ?? true,
    ...(item.displayName ? { displayName: item.displayName } : {}),
    ...(item.description ? { description: item.description } : {}),
    ...(item.notes ? { notes: item.notes } : {}),
  };
}

function mergeDiscovered(
  current: MekaProjectFile,
  discovered: readonly DiscoveredMekaProjectMetadata[],
): MekaProjectFile {
  const previous = new Map(
    current.metadata.map((item) => [
      `${item.rootPath ?? ''}|${item.sourcePath}|${item.itemType}`,
      item,
    ]),
  );
  return {
    ...current,
    metadata: discovered.map((item) => {
      const old = previous.get(`${item.rootPath ?? ''}|${item.sourcePath}|${item.itemType}`);
      return {
        ...old,
        ...item,
        disciplines: old?.disciplines ?? [],
        domains: old?.domains ?? [],
        enabled: old?.enabled ?? true,
      };
    }),
  };
}

function rethrow(error: unknown, action: string): never {
  if (isIpcError(error)) throw error;
  throwIpcError('INTERNAL', `failed to ${action} Meka project metadata: ${String(error)}`);
}

async function loadProject(projectIdInput: unknown): Promise<MekaProjectFile> {
  const { locator } = await context(projectIdInput);
  const file = await readEffectiveProjectConfig(locator);
  if (!file) throwIpcError('NOT_FOUND', 'project.json not found');
  return file;
}

async function saveProject(input: unknown): Promise<MekaProjectFile> {
  try {
    const body = requireObject(input);
    const { row, locator } = await context(body.projectId);
    if (row.is_builtin === 1 && !path.isAbsolute(locator.projectRoot)) {
      throwIpcError(
        'INVALID_PARAMS',
        'configure the Meka P4 root before saving the builtin project',
      );
    }
    const saved = await saveProjectConfig(locator, body.project as MekaProjectFile);
    await getDbClient().exec(
      'UPDATE meka_projects SET name = ?, path = ?, updated_at = ? WHERE id = ?',
      [saved.basic.name ?? row.name, saved.basic.path, Date.now(), saved.projectId],
    );
    return saved;
  } catch (error) {
    rethrow(error, 'save');
  }
}

async function discover(projectIdInput: unknown): Promise<MekaProjectMetadata[]> {
  try {
    const { locator } = await context(projectIdInput);
    if (!path.isAbsolute(locator.projectRoot)) {
      throwIpcError(
        'INVALID_PARAMS',
        'configure the Meka P4 root before discovering project metadata',
      );
    }
    const current = await readEffectiveProjectConfig(locator);
    if (!current) throwIpcError('NOT_FOUND', 'project.json not found');
    const found = await discoverLocalMekaProjectMetadata(
      locator.projectRoot,
      getRipgrepBinaryPath(),
      current.basic.additionalPaths ?? [],
    );
    const next = mergeDiscovered(current, found);
    await saveProjectConfig(locator, next);
    return next.metadata.map((item) => effectiveItem(locator.projectId, item));
  } catch (error) {
    rethrow(error, 'discover');
  }
}

async function list(projectIdInput: unknown): Promise<MekaProjectMetadata[]> {
  const project = await loadProject(projectIdInput);
  return project.metadata.map((item) => effectiveItem(project.projectId, item));
}

async function gitRemote(projectIdInput: unknown): Promise<string | null> {
  const { locator } = await context(projectIdInput);
  if (!path.isAbsolute(locator.projectRoot)) return null;
  try {
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
      cwd: locator.projectRoot,
      timeout: 5_000,
      windowsHide: true,
    });
    const raw = stdout.trim().replace(/\.git$/, '');
    const scp = /^git@([^:]+):(.+)$/.exec(raw);
    if (scp) return `https://${scp[1]}/${scp[2]}`;
    const ssh = /^ssh:\/\/(?:[^/@]+@)?([^/]+)\/(.+)$/.exec(raw);
    if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
    return raw.replace(/^http:\/\//, 'https://') || null;
  } catch {
    return null;
  }
}

export function registerMekaProjectMetadataIpc(): void {
  ipcMain.handle(MEKA_PROJECT_METADATA_DISCOVER, (_event, id: unknown) => discover(id));
  ipcMain.handle(MEKA_PROJECT_METADATA_LIST, (_event, id: unknown) => list(id));
  ipcMain.handle(MEKA_PROJECT_LOAD, (_event, id: unknown) => loadProject(id));
  ipcMain.handle(MEKA_PROJECT_SAVE, (_event, input: unknown) => saveProject(input));
  ipcMain.handle(MEKA_PROJECT_GIT_REMOTE, (_event, id: unknown) => gitRemote(id));
}
