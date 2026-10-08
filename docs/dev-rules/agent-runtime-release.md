# Agent Runtime 发布契约

> **状态**：权威工程规则
> **读取时机**：修改 Claude/Codex runtime pin、Cindy Meka RustFS 发布或 MCPRouter
> Linux agent runtime 交付前

## 事实边界

- `tools/claude/latest.json` 与 `tools/codex/latest.json` 是 Cindy 当前 runtime pin 的唯一
  真源。
- Cindy Meka 正式发布把 runtime gzip 写入公开的 `cindy-meka` bucket。上传仍使用受保护
  的 RustFS 写凭证；下载公开，不向 MCPRouter 分发 RustFS 凭证。
- 版本化对象不可覆盖：
  `claude-code/<version>/<platform>/claude[.exe].gz` 与
  `codex/<version>/<platform>/codex[.exe].gz`。同路径内容不同必须失败。
- 每个对象同时记录 gzip SHA-256、裸二进制 SHA-256 与字节数。消费者必须完成两段校验，
  不能只以 HTTP 200、文件存在或 gzip 可解压作为成功条件。
- `maker-cc-manager` bundle 不使用上述 runtime 版本号；它由
  `packages/maker-cc-manager/src/protocol.ts` 的 `CC_MGR_BUNDLE_VERSION` 单独 pin。当前为
  `0.0.10` / protocol `5`（pin 与 protocol 的最新值一律以该文件为准，本文不复述具体数字）。
  修改该 pin 后必须运行
  `pnpm --filter @cindy/maker-cc-manager bundle`，并让 MCPRouter 从同一 Cindy 源码重建、探测
  和重启 daemon；只发布 Claude/Codex runtime 资产不会更新 cc-manager。

### cc-mgr bundle 的 CDN 段（L2：按版本交付，2026-09-29 落地）

`runtime-manifest-<platformKey>.json` 增加**可选**的 `ccMgr` 段，让远端可以**按客户端要求的
版本**取用 bundle，而不必等镜像重建：

| 项 | 规则 |
| --- | --- |
| 对象路径 | `cc-mgr/<managerVersion>/cc-mgr.mjs` —— **无平台段**（cc-mgr 是平台无关的 JS，各平台同一份字节） |
| 产物形态 | **明文**（不 gzip），因此 manifest 里只有**一个** `sha256`；不得复用 claude/codex 的 `binarySha256` 语义 |
| 段字段 | `managerVersion`、`protocolVersion`、`file`、`sha256`、`size`（`protocolVersion` 必须一起记：manager 版本相同但 protocol 不同属于不可部署的 pin mismatch） |
| 可选性（红线） | 消费端把**缺失视为合法**并回退镜像内 bundle；`schemaVersion` 保持 `1`。老镜像 / 老区域 / 老 manifest 必须继续可用 |
| 不可覆盖 | 同路径内容不同**必须失败**，绝不覆盖（与既有 runtime 对象同口径）：否则「同一版本号两份字节」会让两台机器表现不一致且无法回滚 |
| 版本来源 | 从 `packages/maker-cc-manager/src/protocol.ts` 解析，**不得**在发布脚本里另写副本 |
| 产物自证 | 发布前必须用产物自身的 `--version` 探针核对它自报的 `managerVersion`/`protocolVersion` 与 pin 一致 —— 「源码常量新、产物旧」正是版本分叉的入口 |
| 落盘位置 | `apps/desktop/scripts/ci/runtime-release.mjs` 的 `publishCcMgrBundle`；由 `publish-agent-runtimes.mjs` 调用 —— **重建产物 + 自证探针在 `--execute` 之前就做**（dry-run 因此也会先构建并核对 pin，几秒的代价换来「打印出来的对象路径与摘要确实是这次要发的字节」），只有**上传**是 `--execute` 专属 |
| 回归 | `node --test scripts/__tests__/cc-mgr-cdn-release.test.mjs` |
| 自动化发布 | **不需要新的发布机制**：cc-mgr 对象由 `pnpm release:runtime:linux-x64` 这条既有链路发出，由 `cindy-meka-cicd` 的 `publish:linux-x64:runtimes` job 在 `pipeline_mode = runtime-assets\|release` 的 web 流水线里调用。该 job 有一条「公共 manifest 已跟上源码 pin 就跳过发布」的复用快路径，因此它**必须把 `ccMgr` 一并纳入 pin 比对**（否则只 bump cc-mgr 的改动会被整段跳过、对象永远发不出去）；同时对 `ccMgr` 段做形状 + 对象 HEAD 校验，并以「源码是否具备该能力」为条件，保证重跑旧 pipeline 不被打挂 |

消费端（MCPRouter）与端到端验证、以及「镜像重建/部署仍必须做」的边界，见 MCPRouter 仓
`docs/cc-mgr-cdn-delivery.md`。**这一段只解决「客户端比服务端新」的情形**：它不改变
`protocol/hello` 的精确相等闸门。

- MCPRouter 的构建探针、daemon 启动探针和 agent-tunnel smoke 必须声明同一精确 pin，且
  完整构建必须对 `CINDY_SRC` 当场生成的 bundle 执行 `--version` 探针。任一消费者或源码
  checkout 不一致都必须在镜像构建前失败，不能等到用户创建远程 Worker 才发现。
