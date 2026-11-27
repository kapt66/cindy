/**
 * 工作区选择行的**键盘与 ARIA**（弹窗与草稿页下拉共用一份实现）。
 *
 * 为什么需要共享：两个入口原来是手写的 —— 弹窗只有 `role=radiogroup/radio` 却没有方向键与
 * roving tabindex，草稿页下拉是 `role=listbox/option` 却把焦点留在容器里、方向键完全没处理，
 * 键盘用户只能逐个 Tab。这里按 WAI-ARIA 的 radio group / list box 键盘惯例统一：
 *
 *   - Tab 只落在**一个**行上（roving tabindex：选中项，否则第一个可用项），Tab 进出列表一次；
 *   - ↑/↓/←/→ 在**可用行**之间移动（禁用/不可用行跳过，两端环绕），Home/End 到首/尾；
 *   - `radiogroup` 里移动焦点 = 改变选中（radio 惯例，选中不触发占用）；
 *     `listbox` 里移动焦点只移动焦点，Enter/Space 才激活。
 *
 * 2026-11-27 起**两个容器都用 `listbox`**：行激活会先弹「占用确认」并真的占用工作区，
 * 键盘浏览时焦点跟随选中（radio 惯例）会反复弹确认框/占用行，不符合「先看再决定」。
 * 行本身仍是原生 `<button>`，Enter/Space 激活由浏览器保证。
 *
 * 行本身是不可用 `disabled` 的（无法聚焦、Tab 跳过）；**在途忙** 的行由容器改用
 * `aria-disabled`（仍可聚焦），这样开始占用的一刹那焦点不会丢到 body。
 */

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';

export type PsbWorkspaceListRole = 'radiogroup' | 'listbox';

export interface PsbWorkspaceListKeyboardOptions {
  /** 容器 ARIA 角色（当前两个选择器容器都用 `listbox`；`radiogroup` 保留给聚焦即选中的场景）。 */
  readonly role: PsbWorkspaceListRole;
  /** 容器可访问名（已本地化）。 */
  readonly ariaLabel: string;
  /** 行数（含不可用行；不可用行不进入键盘序列）。 */
  readonly itemCount: number;
  /** 第 index 行此刻是否可被键盘聚焦（不可用行 = false）。 */
  readonly isEnabled: (index: number) => boolean;
  /** 当前选中项（-1 = 没有选中）。radio 用它做 tab stop；listbox 用它初始化 tab stop。 */
  readonly selectedIndex: number;
  /** 方向键 / Home / End 移动后：radio 跟随焦点选中，listbox 由容器只更新焦点。 */
  readonly onMoveFocus: (index: number) => void;
}

export interface PsbWorkspaceListKeyboard {
  readonly containerProps: {
    readonly role: PsbWorkspaceListRole;
    readonly 'aria-label': string;
    readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  };
  /** 行元素 props：角色、选中态、roving tabIndex、ref 注册。 */
  getItemProps(index: number): {
    readonly role: 'radio' | 'option';
    readonly tabIndex: number;
    readonly 'aria-checked'?: boolean;
    readonly 'aria-selected'?: boolean;
    readonly ref: (element: HTMLButtonElement | null) => void;
    readonly onFocus: () => void;
  };
  /** 点击/程序化激活某行后同步 roving tab stop（焦点已经在行上时也保持 Tab 顺序正确）。 */
  readonly noteActivated: (index: number) => void;
}

function firstEnabledIndex(
  itemCount: number,
  isEnabled: (index: number) => boolean,
): number {
  for (let index = 0; index < itemCount; index += 1) {
    if (isEnabled(index)) return index;
  }
  return -1;
}

function stepEnabledIndex(
  from: number,
  direction: 1 | -1,
  itemCount: number,
  isEnabled: (index: number) => boolean,
): number {
  if (itemCount <= 0) return -1;
  let index = from;
  for (let step = 0; step < itemCount; step += 1) {
    index = (index + direction + itemCount) % itemCount;
    if (isEnabled(index)) return index;
  }
  return -1;
}

/**
 * @internal 供单测直接钉键盘规则（不挂 DOM 时也能验证「跳过不可用行 + 环绕」）。
 */
export function psbWorkspaceKeyboardTarget(
  key: string,
  from: number,
  options: {
    readonly itemCount: number;
    readonly isEnabled: (index: number) => boolean;
  },
): number | null {
  const { itemCount, isEnabled } = options;
  switch (key) {
    case 'ArrowDown':
    case 'ArrowRight':
      return stepEnabledIndex(from < 0 ? -1 : from, 1, itemCount, isEnabled);
    case 'ArrowUp':
    case 'ArrowLeft':
      return stepEnabledIndex(from < 0 ? 0 : from, -1, itemCount, isEnabled);
    case 'Home':
      return firstEnabledIndex(itemCount, isEnabled);
    case 'End': {
      for (let index = itemCount - 1; index >= 0; index -= 1) {
        if (isEnabled(index)) return index;
      }
      return -1;
    }
    default:
      return null;
  }
}

export function usePsbWorkspaceListKeyboard(
  options: PsbWorkspaceListKeyboardOptions,
): PsbWorkspaceListKeyboard {
  const { role, ariaLabel, itemCount, isEnabled, selectedIndex, onMoveFocus } = options;
  const elementsRef = useRef<(HTMLButtonElement | null)[]>([]);
  /** 键盘/点击带来的「当前焦点行」；null = 跟随选中项。 */
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);

  // 选中项变化（列表刷新、外部换工作区）时把 tab stop 交回选中项。
  useEffect(() => {
    setFocusedIndex(null);
  }, [selectedIndex]);

  // 行数缩短后旧的焦点下标可能越界。
  useEffect(() => {
    setFocusedIndex((current) =>
      current !== null && current < itemCount ? current : null,
    );
  }, [itemCount]);

  const fallbackIndex = firstEnabledIndex(itemCount, isEnabled);
  const baseIndex = isEnabled(selectedIndex) ? selectedIndex : fallbackIndex;
  const tabStopIndex =
    focusedIndex !== null && focusedIndex < itemCount && isEnabled(focusedIndex)
      ? focusedIndex
      : baseIndex;

  const focusIndex = useCallback(
    (index: number) => {
      if (index < 0) return;
      setFocusedIndex(index);
      elementsRef.current[index]?.focus();
    },
    [],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      // 不用 event.currentTarget 判断：焦点在行按钮上，事件冒泡到这里。
      const target = psbWorkspaceKeyboardTarget(event.key, tabStopIndex, {
        itemCount,
        isEnabled,
      });
      if (target === null || target < 0) return;
      event.preventDefault();
      onMoveFocus(target);
      focusIndex(target);
    },
    [focusIndex, isEnabled, itemCount, onMoveFocus, tabStopIndex],
  );

  const noteActivated = useCallback((index: number) => {
    setFocusedIndex(index);
  }, []);

  const getItemProps = useCallback(
    (index: number) => ({
      role: role === 'radiogroup' ? ('radio' as const) : ('option' as const),
      tabIndex: index === tabStopIndex ? 0 : -1,
      ...(role === 'radiogroup'
        ? { 'aria-checked': index === selectedIndex }
        : { 'aria-selected': index === selectedIndex }),
      ref: (element: HTMLButtonElement | null) => {
        elementsRef.current[index] = element;
      },
      onFocus: () => setFocusedIndex(index),
    }),
    [role, selectedIndex, tabStopIndex],
  );

  return {
    containerProps: { role, 'aria-label': ariaLabel, onKeyDown: handleKeyDown },
    getItemProps,
    noteActivated,
  };
}
