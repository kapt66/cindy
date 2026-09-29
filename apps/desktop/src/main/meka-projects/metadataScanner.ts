import { createHash } from 'node:crypto';
import path from 'node:path';

import { listAllFiles, readFile } from '@cindy/file-browser-core';
import { parseFrontmatter } from '../../../../../packages/maker-core/src/agents/shared/customization-scanner.js';
import type { MekaProjectMetadataItemType } from '../../shared/meka-projects.js';
import type { MekaProjectFile } from '../../shared/meka-projects.js';
import { createLogger } from '../logger.js';

const log = createLogger('meka-projects:metadata-scanner');

export interface DiscoveredMekaProjectMetadata {
  itemType: MekaProjectMetadataItemType;
  sourcePath: string;
  /** Absolute root for extra paths; omitted when the primary project root is used. */
  rootPath?: string;
  subProjectPath: string | null;
  name: string;
  description?: string;
  contentFingerprint: string;
}

/** Refresh filesystem-derived fields while preserving project-owned metadata annotations. */
export function mergeDiscoveredMekaProjectMetadata(
  current: MekaProjectFile,
  discovered: readonly DiscoveredMekaProjectMetadata[],
): MekaProjectFile {
  const previous = new Map(
    current.metadata.map((item) => [
      `${item.rootPath ?? ''}|${item.sourcePath}|${item.itemType}`,
      item,
    ]),
  );
  return {
    ...current,
    metadata: discovered.map((item) => {
      const old = previous.get(`${item.rootPath ?? ''}|${item.sourcePath}|${item.itemType}`);
      return {
        ...item,
        disciplines: old?.disciplines ?? [],
        domains: old?.domains ?? [],
        enabled: old?.enabled ?? true,
        ...(old?.displayName ? { displayName: old.displayName } : {}),
        ...(old?.description ? { description: old.description } : {}),
        ...(old?.notes ? { notes: old.notes } : {}),
      };
    }),
  };
}

/**
 * 扫描与技能快照**共用**的排除目录名单。
 *
 * `METADATA_SCAN_GLOBS` 由它拼出负向 glob；`skillSnapshot.ts` 的 walk 也直接引用它跳过这些目录名。
 * **不要在任何地方另抄一份**：两处一旦漂移，就会出现「项目扫描看不见、技能快照却递归进去」的目录
 * —— 而技能快照的代价是每个新会话都要遍历 + 哈希，一个 `.git` 就足以让会话起不来。
 */
export const METADATA_SCAN_EXCLUDED_DIRECTORIES = [
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  '__pycache__',
  'vendor',
  '.venv',
  '.cache',
  '.vs',
  '.idea',
  '.vscode-test',
  'dist',
  'build',
  'out',
  '.next',
  'target',
  'bin',
  'obj',
  'Library',
  'library',
  'Temp',
  'temp',
  'Logs',
  'UserSettings',
  'AssetDepotOutput',
  'ChuangXiangEditorCache',
] as const;

/** 由上面那份名单**拼出**的负向 glob：逐字等于历史内联字符串，扫描行为不变。 */
const METADATA_SCAN_EXCLUDED_DIRECTORIES_GLOB =
  `!**/{${METADATA_SCAN_EXCLUDED_DIRECTORIES.join(',')}}/**`;

const METADATA_SCAN_GLOBS = [
  '**/AGENTS.md',
  '**/CLAUDE.md',
  '**/SKILL.md',
  '**/.cursorrules',
  '**/rules.md',
  '**/.mcp.json',
  '**/mcp.json',
  '**/.p4ignore',
  METADATA_SCAN_EXCLUDED_DIRECTORIES_GLOB,
] as const;

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
    !slashed ||
    normalized !== slashed ||
    path.posix.isAbsolute(slashed) ||
    normalized === '..' ||
    normalized.startsWith('../')
  )
    return null;
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

/** 描述上限：与 ghost roster 的「单条 ≤300 字符」预算口径一致，且保证注入文本长度确定。 */
const REFERENCE_DESCRIPTION_MAX_LENGTH = 300;

/** 单句断点：CJK 标点直接断句；ASCII 句点只在后接空白或行尾时断句，避免切断 `v1.2.3` 这类片段。 */
const DESCRIPTION_SENTENCE_BREAK = /[。！？；!?;]|\.(?=\s|$)/;

