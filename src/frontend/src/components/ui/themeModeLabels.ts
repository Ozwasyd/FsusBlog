export type ThemeModeToggleLabels = Readonly<{
    light?: string;
    dark?: string;
    system?: string;
    lightShort?: string;
    darkShort?: string;
    systemShort?: string;
}>;

export const FSUSBLOG_THEME_MODE_LABELS = {
    light: '浅色',
    dark: '深色',
    system: '跟随系统',
    lightShort: '浅',
    darkShort: '深',
    systemShort: '系统'
} satisfies ThemeModeToggleLabels;
