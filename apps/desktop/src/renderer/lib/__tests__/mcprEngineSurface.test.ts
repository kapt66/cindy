import { describe, expect, it } from 'vitest';

import { resolveMcprEngineSurface } from '../mcprEngineSurface';
import type { MakerVendor } from '../ccAgent.types';

const all: ReadonlySet<MakerVendor> = new Set<MakerVendor>(['cc', 'codex', 'pi', 'orca']);

describe('MCPRouter 位置下的引擎面', () => {
  it('MCPR 位置下收掉 Pi，其余引擎一个不动', () => {
    const surface = resolveMcprEngineSurface(all, true);
    expect([...surface].sort()).toEqual(['cc', 'codex', 'orca']);
    expect(surface.has('pi')).toBe(false);
  });

  it('非 MCPR 位置原样放行（Pi + SSH 仍是完整能力）', () => {
    expect(resolveMcprEngineSurface(all, false)).toBe(all);
    expect(resolveMcprEngineSurface(all, false).has('pi')).toBe(true);
  });

  it('不需要收窄时返回入参本身（身份稳定，不打断下游 useMemo）', () => {
    // mcprTarget 为真但集合里本来就没有 Pi：不能顺手拷一份新 Set，
    // 否则每次 render 都会让依赖它的 memo 失效。
    const withoutPi: ReadonlySet<MakerVendor> = new Set<MakerVendor>(['cc', 'codex']);
    expect(resolveMcprEngineSurface(withoutPi, true)).toBe(withoutPi);

    const empty: ReadonlySet<MakerVendor> = new Set<MakerVendor>();
    expect(resolveMcprEngineSurface(empty, true)).toBe(empty);
    expect(resolveMcprEngineSurface(empty, false)).toBe(empty);
  });

  it('不修改入参（调用方可能持有同一集合的其它读者）', () => {
    const source = new Set<MakerVendor>(['cc', 'pi']);
    const surface = resolveMcprEngineSurface(source, true);
    expect([...source].sort()).toEqual(['cc', 'pi']);
    expect(surface).not.toBe(source);
  });

  it('只收 Pi —— 不因为「远端」顺手把别的引擎也摘掉', () => {
    const piOnly: ReadonlySet<MakerVendor> = new Set<MakerVendor>(['pi']);
    expect([...resolveMcprEngineSurface(piOnly, true)]).toEqual([]);
    // 只剩 Pi 时引擎面为空：调用方（草稿的 fallbackUnavailableVendor）会拿不到候选而
    // 保持原值，最终由主进程的 MCPR_AGENT_UNSUPPORTED 兜底 —— 这里锁定「不额外发明引擎」。
    expect(resolveMcprEngineSurface(piOnly, true).has('cc')).toBe(false);
    // cc / codex / orca 都不受影响（`orca` 是协同 Worker 的引擎槽，与远端位置无关）。
    expect([...resolveMcprEngineSurface(new Set<MakerVendor>(['cc', 'codex', 'orca']), true)].sort())
      .toEqual(['cc', 'codex', 'orca']);
  });
});
