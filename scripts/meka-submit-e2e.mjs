#!/usr/bin/env node
/**
 * Meka 提交流程端到端驱动脚本（meka-submit 插件）。
 * ---------------------------------------------------------------------------
 * 为什么需要它（2026-11-18）：
 *   用户不想再「被通知说提交流程好了、自己一测又是基础问题」。真实会话里的提交走的是
 *   **meka-submit 插件**（`ghost.json` 的 `call_tool` 二级操作：submit_start / submit_check /
 *   submit_confirm / submit_record，以及 PSB 的 jira_issues 查单），它的行为只在**真实运行期**
 *   成立：插件是否被召回、`ghost_call` 参数形状、Jira 单能否自动推断、`submit_confirm` 的确认框
 *   是否弹得出来、回执是否落库——单测和静态检查都看不到。所以需要一个能**程序化驱动正在运行的
 *   dev 实例跑一轮真实会话**、把整条工具链与校验摘要留成 JSON 的证据工具。
 *
 * 与 `scripts/meka-session-smoke.mjs` 的分工（本脚本刻意复用它的成熟套路，不另造一套）：
 *   - smoke：验 Meka 项目/角色机制（WL-3.2、WL-11.x），断言侧栏布局、草稿绑定、运行期注入。
 *   - 本脚本：不验 UI 结构，而是**跑一轮真实的提交流程**并把每一步工具调用、结果摘要、错误码、
 *     自动作答记录、是否走到 submit_confirm / submit_record 落成报告，供交付前自测取证。
 *   复用自 smoke 的部分（逐字或近乎逐字，避免两份会漂移的实现）：
 *     · `CdpSession`（Runtime.evaluate / Input.dispatch* / waitFor / boxOf / clickAt / pressEscape）；
 *     · 主窗口 renderer 目标的挑选规则（排除 sidebarWindow / resourceUsageWindow /
 *       remoteDesktopViewer / 带 `?view=` 的分离窗口，优先不带查询串的页面）；
 *     · 侧栏 Meka 项目树的两种布局探测（扁平 = 项目级入口挂在项目行上；两子组 = 入口挂在
 *       「普通对话」子组头上）与 `createMekaDraft()` 的真实鼠标入口点击；
 *     · `sendMessage()`（contenteditable + Input.insertText + 点「发送」）；
 *     · userData 候选目录与 `DevToolsActivePort` 解析、只读打开 `cindy-meka-*.db` 的轮询方式。
 *   ⚠️ 同步义务：上面这些是**手抄副本**（本脚本不 import smoke，因为两者生命周期与失败语义不同），
 *   smoke 里的选择器/入口文案改了，这里必须一起改，否则本脚本会「建不出草稿」而不是「测试失败」。
 *
 * 用法：
 *   node scripts/meka-submit-e2e.mjs                      # 默认：项目 saga2、prompt「提交客户端仓库 P4 修改」
 *   node scripts/meka-submit-e2e.mjs --dry-run            # 只连 CDP + 探测目标页，不发消息、不改 UI 状态
 *   node scripts/meka-submit-e2e.mjs --answer "SAGA-30"   # 出现 ask_user 提问时按参数自动作答
 *   node scripts/meka-submit-e2e.mjs --answer SAGA-30 --confirm   # 另自动点插件确认框的「确认」（真提交！）
 *   node scripts/meka-submit-e2e.mjs --project-id saga2 --prompt "提交客户端仓库 P4 修改" \
 *        --timeout-ms 900000 --out artifacts/meka-submit-e2e/run.json
 *
 * 参数（全部命令行，不依赖交互式输入）：
 *   --cdp-port <n>         CDP 端口。默认：`XDT_CDP_PORT` → 该实例 userData 的
 *                          `DevToolsActivePort` → 9222（与 smoke 同序）。
 *   --user-data-dir <dir>  dev 实例 userData。默认：`XDT_USER_DATA_DIR` →
 *                          `%APPDATA%/CindyMeka-dev2-dev` → `%APPDATA%/CindyMeka`。
 *   --project-id <id>      Meka 项目 id（默认 `saga2`）。
 *   --prompt <text>        首条用户消息（默认 `提交客户端仓库 P4 修改`）。
 *   --answer <text>        自动作答一个 ask_user 问题；**可重复**，按出现顺序（第 1 次提问用第 1 个
 *                          --answer，第 2 次用第 2 个）。不传 = 不猜，遇到提问直接判「卡住」。
 *   --confirm             自动点插件确认框的主按钮（`confirm` 槽，meka-submit 的 submit_confirm 会弹）。
 *                         不传 = 不点确认，把弹窗按「取消」关掉并判「卡住」——**它可能是真提交的闸门**。
 *   --timeout-ms <n>      等待本轮 Agent 跑完的上限（默认 900000 = 15 分钟）。
 *   --out <path>          报告 JSON 路径（默认 `artifacts/meka-submit-e2e/e2e-<时间戳>.json`）。
 *   --dry-run             只连 CDP + 探测目标页/项目可见性，不建会话、不发消息、不点任何东西。
 *   --help
 *
 * 退出码：0 = 本轮真实跑完（业务成败见报告 verdict/checks）；1 = 卡住/超时/执行异常；
 *        2 = 前置不满足（CDP 连不上、target 找不到、项目入口建不出草稿、库找不到等）。
 *        `--dry-run` 探测成功返回 0、失败返回 2。
 *
 * 安全边界（刻意 fail closed，不猜）：
 *   1. **没有 `--answer` 就不作答**：直接把提问的题干/选项/卡在哪一步写进报告并退出，不做
 *      「选第一个」「选推荐项」这类猜测——那会把「用户必须拍板的事」静默变成脚本决定。
 *   2. **没有 `--confirm` 就不确认**：插件确认框是提交前的真人闸门。脚本会把它**取消掉**
 *      （取消 = 不批准，绝不会误点成同意），记录确认框标题/正文，然后判「卡住」。
 *      传了 `--confirm` 才点主按钮，并在报告里记下「脚本代替人点了确认」及其文案。
 *   3. 只点**插件确认框**（`role=alertdialog` 且标题以「插件「」开头，见
 *      `GhostConfirmDialogHost`）；其它弹窗一律不碰，只登记并判卡住。
 *   4. 不修改仓库文件、不改应用配置、不 commit；数据库只读打开（`readonly: true`）。
 *
 * 副作用：会在真实用户库里新建一条 Meka 会话并触发**真实模型调用**（与 smoke 同性质），
 *   并把 Electron 主窗口导航到该会话。报告写到仓库 `artifacts/`（已被 .gitignore 忽略）。
 *   脚本**不删会话、不改应用数据**；判「卡住」时把提问原样留在界面上等真人回答
 *   （不按 Escape、不跳过——实测按 Escape 会把等待中的提问答成空答案并让该轮异常收尾）。
 *
 * 环境要求与已知限制（2026-11-18 在真实 dev 实例上实跑记录）：
 *   - 只连**已经跑着**的 dev 实例，自己不启动/重启实例；跑之前先 `pnpm restart:desktop:remote`。
 *   - 主窗口被最小化/隐藏时，隐藏文档里 CSS 动画不推进 ⇒ Radix 的**已关闭**弹窗会以
 *     `.modal-scrim` 形态永久留在 DOM 里盖住整个界面，侧栏入口点不到、`:hover` 也不更新。
 *     脚本连上后打开 CDP 的焦点模拟（`Emulation.setFocusEmulationEnabled`）把页面判为可见来绕开；
 *     仍不可视时以前置失败退出（退出码 2）并给出可操作诊断。
 *   - 提问按 `--answer` 的**出现顺序**逐题作答（第 1 题用第 1 个 --answer）；answer 不够用就停在
 *     那一题，**不会**拿同一个答案去应付下一题，也不会「选推荐项」。
 *   - 一次运行 = 库/侧栏里多一条真实 Meka 会话；脚本不清理它，也不清理历史会话。
 *   - 未覆盖：`submit_confirm` 之后的真实提交链路（要 `--confirm` 才会点确认，而那是**真的会提交**，
 *     在没拿到明确授权时不要传）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// `better-sqlite3` 是 desktop 的依赖（根只是靠 hoisting 恰好可见），从 desktop 解析避免
// 换 node-linker 后本工具在干净安装上直接崩（与 smoke 同一处取舍）。
const require = createRequire(path.join(ROOT, 'apps', 'desktop', 'package.json'));

const DEFAULT_CDP_PORT = 9222;
const DEFAULT_PROJECT_ID = 'saga2';
const DEFAULT_PROMPT = '提交客户端仓库 P4 修改';
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
/** 轮询 DB / DOM 的间隔：提交链路一步通常 1-15s，2s 足够且不会给库造成压力。 */
const POLL_MS = 2000;
const READY_TIMEOUT_MS = 30_000;
const STEP_TIMEOUT_MS = 10_000;
/** 发送后等会话行落库的上限（同 smoke 的 SESSION_TIMEOUT_MS）。 */
const SESSION_TIMEOUT_MS = 60_000;
/** ask_user 卡片在 DOM 里出现的等待上限（库行先落，renderer 后画）。 */
const CARD_WAIT_MS = 20_000;
/** 一次答题动作（点选项/点提交）后等卡片状态变化的上限。 */
const ANSWER_SETTLE_MS = 20_000;
/** 插件确认框从出现到点掉的等待上限（main 侧兜底超时是 90s，别抢在它前面误判）。 */
const CONFIRM_SETTLE_MS = 15_000;

// ── 与语言无关的 i18n 文案（zh-CN 值；界面语言不同会导致本脚本找不到入口） ──────────────
const ASK_RESTORE_ARIA = '展开问题卡片';
const ASK_CUSTOM_ROW_TEXT = '输入其他回答';
const ASK_SUBMIT_LABELS = ['提交', '下一题', '发送并继续', '发送补充'];
/** meka-submit 确认框的标题前缀（`settings.ghosts.confirm.dialogTitle` = `插件「{{name}}」…`）。 */
const GHOST_CONFIRM_TITLE_PREFIX = '插件「';

/**
 * 与 `apps/desktop/src/renderer/lib/makerChatStore.ts` 里 ask_user 内容结构同步的解析口径：
 * 库行 `content` = `{ requestId, questions: [{ question, header, options: [{label, description}],
 * multiSelect?, answerConstraints? }], status: 'pending'|'answered'|'cancelled', answers }`。
 * 这里只读不猜，字段缺失一律按「读不到」处理。
 */

