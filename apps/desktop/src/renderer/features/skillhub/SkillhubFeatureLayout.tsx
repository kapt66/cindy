/**
 * SkillhubFeatureLayout — route container for /skillhub/*.
 *
 * Three responsibilities:
 *   1. Bootstrap the SkillHub module-level store on mount.
 *   2. Derive the project list from CC Agent sessions (via projectGrouping)
 *      and push it into the store. Whenever the project set changes the
 *      store auto-rescans.
 *
 * Outlet renders the child route — either <SkillhubWelcomeView /> (index)
 * or <SkillhubDetailView /> (`/skillhub/:type/global/:name` or
 * `/skillhub/:type/project/:projectHash/:name`).
 *
 * Note: the SidebarUpper does NOT live under this layout's React subtree
 * (the slot mechanism teleports it into the shell), so we use a module-
 * level store for shared state instead of React Context. See useSkillhub.ts
 * for the rationale.
 */

import { useEffect, useRef } from 'react';
import { Outlet } from 'react-router-dom';

import { useRegisterCCAgentSidebar } from '@/features/cc-agent/useRegisterCCAgentSidebar';
import { createLogger } from '@/lib/logger';

const log = createLogger('SkillhubFeatureLayout');
import { refresh as refreshSkillhub, useSkillhub } from './hooks/useSkillhub';
import { useSkillhubProjectBootstrap } from './hooks/useSkillhubProjectBootstrap';
import { useSkillSync } from './hooks/useSkillSync';
import { useAuth } from '@/contexts/AuthContext';

export function SkillhubFeatureLayout() {
  const { mode } = useAuth();
  const cloudSyncEnabled = mode === 'cloud';
  useSkillhubProjectBootstrap();
  // 技能改为右侧整页(无左树导航),左侧 app 侧栏沿用 cc-agent 项目/对话列表。
  // 显式注册同一个 CCAgentSidebarUpper:warm 导航时与 cc-agent 注册的是同一组件
  // 类型,只 reconcile、不 remount(实例状态保留);冷启动直接进 /skillhub 时则首次
  // 播种,避免左栏空白(详见 useRegisterCCAgentSidebar)。
  useRegisterCCAgentSidebar();

  // v0.2.1: trigger batch sync whenever the skill list changes
  const { skills, syncResults, bootstrapped } = useSkillhub();
  useSkillSync(skills, cloudSyncEnabled);

  // 一次性回填:server 端 authorId 是权威结论,把本地 registry 跟它对齐。两类:
  //   1) 没 registry 记录(老 publish 没主动建)
  //   2) 有 registry 但 authorId 缺失/不一致(老 manifest 还没迁移过)
  // 都送去 reconcileMineRegistry,main 决定 add or update。每个 session 至多跑一次。
  // 注意:已有 registry 的 version 不在这里对齐。版本代表本地文件内容基线,
  // 只能在 publish/install/update 这种同步文件内容的流程里更新。
  // 注:本回填只针对"server 说是我自己发的(sync.isMine)"的 skill,因为这种场景
  // 本地 authorId 必须是当前登录用户,补齐后归属判定才会回归 mine 状态。
  const reconciledKeysRef = useRef(new Set<string>());
  useEffect(() => {
    if (!cloudSyncEnabled || !bootstrapped) return;
    if (syncResults.size === 0) return; // sync 还没完成
    const items: Array<{ name: string; absolutePath: string; version: string; authorId: string; folderHash?: string }> = [];
    const itemKeys: Array<{ name: string; key: string }> = [];
    for (const s of skills) {
      if (s.kind !== 'skill') continue;
      const sync = syncResults.get(s.name);
      if (!sync?.exists || !sync.isMine) continue;
      const serverAuthorId = sync.authorId ?? '';
      if (!serverAuthorId) continue; // server 没回 authorId 就别回填
      const latestVersion = typeof sync.latestVersion === 'string' ? sync.latestVersion : '';
      // 已有 registry 且所有需 reconcile 的字段都已对齐 → 跳过
      const reg = s.registryEntry;
      if (reg !== null) {
        const needsAuthorId = reg.authorId !== serverAuthorId;
        const needsOrigin = !(reg.origin === 'published' || reg.origin === 'installed' || reg.origin === 'learned');
        if (!needsAuthorId && !needsOrigin) continue;
      }
      const key = `${s.name}\u0000${s.absolutePath}\u0000${serverAuthorId}`;
      if (reconciledKeysRef.current.has(key)) continue;
      items.push({
        name: s.name,
        absolutePath: s.absolutePath,
        version: latestVersion,
        authorId: serverAuthorId,
        ...(typeof sync.folderHash === 'string' && sync.folderHash ? { folderHash: sync.folderHash } : {}),
      });
      itemKeys.push({ name: s.name, key });
    }
    if (items.length === 0) {
      return;
    }
    void window.electronAPI.skillhub
      .reconcileMineRegistry(items)
      .then((res) => {
        const failedNames = new Set(res.failures.map((f) => f.name));
        for (const item of itemKeys) {
          if (!failedNames.has(item.name)) reconciledKeysRef.current.add(item.key);
        }
        if (res.added > 0 || res.flipped > 0) void refreshSkillhub();
      })
      .catch((err) => {
        log.warn('reconcileMineRegistry failed:', err);
      });
  }, [bootstrapped, cloudSyncEnabled, skills, syncResults]);

  return (
    <div className="flex h-full w-full flex-col">
      <Outlet />
    </div>
  );
}
