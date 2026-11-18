import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { GhostManifest } from '../../../shared/ghost.js';
import {
  ghostManifestDigest,
  PluginMarketLedger,
  type PluginMarketInstallationRecord,
} from '../../plugin-market/ledger.js';
import {
  isConnectionSecretReady,
  isReservedConnectionPluginSlug,
  loadConnectionAudienceResolver,
  type LoadConnectionAudienceResolverOptions,
} from '../connectionAudienceResolver.js';
import { MEKA_PSB_HOST, MEKA_PSB_TEST_HOST } from '../mekaPsbHostOverride.js';

const manifest: GhostManifest = {
  schemaVersion: 2,
  id: 'plugin-a',
  name: 'Plugin A',
  version: '1.0.0',
  kind: 'chip' as const,
  entry: 'index.js',
  network: {
    hosts: ['service-a.x.test'],
    secrets: [
      {
        key: 'cindy_identity',
        label: 'Cindy organization identity',
        source: 'oidc-token' as const,
        inject: {
          header: 'Authorization',
          format: 'Bearer {value}',
          hosts: ['service-a.x.test'],
        },
      },
    ],
  },
};

const identity = {
  membershipId: 'membership-1',
  membershipKind: 'org' as const,
  orgId: 'org-id-1',
  orgSlug: 'org-example',
};

const marketInstallation: PluginMarketInstallationRecord = {
  pluginId: 'plugin-market-1',
  ghostId: manifest.id,
  releaseId: 'release-1',
  version: manifest.version,
  sha256: 'a'.repeat(64),
  scope: 'organization',
  organizationId: identity.orgId,
  source: 'market',
  installed: true,
  updatedAt: '2026-08-04T00:00:00.000Z',
  manifestDigest: ghostManifestDigest(manifest),
  rawManifestSha256: ghostManifestDigest(manifest),
};

function resolverOptions(
  installedManifest: GhostManifest | null = manifest,
  installation: PluginMarketInstallationRecord | null = marketInstallation,
) {
  return {
    readInstalledManifestIdentity: () =>
      installedManifest
        ? {
            manifest: installedManifest,
            rawManifestSha256: ghostManifestDigest(installedManifest),
            legacyManifestDigest: ghostManifestDigest(installedManifest),
            legacyManifestDigests: [ghostManifestDigest(installedManifest)],
          }
        : null,
    readMarketInstallation: () => installation,
  };
}

