/**
 * 测试价值
 * - 生产入口与可观察结果：`resolveMekaPsbHostOverride` / `readMekaPsbHostOverride`
 *   （Host 启动期唯一开关）、`rewriteMekaPsbHost`（插件出网改写边界）与
 *   `withMekaPsbHostDeclarations`（Meka 开发目录派生清单补声明）。用户可见结果是
 *   「设了 `CINDY_MEKA_PSB_HOST` 时只有正式 PSB 主机的请求被改道到测试部署；没设时
 *   一个请求、一个 manifest 字段都不变」。
 * - Bug／规则依据：2026-11-18 维护者需求——插件包保持正式 `mekabot.meka.pawdy.fun`
 *   不变、发布后不再改插件，本地验收 `mekabot-test.meka.pawdy.fun` 时用启动期环境变量
 *   在运行时替换。取值白名单是凭证流向边界（企业身份 JWT 绝不能被引到未声明主机），
 *   规则正文见 `docs/dev-rules/plugin-security-and-authoring.md` §4.4。
 * - 现有覆盖缺口：`networkSlot` 与 `mekaDevPlugins` 的既有用例全部按「没有覆盖」编写，
 *   没有任何断言证明白名单拒绝、未设置时的零影响，以及「只改正式 PSB 主机」。
 * - 最小失败输入：`CINDY_MEKA_PSB_HOST=https://evil.example` 若被接受，插件 JWT 会被
 *   引到未声明主机；未设置时 `network.hosts` 若被多写一条测试主机，就违反了「发布后
 *   不用改插件」的前提（派生包权限凭空变大）。
 * - tier：unit（纯函数，无 Electron、无网络、无文件）。
 */

import { describe, expect, it } from 'vitest';

import { validateGhostManifest } from '../../../shared/ghost.js';
import {
  MEKA_PSB_HOST,
  MEKA_PSB_HOST_ENV,
  MEKA_PSB_TEST_HOST,
  manifestDeclaresMekaPsbHost,
  readMekaPsbHostOverride,
  resolveMekaPsbHostOverride,
  rewriteMekaPsbHost,
  withMekaPsbHostDeclarations,
} from '../mekaPsbHostOverride.js';

/** `meka-submit` 这类插件的最小作者清单：正式 PSB 主机 + 企业身份 JWT。 */
function psbAuthorManifest(
  overrides: {
    hosts?: string[];
    secrets?: unknown[];
  } = {},
): Record<string, unknown> {
  return {
    schemaVersion: 2,
    id: 'meka-submit',
    name: 'Meka Submit',
    version: '0.12.5',
    entry: 'main.js',
    slots: ['tool', 'network'],
    tools: [{ name: 'submit_task', description: 'Submit a task to PSB' }],
    network: {
      hosts: overrides.hosts ?? [MEKA_PSB_HOST],
      secrets:
        overrides.secrets ??
        [
          {
            key: 'cindy_identity',
            label: 'Cindy Enterprise Identity',
            source: 'oidc-token',
            inject: {
              header: 'Authorization',
              format: 'Bearer {value}',
              hosts: [MEKA_PSB_HOST],
            },
          },
        ],
    },
  };
}

