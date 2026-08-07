import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface LocalSessionDirectorySnapshot {
  workingDir: string | null;
  remoteHostId: string | null;
}

const SAFE_RELATIVE_DIRECTORY = /^[^\\/\0]{1,128}$/;

/** Resolve one direct child of a Host-owned local task directory without exposing arbitrary paths to a plugin. */
export async function resolveLocalServerProjectDirectory(
  sessionId: string,
  relativeDirectory: string,
  getSession: (sessionId: string) => Promise<LocalSessionDirectorySnapshot | null>,
): Promise<string | null> {
  if (!/^[-A-Za-z0-9._]{1,128}$/.test(sessionId) || !SAFE_RELATIVE_DIRECTORY.test(relativeDirectory) ||
    relativeDirectory === '.' || relativeDirectory === '..') return null;
  const snapshot = await getSession(sessionId);
  if (!snapshot?.workingDir || snapshot.remoteHostId || !path.isAbsolute(snapshot.workingDir)) return null;
  try {
    const root = await fs.realpath(snapshot.workingDir);
    const candidate = await fs.realpath(path.join(root, relativeDirectory));
    if (path.dirname(candidate) !== root) return null;
    const stat = await fs.stat(candidate);
    if (!stat.isDirectory() || (await fs.readdir(candidate)).length === 0) return null;
    return candidate;
  } catch {
    return null;
  }
}
