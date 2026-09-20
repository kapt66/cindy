/**
 * 注入层第 3 层：**落地**。
 *
 * 只做一件事：把 `MekaInjectionPlan` 写进 maker.createSession opts。不解析、不做 I/O、
 * 不重算结果（`plan.result` 由解析阶段给出）。
 *
 * 关键不变量：
 * - 段落按 `order` 升序拼接后**一次性 prepend**，与重构前「7 次 `prependPromptSection`、
 *   后 prepend 者更靠前」逐字节等价（trim + 丢空段 + `\n\n` 连接）。
 * - 同一批段落的 `id` 必须唯一（`renderMekaPromptSegments` 只读断言）。
 * - `vendorOptions` 只做一次 spread，`plan.vendorOptionsPatch` 的键插入顺序就是现状的键
 *   插入顺序（I2：下游 `combatWorkflowPolicy.ts` / `meka-runtime-mcp.ts` 按这些键裁决）。
 * - 补丁为空时不写 `opts.vendorOptions`，保持对象引用不变（与现状一致）。
 */

import type { MakerSessionCreateOpts } from '../maker-ipc/sessionRequest.js';
import type {
  AppliedMekaRuntimeConfig,
  MekaInjectionPlan,
  MekaInjectionResult,
  MekaPromptSegment,
  MekaPromptSegmentId,
} from './types.js';

/** 非 Meka / 不适用的空结果（与重构前 `emptyResult()` 逐字段一致）。 */
export function emptyMekaRuntimeResult(): AppliedMekaRuntimeConfig {
  return {
    didApply: false,
    mcpProviderIds: [],
    inlineMcpCount: 0,
    skillsCount: 0,
    platformSkillsCount: 0,
    skillSnapshot: null,
    workflow: null,
    workflowRecoveredFromRole: false,
    combatEnvironmentReady: null,
  };
}

/**
 * 与重构前 `prependPromptSection` 同义：section trim 后放到 existing 之上，用 `\n\n`
 * 连接，空串被丢弃（`existing` 非字符串按空串处理）。
 */
function prependPromptSection(existing: unknown, section: string): string {
  const trimmedSection = section.trim();
  const existingPrompt = typeof existing === 'string' ? existing.trim() : '';
  return [trimmedSection, existingPrompt].filter(Boolean).join('\n\n');
}

/**
 * 按 `order` 升序渲染段落并 prepend 到调用方原始 prompt 之上。
 *
 * 返回 null = 没有任何非空段落 ⇒ **不写** `opts.userPrompt`（保持调用方原值，包括空白）。
 * 抛错 = 同一批段落里 `id` 重复（只读防线，见函数体内注释）。
 */
export function renderMekaPromptSegments(
  existing: unknown,
  segments: readonly MekaPromptSegment[],
): string | null {
  // 只读检查（不改渲染结果）：同一批段落里 `id` 必须唯一。
  //
  // 为什么必须钉住：`order` 并列时 `sort` 是稳定的（保持 push 次序 = 后者更靠后），
  // 而重构前的 prepend 语义是「后 prepend 者更靠前」—— 两者方向相反。于是同一批里
  // 出现重复 id 时，整组段的最终次序会被静默反转，且没有任何断言能看出来。
  // 现状下每个 id 每条路径最多 push 一次（见 `resolvePlan.ts`），所以这里是纯防线。
  const seenSegmentIds = new Set<MekaPromptSegmentId>();
  for (const segment of segments) {
    if (seenSegmentIds.has(segment.id)) {
      throw new Error(`duplicate Meka prompt segment id: ${segment.id}`);
    }
    seenSegmentIds.add(segment.id);
  }
  const rendered = [...segments]
    .sort((left, right) => left.order - right.order)
    .map((segment) => segment.text.trim())
    .filter(Boolean)
    .join('\n\n');
  if (!rendered) return null;
  return prependPromptSection(existing, rendered);
}

/** 形态 A 的落地：只写 opts，原样返回解析阶段确定的 result。 */
export function applyMekaInjection(
  opts: MakerSessionCreateOpts,
  plan: MekaInjectionPlan,
): MekaInjectionResult {
  if (plan.sessionBindingPatch) Object.assign(opts, plan.sessionBindingPatch);

  const writeVendorOptions = (): void => {
    if (!plan.rewriteVendorOptions && Object.keys(plan.vendorOptionsPatch).length === 0) return;
    opts.vendorOptions = { ...(opts.vendorOptions ?? {}), ...plan.vendorOptionsPatch };
  };
  const writeUserPrompt = (): void => {
    const userPrompt = renderMekaPromptSegments(opts.userPrompt, plan.promptSegments);
    if (userPrompt !== null) opts.userPrompt = userPrompt;
  };
  const writeNativeSkill = (): void => {
    if (!plan.nativeSkill) return;
    opts.nativeSkillPluginPath = plan.nativeSkill.pluginPath;
    opts.nativeSkillRevision = plan.nativeSkill.revision;
  };

  // 写入次序：它决定 `opts` 键的**插入顺序**（`Object.keys(opts)` 的先后）。
  // - 常规创建路径：三个写入的**相对次序**与重构前一致（快照 → prompt → vendorOptions）。
  // - resume 短路路径：**与重构前不同**。重构前快照（`nativeSkillPluginPath` /
  //   `nativeSkillRevision`）夹在早段 prompt 写入与尾段 controller prompt 写入**之间**
  //   （原 `mekaRuntimeInjection.ts:501-502` 在前、`:505` 的 `injectCombatControllerSkill`
  //   在后），这里统一移到最后。于是在「只有 controller 段会写 prompt」（`opts.userPrompt`
  //   键缺省、无 `workingDir`、exec mode 已是 autonomous、无合法技能 ID）这类输入下，
  //   `Object.keys(opts)` 的新增键顺序是 `userPrompt → nativeSkillPluginPath →
  //   nativeSkillRevision`，重构前是 `nativeSkillPluginPath → nativeSkillRevision →
  //   userPrompt`。
  //   **该差异不可观测**：全仓没有任何消费者枚举 `opts` 的键（只有 `{...opts}` 扩散与
  //   命名字段访问）。因此这里只保证「同一路径内三个写入的相对次序与重构前一致」，
  //   不保证跨写入阶段的键插入顺序。
  if (plan.frozen) {
    writeVendorOptions();
    writeUserPrompt();
    writeNativeSkill();
  } else {
    writeNativeSkill();
    writeUserPrompt();
    writeVendorOptions();
  }
  return plan.result;
}