describe('CINDY_MEKA_PSB_HOST whitelist', () => {
  it('只接受测试主机；正式主机等于没开；其它值一律拒绝', () => {
    expect(resolveMekaPsbHostOverride(undefined)).toEqual({ kind: 'off' });
    expect(resolveMekaPsbHostOverride('')).toEqual({ kind: 'off' });
    expect(resolveMekaPsbHostOverride('   ')).toEqual({ kind: 'off' });
    expect(resolveMekaPsbHostOverride(MEKA_PSB_TEST_HOST)).toEqual({
      kind: 'test',
      host: MEKA_PSB_TEST_HOST,
    });
    // 大小写与首尾空白归一化后仍只认白名单值。
    expect(resolveMekaPsbHostOverride(`  ${MEKA_PSB_TEST_HOST.toUpperCase()}  `)).toEqual({
      kind: 'test',
      host: MEKA_PSB_TEST_HOST,
    });
    expect(resolveMekaPsbHostOverride(MEKA_PSB_HOST)).toEqual({ kind: 'formal' });
    for (const value of [
      'evil.example',
      'mekabot-test.meka.pawdy.fun.evil.example',
      `https://${MEKA_PSB_TEST_HOST}`,
      `*.${MEKA_PSB_TEST_HOST}`,
      'mekabot-test.meka.pawdy.fun:8443',
    ]) {
      expect(resolveMekaPsbHostOverride(value)).toEqual({ kind: 'rejected', value });
    }
  });

  it('启动期读到的生效主机只在白名单测试主机时为非 null', () => {
    expect(readMekaPsbHostOverride({})).toEqual({ host: null, resolution: { kind: 'off' } });
    expect(readMekaPsbHostOverride({ [MEKA_PSB_HOST_ENV]: MEKA_PSB_TEST_HOST }).host).toBe(
      MEKA_PSB_TEST_HOST,
    );
    expect(readMekaPsbHostOverride({ [MEKA_PSB_HOST_ENV]: MEKA_PSB_HOST }).host).toBeNull();
    expect(readMekaPsbHostOverride({ [MEKA_PSB_HOST_ENV]: 'evil.example' }).host).toBeNull();
  });
});

describe('rewriteMekaPsbHost', () => {
  it('只改写逐字匹配正式 PSB 主机的 HTTPS 默认端口请求，协议/端口/路径/参数保留', () => {
    const formal = new URL('https://mekabot.meka.pawdy.fun/api/task/submit?debug=1#frag');
    const rewritten = rewriteMekaPsbHost(formal, MEKA_PSB_TEST_HOST);
    expect(rewritten).not.toBe(formal);
    expect(rewritten.toString()).toBe(
      `https://${MEKA_PSB_TEST_HOST}/api/task/submit?debug=1#frag`,
    );
    // 原始 URL 不被原地修改。
    expect(formal.hostname).toBe(MEKA_PSB_HOST);
  });

  it('未开覆盖、其它 host、自定义端口与明文 HTTP 一律原样返回同一实例', () => {
    const otherHost = new URL('https://api.example.com/x');
    expect(rewriteMekaPsbHost(otherHost, MEKA_PSB_TEST_HOST)).toBe(otherHost);
    const formal = new URL('https://mekabot.meka.pawdy.fun/x');
    expect(rewriteMekaPsbHost(formal, null)).toBe(formal);
    for (const raw of [
      'https://mekabot.meka.pawdy.fun:8443/x',
      'http://mekabot.meka.pawdy.fun/x',
      'https://mekabot.meka.pawdy.fun.evil.example/x',
      'https://cluster.mekabot.meka.pawdy.fun/x',
    ]) {
      const target = new URL(raw);
      expect(rewriteMekaPsbHost(target, MEKA_PSB_TEST_HOST)).toBe(target);
    }
  });
});

describe('manifestDeclaresMekaPsbHost', () => {
  it('逐字与 origin 两种声明都算声明，其它 host 不算', () => {
    expect(manifestDeclaresMekaPsbHost([MEKA_PSB_TEST_HOST], MEKA_PSB_TEST_HOST)).toBe(true);
    expect(
      manifestDeclaresMekaPsbHost([`https://${MEKA_PSB_TEST_HOST}`], MEKA_PSB_TEST_HOST),
    ).toBe(true);
    expect(manifestDeclaresMekaPsbHost([MEKA_PSB_HOST], MEKA_PSB_TEST_HOST)).toBe(false);
    expect(manifestDeclaresMekaPsbHost([MEKA_PSB_TEST_HOST], null)).toBe(false);
  });
});

