import type { PublicShellMobileNavMode } from '@ozwasyd/element-plus';

/** Consumer boundary for the alias-resolved FsusUI PublicShell contract. */
export { ElPublicShell as FsusUiPublicShell } from '@ozwasyd/element-plus';

export const FSUSUI_PUBLIC_SHELL_MOBILE_NAV_MODES = [
    'inline',
    'menu',
    'bottom',
    'none'
] as const satisfies readonly PublicShellMobileNavMode[];

export type FsusUiPublicShellMobileNavMode = PublicShellMobileNavMode;

export const FSUSBLOG_PUBLIC_MOBILE_NAV_MODE = 'menu' as const;
