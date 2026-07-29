// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('useGhostContentRevision', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('只递增完成开发同步的插件，使可见 WebView 重新装载', async () => {
    let notify: ((payload: { id: string }) => void) | null = null;
    const onContentReloaded = vi.fn((callback: (payload: { id: string }) => void) => {
      notify = callback;
      return vi.fn();
    });
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { ghosts: { onContentReloaded } },
    });
    const { useGhostContentRevision } = await import('../ghostContentRevision');
    const first = renderHook(() => useGhostContentRevision('plugin-a'));
    const second = renderHook(() => useGhostContentRevision('plugin-b'));

    expect(first.result.current).toBe(0);
    expect(second.result.current).toBe(0);
    act(() => notify?.({ id: 'plugin-a' }));
    expect(first.result.current).toBe(1);
    expect(second.result.current).toBe(0);
    expect(onContentReloaded).toHaveBeenCalledTimes(1);
  });
});
