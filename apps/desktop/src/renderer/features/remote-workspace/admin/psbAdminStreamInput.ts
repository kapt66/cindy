/**
 * 「远程工作区」页的**工作区级**输入通道（窄入口 + 串行发送器）。
 *
 * ## 为什么是工作区级
 *
 * 页面看的画面由主进程的**工作区级观看端绑定**订阅：`POST …/workspaces/:id/stream/subscribe`
 * 返回的桌面访问会话 id（旧 PSB 的过渡回退才是内部 Agent 会话），串流 WS 挂在那条会话上。
 * 所以输入必须走 `adminStreamInput({ workspaceId, event })`（`PSB_ADMIN_CHANNELS
 * .STREAM_INPUT`），**不能**用会话级 `psbRemote.streamInput({ sessionId, ... })` —— 那指向
 * 用户任务的 `psb:<id>` 会话，和本页画面不是同一条连接（发了也没人看，还会在另一条会话上
 * 触发 xdotool）。
 *
 * ## 通道未落地时的降级
 *
 * 通道由主进程批次加性落地（`shared/psb-workspace-admin.ts` 的 `STREAM_INPUT` / `STREAM_CAPTURE`
 * + preload + `bridge.ts`）。本文件只在运行时探测方法是否存在：旧 preload / 单测环境缺方法时
 * 返回 `null`，页面据此把画面降级成「只读观看」，而不是崩或点了没反应。
 *
 * 同一批契约里还有 `setAdminStreamCaptureActive`（画面捕获态开关）：全屏时通知 main 让本窗口
 * 的宿主菜单快捷键让路（Electron accelerator 在 main 侧，渲染层 `preventDefault` 拦不住）。
 * 它同样按「方法存在才用」探测，缺方法时只失去这层加固，不影响事件级转发。
 *
 * ## 为什么发送要串行
 *
 * IPC invoke 的完成顺序不保证，而 PSB 客户端注入是**顺序执行**的：鼠标按下 / 抬起、keydown /
 * keyup 乱序会变成「按了没放」「没按就放」。这里用一条 promise 链把事件按到达顺序排队，单条
 * 发送失败只吞掉错误（WS 断开会由串流状态驱动界面），不打断后续输入。
 */

import { tryGetPsbRemoteBridge } from '../bridge';
import type { PsbWorkspaceAdminStreamInputRequest } from '../../../../shared/psb-workspace-admin';
import type { PsbRemoteBridge } from '../bridge';
import type { PsbStreamInputEvent } from '../stream/psbStreamInput';

/**
 * 渲染层需要的最小桥形状：**直接取自 `bridge.ts` 的正式签名**（`Pick` 而不是另抄一份），
 * 契约改字段时这里编译期就会报错。
 */
export type PsbAdminStreamInputBridge = Pick<PsbRemoteBridge, 'adminStreamInput'>;

/**
 * 取带输入通道的 preload 桥；方法不存在时返回 `null`（**只读观看**降级，不是错误）。
 */
export function tryGetAdminStreamInputBridge(): PsbAdminStreamInputBridge | null {
  const bridge = tryGetPsbRemoteBridge() as unknown as Record<string, unknown> | null;
  if (!bridge) return null;
  if (typeof bridge.adminStreamInput !== 'function') return null;
  return bridge as unknown as PsbAdminStreamInputBridge;
}

/** 「画面捕获态」开关（工作区级；全屏时通知 main 让本窗口的宿主快捷键让路）。 */
export type PsbAdminStreamCaptureBridge = Pick<PsbRemoteBridge, 'setAdminStreamCaptureActive'>;

/**
 * 取「画面捕获态」通道；旧 preload 缺方法时返回 `null`（不通知 main 也能工作，只是宿主
 * 菜单快捷键可能仍会响应 —— 降级路径由渲染层的 `preventDefault` 尽力兜住）。
 */
export function tryGetAdminStreamCaptureBridge(): PsbAdminStreamCaptureBridge | null {
  const bridge = tryGetPsbRemoteBridge() as unknown as Record<string, unknown> | null;
  if (!bridge) return null;
  if (typeof bridge.setAdminStreamCaptureActive !== 'function') return null;
  return bridge as unknown as PsbAdminStreamCaptureBridge;
}

export interface PsbStreamInputSender {
  /** 排队发送一条输入事件（按调用顺序到达主进程）。 */
  send(event: PsbStreamInputEvent): void;
  /** 不再接收新事件；已排队的事件仍会发完（卸载时补发的释放事件要送达）。 */
  dispose(): void;
}

/**
 * 创建串行发送器。
 *
 * @param input.workspaceId 目标 PSB 工作区（工作区级通道的必填字段）。
 * @param input.send 桥的 invoke；失败只回调 `onSendError`，不向调用方抛。
 */
export function createPsbStreamInputSender(input: {
  readonly workspaceId: string;
  readonly send: (input: PsbWorkspaceAdminStreamInputRequest) => Promise<void>;
  readonly onSendError?: (error: unknown) => void;
}): PsbStreamInputSender {
  let chain: Promise<void> = Promise.resolve();
  let disposed = false;
  return {
    send(event) {
      if (disposed) return;
      chain = chain.then(async () => {
        try {
          await input.send({
            workspaceId: input.workspaceId,
            event: event as unknown as Record<string, unknown>,
          });
        } catch (error) {
          input.onSendError?.(error);
        }
      });
    },
    dispose() {
      disposed = true;
    },
  };
}
