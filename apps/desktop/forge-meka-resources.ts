import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ForgePlatform } from '@electron-forge/shared-types';

import { packagedResourcesPath } from './forge-third-party-notices';

type ResourceInventory = Map<string, string>;

function collectResourceInventory(root: string): ResourceInventory {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`[meka-resources] directory missing: ${root}`);
  }

  const result: ResourceInventory = new Map();
  const walk = (directory: string): void => {
    const entries = fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`[meka-resources] unsupported resource entry: ${absolute}`);
      }
      const relativePath = path.relative(root, absolute).split(path.sep).join('/');
      const digest = createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
      result.set(relativePath, digest);
    }
  };

  walk(root);
  if (result.size === 0) {
    throw new Error(`[meka-resources] resource tree is empty: ${root}`);
  }
  return result;
}

function summarize(paths: string[]): string {
  const limit = 10;
  const visible = paths.slice(0, limit).join(', ');
  return paths.length > limit ? `${visible}, ... (+${paths.length - limit})` : visible;
}

/**
 * Confirm the source carrier is a readable, non-empty file tree.
 *
 * Product-level project, role, and Skill semantics are validated by the runtime
 * and its integration tests, not by the packaging layer.
 */
export function assertMekaResourceTree(mekaRoot: string): void {
  collectResourceInventory(mekaRoot);
}

export function assertPackagedMekaResources(
  sourceMekaRoot: string,
  buildPath: string,
  platform: ForgePlatform,
): void {
  const source = collectResourceInventory(sourceMekaRoot);
  const packagedRoot = path.join(packagedResourcesPath(buildPath, platform), 'meka');
  const packaged = collectResourceInventory(packagedRoot);
  const missing = [...source.keys()].filter((filePath) => !packaged.has(filePath));
  const unexpected = [...packaged.keys()].filter((filePath) => !source.has(filePath));
  const changed = [...source.entries()]
    .filter(
      ([filePath, digest]) =>
        packaged.get(filePath) !== undefined && packaged.get(filePath) !== digest,
    )
    .map(([filePath]) => filePath);

  const differences = [
    ...(missing.length > 0 ? [`missing: ${summarize(missing)}`] : []),
    ...(unexpected.length > 0 ? [`unexpected: ${summarize(unexpected)}`] : []),
    ...(changed.length > 0 ? [`changed: ${summarize(changed)}`] : []),
  ];
  if (differences.length > 0) {
    throw new Error(
      `[meka-resources] packaged tree differs from source (${differences.join('; ')})`,
    );
  }
}
