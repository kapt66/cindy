/**
 * 测试价值
 * - 生产入口与可观察结果：`psbWorkspaceRowLabels()` 是选择器行标签（主标题 + 单行次要信息）的
 *   唯一产出点；用户看到的是「同名工作区能不能分辨」。`psbWorkspaceDisplayName()` 是胶囊 /
 *   主标题口径（名称优先，缺名回退机器-短 id）。
 * - Bug／规则依据：`psbWorkspaceDisplay.ts` 文件头与产品 §2.3（主标题显示工作区名称、同名跨机器
 *   交给次要行）；2026-11-26 独立审查：主标题与次要行**都撞**时两行完全一样，选错工作区会把
 *   占用与会话落进别人的记录 → 冲突行追加短 id 消歧。
 * - 现有覆盖缺口：旧测试只覆盖「名称优先 / 去重」，没有「碰撞消歧」与「跨机器同名不加后缀」。
 * - 最小失败输入：两台机器上同名 + 同目录的工作区（客户端名也相同）。
 * - tier：unit（纯函数，node 环境）。
 */

import { describe, expect, it } from 'vitest';

import type { PsbRemoteWorkspace } from '../../../../../shared/psb-remote-workspace';
import { makePsbWorkspace } from '../../__tests__/psbTestFixtures';
import {
  psbWorkspaceDisplayName,
  psbWorkspaceRowLabels,
  shortPsbWorkspaceId,
} from '../psbWorkspaceDisplay';

const t = (key: string, options?: Record<string, string>) =>
  options?.directory ? `${key}#${options.directory}` : key;

function labelsFor(workspaces: readonly PsbRemoteWorkspace[]) {
  return psbWorkspaceRowLabels(workspaces, t);
}

describe('psbWorkspaceRowLabels', () => {
  it('同名但机器不同：主标题不加后缀，区分交给次要行的机器名', () => {
    // 名称与目录同名 → 次要行退回机器名（跨机器同名时唯一能区分的那一项）。
    const first = makePsbWorkspace({
      id: '9c747178aabbccdd',
      title: 'saga2_project',
      clientName: '打包机',
      directoryName: 'saga2_project',
    });
    const second = makePsbWorkspace({
      id: 'dd44ee55ff66',
      title: 'saga2_project',
      clientName: '设计机-01',
      directoryName: 'saga2_project',
    });
    const labels = labelsFor([first, second]);
    expect(labels.get(first.id)).toEqual({ name: 'saga2_project', secondary: '打包机' });
    expect(labels.get(second.id)).toEqual({ name: 'saga2_project', secondary: '设计机-01' });
  });

  it('主标题与次要行都撞：冲突行追加短 id，保证列表里每行可区分', () => {
    const first = makePsbWorkspace({ id: 'aaaabbbbccccdddd', title: 'saga2_project' });
    const second = makePsbWorkspace({ id: 'bbbbccccddddeeee', title: 'saga2_project' });
    const labels = labelsFor([first, second]);
    expect(labels.get(first.id)?.name).toBe(`saga2_project-${shortPsbWorkspaceId(first.id)}`);
    expect(labels.get(second.id)?.name).toBe(`saga2_project-${shortPsbWorkspaceId(second.id)}`);
    expect(labels.get(first.id)?.name).not.toBe(labels.get(second.id)?.name);
  });

  it('短 id 前缀也相同时用完整 id 兜底（仍要保证唯一）', () => {
    const first = makePsbWorkspace({ id: 'sameprefix0001', title: 'dup' });
    const second = makePsbWorkspace({ id: 'sameprefix0002', title: 'dup' });
    const labels = labelsFor([first, second]);
    // 8 位前缀相同（samepref…）→ 第二次追加完整 id 再区分。
    expect(labels.get(first.id)?.name).not.toBe(labels.get(second.id)?.name);
    expect(labels.get(first.id)?.name).toContain(first.id);
    expect(labels.get(second.id)?.name).toContain(second.id);
  });
});

describe('psbWorkspaceDisplayName', () => {
  it('名称优先；缺名才「机器-短 id」，再短 id', () => {
    expect(
      psbWorkspaceDisplayName({ clientName: '打包机', workspaceId: '9c747178aabbccdd', workspaceTitle: ' saga2 ' }),
    ).toBe('saga2');
    expect(
      psbWorkspaceDisplayName({ clientName: '打包机', workspaceId: '9c747178aabbccdd' }),
    ).toBe('打包机-9c747178…');
    expect(
      psbWorkspaceDisplayName({ clientName: ' ', workspaceId: '9c747178aabbccdd' }),
    ).toBe('9c747178…');
  });
});
