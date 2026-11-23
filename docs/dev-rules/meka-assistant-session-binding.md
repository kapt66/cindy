# Meka 助理会话：身份绑定与工作区隐式解析

> **状态**：已实现——身份 = 持久化绑定（2026-11-20 裁决）；**创建 / 启动统一身份收口与
> row-first（2026-11-23）**。**本轮门禁由 lead 最终一次性执行，尚未跑**：
> `pnpm test:unit:related`、desktop typecheck、白名单实机清单都没有本轮结果。不要把本文
> 读成「已验证」；凡「本轮新增」的行为一律按「待 lead 最终门禁」读。
> **读取时机**：修改 Meka 会话身份判定、会话创建 / 移动 / 启动注入、IM / 伙伴的会话与项目
> 投影，或修改「Meka 助理项目目录里的任务」行为之前。

## 1. 结论（本规则的唯一真源）

**一个会话是不是 Meka 助理会话，只由持久化绑定决定：**

```
isMekaAssistantSession(session) =
  (session.mekaProjectId && session.mekaRoleId)   // 新真源：成对绑定
  || session.workspaceKind === 'meka'             // 旧数据兼容
  || session.mekaRole                             // 更旧的角色标记（只读兼容）
```

`workspace_kind` 只是**展示归类**，不再承担执行身份。新会话不再写 `workspace_kind='meka'`：
落在 Meka 项目目录里的写 `'project'`，落不到项目目录的（历史兜底目录）写 `'dialogue'`，
绑定列照写。

**旧行怎么处理（2026-11-23 复核口径）**：

- **不批量回填、不写数据迁移、不扫全库**：没有任何一次启动会遍历 `sessions` 表把历史行
  改写成 Meka 会话。
- **首次启动按行升级**：历史普通行、旧版本建出的行、或任何漏接创建缝的入口，在**任何
  入口启动这一行**时，只要它是**本地工作区**、**未绑定**且工作区精确命中已注册 Meka 项目，
  就按路径补一次成对绑定并写回同一行（见 §3.2）。这是启动面兼容网，不是存量回填。
- **半绑定行（只有 project 或只有 role）不自动修**：启动期升级只从「两个都空」的状态补，
  半绑定交给写入侧拒绝 / 迁移显式修（§5）。

实现落点：

- 身份判定跨层唯一 helper：`apps/desktop/src/shared/mekaAssistantSession.ts` 的
  `isMekaAssistantSession` / `hasMekaAssistantBinding`。
- 创建侧唯一身份入口（2026-11-23）：`apps/desktop/src/main/localDb/sessionIdentity.ts` 的
  `resolveSessionIdentityForCreate`；启动前建行：`localDb/sessionProvisioning.ts` 的
  `insertProvisionedSessionRow`；启动期读行 + 按本地工作区升级：
  `apps/desktop/src/main/meka-injection/persistedBinding.ts` 的
  `ensurePersistedMekaSessionBinding`（数据源，不是第二个注入入口）。
- 写入侧在 `apps/desktop/src/main/localDb/mapper.ts` 的 `sessionCreateToRow` **成对校验**
  （只有 project 或只有 role 直接抛错，不落半绑定行），且绑定不再被 `workspaceKind` 吞掉。
  禁止新增 `workspaceKind === 'meka'` 的身份判断（该分支只允许出现在「旧数据兼容 / 展示」
  处，且需注释理由）。

## 2. 工作区路径隐式绑定

- **Meka 项目的路径**就是 `meka_projects` 注册项解析后的工作目录（内置项目由 token 解析，
  不把 P4 等业务细节写进本规则）。
- **精确匹配**：创建 / 移动时分别规范化 `projectDir` 与 `workingDir`，任一与某个**可用**
  Meka 项目路径规范化后**相等**即命中（子目录、前缀、符号链接 realpath 都不推断）。
  **`projectDir`（显式项目归属）优先于 `workingDir`**：两者同时命中不同项目时由
  `projectDir` 决定身份。命中后隐式绑定该项目的**默认角色**
  （`mekaDefaultRoleId(projectId)`），并把 `projectDir` 写成该项目路径、`workspace_kind`
  写成 `'project'`。