- 依赖 MCPRouter 原生 Skill 投递的强制工作流必须在业务探索前执行 capability hello，并以
  `CC_MGR_BUNDLE_VERSION` 与 protocol 精确匹配作为环境 ready 条件。实例 online、项目已绑定或
  普通 route 可查询都不能替代该握手；不得把旧 bundle 兼容降级成成功。版本错配时应停止业务
  流程并要求从同一 Cindy 源码重建、探测和重启远端 daemon。
- **版本错配必须可诊断**：客户端不得把 daemon 的
  `[INVALID_BUNDLE_VERSION] client bundle <X> does not match server bundle <Y>` 作为自由文本
  透出（它会先被 lazy-create 包装成 `LAZY_CREATE_FAILED`，用户看不到哪边旧、也没有动作入口）。
  Main 侧统一规约成 `[REMOTE_CC_MGR_VERSION_MISMATCH] client=<X> server=<Y>`
  （`packages/maker-shared/src/ccManagerRuntimeVersion.ts`，唯一规约点
  `maker-host/send-outcome.ts` 的 `createHostSendFailure`），渲染层换成带两边版本与
  「重建并重启远端运行时」指引的提示。细则见 `mcpr-remote-session-routing.md §4.1`。

## 发布物 runtime ≠ 桌面端打包 runtime

两侧是**两种产物、两个 pin**，改任何一侧都必须同时核对另一侧：

| 用途 | 产物形态 | 落点 | pin |
| --- | --- | --- | --- |
| 桌面端运行／打包（应用内 agent runtime） | codex **目录分发** | `apps/codex-package-bin/<platform>/` | `tools/codex-package/latest.json` |
| 发布到 CDN 的 runtime 对象 | codex **单文件** | `apps/codex-bin/<platform>/codex[.exe]` | `tools/codex/latest.json` |
| 两侧共用 | claude / ripgrep 单文件 | `apps/claude-code-bin/`、`apps/ripgrep-bin/` | `tools/claude/latest.json`、`tools/ripgrep/latest.json` |
| 桌面端运行（Pi agent） | pi **目录分发**（发布侧重打成 tar.gz） | CDN `pi/<ver>/<platform>/pi.dist.tar.gz`（安装包**不**内置） | `tools/pi/latest.json` |

### 应用 manifest 必须同时记录 `codex`、`codexPackage` 与 `pi`

**硬契约：三段都要发**（`publish-desktop.mjs` → `buildCanaryManifest`）：

| manifest 字段 | 形态 | 谁在读 |
| --- | --- | --- |
| `codex` | 单文件 gz（`codex/<ver>/<platform>/codex[.exe].gz` + `binarySha256`） | ≤0.0.20 的桌面客户端；MCPRouter 侧的 `runtime-manifest-linux-*.json` 是同形资产的独立入口，不在应用 manifest 内 |
| `codexPackage` | 整目录 tar.gz（`codex-package/<ver>/<platform>/codex-package.tar.gz`） | **≥0.0.21 桌面端启动**：`agent-binaries` 的 `CONFIG.codex` = `manifestField: 'codexPackage'` + `artifactKind: 'tar-gz-dir'` + `installSubdir: 'codex-package'` |
| `pi` | 整目录 tar.gz（`pi/<ver>/<platform>/pi.dist.tar.gz`） | **≥0.0.21 桌面端的 Pi agent**：`CONFIG.pi` = `manifestField: 'pi'` + `artifactKind: 'tar-gz-dir'` + `optionalAsset`。安装包不内置 `resources/pi`，`resolvePiBinaryPath` 只认受管安装版，因此**这一段是 packaged 用户拿到 Pi 的唯一途径** |

- 目录分发资产**直接复用 pin 记录的上游官方整包**（`tools/codex-package/latest.json` 的
  `runtimeAssets.<platformKey>`：直链 + sha256 + 字节数），**不在发版机重新打包本地
  `apps/codex-package-bin`**：字节可复现、sha256 与 pin 同源，也不会因为「本机再打一次包 →
  字节不同」在同一个不可覆盖对象上撞车。下载走 `downloadToFileWithTimeout` 并显式
  `minThroughputBytesPerSec: 0`（发布链路没有退路，掐断只会把"慢但能成"变成失败）；落盘后按
  pin 的 sha256 校验，上传后回读 `size` + `metadata.sha256` 复核，失败即中止。
- 定义在 `apps/desktop/scripts/ci/runtime-release.mjs`：`RUNTIME_DEFINITIONS`（单文件三段）、
  `DIR_DIST_RUNTIME_DEFINITIONS` = `codexPackage` + `pi`（目录分发两段）、
  `RELEASE_RUNTIME_DEFINITIONS = RUNTIME_DEFINITIONS + DIR_DIST_*`（应用 manifest 必须齐全的判据）。
  `publish-desktop.mjs` 与 `reset-canary-desktop.mjs` 都用它断言；reset 侧
  `allowMissing: ['ripgrep','codexPackage','pi']` 以兼容字段引入前的 stable manifest
  （字段**存在就必须校验**）。
- 对象路径含平台段（`/<platformKey>/`），这是发布侧 `assertRuntimeManifestAssets` /
  `validRuntimeManifestAsset`（`apps/desktop/scripts/ci/runtime-release.mjs`）的既有路径约束。
