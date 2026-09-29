#!/usr/bin/env node
/**
 * Meka 项目 / 角色会话端到端冒烟：用 Chrome DevTools Protocol 程序化驱动正在运行的
 * Desktop dev 实例，把 `docs/dev-rules/meka-whitelist-verification.md` 的 WL-3.2 与
 * WL-11（项目与角色机制、Meka 会话生命周期）从「只能人工点击」变成可重复执行、可留证的检查。
 *
 * 为什么需要它：白名单规范要求「合并后必须实际运行检查，全部通过才能宣告完成」。项目/角色
 * 机制的核心恰恰是**运行期语义**——草稿绑定、会话落库、角色运行期注入、侧栏归属分类。
 * 只断言「侧栏有 SAGA2 字样」无法拦住「UI 还在、绑定已经常量退化」这类静默回归。
 *
 * 覆盖内容（逐项对应白名单条目）：
 *   - WL-3.2  侧栏 Meka 项目树：项目行 + 项目作用域的新建入口，并按该项目**是否启用正式工作流**
 *     断言「扁平」与「正式流程 / 普通对话两子组」两套契约中**该套**的完整结构
 *   - WL-11.1 从该布局的项目入口（扁平 = 项目行上的项目级入口；两子组 =「普通对话」子组头上的入口）
 *     创建草稿后，草稿被绑定到该项目与该项目默认角色
 *   - WL-11.2 角色选择器列出该项目全部角色（随包内置阵容 = 该项目共享默认角色），切换后草稿角色随之变化
 *   - WL-11.3 发送后会话行绑定 project/role，工作目录解析到项目路径，且为普通（非正式）会话
 *   - WL-11.4 Agent 真实跑完一轮并产出回复
 *   - WL-11.5 角色上下文注入运行期：由运行中的会话回显 [MEKA_ROLE_CONTEXT] 证明
 *   - WL-11.6 运行期配置按角色解析（MCP / 技能快照，**无 workflow 字段**）；默认角色走「出厂即全量」契约
 *   - WL-11.7 新会话归属 Meka 分区下的该项目子树，而非普通「对话」分组
 *   - WL-11.8 同一项目内再次点击新建入口时保留当前草稿已选角色
 *   - WL-11.17 规范类元数据的渐进披露（order 65 段 `meka.project-references`）：只投递
 *     「作用范围 | 绝对路径 | 用途」，正文不内联。脚本把它拆成**两行**：
 *     `WL-11.17`（段注入）与 `WL-11.17/退役重绑`（升级库不残留已退役内置角色行）——
 *     两条同属白名单 WL-11.17 这一条不变量，`--filter WL-11.17` 会同时命中。
 *
 * ⚠️ 默认角色契约已反转（2026-09-23「默认角色合并通用开发」交付）：
 *   共享默认角色（`<projectId>-default-role`）从「刻意零注入」变为**出厂即全量**——吸收项目
 *   `roleDefaults`（promptFramework + 默认 skills + 默认 MCP + 默认元数据选择）与项目当前**全部
 *   enabled 元数据**（`includeAllProjectMetadata`）；`agents-md` / `rule` **不再内联正文**，改投
 *   「作用范围 + 绝对路径 + 用途」清单（order 65 段 `meka.project-references`，正文按需读取）；
 *   它**绝不带 `workflow`**（因此永不进入战斗门禁）。同时「通用开发」退役：包内角色 JSON 已删除。
 *   据此，WL-11.6 里整套「默认角色不注入」的反向断言
 *   （`skillsCount === platformSkillsCount`、平台基线外 MCP 为空、快照技能数 === platformSkillsCount）
 *   **已作废并反转**，WL-11.1/11.2/11.8 的期望值与取角色的方式（位置 → 身份）同步更新，
 *   WL-11.17 为本次新增（脚本内拆成 `WL-11.17` / `WL-11.17/退役重绑` 两条检查）。
 *
 * ⚠️ 2026-09-29（Meka 最小随包交付）后**随包角色清单目录整体消失**（`resources/meka/roles/` 不再
 *   存在），脚本据此改口。改动依据见 `docs/dev-rules/meka-whitelist-verification.md` 的 WL-11
 *   「2026-09-29」块与 §8.12 第 4 条第 7 项；本文件是那一项的收口：
 *   - 唯一随包保证的角色 = **共享默认角色**（`mekaDefaultRoleId(projectId)`，如 `saga2-default-role`），
 *     其清单由 `mekaDefaultRoleManifest()` **内存合成、从不落盘**。`COMBAT_ROLE_ID` 与
 *     `combatRoleOf()` 已删除（原「角色清单声明」分支的靶子 `combat-development.json` 已随包删除），
 *     默认角色分支改为**不问文件**。
 *   - 非默认角色的声明源只剩两处：**项目文件 `builtinRoles` 快照**与**用户目录
 *     `meka-roles/<roleId>.json`**。脚本只读后者（`declaredRoleSkills()`）；两者都读不到时该分支
 *     登记 UNVERIFIED，不再把「读不到清单」写成 FAIL。存量库里 `combat-development` 的
 *     `is_builtin=1` 孤儿行**刻意保留**（它是退役映射表的**重绑目标**，不删存量行），读取时由 T2
 *     回落该项目默认角色（白名单 WL-20）⇒ 落在它上面的 `--role` 同样只能登记 UNVERIFIED。
 *   - 「默认角色绝不带 workflow」改为断言**运行期配置块里根本不存在 `workflow` 键**：该字段已随
 *     workflow 机制整体删除，旧的 `pick('workflow') !== null` 恒为 false ⇒ **永远不可能失败**。
 *   - 「角色清单声明的技能/MCP」改为断言**随包平台 MCP**（默认角色清单自己 pin 的 `meka-design`）
 *     与**随包平台 Skill**（`platform-capabilities`）必须生效/在快照里，替代已删除的角色清单项。
 *   - 内置阵容不再做「恰等于 [默认角色]」的集合相等断言：升级库里合法的孤儿内置行会让它假红，
 *     改为「默认角色必须在场 + 其余内置行必须已无随包清单」。同理，项目只有共享默认角色时
 *     WL-11.2/11.8 的「切换角色」断言降级为 UNVERIFIED（切到默认角色本身 = 同值比较 = 恒真）。
 *   - **侧栏布局改为按运行期探测分支（同轮补齐；2026-09-29 实机复现）**：侧栏只有在项目**启用了
 *     正式工作流**时才渲染「正式流程 / 普通对话」两个子组头（`MekaAssistantSection.tsx:175` 由
 *     `formalWorkflowEnabled` + workflow 类型与 key/url 算出 `formalWorkflowActive`，:477 走两子组
 *     分支）；没有正式工作流的项目（随包 `saga2`：`basic.formalWorkflowEnabled=false` +
 *     `workflowType: "none"`）走 :466 / :531 的**扁平分支**——不渲染任何子组头，会话直接挂在项目行
 *     下，新建入口是**项目级**的 `meka.newSessionForProject`「在 {{project}} 中新建对话」并挂在
 *     **项目行**上（子组分支的入口才是 `meka.newRegularSessionForProject`「…新建普通对话」）。
 *     脚本原来无条件按两子组形态找「普通对话」子组头 ⇒ 在扁平项目上「未找到子组头」而**建不出
 *     草稿**：`pnpm desktop:session-smoke` 实机为 WL-3.2 / 11.1 / 11.8 报「未找到子组头「普通对话」」，
 *     WL-11.2 因草稿根本没建出来而报「弹层未打开」，WL-11.3 / 11.5 / 11.6 / 11.7 连带假红。
 *     现在由 `resolveMekaProjectLayout()` 在**展开后的项目组容器内探测**两条互斥信号来选路径
 *     （①两个子组头 + 挂在子组头上的两个入口；②无子组头 + 挂在项目行上的项目级入口），信号
 *     自相矛盾时**不猜**，直接 FAIL 并列出信号。探测**不**硬编码「saga2 是扁平的」，也**不**把
 *     `formalWorkflowActive` 的算法抄进脚本（那会多一份会漂移的镜像；且随包项目在库里的
 *     `meka_projects.path` 是相对值 `saga2`，真实项目根由 p4 设置解析，脚本读不全）——判据就是
 *     **实际渲染出来的**那一组 DOM 信号。
 *   - 相应地 WL-3.2 变为**按布局断言该布局的契约**（不再只断言「有个新建入口能点」）：扁平分支付出
 *     「子组头缺席」「项目子树只有项目行一个树节点」「项目级入口挂在项目行上」「会话行不落在任何
 *     子组容器里」；两子组分支保持原断言（两个子组头 + 各自作用域入口 + 项目子树 3 个树节点），
 *     并补上与扁平对称的**会话放置**断言（会话行必须全部落在两个子组容器里）。WL-11.1 / 11.8 建
 *     草稿与「重进项目入口保留已选角色」一律走**该布局**的入口。角色选择器在草稿路由里、与侧栏布局无关，
 *     打开方式无需改动（`NewMakerDraftRoute.tsx:620-669` 的触发器/选项 DOM）。
 *
 *   **本次布局修复的期望值对照**（同样体例）：
 *
 *   | 检查 | 扁平项目（`formalWorkflowActive=false`，随包 saga2） | 两子组项目（正式工作流启用） |
 *   | --- | --- | --- |
 *   | WL-3.2 | 项目行 + **项目级**入口「在 X 中新建对话」挂在项目行上 + 显式断言子组头**不**在场 + 会话行不落在子组容器里 | 两个子组头在场 + 各自作用域入口挂在对应子组头上 + 项目级入口**不**在场 |
 *   | WL-11.1 / 11.8 | 从**项目行**上的项目级入口建草稿 / 重进该入口 | 从「普通对话」**子组头**上的入口建草稿 / 重进该入口 |
 *
 * 下表是 2026-09-23 那轮改动的**期望值对照**（体例同白名单清单的「改动前 / 新期望」）：
 *
 *   | 检查 | 改动前 | 本轮新期望 |
 *   | --- | --- | --- |
 *   | WL-11.1 | 草稿默认角色 = 通用开发 | 草稿默认角色 = 共享默认角色「默认角色」 |
 *   | WL-11.2 | 选项数与库里角色数相等；切换目标取 `roles[1]` | 选项与库里角色一一对应、共享默认角色排第一；随包内置阵容 = 该项目共享默认角色（存量库可另有「随包清单已删」的孤儿内置行）；切换目标 = 第一个非默认角色 |
 *   | WL-11.6 | 默认角色：`workflow=null`、`skillsCount===platformSkillsCount`、平台基线外 MCP 为空、快照技能数===platformSkillsCount | 默认角色：运行期配置块**没有 `workflow` 键**、MCP ⊇ 平台基线且 ⊇ 默认角色清单 pin 的 `meka-design` 且 ⊇ 项目 roleDefaults、`skillsCount>platformSkillsCount`、快照 ⊇ 项目默认技能与平台技能 `platform-capabilities` 且 > 平台基线 |
 *   | WL-11.8 | fresh 默认 =「通用开发」 | fresh 默认 =「默认角色」 |
 *   | WL-11.17 | （无此检查） | 注入段含 marker 与格式行「每条格式：作用范围 \| 绝对路径 \| 用途」；条目逐行合规、绝对路径真实存在；无 `#` 标题行、无正文标志串 |
 *   | WL-11.17/退役重绑 | （无此检查） | `meka_roles` 无退役内置角色行；该项目可见角色无退役 id |
 *
 * ⚠️ **本轮（2026-09-23）写脚本时没有实跑本脚本**：上表的「新期望」都是从代码与契约推导的
 * **待验证值**，不是已通过结论。按 `docs/dev-rules/meka-whitelist-verification.md` 的口径，未实跑
 * 不得记成通过——实跑与结论由交付时统一登记。这条「写脚本时未实跑」的状态**只写在代码注释里**，
 * 刻意不写进任何 PASS 证据串：真实跑完之后输出若仍打印「待实跑／本轮未实跑」，就会误导维护者。
 * 重跑的主命令是 `pnpm desktop:session-smoke`：默认路径就用**该项目的共享默认角色**建会话 ⇒ 命中
 * WL-11.6 的默认角色契约分支。`--role <项目自有角色的 id 或显示名>` 仍可跑「角色声明」分支
 * （声明源 = 用户目录 `meka-roles/<roleId>.json`）。随包已不附带任何角色清单文件，所以
 * `--role 战斗开发` 这类落在**内置孤儿行**上的角色只会登记 UNVERIFIED（理由见上）。
 *
 * 前置：
 *   1. 应用已通过 `pnpm restart:desktop:remote` 起来（dev 模式默认开 remote debugging）；
 *   2. 端口来自该实例 userData 下的 `DevToolsActivePort`（或用 `--port` 显式指定）。
 *
 * 用法：
 *   pnpm desktop:session-smoke                     # 自动解析端口，用第一个多角色 Meka 项目
 *   pnpm desktop:session-smoke -- --dry-run        # 只读：一切真实 UI 交互与建会话都跳过
 *   pnpm desktop:session-smoke -- --user-data-dir "<userData>" --json
 *   pnpm desktop:session-smoke -- --project-id saga2 --role 默认角色
 *
 * `--role`（**新语义，2026-09-23 起**）：不传时默认路径就用**该项目的共享默认角色**
 * （`<projectId>-default-role`，也就是承接「通用开发」职能的出厂全量角色）建会话，因此
 * WL-11.6 默认就命中默认角色契约；传 `--role <角色 id 或显示名>`（例如 `--role 默认角色`，或某个
 * **项目自有角色**）才改用它跑「角色声明」分支——随包已不附带任何角色清单（`resources/meka/roles/`
 * 不存在），项目自有角色的声明只从用户目录 `meka-roles/<roleId>.json` 读，读不到就登记 UNVERIFIED。
 * 指定了库里不存在的角色会以退出码 2 直接失败，不静默回落——静默回落会把「我想验别的角色」变成假通过。
 *
 * 退出码：0 = 无 FAIL（UNVERIFIED 不阻断但会列出）；1 = 有 FAIL；2 = 前置不满足（连不上、
 * 库/清单读不到、`--role` 不存在等）。
 *
 * 副作用（刻意保留，规范要求实跑）：会在真实用户库里新建一条 Meka 会话并发起**两次**真实模型
 * 调用（一轮普通对话 + 两轮注入段回显探针）。`--dry-run` 跳过「发送 → 建会话 → 运行」三段，且
 * 跳过一切会派发真实输入事件或改 hash 的检查（WL-3.2 / WL-11.1 / WL-11.2 / WL-11.8）——它们会
 * 登记为 UNVERIFIED 并在证据里标注「dry-run 未执行」，**不会**被伪造成 PASS。dry-run 下真正执行
 * 的只剩只读检查（`WL-11.17/退役重绑`：只读库与清单）。
 * 脚本只读库/日志/快照与项目配置文件，不修改仓库文件、不改应用配置。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// `better-sqlite3` 是 desktop 的依赖（根只是靠 hoisting 恰好可见），因此优先从 desktop
// 解析，避免换 node-linker / 关掉 hoisting 后本工具在干净安装上直接崩。
const require = createRequire(path.join(ROOT, 'apps', 'desktop', 'package.json'));
const DEFAULT_PORT = 9222;
const READY_TIMEOUT_MS = 30_000;
const STEP_TIMEOUT_MS = 10_000;
const SESSION_TIMEOUT_MS = 60_000;
const REPLY_TIMEOUT_MS = 180_000;
const MESSAGE = '只回复两个字：收到。不要调用任何工具。';
const ROLE_CONTEXT_MESSAGE =
  '请把你上下文里 [MEKA_ROLE_CONTEXT] 与 [/MEKA_ROLE_CONTEXT] 之间的内容逐行原样输出，含标记行本身；不要解释、不要调用任何工具。';

/**
 * 项目参考清单段（段 id `meka.project-references`，order 65）的字面量。
 *
 * ⚠️ **同步义务**：这些字面量的唯一来源是
 * `apps/desktop/src/main/meka-injection/mekaPrompts.ts`（2026-09-29 随包收敛由
 * `mekaCombatPrompts.ts` 改名而来，战斗段已随之删除）的
 * `MEKA_PROJECT_REFERENCES_MARKER` / `mekaProjectReferencesPrompt()`。注意段内的「每条格式」行
 * 现已是该函数里的**内联字面量**，不再有独立导出标识符可供引用。本脚本是 `.mjs`、跨进程
 * 只读日志/库/DOM，**刻意不 import TS 源码**（那会要求构建产物或 TS 加载器），所以这里是**手抄
 * 副本**：该常量一旦改名、改标点或改条目形态，本脚本必须一起改，否则 WL-11.17 会变成假红；
 * 更糟的是旧 marker 仍命中旧段时，新段可能从未被验证过。
 */
