import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

import {
  GHOST_MANIFEST_FILE,
  ghostIconMimeType,
  isValidGhostId,
  validateGhostManifest,
  type GhostManifest,
} from '../../shared/ghost.js';
import {
  classifyGhostDirEntry,
  classifyGhostDirEntrySync,
  collectGhostContentFiles,
  hashGhostContentFiles,
  resolveGhostContentPathSync,
} from './ghostContentTree.js';
import { validateGhostLocaleResourcesInDirectory } from './ghostLocaleFiles.js';
import {
  CINDY_OFFICIAL_GHOST_TRUST,
  hasCindyOfficialTrustMetadata,
} from './GhostManager.js';
import { withGhostInstallLock } from './ghostInstallLock.js';

/**
 * builtinGhostProvisioner — 内置意识的启动播种(第一方可信通道)。
 *
 * 模型(2026-07-12 Lizi 定案;2026-07-22 种子源拆分为多根;2026-09 种子退休):
 * - 种子 = 曾经随包分发的意识源码目录(dev 读仓库 resources/builtin-ghosts,
 *   packaged 读 process.resourcesPath/builtin-ghosts),不经 .cindy zip。
 *   **该分发已被上游退休、不再随包出货**(2026-09 复核:resources/builtin-ghosts
 *   在磁盘上不存在,也从未进入 forge.config.ts 的 extraResourcesForTarget() 白名单,
 *   .gitignore:208-209 写着「内置插件种子已废弃(改走 plugin-store 安装)」;上游
 *   origin/main 同形)⇒ 正常安装(dev 与 packaged)下本模块是**有意的 no-op**。
 *   **机制保留的原因**:历史已播种安装的墓碑/seeded 台账、改名与退役对账仍由它执行
 *   (调用方 index.ts 的 RENAMED_BUILTIN_GHOSTS / RETIRED_BUILTIN_GHOSTS),删掉
 *   等于搁置存量用户数据,而今天零收益。因此"种子集为空"不再只有"submodule 没
 *   checkout"一种解释,必须区分设计状态与异常(见下条「观测口径」);
 * - **多种子根**:种子源按归属拆成多个根(official = cindy-official-plugin,
 *   xd = cindy-xd-plugin),每个根自带一份 provisioning.json,配置损坏按根隔离
 *   fail-closed(只跳过该根的种子,不拖累其它根);同 id 撞车取先到的根(warn 留痕);
 * - **观测口径(2026-09 新增,"设计如此"与"真的坏了"必须可分辨)**:
 *   ① 种子父目录(…/builtin-ghosts)整棵不在 = 当前的设计状态 ⇒ 记**每进程每父目录
 *      至多一次** info("seed roots absent by design"),并带上解析出的全部根路径;
 *      **绝不 warn/error** —— 这是正常安装的常态,升级成 warn 就是每次启动刷噪声;
 *   ② 父目录在、而某个根缺失/为空/不可读 = 打包或提交事故 ⇒ **warn** 并带根路径与
 *      errno/原因(区分"仓里真没有"与"读失败");
 *   ③ 种子集为空 ⇒ 本轮不执行孤儿回收(空集分不清"随包真没有"与"根没 checkout",
 *      宁可不删),这条后果必须在日志里说明;scope 为 brain/plugin-*,只进本机日志,
 *      **不进上传包**(log-upload 的 NOTABLE_DENIED_ROOTS),所以别指望可上报;
 * - **空根保护**:任一根为空 ⇒ 整轮跳过孤儿回收,只做装/覆盖(见 ③);
 * - 「永远以最新包为准」:对每个种子做内容指纹比对(逐字节收敛),本地没装
 *   就装、指纹不同就覆盖 —— 不看 version 字段,dev 改源码重启即生效;
 * - **受众(audience)**:种子根下可选的 provisioning.json 按 id 声明给谁装
 *   ("all" 或按登录身份命中);不在配置里的种子默认人人都装。身份不再命中
 *   时,把"当初由播种装上的"(seeded 台账)回收删除 —— 用户手动装的同 id
 *   意识不动;
 * - 用户自主权两条豁免:`.disabled` 停用标记覆盖时保留(指纹计算也忽略它);
 *   用户卸载过的内置意识记墓碑,播种永远跳过;
 * - 全程不打扰用户(main 内完成,不走 renderer 确认弹窗)—— 三方装入通道的
 *   inspect → 确认 → install 流程不受影响;"静默"指没有 UI 交互,不指没有日志:
 *   种子树的形态判定见上条「观测口径」,本机日志必须能分辨 no-op 的成因。
 *
 * 依赖注入、零 electron(规则 14):seedRootDir / repoRootDir / identity 由
 * index.ts 装配,单测用 os.tmpdir 下的临时目录直接驱动。
 *
 * ⚠️ 保密边界:受众只是"给谁装"的策展,不是保密 —— 种子字节在安装包里人人
 * 可解。内容不能给包外人看的意识必须走服务端清单分发(第二期),别放这里。
 */

/** 墓碑 + seeded 台账的状态文件(点开头 —— GhostManager.list() 天然跳过)。 */
export const PROVISIONING_STATE_FILE = '.builtin-provisioning.json';
/** 受众配置文件(种子根下,可选;缺失 = 全部种子人人都装)。 */
export const PROVISIONING_CONFIG_FILE = 'provisioning.json';

export interface BuiltinProvisionerLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

/** 播种时的登录身份快照(登出 = null;字段来自 authManager 的 User)。 */
export interface ProvisionIdentity {
  userId: string;
  email: string | null;
}

/**
 * 受众规则:'all' = 人人都装(不需要登录);对象形态 = 登录后任一维度命中
 * 即命中(userIds 精确匹配 / emails 大小写不敏感)。将来的企业 key 等新维度
 * 在这里加字段即可(原 roles 维度随产品级 role 退役,2026-07,当时零使用)。
 * 空对象 / 不认识的形态一律不命中(fail-closed,配错了宁可不装,不把定向
 * 意识误发给所有人)。
 */
export type AudienceRule =
  | 'all'
  | {
      userIds?: string[];
      emails?: string[];
    };

/**
 * 种子档位(来源分类,2026-07-15):'builtin' = 官方内置(人人可见的第一方
 * 意识);'enterprise' = 企业意识(面向组织/定向受众发放)。档位由随包的
 * provisioning.json 声明,**不由 ghost.json 自表**——来源分类跟安装通道走,
 * 不给第三方包"自称官方"的口子。缺省 'builtin'。
 * 只影响设置页分组与标签,不改变播种/回收/墓碑等任何行为。
 */
