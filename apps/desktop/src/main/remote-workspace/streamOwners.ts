/**
 * 「谁在看这条串流」的**引用计数**账本（main 侧，纯数据结构、不碰 Electron）。
 *
 * ## 为什么需要它
 *
 * PSB 的串流订阅是**进程内共享**的一条观看端连接：同一 `sessionId` 被多个窗口同时观看时，
 * 只能有一条 WS（PSB 的观看名额与网页观看端共用，且同一 `subscriberId` 重连是替换而不是
 * 新订阅）。旧实现用 `Map<sessionId, webContentsId>` 记「最后一个启动者」：窗口 A 先看、
 * 窗口 B 再看，随后 A 关掉面板 → 旧逻辑会**直接停流**，B 的画面黑掉；多窗口同时停止时
 * 又会重复 `stopStream`。正确语义是「最后离开的人关灯」：进入 +1、离开 -1，只有归零才停。
 *
 * ## 为什么单独一个模块
 *
 * 这段逻辑要在两个地方用：IPC handler（启动/停止/窗口销毁时决定是否真的停流）与推送层
 * （帧只发给这条串流真正的主人）。把它写成不依赖 `electron` 的纯结构，才能用单测覆盖
 * 「多窗口交替进出」「窗口销毁兜底」「重复停止幂等」这些现场很难复现的顺序。窗口 / 通道的
 * 绑定由调用方提供，本模块只记 `key → Set<ownerId>`。
 *
 * ## 命名口径
 *
 * `key` 是「哪条串流」的稳定标识：会话级通道用 `session:<sessionId>`，管理页用
 * `admin:<workspaceId>`（管理页的观看端绑定由 main 解析，渲染层不持有会话 id）。`ownerId`
 * 是 `webContents.id`（窗口 / 面板的实际生命周期边界）。
 */

export interface PsbStreamOwnerRegistry {
  /**
   * 登记一个观看者。返回 `true` = 该 key 此前没有任何人（调用方据此决定「需要新开/复用
   * 连接」由自己的端口语义判断，不在本模块里做）。
   */
  add(key: string, ownerId: number): boolean;
  /** 取消一个观看者。返回 `true` = 该 key 现在没有任何人（调用方据此真正停流）。 */
  remove(key: string, ownerId: number): boolean;
  /** 某 key 当前的全部 owner（顺序 = 登记顺序；推送层按此定向投递）。 */
  owners(key: string): number[];
  /** 某个窗口拥有的全部 key（窗口销毁时兜底清理用；返回的是**已清空**的 key）。 */
  removeOwner(ownerId: number): string[];
  /** 当前 key 数（诊断 / 测试）。 */
  size(): number;
  /** 清空（服务 dispose / 账号边界）。 */
  clear(): void;
}

export function createPsbStreamOwnerRegistry(): PsbStreamOwnerRegistry {
  const owners = new Map<string, Set<number>>();
  return {
    add(key, ownerId) {
      const current = owners.get(key);
      if (!current) {
        owners.set(key, new Set([ownerId]));
        return true;
      }
      current.add(ownerId);
      return false;
    },
    remove(key, ownerId) {
      const current = owners.get(key);
      if (!current) return false;
      current.delete(ownerId);
      if (current.size > 0) return false;
      owners.delete(key);
      return true;
    },
    owners(key) {
      return [...(owners.get(key) ?? [])];
    },
    removeOwner(ownerId) {
      const released: string[] = [];
      for (const [key, current] of owners) {
        if (!current.delete(ownerId)) continue;
        if (current.size === 0) {
          owners.delete(key);
          released.push(key);
        }
      }
      return released;
    },
    size() {
      return owners.size;
    },
    clear() {
      owners.clear();
    },
  };
}
