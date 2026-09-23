import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { app } from 'electron';
import matter from 'gray-matter';

import type {
  MekaProjectDefaultMetadataSelection,
  MekaProjectFile,
  MekaProjectMetadataSelection,
  MekaProjectReference,
  MekaProjectRoleDefaults,
  MekaRoleFile,
  MekaRoleManifestFile,
  MekaRoleMcpEntry,
  MekaRoleRule,
  MekaRoleSkillEntry,
  MekaRoleSkillSelection,
  MekaRoleWorkflow,
} from '../../shared/meka-projects.js';
import { mekaDefaultRoleId, mekaDefaultRoleManifest } from '../../shared/meka-projects.js';
import { getDbClient } from '../localDb/client/current.js';
import { createLogger } from '../logger.js';
import { getMekaP4SettingsService } from '../meka-settings/ipc.js';
import {
  SECRET_REFERENCE_RE,
  readBuiltinRoleManifest,
  readCustomRoleManifest,
  readEffectiveProjectConfig,
} from './projectConfig.js';
import { bundledMekaRolesRoot, bundledMekaSkillsRoot } from './resourcePaths.js';

const log = createLogger('meka-projects:runtime-config');
const SAFE_SKILL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_DISCOVERED_SKILL_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KNOWN_POLICY_PROVIDER_REFS = new Set(['meka-host-risk-policy', 'meka-p4-boundary-policy']);
const MEKA_PLATFORM_SKILL_IDS = ['platform-capabilities'] as const;
/** 参考条目描述的上限：有界且确定性，system 前缀才不会随项目内容漂移。 */
const PROJECT_REFERENCE_DESCRIPTION_MAX = 300;

interface ProjectRow {
  id: string;
  path: string | null;
  is_builtin: number;
}

interface RoleRow {
  id: string;
  project_id: string;
  is_builtin: number;
  file_path: string;
}

export interface MekaRuntimeSkill {
  id: string;
  name: string;
  description: string;
  content: string;
  sourceDirectory: string;
  sourceEntryPath: string;
  /**
   * 这个 skill **只由全量开关派生**（`includeAllBundledSkills` 铺进来的内置 catalog 技能，或
   * `includeAllProjectMetadata` 全量展开出来的项目 `SKILL.md`），不是作者显式选择。
   *
   * 用途只有一处：`materializeMekaSkillSnapshot` 收集文件失败时，派生 skill 按「warn + 跳过该
   * skill」处理（一个坏目录不得把该项目所有新建会话顶成 `INVALID_PARAMS`），而作者显式选择的
   * skill 仍然原样抛出（fail-closed 不放宽）。字段缺省 = 作者显式选择。
   *
   * 它**不参与**技能 id / 内容 / 去重 / 顺序的任何口径：只影响「收集失败时跳过还是抛错」。
   */
  derivedOnly?: boolean;
}

