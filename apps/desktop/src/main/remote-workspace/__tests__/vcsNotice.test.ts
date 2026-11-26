/**
 * main 侧版本控制通知的安全边界单测（CINDY-RW-10）。
 *
 * 测试价值
 * - 生产入口与可观察结果：`sanitizeWorkspaceVcsNotice` / `createWorkspaceVcsNoticeCache` /
 *   `isAllowedPsbRemoteActionPath` 决定 main 会替用户请求哪个 URL、body 带什么，以及渲染层
 *   会看到哪些可点按钮。用户可观察结果：错误路径被拒（不发出请求）vs 合法路径被执行。
 * - Bug／规则依据：更正版契约要求「直接按服务端 actions 的 method/path/body 执行、不要自己拼
 *   路径」，同时**没有 force 分支**。盲信服务端 = 可被指向任意 URL；不放行合法 action = 用户
 *   无法清理。安全边界必须由本文件钉住。
 * - 现有覆盖缺口：新增文件此前无用例；`force-release` / 跨工作区路径 / 绝对 URL / 多余 body
 *   键都没有任何运行期断言。
 * - 最小失败输入：
 *   - action.path 指向另一个 workspaceId；
 *   - path 带 `https://evil.example`、`..`、`?force=1`；
 *   - body 含白名单外的键（如 `force:true`）/ projectIds 非数组；
 *   - 33 个工作区的 notice（缓存上限 32）。
 * - tier：unit（纯函数 + 内存缓存，无网络 / Electron）。
 */

import { describe, expect, it } from 'vitest';

import {
  PSB_WORKSPACE_VCS_NOTICE_LIMIT,
  createWorkspaceVcsNoticeCache,
  isAllowedWorkspaceVcsActionPath,
  sanitizeWorkspaceVcsActionBody,
  sanitizeWorkspaceVcsNotice,
} from '../vcsNotice';
import { isAllowedPsbRemoteActionPath } from '../psbClient';

const WORKSPACE_ID = 'ws-1';

function advisory(overrides: Record<string, unknown> = {}) {
  return {
    code: 'WORKSPACE_VCS_DIRTY',
    advisory: true,
    messageZh: '检测到未提交修改（2 个检出）',
    dirty: true,
    projects: [{ projectId: 1, pathInWorkspace: '.', kind: 'p4', changes: 3 }],
    actions: [
      {
        kind: 'inspect-vcs',
        method: 'GET',
        path: `/api/cindy/remote/workspaces/${WORKSPACE_ID}/vcs`,
        descriptionZh: '查看未提交修改详情',
      },
      {
        kind: 'clean-workspace',
        method: 'POST',
        path: `/api/cindy/remote/workspaces/${WORKSPACE_ID}/vcs/revert`,
        body: { projectIds: [1], confirm: 'revert' },
        descriptionZh: '一键清理',
      },
      { kind: 'continue', descriptionZh: '忽略提示，继续使用工作区' },
    ],
    ...overrides,
  };
}

describe('sanitizeWorkspaceVcsNotice：把服务端 actions 收敛成可安全执行的集合', () => {
  it('合法 action 原样保留（0.1.180 advisory：inspect / clean / continue）', () => {
    const notice = sanitizeWorkspaceVcsNotice(WORKSPACE_ID, advisory());

    expect(notice).not.toBeNull();
    expect(notice?.advisory).toBe(true);
    expect(notice?.actions.map((action) => action.kind)).toEqual([
      'inspect-vcs',
      'clean-workspace',
      'continue',
    ]);
    const clean = notice?.actions.find((action) => action.kind === 'clean-workspace');
    expect(clean).toMatchObject({
      method: 'POST',
      path: `/api/cindy/remote/workspaces/${WORKSPACE_ID}/vcs/revert`,
      body: { projectIds: [1], confirm: 'revert' },
    });
  });

  it('跨工作区的 action 被丢弃（不能借一个工作区的提示去改另一个）', () => {
    const notice = sanitizeWorkspaceVcsNotice(WORKSPACE_ID, {
      ...advisory(),
      actions: [
        {
          kind: 'clean-workspace',
          method: 'POST',
          path: '/api/cindy/remote/workspaces/ws-other/vcs/revert',
        },
        {
          kind: 'inspect-vcs',
          method: 'GET',
          path: `/api/cindy/remote/workspaces/${WORKSPACE_ID}/vcs`,
        },
      ],
    });

    expect(notice?.actions.map((action) => action.kind)).toEqual(['inspect-vcs']);
  });

  it('绝对 URL / 协议相对 / .. / force 查询参数一律拒绝', () => {
    for (const path of [
      'https://evil.example/api/cindy/remote/workspaces/ws-1/vcs',
      '//evil.example/api/cindy/remote/workspaces/ws-1/vcs',
      '/api/cindy/remote/workspaces/ws-1/../ws-2/vcs',
      '/api/cindy/remote/workspaces/ws-1/occupy?force=1',
      '/api/cindy/remote/workspaces/ws-1/vcs?x=1&force=true',
      '/api/cindy/remote/workspaces/ws-1\\vcs',
    ]) {
      expect(isAllowedWorkspaceVcsActionPath(WORKSPACE_ID, path), path).toBe(false);
    }
    expect(isAllowedWorkspaceVcsActionPath(WORKSPACE_ID, `/api/cindy/remote/workspaces/${WORKSPACE_ID}/vcs`)).toBe(true);
    // 合法 query 仍允许（例如服务端用 `?project=1` 指定范围）。
    expect(
      isAllowedWorkspaceVcsActionPath(WORKSPACE_ID, `/api/cindy/remote/workspaces/${WORKSPACE_ID}/vcs/revert?retry=2`),
    ).toBe(true);
  });

  it('body 只接受 revert / projectIds / confirm；多余键整条 action 丢弃', () => {
    expect(sanitizeWorkspaceVcsActionBody(undefined)).toBeUndefined();
    expect(sanitizeWorkspaceVcsActionBody({ projectIds: [1], confirm: 'revert' })).toEqual({
      projectIds: [1],
      confirm: 'revert',
    });
    expect(sanitizeWorkspaceVcsActionBody({ force: true })).toBeNull();
    expect(sanitizeWorkspaceVcsActionBody({ revert: 'yes' })).toBeNull();
    expect(sanitizeWorkspaceVcsActionBody({ projectIds: 'all' })).toBeNull();
    expect(sanitizeWorkspaceVcsActionBody({ projectIds: [{}] })).toBeNull();

    const notice = sanitizeWorkspaceVcsNotice(WORKSPACE_ID, {
      ...advisory(),
      actions: [
        {
          kind: 'clean-workspace',
          method: 'POST',
          path: `/api/cindy/remote/workspaces/${WORKSPACE_ID}/vcs/revert`,
          body: { projectIds: [1], force: true },
        },
      ],
    });
    expect(notice?.actions).toEqual([]);
  });

  it('continue 带 method/path/body 时整条丢弃（它必须不发请求）', () => {
    const notice = sanitizeWorkspaceVcsNotice(WORKSPACE_ID, {
      ...advisory(),
      actions: [
        {
          kind: 'continue',
          method: 'POST',
          path: `/api/cindy/remote/workspaces/${WORKSPACE_ID}/vcs/continue`,
        },
      ],
    });
    expect(notice?.actions).toEqual([]);
  });
});

