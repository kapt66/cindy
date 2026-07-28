/**
 * legacyUserDataMigration — 首登轻量数据迁移(mToc)。
 *
 * Cindy Meka 身份翻转后 userData 目录从 `xdmaker-meka` 变为 `CindyMeka`,老用户的
 * 主库与媒体总仓留在同级的老目录里。本模块在「用户首次登录成功、db 尚未打开」
 * 时(registerLocalDbIpc 的 beforeEnsureReady 钩子)做一次**只读老目录**的简单
 * 迁移:通过 SQLite online backup 复制主库并合入 WAL、迁移 `cindy-media` 目录、
 * `dialogues` 无文件夹
 * 对话工作目录(agent 可能在里面写过真实文件,必须随迁;DB 里的 working_dir
 * 前缀改写由 db ready 后的 sweepLegacyDialogueWorkingDirs 完成)、agent 浏览器
 * profile(`browser-runtime/browser/XDMaker` → `browser/Cindy`,登录态随迁)、
 * Meka 非敏感设置与自定义角色到新
 * userData,完成后写 marker 文件 `<userData>/mToc` 防重入。
 *
 * 设计要点:
 *  - 使用独立的 mToc marker，不复用更新器状态。
 *  - 全程绝不写/删老目录任何内容;目标已存在的文件一律跳过不覆盖。
 *  - 任一步失败:不写 marker(下次登录重试)、warn 日志、通知 renderer failed,
 *    然后正常返回 —— 不阻塞登录,ensureReady 会照常建新库。
 *  - 老目录不存在(全新用户):静默写 marker 返回,不弹窗打扰。
 *  - 老目录存在:推送 confirm 态给 renderer 弹确认窗,await 用户确认(IPC
 *    `legacy-migration:confirm`)后才开始复制。
 *  - dev userData 覆写(--isolated 沙箱 / XDT_USER_DATA_DIR)下整个迁移跳过,
 *    不探测不弹窗(见 shouldSkipLegacyMigrationForDevSandbox)。
 *
 * 可测试性(docs/dev-rules/engineering-conventions.md):核心流程 `runLegacyUserDataMigration` 全部依赖
 * 经 `LegacyUserDataMigrationDeps` 注入(fs / 时钟 / 日志 / UI 桥),单测用内存
 * fs 假体直接驱动;electron 依赖只出现在默认实现的静态 import 里(main 禁运行时
 * 动态 import)。
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { app, BrowserWindow, ipcMain } from 'electron';
import { BRAND_IDENTITY } from '@cindy/maker-shared/brand-identity';
import Database from 'better-sqlite3';
import { CURRENT_CINDY_REGION } from '../shared/brandRegion.js';

import {
  createBetterSqliteDatabase,
  restrictDbFilePermissions,
  resolveBetterSqliteNativeBinding,
} from './localDb/betterSqliteFactory';
import { createLogger } from './logger';

/** marker 文件名(userData 根下)。存在 = 本 profile 已做过首登轻量迁移。 */
export const LEGACY_MIGRATION_MARKER_FILENAME = 'mToc';

/** 老目录里媒体总仓的目录名(与新 userData 下同名,原样平移)。 */
const CINDY_MEDIA_DIR_NAME = 'cindy-media';

/**
 * 老目录里无文件夹对话工作目录的根目录名(与新 userData 下同名,原样平移;
 * 与 localDb/dialogueWorkspace.ts、localDb/dialogueWorkdirSelfHeal.ts 一致)。
 */
const DIALOGUES_DIR_NAME = 'dialogues';

/** XDMaker Meka 的非敏感产品配置；随数据库一起迁移到 Cindy Meka。 */
const MEKA_SETTINGS_FILE_NAME = 'meka-assistant-settings.json';
const MEKA_ROLES_DIR_NAME = 'meka-roles';
/** XDMaker Meka 收尾版写入的跨账号系统身份锚；结构以 xdmaker/meka/main 为准。 */
const IDENTITY_ANCHOR_REL_PATH = path.join('migration', 'identity-anchor.json');

/**
 * dialogue 工作目录里的依赖树可由包管理器重建，且 pnpm 会在其中创建大量目录符号链接。
 * 搬迁这些内容既没有必要，也会让 copyFile 在 macOS 上对目录链接报 ENOTSUP。
 */
const DIALOGUE_SKIP_DIR_NAMES: ReadonlySet<string> = new Set(['node_modules']);

/**
 * agent 浏览器登录态的搬运路径:老 `<legacy>/browser-runtime/browser/XDMaker` →
 * 新 `<userData>/browser-runtime/browser/Cindy`(搬运即完成 profile 目录的品牌
 * 改名;Chrome 窗口显示名由 runtime 启动时的 decoration 自愈刷新)。两端字面量
 * 与 mcp-integrations/browser.ts 的 LEGACY_MANAGED_PROFILE / MANAGED_PROFILE
 * 保持一致(那边的注释交叉引用了这里)。
 */
const BROWSER_RUNTIME_DIR_NAME = 'browser-runtime';
const BROWSER_PROFILES_SUBDIR = 'browser';
const LEGACY_BROWSER_PROFILE_NAME = 'XDMaker';
const CURRENT_BROWSER_PROFILE_NAME = 'Cindy';

/**
 * profile 搬运时跳过的目录名(任意层级命中即整棵跳过):Chrome 的重建型缓存,
 * 体积大且丢了无害——登录态在 Cookies / Login Data / Local State 等小文件里。
 */
