/**
 * PSB 远程工作区的 IPC 面（renderer ↔ main）。
 *
 * ## 约定（与仓库既有 IPC 规则一致）
 *
 * - 通道名只用共享契约的 `PSB_REMOTE_CHANNELS`，不在这里写字符串；
 * - 每个 handler 先 `assertTrustedAppRendererEvent`（子 frame / WebView / 导航走的窗口一律拒），
 *   再校验 payload，**校验通过才产生副作用**；
 * - 失败一律 `throwIpcError`：码用共享契约的 `PSB_` 命名空间失败码（`psbIpcCodeForFailure`，
 *   渲染层据此映射 i18n 键；协议错 / 未知码落通用 `INTERNAL`），`message` 只放 PSB 原文或
 *   占用人名做兜底与诊断。**message 不含 token、Authorization 或身份字段。**
 * - 返回值形状由共享 DTO `satisfies` 锁住（`{ workspaces }` / `{ workspace }` / `{ status }`），
 *   与渲染层 `PsbRemoteBridge` 一致——并行开发时这里最容易漂。
 * - 推送（帧 / 状态 / 工作区变更）只经 `push.ts` 发给受信窗口，不在这里 `webContents.send`。
 */

import { ipcMain, shell } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';

import {
  PSB_AGENT_KINDS,
  PSB_REMOTE_CHANNELS,
  PSB_SESSION_RELEASE_REASONS,
  psbIpcCodeForFailure,
  type PsbCreateWorkspaceResult,
  type PsbListClientsResult,
  type PsbListTemplatesResult,
  type PsbListWorkspacesResult,
  type PsbOccupyWorkspaceResult,
  type PsbPendingWorkspaceReleasesResult,
  type PsbPendingWorkspaceReleasesRetryResult,
  type PsbSessionWorkspaceReleaseResult,
} from '../../shared/psb-remote-workspace.js';
import {
  PSB_ADMIN_CHANNELS,
  validatePsbStreamInputEvent,
  type PsbWorkspaceAdminContextResult,
  type PsbWorkspaceAdminStreamStartResult,
  type PsbWorkspaceAdminStreamStatusResult,
} from '../../shared/psb-workspace-admin.js';
import {
  WORKSPACE_VCS_ACTION_KINDS,
  type PsbRunWorkspaceVcsActionResponse,
  type PsbWorkspaceVcsNoticeResult,
} from '../../shared/psb-workspace-vcs.js';
import { isIpcError } from '../../shared/ipc-errors.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import {
  optionalString,
  requireBoolean,
  requireEnum,
  requireNullableString,
  requireObject,
  requireString,
  throwIpcError,
} from '../utils/ipcValidate.js';
import { getPsbWorkspaceAdminService } from './adminRuntime.js';
import { PsbClientError, toPsbRemoteFailure } from './psbClient.js';
import { normalizePsbWebUrl } from './psbEndpoint.js';
import { getPsbRemoteService, type PsbRemoteService } from './index.js';
import {
  broadcastPsbPendingReleasesChanged,
  broadcastPsbWorkspaceChanged,
} from './push.js';
import {
  listPendingWorkspaceReleases,
  onPendingWorkspaceReleasesChanged,
  releasePsbWorkspaceForSession,
  retryPendingWorkspaceReleases,
} from '../maker-host/psb-workspace-session-release.js';
import {
  registerPsbAdminStreamOwner,
  releasePsbAdminStreamOwner,
  releasePsbStreamFrameOwnersForWebContents,
} from './push.js';
import { updatePsbStreamCapture } from './streamCaptureRuntime.js';
import { createPsbStreamOwnerRegistry } from './streamOwners.js';

/**
 * 失败形状 → IPC 错误。
 *
 * 外层码用共享契约给出的 `PSB_` 命名空间失败码：跨进程只能保留 message，语义必须由码名承载
 * （见 `shared/psb-remote-workspace.ts` §8）。message 只放 PSB 原文 / 占用人名做兜底与诊断，
 * **不含** token、Authorization 或身份字段。参数/来源校验抛出的 `IpcError` 已经带码，原样透传
 * （不要二次改写掩掉 `INVALID_PARAMS`）。
 */
