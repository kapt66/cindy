# 开发工作流：worktree、提 PR 与 Review

> **状态**：权威开发规则（authoritative）
> **读取时机**：在 Cindy 内嵌的 worktree 会话里工作、准备提交或直推、做 code review，
> 或决定开发中得到的知识该写到哪里、整理与迁移规则文档之前

本文是仓库交付约定的正本，维护 worktree 会话契约、DCO、提交组织、**提交前测试门禁与门禁
时机**、直推 `main` 的额外门禁、review 严重度口径、项目知识归属与文档整理原则；根
[AGENTS.md](../../AGENTS.md) 保留关键约束与阅读入口。提交、push 和 PR 的时机由用户或宿主
工作流决定，本文不额外授权外部写操作。自动审阅是建议性检查，口径与修改入口见
[REVIEW.md](../../REVIEW.md)，不替代人工 review 或 CI 门禁。

> **保留 Meka 口径（2026-09-25 第四轮上游同步裁决，第六、七轮维持）**：上游把「提交前
> 测试门禁」放宽为「提交前验证」（已按影响面完成等效定向验证即不要求重跑整仓）。本仓
> **不采纳**该放宽——`meka/main` 是直推集成分支，唯一自动化门禁是 `client-ci` 的 push 触发，
> 推送前的本地门禁是唯一闸门。详见第 2 节「提交前测试门禁」，记录见
> [`../migrations/2026-09-25-origin-main-to-meka-main.md`](../migrations/2026-09-25-origin-main-to-meka-main.md)。

## 1. Dogfooding：在本仓 worktree 会话里工作

Cindy 创建或重建托管 worktree 时，会尽力向 Git 本地 `info/exclude` 追加所用托管目录的
根级排除规则，避免基础仓库的未跟踪扫描进入这些目录。保留已有规则，不修改项目
`.gitignore`，不影响已跟踪文件；写入失败不阻止创建或恢复。不扫描、排除任意第三方目录。
实现见 `apps/desktop/src/main/worktree/managedWorktreeExclude.ts`。

仓库根有 `.multibox.toml`、且本机能运行 `git multibox --version` 时，托管 worktree 的
创建、目录丢失后的重建和删除改用 Multibox（`git multibox`，`git worktree` 的替代品）：
一次给出带引擎缓存（Unity `Library/`、Rust `target/` 等）的完整目录，不带 `--no-checkout`
（带上会退回普通 worktree、不复制缓存），也不做分段检出和后台 checkout；`.worktreeinclude`
匹配的文件只补缺、不覆盖 Multibox 已克隆的副本；删除带 `--wait`，不带 `-f` 时同样拒绝删除
有改动的工作区。两个条件缺一就走原生 `git worktree`，普通仓库不额外启动探测进程。按是否
启用选择，不按失败回退：Multibox 报错原样显示给用户，不改用 `git worktree add` 重试。
同一次创建中途失败的回滚不再逐字节比较 ignored 文件：此时它们全是本次刚从 base 克隆的
引擎缓存（常见十万级文件、数十 GB），比较只会长时间占住该仓库的创建队列。
Multibox 建完才返回（2026-11-16 实测 Unity 项目 67–88 秒），所以远程创建（另一台电脑或
手机发起）的等待上限是 5 分钟（`packages/device-link/src/allowlist.ts` 的 `worktree:create`），
期间控制端一直显示创建中，建好后才建任务，Agent 不会进入半成品目录；未更新的控制端仍按
60 秒超时。Desktop 的创建中卡片（`WorktreeCreatingOverlay`）超过 3 秒后显示已等待时长：本机
新建在任务页替代输入框；远程创建时显示在新建页输入框下方，Goal 创建时显示在目标弹窗内。
手机新建页暂无同款卡片与计时。

正常回收后的完整 Git 快照恢复也使用 Multibox：直接在最终目录检出快照 commit 并携带缓存，
再只还原原 HEAD、index 和分支连接，保留 staged、unstaged 与未跟踪文件；不经临时路径搬移，
避免缓存内的绝对路径失效。回收记录的可选 `multiboxRestore` 标记和预留目录身份覆盖中断重试；
恢复期间出现新的文件、暂存或 HEAD 变化时保留现场与快照，不覆盖用户改动。部分删除目录及
历史加密归档仍使用原有保护式修复。旧 stash 恢复先让出 Multibox 刚复制且仍与 base 相同的
本地配置，再还原快照里的用户版本；配置已被修改则保留并停止恢复。
现状缺口：
- `git multibox add` 报告的环境变量（如 `UNITY_PROJECT_PATH`）不会注入任务的 Agent 进程
  （Codex 多个任务共用一个后台进程），需要的工具在工作区内运行 `eval "$(git multibox env)"`。
