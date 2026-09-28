/**
 * Regression coverage for the market Plugin detail view's explicit same-ID
 * replacement action and its data-preservation explanation.
 *
 * 主操作按钮已迁到共享 `Button`（上游结构），Meka 侧在其上保留自己的进度口径：
 * `loading={busy && !progress}` —— 只有「忙但没有 progress」时才走 loading 遮罩；
 * 「忙且有 progress」（Meka 渠道安装/更新会下发进度）时必须继续渲染进度文案与进度条，
 * 不能被遮罩吃掉。两种状态各有独立用例，改动任一分支都必须同时看这两条。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 * @vitest-environment jsdom
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { MarketPluginDetailView } from '../MarketPluginDetailView';
import type { GhostManifest } from '../../../../shared/ghost';
import type { PluginMarketDetail } from '../../../../shared/pluginMarket';

const manifest: GhostManifest = {
  schemaVersion: 2,
  id: 'google-calendar',
  name: 'Google Calendar',
  version: '1.3.11',
  kind: 'chip',
  entry: 'main.js',
  notify: true,
};

const detail: PluginMarketDetail = {
  pluginId: 'release-google-calendar',
  ghostId: 'google-calendar',
  name: 'Google Calendar',
  description: 'Connect Google Calendar',
  author: 'Cindy',
  scope: 'public',
  organizationId: null,
  defaultInstall: false,
  releaseId: 'release-1',
  version: '1.3.11',
  publishedAt: '2026-07-25T00:00:00.000Z',
  icon: null,
  installState: 'not-installed',
  enabled: null,
  sourceType: 'server',
  sourceMarketName: null,
  manifest,
};

const renderDetail = (overrides: Partial<PluginMarketDetail> = {}) =>
  render(
    <MarketPluginDetailView
      detail={{ ...detail, ...overrides }}
      busy={false}
      onBack={vi.fn()}
      onInstall={vi.fn()}
      onIconLoadError={vi.fn()}
    />,
  );

describe('MarketPluginDetailView', () => {
  it('shows the marketing description outside the conflict state', () => {
    renderDetail();
    const description = screen.getByText('Connect Google Calendar');
    expect(description.id).toBe('');
    expect(
      screen
        .getByRole('button', { name: /settings\.ghosts\.market\.install/ })
        .getAttribute('aria-describedby'),
    ).toBeNull();
  });

  it('presents server catalog permissions before the package is downloaded', () => {
    renderDetail();
    expect(screen.getByText('settings.ghosts.perm.grantsTitle')).toBeTruthy();
  });

  it('offers an explicit same-id replacement and binds its explanation to the action', () => {
    renderDetail({ installState: 'conflict' });

    const reason = screen.getByText('settings.ghosts.market.replaceDescription');
    expect(reason.id).toBeTruthy();
    // 冲突态下正文让位给原因,不再显示营销描述。
    expect(screen.queryByText('Connect Google Calendar')).toBeNull();

    const action = screen.getByRole('button', {
      name: /settings\.ghosts\.market\.replace$/,
    }) as HTMLButtonElement;
    expect(action.disabled).toBe(false);
    expect(action.getAttribute('aria-describedby')).toBe(reason.id);
  });

  it('falls back to the ghostId when a plugin has no description', () => {
    renderDetail({ description: null });
    expect(screen.getByText('google-calendar')).toBeTruthy();
  });

  it('hides the install action when the host does not provide one', () => {
    render(
      <MarketPluginDetailView
        detail={detail}
        busy={false}
        onBack={vi.fn()}
        onIconLoadError={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /settings\.ghosts\.market\.install/ })).toBeNull();
  });

  it('replaces the install action with a spinner while busy', () => {
    render(
      <MarketPluginDetailView
        detail={detail}
        busy
        onBack={vi.fn()}
        onInstall={vi.fn()}
        onIconLoadError={vi.fn()}
      />,
    );

    const action = screen.getByRole('button', {
      name: /settings\.ghosts\.market\.install/,
    });
    expect(action.getAttribute('aria-busy')).toBe('true');
    // 共享 Button 的 loading 契约：按钮进入 loading，Spinner 覆盖在操作区上。
    expect(action.querySelector('.animate-spinner')).toBeTruthy();
    // 没有 progress 时与上游同形：文案不是被删掉，而是被收进 `opacity-0` 遮罩
    // （Button 用它保住可访问名称与按钮宽度，见 components/ui/button.tsx 与
    // components/ui/__tests__/button.test.tsx 的同名断言）。旧实现是裸 `<button>`
    // 直接把子节点换成 Spinner，才会得到空 textContent；断言「文案仍在遮罩里」
    // 才同时钉住「可见文案被 spinner 取代」和「可访问名称不丢」。
    expect(action.querySelector('.opacity-0')?.textContent).toBe('settings.ghosts.market.install');
    expect(action.getAttribute('aria-label')).toBe('settings.ghosts.market.install');
    // 上游同一条用例的结构断言，一并保留（不替代上面的语义断言）：
    // 遮罩是首个子元素、Spinner 是末个子元素且对 AT 隐藏、loading 期间按钮真 disabled。
    expect(action.firstElementChild?.classList.contains('opacity-0')).toBe(true);
    expect(action.firstElementChild?.textContent).toBe('settings.ghosts.market.install');
    expect(action.lastElementChild?.getAttribute('aria-hidden')).toBe('true');
    expect(action.hasAttribute('disabled')).toBe(true);
  });

  it('keeps the channel install progress visible in the action while busy', () => {
    render(
      <MarketPluginDetailView
        detail={detail}
        busy
        progress={{
          operationId: '6f1d4c2e-9a3b-4c5d-8e7f-0a1b2c3d4e5f',
          pluginId: 'release-google-calendar',
          phase: 'downloading',
          downloadedBytes: 25,
          totalBytes: 100,
        }}
        onBack={vi.fn()}
        onInstall={vi.fn()}
        onIconLoadError={vi.fn()}
      />,
    );

    // Meka 口径：Meka 渠道（`progress` 非空）在下载/安装阶段必须让进度文案与进度条
    // 继续可见——既不套 `opacity-0` 遮罩，也不渲染遮罩用的 Spinner，否则用户只看到
    // 一个转圈，看不到同一操作的真实阶段（这是本轮合并要保留的产品差异）。
    const action = screen.getByRole('button', {
      name: 'settings.ghosts.market.downloading',
    });
    expect(action.getAttribute('aria-busy')).toBe('true');
    expect(action.querySelector('.animate-spinner')).toBeNull();
    expect(action.querySelector('.opacity-0')).toBeNull();
    // 进度文案可见，且安装文案不再出现在主操作里。
    expect(screen.getByText('settings.ghosts.market.downloading')).toBeTruthy();
    expect(screen.queryByText('settings.ghosts.market.install')).toBeNull();
    // 进度条按真实下载比例落点（25/100）。
    const bar = action.querySelector('[aria-hidden="true"].absolute');
    expect(bar).toBeTruthy();
    expect((bar?.querySelector('span') as HTMLElement | null)?.style.width).toBe('25%');
    // 可访问名称不变量：有 progress 时按钮的可访问名称继续非空。这里刻意让它取自
    // 可见的进度文案（组件在该分支不写 aria-label）：aria-label 会**覆盖**子节点文本，
    // 而主操作此刻唯一的进度播报通道就是这个文本，写死成 action 文案反而会把阶段
    // 信息从无障碍树里抹掉。同一口径见 GhostPluginPage.tsx 的 `GhostPluginCard`
    // 列表更新按钮（`aria-label={updateProgress ? undefined : …}`，本轮同步后
    // 落在 2925-2932 行，`loading={updatePending && !updateProgress}` 在 2920 行），
    // 两处不得分叉。
  });
});
