# Desktop 按需性能跟踪（本地录制，无上报）

> **读取时机**：新增或修改性能跟踪的录制、报告投影、本地保存、保留期、菜单入口、命令面，
> 或需要判断「性能报告会不会外发 / 能不能加一个上传入口」时。

**结论先行（WL-26）**：Cindy Meka 的性能跟踪是**纯本地能力** —— 录制 → 本地保存 → 打开本地目录 →
7 天保留期；**没有上传面**（无上传命令、无上传按钮、无上传依赖与 Worker、无还原工具、无上传文案）。
它**不**复用日志上报通道，也不扩充日志来源白名单。规则正本是
[`meka-whitelist-verification.md`](meka-whitelist-verification.md) 的 **WL-26**；要变成「能外发」必须先改
WL-26 并走插件/隐私相关的批准流程，不能只改本文件或代码。

## 1. 能力面

- **入口**：应用内菜单「性能跟踪」（命令 `open-performance-trace`；macOS 同时在帮助菜单），
  **只在主窗口**显示，副窗口不显示也不可发起录制。
- **采集对象**：当前这台 Desktop 电脑。Chromium 时间线 + Node inspector + 当前 renderer 的 CDP Profiler
  + 每秒 Electron 进程 CPU/内存与主进程事件循环延迟；不采截图、堆快照或网络正文，
  不保存窗口/任务标题与命令行，不读取按键值、输入内容、DOM 文本或输入目标。
- **边界**：不远程启动另一台电脑的采集；不声称覆盖 Mobile、SSH、Agent 子进程或原生输入法内部。
- **时长与体量**：单次最长 **60 秒**（`TRACE_MAX_DURATION_MS`），Chromium 缓冲 **32 MiB**
  （`TRACE_BUFFER_KB = 32 * 1024`），缓冲使用率到 95% 提前停止。
- **结果页**：只保留摘要、`partial` 提示与「查看本地文件」（`performanceTrace.keepLocal`）+
  「重新录制」（`performanceTrace.new`）；**没有**说明输入框与提交按钮（反回归断言见 §6）。
- **交互约束**：计时与停止按钮在主内容区顶部独占一行，不覆盖输入区；采集控制器保持在窗口级，
  状态栏通过 portal 放入布局占位，避免内容区重排影响录制生命周期。

- **其它采集面（2026-11-17 上游同步采纳，均为本地证据）**：
  - Renderer 被动记录 long task、输入总延迟／排队延迟／处理时间、组合输入起止和窗口可见性；
    不读取按键值、输入内容、DOM 文本或目标。后台窗口样本仍保留可见性，供分析时剔除绘制节流。
  - 既有 invoke registry 只对固定任务列表、消息视图和 Skill 查询计时，不读取参数、返回内容或异常正文；
    本地调用与执行端收到的远程调用都计时，但没有跨电脑时钟关联或远程耗时承诺。
  - 截图入口另记录原生抓取、窗口识别及 Electron 回退耗时；回退原因只允许固定标签（平台、helper 缺失、
    色彩限制、原生帧不可用／尺寸不符／空图），不读取显示器标识、色彩描述、窗口标题或像素。
    原生帧不可用包含启动失败、超时和抓取失败，不能仅凭该标签区分这三种原因。
  - 相同录制的事件用 epoch ms，CPU profile 保留采样间隔及相对录制起点的偏移。性能开销是相关证据，
    不自动判定根因；压缩 bundle 的位置需结合对应发行构建映射分析，本功能不新增公开 source map 分发。

## 2. 状态机与命令面

- 相位（`shared/performanceTrace.ts` 的 `PerformanceTracePhase`）：
  `idle → starting → recording → saving → ready`（保存失败/不完整时 `ready` + `partial: true`，内存副本保留供重试）。
- 命令面（`PerformanceTraceCommand`）：**`state` | `start` | `stop` | `show-local`**，
  IPC 通道 `performance-trace:command`（另有两个事件通道 `performance-trace:events` /
  `performance-trace:state`）。
- 其它命令（含历史 `upload`）一律 **`INVALID_PARAMS`**（`main/performance-trace/ipc.ts` 的固定命令集白名单）。
- `start` 只允许**主窗口**发起；非发起窗口只能 `state` / `show-local`（`PRECONDITION_FAILED`）。
  已开始的采集绑定发起窗口，副窗口与其它账号不能接管；普通刷新沿用原绑定。
