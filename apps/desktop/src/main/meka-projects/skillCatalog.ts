import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { MekaSkillCatalogEntry } from '../../shared/meka-projects.js';
import { bundledMekaSkillsRoot } from './resourcePaths.js';

function frontmatterValue(content: string, field: string): string | undefined {
  const frontmatter = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1];
  if (!frontmatter) return undefined;
  const match = new RegExp(`^${field}:\\s*(.+?)\\s*$`, 'm').exec(frontmatter);
  const value = match?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2');
  return value || undefined;
}

async function childDirectories(root: string): Promise<string[]> {
  return (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, 'zh-CN'));
}

export async function listMekaSkillCatalog(
  root = bundledMekaSkillsRoot(),
): Promise<MekaSkillCatalogEntry[]> {
  const result: MekaSkillCatalogEntry[] = [];
  let categories: string[];
  try {
    categories = await childDirectories(root);
  } catch {
    return result;
  }
  for (const category of categories) {
    for (const subCategory of await childDirectories(path.join(root, category))) {
      for (const skillId of await childDirectories(path.join(root, category, subCategory))) {
        const skillFile = path.join(root, category, subCategory, skillId, 'SKILL.md');
        let content: string;
        try {
          content = await readFile(skillFile, 'utf8');
        } catch {
          continue;
        }
        const description = frontmatterValue(content, 'description') ?? skillId;
        result.push({
          skillId,
          category,
          subCategory,
          description,
          ...(frontmatterValue(content, 'purpose')
            ? { purpose: frontmatterValue(content, 'purpose') }
            : {}),
          filePath: path.posix.join(category, subCategory, skillId, 'SKILL.md'),
        });
      }
    }
  }
  return result.sort(
    (left, right) =>
      left.category.localeCompare(right.category, 'zh-CN') ||
      left.subCategory.localeCompare(right.subCategory, 'zh-CN') ||
      left.skillId.localeCompare(right.skillId),
  );
}
