# Meka 助理会话：身份绑定与工作区隐式解析

> **状态**：已实现（2026-11-20），**门禁与实机均未验证**：`pnpm test:unit:related` 与
> `pnpm --filter desktop typecheck` 本轮未跑，实机验收未执行。不要把本文读成「已验证」。
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

`workspace_kind` 从此**只是展示归类**，不再承担执行身份。新会话不再写 `workspace_kind='meka'`：
落在 Meka 项目目录里的写 `'project'`，落不到项目目录的（历史兜底目录）写 `'dialogue'`，
绑定列照写。旧行保持原样，读取侧双读，**不做存量回填**（2026-11-20 裁决：存量不管）。

实现落点：`apps/desktop/src/shared/mekaAssistantSession.ts` 的 `isMekaAssistantSession` /
`hasMekaAssistantBinding` 是跨层唯一判定；写入侧在 `apps/desktop/src/main/localDb/mapper.ts`
的 `sessionCreateToRow` **成对校验**（只有 project 或只有 role 直接抛错，不落半绑定行），
且绑定不再被 `workspaceKind` 吞掉。禁止新增 `workspaceKind === 'meka'` 的身份判断
（`workspaceKind` 分支只允许出现在「旧数据兼容 / 展示」处，且需注释理由）。

## 2. 工作区路径隐式绑定（2026-11-20 裁决）

- **Meka 项目的路径**就是 `meka_projects` 注册项解析后的工作目录（内置项目由 token 解析，
  不把 P4 等业务细节写进本规则）。
- **精确匹配**：创建 / 移动时分别规范化 `projectDir` 与 `workingDir`，任一与某个**可用**
  Meka 项目路径规范化后**相等**即命中（子目录、前缀、符号链接 realpath 都不推断）。
  **`projectDir`（显式项目归属）优先于 `workingDir`**：两者同时命中不同项目时由
  `projectDir` 决定身份。命中后隐式绑定该项目的**默认角色**
  （`mekaDefaultRoleId(projectId)`），并把 `projectDir` 写成该项目路径、`workspace_kind`
  写成 `'project'`。
- **不参与解析**：`additionalPaths`；`meka-assistants/<日期>/<id>` 兜底目录（只认显式绑定）；
  远程 / 跨设备会话（`remoteHostId` / `agentDeviceId`，身份归属于执行的那台电脑）；
  配置不可用（`configUnavailable`）的 Meka 项目。
- **生效时机**：
  - **创建缝**（`apps/desktop/src/main/localDb/sessionOpening.ts` 的 `openSession` 与
    `apps/desktop/src/main/localDb/sessionStorageAdapter.ts` 的 `OwnerSessionStorage.create`）：
    覆盖桌面新任务、个人 IM / 官方 hook 的渠道建行、插件任务、伙伴 canonical、
    `send_to_session` 等写 `sessions` 行的入口（各入口都复用这两条缝，不各写一套）；
  - **未绑定会话被移动 / 切换到该目录**：`sessions:update`（`/project`、`TaskMoveSubmenu`
    等）与渠道换目录（`switchSessionWorkingDir`）。
- **已绑定会话不可改目录 / 身份**：`sessions:update` 与 `switchSessionWorkingDir` 对已有绑定
  （含旧 `kind='meka'` 与旧 `mekaRole` 行）直接拒绝，避免「目录与绑定不一致」的半身份行。
- **显式优先**：桌面 Meka 入口的显式 `(projectId, roleId)` 不被路径解析覆盖；正式流程
  （`is_formal`）仍只能从桌面显式创建，路径解析只产生普通 Meka 会话。
- **Meka 目录是保留目录**：不提供「在该目录新建普通任务」的逃生口——目录能识别为 Meka
  项目就绑定。解析端口未安装或解析异常时按「不绑定」兜底（普通任务不能因 Meka 项目
  注册表暂时不可用而建不出来）；**显式** Meka 创建解析项目目录失败仍返回明确错误
  （`PRECONDITION_FAILED`）。这两条是**有意行为**，不是静默降级 Meka 身份。