export interface MekaRuntimeConfig {
  projectId: string;
  roleId: string;
  roleDisplayName: string;
  workflowRecoveredFromRole: boolean;
  promptText: string;
  skills: MekaRuntimeSkill[];
  mcp: MekaRoleMcpEntry[];
  policyProviderRefs: string[];
  workflow?: MekaRoleWorkflow;
  /** 项目参考文件（渐进披露：只给地址 + 描述，正文由 Agent 按需读取）。 */
  projectReferences: readonly MekaProjectReference[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function metadataKey(
  selection: Pick<MekaProjectDefaultMetadataSelection, 'rootPath' | 'sourcePath' | 'itemType'>,
): string {
  return `${selection.rootPath ?? ''}\0${selection.sourcePath}\0${selection.itemType}`;
}

function isLegacySkill(
  value: MekaRoleSkillSelection | MekaRoleSkillEntry,
): value is MekaRoleSkillEntry {
  return 'path' in value;
}

/**
 * Keep editable SAGA2 project snapshots compatible when a bundled skill is
 * renamed. The project file remains the user's source of truth; migration is
 * deliberately in-memory so an upgrade never rewrites P4-owned data.
 */
function migrateSAGA2CombatSkillSelection(
  value: MekaRoleSkillSelection | MekaRoleSkillEntry,
): MekaRoleSkillSelection | MekaRoleSkillEntry {
  if (isLegacySkill(value)) return value;
  return value.skillId === 'skill-entry-model' ? { ...value, skillId: 'saga2-entry-model' } : value;
}

function migrateSAGA2CombatRoleSkills(
  role: MekaRoleFile,
  projectId: string,
  roleId: string,
  bundled: MekaRoleFile,
): MekaRoleFile {
  // Only the combat role still owns a pre-rename built-in snapshot. Its old
  // project file may pin the retired skill id, so it must receive the in-memory
  // snapshot migration before skill loading; otherwise an old project file fails
  // on the retired skill id first. The shared default role replaced
  // `general-development`, but it has no bundled manifest file and its manifest
  // is generated in memory (never persisted), so there is no legacy snapshot to
  // migrate and it must never be rewritten from a bundled role here.
  if (projectId !== 'saga2' || roleId !== 'combat-development') return role;
  const legacyAuxiliarySkillIds = new Set([
    'saga2-overview',
    'safety-boundaries',
    'p4-operations',
    'orca-coordination',
    'remote-operations',
    'saga2-server-reference',
    'saga2-entry-model',
    'skill-entry-model',
  ]);
  const hasRenamedSkill = role.skills.some(
    (skill) => !isLegacySkill(skill) && skill.skillId === 'skill-entry-model',
  );
  const hasLegacyAuxiliarySkills = role.skills.some(
    (skill) => !isLegacySkill(skill) && legacyAuxiliarySkillIds.has(skill.skillId),
  );
  const hasCurrentIdContract = role.promptFragments?.some(
    (fragment) => fragment.id === 'combat-skill-id-contract',
  );
  const hasLegacyMetadata = (role.projectMetadataSelection ?? []).some((selection) =>
    /(?:saga2_design|saga2-project-battle-designer|editor-skill-editor-module)/i.test(
      selection.sourcePath,
    ),
  );
  const hasLegacyDefaults =
    role.useProjectDefaults === true || role.includeAllProjectMetadata === true;
  if (
    !hasRenamedSkill &&
    !hasLegacyAuxiliarySkills &&
    hasCurrentIdContract &&
    !hasLegacyMetadata &&
    !hasLegacyDefaults
  ) {
    return role;
  }
  return {
    ...role,
    // This marker identifies the pre-rename built-in snapshot. Refresh its
    // bundled prompt contract as well as the skill id; otherwise the old
    // prompt can direct the Agent back to the retired global skill name.
    prompt: bundled.prompt,
    promptFragments: bundled.promptFragments,
    // The old snapshot enabled project defaults, which would re-add the
    // retired skill id and broad metadata after this migration. The bundled
    // combat role deliberately owns its complete runtime contract now.
    useProjectDefaults: bundled.useProjectDefaults,
    includeAllProjectMetadata: bundled.includeAllProjectMetadata,
    projectMetadataSelection: bundled.projectMetadataSelection,
    skills: mergeSkills(
      role.skills
        .map(migrateSAGA2CombatSkillSelection)
        .filter((skill) => isLegacySkill(skill) || !legacyAuxiliarySkillIds.has(skill.skillId)),
      bundled.skills,
    ),
  };
}

/** Project defaults are part of the project/role contract, not a separate capability state. */
export function mergeMekaProjectRoleDefaults(
  role: MekaRoleFile,
  defaults: MekaProjectRoleDefaults,
): MekaRoleFile {
  if (role.useProjectDefaults !== true) return role;
  const excludedSkills = new Set(role.excludeDefaults?.skills ?? []);
  const excludedRules = new Set(role.excludeDefaults?.rules ?? []);
  const excludedMcp = new Set(role.excludeDefaults?.mcp ?? []);
  const excludedMetadata = new Set((role.excludeDefaults?.metadata ?? []).map(metadataKey));

  const skills = new Map<string, MekaRoleSkillSelection | MekaRoleSkillEntry>();
  for (const skillId of defaults.skills ?? []) {
    if (!excludedSkills.has(skillId)) skills.set(skillId, { skillId, enabled: true });
  }
  for (const entry of role.skills) {
    skills.set(isLegacySkill(entry) ? entry.id : entry.skillId, entry);
  }

  const rules = new Map<string, MekaRoleRule>();
  for (const rule of defaults.rules ?? []) {
    if (!excludedRules.has(rule.id)) rules.set(rule.id, rule);
  }
  for (const rule of role.rules ?? []) rules.set(rule.id, rule);

  const mcp = new Map<string, MekaRoleMcpEntry>();
  for (const entry of defaults.mcp ?? []) {
    if (!excludedMcp.has(entry.id)) mcp.set(entry.id, entry);
  }
  for (const entry of role.mcp) mcp.set(entry.id, entry);

  const metadata = new Map<string, MekaProjectMetadataSelection>();
  for (const entry of defaults.projectMetadataSelection ?? []) {
    if (!excludedMetadata.has(metadataKey(entry))) {
      metadata.set(metadataKey(entry), { ...entry, enabled: true });
    }
  }
  for (const entry of role.projectMetadataSelection ?? []) {
    metadata.set(metadataKey(entry), entry);
  }

  const framework = defaults.promptFramework?.trim();
  const ownPrompt = role.prompt?.trim();
  return {
    ...role,
    ...(framework ? { prompt: ownPrompt ? `${framework}\n\n${ownPrompt}` : framework } : {}),
    rules: [...rules.values()],
    skills: [...skills.values()],
    mcp: [...mcp.values()],
    projectMetadataSelection: [...metadata.values()],
  };
}

export function resolveRoleProjectMetadataSelections(
  role: MekaRoleFile,
  projectMetadata: readonly MekaProjectFile['metadata'][number][],
): MekaProjectMetadataSelection[] {
  const selections = new Map<string, MekaProjectMetadataSelection>();
  if (role.includeAllProjectMetadata === true) {
    for (const item of projectMetadata) {
      if (item.enabled === false) continue;
      const selection = {
        ...(item.rootPath ? { rootPath: item.rootPath } : {}),
        sourcePath: item.sourcePath,
        itemType: item.itemType,
        enabled: true,
      } satisfies MekaProjectMetadataSelection;
      selections.set(metadataKey(selection), selection);
    }
  }
  for (const selection of role.projectMetadataSelection ?? []) {
    selections.set(metadataKey(selection), selection);
  }
  return [...selections.values()];
}

function parseSkillMetadata(
  content: string,
  fallbackId: string,
): {
  name: string;
  description: string;
} {
  let data: Record<string, unknown>;
  try {
    data = matter(content).data as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `invalid Meka Skill frontmatter for ${fallbackId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : fallbackId;
  const description = typeof data.description === 'string' ? data.description.trim() : '';
  return { name, description };
}

function normalizeDiscoveredSkillId(
  name: string,
  sourcePath: string,
  usedIds: ReadonlySet<string>,
): string {
  const normalize = (value: string) =>
    value
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  const fallback = normalize(sourcePath) || 'project-skill';
  const base = (normalize(name) || fallback).slice(0, 64).replace(/-+$/g, '') || 'project-skill';
  let candidate = base;
  for (let duplicateIndex = 2; usedIds.has(candidate); duplicateIndex += 1) {
    const suffix = `-${duplicateIndex}`;
    candidate = `${base.slice(0, 64 - suffix.length).replace(/-+$/g, '')}${suffix}`;
  }
  if (!SAFE_DISCOVERED_SKILL_ID_RE.test(candidate)) {
    throw new Error(`invalid discovered Meka skill id: ${candidate}`);
  }
  return candidate;
}

/**
 * 包内 skill catalog：扫描 `resources/meka/skills/**` 下的 `SKILL.md`，返回 `skillId → 绝对路径`。
 *
 * 导出供 IPC 读清单路径复用同一份扫描结果（那里只要 id，不读正文）；**不要**在任何地方复制
 * 这份扫描逻辑，否则面板与运行期会各自漂移。
 */
export async function listBundledSkills(): Promise<Map<string, string>> {
  const root = bundledMekaSkillsRoot();
  const result = new Map<string, string>();

  async function walk(directory: string): Promise<void> {
    let entries: Array<{
      name: string;
      isDirectory(): boolean;
      isFile(): boolean;
    }>;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile() && entry.name === 'SKILL.md') {
        const id = path.basename(path.dirname(absolute));
        if (!SAFE_SKILL_ID_RE.test(id)) {
          throw new Error(`invalid bundled Meka skill id: ${id}`);
        }
        if (result.has(id)) throw new Error(`duplicate bundled Meka skill id: ${id}`);
        result.set(id, absolute);
      }
    }
  }

  await walk(root);
  return result;
}

async function readBundledRuntimeSkill(
  catalog: ReadonlyMap<string, string>,
  id: string,
): Promise<MekaRuntimeSkill> {
  const source = catalog.get(id);
  if (!source) throw new Error(`unknown bundled Meka skill: ${id}`);
  const content = await fs.readFile(source, 'utf8');
  const metadata = parseSkillMetadata(content, id);
  return {
    id,
    name: metadata.name,
    description: metadata.description,
    content,
    sourceDirectory: path.dirname(source),
    sourceEntryPath: source,
  };
}

/** Host-owned capabilities that every ordinary Meka session receives. */
export async function resolveMekaPlatformRuntimeSkills(): Promise<MekaRuntimeSkill[]> {
  const catalog = await listBundledSkills();
  return Promise.all(MEKA_PLATFORM_SKILL_IDS.map((id) => readBundledRuntimeSkill(catalog, id)));
}

async function resolveProjectWorkspace(project: ProjectRow): Promise<string | null> {
  const configuredPath = project.path?.trim();
  if (!configuredPath) return null;
  if (configuredPath === 'saga2') {
    return (await getMekaP4SettingsService().get()).p4RootPath;
  }
  return path.isAbsolute(configuredPath) ? path.resolve(configuredPath) : null;
}

/**
 * {@link resolveProjectMetadataAbsolutePath} 的可判别结果。
 *
 * 为什么 root 白名单失配被做成可判别结果、而不是当场抛错：这条解析位于元数据循环里、**在**
 * F1 容错 try/catch **之外**（见 `readProjectMetadataContent`）。对 `includeAllProjectMetadata`
 * 全量展开出来的项（共享默认角色出厂即全量）而言，root 失配只是「项目配置后来被改过」留下的历史
 * 残影 —— 用户先配了 `additionalPaths`、跑过「发现」把元数据项写进项目文件，之后又把这个
 * 附加路径删掉并保存；那个元数据项仍是 enabled 且带着旧 `rootPath`。把这类项升级成抛错，等于
 * **该项目的所有新建会话一起失败**。因此失败的种类与文案要交给调用点，由它按来源分流。
 *
 * 注意 `message` 逐字保留既有文案：它们是既有断言与用户可见错误文本的一部分。
 */
type MekaProjectMetadataPathResolution =
  | { path: string }
  | { failure: 'root-not-configured' | 'escapes-root'; message: string };

/**
 * 解析一条项目元数据的绝对路径。合法根只有 `[resolve(projectRoot), ...additionalRoots]`；
 * 候选路径逃出**该条目自己的 root** 同样非法。两类失败都不在这里抛错，而是返回带既有文案的
 * 可判别结果，由调用点按来源分流（`..` 逃逸对任何来源都不放宽，root 白名单失配仅对作者显式
 * 选择 fail-closed —— 见 `resolveMekaRuntimeConfig` 的元数据循环）。
 *
 * `null` 不是失败：项目根本没有可用的根（`path` 未配置/非绝对），调用方照旧跳过。
 */
function resolveProjectMetadataAbsolutePath(
  projectRoot: string | null,
  additionalRoots: readonly string[],
  selection: MekaProjectMetadataSelection,
): MekaProjectMetadataPathResolution | null {
  if (!projectRoot) return null;
  const roots = [path.resolve(projectRoot), ...additionalRoots.map((root) => path.resolve(root))];
  const root = path.resolve(selection.rootPath ?? projectRoot);
  const rootKey = (candidate: string) =>
    process.platform === 'win32'
      ? path.normalize(candidate).toLowerCase()
      : path.normalize(candidate);
  if (!roots.some((candidate) => rootKey(candidate) === rootKey(root))) {
    return {
      failure: 'root-not-configured',
      message: `Meka project metadata root is not configured: ${root}`,
    };
  }
  const candidate = path.resolve(root, ...selection.sourcePath.split('/'));
  const relative = path.relative(root, candidate);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    return {
      failure: 'escapes-root',
      message: `Meka project metadata escapes the project root: ${selection.sourcePath}`,
    };
  }
  return { path: candidate };
}

/**
 * 读取一条项目元数据，并同时返回它的绝对路径 —— 「地址 + 描述」的投递形态需要地址。
 * 内容不可用（ENOENT）时返回 null，调用方据此跳过，绝不产出悬空引用。
 *
 * 路径解析刻意**不在这里**：{@link resolveProjectMetadataAbsolutePath} 的契约校验留在"全量
 * 展开项可以跳过"的容错边界之外，由调用点按来源分流。准确口径是：
 * - `..` 逃逸与未知 `itemType`：**对任何来源都不放宽**（前者是安全红线，后者在项目配置归一化
 *   边界就被拦，运行期只是兜底的穷尽性校验）；
 * - **root 白名单失配**：仅对作者显式选择 fail-closed；仅由 `includeAllProjectMetadata`
 *   全量展开而来的项降级为 warn + 跳过。
 *
 * 为什么「跳过」在这里不是放宽：跳过的项**根本不读盘**，因此不可能读出允许根之外的内容 ——
 * 在安全上严格优于抛错（抛错只是把「配置历史残影」升级成该项目所有新建会话一起失败）。
 */
async function readProjectMetadataContent(
  absolutePath: string,
  selection: MekaProjectMetadataSelection,
): Promise<{ content: string; absolutePath: string } | null> {
  try {
    return { content: await fs.readFile(absolutePath, 'utf8'), absolutePath };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      log.warn('selected Meka project metadata is missing', {
        sourcePath: selection.sourcePath,
        itemType: selection.itemType,
      });
      return null;
    }
    throw error;
  }
}

