/**
 * Regression coverage for the Cindy-assisted Plugin creation draft.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const zhCommon = JSON.parse(
  readFileSync(
    resolve(__dirname, '..', '..', '..', 'i18n', 'locales', 'zh-CN', 'common.json'),
    'utf8',
  ),
) as {
  settings: {
    ghosts: {
      meka: { createPromptLead: string; createWithCindy: string };
      page: { createPrompt: string };
    };
  };
};
const pageSource = readFileSync(resolve(__dirname, '..', 'GhostPluginPage.tsx'), 'utf8');

describe('Ghost Plugin creation prompt', () => {
  it('reads the forge guide before designing, packing, and installing', () => {
    const prompt = zhCommon.settings.ghosts.page.createPrompt;

    expect(prompt).toContain('先从提问开始');
    expect(prompt.indexOf('ghost_forge_guide')).toBeGreaterThanOrEqual(0);
    expect(prompt.indexOf('ghost_forge_guide')).toBeLessThan(prompt.indexOf('ghost_forge_pack'));
    expect(prompt).toContain('打包并安装插件');
  });

  it('marks Cindy-assisted creation as Meka without adding manifest provenance', () => {
    const { createPromptLead, createWithCindy } = zhCommon.settings.ghosts.meka;

    expect(createWithCindy).toBe('创建 Meka 插件');
    expect(createPromptLead).toContain('MCPRouter');
    expect(createPromptLead).toContain('channel: "meka"');
    expect(createPromptLead).toContain('ghost_forge_pack');
    expect(createPromptLead).toContain('ghost.json');
    expect(createPromptLead).toContain('不要');
    expect(createPromptLead).toContain('.cindy');
    expect(pageSource).toContain("t('settings.ghosts.meka.createPromptLead')");
    expect(pageSource).toContain("t('settings.ghosts.page.createPrompt')");
  });

  it('keeps Cindy and MCPRouter catalogs separate by channel provenance', () => {
    expect(pageSource).toContain('window.electronAPI.mekaPluginMarket');
    expect(pageSource).toContain('window.electronAPI.pluginMarket');
    expect(pageSource).toContain('mekaInstalledGhostIdSet.has(item.id)');
    expect(pageSource).toContain('!mekaInstalledGhostIdSet.has(item.id)');
    expect(pageSource).not.toContain('if (!isMekaSurface) return [];');
  });
});
