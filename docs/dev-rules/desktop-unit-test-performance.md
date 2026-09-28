# Desktop 单测性能基准

> **读取时机**：调整 Desktop Vitest worker、测试分池或根级单测资源配额前

## 可复现命令

`benchmark:desktop-workers` 复用 `test-workspaces.config.mjs` 中 Desktop unit tier 的
完整排除规则，不会混入 DB、migration、guard 或 `*.bench.ts`。

```bash
pnpm benchmark:desktop-workers -- --workers 1,2,4,8 --runs 1 --output <report.json>
```

报告包含机器信息、墙钟、文件数、测试数、文件耗时 P50/P95/P99 和最慢文件。调整 worker
或分池前后必须使用同一 checkout、同一机器和同一测试范围比较；单次数据需同时保留稳定性
结果，不得只挑最快的一次。

## 单测超时默认值（2026-09-23 第三轮上游同步后实查）

`apps/desktop/vitest.config.ts` 的 `test` 段按**平台**给两套默认值，两者都不是「一律 60s」：

```ts
testTimeout: process.platform === 'win32' ? 60_000 : 5_000,
hookTimeout: process.platform === 'win32' ? 60_000 : 10_000,
```

- `testTimeout`：**win32 60s、非 win32 5s**。
- `hookTimeout`：**win32 60s、非 win32 10s**。
- 只放宽 win32 的原因（同文件内的既有注释）：主进程用例要跑回环 HTTP、真实 git 子进程与
  重型 `vite-node` 模块图，在全量套件的 worker 池争用下会非确定性地越过 vitest 默认值
  （不同轮次红的不是同一条）；Linux / macOS 保留较紧的默认值，真挂起才能及时暴露。
  同一段注释记录了 2026-09-20 把 Windows 侧预算从 20s 调到 60s 的实测依据。
- 需要更长预算的用例仍自带更高的**逐文件**超时，会覆盖这里的默认值。
- **引用时必须写明平台**：把 60s 说成「Desktop 单测的默认超时」会让 Linux / macOS 上真实生效的
  5s（`testTimeout`）/ 10s（`hookTimeout`）被读错；判断「是不是超时抖动」也要按平台取基准。

## Windows 命令行长度预算与 tier 分块（2026-09-24 第三轮上游同步后实查）

**事实**：`vitest run <每个被选文件一个显式路径>` 的命令串会撞 Windows 命令行上限。本机
（Windows x64、zh-CN 控制台代码页）实测有效上限约 **7.2k 字符**：vitest 在
`approxLen≈7436` 时报 `The command line is too long.`（回显走控制台代码页，日志里是 GBK
乱码，门禁只看到 `COMMAND_FAILED`），`approxLen≈7100` 正常。`apps/desktop` 的 `db` tier
有 **125 个显式文件**、整串约 **7.4k–7.5k 字符**（本机实测 pnpm 参数串 7418 字符，原始报错
命令串约 7524 字符），正是触发点；症状是 vitest 根本没启动就被 cmd.exe 拒绝，而不是测试
失败。

**机制**：`scripts/test-workspaces.mjs` 的 `planPnpmArgBatches` 把 pnpm 参数拆成三段——
共享前缀（`--dir <abs>` / `exec` / bin / pool 与 shard 标志 / `--passWithNoTests`）、可切分
的显式文件列表、全部 `--exclude` 后缀。整串长度按 `commandLineLength`（每参数长度加分隔符）
计算，超过 `maxInlineCommandLength(platform)`（**win32 6000 / POSIX 120000**）时按贪心装填
切成若干批**顺序执行**并聚合结果；不超限时**恰好 1 批、零额外进程，行为与旧实现逐字节相同**。
阈值是「**pnpm 参数口径**」：`resolvePnpmInvocation` 之后还要加上 `node` + `pnpm.cjs`（或
cmd.exe 包装）前缀与引号开销，6000 相对 cmd.exe 的 8191 硬上限仍留出约 **1.1k 余量**。

**不变量**（分块不得破坏其中任何一条）：

- 分块**不得减少被跑文件**：各批文件列表的并集与顺序等于原始选择，不重、不漏。
- **每批都带全量 `--exclude`**，否则某一批会把本该排除的文件跑起来。
- 任一失败 ⇒ tier 失败；失败**不提前中断**，剩余批次照跑，日志因此是完整的。
- 带 `--shard=i/n` 的 tier **不分块**：`--shard` 自己也切分文件列表，逐批重复它会跑到与
  请求不同的子集；`packageScript` tier 本就没有逐文件列表，同样只有 1 批。