/** 折叠连续空白并做确定性截断；结果为空时返回 undefined，调用方据此不写 description。 */
function boundDescription(raw: string): string | undefined {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (!collapsed) return undefined;
  if (collapsed.length <= REFERENCE_DESCRIPTION_MAX_LENGTH) return collapsed;
  // 长度按码点复核后再截断，避免把一个代理对切成半个字符。
  const characters = Array.from(collapsed);
  if (characters.length <= REFERENCE_DESCRIPTION_MAX_LENGTH) return collapsed;
  const head = characters.slice(0, REFERENCE_DESCRIPTION_MAX_LENGTH - 3).join('').trimEnd();
  return `${head}...`;
}

/** 取首句（含句末标点）；找不到断点或首字符即断点（如 `!important`）时整段返回。 */
function firstSentence(text: string): string {
  const match = DESCRIPTION_SENTENCE_BREAK.exec(text);
  if (!match || match.index === 0) return text;
  return text.slice(0, match.index + match[0].length);
}

/**
 * 剥掉文件开头的 YAML frontmatter 块并返回正文。
 * 规则保守且确定：仅当首个字符（忽略 BOM）就是独立成行的 `---` 时才视为 frontmatter；
 * 找不到闭合分隔符时原样返回，绝不吞掉正文首行（`.cursorrules` 这类纯文本文件常见）。
 */
function stripFrontmatterBlock(content: string): string {
  const normalized = content.replace(/^\uFEFF/, '');
  const lines = normalized.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return normalized;
  for (let index = 1; index < lines.length; index += 1) {
    const delimiter = lines[index]!.trim();
    if (delimiter === '---' || delimiter === '...') return lines.slice(index + 1).join('\n');
  }
  return normalized;
}

/** 段落里的项目符号/编号标记不含语义，剥掉后再拼段，避免「1.」这类碎片成为描述。 */
const REFERENCE_LIST_MARKER = /^(?:[-*+]|\d{1,9}[.)])\s+/;

/**
 * 从正文里取「首个 ATX 标题」或「首个非空段落」，供 frontmatter 缺描述时兜底。
 * 跳过围栏代码块与分隔线，避免把代码注释或 `---` 当成描述；全程只做字符串扫描，不抛错。
 * 语义是「**先出现的结构元素胜出**」：正文首个非空块若是 ATX 标题就取标题，若是普通段落就取该段
 * （因此段落之后才出现的标题**不会**顶掉它）。命中即收束，同一份正文不会被读两遍语义。
 */
