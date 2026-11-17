# 配置分层与 override 契约

> **状态**：权威开发规则（authoritative）
> **读取时机**：新增或修改 Settings UI、配置文件、本地偏好存储、运行时 profile，或
> agent／MCP／provider 相关开关之前

本规则适用于所有用户可配置项。Cindy 允许用户高度定制，但**默认配置承载创作者品味，
是产品体验的一部分**——不是让每个选项都堆进设置页。产品边界见
[`../product-rules/core-product-principles.md`](../product-rules/core-product-principles.md)；
进入 Settings UI 的配置还必须遵守
[`../design-rules/cindy-design-system.md`](../design-rules/cindy-design-system.md)（主题
token）与 [`engineering-conventions.md`](engineering-conventions.md)（i18n）。

> **增量适用原则**：约束新增和正在修改的配置项，不要求为统一形式专项重构存量配置。

## 1. 可见性分层

新增／修改任何可配置项前，先判断它属于常规设置、高级设置、隐藏配置还是内部常量；不要
因为技术上能配置就放进 Settings 外层。

- 只有大多数用户经常需要理解并调整、且无需理解内部实现的选项，才默认可见。
- 低频、专业或误改成本高的选项进入高级设置。
- 有定制价值但不值得占用 UI 注意力的选项进入配置文件、本地配置存储，或由 agent 通过
  自然语言修改。
- 涉及产品语义、安全边界、数据契约或核心体验的不变量保留为内部常量。
- 设置页只直接展示推荐用户了解的项（2026-10-02 裁决）：每个设置项分四档——直接展示 →
  所在分类页底部默认折叠的「高级」→ 不做 GUI、跟 Cindy 说 → 内部常量。「高级」是每个分类
  页里的折叠区，不做把整类设置堆进去的独立页面；分类沿用现有结构与名字，只合并明显重复的，
  不为精简大幅压缩分类数；「只能跟 Cindy 说」的项保持少量；新增设置项不默认加可见开关。

## 2. 默认值与用户 override 分离

截图翻译目标默认跟随当前界面语言，目标语言列表独立于界面支持的语言。
用户在截图或长截图编辑器的 Cindy 菜单中改选语言后，按本机客户端保存显式覆盖；
选择「跟随界面语言」删除覆盖。菜单展示本次目标，截图交接携带该目标快照，避免
进入任务时被后续偏好变化改写。实现见 Desktop 的 `shared/screenshotTranslation.ts`
与 `main/region-screenshot/translationPreferences.ts`。

- 每个配置项都必须能判断是否被用户显式自定义。
- 运行时以「系统默认值 + 用户 override」合并出有效值；持久化只记录 override 与必要的
  自定义标记，**不把完整默认配置复制进用户配置**。
- 未自定义的用户随版本获得新默认值，已自定义的用户保留自己的选择。

### 完整主题与外观设置

Desktop 的 `main/appearance/service.ts` 是唯一外观覆盖所有者；
`appearance-settings.json` 只保存明确覆盖。仅选中新主题包时，有效值依次为内置默认、
主题包的内存默认层、用户或已批准固定能力的明确覆盖。主题包不把默认值复制成覆盖，
也不直接写 DOM；`renderer/appearance/AppearancePresenter.ts` 和原壁纸消费者统一投影。
插件不提供／注册主题；固定字体、壁纸、阅读样式等操作保留原调用、声明、批准和资源校验，
其最终写入复用相同的定义转换与原子设置存储。

主题模式／家族继续由 renderer localStorage 的 `theme` / `theme.familyId`、原
`setTheme` / `setFamily` 和跨窗口 storage 同步持有，不迁入宿主。内置主题、旧 loose
JSON 和无包用户保留原启动、切换、重置、落盘及回滚行为；旧 loose 的未知 `appearance`
字段仍忽略。升级不操作时保留原主题与字体、壁纸。