- 预创建放弃与创建失败补偿（`preserveDirty` 路径）仍逐字节比较 ignored 文件；在 Multibox
  的 Unity 仓库上会很慢，且主仓库编辑器改动缓存后通常判为保留，未回收的远程预创建账本会
  阻止该设备再次远程创建 worktree。

实现见 `apps/desktop/src/main/worktree/multibox.ts`、`restoreRecovery.ts`，回归见
`apps/desktop/src/main/__tests__/worktreeManagerCreate.test.ts`、`worktreeRestore.test.ts` 与
`worktreeRecovery.git-integration.test.ts` 的 Multibox 用例。

如果你是 Cindy 内嵌的 agent，且 cwd 位于 `<baseRepo>/.cindy-worktrees/<name>`（或迁移前的
`.xdt-worktrees/<name>`）下（会话级 git worktree），遵守以下契约：

- **先等 checkout 完成再确认依赖**：worktree 创建返回时后台完整 checkout 可能仍在进行；
  跑任何 `pnpm` 命令前先确认 `package.json` 存在且 `git status` 干净。worktree 与 baseRepo
  共享 `.git` 但**不共享 `node_modules`**，缺失就先 `pnpm install`（首次可能数分钟，注意
  命令超时）。
- **你的编辑对运行中的 app 无效**：Vite HMR 只 watch 启动 dev 实例的那个 checkout，
  worktree 下的改动既不热更也不随重启生效。「改了没反应」不是 bug。开发过程中的增量验证在本
  worktree 内跑 `pnpm --filter desktop typecheck` / 定向 `vitest run`；**提交前仍须完成
  第 2 节的提交前测试门禁**。需要运行时验证时，在本 worktree 用
  `pnpm restart:desktop:remote -- --isolated=@worktree` 起一个属于本 worktree 的独立实例
  （不会停掉宿主，也不与其他 checkout 抢默认 `dev` 沙箱），成功以
  `DESKTOP_DEV_VERDICT=ready` 为准，细则见 [`desktop-development.md`](desktop-development.md)。
- **宿主 app 日志不在你的 cwd 下**：dev 日志在启动 checkout（通常是 baseRepo）的
  `apps/desktop/logs/`，读日志时拼 baseRepo 的绝对路径。
- **会话结束与工作区保留**：是否 commit 由用户或宿主工作流决定，不能仅因会话结束
  强制提交。会话被删除或归档时脏 worktree 会先把改动和新文件存进 Git 快照再删目录；
  被 `.gitignore` 忽略的文件（依赖、构建产物）和 worktree 内克隆／初始化的嵌套仓库不保留。**PR
  merged／closed 不等于 Cindy 会话已结束**：只要 owning session 仍 active，任何外部 Git
  cleanup 都必须跳过该 `.cindy-worktrees` / `.xdt-worktrees` 目录与本地 `cindy/*` / `xdt/*` 分支，交给
  用户显式归档／删除会话时回收；禁止手动 `git worktree remove` 造成 active session 的 cwd
  悬空。手动干活时可放 `.worktree-keep` 哨兵文件豁免自动回收。
- **stale prebundle 白屏**：给带依赖的内部包新增 export 后，运行中实例可能因 stale Vite
  prebundle 报 `does not provide an export named X` 白屏——需要受影响实例完整重启
  （re-optimize），提醒用户即可，不要误诊为自己的代码问题。

## 2. 提 PR 与直推 `main`

### 托管 worktree 不可用时的任务连续性