- 单个文件在这一预算内装不下时仍单独成批并**大声失败**，不静默丢文件。

**如何取证**：`node --test scripts/__tests__/test-workspaces.test.mjs` 覆盖零行为变化
（batch=1 的 `args` 与 `buildPnpmArgs` 逐字节相同）、分块并集/顺序、每批全量 `--exclude`、
每批长度上限、退化单文件、shard 与 `packageScript` 不分块、失败传播（第 2 批失败仍有全部
批次的调用记录）以及单批输出逐字节一致；分块路径通过注入 `platform` / `maxCommandLength`
在任意宿主上都会被执行。多批时 runner 逐块打印
`CHUNK i/n <cwd> <tier> test (N files, M chars)`（失败块表头另带 `chunk i/n`），
`printSummary` 打印 `chunks: N sequential invocations`。

**未覆盖项（如实登记）**：

- POSIX 阈值（120000）使这层保护在 macOS / Linux 上**惰性**：清单里没有任何 tier 会越过
  它，因此分块路径**无法在那两个平台用真实 tier 验证**；单测是靠注入平台阈值覆盖的，不算
  生产证据。
- `--related` 模式下 `relatedFiles` 同样进入 `planPnpmArgBatches`（`fileArgs` 换成相关源码
  列表），但当前**没有任何 tier 会在 related 模式下越过阈值**，该分支只有纯函数级覆盖，
  没有真实 tier 的触发记录。

## 2026-07-26 Windows 基线

环境：Windows x64、Node v24.15.0、32 available CPUs、63.8 GiB RAM。测试范围为
1,213 个文件、13,062 个测试。

| Workers | 结果 | 墙钟 | 相比上一档 | 相比 1 worker |
|---:|---|---:|---:|---:|
| 1 | 通过 | 710.6s | — | 1.00x |
| 2 | 通过 | 353.7s | -50.2% | 2.01x |
| 4 | 通过 | 183.5s | -48.1% | 3.87x |
| 8 | 通过 | 108.3s | -41.0% | 6.56x |

8-worker 复跑为 114.9s，说明该档在本机约为 108–115s。2-worker 首次运行曾在 116.7s
触发一次 `ERR_IPC_CHANNEL_CLOSED`，重跑 353.7s 通过；worker 数降低本身不能消除
Vitest/tinypool fork 通道的偶发退出问题。

随着 workers 增加，所有文件自身耗时之和从 247.0s（1 worker）升至 317.5s（8
workers），说明存在资源争用；但墙钟仍持续下降。综合速度、资源和实现复杂度，正式配置
采用单池最多 8 workers；低于 8 CPU 的主机按 `os.availableParallelism()` 自动下调。

## 长尾分布

8-worker 复跑中，最慢 200 个文件按路径聚合：

| 路径 | 文件数 | 文件耗时之和 |
|---|---:|---:|
| `src/main/git-review/**` | 10 | 180.7s |
| `src/main/__tests__/**` | 27 | 49.7s |
| `src/renderer/**` | 92 | 31.8s |
| `src/main/hook-control/**` | 1 | 11.9s |

最慢的单文件主要是创建真实 Git 仓库或子进程的测试：

| 文件 | 8-worker 文件耗时 |
|---|---:|
| `git-review/__tests__/stageOps.test.ts` | 42.1s |
| `git-review/__tests__/pushOps.test.ts` | 28.6s |
| `git-review/__tests__/branchReader.test.ts` | 23.8s |
| `main/__tests__/codexFileRewindExecutor.test.ts` | 23.4s |
| `git-review/__tests__/ipc.test.ts` | 22.0s |
| `git-review/__tests__/diffReader.test.ts` | 19.5s |

因此分池优先按“真实 Git／子进程长尾”和“其余测试”隔离，而不是只按 node/jsdom 环境
机械拆分。

## 多 worktree 资源协调

Desktop 测试按成本拆成默认层与显式层：

- `standard`：普通单测，以及一条代表性的真实 Git smoke；默认 `test:unit` 只运行这一层。
- `git-integration`：文件名为 `*.git-integration.test.ts` 的完整真实 Git 覆盖，由
  `pnpm test:git-integration` 显式运行，并通过 global setup 获取以 Git common-dir
  派生的本机回环端口锁。

