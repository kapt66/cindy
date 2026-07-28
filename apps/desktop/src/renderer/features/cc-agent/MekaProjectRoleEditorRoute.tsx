import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  BookOpen,
  BriefcaseBusiness,
  ChevronRight,
  Copy,
  MessageSquarePlus,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  Users,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';

import {
  PLUGIN_MANAGEMENT_FRAME_CLASS,
  PluginManagementPage,
} from '@/features/plugin/PluginManagementLayout';
import { WINDOW_DRAG_STYLE, WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { emitMekaProjectsRolesChanged } from '@/lib/mekaProjectsRolesBus';
import type {
  MekaProject,
  MekaProjectFile,
  MekaProjectMetadata,
  MekaProjectMetadataConfigItem,
  MekaProjectMetadataItemType,
  MekaProjectMetadataSelection,
  MekaRoleMcpEntry,
  MekaRoleMcpInlineConfig,
  MekaRoleManifestFile,
  MekaRoleSkillEntry,
  MekaRoleSkillSelection,
  MekaSkillCatalogEntry,
  MekaWorkflowType,
} from '../../../shared/meka-projects';
import { MEKA_GENERAL_DISCIPLINE } from '../../../shared/meka-projects';
import { parseJiraIssueFromLink } from '../../../shared/jira';
import { MekaProjectRemoteInstances } from './MekaProjectRemoteInstances';

type DraftProject = {
  displayName: string;
  description: string;
  path: string;
  formalWorkflowEnabled: boolean;
  workflowType: MekaWorkflowType;
  jiraProjectKey: string;
  gitlabProjectUrl: string;
  disciplines: string[];
  domains: string[];
};

const inputClass =
  'h-10 w-full rounded-full border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] px-4 text-13 text-[var(--settings-input-text)] outline-none transition-colors placeholder:text-[var(--settings-input-placeholder)] focus:border-[var(--settings-input-border-focus)] disabled:cursor-default disabled:opacity-55';
const textAreaClass =
  'min-h-24 w-full resize-y rounded-lg border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] px-4 py-3 text-13 leading-5 text-[var(--settings-input-text)] outline-none transition-colors placeholder:text-[var(--settings-input-placeholder)] focus:border-[var(--settings-input-border-focus)] disabled:cursor-default disabled:opacity-55';
const buttonClass =
  'inline-flex h-9 select-none items-center justify-center gap-2 rounded-full border border-[var(--button-secondary-border)] bg-[var(--button-secondary-bg)] px-4 text-13 font-medium text-[var(--button-secondary-fg)] transition-colors hover:bg-[var(--button-secondary-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-40';
const detailSectionClass = 'mt-9 first:mt-0';
const detailSurfaceClass =
  'rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated-soft)] p-5';
const fieldLabelClass = 'flex flex-col gap-2 text-13 text-[var(--text-secondary)]';
const compactButtonClass =
  'inline-flex h-8 items-center justify-center gap-1.5 rounded-full border border-[var(--button-secondary-border)] bg-[var(--button-secondary-bg)] px-3 text-12 text-[var(--button-secondary-fg)] transition-colors hover:bg-[var(--button-secondary-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-40';
const METADATA_TYPE_ORDER: readonly MekaProjectMetadataItemType[] = [
  'skill',
  'rule',
  'mcp',
  'agents-md',
];

function DetailSectionHeader({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 text-[var(--text-tertiary)]">{icon}</span>
        <div className="min-w-0">
          <h2 className="text-16 font-medium leading-6 text-[var(--text-primary)]">{title}</h2>
          {description ? (
            <p className="mt-1 text-13 leading-5 text-[var(--text-secondary)]">{description}</p>
          ) : null}
        </div>
      </div>
      {action}
    </div>
  );
}

function projectDraft(project: MekaProject, file?: MekaProjectFile | null): DraftProject {
  const basic = file?.basic;
  return {
    displayName: basic?.displayName ?? project.displayName,
    description: basic?.description ?? project.description ?? '',
    path: basic?.path ?? project.path ?? '',
    formalWorkflowEnabled:
      basic?.formalWorkflowEnabled === true || project.formalWorkflowEnabled === true,
    workflowType: basic?.workflowType ?? project.workflowType ?? 'none',
    jiraProjectKey: basic?.jiraProjectKey ?? project.jiraProjectKey ?? '',
    gitlabProjectUrl: basic?.gitlabProjectUrl ?? project.gitlabProjectUrl ?? '',
    disciplines: basic?.disciplines ?? [MEKA_GENERAL_DISCIPLINE],
    domains: basic?.domains ?? [],
  };
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function metadataConfig(item: MekaProjectMetadata): MekaProjectMetadataConfigItem {
  return {
    sourcePath: item.sourcePath,
    itemType: item.itemType,
    subProjectPath: item.subProjectPath,
    name: item.name,
    contentFingerprint: item.contentFingerprint,
    disciplines: item.disciplines,
    domains: item.domains,
    enabled: item.enabled,
    ...(item.displayName ? { displayName: item.displayName } : {}),
    ...(item.description ? { description: item.description } : {}),
    ...(item.notes ? { notes: item.notes } : {}),
  };
}

function projectFileFromDraft(
  file: MekaProjectFile,
  project: DraftProject,
  metadata: readonly MekaProjectMetadata[],
): MekaProjectFile {
  return {
    ...file,
    basic: {
      ...file.basic,
      displayName: project.displayName.trim(),
      description: project.description.trim() || undefined,
      path: project.path.trim(),
      formalWorkflowEnabled: project.formalWorkflowEnabled,
      workflowType: project.formalWorkflowEnabled ? project.workflowType : 'none',
      jiraProjectKey: project.jiraProjectKey.trim() || undefined,
      gitlabProjectUrl: project.gitlabProjectUrl.trim() || undefined,
      disciplines: [...project.disciplines],
      domains: [...project.domains],
    },
    metadata: metadata.map(metadataConfig),
  };
}

function safeConfigId(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
}

function isRoleSkillSelection(
  item: MekaRoleSkillSelection | MekaRoleSkillEntry,
): item is MekaRoleSkillSelection {
  return 'skillId' in item;
}

function isInlineMcp(item: MekaRoleMcpEntry): item is MekaRoleMcpInlineConfig {
  return 'transport' in item;
}

function VocabEditor({
  values,
  disabled,
  locked = [],
  placeholder,
  onChange,
}: {
  values: string[];
  disabled?: boolean;
  locked?: readonly string[];
  placeholder: string;
  onChange: (values: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  const lockedValues = useMemo(() => new Set(locked), [locked]);
  const add = () => {
    const value = draft.trim();
    if (!value || values.includes(value)) return;
    onChange([...values, value]);
    setDraft('');
  };

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {values.map((value) => (
          <span
            key={value}
            className="inline-flex h-8 items-center gap-1.5 rounded-full border border-[var(--border-default)] bg-[var(--surface-chip)] px-3 text-12 text-[var(--text-secondary)]"
          >
            {value}
            {!disabled && !lockedValues.has(value) ? (
              <button
                type="button"
                className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                onClick={() => onChange(values.filter((item) => item !== value))}
                aria-label={value}
              >
                ×
              </button>
            ) : null}
          </span>
        ))}
      </div>
      {!disabled ? (
        <div className="mt-3 flex gap-2">
          <input
            className={inputClass}
            value={draft}
            placeholder={placeholder}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                add();
              }
            }}
          />
          <button
            type="button"
            className={compactButtonClass}
            onClick={add}
            disabled={!draft.trim()}
          >
            <Plus size={13} aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </div>
  );
}

function MetadataSelectionList({
  metadata,
  itemTypes,
  selections,
  disabled,
  onChange,
}: {
  metadata: readonly MekaProjectMetadata[];
  itemTypes: readonly MekaProjectMetadataItemType[];
  selections: readonly MekaProjectMetadataSelection[];
  disabled?: boolean;
  onChange: (selections: MekaProjectMetadataSelection[]) => void;
}) {
  const { t } = useTranslation();
  const items = metadata.filter((item) => item.enabled && itemTypes.includes(item.itemType));
  if (items.length === 0) return null;
  const selectionMap = new Map(
    selections.map((item) => [`${item.itemType}:${item.sourcePath}`, item]),
  );

  return (
    <div className="mt-4 border-t border-[var(--border-default)] pt-4">
      <div className="mb-2 text-12 font-medium text-[var(--text-secondary)]">
        {t('meka.projectKnowledge')}
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        {items.map((item) => {
          const key = `${item.itemType}:${item.sourcePath}`;
          const checked = selectionMap.get(key)?.enabled === true;
          return (
            <label
              key={key}
              className="flex min-w-0 items-center gap-2 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 py-2 text-12"
            >
              <input
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={(event) => {
                  const next = selections.filter(
                    (selection) =>
                      selection.sourcePath !== item.sourcePath ||
                      selection.itemType !== item.itemType,
                  );
                  if (event.target.checked) {
                    next.push({
                      sourcePath: item.sourcePath,
                      itemType: item.itemType,
                      enabled: true,
                    });
                  }
                  onChange(next);
                }}
              />
              <span className="min-w-0 flex-1 truncate">{item.displayName ?? item.name}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

function RoleSkillsEditor({
  skills,
  catalog,
  disabled,
  onChange,
}: {
  skills: Array<MekaRoleSkillSelection | MekaRoleSkillEntry>;
  catalog: readonly MekaSkillCatalogEntry[];
  disabled?: boolean;
  onChange: (skills: Array<MekaRoleSkillSelection | MekaRoleSkillEntry>) => void;
}) {
  const { t } = useTranslation();
  const selections = skills.filter(isRoleSkillSelection);
  const legacyEntries = skills.filter(
    (item): item is MekaRoleSkillEntry => !isRoleSkillSelection(item),
  );
  const knownIds = new Set(catalog.map((item) => item.skillId));
  const unknownSelections = selections.filter((item) => !knownIds.has(item.skillId));
  const selectedById = new Map(selections.map((item) => [item.skillId, item]));
  const grouped = new Map<string, MekaSkillCatalogEntry[]>();
  for (const item of catalog) {
    const key = `${item.category} / ${item.subCategory}`;
    grouped.set(key, [...(grouped.get(key) ?? []), item]);
  }

  const setSelected = (skillId: string, enabled: boolean) => {
    const existing = selectedById.get(skillId);
    if (existing) {
      onChange(
        skills.map((item) =>
          isRoleSkillSelection(item) && item.skillId === skillId ? { ...item, enabled } : item,
        ),
      );
      return;
    }
    onChange([...skills, { skillId, enabled }]);
  };

  return (
    <div className="flex flex-col gap-5">
      {[...grouped.entries()].map(([group, entries]) => (
        <div key={group}>
          <div className="mb-2 text-12 font-medium text-[var(--text-secondary)]">{group}</div>
          <div className="grid gap-2 md:grid-cols-2">
            {entries.map((item) => {
              const selected = selectedById.get(item.skillId);
              return (
                <label
                  key={item.filePath}
                  className="flex min-w-0 items-start gap-3 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 py-2.5"
                >
                  <input
                    className="mt-0.5"
                    type="checkbox"
                    checked={selected?.enabled === true}
                    disabled={disabled}
                    onChange={(event) => setSelected(item.skillId, event.target.checked)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-12 font-medium text-[var(--text-primary)]">
                      {item.skillId}
                    </span>
                    <span className="mt-0.5 block text-11 leading-4 text-[var(--text-secondary)]">
                      {item.description}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      ))}
      {unknownSelections.length > 0 || legacyEntries.length > 0 ? (
        <div>
          <div className="mb-2 text-12 font-medium text-[var(--text-secondary)]">
            {t('meka.legacySkillReferences')}
          </div>
          <div className="flex flex-col gap-2">
            {unknownSelections.map((item) => (
              <div
                key={item.skillId}
                className="flex min-w-0 items-center gap-3 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 py-2.5"
              >
                <input
                  type="checkbox"
                  checked={item.enabled}
                  disabled={disabled}
                  onChange={(event) => setSelected(item.skillId, event.target.checked)}
                />
                <span className="min-w-0 flex-1 truncate text-12 text-[var(--text-secondary)]">
                  {item.skillId}
                </span>
                {!disabled ? (
                  <button
                    type="button"
                    className="text-[var(--text-tertiary)] hover:text-[var(--error-fg-strong)]"
                    onClick={() =>
                      onChange(
                        skills.filter(
                          (current) =>
                            !isRoleSkillSelection(current) || current.skillId !== item.skillId,
                        ),
                      )
                    }
                    aria-label={t('meka.remove')}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            ))}
            {legacyEntries.map((item, index) => (
              <div
                key={`${item.id}:${item.path}:${index}`}
                className="flex min-w-0 items-center gap-3 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 py-2.5"
              >
                <span className="min-w-0 flex-1 truncate text-12 text-[var(--text-secondary)]">
                  {item.path}
                </span>
                {!disabled ? (
                  <button
                    type="button"
                    className="text-[var(--text-tertiary)] hover:text-[var(--error-fg-strong)]"
                    onClick={() =>
                      onChange(
                        skills.filter(
                          (current) =>
                            isRoleSkillSelection(current) ||
                            current.id !== item.id ||
                            current.path !== item.path,
                        ),
                      )
                    }
                    aria-label={t('meka.remove')}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {catalog.length === 0 && skills.length === 0 ? (
        <p className="text-13 text-[var(--text-tertiary)]">{t('meka.skillsEmpty')}</p>
      ) : null}
    </div>
  );
}

function RoleMcpEditor({
  entries,
  disabled,
  onChange,
}: {
  entries: MekaRoleMcpEntry[];
  disabled?: boolean;
  onChange: (entries: MekaRoleMcpEntry[]) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState('');
  const add = () => {
    const providerId = safeConfigId(draft);
    if (!providerId || entries.some((item) => item.id === providerId)) return;
    onChange([...entries, { id: providerId, providerId, enabled: true }]);
    setDraft('');
  };

  return (
    <div>
      <div className="flex flex-col gap-3">
        {entries.map((entry, index) => (
          <div
            key={`${entry.id}:${index}`}
            className="rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] p-3"
          >
            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                checked={entry.enabled !== false}
                disabled={disabled}
                onChange={(event) =>
                  onChange(
                    entries.map((current, currentIndex) =>
                      currentIndex === index
                        ? { ...current, enabled: event.target.checked }
                        : current,
                    ),
                  )
                }
              />
              <span className="min-w-0 flex-1 truncate text-12 font-medium text-[var(--text-primary)]">
                {entry.id}
              </span>
              <span className="text-10 text-[var(--text-tertiary)]">
                {isInlineMcp(entry) ? entry.transport : t('meka.providerReference')}
              </span>
              {!disabled ? (
                <button
                  type="button"
                  className="text-[var(--text-tertiary)] hover:text-[var(--error-fg-strong)]"
                  onClick={() =>
                    onChange(entries.filter((_, currentIndex) => currentIndex !== index))
                  }
                  aria-label={t('meka.remove')}
                >
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              ) : null}
            </div>
            {isInlineMcp(entry) ? (
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <label className={fieldLabelClass}>
                  <span>{entry.transport === 'stdio' ? t('meka.command') : t('meka.url')}</span>
                  <input
                    className={inputClass}
                    disabled={disabled}
                    value={entry.transport === 'stdio' ? (entry.command ?? '') : (entry.url ?? '')}
                    onChange={(event) =>
                      onChange(
                        entries.map((current, currentIndex) => {
                          if (currentIndex !== index || !isInlineMcp(current)) return current;
                          return current.transport === 'stdio'
                            ? { ...current, command: event.target.value }
                            : { ...current, url: event.target.value };
                        }),
                      )
                    }
                  />
                </label>
                {entry.transport === 'stdio' ? (
                  <label className={fieldLabelClass}>
                    <span>{t('meka.arguments')}</span>
                    <input
                      className={inputClass}
                      disabled={disabled}
                      value={(entry.args ?? []).join(' ')}
                      onChange={(event) =>
                        onChange(
                          entries.map((current, currentIndex) =>
                            currentIndex === index && isInlineMcp(current)
                              ? {
                                  ...current,
                                  args: event.target.value
                                    .split(/\s+/)
                                    .map((value) => value.trim())
                                    .filter(Boolean),
                                }
                              : current,
                          ),
                        )
                      }
                    />
                  </label>
                ) : null}
              </div>
            ) : (
              <label className={cn(fieldLabelClass, 'mt-3')}>
                <span>{t('meka.providerId')}</span>
                <input
                  className={inputClass}
                  disabled={disabled}
                  value={entry.providerId}
                  onChange={(event) =>
                    onChange(
                      entries.map((current, currentIndex) =>
                        currentIndex === index && !isInlineMcp(current)
                          ? { ...current, providerId: event.target.value }
                          : current,
                      ),
                    )
                  }
                />
              </label>
            )}
          </div>
        ))}
      </div>
      {!disabled ? (
        <div className="mt-3 flex gap-2">
          <input
            className={inputClass}
            value={draft}
            placeholder={t('meka.providerIdPlaceholder')}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                add();
              }
            }}
          />
          <button
            type="button"
            className={compactButtonClass}
            onClick={add}
            disabled={!safeConfigId(draft)}
          >
            <Plus size={13} aria-hidden="true" />
            {t('meka.add')}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function MekaProjectRoleEditorRoute() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const requestedProjectId = searchParams.get('projectId');
  const requestedRoleId = searchParams.get('roleId');
  const [projects, setProjects] = useState<MekaProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [project, setProject] = useState<DraftProject | null>(null);
  const [projectFile, setProjectFile] = useState<MekaProjectFile | null>(null);
  const [role, setRole] = useState<MekaRoleManifestFile | null>(null);
  const [roleEffective, setRoleEffective] = useState<MekaRoleManifestFile | null>(null);
  const [metadata, setMetadata] = useState<MekaProjectMetadata[]>([]);
  const [metadataEffective, setMetadataEffective] = useState<MekaProjectMetadata[]>([]);
  const [skillCatalog, setSkillCatalog] = useState<MekaSkillCatalogEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [gitRemoteFetching, setGitRemoteFetching] = useState(false);
  const [projectsLoaded, setProjectsLoaded] = useState(false);

  const selectedProject = useMemo(
    () => projects.find((item) => item.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );

  const reload = useCallback(async (preferredId?: string | null) => {
    const next = await window.electronAPI.localDb.mekaProjects.list();
    setProjects(next);
    setSelectedProjectId((current) => {
      if (preferredId !== undefined) {
        return preferredId && next.some((item) => item.id === preferredId) ? preferredId : null;
      }
      return current && next.some((item) => item.id === current) ? current : null;
    });
    emitMekaProjectsRolesChanged();
    return next;
  }, []);

  useEffect(() => {
    void reload(requestedProjectId)
      .then((nextProjects) => {
        if (!requestedProjectId || !requestedRoleId) return;
        const requestedProject = nextProjects.find((item) => item.id === requestedProjectId);
        if (requestedProject?.roles.some((item) => item.id === requestedRoleId)) {
          setSelectedRoleId(requestedRoleId);
        }
      })
      .catch(() => toast.error(t('meka.failed')))
      .finally(() => setProjectsLoaded(true));
  }, [reload, requestedProjectId, requestedRoleId, t]);

  useEffect(() => {
    void window.electronAPI.localDb.mekaSkillCatalog
      .list()
      .then(setSkillCatalog)
      .catch(() => setSkillCatalog([]));
  }, []);

  useEffect(() => {
    if (!selectedProject) {
      setProject(null);
      setProjectFile(null);
      setRole(null);
      setRoleEffective(null);
      setSelectedRoleId(null);
      setMetadata([]);
      setMetadataEffective([]);
      return;
    }
    let cancelled = false;
    setProject(projectDraft(selectedProject));
    setProjectFile(null);
    setMetadata([]);
    setMetadataEffective([]);
    setSelectedRoleId((current) =>
      current && selectedProject.roles.some((item) => item.id === current) ? current : null,
    );
    void Promise.all([
      window.electronAPI.localDb.mekaProjectMetadata.loadProject(selectedProject.id),
      window.electronAPI.localDb.mekaProjectMetadata.list(selectedProject.id),
    ])
      .then(([nextFile, nextMetadata]) => {
        if (!cancelled) {
          setProjectFile(nextFile);
          setProject(projectDraft(selectedProject, nextFile));
          setMetadata(cloneValue(nextMetadata));
          setMetadataEffective(cloneValue(nextMetadata));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setProjectFile(null);
          setMetadata([]);
          setMetadataEffective([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedProject]);

  useEffect(() => {
    if (!selectedRoleId) {
      setRole(null);
      setRoleEffective(null);
      return;
    }
    let cancelled = false;
    setRole(null);
    setRoleEffective(null);
    void window.electronAPI.localDb.mekaRoles
      .readManifest(selectedRoleId)
      .then((nextRole) => {
        if (!cancelled) {
          setRole(nextRole ? cloneValue(nextRole) : null);
          setRoleEffective(nextRole ? cloneValue(nextRole) : null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRole(null);
          setRoleEffective(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRoleId]);

  const run = useCallback(
    async (action: () => Promise<void>) => {
      setBusy(true);
      try {
        await action();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : t('meka.failed'));
      } finally {
        setBusy(false);
      }
    },
    [t],
  );

  const createProject = () =>
    void run(async () => {
      const displayName = window.prompt(t('meka.projectName'))?.trim();
      if (!displayName) return;
      const path = window.prompt(t('meka.projectPath'))?.trim();
      if (!path) return;
      const created = await window.electronAPI.localDb.mekaProjects.create({ displayName, path });
      setSelectedRoleId(null);
      await reload(created.id);
    });

  const projectDirty = useMemo(() => {
    if (!project || !projectFile) return false;
    return (
      JSON.stringify(projectFileFromDraft(projectFile, project, metadata)) !==
      JSON.stringify(projectFile)
    );
  }, [metadata, project, projectFile]);

  const roleDirty = useMemo(
    () => !!role && !!roleEffective && JSON.stringify(role) !== JSON.stringify(roleEffective),
    [role, roleEffective],
  );

  const cancelProjectDraft = () => {
    if (!selectedProject || !projectFile) return;
    setProject(projectDraft(selectedProject, projectFile));
    setMetadata(cloneValue(metadataEffective));
  };

  const cancelRoleDraft = () => {
    setRole(roleEffective ? cloneValue(roleEffective) : null);
  };

  const parseJiraProjectKeyFromClipboard = async () => {
    if (!project) return;
    try {
      const parsed = parseJiraIssueFromLink(await navigator.clipboard.readText());
      if (!parsed) {
        toast.error(t('meka.jiraKeyParseFailed'));
        return;
      }
      setProject((current) =>
        current ? { ...current, jiraProjectKey: parsed.projectKey } : current,
      );
    } catch {
      toast.error(t('meka.jiraKeyParseFailed'));
    }
  };

  const fetchGitRemoteUrl = async () => {
    if (!selectedProject || !project) return;
    setGitRemoteFetching(true);
    try {
      const url = await window.electronAPI.localDb.mekaProjectMetadata.gitRemote(
        selectedProject.id,
      );
      if (!url) {
        toast.error(t('meka.gitRemoteNotFound'));
        return;
      }
      setProject((current) => (current ? { ...current, gitlabProjectUrl: url } : current));
    } catch {
      toast.error(t('meka.gitRemoteNotFound'));
    } finally {
      setGitRemoteFetching(false);
    }
  };

  const saveProject = () => {
    if (!selectedProject || !project || !projectFile) return;
    void run(async () => {
      const savedFile = await window.electronAPI.localDb.mekaProjectMetadata.saveProject({
        projectId: selectedProject.id,
        project: projectFileFromDraft(projectFile, project, metadata),
      });
      const savedMetadata = await window.electronAPI.localDb.mekaProjectMetadata.list(
        selectedProject.id,
      );
      setProjectFile(cloneValue(savedFile));
      setProject(projectDraft(selectedProject, savedFile));
      setMetadata(cloneValue(savedMetadata));
      setMetadataEffective(cloneValue(savedMetadata));
      await reload(selectedProject.id);
      toast.success(t('meka.saved'));
    });
  };

  const deleteProject = () => {
    if (
      !selectedProject ||
      selectedProject.isBuiltin ||
      !window.confirm(t('meka.confirmDeleteProject'))
    ) {
      return;
    }
    void run(async () => {
      await window.electronAPI.localDb.mekaProjects.delete(selectedProject.id);
      await reload(null);
    });
  };

  const createRole = () => {
    if (!selectedProject) return;
    void run(async () => {
      const displayName = window.prompt(t('meka.roleName'))?.trim();
      if (!displayName) return;
      const created = await window.electronAPI.localDb.mekaRoles.create({
        projectId: selectedProject.id,
        roleFile: {
          schemaVersion: 1,
          displayName,
          description: '',
          prompt: '',
          policyProviderRefs: [],
          rules: [],
          skills: [],
          promptFragments: [],
          mcp: [],
          projectMetadataSelection: [],
        },
      });
      await reload(selectedProject.id);
      setSelectedRoleId(created.id);
    });
  };

  const saveRole = () => {
    const selectedRole = selectedProject?.roles.find((item) => item.id === selectedRoleId);
    if (!selectedProject || !role || selectedRole?.isBuiltin) return;
    void run(async () => {
      await window.electronAPI.localDb.mekaRoles.update({
        projectId: selectedProject.id,
        roleFile: role,
      });
      const savedRole = await window.electronAPI.localDb.mekaRoles.readManifest(role.id);
      if (!savedRole) throw new Error('role manifest unavailable after save');
      setRole(cloneValue(savedRole));
      setRoleEffective(cloneValue(savedRole));
      await reload(selectedProject.id);
      toast.success(t('meka.saved'));
    });
  };

  const copyRole = () => {
    if (!selectedProject || !role) return;
    void run(async () => {
      const { id: _id, name: _name, projectId: _projectId, ...roleFile } = role;
      const created = await window.electronAPI.localDb.mekaRoles.create({
        projectId: selectedProject.id,
        roleFile: {
          ...roleFile,
          displayName: t('meka.roleCopyName', { name: role.displayName }),
        },
      });
      await reload(selectedProject.id);
      setSelectedRoleId(created.id);
    });
  };

  const deleteRole = () => {
    if (!selectedProject || !role) return;
    const selectedRole = selectedProject.roles.find((item) => item.id === selectedRoleId);
    if (selectedRole?.isBuiltin) return;
    if (selectedProject.roles.length <= 1) {
      toast.error(t('meka.atLeastOneRole'));
      return;
    }
    if (!window.confirm(t('meka.confirmDeleteRole'))) return;
    void run(async () => {
      await window.electronAPI.localDb.mekaRoles.delete(role.id);
      setSelectedRoleId(null);
      await reload(selectedProject.id);
    });
  };

  const discoverMetadata = () => {
    if (!selectedProject) return;
    void run(async () => {
      const nextMetadata = await window.electronAPI.localDb.mekaProjectMetadata.discover(
        selectedProject.id,
      );
      const nextFile = await window.electronAPI.localDb.mekaProjectMetadata.loadProject(
        selectedProject.id,
      );
      setMetadata(cloneValue(nextMetadata));
      setMetadataEffective(cloneValue(nextMetadata));
      setProjectFile(cloneValue(nextFile));
      setProject(projectDraft(selectedProject, nextFile));
    });
  };

  if (!selectedProject) {
    return (
      <main className="flex h-full min-h-0 w-full flex-col bg-[var(--surface)] text-[var(--text-primary)]">
        <header className="h-16 shrink-0 px-3" style={WINDOW_DRAG_STYLE}>
          <div
            className={cn(
              PLUGIN_MANAGEMENT_FRAME_CLASS,
              'flex h-full items-center justify-end gap-4',
            )}
          >
            <button
              type="button"
              className={buttonClass}
              style={WINDOW_NO_DRAG_STYLE}
              onClick={createProject}
              disabled={busy}
            >
              <Plus size={15} aria-hidden="true" />
              {t('meka.newProject')}
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable_both-edges]">
          <PluginManagementPage>
            {!projectsLoaded ? (
              <div className="flex min-h-72 items-center justify-center text-13 text-[var(--text-secondary)]">
                {t('meka.loading')}
              </div>
            ) : projects.length > 0 ? (
              <section className="min-w-0">
                <div className="mb-5 flex items-baseline gap-2">
                  <h2 className="text-20 font-medium text-[var(--text-primary)]">
                    {t('meka.projectNavigation')}
                  </h2>
                  <span className="text-13 tabular-nums text-[var(--text-tertiary)]">
                    {projects.length}
                  </span>
                </div>
                <div className="plugin-motion-stagger grid grid-cols-1 gap-3 md:grid-cols-2">
                  {projects.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        setSelectedRoleId(null);
                        setSelectedProjectId(item.id);
                      }}
                      className={cn(
                        'group flex w-full items-start gap-3 rounded-[12px] border-[0.5px] border-[var(--border-default)] px-3 py-2.5 text-left',
                        'bg-[var(--surface-elevated)] shadow-[var(--plugin-card-shadow)]',
                        'transition-[background-color,border-color,transform] duration-150 ease-out',
                        'hover:-translate-y-0.5 hover:border-[var(--text-tertiary)]',
                        'active:translate-y-0 active:scale-[0.992]',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                      )}
                      aria-label={item.displayName}
                    >
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-[22%] border-[0.5px] border-[var(--border-default)] bg-[var(--surface-elevated)] text-[var(--text-primary)] shadow-[var(--plugin-card-shadow)]">
                        <BriefcaseBusiness size={17} strokeWidth={1.75} aria-hidden="true" />
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col gap-1 pt-0.5">
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-13 font-medium text-[var(--text-primary)]">
                            {item.displayName}
                          </span>
                          {item.isBuiltin ? (
                            <span className="shrink-0 text-10 text-[var(--text-tertiary)]">
                              {t('meka.builtin')}
                            </span>
                          ) : null}
                        </span>
                        {item.description || item.path ? (
                          <span className="line-clamp-1 text-12 leading-4 text-[var(--text-secondary)]">
                            {item.description || item.path}
                          </span>
                        ) : null}
                      </span>
                      <span className="mt-1 flex size-7 shrink-0 items-center justify-center rounded-lg border border-transparent text-[var(--text-secondary)] transition-[background-color,color,transform] group-hover:translate-x-0.5 group-hover:bg-[var(--surface-chip)] group-hover:text-[var(--text-primary)] group-active:translate-x-0 group-active:scale-95">
                        <ChevronRight size={15} strokeWidth={1.8} aria-hidden="true" />
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            ) : (
              <div className="mt-7 flex min-h-72 flex-col items-center justify-center rounded-xl border-[0.5px] border-[var(--border-default)] p-8 text-center">
                <BriefcaseBusiness
                  size={30}
                  className="text-[var(--text-tertiary)]"
                  aria-hidden="true"
                />
                <p className="mt-4 max-w-sm text-14 leading-6 text-[var(--text-secondary)]">
                  {t('meka.empty')}
                </p>
                <button className={cn(buttonClass, 'mt-5')} onClick={createProject} disabled={busy}>
                  <Plus size={15} aria-hidden="true" />
                  {t('meka.newProject')}
                </button>
              </div>
            )}
          </PluginManagementPage>
        </div>
      </main>
    );
  }

  const showingRole = selectedRoleId !== null;
  const selectedRoleSummary =
    selectedProject.roles.find((item) => item.id === selectedRoleId) ?? null;
  const selectionReadOnly = showingRole ? selectedRoleSummary?.isBuiltin === true : false;

  return (
    <main className="flex h-full min-h-0 w-full flex-col bg-[var(--surface)] text-[var(--text-primary)]">
      <header
        className="flex h-[72px] w-full shrink-0 items-center gap-4 border-b border-[var(--cmd-palette-border)] pl-4 pr-6"
        style={WINDOW_DRAG_STYLE}
      >
        <button
          type="button"
          onClick={() => {
            setSelectedRoleId(null);
            setSelectedProjectId(null);
          }}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[var(--settings-section-desc)] transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
          style={WINDOW_NO_DRAG_STYLE}
          aria-label={t('meka.backToProjects')}
        >
          <ArrowLeft size={18} aria-hidden="true" />
        </button>
        <div className="flex min-w-0 flex-1 flex-col gap-1 overflow-hidden">
          <h1 className="truncate text-lg font-medium leading-none text-[var(--text-primary)]">
            {selectedProject.displayName}
          </h1>
          <p className="truncate text-12 text-[var(--text-tertiary)]">
            {selectedProject.path ?? selectedProject.id}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2" style={WINDOW_NO_DRAG_STYLE}>
          {showingRole && selectedRoleSummary?.isBuiltin ? (
            <button className={buttonClass} onClick={copyRole} disabled={busy || !role}>
              <Copy size={14} aria-hidden="true" />
              {t('meka.copyRole')}
            </button>
          ) : null}
          {!selectionReadOnly ? (
            <>
              <button
                className={buttonClass}
                onClick={showingRole ? cancelRoleDraft : cancelProjectDraft}
                disabled={busy || !(showingRole ? roleDirty : projectDirty)}
              >
                {t('logic.confirm.cancel')}
              </button>
              <button
                className={buttonClass}
                onClick={showingRole ? saveRole : saveProject}
                disabled={
                  busy ||
                  !(showingRole ? roleDirty && !!role : projectDirty && !!project && !!projectFile)
                }
              >
                <Save size={14} aria-hidden="true" />
                {showingRole ? t('meka.saveRole') : t('meka.save')}
              </button>
              {showingRole || !selectedProject.isBuiltin ? (
                <button
                  type="button"
                  onClick={showingRole ? deleteRole : deleteProject}
                  disabled={busy || (showingRole ? !role : !project)}
                  aria-label={showingRole ? t('meka.deleteRole') : t('meka.delete')}
                  className="grid size-9 shrink-0 place-items-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--error-bg)] hover:text-[var(--error-fg-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-40"
                >
                  <Trash2 size={16} aria-hidden="true" />
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[260px] shrink-0 flex-col overflow-y-auto border-r border-[var(--cmd-palette-border)] px-3 py-4">
          <nav className="flex flex-col gap-1" aria-label={t('meka.projectNavigation')}>
            <button
              type="button"
              onClick={() => setSelectedRoleId(null)}
              aria-current={!showingRole ? 'page' : undefined}
              className={cn(
                'flex min-h-10 w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-13 transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                !showingRole
                  ? 'bg-[var(--surface-chip)] font-medium text-[var(--text-primary)]'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover-soft)] hover:text-[var(--text-primary)]',
              )}
            >
              <BriefcaseBusiness size={16} className="shrink-0" aria-hidden="true" />
              <span className="truncate">{t('meka.projectDetails')}</span>
            </button>
          </nav>

          <div className="mt-6 flex items-center justify-between gap-2 px-3">
            <h2 className="text-xs font-medium uppercase tracking-wider text-[var(--text-tertiary)]">
              {t('meka.roles')}
            </h2>
            <button
              type="button"
              onClick={createRole}
              disabled={busy}
              aria-label={t('meka.newRole')}
              className="grid size-7 shrink-0 place-items-center rounded-full text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-hover-soft)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-40"
            >
              <Plus size={14} aria-hidden="true" />
            </button>
          </div>
          <nav className="mt-2 flex flex-col gap-1" aria-label={t('meka.roles')}>
            {selectedProject.roles.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setSelectedRoleId(item.id)}
                aria-current={item.id === selectedRoleId ? 'page' : undefined}
                className={cn(
                  'flex min-h-10 w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                  item.id === selectedRoleId
                    ? 'bg-[var(--surface-chip)] text-[var(--text-primary)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover-soft)] hover:text-[var(--text-primary)]',
                )}
              >
                <Users size={15} className="shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-13 font-medium">
                  {item.displayName}
                </span>
              </button>
            ))}
          </nav>
        </aside>

        <section className="min-w-0 flex-1 overflow-y-auto px-8 pb-16 pt-8 [scrollbar-gutter:stable]">
          {showingRole ? (
            role ? (
              <div className="mx-auto w-full max-w-[760px]">
                <section className={detailSectionClass}>
                  <DetailSectionHeader
                    icon={<Users size={18} aria-hidden="true" />}
                    title={t('meka.roleBasicInfo')}
                    description={
                      selectionReadOnly ? t('meka.builtinRoleReadOnly') : t('meka.rolesDescription')
                    }
                  />
                  <div className={cn(detailSurfaceClass, 'mt-5')}>
                    <label className={fieldLabelClass}>
                      <span>{t('meka.roleName')}</span>
                      <input
                        className={inputClass}
                        value={role.displayName}
                        disabled={selectionReadOnly}
                        onChange={(event) => setRole({ ...role, displayName: event.target.value })}
                      />
                    </label>
                    <label className={cn(fieldLabelClass, 'mt-4')}>
                      <span>{t('meka.description')}</span>
                      <textarea
                        className={textAreaClass}
                        value={role.description ?? ''}
                        disabled={selectionReadOnly}
                        onChange={(event) => setRole({ ...role, description: event.target.value })}
                      />
                    </label>
                  </div>
                </section>

                <section className={detailSectionClass}>
                  <DetailSectionHeader
                    icon={<MessageSquarePlus size={18} aria-hidden="true" />}
                    title={t('meka.prompt')}
                    description={t('meka.promptDescription')}
                  />
                  <div className={cn(detailSurfaceClass, 'mt-5')}>
                    <textarea
                      className={cn(textAreaClass, 'min-h-72 font-mono text-12')}
                      value={role.prompt ?? ''}
                      disabled={selectionReadOnly}
                      onChange={(event) => setRole({ ...role, prompt: event.target.value })}
                    />
                  </div>
                </section>

                <section className={detailSectionClass}>
                  <DetailSectionHeader
                    icon={<BookOpen size={18} aria-hidden="true" />}
                    title={t('meka.rules')}
                    description={t('meka.rulesDescription')}
                    action={
                      !selectionReadOnly ? (
                        <button
                          type="button"
                          className={compactButtonClass}
                          onClick={() =>
                            setRole({
                              ...role,
                              rules: [
                                ...(role.rules ?? []),
                                {
                                  id: `rule-${Date.now().toString(36)}`,
                                  text: t('meka.newRuleText'),
                                  enabled: true,
                                },
                              ],
                            })
                          }
                        >
                          <Plus size={13} aria-hidden="true" />
                          {t('meka.addRule')}
                        </button>
                      ) : undefined
                    }
                  />
                  <div className={cn(detailSurfaceClass, 'mt-5')}>
                    <div className="flex flex-col gap-3">
                      {(role.rules ?? []).map((ruleItem, index) => (
                        <div key={ruleItem.id} className="flex items-start gap-3">
                          <input
                            className="mt-3"
                            type="checkbox"
                            checked={ruleItem.enabled}
                            disabled={selectionReadOnly}
                            onChange={(event) =>
                              setRole({
                                ...role,
                                rules: (role.rules ?? []).map((item, itemIndex) =>
                                  itemIndex === index
                                    ? { ...item, enabled: event.target.checked }
                                    : item,
                                ),
                              })
                            }
                          />
                          <textarea
                            className={cn(textAreaClass, 'min-h-16 flex-1')}
                            value={ruleItem.text}
                            disabled={selectionReadOnly}
                            onChange={(event) =>
                              setRole({
                                ...role,
                                rules: (role.rules ?? []).map((item, itemIndex) =>
                                  itemIndex === index
                                    ? { ...item, text: event.target.value }
                                    : item,
                                ),
                              })
                            }
                          />
                          {!selectionReadOnly ? (
                            <button
                              type="button"
                              className="mt-3 text-[var(--text-tertiary)] hover:text-[var(--error-fg-strong)]"
                              onClick={() =>
                                setRole({
                                  ...role,
                                  rules: (role.rules ?? []).filter(
                                    (_, itemIndex) => itemIndex !== index,
                                  ),
                                })
                              }
                              aria-label={t('meka.remove')}
                            >
                              <Trash2 size={14} aria-hidden="true" />
                            </button>
                          ) : null}
                        </div>
                      ))}
                      {(role.rules ?? []).length === 0 ? (
                        <p className="text-13 text-[var(--text-tertiary)]">
                          {t('meka.rulesEmpty')}
                        </p>
                      ) : null}
                    </div>
                    <MetadataSelectionList
                      metadata={metadata}
                      itemTypes={['rule', 'agents-md']}
                      selections={role.projectMetadataSelection ?? []}
                      disabled={selectionReadOnly}
                      onChange={(projectMetadataSelection) =>
                        setRole({ ...role, projectMetadataSelection })
                      }
                    />
                  </div>
                </section>

                <section className={detailSectionClass}>
                  <DetailSectionHeader
                    icon={<BookOpen size={18} aria-hidden="true" />}
                    title={t('meka.skills')}
                    description={t('meka.skillsDescription')}
                  />
                  <div className={cn(detailSurfaceClass, 'mt-5')}>
                    <RoleSkillsEditor
                      skills={role.skills}
                      catalog={skillCatalog}
                      disabled={selectionReadOnly}
                      onChange={(skills) => setRole({ ...role, skills })}
                    />
                    <MetadataSelectionList
                      metadata={metadata}
                      itemTypes={['skill']}
                      selections={role.projectMetadataSelection ?? []}
                      disabled={selectionReadOnly}
                      onChange={(projectMetadataSelection) =>
                        setRole({ ...role, projectMetadataSelection })
                      }
                    />
                  </div>
                </section>

                <section className={detailSectionClass}>
                  <DetailSectionHeader
                    icon={<RefreshCw size={18} aria-hidden="true" />}
                    title={t('meka.roleMcp')}
                    description={t('meka.roleMcpDescription')}
                  />
                  <div className={cn(detailSurfaceClass, 'mt-5')}>
                    <RoleMcpEditor
                      entries={role.mcp}
                      disabled={selectionReadOnly}
                      onChange={(mcp) => setRole({ ...role, mcp })}
                    />
                    <MetadataSelectionList
                      metadata={metadata}
                      itemTypes={['mcp']}
                      selections={role.projectMetadataSelection ?? []}
                      disabled={selectionReadOnly}
                      onChange={(projectMetadataSelection) =>
                        setRole({ ...role, projectMetadataSelection })
                      }
                    />
                  </div>
                </section>
              </div>
            ) : (
              <div className="flex h-full items-center justify-center text-13 text-[var(--text-tertiary)]">
                {t('meka.loading')}
              </div>
            )
          ) : project ? (
            <div className="mx-auto w-full max-w-[760px]">
              <section className={detailSectionClass}>
                <DetailSectionHeader
                  icon={<BriefcaseBusiness size={18} aria-hidden="true" />}
                  title={t('meka.projectBasicInfo')}
                  description={
                    selectionReadOnly
                      ? t('meka.builtinProjectReadOnly')
                      : t('meka.projectDetailsDescription')
                  }
                />
                <div className={cn(detailSurfaceClass, 'mt-5 space-y-4')}>
                  <label className={fieldLabelClass}>
                    <span>{t('meka.projectName')}</span>
                    <input
                      className={inputClass}
                      value={project.displayName}
                      disabled={selectionReadOnly}
                      onChange={(event) =>
                        setProject({ ...project, displayName: event.target.value })
                      }
                    />
                  </label>
                  <label className={fieldLabelClass}>
                    <span>{t('meka.description')}</span>
                    <textarea
                      className={textAreaClass}
                      value={project.description}
                      disabled={selectionReadOnly}
                      onChange={(event) =>
                        setProject({ ...project, description: event.target.value })
                      }
                    />
                  </label>
                </div>
              </section>

              <section className={detailSectionClass}>
                <DetailSectionHeader
                  icon={<MessageSquarePlus size={18} aria-hidden="true" />}
                  title={t('meka.projectConfiguration')}
                />
                <div className={cn(detailSurfaceClass, 'mt-5')}>
                  <label className={fieldLabelClass}>
                    <span>{t('meka.projectPath')}</span>
                    <input className={inputClass} value={project.path} disabled />
                  </label>
                  <div className="mt-5 border-t border-[var(--border-default)] pt-5">
                    <div className="grid gap-4 md:grid-cols-2">
                      <label className={fieldLabelClass}>
                        <span>{t('meka.formalProvider')}</span>
                        <select
                          className={inputClass}
                          value={project.formalWorkflowEnabled ? project.workflowType : 'none'}
                          disabled={selectionReadOnly}
                          onChange={(event) => {
                            const workflowType = event.target.value as MekaWorkflowType;
                            setProject({
                              ...project,
                              formalWorkflowEnabled: workflowType !== 'none',
                              workflowType,
                            });
                            if (workflowType === 'gitlab' && !project.gitlabProjectUrl) {
                              void fetchGitRemoteUrl();
                            }
                          }}
                        >
                          <option value="none">{t('meka.formalDisabled')}</option>
                          <option value="jira">Jira</option>
                          <option value="gitlab">GitLab</option>
                        </select>
                      </label>
                      {project.workflowType === 'jira' && project.formalWorkflowEnabled ? (
                        <div className="flex items-end gap-2">
                          <label className={cn(fieldLabelClass, 'min-w-0 flex-1')}>
                            <span>{t('meka.jiraKey')}</span>
                            <input
                              className={inputClass}
                              value={project.jiraProjectKey}
                              disabled={selectionReadOnly}
                              onChange={(event) =>
                                setProject({ ...project, jiraProjectKey: event.target.value })
                              }
                            />
                          </label>
                          {!selectionReadOnly ? (
                            <button
                              type="button"
                              className={cn(compactButtonClass, 'mb-1 shrink-0')}
                              onClick={() => void parseJiraProjectKeyFromClipboard()}
                            >
                              {t('meka.jiraLinkParse')}
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                      {project.workflowType === 'gitlab' && project.formalWorkflowEnabled ? (
                        <div className="flex items-end gap-2">
                          <label className={cn(fieldLabelClass, 'min-w-0 flex-1')}>
                            <span>{t('meka.gitlabUrl')}</span>
                            <input
                              className={inputClass}
                              value={project.gitlabProjectUrl}
                              disabled={selectionReadOnly}
                              onChange={(event) =>
                                setProject({ ...project, gitlabProjectUrl: event.target.value })
                              }
                            />
                          </label>
                          {!selectionReadOnly ? (
                            <button
                              type="button"
                              className={cn(compactButtonClass, 'mb-1 shrink-0')}
                              disabled={gitRemoteFetching}
                              onClick={() => void fetchGitRemoteUrl()}
                            >
                              {gitRemoteFetching
                                ? t('meka.gitRemoteFetching')
                                : t('meka.gitRemoteFetch')}
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              </section>

              <MekaProjectRemoteInstances projectId={selectedProject.id} />

              <section className={detailSectionClass}>
                <DetailSectionHeader
                  icon={<BookOpen size={18} aria-hidden="true" />}
                  title={t('meka.disciplinesAndDomains')}
                />
                <div className={cn(detailSurfaceClass, 'mt-5 space-y-5')}>
                  <div>
                    <div className="mb-2 text-13 font-medium text-[var(--text-secondary)]">
                      {t('meka.disciplines')}
                    </div>
                    <p className="mb-3 text-12 leading-5 text-[var(--text-secondary)]">
                      {t('meka.disciplinesDescription')}
                    </p>
                    <VocabEditor
                      values={project.disciplines}
                      locked={[MEKA_GENERAL_DISCIPLINE]}
                      disabled={selectionReadOnly}
                      placeholder={t('meka.vocabAddPlaceholder')}
                      onChange={(disciplines) => setProject({ ...project, disciplines })}
                    />
                  </div>
                  <div className="border-t border-[var(--border-default)] pt-5">
                    <div className="mb-2 text-13 font-medium text-[var(--text-secondary)]">
                      {t('meka.domains')}
                    </div>
                    <p className="mb-3 text-12 leading-5 text-[var(--text-secondary)]">
                      {t('meka.domainsDescription')}
                    </p>
                    <VocabEditor
                      values={project.domains}
                      disabled={selectionReadOnly}
                      placeholder={t('meka.vocabAddPlaceholder')}
                      onChange={(domains) => setProject({ ...project, domains })}
                    />
                  </div>
                </div>
              </section>

              <section className={detailSectionClass}>
                <DetailSectionHeader
                  icon={<BookOpen size={18} aria-hidden="true" />}
                  title={t('meka.metadata')}
                  action={
                    !selectionReadOnly ? (
                      <button className={buttonClass} onClick={discoverMetadata} disabled={busy}>
                        <RefreshCw
                          size={14}
                          className={cn(busy && 'animate-spin')}
                          aria-hidden="true"
                        />
                        {t('meka.discover')}
                      </button>
                    ) : undefined
                  }
                />
                <div className="mt-5 flex flex-col gap-4">
                  {METADATA_TYPE_ORDER.map((itemType) => {
                    const groupItems = metadata.filter((item) => item.itemType === itemType);
                    return (
                      <section
                        key={itemType}
                        className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated-soft)] p-4"
                      >
                        <div className="mb-3 flex items-baseline gap-2">
                          <h3 className="text-14 font-medium text-[var(--text-primary)]">
                            {t(`meka.metadataTypes.${itemType}`)}
                          </h3>
                          <span className="text-12 tabular-nums text-[var(--text-tertiary)]">
                            {groupItems.length}
                          </span>
                        </div>
                        {groupItems.length > 0 ? (
                          <div className="flex flex-col gap-2">
                            {groupItems.map((item) => {
                              const itemIndex = metadata.indexOf(item);
                              return (
                                <details
                                  key={`${item.itemType}:${item.sourcePath}`}
                                  className="group rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)]"
                                >
                                  <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3">
                                    <ChevronRight
                                      size={14}
                                      className="shrink-0 text-[var(--text-tertiary)] transition-transform group-open:rotate-90"
                                      aria-hidden="true"
                                    />
                                    <span className="min-w-0 flex-1">
                                      <span className="block truncate text-13 font-medium text-[var(--text-primary)]">
                                        {item.displayName ?? item.name}
                                      </span>
                                      <span className="mt-0.5 block truncate text-11 text-[var(--text-tertiary)]">
                                        {t(`meka.metadataTypes.${item.itemType}`)} ·{' '}
                                        {item.sourcePath}
                                      </span>
                                    </span>
                                    <input
                                      type="checkbox"
                                      checked={item.enabled}
                                      disabled={selectionReadOnly}
                                      onClick={(event) => event.stopPropagation()}
                                      onChange={(event) =>
                                        setMetadata(
                                          metadata.map((current, currentIndex) =>
                                            currentIndex === itemIndex
                                              ? { ...current, enabled: event.target.checked }
                                              : current,
                                          ),
                                        )
                                      }
                                      aria-label={t('meka.enabled')}
                                    />
                                  </summary>
                                  <div className="border-t border-[var(--border-default)] px-4 py-4">
                                    <div className="grid gap-4 md:grid-cols-2">
                                      <label className={fieldLabelClass}>
                                        <span>{t('meka.metadataDisplayName')}</span>
                                        <input
                                          className={inputClass}
                                          value={item.displayName ?? ''}
                                          disabled={selectionReadOnly}
                                          onChange={(event) =>
                                            setMetadata(
                                              metadata.map((current, currentIndex) =>
                                                currentIndex === itemIndex
                                                  ? { ...current, displayName: event.target.value }
                                                  : current,
                                              ),
                                            )
                                          }
                                        />
                                      </label>
                                      <label className={fieldLabelClass}>
                                        <span>{t('meka.description')}</span>
                                        <input
                                          className={inputClass}
                                          value={item.description ?? ''}
                                          disabled={selectionReadOnly}
                                          onChange={(event) =>
                                            setMetadata(
                                              metadata.map((current, currentIndex) =>
                                                currentIndex === itemIndex
                                                  ? { ...current, description: event.target.value }
                                                  : current,
                                              ),
                                            )
                                          }
                                        />
                                      </label>
                                    </div>
                                    <div className="mt-4 grid gap-4 md:grid-cols-2">
                                      <div>
                                        <div className="mb-2 text-12 text-[var(--text-secondary)]">
                                          {t('meka.disciplines')}
                                        </div>
                                        <VocabEditor
                                          values={item.disciplines}
                                          disabled={selectionReadOnly}
                                          placeholder={t('meka.vocabAddPlaceholder')}
                                          onChange={(disciplines) =>
                                            setMetadata(
                                              metadata.map((current, currentIndex) =>
                                                currentIndex === itemIndex
                                                  ? { ...current, disciplines }
                                                  : current,
                                              ),
                                            )
                                          }
                                        />
                                      </div>
                                      <div>
                                        <div className="mb-2 text-12 text-[var(--text-secondary)]">
                                          {t('meka.domains')}
                                        </div>
                                        <VocabEditor
                                          values={item.domains}
                                          disabled={selectionReadOnly}
                                          placeholder={t('meka.vocabAddPlaceholder')}
                                          onChange={(domains) =>
                                            setMetadata(
                                              metadata.map((current, currentIndex) =>
                                                currentIndex === itemIndex
                                                  ? { ...current, domains }
                                                  : current,
                                              ),
                                            )
                                          }
                                        />
                                      </div>
                                    </div>
                                    <label className={cn(fieldLabelClass, 'mt-4')}>
                                      <span>{t('meka.notes')}</span>
                                      <textarea
                                        className={textAreaClass}
                                        value={item.notes ?? ''}
                                        disabled={selectionReadOnly}
                                        onChange={(event) =>
                                          setMetadata(
                                            metadata.map((current, currentIndex) =>
                                              currentIndex === itemIndex
                                                ? { ...current, notes: event.target.value }
                                                : current,
                                            ),
                                          )
                                        }
                                      />
                                    </label>
                                  </div>
                                </details>
                              );
                            })}
                          </div>
                        ) : (
                          <p className="text-12 text-[var(--text-tertiary)]">
                            {t('meka.metadataTypeEmpty')}
                          </p>
                        )}
                      </section>
                    );
                  })}
                </div>
              </section>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-13 text-[var(--text-tertiary)]">
              {t('meka.loading')}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
