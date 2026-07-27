import path from 'node:path';
import fs from 'node:fs';

import { app, ipcMain, safeStorage } from 'electron';

import { createMekaP4SettingsService, type MekaP4SettingsService } from './service.js';
import { createMekaRouterService, type MekaRouterService } from './routerService.js';
import { requireObject, requireString, throwIpcError } from '../utils/ipcValidate.js';

export const MEKA_SETTINGS_CHANNELS = {
  GET_P4: 'meka-settings:get-p4',
  SET_P4_ROOT: 'meka-settings:set-p4-root',
  ROUTER_GET: 'meka-settings:router:get',
  ROUTER_CONNECT: 'meka-settings:router:connect',
  ROUTER_DISCONNECT: 'meka-settings:router:disconnect',
  ROUTER_LIST_TOOLS: 'meka-settings:router:list-tools',
  ROUTER_SET_ROUTE: 'meka-settings:router:set-route',
  DESIGN_CONNECT: 'meka-settings:design:connect',
  DESIGN_DISCONNECT: 'meka-settings:design:disconnect',
  ROUTER_LIST_INSTANCES: 'meka-settings:router:list-instances',
  ROUTER_LIST_TEMPLATES: 'meka-settings:router:list-templates',
  ROUTER_CREATE_INSTANCE: 'meka-settings:router:create-instance',
  PROJECT_GET_BINDINGS: 'meka-settings:project:get-bindings',
  PROJECT_SET_BINDINGS: 'meka-settings:project:set-bindings',
} as const;

let routerSingleton: MekaRouterService | null = null;
let p4Singleton: MekaP4SettingsService | null = null;

function createEncryptedVault(userDataPath: string) {
  const secretPath = (key: string, extension: 'enc' | 'plain') =>
    path.join(userDataPath, `${key}.${extension}`);
  return {
    read(key: string): string | null {
      if (!safeStorage.isEncryptionAvailable()) return null;
      try {
        const encrypted = fs.readFileSync(secretPath(key, 'enc'));
        return safeStorage.decryptString(encrypted);
      } catch {
        // Meka 0.0.x fell back to `<key>.plain` when safeStorage was
        // temporarily unavailable. When OS encryption is available again,
        // consume that legacy value exactly once, encrypt it in place, and
        // remove the plaintext. New code never creates plaintext secrets.
        try {
          const plainPath = secretPath(key, 'plain');
          const value = fs.readFileSync(plainPath, 'utf8');
          if (!value) return null;
          fs.writeFileSync(secretPath(key, 'enc'), safeStorage.encryptString(value));
          fs.unlinkSync(plainPath);
          return value;
        } catch {
          return null;
        }
      }
    },
    store(key: string, value: string): void {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('OS credential encryption is unavailable; MCPRouter credentials were not saved');
      }
      fs.mkdirSync(userDataPath, { recursive: true });
      fs.writeFileSync(secretPath(key, 'enc'), safeStorage.encryptString(value));
      try { fs.unlinkSync(secretPath(key, 'plain')); } catch { /* absent or locked */ }
    },
    remove(key: string): void {
      for (const extension of ['enc', 'plain'] as const) {
        try { fs.unlinkSync(secretPath(key, extension)); } catch { /* absent or locked */ }
      }
    },
  };
}

export function getMekaRouterService(): MekaRouterService {
  if (routerSingleton) return routerSingleton;
  const userDataPath = app.getPath('userData');
  routerSingleton = createMekaRouterService({
    configPath: path.join(userDataPath, 'meka-assistant-settings.json'),
    vault: createEncryptedVault(userDataPath),
  });
  return routerSingleton;
}

export function getMekaP4SettingsService(): MekaP4SettingsService {
  if (p4Singleton) return p4Singleton;
  p4Singleton = createMekaP4SettingsService({
    // Preserve the original Meka filename inside the original Meka userData identity.
    configPath: path.join(app.getPath('userData'), 'meka-assistant-settings.json'),
  });
  return p4Singleton;
}

export function registerMekaSettingsIpc(
  service: MekaP4SettingsService = getMekaP4SettingsService(),
): void {
  ipcMain.handle(MEKA_SETTINGS_CHANNELS.GET_P4, () => service.get());
  ipcMain.handle(MEKA_SETTINGS_CHANNELS.SET_P4_ROOT, (_event, directoryPath: unknown) =>
    service.setP4RootPath(requireString(directoryPath, 'directoryPath')),
  );

  const router = getMekaRouterService();
  ipcMain.handle(MEKA_SETTINGS_CHANNELS.ROUTER_GET, () => router.getSettings());
  ipcMain.handle(MEKA_SETTINGS_CHANNELS.ROUTER_CONNECT, (_event, input: unknown) => {
    const body = requireObject(input);
    return router.connect(
      requireString(body.routerUrl, 'routerUrl'),
      requireString(body.username, 'username'),
      requireString(body.password, 'password'),
    );
  });
  ipcMain.handle(MEKA_SETTINGS_CHANNELS.ROUTER_DISCONNECT, () => router.disconnect());
  ipcMain.handle(MEKA_SETTINGS_CHANNELS.ROUTER_LIST_TOOLS, () => router.listToolsAndRoutes());
  ipcMain.handle(MEKA_SETTINGS_CHANNELS.ROUTER_SET_ROUTE, (_event, input: unknown) => {
    const body = requireObject(input);
    if (typeof body.enabled !== 'boolean') throwIpcError('INVALID_PARAMS', 'enabled required');
    return router.setRoute(requireString(body.routeId, 'routeId'), body.enabled);
  });
  ipcMain.handle(MEKA_SETTINGS_CHANNELS.DESIGN_CONNECT, (_event, endpoint: unknown) =>
    router.connectMekaDesign(requireString(endpoint, 'endpoint')),
  );
  ipcMain.handle(MEKA_SETTINGS_CHANNELS.DESIGN_DISCONNECT, () => router.disconnectMekaDesign());
  ipcMain.handle(MEKA_SETTINGS_CHANNELS.ROUTER_LIST_INSTANCES, () => router.listInstances());
  ipcMain.handle(MEKA_SETTINGS_CHANNELS.ROUTER_LIST_TEMPLATES, () => router.listTemplates());
  ipcMain.handle(MEKA_SETTINGS_CHANNELS.ROUTER_CREATE_INSTANCE, (_event, input: unknown) => {
    const body = requireObject(input);
    return router.createInstance(
      requireString(body.templateId, 'templateId'),
      requireString(body.name, 'name'),
    );
  });
  ipcMain.handle(MEKA_SETTINGS_CHANNELS.PROJECT_GET_BINDINGS, (_event, projectId: unknown) =>
    router.listProjectBindings(requireString(projectId, 'projectId')),
  );
  ipcMain.handle(MEKA_SETTINGS_CHANNELS.PROJECT_SET_BINDINGS, (_event, input: unknown) => {
    const body = requireObject(input);
    if (!Array.isArray(body.instanceIds) || !body.instanceIds.every((id) => typeof id === 'string')) {
      throwIpcError('INVALID_PARAMS', 'instanceIds must be a string array');
    }
    return router.setProjectBindings(
      requireString(body.projectId, 'projectId'),
      body.instanceIds,
    );
  });
}
