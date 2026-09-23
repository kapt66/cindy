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

**已知缺陷（2026-09-23 已补）**：该文件里 3 处 `#[test]` 直接调用
`std::os::unix::fs::symlink` 而未加 `#[cfg(unix)]`
（`install_dir_identity_rejects_a_swapped_reparse_point`、
`copy_tree_into_pinned_rejects_a_swapped_destination`、
`pinned_join_rejects_a_descendant_junction`），导致 Windows 上
`cargo test -p cindy-updater` 无法编译。属性已在 §6.60 那轮补齐，现在 `cargo test --lib` 在
Windows 可编译并执行 65 项；`cargo build` 与上面的打包门禁要求不变。

## Windows 热更的启动与重试契约

### 替换成功后的启动一律用自身令牌（`launch_detached`）

`installer.rs` 在文件替换完成后用 `launch_detached` 启动新版 `Cindy.exe`。**不得**再把
「链接中等完整性令牌 + `CreateProcessWithTokenW`」的反提权启动塞进成功路径，更不得把它
的失败升级成安装失败。2026-09-22 的线上事故（0.0.22 无法升到 0.0.23）就是这条：

- #4502 在成功路径上加了该握手。在 `CreateProcessWithTokenW` 不可用的机器上它返回
  `ERROR_INVALID_PARAMETER`（os error 87），配套的完整性探测返回
  `ERROR_BAD_IMPERSONATION_LEVEL`（1346）；
- 失败被当成「安装失败」→ **回滚一份已经替换成功的安装目录** → 版本永远不变；
- 同一次失败还把暂存 ZIP 移出 `updates/`，客户端只好整包重下（每次 325 MB + 一次 UAC +
  一次完整替换与回滚）；而每次重下都会让重试计数归零（机制见下节），于是无限循环。

上游已在 `5b10e9babc`（「恢复原更新权限流程并保留失败重试」）把这条握手整体回退，本仓与之
对齐。**不变量（精确版）：启动的完整性决策不得被令牌编排门控——不得因为「怎么把它拉起来」
的令牌处理而把一次已完成的替换判成安装失败。**

**该不变量不覆盖启动本身失败**：替换之后仍有两条路径会回滚，且与上游 `5b10e9babc` 同形，
是本仓刻意保留的上游语义，不是遗留待办：

| 残留回滚点 | 代码 | 说明 |
|---|---|---|
| `launch_detached` 返回 `Err` | `installer.rs` 的 `install_result` 闭包 | AV/EDR 拦 `CreateProcessW`、镜像被锁（os error 2/5） |
| `poll_until_process_running` 3 秒内未见进程 | 同上 | 慢机/杀软扫描/新版秒退；这是唯一现实可达的残留点 |

代价由客户端侧兜底：同一版本最多交付 3 次，之后停止自动 apply 并引导手动安装（见下节）。
**不要**在此基础上继续分叉出「替换完成标记」之类的机制，除非同时推翻本节与上游的一致性。

安全取舍（显式记录，不是遗漏）：在「提权更新器 + 中等完整性可写安装目录」这一组合下，
重新启动的 Cindy 会继承更新器的令牌——这与 #4502 之前的长期行为一致，也是上游回退后的
现状。若要重新收紧这条，必须在不把启动失败升级为安装失败的前提下实现，并且自带失败退化
路径；否则会再次把用户钉死在旧版本上。

相关参数语义收窄（不是死参数）：`--install-writable` 在被删的 `may_relaunch_with_current_integrity`
里曾是启动判定的第 3 个入参，现在**只**驱动 staging 选择
（`resolved_install_writable` → `staging_dirs` / `staging_dirs_for`），仍会被解析并在 UAC
自我提权时转发。它不再影响「用谁的令牌启动」，改动这条链路时不要以为它还管启动。

### 重试预算必须跨「重新下载」存活