function parseArgs(argv) {
  const options = {
    cdpPort: null,
    userDataDir: null,
    projectId: DEFAULT_PROJECT_ID,
    prompt: DEFAULT_PROMPT,
    answers: [],
    confirm: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    out: null,
    dryRun: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} 需要一个值`);
      i += 1;
      return value;
    };
    if (arg === '--cdp-port') options.cdpPort = Number(next());
    else if (arg === '--user-data-dir') options.userDataDir = next();
    else if (arg === '--project-id') options.projectId = next();
    else if (arg === '--prompt') options.prompt = next();
    else if (arg === '--answer') options.answers.push(next());
    else if (arg === '--confirm') options.confirm = true;
    else if (arg === '--timeout-ms') options.timeoutMs = Number(next());
    else if (arg === '--out') options.out = next();
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--') continue; // pnpm 透传的分隔符
    else throw new Error(`未知参数：${arg}`);
  }
  if (!Number.isInteger(options.cdpPort ?? DEFAULT_CDP_PORT) || (options.cdpPort ?? 1) <= 0) {
    throw new Error('--cdp-port 必须是正整数');
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 60_000) {
    throw new Error('--timeout-ms 必须是 >= 60000 的整数');
  }
  return options;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function shortHead() {
  const r = spawnSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function candidateUserDataDirs(options) {
  return [
    options.userDataDir,
    process.env.XDT_USER_DATA_DIR,
    process.env.APPDATA ? path.join(process.env.APPDATA, 'CindyMeka-dev2-dev') : null,
    process.env.APPDATA ? path.join(process.env.APPDATA, 'CindyMeka') : null,
  ].filter(Boolean);
}

/** `<userData>/DevToolsActivePort` 第一行 = 本实例真实开的 CDP 端口（smoke 同款）。 */
function portFromUserData(userDataDir) {
  const file = path.join(userDataDir, 'DevToolsActivePort');
  if (!fs.existsSync(file)) return null;
  const port = Number(fs.readFileSync(file, 'utf8').split(/\r?\n/)[0]?.trim());
  return Number.isInteger(port) && port > 0 ? port : null;
}

function resolvePort(options) {
  if (options.cdpPort) return { port: options.cdpPort, source: '--cdp-port' };
  const envPort = Number(process.env.XDT_CDP_PORT);
  if (Number.isInteger(envPort) && envPort > 0) return { port: envPort, source: 'XDT_CDP_PORT' };
  for (const dir of candidateUserDataDirs(options)) {
    const port = portFromUserData(dir);
    if (port) return { port, source: `DevToolsActivePort(${dir})` };
  }
  return { port: DEFAULT_CDP_PORT, source: '默认 9222' };
}

// ── CDP 客户端（逐字复用 smoke 的实现，只补了 `flush` 与按键） ─────────────────────────
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
      const timer = setTimeout(() => reject(new Error('CDP websocket 连接超时')), STEP_TIMEOUT_MS);
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
    // **关键**（2026-11-18 实跑踩到并验证）：dev 实例的主窗口可能被最小化/隐藏
    // （`document.visibilityState === 'hidden'`）。隐藏文档里 CSS 动画不推进 ⇒
    // ① Radix 已关闭的弹窗会以遮罩形态永久留在 DOM 里盖住整个界面（侧栏点不到）；
    // ② 合成鼠标事件不会更新 `:hover`（入口是 hover 才 point-events-auto 的）。
    // 打开焦点模拟后页面被判为 visible，遮罩的退场动画立即跑完并自行卸载，hover 也恢复正常。
    // 这是纯 CDP 侧的模拟，不改应用数据；断开连接后自动失效。
    await session.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
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
      throw new Error(`evaluate 失败：${detail}`);
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
    throw new Error(`等待超时：${label}`);
  }

  /** 坐标 → 真实鼠标事件点击（与人工点击同链路：React 合成事件、路由、持久化都会真实发生）。 */
  async clickAt(box) {
    if (!box) return false;
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, buttons: 0 });
    await sleep(320);
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

  async clickElement(expr) {
    return this.clickAt(await this.boxOf(expr));
  }

  async pressDigit(digit) {
    const text = String(digit);
    const keyCode = 48 + Number(text);
    for (const type of ['keyDown', 'keyUp']) {
      await this.send('Input.dispatchKeyEvent', {
        type,
        key: text,
        code: `Digit${text}`,
        windowsVirtualKeyCode: keyCode,
        ...(type === 'keyDown' ? { text } : {}),
      });
    }
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

/**
 * 在端口上挑**主窗口 renderer 页**（不写死 5173/5174）。
 * 排除辅助窗口的规则与 smoke 完全一致（dev 启动会额外开 `?remoteDesktopViewer=1` 等窗口；
 * 连错窗口会得到一串误导性结论），并优先选择不带查询串的页面。
 * 返回 `{target, pages, all}`，由调用方打印诊断。
 */
async function pickRendererTarget(port) {
  let all;
  try {
    all = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  } catch (error) {
    return {
      ok: false,
      reason:
        `连不上 CDP 端口 ${port}（${error.message}）。可操作诊断：①该实例是否以 CDP 起？` +
        `用 \`pnpm restart:desktop:remote\`（或设 XDT_CDP_PORT=${port}）重启；` +
        `②端口是否被别的进程占用？\`netstat -ano | findstr :${port}\` 后看 PID 对应的进程；` +
        '③若实例已经起来但不在此端口，用 --cdp-port 指定，或先关掉别的实例再重试；' +
        '④该实例 userData 下的 DevToolsActivePort 是否指向了另一个端口。',
      all: [],
      pages: [],
    };
  }
  const auxiliaryWindowPattern = /\?(sidebarWindow|resourceUsageWindow|remoteDesktopViewer|view=)/;
  const pages = all.filter((t) => t.type === 'page' && !auxiliaryWindowPattern.test(t.url ?? ''));
  const rendererPages = pages.filter((t) => /^https?:\/\//.test(t.url ?? ''));
  const target = rendererPages.find((t) => !(t.url ?? '').includes('?')) ?? rendererPages[0];
  if (!target?.webSocketDebuggerUrl) {
    return {
      ok: false,
      reason:
        `端口 ${port} 上没找到主窗口 renderer 页（该端口确有 CDP target，但没有 http(s) 页面）。` +
        `全部 target=${JSON.stringify(all.map((t) => ({ type: t.type, url: t.url })).slice(0, 12))}` +
        '。可操作诊断：①这个端口可能属于**另一个实例**（例如面板 WebView / 打包版 / 别的 dev 实例）；' +
        '②用 --cdp-port 指向目标实例，或先只保留一个 dev 实例再跑。',
      all,
      pages,
    };
  }
  return { ok: true, target, all, pages };
}

// ── 数据库（只读轮询；用于等待与取证，不写回） ─────────────────────────────────────
function candidateDbFiles(options) {
  const files = [];
  for (const dir of candidateUserDataDirs(options)) {
    if (!fs.existsSync(dir)) continue;
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((name) => /^cindy-meka-.*\.db$/.test(name));
    } catch {
      continue;
    }
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        files.push({ file, mtimeMs: fs.statSync(file).mtimeMs });
      } catch {
        /* 忽略瞬时不可读 */
      }
    }
  }
  // dev 实例正在写的库 mtime 最新；同目录多 owner 库时也能优先命中活跃那个。
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs).map((entry) => entry.file);
}

class DbPool {
  constructor(files) {
    this.files = files;
    this.Database = require('better-sqlite3');
    /** 观测到目标会话的库（发送前未知）；命中后把轮询收窄到它，避免每轮全扫。 */
    this.primary = null;
  }

  withDb(file, fn) {
    const db = new this.Database(file, { readonly: true, fileMustExist: true });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }

  /** 依次在候选库里执行；任何一库不可读（被别的实例锁/已删除）时跳过而不是整体失败。 */
  each(fn) {
    const files = this.primary ? [this.primary] : this.files;
    for (const file of files) {
      try {
        const value = this.withDb(file, fn);
        if (value !== undefined && value !== null) return { file, value };
      } catch {
        /* 跳过读不到的库 */
      }
    }
    return { file: null, value: null };
  }

  sessionIds() {
    const ids = new Set();
    for (const file of this.files) {
      try {
        for (const row of this.withDb(file, (db) => db.prepare('SELECT id FROM sessions').all())) {
          ids.add(row.id);
        }
      } catch {
        /* 跳过 */
      }
    }
    return ids;
  }

  /** 找发送后新落库、且属于该 Meka 项目的会话行。 */
  findNewSession(beforeIds, projectId) {
    const hit = this.each((db) =>
      db
        .prepare(
          `SELECT id, title, workspace_kind, meka_project_id, meka_role_id, is_formal, working_dir,
                  permission_mode, status, created_at
             FROM sessions
            ORDER BY created_at DESC LIMIT 20`,
        )
        .all()
        .find(
          (row) =>
            !beforeIds.has(row.id) &&
            row.workspace_kind === 'meka' &&
            row.meka_project_id === projectId,
        ),
    );
    if (hit.value) this.primary = hit.file;
    return hit.value ?? null;
  }

  sessionRow(sessionId) {
    const hit = this.each((db) =>
      db
        .prepare(
          `SELECT id, title, workspace_kind, meka_project_id, meka_role_id, is_formal, working_dir,
                  permission_mode, status, active_turn_started_at, last_turn_ended_at, created_at, updated_at
             FROM sessions WHERE id = ?`,
        )
        .get(sessionId),
    );
    return hit.value ?? null;
  }

  messageRows(sessionId) {
    const hit = this.each((db) =>
      db
        .prepare(
          `SELECT id, client_id, role, content, tool_use_id, created_at, agent_kind
             FROM messages WHERE session_id = ? ORDER BY created_at, id`,
        )
        .all(sessionId),
    );
    return hit.value ?? [];
  }

  /** 还在等用户回答的 ask_user 行（`content.status === 'pending'`，按出现顺序取最早一条）。 */
  pendingAskUser(sessionId) {
    const rows = this.messageRows(sessionId).filter((row) => row.role === 'ask_user');
    for (const row of rows) {
      const content = parseJsonLoose(row.content);
      if (content && content.status === 'pending' && typeof content.requestId === 'string') {
        return {
          requestId: content.requestId,
          questions: Array.isArray(content.questions) ? content.questions : [],
          raw: content,
          messageId: row.id,
        };
      }
    }
    return null;
  }
}

