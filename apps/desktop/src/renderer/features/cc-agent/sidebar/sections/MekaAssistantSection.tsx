import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  BriefcaseBusiness,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  MessageSquare,
  SquarePen,
  Workflow,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Tip } from '@/components/ui/tooltip';
import type { Session } from '@/lib/ccAgent.types';
import { listMekaProjects } from '@/ipc/mekaProjects';
import { onMekaProjectsRolesChanged } from '@/lib/mekaProjectsRolesBus';
import { cn } from '@/lib/utils';
import type { MekaProject } from '../../../../../shared/meka-projects';
import type {
  AutomationScheduleAction,
  AutomationScheduleSessionInfo,
  AutomationSessionGroup,
} from '../../lib/automationSidebarGrouping';
import { sessionActivityMs } from '../../lib/dateSessionGrouping';
import { getDialogueCollapseLimit } from '../../lib/sidebarCollapseConfig';
import { SectionCollapse } from '../SectionCollapse';
import { SessionEntryList } from '../SessionEntryList';
import type { SessionClickHandler } from '../SessionItem';

const HEADER_HOVER_ACTION_CLASS = cn(
  'pointer-events-none opacity-0 transition-opacity duration-150',
  'group-hover/sidebar-header:pointer-events-auto group-hover/sidebar-header:opacity-100',
  'has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100',
);

function MekaTreeAction({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Tip text={label}>
      <button
        type="button"
        aria-label={label}
        onClick={(event) => {
          event.stopPropagation();
          onClick();
        }}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        className={cn(
          'flex size-5 shrink-0 items-center justify-center rounded-md',
          'text-sidebar-action-icon hover:text-foreground',
          'hover:bg-sidebar-item-hover focus:outline-none',
        )}
      >
        <SquarePen size={14} strokeWidth={2} />
      </button>
    </Tip>
  );
}

function MekaSessionSubgroup({
  label,
  createLabel,
  icon,
  collapsed,
  onToggle,
  onCreate,
  children,
}: {
  label: string;
  createLabel: string;
  icon: ReactNode;
  collapsed: boolean;
  onToggle: () => void;
  onCreate: () => void;
  children: ReactNode;
}) {
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    <div className="relative flex w-full flex-col select-none">
      <div
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          onToggle();
        }}
        className={cn(
          'group flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-full pl-[22px] pr-1',
          'text-sm font-normal text-[var(--sidebar-list-muted)] transition-colors',
          'hover:bg-sidebar-item-hover',
        )}
      >
        {icon}
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate">{label}</span>
          <Chevron
            size={13}
            strokeWidth={2}
            aria-hidden="true"
            className="shrink-0 text-[var(--cmd-palette-item-meta)] opacity-0 transition-opacity duration-[120ms] group-hover:opacity-100"
          />
        </div>
        <div className="pointer-events-none flex shrink-0 items-center opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100">
          <MekaTreeAction label={createLabel} onClick={onCreate} />
        </div>
      </div>
      <SectionCollapse collapsed={collapsed}>{children}</SectionCollapse>
    </div>
  );
}

export interface MekaProjectSessionGroup {
  projectId: string | null;
  project: MekaProject | null;
  formalWorkflowActive: boolean;
  formalSessions: Session[];
  regularSessions: Session[];
}

export function buildMekaProjectSessionGroups(
  projects: readonly MekaProject[],
  sessions: readonly Session[],
): MekaProjectSessionGroup[] {
  const sessionsByProject = new Map<string, Session[]>();
  for (const session of sessions) {
    const key = session.mekaProjectId ?? '';
    const group = sessionsByProject.get(key);
    if (group) group.push(session);
    else sessionsByProject.set(key, [session]);
  }

  const projectById = new Map(projects.map((project) => [project.id, project]));
  const orderedKeys = [
    ...projects.map((project) => project.id),
    ...[...sessionsByProject.keys()].filter((id) => !projectById.has(id)),
  ];
  return orderedKeys.map((projectId) => {
    const project = projectById.get(projectId) ?? null;
    const projectSessions = (sessionsByProject.get(projectId) ?? []).slice().sort((a, b) => {
      const pinRank = Number(b.pinnedAt != null) - Number(a.pinnedAt != null);
      return pinRank || sessionActivityMs(b) - sessionActivityMs(a) || a.id.localeCompare(b.id);
    });
    const formalWorkflowActive =
      project?.formalWorkflowEnabled === true &&
      ((project.workflowType === 'jira' && Boolean(project.jiraProjectKey?.trim())) ||
        (project.workflowType === 'gitlab' && Boolean(project.gitlabProjectUrl?.trim())));
    return {
      projectId: projectId || null,
      project,
      formalWorkflowActive,
      formalSessions: formalWorkflowActive
        ? projectSessions.filter((session) => session.isFormal === true)
        : [],
      regularSessions: formalWorkflowActive
        ? projectSessions.filter((session) => session.isFormal !== true)
        : projectSessions,
    };
  });
}

