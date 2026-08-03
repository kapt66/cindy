import crypto from 'node:crypto';
import { net } from 'electron';
import JSZip, { type JSZipObject } from 'jszip';

import type {
  MekaSkillAccessUpdateRequest,
  MekaSkillDeleteRequest,
  MekaSkillInstallRequest,
  MekaSkillManagementInfo,
  MekaSkillMarketDetail,
  MekaSkillMarketSnapshot,
  MekaSkillPreviewFile,
} from '../../shared/mekaSkillMarket.js';
import { getActiveAppSession, isAppSessionBoundaryPending } from '../appSessionState.js';
import { getMekaRouterService } from '../meka-settings/ipc.js';
import * as installService from '../skillhub/installService.js';
import { registryService } from '../skillhub/registry/index.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { MekaSkillMarketApi, type VisibleMekaSkill } from './api.js';

const MAX_MEKA_SKILL_PACKAGE_BYTES = 10 * 1024 * 1024;
const MAX_MEKA_SKILL_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
const MAX_MEKA_SKILL_FILE_COUNT = 1000;
const MAX_PREVIEW_TEXT_BYTES = 1024 * 1024;

type PreviewFetch = (url: string, init: { method: 'GET' }) => Promise<Response>;

interface PreviewPackageCache {
  accessKey: string;
  releaseId: string;
  zip: JSZip;
}

function isMissingRegistryRoute(error: unknown): boolean {
  return (
    error instanceof Error &&
    'statusCode' in error &&
    (error as Error & { statusCode?: unknown }).statusCode === 404
  );
}

function captureOwner(): { dataOwnerId: string; generation: number } {
  const session = getActiveAppSession();
  if (
    isAppSessionBoundaryPending() ||
    !session.dataOwnerId ||
    (session.mode !== 'cloud' && session.mode !== 'local')
  ) {
    throwIpcError('PRECONDITION_FAILED', 'Meka Skill requires a stable app session');
  }
  return { dataOwnerId: session.dataOwnerId, generation: session.generation };
}

function sameOwner(expected: { dataOwnerId: string; generation: number }): boolean {
  const current = getActiveAppSession();
  return (
    !isAppSessionBoundaryPending() &&
    current.dataOwnerId === expected.dataOwnerId &&
    current.generation === expected.generation
  );
}

/** Main-process orchestration for MCPRouter Meka Skill browse and install. */
export class MekaSkillMarketService {
  private previewCache: PreviewPackageCache | null = null;

  constructor(
    private readonly api = new MekaSkillMarketApi(),
    private readonly fetchPreview: PreviewFetch = (url, init) => net.fetch(url, init),
  ) {}

  private async projectItems(items: VisibleMekaSkill[]): Promise<MekaSkillMarketSnapshot['items']> {
    const installs = await registryService.listAllInstalls();
    const mekaByResource = new Map(
      installs
        .filter((install) => install.entry.distribution?.channel === 'meka')
        .map((install) => [install.entry.distribution!.resourceId, install]),
    );
    return items.map((item) => {
      const install = mekaByResource.get(item.id);
      return {
        ...item,
        installed: Boolean(install),
        updateAvailable:
          Boolean(install) && install?.entry.distribution?.releaseId !== item.currentRelease.id,
        ...(install ? { installedPath: install.installPath } : {}),
      };
    });
  }

  async snapshot(query?: string): Promise<MekaSkillMarketSnapshot> {
    const configured = await this.api.isConfigured();
    if (!configured) return { configured: false, items: [] };
    try {
      return {
        configured: true,
        items: await this.projectItems(await this.api.listAll(query)),
      };
    } catch (error) {
      if (isMissingRegistryRoute(error)) {
        return {
          configured: false,
          unavailableReason: 'registry-not-supported',
          items: [],
        };
      }
      throw error;
    }
  }

  detail(skillId: string): Promise<MekaSkillMarketDetail> {
    return this.api.detail(skillId);
  }

  async files(skillId: string): Promise<MekaSkillPreviewFile[]> {
    const detail = await this.api.detail(skillId);
    validatePackageIndex(detail);
    return detail.currentRelease.files.map((file) => ({
      path: file.path,
      size: file.sizeBytes,
      language: languageForPath(file.path),
      truncated: false,
    }));
  }

  async file(skillId: string, filePath: string): Promise<MekaSkillPreviewFile> {
    const detail = await this.api.detail(skillId);
    validatePackageIndex(detail);
    const indexed = detail.currentRelease.files.find((file) => file.path === filePath);
    if (!indexed) throwIpcError('NOT_FOUND', 'Meka Skill file not found');
    const zip = await this.previewPackage(detail);
    const entry = zip.file(indexed.path);
    if (!entry || entry.dir) throwIpcError('NOT_FOUND', 'Meka Skill package file not found');
    const preview = await readVerifiedPreview(entry, indexed.sizeBytes, indexed.sha256);
    return {
      path: indexed.path,
      size: indexed.sizeBytes,
      language: languageForPath(indexed.path),
      truncated: preview.truncated,
      content: preview.content,
    };
  }

