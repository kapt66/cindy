/**
 * cc-mgr 远端运行时版本不匹配的**跨进程线协议**。
 *
 * 背景：MCPRouter 容器内嵌的 cc-mgr daemon 与桌面端各自硬编码同一个 manager bundle
 * 版本号，握手时用**精确字符串相等**比对（`packages/maker-cc-manager/src/server.ts`）。
 * 两边不一致时 daemon 返回
 *
 * ```
 * [INVALID_BUNDLE_VERSION] client bundle 0.0.10 does not match server bundle 0.0.9
 * ```
 *
 * 这条报文随后被 lazy-create 的兜底包装成 `LAZY_CREATE_FAILED`，用户看到的是一串
 * **无法据此行动**的自由文本（既不知道哪边旧，也不知道该做什么）。本模块把它规约成
 * 一个带稳定 marker 的线消息，让渲染层能换成「远端运行时需要升级（0.0.9 → 0.0.10）」
 * 这类可操作提示，而 Main 侧只需要在包装失败的**唯一出口**调用一次
 * `projectCcMgrRuntimeVersionMismatch`。
 *
 * 设计约束：
 *   - 规约是**幂等**的（已规约的消息再规约一次不变），因为消息可能经过多层包装；
 *   - 版本号只接受 `[A-Za-z0-9._-]` 且长度有界，避免把 daemon 的自由文本当版本渲染；
 *   - 认不出形状时**原样返回**，绝不改写别的错误——这条报文是全仓错误面的一部分，
 *     误伤比不识别更糟。
 */

/** 稳定 marker：Main 产出、渲染层识别，两侧都不得改写字面量。 */
export const CC_MGR_VERSION_MISMATCH_MARKER = '[REMOTE_CC_MGR_VERSION_MISMATCH]';

/** 版本号允许的字符集与长度（`0.0.10` 这类语义版本 + 少量自定义形态）。 */
const VERSION_RE = '[A-Za-z0-9][A-Za-z0-9._-]{0,31}';

/**
 * daemon 原始报文的形状：`client bundle <X> does not match server bundle <Y>`。
 *
 * 前缀（`[INVALID_BUNDLE_VERSION] `）与 `Error: ` 包装都不参与匹配：形状本身就是
 * 唯一的锚点，多写前缀反而会在报文措辞变化时漏认。
 */
const DAEMON_MESSAGE_RE = new RegExp(
  `client bundle (${VERSION_RE}) does not match server bundle (${VERSION_RE})`,
);

/** 规约后的线消息：`[REMOTE_CC_MGR_VERSION_MISMATCH] client=<X> server=<Y>`。 */
const PROJECTED_RE = new RegExp(
  `\\[REMOTE_CC_MGR_VERSION_MISMATCH\\]\\s*client=(${VERSION_RE})\\s+server=(${VERSION_RE})`,
);

export interface CcMgrRuntimeVersions {
  /** 本机（客户端）期望的 manager bundle 版本。 */
  clientBundle: string;
  /** 远端 daemon 实际运行的 manager bundle 版本。 */
  serverBundle: string;
}

/** 从**已规约**的线消息里读出两边版本（幂等入口）；形状不符 → null。 */
export function readProjectedCcMgrRuntimeVersions(
  message: string,
): CcMgrRuntimeVersions | null {
  const match = PROJECTED_RE.exec(message);
  if (!match) return null;
  return { clientBundle: match[1], serverBundle: match[2] };
}

/** 从 daemon 原始报文里读出两边版本；未规约的原文与已规约的线消息都认。 */
export function readCcMgrRuntimeVersionMismatch(
  message: string,
): CcMgrRuntimeVersions | null {
  const projected = readProjectedCcMgrRuntimeVersions(message);
  if (projected) return projected;
  const match = DAEMON_MESSAGE_RE.exec(message);
  if (!match) return null;
  return { clientBundle: match[1], serverBundle: match[2] };
}

/** 渲染层判定「这是不是远端运行时版本不匹配」——只看 marker，不解析数字。 */
export function isCcMgrRuntimeVersionMismatchError(error: string): boolean {
  return error.includes(CC_MGR_VERSION_MISMATCH_MARKER);
}

/**
 * 把 daemon 报文规约成带 marker 的线消息。
 *
 * 认不出形状时**原样返回**；已经是规约形态时也原样返回（幂等）。调用点应该是
 * 「把底层异常包装成 host-send failure」的唯一出口，而不是每一处 catch。
 */
export function projectCcMgrRuntimeVersionMismatch(message: string): string {
  if (isCcMgrRuntimeVersionMismatchError(message)) return message;
  const versions = readCcMgrRuntimeVersionMismatch(message);
  if (!versions) return message;
  return `${CC_MGR_VERSION_MISMATCH_MARKER} client=${versions.clientBundle} server=${versions.serverBundle}`;
}
