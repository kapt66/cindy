# 通用工程规范（Desktop / 客户端）

> **状态**：权威开发规则（authoritative）
> **读取时机**：新增或修改 Desktop 日志、IPC 错误处理、main 侧业务逻辑与测试、
> 跨平台（macOS／Windows）相关行为、任何 UI 文案的 i18n 落地，或新增／修改动画与
> 界面加载时序等渲染性能相关行为之前

本文收拢一组适用于整个客户端的通用工程约束。IPC 的安全与授权边界另见
[`electron-security-and-process-boundaries.md`](electron-security-and-process-boundaries.md)，
UI 文案的语气与措辞另见 [`DESIGN.md`](../design-rules/DESIGN.md) 的 Voice & Content 一节，验证命令
见 [`desktop-development.md`](desktop-development.md)。

> **增量适用原则**：本规则约束新增和正在修改的代码，不要求为统一形式专项重构存量。
> 编辑既有代码时顺手对齐碰到的违规即可，不主动批量 grep 改造。

## 事实来源

| 内容 | 权威来源 |
|---|---|
| 统一日志模块 | `apps/desktop/src/main/logger.ts`（main）、`apps/desktop/src/renderer/lib/logger.ts`（renderer） |
| dev 日志目录 | 启动 checkout 的 `apps/desktop/logs/` |
| IPC 错误码枚举 | `apps/desktop/src/shared/ipc-errors.ts`（`IpcErrorCode`） |
| `throwIpcError` 实现 | `apps/desktop/src/main/utils/ipcValidate.ts` |
| Renderer 侧错误解码 | `apps/desktop/src/renderer/utils/ipcError.ts`（`extractIpcError`、`mapIpcErrorToI18nKey`） |
| 支持的语言与默认语言 | `apps/desktop/src/shared/locale.ts`（`SUPPORTED_LOCALES`、`DEFAULT_LOCALE`） |
| i18n 资源 | `apps/desktop/src/renderer/i18n/locales/<locale>/common.json` |
| i18n key 一致性门禁 | `scripts/check-i18n.mjs`（`pnpm check:i18n`） |
| **术语表（唯一事实源）** | `i18n/glossary.json`，人读版 `i18n/GLOSSARY.md` |
| 术语一致性门禁 | `scripts/check-i18n-glossary.mjs`（`pnpm check:i18n-glossary`） |

## 1. 日志

- 所有日志输出走统一日志模块，不要裸 `console.log`。
- dev 排查 bug 时，若问题能靠日志定位，优先在可疑路径加 DEBUG 级日志（走统一 logger），
  让用户复现一次后去日志目录定位。日志目录是启动 checkout 的 `apps/desktop/logs/`：先用
  Glob／ls 列出当前文件（文件名与 rotate 后缀会变），再读相关文件；cwd 不在仓库根时先
  确认仓库根再拼绝对路径。
- 问题确认后清掉临时排查日志，不要把它们留在仓库里。

## 2. IPC 错误协议

- main 进程 IPC handler 的错误必须用 `throwIpcError(code, message)`，禁止裸
  `throw new Error('xxx')`，也不要用 `return { ok: false, error: '...' }`。
- `code` 必须来自 `ipc-errors.ts` 的 `IpcErrorCode` 字面量联合，违规会被 typecheck 拦下；
  确需新 code 时先扩枚举，不要在调用点用 `as IpcErrorCode` 强转绕过。
- Renderer 端消费 IPC 错误统一走 `renderer/utils/ipcError.ts` 的 `extractIpcError` /
  `mapIpcErrorToI18nKey`，不要手写 `err.message.match(/\[XXX\]/)` 解码——跨进程序列化会丢
  `Error.code` 字段，协议靠 `[CODE] message` 编码 + Renderer 正则解码绕开这个限制，绕开
  就拿不到 code。
- **例外**：查询型 handler（list／scan／search 等）若失败时 Renderer 仍需 fallback data 或
  结构化 metadata 才能渲染，可保留 `{ success: true, ... } | { success: false, error, ...default }`
  模式。判断标准是“失败时 Renderer 是否需要结构化数据继续渲染”；需要就用 `{success}`
  风格，否则新 handler 默认走 `throwIpcError`。
- 不把堆栈、凭证、内部绝对路径或敏感响应原样返回 Renderer（安全细节见
  [`electron-security-and-process-boundaries.md`](electron-security-and-process-boundaries.md)）。

## 3. main 侧业务逻辑默认带测试

- main 是跨平台、跨进程边界的高风险层，新增或修改业务逻辑时默认同步补单测或回归测试；
  确实无法自动化时，在 PR 自测里写明原因和手工验证路径。
- IPC handler 的业务体（参数校验、`throwIpcError` 错误路径、maker-host／localDb／auth 等
  依赖交互）应抽成可注入依赖的纯 handler 或小函数，`ipcMain.handle` 只做 adapter，这样
  测试可用内存 harness 直接 invoke handler body，无需启动 Electron。
- 新增 handler 至少覆盖主路径与关键错误路径；修改已有 handler 时补上能复现本次风险的
  回归用例。

### 3.1 测试资源与分层

默认 `test:unit` 必须适合多个 worktree 同时运行。新增、生成或改写测试时遵守：

- 默认单测优先使用进程内依赖注入、内存 fake 和表驱动用例；同一模块的重复初始化应合并到
  文件级 fixture，不要为每个断言重复启动子进程、仓库、数据库或监听服务。
