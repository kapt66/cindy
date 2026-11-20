import fs from 'node:fs';
import path from 'node:path';

/**
 * Meka 随包默认插件清单（meka/main 专属，2026-11-20 裁决）。
 *
 * 上游 Cindy 由服务端目录的 `defaultInstall` 决定默认插件；Meka 渠道不接服务端默认下发
 * （`registerIpc.ts` 的 Meka service 本来就是 `applyDefaultInstalls:false`）。这里改为
 * **随包清单**：安装包里带 `resources/meka/default-plugins.json`，启动后由 Meka 市场按
 * 清单补齐/更新插件；不新增服务端接口，也不需要服务端下发。
 *
 * 约束：
 * - 清单只列插件 id（可选展示名），不列包字节、不列 URL；包仍从 Meka 插件市场下载并校验。
 * - 清单是受信任的安装包内容；用户显式卸载写下的 opt-out 仍然优先，卸载后不会再被装回。
 * - 清单更新只随客户端发版；移除条目不会自动卸载已装插件（避免客户端回退时误删用户环境）。
 * - 损坏 / 超限 / 非法 id 时 fail-closed：整份清单不生效（返回空列表），只记 warn，不阻塞启动。
 */

export const MEKA_DEFAULT_PLUGINS_SCHEMA_VERSION = 1;
export const MEKA_DEFAULT_PLUGINS_MAX_COUNT = 32;
export const MEKA_DEFAULT_PLUGINS_MAX_BYTES = 64 * 1024;

/** 与共享 Ghost id 规则同形：小写字母/数字/连字符，字母或数字开头，≤64。 */
const MEKA_DEFAULT_PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface MekaDefaultPluginEntry {
  ghostId: string;
  name?: string;
}

export interface MekaDefaultPluginsManifest {
  schemaVersion: number;
  plugins: MekaDefaultPluginEntry[];
}

export interface ResolveMekaDefaultPluginsPathInput {
  isPackaged: boolean;
  appPath: string;
  resourcesPath: string;
}

/** 清单路径：打包读取 resources/meka；dev 读取仓库 apps/desktop/resources/meka。 */
export function resolveMekaDefaultPluginsPath(input: ResolveMekaDefaultPluginsPathInput): string {
  return input.isPackaged
    ? path.join(input.resourcesPath, 'meka', 'default-plugins.json')
    : path.join(input.appPath, 'resources', 'meka', 'default-plugins.json');
}

/**
 * 解析并校验清单。返回值只保留合法、去重后的 id；任何结构性错误都让整份清单失效
 * （fail-closed），避免“只装了一半”造成环境不一致。
 */
export function parseMekaDefaultPluginsManifest(
  raw: unknown,
): { ok: true; ghostIds: string[]; entries: MekaDefaultPluginEntry[] } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'manifest must be an object' };
  }
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== MEKA_DEFAULT_PLUGINS_SCHEMA_VERSION) {
    return { ok: false, reason: 'unsupported schemaVersion' };
  }
  if (!Array.isArray(record.plugins)) return { ok: false, reason: 'plugins must be an array' };
  if (record.plugins.length === 0) return { ok: false, reason: 'plugins must not be empty' };
  if (record.plugins.length > MEKA_DEFAULT_PLUGINS_MAX_COUNT) {
    return { ok: false, reason: 'too many plugins' };
  }
  const seen = new Set<string>();
  const entries: MekaDefaultPluginEntry[] = [];
  for (const [index, item] of record.plugins.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, reason: `plugins[${index}] must be an object` };
    }
    const plugin = item as Record<string, unknown>;
    const ghostId = typeof plugin.ghostId === 'string' ? plugin.ghostId.trim() : '';
    if (!MEKA_DEFAULT_PLUGIN_ID_PATTERN.test(ghostId)) {
      return { ok: false, reason: `plugins[${index}].ghostId is invalid` };
    }
    if (seen.has(ghostId)) return { ok: false, reason: `duplicate plugin ghostId: ${ghostId}` };
    seen.add(ghostId);
    const name = typeof plugin.name === 'string' ? plugin.name.trim() : '';
    if (name.length > 120) return { ok: false, reason: `plugins[${index}].name is too long` };
    entries.push(name ? { ghostId, name } : { ghostId });
  }
  return { ok: true, ghostIds: entries.map((entry) => entry.ghostId), entries };
}

export type ReadMekaDefaultPluginsResult =
  | { ok: true; ghostIds: string[]; entries: MekaDefaultPluginEntry[] }
  | { ok: false; reason: 'missing' | 'unreadable' | 'invalid'; detail: string };

/** 读取清单文件；文件不存在视为“没有默认清单”（正常，尤其旧安装/裁剪包），不报错。 */
export function readMekaDefaultPlugins(filePath: string): ReadMekaDefaultPluginsResult {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    // 只有 ENOENT 才是“没有清单”；EACCES/EIO/ELOOP 等必须留下可诊断原因。
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ok: false, reason: 'missing', detail: filePath };
    return {
      ok: false,
      reason: 'unreadable',
      detail: code || (error instanceof Error ? error.message : String(error)),
    };
  }
  if (!stat.isFile()) return { ok: false, reason: 'unreadable', detail: 'not a regular file' };
  if (stat.size > MEKA_DEFAULT_PLUGINS_MAX_BYTES) {
    return { ok: false, reason: 'invalid', detail: 'manifest exceeds size limit' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return {
      ok: false,
      reason: 'invalid',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  const validated = parseMekaDefaultPluginsManifest(parsed);
  if (!validated.ok) return { ok: false, reason: 'invalid', detail: validated.reason };
  return { ok: true, ghostIds: validated.ghostIds, entries: validated.entries };
}
