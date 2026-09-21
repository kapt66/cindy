// dirDist(目录分发)归档 —— 确定性 tar.gz 的单一来源。
//
// 为什么必须逐字节确定（不是"好看"而是链路正确性）：发布链路的 runtime 对象是
// **版本化且不可覆盖**的（`runtime-release.mjs` / `release-lib.mjs` 的
// putImmutable* 家族）。同一版本重跑发布时只有两条路可走：复用已存在的对象，或按
// sha256 判定与本地字节相同；一旦重新打包的字节随 runner 的文件系统时间戳、umask 或
// 打包工具实现漂移，重跑就会撞上"同一路径内容不同，拒绝覆盖"，把一次可以重试的发布
// 变成需要人工介入的事故（0.0.21 的 codexPackage 事故已经演示过发布链路重跑的现实性）。
//
// 因此这里把三样东西全部钉死：
//   - 内容顺序：条目按 posix 相对路径的**字节序**排序（不用 localeCompare —— 排序依赖
//     系统 locale 会让同一份内容在不同机器上出不同字节）；
//   - 元数据：mtime / uid / gid / uname / gname 由 `tar` 的 portable + noMtime 抹平，
//     gzip 头同样用 portable（OS 字节固定 0xff、MTIME 0）；
//   - 权限位：打包前把整棵树归一（目录 0755、文件按可执行位取 0755 / 0644），不依赖
//     上游归档被哪种解压器还原（Windows bsdtar 与 GNU tar 对 exec 位/umask 的处理不同）。
//
// 消费者：`apps/desktop/scripts/ci/runtime-release.mjs` 的 pi 目录分发段（上游 win32 是
// zip、unix 是带 `pi/` 壳目录的 tar.gz，两侧都必须重打成同一种形态）。
import fs from 'node:fs';
import path from 'node:path';

import { create as createTar } from 'tar';

const DIRECTORY_MODE = 0o755;
const EXECUTABLE_FILE_MODE = 0o755;
const REGULAR_FILE_MODE = 0o644;

function toPosixRelative(baseDir, absolutePath) {
  return path.relative(baseDir, absolutePath).split(path.sep).join('/');
}

/**
 * 递归收集待打包条目（目录 + 普通文件），返回按 posix 相对路径字节序排序的列表。
 * 排序保证父目录一定排在子项之前，符号链接不入归档（与目录分发"整目录解包"契约一致：
 * 解包侧按普通文件/目录还原，不还原链接）。
 */
export function listDirDistEntries(sourceDir) {
  const entries = [];
  const walk = (dir) => {
    const children = fs.readdirSync(dir, { withFileTypes: true });
    for (const child of children) {
      const absolute = path.join(dir, child.name);
      if (child.isDirectory()) {
        entries.push(toPosixRelative(sourceDir, absolute));
        walk(absolute);
        continue;
      }
      if (!child.isFile()) continue;
      entries.push(toPosixRelative(sourceDir, absolute));
    }
  };
  walk(sourceDir);
  return entries.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * 归一整棵树的权限位：目录 0755；文件按当前可执行位取 0755 / 0644。
 *
 * Windows 没有 exec 位（chmod 只切只读位，stat 一律回报 0o666），因此 win32 归档里所有
 * 文件都是 0644 —— 那里本来也不靠权限位启动。
 */
export function normalizeDirDistModes(sourceDir) {
  const directories = [];
  const walk = (dir) => {
    for (const child of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, child.name);
      if (child.isDirectory()) {
        directories.push(absolute);
        walk(absolute);
        continue;
      }
      if (!child.isFile()) continue;
      let executable = false;
      try {
        executable = (fs.statSync(absolute).mode & 0o111) !== 0;
      } catch {
        // stat 失败交给后续 readStream 报错，不在这里静默放行权限位。
      }
      fs.chmodSync(absolute, executable ? EXECUTABLE_FILE_MODE : REGULAR_FILE_MODE);
    }
  };
  walk(sourceDir);
  // 目录放在子项之后 chmod：先改文件再改目录，避免目录先变成只读影响遍历。
  for (const dir of directories.reverse()) {
    fs.chmodSync(dir, DIRECTORY_MODE);
  }
}

/**
 * 把 `sourceDir` 的内容（不含外层目录本身）打成确定性 tar.gz 写到 `outPath`。
 *
 * @param {string} sourceDir 已归一布局的目录分发目录
 * @param {string} outPath 目标归档路径（调用方负责清理）
 */
export async function createDeterministicTarGz(sourceDir, outPath) {
  normalizeDirDistModes(sourceDir);
  const entries = listDirDistEntries(sourceDir);
  if (entries.length === 0) {
    throw new Error(`directory distribution is empty: ${sourceDir}`);
  }
  await createTar(
    {
      file: outPath,
      cwd: sourceDir,
      gzip: true,
      // portable: 抹掉 uid/gid/uname/gname/dev/ino/nlink，并让 gzip 头不进 mtime/OS；
      // noMtime: 文件条目的 mtime 也写 0（portable 只对目录自动生效）。
      portable: true,
      noMtime: true,
      // 条目已显式枚举（含目录），禁止 tar 再递归，否则每个文件会被写两遍。
      noDirRecurse: true,
      follow: false,
    },
    entries,
  );
  return outPath;
}