- **不参与解析**：`additionalPaths`；`meka-assistants/<日期>/<id>` 兜底目录（只认显式绑定）；
  `remoteHostId`（远端工作区路径属于另一台电脑，不能用本机项目表匹配）；
  配置不可用（`configUnavailable`）的 Meka 项目。
- **`agentDeviceId` 参与解析（2026-11-23 口径收紧）**：这类任务只在**另一台电脑上跑 Agent
  进程**，任务文件与工作区仍在本机，因此身份仍按本机工作区解析。2026-11-20 曾把
  `agentDeviceId` 与 `remoteHostId` 一起排除，那会让「Agent 在另一台电脑、目录就是本机
  Meka 项目」的任务落成普通行；本轮修正为只有 `remoteHostId` 跳过。实现方式是
  `resolveSessionIdentityForCreate` 在调用工作区解析端口时**显式传 `agentDeviceId: null`**；
  端口实现里仍保留「带 `agentDeviceId` 就跳过」的守卫，因此**新增代码一律走
  `resolveSessionIdentityForCreate`**，不要直接调用端口（直接调用会退回旧口径）。
- **生效时机**：
  - **创建 / 写入（创建侧唯一入口）**：所有写 `sessions` 行的通道在 INSERT 前调用
    `resolveSessionIdentityForCreate`——桌面 `localDb/sessionOpening.ts` 的 `openSession`
    与 `localDb/sessionStorageAdapter.ts` 的 `OwnerSessionStorage.create`；IM
    `im/shared/sessionRepo.ts` 的手工 INSERT、`/new` 轮换、`switchSessionWorkingDir`；
    `localDb/ipc/sessions.ts` 的 `sessions:update`；伙伴群 lane
    `localDb/ipc/bots.ts` 的 `ensureBotGroupLaneSession`；Cindy Make
    `cindy-make/taskRuntime.ts` / `cindy-make/upstreamMergeSession.ts`；会话导入
    `session-import/executor.ts` 与 `localDb/worker/opHandlers/sessionImportTx.ts`（解析在
    main、落库在 tx）；fork `maker-orchestration/fork.ts`（源行无绑定时按子行目录解析）。
  - **启动（兼容网）**：`ensurePersistedMekaSessionBinding` 在**任何入口启动会话**时读
    持久行；行未绑定且工作区是**本地** Meka 项目目录时，按路径补成对绑定并写回同一行
    （见 §3.2 的边界）。已绑定行零写入。
  - **未绑定会话被移动 / 切换到该目录**：`sessions:update`（`/project`、`TaskMoveSubmenu`
    等）与渠道换目录（`switchSessionWorkingDir`）、导入页「选择文件夹」
    （`relocateImportedSession`）。
- **已绑定会话不可改目录 / 身份**：`sessions:update`、`switchSessionWorkingDir` 与
  `relocateImportedSession` 对已有绑定（含旧 `kind='meka'`、旧 `mekaRole` 行与半绑定行）
  直接拒绝，避免「目录与绑定不一致」的半身份行。
- **显式优先**：桌面 Meka 入口的显式 `(projectId, roleId)` 不被路径解析覆盖；正式流程
  （`is_formal`）仍只能从桌面显式创建，路径解析只产生普通 Meka 会话。
- **Meka 目录是保留目录**：不提供「在该目录新建普通任务」的逃生口——目录能识别为 Meka
  项目就绑定。解析端口未安装或解析异常时按「不绑定」兜底（普通任务不能因 Meka 项目
  注册表暂时不可用而建不出来）；**显式** Meka 创建解析项目目录失败仍返回明确错误
  （`PRECONDITION_FAILED`）。这两条是**有意行为**，不是静默降级 Meka 身份。
