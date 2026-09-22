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
 *   - WL-3.2  侧栏 Meka 项目树：项目行 + 正式流程/普通对话子组 + 项目作用域的新建入口
 *   - WL-11.1 从项目入口创建草稿后，草稿被绑定到该项目与该项目默认角色
 *   - WL-11.2 角色选择器列出该项目全部角色，切换后草稿角色随之变化
 *   - WL-11.3 发送后会话行绑定 project/role，工作目录解析到项目路径，且为普通（非正式）会话
 *   - WL-11.4 Agent 真实跑完一轮并产出回复
 *   - WL-11.5 角色上下文注入运行期：由运行中的会话回显 [MEKA_ROLE_CONTEXT] 证明
 *   - WL-11.6 运行期配置按角色解析（workflow / 角色级 MCP / 技能快照含角色声明的技能）
 *   - WL-11.7 新会话归属 Meka 分区下的该项目子树，而非普通「对话」分组
 *
 * 前置：
 *   1. 应用已通过 `pnpm restart:desktop:remote` 起来（dev 模式默认开 remote debugging）；
 *   2. 端口来自该实例 userData 下的 `DevToolsActivePort`（或用 `--port` 显式指定）。
 *
 * 用法：
 *   pnpm desktop:session-smoke                     # 自动解析端口，用第一个多角色 Meka 项目
 *   pnpm desktop:session-smoke -- --dry-run        # 只验草稿/角色选择器，不真正建会话
 *   pnpm desktop:session-smoke -- --user-data-dir "<userData>" --json
 *   pnpm desktop:session-smoke -- --project-id saga2 --role 战斗开发
 *
 * 退出码：0 = 无 FAIL（UNVERIFIED 不阻断但会列出）；1 = 有 FAIL；2 = 前置不满足（连不上、
 * 库/清单读不到等）。
 *
 * 副作用（刻意保留，规范要求实跑）：会在真实用户库里新建一条 Meka 会话并发起一次真实模型
 * 调用。`--dry-run` 可跳过「发送 → 建会话 → 运行」三段。不修改仓库文件、不改应用配置。
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

/** 与语言无关的侧栏钩子：Meka 分区的展开/收起按钮、项目行、子组头。 */
const MEKA_SECTION_TOGGLE = `[...document.querySelectorAll('button')].find((b) => /展开 Meka 对话|收起 Meka 对话/.test(b.getAttribute('aria-label') || ''))`;
// 库里的 `name`（如 saga2）与可见 displayName（如 SAGA2）大小写不一定一致，比对必须忽略大小写。
const projectRow = (projectName) =>
  `[...document.querySelectorAll('[role=button]')].find((e) => (e.textContent || '').toLowerCase().includes(${JSON.stringify(projectName.toLowerCase())}) && e.getAttribute('aria-expanded') !== null)`;
const subgroupHeader = (label) =>
  `[...document.querySelectorAll('[role=button]')].find((e) => (e.textContent || '').trim() === ${JSON.stringify(label)} && e.getAttribute('aria-expanded') !== null)`;
const sidebarText = `(() => { const sb = document.querySelector('aside') || document.body; return (sb.innerText || '').replace(/\\n+/g, ' | '); })()`;

