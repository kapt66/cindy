import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const readSource = (): string =>
  readFileSync(new URL('../index.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

describe('cindy media catalog edition wiring', () => {
  it('projects plugin image and video capabilities with the runtime edition', () => {
    const source = readSource();
    const start = source.indexOf("function getCatalogMediaConfig(kind: 'image' | 'video')");
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
