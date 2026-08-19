import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { app } from 'electron';
import matter from 'gray-matter';

import type { MekaRuntimeSkill } from './runtimeConfig.js';

const SNAPSHOT_SCHEMA_VERSION = 1;
const MAX_FILES = 4_096;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const SHA256_RE = /^[a-f0-9]{64}$/;
const SAFE_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/;

export interface MekaSkillSnapshotFile {
  relativePath: string;
  contentBase64: string;
  digest: string;
}

export interface MekaSkillSnapshot {
  revision: string;
  pluginPath: string;
  files: readonly MekaSkillSnapshotFile[];
}

export function hasMekaSkillSnapshotEntries(snapshot: MekaSkillSnapshot): boolean {
  return snapshot.files.some((file) => file.relativePath.startsWith('skills/'));
}

interface SnapshotCatalogEntry {
  packId: string;
  skillId: string;
  name: string;
  description: string;
  relPath: string;
}

interface SnapshotManifest {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  revision: string;
  files: Array<Pick<MekaSkillSnapshotFile, 'relativePath' | 'digest'> & { size: number }>;
}

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

function safeSkillDirectoryName(id: string): string {
  const normalized = id
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  return normalized || `skill-${sha256(id).slice(0, 12)}`;
}

function uniqueSkillDirectoryName(id: string, used: ReadonlySet<string>): string {
  const base = safeSkillDirectoryName(id);
  if (!used.has(base)) return base;
  const digest = sha256(id);
  for (let attempt = 0; ; attempt += 1) {
    const suffix = attempt === 0 ? digest.slice(0, 8) : `${digest.slice(0, 8)}-${attempt}`;
    const prefix = base.slice(0, 64 - suffix.length - 1).replace(/-+$/g, '') || 'skill';
    const candidate = `${prefix}-${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

function snapshotRoot(): string {
  return path.join(app.getPath('userData'), 'meka-skill-snapshots');
}

function bindingPath(sessionId: string): string {
  if (!SAFE_SESSION_ID_RE.test(sessionId))
    throw new Error('invalid Meka session id for Skill binding');
  return path.join(snapshotRoot(), 'bindings', `${sessionId}.json`);
}

function pluginPathForRevision(revision: string): string {
  if (!SHA256_RE.test(revision)) throw new Error('invalid Meka Skill snapshot revision');
  return path.join(snapshotRoot(), 'revisions', revision, 'claude-plugin');
}

function assertSafeRelativePath(relativePath: string): void {
  if (
    !relativePath ||
    relativePath.includes('\\') ||
    path.posix.isAbsolute(relativePath) ||
    relativePath.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error(`invalid Meka Skill snapshot path: ${relativePath}`);
  }
}

function rewriteSkillMetadata(content: string, name: string, description: string): string {
  const parsed = matter(content);
  return matter.stringify(parsed.content, {
    ...parsed.data,
    name,
    description,
  });
}

async function collectSkillFiles(skill: MekaRuntimeSkill): Promise<MekaSkillSnapshotFile[]> {
  const root = path.resolve(skill.sourceDirectory);
  const rootStats = await fs.lstat(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error(`Meka Skill source root must be a real directory: ${root}`);
  }
  const entryPath = path.resolve(skill.sourceEntryPath);
  const entryRelative = path.relative(root, entryPath);
  if (
    !entryRelative ||
    path.isAbsolute(entryRelative) ||
    entryRelative.startsWith(`..${path.sep}`) ||
    path.dirname(entryRelative) !== '.'
  ) {
    throw new Error(`Meka Skill entry must be a root file: ${entryPath}`);
  }
  const files: MekaSkillSnapshotFile[] = [];
  let totalBytes = 0;

  const walk = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute);
      if (!relative || path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`)) {
        throw new Error(`Meka Skill file escapes its source directory: ${absolute}`);
      }
      if (entry.isSymbolicLink()) {
        throw new Error(`Meka Skill snapshots do not follow symbolic links: ${absolute}`);
      }
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`Meka Skill snapshots only accept regular files: ${absolute}`);
      }
      if (entry.name === 'SKILL.md' && path.dirname(absolute) === root && absolute !== entryPath) {
        throw new Error(`Meka Skill source contains an ambiguous root SKILL.md: ${root}`);
      }
      const content =
        absolute === entryPath
          ? Buffer.from(rewriteSkillMetadata(skill.content, skill.name, skill.description), 'utf8')
          : await fs.readFile(absolute);
      totalBytes += content.byteLength;
      if (files.length + 1 > MAX_FILES || totalBytes > MAX_TOTAL_BYTES) {
        throw new Error(
          `Meka Skill snapshot exceeds the ${MAX_FILES} file / ${MAX_TOTAL_BYTES} byte limit`,
        );
      }
      files.push({
        relativePath: absolute === entryPath ? 'SKILL.md' : relative.split(path.sep).join('/'),
        contentBase64: content.toString('base64'),
        digest: sha256(content),
      });
    }
  };

  await walk(root);
  if (!files.some((file) => file.relativePath === 'SKILL.md')) {
    throw new Error(`Meka Skill source entry is missing: ${entryPath}`);
  }
  return files;
}

