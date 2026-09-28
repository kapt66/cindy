# Desktop 开发、启动与验证

> **读取时机**：安装、启动、重启、调试或验证 `apps/desktop` 及其共享 packages 时

本文是 Desktop 开发命令及其使用条件的权威说明；可执行脚本以当前 checkout 的根
`package.json` 与 `apps/desktop/package.json` 为代码事实源。

## Agent 启动入口

Agent 启动 Desktop 只使用仓库根的安全包装命令。restart 命令默认使用固定的 `dev` 命名
隔离沙箱（等价于自动附加 `--isolated=dev`），不再默认共享 Cindy Meka 账号登录态与业务
数据。OpenAI 模型登录态是刻意保留的例外：普通 Dev 可只读复用同区域 Release／本机
Codex 已有登录态，能够调用模型，但不能在 Dev 内发起 OpenAI 登录或断开共享登录态。
Claude Code 的配置目录同样不隔离：Dev 与正式版一样使用 CLI 默认的 `~/.claude`（不设
`CLAUDE_CONFIG_DIR`），所以直接沿用本机 Claude Code 的订阅登录；在 Dev 里「使用
Claude Code 登录」等同于在终端运行 `claude auth login`，「断开」只撤销本实例的使用许可。
代价是多个 Dev 实例与安装版在同机共用 `~/.claude` 下的 Claude 转录（按 sdk session id
区分；同机导入分享包时同 id 转录会复用同一份）。旧版 Dev 隔离在 `<userData>/claude-home`
的转录与文件检查点，会在启动时后台一次性补拷到默认目录（只补缺、不覆盖、不删旧目录；
拉起 Claude CLI 前最多等一次 15s）；补拷完成后，旧 checkout 再写进旧目录的转录不会再补拷。

Cindy Meka 常规开发不需要指定 `--region`：命令以 Global endpoint manifest 自举，并把
Global 作为未登录时的产品 edition 默认值；登录页显式选择 CN / Global 后，该选择随认证
会话保存并优先于启动默认，登出后清除。只有验证特定 endpoint manifest 或 edition 默认值
时才显式传 `--region=cn|global|dev`。该参数不改变 Cindy Meka 的安装身份、userData 或
更新渠道。

默认 `dev` 沙箱与 checkout 路径无关：无论从主仓还是哪个 worktree 启动，Global 都落在
同一个 dev 沙箱，CN 也落在同一个 CN dev 沙箱；登录态与 dev 数据持续保留。

```bash
pnpm restart:desktop:remote
```

需要按 worktree 拆分数据时才显式传 `--isolated=@worktree`，它会按 checkout 目录名派生
稳定沙箱名（去掉前导 `cindy-`，再加路径短哈希）。同一 worktree 下次仍使用这个名字，
登录态保留在该沙箱：

```bash
pnpm restart:desktop:remote -- --isolated=@worktree
```

只有用户明确说「共享登录 / 不要重新登录 / 用现有数据」时才加 `--shared`；用户明确
「不要关当前实例」时才加 `--preserve-running`。不要把「用户没提模式」理解成共享。
需要复用旧的共享正式 profile 时，命令是：

```bash
pnpm restart:desktop:remote -- --shared
```

启动命令等待冷启动的 main/preload 编译以及窗口、认证和数据库就绪，最长 600 秒。Windows
冷缓存下编译超过五分钟也可能发生，等待期间不得并行重复启动。启动命令结束时必须出现
`DESKTOP_DEV_VERDICT=ready` 才算成功；看到
`DESKTOP_DEV_VERDICT=failed` 或没有 verdict 行，不得声称开发版已启动。失败时报告
`code` / `message`；有 `next=` 且用户未指定必须共享时，可执行该命令重试。
Desktop 连接的是你自己的 Cindy 云端账号（remote）。这与登录页中免 Cindy 账号的
「跳过登录」（应用内显示为「未登录」，无需账号即可使用本机 agent；代码内部标识仍为
`local` mode）不是同一个概念。Agent 不得自行改用
`pnpm dev:desktop` 或 `pnpm dev:desktop:remote` 绕过包装脚本。
高负载机器已经确认 600 秒仍不足时，可为单次诊断设置
`XDT_DESKTOP_STARTUP_TIMEOUT_MS`；只接受毫秒正整数并限制在 30 秒至 30 分钟，不能用它
掩盖明确的编译错误或数据库失败。

