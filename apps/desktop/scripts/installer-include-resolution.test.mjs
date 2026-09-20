import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// NSIS resolves a relative `!include` against the makensis working directory,
// the `!addincludedir` list and `NSISDIR\Include` — never against the directory
// of the file doing the including. app-builder-lib only adds the
// buildResourcesDir (NsisTarget.js `addIncludeDir(packager.info.buildResourcesDir)`),
// and this repo has never had an `apps/desktop/build/` directory, so a bare
// `!include "sibling.nsh"` for a script shipped in `resources/` compiles only
// where a caller happens to pass `!addincludedir resources/`.
//
// That mismatch is what broke the 0.0.22 Windows release: production failed at
// `installer.nsh:9` while `check-windows-installer.mjs` passed, because the check
// overrode `directories.buildResources`. Same-directory includes must therefore be
// `${__FILEDIR__}`-qualified so production and every check resolve identically.
// This rule is path-based, so it runs on any platform, unlike the real NSIS build.
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