- **已知边界**：
  - 路径只做规范化后的精确比较，不解析符号链接真实路径（realpath）；同一台机器上两个注册
    项目指向同一目录时按项目注册表顺序取第一个（目录相同的重复注册本身是配置问题）。
  - **`apps/host`（cindy-host）不安装解析端口**：Meka 目录里的任务在 host 上仍是普通任务，
    也没有本轮的任何启动期升级 / 注入（端口未安装 ⇒ 不解析）。
  - **Orca 跨设备（另一台电脑执行 Worker）没有身份传递**：`OrcaRemoteWorkerOpenRequest` /
    `Result` 契约（`packages/device-link/src/orcaRemoteWorker.ts`）没有 Meka 字段，运行设备
    只能按**它自己的**工作目录 / 项目注册表判断；发起端的本机代理行（`proxySession`）也不带
    Meka 身份。是否要在跨端协议加身份、以及跨设备 Worker 应该用 Lead 的角色还是运行设备的
    默认角色，属**跨端协议 / 产品裁决，需用户明确决定**，本轮不做。
  - **Pi runtime 预启动**经 renderer `maker:create-session` → main
    `registerMakerSessionCreateHandler` → `bootstrapSessionOnce` 收口（不是裸
    `maker.createSession`），因此与普通启动同口径；**未实机验证**。
- 解析器：`apps/desktop/src/main/meka-projects/workspaceBinding.ts` 的
  `resolveMekaWorkspaceBinding`，经 `apps/desktop/src/main/localDb/workspaceBindingResolver.ts`
  的端口（`setWorkspaceBindingResolver` / `resolveSessionWorkspaceBinding`）安装进
  `resolveSessionIdentityForCreate`，安装点是
  `apps/desktop/src/main/localDb/ipc/registerAll.ts` 的 `registerLocalDbIpc`；
  `localDb` / `apps/host` 不直接依赖 Meka 设置。

## 3. 创建与启动收口

### 3.1 创建：唯一身份入口，身份随行原子落库

- **唯一入口**：`apps/desktop/src/main/localDb/sessionIdentity.ts` 的
  `resolveSessionIdentityForCreate({ workspaceKind, workingDir, projectDir, remoteHostId,
  agentDeviceId, mekaProjectId?, mekaRoleId? })`。输入 / 输出见该文件的 `SessionCreateIdentity`。
  - **显式成对绑定优先**：调用方同时给出 project + role 时原样采用；只有一边则**直接抛错**
    （`Meka session binding requires both a project and a role`），不落半身份行。
  - 否则：`remoteHostId` 非空 → 不解析、不绑定；本地工作区 → 精确命中 Meka 项目时绑定
    项目默认角色并写 `projectDir`；未命中 → 保持普通会话。
  - `workspaceKind === 'meka'` 是旧行 / 旧调用兼容值：命中路径时归一成普通 `'project'` +
    成对绑定；未命中时保留旧值交给 legacy 兼容层。
- **身份必须随同一次 INSERT 落库**（不是启动后补写）：
  `localDb/mapper.ts` 的 `sessionCreateToRow` 成对校验后把
  `mekaProjectId` / `mekaRoleId` / `projectDir` 写进行；`workspaceKind` 与 kind 解耦。
  使用它的创建缝：
  - 桌面新任务 / 插件任务 / device-link 创建：`localDb/sessionOpening.ts` 的 `openSession`
    （`createUserSession` 显式 Meka 创建也走这里）与 `OwnerSessionStorage.create`
    （scheduler / Feishu / Orca 等经 maker storage 建行的路径）。
  - IM / 官方 hook：`im/shared/sessionRepo.ts` 的 `createSession`（确定性 id upsert）与
    `/new` 轮换、`switchSessionWorkingDir`；官方 hook 新建任务的行仍由
    `maker.createSession → OwnerSessionStorage.create` 落库（注入身份先解析，storage 再按
    `projectDir` 兜底——两条路径同一套规则）。
  - 伙伴：`localDb/ipc/bots.ts` 的 `ensureBotGroupLaneSession`（群 lane 可直接工作在群项目
    目录）经 `bots.createGroupLane` tx 落库，tx 参数带成对 id（`client/tx/types.ts` 的
    `BotsReplaceCanonicalSessionArgs`）。
  - Cindy Make：`cindy-make/taskRuntime.ts`、`cindy-make/upstreamMergeSession.ts`。
  - 会话导入：`session-import/executor.ts` 在 main 解析，`sessionImportTx.ts` 只落库；
    `relocateImportedSession` 未绑定行移入 Meka 目录时同一次事务补绑定。
  - fork：`maker-orchestration/fork.ts` 源行已成对绑定则继承；源行未绑定但子行目录命中本机
    Meka 项目时按路径补齐（子行创建瞬间就是 Meka 会话）。
