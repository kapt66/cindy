import type {
  MekaSkillMarketDetail,
  MekaSkillReleaseSummary,
} from '../../shared/mekaSkillMarket.js';
import { getMekaRouterService } from '../meka-settings/ipc.js';
import { serverApiFetch } from '../serverApiClient.js';

interface DeliveryAccess {
  baseUrl: string;
  clientKey: string | null;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid MCPRouter ${label}`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Invalid MCPRouter ${label}`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Invalid MCPRouter ${label}`);
  }
  return value as number;
}

function release(value: unknown): MekaSkillReleaseSummary {
  const raw = record(value, 'skill release');
  return {
    id: text(raw.id, 'skill release id'),
    version: text(raw.version, 'skill release version'),
    sha256: text(raw.sha256, 'skill release sha256'),
    sizeBytes: positiveInteger(raw.sizeBytes, 'skill release size'),
    uncompressedSizeBytes: positiveInteger(
      raw.uncompressedSizeBytes,
      'skill release uncompressed size',
    ),
    publishedAt: text(raw.publishedAt, 'skill release publishedAt'),
  };
}

export interface VisibleMekaSkill {
  id: string;
  slug: string;
  name: string;
  description: string;
  scope: 'public' | 'personal';
  access: 'owner' | 'shared' | 'public';
  currentRelease: MekaSkillReleaseSummary;
}

function summary(value: unknown): VisibleMekaSkill {
  const raw = record(value, 'skill');
  const scope = raw.scope;
  if (scope !== 'public' && scope !== 'personal') {
    throw new Error('Invalid MCPRouter skill scope');
  }
  const access = raw.access;
  if (access !== 'owner' && access !== 'shared' && access !== 'public') {
    throw new Error('Invalid MCPRouter skill access');
  }
  return {
    id: text(raw.id, 'skill id'),
    slug: text(raw.slug, 'skill slug'),
    name: text(raw.name, 'skill name'),
    description: text(raw.description, 'skill description'),
    scope,
    access,
    currentRelease: release(raw.currentRelease),
  };
}

function deliveryPath(apiPath: string, authenticated: boolean): string {
  const prefix = '/api/skills';
  if (
    apiPath !== prefix &&
    !apiPath.startsWith(`${prefix}/`) &&
    !apiPath.startsWith(`${prefix}?`)
  ) {
    throw new Error('Unexpected MCPRouter skill delivery path');
  }
  return authenticated ? apiPath : `/api/public/skills${apiPath.slice(prefix.length)}`;
}

/** Fail-closed client for the MCPRouter-owned Meka Skill delivery API. */
export class MekaSkillMarketApi {
  async access(): Promise<DeliveryAccess> {
    return getMekaRouterService().getPluginRegistryAccess();
  }

  async isConfigured(): Promise<boolean> {
    try {
      await this.access();
      return true;
    } catch {
      return false;
    }
  }

  private async fetch<T>(apiPath: string): Promise<T> {
    const access = await this.access();
    return serverApiFetch<T>(deliveryPath(apiPath, access.clientKey !== null), {
      baseUrl: access.baseUrl,
      ...(access.clientKey ? { token: access.clientKey } : {}),
      cache: 'no-store',
      skipAutoRefresh: true,
      redactErrorDetails: true,
    });
  }

  async listAll(query?: string): Promise<VisibleMekaSkill[]> {
    const result: VisibleMekaSkill[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < 100; page += 1) {
      const search = new URLSearchParams({ limit: '100' });
      if (query?.trim()) search.set('query', query.trim());
      if (cursor) search.set('cursor', cursor);
      const raw = record(
        await this.fetch<unknown>(`/api/skills?${search.toString()}`),
        'skill catalog',
      );
      if (raw.schemaVersion !== 1 || !Array.isArray(raw.skills)) {
        throw new Error('Invalid MCPRouter skill catalog');
      }
      for (const value of raw.skills) {
        const skill = summary(value);
        if (seen.has(skill.id)) continue;
        seen.add(skill.id);
        result.push(skill);
      }
      if (raw.nextCursor === null) return result;
      const nextCursor = text(raw.nextCursor, 'skill cursor');
      if (nextCursor === cursor) throw new Error('Meka Skill catalog cursor did not advance');
      cursor = nextCursor;
    }
    throw new Error('Meka Skill catalog exceeded the page limit');
  }

  async detail(skillId: string): Promise<MekaSkillMarketDetail> {
    const raw = record(
      await this.fetch<unknown>(`/api/skills/${encodeURIComponent(skillId)}`),
      'skill detail response',
    );
    if (raw.schemaVersion !== 1) throw new Error('Invalid MCPRouter skill detail schema');
    const skill = record(raw.skill, 'skill detail');
    const base = summary(skill);
    const currentRelease = record(skill.currentRelease, 'skill detail release');
    const manifest = record(currentRelease.manifest, 'skill manifest');
    if (!Array.isArray(currentRelease.files)) throw new Error('Invalid MCPRouter skill file index');
    return {
      ...base,
      currentRelease: {
        ...release(currentRelease),
        manifest: {
          ...manifest,
          name: text(manifest.name, 'skill manifest name'),
          description: text(manifest.description, 'skill manifest description'),
          version: text(manifest.version, 'skill manifest version'),
        },
        files: currentRelease.files.map((value) => {
          const file = record(value, 'skill file');
          return {
            path: text(file.path, 'skill file path'),
            sizeBytes: positiveInteger(file.sizeBytes, 'skill file size'),
            sha256: text(file.sha256, 'skill file sha256'),
          };
        }),
      },
    };
  }

  async download(
    skillId: string,
    releaseId: string,
  ): Promise<{ url: string; expiresAt: string; sha256: string; sizeBytes: number }> {
    const raw = record(
      await this.fetch<unknown>(
        `/api/skills/${encodeURIComponent(skillId)}/releases/${encodeURIComponent(releaseId)}/download`,
      ),
      'skill download',
    );
    return {
      url: text(raw.url, 'skill download URL'),
      expiresAt: text(raw.expiresAt, 'skill download expiry'),
      sha256: text(raw.sha256, 'skill download sha256'),
      sizeBytes: positiveInteger(raw.sizeBytes, 'skill download size'),
    };
  }
}
