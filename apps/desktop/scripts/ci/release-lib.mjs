import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const VERSION_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const SUPPORTED_PLATFORM_KEYS = new Set(['win32-x64', 'darwin-x64', 'darwin-arm64']);

function parseVersion(value) {
  const match = VERSION_RE.exec(value);
  if (!match) throw new Error(`非法发布版本: ${value}`);
  const prerelease = match[4]?.split('.') ?? [];
  if (prerelease.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) {
    throw new Error(`非法发布版本: ${value}`);
  }
  return {
    core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])],
    prerelease,
  };
}

function compareIdentifier(a, b) {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) {
    const left = BigInt(a);
    const right = BigInt(b);
    return left === right ? 0 : left < right ? -1 : 1;
  }
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

/** Strict SemVer precedence; build metadata intentionally does not affect ordering. */
export function compareReleaseVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < left.core.length; i += 1) {
    if (left.core[i] !== right.core[i]) return left.core[i] < right.core[i] ? -1 : 1;
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < length; i += 1) {
    if (left.prerelease[i] === undefined) return -1;
    if (right.prerelease[i] === undefined) return 1;
    const compared = compareIdentifier(left.prerelease[i], right.prerelease[i]);
    if (compared !== 0) return compared;
  }
  return 0;
}

export function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

