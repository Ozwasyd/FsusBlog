import { normalizeThemeMode, syncThemeMode } from '@/fsusui/theme';

const THEME_STORAGE_KEY = 'fsus:theme-mode';

let storedThemeMode: string | null = null;

try
{
    storedThemeMode = window.localStorage.getItem(THEME_STORAGE_KEY);
}
catch
{
    storedThemeMode = null;
}

syncThemeMode(normalizeThemeMode(storedThemeMode, 'system'));
