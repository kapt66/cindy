// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MekaProjectRemoteInstances } from '../MekaProjectRemoteInstances';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

describe('MekaProjectRemoteInstances', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('creates from the selected template and binds the returned instance', async () => {
    const router = {
      get: vi.fn(async () => ({ configured: true })),
      listInstances: vi.fn(async () => []),
      listTemplates: vi.fn(async () => [
        { id: 'template-a', name: 'Template A', description: null },
      ]),
      getProjectBindings: vi.fn(async () => []),
      setProjectBindings: vi.fn(async () => undefined),
      createInstance: vi.fn(async () => ({
        id: 'instance-a',
        instanceId: 'worker-01',
        projectId: null,
        projectName: 'Worker',
        projectDescription: null,
        agentType: 'codex',
        agentMode: 'default',
        status: 'ready',
        workspaceRef: null,
        supported: true,
        available: true,
        remoteHostId: 'mcpr:worker-01',
        workingDir: '/work',
      })),
    };
    (
      window as unknown as { electronAPI: { mekaSettings: { router: typeof router } } }
    ).electronAPI = {
      mekaSettings: { router },
    };

    render(<MekaProjectRemoteInstances projectId="project-a" />);
    fireEvent.click(await screen.findByRole('button', { name: 'meka.remote.create' }));

    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('meka.remote.instanceName'), {
      target: { value: 'worker-01' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'meka.remote.create' }));

    await waitFor(() =>
      expect(router.createInstance).toHaveBeenCalledWith('template-a', 'worker-01'),
    );
    expect(router.setProjectBindings).toHaveBeenCalledWith('project-a', ['instance-a']);
  });
});
