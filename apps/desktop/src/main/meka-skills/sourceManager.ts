import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import JSZip from 'jszip';
import { BrowserWindow, dialog } from 'electron';
import type { WebContents } from 'electron';

import type {
  MekaSkillPublishInfo,
  MekaSkillPublishRequest,
  MekaSkillPublishResult,
  MekaSkillSourcePreview,
} from '../../shared/mekaSkillMarket.js';
import { getActiveAppSession, isAppSessionBoundaryPending } from '../appSessionState.js';
import { getMekaRouterService } from '../meka-settings/ipc.js';
import { computeFolderHash } from '../skillhub/folderHash.js';
import { pack } from '../skillhub/zipPacker.js';
import { throwIpcError } from '../utils/ipcValidate.js';

const MAX_MEKA_SKILL_BYTES = 10 * 1024 * 1024;
const MAX_MEKA_SKILL_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
const MAX_MEKA_SKILL_FILE_COUNT = 1000;
const SOURCE_GRANT_TTL_MS = 15 * 60 * 1000;
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

interface SourceGrant {
  ownerId: string;
  generation: number;
  expiresAt: number;
  packageBytes: Buffer;
  preview: MekaSkillSourcePreview;
}

function currentOwner(): { ownerId: string; generation: number } {
  const session = getActiveAppSession();
  if (
    isAppSessionBoundaryPending() ||
    !session.dataOwnerId ||
    (session.mode !== 'cloud' && session.mode !== 'local')
  ) {
    throwIpcError('PRECONDITION_FAILED', 'Meka Skill requires a stable app session');
  }
  return { ownerId: session.dataOwnerId, generation: session.generation };
}

function requiredText(data: Record<string, unknown>, field: 'name' | 'description'): string {
  const value = data[field];
  if (typeof value !== 'string' || !value.trim()) {
    throwIpcError('INVALID_PARAMS', `SKILL.md ${field} is required`);
  }
  return value.trim();
}

export async function inspectMekaSkillSource(absolutePath: string): Promise<{
  folderHash: string;
  packageBytes: Buffer;
  preview: Omit<MekaSkillSourcePreview, 'sourceId' | 'directoryPath'>;
}> {
  const rootStat = await fs.promises.lstat(absolutePath);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throwIpcError('INVALID_PARAMS', 'Meka Skill source must be a real directory');
  }
  const skillPath = path.join(absolutePath, 'SKILL.md');
  const skillStat = await fs.promises.lstat(skillPath).catch(() => null);
  if (!skillStat?.isFile() || skillStat.isSymbolicLink()) {
    throwIpcError('INVALID_PARAMS', 'Meka Skill source requires a root SKILL.md');
  }
  const beforeHash = await computeFolderHash(absolutePath);
  const packaged = await pack(absolutePath, { timeoutMs: 45_000 });
  const afterHash = await computeFolderHash(absolutePath);
  if (beforeHash !== afterHash) {
    throwIpcError(
      'PRECONDITION_FAILED',
      'Meka Skill source changed while it was being packaged; select it again',
    );
  }
  if (packaged.size > MAX_MEKA_SKILL_BYTES) {
    throwIpcError('INVALID_PARAMS', 'Meka Skill package exceeds 10 MiB');
  }
  const uncompressedBytes = packaged.manifest.files.reduce((total, file) => total + file.size, 0);
  if (
    packaged.manifest.files.length > MAX_MEKA_SKILL_FILE_COUNT ||
    uncompressedBytes > MAX_MEKA_SKILL_UNCOMPRESSED_BYTES
  ) {
    throwIpcError('INVALID_PARAMS', 'Meka Skill package exceeds extraction safety limits');
  }
  const packagedZip = await JSZip.loadAsync(packaged.buffer);
  const packagedSkill = packagedZip.file('SKILL.md');
  if (!packagedSkill) {
    throwIpcError('INVALID_PARAMS', 'Meka Skill source requires a root SKILL.md');
  }
  const parsed = matter(await packagedSkill.async('string'));
  const data = parsed.data as Record<string, unknown>;
  const name = requiredText(data, 'name');
  const description = requiredText(data, 'description');
  if (!SKILL_NAME_RE.test(name)) {
    throwIpcError('INVALID_PARAMS', 'Meka Skill name must use lowercase kebab-case');
  }
  if (path.basename(absolutePath) !== name) {
    throwIpcError('INVALID_PARAMS', 'Meka Skill folder name must match SKILL.md name');
  }
  return {
    folderHash: afterHash,
    packageBytes: packaged.buffer,
    preview: {
      name,
      description,
      fileCount: packaged.manifest.files.length,
      packageSizeBytes: packaged.size,
    },
  };
}

