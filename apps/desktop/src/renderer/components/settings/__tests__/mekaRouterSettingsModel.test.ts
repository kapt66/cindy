import { describe, expect, it } from 'vitest';

import type {
  MekaRouterInstance,
  MekaRouterTemplate,
  MekaRouterTool,
} from '../../../../shared/meka-router';
import {
  buildMekaRouterClientGroups,
  getMekaRouterClientLabel,
  groupMekaRouterTemplates,
} from '../mekaRouterSettingsModel';

describe('Meka MCPRouter settings model', () => {
  it('groups concrete tool routes into endpoint clients', () => {
    const tools: MekaRouterTool[] = [
      { name: 'design_read' },
      { name: 'design_write' },
      { name: 'worker_status' },
    ];

    expect(
      buildMekaRouterClientGroups(tools, [
        {
          id: 'route-1',
          toolName: 'design_read',
          endpoint: 'https://design.example/api/mcp',
          clientName: 'MekaDesign',
          clientDescription: 'Design platform tools',
          enabled: true,
        },
        {
          id: 'route-2',
          toolName: 'design_write',
          endpoint: 'https://design.example/api/mcp',
          clientName: 'MekaDesign',
          clientDescription: 'Design platform tools',
          enabled: false,
        },
      ]),
    ).toEqual({
      clients: [
        {
          endpoint: 'https://design.example/api/mcp',
          name: 'MekaDesign',
          description: 'Design platform tools',
          routeIds: ['route-1', 'route-2'],
          toolCount: 2,
          enabled: false,
        },
      ],
      systemToolCount: 1,
    });
  });

  it('uses the MekaDesign identity and otherwise falls back to endpoint host', () => {
    expect(
      getMekaRouterClientLabel('https://design.example/api/mcp', 'https://design.example/api/mcp'),
    ).toBe('MekaDesign');
    expect(getMekaRouterClientLabel('https://router-client.example/mcp', null)).toBe(
      'router-client.example',
    );
    expect(getMekaRouterClientLabel('local-client', null)).toBe('local-client');
  });

  it('groups remote instances under their templates and preserves orphans', () => {
    const templates: MekaRouterTemplate[] = [
      { id: 'template-1', name: 'SAGA2 Worker', description: null },
    ];
    const instance = (id: string, projectId: string | null): MekaRouterInstance => ({
      id,
      instanceId: id,
      projectId,
      projectName: id,
      projectDescription: null,
      agentType: 'claude',
      agentMode: 'ask',
      status: 'running',
      workspaceRef: null,
      supported: true,
      available: true,
      remoteHostId: `mcpr:${id}`,
      workingDir: `/mcpr/${id}`,
    });

    expect(
      groupMekaRouterTemplates(templates, [
        instance('bound', 'template-1'),
        instance('orphan', 'missing-template'),
      ]),
    ).toEqual({
      templates: [
        { template: templates[0], instances: [expect.objectContaining({ id: 'bound' })] },
      ],
      orphanInstances: [expect.objectContaining({ id: 'orphan' })],
    });
  });
});