- 默认单测不得访问业务外网、真实云服务或开发者账号。需要验证 HTTP／WebSocket 协议时，
  优先直接调用 handler；确需真实 socket 时只绑定 loopback，使用 `listen(0)` 的系统分配
  端口，并在 `afterAll`／`finally` 中关闭。禁止固定端口。
- 临时文件必须放在 `os.tmpdir()` 下由 `mkdtemp` 创建的唯一目录并可靠清理；禁止复用仓库外
  的固定目录、用户配置目录或跨 worktree 共享文件。测试不得修改全局 Git 配置、系统代理或
  其它机器级状态。
- 默认单测中真实 Git 只保留一条代表性 smoke；覆盖 index、patch、hook、ref、worktree 等
  组合语义的完整用例命名为 `*.git-integration.test.ts`，由
  `pnpm test:git-integration` 显式执行。不得因 review 或补回归把完整真实 Git 链路重新放回
  默认层。
- SQLite migration、runtime asset、严格性能计时等已有专用 tier 的资源测试继续进入对应
  tier。新增资源类型若无法进程内隔离，必须先在 `scripts/test-workspaces.config.mjs` 声明
  专用 tier，并按实际共享资源增加跨 worktree 协调；不要在测试文件里自行发明全局锁。
- “合并测试”只合并重复 fixture 和等价输入矩阵，不合并语义不同的失败路径，也不以删除断言
  换速度。若单文件仍有大量真实 I/O，迁移 tier，而不是继续扩大 timeout。
- **共享 Windows 发布 runner 上，Windows 默认单测预算按"能容纳重模块图首导入"设**：
  一批用例的成本**几乎全部**来自第一次 `await import(...)`／`vi.resetModules()` 重新导入
  一个大模块图（不是断言、也不是真实 I/O），空载 6–10s、8 worker 满载时越过 20s。
  2026-09-20 这类超时连续两轮把 `verify:windows` 卡红
  （`updateService > does not add metadata work to darwin startup`、
  `codexAuthIsolatedSandbox > 开关开:不建共享硬链…`），而它们在单文件复跑时全绿 ——
  典型的"看起来像断言失败、其实是预算不够"。`apps/desktop/vitest.config.ts` 的 win32
  默认值因此定为 **60s**（Linux/macOS 仍 5s）：vitest 的 timeout 仍然拦真挂起，只是晚 40s。
  新增此类"首导入很贵"的用例时给它自己的显式预算，不要指望默认值；反之，**不要把这条
  当成放宽断言或掩盖真挂起的许可** —— 把用例压到 5s 预算能稳定重现超时、且单跑明显变快，
  才是"只是预算问题"的证据。

`scripts/__tests__/test-workspaces.test.mjs` 是 tier 边界的可执行契约；调整测试命名、include
或 exclude 时必须同步更新并运行 `pnpm test:runner`。

### 3.2 新增测试的价值门槛

测试数量不是覆盖质量。后续 Agent 新增或改写测试时，每个测试文件在 PR 描述或邻近注释中都
要能回答「它保护哪个真实行为、历史 bug 或稳定契约」。没有可观察行为变化的重构、文档和
纯类型调整，不为了凑覆盖率新增测试。

- **测生产行为**：优先调用被测模块的公开函数、handler 或真实组件入口，断言用户可观察的
  结果、错误语义、权限边界、数据持久化或协议结构。禁止复制生产函数、常量表、JSX 或
  Tailwind 字符串后再与副本比较；只证明“源码里出现了某段字面量”的测试不算行为覆盖。
- **回归测试先红后绿**：修 bug 时先用最小用例复现修复前的失败，再验证修复后的通过。若
  只能测试静态契约，必须写出规则编号和保留原因，并把它放进明确的 guard／静态检查位置，
  不要把普通布局、类名、import 或调用顺序扫描伪装成 unit test。只包含跨文件静态契约的
  Desktop / Mobile 测试文件必须加入 `scripts/test-workspaces.config.mjs` 的 guard allowlist，并由
  CI 的 `pnpm test:guard` 执行；混合文件中的静态断言只有在保护权限、凭证、协议或竞态
  规则且无法从生产入口隔离时才保留，并在测试名或注释中写明失效后果。没有对应规则或
  失效后果的源码字面量断言直接删除。
- **控制文件数量**：同一领域的输入矩阵优先加入现有测试文件并使用表驱动；只有测试环境、
  生命周期、隔离资源或 tier 不同，才新建文件。一个文件只放一两个机械断言，或把同一行为
  拆成多个重复文件，必须合并或说明为什么不能合并。
- **不重复断言**：每条用例都应区分一个实际行为分支。只断言内部函数被调用，却不验证
  由此产生的用户可观察结果、错误语义、持久化或时序，通常没有独立价值；常量等于字面量、
  某个 class／属性存在、或重复同一 happy path 的用例应删除。调用、字面量或属性本身若是
  对外协议，可以保留，但要在测试名和注释中写明协议及失效后果。
- **隔离和分层**：默认 unit 使用进程内依赖注入、内存 fake；真实网络、外部进程、真实 Git
  矩阵、SQLite migration 和严格计时进入已有专用 tier。不要为了让 unit 变绿而把真实资源
  粗暴 mock 掉，也不要在测试里新增全局锁。