interface MekaAssistantSectionProps {
  sessions: Session[];
  activeSessionId?: string;
  runningSessionIds: ReadonlySet<string>;
  attachedSessionIds: ReadonlySet<string>;
  notifications: ReadonlySet<string>;
  scheduleSessionIndex: ReadonlyMap<string, AutomationScheduleSessionInfo>;
  selectedSessionIds?: ReadonlySet<string>;
  onSessionClick: SessionClickHandler;
  onAction: (id: string, action: 'delete' | 'archive' | 'archive-now' | 'unarchive') => void;
  onRename: (id: string, title: string) => void;
  onTogglePin: (id: string, currentlyPinned: boolean) => void;
  onScheduleAction: (group: AutomationSessionGroup, action: AutomationScheduleAction) => void;
  onCreateRegular: (projectId: string) => void;
  onCreateFormal: (project: MekaProject) => void;
  onManage: () => void;
}

export function MekaAssistantSection({
  sessions,
  activeSessionId,
  runningSessionIds,
  attachedSessionIds,
  notifications,
  scheduleSessionIndex,
  selectedSessionIds,
  onSessionClick,
  onAction,
  onRename,
  onTogglePin,
  onScheduleAction,
  onCreateRegular,
  onCreateFormal,
  onManage,
}: MekaAssistantSectionProps) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(false);
  const [collapsedProjects, setCollapsedProjects] = useState<ReadonlySet<string>>(new Set());
  const [collapsedFormalGroups, setCollapsedFormalGroups] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [collapsedRegularGroups, setCollapsedRegularGroups] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [projects, setProjects] = useState<readonly MekaProject[]>([]);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void listMekaProjects()
        .then((next) => {
          if (!cancelled) setProjects(next);
        })
        .catch(() => {
          // Session rows remain available under their frozen project ids.
        });
    };
    refresh();
    const unsubscribe = onMekaProjectsRolesChanged(refresh);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const groups = useMemo(
    () => buildMekaProjectSessionGroups(projects, sessions),
    [projects, sessions],
  );
  const ToggleIcon = collapsed ? ChevronRight : ChevronDown;

  const renderSessions = (entries: Session[], sectionCollapsed: boolean, nested = false) => (
    <div className={cn(nested && 'pl-3')}>
      <SessionEntryList
        sessions={entries}
        activeSessionId={activeSessionId}
        runningSessionIds={runningSessionIds}
        attachedSessionIds={attachedSessionIds}
        notifications={notifications}
        scheduleSessionIndex={scheduleSessionIndex}
        selectedSessionIds={selectedSessionIds}
        onSessionClick={onSessionClick}
        onAction={onAction}
        onRename={onRename}
        onTogglePin={onTogglePin}
        onScheduleAction={onScheduleAction}
        collapsible
        collapseLimit={getDialogueCollapseLimit()}
        sectionCollapsed={sectionCollapsed}
        indented
      />
    </div>
  );

  return (
    <div className="flex w-full flex-col gap-0.5">
      <div className="group/sidebar-header flex h-6 items-center justify-between pr-0 pl-6">
        <div className="flex min-w-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setCollapsed((value) => !value)}
            aria-expanded={!collapsed}
            className="text-sm font-medium text-[var(--sidebar-list-muted)] transition-colors hover:text-[var(--sidebar-nav-text)]"
          >
            {t('meka.sessionListTitle')}
          </button>
          <div className={HEADER_HOVER_ACTION_CLASS}>
            <Tip
              text={t(collapsed ? 'meka.expandSessions' : 'meka.collapseSessions')}
              side="bottom"
            >
              <button
                type="button"
                onClick={() => setCollapsed((value) => !value)}
                aria-label={t(collapsed ? 'meka.expandSessions' : 'meka.collapseSessions')}
                aria-expanded={!collapsed}
                className={cn(
                  'flex size-5 shrink-0 items-center justify-center rounded-md',
                  'text-[var(--sidebar-list-muted)] transition-colors',
                  'hover:text-[var(--sidebar-nav-text)]',
                )}
              >
                <ToggleIcon size={13} strokeWidth={2} />
              </button>
            </Tip>
          </div>
        </div>
        <div className={cn('flex -mt-px items-center gap-0.5', HEADER_HOVER_ACTION_CLASS)}>
          <Tip text={t('meka.openManagement')} side="bottom">
            <button
              type="button"
              onClick={onManage}
              aria-label={t('meka.openManagement')}
              className="flex size-7 items-center justify-center rounded-md text-[var(--sidebar-list-muted)] transition-colors hover:text-[var(--sidebar-nav-text)]"
            >
              <BriefcaseBusiness size={14} strokeWidth={2} />
            </button>
          </Tip>
        </div>
      </div>

      <SectionCollapse collapsed={collapsed}>
        <div className="flex flex-col gap-1 pt-1 pr-0 pl-3">
          {groups.map((group) => {
            const key = group.projectId ?? '__legacy__';
            const projectCollapsed = collapsedProjects.has(key);
            const formalGroupCollapsed = collapsedFormalGroups.has(key);
            const regularGroupCollapsed = collapsedRegularGroups.has(key);
            const FolderIcon = projectCollapsed ? Folder : FolderOpen;
            const ProjectToggleIcon = projectCollapsed ? ChevronRight : ChevronDown;
            const toggleProject = () => {
              setCollapsedProjects((current) => {
                const next = new Set(current);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                return next;
              });
            };
            const toggleFormalGroup = () => {
              setCollapsedFormalGroups((current) => {
                const next = new Set(current);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                return next;
              });
            };
            const toggleRegularGroup = () => {
              setCollapsedRegularGroups((current) => {
                const next = new Set(current);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                return next;
              });
            };
            const projectName =
              group.project?.displayName ??
              (group.projectId ? t('meka.unavailableProject') : t('meka.legacySessions'));
            const projectId = group.project?.id;
            return (
              <div key={key} className="relative flex w-full flex-col select-none">
                <div
                  role="button"
                  tabIndex={0}
                  aria-expanded={!projectCollapsed}
                  onClick={toggleProject}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    toggleProject();
                  }}
                  className={cn(
                    'group flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-full pl-3 pr-1',
                    'text-sm font-normal text-[var(--sidebar-list-muted)] transition-colors',
                    'hover:bg-sidebar-item-hover',
                  )}
                >
                  <FolderIcon
                    size={15}
                    strokeWidth={1.8}
                    className="shrink-0 text-[var(--sidebar-list-muted)]"
                    aria-hidden="true"
                  />
                  <div className="flex min-w-0 flex-1 items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate">{projectName}</span>
                    <ProjectToggleIcon
                      size={13}
                      strokeWidth={2}
                      aria-hidden="true"
                      className="shrink-0 text-[var(--cmd-palette-item-meta)] opacity-0 transition-opacity duration-[120ms] group-hover:opacity-100"
                    />
                  </div>
                  {projectId && !group.formalWorkflowActive ? (
                    <div className="pointer-events-none flex shrink-0 items-center opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100">
                      <MekaTreeAction
                        label={t('meka.newSessionForProject', { project: projectName })}
                        onClick={() => onCreateRegular(projectId)}
                      />
                    </div>
                  ) : null}
                </div>
                <SectionCollapse collapsed={projectCollapsed}>
                  <div className="flex flex-col gap-0.5 pt-0.5 pb-1.5 px-0">
                    {group.formalWorkflowActive ? (
                      <>
                        <MekaSessionSubgroup
                          label={t('meka.formalSessions')}
                          createLabel={t('meka.newFormalSessionForProject', {
                            project: projectName,
                          })}
                          icon={
                            <Workflow
                              size={15}
                              strokeWidth={1.8}
                              className="shrink-0 text-[var(--sidebar-list-muted)]"
                              aria-hidden="true"
                            />
                          }
                          collapsed={formalGroupCollapsed}
                          onToggle={toggleFormalGroup}
                          onCreate={() => {
                            if (group.project) onCreateFormal(group.project);
                          }}
                        >
                          {renderSessions(
                            group.formalSessions,
                            projectCollapsed || formalGroupCollapsed,
                            true,
                          )}
                        </MekaSessionSubgroup>
                        <MekaSessionSubgroup
                          label={t('meka.regularSessions')}
                          createLabel={t('meka.newRegularSessionForProject', {
                            project: projectName,
                          })}
                          icon={
                            <MessageSquare
                              size={15}
                              strokeWidth={1.8}
                              className="shrink-0 text-[var(--sidebar-list-muted)]"
                              aria-hidden="true"
                            />
                          }
                          collapsed={regularGroupCollapsed}
                          onToggle={toggleRegularGroup}
                          onCreate={() => {
                            if (projectId) onCreateRegular(projectId);
                          }}
                        >
                          {renderSessions(
                            group.regularSessions,
                            projectCollapsed || regularGroupCollapsed,
                            true,
                          )}
                        </MekaSessionSubgroup>
                      </>
                    ) : (
                      renderSessions(group.regularSessions, projectCollapsed)
                    )}
                    {!group.formalWorkflowActive && group.regularSessions.length === 0 ? (
                      <div className="flex h-7 items-center pl-[22px] text-xs text-[var(--sidebar-list-muted)]">
                        {t('meka.noSessions')}
                      </div>
                    ) : null}
                  </div>
                </SectionCollapse>
              </div>
            );
          })}
          {groups.length === 0 && (
            <div className="flex min-h-7 items-center rounded-lg px-3 text-xs text-[var(--sidebar-list-muted)]">
              {t('meka.noSessions')}
            </div>
          )}
        </div>
      </SectionCollapse>
    </div>
  );
}