const MEKA_PROJECT_REFERENCES_MARKER = '[MEKA_PROJECT_REFERENCES]';
const MEKA_PROJECT_REFERENCES_CLOSE = '[/MEKA_PROJECT_REFERENCES]';
const MEKA_PROJECT_REFERENCES_FORMAT_LINE = '每条格式：作用范围 | 绝对路径 | 用途';
/** `scope === ''` 的显示形态（同文件的 `MEKA_PROJECT_REFERENCES_ROOT_SCOPE_LABEL`）。 */
const MEKA_PROJECT_REFERENCES_ROOT_SCOPE_LABEL = '(项目根)';
/**
 * 段的**全部固定模板行**（同上，逐字手抄）：除 marker 与格式行外，还有打开标记后的两句说明与
 * 闭合前的最后一句。WL-11.17 用它把「模板行」与「条目行」区分开——凡是不属于这两类、又不是
 * 代码围栏的行，都算「清单外的文本」，必须报出来。
 */
const MEKA_PROJECT_REFERENCES_TEMPLATE_LINES = [
  MEKA_PROJECT_REFERENCES_MARKER,
  '项目参考文件按作用范围列出。当你的工作涉及某个作用范围内（该目录及其子目录）的内容时，',
  '必须先用原生文件读取工具（read）完整读取该范围内列出的文件，再动手；不要凭记忆、缓存或旧版内容替代。',
  MEKA_PROJECT_REFERENCES_FORMAT_LINE,
  '不要读取、枚举或发现本清单未列出的 AGENTS.md / .cursorrules / rules.md；技能正文（SKILL.md）按技能目录正常按需读取；不要根据项目根目录二次拼接或猜测其它路径。',
  MEKA_PROJECT_REFERENCES_CLOSE,
];
/**
 * 注入段回显探针。**必须要求「逐行原样、含两行标记」，且显式禁止读文件**：本检查断言的是
 * Host 投递了什么，不是模型自己读了什么（若模型自行读取参考文件，回显里会出现正文标题行，
 * 那属于偏差，失败信息会原样引用这些行以便人工区分）。
 */
const PROJECT_REFERENCES_MESSAGE =
  `请只输出你上下文里 ${MEKA_PROJECT_REFERENCES_MARKER} 与 ${MEKA_PROJECT_REFERENCES_CLOSE} 之间的全部内容，` +
  '含这两行标记本身；逐行原样输出、不要改写、不要省略、不要合并行、不要解释、不要调用任何工具、不要读取任何文件。';