- **先查已有覆盖**：新增前先搜索相邻测试和相关入口；如果已有用例覆盖同一行为，只补缺失
  的输入或回归条件，不复制一套断言。删除候选测试时要确认剩余测试仍经生产入口覆盖该风险。

Agent 在提交新增测试前必须在 PR 描述或测试文件邻近注释中填清四项：被测生产入口和
用户可观察结果、对应的历史 bug／规则编号、现有覆盖为什么不够、以及最小失败输入和
所属 tier。四项有一项答不出来就不新增测试；修复后仍要保留能在回归前失败的最小断言，
不要用更多 happy path 来替代。

建议直接复制下面的模板填写；同一 PR 有多个测试文件时逐文件填写，不能用一句“补充覆盖”
代替：

~~~text
测试价值
- 生产入口与可观察结果：<调用哪个公开函数／handler／组件入口；用户或协议会看到什么>
- Bug／规则依据：<issue、回归提交或规则章节；没有就不新增>
- 现有覆盖缺口：<为什么相邻测试没有覆盖这个分支>
- 最小失败输入：<触发旧错误的最小输入、状态或时序>
- tier：<unit / guard / db / integration / e2e；为什么放这里>
- 实测耗时：<单独运行该文件的墙钟，例如 pnpm --dir apps/desktop exec vitest run <文件>>
~~~

用例的停止条件是覆盖完不同的结果分支：同一入口、同一结果只保留一个最小代表，更多
输入用表驱动表达；当新增用例不能指出新的结果、错误、权限、持久化、协议或时序差异时
就停止。不要设置“每个函数都要一个测试”或“覆盖率必须再涨一点”的数量目标，也不要
为了填满文件、提高测试条数或证明测试框架本身而新增用例。

评审可以直接要求删掉无法指出生产行为或契约的测试；“测试通过”本身不能证明它有价值。

#### 性能预算（与价值门槛同等强制）

单测的成本主要不在用例条数，而在每个文件的准备、收集（导入模块）和环境初始化。2026-10-16
实测 Desktop 每个分片的 worker 时间里，收集阶段与执行测试相当；一个逐用例重置模块的文件
（`codexProxyHost.test.ts`）就占全部文件耗时的约 10%，不重置时同样 285 条用例从 105 秒降到
7 秒。新增或改写测试时：

- **单文件预算**：新增或改写的单测文件单独运行应在 5 秒内（本机），超过 10 秒必须在 PR
  写明原因，并优先改用文件级 fixture、依赖注入或迁移 tier；不得用放宽 timeout 掩盖。
  「测试价值」模板里填写实测耗时。
- **模块只加载一次**：默认在文件顶部静态 import 被测模块。需要干净的模块级状态时，调用
  生产代码已有的 dispose／reset 或注入依赖；`vi.resetModules()` 只用于确实在验证「重启／
  重新加载」语义的边界，上一行写 `// reset-modules: <被隔离的状态>`，禁止放进
  `beforeEach` 或每个用例都会调用的 helper。
- **不做真实等待**：不用 ≥100ms 的 `setTimeout`／`sleep` 等异步结果，改用
  `vi.useFakeTimers()`、`vi.waitFor`／事件，或直接 await 被测 Promise。确需真实等待时上一行写
  `// real-wait: <原因>`。
- **环境按需**：只有真正渲染组件或操作 DOM 的文件才声明 `@vitest-environment jsdom`，纯逻辑
  留在 node 环境；jsdom 每个文件约多 0.5 秒初始化。
- **不新开小文件**：同一被测模块的新用例加进已有文件并用表驱动；每个新文件都要多付一次
  准备、收集和环境初始化。不超过 3 条用例的新文件必须说明为什么不能并入。
- **重 I/O 下沉**：真实子进程、真实 socket、真实 Git 或大量文件 I/O 让单文件超预算时，迁移到
  §3.1 的专用 tier，不要留在默认 unit。

**机器门禁**：CI verify 运行 `pnpm check:test-hygiene`（`scripts/check-test-hygiene.mjs`）并阻断
三类问题：没有写理由的 `vi.resetModules()`、没有写理由的 ≥100ms 真实等待、普通单测读取生产源码
文本（这类静态契约只能进 guard tier，不接受理由豁免）。存量计数记在
`scripts/test-hygiene-baseline.json`，只允许减少；修掉存量后运行
`node scripts/check-test-hygiene.mjs --update` 收紧基线。门禁从 GitHub PR／合并队列／push 事件
取得基准提交（`pull_request.base.sha` / `merge_group.base_sha` / `push.before`；事件缺字段直接失败，
不静默回退）；**本地**按当前分支自己的 `refs/remotes/origin/<branch>` 解析（`meka/main` → `origin/meka/main`），
可用 `--base <ref>` 显式指定，当前分支无远端时回落 `origin/main`（直推集成分支因此不会因为
「继承了上游基线文件」而本地恒红）；逐文件、逐规则拒绝基线上调，手改 JSON 也不能放行。
只有确认基准提交确实没有基线文件时才允许首次登记；基准缺失、读取失败或基线格式错误均失败。
若当前分支已有高于 Git 基准的旧基线，先修复对应源码违规再运行 `--update`；更新器对新生成的
基线同时核对本地与 Git 基准上限，允许收紧修复，不允许把仍存在的新违规登记为存量。