function probeReferenceBody(content: string): { heading?: string; paragraph?: string } {
  const lines = stripFrontmatterBlock(content).split(/\r?\n/);
  const paragraph: string[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const fenceMarker = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence !== null) {
      if (fenceMarker && fenceMarker[1]!.startsWith(fence)) fence = null;
      continue;
    }
    if (fenceMarker) {
      if (paragraph.length > 0) break;
      fence = fenceMarker[1]!.slice(0, 1);
      continue;
    }
    const heading = /^\s{0,3}#{1,6}(?:\s+(.*))?$/.exec(line);
    if (heading) {
      if (paragraph.length > 0) break;
      const text = (heading[1] ?? '').replace(/\s+#+\s*$/, '').trim();
      if (text) return { heading: text };
      continue;
    }
    if (!line.trim()) {
      if (paragraph.length > 0) break;
      continue;
    }
    // 分隔线与 setext 标题下划线（`===`/`---`/`***`/`___`）：不含语义，段落已开始时直接收束。
    if (/^\s{0,3}(?:=+|-{2,}|[*_]{3,})\s*$/.test(line)) {
      if (paragraph.length > 0) break;
      continue;
    }
    paragraph.push(line.trim().replace(REFERENCE_LIST_MARKER, ''));
  }
  return paragraph.length > 0 ? { paragraph: paragraph.join(' ') } : {};
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
      name:
        typeof rawName === 'string' && rawName.trim()
          ? rawName.trim()
          : fallbackName(sourcePath, type),
      ...(parsed.description ? { description: parsed.description } : {}),
    };
  }
  if (type === 'mcp') {
    try {
      const parsed = JSON.parse(content) as {
        mcpServers?: Record<string, unknown>;
        servers?: Record<string, unknown>;
      };
      const ids = Object.keys(parsed.mcpServers ?? parsed.servers ?? {}).sort();
      if (ids.length > 0)
        return { name: ids.length === 1 ? ids[0]! : `${ids[0]} +${ids.length - 1}` };
    } catch {
      // Invalid JSON is still surfaced as discovered metadata for the editor.
    }
  }
  if (type === 'agents-md' || type === 'rule') {
    // 规范类元数据只投递「地址 + 描述」，正文由 Agent 按需读取，因此描述必须在扫描期
    // 确定性地产出：禁止运行期让模型生成（会让 promptText 非确定，破坏 system 前缀稳定性）。
    // 优先级：frontmatter description > frontmatter title > 正文首个结构元素（先出现的 ATX 标题
    // 或非空段落；段落先出现时取首段首句，其后的标题不顶掉它 —— 见 `probeReferenceBody`）。
    const parsed = parseFrontmatter(content);
    const frontmatterTitle = parsed.frontmatter?.title;
    const fromFrontmatter =
      boundDescription(parsed.description ?? '') ??
      boundDescription(typeof frontmatterTitle === 'string' ? frontmatterTitle : '');
    if (fromFrontmatter) {
      return { name: fallbackName(sourcePath, type), description: fromFrontmatter };
    }
    const body = probeReferenceBody(content);
    const fromBody =
      boundDescription(body.heading ?? '') ??
      boundDescription(firstSentence(body.paragraph ?? ''));
    return {
      name: fallbackName(sourcePath, type),
      ...(fromBody ? { description: fromBody } : {}),
    };
  }
  return { name: fallbackName(sourcePath, type) };
}

/**
 * 裸 include 判定：整份内容只有 `@AGENTS.md` 一行。
 *
 * 宽松的只是**排版**（UTF-8 BOM、CRLF/LF、行首行尾空白、前后空行），不是语义 —— include 之外
 * 多写一个字就不再是指针，而是「内容副本」，而内容副本**必然**漂移。
 */
function isBareAgentsInclude(content: string): boolean {
  const lines = content
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.length === 1 && lines[0] === '@AGENTS.md';
}

/**
 * `CLAUDE.md` 与同目录 `AGENTS.md` 的别名判定：只有两种形态可接受 —— 逐字节相同，或
 * `CLAUDE.md` 是内容仅为 `@AGENTS.md` 一行的裸 include。
 *
 * 不假设哪一侧是权威：`CLAUDE.md` 为源、`AGENTS.md` 为逐字镜像的项目同样满足本判定
 * （逐字节相同），因此判定只看「关系是否合规」，不看方向。
 */
function isAcceptableClaudeAlias(claudeContent: string, agentsContent: string): boolean {
  return claudeContent === agentsContent || isBareAgentsInclude(claudeContent);
}

/**
 * 别名漂移**检测**（只告警，不修复）。
 *
 * 为什么需要它：`saga2_design/CLAUDE.md` 曾是同目录 `AGENTS.md` 的内容副本，长期落后两条硬规则
 * （2397 B vs 5259 B），任何读 Claude 侧的路径都静默拿到陈旧规则集，数月无人发现 —— 因为过去
 * 没有任何检查。这里只把漂移**摆到扫描期**：不改 `enabled`、不改 `description` / `name` /
 * `contentFingerprint` / `subProjectPath`，也不自动禁用、编辑或合并任何条目；怎么处置属于项目
 * 策展人（治理口径见 `docs/product-rules/meka-project-metadata-governance.md`）。
 *
 * 边界：
 * - 只在**同目录**找 `AGENTS.md`。同目录没有 `AGENTS.md` 时 `CLAUDE.md` 是合法独立条目，不存在
 *   别名关系，不告警；也不去父目录或别处找。
 * - 判定用扫描期已经读到的正文（`contents`），**不额外读盘**：正文不在手上就静默跳过，绝不因为
 *   任何缺失、权限或读取异常把整次扫描变成 reject。
 * - 告警只进 host 日志，不进 manifest，更不进注入给模型的参考列表。
 */