  /** Downloads and verifies one immutable release, then reuses it while its access identity matches. */
  private async previewPackage(detail: MekaSkillMarketDetail): Promise<JSZip> {
    validatePackageIndex(detail);
    const access = await this.api.access();
    const accessKey = previewAccessKey(access.baseUrl, access.clientKey);
    if (
      this.previewCache?.accessKey === accessKey &&
      this.previewCache.releaseId === detail.currentRelease.id
    ) {
      return this.previewCache.zip;
    }

    const grant = await this.api.download(detail.id, detail.currentRelease.id);
    if (
      grant.sizeBytes !== detail.currentRelease.sizeBytes ||
      grant.sha256 !== detail.currentRelease.sha256 ||
      grant.sizeBytes < 1 ||
      grant.sizeBytes > MAX_MEKA_SKILL_PACKAGE_BYTES
    ) {
      throwIpcError('PRECONDITION_FAILED', 'Meka Skill preview package metadata changed');
    }
    const response = await this.fetchPreview(grant.url, { method: 'GET' });
    if (!response.ok) {
      throwIpcError('INTERNAL', `Meka Skill preview download failed (${response.status})`);
    }
    const packageBytes = await readResponseBounded(response, grant.sizeBytes);
    const actualSha256 = crypto.createHash('sha256').update(packageBytes).digest('hex');
    if (actualSha256 !== grant.sha256) {
      throwIpcError('PRECONDITION_FAILED', 'Meka Skill preview package checksum mismatch');
    }
    const zip = await JSZip.loadAsync(packageBytes);
    validatePreviewZip(zip, detail);
    const currentAccess = await this.api.access();
    if (previewAccessKey(currentAccess.baseUrl, currentAccess.clientKey) !== accessKey) {
      throwIpcError('PRECONDITION_FAILED', 'Meka Skill access changed during preview');
    }
    this.previewCache = { accessKey, releaseId: detail.currentRelease.id, zip };
    return zip;
  }

  async install(request: MekaSkillInstallRequest): Promise<installService.InstallResult> {
    const owner = captureOwner();
    const capturedAccess = await this.api.access();
    const detail = await this.api.detail(request.skillId);
    if (detail.currentRelease.id !== request.expectedReleaseId) {
      throwIpcError('PRECONDITION_FAILED', 'Meka Skill release changed before installation');
    }
    validatePackageIndex(detail);
    return installService.install(
      {
        name: detail.slug,
        version: detail.currentRelease.version,
        ...(request.installPath ? { installPath: request.installPath } : {}),
        ...(request.force === true ? { force: true } : {}),
        ...(request.skipBackup === true ? { skipBackup: true } : {}),
      },
      () => undefined,
      {
        channel: 'meka',
        authorId: `meka:${detail.id}`,
        isAvailable: async () => {
          if (!sameOwner(owner)) return false;
          const current = await this.api.access();
          return (
            current.baseUrl === capturedAccess.baseUrl &&
            current.clientKey === capturedAccess.clientKey
          );
        },
        getDownloadInfo: async () => {
          const download = await this.api.download(detail.id, detail.currentRelease.id);
          if (
            download.sizeBytes !== detail.currentRelease.sizeBytes ||
            download.sha256 !== detail.currentRelease.sha256
          ) {
            throwIpcError('PRECONDITION_FAILED', 'Meka Skill download metadata changed');
          }
          return {
            url: download.url,
            expiresAt: download.expiresAt,
            fileHash: download.sha256,
            fileSize: download.sizeBytes,
            zipSha256: download.sha256,
            version: detail.currentRelease.version,
            resourceId: detail.id,
            releaseId: detail.currentRelease.id,
          };
        },
      },
    );
  }

  async managementInfo(skillId: string): Promise<MekaSkillManagementInfo> {
    try {
      return await getMekaRouterService().getMekaSkillManagementInfo(skillId);
    } catch (error) {
      rethrowManagementError(error);
    }
  }

  async updateAccess(request: MekaSkillAccessUpdateRequest): Promise<MekaSkillManagementInfo> {
    try {
      return await getMekaRouterService().updateMekaSkillAccess(
        request.skillId,
        request.expectedCurrentReleaseId,
        request.visibility,
        request.sharedUsernames,
      );
    } catch (error) {
      rethrowManagementError(error);
    }
  }

  async deletePublished(request: MekaSkillDeleteRequest): Promise<{ ok: true }> {
    try {
      await getMekaRouterService().deleteMekaSkill(
        request.skillId,
        request.expectedCurrentReleaseId,
      );
      return { ok: true };
    } catch (error) {
      rethrowManagementError(error);
    }
  }
}

