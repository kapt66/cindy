/**
 * 测试价值
 * - 生产入口与可观察结果：`psbWorkspaceRowLabels()`（选择器行主标题 + 单行次要信息）与
 *   `psbWorkspaceTargetDisplayName()`（草稿页项目胶囊）是用户实际看到的两个名字产出口。
 * - Bug／规则依据：2026-11-27 人工复测——工作区**实例名是工作区自己的目录名**
 *   （PSB `directoryName`，如 `saga2_project-3`），模板名（`saga2_project`）只是模板；同一模板
 *   建出的多个工作区过去在主标签上看起来一模一样。目录名缺失（旧数据 / PSB 还没回填）才回退
 *   `title`。模板名与机器名只进次要行（`模板名 · 机器名`），不再出现「目录：<同一个目录名>」。
 * - 现有覆盖缺口：旧用例把「主标签 = workspace.title、次要行在目录/机器间二选一」钉死，没有
 *   「目录名优先 / 模板名进次要行 / 同名不同目录不再消歧后缀」。
 * - 最小失败输入：title=`saga2_project`、directoryName=`saga2_project-3`、
 *   templateTitle=`saga2_project`（模板名与标题同词，旧实现主标签就是模板名）。
 * - tier：unit（纯函数，node 环境）。
 */

import { describe, expect, it } from 'vitest';

import type { PsbRemoteWorkspace } from '../../../../../shared/psb-remote-workspace';
import { makePsbWorkspace } from '../../__tests__/psbTestFixtures';
import { psbWorkspaceCreatedPayload } from '../psbSessionIdentity';
import {
  psbWorkspaceDisplayName,
  psbWorkspaceRowLabels,
  psbWorkspaceTargetDisplayName,
  psbWorkspaceTemplateMachineText,
  shortPsbWorkspaceId,
} from '../psbWorkspaceDisplay';

function labelsFor(workspaces: readonly PsbRemoteWorkspace[]) {
  return psbWorkspaceRowLabels(workspaces);
}