- **新的写行入口必须接入**：复用 `resolveSessionIdentityForCreate` + 上面任一创建缝，
  不得自己读 Meka 项目表或另写一套路径判断；无法接入（如 worker 内联 tx 不能依赖项目
  注册表）时在 main 侧解析好再传参。

### 3.2 启动：row-first（先落行、再注入、最后起 Agent）

`apps/desktop/src/main/maker-ipc/register.ts` 的 `bootstrapSessionOnce` 是本轮启动收口的
正本（`bootstrapSession` 只是 in-flight 去重包装）。它按顺序做四件事：

1. **已有行：读持久身份 + 启动期升级**——`ensurePersistedMekaSessionBinding(o.id)`：
   - 行已带成对绑定：以**行**为准；调用方 opts 若带了不一致的显式绑定，直接报错
     `Meka session binding differs from the persisted identity`（不让调用方另造身份）。
   - 行未绑定且是本地 Meka 项目目录：按路径写回成对绑定 + `projectDir` +
     `workspaceKind='project'`（只从「两个都空」补；半绑定、远端的行**不修**；已绑定行零写入；
     写回用 `IS NULL` 条件，避免并发覆盖另一路刚写入的身份）。
2. **新行：创建侧同一身份入口解析**——opts 没有绑定且没有持久行时，用
   `resolveSessionIdentityForCreate` 按显式 / 本地工作区解析（`remoteHostId` 跳过、
   `agentDeviceId` 参与）。
3. **Agent 启动前先建行**——解析出成对绑定时，若该 id 还没有行，调用
   `localDb/sessionProvisioning.ts` 的 `insertProvisionedSessionRow` 在 Agent 启动前 INSERT
   一条带身份的行（`onConflictDoNothing` 幂等，不覆盖已有行）。这一步覆盖远端 Worker /
   worktree / device-link / scheduler 等「工作区路径不是本机 Meka 项目根」的入口：
   `maker.createSession` 内部的 `SessionMeta` 不携带显式绑定，路径推断兜不住它们。
4. **最后注入，然后起 Agent**——`applyMekaRuntimeConfig(o, { readPersistedSession:
   ensurePersistedMekaSessionBinding })` 读取刚写好的持久行注入；随后 `maker.createSession`
   命中已有行（`storage.get` 有行时跳过 `storage.create`，只回写 `sdkSessionId`）。

**启动失败清理**：本次 bootstrap 先建的行若在 Agent 启动前失败，删除这条空行——条件是
`sdkSessionId IS NULL`（绝不删已挂上 Agent 的行），删除失败只 `log.warn`，不掩盖原始错误。

**启动期升级的边界（重要）**：

- 只处理**本地工作区**：`remoteHostId` 行跳过（远端路径属于另一台电脑，不能用本机项目表）；
- 只处理**未绑定**行：半绑定行（只有 project 或只有 role）不自动修，已绑定行零写入；
- 只在**这一行被某个入口启动**时发生：不扫表、不批量迁移、不因目录相同去追溯别的行；
- 解析端口未安装（`apps/host`、测试）或解析异常时按「不绑定」处理，不阻塞普通会话启动。

### 3.3 运行期注入：入口不变，数据源统一

- **唯一注入入口仍是** `apps/desktop/src/main/meka-injection/index.ts` 的
  `applyMekaRuntimeConfig`；本轮没有第二个入口，也不得为任何启动路径另写注入实现。
