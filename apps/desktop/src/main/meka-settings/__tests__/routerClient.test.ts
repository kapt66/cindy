import { describe, expect, it, vi } from 'vitest';

import { createMekaRouterClient } from '../routerClient';

describe('MekaRouterClient', () => {
  it('normalizes only credential-free HTTP(S) URLs', () => {
    const client = createMekaRouterClient();
    expect(client.normalizeBaseUrl('https://router.example/base///?ignored=1')).toBe(
      'https://router.example/base',
    );
    expect(() => client.normalizeBaseUrl('file:///tmp/router')).toThrow('HTTP or HTTPS');
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
});
