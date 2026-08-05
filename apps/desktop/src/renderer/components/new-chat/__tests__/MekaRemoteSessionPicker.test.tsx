// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MekaRemoteSessionPicker } from '../MekaRemoteSessionPicker';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

describe('MekaRemoteSessionPicker', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows only supported and available instances', async () => {
    const onSelect = vi.fn();
    const router = {
      get: vi.fn(async () => ({ configured: true })),
      listInstances: vi.fn(async () => [
        { id: 'ready', instanceId: 'ready-1', agentType: 'codex', projectName: 'Ready', supported: true, available: true },
        { id: 'offline', instanceId: 'offline-1', projectName: 'Offline', supported: true, available: false },
        { id: 'unsupported', instanceId: 'unsupported-1', projectName: 'Unsupported', supported: false, available: true },
      ]),
      listTemplates: vi.fn(async () => []),
    };
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      mekaSettings: { router },
    };

    render(<MekaRemoteSessionPicker open onSelect={onSelect} />);
    expect(await screen.findByText('Ready')).toBeTruthy();
    expect(screen.queryByText('Offline')).toBeNull();
    expect(screen.queryByText('Unsupported')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Ready/ }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'ready' }));
  });

  it('creates from a template and selects the created instance', async () => {
    const onSelect = vi.fn();
    const created = {
      id: 'created',
      instanceId: 'worker-1',
      projectName: 'Worker',
      supported: true,
      available: true,
      remoteHostId: 'mcpr:created',
      workingDir: '/mcpr/worker-1',
    };
    let resolveCreate: ((value: typeof created) => void) | undefined;
    const createPromise = new Promise<typeof created>((resolve) => {
      resolveCreate = resolve;
    });
    const router = {
      get: vi.fn(async () => ({ configured: true })),
      listInstances: vi.fn(async () => []),
      listTemplates: vi.fn(async () => [{ id: 'template-a', name: 'Template A', description: null }]),
      createInstance: vi.fn(() => createPromise),
    };
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      mekaSettings: { router },
    };

    render(<MekaRemoteSessionPicker open onSelect={onSelect} />);
    fireEvent.click(await screen.findByRole('button', { name: 'newChat.folderPicker.remoteCreate' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'worker-1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'meka.remote.create' }));

    await waitFor(() => expect(router.createInstance).toHaveBeenCalledWith('template-a', 'worker-1'));
    expect(
      (within(dialog).getByRole('button', { name: 'meka.remote.creating' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    resolveCreate?.(created);
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(created));
  });
});
