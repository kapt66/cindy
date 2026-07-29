import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { PluginChannelLedger } from '../channelLedger';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function ledger() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-plugin-channel-'));
  roots.push(root);
  return new PluginChannelLedger(path.join(root, 'channels.v1.json'));
}

describe('PluginChannelLedger', () => {
  it('moves a local package into and out of the Meka channel', () => {
    const subject = ledger();

    subject.setMeka('taptap-maker', true);
    subject.setMeka('meka-owned', true);
    subject.setMeka('taptap-maker', false);

    expect(subject.readMekaGhostIds()).toEqual(['meka-owned']);
  });

  it('fails closed for malformed or unsupported data', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-plugin-channel-'));
    roots.push(root);
    const filePath = path.join(root, 'channels.v1.json');
    fs.writeFileSync(filePath, '{"schemaVersion":2,"mekaGhostIds":["wrong"]}');

    expect(new PluginChannelLedger(filePath).readMekaGhostIds()).toEqual([]);
  });
});
