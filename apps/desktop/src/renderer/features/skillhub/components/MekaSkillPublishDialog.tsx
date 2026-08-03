import { useCallback, useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { FolderOpen, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

import type { MekaSkillPublishInfo, MekaSkillVisibility } from '../../../../shared/mekaSkillMarket';

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function MekaSkillPublishDialog({
  open,
  info,
  selectingSource,
  onSelectSource,
  onOpenChange,
  onPublished,
}: {
  open: boolean;
  info: MekaSkillPublishInfo | null;
  selectingSource: boolean;
  onSelectSource: () => Promise<void> | void;
  onOpenChange: (open: boolean) => void;
  onPublished: () => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const [visibility, setVisibility] = useState<MekaSkillVisibility>('private');
  const [sharedUsers, setSharedUsers] = useState('');
  const [version, setVersion] = useState('');
  const [extraDescription, setExtraDescription] = useState('');
  const [publishing, setPublishing] = useState(false);

  useEffect(() => {
    setVisibility(info?.existing?.visibility ?? 'private');
    setSharedUsers(info?.existing?.sharedUsernames.join('\n') ?? '');
    setVersion(info?.suggestedVersion ?? '');
    setExtraDescription('');
  }, [info]);

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
  const normalizedVersion = version.trim();
  const versionValid = SEMVER_RE.test(normalizedVersion);
  const busy = selectingSource || publishing;

  const publish = useCallback(async () => {
    if (!info || busy) return;
    if (!versionValid) {
      toast.error(t('mekaSkills.versionInvalid'));
      return;
    }
    if (visibility === 'shared' && parsedSharedUsers.length === 0) {
      toast.error(t('mekaSkills.sharedUsersRequired'));
      return;
    }
    setPublishing(true);
    try {
      const result = await window.electronAPI.mekaSkills.publishSource({
        sourceId: info.source.sourceId,
        version: normalizedVersion,
        ...(extraDescription.trim() ? { extraDescription: extraDescription.trim() } : {}),
        visibility,
        sharedUsernames: visibility === 'shared' ? parsedSharedUsers : [],
        expectedCurrentReleaseId: info.existing?.currentReleaseId ?? null,
      });
      toast.success(t('mekaSkills.publishSuccess', { name: info.source.name }));
      await onPublished();
      return result;
    } catch {
      toast.error(t('mekaSkills.publishFailed'));
    } finally {
      setPublishing(false);
    }
  }, [
    busy,
    extraDescription,
    info,
    normalizedVersion,
    onPublished,
    parsedSharedUsers,
    t,
    versionValid,
    visibility,
  ]);

  return (
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
            'fixed left-1/2 top-1/2 z-[10000] w-[min(92vw,600px)] -translate-x-1/2 -translate-y-1/2 overflow-hidden',
            'rounded-xl border border-[var(--border-default)] bg-[var(--confirm-bg)] shadow-[var(--confirm-shadow)] focus:outline-none',
          )}
          style={WINDOW_NO_DRAG_STYLE}
        >
          <header className="flex items-start justify-between gap-4 border-b border-[var(--border-default)] px-5 py-4">
            <div className="min-w-0">
              <Dialog.Title className="text-18 font-medium text-[var(--confirm-title)]">
                {t('mekaSkills.publishTitle')}
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-13 leading-5 text-[var(--confirm-description)]">
                {t('mekaSkills.publishDescription')}
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

          <div className="max-h-[66vh] overflow-y-auto px-5 py-4">
            <section>
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-13 font-medium text-[var(--text-primary)]">
                  {t('mekaSkills.publishDirectory')}
                </h3>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void onSelectSource()}
                  className="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 text-12 font-medium text-[var(--text-primary)] hover:bg-[var(--surface-hover-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-wait disabled:opacity-50"
                >
                  {selectingSource ? (
                    <Spinner className="size-4" />
                  ) : (
                    <FolderOpen size={15} aria-hidden="true" />
                  )}
                  {t(info ? 'mekaSkills.changeDirectory' : 'mekaSkills.selectDirectory')}
                </button>
              </div>
              <div className="mt-2 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated-soft)] p-4">
                {info ? (
                  <>
                    <p
                      className="truncate text-12 text-[var(--text-tertiary)]"
                      title={info.source.directoryPath}
                    >
                      {info.source.directoryPath}
                    </p>
                    <p className="mt-3 text-14 font-medium text-[var(--text-primary)]">
                      {info.source.name}
                    </p>
                    <p className="mt-1 text-12 leading-5 text-[var(--text-secondary)]">
                      {info.source.description}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-11 text-[var(--text-tertiary)]">
                      <span>
                        {t('mekaSkills.packageSummary', {
                          files: info.source.fileCount,
                          bytes: info.source.packageSizeBytes,
                        })}
                      </span>
                      {info.existing ? (
                        <span>
                          {t('mekaSkills.currentVersion', {
                            version: info.existing.currentVersion,
                          })}
                        </span>
                      ) : (
                        <span>{t('mekaSkills.firstRelease')}</span>
                      )}
                    </div>
                  </>
                ) : (
                  <p className="text-12 leading-5 text-[var(--text-tertiary)]">
                    {t('mekaSkills.directoryEmpty')}
                  </p>
                )}
              </div>
            </section>

            <label className="mt-5 block">
              <span className="text-13 font-medium text-[var(--text-primary)]">
                {t('mekaSkills.publishVersion')}
              </span>
              <input
                value={version}
                disabled={!info || busy}
                onChange={(event) => setVersion(event.target.value)}
                placeholder="1.0.0"
                aria-invalid={!!version && !versionValid}
                className="mt-2 h-10 w-full rounded-lg border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] px-3 font-mono text-13 text-[var(--settings-input-text)] outline-none placeholder:text-[var(--settings-input-placeholder)] focus:border-[var(--focus-ring)] focus:ring-2 focus:ring-[var(--focus-ring-soft)] disabled:opacity-50"
              />
              <span className="mt-1.5 block text-11 leading-4 text-[var(--text-tertiary)]">
                {t(
                  info?.existing
                    ? 'mekaSkills.versionIncrementHint'
                    : 'mekaSkills.versionDefaultHint',
                )}
              </span>
            </label>

            <label className="mt-5 flex flex-col gap-1.5">
              <span className="text-12 font-medium text-[var(--text-secondary)]">
                {t('mekaSkills.visibility')}
              </span>
              <select
                value={visibility}
                disabled={!info || busy}
                onChange={(event) => setVisibility(event.target.value as MekaSkillVisibility)}
                className="h-9 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 text-13 text-[var(--text-primary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <option value="private">{t('mekaSkills.private')}</option>
                <option value="shared">{t('mekaSkills.sharedVisibility')}</option>
                <option value="public">{t('mekaSkills.publicVisibility')}</option>
              </select>
            </label>

            {visibility === 'shared' ? (
              <label className="mt-3 flex flex-col gap-1.5">
                <span className="text-12 font-medium text-[var(--text-secondary)]">
                  {t('mekaSkills.sharedUsers')}
                </span>
                <textarea
                  value={sharedUsers}
                  disabled={!info || busy}
                  onChange={(event) => setSharedUsers(event.target.value)}
                  placeholder={t('mekaSkills.sharedUsersPlaceholder')}
                  rows={2}
                  className="resize-none rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 py-2 text-13 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-50"
                />
                {parsedSharedUsers.length === 0 ? (
                  <span className="text-11 text-[var(--error-fg)]">
                    {t('mekaSkills.sharedUsersRequired')}
                  </span>
                ) : null}
              </label>
            ) : null}

            <label className="mt-5 block">
              <span className="text-13 font-medium text-[var(--text-primary)]">
                {t('mekaSkills.extraDescription')}
              </span>
              <textarea
                value={extraDescription}
                disabled={!info || busy}
                maxLength={2000}
                onChange={(event) => setExtraDescription(event.target.value)}
                placeholder={t('mekaSkills.extraDescriptionPlaceholder')}
                className="mt-2 min-h-20 w-full resize-y rounded-lg border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] px-3 py-2 text-13 text-[var(--settings-input-text)] outline-none placeholder:text-[var(--settings-input-placeholder)] focus:border-[var(--focus-ring)] focus:ring-2 focus:ring-[var(--focus-ring-soft)] disabled:opacity-50"
              />
            </label>
          </div>

          <footer className="flex justify-end gap-2 border-t border-[var(--border-default)] px-5 py-4">
            <Dialog.Close asChild>
              <button
                type="button"
                disabled={busy}
                className="h-9 rounded-lg px-4 text-13 text-[var(--text-secondary)] hover:bg-[var(--surface-hover-soft)] disabled:opacity-50"
              >
                {t('mekaSkills.cancel')}
              </button>
            </Dialog.Close>
            <button
              type="button"
              disabled={!info || busy || !versionValid}
              onClick={() => void publish()}
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-[var(--accent-cta-bg)] px-4 text-13 font-medium text-[var(--accent-pure-cta-fg)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {publishing ? <Spinner className="size-4" /> : null}
              {t('mekaSkills.publish')}
            </button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
