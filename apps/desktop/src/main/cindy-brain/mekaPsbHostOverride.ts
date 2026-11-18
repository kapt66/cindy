/**
 * mekaPsbHostOverride.ts — 本地测试用的 Meka PSB 主机覆盖（启动期环境变量）。
 * ---------------------------------------------------------------------------
 * 背景：Meka 插件包（`meka-submit` 等）把正式 Project Steward Bot 主机
 * `mekabot.meka.pawdy.fun` 硬编码在源码里，manifest 的 `network.hosts` 与
 * `network.secrets[].inject.hosts` 也只声明它。发布后的插件包**不再改动**；本地要
 * 验收测试部署（`mekabot-test.meka.pawdy.fun`），由 Cindy Host 在启动期按环境变量
 * 把「正式 PSB 主机」在运行时替换成测试主机。插件代码、插件包、manifest schema 与
 * 发布流程都不动。
 *
 * 三条不变量：
 * 1. **取值白名单**：只接受测试主机本身（可显式写正式主机，等于没开）。任何其它值
 *    一律忽略并 warn —— 绝不允许把插件凭证／流量引到未声明主机上。
 * 2. **零影响**：未设置 / 被拒绝 / 显式写正式主机时，本模块的所有消费者行为逐字节
 *    不变（下面每个函数都先看 `host`，为 null 时原样返回入参）。
 * 3. **只覆盖正式 PSB 主机**：逐字匹配该主机 + HTTPS 默认端口的请求才改写；其它
 *    host、自定义端口、HTTP、WebSocket 一律不动。生效前提是**该实例 manifest 声明了
 *    正式 PSB 主机**（`network.hosts` 命中它）——Meka 开发目录派生包与**市场安装的
 *    Meka 插件**都满足（后者只声明正式主机，运行时由本模块把覆盖主机当作等价的可
 *    改写／可注入目标），其它插件即使开着覆盖也不会被改道。覆盖只发生在运行时：
 *    manifest、批准记录与包字节都不动。
 *
 * 纯函数 + 一次性读 env，不依赖 Electron：networkSlot / mekaDevPlugins /
 * connectionAudienceResolver 的定向单测直测本模块，main 侧只在启动期读一次
 * （`cindy-brain/index.ts`）。
 */

import { ghostNetworkTargetMatches } from '../../shared/ghost.js';

/** 正式 Project Steward Bot 主机：插件包硬编码它，发布后不再改插件。 */
export const MEKA_PSB_HOST = 'mekabot.meka.pawdy.fun';

/** 唯一允许被切换到的主机（Meka 测试部署）。白名单之外的值一律忽略。 */
export const MEKA_PSB_TEST_HOST = 'mekabot-test.meka.pawdy.fun';

/** 启动期环境变量名：`CINDY_MEKA_PSB_HOST`。 */
export const MEKA_PSB_HOST_ENV = 'CINDY_MEKA_PSB_HOST';

/**
 * 环境变量的解析结论：
 * - `off`：未设置 / 空值，完全没开覆盖；
 * - `formal`：显式写成正式主机，等于没开（幂等，便于部署脚本统一注入）；
 * - `test`：唯一允许的覆盖主机；
 * - `rejected`：值不在白名单，忽略并记 warn，绝不生效。
 */
export type MekaPsbHostOverrideResolution =
  | { kind: 'off' }
  | { kind: 'formal' }
  | { kind: 'test'; host: typeof MEKA_PSB_TEST_HOST }
  | { kind: 'rejected'; value: string };

/**
 * 白名单解析（纯函数）：只认测试主机；正式主机算明示「不覆盖」；其它一律 rejected。
 * 大小写与首尾空白归一化后比较，不做前缀／通配／URL 形式匹配。
 */
export function resolveMekaPsbHostOverride(raw: unknown): MekaPsbHostOverrideResolution {
  if (typeof raw !== 'string') return { kind: 'off' };
  const value = raw.trim().toLowerCase();
  if (value.length === 0) return { kind: 'off' };
  if (value === MEKA_PSB_TEST_HOST) return { kind: 'test', host: MEKA_PSB_TEST_HOST };
  if (value === MEKA_PSB_HOST) return { kind: 'formal' };
  return { kind: 'rejected', value: raw };
}

/**
 * 主进程启动期读一次环境变量。返回的 `host` 只在 `kind === 'test'` 时非 null：
 * 它是下面所有覆盖行为的唯一开关，其余三种结论都是 null（零影响）。
 */
export function readMekaPsbHostOverride(env: NodeJS.ProcessEnv = process.env): {
  host: string | null;
  resolution: MekaPsbHostOverrideResolution;
} {
  const resolution = resolveMekaPsbHostOverride(env[MEKA_PSB_HOST_ENV]);
  return {
    host: resolution.kind === 'test' ? resolution.host : null,
    resolution,
  };
}

/**
 * 该实例 manifest 的 host 声明是否已经包含覆盖主机（逐字或 origin 形式都算）。
 * Meka 开发目录派生包由 `withMekaPsbHostDeclarations` 补上这一条；市场安装的 Meka
 * 插件不在磁盘上补声明（那会改变已批准权限），运行时由
 * `withMekaPsbHostRuntimeDeclarations` 把覆盖主机当作等价目标。
 */
