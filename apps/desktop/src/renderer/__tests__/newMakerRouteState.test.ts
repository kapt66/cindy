import { describe, expect, it, vi } from 'vitest';

import {
  consumeNewMakerDialogueTargetRequest,
  consumeNewMakerFolderPickerRequest,
  consumeNewMakerNavigationIntent,
  makeDialogueNewMakerRouteState,
  makeFolderPickerNewMakerRouteState,
  makePsbTargetNewMakerRouteState,
  isSameNewMakerDevice,
  readNewMakerDialogueTargetRequest,
  readNewMakerFolderPickerRequest,
  readNewMakerNavigationIntent,
  shouldPrefillDefaultNewTaskWorkingDir,
} from '@/features/cc-agent/lib/newMakerRouteState';

describe('default directory for a new local task', () => {
  const emptyLocalDraft = { workingDir: null, remoteHostId: null, deviceLinkDeviceId: null };

  it('fills a generic local draft and yields to an explicitly chosen project', () => {
    expect(
      shouldPrefillDefaultNewTaskWorkingDir({ workspacePrompt: 'generic' }, emptyLocalDraft),
    ).toBe(true);
    expect(shouldPrefillDefaultNewTaskWorkingDir(null, emptyLocalDraft)).toBe(false);
    expect(
      shouldPrefillDefaultNewTaskWorkingDir(
        { workspacePrompt: 'generic' },
        { ...emptyLocalDraft, explicitNoProject: true },
      ),
    ).toBe(false);
    expect(
      shouldPrefillDefaultNewTaskWorkingDir(
        { workspacePrompt: 'generic' },
        {
          ...emptyLocalDraft,
          workingDir: '/chosen-project',
        },
      ),
    ).toBe(false);
  });

  it('does not replace a dialogue or a remote target', () => {
    expect(
      shouldPrefillDefaultNewTaskWorkingDir(makeDialogueNewMakerRouteState(null), emptyLocalDraft),
    ).toBe(false);
    expect(
      shouldPrefillDefaultNewTaskWorkingDir(
        {
          workspacePrompt: 'generic',
          dialogueTargetRequest: {
            requestId: 'remote',
            deviceId: 'computer-a',
            deviceName: 'Computer A',
          },
        },
        emptyLocalDraft,
      ),
    ).toBe(false);
    expect(
      shouldPrefillDefaultNewTaskWorkingDir(null, {
        ...emptyLocalDraft,
        remoteHostId: 'ssh-a',
      }),
    ).toBe(false);
    expect(
      shouldPrefillDefaultNewTaskWorkingDir(null, {
        ...emptyLocalDraft,
        deviceLinkDeviceId: 'computer-a',
      }),
    ).toBe(false);
  });
});

describe('new maker execution device identity', () => {
  it.each([
    {
      label: 'local',
      deviceLinkDeviceId: null,
      remoteHostId: null,
      expected: [true, false, false],
    },
    {
      label: 'remote A',
      deviceLinkDeviceId: 'a',
      remoteHostId: null,
      expected: [false, true, false],
    },
    {
      label: 'remote B',
      deviceLinkDeviceId: 'b',
      remoteHostId: null,
      expected: [false, false, true],
    },
    {
      label: 'SSH',
      deviceLinkDeviceId: null,
      remoteHostId: 'ssh-a',
      expected: [false, false, false],
    },
  ])('preserves only the matching execution target for $label drafts', ({ expected, ...draft }) => {
    expect([null, 'a', 'b'].map((deviceId) => isSameNewMakerDevice(deviceId, draft))).toEqual(
      expected,
    );
  });

  it('distinguishes SSH and local even when a folder path is reused', () => {
    const draft = {
      deviceLinkDeviceId: null,
      remoteHostId: 'ssh-a' as string | null,
      workingDir: '/project',
    };
    expect(isSameNewMakerDevice(null, draft)).toBe(false);
    draft.remoteHostId = null;
    expect(isSameNewMakerDevice(null, draft)).toBe(true);
    draft.remoteHostId = 'ssh-b';
    expect(isSameNewMakerDevice(null, draft)).toBe(false);
  });
});

