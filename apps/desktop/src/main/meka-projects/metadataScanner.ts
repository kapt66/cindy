import { createHash } from 'node:crypto';
import path from 'node:path';

import { listAllFiles, readFile } from '@cindy/file-browser-core';
import { parseFrontmatter } from '../../../../../packages/maker-core/src/agents/shared/customization-scanner.js';
import type { MekaProjectMetadataItemType } from '../../shared/meka-projects.js';

export interface DiscoveredMekaProjectMetadata {
  itemType: MekaProjectMetadataItemType;
  sourcePath: string;
  subProjectPath: string | null;
  name: string;
  description?: string;
  contentFingerprint: string;
}

function metadataType(sourcePath: string): MekaProjectMetadataItemType | null {
  const name = path.posix.basename(sourcePath);
  if (name === 'AGENTS.md' || name === 'CLAUDE.md') return 'agents-md';
  if (name === 'SKILL.md') return 'skill';
  if (name === '.cursorrules' || name === 'rules.md') return 'rule';
  if (name === '.mcp.json' || name === 'mcp.json') return 'mcp';
  return null;
}

function canonicalPath(candidate: string): string | null {
  const slashed = candidate.replaceAll('\\', '/').replace(/^\.\/+/, '');
  const normalized = path.posix.normalize(slashed);
  if (
    !slashed
    || normalized !== slashed
    || path.posix.isAbsolute(slashed)
    || normalized === '..'
    || normalized.startsWith('../')
  ) return null;
  return normalized;
}

export function inferMekaSubProjectPath(
  sourcePath: string,
  files: readonly string[],
): string | null {
  const owners = files
    .filter((file) => path.posix.basename(file) === '.p4ignore')
    .map((file) => path.posix.dirname(file))
    .filter((dir) => dir !== '.')
    .sort((a, b) => b.length - a.length || a.localeCompare(b));
  const owner = owners.find((dir) => sourcePath === dir || sourcePath.startsWith(`${dir}/`));
  if (owner) return owner;
  if (!files.includes('.p4ignore') && owners.length === 0) return null;
  return sourcePath.includes('/') ? sourcePath.split('/')[0]! : null;
}

function fallbackName(sourcePath: string, type: MekaProjectMetadataItemType): string {
  if (type === 'skill') return path.posix.basename(path.posix.dirname(sourcePath)) || 'skill';
  if (type === 'mcp') return 'mcp';
  return path.posix.basename(sourcePath);
}

function describe(
  sourcePath: string,
  type: MekaProjectMetadataItemType,
  content: string,
): { name: string; description?: string } {
  if (type === 'skill') {
    const parsed = parseFrontmatter(content);
    const rawName = parsed.frontmatter?.name;
    return {
      name: typeof rawName === 'string' && rawName.trim()
        ? rawName.trim()
        : fallbackName(sourcePath, type),
      ...(parsed.description ? { description: parsed.description } : {}),
    };
  }
  if (type === 'mcp') {
    try {
      const parsed = JSON.parse(content) as { mcpServers?: Record<string, unknown>; servers?: Record<string, unknown> };
      const ids = Object.keys(parsed.mcpServers ?? parsed.servers ?? {}).sort();
      if (ids.length > 0) return { name: ids.length === 1 ? ids[0]! : `${ids[0]} +${ids.length - 1}` };
    } catch {
      // Invalid JSON is still surfaced as discovered metadata for the editor.
    }
  }
  return { name: fallbackName(sourcePath, type) };
}

export async function discoverLocalMekaProjectMetadata(
  projectRoot: string,
  rgPath: string,
): Promise<DiscoveredMekaProjectMetadata[]> {
  if (!path.isAbsolute(projectRoot)) throw new Error('project root must be absolute');
  const listed = await listAllFiles({ workdir: projectRoot, rgPath });
  const files = [...new Set(listed.files.map(canonicalPath).filter((item): item is string => Boolean(item)))]
    .sort((a, b) => a.localeCompare(b));
  const candidates = files
    .map((sourcePath) => ({ sourcePath, itemType: metadataType(sourcePath) }))
    .filter((item): item is { sourcePath: string; itemType: MekaProjectMetadataItemType } =>
      item.itemType !== null);
  const discovered = await Promise.all(candidates.map(async ({ sourcePath, itemType }) => {
    const content = (await readFile(projectRoot, sourcePath)).content;
    return {
      itemType,
      sourcePath,
      subProjectPath: inferMekaSubProjectPath(sourcePath, files),
      ...describe(sourcePath, itemType, content),
      contentFingerprint: createHash('sha256').update(content, 'utf8').digest('hex'),
    };
  }));
  return discovered;
}
