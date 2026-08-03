import { useCallback, useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Plus, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  ROUTER_INSTANCE_NAME_PATTERN,
  type MekaRouterInstance,
  type MekaRouterTemplate,
} from '../../../shared/meka-router';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';

const buttonClass =
  'inline-flex h-9 select-none items-center justify-center gap-1.5 rounded-full border border-[var(--button-secondary-border)] bg-[var(--button-secondary-bg)] px-4 text-13 font-medium text-[var(--button-secondary-fg)] transition-colors hover:bg-[var(--button-secondary-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-40';
const inputClass =
  'h-10 w-full rounded-lg border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] px-3 text-13 text-[var(--settings-input-text)] outline-none transition-colors focus:border-[var(--settings-input-border-focus)]';

export function MekaProjectRemoteInstances({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const [instances, setInstances] = useState<MekaRouterInstance[]>([]);
  const [templates, setTemplates] = useState<MekaRouterTemplate[]>([]);
  const [bindings, setBindings] = useState<string[]>([]);
  const [configured, setConfigured] = useState(false);
  const [busy, setBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [templateId, setTemplateId] = useState('');
  const [instanceName, setInstanceName] = useState('');

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const state = await window.electronAPI.mekaSettings.router.get();
      setConfigured(state.configured);
      if (!state.configured) {
        setInstances([]);
        setTemplates([]);
        setBindings([]);
        return;
      }
      const [nextInstances, nextTemplates, nextBindings] = await Promise.all([
        window.electronAPI.mekaSettings.router.listInstances(),
        window.electronAPI.mekaSettings.router.listTemplates(),
        window.electronAPI.mekaSettings.router.getProjectBindings(projectId),
      ]);
      setInstances(nextInstances);
      setTemplates(nextTemplates);
      setBindings(nextBindings);
    } catch (error) {
      toast.error(extractIpcError(error)?.message ?? String(error));
    } finally {
      setBusy(false);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const bound = useMemo(() => new Set(bindings), [bindings]);

  const toggle = useCallback(
    async (instanceId: string, enabled: boolean) => {
      const next = enabled
        ? [...new Set([...bindings, instanceId])]
        : bindings.filter((id) => id !== instanceId);
      setBindings(next);
      try {
        await window.electronAPI.mekaSettings.router.setProjectBindings(projectId, next);
      } catch (error) {
        setBindings(bindings);
        toast.error(extractIpcError(error)?.message ?? String(error));
      }
    },
    [bindings, projectId],
  );

  const openCreate = useCallback(() => {
    setTemplateId(templates[0]?.id ?? '');
    setInstanceName('');
    setCreateOpen(true);
  }, [templates]);

  const nameValid = ROUTER_INSTANCE_NAME_PATTERN.test(instanceName.trim());

  const createFromTemplate = useCallback(async () => {
    if (!templateId || !nameValid) return;
    setBusy(true);
    try {
      const created = await window.electronAPI.mekaSettings.router.createInstance(
        templateId,
        instanceName.trim(),
      );
      const next = [...new Set([...bindings, created.id])];
      await window.electronAPI.mekaSettings.router.setProjectBindings(projectId, next);
      setCreateOpen(false);
      await refresh();
    } catch (error) {
      toast.error(extractIpcError(error)?.message ?? String(error));
    } finally {
      setBusy(false);
    }
  }, [bindings, instanceName, nameValid, projectId, refresh, templateId]);

  return (
    <section className="mt-10">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-16 font-medium leading-6 text-[var(--text-primary)]">
            {t('meka.remote.title')}
          </h2>
          <p className="mt-1 text-13 leading-5 text-[var(--text-secondary)]">
            {t('meka.remote.description')}
          </p>
        </div>
        <div className="flex gap-2">
          <button className={buttonClass} onClick={() => void refresh()} disabled={busy}>
            <RefreshCw size={13} className={cn(busy && 'animate-spin')} />
            {t('meka.remote.refresh')}
          </button>
          <button
            className={buttonClass}
            onClick={openCreate}
            disabled={busy || !configured || templates.length === 0}
          >
            <Plus size={13} />
            {t('meka.remote.create')}
          </button>
        </div>
      </div>
      <div className="mt-5 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated-soft)] p-5">
        {!configured ? (
          <p className="text-13 text-[var(--text-tertiary)]">{t('meka.remote.notConfigured')}</p>
        ) : instances.length === 0 ? (
          <p className="text-13 text-[var(--text-tertiary)]">{t('meka.remote.empty')}</p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {instances.map((instance) => (
              <label
                key={instance.id}
                className={cn(
                  'flex items-center gap-3 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-4 transition-colors hover:bg-[var(--surface-hover-soft)]',
                  (!instance.supported || !instance.available) && 'opacity-60',
                )}
              >
                <input
                  type="checkbox"
                  checked={bound.has(instance.id)}
                  disabled={!instance.supported || !instance.available}
                  onChange={(event) => void toggle(instance.id, event.target.checked)}
                />
                <span className="min-w-0">
                  <span className="block truncate text-13 text-[var(--text-primary)]">
                    {instance.projectDescription || instance.projectName || instance.instanceId}
                  </span>
                  <span className="mt-1 block truncate text-12 text-[var(--text-tertiary)]">
                    {instance.instanceId} ·{' '}
                    {instance.available ? t('meka.remote.available') : t('meka.remote.unavailable')}
                  </span>
                </span>
              </label>
            ))}
          </div>
        )}
      </div>
      <Dialog.Root open={createOpen} onOpenChange={(open) => !open && setCreateOpen(false)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[10000] bg-[var(--overlay-modal)]" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-[10001] w-[calc(100vw-32px)] max-w-[440px] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5 text-[var(--text-primary)] shadow-[var(--shadow-menu)] focus:outline-none">
            <Dialog.Title className="text-16 font-medium">{t('meka.remote.create')}</Dialog.Title>
            <div className="mt-4 flex flex-col gap-4">
              <label className="flex flex-col gap-2 text-13 text-[var(--text-secondary)]">
                <span>{t('meka.remote.template')}</span>
                <select
                  className={inputClass}
                  value={templateId}
                  onChange={(event) => setTemplateId(event.target.value)}
                >
                  {templates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.description
                        ? `${template.name} - ${template.description}`
                        : template.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-2 text-13 text-[var(--text-secondary)]">
                <span>{t('meka.remote.instanceName')}</span>
                <input
                  autoFocus
                  className={inputClass}
                  value={instanceName}
                  onChange={(event) => setInstanceName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && nameValid) void createFromTemplate();
                  }}
                />
                {instanceName.trim() && !nameValid ? (
                  <span className="text-12 text-[var(--error-fg)]">
                    {t('meka.remote.instanceNameInvalid')}
                  </span>
                ) : null}
              </label>
              <div className="flex justify-end gap-2">
                <button className={buttonClass} type="button" onClick={() => setCreateOpen(false)}>
                  {t('logic.confirm.cancel')}
                </button>
                <button
                  className={buttonClass}
                  type="button"
                  disabled={busy || !templateId || !nameValid}
                  onClick={() => void createFromTemplate()}
                >
                  {t('meka.remote.create')}
                </button>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}
