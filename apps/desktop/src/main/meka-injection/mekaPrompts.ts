/**
 * Meka 注入段的**文本唯一来源**：平台四段里的三段由本文件承载。
 *
 * 平台注入面（order 见 `mekaInjectionTypes.ts` 的 `MEKA_PROMPT_SEGMENT_ORDER`）：
 * - 55 `meka.submit-intent` —— `mekaSubmitIntentPrompt`（本文件；提交意图 → 工具发现优先的硬顺序规则）
 * - 60 `meka.role-context` —— `roleContextPrompt`（本文件）
 * - 65 `meka.project-references` —— `mekaProjectReferencesPrompt`（本文件）
 * - 70 `meka.role-prompt` —— 角色 `promptText`，由 `meka-projects/runtimeConfig.ts` 产出，
 *   本文件不参与
 *
 * 本文件里的函数都是从 `maker-ipc/mekaRuntimeInjection.ts` **原样搬迁**的纯函数：没有 I/O、
 * 不碰 opts、不读 deps。因此「注入文本逐字节不变」（I1）的评审范围可以只看本文件；任何新段
 * 同样必须从本文件取文本，不得在别处再拼一份。
 *
 * 段落之间的分隔统一是 `\n\n`（由 applyPlan 渲染），段内分隔是 `\n`（各构建器 join）。
 * 改动任何一个字符都会破坏 system prompt 前缀稳定性（maker-core-and-agent-behavior.md
 * §3.1/§4），属于必须 owner 确认的改动。
 */

import type { MekaProjectReference } from '../../shared/meka-projects.js';
import type { MekaRuntimeConfig } from '../meka-projects/runtimeConfig.js';

export function roleContextPrompt(runtime: MekaRuntimeConfig): string {
  return [
    '[MEKA_ROLE_CONTEXT]',
    `projectId: ${runtime.projectId}`,
    `roleId: ${runtime.roleId}`,
    `displayName: ${runtime.roleDisplayName}`,
    '这是当前任务的权威角色绑定。不得根据打开的窗口、缓存文件或其它项目角色推断或替换当前角色。',
    '[/MEKA_ROLE_CONTEXT]',
  ].join('\n');
}

/** 提交意图段的 marker（正向断言段落存在、反向断言非 Meka / frozen 路径不在场都用它）。 */
export const MEKA_SUBMIT_INTENT_MARKER = '[MEKA_SUBMIT_INTENT]';

/**
 * 提交意图段（段 id `meka.submit-intent`，order 55）。
 *
 * 修的是真实会话里的一条失败链（Pi harness，用户只说「帮我提交模块表定义」）：模型先跑了
 * 13 次 `bash`、2 次 `read`、1 次 `grep`（全盘找 memory、探测 p4 CLI、全仓 grep「模块定义」），
 * **0 次**插件发现调用（`cindy_mcp_list_tools` / `ghost_info` / `ghost_call`），直到 turn 被
 * abort 都没发出真实提交调用；thinking 里已经知道「应该走 meka-submit 插件」，说明缺的不是
 * 插件可见性，而是「提交意图 ⇒ 先走插件流程」的硬顺序。同一 harness 里用户明确点名插件时
 * 第一反应就是 `cindy_mcp_list_tools`，因此这条规则只补顺序，不补能力。
 *
 * 三条契约：
 * - **文本是固定常量**：不读 deps、不做 I/O、不含时间/随机值 ⇒ 会话前缀逐字节稳定（§3.1）。
 *   行数固定 7，测试逐行断言，改字必须同时改用例与 `docs/dev-rules/meka-injection-layer.md` §3.3。
 * - **工具名先后即语义**：`cindy_mcp_list_tools → ghost_info → meka-submit` 的先后不得改序；
 *   「拿到插件流程前禁止 p4 / git CLI 与全仓 find / grep」是这条段的风险边界。
 * - **只在 Meka 会话的 bootstrap 路径注入**（与 60 / 65 / 70 同进同出，I4 / I6），文本本身
 *   与项目/角色无关，因此不参与 `runtimeConfig` 的解析。
 */
