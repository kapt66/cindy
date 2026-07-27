import type { MekaProject } from '../../shared/meka-projects.js';

export interface CreateMekaProjectInput {
  displayName: string;
  description?: string | null;
  path: string;
  tags?: readonly string[];
}

export interface UpdateMekaProjectPatch {
  displayName?: string;
  description?: string | null;
  path?: string;
  tags?: readonly string[];
}

export const listMekaProjects = (): Promise<MekaProject[]> =>
  window.electronAPI.localDb.mekaProjects.list();

export const getMekaProject = (id: string): Promise<MekaProject | null> =>
  window.electronAPI.localDb.mekaProjects.get(id);

export const createMekaProject = (input: CreateMekaProjectInput): Promise<MekaProject> =>
  window.electronAPI.localDb.mekaProjects.create(input);

export const updateMekaProject = (
  id: string,
  patch: UpdateMekaProjectPatch,
): Promise<MekaProject> => window.electronAPI.localDb.mekaProjects.update({ id, patch });

export const deleteMekaProject = (id: string): Promise<void> =>
  window.electronAPI.localDb.mekaProjects.delete(id);

export const resolveMekaProjectPath = (
  id: string,
): Promise<{ resolvedPath: string | null }> =>
  window.electronAPI.localDb.mekaProjects.resolvePath(id);