- **数据源统一**为 `meka-injection/persistedBinding.ts` 的 `ensurePersistedMekaSessionBinding`
  （读行 + §3.2 的启动期升级）。各启动路径：
  - 桌面：`maker-ipc/register.ts` 的 `bootstrapSessionOnce`（含 `maker:create-session`，
    即手机 / device-link / Pi runtime 预启动）。
  - IM：`im/shared/turnRunner.ts` 的 `wireSessionInternal`（冷启动）与
    `refreshSessionAfterPendingAgentSwitch`（延迟 agent switch 冷重建）；个人 IM 卡片
    `im/shared/cardActionHandler.ts` 的 `control:new`。
  - 官方 hook：`hook-control/session-runner.ts` 的 `createMakerHookSessionRunner`
    （新建任务轮 + 冷启动）。
  - 休眠 Goal 恢复：`goal-host/sessionRestore.ts` 的 `restoreSessionForGoal` 在
    `maker.createSession` 之前先 ensure 再调用同一入口（dormant Goal 不经过桌面
    `bootstrapSessionOnce`）。
  - scheduler「Pi runtime 资源漂移后重建」：`scheduler-host/runner.ts` 已回到
    `bootstrapSession` funnel（不再裸 `maker.createSession`），与首次启动同口径。
- 不得新增第二套注入实现；新增绕过桌面 bootstrap 的启动路径必须接同一入口，并在
  [`meka-injection-layer.md`](meka-injection-layer.md) §2 补登调用点。

### 3.4 Orca Worker：绑定来自 Lead，行由 bootstrap 先建

- Worker 的成对绑定来自 Lead：创建服务把 `lead.mekaProjectId` / `lead.mekaRoleId` 显式
  放进 `createOpts`（Lead 缺完整成对绑定直接拒绝创建 Worker），新 Worker 的
  `workspaceKind` 归一为普通 `'project'`（旧 Lead 的 `'meka'` 只作历史展示，不再复制给
  新行）。
- **本轮删除了「启动后补写」**：`bootstrapSession` 之后不再调用
  `persistMekaWorkerBinding`；Worker 行由 §3.2 的 row-first 在 Agent 启动前 provision，
  因此「行里没有 Meka 身份」不会在启动后才被发现。旧实现事后读行补绑定的路径见
  [`../migrations/xdmaker-meka-to-cindy.md`](../migrations/xdmaker-meka-to-cindy.md) §11.40。
- **跨设备 Worker（另一台电脑执行）仍未解决**：见 §2 的已知边界（协议无 Meka 字段）。

### 3.5 身份不可变与继承

- **身份不可变**：绑定只能在创建时写入（或未绑定会话首次移入 Meka 项目目录时补齐 /
  §3.2 首次启动升级），此后不可改：`sessions:update`、`switchSessionWorkingDir`、
  `relocateImportedSession` 对已绑定（含旧行 / 半绑定）直接拒绝。
- **`/new` 轮换**在同一个 INSERT 里继承上一行成对绑定；上一行未绑定但 lane 目录已是 Meka
  项目时，新行按创建侧同一入口重新解析升级（不在 Meka 保留目录里造普通任务）。
- **fork**：源行有成对绑定则继承（`kind` 按源行复制只作展示）；源行未绑定但目录命中本机
  Meka 项目时按路径补齐（见 §3.1）。
- **`.cshare`** 按绑定导出 / 导入；导入端在本机重新解析项目 / 角色。
- **任务迁移**遇到 Meka 助理会话显式拒绝（`MIGRATION_MEKA_UNSUPPORTED`），不允许丢绑定
  后照常迁移。
- **lazy / resume 重建与协同（Orca）**按绑定恢复；运行期只认持久行（§3.2 / §3.3）。
- **运行时语义不变**：外部（IM / 伙伴）创建的 Meka 会话能力层与桌面一致（只多「它变成
  Meka 会话」这一件事），其余保持上游设计（群 / 话题 / 权限 / 命令面不变）。