type ConfiguredProjectMetadata = MekaProjectFile['metadata'][number];

/**
 * `subProjectPath` 是否可以作为作用范围采用：必须是**相对路径且不逃逸**。
 * 反斜杠一律先当分隔符看，因此 `C:\x`、`\\srv\share`、`/x` 与任何 `..` 段（含 `a/../b`）
 * 都判不安全；空值不算可用值（回落由调用方处理）。
 */
function isUsableScopePath(value: string): boolean {
  const slashed = value.replace(/\\/g, '/').trim();
  if (!slashed) return false;
  if (path.posix.isAbsolute(slashed) || path.isAbsolute(slashed) || /^[A-Za-z]:/.test(slashed)) {
    return false;
  }
  return !slashed.split('/').includes('..');
}

/**
 * 参考条目的作用范围：该文档治理的目录（posix 路径，`''` 表示该项 root 本身）。
 * 优先取扫描期记录的 `subProjectPath`，否则回落到文档自身所在目录；一律转 posix 并去掉
 * 首尾 `/`，只依赖配置本身 ⇒ 同一份配置每次得到同一个字符串。
 *
 * `subProjectPath` 只在它是根内相对路径时才采用（{@link isUsableScopePath}）：该字符串会被
 * 逐字写进注入文本并当作"从项目根可解析的目录"使用，绝对路径或含 `..` 段的值既无法定位，
 * 也可能把作用范围指向项目/附加根之外。`selection.sourcePath` 在项目配置边界上有
 * `canonicalRelativePath` 校验，`subProjectPath` 在**运行期读取侧**没有同等校验，所以这里
 * 兜住最后一道：越界值一律不采用，回落到文档所在目录，绝不原样输出。
 */