function parseJsonLoose(text) {
  if (typeof text !== 'string' || !text) return null;
  const trimmed = text.trim();
  if (!/^[[{]/.test(trimmed)) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * 工具结果解析。两种形态都要认：
 *   ① 正常结果：直接是 JSON 字符串（`{"ok":true,"result":{…}}`）；
 *   ② 宿主包住的错误：`<tool_use_error>{…}</tool_use_error>`（meka-submit 的
 *      `AUTH_INVALID` / `SINGLE_TICKET_REQUIRED` 都以这种形态出现）。
 */
function parseToolResult(raw) {
  const text = typeof raw === 'string' ? raw : String(raw ?? '');
  const wrapped = /^<tool_use_error>([\s\S]*)<\/tool_use_error>$/.exec(text.trim());
  const payloadText = wrapped ? wrapped[1] : text;
  const json = parseJsonLoose(payloadText);
  const errorCode =
    json && typeof json.errorCode === 'string' ? json.errorCode : wrapped ? 'TOOL_USE_ERROR' : null;
  const ok = json && typeof json.ok === 'boolean' ? json.ok : wrapped ? false : null;
  const message = json && typeof json.message === 'string' ? json.message : null;
  return {
    raw: text,
    wrappedInToolError: Boolean(wrapped),
    ok,
    errorCode,
    message,
    payload: json,
  };
}

/** ghost_call 的二级操作名（插件侧真正执行的那一步，例如 `jira_issues` / `submit_confirm`）。 */
function pluginOpOf(input) {
  if (!input || typeof input !== 'object') return null;
  const args = input.args;
  if (input.tool === 'call_tool' && args && typeof args === 'object' && typeof args.name === 'string') {
    return args.name;
  }
  return null;
}

/** 递归找带真实标题的 Jira 候选（PSB 的 jira_issues 约定是 `items[].summary`）。 */
function collectJiraTickets(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectJiraTickets(item, out);
    return out;
  }
  if (value && typeof value === 'object') {
    if (typeof value.summary === 'string' && value.summary.trim()) {
      const key = value.key ?? value.jiraKey ?? value.issueKey ?? value.id ?? null;
      out.push({ key: typeof key === 'string' ? key : null, summary: value.summary.trim() });
    }
    for (const item of Object.values(value)) collectJiraTickets(item, out);
  }
  return out;
}

/** 结果摘要：控制报告体积（p4_status / p4_history 的返回可以几十 KB）。 */
function summarizeResult(res) {
  if (!res) return '（无结果行）';
  const { payload, errorCode, message, raw } = res;
  if (payload && typeof payload === 'object') {
    const result = payload.result && typeof payload.result === 'object' ? payload.result : payload;
    const picked = {};
    for (const key of [
      'runId', 'step', 'status', 'jiraKey', 'jiraSource', 'approvalToken', 'environment',
      'passed', 'ok', 'errorCode', 'message', 'items', 'total',
    ]) {
      if (key in result) picked[key] = result[key];
    }
    if (result.message && typeof result.message === 'object' && 'title' in result.message) {
      picked.message = { title: result.message.title, description: String(result.message.description ?? '').slice(0, 80) };
    }
    let text = JSON.stringify(picked);
    if (text.length < 40) text = JSON.stringify(payload).slice(0, 500);
    return text.slice(0, 900);
  }
  return `${errorCode ? `[${errorCode}] ` : ''}${message ?? raw.replace(/\s+/g, ' ').slice(0, 400)}`;
}

/**
 * 把该会话的全部消息收成「步骤 + 文本 + 错误码」证据。
 * 注意：`tool_use` / `tool_result` 通过 `tool_use_id` 配对，不按顺序假设（并行工具调用会交错）。
 */
function collectEvidence(db, sessionId) {
  const rows = db.messageRows(sessionId);
  const counts = {};
  const assistantTexts = [];
  const toolCalls = [];
  const askUsers = [];
  const byToolUseId = new Map();
  for (const row of rows) {
    counts[row.role] = (counts[row.role] ?? 0) + 1;
    if (row.role === 'assistant') {
      const text = typeof row.content === 'string' ? row.content : JSON.stringify(row.content);
      if (text && text.trim()) assistantTexts.push(text.trim());
    } else if (row.role === 'tool_use') {
      const parsed = parseJsonLoose(row.content) ?? {};
      const call = {
        toolUseId: parsed.toolUseId ?? row.tool_use_id ?? null,
        toolName: parsed.toolName ?? '(unknown)',
        input: parsed.input ?? null,
        createdAt: row.created_at,
        result: null,
      };
      toolCalls.push(call);
      if (call.toolUseId) byToolUseId.set(call.toolUseId, call);
    } else if (row.role === 'tool_result') {
      const call = row.tool_use_id ? byToolUseId.get(row.tool_use_id) : null;
      const parsed = parseToolResult(row.content);
      if (call) call.result = parsed;
      else toolCalls.push({ toolUseId: row.tool_use_id ?? null, toolName: '(orphan)', input: null, result: parsed });
    } else if (row.role === 'ask_user') {
      const content = parseJsonLoose(row.content) ?? {};
      askUsers.push({
        requestId: content.requestId ?? null,
        status: content.status ?? null,
        questions: Array.isArray(content.questions) ? content.questions : [],
        answers: content.answers ?? null,
      });
    }
  }
  const steps = toolCalls.map((call, index) => {
    const res = call.result;
    const pluginOp = pluginOpOf(call.input);
    const ghostId =
      call.input && typeof call.input === 'object' && typeof call.input.ghost_id === 'string'
        ? call.input.ghost_id
        : null;
    return {
      n: index + 1,
      tool: call.toolName,
      // 保留 toolUseId：`buildChecks` 要靠它把 `jira_issues` 的 tool_use 与它的 tool_result 配对
      // （并行工具调用会交错，按顺序配对会错位）。
      toolUseId: call.toolUseId ?? null,
      pluginOp,
      ghostId,
      ok: res ? res.ok : null,
      errorCode: res?.errorCode ?? null,
      summary: summarizeResult(res),
      input: compactInput(call.input),
    };
  });
  return {
    counts,
    assistantTexts,
    toolCalls,
    steps,
    askUsers,
    lastAssistantText: assistantTexts.at(-1) ?? null,
  };
}

/** 输入摘要：只保留判断「它到底调了哪一步」需要的字段。 */
function compactInput(input) {
  if (!input || typeof input !== 'object') return null;
  const pick = {};
  for (const key of ['ghost_id', 'tool', 'namespace', 'name', 'category', 'server', 'query']) {
    if (input[key] !== undefined) pick[key] = input[key];
  }
  if (input.args && typeof input.args === 'object') {
    const args = input.args;
    for (const key of ['name', 'category']) {
      if (args[key] !== undefined) pick[key] = args[key];
    }
    if (args.args && typeof args.args === 'object') pick.opArgs = trimJson(args.args, 400);
  }
  return Object.keys(pick).length ? pick : null;
}

function trimJson(value, max) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    return null;
  }
  return text.length > max ? `${text.slice(0, max)}…(${text.length} chars)` : text;
}

// ── 侧栏 Meka 项目树（复用 smoke 的两套布局探测与入口点击） ─────────────────────────
const BY_LABEL = (label) =>
  `[...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '') === ${JSON.stringify(label)})`;
const ROLE_PICKER = '选择 Meka 角色';
const MEKA_SECTION_TOGGLE = `[...document.querySelectorAll('button')].find((b) => /展开 Meka 对话|收起 Meka 对话/.test(b.getAttribute('aria-label') || ''))`;
const projectRow = (projectName) =>
  `[...document.querySelectorAll('[role=button]')].find((e) => (e.textContent || '').toLowerCase().includes(${JSON.stringify(projectName.toLowerCase())}) && e.getAttribute('aria-expanded') !== null)`;
const subgroupHeader = (label) =>
  `[...document.querySelectorAll('[role=button]')].find((e) => (e.textContent || '').trim() === ${JSON.stringify(label)} && e.getAttribute('aria-expanded') !== null)`;
const SESSION_ROW_SELECTOR =
  '[data-sidebar-session-row="true"], [data-sidebar-navigation-row="true"]';
const MEKA_SUBGROUP_LABELS = ['正式流程', '普通对话'];
/** 三种项目作用域新建入口的 aria-label 模板（与 i18n 的 `{{project}}` 插值逐字一致）。 */
const MEKA_ENTRY_LABEL_TEMPLATES = {
  flat: '在 {{project}} 中新建对话',
  regular: '在 {{project}} 中新建普通对话',
  formal: '在 {{project}} 中新建正式流程对话',
};
const mekaEntryLabel = (kind, projectName) =>
  MEKA_ENTRY_LABEL_TEMPLATES[kind].replace('{{project}}', projectName);

/** 展开侧栏 Meka 段与项目行，返回项目行在侧栏里的真实可见标签。 */
async function ensureMekaTreeVisible(session, projectName) {
  await session.evaluate(`location.hash = '#/cc-agent/new'`);
  await sleep(1800);
  const toggle = await session.evaluate(`${MEKA_SECTION_TOGGLE}?.getAttribute('aria-label') ?? null`);
  if (toggle && toggle.includes('展开')) {
    await session.clickAt(await session.boxOf(MEKA_SECTION_TOGGLE));
    await sleep(900);
  }
  const rowExpr = projectRow(projectName);
  if ((await session.evaluate(`${rowExpr}?.getAttribute('aria-expanded') ?? null`)) === 'false') {
    await session.clickAt(await session.boxOf(rowExpr));
    await sleep(900);
  }
  return session.evaluate(`${rowExpr}?.textContent?.replace(/\\s+/g, ' ').trim() ?? null`);
}

/**
 * 探测**已展开**的项目组容器实际渲染了哪一套布局（信号互相印证才下结论，自相矛盾不猜）。
 * 与 smoke 完全同构：①子组头文案；②三种项目级入口的挂载点；③会话行是否落在子组容器里。
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
    return {
      projectLabel,
      headerLabels,
      treeNodeCount: treeNodes.length,
      treeNodeLabels: treeNodes.map(textOf),
      sessionRowCount: sessionRows.length,
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
    hasNoHeader && signals.flatEntryOnRow && !signals.regularEntryOnHeader && !signals.formalEntryOnHeader;
  const subgroupSignals =
    hasEveryHeader && signals.regularEntryOnHeader && signals.formalEntryOnHeader && !signals.flatEntryOnRow;
  if (flatSignals && !subgroupSignals) {
    return { ok: true, layout: 'flat', projectLabel: signals.projectLabel, signals };
  }
  if (subgroupSignals && !flatSignals) {
    return { ok: true, layout: 'subgroups', projectLabel: signals.projectLabel, signals };
  }
  return {
    ok: false,
    reason:
      '侧栏项目组的布局信号自相矛盾或两组信号都不完整（无法判定扁平/两子组）：' +
      JSON.stringify({
        headerLabels: signals.headerLabels,
        treeNodeLabels: signals.treeNodeLabels,
        flatEntryOnRow: signals.flatEntryOnRow,
        regularEntryOnHeader: signals.regularEntryOnHeader,
        formalEntryOnHeader: signals.formalEntryOnHeader,
        entryLabels: signals.entryLabels,
      }),
  };
}

/**
 * 建 Meka 草稿：按**探测到的布局**把真实鼠标事件打到正确入口上。
 * 入口住在 `opacity-0 pointer-events-none` + `group-hover:pointer-events-auto` 的容器里，
 * 所以必须先 hover 宿主（项目行 / 子组头），否则真实鼠标事件会落到宿主（折叠开关）上。
 */
async function createMekaDraft(session, projectName) {
  const detected = await resolveMekaProjectLayout(session, projectName);
  if (!detected.ok) return detected;
  const { layout, projectLabel } = detected;
  const entryKind = layout === 'flat' ? 'flat' : 'regular';
  const hostExpr = layout === 'flat' ? projectRow(projectName) : subgroupHeader(MEKA_SUBGROUP_LABELS[1]);
  const host = await session.boxOf(hostExpr);
  if (!host) {
    return {
      ok: false,
      reason:
        layout === 'flat'
          ? `未找到项目行「${projectLabel}」（无法 hover 出项目级新建入口）`
          : `未找到子组头「${MEKA_SUBGROUP_LABELS[1]}」`,
    };
  }
  const label = mekaEntryLabel(entryKind, projectLabel);
  // 入口的容器带「group-hover 才 pointer-events-auto」；先 hover 宿主，再**把入口 focus 一次**
  // ——`focus-within:pointer-events-auto` 是同一条契约的键盘通道，也是窗口不可见（hover 不生效）
  // 时唯一还能让入口可点的方式。两条都做，任何一条生效即可。
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: host.x, y: host.y, buttons: 0 });
  await sleep(700);
  await session.evaluate(`(${BY_LABEL(label)})?.focus()`).catch(() => {});
  await sleep(200);
  // 点之前先做命中测试：入口坐标上必须真的是这个入口（否则说明被遮罩/别的元素盖住，
  // 点下去只会落到宿主或遮罩上，白跑一轮）。
  const box = await session.boxOf(BY_LABEL(label));
  if (!box) {
    return {
      ok: false,
      reason:
        `未找到新建入口「${label}」（项目组内与「新建」有关的 aria-label=` +
        `${JSON.stringify(detected.signals.entryLabels)}）`,
    };
  }
  const hit = await session.evaluate(`(() => {
    const el = ${BY_LABEL(label)};
    const r = el ? el.getBoundingClientRect() : null;
    if (!r) return null;
    const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
    const top = document.elementFromPoint(cx, cy);
    return {
      cx, cy,
      topTag: top ? top.tagName : null,
      topAria: top ? top.getAttribute('aria-label') : null,
      topClass: top ? (top.className || '').toString().slice(0, 80) : null,
      isEntry: !!top && (top === el || el.contains(top)),
    };
  })()`);
  if (!hit?.isEntry) {
    return {
      ok: false,
      reason:
        `新建入口「${label}」被其它元素盖住（命中=${hit ? `${hit.topTag}[${hit.topAria ?? hit.topClass}]` : 'null'}），` +
        '点击不会到达入口。常见原因：窗口不可见导致 Radix 退场动画没结束、遮罩残留在 DOM 里；' +
        '先把 dev 实例窗口切到前台、关掉挡在前面的弹窗再重跑',
    };
  }
  await session.clickAt(box);
  await sleep(2400);
  return { ok: true, layout, projectLabel, entryLabel: label, signals: detected.signals, hit };
}