describe('new maker dialogue route target request', () => {
  it('encodes remote and local dialogue targets', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1234);
    const remote = makeDialogueNewMakerRouteState({
      deviceId: 'remote-a',
      deviceName: 'Remote A',
    });
    const local = makeDialogueNewMakerRouteState(null);

    expect(readNewMakerDialogueTargetRequest(remote)).toMatchObject({
      deviceId: 'remote-a',
      deviceName: 'Remote A',
    });
    expect(readNewMakerDialogueTargetRequest(local)).toMatchObject({
      deviceId: null,
      deviceName: null,
    });
  });

  it('generates a fresh request for repeated navigation to an already-mounted route', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1234);
    const first = readNewMakerDialogueTargetRequest(makeDialogueNewMakerRouteState(null));
    const second = readNewMakerDialogueTargetRequest(makeDialogueNewMakerRouteState(null));
    expect(first?.requestId).not.toBe(second?.requestId);
  });

  it('rejects malformed route state instead of guessing a target', () => {
    expect(readNewMakerDialogueTargetRequest(null)).toBeNull();
    expect(readNewMakerDialogueTargetRequest({ dialogueTargetRequest: {} })).toBeNull();
    expect(
      readNewMakerDialogueTargetRequest({
        dialogueTargetRequest: {
          requestId: 'bad',
          deviceId: null,
          deviceName: 'orphan-name',
        },
      }),
    ).toBeNull();
  });

  it('consumes an applied target request without changing the original or other route state', () => {
    const original = {
      workspacePrompt: 'dialogue',
      dialogueTargetRequest: {
        requestId: 'request-a',
        deviceId: 'remote-a',
        deviceName: 'Remote A',
      },
      preserved: { source: 'sidebar' },
    };

    const consumed = consumeNewMakerDialogueTargetRequest(original);

    expect(consumed).toEqual({
      workspacePrompt: 'dialogue',
      preserved: { source: 'sidebar' },
    });
    expect(readNewMakerDialogueTargetRequest(consumed)).toBeNull();
    expect(readNewMakerDialogueTargetRequest(original)).toMatchObject({
      requestId: 'request-a',
      deviceId: 'remote-a',
    });
  });

  it('leaves unrelated or non-object history state untouched', () => {
    const unrelated = { workspacePrompt: 'generic' };
    expect(consumeNewMakerDialogueTargetRequest(unrelated)).toBe(unrelated);
    expect(consumeNewMakerDialogueTargetRequest(null)).toBeNull();
  });
});

describe('new maker folder picker request', () => {
  it('opens the picker again when the same route is already mounted', () => {
    vi.spyOn(Date, 'now').mockReturnValue(5678);
    const first = readNewMakerFolderPickerRequest(makeFolderPickerNewMakerRouteState());
    const second = readNewMakerFolderPickerRequest(makeFolderPickerNewMakerRouteState());
    expect(first?.requestId).toBeTruthy();
    expect(first?.requestId).not.toBe(second?.requestId);
  });

  it('consumes a folder picker request without dropping other route state', () => {
    const original = {
      workspacePrompt: 'generic',
      folderPickerRequest: { requestId: 'picker-1' },
      preserved: true,
    };
    const consumed = consumeNewMakerFolderPickerRequest(original);
    expect(consumed).toEqual({ workspacePrompt: 'generic', preserved: true });
    expect(readNewMakerFolderPickerRequest(consumed)).toBeNull();
    expect(readNewMakerFolderPickerRequest(original)).toEqual({ requestId: 'picker-1' });
  });
});

describe('new maker navigation intent union', () => {
  it('carries a remote-workspace handover through the same one-shot intent as dialogue / picker', () => {
    const state = makePsbTargetNewMakerRouteState({
      workspaceId: 'ws-1',
      clientId: 'client-1',
      clientName: '设计机',
      workspaceTitle: 'SAGA2',
      directoryName: 'saga2_design',
    });
    const intent = readNewMakerNavigationIntent(state);
    expect(intent).toMatchObject({
      kind: 'psbTarget',
      workspaceId: 'ws-1',
      clientName: '设计机',
      workspaceTitle: 'SAGA2',
    });
    // 每次交接都是新意图（同一工作区可以被再次交接，不能被 workspaceId 去重吞掉）。
    const second = readNewMakerNavigationIntent(makePsbTargetNewMakerRouteState({
      workspaceId: 'ws-1', clientId: 'client-1', clientName: '设计机',
      workspaceTitle: 'SAGA2', directoryName: 'saga2_design',
    }));
    expect(second?.requestId).not.toBe(intent?.requestId);
  });

  it('consumes only the applied intent and preserves the other legacy payloads', () => {
    const state = {
      workspacePrompt: 'generic',
      dialogueTargetRequest: { requestId: 'dialogue-1', deviceId: null, deviceName: null },
      psbTarget: {
        workspaceId: 'ws-1', clientId: 'c', clientName: 'n',
        workspaceTitle: 't', directoryName: 'd',
      },
      preserved: true,
    };
    const intent = readNewMakerNavigationIntent(state);
    // 优先级：对话意图先应用（同一 entry 里历史版本可能叠了多个旧字段）。
    expect(intent?.kind).toBe('dialogue');
    const consumed = consumeNewMakerNavigationIntent(state, intent!);
    expect(readNewMakerDialogueTargetRequest(consumed)).toBeNull();
    // 远程工作区载荷仍在，等它自己被消费；不会因为应用了对话意图被一起吞掉。
    expect(readNewMakerNavigationIntent(consumed)).toMatchObject({ kind: 'psbTarget' });
    expect((consumed as Record<string, unknown>).preserved).toBe(true);
  });
});
