# cindy-updater 高风险模块

> **状态**：权威开发规则（authoritative）
> **读取时机**：修改客户端自动更新链路（`cindy-updater` 或 Electron 侧更新服务）之前

`cindy-updater` 负责桌面客户端的自动更新，由独立的更新器（`apps/desktop/cindy-updater/`，
Tauri 实现）与 Electron 侧的更新服务（`apps/desktop/src/main/updateService.ts`）组成。它是
分发层的高风险模块：一处改错会无差别影响所有已安装用户。

本文只约束「改动更新链路的开发门禁」，不涉及对外版本发布、签名与渠道等商业分发细节
（按既有决策不进公开开发文档）。

## 核心门禁

**任何对 `cindy-updater` 及其相关更新链路的修改，都必须先与仓库维护者确认后再
动手。** 未经确认不得提 PR 或直推。

- 收到「改更新器 / 调整更新逻辑 / 改更新服务」的诉求时**先停下**，不要直接动代码。
- 把「改哪里、为什么改、预期影响、如何回滚」整理清楚，主动找 owner 讨论并取得明确
  确认。
- 确认通过后再实现，并在 PR 说明里写明「更新器改动已与 owner 确认」。

## 为什么这么严

自动更新链路与普通功能不同：它决定用户机器上的客户端如何被替换。这里的回退难以
事后补救——

- 一个坏更新会推送给全体用户，可能导致更新失败、装到损坏版本，甚至更新器自身损坏后
  无法再自我修复。
- 更新行为发生在用户机器上、跨 Windows / macOS 两端，本地测试很难覆盖真实的
  安装—替换—重启全过程。
- 影响面是“全体已安装用户”，不是单次会话，出问题的代价远高于普通功能。

## 事实来源

| 内容 | 权威来源 |
|---|---|
| 独立更新器（Tauri） | `apps/desktop/cindy-updater/`（`src-tauri/` 为 Rust 实现） |
| Electron 侧更新服务 | `apps/desktop/src/main/updateService.ts` |

先读实际代码再决定实现；不要只凭文档或记忆猜测更新流程。

## Review 要点

1. 改动是否触及更新器或更新服务？触及就必须先有 owner 确认，PR 说明写明。
2. 是否在普通功能 PR 里“顺带”改了更新链路？高风险改动必须独立、显式、经确认。
3. Windows / macOS 两端的安装—替换—重启路径是否都评估到位？回滚方案是否清晰？

## Windows 热更后的 Shell 刷新

Windows 热更包会直接覆盖安装目录，不会重新执行 NSIS。新进程启动并验证成功后，
`cindy-updater` 必须以 best-effort 方式调用
`SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, null, null)`，让 Shell 失效
任务栏 AppUserModelID 分组图标及文件关联图标缓存。该通知无返回值，不得改变更新成功
判定；失败安装和回滚路径不得发送新版本刷新通知。图标变更的 canary 验收必须同时检查
开始菜单、运行中任务栏按钮和悬浮缩略图，不能只检查包内资源或安装器图标。

执行热更的是更新前版本复制到临时目录的 updater，因此“首次带入 Shell 刷新能力”的
版本仍由旧 updater 安装，不会在该次更新中发送通知。验证时必须先安装／更新到已携带
该能力的 canary，再由它热更到更高版本；或者直接安装该 canary 后再测试下一次热更。

验证命令按 [`desktop-development.md`](desktop-development.md) 选择；更新链路的真实行为
无法靠单测完全覆盖，评估与实测结论必须如实记录。

## Windows 安装目录身份必须用 stable 工具链可编译的 API

更新器在替换前会「钉住」安装目录并校验它没被换成重解析点（junction / symlink），
判据是 `InstallDirIdentity { is_reparse, device, inode }`（`installer.rs` 的
`capture_install_dir_identity` / `install_dir_identity_unchanged`）。取 `device` / `inode` 时：

- **不得使用 `std::os::windows::fs::MetadataExt::volume_serial_number()` /
  `file_index()`**：这两个方法至今仍在 `windows_by_handle` 不稳定特性后面
  （rust-lang/rust#63010）。发布链路用的是 **stable** Rust，走 std 会直接
  `error[E0658]` 让 `cargo build --release` 失败，进而让整个 Windows 打包中止
  （2026-09-18 canary 实测）。改用 `GetFileInformationByHandle` 读同一份
  `BY_HANDLE_FILE_INFORMATION`（`dwVolumeSerialNumber` + `nFileIndexHigh/Low`），
  语义与 std 内部实现一致；目录句柄需要 `FILE_FLAG_BACKUP_SEMANTICS`。
- **`OWNER_SECURITY_INFORMATION` 从 `windows_sys::Win32::Security` 导入**，不在
  `Security::Authorization`（后者只提供 `GetNamedSecurityInfoW` 与 `SE_FILE_OBJECT`）。
  从 `Authorization` 导入必然 `error[E0432]`。
- **取不到身份一律 fail closed**：`capture_install_dir_identity` 返回 `Err`，
  安装以「无法钉住安装目录 …」中止且不可重试；`install_dir_identity_unchanged`
  对 `Err` 判「已变」从而拒绝复制。**不得**退化成 `unwrap_or(0)` 这类「全 0 身份」——
  那会让两侧比较都命中 0 而把「目录已被换掉」误判成「没变」。

该约束的原因与影响：更新器编译失败**不是**「少个功能」，而是**所有 Windows 打包（含
canary 与正式发布）全部中止**，且报错位置在 `cargo` 而不是本仓 TS 门禁里 —— 只有真正
跑一次打包才会暴露。因此改动 `installer.rs` 后**必须**至少跑通
`cargo build --release --manifest-path apps/desktop/cindy-updater/src-tauri/Cargo.toml`
（等价于 forge 的 prePackage），以及
`node apps/desktop/scripts/check-windows-installer.mjs`。

**已知未修**：该文件里 3 处 `#[test]` 直接调用 `std::os::unix::fs::symlink` 而未加
`#[cfg(unix)]`，导致 Windows 上 `cargo test -p cindy-updater` 无法编译（`cargo build`
不受影响，仓库任何门禁也不跑它）。属上游同批引入的缺陷，未擅自扩大范围。

## 更新与运行时资产根地址

`manifestService.getBaseUrl()` 同时服务应用热更新与 Claude Code、Codex、ripgrep 等运行时
资产下载。解析顺序固定为：显式 `XDT_CDN_BASE_URL` → 启动端点清单的非空
`cdnBaseUrl` → 构建期烘焙的 `VITE_ENDPOINT_MANIFEST_BASE_URL`。最后一层是 Cindy Meka
私有渠道的兼容边界：其公开 `endpoint.json` 有意把 `cdnBaseUrl` 留空，避免继承上游 Cindy
更新渠道；正式构建必须回到发布时已批准并烘焙的同一清单根。不得把空值直接拼成
`/manifest-*.json` 相对路径。

该优先级由 `updateBaseUrl.test.ts` 的纯函数测试与 `manifestService.test.ts` 的服务接线测试
共同锁定。修改端点清单解析时必须同时验证应用 manifest 与 Agent 运行时资产下载，不能只
验证 `endpoint.json` 自举成功。
