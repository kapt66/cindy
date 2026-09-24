import { app } from 'electron';

import {
  CINDY_CLIENT_VERSION_HEADER,
  isValidCindyVersion,
  isVersionlessCindyVersion,
} from '@cindy/plugin-protocol';

/**
 * 插件分发身份的**唯一**解析入口（设计正本见
 * `docs/dev-rules/plugin-distribution-and-version-compat.md` §3.1／§3.2）。
 *
 * 为什么需要它：`minCindyVersion` 这类兼容判定只在**同一条版本线（versionSpace）**内才有定义，
 * 而"这次比较发生在哪个空间"是**客户端身份**、不是插件元数据。此前没有任何地方声明这件事，
 * 于是同一个字段同时承载上游 `0.1.x` 与 Cindy Meka `0.0.x` 两条互不可比的版本线：同一个
 * `minCindyVersion` 在两条线上各自"看起来成立"，而跨空间比较其实是无定义操作。
 *
 * 为什么收在一个模块：把「该 edition 用哪个空间、上报哪个版本、版本从哪来」只写一次，
 * 两个渠道的市场 API 构造点都只能从这里取值——"某个渠道忘记传版本 → 落到默认 `0.0.0`"
 * 这条路径必须在结构上不存在（顶层构造点由源码级门禁
 * `__tests__/pluginDistributionContract.test.ts` 兜住）。
 *
 * 与声明工件 `config/plugin-distribution.json` 的关系：工件是受 Git 管理、给人和门禁看的
 * **纯数据**声明（来源决定去哪、进哪个数据域），本模块是它在运行期的镜像。两者由同一个门禁
 * 双向绑定，任何一侧漂移都红灯。运行期**不** import 工件，原因有二：①主进程 bundle 不保证
 * 带上仓内 JSON 资产，把身份解析依赖打包细节会引入只在正式包里暴露的缺陷；②工件里会混入
 * "兼容基线证据表"这类只能用于上架决策的数据，一旦它出现在运行期 import 图上，就会变成
 * 客户端二次筛选的入口（设计文档 §3.6）。
 */

/** 一次插件分发所属的产品版本空间轴：`cindy` | `meka`（设计文档 §3.1 新增的唯一轴）。 */
export const PLUGIN_EDITIONS = ['cindy', 'meka'] as const;

export type PluginEdition = (typeof PLUGIN_EDITIONS)[number];

/** 版本线标识。`cindy` = 上游线（`0.1.x`…）；`cindy-meka` = Meka 线（`0.0.x`）。 */
export type PluginVersionSpace = 'cindy' | 'cindy-meka';

/** 客户端身份种类：正式版本号 vs 版本无关（占位 `0.0.0`）构建。 */
export type PluginClientIdentityKind = 'versioned' | 'unversioned';

const PLUGIN_VERSION_SPACES: Record<PluginEdition, PluginVersionSpace> = {
  cindy: 'cindy',
  meka: 'cindy-meka',
};

/**
 * 版本上报头名与协议包常量同源：这里不新写 `x-cindy-version` 字面量。
 *
 * P2 的空间头（`x-cindy-plugin-space`）常量已在协议包里就位（增量导出），但**默认不发**：
 * 单端先行发新头等于 wire 漂移（`protocol-and-submodules.md` 的修改准入）。发与不发出下面的
 * `PLUGIN_SPACE_HEADER_ENABLED` 单点决定，该开关默认 false。
 */
const PLUGIN_VERSION_HEADER = CINDY_CLIENT_VERSION_HEADER;

/**
 * 空间头（`x-cindy-plugin-space`）的运行期开关：**默认 false = 不发送**。
 *
 * ① 它是声明工件 `config/plugin-distribution.json` 里 `editions.*.identity.spaceHeader.enabled`
 *    的**运行期镜像**。工件是受 Git 管理、给人和门禁看的纯数据声明，运行期**刻意不 import** 它
 *    （P1 既定设计，原因见本文件头部注释），所以请求路径上唯一能读到这个开关的地方就是这里；
 *    两者由 `__tests__/pluginDistributionContract.test.ts` 双向绑定——工件说关了而运行期打开
 *    （或反之）一律红灯。
 * ② **只有在服务端（上游 plugin-server 与 MCPRouter 侧）按该头分区投影之后才允许翻成 true**
 *    （设计正本 `docs/dev-rules/plugin-distribution-and-version-compat.md` §3.5 的四项要求）：
 *    ① 两端都接受 `x-cindy-plugin-space: cindy | meka`，且缺省（旧客户端不发该头）等价于
 *    `cindy`、行为与今天逐字节一致；② release 命名空间与投影按 space 分区、不回退到另一个
 *    space；③ 无兼容 release 时返回机器可读 reason；④ Meka 请求不写上游数据域。
 *    服务端未就绪就发头 = 单端先行 wire 漂移（`protocol-and-submodules.md` 的修改准入）。
 * ③ 默认 false 时客户端发出的请求与今天**逐字节相同**：`requestOptions()` 里附加该头的分支
 *    不执行，既不新增任何头也不改版本头；由 `__tests__/api.test.ts` 的"默认请求头恰好只有
 *    `x-cindy-version`"断言证明。
 *
 * 类型显式写成 `boolean`（而不是字面量 `false`）是刻意的：让"开启后"的那一支在类型层面仍是
 * 活代码。但它是**模块常量**——改它只能改源码，不提供环境变量／配置等运行期翻转入口，
 * 免得存在"某台机器上悄悄开始发头"的状态。
 */
