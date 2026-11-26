// @vitest-environment jsdom

/**
 * resetDraftWorkspaceTargets —— 「另起一段干净对话」的共享复位入口。
 *
 * 所有预填入口(/issue、通讯录引导、发送后复位)都走它。这里钉住它真的清干净:
 * 尤其 extraDirs —— 那是单次草稿的**目录读取授权**,漏掉会让新会话悄悄继承对无关
 * 本地目录的访问权(#1103 review:两个入口各自手写字段清单,都漏了它)。
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  __reloadForTest,
  __resetForTest,
  __STORAGE_KEY,
  getDraft,
  patchCollab,
  patchDraft,
  resetDraftWorkspaceTargets,
  setNewMakerDraftOwner,
} from '@/state/newMakerDraft';

beforeEach(() => {
  __resetForTest();
});

describe('resetDraftWorkspaceTargets', () => {
  it('清空额外目录授权', () => {
    patchDraft({ workingDir: '/Users/someone/project', extraDirs: ['/Users/someone/secrets'] });
    expect(getDraft().extraDirs).toEqual(['/Users/someone/secrets']);

    resetDraftWorkspaceTargets();
    expect(getDraft().extraDirs).toEqual([]);
  });

  it('清空工作目录和远程目标,并显式消费本次协同选择', () => {
    patchDraft({ workingDir: '/Users/someone/project' });
    patchDraft({ remoteHostId: 'host-1' });
    patchDraft({ workingDir: '/Users/someone/project', deviceLinkDeviceId: 'dev-1' });
    // PSB 远程工作区目标（第三种 transport）：目标与懒建后的身份都要一起被复位。
    patchDraft({
      psbTarget: {
        sessionId: 'psb-session-1',
        workspaceId: 'workspace-1',
        clientId: 'client-1',
        clientName: '设计机',
        workspaceTitle: 'SAGA2',
        directoryName: 'saga2',
      },
    });
    patchCollab({ enabled: true });

    resetDraftWorkspaceTargets();
    const draft = getDraft();
    expect(draft.workingDir).toBeNull();
    expect(draft.remoteHostId).toBeNull();
    expect(draft.psbTarget).toBeNull();
    expect(draft.deviceLinkDeviceId).toBeNull();
    expect(draft.deviceLinkDeviceName).toBeNull();
    expect(draft.collab.enabled).toBe(false);
  });

  it('不动模型 / agent 层偏好 —— 那是「我常用哪个」的记忆,与「这次跑在哪」正交', () => {
    patchDraft({ vendor: 'codex', workingDir: '/tmp/x', extraDirs: ['/tmp/y'] });
    const vendorBefore = getDraft().vendor;
    const lastByVendorBefore = getDraft().lastByVendor;

    resetDraftWorkspaceTargets();
    expect(getDraft().vendor).toBe(vendorBefore);
    expect(getDraft().lastByVendor).toEqual(lastByVendorBefore);
  });

  it('幂等:已经是干净对话态时再调一次没有副作用', () => {
    resetDraftWorkspaceTargets();
    const first = getDraft();
    resetDraftWorkspaceTargets();
    expect(getDraft()).toEqual(first);
  });

  it('记住明确选择的无项目对话，功能引导保留而发送复位清除该选择', () => {
    setNewMakerDraftOwner('explicit-dialogue-owner');
    patchDraft({ workingDir: null, explicitNoProject: true });
    setNewMakerDraftOwner('other-owner');
    setNewMakerDraftOwner('explicit-dialogue-owner');
    expect(getDraft().explicitNoProject).toBe(true);

    resetDraftWorkspaceTargets();
    expect(getDraft().explicitNoProject).toBe(true);
    resetDraftWorkspaceTargets({ explicitNoProject: false });
    expect(getDraft().explicitNoProject).toBe(false);
  });
});

/**
 * PSB 远程工作区目标（第三种 transport）。
 *
 * 规则依据：产品口径 2026-11-25（新建只选/建工作区，PSB 会话首条消息懒建）+
 * docs/dev-rules/psb-remote-session-transport.md 第 1 节（`psb:` 不是 SSH 主机）。
 * 目标在懒建前只有工作区级事实（无 `psb:` / 无虚拟目录）；懒建回写 sessionId 后才派生身份。
 * 现有覆盖缺口：同文件的 remoteHostId 用例只覆盖字符串目标，不覆盖「目标先于会话存在」、
 * 「懒建回写派生身份」与「脏 localStorage 半截身份回退」。
 * tier：unit（jsdom + 生产 store 入口，无网络）。
 */