启动包装会先停止**当前 checkout** 已有的 Desktop dev 进程；其他 worktree／命名沙箱的
实例不受影响。必须尊重宿主提供的并行或保活工作流。脚本只在宿主是**当前 checkout**
的 desktop dev 时拒绝重启（杀掉宿主会连这次启动一起收掉）。宿主是正式版或另一个
worktree 时可以起隔离沙箱；从另一个 checkout 的 desktop dev 里起共享实例仍会拒绝，
避免两份进程抢同一份正式 profile。若因当前 checkout 宿主拒绝、或目标 userData 被其他
checkout 占用而中止，不要换命令绕过，应把 verdict 交给用户。

## 可选启动参数

两个 restart 命令都支持下列参数。不加任何模式旗标时默认走固定的 `--isolated=dev`
命名沙箱；要回到旧的共库行为必须显式加 `--shared`。这些参数只对 dev 生效，不影响
用户机器上的正式版。

- `--region=cn|global|dev`（默认 `global`）：切换 endpoint bootstrap 与仓内端点清单；
  验证中国大陆清单时显式传 `--region=cn`。它也是没有登录页 override 时的 edition
  默认值；登录页选择优先，企业 SSO 自动发现只改变认证服务区，不改变有效 edition。
  remote 开发启动忽略环境里的 `XDT_ENDPOINT_MANIFEST_FILE`，始终按所选区域重设
  端点文件，避免继承宿主的其它区域或自定义服务器。`--endpoints-cdn` 仍走所选区域的
  线上 CDN；本地服务调试（local）仍保留本地端点文件配置。
- `--shared`：显式选择共享 userData（旧默认行为）：dev 与正式版共用当前区域的正式
  profile，数据库、登录态、会话完全共享。仅当用户明确要求「共享登录 / 复用现有数据」
  时使用；禁止与 `--isolated` 或环境里的 `XDT_ISOLATED=1` 组合。
- `--isolated` / `--isolated=<名字>` / `--isolated=@worktree`：使用独立 userData 沙箱，数据库、Cindy Meka 登录态、会话、定时
  任务与设备身份都与正式版彻底隔离（首次需重新登录）；OpenAI 模型登录态按上述只读例外复用，
  Claude Code 按上述约定使用默认 `~/.claude`。命名沙箱每个名字一条独立沙箱，
  名字限 `A-Za-z0-9_-`、≤32 字符。`@worktree` 是保留名，按当前 checkout 目录派生沙箱名。
  用户说「独立数据库／隔离数据／沙箱启动／不要动正式版
  数据」时用；Agent 把「启动开发版」也落在这条路径。**未合入主干的 migration 必须在 `--isolated` 沙箱里跑，不得连共享 userData**
  （见 [`database-and-migrations.md`](database-and-migrations.md)）。沙箱（及任何 dev
  userData 覆写）内不触发首登旧数据迁移（mToc）：不探测老目录、不弹确认窗、不把正式
  数据复制进沙箱。**`--isolated` 不得落在任一正式 profile 上**：显式 `XDT_USER_DATA_DIR`
  若指向 CN / Global / Dev 任一正式目录（不限当前构建区域），启动器与主进程都 fail closed。isolated 会换独立 deviceId，
  正式目录里的 refresh token 属于正式版设备，叠在一起必然 `DEVICE_MISMATCH`，再删盘会
  把正式版踢下线（2026-08-16）。
