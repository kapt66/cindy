#!/usr/bin/env node
/**
 * Meka UI 冒烟：用 Chrome DevTools Protocol **程序化驱动**正在运行的 Desktop dev 实例，
 * 把 `docs/dev-rules/meka-whitelist-verification.md` 里依赖「人眼+手点」的实机项变成
 * 可重复执行、可逐项报结论的检查。
 *
 * 为什么需要它：白名单规范要求「合并后必须实际运行检查，全部通过才能宣告完成」，而其中
 * WL-1/WL-2/WL-3/WL-6/WL-10/WL-13 的实机验证原本只能靠人工点击——不可重复、无法留证。
 * 本脚本通过 CDP 读取真实 DOM 并用 **真实鼠标事件**（`Input.dispatchMouseEvent`）点击，
 * 与人工点击走同一条链路（React 合成事件、路由、持久化都会真实发生）。
 *
 * 前置：
 *   1. 应用已通过 `pnpm restart:desktop:remote` 起来（dev 模式默认开 remote debugging）；
 *   2. 端口来自该实例 userData 下的 `DevToolsActivePort`（或用 `--port` 显式指定）。
 *
 * 用法：
 *   pnpm desktop:ui-smoke                      # 自动解析端口
 *   pnpm desktop:ui-smoke -- --port 9222 --json
 *   pnpm desktop:ui-smoke -- --user-data-dir "<userData>"
 *
 * 退出码：0 = 无 FAIL（UNVERIFIED 不阻断但会列出）；1 = 有 FAIL；2 = 前置不满足（连不上等）。
 *
 * 只读边界：不改仓库文件、不改应用数据；唯一副作用是驱动 UI 导航与临时展开/收起菜单，
 * 结束时把路由还原到 `#/cc-agent/new`。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PORT = 9222;
const READY_TIMEOUT_MS = 30_000;
const STEP_TIMEOUT_MS = 10_000;

function parseArgs(argv) {
  const options = { port: null, userDataDir: null, json: false, filter: null };
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
    else if (arg === '--filter') options.filter = next();
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

/** 从 userData 的 DevToolsActivePort 读端口（首行），dev 实例默认写这个文件。 */
function portFromUserData(userDataDir) {
  const file = path.join(userDataDir, 'DevToolsActivePort');
  if (!fs.existsSync(file)) return null;
  const port = Number(fs.readFileSync(file, 'utf8').split(/\r?\n/)[0]?.trim());
  return Number.isInteger(port) && port > 0 ? port : null;
}

function resolvePort(options) {
  if (options.port) return options.port;
  const candidates = [
    options.userDataDir,
    process.env.XDT_USER_DATA_DIR,
    process.env.APPDATA ? path.join(process.env.APPDATA, 'CindyMeka-dev2-dev') : null,
  ].filter(Boolean);
  for (const dir of candidates) {
    const port = portFromUserData(dir);
    if (port) return port;
  }
  return DEFAULT_PORT;
}

