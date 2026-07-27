/**
 * brand-identity — 产品**标识符层**身份的单一事实源(构建期单点)。
 *
 * 与 `branding.ts`(展示名层,`BRAND_NAME`)互补:那边管用户/LLM 看到的名字,
 * 这边管 OS 注册身份与磁盘/协议标识符——exe 名、AppUserModelId/bundle id、
 * 深链 scheme、userData 目录名、CDN 渠道前缀、更新器产物名等。
 *
 * 2026-07 Cindy Meka 身份迁移：新应用的程序与 userData 使用 `CindyMeka`
 * 文件身份；协议、数据库与更新渠道使用机器友好的 `cindy-meka` 身份，并从
 * XDMaker Meka 的 `xdmaker-meka` userData 只读导入数据。旧值只作为兼容输入，
 * 不再作为新包的主身份。
 *
 * ⚠️ 语义边界:
 *  - 这是**构建期单点,不是运行时开关**。区域(cn/global)是唯一的构建期维度,
 *    经打包命令的 CINDY_AUTH_REGION 选择,默认 global。appId / userData 目录名
 *    按区域派生；Cindy Meka 的 cn / global / dev 使用独立 appId、userData
 *    目录和可执行文件名，避免与普通 Cindy 或彼此覆盖。
 *  - 历史兼容锚点(旧 scheme 解析、旧 userData / DB 文件识别)由
 *    `legacySchemes` / `legacyUserDataDirNames` / `legacyDbFilePrefixes`
 *    承载,只增不减:老用户机器上的存量注册与文件可能永远带着旧值。
 *  - 永久不随本配置变化的标识符(settings 键名 `xdtMaker.*`、
 *    `xdt-image://` 等进程内 scheme、`.cshare` 扩展名、
 *    localStorage 键等)由各自协议/存储模块维护,
 *    不要试图从这里派生它们。
 *  - `updaterName` = `cindy-meka-updater`，只属于新 Cindy Meka 渠道；旧
 *    `xdt-updater` 不作为新包资源名复用。
 *    消费方:updateService(resources 源名 + %TEMP% 运行名)、forge prePackage
 *    构建/签名/extraResource、notices 脚本登记路径。
 *
 * 消费方:
 *  - apps/desktop forge.config.ts(executableName / appId / protocols / UTI)
 *  - apps/desktop main 常量(AUMID、深链、orphan-reaper 路径标记、skillhub
 *    usageIndexer 的 userData 兜底路径、localDb 文件名前缀)
 *  - release / publish / smoke 脚本(产物名、OSS 前缀)
 */

import { BRAND_NAME } from './branding.js';

/**
 * 构建期区域维度(与 mobile 的 EXPO_PUBLIC_CINDY_AUTH_REGION 同语义)。
 * 2026-07-20 新增第三目标 `dev`:独立系统身份,可与 cn/global 同机
 * 三装),连接独立的 dev 服务器(config/endpoint.dev.json,服务端就绪前为
 * 约定占位域名)。行为语义上 dev 归 cn 系(登录线/文案等运行时按区域分支处
 * 与 cn 同待遇),差异只在端点与身份。注意与「开发模式(未注入区域的本地
 * dev 构建)」区分:那仍默认 global 身份。
 */
export type CindyRegion = 'cn' | 'global' | 'dev';

/** 默认区域:Global。开发模式 / 未显式注入区域的构建一律落在这里。 */
export const DEFAULT_CINDY_REGION: CindyRegion = 'global';

/**
 * 归一化区域输入(构建脚本 env / 运行时注入值)。空值 → 默认 global;
 * 非法值抛错——打包链路宁可失败也不能默默打出身份错误的包。
 */
export function resolveCindyRegion(raw?: string | null): CindyRegion {
  const v = raw?.trim().toLowerCase();
  if (!v) return DEFAULT_CINDY_REGION;
  if (v === 'cn' || v === 'global' || v === 'dev') return v;
  throw new Error(`Invalid Cindy region: ${raw}; expected cn, global or dev`);
}