const BROWSER_PROFILE_SKIP_DIR_NAMES: ReadonlySet<string> = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'ShaderCache',
  'GrShaderCache',
  'GraphiteDawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'Crashpad',
  'Crash Reports',
]);
/** profile 搬运时跳过的文件名前缀:Chrome 单实例锁,复制过去只会挡住新端启动。 */
const BROWSER_PROFILE_SKIP_FILE_PREFIXES: readonly string[] = ['Singleton'];

/** 推送给 renderer 的弹窗阶段。 */
export type LegacyMigrationPhase = 'confirm' | 'running' | 'done' | 'failed';

/** 内存可替身的最小 fs 面;默认实现见 realFsDeps。全部异步,不碰同步 API。 */
export interface LegacyMigrationFsDeps {
  /** 路径存在(文件或目录)。 */
  pathExists(p: string): Promise<boolean>;
  /** 读取 UTF-8 文本(marker 校验用)。 */
  readFile(p: string): Promise<string>;
  /** 列目录文件名;目录不存在返回 []。 */
  listDir(dir: string): Promise<string[]>;
  /**
   * 列目录条目,区分真实子目录与符号链接/junction;目录不存在返回 []。
   * 符号链接不允许落入 copyFile 分支,否则目录链接在 macOS 上会报 ENOTSUP。
   */
  listDirEntries(
    dir: string,
  ): Promise<Array<{ name: string; isDirectory: boolean; isSymbolicLink: boolean }>>;
  /** 文件字节数;media merge 的"已存在但截断"检测用。 */
  statSize(p: string): Promise<number>;
  /** 复制单文件(允许覆盖——只用于 .mtoc-tmp 临时名,最终名一律经 rename 入位)。 */
  copyFile(src: string, dest: string): Promise<void>;
  /** 原子改名(同卷)。Windows 上目标存在会失败,调用方先 removeIfExists。 */
  rename(src: string, dest: string): Promise<void>;
  /** 删除文件,不存在时静默成功。 */
  removeIfExists(p: string): Promise<void>;
  /** 递归建目录(mkdir -p)。 */
  mkdirp(dir: string): Promise<void>;
  /** 写文本文件(marker)。 */
  writeFile(p: string, content: string): Promise<void>;
}

/** UI 桥:main→renderer 弹窗状态推送 + 等待用户点「确定」。 */
export interface LegacyMigrationUiDeps {
  publish(phase: LegacyMigrationPhase): void;
  waitForConfirm(): Promise<void>;
}

/** runLegacyUserDataMigration 的全量依赖注入面。 */
export interface LegacyUserDataMigrationDeps {
  /** 新 userData 目录(绝对路径)。 */
  userDataDir: string;
  /** 老 userData 目录候选名(同级目录下逐个探测,取第一个存在的)。 */
  legacyDirNames: readonly string[];
  /** 老主库文件名前缀(`<prefix>-<userId>.db`)。 */
  legacyDbPrefixes: readonly string[];
  /** 新主库文件名前缀(目标 `<prefix>-<userId>.db`)。 */
  currentDbPrefix: string;
  /** 当前 Cindy 账号 email；用于匹配旧 Meka identity anchor。 */
  currentUserEmail?: string | null;
  fs: LegacyMigrationFsDeps;
  /**
   * 生产环境使用 SQLite online backup 把 WAL 合入完整主库并 quick_check；
   * 单测未注入时保留文件级复制假体，以覆盖原子落位与 sidecar 清理。
   */
  copyDatabase?(sourcePath: string, temporaryTargetPath: string): Promise<void>;
  /** 注入时钟(marker 的 migratedAt)。 */
  now(): Date;
  log: { info(msg: string, ...args: unknown[]): void; warn(msg: string, ...args: unknown[]): void };
  ui: LegacyMigrationUiDeps;
}

export type LegacyUserDataMigrationResult =
  | { status: 'marker-exists' }
  | { status: 'no-legacy-dir' }
  | {
      status: 'migrated';
      sourceDb: string | null;
      mediaCopied: boolean;
      dialoguesCopied: boolean;
      browserProfileCopied: boolean;
      mekaSettingsCopied: boolean;
      mekaRolesCopied: boolean;
    }
  | { status: 'failed'; error: string };

/** wal / shm 附属文件后缀(SQLite sidecar 命名:`<db 文件全名><后缀>`)。 */
const DB_SIDECAR_SUFFIXES = ['-wal', '-shm'] as const;
/** 与某一 DB migration history 绑定的旁路身份文件；换主库时不可沿用。 */
const DB_RUNTIME_METADATA_SUFFIXES = ['.migration-runtime.json'] as const;
/** packaged smoke 会创建该后缀的临时 DB；它永远不能成为真实用户的迁移源。 */
const SMOKE_TEST_DB_SUFFIX = '-__smoke_test__.db';
/** 已误迁 smoke DB 时，替换前保留当前目标库及 sidecar 的一次性备份。 */
export const SMOKE_MIGRATION_BACKUP_SUFFIX = '.before-smoke-repair.bak';

/**
 * 复制暂存临时名后缀。所有复制先落 tmp、就绪后 rename 入位——中途崩溃只会
 * 残留 tmp 文件(重试时清理重拷),**最终名一旦存在即是完整文件**,"目标已
 * 存在跳过"才不会把截断半成品转正(review P1)。
 */
export const COPY_TMP_SUFFIX = '.mtoc-tmp';