function validateManifest(value: unknown, revision: string): SnapshotManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid Meka Skill snapshot manifest');
  }
  const manifest = value as Partial<SnapshotManifest>;
  if (
    manifest.schemaVersion !== SNAPSHOT_SCHEMA_VERSION ||
    manifest.revision !== revision ||
    !Array.isArray(manifest.files)
  ) {
    throw new Error('incompatible Meka Skill snapshot manifest');
  }
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const candidate of manifest.files) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('invalid Meka Skill snapshot file entry');
    }
    const file = candidate as Partial<SnapshotManifest['files'][number]>;
    if (
      typeof file.relativePath !== 'string' ||
      typeof file.digest !== 'string' ||
      !SHA256_RE.test(file.digest) ||
      !Number.isSafeInteger(file.size) ||
      file.size! < 0
    ) {
      throw new Error('invalid Meka Skill snapshot file entry');
    }
    assertSafeRelativePath(file.relativePath);
    if (seen.has(file.relativePath)) throw new Error('duplicate Meka Skill snapshot path');
    seen.add(file.relativePath);
    totalBytes += file.size!;
  }
  if (manifest.files.length > MAX_FILES || totalBytes > MAX_TOTAL_BYTES) {
    throw new Error('Meka Skill snapshot manifest exceeds its safety limit');
  }
  const expectedRevision = sha256(
    [...manifest.files]
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
      .map((file) => `${file.relativePath}\0${file.digest}`)
      .join('\0'),
  );
  if (expectedRevision !== revision) throw new Error('Meka Skill snapshot revision mismatch');
  return manifest as SnapshotManifest;
}

async function readSnapshot(revision: string): Promise<MekaSkillSnapshot> {
  const pluginPath = pluginPathForRevision(revision);
  const raw = await fs.readFile(path.join(pluginPath, 'snapshot.json'), 'utf8');
  const manifest = validateManifest(JSON.parse(raw), revision);
  const actualPaths = new Set<string>();
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(pluginPath, absolute).split(path.sep).join('/');
      if (entry.isSymbolicLink()) {
        throw new Error(`Meka Skill snapshot contains a symbolic link: ${relative}`);
      }
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) actualPaths.add(relative);
      else throw new Error(`Meka Skill snapshot contains a non-file entry: ${relative}`);
    }
  };
  await walk(pluginPath);
  const expectedPaths = new Set([
    'snapshot.json',
    ...manifest.files.map((file) => file.relativePath),
  ]);
  if (
    actualPaths.size !== expectedPaths.size ||
    [...actualPaths].some((relativePath) => !expectedPaths.has(relativePath))
  ) {
    throw new Error('Meka Skill snapshot contains files outside its immutable manifest');
  }
  const files: MekaSkillSnapshotFile[] = [];
  for (const file of manifest.files) {
    const content = await fs.readFile(path.join(pluginPath, ...file.relativePath.split('/')));
    if (content.byteLength !== file.size || sha256(content) !== file.digest) {
      throw new Error(
        `Meka Skill snapshot file changed after materialization: ${file.relativePath}`,
      );
    }
    files.push({
      relativePath: file.relativePath,
      contentBase64: content.toString('base64'),
      digest: file.digest,
    });
  }
  return { revision, pluginPath, files };
}