function parseArgs(argv) {
  const options = {
    port: null,
    userDataDir: null,
    projectId: null,
    role: null,
    dryRun: false,
    json: false,
    filter: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      i += 1;
      return value;
    };
    if (arg === '--port') options.port = Number(next());
    else if (arg === '--user-data-dir') options.userDataDir = next();
    else if (arg === '--project-id') options.projectId = next();
    // `--role` 接受**角色 id 或显示名**（见 main() 里的解析与「新语义」说明）；不解析身份，
    // 只把原样值交给 roleFromOption()。
    else if (arg === '--role') options.role = next();
    else if (arg === '--filter') options.filter = next();
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--') continue; // pnpm 透传的分隔符
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function candidateUserDataDirs(options) {
  return [
    options.userDataDir,
    process.env.XDT_USER_DATA_DIR,
    process.env.APPDATA ? path.join(process.env.APPDATA, 'CindyMeka-dev2-dev') : null,
    process.env.APPDATA ? path.join(process.env.APPDATA, 'CindyMeka') : null,
  ].filter(Boolean);
}

function portFromUserData(userDataDir) {
  const file = path.join(userDataDir, 'DevToolsActivePort');
  if (!fs.existsSync(file)) return null;
  const port = Number(fs.readFileSync(file, 'utf8').split(/\r?\n/)[0]?.trim());
  return Number.isInteger(port) && port > 0 ? port : null;
}

function resolvePort(options) {
  if (options.port) return options.port;
  for (const dir of candidateUserDataDirs(options)) {
    const port = portFromUserData(dir);
    if (port) return port;
  }
  return DEFAULT_PORT;
}

/** 该实例的本地库文件（`cindy-meka-<ownerId>.db`，排除备份与 WAL/SHM）。 */
function resolveDbPath(options) {
  for (const dir of candidateUserDataDirs(options)) {
    if (!fs.existsSync(dir)) continue;
    const hit = fs
      .readdirSync(dir)
      .filter((name) => /^cindy-meka-.*\.db$/.test(name))
      .sort()
      .pop();
    if (hit) return path.join(dir, hit);
  }
  return null;
}

/** dev 实例的 main 日志目录：`<启动 checkout>/apps/desktop/logs/`（见
 * docs/dev-rules/engineering-conventions.md）。本脚本与实例同 checkout，故取仓库内路径。
 */
function resolveLogDir() {
  return path.join(ROOT, 'apps', 'desktop', 'logs');
}

function gitShortHead() {
  const r = spawnSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * 陈旧实例是同步验收最容易犯的错：跑着的实例若还是旧 commit，本脚本会拿**旧代码**去建会话
 * 并把结论记成「通过」。所以把它做成硬前置（退出码 2），而不是一条可被忽略的检查项。
 * 版本行渲染在侧栏底部，形如 `Global · 0.0.0 · meka/main@51fe4c4`。
 */
async function assertInstanceMatchesHead(session) {
  // 版本行渲染在主界面（侧栏底部），先落到一个稳定路由再读。
  await session.evaluate(`location.hash = '#/cc-agent/new'`).catch(() => {});
  await sleep(1500);
  const line = await session
    .waitFor(
      `(() => { const m = (document.body.innerText || '').match(/(Global|CN|Dev) · [^\\n]*meka\\/main@[0-9a-f]{7,}/); return m ? m[0] : null; })()`,
      { timeoutMs: READY_TIMEOUT_MS, label: '版本行（edition · 版本 · 分支@commit）' },
    )
    .catch(() => null);
  if (!line) return { ok: true, line: null, head: null, reason: '未找到版本行，跳过陈旧性核对' };
  const head = gitShortHead();
  const commitInUi = /@([0-9a-f]{7,})/.exec(line)?.[1] ?? '';
  if (head && !commitInUi.startsWith(head) && !head.startsWith(commitInUi)) {
    return { ok: false, line, head, reason: `实例版本行 commit=${commitInUi} 与 HEAD=${head} 不一致` };
  }
  return { ok: true, line, head, reason: null };
}

/** 极简 CDP 客户端：只需 Runtime.evaluate 与 Input.dispatch*。 */
class CdpSession {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    ws.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const entry = message.id ? this.pending.get(message.id) : null;
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP websocket connect timed out')), STEP_TIMEOUT_MS);
      ws.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    const session = new CdpSession(ws);
    await session.send('Runtime.enable');
    return session;
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = (this.nextId += 1);
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new Error(`evaluate failed: ${detail}`);
    }
    return result.result.value;
  }

  async waitFor(expression, { timeoutMs = STEP_TIMEOUT_MS, label = expression } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      last = await this.evaluate(expression);
      if (last) return last;
      await sleep(150);
    }
    throw new Error(`timed out waiting for: ${label}`);
  }

  /** 坐标 → 真实鼠标事件点击（与人工点击同链路：React 合成事件、路由、持久化都会真实发生）。 */
  async clickAt(box) {
    if (!box) return false;
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, buttons: 0 });
    await sleep(350);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', {
        type,
        x: box.x,
        y: box.y,
        button: 'left',
        clickCount: 1,
        buttons: type === 'mousePressed' ? 1 : 0,
      });
    }
    return true;
  }

  async clickSelector(selector, nth = 0) {
    return this.clickAt(await this.boxOf(`${JSON.stringify(selector)}`, nth));
  }

  /** 求值出一个元素再取其中点；`expr` 是元素表达式（不是选择器）。 */
  async boxOf(expr, nth = 0) {
    const element = nth > 0 ? `[...(${expr})][${nth}]` : expr;
    return this.evaluate(`(() => {
      const el = ${element};
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
  }

  async pressEscape() {
    for (const type of ['keyDown', 'keyUp']) {
      await this.send('Input.dispatchKeyEvent', {
        type,
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27,
      });
    }
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* 忽略关闭期错误 */
    }
  }
}

const BY_LABEL = (label) =>
  `[...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '') === ${JSON.stringify(label)})`;
const ROLE_PICKER = '选择 Meka 角色';
const ROLE_OPTION_LIST = `[role=listbox][aria-label=${JSON.stringify(ROLE_PICKER)}] [role=option]`;
/**
 * 选项按钮里第一段 span 才是角色显示名，第二段是描述（`MekaRolePicker` 的 DOM：选项按钮 >
 * flex 容器 > 显示名 span + 描述 span）。直接取 `textContent` 会把描述一起读进来，
 * 所以显示名与描述**分开读**：显示名用于身份比对，描述只作证据。
 */
const ROLE_OPTION_NAME_EXPR = `(o.querySelector('span span')?.textContent || o.textContent || '').trim()`;
/** 按**显示名精确相等**定位选项：`.includes()` 会让「战斗开发」命中「战斗开发（旧）」这类名字。 */
const roleOptionByName = (displayName) =>
  `[...document.querySelectorAll(${JSON.stringify(ROLE_OPTION_LIST)})].find((o) => ${ROLE_OPTION_NAME_EXPR} === ${JSON.stringify(displayName)})`;

/** 与语言无关的侧栏钩子：Meka 分区的展开/收起按钮、项目行、子组头。 */
const MEKA_SECTION_TOGGLE = `[...document.querySelectorAll('button')].find((b) => /展开 Meka 对话|收起 Meka 对话/.test(b.getAttribute('aria-label') || ''))`;
// 库里的 `name`（如 saga2）与可见 displayName（如 SAGA2）大小写不一定一致，比对必须忽略大小写。
const projectRow = (projectName) =>
  `[...document.querySelectorAll('[role=button]')].find((e) => (e.textContent || '').toLowerCase().includes(${JSON.stringify(projectName.toLowerCase())}) && e.getAttribute('aria-expanded') !== null)`;
const subgroupHeader = (label) =>
  `[...document.querySelectorAll('[role=button]')].find((e) => (e.textContent || '').trim() === ${JSON.stringify(label)} && e.getAttribute('aria-expanded') !== null)`;
const sidebarText = `(() => { const sb = document.querySelector('aside') || document.body; return (sb.innerText || '').replace(/\\n+/g, ' | '); })()`;

/**
 * 侧栏 Meka 项目组的**两套渲染契约**（唯一来源：
 * `apps/desktop/src/renderer/features/cc-agent/sidebar/sections/MekaAssistantSection.tsx`）：
 *
 * - **两子组**（`formalWorkflowActive`，:175 由 `formalWorkflowEnabled` + workflow 类型与 key/url
 *   算出）：项目**启用了正式工作流**时才渲染下面这两个子组头（:477 分支），新建入口挂在**子组头**上
 *   （:481 正式 / :506 普通）。
 * - **扁平**（:466 与 :531）：没有正式工作流的项目（随包 `saga2` 的
 *   `basic.formalWorkflowEnabled=false` + `workflowType: "none"`）**不渲染任何子组头**，会话直接挂在
 *   项目行下（`renderSessions(group.regularSessions, projectCollapsed)`），新建入口是**项目级**的
 *   `meka.newSessionForProject`，挂在**项目行**上。
 *
 * 两组的入口文案与挂载点**互相排斥**（扁平入口要求 `!formalWorkflowActive`，子组头要求
 * `formalWorkflowActive`），所以「探测实际渲染了哪一组信号」就足以判定布局——不需要把
 * `formalWorkflowActive` 的算法抄进脚本（那会多一份会漂移的镜像；且随包项目在库里的
 * `meka_projects.path` 是相对值 `saga2`，真实项目根由 p4 设置解析，脚本读不全）。
 */
const MEKA_SUBGROUP_LABELS = ['正式流程', '普通对话']; // i18n meka.formalSessions / meka.regularSessions
/**
 * 三种项目作用域新建入口的 aria-label 模板（i18n 的 `{{project}}` 插值形态**逐字**照抄）：
 * `meka.newSessionForProject`（扁平：挂在**项目行**上 / 两子组：不渲染）、
 * `meka.newRegularSessionForProject` 与 `meka.newFormalSessionForProject`（两子组：分别挂在
 * 「普通对话」/「正式流程」子组头上）。文案在源侧改名时这里必须同步，否则 WL-3.2 / 11.1 / 11.8
 * 会变成假红。
 */
const MEKA_ENTRY_LABEL_TEMPLATES = {
  flat: '在 {{project}} 中新建对话',
  regular: '在 {{project}} 中新建普通对话',
  formal: '在 {{project}} 中新建正式流程对话',
};
const mekaEntryLabel = (kind, projectName) =>
  MEKA_ENTRY_LABEL_TEMPLATES[kind].replace('{{project}}', projectName);
/** 会话行钩子（`SessionItem.tsx` 的 `data-sidebar-session-row`），用于「会话是否直挂项目行下」。 */
const SESSION_ROW_SELECTOR =
  '[data-sidebar-session-row="true"], [data-sidebar-navigation-row="true"]';

/** 读库（只读打开，绝不写回）。 */
function openDb(dbPath) {
  const Database = require('better-sqlite3');
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

/** 与 shared/meka-projects.ts 的 MEKA_DEFAULT_ROLE_ID_SUFFIX 同构。 */
const MEKA_DEFAULT_ROLE_ID_SUFFIX = '-default-role';
/** 包内唯一随包登记的项目（shared/meka-projects.ts 的 `BUILTIN_MEKA_PROJECTS`）。 */
const SAGA2_PROJECT_ID = 'saga2';
/**
 * 随包**唯一保证存在**的角色 id = saga2 的共享默认角色（`mekaDefaultRoleId('saga2')`）。
 *
 * 刻意写成**手抄常量**而不是到处现推：期望值需要一个独立于被测推导的来源（推导 + 推导 =
 * 同义反复，永远相等）。它同时是「脚本手抄的 id 结构是否已过期」的判据——`MEKA_DEFAULT_ROLE_ID_SUFFIX`
 * 一旦在源侧改名，`isSharedDefaultRole()` 会静默认为「这个项目没有默认角色」，把整串默认角色检查
 * 降级成「环境不满足」。WL-11.2 里对随包项目发作一条显式失败来兜住这类漂移。
 */
const DEFAULT_ROLE_ID = `${SAGA2_PROJECT_ID}${MEKA_DEFAULT_ROLE_ID_SUFFIX}`;
/**
 * 随包角色清单目录。Meka 最小随包交付后这里**整体不存在**（`resources/meka/roles/` 已删除，唯一
 * 随包角色是内存合成的共享默认角色）。本脚本只把它当作「某内置角色是否仍有随包声明」的判据，
 * **不假设它存在**（`fs.existsSync` 对不存在的目录返回 false）。
 */
const BUNDLED_MEKA_ROLES_DIR = path.join(ROOT, 'apps', 'desktop', 'resources', 'meka', 'roles');
/**
 * 已退役的内置角色 id，必须与 `shared/meka-projects.ts` 的
 * `RETIRED_BUILTIN_MEKA_DEFAULT_ROLE_ALIASES`（前四项：折叠进 `<projectId>-default-role`）与
 * `RETIRED_BUILTIN_MEKA_ROLE_MAPPINGS` 的左值（后两项：映射到 `combat-development`）同步。
 * 两张表的左值都被启动播种的删除语句清掉，因此**升级库**里不应再有这些 id 的 `is_builtin=1` 行。
 *
 * ⚠️ **不要把 `combat-development` 加进来**：它是映射表的**右值**（重绑目标），不是退役 id。
 * 它的随包清单文件已删，但 `is_builtin=1` 行**刻意保留**（不删存量行；读取时由 T2 回落该项目
 * 默认角色，见白名单 WL-20）。把它当退役行会让升级库上的本检查**假红**。
 */
const RETIRED_BUILTIN_ROLE_IDS = [
  'general-development',
  'system-development',
  'system-overview',
  'system-debug',
  'combat-config',
  'combat-debug',
];

/** 与 shared/meka-projects.ts 的 mekaDefaultRoleId() 同构：<projectId>-default-role。 */
function isSharedDefaultRole(role, projectId) {
  return role.isBuiltin === true && role.id === `${projectId}${MEKA_DEFAULT_ROLE_ID_SUFFIX}`;
}

/**
 * 应用会为该项目默认选中的角色（与 `pickDefaultMekaRole()` 同义）：优先共享默认角色，
 * 退化到第一项。用于「当前会话用的是哪个角色」这类回退，避免把位置当成身份。
 */
function defaultRoleOf(catalog) {
  return (
    catalog.roles.find((role) => isSharedDefaultRole(role, catalog.project.id)) ??
    catalog.roles[0]
  );
}

/**
 * 「切换角色」这条检查的目标角色：**共享默认角色之外的第一个角色**（按 id / 排序取，不按位置取）。
 *
 * 随包不再提供第二个内置角色（`combat-development.json` 已删除），所以目标通常是一个**项目自有
 * 角色**；存量库里也可能是遗留的孤儿内置行。项目只有共享默认角色时返回 `null` —— 调用方**必须**
 * 登记 UNVERIFIED：切到默认角色本身会让「切换后 chip 变化」变成同值比较而恒真，那是假通过。
 */
function switchTargetRoleOf(catalog) {
  return catalog.roles.find((role) => !isSharedDefaultRole(role, catalog.project.id)) ?? null;
}

/**
 * `--role` 的取值解析：先按 id（稳定身份），再按显示名/name（用户可见写法）。
 * 显示名不是主键，所以只把它当**用户输入**的便捷别名，命中后仍按 id 继续走。
 */
function roleFromOption(catalog, reference) {
  if (!reference) return null;
  return (
    catalog.roles.find((role) => role.id === reference) ??
    catalog.roles.find((role) => role.displayName === reference) ??
    catalog.roles.find((role) => role.name === reference) ??
    null
  );
}

/**
 * Host 对每个普通 Meka 任务都会注入的平台 MCP（`mekaResolvePlan.ts` 的
 * `mergePlatformMcp`）。默认角色的**新**契约要求运行期 MCP **包含**它（旧的反向断言是
 * 「平台基线之外必须为空」，那条已随 2026-09-23 的契约反转作废）。平台基线变化时这里必须
 * 同步——这正是本清单要拦住的那类漂移。
 */
const PLATFORM_MCP_PROVIDER_IDS = ['mcp-router'];
/**
 * 随包唯一的平台 Skill（`runtimeConfig.ts` 的 `MEKA_PLATFORM_SKILL_IDS`）。它是删掉 9 个业务
 * Skill 之后**唯一必须出现在每个普通 Meka 任务快照里**的随包技能，因此接替了原「角色清单声明的
 * 技能」那条断言的位置。它读不到时解析侧**硬失败**（每个项目的普通会话都会 `INVALID_PARAMS`），
 * 所以这里断言它进了快照比断言 `platformSkillsCount > 0` 更硬——计数对不上号照样能过。
 */
const PLATFORM_SKILL_IDS = ['platform-capabilities'];
/**
 * 共享默认角色**内存清单自己 pin 的 MCP**（`shared/meka-projects.ts` 的
 * `mekaDefaultRoleManifest()` 的 `mcp`）。这是原「包内角色清单声明的 MCP 生效」那条断言的存活
 * 形态：默认角色是唯一随包角色，清单从不落盘、脚本又不 import TS，所以这里是**手抄副本 + 同步
 * 义务**（同 `MEKA_PROJECT_REFERENCES_*` 的写法）——源侧改了它，本脚本必须一起改。
 */
const DEFAULT_ROLE_MCP_PROVIDER_IDS = ['meka-design'];

function readMekaCatalog(dbPath, options) {
  const db = openDb(dbPath);
  try {
    const projects = db.prepare('SELECT id, name, path FROM meka_projects ORDER BY sort_order, id').all();
    const rolesByProject = new Map();
    // 与主进程 rolesFor() 的排序一致（sort_order, display_name）。
    for (const row of db.prepare('SELECT * FROM meka_roles ORDER BY sort_order, display_name').all()) {
      if (!rolesByProject.has(row.project_id)) rolesByProject.set(row.project_id, []);
      rolesByProject.get(row.project_id).push({
        id: row.id,
        name: row.name ?? row.id,
        displayName: row.display_name ?? row.name,
        description: row.description ?? '',
        isBuiltin: row.is_builtin === 1,
      });
    }
    const project = options.projectId
      ? projects.find((p) => p.id === options.projectId)
      : // 优先挑「有至少两个角色」的项目：切换类检查（WL-11.2 / WL-11.8）需要第二个角色。
        // 一个都没有时退到第一个项目——默认角色的检查（WL-11.1 / 11.3–11.7）照样跑得动。
        projects.find((p) => (rolesByProject.get(p.id) ?? []).length >= 2) ?? projects[0];
    if (!project) throw new Error('库里没有 Meka 项目');
    const roles = rolesByProject.get(project.id) ?? [];
    // 不再要求「至少两个角色」：随包删掉战斗角色的清单后，干净安装的项目只有共享默认角色一个角色，
    // 而 WL-11.1/11.3–11.7 都能用它跑；需要第二个角色的检查在只有默认角色时降级为 UNVERIFIED。
    // 硬前置只保留「这个项目至少有一个角色」——没有角色的项目无法建会话，属于真实环境问题。
    if (!roles.length) throw new Error(`项目 ${project.id} 没有任何角色`);
    return { projects, project, roles };
  } finally {
    db.close();
  }
}

function skillDirsForSession(userDataDir, sessionId) {
  const roots = candidateUserDataDirs({ userDataDir }).map((dir) =>
    path.join(dir, 'meka-skill-snapshots'),
  );
  for (const root of roots) {
    const binding = path.join(root, 'bindings', `${sessionId}.json`);
    if (!fs.existsSync(binding)) continue;
    let revision;
    try {
      revision = JSON.parse(fs.readFileSync(binding, 'utf8')).revision;
    } catch {
      continue;
    }
    const skillsDir = path.join(root, 'revisions', revision, 'claude-plugin', 'skills');
    if (!fs.existsSync(skillsDir)) continue;
    return {
      revision,
      skills: fs
        .readdirSync(skillsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort(),
    };
  }
  return null;
}

/** 从当日 main 日志里取该会话最后一条「Meka runtime config applied」块的字段。 */
function runtimeConfigFromLog(logDir, sessionId) {
  const today = new Date().toISOString().slice(0, 10);
  const file = path.join(logDir, `main-${today}.log`);
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].includes('Meka runtime config applied before session start')) {
      const block = lines.slice(i, i + 16).join('\n');
      if (block.includes(sessionId)) {
        start = i;
        break;
      }
    }
  }
  if (start === -1) return null;
  const block = lines.slice(start, start + 16).join('\n');
  // Anchored on a key boundary so a key can never be matched as a suffix of a longer key.
  // Today `platformSkillsCount` is logged with a capital S, so the unanchored form happened
  // not to collide with `skillsCount`; anchoring makes that independent of casing and of any
  // future field name ending in `skillsCount`, which the default-role comparison relies on.
  const pick = (key) => {
    const m = block.match(new RegExp(`(?:^|[\\s,{])${key}:\\s*([^,\\n]+)`));
    return m ? m[1].trim().replace(/^'|'$/g, '') : null;
  };
  const mcpMatch = block.match(/mcpProviderIds:\s*\[([^\]]*)\]/);
  return {
    projectId: pick('projectId'),
    roleId: pick('roleId'),
    skillsCount: Number(pick('skillsCount')),
    platformSkillsCount: Number(pick('platformSkillsCount')),
    skillRevision: pick('skillRevision'),
    // 这一次日志块里**出现过的全部键名**（含 JSON 引号形态）。存在的意义是让调用方断言
    // 「某个字段根本不存在」：`pick('workflow')` 那种「取到的值是不是 null」的断言在字段被删掉
    // 之后恒为真，**永远不可能失败**（假通过）；而对键名的断言在生产侧重新投递该键时立刻变红。
    keys: logBlockKeys(block),
    mcpProviderIds: mcpMatch
      ? mcpMatch[1]
          .split(',')
          .map((s) => s.trim().replace(/^'|'$/g, ''))
          .filter(Boolean)
      : [],
  };
}

/**
 * 单个日志块里出现过的键名。前缀规则与上面的 `pick()` 完全一致（`^` / 空白 / `,` / `{` 之后），
 * 额外容忍 JSON 的引号键形态；键名本身限定为标识符，因此键值里的冒号（时间戳、URL）与数组元素
 * 都不会被当成键。
 */
function logBlockKeys(block) {
  const keys = new Set();
  for (const match of block.matchAll(/(?:^|[\s,{])"?([A-Za-z_][A-Za-z0-9_]*)"?\s*:/g)) {
    keys.add(match[1]);
  }
  return [...keys];
}

/**
 * 角色清单里声明的技能 / MCP。
 *
 * **声明源在 2026-09-29 后只剩一处**：随包 `resources/meka/roles/` 已整体删除（唯一随包角色是内存
 * 合成的共享默认角色）。生产侧 `runtimeConfig.ts` 的 `resolveRoleFile` 对**内置**行读的是项目文件
 * `builtinRoles` 快照或随包清单，对**用户自有**行（`is_builtin=0`）读的才是用户目录
 * `meka-roles/<roleId>.json`（`projectConfig.ts` 的 `customRolePath`）。本函数只承担后者：内置行
 * 一律返回 null，由调用方登记 UNVERIFIED —— 拿用户目录的同名文件去核对内置行会核对到一个
 * **生产根本不读**的声明源（那会变成假红/假绿）。
 *
 * `enabled: false` 的条目必须排除：运行期会过滤它们，不过滤就会把「清单声明了但显式关闭」误报成
 * 「声明未生效」。返回值里**没有** `workflow`：该字段已随 workflow 机制整体删除，留着只会诱导
 * 调用方去比 null（假通过）。
 */
function declaredRoleSkills(role, userDataDir) {
  if (role.isBuiltin) return null;
  for (const dir of candidateUserDataDirs({ userDataDir })) {
    const file = path.join(path.resolve(dir), 'meka-roles', `${role.id}.json`);
    if (!fs.existsSync(file)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
      return {
        file,
        skills: (manifest.skills ?? [])
          .filter((entry) => entry?.enabled !== false)
          .map((entry) => entry.skillId)
          .filter(Boolean),
        mcp: (manifest.mcp ?? [])
          .filter((entry) => entry?.enabled !== false)
          .map((entry) => entry.providerId)
          .filter(Boolean),
      };
    } catch {
      return null;
    }
  }
  return null;
}

/** 只读文件开头若干字节（正文可能几十 KB，取标志串不需要整读）。 */
function readFileHead(file, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(maxBytes);
    const read = fs.readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, read).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* 忽略关闭期错误 */
      }
    }
  }
}

function readJsonIfObject(file) {
  if (!file || !fs.existsSync(file)) return null;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw.startsWith('\uFEFF') ? raw.slice(1) : raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 项目配置里**默认角色必然吸收**的部分（只读 JSON，不 import TS）：
 * - `roleDefaults.mcp[].providerId`（默认角色 `useProjectDefaults: true`，见 `mergeMekaProjectRoleDefaults`）；
 * - `roleDefaults.skills[]`（同上，取值是包内 catalog 的 skill id）；
 * - `metadata[]` 里 enabled 的条目（`includeAllProjectMetadata: true`）：`skill` 进技能，
 *   `agents-md` / `rule` 进「地址 + 描述」清单。
 *
 * 读取顺序**镜像** `readProjectConfigState()`：项目根的 `.meka/project.json` 覆盖优先，
 * 缺失或不可解析时回落到包内 `resources/meka/projects/<projectId>/project.json`。
 * 两处都读不到就返回 null——调用方必须把相关断言降级为 UNVERIFIED，**不许猜**。
 *
 * `existingReferencePaths` 按 `resolveProjectMetadataAbsolutePath()` 的同一套规则（`rootPath ??
 * projectRoot` + 按 `/` 拆分 `sourcePath`）解析出**真实存在**的规范文件绝对路径：段里的条目数
 * 至少要与它相等，否则就是「清单漏投」——没被列出的文件，Agent 按契约不该去发现，等于不可达。
 */
function readProjectDefaultContributions(projectRoot, projectId) {
  const projectRootAbsolute =
    typeof projectRoot === 'string' && path.isAbsolute(projectRoot) ? path.resolve(projectRoot) : null;
  const candidates = [
    projectRootAbsolute ? path.join(projectRootAbsolute, '.meka', 'project.json') : null,
    path.join(ROOT, 'apps', 'desktop', 'resources', 'meka', 'projects', projectId, 'project.json'),
  ].filter(Boolean);
  for (const file of candidates) {
    const parsed = readJsonIfObject(file);
    if (!parsed) continue;
    const defaults = parsed.roleDefaults ?? {};
    const metadata = Array.isArray(parsed.metadata) ? parsed.metadata : [];
    const enabledMetadata = (itemType) =>
      metadata.filter((item) => item?.itemType === itemType && item?.enabled !== false);
    const referenceItems = [...enabledMetadata('agents-md'), ...enabledMetadata('rule')];
    const existingReferencePaths = referenceItems
      .map((item) => {
        if (typeof item?.sourcePath !== 'string' || !item.sourcePath) return null;
        const root =
          typeof item?.rootPath === 'string' && item.rootPath.trim()
            ? path.resolve(item.rootPath)
            : projectRootAbsolute;
        if (!root) return null;
        return path.resolve(root, ...item.sourcePath.split('/'));
      })
      .filter((resolved) => resolved && fs.existsSync(resolved));
    return {
      file,
      mcpProviderIds: (Array.isArray(defaults.mcp) ? defaults.mcp : [])
        .map((entry) => entry?.providerId)
        .filter((value) => typeof value === 'string' && value.trim()),
      skillIds: (Array.isArray(defaults.skills) ? defaults.skills : []).filter(
        (value) => typeof value === 'string' && value.trim(),
      ),
      enabledSkillMetadata: enabledMetadata('skill').length,
      enabledReferenceMetadata: referenceItems.length,
      existingReferencePaths,
    };
  }
  return null;
}

/**
 * 项目贡献快照（按需计算一次）。会话落库后才有 `working_dir`（= 项目根），
 * 因此它只能在 WL-11.3 之后取；`--dry-run` 下恒为 null。
 */
function projectContributionsOf(ctx) {
  if (ctx.projectContributions === undefined) {
    ctx.projectContributions = readProjectDefaultContributions(
      ctx.row?.working_dir ?? null,
      ctx.catalog.project.id,
    );
  }
  return ctx.projectContributions;
}

/** 展开侧栏 Meka 段与项目行（两套布局共用），返回项目行在侧栏里的真实可见标签。 */
async function ensureMekaTreeVisible(session, projectName) {
  await session.evaluate(`location.hash = '#/cc-agent/new'`);
  await sleep(1800);

  const toggle = await session.evaluate(
    `${MEKA_SECTION_TOGGLE}?.getAttribute('aria-label') ?? null`,
  );
  if (toggle && toggle.includes('展开')) {
    await session.clickAt(await session.boxOf(MEKA_SECTION_TOGGLE));
    await sleep(900);
  }
  // 项目行的可见标签就是 app 用于 aria-label 的 displayName（可能来自项目配置文件，
  // 与库里的 `name` 不一定同形，例如 name=saga2 / displayName=SAGA2）。因此不能自己
  // 拼标签，必须从 DOM 读回真实标签。内部空白先折叠成单空格：入口 aria-label 用的是
  // `{{project}}` 插值后的**原值**，行内若混入换行/缩进会导致严格相等比对失败。
  const rowExpr = projectRow(projectName);
  if ((await session.evaluate(`${rowExpr}?.getAttribute('aria-expanded') ?? null`)) === 'false') {
    await session.clickAt(await session.boxOf(rowExpr));
    await sleep(900);
  }
  const label = await session.evaluate(
    `${rowExpr}?.textContent?.replace(/\\s+/g, ' ').trim() ?? null`,
  );
  return label;
}

/**
 * 探测**已展开**的项目组容器的真实渲染形态，据此判定布局（两套契约见 `MEKA_SUBGROUP_LABELS` 的
 * 注释）。判据全部是 DOM 信号，不硬编码任何项目：
 *
 *   ① 子组头文案（`正式流程` / `普通对话`）；
 *   ② 三种项目作用域新建入口的**挂载点**：项目级入口在**项目行**内 ⇔ 扁平；
 *      子组入口在**对应子组头**内 ⇔ 两子组；
 *   ③ 项目子树的树节点数（`[role=button]` 且不在会话行内）：扁平 = 只有项目行 1 个，
 *      两子组 = 项目行 + 两个子组头 3 个；以及会话行是否落在子组容器里。③ **不参与选路径**，
 *      只作为信号返回给 WL-3.2 去正面断言「树就长这样」。
 *
 * ①②互相印证后才会给出结论；信号自相矛盾（既像扁平又像两子组、或两组都不齐）时**不猜**，
 * 返回 `ok:false` 并把观测到的信号原样报出——静默挑一条路径会把「UI 分支回归」变成假通过。
 */
async function resolveMekaProjectLayout(session, projectName) {
  const projectLabel = await ensureMekaTreeVisible(session, projectName);
  if (!projectLabel) return { ok: false, reason: `侧栏 Meka 分区里找不到项目「${projectName}」` };
  const probe = `(() => {
    const row = ${projectRow(projectName)};
    if (!row) return { error: 'no-project-row' };
    const container = row.parentElement;
    if (!container) return { error: 'no-project-container' };
    const projectLabel = (row.textContent || '').replace(/\\s+/g, ' ').trim();
    const labelOf = (template) => template.replace('{{project}}', projectLabel);
    const flatLabel = labelOf(${JSON.stringify(MEKA_ENTRY_LABEL_TEMPLATES.flat)});
    const regularLabel = labelOf(${JSON.stringify(MEKA_ENTRY_LABEL_TEMPLATES.regular)});
    const formalLabel = labelOf(${JSON.stringify(MEKA_ENTRY_LABEL_TEMPLATES.formal)});
    const textOf = (el) => (el.textContent || '').replace(/\\s+/g, ' ').trim();
    const headerLabels = [...container.querySelectorAll('[role=button]')]
      .map(textOf)
      .filter((text) => ${JSON.stringify(MEKA_SUBGROUP_LABELS)}.includes(text));
    const inSessionRow = (el) => !!el.closest(${JSON.stringify(SESSION_ROW_SELECTOR)});
    const treeNodes = [...container.querySelectorAll('[role=button]')].filter((el) => !inSessionRow(el));
    const headerOf = (text) => [...container.querySelectorAll('[role=button]')].find((el) => textOf(el) === text) || null;
    const entryIn = (root, label) => root
      ? [...root.querySelectorAll('button')].some((b) => (b.getAttribute('aria-label') || '') === label)
      : false;
    const regularHeader = headerOf(${JSON.stringify(MEKA_SUBGROUP_LABELS[1])});
    const formalHeader = headerOf(${JSON.stringify(MEKA_SUBGROUP_LABELS[0])});
    const sessionRows = [...container.querySelectorAll('[data-sidebar-session-row="true"]')];
    const inSubgroup = sessionRows.filter((sessionRow) => {
      for (let el = sessionRow.parentElement; el && el !== container; el = el.parentElement) {
        if (headerLabels.some((text) => [...el.querySelectorAll('[role=button]')].some((el2) => textOf(el2) === text))) return true;
      }
      return false;
    }).length;
    return {
      projectLabel,
      headerLabels,
      treeNodeCount: treeNodes.length,
      treeNodeLabels: treeNodes.map(textOf),
      sessionRowCount: sessionRows.length,
      sessionRowsInSubgroups: inSubgroup,
      flatEntryOnRow: entryIn(row, flatLabel),
      regularEntryOnHeader: entryIn(regularHeader, regularLabel),
      formalEntryOnHeader: entryIn(formalHeader, formalLabel),
      entryLabels: [...container.querySelectorAll('button')]
        .map((b) => b.getAttribute('aria-label') || '')
        .filter((a) => a.includes('新建')),
    };
  })()`;
  const signals = await session.evaluate(probe);
  if (!signals || signals.error) {
    return { ok: false, reason: `侧栏项目组的 DOM 探测失败：${signals?.error ?? '探测返回空结果'}` };
  }
  const hasEveryHeader = MEKA_SUBGROUP_LABELS.every((text) => signals.headerLabels.includes(text));
  const hasNoHeader = MEKA_SUBGROUP_LABELS.every((text) => !signals.headerLabels.includes(text));
  const flatSignals =
    hasNoHeader && signals.flatEntryOnRow
    && !signals.regularEntryOnHeader && !signals.formalEntryOnHeader;
  const subgroupSignals =
    hasEveryHeader && signals.regularEntryOnHeader && signals.formalEntryOnHeader
    && !signals.flatEntryOnRow;
  if (flatSignals && !subgroupSignals) {
    return { ok: true, layout: 'flat', projectLabel: signals.projectLabel, signals };
  }
  if (subgroupSignals && !flatSignals) {
    return { ok: true, layout: 'subgroups', projectLabel: signals.projectLabel, signals };
  }
  return {
    ok: false,
    reason: '侧栏项目组的布局信号自相矛盾或两组信号都不完整（无法判定扁平/两子组）：'
      + JSON.stringify({
        headerLabels: signals.headerLabels,
        treeNodeLabels: signals.treeNodeLabels,
        flatEntryOnRow: signals.flatEntryOnRow,
        regularEntryOnHeader: signals.regularEntryOnHeader,
        formalEntryOnHeader: signals.formalEntryOnHeader,
      }),
  };
}

/**
 * 建 Meka 草稿：展开 Meka 段与项目行，按**探测到的布局**把真实鼠标事件打到正确的入口上。
 *
 * 入口由布局决定（见 `MEKA_ENTRY_LABEL_TEMPLATES` 的注释）：
 * - 扁平（`formalWorkflowActive=false`）：hover **项目行** → 点项目级入口「在 X 中新建对话」；
 * - 两子组：hover 对应**子组头** → 点该子组作用域的入口（`formal` 时是「正式流程」）。
 * 两条路径的入口都住在 `opacity-0 pointer-events-none` + `group-hover:pointer-events-auto` 的容器里，
 * 所以必须先 hover 它的宿主让容器可点；否则真实鼠标事件会落到宿主（项目行 = 折叠开关）上。
 */
async function createMekaDraft(session, projectName, { formal = false, fresh = false } = {}) {
  // `navigate('/cc-agent/new', …)` 在**已经在**该路由时不会重挂载 NewMakerDraftRoute，
  // 其 `useState` 里已选的项目/角色会保留（见 WL-11.8）。要验证「新建草稿的默认角色」
  // 就必须先离开该路由，逼出一次真正的挂载。
  if (fresh) {
    await session.evaluate(`location.hash = '#/cc-agent/meka'`);
    await sleep(1400);
  }
  const detected = await resolveMekaProjectLayout(session, projectName);
  if (!detected.ok) return detected;
  const { layout, projectLabel } = detected;
  if (layout === 'flat' && formal) {
    return {
      ok: false,
      reason: `项目 ${projectLabel} 是扁平布局（未启用正式工作流），不存在`
        + `「${mekaEntryLabel('formal', projectLabel)}」入口`,
      projectLabel,
      layout,
    };
  }
  const entryKind = layout === 'flat' ? 'flat' : formal ? 'formal' : 'regular';
  const hostLabel = layout === 'flat' ? null : MEKA_SUBGROUP_LABELS[formal ? 0 : 1];
  const hostExpr = layout === 'flat' ? projectRow(projectName) : subgroupHeader(hostLabel);
  const host = await session.boxOf(hostExpr);
  if (!host) {
    return {
      ok: false,
      reason: layout === 'flat'
        ? `未找到项目行「${projectLabel}」（无法 hover 出项目级新建入口）`
        : `未找到子组头「${hostLabel}」`,
      projectLabel,
      layout,
    };
  }
  // 创建按钮在 hover 显现的容器里，必须先 hover 宿主再用真实鼠标点。
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: host.x,
    y: host.y,
    buttons: 0,
  });
  await sleep(700);
  const label = mekaEntryLabel(entryKind, projectLabel);
  const box = await session.boxOf(BY_LABEL(label));
  if (!box) {
    return {
      ok: false,
      reason: `未找到${layout === 'flat' ? '挂在项目行上的项目级' : '子组头作用域'}创建入口「${label}」`
        + `（项目组容器内与「新建」有关的 aria-label=${JSON.stringify(detected.signals.entryLabels)}）`,
      projectLabel,
      layout,
    };
  }
  await session.clickAt(box);
  await sleep(2400);
  return { ok: true, projectLabel, layout, entryLabel: label, signals: detected.signals };
}

async function sendMessage(session, text) {
  const editor = await session.boxOf(`document.querySelector('[contenteditable="true"]')`);
  if (!editor) return false;
  await session.clickAt(editor);
  await sleep(400);
  await session.send('Input.insertText', { text });
  await sleep(600);
  const box = await session.boxOf(`[...document.querySelectorAll('button')].find((b) => /发送/.test(b.getAttribute('aria-label') || ''))`);
  if (!box) return false;
  await session.clickAt(box);
  return true;
}

function buildChecks(ctx) {
  const { options } = ctx;
  return [
    {
      id: 'WL-3.2',
      name: '侧栏 Meka 项目树按该项目配置断言布局契约（无正式工作流=扁平；启用=正式/普通两子组）',
      async run() {
        // dry-run 不是只读：本检查要改 hash 并派发真实鼠标事件（展开侧栏 Meka 项目树、hover
        // 入口宿主、点开项目作用域的新建入口），因此 dry-run 下**不执行**，登记为 UNVERIFIED，
        // 绝不伪造 PASS。
        if (options.dryRun) {
          return ctx.unverified('--dry-run：未执行（跳过侧栏导航与项目树的真实鼠标点击/新建入口点击）');
        }
        const { project } = ctx.catalog;
        await ctx.session.evaluate(`location.hash = '#/cc-agent/new'`);
        await sleep(1600);
        const text = await ctx.session.evaluate(sidebarText);
        if (!text.includes('Meka')) return ctx.fail(`侧栏缺少 Meka 分区：${text.slice(0, 200)}`);
        if (!text.toLowerCase().includes(project.name.toLowerCase())) {
          return ctx.fail(`侧栏缺少项目「${project.name}」：${text.slice(0, 300)}`);
        }
        // 布局是**运行期探测**出来的（`resolveMekaProjectLayout`：子组头 + 三种入口的挂载点），
        // 然后断言**该布局**的完整契约——两条分支的断言同等硬，扁平分支**不**是「只要建得出草稿
        // 就算过」：它必须显式证明子组头**不**在场，并且新建入口确实挂在**项目行**上。
        const detected = await resolveMekaProjectLayout(ctx.session, project.name);
        if (!detected.ok) return ctx.fail(detected.reason);
        const { signals } = detected;
        const label = signals.projectLabel;
        const problems = [];
        if (detected.layout === 'flat') {
          // ── 扁平契约（`formalWorkflowEnabled: false` 的项目，例如随包 saga2）─────────────
          if (signals.headerLabels.length) {
            problems.push(
              `扁平布局（项目未启用正式工作流）不应渲染子组头，实际渲染=${JSON.stringify(signals.headerLabels)}`,
            );
          }
          if (signals.treeNodeCount !== 1) {
            problems.push(
              '扁平布局的项目子树只应有项目行 1 个树节点（[role=button] 且不在会话行内），'
                + `实际 ${signals.treeNodeCount} 个=${JSON.stringify(signals.treeNodeLabels)}`,
            );
          }
          if (!signals.flatEntryOnRow) {
            problems.push(`项目行上没有项目级新建入口「${mekaEntryLabel('flat', label)}」`);
          }
          if (signals.regularEntryOnHeader || signals.formalEntryOnHeader) {
            problems.push('扁平布局不应存在子组头作用域的创建入口');
          }
          if (signals.sessionRowsInSubgroups) {
            problems.push(
              `有 ${signals.sessionRowsInSubgroups} 行会话落在子组容器里（扁平布局应直挂项目行下）`,
            );
          }
        } else {
          // ── 两子组契约（正式工作流启用）──────────────────────────────────────────────
          for (const subgroupLabel of MEKA_SUBGROUP_LABELS) {
            if (!signals.headerLabels.includes(subgroupLabel)) {
              problems.push(`两子组布局缺少子组头「${subgroupLabel}」`);
            }
          }
          if (signals.treeNodeCount !== 3) {
            problems.push(
              '两子组布局的项目子树应有项目行 + 两个子组头共 3 个树节点（[role=button] 且不在会话行内），'
                + `实际 ${signals.treeNodeCount} 个=${JSON.stringify(signals.treeNodeLabels)}`,
            );
          }
          if (signals.flatEntryOnRow) {
            problems.push('两子组布局不应把项目级新建入口挂在项目行上');
          }
          if (!signals.regularEntryOnHeader) {
            problems.push(
              `子组头「${MEKA_SUBGROUP_LABELS[1]}」上没有创建入口「${mekaEntryLabel('regular', label)}」`,
            );
          }
          if (!signals.formalEntryOnHeader) {
            problems.push(
              `子组头「${MEKA_SUBGROUP_LABELS[0]}」上没有创建入口「${mekaEntryLabel('formal', label)}」`,
            );
          }
          // 与扁平分支对称的**放置**断言：两子组布局下所有会话行都应落在某个子组容器里（正式流程 /
          // 普通对话），不应有会话直挂项目行——`:477-529` 分支里 `renderSessions()` 只作为两个
          // `MekaSessionSubgroup` 的子节点调用。
          const rowsOutsideSubgroups = signals.sessionRowCount - signals.sessionRowsInSubgroups;
          if (rowsOutsideSubgroups > 0) {
            problems.push(
              `两子组布局里有 ${rowsOutsideSubgroups} 行会话没落在任何子组容器里`
                + `（应挂在「${MEKA_SUBGROUP_LABELS[0]}」/「${MEKA_SUBGROUP_LABELS[1]}」子组下）`,
            );
          }
        }
        if (problems.length) return ctx.fail(problems.join('；'));
        // 结构断言通过后还要证明该入口**真的可用**：真实点击建出草稿（`fresh` 逼出重挂载）。
        const draft = await createMekaDraft(ctx.session, project.name, { fresh: true });
        if (!draft.ok) return ctx.fail(draft.reason);
        if (draft.layout !== detected.layout) {
          return ctx.fail(
            `项目树布局在结构断言与点击之间发生了变化：${detected.layout} → ${draft.layout}`,
          );
        }
        // 入口必须**在 DOM 里**（点得到）而不只是「曾经点过一次」：扁平布局的入口挂在项目行上，
        // 项目行折叠时这段子树可能整个不渲染，所以先确保项目树可见，再读一次——这条断言因此
        // 核对的是「入口在场」，而不是「此刻恰好是展开态」。
        await ensureMekaTreeVisible(ctx.session, project.name);
        const entries = await ctx.session.evaluate(
          `[...document.querySelectorAll('button')]
             .map((b) => b.getAttribute('aria-label') || '')
             .filter((a) => a.includes('新建') && a.includes(${JSON.stringify(draft.projectLabel)}))`,
        );
        if (!entries.length) return ctx.fail('项目作用域的新建入口不可见');
        const structureEvidence = detected.layout === 'flat'
          ? '扁平（无子组头；项目级入口挂在项目行上；'
            + `会话行 ${signals.sessionRowCount} 行直挂项目行下、落在子组容器里 ${signals.sessionRowsInSubgroups} 行）`
          : `两子组（子组头=${JSON.stringify(signals.headerLabels)}；正式/普通入口各挂自己子组头；`
            + `会话行 ${signals.sessionRowCount} 行全在子组容器里）`;
        return ctx.pass(
          `布局=${structureEvidence}；项目=${label}；树节点=${JSON.stringify(signals.treeNodeLabels)}；`
            + `点击入口=${draft.entryLabel}；新建入口=${JSON.stringify(entries)}`,
        );
      },
    },
    {
      id: 'WL-11.1',
      name: '从项目入口新建的草稿（真实重挂载）绑定到该项目与该项目的默认角色',
      async run() {
        // dry-run 不是只读：`createMekaDraft()` 会改 hash 并派发真实鼠标事件（fresh 重挂载 +
        // 新建入口点击），因此 dry-run 下**不执行**，登记为 UNVERIFIED。
        if (options.dryRun) {
          return ctx.unverified('--dry-run：未执行（跳过新建草稿所需的真实鼠标点击）');
        }
        const { project, roles } = ctx.catalog;
        // 入口是**该布局**规定的那一个（扁平 = 项目行上的项目级入口；两子组 =「普通对话」子组头上的
        // 入口），由 `createMekaDraft()` 自己探测决定，不再假定存在子组头（2026-09-29 布局修复）。
        const draft = await createMekaDraft(ctx.session, project.name, { fresh: true });
        if (!draft.ok) return ctx.fail(draft.reason);
        const chip = await ctx.session.evaluate(`${BY_LABEL(ROLE_PICKER)}?.textContent?.trim() ?? null`);
        if (!chip) return ctx.fail('草稿里没有角色选择器（未绑定 Meka 项目/角色）');
        // 断言的是「共享默认角色」这个身份，而不是「列表第一项」：应用侧由
        // `pickDefaultMekaRole()` 显式选中 `<projectId>-default-role`，排序只是附带结果。
        // 按位置断言会在排序被任何写入路径归一化时误红，且失败信息指错方向。
        // 2026-09-23 契约反转不改变这条「默认选中项」语义：变的只是这个角色的注入契约
        // （出厂即全量），它仍然是新建草稿的默认角色、仍然只读且不可删除。
        const defaultRole = roles.find((role) => isSharedDefaultRole(role, project.id));
        if (!defaultRole) {
          return ctx.fail(`项目 ${project.id} 库里没有共享默认角色 ${project.id}${MEKA_DEFAULT_ROLE_ID_SUFFIX}`);
        }
        if (chip !== defaultRole.displayName) {
          return ctx.fail(`草稿默认角色应为共享默认角色=${defaultRole.displayName}，实际=${chip}`);
        }
        const scope = await ctx.session.evaluate(
          `(() => { const m = document.querySelector('main') || document.body; return (m.innerText || '').replace(/\\n+/g, ' | ').slice(0, 200); })()`,
        );
        if (!scope.toLowerCase().includes(project.name.toLowerCase())) {
          return ctx.fail(`草稿未显示项目 ${project.name}：${scope}`);
        }
        ctx.projectLabel = draft.projectLabel ?? project.name;
        // 「草稿默认角色 = 共享默认角色」是本轮契约反转后的**新期望**，写脚本时未实跑——这条信息
        // 只留在注释里，不进 PASS 证据串：真实跑完后输出不应再声称「待实跑」。
        return ctx.pass(
          `项目=${ctx.projectLabel} 默认角色=${chip}（布局=${draft.layout}，新建入口=${draft.entryLabel}）`,
        );
      },
    },
    {
      id: 'WL-11.2',
      name: '角色选择器列出该项目全部角色（随包内置阵容 = 该项目共享默认角色），且切换后草稿角色随之变化',
      async run() {
        // dry-run 不是只读：本检查要开角色弹层、点选项切换角色（真实鼠标事件），因此 dry-run 下
        // **不执行**，登记为 UNVERIFIED。
        if (options.dryRun) {
          return ctx.unverified('--dry-run：未执行（跳过角色选择器的真实鼠标点击与角色切换）');
        }
        const { project, roles } = ctx.catalog;
        const defaultRole = defaultRoleOf(ctx.catalog);
        const problems = [];
        // 显示名是选择器里唯一的身份信号（选项按钮不带 id），所以显示名必须唯一，
        // 否则「显示名 → 角色」的映射本身不可信，后面的比对全部无意义。
        const duplicatedName = roles
          .map((role) => role.displayName)
          .find((name, index, all) => all.indexOf(name) !== index);
        if (duplicatedName) {
          problems.push(`项目 ${project.id} 的角色显示名不唯一（「${duplicatedName}」），无法按显示名做身份判定`);
        }
        // 角色选择器在**草稿路由**里（`NewMakerDraftRoute.tsx` 的 `MekaRolePicker`），与侧栏布局无关，
        // 因此 2026-09-29 的布局修复**不需要**改这里的打开方式（已按源码核对）：
        // 触发器 = `button[aria-label=meka.projectsRoles.rolePicker]`（:620-624）；弹层列表 =
        // `[role=listbox][aria-label=…] [role=option]`（:659-669）；选项里第一段 span 才是显示名（:679）。
        // 项目级入口与「普通对话」子组入口走的是**同一条** `onCreateRegular` →
        // `navigate('/cc-agent/new', { state: { …makeNewMakerRouteState('meka'), mekaProjectId } })`
        // （`CCAgentSidebarUpper.tsx:2607`），所以两条布局下的草稿形态完全一致。
        await ctx.session.clickAt(await ctx.session.boxOf(BY_LABEL(ROLE_PICKER)));
        await sleep(900);
        // 只读选项里的**第一段 span**（显示名）；`textContent` 会把描述也拼进来。
        const optionNames = await ctx.session.evaluate(
          `[...document.querySelectorAll(${JSON.stringify(ROLE_OPTION_LIST)})].map((o) => ${ROLE_OPTION_NAME_EXPR})`,
        );
        const uiNames = (optionNames ?? []).filter((name) => typeof name === 'string' && name);
        if (!uiNames.length) {
          await ctx.session.pressEscape().catch(() => {});
          return ctx.fail('角色选择器里没有渲染出任何选项（弹层未打开，或该项目角色没加载出来）');
        }
        const dbNames = roles.map((role) => role.displayName);
        const sortKey = (list) => [...list].sort().join('\u0000');
        if (uiNames.length !== dbNames.length || sortKey(uiNames) !== sortKey(dbNames)) {
          problems.push(`选择器选项=${JSON.stringify(uiNames)}，库里角色=${JSON.stringify(dbNames)}`);
        }
        // 「共享默认角色排第一」是可见的排序保证（sort_order = -1），但断言对象是**身份**：
        // 第一位必须就是 `pickDefaultMekaRole()` 会选中的那个角色，而不是「恰好第一项」。
        if (uiNames[0] !== defaultRole.displayName) {
          problems.push(
            `角色列表第一位应为共享默认角色「${defaultRole.displayName}」(sort_order=-1 的可见保证)，实际第一位=「${uiNames[0]}」`,
          );
        }
        // 内置阵容：随包**只声明每个项目一个共享默认角色**（`BUILTIN_MEKA_ROLES` 现在只剩它）。
        // 存量库里可能另有随包清单已被删除的遗留内置行——`combat-development` 是
        // `RETIRED_BUILTIN_MEKA_ROLE_MAPPINGS` 的**重绑目标**（不是退役 id），播种刻意不删它，
        // 读取时由 T2 回落该项目默认角色（白名单 WL-20）。所以这里**不能**用「内置集合恰等于
        // [默认角色]」：那会在升级库上假红。判据取「该 id 是否还有随包清单文件」：
        // ① 共享默认角色必须在场；② 其余内置行必须**已无**随包清单（= 清单已删的孤儿行）。
        // 随包一旦重新提供某角色的清单文件，这条期望就会要求它被显式登记，否则报出来。
        const builtinRoleIds = roles
          .filter((role) => role.isBuiltin)
          .map((role) => role.id)
          .sort();
        const defaultRoleId = `${project.id}${MEKA_DEFAULT_ROLE_ID_SUFFIX}`;
        if (!builtinRoleIds.includes(defaultRoleId)) {
          problems.push(
            `项目 ${project.id} 没有共享默认角色行 ${defaultRoleId}（内置阵容=${JSON.stringify(builtinRoleIds)}）`,
          );
        }
        const unexpectedBuiltinRoleIds = builtinRoleIds.filter(
          (id) =>
            id !== defaultRoleId &&
            fs.existsSync(path.join(BUNDLED_MEKA_ROLES_DIR, `${id}.json`)),
        );
        if (unexpectedBuiltinRoleIds.length) {
          problems.push(
            `项目 ${project.id} 有「随包清单仍在、但脚本未登记」的内置角色行：`
              + `${JSON.stringify(unexpectedBuiltinRoleIds)}`
              + `（期望 = 共享默认角色 ${defaultRoleId} ∪ 随包清单已删除的遗留行）`,
          );
        }
        // 脚本手抄的 id 结构自检：随包项目 saga2 的默认角色 id 必须逐字等于 `DEFAULT_ROLE_ID`。
        // 漂移时 `isSharedDefaultRole()` 会静默认为「这个项目没有默认角色」，把整串默认角色检查
        // 降级成「环境不满足」——看起来像环境问题，其实是脚本过期。
        if (
          project.id === SAGA2_PROJECT_ID &&
          !roles.some((role) => role.id === DEFAULT_ROLE_ID)
        ) {
          problems.push(
            `随包项目 ${SAGA2_PROJECT_ID} 的角色里没有脚本常量 ${DEFAULT_ROLE_ID}`
              + `（实际=${JSON.stringify(roles.map((role) => role.id))}）：脚本手抄的默认角色 id 结构可能已过期`,
          );
        }
        const retiredVisible = roles.filter((role) => RETIRED_BUILTIN_ROLE_IDS.includes(role.id));
        if (retiredVisible.length) {
          problems.push(
            `项目角色列表里仍有已退役内置角色：${retiredVisible.map((role) => `${role.id}(${role.displayName})`).join('、')}`,
          );
        }
        if (problems.length) {
          // 失败时仍然开着弹层，会挡住后面检查要点的编辑器，所以先关掉再返回。
          await ctx.session.pressEscape().catch(() => {});
          return ctx.fail(problems.join('；'));
        }
        // 切换目标按**身份**取：共享默认角色之外的第一个角色（通常是项目自有角色；存量库里也可能
        // 是遗留的 `combat-development` 孤儿行）。项目只有共享默认角色时**没有可切换对象** ——
        // 这时必须登记 UNVERIFIED 并先关掉弹层：切到默认角色本身会让「切换后 chip 变化」变成同值
        // 比较而恒真（假通过），而留着的弹层会挡住后面检查要点的编辑器。
        const target = switchTargetRoleOf(ctx.catalog);
        if (!target) {
          await ctx.session.pressEscape().catch(() => {});
          return ctx.unverified(
            `项目 ${project.id} 只有共享默认角色 ${defaultRoleId}（随包已不再提供第二个内置角色）：`
              + '已核对选项清单/排序/退役 id 与内置阵容，未验证「切换后草稿角色随之变化」',
          );
        }
        // 弹层在读选项时就已经打开，这里**直接点选项**（再点一次触发器会把它 toggle 关闭）。
        const clicked = await ctx.session.clickAt(
          await ctx.session.boxOf(roleOptionByName(target.displayName)),
        );
        if (!clicked) return ctx.fail(`未能选中角色「${target.displayName}」(${target.id})`);
        await sleep(900);
        const chip = await ctx.session.evaluate(`${BY_LABEL(ROLE_PICKER)}?.textContent?.trim() ?? null`);
        if (chip !== target.displayName) {
          return ctx.fail(`切换后角色 chip 应为「${target.displayName}」(${target.id})，实际=${chip}`);
        }
        // 切回本次要建会话的角色，让 WL-11.3/11.5/11.6 的会话角色由身份决定（默认 = 共享默认角色，
        // 即 `--role` 的新语义），而不是由上一个检查恰好留下了谁决定。
        const wanted = ctx.sessionRole;
        if (wanted.id !== target.id) {
          await ctx.session.clickAt(await ctx.session.boxOf(BY_LABEL(ROLE_PICKER)));
          await sleep(900);
          await ctx.session.clickAt(await ctx.session.boxOf(roleOptionByName(wanted.displayName)));
          await sleep(900);
          const restored = await ctx.session.evaluate(`${BY_LABEL(ROLE_PICKER)}?.textContent?.trim() ?? null`);
          if (restored !== wanted.displayName) {
            return ctx.fail(`未能把草稿角色切回本次要用的「${wanted.displayName}」(${wanted.id})，实际=${restored}`);
          }
        }
        // 期望值（选项与库里角色一一对应、共享默认角色排第一、切换按身份生效）是本轮契约反转后的
        // **新期望**，写脚本时未实跑——这条信息只留在注释里，不进 PASS 证据串。
        return ctx.pass(
          `选项=${JSON.stringify(uiNames)}（第一位=${uiNames[0]}，内置阵容=${builtinRoleIds.join(',')}）；`
            + `切到「${target.displayName}」(${target.id}) 生效；会话角色=${wanted.displayName}(${wanted.id})`
            + `${options.role ? `（--role=${options.role}）` : '（默认路径：共享默认角色）'}`,
        );
      },
    },
    {
      id: 'WL-11.3',
      name: '发送后会话行绑定项目/角色，工作目录解析到项目路径，且为普通会话',
      async run() {
        if (options.dryRun) return ctx.unverified('--dry-run：跳过建会话');
        const { project } = ctx.catalog;
        ctx.beforeIds = new Set(ctx.dbIds());
        if (!(await sendMessage(ctx.session, MESSAGE))) return ctx.fail('未能发送消息');
        let row = null;
        for (let i = 0; i < SESSION_TIMEOUT_MS / 1500 && !row; i += 1) {
          await sleep(1500);
          row = ctx.sessionRow((r) => !ctx.beforeIds.has(r.id));
        }
        if (!row) return ctx.fail('超时未见新会话落库');
        ctx.row = row;
        const problems = [];
        if (row.workspace_kind !== 'meka') problems.push(`workspace_kind=${row.workspace_kind}`);
        if (row.meka_project_id !== project.id) problems.push(`meka_project_id=${row.meka_project_id}`);
        // 角色身份来自 `ctx.sessionRole`（WL-11.2 结束时选择器上真实选中的那个角色），
        // 不再用「列表第二项」这类位置假设。
        const expectedRole = ctx.sessionRole.id;
        if (row.meka_role_id !== expectedRole) problems.push(`meka_role_id=${row.meka_role_id}≠${expectedRole}`);
        if (row.is_formal !== 0) problems.push(`is_formal=${row.is_formal}`);
        // 工作目录必须解析成真实存在的绝对路径（只断言非空会漏掉「路径没解析出来」）。
        if (!row.working_dir || !path.isAbsolute(row.working_dir) || !fs.existsSync(row.working_dir)) {
          problems.push(`working_dir=${row.working_dir}`);
        }
        if (problems.length) return ctx.fail(`会话绑定异常：${problems.join('；')}`);
        return ctx.pass(
          `session=${row.id} workspace_kind=${row.workspace_kind} project=${row.meka_project_id} role=${row.meka_role_id} is_formal=${row.is_formal} workdir=${row.working_dir}`,
        );
      },
    },
    {
      id: 'WL-11.4',
      name: 'Agent 真实跑完一轮并产出回复（Meka 会话可正常对话）',
      async run() {
        if (options.dryRun) return ctx.unverified('--dry-run：跳过真实运行');
        if (!ctx.row) return ctx.fail('前置失败：没有新会话');
        const before = ctx.assistantCount(ctx.row.id);
        let reply = null;
        for (let i = 0; i < REPLY_TIMEOUT_MS / 3000; i += 1) {
          await sleep(3000);
          if (ctx.assistantCount(ctx.row.id) <= before) continue;
          reply = ctx.lastAssistant(ctx.row.id);
          if (reply) break;
        }
        if (!reply) return ctx.fail('超时未见 Agent 回复');
        ctx.reply = reply;
        return ctx.pass(`回复=${JSON.stringify(String(reply).slice(0, 60))}`);
      },
    },
    {
      id: 'WL-11.5',
      name: '角色上下文注入运行期：会话能回显 [MEKA_ROLE_CONTEXT] 的 projectId/roleId/displayName',
      async run() {
        if (options.dryRun) return ctx.unverified('--dry-run：跳过真实运行');
        if (!ctx.row) return ctx.fail('前置失败：没有新会话');
        const { project } = ctx.catalog;
        // 角色身份来自 `ctx.sessionRole`（WL-11.2 结束时的选择器状态），不用位置假设，也不按
        // 显示名回查（显示名可能对应到别的角色）。
        const role = ctx.sessionRole;
        const before = ctx.assistantCount(ctx.row.id);
        await ctx.session.evaluate(`location.hash = '#/cc-agent/${ctx.row.id}'`);
        await sleep(2500);
        if (!(await sendMessage(ctx.session, ROLE_CONTEXT_MESSAGE))) return ctx.fail('未能发送角色上下文探针');
        let reply = null;
        for (let i = 0; i < REPLY_TIMEOUT_MS / 3000; i += 1) {
          await sleep(3000);
          if (ctx.assistantCount(ctx.row.id) <= before) continue;
          reply = ctx.lastAssistant(ctx.row.id);
          if (reply) break;
        }
        if (!reply) return ctx.fail('超时未见角色上下文回显');
        const text = String(reply);
        // 硬断言只放**不可翻译的标识符**：`roleId` 是 Meka 内部 id，工作目录与任何项目文件里
        // 都没有它，只能来自注入的角色上下文。`displayName` 不能当硬断言——实测模型会按输出
        // 语言**改写**它（2026-09-14 实测：`战斗开发` → `Combat Development`；同一行为对
        // `默认角色` 这类显示名同样适用），那是模型行为而非注入缺陷。
        // 字面标记行同样只是附加证据（模型可能省略排版）。
        const displayNameActual = /displayName:\s*([^\n]*)/.exec(text)?.[1]?.trim() ?? null;
        const missing = [];
        if (!new RegExp(`projectId:\\s*${project.id}\\b`).test(text)) missing.push(`projectId=${project.id}`);
        if (!new RegExp(`roleId:\\s*${role.id}\\b`).test(text)) missing.push(`roleId=${role.id}`);
        if (!displayNameActual) missing.push('displayName 字段行');
        if (missing.length) {
          return ctx.fail(`角色上下文注入缺失：${missing.join('、')}；回显=${JSON.stringify(text.slice(0, 300))}`);
        }
        const marker = /\[MEKA_ROLE_CONTEXT\]/.test(text);
        const verbatim = displayNameActual === role.displayName;
        return ctx.pass(
          `回显含 projectId=${project.id} roleId=${role.id} displayName=${JSON.stringify(displayNameActual)}`
            + `${verbatim ? '（与清单一致）' : `（清单为「${role.displayName}」，模型按输出语言改写了该值——不影响身份判定）`}`
            + `${marker ? '；含字面标记行' : '；模型省略了字面标记行'}`,
        );
      },
    },
    {
      id: 'WL-11.6',
      name: '运行期配置按角色解析：默认角色出厂全量（无 workflow 字段、吸收项目默认 MCP/技能）或角色声明生效',
      async run() {
        if (options.dryRun) return ctx.unverified('--dry-run：跳过真实运行');
        if (!ctx.row) return ctx.fail('前置失败：没有新会话');
        const role = ctx.sessionRole;
        const sharedDefault = isSharedDefaultRole(role, ctx.catalog.project.id);
        // 共享「默认角色」没有包内清单文件（清单由 `mekaDefaultRoleManifest()` 内存生成、从不落盘），
        // 所以**默认角色分支根本不问文件**：随包 `resources/meka/roles/` 已整体删除，
        // `declaredRoleSkills()` 现在只承担「用户自有角色在用户目录 `meka-roles/<id>.json` 的声明」
        // 这一种来源。缺清单**不再**意味着「零注入」：2026-09-23 起默认角色的契约是**出厂即全量**
        // ——吸收项目 `roleDefaults`（promptFramework + 默认 skills + 默认 MCP + 默认元数据选择）
        // 与项目全部 enabled 元数据（`includeAllProjectMetadata`）。
        const declared = sharedDefault ? null : declaredRoleSkills(role, options.userDataDir);
        const config = runtimeConfigFromLog(ctx.logDir, ctx.row.id);
        if (!config) return ctx.fail(`日志里找不到该会话的 Meka 运行期配置（${ctx.logDir}）`);
        if (config.projectId !== ctx.catalog.project.id) {
          return ctx.fail(`运行期 projectId=${config.projectId}，期望 ${ctx.catalog.project.id}`);
        }
        if (config.roleId !== role.id) return ctx.fail(`运行期 roleId=${config.roleId}，期望 ${role.id}`);
        const problems = [];
        // 「读不到」与「不满足」必须分开：读不到时把相关断言降级为 UNVERIFIED，
        // 绝不把「没查成」写成「符合」。
        const unknowns = [];

        // ── 与角色无关的平台不变量（Host 对**每个**普通 Meka 任务都保证）─────────────────
        // 平台基线（`mergePlatformMcp`）必须仍然在场。
        for (const platformId of PLATFORM_MCP_PROVIDER_IDS) {
          if (!config.mcpProviderIds.includes(platformId)) {
            problems.push(`平台 MCP ${platformId} 未进入运行期（实际 ${config.mcpProviderIds.join(',')}）`);
          }
        }
        // 红线：运行期配置里**根本不存在** `workflow` 键。判据刻意是「键不存在」而不是「取到的值
        // 为 null」：workflow 机制已整体删除（`MekaRuntimeConfig` 上没有该字段，main 日志的
        // 「Meka runtime config applied before session start」块也不再投递它），旧的
        // `config.workflow !== null` 依赖 `pick('workflow')`（恒为 null）⇒ **永远不可能失败**，
        // 是假通过。改成键名断言后，生产侧一旦重新投递该键（哪怕值是 null）立刻变红。
        if (config.keys.includes('workflow')) {
          problems.push(
            '运行期配置块重新出现了 `workflow` 键（workflow 机制已整体删除，'
              + '`MekaRuntimeConfig` 上不应再有任何 workflow 生产者）',
          );
        }
        // 技能快照：revision 必须与运行期一致，且**随包平台 Skill** 必须在快照里。
        const snapshot = skillDirsForSession(options.userDataDir, ctx.row.id);
        if (!snapshot) {
          // 只有平台技能也为空时才允许没有快照；平台技能存在却缺快照是真实缺陷
          // （平台技能必须被冻结进该任务的不可变快照）。
          if (config.platformSkillsCount > 0) {
            problems.push(`平台技能 ${config.platformSkillsCount} 个存在，但该会话没有技能快照`);
          }
        } else {
          if (snapshot.revision !== config.skillRevision) {
            problems.push(`快照 revision=${snapshot.revision}≠运行期 ${config.skillRevision}`);
          }
          // 随包 Skill 只剩 `platform-capabilities`（9 个业务 Skill 已删除）。原「角色清单声明的
          // 技能必须在快照里」那条断言的声明源已不存在（随包角色清单目录已删），存活形态就是这条：
          // **平台 Skill 必须真的进了本次任务的快照**。它比 `platformSkillsCount > 0` 更硬——
          // 数量对不上号照样能过那条计数断言。
          const missingPlatformSkills = PLATFORM_SKILL_IDS.filter(
            (skillId) => !snapshot.skills.includes(skillId),
          );
          if (missingPlatformSkills.length) {
            problems.push(
              `随包平台技能不在该会话快照里：${missingPlatformSkills.join('、')}（快照=${snapshot.skills.join(',')}）`,
            );
          }
          ctx.snapshotSkills = snapshot.skills;
        }

        // ── 角色侧的声明核对 ─────────────────────────────────────────────────────────
        if (sharedDefault) {
          // ── 默认角色的**新契约**（新期望，待实跑）────────────────────────────────
          // 旧口径（`skillsCount === platformSkillsCount`、平台基线外 MCP 必须为空、
          // 快照技能数 === platformSkillsCount）断言的是「刻意零注入」，随职能合并已作废：
          // 它现在承接原「通用开发」的职能，注入内容必须**明显多于**平台基线。
          //
          // 默认角色内存清单**自己 pin 的 MCP** 必须生效——这是原「包内角色清单声明的 MCP 生效」
          // 那条断言在随包清单删除后的存活形态（原靶子是已删除的 `combat-development.json` 的
          // `mcp` 列表）。
          for (const providerId of DEFAULT_ROLE_MCP_PROVIDER_IDS) {
            if (!config.mcpProviderIds.includes(providerId)) {
              problems.push(
                `默认角色清单 pin 的 MCP ${providerId} 未进入运行期（实际 ${config.mcpProviderIds.join(',')}）`,
              );
            }
          }
          const contributions = projectContributionsOf(ctx);
          if (!contributions) {
            unknowns.push(
              '读不到项目配置（项目根 .meka/project.json 与包内 resources/meka/projects/<id>/project.json 都不可解析），'
                + '无法逐项核对默认角色吸收的 roleDefaults MCP / 默认技能 / 全量元数据',
            );
            if (config.skillsCount < config.platformSkillsCount) {
              problems.push(
                `skillsCount=${config.skillsCount} 小于 platformSkillsCount=${config.platformSkillsCount}`,
              );
            }
          } else {
            // 项目 `roleDefaults.mcp`（saga2 = project-agent）必须被默认角色吸收。
            for (const providerId of contributions.mcpProviderIds) {
              if (!config.mcpProviderIds.includes(providerId)) {
                problems.push(
                  `项目 roleDefaults 的 MCP ${providerId} 未进入默认角色运行期（实际 ${config.mcpProviderIds.join(',')}）`,
                );
              }
            }
            const expectedExtraSkills =
              contributions.skillIds.length + contributions.enabledSkillMetadata;
            if (expectedExtraSkills > 0) {
              if (!(config.skillsCount > config.platformSkillsCount)) {
                problems.push(
                  `默认角色应吸收项目默认技能 ${contributions.skillIds.length} 个 + 项目 skill 元数据 `
                    + `${contributions.enabledSkillMetadata} 条：skillsCount=${config.skillsCount} `
                    + `未大于 platformSkillsCount=${config.platformSkillsCount}`,
                );
              }
            } else {
              unknowns.push(
                `项目配置（${contributions.file}）没有 roleDefaults 默认技能、也没有 enabled 的 skill 元数据，`
                  + '无法断言 skillsCount 增长（只核对了不小于平台基线）',
              );
              if (config.skillsCount < config.platformSkillsCount) {
                problems.push(
                  `skillsCount=${config.skillsCount} 小于 platformSkillsCount=${config.platformSkillsCount}`,
                );
              }
            }
            if (snapshot) {
              // 项目 `roleDefaults.skills` 是包内 catalog 的 skill id，必须逐个出现在该会话快照里
              // ——这比「数量大于平台基线」更硬：数量涨了但涨的是别的东西照样能过计数断言。
              const missingSkills = contributions.skillIds.filter(
                (skillId) => !snapshot.skills.includes(skillId),
              );
              if (missingSkills.length) {
                problems.push(
                  `项目默认技能不在该会话快照里：${missingSkills.join('、')}（快照=${snapshot.skills.join(',')}）`,
                );
              }
              if (
                contributions.enabledSkillMetadata > 0 &&
                snapshot.skills.length <= config.platformSkillsCount
              ) {
                problems.push(
                  `快照技能数=${snapshot.skills.length} 未超过平台基线 ${config.platformSkillsCount}`
                    + `（项目有 ${contributions.enabledSkillMetadata} 条 enabled 的 skill 元数据，应已注入）`,
                );
              }
            }
          }
        } else if (declared) {
          // 非默认角色（项目自有角色）：按**可读到的声明源**核对。随包清单目录已删除，声明现在只在
          // 用户目录的 `meka-roles/<id>.json`（`declaredRoleSkills()` 只返回这种来源）；
          // **不再比较 workflow**——角色清单与运行期两侧都没有该字段了，比它等于拿 null 比 null。
          for (const providerId of declared.mcp) {
            if (!config.mcpProviderIds.includes(providerId)) {
              problems.push(
                `角色声明的 MCP ${providerId} 未进入运行期（实际 ${config.mcpProviderIds.join(',')}）`,
              );
            }
          }
          if (snapshot) {
            for (const skillId of declared.skills) {
              if (!snapshot.skills.includes(skillId)) {
                problems.push(`角色声明的技能 ${skillId} 不在快照（${snapshot.skills.join(',')}）`);
              }
            }
          }
        } else {
          // 声明源不可读：① 内置的**孤儿行**（如存量库里的 `combat-development`，随包清单已删，
          // 读取时由 T2 回落该项目默认角色，而项目文件 `builtinRoles` 快照这条源脚本不读）；
          // ② 用户自有角色但用户目录下没有清单文件。两种都只核对上面那些与角色无关的平台不变量，
          // 其余登记 UNVERIFIED —— 既不伪造 PASS，也不把「没查成」写成 FAIL。
          unknowns.push(
            `读不到角色 ${role.id} 的声明（${
              role.isBuiltin
                ? '内置行：随包清单目录已删除，声明只可能在项目文件 builtinRoles 快照里（脚本不读该源）'
                : `用户自有行：用户目录下没有 meka-roles/${role.id}.json`
            }）：未核对角色声明的技能/MCP（平台不变量与快照 revision 照常核对）`,
          );
        }
        const branch = sharedDefault
          ? '分支=默认角色（出厂全量契约）'
          : declared
            ? `分支=角色声明（${declared.file}）`
            : '分支=声明源不可读（登记 UNVERIFIED）';
        const evidence =
          `${branch} roleId=${config.roleId} `
          + `workflow键=${config.keys.includes('workflow') ? '存在（违规）' : '不存在'} `
          + `mcp=${config.mcpProviderIds.join(',')} skillsCount=${config.skillsCount} `
          + `platformSkillsCount=${config.platformSkillsCount} 快照技能数=${(ctx.snapshotSkills ?? []).length}`;
        if (problems.length) return ctx.fail(`${problems.join('；')}（${evidence}）`);
        if (unknowns.length) return ctx.unverified(`${unknowns.join('；')}（${evidence}）`);
        // 这里的期望值（默认角色出厂全量）是本轮新契约，写脚本时未实跑——这条信息只留在注释里，
        // 不进 PASS 证据串。
        return ctx.pass(evidence);
      },
    },
    {
      id: 'WL-11.7',
      name: '新会话归属 Meka 分区下该项目子树，而非普通「对话」分组',
      async run() {
        if (options.dryRun) return ctx.unverified('--dry-run：跳过建会话');
        if (!ctx.row) return ctx.fail('前置失败：没有新会话');
        const { project } = ctx.catalog;
        // 标题是自动生成的，可能在落库后又被改写；按 id 重读当前值，避免拿过期标题找行。
        const title = ctx.sessionRow((r) => r.id === ctx.row.id)?.title ?? ctx.row.title;
        // 只验侧栏归属，所以停在草稿路由即可（侧栏在所有 cc-agent 路由下都渲染），
        // 并先把 Meka 段与项目行展开——折叠状态下会话行根本不在 DOM 里。
        await ensureMekaTreeVisible(ctx.session, project.name);
        // 侧栏列表是事件驱动刷新，单次读取会偶发读空；轮询等它出现。
        const readVerdict = `(() => {
          const nodes = [...document.querySelectorAll('aside *')].filter((el) =>
            (el.textContent || '').includes(${JSON.stringify(title)}));
          if (!nodes.length) return null;
          const row = nodes.reduce((a, b) => ((a.textContent || '').length <= (b.textContent || '').length ? a : b));
          const projectRow = ${projectRow(project.name)};
          if (!projectRow) return { error: 'no-project-row' };
          const inProject = projectRow.parentElement.contains(row);
          const mainHeader = [...document.querySelectorAll('aside [role=button]')]
            .find((e) => (e.textContent || '').trim() === '对话');
          const inMainDialogueGroup = mainHeader ? mainHeader.parentElement.contains(row) : null;
          return { inProject, inMainDialogueGroup, hasMainHeader: !!mainHeader };
        })()`;
        let verdict = null;
        for (let i = 0; i < 12 && !verdict; i += 1) {
          verdict = await ctx.session.evaluate(readVerdict);
          if (!verdict) await sleep(1500);
        }
        if (!verdict) {
          return ctx.fail(`等待 18s 后侧栏仍未出现会话「${title}」`);
        }
        if (verdict.error) return ctx.fail(`侧栏归属判定失败：${verdict.error}`);
        if (!verdict.inProject) return ctx.fail(`会话「${title}」不在项目「${project.name}」容器内`);
        if (verdict.inMainDialogueGroup) {
          return ctx.fail(`会话「${title}」同时出现在普通「对话」分组内`);
        }
        const label = ctx.projectLabel ?? project.name;
        return ctx.pass(
          `会话「${title}」在项目「${label}」容器内；普通对话分组排除=${verdict.hasMainHeader ? '已核对' : '该侧栏无独立「对话」分组头，未核对'}`,
        );
      },
    },
    {
      id: 'WL-11.8',
      name: '同一项目内再次点击新建入口时保留当前草稿已选角色（已登记行为，非缺陷）',
      async run() {
        // dry-run 不是只读：本检查要真实切换角色并再次点击新建入口（`createMekaDraft()` 会改
        // hash + 派发鼠标事件），因此 dry-run 下**不执行**，登记为 UNVERIFIED。
        if (options.dryRun) {
          return ctx.unverified('--dry-run：未执行（跳过角色切换与重进项目入口的真实鼠标点击）');
        }
        const { project, roles } = ctx.catalog;
        if (roles.length < 2) {
          return ctx.unverified(
            `项目 ${project.id} 只有共享默认角色（随包已不再提供第二个内置角色），无法验证「重进保留已选角色」`,
          );
        }
        const draft = await createMekaDraft(ctx.session, project.name, { fresh: true });
        if (!draft.ok) return ctx.fail(draft.reason);
        // 切换目标按**身份**取（共享默认角色之外的第一个角色），不用 `roles[1]`：阵容从
        // 「默认角色/通用开发/战斗开发」收到「默认角色（+ 存量库里的孤儿内置行）」后，位置与角色的
        // 对应关系已经变了，位置假设会把这条检查悄悄指向别的角色（甚至指向默认角色本身，让
        // 「保留已选角色」变成同值比较而恒真）。
        const target = switchTargetRoleOf(ctx.catalog);
        if (!target) return ctx.unverified('该项目没有第二个可用于切换的角色，无法验证');
        await ctx.session.clickAt(await ctx.session.boxOf(BY_LABEL(ROLE_PICKER)));
        await sleep(900);
        await ctx.session.clickAt(await ctx.session.boxOf(roleOptionByName(target.displayName)));
        await sleep(900);
        const afterSwitch = await ctx.session.evaluate(`${BY_LABEL(ROLE_PICKER)}?.textContent?.trim() ?? null`);
        if (afterSwitch !== target.displayName) return ctx.fail(`切换角色失败：${afterSwitch}`);
        // 同路径再次点击项目新建入口：不离开路由 → NewMakerDraftRoute 不重挂载 → 已选角色保留。
        // 「同一入口」= **该布局**的入口（扁平 = 项目行上的项目级入口；两子组 =「普通对话」子组头上的
        // 入口），与上面那次 `createMekaDraft()` 一致，所以这条检查在两种布局下验的是同一个流程。
        const again = await createMekaDraft(ctx.session, project.name);
        if (!again.ok) return ctx.fail(again.reason);
        if (again.entryLabel !== draft.entryLabel) {
          return ctx.fail(`重进用的是另一个入口：${draft.entryLabel} → ${again.entryLabel}`);
        }
        const afterReenter = await ctx.session.evaluate(`${BY_LABEL(ROLE_PICKER)}?.textContent?.trim() ?? null`);
        if (afterReenter !== target.displayName) {
          return ctx.fail(`同一项目重进后应保留草稿已选角色「${target.displayName}」(${target.id})，实际=${afterReenter}`);
        }
        // 「fresh 默认 = 共享默认角色」同样是本轮反转后的**新期望**，写脚本时未实跑——信息留在注释里。
        return ctx.pass(
          `fresh 默认=「${defaultRoleOf(ctx.catalog).displayName}」；`
            + `切到「${target.displayName}」(${target.id}) 后用同一入口「${again.entryLabel}」`
            + `（布局=${again.layout}）重进仍为「${afterReenter}」（跨项目重进无第二个项目可验）`,
        );
      },
    },
    {
      id: 'WL-11.17',
      name: '项目参考清单段注入：只投递「作用范围 | 绝对路径 | 用途」，正文（Markdown 标题行）不内联',
      async run() {
        // 新增检查（2026-09-23）：段 id `meka.project-references`（order 65）是本次新增的注入段，
        // 它必须①真的进入会话上下文、②每个条目都是「地址 + 描述」形态、③正文标志串不在场。
        // 白名单编号与 `docs/dev-rules/meka-whitelist-verification.md` 必须一致（现最大编号 WL-11.16）。
        if (options.dryRun) return ctx.unverified('--dry-run：跳过真实运行');
        if (!ctx.row) return ctx.fail('前置失败：没有新会话');
        const before = ctx.assistantCount(ctx.row.id);
        await ctx.session.evaluate(`location.hash = '#/cc-agent/${ctx.row.id}'`);
        await sleep(2500);
        if (!(await sendMessage(ctx.session, PROJECT_REFERENCES_MESSAGE))) {
          return ctx.fail('未能发送项目参考清单回显探针');
        }
        let reply = null;
        for (let i = 0; i < REPLY_TIMEOUT_MS / 3000; i += 1) {
          await sleep(3000);
          if (ctx.assistantCount(ctx.row.id) <= before) continue;
          reply = ctx.lastAssistant(ctx.row.id);
          if (reply) break;
        }
        if (!reply) return ctx.fail('超时未见项目参考清单回显');
        const text = String(reply);
        // 项目配置的贡献快照在这里只取一次（结果缓存在 ctx 上）。
        const contributions = projectContributionsOf(ctx);
        const expectedReferences = contributions ? contributions.existingReferencePaths.length : 0;
        const start = text.indexOf(MEKA_PROJECT_REFERENCES_MARKER);
        const end = text.indexOf(MEKA_PROJECT_REFERENCES_CLOSE);
        if (start === -1 || end === -1 || end < start) {
          // 「段缺席」有两种完全不同的原因，必须分开报：项目本来就没有 agents-md/rule 元数据
          // （或声明的文件在盘上都不存在）时，该段按契约**不渲染**（空集合 ⇒ 不入 plan），
          // 这不是缺陷。
          if (contributions && expectedReferences > 0) {
            return ctx.fail(
              `项目（${contributions.file}）有 ${expectedReferences} 个真实存在的 enabled `
                + `agents-md/rule 文件，但回显里没有 ${MEKA_PROJECT_REFERENCES_MARKER} / `
                + `${MEKA_PROJECT_REFERENCES_CLOSE}：段未注入，或模型没有逐行回显；`
                + `回显=${JSON.stringify(text.slice(0, 300))}`,
            );
          }
          return ctx.unverified(
            '回显里没有参考清单段，且无法读项目配置（或该项目没有真实存在的 enabled agents-md/rule 文件）：'
              + '无法区分「契约上不渲染」与「段缺失」'
              + `${contributions ? `（配置=${contributions.file}，声明 ${contributions.enabledReferenceMetadata} 条、盘上存在 ${expectedReferences} 条）` : ''}`
              + `；回显=${JSON.stringify(text.slice(0, 300))}`,
          );
        }
        const section = text.slice(start, end + MEKA_PROJECT_REFERENCES_CLOSE.length);
        // 模型可能把整段包在代码围栏里（排版），围栏行不算内容；其余行必须是模板行或条目行。
        const rawLines = section.split(/\r?\n/).map((line) => line.trim());
        const fenceLines = rawLines.filter((line) => /^```/.test(line)).length;
        const lines = rawLines.filter((line) => line && !/^```/.test(line));
        const templateLines = new Set(MEKA_PROJECT_REFERENCES_TEMPLATE_LINES);
        // 模板行再给一层「忽略空白差异」的容忍：模型可能只重排空格而正文照抄。
        const templateKeys = new Set(
          MEKA_PROJECT_REFERENCES_TEMPLATE_LINES.map((line) => line.replace(/\s+/g, '')),
        );
        const entryPattern = /^-\s+(.+?)\s*\|\s*(.+?)\s*\|\s*(.*)$/;
        const entries = [];
        const violations = [];
        const headingLines = [];
        for (const line of lines) {
          if (templateLines.has(line) || templateKeys.has(line.replace(/\s+/g, ''))) continue;
          const matched = entryPattern.exec(line);
          if (matched) {
            entries.push({ scope: matched[1].trim(), path: matched[2].trim(), description: matched[3].trim() });
            continue;
          }
          if (line.startsWith('#')) {
            headingLines.push(line);
            continue;
          }
          violations.push(line);
        }
        const problems = [];
        if (!lines.includes(MEKA_PROJECT_REFERENCES_FORMAT_LINE)) {
          problems.push(`段里缺少格式行「${MEKA_PROJECT_REFERENCES_FORMAT_LINE}」`);
        }
        if (!entries.length) problems.push('段里没有任何条目行（`- 作用范围 | 绝对路径 | 用途`）');
        // 条目数不得**少于**项目里真实存在的规范文件数：漏投的条目等于该文件不可达（按契约
        // Agent 不该去发现本清单未列出的**规范文件** AGENTS.md / .cursorrules / rules.md；
        // 技能正文 SKILL.md 不在此限，它走技能目录按需读取）。**多**于期望不算违规：角色默认值里的
        // `projectMetadataSelection` 可以合法地指向 `metadata[]` 之外的条目，那种条目同样会渲染。
        if (expectedReferences > 0 && entries.length < expectedReferences) {
          problems.push(
            `清单条目少于项目里真实存在的规范文件数：条目=${entries.length} < 期望=${expectedReferences}`
              + `（漏投的条目会让对应文件按契约不可发现）`,
          );
        }
        if (headingLines.length) {
          // 这是「正文没被内联」的主要负向断言：`agents-md`/`rule` 的正文几乎必然含 Markdown 标题行，
          // 而清单条目本身永远以 `- ` 开头，不会以 `#` 开头。
          problems.push(
            `段内出现了以 # 开头的 Markdown 标题行（正文疑似被内联，或模型自行读取了参考文件）：`
              + JSON.stringify(headingLines.slice(0, 3)),
          );
        }
        if (violations.length) {
          problems.push(
            `段内有既非模板行、也非条目行的文本（注入文本被改写，或模型自行补了说明）：`
              + JSON.stringify(violations.slice(0, 3)),
          );
        }
        // 条目里的地址必须是**真实存在**的绝对路径：这既证明「给的是地址不是正文」，
        // 也证明给出去的地址可用（悬空引用同样会让按需读取失败）。
        const badPaths = entries.filter(
          (entry) => !path.isAbsolute(entry.path) || !fs.existsSync(entry.path),
        );
        if (badPaths.length) {
          problems.push(
            `条目里的路径不是真实存在的绝对路径（地址不可用，或模型未逐字回显）：`
              + JSON.stringify(badPaths.slice(0, 3).map((entry) => entry.path)),
          );
        }
        const badShapes = entries.filter(
          (entry) =>
            !entry.scope ||
            !entry.description ||
            (entry.scope !== MEKA_PROJECT_REFERENCES_ROOT_SCOPE_LABEL && /^([A-Za-z]:|[\\/])/.test(entry.scope)),
        );
        if (badShapes.length) {
          problems.push(
            `条目形态不符合「作用范围 | 绝对路径 | 用途」：${JSON.stringify(badShapes.slice(0, 3))}`,
          );
        }
        // 负向**强化**：从回显出来的真实地址里取「正文标志串」，断言它们不在段文本里。
        // 强度说明：标志串缺席只能说明「正文没有在场」，说明不了「模型读过这些文件」；因此这里
        // 只在**命中**时报错（命中 = 正文确实进了上下文），缺席不报错。取 ≤3 个文件、每个只读前 8 KiB。
        const signatureHits = [];
        const checkedSignatures = [];
        for (const entry of entries.slice(0, 3)) {
          const head = readFileHead(entry.path, 8192);
          if (!head) continue;
          const bodyLines = head
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line && !/^```/.test(line));
          const signature =
            bodyLines.find((line) => line.startsWith('#') && line.length >= 8) ??
            bodyLines.find((line) => line.length >= 8) ??
            null;
          if (!signature) continue;
          // 描述里本来就含这个字符串时无法区分来源，跳过（避免假红）。
          const ambiguous = entries.some(
            (candidate) =>
              candidate.description.includes(signature) || candidate.scope.includes(signature),
          );
          if (ambiguous) continue;
          checkedSignatures.push(signature);
          if (section.includes(signature)) signatureHits.push(signature);
        }
        if (signatureHits.length) {
          problems.push(
            `参考文件正文标志串出现在注入段里（正文被内联，或模型自行读取了参考文件）：`
              + JSON.stringify(signatureHits),
          );
        }
        if (problems.length) {
          return ctx.fail(`${problems.join('；')}；段内条目=${entries.length}，期望≥${expectedReferences}`);
        }
        const expectationNote = contributions
          ? `期望≥${expectedReferences}`
          : `项目配置不可读（声明数未知），未核对条目数与工程文件是否一一对应`;
        // 「正文标志串核对」是本次新增的检查，写脚本时未实跑——信息留在注释里，不进 PASS 证据串。
        return ctx.pass(
          `段命中：条目 ${entries.length} 条（${expectationNote}；路径均存在）；格式行在场；`
            + `无 # 标题行、无清单外文本${fenceLines ? `（忽略模型代码围栏 ${fenceLines} 行）` : ''}；`
            + `正文标志串核对 ${checkedSignatures.length} 条，命中 0 条`,
        );
      },
    },
    {
      id: 'WL-11.17/退役重绑',
      name: '升级库不残留已退役的内置角色行（通用开发 / system-* 等已折叠或映射走）',
      async run() {
        // 新增检查（2026-09-23），同属白名单 WL-11.17 的第 5 条不变量「退役别名重绑」：
        // 「通用开发」退役后，启动播种会把 general-development / system-* 的历史会话重绑到
        // `<projectId>-default-role` 并删除 saga2 的旧内置行。
        // 判定强度：直接读 `meka_roles` 全表（不依赖 UI），所以升级库里任何一条残留都能看见；
        // 只对 `is_builtin=1` 报错——同 id 的非内置行按 `§3.4/§8` 的接受边界属用户数据，不清理。
        // 该检查在**升级库**上才有判别力：新建库本来就没有这些 id。
        //
        // ⚠️ 本检查的列表**不含** `combat-development`（它是 `RETIRED_BUILTIN_MEKA_ROLE_MAPPINGS`
        // 的重绑**目标**，不是退役 id）。随包不再提供它的清单文件，但它是刻意保留的**孤儿内置行**
        // （不删存量行；读取时由 T2 回落该项目默认角色，见白名单 WL-20），所以它出现在
        // `meka_roles` 与角色列表里都是**预期**行为，不是残留 —— 把它加进 `RETIRED_BUILTIN_ROLE_IDS`
        // 会让本检查在升级库上**假红**。同理，本次交付**没有**给包内重新播种任何业务角色。
        const { project, roles } = ctx.catalog;
        const placeholders = RETIRED_BUILTIN_ROLE_IDS.map(() => '?').join(', ');
        const rows = ctx.dbAll(
          `SELECT id, project_id, is_builtin, display_name FROM meka_roles WHERE id IN (${placeholders})`,
          ...RETIRED_BUILTIN_ROLE_IDS,
        );
        const builtinRows = rows.filter((row) => row.is_builtin === 1);
        const customRows = rows.filter((row) => row.is_builtin !== 1);
        const problems = [];
        if (builtinRows.length) {
          problems.push(
            `meka_roles 里仍有已退役的**内置**角色行（退役播种应删除它们）：`
              + builtinRows.map((row) => `${row.id}(project=${row.project_id})`).join('、'),
          );
        }
        const retiredVisible = roles.filter((role) => RETIRED_BUILTIN_ROLE_IDS.includes(role.id));
        if (retiredVisible.length) {
          problems.push(
            `项目 ${project.id} 的角色列表里仍能选到退役角色：`
              + retiredVisible.map((role) => `${role.id}(${role.displayName})`).join('、'),
          );
        }
        if (problems.length) return ctx.fail(problems.join('；'));
        const customNote = customRows.length
          ? `；另有 ${customRows.length} 条同 id 的非内置行（用户数据，按裁决保留）：`
            + customRows.map((row) => `${row.id}@${row.project_id}`).join('、')
          : '';
        // 该检查同为本次新增，写脚本时未实跑——信息留在注释里，不进 PASS 证据串。
        return ctx.pass(
          `meka_roles 无退役内置行（核对 ${RETIRED_BUILTIN_ROLE_IDS.join('/')}）；`
            + `项目 ${project.id} 可见角色=${roles.map((role) => role.id).join(',')}${customNote}`
            + '（升级库场景才有判别力）',
        );
      },
    },
  ];
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(
      'usage: pnpm desktop:session-smoke -- [--port N] [--user-data-dir DIR] [--project-id ID] [--role ROLE_ID_OR_DISPLAY_NAME] [--dry-run] [--filter WL-11] [--json]',
    );
    console.log(
      `  --role 不传 = 用该项目的共享默认角色（<projectId>-default-role；随包项目 `
        + `${SAGA2_PROJECT_ID} 的就是 ${DEFAULT_ROLE_ID}，出厂全量契约）。`
        + '传别的角色请用库里真实存在的 id 或显示名（例如某个项目自有角色）；'
        + '随包已不附带任何角色清单文件，非默认角色的声明只从用户目录 meka-roles/<id>.json 读，'
        + '读不到（含 --role 战斗开发 这类已删清单的孤儿内置行）会登记 UNVERIFIED。',
    );
    return 0;
  }

  const port = resolvePort(options);
  const dbPath = resolveDbPath(options);
  if (!dbPath) {
    console.error('desktop:session-smoke: 找不到实例本地库（用 --user-data-dir 指定 userData）');
    return 2;
  }

  let catalog;
  try {
    catalog = readMekaCatalog(dbPath, options);
  } catch (error) {
    console.error(`desktop:session-smoke: 读取 Meka 项目/角色失败：${error.message}`);
    return 2;
  }

  // `--role` 的**新语义**：不传 = 该项目的共享默认角色（承接「通用开发」职能的出厂全量角色），
  // 因此默认跑法就命中默认角色契约；显式传角色 id 或显示名才改用它跑。指定了库里不存在的角色
  // 一律以前置错误退出（退出码 2），绝不静默回落默认角色——那会把「想验别的角色」变成假通过。
  const requestedRole = roleFromOption(catalog, options.role);
  if (options.role && !requestedRole) {
    console.error(
      `desktop:session-smoke: --role「${options.role}」不是项目 ${catalog.project.id} 的角色`
        + `（可选：${catalog.roles.map((role) => `${role.id}/${role.displayName}`).join('、')}）`,
    );
    return 2;
  }
  const sessionRole = requestedRole ?? defaultRoleOf(catalog);
  if (!sessionRole) {
    console.error(`desktop:session-smoke: 项目 ${catalog.project.id} 没有任何角色`);
    return 2;
  }

  let targets;
  try {
    targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  } catch (error) {
    console.error(`desktop:session-smoke: 连不上 CDP 端口 ${port}（先跑 pnpm restart:desktop:remote）：${error.message}`);
    return 2;
  }
  // 只留**主窗口**：排除独立辅助窗口（侧栏 / 资源占用 / 远程桌面查看器 / 带 `?view=` 的分离窗口）。
  // ⚠️ 2026-09-24 第三轮上游同步修正（与 `meka-ui-smoke.mjs` 同一处缺陷）：dev 启动会额外开出
  // `?remoteDesktopViewer=1#/remote-desktop-viewer` 窗口；当它排在主窗口之前时，脚本会连到查看器页面
  // ⇒ 侧栏里只有「远程桌面 / 连接中…」而没有 Meka 分区，于是 WL-3.2 与整串 WL-11.x 全部报
  // 「侧栏缺少 Meka 分区」这种**误导性结论**（看起来像 Meka 能力丢了，其实连错了窗口）。
  // 因此补充排除 `remoteDesktopViewer`，并优先选择不带查询串的页面目标。
  const auxiliaryWindowPattern = /\?(sidebarWindow|resourceUsageWindow|remoteDesktopViewer|view=)/;
  const pageTargets = targets.filter(
    (t) => t.type === 'page' && !auxiliaryWindowPattern.test(t.url ?? ''),
  );
  const target = pageTargets.find((t) => !(t.url ?? '').includes('?')) ?? pageTargets[0];
  if (!target?.webSocketDebuggerUrl) {
    console.error(`desktop:session-smoke: 端口 ${port} 上没有找到主窗口页面目标`);
    return 2;
  }

  const session = await CdpSession.connect(target.webSocketDebuggerUrl);
  const logDir = resolveLogDir();
  const results = [];
  const dbRead = (sql, ...args) => {
    const db = openDb(dbPath);
    try {
      return db.prepare(sql).all(...args);
    } finally {
      db.close();
    }
  };
  const dbGet = (sql, ...args) => {
    const db = openDb(dbPath);
    try {
      return db.prepare(sql).get(...args);
    } finally {
      db.close();
    }
  };

  const ctx = {
    session,
    options,
    catalog,
    dbPath,
    logDir,
    // 本次要建会话的角色（`--role` 指定，否则 = 该项目的共享默认角色）。WL-11.2 会把选择器真的
    // 切到这个身份上，WL-11.3/11.5/11.6 一律以它为准，不再用位置或显示名回查角色。
    sessionRole,
    pass: (evidence) => ({ status: 'pass', evidence }),
    fail: (evidence) => ({ status: 'fail', evidence }),
    unverified: (evidence) => ({ status: 'unverified', evidence }),
    dbAll: (sql, ...args) => dbRead(sql, ...args),
    dbIds: () => dbRead('SELECT id FROM sessions').map((r) => r.id),
    sessionRow: (predicate) =>
      dbRead(
        'SELECT id, title, workspace_kind, meka_project_id, meka_role_id, is_formal, working_dir, status FROM sessions',
      ).find(predicate) ?? null,
    assistantCount: (sessionId) =>
      dbGet(
        "SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND role = 'assistant' AND agent_kind = 'pi'",
        sessionId,
      ).n,
    lastAssistant: (sessionId) =>
      dbGet(
        "SELECT content FROM messages WHERE session_id = ? AND role = 'assistant' AND agent_kind = 'pi' ORDER BY created_at DESC LIMIT 1",
        sessionId,
      )?.content ?? null,
  };

  const checks = buildChecks(ctx);
  try {
    await session.waitFor(`!!document.querySelector('#root, #app') || document.body.children.length > 0`, {
      timeoutMs: READY_TIMEOUT_MS,
      label: 'renderer ready',
    });
    // 先确认实例就是 HEAD，否则下面的结论描述的是旧代码。
    const freshness = await assertInstanceMatchesHead(session);
    if (!freshness.ok) {
      console.error(`desktop:session-smoke: ${freshness.reason}（先跑 pnpm restart:desktop:remote）`);
      return 2;
    }
    console.error(
      freshness.line
        ? `desktop:session-smoke: 实例版本行「${freshness.line}」与 HEAD=${freshness.head} 一致`
        : `desktop:session-smoke: ${freshness.reason}`,
    );
    for (const check of checks) {
      if (options.filter && !check.id.includes(options.filter) && !check.name.includes(options.filter)) {
        continue;
      }
      let outcome;
      try {
        outcome = await check.run();
      } catch (error) {
        outcome = {
          status: 'fail',
          evidence: `执行异常：${error instanceof Error ? error.message : String(error)}`,
        };
      }
      results.push({ id: check.id, name: check.name, ...outcome });
    }
    await session.pressEscape().catch(() => {});
    await session.evaluate(`location.hash = '#/cc-agent/new'`).catch(() => {});
  } finally {
    session.close();
  }

  const failed = results.filter((r) => r.status === 'fail');
  const unverified = results.filter((r) => r.status === 'unverified');
  const summary = {
    port,
    target: target.url,
    dbPath,
    project: catalog.project.id,
    roles: catalog.roles.map((r) => r.id),
    sessionRole: sessionRole.id,
    dryRun: options.dryRun,
    checked: results.length,
    pass: results.filter((r) => r.status === 'pass').length,
    fail: failed.length,
    unverified: unverified.length,
    results,
  };

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    for (const r of results) {
      const mark = r.status === 'pass' ? 'PASS' : r.status === 'fail' ? 'FAIL' : 'UNVERIFIED';
      console.log(`[${mark}] ${r.id} ${r.name}`);
      console.log(`         ${r.evidence}`);
    }
    console.log(
      `\nSESSION_SMOKE ${failed.length ? 'FAILED' : 'PASSED'} — checks=${summary.checked} pass=${summary.pass} fail=${summary.fail} unverified=${summary.unverified}`,
    );
    console.log(
      `port=${port} project=${summary.project} roles=${summary.roles.join(',')} sessionRole=${summary.sessionRole}${options.dryRun ? ' (dry-run)' : ''}`,
    );
  }
  return failed.length ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`desktop:session-smoke: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  });