/**
 * db + sidecar 原子入位:全部先拷到 tmp,再按「sidecar 先、db 最后」rename。
 * db 最终名是"完成信号"——它 rename 成功前,重试路径永远走整体重拷。
 */
async function copyDbAtomic(
  fs: LegacyMigrationFsDeps,
  sourceDbPath: string,
  targetDbPath: string,
  options: {
    replaceExisting?: boolean;
    copyDatabase?: (sourcePath: string, temporaryTargetPath: string) => Promise<void>;
  } = {},
): Promise<void> {
  const dbTmp = `${targetDbPath}${COPY_TMP_SUFFIX}`;
  await fs.removeIfExists(dbTmp);
  if (options.copyDatabase) {
    await options.copyDatabase(sourceDbPath, dbTmp);
  } else {
    await fs.copyFile(sourceDbPath, dbTmp);
  }
  const sidecarRenames: Array<{ tmp: string; final: string }> = [];
  // online backup 已把 WAL 中已提交数据合并进 dbTmp，不得再混入源 sidecar。
  // 文件级复制只服务 DI 单测与兼容假体，仍需带上 wal/shm。
  if (!options.copyDatabase) {
    for (const suffix of DB_SIDECAR_SUFFIXES) {
      const sidecarSrc = `${sourceDbPath}${suffix}`;
      if (!(await fs.pathExists(sidecarSrc))) continue;
      const final = `${targetDbPath}${suffix}`;
      const tmp = `${final}${COPY_TMP_SUFFIX}`;
      await fs.removeIfExists(tmp);
      await fs.copyFile(sidecarSrc, tmp);
      sidecarRenames.push({ tmp, final });
    }
  }
  // 普通迁移要求目标 db 不存在；唯一替换路径是 marker 已证明目标来自 smoke DB，
  // 且调用方已经完成不覆盖的备份。先移走旧 db，再统一清掉旧 sidecar，防止
  // 「本次源侧无 wal」时 stale wal 与新 db 错配。
  if (options.replaceExisting) await fs.removeIfExists(targetDbPath);
  for (const suffix of DB_SIDECAR_SUFFIXES) {
    await fs.removeIfExists(`${targetDbPath}${suffix}`);
  }
  for (const suffix of DB_RUNTIME_METADATA_SUFFIXES) {
    await fs.removeIfExists(`${targetDbPath}${suffix}`);
  }
  for (const { tmp, final } of sidecarRenames) {
    await fs.rename(tmp, final);
  }
  await fs.rename(dbTmp, targetDbPath);
}

/** 清理上次崩溃可能残留的 db/sidecar tmp 文件(目标库已存在的跳过分支用)。 */
async function cleanupDbTmp(fs: LegacyMigrationFsDeps, targetDbPath: string): Promise<void> {
  await fs.removeIfExists(`${targetDbPath}${COPY_TMP_SUFFIX}`);
  for (const suffix of DB_SIDECAR_SUFFIXES) {
    await fs.removeIfExists(`${targetDbPath}${suffix}${COPY_TMP_SUFFIX}`);
  }
}

/**
 * 单文件只在目标缺失时复制。配置迁移不能覆盖用户已经在 Cindy Meka 中保存的新值；
 * tmp + rename 保证崩溃时最终路径不会留下半文件。
 */
async function copyFileIfMissing(
  fs: LegacyMigrationFsDeps,
  sourcePath: string,
  targetPath: string,
): Promise<boolean> {
  if (!(await fs.pathExists(sourcePath)) || (await fs.pathExists(targetPath))) return false;
  await fs.mkdirp(path.dirname(targetPath));
  const tmp = `${targetPath}${COPY_TMP_SUFFIX}`;
  await fs.removeIfExists(tmp);
  await fs.copyFile(sourcePath, tmp);
  await fs.rename(tmp, targetPath);
  return true;
}

/** 已知 smoke 误迁修复前备份目标 DB 与 sidecar；既有备份永不覆盖。 */
async function backupTargetDbBeforeSmokeRepair(
  fs: LegacyMigrationFsDeps,
  targetDbPath: string,
): Promise<void> {
  for (const suffix of ['', ...DB_SIDECAR_SUFFIXES, ...DB_RUNTIME_METADATA_SUFFIXES]) {
    const source = `${targetDbPath}${suffix}`;
    const backup = `${source}${SMOKE_MIGRATION_BACKUP_SUFFIX}`;
    await copyFileIfMissing(fs, source, backup);
  }
}

/**
 * media 目录递归 merge:目标缺失 → tmp+rename 复制;目标存在且字节数一致 →
 * 跳过;字节数不一致(上次截断残留)→ 重拷修复。cindy-media 是内容寻址 blob
 * 仓,"文件名在 = 内容对"必须由字节数兜底,否则截断 blob 永久坏(review P1)。
 */