- 状态通知跟随**当前受信主窗口**（`createTraceStatePublisher`）；新主窗口在旧采集停止/保存期间打开也会收到完成状态。
- 账号失效立即取消该次采集；启动/停止期间跨账号的原始文件与摘要丢弃，不向任何账号保留混合记录。

## 3. 存储与本地报告

- **账号代次与保存顺序（2026-11-17 上游同步采纳）**：摘要保存成功或失败后再次核对账号；账号已变化时
  丢弃内存报告并回到空闲，不能把它当成可重试报告。已开始的写入固定在原账号目录，**不转存给新账号**；
  采集停止后保存期间的账号变化不会把新账号内容加入原始文件。Chromium 先停止到临时文件，核对账号仍有效
  后才保存；超时后迟到的启动也只停止并删除临时结果。
- **主窗口重建**：主窗口销毁后重新创建时，同一账号的已完成报告可在新主窗口继续查看（Meka 无「提交」
  动作，只保留查看与「查看本地文件」）；读取状态时恢复绑定。活动采集仍绑定原窗口，副窗口和其它账号
  不能接管报告；普通刷新保留原 WebContents 时沿用原绑定。

- **目录**：`ownerScopedUserDataPath('diagnostics', 'performance-traces')/<报告编号>/`
  （按账号代次隔离，录制开始时固定路径并捕获 owner；之后切账号不会把内容写给新账号）。
- **录制期原始证据**（三份原生文件）：`chromium-trace.json`、`main.cpuprofile`、`renderer.cpuprofile`。
  CPU profile 采样间隔 4ms；renderer debugger 不可用时保留其它证据并标记 `partial`。
- **停止后摘要**：`report.json` —— 先写 `report.json.tmp`（`0o600`）再 `rename` 原子落盘；
  目录创建即 `0o700`。
- **报告编号**：`reportId.ts` 的 `generateTraceReportId()`，形状 **`XXXX-XXXX`**、字符集
  `23456789ABCDEFGHJKMNPQRSTVWXYZ`（去掉 0/1/I/L/O/U 等易混字符）；**不再复用 log-upload 的
  `uploadCode`**。`retention.ts` 用 `TRACE_REPORT_ID_PATTERN` 判断「哪些子目录是本功能生成的」⇒
  **改形状必须同时迁移旧目录清理判据**，否则升级前录制的旧报告永远不会被清理。
  **区域前缀不接（第八轮同步 2026-11-17）**：上游给**上报**编号加了 `CN-` / `GLOBAL-` / `DEV-` 前缀
  （`formatUploadCode` / `isFormattedUploadCode`），并让清理同时识别前缀目录。Meka 没有上报面、
  本地报告编号保持**无前缀**，因此 `performance-trace/{index,retention}.ts` **不接**这套前缀语义
  （含 `performanceTrace.test.ts` 里 `it.each(['','CN-','GLOBAL-','DEV-'])` 那条上游用例——
  它的前提是本地 ID 也会带前缀，不成立）。判据：`TRACE_REPORT_ID_PATTERN` 只认无前缀形状。
- **摘要投影上限**：事件最多 **3000** 条（`TRACE_MAX_EVENTS`）；CPU 每进程最多 **20000** 节点
  （`report.ts` 的 `profile.nodes.slice(0, 20_000)`）与受限样本数；未知 event 类型/标签及多余字段拒绝或剔除。
  因上限丢弃的证据必须注明；完整采样在另外三份文件里，不受摘要投影上限裁剪。
- **打开目录**：`show-local` 在空闲态打开 owner 根目录（`shell.openPath`）；`ready` 态下打开的是
  本次报告的 `report.json` 所在位置（`shell.showItemInFolder`）。

## 4. 脱敏与安全边界

- 摘要投影复用**采集侧**的脱敏器：`performance-trace/report.ts` 从 `../log-upload/redact` 取 `redact`
  并按字段值脱敏（如 CPU 帧函数名）。**只复用采集面**——`log-upload` 的上报面
  （`uploadRunner` / `logSink` / `uploadCode` / 上传批次常量）已随 WL-26 删除，不得因这行 import 而恢复。