function warnOnDivergentClaudeAliases(
  root: string,
  items: readonly Pick<DiscoveredMekaProjectMetadata, 'itemType' | 'sourcePath'>[],
  contents: ReadonlyMap<string, string>,
): void {
  for (const item of items) {
    if (item.itemType !== 'agents-md') continue;
    if (path.posix.basename(item.sourcePath) !== 'CLAUDE.md') continue;
    const siblingPath = path.posix.join(path.posix.dirname(item.sourcePath), 'AGENTS.md');
    const claudeContent = contents.get(item.sourcePath);
    const agentsContent = contents.get(siblingPath);
    if (claudeContent === undefined || agentsContent === undefined) continue;
    if (isAcceptableClaudeAlias(claudeContent, agentsContent)) continue;
    try {
      log.warn(
        'Meka project CLAUDE.md does not alias its sibling AGENTS.md: make it a bare `@AGENTS.md` include, make it byte-identical, or accept the divergence deliberately and record the reason in that item\'s notes in the project metadata panel',
        {
          root,
          claudePath: path.join(root, item.sourcePath),
          agentsPath: path.join(root, siblingPath),
          claudeBytes: Buffer.byteLength(claudeContent, 'utf8'),
          agentsBytes: Buffer.byteLength(agentsContent, 'utf8'),
        },
      );
    } catch {
      // 告警是附带信息（dev 终端断开等会让写日志抛错），不得反过来把整次扫描带崩。
    }
  }
}

export async function discoverLocalMekaProjectMetadata(
  projectRoot: string,
  rgPath: string,
  additionalRoots: readonly string[] = [],
): Promise<DiscoveredMekaProjectMetadata[]> {
  if (!path.isAbsolute(projectRoot)) throw new Error('project root must be absolute');
  if (additionalRoots.some((root) => !path.isAbsolute(root))) {
    throw new Error('additional project roots must be absolute');
  }
  const primaryRoot = path.resolve(projectRoot);
  const rootKey = (root: string) =>
    process.platform === 'win32' ? path.normalize(root).toLowerCase() : path.normalize(root);
  const uniqueAdditionalRoots: string[] = [];
  const seenRoots = new Set([rootKey(primaryRoot)]);
  for (const additionalRoot of additionalRoots) {
    const root = path.resolve(additionalRoot);
    const key = rootKey(root);
    if (!seenRoots.has(key)) {
      seenRoots.add(key);
      uniqueAdditionalRoots.push(root);
    }
  }
  const roots = [
    { root: primaryRoot, rootPath: undefined as string | undefined },
    ...uniqueAdditionalRoots.map((root) => ({ root, rootPath: root })),
  ];
  const discovered = await Promise.all(
    roots.map(async ({ root, rootPath }) => {
      const listed = await listAllFiles({
        workdir: root,
        rgPath,
        globs: METADATA_SCAN_GLOBS,
      });
      if (listed.truncated) {
        throw new Error(`Meka project metadata scan was truncated: ${root}`);
      }
      const files = [
        ...new Set(listed.files.map(canonicalPath).filter((item): item is string => Boolean(item))),
      ].sort((a, b) => a.localeCompare(b));
      const candidates = files
        .map((sourcePath) => ({ sourcePath, itemType: metadataType(sourcePath) }))
        .filter(
          (item): item is { sourcePath: string; itemType: MekaProjectMetadataItemType } =>
            item.itemType !== null,
        );
      // 正文在扫描期只读一次：指纹与别名漂移检测共用同一份，检测因此不额外读盘。
      const contents = new Map<string, string>();
      const items = await Promise.all(
        candidates.map(async ({ sourcePath, itemType }) => {
          const content = (await readFile(root, sourcePath)).content;
          contents.set(sourcePath, content);
          return {
            itemType,
            sourcePath,
            ...(rootPath ? { rootPath } : {}),
            subProjectPath: inferMekaSubProjectPath(sourcePath, files),
            ...describe(sourcePath, itemType, content),
            contentFingerprint: createHash('sha256').update(content, 'utf8').digest('hex'),
          };
        }),
      );
      warnOnDivergentClaudeAliases(root, items, contents);
      return items;
    }),
  );
  return discovered.flat();
}