- `--passive`：定时任务被动模式，本实例不自动触发 schedule。多开导致定时任务重复、
  需要让位给 primary 时用。它可以和 `--isolated` 组合（隔离沙箱只看 UI、不跑定时任务
  是合法的）。**共库只读契约不是这个旗标本身**，而是解析后的正式 profile + passive
  才落地。共享正式 profile 的 passive 实例对
  userData 布局保持只读：不执行 owner-namespace 迁移（claim 推迟到下次独占启动），
  legacy 数据导入（`hasLegacyOwnerNamespaceClaim` 门控的 secret／IM／brain 搬账）
  一并等待。非 passive 实例执行该迁移前也会先查 `.dev-instances` 实例注册表
  （dev 与 packaged 实例都登记——dev 与正式版共库双开受支持），发现其它存活实例
  共享同一 userData 时同样推迟——搬家式迁移必须独占 userData 才能执行，否则会打断
  还在运行的旧版本实例（2026-07-23 slack-hook.json／网关凭证被搬走事故）。
  **auth 凭证同属这条契约**：passive 共享实例不得**删除、作废或消费**整机共享的 auth
  持久状态——磁盘 refresh token、服务端 device token（调登出会连坐作废 primary 的
  那份）、relogin marker（一次性，被消费掉 primary 就再也看不到）、canary flag、账号
  删除 receipt。它的「退出登录」只清本进程内存态（`authManager.ts` 的
  `isPassiveSharedUserDataInstance`）。代价是同机两个实例的登录态可能不一致，这是有意
  的：passive 无权代表整机登出（2026-07-27 事故：MIGRATE_FAILED 的 passive 实例在
  fatal 界面点「返回登录」，删掉整机 refresh token，primary 在 19／46 分钟后的续期周期
  被强制重登）。
  约束的是破坏性动作，**不是写入本身**：passive 照常排续期 timer，轮换后正常写回新的
  refresh token——那写入的是有效凭证，primary 侧由 replacement-retry 消化。反过来让
  passive 停止续期，会使它的 access token 过期后再无替换途径（primary 的续期只更新磁盘
  token，不更新 passive 进程的内存态，而直接走 `apiFetch` 的路径没有 401 refresh/retry）。
- `--preserve-running`：启动编排，不是运行期模式。默认 restart 本来就不会关正式版和
  其它 worktree，只替换**当前 checkout** 的旧 dev；本旗标连这份旧 dev 也保留，再并排
  开一个共库预览，并强制 `--passive`。启动前必须由 `.dev-instances` 存活记录证明已运行
  实例与目标区域一致，旧记录没有 region 或跨区域都会 fail closed。仅供能证明实例归属的
  上层编排，或用户明确「不要关当前实例／不要重新登录」时用。仅支持 remote。禁止与
  `--isolated` 或环境里的 `XDT_ISOLATED=1` 组合。共享实例若只发现没有 realm 的旧版裸
  refresh token，也不得猜区域迁移或轮换，保持本进程登出，交给同区域独占实例完成凭证迁移。

dev-only 环境变量（不是启动参数，只影响 dev，打包构建一律忽略）：

- `XDT_PLUGIN_CLIENT_VERSION=<版本号>`（如 `0.0.25`）：覆盖**上报给插件市场的客户端版本**，
  用于在 dev 下复现发布版的插件分发身份。dev 的 `app.getVersion()` 是占位值 `0.0.0`，
  协议把 `0.0.0` 判成"版本无关"并**无条件放行**，于是 dev 拿到最宽的市场投影；发布版上报
  真实 `0.0.x`（`identityKind = versioned`）会被插件的 `minCindyVersion` 挡住。做插件可见性
  ／兼容下限排查时用它把 dev 拉到发布版的判定输入，否则「本地看得到、发布版看不到」这类
  缺陷在本地无法复现。生效范围：仅 `!app.isPackaged`，且**只**改上报版本与其 identityKind——
  `app.getVersion()`、更新器、日志与 UI 版本显示都不变，因此它不能当"伪装版本号"的通用手段。
  失败行为是 fail-loud：值不是合法版本号形态（含空值）直接抛错，传 versionless 哨兵
  （`0.0.0` / `0.0.0-*`）也抛错——传哨兵等于没开，静默回退会让人误以为复现成功。错误在
  插件市场首次解析身份时（即第一次用到该渠道）抛出，报错信息里点名该环境变量。用完即撤，
  不要写进任何脚本或 `.env`。设计正本与验收标准见
  [`plugin-distribution-and-version-compat.md`](plugin-distribution-and-version-compat.md) §5.1.1 P1-7／§6.1。