`patch-info.json` 的 `applyAttempts` **不能单独**作为放弃判据：它只活在该文件存活期内。
`cleanOldFiles()` **刻意保留** `patch-info.json`（它在 `persistentFileNames` 允许名单里，与
`.updating`、`apply-state.json` 一样），但**每条失败路径都会把它删掉**
（`handleApplyFailure()`、`checkExistingPatch()` 的孤儿分支、`discardExistingPatch()`），
而下次下载成功的 `writePatchInfo()` 重写该文件时**根本不带 `applyAttempts`** —— 计数因此每轮
归零。Windows 更新器在可重试失败后还会把暂存 ZIP 移出 `updates/`，正好强制这次重下。旧实现里
`attempts >= 3` 因此永远打不到。

放弃判据落在 `updates/apply-state.json`（`{ version, attempts, abandoned?, abandonedAt? }`）：

- `incrementApplyAttempts()` 在写 `patch-info.json` 的同时镜像写入该文件，计数**按目标版本**
  归属；manifest 广告的版本一变，预算自然重置（新版本不该被上一版本的失败拖住）；
  计数同时保留一份**进程内镜像**（`applyStateMirror`）：增量是「上一次的值 + 1」，
  所以不能依赖落盘成功 —— 文件被 AV/EDR 持续占用（或落到共享原子写工具承认的
  `.bak` 不可恢复态）时，磁盘计数会停住、上限永远打不到，而这正是用户连续点「重试」时最糟的
  形态。**「上一次」的定义要写清**：同版本 `max(磁盘值, 进程内镜像) + 1` ——
  镜像无条件更新，且**磁盘可读也不能当作够新**（「文件可读、但每次替换都被拒」是常见形状，
  只信磁盘会让每轮都算「旧值 + 1」，上限永远打不到）。
  读侧同理：`spentApplyAttemptsFor()` 取 `max(磁盘, 内存镜像, patch-info)`；
  镜像随进程结束消失（重启即新会话），持久化仍由该文件负责；
- **该文件必须留在 `cleanOldFiles()` 传给 `cleanOldUpdateFiles(..., persistentFileNames)` 的
  保留名单里**，当前名单为
  `[patch-info.json, .updating, apply-state.json, apply-state.json.bak]`。
  `cleanOldUpdateFiles` 会删掉 `updates/` 下所有其它文件，漏登记就等于在最需要它的那次重下里
  把计数清掉、死循环原样复现；回归用例
  `keeps the durable attempt counter across the re-download after a failure` 钉住这一点。
  `.bak` 必须一起保留：该文件用共享的 `atomicWriteFileSync` 写入，主文件缺失时 `.bak` 是唯一
  有效快照（`readAtomicFileSync` 会把它恢复回来），删掉它等于静默把预算归零；
- 达到 `MAX_APPLY_ATTEMPTS`（3）后，**下载前闸门**与 `checkExistingPatch` 两处都判定
  「已耗尽」，且两处取**同一个口径**
  `spentApplyAttemptsFor(version) = max(durable, 内存镜像, patch-info)`
  ——只看持久记录会让放弃分支在同一次里触发、却又被随后的下载覆盖；两处的放弃动作也必须一致：
  **按版本**删掉暂存包与 patch-info（不得误伤其它版本的暂存包）+ 清掉匹配版本的
  `relogin-required.flag`；**不再下载、不再自动 apply**，终态**由闸门统一**置 `error` +
  `errorCode: 'update_apply_exhausted'` 并广播（`checkExistingPatch` 只负责清场）；
- 终态的**释放**条件只有两个**可达**路径，且都在主进程：manifest 广告的版本变成另一个
  （在算出 `latestVersion` 后、`invalid`/`same`/`older` 这些 early-return **之前**释放并广播
  `idle`，否则终态会永久留在进程里）、或该版本成为已安装版本（冷启动
  `reconcileApplyStateWithInstalledVersion()` 清记录）。持久化记录**按版本号归属**，
  版本身份用 `compareAppUpdateVersions(...) === 'same'` 判定（`v0.0.65` / `0.0.65+build`
  与 `0.0.65` 是同一条记录），所以**同一版本号 repack 会被拒绝**（见发布纪律）。
  （另有一处**不可达**的防御性清除：下载失败路径顺手清 `lastErrorCode`/终态；
  走到那里之前必定已经 `setStatus('downloading')`，不必据它推导行为。）
