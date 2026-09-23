import { createHash } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createId } from '@paralleldrive/cuid2';
import { app, ipcMain } from 'electron';

import type {
  MekaProjectFile,
  MekaProjectMetadataSelection,
  MekaRole,
  MekaRoleManifestFile,
  MekaRoleSkillEntry,
  MekaRoleSkillSelection,
} from '../../../shared/meka-projects.js';
import {
  MEKA_DEFAULT_ROLE_UPSERT_SQL,
  mekaDefaultRoleId,
  mekaDefaultRoleManifest,
  mekaDefaultRoleUpsertParams,
} from '../../../shared/meka-projects.js';
import { isIpcError } from '../../../shared/ipc-errors.js';
import { createLogger } from '../../logger.js';
import {
  createCustomRoleManifestExclusive,
  normalizeMekaRoleManifest,
  readBuiltinRoleManifest,
  readCustomRoleManifest,
  readProjectConfigState,
  resolveCustomRoleManifestPath,
  saveProjectConfig,
  writeCustomRoleManifest,
} from '../../meka-projects/projectConfig.js';
import {
  listBundledSkills,
  mergeMekaProjectRoleDefaults,
  resolveBundledSkillSelections,
  resolveRoleProjectMetadataSelections,
  stripSelectAllDerivedEntries,
} from '../../meka-projects/runtimeConfig.js';
import { getMekaP4SettingsService } from '../../meka-settings/ipc.js';
import { assertTrustedAppRendererEvent } from '../../security/trustedAppRenderer.js';
import { requireObject, requireString, throwIpcError } from '../../utils/ipcValidate.js';
import { getDbClient } from '../client/current.js';

export const MEKA_ROLE_LIST = 'meka-role:list';
export const MEKA_ROLE_CREATE = 'meka-role:create';
export const MEKA_ROLE_UPDATE = 'meka-role:update';
export const MEKA_ROLE_DELETE = 'meka-role:delete';
export const MEKA_ROLE_READ_MANIFEST = 'meka-role:read-manifest';

const log = createLogger('meka-roles');

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

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

