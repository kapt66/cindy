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
  psbIpcCodeForFailure,
  type PsbCreateWorkspaceResult,
  type PsbListClientsResult,
  type PsbListTemplatesResult,
  type PsbListWorkspacesResult,
  type PsbOccupyWorkspaceResult,
  type PsbStreamStartResult,
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
  requireObject,
  requireString,
  throwIpcError,
} from '../utils/ipcValidate.js';
import { getPsbWorkspaceAdminService } from './adminRuntime.js';
import { PsbClientError, toPsbRemoteFailure } from './psbClient.js';
import { normalizePsbWebUrl } from './psbEndpoint.js';
import { getPsbRemoteService, type PsbRemoteService } from './index.js';
import { broadcastPsbWorkspaceChanged } from './push.js';
import { updatePsbStreamCapture } from './streamCaptureRuntime.js';

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

/**
 * 窗口销毁时释放观看名额：PSB 每会话观看者有上限，面板/窗口直接关掉也必须真的断开 WS
 * （见 docs/dev-rules/psb-remote-session-transport.md §5「名额与泄漏」）。
 */
function trackStreamOwner(
  sessionId: string,
  event: IpcMainInvokeEvent,
  getService: () => PsbRemoteService,
): void {
  const sender = event.sender;
  streamOwners.set(sessionId, sender.id);
  if (watchedSenders.has(sender.id)) return;
  watchedSenders.add(sender.id);
  sender.once('destroyed', () => {
    watchedSenders.delete(sender.id);
    for (const [ownerSessionId, ownerId] of streamOwners) {
      if (ownerId !== sender.id) continue;
      streamOwners.delete(ownerSessionId);
      void getService().stopStream(ownerSessionId).catch(() => {
        /* 窗口已经销毁：这里没有可报错的界面，连接自身也会随 socket 断开而收尸 */
      });
    }
  });
}

/** sessionId → 正在观看它的 webContents.id（多窗口同步用；同一会话只保留最后一个启动者）。 */
const streamOwners = new Map<string, number>();
/** 已挂过 `destroyed` 监听的 webContents.id。 */
const watchedSenders = new Set<number>();

/**
 * 管理页串流：workspaceId → 启动它的 webContents.id。
 *
 * 管理页的串流观看挂在**工作区级绑定**上（每个工作区一条，跨窗口共享），观看端绑定的会话 id
 * 是主进程的事实（正常 = PSB 桌面访问会话 id），所以释放点必须按工作区而不是会话 id 记；
 * 窗口销毁同样要停流，否则会白占 PSB 的观看名额。
 */
const adminStreamOwners = new Map<string, number>();
/** 已挂过管理页 `destroyed` 监听的 webContents.id。 */
const watchedAdminSenders = new Set<number>();

function trackAdminStreamOwner(workspaceId: string, event: IpcMainInvokeEvent): void {
  const sender = event.sender;
  adminStreamOwners.set(workspaceId, sender.id);
  if (watchedAdminSenders.has(sender.id)) return;
  watchedAdminSenders.add(sender.id);
  sender.once('destroyed', () => {
    watchedAdminSenders.delete(sender.id);
    for (const [ownerWorkspaceId, ownerId] of adminStreamOwners) {
      if (ownerId !== sender.id) continue;
      adminStreamOwners.delete(ownerWorkspaceId);
      void getPsbWorkspaceAdminService().streamStop(ownerWorkspaceId).catch(() => {
        /* 窗口已经销毁：这里没有可报错的界面，连接自身也会随 socket 断开而收尸 */
      });
    }
  });
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
          { code: 'NOT_FOUND', messageKey: 'remoteWorkspace.error.notFound', message: null },
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

  handleInvoke(PSB_REMOTE_CHANNELS.STREAM_STATUS, (_event, payload) =>
    service().getStreamStatus(readSessionRef(payload).sessionId),
  );

  handleInvoke(PSB_REMOTE_CHANNELS.STREAM_START, async (event, payload) => {
    const { sessionId } = readSessionRef(payload);
    // 会话级启动串流同样是**工作区写操作**（PSB 对未锁定者拒绝）：走与工作区级启动同一条
    // 占用闸门，不依赖 PSB 拒后再把不可行动的原因转给用户。该组通道目前没有渲染层消费方，
    // 但闸门必须在这里，否则以后接消费方时它就成了绕过占用检查的第二条路径。
    await service().ensureWorkspaceLockedForSession(sessionId);
    const status = await service().startStream(sessionId);
    trackStreamOwner(sessionId, event, service);
    return { status } satisfies PsbStreamStartResult;
  });

  handleInvoke(PSB_REMOTE_CHANNELS.STREAM_STOP, async (_event, payload) => {
    const { sessionId } = readSessionRef(payload);
    streamOwners.delete(sessionId);
    await service().stopStream(sessionId);
  });

  handleInvoke(PSB_REMOTE_CHANNELS.STREAM_INPUT, async (_event, payload) => {
    const body = requireObject(payload);
    const sessionId = requireString(body['sessionId'], 'sessionId');
    const message = requireObject(body['event'], 'event');
    if (message['kind'] !== 'input') {
      throwIpcError('INVALID_PARAMS', "event.kind must be 'input'");
    }
    await service().sendStreamInput(sessionId, readStreamInputEvent(message['event']));
  });

  /* ---------------------- 「远程工作区」管理页（工作区级） ---------------------- */

  // 这一组 handler 与上面「会话级」通道**分属两组常量**（`PSB_ADMIN_CHANNELS`）：
  // 页面围绕一个 PSB 工作区工作，观看端走工作区级 `stream/subscribe` 返回的桌面访问会话
  // （**不建 Agent 会话**），与用户任务是否结束无关
  // （见 `shared/psb-workspace-admin.ts` 与 docs/dev-rules/psb-remote-session-transport.md §11）。
  const admin = () => getPsbWorkspaceAdminService();

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
    const result = await admin().streamStart(workspaceId);
    trackAdminStreamOwner(workspaceId, event);
    return result satisfies PsbWorkspaceAdminStreamStartResult;
  });

  handleInvoke(PSB_ADMIN_CHANNELS.STREAM_STOP, async (_event, payload) => {
    const { workspaceId } = readWorkspaceRef(payload);
    adminStreamOwners.delete(workspaceId);
    await admin().streamStop(workspaceId);
  });

  handleInvoke(PSB_ADMIN_CHANNELS.STREAM_STATUS, async (_event, payload) => {
    const { workspaceId } = readWorkspaceRef(payload);
    const result = await admin().streamStatus(workspaceId);
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