- 持有终态期间，所有「本轮没有可装的更新」出口都必须回答 `'apply_exhausted'` 而不是 `'idle'`
  （manifest 无资产、跨实例渠道变更等），否则用户会同时看到「已经是最新版本」的 toast 和
  「请手动安装」的弹窗；
- `checkForUpdate()` 在终态返回结果是**独立的 `'apply_exhausted'`，不是 `'idle'`**：用户点
  「检查更新」时必须看到「已停止自动重试，请手动安装」，不能被告知「已是最新版本」；
- 渲染端据此给「手动下载新版本 / 稍后」两条出路（`update.applyExhausted.*`，入口复用
  `websiteUrl()`），**不给重试按钮**（主进程已经不会再尝试）。弹窗是终态下**唯一**的 UI
  （`isErrorOnly` 分支不再渲染横幅主体），所以「稍后」之后靠侧栏火焰按钮唤回。
  弹窗打开时机的口径与真值表：
  1. **主进程保持终态**：`applyExhaustedVersion` 记住被放弃的版本，只要 `status` 仍是
     `error` 且 `lastErrorCode` 仍是 `update_apply_exhausted`，这一轮就**不广播 `checking`**，
     也不把 `currentStatus` 悄悄降回 `idle`（含 manifest 拉取失败等所有「无事可做」出口）。
     渲染端把 `checking` 渲染成「没有可跟的更新」并卸载弹窗，漏了这条就会每 30 分钟拆装一次
     弹窗：重放开场动画、把焦点抢回主按钮，而用户正在输入时紧接的 Enter 会直接打开浏览器。
     **这是防拆装的唯一保证**；
  2. **渲染端没有任何独立的一次性防线**（曾经有过一个 `applyExhaustedShownForRef`，已删除：
     两个关闭路径都会 `dismiss()`，于是「弹窗关着」恒蕴含 `dismissed === true`，那个 ref
     永远不是真正拦住重开的那道闸）。它只做一件事：`isApplyExhausted && !dismissed` 时
     `setShow(true)`。因此：

     | `dismissed` | 弹窗 | 用户可见结果 |
     |---|---|---|
     | `false` | 开 | 终态下的唯一 UI（正常态）。重新挂载（组件 state 复位）会重新自动弹 |
     | `true` | 关 | **重新挂载不会重开**：`dismissed` 在模块级 store 里跨卸载存活，effect 直接早退。唯一回入口是侧栏火焰（即：收起「rail」态下需要先展开侧栏），或重启进程 |

     因此「为什么点过『稍后』之后还能再看到引导」完全依赖上一条火焰：**不要**把
     `hasBlockedUpdate` 从 `isFlameReopen` 里去掉，也不要为了「每版本只弹一次」再加一次性标记
     （那会造出一个没有入口的死态）。
  「稍后」后靠侧栏火焰唤回：`UserInfoSection` 新增 `hasBlockedUpdate = status === 'error' &&
  errorCode === UPDATE_APPLY_EXHAUSTED_ERROR_CODE`，`isFlameReopen` 由
  `hasPendingUpdate && dismissed` 改为 `(hasPendingUpdate || hasBlockedUpdate) && dismissed`
  （`hasPendingUpdate` 本身未改）。**已知边界**：侧栏处于收起「rail」态时 `UserInfoSection`
  只渲染头像、没有火焰按钮，此时必须**先展开侧栏**才能唤回弹窗（重新挂载不会重开，见上表）；
  这与 `translocated` / `spawnFailed` **不完全同形**：那两个弹窗 `showCancel={false}`、
  用户根本关不掉，因此不存在「关掉后没入口」的问题；
- 记录的清除：`clearApplyStateFor(version)` 用 `compareAppUpdateVersions(...) === 'same'`
  判定归属（不是字符串相等，`v0.0.64` / `0.0.64+build` 都算同一版本），由
  `patch-info.version` 命中已装版本的分支、以及冷启动
  `reconcileApplyStateWithInstalledVersion()` 两条路径触发——后者专门覆盖「用户按弹窗引导
  手动安装」这条路（手动安装不写 patch-info，前者永远到不了）。
  读失败与「不存在」必须分开：`readApplyStateDetailed()` 把非 ENOENT 的读取失败标成
  `unreadable`，`clearApplyStateFor` 遇到它**不删**——那可能是**另一个版本**的记录，
  删掉就等于把它的预算清零。

