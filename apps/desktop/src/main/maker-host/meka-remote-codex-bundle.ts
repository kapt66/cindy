import type { BundleFile } from '@cindy/maker-cc-manager';

import type { MekaSkillSnapshot } from '../meka-projects/skillSnapshot.js';

export interface MekaRemoteCodexBundle {
  revisionHash: string;
  files: readonly BundleFile[];
}

/**
 * Reuse the exact immutable local snapshot bytes for remote Worker delivery.
 */
export function buildMekaRemoteCodexBundle(
  snapshot: MekaSkillSnapshot,
): MekaRemoteCodexBundle {
  return {
    revisionHash: snapshot.revision,
    files: snapshot.files.map((file) => ({
      relPath: file.relativePath,
      contentBase64: file.contentBase64,
      digest: file.digest,
    })),
  };
}
