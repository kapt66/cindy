# Meka 项目元数据与别名治理

> 本文件是**项目侧元数据（`metadata[]` 发现清单）与文件别名**的长期实践规范。
> 触发条件：新增/修改 Meka 项目的 `AGENTS.md` / `CLAUDE.md` / `SKILL.md` / `rule` / `mcp.json`，
> 在「发现元数据」面板里勾选或取消条目，或排查「清单里出现了重复/过期条目」时，必须先读本文。
>
> 机制与代码锚点的正本在 `docs/dev-rules/meka-whitelist-verification.md` **WL-24**；
> 清单如何进入模型上下文（order 65 段）见 `docs/dev-rules/meka-injection-layer.md`。
> 本文只管**治理决策**：该不该让一份文件存在、该不该让它进清单、理由记在哪。

## 1. 两个必须分开的问题

| 问题 | 载体 | 谁来回答 |
|---|---|---|
| **这份文件该不该存在？** | 文件系统（项目仓 / P4） | 项目自己（本文 §3） |
| **这份文件该不该进注入清单？** | manifest 的 `enabled` 字段 | 项目策展人（本文 §2、§4） |

**不要把前一个问题伪装成后一个。** 用 `enabled: false` 长期遮盖真正的重复，等于给自己留陷阱 ——
因为 `enabled` 只对 Cindy 生效：Codex / Claude / Pi **原生**读 `AGENTS.md` / `CLAUDE.md` /
`SKILL.md`，根本不看我们的 manifest，重复文件对它们照样是重复。

## 2. `enabled: false` 的正确定位

「全量展开」的准确含义是**「全部 `enabled !== false`」**，不是「全部发现到的」：
`runtimeConfig.ts:164-175` 在 `includeAllProjectMetadata: true` 时逐条 `if (item.enabled === false) continue`。
所以 `enabled` 是全量开关**唯一盖不住的例外**（缺省 `true`）。

它**只**应该用来表达一件事：

> **这份文件必须存在，但注入它没有增量信息。**

它有三个已知失效模式，禁止当作长期手段：

1. **健忘**：匹配键是 `${rootPath ?? ''}|${sourcePath}|${itemType}`（`runtimeConfig.ts` `metadataKey`）
   ⇒ 文件一旦改名或移动，标记**静默失效**，重复项自己回来。**同一把 key 也会让手写的
   `description` / `displayName` / `notes` 一起丢失。**
2. **只对 Cindy 有效**：见 §1。
3. **不是全局事实**：它要么在随包基线（每包一份）、要么在项目根 `.meka/project.json`（每机一份），
   两台机器可以对同一份重复给出不同答案。

**因此：`enabled: false` 是「我先把它按住」的过渡工具，不是终点。**

## 3. 四类判据：这份文件该不该存在

对每一处重复问一句：**这份文件除了「被扫描到」之外，有没有独立存在的理由？**

| 情形 | 处理 | 理由 |
|---|---|---|
| **是指针**（内容形如 `@AGENTS.md` 的一行 include） | **保留**，`enabled` 取 `false` 或 `true` 都成立 | 单一事实源，重复无害 |
| **是内容副本**（工具强制要求实体内容） | **收敛为单向 include**；做不到就加**机械一致性检查**（字节相等断言），不得靠人记 | 内容副本**必然**漂移（见 §6 的真实事故） |
| **没有独立理由**（旧版副本、废弃镜像） | **删文件** | 留着就是陷阱：有人按路径去编辑，会改到废弃的那份 |
| **是别名的触发入口**（例如 `$saga2` 转接 Skill） | **应当启用**，并在 `description` 里写明「别名入口，权威见 X」 | 禁用它等于**关掉一条入口**，这不属于去重 |

## 4. 硬规矩

1. **别名只写 include，永不写内容副本。**
   同一目录下 `CLAUDE.md` 与 `AGENTS.md` 的关系只有两种可接受形态：**两文件逐字节相同**，
   或 **`CLAUDE.md` 一侧的内容仅为 `@AGENTS.md` 一行**（`AGENTS.md` 自己写 `@AGENTS.md` 属无意义，
   不予接受）。两种都不是 ⇒ 视为漂移，必须处理。
   判定细节（由扫描器实现，见 §5）：容忍一个前导 UTF-8 BOM、CRLF 与 LF、行首行尾空白与空行
   —— 即 `"\n  @AGENTS.md  \r\n\n"` 算合规 include，而 `"@AGENTS.md\n补充说明。"` **不算**
   （多了一行实质内容，就是内容副本）。
2. **禁用必须留痕。** 每一条 `enabled: false` 都必须在 `notes` 里写清「为什么禁用 + 权威副本在哪」。
   `notes` **不进 prompt**（`runtimeConfig` 里没有任何读取方，只有面板 IPC 与重扫保留在读它），
   面板可见、重扫保留 ⇒ 它正是为此设计的。**禁用一个条目却不写理由，视为未完成。**
3. **权威条目的 `description` 里写明关系。** 例如「战斗设计正本；Unity 工程内同名副本已废弃」——
   让模型自己知道该信哪份，比让它同时看到两份再猜要好。
4. **同名不同路径是合法的，不要去"修"。** 同一份 skill 名出现在两个子项目，**可以**是两个不同用途
   的实体；运行时按 `rootPath|sourcePath|itemType` 区分，重名时 `normalizeDiscoveredSkillId`
   （`runtimeConfig.ts:204-226`）会依次给后面的加 `-2`、`-3` 后缀来消歧 —— 这是**设计行为**，
   不是缺陷。**不要**为此加「跨目录同名即警告」的检查，也不要把同名当成需要合并的信号。
