// Entry: Electron startup → bootstrap-electron.ts (dynamic import).
import fixPath from 'fix-path';
import { app } from 'electron';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { exit, stderr } from 'node:process';
import {
  BRAND_IDENTITY,
  MAX_DESKTOP_DEVICE_ID_LENGTH,
  brandDesktopDeviceId,
  brandDesktopIsolatedDeviceId,
} from '@cindy/maker-shared/brand-identity';
import { CURRENT_CINDY_REGION } from '../shared/brandRegion.js';
import { resolveRegionUserDataDirName } from './regionUserData.js';
import { createLogger, initLogger } from './logger.js';
import { beginDesktopDevInstance, type DesktopDevMode } from './devStartupStatus.js';

// 同机双装(cn/global):global 构建把 userData 切到区域目录(CindyMekaGlobal),
// 与 cn 版(productName 默认 'CindyMeka')彻底分库;数据库 / 登录态 / 单实例锁 /
// sessionData 随 userData 目录天然隔离。必须在 initLogger()(packaged 日志
// 目录)、crashReporter、单实例锁与一切 userData 读取之前执行。cn 构建与
// dev 返回 null,零行为变化(dev 隔离语义由下方 devCliFlags 的 --isolated 承载)。
const regionUserDataDirName = resolveRegionUserDataDirName({
  isPackaged: app.isPackaged,
  region: CURRENT_CINDY_REGION,
  argv: process.argv,
});
if (regionUserDataDirName) {
  app.setPath('userData', path.join(app.getPath('appData'), regionUserDataDirName));
}

// Node happy-eyeballs(autoSelectFamily)默认每个地址只给 250ms 完成 TCP 握手,
// VPN/高 RTT 链路上直连海外端点(platform.claude.com 换 token、订阅模式模型流量等)
// 的合法握手常超过 250ms,所有地址族全被掐掉后 undici 只报一个裸 'fetch failed'。
// 与 voice-input/refinerHttpDispatcher.ts 的 per-pool 配置同值(2500ms),这里设
// 进程级默认值,兜住 main 里所有不走自建 dispatcher 的 fetch / net.connect。
setDefaultAutoSelectFamilyAttemptTimeout(2500);

initLogger();
const log = createLogger('fix-path');
log.debug(`[fix-path] before PATH=${process.env.PATH ?? ''}`);
fixPath();
log.debug(`[fix-path] after PATH=${process.env.PATH ?? ''}`);

// !! 必须在 dispatch() 之前同步执行 !!
// 把用户系统(HKCU / shell rc)注入到本进程 process.env 上的 Anthropic / Claude Code
// 体系 env 全部清掉,避免泄漏到我们 spawn 的 CC CLI 子进程。
// 字段列表 + 原理见 maker-core/agents/claude-code/env-builder.ts 里的
// SENSITIVE_ANTHROPIC_ENV_KEYS 注释。
//
// 这里同步 import 不走动态 import,确保 strip 在任何 module top-level 代码读
// process.env 之前执行。
import { stripSensitiveAnthropicEnv } from '@cindy/maker-core';

// device-link 远程控制:必须在任何 ipcMain.handle 调用之前 monkey-patch,
// 才能捕获到全量 channel → handler 映射(供被控端 dispatch 远程 invoke)。
// import 在 ESM 里被 hoist,patch 在 bootstrap-electron 动态 import(其内部注册
// 所有 handler)之前完成。
import { installInvokeCapture } from './device-link/invoke-registry.js';

const stripped = stripSensitiveAnthropicEnv();
if (stripped.length > 0) {
  stderr.write(`[cindy] stripped user-level Anthropic env: ${stripped.join(', ')}\n`);
}

installInvokeCapture();

// 启动期身份与 dev-only 覆写。dev 参数与 scripts/restart-desktop-remote.mjs 的
// --passive/--isolated 同义；人类直跑 pnpm dev:desktop* 时参数经 electron-forge
// 的 `--` 透传到这里，restart 脚本路径经 XDT_ISOLATED=1 声明隔离意图：
//   - XDT_USER_DATA_DIR / --isolated:userData 切独立目录 —— 多实例不抢 SQLite 锁
//     (device-link 联调)、或与正式版彻底分家(--isolated 默认 <userData>-dev)。
//   - 所有 Cindy Meka 实例都使用产品前缀 deviceId(cindy-meka-<机器指纹>),
//     与同机普通 Cindy 的裸指纹分家。服务端 refresh token 按 (user, device)
//     一对一存,若共用裸指纹,任一产品登录/续期都会覆盖另一边并造成同机互踢。
//   - 隔离模式在产品前缀下继续派生 cindy-meka-dev-<沙箱>-<机器指纹>；
//     显式设 XDT_DEVICE_ID_OVERRIDE 时尊重用户值。
//   - --passive / XDT_SCHEDULER_PASSIVE:定时任务自动触发让位给同机另一实例。
// 必须在 app 'ready' 和 authManager 动态加载前完成。CLI/目录覆写仅 dev 生效；
// 产品 deviceId 命名空间对 dev 与 packaged 一律生效。
import { machineIdSync } from 'node-machine-id';
import {
  resolveDevCliFlags,
  shouldEnforcePassiveMigrationCompatibility,
} from './devCliFlags.js';

