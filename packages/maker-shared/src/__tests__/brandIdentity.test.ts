import { describe, expect, it } from 'vitest';
import { BRAND_NAME } from '../branding.js';
import {
  BRAND_IDENTITY,
  CINDY_INTEROP_DEEP_LINK_SCHEMES,
  CINDY_INTEROP_PRIMARY_SCHEME,
  DEFAULT_CINDY_REGION,
  allAcceptedDeepLinkSchemes,
  allDeepLinkSchemes,
  allUserDataDirNames,
  brandAppId,
  brandBundleIdPrefix,
  brandDesktopDeviceId,
  brandDesktopIsolatedDeviceId,
  brandExecutableName,
  brandFileAssociationProgId,
  brandUserDataDirName,
  resolveCindyRegion,
} from '../brandIdentity.js';

/**
 * brand-identity 是标识符层单点,消费方(forge / main 常量 / release 脚本)
 * 对格式有硬约束。这里锁住形状与不变量,防止改名/改值时把非法字符或自相
 * 矛盾的配置带上线——这类错误 typecheck 拦不住,只有到 OS 注册/更新链路
 * 运行时才爆炸。
 */
describe('BRAND_IDENTITY invariants', () => {
  it('displayName 与 branding.ts 的 BRAND_NAME 同源', () => {
    expect(BRAND_IDENTITY.displayName).toBe(BRAND_NAME);
  });

  it('cdnPrefix / dbFilePrefix / updaterName 是安全的小写文件名段', () => {
    // 要进 OSS key(大小写敏感)与文件路径,统一小写规避平台差异。
    const fileSafe = /^[a-z0-9][a-z0-9-]*$/;
    expect(BRAND_IDENTITY.cdnPrefix).toMatch(fileSafe);
    expect(BRAND_IDENTITY.dbFilePrefix).toMatch(fileSafe);
    for (const prefix of BRAND_IDENTITY.legacyDbFilePrefixes) {
      expect(prefix).toMatch(fileSafe);
    }
    expect(BRAND_IDENTITY.updaterName).toMatch(fileSafe);
    expect(BRAND_IDENTITY.desktopDeviceIdPrefix).toMatch(/^[a-z0-9][a-z0-9-]*-$/);
  });

  it('executableName / userDataDirName 是安全的文件名段(允许首字母大写)', () => {
    // executableName 首字母大写是产品决策(Cindy.exe,同 Discord/Slack 惯例):
    // Windows 进程匹配大小写不敏感,mac Mach-O 名对用户不可见;OSS key 等大小写
    // 敏感场景一律走小写的 cdnPrefix,不用本字段。userDataDirName 同理
    // (Electron productName 惯例)。区域值不含空格(owner 决策,双装路径安全)。
    const dirSafe = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
    expect(BRAND_IDENTITY.executableName).toMatch(dirSafe);
    expect(BRAND_IDENTITY.userDataDirName).toMatch(dirSafe);
    for (const region of ['cn', 'global'] as const) {
      expect(BRAND_IDENTITY.executableNameByRegion[region]).toMatch(dirSafe);
      expect(BRAND_IDENTITY.userDataDirNameByRegion[region]).toMatch(dirSafe);
    }
    for (const dir of BRAND_IDENTITY.legacyUserDataDirNames) {
      expect(dir).toMatch(dirSafe);
    }
  });

  it('正式服务区共享安装身份，dev 保持独立', () => {
    expect(BRAND_IDENTITY.executableNameByRegion.cn)
      .toBe(BRAND_IDENTITY.executableNameByRegion.global);
    expect(BRAND_IDENTITY.userDataDirNameByRegion.cn)
      .toBe(BRAND_IDENTITY.userDataDirNameByRegion.global);
    expect(BRAND_IDENTITY.executableNameByRegion.dev)
      .not.toBe(BRAND_IDENTITY.executableNameByRegion.global);
  });

  it('cn 区域值 = 基线标量字段', () => {
    expect(BRAND_IDENTITY.executableNameByRegion.cn).toBe(BRAND_IDENTITY.executableName);
    expect(BRAND_IDENTITY.userDataDirNameByRegion.cn).toBe(BRAND_IDENTITY.userDataDirName);
  });

  it('scheme 符合 RFC 3986(字母开头,字母/数字/+/-/. 组成)且主 scheme 不在 legacy 里', () => {
    const schemeRe = /^[a-z][a-z0-9+.-]*$/;
    expect(BRAND_IDENTITY.primaryScheme).toMatch(schemeRe);
    for (const s of BRAND_IDENTITY.legacySchemes) {
      expect(s).toMatch(schemeRe);
    }
    expect(BRAND_IDENTITY.legacySchemes).not.toContain(BRAND_IDENTITY.primaryScheme);
  });

  it('appId 两区都是同一个反向域名格式的正式身份', () => {
    const rdnRe = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$/;
    expect(BRAND_IDENTITY.appIdByRegion.cn).toMatch(rdnRe);
    expect(BRAND_IDENTITY.appIdByRegion.global).toMatch(rdnRe);
    expect(BRAND_IDENTITY.appIdByRegion.cn).toBe(BRAND_IDENTITY.appIdByRegion.global);
  });

  it('legacy userData / DB 前缀不含当前值(历史表只放旧值)', () => {
    expect(BRAND_IDENTITY.legacyUserDataDirNames).not.toContain(
      BRAND_IDENTITY.userDataDirName,
    );
    expect(BRAND_IDENTITY.legacyDbFilePrefixes).not.toContain(
      BRAND_IDENTITY.dbFilePrefix,
    );
  });

  it('Cindy Meka 新身份与 XDMaker Meka 迁移锚保持分离', () => {
    expect(BRAND_IDENTITY.legacySchemes).toContain('xdt-maker');
    expect(BRAND_IDENTITY.legacyUserDataDirNames).toEqual(['xdmaker-meka', 'xdt-maker']);
    expect(BRAND_IDENTITY.executableName).toBe('CindyMeka');
    expect(BRAND_IDENTITY.appIdByRegion.cn).toBe('com.xd.cindy.meka');
    expect(BRAND_IDENTITY.userDataDirName).toBe('CindyMeka');
    expect(BRAND_IDENTITY.dbFilePrefix).toBe('cindy-meka');
    expect(BRAND_IDENTITY.cdnPrefix).toBe('cindy-meka');
    expect(BRAND_IDENTITY.desktopDeviceIdPrefix).toBe('cindy-meka-');
    expect(BRAND_IDENTITY.updaterName).toBe('cindy-meka-updater');
    expect(brandFileAssociationProgId()).toBe('CindyMeka.CindyGhost');
    expect(BRAND_IDENTITY.legacyDbFilePrefixes).toEqual(['xdt-maker']);
  });

  it('档案与内嵌数组已冻结,消费方无法运行时篡改', () => {
    expect(Object.isFrozen(BRAND_IDENTITY)).toBe(true);
    expect(Object.isFrozen(BRAND_IDENTITY.appIdByRegion)).toBe(true);
    expect(Object.isFrozen(BRAND_IDENTITY.executableNameByRegion)).toBe(true);
    expect(Object.isFrozen(BRAND_IDENTITY.userDataDirNameByRegion)).toBe(true);
    expect(Object.isFrozen(BRAND_IDENTITY.fileAssociationProgIdByRegion)).toBe(true);
    expect(Object.isFrozen(BRAND_IDENTITY.legacySchemes)).toBe(true);
    expect(Object.isFrozen(BRAND_IDENTITY.acceptedUnregisteredSchemes)).toBe(true);
    expect(Object.isFrozen(BRAND_IDENTITY.legacyUserDataDirNames)).toBe(true);
    expect(Object.isFrozen(BRAND_IDENTITY.legacyDbFilePrefixes)).toBe(true);
  });
});