export const PLUGIN_SPACE_HEADER_ENABLED: boolean = false;

export interface PluginClientIdentity {
  /** 分发 edition；P2 的空间头取值直接用它，因此将来发头不需要新增映射。 */
  edition: PluginEdition;
  /** 上报版本号所属的版本线。 */
  versionSpace: PluginVersionSpace;
  /** 上报用的请求头名。 */
  header: typeof CINDY_CLIENT_VERSION_HEADER;
  /** 实际写进请求头的版本值。 */
  reportedVersion: string;
  /** 该身份的判定种类；`unversioned` 在协议侧等价于"版本无关、无条件放行"。 */
  identityKind: PluginClientIdentityKind;
}

export interface PluginClientIdentityInput {
  edition: PluginEdition;
  /** 进程内唯一权威版本来源是 `app.getVersion()`（与工件 `identity.source` 一致）。 */
  appVersion: string;
  /**
   * 该构建是否"版本无关"。缺省按哨兵判定，与协议 `isVersionlessCindyVersion`
   * （`packages/plugin-protocol/src/manifest.ts`）及更新器的 `isVersionlessAppVersion` 同口径：
   * 只有打包形态自己知道这件事，进程内唯一可用的信号就是这个哨兵。显式传入用于调用方
   * 已经确知打包形态、不需要靠数值猜的场合。
   */
  versionless?: boolean;
}

/**
 * 纯函数身份解析：同一个 `{ edition, appVersion, versionless }` 三元组必定得到同一个身份，
 * 因此本地无需打包即可复现发布版的判定输入（设计原则④）。
 */
export function resolvePluginClientIdentity({
  edition,
  appVersion,
  versionless,
}: PluginClientIdentityInput): PluginClientIdentity {
  const unversioned = versionless ?? isVersionlessCindyVersion(appVersion);
  return {
    edition,
    versionSpace: PLUGIN_VERSION_SPACES[edition],
    header: PLUGIN_VERSION_HEADER,
    // versionless 构建上报 `app.getVersion()` **原值**（dev 实测 `0.0.0`），不做数值改写：
    // 两个 space 都报 `0.0.0` 是预期行为（协议把该数值判成"版本无关"并无条件放行），不是缺陷；
    // 差异只体现在 identityKind 上。发布包的 `0.0.x` 永远是 versioned，不得与它混同，
    // 因此这里绝不能用"归一化成 0.0.0"之类的手法抹掉打包形态的区别。
    reportedVersion: appVersion,
    identityKind: unversioned ? 'unversioned' : 'versioned',
  };
}

/** 空间头取值：两个 edition 空间名（设计文档 §3.3 选定方案 B：`x-cindy-plugin-space: cindy | meka`）。 */
export type PluginSpaceHeaderValue = PluginEdition;

/**
 * 读取一次请求该带的**空间头取值**（`cindy` | `meka`）。
 *
 * 取值就是身份解析结果的 `edition` 轴本身：`resolvePluginClientIdentity(...)` 已经把
 * "这次请求属于哪个 space"定型在 `edition`（以及由它派生的 `versionSpace`）上，调用方传入的
 * 只能是解析出来的那个 edition，所以这里直接透传——**不新造** `edition → 头值` 映射表：
 * 两张表就是两个真源，迟早漂移。注意取值是 edition 名（`cindy` / `meka`），不是
 * `versionSpace`（`cindy` / `cindy-meka`）：后者是版本线的名字，不是该头的 wire 取值。
 *
 * 请求路径只在 `PLUGIN_SPACE_HEADER_ENABLED` 为 true 时才调用它。
 */
export function pluginSpaceHeaderValue(edition: PluginEdition): PluginSpaceHeaderValue {
  return edition;
}

/**
 * dev-only 的上报版本覆盖开关（值为版本号字符串，例如 `0.0.25`）。
 * 只影响**上报给市场的版本与其 identityKind**，见下方 `applyDevPluginIdentityOverride`。
 */
export const PLUGIN_CLIENT_VERSION_OVERRIDE_ENV = 'XDT_PLUGIN_CLIENT_VERSION';

export interface DevPluginIdentityOverrideInput {
  /** 进程内唯一权威版本来源（`app.getVersion()`）；不带覆盖时原样透传。 */
  appVersion: string;
  /** `app.isPackaged`：打包构建一律忽略覆盖。 */
  isPackaged: boolean;
  /** `XDT_PLUGIN_CLIENT_VERSION` 的原始值；`undefined` = 未设置。 */
  overrideRaw: string | undefined;
}

/** `app-version` = 未采用覆盖；`dev-override` = 上报值来自该开关。 */
export type DevPluginIdentityOverrideSource = 'app-version' | 'dev-override';

