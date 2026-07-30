# Cindy Meka Desktop 发布与热更新

本文描述 Cindy Meka Desktop 的私有发布流程。Mobile 不在本流程中；Cindy Mobile
继续通过 Cindy device-link 协议连接 Cindy Meka Desktop。

## 1. 发布模型

发布分四步，任何一步都不自动代替下一步：

1. `release:package`：在目标 OS 本地构建、签名并生成 `build-info.json`。
2. `release:publish`：复核 `build-info.json` 和产物哈希，把版本化文件上传到 RustFS，
   最后写 canary manifest。
3. 真实 canary 安装/热更新验收。
4. `release:promote`：备份当前 stable manifest，再把已验收的 canary 提升为 stable。

回滚只移动 stable manifest 指针，不覆盖或删除版本化安装包/热更包。

## 2. RustFS 与 CDN 配置

复制：

```powershell
Copy-Item apps/desktop/scripts/release-regions.json.example `
  apps/desktop/scripts/release-regions.json
```

`release-regions.json` 已被 Git 忽略。每个 `cn` / `global` / `dev` 块分别配置：

- `oss.cdnBaseUrl`：公开只读 CDN 根地址，必须直接映射到最终发布根目录。
- `oss.bucket`：Cindy Meka 独立 RustFS bucket。
- `oss.prefix`：共用 bucket 时固定为 `cindy-meka`；独立 bucket 名为
  `cindy-meka` 且直接使用桶根目录时填写 `/`。
- `oss.ossRegion`：RustFS S3 region。
- `s3.endpoint`：RustFS 的 S3 API 地址。
- `s3.forcePathStyle`：RustFS 通常使用 `true`。
- `s3.accessKeyIdEnv` / `secretAccessKeyEnv`：存放真实凭证的环境变量名。
- `s3.sessionTokenEnv`：仅临时凭证需要；不用时留空。

真实凭证只放发版机环境：

```powershell
$env:CINDY_MEKA_RUSTFS_ACCESS_KEY_ID = '<access-key>'
$env:CINDY_MEKA_RUSTFS_SECRET_ACCESS_KEY = '<secret-key>'
```

发版凭证只需限定在对应 bucket 的发布根目录，并授予读取/HEAD 与写入对象；
脚本不删除远端对象，也不需要删除权限。

也可以用 `CINDY_MEKA_S3_ENDPOINT` 覆盖配置文件中的 endpoint。S3 API 与客户端下载根
地址都强制 HTTPS，不提供 HTTP 放行开关。

当前正式 RustFS 地址：

- S3 API 与公开对象入口：`https://s3.meka.pawdy.fun/`
- 管理控制台：`https://s3-admin.meka.pawdy.fun/`；仅供管理员操作，不得配置为
  `cdnBaseUrl` 或 `s3.endpoint`。

独立 `cindy-meka` bucket 的正式示例：

```json
{
  "oss": {
    "cdnBaseUrl": "https://s3.meka.pawdy.fun/cindy-meka",
    "bucket": "cindy-meka",
    "prefix": "/",
    "ossRegion": "us-east-1"
  },
  "s3": {
    "endpoint": "https://s3.meka.pawdy.fun",
    "forcePathStyle": true
  }
}
```

正式包启动前必须能从 `${cdnBaseUrl}/endpoint.json` 读取 CN 端点清单。
`release:publish` 会从仓内 `config/endpoint.json` 自动生成并上传公开副本：保留
CindyAI、登录与插件市场等 HTTPS 业务端点，将其中的 `cdnBaseUrl` 留空，使
Cindy Meka 回退到构建时显式批准并烘焙的同一发布根地址，不继承上游 Cindy 更新渠道。

CDN 必须允许匿名 `GET` / `HEAD`，RustFS 凭证不能暴露给客户端。manifest 使用
`no-store`；版本化安装包和 ZIP 使用一年 immutable cache。

## 3. 构建

### 3.1 固定 CN 渠道快捷发布

发版机已经固定使用 Cindy Meka 的 CN/RustFS 配置时，优先使用与旧 Meka 一致的快捷
入口。`release:*` 会完成“打包、签名、本地复核、上传版本化产物、写 canary manifest”
整个流程，并保证 manifest 同时包含首启环境初始化所需的 Claude Code 与 Codex
运行时资产；它不是仅打包命令。

```powershell
# Windows x64：明确版本或按远端 canary/stable 基线自动 bump
pnpm release:win 0.0.12
pnpm release:win patch

# macOS：缺省连续发布 arm64 + x64，也可只发一个架构
pnpm release:mac 0.0.12
pnpm release:mac patch
pnpm release:mac:arm64 patch
pnpm release:mac:x64 patch
```

首次发布没有远端版本基线，不能使用 `patch`，必须传明确版本。需要更新说明或强制重新
登录时可继续透传参数：

```powershell
pnpm release:win 0.0.12 -- `
  --release-notes-file C:\path\release-notes.txt --require-relogin
```

canary 验收后使用固定平台推进命令；不带 `--yes` 只预览：

```powershell
pnpm release:promote:win
pnpm release:promote:win -- --yes

