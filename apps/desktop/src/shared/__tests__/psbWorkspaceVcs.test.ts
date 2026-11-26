/**
 * CINDY-RW-10 共享契约单测：版本控制通知的解析与 action 白名单。
 *
 * 测试价值
 * - 生产入口与可观察结果：`parseWorkspaceVcsNotice` / `parseWorkspaceVcsAction` /
 *   `readAdvisoryWorkspaceVcs` 是 main 与 renderer 共用的唯一形状入口；它们决定 UI 上出现哪些
 *   处置按钮、以及 `actions` 里哪些条目会被丢弃。
 * - Bug／规则依据：PSB 0.1.180 advisory（`data.vcs`，`advisory:true`，actions 含
 *   inspect-vcs / clean-workspace / continue）与旧版 409 兼容（revert-then-* / retry，更早
 *   revert-vcs）；`force-release` 已删除，**收到也不执行、不渲染**。
 * - 现有覆盖缺口：此前没有任何用例钉住「未知 / 已删除 action 被丢弃」与「continue 不带请求」，
 *   两者漏掉的表现分别是「按钮点了没反应」与「点了继续发出一个畸形请求」。
 * - 最小失败输入：actions 塞 `force-release`、method 与 kind 不匹配（inspect-vcs + POST）、
 *   dirty:false 的 advisory。
 * - tier：unit（纯函数）。
 */

import { describe, expect, it } from 'vitest';

import {
  findWorkspaceVcsAction,
  parseWorkspaceVcsNotice,
  readAdvisoryWorkspaceVcs,
  workspaceVcsActionIsIrreversible,
  workspaceVcsActionMethodAllowed,
  type WorkspaceVcsNotice,
} from '../psb-workspace-vcs';

const DIRTY_ADVISORY = {
  code: 'WORKSPACE_VCS_DIRTY',
  advisory: true,
  messageZh: '检测到未提交修改（2 个检出）',
  dirty: true,
  projects: [
    { projectId: 1, pathInWorkspace: '.', kind: 'p4', changes: 3 },
    { projectId: '2', pathInWorkspace: 'sub', kind: 'git', changes: 1 },
  ],
  actions: [
    {
      kind: 'inspect-vcs',
      method: 'GET',
      path: '/api/cindy/remote/workspaces/ws-1/vcs',
      descriptionZh: '查看未提交修改详情',
    },
    {
      kind: 'clean-workspace',
      method: 'POST',
      path: '/api/cindy/remote/workspaces/ws-1/vcs/revert',
      body: { projectIds: [1], confirm: 'revert' },
      descriptionZh: '一键清理',
    },
    { kind: 'continue', descriptionZh: '忽略提示，继续使用工作区' },
  ],
};

/** 旧版 409（兼容路径）的 actions。 */
const LEGACY_REJECTION = {
  code: 'WORKSPACE_VCS_DIRTY',
  advisory: false,
  messageZh: '工作区有未提交修改：2 个检出',
  dirty: true,
  projects: [{ projectId: 1, pathInWorkspace: '.', kind: 'p4', changes: 3 }],
  actions: [
    { kind: 'inspect-vcs', method: 'GET', path: '/api/cindy/remote/workspaces/ws-1/vcs' },
    {
      kind: 'revert-then-release',
      method: 'DELETE',
      path: '/api/cindy/remote/workspaces/ws-1/occupy',
      body: { revert: true },
    },
    { kind: 'retry', method: 'POST', path: '/api/cindy/remote/workspaces/ws-1/vcs/check' },
  ],
};

describe('parseWorkspaceVcsNotice：0.1.180 advisory 与旧版兼容形状', () => {
  it('保留 advisory / dirty / projects 与干净的 action 形状', () => {
    const notice = parseWorkspaceVcsNotice(DIRTY_ADVISORY);

    expect(notice).not.toBeNull();
    expect(notice).toMatchObject({
      code: 'WORKSPACE_VCS_DIRTY',
      advisory: true,
      dirty: true,
      messageZh: '检测到未提交修改（2 个检出）',
    });
    expect(notice?.projects).toHaveLength(2);
    expect(notice?.actions.map((action) => action.kind)).toEqual([
      'inspect-vcs',
      'clean-workspace',
      'continue',
    ]);
    // continue 不发请求：没有 method / path。
    const continueAction = findWorkspaceVcsAction(notice, 'continue');
    expect(continueAction).toMatchObject({ kind: 'continue' });
    expect(continueAction?.method).toBeUndefined();
    expect(continueAction?.path).toBeUndefined();
  });

  it('旧版 409 兼容 actions（revert-then-* / retry）同样被保留', () => {
    const notice = parseWorkspaceVcsNotice(LEGACY_REJECTION);

    expect(notice?.advisory).toBe(false);
    expect(notice?.actions.map((action) => action.kind)).toEqual([
      'inspect-vcs',
      'revert-then-release',
      'retry',
    ]);
    expect(workspaceVcsActionIsIrreversible('revert-then-release')).toBe(true);
    expect(workspaceVcsActionIsIrreversible('retry')).toBe(false);
    expect(workspaceVcsActionIsIrreversible('clean-workspace')).toBe(true);
  });

  it('已删除的 force-release 与未知 kind 被逐条丢弃，不影响其它动作与文案', () => {
    const notice = parseWorkspaceVcsNotice({
      ...DIRTY_ADVISORY,
      actions: [
        {
          kind: 'force-release',
          method: 'DELETE',
          path: '/api/cindy/remote/workspaces/ws-1/occupy?force=1',
        },
        { kind: 'clean-workspace', method: 'POST', path: '/api/cindy/remote/workspaces/ws-1/vcs/revert' },
        { kind: 'launch-missiles', method: 'POST', path: '/api/cindy/remote/workspaces/ws-1/x' },
      ],
    });

    expect(notice?.actions.map((action) => action.kind)).toEqual(['clean-workspace']);
    // 连错误码都不认识时整份丢弃：调用方按普通失败 / 无提示处理。
    expect(parseWorkspaceVcsNotice({ ...DIRTY_ADVISORY, code: 'WORKSPACE_VCS_UNKNOWN' })).toBeNull();
  });

  it('kind 与 HTTP 方法不匹配的 action 被丢弃（inspect 必须是只读 GET）', () => {
    expect(workspaceVcsActionMethodAllowed('inspect-vcs', 'POST')).toBe(false);
    expect(workspaceVcsActionMethodAllowed('clean-workspace', 'DELETE')).toBe(false);
    expect(workspaceVcsActionMethodAllowed('revert-then-release', 'POST')).toBe(true);
    expect(workspaceVcsActionMethodAllowed('continue', undefined)).toBe(true);

    const notice = parseWorkspaceVcsNotice({
      ...DIRTY_ADVISORY,
      actions: [
        { kind: 'inspect-vcs', method: 'POST', path: '/api/cindy/remote/workspaces/ws-1/vcs' },
        { kind: 'clean-workspace', method: 'POST', path: '/api/cindy/remote/workspaces/ws-1/vcs/revert' },
      ],
    });
    expect(notice?.actions.map((action) => action.kind)).toEqual(['clean-workspace']);
  });

  it('同一个 kind 只保留第一条（服务端重复下发不出现两个一样按钮）', () => {
    const notice = parseWorkspaceVcsNotice({
      ...DIRTY_ADVISORY,
      actions: [
        { kind: 'inspect-vcs', method: 'GET', path: '/api/cindy/remote/workspaces/ws-1/vcs' },
        { kind: 'inspect-vcs', method: 'GET', path: '/api/cindy/remote/workspaces/ws-1/vcs' },
      ],
    });
    expect(notice?.actions).toHaveLength(1);
  });
});

