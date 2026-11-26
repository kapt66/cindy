/**
 * 宿主光标**形状**同步（PSB 串流观看端，2026-11-26；同日改口径）。
 *
 * ## 口径：只同步形状，外观永远是宿主（本机）指针风格（用户明确要求）
 *
 * 「鼠标指针变化不是只同步远程的形态——**鼠标指针的风格仍然保留宿主的风格**。参照 PSB 网页
 * 实现：**永远使用宿主鼠标指针、永远保持宿主鼠标指针风格**，但串流的**鼠标状态**（形状/形态）
 * 需要同步过来」。所以这里把远端 `stream.cursor` 的 `name`（XFixes 光标名）经共享纯函数
 * `psbStreamCursorKeyword` 映射成 **CSS 关键字**（`text` / `ew-resize` / `wait`…），由本机主题
 * 渲染指针外观；**不再**使用远端 PNG 位图 `url("data:image/png…")`（那会把 Windows/macOS 的
 * 宿主指针换成 Linux 主题外观，PSB 网页 2026-11-25 真机反馈过同一个问题）。
 *
 * ## 只在**画面区域**生效
 *
 * 关键字只写到 **canvas**（画面区域）的 `style.cursor`：指针命中 canvas 时应用，离开画面立即
 * 清空 → 恢复宿主默认光标。控制条、HUD、全屏退出按钮都是本地 UI，不继承远端形状（HUD / 退出
 * 按钮另有显式 `cursor-default` / `cursor-pointer`）。不用 stage 承载样式：stage 还包含黑边与
 * 浮层，写在那里会让 HUD / 空白处也变成远端形状；全屏时 canvas 仍在 stage 里，同一份样式继续
 * 生效。
 *
 * **命中判定为什么不能只靠 canvas 的 `pointerleave`**：画面支持拖拽操作（选文本、拖窗口、拉
 * 窗口边缘 resize），`usePsbStreamInteraction` 在 pointerdown 时把指针捕获到 **stage**；捕获
 * 会把后续指针事件重定向，canvas 会收到一次「伪造的」`pointerleave`。只按边界事件会在整个
 * 拖拽期间把 resize / grabbing 这类形状清掉。所以：canvas `pointerenter` 负责「进入即应用」，
 * stage `pointermove` 按 **canvas 矩形几何命中**（捕获前后都有效）持续校正，stage `pointerleave`
 * 负责「离开画面容器立即恢复」。
 *
 * ## 缓存最近一次形状
 *
 * 形状事件可能在指针不在画面上时到达（例如远端光标变 `wait` 时用户正看着 HUD）。缓存关键字 +
 * 主机光标名，重新进入画面时立刻应用，不必等下一帧；离开画面只清样式、不清缓存。
 *
 * ## 生命周期（什么时候必须回宿主默认）
 *
 * - 没有活动订阅（未启动 / 停止 / `closed` / 错误断开 / 切工作区 / 组件卸载）→ 清缓存并清
 *   canvas 的 `style.cursor`；`closed` / `error` 事件本身也直接清（错误断开不一定会让上层重置
 *   订阅，不能只等 cleanup）；切工作区由页面按 `workspaceId` 重挂连接区（见
 *   `RemoteWorkspaceAdminPanel` 的 `key`），卸载 cleanup 会清掉；
 * - 每次「无订阅 ↔ 有订阅」切换都把缓存归零：上一条连接的光标形状不该画到新画面上。
 *
 * ## 排障属性
 *
 * 生效时在 canvas 上写 `data-stream-cursor-keyword` / `data-stream-cursor-name`（真机验收从
 * canvas 读 `getComputedStyle(canvas).cursor` 与这两个属性即可说清「远端是哪个光标、我们映射成
 * 哪个关键字」），清空时一并移除。只写关键字/名字，不再放位图或 data URL。
 */

import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

import {
  psbStreamCursorKeyword,
  psbStreamCursorName,
} from '../../../../shared/psb-remote-workspace';
import type { PsbWorkspaceAdminBridge } from './psbWorkspaceAdminBridge';

/** 排障属性：远端 XFixes 光标名（如 `xterm` / `left_side`），真机断言用。 */
export const PSB_STREAM_CURSOR_NAME_ATTRIBUTE = 'data-stream-cursor-name';

/** 排障属性：实际写进 `style.cursor` 的 CSS 关键字（如 `text` / `ew-resize`）。 */
export const PSB_STREAM_CURSOR_KEYWORD_ATTRIBUTE = 'data-stream-cursor-keyword';

export interface PsbStreamCursorInput {
  /** 工作区级管理桥；缺失（旧 preload / 单测）时保持宿主默认光标。 */
  readonly bridge: Pick<PsbWorkspaceAdminBridge, 'onAdminStreamEvent'> | null;
  /** 画面区域：光标只在指针命中它时生效（canvas 是等比的画面，不含黑边 / 浮层）。 */
  readonly canvasRef: RefObject<HTMLCanvasElement | null>;
  /**
   * 画面容器：拖拽期间指针被捕获到它，指针事件会从 canvas 重定向到这里；命中判定在这里按
   * canvas 矩形几何校正（见文件头「只在画面区域生效」）。
   */
  readonly stageRef: RefObject<HTMLDivElement | null>;
  /** 本工作区内部观看端会话 id（事件过滤；`null` = 还不知道，按不过滤处理）。 */
  readonly viewerSessionIdRef: RefObject<string | null>;
  /** 是否有活动订阅（`subscribed || streaming`）：false = 回宿主默认光标并停止接收形状。 */
  readonly active: boolean;
}

/** 缓存的最近一条远端形状（已映射成关键字；`serial` 只用于去重连续重复）。 */
interface CachedCursor {
  readonly keyword: string;
  readonly name: string | null;
  readonly serial: number;
}

