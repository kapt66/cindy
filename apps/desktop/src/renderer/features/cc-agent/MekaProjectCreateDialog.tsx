import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { FolderOpen, Plus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';

export interface MekaProjectCreateInput {
  displayName: string;
  path: string;
  additionalPaths: string[];
}

interface MekaProjectCreateDialogProps {
  open: boolean;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: MekaProjectCreateInput) => Promise<void>;
}

const inputClass =
  'h-10 w-full rounded-full border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] px-4 text-13 text-[var(--settings-input-text)] outline-none transition-colors placeholder:text-[var(--settings-input-placeholder)] focus:border-[var(--settings-input-border-focus)] disabled:cursor-default disabled:opacity-55';
const buttonClass =
  'inline-flex h-9 select-none items-center justify-center gap-2 rounded-full border border-[var(--button-secondary-border)] bg-[var(--button-secondary-bg)] px-4 text-13 font-medium text-[var(--button-secondary-fg)] transition-colors hover:bg-[var(--button-secondary-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-40';

function pathKey(value: string): string {
  return navigator.userAgent.includes('Windows') ? value.toLowerCase() : value;
}

export function MekaProjectCreateDialog({
  open,
  busy,
  onOpenChange,
  onCreate,
}: MekaProjectCreateDialogProps) {
  const { t } = useTranslation();
  const [displayName, setDisplayName] = useState('');
  const [paths, setPaths] = useState<string[]>([]);
  const [projectFileDetected, setProjectFileDetected] = useState(false);
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDisplayName('');
    setPaths([]);
    setProjectFileDetected(false);
    setPicking(false);
  }, [open]);

  const addDirectory = async () => {
    setPicking(true);
    try {
      const result = await window.electronAPI.showOpenDirectoryDialog();
      const selected = result.canceled ? null : result.path?.trim();
      if (!selected || paths.some((candidate) => pathKey(candidate) === pathKey(selected))) return;

      if (paths.length === 0) {
        const existing = await window.electronAPI.localDb.mekaProjects.inspectPath(selected);
        if (existing) {
          setDisplayName(existing.basic.displayName);
          setPaths([selected, ...(existing.basic.additionalPaths ?? [])]);
          setProjectFileDetected(true);
          return;
        }
      }
      setPaths((current) => [...current, selected]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('meka.projectConfigReadFailed'));
    } finally {
      setPicking(false);
    }
  };

  const removeDirectory = (index: number) => {
    if (projectFileDetected) {
      if (index === 0) {
        setPaths([]);
        setDisplayName('');
        setProjectFileDetected(false);
      }
      return;
    }
    setPaths((current) => current.filter((_, itemIndex) => itemIndex !== index));
  };

  const canCreate = displayName.trim().length > 0 && paths.length > 0 && !busy && !picking;

  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen) => !busy && onOpenChange(nextOpen)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[10000] bg-[var(--overlay-modal)]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[10001] flex max-h-[calc(100vh-32px)] w-[calc(100vw-32px)] max-w-[560px] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] text-[var(--text-primary)] shadow-[var(--shadow-menu)] focus:outline-none">
          <div className="flex items-start justify-between gap-4 border-b border-[var(--border-default)] px-5 py-4">
            <div className="min-w-0">
              <Dialog.Title className="text-16 font-medium">{t('meka.newProject')}</Dialog.Title>
              <Dialog.Description className="mt-1 text-13 leading-5 text-[var(--text-secondary)]">
                {t('meka.createDialogDescription')}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild disabled={busy}>
              <button
                type="button"
                className="grid size-8 shrink-0 place-items-center rounded-full text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                aria-label={t('logic.confirm.cancel')}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </Dialog.Close>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
            <label className="flex flex-col gap-2 text-13 text-[var(--text-secondary)]">
              <span>{t('meka.projectName')}</span>
              <input
                className={inputClass}
                value={displayName}
                disabled={projectFileDetected || busy}
                autoFocus
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </label>

            <div className="mt-5 flex items-center justify-between gap-3">
              <span className="text-13 text-[var(--text-secondary)]">{t('meka.directories')}</span>
              {!projectFileDetected ? (
                <button
                  type="button"
                  className={cn(buttonClass, 'h-8 px-3 text-12')}
                  disabled={busy || picking}
                  onClick={() => void addDirectory()}
                >
                  {paths.length === 0 ? (
                    <FolderOpen size={14} aria-hidden="true" />
                  ) : (
                    <Plus size={14} aria-hidden="true" />
                  )}
                  {t(paths.length === 0 ? 'meka.chooseDirectory' : 'meka.addAdditionalPath')}
                </button>
              ) : null}
            </div>

            <div className="mt-3 flex min-h-20 flex-col gap-2">
              {paths.map((directory, index) => (
                <div
                  key={`${pathKey(directory)}-${index}`}
                  className="flex min-w-0 items-center gap-3 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated-soft)] px-3 py-2.5"
                >
                  <FolderOpen size={15} className="shrink-0 text-[var(--text-tertiary)]" />
                  <span className="min-w-0 flex-1 truncate text-12 text-[var(--text-secondary)]">
                    {directory}
                  </span>
                  <span className="shrink-0 rounded-full bg-[var(--surface-chip)] px-2 py-1 text-11 text-[var(--text-secondary)]">
                    {t(index === 0 ? 'meka.primaryDirectory' : 'meka.referenceDirectory')}
                  </span>
                  {(!projectFileDetected || index === 0) && !busy ? (
                    <button
                      type="button"
                      className="grid size-7 shrink-0 place-items-center rounded-full text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                      aria-label={t('meka.removeDirectory')}
                      onClick={() => removeDirectory(index)}
                    >
                      <X size={14} aria-hidden="true" />
                    </button>
                  ) : null}
                </div>
              ))}
              {paths.length === 0 ? (
                <button
                  type="button"
                  className="flex min-h-20 items-center justify-center gap-2 rounded-lg border border-dashed border-[var(--border-default)] text-13 text-[var(--text-tertiary)] hover:bg-[var(--surface-hover-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                  disabled={busy || picking}
                  onClick={() => void addDirectory()}
                >
                  <FolderOpen size={16} aria-hidden="true" />
                  {t('meka.choosePrimaryDirectory')}
                </button>
              ) : null}
            </div>

            {projectFileDetected ? (
              <p className="mt-3 text-12 leading-5 text-[var(--text-secondary)]">
                {t('meka.existingProjectConfigDetected')}
              </p>
            ) : null}
          </div>

          <div className="flex justify-end gap-2 border-t border-[var(--border-default)] px-5 py-4">
            <Dialog.Close asChild disabled={busy}>
              <button type="button" className={buttonClass} disabled={busy}>
                {t('logic.confirm.cancel')}
              </button>
            </Dialog.Close>
            <button
              type="button"
              className={buttonClass}
              disabled={!canCreate}
              onClick={() =>
                void onCreate({
                  displayName: displayName.trim(),
                  path: paths[0]!,
                  additionalPaths: paths.slice(1),
                })
              }
            >
              <Plus size={14} aria-hidden="true" />
              {t('meka.createProjectAction')}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