describe('区域解析与派生', () => {
  it('resolveCindyRegion:空值 → 默认 global;合法值归一化;非法值抛错', () => {
    expect(resolveCindyRegion(undefined)).toBe('global');
    expect(resolveCindyRegion(null)).toBe('global');
    expect(resolveCindyRegion('')).toBe('global');
    expect(resolveCindyRegion('  ')).toBe('global');
    expect(resolveCindyRegion('cn')).toBe('cn');
    expect(resolveCindyRegion('global')).toBe('global');
    expect(resolveCindyRegion('GLOBAL')).toBe('global');
    expect(() => resolveCindyRegion('us')).toThrow(/Invalid Cindy region/);
  });

  it('brandAppId / brandBundleIdPrefix 正式服务区固定,默认 global', () => {
    expect(DEFAULT_CINDY_REGION).toBe('global');
    expect(brandAppId()).toBe('com.xd.cindy.meka');
    expect(brandAppId('global')).toBe('com.xd.cindy.meka');
    expect(brandBundleIdPrefix('cn')).toBe('com.xd.cindy.meka');
    expect(brandBundleIdPrefix('global')).toBe('com.xd.cindy.meka');
  });

  it('brandExecutableName / brandUserDataDirName 按区域取值,默认 global', () => {
    expect(brandExecutableName()).toBe('CindyMeka');
    expect(brandExecutableName('global')).toBe('CindyMeka');
    expect(brandExecutableName('dev')).toBe('CindyMekaDev');
    expect(brandUserDataDirName()).toBe('CindyMeka');
    expect(brandUserDataDirName('global')).toBe('CindyMeka');
  });
});

