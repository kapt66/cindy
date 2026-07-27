import { describe, expect, it } from 'vitest';

import { buildMekaRemoteCodexBundle } from '../meka-remote-codex-bundle';

describe('buildMekaRemoteCodexBundle', () => {
  it('creates a deterministic catalog and skill file set', () => {
    const skills = [
      {
        id: 'zeta',
        name: 'Zeta',
        description: 'Second',
        content: '# Zeta',
      },
      {
        id: 'alpha',
        name: 'Alpha',
        description: 'First',
        content: '# Alpha',
      },
    ];
    const first = buildMekaRemoteCodexBundle(skills);
    const second = buildMekaRemoteCodexBundle([...skills].reverse());

    expect(second).toEqual(first);
    expect(first.revisionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.files.map((file) => file.relPath)).toEqual([
      'catalog.json',
      'meka-runtime/skills/alpha/SKILL.md',
      'meka-runtime/skills/zeta/SKILL.md',
    ]);
    expect(JSON.parse(first.files[0]!.content)).toEqual([
      expect.objectContaining({
        packId: 'meka-runtime',
        skillId: 'alpha',
        relPath: 'meka-runtime/skills/alpha/SKILL.md',
      }),
      expect.objectContaining({
        packId: 'meka-runtime',
        skillId: 'zeta',
        relPath: 'meka-runtime/skills/zeta/SKILL.md',
      }),
    ]);
  });

  it('changes the revision when skill content changes', () => {
    const original = buildMekaRemoteCodexBundle([
      { id: 'skill', name: 'Skill', description: '', content: 'one' },
    ]);
    const changed = buildMekaRemoteCodexBundle([
      { id: 'skill', name: 'Skill', description: '', content: 'two' },
    ]);
    expect(changed.revisionHash).not.toBe(original.revisionHash);
  });
});