export type GhostSeedTier = 'builtin' | 'enterprise';

/** provisioning.json 单条种子配置(解析后形态)。 */
interface SeedConfigEntry {
  audience: AudienceRule;
  tier: GhostSeedTier;
}

export interface ProvisionDeps {
  /**
   * 种子根目录列表(builtin-ghosts 下的各根,如 official / xd)。
   * 判读口径见模块头「观测口径」:整棵种子树不在 = 已退休的设计状态(每进程每父
   * 目录至多一条 info,不 warn);父目录在而某根缺失/为空/读失败 = 异常(warn 带根
   * 路径与 errno/原因)。种子集为空则本轮不执行孤儿回收,并在日志里说明。
   */
  seedRootDirs: string[];
  /** 意识仓库根(userData/cindy-brain)。 */
  repoRootDir: string;
  /** 当前登录身份(登出传 null;缺省 null)。 */
  identity?: ProvisionIdentity | null;
  /** 回收删除某个意识目录之前的钩子(index.ts 用它先熄灯沙箱,防 Windows 文件锁)。 */
  beforeRemove?: (id: string) => void | Promise<void>;
  /** Replacing existing bundled bytes must revoke the old Host receipt first. */
  beforeReplace?: (id: string) => void | Promise<void>;
  /** Production path publishes through GhostManager's durable pending journal. */
  publishSeed?: (
    id: string,
    seedDir: string,
    options: {
      disabled: boolean;
      trust?: typeof CINDY_OFFICIAL_GHOST_TRUST;
    },
  ) => void | Promise<void>;
  /**
   * 首次真实变更(装/覆盖/回收)动手前回调,整轮至多一次 —— index.ts 用它
   * 广播"播种进行中"的 UI 提示;指纹全一致的 no-op 轮永不触发(不闪提示)。
   */
  onApplyStart?: () => void;
  log?: BuiltinProvisionerLogger;
}

export interface ProvisionOutcome {
  /** First-party seed manifests whose installed bytes reconciled successfully. */
  approved: GhostManifest[];
  /** Immutable seed source for each approved manifest; receipt baselines must use it. */
  approvedSourceDirs: Record<string, string>;
  /** 本次首装的意识(装完默认唤醒;调用方负责停靠面板 + 广播 + 常驻点火)。 */
  installed: GhostManifest[];
  /** 本次覆盖更新的意识(`.disabled` 已保留;调用方负责广播)。 */
  updated: GhostManifest[];
  /** 本次因受众不再命中而回收删除的 id(调用方负责广播)。 */
  removed: string[];
  /** 指纹一致 / 墓碑 / 受众不命中 / 种子不合格而跳过的 id(仅日志用途)。 */
  skipped: string[];
  /** A transient per-seed or state I/O failure keeps the stable-owner pass retryable. */
  retryPending?: boolean;
}

function isRetryableProvisioningError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  // Seed links/non-regular entries are deterministic package violations. Keep
  // them fail-closed without turning a bad bundle into an endless retry loop.
  if (message.includes('non-regular') || message.includes(' rejects link')) return false;
  return true;
}

/** 播种状态文件形态(墓碑 + seeded 台账;将来组织清单等扩展也落这里)。 */
interface ProvisioningState {
  /** 用户主动卸载过的内置意识 id —— 播种永远跳过,除非用户手动重装(清墓碑)。 */
  removed: string[];
  /** 由播种装上的 id 台账 —— 受众不再命中时只回收台账内的,用户手动装的不动。 */
  seeded: string[];
}

interface ProvisioningStateRead {
  state: ProvisioningState;
  readable: boolean;
}

/** Managed roots must not traverse a symlink/junction in any path segment. */
function isRealDirectoryPath(absPath: string, allowMissingLeaf = false): boolean {
  const resolved = path.resolve(absPath);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  const segments = path.relative(parsed.root, resolved).split(path.sep).filter(Boolean);
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (err) {
      if (
        allowMissingLeaf &&
        index === segments.length - 1 &&
        (err as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        return true;
      }
      return false;
    }
    if (stat.isSymbolicLink()) {
      if (!isExternalTempAncestor(current, resolved)) return false;
      try {
        if (!fs.statSync(current).isDirectory()) return false;
      } catch {
        return false;
      }
      continue;
    }
    if (!stat.isDirectory()) return false;
  }
  return true;
}

/**
 * macOS exposes the temporary directory through a system alias (`/var` →
 * `/private/var`).  That alias is outside the caller-controlled directory and
 * is safe to traverse; links at or below the temporary root remain rejected.
 */
function isExternalTempAncestor(segment: string, target: string): boolean {
  const tempRoot = path.resolve(os.tmpdir());
  const targetRel = path.relative(tempRoot, target);
  if (targetRel.startsWith(`..${path.sep}`) || path.isAbsolute(targetRel)) return false;
  try {
    const realSegment = fs.realpathSync.native(segment);
    const realTempRoot = fs.realpathSync.native(tempRoot);
    const tempRel = path.relative(realSegment, realTempRoot);
    return tempRel !== '' && !tempRel.startsWith(`..${path.sep}`) && !path.isAbsolute(tempRel);
  } catch {
    return false;
  }
}

/** Verify that an approval source is the exact, link-free bundled seed directory for an id. */
export function isTrustedBuiltinSeedSource(
  seedRootDirs: string[],
  id: string,
  sourceDir: string,
): boolean {
  if (!isValidGhostId(id)) return false;
  const resolvedSource = path.resolve(sourceDir);
  return seedRootDirs.some((root) => {
    const resolvedRoot = path.resolve(root);
    const expectedSource = path.join(resolvedRoot, id);
    return (
      resolvedSource === expectedSource &&
      isRealDirectoryPath(resolvedRoot) &&
      isRealDirectoryPath(expectedSource)
    );
  });
}

/** 列出多个种子根下的意识 id 并集(去重排序)。根缺失/为空按无种子处理。 */
export function listBuiltinSeedIds(seedRootDirs: string[]): string[] {
  const ids = new Set<string>();
  for (const root of seedRootDirs) {
    for (const id of listSeedIdsInRoot(root)) ids.add(id);
  }
  return [...ids].sort();
}

