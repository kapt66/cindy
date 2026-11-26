import type { DialogueDeviceTarget } from './dialogueCreateTarget';

export interface NewMakerDialogueTargetRequest {
  requestId: string;
  deviceId: string | null;
  deviceName: string | null;
  /** 通用新建只继承电脑；同机时保留草稿项目及用户选择。 */
  preserveWorkspaceIfSameDevice?: boolean;
}

export interface NewMakerFolderPickerRequest {
  requestId: string;
}

/**
 * 「远程工作区」侧栏 → 草稿页的一次性交接载荷（工作区级，无 PSB 会话 id）。
 *
 * 与 `features/remote-workspace/draft/psbDraftTarget.ts` 的 `PsbDraftRouteTarget` 同形；
 * 这里只做 navigation intent 的**校验视图**，构造/消费仍由那一层的纯函数负责。
 */
export interface NewMakerPsbRouteTarget {
  workspaceId: string;
  clientId: string;
  clientName: string;
  workspaceTitle: string;
  directoryName: string | null;
}

/**
 * 草稿页**一次性导航意图**（history state）。
 *
 * 收敛前三类路由动作各有一套字段 + reader + consumer（`dialogueTargetRequest` /
 * `folderPickerRequest` / `psbTarget`），路由里要记得给每一对写去重键、逐个删除。
 * 现在只有一个 union + 一对 reader/consumer：新增路由动作 = 加一个 variant，
 * 路由侧循环消费，不需要再三处对齐「谁先应用、谁删字段、后退怎么办」。
 */
export type NewMakerNavigationIntent =
  | ({ kind: 'dialogue' } & NewMakerDialogueTargetRequest)
  | ({ kind: 'folderPicker' } & NewMakerFolderPickerRequest)
  | ({ kind: 'psbTarget'; requestId: string } & NewMakerPsbRouteTarget);

/**
 * 路由 state 形状。
 *
 * 旧字段保留为**兼容读取**（旧窗口 / 旧浏览器记录仍可能带着它们进入新版本），新写入一律走
 * `newMakerIntent`。`workspacePrompt` 不是一次性指令，它是页面形态提示，跨前进/后退都保留。
 */
export interface NewMakerRouteState {
  workspacePrompt?: 'generic' | 'dialogue' | 'meka';
  newMakerIntent?: NewMakerNavigationIntent;
  /** @deprecated 由 `newMakerIntent` 取代；仅为旧路由记录兼容。 */
  dialogueTargetRequest?: NewMakerDialogueTargetRequest;
  /** @deprecated 由 `newMakerIntent` 取代；仅为旧路由记录兼容。 */
  folderPickerRequest?: NewMakerFolderPickerRequest;
  /** @deprecated 由 `newMakerIntent` 取代；仅为旧路由记录兼容。 */
  psbTarget?: NewMakerPsbRouteTarget;
}

/** A saved local default only fills a generic draft with no explicit target. */
export function shouldPrefillDefaultNewTaskWorkingDir(
  state: unknown,
  draft: {
    workingDir: string | null;
    explicitNoProject?: boolean;
    remoteHostId?: string | null;
    deviceLinkDeviceId?: string | null;
    /**
     * 远程工作区目标（含「已选渠道、还没选工作区」）。目标没有本地目录，但它是**一个明确的
     * 运行目标**，不是「没有目标」——默认目录不能盖掉它。`explicitNoProject` 不再兼任这个
     * 含义（那是用户显式选「对话」），所以这里单独判。
     */
    psbTarget?: unknown;
    psbChannelSelected?: boolean;
  },
): boolean {
  if (
    !state ||
    typeof state !== 'object' ||
    (state as NewMakerRouteState).workspacePrompt !== 'generic'
  ) {
    return false;
  }
  const request = readNewMakerDialogueTargetRequest(state);
  return (
    (!request || request.deviceId === null) &&
    !draft.workingDir &&
    !draft.explicitNoProject &&
    !draft.remoteHostId &&
    !draft.deviceLinkDeviceId &&
    !draft.psbTarget &&
    draft.psbChannelSelected !== true
  );
}


let dialogueTargetRequestSequence = 0;
let folderPickerRequestSequence = 0;
let psbTargetRequestSequence = 0;

/** These requests select local/device-link execution, never an SSH workspace. */
export function isSameNewMakerDevice(
  deviceId: string | null,
  draft: { deviceLinkDeviceId?: string | null; remoteHostId?: string | null },
): boolean {
  return !draft.remoteHostId && deviceId === (draft.deviceLinkDeviceId ?? null);
}