function projectReferenceScope(
  selection: MekaProjectMetadataSelection,
  configuredMetadata: ConfiguredProjectMetadata | undefined,
): string {
  const normalize = (value: string): string => {
    const normalized = value
      .replace(/\\/g, '/')
      .trim()
      .replace(/^\.\//, '')
      .replace(/^\/+|\/+$/g, '');
    return normalized === '.' ? '' : normalized;
  };
  const subProjectPath = configuredMetadata?.subProjectPath;
  if (typeof subProjectPath === 'string' && subProjectPath.trim()) {
    if (isUsableScopePath(subProjectPath)) return normalize(subProjectPath);
    log.warn('ignoring unsafe Meka project metadata subProjectPath', {
      sourcePath: selection.sourcePath,
      subProjectPath,
    });
  }
  return normalize(path.posix.dirname(selection.sourcePath));
}

/**
 * 参考条目的描述**只来自项目配置，绝不由模型生成**：`description` → `displayName` →
 * `name` → 相对 `sourcePath` 取第一个非空值，折叠空白并 trim 后有界化到 ≤300 字符。
 * 截断按码点做（与扫描期口径一致），保证不会把一个代理对切成半个字符。
 */
function projectReferenceDescription(
  selection: MekaProjectMetadataSelection,
  configuredMetadata: ConfiguredProjectMetadata | undefined,
): string {
  const candidates = [
    configuredMetadata?.description,
    configuredMetadata?.displayName,
    configuredMetadata?.name,
    selection.sourcePath,
  ];
  const description =
    candidates.find((value): value is string => typeof value === 'string' && value.trim() !== '') ??
    '';
  const collapsed = description.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= PROJECT_REFERENCE_DESCRIPTION_MAX) return collapsed;
  const characters = Array.from(collapsed);
  if (characters.length <= PROJECT_REFERENCE_DESCRIPTION_MAX) return collapsed;
  const head = characters.slice(0, PROJECT_REFERENCE_DESCRIPTION_MAX - 3).join('').trimEnd();
  return `${head}...`;
}

/** 参考清单的确定性排序：先 scope 升序、再绝对路径升序（system 前缀稳定 ⇒ 缓存率不退化）。 */
function compareProjectReferences(
  left: MekaProjectReference,
  right: MekaProjectReference,
): number {
  if (left.scope !== right.scope) return left.scope < right.scope ? -1 : 1;
  if (left.path !== right.path) return left.path < right.path ? -1 : 1;
  return 0;
}

function parseDiscoveredMcp(content: string, fallbackId: string): MekaRoleMcpEntry[] {
  const parsed: unknown = JSON.parse(content);
  if (!isRecord(parsed)) throw new Error(`Meka MCP metadata ${fallbackId} must be an object`);
  const container = isRecord(parsed.mcpServers)
    ? parsed.mcpServers
    : isRecord(parsed.servers)
      ? parsed.servers
      : { [fallbackId]: parsed };
  return Object.entries(container).map(([id, raw]) => {
    if (!isRecord(raw)) throw new Error(`Meka MCP metadata ${id} must be an object`);
    if (!SAFE_SKILL_ID_RE.test(id)) throw new Error(`Meka MCP metadata has an invalid id: ${id}`);
    // Unity is driven exclusively through the Meka Unity official CLI
    // (`unity_inspect` / `unity_execute`). Rejecting a Unity entry here is what keeps a
    // project-owned metadata file from routing Unity work back over MCP.
    if (/unity/i.test(id)) {
      throw new Error(
        `Unity is CLI-only; a Unity MCP metadata entry is not supported: ${id}`,
      );
    }
    if (typeof raw.providerId === 'string') {
      if (!SAFE_SKILL_ID_RE.test(raw.providerId)) {
        throw new Error(`Meka MCP metadata ${id} has an invalid providerId`);
      }
      return { id, providerId: raw.providerId, enabled: true };
    }
    const transport =
      raw.transport === 'stdio' || raw.transport === 'sse' || raw.transport === 'http'
        ? raw.transport
        : typeof raw.command === 'string'
          ? 'stdio'
          : 'http';
    if (
      raw.args !== undefined &&
      (!Array.isArray(raw.args) || raw.args.some((item) => typeof item !== 'string'))
    ) {
      throw new Error(`Meka MCP metadata ${id} args must be an array of strings`);
    }
    if (transport === 'stdio' && (typeof raw.command !== 'string' || !raw.command.trim())) {
      throw new Error(`Meka MCP metadata ${id} requires command for stdio transport`);
    }
    if (transport !== 'stdio' && (typeof raw.url !== 'string' || !raw.url.trim())) {
      throw new Error(`Meka MCP metadata ${id} requires url for ${transport} transport`);
    }
    if (raw.env !== undefined && !isRecord(raw.env)) {
      throw new Error(`Meka MCP metadata ${id} env must be an object`);
    }
    if (isRecord(raw.env)) {
      for (const [name, value] of Object.entries(raw.env)) {
        if (typeof value !== 'string' || !SECRET_REFERENCE_RE.test(value)) {
          throw new Error(
            `Meka MCP metadata ${id} env.${name} contains a raw value; use {{secret:name}}`,
          );
        }
      }
    }
    return {
      id,
      transport,
      enabled: true,
      ...(typeof raw.command === 'string' ? { command: raw.command } : {}),
      ...(Array.isArray(raw.args) && raw.args.every((item) => typeof item === 'string')
        ? { args: raw.args as string[] }
        : {}),
      ...(typeof raw.url === 'string' ? { url: raw.url } : {}),
      ...(isRecord(raw.env) && Object.values(raw.env).every((item) => typeof item === 'string')
        ? { env: raw.env as Record<string, string> }
        : {}),
    };
  });
}

function roleManifestDirectory(row: RoleRow): string {
  if (row.is_builtin === 1) return bundledMekaRolesRoot();
  const configured = row.file_path.trim();
  if (path.isAbsolute(configured)) return path.dirname(path.resolve(configured));
  return path.dirname(path.resolve(app.getPath('userData'), configured));
}

async function readRoleRelativeFile(row: RoleRow, relativePath: string): Promise<string> {
  return fs.readFile(resolveRoleRelativePath(row, relativePath), 'utf8');
}

function resolveRoleRelativePath(row: RoleRow, relativePath: string): string {
  const root = path.resolve(roleManifestDirectory(row));
  const candidate = path.resolve(root, relativePath);
  const relative = path.relative(root, candidate);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`Meka role resource escapes the role directory: ${relativePath}`);
  }
  return candidate;
}

function mergeById<T extends { id: string }>(current: readonly T[], required: readonly T[]): T[] {
  const merged = new Map(current.map((entry) => [entry.id, entry]));
  for (const entry of required) merged.set(entry.id, entry);
  return [...merged.values()];
}

function mergeSkills(
  current: readonly (MekaRoleSkillSelection | MekaRoleSkillEntry)[],
  required: readonly (MekaRoleSkillSelection | MekaRoleSkillEntry)[],
): Array<MekaRoleSkillSelection | MekaRoleSkillEntry> {
  const key = (entry: MekaRoleSkillSelection | MekaRoleSkillEntry) =>
    isLegacySkill(entry) ? entry.id : entry.skillId;
  const merged = new Map(current.map((entry) => [key(entry), entry]));
  for (const entry of required) merged.set(key(entry), entry);
  return [...merged.values()];
}

