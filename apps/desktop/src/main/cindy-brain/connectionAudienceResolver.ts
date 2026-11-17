/**
 * Host-owned Connection audience resolution. Explicit Forge installs for the
 * current organization and intact organization-market installs are the two
 * dynamic bases. A third base covers the Meka internal distribution channel:
 * installs from the MCPRouter Meka registry land in their own market ledger
 * (`meka-ledger.v1.json`) with `personal` / `public` scope, so they can never
 * satisfy the organization-scope basis; they resolve when the current identity
 * is an organization membership, the ghost is recorded installed in the Meka
 * market ledger (or is a Host-trusted bundled seed id of a root instance), an
 * approved package digest exists, and the installed manifest declares an exact
 * oidc-token host. A recorded install must also match the currently installed
 * ghost.json identity (`verifyInstalledMarketManifest`); a record without that
 * identity is rejected instead of being trusted. A corrupted Meka ledger is a
 * hard failure, not an absent record. The Cindy channel itself keeps the
 * organization-only rule.
 * A temporary local-install exception exists only for root
 * ghostId `mivo-canvas`: organization members may resolve after the org gate
 * when the installed manifest's exact oidc-token host is only
 * `mivo-canvas.dsworks.cn` and the instance namespace is null or not yet
 * recorded. Organization installs such as `_ns/xd/mivo-canvas` are excluded.
 * Delete it after the XD enterprise-market build and the one-time data
 * migration ship. An intact organization market record, including
 * installed:false, still takes the digest path and must not skip via this
 * exception. A present but invalid market ledger is a hard failure, not an
 * absent record. The Host derives the audience from current identity + plugin id.
 */
import { isValidGhostId, isValidGhostNetworkHostPattern } from '../../shared/ghost.js';
import type { GhostManifest } from '../../shared/ghost.js';
import { hasDeliveryNamespace, parsePluginInstanceId } from '../../shared/pluginIdentity.js';
import type { PluginMarketInstallationRecord } from '../plugin-market/ledger.js';
import { matchesPendingLegacyForge } from './ghostFirstPartyPrivilege.js';
import {
  verifyInstalledMarketManifest,
  type InstalledMarketManifestIdentity,
} from '../plugin-market/installedManifestIdentity.js';
import { PLUGIN_MEMBER_PUBLISHER_GHOST_ID } from '../plugin-publisher/types.js';

export interface ConnectionAudienceIdentity {
  membershipId: string;
  membershipKind: 'personal' | 'org';
  orgId: string | null;
  orgSlug: string | null;
}

export interface ConnectionAudienceResolution {
  membershipId: string;
  audience: string;
  pluginSlug: string;
  allowedHosts: readonly string[];
}

export interface ConnectionAudienceResolver {
  resolve(
    ghostId: string,
    identity: ConnectionAudienceIdentity,
  ): ConnectionAudienceResolution | null;
}

const ORG_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const PLUGIN_SLUG_RE = /^[a-z][a-z0-9-]{0,31}$/;
/**
 * Temporary root-only exception for the locally imported mivo-canvas.
 * Delete it after the XD enterprise-market build ships and the follow-up
 * one-time Library/KV migration is released.
 */
const LOCAL_OIDC_ALLOWLIST_GHOST_ID = 'mivo-canvas';
/** Local exception may inject the org JWT only to this exact host. */
const LOCAL_OIDC_ALLOWLIST_HOST = 'mivo-canvas.dsworks.cn';

/**
 * Host-owned Connection audiences that plugins must never mint.
 * `cindy-publisher` is the member-upload publisher identity; `xd-publisher`
 * is the retired slug kept as defense in depth after the rename.
 */
export const RESERVED_CONNECTION_PLUGIN_SLUGS = Object.freeze([
  PLUGIN_MEMBER_PUBLISHER_GHOST_ID,
  'xd-publisher',
] as const);

export function isReservedConnectionPluginSlug(ghostId: string): boolean {
  return (RESERVED_CONNECTION_PLUGIN_SLUGS as readonly string[]).includes(ghostId);
}

/** A managed secret is ready only when its exact injection host is declared. */
export function isConnectionSecretReady(
  injectHosts: readonly string[],
  resolution: ConnectionAudienceResolution | null,
): boolean {
  return resolution !== null && injectHosts.some((host) => resolution.allowedHosts.includes(host));
}

/** Exact non-wildcard hosts declared for Host-injected Connection JWTs. */
export function declaredOidcTokenHosts(manifest: GhostManifest): string[] {
  return [
    ...new Set(
      (manifest.network?.secrets ?? [])
        .filter((secret) => secret.source === 'oidc-token')
        .flatMap((secret) => secret.inject.hosts ?? [])
        .filter((host) => isValidGhostNetworkHostPattern(host) && !host.startsWith('*.')),
    ),
  ];
}

