import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// NSIS resolves a relative `!include` against the makensis working directory,
// the `!addincludedir` list and `NSISDIR\Include` — never against the directory
// of the file doing the including. A bare `!include "sibling.nsh"` for a script
// shipped in `resources/` therefore compiles only where a caller happens to pass
// `!addincludedir resources/`.
//
// That mismatch is what broke the 0.0.22 Windows release: production failed at
// `installer.nsh:9` while `check-windows-installer.mjs` passed, because the check
// overrode `directories.buildResources`.
//
// 当前形态（2026-09-24 起）由两侧方案合并而成，两个条件必须同时成立：
//  1. `forge.config.ts` 显式设 `directories.buildResources = resources`
//     （上游 7582de5f20），两个 native 检查脚本也必须照此设置，否则它们的
//     `${BUILD_RESOURCES_DIR}` 会指向不存在的 `<projectDir>/build`；
//  2. 同级 include 用 `${BUILD_RESOURCES_DIR}`（或 `${__FILEDIR__}`）限定，
//     且必须留在**顶层** —— 宏体内的 `!include` 要到 `!insertmacro` 的插入点才展开，
//     实测会让 native harness 的 `missing` 场景以 0xC0000005 崩溃。
// 本规则只禁「裸相对名」，两种限定写法都放行；它是纯路径规则，任何平台都可跑。
const resourcesDir = fileURLToPath(new URL('../resources', import.meta.url));
// Allow an optional /NONFATAL-style flag so such an include cannot slip past the rule.
const includePattern = /^\s*!include\s+(?:\/\w+\s+)?"?([^"\s]+)"?\s*$/gm;

function includesOf(source) {
  // Report the line of the `!include` token itself: the leading \s* may start on an
  // earlier blank line, which would otherwise shift every diagnostic up by one.
  return [...source.matchAll(includePattern)].map((match) => [
    match[1],
    match.index + match[0].indexOf('!include'),
  ]);
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

const shippedScripts = readdirSync(resourcesDir)
  .filter((name) => name.endsWith('.nsh'))
  .sort();

describe('NSIS installer include resolution', () => {
  it('scans the shipped installer scripts', () => {
    expect(shippedScripts).toEqual(
      expect.arrayContaining([
        'installer.nsh',
        'installer-directory.nsh',
        'installer-directory-messages.nsh',
        'winget-shortcuts.nsh',
      ]),
    );
  });

  it('qualifies same-directory includes with __FILEDIR__ so production resolves them', () => {
    const violations = [];
    for (const name of shippedScripts) {
      const source = readFileSync(path.join(resourcesDir, name), 'utf8');
      for (const [target, index] of includesOf(source)) {
        // Only bare filenames can be resolved through the caller's search path;
        // anything already carrying ${__FILEDIR__} or a directory is out of scope.
        if (!/^[\w.-]+\.nsh$/.test(target)) continue;
        // A name that is not shipped here is supplied by NSIS itself
        // (LogicLib.nsh, FileFunc.nsh, UAC.nsh) or by app-builder-lib templates.
        if (!existsSync(path.join(resourcesDir, target))) continue;
        violations.push(
          `${name}:${lineOf(source, index)}: !include "${target}" -> ` +
            `!include "\${__FILEDIR__}\\${target}"`,
        );
      }
    }
    expect(violations).toEqual([]);
  });

  it('points every __FILEDIR__ include at a script that exists next to it', () => {
    const missing = [];
    for (const name of shippedScripts) {
      const source = readFileSync(path.join(resourcesDir, name), 'utf8');
      for (const [target] of includesOf(source)) {
        const sibling = target.match(/^\$\{__FILEDIR__\}[\\/](.+)$/);
        if (sibling === null) continue;
        if (!existsSync(path.join(resourcesDir, sibling[1]))) missing.push(`${name}: ${target}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
