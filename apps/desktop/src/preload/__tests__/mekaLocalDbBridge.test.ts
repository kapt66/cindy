import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../preload.ts', import.meta.url), 'utf8');

describe('Meka localDb preload bridge', () => {
  it('keeps every Meka capability group inside the exposed localDb API', () => {
    const localDbStart = source.indexOf('  localDb: {');
    const localDbEnd = source.indexOf('\n  // ── RSB browser bridge', localDbStart);
    const localDb = source.slice(localDbStart, localDbEnd);

    expect(localDbStart).toBeGreaterThan(-1);
    expect(localDbEnd).toBeGreaterThan(localDbStart);
    for (const group of [
      'mekaProjects',
      'mekaRoles',
      'mekaProjectMetadata',
      'mekaSkillCatalog',
      'mekaFormal',
    ]) {
      expect(localDb).toContain(`    ${group}: {`);
    }
    for (const channel of [
      'meka-project:list',
      'meka-project:reset-builtin',
      'meka-role:list',
      'meka-role:read-manifest',
      'meka-project-metadata:discover',
      'meka-project:load',
      'meka-project:save',
      'meka-skill-catalog:list',
      'meka-formal:provider-list',
      'meka-formal:prepare',
    ]) {
      expect(localDb).toContain(`'${channel}'`);
    }
  });
});