- pin 的 `target` / `entrypoint` 元数据在发布侧也做**交叉校验**，且**要求字段存在**：缺任一
  即 fail closed。校验真值是安装侧维护的规范表 `tools/codex-package/update.mjs` 的
  `CODEX_PACKAGE_PLATFORMS`（发布侧 import 复用，不另造平台映射）。**只比 `entrypoint` 不够**：
  `bin/codex` / `bin/codex.exe` 各覆盖两个平台，跨架构整段粘贴（如把 win32-arm64 条目放进
  win32-x64 槽位）能骗过它，结果是把 arm64 字节发到 x64 路径——必须连 `target` 一起比。
  这与安装侧 `validateCodexPackageDirectory` 的 `pin.target !== platform.target` 同口径。
- `buildCanaryManifest` 对五段 runtime **一律无条件覆盖**（本轮无值时 `delete`）：该函数从
  baseManifest（上一版 canary）clone 而来，只在「本轮有值」时写入会让上一版的陈旧段顶包，
  而齐备断言仍然通过——守卫就证明不了本轮的段真的发布过。

### linux runtime manifest 也必须带 `codexPackage` 与 `pi`（2026-10-08 落地）

**事实（2026-10-08 事故）**：MCPRouter（远程 agent 宿主）只从
`runtime-manifest-linux-<arch>.json` 取 runtime，而这份 manifest **从来没有** `codexPackage`
段。它拿到的 `codex` 是**单文件** gz，里面没有 `bin/codex-code-mode-host` —— 这个 sidecar
（code-mode / 命令执行宿主）**只存在于目录发行包**里（安装侧
`tools/codex-package/update.mjs` 的 `validateCodexPackageDirectory` 要求它与 `bin/codex`、
`rg` 同时在包内）。后果：远端 Codex 的 code-mode 起不来，MCPRouter 会话里报「命令执行环境因
缺少 codex-code-mode-host 无法启动」，模型只能让用户手动 `ls -la`。桌面端 ≥0.0.21 早已改用
目录分发，**只有 linux 的 agent runtime manifest 漏了这一段**；`pi` 段同理从未发过，而
MCPRouter 还需要能跑 Pi。

因此 `publish-agent-runtimes.mjs` 发布的 `runtime-manifest-<platformKey>.json` 增加两个
**可选**段（`buildAgentRuntimeManifest` 的第 4 个参数，取 `publishDirDistAssets` 的
`manifestAssets`）：

| 项 | `codexPackage` | `pi` |
| --- | --- | --- |
| 对象路径 | `codex-package/<version>/<platformKey>/codex-package.tar.gz` | `pi/<version>/<platformKey>/pi.dist.tar.gz` |
| 段字段 | `version`、`file`、`sha256`、`size`（**四字段**，与桌面端同一套目录分发资产形状；不含 `target`/`entrypoint`——那两个只在 pin 里做交叉校验） | 同左 |
| sha256 / size 来源 | **原样转发** pin 的上游官方整包 ⇒ 与 `tools/codex-package/latest.json` 的摘要逐字节同源 | **确定性重打包产物**（解包 → 补 `theme/` → tar.gz）⇒ 与 pin 摘要**不同**；pin 摘要留在对象元数据 `pinned-sha256` |
| pin | `tools/codex-package/latest.json` | `tools/pi/latest.json` |
| 定义 | `CODEX_PACKAGE_DIR_DIST_DEFINITION` | `PI_DIR_DIST_DEFINITION`（`repack: 'pinned-archive'`） |
| 谁在读 | MCPRouter 的 linux runtime（目录分发是 code-mode 能起来的前提） | MCPRouter 上跑 Pi |

- **可选性（红线）**：两段都是**可选段**。消费端把「缺失」视为合法并回退镜像内那份，老
  manifest / 老镜像 / 老区域继续可用；`schemaVersion` 保持 `1`；`claudeCode` 与**单文件**
  `codex` 段的字段、对象路径与 `binarySha256` 语义一个字都没变。发布侧对它们只做
  「**存在即校验、缺失即合法**」（`assertRuntimeManifestAssets({ required: false })`）。
- **发布侧齐备闸门**：`publish-agent-runtimes.mjs` 在写 mutable manifest 之前用
  `assertRuntimeManifestAssets(manifest, platform, { definitions: DIR_DIST_RUNTIME_DEFINITIONS })`
  要求两段齐备 —— 消费端的「缺失合法」不是发布端的「可以不发」。2026-10-08 的事故形态正是
  「发布链路上从来没有这段」，所以闸门必须落在发布侧。
- **为什么不许删掉单文件 `codex`**：它在同一份 manifest 里服务两类老消费方 —— ≤0.0.20 的桌面
  客户端（只认 `manifest.codex` 的单文件形态），以及**还没重建的旧 MCPRouter 镜像**（在远端
  改用目录分发之前，单文件段是它唯一认识的形态）。删掉它等于让这些消费方在这次 manifest 更新后
  **再也取不到 codex**。两段并存是刻意的：新镜像取 `codexPackage`，老镜像继续取 `codex`；本仓
  无从验证远端的具体取用顺序，因此**只增不删**是唯一安全的改法。
- **消费侧必须优先 `codexPackage`（在 MCPRouter 仓，本仓只登记契约）**：本仓只保证 manifest
  带上两段。远端「先目录分发、缺段才回落单文件 `codex`」的取用顺序在 MCPRouter 仓实现。注意
  两侧 pin 版本可以不同（`codex` 单文件与 `codex-package` 是两个独立 pin，见本章开头的表）：
  只要远端仍优先取单文件 `codex`，code-mode 就仍然缺 sidecar。该仓侧的端到端验证不在本仓。
