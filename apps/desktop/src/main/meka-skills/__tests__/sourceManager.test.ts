import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';

import { pack } from '../../skillhub/zipPacker';
import { applyMekaSkillReleaseVersion, inspectMekaSkillSource } from '../sourceManager';

const roots: string[] = [];

function source(name: string, frontmatter: string): string {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'meka-skill-source-'));
  roots.push(parent);
  const root = path.join(parent, name);
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'SKILL.md'), `---\n${frontmatter}\n---\n\n# Test\n`);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('inspectMekaSkillSource', () => {
  it('accepts an upstream-compatible root SKILL.md without a content version', async () => {
    const root = source('release-notes', 'name: release-notes\ndescription: Prepare release notes');
    fs.writeFileSync(path.join(root, 'reference.md'), 'Reference');

    await expect(inspectMekaSkillSource(root)).resolves.toMatchObject({
      folderHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      preview: {
        name: 'release-notes',
        description: 'Prepare release notes',
        fileCount: 2,
      },
    });
  });

  it('rejects a source whose directory identity differs from SKILL.md', async () => {
    const root = source('wrong-folder', 'name: expected-name\ndescription: Prepare release notes');

    await expect(inspectMekaSkillSource(root)).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
  });

  it('treats an existing frontmatter version as non-authoritative source metadata', async () => {
    const root = source(
      'release-notes',
      'name: release-notes\ndescription: Prepare release notes\nversion: latest',
    );

    await expect(inspectMekaSkillSource(root)).resolves.toMatchObject({
      preview: { name: 'release-notes' },
    });
  });

  it('injects the selected release version into package bytes without changing SKILL.md', async () => {
    const root = source('release-notes', 'name: release-notes\ndescription: Prepare release notes');
    const before = fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8');
    const packaged = await pack(root);
    const releaseBytes = await applyMekaSkillReleaseVersion(packaged.buffer, '1.2.4');
    const zip = await JSZip.loadAsync(releaseBytes);
    const releasedManifest = matter(await zip.file('SKILL.md')!.async('string'));

    expect(releasedManifest.data).toMatchObject({
      name: 'release-notes',
      version: '1.2.4',
    });
    expect(fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8')).toBe(before);
  });

  it('returns the exact reviewed package snapshot even if the source changes later', async () => {
    const root = source('release-notes', 'name: release-notes\ndescription: Prepare release notes');
    fs.writeFileSync(path.join(root, 'reference.md'), 'Reviewed content');

    const inspected = await inspectMekaSkillSource(root);
    fs.writeFileSync(path.join(root, 'reference.md'), 'Changed after review');
    const zip = await JSZip.loadAsync(inspected.packageBytes);

    await expect(zip.file('reference.md')!.async('string')).resolves.toBe('Reviewed content');
  });

  it('rejects a source with more than 1000 packaged files', async () => {
    const root = source('release-notes', 'name: release-notes\ndescription: Prepare release notes');
    for (let index = 0; index < 1000; index += 1) {
      fs.writeFileSync(path.join(root, `reference-${index}.txt`), 'x');
    }

    await expect(inspectMekaSkillSource(root)).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
  });
});