/** 读库（只读打开，绝不写回）。 */
function openDb(dbPath) {
  const Database = require('better-sqlite3');
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

/** 与 shared/meka-projects.ts 的 mekaDefaultRoleId() 同构：<projectId>-default-role。 */
function isSharedDefaultRole(role, projectId) {
  return role.isBuiltin === true && role.id === `${projectId}-default-role`;
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
 * Host 对每个普通 Meka 任务都会注入的平台 MCP（`mekaResolvePlan.ts` 的
 * `mergePlatformMcp`）。它是「角色级注入」之外的部分，因此默认角色的反向断言要把它排除，
 * 而不是断言运行期 MCP 为空。平台基线变化时这里必须同步——这正是本清单要拦住的那类漂移。
 */
const PLATFORM_MCP_PROVIDER_IDS = ['mcp-router'];

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
        displayName: row.display_name ?? row.name,
        description: row.description ?? '',
        isBuiltin: row.is_builtin === 1,
      });
    }
    const project = options.projectId
      ? projects.find((p) => p.id === options.projectId)
      : projects.find((p) => (rolesByProject.get(p.id) ?? []).length >= 2) ?? projects[0];
    if (!project) throw new Error('库里没有 Meka 项目');
    const roles = rolesByProject.get(project.id) ?? [];
    if (roles.length < 2) throw new Error(`项目 ${project.id} 的角色少于 2 个，无法验证角色切换`);
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
    workflow: pick('workflow') === 'null' ? null : pick('workflow'),
    skillsCount: Number(pick('skillsCount')),
    platformSkillsCount: Number(pick('platformSkillsCount')),
    skillRevision: pick('skillRevision'),
    mcpProviderIds: mcpMatch
      ? mcpMatch[1]
          .split(',')
          .map((s) => s.trim().replace(/^'|'$/g, ''))
          .filter(Boolean)
      : [],
  };
}