describe('派生 helper', () => {
  it('Desktop deviceId 保留 Cindy Meka 前缀、与裸 Cindy 指纹隔离且不超过 64 字符', () => {
    const machineId = 'a'.repeat(100);
    expect(brandDesktopDeviceId(' machine-id ')).toBe('cindy-meka-machine-id');
    expect(brandDesktopDeviceId(machineId)).toHaveLength(64);
    expect(brandDesktopDeviceId(machineId)).toMatch(/^cindy-meka-/);
    expect(brandDesktopDeviceId(machineId)).not.toBe(machineId.slice(0, 64));
    expect(() => brandDesktopDeviceId('   ')).toThrow('machine id is required');
  });

  it('isolated Desktop deviceId 在产品前缀下继续按沙箱分家', () => {
    expect(brandDesktopIsolatedDeviceId('machine-id')).toBe('cindy-meka-dev-machine-id');
    expect(brandDesktopIsolatedDeviceId('machine-id', 'feature-a')).toBe(
      'cindy-meka-dev-feature-a-machine-id',
    );
    expect(brandDesktopIsolatedDeviceId('a'.repeat(100), 'n'.repeat(32))).toHaveLength(64);
    expect(() => brandDesktopIsolatedDeviceId('machine-id', '非法')).toThrow(
      'invalid isolation name',
    );
  });

  it('allDeepLinkSchemes 主 scheme 恒为首位且包含全部 legacy', () => {
    expect(allDeepLinkSchemes()).toEqual(['cindy-meka', 'xdmaker-meka', 'xdt-maker']);
  });

  it('接受上游 cindy:// 但不把它加入 OS 注册集合', () => {
    expect(allAcceptedDeepLinkSchemes()).toEqual([
      'cindy-meka',
      'xdmaker-meka',
      'xdt-maker',
      'cindy',
    ]);
    expect(allDeepLinkSchemes()).not.toContain('cindy');
  });

  it('Meka 桌面身份不会改写 Cindy mobile/device-link wire scheme', () => {
    expect(CINDY_INTEROP_PRIMARY_SCHEME).toBe('cindy');
    expect(CINDY_INTEROP_DEEP_LINK_SCHEMES).toEqual(['cindy', 'xdt-maker']);
    expect(Object.isFrozen(CINDY_INTEROP_DEEP_LINK_SCHEMES)).toBe(true);
  });

  it('allUserDataDirNames 正式目录名恒为首位 + 全部历史值', () => {
    expect(allUserDataDirNames()).toEqual(['CindyMeka', 'xdmaker-meka', 'xdt-maker']);
    expect(allUserDataDirNames('cn')).toEqual(['CindyMeka', 'xdmaker-meka', 'xdt-maker']);
    expect(allUserDataDirNames('global')).toEqual(['CindyMeka', 'xdmaker-meka', 'xdt-maker']);
  });

  it('helper 接受显式档案参数(历史身份回放用)', () => {
    const legacyLike = {
      ...BRAND_IDENTITY,
      primaryScheme: 'xdt-maker',
      legacySchemes: [],
      acceptedUnregisteredSchemes: [],
      userDataDirNameByRegion: {
        cn: 'xdt-maker',
        global: 'xdt-maker',
        dev: 'xdt-maker',
      },
      legacyUserDataDirNames: [],
      dbFilePrefix: 'xdt-maker',
      legacyDbFilePrefixes: [],
    };
    expect(allDeepLinkSchemes(legacyLike)).toEqual(['xdt-maker']);
    expect(allUserDataDirNames('cn', legacyLike)).toEqual(['xdt-maker']);
  });
});