本机任务发送前优先按原分支和快照恢复托管 worktree。仅在确认目录缺失、且成功枚举
Git 引用后确认原分支不存在时，使用当前 owner 的
托管对话目录继续运行，保留数据库里的项目工作目录和 worktree 绑定；备用目录按任务 ID
与原工作目录的哈希定位。重启后重新优先恢复原 worktree；仍失败则复用同一备用目录，
不搬运或删除其中的文件。DB / Git 临时错误、绑定不匹配与快照冲突保留原目录重试，
不登记备用目录。同一运行期不自动切回。明确换到另一工作目录时不复用旧绑定
的备用目录。普通目录仍可原地重建，但当前 userData 的 `owners/` 下只允许重建当前
owner 的目录；旧 owner 的缺失路径沿用目录不可用结果，不自动映射、搬运或清理账号数据。
已有旧路径（含用户自行建立的 junction）不因该检查而改向。创建前复核账号边界和恢复记录，
探测或排队期间切账号或清除恢复记录后不再发起创建；共享 I/O 队列在实际写入前复核，
不同恢复尝试的创建请求不共用旧记录的检查。已经交给文件系统的操作无法撤销。不把失败的 Git
worktree 建成空目录或自动切到项目根继续修改代码。

恢复说明随本轮消息传给 Agent，明确原路径、文件未恢复和当前运行位置；消息被接受
之后才消费说明。SSH 不使用本机备用目录；设备互联和手机沿用被控 Desktop 的发送链。
实现见 `apps/desktop/src/main/maker-ipc/workingDirectoryRecovery.ts` 与 `register.ts`，
回归见 `workingDirectoryRecovery.test.ts` 和 `makerSendTransaction.test.ts`。

### 门禁时机：迭代期不跑门禁，交付时一次跑完

门禁是**交付动作**，不是编辑循环的一部分。默认节奏如下，agent 与人类都适用：

- **迭代期（写代码、改文档、调实现）不跑门禁。** 用户要求 commit、push 或最终验收之前，
  不运行 `test:unit:related` / `test:unit` / `test:all`、包级 `typecheck`、全仓套件，也不跑
  design／i18n／白名单／DCO 等检查。改一点就跑一次门禁会把时间全花在门禁上：单次
  `test:unit:related` 在本机约 1.5–2 分钟，改十轮就是十几分钟纯等待；而中间态的绿／红对
  最终提交没有增量证据价值，反而让「改代码」变成门禁的附属动作。
- **交付时一次跑完。** 准备 commit、push 或用户要求最终验收时，按「提交门禁」一节一次性
  执行完整门禁（相关单测 + 各包 typecheck），再按风险追加验证。门禁只在**最终代码**上跑，
  结果才代表要交付的那个状态。
- **用户显式要求时立即跑。** 用户说「跑门禁」「验证一下」「看下测试」「测试过了吗」时，
  按用户指定的范围立即执行，不受本节奏约束。
- **唯一例外：为决策取证。** 当某个实现方向依赖尚未确定的运行时行为，不实测就无法决定
  怎么写时（例如「这个 API 到底返回什么」「这个 schema 迁移会不会冲突」），可以跑**最小
  定向检查**——单个测试文件、一个最小复现脚本，或一次只读探测。这类检查的目的是拿到决策
  依据，不是证明交付质量，因此：跑完即停、不顺手扩大到全量、并在汇报里明确说明它是取证而
  非门禁。判断标准是「不跑就写不下去」，而不是「跑一下更安心」。
- **哪些操作不算门禁**：读代码、读测试、读文档、grep、单文件语法检查（如 `node --check`）、
  `git status` / `git diff` 等只读探查，随时都可做——它们的成本与收益和门禁完全不同。

这条节奏与「提交前测试门禁（硬性要求）」不冲突：后者规定**提交前必须跑什么**，本节规定
**什么时候跑**。提交前那一次仍然必须完整执行，任何一项失败都不得提交。

### 提交门禁

- 本仓默认 **PR-first**：代码和文档通常从非默认分支通过 PR 进入 `main`；直推 `main` 只由
  具备 bypass 权限的维护者明确选择，并执行本节的额外门禁。
- **提交必须按功能组织**：在首次 `git add` 或创建 commit 前，先盘点工作区并写出 commit
  plan；按用户可感知能力、独立行为或明确契约边界拆成可单独 review 的提交，不得仅按文件
  类型机械拆成“代码／测试／文档”，也不得因为改动来自同一工作树或准备一次性交付，就把
  多个功能压进一个提交。一个功能对应的实现、测试和事实文档应进入同一个提交；确有共享
  基础设施时，可先形成不夹带上层产品行为的独立基础提交。每个提交都应保持可构建、可验证，
  提交说明准确描述该提交本身。开始暂存后若发现新的功能边界，必须重新调整 staged 内容，
  不能用一个笼统 commit 收尾。用户明确要求 squash、fixup 或单提交交付时才可例外，并在
  交付说明中写明。
