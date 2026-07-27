import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveMekaResourcesRoot } from '../resourcePaths.js';

describe('Meka bundled resource paths', () => {
  it('uses one meka parent below the source resources directory in development', () => {
    expect(
      resolveMekaResourcesRoot({
        appIsPackaged: false,
        appPath: path.join('C:', 'workspace', 'desktop'),
        resourcesPath: path.join('C:', 'installed', 'resources'),
      }),
    ).toBe(path.join('C:', 'workspace', 'desktop', 'resources', 'meka'));
  });

  it('uses process.resourcesPath/meka in packaged builds', () => {
    expect(
      resolveMekaResourcesRoot({
        appIsPackaged: true,
        appPath: path.join('C:', 'workspace', 'desktop'),
        resourcesPath: path.join('C:', 'installed', 'resources'),
      }),
    ).toBe(path.join('C:', 'installed', 'resources', 'meka'));
  });
});
