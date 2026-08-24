import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(__dirname, '..', 'bootstrap-electron.ts'), 'utf8').replace(
  /\r\n?/g,
  '\n',
);

describe('Remote SSH IPC startup ordering', () => {
  it('registers exactly once before the first renderer window is created', () => {
    const registrations = [...source.matchAll(/\bregisterRemoteSshIpc\(\);/g)].map(
      (match) => match.index,
    );
    const firstWindow = source.indexOf('\n  createWindow();');

    expect(registrations).toHaveLength(1);
    expect(firstWindow).toBeGreaterThan(-1);
    expect(registrations[0]).toBeLessThan(firstWindow);
  });
});
