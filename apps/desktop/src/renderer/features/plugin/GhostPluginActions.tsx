import { useTranslation } from 'react-i18next';
import { ChevronDown, FolderCode, Plus, Sparkles, Store, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/**
 * Add-plugin menu shared by local and remote catalogs.
 *
 * [MEKA] `meka` 只切换「新建」文案（Meka 渠道引导语），`onInstallDevelopment` 只多出
 * 「装入开发目录」一项；两者都缺省关闭，上游面（含远端目录）行为不变。这样 Meka 与上游
 * 共用同一个菜单实现，不再各维护一份。
 */
export function GhostPluginActions({
  onInstall,
  onCreateWithCindy,
  onAddMarketplace,
  disabled = false,
  installTarget,
  meka = false,
  onInstallDevelopment,
}: {
  onInstall: () => void;
  onCreateWithCindy?: () => void;
  onAddMarketplace?: () => void;
  disabled?: boolean;
  installTarget?: string;
  /** [MEKA] Meka 渠道面：沿用 Meka 的「用 Cindy 创建」文案。 */
  meka?: boolean;
  /** [MEKA] 开发目录装入入口（只在本机 Meka 面提供）。 */
  onInstallDevelopment?: () => void;
}) {
  const { t } = useTranslation();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="primary"
          size="lg"
          type="button"
          disabled={disabled}
          aria-label={t('settings.ghosts.page.addPluginAria')}
          className="plugin-management-action-trigger group shrink-0 data-[state=open]:[--button-face-bg:var(--surface-chip)]"
        >
          <Plus size={14} strokeWidth={1.8} aria-hidden="true" />
          <span className="plugin-management-action-label">
            {t('settings.ghosts.page.addPlugin')}
          </span>
          <ChevronDown
            size={13}
            strokeWidth={1.75}
            className="plugin-management-action-chevron transition-transform duration-150 group-data-[state=open]:rotate-180 motion-reduce:transition-none"
            aria-hidden="true"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={8}
        className="w-max min-w-52 max-w-[calc(100vw-2rem)] p-1.5"
      >
        {installTarget ? (
          <DropdownMenuLabel>
            {t('settings.ghosts.remote.installDestination', { device: installTarget })}
          </DropdownMenuLabel>
        ) : null}
        {onCreateWithCindy ? (
          <>
            <DropdownMenuItem onSelect={onCreateWithCindy} className="gap-3 whitespace-nowrap">
              <Sparkles
                size={16}
                strokeWidth={1.7}
                className="text-[var(--text-secondary)]"
                aria-hidden="true"
              />
              {t(
                meka
                  ? 'settings.ghosts.meka.createWithCindy'
                  : 'settings.ghosts.page.createWithCindy',
              )}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuItem onSelect={onInstall} className="gap-3 whitespace-nowrap">
          <Upload
            size={16}
            strokeWidth={1.7}
            className="text-[var(--text-secondary)]"
            aria-hidden="true"
          />
          {t('settings.ghosts.install')}
        </DropdownMenuItem>
        {onInstallDevelopment ? (
          <DropdownMenuItem onSelect={onInstallDevelopment} className="gap-3 whitespace-nowrap">
            <FolderCode size={16} strokeWidth={1.7} aria-hidden="true" />
            {t('settings.ghosts.meka.dev.loadDirectory')}
          </DropdownMenuItem>
        ) : null}
        {onAddMarketplace ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onAddMarketplace} className="gap-3 whitespace-nowrap">
              <Store
                size={16}
                strokeWidth={1.7}
                className="text-[var(--text-secondary)]"
                aria-hidden="true"
              />
              {t('settings.ghosts.market.sources.addMarketplace')}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
