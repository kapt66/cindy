// 回归锁定 2026-11-02 的 canary 事故：
//   `packagerConfig.tmpdir` 指向 `.forge-tmp`（点开头目录）后，asar 的 unpack
//   glob（以 `**` 开头的通配）整体失配——minimatch 的 `**` 默认不跨过点目录段——
//   导致 sharp/libvips、node-pty、loudness、sherpa-onnx、sqlite-vec 的运行时
//   二进制全部被留在 app.asar 里，packaged 应用启动即抛 ERR_DLOPEN_FAILED，
//   release smoke 表现为 60s 超时且没有任何输出。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertNativeRuntimeUnpacked,
  findMissingUnpackedMatchers,
  listUnpackedFiles,
  requiredUnpackedMatchers,
} from '../ci/native-unpack-verify.mjs';

const repoRoot = path.resolve(import.meta.dirname, '../../../..');
const tempRoots = [];

function makeUnpackedRoot(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unpack-verify-'));
  tempRoots.push(root);
  for (const file of files) {
    const target = path.join(root, ...file.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'x');
  }
  return root;
}

const win32X64Complete = [
  'node_modules/@img/sharp-win32-x64/lib/libvips-42.dll',
  'node_modules/@img/sharp-win32-x64/lib/libvips-cpp-8.18.3.dll',
  'node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64-0.35.3.node',
  'node_modules/node-pty/build/Release/conpty/conpty.dll',
  'node_modules/node-pty/build/Release/winpty-agent.exe',
  'node_modules/loudness/impl/windows/adjust_get_current_system_volume_vista_plus.exe',
  'node_modules/sherpa-onnx-win-x64/onnxruntime.dll',
  'native/sqlite-vec/win32-x64/vec0.dll',
];

afterEach(() => {
  while (tempRoots.length > 0) fs.rmSync(tempRoots.pop(), { recursive: true, force: true });
});

describe('native runtime unpack assertions', () => {
  it('accepts a Windows package that unpacked every runtime binary', () => {
    const root = makeUnpackedRoot(win32X64Complete);
    expect(findMissingUnpackedMatchers(root, 'win32', 'x64')).toEqual([]);
    expect(() => assertNativeRuntimeUnpacked({ unpackedRoot: root, platform: 'win32', arch: 'x64' })).not.toThrow();
  });

  it('reports sharp libvips when it stayed inside app.asar', () => {
    const root = makeUnpackedRoot(win32X64Complete.filter((file) => !file.includes('libvips')));
    const missing = findMissingUnpackedMatchers(root, 'win32', 'x64').map((matcher) => matcher.id);
    expect(missing).toContain('sharp-libvips');
    expect(missing).not.toContain('node-pty-runtime');
  });

  it('reports every category for a package that unpacked nothing', () => {
    const root = makeUnpackedRoot(['.vite/build/index.js']);
    const missing = findMissingUnpackedMatchers(root, 'win32', 'x64').map((matcher) => matcher.id);
    expect(missing).toEqual(['sharp-libvips', 'node-pty-runtime', 'loudness-win-helper', 'sherpa-onnx-runtime', 'sqlite-vec']);
  });

  it('fails loudly with the expected paths and the dot-directory hint', () => {
    const root = makeUnpackedRoot(['.vite/build/index.js']);
    let message = '';
    try {
      assertNativeRuntimeUnpacked({ unpackedRoot: root, platform: 'win32', arch: 'x64' });
    } catch (error) {
      message = error.message;
    }
    expect(message).toContain('node_modules/@img/sharp-win32-x64/lib/libvips*.dll');
    expect(message).toContain('starts with "."');
  });

  it('throws when app.asar.unpacked/ is absent altogether', () => {
    const root = path.join(os.tmpdir(), `unpack-verify-missing-${process.pid}`);
    expect(() => assertNativeRuntimeUnpacked({ unpackedRoot: root, platform: 'win32', arch: 'x64' })).toThrow(
      /missing app\.asar\.unpacked/,
    );
  });

  it('uses the libvips sibling package layout on macOS', () => {
    const root = makeUnpackedRoot([
      'node_modules/@img/sharp-libvips-darwin-arm64/lib/libvips-cpp.8.18.3.dylib',
      'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
      'node_modules/sherpa-onnx-darwin-arm64/libonnxruntime.dylib',
      'native/sqlite-vec/darwin-arm64/vec0.dylib',
    ]);
    expect(findMissingUnpackedMatchers(root, 'darwin', 'arm64')).toEqual([]);
    expect(requiredUnpackedMatchers('darwin', 'arm64').map((matcher) => matcher.id)).not.toContain('loudness-win-helper');
  });

  it('accepts both glibc and musl libvips layouts on linux', () => {
    for (const packageDir of ['sharp-libvips-linux-x64', 'sharp-libvips-linuxmusl-x64']) {
      const root = makeUnpackedRoot([
        `node_modules/@img/${packageDir}/lib/libvips-cpp.so.8.18.3`,
        'node_modules/node-pty/prebuilds/linux-x64/spawn-helper',
        'node_modules/sherpa-onnx-linux-x64/libonnxruntime.so',
        'native/sqlite-vec/linux-x64/vec0.so',
      ]);
      expect(findMissingUnpackedMatchers(root, 'linux', 'x64')).toEqual([]);
    }
  });

  it('lists unpacked files relative to the unpacked root', () => {
    const root = makeUnpackedRoot(['node_modules/@img/sharp-win32-x64/lib/libvips-42.dll']);
    expect(listUnpackedFiles(root)).toEqual(['node_modules/@img/sharp-win32-x64/lib/libvips-42.dll']);
  });
});

describe('packaging staging dir invariant', () => {
  // 这条用例直接锁事故根因：暂存目录名一旦以 `.` 开头，asar 的 unpack glob
  // 会整体失配，而 make 本身不会报错。
  it('does not stage electron-packager output under a dot-prefixed directory', () => {
    const forgeConfig = fs.readFileSync(path.join(repoRoot, 'apps/desktop/forge.config.ts'), 'utf8');
    const tmpdirLine = forgeConfig.split('\n').find((line) => line.trim().startsWith('tmpdir:'));
    expect(tmpdirLine, 'packagerConfig.tmpdir must be declared explicitly').toBeTruthy();
    const segments = [...tmpdirLine.matchAll(/'([^']*)'/g)].map((match) => match[1]).join('/');
    for (const segment of segments.split('/')) {
      expect(segment.startsWith('.') && segment !== '..', `tmpdir segment must not start with a dot: ${segment}`).toBe(false);
    }
  });

  it('keeps the asar.unpack rule that protects native runtime binaries', () => {
    const forgeConfig = fs.readFileSync(path.join(repoRoot, 'apps/desktop/forge.config.ts'), 'utf8');
    expect(forgeConfig).toContain('sharp-win32-*');
    expect(forgeConfig).toContain('native/sqlite-vec');
    expect(forgeConfig).toContain('sherpa-onnx-{darwin,win,linux}-*');
  });
});
