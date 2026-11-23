import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProviderView } from '@cindy/model-providers';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { asSshRemoteHostId, type SshRemoteHostId } from '@/lib/remoteCodexModelHost';

const EMPTY: ProviderView[] = [];

/**
 * 读「SSH 执行主机」自己的 Codex 模型清单（`maker:remote-ssh:list-codex-models`）。
 *
 * **参数是品牌类型 `SshRemoteHostId`，不是裸 `string`**：这条探针只对真 SSH 主机成立。
 * `mcpr:<instanceId>` 是 MCPRouter 的隧道身份（模型面就是本机 AI Gateway 目录），其它远程身份
 * 同理；把它们喂进探针只会得到「无法读取远程设备上的模型」这种**假失败**。
 *
 * 2026-11-23 的假告警就是被裸 `string` 放行的：新建任务草稿把 `mcpr:` 直接传进来，主进程
 * 按 transport 分类抛出 `INVALID_PARAMS`，钩子把任何 reject 折叠成 `status:'error'`，模型
 * 选择器随即弹出「请检查连接后重试」。品牌类型让**新增/合并进来的调用点必须先过
 * `asSshRemoteHostId()`，否则 typecheck 直接失败**；下面的运行时复核是给 JS 绕过与合并
 * 回退的第二道保险。判定正本见 `lib/remoteCodexModelHost.ts`。
 */
export function useSshCodexProviders(hostId?: SshRemoteHostId | null) {
  // 运行时复核同一条判据：非 SSH 身份**绝不发起 IPC**（正常调用点由品牌类型保证）。
  const sshHostId = asSshRemoteHostId(hostId);
  const owner = getDataOwnerGeneration();
  const key = JSON.stringify([sshHostId, owner.dataOwnerId, owner.generation]);
  const sequence = useRef(0);
  const [state, setState] = useState<{ key: string; providers: ProviderView[]; status: 'loading' | 'error' | 'ready' }>({
    key: '', providers: EMPTY, status: 'loading',
  });
  const refresh = useCallback(async () => {
    if (!sshHostId) return false;
    const request = ++sequence.current;
    const requestOwner = getDataOwnerGeneration();
    setState({ key, providers: EMPTY, status: 'loading' });
    return window.electronAPI.remoteSsh.listCodexModels(sshHostId).then((providers) => {
      if (sequence.current === request && isDataOwnerGenerationCurrent(requestOwner)) {
        setState({ key, providers, status: 'ready' });
      }
      return true;
    }).catch(() => {
      if (sequence.current === request && isDataOwnerGenerationCurrent(requestOwner)) {
        setState({ key, providers: EMPTY, status: 'error' });
      }
      return false;
    });
  }, [sshHostId, key]);
  useEffect(() => {
    if (!sshHostId) return;
    const initialRefresh = refresh();
    const initialRequest = sequence.current;
    let disposed = false;
    // The push subscription does not replay the current connection state.
    // The first ready may finish a connection already in progress on mount.
    let wasReady: boolean | null = null;
    const stop = window.electronAPI.remoteSsh.onStatusChanged((snapshot) => {
      if (snapshot.config.id !== sshHostId) return;
      if (snapshot.status === 'ready') {
        if (wasReady === null) {
          void initialRefresh.then((success) => {
            if (!success && !disposed && wasReady && sequence.current === initialRequest) void refresh();
          });
        } else if (!wasReady) void refresh();
        wasReady = true;
      }
      else {
        wasReady = false;
        ++sequence.current;
        setState({ key, providers: EMPTY, status: 'error' });
      }
    });
    return () => { disposed = true; ++sequence.current; stop(); };
  }, [sshHostId, key, refresh]);
  const retry = useCallback(() => { void refresh(); }, [refresh]);
  // 非 SSH 身份（品牌类型上已不可达；这里兜 `as any` / 合并回退出来的裸字符串）：
  // 不发任何 IPC，也不报错 —— 「没有远端 Codex 清单」对 MCPRouter / 本地目标是**事实**，
  // 不是连接失败，调用方据此回落本机目录即可。
  if (hostId != null && sshHostId === null) {
    return { providers: EMPTY, status: 'ready' as const, refresh: retry };
  }
  return {
    providers: state.key === key ? state.providers : EMPTY,
    status: state.key === key ? state.status : 'loading' as const,
    refresh: retry,
  };
}