function throwPsbFailure(error: unknown): never {
  if (isIpcError(error)) throw error;
  const failure = toPsbRemoteFailure(error);
  // 协议错 / 未知码不是可行动的用户失败：落通用 INTERNAL，只带诊断原文。
  throwIpcError(psbIpcCodeForFailure(failure) ?? 'INTERNAL', failure.message ?? '');
}

function handleInvoke(
  channel: string,
  handler: (event: IpcMainInvokeEvent, payload: unknown) => unknown,
): void {
  ipcMain.handle(channel, async (event, payload: unknown) => {
    assertTrustedAppRendererEvent(event);
    try {
      return await handler(event, payload);
    } catch (error) {
      throwPsbFailure(error);
    }
  });
}

/** 允许缺省或在空对象外多传字段：只在真正用到的字段上做校验。 */
function readOptionalBody(payload: unknown): Record<string, unknown> {
  if (payload === undefined || payload === null) return {};
  return requireObject(payload);
}

function readWorkspaceRef(payload: unknown): { workspaceId: string } {
  const body = requireObject(payload);
  return { workspaceId: requireString(body['workspaceId'], 'workspaceId') };
}

function readSessionRef(payload: unknown): { sessionId: string } {
  const body = requireObject(payload);
  return { sessionId: requireString(body['sessionId'], 'sessionId') };
}

function readOptionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throwIpcError('INVALID_PARAMS', `${name} must be a boolean`);
  return value;
}

function readStringArray(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string' && entry)) {
    throwIpcError('INVALID_PARAMS', `${name} must be a string array`);
  }
  return value as string[];
}

/**
 * 校验一条待转发的键鼠输入事件（形状 + 帧大小）。
 *
 * 为什么在 IPC 边界就拒绝：这条通道后面是一条**共享中继**（PSB 网页观看端与 Cindy 共用）。
 * 渲染层一次 bug（把任意消息塞进 `event`）就会变成「向别人的观看端注入垃圾帧」，服务端只会
 * 把它计成非法消息。规则本身放在共享契约里（`validatePsbStreamInputEvent`），渲染层采集后
 * 也能用同一份判据自检。
 */
function readStreamInputEvent(value: unknown): Record<string, unknown> {
  const validation = validatePsbStreamInputEvent(value);
  if (!validation.ok) {
    throwIpcError('INVALID_PARAMS', `invalid stream input event: ${validation.reason}`);
  }
  return validation.event;
}

/* ------------------------- 管理页串流：多窗口引用计数 ------------------------- */

/**
 * 管理页串流的多窗口账本：`workspaceId → Set<webContentsId>`。
 *
 * 管理页的观看端是**工作区级绑定**（每个工作区一条观看连接，由 main 解析 viewerSessionId）。
 * 旧实现 `Map<workspaceId, webContentsId>` 只记「最后一个启动者」：A 先看、B 再看，A 关面板
 * 就会把 B 的画面一起停掉；窗口销毁时还会重复停流。正确语义是**最后离开者关灯**：
 * start = +1，stop / 窗口销毁 = -1，只有归零才真正 `streamStop`（PSB 观看名额与网页端共用，
 * 泄漏一个名额别人就连不上）。
 *
 * 帧的定向投递另有一本账（`push.ts` 的 `adminStreamFrameOwners`）：它按 viewerSessionId 记，
 * 因为帧事件的 `sessionId` 是观看端会话 id，不是 workspaceId。
 */
const adminStreamOwners = createPsbStreamOwnerRegistry();
/** 工作区 → 最近一次启动得到的 viewerSessionId（窗口销毁时用来注销帧 owner）。 */
const adminViewerSessionByWorkspace = new Map<string, string>();
/** 已挂过窗口 `destroyed` 监听的 webContents.id。 */
const watchedAdminSenders = new Set<number>();