## 4. 外部可见性

- 对 IM / 伙伴：新 Meka 会话是普通会话（普通 `workspace_kind`、普通列表 / 选择器 / 协议），
  不新增跨端字段、不要求上游认识 Meka。个人 IM 的 `/session` 与 `/ctr` **可以**列出并接管。
- **接管 / 冷启动保真（2026-11-23 追认）**：因为启动期会按持久行做一次身份 ensure 再注入，
  一条历史普通行只要工作区是本机 Meka 项目，被 IM / hook / Goal 恢复接管时就会升级成 Meka
  会话并按绑定注入；**不再有**「库里有目录、运行期按普通会话跑」的静默分叉。半绑定行不会
  被这条兜底自动修（会按未绑定/半绑定处理，见 §5）。
- 项目清单：IM / 伙伴的项目目录投影把 Meka 项目路径作为普通项目目录提供（`hello.workspaces`
  名称不变），实现是 `apps/desktop/src/main/meka-projects/workspaceCatalog.ts` 的
  `listMekaProjectWorkspaceEntries` 合进 `apps/desktop/src/main/hook-control/projectCatalog.ts`
  与 `apps/desktop/src/main/maker-ipc/botLinkedProjects.ts` 的既有清单。桌面侧栏的 Meka 段
  继续由绑定派生，不等同于普通项目树。
- **官方飞书没有会话选择器**：`apps/desktop/src/main/hook-control/manager.ts` 的
  `feishuProviderFeatures` 不声明 `session-picker-v1`（协议 / 鉴权原因），要正式支持需跨端
  协议改动，本轮不做。官方 hook 的 `recentSessions` 投影对**旧**
  `workspaceKind === 'meka'` 行保留原跳过（旧行为不变），新会话是普通 kind 因而自然进入。
- **`apps/host` 与远端执行设备**：host 不安装解析端口、也没有 Meka 注入，普通任务行为不变；
  Orca 跨设备 Worker 的身份由运行设备自己决定（现在没有传递通道，需用户裁决）。
- **安全边界（2026-11-20 登记，未单独安全评审）**：项目投影让个人 IM、官方 hook（飞书多组织
  共用服务端）与伙伴都能看到 Meka 项目目录与显示名，并能在这些目录新建带 Meka 运行时的
  任务。是否允许官方 hook / 群聊可见、外部创建是否授予完整角色能力，按「对外普通会话」
  裁决执行；若要收紧，应在 `listMekaProjectWorkspaceEntries` 的调用点按渠道过滤或在能力
  声明上限制。

## 5. 兼容与验证

- **旧行**：`workspace_kind='meka'` + 绑定 / 旧角色标记都继续被识别；不写 migration、不批量
  回填；**首次被任何入口启动时按行升级**（§3.2，仅本地工作区、仅未绑定行）。
  `seedBuiltinMekaProjects` 的 `backfillSessions` 只补内置项目的 `meka_project_id`（历史行为，
  role 仍由运行期派生默认角色），不是本轮新增的回填。
- **新行**：普通 kind + 成对绑定；`sessionCreateToRow` 拒绝半绑定；显式 Meka 创建归一成
  `project` / `dialogue` + `projectDir`，不再写第三态；身份随同一次 INSERT 落库。
- **兼容迁移语义**：普通存量行**不批量迁移、不按目录追溯**；只有该行真的被启动时才升级，
  且升级后 `workspace_kind` 归成 `'project'`、`projectDir` 写成项目根（与新建行一致）。
  未启动的存量行保持原样，符合「不批量改用户数据」的基线。