/** 等草稿页的 Meka 角色选择器出现（= 草稿真的绑上了项目/角色），返回它的可见文案。 */
async function waitForRoleChip(session, timeoutMs = CARD_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const chip = await session
      .evaluate(`${BY_LABEL(ROLE_PICKER)}?.textContent?.trim() ?? null`)
      .catch(() => null);
    if (chip) return chip;
    await sleep(400);
  }
  return null;
}

/**
 * 界面「挡板」探测：`.modal-scrim`（模态遮罩，含 Radix 的退场残留）与 dialog/alertdialog。
 * 为什么必须有这一层（2026-11-18 实跑教训）：dev 实例的主窗口若被最小化/隐藏
 * （`document.visibilityState === 'hidden'`），CSS 动画不推进 ⇒ Radix 的**已关闭**弹窗会以
 * `data-state="closed"` 的形态把整窗遮罩留在 DOM 里，于是侧栏点击/悬停全部落到遮罩上：
 * 侧栏入口点不到、草稿建不出、消息发不出，而脚本会误以为「点了」并一路走到超时。
 * 这里把「界面可交互」做成硬前置，并在失败信息里写清是哪种挡板。
 */
const OVERLAY_PROBE = `(() => {
  const scrims = [...document.querySelectorAll('.modal-scrim')]
    .filter((el) => getComputedStyle(el).pointerEvents !== 'none');
  const scrim = scrims[scrims.length - 1] || null;
  const dialogs = [...document.querySelectorAll('[role="alertdialog"],[role="dialog"]')];
  const dialog = dialogs[dialogs.length - 1] || null;
  const owner = dialog || scrim;
  const titleNode = dialog ? dialog.querySelector('h2') : null;
  return {
    present: !!scrim || !!dialog,
    scrimCount: scrims.length,
    dialogTitle: titleNode ? (titleNode.textContent || '').trim() : null,
    dialogState: dialog ? dialog.getAttribute('data-state') : null,
    text: owner ? (owner.innerText || '').replace(/\\n+/g, ' | ').slice(0, 500) : '',
  };
})()`;

/** 把挡板分类。`ghost-confirm` 由确认框处理器负责，其余都算「挡住界面的东西」。 */
async function readBlockingOverlay(session) {
  const probe = await session.evaluate(OVERLAY_PROBE);
  if (!probe?.present) return null;
  if (probe.dialogTitle && probe.dialogTitle.startsWith(GHOST_CONFIRM_TITLE_PREFIX)) {
    return { ...probe, kind: 'ghost-confirm' };
  }
  if (probe.text.includes('继续上次中断的任务')) return { ...probe, kind: 'interrupted-resume' };
  return { ...probe, kind: 'other' };
}

/**
 * 主窗口可交互性前置：`Page.bringToFront` 尽力把窗口提到前台，然后判定
 *   ① `document.visibilityState` 是否 visible（隐藏窗口下 hover/合成点击都不可靠）；
 *   ② 是否有模态遮罩（除了插件确认框以外）挡住整窗。
 * `--dry-run` 只记录不失败（它的职责就是探测环境）；真实运行失败即前置退出。
 */
async function assertRendererInteractive(session, report, { dryRun }) {
  await session.send('Page.bringToFront').catch(() => {});
  await sleep(300);
  const state = await session.evaluate(`(() => {
    const scrim = document.querySelector('.modal-scrim');
    return {
      visibility: document.visibilityState,
      hasFocus: document.hasFocus(),
      scrimPresent: !!scrim,
      scrimPointerEvents: scrim ? getComputedStyle(scrim).pointerEvents : null,
      viewport: [window.innerWidth, window.innerHeight],
    };
  })()`);
  const overlay = await readBlockingOverlay(session);
  const environment = { ...state, overlay };
  report.environment = environment;
  const problems = [];
  if (state.visibility !== 'visible') {
    problems.push(
      `主窗口当前不可见（document.visibilityState=${state.visibility}）：窗口被最小化/隐藏时` +
        'CSS 动画不推进，Radix 的已关闭弹窗会把遮罩留在 DOM 里挡住整个界面，' +
        '侧栏入口（hover 才可点）与合成点击都不可靠',
    );
  }
  if (overlay && overlay.kind === 'other') {
    problems.push(`界面被模态框挡住：「${overlay.text.slice(0, 120)}」`);
  }
  if (overlay && overlay.kind === 'interrupted-resume') {
    problems.push(
      `界面被「继续上次中断的任务」弹窗挡住（正文=${JSON.stringify(overlay.text.slice(0, 120))}）：` +
        '先在这个弹窗里点「暂不继续」再重跑（脚本不会代替你选「继续」，那会对中断任务发起真实续跑）',
    );
  }
  if (problems.length && !dryRun) return { ok: false, reason: problems.join('；'), environment };
  return { ok: true, environment, problems };
}

/** 把主窗口导航到该会话路由（提问卡片只在会话视图里渲染）。已经在就不动 hash。 */
async function ensureSessionRoute(session, sessionId) {
  const hash = await session.evaluate('location.hash');
  if (typeof hash === 'string' && hash.includes(sessionId)) return;
  await session.evaluate(`location.hash = '#/cc-agent/${sessionId}'`);
  await sleep(1800);
}

/**
 * 发消息（与 smoke 同一条真实链路：contenteditable + insertText + 点「发送」）。
 *
 * 比 smoke 多两步**验证**，因为「点了发送但消息没发出去」在 e2e 里是灾难性的静默失败
 * （2026-11-18 实跑撞到过：草稿没绑到项目、text 也没落进 composer，脚本却以为发出去了）：
 *   ① 插完文本后回读 `contenteditable` 的真实文本长度，为空就重试一次；
 *   ② 发送按钮必须是 enabled 状态才点，点完回读「输入框已清空」作为发出的旁证。
 */
async function sendMessage(session, text) {
  const composerState = `(() => {
    const editor = document.querySelector('[contenteditable="true"]');
    const send = [...document.querySelectorAll('button')].find((b) => /发送/.test(b.getAttribute('aria-label') || ''));
    return {
      textLen: (editor?.innerText || '').trim().length,
      editorText: (editor?.innerText || '').slice(0, 120),
      sendFound: !!send,
      sendDisabled: send ? send.disabled === true : null,
    };
  })()`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const editor = await session.boxOf(`document.querySelector('[contenteditable="true"]')`);
    if (!editor) return { ok: false, reason: '界面上找不到消息输入框（contenteditable）' };
    await session.clickAt(editor);
    await sleep(400);
    await session.send('Input.insertText', { text });
    await sleep(600);
    let state = await session.evaluate(composerState);
    if (!state?.textLen) {
      // 焦点没落进 composer（窗口刚重挂载 / 动画中）时文本会丢掉：再点一次并重插。
      await session.clickAt(await session.boxOf(`document.querySelector('[contenteditable="true"]')`));
      await sleep(300);
      await session.send('Input.insertText', { text });
      await sleep(800);
      state = await session.evaluate(composerState);
    }
    if (!state?.textLen) return { ok: false, reason: '消息输入框里始终没有落下文本（输入链路未生效）' };
    const box = await session.boxOf(
      `[...document.querySelectorAll('button')].find((b) => /发送/.test(b.getAttribute('aria-label') || ''))`,
    );
    if (!box) return { ok: false, reason: '找不到发送按钮' };
    if (state.sendDisabled) continue; // 有文本但按钮仍 disabled：再试一轮
    await session.clickAt(box);
    await sleep(1200);
    const after = await session.evaluate(composerState);
    return {
      ok: true,
      sentText: state.editorText,
      composerCleared: (after?.textLen ?? 0) === 0,
    };
  }
  return { ok: false, reason: '发送按钮在输入文本后仍处于 disabled，没能发出消息' };
}

// ── ask 卡片 / 确认框的 DOM 挂钩 ────────────────────────────────────────────────
const ASK_CARD_PROBE = `(() => {
  const restore = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '') === ${JSON.stringify(ASK_RESTORE_ARIA)});
  const region = document.querySelector('[data-testid="interaction-prompt-scroll-region"]');
  const root = region ? region.parentElement?.parentElement ?? null : null;
  const cardText = root ? (root.innerText || '') : '';
  // 题干可能含换行；cardText 用「 | 」替代换行便于人读，**匹配用**的 plain 版本只折叠空白。
  const cardPlain = root ? (root.textContent || '').replace(/\\s+/g, ' ').trim() : '';
  const allOptionNodes = region ? [...region.querySelectorAll('button, label')] : [];
  const optionNodes = allOptionNodes.filter(
    (el) => !allOptionNodes.some((other) => other !== el && other.contains(el)),
  );
  return {
    present: !!region || !!restore,
    minimized: !region && !!restore,
    cardText: cardText.replace(/\\n+/g, ' | ').slice(0, 1200),
    cardPlain: cardPlain.slice(0, 2000),
    optionCount: optionNodes.length,
    options: optionNodes.map((el) => (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 200)),
    validationError: (() => {
      const alert = root ? root.querySelector('[role="alert"]') : null;
      return alert ? (alert.textContent || '').trim().slice(0, 300) : null;
    })(),
  };
})()`;

const ASK_OPTION_EXPR = (index) => `(() => {
  const region = document.querySelector('[data-testid="interaction-prompt-scroll-region"]');
  if (!region) return null;
  const all = [...region.querySelectorAll('button, label')];
  // 与 ASK_CARD_PROBE 的过滤规则一致：只取最外层行元素，避免内在 Checkbox 撑开下标。
  const rows = all.filter((el) => !all.some((other) => other !== el && other.contains(el)));
  return rows[${index}] || null;
})()`;
const ASK_CUSTOM_ROW_EXPR = `[...document.querySelectorAll('button')].find((b) => (b.innerText || '').includes(${JSON.stringify(ASK_CUSTOM_ROW_TEXT)}))`;
const ASK_COMPOSER_EXPR = `[...document.querySelectorAll('[data-testid="interaction-answer-composer"]')].pop()`;
const ASK_COMPOSER_TEXTAREA_EXPR = `${ASK_COMPOSER_EXPR}?.querySelector('textarea')`;

/** 插件确认框（Radix AlertDialog）：主按钮永远是 DOM 里最后一个 button（见 confirm-dialog.tsx）。 */
const CONFIRM_PROBE = `(() => {
  const dialogs = [...document.querySelectorAll('[role="alertdialog"]')];
  const dialog = dialogs[dialogs.length - 1];
  if (!dialog) return null;
  const buttons = [...dialog.querySelectorAll('button')];
  return {
    title: (dialog.querySelector('h2')?.textContent || '').trim(),
    text: (dialog.innerText || '').replace(/\\n+/g, ' | ').slice(0, 1500),
    buttons: buttons.map((b) => ({
      label: (b.innerText || '').replace(/\\s+/g, ' ').trim(),
      ariaLabel: b.getAttribute('aria-label') || '',
    })),
  };
})()`;

