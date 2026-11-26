// @vitest-environment jsdom

/**
 * 测试价值
 * - 生产入口与可观察结果：真实渲染 `DeviceSwitcherPill`（创建页位置渠道菜单），断言「远程工作区」
 *   作为与「本机 / MCPR远程 / 设备…」并列的渠道出现、可被选中，且选中态反映在 pill 文案上。
 * - Bug／规则依据：产品口径 2026-11-25（远程工作区是位置渠道，不再自绘目标头）。
 * - 现有覆盖缺口：草稿页路由不可挂载；设备 pill 的渠道行是用户进入远程工作区（并看到工作区
 *   下拉）的唯一入口，缺这一行整个功能在界面上不可达。
 * - 最小失败输入：若渠道行没接上 `onPsbRemoteSelect`，点它只会关闭菜单而不切换渠道，
 *   项目胶囊仍列本机项目 —— 用户无法进入远程工作区。
 * - tier：unit（jsdom + 受控 Popover，无网络/进程）。
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DeviceSwitcherPill } from '../DeviceSwitcherPill';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(() => {
  cleanup();
});

function renderPill(overrides: Partial<Parameters<typeof DeviceSwitcherPill>[0]> = {}) {
  const onChange = vi.fn();
  const onOpenChange = vi.fn();
  const onPsbRemoteSelect = vi.fn();
  render(
    <DeviceSwitcherPill
      devices={[]}
      value={null}
      onChange={onChange}
      open
      onOpenChange={onOpenChange}
      onPsbRemoteSelect={onPsbRemoteSelect}
      {...overrides}
    />,
  );
  return { onChange, onOpenChange, onPsbRemoteSelect };
}

describe('DeviceSwitcherPill remote-workspace channel', () => {
  it('lists 远程工作区 next to local / MCPR channels and reports selection', () => {
    const { onPsbRemoteSelect, onOpenChange } = renderPill();

    const rows = screen.getAllByTestId('create-agent-device-option');
    // 本机 + MCPR远程 + 远程工作区（设备列表为空）。
    expect(rows).toHaveLength(3);
    const channelRow = rows.find(
      (row) => row.textContent?.includes('remoteWorkspace.sidebar.title'),
    );
    expect(channelRow).toBeTruthy();
    fireEvent.click(channelRow!);
    expect(onPsbRemoteSelect).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('shows the channel as the current location when selected', () => {
    renderPill({ psbSelected: true });
    // pill 文案从「本机」切换成渠道名（aria-label 同时带上当前值）。
    expect(screen.getByTestId('create-agent-device-pill').getAttribute('aria-label')).toContain(
      'remoteWorkspace.sidebar.title',
    );
  });
});