- **dry-run 必须打印两段**：
  `node apps/desktop/scripts/publish-agent-runtimes.mjs --platform linux-x64 --region cn`（不加
  `--execute`）必须打印两个新段的对象路径与段形状（`formatMekaDirDistManifestPreview`）；
  `pi` 的 `sha256`/`size` 打印为 `null` 占位并注明「`--execute` 时按重打包产物填写」——
  **绝不**把 pin（上游归档）的摘要冒充成段摘要。
- **CI 复用快路径的连带义务（在 `cindy-meka-cicd` 仓，本仓只登记）**：该 job 有一条「公共
  manifest 已跟上源码 pin ⇒ 跳过发布」的快路径。它必须把 `codexPackage` / `pi` 一并纳入 pin
  比对，否则「只 bump 了 codex-package / pi pin」的改动静默不发布（与 `ccMgr` 段同一问题）。
- **回归**：`node --test scripts/__tests__/codex-package-cdn-release.test.mjs scripts/__tests__/pi-cdn-release.test.mjs scripts/__tests__/meka-release-flow.test.mjs`
  （覆盖：两段写入的形状与对象路径、缺段时消费端合法 / 发布侧必须齐备、存在即 fail closed、
  `codexPackage` 原样转发 ⇒ 摘要与 pin 同源、`pi` 重打包 ⇒ 摘要与 pin **不同**且
  `pinned-sha256` 留证、dry-run 预览文本）。

### `pi` 段的特殊契约：发布侧重打包（不是原样转发）

**为什么不能像 `codexPackage` 那样直接转发 pin 字节**（三个事实叠加，缺一个结论就不成立）：

1. 上游 pi 归档的平台形态不一致：win32 是 `.zip`，unix 是**包在 `pi/` 壳目录里**的 `.tar.gz`；
   而客户端 `CONFIG.pi` 只认 `tar-gz-dir`（用 npm `tar` 解包，不认 zip）。
2. 上游归档**不含 `theme/`**，缺它 Pi 的 RPC 模式启动即崩；补齐主题是本仓的既有职责
   （`tools/pi/update.mjs` 的 `ensurePiThemeAssets`，仓库自带 `tools/pi/theme/*`）。
3. 客户端 `extractTarGzDir` 要求解包后主执行文件在目录根（或唯一的 `pi/` 壳目录里）。

因此 `PI_DIR_DIST_DEFINITION` 走 `repack: 'pinned-archive'`：从 pin 直链下载 → 按 pin 的
sha256 逐字节校验 → 解包 → `flattenExtractedDir` 归一布局 → 补主题 → **确定性 tar.gz**
（顺序/元数据/权限位全部归一，见 `tools/shared/dir-dist-archive.mjs`）。确定性不是风格问题：
版本化对象不可覆盖，同一版本重跑发布只能得到同一份字节，否则重跑会撞上「同路径内容不同」而
需要人工介入。

**来源可验证性**：manifest 记的是**重打包产物**的 sha256，因此额外把 pin 归档的摘要在上传时写入
对象元数据的 `pinned-sha256`；重跑（含 canary 被 reset 回上一版 stable 的场景）据此判定
「在线对象确实由当前 pin 的字节重打包而来」，pin 字节在同一版本下被上游替换时会 fail closed
拒绝覆盖，而不是静默复用一份陈旧的重打包结果。

**兼容**：`pi` 是可选的 manifest 段，旧客户端会忽略它；`reset-canary-desktop.mjs` 对 0.0.23
之前的 stable manifest 允许该段缺失（`allowMissing`）——那些 stable 本来就没发过它。

- **历史事故（0.0.21 / 0.0.22 packaged 包「模型只有零星几个可用」）**：客户端早在
  `4c94194709`（2026-08-02）就把 pi 接进了 CDN 运行时分发链（manifest 可选 `pi` 字段 +
  `optionalAsset` 降级），并同步改成「正式安装包不内置 Pi」，但本仓发布链路
  （`runtime-release.mjs` / `release-lib.mjs` / `buildCanaryManifest`）从来没有发过这一段
  （`PI_DIR_DIST_DEFINITION` 在 0.0.23 才落地）。后果链条：每次启动都是
  `prepare('pi')` → `asset_missing (manifest field "pi")` → `pi-host` 记
  `pi agent disabled for this launch` → `maker:get-capabilities` 只报
  `claude-code, codex`。因为 XD 网关这类供应商的多数模型只在 `pi` 路由上默认开启
  （其它 agent 与模型原生协议不兼容，`active-catalog.ts` 会给出 `defaultEnabled=false`），
  packaged 用户看到的模型列表被砍到零星几个——`deepseek/deepseek-v4.1-flash` 就是典型
  （profile 里 `pi:xd:...=true` 而 `claude-code/codex:xd:...=false`）。开发机不受影响，
  因为 dev 短路读 `apps/pi-bin/<platform>/pi.exe`（`ensure-dev-runtime-assets.mjs`）。
  与 codexPackage 事故的差别是**它不阻塞启动**（`optionalAsset`），所以只表现为能力缺失，
  不会在 splash 上炸出来——也正因如此它跨了两个版本都没被发现。
