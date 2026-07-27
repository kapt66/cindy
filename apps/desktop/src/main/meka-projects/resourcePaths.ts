import path from 'node:path';

import { app } from 'electron';

export interface MekaResourceEnvironment {
  appIsPackaged: boolean;
  appPath: string;
  resourcesPath: string;
}

/**
 * Resolve the single bundled Meka resource root.
 *
 * Packaged builds always read process.resourcesPath/meka. Development reads
 * <appPath>/resources/meka, which is the same tree before Electron Forge copies it.
 */
export function resolveMekaResourcesRoot(environment: MekaResourceEnvironment): string {
  const resourcesRoot = environment.appIsPackaged
    ? environment.resourcesPath
    : path.join(environment.appPath, 'resources');
  return path.join(resourcesRoot, 'meka');
}

export function bundledMekaResourcesRoot(): string {
  const appPath =
    typeof app?.getAppPath === 'function' ? app.getAppPath() : path.resolve(__dirname, '../../..');
  return resolveMekaResourcesRoot({
    appIsPackaged: app?.isPackaged === true,
    appPath,
    resourcesPath: process.resourcesPath,
  });
}

export function bundledMekaProjectsRoot(): string {
  return path.join(bundledMekaResourcesRoot(), 'projects');
}

export function bundledMekaRolesRoot(): string {
  return path.join(bundledMekaResourcesRoot(), 'roles');
}

export function bundledMekaSkillsRoot(): string {
  return path.join(bundledMekaResourcesRoot(), 'skills');
}
