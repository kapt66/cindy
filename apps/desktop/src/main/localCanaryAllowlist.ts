/**
 * Cindy Meka 本地维护的 canary 用户。
 *
 * 这里使用不可变的用户 ID，不使用会变化的昵称、邮箱或其它身份资料。名单仅影响
 * 客户端选择公开的 canary 更新 manifest，不承载授权或凭证语义。
 */
export const LOCAL_CANARY_USER_IDS = ['cmru3wofs00q8y701fkfhibkc'] as const;

/** Set 形式用于精确、常数时间的名单判断。 */
const localCanaryUserIds = new Set<string>(LOCAL_CANARY_USER_IDS);

/** 合并 Cindy 服务端灰度标记与 Cindy Meka 本地名单。 */
export function isCanaryUser(userId: string, serverIsCanary: boolean): boolean {
  return serverIsCanary || localCanaryUserIds.has(userId);
}
