export type ThemeColorMode = 'light' | 'dark';
export type ThemeAssetSource = 'preview' | 'active' | 'default';

export interface ThemeAssetDescriptor {
    id: string;
    contentHash: string;
    cssUrl: string;
    defaultMode: ThemeColorMode;
    activationId?: string | null;
}

export interface ThemeAssetSelection {
    defaultTheme: ThemeAssetDescriptor;
    activeTheme?: ThemeAssetDescriptor | null;
    previewTheme?: ThemeAssetDescriptor | null;
    explicitMode?: ThemeColorMode | null;
}

export interface ResolvedThemeAsset {
    source: ThemeAssetSource;
    theme: ThemeAssetDescriptor;
}

export interface ThemeAssetState {
    source: ThemeAssetSource | null;
    themeId: string | null;
    contentHash: string | null;
    colorScheme: ThemeColorMode;
    reducedMotion: boolean;
    highContrast: boolean;
}

export interface ThemeAssetRuntimeOptions {
    root: HTMLElement;
    head: HTMLHeadElement;
    matchMedia: (query: string) => MediaQueryList;
    reportFailure?: (failure: ThemeAssetFailureReport) => void | Promise<void>;
}

export interface ThemeAssetFailureReport {
    source: ThemeAssetSource;
    themeId: string;
    contentHash: string;
    activationId: string | null;
    code: string;
    detail: string;
}

export class ThemeAssetRuntimeError extends Error
{
    public readonly code: string;

    constructor(
        code: string,
        message: string
    )
    {
        super(message);
        this.code = code;
        this.name = 'ThemeAssetRuntimeError';
    }
}

const THEME_ID_PATTERN = /^fsusblog\.theme\.[a-z0-9](?:[a-z0-9.-]{0,94}[a-z0-9])?$/;
const CONTENT_HASH_PATTERN = /^[a-f0-9]{64}$/;
const DARK_MODE_QUERY = '(prefers-color-scheme: dark)';
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
const HIGH_CONTRAST_QUERY = '(prefers-contrast: more)';

export function resolveThemeAsset(selection: ThemeAssetSelection): ResolvedThemeAsset
{
    if (selection.previewTheme)
    {
        return { source: 'preview', theme: selection.previewTheme };
    }
    if (selection.activeTheme)
    {
        return { source: 'active', theme: selection.activeTheme };
    }
    return { source: 'default', theme: selection.defaultTheme };
}

