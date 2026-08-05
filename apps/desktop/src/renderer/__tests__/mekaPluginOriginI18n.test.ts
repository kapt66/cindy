import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const LOCALES = ['en', 'ja', 'ko', 'zh-CN'] as const;

describe('Meka plugin origin i18n', () => {
  it('provides the dynamic all-origin filter label in every locale', () => {
    for (const locale of LOCALES) {
      const file = resolve(__dirname, '..', 'i18n', 'locales', locale, 'common.json');
      const common = JSON.parse(readFileSync(file, 'utf8')) as {
        settings?: { ghosts?: { meka?: { origin?: { all?: unknown } } } };
      };

      expect(common.settings?.ghosts?.meka?.origin?.all, locale).toEqual(expect.any(String));
    }
  });
});
