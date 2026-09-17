import { normalizeThemeMode, type ThemeMode } from '@/fsusui/theme';
import type { PublicPageKind } from '@/public-renderers/publicRenderBase';
import { createPublicShellViewState } from '@/public-renderers/publicShellViewState';

export type PublicBrowserSessionState = 'anonymous' | 'user' | 'admin';
export type PublicBrowserStorageBehavior = 'normal' | 'unavailable' | 'cleared-after-reload';

export type PublicBrowserEnvironmentInput = Readonly<{
    hydrationKind: PublicPageKind;
    themePreference?: string | null;
    sessionState: PublicBrowserSessionState;
    storageBehavior: PublicBrowserStorageBehavior;
    motionPreference: 'normal' | 'reduced';
    colorScheme: 'light' | 'dark';
    stalePublicShellState?: boolean;
    staleSiteInfo?: boolean;
}>;

export type PublicBrowserEnvironmentProjection = Readonly<{
    hydrationKind: PublicPageKind;
    themeMode: ThemeMode;
    themeResolved: 'light' | 'dark';
    authAction: 'login' | 'account' | 'dashboard';
    authHref: string;
    reducedMotion: boolean;
    darkColorScheme: boolean;
    storageAvailable: boolean;
    staleStateAccepted: false;
    activeNav: string;
}>;

export function projectPublicBrowserEnvironment(
    input: PublicBrowserEnvironmentInput
): PublicBrowserEnvironmentProjection
{
    const storageAvailable = input.storageBehavior !== 'unavailable';
    const storedTheme = storageAvailable && input.storageBehavior !== 'cleared-after-reload'
        ? input.themePreference
        : null;
    const themeMode = normalizeThemeMode(storedTheme, 'system');
    const themeResolved = themeMode === 'system' ? input.colorScheme : themeMode;
    const isLoggedIn = input.sessionState !== 'anonymous';
    const shell = createPublicShellViewState({
        hydrationKind: input.hydrationKind,
        isRuntimeAuthResolved: true,
        isLoggedIn,
        isAdmin: input.sessionState === 'admin'
    });

    return Object.freeze({
        hydrationKind: input.hydrationKind,
        themeMode,
        themeResolved,
        authAction: shell.authAction,
        authHref: shell.authHref,
        reducedMotion: input.motionPreference === 'reduced',
        darkColorScheme: input.colorScheme === 'dark',
        storageAvailable,
        staleStateAccepted: false,
        activeNav: shell.activeNav
    });
}