5. **`description` 是注入文本**：长度 ≤ 300 码点（超出会在运行期被截断补 `…`，等于死文本），
   且不得含换行、`|`、反引号（会破坏 `作用范围 | 绝对路径 | 用途` 的行格式）。
6. **`basic.path` 必须保持项目 id token**（bundled saga2 = `saga2`），**不得**写成绝对路径 ——
   那会把出厂基线绑死到一台机器；真实根来自 Meka 设置的 `p4RootPath`。

## 5. 机械守卫（不靠人记）

| 守卫 | 位置 | 拦住什么 | 验证现状 |
|---|---|---|---|
| 别名漂移告警 | `apps/desktop/src/main/meka-projects/metadataScanner.ts`：判定 `:293` `isBareAgentsInclude` / `:309` `isAcceptableClaudeAlias`，检查与调用 `:329` / `:420`；测试 `__tests__/metadataScanner.test.ts:294-460`（9 例） | 「`CLAUDE.md` 是内容副本且已落后」——§6 的真实事故 | 单测 22/22 通过；并对**真实 SAGA2 工作区只读实跑**过谓词：`saga2_design`（2397 B vs 5259 B）**告警**、`世界观-worldbuilding`（37755 B vs 37755 B）与 `saga2_unity`（15 B include）**不告警**。**未在打包产物 / 正式版实机验证过** |
| 随包基线不变量 | `apps/desktop/src/main/meka-projects/__tests__/saga2BundledBaseline.test.ts`（8 例） | 基线 JSON 非法（**必须用 `JSON.parse`，不得用 PowerShell 的 `ConvertFrom-Json`**：后者容忍尾随逗号）、`basic.path` 写成绝对路径、描述超 300 码点或含 `\|` / 反引号、`enabled` 非布尔、**禁用条目没写 `notes`**、`projectMetadataSelection` 悬空引用 | 单测 8/8 通过；并做了**变异咬合证明**（把文件指向 `%TEMP%` 的坏副本：尾随逗号 ⇒ 8/8 红并点名条目；其它不变量破坏 ⇒ 各条分别红并点名） |
| 基线一致性 | `docs/dev-rules/meka-whitelist-verification.md` **WL-24** | 随包基线机械字段与真实工作区不一致（指纹、条目集合） | 见 WL-24 的「验证现状」 |

> **告警行的边界（如实登记）**：告警带绝对路径，写在本机日志里。scope `meka-projects:metadata-scanner`
> **未**进入日志上传白名单（deny-by-default），所以这些绝对路径**只落本机、不上传**；若日后有人把它
> 加进上传白名单，这条告警的绝对路径就会变成可上传内容，届时必须重新评审。
> 另一处已知边界：扫描读文件有 2 MiB 上限，超过该上限时比对用的是被截断的文本（真实别名最大 37 KiB，
> 未被特判）。

## 6. 真实事故：为什么这些规矩不是空话

- **别名内容副本漂移（已发生）**：`saga2_design/CLAUDE.md` 2397 B（2026-07-13）落后于同目录
  `AGENTS.md` 5259 B（2026-08-18），**缺两条硬规则**（「三级复核边界」「配置表普通生产单次授权例外」）
  ⇒ 任何读 Claude 侧的路径都拿到陈旧的规则集，且**数月无人发现**（当时没有任何检查）。
  该目录更棘手的是：它没有任何文件声明权威方向，而同仓 `IP组-ip/世界观-worldbuilding/` 明确声明
  「`CLAUDE.md` 为唯一权威源、`AGENTS.md` 为逐字镜像」—— 若沿用该约定，则**领先的是镜像、落后的是源**。
- **同目录两份 37,755 B 逐字相同**：`世界观-worldbuilding/` 的 `CLAUDE.md` 与 `AGENTS.md`
  SHA256 相同。今天无害，但它自述「CLAUDE.md 为源、AGENTS.md 为镜像」是**人工同步义务** ⇒
  下次只改一处就漂移。**改成单向 include 才是一劳永逸。**
- **基线 JSON 非法（已发生）**：一次性重写随包基线时产生了尾随逗号，PowerShell 解析通过、
  Node/Electron 拒绝 ⇒ 31 个单测变红。根因是**用宽容解析器做校验**。该教训已固化为 §5 的守卫与
  WL-24 的硬要求。

## 7. 项目侧的收尾清单（从发现到固化）

1. 点一次「发现元数据」把新文件收进清单（**重扫保留** `description` / `displayName` / `notes` /
   `enabled` / `disciplines` / `domains`，只刷新 `name` / `contentFingerprint` / `subProjectPath` /
   `sourcePath`）。
2. 逐条写 `displayName` + `description`（中文、≤ 300 字、句尾带「查阅本文档当需要：…」触发语）。
3. 对每一处重复执行 §3 的判据：**先修文件，再决定要不要 `enabled: false`**；禁用的一律补 `notes`。
4. 别名一律收敛为 include；做不到就补一致性检查。
5. 新增/改名/AI 刷新技能正文后，回头核对本清单（`tool-skill-refresh` 目前只覆盖 `script-*`，
   `artist-*` / `editor-*` / `doc-*` 仍是「仅预留」⇒ 这几族的正文与清单**最容易腐坏**）。
