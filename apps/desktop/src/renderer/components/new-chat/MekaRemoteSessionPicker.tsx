import { useCallback, useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Cloud, Plus, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  ROUTER_INSTANCE_NAME_PATTERN,
  type MekaRouterInstance,
  type MekaRouterTemplate,
} from '../../../shared/meka-router';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';

interface Props {
  open: boolean;
  onSelect: (instance: MekaRouterInstance) => void;
}

const controlClass =
  'inline-flex h-8 select-none items-center justify-center gap-1.5 rounded-full border border-[var(--button-secondary-border)] bg-[var(--button-secondary-bg)] px-3 text-12 font-medium text-[var(--button-secondary-fg)] transition-colors hover:bg-[var(--button-secondary-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-40';
const inputClass =
  'h-9 w-full rounded-lg border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] px-3 text-13 text-[var(--settings-input-text)] outline-none transition-colors focus:border-[var(--settings-input-border-focus)]';

export function MekaRemoteSessionPicker({ open, onSelect }: Props) {
  const { t } = useTranslation();
  const [configured, setConfigured] = useState(false);
  const [instances, setInstances] = useState<MekaRouterInstance[]>([]);
  const [templates, setTemplates] = useState<MekaRouterTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [templateId, setTemplateId] = useState('');
  const [instanceName, setInstanceName] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const state = await window.electronAPI.mekaSettings.router.get();
      setConfigured(state.configured);
      if (!state.configured) {
        setInstances([]);
        setTemplates([]);
        return;
      }
      const [nextInstances, nextTemplates] = await Promise.all([
        window.electronAPI.mekaSettings.router.listInstances(),
        window.electronAPI.mekaSettings.router.listTemplates(),
      ]);
      setInstances(nextInstances);
      setTemplates(nextTemplates);
    } catch {
      setInstances([]);
      setTemplates([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open, refresh]);

  const availableInstances = useMemo(
    () => instances.filter((instance) => instance.supported && instance.available),
    [instances],
  );
  const nameValid = ROUTER_INSTANCE_NAME_PATTERN.test(instanceName.trim());

  const createFromTemplate = useCallback(async () => {
    if (!templateId || !nameValid || creating) return;
    setCreating(true);
    try {
      const created = await window.electronAPI.mekaSettings.router.createInstance(
        templateId,
        instanceName.trim(),
      );
      setCreateOpen(false);
      setInstanceName('');
      onSelect(created);
      await refresh();
    } catch (error) {
      toast.error(extractIpcError(error)?.message ?? String(error));
    } finally {
      setCreating(false);
    }
  }, [creating, instanceName, nameValid, onSelect, refresh, templateId]);

  if (!configured || (availableInstances.length === 0 && templates.length === 0)) return null;

  return (
    <>
      <div className="px-3 pb-1 pt-2">
        <span className="text-xs font-normal text-[var(--folder-label)]">
          {t('newChat.folderPicker.remoteInstances')}
        </span>
      </div>
      <div data-folder-picker-scroll="true" className="pending-queue-scroll max-h-[180px] overflow-y-auto">
        {loading && availableInstances.length === 0 ? (
          <div className="flex items-center gap-2 px-3 py-[10px] text-sm text-[var(--folder-item-path)]">
            <RefreshCw size={14} className="animate-spin" />
            {t('newChat.folderPicker.remoteLoading')}
          </div>
        ) : null}
        {availableInstances.map((instance) => (
          <button
            key={instance.id}
            type="button"
            onClick={() => onSelect(instance)}
            className={cn(
              'flex w-full items-center gap-3 rounded-[8px] px-3 py-[10px] text-left',
              'outline-none transition-colors hover:bg-[var(--folder-item-hover)]',
            )}
          >
            <Cloud size={20} className="shrink-0 text-[var(--folder-item-icon)]" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-[var(--folder-item-name)]">
                {instance.projectName || instance.instanceId}
              </span>
              <span className="block truncate text-xs text-[var(--folder-item-path)]">
                {instance.instanceId}
              </span>
            </span>
          </button>
        ))}
        {availableInstances.length === 0 && templates.length > 0 ? (
          <div className="px-3 py-[8px] text-xs text-[var(--folder-item-path)]">
            {t('newChat.folderPicker.remoteEmpty')}
          </div>
        ) : null}
      </div>
      {templates.length > 0 ? (
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-[8px] px-3 py-[10px] text-left text-12 font-medium text-[var(--folder-item-name)] outline-none hover:bg-[var(--folder-item-hover)]"
          onClick={() => {
            setTemplateId(templates[0]?.id ?? '');
            setInstanceName('');
            setCreateOpen(true);
          }}
        >
          <Plus size={16} className="shrink-0" />
          {t('newChat.folderPicker.remoteCreate')}
        </button>
      ) : null}
      <Dialog.Root open={createOpen} onOpenChange={(next) => !creating && setCreateOpen(next)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[10020] bg-[var(--overlay-modal)]" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-[10021] w-[calc(100vw-32px)] max-w-[440px] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5 text-[var(--text-primary)] shadow-[var(--shadow-menu)] focus:outline-none">
            <Dialog.Title className="text-16 font-medium">{t('meka.remote.create')}</Dialog.Title>
            <div className="mt-4 flex flex-col gap-4">
              <label className="flex flex-col gap-2 text-13 text-[var(--text-secondary)]">
                <span>{t('meka.remote.template')}</span>
                <select
                  className={inputClass}
                  value={templateId}
                  onChange={(event) => setTemplateId(event.target.value)}
                  disabled={creating}
                >
                  {templates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.description ? `${template.name} - ${template.description}` : template.name}
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
                  disabled={creating}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && nameValid) void createFromTemplate();
                  }}
                />
                {instanceName.trim() && !nameValid ? (
                  <span className="text-12 text-[var(--error-fg)]">{t('meka.remote.instanceNameInvalid')}</span>
                ) : null}
              </label>
              <div className="flex justify-end gap-2">
                <button className={controlClass} type="button" onClick={() => setCreateOpen(false)} disabled={creating}>
                  {t('logic.confirm.cancel')}
                </button>
                <button className={controlClass} type="button" disabled={creating || !templateId || !nameValid} onClick={() => void createFromTemplate()}>
                  {creating ? <RefreshCw size={13} className="animate-spin" /> : null}
                  {creating ? t('meka.remote.creating') : t('meka.remote.create')}
                </button>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
