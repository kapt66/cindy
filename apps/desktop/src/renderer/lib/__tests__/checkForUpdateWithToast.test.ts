// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  checkForUpdate: vi.fn(),
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/toast', () => ({
  toast: mocks.toast,
}));

import { checkForUpdateWithToast } from '../checkForUpdateWithToast';

const t = (key: string): string => key;

describe('checkForUpdateWithToast', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      checkForUpdate: mocks.checkForUpdate,
    };
  });

  it('只有 idle 才表示「已经是最新版本了」', async () => {
    mocks.checkForUpdate.mockResolvedValue({ result: 'idle' });

    await checkForUpdateWithToast(t);

    expect(mocks.toast.success).toHaveBeenCalledWith('titleBar.updateCheckToast.alreadyLatest');
  });

  // 回归护栏:清单里广告了更高版本、只是本平台这一轮没有可安装资产时,主进程曾返回
  // 'idle',于是弹「已经是最新版本了」——在明明有新版本时对用户说反话。
  it('no_asset 如实告知有新版但没有可用安装包,不复用「已是最新」', async () => {
    mocks.checkForUpdate.mockResolvedValue({ result: 'no_asset' });

    await checkForUpdateWithToast(t);

    expect(mocks.toast.warning).toHaveBeenCalledWith('titleBar.updateCheckToast.noAsset');
    expect(mocks.toast.success).not.toHaveBeenCalled();
  });

  // 版本无关(占位 0.0.0)包被有意排除在自动更新之外,那不是「已是最新」,而是
  // 「这个包不参与更新」;两者对用户的下一步完全不同。
  it('versionless 如实告知本地构建不参与自动更新,不复用「已是最新」', async () => {
    mocks.checkForUpdate.mockResolvedValue({ result: 'versionless' });

    await checkForUpdateWithToast(t);

    expect(mocks.toast.warning).toHaveBeenCalledWith('titleBar.updateCheckToast.versionless');
    expect(mocks.toast.success).not.toHaveBeenCalled();
  });

  it('apply_exhausted 保持既有的「已停止自动更新,请手动安装」提示', async () => {
    mocks.checkForUpdate.mockResolvedValue({ result: 'apply_exhausted' });

    await checkForUpdateWithToast(t);

    expect(mocks.toast.warning).toHaveBeenCalledWith('titleBar.updateCheckToast.applyExhausted');
    expect(mocks.toast.success).not.toHaveBeenCalled();
  });
});