- `XDT_CINDY_MAKE_TEST=1`：**Cindy Make 测试窗口标记**（严格等于 `1`）。消费方只有
  `src/main/cindy-make/testWindowBehavior.ts`，且必须**同时**满足 `!app.isPackaged` 与
  `XDT_ISOLATED=1` 才生效——生效时窗口就绪即复用主窗口激活路径带到前台、关闭窗口直接退出
  测试进程（不进托盘／最小化选择）；两个条件任一不满足就退回普通开发窗口行为（数据仍隔离，
  但关闭／前台语义不再是测试版）。**透传链路**：Cindy Make 的任务进程由
  `src/main/cindy-make/testRunner.ts` 注入该变量 → `scripts/restart-desktop-remote.mjs` 的
  `devEnvPrefix()` 白名单（`restart-desktop-remote.mjs:1018`）把它拼进 `pnpm dev:desktop*`
  的环境前缀，随 dev-env / Forge 进入 dev 主进程。**漏了这条透传不会报错**，只会让测试进程
  退化成普通开发窗口，所以它是白名单的一等成员。只影响 dev，打包构建忽略；回归见
  `scripts/__tests__/restart-desktop-remote.test.mjs`（`devEnvPrefix` 的 win32 / darwin 两条
  断言）与 `src/main/cindy-make/__tests__/testWindowBehavior.test.ts`；产品契约正本见
  [`../cindy-make-upstream.md`](../cindy-make-upstream.md)。

已手动设 `XDT_USER_DATA_DIR` 时尊重用户值，不覆盖，也不探测或迁移正式区域目录。
唯一例外：`--isolated` / `XDT_ISOLATED=1` 把该目录指到正式 profile 时直接拒绝启动。

正式版目录保持历史兼容：上游 Cindy 使用 `Cindy` / `CindyGlobal`，Cindy Meka 使用
`CindyMeka`；两套目录都不在启动时改名或搬迁用户数据。
`--shared` dev 使用当前区域对应的正式 profile；`--isolated` 沙箱再按相同区域映射派生目录。

**dev writer 不得把正式 profile 升到当前 checkout 比安装版更新的 schema**：有 pending
migration 就拒绝启动，改用 `--isolated=<名字>`。`--preserve-running` / 共库 passive 仍只读。

Desktop 服务端 `deviceId` 是产品身份边界的一部分。Meka 正常实例使用
`cindy-meka-<machineId>`，显式 `XDT_DEVICE_ID_OVERRIDE` 仅用于同机多实例联调，启动时也
会归一化为 `cindy-meka-*`；不得让上游 Cindy 的裸机器指纹穿透到 Meka。这样登录、换 token
和 refresh 都不会共用 auth-server 的 `(userId, deviceId)` 设备槽。官方 profile 保护集合
同时包含 Cindy 的 `Cindy` / `CindyGlobal` / `CindyDev` 与 Meka 的
`CindyMeka` / `CindyMekaDev`，隔离启动指向任一正式目录都必须拒绝。
跨区域共享、登录态迁移或旧版本回滚应使用显式隔离目录，避免不同构建误用同一 profile。

### 并行多开 dev

restart 的 kill 作用域是**当前 checkout（worktree）**：只停自己这份 checkout 的 dev
进程，其他 worktree／命名沙箱的实例一律保留（2026-07-30 约束：并行沙箱不得被另一个
checkout 的启动器顶掉）。因此并行多开的标准姿势是：**每个 worktree 显式传
`--isolated=@worktree` 或 `--isolated=<名字>`**，各自使用独立沙箱；默认 `dev`
沙箱跨 worktree 共用，适合单人常规开发但不能并行多开同一份 userData。