/** 列出当前身份本轮会播种的 command(已墓碑的 id 由调用方排除)。 */
export function listEligibleBuiltinCommands(
  seedRootDirs: string[],
  identity: ProvisionIdentity | null,
  excludedIds: ReadonlySet<string> = new Set(),
  log?: BuiltinProvisionerLogger,
): string[] {
  const commands = new Set<string>();
  const seen = new Set<string>();
  for (const root of seedRootDirs) {
    const ids = listSeedIdsInRoot(root);
    if (ids.length === 0) continue;
    const config = readProvisioningConfig(root, log);
    if (config === null) continue;
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (excludedIds.has(id) || !matchesAudience(config.get(id)?.audience, identity)) continue;
      const manifest = readSeedManifest(path.join(root, id), id, log);
      const command = manifest?.command?.toLowerCase();
      if (command) commands.add(command);
    }
  }
  return [...commands].sort();
}

/** 列出单个种子根下的意识 id(= 子目录名;点开头跳过)。种子根缺失返回空。 */
function listSeedIdsInRoot(seedRootDir: string): string[] {
  if (!isRealDirectoryPath(seedRootDir)) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(seedRootDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
}

/**
 * 种子根的观测形态 —— 专为"说清为什么这轮没有种子"服务(播种主流程用)。
 * 设置页取数路径(listBuiltinSeedIds / listRestorableBuiltinGhosts 等)仍走
 * listSeedIdsInRoot 且保持静默:那是读操作,不该在用户点开设置时刷 warn。
 */
type SeedRootShape = 'seeded' | 'empty' | 'root-missing' | 'root-unreadable' | 'tree-absent';

interface SeedRootObservation {
  root: string;
  ids: string[];
  shape: SeedRootShape;
  /** 异常形态的原因(errno + message),进 warn 元数据。 */
  reason?: string;
}

/**
 * 已就"整棵种子树随包缺失"记过 info 的种子父目录。种子分发已退休,这条日志在
 * 正常安装下每轮对账都会命中 —— 用模块级去重做到**每进程每父目录至多一次**,
 * 既留下"播种为何 no-op"的证据,又不至于每次登录/对账刷一行。
 */
const seedTreeAbsentLoggedBaseDirs = new Set<string>();

/** errno + message(= 诊断要的"原因"),errno 缺失时退回 message。 */
function describeSeedRootFailure(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  const message = err instanceof Error ? err.message : String(err);
  return code ? `${code}: ${message}` : message;
}

/**
 * 判定单个种子根的形态。关键是**把"整棵种子树不在"从其它异常里分出来**:
 * - 根 lstat 报 ENOENT 且父目录也不存在 ⇒ 'tree-absent' = 随包种子已退休的设计状态;
 * - 其余(父目录在而根缺失/链接/非目录 ⇒ 'root-missing';根在但 readdir 抛错 ⇒
 *   'root-unreadable';根在且可读但没有种子子目录 ⇒ 'empty')都是异常,必须 warn。
 * ids 始终复用 listSeedIdsInRoot,判定与取种子同一口径(链接穿透判定不在这里重复实现)。
 */
function observeSeedRoot(seedRootDir: string): SeedRootObservation {
  const root = seedRootDir;
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(root);
  } catch (err) {
    const reason = describeSeedRootFailure(err);
    const parent = path.dirname(path.resolve(root));
    if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' && !fs.existsSync(parent)) {
      return { root, ids: [], shape: 'tree-absent' };
    }
    // 父目录在而根本身缺失:打包漏拷/子模块没 checkout 一类事故,不是退休形态。
    return { root, ids: [], shape: 'root-missing', reason };
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    return {
      root,
      ids: [],
      shape: 'root-missing',
      reason: 'seed root is not a link-free directory',
    };
  }
  const ids = listSeedIdsInRoot(root);
  if (ids.length > 0) return { root, ids, shape: 'seeded' };
  if (!isRealDirectoryPath(root)) {
    // 路径上有链接跳转:取种子被拒(安全边界),同样按异常记。
    return {
      root,
      ids: [],
      shape: 'root-missing',
      reason: 'seed root path traverses a link; seeds are rejected',
    };
  }
  try {
    fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    // 根在但读不出:权限/IO 事故,与"根里真的没种子"必须分开。
    return { root, ids: [], shape: 'root-unreadable', reason: describeSeedRootFailure(err) };
  }
  return { root, ids: [], shape: 'empty' };
}

/** 异常种子根的 warn(带根路径与 errno/原因;级别统一 warn —— 这些形态都不该出现)。 */
function warnUnusableSeedRoot(state: SeedRootObservation, log?: BuiltinProvisionerLogger): void {
  const meta = {
    root: state.root,
    seedBaseDir: path.dirname(path.resolve(state.root)),
  };
  if (state.shape === 'empty') {
    log?.warn('builtin seed root present but empty', {
      ...meta,
      reason:
        'seed root exists but declares no seeds; bundled seeds are retired, so a present-but-empty root is a packaging/submodule accident, not the normal state',
    });
    return;
  }
  if (state.shape === 'root-unreadable') {
    log?.warn('builtin seed root unreadable', { ...meta, error: state.reason ?? 'unknown' });
    return;
  }
  log?.warn('builtin seed root missing', {
    ...meta,
    shape: state.shape,
    error: state.reason ?? `seed root contributes no seeds (shape: ${state.shape})`,
  });
}

/**
 * 种子集整体为空时的说明。两种成因分开,且都要把"本轮没做孤儿回收"讲清楚 ——
 * 全空时主流程在读到种子集为空后就直接返回,走不到下面 hasEmptyRoot 的那条 info,
 * 所以那句必须在这里说,否则"为什么一个已装内置插件都没被回收"在日志里无迹可查。
 */