interface ProjectRow {
  id: string;
  path: string | null;
  is_builtin: number;
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
  if (!SAFE_ID_RE.test(id))
    throwIpcError('INVALID_PARAMS', `${name} contains unsupported characters`);
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

function roleFromManifest(row: RoleRow, manifest: MekaRoleManifestFile): MekaRole {
  return {
    ...toRole(row),
    name: manifest.name,
    displayName: manifest.displayName,
    description: manifest.description ?? null,
    tags: manifest.tags ?? [],
    contentDigest: digest(manifest),
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
  return Boolean(
    await getDbClient().queryOne('SELECT id FROM meka_projects WHERE id = ?', [projectId]),
  );
}

async function roleRow(roleId: string): Promise<RoleRow | undefined> {
  return getDbClient().queryOne<RoleRow>('SELECT * FROM meka_roles WHERE id = ?', [roleId]);
}

async function projectRow(projectId: string): Promise<ProjectRow | undefined> {
  return getDbClient().queryOne<ProjectRow>(
    'SELECT id, path, is_builtin FROM meka_projects WHERE id = ?',
    [projectId],
  );
}

async function builtinProjectState(projectId: string) {
  const project = await projectRow(projectId);
  if (!project || project.is_builtin !== 1) return null;
  const projectRoot = (await getMekaP4SettingsService().get()).p4RootPath ?? '';
  return readProjectConfigState({
    projectId,
    isBuiltin: true,
    projectRoot: path.isAbsolute(projectRoot) ? path.resolve(projectRoot) : '',
    appIsPackaged: app.isPackaged,
  });
}

/**
 * Project configuration for a role's project, for both built-in and project-owned
 * registrations. Deliberately best-effort instead of validating: it only feeds a read-only panel
 * read, so an unavailable project row, path or configuration file returns `null` — and the caller
 * falls back to the stored manifest — rather than failing the whole panel.
 */
async function projectFileForRole(projectId: string): Promise<MekaProjectFile | null> {
  const project = await projectRow(projectId);
  if (!project) return null;
  if (project.is_builtin === 1) return (await builtinProjectState(projectId))?.file ?? null;
  const configuredPath = project.path?.trim();
  if (!configuredPath || !path.isAbsolute(configuredPath)) return null;
  return (
    await readProjectConfigState({
      projectId,
      isBuiltin: false,
      projectRoot: path.resolve(configuredPath),
      appIsPackaged: app.isPackaged,
    })
  ).file;
}

/**
 * Per-list keys of the entries {@link expandRoleManifest} derived from the role's switches instead
 * of from the manifest's own lists.
 *
 * **Display-only, never persisted.** `meka-role:read-manifest` attaches it to its result so the
 * panel can tell a row it may not remove apart from one the role owns: a derived row is laid back
 * down by the runtime on every resolve, so deleting it from the draft cannot stick and only the
 * row's `enabled: false` checkbox is an exclusion the runtime honours. Nothing else may consume it.
 * `normalizeMekaRoleManifest` (`meka-projects/projectConfig.ts`) rebuilds the manifest field by
 * field, so even a payload that carries this field cannot write it to disk.
 */
interface MekaRoleDerivedEntryKeys {
  rules: string[];
  skills: string[];
  mcp: string[];
  metadata: string[];
}

/**
 * A manifest as `read-manifest` returns it: the expanded lists plus their display-only derived keys.
 */
type ExpandedMekaRoleManifest = MekaRoleManifestFile & {
  derivedEntryKeys?: MekaRoleDerivedEntryKeys;
};

/**
 * Metadata key of `stripSelectAllDerivedEntries` / `resolveRoleProjectMetadataSelections`.
 *
 * **Must stay byte-identical to `metadataKey` in `meka-projects/runtimeConfig.ts`** (same field
 * order, `\0` separator): the derived key sets below are computed by differencing that strip
 * function's output, and a key with a different shape would silently report nothing as derived.
 * The runtime keeps the helper private, so this is a minimal local copy rather than a second rule.
 */
function metadataSelectionKey(
  selection: Pick<MekaProjectMetadataSelection, 'rootPath' | 'sourcePath' | 'itemType'>,
): string {
  return `${selection.rootPath ?? ''}\0${selection.sourcePath}\0${selection.itemType}`;
}

/**
 * Skill key of `mergeSkills` / `skillSelectionKey` in `meka-projects/runtimeConfig.ts`
 * (`isLegacySkill(entry) ? entry.id : entry.skillId`). Same constraint as
 * {@link metadataSelectionKey}: a local copy that must stay in step with the strip pass.
 */
function skillSelectionKey(entry: MekaRoleSkillSelection | MekaRoleSkillEntry): string {
  return 'path' in entry ? entry.id : entry.skillId;
}

/**
 * Keys present in `expanded` whose entries `stripSelectAllDerivedEntries` removed.
 *
 * That strip keeps exactly the entries the three switches cannot re-derive — the author's own
 * additions and the author's modifications (`enabled: false`) — so a key with **no survivor** is one
 * the switches alone produced. Those are the entries the runtime lays back down on every resolve,
 * which is what makes their "remove" button a no-op.
 */
function derivedEntryKeysOf(
  expanded: MekaRoleManifestFile,
  projectFile: MekaProjectFile,
  catalog: ReadonlyMap<string, string>,
): MekaRoleDerivedEntryKeys {
  const stripped = stripSelectAllDerivedEntries(expanded, projectFile, catalog);
  const keptRuleIds = new Set((stripped.rules ?? []).map((rule) => rule.id));
  const keptSkillKeys = new Set(stripped.skills.map(skillSelectionKey));
  const keptMcpIds = new Set(stripped.mcp.map((entry) => entry.id));
  const keptMetadataKeys = new Set(
    (stripped.projectMetadataSelection ?? []).map(metadataSelectionKey),
  );
  return {
    rules: (expanded.rules ?? [])
      .filter((rule) => !keptRuleIds.has(rule.id))
      .map((rule) => rule.id),
    skills: expanded.skills
      .filter((entry) => !keptSkillKeys.has(skillSelectionKey(entry)))
      .map(skillSelectionKey),
    mcp: expanded.mcp.filter((entry) => !keptMcpIds.has(entry.id)).map((entry) => entry.id),
    metadata: (expanded.projectMetadataSelection ?? [])
      .filter((selection) => !keptMetadataKeys.has(metadataSelectionKey(selection)))
      .map(metadataSelectionKey),
  };
}

/** A role with nothing switch-derived keeps the exact shape it had before this field existed. */
function hasDerivedEntryKeys(keys: MekaRoleDerivedEntryKeys): boolean {
  return (
    keys.rules.length > 0 ||
    keys.skills.length > 0 ||
    keys.mcp.length > 0 ||
    keys.metadata.length > 0
  );
}

/**
 * Expand a role manifest into its effective selections through the same pure functions the
 * runtime uses, in the same order (`mergeMekaProjectRoleDefaults` → the metadata selection
 * resolver → the bundled-catalog skill expansion). A role that opts into the project's defaults or
 * into the bundled catalog ships `rules` / `skills` / `mcp` / `projectMetadataSelection` empty on
 * purpose: those lists only become real at resolve time. The editor panel renders the manifest's
 * explicit lists, so handing it the raw manifest made such a role look like it configures nothing
 * — the opposite of its contract, and (for `includeAllBundledSkills`) it left the bundled skills
 * the role really mounts unchecked in the panel.
 *
 * `includeAllBundledSkills` only needs the in-package catalog, so its ids come from
 * `listBundledSkills()` — the very scan the runtime expands from, reached through the same
 * `resolveBundledSkillSelections` helper — and skill bodies are never read here: the panel needs
 * the id list, not the content. That scan is done **only** when the role asks for it, so a role
 * that merely absorbs its project defaults never depends on the catalog being scannable.
 *
 * The gate is the three manifest flags — never a role id or name — so any role that does not opt
 * in is returned untouched without reading project configuration at all, and anything that cannot
 * be resolved (no project file, no catalog) degrades to the stored manifest rather than throwing.
 * Both degradation paths return the stored manifest as it is, i.e. **without** `derivedEntryKeys`:
 * they have no expansion to difference, and a field that claimed derived rows there would be wrong
 * rather than merely absent.
 *
 * The result additionally carries the display-only `derivedEntryKeys` of the expansion, computed at
 * the same place the expansion is (see {@link derivedEntryKeysOf}); that field exists so the panel
 * can refuse to offer a removal that the runtime would immediately undo.
 */
async function expandRoleManifest(
  manifest: MekaRoleManifestFile,
): Promise<ExpandedMekaRoleManifest> {
  if (
    manifest.useProjectDefaults !== true &&
    manifest.includeAllProjectMetadata !== true &&
    manifest.includeAllBundledSkills !== true
  ) {
    return manifest;
  }
  try {
    const projectFile = await projectFileForRole(manifest.projectId);
    if (!projectFile) return manifest;
    const merged = mergeMekaProjectRoleDefaults(manifest, projectFile.roleDefaults ?? {});
    const expanded: MekaRoleManifestFile = {
      ...merged,
      projectId: manifest.projectId,
      projectMetadataSelection: resolveRoleProjectMetadataSelections(merged, projectFile.metadata),
    };
    // The scan stays conditional, and it happens at most once: with `includeAllBundledSkills` off
    // the expansion cannot contain catalog entries, and `resolveBundledSkillSelections` returns the
    // same emptied list for any catalog — so the strip pass below is handed an empty map instead of
    // paying for a scan that provably cannot change its outcome.
    const catalog =
      manifest.includeAllBundledSkills === true
        ? await listBundledSkills()
        : new Map<string, string>();
    const effective: MekaRoleManifestFile =
      manifest.includeAllBundledSkills === true
        ? { ...expanded, skills: resolveBundledSkillSelections(merged, catalog) }
        : expanded;
    const derivedEntryKeys = derivedEntryKeysOf(effective, projectFile, catalog);
    return hasDerivedEntryKeys(derivedEntryKeys) ? { ...effective, derivedEntryKeys } : effective;
  } catch (error) {
    log.warn('role manifest expansion unavailable; using the stored manifest', {
      roleId: manifest.id,
      projectId: manifest.projectId,
      error: error instanceof Error ? error.message : String(error),
    });
    return manifest;
  }
}

/**
 * Write-side counterpart of {@link expandRoleManifest}: both save paths receive the **expanded**
 * draft the panel round-tripped from `read-manifest`, and writing it back verbatim would
 * materialize the switch-derived entries on disk.
 *
 * `stripSelectAllDerivedEntries` owns the rule (only entries deep-equal to the ones the switches
 * alone derive are dropped); this wrapper owns the IO gating, so it stays best-effort by contract:
 *
 * - the three flags are the only gate. A role that opts into nothing returns here before any
 *   project or catalog read — the same zero-cost path `expandRoleManifest` takes;
 * - the bundled catalog is scanned only when `includeAllBundledSkills` is on. With the flag off
 *   `resolveBundledSkillSelections` returns that same emptied list regardless of the catalog, so
 *   skipping the scan cannot change the outcome;
 * - an unavailable project file (or any failure while reading it / the catalog) means "do not
 *   strip" and never a failed save. The panel read degrades the same way, and a save must not
 *   throw for a reason `normalizeMekaRoleManifest` would not have thrown for either.
 *
 * The parameter stays `unknown` because both callers reach this point with the raw renderer
 * payload, which `normalizeMekaRoleManifest` validates right afterwards. `projectId` is passed
 * explicitly instead of trusting the payload's own `projectId` (which is only checked by that
 * later validation).
 */
async function stripSelectAllDerivedForSave(input: unknown, projectId: string): Promise<unknown> {
  const manifest = input as MekaRoleManifestFile;
  if (
    manifest.useProjectDefaults !== true &&
    manifest.includeAllProjectMetadata !== true &&
    manifest.includeAllBundledSkills !== true
  ) {
    return input;
  }
  try {
    const projectFile = await projectFileForRole(projectId);
    if (!projectFile) return input;
    const catalog =
      manifest.includeAllBundledSkills === true
        ? await listBundledSkills()
        : new Map<string, string>();
    return stripSelectAllDerivedEntries(manifest, projectFile, catalog);
  } catch (error) {
    log.warn('role manifest select-all stripping unavailable; saving the manifest as it is', {
      roleId: manifest.id,
      projectId,
      error: error instanceof Error ? error.message : String(error),
    });
    return input;
  }
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

/**
 * Ensure the shared built-in default role row exists for a project. Custom projects are not
 * covered by the bundled startup seed, and a project created during this session must offer
 * the default role immediately instead of only after the next restart.
 */
export async function ensureMekaDefaultRoleRow(projectId: string): Promise<void> {
  await getDbClient().exec(MEKA_DEFAULT_ROLE_UPSERT_SQL, mekaDefaultRoleUpsertParams(projectId));
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
    const manifest = normalizeMekaRoleManifest(
      await stripSelectAllDerivedForSave(
        {
          ...roleFile,
          schemaVersion: 1,
          id,
          projectId,
          name: id,
        },
        projectId,
      ),
      id,
      projectId,
    );
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

async function updateMekaRole(input: unknown): Promise<MekaRole> {
  try {
    const body = requireObject(input);
    const projectId = safeId(body.projectId, 'projectId');
    const roleFile = requireObject(body.roleFile, 'roleFile');
    const id = safeId(roleFile.id, 'role id');
    const current = await roleRow(id);
    if (!current) throwIpcError('MEKA_ROLE_NOT_FOUND', `Meka role ${id} not found`);
    if (current.project_id !== projectId)
      throwIpcError('INVALID_PARAMS', 'role projectId mismatch');
    const manifest = normalizeMekaRoleManifest(
      await stripSelectAllDerivedForSave(roleFile, projectId),
      id,
      projectId,
    );
    if (current.is_builtin === 1) {
      if (current.id === mekaDefaultRoleId(current.project_id)) {
        throwIpcError(
          'MEKA_BUILTIN_READ_ONLY',
          'the shared default role cannot be edited; copy it to a project role instead',
        );
      }
      const state = await builtinProjectState(projectId);
      if (!state?.file)
        throwIpcError('MEKA_PROJECT_NOT_FOUND', 'builtin project configuration unavailable');
      const roleIndex = state.file.builtinRoles?.findIndex((role) => role.id === id) ?? -1;
      if (roleIndex < 0) throwIpcError('MEKA_ROLE_NOT_FOUND', `Meka role ${id} not found`);
      const builtinRoles = [...state.file.builtinRoles!];
      builtinRoles[roleIndex] = manifest;
      if (!path.isAbsolute(state.file.basic.path)) {
        throwIpcError('INVALID_PARAMS', 'configure the Meka P4 root before saving builtin roles');
      }
      await saveProjectConfig(
        {
          projectId,
          isBuiltin: true,
          projectRoot: state.file.basic.path,
          appIsPackaged: app.isPackaged,
        },
        { ...state.file, builtinRoles },
      );
      return roleFromManifest(current, manifest);
    }
    const userData = app.getPath('userData');
    const previous = await readCustomRoleManifest(id, userData, projectId);
    await writeCustomRoleManifest(id, manifest, userData);
    try {
      return await upsertRole(
        manifest,
        sortOrder(body.sortOrder ?? current.sort_order),
        current.created_at ?? Date.now(),
      );
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
    if (current.is_builtin === 1)
      throwIpcError('MEKA_BUILTIN_READ_ONLY', 'builtin role is read-only');
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
      if (previous)
        await writeFile(filePath, `${JSON.stringify(previous, null, 2)}\n`, { mode: 0o600 });
      throw error;
    }
  } catch (error) {
    rethrow(error, 'delete');
  }
}

async function listMekaRoles(projectIdInput: unknown): Promise<MekaRole[]> {
  const projectId = safeId(projectIdInput, 'projectId');
  const rows = await getDbClient().query<RoleRow>(
    'SELECT * FROM meka_roles WHERE project_id = ? ORDER BY sort_order, display_name',
    [projectId],
  );
  const state = rows.some((row) => row.is_builtin === 1)
    ? await builtinProjectState(projectId)
    : null;
  const builtinRoles = new Map((state?.file?.builtinRoles ?? []).map((role) => [role.id, role]));
  return rows.map((row) =>
    row.is_builtin === 1 && builtinRoles.has(row.id)
      ? roleFromManifest(row, builtinRoles.get(row.id)!)
      : toRole(row),
  );
}

/**
 * Read a role's *effective* manifest: the explicitly stored selections plus everything the role
 * absorbs from its project at resolve time, plus the display-only `derivedEntryKeys` that tell the
 * panel which of those entries it may not remove. Returning the stored manifest alone made every
 * role that opts into project defaults render as an empty panel.
 */
async function readRoleManifest(roleIdInput: unknown): Promise<ExpandedMekaRoleManifest | null> {
  const roleId = safeId(roleIdInput, 'role id');
  const row = await roleRow(roleId);
  if (!row) return null;
  if (row.is_builtin === 1) {
    if (row.id === mekaDefaultRoleId(row.project_id))
      return expandRoleManifest(mekaDefaultRoleManifest(row.project_id));
    const state = await builtinProjectState(row.project_id);
    return expandRoleManifest(
      state?.file?.builtinRoles?.find((role) => role.id === roleId) ??
        (await readBuiltinRoleManifest(roleId, row.project_id)),
    );
  }
  const custom = await readCustomRoleManifest(roleId, app.getPath('userData'), row.project_id);
  return custom ? expandRoleManifest(custom) : null;
}

export function registerMekaRolesIpc(): void {
  ipcMain.handle(MEKA_ROLE_LIST, (_event, projectId: unknown) => listMekaRoles(projectId));
  ipcMain.handle(MEKA_ROLE_CREATE, (event, input: unknown) => {
    assertTrustedAppRendererEvent(event);
    return createMekaRole(input);
  });
  ipcMain.handle(MEKA_ROLE_UPDATE, (event, input: unknown) => {
    assertTrustedAppRendererEvent(event);
    return updateMekaRole(input);
  });
  ipcMain.handle(MEKA_ROLE_DELETE, (event, id: unknown) => {
    assertTrustedAppRendererEvent(event);
    return deleteMekaRole(id);
  });
  ipcMain.handle(MEKA_ROLE_READ_MANIFEST, (_event, id: unknown) => readRoleManifest(id));
}