describe('PSB 远程工作区目标', () => {
  /** 工作区级目标（弹窗/侧栏交接的常态：还没建 PSB 会话）。 */
  const workspaceTarget = {
    workspaceId: 'workspace-1',
    clientId: 'client-1',
    clientName: '设计机-01',
    workspaceTitle: 'SAGA2 设计',
    directoryName: 'saga2_design',
    sessionId: null as string | null,
  };

  it('只声明工作区目标时不产生 psb 身份；懒建回写 sessionId 后才派生身份三件', () => {
    patchDraft({ psbTarget: workspaceTarget });

    const before = getDraft();
    // 还没发首条消息：没有 PSB 会话，也就不该有 psb: 身份与虚拟工作目录。
    expect(before.remoteHostId).toBeNull();
    expect(before.workingDir).toBeNull();
    // `explicitNoProject` **只**表示用户显式选了「对话」，不再被借用成「远程目标没有本地
    // 项目目录」。远程目标靠目标自身/渠道状态识别默认目录预填，不靠这个标记。
    expect(before.explicitNoProject).toBe(false);
    expect(before.remoteProjectName).toBe('SAGA2 设计');
    expect(before.remoteInstanceName).toBe('设计机-01');
    expect(before.psbTarget).toEqual(workspaceTarget);

    // 首条消息懒建成功 → 回写 sessionId（生产代码里由 gate.onSessionCreated 调 patchDraft）。
    patchDraft({ psbTarget: { ...workspaceTarget, sessionId: 'psb-session-1' } });
    const after = getDraft();
    expect(after.remoteHostId).toBe('psb:psb-session-1');
    expect(after.workingDir).toBe('/psb-remote/saga2_design');
    expect(after.psbTarget?.sessionId).toBe('psb-session-1');

    // __reloadForTest 是生产代码自带的「模拟 app 重启」入口：从 localStorage 重载。
    __reloadForTest();
    expect(getDraft().remoteHostId).toBe('psb:psb-session-1');
    expect(getDraft().workingDir).toBe('/psb-remote/saga2_design');
    expect(getDraft().psbTarget?.sessionId).toBe('psb-session-1');
  });

  it('切到本机项目时把目标与身份一起清掉', () => {
    patchDraft({ psbTarget: { ...workspaceTarget, sessionId: 'psb-session-1' } });
    patchDraft({ workingDir: '/local/app' });

    const draft = getDraft();
    expect(draft.workingDir).toBe('/local/app');
    expect(draft.remoteHostId).toBeNull();
    expect(draft.remoteProjectName).toBeNull();
    expect(draft.psbTarget).toBeNull();
  });

  it('切到 MCPR 远程项目时同样把 PSB 目标清掉，且不动 MCPR 身份', () => {
    patchDraft({ psbTarget: workspaceTarget });
    patchDraft({
      workingDir: '/srv/app',
      remoteHostId: 'mcpr:instance-a',
      remoteProjectName: 'SAGA2服务器',
      remoteInstanceName: 'team/saga2',
    });

    const draft = getDraft();
    expect(draft.psbTarget).toBeNull();
    expect(draft.remoteHostId).toBe('mcpr:instance-a');
    expect(draft.workingDir).toBe('/srv/app');
    expect(draft.remoteProjectName).toBe('SAGA2服务器');
  });

  it('与 device-link 目标双向互斥', () => {
    patchDraft({ workingDir: '/local/app', deviceLinkDeviceId: 'device-1', deviceLinkDeviceName: '旧电脑' });
    patchDraft({ psbTarget: workspaceTarget });
    expect(getDraft().psbTarget?.workspaceId).toBe('workspace-1');
    expect(getDraft().deviceLinkDeviceId).toBeNull();
    expect(getDraft().deviceLinkDeviceName).toBeNull();

    patchDraft({ workingDir: '/local/app', deviceLinkDeviceId: 'device-1', deviceLinkDeviceName: '旧电脑' });
    expect(getDraft().psbTarget).toBeNull();
    expect(getDraft().remoteHostId).toBeNull();
    expect(getDraft().deviceLinkDeviceId).toBe('device-1');
  });

  it('脏 localStorage 里只剩 psb 前缀：丢弃远程身份，不落成 SSH 主机', () => {
    localStorage.setItem(
      __STORAGE_KEY,
      JSON.stringify({ vendor: 'cc', workingDir: '/psb-remote/x', remoteHostId: 'psb:lost-session' }),
    );
    __reloadForTest();

    expect(getDraft().remoteHostId).toBeNull();
    expect(getDraft().workingDir).toBeNull();
    expect(getDraft().psbTarget).toBeNull();
  });

  it('目标会话 id 与存储的 psb 身份不一致时丢掉会话 id，但保留工作区目标', () => {
    localStorage.setItem(
      __STORAGE_KEY,
      JSON.stringify({
        vendor: 'cc',
        psbTarget: { ...workspaceTarget, sessionId: 'psb-session-stored' },
        remoteHostId: 'psb:psb-session-other',
        workingDir: '/psb-remote/saga2_design',
      }),
    );
    __reloadForTest();

    const draft = getDraft();
    expect(draft.psbTarget?.workspaceId).toBe('workspace-1');
    expect(draft.psbTarget?.sessionId).toBeNull();
    expect(draft.remoteHostId).toBeNull();
    expect(draft.workingDir).toBeNull();
  });
});