function readRequestId(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const requestId = (value as Record<string, unknown>).requestId;
  return typeof requestId === 'string' && requestId.length > 0 ? requestId : null;
}

/** 校验历史记录里的遥控工作区载荷（与 `psbDraftTarget.ts` 的 `PsbDraftRouteTarget` 同形）。 */
function parsePsbRouteTarget(value: unknown): NewMakerPsbRouteTarget | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const text = (input: unknown): string => (typeof input === 'string' ? input.trim() : '');
  const workspaceId = text(record.workspaceId);
  if (!workspaceId) return null;
  return {
    workspaceId,
    clientId: text(record.clientId),
    clientName: text(record.clientName),
    workspaceTitle: text(record.workspaceTitle),
    directoryName: text(record.directoryName) || null,
  };
}

function parseDialogueIntent(value: unknown): NewMakerNavigationIntent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const requestId = readRequestId(value);
  if (!requestId) return null;
  const deviceId = record.deviceId;
  const deviceName = record.deviceName;
  if (deviceId !== null && (typeof deviceId !== 'string' || deviceId.length === 0)) return null;
  if (deviceName !== null && typeof deviceName !== 'string') return null;
  if (deviceId === null && deviceName !== null) return null;
  return {
    kind: 'dialogue',
    requestId,
    deviceId,
    deviceName,
    ...(record.preserveWorkspaceIfSameDevice === true
      ? { preserveWorkspaceIfSameDevice: true }
      : {}),
  };
}

function parseIntent(value: unknown): NewMakerNavigationIntent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const kind = (value as Record<string, unknown>).kind;
  if (kind === 'dialogue') return parseDialogueIntent(value);
  if (kind === 'folderPicker') {
    const requestId = readRequestId(value);
    return requestId ? { kind: 'folderPicker', requestId } : null;
  }
  if (kind === 'psbTarget') {
    const target = parsePsbRouteTarget(value);
    if (!target) return null;
    const requestId = readRequestId(value) ?? `psb:${target.workspaceId}`;
    return { kind: 'psbTarget', requestId, ...target };
  }
  return null;
}

/**
 * 读**一次性导航意图**（唯一读口）。
 *
 * 优先读新格式 `newMakerIntent`；旧窗口 / 旧浏览器记录还带着三类旧字段时按同一顺序
 * （对话 → 目录选择器 → 远程工作区）归一，路由因此只需要消费一个 union。
 *
 * 后退/前进语义：意图在**应用后**由 {@link consumeNewMakerNavigationIntent} 从当前 history
 * entry 移除（route state 随 replace 写回）。后退到一条已经消费过的记录不会重放意图；
 * 生产者每次点击都生成新 `requestId`，所以「后退再前进」到一条**带着意图**的记录会重放一次
 * —— 这与用户重新点一次入口等价，是期望行为。
 */
export function readNewMakerNavigationIntent(state: unknown): NewMakerNavigationIntent | null {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
  const record = state as Record<string, unknown>;
  const written = parseIntent(record.newMakerIntent);
  if (written) return written;
  const dialogue = parseDialogueIntent(record.dialogueTargetRequest);
  if (dialogue) return dialogue;
  const folderRequestId = readRequestId(record.folderPickerRequest);
  if (folderRequestId) return { kind: 'folderPicker', requestId: folderRequestId };
  const psb = parsePsbRouteTarget(record.psbTarget);
  if (psb) return { kind: 'psbTarget', requestId: `psb:${psb.workspaceId}`, ...psb };
  return null;
}

/**
 * 应用后消费一个意图（唯一消费点）：把它从当前 history entry 移除，其它 route state 原样保留。
 *
 * 只删**这一条**：旧格式里同一个 entry 可能同时带着多个旧字段（历史版本叠加），其余字段留在
 * state 里等各自被消费，不会因为应用了对话意图就把远程工作区交接一起吞掉。
 */
export function consumeNewMakerNavigationIntent(
  state: unknown,
  intent: NewMakerNavigationIntent,
): unknown {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return state;
  const record = { ...(state as Record<string, unknown>) };
  let changed = false;
  const written = record.newMakerIntent;
  if (readRequestId(written) === intent.requestId) {
    delete record.newMakerIntent;
    changed = true;
  }
  const legacyKey =
    intent.kind === 'dialogue'
      ? 'dialogueTargetRequest'
      : intent.kind === 'folderPicker'
        ? 'folderPickerRequest'
        : 'psbTarget';
  const legacy = record[legacyKey];
  if (legacy !== undefined) {
    // 远程工作区旧载荷没有 requestId；只在没有新格式意图时消费它，避免误删另一个意图。
    const matches =
      intent.kind === 'psbTarget'
        ? written === undefined
        : readRequestId(legacy) === intent.requestId;
    if (matches) {
      delete record[legacyKey];
      changed = true;
    }
  }
  return changed ? record : state;
}

