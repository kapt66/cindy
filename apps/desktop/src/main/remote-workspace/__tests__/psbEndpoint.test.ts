/**
 * psbEndpoint 单测 —— PSB 站点根解析与 `CINDY_MEKA_PSB_HOST` 测试部署覆盖。
 *
 * 测试价值
 * - 生产入口与可观察结果：`resolvePsbEndpoint()` / `psbWebSocketUrl()` / `normalizePsbWebUrl()`
 *   是 main 侧所有 PSB 调用（HTTP、两条 WS、网页跳转）的唯一地址来源。用户可观察结果是
 *   「联调时 Cindy 整体打到测试部署，且网页跳转不会跳回生产」。
 * - Bug／规则依据：`docs/dev-rules/psb-remote-session-transport.md` §7 第 6 条
 *   （端点解析只有一份、复用 `CINDY_MEKA_PSB_HOST` 白名单、不做明文降级）与
 *   `cindy-brain/mekaPsbHostOverride.ts` 的不变量（白名单之外的值一律不生效）。
 * - 现有覆盖缺口：`psbEndpoint.ts` 是本轮新增文件；白名单解析的既有用例只覆盖插件路径，
 *   不覆盖「远程工作区 HTTP / WS / 网页跳转一起改道」这条组合。
 * - 最小失败输入：环境变量写成非白名单主机（必须被忽略并保持正式主机）；`webUrl` 指向正式
 *   主机而当前生效站点是测试部署（必须只替换协议 + 主机）。
 * - tier：unit（纯函数 + 进程环境变量，无网络）。
 * - 实测耗时：单独运行 1.61s（其中用例 3ms；其余为 vitest 启动与模块加载）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  PSB_FORMAL_HOST,
  PSB_TEST_HOST,
  normalizePsbWebUrl,
  psbHttpUrl,
  psbWebSocketUrl,
  resetPsbEndpointCacheForTest,
  resolvePsbEndpoint,
} from '../psbEndpoint';

const ENV_KEY = 'CINDY_MEKA_PSB_HOST';

describe('psbEndpoint 站点根解析', () => {
  const original = process.env[ENV_KEY];

  beforeEach(() => {
    delete process.env[ENV_KEY];
    resetPsbEndpointCacheForTest();
  });

  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
    resetPsbEndpointCacheForTest();
  });

  it('未设置覆盖时使用正式部署，HTTP 与 WS 都不降级到明文', () => {
    expect(resolvePsbEndpoint()).toEqual({
      host: PSB_FORMAL_HOST,
      origin: `https://${PSB_FORMAL_HOST}`,
      testHost: false,
    });
    expect(psbHttpUrl('api/cindy/remote/workspaces')).toBe(
      `https://${PSB_FORMAL_HOST}/api/cindy/remote/workspaces`,
    );
    expect(psbWebSocketUrl('/api/cindy/remote/sessions/s1/stream')).toBe(
      `wss://${PSB_FORMAL_HOST}/api/cindy/remote/sessions/s1/stream`,
    );
  });

  it('设置测试主机覆盖后，HTTP 与 WS 一起改道', () => {
    process.env[ENV_KEY] = PSB_TEST_HOST;
    resetPsbEndpointCacheForTest();

    expect(resolvePsbEndpoint()).toMatchObject({ host: PSB_TEST_HOST, testHost: true });
    expect(psbHttpUrl('/api/cindy/remote/workspaces')).toBe(
      `https://${PSB_TEST_HOST}/api/cindy/remote/workspaces`,
    );
    expect(psbWebSocketUrl('/api/cindy/remote/sessions/s1/stream')).toBe(
      `wss://${PSB_TEST_HOST}/api/cindy/remote/sessions/s1/stream`,
    );
  });

  it('白名单之外的主机名被忽略，仍然落在正式部署', () => {
    process.env[ENV_KEY] = 'evil.example.com';
    resetPsbEndpointCacheForTest();

    expect(resolvePsbEndpoint()).toMatchObject({ host: PSB_FORMAL_HOST, testHost: false });
    expect(psbHttpUrl('/api/cindy/remote/clients')).toBe(
      `https://${PSB_FORMAL_HOST}/api/cindy/remote/clients`,
    );
  });

  it('PSB 下发的网页地址只替换协议与主机，路径与查询保持 PSB 的事实', () => {
    process.env[ENV_KEY] = PSB_TEST_HOST;
    resetPsbEndpointCacheForTest();

    expect(
      normalizePsbWebUrl(`https://${PSB_FORMAL_HOST}/remote/workspaces/ws-1/sessions?tab=agent`),
    ).toBe(`https://${PSB_TEST_HOST}/remote/workspaces/ws-1/sessions?tab=agent`);
    expect(normalizePsbWebUrl(null)).toBeNull();
    expect(normalizePsbWebUrl('not a url')).toBeNull();
    expect(normalizePsbWebUrl('file:///etc/passwd')).toBeNull();
  });
});