Host 启动时没有主题包投影；renderer 按当前选择先同步应用配色和用户原字体、壁纸，再
通过现有 `selectTheme` 异步准备包资源。投影只在内存，旧文件里的 `themeSelection` 忽略。
主动选中新主题包时，先通过同一入口准备，成功后才提交原选择与配色；失败只提示，
不写 localStorage，不切换配色。沿用在途请求身份丢弃迟到结果；Agent 回执确认实际结果。
从主题包切回内置或 loose 才撤掉包默认层；从未选包的用户不发准备或清理 IPC。
只有主题包生效时，单项恢复删除相应覆盖并跟随包默认；没有主题包时仍按原静态默认写入。

全量恢复仅清外观覆盖，不重置主题模式或家族。字号恢复不清字体家族，壁纸恢复不清字体。
密度／动效默认 1，不添加可见设置项；动效服从系统减少动效。主题格式与素材限制见内置
`cindy-theme-creator` 的 package-format.md；回归入口为 `useTheme.test.tsx`、
`appearanceSettingsStore.test.ts` 和 `packages.test.ts`。

已知限制：没有选用主题包时，用户或插件显式设置为与 Cindy 默认值相同的外观项
（例如 `uiSize=14`、`wallpaperMotion=static`）不会记为覆盖；之后选择主题包时，
这些项目会采用主题包的默认值。此行为保留现有覆盖设置与“恢复默认”的语义。
主题包目前没有原生卸载入口，可以通过“打开目录”手动移除。

模型资料的系统层再区分公共默认、供应商默认、供应商实报与服务端明确修正；用户覆盖始终最高。
发现快照和用户字段分开持久化，详见 [模型资料优先级](../product-rules/model-metadata-precedence.md)。

### 自动任务的单次模型选择

绑定已有对话的自动任务，其模型、来源、推理档位与 Fast 仅用于该次运行。
选择器始终展示用户的选择；运行结束不切换运行模型、不重建或整理上下文。
仅在下一次实际发送时落实最终选择的模型；新的自动任务指定模型时直接应用该模型，
不先恢复用户模型再切过去。权限与计划模式保持原有语义。
跨引擎继续使用已有历史交接机制，不回滚原生会话检查点。
保存的用户选择需能跨进程恢复；恢复失败保留它，下次发送前重试，不能悄悄沿用自动任务模型。
用户在运行期间主动改选的模型优先；修改推理档位与 Fast 更新用户配置，不改正在运行的自动任务。

<a id="模型可见性2026-09-13-用户更正"></a>

### 模型可见性

显示开关的有效值是 **用户显式 override ?? 当前目录 defaultEnabled**。此条只约束模型显示开关。

- 目录下发哪些默认开、哪些默认关，没拨过开关的路线一律跟随。目录后来新增的默认开模型
  要显示出来；客户端不得把「没有开关记录」做成全关。
- 用户手动开过或关过的写成 override，升级不清、不覆盖。
- 「恢复默认」只删除本次点名路线的 override，重新跟随当前目录。
- 收藏、历史选择、引擎偏好不能当成开关。
- 桌面、IM 与远端用同一套 override；没 override 的路线由各端按当时目录 defaultEnabled 计算。

