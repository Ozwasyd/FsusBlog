import { computed, readonly, ref } from 'vue';

import {
    normalizeThemeMode,
    syncThemeMode,
    type ThemeMode as FsusThemeMode
} from '@/fsusui/theme';

export type ThemeMode = FsusThemeMode;
type ResolvedTheme = 'light' | 'dark';

const THEME_STORAGE_KEY = 'fsus:theme-mode';
const THEME_CHANGE_EVENT = 'fsus:theme-change';
const THEME_MODE_ORDER: ThemeMode[] = ['light', 'dark', 'system'];

const themeModeState = ref<ThemeMode>('system');
const resolvedThemeState = ref<ResolvedTheme>('light');
let isThemeRuntimeReady = false;

let themeRootObserver: MutationObserver | null = null;

function readStoredThemeMode(): ThemeMode
{
    if (typeof window === 'undefined')
    {
        return 'system';
    }

    try
    {
        return normalizeThemeMode(window.localStorage.getItem(THEME_STORAGE_KEY), 'system');
    }
    catch
    {
        return 'system';
    }
}

function writeStoredThemeMode(mode: ThemeMode): void
{
    if (typeof window === 'undefined')
    {
        return;
    }

    try
    {
        window.localStorage.setItem(THEME_STORAGE_KEY, mode);
    }
    catch
    {
    // Ignore storage failures in private mode or restricted environments.
    }
}

function readResolvedThemeFromDom(): ResolvedTheme
{
    if (typeof document === 'undefined')
    {
        return 'light';
    }

    return document.documentElement.dataset.themeResolved === 'dark' ? 'dark' : 'light';
}

function readDomThemeMode(): ThemeMode
{
    if (typeof document === 'undefined')
    {
        return 'system';
    }

    return normalizeThemeMode(document.documentElement.dataset.themeMode, readStoredThemeMode());
}

function isHydratingPublicAotShell(): boolean
{
    if (typeof document === 'undefined')
    {
        return false;
    }

    const shell = document.querySelector<HTMLElement>('#fsus-aot-shell');
    return Boolean(shell && !shell.dataset.publicHydrated);
}

function emitThemeChange(mode: ThemeMode, resolvedTheme: ResolvedTheme): void
{
    if (typeof window === 'undefined')
    {
        return;
    }

    window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, {
        detail: {
            mode,
            resolvedTheme
        }
    }));
}

function refreshResolvedTheme(mode = themeModeState.value): void
{
    themeModeState.value = normalizeThemeMode(mode, 'system');
    resolvedThemeState.value = readResolvedThemeFromDom();
    emitThemeChange(themeModeState.value, resolvedThemeState.value);
}

function syncThemeRuntime(mode: ThemeMode, persist: boolean): void
{
    syncThemeMode(mode);
    refreshResolvedTheme(mode);

    if (persist)
    {
        writeStoredThemeMode(mode);
    }
}

function observeThemeRoot(): void
{
    if (themeRootObserver || typeof document === 'undefined' || typeof MutationObserver === 'undefined')
    {
        return;
    }

    themeRootObserver = new MutationObserver((records) =>
    {
        if (records.some((record) => record.attributeName === 'data-theme-resolved'))
        {
            refreshResolvedTheme();
        }
    });
    themeRootObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme-resolved']
    });
}

export function readInitialThemeMode(): ThemeMode
{
    // Hydration invariant: public AOT starts from DOM-safe system mode, then reconciles persisted preference after mount.
    if (isHydratingPublicAotShell())
    {
        return 'system';
    }

    return readDomThemeMode();
}

export function ensureThemeRuntime(): void
{
    if (isThemeRuntimeReady)
    {
        return;
    }

    syncThemeRuntime(readInitialThemeMode(), false);
    observeThemeRoot();
    isThemeRuntimeReady = true;
}

export function setThemeMode(mode: ThemeMode): void
{
    ensureThemeRuntime();
    syncThemeRuntime(mode, true);
}

export function reconcileThemeRuntimeAfterHydration(): void
{
    ensureThemeRuntime();
    syncThemeRuntime(readStoredThemeMode(), false);
}

function cycleThemeMode(): ThemeMode
{
    ensureThemeRuntime();
    const currentIndex = THEME_MODE_ORDER.indexOf(themeModeState.value);
    const nextMode = THEME_MODE_ORDER[(currentIndex + 1) % THEME_MODE_ORDER.length] ?? 'system';
    setThemeMode(nextMode);
    return nextMode;
}

export function useThemeRuntime()
{
    ensureThemeRuntime();

    return {
        mode: readonly(themeModeState),
        resolvedTheme: readonly(resolvedThemeState),
        isDark: computed(() => resolvedThemeState.value === 'dark'),
        setThemeMode,
        cycleThemeMode
    };
}
