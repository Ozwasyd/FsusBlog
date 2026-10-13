import { computed, readonly, ref } from 'vue';

import {
    normalizeThemeMode,
    syncThemeMode,
    type ThemeMode as FsusThemeMode
} from '@/fsusui/theme';

import type { GlobalConfigSnapshotProducer } from '@ozwasyd/element-plus';

export type ThemeMode = FsusThemeMode;
type ResolvedTheme = 'light' | 'dark';

const THEME_STORAGE_KEY = 'fsus:theme-mode';
const THEME_CHANGE_EVENT = 'fsus:theme-change';
const THEME_MODE_ORDER: ThemeMode[] = ['light', 'dark', 'system'];

const themeModeState = ref<ThemeMode>('system');
const resolvedThemeState = ref<ResolvedTheme>('light');
let isThemeRuntimeReady = false;

let themeRootObserver: MutationObserver | null = null;
type ThemeConfigBinding = {
    producer: GlobalConfigSnapshotProducer;
    failed: boolean;
};
const themeConfigBindings = new Set<ThemeConfigBinding>();
let themeWriteActive = false;

/** Bind an actual caller-created producer; registration itself is not provenance certification. */
export function bindThemeConfigProducer(producer: GlobalConfigSnapshotProducer): () => void
{
    if (themeWriteActive)
    {
        throw new Error('theme_config_binding_during_write');
    }
    ensureThemeRuntime();
    const binding: ThemeConfigBinding = { producer, failed: false };
    themeWriteActive = true;
    try
    {
        producer.update({ ...producer.config.value, themeMode: themeModeState.value });
        themeConfigBindings.add(binding);
    }
    catch (cause)
    {
        try
        {
            producer.release();
        }
        catch
        {
            // Keep the original binding failure.
        }
        throw cause;
    }
    finally
    {
        themeWriteActive = false;
    }
    return () =>
    {
        themeConfigBindings.delete(binding);
    };
}

function retireThemeConfigBindings(bindings: readonly ThemeConfigBinding[]): void
{
    for (const binding of new Set([...bindings, ...themeConfigBindings]))
    {
        binding.failed = true;
        try
        {
            binding.producer.release();
        }
        catch
        {
            // The genuine producer invalidates before notifying; retain the write failure.
        }
    }
}

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
    if (themeWriteActive)
    {
        throw new Error('theme_config_reentrant_write');
    }
    const bindings = [...themeConfigBindings];
    themeWriteActive = true;
    try
    {
        const nextMode = normalizeThemeMode(mode, 'system');
        for (const binding of bindings)
        {
            if (binding.failed || !themeConfigBindings.has(binding))
            {
                throw new Error('theme_config_binding_unavailable');
            }
            binding.producer.update({ ...binding.producer.config.value, themeMode: nextMode });
            if (!themeConfigBindings.has(binding))
            {
                throw new Error('theme_config_binding_released_during_write');
            }
        }
        syncThemeMode(mode);
        refreshResolvedTheme(mode);

        if (persist)
        {
            writeStoredThemeMode(mode);
        }
    }
    catch (cause)
    {
        retireThemeConfigBindings(bindings);
        throw cause;
    }
    finally
    {
        themeWriteActive = false;
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
