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

- `oss.cdnBaseUrl`：公开只读 CDN 根地址，必须直接映射到该 bucket 的
  `cindy-meka/` prefix。
- `oss.bucket`：Cindy Meka 独立 RustFS bucket。
- `oss.prefix`：固定为 `cindy-meka`，避免与 Cindy 渠道混用。
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

发版凭证只需限定在对应 bucket 的 `cindy-meka/` prefix，并授予读取/HEAD 与写入对象；
脚本不删除远端对象，也不需要删除权限。

也可以用 `CINDY_MEKA_S3_ENDPOINT` 覆盖配置文件中的 endpoint。生产发布要求 HTTPS；
`CINDY_MEKA_ALLOW_INSECURE_S3=1` 只允许用于隔离的本地 RustFS 测试。

CDN 必须允许匿名 `GET` / `HEAD`，RustFS 凭证不能暴露给客户端。manifest 使用
`no-store`；版本化安装包和 ZIP 使用一年 immutable cache。

## 3. 构建

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

## 6. 回滚

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
- macOS：两个架构分别核对 bundle id、`CFBundleExecutable`、Mach-O 架构、签名；
  模拟新包启动失败时确认旧 `.app` 被恢复。
- RustFS：bucket/prefix 与 Cindy 隔离，凭证仅发版机可见。
- CDN：安装包/ZIP 可匿名读取；canary/stable manifest 不被边缘缓存滞留。
- stable 推进前保存本版 `build-info.json` 和终端发布日志。
