/**
 * 会话页 composer 的**禁用判据**（唯一来源）。
 *
 * 为什么抽成纯函数：`disabled` / `settingsLocked` 的表达式曾经直接写在
 * `CCAgentSessionView` 的 JSX 里，不变量（「整段远端交接期间 composer 必须保持禁用」、
 * 「PSB 占用/终态时输入置灰」）只能靠对**源码文本**做正则断言来守住——加一个合法门禁就要
 * 逐字改测试，而真正的行为一次都没被验证过。这里让不变量成为可执行的布尔函数：
 *
 *   · `remoteHandoffPreparing`（device-link 起目标 / 消费 pending 的整段 await）为真时禁用；
 *   · `psbInputBlocked`（远程工作区被他人占用、客户端离线、工作区未就绪）为真时禁用；
 *   · `readOnly` / review 会话保持既有语义；
 *   · 门禁只增不减：新增一个禁用原因必须加在这里，并补一条矩阵用例。
 */
export interface ComposerGateInput {
  /** 只读会话（历史回放 / 只读入口等）。 */
  readOnly: boolean;
  /** 远端交接（device-link 建目标 / 首条 pending 消费）在途：整段期间 composer 必须禁用。 */
  remoteHandoffPreparing: boolean;
  /** 会话来源；'review' 是只读审阅会话。 */
  sessionSource: string | null;
  /** 远程工作区（PSB）外部阻断：被他人占用 / 客户端离线 / 工作区未就绪 / 会话终态。 */
  psbInputBlocked: boolean;
}

/** composer 是否整体禁用（不可输入、不可发送）。 */
export function composerIsDisabled(input: ComposerGateInput): boolean {
  return (
    input.readOnly
    || input.remoteHandoffPreparing
    || input.sessionSource === 'review'
    || input.psbInputBlocked
  );
}

/**
 * composer 的设置类操作是否锁定（模型 / 目录 / 权限等）。
 *
 * 与 `disabled` 分开：队列编辑也锁设置，但不锁“继续输入”；PSB 外部阻断两者都锁
 * （输入发不出去，改设置也没有意义）。
 */
export function composerSettingsAreLocked(
  input: ComposerGateInput & { queueEditing: boolean },
): boolean {
  return (
    input.readOnly
    || input.sessionSource === 'review'
    || input.queueEditing
    || input.psbInputBlocked
  );
}
