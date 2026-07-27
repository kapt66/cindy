import { createHash } from 'node:crypto';

import type { BundleFile } from '@cindy/maker-cc-manager';

import type { MekaRuntimeSkill } from '../meka-projects/runtimeConfig.js';

export interface MekaRemoteCodexBundle {
  revisionHash: string;
  files: readonly BundleFile[];
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function stableSkillId(id: string): string {
  const normalized = id.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || `skill-${sha256(id).slice(0, 12)}`;
}

/**
 * Freeze Cindy Meka's already-resolved role skills into the catalog layout
 * consumed by the MCPRouter daemon capability service.
 */
export function buildMekaRemoteCodexBundle(
  skills: readonly MekaRuntimeSkill[],
): MekaRemoteCodexBundle {
  const ordered = [...skills].sort((left, right) => left.id.localeCompare(right.id));
  const usedIds = new Set<string>();
  const catalog: Array<{
    packId: string;
    skillId: string;
    name: string;
    description: string;
    relPath: string;
  }> = [];
  const skillFiles: BundleFile[] = [];

  for (const skill of ordered) {
    const baseId = stableSkillId(skill.id);
    let skillId = baseId;
    if (usedIds.has(skillId)) {
      skillId = `${baseId}-${sha256(skill.id).slice(0, 8)}`;
    }
    usedIds.add(skillId);
    const relPath = `meka-runtime/skills/${skillId}/SKILL.md`;
    catalog.push({
      packId: 'meka-runtime',
      skillId,
      name: skill.name || skill.id,
      description: skill.description || skill.name || skill.id,
      relPath,
    });
    skillFiles.push({
      relPath,
      content: skill.content,
      digest: sha256(skill.content),
    });
  }

  const catalogContent = JSON.stringify(catalog);
  const files: BundleFile[] = [
    {
      relPath: 'catalog.json',
      content: catalogContent,
      digest: sha256(catalogContent),
    },
    ...skillFiles,
  ];
  const revisionHash = sha256(
    files.map((file) => `${file.relPath}\0${file.digest}`).join('\0'),
  );
  return { revisionHash, files };
}