- PR 的 Title／Description 以 [`../../.github/PULL_REQUEST_TEMPLATE.md`](../../.github/PULL_REQUEST_TEMPLATE.md)
  为准（这次改了什么／怎么验证的／风险）；涉及 SQLite migration、system prompt、协议、
  原生层或跨平台差异时必须在「风险」里说明；涉及 UI 时必须在「UI 变化」注明引用的
  设计规范章节与约束（正本为 `docs/design-rules/DESIGN.md`）。CI 的
  `pr-design-basis` 会在 PR 变更命中 UI 路径时轻校验该字段（非空、引用了
  design-rules 文档，或「不涉及：<理由>」豁免；判定逻辑见
  `scripts/check-pr-design-basis.mjs`），但通过 CI 不代表内容合格，质量仍由
  review 把关。Reviewer 只看 Title + Description 决定要不要 review，写不清直接退回。
- **DCO 签名门禁（硬性要求）**：每个 commit 都必须带 `Signed-off-by` trailer，其中的名字
  与邮箱都要与 commit 的 author（或 committer）一致——`git commit -s`，或先跑一次
  `pnpm dco:install-hook` 装上 hook 让后续提交自动补签（正本 `.githooks/prepare-commit-msg`；
  `git commit` 本身没有自动签名的配置项，`format.signOff` 只作用于 `git format-patch` /
  `git am`）。这条对 agent 自动提交、worktree 会话内的收尾 commit 一律适用。
  - PR 上的权威门禁是 **DCO GitHub App** 的 check：它校验该 PR 的每个 commit，豁免
    merge 与 bot，不追溯历史；`.github/dco.yml` 开了 remediation commit，因此漏签也可以
    不改写历史（格式见 `CONTRIBUTING.md`）。
  - 提交前自查用 `pnpm check:dco`（`scripts/check-dco.mjs`，范围 `merge-base..head`）。
    它的判定刻意对齐 App 但**不识别 remediation commit**：本地通过则 App 必过，反之不然。
    改这个脚本时不要放宽 name／邮箱比对，否则会出现「本地绿、PR 红」。
  - 自动 review 沙箱中的平台合成 HEAD 不属于真实 PR 提交；对它运行本地 DCO 检查的失败
    不构成缺签证据。以 PR 的 DCO App check 与真实提交范围（`origin/main..PR head`）为准。
  - 漏签不要重新造一份提交：用 `git commit --amend -s --no-edit` 或
    `git rebase --signoff <base>` 补签后 `git push --force-with-lease`。