pnpm release:promote:mac
pnpm release:promote:mac -- --yes
pnpm release:promote:mac:arm64 -- --yes
pnpm release:promote:mac:x64 -- --yes
```

macOS 双架构快捷命令会先让两个架构全部完成本地校验，再开始逐个写 canary；双架构
推进也会先预览两个目标，再在 `--yes` 模式下逐个推进 stable。

首次安装尚未登录时只能读取 stable manifest，不能识别账号的 canary 标记。因此首包
即使已经发布到 canary，也必须在验收后执行对应的 `release:promote:* -- --yes`，否则
新安装客户端会因 stable manifest 404 而无法下载 Agent 运行时、停在环境初始化页。
登录完成后，客户端把服务端 canary 标记与 Cindy Meka 本地名单合并；任一命中即读取
canary manifest。

### 3.2 底层分步命令

Windows x64 示例：

```powershell
pnpm --filter desktop release:package -- `
  --platform win32 --arch x64 --region cn --version 0.0.12
```

Windows 正式构建必须设置 `CINDY_WIN_SIGN_CMD` 或 `NPKG_TOKEN`。发布侧会再次检查
`build-info.json`，拒绝 installer、uninstaller 或包内 exe 未签名的结果。

macOS 使用原 Meka 自签证书示例：

```bash
MAC_SIGNING_MODE=self-signed \
APPLE_SIGN_IDENTITY='<Meka certificate name>' \
pnpm --filter desktop release:package -- \
  --platform darwin --region cn --version 0.0.12
```

macOS 缺省同时构建 arm64 与 x64；每个架构有独立 `build-info.json`。正式发布只接受
`self-signed` 或 `developer-id+notarized`，拒绝 ad-hoc 包。

产物位于：

```text
apps/desktop/release/artifacts/<region>/<version>/<platform-arch>/
```

## 4. 发布到 canary

先做无远端写入的本地复核：

```powershell
pnpm --filter desktop release:publish -- `
  --build-info <absolute-path-to-build-info.json>
```

确认计划后执行：

```powershell
pnpm --filter desktop release:publish -- `
  --build-info <absolute-path-to-build-info.json> --execute
```

可选参数：

- `--release-notes-file <path>`：写入本版更新说明。
- `--require-relogin`：仅本版确实改变登录授权契约时使用。

写入顺序固定为：

1. `app/<platformKey>/<installer>`
2. `hotfix/<platformKey>/<zip>`
3. `manifest-<platformKey>-canary.json`

版本化对象不可覆盖。同一路径存在相同 SHA256/size 时幂等复用；内容不同则中止。
manifest 写入后脚本会从 CDN 带 cache-bust 重新读取并核对全文哈希。

## 5. 推进 stable

不带 `--yes` 只预览：

```powershell
pnpm --filter desktop release:promote -- `
  --region cn --platform win32 --arch x64
```

canary 验收通过后：

```powershell
pnpm --filter desktop release:promote -- `
  --region cn --platform win32 --arch x64 --yes
```

当前 stable 会先备份到：

```text
back-up/<stable-version>/manifest-<platformKey>.json
```

随后写 stable manifest，并从 CDN 反向校验。macOS arm64/x64 必须分别推进。

## 6. Canary 撤回与 stable 回滚

### 6.1 将 canary 对齐回 stable

不要手动删除版本化 installer、hotfix 或运行时资产。需要撤回未推进的 canary，或已经
手动删除 canary manifest 后希望恢复可读指针时，使用：

```powershell
# Windows：默认只预览
pnpm release:reset-canary:win
pnpm release:reset-canary:win -- --yes

# macOS：缺省先预览 arm64 + x64，再逐架构执行
pnpm release:reset-canary:mac
pnpm release:reset-canary:mac -- --yes
```

脚本先校验 stable manifest 引用的 installer、hotfix、Claude 与 Codex 资产仍存在；
当前 canary 存在时按“版本 + manifest 全文 SHA256”写入
`back-up/canary/<version>/<sha256>/manifest-<platformKey>.json`，随后把 stable manifest
全文写到 canary 指针并从 CDN 反向校验。版本化产物不会删除。

该操作不是客户端降级：已经安装更高 canary 的客户端仍会因严格 SemVer 保持当前版本，
需要重新安装 stable，或等待一个更高版本发布。

### 6.2 回滚 stable

先预览：

```powershell
pnpm --filter desktop release:rollback -- `
  --region cn --platform win32 --arch x64 --to-version 0.0.11
```

确认后追加 `--yes`。回滚前仍会备份当前 stable。

回滚不会让已经安装较高版本的客户端降级：客户端严格比较 SemVer，拒绝
`manifest <= 当前安装版本`。它只阻止尚未更新的用户继续取得问题版本；已更新用户需要
发布一个更高版本的修复包。

## 7. 发布前验收

- Windows：安装包签名、包内 exe 签名、旧版 → canary 热更、启动与卸载。
- Windows 图标变更：热更替换并验证新进程启动后，确认开始菜单、运行中任务栏按钮与
  悬浮缩略图均显示新图标；更新器会发送 `SHCNE_ASSOCCHANGED` 使 Shell 图标／关联缓存
  失效，但该 best-effort 通知不参与更新成功判定。注意热更由更新前版本的 updater
  执行：首次发布含该能力的 canary 后，还要再发布一个更高版本，由前一版执行第二次
  热更，才能覆盖这条通知路径。
- macOS：两个架构分别核对 bundle id、`CFBundleExecutable`、Mach-O 架构、签名；
  模拟新包启动失败时确认旧 `.app` 被恢复。
- RustFS：bucket/prefix 与 Cindy 隔离，凭证仅发版机可见。
- CDN：安装包/ZIP 可匿名读取；canary/stable manifest 不被边缘缓存滞留。
- stable 推进前保存本版 `build-info.json` 和终端发布日志。
