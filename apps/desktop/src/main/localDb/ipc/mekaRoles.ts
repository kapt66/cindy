import { createHash } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';

import { createId } from '@paralleldrive/cuid2';
import { app, ipcMain } from 'electron';

import type { MekaRole, MekaRoleManifestFile } from '../../../shared/meka-projects.js';
import { isIpcError } from '../../../shared/ipc-errors.js';
import {
  createCustomRoleManifestExclusive,
  normalizeMekaRoleManifest,
  readBuiltinRoleManifest,
  readCustomRoleManifest,
  resolveCustomRoleManifestPath,
  writeCustomRoleManifest,
} from '../../meka-projects/projectConfig.js';
import { requireObject, requireString, throwIpcError } from '../../utils/ipcValidate.js';
import { getDbClient } from '../client/current.js';

export const MEKA_ROLE_LIST = 'meka-role:list';
export const MEKA_ROLE_CREATE = 'meka-role:create';
export const MEKA_ROLE_UPDATE = 'meka-role:update';
export const MEKA_ROLE_DELETE = 'meka-role:delete';
export const MEKA_ROLE_READ_MANIFEST = 'meka-role:read-manifest';

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export const DEFAULT_MEKA_PROJECT_ROLE_DISPLAY_NAME = '通用';

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

export interface CreateMekaRoleInput {
  projectId: string;
  roleFile: Omit<MekaRoleManifestFile, 'id' | 'name' | 'projectId'>;
  sortOrder?: number;
}

export interface UpdateMekaRoleInput {
  projectId: string;
  roleFile: MekaRoleManifestFile;
  sortOrder?: number;
}

function safeId(value: unknown, name: string): string {
  const id = requireString(value, name).trim();
  if (!SAFE_ID_RE.test(id)) throwIpcError('INVALID_PARAMS', `${name} contains unsupported characters`);
  return id;
}

function parseTags(value: string | null): string[] {
  try {
    const parsed: unknown = JSON.parse(value ?? '[]');
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : [];
  } catch {
    return [];
  }
}

function toRole(row: RoleRow): MekaRole {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    displayName: row.display_name,
    description: row.description,
    tags: parseTags(row.tags),
    filePath: row.file_path,
    isBuiltin: row.is_builtin === 1,
    contentDigest: row.content_digest,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function digest(manifest: MekaRoleManifestFile): string {
  return createHash('sha256').update(JSON.stringify(manifest), 'utf8').digest('hex');
}

function sortOrder(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throwIpcError('INVALID_PARAMS', 'sortOrder must be a non-negative integer');
  }
  return value;
}

async function projectExists(projectId: string): Promise<boolean> {
  return Boolean(await getDbClient().queryOne('SELECT id FROM meka_projects WHERE id = ?', [projectId]));
}

async function roleRow(roleId: string): Promise<RoleRow | undefined> {
  return getDbClient().queryOne<RoleRow>('SELECT * FROM meka_roles WHERE id = ?', [roleId]);
}

async function upsertRole(
  manifest: MekaRoleManifestFile,
  order: number,
  createdAt: number,
): Promise<MekaRole> {
  const now = Date.now();
  const filePath = `meka-roles/${manifest.id}.json`;
  await getDbClient().exec(
    `INSERT INTO meka_roles
      (id, project_id, name, display_name, description, tags, file_path,
       is_builtin, content_digest, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       project_id=excluded.project_id, name=excluded.name,
       display_name=excluded.display_name, description=excluded.description,
       tags=excluded.tags, file_path=excluded.file_path,
       content_digest=excluded.content_digest, sort_order=excluded.sort_order,
       updated_at=excluded.updated_at
     WHERE meka_roles.is_builtin=0`,
    [
      manifest.id,
      manifest.projectId,
      manifest.name,
      manifest.displayName,
      manifest.description ?? null,
      JSON.stringify(manifest.tags ?? []),
      filePath,
      digest(manifest),
      order,
      createdAt,
      now,
    ],
  );
  const row = await roleRow(manifest.id);
  if (!row) throw new Error('role row missing after upsert');
  return toRole(row);
}

function rethrow(error: unknown, action: string): never {
  if (isIpcError(error)) throw error;
  if (/FOREIGN KEY constraint failed/i.test(String(error))) {
    throwIpcError('MEKA_ROLE_IN_USE', `cannot ${action} a role that is still referenced`);
  }
  throwIpcError('INTERNAL', `failed to ${action} Meka role: ${String(error)}`);
}

export function createDefaultMekaRoleManifest(projectId: string, roleId: string): MekaRoleManifestFile {
  return {
    schemaVersion: 1,
    id: roleId,
    projectId,
    name: roleId,
    displayName: DEFAULT_MEKA_PROJECT_ROLE_DISPLAY_NAME,
    policyProviderRefs: [],
    rules: [],
    skills: [],
    promptFragments: [],
    mcp: [],
    projectMetadataSelection: [],
  };
}

