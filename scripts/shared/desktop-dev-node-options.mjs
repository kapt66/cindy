/**
 * Keep the development Forge/Vite process above the one-shot rebuild peak.
 * The 2026-11-06 upstream sync grew the renderer graph: 6144 MB reproducibly
 * aborts the default `pnpm restart:desktop:remote` with exit 134 before the
 * renderer guard can mark alive, while 8192 MB completes a cold start. An
 * explicit developer override always wins.
 */
export const DESKTOP_DEV_MAX_OLD_SPACE = 8192;

const MAX_OLD_SPACE_OPTION = /(?:^|\s)--max[-_]old[-_]space[-_]size(?:=|\s)/;

export function withDesktopDevNodeOptions(env = process.env) {
  const next = { ...env };
  const existing = next.NODE_OPTIONS?.trim() ?? '';
  if (!MAX_OLD_SPACE_OPTION.test(existing)) {
    next.NODE_OPTIONS = [existing, `--max-old-space-size=${DESKTOP_DEV_MAX_OLD_SPACE}`]
      .filter(Boolean)
      .join(' ');
  }
  return next;
}
