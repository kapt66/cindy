import { ownerScopedUserDataPath } from '../appSessionState.js';
import { PluginMarketLedger, type PluginMarketAuthorizationLookup } from './ledger.js';

/**
 * Meka 渠道的独立市场来源账本（`meka-ledger.v1.json`）。
 *
 * 两个渠道的账本**主文件不合并**：Cindy 渠道写 `ledger.v1.json`，Meka 渠道由
 * `plugin-market/registerIpc.ts` 的 `mekaService()` 注入这一份。这里把它抽成不依赖
 * IPC 的单例访问点，让 Host 的 Connection 签发资格判定与 Meka 市场服务读同一份账本、
 * 共用同一条 fail-closed 语义（账本存在但不可读 = `invalid`，不是「无记录」）。
 * 抽出而不是留在 `registerIpc.ts` 的原因：两渠道账本不合并（各自 loader），且
 * cindy-brain 的签发资格判定需要只读注入同一实例，不能反过来依赖 IPC 注册模块。
 *
 * **已知边界（2026-11-17 登记）**：`PluginMarketLedger` 的 custom / ns sidecar 由主
 * 账本 dirname 派生，所以本账本与 `ledger.v1.json` 实际共用同目录的
 * `custom-ledger.v1.json` / `ns-ledger.v1.json`。读侧合并视图可能包含另一渠道的
 * 自定义来源或组织 namespace 记录，调用方必须按来源判定（Connection 基座只认
 * `source: 'market'` 且不带组织 namespace 的记录，见 `connectionAudienceResolver.ts`）。
 * 不要为"隔离"直接改 sidecar 文件名：会丢存量数据，详见 `ledger.ts` 的
 * `customFilePath()` 注释。
 *
 * 本模块只读账本；写入仍由 Meka 市场服务通过同一个实例完成（账本不缓存文件内容，
 * 共享实例不会把两边的写入视图分开）。
 */
let mekaLedgerSingleton: PluginMarketLedger | null = null;

/** Meka 渠道的注入账本；路径按调用时的 owner 作用域解析（不缓存 owner）。 */
export function getMekaLedger(): PluginMarketLedger {
  mekaLedgerSingleton ??= new PluginMarketLedger(() =>
    ownerScopedUserDataPath('plugin-market', 'meka-ledger.v1.json'),
  );
  return mekaLedgerSingleton;
}

/**
 * 读取某个已装实例的 Meka 渠道安装记录。
 *
 * `invalid` 表示账本文件存在但内容不可读或不合法——调用方必须按 fail-closed 处理，
 * 不得当成 `absent`（「无记录」会误放行成另一种来源判定）。
 */
export function readMekaMarketInstallation(ghostId: string): PluginMarketAuthorizationLookup {
  return getMekaLedger().lookupInstallationForOidc(ghostId);
}
