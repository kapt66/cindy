import { ipcMain } from 'electron';
import type {
  MekaSkillAccessUpdateRequest,
  MekaSkillDeleteRequest,
  MekaSkillInstallRequest,
  MekaSkillPublishRequest,
} from '../../shared/mekaSkillMarket.js';
import { isIpcError } from '../../shared/ipc-errors.js';
import { createLogger } from '../logger.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { requireString, throwIpcError } from '../utils/ipcValidate.js';
import { MekaSkillMarketService } from './service.js';
import { MekaSkillSourceManager } from './sourceManager.js';

const log = createLogger('meka-skills-ipc');
let registered = false;
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const MAX_PUBLISH_DESCRIPTION_LENGTH = 2_000;
const MAX_SHARED_USERS = 100;
const MAX_USERNAME_LENGTH = 128;

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : requireString(value, label);
}

function installRequest(value: unknown): MekaSkillInstallRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throwIpcError('INVALID_PARAMS', 'Invalid Meka Skill install request');
  }
  const raw = value as Record<string, unknown>;
  return {
    skillId: requireString(raw.skillId, 'skillId'),
    expectedReleaseId: requireString(raw.expectedReleaseId, 'expectedReleaseId'),
    ...(optionalString(raw.installPath, 'installPath')
      ? { installPath: optionalString(raw.installPath, 'installPath') }
      : {}),
    ...(raw.force === true ? { force: true } : {}),
    ...(raw.skipBackup === true ? { skipBackup: true } : {}),
  };
}

function visibility(value: unknown): 'private' | 'shared' | 'public' {
  const normalized = requireString(value, 'visibility');
  if (normalized !== 'private' && normalized !== 'shared' && normalized !== 'public') {
    throwIpcError('INVALID_PARAMS', 'Invalid Meka Skill visibility');
  }
  return normalized;
}

function sharedUsernames(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_SHARED_USERS) {
    throwIpcError('INVALID_PARAMS', 'Invalid Meka Skill shared users');
  }
  return value.map((username) => {
    const normalized = requireString(username, 'shared username').trim();
    if (normalized.length > MAX_USERNAME_LENGTH) {
      throwIpcError('INVALID_PARAMS', 'Meka Skill shared username is too long');
    }
    return normalized;
  });
}

function publishRequest(value: unknown): MekaSkillPublishRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throwIpcError('INVALID_PARAMS', 'Invalid Meka Skill publish request');
  }
  const raw = value as Record<string, unknown>;
  const normalizedVisibility = visibility(raw.visibility);
  const version = requireString(raw.version, 'version').trim();
  if (!SEMVER_RE.test(version)) {
    throwIpcError('INVALID_PARAMS', 'Meka Skill version must be valid SemVer');
  }
  const extraDescription =
    raw.extraDescription === undefined
      ? undefined
      : requireString(raw.extraDescription, 'extraDescription').trim();
  if ((extraDescription?.length ?? 0) > MAX_PUBLISH_DESCRIPTION_LENGTH) {
    throwIpcError('INVALID_PARAMS', 'Meka Skill publish description is too long');
  }
  return {
    sourceId: requireString(raw.sourceId, 'sourceId'),
    version,
    ...(extraDescription ? { extraDescription } : {}),
    visibility: normalizedVisibility,
    sharedUsernames: sharedUsernames(raw.sharedUsernames),
    expectedCurrentReleaseId:
      raw.expectedCurrentReleaseId === null
        ? null
        : requireString(raw.expectedCurrentReleaseId, 'expectedCurrentReleaseId'),
  };
}

function accessUpdateRequest(value: unknown): MekaSkillAccessUpdateRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throwIpcError('INVALID_PARAMS', 'Invalid Meka Skill access request');
  }
  const raw = value as Record<string, unknown>;
  return {
    skillId: requireString(raw.skillId, 'skillId'),
    expectedCurrentReleaseId: requireString(
      raw.expectedCurrentReleaseId,
      'expectedCurrentReleaseId',
    ),
    visibility: visibility(raw.visibility),
    sharedUsernames: sharedUsernames(raw.sharedUsernames),
  };
}

function deleteRequest(value: unknown): MekaSkillDeleteRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throwIpcError('INVALID_PARAMS', 'Invalid Meka Skill delete request');
  }
  const raw = value as Record<string, unknown>;
  return {
    skillId: requireString(raw.skillId, 'skillId'),
    expectedCurrentReleaseId: requireString(
      raw.expectedCurrentReleaseId,
      'expectedCurrentReleaseId',
    ),
  };
}

async function invoke<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isIpcError(error)) throw error;
    log.warn('Meka Skill IPC failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    throwIpcError('INTERNAL', 'Meka Skill operation failed');
  }
}

/** Exposes a narrow renderer bridge; all network, files, and provenance stay in Main. */
export function registerMekaSkillIpc(): void {
  if (registered) return;
  registered = true;
  const service = new MekaSkillMarketService();
  const sourceManager = new MekaSkillSourceManager();

  ipcMain.handle('meka-skills:snapshot', (event, query: unknown) => {
    assertTrustedAppRendererEvent(event);
    return invoke(() => service.snapshot(optionalString(query, 'query')));
  });
  ipcMain.handle('meka-skills:detail', (event, skillId: unknown) => {
    assertTrustedAppRendererEvent(event);
    return invoke(() => service.detail(requireString(skillId, 'skillId')));
  });
  ipcMain.handle('meka-skills:files', (event, skillId: unknown) => {
    assertTrustedAppRendererEvent(event);
    return invoke(() => service.files(requireString(skillId, 'skillId')));
  });
  ipcMain.handle('meka-skills:file', (event, skillId: unknown, filePath: unknown) => {
    assertTrustedAppRendererEvent(event);
    return invoke(() =>
      service.file(requireString(skillId, 'skillId'), requireString(filePath, 'filePath')),
    );
  });
  ipcMain.handle('meka-skills:install', (event, request: unknown) => {
    assertTrustedAppRendererEvent(event);
    return invoke(() => service.install(installRequest(request)));
  });
  ipcMain.handle('meka-skills:management-info', (event, skillId: unknown) => {
    assertTrustedAppRendererEvent(event);
    return invoke(() => service.managementInfo(requireString(skillId, 'skillId')));
  });
  ipcMain.handle('meka-skills:update-access', (event, request: unknown) => {
    assertTrustedAppRendererEvent(event);
    return invoke(() => service.updateAccess(accessUpdateRequest(request)));
  });
  ipcMain.handle('meka-skills:delete-published', (event, request: unknown) => {
    assertTrustedAppRendererEvent(event);
    return invoke(() => service.deletePublished(deleteRequest(request)));
  });
  ipcMain.handle('meka-skills:pick-source', (event) => {
    assertTrustedAppRendererEvent(event);
    return invoke(() => sourceManager.pick(event.sender));
  });
  ipcMain.handle('meka-skills:publish-source', (event, request: unknown) => {
    assertTrustedAppRendererEvent(event);
    return invoke(() => sourceManager.publish(publishRequest(request)));
  });
}