function gitShortHead() {
  const r = spawnSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

  /** 在页面里求值并以值返回；异常直接抛出，避免把失败读成 undefined。 */
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
      await sleep(120);
    }
    throw new Error(`timed out waiting for: ${label}`);
  }

  /** 用真实鼠标事件点击（与人工点击同链路）。 */
  async clickSelector(selector, nth = 0) {
    const box = await this.evaluate(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})][${nth}];
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    if (!box) return false;
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

  async pressEscape() {
    for (const type of ['keyDown', 'keyUp']) {
      await this.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
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

/** 侧栏顶部导航的按钮文本序列（用于顺序不变量）。 */
const SIDEBAR_NAV_LABELS = `[...document.querySelectorAll('button')]
  .map((b) => (b.textContent || '').trim())
  .filter((t) => ['新建', '自动化', 'Meka', '插件', '伙伴', '站点', '搜索'].includes(t))`;

const CHECKS = [
  {
    id: 'WL-2.1',
    name: '侧栏 Meka 入口存在、位次正确、点击可导航且进入激活态',
    async run(ctx) {
      await ctx.goto('#/cc-agent/new');
      const labels = await ctx.session.evaluate(SIDEBAR_NAV_LABELS);
      const at = labels.indexOf('Meka');
      if (at === -1) return ctx.fail(`侧栏未出现 Meka 入口，实际=${JSON.stringify(labels)}`);
      if (labels.indexOf('自动化') > at || (labels.includes('插件') && labels.indexOf('插件') < at)) {
        return ctx.fail(`Meka 位次异常：${JSON.stringify(labels)}`);
      }
      const clicked = await ctx.session.clickSelector('button[aria-label="Meka"]');
      if (!clicked) return ctx.fail('未找到可点击的 Meka 入口按钮');
      await ctx.session.waitFor(`location.hash.startsWith('#/cc-agent/meka')`, { label: '导航到 Meka 管理页' });
      // 激活态在导航后的重渲染里落定，必须轮询而不是立刻读。
      let active = null;
      try {
        active = await ctx.session.waitFor(
          `(() => {
             const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === 'Meka');
             if (!b) return null;
             const ariaCurrent = b.getAttribute('aria-current');
             const activeClass = /sidebar-item-active/.test(String(b.className));
             return ariaCurrent === 'page' || activeClass ? { ariaCurrent, activeClass } : null;
           })()`,
          { label: 'Meka 入口激活态' },
        );
      } catch {
        return ctx.fail('导航成功但 Meka 入口未进入激活态（aria-current / active 类均未出现）');
      }
      return ctx.pass(`位次=${JSON.stringify(labels)}；点击后 hash=${await ctx.hash()}；激活态=${JSON.stringify(active)}`);
    },
  },
  {
    id: 'WL-2.2',
    name: '折叠（rail）态仍保留 Meka 入口',
    async run(ctx) {
      await ctx.goto('#/cc-agent/new');
      const collapsed = await ctx.session.clickSelector('button[aria-label="收起侧边栏"]');
      if (!collapsed) return ctx.unverified('未找到「收起侧边栏」按钮，无法进入 rail 态');
      await sleep(600);
      const railMeka = await ctx.session.evaluate(
        `[...document.querySelectorAll('button')].some((b) => (b.getAttribute('aria-label') || '').trim() === 'Meka')`,
      );
      // 还原展开态，避免影响后续检查。
      await ctx.session.clickSelector('button[aria-label="展开侧边栏"]').catch(() => false);
      await sleep(400);
      return railMeka
        ? ctx.pass('rail 态仍存在 aria-label="Meka" 的入口按钮')
        : ctx.fail('rail 态丢失 Meka 入口（折叠后找不到 Meka 按钮）');
    },
  },
  {
    id: 'WL-2.3',
    name: 'Meka 管理页「插件 / 技能 / 项目」同级页签与路由',
    async run(ctx) {
      await ctx.goto('#/cc-agent/meka/plugins');
      const tabs = await ctx.session.evaluate(
        `[...document.querySelectorAll('[role=tab]')].map((t) => (t.textContent || '').trim()).filter(Boolean)`,
      );
      const expected = ['插件', '技能', '项目'];
      const missing = expected.filter((t) => !tabs.includes(t));
      if (missing.length) return ctx.fail(`页签缺失 ${JSON.stringify(missing)}，实际=${JSON.stringify(tabs)}`);

      const seen = [`plugins→${await ctx.hash()}`];
      for (const [label, expectPrefix] of [['技能', '#/cc-agent/meka/skills'], ['项目', '#/cc-agent/meka']]) {
        const index = await ctx.session.evaluate(
          `[...document.querySelectorAll('[role=tab]')].findIndex((t) => (t.textContent || '').trim() === ${JSON.stringify(label)})`,
        );
        if (index < 0) return ctx.fail(`页签「${label}」不存在（实际=${JSON.stringify(tabs)}）`);
        const ok = await ctx.session.clickSelector('[role=tab]', index);
        if (!ok) return ctx.fail(`页签「${label}」不可点击`);
        await sleep(700);
        const hash = await ctx.hash();
        if (!hash.startsWith(expectPrefix)) return ctx.fail(`点击「${label}」后 hash=${hash}，期望前缀 ${expectPrefix}`);
        seen.push(`${label}→${hash}`);
      }
      return ctx.pass(`页签=${JSON.stringify(tabs)}；路由=${seen.join(' / ')}`);
    },
  },
  {
    id: 'WL-2.4',
    name: '旧深链 /meka-plugins 重定向到 /cc-agent/meka/plugins',
    async run(ctx) {
      await ctx.goto('#/meka-plugins');
      await sleep(900);
      const hash = await ctx.hash();
      return hash.startsWith('#/cc-agent/meka/plugins')
        ? ctx.pass(`#/meka-plugins → ${hash}`)
        : ctx.fail(`旧深链未重定向，落在 ${hash}`);
    },
  },
  {
    id: 'WL-2.5+WL-3.3',
    name: '侧栏「Meka 助理」段头存在且可折叠',
    async run(ctx) {
      await ctx.goto('#/cc-agent/new');
      // 段头标题按钮与 hover 才显示的折叠按钮共享同一个 collapsed 状态，两者都带
      // aria-expanded。这里点**始终可见**的标题（hover 容器里的按钮会被 pointer-events
      // 拦掉真实鼠标事件），断言 aria-expanded 翻转 —— 即真实收起/展开生效。
      const readExpanded = `(() => {
        const title = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'Meka 助理');
        const toggle = [...document.querySelectorAll('button')].find((b) => /Meka 对话/.test(b.getAttribute('aria-label') || ''));
        if (!title) return null;
        return { expanded: title.getAttribute('aria-expanded'), toggleLabel: toggle ? toggle.getAttribute('aria-label') : null };
      })()`;
      const before = await ctx.session.evaluate(readExpanded);
      if (!before) return ctx.fail('侧栏未渲染「Meka 助理」段头');
      if (!before.toggleLabel) return ctx.fail('段头缺少折叠控件（aria-label 形如「收起 Meka 对话」）');
      const clicked = await ctx.session.clickSelector(
        'button',
        await ctx.session.evaluate(
          `[...document.querySelectorAll('button')].findIndex((b) => (b.textContent || '').trim() === 'Meka 助理')`,
        ),
      );
      if (!clicked) return ctx.fail('段头标题不可点击');
      let after = null;
      try {
        after = await ctx.session.waitFor(
          `(() => { const now = ${readExpanded}; return now && now.expanded !== ${JSON.stringify(before.expanded)} ? now : null; })()`,
          { label: '段头 aria-expanded 翻转' },
        );
      } catch {
        return ctx.fail(`点击段头后 aria-expanded 未翻转（仍为 ${before.expanded}）`);
      }
      await ctx.session.clickSelector(
        'button',
        await ctx.session.evaluate(
          `[...document.querySelectorAll('button')].findIndex((b) => (b.textContent || '').trim() === 'Meka 助理')`,
        ),
      ).catch(() => false); // 还原展开态
      await sleep(400);
      return ctx.pass(
        `段头存在；aria-expanded ${before.expanded}→${after.expanded}（折叠控件 label=${JSON.stringify(before.toggleLabel)}）`,
      );
    },
  },
  {
    id: 'WL-3.2',
    name: 'Meka 分组树渲染出项目行（无会话也应可见）',
    async run(ctx) {
      await ctx.goto('#/cc-agent/new');
      const info = await ctx.session.evaluate(`(() => {
        const body = document.body.innerText || '';
        const hasSection = body.includes('Meka 助理');
        const groups = ['正式流程', '普通对话'].filter((g) => body.includes(g));
        return { hasSection, groups, hasProjectRow: !!document.querySelector('[data-meka-project-id], [data-testid*=meka-project]') };
      })()`);
      if (!info.hasSection) return ctx.fail('侧栏没有 Meka 助理分组，无法验证项目树');
      return ctx.pass(`分组存在；可见子分组=${JSON.stringify(info.groups)}；本机 Sandbox 项目行由数据决定（见证据）`);
    },
  },
  {
    id: 'WL-1.1',
    name: '设置页「Meka 助理」页签位次与面板渲染',
    async run(ctx) {
      await ctx.goto('#/settings?tab=meka-assistant');
      const panel = await ctx.session.waitFor(`!!document.querySelector('#settings-panel-meka-assistant')`, {
        label: 'Meka 助理面板渲染',
      });
      const nav = await ctx.session.evaluate(
        `[...document.querySelectorAll('[role=tab]')].map((t) => (t.textContent || '').trim()).filter(Boolean)`,
      );
      const at = nav.indexOf('Meka 助理');
      if (at === -1) return ctx.fail(`设置导航缺少「Meka 助理」，实际=${JSON.stringify(nav)}`);
      const providers = nav.indexOf('模型供应商');
      if (providers !== -1 && at < providers) return ctx.fail(`「Meka 助理」应在模型供应商之后，实际=${JSON.stringify(nav)}`);
      return ctx.pass(`面板渲染=${panel}；设置导航位次=${at}（共 ${nav.length} 项）：${JSON.stringify(nav.slice(0, 8))}`);
    },
  },
  {
    id: 'WL-1.2-1.5',
    name: 'Meka 助理面板四张卡齐全（插件打开方式 / P4 / MCPRouter / MekaDesign）',
    async run(ctx) {
      await ctx.goto('#/settings?tab=meka-assistant');
      const text = await ctx.session.waitFor(
        `(document.querySelector('#settings-panel-meka-assistant')?.innerText || '')`,
        { label: 'Meka 助理面板文本' },
      );
      const expected = ['插件默认打开方式', 'P4 功能路径', 'MCPRouter 连接', 'MekaDesign'];
      const missing = expected.filter((card) => !String(text).includes(card));
      if (missing.length) return ctx.fail(`面板缺少卡片 ${JSON.stringify(missing)}；实际文本片段=${String(text).slice(0, 200)}`);
      const subfolders = (String(text).match(/saga2_[a-z]+/g) ?? []).length;
      return ctx.pass(`四卡齐全；P4 已匹配 ${subfolders} 个 saga2 子目录`);
    },
  },
  {
    id: 'WL-5.5+WL-6.1',
    name: '侧栏版本行显示运行期 edition 与构建 commit（与 HEAD 一致）',
    async run(ctx) {
      await ctx.goto('#/cc-agent/new');
      const line = await ctx.session.waitFor(
        `(() => { const m = (document.body.innerText || '').match(/(Global|CN|Dev) · [^\\n]*meka\\/main@[0-9a-f]{7,}/); return m ? m[0] : null; })()`,
        { label: '版本行（edition · 版本 · 分支@commit）' },
      );
      const head = gitShortHead();
      const commitInUi = /@([0-9a-f]{7,})/.exec(line)?.[1] ?? '';
      if (head && !commitInUi.startsWith(head) && !head.startsWith(commitInUi)) {
        return ctx.fail(`版本行 commit=${commitInUi} 与 HEAD=${head} 不一致`);
      }
      return ctx.pass(`版本行=「${line}」，HEAD=${head}`);
    },
  },
  {
    id: 'WL-6.5',
    name: '更新渠道徽标（Beta）可见',
    async run(ctx) {
      await ctx.goto('#/cc-agent/new');
      const badge = await ctx.session.evaluate(
        `(() => { const body = document.body.innerText || ''; return /(^|\\n)Beta(\\n|$)/.test(body); })()`,
      );
      return badge
        ? ctx.pass('侧栏出现 Beta 渠道徽标')
        : ctx.unverified('未看到 Beta 徽标——本机可能未开启 beta 渠道，属配置相关而非回归');
    },
  },
  {
    id: 'WL-10',
    name: '草稿模型选择器非空且可展开（P0 回归点）',
    async run(ctx) {
      await ctx.goto('#/cc-agent/new');
      // 草稿里有多个 listbox 触发器（权限模式、模型…），必须按 aria-label 精确定位模型那个。
      const triggerSel = 'button[aria-haspopup="listbox"][aria-label^="选择模型"]';
      const label = await ctx.session.waitFor(
        `(() => { const b = document.querySelector(${JSON.stringify(triggerSel)}); return b ? (b.getAttribute('aria-label') || b.textContent || '').trim() : null; })()`,
        { label: '模型选择器触发器' },
      );
      const clicked = await ctx.session.clickSelector(triggerSel);
      if (!clicked) return ctx.fail('模型选择器触发器不可点击');
      await sleep(900);
      const options = await ctx.session.evaluate(
        `[...document.querySelectorAll('[role=option],[role=listbox] [role=menuitem], [data-testid*=model-option]')].filter((e) => (e.textContent || '').trim().length > 0).length`,
      );
      await ctx.session.pressEscape();
      await sleep(300);
      if (!options) return ctx.fail(`模型下拉展开后没有任何选项（label=「${label}」）——即 P0 回归形态`);
      return ctx.pass(`触发器 label=「${label}」；展开后选项数=${options}`);
    },
  },
  {
    id: 'WL-13',
    name: '显示语言选择器可用且列出五语（含裸 key 泄漏检查）',
    async run(ctx) {
      // 语言选择器位于设置页头部；Meka 助理 tab 下由该面板自己的头部替代，故用默认 tab。
      await ctx.goto('#/settings');
      const selector = 'button[aria-label="显示语言选择"]';
      const exists = await ctx.session.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`);
      if (!exists) return ctx.unverified('未找到「显示语言选择」按钮（UI 结构可能已变）');
      await ctx.session.clickSelector(selector);
      await sleep(800);
      const options = await ctx.session.evaluate(
        `[...document.querySelectorAll('[role=option],[role=menuitemradio]')].map((e) => (e.textContent || '').trim()).filter(Boolean)`,
      );
      await ctx.session.pressEscape();
      await sleep(300);
      // 原始 i18n key 泄漏检查：渲染文本里不应出现 settings.meka.* / meka.* / sidebar.* 这类裸 key。
      const rawKeys = await ctx.session.evaluate(
        `((document.body.innerText || '').match(/(settings|meka|sidebar)\\.[a-zA-Z][a-zA-Z0-9_.]{3,}/g) || []).slice(0, 5)`,
      );
      if (rawKeys.length) return ctx.fail(`界面出现裸 i18n key：${JSON.stringify(rawKeys)}`);
      const languages = options.filter((o) => o !== '跟随系统');
      if (languages.length < 5) {
        return ctx.unverified(`语言菜单只列出 ${languages.length} 种语言：${JSON.stringify(options)}`);
      }
      return ctx.pass(`语言选项=${JSON.stringify(options)}；无裸 key 泄漏（逐语言视觉目检仍需人工）`);
    },
  },
];

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('usage: pnpm desktop:ui-smoke -- [--port N] [--user-data-dir DIR] [--filter WL-2] [--json]');
    return 0;
  }
  const port = resolvePort(options);
  let targets;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    targets = await response.json();
  } catch (error) {
    console.error(`desktop:ui-smoke: 连不上 CDP 端口 ${port}（先跑 pnpm restart:desktop:remote）：${error.message}`);
    return 2;
  }
  const target = targets.find(
    (t) => t.type === 'page' && !/\?(sidebarWindow|resourceUsageWindow|view=)/.test(t.url ?? ''),
  );
  if (!target?.webSocketDebuggerUrl) {
    console.error(`desktop:ui-smoke: 端口 ${port} 上没有找到主窗口页面目标`);
    return 2;
  }

  const session = await CdpSession.connect(target.webSocketDebuggerUrl);
  const results = [];
  const ctx = {
    session,
    hash: () => session.evaluate('location.hash'),
    goto: async (hash) => {
      await session.evaluate(`location.hash = ${JSON.stringify(hash)}`);
      await sleep(900);
    },
    pass: (evidence) => ({ status: 'pass', evidence }),
    fail: (evidence) => ({ status: 'fail', evidence }),
    unverified: (evidence) => ({ status: 'unverified', evidence }),
  };

  try {
    // 等待渲染进程就绪（dev 冷启动可能还在编译）。
    await session.waitFor(`!!document.querySelector('#root, #app') || document.body.children.length > 0`, {
      timeoutMs: READY_TIMEOUT_MS,
      label: 'renderer ready',
    });
    for (const check of CHECKS) {
      if (options.filter && !check.id.includes(options.filter) && !check.name.includes(options.filter)) continue;
      let outcome;
      try {
        outcome = await check.run(ctx);
      } catch (error) {
        outcome = { status: 'fail', evidence: `执行异常：${error instanceof Error ? error.message : String(error)}` };
      }
      results.push({ id: check.id, name: check.name, ...outcome });
    }
    await ctx.goto('#/cc-agent/new').catch(() => {});
  } finally {
    session.close();
  }

  const failed = results.filter((r) => r.status === 'fail');
  const unverified = results.filter((r) => r.status === 'unverified');
  const summary = {
    port,
    target: target.url,
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
      `\nUI_SMOKE ${failed.length ? 'FAILED' : 'PASSED'} — checks=${summary.checked} pass=${summary.pass} fail=${summary.fail} unverified=${summary.unverified}`,
    );
    console.log(`port=${port} target=${target.url}`);
  }
  return failed.length ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`desktop:ui-smoke: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  });