/**
 * 「包内 catalog 全量」的展开点（`includeAllBundledSkills`）：开关为 true 时，把 catalog 里
 * **每一个** skill id 以 `{ skillId, enabled: true }` 铺进选择集合，再由角色清单里的显式条目
 * 按同 key 覆盖 —— 与 `mergeMekaProjectRoleDefaults` 的「defaults 先铺、角色同 id 覆盖」完全同
 * 一口径，因此显式 `enabled: false` 可以精确排除单个 skill。开关为 false 时原样返回
 * `role.skills`，不改变任何既有语义。
 *
 * 展开来源就是调用方传入的 catalog 本身（`listBundledSkills()` 的扫描结果），所以
 * `readBundledRuntimeSkill` 不可能收到未知 id；这里也刻意不枚举任何 skill id —— 以后应用新增内置
 * skill 时，开关自动覆盖它，不会漂移。
 *
 * 运行期与面板读清单（`localDb/ipc/mekaRoles.ts`）共用这一个函数，禁止第二套展开逻辑。
 */
export function resolveBundledSkillSelections(
  role: Pick<MekaRoleFile, 'skills' | 'includeAllBundledSkills'>,
  catalog: ReadonlyMap<string, string>,
): Array<MekaRoleSkillSelection | MekaRoleSkillEntry> {
  if (role.includeAllBundledSkills !== true) return role.skills;
  return mergeSkills(
    [...catalog.keys()].map((skillId): MekaRoleSkillSelection => ({ skillId, enabled: true })),
    role.skills,
  );
}

/** skills 的既有 key 口径，与 `mergeSkills` / `mergeMekaProjectRoleDefaults` 逐字一致。 */
function skillSelectionKey(entry: MekaRoleSkillSelection | MekaRoleSkillEntry): string {
  return isLegacySkill(entry) ? entry.id : entry.skillId;
}

/**
 * 只保留「在 `derived` 里没有同 key 等价条目」的项；等价 = `isDeepStrictEqual`（含字段与值，
 * 与对象字面量的键序无关）。见 {@link stripSelectAllDerivedEntries}。
 */
function withoutDerivedEntries<T>(
  current: readonly T[],
  derived: readonly T[],
  key: (entry: T) => string,
): T[] {
  const derivedByKey = new Map(derived.map((entry) => [key(entry), entry]));
  return current.filter((entry) => {
    const candidate = derivedByKey.get(key(entry));
    return candidate === undefined || !isDeepStrictEqual(candidate, entry);
  });
}

/**
 * {@link resolveBundledSkillSelections} 的落盘侧反向操作：把**完全由三个 select-all 开关派生**
 * 出来的条目从清单里剥掉，只留开关本身，维持「开关即真相、不枚举 id」的契约。
 *
 * 为什么必须剥：面板拿到的是**展开态**（`localDb/ipc/mekaRoles.ts` 的 `expandRoleManifest` 在
 * `read-manifest` 时已把开关展开成显式清单），保存时若原样写回，那些条目就从"派生"变成磁盘上的
 * 静态副本。其中 `projectMetadataSelection` 的后果是 P1：运行期
 * （`resolveMekaRuntimeConfig` 的 `explicitMetadataKeys` 快照）只对**作者显式选择** fail-closed，
 * 一旦全量展开项被物化，项目里任何一个无法解析的第三方 `SKILL.md` / `.mcp.json` 都会把该角色的
 * 新建会话顶成 `INVALID_PARAMS`。这条路径还是被官方文案引导的：
 * `MEKA_BUILTIN_READ_ONLY` 让用户「copy it to a project role instead」，而复制的正是三个开关
 * 全 true 的默认角色。
 *
 * 判据刻意取"完全等价"：作者把某个派生项改成 `enabled: false`（或改动其它任何字段）后它不再与
 * derived 相等 ⇒ 必须保留，那是精确的排除意图；派生集合里没有的 key ⇒ 也保留（作者新增项）。
 *
 * 派生集合来自与运行期**同一条**展开漏斗：以「开关不变、四个列表清空」的清单为输入，依次走
 * `mergeMekaProjectRoleDefaults` → `resolveRoleProjectMetadataSelections` →
 * `resolveBundledSkillSelections`。**除这四个列表之外，`prompt` 上由项目 `roleDefaults.promptFramework`
 * 派生的前缀也要剥**（判据见函数体内的 `prompt` 段），其余字段（`workflow` /
 * `policyProviderRefs` / `displayName` / 三个开关本身 …）一律不动。
 *
 * 纯函数：不读磁盘、不打日志。（**不承诺对畸形输入不抛错**：`manifest.skills` / `manifest.mcp`
 * 缺失时 `withoutDerivedEntries(undefined, …)` 会抛 `TypeError`。调用方的包装层
 * `localDb/ipc/mekaRoles.ts` 的 `stripSelectAllDerivedForSave` 会捕获并降级为「原样落盘」，
 * 于是这类输入最终落到既有的 `role skills/mcp must be arrays` 校验失败上，**不会留下半残缺的
 * 落盘**。）项目文件里没有的项在 derived 里本就不存在，因此自然不会被剥掉（取不到项目文件时
 * 调用方跳过剥离即可）。
 */
