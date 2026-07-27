import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { MekaRouterInstance, MekaRouterTemplate } from '../../../shared/meka-router';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';

const buttonClass =
  'inline-flex h-9 select-none items-center justify-center gap-1.5 rounded-full border border-[var(--button-secondary-border)] bg-[var(--button-secondary-bg)] px-4 text-13 font-medium text-[var(--button-secondary-fg)] transition-colors hover:bg-[var(--button-secondary-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-40';

export function MekaProjectRemoteInstances({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const [instances, setInstances] = useState<MekaRouterInstance[]>([]);
  const [templates, setTemplates] = useState<MekaRouterTemplate[]>([]);
  const [bindings, setBindings] = useState<string[]>([]);
  const [configured, setConfigured] = useState(false);
  const [busy, setBusy] = useState(false);

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

  const createFromTemplate = useCallback(async () => {
    const templateId = window
      .prompt(
        `${t('meka.remote.templatePrompt')}\n${templates.map((item) => `${item.id}: ${item.name}`).join('\n')}`,
        templates[0]?.id,
      )
      ?.trim();
    if (!templateId) return;
    const name = window.prompt(t('meka.remote.instanceNamePrompt'))?.trim();
    if (!name) return;
    setBusy(true);
    try {
      const created = await window.electronAPI.mekaSettings.router.createInstance(templateId, name);
      const next = [...new Set([...bindings, created.id])];
      await window.electronAPI.mekaSettings.router.setProjectBindings(projectId, next);
      await refresh();
    } catch (error) {
      toast.error(extractIpcError(error)?.message ?? String(error));
    } finally {
      setBusy(false);
    }
  }, [bindings, projectId, refresh, t, templates]);

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
            onClick={() => void createFromTemplate()}
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
    </section>
  );
}