export interface DevPluginIdentityOverrideResult {
  /** 最终会上报给市场的版本号。 */
  reportedVersion: string;
  source: DevPluginIdentityOverrideSource;
}

/**
 * 为什么需要这个开关（缺陷机制，设计正本
 * `docs/dev-rules/plugin-distribution-and-version-compat.md` §1.1／§2④）：dev 下
 * `app.getVersion()` 是 `apps/desktop/package.json` 的占位值 `0.0.0`，协议
 * `isVersionlessCindyVersion`（`packages/plugin-protocol/src/manifest.ts`）把它判成
 * "版本无关"，`supportsCindyVersion` 于是**无条件放行**——市场下发的是最宽的投影。
 * 发布版上报的是真实 `0.0.x`，`identityKind` 是 `versioned`，会被插件的
 * `minCindyVersion` 兼容下限挡住。两者身份不同 ⇒「本地看得到、发布版看不到」这类
 * 缺陷在本地**永远无法复现**（这是原则④"dev 与 release 上报同一语义身份"缺的最后一块）。
 *
 * 为什么要这样一个开关而不是直接改 `app.getVersion()`：版本号同时是更新渠道、产物
 * 命名、UI 版本显示与日志的键，改它会把整个 dev 环境变成"另一代产品"。本开关**只**
 * 改写插件分发身份的上报值，其余读取 `app.getVersion()` 的路径一律不受影响——它是
 * 复现器，不是伪造版本号的通用手段。
 *
 * 为什么只在 `!isPackaged` 生效：与 `cindy-brain/reservedGhostIdGate.ts` 同一条判据方向
 * ——dev-only 覆盖只能让开发环境**更接近**发布行为，绝不能削弱生产行为。打包构建若认这个
 * 环境变量，用户机器上的任何环境变量就能伪造插件分发身份、绕过服务端按版本的投影与
 * 兼容下限；因此打包时无条件忽略（含非法值也忽略——它根本不该被生产路径读到）。
 *
 * 失败行为是 fail-loud 而非静默回退：非法形态、以及 versionless 哨兵（`0.0.0` /
 * `0.0.0-*`）都直接抛错。原因很具体——静默回退会回到 `0.0.0`⇒`unversioned`⇒最宽投影，
 * 而开发者以为自己已经复现了发布身份，得到的是**假阳性**的复现结论。哨兵值单独报错，
 * 是因为它等于"开关开了个寂寞"：该开关的用途正是复现**版本化**身份。
 */
export function applyDevPluginIdentityOverride({
  appVersion,
  isPackaged,
  overrideRaw,
}: DevPluginIdentityOverrideInput): DevPluginIdentityOverrideResult {
  // 打包构建一律忽略：这里不看值、也不校验值，生产路径不该被环境变量影响。
  if (isPackaged) return { reportedVersion: appVersion, source: 'app-version' };
  if (overrideRaw === undefined) return { reportedVersion: appVersion, source: 'app-version' };

  const raw = overrideRaw.trim();
  // 空值也算"设了但没给版本"：静默当作没开正是上面说的假阳性来源，因此同样抛错。
  if (!isValidCindyVersion(raw)) {
    throw new Error(
      `${PLUGIN_CLIENT_VERSION_OVERRIDE_ENV} 必须是合法的 Cindy 版本号形态（如 0.0.25），实得 ${JSON.stringify(overrideRaw)}；` +
        '请改成合法版本号，或取消该环境变量（留空不等于未设置）。',
    );
  }
  if (isVersionlessCindyVersion(raw)) {
    throw new Error(
      `${PLUGIN_CLIENT_VERSION_OVERRIDE_ENV} 不能是 versionless 哨兵 ${JSON.stringify(raw)}：` +
        '该开关的用途是复现**版本化**的发布身份（发布版上报真实 0.0.x、identityKind=versioned）；' +
        '传哨兵等于没开——市场仍会按"版本无关"无条件放行，复现结论是假的。',
    );
  }
  return { reportedVersion: raw, source: 'dev-override' };
}

/**
 * 读取当前进程的客户端身份。`app.getVersion()` 在本仓只应该在这一个模块里被读——
 * 渠道各写一份 getter 正是"某个渠道漏传版本"的成因。
 *
 * 唯一的上报值改写点是 `applyDevPluginIdentityOverride`（仅非打包生效，见其注释）；
 * 它只影响 `reportedVersion`，`app.getVersion()`、更新器、日志与 UI 版本显示都不变。
 */
export function readPluginClientIdentity(edition: PluginEdition): PluginClientIdentity {
  const override = applyDevPluginIdentityOverride({
    appVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    overrideRaw: process.env[PLUGIN_CLIENT_VERSION_OVERRIDE_ENV],
  });
  return resolvePluginClientIdentity({ edition, appVersion: override.reportedVersion });
}

/**
 * 市场 API 构造点使用的版本读取器。返回 `() => string` 是为了与 `PluginMarketApi` 既有参数
 * 形态对齐，不再造第二套接口；两个渠道各传自己 edition 的读取器。
 */
export function pluginClientVersionReader(edition: PluginEdition): () => string {
  return () => readPluginClientIdentity(edition).reportedVersion;
}