配套护栏与工具：

- **userData 冲突门**：目标 userData（按 `--isolated` 名字推导）已被其他 checkout 的
  dev 实例占用时，restart 会在杀任何进程之前中止并列出占用进程——不代杀、不共库。
  换一个沙箱名字，或由用户自己停掉那个实例后重试。检测靠 helper 进程命令行上的
  `--user-data-dir`，对方实例刚启动还没起 helper 时可能漏检，属尽力而为。
- **CDP 端口**：dev 的 remote-debugging-port 固定 9222，只有先起的实例能绑上。后起
  实例需要 CDP 调试面时，用 `XDT_CDP_PORT=<端口>` 覆写（仅数字生效，dev-only）。
- 同一 checkout 内仍是单实例语义：restart 会替换本 checkout 上一个实例（不论沙箱
  名字），一个 worktree 同时只跑一份 dev。
- 共享 userData 的并行（`--preserve-running` 被动预览）语义不变：不停任何实例、强制
  passive、禁止与 `--isolated` 组合，仅供能证明实例归属的上层编排使用。

Agent 自身仍只走 restart 命令，不直接调 human-only 的 `dev:desktop*`。共享同一 userData
多开时，非 primary 实例用 `--passive` 让出定时任务调度（见上）。

### 使用统计（TapDB）在 dev 下不上报

dev 构建**默认不初始化 TapDB**，与用户是否同意《隐私政策》、统计开关是否打开无关。闸在
main 侧 `analytics-settings-store.ts` 的 `isReportingBuild()`（`app.isPackaged !== true`
默认关），renderer 只消费 `allowed` 这个结论。

原因：TapDB Web SDK 的设备身份（`device_id`）写在 renderer 的 localStorage 里，而
localStorage 按 **origin + userData 目录** 分家——dev 的 renderer 从
`http://localhost:<vite 端口>` 加载（并行多开时端口自增），`--isolated[=<名字>]` 与
`XDT_USER_DATA_DIR` 每条沙箱又各有一份。于是一个开发者一天能凭空造出几十台「新增设备」，
把线上新增设备／转化率／次日留存全部带偏（2026-07-26 复盘：某地区单人一天 78 台设备、
新增账号 1、次日留存 2.6%）。dev 与 release 目前共用同一个 TapDB appId，只能在闸上区分。

要验证上报链路本身时，手动设 `XDT_TAPDB_DEV=1` 放行（严格等于 `1`，其它值一律视为关）。
**这会把 dev 数据打进线上 app，用完即撤，不要写进任何脚本或 `.env`。**

## 何时需要重启

- 修改 main、preload、MCP、原生依赖或 package 运行时代码后需要重启。
- 只修改 renderer 时优先使用现有实例的热更新，不重复重启。
- 不确定运行实例来自哪个 checkout 时，先运行 `pnpm desktop:whoami -- --all` 核对。

`desktop:whoami` 的进程扫描会过滤 Electron 的 `crashpad-handler` 子进程，再从 renderer/
utility 子进程确认 userData；Windows crashpad 命令行的裸路径会紧跟 `/prefetch`，不能作为
启动实例身份的证据。验证必须看到 `DESKTOP_DEV_VERDICT=ready`，并且 root、commit、ready
三项均匹配当前 checkout。

## 分层验证

工作目录误报缺失或切到备用目录时，参见[工作目录异常日志判读](../working-directory-diagnostics.md)，
按探测阶段、恢复结果与匿名关联标识区分原因，不要仅凭超时推断掉盘。

本节指导本地验证；提交前按 `development-workflow.md` 的「提交前验证」覆盖改动影响面，
默认使用 `pnpm test:unit:related`，也可采用等效定向测试与相关 package 的类型检查。
本机并发预算由使用者或宿主决定，CI 保留完整单测。根据实际改动选择最小但充分的检查：

```bash
pnpm --filter desktop typecheck
pnpm --filter desktop lint
pnpm --filter desktop exec vitest run <测试文件路径>
pnpm --filter desktop test
pnpm build
pnpm test:unit:related
pnpm test:unit
```