/**
 * 「启动还在路上时这个窗口已经请求停止」的标记（`workspaceId + ownerId`）。
 *
 * 为什么需要（2026-11-27 复审 P1「starting 相位卸载僵尸订阅」）：渲染层在 `starting` 相位卸载
 * （或用户快速点停止）时会发 `STREAM_STOP`，但那条 `STREAM_START` 还可能正在 PSB 里飞、owner
 * 还没登记 —— 此时 `untrackAdminStreamOwner` 是 no-op，停止就丢了；等启动落定后 ipc 再
 * `trackAdminStreamOwner`，owner 与流都会永久残留（渲染层已卸载，没人再来释放）。
 *
 * 所以 `STREAM_STOP` 先落标记；`STREAM_START` 落定后消费它：**不登记 owner**，并按「最后离开者」
 * 判据把刚起来的流收掉（可能已经没有任何观看者）。每个窗口的新一轮启动在入口清掉上一轮的旧
 * 标记，窗口销毁时也清一次。
 */
const adminStreamReleasePending = new Set<string>();

/** 标记 key：「工作区 + 窗口」唯一；不依赖分隔符出现在 id 里（workspaceId 是 PSB id）。 */
function adminStreamReleaseKey(workspaceId: string, ownerId: number): string {
  return `${workspaceId}\u0000${ownerId}`;
}

function requestAdminStreamRelease(workspaceId: string, ownerId: number): void {
  adminStreamReleasePending.add(adminStreamReleaseKey(workspaceId, ownerId));
}

/** 消费（清掉并返回是否存在）该窗口的停止标记；只对当前这一次启动生效。 */
function consumeAdminStreamRelease(workspaceId: string, ownerId: number): boolean {
  return adminStreamReleasePending.delete(adminStreamReleaseKey(workspaceId, ownerId));
}

/** 窗口销毁：清掉它所有工作区的停止标记（否则下一次启动会被误判成「已取消」）。 */
function clearAdminStreamReleaseForOwner(ownerId: number): void {
  const suffix = `\u0000${ownerId}`;
  for (const key of [...adminStreamReleasePending]) {
    if (key.endsWith(suffix)) adminStreamReleasePending.delete(key);
  }
}

/**
 * 登记「这个窗口在看这个工作区的串流」。
 *
 * `viewerSessionId` 来自 `streamStart` 的返回值：它是帧事件的 `sessionId`。ping（重复 start）
 * 不会重复计数（Set 语义），因此同一个窗口重复点启动不会把计数刷高。
 */
function trackAdminStreamOwner(
  workspaceId: string,
  viewerSessionId: string,
  event: IpcMainInvokeEvent,
): void {
  const sender = event.sender;
  adminStreamOwners.add(workspaceId, sender.id);
  adminViewerSessionByWorkspace.set(workspaceId, viewerSessionId);
  registerPsbAdminStreamOwner(viewerSessionId, sender.id);
  if (watchedAdminSenders.has(sender.id)) return;
  watchedAdminSenders.add(sender.id);
  sender.once('destroyed', () => {
    watchedAdminSenders.delete(sender.id);
    // 窗口已经不在了：残留的「启动在途停止」标记也一并清掉（否则同 id 复用时会被误读）。
    clearAdminStreamReleaseForOwner(sender.id);
    // 窗口销毁兜底：清掉它登记的帧 owner；真正归零的工作区才停流。
    releasePsbStreamFrameOwnersForWebContents(sender.id);
    for (const workspaceId of adminStreamOwners.removeOwner(sender.id)) {
      const viewerSessionId = adminViewerSessionByWorkspace.get(workspaceId);
      adminViewerSessionByWorkspace.delete(workspaceId);
      if (viewerSessionId) releasePsbAdminStreamOwner(viewerSessionId, sender.id);
      void getPsbWorkspaceAdminService()
        .streamStop(workspaceId)
        .catch(() => {
          /* 窗口已经销毁：这里没有可报错的界面，连接自身也会随 socket 断开而收尸 */
        });
    }
  });
}

/**
 * 注销「这个窗口在看这个工作区的串流」；**返回是否应当真正停流**（最后一个离开者）。
 */