export function sha256Text(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是 object`);
  }
  return value;
}

/**
 * Validates the package-stage handoff and re-hashes every artifact before any
 * remote write. Publishing never trusts stale build-info metadata by itself.
 */
export function validateBuildInfo(buildInfoPath) {
  const absolutePath = path.resolve(buildInfoPath);
  const raw = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
  requireObject(raw, 'build-info');
  if (raw.schemaVersion !== 2)
    throw new Error(`不支持 build-info schemaVersion=${raw.schemaVersion}`);
  if (raw.product !== 'cindy-meka-desktop')
    throw new Error(`错误的 build-info product=${raw.product}`);
  if (raw.versionless !== false || typeof raw.version !== 'string') {
    throw new Error('版本无关产物不能发布；请先用 --version x.y.z 打包');
  }
  parseVersion(raw.version);
  if (!['cn', 'global', 'dev'].includes(raw.region)) {
    throw new Error(`非法 build-info region=${raw.region}`);
  }
  if (!SUPPORTED_PLATFORM_KEYS.has(raw.platformKey)) {
    throw new Error(`Cindy Meka 发布暂不支持 platformKey=${raw.platformKey}`);
  }
  if (`${raw.platform}-${raw.arch}` !== raw.platformKey) {
    throw new Error('build-info platform/arch/platformKey 不一致');
  }

  if (raw.platform === 'win32') {
    if (raw.signing?.installerSigned !== true || raw.signing?.internalExesSigned !== true) {
      throw new Error('Windows 正式发布要求 installer、uninstaller 与包内 exe 全部完成签名');
    }
  } else if (!['self-signed', 'developer-id+notarized'].includes(raw.signing?.mode)) {
    throw new Error(`macOS 正式发布拒绝签名模式: ${raw.signing?.mode ?? '<missing>'}`);
  }

  if (!Array.isArray(raw.files)) throw new Error('build-info.files 必须是 array');
  const entriesByRole = new Map();
  const artifactDir = path.dirname(absolutePath);
  for (const entry of raw.files) {
    requireObject(entry, 'build-info.files[]');
    if (!['installer', 'hotfix'].includes(entry.role)) continue;
    if (entriesByRole.has(entry.role)) throw new Error(`build-info 重复 role=${entry.role}`);
    if (typeof entry.name !== 'string' || path.basename(entry.name) !== entry.name) {
      throw new Error(`非法产物文件名: ${entry.name}`);
    }
    if (!SHA256_RE.test(entry.sha256) || !Number.isSafeInteger(entry.size) || entry.size <= 0) {
      throw new Error(`产物元数据非法: ${entry.name}`);
    }
    const filePath = path.join(artifactDir, entry.name);
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size !== entry.size) {
      throw new Error(`产物大小与 build-info 不一致: ${entry.name}`);
    }
    const actualSha256 = sha256File(filePath);
    if (actualSha256 !== entry.sha256) {
      throw new Error(`产物 SHA256 与 build-info 不一致: ${entry.name}`);
    }
    entriesByRole.set(entry.role, { ...entry, filePath });
  }
  for (const role of ['installer', 'hotfix']) {
    if (!entriesByRole.has(role)) throw new Error(`build-info 缺少 ${role} 产物`);
  }
  const artifactBase = `cindy-meka-${raw.version}`;
  const expectedNames =
    raw.platform === 'win32'
      ? {
          installer: `${artifactBase}-Setup.exe`,
          hotfix: `${artifactBase}.zip`,
        }
      : {
          installer: `${artifactBase}-${raw.arch}.dmg`,
          hotfix: `${artifactBase}-${raw.arch}.zip`,
        };
  for (const [role, expectedName] of Object.entries(expectedNames)) {
    const actualName = entriesByRole.get(role).name;
    if (actualName !== expectedName) {
      throw new Error(`${role} 产物名必须是版本化的 ${expectedName}，当前为 ${actualName}`);
    }
  }

  return Object.freeze({
    buildInfoPath: absolutePath,
    raw,
    version: raw.version,
    region: raw.region,
    platformKey: raw.platformKey,
    installer: entriesByRole.get('installer'),
    hotfix: entriesByRole.get('hotfix'),
  });
}

export function manifestKey(platformKey, channel) {
  if (!SUPPORTED_PLATFORM_KEYS.has(platformKey)) throw new Error(`非法 platformKey=${platformKey}`);
  if (!['canary', 'stable'].includes(channel)) throw new Error(`非法 channel=${channel}`);
  return `manifest-${platformKey}${channel === 'canary' ? '-canary' : ''}.json`;
}

export function buildCanaryManifest(baseManifest, release, options = {}) {
  const manifest = baseManifest
    ? structuredClone(requireObject(baseManifest, 'base manifest'))
    : { app: {} };
  manifest.app = {
    ...(manifest.app ?? {}),
    version: release.version,
    hotfix: {
      file: `hotfix/${release.platformKey}/${release.hotfix.name}`,
      sha256: release.hotfix.sha256,
      size: release.hotfix.size,
    },
    installer: {
      file: `app/${release.platformKey}/${release.installer.name}`,
      sha256: release.installer.sha256,
      size: release.installer.size,
    },
  };
  if (options.releaseNotes) manifest.app.releaseNotes = options.releaseNotes;
  else delete manifest.app.releaseNotes;
  if (options.requireRelogin === true) manifest.app.requireRelogin = true;
  else delete manifest.app.requireRelogin;
  if (options.runtimeAssets) {
    manifest.claudeCode = structuredClone(options.runtimeAssets.claudeCode);
    manifest.codex = structuredClone(options.runtimeAssets.codex);
    manifest.ripgrep = structuredClone(options.runtimeAssets.ripgrep);
  }
  return manifest;
}

/**
 * Build the public endpoint manifest for a Cindy Meka release.
 *
 * The packaged app already has the endpoint-manifest root baked in. Keeping
 * cdnBaseUrl empty makes the update service reuse that same root instead of
 * inheriting the upstream Cindy update channel from config/endpoint.json.
 */
export function buildPublishedEndpointManifest(sourceText) {
  let source;
  try {
    source = JSON.parse(sourceText);
  } catch {
    throw new Error('config/endpoint.json 不是合法 JSON');
  }
  if (
    !source ||
    typeof source !== 'object' ||
    Array.isArray(source) ||
    !Number.isInteger(source.schemaVersion) ||
    source.schemaVersion < 1
  ) {
    throw new Error('config/endpoint.json 缺少合法 schemaVersion');
  }
  return `${JSON.stringify({ ...source, cdnBaseUrl: '' }, null, 2)}\n`;
}

export function validateManifestForPlatform(manifest, platformKey) {
  requireObject(manifest, 'manifest');
  requireObject(manifest.app, 'manifest.app');
  parseVersion(manifest.app.version);
  const hotfix = requireObject(manifest.app.hotfix, 'manifest.app.hotfix');
  const installer = requireObject(manifest.app.installer, 'manifest.app.installer');
  for (const [role, asset, expectedPrefix] of [
    ['hotfix', hotfix, `hotfix/${platformKey}/`],
    ['installer', installer, `app/${platformKey}/`],
  ]) {
    if (
      typeof asset.file !== 'string' ||
      !asset.file.startsWith(expectedPrefix) ||
      asset.file.includes('..') ||
      !SHA256_RE.test(asset.sha256) ||
      !Number.isSafeInteger(asset.size) ||
      asset.size <= 0
    ) {
      throw new Error(`manifest ${role} 非法或不属于 ${platformKey}`);
    }
  }
  return manifest;
}

export async function readStoredManifest(storage, platformKey, channel) {
  const key = manifestKey(platformKey, channel);
  const head = await storage.head(key);
  if (!head) return null;
  const text = await storage.getText(key);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`远端 ${key} 不是合法 JSON`);
  }
  return { key, text, json: validateManifestForPlatform(json, platformKey) };
}

async function inspectRemoteObject(storage, relativeKey) {
  const head = await storage.head(relativeKey);
  if (!head) return null;
  const metadataSha = head.metadata.sha256?.toLowerCase();
  if (metadataSha && head.size > 0) {
    return { sha256: metadataSha, size: head.size };
  }

  const tempPath = path.join(
    os.tmpdir(),
    `cindy-meka-release-verify-${process.pid}-${Date.now()}-${path.basename(relativeKey)}`,
  );
  try {
    await storage.download(relativeKey, tempPath);
    return {
      sha256: sha256File(tempPath),
      size: fs.statSync(tempPath).size,
    };
  } finally {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      /* best effort */
    }
  }
}

/**
 * Versioned release objects are immutable. An idempotent re-run may reuse the
 * exact bytes; the same path with different bytes is always rejected.
 */
export async function putImmutableArtifact(storage, relativeKey, entry) {
  const remote = await inspectRemoteObject(storage, relativeKey);
  if (remote) {
    if (remote.sha256 === entry.sha256 && remote.size === entry.size) {
      return { uploaded: false, reused: true };
    }
    throw new Error(
      `版本化对象已存在但内容不同，拒绝覆盖: ${relativeKey} ` +
        `(remote ${remote.sha256}/${remote.size}, local ${entry.sha256}/${entry.size})`,
    );
  }
  await storage.putFile(relativeKey, entry.filePath, {
    metadata: { sha256: entry.sha256 },
  });
  const verified = await storage.head(relativeKey);
  if (
    !verified ||
    verified.size !== entry.size ||
    verified.metadata.sha256?.toLowerCase() !== entry.sha256
  ) {
    throw new Error(`RustFS 上传后校验失败: ${relativeKey}`);
  }
  return { uploaded: true, reused: false };
}

export function assertPublishVersionOrder(version, canaryManifest, stableManifest) {
  if (stableManifest && compareReleaseVersions(version, stableManifest.app.version) <= 0) {
    throw new Error(`canary 版本 ${version} 必须高于 stable ${stableManifest.app.version}`);
  }
  if (canaryManifest && compareReleaseVersions(version, canaryManifest.app.version) < 0) {
    throw new Error(`拒绝用较低版本 ${version} 覆盖 canary ${canaryManifest.app.version}`);
  }
}

export function assertPromotionOrder(canaryManifest, stableManifest) {
  validateManifestForPlatform(canaryManifest, inferPlatformKey(canaryManifest));
  if (
    stableManifest &&
    compareReleaseVersions(canaryManifest.app.version, stableManifest.app.version) < 0
  ) {
    throw new Error(
      `拒绝把 canary ${canaryManifest.app.version} 降级提升到 stable ${stableManifest.app.version}`,
    );
  }
}

function inferPlatformKey(manifest) {
  const match = /^hotfix\/([^/]+)\//.exec(manifest?.app?.hotfix?.file ?? '');
  if (!match) throw new Error('manifest 无法推导 platformKey');
  return match[1];
}

export function stableBackupKey(platformKey, version) {
  parseVersion(version);
  if (!SUPPORTED_PLATFORM_KEYS.has(platformKey)) throw new Error(`非法 platformKey=${platformKey}`);
  return `back-up/${version}/manifest-${platformKey}.json`;
}

export function canaryBackupKey(platformKey, version, manifestText) {
  parseVersion(version);
  if (!SUPPORTED_PLATFORM_KEYS.has(platformKey)) throw new Error(`非法 platformKey=${platformKey}`);
  return `back-up/canary/${version}/${sha256Text(manifestText)}/manifest-${platformKey}.json`;
}

export async function putImmutableText(storage, relativeKey, text) {
  const localSha = sha256Text(text);
  const head = await storage.head(relativeKey);
  if (head) {
    const remoteText = await storage.getText(relativeKey);
    if (sha256Text(remoteText) === localSha) return { uploaded: false, reused: true };
    throw new Error(`备份对象已存在但内容不同，拒绝覆盖: ${relativeKey}`);
  }
  await storage.putText(relativeKey, text, {
    metadata: { sha256: localSha },
    cacheControl: 'public, max-age=31536000, immutable',
  });
  return { uploaded: true, reused: false };
}

export async function verifyCdnText(storage, relativeKey, expectedText, options = {}) {
  const attempts = options.attempts ?? 5;
  const retryMs = options.retryMs ?? 1_500;
  const expectedSha = sha256Text(expectedText);
  const url = storage.cdnUrl(relativeKey);
  let lastError = '';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(`${url}?t=${Date.now()}`, {
        headers: { 'cache-control': 'no-cache' },
      });
      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
      } else {
        const text = await response.text();
        if (sha256Text(text) === expectedSha) return;
        lastError = '内容哈希仍是旧值';
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }
  throw new Error(`CDN 对象校验失败: ${url} (${lastError})`);
}

export async function verifyCdnManifest(storage, platformKey, channel, expectedText, options = {}) {
  return verifyCdnText(storage, manifestKey(platformKey, channel), expectedText, options);
}