async function mergeCopyDir(
  fs: LegacyMigrationFsDeps,
  srcDir: string,
  destDir: string,
  skip?: {
    /** 任意层级命中目录名即整棵跳过(浏览器 profile 的 Chrome 缓存目录)。 */
    dirNames?: ReadonlySet<string>;
    /** 任意层级命中文件名前缀即跳过(Chrome Singleton 锁)。 */
    filePrefixes?: readonly string[];
    /** 配置目录迁移时保留目标已有文件；媒体默认修复字节数不一致的截断文件。 */
    existingFilePolicy?: 'repair-size-mismatch' | 'preserve';
  },
): Promise<void> {
  await fs.mkdirp(destDir);
  for (const entry of await fs.listDirEntries(srcDir)) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    // 不解引用符号链接/junction:目标可能位于老 userData 之外或形成环；pnpm 的目录链接
    // 也不能交给 copyFile。迁移只搬真实目录与普通文件。
    if (entry.isSymbolicLink) continue;
    if (entry.isDirectory) {
      if (skip?.dirNames?.has(entry.name)) continue;
      await mergeCopyDir(fs, src, dest, skip);
      continue;
    }
    if (skip?.filePrefixes?.some((prefix) => entry.name.startsWith(prefix))) continue;
    if (entry.name.endsWith(COPY_TMP_SUFFIX)) continue; // 防御:源侧不应有
    if (await fs.pathExists(dest)) {
      if (skip?.existingFilePolicy === 'preserve') continue;
      const srcSize = await fs.statSize(src);
      const destSize = await fs.statSize(dest);
      if (srcSize === destSize) continue;
    }
    const tmp = `${dest}${COPY_TMP_SUFFIX}`;
    await fs.removeIfExists(tmp);
    await fs.copyFile(src, tmp);
    await fs.removeIfExists(dest);
    await fs.rename(tmp, dest);
  }
}

type SourceDbSelection =
  | {
      status: 'selected';
      path: string;
      strategy: 'current-user-id' | 'identity-anchor' | 'only-candidate';
    }
  | { status: 'none' }
  | { status: 'blocked'; error: string };

interface IdentityAnchorAccount {
  userId: string;
  email: string | null;
}

function normalizeEmail(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim().toLowerCase();
  return normalized || null;
}

async function readIdentityAnchor(
  legacyDir: string,
  fs: LegacyMigrationFsDeps,
): Promise<
  | { status: 'absent' }
  | { status: 'valid'; accounts: IdentityAnchorAccount[] }
  | { status: 'invalid'; error: string }
