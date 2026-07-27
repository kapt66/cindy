import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Check, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { FormalSessionData } from '../../../shared/meka-formal';
import type { MekaProject } from '../../../shared/meka-projects';
import { cn } from '@/lib/utils';

interface FormalIssueItem {
  ref: string;
  title: string;
  webUrl: string;
}

export interface PreparedMekaFormalDraft {
  formal: FormalSessionData;
  firstMessage: string;
  titlePrefix: string;
}

interface MekaFormalIssueModalProps {
  project: MekaProject;
  onClose: () => void;
  onPrepared: (prepared: PreparedMekaFormalDraft) => void;
}

type LoadState = 'checking' | 'connected' | 'needs-connect' | 'error';

/**
 * Provider-neutral formal-workflow picker.
 *
 * The original Meka flow first freezes a Jira/GitLab issue and only then opens
 * the regular new-session draft. Main owns provider auth, link validation and
 * the frozen snapshot; renderer only selects an item and forwards the result.
 */
export function MekaFormalIssueModal({
  project,
  onClose,
  onPrepared,
}: MekaFormalIssueModalProps): React.ReactElement {
  const { t } = useTranslation();
  const provider =
    project.workflowType === 'jira' || project.workflowType === 'gitlab'
      ? project.workflowType
      : null;
  const [loadState, setLoadState] = useState<LoadState>('checking');
  const [issues, setIssues] = useState<FormalIssueItem[]>([]);
  const [query, setQuery] = useState('');
  const [link, setLink] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);

  const loadIssues = useCallback(async () => {
    if (!provider) {
      setLoadState('error');
      return;
    }
    setLoadState('checking');
    setError(null);
    try {
      const auth = await window.electronAPI.localDb.mekaFormal.checkAuth({
        projectId: project.id,
        type: provider,
      });
      if (!auth.ok) {
        setIssues([]);
        setLoadState(auth.reason === 'NETWORK' ? 'error' : 'needs-connect');
        return;
      }
      const result = await window.electronAPI.localDb.mekaFormal.fetchIssues({
        projectId: project.id,
        type: provider,
      });
      if (!result.ok) {
        setIssues([]);
        setLoadState('error');
        setError(result.detail ?? result.error);
        return;
      }
      setIssues(result.data);
      setLoadState('connected');
    } catch (caught) {
      setIssues([]);
      setLoadState('error');
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [project.id, provider]);

  useEffect(() => {
    void loadIssues();
  }, [loadIssues]);

  const filteredIssues = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return issues;
    return issues.filter(
      (issue) =>
        issue.ref.toLowerCase().includes(normalized) ||
        issue.title.toLowerCase().includes(normalized),
    );
  }, [issues, query]);

  const prepare = useCallback(async () => {
    const normalizedLink = link.trim();
    if (!provider || !normalizedLink || preparing) return;
    setPreparing(true);
    setError(null);
    try {
      const result = await window.electronAPI.localDb.mekaFormal.prepare({
        projectId: project.id,
        type: provider,
        link: normalizedLink,
      });
      if (!result.ok) {
        setError(result.detail ?? result.error);
        return;
      }
      onPrepared(result.data);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPreparing(false);
    }
  }, [link, onPrepared, preparing, project.id, provider]);

  const providerLabel = provider === 'jira' ? 'Jira' : 'GitLab';
  const busy = preparing || loadState === 'checking';
  const inputClassName = cn(
    'h-9 w-full rounded-lg border px-3 text-13 outline-none transition-colors',
    'border-[var(--settings-input-border)] bg-[var(--settings-input-bg)]',
    'text-[var(--settings-input-text)] placeholder:text-[var(--settings-input-placeholder)]',
    'focus:border-[var(--settings-input-border-focus)] disabled:opacity-60',
  );

  return (
    <Dialog.Root
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 z-[10000] bg-[var(--overlay-modal)]"
          style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
        />
        <Dialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-[10001] w-[calc(100vw-32px)] max-w-[480px]',
            '-translate-x-1/2 -translate-y-1/2 rounded-xl border p-5 focus:outline-none',
            'border-[var(--border-default)] bg-[var(--surface-elevated)] text-[var(--text-primary)]',
          )}
          style={{ WebkitAppRegion: 'no-drag', boxShadow: 'var(--shadow-menu)' } as CSSProperties}
        >
          <Dialog.Title className="text-base font-medium">
            {t('meka.formalPicker.title', { provider: providerLabel })}
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-13 text-[var(--text-secondary)]">
            {t('meka.formalPicker.description', { project: project.displayName })}
          </Dialog.Description>

          <div className="mt-4 flex flex-col gap-4">
            {loadState === 'needs-connect' ? (
              <div className="rounded-lg border border-[var(--border-default)] bg-[var(--surface-chip)] p-4">
                <p className="text-13 leading-5 text-[var(--text-secondary)]">
                  {t('meka.formalPicker.connectRequired', { provider: providerLabel })}
                </p>
              </div>
            ) : (
              <>
                <input
                  className={inputClassName}
                  value={query}
                  disabled={loadState === 'checking'}
                  placeholder={t('meka.formalPicker.searchPlaceholder')}
                  onChange={(event) => setQuery(event.target.value)}
                />
                <div
                  className="flex max-h-[240px] min-h-[112px] flex-col gap-0.5 overflow-y-auto"
                  role="listbox"
                  aria-label={t('meka.formalPicker.issueList')}
                >
                  {loadState === 'checking' ? (
                    <div className="flex flex-1 items-center justify-center gap-2 text-13 text-[var(--text-tertiary)]">
                      <Loader2 size={14} className="animate-spin" />
                      {t('meka.formalPicker.loading')}
                    </div>
                  ) : filteredIssues.length > 0 ? (
                    filteredIssues.map((issue) => {
                      const selected = link === issue.webUrl;
                      return (
                        <button
                          key={`${provider}:${issue.ref}`}
                          type="button"
                          role="option"
                          aria-selected={selected}
                          disabled={preparing}
                          onClick={() => {
                            setLink(issue.webUrl);
                            setError(null);
                          }}
                          className={cn(
                            'flex w-full items-center justify-between rounded-lg px-3 py-2 text-left',
                            'transition-colors hover:bg-[var(--model-item-hover)]',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                            selected && 'bg-[var(--surface-chip)]',
                          )}
                        >
                          <span className="flex min-w-0 items-center gap-2.5">
                            <span className="shrink-0 text-13 text-[var(--text-tertiary)]">
                              {provider === 'gitlab' ? `#${issue.ref}` : issue.ref}
                            </span>
                            <span className="min-w-0 truncate text-14 text-[var(--model-item-text)]">
                              {issue.title}
                            </span>
                          </span>
                          {selected ? (
                            <Check
                              size={15}
                              className="ml-2 shrink-0 text-[var(--model-item-check)]"
                            />
                          ) : null}
                        </button>
                      );
                    })
                  ) : (
                    <div className="flex flex-1 items-center justify-center text-13 text-[var(--text-tertiary)]">
                      {t('meka.formalPicker.empty')}
                    </div>
                  )}
                </div>
                <label className="flex flex-col gap-1.5 text-xs text-[var(--text-secondary)]">
                  <span>{t('meka.formalPicker.linkLabel')}</span>
                  <input
                    className={inputClassName}
                    value={link}
                    disabled={preparing}
                    placeholder={t('meka.formalPicker.linkPlaceholder', {
                      provider: providerLabel,
                    })}
                    onChange={(event) => {
                      setLink(event.target.value);
                      setError(null);
                    }}
                  />
                </label>
              </>
            )}

            {error ? (
              <p role="alert" className="break-words text-xs text-[var(--error-fg-strong)]">
                {t('meka.formalPicker.failed', { error })}
              </p>
            ) : null}

            <div className="flex items-center justify-end gap-2">
              {loadState === 'needs-connect' || loadState === 'error' ? (
                <button
                  type="button"
                  disabled={preparing}
                  className="inline-flex h-8 items-center rounded-full border border-[var(--button-secondary-border)] px-4 text-xs text-[var(--button-secondary-fg)] hover:bg-[var(--button-secondary-hover-bg)] disabled:opacity-50"
                  onClick={() => void loadIssues()}
                >
                  {t('meka.formalPicker.retry')}
                </button>
              ) : null}
              <button
                type="button"
                disabled={busy}
                className="inline-flex h-8 items-center rounded-full border border-[var(--button-secondary-border)] px-4 text-xs text-[var(--button-secondary-fg)] hover:bg-[var(--button-secondary-hover-bg)] disabled:opacity-50"
                onClick={onClose}
              >
                {t('meka.formalPicker.cancel')}
              </button>
              {loadState === 'connected' ? (
                <button
                  type="button"
                  disabled={preparing || !link.trim()}
                  className="inline-flex h-8 items-center gap-1.5 rounded-full bg-[var(--accent-cta-bg)] px-4 text-xs font-medium text-[var(--accent-pure-cta-fg)] hover:bg-[var(--accent-hover)] disabled:opacity-50"
                  onClick={() => void prepare()}
                >
                  {preparing ? <Loader2 size={13} className="animate-spin" /> : null}
                  {preparing ? t('meka.formalPicker.preparing') : t('meka.formalPicker.confirm')}
                </button>
              ) : null}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