- **历史事故（2026-09-16，Windows canary 0.0.21「环境初始化失败」）**：上游 `b43ee771ad`
  （2026-09-03，use Codex package in production）把生产侧 codex 换成目录分发，`bdc8397a7e`
  （2026-09-11）合并进 `meka/main`，**0.0.21 是合并后第一个包**；本仓发布链路却仍只发单文件
  `codex`。后果链条：canary 热更成功、新进程启动 → `prepare('codex')` 读不到
  `manifest.codexPackage` → `asset_missing`（`factory.ts` 取 vendor asset **先于**本地回退，
  本机既有的旧 `userData/codex/<ver>` 也救不回来）→ `check-environment` `allPassed=false` →
  splash 停在「环境初始化失败」。影响面是所有已升到该版本的客户端，且**无法自愈**：splash
  失败态下 renderer 不会消费 Phase 1 的 relaunch 结论，后台轮询即使下好补丁，
  `autoRelaunchOnIdle` 默认 `false`（`auto-update-settings-store.ts`）也会拦住自动重启——
  只能重装安装包。
  定位代价极高，原因是这条失败路径当时**一行日志都没有**。现已补两处：`agent-binaries` 在
  `prepareViaCdn` 失败时 `log.warn` 带 `manifest field`；`bootstrap-electron` 的
  `check-environment` 在每个失败分支 `console.error` 带 stage。
- 通用教训：改桌面端 runtime 消费契约（vendor kind 的 manifest 字段／产物形态）时，**必须同时**
  改发布链路，并把「该字段必须存在」写进发布侧断言。只改客户端会在下一个 canary 上炸，而且是在
  「打包、签名、冒烟全部成功之后」才炸给用户。反面案例同样成立：**可选** runtime 漏发不会炸，
  只会静默少能力（`pi` 段跨 0.0.21 / 0.0.22 两个版本没人发现），因此可选段的齐备断言不能省。

- CDN 的**单文件** runtime 对象是单二进制 gz（`codex/<version>/<platform>/codex[.exe].gz` +
  `binarySha256`），形态由 `apps/desktop/scripts/ci/runtime-release.mjs` 的 `RUNTIME_DEFINITIONS`
  定义。`publish-desktop.mjs` 在 `collectLocalRuntimeAssets` **之前**必须就位这些 runtime。
  目录分发的 `codexPackage` 与 `pi` 都不走这条本地收集链（前者直接转发 pin 字节，后者由 pin 下载后
  重打包，见前述 `pi` 段契约）。
- 契约：`scripts/ensure-agent-binaries.mjs` 的 `PUBLISHED_RUNTIME_KINDS`
  （claude / `codex-single` / ripgrep）与 `ensurePublishedRuntimes()` 和 `RUNTIME_DEFINITIONS`
  **一一对应**——改一边必须同时改另一边，否则发布会在收集本地资产时失败。`pi` **有意不在**这份
  名单里：目录分发段从 pin 直接发布，不依赖发版机 `apps/pi-bin/` 的落位状态（也就不会把
  GitHub API 配额花在安装侧路径上）。
- `codex-single` 带 `publicationOnly`：它**不进** `SUPPORTED_BINARY_KINDS`（dev/postinstall 自举集合），
  否则每次 dev 安装/启动都会多下 ~120MB，而 dev 根本不用单文件 codex。
- `codex-single` 的 `ensurePlatform` 同样支持 pin 降级（见上一节）：发布链路上配额耗尽时仍能从
  `tools/codex/latest.json` 的直链 + sha256 就位。
- **历史教训（2026-09-16，发布校验阶段 ENOENT）**：2026-09-03 的 codex-package 迁移把
  `KINDS.codex` 从 `codex-bin` 换成 `codex-package-bin`，却没有同步发布链路。于是
  `release:windows:canary` 打包、签名、冒烟全部成功后，在「本地发布校验」阶段读
  `apps/codex-bin/win32-x64/.version` 直接 ENOENT 失败（macOS canary 同构，只是先被别的阻断挡住）。
  它长期不可见有两个原因：干净 worktree 里 `apps/codex-bin` 不存在（构建产物不进 git），
  且前面还有 promote 竞态与 API 配额两个更早的阻断点，任务走不到发布阶段。它只解释了"发不出去"，
  **不能**解释"发出去了但客户端起不来"——后者是同一次迁移漏发的 `codexPackage` 段，见上一节。
- `collectLocalRuntimeAssets` 在缺 `.version` 时必须报出**点名 runtime + 路径 + 补齐命令**的错误，
  不得抛裸 ENOENT（无上下文的 ENOENT 让这条链多花了一轮排查）。

## pin 是下载信任锚：上游 API 限流不得阻断安装

**事实**：未认证的 `api.github.com` 配额是**每出口 IP 60 次/小时**。Windows runner 与开发机
是同一台机器、共用出口 IP，2026-09-16 的第二个 `release:windows:canary` 就在同一个 job 里把配额
耗尽（`pnpm install` 的 best-effort postinstall 会为 codex/pi 各取一次 release 元数据，加上
其它 job 的调用），随后 release 步骤解析 pin 元数据时直接
`HTTP 403 rate limit exceeded: https://api.github.com/repos/openai/codex/releases/tags/rust-v0.153.4`，
codex 与 pi 都装不上、发布被阻断。

**契约**：

- 安装链路的信任锚是**已复核并随仓库分发**的 pin（`tools/<kind>/latest.json` 的
  `runtimeAssets.<platformKey>`：官方资产直链 + sha256 + 字节数），不是可变的 API 元数据。
- **内容校验永不降级**：始终从 pin 记录的直链下载，并按 pin 的 sha256 逐字节校验（不符即失败），
  同时校验来源必须是 `https://github.com/...` 的 release 资产。
