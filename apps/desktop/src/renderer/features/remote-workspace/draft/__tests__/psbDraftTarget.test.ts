/**
 * 测试价值
 * - 生产入口与可观察结果：`readPsbDraftRouteTarget` / `consumePsbDraftRouteTarget` /
 *   `buildPsbDraftTarget` 是「侧栏弹窗 → 草稿页」一次性交接的**唯一入口**
 *   （`NewMakerDraftRoute` 读 history state 调它们）。可观察结果：脏 history state 被丢弃后
 *   得到什么目标、目标头显示什么、交接标记是否被消费。
 * - Bug／规则依据：`draft/psbDraftTarget.ts` 文件头（路由 state 会进浏览器历史，可能被旧版本
 *   写入或手改；校验不过就整块丢弃）+ 产品 §2.3（虚拟工作目录 `/psb-remote/<name>` 只是引用）。
 *   2026-11-26 独立审查：`directoryName` 直接拼进虚拟工作目录，**没有校验** —— `/`、`\`、
 *   `..` 会让虚拟目录出现多余层级或越过前缀语义（且脏值会被侧栏反查匹配逻辑误用）。
 * - 现有覆盖缺口：此前没有任何针对 route state 脏值的测试。
 * - 最小失败输入：`psbTarget.directoryName = '../etc'` / `'a/b'` / `'a\\b'` / 含控制字符。
 * - tier：unit（纯函数，node 环境）。
 */

import { describe, expect, it } from 'vitest';

import {
  buildPsbDraftTarget,
  consumePsbDraftRouteTarget,
  readPsbDraftRouteTarget,
  readPsbDirectoryName,
} from '../psbDraftTarget';

const BASE_STATE = {
  psbTarget: {
    workspaceId: 'ws-1',
    clientId: 'client-1',
    clientName: '打包机',
    workspaceTitle: 'saga2_project',
    directoryName: 'saga2_project',
  },
};

describe('readPsbDraftRouteTarget', () => {
  it('读取合法交接载荷（工作区级，无 sessionId）', () => {
    expect(readPsbDraftRouteTarget(BASE_STATE)).toEqual({
      workspaceId: 'ws-1',
      clientId: 'client-1',
      clientName: '打包机',
      workspaceTitle: 'saga2_project',
      directoryName: 'saga2_project',
    });
    expect(buildPsbDraftTarget(readPsbDraftRouteTarget(BASE_STATE)!)).toEqual({
      workspaceId: 'ws-1',
      clientId: 'client-1',
      clientName: '打包机',
      workspaceTitle: 'saga2_project',
      directoryName: 'saga2_project',
      sessionId: null,
    });
  });

  it('没有 workspaceId / 形状不成立时整块丢弃（目标必须可占用/建会话）', () => {
    expect(readPsbDraftRouteTarget(null)).toBeNull();
    expect(readPsbDraftRouteTarget({})).toBeNull();
    expect(readPsbDraftRouteTarget({ psbTarget: { clientId: 'c' } })).toBeNull();
    expect(readPsbDraftRouteTarget({ psbTarget: [] })).toBeNull();
  });

  it.each([
    ['含正斜杠的路径', '../etc'],
    ['含反斜杠的路径', 'a\\b'],
    ['只有 .. 的目录', '..'],
    ['含 .. 的目录名', 'a..b'],
    ['绝对路径', '/tmp/x'],
    ['空控制字符', 'a\u0000b'],
  ])('history state 里的脏 directoryName（%s）被丢弃，只保留工作区目标', (_name, dirty) => {
    const target = readPsbDraftRouteTarget({
      psbTarget: { ...BASE_STATE.psbTarget, directoryName: dirty },
    });
    expect(target).not.toBeNull();
    expect(target?.workspaceId).toBe('ws-1');
    // 丢弃一个展示字段不影响目标本身；虚拟目录会退回工作区 id（`buildPsbVirtualWorkingDir`）。
    expect(target?.directoryName).toBeNull();
  });

  it('超长目录名被丢弃（虚拟目录与日志都不该被一条脏 state 撑爆）', () => {
    expect(readPsbDirectoryName('a'.repeat(256))).toBeNull();
    expect(readPsbDirectoryName('a'.repeat(255))).toBe('a'.repeat(255));
  });
});

describe('consumePsbDraftRouteTarget', () => {
  it('只消费 psbTarget，其它 route state 原样保留（一次性导航指令）', () => {
    const state = { ...BASE_STATE, workspacePrompt: { text: 'hi' } };
    expect(consumePsbDraftRouteTarget(state)).toEqual({ workspacePrompt: { text: 'hi' } });
    // 没有交接标记时返回原对象（调用方据此决定是否 replace 导航）。
    expect(consumePsbDraftRouteTarget({ workspacePrompt: 1 })).toEqual({ workspacePrompt: 1 });
    expect(consumePsbDraftRouteTarget(null)).toBeNull();
  });
});