export function manifestDeclaresMekaPsbHost(
  patterns: readonly string[],
  host: string | null,
): boolean {
  if (!host) return false;
  let target: URL;
  try {
    target = new URL(`https://${host}/`);
  } catch {
    return false;
  }
  return patterns.some(
    (pattern) => typeof pattern === 'string' && ghostNetworkTargetMatches(pattern, target),
  );
}

/**
 * 运行时把覆盖主机视为「该实例已声明 / 可注入」的 host（dev-only，纯内存）。
 *
 * 生效条件只有两条：覆盖开关生效（`overrideHost` 非 null）且传入的声明集合**声明了
 * 正式 PSB 主机**——也就是这个插件本来就该访问 PSB。满足时返回**追加了覆盖主机**的
 * 新数组；否则原样返回入参（同一个数组引用 ⇒ 未设置环境变量时逐字节零影响）。
 *
 * 它只改运行时的宿主侧视图（出网白名单、注入 host 匹配、Connection audience 可注入
 * host），不写回 manifest、不改变批准记录：市场安装的插件仍只批准了正式主机，覆盖
 * 只把同一服务的测试部署当作已批准目标的等价形态。
 */
export function withMekaPsbHostRuntimeDeclarations(
  patterns: readonly string[],
  overrideHost: string | null,
): readonly string[] {
  if (!overrideHost || patterns.includes(overrideHost)) return patterns;
  if (!manifestDeclaresMekaPsbHost(patterns, MEKA_PSB_HOST)) return patterns;
  return [...patterns, overrideHost];
}

/**
 * 把「完全匹配正式 PSB 主机」的 HTTPS 默认端口请求改写为覆盖主机。
 * 其它一切请求（未开覆盖、host 不同、自定义端口、非 HTTPS）原样返回**同一个**
 * URL 实例，调用方可用 `rewritten !== target` 判断是否真的改写过。
 */
export function rewriteMekaPsbHost(target: URL, host: string | null): URL {
  if (!host) return target;
  if (target.protocol !== 'https:' || target.port !== '' || target.hostname !== MEKA_PSB_HOST) {
    return target;
  }
  const rewritten = new URL(target.toString());
  rewritten.hostname = host;
  return rewritten;
}

/** `withMekaPsbHostDeclarations` 的变更摘要（只用于日志；没变时为 null）。 */
export interface MekaPsbHostDeclarationPatch {
  manifest: Record<string, unknown>;
  /** 追加进 `network.hosts` 的条目（保留正式主机，不删除任何原条目）。 */
  addedHosts: string[];
  /** 追加进 `network.secrets[].inject.hosts` 的条数。 */
  addedInjectHosts: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 在**内存里**给派生清单补上覆盖主机（源目录、源包字节与已发布包都不动）：
 *
 * - 只在插件真的声明了正式 PSB 主机（`network.hosts` 命中它）时才补——覆盖只服务
 *   走 PSB 的插件，其它插件保持原样，不扩大权限、也不制造无谓的批准差异；
 * - `network.hosts` 追加覆盖主机条目（正式主机原样保留）；
 * - 所有显式声明了 `inject.hosts` 的 `network.secrets[]` 追加同一条逐字条目
 *   （manifest 校验要求 `inject.hosts` 必须逐字取自 `network.hosts`；省略
 *   `inject.hosts` 的凭证本来就跟随全部白名单域名，无需改）；
 * - `source: 'gh-cli'` 的凭证被校验约束为「必须且只能是 api.github.com」，不补；
 * - 没发生变化时返回 null（调用方沿用原对象，零影响）。
 *
 * 不修改入参：返回的 manifest / network / hosts / secrets / inject 都是新对象。
 */
export function withMekaPsbHostDeclarations(
  manifest: Record<string, unknown>,
  host: string | null,
): MekaPsbHostDeclarationPatch | null {
  if (!host) return null;
  const network = manifest.network;
  if (!isPlainObject(network)) return null;
  const hosts: readonly unknown[] = Array.isArray(network.hosts) ? network.hosts : [];
  if (!manifestDeclaresMekaPsbHost(hosts.filter((entry): entry is string => typeof entry === 'string'), MEKA_PSB_HOST)) {
    return null;
  }

  const addedHosts: string[] = [];
  const nextHosts = [...hosts];
  if (!nextHosts.includes(host)) {
    nextHosts.push(host);
    addedHosts.push(host);
  }

  let addedInjectHosts = 0;
  const secrets: readonly unknown[] = Array.isArray(network.secrets) ? network.secrets : [];
  const nextSecrets = secrets.map((secret) => {
    if (!isPlainObject(secret)) return secret;
    // gh-cli 的 inject.hosts 被校验锁死为 api.github.com，补条目会直接让包校验失败。
    if (secret.source === 'gh-cli') return secret;
    const inject = secret.inject;
    if (!isPlainObject(inject)) return secret;
    if (!Array.isArray(inject.hosts)) return secret;
    if (inject.hosts.includes(host)) return secret;
    addedInjectHosts += 1;
    return { ...secret, inject: { ...inject, hosts: [...inject.hosts, host] } };
  });

  if (addedHosts.length === 0 && addedInjectHosts === 0) return null;
  return {
    manifest: {
      ...manifest,
      network: {
        ...network,
        hosts: nextHosts,
        ...(secrets.length > 0 ? { secrets: nextSecrets } : {}),
      },
    },
    addedHosts,
    addedInjectHosts,
  };
}
