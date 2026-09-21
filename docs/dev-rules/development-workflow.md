# 开发工作流：worktree、提 PR 与 Review

> **状态**：权威开发规则（authoritative）
> **读取时机**：在 Cindy 内嵌的 worktree 会话里工作、准备提交或直推、或做 code review
> 之前

本文细化根 [`../../AGENTS.md`](../../AGENTS.md) 的「通用工作流程」「Git 与交付」两节，补上
worktree 会话契约、提交组织、直推 `main` 的额外门禁与 review 严重度口径，不重复根文件
已有的通用流程。

## 1. Dogfooding：在本仓 worktree 会话里工作

如果你是 Cindy 内嵌的 agent，且 cwd 位于 `<baseRepo>/.cindy-worktrees/<name>`（或迁移前的
`.xdt-worktrees/<name>`）下（会话级 git worktree），遵守以下契约：

- **先等 checkout 完成再确认依赖**：worktree 创建返回时后台完整 checkout 可能仍在进行；
  跑任何 `pnpm` 命令前先确认 `package.json` 存在且 `git status` 干净。worktree 与 baseRepo
  共享 `.git` 但**不共享 `node_modules`**，缺失就先 `pnpm install`（首次可能数分钟，注意
  命令超时）。
- **你的编辑对运行中的 app 无效**：Vite HMR 只 watch 启动 dev 实例的那个 checkout，
  worktree 下的改动既不热更也不随重启生效。「改了没反应」不是 bug。开发过程中的增量验证在本
  worktree 内跑 `pnpm --filter desktop typecheck` / 定向 `vitest run`；**提交前仍须通过
  第 2 节的提交前测试门禁**。需要运行时验证时 commit + push 后交用户（你无法重启宿主）。
- **宿主 app 日志不在你的 cwd 下**：dev 日志在启动 checkout（通常是 baseRepo）的
  `apps/desktop/logs/`，读日志时拼 baseRepo 的绝对路径。
- **结束前必须 commit**：会话被删除或归档时脏 worktree 会先存内容快照再删目录。**PR
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
的备用目录。原地重建普通目录的现有行为保持不变，不把失败的 Git
worktree 建成空目录或自动切到项目根继续修改代码。

恢复说明随本轮消息传给 Agent，明确原路径、文件未恢复和当前运行位置；消息被接受
之后才消费说明。SSH 不使用本机备用目录；设备互联和手机沿用被控 Desktop 的发送链。
实现见 `apps/desktop/src/main/maker-ipc/workingDirectoryRecovery.ts` 与 `register.ts`，
回归见 `workingDirectoryRecovery.test.ts` 和 `makerSendTransaction.test.ts`。

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
    文件则跳过 workspace 单测。改到测试调度（`scripts/test-workspaces*`、
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
  - **跨 worktree 重型门禁串行**：本地运行 `unit`、`all`、`db`、`git-integration`
    tier 时，`test-workspaces.mjs` 会按 Git common-dir 获取同仓共享的 loopback TCP 锁；
    同一 clone 的后到进程会打印持有者 PID、tier 与 worktree 路径并排队，不同 clone
    互不影响。`guard` tier 和 CI／GitHub Actions 不参与。等待超过 15 分钟以退出码 `75`
    结束，表示测试尚未运行，不得当作测试失败排查；排队是正常状态，不要 kill 后重跑。
    只有明确确认资源足够且需要有意重叠时，才可追加 `--no-lock` 作为逃生口。
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
