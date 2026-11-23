/**
 * remote transport 分类在渲染层的接线契约（2026-11-23）。
 *
 * 背景：SSH-only 的「读远端 Codex 清单」探针（`maker:remote-ssh:list-codex-models`）只对**真 SSH
 * 执行主机**成立。`mcpr:<instance-id>` 是 MCPRouter 的隧道身份，它的模型面就是本机 AI Gateway
 * 目录（远端 bridge 只带本机 key），喂进探针只会得到一个假失败。
 *
 * 这条规则各炸过一次：
 *   · 2026-10-08 `ChatInput` 把任意 `remoteHostId` 当 SSH Codex 主机 → 报错 + 禁止发送；
 *   · 2026-11-23 新建任务草稿（2026-11-02 新增的 SSH 草稿目录）绕过唯一判据 →
 *     MCPRouter 远程项目一打开模型选择器就弹「无法读取远程设备上的模型」。
 *
 * 两次的形状相同：**调用点各自记得分类**。本文件是合并防回归的静态契约——上游同步若把某个
 * 文件整体解回旧版、丢了判据，这里直接红，而不是等用户在看板上看到假告警。行为级覆盖在 unit
 * tier（`__tests__/sshCodexModels.test.tsx`、`lib/__tests__/remoteCodexModelHost.test.ts`）。
 *
 * 为什么这条能进 guard tier：它断言的是**跨文件接线**（哪个入口可以用 SSH-only 探针），不是
 * 单一模块的运行时行为；`scripts/check-test-hygiene.mjs` 的 source-read 规则正是为此保留
 * 显式白名单（见 `scripts/test-workspaces.config.mjs` 的 `desktopGuardInclude`）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relative: string): string =>
  readFileSync(resolve(__dirname, relative), 'utf8').replace(/\r\n/g, '\n');

const decisionSource = read('../lib/remoteCodexModelHost.ts');
const hookSource = read('../hooks/useSshCodexProviders.ts');
const draftRouteSource = read('../features/cc-agent/NewMakerDraftRoute.tsx');
const chatInputSource = read('../components/new-chat/ChatInput.tsx');
const selectionSource = read('../features/cc-agent/sshSessionModelSelection.ts');
const errorBannerSource = read('../components/chat/ErrorBanner.tsx');
const mainHandlerSource = read('../../main/remote-ssh/index.ts');

describe('SSH-only 模型清单探针的接线', () => {
  it('唯一判据模块仍是 transport 品牌类型与两个入口判据的唯一定义处', () => {
    expect(decisionSource).toContain('export type SshRemoteHostId = string &');
    expect(decisionSource).toContain('export function asSshRemoteHostId(');
    expect(decisionSource).toContain('export function resolveRemoteCodexModelHostId(');
    expect(decisionSource).toContain('export function resolveSshCodexCatalogHostId(');
    // 判据必须与主进程共用前缀常量，不得退回写死的 'mcpr:' 字面量。
    expect(decisionSource).toContain('MCPR_REMOTE_HOST_PREFIX');
    expect(decisionSource).not.toMatch(/startsWith\(\s*['"]mcpr:/);
  });

  it('钩子入口只接受品牌类型，且发 IPC 前做运行时复核', () => {
    expect(hookSource).toContain('hostId?: SshRemoteHostId | null');
    expect(hookSource).toContain("from '@/lib/remoteCodexModelHost'");
    expect(hookSource).toContain('const sshHostId = asSshRemoteHostId(hostId);');
    expect(hookSource).toContain('.listCodexModels(sshHostId)');
  });

  it('新建任务草稿只为真 SSH 目标建目录，不再把 mcpr / device-link 目标当 SSH 主机', () => {
    expect(draftRouteSource).toContain('resolveSshCodexCatalogHostId({');
    // 2026-11-02 的裸条件（2026-11-23 假告警的直接原因）：有 remoteHostId 就当 SSH 主机。
    expect(draftRouteSource).not.toMatch(/sshDraftHostId\s*=\s*!catalogDeviceId\s*\?/);
    expect(draftRouteSource).not.toMatch(/useSshCodexProviders\(\s*effectiveRemoteHostId/);
  });

  it('ChatInput 的两条路径都先过判据', () => {
    // Codex 探针：引擎级判据；SSH Codex 目录：transport 判据。
    expect(chatInputSource).toContain('resolveRemoteCodexModelHostId({');
    expect(chatInputSource).toContain('resolveSshCodexCatalogHostId({');
    // 模型面就是本机目录的目标（本地 / device-link / mcpr）不得挂空 SSH 目录：空目录会被
    // `mergeSshCodexCatalog` 当成「远端没有」，把本机目录里的 codex 型号整组剥掉。
    expect(chatInputSource).not.toMatch(/sshCodexCatalogOverride \?\? \(sshHostId/);
    expect(chatInputSource).not.toMatch(/sshHostId \? mergeSshCodexCatalog/);
  });

  it('会话模型选择在读远端清单前判过 transport', () => {
    const guard = selectionSource.indexOf('resolveRemoteCodexModelHostId({');
    const probe = selectionSource.indexOf('.listCodexModels(');
    expect(guard).toBeGreaterThan(0);
    expect(probe).toBeGreaterThan(guard);
  });

  it('SSH 专属的「同步 Codex 登录」只对真 SSH 主机成立', () => {
    // 把本机 auth.json 推到远端是 SSH 语义；`mcpr:` 没有可推送的远端登录态，
    // 传进探针只会得到 `SSH_HOST_NOT_FOUND: unknown host: mcpr:…`。
    expect(errorBannerSource).toContain('const sshRemoteHostId = asSshRemoteHostId(remoteHostId);');
    expect(errorBannerSource).toContain(
      'isCodexRemoteAuthMissing = isCodexAuthMissing && sshRemoteHostId != null;',
    );
    expect(errorBannerSource).not.toMatch(/remoteSsh\.(?:checkCodexAuth|syncCodexAuth)\(remoteHostId/);
  });

  it('主进程 LIST_CODEX_MODELS 先分类再读，非 SSH 抛 INVALID_PARAMS（第二道保险）', () => {
    const handlerStart = mainHandlerSource.indexOf(
      'ipcMain.handle(REMOTE_SSH_INVOKE.LIST_CODEX_MODELS',
    );
    expect(handlerStart).toBeGreaterThan(0);
    const handler = mainHandlerSource.slice(handlerStart, handlerStart + 4000);
    const classify = handler.indexOf('classifyRemoteSessionTransport(');
    const readList = handler.indexOf('readSshCodexModelList(');
    expect(classify).toBeGreaterThan(0);
    expect(classify).toBeLessThan(readList);
    expect(handler).toContain("'INVALID_PARAMS'");
  });
});