- **交叉校验尽力而为**：取到 API 元数据时照旧用 `assertPinnedRuntimeAsset` 比对；**仅**在限流
  （429，或 403 且带 rate limit 信号）时降级为纯 pin 模式，并打印明确告警
  （`WARN: GitHub API rate limit hit (...); installing from the reviewed pin instead (the pinned
  sha256 is still enforced).`）。降级只放弃"上游元数据是否仍与 pin 一致"这一层，不影响
  "下载物必须等于 pin 的 sha256"。
- **其它 API 错误仍 fail closed**：404（pin 指向的 release 已不存在）或 pin 不完整/字段非法时
  不得降级——降级路径同样要能拒绝坏 pin。
- 实现：`tools/shared/github-release-pin.mjs`（`isGitHubRateLimitError` /
  `pinnedAssetDescriptor` / `resolveInstallReleaseMeta`），由
  `tools/codex-package/update.mjs`、`tools/pi/update.mjs` 的 `ensurePlatform` 使用；
  HTTP 非 2xx 由 `tools/shared/fetch-with-timeout.mjs` 抛出带 `status` 的错误，供限流判定。
- `claude` 不走 GitHub API（用 `downloads.claude.ai` 的 per-version manifest），不受影响；
  `ripgrep` / 旧 `codex` 单文件链路仍会取 API 元数据（CI 已用 `Install-PinnedWindowsRipgrep`
  预置 ripgrep；如后续再遇到配额问题，按同一模式改）。需要更高配额时，开发机可自行
  设 `GITHUB_TOKEN`（工具已支持）。

## 本地落位（promote）与 Windows 目录改名

`apps/<kind>-bin/<platform>/` 是 gitignore 的构建产物，干净 checkout（CI 每个 job、新的
git worktree、首次 dev 启动）必然不存在，因此**每次都要走一次本地落位**（有兄弟 worktree
时这一步由本地复用完成，见下条）。这条路径的正确性
与"本机恰好已有安装"无关，必须按下面的契约实现。

- **网络之前先复用同版本兄弟 worktree 的「整目录」**（`scripts/ensure-agent-binaries.mjs`）：
  目录分发 kind 的复用已从「只复制主执行文件的单文件复用」改成**整目录 clone**，入口
  `tryReuseDirDistFromSiblingWorktree()`；`ensureBinary()` 在 `!force` 时对 `cfg.dirDist`
  调它（`claude` / `ripgrep` 等非 dirDist kind 仍走 `tryReuseFromSiblingWorktree()` 的单文件
  路径）。契约四点：
  - **复用来源**：`listSiblingWorktreeRoots(ROOT)`（`git worktree list --porcelain` +
    `realpathSync.native` 归一后排除本 checkout；git 不可用或不在 git 仓库里返回空数组，
    调用方**直接走网络、不报错**）映射到各兄弟 worktree 的 `apps/<binDir>/<platform>/`；
    只接受 `.version` 标记与当前 pin **完全相等**、且候选目录通过下面的结构校验的项。
  - **校验项**：候选先过 `isValidDirDist(candidateDir, candidateDir/<binaryRelativePath>,
    requiredFiles)`——主执行文件 `isValidBinary()`（存在、非 LFS 指针、非长度占位）+
    `verifyDirDistManifest()`（安装清单）+ `requiredDirDistFilesFor()` 列出的**必需资产**
    （如 pi 的 `theme/`；路径解析后不得越出目录根）。clone 到 staging 后**整份再校验一遍**，
    不过就换下一个候选。只验主执行文件会把缺旁侧资产的残缺目录当"已就位"复用。
  - **替换与失败回滚**：在同一文件系统的临时目录（`fs.mkdtempSync('<destDir>.reuse-')`）里
    `fs.cpSync(candidateDir, next, { recursive: true, mode: COPYFILE_FICLONE })`（不支持
    copy-on-write 的文件系统由 `cpSync` 自行回退普通拷贝）→ 校验 → 目标目录已存在就先
    `rename(destDir, previous)` 备份 → `rename(next, destDir)`；rename 失败则把 `previous`
    改回 `destDir` 再抛。**回滚也失败时立即抛 `Cannot restore previous runtime at …` 并停止，
    不得继续走网络下载**（不能拿一次下载覆盖掉现场证据）；其余失败（候选损坏、目标被占用）
    只 `warn` 并试下一个候选，staging 在成功或已回滚后清理，不留半成品。
  - **何时才走网络**：所有兄弟 worktree 都没有同版本合法目录（或调用方传了 `force`——它的
    语义是"强制重新获取"，因此**不复用**）时才回落到 `mod.ensurePlatform()`（含 pin 降级）
    与 CDN 兜底；复用本身是纯本地操作。复用之后同样受本节末尾的就位终检约束
    （`isValidDirDist` + `.version == pin`）。
    回归用例：`scripts/__tests__/ensure-agent-binaries.test.mjs` 的
    `directory reuse validates all assets, skips mismatches and replaces stale files`
    （版本不符/清单损坏的候选被跳过、clone 后目标不含旧残留、失败候选不影响目标）。

- **目录分发 runtime 的落位必须用有界退避重试**：`tools/codex-package/update.mjs` 的
  `replaceDirectory` 走 `tools/shared/rename-with-retry.mjs`。两处改名的预算刻意不同：
  - 落位（`staging → 目标`）用 `PLACEMENT_RENAME_RETRY_DELAYS_MS`（累计 ≥3.75s）；
  - 换下旧目录（`目标 → 备份`）用 `SWAP_RENAME_RETRY_DELAYS_MS`（很短）——这里的锁多半是
    "应用正在运行"，不会自己消失，不能让 dev 启动白等十几秒才报错。
