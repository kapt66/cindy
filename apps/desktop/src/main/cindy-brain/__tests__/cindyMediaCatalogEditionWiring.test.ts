import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const readSource = (): string =>
  readFileSync(new URL('../index.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

describe('cindy media catalog edition wiring', () => {
  it('projects plugin media capabilities with the runtime edition', () => {
    const source = readSource();
    // 上游把签名重构成多行（`kind` 之外还有 `action` / `selectedProviderId`），
    // 这里只锚定函数名，函数体边界由下面的 end 标记切出。
    const start = source.indexOf('function getCatalogMediaConfig(');
    const end = source.indexOf('\n}\n\nconst getCatalogImageConfig', start);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const functionSource = source.slice(start, end);
    expect(functionSource).toMatch(
      /projectProviderCatalogForBuildRegion\(\s*getActiveCatalog\(\),\s*getAuthState\(\)\.edition,?\s*\)/,
    );
    expect(functionSource).not.toContain('CURRENT_CINDY_REGION');
  });
});