/** 标识符层身份配置的完整形状。字段语义见各注释;全部为纯数据,零运行时逻辑。 */
export interface BrandIdentity {
  /** 展示名(与 branding.ts 的 BRAND_NAME 同源,这里仅聚合成完整档案)。 */
  readonly displayName: string;
  /**
   * 可执行文件基名(Windows 加 .exe;mac Mach-O 名同源派生)。
   * 首字母大写是产品决策(Cindy.exe,同 Discord/Slack 惯例);Windows 进程
   * 匹配大小写不敏感,产物 / OSS key 命名走小写的 `cdnPrefix`,互不影响。
   * ⚠️ 这是 **cn / dev 基线值**;2026-07-18 支持同机双装后,打包与运行时
   * 一律走 `brandExecutableName(region)` 取区域值,本字段仅供 dev 链路
   * (restart 脚本镜像)与 legacy 消费点使用。
   */
  readonly executableName: string;
  /**
   * 按区域派生的可执行文件基名(exe / mac .app 包名 / 安装目录 / NSIS
   * 快捷方式全部跟随)。Cindy Meka 的 cn / global / dev 名称彼此独立，
   * 同时与普通 Cindy 隔离；区域名不含空格。
   */
  readonly executableNameByRegion: Readonly<Record<CindyRegion, string>>;
  /**
   * Windows AppUserModelId = NSIS appId = macOS bundle id,按区域派生
   * (cn/global 是两个可并存的系统身份,与 mobile 同一套命名)。
   * ⚠️ AUMID 三位一体:NSIS appId、运行时 setAppUserModelId、快捷方式 AUMID
   * 必须逐字符一致,否则 Windows toast 通知被静默丢弃。取值经 `brandAppId()`。
   */
  readonly appIdByRegion: Readonly<Record<CindyRegion, string>>;
  /** 深链主 scheme(OS 级注册,`<scheme>://session/...`;cn/global 不区分)。 */
  readonly primaryScheme: string;
  /** 历史 Meka scheme：继续注册并解析，使旧链接可直接唤起新应用。只增不减。 */
  readonly legacySchemes: readonly string[];
  /**
   * 只解析、不向 OS 注册的互操作 scheme。`cindy://` 属于上游 Cindy：
   * Cindy Meka 可复用其链接语义，但不能抢占同机 Cindy 的系统协议所有权。
   */
  readonly acceptedUnregisteredSchemes: readonly string[];
  /**
   * Electron userData 目录名(cn / dev 基线值 = package.json productName,
   * Electron 默认派生)。区域值走 `brandUserDataDirName(region)`:global 构建
   * 在 main 入口早期 setPath 切到区域目录,与 cn 彻底分库(数据库 / 登录态 /
   * 单实例锁随 userData 目录天然隔离)。
   */
  readonly userDataDirName: string;
  /** 按区域派生的 userData 目录名(cn 保持 productName 默认,global 独立目录)。 */
  readonly userDataDirNameByRegion: Readonly<Record<CindyRegion, string>>;
  /** 历史 userData 目录名(orphan-reaper 等按路径识别的消费点需匹配全量)。只增不减。 */
  readonly legacyUserDataDirNames: readonly string[];
  /**
   * 更新分发 CDN / OSS 的一级路径前缀(渠道身份,老客户端永远只看自己的前缀)。
   * ⚠️ 两区共用(owner 决策 2026-07-18):cn / global 的发布渠道靠**不同
   * OSS bucket** 区分,不靠路径前缀——本字段不做区域派生,发布侧矩阵按
   * region 选 bucket。
   */
  readonly cdnPrefix: string;
  /** 更新器/迁移执行器产物基名(`<updaterName>.exe`)。 */
  readonly updaterName: string;
  /** 本地主库文件名前缀(`<dbFilePrefix>-<userId>.db`)。 */
  readonly dbFilePrefix: string;
  /** 历史主库文件名前缀；首登本地迁移扫描旧库时只增不减。 */
  readonly legacyDbFilePrefixes: readonly string[];
  /** Windows `.cindy` 文件关联 ProgID；cn 必须兼容既有 Meka 安装。 */
  readonly fileAssociationProgIdByRegion: Readonly<Record<CindyRegion, string>>;
}

/**
 * 当前生效的身份档案：Cindy Meka 是独立新应用；XDMaker Meka 仅作迁移来源。
 *
 * 区域差异字段 appId、userDataDirName、executableName 均按区域派生，
 * cn / global / dev 可并存；深链 scheme、展示名 BRAND_NAME、cdnPrefix、dbFilePrefix、
 * updaterName 两区共用(scheme 共用是 owner 决策:双装时后注册者赢,单装用户
 * 无感;cdnPrefix 共用因发布渠道靠不同 OSS bucket 区分;db 前缀因 userData
 * 已分目录无需再区分)。
 */
