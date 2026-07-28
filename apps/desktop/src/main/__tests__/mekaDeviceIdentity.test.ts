import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const mainRoot = path.resolve(__dirname, '..');

describe('Cindy Meka Desktop device identity bootstrap', () => {
  it('在 authManager 动态加载前为普通与 isolated 实例设置产品命名空间 deviceId', () => {
    const source = fs.readFileSync(path.join(mainRoot, 'index.ts'), 'utf8');
    const normalAssignment =
      'process.env.XDT_DEVICE_ID_OVERRIDE = brandDesktopDeviceId(machineIdSync())';
    const isolatedDerivation =
      'brandDesktopIsolatedDeviceId(machineIdSync(), devFlags.isolationName)';

    expect(source).toContain(normalAssignment);
    expect(source).toContain(isolatedDerivation);
    expect(source.indexOf(normalAssignment)).toBeLessThan(
      source.indexOf("import('./bootstrap-electron.js')"),
    );
    expect(source.indexOf(isolatedDerivation)).toBeLessThan(
      source.indexOf("import('./bootstrap-electron.js')"),
    );
  });
});
