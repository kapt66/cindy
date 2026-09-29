import { EventEmitter } from 'node:events';

import { CC_MGR_BUNDLE_VERSION } from '@cindy/maker-cc-manager';
import { describe, expect, it } from 'vitest';

import { buildMcprTunnelUrl, openMcprTunnel } from '../mcpr-tunnel';

describe('Meka MCPRouter tunnel', () => {
  it('builds the authenticated agent-tunnel WebSocket URL without inherited query data', () => {
    // cc-mgr 隧道**带** `bundleVersion`：客户端开隧道时就要声明自己要求的 manager 版本
    // （cc-mgr 的版本闸门在 protocol/hello 里精确比对，而服务端子进程必须在握手前就是
    // 正确版本）。值必须等于真实 pin，所以这里读常量而不是写字面量 —— 否则 pin 漂了
    // 这条断言照样绿（同一个教训见 mcprCodexCapability.test.ts）。
    expect(buildMcprTunnelUrl('https://router.example/base?old=1', 'instance / one')).toBe(
      `wss://router.example/api/project-agent-instances/instance%20%2F%20one/agent-tunnel`
      + `?bundleVersion=${encodeURIComponent(CC_MGR_BUNDLE_VERSION)}`,
    );
    // 载体与 pin 的形状守护：常量被换成空值/未定义时上面那条会退化成自证。
    expect(CC_MGR_BUNDLE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    // codex-appserver **同样要**带版本要求：服务端那条分支跑的是 `cc-mgr codex-bridge`
    // （同一个 cc-mgr bundle、同样过 assertCcMgrBundlePin），只在 cc-mgr 模式声明版本会让
    // Codex 的 MCPRouter 会话继续撞 `[INVALID_BUNDLE_VERSION]`。
    const codexUrl = new URL(
      buildMcprTunnelUrl('https://router.example/base?old=1', 'instance / one', 'codex-appserver'),
    );
    expect(codexUrl.searchParams.get('mode')).toBe('codex-appserver');
    expect(codexUrl.searchParams.get('bundleVersion')).toBe(CC_MGR_BUNDLE_VERSION);
    // 既有形状不变：路径仍是 agent-tunnel，且不继承 baseUrl 的 query。
    expect(codexUrl.pathname).toBe(
      '/api/project-agent-instances/instance%20%2F%20one/agent-tunnel',
    );
    expect(codexUrl.searchParams.get('old')).toBeNull();
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
      'wss://router.example/api/project-agent-instances/instance-1/agent-tunnel'
      + `?bundleVersion=${encodeURIComponent(CC_MGR_BUNDLE_VERSION)}`,
    );
    expect(capturedCookie).toBe('session=session-token');
    expect(stream).toHaveProperty('onStdoutBytes');
  });
});