describe('installed Plugin Connection audience resolver', () => {
  it('names cindy-publisher and xd-publisher as reserved connection slugs', () => {
    expect(isReservedConnectionPluginSlug('cindy-publisher')).toBe(true);
    expect(isReservedConnectionPluginSlug('xd-publisher')).toBe(true);
    expect(isReservedConnectionPluginSlug('cindy-art')).toBe(false);
  });

  it('derives audience and hosts from the installed manifest and current organization', () => {
    const resolver = loadConnectionAudienceResolver({
      ...resolverOptions(),
    });
    expect(resolver.resolve('plugin-a', identity)).toEqual({
      membershipId: 'membership-1',
      audience: 'org-example:plugin-a',
      pluginSlug: 'plugin-a',
      allowedHosts: ['service-a.x.test'],
    });
  });

  /**
   * 测试价值
   * - 生产入口与可观察结果：`loadConnectionAudienceResolver(...).resolve()`（Connection
   *   身份 JWT 的唯一签发资格判定）在启动期 `CINDY_MEKA_PSB_HOST` 生效、且实例 manifest
   *   声明了正式 PSB 主机时，把覆盖主机也列为可注入 host；否则市场安装的 meka-submit
   *   被改道到测试部署后拿不到企业身份 JWT，测试服务按「无凭证」401。
   * - Bug／规则依据：2026-11-18 用户实测——市场安装的 meka-submit 仍打正式 PSB，测试部署
   *   `/capabilities` 404；身份注入必须跟着运行时覆盖走（§4.4）。
   * - 现有覆盖缺口：既有用例全部在「没有覆盖」下断言 `allowedHosts`，没有人证明覆盖开启
   *   时只对声明了正式 PSB 主机的实例放宽、未设置时逐字节不变。
   * - 最小失败输入：覆盖开启 + manifest 只声明正式主机时 `allowedHosts` 仍只有正式主机。
   * - tier：unit（纯函数 + fake 账本/身份读取，无 Electron）。
   */
  it('Meka PSB 主机覆盖：只对声明了正式 PSB 主机的实例把覆盖主机列为可注入 host', () => {
    const psbManifest: GhostManifest = {
      ...manifest,
      network: {
        hosts: [MEKA_PSB_HOST],
        secrets: [
          {
            key: 'cindy_identity',
            label: 'Cindy organization identity',
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
    const resolveHosts = (
      mekaPsbHostOverride: string | null | undefined,
      installed: GhostManifest = psbManifest,
    ) =>
      loadConnectionAudienceResolver({
        ...resolverOptions(installed, {
          ...marketInstallation,
          version: installed.version,
          manifestDigest: ghostManifestDigest(installed),
          rawManifestSha256: ghostManifestDigest(installed),
        }),
        ...(mekaPsbHostOverride === undefined ? {} : { mekaPsbHostOverride }),
      }).resolve('plugin-a', identity)?.allowedHosts;

    // 生产默认（未设置环境变量 / 被白名单拒绝）：allowedHosts 逐字不变。
    expect(resolveHosts(undefined)).toEqual([MEKA_PSB_HOST]);
    expect(resolveHosts(null)).toEqual([MEKA_PSB_HOST]);
    // 开关生效 + manifest 声明正式 PSB 主机 ⇒ 覆盖主机也成为可注入 host。
    expect(resolveHosts(MEKA_PSB_TEST_HOST)).toEqual([MEKA_PSB_HOST, MEKA_PSB_TEST_HOST]);
    // 开关生效但实例没声明正式 PSB 主机：其它插件的注入面不放宽。
    expect(resolveHosts(MEKA_PSB_TEST_HOST, manifest)).toEqual(['service-a.x.test']);
  });

  it('reads the installed manifest and byte identity only once', () => {
    const readInstalledManifestIdentity = vi.fn(
      resolverOptions().readInstalledManifestIdentity,
    );
    const resolver = loadConnectionAudienceResolver({
      ...resolverOptions(),
      readInstalledManifestIdentity,
    });

    expect(resolver.resolve('plugin-a', identity)).not.toBeNull();
    expect(readInstalledManifestIdentity).toHaveBeenCalledTimes(1);
  });

  it('requires a current organization market installation record', () => {
    const resolver = loadConnectionAudienceResolver(
      resolverOptions(manifest, { ...marketInstallation, source: 'local-market' }),
    );
    expect(resolver.resolve('plugin-a', identity)).toBeNull();
    expect(
      loadConnectionAudienceResolver(
        resolverOptions(manifest, { ...marketInstallation, source: 'legacy-adopted' }),
      ).resolve('plugin-a', identity),
    ).toBeNull();

    expect(
      loadConnectionAudienceResolver(
        resolverOptions(manifest, { ...marketInstallation, scope: 'public', organizationId: null }),
      ).resolve('plugin-a', identity),
    ).toBeNull();
    expect(
      loadConnectionAudienceResolver(
        resolverOptions(manifest, { ...marketInstallation, organizationId: 'org-other' }),
      ).resolve('plugin-a', identity),
    ).toBeNull();
    expect(
      loadConnectionAudienceResolver(
        resolverOptions(manifest, {
          ...marketInstallation,
          manifestDigest: undefined,
          rawManifestSha256: undefined,
        }),
      ).resolve('plugin-a', identity),
    ).toBeNull();
  });

  it('does not authorize a root twin through an uninstalled root row and a live organization row', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-connection-identity-'));
    try {
      const ledger = new PluginMarketLedger(path.join(directory, 'ledger.v1.json'));
      ledger.upsertInstallation({ ...marketInstallation, namespace: null, installed: false });
      ledger.upsertInstallation({
        ...marketInstallation,
        pluginId: 'plugin-market-org',
        namespace: identity.orgSlug,
      });
      const options = {
        ...resolverOptions(),
        readMarketInstallation: (id: string) => ledger.lookupInstallationForOidc(id),
        readInstallNamespace: (id: string) =>
          id === 'plugin-a' ? null : identity.orgSlug,
        readApprovedPackageSha256: (id: string) =>
          id === 'plugin-a' ? 'b'.repeat(64) : marketInstallation.sha256,
      };
      expect(ledger.lookupInstallationForOidc('plugin-a')).toMatchObject({
        kind: 'found',
        record: { namespace: identity.orgSlug, installed: true },
      });
      expect(loadConnectionAudienceResolver(options).resolve('plugin-a', identity)).toBeNull();
      expect(loadConnectionAudienceResolver({
        ...options,
        readInstallNamespace: () => undefined,
      }).resolve('plugin-a', identity)).toBeNull();
      expect(loadConnectionAudienceResolver({
        ...options,
        readInstallNamespace: () => 'other-org',
      }).resolve('plugin-a', identity)).toBeNull();
      expect(loadConnectionAudienceResolver({
        ...options,
        readMarketInstallation: () => ({
          kind: 'found' as const,
          record: { ...marketInstallation, namespace: 'other-org' },
        }),
        readInstallNamespace: () => 'other-org',
      }).resolve('plugin-a', identity)).toBeNull();
      expect(loadConnectionAudienceResolver({
        ...options,
        readInstallNamespace: () => { throw new Error('receipt unavailable'); },
      }).resolve('plugin-a', identity)).toBeNull();
      expect(loadConnectionAudienceResolver({
        ...options,
        readMarketInstallation: () => ({
          kind: 'found' as const,
          record: { ...marketInstallation, namespace: null },
        }),
        readInstallNamespace: () => identity.orgSlug,
      }).resolve('plugin-a', identity)).toBeNull();
      expect(loadConnectionAudienceResolver({
        ...options,
        readInstallNamespace: () => identity.orgSlug,
      }).resolve('plugin-a', identity)).toMatchObject({ audience: 'org-example:plugin-a' });
      expect(loadConnectionAudienceResolver(options).resolve('_ns__org-example__plugin-a', identity))
        .toMatchObject({ audience: 'org-example:plugin-a' });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('uses raw manifest bytes when the legacy digest is absent', () => {
    const resolver = loadConnectionAudienceResolver(
      resolverOptions(manifest, { ...marketInstallation, manifestDigest: undefined }),
    );

    expect(resolver.resolve('plugin-a', identity)).not.toBeNull();
  });

  it('rejects a changed installed manifest digest', () => {
    const changedManifest = { ...manifest, version: '2.0.0' };
    const resolver = loadConnectionAudienceResolver(resolverOptions(changedManifest));
    expect(resolver.resolve('plugin-a', identity)).toBeNull();
  });

  it('does not fall back to a matching legacy digest after raw identity mismatches', () => {
    const resolver = loadConnectionAudienceResolver(
      resolverOptions(manifest, {
        ...marketInstallation,
        rawManifestSha256: 'f'.repeat(64),
      }),
    );

    expect(resolver.resolve('plugin-a', identity)).toBeNull();
  });

  it('rejects reserved publisher identity slugs even with a matching market install', () => {
    for (const ghostId of ['cindy-publisher', 'xd-publisher'] as const) {
      const reservedManifest = { ...manifest, id: ghostId };
      const reservedInstallation = {
        ...marketInstallation,
        ghostId,
        manifestDigest: ghostManifestDigest(reservedManifest),
      };
      const resolver = loadConnectionAudienceResolver(
        resolverOptions(reservedManifest, reservedInstallation),
      );
      expect(resolver.resolve(ghostId, identity)).toBeNull();
    }
  });

  it('requires an organization identity and an installed oidc-token declaration', () => {
    const resolver = loadConnectionAudienceResolver({
      ...resolverOptions(),
    });
    expect(
      resolver.resolve('plugin-a', {
        membershipId: 'membership-1',
        membershipKind: 'personal',
        orgId: null,
        orgSlug: null,
      }),
    ).toBeNull();
    expect(resolver.resolve('plugin-b', identity)).toBeNull();
    expect(
      loadConnectionAudienceResolver({
        ...resolverOptions({ ...manifest, network: { hosts: ['service-a.x.test'] } }),
      }).resolve('plugin-a', identity),
    ).toBeNull();
  });

  it('resolves explicit Forge OIDC before a stale or foreign market row', () => {
    const forgeManifest: GhostManifest = { ...manifest, id: 'acme-tool' };
    const resolver = loadConnectionAudienceResolver({
      ...resolverOptions(forgeManifest, {
        ...marketInstallation,
        installed: false,
        organizationId: 'org-other',
      }),
      readInstallOrigin: () => 'agent-forge',
      readApprovedPackageSha256: () => 'a'.repeat(64),
      readInstallNamespace: () => 'org-example',
    });
    expect(resolver.resolve('acme-tool', identity)).toEqual({
      membershipId: 'membership-1',
      audience: 'org-example:acme-tool',
      pluginSlug: 'acme-tool',
      allowedHosts: ['service-a.x.test'],
    });
  });

  it('preserves OIDC for a verified pending legacy Forge receipt in the current organization', () => {
    const forgeManifest: GhostManifest = { ...manifest, id: 'acme-tool' };
    const options = {
      ...resolverOptions(forgeManifest, null),
      readInstallOrigin: () => 'agent-forge' as const,
      readInstallNamespace: () => undefined,
      readApprovedPackageSha256: () => 'a'.repeat(64),
      isPendingLegacyForge: () => true,
      lookupOrganizationPrefix: () => ({ kind: 'known' as const, pluginPrefix: 'acme' }),
    };
    expect(loadConnectionAudienceResolver(options).resolve('acme-tool', identity)).toMatchObject({
      audience: 'org-example:acme-tool',
    });
    expect(loadConnectionAudienceResolver({ ...options, isPendingLegacyForge: () => false })
      .resolve('acme-tool', identity)).toBeNull();
    expect(loadConnectionAudienceResolver({ ...options, lookupOrganizationPrefix: () => ({
      kind: 'known' as const, pluginPrefix: 'other',
    }) }).resolve('acme-tool', identity)).toBeNull();
    expect(loadConnectionAudienceResolver({ ...options, lookupOrganizationPrefix: () => ({
      kind: 'known' as const, pluginPrefix: null,
    }) }).resolve('acme-tool', identity)).toBeNull();
    expect(loadConnectionAudienceResolver({ ...options, readInstallNamespace: () => null })
      .resolve('acme-tool', identity)).toBeNull();
    expect(loadConnectionAudienceResolver({ ...options, lookupOrganizationPrefix: () => ({
      kind: 'unavailable' as const,
    }) }).resolve('acme-tool', identity)).toBeNull();
  });

  it('does not extend Forge OIDC to a manual install or another organization', () => {
    const forgeManifest: GhostManifest = { ...manifest, id: 'helper' };
    for (const options of [
      { readInstallOrigin: () => 'manual' as const, namespace: 'org-example' as string | null },
      { readInstallOrigin: () => 'agent-forge' as const, namespace: 'other' as string | null },
    ]) {
      const resolver = loadConnectionAudienceResolver({
        ...resolverOptions(forgeManifest, null),
        readInstallOrigin: options.readInstallOrigin,
        readApprovedPackageSha256: () => 'a'.repeat(64),
        readInstallNamespace: () => options.namespace,
      });
      expect(resolver.resolve('helper', identity)).toBeNull();
    }
  });

  it('resolves a prefix-free Forge helper bound to the current organization', () => {
    const forgeManifest: GhostManifest = { ...manifest, id: 'helper' };
    const resolver = loadConnectionAudienceResolver({
      ...resolverOptions(forgeManifest, null),
      readInstallOrigin: () => 'agent-forge',
      readApprovedPackageSha256: () => 'a'.repeat(64),
      readInstalledManifestIdentity: (id) =>
        id === '_ns__org-example__helper' || id === 'helper'
          ? {
              manifest: forgeManifest,
              rawManifestSha256: ghostManifestDigest(forgeManifest),
              legacyManifestDigest: ghostManifestDigest(forgeManifest),
              legacyManifestDigests: [ghostManifestDigest(forgeManifest)],
            }
          : null,
    });
    expect(resolver.resolve('_ns__org-example__helper', identity)).toEqual({
      membershipId: 'membership-1',
      audience: 'org-example:helper',
      pluginSlug: 'helper',
      allowedHosts: ['service-a.x.test'],
    });
  });

  it('resolves a root local mivo-canvas install without a market record', () => {
    const localManifest: GhostManifest = {
      ...manifest,
      id: 'mivo-canvas',
      network: {
        hosts: ['mivo-canvas.dsworks.cn'],
        secrets: [
          {
            key: 'cindy_identity',
            label: 'Cindy organization identity',
            source: 'oidc-token' as const,
            inject: {
              header: 'Authorization',
              format: 'Bearer {value}',
              hosts: ['mivo-canvas.dsworks.cn'],
            },
          },
        ],
      },
    };
    const allowed = {
      membershipId: 'membership-1',
      audience: 'org-example:mivo-canvas',
      pluginSlug: 'mivo-canvas',
      allowedHosts: ['mivo-canvas.dsworks.cn'],
    };
    expect(loadConnectionAudienceResolver({
      ...resolverOptions(localManifest, null),
      readInstallOrigin: () => 'manual',
    }).resolve('mivo-canvas', identity)).toEqual(allowed);
    expect(loadConnectionAudienceResolver({
      ...resolverOptions(localManifest, null),
      readMarketInstallation: () => ({ kind: 'absent' }),
      readInstallOrigin: () => 'manual',
      readInstallNamespace: () => null,
    }).resolve('_root__mivo-canvas', identity)).toEqual(allowed);
  });

  it('does not apply the local mivo-canvas exception to an organization instance', () => {
    const localManifest: GhostManifest = {
      ...manifest,
      id: 'mivo-canvas',
      network: {
        hosts: ['mivo-canvas.dsworks.cn'],
        secrets: [
          {
            key: 'cindy_identity',
            label: 'Cindy organization identity',
            source: 'oidc-token' as const,
            inject: {
              header: 'Authorization',
              format: 'Bearer {value}',
              hosts: ['mivo-canvas.dsworks.cn'],
            },
          },
        ],
      },
    };
    for (const instanceId of ['_ns/xd/mivo-canvas', '_ns/acme/mivo-canvas', '_ns__xd__mivo-canvas']) {
      expect(loadConnectionAudienceResolver({
        ...resolverOptions(localManifest, null),
        readInstallOrigin: () => 'manual',
      }).resolve(instanceId, identity)).toBeNull();
    }
    expect(loadConnectionAudienceResolver({
      ...resolverOptions(localManifest, null),
      readInstallOrigin: () => 'manual',
      readInstallNamespace: () => 'xd',
    }).resolve('mivo-canvas', identity)).toBeNull();
  });

  it('does not apply the local mivo-canvas exception to a different plugin id', () => {
    for (const id of ['mivo-canvas2', 'xd-mivo-canvas']) {
      const localManifest: GhostManifest = {
        ...manifest,
        id,
        network: {
          hosts: ['mivo-canvas.dsworks.cn'],
          secrets: [
            {
              key: 'cindy_identity',
              label: 'Cindy organization identity',
              source: 'oidc-token' as const,
              inject: {
                header: 'Authorization',
                format: 'Bearer {value}',
                hosts: ['mivo-canvas.dsworks.cn'],
              },
            },
          ],
        },
      };
      expect(loadConnectionAudienceResolver({
        ...resolverOptions(localManifest, null),
        readInstallOrigin: () => 'manual',
      }).resolve(id, identity)).toBeNull();
    }
  });

  it('does not extend the local mivo-canvas exception past an exact id and org membership', () => {
    const localManifest: GhostManifest = {
      ...manifest,
      id: 'mivo-canvas',
      network: {
        hosts: ['mivo-canvas.dsworks.cn'],
        secrets: [
          {
            key: 'cindy_identity',
            label: 'Cindy organization identity',
            source: 'oidc-token' as const,
            inject: {
              header: 'Authorization',
              format: 'Bearer {value}',
              hosts: ['mivo-canvas.dsworks.cn'],
            },
          },
        ],
      },
    };
    const resolver = loadConnectionAudienceResolver({
      ...resolverOptions(localManifest, null),
      readInstallOrigin: () => 'manual',
    });
    expect(resolver.resolve('plugin-a', identity)).toBeNull();
    expect(resolver.resolve('mivo-canvas-x', identity)).toBeNull();
    expect(resolver.resolve('Mivo-Canvas', identity)).toBeNull();
    expect(
      resolver.resolve('mivo-canvas', {
        membershipId: 'membership-1',
        membershipKind: 'personal',
        orgId: null,
        orgSlug: null,
      }),
    ).toBeNull();
  });

  it('rejects a local mivo-canvas install whose exact oidc host is not the allowlisted host', () => {
    const forgedManifest: GhostManifest = {
      ...manifest,
      id: 'mivo-canvas',
      network: {
        hosts: ['attacker.example.com'],
        secrets: [
          {
            key: 'cindy_identity',
            label: 'Cindy organization identity',
            source: 'oidc-token' as const,
            inject: {
              header: 'Authorization',
              format: 'Bearer {value}',
              hosts: ['attacker.example.com'],
            },
          },
        ],
      },
    };
    const resolver = loadConnectionAudienceResolver({
      ...resolverOptions(forgedManifest, null),
      readInstallOrigin: () => 'manual',
    });
    expect(resolver.resolve('mivo-canvas', identity)).toBeNull();
  });

  it('rejects a local mivo-canvas install that declares an extra exact oidc host', () => {
    const extraHostManifest: GhostManifest = {
      ...manifest,
      id: 'mivo-canvas',
      network: {
        hosts: ['mivo-canvas.dsworks.cn', 'attacker.example.com'],
        secrets: [
          {
            key: 'cindy_identity',
            label: 'Cindy organization identity',
            source: 'oidc-token' as const,
            inject: {
              header: 'Authorization',
              format: 'Bearer {value}',
              hosts: ['mivo-canvas.dsworks.cn', 'attacker.example.com'],
            },
          },
        ],
      },
    };
    const resolver = loadConnectionAudienceResolver({
      ...resolverOptions(extraHostManifest, null),
      readInstallOrigin: () => 'manual',
    });
    expect(resolver.resolve('mivo-canvas', identity)).toBeNull();
  });

  it('rejects a local mivo-canvas install whose oidc host is only a wildcard', () => {
    const wildcardManifest: GhostManifest = {
      ...manifest,
      id: 'mivo-canvas',
      network: {
        hosts: ['*.x.test'],
        secrets: [
          {
            key: 'cindy_identity',
            label: 'Cindy organization identity',
            source: 'oidc-token' as const,
            inject: {
              header: 'Authorization',
              format: 'Bearer {value}',
              hosts: ['*.x.test'],
            },
          },
        ],
      },
    };
    const resolver = loadConnectionAudienceResolver({
      ...resolverOptions(wildcardManifest, null),
      readInstallOrigin: () => 'manual',
    });
    expect(resolver.resolve('mivo-canvas', identity)).toBeNull();
  });

  it('still requires digest match when mivo-canvas has an organization market record', () => {
    const localManifest: GhostManifest = {
      ...manifest,
      id: 'mivo-canvas',
      version: '2.0.0',
      network: {
        hosts: ['mivo-canvas.dsworks.cn'],
        secrets: [
          {
            key: 'cindy_identity',
            label: 'Cindy organization identity',
            source: 'oidc-token' as const,
            inject: {
              header: 'Authorization',
              format: 'Bearer {value}',
              hosts: ['mivo-canvas.dsworks.cn'],
            },
          },
        ],
      },
    };
    const marketRecord: PluginMarketInstallationRecord = {
      ...marketInstallation,
      ghostId: 'mivo-canvas',
      manifestDigest: ghostManifestDigest({ ...localManifest, version: '1.0.0' }),
    };
    const resolver = loadConnectionAudienceResolver(
      resolverOptions(localManifest, marketRecord),
    );
    expect(resolver.resolve('mivo-canvas', identity)).toBeNull();
  });

  it('does not take the local exception when the market ledger is invalid', () => {
    const localManifest: GhostManifest = {
      ...manifest,
      id: 'mivo-canvas',
      network: {
        hosts: ['mivo-canvas.dsworks.cn'],
        secrets: [
          {
            key: 'cindy_identity',
            label: 'Cindy organization identity',
            source: 'oidc-token' as const,
            inject: {
              header: 'Authorization',
              format: 'Bearer {value}',
              hosts: ['mivo-canvas.dsworks.cn'],
            },
          },
        ],
      },
    };
    const resolver = loadConnectionAudienceResolver({
      ...resolverOptions(localManifest, null),
      readMarketInstallation: () => ({ kind: 'invalid' }),
      readInstallOrigin: () => 'manual',
    });
    expect(resolver.resolve('mivo-canvas', identity)).toBeNull();
  });

  it('does not skip digest when a mivo-canvas market record is marked uninstalled', () => {
    const localManifest: GhostManifest = {
      ...manifest,
      id: 'mivo-canvas',
      version: '2.0.0',
      network: {
        hosts: ['mivo-canvas.dsworks.cn'],
        secrets: [
          {
            key: 'cindy_identity',
            label: 'Cindy organization identity',
            source: 'oidc-token' as const,
            inject: {
              header: 'Authorization',
              format: 'Bearer {value}',
              hosts: ['mivo-canvas.dsworks.cn'],
            },
          },
        ],
      },
    };
    const marketRecord: PluginMarketInstallationRecord = {
      ...marketInstallation,
      ghostId: 'mivo-canvas',
      installed: false,
      manifestDigest: ghostManifestDigest({ ...localManifest, version: '1.0.0' }),
    };
    const resolver = loadConnectionAudienceResolver(
      resolverOptions(localManifest, marketRecord),
    );
    expect(resolver.resolve('mivo-canvas', identity)).toBeNull();
  });

  it('resolves a namespaced instance id to the plugin slug audience', () => {
    const readInstalledManifestIdentity = vi.fn((id: string) =>
      id === '_ns__org-example__plugin-a'
        ? {
            manifest,
            rawManifestSha256: ghostManifestDigest(manifest),
            legacyManifestDigest: ghostManifestDigest(manifest),
            legacyManifestDigests: [ghostManifestDigest(manifest)],
          }
        : null,
    );
    const readMarketInstallation = vi.fn((id: string) =>
      id === '_ns__org-example__plugin-a'
        ? { kind: 'found' as const, record: { ...marketInstallation, namespace: 'org-example' } }
        : { kind: 'absent' as const },
    );
    const readInstallOrigin = vi.fn(() => 'manual' as const);
    const resolver = loadConnectionAudienceResolver({
      readInstalledManifestIdentity,
      readMarketInstallation,
      readInstallOrigin,
      readInstallNamespace: () => 'org-example',
    });
    expect(resolver.resolve('_ns__org-example__plugin-a', identity)).toEqual({
      membershipId: 'membership-1',
      audience: 'org-example:plugin-a',
      pluginSlug: 'plugin-a',
      allowedHosts: ['service-a.x.test'],
    });
    expect(readInstalledManifestIdentity).toHaveBeenCalledWith('_ns__org-example__plugin-a');
    expect(readMarketInstallation).toHaveBeenCalledWith('_ns__org-example__plugin-a');
    expect(readInstallOrigin).toHaveBeenCalledWith('_ns__org-example__plugin-a');
  });

  it('resolves a pending legacy xd-mivo-canvas after the market row gains namespace xd', () => {
    const canvasManifest: GhostManifest = { ...manifest, id: 'xd-mivo-canvas' };
    const xdIdentity = { ...identity, orgId: 'org-xd', orgSlug: 'xd' };
    const record: PluginMarketInstallationRecord = {
      ...marketInstallation,
      pluginId: 'cb163dbadea776c1b9ce9be38',
      ghostId: 'xd-mivo-canvas',
      organizationId: 'org-xd',
      namespace: 'xd',
      manifestDigest: ghostManifestDigest(canvasManifest),
      rawManifestSha256: ghostManifestDigest(canvasManifest),
    };
    const resolver = loadConnectionAudienceResolver({
      ...resolverOptions(canvasManifest, record),
      readInstallNamespace: () => undefined,
      isPendingLegacyNamespace: () => true,
    });
    expect(resolver.resolve('xd-mivo-canvas', xdIdentity)).toEqual({
      membershipId: 'membership-1',
      audience: 'xd:xd-mivo-canvas',
      pluginSlug: 'xd-mivo-canvas',
      allowedHosts: ['service-a.x.test'],
    });
  });


  it('resolves xd-mivo-canvas after the pending install is confirmed in place', () => {
    const canvasManifest: GhostManifest = { ...manifest, id: 'xd-mivo-canvas' };
    const xdIdentity = { ...identity, orgId: 'org-xd', orgSlug: 'xd' };
    const record: PluginMarketInstallationRecord = {
      ...marketInstallation,
      pluginId: 'cb163dbadea776c1b9ce9be38',
      ghostId: 'xd-mivo-canvas',
      organizationId: 'org-xd',
      namespace: 'xd',
      manifestDigest: ghostManifestDigest(canvasManifest),
      rawManifestSha256: ghostManifestDigest(canvasManifest),
    };
    expect(loadConnectionAudienceResolver({
      ...resolverOptions(canvasManifest, record),
      readInstallNamespace: () => 'xd',
    }).resolve('xd-mivo-canvas', xdIdentity)).toMatchObject({ audience: 'xd:xd-mivo-canvas' });
  });

  it('resolves a newly installed namespaced xd-mivo-canvas', () => {
    const canvasManifest: GhostManifest = { ...manifest, id: 'xd-mivo-canvas' };
    const xdIdentity = { ...identity, orgId: 'org-xd', orgSlug: 'xd' };
    const record: PluginMarketInstallationRecord = {
      ...marketInstallation,
      pluginId: 'cb163dbadea776c1b9ce9be38',
      ghostId: 'xd-mivo-canvas',
      organizationId: 'org-xd',
      namespace: 'xd',
      manifestDigest: ghostManifestDigest(canvasManifest),
      rawManifestSha256: ghostManifestDigest(canvasManifest),
    };
    expect(loadConnectionAudienceResolver({
      ...resolverOptions(canvasManifest, record),
      readInstallNamespace: () => 'xd',
    }).resolve('_ns__xd__xd-mivo-canvas', xdIdentity)).toMatchObject({
      audience: 'xd:xd-mivo-canvas',
      pluginSlug: 'xd-mivo-canvas',
    });
  });

  it('rejects a pending legacy install whose catalog namespace is another org', () => {
    const canvasManifest: GhostManifest = { ...manifest, id: 'xd-mivo-canvas' };
    const xdIdentity = { ...identity, orgId: 'org-xd', orgSlug: 'xd' };
    const record: PluginMarketInstallationRecord = {
      ...marketInstallation,
      ghostId: 'xd-mivo-canvas',
      organizationId: 'org-xd',
      namespace: 'other-org',
      manifestDigest: ghostManifestDigest(canvasManifest),
      rawManifestSha256: ghostManifestDigest(canvasManifest),
    };
    expect(loadConnectionAudienceResolver({
      ...resolverOptions(canvasManifest, record),
      readInstallNamespace: () => undefined,
      isPendingLegacyNamespace: () => true,
    }).resolve('xd-mivo-canvas', xdIdentity)).toBeNull();
  });

  it('rejects a pending legacy install for a different organization id', () => {
    const canvasManifest: GhostManifest = { ...manifest, id: 'xd-mivo-canvas' };
    const xdIdentity = { ...identity, orgId: 'org-xd', orgSlug: 'xd' };
    const record: PluginMarketInstallationRecord = {
      ...marketInstallation,
      ghostId: 'xd-mivo-canvas',
      organizationId: 'org-other',
      namespace: 'xd',
      manifestDigest: ghostManifestDigest(canvasManifest),
      rawManifestSha256: ghostManifestDigest(canvasManifest),
    };
    expect(loadConnectionAudienceResolver({
      ...resolverOptions(canvasManifest, record),
      readInstallNamespace: () => undefined,
      isPendingLegacyNamespace: () => true,
    }).resolve('xd-mivo-canvas', xdIdentity)).toBeNull();
  });

  it('does not authorize an unconfirmed install just because the catalog namespace was backfilled', () => {
    const canvasManifest: GhostManifest = { ...manifest, id: 'xd-mivo-canvas' };
    const xdIdentity = { ...identity, orgId: 'org-xd', orgSlug: 'xd' };
    const record: PluginMarketInstallationRecord = {
      ...marketInstallation,
      ghostId: 'xd-mivo-canvas',
      organizationId: 'org-xd',
      namespace: 'xd',
      manifestDigest: ghostManifestDigest(canvasManifest),
      rawManifestSha256: ghostManifestDigest(canvasManifest),
    };
    expect(loadConnectionAudienceResolver({
      ...resolverOptions(canvasManifest, record),
      readInstallNamespace: () => undefined,
      isPendingLegacyNamespace: () => false,
    }).resolve('xd-mivo-canvas', xdIdentity)).toBeNull();
  });

  it('resolves a local mivo-canvas and a pending xd-mivo-canvas independently', () => {
    const localManifest: GhostManifest = {
      ...manifest,
      id: 'mivo-canvas',
      network: {
        hosts: ['mivo-canvas.dsworks.cn'],
        secrets: [{
          key: 'cindy_identity',
          label: 'Cindy organization identity',
          source: 'oidc-token' as const,
          inject: {
            header: 'Authorization',
            format: 'Bearer {value}',
            hosts: ['mivo-canvas.dsworks.cn'],
          },
        }],
      },
    };
    const canvasManifest: GhostManifest = { ...manifest, id: 'xd-mivo-canvas' };
    const xdIdentity = { ...identity, orgId: 'org-xd', orgSlug: 'xd' };
    const record: PluginMarketInstallationRecord = {
      ...marketInstallation,
      pluginId: 'cb163dbadea776c1b9ce9be38',
      ghostId: 'xd-mivo-canvas',
      organizationId: 'org-xd',
      namespace: 'xd',
      manifestDigest: ghostManifestDigest(canvasManifest),
      rawManifestSha256: ghostManifestDigest(canvasManifest),
    };
    const resolver = loadConnectionAudienceResolver({
      readInstalledManifestIdentity: (id: string) => {
        const chosen = id === 'mivo-canvas' ? localManifest : canvasManifest;
        return {
          manifest: chosen,
          rawManifestSha256: ghostManifestDigest(chosen),
          legacyManifestDigest: ghostManifestDigest(chosen),
          legacyManifestDigests: [ghostManifestDigest(chosen)],
        };
      },
      readMarketInstallation: (id: string) => (id === 'mivo-canvas' ? null : record),
      readInstallOrigin: () => 'manual',
      readInstallNamespace: () => undefined,
      isPendingLegacyNamespace: (id: string) => id !== 'mivo-canvas',
    });
    expect(resolver.resolve('mivo-canvas', xdIdentity)).toMatchObject({
      audience: 'xd:mivo-canvas',
      pluginSlug: 'mivo-canvas',
    });
    expect(resolver.resolve('xd-mivo-canvas', xdIdentity)).toMatchObject({
      audience: 'xd:xd-mivo-canvas',
      pluginSlug: 'xd-mivo-canvas',
    });
  });

  it('requires the managed secret target to match a declared exact host', () => {
    const resolver = loadConnectionAudienceResolver({
      ...resolverOptions(),
    });
    const resolution = resolver.resolve('plugin-a', identity);
    expect(isConnectionSecretReady(['service-a.x.test'], resolution)).toBe(true);
    expect(isConnectionSecretReady(['service-b.x.test'], resolution)).toBe(false);
    expect(isConnectionSecretReady(['service-a.x.test'], null)).toBe(false);
  });
});


/**
 * Meka 内部渠道基座：Meka 市场安装只写自己的账本（`meka-ledger.v1.json`），可见性
 * 只会投影成 personal / public，所以 organization scope 那条门永远过不了。这里钉住
 * 新的第三条基座与它的 fail-closed 边界，同时证明它不替代、不削弱既有两条基座。
 */
describe('Meka internal channel Connection basis', () => {
  const mekaRecord: PluginMarketInstallationRecord = {
    ...marketInstallation,
    scope: 'public',
    organizationId: null,
    namespace: null,
    source: 'market',
    installed: true,
  };

  function mekaOptions(overrides: Record<string, unknown> = {}) {
    return {
      readInstalledManifestIdentity: resolverOptions().readInstalledManifestIdentity,
      readMarketInstallation: () => ({ kind: 'absent' as const }),
      readMekaMarketInstallation: () => ({ kind: 'found' as const, record: mekaRecord }),
      readApprovedPackageSha256: () => 'b'.repeat(64),
      ...overrides,
    };
  }

  function warnReasons(options: Record<string, unknown>): string[] {
    const warn = vi.fn();
    loadConnectionAudienceResolver({
      ...(options as unknown as LoadConnectionAudienceResolverOptions),
      log: { info: () => {}, warn },
    }).resolve('plugin-a', identity);
    return warn.mock.calls.map(([, meta]) => (meta as { reason?: string }).reason ?? '');
  }

  it('resolves a public Meka-market install for the current organization membership', () => {
    expect(loadConnectionAudienceResolver(mekaOptions()).resolve('plugin-a', identity)).toEqual({
      membershipId: 'membership-1',
      audience: 'org-example:plugin-a',
      pluginSlug: 'plugin-a',
      allowedHosts: ['service-a.x.test'],
    });
  });

  it('keeps the organization-membership gate: a personal account never signs', () => {
    expect(
      loadConnectionAudienceResolver(mekaOptions()).resolve('plugin-a', {
        membershipId: 'membership-1',
        membershipKind: 'personal',
        orgId: null,
        orgSlug: null,
      }),
    ).toBeNull();
  });

  it('does not treat a local .cindy channel attribution as a Meka market install', () => {
    // 本地 `.cindy` 渠道归属记在 `channels.v1.json`（channelLedger），不是 Meka 市场
    // 账本；resolver 不读它，因此只有渠道归属时不签发（用错依据就会在这里变红）。
    const resolver = loadConnectionAudienceResolver(
      mekaOptions({
        readMekaMarketInstallation: undefined,
        isTrustedBundledGhostId: () => false,
      }),
    );
    expect(resolver.resolve('plugin-a', identity)).toBeNull();
  });

  it('resolves a Host-trusted bundled seed only for a root instance', () => {
    expect(
      loadConnectionAudienceResolver(
        mekaOptions({
          readMekaMarketInstallation: () => ({ kind: 'absent' as const }),
          isTrustedBundledGhostId: (id: string) => id === 'plugin-a',
        }),
      ).resolve('plugin-a', identity),
    ).toMatchObject({ audience: 'org-example:plugin-a' });
    // 随包种子按**逻辑插件 id** 判定：物理实例键 `_root__<id>` 也要命中同一颗种子。
    expect(
      loadConnectionAudienceResolver(
        mekaOptions({
          readMekaMarketInstallation: () => ({ kind: 'absent' as const }),
          isTrustedBundledGhostId: (id: string) => id === 'plugin-a',
        }),
      ).resolve('_root__plugin-a', identity),
    ).toMatchObject({ audience: 'org-example:plugin-a' });
    expect(
      loadConnectionAudienceResolver(
        mekaOptions({
          readMekaMarketInstallation: () => ({ kind: 'absent' as const }),
          isTrustedBundledGhostId: (id: string) => id === 'other-plugin',
        }),
      ).resolve('plugin-a', identity),
    ).toBeNull();
    // `GhostManager` 的 builtin 标记要求 namespace === null；带组织 namespace 的同名
    // 实例不是随包种子，不得借种子分支签发（否则将来恢复随包种子后会出现越权）。
    for (const ghostId of ['_ns/acme/plugin-a', '_ns__acme__plugin-a']) {
      expect(
        loadConnectionAudienceResolver(
          mekaOptions({
            readMekaMarketInstallation: () => ({ kind: 'absent' as const }),
            isTrustedBundledGhostId: (id: string) => id === 'plugin-a',
          }),
        ).resolve(ghostId, identity),
      ).toBeNull();
    }
  });

  it('requires the Meka ledger record to match the installed manifest identity', () => {
    // 账本记录带 `rawManifestSha256` 时按精确字节比对：本地替换过 manifest、记录过期
    // 但 installed:true 的状态不得签发。
    expect(
      loadConnectionAudienceResolver(
        mekaOptions({
          readMekaMarketInstallation: () => ({
            kind: 'found' as const,
            record: { ...mekaRecord, rawManifestSha256: 'f'.repeat(64) },
          }),
        }),
      ).resolve('plugin-a', identity),
    ).toBeNull();
    // 只带 `manifestDigest` 的旧记录仍走 released 客户端的 legacy 摘要兼容路径。
    expect(
      loadConnectionAudienceResolver(
        mekaOptions({
          readMekaMarketInstallation: () => ({
            kind: 'found' as const,
            record: {
              ...mekaRecord,
              rawManifestSha256: undefined,
              manifestDigest: ghostManifestDigest(manifest),
            },
          }),
        }),
      ).resolve('plugin-a', identity),
    ).toMatchObject({ audience: 'org-example:plugin-a' });
    // 两个摘要字段都缺的旧记录不得静默放行（必须留下可排查的原因）。
    expect(
      loadConnectionAudienceResolver(
        mekaOptions({
          readMekaMarketInstallation: () => ({
            kind: 'found' as const,
            record: { ...mekaRecord, rawManifestSha256: undefined, manifestDigest: undefined },
          }),
        }),
      ).resolve('plugin-a', identity),
    ).toBeNull();
  });

  it('rejects non-market or namespaced records leaked through the shared sidecars', () => {
    // Meka 主账本与 Cindy 主账本不合并，但 custom / ns sidecar 由主账本 dirname 派生
    // 而共用（已知边界，见 ledger.ts）。另一渠道的自定义来源与组织 namespace 记录
    // 可以被读侧合并视图带出来，它们不构成 Meka 内部渠道资格。
    for (const record of [
      { ...mekaRecord, source: 'local-market' as const },
      { ...mekaRecord, source: 'git-market' as const },
      { ...mekaRecord, namespace: 'acme' },
    ]) {
      expect(
        loadConnectionAudienceResolver(
          mekaOptions({
            readMekaMarketInstallation: () => ({ kind: 'found' as const, record }),
          }),
        ).resolve('plugin-a', identity),
      ).toBeNull();
    }
  });

  it('rejects a missing or malformed approved package digest on the Meka basis', () => {
    for (const sha of [null, '', 'not-a-digest', 'a'.repeat(63)]) {
      expect(
        loadConnectionAudienceResolver(
          mekaOptions({ readApprovedPackageSha256: () => sha }),
        ).resolve('plugin-a', identity),
      ).toBeNull();
    }
  });

  it('fails closed when the Meka ledger is invalid, unreadable, or not installed', () => {
    expect(
      loadConnectionAudienceResolver(
        mekaOptions({ readMekaMarketInstallation: () => ({ kind: 'invalid' as const }) }),
      ).resolve('plugin-a', identity),
    ).toBeNull();
    expect(
      loadConnectionAudienceResolver(
        mekaOptions({
          readMekaMarketInstallation: () => {
            throw new Error('meka ledger unreadable');
          },
        }),
      ).resolve('plugin-a', identity),
    ).toBeNull();
    expect(
      loadConnectionAudienceResolver(
        mekaOptions({
          readMekaMarketInstallation: () => ({
            kind: 'found' as const,
            record: { ...mekaRecord, installed: false },
          }),
        }),
      ).resolve('plugin-a', identity),
    ).toBeNull();
  });

  it('never falls into the Meka basis when the Cindy ledger resolved a record', () => {
    // Cindy 账本损坏：必须在旧口径直接 reject，不得把「损坏」当成「无记录」后落到
    // Meka 基座（那会让 fail-closed 失效）。
    expect(warnReasons(mekaOptions({
      readMarketInstallation: () => ({ kind: 'invalid' as const }),
    }))).toEqual(['market-installation-invalid']);
    // Cindy 账本有记录（public / personal 不会满足组织口径）：结果与拒绝原因必须由
    // Cindy 那套判据决定，不得改由 Meka 基座签发。
    expect(warnReasons(mekaOptions({
      readMarketInstallation: () => ({
        kind: 'found' as const,
        record: { ...mekaRecord, scope: 'public' as const },
      }),
    }))).toEqual(['market-installation-not-organization']);
  });

  it('does not append a generic reject log after a decided Meka rejection', () => {
    // P2-4：`null`（已判定拒绝）与 `undefined`（不是 Meka 来源）必须区分，否则真实
    // 原因后面必然再跟一条 `market-installation-missing`，排查会被误导。
    expect(warnReasons(mekaOptions({
      readMekaMarketInstallation: () => ({
        kind: 'found' as const,
        record: { ...mekaRecord, installed: false },
      }),
    }))).toEqual(['meka-market-installation-missing']);
    // 不是 Meka 来源时仍保留原有通用原因，且只有一条。
    expect(warnReasons(mekaOptions({
      readMekaMarketInstallation: () => ({ kind: 'absent' as const }),
    }))).toEqual(['market-installation-missing']);
  });
});


it.each(['manual', 'agent-forge'] as const)('never signs enterprise OIDC for a local development copy (%s)', origin => {
  const resolver = loadConnectionAudienceResolver({
    ...resolverOptions(manifest, null), readInstallOrigin: () => origin,
    readApprovedPackageSha256: () => 'a'.repeat(64), readInstallNamespace: () => 'local',
  });
  expect(resolver.resolve('_ns__local__plugin-a', identity)).toBeNull();
});