function reportEmptySeedSet(
  observations: ReadonlyArray<SeedRootObservation>,
  log?: BuiltinProvisionerLogger,
): void {
  const absent = observations.filter((o) => o.shape === 'tree-absent');
  const unusable = observations.filter((o) => o.shape !== 'tree-absent');
  const absentBaseDirs = [...new Set(absent.map((o) => path.dirname(path.resolve(o.root))))];
  for (const baseDir of absentBaseDirs) {
    if (seedTreeAbsentLoggedBaseDirs.has(baseDir)) continue;
    seedTreeAbsentLoggedBaseDirs.add(baseDir);
    log?.info('builtin ghost seed roots absent by design; builtin provisioning is a no-op', {
      seedBaseDir: baseDir,
      seedRootDirs: absent
        .filter((o) => path.dirname(path.resolve(o.root)) === baseDir)
        .map((o) => o.root),
      reason: 'bundled builtin seeds retired upstream; official plugins install from plugin-store',
      orphanRecovery:
        'skipped: an empty seed set cannot distinguish "no seed shipped" from "root not checked out"; installed builtins are left untouched',
    });
  }
  for (const state of unusable) warnUnusableSeedRoot(state, log);
  if (unusable.length > 0) {
    log?.info('builtin ghost orphan recovery skipped: no seed ids available this round', {
      emptyRoots: unusable.map((o) => o.root),
      reason:
        'an empty or unreadable root cannot distinguish "no seed in repo" from "root not checked out"; keep installed builtins rather than delete them',
    });
  }
}

/**
 * 读墓碑列表。状态文件缺失 = 无墓碑(返回空);**损坏/读不出则抛错 fail closed**
 * ——把损坏当空会让已卸载的随包意识复活(丢失卸载事实)。播种路径依赖这个抛错保持
 * fail closed;不能阻断的消费者(如 legacy 恢复状态查询)必须自己 try/catch 降级,
 * 而不是把损坏当空(见 getLegacyGhostRecoveryStatusForActiveSession)。
 */
export function readBuiltinTombstones(repoRootDir: string): string[] {
  const result = readState(repoRootDir);
  if (!result.readable) {
    throw new Error('builtin provisioning state is unreadable');
  }
  return result.state.removed;
}

/** 记墓碑(幂等)。用户卸载内置意识时由 IPC 层调用;同时从 seeded 台账摘除。 */
export function recordBuiltinTombstone(
  repoRootDir: string,
  id: string,
  log?: BuiltinProvisionerLogger,
): void {
  if (!isValidGhostId(id)) throw new Error('invalid builtin tombstone id');
  const result = readState(repoRootDir, log);
  if (!result.readable) throw new Error('builtin provisioning state is unreadable');
  const state = result.state;
  if (state.removed.includes(id) && !state.seeded.includes(id)) return;
  if (!writeState(
    repoRootDir,
    {
      removed: state.removed.includes(id) ? state.removed : [...state.removed, id],
      seeded: state.seeded.filter((v) => v !== id),
    },
    log,
  )) {
    throw new Error('builtin provisioning state write failed');
  }
}

/** 清墓碑(幂等)。用户手动重装同 id 意识 = 重新跟随包内版本。 */
export function clearBuiltinTombstone(
  repoRootDir: string,
  id: string,
  log?: BuiltinProvisionerLogger,
): void {
  if (!isValidGhostId(id)) throw new Error('invalid builtin tombstone id');
  const result = readState(repoRootDir, log);
  if (!result.readable) throw new Error('builtin provisioning state is unreadable');
  const state = result.state;
  if (!state.removed.includes(id)) return;
  if (!writeState(repoRootDir, { ...state, removed: state.removed.filter((v) => v !== id) }, log)) {
    throw new Error('builtin provisioning state write failed');
  }
}

/** Carry a removed builtin across an id rename in one atomic state replacement. */
export function renameBuiltinTombstone(
  repoRootDir: string,
  fromId: string,
  toId: string,
  log?: BuiltinProvisionerLogger,
): boolean {
  if (!isValidGhostId(fromId) || !isValidGhostId(toId)) {
    throw new Error('invalid builtin tombstone rename');
  }
  const result = readState(repoRootDir, log);
  if (!result.readable) throw new Error('builtin provisioning state is unreadable');
  const state = result.state;
  if (!state.removed.includes(fromId)) return false;
  const removed = state.removed.filter((id) => id !== fromId && id !== toId);
  removed.push(toId);
  if (
    !writeState(
      repoRootDir,
      {
        removed,
        seeded: state.seeded.filter((id) => id !== toId),
      },
      log,
    )
  ) {
    throw new Error('builtin provisioning state write failed');
  }
  return true;
}

function readState(repoRootDir: string, log?: BuiltinProvisionerLogger): ProvisioningStateRead {
  const empty: ProvisioningStateRead = {
    state: { removed: [], seeded: [] },
    readable: true,
  };
  const file = path.join(repoRootDir, PROVISIONING_STATE_FILE);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      log?.warn('builtin provisioning state is not a regular file', { file });
      return { ...empty, readable: false };
    }
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      log?.warn('builtin provisioning state is invalid', { file });
      return { ...empty, readable: false };
    }
    const obj = raw as { removed?: unknown; seeded?: unknown };
    if (
      (obj.removed !== undefined && !Array.isArray(obj.removed)) ||
      (obj.seeded !== undefined && !Array.isArray(obj.seeded))
    ) {
      log?.warn('builtin provisioning state has invalid fields', { file });
      return { ...empty, readable: false };
    }
    const removed = Array.isArray(obj.removed)
      ? obj.removed.filter((v): v is string => typeof v === 'string')
      : [];
    const seeded = Array.isArray(obj.seeded)
      ? obj.seeded.filter((v): v is string => typeof v === 'string')
      : [];
    if (
      (Array.isArray(obj.removed) && removed.length !== obj.removed.length) ||
      (Array.isArray(obj.seeded) && seeded.length !== obj.seeded.length) ||
      removed.some((id) => !isValidGhostId(id)) ||
      seeded.some((id) => !isValidGhostId(id))
    ) {
      log?.warn('builtin provisioning state contains invalid ghost id', { file });
      return { ...empty, readable: false };
    }
    return {
      state: { removed, seeded },
      readable: true,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return empty;
    log?.warn('builtin provisioning state unreadable', {
      file,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ...empty, readable: false };
  }
}

function writeState(
  repoRootDir: string,
  state: ProvisioningState,
  log?: BuiltinProvisionerLogger,
): boolean {
  const file = path.join(repoRootDir, PROVISIONING_STATE_FILE);
  const temp = path.join(
    repoRootDir,
    `.${PROVISIONING_STATE_FILE}.tmp-${crypto.randomBytes(8).toString('hex')}`,
  );
  try {
    if (!isRealDirectoryPath(repoRootDir, true)) {
      throw new Error('builtin provisioning repo root is not a real directory');
    }
    fs.mkdirSync(repoRootDir, { recursive: true });
    fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    const tempStat = fs.lstatSync(temp);
    if (!tempStat.isFile() || tempStat.isSymbolicLink()) {
      throw new Error('builtin provisioning temporary state is not a regular file');
    }
    fs.renameSync(temp, file);
    return true;
  } catch (err) {
    // 状态写失败不致命(最坏情况:卸载的内置意识下次启动弹回来一次),warn 留痕。
    log?.warn('builtin provisioning state write failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // Preserve the original failure; the next reconciliation retries the write.
    }
    return false;
  }
}