export function stripSelectAllDerivedEntries(
  manifest: MekaRoleManifestFile,
  projectFile: MekaProjectFile,
  catalog: ReadonlyMap<string, string>,
): MekaRoleManifestFile {
  if (
    manifest.useProjectDefaults !== true &&
    manifest.includeAllProjectMetadata !== true &&
    manifest.includeAllBundledSkills !== true
  ) {
    return manifest;
  }
  // 开关保持原样、四个列表清空 ⇒ 下面这条漏斗里只可能剩下「开关自己派生出来的东西」。
  const switchesOnly: MekaRoleFile = {
    ...manifest,
    rules: [],
    skills: [],
    mcp: [],
    projectMetadataSelection: [],
  };
  const merged = mergeMekaProjectRoleDefaults(switchesOnly, projectFile.roleDefaults ?? {});
  const derived: MekaRoleFile = {
    ...merged,
    projectMetadataSelection: resolveRoleProjectMetadataSelections(merged, projectFile.metadata),
    skills: resolveBundledSkillSelections(merged, catalog),
  };
  // `prompt` 的派生前缀：`mergeMekaProjectRoleDefaults` 在 `roleDefaults.promptFramework` 非空时把
  // framework 前置进 `prompt`（own 为空 ⇒ prompt 恰为 framework，否则为 `framework\n\n own`）。展开态
  // 草稿带着这段前缀回传，若原样落盘，运行期再前置一次就变成 `framework\n\nframework\n\n own`，且每次
  // 「打开面板 → 保存」再叠一份。
  //
  // 为什么用「前缀剥离」而不是「与 `derived.prompt` 相等就还原」：那个判据要拿作者的 **own** 文本
  // 才算得出（`derived.prompt` 是 `framework + own`），而这里只拿得到展开值、拿不到 own，故只能按
  // 前缀剥。代价是「作者 own 恰好以 framework 开头」也会被剥——但剥掉后运行期会**再前置一次**，
  // 有效 prompt 逐字不变，因此对任何场景都不改变行为。
  //
  // 为什么 `prompt === framework` 只能来自「own 为空」：own 为空时合并结果就是 framework；若 own 也
  // 恰好等于 framework，合并结果会是 `framework\n\nframework`（恒不等于 framework）。故这条推断是
  // **确定的**，可以放心写回空串（写 `''` 而不是删字段，与 `normalizeMekaRoleManifest` 的字符串字段
  // 契约一致——它随后会把空串规范成「无 prompt」）。
  //
  // 幂等（语义等价）：剥掉后运行期 `resolveMekaRuntimeConfig` 再走一次
  // `mergeMekaProjectRoleDefaults`，得到的正是第一次的展开值 ⇒ 无论保存多少次，运行期 prompt 恒定，
  // 磁盘上的 prompt 回到作者 own。
  //
  // 门控：只有 `useProjectDefaults === true` 才可能被合并改动 `prompt`（该函数对其它角色直接早退），
  // 且 framework 为空/纯空白时不处理；不满足「恰等于」或「以 `framework\n\n` 开头」的 prompt
  // （含作者改写过前缀、空串）一律原样保留。
  const framework =
    manifest.useProjectDefaults === true ? projectFile.roleDefaults?.promptFramework?.trim() : '';
  const prompt = manifest.prompt ?? '';
  const derivedPromptPrefix = framework ? `${framework}\n\n` : '';
  const promptPatch: Partial<Pick<MekaRoleManifestFile, 'prompt'>> = !framework
    ? {}
    : prompt === framework
      ? { prompt: '' }
      : prompt.startsWith(derivedPromptPrefix)
        ? { prompt: prompt.slice(derivedPromptPrefix.length) }
        : {};
  return {
    ...manifest,
    ...promptPatch,
    skills: withoutDerivedEntries(manifest.skills, derived.skills, skillSelectionKey),
    mcp: withoutDerivedEntries(manifest.mcp, derived.mcp, (entry) => entry.id),
    ...(manifest.rules
      ? { rules: withoutDerivedEntries(manifest.rules, derived.rules ?? [], (rule) => rule.id) }
      : {}),
    ...(manifest.projectMetadataSelection
      ? {
          projectMetadataSelection: withoutDerivedEntries(
            manifest.projectMetadataSelection,
            derived.projectMetadataSelection ?? [],
            metadataKey,
          ),
        }
      : {}),
  };
}

function mergeMetadataSelections(
  current: readonly MekaProjectMetadataSelection[],
  required: readonly MekaProjectMetadataSelection[],
): MekaProjectMetadataSelection[] {
  const merged = new Map(current.map((entry) => [metadataKey(entry), entry]));
  for (const entry of required) merged.set(metadataKey(entry), entry);
  return [...merged.values()];
}

function upgradeLegacyBundledWorkflowRole(
  manifest: MekaRoleFile,
  bundled: MekaRoleFile,
): { role: MekaRoleFile; recovered: boolean } {
  if (manifest.workflow || !bundled.workflow) return { role: manifest, recovered: false };

  // Project-owned role snapshots predate Host workflows. Missing workflow is
  // the version marker: restore the current built-in contract in memory while
  // retaining project-specific additions. Do not rewrite the P4-owned file.
  return {
    recovered: true,
    role: {
      ...manifest,
      displayName: bundled.displayName,
      description: bundled.description,
      policyProviderRefs: bundled.policyProviderRefs,
      workflow: bundled.workflow,
      prompt: bundled.prompt,
      promptFragments: bundled.promptFragments,
      useProjectDefaults: bundled.useProjectDefaults,
      skills: mergeSkills(manifest.skills, bundled.skills),
      mcp: mergeById(manifest.mcp, bundled.mcp),
      projectMetadataSelection: mergeMetadataSelections(
        manifest.projectMetadataSelection ?? [],
        bundled.projectMetadataSelection ?? [],
      ),
    },
  };
}

async function resolveRoleFile(
  row: RoleRow,
  projectFile: MekaProjectFile,
): Promise<{ role: MekaRoleFile; workflowRecoveredFromRole: boolean }> {
  if (row.is_builtin === 1 && row.id === mekaDefaultRoleId(row.project_id)) {
    // 默认角色没有磁盘清单文件（`readBuiltinRoleManifest` 对它必然抛错），出厂清单由内存函数
    // 提供。这里**不是**「零注入」短路：返回后调用方依旧会对它做 `mergeMekaProjectRoleDefaults`
    // 与 `resolveRoleProjectMetadataSelections`，与其它角色走同一条展开漏斗。
    // 它也因此不经过 `upgradeLegacyBundledWorkflowRole` / `migrateSAGA2CombatRoleSkills`——
    // 这两个升级路径都以「该 roleId 存在 bundled 清单文件」为前提，而默认角色的清单从不落盘。
    const manifest = mekaDefaultRoleManifest(row.project_id);
    return { role: manifest, workflowRecoveredFromRole: false };
  }
  if (row.is_builtin === 1) {
    const bundled = await readBuiltinRoleManifest(row.id, row.project_id);
    const manifest = projectFile.builtinRoles?.find((role) => role.id === row.id) ?? bundled;
    const upgraded = upgradeLegacyBundledWorkflowRole(manifest, bundled);
    return {
      role: migrateSAGA2CombatRoleSkills(upgraded.role, row.project_id, row.id, bundled),
      workflowRecoveredFromRole: upgraded.recovered,
    };
  }
  const manifest = await readCustomRoleManifest(row.id, app.getPath('userData'), row.project_id);
  if (!manifest) throw new Error(`Meka role manifest is missing: ${row.id}`);
  return { role: manifest, workflowRecoveredFromRole: false };
}

/**
 * Resolve the current project and role files directly into runtime inputs.
 * There is deliberately no capability-status, whitelist, activation, or snapshot layer here.
 */