- **提交前测试门禁（硬性要求）**：无论是提 PR 还是直接 commit，提交前都必须在本地跑完
  仓库根 `pnpm test:unit:related`（只跑这次改动能影响到的单测），并对本次改动涉及的每个
  package 跑 `pnpm --filter <包名> run --if-present typecheck`（`<包名>` 用该 package 在
  `package.json` 里的 `name`，如 `desktop`、`@cindy/maker-core`；没有 `typecheck`
  script 的 package 该步自动跳过），全部通过后才允许提交；任何一项失败都不得提交，
  必须先修复。worktree 会话内的 commit 同样适用。唯一例外是**防丢数据的兜底保存**：
  宿主删除／归档会话时自动存的内容快照（见第 1 节），以及会话必须收尾、测试却来不及
  修好时的收尾 commit——后者 commit message 必须标注 `WIP`，且在门禁通过前不得
  push、不得提 PR。
  - **相关单测怎么选**：`test:unit:related` 看相对**产品集成分支**的已提交、已暂存、未暂存
    和未跟踪文件。本仓优先 `origin/meka/main`，其次 `meka/main`；没有 Meka 产品分支的上游
    Cindy checkout 才落到 `origin/main` / `main`。不要拿上游 `origin/main` 当 Meka 日常开发
    的 related 基准——那会把整条产品线 delta（含 lockfile / `package.json` / Vitest 配置）
    都当成“这次改动”，门禁会静默退回全量。同一包里用 Vitest `related` 只跑会引用这些文件
    的测试；改了会被别的包依赖的公共包源码时，依赖方跑该包自己的整包单测。只改文档等非代码
    文件则跳过 workspace 单测；但 **`i18n/GLOSSARY.md` 与 `docs/legal/notices/` 是有内容断言的
    生成产物，仍要跑根级 runner 验证，不能仅因扩展名是 Markdown／文本而跳过**。改到测试调度（`scripts/test-workspaces*`、
    `scripts/test-related.mjs`、`scripts/test-gate-lock.mjs`）、`package.json`、
    `pnpm-lock.yaml`、`pnpm-workspace.yaml`、各包 `vitest.config.*`、单测 CI 工作流，或
    算不出 git 基准时，打印原因并退回全量 `pnpm test:unit`。上游同步进 `meka/main` 必然会改
    lockfile / `package.json`，因此同步交付仍然按全量安排时间。批量改产品术语仍须全量，
    因为有测试直接锁中文文案。GitHub CI 不受此影响，仍跑完整 `pnpm test:unit`。
  - **完整单测的外层超时**：默认相关门禁通常比全仓短，但一旦退回全量，`pnpm test:unit`
    正常执行仍可能超过数分钟。调用全量门禁的 agent／自动化工具不得使用 120 秒或更短的
    绝对超时；未知当前耗时时，外层兜底超时至少设为 15 分钟。工具支持后台运行或 yielded
    process handle 时优先使用该模式并短轮询进度，不要因为调用端停止等待就误判失败、杀掉
    仍在正常运行的测试或重复启动一轮。Vitest 的单测试例超时仍由各 package 配置控制，不受
    这条外层约束影响。
  - **workspace 有界并行**：`test-workspaces.mjs` 默认最多并行
    `min(4, os.availableParallelism())` 个普通 workspace；每个普通 Vitest workspace 只使用
    1 个 worker。Mobile 使用完整的 4-worker 配额；Desktop 使用基准验证过的单池最多
    8-worker 配额，低于 8 CPU 时按 `os.availableParallelism()` 自动下调。重型 workspace
    必须独占执行，避免外层并发与内部 worker 池相乘。
    排查并发相关问题时可用
    `pnpm test:unit -- --workspace-concurrency=1` 临时退回 workspace 串行；该参数只改变
    workspace 调度，不减少测试覆盖。
  - **跨 worktree 排队默认关闭（2026-09-25 第四轮上游同步，采纳上游；代码证据
    `scripts/test-gate-lock.mjs` 的 `shouldUseTestGateLock` 现要求显式 `lock`）**：
    只有主动传 `--lock` 的本地重型测试命令才参与同仓共享 loopback TCP 锁；
    `--no-lock` 保留兼容，不能与 `--lock` 同时使用。锁按 Git common-dir 区分 clone，
    只监听 `127.0.0.1`，退出后自动释放，不同 clone 互不影响。直接运行 Desktop Vitest
    也不再隐式加第二层锁。选择排队后，等待超过 15 分钟以退出码 `75` 结束，表示测试
    尚未运行，不得当作测试失败排查；排队是正常状态，不要 kill 后重跑。
    `guard` tier 和 CI／GitHub Actions 不参与。锁只协调同样选择排队的进程，不能限制
    未选择排队的入口；有意统一预算时由使用者或宿主协调各入口。
  - **如实记录结果（2026-09-25 第四轮上游同步，采纳上游非削弱表述）**：本次改动导致的
    失败须修复；既有或环境故障要说明证据、影响和未完成项，不伪造通过、不删除或放宽
    有效断言；**未执行的检查项和原因必须如实记录**（本仓由本节与当期同步报告的
    「未验证 + 原因」登记承担）。完整测试与远端必需检查仍由 CI 和合并规则保障，本地
    定向验证不能冒充完整 CI 通过。需要保存未完成工作时可作 `WIP` commit（口径见本条
    正文：门禁通过前不得 push、不得提 PR）。
  - **Agent 环境变量**：workspace runner 启动测试前清掉 Agent 终端可能带着、会改变测试结果
    但不属于被测代码的变量（`NODE_ENV`、`NODE_DEBUG`、`CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL`、
    `CINDY_INPUT_HANDOFF_ROUTE`），并在输出里列出清掉了哪些。新发现同类变量时加进
    `scripts/test-workspaces.mjs` 的 `AGENT_ENV_TEST_POLLUTANTS`，不要只在对话里口头排除。
  - **长测试调用与输出**：耗时不确定的检查优先后台运行并保留进度。工具结束等待不等于测试
    失败，不因等待时间较长重复启动或终止仍在正常运行的测试；外层超时按选定范围和本机情况
    设置。输出较长时写进日志文件再读取定位失败项，不因终端截断而整轮重跑。
