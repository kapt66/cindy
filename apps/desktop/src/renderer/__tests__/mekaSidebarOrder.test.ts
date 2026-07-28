import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const sidebarSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'CCAgentSidebarUpper.tsx'),
  'utf8',
);

describe('Meka sidebar order', () => {
  it('renders Meka conversations before pinned and ordinary conversation groups', () => {
    const mekaIndex = sidebarSource.indexOf('<MekaAssistantSection');
    const pinnedIndex = sidebarSource.indexOf('<PinnedSection');
    const projectsIndex = sidebarSource.indexOf('<ProjectsSection');
    const dialogueIndex = sidebarSource.indexOf('<DialogueSection');

    expect(mekaIndex).toBeGreaterThan(-1);
    expect(mekaIndex).toBeLessThan(pinnedIndex);
    expect(mekaIndex).toBeLessThan(projectsIndex);
    expect(mekaIndex).toBeLessThan(dialogueIndex);
  });
});