export async function resolveMekaRuntimeConfig(
  projectId: string,
  roleId: string,
): Promise<MekaRuntimeConfig> {
  const db = getDbClient();
  const [project, role] = await Promise.all([
    db.queryOne<ProjectRow>('SELECT id, path, is_builtin FROM meka_projects WHERE id = ?', [
      projectId,
    ]),
    db.queryOne<RoleRow>(
      'SELECT id, project_id, is_builtin, file_path FROM meka_roles WHERE id = ?',
      [roleId],
    ),
  ]);
  if (!project) throw new Error(`Meka project not found: ${projectId}`);
  if (!role) throw new Error(`Meka role not found: ${roleId}`);
  if (role.project_id !== project.id) {
    throw new Error(`Meka role ${roleId} does not belong to project ${projectId}`);
  }

  const projectRoot = await resolveProjectWorkspace(project);
  const projectFile = await readEffectiveProjectConfig({
    projectId: project.id,
    isBuiltin: project.is_builtin === 1,
    projectRoot: projectRoot ?? '',
    appIsPackaged: app.isPackaged,
  });
  if (!projectFile) throw new Error(`Meka project config is missing: ${projectId}`);

  const resolvedRole = await resolveRoleFile(role, projectFile);
  const roleFile = mergeMekaProjectRoleDefaults(resolvedRole.role, projectFile.roleDefaults ?? {});
  // 作者侧「显式选择」的 key 快照。落位有两个约束，缺一个这份快照就没意义：
  // - 必须在 `resolveRoleProjectMetadataSelections` **之前**：那个函数会把
  //   `includeAllProjectMetadata` 全量展开出的项并进同一个 `roleFile.projectMetadataSelection`，
  //   合并之后就再也分不清"作者勾选的项"与"扫描自动展开的项"了。
  // - 必须在 `mergeMekaProjectRoleDefaults` **之后**：项目 `roleDefaults.projectMetadataSelection`
  //   同样是作者侧的显式声明，要和角色清单里的选择同等 fail-closed。
  // 用途见下方元数据循环：显式选择的项解析失败仍然上抛，只有全量展开项才允许跳过。
  const explicitMetadataKeys = new Set(
    (roleFile.projectMetadataSelection ?? []).map((selection) => metadataKey(selection)),
  );
  roleFile.projectMetadataSelection = resolveRoleProjectMetadataSelections(
    roleFile,
    projectFile.metadata,
  );
  const catalog = await listBundledSkills();
  const skills = new Map<string, MekaRuntimeSkill>();
  const prompts: string[] = [];
  const mcp = new Map<string, MekaRoleMcpEntry>();
  const additionalRoots = projectFile.basic.additionalPaths ?? [];
  const projectMetadata = new Map(projectFile.metadata.map((item) => [metadataKey(item), item]));

  if (roleFile.prompt?.trim()) prompts.push(roleFile.prompt.trim());
  for (const rule of roleFile.rules ?? []) {
    if (rule.enabled && rule.text.trim()) prompts.push(rule.text.trim());
  }
  for (const fragment of roleFile.promptFragments ?? []) {
    if (!fragment.path.trim()) {
      throw new Error(`Meka role prompt fragment ${fragment.id} has an empty path`);
    }
    prompts.push((await readRoleRelativeFile(role, fragment.path)).trim());
  }

  // 「包内 catalog 全量」铺底（`includeAllBundledSkills`）：展开来源就是上面 `listBundledSkills()`
  // 的扫描结果本身，因此不会引入 catalog 之外的 id；随后 `roleFile.skills` 里的显式条目按同 key
  // 覆盖（`enabled: false` 精确排除单个）。展开只改 harness 原生 catalog 的选择集 —— 技能 id 清单与
  // 正文都**不**写进 `prompts`。
  //
  // 作者侧「显式选择」的 skill key 快照。落位约束与 `explicitMetadataKeys` 完全一致：必须在
  // `mergeMekaProjectRoleDefaults` **之后**（项目 `roleDefaults.skills` 同样是作者侧的显式声明）、
  // 在 `resolveBundledSkillSelections` 全量展开 **之前**（展开之后 catalog 铺进来的 id 与作者自己
  // 写的 id 就再也分不清了）。用途只有一处：`derivedOnly` —— 快照之外的 skill 都是「只由全量开关
  // 派生」，快照里没有它就不是作者显式选择。
  const explicitSkillKeys = new Set(roleFile.skills.map(skillSelectionKey));
  const skillSelections = resolveBundledSkillSelections(roleFile, catalog);

  for (const selected of skillSelections) {
    if (isLegacySkill(selected)) {
      if (!SAFE_SKILL_ID_RE.test(selected.id)) {
        throw new Error(`invalid path-based Meka role skill id: ${selected.id}`);
      }
      const source = resolveRoleRelativePath(role, selected.path);
      const content = await fs.readFile(source, 'utf8');
      const metadata = parseSkillMetadata(content, selected.id);
      skills.set(selected.id, {
        id: selected.id,
        name: metadata.name,
        description: selected.description ?? metadata.description,
        content,
        sourceDirectory: path.dirname(source),
        sourceEntryPath: source,
      });
      continue;
    }
    if (!selected.enabled) continue;
    // catalog 全量铺底而来的 id 不在快照里 ⇒ 标为 derivedOnly（同 id 的作者显式条目在
    // `resolveBundledSkillSelections` 里按同 key 覆盖，因此这里读到的 id 命中快照就不是派生的）。
    const runtimeSkill = await readBundledRuntimeSkill(catalog, selected.skillId);
    skills.set(
      selected.skillId,
      explicitSkillKeys.has(selected.skillId) ? runtimeSkill : { ...runtimeSkill, derivedOnly: true },
    );
  }

  for (const entry of roleFile.mcp) {
    // Same CLI-only boundary as the metadata path above: a role must not declare a Unity MCP
    // server. Unity access goes through the Meka Unity official CLI.
    if (/unity/i.test(entry.id)) {
      throw new Error(`Unity is CLI-only; a Unity MCP role entry is not supported: ${entry.id}`);
    }
    if (entry.enabled !== false) mcp.set(entry.id, entry);
  }

  const projectReferences = new Map<string, MekaProjectReference>();
  // 战斗 workflow 的规范类元数据**保持改动前的内联投递**（有意差异，需在文档登记）。
  // 判据用 workflow 而不是 role id：进入战斗的唯一分流判据就是它（`mekaResolvePlan` 的段序、
  // 策略层、服务器能力态都按它走），自定义角色只要声明同一个 workflow 就必须同形态。
  // 理由：战斗会话的项目参考路径是一套**封闭且精确**的白名单契约 —— `[SAGA2_PROJECT_PATHS]`
  // 逐条给出 ReadCommand，同一份解析结果写进 `vendorOptions.mekaCombatProjectRefPaths` 供策略层
  // 精确放行，而策略层会**拒绝**读取工作区根 `AGENTS.md`（只放行已知的 saga2_unity/AGENTS.md）。
  // 再叠加一段"必须读取这些路径"的开放清单，就是让指令与 Host 策略正面冲突：模型被要求读，
  // 读取却被拒绝。规范正文在改动前是内联进 prompt 的（可正常工作），保持原形态才不会静默丢掉
  // 已经在场的规范。
  const inlineProjectDocumentation = roleFile.workflow === 'saga2-combat-development-v1';

  for (const selection of roleFile.projectMetadataSelection ?? []) {
    if (!selection.enabled) continue;
    const selectionKey = metadataKey(selection);
    // 该 key 是否来自作者侧显式选择（角色清单 + 项目 roleDefaults）。全量展开项不在快照里。
    const isExplicitSelection = explicitMetadataKeys.has(selectionKey);
    const configuredMetadata = projectMetadata.get(selectionKey);
    if (configuredMetadata?.enabled === false) continue;
    // 类型穷尽性校验前置在容错边界之外：`itemType` 不合法说明这条选择本身不可信，因此
    // **任何来源都不跳过**，全量展开项也不例外。这与 root 白名单失配是**刻意的不同口径**：
    // root 失配是「配置被改过」的历史残影（被删掉的 `additionalPath` 留下的旧 `rootPath`），
    // 而未知 `itemType` 是配置本身被改坏，两者不能同口径降级。
    const itemType = selection.itemType;
    if (
      itemType !== 'agents-md' &&
      itemType !== 'rule' &&
      itemType !== 'skill' &&
      itemType !== 'mcp'
    ) {
      const exhaustive: never = itemType;
      throw new Error(`unsupported Meka project metadata type: ${String(exhaustive)}`);
    }
    // 路径契约校验同样留在容错边界之外，但**按来源分流**（见 readProjectMetadataContent）：
    // - `escapes-root`（`..` 逃逸）：任何来源都抛错，红线不放宽；
    // - `root-not-configured`：作者显式选择仍 fail-closed；仅由 `includeAllProjectMetadata`
    //   全量展开而来的项按与 ENOENT / 解析失败相同的容忍口径 warn + 跳过。
    //   跳过在安全上**严格优于**抛错：它根本不访问那个根，因此不可能读出允许根之外的内容。
    const resolution = resolveProjectMetadataAbsolutePath(projectRoot, additionalRoots, selection);
    if (resolution === null) continue;
    if ('failure' in resolution) {
      if (resolution.failure === 'root-not-configured' && !isExplicitSelection) {
        log.warn('skipping Meka project metadata whose root is no longer configured', {
          metadataKey: selectionKey,
          sourcePath: selection.sourcePath,
          itemType,
          rootPath: selection.rootPath,
        });
        continue;
      }
      throw new Error(resolution.message);
    }
    const absolutePath = resolution.path;
    try {
      const resolvedMetadata = await readProjectMetadataContent(absolutePath, selection);
      // 内容不可用（ENOENT）时一并跳过：绝不产出指向不存在文件的悬空引用。
      if (resolvedMetadata === null) continue;
      switch (itemType) {
        case 'agents-md':
        case 'rule':
          // 战斗 workflow：维持改动前的内联投递，不产出 `projectReferences` 条目
          // ⇒ order 65 段拿到空集合、整段不渲染（`mekaProjectReferencesPrompt` 空集合返回 null）。
          if (inlineProjectDocumentation) {
            prompts.push(resolvedMetadata.content.trim());
            break;
          }
          // 其余角色：规范类元数据只投递「地址 + 描述」，正文由 Agent 按需读取（渐进披露）。
          // 内联正文会把 system 前缀推到 Pi 的 argv 预算之外（win32 30,000 字符 ⇒ 新建会话直接失败），
          // 所以这里刻意不再把正文 push 进 prompts。同一 metadataKey 去重，保持既有 map 语义。
          projectReferences.set(selectionKey, {
            scope: projectReferenceScope(selection, configuredMetadata),
            path: resolvedMetadata.absolutePath,
            description: projectReferenceDescription(selection, configuredMetadata),
            itemType,
          });
          break;
        case 'skill': {
          const fallbackId = path.posix.basename(path.posix.dirname(selection.sourcePath));
          const metadata = parseSkillMetadata(resolvedMetadata.content, fallbackId);
          const id = normalizeDiscoveredSkillId(
            configuredMetadata?.name ?? metadata.name,
            selection.sourcePath,
            new Set(skills.keys()),
          );
          skills.set(id, {
            id,
            name: configuredMetadata?.displayName ?? metadata.name,
            description:
              configuredMetadata?.description ?? metadata.description ?? selection.sourcePath,
            content: resolvedMetadata.content,
            // 只由 `includeAllProjectMetadata` 全量展开而来的 skill：它的源目录可能整个是项目根
            // 或一个第三方目录，快照收集失败时必须只跳过它自己（见 MekaRuntimeSkill.derivedOnly）。
            ...(isExplicitSelection ? {} : { derivedOnly: true }),
            sourceDirectory: path.dirname(
              path.resolve(
                selection.rootPath ?? projectRoot ?? '',
                ...selection.sourcePath.split('/'),
              ),
            ),
            sourceEntryPath: path.resolve(
              selection.rootPath ?? projectRoot ?? '',
              ...selection.sourcePath.split('/'),
            ),
          });
          break;
        }
        case 'mcp': {
          const discovered = parseDiscoveredMcp(
            resolvedMetadata.content,
            configuredMetadata?.name ?? path.posix.basename(selection.sourcePath),
          );
          // 撞名在写入前一次性判定：全量展开项可能整项被跳过，不得留下"半个文件"的残留。
          for (const entry of discovered) {
            if (mcp.has(entry.id)) {
              throw new Error(`duplicate discovered Meka MCP id: ${entry.id}`);
            }
          }
          for (const entry of discovered) mcp.set(entry.id, entry);
          break;
        }
      }
    } catch (error) {
      // 作者显式选择的项：解析失败**仍然上抛**，不放宽作者配置的 fail-closed 契约。
      if (isExplicitSelection) throw error;
      // 仅由 `includeAllProjectMetadata` 全量展开而来的项：这类项由项目扫描自动产生，可能包含
      // 无法解析的第三方文件（frontmatter 非法的 `SKILL.md`、声明不全的 `.mcp.json`…）。
      // 让其中一个坏文件把该项目的**所有新建会话**顶成 `INVALID_PARAMS` 不可接受，因此按与
      // ENOENT 相同的容忍口径跳过，只 warn 记录。
      // 之所以不能对显式选择照做：显式选择是作者意图，静默跳过会把"配置写错了"变成
      // "配置生效了但什么都没有"，掩盖真正的配置错误。
      log.warn('skipping unparsable Meka project metadata from includeAllProjectMetadata', {
        metadataKey: selectionKey,
        sourcePath: selection.sourcePath,
        itemType,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const policyProviderRefs = [...(roleFile.policyProviderRefs ?? [])];
  for (const ref of policyProviderRefs) {
    if (!KNOWN_POLICY_PROVIDER_REFS.has(ref)) {
      throw new Error(`unknown Meka policy provider: ${ref}`);
    }
  }

  return {
    projectId,
    roleId,
    roleDisplayName: roleFile.displayName,
    workflowRecoveredFromRole: resolvedRole.workflowRecoveredFromRole,
    promptText: prompts.filter(Boolean).join('\n\n'),
    skills: [...skills.values()],
    mcp: [...mcp.values()],
    policyProviderRefs,
    projectReferences: [...projectReferences.values()].sort(compareProjectReferences),
    ...(roleFile.workflow ? { workflow: roleFile.workflow } : {}),
  };
}
