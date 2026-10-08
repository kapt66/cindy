import type { AgentKind } from '@cindy/model-providers';

import { MCPR_REMOTE_HOST_PREFIX } from '../../shared/meka-router';

/**
 * 「按 SSH 执行主机读远端 Codex 清单」这条探针只接受**真正的 SSH host**。
 *
 * 上游 `340888c77d` 加了这条探针（main 的 `maker:remote-ssh:list-codex-models` →
 * `remote-ssh/codex-model-list.ts` 的 `readSshCodexModelList`），它把**一切失败**折叠成
 * `SSH_EXEC_FAILED: Unable to read remote Codex models; reconnect and retry`。主进程侧有
 * 三个 `mcpr:` 可达的调用点当时漏了 transport 分类（已在 `register.ts` 用共享分类器修掉，
 * 见 `docs/dev-rules/mcpr-remote-session-routing.md` 第 7 条），但**渲染层同样可达**：
 * `ChatInput` 把任意 `remoteHostId` 当成「SSH Codex 主机」喂给这个探针，于是 MCPRouter 的
 * Codex 会话会：
 *   1. 打出一条 `SSH_EXEC_FAILED`（用户看到「无法读取远程设备上的模型」toast）；
 *   2. 让 `remoteModelListBlocked` 恒为真 —— **连发送都被拦下**；
 *   3. 用空清单当远端模型面 —— 模型选择器里少掉一大批模型（本机普通会话正常）。
 *
 * **为什么 MCPRouter 侧不能用远端清单**：MCPRouter 的 Codex bridge 只带**本机** AI Gateway
 * key（`main/maker-host/mcpr-codex-capability.ts` 的 `buildRemoteCodexBridgeHeader`：
 * `readClaudeApiKey()` + 网关代理参数，`resolveRemoteCodexCredentialMode` 也把 mcpr 判为
 * `'gateway-key'`），所以它的模型面与本机一致，正确来源是**本机目录**，不是远端探测。
 * SSH 相反：那台主机有自己的登录与 `CODEX_HOME`，必须问它自己。
 *
 * 收成一个纯函数：这条规则有多个消费方（`ChatInput` 的 `sshCodexHostId`、
 * `loadSshSessionModelSelection` 的调用方），各写一遍条件正是本仓反复吃过的
 * 「同一规则多处漂移」形状。（注：`lib/mcprEngineSurface.ts` 曾是同款做法的另一个例子，
 * 已随 2026-10-09 的 Pi + MCPR 支持一起删除 —— 那条「MCPR 位置收掉 Pi」的规则本身不存在了，
 * 不是被合并进本文件。）
 *
 * 返回值沿用调用方已有的语义：`null` 表示「不走 SSH 探针」（本地 / device-link / mcpr）。
 */
export function resolveRemoteCodexModelHostId(input: {
  remoteHostId?: string | null;
  agentKind?: AgentKind | null;
  deviceLinkDeviceId?: string | null;
}): string | null {
  const { remoteHostId, agentKind, deviceLinkDeviceId } = input;
  // 只有 Codex 需要这条探针（Claude / Pi 的清单来源与本机目录无关）。
  if (agentKind !== 'codex') return null;
  // device-link 的模型面走被控端隧道，与 SSH 主机互斥。
  if (deviceLinkDeviceId) return null;
  if (!remoteHostId) return null;
  // `mcpr:<instance.id>` 是隧道身份，不是 SSH pool 条目。判据必须与主进程的
  // `classifyRemoteSessionTransport` **逐字一致**：用共享前缀常量、且**保留畸形 `mcpr:`**
  // 在 MCPRouter 一侧（主进程刻意不把它当 SSH 主机，见 `remote-session-routing.ts`）。
  // 渲染层 import 不到主进程模块，所以这里镜像同一个谓词；`remoteCodexModelHost.test.ts`
  // 用矩阵断言两者对同一批输入永远一致，避免这条规则在两处漂移 —— 这正是本轮故障的形状
  // （主进程三处已分类、渲染层漏了）。
  return remoteHostId.startsWith(MCPR_REMOTE_HOST_PREFIX) ? null : remoteHostId;
}