async function writeSnapshot(
  revision: string,
  files: readonly MekaSkillSnapshotFile[],
): Promise<void> {
  const revisionsRoot = path.join(snapshotRoot(), 'revisions');
  const target = path.join(revisionsRoot, revision);
  try {
    await readSnapshot(revision);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await fs.mkdir(revisionsRoot, { recursive: true });
  const staging = await fs.mkdtemp(path.join(revisionsRoot, `.staging-${revision}-`));
  try {
    const pluginPath = path.join(staging, 'claude-plugin');
    for (const file of files) {
      assertSafeRelativePath(file.relativePath);
      const destination = path.resolve(pluginPath, ...file.relativePath.split('/'));
      const relative = path.relative(pluginPath, destination);
      if (!relative || path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`)) {
        throw new Error(`Meka Skill snapshot path escapes plugin root: ${file.relativePath}`);
      }
      const content = Buffer.from(file.contentBase64, 'base64');
      if (sha256(content) !== file.digest)
        throw new Error(`Meka Skill snapshot digest mismatch: ${file.relativePath}`);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, content);
    }
    const manifest: SnapshotManifest = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      revision,
      files: files.map((file) => ({
        relativePath: file.relativePath,
        digest: file.digest,
        size: Buffer.from(file.contentBase64, 'base64').byteLength,
      })),
    };
    await fs.writeFile(
      path.join(pluginPath, 'snapshot.json'),
      `${JSON.stringify(manifest)}\n`,
      'utf8',
    );
    try {
      await fs.rename(staging, target);
    } catch (error) {
      try {
        await readSnapshot(revision);
      } catch {
        throw error;
      }
    }
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

async function readBoundRevision(sessionId: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(bindingPath(sessionId), 'utf8')) as {
      schemaVersion?: unknown;
      sessionId?: unknown;
      revision?: unknown;
    };
    if (
      parsed.schemaVersion !== SNAPSHOT_SCHEMA_VERSION ||
      parsed.sessionId !== sessionId ||
      typeof parsed.revision !== 'string' ||
      !SHA256_RE.test(parsed.revision)
    ) {
      throw new Error('invalid Meka Skill session binding');
    }
    return parsed.revision;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Resolve an existing task binding or atomically freeze the task's first catalog. */
export async function materializeMekaSkillSnapshot(
  sessionId: string,
  skills: readonly MekaRuntimeSkill[],
): Promise<MekaSkillSnapshot | null> {
  const boundRevision = await readBoundRevision(sessionId);
  if (boundRevision) return await readSnapshot(boundRevision);

  const usedDirectories = new Set<string>();
  const files: MekaSkillSnapshotFile[] = [];
  const catalog: SnapshotCatalogEntry[] = [];
  let totalBytes = 0;
  for (const skill of [...skills].sort((left, right) => left.id.localeCompare(right.id))) {
    const directory = uniqueSkillDirectoryName(skill.id, usedDirectories);
    usedDirectories.add(directory);
    const description = skill.description.trim() || skill.name.trim() || directory;
    catalog.push({
      packId: 'meka-runtime',
      skillId: directory,
      name: directory,
      description,
      relPath: `skills/${directory}/SKILL.md`,
    });
    for (const file of await collectSkillFiles({
      ...skill,
      name: directory,
      description,
    })) {
      files.push({ ...file, relativePath: `skills/${directory}/${file.relativePath}` });
      totalBytes += Buffer.from(file.contentBase64, 'base64').byteLength;
      if (files.length > MAX_FILES || totalBytes > MAX_TOTAL_BYTES) {
        throw new Error(
          `Meka Skill snapshot exceeds the ${MAX_FILES} file / ${MAX_TOTAL_BYTES} byte limit`,
        );
      }
    }
  }
  const addTextFile = (relativePath: string, content: string): void => {
    const bytes = Buffer.from(content, 'utf8');
    files.push({ relativePath, contentBase64: bytes.toString('base64'), digest: sha256(bytes) });
    totalBytes += bytes.byteLength;
  };
  addTextFile(
    '.claude-plugin/plugin.json',
    `${JSON.stringify({ name: 'cindy-meka-role-skills', version: '1.0.0' }, null, 2)}\n`,
  );
  addTextFile('catalog.json', `${JSON.stringify(catalog)}\n`);
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  if (files.length > MAX_FILES || totalBytes > MAX_TOTAL_BYTES) {
    throw new Error(
      `Meka Skill snapshot exceeds the ${MAX_FILES} file / ${MAX_TOTAL_BYTES} byte limit`,
    );
  }
  const revision = sha256(files.map((file) => `${file.relativePath}\0${file.digest}`).join('\0'));
  await writeSnapshot(revision, files);

  const target = bindingPath(sessionId);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(
    temporary,
    `${JSON.stringify({ schemaVersion: 1, sessionId, revision })}\n`,
    'utf8',
  );
  try {
    try {
      // A hard link publishes the complete sidecar atomically and fails with
      // EEXIST when another concurrent first start already froze this task.
      await fs.link(temporary, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  } finally {
    await fs.rm(temporary, { force: true });
  }
  const winner = await readBoundRevision(sessionId);
  if (!winner) throw new Error('Meka Skill session binding was not published');
  return await readSnapshot(winner);
}
