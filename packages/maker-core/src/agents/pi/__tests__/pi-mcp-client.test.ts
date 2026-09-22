import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CINDY_BRIDGE_EXTENSION_SOURCE } from '../cindy-bridge-source.js';

// Execute the generated extension's actual client and registered gateway. Pi
// loads this standalone source, so importing a parallel client would miss bugs.
function gatewayWithFetch(
  fetchImpl: typeof fetch,
  options: {
    disclose?: boolean;
    callParams?: Record<string, unknown>;
    /** Registers a second server with a large catalog to probe bounded answers. */
    bulkTools?: number;
    /** Reproduces the connection path's "registered but not connected this time" state. */
    unavailableServer?: { name: string; reason: string };
  } = {},
) {
  const source = CINDY_BRIDGE_EXTENSION_SOURCE;
  const compiled = ts.transpileModule(
    source.slice(source.indexOf('const CINDY_MCP_LIST_TOOLS'), source.indexOf('async function connectServer'))
      + '\nglobalThis.Client = McpHttpClient; globalThis.Gateway = CindyMcpGateway;',
    { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const context: Record<string, any> = {
    fetch: fetchImpl, URL, Headers, AbortController, TextDecoder, process: { env: {} },
    setTimeout, clearTimeout,
  };
  runInNewContext(compiled, context);
  const client = new context.Client({ name: 'cindy', url: 'http://127.0.0.1/mcp' }, 'fake-token');
  client.finishStartup();
  const gateway = new context.Gateway();
  gateway.add('cindy', client, [{ name: 'ghost_call', inputSchema: {
    type: 'object', properties: { ghost_id: { type: 'string' } }, required: ['ghost_id'],
  } }]);
  if (options.bulkTools) {
    gateway.add('bulk', client, Array.from({ length: options.bulkTools }, (_unused, index) => ({
      name: 'bulk_tool_' + index,
      inputSchema: { type: 'object', properties: { index: { type: 'number' } } },
    })));
  }
  if (options.unavailableServer) {
    gateway.markUnavailable(options.unavailableServer.name, options.unavailableServer.reason);
  }
  const registered: any[] = [];
  gateway.register({ registerTool: (tool: unknown) => registered.push(tool) });
  const list = (params: unknown) => registered.find(t => t.name === 'cindy_mcp_list_tools')
    .execute('list', params);
  if (options.disclose !== false) void list({ server: 'cindy', tool: 'ghost_call' });
  const call = (signal?: AbortSignal, params?: Record<string, unknown>) => registered
    .find(t => t.name === 'cindy_mcp_call_tool')
    .execute(
      'call',
      params ?? options.callParams ?? { server: 'cindy', tool: 'ghost_call', args: { ghost_id: 'demo' } },
      signal,
    );
  return { list, call };
}

afterEach(() => vi.useRealTimers());

describe('Pi MCP request lifecycle', () => {
  it('waits for card interaction beyond five minutes with one explicit deadline', async () => {
    vi.useFakeTimers();
    let complete!: (response: Response) => void;
    const fetchImpl = vi.fn((_url, options) => {
      expect(options.timeout).toBe(false);
      return new Promise<Response>(resolve => { complete = resolve; });
    });
    const { call } = gatewayWithFetch(fetchImpl);
    const result = call();
    await vi.advanceTimersByTimeAsync(301_000);
    expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(false);
    complete(Response.json({ result: { content: [{ type: 'text', text: 'clicked' }] } }));
    await expect(result).resolves.toMatchObject({ content: [{ text: 'clicked' }] });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['cancel', 'timeout'] as const)('aborts an in-flight response on %s without blaming its arguments', async (action) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let bodyStarted!: () => void;
    const bodyReady = new Promise<void>(resolve => { bodyStarted = resolve; });
    const { call } = gatewayWithFetch(vi.fn(async (_url, options) => {
      // Response headers arrived; body is still waiting for the tool.
      return { headers: new Headers(), ok: true, json: () => new Promise((_resolve, reject) => {
        options!.signal!.addEventListener('abort', () => reject(new Error('secret URL')), { once: true });
        bodyStarted();
      }) } as Response;
    }));
    const result = call(controller.signal);
    const assertion = expect(result).rejects.toThrow(action === 'cancel' ? 'request cancelled' : 'request timed out');
    await bodyReady;
    if (action === 'cancel') controller.abort();
    else await vi.advanceTimersByTimeAsync(600_000);
    await assertion;
    await result.catch((error: Error) => {
      expect(error.message).not.toContain('schema');
      expect(error.message).not.toContain('secret');
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains only allowlisted transport codes, not messages or arbitrary causes', async () => {
    const { call } = gatewayWithFetch(vi.fn(async () => {
      throw Object.assign(new Error('https://secret-token@example.test'), {
        cause: { code: 'ECONNRESET', message: 'Authorization: secret' },
      });
    }));
    await expect(call()).rejects.toThrow('request failed (ECONNRESET)');
    await call().catch((error: Error) => {
      expect(error.message).not.toMatch(/secret|schema|example/);
    });
  });

  it('adds schema help only for the MCP invalid-parameters error code', async () => {
    const { call } = gatewayWithFetch(vi.fn(async () => Response.json({
      error: { code: -32602, message: 'untrusted upstream text' },
    })));
    await expect(call()).rejects.toThrow('Expected args schema:');
    const business = gatewayWithFetch(vi.fn(async () => Response.json({ result: {
      isError: true, content: [{ type: 'text', text: 'Plugin unavailable' }],
    } })));
    await expect(business.call()).rejects.toThrow(/^Plugin unavailable$/);
  });
});

describe('Pi MCP gateway discovery', () => {
  const unusedFetch = () => vi.fn(async () => Response.json({ result: { content: [] } }));

  it('returns the input schema with the not-disclosed error so one retry is enough', async () => {
    const fetchImpl = unusedFetch();
    const gateway = gatewayWithFetch(fetchImpl, { disclose: false });
    const failure = await gateway.call().then(() => undefined, (error: Error) => error);

    // 网关错误来自 vm 里的另一 realm,只按消息断言。
    expect(failure).toBeDefined();
    expect(failure?.message).toContain('Inspect this tool before execution');
    expect(failure?.message).toContain('"server":"cindy","tool":"ghost_call"');
    expect(failure?.message).toContain('Expected args schema:');
    expect(failure?.message).toContain('"ghost_id"');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // 这条只钉"未检视前执行被挡住":schema 提示虽然随错误一起给(见上一条),
  // 但它不能替代检视这一步——检视本身仍是不放行的门。
  it('keeps execution blocked until the tool is inspected through list_tools', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ result: { content: [{ type: 'text', text: 'ok' }] } }));
    const gateway = gatewayWithFetch(fetchImpl, { disclose: false });

    await expect(gateway.call()).rejects.toThrow('Inspect this tool before execution');
    expect(fetchImpl).not.toHaveBeenCalled();
    await gateway.list({ server: 'cindy', tool: 'ghost_call' });
    await expect(gateway.call()).resolves.toMatchObject({ content: [{ text: 'ok' }] });
  });

  it('answers an unknown server as an unknown server even when a tool name is passed', async () => {
    const gateway = gatewayWithFetch(unusedFetch());
    for (const params of [{ server: 'meka-unity' }, { server: 'meka-unity', tool: 'unity_inspect' }]) {
      const result: any = await gateway.list(params);
      expect(result.details).toMatchObject({
        ok: false, errorCode: 'UNKNOWN_SERVER', requested: 'meka-unity',
      });
      expect(result.details.availableTools).toBeUndefined();
      expect(result.details.availableServers).toContain('cindy');
      expect(result.details.reason).toContain('"meka-unity" is not a connected gateway server');
      expect(result.details.reason).toContain('Installed plugins (ghosts) are not MCP servers');
      expect(result.details.reason).toContain('{server:"cindy", tool:"ghost_call"');
      expect(result.details.reason).toContain('ghost_list');
    }
  });

  it('still answers a bad tool on a known server with the real tool list', async () => {
    const gateway = gatewayWithFetch(unusedFetch());
    const result: any = await gateway.list({ server: 'cindy', tool: 'not_a_tool' });

    expect(result.details).toMatchObject({ ok: false, errorCode: 'UNKNOWN_TOOL' });
    expect(result.details.availableTools).toEqual(['ghost_call']);
  });

  it('teaches the plugin lesson when call_tool treats a plugin id as an MCP server', async () => {
    const fetchImpl = unusedFetch();
    const gateway = gatewayWithFetch(fetchImpl, {
      callParams: { server: 'meka-unity', tool: 'unity_inspect' },
    });
    const failure = await gateway.call().then(() => undefined, (error: Error) => error);

    // 与 list_tools 的 UNKNOWN_SERVER 同一课:插件经 cindy 网关的 ghost_call 走,
    // 不是 MCP server;插件 id 来自注入花名册/用户消息/角色配置。
    expect(failure?.message).toContain('"meka-unity" is not a connected gateway server');
    expect(failure?.message).toContain('Installed plugins (ghosts) are not MCP servers');
    expect(failure?.message).toContain('injected plugin roster');
    expect(failure?.message).toContain('only when the session policy permits ghost_list');
    expect(failure?.message).toContain('Available gateway servers: ["cindy"]');
    // 不再倾倒工具清单:这条报错只给有界的 server 名。
    expect(failure?.message).not.toContain('Unknown Cindy MCP tool. Call cindy_mcp_list_tools first.');
    expect(failure?.message).not.toContain('"name":"ghost_call"');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('answers a registered but unavailable server with its real reason, not the generic catalogue', async () => {
    const fetchImpl = unusedFetch();
    const gateway = gatewayWithFetch(fetchImpl, {
      callParams: { server: 'dead-srv', tool: 'dead_tool' },
      unavailableServer: { name: 'dead-srv', reason: 'request timed out' },
    });
    const failure = await gateway.call().then(() => undefined, (error: Error) => error);

    // 注册过但这次没连上:给真实原因 + 有界的 server 名,既不贴插件那一课,也不倾倒工具清单。
    expect(failure?.message).toContain('"dead-srv" is registered but unavailable: request timed out');
    expect(failure?.message).toContain('Available gateway servers: ["cindy"]');
    expect(failure?.message).not.toContain('Installed plugins (ghosts) are not MCP servers');
    expect(failure?.message).not.toContain('Unknown Cindy MCP tool. Call cindy_mcp_list_tools first.');
    expect(failure?.message).not.toContain('"name":"ghost_call"');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps the unknown-server call answer bounded even with a huge tool catalog', async () => {
    const gateway = gatewayWithFetch(unusedFetch(), { bulkTools: 2_000 });

    const unknownServer = await gateway.call(undefined, { server: 'meka-unity', tool: 'unity_inspect' })
      .then(() => undefined, (error: Error) => error);
    expect(unknownServer?.message).toContain('Installed plugins (ghosts) are not MCP servers');
    expect(unknownServer?.message.length).toBeLessThan(3_000);
    expect(unknownServer?.message).not.toContain('bulk_tool_0');

    // 反例保留既有行为:server 对、tool 名错时仍给(截断后的)真实工具清单。
    const knownServer = await gateway.call(undefined, { server: 'bulk', tool: 'not_a_tool' })
      .then(() => undefined, (error: Error) => error);
    expect(knownServer?.message).toContain('Call cindy_mcp_list_tools first');
    expect(knownServer?.message).toContain('bulk_tool_0');
  });
});
