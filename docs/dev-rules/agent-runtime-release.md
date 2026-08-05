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

## Linux 交付

桌面安装包发布只覆盖 Windows/macOS。MCPRouter 生产容器使用 `linux-x64`，因此 Linux
runtime 由独立发布入口负责：

```bash
node scripts/ensure-agent-binaries.mjs --kinds=claude,codex --platform=linux-x64
pnpm release:runtime:linux-x64
```

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
- CLI dry-run：
  `node apps/desktop/scripts/publish-agent-runtimes.mjs --platform linux-x64 --region cn`
- CI 发布后确认公开 `runtime-manifest-linux-x64.json` 及其两个资产均返回 200，大小与 manifest
  一致。
