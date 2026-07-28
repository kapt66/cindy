import { useEffect, useState } from 'react';

import { getMekaProject } from '@/ipc/mekaProjects';
import { onMekaProjectsRolesChanged } from '@/lib/mekaProjectsRolesBus';
import type { MekaProject } from '../../../shared/meka-projects';

export function resolveMekaSessionScope(
  project: MekaProject | null,
  roleId: string | null | undefined,
): string | null {
  if (!project) return null;
  const role = project.roles.find((candidate) => candidate.id === roleId);
  return role?.displayName ?? null;
}

export function buildMekaRoleEditorRoute(projectId: string, roleId: string): string {
  return `/cc-agent/meka?projectId=${encodeURIComponent(projectId)}&roleId=${encodeURIComponent(roleId)}`;
}

export function useMekaSessionScope(
  projectId: string | null | undefined,
  roleId: string | null | undefined,
): string | null {
  const [scope, setScope] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      if (!projectId) {
        setScope(null);
        return;
      }
      setScope(null);
      void getMekaProject(projectId)
        .then((project) => {
          if (!cancelled) setScope(resolveMekaSessionScope(project, roleId));
        })
        .catch(() => {
          if (!cancelled) setScope(null);
        });
    };
    refresh();
    const unsubscribe = onMekaProjectsRolesChanged(refresh);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [projectId, roleId]);

  return scope;
}
