import { cn } from '@/lib/utils';

import { REGION_SELECTOR } from './loginDesignTokens';

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
      className="inline-flex shrink-0 items-center rounded-full border border-[var(--border-default)] bg-[var(--surface-chip)]"
      style={{
        height: REGION_SELECTOR.height,
        borderRadius: REGION_SELECTOR.radius,
        padding: REGION_SELECTOR.trackPadding,
        gap: REGION_SELECTOR.gap,
      }}
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
              'flex h-full items-center justify-center whitespace-nowrap rounded-full leading-none transition-colors',
              selected
                ? 'border border-[var(--border-default)] bg-[var(--surface-elevated)] font-medium text-[var(--text-primary)]'
                : 'border border-transparent font-normal text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
              'focus-visible:z-[1] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]',
              'disabled:cursor-not-allowed disabled:opacity-60',
            )}
            style={{
              paddingLeft: REGION_SELECTOR.paddingX,
              paddingRight: REGION_SELECTOR.paddingX,
              fontSize: REGION_SELECTOR.fontSize,
            }}
          >
            {realm === 'cn' ? cnLabel : globalLabel}
          </button>
        );
      })}
    </span>
  );
}