describe('withMekaPsbHostDeclarations', () => {
  it('给声明了正式 PSB 主机的派生清单追加测试主机，正式主机保留，源数据不被原地修改', () => {
    const source = psbAuthorManifest();
    const sourceSnapshot = structuredClone(source);

    const patch = withMekaPsbHostDeclarations(source, MEKA_PSB_TEST_HOST);

    expect(patch).not.toBeNull();
    const network = patch!.manifest.network as {
      hosts: string[];
      secrets: Array<{ inject: { hosts: string[] } }>;
    };
    expect(network.hosts).toEqual([MEKA_PSB_HOST, MEKA_PSB_TEST_HOST]);
    expect(network.secrets[0]!.inject.hosts).toEqual([MEKA_PSB_HOST, MEKA_PSB_TEST_HOST]);
    expect(patch!.addedHosts).toEqual([MEKA_PSB_TEST_HOST]);
    expect(patch!.addedInjectHosts).toBe(1);

    // 源清单（作者文件的内存快照）逐字段未变，且不是同一份数组/对象引用。
    expect(source).toEqual(sourceSnapshot);
    expect(patch!.manifest).not.toBe(source);
    expect(network).not.toBe(source.network);
    expect(network.hosts).not.toBe((source.network as { hosts: string[] }).hosts);
    expect(network.secrets[0]).not.toBe((source.network as { secrets: unknown[] }).secrets[0]);
  });

  it('补完声明的派生清单仍通过严格 manifest 校验（inject.hosts 必须逐字取自 network.hosts）', () => {
    const patch = withMekaPsbHostDeclarations(psbAuthorManifest(), MEKA_PSB_TEST_HOST);
    expect(patch).not.toBeNull();
    const validated = validateGhostManifest(patch!.manifest);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.manifest.network?.hosts).toEqual([MEKA_PSB_HOST, MEKA_PSB_TEST_HOST]);
    expect(validated.manifest.network?.secrets?.[0]?.inject.hosts).toEqual([
      MEKA_PSB_HOST,
      MEKA_PSB_TEST_HOST,
    ]);
  });

  it('未开覆盖、非 PSB 插件、已声明过与 gh-cli 凭证都不改', () => {
    expect(withMekaPsbHostDeclarations(psbAuthorManifest(), null)).toBeNull();
    expect(
      withMekaPsbHostDeclarations(psbAuthorManifest({ hosts: ['api.example.com'] }), MEKA_PSB_TEST_HOST),
    ).toBeNull();
    const already = withMekaPsbHostDeclarations(
      psbAuthorManifest({ hosts: [MEKA_PSB_HOST, MEKA_PSB_TEST_HOST] }),
      MEKA_PSB_TEST_HOST,
    );
    // hosts 已含测试主机 → 只剩 inject.hosts 需要补：仍然是一次有效变更。
    expect(already?.addedHosts).toEqual([]);
    expect(already?.addedInjectHosts).toBe(1);
    // gh-cli 的 inject.hosts 被校验锁死为 api.github.com，补条目会让包校验失败。
    const withGhCli = withMekaPsbHostDeclarations(
      psbAuthorManifest({
        secrets: [
          {
            key: 'gh',
            label: 'GitHub',
            source: 'gh-cli',
            inject: {
              header: 'Authorization',
              format: 'Bearer {value}',
              hosts: ['api.github.com'],
            },
          },
        ],
      }),
      MEKA_PSB_TEST_HOST,
    );
    expect(withGhCli?.manifest.network).toMatchObject({
      secrets: [{ inject: { hosts: ['api.github.com'] } }],
    });
    // 补过一次后再补一次没有新增（幂等，不产生重复条目）。
    const once = withMekaPsbHostDeclarations(psbAuthorManifest(), MEKA_PSB_TEST_HOST)!;
    expect(withMekaPsbHostDeclarations(once.manifest, MEKA_PSB_TEST_HOST)).toBeNull();
  });
});