const CONFIRM_ACTION_EXPR = `(() => {
  const dialogs = [...document.querySelectorAll('[role="alertdialog"]')];
  const dialog = dialogs[dialogs.length - 1];
  if (!dialog) return null;
  const buttons = [...dialog.querySelectorAll('button')];
  return buttons[buttons.length - 1] || null;
})()`;

const CONFIRM_CANCEL_EXPR = `(() => {
  const dialogs = [...document.querySelectorAll('[role="alertdialog"]')];
  const dialog = dialogs[dialogs.length - 1];
  if (!dialog) return null;
  const buttons = [...dialog.querySelectorAll('button')];
  return buttons[0] || null;
})()`;

async function readAskCard(session) {
  return session.evaluate(ASK_CARD_PROBE);
}

/** 等卡片「推进」：要么卸载（整批问题答完），要么换成下一题（多题/多选场景）。 */
async function waitCardAdvance(session, beforeText, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let card = await readAskCard(session);
  while (Date.now() < deadline) {
    if (!card.present || card.cardText !== beforeText) return card;
    await sleep(400);
    card = await readAskCard(session);
  }
  return card;
}

async function readConfirmDialog(session) {
  return session.evaluate(CONFIRM_PROBE);
}

/**
 * 「允许 / 拒绝」类权限卡（本脚本**不**自动批准，只负责认出它并写出诊断）。
 * 判据收紧到「交互卡片壳里出现允许/拒绝按钮」：全局扫「允许」两个字会把侧栏/通知里的
 * 无关按钮误判成权限卡（bypassPermissions 会话本来不该出现权限卡）。
 */
async function readPermissionPrompt(session) {
  return session.evaluate(
    `(() => {
      const region = document.querySelector('[data-testid="interaction-prompt-scroll-region"]');
      if (!region) return null;
      const root = region.parentElement?.parentElement ?? document.body;
      const hit = [...root.querySelectorAll('button')]
        .map((button) => button.getAttribute('aria-label') || '')
        .filter((label) => /允许|拒绝/.test(label));
      if (!hit.length) return null;
      return { labels: hit.slice(0, 8), text: (root.innerText || '').replace(/\\n+/g, ' | ').slice(0, 1200) };
    })()`,
  );
}

// ── 自动作答（不猜：只按 --answer 的顺序作答，缺参数就判卡住） ────────────────────────
function optionLabelsOf(question) {
  const options = Array.isArray(question?.options) ? question.options : [];
  return options
    .map((option) => (option && typeof option.label === 'string' ? option.label : null))
    .filter((label) => typeof label === 'string' && label.trim());
}

/**
 * 把 `--answer` 的值映射到该题的一个选项 / 一段自由文本。规则（命中即停，歧义不猜）：
 *   ① 与某个选项**逐字相等**；
 *   ② 值是选项编号（`1`-`N`，与卡片数字键编号一致）；
 *   ③ 值是某个选项的**子串**（或选项是它的子串）——**必须唯一**，多个命中就报歧义。
 *   ④ 都没命中 → 走「输入其他回答…」自由文本；但题目声明了 `answerConstraints.choices`
 *      时不存在自由文本，直接报「无法作答」。
 */
function resolveAnswerForQuestion(question, answerText) {
  const labels = optionLabelsOf(question);
  if (!answerText) return { missing: true };
  if (labels.length) {
    const exact = labels.filter((label) => label === answerText);
    if (exact.length === 1) {
      return { mode: 'option', index: labels.indexOf(exact[0]), label: exact[0], rule: 'exact' };
    }
    if (/^[1-9]\d?$/.test(answerText.trim())) {
      const index = Number(answerText.trim()) - 1;
      if (index < labels.length) {
        return { mode: 'option', index, label: labels[index], rule: 'index' };
      }
    }
    const fuzzy = labels.filter(
      (label) => label.includes(answerText) || answerText.includes(label),
    );
    if (fuzzy.length === 1) {
      return { mode: 'option', index: labels.indexOf(fuzzy[0]), label: fuzzy[0], rule: 'substring' };
    }
    if (fuzzy.length > 1) {
      return {
        missing: false,
        ambiguous: true,
        candidates: fuzzy,
        reason: `--answer「${answerText}」同时命中多个选项，脚本不猜`,
      };
    }
  }
  if (question?.answerConstraints?.choices) {
    return {
      missing: false,
      unsupported: true,
      reason: `题目声明了 answerConstraints.choices（只能从列出的选项里选），而 --answer「${answerText}」不在其中`,
    };
  }
  return { mode: 'custom', value: answerText, rule: 'free-text' };
}

function questionTextOf(question) {
  if (typeof question?.question === 'string' && question.question.trim()) return question.question.trim();
  if (typeof question?.header === 'string' && question.header.trim()) return question.header.trim();
  return '(题干缺失)';
}

/**
 * 按 DOM 里**当前展示的**那一题决定要答第几题：用题干文本在卡片文本（折叠空白后的 plain 版本）
 * 里比对（renderer 原样渲染题干）。比不到时返回 -1 —— 调用方**不猜**，直接判卡住。
 */
function currentQuestionIndex(questions, cardPlain) {
  const plain = String(cardPlain ?? '');
  return questions.findIndex((question) => {
    const text = questionTextOf(question).replace(/\s+/g, ' ').trim();
    return text && plain.includes(text);
  });
}

/**
 * 处理一次 ask_user 请求：逐题作答，每答一题都等「卡片文本变化 / 卡片消失」再推进；
 * 任何一步失败都把「卡在哪一题、题干、选项、已答了什么」原样返回，绝不继续猜。
 * `answerQueue` 是 `--answer` 的剩余队列（跨请求按出现顺序消费）。
 */
async function answerAskRequest({ session, pending, answerQueue, report }) {
  const questions = pending.questions;
  if (!questions.length) {
    return { ok: false, reason: 'ask_user 行里没有 questions 字段（结构不认识，不猜）', detail: trimJson(pending.raw, 600) };
  }
  const plan = questions.map((question) => resolveAnswerForQuestion(question, answerQueue.shift()));
  const firstMissing = plan.findIndex((item) => item.missing);
  if (firstMissing !== -1) {
    const question = questions[firstMissing];
    return {
      ok: false,
      kind: 'ask_user',
      reason: `出现提问，但没有对应的 --answer（第 ${firstMissing + 1} 题）`,
      stuck: {
        requestId: pending.requestId,
        questionIndex: firstMissing,
        question: questionTextOf(question),
        header: typeof question?.header === 'string' ? question.header : null,
        options: optionLabelsOf(question),
        questions: questions.map(questionTextOf),
      },
    };
  }
  const unsupported = plan.findIndex((item) => item.unsupported || item.ambiguous);
  if (unsupported !== -1) {
    return {
      ok: false,
      kind: 'ask_user',
      reason: plan[unsupported].reason,
      stuck: {
        requestId: pending.requestId,
        questionIndex: unsupported,
        question: questionTextOf(questions[unsupported]),
        options: optionLabelsOf(questions[unsupported]),
        candidates: plan[unsupported].candidates ?? null,
      },
    };
  }

  const answered = [];
  for (let step = 0; step < questions.length; step += 1) {
    // 卡片要先在 DOM 里（库行先落，renderer 后画），折叠态先展开。
    const deadline = Date.now() + CARD_WAIT_MS;
    let card = await readAskCard(session);
    while (!card.present && Date.now() < deadline) {
      await sleep(500);
      card = await readAskCard(session);
    }
    if (!card.present) {
      return { ok: false, reason: '出现 pending 提问，但问题卡片没有渲染出来（DOM 里找不到）', stuck: { requestId: pending.requestId } };
    }
    if (card.minimized) {
      await session.clickElement(BY_LABEL(ASK_RESTORE_ARIA));
      await sleep(700);
      card = await readAskCard(session);
    }
    const index = currentQuestionIndex(questions, card.cardPlain);
    if (index === -1) {
      return {
        ok: false,
        reason: '无法确定卡片当前展示的是哪一题（题干文本没有出现在卡片里），不猜',
        stuck: { requestId: pending.requestId, cardText: card.cardText, questions: questions.map(questionTextOf) },
      };
    }
    const question = questions[index];
    const item = plan[index];
    const before = card.cardText;
    let actionEvidence;
    if (item.mode === 'option') {
      const domCount = card.optionCount;
      const expectedCount = optionLabelsOf(question).length;
      const multiSelect = question?.multiSelect === true;
      await session.clickElement(ASK_OPTION_EXPR(item.index));
      await sleep(900);
      let after = await readAskCard(session);
      // 兜底：真实鼠标点击若被遮罩吃掉（卡片在动画/有遮挡），改用卡片自带的数字快捷键——
      // 渲染端对 1..N 走的是**同一个** handleSingleSelect/handleToggle，语义一致。
      let usedNumberKey = false;
      if (after.present && after.cardText === before) {
        await session.pressDigit(item.index + 1);
        usedNumberKey = true;
        await sleep(900);
        after = await readAskCard(session);
      }
      // 多选卡片：勾选不会自动提交，还要按一次「提交 / 下一题」。
      if (multiSelect && after.present) {
        const submitBox = await session.boxOf(
          `(() => {
            const card = document.querySelector('[data-testid="interaction-prompt-scroll-region"]')?.parentElement?.parentElement;
            if (!card) return null;
            return [...card.querySelectorAll('button')].find((b) =>
              ${JSON.stringify(ASK_SUBMIT_LABELS)}.includes((b.innerText || '').replace(/\\s+/g, ' ').trim()),
            ) || null;
          })()`,
        );
        if (submitBox) {
          await session.clickAt(submitBox);
          await sleep(900);
          after = await readAskCard(session);
        }
      }
      actionEvidence = {
        mode: 'option',
        label: item.label,
        rule: item.rule,
        multiSelect,
        domOptionCount: domCount,
        domOptionCountMatchesModel: domCount === expectedCount,
        usedNumberKey,
        advanced: !after.present || after.cardText !== before,
        cardAfter: after.present ? after.cardText : null,
        validationError: after.validationError ?? null,
      };
      // 推进失败时先把卡片落定（动画/状态可能滞后），再决定是不是真的没点中。
      if (!actionEvidence.advanced) {
        after = await waitCardAdvance(session, before);
        actionEvidence.advanced = !after.present || after.cardText !== before;
        actionEvidence.cardAfter = after.present ? after.cardText : null;
        actionEvidence.validationError = after.validationError ?? actionEvidence.validationError;
      }
    } else {
      // 自由文本：点开「输入其他回答…」→ 点 textarea → Input.insertText（真实输入链路）→ 点提交。
      await session.clickElement(ASK_CUSTOM_ROW_EXPR);
      await sleep(700);
      const textarea = await session.boxOf(ASK_COMPOSER_TEXTAREA_EXPR);
      if (!textarea) {
        return {
          ok: false,
          reason: '点开「输入其他回答…」后没有出现答题输入框',
          stuck: { requestId: pending.requestId, question: questionTextOf(question) },
        };
      }
      await session.clickAt(textarea);
      await sleep(300);
      await session.send('Input.insertText', { text: item.value });
      await sleep(500);
      const submitBox = await session.boxOf(
        `(() => {
          const composer = ${ASK_COMPOSER_EXPR};
          if (!composer) return null;
          const buttons = [...composer.querySelectorAll('button')];
          return buttons.find((b) => ${JSON.stringify(ASK_SUBMIT_LABELS)}.includes(b.getAttribute('aria-label') || ''))
            || buttons[buttons.length - 1] || null;
        })()`,
      );
      if (!submitBox) {
        return {
          ok: false,
          reason: '答题输入框里找不到提交按钮',
          stuck: { requestId: pending.requestId, question: questionTextOf(question) },
        };
      }
      await session.clickAt(submitBox);
      await sleep(900);
      const after = await waitCardAdvance(session, before);
      actionEvidence = {
        mode: 'custom',
        value: item.value,
        rule: item.rule,
        advanced: !after.present || after.cardText !== before,
        cardAfter: after.present ? after.cardText : null,
        validationError: after.validationError ?? null,
      };
    }
    answered.push({
      requestId: pending.requestId,
      questionIndex: index,
      question: questionTextOf(question),
      answer: item.mode === 'option' ? item.label : item.value,
      mode: item.mode,
      rule: item.rule,
      options: optionLabelsOf(question),
      ...actionEvidence,
    });
    report.askUser.autoAnswers.push(answered.at(-1));
    if (actionEvidence.validationError) {
      return {
        ok: false,
        reason: `作答被界面校验拒绝：${actionEvidence.validationError}`,
        stuck: { requestId: pending.requestId, question: questionTextOf(question), options: optionLabelsOf(question) },
      };
    }
    if (!actionEvidence.advanced) {
      return {
        ok: false,
        reason: '作答操作后卡片没有推进（选项/提交按钮可能没点中，或答案被界面静默忽略），不重试、不猜',
        stuck: {
          requestId: pending.requestId,
          question: questionTextOf(question),
          options: optionLabelsOf(question),
          cardText: actionEvidence.cardAfter,
        },
      };
    }
  }
  // 用库行状态确认「真的被主机收下」：status 由 pending 翻成 answered（main 的 onInteractionResolved 写）。
  const deadline = Date.now() + ANSWER_SETTLE_MS;
  while (Date.now() < deadline) {
    const stillPending = MekaE2E.db.pendingAskUser(MekaE2E.sessionId);
    if (!stillPending || stillPending.requestId !== pending.requestId) return { ok: true, answered };
    await sleep(500);
  }
  return {
    ok: false,
    reason: '已按 --answer 操作界面，但库里该提问仍是 pending（主机没有收下答案）',
    stuck: { requestId: pending.requestId, answered },
  };
}