- **已知边界**：路径只做规范化后的精确比较，不解析符号链接真实路径（realpath）；同一台机器
  上两个注册项目指向同一目录时按项目注册表顺序取第一个（目录相同的重复注册本身是配置
  问题）。这些组合**未验证**，登记在 §5。**未接入解析的写行路径**：伙伴群 lane 的
  `ensureBotGroupLaneSession` 仍经 `bots.createGroupLane` 直接 INSERT；`apps/host`
  （cindy-host）不安装解析端口，Meka 目录里的任务在 host 上仍是普通任务；Goal 恢复 /
  Pi runtime 预启动仍直接 `maker.createSession`（非本次引入）。
- 解析器：`apps/desktop/src/main/meka-projects/workspaceBinding.ts` 的
  `resolveMekaWorkspaceBinding`，经 `apps/desktop/src/main/localDb/workspaceBindingResolver.ts`
  的端口（`setWorkspaceBindingResolver` / `resolveSessionWorkspaceBinding`）安装进创建缝，
  安装点是 `apps/desktop/src/main/localDb/ipc/registerAll.ts` 的 `registerLocalDbIpc`；
  `localDb` / `apps/host` 不直接依赖 Meka 设置。

## 3. 创建与启动收口

- **创建**：所有写 `sessions` 行的通道都必须过工作区绑定解析（见 §2 的两条创建缝）。
  显式 Meka 创建（左侧 Meka 助理 → Meka 项目）仍以显式角色为准，路径解析不得覆盖它。
- **启动**：会话冷启动时（`maker.createSession` 之前）必须按持久绑定应用
  `applyMekaRuntimeConfig`。**生产调用点有四个、入口只有一个**：桌面
  `apps/desktop/src/main/maker-ipc/register.ts` 的 `bootstrapSessionOnce`（新会话行尚未落库
  时先用创建侧解析端口按 `workingDir` 补绑定）；IM
  `apps/desktop/src/main/im/shared/turnRunner.ts` 的 `wireSessionInternal` 与
  `refreshSessionAfterPendingAgentSwitch`；个人 IM 卡片
  `apps/desktop/src/main/im/shared/cardActionHandler.ts` 的 `control:new`；官方 hook
  `apps/desktop/src/main/hook-control/session-runner.ts` 的
  `createMakerHookSessionRunner`。IM / 官方 hook 的 `deps.readPersistedSession` 统一用
  `apps/desktop/src/main/meka-injection/persistedBinding.ts` 的
  `readPersistedMekaSessionBinding`；桌面 `bootstrapSessionOnce` 仍内联同一段只读查询
  （本轮未改，行为等价）。不得另写第二套注入实现。**未接入的存量路径**：Goal 恢复与
  Pi runtime 预启动（非本次引入）。
- **新建任务首轮**：IM 渠道先落行再 `wireSessionInternal`，首轮读持久绑定即可。官方 hook
  的新建任务行要等 `maker.createSession → OwnerSessionStorage.create` 才落库，读不到持久
  绑定，因此在同一处改用**创建侧同一解析端口** `resolveSessionWorkspaceBinding`
  （规则 §2）按本次工作目录解析项目默认角色，再调用同一个 `applyMekaRuntimeConfig`——
  首轮与后续冷启动复用同一注入入口，不另写实现。显式 Meka 创建仍只从桌面入口进入。
  **未实机验证**（见 §5）。
- **运行时语义**：外部（IM / 伙伴）创建的 Meka 会话能力层与桌面一致（只多「它变成 Meka
  会话」这一件事），其余保持上游设计（群 / 话题 / 权限 / 命令面不变）。
- **身份不可变**：绑定只能在创建时写入（或未绑定会话首次移入 Meka 项目目录时补齐），此后
  不可改；`/new` 轮换在同一个 INSERT 里继承上一行的成对绑定（不在 Meka 保留目录里造普通
  任务）；`fork` 只继承成对绑定（`kind` 按源行复制、只作
  展示）；`.cshare` 按绑定导出 / 导入（导入端在本机重新解析项目 / 角色）；任务迁移遇到
  Meka 助理会话显式拒绝（`MIGRATION_MEKA_UNSUPPORTED`），不允许丢绑定后照常迁移；lazy /
  resume 重建与协同（Orca）按绑定恢复。

## 4. 外部可见性

- 对 IM / 伙伴：新 Meka 会话是普通会话（普通 `workspace_kind`、普通列表 / 选择器 / 协议），
  不新增跨端字段、不要求上游认识 Meka。个人 IM 的 `/session` 与 `/ctr` **可以**列出并接管。