/** 已写上去的样式（关键字 + 名字），避免指针每次移动都重复写同一份 DOM。 */
interface AppliedCursor {
  readonly keyword: string;
  readonly name: string | null;
}

export function usePsbStreamCursor(input: PsbStreamCursorInput): void {
  const { bridge, canvasRef, stageRef, viewerSessionIdRef, active } = input;
  /** 最近一次形状：重新进入画面时立刻用，不必等下一帧。 */
  const latestRef = useRef<CachedCursor | null>(null);
  /** 最近一次真正写上去的样式（指针不在画面上时为 `null`）。 */
  const appliedRef = useRef<AppliedCursor | null>(null);
  /** 指针此刻是否停在画面（canvas）上。 */
  const insideRef = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;

    const clearCursor = (): void => {
      appliedRef.current = null;
      if (!canvas) return;
      canvas.style.cursor = '';
      canvas.removeAttribute(PSB_STREAM_CURSOR_KEYWORD_ATTRIBUTE);
      canvas.removeAttribute(PSB_STREAM_CURSOR_NAME_ATTRIBUTE);
    };

    /** 把缓存的形状写到画面区域；没有缓存 / 已经写过同一份就什么都不做（幂等）。 */
    const applyCursor = (): void => {
      const target = latestRef.current;
      if (!canvas || !target) return;
      const applied = appliedRef.current;
      if (applied?.keyword === target.keyword && applied.name === target.name) return;
      appliedRef.current = { keyword: target.keyword, name: target.name };
      canvas.style.cursor = target.keyword;
      canvas.setAttribute(PSB_STREAM_CURSOR_KEYWORD_ATTRIBUTE, target.keyword);
      if (target.name === null) canvas.removeAttribute(PSB_STREAM_CURSOR_NAME_ATTRIBUTE);
      else canvas.setAttribute(PSB_STREAM_CURSOR_NAME_ATTRIBUTE, target.name);
    };

    const reset = (): void => {
      latestRef.current = null;
      insideRef.current = false;
      clearCursor();
    };

    // 每次订阅状态变化都从干净状态开始：旧形状作废、缓存归零。
    reset();
    if (!bridge || !active || !canvas || !stage) return undefined;

    /**
     * 坐标是否落在画面（canvas）矩形内。
     *
     * 用几何而不是 `event.target === canvas`：拖拽时指针被捕获到 stage，事件 target 变成 stage；
     * 但用户看到的指针位置仍由命中测试决定（canvas / 浮层 / 黑边），CSS `cursor` 也只对命中的
     * 元素生效。所以「指针是否在画面区域」用 canvas 的当前矩形判断，捕获前后一致。
     */
    const isOverPicture = (event: { readonly clientX: number; readonly clientY: number }): boolean => {
      const rect = canvas.getBoundingClientRect();
      if (!(rect.width > 0 && rect.height > 0)) return false;
      return (
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom
      );
    };

    const onPointerEnter = (): void => {
      insideRef.current = true;
      applyCursor();
    };
    // 捕获态（拖拽）下 canvas 的 `pointermove` / `pointerleave` 都不再按边界触发，stage 的
    // `pointermove` 仍会带着真实坐标到达：按几何命中持续校正。
    const onStagePointerMove = (event: PointerEvent): void => {
      if (isOverPicture(event)) {
        insideRef.current = true;
        applyCursor();
        return;
      }
      // 移出画面区域（进入黑边 / 浮层外）：立即回到宿主默认，不保持远端形状。
      if (insideRef.current) {
        insideRef.current = false;
        clearCursor();
      }
    };
    // 离开画面容器（切到控制条 / 页签外）：同样立即恢复宿主默认。
    const onStagePointerLeave = (): void => {
      insideRef.current = false;
      clearCursor();
    };

    const unsubscribe = bridge.onAdminStreamEvent((event) => {
      // 观看被 PSB 关闭 / 连接错误：画面已经不是这条连接的了，光标立刻回宿主默认。
      // （`closed` 通常也会让 `active` 变 false 触发一次 cleanup，但错误断开不一定会重置订阅，
      // 所以这里两种结局都兜住，不依赖上层状态机的细节。）
      if (event.type === 'closed' || event.type === 'error') {
        reset();
        return;
      }
      if (event.type !== 'cursor') return;
      const viewerSessionId = viewerSessionIdRef.current;
      if (viewerSessionId && event.sessionId && event.sessionId !== viewerSessionId) return;
      // 同一条形状重复下发（PSB 补发 / 重连补发）：不重复改样式。serial 只做这一层去重，
      // **不按序号丢弃更新**——真机日志里序号并不严格单调（main 侧同样不丢）。
      if (latestRef.current?.serial === event.cursor.serial) return;
      // 形状非法（已由 main 校验，这里防伪造）：保持现状，不写坏值也不清掉已有形状。
      const keyword = psbStreamCursorKeyword(event.cursor);
      if (keyword === null) return;
      latestRef.current = {
        keyword,
        name: psbStreamCursorName(event.cursor),
        serial: event.cursor.serial,
      };
      // 指针不在画面上时只更新缓存：离开画面期间不持有远端形状，进入时立刻用上。
      if (insideRef.current) applyCursor();
    });

    canvas.addEventListener('pointerenter', onPointerEnter);
    stage.addEventListener('pointermove', onStagePointerMove);
    stage.addEventListener('pointerleave', onStagePointerLeave);
    return () => {
      unsubscribe();
      canvas.removeEventListener('pointerenter', onPointerEnter);
      stage.removeEventListener('pointermove', onStagePointerMove);
      stage.removeEventListener('pointerleave', onStagePointerLeave);
      reset();
    };
  }, [active, bridge, canvasRef, stageRef, viewerSessionIdRef]);
}
