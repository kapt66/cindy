import fs from 'node:fs';
import path from 'node:path';

import { app } from 'electron';

import { normalizeWorkingDirForStorage } from '../../shared/workingDir.js';

export function mekaWorkspaceDayKey(nowMs: number): string {
  const date = new Date(nowMs);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

export function mekaWorkspaceRootDir(): string {
  return path.join(app.getPath('userData'), 'meka-assistants');
}

export function buildMekaWorkspaceDir(sessionId: string, nowMs: number): string {
  return path.join(mekaWorkspaceRootDir(), mekaWorkspaceDayKey(nowMs), sessionId);
}

/** Resolve a project.path token into the actual session working directory. */
export async function resolveMekaProjectWorkspacePath(
  projectPath: string | null | undefined,
  deps: { readP4RootPath: () => Promise<string | null> },
): Promise<string | null> {
  const normalizedPath = typeof projectPath === 'string' ? projectPath.trim() : '';
  if (!normalizedPath) return null;
  if (normalizedPath === 'saga2') {
    const p4RootPath = normalizeWorkingDirForStorage(await deps.readP4RootPath());
    if (!p4RootPath) throw new Error('Meka P4 root path is not configured');
    return p4RootPath;
  }
  const resolved = normalizeWorkingDirForStorage(normalizedPath);
  if (!resolved || !path.isAbsolute(resolved)) {
    throw new Error('Meka custom project path must be absolute');
  }
  return resolved;
}

/** Create a Meka-owned workspace for historical/unscoped sessions only. */
export function ensureMekaWorkspaceDir(sessionId: string, nowMs: number): string {
  const directory = buildMekaWorkspaceDir(sessionId, nowMs);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}
