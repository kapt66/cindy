/**
 * 「远程工作区」入口的**位置**契约（2026-11-26 用户口径）。
 *
 * 用户明确要求：入口从窗口右上角挪到**会话标题行内、标题后的「…」菜单之后**
 * （`[图标][标题][…][远程工作区]`），并且只在 `psb:` 会话页出现。这件事跨两个文件接线
 * （`SessionContentHeader.tsx` 负责渲染位置、`MainLayout.tsx` 负责**不再**把它放进
 * `ContentHeader.trailing`），没有任何单一模块的运行时能把「它不在窗口角」作为可观察结果
 * 断言出来，所以按仓库既有先例用源码结构 guard 锁定（同类：`sessionHeaderMenuParity`、
 * `remoteTransportProbeWiring.guard`）。
 *
 * 行为级覆盖在 unit tier：`RemoteWorkspaceAdminButton.test.tsx`（psb-only + 文案 + 打开全局
 * 页签）与 `stream/__tests__/remoteWorkspaceStreamGates.test.ts`（`psb:` 身份判据矩阵）。
 *
 * 最小失败输入：把按钮重新塞回 `ContentHeader.trailing`（回到窗口右上角）；或渲染顺序挪到
 * 「…」菜单之前（标题与按钮之间的位置约定被破坏）。tier：guard（source contract）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const read = (relative: string): string =>
  readFileSync(resolve(__dirname, relative), 'utf8').replace(/\r\n/g, '\n');

const sessionHeaderSource = read('../../../cc-agent/SessionContentHeader.tsx');
const mainLayoutSource = read('../../../../components/layout/MainLayout.tsx');

describe('「远程工作区」入口位置', () => {
  it('renders the entry inside the session title row, after the overflow menu', () => {
    expect(sessionHeaderSource).toContain(
      "import { RemoteWorkspaceAdminButton } from '@/features/remote-workspace/admin/RemoteWorkspaceAdminButton';",
    );
    // 「…」菜单是标题行里最后一个下拉菜单：入口必须排在它之后。
    const menuClose = sessionHeaderSource.indexOf('</DropdownMenu>');
    const entry = sessionHeaderSource.indexOf('<RemoteWorkspaceAdminButton');
    expect(menuClose).toBeGreaterThan(-1);
    expect(entry).toBeGreaterThan(menuClose);
    // 仍在标题行内（在紧随其后的 Git 上下文徽标之前），不是内容区里的独立浮层。
    const gitBadge = sessionHeaderSource.indexOf('<GitContextBadge');
    expect(gitBadge).toBeGreaterThan(entry);
    // 传给按钮的是本条会话的本地 id 与远端身份，判据由按钮内部统一做（psb-only）。
    expect(sessionHeaderSource).toContain('sessionId={session.id}');
    expect(sessionHeaderSource).toContain('remoteHostId={session.remoteHostId}');
  });

  it('is no longer mounted in the window-corner ContentHeader trailing slot', () => {
    expect(mainLayoutSource).not.toContain('RemoteWorkspaceAdminButton');
    expect(mainLayoutSource).not.toContain('shouldShowRemoteWorkspaceAdminEntry');
    // trailing 现在只留给插件顶栏条目与 mac 远程桌面按钮。
    const trailing = mainLayoutSource.slice(
      mainLayoutSource.indexOf('trailing={'),
      mainLayoutSource.indexOf('trailing={') + 1200,
    );
    expect(trailing).not.toContain('remote-workspace');
  });
});
