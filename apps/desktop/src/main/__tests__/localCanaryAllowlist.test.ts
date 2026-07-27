import { describe, expect, it } from 'vitest';

import { LOCAL_CANARY_USER_IDS, isCanaryUser } from '../localCanaryAllowlist';

describe('localCanaryAllowlist', () => {
  it('本地名单用户在服务端标记为 false 时仍进入 canary', () => {
    expect(isCanaryUser(LOCAL_CANARY_USER_IDS[0], false)).toBe(true);
  });

  it('保留服务端管理的 canary 用户', () => {
    expect(isCanaryUser('server-canary-user', true)).toBe(true);
  });

  it('两个来源均未命中时保持 stable', () => {
    expect(isCanaryUser('stable-user', false)).toBe(false);
  });
});