describe('psbWorkspaceRowLabels', () => {
  it('主标题 = 目录名（实例名）；模板名 · 机器名进次要行，模板名不再当主标签', () => {
    // 用户实机数据的形状：title 与模板名同词，目录名才是这个实例自己的名字。
    const workspace = makePsbWorkspace({
      id: '9c747178aabbccdd',
      title: 'saga2_project',
      templateTitle: 'saga2_project',
      directoryName: 'saga2_project-3',
      clientName: '打包机',
    });
    const labels = labelsFor([workspace]);
    expect(labels.get(workspace.id)).toEqual({
      name: 'saga2_project-3',
      secondary: 'saga2_project · 打包机',
    });
  });

  it('同一模板的两个实例（同名不同目录）：主标题各自唯一，不追加短 id', () => {
    const first = makePsbWorkspace({
      id: 'aaaabbbbccccdddd',
      title: 'saga2_project',
      templateTitle: 'saga2_project',
      directoryName: 'saga2_project-3',
      clientName: '打包机',
    });
    const second = makePsbWorkspace({
      id: 'bbbbccccddddeeee',
      title: 'saga2_project',
      templateTitle: 'saga2_project',
      directoryName: 'saga2_project-4',
      clientName: '打包机',
    });
    const labels = labelsFor([first, second]);
    expect(labels.get(first.id)?.name).toBe('saga2_project-3');
    expect(labels.get(second.id)?.name).toBe('saga2_project-4');
    // 目录名已足够区分：不因为标题相同就加短 id 后缀。
    expect(labels.get(first.id)?.name).not.toContain(shortPsbWorkspaceId(first.id));
    expect(labels.get(first.id)?.name).not.toContain(shortPsbWorkspaceId(second.id));
  });

  it('同一目录出现在两台机器：主标题相同，区分交给次要行的机器名', () => {
    const first = makePsbWorkspace({
      id: '9c747178aabbccdd',
      title: 'saga2_project',
      templateTitle: 'saga2_project',
      directoryName: 'saga2_project-3',
      clientName: '打包机',
    });
    const second = makePsbWorkspace({
      id: 'dd44ee55ff66',
      title: 'saga2_project',
      templateTitle: 'saga2_project',
      directoryName: 'saga2_project-3',
      clientName: '设计机-01',
    });
    const labels = labelsFor([first, second]);
    expect(labels.get(first.id)).toEqual({
      name: 'saga2_project-3',
      secondary: 'saga2_project · 打包机',
    });
    expect(labels.get(second.id)).toEqual({
      name: 'saga2_project-3',
      secondary: 'saga2_project · 设计机-01',
    });
  });

  it('目录名缺失（旧数据）回退标题；与主标签重复的模板名不再写第二遍', () => {
    const legacy = makePsbWorkspace({
      id: 'aa11bb22cc33',
      title: '我的项目',
      templateTitle: 'SAGA2 设计',
      directoryName: null,
      clientName: '打包机',
    });
    expect(labelsFor([legacy]).get(legacy.id)).toEqual({
      name: '我的项目',
      secondary: 'SAGA2 设计 · 打包机',
    });

    // 标题与模板名同词（模板建出来的工作区常态）：只剩机器名，不把同一个词写两遍。
    const templateNamed = makePsbWorkspace({
      id: 'aa11bb22cc44',
      title: 'saga2_project',
      templateTitle: 'saga2_project',
      directoryName: null,
      clientName: '打包机',
    });
    expect(labelsFor([templateNamed]).get(templateNamed.id)).toEqual({
      name: 'saga2_project',
      secondary: '打包机',
    });

    // 模板 / 机器都拿不到：没有次要行，也不再退回「目录：<同一个目录名>」。
    const bare = makePsbWorkspace({
      id: 'aa11bb22cc55',
      title: 'saga2_project',
      templateTitle: null,
      directoryName: null,
      clientName: '',
    });
    expect(labelsFor([bare]).get(bare.id)).toEqual({ name: 'saga2_project', secondary: null });
  });

  it('目录与标题都缺失：主标题退回「机器-短 id」，模板名仍只作次要信息', () => {
    const workspace = makePsbWorkspace({
      id: '9c747178aabbccdd',
      title: '',
      templateTitle: 'SAGA2 设计',
      directoryName: null,
      clientName: '打包机',
    });
    expect(labelsFor([workspace]).get(workspace.id)).toEqual({
      name: '打包机-9c747178…',
      secondary: 'SAGA2 设计',
    });
  });

  it('主标题与次要行都撞：冲突行追加短 id，保证列表里每行可区分', () => {
    // 两台不同机器却连机器名都拿不到（脏数据 / 旧 PSB）：目录名 + 模板名 + 机器名完全一致。
    const first = makePsbWorkspace({
      id: 'aaaabbbbccccdddd',
      title: 'saga2_project',
      templateTitle: 'saga2_project',
      directoryName: 'saga2_project-3',
      clientName: '',
    });
    const second = makePsbWorkspace({
      id: 'bbbbccccddddeeee',
      title: 'saga2_project',
      templateTitle: 'saga2_project',
      directoryName: 'saga2_project-3',
      clientName: '',
    });
    const labels = labelsFor([first, second]);
    expect(labels.get(first.id)?.name).toBe(`saga2_project-3-${shortPsbWorkspaceId(first.id)}`);
    expect(labels.get(second.id)?.name).toBe(`saga2_project-3-${shortPsbWorkspaceId(second.id)}`);
    expect(labels.get(first.id)?.name).not.toBe(labels.get(second.id)?.name);
  });

  it('短 id 前缀也相同时用完整 id 兜底（仍要保证唯一）', () => {
    const first = makePsbWorkspace({
      id: 'sameprefix0001',
      title: 'dup',
      templateTitle: null,
      directoryName: null,
      clientName: '',
    });
    const second = makePsbWorkspace({
      id: 'sameprefix0002',
      title: 'dup',
      templateTitle: null,
      directoryName: null,
      clientName: '',
    });
    const labels = labelsFor([first, second]);
    // 8 位前缀相同（samepref…）→ 第二次追加完整 id 再区分。
    expect(labels.get(first.id)?.name).not.toBe(labels.get(second.id)?.name);
    expect(labels.get(first.id)?.name).toContain(first.id);
    expect(labels.get(second.id)?.name).toContain(second.id);
  });
});

