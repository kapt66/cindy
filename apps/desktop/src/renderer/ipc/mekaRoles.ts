import type { MekaRole, MekaRoleManifestFile } from '../../shared/meka-projects.js';

export interface CreateMekaRoleInput {
  projectId: string;
  roleFile: Omit<MekaRoleManifestFile, 'id' | 'name' | 'projectId'>;
  sortOrder?: number;
}

export const listMekaRoles = (projectId: string): Promise<MekaRole[]> =>
  window.electronAPI.localDb.mekaRoles.list(projectId);

export const readMekaRoleManifest = (id: string): Promise<MekaRoleManifestFile | null> =>
  window.electronAPI.localDb.mekaRoles.readManifest(id);

export const createMekaRole = (input: CreateMekaRoleInput): Promise<MekaRole> =>
  window.electronAPI.localDb.mekaRoles.create(input);

export const updateMekaRole = (
  projectId: string,
  roleFile: MekaRoleManifestFile,
  sortOrder?: number,
): Promise<MekaRole> =>
  window.electronAPI.localDb.mekaRoles.update({ projectId, roleFile, sortOrder });

export const deleteMekaRole = (id: string): Promise<void> =>
  window.electronAPI.localDb.mekaRoles.delete(id);
