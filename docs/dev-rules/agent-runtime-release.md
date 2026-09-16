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
  `0.0.9/protocol 4`，在 protocol 3 的任意二进制 Skill 文件规范 base64 投递之上增加了
  Full access 前的 subagent 模型能力预检。修改该 pin 后必须运行
  `pnpm --filter @cindy/maker-cc-manager bundle`，并让 MCPRouter 从同一 Cindy 源码重建、探测
  和重启 daemon；只发布 Claude/Codex runtime 资产不会更新 cc-manager。
- MCPRouter 的构建探针、daemon 启动探针和 agent-tunnel smoke 必须声明同一精确 pin，且
  完整构建必须对 `CINDY_SRC` 当场生成的 bundle 执行 `--version` 探针。任一消费者或源码
  checkout 不一致都必须在镜像构建前失败，不能等到用户创建远程 Worker 才发现。
- 依赖 MCPRouter 原生 Skill 投递的强制工作流必须在业务探索前执行 capability hello，并以
  `CC_MGR_BUNDLE_VERSION` 与 protocol 精确匹配作为环境 ready 条件。实例 online、项目已绑定或
  普通 route 可查询都不能替代该握手；不得把旧 bundle 兼容降级成成功。版本错配时应停止业务
  流程并要求从同一 Cindy 源码重建、探测和重启远端 daemon。

## 发布物 runtime ≠ 桌面端打包 runtime

两侧是**两种产物、两个 pin**，改任何一侧都必须同时核对另一侧：

| 用途 | 产物形态 | 落点 | pin |
| --- | --- | --- | --- |
| 桌面端运行／打包（应用内 agent runtime） | codex **目录分发** | `apps/codex-package-bin/<platform>/` | `tools/codex-package/latest.json` |
| 发布到 CDN 的 runtime 对象 | codex **单文件** | `apps/codex-bin/<platform>/codex[.exe]` | `tools/codex/latest.json` |
| 两侧共用 | claude / ripgrep 单文件 | `apps/claude-code-bin/`、`apps/ripgrep-bin/` | `tools/claude/latest.json`、`tools/ripgrep/latest.json` |

- CDN runtime 对象是单二进制 gz（`codex/<version>/<platform>/codex[.exe].gz` + `binarySha256`），
  形态由 `apps/desktop/scripts/ci/runtime-release.mjs` 的 `RUNTIME_DEFINITIONS` 定义。
  `publish-desktop.mjs` 在 `collectLocalRuntimeAssets` **之前**必须就位这些 runtime。
- 契约：`scripts/ensure-agent-binaries.mjs` 的 `PUBLISHED_RUNTIME_KINDS`
  （claude / `codex-single` / ripgrep）与 `ensurePublishedRuntimes()` 和 `RUNTIME_DEFINITIONS`
  **一一对应**——改一边必须同时改另一边，否则发布会在收集本地资产时失败。
- `codex-single` 带 `publicationOnly`：它**不进** `SUPPORTED_BINARY_KINDS`（dev/postinstall 自举集合），
  否则每次 dev 安装/启动都会多下 ~120MB，而 dev 根本不用单文件 codex。
- `codex-single` 的 `ensurePlatform` 同样支持 pin 降级（见上一节）：发布链路上配额耗尽时仍能从
  `tools/codex/latest.json` 的直链 + sha256 就位。
- **历史教训（2026-09-16）**：2026-09-03 的 codex-package 迁移把 `KINDS.codex` 从 `codex-bin` 换成
  `codex-package-bin`，却没有同步发布链路。于是 `release:windows:canary` 打包、签名、冒烟全部成功后，
  在「本地发布校验」阶段读 `apps/codex-bin/win32-x64/.version` 直接 ENOENT 失败（macOS canary
  同构，只是先被别的阻断挡住）。它长期不可见有两个原因：干净 worktree 里 `apps/codex-bin` 不存在
  （构建产物不进 git），且前面还有 promote 竞态与 API 配额两个更早的阻断点，任务走不到发布阶段。
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
git worktree、首次 dev 启动）必然不存在，因此**每次都要走一次本地落位**。这条路径的正确性
与"本机恰好已有安装"无关，必须按下面的契约实现。

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
`codex` 是目录分发、只服务桌面端打包，**不参与 CDN runtime 发布**。）

该入口先上传/复用 immutable runtime 对象，最后更新
`runtime-manifest-linux-x64.json`。manifest schemaVersion 为 `1`，包含 `platformKey`、
`claudeCode` 与 `codex` 三部分；每个资产字段包含 `version`、`file`、`sha256`、`size` 与
`binarySha256`。mutable manifest 必须最后处理并从公开 CDN 回读校验；远端内容逐字节相同
时必须跳过写入，使相同 pin 的重复发布不改变对象元数据或 Last-Modified。

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
- CI 发布后确认公开 `runtime-manifest-linux-x64.json` 及其两个资产均返回 200，大小与 manifest
  一致。