export function mekaSubmitIntentPrompt(): string {
  return [
    MEKA_SUBMIT_INTENT_MARKER,
    '用户说「提交 / 提交代码 / 提交改动 / 提交服务器 / 推送建 MR」时，第一步固定是工具发现，不是探测：',
    '工具发现先确认本机插件清单（Pi 经 cindy_mcp_list_tools 网关；Claude/Codex 直连本机插件的 MCP 工具），再 ghost_info(meka-submit) → ghost_call 调 meka-submit 的 list_tools，拿到该插件流程后再动手。若当前会话没有 meka-submit 插件（它是市场安装插件、不随包），如实告知用户，并按用户确认改用本机 CLI 或既有流程，不得假装插件可用。',
    '拿到插件流程前，禁止用 p4 / git 等 CLI 探测或执行提交，禁止用全仓 find / grep 猜要提交什么。',
    '提交对象只可能是「已存在的改动」：先确定改动来源再谈范围——P4 项目用 meka-p4 的 p4_status（pending changelists / 未 open 改动）；远程 Git 项目用 MCPRouter 的 mcpr-project-manager 的 git_status（工作树未提交改动）。',
    '文件名词（例如「模块表定义」）先在改动清单里模糊匹配；匹配不到就问用户，不得改用全仓 grep 去找。',
    '[/MEKA_SUBMIT_INTENT]',
  ].join('\n');
}

/** 项目参考文件清单段的 marker（正向断言段落存在、反向断言正文不在场都用它）。 */
export const MEKA_PROJECT_REFERENCES_MARKER = '[MEKA_PROJECT_REFERENCES]';

/** `scope === ''` 的显示形态：空字段会被读成「没有范围」，必须显式写成项目根。 */
const MEKA_PROJECT_REFERENCES_ROOT_SCOPE_LABEL = '(项目根)';

/**
 * 项目参考文件清单段（段 id `meka.project-references`，order 65）。
 *
 * **只投递「作用范围 + 绝对路径 + 描述」，正文一律不进 prompt**（渐进披露）。正文内联会把
 * system 前缀推到 Pi 的 argv 预算之外（win32 30,000 字符 ⇒ 新建会话直接失败），这是该段
 * 采用「给地址不给正文」形态的唯一动机。
 *
 * 三条契约：
 * - **空集合返回 null**（完全不入 plan），与「`meka.role-prompt` 文本为空则不入 plan」同口径。
 * - **不排序、不去重**：顺序由 `MekaRuntimeConfig.projectReferences` 的生产方（`runtimeConfig.ts`
 *   的 `compareProjectReferences`，scope → path）决定，本函数只渲染。
 * - 段文本是**唯一常量**：第 2–3 行是两条独立成行的规则（之间恰好一个 `\n`，不是排版折行），
 *   随后是 N 行 `- <scope> | <path> | <description>`，总行数 = 6 + N。测试与文档共用本函数，
 *   不得在别处再拼一遍（含末行闭合 marker）。
 */
export function mekaProjectReferencesPrompt(
  references: readonly MekaProjectReference[],
): string | null {
  if (references.length === 0) return null;
  return [
    MEKA_PROJECT_REFERENCES_MARKER,
    '项目参考文件按作用范围列出。当你的工作涉及某个作用范围内（该目录及其子目录）的内容时，',
    '必须先用原生文件读取工具（read）完整读取该范围内列出的文件，再动手；不要凭记忆、缓存或旧版内容替代。',
    '每条格式：作用范围 | 绝对路径 | 用途',
    ...references.map(
      (reference) =>
        `- ${
          reference.scope === '' ? MEKA_PROJECT_REFERENCES_ROOT_SCOPE_LABEL : reference.scope
        } | ${reference.path} | ${reference.description}`,
    ),
    '不要读取、枚举或发现本清单未列出的 AGENTS.md / .cursorrules / rules.md；技能正文（SKILL.md）按技能目录正常按需读取；不要根据项目根目录二次拼接或猜测其它路径。',
    '[/MEKA_PROJECT_REFERENCES]',
  ].join('\n');
}
