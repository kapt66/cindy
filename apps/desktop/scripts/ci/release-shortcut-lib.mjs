import path from 'node:path';

import {
  isExplicitVersion,
  PLATFORM_ARCHS,
} from './package-lib.mjs';

const VERSION_BUMP_KINDS = new Set(['major', 'minor', 'patch']);
const SHORTCUT_PLATFORMS = new Set(['win32', 'darwin']);

function takeValue(argv, flag, index) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} 需要一个值`);
  }
  return value;
}

function validateTarget(platform, arch) {
  if (!SHORTCUT_PLATFORMS.has(platform)) {
    throw new Error('快捷发布只支持 win32 或 darwin');
  }
  const supported = PLATFORM_ARCHS[platform];
  if (arch && !supported.includes(arch)) {
    throw new Error(`${platform} 不支持架构 ${arch}`);
  }
  if (platform === 'win32' && arch !== 'x64') {
    throw new Error('Windows 快捷发布必须固定为 x64');
  }
}

export function targetArchs(platform, arch = null) {
  validateTarget(platform, arch);
  return arch ? [arch] : [...PLATFORM_ARCHS[platform]];
}

export function parseReleaseShortcutArgs(argv) {
  const result = {
    platform: '',
    arch: null,
    versionSpec: '',
    releaseNotesFile: '',
    requireRelogin: false,
  };
  let platformSeen = false;
  let archSeen = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--platform') {
      if (platformSeen) throw new Error('--platform 只能传一次');
      platformSeen = true;
      result.platform = takeValue(argv, arg, index);
      index += 1;
    } else if (arg === '--arch') {
      if (archSeen) throw new Error('--arch 只能传一次');
      archSeen = true;
      result.arch = takeValue(argv, arg, index);
      index += 1;
    } else if (arg === '--release-notes-file') {
      result.releaseNotesFile = takeValue(argv, arg, index);
      index += 1;
    } else if (arg === '--require-relogin') {
      result.requireRelogin = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`未知参数: ${arg}`);
    } else if (result.versionSpec) {
      throw new Error(`只能提供一个版本参数，重复收到: ${arg}`);
    } else {
      result.versionSpec = arg;
    }
  }

  if (!result.platform) throw new Error('缺少固定发布平台');
  validateTarget(result.platform, result.arch);
  if (!result.versionSpec) {
    throw new Error('必须提供版本号或 major/minor/patch，例如 pnpm release:win patch');
  }
  if (
    !isExplicitVersion(result.versionSpec) &&
    !VERSION_BUMP_KINDS.has(result.versionSpec)
  ) {
    throw new Error(`非法版本参数: ${result.versionSpec}`);
  }
  return Object.freeze(result);
}

export function packageArgsForShortcut(options) {
  const args = [
    '--platform',
    options.platform,
    '--region',
    'cn',
    '--version',
    options.versionSpec,
  ];
  if (options.arch) args.push('--arch', options.arch);
  return args;
}

export function publishArgsForShortcut(buildInfoPath, options, { execute = false } = {}) {
  const args = ['--build-info', path.resolve(buildInfoPath)];
  if (options.releaseNotesFile) {
    args.push('--release-notes-file', path.resolve(options.releaseNotesFile));
  }
  if (options.requireRelogin) args.push('--require-relogin');
  if (execute) args.push('--execute');
  return args;
}

export function parsePromoteShortcutArgs(argv) {
  const result = { platform: '', arch: null, yes: false };
  let platformSeen = false;
  let archSeen = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--platform') {
      if (platformSeen) throw new Error('--platform 只能传一次');
      platformSeen = true;
      result.platform = takeValue(argv, arg, index);
      index += 1;
    } else if (arg === '--arch') {
      if (archSeen) throw new Error('--arch 只能传一次');
      archSeen = true;
      result.arch = takeValue(argv, arg, index);
      index += 1;
    } else if (arg === '--yes') {
      result.yes = true;
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }

  if (!result.platform) throw new Error('缺少固定推进平台');
  validateTarget(result.platform, result.arch);
  return Object.freeze(result);
}

export function promoteArgsForShortcut(platform, arch, { yes = false } = {}) {
  const args = ['--region', 'cn', '--platform', platform, '--arch', arch];
  if (yes) args.push('--yes');
  return args;
}