/** 受众命中判定(纯函数,fail-closed:不认识的规则形态一律不命中)。 */
export function matchesAudience(
  rule: AudienceRule | undefined,
  identity: ProvisionIdentity | null,
): boolean {
  if (rule === undefined || rule === 'all') return true;
  if (typeof rule !== 'object' || rule === null) return false;
  if (identity === null) return false;
  if (Array.isArray(rule.userIds) && rule.userIds.includes(identity.userId)) return true;
  if (Array.isArray(rule.emails) && identity.email !== null) {
    const emailFold = identity.email.toLowerCase();
    if (rule.emails.some((e) => typeof e === 'string' && e.toLowerCase() === emailFold))
      return true;
  }
  return false;
}

/**
 * 读受众配置。三种结果:
 * - 文件不存在 → 空表(全部种子默认 'all',零配置模式);
 * - 文件在且合法 → id → 规则表;
 * - 文件在但坏(JSON 解析失败 / 形态不对)→ null(fail-closed:本根种子整轮
 *   跳过,warn 留痕 —— 配置坏了宁可什么都不动,不按"人人都装"误发定向意识)。
 */
function readProvisioningConfig(
  seedRootDir: string,
  log?: BuiltinProvisionerLogger,
): Map<string, SeedConfigEntry> | null {
  const file = path.join(seedRootDir, PROVISIONING_CONFIG_FILE);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    log?.warn('builtin provisioning config unreadable', {
      file,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  try {
    const raw = JSON.parse(text) as unknown;
    if (typeof raw !== 'object' || raw === null) throw new Error('config root must be an object');
    const ghosts = (raw as { ghosts?: unknown }).ghosts;
    if (ghosts === undefined) return new Map();
    if (typeof ghosts !== 'object' || ghosts === null)
      throw new Error('"ghosts" must be an object');
    const map = new Map<string, SeedConfigEntry>();
    for (const [id, entry] of Object.entries(ghosts as Record<string, unknown>)) {
      if (typeof entry !== 'object' || entry === null)
        throw new Error(`ghosts["${id}"] must be an object`);
      const audience = (entry as { audience?: unknown }).audience;
      const tier = (entry as { tier?: unknown }).tier;
      // tier 只认 'builtin' / 'enterprise'(缺省 builtin);写错整份配置按损坏
      // 处理(与 audience 同一 fail-closed 口径,配错宁可本轮不动)。
      if (tier !== undefined && tier !== 'builtin' && tier !== 'enterprise') {
        throw new Error(`ghosts["${id}"].tier must be 'builtin' or 'enterprise'`);
      }
      map.set(id, {
        // audience 缺省 = 'all';其余形态原样进 matchesAudience(fail-closed 在那边)。
        audience: audience === undefined ? 'all' : (audience as AudienceRule),
        tier: tier === 'enterprise' ? 'enterprise' : 'builtin',
      });
    }
    return map;
  } catch (err) {
    log?.warn('builtin provisioning config invalid, skipping this seed root this round', {
      file,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * 播种主流程。对每个种子:墓碑 → 受众 → 指纹 → 首装 / 覆盖 / 回收 / 跳过。
 * 单个种子失败只 warn + 跳过,绝不拖垮其它种子或启动流程。
 * 多根语义:配置损坏按根 fail-closed(该根种子整轮跳过,但其 id 仍算入种子
 * 全集,不会被当孤儿回收);同 id 撞车取先到的根;任一根为空跳过孤儿回收。
 */
export async function provisionBuiltinGhosts(deps: ProvisionDeps): Promise<ProvisionOutcome> {
  const { seedRootDirs, repoRootDir, log } = deps;
  const identity = deps.identity ?? null;
  const outcome: ProvisionOutcome = {
    approved: [],
    approvedSourceDirs: {},
    installed: [],
    updated: [],
    removed: [],
    skipped: [],
  };

  // 每根独立列种子 + 读配置(形态判定见 observeSeedRoot)。空根不读配置 —— 根里
  // 连 provisioning.json 都没有,读了必 warn,徒增噪音。
  const rootStates = seedRootDirs.map((root) => {
    const observation = observeSeedRoot(root);
    return {
      ...observation,
      config:
        observation.ids.length === 0
          ? new Map<string, SeedConfigEntry>()
          : readProvisioningConfig(root, log),
    };
  });
  const allSeedIds = new Set(rootStates.flatMap((s) => s.ids));
  if (allSeedIds.size === 0) {
    // 一个种子都没有:本轮确定是 no-op,成因与后果在这里一次讲清(全空时走不到
    // 下面 hasEmptyRoot 那条 info,孤儿回收为何没执行只能在这里说明)。
    reportEmptySeedSet(rootStates, log);
    return outcome;
  }
  const hasEmptyRoot = rootStates.some((s) => s.ids.length === 0);
  // 还有种子可播时,个别根的缺失/为空/读失败仍要留痕(异常形态,级别 warn)。
  for (const state of rootStates) {
    if (state.shape !== 'seeded') warnUnusableSeedRoot(state, log);
  }

  if (!isRealDirectoryPath(repoRootDir, true)) {
    log?.warn('builtin provisioning skipped: repo root is not a real directory', {
      repoRootDir,
    });
    outcome.skipped.push(...allSeedIds);
    outcome.retryPending = true;
    return outcome;
  }
  const stateResult = readState(repoRootDir, log);
  if (!stateResult.readable) {
    // readState 已经 warn 过具体原因(文件路径 + errno/message),这里再补一句**整轮
    // 后果**:本轮不装不删、台账原样保留、等下一轮重试。否则只剩一条文件级 warn,
    // 读日志的人分不清"播种被跳过了"还是"播种跑完了什么都没做"。
    log?.warn('builtin provisioning skipped: unreadable state ledger; no seed applied this round', {
      repoRootDir,
      seedRootDirs: rootStates.map((s) => s.root),
      deferredSeedIds: [...allSeedIds].sort(),
      reason:
        'the tombstone/seeded ledger is unreadable; treating it as empty would resurrect uninstalled builtins',
      retry: 'the stable-owner pass is marked retry-pending',
    });
    outcome.skipped.push(...allSeedIds);
    outcome.retryPending = true;
    return outcome;
  }
  const state = stateResult.state;
  const tombstones = new Set(state.removed);
  const seeded = new Set(state.seeded);
  const seededBefore = new Set(seeded);

  let applyStarted = false;
  const markApplyStart = (): void => {
    if (applyStarted) return;
    applyStarted = true;
    deps.onApplyStart?.();
  };

  const processed = new Set<string>();
  for (const { root, ids, config } of rootStates) {
    if (config === null) {
      // 本根配置损坏:fail-closed 跳过本根全部种子;id 仍在 allSeedIds 里,
      // 孤儿回收不会误删它们名下已装的意识。
      outcome.skipped.push(...ids);
      continue;
    }
    for (const id of ids) {
      const ownedBeforeAttempt = seeded.has(id);
      let ownershipClaimPersisted = false;
      if (processed.has(id)) {
        log?.warn('builtin seed skipped: duplicate id across seed roots', { id, root });
        outcome.skipped.push(id);
        continue;
      }
      processed.add(id);
      const seedDir = path.join(root, id);
      try {
        // 1) 种子自检:manifest 合法且 id 与目录名一致(第一方内容,不合格
        //    属于打包/提交事故 —— warn 跳过,别把坏种子播出去)。
        const manifest = readSeedManifest(seedDir, id, log);
        if (!manifest) {
          outcome.skipped.push(id);
          continue;
        }

        // 2) 墓碑:用户删过,永不装回(顺手清掉台账残留)。
        if (tombstones.has(id)) {
          seeded.delete(id);
          outcome.skipped.push(id);
          continue;
        }

        await withGhostInstallLock(id, async () => {
          const installedDir = path.join(repoRootDir, id);
          const installedExists =
            isRealDirectoryPath(installedDir) &&
            (() => {
              try {
                return classifyGhostDirEntrySync(path.join(installedDir, GHOST_MANIFEST_FILE)) === 'file';
              } catch {
                return false;
              }
            })();

          // 3) 受众:不命中 → 回收"播种装的"(seeded 台账内),手动装的不动。
          if (!matchesAudience(config.get(id)?.audience, identity)) {
            if (seeded.has(id) && installedExists) {
              markApplyStart();
              await deps.beforeRemove?.(id);
              await fs.promises.rm(installedDir, { recursive: true, force: true });
              seeded.delete(id);
              outcome.removed.push(id);
              log?.info('builtin ghost removed: audience no longer matches', { id });
            } else {
              outcome.skipped.push(id);
            }
            return;
          }

          // 4) 指纹比对(忽略点开头文件:`.disabled` 是用户状态不是内容)。
          // 种子是随应用发布的第一方输入,出现链接/FIFO/设备节点属于打包事故:
          // 必须整颗 fail closed,不能在复制时静默丢掉条目后批准一个残缺安装。
          const seedFingerprint = await fingerprintDirContent(seedDir);
          if (seedFingerprint.hasNonRegularEntry) {
            throw new Error('builtin seed contains a link or non-regular entry');
          }

          const trust = id === 'cindy-github' ? CINDY_OFFICIAL_GHOST_TRUST : undefined;
          if (installedExists) {
            const installedFingerprint = await fingerprintDirContent(installedDir);
            const contentMatches =
              !installedFingerprint.hasNonRegularEntry &&
              seedFingerprint.hash === installedFingerprint.hash;
            const trustNeedsRepair = trust !== undefined && !hasCindyOfficialTrustMetadata(installedDir);
            if (contentMatches && !trustNeedsRepair) {
              outcome.approved.push(manifest);
              outcome.approvedSourceDirs[id] = seedDir;
              outcome.skipped.push(id);
              return;
            }

            const wasDisabled = (() => {
              try {
                return classifyGhostDirEntrySync(path.join(installedDir, '.disabled')) === 'file';
              } catch {
                return false;
              }
            })();
            markApplyStart();
            // Claim seeded ownership durably before exchanging bytes. If the process
            // dies after the swap but before the end-of-pass ledger write, the next
            // reconciliation still knows this id is eligible for audience cleanup.
            seeded.add(id);
            if (!writeState(repoRootDir, { removed: [...tombstones], seeded: [...seeded].sort() }, log)) {
              seeded.delete(id);
              throw new Error('builtin seeded ledger could not be persisted before replacement');
            }
            ownershipClaimPersisted = true;
            if (!contentMatches) await deps.beforeReplace?.(id);
            const options = {
              disabled: wasDisabled,
              ...(trust ? { trust } : {}),
            };
            if (deps.publishSeed) await deps.publishSeed(id, seedDir, options);
            else await swapInSeed(seedDir, installedDir, repoRootDir, id, options);
            outcome.approved.push(manifest);
            outcome.approvedSourceDirs[id] = seedDir;
            if (contentMatches) {
              outcome.skipped.push(id);
            } else {
              outcome.updated.push(manifest);
              log?.info('builtin ghost updated to bundled content', { id, version: manifest.version });
            }
            return;
          }

          markApplyStart();
          seeded.add(id);
          if (!writeState(repoRootDir, { removed: [...tombstones], seeded: [...seeded].sort() }, log)) {
            seeded.delete(id);
            throw new Error('builtin seeded ledger could not be persisted before install');
          }
          ownershipClaimPersisted = true;
          const options = {
            disabled: false,
            ...(trust ? { trust } : {}),
          };
          if (deps.publishSeed) await deps.publishSeed(id, seedDir, options);
          else await swapInSeed(seedDir, installedDir, repoRootDir, id, options);
          outcome.approved.push(manifest);
          outcome.approvedSourceDirs[id] = seedDir;
          outcome.installed.push(manifest);
          log?.info('builtin ghost installed', { id, version: manifest.version });
        });
      } catch (err) {
        // Existing ownership must survive a failed audience/orphan cleanup so the
        // next reconciliation retries instead of permanently forgetting an
        // installed approved plugin. Likewise, once a new ownership claim was
        // durably committed before publish/replace, keep it: the mutation may
        // have partially changed bytes or approval state before throwing.
        if (!ownedBeforeAttempt && !ownershipClaimPersisted) seeded.delete(id);
        outcome.skipped.push(id);
        if (isRetryableProvisioningError(err)) outcome.retryPending = true;
        log?.warn('builtin ghost provisioning failed', {
          id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // 孤儿种子回收(2026-07-13,filo-google 更名实撞):种子目录从包里消失
  // (意识改名 / 下架)时,当初"播种装上的"旧包也要收走,否则新旧两个
  // 意识并存(工具面重复、旧包永不再更新)。只收 seeded 台账内的——用户
  // 手动装的同 id 意识与本机制无关,照旧不动。
  // 空根保护(多根拆分后新增,2026-09 复核保留):任一根为空说明"该根的种子全集
  // 不可知"(子模块没 checkout / 打包漏拷 / 读失败),本轮跳过孤儿回收,宁可留旧包
  // 也不误删。这里只会命中"部分根为空"——**根全空时上面已经 return**,那种情况下
  // "未执行孤儿回收"的原因由 reportEmptySeedSet 说明,不会静默。
  if (hasEmptyRoot) {
    log?.info(
      'builtin ghost orphan recovery skipped: empty seed root (submodule not initialized?)',
      {
        emptyRoots: rootStates.filter((s) => s.ids.length === 0).map((s) => s.root),
        emptyRootShapes: rootStates.filter((s) => s.ids.length === 0).map((s) => s.shape),
        reason:
          'an empty or unreadable root makes the seed id set unknowable; keep installed builtins',
      },
    );
  } else {
    for (const id of [...seeded]) {
      if (!isValidGhostId(id)) {
        log?.warn('builtin ghost orphan id is invalid; skipped', { id });
        continue;
      }
      if (allSeedIds.has(id)) continue;
      const installedDir = path.join(repoRootDir, id);
      if (
        isRealDirectoryPath(installedDir) &&
        (() => {
          try {
            return classifyGhostDirEntrySync(path.join(installedDir, GHOST_MANIFEST_FILE)) === 'file';
          } catch {
            return false;
          }
        })()
      ) {
        try {
          markApplyStart();
          await deps.beforeRemove?.(id);
          await fs.promises.rm(installedDir, { recursive: true, force: true });
          outcome.removed.push(id);
          log?.info('builtin ghost removed: seed no longer bundled', { id });
        } catch (err) {
          outcome.retryPending = true;
          log?.warn('builtin ghost orphan removal failed', {
            id,
            error: err instanceof Error ? err.message : String(err),
          });
          continue; // 删失败保留台账,下轮再试
        }
      }
      seeded.delete(id);
    }
  }

  if (!setsEqual(seeded, seededBefore)) {
    if (!writeState(repoRootDir, { removed: [...tombstones], seeded: [...seeded].sort() }, log)) {
      outcome.retryPending = true;
    }
  }
  return outcome;
}

/** 「已抽离、可一键恢复」的内置意识摘要(设置页灰态占位行的数据源)。 */
export interface RestorableBuiltinGhost {
  id: string;
  name: string;
  description?: string;
  version: string;
  /** 随包 seed 的完整已校验身份卡;卸载不抹掉插件的声明事实。 */
  manifest: GhostManifest;
  /** 种子档位(设置页按它归组:builtin → 内置组,enterprise → 企业组)。 */
  tier: GhostSeedTier;
  iconDataUrl?: string;
}

/** 恢复行 icon 上限(与 GhostManager 的装载口径一致)。 */
const MAX_RESTORABLE_ICON_BYTES = 512 * 1024;

/**
 * 列出"可恢复"的内置意识 = 种子 ∩ 墓碑 ∩ 受众命中。
 * 全同步(设置页 sendSync 首帧拉取,种子极小);受众不命中的墓碑不列
 * (恢复了也装不上);配置损坏按根 fail-closed(只该根不列,不拖累其它根);
 * 同 id 撞车取先到的根(与播种口径一致)。
 */
export function listRestorableBuiltinGhosts(deps: {
  seedRootDirs: string[];
  repoRootDir: string;
  identity?: ProvisionIdentity | null;
  log?: BuiltinProvisionerLogger;
}): RestorableBuiltinGhost[] {
  const tombstones = new Set(readBuiltinTombstones(deps.repoRootDir));
  if (tombstones.size === 0) return [];
  const identity = deps.identity ?? null;

  const result: RestorableBuiltinGhost[] = [];
  const seen = new Set<string>();
  for (const root of deps.seedRootDirs) {
    const ids = listSeedIdsInRoot(root);
    if (ids.length === 0) continue;
    const config = readProvisioningConfig(root, deps.log);
    if (config === null) continue;
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (!tombstones.has(id)) continue;
      if (!matchesAudience(config.get(id)?.audience, identity)) continue;
      const seedDir = path.join(root, id);
      const manifest = readSeedManifest(seedDir, id, deps.log);
      if (!manifest) continue;
      const iconDataUrl = readSeedIconDataUrl(seedDir, manifest);
      result.push({
        id: manifest.id,
        name: manifest.name,
        ...(manifest.description !== undefined ? { description: manifest.description } : {}),
        version: manifest.version,
        manifest,
        tier: config.get(id)?.tier ?? 'builtin',
        ...(iconDataUrl !== null ? { iconDataUrl } : {}),
      });
    }
  }
  return result;
}

/**
 * 列出企业档种子 id(= 种子目录 ∩ provisioning.json 里 tier: 'enterprise')。
 * 纯展示用途(设置页分组/打标),配置缺失或损坏按根降级成"全归内置组"
 * 而不是报错,不影响播种主流程。
 */
export function listEnterpriseSeedIds(
  seedRootDirs: string[],
  log?: BuiltinProvisionerLogger,
): string[] {
  const ids = new Set<string>();
  for (const root of seedRootDirs) {
    const rootIds = listSeedIdsInRoot(root);
    if (rootIds.length === 0) continue;
    const config = readProvisioningConfig(root, log);
    if (config === null) continue;
    for (const id of rootIds) {
      if (config.get(id)?.tier === 'enterprise') ids.add(id);
    }
  }
  return [...ids].sort();
}

/**
 * 种子目录里的 icon → data URL(缺失/超限/读失败降级 null,不拖垮列表)。
 *
 * 路径解析走 `ghostContentTree` 的逐段判定:`stat` 会静默穿透链接,把种子目录之外
 * 的字节读成 icon 塞进设置页(与"清单声明的相对路径必须落在插件目录内"同一条判据,
 * 不因为它只是张图就换一套写法)。
 */
function readSeedIconDataUrl(seedDir: string, manifest: GhostManifest): string | null {
  if (manifest.icon === undefined) return null;
  try {
    const iconPath = resolveGhostContentPathSync(seedDir, manifest.icon, {
      expect: 'file',
      label: 'builtin seed icon',
    });
    const stat = fs.lstatSync(iconPath);
    if (stat.size > MAX_RESTORABLE_ICON_BYTES) return null;
    const mime = ghostIconMimeType(manifest.icon);
    if (!mime) return null;
    return `data:${mime};base64,${fs.readFileSync(iconPath).toString('base64')}`;
  } catch {
    return null;
  }
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/** 读并校验种子 manifest;不合格返回 null(warn 留痕)。 */
function readSeedManifest(
  seedDir: string,
  id: string,
  log?: BuiltinProvisionerLogger,
): GhostManifest | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(seedDir, GHOST_MANIFEST_FILE), 'utf-8'));
  } catch (err) {
    log?.warn('builtin seed skipped: unreadable manifest', {
      seedDir,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  const v = validateGhostManifest(raw);
  if (!v.ok) {
    log?.warn('builtin seed skipped: invalid manifest', { seedDir, reason: v.reason });
    return null;
  }
  if (v.manifest.id !== id) {
    log?.warn('builtin seed skipped: dir name != manifest id', {
      seedDir,
      manifestId: v.manifest.id,
    });
    return null;
  }
  const localeValidation = validateGhostLocaleResourcesInDirectory(seedDir, v.manifest);
  if (!localeValidation.ok) {
    log?.warn('builtin seed skipped: invalid locale resources', {
      seedDir,
      reason: localeValidation.reason,
    });
    return null;
  }
  return v.manifest;
}

/**
 * 目录内容指纹 + 一个**不进哈希**的类型状态。意识包极小(zip 通道上限才 8MB),
 * 启动算一遍开销可忽略。
 *
 * 遍历与类型判定取自 `ghostContentTree`(与技能指纹、快照拷贝、安装目录漂移指纹
 * 同一份实现);这里的显式策略是"点开头条目不算内容(`.disabled` 是用户状态)、
 * 非普通条目只记状态位不抛错"—— 因为本判据的收敛动作是**重新播种**,不是拒绝。
 *
 * 非普通条目(软链 / Windows junction 等)不读内容,也**不能拿 sentinel 喂进哈希** ——
 * 任何这样的 sentinel 都能被"同路径下内容恰好等于该 sentinel 的普通文件"撞上(已实测:
 * 内容为 `non-regular` 的普通文件与同名 junction 的摘要完全相等),于是被塞进链接的
 * 安装目录仍会被判成"与种子逐字节相同"。所以它作为独立字段参与比较,不掺进字节流。
 */
export interface DirContentFingerprint {
  /** 普通文件的 v2 内容指纹；链接等非普通条目不掺进字节流。 */
  hash: string;
  /** 是否含既非目录也非普通文件的条目(含点开头的那些)。 */
  hasNonRegularEntry: boolean;
}

export async function fingerprintDirContent(dir: string): Promise<DirContentFingerprint> {
  const tree = await collectGhostContentFiles(dir, {
    dotEntries: 'skip',
    nonRegular: 'flag',
    label: 'builtin seed content',
  });
  return {
    hash: await hashGhostContentFiles(dir, tree.files, tree.rootIdentity),
    hasNonRegularEntry: tree.hasNonRegularEntry,
  };
}

/**
 * 种子落位:复制到 staging → (可选)写 `.disabled` → 换目录。
 * 换目录用与 GhostManager.update 相同的备份滚回模式:任何时刻磁盘上都有
 * 一份完整版本,失败不会留半截。
 */
async function swapInSeed(
  seedDir: string,
  finalDir: string,
  repoRootDir: string,
  id: string,
  opts: { disabled: boolean; trust?: typeof CINDY_OFFICIAL_GHOST_TRUST },
): Promise<void> {
  const rand = crypto.randomBytes(4).toString('hex');
  const stagingDir = path.join(repoRootDir, `.cindy-provisioning-${id}-${rand}`);
  const backupDir = path.join(repoRootDir, `.cindy-provisioning-bak-${id}-${rand}`);

  try {
    await copyDirSkippingDotEntries(seedDir, stagingDir);
    if (opts.disabled) {
      await fs.promises.writeFile(path.join(stagingDir, '.disabled'), '');
    }
    if (opts.trust) {
      await fs.promises.writeFile(
        path.join(stagingDir, '.cindy-trust.json'),
        `${JSON.stringify(opts.trust, null, 2)}\n`,
      );
    }
  } catch (err) {
    await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  const hadExisting = fs.existsSync(finalDir);
  if (hadExisting) {
    await fs.promises.rename(finalDir, backupDir);
  }
  try {
    await fs.promises.rename(stagingDir, finalDir);
  } catch (err) {
    if (hadExisting) await fs.promises.rename(backupDir, finalDir).catch(() => {});
    await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  if (hadExisting) {
    await fs.promises.rm(backupDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * 递归复制目录,点开头条目跳过(种子里的 .DS_Store 等垃圾不落仓库)。
 *
 * 类型判定同样走 `ghostContentTree`:非普通条目直接抛错。种子里出现链接属于打包
 * 事故；既不能跟随复制把外部字节铺进安装目录，也不能静默丢掉后批准残缺安装。
 * 主流程在交换目录前已有同形自检，这里逐条复制前再判一次类型，缩小检查与使用之间
 * 的窗口，并挡住预检后、该条目被读取前已经发生的类型替换。
 */
async function copyDirSkippingDotEntries(from: string, to: string): Promise<void> {
  await fs.promises.mkdir(to, { recursive: true });
  for (const entry of await fs.promises.readdir(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    const kind = await classifyGhostDirEntry(src);
    // 与 collectGhostContentFiles 同序:先判类型，再按名称决定是否忽略内容。
    // 否则复制期间出现的 `.x` 链接会被静默跳过，第二道 fail-closed 防线名不副实。
    if (kind !== 'directory' && kind !== 'file') {
      throw new Error(
        `builtin seed rejects ${kind === 'link' ? 'link' : 'non-regular'} entry: ${src}`,
      );
    }
    if (entry.name.startsWith('.')) continue;
    if (kind === 'directory') {
      await copyDirSkippingDotEntries(src, dest);
    } else {
      await fs.promises.copyFile(src, dest);
    }
  }
}
