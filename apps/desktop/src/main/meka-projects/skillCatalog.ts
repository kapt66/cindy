import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { parseFrontmatter } from '../../../../../packages/maker-core/src/agents/shared/customization-scanner.js';
import type { MekaSkillCatalogEntry } from '../../shared/meka-projects.js';
import { bundledMekaSkillsRoot } from './resourcePaths.js';

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
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
        const parsed = parseFrontmatter(content);
        const metadata =
          parsed.frontmatter?.metadata && typeof parsed.frontmatter.metadata === 'object'
            ? (parsed.frontmatter.metadata as Record<string, unknown>)
            : undefined;
        const description = parsed.description ?? skillId;
        const displayName = stringValue(metadata?.['display-name']);
        const purpose = stringValue(metadata?.purpose);
        result.push({
          skillId,
          ...(displayName ? { displayName } : {}),
          category,
          subCategory,
          description,
          ...(purpose ? { purpose } : {}),
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