> {
  const anchorPath = path.join(legacyDir, IDENTITY_ANCHOR_REL_PATH);
  if (!(await fs.pathExists(anchorPath))) return { status: 'absent' };
  try {
    const parsed = JSON.parse(await fs.readFile(anchorPath)) as {
      schemaVersion?: unknown;
      accounts?: unknown;
    };
    if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.accounts)) {
      return { status: 'invalid', error: 'identity anchor has an unsupported shape' };
    }
    const accounts = parsed.accounts.filter(
      (account): account is IdentityAnchorAccount =>
        account != null &&
        typeof account === 'object' &&
        typeof (account as IdentityAnchorAccount).userId === 'string' &&
        (account as IdentityAnchorAccount).userId.length > 0 &&
        ((account as IdentityAnchorAccount).email == null ||
          typeof (account as IdentityAnchorAccount).email === 'string'),
    );
    if (accounts.length !== parsed.accounts.length) {
      return { status: 'invalid', error: 'identity anchor contains an invalid account' };
    }
    return { status: 'valid', accounts };
  } catch (err) {
    return {
      status: 'invalid',
      error: `identity anchor is unreadable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function dbPathForIdentity(legacyDir: string, prefix: string, userId: string): string | null {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(prefix)) return null;
  const fileName = `${prefix}-${userId}.db`;
  // userId 来自远端身份，不假设其字符集；只要求拼出的值仍是单一文件名段，
  // 拒绝 `/`、`\`、`.` / `..` 等路径逃逸。避免 path.resolve 改写 Windows
  // 根相对路径或 UNC 语义。
  if (path.basename(fileName) !== fileName || fileName === '.' || fileName === '..') return null;
  const root = path.normalize(legacyDir);
  const candidate = path.join(root, fileName);
  return path.dirname(candidate) === root ? candidate : null;
}

async function eligibleDbCandidates(
  legacyDir: string,
  legacyDbPrefixes: readonly string[],
  fs: LegacyMigrationFsDeps,
): Promise<string[]> {
  return (await fs.listDir(legacyDir))
    .filter(
      (name) =>
        name.endsWith('.db') &&
        !name.endsWith(SMOKE_TEST_DB_SUFFIX) &&
        legacyDbPrefixes.some((prefix) => name.startsWith(`${prefix}-`)),
    )
    .map((name) => path.join(legacyDir, name));
}

/**
 * 选源库严格复用 xdmaker/meka/main 的身份锚语义：
 *  1) 同 UID 精确命中；
 *  2) identity anchor 按 email 唯一映射旧 UID；
 *  3) 无 anchor 时仅接受单一非 smoke 候选。
 * 多账号、损坏 anchor、anchor 与 DB 不一致均 fail closed，绝不按 mtime 猜测。
 */
async function pickSourceDb(
  legacyDirs: readonly string[],
  userId: string,
  currentUserEmail: string | null | undefined,
  legacyDbPrefixes: readonly string[],
  fs: LegacyMigrationFsDeps,
): Promise<SourceDbSelection> {
  // 同一账号系统或 UID 恰好保持一致时，不需要身份锚。
  for (const legacyDir of legacyDirs) {
    for (const prefix of legacyDbPrefixes) {
      const exact = dbPathForIdentity(legacyDir, prefix, userId);
      if (exact == null || exact.endsWith(SMOKE_TEST_DB_SUFFIX)) continue;
      if (await fs.pathExists(exact)) {
        return { status: 'selected', path: exact, strategy: 'current-user-id' };
      }
    }
  }

  // 直接来源目录里的 anchor 是账号系统切换的权威映射。只要存在，就不允许
  // 降级到“猜一个 DB”；损坏或不匹配必须保留重试并给出诊断。
  for (const legacyDir of legacyDirs) {
    const anchor = await readIdentityAnchor(legacyDir, fs);
    if (anchor.status === 'absent') continue;
    if (anchor.status === 'invalid') {
      return { status: 'blocked', error: anchor.error };
    }
    const email = normalizeEmail(currentUserEmail);
    if (email == null) {
      return {
        status: 'blocked',
        error: 'identity anchor exists, but current user email is missing',
      };
    }
    const hits = anchor.accounts.filter(
      (account) => account.userId !== userId && normalizeEmail(account.email) === email,
    );
    if (hits.length !== 1) {
      return {
        status: 'blocked',
        error:
          hits.length === 0
            ? 'identity anchor does not match the current user'
            : 'identity anchor matches multiple legacy users',
      };
    }
    const candidates = (
      await Promise.all(
        legacyDbPrefixes.map(async (prefix) => {
          const candidate = dbPathForIdentity(legacyDir, prefix, hits[0].userId);
          return candidate != null && (await fs.pathExists(candidate)) ? candidate : null;
        }),
      )
    ).filter((candidate): candidate is string => candidate != null);
    if (candidates.length !== 1) {
      return {
        status: 'blocked',
        error:
          candidates.length === 0
            ? 'identity anchor matched, but its legacy database is missing'
            : 'identity anchor matched multiple legacy database prefixes',
      };
    }
    return { status: 'selected', path: candidates[0], strategy: 'identity-anchor' };
  }

  // 更早、没有身份锚的版本只在候选唯一时兼容；目录优先级仍由 legacyDirNames 决定。
  for (const legacyDir of legacyDirs) {
    const candidates = await eligibleDbCandidates(legacyDir, legacyDbPrefixes, fs);
    if (candidates.length === 1) {
      return { status: 'selected', path: candidates[0], strategy: 'only-candidate' };
    }
    if (candidates.length > 1) {
      return {
        status: 'blocked',
        error: `multiple legacy databases found under ${path.basename(legacyDir)}`,
      };
    }
  }
  return { status: 'none' };
}

/** 仅识别本次已知的 smoke 误迁 marker；未知/损坏 marker 保持既有 fail-closed 跳过语义。 */
async function markerReferencesSmokeTestDb(
  fs: LegacyMigrationFsDeps,
  markerPath: string,
): Promise<boolean> {
  try {
    const parsed = JSON.parse(await fs.readFile(markerPath)) as unknown;
    if (parsed == null || typeof parsed !== 'object') return false;
    const sourceDb = (parsed as { sourceDb?: unknown }).sourceDb;
    return typeof sourceDb === 'string' && sourceDb.endsWith(SMOKE_TEST_DB_SUFFIX);
  } catch {
    return false;
  }
}

/** 写 mToc marker(JSON;schemaVersion 固定 1)。 */
async function writeMarker(
  deps: LegacyUserDataMigrationDeps,
  userId: string,
  sourceDb: string | null,
  mediaCopied: boolean,
  dialoguesCopied: boolean,
  browserProfileCopied: boolean,
  mekaSettingsCopied: boolean,
  mekaRolesCopied: boolean,
): Promise<void> {
  await deps.fs.writeFile(
    path.join(deps.userDataDir, LEGACY_MIGRATION_MARKER_FILENAME),
    JSON.stringify(
      {
        schemaVersion: 1,
        migratedAt: deps.now().toISOString(),
        userId,
        sourceDb,
        mediaCopied,
        dialoguesCopied,
        browserProfileCopied,
        mekaSettingsCopied,
        mekaRolesCopied,
      },
      null,
      2,
    ),
  );
}

/**
 * 首登轻量数据迁移核心流程。纯 DI,不 import electron;绝不 throw
 * (所有失败都收敛成 failed 结果),调用方(beforeEnsureReady)无需 try/catch。
 */
export async function runLegacyUserDataMigration(
  userId: string,
  deps: LegacyUserDataMigrationDeps,
): Promise<LegacyUserDataMigrationResult> {
  try {
    // 1. marker 已存在通常零开销返回。早期 Cindy Meka 版本可能把 packaged smoke
    // DB 误选为真实源库；仅该 marker 允许进入一次可备份、可重试的修复路径。
    const markerPath = path.join(deps.userDataDir, LEGACY_MIGRATION_MARKER_FILENAME);
    const markerExists = await deps.fs.pathExists(markerPath);
    const repairingSmokeMigration =
      markerExists && (await markerReferencesSmokeTestDb(deps.fs, markerPath));
    if (markerExists && !repairingSmokeMigration) return { status: 'marker-exists' };
    if (repairingSmokeMigration) {
      deps.log.warn('legacy userData migration: repairing prior smoke DB migration');
    }

    // 2. 探测同级老目录。文件/目录资产仍以最直接的旧 Meka 目录为准；DB 选择
    // 会跨候选目录做严格身份匹配，直接来源没有库时才能接管更早的 xdt-maker。
    const parentDir = path.dirname(deps.userDataDir);
    const legacyDirs: string[] = [];
    for (const name of deps.legacyDirNames) {
      const candidate = path.join(parentDir, name);
      if (await deps.fs.pathExists(candidate)) legacyDirs.push(candidate);
    }
    if (legacyDirs.length === 0) {
      // 全新用户:无可迁,静默写 marker,不打扰。
      await writeMarker(deps, userId, null, false, false, false, false, false);
      deps.log.info('legacy userData migration: no legacy dir, marker written silently');
      return { status: 'no-legacy-dir' };
    }
    const legacyDir = legacyDirs[0];

    // 3. 有老数据 → 弹确认窗并等待用户点「确定」(唯一按钮,不可取消)。
    deps.ui.publish('confirm');
    await deps.ui.waitForConfirm();
    deps.ui.publish('running');

    try {
      // 3a/3b. 主库 + wal/shm 附属文件。
      let copiedSourceDb: string | null = null;
      const sourceDb = await pickSourceDb(
        legacyDirs,
        userId,
        deps.currentUserEmail,
        deps.legacyDbPrefixes,
        deps.fs,
      );
      if (sourceDb.status === 'blocked') {
        throw new Error(sourceDb.error);
      }
      if (sourceDb.status === 'none') {
        if (repairingSmokeMigration) {
          throw new Error('prior smoke DB migration detected, but no eligible legacy DB was found');
        }
        deps.log.info('legacy userData migration: no legacy db found, skipping db step');
      } else {
        const sourceDbPath = sourceDb.path;
        const targetDbPath = path.join(deps.userDataDir, `${deps.currentDbPrefix}-${userId}.db`);
        if (await deps.fs.pathExists(targetDbPath)) {
          if (repairingSmokeMigration) {
            await backupTargetDbBeforeSmokeRepair(deps.fs, targetDbPath);
            await copyDbAtomic(deps.fs, sourceDbPath, targetDbPath, {
              replaceExisting: true,
              copyDatabase: deps.copyDatabase,
            });
            copiedSourceDb = path.basename(sourceDbPath);
            deps.log.info(
              'legacy userData migration: replaced smoke DB from %s via %s (previous target backed up)',
              copiedSourceDb,
              sourceDb.strategy,
            );
          } else {
            // 最终名只经 rename 产生,存在即完整成品(半成品只会以 .mtoc-tmp 残留),
            // 跳过是安全的;顺手清理上次崩溃可能留下的 tmp。
            await cleanupDbTmp(deps.fs, targetDbPath);
            deps.log.info(
              'legacy userData migration: target db already exists, skipping db copy (%s)',
              path.basename(targetDbPath),
            );
          }
        } else {
          await copyDbAtomic(deps.fs, sourceDbPath, targetDbPath, {
            copyDatabase: deps.copyDatabase,
          });
          copiedSourceDb = path.basename(sourceDbPath);
          deps.log.info(
            'legacy userData migration: db copied %s -> %s via %s',
            copiedSourceDb,
            path.basename(targetDbPath),
            sourceDb.strategy,
          );
        }
      }

      // 3c. cindy-media 递归 merge(逐文件 tmp+rename;同名同字节跳过,字节不一致
      // 视为截断残留重拷修复);老目录没有则跳过。
      let mediaCopied = false;
      const legacyMediaDir = path.join(legacyDir, CINDY_MEDIA_DIR_NAME);
      if (await deps.fs.pathExists(legacyMediaDir)) {
        await mergeCopyDir(
          deps.fs,
          legacyMediaDir,
          path.join(deps.userDataDir, CINDY_MEDIA_DIR_NAME),
        );
        mediaCopied = true;
      }

      // 3c2. dialogues 无文件夹对话工作目录递归 merge(与 media 同语义):agent
      // 可能在这些 cwd 里写过真实文件,必须随迁,否则老目录一旦被清理,老会话
      // 的工作目录内容就永久丢失(DB 里 working_dir 的前缀改写由 db ready 后的
      // sweepLegacyDialogueWorkingDirs 统一完成,二者同一次登录内先后衔接)。
      let dialoguesCopied = false;
      const legacyDialoguesDir = path.join(legacyDir, DIALOGUES_DIR_NAME);
      if (await deps.fs.pathExists(legacyDialoguesDir)) {
        await mergeCopyDir(
          deps.fs,
          legacyDialoguesDir,
          path.join(deps.userDataDir, DIALOGUES_DIR_NAME),
          { dirNames: DIALOGUE_SKIP_DIR_NAMES },
        );
        dialoguesCopied = true;
      }

      // 3d. agent 浏览器 profile(登录态):老 browser/XDMaker → 新 browser/Cindy,
      // 搬运即完成品牌改名。Chrome 重建型缓存目录与 Singleton 锁跳过(登录态在
      // Cookies / Login Data / Local State 等小文件里);老目录没有则跳过。
      let browserProfileCopied = false;
      const legacyProfileDir = path.join(
        legacyDir,
        BROWSER_RUNTIME_DIR_NAME,
        BROWSER_PROFILES_SUBDIR,
        LEGACY_BROWSER_PROFILE_NAME,
      );
      if (await deps.fs.pathExists(legacyProfileDir)) {
        await mergeCopyDir(
          deps.fs,
          legacyProfileDir,
          path.join(
            deps.userDataDir,
            BROWSER_RUNTIME_DIR_NAME,
            BROWSER_PROFILES_SUBDIR,
            CURRENT_BROWSER_PROFILE_NAME,
          ),
          {
            dirNames: BROWSER_PROFILE_SKIP_DIR_NAMES,
            filePrefixes: BROWSER_PROFILE_SKIP_FILE_PREFIXES,
          },
        );
        browserProfileCopied = true;
        deps.log.info('legacy userData migration: browser profile copied (XDMaker -> Cindy)');
      }

      // 3e. Meka 产品配置：只搬非敏感设置与自定义角色。目标已存在时一律保留
      // Cindy Meka 新值；safe-storage 不复制，跨应用身份的凭证由用户重新授权。
      const mekaSettingsCopied = await copyFileIfMissing(
        deps.fs,
        path.join(legacyDir, MEKA_SETTINGS_FILE_NAME),
        path.join(deps.userDataDir, MEKA_SETTINGS_FILE_NAME),
      );
      let mekaRolesCopied = false;
      const legacyMekaRolesDir = path.join(legacyDir, MEKA_ROLES_DIR_NAME);
      if (await deps.fs.pathExists(legacyMekaRolesDir)) {
        await mergeCopyDir(
          deps.fs,
          legacyMekaRolesDir,
          path.join(deps.userDataDir, MEKA_ROLES_DIR_NAME),
          { existingFilePolicy: 'preserve' },
        );
        mekaRolesCopied = true;
      }

      // 3f. 全部成功 → 写 marker → done。
      await writeMarker(
        deps,
        userId,
        copiedSourceDb,
        mediaCopied,
        dialoguesCopied,
        browserProfileCopied,
        mekaSettingsCopied,
        mekaRolesCopied,
      );
      deps.ui.publish('done');
      return {
        status: 'migrated',
        sourceDb: copiedSourceDb,
        mediaCopied,
        dialoguesCopied,
        browserProfileCopied,
        mekaSettingsCopied,
        mekaRolesCopied,
      };
    } catch (err) {
      // 3g. 复制阶段失败:不写 marker(下次登录重试),failed 弹窗,不阻塞登录。
      const message = err instanceof Error ? err.message : String(err);
      deps.log.warn('legacy userData migration failed (will retry next login): %s', message);
      deps.ui.publish('failed');
      return { status: 'failed', error: message };
    }
  } catch (err) {
    // marker / 探测阶段的意外失败:同样不阻塞登录;不弹窗(此时还没进确认流程,
    // 或 marker 写失败——下次登录自然重来)。
    const message = err instanceof Error ? err.message : String(err);
    deps.log.warn('legacy userData migration aborted: %s', message);
    return { status: 'failed', error: message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Electron 默认实现(IPC 桥 + 真实 fs)。
// ─────────────────────────────────────────────────────────────────────────────

const log = createLogger('legacyUserDataMigration');

/** 当前推送给 renderer 的阶段(renderer 挂载晚于推送时经 get-state 补拉)。 */
let currentPhase: LegacyMigrationPhase | null = null;
/** confirm 弹窗的 pending resolver(同一时刻至多一个迁移在等确认)。 */
let pendingConfirmResolver: (() => void) | null = null;
/** 并发防重入:beforeEnsureReady 可能被重复触发,共享同一个 in-flight promise。 */
let inFlight: Promise<LegacyUserDataMigrationResult> | null = null;

function broadcastPhase(phase: LegacyMigrationPhase): void {
  currentPhase = phase;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('legacy-migration:state', { phase });
    }
  }
}

const realFsDeps: LegacyMigrationFsDeps = {
  pathExists: async (p) => {
    try {
      await fsp.access(p);
      return true;
    } catch {
      return false;
    }
  },
  readFile: (p) => fsp.readFile(p, 'utf8'),
  listDir: async (dir) => {
    try {
      return await fsp.readdir(dir);
    } catch {
      return [];
    }
  },
  listDirEntries: async (dir) => {
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      return await Promise.all(
        entries.map(async (entry) => {
          const reportedSymbolicLink = entry.isSymbolicLink();
          if (reportedSymbolicLink || !entry.isDirectory()) {
            return {
              name: entry.name,
              isDirectory: entry.isDirectory(),
              isSymbolicLink: reportedSymbolicLink,
            };
          }

          // 某些 Node/libuv 组合会把 Windows junction 报成普通目录；只对目录做
          // lstat 二次核验，避免对工作区里的海量普通文件增加一次额外系统调用。
          const entryPath = path.join(dir, entry.name);
          try {
            const isSymbolicLink = (await fsp.lstat(entryPath)).isSymbolicLink();
            return {
              name: entry.name,
              isDirectory: !isSymbolicLink,
              isSymbolicLink,
            };
          } catch (err) {
            // 条目在 readdir 与 lstat 之间消失或不可读时 fail-closed，不递归进入未知目标。
            log.warn(
              'legacy userData migration: failed to lstat directory entry, skipping %s: %s',
              entryPath,
              err instanceof Error ? err.message : String(err),
            );
            return { name: entry.name, isDirectory: false, isSymbolicLink: true };
          }
        }),
      );
    } catch {
      return [];
    }
  },
  statSize: async (p) => (await fsp.stat(p)).size,
  copyFile: (src, dest) => fsp.copyFile(src, dest),
  rename: (src, dest) => fsp.rename(src, dest),
  removeIfExists: (p) => fsp.rm(p, { force: true }),
  mkdirp: async (dir) => {
    await fsp.mkdir(dir, { recursive: true });
  },
  writeFile: (p, content) => fsp.writeFile(p, content, 'utf8'),
};

/**
 * 从只读旧库生成完整 SQLite 副本：online backup 会把 WAL 中已提交事务合入目标，
 * 随后 quick_check + 核心表检查阻止损坏或非 Cindy/XDMaker 主库落位。
 */
export async function copyDatabaseVerified(sourcePath: string, targetPath: string): Promise<void> {
  // 旧目录契约是内容与元数据都只读。createBetterSqliteDatabase 会在非 Windows
  // 平台 chmod 0600，因此源库必须直接用同一 native binding 打开；目标副本仍走
  // factory，继续获得权限收紧。
  const nativeBinding = resolveBetterSqliteNativeBinding();
  const source = new Database(sourcePath, {
    readonly: true,
    fileMustExist: true,
    ...(nativeBinding ? { nativeBinding } : {}),
  });
  try {
    await source.backup(targetPath);
  } finally {
    source.close();
  }

  const probe = createBetterSqliteDatabase(targetPath, { readonly: true, fileMustExist: true });
  try {
    const verdict = (probe.pragma('quick_check') as Array<{ quick_check?: string }>)[0]
      ?.quick_check;
    if (verdict !== 'ok') {
      throw new Error(`migrated database quick_check = ${verdict ?? 'unknown'}`);
    }
    const coreTables = probe
      .prepare(
        `SELECT name
           FROM sqlite_master
          WHERE type = 'table'
            AND name IN ('sessions', 'messages', 'migration_meta')`,
      )
      .all() as Array<{ name: string }>;
    if (new Set(coreTables.map((row) => row.name)).size !== 3) {
      throw new Error('migrated database is missing required application tables');
    }
  } finally {
    probe.close();
  }
  restrictDbFilePermissions(targetPath);
}

const electronUiDeps: LegacyMigrationUiDeps = {
  publish: broadcastPhase,
  waitForConfirm: () =>
    new Promise<void>((resolve) => {
      pendingConfirmResolver = resolve;
    }),
};

/**
 * 注册迁移弹窗的 IPC handler(bootstrap 里在 registerLocalDbIpc 前调用一次)。
 *  - `legacy-migration:confirm`:renderer 点「确定」→ 放行等待中的迁移;
 *    「失败 → 继续」也走这条(无 pending resolver 时仅清掉 failed 态)。
 *  - `legacy-migration:get-state`:renderer 弹窗组件挂载时补拉当前阶段,
 *    避免「main 先推送、renderer 后订阅」丢事件。
 * 两个 handler 都没有业务错误路径,无需 throwIpcError(规则 13 的错误编码协议
 * 只约束失败路径)。
 */
export function registerLegacyMigrationIpc(): void {
  ipcMain.handle('legacy-migration:confirm', () => {
    const resolver = pendingConfirmResolver;
    pendingConfirmResolver = null;
    if (resolver != null) {
      resolver();
      return;
    }
    // failed 态下的「继续」:清态,防止 renderer 重挂载后经 get-state 再次弹出。
    if (currentPhase === 'failed' || currentPhase === 'done') currentPhase = null;
  });
  ipcMain.handle('legacy-migration:get-state', () => ({ phase: currentPhase }));
}

/**
 * dev userData 覆写(--isolated 沙箱 / 手动 XDT_USER_DATA_DIR)下必须跳过首登迁移。
 *
 * 沙箱目录(如 <userData>-dev)与真实 userData 同级,首次登录时沙箱里没有 mToc
 * marker，探测会命中同级的真实旧 Meka 目录 → 弹确认窗并把用户真实主库 /
 * cindy-media / dialogues / 浏览器 profile 整套复制进临时沙箱。这既不是沙箱的
 * 语义(隔离、不动正式数据),也会产生 GB 级无意义复制。isolated 的 argv 与 env
 * 两条声明通道最终都会把生效目录同步进 XDT_USER_DATA_DIR(main/index.ts),
 * 因此这里以该 env 为唯一检测面。packaged 永不跳过(线上升级迁移不受影响)。
 * 纯函数、零 electron 依赖,便于单测。
 */
export function shouldSkipLegacyMigrationForDevSandbox(input: {
  isPackaged: boolean;
  envUserDataDir: string | undefined;
}): boolean {
  return !input.isPackaged && Boolean(input.envUserDataDir?.trim());
}

/**
 * bootstrap 挂载点:首次登录成功后、ensureReady 打开 db 前调用。
 * 幂等 + 防重入;marker 已写时零开销。绝不 throw。
 */
export async function runLegacyUserDataMigrationForUser(user: {
  id: string;
  email: string | null;
}): Promise<void> {
  // 仅 cn 构建迁移：旧 XDMaker Meka 数据属于 cn 身份（老渠道只有国内版），
  // global 构建(同机双装)是全新身份,把 cn 的历史数据导进 global 库会
  // 跨区域串台(两边 auth 后端不同,会话 / 凭证对不上)。
  if (CURRENT_CINDY_REGION !== 'cn') return;
  // dev 沙箱 / userData 覆写:不探测、不弹窗、不写 marker,纯跳过(见上方谓词注释)。
  if (
    shouldSkipLegacyMigrationForDevSandbox({
      isPackaged: app.isPackaged,
      envUserDataDir: process.env.XDT_USER_DATA_DIR,
    })
  ) {
    log.info('legacy userData migration: dev userData override active, skipped');
    return;
  }
  if (inFlight != null) {
    await inFlight;
    return;
  }
  inFlight = runLegacyUserDataMigration(user.id, {
    userDataDir: app.getPath('userData'),
    legacyDirNames: BRAND_IDENTITY.legacyUserDataDirNames,
    legacyDbPrefixes: BRAND_IDENTITY.legacyDbFilePrefixes,
    currentDbPrefix: BRAND_IDENTITY.dbFilePrefix,
    currentUserEmail: user.email,
    fs: realFsDeps,
    copyDatabase: copyDatabaseVerified,
    now: () => new Date(),
    log,
    ui: electronUiDeps,
  });
  try {
    await inFlight;
  } finally {
    inFlight = null;
  }
}
