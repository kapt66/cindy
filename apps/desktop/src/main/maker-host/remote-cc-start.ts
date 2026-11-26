/**
 * 远端 Claude Code（cc-mgr）会话的 `startParams` 口径 —— 唯一判定点。
 *
 * ## 为什么单独成文件
 *
 * cwd 归属是**产品事实**（PSB 远程工作区的 cwd 由宿主按服务端会话记录决定，Cindy 手里的
 * `/psb-remote/<目录>` 只是本机虚拟路径），但它的消费点在 `maker-host/index.ts` 的巨型
 * 组装闭包里，闭包本身无法单测。把这条纯决策抽出来，既让 `remoteCcQueryFactory` 只剩
 * 「调它 + 开隧道」，也让回归测试能直接跑行为而不是读源码文本。
 *
 * 历史教训（2026-11-26 实报）：这里曾用第二个分类器 `parsePsbRemoteHostId(remoteHostId)`
 * 判 cwd。畸形 `psb:`（`psb:` 后面为空）在 `classifyRemoteSessionTransport` 里**仍然是
 * psb transport**（前缀命中），但 `parsePsbRemoteHostId` 返回 `null` → 虚拟 `/psb-remote/…`
 * 被原样下发 → daemon 侧 SDK 用不存在的目录 spawn `claude` → query 在首个 turn 前终止、
 * 本地会话被自动关闭。凡是「这是哪种 transport」的问题都只能问
 * `remoteSessionHostOwnsCwd`（→ 能力表），不要在调用点再解析身份。
 */

import { remoteSessionHostOwnsCwd } from './remote-session-routing.js';

/**
 * 远端 cc 隧道的启动参数：cwd 归宿主时改成 `'.'`（daemon 自己的 cwd == 宿主工作区），
 * 其余 transport（`mcpr:`）的 `workingDir` 是实例上的真实路径，原样保留。
 *
 * 只改 `cwd`，不动其它字段；返回新对象以免调用方拿到被改写的入参。
 */
export function resolveRemoteCcTunnelStartParams<T extends Record<string, unknown>>(
  remoteHostId: string,
  startParams: T,
): T {
  if (!remoteSessionHostOwnsCwd(remoteHostId)) return startParams;
  return { ...startParams, cwd: '.' };
}
