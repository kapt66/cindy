import { promises as fs } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import type { MekaRoleMcpEntry } from '../../../shared/meka-projects.js';
import type { MekaRuntimeConfig } from '../../meka-projects/runtimeConfig.js';
import { applyMekaRuntimeConfig } from '../mekaRuntimeInjection.js';
import type { MakerSessionCreateOpts } from '../sessionRequest.js';

function baseOpts(overrides: Partial<MakerSessionCreateOpts> = {}): MakerSessionCreateOpts {
  return {
    agentKind: 'codex',
    model: 'gpt-test',
    workingDir: 'C:/Workspace/saga2/saga2_project',
    workspaceKind: 'meka',
    mekaProjectId: 'saga2',
    mekaRoleId: 'general-development',
    ...overrides,
  };
}

function runtime(overrides: Partial<MekaRuntimeConfig> = {}): MekaRuntimeConfig {
  return {
    projectId: 'saga2',
    roleId: 'general-development',
    promptText: 'SAGA2 server code lives behind MCPRouter as saga2-server.',
    skills: [
      {
        id: 'remote-operation',
        name: 'Remote Operation',
        description: 'Use bound MCPRouter instances.',
        content: '# Remote Operation',
      },
    ],
    mcp: [
      { id: 'router', providerId: 'mcp-router', enabled: true },
      { id: 'project-agent', providerId: 'project-agent', enabled: true },
      { id: 'design', providerId: 'meka-design', enabled: true },
      { id: 'local-http', transport: 'http', url: 'https://example.invalid/mcp', enabled: true },
    ],
    policyProviderRefs: [],
    ...overrides,
  };
}

