/**
 * `streamOwners.ts` 的引用计数单测。
 *
 * 测试价值
 * - 生产入口与可观察结果：`createPsbStreamOwnerRegistry()` 是「多窗口看同一路串流」与
 *   「帧只发给正在看的窗口」的唯一记账实现（`ipc.ts` / `push.ts` 共用）。用户可观察结果：
 *   窗口 A 关掉面板不会把仍在观看的窗口 B 的画面停掉；最后一个窗口离开时 PSB 观看名额才释放。
 * - Bug／规则依据：旧实现 `Map<sessionId, webContentsId>` 只记最后一个启动者，多窗口交替
 *   进出时会误停流 / 重复停流（review r2）。PSB 观看名额与浏览器端共用（默认 4）。
 * - 现有覆盖缺口：`ipc.ts` 需要 Electron 才能跑，无法直接单测；这段计数逻辑是其中唯一
 *   有分支的部分，抽成纯结构后由本文件覆盖。
 * - 最小失败输入：同一 key 两个 owner，先移除一个（必须不为空）、再移除另一个（必须为空）；
 *   窗口销毁一次清掉多个 key；重复移除同一 owner 必须幂等。
 * - tier：unit（纯内存结构，无 Electron / 网络）。
 * - 实测耗时：单独运行 < 1s。
 */

import { describe, expect, it } from 'vitest';

import { createPsbStreamOwnerRegistry } from '../streamOwners';

describe('createPsbStreamOwnerRegistry：多窗口串流引用计数', () => {
  it('两个窗口看同一路：先离开的只减计数，最后离开才归零', () => {
    const registry = createPsbStreamOwnerRegistry();
    expect(registry.add('ws-1', 1)).toBe(true);
    expect(registry.add('ws-1', 2)).toBe(false);
    expect(registry.owners('ws-1')).toEqual([1, 2]);

    expect(registry.remove('ws-1', 1)).toBe(false);
    expect(registry.owners('ws-1')).toEqual([2]);
    expect(registry.remove('ws-1', 2)).toBe(true);
    expect(registry.owners('ws-1')).toEqual([]);
    expect(registry.size()).toBe(0);
  });

  it('同一窗口重复登记 / 重复移除都是幂等的（不会把计数刷高或提前归零）', () => {
    const registry = createPsbStreamOwnerRegistry();
    registry.add('ws-1', 7);
    registry.add('ws-1', 7);
    expect(registry.remove('ws-1', 7)).toBe(true);
    // 已经归零：再一次移除不得再次报告「应当停流」（否则会重复 stopStream）。
    expect(registry.remove('ws-1', 7)).toBe(false);
  });

  it('窗口销毁兜底：一次清掉它所有的 key，返回被清空（其它窗口不再观看）的 key', () => {
    const registry = createPsbStreamOwnerRegistry();
    registry.add('ws-1', 1);
    registry.add('ws-1', 2);
    registry.add('ws-2', 1);
    registry.add('ws-3', 3);

    expect(registry.removeOwner(1).sort()).toEqual(['ws-2']);
    // ws-1 还有窗口 2：不能停流；ws-3 与窗口 1 无关。
    expect(registry.owners('ws-1')).toEqual([2]);
    expect(registry.owners('ws-3')).toEqual([3]);
  });

  it('key 之间的计数互不影响（同一窗口可以同时看多个工作区）', () => {
    const registry = createPsbStreamOwnerRegistry();
    registry.add('a', 1);
    registry.add('b', 1);
    expect(registry.remove('a', 1)).toBe(true);
    expect(registry.owners('b')).toEqual([1]);
  });
});
