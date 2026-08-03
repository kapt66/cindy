export interface MekaSkillReleaseSummary {
  id: string;
  version: string;
  sha256: string;
  sizeBytes: number;
  uncompressedSizeBytes: number;
  publishDescription?: string;
  publishedAt: string;
}

export interface MekaSkillMarketItem {
  id: string;
  slug: string;
  name: string;
  description: string;
  scope: 'public' | 'personal';
  access: 'owner' | 'shared' | 'public';
  currentRelease: MekaSkillReleaseSummary;
  installed: boolean;
  updateAvailable: boolean;
  installedPath?: string;
}

export interface MekaSkillPreviewFile {
  path: string;
  size: number;
  language: string;
  truncated: boolean;
  content?: string;
}

export interface MekaSkillMarketDetail extends Omit<
  MekaSkillMarketItem,
  'installed' | 'updateAvailable' | 'installedPath'
> {
  currentRelease: MekaSkillReleaseSummary & {
    manifest: Record<string, unknown> & {
      name: string;
      description: string;
      version: string;
    };
    files: Array<{ path: string; sizeBytes: number; sha256: string }>;
  };
}

export interface MekaSkillMarketSnapshot {
  configured: boolean;
  unavailableReason?: 'registry-not-supported';
  items: MekaSkillMarketItem[];
}

export interface MekaSkillInstallRequest {
  skillId: string;
  expectedReleaseId: string;
  installPath?: string;
  force?: boolean;
  skipBackup?: boolean;
}

export type MekaSkillVisibility = 'private' | 'shared' | 'public';

export interface MekaSkillSourcePreview {
  sourceId: string;
  directoryPath: string;
  name: string;
  description: string;
  fileCount: number;
  packageSizeBytes: number;
}

export interface MekaSkillPublishInfo {
  source: MekaSkillSourcePreview;
  suggestedVersion: string;
  existing: {
    skillResourceId: string;
    currentReleaseId: string;
    currentVersion: string;
    visibility: MekaSkillVisibility;
    sharedUsernames: string[];
  } | null;
}

export interface MekaSkillPublishRequest {
  sourceId: string;
  version: string;
  extraDescription?: string;
  visibility: MekaSkillVisibility;
  sharedUsernames: string[];
  expectedCurrentReleaseId: string | null;
}

export interface MekaSkillPublishResult {
  skillId: string;
  version: string;
  visibility: MekaSkillVisibility;
  releasePublished: boolean;
}

export interface MekaSkillManagementInfo {
  skillResourceId: string;
  slug: string;
  name: string;
  currentReleaseId: string;
  currentVersion: string;
  visibility: MekaSkillVisibility;
  sharedUsernames: string[];
}

export interface MekaSkillAccessUpdateRequest {
  skillId: string;
  expectedCurrentReleaseId: string;
  visibility: MekaSkillVisibility;
  sharedUsernames: string[];
}

export interface MekaSkillDeleteRequest {
  skillId: string;
  expectedCurrentReleaseId: string;
}

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Meka releases start at 1.0.0 and advance the current stable patch. */
export function nextMekaSkillVersion(currentVersion: string | null): string {
  if (currentVersion === null) return '1.0.0';
  const match = SEMVER_RE.exec(currentVersion);
  if (!match) throw new Error('Current Meka Skill version is not valid SemVer');
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger) || patch === Number.MAX_SAFE_INTEGER) {
    throw new Error('Current Meka Skill version cannot be incremented safely');
  }
  return `${major}.${minor}.${patch + 1}`;
}
