/**
 * 打包产物 native 运行时解包断言。
 *
 * 为什么需要这条断言：`packagerConfig.asar.unpack` 里的规则（sharp 的 libvips、
 * node-pty 的 conpty/winpty/spawn-helper、loudness 的调音量 exe、sherpa-onnx 与
 * sqlite-vec 的动态库）必须真的被释放到 `app.asar.unpacked/` 才能被 `dlopen` /
 * `spawn`。这些文件一旦被留在 `app.asar` 内部，Electron 主进程在执行到第一个
 * `require('sharp')` 时就会抛 `ERR_DLOPEN_FAILED`，随后弹出一个标题为 `Error` 的
 * 模态框——无人点击时进程既不退出也不输出，release 的 packaged smoke 就从这里变成
 * “60 秒超时且没有任何输出”。
 *
 * 2026-11-02 的真实事故：`packagerConfig.tmpdir` 被改成 `<repo>/.forge-tmp`，
 * asar 用**绝对路径**匹配 unpack glob，而 minimatch 的 `**` 默认不跨过以 `.` 开头
 * 的路径段（`dot: false`）。于是所有以 `**` 开头的 unpack 通配规则整体失效，包看起来“打成功
 * 了”，实际是坏的。这条断言把这种静默损坏变成 make 之后的显式失败。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 把任意平台路径规范成 asar/glob 口径的 posix 相对路径。 */
function toPosix(relativePath) {
  return relativePath.split(path.sep).join('/');
}

/** 递归列出目录下所有文件的 posix 相对路径（无目录项）。 */
export function listUnpackedFiles(root) {
  const files = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const nextPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute, nextPrefix);
      else if (entry.isFile()) files.push(nextPrefix);
    }
  };
  walk(root, '');
  return files;
}

/**
 * 目标平台/架构必须出现在 `app.asar.unpacked/` 里的运行时二进制。
 *
 * 每个条目是「至少命中一个文件」的规则：版本号/ABI 后缀会随依赖升级漂移，所以
 * 只锁目录与关键文件名，不锁完整文件名。Windows 的 libvips 与 sharp 同目录；
 * macOS/Linux 的 libvips 在独立的 `@img/sharp-libvips-*` 包里。
 */
export function requiredUnpackedMatchers(platform, arch) {
  const platformName = platform === 'win32' ? 'win' : platform;
  const matchers = [];

  if (platform === 'win32') {
    matchers.push({
      id: 'sharp-libvips',
      description: `node_modules/@img/sharp-win32-${arch}/lib/libvips*.dll`,
      test: (file) => new RegExp(`^node_modules/@img/sharp-win32-${arch}/lib/libvips[^/]*\\.dll$`).test(file),
    });
  } else {
    // macOS 只认 `darwin-<arch>`；glibc 发行版是 `linux-<arch>`，musl 发行版是
    // `linuxmusl-<arch>`，两者都算合法布局。
    const libvipsPackage =
      platform === 'darwin' ? `sharp-libvips-darwin-${arch}` : `sharp-libvips-linux(musl)?-${arch}`;
    const libvipsHint = platform === 'darwin' ? `sharp-libvips-darwin-${arch}` : `sharp-libvips-linux[musl]-${arch}`;
    matchers.push({
      id: 'sharp-libvips',
      description: `node_modules/@img/${libvipsHint}/lib/libvips-cpp*`,
      test: (file) => new RegExp(`^node_modules/@img/${libvipsPackage}/lib/libvips-cpp[^/]*$`).test(file),
    });
  }

  matchers.push({
    id: 'node-pty-runtime',
    description:
      platform === 'win32'
        ? 'node_modules/node-pty/**/{conpty.dll,winpty-agent.exe}'
        : `node_modules/node-pty/**/spawn-helper`,
    test: (file) => {
      if (!file.startsWith('node_modules/node-pty/')) return false;
      if (platform === 'win32') return /(^|\/)(conpty\.dll|winpty-agent\.exe)$/.test(file);
      return file.endsWith('/spawn-helper');
    },
  });

  if (platform === 'win32') {
    matchers.push({
      id: 'loudness-win-helper',
      description: 'node_modules/loudness/impl/windows/adjust_get_current_system_volume_vista_plus.exe',
      test: (file) => file === 'node_modules/loudness/impl/windows/adjust_get_current_system_volume_vista_plus.exe',
    });
  }

  matchers.push({
    id: 'sherpa-onnx-runtime',
    description: `node_modules/sherpa-onnx-${platformName}-${arch}/**/*.{dll,dylib,so}`,
    test: (file) => {
      if (!file.startsWith(`node_modules/sherpa-onnx-${platformName}-${arch}/`)) return false;
      if (platform === 'win32') return file.endsWith('.dll');
      if (platform === 'darwin') return file.endsWith('.dylib');
      return /\.so(\.[^/]+)?$/.test(file);
    },
  });

  const sqliteVecExtension = platform === 'win32' ? 'dll' : platform === 'darwin' ? 'dylib' : 'so';
  matchers.push({
    id: 'sqlite-vec',
    description: `native/sqlite-vec/${platform}-${arch}/vec0.${sqliteVecExtension}`,
    test: (file) => file === `native/sqlite-vec/${platform}-${arch}/vec0.${sqliteVecExtension}`,
  });

  return matchers;
}

/** 返回未命中的规则（空数组表示解包完整）。 */
export function findMissingUnpackedMatchers(unpackedRoot, platform, arch) {
  const files = listUnpackedFiles(unpackedRoot);
  return requiredUnpackedMatchers(platform, arch).filter((matcher) => !files.some((file) => matcher.test(file)));
}

/**
 * 断言 packaged app 的 `app.asar.unpacked/` 里存在全部目标平台运行时二进制。
 * 缺失即抛错，并把缺失项与期望路径一起打出来，避免再去 smoke 里找原因。
 */
export function assertNativeRuntimeUnpacked({ unpackedRoot, platform, arch }) {
  if (!fs.existsSync(unpackedRoot)) {
    throw new Error(
      `packaged app is missing app.asar.unpacked/ (expected at ${unpackedRoot}); ` +
        'native runtime binaries would be trapped inside app.asar and dlopen/spawn would fail at startup',
    );
  }
  const missing = findMissingUnpackedMatchers(unpackedRoot, platform, arch);
  if (missing.length === 0) {
    console.log(
      `    verified unpacked native runtime binaries for ${platform}-${arch} in ${path.relative(process.cwd(), unpackedRoot) || unpackedRoot}`,
    );
    return;
  }
  const details = missing.map((matcher) => `  - ${matcher.id}: expected ${matcher.description}`).join('\n');
  throw new Error(
    `packaged app is missing ${missing.length} unpacked native runtime entr${missing.length === 1 ? 'y' : 'ies'} ` +
      `for ${platform}-${arch}:\n${details}\n` +
      'These files are still inside app.asar, so the packaged app fails at startup ' +
      '(ERR_DLOPEN_FAILED / spawn ENOENT). Check that packagerConfig.asar.unpack still matches and that ' +
      'packagerConfig.tmpdir does not point at a directory whose name starts with "." ' +
      "(minimatch's ** does not cross dot segments, which silently disables every unpack rule).",
  );
}