- 项目清单：IM / 伙伴的项目目录投影把 Meka 项目路径作为普通项目目录提供（`hello.workspaces`
  名称不变），实现是 `apps/desktop/src/main/meka-projects/workspaceCatalog.ts` 的
  `listMekaProjectWorkspaceEntries` 合进 `apps/desktop/src/main/hook-control/projectCatalog.ts`
  与 `apps/desktop/src/main/maker-ipc/botLinkedProjects.ts` 的既有清单。桌面侧栏的 Meka 段
  继续由绑定派生，不等同于普通项目树。
- **官方飞书没有会话选择器**：`apps/desktop/src/main/hook-control/manager.ts` 的
  `feishuProviderFeatures` 不声明 `session-picker-v1`（协议 / 鉴权原因），要正式支持需跨端
  协议改动，本轮不做。官方 hook 的 `recentSessions` 投影对**旧**
  `workspaceKind === 'meka'` 行保留原跳过（旧行为不变），新会话是普通 kind 因而自然进入。
- 旧 `workspaceKind === 'meka'` 会话在清理前继续按旧规则参与外部过滤；新会话不依赖这些过滤。
- **安全边界（2026-11-20 登记，未单独安全评审）**：项目投影让个人 IM、官方 hook（飞书多组织
  共用服务端）与伙伴都能看到 Meka 项目目录与显示名，并能在这些目录新建带 Meka 运行时的
  任务。是否允许官方 hook / 群聊可见、外部创建是否授予完整角色能力，按「对外普通会话」
  裁决执行；若要收紧，应在 `listMekaProjectWorkspaceEntries` 的调用点按渠道过滤或在能力
  声明上限制。

## 5. 兼容与验证

- 旧行：`workspace_kind='meka'` + 绑定 / 旧角色标记都继续被识别；不写迁移、不回填。
  `seedBuiltinMekaProjects` 的 `backfillSessions` 只补内置项目的 `meka_project_id`
  （历史行为，role 仍由运行期派生默认角色），不是本次新增的回填。
- 新行：普通 kind + 成对绑定；`sessionCreateToRow` 拒绝半绑定；显式 Meka 创建归一成
  `project` / `dialogue` + `projectDir`，不再写第三态。
- **已写但本轮未跑的用例**：`apps/desktop/src/shared/__tests__/mekaAssistantSession.test.ts`、
  `apps/desktop/src/main/meka-projects/__tests__/workspaceBinding.test.ts`、
  `apps/desktop/src/main/localDb/__tests__/createUserSessionMekaBinding.test.ts`，以及
  `sessionOpening.test.ts` / `mekaRuntimeInjection.test.ts` / `mapperMekaFormal.test.ts` 与
  IM / hook / fork / `.cshare` / 迁移 / 项目投影相关既有用例的本轮增改（逐文件见交付报告）。
  覆盖意图：路径解析（大小写 / 斜杠 / 精确匹配 / `projectDir` 优先）、显式优先、创建时绑定、
  启动注入触发、旧行兼容、半绑定拒绝。
- **未验证（如实登记）**：
  - **门禁未跑**：`pnpm test:unit:related` 与 desktop typecheck 本轮都没执行（按仓库门禁时机，
    留到交付时一次性跑），因此上述用例**是否通过未知**。
  - **实机未跑**：普通入口选 Meka 项目目录 → Meka 段 + 默认角色 chip；个人 IM `/project`
    可见项目目录、`/session` 可列出并接管且注入保真；重启后 IM / hook 冷启动注入；官方 hook
    新建任务首轮注入（已实现，未实机）；旧 `kind='meka'` 行显示与运行不变；fork / `.cshare` /
    协同不丢绑定。
  - **残留 kind 判据**：`hook-control/recentSessions.ts`（旧行跳过）、
    `scheduler-host/storage.ts`（旧数据别名扫描）仍按 `workspaceKind === 'meka'` 判断，
    不会命中新绑定会话。前者是**有意的旧行兼容**；后者只服务历史调度数据，新会话是否会被
    误认领**未验证**。
  - **已知未覆盖**：符号链接 realpath、跨电脑同名路径、P4 根变化后的旧会话（按「存量不管」
    接受）。
