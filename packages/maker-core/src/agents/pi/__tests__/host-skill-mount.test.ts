import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolvePiHostSkillMount } from '../host-skill-mount.js';

/**
 * Host-owned Skill root (`opts.nativeSkillPluginPath`) → Pi `--skill` directories.
 *
 * Claude, Codex and Pi consume the same opt in their own native form. If Pi cannot
 * consume it, a task's role Skills silently disappear from Pi tasks — so the layout
 * translation, ordering, skip rules and the sessions that must NOT get local paths are
 * pinned here instead of living in a comment.
 */
describe('resolvePiHostSkillMount', () => {
  let root = '';

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  function makePlugin(skills: Record<string, string | null>): string {
    root = mkdtempSync(path.join(tmpdir(), 'pi-host-skill-'));
    const pluginPath = path.join(root, 'revisions', 'a'.repeat(64), 'claude-plugin');
    mkdirSync(path.join(pluginPath, 'skills'), { recursive: true });
    // The snapshot also carries a manifest, a catalog and a plugin descriptor. They are
    // not Skill directories and must be ignored.
    writeFileSync(path.join(pluginPath, 'snapshot.json'), '{}\n');
    writeFileSync(path.join(pluginPath, 'catalog.json'), '[]\n');
    mkdirSync(path.join(pluginPath, '.claude-plugin'), { recursive: true });
    writeFileSync(
      path.join(pluginPath, '.claude-plugin', 'plugin.json'),
      '{"name":"host-role-skills","version":"1.0.0"}\n',
    );
    for (const [name, entrypoint] of Object.entries(skills)) {
      const skillDir = path.join(pluginPath, 'skills', name);
      mkdirSync(skillDir, { recursive: true });
      if (entrypoint) writeFileSync(path.join(skillDir, entrypoint), `# ${name}\n`);
    }
    return pluginPath;
  }

  it('resolves every skills/<id> directory as a --skill path, sorted', () => {
    const pluginPath = makePlugin({
      'combat-skill-configuration': 'SKILL.md',
      'general-development': 'SKILL.md',
    });

    const mount = resolvePiHostSkillMount({ pluginPath });

    expect(mount.status).toBe('resolved');
    expect(mount.skillDirs).toEqual([
      path.join(pluginPath, 'skills', 'combat-skill-configuration'),
      path.join(pluginPath, 'skills', 'general-development'),
    ]);
    expect(Object.isFrozen(mount)).toBe(true);
    expect(Object.isFrozen(mount.skillDirs)).toBe(true);
  });

  it('accepts a lowercase skill.md and skips hidden or entrypoint-less directories', () => {
    const pluginPath = makePlugin({
      'lower-case': 'skill.md',
      'no-entrypoint': null,
      '.hidden': 'SKILL.md',
    });

    const mount = resolvePiHostSkillMount({ pluginPath });

    expect(mount.skillDirs).toEqual([path.join(pluginPath, 'skills', 'lower-case')]);
    expect(mount.status).toBe('resolved');
  });

  it('mounts nothing when no host Skill root was passed (ordinary tasks unchanged)', () => {
    expect(resolvePiHostSkillMount({})).toEqual({ skillDirs: [], status: 'not-configured' });
    expect(resolvePiHostSkillMount({ pluginPath: '   ' }).status).toBe('not-configured');
  });

  it('never hands a local snapshot path to a remote session', () => {
    const pluginPath = makePlugin({ 'combat-skill-configuration': 'SKILL.md' });

    expect(resolvePiHostSkillMount({ pluginPath, remoteHostId: 'ssh-host' }).status).toBe(
      'remote-session',
    );
    expect(
      resolvePiHostSkillMount({ pluginPath, remoteHostId: 'mcpr:instance-1' }).skillDirs,
    ).toEqual([]);
  });

  it('keeps review sessions hermetic', () => {
    const pluginPath = makePlugin({ 'combat-skill-configuration': 'SKILL.md' });

    expect(resolvePiHostSkillMount({ pluginPath, reviewMode: true })).toEqual({
      skillDirs: [],
      status: 'review-session',
    });
  });

  it('degrades to unavailable instead of throwing when the root is unusable', () => {
    // Missing root: readdir throws ENOENT.
    expect(
      resolvePiHostSkillMount({ pluginPath: path.join(tmpdir(), 'pi-host-skill-missing') }),
    ).toEqual({ skillDirs: [], status: 'unavailable' });

    const emptyPlugin = makePlugin({});
    expect(resolvePiHostSkillMount({ pluginPath: emptyPlugin })).toEqual({
      skillDirs: [],
      status: 'unavailable',
    });

    // `skills` is a file rather than a directory: same degradation, no throw.
    const notADirectory = mkdtempSync(path.join(tmpdir(), 'pi-host-skill-file-'));
    writeFileSync(path.join(notADirectory, 'skills'), 'not a directory\n');
    expect(resolvePiHostSkillMount({ pluginPath: notADirectory })).toEqual({
      skillDirs: [],
      status: 'unavailable',
    });
    rmSync(notADirectory, { recursive: true, force: true });
  });

  it('is stable across repeated resolutions so spawn argv cannot drift', () => {
    const pluginPath = makePlugin({
      b: 'SKILL.md',
      a: 'SKILL.md',
      c: 'SKILL.md',
    });

    const first = resolvePiHostSkillMount({ pluginPath });
    const second = resolvePiHostSkillMount({ pluginPath });

    expect(first.skillDirs).toEqual(second.skillDirs);
    expect(first.skillDirs.map((dir) => path.basename(dir))).toEqual(['a', 'b', 'c']);
  });
});
