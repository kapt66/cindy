/**
 * xdt-helper/start_team.ts —— 启动 multi-worker workflow, 为当前 Lead session
 * 创建 orca workflow 记录。
 *
 * 与旧粗粒度入口不同: 本工具不创建 worker (改由 create_worker 负责),
 * 也不接受 delegate_task 参数 (派活改用 send_to_worker)。
 */

import { BRAND_NAME } from "@cindy/maker-shared/branding";
import { z } from "zod";
import type { XdtHelperToolRegistry } from "../lizi_xdtHelperToolRegistry.js";
import type { ControlResult } from "../lizi_xdtHelperMcpServer.js";
import { okPayload, errorPayload } from "./_payload.js";

export interface StartTeamDeps {
  sessionId: string | undefined;
  vendorOptions: Record<string, unknown> | undefined;
  getSessionContext?: () => {
    sessionId?: string;
    vendorOptions?: Record<string, unknown>;
  };
  startTeam: (params: {
    leadSessionId: string;
    workerPermissionMode?: "auto" | "bypassPermissions";
  }) => Promise<
    ControlResult<
      {
        teamId: string;
        workerPermissionMode: "auto" | "bypassPermissions";
        reused?: boolean;
      },
      "USER_CANCELLED" | "CONFIRM_TIMEOUT"
    >
  >;
}

const DESCRIPTION =
  "为当前 session 创建 orca team, 进入多 worker 协同模式。" +
  "失败码: LEAD_NOT_SUPPORTED / WORKER_CANNOT_NEST / ALREADY_ENABLED / USER_CANCELLED / CONFIRM_TIMEOUT。" +
  "worker_permission_mode 可选:auto(Auto-review)或 bypassPermissions(Full access);省略时沿用上次 Worker 创建偏好。没有保存过偏好时默认 bypassPermissions,但这只是可选初始值,可以显式选择 auto;手动选择后继续沿用该选择。当前 session 已是 Lead 时,必须显式指定模式才能更新默认值。" +
  "显式指定后,它会成为 UI 与 agent tool 后续创建 Worker 的共同默认权限;不改变 Lead 自己的权限。从 auto 升级到 bypassPermissions 时,主机会等待用户确认;取消或超时不会更新偏好、也不会开启 team。" +
  "注:start_team 开启的是 session 级、持久、UI 可见的多 worker 协同。若用户要的是一个 subagent(一次性、用完即弃的子任务执行体),请用你自己的原生 subagent 机制(如 Codex 的 spawn_agent、Claude Code 的 Task 工具),不要为此 start_team 开协同。" +
  "Orca 协同永远不是 subagent 的替代品;你没有原生 subagent 机制时,如实告知用户并请他决定,不要拿 Orca 顶替,也不要自己起进程冒充。";

/**
 * Host 声明「当前 workflow 只读」的 vendorOption 键。为 true 时 Worker 一律以 auto 启动，
 * 绝不因用户的通用 Worker 创建偏好拿到 Full access。
 *
 * 该键由宿主策略／项目角色配置下发（键名固定为 "mekaLockWorkerPermissionMode"）；
 * 随包内置的只读工作流退役后，本仓暂时没有任何写入方——这是**预期**状态，
 * 机制本身不是死代码：外部宿主仍可通过该键约束 Worker 权限。
 */
const READ_ONLY_WORKFLOW_LOCK_VENDOR_OPTION = "mekaLockWorkerPermissionMode";

export function registerStartTeamTool(
  registry: XdtHelperToolRegistry,
  deps: StartTeamDeps,
): void {
  registry.register({
    name: "start_team",
    category: "control",
    description: DESCRIPTION,
    inputShape: {
      worker_permission_mode: z
        .enum(["auto", "bypassPermissions"])
        .optional()
        .describe(
          "Worker 创建默认权限。省略时沿用已保存偏好；没有保存过偏好时初始为 bypassPermissions，但可显式选择 auto，手动选择后 UI 与后续 create_worker/create_workers 都沿用该模式。当前 session 已是 Lead 时须显式指定才能更新默认值。",
        ),
    },
    handler: async ({ worker_permission_mode }) => {
      const ctx = deps.getSessionContext?.() ?? deps;
      if (!ctx.sessionId) {
        return errorPayload(
          "LEAD_NOT_SUPPORTED",
          `当前 MCP 调用没有绑定 ${BRAND_NAME} session, 无法作为 Lead 启动协同。`,
        );
      }
      const role = ctx.vendorOptions?.orcaRole;
      if (role === "worker") {
        return errorPayload(
          "WORKER_CANNOT_NEST",
          "start_team 是 Orca worker 协同入口,不是 subagent 入口。若用户明确要求 subagent / 子代理,请使用你自己的原生 subagent 机制(如 Codex 的 spawn_agent、Claude Code 的 Task/Agent 工具),不要使用 Orca start_team / create_worker。没有原生 subagent 机制时如实告知用户,Orca 协同不是它的替代品。",
        );
      }
      if (role === "lead" && worker_permission_mode === undefined) {
        return errorPayload(
          "ALREADY_ENABLED",
          "当前 session 已是 Lead, 已有 active workflow。",
        );
      }

      // Host 声明的只读 workflow 下，只读证据 Worker 永不需要 Full access，也不应因为
      // 用户的通用 Worker 偏好（可能正是 Full access）弹出一次权限升级确认。
      const effectiveWorkerPermissionMode =
        ctx.vendorOptions?.[READ_ONLY_WORKFLOW_LOCK_VENDOR_OPTION] === true
          ? "auto"
          : worker_permission_mode;

      const result = await deps.startTeam({
        leadSessionId: ctx.sessionId,
        workerPermissionMode: effectiveWorkerPermissionMode,
      });
      if (!result.ok) {
        if (
          result.errorCode === "HOST_NOT_READY" ||
          result.errorCode === "USER_CANCELLED" ||
          result.errorCode === "CONFIRM_TIMEOUT"
        ) {
          return errorPayload(result.errorCode, result.message);
        }
        return errorPayload("INTERNAL", result.message);
      }

      return okPayload({
        team_id: result.teamId,
        worker_permission_mode: result.workerPermissionMode,
        reused: result.reused === true,
      });
    },
  });
}