export async function createMekaRole(input: unknown): Promise<MekaRole> {
  try {
    const body = requireObject(input);
    const projectId = safeId(body.projectId, 'projectId');
    if (!(await projectExists(projectId))) {
      throwIpcError('MEKA_PROJECT_NOT_FOUND', `Meka project ${projectId} not found`);
    }
    const id = safeId(createId(), 'generated role id');
    const roleFile = requireObject(body.roleFile, 'roleFile');
    const manifest = normalizeMekaRoleManifest({
      ...roleFile,
      schemaVersion: 1,
      id,
      projectId,
      name: id,
    }, id, projectId);
    const userData = app.getPath('userData');
    await createCustomRoleManifestExclusive(id, manifest, userData);
    try {
      return await upsertRole(manifest, sortOrder(body.sortOrder), Date.now());
    } catch (error) {
      await unlink(resolveCustomRoleManifestPath(id, userData)).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    rethrow(error, 'create');
  }
}

export async function ensureDefaultMekaRole(projectIdInput: string): Promise<MekaRole> {
  const projectId = safeId(projectIdInput, 'projectId');
  const existing = await getDbClient().queryOne<RoleRow>(
    'SELECT * FROM meka_roles WHERE project_id = ? ORDER BY sort_order, created_at LIMIT 1',
    [projectId],
  );
  if (existing) return toRole(existing);
  const id = safeId(createId(), 'generated role id');
  const manifest = createDefaultMekaRoleManifest(projectId, id);
  const userData = app.getPath('userData');
  await createCustomRoleManifestExclusive(id, manifest, userData);
  try {
    return await upsertRole(manifest, 0, Date.now());
  } catch (error) {
    await unlink(resolveCustomRoleManifestPath(id, userData)).catch(() => undefined);
    throw error;
  }
}

async function updateMekaRole(input: unknown): Promise<MekaRole> {
  try {
    const body = requireObject(input);
    const projectId = safeId(body.projectId, 'projectId');
    const roleFile = requireObject(body.roleFile, 'roleFile');
    const id = safeId(roleFile.id, 'role id');
    const current = await roleRow(id);
    if (!current) throwIpcError('MEKA_ROLE_NOT_FOUND', `Meka role ${id} not found`);
    if (current.is_builtin === 1) throwIpcError('MEKA_BUILTIN_READ_ONLY', 'builtin role is read-only');
    if (current.project_id !== projectId) throwIpcError('INVALID_PARAMS', 'role projectId mismatch');
    const manifest = normalizeMekaRoleManifest(roleFile, id, projectId);
    const userData = app.getPath('userData');
    const previous = await readCustomRoleManifest(id, userData, projectId);
    await writeCustomRoleManifest(id, manifest, userData);
    try {
      return await upsertRole(manifest, sortOrder(body.sortOrder ?? current.sort_order), current.created_at ?? Date.now());
    } catch (error) {
      if (previous) await writeCustomRoleManifest(id, previous, userData);
      throw error;
    }
  } catch (error) {
    rethrow(error, 'update');
  }
}

async function deleteMekaRole(idInput: unknown): Promise<void> {
  try {
    const id = safeId(idInput, 'role id');
    const current = await roleRow(id);
    if (!current) throwIpcError('MEKA_ROLE_NOT_FOUND', `Meka role ${id} not found`);
    if (current.is_builtin === 1) throwIpcError('MEKA_BUILTIN_READ_ONLY', 'builtin role is read-only');
    const count = await getDbClient().queryOne<{ count: number }>(
      'SELECT COUNT(*) AS count FROM meka_roles WHERE project_id = ?',
      [current.project_id],
    );
    if ((count?.count ?? 0) <= 1) {
      throwIpcError('MEKA_ROLE_REQUIRED', 'a Meka project must keep at least one role');
    }
    const userData = app.getPath('userData');
    const previous = await readCustomRoleManifest(id, userData, current.project_id);
    const filePath = resolveCustomRoleManifestPath(id, userData);
    await unlink(filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    try {
      await getDbClient().exec('DELETE FROM meka_roles WHERE id = ?', [id]);
    } catch (error) {
      if (previous) await writeFile(filePath, `${JSON.stringify(previous, null, 2)}\n`, { mode: 0o600 });
      throw error;
    }
  } catch (error) {
    rethrow(error, 'delete');
  }
}

async function listMekaRoles(projectIdInput: unknown): Promise<MekaRole[]> {
  const projectId = safeId(projectIdInput, 'projectId');
  return (await getDbClient().query<RoleRow>(
    'SELECT * FROM meka_roles WHERE project_id = ? ORDER BY sort_order, display_name',
    [projectId],
  )).map(toRole);
}

async function readRoleManifest(roleIdInput: unknown): Promise<MekaRoleManifestFile | null> {
  const roleId = safeId(roleIdInput, 'role id');
  const row = await roleRow(roleId);
  if (!row) return null;
  if (row.is_builtin === 1) return readBuiltinRoleManifest(roleId, row.project_id);
  return readCustomRoleManifest(roleId, app.getPath('userData'), row.project_id);
}

export function registerMekaRolesIpc(): void {
  ipcMain.handle(MEKA_ROLE_LIST, (_event, projectId: unknown) => listMekaRoles(projectId));
  ipcMain.handle(MEKA_ROLE_CREATE, (_event, input: unknown) => createMekaRole(input));
  ipcMain.handle(MEKA_ROLE_UPDATE, (_event, input: unknown) => updateMekaRole(input));
  ipcMain.handle(MEKA_ROLE_DELETE, (_event, id: unknown) => deleteMekaRole(id));
  ipcMain.handle(MEKA_ROLE_READ_MANIFEST, (_event, id: unknown) => readRoleManifest(id));
}