- **不是任意内容匿名化保证**：路径与用户生成的性能标记仍可能出现在报告里 ⇒ 报告**只在本机保留**，
  界面明确按「保留本地」表述。任何外发都必须先过 WL-26 裁决与隐私评审（脱敏/同意/区域）。
- 主进程拒绝非主窗口、非受信 renderer 的录制与事件；`performance-trace:events` 只接受发起窗口且单批 ≤100 条。
- 退出应用会等待启动中的采集完成并停止、保存（`onQuit('performance-trace', …)`）。

## 5. 保留期与清理

- 保留期 **7 天**（`retention.ts` 的 `TRACE_RETENTION_MS`）。服务启动时与运行期**每小时**尽力清理，
  不依赖用户再次录制；应用未运行时不清理，下次启动或进入该账号后补清。
- 只删**本功能生成**的目录：名字命中 `TRACE_REPORT_ID_PATTERN`、确实是目录、**不是符号链接**、mtime 超期，
  且账号代次仍匹配；忙碌/缺失的目录不阻断其它过期报告的清理。
- 正在录制/保存的报告不清理；清理当前已完成报告时同步清除内存副本；用户另存的副本不删除。
- 重启后可通过「查看本地文件」找到此前记录；界面内重试只针对本次运行的当前报告。

## 6. 验证

| 命令 | 覆盖 |
| --- | --- |
| `pnpm --filter desktop exec vitest run src/main/performance-trace/__tests__` | 生命周期、账号切换/代次隔离、保存失败重试、保留期清理、命令面拒绝 `upload`（`performanceTrace.test.ts`）+ 原生文件与 `partial`（`capture.test.ts`） |
| `pnpm --filter desktop exec vitest run src/renderer/components/title-bar/__tests__/MenuButton.test.tsx` | 结果页**没有**输入框/提交按钮，只有「查看本地文件」；`command` 不再收到 `upload` |
| `pnpm ui:check --page performance-trace --case all --theme all --locale all` | 真实界面与十二语/双主题（**未跑**） |
| 隔离 Electron 实例 | 两份 CPU profile + Chromium trace + 资源样本的真实采集（UI 场景不能代替），**未跑** |

**反回归 grep**（代码 0 命中；命中即说明上传面被同步带回）：

```sh
git grep -n -E "uploadPerformanceTraceReport|generateUploadCode|submitPerformanceReport|traceRedactionWorker|restore-performance-report|performance-trace/(upload|artifacts|restore)" -- apps/desktop/src apps/desktop/scripts apps/desktop/forge.config.ts
```

**未验证（如实登记）**：真实版本化打包（`forge.config.ts` 的 `traceRedactionWorker` worker 入口已删，
需确认打包仍成功）、实机双主题/十二语目检、WL-26 的实机判据（无 `config/log-upload.json` 的机器能打包完成、
「设置 → 关于」无上报两行、报告问题仍能采集脱敏）。

## 7. 维护契约

- **不得恢复上传面**（含「临时调试上传」）：需要外发时先改 WL-26 并完成隐私评审，再改本文件。
- 改命令面/状态机必须同步 `shared/performanceTrace.ts`（preload 与 renderer 一起），并复核主窗口/受信 renderer 的授权。
- 改报告编号形状必须同时迁移 `TRACE_REPORT_ID_PATTERN`、保留期清理测试与旧目录判据。
- 改采集类别或上限要说明对磁盘与性能的影响，并在摘要里注明因上限丢弃的证据。

## 8. 与上游的关系（刻意偏离，登记在 WL-26）

上游（2026-10-29 起）有「提交完整性能文件」能力：一次性脱敏 Worker、`TraceArtifacts`、
`cindy-performance-files` v1 分片协议、按 `uploadCode` 检索、以及 `scripts/restore-performance-report.ts`
还原工具。Meka 按 WL-26 **整块移除**，只保留本地录制/保存/查看与保留期：

- 已删：`performance-trace/{upload,artifacts,restore,traceRedactionWorker}.ts`、
  `scripts/restore-performance-report.ts`；`reportId.ts` 取代 `generateUploadCode`；
  `shared/performanceTrace.ts` 去掉 `uploading` / `uploaded` / `upload` 命令；
  结果页去掉说明输入与提交按钮。
- 同步上游时若这些文件/命令/文案被带回，**按回归处理**，不要按上游文档补回。