/** Adds release-only metadata to package bytes without modifying the selected source folder. */
export async function applyMekaSkillReleaseVersion(
  packageBytes: Buffer,
  version: string,
): Promise<Buffer> {
  const zip = await JSZip.loadAsync(packageBytes);
  const skillEntry = zip.file('SKILL.md');
  if (!skillEntry) {
    throwIpcError('INVALID_PARAMS', 'Meka Skill source requires a root SKILL.md');
  }
  const parsed = matter(await skillEntry.async('string'));
  zip.file(
    'SKILL.md',
    matter.stringify(parsed.content, {
      ...parsed.data,
      version,
    }),
  );
  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}

/**
 * Grants explicit, owner-bound access to one user-selected source directory.
 * Renderer receives metadata and an opaque source id, never package bytes.
 */
export class MekaSkillSourceManager {
  private readonly grants = new Map<string, SourceGrant>();

  private pruneExpired(now = Date.now()): void {
    for (const [sourceId, grant] of this.grants) {
      if (grant.expiresAt <= now) this.grants.delete(sourceId);
    }
  }

  async pick(sender: WebContents): Promise<MekaSkillPublishInfo | null> {
    this.pruneExpired();
    const owner = currentOwner();
    const parent = BrowserWindow.fromWebContents(sender);
    const result = parent
      ? await dialog.showOpenDialog(parent, {
          properties: ['openDirectory'],
        })
      : await dialog.showOpenDialog({
          properties: ['openDirectory'],
        });
    const selected = result.canceled ? undefined : result.filePaths[0];
    if (!selected) return null;
    const inspected = await inspectMekaSkillSource(path.resolve(selected));
    const sourceId = randomUUID();
    const preview = {
      sourceId,
      directoryPath: path.resolve(selected),
      ...inspected.preview,
    };
    const publishInfo = await getMekaRouterService().getMekaSkillPublishInfo(preview);
    const confirmedOwner = currentOwner();
    if (
      confirmedOwner.ownerId !== owner.ownerId ||
      confirmedOwner.generation !== owner.generation
    ) {
      throwIpcError('PRECONDITION_FAILED', 'Meka Skill app session changed during review');
    }
    this.grants.set(sourceId, {
      ownerId: owner.ownerId,
      generation: owner.generation,
      expiresAt: Date.now() + SOURCE_GRANT_TTL_MS,
      packageBytes: inspected.packageBytes,
      preview,
    });
    return publishInfo;
  }

  private requireGrant(sourceId: string): SourceGrant {
    this.pruneExpired();
    const grant = this.grants.get(sourceId);
    const owner = currentOwner();
    if (
      !grant ||
      grant.ownerId !== owner.ownerId ||
      grant.generation !== owner.generation ||
      grant.expiresAt <= Date.now()
    ) {
      throwIpcError('PRECONDITION_FAILED', 'Meka Skill source grant expired');
    }
    return grant;
  }

  async publish(request: MekaSkillPublishRequest): Promise<MekaSkillPublishResult> {
    const grant = this.requireGrant(request.sourceId);
    const publishBytes = await applyMekaSkillReleaseVersion(grant.packageBytes, request.version);
    if (publishBytes.byteLength > MAX_MEKA_SKILL_BYTES) {
      throwIpcError('INVALID_PARAMS', 'Meka Skill package exceeds 10 MiB');
    }
    this.requireGrant(request.sourceId);
    const result = await getMekaRouterService().uploadMekaSkill(
      publishBytes,
      grant.preview,
      request.version,
      request.extraDescription ?? '',
      request.visibility,
      request.sharedUsernames,
      request.expectedCurrentReleaseId,
    );
    this.grants.delete(request.sourceId);
    return result;
  }
}
