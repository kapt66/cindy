import os from 'node:os';
import path from 'node:path';

import { app } from 'electron';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: vi.fn(() => path.resolve(__dirname, '../../../..')),
    getPath: vi.fn(() => path.join(os.tmpdir(), 'cindy-meka-runtime-test-user-data')),
  },
}));

import type { MekaRoleFile } from '../../../shared/meka-projects.js';
import { mergeMekaProjectRoleDefaults } from '../runtimeConfig.js';

function role(overrides: Partial<MekaRoleFile> = {}): MekaRoleFile {
  return {
    schemaVersion: 1,
    id: 'developer',
    name: 'developer',
    displayName: 'Developer',
    prompt: 'role prompt',
    rules: [],
    skills: [{ skillId: 'role-skill', enabled: true }],
    promptFragments: [],
    mcp: [{ id: 'role-router', providerId: 'mcp-router', enabled: true }],
    projectMetadataSelection: [],
    useProjectDefaults: true,
    ...overrides,
  };
}

describe('Meka project and role runtime configuration', () => {
  it('merges project defaults underneath role-owned overrides and exclusions', () => {
    const merged = mergeMekaProjectRoleDefaults(
      role({
        excludeDefaults: {
          rules: ['excluded-rule'],
          skills: ['excluded-skill'],
          mcp: ['excluded-mcp'],
          metadata: [{ sourcePath: 'excluded.md', itemType: 'rule' }],
        },
        skills: [
          { skillId: 'shared-skill', enabled: false },
          { skillId: 'role-skill', enabled: true },
        ],
        projectMetadataSelection: [{ sourcePath: 'role.md', itemType: 'agents-md', enabled: true }],
      }),
      {
        promptFramework: 'project framework',
        rules: [
          { id: 'excluded-rule', text: 'excluded', enabled: true },
          { id: 'project-rule', text: 'project rule', enabled: true },
        ],
        skills: ['shared-skill', 'excluded-skill'],
        mcp: [
          { id: 'excluded-mcp', providerId: 'project-agent' },
          { id: 'project-router', providerId: 'project-agent' },
        ],
        projectMetadataSelection: [
          { sourcePath: 'excluded.md', itemType: 'rule' },
          { sourcePath: 'project.md', itemType: 'agents-md' },
        ],
      },
    );

    expect(merged.prompt).toBe('project framework\n\nrole prompt');
    expect(merged.rules).toEqual([{ id: 'project-rule', text: 'project rule', enabled: true }]);
    expect(merged.skills).toEqual([
      { skillId: 'shared-skill', enabled: false },
      { skillId: 'role-skill', enabled: true },
    ]);
    expect(merged.mcp.map((entry) => entry.id)).toEqual(['project-router', 'role-router']);
    expect(merged.projectMetadataSelection).toEqual([
      { sourcePath: 'project.md', itemType: 'agents-md', enabled: true },
      { sourcePath: 'role.md', itemType: 'agents-md', enabled: true },
    ]);
  });
});
