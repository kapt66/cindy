/**
 * Host-owned session Skill root → explicit Pi `--skill` directories.
 *
 * `opts.nativeSkillPluginPath` is the host's immutable, revision-frozen Agent Skills
 * plugin for one task. Every harness consumes that one path in its own native form:
 * Claude loads the directory itself as a local plugin, Codex registers `<path>/skills`
 * as an extra native root. Pi's native carrier for an absolute Skill directory is the
 * explicit `--skill` flag — the exact shape Bot own-Skills already use — so this module
 * only translates one layout into the other. It adds no second loading mechanism, no
 * approval surface, and no Pi-side copy of the snapshot.
 *
 * Rules kept from the project-resource assembly:
 * - Only real directories that directly contain `SKILL.md` / `skill.md` are mounted:
 *   Pi loads a Skill from its own directory, never from a root of roots.
 * - Hidden entries are skipped, matching project Skill discovery.
 * - A remote session must never receive a local path — the harness runs on the other
 *   machine — so the caller passes `remoteHostId` and gets nothing back.
 * - Review stays hermetic: no host-injected Skill root.
 * - A read failure degrades to `unavailable` (no `--skill` arguments) instead of
 *   throwing. The snapshot is auxiliary to the session, and its content was already
 *   verified against its immutable revision by the host before it reached this opt.
 */

import fs from 'node:fs';
import path from 'node:path';

import { comparePiResourcePaths } from './project-resource-cli.js';

export type PiHostSkillMountStatus =
  /** No host-owned plugin path was passed for this session — nothing to mount. */
  | 'not-configured'
  /** Harness runs on another machine; a local snapshot path would be meaningless. */
  | 'remote-session'
  /** Review sessions stay hermetic (no project or host-injected resources). */
  | 'review-session'
  /** At least one mountable Skill directory was resolved. */
  | 'resolved'
  /** Configured, but nothing mountable (missing root, read failure, or no Skill). */
  | 'unavailable';

export interface PiHostSkillMount {
  /** Absolute Skill directories to pass as repeated `--skill <path>` arguments. */
  readonly skillDirs: readonly string[];
  readonly status: PiHostSkillMountStatus;
}

function emptyMount(status: PiHostSkillMountStatus): PiHostSkillMount {
  return Object.freeze({ skillDirs: Object.freeze([]) as readonly string[], status });
}

function hasSkillEntrypoint(skillDir: string): boolean {
  for (const name of ['SKILL.md', 'skill.md']) {
    try {
      if (fs.statSync(path.join(skillDir, name)).isFile()) return true;
    } catch {
      /* Missing/unreadable entrypoints are simply not mountable. */
    }
  }
  return false;
}

/**
 * Resolve the host-owned Skill root into per-Skill directories for Pi's CLI.
 *
 * Pure and synchronous: the caller spreads the result into spawn arguments, so the
 * outcome must be stable for one launch (a half-read directory would make two sessions
 * with the same inputs spawn different argument lists).
 */
export function resolvePiHostSkillMount(input: {
  pluginPath?: string | null;
  remoteHostId?: string | null;
  reviewMode?: boolean;
}): PiHostSkillMount {
  const pluginPath = typeof input.pluginPath === 'string' ? input.pluginPath.trim() : '';
  if (!pluginPath) return emptyMount('not-configured');
  if (input.remoteHostId) return emptyMount('remote-session');
  if (input.reviewMode) return emptyMount('review-session');

  try {
    const skillsRoot = path.join(pluginPath, 'skills');
    const skillDirs = fs
      .readdirSync(skillsRoot, { withFileTypes: true })
      // Symbolic links are skipped on purpose: `isDirectory()` is false for them, and
      // the host-owned snapshot never contains one.
      .filter((entry) => !entry.name.startsWith('.') && entry.isDirectory())
      .map((entry) => path.join(skillsRoot, entry.name))
      .filter((skillDir) => hasSkillEntrypoint(skillDir))
      .sort(comparePiResourcePaths);
    if (skillDirs.length === 0) return emptyMount('unavailable');
    return Object.freeze({
      skillDirs: Object.freeze(skillDirs) as readonly string[],
      status: 'resolved',
    });
  } catch {
    return emptyMount('unavailable');
  }
}
