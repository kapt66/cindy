import { contextBridge, ipcRenderer } from 'electron';
import { createGhostPageBridge } from '../shared/ghostPageBridge';

/**
 * 意识电子脑的最小管子桥(脑机接口;docs/dev-rules/plugin-security-and-authoring.md)。
 *
 * 只注入**离屏逻辑页**(电子脑);面板页零桥零特权(面板与逻辑页走同源
 * BroadcastChannel,主机零中转)。身份不自报:main 侧按 sender webContents
 * 与意识 id 的绑定表验身,冒名调用直接拒(结构隔离,见 electronSandboxAdapter)。
 *
 * 上游把通用入口收敛进 `shared/ghostPageBridge` 的 createGhostPageBridge
 * (ping / ui / send / onHostMessage / host.call / recommendations / request /
 * fetch / network / downloads / fs / deviceSync / liveScreenView / library /
 * targets / observe / companions / tasks / agent / routines / node / pick /
 * pickModel / preview / taskView / workspace / confirm)。本文件只保留宿主接线
 * 与 Meka 私有的两条管子,两者挂在同一个 `window.cindy` 上:
 * - reveal(req):reveal 槽的便捷口——send({type:'reveal-request', …req}) 的
 *   语法糖;主机只定位现存的本机普通文件/文件夹并交 OS 文件管理器,不把路径回传给插件。
 * - mcpr.status()/configureLogin()/call(req)/local(req):mcpr 槽便捷口。插件只提交
 *   manifest 已声明的逻辑 route 与受限本地服务器动作;Router 地址、session、本机路径
 *   和 PID 始终留在 Host。
 *
 * 变更时同步更新 docs/dev-rules/plugin-security-and-authoring.md 的管子协议条目。
 */

// Injected only into the logic page. Main resolves identity from the real sender.
const bridge = createGhostPageBridge({
  ping: () => ipcRenderer.invoke('ghost-pipe:ping'),
  send: payload => ipcRenderer.invoke('ghost-pipe:send', payload),
});
ipcRenderer.on('ghost-pipe:message', (_event, payload: unknown) => bridge.deliver(payload));

/** [MEKA] 私有管子:只做语法糖,资格审/路径校验/认证与频控全在 Host 槽位。 */
const mekaPipe = {
  reveal: (req: Record<string, unknown>): Promise<unknown> =>
    ipcRenderer.invoke('ghost-pipe:send', { ...req, type: 'reveal-request' }),
  mcpr: {
    status: (): Promise<unknown> =>
      ipcRenderer.invoke('ghost-pipe:send', { type: 'mcpr-request', operation: 'status' }),
    configureLogin: (): Promise<unknown> =>
      ipcRenderer.invoke('ghost-pipe:send', {
        type: 'mcpr-request',
        operation: 'configure-login',
      }),
    call: (request: Record<string, unknown>): Promise<unknown> =>
      ipcRenderer.invoke('ghost-pipe:send', {
        type: 'mcpr-request',
        operation: 'call',
        request,
      }),
    local: (input: Record<string, unknown>): Promise<unknown> =>
      ipcRenderer.invoke('ghost-pipe:send', {
        type: 'mcpr-request',
        operation: 'local',
        input,
      }),
  },
};

contextBridge.exposeInMainWorld('cindy', { ...bridge.api, ...mekaPipe });
