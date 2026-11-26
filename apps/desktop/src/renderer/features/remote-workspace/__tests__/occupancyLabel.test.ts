// @vitest-environment jsdom
/**
 * 测试价值
 * - 生产入口与可观察结果：`features/remote-workspace/occupancyLabel.ts` 的
 *   `formatWorkspaceOccupancy()`（页头占用信息与侧栏锁 Tip 的唯一格式化入口）。
 *   可观察的是用户看到的占用文案（2026-11-26 用户口径）：
 *     ① 自己占用且 PSB 给了名字 → `张三（你）`（PSB 在 byMe:true 时也回自己的名字）；
 *     ② 他人占用且有名 → 直接显示 `李四`；
 *     ③ 占用中但 PSB 没给名字 → 自己「你」/ 他人「他人」；
 *     ④ 未占用 → 「无」。
 * - Bug / 规则依据：旧实现 `byMe` 时只显示「你」，丢掉了 PSB 回的真实姓名；产品正本
 *   `docs/product-rules/psb-remote-workspace-sessions.md` §2.4。
 * - 现有覆盖缺口：占用文案此前在页头与侧栏各写一份、都在 `byMe` 时丢掉名字；本文件把格式
 *   规则钉在一处。
 * - 最小失败输入：byMe 时仍只显示「你」；他人占用显示「你」；名字为空时拼出空括号；未占用
 *   显示成「你」。
 * - tier：unit（jsdom + 真实 i18n 资源，无 Electron）。
 */

import { beforeEach, describe, expect, it } from 'vitest';

import i18n from '@/i18n';
import { formatWorkspaceOccupancy } from '../occupancyLabel';

function occupancy(patch: {
  occupied?: boolean;
  byMe?: boolean;
  personName?: string;
} = {}) {
  return {
    occupied: true,
    byMe: false,
    personName: '',
    ...patch,
  };
}

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
});

describe('formatWorkspaceOccupancy', () => {
  it('shows the person name and appends （你） when the occupant is me', () => {
    expect(
      formatWorkspaceOccupancy(occupancy({ byMe: true, personName: '张三' }), i18n.t),
    ).toBe('张三（你）');
  });

  it('shows the other person’s name without a suffix', () => {
    expect(formatWorkspaceOccupancy(occupancy({ personName: '李四' }), i18n.t)).toBe('李四');
  });

  it('falls back to 你 / 他人 when PSB gave no name', () => {
    expect(formatWorkspaceOccupancy(occupancy({ byMe: true }), i18n.t)).toBe('你');
    expect(formatWorkspaceOccupancy(occupancy({ byMe: false }), i18n.t)).toBe('他人');
  });

  it('keeps 无 for a free workspace', () => {
    expect(
      formatWorkspaceOccupancy(occupancy({ occupied: false }), i18n.t),
    ).toBe('无');
  });

  it('uses locale-specific brackets / pronouns instead of hardcoding them', async () => {
    await i18n.changeLanguage('en');
    expect(formatWorkspaceOccupancy(occupancy({ byMe: true, personName: 'Ada' }), i18n.t)).toBe(
      'Ada (you)',
    );
  });
});