远端 `client-ci` 以独立并行 job 在每个 PR、`main` 与 `meka/main` push 和手动触发时运行完整
`git-integration` 层；本地提交前门禁默认是 `test:unit:related`，修改真实 Git 行为时可按需
显式补跑完整层。CI 仍跑完整 `test:unit`。本仓 related 基准是产品集成分支
（`origin/meka/main` / `meka/main`），不是上游 `origin/main`；拿错基准会把 Meka 产品线
delta 里的 lockfile / `package.json` 当成这次改动并静默退回全量。

`meka/main` 是 Meka 的集成分支，直推、不开 PR，因此它的 push 触发是**该分支唯一的自动化
门禁**：Meka 的 GitLab 发布流水线里不再自带验证（原 `verify:windows` 是本 workflow 内容
的子集，却要占用与开发机共用的 Windows runner 跑 45-60 分钟并压在发布关键路径上）。
这条 push 触发同时让 `db:validate` 拿到真实的 migration 冻结检查：它以
`github.event.before`（该分支上一次的 tip）为基线，而 GitLab 侧原先把基线钉成被验证 commit
自身、该子检查实际恒为空转。

因此同一仓库的多个 worktree 可以并行完成默认单测；只有显式运行完整 Git 集成层时才排队：

- 同一主仓的 worktree 共享 common-dir，因此只有重型层排队执行。
- 独立仓库不共享锁，不会互相阻塞。
- 锁只监听 `127.0.0.1`，不发起业务网络请求；测试进程退出后由操作系统自动释放，不产生
  stale lock 文件。
- 无 `.git` 的源码归档按 checkout 实际路径派生锁，不因缺少 Git 元数据而启动失败。
- 两个 project 的 include/exclude 必须互补；默认层以低成本 smoke 守住主链路，完整层保留
  index、patch、hook、ref、worktree 等组合语义。
- Vitest 3.2 的 inline project 不会自动继承根 CLI 的 `--exclude`；配置必须把这些排除项
  显式传入两个 project，确保 unit、DB、migration 等 tier 的测试边界保持不变。

真实 Git 测试的 fixture 还应优先复用 `src/test/vitest/testDirectoryTemplate.ts`：每个测试
文件初始化一次不可变基准仓库，再为每个用例复制独立目录。默认层不复制完整矩阵；完整层
不得为了提速把需要验证 Git index、patch、hook 或 ref 语义的集成覆盖全部 mock 掉。

2026-07-28 在 Windows 上测得旧 `resource-intensive` 范围为 22 files、219 passed /
3 skipped，墙钟 252.07s；其中 15 个真实 Git 文件的测试耗时合计占主要长尾。该数据是拆层
前基线，后续比较必须分别报告默认 smoke 与显式完整层，不能把两者相加后宣称默认层变快。

## 分池评估

分池把 21 个 Git／子进程长尾文件放入 `git-io`，其余文件放入 `standard`；两个池并发，
且完整覆盖仍为 1,213 个文件、13,062 个测试。

| 配置 | 结果 | 总墙钟 | 说明 |
|---|---|---:|---|
| 单池 8 forks | 通过 | 108.3–114.9s | PR3 单池基线 |
| 3 forks + 5 forks | 通过 | 126.9s | standard 池成为长板 |
| 2 forks + 6 forks | 通过 | 111.6s | 与单池持平 |
| 2 threads + 6 forks | 通过 | 114.8s | standard 使用 threads 无收益 |
| 2 threads + 7 forks | 通过 | 111.1s | git-io 成为长板 |
| 3 threads + 7 forks | 连续两次通过 | 102.2–103.0s | 最快分池候选 |

另一次 `2 forks + 7 forks` 中，standard 池在 100.6s 完成，但 git-io 池触发
`ERR_IPC_CHANNEL_CLOSED`，因此不作为有效性能样本。

最快分池候选的平均墙钟为 102.6s：

- 相比现有单池 4 workers 的 183.5s，减少 80.9s（44.1%）。
- 相比单池 8 workers 的平均 111.6s，减少 9.0s（8.1%）。
- 但 worker 上限会从 8 提高到两池合计 10，并引入分区维护和双执行器复杂度。

因此分池相对单池 8 workers 的额外 8.1% 收益不足以抵消资源与维护成本，正式配置不采用
分池，保留单池最多 8 workers。