describe('applyMekaRuntimeConfig', () => {
  it('is wired into register bootstrap before maker.createSession', async () => {
    const source = await fs.readFile(new URL('../register.ts', import.meta.url), 'utf8');
    const bootstrap = source.indexOf('async function bootstrapSession');
    const applyRuntime = source.indexOf('await applyMekaRuntimeConfig(o,', bootstrap);
    const createSession = source.indexOf('await maker.createSession(o)', bootstrap);

    expect(bootstrap).toBeGreaterThanOrEqual(0);
    expect(applyRuntime).toBeGreaterThan(bootstrap);
    expect(createSession).toBeGreaterThan(applyRuntime);
  });

  it('injects project-role prompt and MCP provider ids for Meka sessions', async () => {
    const opts = baseOpts({
      userPrompt: 'USER PROMPT',
      vendorOptions: { onStderrLine: 'keep-me', orcaRole: 'lead' },
    });
    const materialize = vi.fn();

    const result = await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig: vi.fn(async () => runtime()),
      prepareRuntimeMcp: vi.fn((entries: readonly MekaRoleMcpEntry[]) => ({
        providerIds: entries
          .filter((entry): entry is Extract<typeof entry, { providerId: string }> =>
            'providerId' in entry,
          )
          .map((entry) => entry.providerId),
        inlineConfigs: entries.filter(
          (entry): entry is Extract<typeof entry, { transport: unknown }> => 'transport' in entry,
        ),
      })),
      isManagedWorkspaceDir: vi.fn(() => false),
      materializeRuntimeSkills: materialize,
    });

    expect(result).toMatchObject({
      didApply: true,
      mcpProviderIds: ['mcp-router', 'project-agent', 'meka-design'],
      inlineMcpCount: 1,
      skillsCount: 1,
      didMaterializeSkills: false,
      didInlineSkills: true,
    });
    expect(opts.userPrompt).toBe(
      'SAGA2 server code lives behind MCPRouter as saga2-server.\n\n' +
        '# Configured Meka Agent Skills\n\n' +
        '## Remote Operation (remote-operation)\n\n' +
        '# Remote Operation\n\n' +
        'USER PROMPT',
    );
    expect(opts.vendorOptions).toMatchObject({
      onStderrLine: 'keep-me',
      orcaRole: 'lead',
      source: 'meka',
      mekaProjectId: 'saga2',
      mekaRoleId: 'general-development',
      mekaMcpProviderIds: ['mcp-router', 'project-agent', 'meka-design'],
      mekaMcpInlineConfigs: [
        { id: 'local-http', transport: 'http', url: 'https://example.invalid/mcp' },
      ],
    });
    expect(materialize).not.toHaveBeenCalled();
  });

  it('materializes configured runtime skills only for app-managed workspaces', async () => {
    const opts = baseOpts({ workingDir: 'C:/Users/AppData/CindyMeka/meka-assistants/session-1' });
    const resolved = runtime();
    const materialize = vi.fn(async () => undefined);

    const result = await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig: vi.fn(async () => resolved),
      prepareRuntimeMcp: vi.fn(() => ({ providerIds: [], inlineConfigs: [] })),
      isManagedWorkspaceDir: vi.fn(() => true),
      materializeRuntimeSkills: materialize,
    });

    expect(result.didMaterializeSkills).toBe(true);
    expect(result.didInlineSkills).toBe(false);
    expect(materialize).toHaveBeenCalledWith(opts.workingDir, resolved.skills);
    expect(opts.userPrompt).toBe('SAGA2 server code lives behind MCPRouter as saga2-server.');
  });

  it('hydrates persisted legacy Meka bindings before resolving runtime config', async () => {
    const opts = baseOpts({
      id: 'legacy-session',
      workspaceKind: undefined,
      mekaProjectId: null,
      mekaRoleId: null,
      mekaRole: null,
    });
    const resolveRuntimeConfig = vi.fn(async (projectId: string, roleId: string) =>
      runtime({ projectId, roleId, skills: [], mcp: [] }),
    );

    const result = await applyMekaRuntimeConfig(opts, {
      readPersistedSession: vi.fn(async () => ({
        workspaceKind: 'meka' as const,
        mekaProjectId: 'saga2',
        mekaRoleId: null,
        mekaRole: 'planner' as const,
      })),
      resolveRuntimeConfig,
      prepareRuntimeMcp: vi.fn(() => ({ providerIds: [], inlineConfigs: [] })),
    });

    expect(result.didApply).toBe(true);
    expect(resolveRuntimeConfig).toHaveBeenCalledWith('saga2', 'system-overview');
    expect(opts).toMatchObject({
      workspaceKind: 'meka',
      mekaProjectId: 'saga2',
      mekaRoleId: 'system-overview',
      mekaRole: 'planner',
    });
  });

  it('does not duplicate prompt injection when the same create opts are bootstrapped twice', async () => {
    const opts = baseOpts({ userPrompt: 'USER PROMPT' });
    const resolveRuntimeConfig = vi.fn(async () => runtime({ skills: [], mcp: [] }));
    const prepareRuntimeMcp = vi.fn(() => ({ providerIds: [], inlineConfigs: [] }));

    const first = await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig,
      prepareRuntimeMcp,
    });
    const promptAfterFirstBootstrap = opts.userPrompt;
    const second = await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig,
      prepareRuntimeMcp,
    });

    expect(first.didApply).toBe(true);
    expect(second.didApply).toBe(false);
    expect(resolveRuntimeConfig).toHaveBeenCalledTimes(1);
    expect(prepareRuntimeMcp).toHaveBeenCalledTimes(1);
    expect(opts.userPrompt).toBe(promptAfterFirstBootstrap);
  });

  it('inlines rather than materializes skills for remote sessions', async () => {
    const opts = baseOpts({ remoteHostId: 'mcpr:instance-1' });
    const materialize = vi.fn(async () => undefined);

    const result = await applyMekaRuntimeConfig(opts, {
      resolveRuntimeConfig: vi.fn(async () => runtime()),
      prepareRuntimeMcp: vi.fn(() => ({ providerIds: [], inlineConfigs: [] })),
      isManagedWorkspaceDir: vi.fn(() => true),
      materializeRuntimeSkills: materialize,
    });

    expect(result.didMaterializeSkills).toBe(false);
    expect(result.didInlineSkills).toBe(true);
    expect(materialize).not.toHaveBeenCalled();
    expect(opts.userPrompt).toContain('# Configured Meka Agent Skills');
  });

  it.each([
    {
      name: 'project/role resolution',
      deps: {
        resolveRuntimeConfig: vi.fn(async () => {
          throw new Error('broken role');
        }),
      },
      message: '[INVALID_PARAMS] Meka project/role configuration failed: broken role',
    },
    {
      name: 'MCP preparation',
      deps: {
        resolveRuntimeConfig: vi.fn(async () => runtime()),
        prepareRuntimeMcp: vi.fn(() => {
          throw new Error('broken MCP');
        }),
      },
      message: '[INVALID_PARAMS] Meka project/role MCP configuration failed: broken MCP',
    },
  ])('preserves INVALID_PARAMS for $name failures', async ({ deps, message }) => {
    await expect(applyMekaRuntimeConfig(baseOpts(), deps)).rejects.toThrow(message);
  });

  it('leaves non-Meka sessions untouched', async () => {
    const opts = baseOpts({
      workspaceKind: 'project',
      mekaProjectId: null,
      mekaRoleId: null,
      userPrompt: 'USER PROMPT',
    });
    const resolveRuntimeConfig = vi.fn();

    const result = await applyMekaRuntimeConfig(opts, { resolveRuntimeConfig });

    expect(result.didApply).toBe(false);
    expect(resolveRuntimeConfig).not.toHaveBeenCalled();
    expect(opts.userPrompt).toBe('USER PROMPT');
    expect(opts.vendorOptions).toBeUndefined();
  });
});
