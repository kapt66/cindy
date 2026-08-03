import { useEffect, useMemo } from 'react';

import { useAuth } from '@/contexts/AuthContext';
import { groupSessions } from '@/features/cc-agent/lib/projectGrouping';
import { useCCSessions } from '@/hooks/useCCSessions';

import {
  bootstrapSkillhub,
  setSkillhubDataOwner,
  syncProjects,
  type SkillhubProject,
} from './useSkillhub';
import { projectHash } from '../lib/projectHash';

/**
 * Keeps the shared local Skill store on the current data owner and project set.
 * Both the upstream Skill routes and the Meka Skill route use this hook so the
 * local section has identical scan and grouping semantics.
 */
export function useSkillhubProjectBootstrap(): void {
  const { dataOwnerId } = useAuth();
  const { sessions, isLoading: sessionsLoading } = useCCSessions();
  const projects = useMemo<SkillhubProject[] | null>(() => {
    if (sessionsLoading) return null;
    return groupSessions(sessions).projects.map((project) => ({
      projectRoot: project.workingDir,
      hash: projectHash(project.workingDir),
      displayName: project.displayName,
    }));
  }, [sessions, sessionsLoading]);

  useEffect(() => {
    setSkillhubDataOwner(dataOwnerId);
    if (dataOwnerId === null || projects === null) return;
    syncProjects(projects);
    // The session hook starts with a transient empty list on every remount.
    // Waiting for projects !== null prevents that loading frame from clearing
    // project skills and then immediately rescanning them.
    bootstrapSkillhub();
  }, [dataOwnerId, projects]);
}
