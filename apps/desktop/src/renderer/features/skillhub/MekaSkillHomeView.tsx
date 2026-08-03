/**
 * Meka Skill home.
 *
 * This page deliberately uses the Cindy Skill home presentation and
 * interaction components. The only product boundary here is the remote
 * adapter: catalog, preview files and installation are served by MCPRouter.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, FolderCode, Plus, Sparkles, Store } from 'lucide-react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { NEW_MAKER_DRAFT_KEY } from '@/features/cc-agent/newMakerDraftKeys';

import {
  PLUGIN_MANAGEMENT_CARD_GRID_CLASS,
  PluginManagementLayout,
  PluginManagementPage,
} from '@/features/plugin/PluginManagementLayout';
import { cn } from '@/lib/utils';
import { plainTextToTiptapDoc, saveDraft as saveComposerDraft } from '@/lib/composerDraftStore';
import { toast } from '@/lib/toast';
import { patchDraft } from '@/state/newMakerDraft';

import type { MekaSkillMarketItem, MekaSkillPublishInfo } from '../../../shared/mekaSkillMarket';
import { InstallTargetPicker, type SkillInstallRequest } from './components/InstallTargetPicker';
import { MekaSkillManagementDialog } from './components/MekaSkillManagementDialog';
import { MekaSkillPublishDialog } from './components/MekaSkillPublishDialog';
import { LocalGroup, RecommendedSkillCard, SkillSectionHeading } from './SkillhubHomeView';
import { SkillhubMarketPreviewPanel } from './SkillhubMarketPreviewPanel';
import { basename } from './lib/pathDerivations';
import { type MarketSkill } from './hooks/useMarketList';
import { refresh as refreshSkillhub, useSkillhub } from './hooks/useSkillhub';
import { useSkillhubProjectBootstrap } from './hooks/useSkillhubProjectBootstrap';
import { mapMekaSkillToMarketSkill } from './lib/mekaSkillMarketViewModel';

const RECOMMENDED_LIMIT = 8;

function includesSkillQuery(values: ReadonlyArray<string | undefined>, query: string): boolean {
  if (!query) return true;
  return values.some((value) => value?.toLocaleLowerCase().includes(query));
}

export function MekaSkillHomeView() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  useSkillhubProjectBootstrap();
  const { skills, projects, bootstrapped, syncResults } = useSkillhub();
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const [items, setItems] = useState<MekaSkillMarketItem[]>([]);
  const [configured, setConfigured] = useState(true);
  const [unavailableReason, setUnavailableReason] = useState<'registry-not-supported' | null>(null);
  const [loading, setLoading] = useState(true);
  const [previewSkill, setPreviewSkill] = useState<MarketSkill | null>(null);
  const [pickerSkill, setPickerSkill] = useState<MarketSkill | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [managementSkill, setManagementSkill] = useState<MekaSkillMarketItem | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishInfo, setPublishInfo] = useState<MekaSkillPublishInfo | null>(null);
  const [pickingSource, setPickingSource] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const snapshot = await window.electronAPI.mekaSkills.snapshot();
      setConfigured(snapshot.configured);
      setUnavailableReason(snapshot.unavailableReason ?? null);
      setItems(snapshot.items);
    } catch {
      setConfigured(false);
      setUnavailableReason(null);
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const itemBySlug = useMemo(() => new Map(items.map((item) => [item.slug, item])), [items]);
  const marketItems = useMemo<MarketSkill[]>(
    () => items.map((item) => mapMekaSkillToMarketSkill(item, t)),
    [items, t],
  );
  const recommended = useMemo(
    () =>
      marketItems
        .filter(
          (skill) =>
            skill.cardState === 'not-installed' &&
            includesSkillQuery(
              [skill.displayName, skill.name, skill.description, skill.authorName],
              normalizedQuery,
            ),
        )
        .slice(0, RECOMMENDED_LIMIT),
    [marketItems, normalizedQuery],
  );

  const mekaLocalSkills = useMemo(
    () =>
      skills.filter(
        (skill) =>
          skill.kind === 'skill' &&
          skill.registryEntry?.origin === 'installed' &&
          skill.registryEntry?.distribution?.channel === 'meka',
      ),
    [skills],
  );
  const globalSkills = useMemo(
    () =>
      mekaLocalSkills.filter(
        (skill) =>
          skill.scope === 'global' &&
          includesSkillQuery(
            [skill.name, skill.description, skill.kind, skill.engine],
            normalizedQuery,
          ),
      ),
    [mekaLocalSkills, normalizedQuery],
  );
  const projectGroups = useMemo(() => {
    const byRoot = new Map<string, SkillhubSkill[]>();
    for (const skill of mekaLocalSkills) {
      if (skill.scope !== 'project' || !skill.projectRoot) continue;
      const existing = byRoot.get(skill.projectRoot);
      if (existing) existing.push(skill);
      else byRoot.set(skill.projectRoot, [skill]);
    }
    const nameByRoot = new Map(
      projects.map((project) => [project.projectRoot, project.displayName]),
    );
    return [...byRoot.entries()]
      .map(([root, groupSkills]) => {
        const label = nameByRoot.get(root) ?? basename(root);
        return {
          root,
          label,
          skills: groupSkills.filter((skill) =>
            includesSkillQuery(
              [skill.name, skill.description, skill.kind, skill.engine, label],
              normalizedQuery,
            ),
          ),
        };
      })
      .filter((group) => group.skills.length > 0);
  }, [mekaLocalSkills, normalizedQuery, projects]);
  const visibleLocalCount = useMemo(
    () =>
      globalSkills.length + projectGroups.reduce((count, group) => count + group.skills.length, 0),
    [globalSkills.length, projectGroups],
  );
  const hasSearchResults = recommended.length > 0 || visibleLocalCount > 0;

  const openLocal = useCallback(
    (skill: SkillhubSkill) => {
      const name = encodeURIComponent(skill.name);
      const base =
        skill.scope === 'global'
          ? `/skillhub/local/${skill.kind}/global/${name}`
          : `/skillhub/local/${skill.kind}/project/${skill.projectHash}/${name}`;
      navigate(`${base}?engine=${skill.engine}`, {
        state: { from: '/cc-agent/meka/skills', resetHistory: true },
      });
    },
    [navigate],
  );
  const handleClone = useCallback((skill: MarketSkill) => {
    setPickerSkill(skill);
    setPickerOpen(true);
  }, []);
  const manageSkill = useCallback(
    (skill: MarketSkill) => {
      const item = itemBySlug.get(skill.name);
      if (item?.access !== 'owner') return;
      setPreviewSkill(null);
      setManagementSkill(item);
    },
    [itemBySlug],
  );
  const createWithCindy = useCallback(() => {
    saveComposerDraft(NEW_MAKER_DRAFT_KEY, {
      text: plainTextToTiptapDoc(t('mekaSkills.createPrompt')),
      attachments: [],
      focusAtEnd: true,
    });
    patchDraft({
      workingDir: null,
      remoteHostId: null,
      deviceLinkDeviceId: null,
      deviceLinkDeviceName: null,
    });
    navigate('/cc-agent/new');
  }, [navigate, t]);
  const pickSource = useCallback(async () => {
    setPickingSource(true);
    try {
      const info = await window.electronAPI.mekaSkills.pickSource();
      if (info) setPublishInfo(info);
    } catch {
      toast.error(t('mekaSkills.sourceInvalid'));
    } finally {
      setPickingSource(false);
    }
  }, [t]);
  const installSkill = useCallback(
    async (request: SkillInstallRequest) => {
      const item = itemBySlug.get(request.name);
      if (!item) {
        return { success: false, message: t('mekaSkills.installUnavailable') };
      }
      return window.electronAPI.mekaSkills.install({
        skillId: item.id,
        expectedReleaseId: item.currentRelease.id,
        ...(request.installPath ? { installPath: request.installPath } : {}),
        ...(request.force ? { force: true } : {}),
      });
    },
    [itemBySlug, t],
  );
  const loadFiles = useCallback(
    async (skill: MarketSkill) => {
      const item = itemBySlug.get(skill.name);
      if (!item) return { success: false, error: t('mekaSkills.loadFailed') };
      return {
        success: true,
        files: await window.electronAPI.mekaSkills.files(item.id),
      };
    },
    [itemBySlug, t],
  );
  const readFile = useCallback(
    async (skill: MarketSkill, path: string) => {
      const item = itemBySlug.get(skill.name);
      if (!item) return { success: false, error: t('mekaSkills.loadFailed') };
      const file = await window.electronAPI.mekaSkills.file(item.id, path);
      return {
        success: true,
        file: { ...file, content: file.content ?? '' },
      };
    },
    [itemBySlug, t],
  );

  return (
    <PluginManagementLayout
      activeTab="meka-skills"
      query={query}
      onQueryChange={setQuery}
      searchPlaceholder={t('skillhub.home.search')}
      clearSearchLabel={t('skillhub.home.clearSearch')}
      headerActions={
        <MekaSkillActions onCreate={createWithCindy} onPublish={() => setPublishOpen(true)} />
      }
    >
      <main className="relative h-full w-full overflow-x-hidden overflow-y-auto bg-[var(--surface)] [scrollbar-gutter:stable_both-edges]">
        <PluginManagementPage className="gap-10">
          <header className="plugin-motion-page-header flex items-start justify-between gap-4">
            <div className="min-w-0 pt-1">
              <h1 className="text-28 font-medium leading-tight text-[var(--text-primary)]">
                {t('skillhub.home.title')}
              </h1>
              <p className="mt-2 max-w-2xl text-14 leading-6 text-[var(--text-secondary)]">
                {t('mekaSkills.description')}
              </p>
            </div>
          </header>

          {!normalizedQuery ? (
            <button
              type="button"
              onClick={() =>
                navigate('/cc-agent/meka/skills/market', {
                  state: { freshEntry: true },
                })
              }
              className={cn(
                'plugin-motion-page-section',
                'group flex items-center gap-4 rounded-[12px] border-[0.5px] border-[var(--border-default)]',
                'bg-[var(--surface-elevated)] px-5 py-4 text-left shadow-[var(--plugin-card-shadow)]',
                'transition-[background-color,border-color,transform] duration-150 ease-out',
                'hover:-translate-y-0.5 hover:border-[var(--text-tertiary)]',
                'active:translate-y-0 active:scale-[0.992]',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
              )}
            >
              <span className="flex size-10 shrink-0 items-center justify-center rounded-[22%] border-[0.5px] border-[var(--border-default)] bg-[var(--surface-elevated)] shadow-[var(--plugin-card-shadow)]">
                <Store size={20} className="text-[var(--msg-assistant-text)]" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-[var(--msg-assistant-text)]">
                  {t('skillhub.home.browseTitle')}
                </span>
                <span className="block text-xs text-[var(--cmd-palette-item-meta)]">
                  {t('mekaSkills.browseDescription')}
                </span>
              </span>
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-[var(--border-default)] text-[var(--text-secondary)] transition-[background-color,color,transform] group-hover:translate-x-0.5 group-hover:bg-[var(--surface-chip)] group-hover:text-[var(--text-primary)] group-active:translate-x-0 group-active:scale-95">
                <ChevronRight size={16} strokeWidth={1.8} />
              </span>
            </button>
          ) : null}

          {!normalizedQuery || recommended.length > 0 || loading || !configured ? (
            <section className="plugin-motion-page-section min-w-0">
              <SkillSectionHeading
                title={t('skillhub.home.recommended')}
                count={recommended.length}
              />
              {!configured ? (
                <CatalogState
                  title={t(
                    unavailableReason === 'registry-not-supported'
                      ? 'mekaSkills.serverUpgradeRequired'
                      : 'mekaSkills.unavailable',
                  )}
                  description={t(
                    unavailableReason === 'registry-not-supported'
                      ? 'mekaSkills.serverUpgradeRequiredDescription'
                      : 'mekaSkills.unavailableDescription',
                  )}
                />
              ) : loading && recommended.length === 0 ? (
                <div className={PLUGIN_MANAGEMENT_CARD_GRID_CLASS} aria-hidden>
                  {Array.from({ length: RECOMMENDED_LIMIT }).map((_, index) => (
                    <div
                      key={index}
                      className="flex h-[100px] flex-col gap-2 rounded-[12px] border-[0.5px] border-[var(--border-default)] bg-[var(--surface-elevated)] p-3 shadow-[var(--plugin-card-shadow)]"
                    >
                      <div className="h-3.5 w-2/3 animate-pulse rounded bg-[var(--cmd-palette-item-hover)] opacity-60" />
                      <div className="h-3 w-full animate-pulse rounded bg-[var(--cmd-palette-item-hover)] opacity-40" />
                      <div className="h-3 w-4/5 animate-pulse rounded bg-[var(--cmd-palette-item-hover)] opacity-40" />
                      <div className="mt-auto h-3 w-1/3 animate-pulse rounded bg-[var(--cmd-palette-item-hover)] opacity-40" />
                    </div>
                  ))}
                </div>
              ) : recommended.length === 0 ? (
                <CatalogState title={t('skillhub.home.recommendedEmpty')} />
              ) : (
                <div className={cn('plugin-motion-stagger', PLUGIN_MANAGEMENT_CARD_GRID_CLASS)}>
                  {recommended.map((skill) => (
                    <RecommendedSkillCard key={skill.name} skill={skill} onOpen={setPreviewSkill} />
                  ))}
                </div>
              )}
            </section>
          ) : null}

          {!normalizedQuery || visibleLocalCount > 0 ? (
            <section className="plugin-motion-page-section min-w-0">
              <SkillSectionHeading title={t('skillhub.home.local')} count={visibleLocalCount} />
              {visibleLocalCount === 0 ? (
                <CatalogState
                  title={
                    bootstrapped ? t('skillhub.home.localEmpty') : t('skillhub.welcome.scanning')
                  }
                />
              ) : (
                <div className="flex flex-col gap-6">
                  {globalSkills.length > 0 ? (
                    <LocalGroup
                      label={t('skillhub.home.globalScope')}
                      skills={globalSkills}
                      syncResults={syncResults}
                      onOpen={openLocal}
                      sourceLabel={(skill, source) =>
                        skill.registryEntry?.distribution?.channel === 'meka'
                          ? t('mekaSkills.sourceMeka')
                          : t(
                              source === 'skillhub'
                                ? 'skillhub.home.sourceSkillhub'
                                : 'skillhub.home.sourceLocal',
                            )
                      }
                    />
                  ) : null}
                  {projectGroups.map((group) => (
                    <LocalGroup
                      key={group.root}
                      label={group.label}
                      skills={group.skills}
                      syncResults={syncResults}
                      onOpen={openLocal}
                      sourceLabel={(skill, source) =>
                        skill.registryEntry?.distribution?.channel === 'meka'
                          ? t('mekaSkills.sourceMeka')
                          : t(
                              source === 'skillhub'
                                ? 'skillhub.home.sourceSkillhub'
                                : 'skillhub.home.sourceLocal',
                            )
                      }
                    />
                  ))}
                </div>
              )}
            </section>
          ) : null}

          {normalizedQuery && !loading && !hasSearchResults ? (
            <div className="plugin-motion-page-section rounded-[12px] border-[0.5px] border-[var(--border-default)] px-4 py-8 text-center text-13 leading-5 text-[var(--text-secondary)]">
              {t('skillhub.home.noSearchResults')}
            </div>
          ) : null}
        </PluginManagementPage>

        <SkillhubMarketPreviewPanel
          open={previewSkill !== null}
          skill={previewSkill}
          onClose={() => setPreviewSkill(null)}
          onClone={handleClone}
          onManage={manageSkill}
          loadFiles={loadFiles}
          readFile={readFile}
          allowLearn={false}
        />
        <InstallTargetPicker
          open={pickerOpen}
          skill={pickerSkill}
          onClose={() => setPickerOpen(false)}
          installSkill={installSkill}
          onInstallComplete={() => {
            void refreshSkillhub();
            void reload();
            setPickerOpen(false);
            setPreviewSkill(null);
          }}
        />
        <MekaSkillManagementDialog
          open={managementSkill !== null}
          skill={managementSkill}
          onOpenChange={(open) => {
            if (!open) setManagementSkill(null);
          }}
          onChanged={reload}
          onDeleted={async () => {
            setPreviewSkill(null);
            await reload();
          }}
        />
        <MekaSkillPublishDialog
          open={publishOpen}
          info={publishInfo}
          selectingSource={pickingSource}
          onSelectSource={pickSource}
          onOpenChange={(open) => {
            setPublishOpen(open);
            if (!open) setPublishInfo(null);
          }}
          onPublished={async () => {
            setPublishOpen(false);
            setPublishInfo(null);
            await reload();
          }}
        />
      </main>
    </PluginManagementLayout>
  );
}

function MekaSkillActions({
  onCreate,
  onPublish,
}: {
  onCreate: () => void;
  onPublish: () => void;
}) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            'plugin-management-action-trigger group inline-flex h-9 shrink-0 items-center gap-2 rounded-full border border-[var(--border-default)]',
            'bg-[var(--surface-elevated)] px-3.5 text-12 font-medium text-[var(--text-primary)] shadow-[var(--plugin-card-shadow)]',
            'transition-[background-color,border-color,transform] duration-150 ease-out',
            'hover:border-[var(--text-tertiary)] hover:bg-[var(--surface-hover-soft)] active:scale-[0.98]',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
            'data-[state=open]:border-[var(--text-tertiary)] data-[state=open]:bg-[var(--surface-chip)]',
          )}
          aria-label={t('mekaSkills.add')}
        >
          <Plus size={14} strokeWidth={1.8} aria-hidden="true" />
          <span className="plugin-management-action-label">{t('mekaSkills.add')}</span>
          <ChevronDown
            size={13}
            strokeWidth={1.75}
            className="plugin-management-action-chevron transition-transform duration-150 group-data-[state=open]:rotate-180 motion-reduce:transition-none"
            aria-hidden="true"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={8}
        className="w-56 rounded-[12px] border-[0.5px] border-[var(--border-default)] bg-[var(--surface-elevated)] p-1.5 text-[var(--text-primary)] shadow-[var(--shadow-menu)]"
      >
        <DropdownMenuItem
          onSelect={onCreate}
          className="h-10 gap-3 rounded-lg px-3 text-13 focus:bg-[var(--surface-hover-soft)] focus:text-[var(--text-primary)]"
        >
          <Sparkles
            size={16}
            strokeWidth={1.7}
            className="text-[var(--text-secondary)]"
            aria-hidden="true"
          />
          {t('mekaSkills.create')}
        </DropdownMenuItem>
        <DropdownMenuSeparator className="mx-2 my-1 h-px bg-[var(--border-default)]" />
        <DropdownMenuItem
          onSelect={onPublish}
          className="h-10 gap-3 rounded-lg px-3 text-13 focus:bg-[var(--surface-hover-soft)] focus:text-[var(--text-primary)]"
        >
          <FolderCode
            size={16}
            strokeWidth={1.7}
            className="text-[var(--text-secondary)]"
            aria-hidden="true"
          />
          {t('mekaSkills.publish')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CatalogState({ title, description }: { title: string; description?: string }) {
  return (
    <div className="rounded-[12px] border-[0.5px] border-[var(--border-default)] px-4 py-5 text-13 leading-5 text-[var(--text-secondary)]">
      <p>{title}</p>
      {description ? (
        <p className="mt-1 text-12 text-[var(--text-tertiary)]">{description}</p>
      ) : null}
    </div>
  );
}