describe('createWorkspaceVcsNoticeCache：有界 + 清除', () => {
  it('按 workspaceId 读回，并记住产生入口', () => {
    const cache = createWorkspaceVcsNoticeCache();
    expect(cache.remember(WORKSPACE_ID, advisory(), 'occupy')).toBe(true);

    expect(cache.read(WORKSPACE_ID)).toMatchObject({ code: 'WORKSPACE_VCS_DIRTY' });
    expect(cache.readEntry(WORKSPACE_ID)?.operation).toBe('occupy');
    expect(cache.findAction(WORKSPACE_ID, 'clean-workspace')).toMatchObject({
      path: `/api/cindy/remote/workspaces/${WORKSPACE_ID}/vcs/revert`,
    });
    expect(cache.findAction(WORKSPACE_ID, 'continue')?.method).toBeUndefined();
    expect(cache.findAction(WORKSPACE_ID, 'retry')).toBeNull();
  });

  it('不合法载荷不写入（调用方按普通失败处理）', () => {
    const cache = createWorkspaceVcsNoticeCache();
    expect(cache.remember(WORKSPACE_ID, { code: 'NOPE' }, 'occupy')).toBe(false);
    expect(cache.read(WORKSPACE_ID)).toBeNull();
  });

  it('超过上限时淘汰最久未用的条目（≤32）', () => {
    const cache = createWorkspaceVcsNoticeCache();
    for (let index = 0; index <= PSB_WORKSPACE_VCS_NOTICE_LIMIT; index += 1) {
      cache.remember(`ws-${index}`, advisory(), 'ensure');
    }
    expect(cache.size()).toBe(PSB_WORKSPACE_VCS_NOTICE_LIMIT);
    // 最早那条被淘汰；最后一条仍在。
    expect(cache.read('ws-0')).toBeNull();
    expect(cache.read(`ws-${PSB_WORKSPACE_VCS_NOTICE_LIMIT}`)).not.toBeNull();
  });

  it('clear 幂等并真正释放条目（成功占用 / 释放后不再提示）', () => {
    const cache = createWorkspaceVcsNoticeCache();
    cache.remember(WORKSPACE_ID, advisory(), 'release');
    expect(cache.clear(WORKSPACE_ID)).toBe(true);
    expect(cache.clear(WORKSPACE_ID)).toBe(false);
    expect(cache.read(WORKSPACE_ID)).toBeNull();
  });
});

describe('isAllowedPsbRemoteActionPath：拼 URL 前的第二道兜底', () => {
  it('只放行 Cindy 命名空间的相对路径', () => {
    expect(isAllowedPsbRemoteActionPath('/api/cindy/remote/workspaces/ws-1/vcs')).toBe(true);
    expect(isAllowedPsbRemoteActionPath('/api/remote/workspaces/ws-1/vcs')).toBe(false);
    expect(isAllowedPsbRemoteActionPath('http://127.0.0.1/api/cindy/remote/workspaces/ws-1/vcs')).toBe(false);
    expect(isAllowedPsbRemoteActionPath('/api/cindy/remote/workspaces/ws-1/../x')).toBe(false);
    expect(isAllowedPsbRemoteActionPath('/api/cindy/remote/workspaces/ws-1/vcs\nX-Injected: 1')).toBe(false);
  });
});