- 改 TypeScript 至少运行相关类型检查和定向测试。
- 跨模块、共享 package、构建链或广泛重构再扩大到 Desktop 全量测试、构建或根级单测。
- 调整 Desktop Vitest worker 或测试分池前，先读取
  [`desktop-unit-test-performance.md`](desktop-unit-test-performance.md)，并用其中的
  benchmark 在相同测试范围下做前后对比。
- 数据库 migration、协议、更新器、权限与用户数据另有高风险专项规则；命中时先读取
  对应规则，不以本页命令替代专项验证。
- 记录实际执行和结果；未执行的高相关检查必须说明原因。

OAuth loopback 单测的浏览器回调夹具在监听器建立后立即发起 loopback 请求，不额外排队
`setImmediate`；这样在 Windows CI 的并发 Vitest worker 负载下不会把合法回调延迟到测试超时。

## 错误任务的原生会话恢复

Desktop 在已注册 Session 进入 `error` 后收到继续消息时，必须把该路径视为恢复已有任务，
不能视为普通新建。lazy-create 前必须成功读取 `sessions` 权威行；读库失败（包括
`SQLITE_BUSY`）时应在 bootstrap 前失败，不能沿用 renderer／队列中的旧 `createOpts`；
对明确处于错误恢复的 Session，记录缺失也必须失败。真正的全新 lazy create 没有历史行，
允许在确认“无行”后按请求创建。DB 行中的 Agent、模型、provider 和 `sdk_session_id` 始终
覆盖调用快照。

Codex 错误恢复还必须携带有效的持久化 thread ID，并调用 `thread/resume`。该路径禁止降级为
`thread/start`；app-server 返回的 handle ID 也必须等于预期 ID，否则关闭新 handle、保留原
`sdk_session_id` 并报告失败。该约束只适用于错误 Session 的原地恢复；显式 `/clear`、切换
Agent、删除消息后重建上下文及全新任务仍允许创建新的原生会话。

## Windows 安装目录与授权

NSIS 安装器保留当前用户／所有用户两种范围。普通用户可写的目录无需提权；选择受保护的
目录时，在替换文件和卸载旧版之前探测写权限，仅遇到 Windows `ACCESS_DENIED` 才通过
现有 UAC broker 请求授权。取消授权保留目录选择；文件占用、无效路径等错误提示换目录
或处理占用，不反复申请管理员权限。静默安装同样在卸载旧版之前检查目录。

同账号提权保留原目录和安装范围。当前用户安装若通过另一个管理员账号授权，则停止该次
提权安装，提示选择当前账号可写的目录，或返回选择为所有用户安装；不得把当前用户安装
悄悄登记到管理员账号名下。此改动不调整 Cindy 运行时的权限、用户数据目录或更新器。

实现使用 `resources/installer-directory.nsh` 的目录页和预检查，
`forge.config.ts` 因此关闭上游自带目录页，由 `customPageAfterChangeDir` 插入同款原生页。
不要单独打开上游 `allowToChangeInstallationDirectory`，否则会重复插入页面。

### NSIS 脚本的同级 `!include` 走 `${BUILD_RESOURCES_DIR}`

`resources/*.nsh` 之间互相引用（`installer.nsh` → `winget-shortcuts.nsh` /
`installer-directory.nsh` → `installer-directory-messages.nsh`）时，**必须**写成
`!include "${BUILD_RESOURCES_DIR}\x.nsh"`（`resources/installer.nsh:16-17`、
`resources/installer-directory.nsh:70`），不得写裸文件名，也不要用相对目录前缀。消息目录的
include 留在 `customHeader` 宏体内即可：`${BUILD_RESOURCES_DIR}` 是 makensis 命令行上的
`-D` 常量，宏内／宏外取值一致，不像 `${__FILEDIR__}` 那样在宏展开时指向「插入方」。

