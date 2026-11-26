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
  assertPsbIdentifier,
  normalizePsbWebUrl,
  psbHttpUrl,
  psbWebSocketUrl,
  PsbUrlRejectedError,
  resetPsbEndpointCacheForTest,
  resolvePsbEndpoint,
  resolvePsbUrl,
} from '../psbEndpoint';

const ENV_KEY = 'CINDY_MEKA_PSB_HOST';
const original = process.env[ENV_KEY];

describe('psbEndpoint 站点根解析', () => {
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
    expect(psbHttpUrl('/api/cindy/remote/workspaces')).toBe(
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

/**
 * URL 解析白名单（安全）：这里是「服务端下发的路径能不能带 Bearer 发出去」的唯一判据。
 *
 * Bug 依据：旧实现只拒绝字面 `..`，`%2e%2e` 会被 URL 解析器归一化到 Cindy 命名空间之外，
 * 一条带 Bearer 的请求就被打到别的路由上。最小失败输入 = `…/workspaces/x/%2e%2e/%2e%2e/evil`。
 */
describe('resolvePsbUrl：归一化后的固定来源判定', () => {
  beforeEach(() => {
    delete process.env[ENV_KEY];
    resetPsbEndpointCacheForTest();
  });

  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
    resetPsbEndpointCacheForTest();
  });

  it('合法 Cindy 命名空间路径（含 query）解析到当前站点的绝对地址', () => {
    expect(resolvePsbUrl('/api/cindy/remote/workspaces/ws-1/vcs?project=1')).toBe(
      `https://${PSB_FORMAL_HOST}/api/cindy/remote/workspaces/ws-1/vcs?project=1`,
    );
  });

  it('encoded dot（%2e%2e / %2E%2E）与字面 .. 一律拒绝（URL 归一化会越界）', () => {
    for (const path of [
      '/api/cindy/remote/workspaces/ws-1/%2e%2e/%2e%2e/evil',
      '/api/cindy/remote/workspaces/ws-1/%2E%2E/evil',
      '/api/cindy/remote/workspaces/ws-1/../evil',
    ]) {
      expect(() => resolvePsbUrl(path), path).toThrow(PsbUrlRejectedError);
      expect(() => resolvePsbUrl(path)).toThrow(/path-normalized/);
    }
  });

  it('跨 origin / 协议相对 / 片段 / 反斜杠 / 空白 / 非 Cindy 命名空间拒绝', () => {
    for (const path of [
      `https://evil.example/api/cindy/remote/workspaces`,
      '//evil.example/api/cindy/remote/workspaces',
      '/api/cindy/remote/workspaces#frag',
      '/api/cindy/remote/workspaces\\evil',
      '/api/cindy/remote/workspaces ws',
      '/api/remote/workspaces',
      'api/cindy/remote/workspaces',
    ]) {
      expect(() => resolvePsbUrl(path), path).toThrow(PsbUrlRejectedError);
    }
  });

  it('编码的点段 / 编码分隔符 / 连续 // 一律拒绝（URL 归一化看不出，落地端会二次解码）', () => {
    // 2026-11-27 复审 s1 实测：`%2e%2e%2f` 与 `//` 能通过「归一化无变化」判据。
    // 二者在 URL 解析里都是普通字符（pathname 不变），但服务端 / 反向代理解码后语义会变：
    // `%2e%2e%2f` 解码成 `../`，`//` 的空段被部分网关折叠。PSB 下发的路径里没有它们的正当用途。
    for (const path of [
      '/api/cindy/remote/workspaces/x/%2e%2e%2f%2e%2e%2fevil',
      '/api/cindy/remote/workspaces/x/%2E%2E%2Fevil',
      '/api/cindy/remote/workspaces/x/%2fevil',
      '/api/cindy/remote/workspaces/x/..%2f..%2fevil',
      '/api/cindy/remote/workspaces%5c..%5cevil',
    ]) {
      expect(() => resolvePsbUrl(path), path).toThrow(PsbUrlRejectedError);
      expect(() => resolvePsbUrl(path), path).toThrow(/encoded-separator/);
    }

    for (const path of [
      '/api/cindy/remote//workspaces',
      '/api/cindy/remote/workspaces//ws-1/vcs',
    ]) {
      expect(() => resolvePsbUrl(path), path).toThrow(PsbUrlRejectedError);
      expect(() => resolvePsbUrl(path), path).toThrow(/duplicate-slash/);
    }

    // 合法路径（含 query 里的正常百分号编码）仍然通过：拒绝面只覆盖 path 里的「分隔符/点段」。
    expect(
      resolvePsbUrl('/api/cindy/remote/workspaces/ws-1/vcs?path=%2Ftmp%2Fcheckout'),
    ).toBe(`https://${PSB_FORMAL_HOST}/api/cindy/remote/workspaces/ws-1/vcs?path=%2Ftmp%2Fcheckout`);
  });

  it('会被拼进路径的会话 id 在编进 URL 之前就按同一判据拒绝（编码分隔符不扩大防线）', () => {
    // 串流 WS / agent-tunnel WS 的路径都带会话 id：含 `/` `\` `%` 空白时 `encodeURIComponent`
    // 会产出 `%2F` / `%5C` / `%25` / `%20`，而路径校验拒绝编码分隔符。真实 PSB id 是 UUID /
    // 短标识，所以这类 id 是协议违约 —— 在拼 URL 前拒绝，错误归因才清楚（2026-11-27 复审 P2）。
    for (const value of ['', 'sess 1', 'sess/1', 'sess\\1', 'sess%2F1', 'sess?x=1', 'sess#1', 'a'.repeat(257)]) {
      expect(() => assertPsbIdentifier(value), value).toThrow(PsbUrlRejectedError);
    }
    for (const value of ['9f1c2d3e-4b5a-4c6d-8e7f-0123456789ab', 'desktop-1', 'sess-1_2.a']) {
      expect(() => assertPsbIdentifier(value), value).not.toThrow();
    }
  });
});
