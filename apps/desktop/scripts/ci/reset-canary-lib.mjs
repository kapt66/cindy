import { artifactBaseName, isExplicitVersion, PLATFORM_ARCHS } from './package-lib.mjs';
import { compareReleaseVersions } from './release-lib.mjs';

function validateTarget(platform, arch) {
  if (!Object.hasOwn(PLATFORM_ARCHS, platform)) {
    throw new Error(`不支持的平台: ${platform}`);
  }
  if (!PLATFORM_ARCHS[platform].includes(arch)) {
    throw new Error(`${platform} 不支持架构: ${arch}`);
  }
}

export function resetCanaryArtifactKeys(platform, arch, version) {
  validateTarget(platform, arch);
  if (!isExplicitVersion(version) || version === '0.0.0') {
    throw new Error(`非法清理版本: ${version}`);
  }

  const platformKey = `${platform}-${arch}`;
  const baseName = artifactBaseName({ version, versionless: false });
  if (platform === 'win32') {
    return [`app/${platformKey}/${baseName}-Setup.exe`, `hotfix/${platformKey}/${baseName}.zip`];
  }
  if (platform === 'darwin') {
    return [
      `app/${platformKey}/${baseName}-${arch}.dmg`,
      `hotfix/${platformKey}/${baseName}-${arch}.zip`,
    ];
  }
  throw new Error(`canary reset 不支持清理 ${platform} 产物`);
}

export function resetCanaryArtifactCandidates(platform, arch, stableVersion, storedKeys) {
  validateTarget(platform, arch);
  if (!isExplicitVersion(stableVersion) || stableVersion === '0.0.0') {
    throw new Error(`非法 stable 版本: ${stableVersion}`);
  }

  const candidates = [];
  for (const key of new Set(storedKeys)) {
    const match = key.match(/cindy-meka-(\d+\.\d+\.\d+)/);
    if (!match || compareReleaseVersions(match[1], stableVersion) <= 0) continue;
    if (resetCanaryArtifactKeys(platform, arch, match[1]).includes(key)) {
      candidates.push(key);
    }
  }
  return candidates.sort();
}

export function assertArtifactsUnreferenced(keys, manifests) {
  const references = new Set();
  for (const manifest of manifests) {
    if (!manifest) continue;
    const installer = manifest.app?.installer?.file;
    const hotfix = manifest.app?.hotfix?.file;
    if (installer) references.add(installer);
    if (hotfix) references.add(hotfix);
  }

  const referenced = keys.filter((key) => references.has(key));
  if (referenced.length > 0) {
    throw new Error(`目标产物仍被 reset 后的 manifest 引用，拒绝删除: ${referenced.join(', ')}`);
  }
}