function untrackAdminStreamOwner(workspaceId: string, ownerId: number): boolean {
  const viewerSessionId = adminViewerSessionByWorkspace.get(workspaceId);
  if (viewerSessionId) releasePsbAdminStreamOwner(viewerSessionId, ownerId);
  const shouldStop = adminStreamOwners.remove(workspaceId, ownerId);
  if (shouldStop) adminViewerSessionByWorkspace.delete(workspaceId);
  return shouldStop;
}

/**
 * 注销 owner，并在**该工作区已没有任何观看者**时真的停流；返回是否发起了停止。
 *
 * 与 `untrackAdminStreamOwner` 的分工：那个回答「这次移除是不是最后一个离开者」（要求该窗口
 * 在账本里）；这里回答「移除之后还有没有人在看」—— 启动在途被取消时 owner 从未登记，但流可能
 * 已经被启动起来，必须按「没有观看者」收掉，否则就是一条没人认领的观看连接（占 PSB 名额、
 * 也让下一次启动误以为还能复用）。
 */
async function dropAdminStreamOwner(
  workspaceId: string,
  ownerId: number,
  localSessionId: string | null,
): Promise<boolean> {
  untrackAdminStreamOwner(workspaceId, ownerId);
  if (adminStreamOwners.owners(workspaceId).length > 0) return false;
  // 账本已归零：帧 owner 映射也一起清掉（没有观看者时留着只会指向一条不属于任何窗口的连接）。
  adminViewerSessionByWorkspace.delete(workspaceId);
  await getPsbWorkspaceAdminService().streamStop(workspaceId, { localSessionId });
  return true;
}

/**
 * `adminService` 的**窗口维度**入参（FIX-B 新增的可选第二参，见其接口变更预告）。
 *
 * 用窄化结构而不是直接依赖 `adminService` 的新签名：两边并行改动时不会互相卡编译；
 * 对方落地后这里可以直接删掉（调用形状一致）。
 */
interface PsbAdminWindowAwarePort {
  context(input: {
    readonly localSessionId: string | null;
  }): Promise<PsbWorkspaceAdminContextResult>;
  streamStart(
    workspaceId: string,
    options?: { readonly localSessionId?: string | null },
  ): Promise<PsbWorkspaceAdminStreamStartResult>;
  streamStop(
    workspaceId: string,
    options?: { readonly localSessionId?: string | null },
  ): Promise<void>;
  streamStatus(
    workspaceId: string,
    options?: { readonly localSessionId?: string | null },
  ): Promise<PsbWorkspaceAdminStreamStatusResult>;
  streamInput(workspaceId: string, event: Record<string, unknown>): Promise<void>;
}