- **在门禁之上按风险追加验证**：跨模块、高风险或基础设施改动追加更广泛验证（如仓库根
  `pnpm test:all`），**最终以 CI 门禁为准**。不得通过 skip、删除或弱化测试制造通过；
  PR「怎么验证的」一节必须**如实**填写，没跑不许写已跑。
- **直推 `main` 的额外门禁**：push 前由独立 reviewer 对最终 diff 做一次对抗性 review，对照
  `docs/` 下规则找实际问题；发现 P0／P1 必须先修复并重新 review，直到没有 P0／P1。commit
  可以先创建，但 push 的必须是 review 通过的最终 commit。

## 3. Review 严重度口径

对照 `docs/` 下各规则与 `.github/PULL_REQUEST_TEMPLATE.md`（以现行内容为准，不凭记忆）：

- **核对受影响的文档**：改动改变已有行为时，结合实现和测试核对对应权威文档中的旧结论；
  发现冲突就在本次改动中修正，并在相关说明旁链接实现或测试，便于后续核对。不涉及文档
  变化的 PR 无需修改文档，也无需另写经验总结。
- **经验回写到已有依据**：纠正和排障发现说明错误或不完整时修原文；说明正确但入口遗漏时
  补入口或触发条件；能自动验证的问题优先补回归测试。一次环境故障不默认升级为长期规则。

- **P0**（不改不能合）：红线／崩溃／数据丢失／跨平台失效／安全。
- **P1**（本次必须修但不阻断流程）：明显 bug／规范违反／影响面没处理干净。
- **P2**（可选优化 / 风格偏好）：不报。

发现 P0／P1 必须先修复再合入或推送。

## 4. 上游同步 merge 的静默丢失门禁

把上游 `origin/main` 合进 `meka/main` 时，**冲突清单不是完整的迁移范围**。真正危险的是
Git 不报的那些：

- 上游新增的能力（文件或整块代码）而本产品线从未碰过 → Git 认为无事发生，
  解决结果里没有它。**这类丢失永远不会出现在冲突清单里**，且如果代码和它的测试被一起
  解成旧版本，测试还会全绿；
- 两侧都改过、解决时整体取了自己那一侧 → Git 只报“已解决”；
- 生成物（`pnpm-lock.yaml`、drizzle snapshot）被手工解决。

2026-08→09 那次同步就踩过第一条：`hook-control` 的 request-ledger / ack-reactions /
turn-delivery 整组丢失，`typecheck` 是唯一信号。因此同步交付前**必须**跑：

```bash
pnpm audit:merge                      # merge 进行中：审 index（commit 将包含的内容）
pnpm audit:merge -- --worktree        # 审工作区实际文件（含未 stage 的手工修复）
pnpm audit:merge -- --merge-commit HEAD   # merge 已提交：审那个 merge commit
```

判定与处理：

- **BLOCKER**（未解决冲突／冲突标记残留）——必须修完再继续。
- **DROPPED**（一侧实质新增的内容在结果里缺失）——**必须逐条确认**。确认是
  “接受上游删除”“被上游新实现取代的孤儿清理”“有意移除”等合理形态后，用
  `--allow <path>` 记入本次豁免；确认是误删就恢复内容。**不得直接忽略。**
- **REVIEW**（结果整体等于某一侧、或疑似按编号顺移）——逐条确认另一侧没丢东西。
- **GENERATED**（生成物被改动）——提示性质，不阻断；按其提示重新生成并跑对应校验
  （`pnpm install` / `pnpm --filter desktop db:generate` + `db:validate`），不要手解。

该脚本只读 git 对象与工作区，不写任何文件。它与「提交前测试门禁」并行生效：
`pnpm test:unit` 证明行为没坏，本门禁证明**没有东西被静默丢掉**——两者都不能替代对方。