- **事实（为什么必须重试）**：2026-09-16 在 Windows 发布机（XINDONG-PC）实测，
  `cpSync 整包 → writeDirDistManifest/verifyDirDistManifest → 立即 rename 目录` 这条
  promote 尾部稳定拿到 `EPERM`（faithful 路径连续实测 5/6、6/6 失败；`C:\Workspace` 与
  `%TEMP%` 下都复现）；同一 rename 推迟约 1s 成功，100/300ms 仍可能失败。对照实验把触发
  条件收窄到"**目录里含刚写入的 `.exe`**"：同一字节改名成 `data.bin` 或内容清零后 0/4 失败，
  单文件 rename 4/4 成功，失败瞬间仍能往目录里写新文件、也能删除目录。即这是系统级安全
  扫描/预读组件对可执行文件的瞬时占用，**与"是否有应用在运行"无关**；把它读成
  `target locked (probably running)` 是错误归因（2026-09-16 的 Windows canary 发布失败即如此）。
- **失败必须带阶段标签**：`tools/<kind>/update.mjs` 的 `ensurePlatform` 用
  `RuntimeInstallError`（`tools/shared/runtime-install-error.mjs`）区分 `download` 与
  `promote`。只有 `download` 阶段才允许上层考虑 CDN/网络兜底；`promote` 阶段失败**不得**
  包装成 `Failed to download ... from upstream`，也不得回退 CDN——下载/缓存其实已经成功，
  再下一次只会重蹈同一个本地失败。
- **成功不能被误报成失败**：落位完成后旧备份删不掉只告警
  （`WARN: 旧 runtime 备份未能删除，可手动清理：…`）；只有"要么新、要么旧"的不变量被破坏
  才算失败（新目录没落位时回滚旧目录）。
- 其它 kind 的现状：`pi` 的 promote 是"清目标 + 直接 cpSync 进最终目录"（不改名目录），
  `claude`/`ripgrep` 是单文件写入/改名，两者都不会踩这条 Windows 目录改名路径；它们的
  lock 分支只 warn，最终由 `scripts/ensure-agent-binaries.mjs` 的就位终检兜底。


## Linux 交付

桌面安装包发布只覆盖 Windows/macOS。MCPRouter 生产容器使用 `linux-x64`，因此 Linux
runtime 由独立发布入口负责：

```bash
node scripts/ensure-agent-binaries.mjs --kinds=claude,codex-single --platform=linux-x64
pnpm release:runtime:linux-x64
```

（`publish-agent-runtimes.mjs` 自己在收集本地资产前也会确保 `claude` + `codex-single` 就位；
目录分发的 `codexPackage` / `pi` **不依赖发版机 `apps/codex-package-bin` 的落位状态** ——
前者直接转发 pin 的官方整包，后者由 pin 下载后确定性重打包，见前文两节。）

该入口先上传/复用 immutable runtime 对象（含目录分发的 `codex-package/...`、
`pi/...`），最后更新 `runtime-manifest-linux-x64.json`。manifest schemaVersion 为 `1`，
包含 `platformKey`、`claudeCode`、`codex` 三段（每段含 `version`、`file`、`sha256`、`size`
与 `binarySha256`），外加三个**可选**段：`ccMgr`（`managerVersion`/`protocolVersion`）、
`codexPackage` 与 `pi`（目录分发四字段，见前文「linux runtime manifest 也必须带 …」）。
mutable manifest 必须最后处理并从公开 CDN 回读校验；远端内容逐字节相同时必须跳过写入，
使相同 pin 的重复发布不改变对象元数据或 Last-Modified。

`cindy-meka-cicd` 的独立 `runtime-assets` pipeline 与完整 `release` pipeline 都固定
`kapt66/cindy:meka/main` HEAD 后执行该入口。独立模式不构建桌面安装包、不修改
Canary/Stable 应用 manifest，也不创建 GitHub tag；完整 release 必须等 runtime job 成功后
才能继续解析桌面发布版本。

## 消费与保留

- MCPRouter 从公开 CDN 读取 runtime manifest 和 gzip，不使用 S3 API 或 RustFS 凭证。
- MCPRouter 按 kind/version/platform 缓存在其持久数据卷；只有 manifest 与本地 marker
  完全匹配且裸二进制重新计算 SHA-256 通过时才允许复用。
- 首次下载必须使用临时文件、校验 gzip、解压、校验裸二进制、设置执行权限后再原子替换。
- 实例 `start` 预热当前 `agentKind`，实际 tunnel mode 在打开前再次幂等 ensure；后者是
  Claude/Codex 依赖选择的最终依据。
- CDN manifest 请求不可用时可以读取最后一次已校验的本地 manifest；公网返回了非法
  manifest 或任一资产校验失败时必须 fail closed，不能静默降级。
- `CC_MGR_CLAUDE_BIN` / `CC_MGR_CODEX_BIN` 是显式运维覆盖，优先于 CDN；配置路径不存在
  时直接失败，不得偷偷改用下载版本。
- 已发布的版本化 runtime 对象必须长期保留。删除对象会让尚未缓存该版本的部署无法恢复；
  mutable manifest 不构成历史对象备份。

## 验证