describe('psbWorkspaceTemplateMachineText', () => {
  it('模板名 · 机器名：去重、去主标签、单行；都缺时 null', () => {
    expect(
      psbWorkspaceTemplateMachineText({
        templateTitle: 'saga2_project',
        clientName: '打包机',
        primaryName: 'saga2_project-3',
      }),
    ).toBe('saga2_project · 打包机');
    // 与主标签相同的值不重复（主标签可能已经回退成模板名或机器名）。
    expect(
      psbWorkspaceTemplateMachineText({
        templateTitle: '打包机',
        clientName: '打包机',
        primaryName: '打包机',
      }),
    ).toBeNull();
    expect(
      psbWorkspaceTemplateMachineText({
        templateTitle: null,
        clientName: '  ',
        primaryName: 'saga2_project-3',
      }),
    ).toBeNull();
  });
});

describe('psbWorkspaceDisplayName', () => {
  it('目录名（实例名）优先；缺目录名才回退标题 → 机器-短 id → 短 id', () => {
    expect(
      psbWorkspaceDisplayName({
        clientName: '打包机',
        workspaceId: '9c747178aabbccdd',
        workspaceTitle: 'saga2_project',
        directoryName: '  saga2_project-3  ',
      }),
    ).toBe('saga2_project-3');
    // 旧数据没有目录名：回退标题（旧口径），不拿模板名 / 机器拼名。
    expect(
      psbWorkspaceDisplayName({
        clientName: '打包机',
        workspaceId: '9c747178aabbccdd',
        workspaceTitle: ' saga2_project ',
      }),
    ).toBe('saga2_project');
    expect(
      psbWorkspaceDisplayName({ clientName: '打包机', workspaceId: '9c747178aabbccdd' }),
    ).toBe('打包机-9c747178…');
    expect(
      psbWorkspaceDisplayName({
        clientName: ' ',
        workspaceId: '9c747178aabbccdd',
        workspaceTitle: '',
        directoryName: '  ',
      }),
    ).toBe('9c747178…');
    expect(shortPsbWorkspaceId('9c747178')).toBe('9c747178');
    expect(
      psbWorkspaceDisplayName({ clientName: '', workspaceId: '', workspaceTitle: '' }),
    ).toBe('');
  });
});

describe('psbWorkspaceTargetDisplayName', () => {
  it('草稿页 PSB 目标 → 胶囊显示目录名（实例名），模板名不进主标签', () => {
    expect(
      psbWorkspaceTargetDisplayName({
        workspaceId: 'ws-a',
        clientName: '打包机',
        workspaceTitle: 'saga2_project',
        directoryName: 'saga2_project-3',
      }),
    ).toBe('saga2_project-3');
    // 旧草稿 / 旧路由 state 没有 directoryName：回退标题，旧数据不崩。
    expect(
      psbWorkspaceTargetDisplayName({
        workspaceId: 'ws-a',
        clientName: '打包机',
        workspaceTitle: 'saga2_project',
        directoryName: null,
      }),
    ).toBe('saga2_project');
  });

  it('选择器交接载荷 → 胶囊同一口径（字段链路：PSB 行 → 载荷 → 显示名）', () => {
    const workspace = makePsbWorkspace({
      id: '9c747178aabbccdd',
      title: 'saga2_project',
      templateTitle: 'saga2_project',
      directoryName: 'saga2_project-3',
      clientName: '打包机',
    });
    expect(psbWorkspaceTargetDisplayName(psbWorkspaceCreatedPayload(workspace))).toBe(
      'saga2_project-3',
    );
  });
});
