import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import { buildMcprTunnelUrl, openMcprTunnel } from '../mcpr-tunnel';

describe('Meka MCPRouter tunnel', () => {
  it('builds the authenticated agent-tunnel WebSocket URL without inherited query data', () => {
    expect(buildMcprTunnelUrl('https://router.example/base?old=1', 'instance / one')).toBe(
      'wss://router.example/api/project-agent-instances/instance%20%2F%20one/agent-tunnel',
    );
  });

  it('uses the stored Router session cookie when opening a project instance tunnel', async () => {
    let capturedUrl = '';
    let capturedCookie = '';
    class FakeSocket {
      readyState = 1;
      binaryType?: string;
      private readonly events = new EventEmitter();

      constructor(url: string, options: { headers: Record<string, string> }) {
        capturedUrl = url;
        capturedCookie = options.headers.cookie;
        queueMicrotask(() => this.events.emit('open'));
      }

      send() {}
      close() {}
      terminate() {}
      on(event: string, callback: (...args: unknown[]) => void) {
        this.events.on(event, callback);
        return this;
      }
    }

    const stream = await openMcprTunnel('mcpr:instance-1', {
      getAuth: async () => ({
        baseUrl: 'https://router.example',
        sessionToken: 'session-token',
      }),
      WebSocketCtor: FakeSocket as never,
    });

    expect(capturedUrl).toBe(
      'wss://router.example/api/project-agent-instances/instance-1/agent-tunnel',
    );
    expect(capturedCookie).toBe('session=session-token');
    expect(stream).toHaveProperty('onStdoutBytes');
  });
});
