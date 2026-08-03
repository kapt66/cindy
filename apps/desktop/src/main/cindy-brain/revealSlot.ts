/**
 * revealSlot.ts — 在系统文件管理器中定位插件已知的本机文件。
 *
 * 插件只能提交路径字符串，不能直接拿 Electron shell 或宿主文件系统。
 * Host 重新解析 realpath、确认目标是现存普通文件或目录后才执行 reveal；返回值
 * 不包含路径，避免把主机路径变成新的沙箱数据出口。
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  GHOST_REVEAL_MIN_INTERVAL_MS,
  GHOST_REVEAL_PATH_MAX_CHARS,
  type GhostPipeRevealResult,
  type InstalledGhost,
} from '../../shared/ghost.js';

function isNativeAbsoluteLocalPath(value: string): boolean {
  if (process.platform === 'win32') {
    // Drive-qualified paths only. UNC, device namespaces, and root-relative
    // paths may refer to a remote or non-filesystem target and are rejected.
    return /^[A-Za-z]:[\\/]/.test(value) && !value.startsWith('\\\\?\\') && !value.startsWith('\\\\.\\');
  }
  return path.posix.isAbsolute(value) && !/^[A-Za-z]:[\\/]/.test(value) && !value.startsWith('\\\\');
}

export interface RevealSlotDeps {
  getGhost(id: string): InstalledGhost | null;
  showItemInFolder(filePath: string): void;
  now?(): number;
  log?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

function fail(
  errorCode: Extract<GhostPipeRevealResult, { ok: false }>['errorCode'],
  message: string,
): GhostPipeRevealResult {
  return { ok: false, errorCode, message };
}

/** reveal 槽:资格审 → 路径解析/文件类型校验 → 限速 → OS reveal。 */
export class GhostRevealSlot {
  private readonly lastAttemptAt = new Map<string, number>();

  constructor(private readonly deps: RevealSlotDeps) {}

  handleRequest(ghostId: string, payload: unknown): GhostPipeRevealResult {
    const ghost = this.deps.getGhost(ghostId);
    if (!ghost?.enabled || !ghost.manifest.slots.includes('reveal')) {
      return fail('PERMISSION_DENIED', '插件未申请文件定位权限(reveal 槽),或当前未启用');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return fail('INVALID_REQUEST', 'reveal-request 载荷必须是对象');
    }
    const request = payload as Record<string, unknown>;
    if (
      typeof request.path !== 'string' ||
      request.path.length === 0 ||
      request.path.length > GHOST_REVEAL_PATH_MAX_CHARS ||
      request.path.includes('\0') ||
      !isNativeAbsoluteLocalPath(request.path)
    ) {
      return fail('INVALID_REQUEST', 'path 必须是本机绝对路径且长度合法');
    }

    const now = this.deps.now?.() ?? Date.now();
    const last = this.lastAttemptAt.get(ghostId);
    this.lastAttemptAt.set(ghostId, now);
    if (last !== undefined && now - last < GHOST_REVEAL_MIN_INTERVAL_MS) {
      return fail('RATE_LIMITED', '文件定位请求太频繁,稍后再试');
    }

    let realPath: string;
    try {
      realPath = fs.realpathSync.native(request.path);
      const stat = fs.statSync(realPath);
      if (!stat.isFile() && !stat.isDirectory()) {
        return fail('NOT_FILE', '目标不是普通文件或文件夹');
      }
    } catch {
      return fail('NOT_FOUND', '目标文件不存在或当前不可访问');
    }

    try {
      this.deps.showItemInFolder(realPath);
    } catch (error) {
      this.deps.log?.warn('ghost reveal failed', {
        ghostId,
        error: error instanceof Error ? error.message : String(error),
      });
      return fail('INTERNAL', '系统文件管理器无法打开');
    }
    this.deps.log?.info('ghost reveal requested', { ghostId });
    return { ok: true };
  }
}
