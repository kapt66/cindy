import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { app } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: vi.fn(() => path.resolve(__dirname, '../../../..')),
    getPath: vi.fn(() => path.join(os.tmpdir(), 'cindy-meka-runtime-test-user-data')),
  },
}));

import type { MekaRoleFile } from '../../../shared/meka-projects.js';
import {
  materializeMekaRuntimeSkills,
  mergeMekaProjectRoleDefaults,
  resolveRoleProjectMetadataSelections,
} from '../runtimeConfig.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

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

  it('expands all enabled project metadata while preserving explicit role overrides', () => {
    expect(
      resolveRoleProjectMetadataSelections(
        role({
          includeAllProjectMetadata: true,
          projectMetadataSelection: [
            { sourcePath: 'all-skill/SKILL.md', itemType: 'skill', enabled: false },
            { sourcePath: 'role-only.md', itemType: 'rule', enabled: true },
          ],
        }),
        [
          { sourcePath: 'AGENTS.md', itemType: 'agents-md', enabled: true },
          { sourcePath: 'all-skill/SKILL.md', itemType: 'skill', enabled: true },
          { sourcePath: 'disabled.md', itemType: 'rule', enabled: false },
        ],
      ),
    ).toEqual([
      { sourcePath: 'AGENTS.md', itemType: 'agents-md', enabled: true },
      { sourcePath: 'all-skill/SKILL.md', itemType: 'skill', enabled: false },
      { sourcePath: 'role-only.md', itemType: 'rule', enabled: true },
    ]);
  });

  it('projects configured skills to both native agent skill roots and removes stale projections', async () => {
    const managedRoot = path.join(app.getPath('userData'), 'meka-assistants');
    await mkdir(managedRoot, { recursive: true });
    const workingDir = await mkdtemp(path.join(managedRoot, 'session-'));
    temporaryDirectories.push(workingDir);

    await materializeMekaRuntimeSkills(workingDir, [
      {
        id: 'first-skill',
        name: 'First',
        description: 'first',
        content: '# First\n',
      },
    ]);
    await materializeMekaRuntimeSkills(workingDir, [
      {
        id: 'second-skill',
        name: 'Second',
        description: 'second',
        content: '# Second\n',
      },
    ]);

    for (const root of ['.claude', '.agents']) {
      await expect(
        readFile(path.join(workingDir, root, 'skills', 'meka-second-skill', 'SKILL.md'), 'utf8'),
      ).resolves.toBe('# Second\n');
      await expect(
        readFile(path.join(workingDir, root, 'skills', 'meka-first-skill', 'SKILL.md'), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('does not write generated skill files into a configured project workspace', async () => {
    const workingDir = await mkdtemp(path.join(os.tmpdir(), 'cindy-meka-project-'));
    temporaryDirectories.push(workingDir);

    await expect(
      materializeMekaRuntimeSkills(workingDir, [
        {
          id: 'project-skill',
          name: 'Project',
          description: 'project',
          content: '# Project\n',
        },
      ]),
    ).rejects.toThrow('app-managed workspace');
  });
});