原因是 NSIS 解析相对 `!include` 只看三处：makensis 的工作目录、`!addincludedir`
列表、`NSISDIR\Include`——**不看「包含它的那个文件所在目录」**。生产打包路径上
app-builder-lib 只把 `buildResourcesDir` 加进 `!addincludedir`，并把同一个值作为
`BUILD_RESOURCES_DIR` 常量注入（`NsisTarget.js` 的 `defines`）；本仓从未有
`apps/desktop/build/`，所以裸名字在**旧配置形状**下必然 `!include: could not find`。
0.0.22 的 Windows 发布就是这样挂在 `installer.nsh` 第一处同级 include 上
（`ERR_ELECTRON_BUILDER_CANNOT_EXECUTE`）。

上游 `7582de5f20`（2026-09-20「configure NSIS build resources」）补上了缺失的一半，
本仓随之把同级 include 全部改成 `${BUILD_RESOURCES_DIR}` 限定：
`forge.config.ts` 的 NSIS maker 显式设
`directories.buildResources = path.join(__dirname, 'resources')`（`forge.config.ts:1761`），
app-builder-lib 据此同时提供 `!addincludedir` 与 `BUILD_RESOURCES_DIR` 常量。二者成对：
**别退回裸名，也别删 `forge.config.ts` 的 `buildResources` 配置**（`resources/installer.nsh`
顶部注释与 `scripts/nsis-include-paths.test.mjs` 都钉住了这一点）。

门禁分工（改任一 `.nsh`、NSIS maker 配置或 `resources/` 布局后都要跑）：

```bash
pnpm --filter desktop exec vitest run scripts/nsis-include-paths.test.mjs
pnpm --filter desktop exec vitest run scripts/installer-include-resolution.test.mjs
pnpm --filter desktop exec vitest run scripts/installer-directory-messages.test.mjs
node apps/desktop/scripts/check-windows-installer.mjs
node apps/desktop/scripts/test-winget-shortcuts.mjs
```

- `scripts/nsis-include-paths.test.mjs`（上游 `7582de5f20` 新增，纯文本、任何平台可跑）是这条
  契约的正面门禁：断言 forge 里有
  `buildResources: path.join(__dirname, 'resources')`、三个同级 include 都是
  `${BUILD_RESOURCES_DIR}` 形态，并断言它们**没有**退回裸文件名。
- `scripts/installer-include-resolution.test.mjs` 是并行的路径规则检查：它只把**裸文件名**
  判为违规（带目录前缀或 `${__FILEDIR__}` 的不在判据内），因此与上面那条不冲突，两者一起
  覆盖「裸名」与「生产常量来源」两种回归。
- 两个 native 脚本都在 Windows 上编译真实安装器／卸载器。`check-windows-installer.mjs` 给
  自己的 fixture 编译显式传 `/DBUILD_RESOURCES_DIR=<resources>`
  （`check-windows-installer.mjs:81`）。**未验证项（本轮如实登记）**：本轮核对时两个脚本调
  app-builder-lib `build()` 都没显式给 `directories.buildResources`，而
  app-builder-lib 的缺省是 `<projectDir>/build`（本仓从未有此目录），`test-winget-shortcuts.mjs`
  的注释里还写着「production sets nothing」——这与 `forge.config.ts:1761` 已设
  `buildResources` 的生产形态**不一致**，两个脚本的安装器编译阶段能否在本机通过本轮未在
  Windows 实跑核对，改动它们时必须实测（`nsis-include-paths.test.mjs` 只锁文件文本，不跑
  makensis）。它实跑 Win32 文件访问与账号 SID 探测；UAC 返回值由测试
  替身提供，覆盖取消、子进程退出和账号／范围恢复。它不能代替真实 UAC 交互验收。发布前还需在
  普通权限 Windows 环境走查：默认目录、自定义受保护目录、允许／取消授权、使用另一管理员
  账号、旧版覆盖安装，以及静默安装失败时旧版仍在。原生对话框的 Light／Dark 外观由 Windows
  提供，自动测试不代表两种模式已完成目检。