export function registerPsbRemoteIpc(
  resolveService: () => PsbRemoteService = getPsbRemoteService,
): void {
  // 每次调用现取单例：账号边界会 dispose 服务（断开串流），下次动作要拿到重新装配的新实例，
  // 而不是一个已 dispose 的旧对象（那会让串流在本进程内永久不可用）。
  const service = (): PsbRemoteService => resolveService();

  handleInvoke(PSB_REMOTE_CHANNELS.STATUS, () => service().status());

  // 返回值形状必须与渲染层 `PsbRemoteBridge` 一一对应（`{ workspaces }` 而不是裸数组）：
  // 两侧并行开发时最容易漂的就是这一层，`satisfies` 让形状由共享 DTO 锁住。
  handleInvoke(PSB_REMOTE_CHANNELS.LIST_WORKSPACES, async (_event, payload) => {
    const body = readOptionalBody(payload);
    const clientId = optionalString(body['clientId']);
    const readyOnly = readOptionalBoolean(body['readyOnly'], 'readyOnly');
    const workspaces = await service().listWorkspaces({
      ...(clientId === undefined ? {} : { clientId }),
      ...(readyOnly === undefined ? {} : { readyOnly }),
    });
    return { workspaces } satisfies PsbListWorkspacesResult;
  });

  handleInvoke(PSB_REMOTE_CHANNELS.LIST_CLIENTS, async () => {
    const clients = await service().listClients();
    return { clients } satisfies PsbListClientsResult;
  });

  handleInvoke(PSB_REMOTE_CHANNELS.LIST_TEMPLATES, async () => {
    const templates = await service().listProjectTemplates();
    return { templates } satisfies PsbListTemplatesResult;
  });

  handleInvoke(PSB_REMOTE_CHANNELS.CREATE_WORKSPACE, async (_event, payload) => {
    const body = requireObject(payload);
    const title = optionalString(body['title']);
    const workspace = await service().createWorkspace({
      clientId: requireString(body['clientId'], 'clientId'),
      templateKey: requireString(body['templateKey'], 'templateKey'),
      ...(title === undefined ? {} : { title }),
    });
    return { workspace } satisfies PsbCreateWorkspaceResult;
  });

  handleInvoke(PSB_REMOTE_CHANNELS.OCCUPY_WORKSPACE, async (_event, payload) => {
    const workspace = await service().occupyWorkspace(readWorkspaceRef(payload).workspaceId);
    return { workspace } satisfies PsbOccupyWorkspaceResult;
  });

  handleInvoke(PSB_REMOTE_CHANNELS.RELEASE_WORKSPACE, async (_event, payload) => {
    const workspace = await service().releaseWorkspace(readWorkspaceRef(payload).workspaceId);
    return { workspace } satisfies PsbOccupyWorkspaceResult;
  });

  /* ---------------------- CINDY-RW-10：占用/释放的版本控制检查 ---------------------- */

  // 为什么这组通道存在：占用 / 解除占用被版本控制检查拒绝时，PSB 的 `details.vcs` 里有
  // `projects` 与可执行 `actions`，而 invoke 抛错跨进程只保留 code+message。main 在抛错前已把
  // notice 写进有界缓存并广播；渲染层用这两个通道兜底读取 + 执行处置动作（只传 kind，
  // method/path/body 由 main 从缓存取，绝不接受渲染层自报 URL）。
  handleInvoke(PSB_REMOTE_CHANNELS.WORKSPACE_VCS_NOTICE_GET, (_event, payload) => {
    const { workspaceId } = readWorkspaceRef(payload);
    const notice = service().readWorkspaceVcsNotice(workspaceId);
    return { workspaceId, notice } satisfies PsbWorkspaceVcsNoticeResult;
  });

  handleInvoke(PSB_REMOTE_CHANNELS.WORKSPACE_VCS_ACTION, async (_event, payload) => {
    const body = requireObject(payload);
    const workspaceId = requireString(body['workspaceId'], 'workspaceId');
    const kind = requireEnum(body['kind'], WORKSPACE_VCS_ACTION_KINDS, 'kind');
    const confirm = body['confirm'];
    if (confirm !== undefined && typeof confirm !== 'boolean') {
      throwIpcError('INVALID_PARAMS', 'confirm must be a boolean');
    }
    const result = await service().runWorkspaceVcsAction({
      workspaceId,
      kind,
      ...(confirm === undefined ? {} : { confirm }),
    });
    return result satisfies PsbRunWorkspaceVcsActionResponse;
  });

  handleInvoke(PSB_REMOTE_CHANNELS.CREATE_SESSION, (_event, payload) => {
    const body = requireObject(payload);
    const title = optionalString(body['title']);
    return service().createSession({
      workspaceId: requireString(body['workspaceId'], 'workspaceId'),
      agentKind: requireEnum(body['agentKind'], PSB_AGENT_KINDS, 'agentKind'),
      clientRequestId: requireString(body['clientRequestId'], 'clientRequestId'),
      ...(title === undefined ? {} : { title }),
    });
  });

  handleInvoke(PSB_REMOTE_CHANNELS.REFRESH_WORKSPACES, async (_event, payload) => {
    const body = readOptionalBody(payload);
    const workspaceIds = readStringArray(body['workspaceIds'], 'workspaceIds');
    const workspaces = await service().listWorkspaces();
    const filtered =
      workspaceIds === undefined
        ? workspaces
        : workspaces.filter((workspace) => workspaceIds.includes(workspace.id));
    return { workspaces: filtered } satisfies PsbListWorkspacesResult;
  });

  handleInvoke(PSB_REMOTE_CHANNELS.SESSION_STATUS, async (_event, payload) => {
    const result = await service().sessionStatus(readSessionRef(payload).sessionId);
    // 会话行带着工作区快照（占用/在线/会话数）：读到的这一刻就是 fresh 的工作区事实，
    // 顺手推给所有窗口，别让别的窗口只能等自己 12s 轮询。main 不做轮询，推送点只有这类
    // 「刚拿到新快照」的位置。
    broadcastPsbWorkspaceChanged({
      workspaceId: result.workspace.id,
      workspace: result.workspace,
    });
    return result;
  });

  handleInvoke(PSB_REMOTE_CHANNELS.STOP_SESSION, async (_event, payload) => {
    const { sessionId } = readSessionRef(payload);
    await service().stopSession(sessionId);
    // 停会话不改占用者，但 PSB 侧的会话数会变。停止是显式动作、频率低：补读一次会话快照，
    // 把「变化后的工作区行」推给各窗口，而不是让它们盯 12s 轮询。
    const after = await service()
      .sessionStatus(sessionId)
      .catch(() => null);
    if (after) {
      broadcastPsbWorkspaceChanged({
        workspaceId: after.workspace.id,
        workspace: after.workspace,
      });
    }
  });

  handleInvoke(PSB_REMOTE_CHANNELS.OPEN_WEB_WORKSPACE, async (_event, payload) => {
    const { workspaceId } = readWorkspaceRef(payload);
    const webUrl = await service().resolveWorkspaceWebUrl(workspaceId);
    if (!webUrl) {
      throwPsbFailure(
        new PsbClientError(
          { code: 'NOT_FOUND', messageKey: 'remoteWorkspace.admin.staleMissingTitle', message: null },
          null,
        ),
      );
    }
    const url = normalizePsbWebUrl(webUrl);
    if (!url) {
      throwPsbFailure(
        new PsbClientError(
          { code: 'PSB_PROTOCOL', messageKey: 'remoteWorkspace.error.unknown', message: null },
          null,
        ),
      );
    }
    await shell.openExternal(url);
  });

  /* ------------- 会话结束释放工作区占用 + 待释放账本（r6/r7 跨组接线） ------------- */

  // 释放的事实判断在 main（`maker-host/psb-workspace-session-release.ts`）：读 PSB 会话行、
  // 只在「由我占用」时释放、失败记进 main 的有界账本。渲染层只报告「这条本地任务结束了」，
  // 不传 workspaceId（那是 main 才能从 PSB 会话行换算的事实），也不自己重试。
  handleInvoke(PSB_REMOTE_CHANNELS.RELEASE_SESSION_WORKSPACE, async (_event, payload) => {
    const body = requireObject(payload);
    const outcome = await releasePsbWorkspaceForSession({
      sessionId: requireString(body['sessionId'], 'sessionId'),
      remoteHostId: requireNullableString(body['remoteHostId'], 'remoteHostId'),
      reason: requireEnum(body['reason'], PSB_SESSION_RELEASE_REASONS, 'reason'),
    });
    // 失败（PSB 网络 / 鉴权 / 5xx）**不抛 IPC 错**：main 已把它记进待释放账本并负责重试，
    // 抛错只会让渲染层以为「事件没送达」而再排一份重试，两边各试一遍没有额外价值。
    return (outcome.ok
      ? {
          ok: true,
          released: outcome.released,
          reason: outcome.reason,
          failureCode: null,
          message: null,
        }
      : {
          ok: false,
          released: false,
          reason: 'retained',
          failureCode: outcome.failureCode,
          message: outcome.message,
        }) satisfies PsbSessionWorkspaceReleaseResult;
  });

  handleInvoke(
    PSB_REMOTE_CHANNELS.PENDING_RELEASES_GET,
    () => ({ releases: listPendingWorkspaceReleases() }) satisfies PsbPendingWorkspaceReleasesResult,
  );

  handleInvoke(PSB_REMOTE_CHANNELS.PENDING_RELEASES_RETRY, async () => {
    const result = await retryPendingWorkspaceReleases();
    // 返回**重试后**的完整账本：调用方一次拿到计数与剩余项，不用再读一次。
    return {
      ...result,
      releases: listPendingWorkspaceReleases(),
    } satisfies PsbPendingWorkspaceReleasesRetryResult;
  });

  // 账本变更 → 推送完整快照。必须在 register 时订阅一次：失败可能发生在 main 自己的终态
  // 扫描里，渲染层没有参与那次 invoke，只能靠推送知道「远端锁可能还在」。
  onPendingWorkspaceReleasesChanged((releases) => {
    broadcastPsbPendingReleasesChanged({ releases });
  });

  /* ---------------------- 「远程工作区」管理页（工作区级） ---------------------- */

  // 会话级 `STREAM_*` 通道已删除（渲染层零消费，死面见 review r10）：串流只有管理页这一组
  // 工作区级通道。页面围绕一个 PSB 工作区工作，观看端走工作区级 `stream/subscribe` 返回的
  // 桌面访问会话（**不建 Agent 会话**），与用户任务是否结束无关
  // （见 `shared/psb-workspace-admin.ts` 与 docs/dev-rules/psb-remote-session-transport.md §11）。
  //
  // 三个方法接受可选的 `localSessionId`（FIX-B 在 adminService 里加的窗口维度参数）：本窗口
  // 当前打开的是哪个本地任务。传给它后 `CONTEXT_CHANGED` 能按任务分桶，不会把别的窗口的
  // 上下文当成自己的刷新基线；不传也兼容（按工作区匹配）。
  const admin = (): PsbAdminWindowAwarePort =>
    getPsbWorkspaceAdminService() as unknown as PsbAdminWindowAwarePort;

  handleInvoke(PSB_ADMIN_CHANNELS.CONTEXT, async (_event, payload) => {
    // 入参只有「当前打开的任务」这一条线索（可为空）：工作区解析完全在 main 侧，
    // 渲染层不传 remoteHostId / workspaceId —— 那些是主进程的事实，传进来只会成为可伪造的输入。
    const body = readOptionalBody(payload);
    const localSessionId = optionalString(body['localSessionId']) ?? null;
    const result = await admin().context({ localSessionId });
    return result satisfies PsbWorkspaceAdminContextResult;
  });

  handleInvoke(PSB_ADMIN_CHANNELS.STREAM_START, async (event, payload) => {
    const { workspaceId } = readWorkspaceRef(payload);
    const body = readOptionalBody(payload);
    const localSessionId = optionalString(body['localSessionId']) ?? null;
    const ownerId = event.sender.id;
    // 上一轮「启动在途时收到停止」的标记只对上一轮有效：新一轮启动在入口清掉它；这一轮的停止
    // 会在下面的 await 期间重新落标记（见 droppedWhileStarting 分支）。
    consumeAdminStreamRelease(workspaceId, ownerId);
    let result: PsbWorkspaceAdminStreamStartResult;
    try {
      result = await admin().streamStart(workspaceId, { localSessionId });
    } catch (error) {
      // 启动失败 = 这条调用没有建立观看连接，也不该留下「待停止」标记影响下一次启动。
      consumeAdminStreamRelease(workspaceId, ownerId);
      throw error;
    }
    // 窗口在启动**在途**被销毁（2026-11-27 终局复审 P1）：`trackAdminStreamOwner` 的
    // `destroyed` 回收监听是**登记 owner 时**才挂的；sender 已经销毁就再也不会回调 —— 此刻
    // 登记下去就是一个永不归零的 owner：之后别的窗口「最后离开」时判据永远看到还有人在看，
    // 流与 PSB 观看名额（与网页观看端共用）泄漏到进程退出。所以落定处先看 sender 是否还在：
    // 不在就绝不登记，按「没有观看者」把刚起来的流收掉（启动可能真的建立了连接）。
    // 顺手清掉这个窗口遗留的「启动在途停止」标记：已销毁的 sender 不会再有机会消费它。
    if (event.sender.isDestroyed()) {
      clearAdminStreamReleaseForOwner(ownerId);
      await dropAdminStreamOwner(workspaceId, ownerId, localSessionId);
      return result satisfies PsbWorkspaceAdminStreamStartResult;
    }
    if (consumeAdminStreamRelease(workspaceId, ownerId)) {
      // 这个窗口在启动还在路上时就请求了停止（starting 相位卸载 / 快速停止）。**不登记 owner**：
      // 渲染层已经不在观看态，登记只会在没人释放的情况下把流留在后台；按「最后离开者」判据
      // 收尾（启动可能真的把流起来了，但没有观看者就必须停掉）。
      await dropAdminStreamOwner(workspaceId, ownerId, localSessionId);
      return result satisfies PsbWorkspaceAdminStreamStartResult;
    }
    // 引用计数：同一工作区被多个窗口观看时只增计数；帧只定向给登记过的窗口。
    trackAdminStreamOwner(workspaceId, result.viewerSessionId, event);
    return result satisfies PsbWorkspaceAdminStreamStartResult;
  });

  handleInvoke(PSB_ADMIN_CHANNELS.STREAM_STOP, async (event, payload) => {
    const { workspaceId } = readWorkspaceRef(payload);
    const body = readOptionalBody(payload);
    const localSessionId = optionalString(body['localSessionId']) ?? null;
    // 这个窗口此前已经登记过 owner = 没有「启动在途」的调用需要消费下面的标记（渲染层不允许
    // 在已连接时再发起启动）：标记只是为了兜住 starting 相位卸载，别让它按「窗口 × 工作区」累积。
    const wasTracking = adminStreamOwners.owners(workspaceId).includes(event.sender.id);
    // 先落标记：这个窗口的启动可能还在 PSB 里飞（owner 还没登记），那次启动落定时会消费它并
    // 直接收尾（否则停止在 `untrackAdminStreamOwner` 里变成一个 no-op，owner 永久残留）。
    requestAdminStreamRelease(workspaceId, event.sender.id);
    if (wasTracking) consumeAdminStreamRelease(workspaceId, event.sender.id);
    // 只有最后离开的窗口才真正停流（其它窗口还在看）。
    await dropAdminStreamOwner(workspaceId, event.sender.id, localSessionId);
  });

  handleInvoke(PSB_ADMIN_CHANNELS.STREAM_STATUS, async (_event, payload) => {
    const { workspaceId } = readWorkspaceRef(payload);
    const body = readOptionalBody(payload);
    const localSessionId = optionalString(body['localSessionId']) ?? null;
    const result = await admin().streamStatus(workspaceId, { localSessionId });
    return result satisfies PsbWorkspaceAdminStreamStatusResult;
  });

  handleInvoke(PSB_ADMIN_CHANNELS.STREAM_INPUT, async (_event, payload) => {
    // 入参是**工作区级**的：渲染层不持有观看端会话 id（那是 main 的事实），事件形状在
    // 产生任何副作用之前先校验（规则见 `readStreamInputEvent`）。
    const body = requireObject(payload);
    const workspaceId = requireString(body['workspaceId'], 'workspaceId');
    const event = readStreamInputEvent(body['event']);
    await admin().streamInput(workspaceId, event);
  });

  handleInvoke(PSB_ADMIN_CHANNELS.STREAM_CAPTURE, (event, payload) => {
    // 全屏 / 画面聚焦时渲染层通知 main「现在键鼠属于远端」：本窗口忽略菜单 accelerator，并在
    // `before-input-event` 里拦掉会触发宿主行为的组合（实现见 `streamCapture.ts`）。
    // **只作用于 event.sender**；退出全屏 / 页面卸载 / 失焦都会各自恢复（见 runtime 文件头）。
    const body = requireObject(payload);
    const active = requireBoolean(body['active'], 'active');
    updatePsbStreamCapture({
      sender: event.sender,
      active,
      workspaceId: optionalString(body['workspaceId']) ?? null,
    });
  });
}