export type MarketInstallationLookup =
  | { kind: 'absent' }
  | { kind: 'found'; record: PluginMarketInstallationRecord }
  | { kind: 'invalid' };

export interface LoadConnectionAudienceResolverOptions {
  /** Manifest and byte identity from one bounded read of the installed ghost.json. */
  readInstalledManifestIdentity(ghostId: string): InstalledMarketManifestIdentity | null;
  readMarketInstallation(
    ghostId: string,
  ): PluginMarketInstallationRecord | MarketInstallationLookup | null;
  /**
   * Meka 渠道的独立账本查询（`meka-ledger.v1.json`）。缺省表示 Host 没有装配该来源，
   * 此时不签发；抛错按不满足处理（fail-closed）。
   */
  readMekaMarketInstallation?(ghostId: string): MarketInstallationLookup | null;
  /** Host 已知的可信随包种子 id（与 provisioning 用同一判据）；抛错按不满足处理。 */
  isTrustedBundledGhostId?(id: string): boolean;
  readApprovedPackageSha256?(ghostId: string): string | null;
  readInstallOrigin?(ghostId: string): 'manual' | 'agent-forge';
  /** Trusted receipt namespace. undefined means no delivery field. */
  readInstallNamespace?(ghostId: string): string | null | undefined;
  /** See ghostFirstPartyFacts. Path fallback is only legal for unknown. */
  readNamespaceState?(ghostId: string): 'confirmed' | 'pending' | 'unconfirmed' | 'unknown';
  /** Upgrade-census root install still running under the pre-namespace rules. */
  isPendingLegacyNamespace?(ghostId: string): boolean;
  isPendingLegacyForge?(ghostId: string): boolean;
  lookupOrganizationPrefix?(
    orgId: string,
  ): { kind: 'known'; pluginPrefix: string | null } | { kind: 'absent' } | { kind: 'unavailable' };
  log?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

export function loadConnectionAudienceResolver(
  options: LoadConnectionAudienceResolverOptions,
): ConnectionAudienceResolver {
  return {
    resolve(ghostId, identity) {
      const pluginSlug = parsePluginInstanceId(ghostId)?.ghostId ?? ghostId;
      const reject = (reason: string): null => {
        options.log?.warn('ghost Connection audience resolution rejected', {
          ghostId,
          pluginSlug,
          reason,
        });
        return null;
      };
      if (!isValidGhostId(pluginSlug) || !PLUGIN_SLUG_RE.test(pluginSlug)) {
        return reject('plugin-id-invalid');
      }
      if (isReservedConnectionPluginSlug(pluginSlug)) {
        return reject('plugin-id-reserved');
      }
      if (identity.membershipKind !== 'org') return reject('membership-not-org');
      if (!identity.membershipId) return reject('membership-id-empty');
      if (!identity.orgId) return reject('org-id-unavailable');
      if (!identity.orgSlug || !ORG_SLUG_RE.test(identity.orgSlug)) {
        return reject('org-slug-unavailable');
      }

      const finish = (manifest: GhostManifest): ConnectionAudienceResolution | null => {
        const allowedHosts = declaredOidcTokenHosts(manifest);
        if (allowedHosts.length === 0) return reject('oidc-host-declaration-missing');
        const audience = `${identity.orgSlug}:${pluginSlug}`;
        if (audience.length > 64) return reject('audience-too-long');
        options.log?.info('ghost Connection audience resolved', {
          ghostId,
          pluginSlug,
          allowedHostCount: allowedHosts.length,
        });
        return {
          membershipId: identity.membershipId,
          audience,
          pluginSlug,
          allowedHosts,
        };
      };

      const readManifestIdentity = (): InstalledMarketManifestIdentity | null => {
        try {
          return options.readInstalledManifestIdentity(ghostId);
        } catch {
          return null;
        }
      };

      // 显式 ghost_forge_install 的企业作者自测分支，同时兼容升级前已有的
      // agent-forge receipt。资格绑定当前组织身份，不再要求旧认领前缀。
      const forgeOrigin = options.readInstallOrigin?.(ghostId);
      if (forgeOrigin === 'agent-forge') {
        const namespaceState = options.readNamespaceState?.(ghostId);
        if (namespaceState === 'unconfirmed') return reject('installed-namespace-unconfirmed');
        const parsedNamespace = parsePluginInstanceId(ghostId)?.namespace ?? null;
        const recordedNamespace = options.readInstallNamespace?.(ghostId);
        const namespace = recordedNamespace !== undefined ? recordedNamespace : parsedNamespace;
        let pendingLegacyForCurrentOrg = false;
        if (recordedNamespace === undefined && parsedNamespace === null) {
          try {
            const prefix = options.lookupOrganizationPrefix?.(identity.orgId);
            pendingLegacyForCurrentOrg = prefix?.kind === 'known' && matchesPendingLegacyForge(
              pluginSlug,
              namespace,
              options.isPendingLegacyForge?.(ghostId) === true,
              prefix.pluginPrefix,
            );
          } catch {
            pendingLegacyForCurrentOrg = false;
          }
        }
        if (identity.orgSlug && (namespace === identity.orgSlug || pendingLegacyForCurrentOrg)) {
          const approvedSha = options.readApprovedPackageSha256?.(ghostId) ?? null;
          if (!approvedSha || !/^[a-f0-9]{64}$/.test(approvedSha)) {
            return reject('forge-package-sha-missing');
          }
          const identitySnapshot = readManifestIdentity();
          if (!identitySnapshot) return reject('plugin-not-installed');
          if (identitySnapshot.manifest.id !== pluginSlug) return reject('plugin-id-mismatch');
          return finish(identitySnapshot.manifest);
        }
      }

      const temporaryRootMivoCanvas = (): boolean => {
        if (pluginSlug !== LOCAL_OIDC_ALLOWLIST_GHOST_ID) return false;
        const parsed = parsePluginInstanceId(ghostId);
        if (!parsed || parsed.namespace !== null) return false;
        let recordedNamespace: string | null | undefined;
        try {
          recordedNamespace = options.readInstallNamespace?.(ghostId);
        } catch {
          return false;
        }
        return recordedNamespace === undefined || recordedNamespace === null;
      };

      /**
       * Meka 内部渠道基座。Meka 市场安装只写自己的账本（`meka-ledger.v1.json`），
       * 可见性只会投影成 `personal` / `public`，因此永远过不了 organization scope
       * 那道门。只在 Cindy 账本完全没有记录时生效——组织 Market / agent-forge /
       * mivo-canvas 三条既有判据的优先级与结果不变。账本损坏必须 reject，不得当成
       * 「无记录」；读取器抛错同样按不满足处理。
       *
       * 返回值三态：`undefined` = 不是 Meka 内部渠道来源，交回调用方保持原有
       * `market-installation-missing` 口径；`null` = 已判定并拒绝（原因已在下面记录，
       * 调用方不得再追加一条通用 reject）；对象 = 签发资格成立。
       *
       * 记录非空时必须与当前已装 manifest 的摘要对得上（`verifyInstalledMarketManifest`）：
       * 本地替换过字节、账本记录过期但 `installed:true` 的状态不得借这条基座放行。
       * 连摘要字段都没有的旧记录显式拒绝并留下原因，不得静默放行。
       */
      const resolveMekaChannelInstall = (): ConnectionAudienceResolution | null | undefined => {
        let record: PluginMarketInstallationRecord | null = null;
        if (options.readMekaMarketInstallation) {
          let lookup: MarketInstallationLookup | null;
          try {
            lookup = options.readMekaMarketInstallation(ghostId);
          } catch {
            return reject('meka-market-installation-read-failed');
          }
          if (lookup?.kind === 'invalid') return reject('meka-market-installation-invalid');
          if (lookup?.kind === 'found') record = lookup.record;
        }
        // 随包种子只存在于 root namespace：`GhostManager` 打 builtin 标记时同样要求
        // namespace 为 null。组织 namespace 下的同名实例（`_ns/<org>/<id>`）不是随包
        // 种子，不得借这条分支签发。
        const instance = parsePluginInstanceId(ghostId);
        const rootNamespace = instance !== null && instance.namespace === null;
        let bundled = false;
        if (rootNamespace && options.isTrustedBundledGhostId) {
          try {
            // 随包种子按**逻辑插件 id** 登记（与 provisioning / 随包批准入口一致），
            // 不能用可能带 `_root__` / `_ns__` 前缀的物理实例 id。
            bundled = options.isTrustedBundledGhostId(pluginSlug) === true;
          } catch {
            bundled = false;
          }
        }
        // 既不在 Meka 账本里、也不是可信随包种子：不是 Meka 内部渠道来源，交回调用方
        // 保持原有 `market-installation-missing` 口径。
        if (!bundled && record === null) return undefined;
        if (record !== null) {
          if (!record.installed) return reject('meka-market-installation-missing');
          if (record.ghostId !== pluginSlug) {
            return reject('meka-market-installation-ghost-mismatch');
          }
          // 只认 Meka 市场安装记录。`ledger.ts` 的 custom / ns sidecar 由主账本
          // dirname 派生——`meka-ledger.v1.json` 与 `ledger.v1.json` 同目录 ⇒ 两个
          // 渠道实际共用 `custom-ledger.v1.json` / `ns-ledger.v1.json`，读侧合并视图
          // 里会出现另一渠道的自定义来源或组织 namespace 记录。它们不构成 Meka 内部
          // 渠道资格（改文件名会丢存量数据，不在这里动；边界见
          // `docs/dev-rules/plugin-distribution-and-version-compat.md` §3.2）。
          if (record.source !== 'market') {
            return reject('meka-market-installation-untrusted');
          }
          if (hasDeliveryNamespace(record) && record.namespace !== null) {
            return reject('meka-market-installation-namespace-unsupported');
          }
        }
        let approvedSha: string | null;
        try {
          approvedSha = options.readApprovedPackageSha256?.(ghostId) ?? null;
        } catch {
          return reject('meka-package-sha-unavailable');
        }
        if (!approvedSha || !/^[a-f0-9]{64}$/.test(approvedSha)) {
          return reject('meka-package-sha-missing');
        }
        const installed = readManifestIdentity();
        if (!installed) return reject('plugin-not-installed');
        if (installed.manifest.id !== pluginSlug) return reject('plugin-id-mismatch');
        if (record !== null) {
          if (record.rawManifestSha256 === undefined && record.manifestDigest === undefined) {
            return reject('meka-market-manifest-identity-missing');
          }
          if (!verifyInstalledMarketManifest(record, installed)) {
            return reject('meka-market-manifest-identity-mismatch');
          }
        }
        return finish(installed.manifest);
      };

      let installation: PluginMarketInstallationRecord | null = null;
      try {
        const lookup = options.readMarketInstallation(ghostId);
        if (
          lookup &&
          typeof lookup === 'object' &&
          'kind' in lookup &&
          (lookup.kind === 'absent' || lookup.kind === 'found' || lookup.kind === 'invalid')
        ) {
          if (lookup.kind === 'invalid') return reject('market-installation-invalid');
          if (lookup.kind === 'found') installation = lookup.record;
        } else {
          installation = lookup;
        }
      } catch {
        return reject('market-installation-read-failed');
      }
      if (!installation) {
        // Temporary root-only exception. Any persisted market row still takes digest.
        if (temporaryRootMivoCanvas()) {
          const allowlisted = readManifestIdentity();
          if (!allowlisted) return reject('plugin-not-installed');
          if (allowlisted.manifest.id !== pluginSlug) return reject('plugin-id-mismatch');
          const allowlistedHosts = declaredOidcTokenHosts(allowlisted.manifest);
          if (
            allowlistedHosts.length !== 1 ||
            allowlistedHosts[0] !== LOCAL_OIDC_ALLOWLIST_HOST
          ) {
            return reject('oidc-host-not-allowlisted');
          }
          return finish(allowlisted.manifest);
        }
        // `undefined` 才是「不是 Meka 来源」；`null` 表示已判定并拒绝（原因已记录），
        // 不能再补一条通用 reject——双日志会把真实拒绝原因埋掉。
        const mekaResolution = resolveMekaChannelInstall();
        if (mekaResolution !== undefined) return mekaResolution;
        return reject('market-installation-missing');
      }
      if (!installation.installed) return reject('market-installation-missing');
      if (installation.source !== 'market') return reject('market-installation-untrusted');
      if (installation.scope !== 'organization') {
        return reject('market-installation-not-organization');
      }
      if (installation.organizationId !== identity.orgId) {
        return reject('market-installation-org-mismatch');
      }
      if (hasDeliveryNamespace(installation)) {
        let installedNamespace: string | null | undefined;
        try {
          installedNamespace = options.readInstallNamespace?.(ghostId);
        } catch {
          return reject('installed-namespace-unavailable');
        }
        // A running pre-namespace install stays pending until it can stop.
        // Do not require a receipt namespace that has not been committed yet.
        // The catalog namespace must still be the current org.
        const pendingLegacyRoot =
          installedNamespace === undefined &&
          options.isPendingLegacyNamespace?.(ghostId) === true;
        if (
          (!pendingLegacyRoot && installedNamespace !== installation.namespace) ||
          (installation.namespace !== null && identity.orgSlug != null &&
            installation.namespace !== identity.orgSlug)
        ) {
          return reject('market-installation-namespace-mismatch');
        }
      }
      if (!installation.rawManifestSha256 && !installation.manifestDigest) {
        return reject('market-manifest-identity-missing');
      }

      let identitySnapshot: InstalledMarketManifestIdentity | null = null;
      try {
        identitySnapshot = options.readInstalledManifestIdentity(ghostId);
      } catch {
        return reject('installed-manifest-read-failed');
      }
      if (!identitySnapshot) return reject('plugin-not-installed');
      if (identitySnapshot.manifest.id !== pluginSlug) return reject('plugin-id-mismatch');
      if (!verifyInstalledMarketManifest(installation, identitySnapshot)) {
        return reject('installed-manifest-identity-mismatch');
      }
      return finish(identitySnapshot.manifest);
    },
  };
}
