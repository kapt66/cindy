import { describe, expect, it, vi } from 'vitest';

import { createMekaRouterClient } from '../routerClient';

describe('MekaRouterClient', () => {
  it('normalizes credential-free HTTPS URLs and migrates HTTP to production', () => {
    const client = createMekaRouterClient();
    expect(client.normalizeBaseUrl('https://router.example/base///?ignored=1')).toBe(
      'https://router.example/base',
    );
    expect(client.normalizeBaseUrl('http://retired-router.example/base')).toBe(
      'https://mcpr.meka.pawdy.fun',
    );
    expect(client.normalizeBaseUrl('https://192.0.2.10:1020/')).toBe('https://mcpr.meka.pawdy.fun');
    expect(() => client.normalizeBaseUrl('file:///tmp/router')).toThrow('must use HTTPS');
    expect(() => client.normalizeBaseUrl('https://user:pass@router.example')).toThrow(
      'must not contain credentials',
    );
  });

  it('preserves MCP endpoint query authorization while removing fragments', () => {
    const client = createMekaRouterClient();
    expect(
      client.normalizeMcpEndpointUrl(
        'https://design.example/api/mcp?key=mcp_secret&scope=design#ignored',
      ),
    ).toBe('https://design.example/api/mcp?key=mcp_secret&scope=design');
    expect(() => client.normalizeMcpEndpointUrl('file:///tmp/mcp')).toThrow('HTTP or HTTPS');
    expect(() =>
      client.normalizeMcpEndpointUrl('https://user:pass@design.example/api/mcp'),
    ).toThrow('must not contain URL credentials');
  });

  it('keeps paging tools/list until the Router cursor is exhausted', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const responses = [
      new Response('{}', { status: 200, headers: { 'mcp-session-id': 'mcp-session' } }),
      new Response('', { status: 202 }),
      Response.json({ result: { tools: [{ name: 'one' }], nextCursor: 'next' } }),
      Response.json({ result: { tools: [{ name: 'two' }] } }),
    ];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
      });
      return responses.shift()!;
    }) as typeof fetch;
    const client = createMekaRouterClient({ fetchImpl });

    await expect(client.listTools('https://router.example', 'client-key')).resolves.toEqual([
      { name: 'one' },
      { name: 'two' },
    ]);
    expect(calls.slice(2).map((call) => call.body.params)).toEqual([{}, { cursor: 'next' }]);
  });

  it('initializes an MCP session before calling a Router tool', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const responses = [
      new Response('{}', { status: 200, headers: { 'mcp-session-id': 'mcp-session' } }),
      new Response('', { status: 202 }),
      Response.json({
        result: { content: [{ type: 'text', text: 'done' }], isError: false },
      }),
    ];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {});
      return responses.shift()!;
    }) as typeof fetch;
    const client = createMekaRouterClient({ fetchImpl });

    await expect(
      client.callTool('https://router.example', 'client-key', 'build_project', {
        target: 'editor',
      }),
    ).resolves.toEqual({
      content: [{ type: 'text', text: 'done' }],
    });
    expect(calls.map((call) => call.method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/call',
    ]);
    expect(calls[2]?.params).toEqual({
      name: 'build_project',
      arguments: { target: 'editor' },
    });
  });

  it('registers discovered endpoints with client metadata', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ ok: true, count: 1, tools: ['read'] }),
    ) as typeof fetch;
    const client = createMekaRouterClient({ fetchImpl });

    await client.discover(
      'https://router.example',
      'session-token',
      'https://design.example/api/mcp',
      {
        clientName: 'MekaDesign',
        clientDescription: 'MekaDesign 设计平台 MCP 工具',
      },
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://router.example/api/routes/discover',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          endpoint: 'https://design.example/api/mcp',
          protocol: 'http',
          clientName: 'MekaDesign',
          clientDescription: 'MekaDesign 设计平台 MCP 工具',
        }),
      }),
    );
  });

  it('uploads a .cindy package with only the MCPRouter session cookie', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    let uploadedBody: BodyInit | null | undefined;
    const managed = {
      id: 'plugin-1',
      ghostId: 'demo-plugin',
      visibility: 'private',
      sharedUsernames: [],
      currentRelease: {
        id: 'release-1',
        version: '1.0.0',
        sha256: 'a'.repeat(64),
        sizeBytes: 4,
        publishedAt: '2026-07-29T00:00:00.000Z',
      },
    };
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      uploadedBody = init?.body;
      return Response.json(managed);
    }) as typeof fetch;
    const client = createMekaRouterClient({ fetchImpl });

    await expect(
      client.uploadMekaPlugin('https://router.example', 'session-token', bytes, null),
    ).resolves.toEqual(managed);

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://router.example/api/meka-plugins/upload',
      expect.objectContaining({
        method: 'POST',
        headers: {
          cookie: 'session=session-token',
          accept: 'application/json',
          'content-type': 'application/vnd.cindy.plugin',
        },
        body: expect.any(ArrayBuffer),
      }),
    );
    expect([...new Uint8Array(uploadedBody as ArrayBuffer)]).toEqual([...bytes]);
  });

  it('loads owned Plugin access and publishes updates through the bound release endpoint', async () => {
    const managed = {
      id: 'plugin-1',
      ghostId: 'demo-plugin',
      visibility: 'shared' as const,
      sharedUsernames: ['alice'],
      currentRelease: {
        id: 'release-2',
        version: '2.0.0',
        sha256: 'b'.repeat(64),
        sizeBytes: 4,
        publishedAt: '2026-07-29T00:00:00.000Z',
      },
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json([managed]))
      .mockResolvedValueOnce(Response.json(managed))
      .mockResolvedValueOnce(Response.json(managed)) as typeof fetch;
    const client = createMekaRouterClient({ fetchImpl });

    await expect(
      client.listOwnedMekaPlugins('https://router.example', 'session-token'),
    ).resolves.toEqual([managed]);
    await client.uploadMekaPlugin(
      'https://router.example',
      'session-token',
      new Uint8Array([1]),
      'plugin-1',
    );
    await client.setMekaPluginAccess(
      'https://router.example',
      'session-token',
      'plugin-1',
      'shared',
      ['alice'],
    );

    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://router.example/api/meka-plugins/plugin-1/releases',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      3,
      'https://router.example/api/meka-plugins/plugin-1/access',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ visibility: 'shared', sharedUsernames: ['alice'] }),
      }),
    );
  });

  it('classifies an expired owner-management session as permission denied', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ error: 'Unauthorized' }, { status: 401 }),
    ) as typeof fetch;
    const client = createMekaRouterClient({ fetchImpl });

    await expect(
      client.listOwnedMekaPlugins('https://router.example', 'expired-session'),
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      status: 401,
    });
  });
});
