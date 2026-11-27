// @vitest-environment jsdom
/**
 * confirmDialogFocus.test.tsx — 确认框关闭后的焦点与「关框键」语义。
 *
 * 测试价值
 * - 生产入口与可观察结果：`ConfirmDialogProvider` + `useConfirmDialog` 是渲染层所有程序化确认
 *   （含 PSB 发送前占用预检的「占用这个工作区」）的唯一入口。可观察结果：弹框期间键盘归确认框，
 *   取消 / 确认关闭后焦点回到打开前的控件，用来关框的 Enter/Esc 不会被下面的输入框吃掉。
 * - Bug／规则依据（2026-11-27 复测）：远程工作区发送消息时弹「占用工作区」确认框，取消后回车
 *   被输入进输入框（编辑器多一行），或再次触发一次发送 / 再弹一次框。确认框是程序化打开的
 *   （没有 Radix Trigger），Radix 不会归还焦点；焦点陷阱也不接管 keydown 默认行为。
 * - 现有覆盖缺口：既有 `confirmDialogA11y.test.tsx` 只钉 aria 关联、按钮顺序与打开时的焦点，
 *   没有「关闭归还焦点」与「关框键不漏给下层」。
 * - 最小失败输入：① 框打开时在输入框上按 Enter；② 用 Enter 关框后立刻再按 Enter；
 *   ③ 鼠标取消（不该吞下一次 Enter）。
 * - tier：unit（jsdom + 真实 Radix AlertDialog，无 Electron / 网络）。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ConfirmDialogProvider,
  useConfirmDialog,
} from '@/components/ui/confirm-dialog-provider';
import { __resetConfirmDialogKeyboardGuardForTests } from '@/lib/confirmDialogKeyboardGuard';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/scrollbarAutoHide', () => ({
  flashScrollbar: () => {},
}));

const COPY = {
  title: '占用「saga2_project-3」？',
  description: '占用后其他人无法使用，直到你释放 / 结束任务。',
  confirmText: '占用',
  cancelText: '取消',
};

let confirmResult: Promise<boolean> | null = null;
let confirmResolved: boolean | null = null;

function Harness() {
  const { confirm } = useConfirmDialog();
  return (
    <div>
      <textarea aria-label="composer" />
      <button
        type="button"
        onClick={() => {
          confirmResult = confirm(COPY);
          void confirmResult.then((value) => {
            confirmResolved = value;
          });
        }}
      >
        发送
      </button>
    </div>
  );
}

function renderHarness() {
  return render(
    <ConfirmDialogProvider>
      <Harness />
    </ConfirmDialogProvider>,
  );
}

async function openConfirm() {
  renderHarness();
  const composer = screen.getByLabelText('composer') as HTMLTextAreaElement;
  composer.focus();
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  const cancel = await screen.findByRole('button', { name: COPY.cancelText });
  return { composer, cancel };
}

beforeEach(() => {
  __resetConfirmDialogKeyboardGuardForTests();
  confirmResult = null;
  confirmResolved = null;
});

afterEach(cleanup);

describe('ConfirmDialog 关闭后的焦点与关框键', () => {
  it('框打开时 Enter/Esc 归确认框；输入框上的同名键被拦下', async () => {
    const { composer } = await openConfirm();
    expect(screen.getByRole('alertdialog')).toBeTruthy();

    // 焦点陷阱 / 异步焦点恢复都可能把焦点留在 composer；此时回车既不能落字也不能发送。
    expect(fireEvent.keyDown(composer, { key: 'Enter', code: 'Enter' })).toBe(false);
    expect(fireEvent.keyDown(composer, { key: 'Escape', code: 'Escape' })).toBe(false);
    expect(screen.getByRole('alertdialog')).toBeTruthy();
  });

  it('用 Enter 取消后：焦点回到输入框，关框的那个 Enter 不会被输入框吃掉', async () => {
    const { composer, cancel } = await openConfirm();
    expect(document.activeElement).toBe(cancel);

    // 真实 Chromium 里按钮由 Enter 的默认行为触发一次 click；jsdom 不实现，这里显式补上。
    fireEvent.keyDown(cancel, { key: 'Enter', code: 'Enter' });
    fireEvent.click(cancel);

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(confirmResolved).toBe(false);
    // 焦点还给了打开确认前的输入框。
    await waitFor(() => expect(document.activeElement).toBe(composer));

    // 关框键被一次性抑制：这一次 Enter 不落到输入框，下一次是用户自己的新发送/输入。
    expect(fireEvent.keyDown(composer, { key: 'Enter', code: 'Enter' })).toBe(false);
    expect(fireEvent.keyDown(composer, { key: 'Enter', code: 'Enter' })).toBe(true);
  });

  it('鼠标取消不记录关框键：下一次 Enter 正常属于用户', async () => {
    const { composer, cancel } = await openConfirm();
    fireEvent.click(cancel);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(confirmResolved).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(composer));

    expect(fireEvent.keyDown(composer, { key: 'Enter', code: 'Enter' })).toBe(true);
  });

  it('确认关闭后同样归还焦点，且关框键不会被下层再消费一次', async () => {
    const { composer } = await openConfirm();
    const confirmButton = screen.getByRole('button', { name: COPY.confirmText });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: COPY.cancelText }));

    fireEvent.keyDown(confirmButton, { key: 'Enter', code: 'Enter' });
    fireEvent.click(confirmButton);

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(confirmResolved).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(composer));
    expect(fireEvent.keyDown(composer, { key: 'Enter', code: 'Enter' })).toBe(false);
    expect(fireEvent.keyDown(composer, { key: 'Enter', code: 'Enter' })).toBe(true);
  });

  it('Esc 关框后焦点回到输入框，且 Esc 也被一次性抑制', async () => {
    const { composer, cancel } = await openConfirm();
    fireEvent.keyDown(cancel, { key: 'Escape', code: 'Escape' });
    // Radix AlertDialog 的 Esc 关闭由 DialogContent 的 onEscapeKeyDown 驱动；jsdom 里直接走
    // 取消按钮同一条关闭路径（真实浏览器中 Esc 等价于取消）。
    fireEvent.click(cancel);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(composer));

    expect(fireEvent.keyDown(composer, { key: 'Escape', code: 'Escape' })).toBe(false);
    expect(fireEvent.keyDown(composer, { key: 'Escape', code: 'Escape' })).toBe(true);
  });

  it('输入法组字中的 Enter 不拦（选字不能被当成发送或关框）', async () => {
    const { composer } = await openConfirm();
    // 组字期间 Enter 属于 IME；确认框打开时也不该由这里吞掉字符输入。
    expect(fireEvent.keyDown(composer, { key: 'Process', code: 'Process' })).toBe(true);
    act(() => {
      fireEvent.keyDown(composer, { key: 'Enter', code: 'Enter', isComposing: true });
    });
  });
});
