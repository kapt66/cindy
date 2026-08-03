import { describe, expect, it } from 'vitest';
import { resolveRegionUserDataDirName } from '../regionUserData';

/**
 * 单安装 Meka 的核心不变量：service realm 不得改写 Electron userData。
 */
describe('resolveRegionUserDataDirName', () => {
  const ARGV = ['CindyMeka.exe'] as const;

  it('packaged + global → null(与 CN 共享固定 Meka userData)', () => {
    expect(
      resolveRegionUserDataDirName({ isPackaged: true, region: 'global', argv: ARGV }),
    ).toBeNull();
  });

  it('packaged + cn → null(区域目录名 = productName 默认,保持原生行为)', () => {
    expect(resolveRegionUserDataDirName({ isPackaged: true, region: 'cn', argv: ARGV })).toBeNull();
  });

  it('dev(非 packaged)任何区域都不覆写(隔离语义归 --isolated)', () => {
    expect(
      resolveRegionUserDataDirName({ isPackaged: false, region: 'cn', argv: ARGV }),
    ).toBeNull();
    expect(
      resolveRegionUserDataDirName({ isPackaged: false, region: 'global', argv: ARGV }),
    ).toBeNull();
  });

  it('显式 --user-data-dir(smoke 脚本临时目录)时不覆写,尊重调用方', () => {
    expect(
      resolveRegionUserDataDirName({
        isPackaged: true,
        region: 'global',
        argv: ['CindyMeka.exe', '--smoke-test', '--user-data-dir=C:\\tmp\\xdt-smoke-x'],
      }),
    ).toBeNull();
    // 空格分隔形态同样尊重。
    expect(
      resolveRegionUserDataDirName({
        isPackaged: true,
        region: 'global',
        argv: ['CindyMeka.exe', '--user-data-dir', 'C:\\tmp\\xdt-smoke-x'],
      }),
    ).toBeNull();
  });
});