### 3.3 路径断言的跨平台宪法

测试必须先区分路径代表的语义，不能把当前开发机的路径表示误当成跨平台事实：

- **宿主文件系统路径**：传给或来自 Node `fs`、Electron、子进程 `cwd` 等本机 API 的路径，
  期望值必须用 `path.join`／`path.resolve`／`path.relative` 构造；按被测语义使用
  `path.normalize`，涉及软链、junction 或物理文件身份时使用 `realpath` 后比较。禁止在这类
  断言中把 `/` 或 `\` 写成固定期望，也禁止只为让断言通过而把整段输出统一
  `replace(/\\/g, '/')`——整段替换会掩盖产品代码返回了错误路径格式，并可能误改 URL、转义
  内容或其它非路径文本。
- **逻辑路径**：URL／URI、远程 POSIX 路径、归档条目、wire protocol，以及契约明确规定用
  `/` 的 repo-relative 路径，不跟随宿主分隔符。这类测试可以固定写 `/`，但测试名称、类型或
  邻近注释必须明确它是稳定协议格式，不能仅凭字符串“看起来像路径”就归入例外。
- **模拟目标平台**：验证 Windows／POSIX 路径算法时使用 `path.win32`／`path.posix`，或把目标
  platform／path API 注入被测函数；禁止只 mock `process.platform` 后继续调用由宿主系统决定的
  默认 `path` 实现。Windows 大小写折叠也只在被测契约明确需要时进行，不能作为所有路径断言的
  通用归一化。
- **平台能力差异**：symlink、junction、文件权限等能力先做 capability probe。宿主确实不支持
  时可以跳过真实文件系统用例，但核心语义必须在支持该能力的受控 CI 平台继续实跑，或通过
  依赖注入／纯函数用例保留等价覆盖；禁止按 `process.platform` 大面积跳过后让整个 CI 矩阵
  失去相应回归保护。

PR 门禁必须在 Windows 上用多个并行分片（当前为 4 个）完整覆盖 `pnpm test:unit`；所有分片的
并集必须等价于未分片的全量测试，且由稳定的汇总检查统一阻断。分片数可以按 CI 实测耗时调整，
但分片矩阵必须连续列出 1..N 并与 `XDT_UNIT_TEST_SHARD` 的 N 一致；只需执行一次的检查放在
独立并行 job，不叠加在某个分片上。`scripts/__tests__/dev-docs-contract.test.mjs` 锁住
该 CI 契约。不能用静态扫描“测试字符串是否含斜杠”代替 Windows 实跑，因为它无法可靠区分宿主
路径与逻辑路径。

测试验证 pnpm 子进程参数时，必须覆盖 Windows `.cmd`／`.bat` 包装路径：此路径通过 `cmd.exe`
和 `CINDY_PNPM_CMD_ARG_*` 环境变量逐项转发参数，不能把 `/c` 命令串误当成直接的 pnpm 参数数组。

### 3.3 随包资源「声明 vs 运行期读点」一致性门禁

`apps/desktop/src/main/__tests__/packagedResourceDeclarations.test.ts` 纯静态（只读源码／配置文本，不启动
Electron、不打包、不联网）对齐 `forge.config.ts` 的 `extraResourcesForTarget()` 声明集合与
`src/main/**`（含 `src/preload/**`）的运行期读点集合，校验：①读到的每个 `resources/<name>` 必须被声明
（违规报出 `文件:行`＋资源名＋修法）；②声明集合不得出现 `.gitignore` 标注**废弃**的路径（如
`resources/builtin-ghosts/`，防「顺手补声明」复活废弃通道）；③声明条目存在且非空；④抽取口径活性。

**为什么落在单测层**：`forge-meka-resources.ts` 的两个 assert 只强制写死的 `resources/meka` 一棵树，
且只在本地 `electron-forge make` 时跑；`.github/workflows/ci.yml` 的 client-ci **没有打包步骤**，
「CI 绿」不代表资源声明完整。本门禁不依赖打包产物，才能在 CI 生效。

**构建期生成物白名单**（不在源码树、由 `prePackage`／前置脚本现场 stage，豁免存在性校验，且必须
仍被 `.gitignore` 忽略）：`resources/cindy-source.json`(:36-37)、`resources/tools`(:35)、
`resources/cc-manager`(:38-39)、`resources/pi-manager`(:40)、`resources/anthropic-compat-proxy`(:41)、
`resources/remote-file-service`(:42)。`drizzle`、`resources/cindy-updater-runtime`、
`resources/cindy-meka-updater.exe` **已入仓**，走存在性校验，不入白名单。

**已知局限**：只做词法级匹配，抓不到常量拼接（`path.join(process.resourcesPath, SOME_CONST)`）、数组
展开、把资源根交给下游解析器再拼名、模板字面量名、以及不以 `resourcesPath` 结尾的资源根变量。
白名单与例外必须写理由，不得为让门禁变绿而扩白名单或减读点抽取范围。

**「已退役但仍被读取」豁免位**（2026-09-24 裁决）：唯一一条是 `builtin-ghosts` ——
`cindy-brain/index.ts:1151-1152` 读它，但该资源既不随包也不在声明集合里
（`.gitignore:208-209` 标注废弃）。**既不给它补声明**（补声明会被上面第②条断言拦下：那等于复活
废弃通道），**也不删读取路径**（退役后"整棵种子树不在"的一次性可观测信号正依赖这条读取才能观测到
缺失，见 `meka-whitelist-verification.md` §8.10）。因此门禁改用范围极窄的豁免位
`RETIRED_BUT_STILL_READ`，登记一条必须同时满足：①通道已被明确裁决退役；②读取的目的是观测"它
不存在"；③补声明被禁止。**豁免位带防腐栏**：用例断言每条豁免仍被读到、且不得出现在声明集合里
——读取路径一旦删除必须在同一次改动里删掉豁免，否则它会退化成永久盲区。新增豁免需在评审中
单独说明理由，不得为了变绿而扩表。

## 4. 跨平台双端兼容（macOS / Windows）

任何功能都必须同时考虑 macOS / Windows，并在两端做到最优性能。

- **路径与目录**：一律走 `path.join` / `path.resolve` / `path.sep`，禁止硬编码 `/` 或 `\`；
  用户目录走 `app.getPath('userData' | 'home' | 'temp')`，不拼 `~` 或 `%APPDATA%`。
- **子进程 / 原生二进制**：按 `process.platform` + `process.arch` 分发与加载；spawn 注意
  Windows 的 `.cmd` / `.exe` 后缀与 `shell: true` 差异；不要假设 POSIX 信号在 Windows 子
  进程生效，需要兜底显式 kill；env 变量名在 Windows 大小写不敏感、在 mac 敏感。
- **文件系统差异**：Windows 大小写不敏感、路径长度上限、文件锁与删除语义不同；涉及
  rename / unlink / 文件监听 / SQLite 文件迁移的逻辑必须两端验证。
- **测试里造目录符号链接必须按平台分派**：Windows 上 `fs.symlink(target, link)` 默认
  `type: 'file'` 需要 `SeCreateSymbolicLinkPrivilege`（普通账号没有，CI 机器也未必给），
  会以 `EPERM` 失败并把一个真实通过的用例报成红。目录链接统一写
  `process.platform === 'win32' ? 'junction' : 'dir'` —— junction 是同一类重解析点、
  同样指到目标树之外，「指向仓库/根目录外的链接必须被跳过」这类语义不变；
  既有约定见 `apps/desktop/src/main/__tests__/codexGlobalSkills.test.ts`。
  只有目标确实**不是目录**时才用 `'file'`，那种情况在无特权 Windows 账号上无法表达，
  必须在测试里显式说明并跳过，不得直接写裸 `symlink`。
- **loopback 端口必须避开 Fetch 标准 bad port**：任何"把 `http://127.0.0.1:<port>` 交给
  `fetch`（全局或某个 undici 实例，含被代理间接使用的）的调用方"都不能把端口选择完全交给
  `listen(0)` —— 内核只判端口空闲，不判客户端肯不肯用；命中 bad port 时报
  `TypeError: fetch failed` + `cause: bad port`，表现为**整条链路每个请求都失败**而非偶发
  超时。**Chromium 侧是同一份名单**：预览 URL 交给 `openExternal`（系统浏览器）或
  in-app 侧栏／iframe 时，用户看到的是 `ERR_UNSAFE_PORT`，页面本身却是好的 —— 排查时别
  只怀疑渲染。它同时适用于三类位置：
  - **生产代码**：本机起服务再把 URL 交给 SDK／子进程／浏览器的，用
    `listenOnFetchSafePort(server)` 绑定（`codexHttpBridge`、`file-browser/html-preview`）。
  - **测试代码**：`server.listen(0, …)` 起的 fixture／upstream 服务，随后被测试或被测代理
    `fetch`。**不得写裸 `listen(0)`**。注意：**测试本身不 binder、端口由被测生产代码绑**
    的情况（如 `html-preview.test.ts` 直接 `fetch(preview.url)`）由修生产代码一并覆盖，
    不要只在测试里绕。
  - **端口探测（probe-then-pin）**：探一个"空闲"端口再钉死给别的进程或客户端时，探测阶段
    就必须过这道判据 —— 钉死之后没有重选机会。**不得在测试里自造裸探测**，否则 OAuth
    回调那类用例会整段红。
  名单与绑定工具的**唯一 SSoT** 是 `packages/anthropic-compat-proxy` 的
  `isFetchBlockedPort` / `listenOnFetchSafePort`（`fetch-blocked-ports.ts`；该包自己绑
  loopback 时用同一份）。**不得另立第二份会漂移的端口黑名单**，也不要用
  `netsh int ipv4 set dynamicport` 当修复（只降低密度，不根治 —— 2026-09-20 实测本机段
  `1024-15000` 内含 19 个 bad port，`listen(0)` 命中率约 1/735；**名单里最大的端口是
  10080，所以 Windows 默认段 `49152-65535` 反而是安全的**，只有在动态段被改小到含低位
  端口时才暴露 —— 排查这类"只在某些机器上复现"的失败时先查 `netsh int ipv4 show
  dynamicport tcp`）。
- **性能基线以较弱一端为准**，不能“Mac 上流畅就过”。I/O 密集与渲染密集的关键路径要给
  出 Windows 上的可接受指标，优先选跨平台原生最优方案而非纯 JS polyfill。
- **快捷键 / 菜单 / 系统集成**（托盘、通知、窗口控制、全屏、`cmd` vs `ctrl`）按平台规范
  分别实现，不要把 Mac 交互照搬到 Windows。
- 改动可能影响平台行为时，在回复／PR 中说明“已分别考虑 macOS / Windows 的 X / Y”，
  未实测的平台标注待验证。

## 5. UI 文案与 i18n

任何 UI 文案的新增／修改／删除都必须走多语言体系，禁止界面里硬编码裸文案，禁止只改
一种语言。本节管“文案怎么落地进 i18n”，文案的语气／措辞见 `DESIGN.md` 的 Voice & Content。

- 资源在 `renderer/i18n/locales/<locale>/common.json`，语言由 `shared/locale.ts` 的
  `SUPPORTED_LOCALES` 定义（当前 `zh-CN` / `zh-TW` / `en` / `ja` / `ko` / `es` / `fr` / `de` / `pt-PT` / `pt-BR` / `zh-Hant-x-lzh` / `zh-Hans-x-lzh`），组件通过 `react-i18next` 的
  `t('<嵌套.key>')` 消费，单 namespace `common`。
- **新增**：复用已有嵌套分组选 key，组件用 `t('key')`，绝不写 `<div>保存</div>` 裸文案。
- **修改**：改某 key 文案时全部已支持语言同步更新，不要只改中文留其它语言旧值。
- **删除**：删 UI 时把对应 key 从全部 locale 一起删掉，不留孤儿 key。
- **文言版（繁 `zh-Hant-x-lzh`／简 `zh-Hans-x-lzh`）**：只能由用户手动选择，系统语言永不自动
  落到它；Intl 日期与数字按 `zh-Hant`／`zh-Hans` 格式化，缺 key 先回退 `zh-TW`／`zh-CN` 再回退
  英文。繁体版是译写正本，简体版由它转写生成（规则见 `i18n/classical-chinese-style.md`，含文风、
  术语表与必须保持白话的删除、权限、凭证、付款、安全文案）。选用文言界面时，每轮界面语言说明
  同时要求 AI 以文言作答，作答文风（唐诗、宋词等）在设置的语言卡片里选，登记在
  `packages/maker-shared/src/classicalReply.ts`；新增文风只需在该表加一项并补齐各语言的
  `settings.language.classical.styles.*` 文案。IM 渠道不套用文言作答风格。
- **翻译准确性**：`fallbackLng = 'en'`，缺 key 会静默回退英文。全部已支持语言都必须补齐并给出
  **准确**翻译，不留空、占位或“待校对”；ja / ko 没把握时先查证再写。
- **术语一致性**：写任何术语前先查 `i18n/GLOSSARY.md`。同一个概念在不同界面译法不一致
  是用户直接可见的质量问题（引入术语表时实测：162 个英文短语存在多种中文译法，反向
  227 条）。表里已裁决的术语**必须照用**，拿不准或表里没有的先在
  `i18n/glossary.json` 加 `status: "proposed"` 条目，别自己临时造一个译法。
- **中文变体命名**：语言列表、选择器、设置项里的 zh-CN / zh-TW 一律按书写体系命名——中文界面
  「简体中文」「繁体中文」，英文界面「Simplified Chinese」「Traditional Chinese」。不要直接用
  `Intl.DisplayNames` 生成的「中文（中国）」「中文（台湾）」这类按地区的名称（2026-10-28 裁决：
  按地区表述在中国大陆有政治风险）；用 DisplayNames 生成名称时对中文变体做显式覆盖。

### 5.1 术语表与门禁

- **数据正本**：`i18n/glossary.json`；人读版 `i18n/GLOSSARY.md` 由
  `pnpm i18n:glossary-doc` 生成，**不要手改**。同步门禁比较前会统一 CRLF／LF，避免
  Windows checkout 把内容相同的生成文档误判为过期。
- **两级状态**：`decided` 违反即阻断 CI；`proposed` 只告警，用于承载「已知不一致但
  尚未拍板」的术语——让清单可见可讨论，而不是靠脚本替产品做裁决。
- **三类规则**：禁用译法、保留英文术语的大小写形态、zh-CN 半角标点与三语省略号。
  标点规则的适用范围由现状数据定，不靠直觉——例如日文 UI 惯例本就用半角冒号，
  ja 不套用中文的全角规则。
- **存量**：`i18n/glossary-baseline.json` 冻结引入时的既有违规，**只减不增**；修好一条
  就从账上删一条，已修复却仍挂账会报错。新增违规一律阻断。
- **误报处理**：guard 已剥离 `{{插值}}`、URL、文件名，并把连字符视作词边界
  （`ssh-agent` 不会被判成产品 `Agent`）。仍需放行时用 `exempt`——完整路径精确匹配，
  或以 `.` 结尾的子树前缀；同形异义必须在 `note` 里写明理由。Codex 旧命名空间只允许
  保留在显式兼容实现及其回归测试中，测试代码的单双引号格式不影响该豁免；其它生产代码
  和测试夹具仍会被阻断。
- **门禁**：
  - `pnpm check:i18n` 校验 key 结构——缺 key、孤儿 key、跨 locale 类型冲突报错阻断；
    空值与“与默认语言完全相同”只发警告。
  - `pnpm check:i18n-glossary` 校验译文术语与标点，并检查 `GLOSSARY.md` 是否与术语表同步。
  - 两者互补：前者管「key 齐不齐」，后者管「词译得一不一致」，谁也替代不了谁。改
    i18n 后两个都要跑（CI 已强制）。
- **影子 catalog**：有几批不走 i18next 的手写多语 catalog，根脚本只扫 locale JSON、扫不到
  这些 `.ts`。它们由 vitest 直接 import 运行时对象覆盖，复用
  `scripts/shared/glossary-rules.mjs` 的同一套判定，随 `test:unit` 阻断：
  - mobile：`src/auth/loginMessages.ts`、`src/session/newSessionMessages.ts`、
    `src/session/fullAccessConfirmationCopy.ts`（Full access 高风险权限提示）→
    `apps/mobile/src/__tests__/shadowCatalogGlossary.test.ts`
  - desktop：`src/main/applicationMenuLabels.ts`（macOS 原生菜单栏）→
    `apps/desktop/src/main/__tests__/applicationMenuLabels.test.ts`
  - desktop：`src/main/endpointManifestDialogCopy.ts`（启动期端点清单获取失败的系统弹框，
    弹在 createWindow 之前、renderer 与 i18next 都还不存在）→
    `apps/desktop/src/main/__tests__/endpointManifestDialogCopyGlossary.test.ts`
  - desktop：`src/main/oauthResultPage.ts`（OAuth 回调结果页，渲染在系统浏览器里）→
    `apps/desktop/src/main/__tests__/oauthResultPageGlossary.test.ts`。它的文案分散在
    若干函数里且要传 provider / brand 实参，测试用固定占位实参求值后再扫；占位值不含
    CJK 与标点，免得实参本身影响判定。

  新增同类手写 catalog 时记得加进对应测试的 `collectEntries()`。**catalog 要单独成模块**：
  原先这两份分别嵌在 `bootstrap-electron.ts` 与 `fullAccessConfirmation.ts` 里，测试一 import
  就会拉起整个 Electron 主进程 / react-native，根本跑不起来——这也是它们长期是盲区的原因。
- **Slack / IM 侧的文案不在任何 locale 文件里**：`src/main/hook-control/interactions.ts` 的
  权限卡片按钮是硬编码中文，与应用内 `permissions.alwaysAllowForSession` 是同一个动作。
  改产品术语时这类「同一动作、两处独立文案」要一起找出来，否则用户在 Slack 和 App 里
  看到两种说法。
- **批量改术语时覆盖相关文案断言，完整单测由 CI 兜底**：仓库里有若干测试直接断言中文文案
  （`automationGeneratedSessions.test.ts`、`builtinToolsCollabDescriptionI18n.test.ts`、
  mobile 的 `sessionMenu.test.ts` 等）。它们是有意的文案锁，改词后要同步更新期望值，
  不能靠 guard 绿灯就认为改完了。反过来这也是一层兜底——Session→对话 那轮正是
  `mobileCindyVoiceSession.test.ts` 暴露了漏网的「语音识别会话」（ASR WebSocket
  连接，不是产品对话）。
- **有些 locale 文案是 package 源的镜像**：改 locale 时必须同步改源，否则镜像断言会红。
  已知两处：`packages/maker-shared/src/sessionOperation.ts` 的 `DESKTOP_SESSION_CHAT_PLACEHOLDER_ZH_CN`
  （mobile composer placeholder 必须等于 desktop `ccAgent.layout.chatPlaceholder`）、
  `packages/maker-scheduler/src/builtin-templates.ts`（desktop locale 的 scheduler 模板块要求与
  package 源逐字一致）。这类断言不是碍事，正是它们保证了跨端文案不漂移。
- **标点可能不在 locale 里**：部分错误消息由代码拼接（如 `cloudVoiceHttpErrorMessage()`
  给 `composer.voice.refineFailed` 补半角冒号），guard 只扫 locale JSON，改不到也管不到。
  批量改标点后若测试断言与实际值方向相反，先查该文案的冒号究竟来自 locale 还是代码，
  别顺手把断言改成"看起来一致"的那个。
- **术语表是参考，不是替换表**：它回答「这个词该不该用」，不回答「该换成哪个」。
  表里的译法是默认情况下的选择，不是「见到 A 就换成 B」的映射——目标译法取决于该
  key 的英文源与实际用途，而脚本看不见语境。因此**禁止用 sed / 正则拿术语表做批量
  替换**，逐条交给 AI 按语境判断。这不是效率取舍，是正确性要求。

  门禁的输出也按这个定位设计：命中禁用译法时只报告事实并附上**英文源原文**，
  刻意不给替换目标（以前输出「应为 X」，读起来就是一条替换指令，于是很自然地被拿去
  做机械替换）。大小写与标点两类例外——`worker`→`Worker`、`,`→`，` 的答案与语境无关、
  唯一确定，那两处仍直接给目标。

  实测代价：#389 那轮批量替换引入的用户可见误译，经七轮 review 才收敛，约 35 处。
  典型如「额度」同时是 Balance / Quota / Credits 三个英文源的正确译法，「代理」同时是
  Agent / Subagent / Proxy 的译法——无条件替换必然改错其中两类。更隐蔽的是外部产品的
  既定术语被产品术语盖掉：macOS 系统设置面板名日文是「オートメーション」而非产品的
  「自動化」，照改会让用户按提示在系统设置里找不到授权项，授权恢复路径直接断掉。

  正确做法：guard 报出违规清单后，**逐条读英文源与该 key 的实际用途再决定**（这正是
  AI 擅长、脚本做不到的部分）。同形异义写进 `exempt` 并在 `note` 里说明理由；若某个
  禁用词对应多个英文源，用条件禁用 `{ text, whenEn }` 按英文源拆开，让每条规则的目标
  译法唯一——目标不唯一的禁用词就是误译的温床。改完仍需人工过一遍 diff。

  已登记的几组同形异义：ssh-agent ≠ 产品 Agent；Computer Use 的「自动操作」≠ scheduler
  的「自动化」；SSO 的「身份提供方」≠「模型供应商」；登录态 / WebSocket / SDK 运行时的
  session ≠ 产品「对话」；OS 的「活动桌面」≠ 产品的「活跃」；Jira 的「課題」≠ 产品 Issue。

## 6. 注释

- 所有类／对象都需要有明确的注释说明其职责；核心类的实现内部要有注释描述逻辑。
- 注释写"代码本身表达不了的约束与原因"，不复述下一行代码在做什么。

## 7. 渲染性能与视觉连续性

界面切换与动画的性能约束。动效的视觉规范（允许哪些过渡、时长、容器形变）见
[`DESIGN.md`](../design-rules/DESIGN.md) §14.4；本节只管性能红线与加载时序。

- **杜绝跳变与空白帧**：所有界面／子界面／边栏切换，过程中不产生让人难受的视觉跳变。
- **取数时序**：Render 层先异步获取数据（绝不能卡主线程渲染），获取期间界面不发生
  变化，拿到数据后再刷新显示。应用内数据大部分来自本地，默认**不做 loading 态界面**；
  需要不同设计时先和用户确认。
- **常驻动画必须 compositor-only（编码与 review 必查）**：常驻／循环的单元素简单动效
  （spinner、呼吸、shimmer 等）只允许写成 **HTML 元素**上的 `transform` / `opacity`；
  其它写法（`mask` / `background-position` 等，以及任何挂在 SVG 上的动画——SVG 上连
  `transform` / `opacity` 也不行）都会每帧惊动主线程，造成持续 CPU／能耗泄漏。图标
  动效一律挂外层 wrapper：
  `❌ <Loader2 className="animate-spin" />`；
  `✅ <span className="animate-spin inline-flex"><Loader2 /></span>`。
- **复杂动效**：多元素组合动效（错峰、内部形变等）不死限实现宿主（含 SVG），按表现力
  灵活选，但遵守性能原则：常驻 infinite 动画越少越好、能不错峰就不错峰、能限挂载时长
  就限。
- 动画只在有状态含义时挂载（如仅 running），响应 `prefers-reduced-motion`；性能有疑虑
  时用 DevTools Performance 实测，以数据为准。弹窗按钮 loading 等秒级瞬态存量不强制
  改，新代码一律照此。

## 8. meka/main 上的命名

- 在 `meka/main` 上**新引入**的命名一律带 `meka`（目标名、符号名、文件名、资源名等）。
  上游已有的名字不因此改名；对外产物名以既有事实文档为准，命名不影响已发布标识。
- 例：Windows 远程桌面 host 的 Rust cdylib 目标名是
  `cindy_meka_windows_desktop_host_napi`。它必须与同包的 bin 目标名区分（MSVC 的
  `.pdb` 同名会让两个目标并发链接报 `LNK1201`），原因与验证见
  [`remote-desktop.md`](../remote-desktop.md) 的 Windows system service 一节。
- 该规则只管代码/构建命名，不改变 `CindyMeka` / `cindy-meka` 安装身份、用户数据目录、
  协议与更新渠道；那些以 [`migrations/xdmaker-meka-to-cindy.md`](../migrations/xdmaker-meka-to-cindy.md)
  为准。

## Review 清单

1. 有没有裸 `console.log`？临时排查日志是否清理干净？
2. 新／改 IPC handler 是否用 `throwIpcError` + `IpcErrorCode`？是否误用 `as` 强转或手写
   正则解码？`{success}` 风格是否只用在确实需要 fallback data 的查询型 handler？
3. main 侧新／改业务逻辑是否带了主路径 + 关键错误路径的测试？handler 业务体是否可注入
   依赖、便于免 Electron 测试？
4. 新增测试是否避免外网、固定端口、共享临时路径和重复真实子进程？资源测试是否进入正确
   tier，并保留了低成本默认 smoke？
5. 路径、子进程、FS、性能、快捷键是否在 macOS / Windows 两端都成立？未实测平台是否
   标注？
6. UI 文案是否全部走 `t()`、全部已支持语言齐全且翻译准确、无孤儿 key？术语是否照 `i18n/GLOSSARY.md`
   写、没有自造译法？是否跑过 `pnpm check:i18n` 与 `pnpm check:i18n-glossary`？
7. 新增类／核心逻辑是否有职责注释？
8. 新增常驻动画是否 compositor-only（HTML 元素 + `transform`/`opacity` + wrapper）、
   响应 `prefers-reduced-motion`？界面切换是否无跳变／空白帧、未引入不必要的 loading 态？

验证按 [`desktop-development.md`](desktop-development.md) 的分层选择：改 TypeScript 至少跑相关
类型检查与定向测试；改 i18n 跑 `pnpm check:i18n` 与 `pnpm check:i18n-glossary`；跨模块或
高风险改动再扩大验证范围。