// 小仓库：把 run 期上下文放一处，避免把 session/db 一路透传（脚本级工具，非产品代码）。
const MekaE2E = { session: null, db: null, sessionId: null, options: null };

/**
 * 处理插件确认框。`--confirm` 时才点主按钮；否则点取消（= 不批准）并返回卡住。
 * 只处理 ghost 确认框（标题以「插件「」开头），其它 alertdialog 一律不碰。
 */
async function handleConfirmDialog({ session, options, report }) {
  const dialog = await readConfirmDialog(session);
  if (!dialog) return { ok: true, handled: false };
  if (!dialog.title.startsWith(GHOST_CONFIRM_TITLE_PREFIX)) {
    return {
      ok: false,
      handled: false,
      reason:
        `出现了非插件确认框（标题「${dialog.title}」），脚本不碰未知弹窗，也不猜它是不是提交闸门`,
      dialog,
    };
  }
  const occurrence = {
    title: dialog.title,
    text: dialog.text,
    buttons: dialog.buttons,
    autoConfirmed: false,
    declined: false,
    occurredAt: new Date().toISOString(),
  };
  if (options.confirm) {
    await session.clickElement(CONFIRM_ACTION_EXPR);
    occurrence.autoConfirmed = true;
  } else {
    await session.clickElement(CONFIRM_CANCEL_EXPR);
    occurrence.declined = true;
  }
  // 等弹窗真的关掉（点没点上 / 有没有第二个排队弹窗都要看见）。
  const deadline = Date.now() + CONFIRM_SETTLE_MS;
  let closed = false;
  while (Date.now() < deadline) {
    if (!(await readConfirmDialog(session))) {
      closed = true;
      break;
    }
    await sleep(500);
  }
  occurrence.closed = closed;
  report.confirmDialog.occurrences.push(occurrence);
  report.confirmDialog.encountered = true;
  if (!closed) {
    return { ok: false, handled: true, reason: options.confirm ? '点了确认但弹窗没有关闭' : '点了取消但弹窗没有关闭', dialog };
  }
  if (!options.confirm) {
    return {
      ok: false,
      handled: true,
      declined: true,
      reason:
        `出现插件确认框（${dialog.title}），未传 --confirm：脚本按「取消」处理并停下，等真人决定`,
      dialog,
      occurrence,
    };
  }
  return { ok: true, handled: true, reason: `已按 --confirm 点下确认框主按钮（${dialog.buttons.at(-1)?.label || '确认'}）`, occurrence };
}

// ── 报告 ────────────────────────────────────────────────────────────────────
function defaultOutPath() {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
  return path.join(ROOT, 'artifacts', 'meka-submit-e2e', `e2e-${stamp}.json`);
}

