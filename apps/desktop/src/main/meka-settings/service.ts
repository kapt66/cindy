import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  MEKA_P4_SUBFOLDERS,
  type MekaP4Settings,
  type MekaP4Subfolder,
} from '../../shared/meka-settings.js';

type JsonRecord = Record<string, unknown>;

export interface MekaP4SettingsServiceDeps {
  configPath: string;
  readFile?: (filePath: string) => Promise<string | null>;
  writeFile?: (filePath: string, content: string) => Promise<void>;
  mkdir?: (directoryPath: string) => Promise<void>;
  rename?: (from: string, to: string) => Promise<void>;
  unlink?: (filePath: string) => Promise<void>;
  statDirectory?: (directoryPath: string) => Promise<boolean>;
  readdir?: (directoryPath: string) => Promise<string[]>;
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeRootPath(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function normalizeSubfolders(value: unknown): MekaP4Subfolder[] {
  if (!isRecord(value)) return [];
  return MEKA_P4_SUBFOLDERS.filter(({ name }) =>
    Object.prototype.hasOwnProperty.call(value, name),
  ).map(({ name }) => ({ name }));
}

async function defaultReadFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function createMekaP4SettingsService(deps: MekaP4SettingsServiceDeps) {
  const readFile = deps.readFile ?? defaultReadFile;
  const writeFile =
    deps.writeFile ?? ((filePath, content) => fs.writeFile(filePath, content, 'utf8'));
  const mkdir =
    deps.mkdir ??
    ((directoryPath) => fs.mkdir(directoryPath, { recursive: true }).then(() => undefined));
  const rename = deps.rename ?? ((from, to) => fs.rename(from, to));
  const unlink =
    deps.unlink ??
    (async (filePath) => {
      try {
        await fs.unlink(filePath);
      } catch {
        // Best-effort cleanup of a failed atomic-write temp file.
      }
    });
  const statDirectory =
    deps.statDirectory ??
    (async (directoryPath) => {
      try {
        return (await fs.stat(directoryPath)).isDirectory();
      } catch {
        return false;
      }
    });
  const readdir = deps.readdir ?? ((directoryPath) => fs.readdir(directoryPath));
  let tempSequence = 0;

  async function loadRaw(): Promise<JsonRecord> {
    const content = await readFile(deps.configPath);
    if (!content) return {};
    const parsed: unknown = JSON.parse(content);
    return isRecord(parsed) ? parsed : {};
  }

  function toView(raw: JsonRecord): MekaP4Settings {
    const p4RootPath = normalizeRootPath(raw.p4RootPath);
    const subfolders = normalizeSubfolders(raw.subfolders);
    return {
      p4RootPath,
      subfolders,
      extraDirs: p4RootPath ? subfolders.map(({ name }) => path.join(p4RootPath, name)) : [],
      readOnlyBecauseFutureSchema: typeof raw.schemaVersion === 'number' && raw.schemaVersion > 1,
    };
  }

  async function get(): Promise<MekaP4Settings> {
    const raw = await loadRaw();
    const view = toView(raw);
    if (!view.p4RootPath) return view;
    try {
      const entries = new Set(await readdir(view.p4RootPath));
      const matched = new Set(view.subfolders.map(({ name }) => name));
      for (const { name } of MEKA_P4_SUBFOLDERS) {
        if (entries.has(name)) matched.add(name);
      }
      const subfolders = MEKA_P4_SUBFOLDERS.filter(({ name }) => matched.has(name)).map(
        ({ name }) => ({ name }),
      );
      return {
        ...view,
        subfolders,
        extraDirs: subfolders.map(({ name }) => path.join(view.p4RootPath!, name)),
      };
    } catch {
      // Keep the persisted compatibility snapshot when the P4 root is temporarily unavailable.
      return view;
    }
  }

  async function setP4RootPath(directoryPath: string): Promise<MekaP4Settings> {
    const normalizedPath = directoryPath.trim();
    if (!path.isAbsolute(normalizedPath) || !(await statDirectory(normalizedPath))) {
      throw new Error('P4 root must be an existing absolute directory');
    }

    const raw = await loadRaw();
    if (typeof raw.schemaVersion === 'number' && raw.schemaVersion > 1) {
      throw new Error(
        `Meka settings schemaVersion ${raw.schemaVersion} is newer than this app and is read-only`,
      );
    }

    const entries = new Set(await readdir(normalizedPath));
    const matched = MEKA_P4_SUBFOLDERS.filter(({ name }) => entries.has(name));
    const next: JsonRecord = {
      ...raw,
      schemaVersion: typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 1,
      p4RootPath: normalizedPath,
      // Keep the original Meka file shape. Values are compatibility placeholders;
      // current behavior treats every matched folder as available.
      subfolders: Object.fromEntries(matched.map(({ name }) => [name, true])),
    };

    await mkdir(path.dirname(deps.configPath));
    const tempPath = `${deps.configPath}.tmp-${process.pid}-${++tempSequence}`;
    await writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`);
    try {
      await rename(tempPath, deps.configPath);
    } catch (error) {
      await unlink(tempPath);
      throw error;
    }
    return toView(next);
  }

  return { get, setP4RootPath };
}

export type MekaP4SettingsService = ReturnType<typeof createMekaP4SettingsService>;
