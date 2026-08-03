import { cn } from '@/lib/utils';

import { REGION_PILL } from './loginDesignTokens';

export type LoginRealm = 'cn' | 'global';

/** Meka single-install service realm selector. */
export function LoginRealmSelector({
  value,
  cnLabel,
  globalLabel,
  disabled,
  onChange,
}: {
  value: LoginRealm;
  cnLabel: string;
  globalLabel: string;
  disabled?: boolean;
  onChange: (realm: LoginRealm) => void;
}) {
  return (
    <span
      role="radiogroup"
      data-testid="login-realm-selector"
      className="inline-flex shrink-0 overflow-hidden border border-[var(--border-default)] bg-[var(--surface-secondary)]"
      style={{ height: REGION_PILL.height, borderRadius: 8 }}
    >
      {(['cn', 'global'] as const).map((realm) => {
        const selected = value === realm;
        return (
          <button
            key={realm}
            type="button"
            role="radio"
            aria-checked={selected}
            data-testid={`login-realm-${realm}`}
            disabled={disabled}
            onClick={() => onChange(realm)}
            className={cn(
              'h-full whitespace-nowrap px-3 font-medium transition-colors',
              selected
                ? 'bg-[var(--surface-elevated)] text-[var(--text-primary)]'
                : 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]',
              'disabled:cursor-not-allowed disabled:opacity-60',
            )}
            style={{ fontSize: REGION_PILL.fontSize, lineHeight: `${REGION_PILL.height}px` }}
          >
            {realm === 'cn' ? cnLabel : globalLabel}
          </button>
        );
      })}
    </span>
  );
}