export const BRAND_IDENTITY: BrandIdentity = Object.freeze({
  displayName: BRAND_NAME,
  executableName: 'CindyMeka',
  executableNameByRegion: Object.freeze({
    cn: 'CindyMeka',
    global: 'CindyMekaGlobal',
    dev: 'CindyMekaDev',
  }),
  appIdByRegion: Object.freeze({
    cn: 'com.xd.cindy.meka',
    global: 'com.xd.cindy.meka.global',
    dev: 'com.xd.cindy.meka.dev',
  }),
  primaryScheme: 'cindy-meka',
  legacySchemes: Object.freeze(['xdmaker-meka', 'xdt-maker']),
  acceptedUnregisteredSchemes: Object.freeze(['cindy']),
  userDataDirName: 'CindyMeka',
  userDataDirNameByRegion: Object.freeze({
    cn: 'CindyMeka',
    global: 'CindyMekaGlobal',
    dev: 'CindyMekaDev',
  }),
  // `xdmaker-meka` 是直接迁移来源；更早的 `xdt-maker` 仍须保留给
  // orphan reaper、Codex HOME 接管与 owner namespace 兼容逻辑。
  legacyUserDataDirNames: Object.freeze(['xdmaker-meka', 'xdt-maker']),
  cdnPrefix: 'cindy-meka',
  updaterName: 'cindy-meka-updater',
  dbFilePrefix: 'cindy-meka',
  legacyDbFilePrefixes: Object.freeze(['xdt-maker']),
  fileAssociationProgIdByRegion: Object.freeze({
    cn: 'CindyMeka.CindyGhost',
    global: 'CindyMekaGlobal.CindyGhost',
    dev: 'CindyMekaDev.CindyGhost',
  }),
});

/**
 * Cindy mobile / cross-device wire links remain on the upstream protocol.
 *
 * Cindy Meka owns `cindy-meka://`, while S3 mobile/device-link stays on the
 * upstream Cindy wire format. Keep these constants separate so desktop OS
 * registration cannot silently rewrite the existing mobile protocol.
 */
export const CINDY_INTEROP_PRIMARY_SCHEME = 'cindy';
export const CINDY_INTEROP_DEEP_LINK_SCHEMES: readonly string[] = Object.freeze([
  CINDY_INTEROP_PRIMARY_SCHEME,
  'xdt-maker',
]);

/** 按区域取 appId(AUMID / bundle id);默认 global。 */
export function brandAppId(
  region: CindyRegion = DEFAULT_CINDY_REGION,
  identity: BrandIdentity = BRAND_IDENTITY,
): string {
  return identity.appIdByRegion[region];
}

/** 自有 UTI / ProgId 等派生标识的前缀(如 `<prefix>.cindy` UTI),随区域 appId 走。 */
export function brandBundleIdPrefix(
  region: CindyRegion = DEFAULT_CINDY_REGION,
  identity: BrandIdentity = BRAND_IDENTITY,
): string {
  return identity.appIdByRegion[region];
}

/** 按区域取可执行文件基名(exe / mac .app / 安装目录 / 快捷方式名);默认 global。 */
export function brandExecutableName(
  region: CindyRegion = DEFAULT_CINDY_REGION,
  identity: BrandIdentity = BRAND_IDENTITY,
): string {
  return identity.executableNameByRegion[region];
}

/** 按区域取 Electron userData 目录名;默认 global。 */
export function brandUserDataDirName(
  region: CindyRegion = DEFAULT_CINDY_REGION,
  identity: BrandIdentity = BRAND_IDENTITY,
): string {
  return identity.userDataDirNameByRegion[region];
}

/** 按区域取 Windows `.cindy` 文件关联 ProgID；默认 cn。 */
export function brandFileAssociationProgId(
  region: CindyRegion = DEFAULT_CINDY_REGION,
  identity: BrandIdentity = BRAND_IDENTITY,
): string {
  return identity.fileAssociationProgIdByRegion[region];
}

/** 深链需要注册/解析的全部 scheme(主 + 历史),顺序稳定:主 scheme 恒为首位。 */
export function allDeepLinkSchemes(identity: BrandIdentity = BRAND_IDENTITY): readonly string[] {
  return [identity.primaryScheme, ...identity.legacySchemes];
}

/**
 * 深链解析器接受的全部 scheme：系统注册集合 + 只解析的上游互操作集合。
 * 顺序稳定且去重，生成侧仍只使用 primaryScheme。
 */
export function allAcceptedDeepLinkSchemes(
  identity: BrandIdentity = BRAND_IDENTITY,
): readonly string[] {
  return [...new Set([...allDeepLinkSchemes(identity), ...identity.acceptedUnregisteredSchemes])];
}

/**
 * 按路径识别本产品 userData 的全部目录名(本区域当前 + 历史),本区域目录名
 * 恒为首位。⚠️ 故意**不包含另一区域**的目录:同机双装时 orphan-reaper 等
 * 按路径匹配的消费点只应认领自己区域的进程 / 文件,跨区域匹配会误杀。
 */
export function allUserDataDirNames(
  region: CindyRegion = DEFAULT_CINDY_REGION,
  identity: BrandIdentity = BRAND_IDENTITY,
): readonly string[] {
  return [identity.userDataDirNameByRegion[region], ...identity.legacyUserDataDirNames];
}