function makeIntentRequestId(prefix: string, sequence: number): string {
  return `${prefix}:${Date.now()}-${sequence}`;
}

/**
 * “对话”分组每次点击都生成新 requestId。同路由重复 navigate 不会 remount 创建页，
 * 但 location.state 会更新，创建页可据此再次执行完整 target transition。
 */
export function makeDialogueNewMakerRouteState(
  target: DialogueDeviceTarget | null,
): NewMakerRouteState & { newMakerIntent: NewMakerNavigationIntent } {
  dialogueTargetRequestSequence += 1;
  return {
    workspacePrompt: 'dialogue',
    newMakerIntent: {
      kind: 'dialogue',
      requestId: makeIntentRequestId('dialogue', dialogueTargetRequestSequence),
      deviceId: target?.deviceId ?? null,
      deviceName: target?.deviceName ?? null,
    },
  };
}

export function makeFolderPickerNewMakerRouteState(): NewMakerRouteState {
  folderPickerRequestSequence += 1;
  return {
    workspacePrompt: 'generic',
    newMakerIntent: {
      kind: 'folderPicker',
      requestId: makeIntentRequestId('picker', folderPickerRequestSequence),
    },
  };
}

/**
 * 远程工作区弹窗选定后 → 草稿页的一次性交接。
 *
 * `workspacePrompt: 'generic'` 必须带：草稿页的默认目录预填只对 generic 生效，而
 * {@link shouldPrefillDefaultNewTaskWorkingDir} 会因意图本身/PSB 目标而拒绝覆盖。
 */
export function makePsbTargetNewMakerRouteState(
  target: NewMakerPsbRouteTarget,
): NewMakerRouteState & { newMakerIntent: NewMakerNavigationIntent } {
  return {
    workspacePrompt: 'generic',
    newMakerIntent: {
      kind: 'psbTarget',
      // 同一个工作区可以被再次交接（用户又点了一次「新建任务」）；带上时间戳让每次交接
      // 都是新的意图，去重键不再需要路由自己用 `location.key` 拼。
      requestId: makeIntentRequestId(`psb:${target.workspaceId}`, (psbTargetRequestSequence += 1)),
      ...target,
    },
  };
}

/* ------------------------- 旧 API：兼容层（内部走唯一读写口） ------------------------- */

/** @deprecated 用 {@link readNewMakerNavigationIntent}；这里只保留旧调用方的窄视图。 */
export function readNewMakerFolderPickerRequest(
  state: unknown,
): NewMakerFolderPickerRequest | null {
  const intent = readNewMakerNavigationIntent(state);
  return intent?.kind === 'folderPicker' ? { requestId: intent.requestId } : null;
}

/** @deprecated 用 {@link consumeNewMakerNavigationIntent}。 */
export function consumeNewMakerFolderPickerRequest(state: unknown): unknown {
  const intent = readNewMakerNavigationIntent(state);
  return intent ? consumeNewMakerNavigationIntent(state, intent) : state;
}

/** @deprecated 用 {@link readNewMakerNavigationIntent}。 */
export function readNewMakerDialogueTargetRequest(
  state: unknown,
): NewMakerDialogueTargetRequest | null {
  const intent = readNewMakerNavigationIntent(state);
  if (intent?.kind !== 'dialogue') return null;
  return {
    requestId: intent.requestId,
    deviceId: intent.deviceId,
    deviceName: intent.deviceName,
    ...(intent.preserveWorkspaceIfSameDevice ? { preserveWorkspaceIfSameDevice: true } : {}),
  };
}

/**
 * dialogueTargetRequest 是一次性导航指令。首次应用后从当前 history entry 移除，避免用户
 * 浏览器后退到旧的 /cc-agent/new 记录时再次迁移草稿目标；其它 route state 必须原样保留。
 *
 * @deprecated 用 {@link consumeNewMakerNavigationIntent}。
 */
export function consumeNewMakerDialogueTargetRequest(state: unknown): unknown {
  const intent = readNewMakerNavigationIntent(state);
  return intent ? consumeNewMakerNavigationIntent(state, intent) : state;
}