- `node --test scripts/__tests__/meka-release-flow.test.mjs`
- 本地落位重试与阶段化归因（改 `tools/codex-package/update.mjs`、
  `scripts/ensure-agent-binaries.mjs`、`tools/shared/rename-with-retry.mjs` 后必须跑）：
  `node --test scripts/__tests__/rename-with-retry.test.mjs scripts/__tests__/codex-package-update-layout.test.mjs scripts/__tests__/ensure-binary-fallback.test.mjs`
- pin 降级与限流判定（改 `tools/shared/github-release-pin.mjs`、
  `tools/shared/fetch-with-timeout.mjs`、任一 `ensurePlatform` 后必须跑）：
  `node --test scripts/__tests__/github-release-pin.test.mjs scripts/__tests__/fetch-with-timeout.test.mjs scripts/__tests__/pi-update-layout.test.mjs scripts/__tests__/codex-single-pin-fallback.test.mjs`
- 发布物 runtime 就位（改 `PUBLISHED_RUNTIME_KINDS` / `RUNTIME_DEFINITIONS` / `publish-desktop.mjs` 后必须跑）：
  `node --test scripts/__tests__/ensure-agent-binaries.test.mjs scripts/__tests__/meka-release-flow.test.mjs scripts/__tests__/codex-single-pin-fallback.test.mjs`
- 应用 manifest 的 `codexPackage` 段（改 `runtime-release.mjs` 的
  `DIR_DIST_RUNTIME_DEFINITIONS` / `RELEASE_RUNTIME_DEFINITIONS`、`release-lib.mjs` 的
  `buildCanaryManifest`、`publish-desktop.mjs`、`reset-canary-desktop.mjs` 后必须跑）：
  `node --test scripts/__tests__/codex-package-cdn-release.test.mjs scripts/__tests__/meka-release-flow.test.mjs`
  （覆盖：pin 锚定与 fail closed、上传/幂等复用、字节数/sha256/同版本内容冲突必须失败、
  manifest 缺 `codexPackage` 必须报错）。
- linux runtime manifest 的两个可选目录分发段（`codexPackage` / `pi`；改
  `buildAgentRuntimeManifest` / `formatMekaDirDistManifestPreview` / `publish-agent-runtimes.mjs`
  后必须跑）：
  `node --test scripts/__tests__/codex-package-cdn-release.test.mjs scripts/__tests__/pi-cdn-release.test.mjs scripts/__tests__/meka-release-flow.test.mjs`
  （覆盖：段写入的形状与对象路径、不传段时形状与老契约逐字一致、缺段对消费端合法而对发布侧
  报错、段存在但形状非法 fail closed、`codexPackage` 摘要与 pin 同源、`pi` 摘要与 pin 不同且
  `pinned-sha256` 留证、dry-run 预览打印两段的对象路径）。
- 发版前 dry-run（不写 RustFS）：`pnpm release:win patch` 之前的
  `publish-desktop.mjs --build-info <path>` 预览必须打印
  `codex 目录分发 -> codexPackage <pin 版本> (codex-package/<ver>/<platform>/codex-package.tar.gz)`；
  发布后必须从 CDN 回读 canary manifest 确认 `codexPackage` 段与 `codex` 段**同时存在**。
- **定「manifest 字段缺失 → 启动失败」这类因果，不能只看静态事实**：2026-09-16 的定案方式是
  「同一份打包产物 + 唯一变量」的真机受控实验——现场 `electron-forge package` 出应用，用
  `XDT_CDN_BASE_URL`（`manifestService.getBaseUrl` 第一优先级）指向本地 mock CDN，两组 manifest
  仅差目标字段，并在隔离 userData 里预置旧单文件 runtime 复刻现场；用户可见文案用 CDP
  `Runtime.evaluate` 取 `document.body.innerText`。结论必须同时对上「main 日志」与「窗口真实文本」，
  只有一条链路的推断不算定案（当时的失败路径连日志都没有，见上一节的补日志改动）。
- 干净 checkout 复现（发布链路）：把 `apps/codex-bin/<platform>` 移走后
  `node scripts/ensure-agent-binaries.mjs --kinds=claude,codex-single,ripgrep --platform=<platform>`
  应把它补回，随后 `collectLocalRuntimeAssets('<platform>')` 必须成功。
- 干净 checkout 端到端（复现 CI 的 promote：目标目录不存在）：
  用只含 `tools/{shared,codex-package}` + `scripts/{ensure-agent-binaries.mjs,agent-binary-cdn-fallback.mjs,shared}`
  的临时 harness，先 `rm -rf apps/codex-package-bin`，再跑
  `node scripts/ensure-agent-binaries.mjs --kinds=codex --platform=win32-x64`；
  修复前应在 `[win32-x64] skip (cached, …)` 之后报 promote 失败，修复后应落地并写出 `.version`。
- CLI dry-run：
  `node apps/desktop/scripts/publish-agent-runtimes.mjs --platform linux-x64 --region cn`
  —— 输出必须包含 `codexPackage` / `pi` 两段的对象路径与段形状（`codexPackage` 的四字段与
  最终 manifest 逐字相同；`pi` 的 `sha256`/`size` 是 `null` 占位，注明 `--execute` 时按重打包
  产物填写）。dry-run 只读本地 pin 与规范表，**不触网**。
- CI 发布后确认公开 `runtime-manifest-linux-x64.json` 与它引用的**全部**资产均返回 200、大小与
  manifest 一致，并确认 `claudeCode`/`codex`/`codexPackage`/`pi`（以及发过的 `ccMgr`）**同时在册**；
  `codexPackage` 段的 `sha256` 必须等于 `tools/codex-package/latest.json` 里该平台的值。