export function createThemeAssetRuntime(options: ThemeAssetRuntimeOptions)
{
    let state: Readonly<ThemeAssetState> = Object.freeze({
        source: null,
        themeId: null,
        contentHash: null,
        colorScheme: 'light',
        reducedMotion: false,
        highContrast: false
    });
    let generation = 0;
    let activeLink: HTMLLinkElement | null = null;
    let cleanupPreferenceListeners: (() => void) | null = null;

    function current(): Readonly<ThemeAssetState>
    {
        return state;
    }

    async function apply(selection: ThemeAssetSelection): Promise<Readonly<ThemeAssetState>>
    {
        const applyGeneration = ++generation;
        cleanupPreferenceListeners?.();
        cleanupPreferenceListeners = null;

        const candidates: ResolvedThemeAsset[] = [];
        if (selection.previewTheme)
        {
            candidates.push({ source: 'preview', theme: selection.previewTheme });
        }
        if (selection.activeTheme
            && !candidates.some(({ theme }) =>
                theme.id === selection.activeTheme?.id
                && theme.contentHash === selection.activeTheme.contentHash))
        {
            candidates.push({ source: 'active', theme: selection.activeTheme });
        }
        if (!candidates.some(({ theme }) =>
            theme.id === selection.defaultTheme.id
            && theme.contentHash === selection.defaultTheme.contentHash))
        {
            candidates.push({ source: 'default', theme: selection.defaultTheme });
        }

        let lastError: unknown;
        for (const candidate of candidates)
        {
            if (applyGeneration !== generation)
            {
                throw new ThemeAssetRuntimeError(
                    'theme_asset_apply_superseded',
                    'Theme asset application was superseded by a newer selection.'
                );
            }
            try
            {
                return await loadAndCommit(candidate, selection, applyGeneration);
            }
            catch (error)
            {
                lastError = error;
                await reportFailure(resolvedFailure(candidate, error));
            }
        }

        throw lastError;
    }

    async function loadAndCommit(
        resolved: ResolvedThemeAsset,
        selection: ThemeAssetSelection,
        applyGeneration: number
    ): Promise<Readonly<ThemeAssetState>>
    {
        validateDescriptor(resolved.theme, options.root.ownerDocument);
        const link = await loadStylesheet(resolved.theme, applyGeneration);
        if (applyGeneration !== generation)
        {
            link.remove();
            throw new ThemeAssetRuntimeError(
                'theme_asset_apply_superseded',
                'Theme asset application was superseded by a newer selection.'
            );
        }

        const preferences = readPreferences(selection, resolved.theme, options.matchMedia);
        commitRoot(resolved, preferences);
        const previousLink = activeLink;
        activeLink = link;
        link.media = 'all';
        previousLink?.remove();
        cleanupPreferenceListeners = observePreferences(selection, resolved, applyGeneration);
        return state;
    }

    function loadStylesheet(
        theme: ThemeAssetDescriptor,
        applyGeneration: number
    ): Promise<HTMLLinkElement>
    {
        return new Promise((resolve, reject) =>
        {
            const link = options.head.ownerDocument.createElement('link');
            link.rel = 'stylesheet';
            link.media = 'not all';
            link.href = theme.cssUrl;
            link.dataset.fsusThemeStylesheet = theme.id;
            link.dataset.contentHash = theme.contentHash;
            link.addEventListener('load', () => resolve(link), { once: true });
            link.addEventListener('error', () =>
            {
                link.remove();
                reject(new ThemeAssetRuntimeError(
                    'theme_asset_stylesheet_load_failed',
                    `Theme stylesheet '${theme.id}' failed to load.`
                ));
            }, { once: true });
            if (applyGeneration !== generation)
            {
                reject(new ThemeAssetRuntimeError(
                    'theme_asset_apply_superseded',
                    'Theme asset application was superseded before loading.'
                ));
                return;
            }
            options.head.append(link);
        });
    }

    function commitRoot(
        resolved: ResolvedThemeAsset,
        preferences: PreferenceSnapshot
    ): void
    {
        options.root.dataset.theme = resolved.theme.id;
        options.root.dataset.colorScheme = preferences.colorScheme;
        options.root.dataset.reducedMotion = String(preferences.reducedMotion);
        options.root.dataset.highContrast = String(preferences.highContrast);
        state = Object.freeze({
            source: resolved.source,
            themeId: resolved.theme.id,
            contentHash: resolved.theme.contentHash,
            colorScheme: preferences.colorScheme,
            reducedMotion: preferences.reducedMotion,
            highContrast: preferences.highContrast
        });
    }

    function observePreferences(
        selection: ThemeAssetSelection,
        resolved: ResolvedThemeAsset,
        applyGeneration: number
    ): () => void
    {
        const queries = [
            options.matchMedia(DARK_MODE_QUERY),
            options.matchMedia(REDUCED_MOTION_QUERY),
            options.matchMedia(HIGH_CONTRAST_QUERY)
        ];
        const listener = () =>
        {
            if (applyGeneration === generation)
            {
                commitRoot(resolved, readPreferences(selection, resolved.theme, options.matchMedia));
            }
        };
        for (const query of queries)
        {
            query.addEventListener?.('change', listener);
        }
        return () =>
        {
            for (const query of queries)
            {
                query.removeEventListener?.('change', listener);
            }
        };
    }

    function dispose(): void
    {
        generation += 1;
        cleanupPreferenceListeners?.();
        cleanupPreferenceListeners = null;
    }

    async function reportFailure(failure: ThemeAssetFailureReport): Promise<void>
    {
        try
        {
            await options.reportFailure?.(failure);
        }
        catch
        {
            // Reporting is best-effort. A telemetry/control-plane outage must never
            // block the active/default stylesheet fallback.
        }
    }

    return Object.freeze({
        apply,
        current,
        dispose
    });
}

function resolvedFailure(
    resolved: ResolvedThemeAsset,
    error: unknown
): ThemeAssetFailureReport
{
    return {
        source: resolved.source,
        themeId: resolved.theme.id,
        contentHash: resolved.theme.contentHash,
        activationId: resolved.theme.activationId ?? null,
        code: error instanceof ThemeAssetRuntimeError
            ? error.code
            : 'theme_asset_runtime_failed',
        detail: error instanceof Error
            ? error.message
            : 'Theme asset runtime failed with an unknown error.'
    };
}

interface PreferenceSnapshot {
    colorScheme: ThemeColorMode;
    reducedMotion: boolean;
    highContrast: boolean;
}

function readPreferences(
    selection: ThemeAssetSelection,
    theme: ThemeAssetDescriptor,
    matchMedia: (query: string) => MediaQueryList
): PreferenceSnapshot
{
    const colorScheme = selection.explicitMode
    ?? (matchMedia(DARK_MODE_QUERY).matches ? 'dark' : theme.defaultMode);
    return {
        colorScheme,
        reducedMotion: matchMedia(REDUCED_MOTION_QUERY).matches,
        highContrast: matchMedia(HIGH_CONTRAST_QUERY).matches
    };
}

function validateDescriptor(theme: ThemeAssetDescriptor, document: Document): void
{
    if (!THEME_ID_PATTERN.test(theme.id) || !CONTENT_HASH_PATTERN.test(theme.contentHash))
    {
        throw new ThemeAssetRuntimeError(
            'theme_asset_descriptor_invalid',
            'Theme asset descriptor has an invalid id or SHA-256 content hash.'
        );
    }
    if (theme.defaultMode !== 'light' && theme.defaultMode !== 'dark')
    {
        throw new ThemeAssetRuntimeError(
            'theme_asset_descriptor_invalid',
            'Theme asset descriptor has an invalid default mode.'
        );
    }

    const url = new URL(theme.cssUrl, document.baseURI);
    if (url.origin !== document.location.origin
    || !url.pathname.endsWith('.css')
    || !url.pathname.split('/').includes(theme.contentHash))
    {
        throw new ThemeAssetRuntimeError(
            'theme_asset_url_hash_mismatch',
            'Theme stylesheet URL must be same-origin CSS scoped by its declared content hash.'
        );
    }
}