const devFlags = resolveDevCliFlags({
  argv: process.argv,
  isPackaged: app.isPackaged,
  envUserDataDir: process.env.XDT_USER_DATA_DIR,
  defaultUserDataDir: app.getPath('userData'),
  envIsolated: process.env.XDT_ISOLATED,
  envIsolationName: process.env.XDT_ISOLATED_NAME,
  envDeviceIdOverride: process.env.XDT_DEVICE_ID_OVERRIDE,
  envSchedulerPassive: process.env.XDT_SCHEDULER_PASSIVE,
  envEndpointsCdn: process.env.XDT_ENDPOINTS_CDN,
});
if (devFlags.schedulerPassive) {
  // 统一收敛到 env:scheduler-host 只认 XDT_SCHEDULER_PASSIVE,不重复解析 argv。
  process.env.XDT_SCHEDULER_PASSIVE = '1';
  stderr.write('[cindy] dev scheduler passive mode (--passive)\n');
}
if (shouldEnforcePassiveMigrationCompatibility({
  isPackaged: app.isPackaged,
  schedulerPassive: devFlags.schedulerPassive,
  isolated: devFlags.isolated,
})) {
  // 内部启动契约：共享 userData 的 passive dev 只能打开与当前 checkout migration
  // 完全一致的数据库，且不得自行迁移。localDb 在用户数据库首次打开时消费本标记。
  process.env.XDT_PASSIVE_SHARED_USER_DATA = '1';
} else {
  // 防止 shell 中同名 ambient env 污染 packaged / isolated 启动语义。
  delete process.env.XDT_PASSIVE_SHARED_USER_DATA;
}
if (devFlags.endpointsCdn) {
  // 统一收敛到 env:clientEndpointsService 只认 XDT_ENDPOINTS_CDN,不重复解析 argv。
  process.env.XDT_ENDPOINTS_CDN = '1';
  stderr.write('[cindy] dev endpoints via CDN (--endpoints-cdn)\n');
}
if (devFlags.userDataDirOverride) {
  // 同步回 env,让读 env 的下游(日志、诊断)与实际生效目录一致。
  process.env.XDT_USER_DATA_DIR = devFlags.userDataDirOverride;
  app.setPath('userData', devFlags.userDataDirOverride);
  stderr.write(`[cindy] dev userData override → ${devFlags.userDataDirOverride}\n`);
}
if (devFlags.invalidIsolationName !== null) {
  // 名字不合法(字符集 / 长度)→ 已按默认沙箱处理(回落到不隔离会混进正式版
  // 数据,更危险),这里只大声警告,让用户发现自己起错了名字。
  stderr.write(
    `[cindy] WARN: invalid --isolated name "${devFlags.invalidIsolationName}"` +
      ' (allowed: A-Za-z0-9_-, max 32 chars); falling back to the DEFAULT sandbox\n',
  );
}
if (devFlags.needsIsolatedDeviceId) {
  // 必须在 authManager 模块加载(bootstrap 动态 import)之前落到 env——它在模块
  // 顶层读一次 XDT_DEVICE_ID_OVERRIDE ?? machineIdSync()。机器指纹极小概率取不到
  // (machineIdSync 抛),兜底用固定串:跨机器同账号双沙箱会撞,但比静默回落物理机
  // 指纹(必踢正式版)安全方向正确。
  // 长度硬预算 64；helper 保留完整产品/沙箱前缀，只截断机器指纹尾部。
  let isolatedDeviceId: string;
  try {
    isolatedDeviceId = brandDesktopIsolatedDeviceId(machineIdSync(), devFlags.isolationName);
  } catch {
    isolatedDeviceId = (
      `${BRAND_IDENTITY.desktopDeviceIdPrefix}isolated-dev` +
      `${devFlags.isolationName ? `-${devFlags.isolationName}` : ''}`
    ).slice(0, MAX_DESKTOP_DEVICE_ID_LENGTH);
  }
  process.env.XDT_DEVICE_ID_OVERRIDE = isolatedDeviceId;
  stderr.write(`[cindy] dev isolated deviceId → ${isolatedDeviceId}\n`);
} else if (!process.env.XDT_DEVICE_ID_OVERRIDE?.trim()) {
  // 普通 dev 与 packaged 都必须在 authManager 动态 import 前固定产品设备身份。
  process.env.XDT_DEVICE_ID_OVERRIDE = brandDesktopDeviceId(machineIdSync());
}

// 实例注册表对 dev 与 packaged 一律登记:dev/release 按 flavor 分锁域、共享同一
// userData 双开是受支持的工作流(bootstrap-electron 单例锁注释),owner-namespace
// 迁移的独占检查靠本注册表发现「还有谁共享这份 userData」——packaged 不登记的话,
// dev 实例会在 release 实例仍存活时误判独占并搬走 legacy 配置。
{
  const rootDir = app.isPackaged
    ? path.resolve(app.getAppPath())
    : path.resolve(app.getAppPath(), '..', '..');
  let commit: string | null = null;
  if (!app.isPackaged) {
    try {
      commit = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: rootDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || null;
    } catch {
      // Source provenance remains useful without a commit in exported/unusual checkouts.
    }
  }
  const declaredMode = process.env.XDT_DESKTOP_DEV_MODE;
  const mode: DesktopDevMode = declaredMode === 'remote' || declaredMode === 'local'
    ? declaredMode
    : 'unknown';
  const cleanupDevInstance = beginDesktopDevInstance({
    userDataDir: app.getPath('userData'),
    rootDir,
    commit,
    mode,
    passive: devFlags.schedulerPassive,
    isolated: Boolean(devFlags.userDataDirOverride),
  });
  app.once('will-quit', cleanupDevInstance);
}

async function dispatch(): Promise<void> {
  const mod = await import('./bootstrap-electron.js');
  await mod.bootstrapElectron();
}

dispatch().catch((err) => {
  stderr.write(`[cindy] fatal: ${(err as Error).stack ?? err}\n`);
  exit(1);
});