function validatePackageIndex(detail: MekaSkillMarketDetail): void {
  const release = detail.currentRelease;
  if (
    release.sizeBytes < 1 ||
    release.sizeBytes > MAX_MEKA_SKILL_PACKAGE_BYTES ||
    release.uncompressedSizeBytes < 1 ||
    release.uncompressedSizeBytes > MAX_MEKA_SKILL_UNCOMPRESSED_BYTES ||
    release.files.length < 1 ||
    release.files.length > MAX_MEKA_SKILL_FILE_COUNT
  ) {
    throwIpcError('PRECONDITION_FAILED', 'Meka Skill preview package exceeds safety limits');
  }
  const paths = new Set<string>();
  let indexedBytes = 0;
  for (const file of release.files) {
    if (
      file.sizeBytes < 0 ||
      file.sizeBytes > MAX_MEKA_SKILL_UNCOMPRESSED_BYTES ||
      paths.has(file.path)
    ) {
      throwIpcError('PRECONDITION_FAILED', 'Meka Skill preview file index is invalid');
    }
    paths.add(file.path);
    indexedBytes += file.sizeBytes;
    if (indexedBytes > release.uncompressedSizeBytes) {
      throwIpcError('PRECONDITION_FAILED', 'Meka Skill preview file index exceeds package size');
    }
  }
}

function validatePreviewZip(zip: JSZip, detail: MekaSkillMarketDetail): void {
  const packagePaths = Object.values(zip.files)
    .filter((entry) => !entry.dir)
    .map((entry) => entry.name);
  const indexedPaths = new Set(detail.currentRelease.files.map((file) => file.path));
  if (
    packagePaths.length > MAX_MEKA_SKILL_FILE_COUNT ||
    packagePaths.length !== indexedPaths.size ||
    packagePaths.some((filePath) => !indexedPaths.has(filePath))
  ) {
    throwIpcError(
      'PRECONDITION_FAILED',
      'Meka Skill preview package does not match its file index',
    );
  }
}

function rethrowManagementError(error: unknown): never {
  const code =
    error instanceof Error && 'code' in error
      ? (error as Error & { code?: unknown }).code
      : undefined;
  if (code === 'NOT_FOUND') {
    throwIpcError('NOT_FOUND', 'Meka Skill is no longer owned by this account');
  }
  if (code === 'INVALID_PARAMS') {
    throwIpcError('INVALID_PARAMS', 'Invalid Meka Skill management request');
  }
  if (code === 'PRECONDITION_FAILED') {
    throwIpcError('PRECONDITION_FAILED', 'Meka Skill changed; reload its management details');
  }
  throw error;
}

function languageForPath(filePath: string): string {
  const extension = filePath.split('.').pop()?.toLowerCase();
  if (extension === 'md' || extension === 'mdx') return 'markdown';
  if (extension === 'ts' || extension === 'tsx') return 'typescript';
  if (extension === 'js' || extension === 'mjs' || extension === 'cjs') return 'javascript';
  if (extension === 'json') return 'json';
  if (extension === 'py') return 'python';
  if (extension === 'sh') return 'shell';
  return 'text';
}

function previewAccessKey(baseUrl: string, clientKey: string | null): string {
  return crypto
    .createHash('sha256')
    .update(baseUrl)
    .update('\0')
    .update(clientKey ?? '')
    .digest('hex');
}

async function readResponseBounded(response: Response, expectedSize: number): Promise<Buffer> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && Number(contentLength) !== expectedSize) {
    throwIpcError('PRECONDITION_FAILED', 'Meka Skill preview package size mismatch');
  }
  if (!response.body) throwIpcError('INTERNAL', 'Meka Skill preview response has no body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > expectedSize || received > MAX_MEKA_SKILL_PACKAGE_BYTES) {
      await reader.cancel();
      throwIpcError('PRECONDITION_FAILED', 'Meka Skill preview package exceeds its size grant');
    }
    chunks.push(value);
  }
  if (received !== expectedSize) {
    throwIpcError('PRECONDITION_FAILED', 'Meka Skill preview package size mismatch');
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    received,
  );
}

async function readVerifiedPreview(
  entry: JSZipObject,
  expectedSize: number,
  expectedSha256: string,
): Promise<{ content: string; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const previewChunks: Buffer[] = [];
    let previewBytes = 0;
    let totalBytes = 0;
    let settled = false;
    const stream = entry.nodeStream('nodebuffer') as NodeJS.ReadableStream & {
      destroy(error?: Error): void;
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      stream.destroy();
      reject(error);
    };
    stream.on('data', (chunk: Buffer) => {
      totalBytes += chunk.byteLength;
      if (totalBytes > expectedSize) {
        fail(new Error('Meka Skill preview file exceeds its indexed size'));
        return;
      }
      hash.update(chunk);
      if (previewBytes < MAX_PREVIEW_TEXT_BYTES) {
        const kept = chunk.subarray(0, MAX_PREVIEW_TEXT_BYTES - previewBytes);
        previewChunks.push(kept);
        previewBytes += kept.byteLength;
      }
    });
    stream.on('error', (error) => fail(error instanceof Error ? error : new Error(String(error))));
    stream.on('end', () => {
      if (settled) return;
      if (totalBytes !== expectedSize || hash.digest('hex') !== expectedSha256) {
        fail(new Error('Meka Skill preview file checksum mismatch'));
        return;
      }
      settled = true;
      resolve({
        content: Buffer.concat(previewChunks, previewBytes).toString('utf8'),
        truncated: totalBytes > MAX_PREVIEW_TEXT_BYTES,
      });
    });
  });
}