结构审计只覆盖「文件、整块代码被丢」这一层。它**抓不到语义层面的静默覆盖**：上游改了
决策函数、序列化形态或状态机语义，Meka 侧调用点的前提随之失效，而两边各自都自洽、
冲突标记为零（2026-09 同步的两起 P0 都是这个形态）。因此同步完成后、得出任何交付或
发布结论之前，还必须**实际运行**并逐项走完
[`meka-whitelist-verification.md`](meka-whitelist-verification.md)（Meka 能力白名单与
合并后验证清单）：那份清单定义「Meka 专属能力」的验收范围，**清单内全绿才判定可以安全
接纳这批上游**。三者的关系是互补而非替代——`audit:merge` 管结构、`test:unit` 管实现
自洽、白名单清单管语义未退化。

**完成判定（硬性）**：合并**只有**在按该清单实跑并逐项给出结论后才算完成。除维护者
书面接受的「未验证 + 原因」外必须全部通过；**读过清单、只跑 `test:unit`、或凭 diff 判断
都不算执行**，未实跑就宣告完成等同于虚报。

同步完成后，除迁移总账外还要在 `docs/migrations/` 下当期同步报告里登记：基线 SHA、
DROPPED／REVIEW 的逐条确认结论与豁免理由，以及白名单清单每一项的结论（通过 / 失败 /
未验证+原因）。

高误报会让人绕过门禁，所以脚本刻意做了降噪（内容归一化、token 兜底、生成物与二进制
跳过、搬迁识别）；改动它的判定逻辑时必须同步跑
`node --test scripts/__tests__/audit-merge-resolution.test.mjs`。

## 5. 项目知识放在哪里

另一位贡献者，或另一台机器上的 Agent，接手时需要知道的信息，默认属于仓库。仓库是这些信息
的维护入口；个人记忆、全局 Skill 和聊天可以指向它，不能是唯一存放处。本节只针对开发过程中
的工作知识，与 Cindy 产品自身的记忆功能无关。

| 信息 | 维护位置 |
| --- | --- |
| 实现约束、固定输入、自动判定 | 代码、配置与测试；能机判的同时落到 lint、测试或契约脚本 |
| 工程规则、环境与工具链的坑、排错结论 | `docs/dev-rules/` 对应专题；单模块的放嵌套 `AGENTS.md`；根 `AGENTS.md` 只留触发条件 |
| 产品行为裁决与理由 | `docs/product-rules/` 对应专题；跨专题的放 `core-product-principles.md` |
| 视觉、交互裁决与理由 | `docs/design-rules/`；带日期的取舍记进 `design-decision-log.md` |
| 已发生的回归、复现与验证证据 | 对应测试；任务体验类归 `docs/dev-rules/session-regressions.md`；大图和录屏挂到 issue 或 PR |
| 未完成的改进 | issue 或计划文档，写明缺口与验收条件，不只记在个人待办 |
| 个人目录、设备标识、账号偏好、凭据、私聊原文 | 本地；仓库只放脱敏后的结论 |

从聊天或本机排错里提炼时，去掉身份、绝对路径和凭据，保留可复现条件、根因、处理办法、验证
范围与仓库入口。写入前对照代码和现有文档核实现状，不把已经过期的个人记忆原样搬进来。同一条
规则只在一处维护正文，其他位置引用。

本节回答「写到哪里」，不新增「每个 PR 都要写文档」的义务：是否需要回写仍按第 3 节「核对受影响
的文档」「经验回写到已有依据」判断。

## 6. 文档的信息与组织

文档只保留 Cindy 特有、无法从通用知识得知的信息：选择及其原因、实现约定、具体行为与参数、
边界、例外、历史裁决和现状差距。精确契约必须写出，不能只写成哲学。

整理只改排列、索引和位置，不丢失、不弱化信息：原则解释取舍，专题保存细则，索引写清场景；
每项信息一个正本，动手前必须知道的约束在入口提醒。迁移时核对去向，保留条件、例外、强度
和读取时机，并更新引用。代码和测试验证契约，不替代说明。

常识可以省略，重复可以合并。排障得出的产品特有知识要保留，不因只发生过一次就删，也不
自动扩大为通用规则。信息过时或矛盾时，核实并注明被哪项决定取代；目标与现状的差距明确
标注，不为迁就现状改写承诺。

根 `AGENTS.md` 每个任务都会完整加载。一句话放进去要同时满足：影响大多数任务；在知道该读
哪份专题之前就需要；链接不能替代。其余放对应正文，根文件只留触发条件与硬约束。

