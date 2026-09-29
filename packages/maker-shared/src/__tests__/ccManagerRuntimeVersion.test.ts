import { describe, expect, it } from 'vitest';

import {
  CC_MGR_VERSION_MISMATCH_MARKER,
  isCcMgrRuntimeVersionMismatchError,
  projectCcMgrRuntimeVersionMismatch,
  readCcMgrRuntimeVersionMismatch,
  readProjectedCcMgrRuntimeVersions,
} from '../ccManagerRuntimeVersion.js';

/** 现场原文（2026-09-28 实机日志：main-2026-09-28.log 的 LAZY_CREATE_FAILED message）。 */
const INCIDENT =
  '[INVALID_BUNDLE_VERSION] client bundle 0.0.10 does not match server bundle 0.0.9';

describe('cc-mgr 运行时版本不匹配的线协议', () => {
  it('认出现场原文并读出两边版本', () => {
    expect(readCcMgrRuntimeVersionMismatch(INCIDENT)).toEqual({
      clientBundle: '0.0.10',
      serverBundle: '0.0.9',
    });
  });

  it('规约成带 marker 的线消息（Main → 渲染层）', () => {
    const projected = projectCcMgrRuntimeVersionMismatch(INCIDENT);
    expect(projected).toBe(`${CC_MGR_VERSION_MISMATCH_MARKER} client=0.0.10 server=0.0.9`);
    expect(isCcMgrRuntimeVersionMismatchError(projected)).toBe(true);
    expect(readProjectedCcMgrRuntimeVersions(projected)).toEqual({
      clientBundle: '0.0.10',
      serverBundle: '0.0.9',
    });
  });

  it('规约是幂等的（消息可能被多层包装）', () => {
    const once = projectCcMgrRuntimeVersionMismatch(INCIDENT);
    expect(projectCcMgrRuntimeVersionMismatch(once)).toBe(once);
    expect(readCcMgrRuntimeVersionMismatch(once)).toEqual({
      clientBundle: '0.0.10',
      serverBundle: '0.0.9',
    });
  });

  it('已经带 LAZY_CREATE_FAILED 前缀的报文同样认得', () => {
    const wrapped = `LAZY_CREATE_FAILED: ${INCIDENT}`;
    expect(projectCcMgrRuntimeVersionMismatch(wrapped)).toBe(
      `${CC_MGR_VERSION_MISMATCH_MARKER} client=0.0.10 server=0.0.9`,
    );
  });

  it('RpcClientError 形态的 `Error: ` 包装同样认得', () => {
    const wrapped = `Error: [INVALID_BUNDLE_VERSION] client bundle 0.0.11 does not match server bundle 0.0.10`;
    expect(readCcMgrRuntimeVersionMismatch(wrapped)).toEqual({
      clientBundle: '0.0.11',
      serverBundle: '0.0.10',
    });
  });

  it('认不出的报文原样透传（绝不改写别的错误）', () => {
    for (const other of [
      '',
      'lazy create failed',
      'remote SSH host "mcpr:x" not found in pool — connect it first under Settings → Remote',
      '[INVALID_PROTOCOL_VERSION] client protocol 6 is not supported',
      // 形状像但版本号非法（超长 / 含空格）→ 不认，避免把自由文本当版本渲染。
      'client bundle 0.0.10; rm -rf / does not match server bundle 0.0.9',
    ]) {
      expect(isCcMgrRuntimeVersionMismatchError(other)).toBe(false);
      expect(projectCcMgrRuntimeVersionMismatch(other)).toBe(other);
      expect(readCcMgrRuntimeVersionMismatch(other)).toBeNull();
    }
  });

  it('版本号长度有界（不会把超长串当版本）', () => {
    const tooLong = 'a'.repeat(64);
    const message = `client bundle ${tooLong} does not match server bundle 0.0.9`;
    expect(readCcMgrRuntimeVersionMismatch(message)).toBeNull();
  });

  it('marker 是稳定的字面量（两侧协议，不得改写）', () => {
    expect(CC_MGR_VERSION_MISMATCH_MARKER).toBe('[REMOTE_CC_MGR_VERSION_MISMATCH]');
  });
});