- **本轮新增 / 修改的自动化覆盖**（门禁由 lead 最终跑，**本轮尚未运行**）：
  - `apps/desktop/src/main/localDb/__tests__/sessionIdentity.test.ts`（新文件：显式成对优先、
    半绑定拒绝、`agentDeviceId` 参与、`remoteHostId` 跳过、legacy kind 归一）；
  - `sessionOpening.test.ts`（创建缝隐式绑定）、`botCanonicalSession.test.ts` /
    `botGroupLaneTx.test.ts`（伙伴 lane）、`taskRuntime.test.ts` /
    `upstreamMergeSession.test.ts`（Cindy Make）、`sessionRestore.test.ts`（Goal 恢复先 ensure
    再注入）、`session-runner.test.ts` / `turnRunner*`（IM / hook 冷启动数据源改为
    `ensurePersistedMekaSessionBinding`）、`orcaWorkerCreationService.test.ts`（删除事后补绑定，
    改为断言绑定在 createOpts / 行由 bootstrap 负责）。
  - 既有绑定 / 注入 / 归属类用例（`mekaRuntimeInjection*.test.ts`、
    `createUserSessionMekaBinding.test.ts`、`workspaceBinding.test.ts`、`fork.test.ts`、
    `mapperMekaFormal.test.ts`、`mekaAssistantSession.test.ts` 等）不在本轮全部重跑；
    以 lead 的最终门禁为准。
- **未验证（如实登记）**：
  - **门禁未跑**：`pnpm test:unit:related`、desktop typecheck、`check:test-hygiene` 等由 lead
    在交付时统一执行；本文写作时**没有任何本轮结果**，上述用例是否通过未知。
  - **实机未跑**：普通入口选 Meka 项目目录 → Meka 段 + 默认角色 chip；历史普通行在 Meka
    目录被首次启动后升级；个人 IM `/project` 可见项目目录、`/session` 可列出并接管且注入
    保真；重启后 IM / hook / Goal 冷启动注入；官方 hook 新建任务首轮注入；旧 `kind='meka'`
    行显示与运行不变；fork / `.cshare` / 协同不丢绑定 —— **全部没有实机证据**。
  - **半绑定行不自动修**：启动期升级只补「两个都空」的行。历史半绑定行不会被改成任一身份；
    其中「普通 kind + 只有 project 或只有 role」的行在读取侧**不满足成对判定**
    （`hasMekaAssistantBinding` 为 false），运行期按非 Meka 处理（注入零写入）；只有同时带旧
    `workspace_kind='meka'` 或旧 `mekaRole` 的老半绑定行才会被 `isMekaAssistantSession` 当作
    Meka。是否需要一次性修复历史半绑定行需另行裁决（写入侧已拒绝产生新的半绑定行）。
  - **启动期升级只处理本地工作区**：带 `remoteHostId` 的会话不参与（远端路径属于另一台
    电脑）；`agentDeviceId` 任务的工作区仍在本机，因此仍参与路径解析（见 §2）。远端路径的
    升级需要那台电脑自己的启动流程完成。
  - **Orca 跨设备**：`OrcaRemoteWorkerOpenRequest` / `Result` 没有 Meka 字段，运行设备端的
    Worker 身份由那台的注册表决定（可能是默认角色，也可能不是 Lead 的角色）；发起端代理行
    也没有身份。**尚未传递身份，属跨端协议改动，需用户裁决**。
  - **`apps/host`**：不装解析端口、无注入 ⇒ host 上既不做隐式绑定也不做启动期升级。
  - **Pi runtime 预启动 / Goal 恢复 / scheduler 重建**：代码上已接同一入口
    （`bootstrapSessionOnce` / `restoreSessionForGoal` / scheduler 回到 bootstrap funnel），
    但**未实机验证**；若后续新增绕过 bootstrap 的启动路径，必须按 §3.3 接入。
  - **残留 kind 判据**：`hook-control/recentSessions.ts`（旧行跳过）、
    `scheduler-host/storage.ts`（旧数据别名扫描）仍按 `workspaceKind === 'meka'` 判断，
    不会命中新绑定会话。前者是**有意的旧行兼容**；后者只服务历史调度数据，新会话是否会被
    误认领**未验证**。
  - **已知未覆盖**：符号链接 realpath、跨电脑同名路径、P4 根变化后的旧会话；这些组合没有
    自动化与实机证据（按「不批量回填 + 启动时按当前路径解析」接受）。
