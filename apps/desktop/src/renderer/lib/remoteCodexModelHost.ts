import type { AgentKind } from '@cindy/model-providers';

import { MCPR_REMOTE_HOST_PREFIX } from '../../shared/meka-router';

/**
 * 渲染层「这个 remoteHostId 是不是真正的 SSH 执行主机」的**唯一判定点**。
 *
 * 为什么值得一个专门模块（两次实机故障，同一种形状）：
 *
 * - 2026-10-08：`ChatInput` 把任意 `remoteHostId` 当成「SSH Codex 主机」，MCPRouter 的
 *   Codex 会话因此打出一条 `SSH_EXEC_FAILED`（用户看到「无法读取远程设备上的模型」toast）、
 *   经 `remoteModelListBlocked` **连发送都被拦下**、并用空清单当远端模型面。
 *   那轮把判定收成 `resolveRemoteCodexModelHostId`，消费方是 `ChatInput` 与
 *   `sshSessionModelSelection.ts`。
 * - 2026-11-23：2026-11-02 新增的「SSH 草稿模型目录」功能在 `NewMakerDraftRoute` 里**又手写了
 *   一遍**「有 `effectiveRemoteHostId` 就当 SSH 主机」的条件，于是 MCPRouter 远程项目草稿
 *   一打开模型选择器，主进程 `LIST_CODEX_MODELS` 的 transport 分类（第二道保险）就抛
 *   `INVALID_PARAMS`，选择器顶部弹出「无法读取远程设备上的模型。请检查连接后重试。」
 *   —— 一个**假告警**，远端请求从未发出；codex 类型实例还会因此丢掉本机目录里的 codex 型号。
 *
 * 结论：这条规则不能靠「每个调用点自己记得分类」。本模块对外只暴露三件东西：
 *
 *   1. `SshRemoteHostId`（品牌类型）+ `asSshRemoteHostId()`：**类型层面**保证能把 host 喂给
 *      SSH-only 探针的调用点必然先经过判定；新增/合并进来的调用点直接传 `string` 会 typecheck 失败。
 *   2. `resolveRemoteCodexModelHostId()`：Codex 清单探针（`remoteSsh.listCodexModels`）的入口判据。
 *   3. `resolveSshCodexCatalogHostId()`：草稿页「要不要建 SSH Codex 目录」的入口判据。
 *
 * 判据必须与主进程 `classifyRemoteSessionTransport`（`main/maker-host/remote-session-routing.ts`）
 * **逐字一致**：用共享前缀常量，且**保留畸形 `mcpr:`** 在 MCPRouter 一侧（主进程刻意不把它
 * 当 SSH 主机）。渲染层 import 不到主进程模块，所以这里镜像同一个谓词；
 * `remoteCodexModelHost.test.ts` 用输入矩阵断言两侧对同一批输入永远一致。
 *
 * **为什么 MCPRouter 侧不能用远端清单**：MCPRouter 的 Codex bridge 只带**本机** AI Gateway
 * key（`main/maker-host/mcpr-codex-capability.ts` 的 `buildRemoteCodexBridgeHeader`：
 * `readClaudeApiKey()` + 网关代理参数，`resolveRemoteCodexCredentialMode` 也把 mcpr 判为
 * `'gateway-key'`），所以它的模型面与本机一致，正确来源是**本机目录**，不是远端探测。
 * SSH 相反：那台主机有自己的登录与 `CODEX_HOME`，必须问它自己。
 */
const SSH_REMOTE_HOST_BRAND: unique symbol = Symbol('cindy.sshRemoteHostId');

/**
 * 已经按 transport 分类、确认是**真 SSH 执行主机**的 `remoteHostId`。
 *
 * 品牌只在本模块由 `asSshRemoteHostId()` 产出；SSH-only 的渲染层入口（目前是
 * `useSshCodexProviders`）只接受这个类型。字符串在运行时仍是原值（可直接给 IPC 用），品牌只
 * 存在于类型层 —— 这正是「新调用点绕过判定就编译不过」的机制。
 */
export type SshRemoteHostId = string & { readonly [SSH_REMOTE_HOST_BRAND]: true };

/**
 * 把任意 `remoteHostId` 收敛成「真 SSH 主机」或 `null`。
 *
 * `null` 的语义是「这不是 SSH 执行主机」（本地 / device-link / `mcpr:`），调用方必须走各自的
 * 通用路径，**不得**把它当作「SSH 主机还没连上」。
 */
export function asSshRemoteHostId(
  remoteHostId: string | null | undefined,
): SshRemoteHostId | null {
  if (!remoteHostId) return null;
  // 判据与主进程 `classifyRemoteSessionTransport` 逐字一致：共享前缀常量，且畸形 `mcpr:`
  // 同样留在 MCPRouter 一侧（主进程 don't 把它当 SSH 主机，见 remote-session-routing.ts）。
  return remoteHostId.startsWith(MCPR_REMOTE_HOST_PREFIX)
    ? null
    : (remoteHostId as SshRemoteHostId);
}

/**
 * 「按 SSH 执行主机读远端 Codex 清单」这条探针的入口判据。
 *
 * `null` 表示「不走 SSH 探针」（本地 / device-link / mcpr）：
 *   · 只有 Codex 需要这条探针（Claude / Pi 的清单来源与本机目录无关）；
 *   · device-link 的模型面走被控端隧道，与 SSH 主机互斥。
 */
export function resolveRemoteCodexModelHostId(input: {
  remoteHostId?: string | null;
  agentKind?: AgentKind | null;
  deviceLinkDeviceId?: string | null;
}): SshRemoteHostId | null {
  const { remoteHostId, agentKind, deviceLinkDeviceId } = input;
  if (agentKind !== 'codex') return null;
  if (deviceLinkDeviceId) return null;
  return asSshRemoteHostId(remoteHostId);
}

/**
 * 新建任务草稿「要不要为这个目标建 SSH Codex 目录」的入口判据。
 *
 * 除 Codex 之外，草稿还会在用户**首次打开模型选择器**时按需读一次远端 Codex 清单（这样统一
 * 面板里也能列出那台 SSH 主机上的 Codex 型号），所以这里不按引擎收窄；但 device-link 目标与
 * `mcpr:` 一律返回 `null`：前者的目录走被控端隧道，后者的模型面就是本机目录。
 *
 * 2026-11-23 的假告警正是漏了这一层：`mcpr:` 被当成 SSH 主机，主进程按设计拒绝，选择器把
 * 拒绝渲染成「无法读取远程设备上的模型」。
 */
export function resolveSshCodexCatalogHostId(input: {
  remoteHostId?: string | null;
  deviceLinkDeviceId?: string | null;
}): SshRemoteHostId | null {
  if (input.deviceLinkDeviceId) return null;
  return asSshRemoteHostId(input.remoteHostId);
}
