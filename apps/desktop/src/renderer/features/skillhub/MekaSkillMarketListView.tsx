import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ChevronDown, Search } from 'lucide-react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { WINDOW_DRAG_STYLE, WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import type { MekaSkillMarketItem } from '../../../shared/mekaSkillMarket';
import { MarketCard } from './components/MarketCard';
import { InstallTargetPicker, type SkillInstallRequest } from './components/InstallTargetPicker';
import { MekaSkillManagementDialog } from './components/MekaSkillManagementDialog';
import type { MarketSkill, SortBy, Visibility } from './hooks/useMarketList';
import { refresh as refreshSkillhub } from './hooks/useSkillhub';
import { mapMekaSkillToMarketSkill } from './lib/mekaSkillMarketViewModel';
import { SkillhubMarketPreviewPanel } from './SkillhubMarketPreviewPanel';
import { SKILLHUB_MARKET_SORT_OPTIONS, SkillhubMarketFilterChip } from './SkillhubMarketListView';

function includesQuery(skill: MarketSkill, query: string): boolean {
  if (!query) return true;
  return [skill.name, skill.displayName, skill.description, skill.authorName].some((value) =>
    value.toLocaleLowerCase().includes(query),
  );
}

/** Cindy Skill Hub market surface backed exclusively by MCPRouter Meka Skills. */
export function MekaSkillMarketListView() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [items, setItems] = useState<MekaSkillMarketItem[]>([]);
  const [configured, setConfigured] = useState(true);
  const [unavailableReason, setUnavailableReason] = useState<'registry-not-supported' | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<SortBy>('updated_at');
  const [visibility, setVisibility] = useState<Visibility>('available');
  const [previewSkill, setPreviewSkill] = useState<MarketSkill | null>(null);
  const [pickerSkill, setPickerSkill] = useState<MarketSkill | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [managementSkill, setManagementSkill] = useState<MekaSkillMarketItem | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const snapshot = await window.electronAPI.mekaSkills.snapshot();
      setConfigured(snapshot.configured);
      setUnavailableReason(snapshot.unavailableReason ?? null);
      setItems(snapshot.items);
    } catch {
      setConfigured(false);
      setUnavailableReason(null);
      setItems([]);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const itemBySlug = useMemo(() => new Map(items.map((item) => [item.slug, item])), [items]);
  const marketItems = useMemo(
    () => items.map((item) => mapMekaSkillToMarketSkill(item, t)),
    [items, t],
  );
  const visibleItems = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase();
    const filtered = marketItems.filter((skill) => {
      if (!includesQuery(skill, query)) return false;
      if (visibility === 'available') return skill.cardState === 'not-installed';
      if (visibility === 'mine') return skill.isMine;
      return true;
    });
    return [...filtered].sort((left, right) => {
      const byPublishedAt = Date.parse(right.publishedAt) - Date.parse(left.publishedAt);
      if (sortBy === 'downloads' && right.downloads !== left.downloads) {
        return right.downloads - left.downloads;
      }
      return byPublishedAt || left.name.localeCompare(right.name);
    });
  }, [marketItems, searchQuery, sortBy, visibility]);

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
      return { success: true, files: await window.electronAPI.mekaSkills.files(item.id) };
    },
    [itemBySlug, t],
  );
  const readFile = useCallback(
    async (skill: MarketSkill, path: string) => {
      const item = itemBySlug.get(skill.name);
      if (!item) return { success: false, error: t('mekaSkills.loadFailed') };
      const file = await window.electronAPI.mekaSkills.file(item.id, path);
      return { success: true, file: { ...file, content: file.content ?? '' } };
    },
    [itemBySlug, t],
  );
  const manageSkill = useCallback(
    (skill: MarketSkill) => {
      const item = itemBySlug.get(skill.name);
      if (item?.access !== 'owner') return;
      setPreviewSkill(null);
      setManagementSkill(item);
    },
    [itemBySlug],
  );
  const sortLabel = useMemo(
    () =>
      t(
        SKILLHUB_MARKET_SORT_OPTIONS.find((option) => option.value === sortBy)?.labelKey ??
          'skillhub.market.sortLatest',
      ),
    [sortBy, t],
  );

  const unavailableTitle = t(
    unavailableReason === 'registry-not-supported'
      ? 'mekaSkills.serverUpgradeRequired'
      : 'mekaSkills.unavailable',
  );

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-[hsl(var(--content-area))]">
      <div
        className="flex items-center justify-between bg-[hsl(var(--content-area))]"
        style={{
          height: '56px',
          padding: '0 24px',
          gap: '12px',
          ...(previewSkill ? WINDOW_NO_DRAG_STYLE : WINDOW_DRAG_STYLE),
        }}
      >
        <button
          type="button"
          onClick={() => navigate('/cc-agent/meka/skills')}
          aria-label={t('skillhub.sidebar.backToLocal')}
          title={t('skillhub.sidebar.backToLocal')}
          className="flex size-9 shrink-0 items-center justify-center rounded-full text-[var(--msg-assistant-text)] transition-colors hover:bg-sidebar-item-hover"
          style={WINDOW_NO_DRAG_STYLE}
        >
          <ArrowLeft size={18} />
        </button>

        <div
          className="flex shrink-0 items-center rounded-full border border-[var(--chat-input-border)] bg-[var(--chat-input-bg)]"
          style={{
            width: '200px',
            height: '36px',
            padding: '0 12px',
            gap: '8px',
            ...WINDOW_NO_DRAG_STYLE,
          }}
        >
          <Search size={14} className="shrink-0 text-[var(--chat-input-placeholder)]" />
          <input
            type="text"
            placeholder={t('skillhub.market.searchPlaceholder')}
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            className="min-w-0 flex-1 border-0 bg-transparent text-[var(--settings-input-text)] outline-none placeholder:text-[var(--settings-input-placeholder)]"
            style={{ fontSize: '13px' }}
          />
        </div>

        <div className="flex items-center" style={{ gap: '8px', ...WINDOW_NO_DRAG_STYLE }}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex items-center rounded-full border border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)]"
                style={{ height: '32px', padding: '0 12px', gap: '6px' }}
              >
                <span className="text-[var(--msg-assistant-text)]" style={{ fontSize: '12px' }}>
                  {sortLabel}
                </span>
                <ChevronDown size={12} className="text-[var(--settings-theme-icon)]" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              sideOffset={4}
              className="w-32 overflow-hidden rounded-xl border border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)] p-1 shadow-[var(--shadow-menu)]"
            >
              {SKILLHUB_MARKET_SORT_OPTIONS.map((option) => (
                <DropdownMenuItem
                  key={option.value}
                  onSelect={() => setSortBy(option.value)}
                  className="h-8 rounded-md px-3 text-sm text-[var(--msg-assistant-text)] focus:bg-[var(--cmd-palette-item-hover)]"
                >
                  {t(option.labelKey)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <SkillhubMarketFilterChip
            active={visibility === 'available'}
            label={t('skillhub.market.chipAvailable')}
            onClick={() => setVisibility('available')}
          />
          <SkillhubMarketFilterChip
            active={visibility === 'all'}
            label={t('skillhub.market.chipAll')}
            onClick={() => setVisibility('all')}
          />
          <SkillhubMarketFilterChip
            active={visibility === 'mine'}
            label={t('skillhub.market.chipMine')}
            onClick={() => setVisibility('mine')}
          />
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {loadError ? (
          <MarketState
            text={t('skillhub.market.loadFailed', { error: t('mekaSkills.loadFailed') })}
          />
        ) : !configured ? (
          <MarketState text={unavailableTitle} />
        ) : loading ? (
          <MarketState text={t('skillhub.market.loading')} />
        ) : visibleItems.length === 0 ? (
          <MarketState text={t('skillhub.market.noResults')} />
        ) : (
          <div className="grid grid-cols-3 gap-4" style={{ padding: '16px 24px 24px' }}>
            {visibleItems.map((skill) => (
              <MarketCard
                key={skill.name}
                skill={skill}
                primaryAction={
                  skill.isMine ? 'manage' : skill.cardState === 'not-installed' ? 'clone' : 'none'
                }
                allowPrivateVisibilityLabel={visibility === 'mine'}
                onClone={(target) => {
                  setPickerSkill(target);
                  setPickerOpen(true);
                }}
                onManage={manageSkill}
                onClick={setPreviewSkill}
                selected={previewSkill?.name === skill.name}
              />
            ))}
          </div>
        )}
      </div>

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
      <SkillhubMarketPreviewPanel
        open={previewSkill !== null}
        skill={previewSkill}
        onClose={() => setPreviewSkill(null)}
        onClone={(target) => {
          setPickerSkill(target);
          setPickerOpen(true);
        }}
        onManage={manageSkill}
        loadFiles={loadFiles}
        readFile={readFile}
        allowLearn={false}
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
    </div>
  );
}

function MarketState({ text }: { text: string }) {
  return (
    <div className="flex h-full items-center justify-center px-6 text-center">
      <p className="text-sm text-[var(--cmd-palette-item-meta)]">{text}</p>
    </div>
  );
}
