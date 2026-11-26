/**
 * PSB 鉴权：宿主**直接**签发 Cindy Connection JWT（不经插件）。
 *
 * ## 走的是哪条链
 *
 * 与「Meka 提交」插件完全相同的一条链：宿主用自己的登录身份向 Cindy 云端的
 * `/api/auth/connections/token` 换一条 audience 为 `<orgSlug>:<pluginSlug>` 的 Connection JWT，
 * PSB 用 `packages/cindy-auth` 验签并把 `sub` / `email` 映射到同一行 `people`。
 *
 * **本轮的特殊之处只有一个：不经过插件。** 宿主自己持有身份与签发通道，因此这里不需要
 * "插件已安装 / 已批准 / manifest 声明 host" 那套资格证据（那套证据存在的目的是防止**第三方包**
 * 拿到企业身份；远程工作区是宿主自己的功能，签发对象就是宿主自己）。
 *
 * ## 三条不变式
 *
 * 1. **audience 复用现网值**：`<orgSlug>:meka-submit`。PSB 生产部署的 `CINDY_AUTH_AUDIENCE`
 *    已经是 `xd:meka-submit`，换成新 slug 需要两侧同时改配置并重走一次白名单评审；本轮目标是
 *    "同一身份、多一条能力入口"，不引入第二个 audience。
 * 2. **token 不落盘、不出 main 进程**：`ConnectionTokenProvider` 自己缓存（内存）；
 *    renderer 永远拿不到 token，也拿不到 orgSlug 之外的任何身份字段。
 * 3. **只有组织成员可用**：个人 membership 没有 `orgSlug`，也就签不出 audience ——
 *    直接给出可翻译的原因，不去猜一个 `personal:meka-submit`。
 */

import type { AuthState } from '../authManager.js';

/**
 * Connection audience 里的插件 slug。
 *
 * 复用 Meka 提交的 slug 是为了与 PSB 侧已配置的 `CINDY_AUTH_AUDIENCE` 对齐（见文件头 1）。
 * **改名不是纯客户端改动**：PSB 的 `.env` 必须同时改，否则所有调用 401。
 */
export const PSB_CONNECTION_PLUGIN_SLUG = 'meka-submit';

/** 宿主签发 PSB Connection JWT 所需的最小身份快照。 */
export interface PsbConnectionIdentity {
  readonly membershipId: string;
  readonly orgSlug: string;
}

/** 解析结果：要么可签发，要么带一个可翻译的原因（不抛异常，调用方按 UI 状态处理）。 */
export type PsbConnectionIdentityResolution =
  | { readonly kind: 'ready'; readonly identity: PsbConnectionIdentity }
  | { readonly kind: 'signed-out'; readonly reasonKey: string }
  | { readonly kind: 'personal-membership'; readonly reasonKey: string }
  | { readonly kind: 'org-unavailable'; readonly reasonKey: string };

/**
 * 从宿主登录态解析 PSB 身份。
 *
 * 只读 `getAuthState()` 的形状（`isAuthenticated` / `user.membershipKind` / `user.orgSlug` / `user.id`），
 * 纯函数便于单测；生产调用点在 `index.ts` 注入 `getAuthState`。
 */
export function resolvePsbConnectionIdentity(state: AuthState): PsbConnectionIdentityResolution {
  if (!state.isAuthenticated || !state.user) {
    return { kind: 'signed-out', reasonKey: 'remoteWorkspace.status.needLogin' };
  }
  const user = state.user;
  if (user.membershipKind !== 'org') {
    return { kind: 'personal-membership', reasonKey: 'remoteWorkspace.status.needOrg' };
  }
  const orgSlug = typeof user.orgSlug === 'string' ? user.orgSlug.trim() : '';
  const membershipId = typeof user.id === 'string' ? user.id.trim() : '';
  if (!orgSlug || !membershipId) {
    return { kind: 'org-unavailable', reasonKey: 'remoteWorkspace.status.needOrg' };
  }
  return { kind: 'ready', identity: { membershipId, orgSlug } };
}

/** `<orgSlug>:<pluginSlug>` —— 与 `connectionAudienceResolver` 拼 audience 的规则逐字一致。 */
export function buildPsbConnectionAudience(orgSlug: string): string {
  return `${orgSlug}:${PSB_CONNECTION_PLUGIN_SLUG}`;
}

/** 取 token 的端口（生产 = `getConnectionTokenProvider()`；测试注入假实现）。 */
export interface PsbConnectionTokenPort {
  getToken(input: { membershipId: string; audience: string }): Promise<string>;
  invalidate(input: { membershipId: string; audience: string }): void;
}

/**
 * 统一取一次 PSB token：解析身份 → 拼 audience → 换 token。
 *
 * 失败时把"为什么要重新登录"翻译成原因键，而不是把底层错误原文抛给渲染层——
 * `ConnectionTokenProvider` 的报错里可能出现 audience 与 membership（都不是用户能行动的信息）。
 */
export async function getPsbConnectionToken(
  deps: {
    getAuthState(): AuthState;
    tokens: PsbConnectionTokenPort;
  },
): Promise<
  | { readonly ok: true; readonly token: string; readonly audience: string }
  | { readonly ok: false; readonly reasonKey: string; readonly detail: string | null }
> {
  const resolution = resolvePsbConnectionIdentity(deps.getAuthState());
  if (resolution.kind !== 'ready') {
    return { ok: false, reasonKey: resolution.reasonKey, detail: null };
  }
  const audience = buildPsbConnectionAudience(resolution.identity.orgSlug);
  try {
    const token = await deps.tokens.getToken({
      membershipId: resolution.identity.membershipId,
      audience,
    });
    return { ok: true, token, audience };
  } catch (error) {
    return {
      ok: false,
      reasonKey: 'remoteWorkspace.error.auth',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 401/403 之后让缓存失效（下次调用会重新签发一次）。 */
export function invalidatePsbConnectionToken(
  deps: {
    getAuthState(): AuthState;
    tokens: PsbConnectionTokenPort;
  },
): void {
  const resolution = resolvePsbConnectionIdentity(deps.getAuthState());
  if (resolution.kind !== 'ready') return;
  deps.tokens.invalidate({
    membershipId: resolution.identity.membershipId,
    audience: buildPsbConnectionAudience(resolution.identity.orgSlug),
  });
}