function writeReport(report, outPath) {
  const file = path.resolve(outPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return file;
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'n/a';
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** 报告里的「校验摘要」：交付前自测真正要盯的几个事实。 */
function buildChecks(evidence, report) {
  const steps = evidence.steps;
  const pluginSteps = steps.filter((step) => step.pluginOp);
  const opNames = pluginSteps.map((step) => step.pluginOp);
  const jiraSteps = steps.filter((step) => step.pluginOp === 'jira_issues' || /jira/i.test(step.tool));
  const jiraTickets = [];
  for (const step of jiraSteps) {
    const call = evidence.toolCalls.find((item) => item.toolUseId && item.toolUseId === step.toolUseId);
    const payload = call?.result?.payload;
    if (payload) collectJiraTickets(payload, jiraTickets);
  }
  const uniqueTickets = [];
  const seen = new Set();
  for (const ticket of jiraTickets) {
    const key = `${ticket.key ?? ''}\u0000${ticket.summary}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueTickets.push(ticket);
  }
  const errorCodes = {};
  for (const step of steps) {
    if (step.errorCode) errorCodes[step.errorCode] = (errorCodes[step.errorCode] ?? 0) + 1;
  }
  // 工具结果正文里出现的其余错误码（有些插件错误只在 message 里带 code）。
  // ⚠️ 只认**结构化**错误码，或在失败结果里以 `"errorCode":"CODE"` 形态出现的码：插件清单/召回
  // 文案里也写着 `SINGLE_TICKET_REQUIRED` / `GHOST_ASLEEP` 这些词（`ghost.json` 的 recall 正文
  // 就是这么写的），拿全文 includes 扫描会把「文档提到」误判成「本次真的返回了」，那会让校验摘要
  // 造假红/假绿（2026-11-18 实跑在 run1 上就撞到过这条假命中）。
  const watched = [
    'SINGLE_TICKET_REQUIRED',
    'JIRA_KEY_REQUIRED',
    'JIRA_KEY_MISMATCH',
    'REGISTRY_JIRA_MISMATCH',
    'GHOST_ASLEEP',
    'GHOST_NOT_FOUND',
    'AUTH_INVALID',
    'ENVIRONMENT_UNSUPPORTED',
  ];
  const failedText = evidence.steps
    .filter((step) => step.ok === false || step.errorCode)
    .map((step) => step.summary)
    .join('\n');
  const watchedHits = watched.filter(
    (code) =>
      code in errorCodes || new RegExp(`"errorCode"\\s*:\\s*"${code}"`).test(failedText),
  );

  const snapshotOps = [
    'list_tools',
    'submit_start',
    'environment_check',
    'submit_check',
    'submit_confirm',
    'submit_record',
    'submit_status',
    'jira_issues',
  ];
  const seenOps = Object.fromEntries(snapshotOps.map((op) => [op, opNames.includes(op)]));

  const findings = [];
  const jira = {
    called: seenOps.jira_issues,
    callCount: opNames.filter((op) => op === 'jira_issues').length,
    returnedTitles: uniqueTickets.length > 0,
    titles: uniqueTickets.slice(0, 10),
    errorCodes: [...new Set(jiraSteps.map((step) => step.errorCode).filter(Boolean))],
  };
  if (jira.called && !jira.returnedTitles) {
    findings.push(
      `jira_issues 调用了但没返回带标题的候选（errorCode=${jira.errorCodes.join(',') || '无'}）：` +
        '单号无法自动推断，插件必然转为问用户',
    );
  }
  if (!jira.called) findings.push('本轮没有出现 jira_issues 调用');
  if (jira.errorCodes.includes('AUTH_INVALID')) {
    findings.push('jira_issues 返回 AUTH_INVALID（PSB/Jira 凭证无效）—— 这是用户抱怨的「基础问题」之一');
  }
  if (watchedHits.includes('SINGLE_TICKET_REQUIRED')) {
    findings.push('出现 SINGLE_TICKET_REQUIRED（本次尝试覆盖多张 Jira 单，插件要求拆单）');
  }
  if (!seenOps.submit_confirm && !seenOps.submit_record) {
    findings.push('本轮未走到 submit_confirm / submit_record（没有进入真人确认与回执阶段）');
  }

  return {
    jiraIssues: jira,
    submitFlow: {
      submitStart: seenOps.submit_start,
      environmentCheck: seenOps.environment_check,
      submitCheck: seenOps.submit_check,
      submitConfirm: seenOps.submit_confirm,
      submitRecord: seenOps.submit_record,
      submitStatus: seenOps.submit_status,
      operations: opNames,
    },
    errorCodes,
    watchedErrorCodes: watchedHits,
    reachedConfirmDialog: report.confirmDialog.encountered,
    askUserAnswered: report.askUser.autoAnswers.length,
    findings,
  };
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
function printUsage() {
  console.log(
    [
      '用法：node scripts/meka-submit-e2e.mjs [--cdp-port N] [--user-data-dir DIR] [--project-id ID]',
      '        [--prompt TEXT] [--answer TEXT]... [--confirm] [--timeout-ms N] [--out PATH] [--dry-run]',
      '',
      '  --answer 可重复：按提问出现顺序逐个使用；不传 = 遇到提问直接判「卡住」（不猜）。',
      '  --confirm 会点插件确认框的主按钮；不传 = 按「取消」处理并停下。',
      '  报告默认写到 artifacts/meka-submit-e2e/e2e-<时间戳>.json（artifacts/ 已被 .gitignore 忽略）。',
    ].join('\n'),
  );
}

function preflightFail(message, report, outPath) {
  console.error(`meka-submit-e2e: ${message}`);
  report.verdict = 'error';
  report.exitCode = 2;
  report.errors.push({ phase: 'preflight', message });
  const file = writeReport(report, outPath);
  console.error(`meka-submit-e2e: 报告（前置失败）已写入 ${file}`);
  return 2;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return 0;
  }
  const outPath = options.out ?? defaultOutPath();
  const startedAt = Date.now();
  const { port, source: portSource } = resolvePort(options);
  const report = {
    schemaVersion: 1,
    tool: 'meka-submit-e2e',
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: null,
    durationMs: null,
    verdict: 'error',
    exitCode: 1,
    cwd: ROOT,
    gitHead: shortHead(),
    dryRun: options.dryRun,
    instance: { versionLine: null, matchesHead: null },
    environment: null,
    cdp: { port, portSource, targetUrl: null, targetTitle: null, targets: [] },
    db: { path: null, candidates: [] },
    project: { id: options.projectId, label: null, layout: null, entryLabel: null },
    prompt: options.prompt,
    autoAnswer: { answers: [...options.answers], confirm: options.confirm },
    sessionId: null,
    session: null,
    timing: { messageSentAt: null, turnStartedAt: null, turnEndedAt: null, waitMs: null, timeoutMs: options.timeoutMs, timedOut: false },
    messages: { total: 0, counts: {}, assistantTexts: [], lastAssistantText: null },
    steps: [],
    askUser: { encountered: false, autoAnswers: [], pending: null },
    confirmDialog: { encountered: false, occurrences: [] },
    permissionPrompt: { encountered: false, detail: null },
    checks: null,
    errors: [],
    notes: [],
  };

  // 1) CDP 前置：端口 → target（失败给出可操作诊断）
  report.db.candidates = candidateDbFiles(options);
  const picked = await pickRendererTarget(port);
  report.cdp.targets = (picked.all ?? []).map((t) => ({ type: t.type, url: t.url })).slice(0, 20);
  if (!picked.ok) {
    return preflightFail(picked.reason, report, outPath);
  }
  report.cdp.targetUrl = picked.target.url;
  report.cdp.targetTitle = picked.target.title ?? null;

  const session = await CdpSession.connect(picked.target.webSocketDebuggerUrl);
  MekaE2E.session = session;
  MekaE2E.options = options;
  let exitCode = 1;
  try {
    await session.waitFor(
      `!!document.querySelector('#root, #app') || document.body.children.length > 0`,
      { timeoutMs: READY_TIMEOUT_MS, label: 'renderer ready' },
    );

    // 2) --dry-run：只做连接与目标页探测（不改 hash、不点任何东西、不发消息）。
    if (options.dryRun) {
      const info = await session.evaluate(`(() => {
        const text = (document.body.innerText || '');
        return {
          href: location.href,
          title: document.title,
          hasAside: !!document.querySelector('aside'),
          sidebarHasMeka: /Meka/.test(text),
          projectVisible: text.toLowerCase().includes(${JSON.stringify(options.projectId.toLowerCase())}),
          newEntryLabels: [...document.querySelectorAll('button')]
            .map((b) => b.getAttribute('aria-label') || '')
            .filter((a) => a.includes('新建')).slice(0, 10),
          hasAskCard: !!document.querySelector('[data-testid="interaction-prompt-scroll-region"]'),
          hasConfirmDialog: !!document.querySelector('[role="alertdialog"]'),
        };
      })()`);
      const env = await assertRendererInteractive(session, report, { dryRun: true });
      report.dryRun = true;
      report.verdict = 'dry-run';
      report.exitCode = 0;
      report.nav = info;
      report.sessionId = null;
      report.notes.push(
        '--dry-run：只验证「CDP 端口可用 + 挑到主窗口 renderer 页」，未建会话、未发消息、未改动界面状态',
      );
      for (const problem of env.problems ?? []) {
        report.notes.push(`环境警告（dry-run 不阻断）：${problem}`);
      }
      printDryRun(info, report, outPath, env);
      return 0;
    }

    // 3) 真实运行：界面可交互前置 → 实例陈旧性核对 → 建草稿 → 发消息
    const interactive = await assertRendererInteractive(session, report, { dryRun: false });
    if (!interactive.ok) {
      return preflightFail(
        `主窗口现在没法被驱动：${interactive.reason}。` +
          '把 dev 实例窗口切到前台、关掉挡在前面的弹窗（或直接重启实例）后再跑；' +
          '脚本不会去点自己不认识的高危弹窗',
        report,
        outPath,
      );
    }
    const dbFiles = report.db.candidates;
    if (!dbFiles.length) {
      return preflightFail(
        '找不到实例本地库（cindy-meka-*.db）。用 --user-data-dir 指定该 dev 实例的 userData；' +
          '默认会尝试 %APPDATA%/CindyMeka-dev2-dev 与 %APPDATA%/CindyMeka',
        report,
        outPath,
      );
    }
    report.db.path = dbFiles[0];
    const db = new DbPool(dbFiles);
    MekaE2E.db = db;

    const freshness = await assertInstanceMatchesHead(session, report);
    if (!freshness.ok) {
      return preflightFail(
        `${freshness.reason}（跑着的实例可能还是旧代码，先 pnpm restart:desktop:remote 再跑）`,
        report,
        outPath,
      );
    }

    const beforeIds = db.sessionIds();
    const draft = await createMekaDraft(session, options.projectId);
    if (!draft.ok) {
      return preflightFail(
        `从侧栏项目入口建不出 Meka 草稿：${draft.reason}。` +
          '（脚本不猜项目/角色，也不会静默改从别的入口进去）',
        report,
        outPath,
      );
    }
    report.project.label = draft.projectLabel;
    report.project.layout = draft.layout;
    report.project.entryLabel = draft.entryLabel;

    // 「点到了入口」不等于「草稿绑上了项目/角色」：角色选择器（Meka 角色 chip）是**绑定的可见判据**。
    // 没有它时发出去的消息会落到普通对话里（2026-11-18 实跑撞到过：入口点空了一次，脚本差点把
    // prompt 发进未绑定的草稿）；这里先离开草稿路由强制重挂载再点一次，仍失败就前置失败。
    let roleChip = await waitForRoleChip(session);
    if (!roleChip) {
      report.notes.push('草稿没有出现角色选择器（未绑定 Meka 项目/角色）：强制重挂载草稿后重试一次入口点击');
      await session.evaluate(`location.hash = '#/cc-agent/meka'`).catch(() => {});
      await sleep(1500);
      const retry = await createMekaDraft(session, options.projectId);
      if (!retry.ok) {
        return preflightFail(
          `重试建草稿仍然失败：${retry.reason}`,
          report,
          outPath,
        );
      }
      roleChip = await waitForRoleChip(session);
    }
    if (!roleChip) {
      const diag = await session.evaluate(`(() => ({
        hash: location.hash,
        newEntryLabels: [...document.querySelectorAll('button')]
          .map((b) => b.getAttribute('aria-label') || '')
          .filter((a) => a.includes('新建')).slice(0, 10),
        mainText: (document.querySelector('main')?.innerText || '').replace(/\\n+/g, ' | ').slice(0, 300),
      }))()`);
      report.notes.push(`草稿未绑定诊断：${JSON.stringify(diag)}`);
      return preflightFail(
        '从侧栏项目入口点击后，草稿页始终没有出现 Meka 角色选择器（项目/角色未绑定），' +
          '此时发消息会落进普通对话而不是 Meka 项目会话——脚本停在这里，不往错误的地方发消息',
        report,
        outPath,
      );
    }
    report.notes.push(`草稿角色选择器=${roleChip}`);

    const sent = await sendMessage(session, options.prompt);
    if (!sent.ok) {
      return preflightFail(`没能发出 prompt：${sent.reason}`, report, outPath);
    }
    report.timing.messageSentAt = new Date().toISOString();
    report.notes.push(`已发送 prompt：${options.prompt}（输入框已清空=${sent.composerCleared}）`);

    let row = null;
    for (let i = 0; i < SESSION_TIMEOUT_MS / 1500 && !row; i += 1) {
      await sleep(1500);
      row = db.findNewSession(beforeIds, options.projectId);
    }
    if (!row) {
      return preflightFail(
        `发送后 ${SESSION_TIMEOUT_MS / 1000}s 内没看到新会话落库（project=${options.projectId}）`,
        report,
        outPath,
      );
    }
    report.sessionId = row.id;
    MekaE2E.sessionId = row.id;
    report.session = {
      title: row.title,
      workspaceKind: row.workspace_kind,
      mekaProjectId: row.meka_project_id,
      mekaRoleId: row.meka_role_id,
      isFormal: row.is_formal,
      workingDir: row.working_dir,
      permissionMode: row.permission_mode,
      status: row.status,
    };
    report.notes.push(`新会话 sessionId=${row.id}，开始等待本轮 Agent 跑完`);

    // 4) 主循环：边等边收证，遇到提问/确认框按参数处理，不传参数就判卡住。
    const outcome = await runTurn({ session, db, row, options, report, startedAt });
    exitCode = outcome.exitCode;
    report.exitCode = outcome.exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report.errors.push({ phase: 'run', message });
    report.verdict = 'error';
    console.error(`meka-submit-e2e: 执行异常：${message}`);
    exitCode = 1;
  } finally {
    // 收尾取证（异常路径也要尽可能留下证据）。
    try {
      if (report.sessionId && MekaE2E.db) {
        const evidence = collectEvidence(MekaE2E.db, report.sessionId);
        const total = Object.values(evidence.counts).reduce((sum, n) => sum + n, 0);
        report.messages = {
          total,
          counts: evidence.counts,
          assistantTexts: evidence.assistantTexts.slice(-5),
          lastAssistantText: evidence.lastAssistantText,
        };
        report.steps = evidence.steps;
        report.checks = buildChecks(evidence, report);
      }
    } catch {
      /* 取证失败不覆盖主错误 */
    }
    // 收尾：只关 CDP 连接，**绝不**再派发 Escape 之类的输入事件。
    // 教训（2026-11-18 实跑）：脚本退出时对 ask 卡片按 Escape = 「跳过该问」，会把等待中的
    // 提问答成空答案并让该轮异常收尾——那既篡改了证据，也不是用户想要的结果。卡住时把
    // 提问原样留在界面上，真人可以接着答。
    session.close();
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - startedAt;
    if (!report.checks && report.verdict === 'error') report.notes.push('未生成 checks：取证阶段未能读到会话消息');
    const file = writeReport(report, outPath);
    // dry-run 的探测结论已由 printDryRun 打印，这里不再重复一份「空会话」摘要。
    if (!report.dryRun) printReport(report, file);
  }
  return exitCode;
}

/** 实例陈旧性核对（同 smoke）：版本行 commit 与 git HEAD 不一致就直接前置失败。 */
async function assertInstanceMatchesHead(session, report) {
  await session.evaluate(`location.hash = '#/cc-agent/new'`).catch(() => {});
  await sleep(1500);
  const line = await session
    .waitFor(
      `(() => { const m = (document.body.innerText || '').match(/(Global|CN|Dev) · [^\\n]*meka\\/main@[0-9a-f]{7,}/); return m ? m[0] : null; })()`,
      { timeoutMs: READY_TIMEOUT_MS, label: '版本行（edition · 版本 · 分支@commit）' },
    )
    .catch(() => null);
  if (!line) {
    report.notes.push('未找到侧栏版本行，跳过「实例是否 HEAD」核对（结论可能来自旧实例，注意）');
    return { ok: true, line: null };
  }
  report.instance.versionLine = line;
  const head = report.gitHead;
  const commitInUi = /@([0-9a-f]{7,})/.exec(line)?.[1] ?? '';
  const matches = Boolean(head) && (commitInUi.startsWith(head) || head.startsWith(commitInUi));
  report.instance.matchesHead = matches;
  if (!matches) {
    return {
      ok: false,
      reason: `实例版本行 commit=${commitInUi} 与仓库 HEAD=${head} 不一致`,
    };
  }
  return { ok: true, line };
}

/**
 * 等一轮 Agent 跑完。判据与优先序（都是**运行期事实**，不看文案）：
 *   ① 库里的提问 pending（`ask_user` 行 status=pending）→ 按 --answer 作答 / 判卡住；
 *   ② renderer 里的插件确认框（`role=alertdialog` + 标题「插件「」）→ 按 --confirm 确认 / 取消并判卡住；
 *   ③ 权限卡（「允许/拒绝」）→ 本脚本不自动批准，登记并判卡住；
 *   ④ turn 收尾：`sessions.active_turn_started_at` 与 `last_turn_ended_at` 都已写、且 ended >= started
 *      （与 `localDb/sessionActiveTurn.ts` 的「疑似中断」判据同源，是本项目里最硬的「本轮结束」信号）；
 *   ⑤ 超过 --timeout-ms 仍未收尾 → 超时。
 * `sessions.status` 在这些会话上恒为 `active`（历史行也一样），所以**不**拿它当结束判据。
 */
async function runTurn({ session, db, row, options, report, startedAt }) {
  const deadline = startedAt + options.timeoutMs;
  let sawTurnStart = false;
  let lastPendingAskRequestId = null;
  let lastTurnEndedAt = null;
  while (Date.now() < deadline) {
    const current = db.sessionRow(row.id) ?? row;
    const turnStartedAt = current.active_turn_started_at ?? null;
    const turnEndedAt = current.last_turn_ended_at ?? null;
    report.timing.turnStartedAt = turnStartedAt;
    report.timing.turnEndedAt = turnEndedAt;
    if (turnStartedAt && !sawTurnStart) sawTurnStart = true;

    // ⓪ 界面挡板：插件确认框之外的模态框/遮罩一律视为「挡住了会话」，停下来报。
    // （窗口不可见时 Radix 的退场动画不结束，遮罩会一直留在 DOM 里——那种状态下点什么都没用。）
    const overlay = await readBlockingOverlay(session);
    if (overlay && overlay.kind !== 'ghost-confirm') {
      report.verdict = 'blocked';
      report.sessionBlock = {
        kind: 'overlay',
        reason:
          `界面被模态框/遮罩挡住（kind=${overlay.kind}，data-state=${overlay.dialogState ?? 'n/a'}）：` +
          `「${overlay.text.slice(0, 160)}」。脚本不去点自己不认识的弹窗`,
        overlay,
      };
      report.notes.push('卡住（界面挡板）：有一层遮罩盖住了会话');
      return { exitCode: 1, blocked: true };
    }

    // ① ask_user 提问
    const pending = db.pendingAskUser(row.id);
    if (pending) {
      report.askUser.encountered = true;
      report.askUser.pending = {
        requestId: pending.requestId,
        questions: pending.questions.map((question) => ({
          question: questionTextOf(question),
          options: optionLabelsOf(question),
        })),
      };
      if (pending.requestId !== lastPendingAskRequestId) {
        lastPendingAskRequestId = pending.requestId;
        // 提问卡片只在会话视图里渲染；用户可能把窗口切到了别的会话，先确保路由。
        await ensureSessionRoute(session, row.id);
        const result = await answerAskRequest({
          session,
          pending,
          answerQueue: options.answers,
          report,
        });
        if (!result.ok) {
          report.verdict = 'blocked';
          report.sessionBlock = { kind: 'ask_user', ...(result.stuck ?? {}), reason: result.reason };
          report.notes.push(`卡住（等待作答）：${result.reason}`);
          return { exitCode: 1, blocked: true };
        }
        report.askUser.pending = null;
        report.notes.push(`已自动作答 ask_user（requestId=${pending.requestId}）`);
        // 重读一次该请求在库里的最终状态，作为「主机真的收下了」的证据。
        const settled = db.messageRows(row.id).find((message) => {
          if (message.role !== 'ask_user') return false;
          const content = parseJsonLoose(message.content);
          return content?.requestId === pending.requestId;
        });
        if (settled) {
          const content = parseJsonLoose(settled.content);
          report.askUser.lastSettled = {
            requestId: pending.requestId,
            status: content?.status ?? null,
            answers: content?.answers ?? null,
          };
        }
        continue;
      }
    }

    // ② 插件确认框
    const confirm = await handleConfirmDialog({ session, options, report });
    if (!confirm.ok) {
      report.verdict = 'blocked';
      report.sessionBlock = {
        kind: 'confirm_dialog',
        reason: confirm.reason,
        dialog: confirm.dialog ?? null,
      };
      report.notes.push(`卡住（确认框）：${confirm.reason}`);
      return { exitCode: 1, blocked: true };
    }
    if (confirm.handled) continue;

    // ③ 权限卡（bypassPermissions 会话不该出现；出现就说明权限模式变了，停下来报）
    const permission = await readPermissionPrompt(session);
    if (permission) {
      report.permissionPrompt = { encountered: true, detail: permission };
      report.verdict = 'blocked';
      report.sessionBlock = {
        kind: 'permission',
        reason: '出现「允许/拒绝」权限卡：脚本不自动批准工具权限（安全边界），请人工处理',
        labels: permission.labels,
      };
      report.notes.push('卡住（权限卡）：不自动批准工具权限');
      return { exitCode: 1, blocked: true };
    }

    // ④ 本轮收尾
    if (sawTurnStart && turnStartedAt && turnEndedAt && turnEndedAt >= turnStartedAt) {
      report.timing.waitMs = Date.now() - startedAt;
      report.verdict = 'completed';
      report.notes.push(`本轮已收尾（active_turn_started_at=${turnStartedAt}, last_turn_ended_at=${turnEndedAt}）`);
      lastTurnEndedAt = turnEndedAt;
      return { exitCode: 0, completed: true };
    }
    await sleep(POLL_MS);
  }
  report.timing.timedOut = true;
  report.timing.waitMs = Date.now() - startedAt;
  report.verdict = 'timed-out';
  report.sessionBlock = {
    kind: 'timeout',
    reason: `等待 ${fmtDuration(options.timeoutMs)} 仍未收尾（sawTurnStart=${sawTurnStart}, lastTurnEndedAt=${lastTurnEndedAt}）`,
  };
  report.notes.push(`超时：${fmtDuration(options.timeoutMs)} 内本轮没有收尾`);
  return { exitCode: 1, timedOut: true };
}

// ── 输出 ────────────────────────────────────────────────────────────────────
function printDryRun(info, report, outPath, env) {
  console.log('MEKA_SUBMIT_E2E DRY-RUN — 只做连接与目标页探测（未建会话、未发消息）');
  console.log(`  cdp=${report.cdp.port}（来源：${report.cdp.portSource}）`);
  console.log(`  target=${report.cdp.targetUrl}`);
  console.log(`  页面：href=${info.href} title=${JSON.stringify(info.title)} aside=${info.hasAside}`);
  console.log(`  侧栏含 Meka 分区=${info.sidebarHasMeka} 项目「${report.project.id}」可见=${info.projectVisible}`);
  console.log(`  与「新建」有关的入口 aria-label=${JSON.stringify(info.newEntryLabels)}`);
  console.log(`  当前界面是否已有 ask 卡片=${info.hasAskCard} / 确认框=${info.hasConfirmDialog}`);
  const environment = env?.environment ?? report.environment;
  if (environment) {
    console.log(
      `  窗口：visibility=${environment.visibility} hasFocus=${environment.hasFocus} ` +
        `viewport=${JSON.stringify(environment.viewport)} 挡板=${environment.overlay ? environment.overlay.kind : '无'}`,
    );
  }
  for (const problem of env?.problems ?? []) console.log(`  ⚠ 环境警告：${problem}`);
  console.log(`  db 候选=${JSON.stringify(report.db.candidates)}`);
  console.log(`  报告：${outPath}`);
}

function printReport(report, file) {
  const verdictLabel = {
    completed: 'COMPLETED',
    blocked: 'BLOCKED',
    'timed-out': 'TIMED-OUT',
    error: 'ERROR',
    'dry-run': 'DRY-RUN',
  }[report.verdict] ?? report.verdict.toUpperCase();
  console.log(`\nMEKA_SUBMIT_E2E ${verdictLabel}`);
  if (report.environment) {
    console.log(
      `  环境：visibility=${report.environment.visibility} hasFocus=${report.environment.hasFocus}` +
        ` 挡板=${report.environment.overlay ? report.environment.overlay.kind : '无'}`,
    );
  }
  console.log(
    `  session=${report.sessionId ?? '(无)'} project=${report.project.id} layout=${report.project.layout ?? 'n/a'}` +
      ` 步骤=${report.steps.length} 耗时=${fmtDuration(report.timing.waitMs ?? report.durationMs)}`,
  );
  if (report.session) {
    console.log(
      `  会话：title=${JSON.stringify(report.session.title)} role=${report.session.mekaRoleId}` +
        ` permission=${report.session.permissionMode} workdir=${report.session.workingDir}`,
    );
  }
  for (const step of report.steps) {
    const mark = step.ok === true ? '✓' : step.ok === false ? '✗' : '·';
    const op = step.pluginOp ? `[${step.pluginOp}]` : '';
    const err = step.errorCode ? ` error=${step.errorCode}` : '';
    console.log(`  ${String(step.n).padStart(2, ' ')} ${mark} ${step.tool}${op}${err} — ${step.summary.slice(0, 160)}`);
  }
  for (const answer of report.askUser.autoAnswers) {
    console.log(
      `  自动作答：${answer.question} → ${JSON.stringify(answer.answer)}` +
        `（mode=${answer.mode}/${answer.rule}，已生效=${answer.advanced}）`,
    );
  }
  for (const occurrence of report.confirmDialog.occurrences) {
    console.log(
      `  确认框：${occurrence.title} → ${occurrence.autoConfirmed ? '脚本点了确认（--confirm）' : '脚本点了取消（未传 --confirm）'}`,
    );
  }
  if (report.checks) {
    const { jiraIssues, submitFlow, errorCodes, findings } = report.checks;
    console.log(
      `  校验：jira_issues 调用=${jiraIssues.called}（${jiraIssues.callCount} 次）返回真实标题=${jiraIssues.returnedTitles}` +
        `${jiraIssues.titles.length ? ` 标题=${JSON.stringify(jiraIssues.titles.slice(0, 3))}` : ''}`,
    );
    console.log(
      `  校验：submit_start=${submitFlow.submitStart} environment_check=${submitFlow.environmentCheck}` +
        ` submit_check=${submitFlow.submitCheck} submit_confirm=${submitFlow.submitConfirm}` +
        ` submit_record=${submitFlow.submitRecord} submit_status=${submitFlow.submitStatus}`,
    );
    console.log(`  校验：错误码=${JSON.stringify(errorCodes)} 关注码命中=${JSON.stringify(report.checks.watchedErrorCodes)}`);
    for (const finding of findings) console.log(`  发现：${finding}`);
  }
  if (report.sessionBlock) {
    console.log(`  卡住：${report.sessionBlock.reason || report.sessionBlock.kind}`);
    if (report.sessionBlock.question) {
      console.log(
        `        题干=${JSON.stringify(report.sessionBlock.question)} 选项=${JSON.stringify(report.sessionBlock.options ?? [])}`,
      );
    }
    if (report.sessionBlock.dialog) {
      console.log(`        确认框正文=${JSON.stringify(String(report.sessionBlock.dialog.text ?? '').slice(0, 300))}`);
    }
  }
  if (report.errors.length) {
    for (const error of report.errors) console.log(`  错误（${error.phase}）：${error.message}`);
  }
  console.log(`  report=${file}`);
  process.exitCode = report.exitCode ?? 1;
}

main()
  .then((code) => {
    if (code !== undefined && code !== 0) process.exitCode = code;
  })
  .catch((error) => {
    console.error(`meka-submit-e2e: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  });
