import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { FolderOpen, Plug, RefreshCw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { MekaP4Settings } from '../../../shared/meka-settings';
import type {
  MekaRouterInstance,
  MekaRouterRoute,
  MekaRouterSettingsView,
  MekaRouterTemplate,
  MekaRouterTool,
} from '../../../shared/meka-router';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';
import { Switch } from '@/components/ui/switch';
import { Tip } from '@/components/ui/tooltip';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import {
  isGhostPanelModalPresentationEnabled,
  setGhostPanelModalPresentationEnabled,
  useGhostPanelModalPresentation,
} from '@/lib/ghostPanelPresentationPreference';
import {
  buildMekaRouterClientGroups,
  getMekaRouterClientLabel,
  groupMekaRouterTemplates,
} from './mekaRouterSettingsModel';
import { MekaRouterConnectDialog } from './MekaRouterConnectDialog';

const CARD_CLASS = cn(
  'flex flex-col gap-4 rounded-[12px] border p-4',
  'border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)]',
);

const BUTTON_CLASS = cn(
  'inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-md px-3 text-14 font-medium',
  'border border-[var(--settings-btn-secondary-border)] bg-[var(--settings-btn-secondary-bg)]',
  'text-[var(--settings-btn-secondary-text)] transition-colors',
  'hover:bg-[var(--settings-btn-secondary-hover)] disabled:cursor-not-allowed disabled:opacity-50',
);

const INPUT_CLASS = cn(
  'h-9 w-full rounded-md border px-3 text-14 outline-none',
  'border-[var(--settings-input-border)] bg-[var(--settings-input-bg)]',
  'text-[var(--settings-input-text)] focus:border-[var(--settings-input-border-focus)]',
);

const STATUS_PILL_CLASS = cn(
  'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-12',
  'bg-[var(--surface-chip)] text-[var(--text-secondary)]',
);

function SettingsModal(props: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[100] bg-black/45 backdrop-blur-[1px]" />
        <Dialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-[101] flex w-[min(440px,calc(100vw-32px))]',
            '-translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-xl border p-5 shadow-xl',
            'border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)]',
          )}
        >
          <div className="flex items-center justify-between gap-3">
            <Dialog.Title className="text-16 font-medium text-[var(--settings-section-title)]">
              {props.title}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                className="rounded-md p-1 text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </Dialog.Close>
          </div>
          {props.children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function MekaAssistantSettingsSection() {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const pluginPanelModalPresentation = useGhostPanelModalPresentation();
  const [settings, setSettings] = useState<MekaP4Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [routerRefreshing, setRouterRefreshing] = useState(false);
  const [router, setRouter] = useState<MekaRouterSettingsView | null>(null);
  const [tools, setTools] = useState<MekaRouterTool[]>([]);
  const [routes, setRoutes] = useState<MekaRouterRoute[]>([]);
  const [templates, setTemplates] = useState<MekaRouterTemplate[]>([]);
  const [instances, setInstances] = useState<MekaRouterInstance[]>([]);
  const [routerModal, setRouterModal] = useState(false);
  const [designModal, setDesignModal] = useState(false);
  const [designUrl, setDesignUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const promptedDesignConflict = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setSettings(await window.electronAPI.mekaSettings.getP4());
    } catch (error) {
      toast.error(extractIpcError(error)?.message ?? t('settings.meka.p4.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const chooseDirectory = useCallback(async () => {
    try {
      const selected = await window.electronAPI.dialog.showOpenDirectory({
        ...(settings?.p4RootPath ? { defaultPath: settings.p4RootPath } : {}),
      });
      if (!selected.success || !selected.path) return;
      setLoading(true);
      setSettings(await window.electronAPI.mekaSettings.setP4Root(selected.path));
      toast.success(t('settings.meka.p4.saved'));
    } catch (error) {
      toast.error(extractIpcError(error)?.message ?? t('settings.meka.p4.saveFailed'));
    } finally {
      setLoading(false);
    }
  }, [settings?.p4RootPath, t]);

  const refreshRouter = useCallback(async () => {
    setRouterRefreshing(true);
    try {
      const next = await window.electronAPI.mekaSettings.router.get();
      setRouter(next);
      if (next.configured) {
        const [listed, nextTemplates, nextInstances] = await Promise.all([
          window.electronAPI.mekaSettings.router.listTools(),
          window.electronAPI.mekaSettings.router.listTemplates().catch(() => []),
          window.electronAPI.mekaSettings.router.listInstances().catch(() => []),
        ]);
        setTools(listed.tools);
        setRoutes(listed.routes);
        setTemplates(nextTemplates);
        setInstances(nextInstances);
      } else {
        setTools([]);
        setRoutes([]);
        setTemplates([]);
        setInstances([]);
      }
      if (!next.mekaDesignConflictId) promptedDesignConflict.current = null;
      if (next.mekaDesignConflict && next.mekaDesignConflictId) {
        if (promptedDesignConflict.current !== next.mekaDesignConflictId) {
          promptedDesignConflict.current = next.mekaDesignConflictId;
          const replace = await confirm({
            title: t('settings.meka.design.conflict.title'),
            description: t('settings.meka.design.conflict.description'),
            confirmText: t('settings.meka.design.conflict.replace'),
            cancelText: t('settings.meka.design.conflict.keep'),
          });
          if (replace) {
            await window.electronAPI.mekaSettings.router.useRouterDesign(next.mekaDesignConflictId);
            setRouter(await window.electronAPI.mekaSettings.router.get());
          }
        }
      }
    } catch (error) {
      toast.error(extractIpcError(error)?.message ?? t('settings.meka.router.loadFailed'));
    } finally {
      setRouterRefreshing(false);
    }
  }, [confirm, t]);

  useEffect(() => {
    void refreshRouter();
  }, [refreshRouter]);

  const disconnectRouter = useCallback(async () => {
    const confirmed = await confirm({
      title: t('settings.meka.router.disconnectConfirm.title'),
      description: t('settings.meka.router.disconnectConfirm.description'),
      confirmText: t('settings.meka.router.disconnect'),
      cancelText: t('logic.confirm.cancel'),
    });
    if (!confirmed) return;
    setSubmitting(true);
    try {
      await window.electronAPI.mekaSettings.router.disconnect();
      await refreshRouter();
    } catch (error) {
      toast.error(extractIpcError(error)?.message ?? String(error));
    } finally {
      setSubmitting(false);
    }
  }, [confirm, refreshRouter, t]);

  const toggleRouterClient = useCallback(
    async (routeIds: string[], enabled: boolean) => {
      try {
        await Promise.all(
          routeIds.map((routeId) =>
            window.electronAPI.mekaSettings.router.setRoute(routeId, enabled),
          ),
        );
        await refreshRouter();
      } catch (error) {
        toast.error(extractIpcError(error)?.message ?? String(error));
        await refreshRouter();
      }
    },
    [refreshRouter],
  );

  const routerClients = useMemo(() => buildMekaRouterClientGroups(tools, routes), [routes, tools]);
  const routerTemplateGroups = useMemo(
    () => groupMekaRouterTemplates(templates, instances),
    [instances, templates],
  );

  const connectDesign = useCallback(async () => {
    setSubmitting(true);
    try {
      await window.electronAPI.mekaSettings.router.connectDesign(designUrl);
      setDesignModal(false);
      setDesignUrl('');
      await refreshRouter();
    } catch (error) {
      toast.error(extractIpcError(error)?.message ?? String(error));
    } finally {
      setSubmitting(false);
    }
  }, [designUrl, refreshRouter]);

  const disconnectDesign = useCallback(async () => {
    const confirmed = await confirm({
      title: t('settings.meka.design.disconnectConfirm.title'),
      description: t('settings.meka.design.disconnectConfirm.description'),
      confirmText: t('settings.meka.design.disconnect'),
      cancelText: t('logic.confirm.cancel'),
    });
    if (!confirmed) return;
    setSubmitting(true);
    try {
      await window.electronAPI.mekaSettings.router.disconnectDesign();
      await refreshRouter();
    } catch (error) {
      toast.error(extractIpcError(error)?.message ?? String(error));
    } finally {
      setSubmitting(false);
    }
  }, [confirm, refreshRouter, t]);

  const renderInstance = (instance: MekaRouterInstance) => (
    <div
      key={instance.id}
      className={cn(
        'flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5',
        'border-[var(--settings-theme-card-border)] bg-[var(--surface-elevated)]',
      )}
    >
      <span className="min-w-0 truncate text-13 text-[var(--text-secondary)]">
        {instance.instanceId}
      </span>
      <span
        className={cn(
          STATUS_PILL_CLASS,
          !instance.available && 'bg-[var(--error-bg)] text-[var(--error-fg)]',
        )}
      >
        {instance.available
          ? t('settings.meka.router.instanceAvailable')
          : t('settings.meka.router.instanceUnavailable')}
      </span>
    </div>
  );

  return (
    <div className="flex flex-col gap-5">
      <div className={CARD_CLASS}>
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h3 className="text-16 font-medium text-[var(--settings-section-title)]">
              {t('settings.meka.pluginPanel.title')}
            </h3>
            <p className="mt-1 text-13 leading-relaxed text-[var(--settings-section-desc)]">
              {t('settings.meka.pluginPanel.description')}
            </p>
          </div>
          <Switch
            checked={pluginPanelModalPresentation}
            onCheckedChange={(enabled) => {
              setGhostPanelModalPresentationEnabled(enabled);
              if (!enabled) return;
              // Modal mode has one visible host. Merge any detached Plugin
              // windows back first; the layout preference then keeps their
              // docked panes hidden until modal mode is disabled.
              const ghosts = window.electronAPI.ghosts.listSync().ghosts;
              for (const ghost of ghosts) {
                if (
                  !ghost.manifest.panel ||
                  ghost.manifest.panel.position === 'tab' ||
                  !isGhostPanelModalPresentationEnabled(ghost.manifest.id)
                ) {
                  continue;
                }
                void window.electronAPI.ghostPanelWindow
                  .setDetached(ghost.manifest.id, false)
                  .catch(() => undefined);
              }
            }}
            aria-label={t('settings.meka.pluginPanel.toggleAria')}
          />
        </div>
      </div>

      <div className={CARD_CLASS}>
        <div>
          <h3 className="text-16 font-medium text-[var(--settings-section-title)]">
            {t('settings.meka.p4.title')}
          </h3>
          <p className="mt-1 text-13 leading-relaxed text-[var(--settings-section-desc)]">
            {t('settings.meka.p4.description')}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div
            className={cn(
              'flex h-9 min-w-0 flex-1 items-center rounded-md border px-3 text-14',
              'border-[var(--settings-input-border)] bg-[var(--settings-input-bg)]',
              settings?.p4RootPath
                ? 'text-[var(--settings-input-text)]'
                : 'text-[var(--text-tertiary)]',
            )}
            title={settings?.p4RootPath ?? undefined}
          >
            <span className="truncate">
              {settings?.p4RootPath ?? t('settings.meka.p4.placeholder')}
            </span>
          </div>
          <button
            type="button"
            className={BUTTON_CLASS}
            onClick={() => void chooseDirectory()}
            disabled={loading || settings?.readOnlyBecauseFutureSchema}
          >
            <FolderOpen size={16} />
            {t('settings.meka.p4.browse')}
          </button>
          <button
            type="button"
            className={cn(BUTTON_CLASS, 'w-9 px-0')}
            onClick={() => void refresh()}
            disabled={loading}
            aria-label={t('settings.meka.p4.refresh')}
          >
            <RefreshCw size={16} className={cn(loading && 'animate-spin')} />
          </button>
        </div>

        {settings?.readOnlyBecauseFutureSchema && (
          <p className="text-13 text-[var(--error-fg)]">
            {t('settings.meka.p4.futureSchemaReadOnly')}
          </p>
        )}

        <div className="flex flex-col gap-2">
          <div className="text-13 font-medium text-[var(--text-secondary)]">
            {t('settings.meka.p4.matchedTitle')}
          </div>
          {!loading && (settings?.subfolders.length ?? 0) === 0 ? (
            <p className="text-13 text-[var(--text-tertiary)]">{t('settings.meka.p4.noMatches')}</p>
          ) : (
            settings?.subfolders.map(({ name }) => (
              <div
                key={name}
                className={cn(
                  'flex flex-col rounded-md border px-3 py-2',
                  'border-[var(--settings-theme-card-border)] bg-[var(--surface)]',
                )}
              >
                <span className="text-14 font-medium text-[var(--text-primary)]">{name}</span>
                <span className="text-12 text-[var(--text-tertiary)]">
                  {t(`settings.meka.p4.subfolders.${name.replace('saga2_', '')}`)}
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      <div className={CARD_CLASS}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-16 font-medium text-[var(--settings-section-title)]">
              {t('settings.meka.router.title')}
            </h3>
            <p className="mt-1 text-13 leading-relaxed text-[var(--settings-section-desc)]">
              {t('settings.meka.router.description')}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {router?.configured && (
              <span className={STATUS_PILL_CLASS}>{t('settings.meka.router.connected')}</span>
            )}
            {router?.configured ? (
              <button
                type="button"
                className={BUTTON_CLASS}
                onClick={() => void disconnectRouter()}
                disabled={submitting}
              >
                {t('settings.meka.router.disconnect')}
              </button>
            ) : (
              <button type="button" className={BUTTON_CLASS} onClick={() => setRouterModal(true)}>
                <Plug size={16} />
                {t('settings.meka.router.connect')}
              </button>
            )}
          </div>
        </div>
        {router?.configured && (
          <>
            <div className="text-12 text-[var(--text-tertiary)]">
              <div className="truncate">{router.routerUrl}</div>
              {router.routerUsername && (
                <div>{t('settings.meka.router.account', { username: router.routerUsername })}</div>
              )}
            </div>
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <div className="text-13 font-medium text-[var(--text-secondary)]">
                  {t('settings.meka.router.clientsTitle')}
                </div>
                <button
                  type="button"
                  className={cn(BUTTON_CLASS, 'h-7 w-7 px-0')}
                  onClick={() => void refreshRouter()}
                  disabled={routerRefreshing}
                  aria-label={t('settings.meka.router.refresh')}
                >
                  <RefreshCw size={14} className={cn(routerRefreshing && 'animate-spin')} />
                </button>
              </div>
              {routerClients.clients.length === 0 && routerClients.systemToolCount === 0 && (
                <p className="text-13 text-[var(--text-tertiary)]">
                  {t('settings.meka.router.noClients')}
                </p>
              )}
              {routerClients.clients.map((client) => {
                const label = getMekaRouterClientLabel(
                  client.endpoint,
                  router.mekaDesignUrl,
                  client.name,
                );
                return (
                  <div
                    key={client.endpoint}
                    className="flex items-center justify-between gap-3 rounded-md border border-[var(--settings-theme-card-border)] bg-[var(--surface)] px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-14 font-medium text-[var(--text-primary)]">
                        {label}
                      </div>
                      <div className="truncate text-12 text-[var(--text-tertiary)]">
                        {t('settings.meka.router.toolCount', { count: client.toolCount })}
                      </div>
                      {client.description && (
                        <div className="truncate text-12 text-[var(--text-tertiary)]">
                          {client.description}
                        </div>
                      )}
                    </div>
                    <Switch
                      checked={client.enabled}
                      onCheckedChange={(enabled) =>
                        void toggleRouterClient(client.routeIds, enabled)
                      }
                      aria-label={label}
                    />
                  </div>
                );
              })}
              {routerClients.systemToolCount > 0 && (
                <div className="flex items-center justify-between gap-3 rounded-md border border-[var(--settings-theme-card-border)] bg-[var(--surface)] px-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate text-14 font-medium text-[var(--text-primary)]">
                      {t('settings.meka.router.systemClient')}
                    </div>
                    <div className="truncate text-12 text-[var(--text-tertiary)]">
                      {t('settings.meka.router.toolCount', {
                        count: routerClients.systemToolCount,
                      })}
                    </div>
                  </div>
                  <Tip text={t('settings.meka.router.systemClientReadOnly')} side="left">
                    <Switch checked disabled aria-label={t('settings.meka.router.systemClient')} />
                  </Tip>
                </div>
              )}
            </div>

            <div className="flex flex-col gap-2">
              <div className="text-13 font-medium text-[var(--text-secondary)]">
                {t('settings.meka.router.templatesTitle')}
              </div>
              {routerTemplateGroups.templates.length === 0 &&
                routerTemplateGroups.orphanInstances.length === 0 && (
                  <p className="text-13 text-[var(--text-tertiary)]">
                    {t('settings.meka.router.noTemplates')}
                  </p>
                )}
              {routerTemplateGroups.templates.map(({ template, instances: templateInstances }) => (
                <div
                  key={template.id}
                  className="flex flex-col gap-1 rounded-md border border-[var(--settings-theme-card-border)] bg-[var(--surface)] px-3 py-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-14 font-medium text-[var(--text-primary)]">
                        {template.name}
                      </div>
                      {template.description && (
                        <div className="truncate text-12 text-[var(--text-tertiary)]">
                          {template.description}
                        </div>
                      )}
                    </div>
                    <span className="shrink-0 text-12 text-[var(--text-tertiary)]">
                      {t('settings.meka.router.instanceCount', {
                        count: templateInstances.length,
                      })}
                    </span>
                  </div>
                  {templateInstances.map(renderInstance)}
                </div>
              ))}
              {routerTemplateGroups.orphanInstances.length > 0 && (
                <div className="flex flex-col gap-1 rounded-md border border-[var(--settings-theme-card-border)] bg-[var(--surface)] px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="truncate text-14 font-medium text-[var(--text-primary)]">
                      {t('settings.meka.router.otherInstances')}
                    </div>
                    <span className="shrink-0 text-12 text-[var(--text-tertiary)]">
                      {t('settings.meka.router.instanceCount', {
                        count: routerTemplateGroups.orphanInstances.length,
                      })}
                    </span>
                  </div>
                  {routerTemplateGroups.orphanInstances.map(renderInstance)}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      <div className={CARD_CLASS}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-16 font-medium text-[var(--settings-section-title)]">MekaDesign</h3>
            <p className="mt-1 text-13 leading-relaxed text-[var(--settings-section-desc)]">
              {t('settings.meka.design.description')}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {router?.mekaDesignConfigured && (
              <span className={STATUS_PILL_CLASS}>{t('settings.meka.design.connected')}</span>
            )}
            {router?.mekaDesignConfigured ? (
              <button
                type="button"
                className={BUTTON_CLASS}
                onClick={() => void disconnectDesign()}
                disabled={submitting}
              >
                {t('settings.meka.design.disconnect')}
              </button>
            ) : (
              <button type="button" className={BUTTON_CLASS} onClick={() => setDesignModal(true)}>
                {t('settings.meka.design.connect')}
              </button>
            )}
          </div>
        </div>
        {router?.mekaDesignUrl && (
          <div className="truncate text-12 text-[var(--text-tertiary)]">{router.mekaDesignUrl}</div>
        )}
      </div>

      <MekaRouterConnectDialog
        open={routerModal}
        settings={router}
        onOpenChange={setRouterModal}
        onConnected={refreshRouter}
      />

      {designModal && (
        <SettingsModal
          title={t('settings.meka.design.dialogTitle')}
          onClose={() => setDesignModal(false)}
        >
          <label className="flex flex-col gap-1">
            <span className="text-13 text-[var(--text-secondary)]">
              {t('settings.meka.design.url')}
            </span>
            <input
              className={INPUT_CLASS}
              value={designUrl}
              onChange={(event) => setDesignUrl(event.target.value)}
              placeholder="https://design.example/api/mcp"
              autoFocus
              onKeyDown={(event) => {
                if (event.key === 'Enter') void connectDesign();
              }}
            />
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" className={BUTTON_CLASS} onClick={() => setDesignModal(false)}>
              {t('logic.confirm.cancel')}
            </button>
            <button
              type="button"
              className={BUTTON_CLASS}
              disabled={submitting || !designUrl.trim()}
              onClick={() => void connectDesign()}
            >
              {t('settings.meka.design.connect')}
            </button>
          </div>
        </SettingsModal>
      )}
    </div>
  );
}