**UI 落点与双模式**：本次只新增一个 `ConfirmDialog`（复用 `components/ui/confirm-dialog`）、
一个标题栏 toast 文案、侧栏火焰的既有唤回路径，以及本地库恢复界面 `LocalDbFatalScreen` 的一个
新视图态（复用同一个 `ConfirmDialog`，主按钮走 `window.open(websiteUrl(), '_blank')`），
**未新增任何样式、颜色、圆角或尺寸硬编码**，
浅/深色都走既有语义 token（依据 `docs/design-rules/DESIGN.md` §5 与 `design-governance.md`）。
**未做实机双模式目检**，如实登记为未验证。`titleBar.updateCheckToast.applyExhausted`、
`update.applyExhausted.{title,description,download,later}` 与
`localDbFatal.applyExhausted.{title,description,download}` 已同步 5 语言（en / zh-CN / zh-TW /
ja / ko），`check:i18n`、`check:i18n-glossary`、`check:brand-terminology` 均通过。

**码值单一事实源**：`update_apply_exhausted` 定义在 `src/shared/updateErrorCodes.ts`，
main 与 renderer 都从这里 import（renderer 不能 import `src/main/**`）。改名/新增同类码值时
改这一处，否则会出现「主进程置了新码、渲染端还在比旧字面量」的静默失效。
`check:brand-terminology` **只拒上游旧拼写**（`XDMaker` / `XD Maker` / `xdt-maker`），
**拦不住**把当前品牌名写死；新增用户可见文案里的品牌名一律用 `{{appName}}`，并由
`i18nBrandPlaceholder.test.ts` 的运行时断言兜住（按 `BRAND_NAME` 渲染结果校验）。

**威胁模型一句话**：`updates/apply-state.json` 与 `patch-info.json` 同处用户可写目录，因此
「本地写入 `attempts >= 3`」可以**阻止自动更新**（拒绝服务面），但它**不是内容信任锚**——
装什么仍由 manifest 摘要与更新器校验决定。不要把该文件当成授权或完整性证据。

**预算口径（显式登记的取舍）**：计数发生在「已把包交给更新器」这一步（`spawn` 之前，
沿用 #3697 的注释：只有最后一次 Runtime 检查通过后才计数，否则保留暂存包会重开 relaunch
循环）。因此 **UAC 被取消 / spawn 失败 / 主程序 60 秒未退出** 也会各消耗 1 次——它们都没
发生过替换，但都算一次交付。这是为了让「永久失败必须封顶」成立而接受的口径；代价是环境性
故障也可能把某版本推到终态，出路是修好环境后**等下一个版本号**（新版本自然拿到新预算）或
手动安装。若将来要区分，需要更新器在 `Phase::Replacing` 写「替换已尝试」收据，属独立交付。

**发布纪律（硬要求）**：终态记录**只按版本号**归属，因此**同一版本号重新出包（repack）会被
永久拒绝自动更新**，应用内没有任何复位入口。**任何 repack 必须递增版本号**，否则那一版会把
已经耗尽预算的用户挡在门外。（**降级**不受影响：记录只在该版本成为*已安装*版本时清除，
`reconcileApplyStateWithInstalledVersion()` 在冷启动即判定，回退到该版本不会留下终态。）

**不变量**：一个持续失败的版本最多消耗 3 次整包下载 + 3 次交付，之后必须停下并把用户导向
手动安装；不允许无限重下。**边界（如实登记）**：进程内镜像只覆盖单会话；如果该状态文件在
**跨进程**意义上长期既不可写、也无法保留旧值（例如每次冷启动都被清掉），那么持久计数仍会
从头开始，封顶只剩「单会话内」成立。已发布版本升级路径见
`docs/migrations/xdmaker-meka-to-cindy.md` 的更新器条目。

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