describe('readAdvisoryWorkspaceVcs：2xx 响应的建议性通知', () => {
  it('从 data.vcs 读取 dirty advisory，并强制 advisory:true', () => {
    const notice = readAdvisoryWorkspaceVcs({ workspace: { id: 'ws-1' }, vcs: DIRTY_ADVISORY });

    expect(notice).not.toBeNull();
    expect(notice).toMatchObject({ advisory: true, dirty: true, code: 'WORKSPACE_VCS_DIRTY' });
  });

  it('dirty:false / 缺省时返回 null（契约允许不带，不提示）', () => {
    expect(readAdvisoryWorkspaceVcs({ vcs: { ...DIRTY_ADVISORY, dirty: false } })).toBeNull();
    expect(readAdvisoryWorkspaceVcs({ workspace: { id: 'ws-1' } })).toBeNull();
    expect(readAdvisoryWorkspaceVcs(null)).toBeNull();
  });

  it('也识别工作区行内嵌 vcs 的旧外壳', () => {
    const notice = readAdvisoryWorkspaceVcs({ workspace: { id: 'ws-1', vcs: DIRTY_ADVISORY } });
    expect(notice).toMatchObject({ advisory: true, dirty: true });
  });
});

describe('notice 的本地化兜底键覆盖全部错误码', () => {
  it('三种码都有文案键（渲染层不会显示裸 key）', async () => {
    const { workspaceVcsNoticeMessageKey } = await import('../psb-workspace-vcs');
    for (const code of [
      'WORKSPACE_VCS_DIRTY',
      'WORKSPACE_VCS_UNAVAILABLE',
      'WORKSPACE_VCS_UNSUPPORTED',
    ] as const) {
      expect(workspaceVcsNoticeMessageKey(code)).toBe(`remoteWorkspace.vcs.${code === 'WORKSPACE_VCS_DIRTY' ? 'dirty' : code === 'WORKSPACE_VCS_UNAVAILABLE' ? 'unavailable' : 'unsupported'}`);
    }
    const notice: WorkspaceVcsNotice = parseWorkspaceVcsNotice(DIRTY_ADVISORY)!;
    expect(notice.code).toBe('WORKSPACE_VCS_DIRTY');
  });
});

describe('PSB 码 → IPC 码 → 文案键（跨进程唯一映射，不落通用「操作失败」）', () => {
  it('三个 VCS 码都映射到各自的 PSB_ 码与可行动文案键', async () => {
    const {
      psbBannerMessageKeyForIpcCode,
      psbFailureMessageKeyForIpcCode,
      psbIpcCodeForFailure,
    } = await import('../psb-remote-workspace');

    const cases = [
      ['WORKSPACE_VCS_DIRTY', 'PSB_WORKSPACE_VCS_DIRTY', 'remoteWorkspace.vcs.dirty'],
      ['WORKSPACE_VCS_UNAVAILABLE', 'PSB_WORKSPACE_VCS_UNAVAILABLE', 'remoteWorkspace.vcs.unavailable'],
      ['WORKSPACE_VCS_UNSUPPORTED', 'PSB_WORKSPACE_VCS_UNSUPPORTED', 'remoteWorkspace.vcs.unsupported'],
    ] as const;

    for (const [code, ipcCode, key] of cases) {
      const failure = { code, messageKey: key, message: 'PSB 原话' };
      expect(psbIpcCodeForFailure(failure)).toBe(ipcCode);
      // 按钮/操作失败与错误横幅两个消费面都必须给出可行动文案（不是 error.unknown）。
      expect(psbFailureMessageKeyForIpcCode(ipcCode)).toBe(key);
      expect(psbBannerMessageKeyForIpcCode(ipcCode)).toBe(key);
    }
  });
});
