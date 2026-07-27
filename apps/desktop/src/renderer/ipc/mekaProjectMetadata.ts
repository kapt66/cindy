import type {
  MekaProjectFile,
  MekaProjectMetadata,
} from '../../shared/meka-projects.js';

export const discoverMekaProjectMetadata = (
  projectId: string,
): Promise<MekaProjectMetadata[]> =>
  window.electronAPI.localDb.mekaProjectMetadata.discover(projectId);

export const listMekaProjectMetadata = (
  projectId: string,
): Promise<MekaProjectMetadata[]> =>
  window.electronAPI.localDb.mekaProjectMetadata.list(projectId);

export const loadMekaProjectFile = (projectId: string): Promise<MekaProjectFile> =>
  window.electronAPI.localDb.mekaProjectMetadata.loadProject(projectId);

export const saveMekaProjectFile = (
  projectId: string,
  project: MekaProjectFile,
): Promise<MekaProjectFile> =>
  window.electronAPI.localDb.mekaProjectMetadata.saveProject({ projectId, project });

export const getMekaProjectGitRemote = (projectId: string): Promise<string | null> =>
  window.electronAPI.localDb.mekaProjectMetadata.gitRemote(projectId);
