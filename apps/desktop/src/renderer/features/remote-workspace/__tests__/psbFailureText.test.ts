/**
 * 测试价值
 * - 生产入口与可观察结果：`psbFailureText()`（`renderer/features/remote-workspace/psbFailureText.ts`）
 *   是渲染层**唯一的失败文案出口**（弹窗 / 草稿页下拉 / 侧栏行装饰 / 管理页 toast 都调它）。
 *   断言用户看到的是哪一句：PSB 失败码 → 共享码表文案、占用人名插值、空人名回落无名字的同一句、
 *   本地 `ipcError.<CODE>` 兜底、`[CODE]` 机器前缀被剥掉。
 * - Bug／规则依据：2026-11-26 独立审查两条 P1 —— ①「两份 `psbFailureText` 能力不同、调用方
 *   分叉」（同一个失败在弹窗与草稿页可以显示成两句话）；② 真机事故「点按钮只弹操作失败」。
 *   共享契约 `shared/psb-remote-workspace.ts` §8 规定 code → 文案键只走
 *   `psbFailureMessageKeyForIpcCode`；产品 §2.4 要求已知失败必须给可行动文案。
 * - 现有覆盖缺口：旧测试只按调用点断言 key，没有任何用例钉住「空人名不会把 `{{name}}`
 *   原样显示」「非 PSB 的本地 IPC 码会查 `ipcError.*`」「`[CODE] ` 前缀不展示」。
 * - 最小失败输入：`PSB_WORKSPACE_OCCUPIED_BY_OTHER` 但 message 为空（旧实现把空 `{{name}}`
 *   塞进模板）；`Object.assign(new Error('[WORKSPACE_OCCUPIED_BY_OTHER] 张三'))`（渲染层不认的码）。
 * - tier：unit（纯函数，node 环境）。
 */

import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';

import { psbFailureText } from '../psbFailureText';
import { psbFailureText as barrelPsbFailureText } from '../dialog/psbDialogModel';
import { readPsbFailure } from '../dialog/psbFailure';
import { createIpcError } from '../../../../shared/ipc-errors';

/** 只回 key / `key#name` 的翻译桩：断言落在「用哪个键、传了什么值」，不复制任何语言文案。 */
const t = ((key: string, options?: Record<string, unknown>) => {
  if (typeof options?.defaultValue === 'string') {
    // 模拟仓库 `ipcError.*` 表：只有已知的本地码才返回译文（这里约定 NOT_FOUND 存在）。
    return key === 'ipcError.NOT_FOUND' ? 'ipcError.NOT_FOUND' : options.defaultValue;
  }
  const name = options?.name;
  return typeof name === 'string' ? `${key}#${name}` : key;
}) as unknown as TFunction;

describe('psbFailureText（渲染层唯一失败文案出口）', () => {
  it('兼容再导出与根实现是同一个函数（不存在第二份同名实现）', () => {
    expect(barrelPsbFailureText).toBe(psbFailureText);
  });

  it('PSB 失败码走共享单表：可行动文案 + 占用人名插值', () => {
    expect(psbFailureText(t, createIpcError('PSB_WORKSPACE_OCCUPIED_BY_OTHER', '张三'))).toBe(
      'remoteWorkspace.error.occupiedByOther#张三',
    );
    expect(psbFailureText(t, createIpcError('PSB_CLIENT_OFFLINE', '机器离线'))).toBe(
      'remoteWorkspace.error.clientOffline',
    );
    expect(psbFailureText(t, createIpcError('PSB_WORKSPACE_VCS_DIRTY', '有未提交修改'))).toBe(
      'remoteWorkspace.vcs.dirty',
    );
    // 2026-11-27 两类新失败同样是可行动文案，不是通用「操作失败」：
    // 「还没被你占用」（与 PSB 守卫契约同码）与「会话正在输出，先停再释放」。
    expect(psbFailureText(t, createIpcError('PSB_WORKSPACE_NOT_OCCUPIED', ''))).toBe(
      'remoteWorkspace.error.occupyRequired',
    );
    expect(psbFailureText(t, createIpcError('PSB_AGENT_SESSION_ACTIVE', '会话正在输出'))).toBe(
      'remoteWorkspace.error.agentSessionActive',
    );
    // CINDY-RW-17：隧道名额满的下一步是「关掉其它远程会话后重试」，不是通用失败。
    expect(psbFailureText(t, createIpcError('PSB_TOO_MANY_TUNNELS', '隧道数量已达上限'))).toBe(
      'remoteWorkspace.error.tooManyTunnels',
    );
  });

  it('占用失败拿不到人名时回落无名字的同一句，不会显示未插值的 {{name}}', () => {
    const text = psbFailureText(t, createIpcError('PSB_WORKSPACE_OCCUPIED_BY_OTHER', ''));
    expect(text).toBe('remoteWorkspace.error.workspaceOccupied');
    expect(text).not.toContain('{{name}}');
    // 结构化失败（UI state 形状）空人名走同一条回落。
    expect(
      psbFailureText(t, {
        code: 'PSB_WORKSPACE_OCCUPIED_BY_OTHER',
        messageKey: 'remoteWorkspace.error.occupiedByOther',
        message: null,
        personName: null,
      }),
    ).toBe('remoteWorkspace.error.workspaceOccupied');
  });

  it('结构化失败优先用共享码表，并消费 UI state 里的 personName', () => {
    expect(
      psbFailureText(t, {
        code: 'PSB_WORKSPACE_OCCUPIED_BY_OTHER',
        messageKey: 'remoteWorkspace.error.occupiedByOther',
        message: null,
        personName: '李四',
      }),
    ).toBe('remoteWorkspace.error.occupiedByOther#李四');
  });

  it('本地 IPC 码走仓库统一 ipcError.<CODE> 表', () => {
    expect(psbFailureText(t, createIpcError('NOT_FOUND', '找不到'))).toBe('ipcError.NOT_FOUND');
  });

  it('渲染层不认的码：剥掉 [CODE] 前缀后照实显示可读原文', () => {
    const error = Object.assign(new Error('[WORKSPACE_OCCUPIED_BY_OTHER] 张三'), {
      code: 'WORKSPACE_OCCUPIED_BY_OTHER',
    });
    expect(psbFailureText(t, error)).toBe('张三');
    expect(psbFailureText(t, '[PSB_SOMETHING_NEW] 新失败原因')).toBe('新失败原因');
    // Electron invoke 会把 main 错误包一层；旧 main / 新子码认不出时也不能把包装串给用户。
    expect(
      psbFailureText(
        t,
        new Error(
          "Error invoking remote method 'psb-remote:occupy-workspace': Error: [WORKSPACE_OCCUPIED_BY_OTHER] 张三",
        ),
      ),
    ).toBe('张三');
  });

  it('真正无法归因才落通用文案；诊断原文不会被当成正文展示', () => {
    expect(psbFailureText(t, new Error(' '))).toBe('remoteWorkspace.error.unknown');
    expect(psbFailureText(t, null)).toBe('remoteWorkspace.error.unknown');
    // 结构化失败只有诊断 message（没有可翻译键）时，正文仍走通用文案（由调用方决定是否显示
    // description）；这里只钉「root 不把 message 当正文」。
    const info = readPsbFailure(new Error('socket hang up'));
    expect(info.code).toBeNull();
    expect(psbFailureText(t, info)).toBe('remoteWorkspace.error.unknown');
  });
});
