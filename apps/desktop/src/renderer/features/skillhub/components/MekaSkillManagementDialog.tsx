import { useCallback, useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { RotateCw, Trash2, Upload, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

import type {
  MekaSkillManagementInfo,
  MekaSkillMarketItem,
  MekaSkillPublishInfo,
  MekaSkillVisibility,
} from '../../../../shared/mekaSkillMarket';
import { MekaSkillPublishDialog } from './MekaSkillPublishDialog';

export function MekaSkillManagementDialog({
  open,
  skill,
  onOpenChange,
  onChanged,
  onDeleted,
}: {
  open: boolean;
  skill: MekaSkillMarketItem | null;
  onOpenChange: (open: boolean) => void;
  onChanged: () => Promise<void> | void;
  onDeleted: () => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const [info, setInfo] = useState<MekaSkillManagementInfo | null>(null);
  const [visibility, setVisibility] = useState<MekaSkillVisibility>('private');
  const [sharedUsers, setSharedUsers] = useState('');
  const [loading, setLoading] = useState(false);
  const [selectingSource, setSelectingSource] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishInfo, setPublishInfo] = useState<MekaSkillPublishInfo | null>(null);
  const [publishTarget, setPublishTarget] = useState<MekaSkillMarketItem | null>(null);

  const load = useCallback(async () => {
    if (!open || !skill) return;
    setLoading(true);
    setConfirmingDelete(false);
    try {
      const next = await window.electronAPI.mekaSkills.managementInfo(skill.id);
      setInfo(next);
      setVisibility(next.visibility);
      setSharedUsers(next.sharedUsernames.join('\n'));
    } catch {
      setInfo(null);
      toast.error(t('mekaSkills.managementLoadFailed'));
    } finally {
      setLoading(false);
    }
  }, [open, skill, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const parsedSharedUsers = useMemo(
    () => [
      ...new Set(
        sharedUsers
          .split(/[\n,]/)
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ],
    [sharedUsers],
  );
  const busy = loading || selectingSource || saving || deleting;
  const accessInvalid = visibility === 'shared' && parsedSharedUsers.length === 0;

  const pickUpdateSource = useCallback(
    async (target: MekaSkillMarketItem) => {
      if (selectingSource) return;
      setSelectingSource(true);
      try {
        const next = await window.electronAPI.mekaSkills.pickSource();
        if (!next) return;
        if (next.existing?.skillResourceId !== target.id) {
          toast.error(t('mekaSkills.sourceMismatch', { name: target.name }));
          return;
        }
        setPublishTarget(target);
        setPublishInfo(next);
        onOpenChange(false);
        setPublishOpen(true);
      } catch {
        toast.error(t('mekaSkills.sourceInvalid'));
      } finally {
        setSelectingSource(false);
      }
    },
    [onOpenChange, selectingSource, t],
  );

  const publishUpdate = useCallback(async () => {
    if (!skill || busy) return;
    await pickUpdateSource(skill);
  }, [busy, pickUpdateSource, skill]);

  const saveAccess = useCallback(async () => {
    if (!info || busy || accessInvalid) return;
    setSaving(true);
    try {
      const updated = await window.electronAPI.mekaSkills.updateAccess({
        skillId: info.skillResourceId,
        expectedCurrentReleaseId: info.currentReleaseId,
        visibility,
        sharedUsernames: visibility === 'shared' ? parsedSharedUsers : [],
      });
      setInfo(updated);
      setVisibility(updated.visibility);
      setSharedUsers(updated.sharedUsernames.join('\n'));
      toast.success(t('mekaSkills.accessSuccess', { name: updated.name }));
      await onChanged();
    } catch {
      toast.error(t('mekaSkills.accessFailed'));
    } finally {
      setSaving(false);
    }
  }, [accessInvalid, busy, info, onChanged, parsedSharedUsers, t, visibility]);

  const deletePublished = useCallback(async () => {
    if (!info || busy) return;
    setDeleting(true);
    try {
      await window.electronAPI.mekaSkills.deletePublished({
        skillId: info.skillResourceId,
        expectedCurrentReleaseId: info.currentReleaseId,
      });
      toast.success(t('mekaSkills.deleteSuccess', { name: info.name }));
      onOpenChange(false);
      await onDeleted();
    } catch {
      toast.error(t('mekaSkills.deleteFailed'));
    } finally {
      setDeleting(false);
    }
  }, [busy, info, onDeleted, onOpenChange, t]);

  return (
    <>
      <Dialog.Root
        open={open}
        onOpenChange={(nextOpen) => {
          if (!busy) onOpenChange(nextOpen);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[9999] bg-[var(--overlay-modal)]" />
          <Dialog.Content
            className={cn(
              'fixed left-1/2 top-1/2 z-[10000] w-[min(92vw,560px)] -translate-x-1/2 -translate-y-1/2 overflow-hidden',
              'rounded-xl border border-[var(--border-default)] bg-[var(--confirm-bg)] shadow-[var(--confirm-shadow)] focus:outline-none',
            )}
            style={WINDOW_NO_DRAG_STYLE}
          >
            <header className="flex items-start justify-between gap-4 border-b border-[var(--border-default)] px-5 py-4">
              <div className="min-w-0">
                <Dialog.Title className="truncate text-18 font-medium text-[var(--confirm-title)]">
                  {t('mekaSkills.manageTitle', { name: skill?.name ?? '' })}
                </Dialog.Title>
                <Dialog.Description className="mt-1 text-13 leading-5 text-[var(--confirm-description)]">
                  {t('mekaSkills.manageDescription')}
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <button
                  type="button"
                  aria-label={t('mekaSkills.close')}
                  disabled={busy}
                  className="grid size-8 shrink-0 place-items-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--surface-hover-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-50"
                >
                  <X size={16} aria-hidden="true" />
                </button>
              </Dialog.Close>
            </header>

            <div className="max-h-[68vh] overflow-y-auto px-5">
              {loading ? (
                <div className="flex min-h-48 items-center justify-center">
                  <Spinner className="size-5" />
                </div>
              ) : !info ? (
                <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-center">
                  <p className="text-13 text-[var(--text-secondary)]">
                    {t('mekaSkills.managementLoadFailed')}
                  </p>
                  <button
                    type="button"
                    onClick={() => void load()}
                    className="inline-flex h-9 items-center gap-2 rounded-full bg-[var(--surface-chip)] px-4 text-13 font-medium text-[var(--text-primary)] hover:bg-[var(--surface-hover-soft)]"
                  >
                    <RotateCw size={14} aria-hidden="true" />
                    {t('mekaSkills.retry')}
                  </button>
                </div>
              ) : (
                <>
                  <section className="flex items-center justify-between gap-4 py-5">
                    <div className="min-w-0">
                      <h3 className="text-13 font-medium text-[var(--text-primary)]">
                        {t('mekaSkills.publishUpdate')}
                      </h3>
                      <p className="mt-1 text-12 leading-5 text-[var(--text-secondary)]">
                        {t('mekaSkills.publishUpdateDescription', { version: info.currentVersion })}
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={busy || !skill}
                      onClick={() => void publishUpdate()}
                      className="inline-flex h-9 shrink-0 items-center gap-2 rounded-full bg-[var(--accent-cta-bg)] px-4 text-13 font-medium text-[var(--accent-pure-cta-fg)] hover:opacity-90 disabled:opacity-50"
                    >
                      {selectingSource ? (
                        <Spinner className="size-4" />
                      ) : (
                        <Upload size={14} aria-hidden="true" />
                      )}
                      {t('mekaSkills.publishUpdate')}
                    </button>
                  </section>

                  <section className="border-t border-[var(--border-default)] py-5">
                    <h3 className="text-13 font-medium text-[var(--text-primary)]">
                      {t('mekaSkills.visibility')}
                    </h3>
                    <p className="mt-1 text-12 leading-5 text-[var(--text-secondary)]">
                      {t('mekaSkills.accessDescription')}
                    </p>
                    <select
                      value={visibility}
                      aria-label={t('mekaSkills.visibility')}
                      disabled={busy}
                      onChange={(event) => setVisibility(event.target.value as MekaSkillVisibility)}
                      className="mt-3 h-9 w-full rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 text-13 text-[var(--text-primary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-50"
                    >
                      <option value="private">{t('mekaSkills.private')}</option>
                      <option value="shared">{t('mekaSkills.sharedVisibility')}</option>
                      <option value="public">{t('mekaSkills.publicVisibility')}</option>
                    </select>
                    {visibility === 'shared' ? (
                      <label className="mt-3 block">
                        <span className="text-12 font-medium text-[var(--text-secondary)]">
                          {t('mekaSkills.sharedUsers')}
                        </span>
                        <textarea
                          value={sharedUsers}
                          aria-label={t('mekaSkills.sharedUsers')}
                          disabled={busy}
                          onChange={(event) => setSharedUsers(event.target.value)}
                          placeholder={t('mekaSkills.sharedUsersPlaceholder')}
                          rows={3}
                          className="mt-1.5 w-full resize-none rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 py-2 text-13 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-50"
                        />
                        {accessInvalid ? (
                          <span className="mt-1 block text-11 text-[var(--error-fg)]">
                            {t('mekaSkills.sharedUsersRequired')}
                          </span>
                        ) : null}
                      </label>
                    ) : null}
                    <div className="mt-3 flex justify-end">
                      <button
                        type="button"
                        disabled={busy || accessInvalid}
                        onClick={() => void saveAccess()}
                        className="inline-flex h-9 items-center gap-2 rounded-full bg-[var(--surface-chip)] px-4 text-13 font-medium text-[var(--text-primary)] hover:bg-[var(--surface-hover-soft)] disabled:opacity-50"
                      >
                        {saving ? <Spinner className="size-4" /> : null}
                        {t('mekaSkills.saveAccess')}
                      </button>
                    </div>
                  </section>

                  <section className="border-t border-[var(--border-default)] py-5">
                    {confirmingDelete ? (
                      <div className="flex flex-col gap-3">
                        <p className="text-12 leading-5 text-[var(--error-fg)]">
                          {t('mekaSkills.deleteWarning', { name: info.name })}
                        </p>
                        <div className="flex flex-wrap justify-end gap-2">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => setConfirmingDelete(false)}
                            className="h-9 rounded-full px-4 text-13 text-[var(--text-secondary)] hover:bg-[var(--surface-hover-soft)]"
                          >
                            {t('mekaSkills.cancel')}
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void deletePublished()}
                            className="inline-flex h-9 items-center gap-2 rounded-full bg-[var(--error-fg)] px-4 text-13 font-medium text-[var(--error-bg)] hover:opacity-90 disabled:opacity-50"
                          >
                            {deleting ? (
                              <Spinner className="size-4" />
                            ) : (
                              <Trash2 size={14} aria-hidden="true" />
                            )}
                            {t('mekaSkills.deleteConfirm')}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex justify-end">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setConfirmingDelete(true)}
                          className="inline-flex h-9 items-center gap-2 rounded-full border border-[var(--error-border)] px-4 text-13 font-medium text-[var(--error-fg)] hover:bg-[var(--error-bg)] disabled:opacity-50"
                        >
                          <Trash2 size={14} aria-hidden="true" />
                          {t('mekaSkills.deletePublish')}
                        </button>
                      </div>
                    )}
                  </section>
                </>
              )}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <MekaSkillPublishDialog
        open={publishOpen}
        info={publishInfo}
        selectingSource={selectingSource}
        onSelectSource={async () => {
          if (publishTarget) await pickUpdateSource(publishTarget);
        }}
        onOpenChange={(nextOpen) => {
          setPublishOpen(nextOpen);
          if (!nextOpen) {
            setPublishInfo(null);
            setPublishTarget(null);
          }
        }}
        onPublished={async () => {
          setPublishOpen(false);
          setPublishInfo(null);
          setPublishTarget(null);
          await onChanged();
        }}
      />
    </>
  );
}