/** 角色清单里声明的技能 id（`resources/meka/roles/<roleId>.json`）。 */
function declaredRoleSkills(roleId) {
  const file = path.join(ROOT, 'apps', 'desktop', 'resources', 'meka', 'roles', `${roleId}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      skills: (manifest.skills ?? []).map((s) => s.skillId).filter(Boolean),
      mcp: (manifest.mcp ?? []).map((m) => m.providerId).filter(Boolean),
      workflow: manifest.workflow ?? null,
    };
  } catch {
    return null;
  }
}

/** 建 Meka 草稿：展开 Meka 段与项目行，hover 子组头，点该子组的创建按钮。 */
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
  // 拼标签，必须从 DOM 读回真实标签。
  const rowExpr = projectRow(projectName);
  if ((await session.evaluate(`${rowExpr}?.getAttribute('aria-expanded') ?? null`)) === 'false') {
    await session.clickAt(await session.boxOf(rowExpr));
    await sleep(900);
  }
  const label = await session.evaluate(`${rowExpr}?.textContent?.trim() ?? null`);
  return label;
}

async function createMekaDraft(session, projectName, { subgroup = '普通对话', formal = false, fresh = false } = {}) {
  // `navigate('/cc-agent/new', …)` 在**已经在**该路由时不会重挂载 NewMakerDraftRoute，
  // 其 `useState` 里已选的项目/角色会保留（见 WL-11.8）。要验证「新建草稿的默认角色」
  // 就必须先离开该路由，逼出一次真正的挂载。
  if (fresh) {
    await session.evaluate(`location.hash = '#/cc-agent/meka'`);
    await sleep(1400);
  }
  const projectLabel = await ensureMekaTreeVisible(session, projectName);
  if (!projectLabel) return { ok: false, reason: `侧栏 Meka 分区里找不到项目「${projectName}」` };

  const header = await session.boxOf(subgroupHeader(subgroup));
  if (!header) return { ok: false, reason: `未找到子组头「${subgroup}」`, projectLabel };
  // 创建按钮在 hover 显现的容器里，必须先 hover 再用真实鼠标点。
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: header.x,
    y: header.y,
    buttons: 0,
  });
  await sleep(700);
  const label = formal
    ? `在 ${projectLabel} 中新建正式流程对话`
    : `在 ${projectLabel} 中新建普通对话`;
  const box = await session.boxOf(BY_LABEL(label));
  if (!box) return { ok: false, reason: `未找到项目作用域创建入口「${label}」`, projectLabel };
  await session.clickAt(box);
  await sleep(2400);
  return { ok: true, projectLabel };
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
      name: '侧栏 Meka 分区呈现项目树：项目行、正式/普通子组与项目作用域的新建入口',
      async run() {
        const { project } = ctx.catalog;
        await ctx.session.evaluate(`location.hash = '#/cc-agent/new'`);
        await sleep(1600);
        const text = await ctx.session.evaluate(sidebarText);
        if (!text.includes('Meka')) return ctx.fail(`侧栏缺少 Meka 分区：${text.slice(0, 200)}`);
        if (!text.toLowerCase().includes(project.name.toLowerCase())) {
          return ctx.fail(`侧栏缺少项目「${project.name}」：${text.slice(0, 300)}`);
        }
        // 展开态:确保项目行与子组可见后断言入口可用。
        const draft = await createMekaDraft(ctx.session, project.name, { fresh: true });
        if (!draft.ok) return ctx.fail(draft.reason);
        const entries = await ctx.session.evaluate(
          `[...document.querySelectorAll('button')]
             .map((b) => b.getAttribute('aria-label') || '')
             .filter((a) => a.includes('新建') && a.includes(${JSON.stringify(draft.projectLabel)}))`,
        );
        if (!entries.length) return ctx.fail('项目作用域的新建入口不可见');
        return ctx.pass(`项目=${draft.projectLabel}；新建入口=${JSON.stringify(entries)}`);
      },
    },
    {
      id: 'WL-11.1',
      name: '从项目入口新建的草稿（真实重挂载）绑定到该项目与该项目的默认角色',
      async run() {
        const { project, roles } = ctx.catalog;
        const draft = await createMekaDraft(ctx.session, project.name, { fresh: true });
        if (!draft.ok) return ctx.fail(draft.reason);
        const chip = await ctx.session.evaluate(`${BY_LABEL(ROLE_PICKER)}?.textContent?.trim() ?? null`);
        if (!chip) return ctx.fail('草稿里没有角色选择器（未绑定 Meka 项目/角色）');
        // 断言的是「共享默认角色」这个身份，而不是「列表第一项」：应用侧由
        // `pickDefaultMekaRole()` 显式选中 `<projectId>-default-role`，排序只是附带结果。
        // 按位置断言会在排序被任何写入路径归一化时误红，且失败信息指错方向。
        const defaultRole = roles.find((role) => isSharedDefaultRole(role, project.id));
        if (!defaultRole) {
          return ctx.fail(`项目 ${project.id} 库里没有共享默认角色 ${project.id}-default-role`);
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
        return ctx.pass(`项目=${ctx.projectLabel} 默认角色=${chip}`);
      },
    },
    {
      id: 'WL-11.2',
      name: '角色选择器列出该项目全部角色，且切换后草稿角色随之变化',
      async run() {
        const { roles } = ctx.catalog;
        await ctx.session.clickAt(await ctx.session.boxOf(BY_LABEL(ROLE_PICKER)));
        await sleep(900);
        const options_ = await ctx.session.evaluate(
          `[...document.querySelectorAll(${JSON.stringify(ROLE_OPTION_LIST)})].map((o) => (o.textContent || '').trim())`,
        );
        if (options_.length !== roles.length) {
          return ctx.fail(`角色选项数应为 ${roles.length}，实际 ${options_.length}：${JSON.stringify(options_)}`);
        }
        const target = options.role ?? roles[1].displayName;
        const clicked = await ctx.session.clickAt(
          await ctx.session.boxOf(
            `[...document.querySelectorAll(${JSON.stringify(ROLE_OPTION_LIST)})].find((o) => (o.textContent || '').includes(${JSON.stringify(target)}))`,
          ),
        );
        if (!clicked) return ctx.fail(`未能选中角色「${target}」`);
        await sleep(900);
        const chip = await ctx.session.evaluate(`${BY_LABEL(ROLE_PICKER)}?.textContent?.trim() ?? null`);
        if (chip !== target) return ctx.fail(`切换后角色 chip 应为「${target}」，实际=${chip}`);
        ctx.role = roles.find((r) => r.displayName === target) ?? null;
        return ctx.pass(`选项=${JSON.stringify(options_)}；切换为「${chip}」`);
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
        const expectedRole = (ctx.role ?? defaultRoleOf(ctx.catalog)).id;
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
        const { project, roles } = ctx.catalog;
        const role = ctx.role ?? defaultRoleOf(ctx.catalog);
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
        // 语言**改写**它（`战斗开发` → `Combat Development`），那是模型行为而非注入缺陷。
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
      name: '运行期配置按角色解析：workflow、角色级 MCP 与角色声明的技能进入该会话快照',
      async run() {
        if (options.dryRun) return ctx.unverified('--dry-run：跳过真实运行');
        if (!ctx.row) return ctx.fail('前置失败：没有新会话');
        const role = ctx.role ?? defaultRoleOf(ctx.catalog);
        const declared = declaredRoleSkills(role.id);
        // 共享「默认角色」刻意没有包内清单：它的契约就是不注入任何提示词／技能／MCP，
        // 所以缺清单是预期结果，而不是验证缺口——改为断言运行期同样为空。
        const sharedDefault = isSharedDefaultRole(role, ctx.catalog.project.id);
        const config = runtimeConfigFromLog(ctx.logDir, ctx.row.id);
        if (!config) return ctx.fail(`日志里找不到该会话的 Meka 运行期配置（${ctx.logDir}）`);
        if (config.projectId !== ctx.catalog.project.id) {
          return ctx.fail(`运行期 projectId=${config.projectId}，期望 ${ctx.catalog.project.id}`);
        }
        if (config.roleId !== role.id) return ctx.fail(`运行期 roleId=${config.roleId}，期望 ${role.id}`);
        const problems = [];
        if (!declared && !sharedDefault) {
          problems.push(`未找到角色清单 apps/desktop/resources/meka/roles/${role.id}.json`);
        } else {
          const declaredWorkflow = declared ? declared.workflow ?? null : null;
          const declaredMcp = declared ? declared.mcp : [];
          const declaredSkills = declared ? declared.skills : [];
          if (declaredWorkflow !== (config.workflow ?? null)) {
            problems.push(`workflow=${config.workflow}，清单声明=${declaredWorkflow}`);
          }
          for (const providerId of declaredMcp) {
            if (!config.mcpProviderIds.includes(providerId)) {
              problems.push(`角色级 MCP ${providerId} 未进入运行期（实际 ${config.mcpProviderIds.join(',')}）`);
            }
          }
          if (sharedDefault) {
            // 默认角色的契约是「没有**角色级**注入」，不是「运行期什么都没有」：Host 对每个
            // 普通 Meka 任务都会加平台基线（`mergePlatformMcp` 注入 mcp-router、
            // `resolveMekaPlatformRuntimeSkills` 提供平台技能并因此仍会冻结一份技能快照）。
            // 所以这里断言的是「总集合等于平台基线」，断言 mcp/skills 为空会误报。
            const extraMcp = config.mcpProviderIds.filter(
              (id) => !PLATFORM_MCP_PROVIDER_IDS.includes(id),
            );
            if (extraMcp.length) {
              problems.push(
                `默认角色不应有角色级 MCP：实际 ${config.mcpProviderIds.join(',')}，平台基线外=${extraMcp.join(',')}`,
              );
            }
            for (const platformId of PLATFORM_MCP_PROVIDER_IDS) {
              if (!config.mcpProviderIds.includes(platformId)) {
                problems.push(`平台 MCP ${platformId} 未进入运行期（实际 ${config.mcpProviderIds.join(',')}）`);
              }
            }
            if (config.skillsCount !== config.platformSkillsCount) {
              problems.push(
                `默认角色不应贡献角色技能：skillsCount=${config.skillsCount} ≠ platformSkillsCount=${config.platformSkillsCount}`,
              );
            }
          }
          const snapshot = skillDirsForSession(options.userDataDir, ctx.row.id);
          if (!snapshot) {
            // 只有平台技能也为空时才允许没有快照；平台技能存在却缺快照是真实缺陷
            // （平台技能必须被冻结进该任务的不可变快照）。
            if (config.platformSkillsCount > 0) {
              problems.push(
                `平台技能 ${config.platformSkillsCount} 个存在，但该会话没有技能快照`,
              );
            }
          } else {
            if (snapshot.revision !== config.skillRevision) {
              problems.push(`快照 revision=${snapshot.revision}≠运行期 ${config.skillRevision}`);
            }
            if (sharedDefault) {
              // 默认角色的快照应恰好只含平台技能——数量相等即证明角色未追加任何技能。
              if (snapshot.skills.length !== config.platformSkillsCount) {
                problems.push(
                  `默认角色快照应只含平台技能 ${config.platformSkillsCount} 个，实际 ${snapshot.skills.length}：${snapshot.skills.join(',')}`,
                );
              }
            } else {
              for (const skillId of declaredSkills) {
                if (!snapshot.skills.includes(skillId)) {
                  problems.push(`角色声明的技能 ${skillId} 不在快照（${snapshot.skills.join(',')}）`);
                }
              }
            }
            ctx.snapshotSkills = snapshot.skills;
          }
        }
        if (problems.length) return ctx.fail(problems.join('；'));
        return ctx.pass(
          `roleId=${config.roleId} workflow=${config.workflow} mcp=${config.mcpProviderIds.join(',')} skillsCount=${config.skillsCount} platformSkillsCount=${config.platformSkillsCount} 快照技能=${(ctx.snapshotSkills ?? []).join(',')}`,
        );
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
        const { project, roles } = ctx.catalog;
        if (roles.length < 2) return ctx.unverified('该项目角色少于 2 个，无法验证');
        const draft = await createMekaDraft(ctx.session, project.name, { fresh: true });
        if (!draft.ok) return ctx.fail(draft.reason);
        const target = roles[1].displayName;
        await ctx.session.clickAt(await ctx.session.boxOf(BY_LABEL(ROLE_PICKER)));
        await sleep(900);
        await ctx.session.clickAt(
          await ctx.session.boxOf(
            `[...document.querySelectorAll(${JSON.stringify(ROLE_OPTION_LIST)})].find((o) => (o.textContent || '').includes(${JSON.stringify(target)}))`,
          ),
        );
        await sleep(900);
        const afterSwitch = await ctx.session.evaluate(`${BY_LABEL(ROLE_PICKER)}?.textContent?.trim() ?? null`);
        if (afterSwitch !== target) return ctx.fail(`切换角色失败：${afterSwitch}`);
        // 同路径再次点击项目新建入口：不离开路由 → NewMakerDraftRoute 不重挂载 → 已选角色保留。
        const again = await createMekaDraft(ctx.session, project.name);
        if (!again.ok) return ctx.fail(again.reason);
        const afterReenter = await ctx.session.evaluate(`${BY_LABEL(ROLE_PICKER)}?.textContent?.trim() ?? null`);
        if (afterReenter !== target) {
          return ctx.fail(`同一项目重进后应保留草稿已选角色「${target}」，实际=${afterReenter}`);
        }
        return ctx.pass(
          `fresh 默认=「${defaultRoleOf(ctx.catalog).displayName}」；切到「${target}」后同项目重进仍为「${afterReenter}」（跨项目重进无第二个项目可验）`,
        );
      },
    },
  ];
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(
      'usage: pnpm desktop:session-smoke -- [--port N] [--user-data-dir DIR] [--project-id ID] [--role DISPLAY_NAME] [--dry-run] [--filter WL-11] [--json]',
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

  let targets;
  try {
    targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  } catch (error) {
    console.error(`desktop:session-smoke: 连不上 CDP 端口 ${port}（先跑 pnpm restart:desktop:remote）：${error.message}`);
    return 2;
  }
  const target = targets.find(
    (t) => t.type === 'page' && !/\?(sidebarWindow|resourceUsageWindow|view=)/.test(t.url ?? ''),
  );
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
    pass: (evidence) => ({ status: 'pass', evidence }),
    fail: (evidence) => ({ status: 'fail', evidence }),
    unverified: (evidence) => ({ status: 'unverified', evidence }),
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
      `port=${port} project=${summary.project} roles=${summary.roles.join(',')}${options.dryRun ? ' (dry-run)' : ''}`,
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