实现核对须区分上游原始目录与执行端活动目录：当前仍有客户端精简陈列投影，见
[已知实现差异](model-catalog-maintenance.md#visibility)。该说明不是对本节合同的豁免；
不得仅因代码仍在筛选就反向修改产品规则，也不能未验证便声称两者已一致。

**Meka 谱系条款（2026-09-10 上游同步定稿；2026-09-18 同步按用户裁决 A 修订）**：初始化资格由
Main 按**该 owner 的库文件 / 迁移标记是否存在**判定（库已在 ⇒ `existing`），只有判成 `new`
的配置才会拿到初始化清单。
Meka 谱系在本轮同步之前完全没有这套机制（`eligibleForDefaults` / `INITIALIZATION_KEY_PREFIX`
/ `profileOrigin` 在合并前的 `meka/main` 中出现 0 次），所以**没有任何既有 Meka 配置可能持有
清单**，整个存量用户群都会落到「无清单」分支（**当时**上游读取侧把「无清单」当作关闭；
2026-09-18 同步后该分支改为跟随目录，见下与 WL-10）。注意这与库名前缀无关：
`ownerDatabasePath` 两端使用同一个 `dbFilePrefix`，上游同形态的老配置同样被判成 `existing`。
合并前 Meka 的
可见性口径是「显式 override 优先，否则跟随目录 `defaultEnabled`」，老用户不需要任何初始化
记录就能看到模型 —— 这正是 2026-09-18 同步后重新生效的最终口径。

- 因此 `state/modelVisibilityPrefs.ts` 对「**这份配置从来没写过初始化记录**」的老配置
  （判据 `stored === null`）**补种一次快照**：按首次观察到的
  目录冻结 `defaultEnabled !== false` 的基线，并落下一次性标记。**2026-09-18 同步后该快照
  只作基线留痕**（记录这份老配置升级时看到过什么，并作为「已初始化过」的判定输入），
  **不决定可见性** —— 见下条与 WL-10。
  > **命中条件已收窄（2026-09-24 第三轮同步）**：原表述把「资格位不为真且 `defaults` 为空
  > （**含被该机制跑过一遍写下的空清单**）」也算命中。现在「**已经存在记录**」一律为权威、
  > 不被补种改写（含外部修好的 `{eligibleForDefaults:false, defaults:{}}`）。理由：本轮语义下
  > 可见性不再读 `initialization.defaults`（恒为 `override ?? defaultEnabled`），空清单不再把任何
  > 路线判成关闭，因此该支补种没有承重作用；而把既有记录的外部判定提升为 `true` 正是上游新增的
  > 「同一生命周期内重新加载可恢复目录」用例所禁止的。**「无记录」这一支（真正的合并前老 Meka 配置）
  > 补种逐字不变**，上一轮 P0（老用户模型选择器整张清空）不回归。见
  > `docs/migrations/2026-09-24-origin-main-to-meka-main.md` §6.16 第 3 条。
- 补种不得跨越：显式 override 永远最高优先；「恢复默认」的具名路线(`followCatalogKeys`)
  继续动态跟随目录；`pending`(Main 尚未定性)不得猜测，定性缺失时失败关闭。
  > **已修订（2026-09-18 同步，用户裁决 A = 接纳上游语义）**：原表述「补种后新增模型不随
  > 目录默认开启」**不再成立**。现行有效语义是 [`模型可见性`](#模型可见性2026-09-13-用户更正)
  > 那条的通用口径 —— 可见性恒为 `override ?? 当前目录 defaultEnabled`，初始化清单
  > `defaults` **不参与可见性判定**，所以目录后来新增的默认开模型会直接显示。**兼容边界**：
  > 该语义逐字等于 Meka 上一轮同步**之前**的原生口径
  > （`override ?? isModelVisible(undefined, model.defaultEnabled)`），所以不变量「存量
  > Meka 用户升级后仍能看到合并前的可见集合」仍由目录原生满足，上一轮那起「选择器整张
  > 清空」的 P0 不会复现；被取代的只是**上一轮为补上该语义打的冻结补丁**，不是 Meka 的
  > 产品分歧。显式 override 的跨升级保留、`followCatalogKeys` 的跟随语义、`pending` 的
  > 失败关闭三者都不变。
- 该机制只存在于客户端 renderer；Server 目录不下发也不覆盖它。调整目录 `defaultEnabled` 时
  按 `docs/dev-rules/model-catalog-maintenance.md` 先确认实际下发目录与数据归属 —— 已补种的
  老配置与其它未自定义路线一样**跟随**目录改动（不存在「老配置被冻结在升级那一刻」这回事）；
  只有**显式 override** 不跟随。
- override 表或初始化清单一旦变化必须**重新镜像给 main**：`mirrorToMain` 推的是
  `effectiveMap(map) => ({ ...map })`（**override 表**；`defaults` **不进**载荷）加上
  **不含 `fallback: false`** 的策略。main 侧 `getModelVisibilityOverride` 在非 strict 下对
  未知 key 返回 `undefined`，由共享 `isModelVisible` 回落目录 `defaultEnabled`
  ⇒ IM `/model` 与应用内列表同口径，且不会因「没有镜像记录」整张清空。只有本地 override 表
  无法解析时才推 `fallback: false`（失败关闭）。`load()` 在 cache 置非空后不再触发镜像，
  所以补种/首次初始化之后必须显式重推一次；若改成把 `defaults` 塞进载荷或请求
  `fallback: false`，就会退回上一轮同步报告 §4.6 那起 P0 的「无记录 ⇒ 整张清空」形态。

### 辅助模型的直接调用

辅助模型的自定义 HTTP 连接按实际文本调用能力准入，不继承聊天引擎因兼容模式产生的
默认关闭状态。候选默认可见；连接模型配置中显式保存的 `defaultEnabled` 和用户显示
override 仍然优先。供应商／模型停用、退役、付费准入和凭证检查继续生效。
内置及原生订阅适配器保持原有默认规则。

选择记录继续使用 `cat:<连接>:<配置来源>:<模型>`；新增 `pi` 来源只标识连接与凭证，
不启动 Pi，也不要求其实现 `Agent.oneShot`。已有 Codex / Claude Code 记录及轻量档位
原样读取，不迁移或重排。候选和执行共用逐模型 HTTP 协议解析，未支持的 SDK 协议不列出。
插件自行钉选继续沿用既有候选规则（含主干已支持的 Pi 路由）；上述直接调用的默认准入
只用于辅助模型。插件跟随辅助模型链时使用用户已经保存的选择。
语音润色继续遵循现有的 OpenAI / Cindy AI 白名单，不因辅助模型候选扩大而新增通道。

实现与回归：`apps/desktop/src/main/utility-model/directTextRoute.ts`、
`__tests__/auxiliaryDirectRoutes.test.ts`、`__tests__/oneShotCandidates.test.ts`。

### Codex 服务器压缩

设置 → 个性化 → 上下文压缩提供一个开关，按本机 data owner 保存到
`codex-compaction-settings.json`。默认 `serverEnabled: null` 保留原生选择与失败后的
摘要回退；显式 `false` 对现有 OpenAI/Cindy Codex 远程压缩身份选择 `cindy_summary`，
显式 `true` 允许已保存的摘要任务恢复服务器压缩。恢复默认删除 override。
设置在本机 Codex 启动/恢复时读取，不打断正在运行的轮，不切模型、不改写历史。
第三方供应商、SSH 和受托访客任务保持原策略。设备互联执行由执行端读取自己的设置；
此本机设置不新增远程全局写权限。兼容旧宿主/缺省依赖时保留原行为。
回归：`compaction-settings-store.test.ts`、Codex `index.test.ts` 的 native compaction
identity / canonical account history 场景，以及
`provider-compatibility.integration.test.ts` 的原生开关往返与历史保留验证。

## 3. 默认值演进与迁移

### 模型上下文与压缩（2026-10-27）

上下文圆环集中展示状态；任务窗口档位及模型设置入口只放在「调整窗口」展开区。
任务档位会随任务保存，不称作一次性「临时设置」。模型窗口仍同时约束任务上限，本次不放宽。
自动压缩设置归入供应商的模型详情高级区域，不再在个性化按 Harness 陈列。
压缩比例按供应商连接与模型保存，桥接前缀按供应商路由声明归一，同一模型的所有 Harness 共用。
默认统一为 90%；仅保存显式覆盖，恢复默认删除覆盖。用户于本次方案复核后明确选择统一策略，
旧 Claude Code/Pi 全局比例退出运行时生效链路，原文件保留但不迁移成模型覆盖。
不再显示「沿用原有策略」或按 Harness 分列的比例。已有窗口上限和任务预算语义不变。
统一自定义范围为 50–90%，由各引擎适配；Codex 使用原生 token 阈值和逐模型目录，
Pi 使用逐模型 reserveTokens，Claude Code 同步原生环境与 host 判断。
运行中的生成不被中断，复用已有模型设置刷新/回合边界处理；界面不得将新偏好冒充在途实际值。

- 默认值变化时，分别说明新用户、未自定义老用户、已自定义老用户的行为。
- 迁移必须基于「是否自定义」的状态判断，**不得通过旧值猜测用户意图**；只有历史数据缺少
  自定义状态时才允许一次性兼容迁移，并在代码或 PR 中说明判断依据与风险。

### 事件音效与系统通知

每个事件直接根据现有音效设置决定声音归属，不另设音效来源。事件音效开启且该事件选了
内置或自定义声音时，只播放所选声音；该事件选择「跟随系统」（存储仍为 `builtin/none`），
或关闭事件音效时，保留系统通知并遵循系统通知设置。不新增开关或持久化字段。

主进程在系统通知创建出口按事件决定 `silent`，覆盖普通任务、其他电脑的任务、定时任务与直接提醒。
没有会话的提醒（如未创建会话就失败的定时任务）没有事件音效可替代，群聊消息也不触发任务音效，
二者沿用系统通知声音。任务胶囊与系统实时活动共用规则；未启用任一界面时沿用系统通知。开始和点击等没有系统通知的事件，在「跟随系统」时不会额外造通知。
实时活动原生 alert 保持无声；已有完成事件去重、免打扰和历史恢复静音规则不变。
实现见 `hasAgentIslandNotificationSound`、`AgentIslandService.shouldSilenceTaskNotification` 与 `notificationService`。

## 4. 恢复默认

- Settings 中「恢复默认」的语义是**删除对应 override、重新跟随当前版本默认值**，而不是
  写入一份静态默认值快照。配置组与整体设置页应提供相应粒度的恢复入口。
- 用户通过 agent 要求恢复默认时同样删除 override。

## 5. 隐藏配置也是正式契约

- 隐藏配置必须有清晰 schema、字段说明、取值约束和安全边界，不能依赖零散分支或隐式
  约定。
- agent 修改配置时，只有用户明确要求才写入 override，不得把当前默认值固化回用户配置。

### 请求体积控制

`XDT_REQUEST_SIZE_CONTROL_DISABLE` 是 Desktop／Node Host 宿主进程的隐藏环境开关，不新增
设置页或持久化 override。默认开启请求体积控制；只有值为字符串 `1` 时才关闭，未设置或其他值
均保持开启。修改启动环境变量后须重启宿主，新的环境才会进入该进程。

关闭后 HTTP 回到原有入口超限／上游 413 附件恢复路径，不启用新的主动重放和预算学习；
Codex 的回退上限为 **42 MiB**，不会恢复到原来的 128 MiB，Claude Code／Pi 仍为 32 MiB。
**图片压缩不受此开关控制**，已注入的图片预处理继续运行。完整阈值、恢复与归属边界以
[模型请求超限时的附件恢复](media-storage-and-protocols.md#模型请求超限时的附件恢复)为正本；
实现入口为 `oversizedAttachmentRecoveryCore.ts` 的 `createRequestSizeController`。

### 代理图片压缩

`XDT_IMAGE_COMPRESSION_DISABLE` 是 Desktop 与 Node Host 的隐藏进程环境开关，不进入设置页或
持久化配置。未设置时默认开启；仅字符串 `1` 关闭，其他值不关闭。移除该环境变量恢复默认。

开关只控制本地代理的图片预处理（`prepare`）及单张图片超限后的进一步压缩（`tighten`）；
关闭时保留输入图片，不调用编码器，也不复用已缓存的压缩结果。它不控制附件的
`image-resizer` 缩图，与 `XDT_REQUEST_SIZE_CONTROL_DISABLE` 控制的请求体积恢复互不替代。
每次调用都读取宿主进程当前的环境值；从外部修改启动环境后，需要重新启动宿主才能带入新值。

实现与回归见 `apps/desktop/src/main/maker-host/inlineImagePreprocessor.ts` 及
`__tests__/inlineImagePreprocessor.test.ts`。

### 全局快捷键

`XDT_DISABLE_GLOBAL_SHORTCUTS` 是 Desktop 的隐藏进程环境开关，适用于开发版（含
`--isolated` 沙箱）与打包版，不进入设置页或持久化配置。只有值为字符串 `1` 时才跳过
语音输入与区域截图的全局快捷键注册，未设置或其他值均保持原有行为。修改启动环境后
需重启进程；移除开关后重启即恢复用户已保存的快捷键，不清空或写回设置。
经 `restart:desktop:remote` 新开 Terminal 启动时，启动器会将此变量转发给开发进程。

语音输入的 Electron 全局注册、macOS 修饰键／功能键原生监听、Windows 原生监听及其
功能键保留注册均会跳过；区域截图同样跳过全局注册。主动跳过视为成功，不报快捷键占用、
不重试恢复或提示重启。每个进程仅记录一行 info 日志，由语音输入初始化入口统一记录。
输入框麦克风按钮、长按输入框、renderer 内的按键处理与浮层 Escape 等临时快捷键不受影响。

实现入口：`apps/desktop/src/main/voice-input/global.ts` 的 `setVoiceInputGlobalShortcut`、
`recoverPendingNativeShortcutRegistration` 与 `registerGlobalVoiceInputIpc`，以及
`apps/desktop/src/main/region-screenshot/index.ts` 的 `syncShortcut`。
启动环境转发见 `scripts/restart-desktop-remote.mjs` 的 `devEnvEntries`。

## 6. 设置搜索与页面定义

设置页新增、改写设置控件时，使用 `defineSettings` 声明稳定 ID、分类、定位锚点、
标题／说明 key、选项以及可见条件；静态定义放在设置目录的 `*.settings-search.ts`，
以默认模块的 `entries: Object.values(命名定义集合)` 接入自动发现。
页面通过 `useSettingDefinition` 复用文案与选项，将 `anchorProps` 放在实际设置行上、
`controlProps` 交给对应控件。定义文件保持轻量，不加载 React 组件、IPC 或用户配置，
未打开的页面同样可搜索。现有快捷键直接由 `APP_SHORTCUT_DEFINITIONS` 生成索引。

复杂页面可直接引用命名定义的 `titleKey` / `descriptionKey` / `options`，保留已有的
翻译参数、动态选项和控件组合；定位用 `id={definition.targetId}`，控件用
`data-setting-id={definition.id}`。两种写法共用同一份静态定义，均由门禁检查。
动态设备、账号、模型列表复用原有运行时数据源，搜索登记其所属设置入口；不把用户数据
复制到静态索引。复用的选择器在调用处绑定对应定义，不用操作按钮豁免设置控件。

`pnpm check:settings-search` 对照 Git HEAD 检查工作区。CI 的 PR 与 merge_group 使用事件的
可信 base SHA，push 使用 `github.event.before`。只有**上游同步 merge** 才允许通过
`--merge-parent` 改用它自己的第二父提交（HEAD^2）作 base：HEAD 是 merge commit（本地尚未
提交时为 MERGE_HEAD），第二父已经是 `refs/remotes/origin/main` 的祖先，**且第一父不是**
该祖先。同步 merge 后若已有普通跟进提交，HEAD 不再有第二父；脚本沿 first-parent 找到最近的
merge commit 再套用同一双父判据，避免把跟进提交后的 push 退化成事件 base 而误报上游新增。
未提交的同步 merge 始终优先读 `MERGE_HEAD`；历史 merge 只是没有进行中 merge 时的回退。第二条判据不可省：落在 `main` 上的普通 feature merge 在 push 后，第二父（feature
tip）同样成为 `origin/main` 祖先，只有第一父（旧 main）也在上游时才必须保留事件 base，
否则会把这次 feature 新增的设置排除在检查之外。普通功能分支 merge 不满足该条件，仍用事件
base，不能借此跳过检查。`--merge-parent` 只由 CI 的 push 步骤传入，PR／merge_group 不传。
新控件及改写过的控件必须绑定已接入索引的定义；已迁移文件检查全部控件。
新增的设置标题、说明、选项标签翻译 key 也必须进入索引，避免复用旧控件时只改文案而漏登记。
未迁移文件仅保留与基准完全相同的旧控件，不维护可被手工上调的豁免基线。
取消、重试等普通操作可用 `data-settings-search-action` 说明具体理由，不得用它豁免设置项。
检查覆盖设置目录及通用页引用的伙伴设置；新增外置设置组件或特殊控件时需同步扩展检查范围。
静态检查不能判断文案语义或任意自定义控件，仍须 review 核对真实设置入口。
已登记的自定义选择器还需将调用方的 `data-setting-id` 传到实际 DOM；门禁同时读取组件
实现，检查参数转发，不能仅凭调用处绑定放行。新增自定义控件时同步登记此检查并验证真实渲染。

现有非空设置索引模块已统一为命名的 `defineSettings` 集合；快捷键继续附加原有快捷键
注册表生成的条目。常规行示例见 `AdditionalSettings.settings-search.ts`，复杂页面和选项
示例见 `AppearanceSection.settings-search.ts`、`LanguageSection.settings-search.ts`。
新增设置在所属集合声明后由页面复用，不另建手工索引副本。空的退役分类模块不制造设置。
搜索词回归通过真实翻译调用生产搜索函数，
定位回归验证异步挂载后的实际滚动；跨文件锚点合同进入 guard tier。

页面补验用 `pnpm ui:check --page settings-search --case all --theme all`：挂载真实
`SettingsView`，滚动长页面、展开折叠项，并通过侧栏搜索检查目标高亮与可见位置。
账号和宿主响应为隔离数据；远程连接另有登录态场景，灵动岛模拟平台能力。
这类检查不代表原生权限、持久化、真实连接或 macOS 原生行为已验收。

可见性必须与页面一致；新增平台能力条件时同步扩展 `SettingsSearchContext`。
已知常用别名作为定义的一部分维护，不把中文逐字 OR 匹配当作分词。

## Review 清单

1. 新配置的可见性层级选对了吗？是否因“技术上能配”就塞进了设置页外层？
2. 有效值是否由「默认 + override」合并？持久化是否只存 override 而非完整默认？
3. 默认值变化的迁移是否基于「是否自定义」，而非用旧值猜意图？
4. 「恢复默认」是否删 override 跟随版本，而不是写静态快照？
5. 隐藏配置是否有正式 schema 与安全边界？agent 是否只在用户明确要求时写 override？

实现／PR 说明至少写明：配置层级、默认值及推荐理由、override 如何记录与识别、未自定义
用户如何跟随新默认、恢复默认会清除什么。

## 作答文风与默认提示词

文风选择仅在显式选中「文言」界面时显示；普通语言忽略旧版保存的特殊文风。
默认普通作答及文言下的「照常作答」不附加任何语言／文风说明，也不注入取消文风的提示。
文言默认的「雅正文言」属于主动启用的文学模式，仍附加对应说明。

特殊文风只约束当前轮，普通发送与插话每次带上本轮说明，不走环境说明去重；
IM 不附加语言／文风说明。固定 system prompt 不因这个设置改变。
既有原生历史不可事后清除，旧版本留下的跨轮文风指令仍可能影响已有会话；不自动重置会话。
回归从 `uiLanguageErrorNote.test.ts`、`makerSendTransaction.test.ts` 与
`hook-control/__tests__/session-runner.test.ts` 进入，验证实际发送文本而非推断模型输出。
