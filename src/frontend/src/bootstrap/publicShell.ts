import { dispatchAotActionEvent } from '@/bootstrap/aotActionEvent';
import {
    adoptPublicBootIntent,
    getPublicActivationOwner,
    submitPublicActivationIntent,
    warmPublicActivation,
    warmPublicFullAppCore
} from '@/bootstrap/publicActivationRuntime';
import type { PublicBootIntent } from '@/bootstrap/publicBootHandoff';
import {
    readPublicHydrationPayloadAsync
} from '@/bootstrap/publicHydrationBootstrap';
import {
    classifyPublicNavigationIntent
} from '@/bootstrap/publicNavigationIntent';
import {
    addPublicShellEventListener,
    onPublicShellLifetimeAbort,
    resetPublicShellLifetime
} from '@/bootstrap/publicShellLifetime';
import {
    isPublicSeoPath,
    removeGlobalLoader
} from '@/bootstrap/publicShellPrimitives';
import { hydratePublicPage, type PublicHydrationPayload } from '@/public-renderers';
import { hasCanonicalPublicSeedRenderTimestamp } from '@/public-renderers/publicRenderClock';
import { putPublicRouteSeed } from '@/public-renderers/publicRouteSeedStore';
import { resetPublicShellRuntimeAuthState } from '@/public-renderers/publicShellRuntimeState';
import {
    resolvePublicRoutePrewarmTarget,
    type PublicRoutePrewarmReason
} from '@/router/publicRoutePreload';
import {
    activateLocalFixtureSession,
    buildLocalFixtureAdminUrl,
    ensureLocalFixtureSessionCookies,
    isLocalFixtureQueryEnabled,
    isLocalFixtureSessionActive
} from '@/services/localFixtureSession';
import { emitRumMetric, emitTelemetry } from '@/services/telemetryBus';
import {
    ensureThemeRuntime,
    reconcileThemeRuntimeAfterHydration,
    setThemeMode
} from '@/services/themeRuntime';

function isModifiedEvent(event: MouseEvent): boolean
{
    return event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
}

function isInternalAppLink(anchor: HTMLAnchorElement): boolean
{
    if (anchor.target && anchor.target !== '_self')
    {
        return false;
    }

    if (anchor.hasAttribute('download'))
    {
        return false;
    }

    const rawHref = anchor.getAttribute('href');
    if (!rawHref || rawHref.startsWith('#'))
    {
        return false;
    }

    const url = new URL(anchor.href, window.location.origin);
    if (url.origin !== window.location.origin)
    {
        return false;
    }

    if (url.pathname.startsWith('/api/'))
    {
        return false;
    }

    return true;
}

interface CriticalStyleLink {
    key: string;
    href: string | null;
    marker: string;
    readiness: 'critical' | 'markdown' | 'background';
}

const CRITICAL_STYLE_READY_TIMEOUT_MS = 450;
const FULL_STYLESHEET_VALIDATION_TIMEOUT_MS = 1500;
const DOCUMENT_INTERACTIVE_FALLBACK_MS = 250;
const HOME_HOT_ARTICLES_SENTINEL_ID = 'fsus-home-secondary-content-sentinel';
const HOME_HOT_ARTICLES_ROOT_MARGIN = '600px 0px 600px 0px';
const HOME_HOT_ARTICLES_FALLBACK_DELAY_MS = 2500;
const COMMENTS_ISLAND_FALLBACK_DELAY_MS = 2500;

const PUBLIC_STYLE_FALLBACKS: CriticalStyleLink[] = [
    {
        key: 'public-shell-critical',
        href: null,
        marker: 'public-shell-critical.css',
        readiness: 'critical'
    },
    {
        key: 'tailwind',
        href: null,
        marker: 'tailwind.css',
        readiness: 'critical'
    },
    {
        key: 'markdown',
        href: null,
        marker: 'markdown.css',
        readiness: 'markdown'
    },
    {
        key: 'motion',
        href: null,
        marker: 'motion.css',
        readiness: 'background'
    },
    {
        key: 'public-page',
        href: null,
        marker: 'public-page.css',
        readiness: 'critical'
    }
];

function isFontOnlyStylesheet(link: HTMLLinkElement): boolean
{
    const href = (link.getAttribute('href') ?? '').toLowerCase();
    const marker = (link.dataset.fsusblogStyle ?? '').toLowerCase();
    return marker.includes('font') || href.includes('font');
}

function isRenderableStylesheet(link: HTMLLinkElement): boolean
{
    const rel = (link.getAttribute('rel') ?? '').toLowerCase();
    if (rel !== 'stylesheet')
    {
        return false;
    }

    if ((link.getAttribute('disabled') ?? '') === 'true' || link.disabled)
    {
        return false;
    }

    return !isFontOnlyStylesheet(link);
}

function listRenderableStylesheets(): HTMLLinkElement[]
{
    return Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'))
        .filter((link) => isRenderableStylesheet(link));
}

function dedupeStylesheetLinks(links: HTMLLinkElement[]): HTMLLinkElement[]
{
    const seen = new Set<string>();
    const ordered: HTMLLinkElement[] = [];
    for (const link of links)
    {
        const styleKey = link.dataset.fsusblogStyle?.trim() ?? '';
        const href = link.getAttribute('href') ?? '';
        const key = styleKey.length > 0 ? styleKey : href;
        if (key.length === 0 || seen.has(key))
        {
            continue;
        }
        seen.add(key);
        ordered.push(link);
    }
    return ordered;
}

function isMarkdownCriticalPath(pathname = window.location.pathname): boolean
{
    return /^\/article\/\d+\/?$/i.test(pathname)
    || /^\/about\/?$/i.test(pathname)
    || /^\/privacy\/?$/i.test(pathname)
    || /^\/guidelines\/?$/i.test(pathname)
    || /^\/copyright\/?$/i.test(pathname);
}

function shouldWaitForStyleCandidate(candidate: CriticalStyleLink): boolean
{
    return candidate.readiness === 'critical'
    || (candidate.readiness === 'markdown' && isMarkdownCriticalPath());
}

function stylesheetMatchesCandidate(link: HTMLLinkElement, candidate: CriticalStyleLink): boolean
{
    const marker = (link.dataset.fsusblogStyle ?? '').trim();
    if (marker === candidate.key)
    {
        return true;
    }

    const href = link.getAttribute('href') ?? '';
    return href.includes(candidate.marker);
}

function listCriticalShellStylesheets(links: HTMLLinkElement[]): HTMLLinkElement[]
{
    const criticalCandidates = PUBLIC_STYLE_FALLBACKS.filter(shouldWaitForStyleCandidate);
    return dedupeStylesheetLinks(
        links.filter((link) => criticalCandidates.some((candidate) => stylesheetMatchesCandidate(link, candidate)))
    );
}

function ensureFallbackStylesheets(): HTMLLinkElement[]
{
    const head = document.head ?? document.getElementsByTagName('head')[0];
    if (!head)
    {
        return [];
    }

    const presentLinks = listRenderableStylesheets();
    const requiredLinks = PUBLIC_STYLE_FALLBACKS.map((candidate) =>
    {
        const existing = document.querySelector<HTMLLinkElement>(
            `link[rel="stylesheet"][data-fsusblog-style="${candidate.key}"]`
        );
        if (existing)
        {
            return existing;
        }

        const byHref = document.querySelector<HTMLLinkElement>(
            `link[rel="stylesheet"][href*="${candidate.marker}"]`
        );
        if (byHref)
        {
            return byHref;
        }

        if (!candidate.href)
        {
            return null;
        }

        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = candidate.href;
        link.dataset.fsusblogStyle = candidate.key;
        link.dataset.fsusblogInjected = 'bootstrap';
        head.appendChild(link);
        return link;
    }).filter((link): link is HTMLLinkElement => link instanceof HTMLLinkElement);

    return dedupeStylesheetLinks([...presentLinks, ...requiredLinks]);
}

function waitForStylesheet(link: HTMLLinkElement, timeoutMs = FULL_STYLESHEET_VALIDATION_TIMEOUT_MS): Promise<boolean>
{
    if (link.sheet)
    {
        return Promise.resolve(true);
    }

    return new Promise((resolve) =>
    {
        let settled = false;

        const onLoad = () => complete(true);
        const onError = () => complete(false);

        const complete = (loaded: boolean) =>
        {
            if (settled)
            {
                return;
            }
            settled = true;
            link.removeEventListener('load', onLoad);
            link.removeEventListener('error', onError);
            resolve(loaded || Boolean(link.sheet));
        };

        link.addEventListener('load', onLoad, { once: true });
        link.addEventListener('error', onError, { once: true });
        window.setTimeout(() => complete(false), timeoutMs);
    });
}

function ensureEmergencyPublicShellStyle(): void
{
    const styleId = 'fsus-public-emergency-style';
    if (document.getElementById(styleId))
    {
        return;
    }

    const link = document.createElement('link');
    link.id = styleId;
    link.rel = 'stylesheet';
    link.href = '/public-shell-emergency.css';
    document.head.appendChild(link);
}

export async function ensurePublicShellStylesReady(): Promise<void>
{
    if (typeof document === 'undefined')
    {
        return;
    }

    const styleLinks = ensureFallbackStylesheets();
    if (styleLinks.length === 0)
    {
        ensureEmergencyPublicShellStyle();
        return;
    }

    await ensureCriticalPublicShellStylesReady(styleLinks);
    validatePublicShellStylesheetsInBackground(styleLinks);
}

async function ensureCriticalPublicShellStylesReady(styleLinks: HTMLLinkElement[]): Promise<void>
{
    const criticalLinks = listCriticalShellStylesheets(styleLinks);
    if (criticalLinks.length === 0)
    {
        ensureEmergencyPublicShellStyle();
        return;
    }

    const loadedStates = await Promise.all(
        criticalLinks.map((link) => waitForStylesheet(link, CRITICAL_STYLE_READY_TIMEOUT_MS))
    );
    const hasRenderableSheet = criticalLinks.some((link) => Boolean(link.sheet));
    if (!hasRenderableSheet || loadedStates.every((loaded) => !loaded))
    {
        ensureEmergencyPublicShellStyle();
    }
}

function validatePublicShellStylesheetsInBackground(styleLinks: HTMLLinkElement[]): void
{
    void Promise.all(styleLinks.map((link) => waitForStylesheet(link, FULL_STYLESHEET_VALIDATION_TIMEOUT_MS)))
        .then((loadedStates) =>
        {
            const hasRenderableSheet = listRenderableStylesheets().some((link) => Boolean(link.sheet));
            if (!hasRenderableSheet || loadedStates.every((loaded) => !loaded))
            {
                ensureEmergencyPublicShellStyle();
            }
        })
        .catch(() =>
        {
            ensureEmergencyPublicShellStyle();
        });
}

let preBootstrapNavigationBound = false;
let hydratedPayload: PublicHydrationPayload | null = null;
let hotArticlesIdleTask: number | null = null;
let hotArticlesFallbackTimer: number | null = null;
let hotArticlesIntersectionObserver: IntersectionObserver | null = null;
let hotArticlesActivationVersion = 0;
let commentsIdleTask: number | null = null;
let commentsFallbackTimer: number | null = null;
let commentsIntersectionObserver: IntersectionObserver | null = null;
let commentsActivationVersion = 0;
let publicRoutePrewarmIdleTask: number | null = null;
const importHomeHotArticlesIslandModule = () => import('@/public-renderers/homeHotArticlesIsland');
const importCommentsIslandModule = () => import('@/public-renderers/commentsIsland');
let homeHotArticlesIslandModulePromise: ReturnType<typeof importHomeHotArticlesIslandModule> | null = null;
let commentsIslandModulePromise: ReturnType<typeof importCommentsIslandModule> | null = null;

function scheduleIdleTask(task: () => void): number
{
    const idleWindow = window;
    if (typeof idleWindow.requestIdleCallback === 'function')
    {
        return idleWindow.requestIdleCallback(() => task(), { timeout: 800 });
    }

    return window.setTimeout(task, 180);
}

function clearIdleTask(taskId: number | null): void
{
    if (taskId === null)
    {
        return;
    }

    const idleWindow = window;
    if (typeof idleWindow.cancelIdleCallback === 'function')
    {
        idleWindow.cancelIdleCallback(taskId);
        return;
    }

    window.clearTimeout(taskId);
}

function loadCommentsIslandModule(): ReturnType<typeof importCommentsIslandModule>
{
    commentsIslandModulePromise ??= importCommentsIslandModule();
    return commentsIslandModulePromise;
}

function loadHomeHotArticlesIslandModule(): ReturnType<typeof importHomeHotArticlesIslandModule>
{
    homeHotArticlesIslandModulePromise ??= importHomeHotArticlesIslandModule();
    return homeHotArticlesIslandModulePromise;
}

async function mountHomeHotArticlesIslandLazy(
    routeKey: string,
    reason: 'viewport' | 'fallback',
    activationVersion = hotArticlesActivationVersion
): Promise<void>
{
    const module = await loadHomeHotArticlesIslandModule();
    if (activationVersion !== hotArticlesActivationVersion)
    {
        return;
    }

    await module.mountHomeHotArticlesIsland(routeKey);
    emitTelemetry('public_home_hot_articles_island_loaded', { reason }, 'info');
}

function unmountHomeHotArticlesIslandLazy(): void
{
    if (!homeHotArticlesIslandModulePromise)
    {
        return;
    }

    void homeHotArticlesIslandModulePromise
        .then((module) => module.unmountHomeHotArticlesIsland())
        .catch((e: unknown) =>
        {
            if (import.meta.env.DEV)
            {
                console.warn('[publicShell] unmount failed', e);
            }
        });
}

async function mountArticleCommentsIslandLazy(
    articleId: number | string,
    reason: 'viewport' | 'request' | 'fallback',
    activationVersion = commentsActivationVersion
): Promise<void>
{
    const module = await loadCommentsIslandModule();
    if (activationVersion !== commentsActivationVersion)
    {
        return;
    }

    await module.mountArticleCommentsIsland(articleId);
    emitTelemetry('public_comments_island_loaded', { reason }, 'info');
}

function unmountArticleCommentsIslandLazy(): void
{
    if (!commentsIslandModulePromise)
    {
        return;
    }

    void commentsIslandModulePromise
        .then((module) => module.unmountArticleCommentsIsland())
        .catch((e: unknown) =>
        {
            if (import.meta.env.DEV)
            {
                console.warn('[publicShell] unmount failed', e);
            }
        });
}

function clearArticleCommentsIslandActivation(): void
{
    commentsActivationVersion += 1;
    commentsIntersectionObserver?.disconnect();
    commentsIntersectionObserver = null;
    clearIdleTask(commentsIdleTask);
    commentsIdleTask = null;
    if (commentsFallbackTimer !== null)
    {
        window.clearTimeout(commentsFallbackTimer);
        commentsFallbackTimer = null;
    }
}

function clearHomeHotArticlesIslandActivation(): void
{
    hotArticlesActivationVersion += 1;
    hotArticlesIntersectionObserver?.disconnect();
    hotArticlesIntersectionObserver = null;
    clearIdleTask(hotArticlesIdleTask);
    hotArticlesIdleTask = null;
    if (hotArticlesFallbackTimer !== null)
    {
        window.clearTimeout(hotArticlesFallbackTimer);
        hotArticlesFallbackTimer = null;
    }
}

function stopArticleCommentsIslandObserver(): void
{
    commentsIntersectionObserver?.disconnect();
    commentsIntersectionObserver = null;
    clearIdleTask(commentsIdleTask);
    commentsIdleTask = null;
    if (commentsFallbackTimer !== null)
    {
        window.clearTimeout(commentsFallbackTimer);
        commentsFallbackTimer = null;
    }
}

function stopHomeHotArticlesIslandObserver(): void
{
    hotArticlesIntersectionObserver?.disconnect();
    hotArticlesIntersectionObserver = null;
    clearIdleTask(hotArticlesIdleTask);
    hotArticlesIdleTask = null;
    if (hotArticlesFallbackTimer !== null)
    {
        window.clearTimeout(hotArticlesFallbackTimer);
        hotArticlesFallbackTimer = null;
    }
}

function clearPublicFirstPaintFlag(): void
{
    document.body.removeAttribute('data-fsusblog-public-first-paint');
}

function isPublicShellDocument(): boolean
{
    return document.body.hasAttribute('data-fsusblog-public-shell');
}

function currentPublicShellFullPath(): string
{
    return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function readCurrentPublicShellPath(): string
{
    return currentPublicShellFullPath();
}

async function preparePublicShellLocalFixtureSession(): Promise<void>
{
    const searchParams = new URLSearchParams(window.location.search);
    if (isLocalFixtureQueryEnabled(searchParams.get('fsusLocalFixtureLogin')))
    {
        activateLocalFixtureSession();
    }

    if (!isLocalFixtureSessionActive())
    {
        return;
    }

    if (await ensureLocalFixtureSessionCookies(readCurrentPublicShellPath()))
    {
        return;
    }

    window.location.replace(buildLocalFixtureAdminUrl(readCurrentPublicShellPath()));
}

function requestPublicRoutePrewarm(target: string | null, reason: PublicRoutePrewarmReason): void
{
    if (!target || getPublicActivationOwner() === 'full-app')
    {
        return;
    }

    // Intent-targeted route preparation only. Idle core warming is a separate port.
    void warmPublicActivation(target, reason)
        .catch((e: unknown) =>
        {
            if (import.meta.env.DEV)
            {
                console.warn('[publicShell] unmount failed', e);
            }
        });
}

/**
 * Idle public boot warms FullApp core modules only.
 * Must not prewarm the current URL or fetch /api/public/navigation-snapshot.aeds
 * for the already-hydrated AOT page.
 */
function schedulePublicCoreIdleWarm(): void
{
    clearPublicCoreIdleWarm();
    publicRoutePrewarmIdleTask = scheduleIdleTask(() =>
    {
        publicRoutePrewarmIdleTask = null;
        if (getPublicActivationOwner() === 'full-app')
        {
            return;
        }
        void warmPublicFullAppCore()
            .catch((e: unknown) =>
            {
                if (import.meta.env.DEV)
                {
                    console.warn('[publicShell] core warm failed', e);
                }
            });
    });
}

function clearPublicCoreIdleWarm(): void
{
    clearIdleTask(publicRoutePrewarmIdleTask);
    publicRoutePrewarmIdleTask = null;
}

function requestPublicAnchorPrewarm(event: Event, reason: Extract<PublicRoutePrewarmReason, 'pointerenter' | 'focus'>): void
{
    if (!(event.target instanceof Element))
    {
        return;
    }

    const anchor = event.target.closest('a');
    if (!(anchor instanceof HTMLAnchorElement))
    {
        return;
    }

    requestPublicRoutePrewarm(resolvePublicRoutePrewarmTarget(anchor, event), reason);
}

function storeInitialPublicRouteSeed(payload: PublicHydrationPayload): void
{
    if (!hasCanonicalPublicSeedRenderTimestamp(payload))
    {
        throw new Error('public_aot_hydration_render_timestamp_invalid');
    }
    const kind = payload.pageKind;
    putPublicRouteSeed({
        kind,
        fullPath: currentPublicShellFullPath(),
        routeKey: payload.routeKey,
        seed: {
            bootstrap: null,
            hydration: payload
        }
    });
}

function waitForDocumentInteractive(): Promise<void>
{
    if (document.readyState !== 'loading')
    {
        return Promise.resolve();
    }

    return new Promise((resolve) =>
    {
        let fallbackTimer: number | null = window.setTimeout(() =>
        {
            fallbackTimer = null;
            complete();
        }, DOCUMENT_INTERACTIVE_FALLBACK_MS);

        const complete = (): void =>
        {
            document.removeEventListener('readystatechange', onReadyStateChange);
            document.removeEventListener('DOMContentLoaded', complete);
            if (fallbackTimer !== null)
            {
                window.clearTimeout(fallbackTimer);
                fallbackTimer = null;
            }
            resolve();
        };

        const onReadyStateChange = (): void =>
        {
            if (document.readyState !== 'loading')
            {
                complete();
            }
        };

        document.addEventListener('readystatechange', onReadyStateChange);
        document.addEventListener('DOMContentLoaded', complete, { once: true });
    });
}

function isPublicMicroRoute(href: string): boolean
{
    const target = new URL(href, window.location.origin);
    return isPublicSeoPath(target.pathname);
}

function navigateWithDocumentRequest(href: string): void
{
    window.location.assign(href);
}

function resolveShellActionNavigation(actionNode: HTMLElement): string | null
{
    const action = actionNode.dataset.aotAction;
    if (action !== 'page-prev' && action !== 'page-next')
    {
        return null;
    }

    const anchor = actionNode instanceof HTMLAnchorElement
        ? actionNode
        : actionNode.closest<HTMLAnchorElement>('a[href]');
    if (!anchor)
    {
        return null;
    }

    const target = new URL(anchor.href, window.location.href);
    const page = Number.parseInt(target.searchParams.get('page') ?? '1', 10);
    if (Number.isFinite(page) && page > 1 && !target.searchParams.get('cursor'))
    {
        return null;
    }

    return target.toString();
}

function clearDynamicIslands(): void
{
    clearHomeHotArticlesIslandActivation();
    clearArticleCommentsIslandActivation();
    unmountArticleCommentsIslandLazy();
    unmountHomeHotArticlesIslandLazy();
}

function resolveArticleCommentsIslandId(payload: PublicHydrationPayload): number | null
{
    if (payload.pageKind !== 'ArticleDetail')
    {
        return null;
    }

    const articleId = Number(payload.articleId);
    return Number.isFinite(articleId) && articleId > 0 ? Math.trunc(articleId) : null;
}

function resolveHomeHotArticlesTarget(): HTMLElement | null
{
    const slot = document.getElementById('fsus-home-hot-articles-slot-content');
    if (!(slot instanceof HTMLElement))
    {
        return null;
    }

    const sentinel = document.getElementById(HOME_HOT_ARTICLES_SENTINEL_ID);
    if (sentinel instanceof HTMLElement)
    {
        return sentinel;
    }

    return slot;
}

function scheduleHomeHotArticlesIsland(payload: PublicHydrationPayload): void
{
    if (payload.pageKind !== 'Home')
    {
        return;
    }

    const target = resolveHomeHotArticlesTarget();
    if (!target)
    {
        return;
    }

    const activationVersion = ++hotArticlesActivationVersion;
    const activate = (reason: 'viewport' | 'fallback') =>
    {
        stopHomeHotArticlesIslandObserver();
        hotArticlesIdleTask = scheduleIdleTask(() =>
        {
            hotArticlesIdleTask = null;
            void mountHomeHotArticlesIslandLazy(payload.routeKey, reason, activationVersion);
        });
    };

    if (typeof IntersectionObserver === 'undefined')
    {
        hotArticlesFallbackTimer = window.setTimeout(() =>
        {
            hotArticlesFallbackTimer = null;
            void mountHomeHotArticlesIslandLazy(payload.routeKey, 'fallback', activationVersion);
        }, HOME_HOT_ARTICLES_FALLBACK_DELAY_MS);
        return;
    }

    hotArticlesIntersectionObserver = new IntersectionObserver((entries) =>
    {
        if (entries.some((entry) => entry.isIntersecting || entry.intersectionRatio > 0))
        {
            activate('viewport');
        }
    }, {
        root: null,
        rootMargin: HOME_HOT_ARTICLES_ROOT_MARGIN,
        threshold: 0
    });
    hotArticlesIntersectionObserver.observe(target);
}

function scheduleArticleCommentsIsland(payload: PublicHydrationPayload): void
{
    const articleId = resolveArticleCommentsIslandId(payload);
    if (articleId === null)
    {
        return;
    }

    const host = document.getElementById('fsus-comments-island');
    if (!(host instanceof HTMLElement))
    {
        return;
    }

    const activationVersion = ++commentsActivationVersion;
    const activate = (reason: 'viewport' | 'request' | 'fallback') =>
    {
        stopArticleCommentsIslandObserver();
        void mountArticleCommentsIslandLazy(articleId, reason, activationVersion);
    };

    if (window.location.hash === '#comments')
    {
        activate('request');
        return;
    }

    if (typeof IntersectionObserver === 'undefined')
    {
        commentsFallbackTimer = window.setTimeout(() =>
        {
            commentsFallbackTimer = null;
            activate('fallback');
        }, COMMENTS_ISLAND_FALLBACK_DELAY_MS);
        return;
    }

    commentsIntersectionObserver = new IntersectionObserver((entries) =>
    {
        if (entries.some((entry) => entry.isIntersecting || entry.intersectionRatio > 0))
        {
            activate('viewport');
        }
    }, {
        root: null,
        rootMargin: '900px 0px 900px 0px',
        threshold: 0
    });
    commentsIntersectionObserver.observe(host);
}

function scheduleDynamicIslands(payload: PublicHydrationPayload | null): void
{
    clearHomeHotArticlesIslandActivation();
    clearArticleCommentsIslandActivation();

    if (!payload)
    {
        return;
    }

    if (payload.pageKind === 'Home')
    {
        scheduleHomeHotArticlesIsland(payload);
    }

    if (payload.pageKind === 'ArticleDetail')
    {
        scheduleArticleCommentsIsland(payload);
    }
}

async function navigateWithPublicIntent(
    intent: ReturnType<typeof classifyPublicNavigationIntent>,
    fallbackHref: string
): Promise<boolean>
{
    if (intent.kind === 'atomic-public-route')
    {
        clearDynamicIslands();
        await submitPublicActivationIntent({
            kind: 'navigate',
            source: intent.source,
            target: intent.fullPath
        });
        return true;
    }

    if (fallbackHref)
    {
        navigateWithDocumentRequest(fallbackHref);
        return true;
    }

    return false;
}

async function handleShellAction(actionNode: HTMLElement, anchor: HTMLAnchorElement | null): Promise<void>
{
    const action = actionNode.dataset.aotAction ?? '';
    if (!action)
    {
        return;
    }

    const actionHref = resolveShellActionNavigation(actionNode);
    if (actionHref)
    {
        dispatchAotActionEvent(actionNode);
        const intent = classifyPublicNavigationIntent({
            action,
            currentHref: window.location.href,
            href: actionHref,
            source: 'pagination'
        });
        await navigateWithPublicIntent(intent, actionHref);
        return;
    }

    if (action === 'activate-comments')
    {
        dispatchAotActionEvent(actionNode);
        const articleId = hydratedPayload?.pageKind === 'ArticleDetail'
            ? hydratedPayload.articleId
            : Number(actionNode.dataset.aotValue ?? actionNode.dataset.aotId ?? '0');
        clearArticleCommentsIslandActivation();
        const activationVersion = commentsActivationVersion;
        await mountArticleCommentsIslandLazy(articleId, 'request', activationVersion);
        return;
    }

    dispatchAotActionEvent(actionNode);
    if (anchor instanceof HTMLAnchorElement && isInternalAppLink(anchor) && isPublicMicroRoute(anchor.href))
    {
        const intent = classifyPublicNavigationIntent({
            action,
            anchor,
            currentHref: window.location.href,
            source: 'action'
        });
        await navigateWithPublicIntent(intent, anchor.href);
    }
}

export function bindPreBootstrapNavigation(): void
{
    if (preBootstrapNavigationBound)
    {
        return;
    }

    preBootstrapNavigationBound = true;
    addPublicShellEventListener(document, 'click', (event) =>
    {
        if (getPublicActivationOwner() === 'full-app')
        {
            return;
        }

        if (!(event.target instanceof Element) || isModifiedEvent(event))
        {
            return;
        }

        const themeModeNode = event.target.closest('[data-fsusblog-theme-mode]');
        if (themeModeNode instanceof HTMLElement)
        {
            const nextMode = themeModeNode.dataset.fsusblogThemeMode;
            if (nextMode === 'light' || nextMode === 'dark' || nextMode === 'system')
            {
                event.preventDefault();
                setThemeMode(nextMode);
            }
            return;
        }

        const actionNode = event.target.closest('[data-aot-action]');
        if (actionNode instanceof HTMLElement && !actionNode.hasAttribute('disabled'))
        {
            const anchor = actionNode.closest('a');

            const actionHref = resolveShellActionNavigation(actionNode);
            if (actionHref)
            {
                dispatchAotActionEvent(actionNode);
                event.preventDefault();
                const intent = classifyPublicNavigationIntent({
                    action: actionNode.dataset.aotAction ?? '',
                    currentHref: window.location.href,
                    event,
                    href: actionHref,
                    source: 'pagination'
                });
                void navigateWithPublicIntent(intent, actionHref);
                return;
            }

            event.preventDefault();
            void handleShellAction(actionNode, anchor instanceof HTMLAnchorElement ? anchor : null);
            return;
        }

        const anchor = event.target.closest('a');
        if (!(anchor instanceof HTMLAnchorElement) || !isInternalAppLink(anchor))
        {
            return;
        }

        if (!isPublicMicroRoute(anchor.href))
        {
            return;
        }

        const intent = classifyPublicNavigationIntent({
            anchor,
            currentHref: window.location.href,
            event,
            source: 'link'
        });
        if (intent.kind !== 'atomic-public-route')
        {
            return;
        }

        event.preventDefault();
        clearDynamicIslands();
        void submitPublicActivationIntent({
            kind: 'navigate',
            source: intent.source,
            target: intent.fullPath
        });
    }, { capture: true, passive: false });
    addPublicShellEventListener(document, 'pointerenter', (event) =>
    {
        requestPublicAnchorPrewarm(event, 'pointerenter');
    }, { capture: true, passive: true });
    addPublicShellEventListener(document, 'focusin', (event) =>
    {
        requestPublicAnchorPrewarm(event, 'focus');
    }, { passive: true });
}

async function hydratePublicShell(): Promise<void>
{
    const payload = await readPublicHydrationPayloadAsync();
    if (!payload)
    {
        return;
    }

    hydratedPayload = payload;
    storeInitialPublicRouteSeed(payload);
    const startedAt = performance.now();
    await hydratePublicPage(payload);
    reconcileThemeRuntimeAfterHydration();
    scheduleDynamicIslands(payload);
    const durationMs = Math.round(performance.now() - startedAt);
    emitRumMetric('hydration_time', {
        value: durationMs,
        durationMs
    });
    clearPublicFirstPaintFlag();
}

export type BootstrapPublicShellOptions = Readonly<{
    bootIntent?: PublicBootIntent | null;
}>;

export async function bootstrapPublicShell(options: BootstrapPublicShellOptions = {}): Promise<void>
{
    resetPublicShellLifetime();
    resetPublicShellRuntimeAuthState();
    onPublicShellLifetimeAbort(() =>
    {
        clearPublicCoreIdleWarm();
        clearDynamicIslands();
        preBootstrapNavigationBound = false;
    });

    ensureThemeRuntime();
    if (isPublicShellDocument())
    {
        document.body.setAttribute('data-fsusblog-public-first-paint', 'true');
    }
    bindPreBootstrapNavigation();
    schedulePublicCoreIdleWarm();
    adoptPublicBootIntent(options.bootIntent ?? null);
    const hydrateTask = (async () =>
    {
        await waitForDocumentInteractive();
        await preparePublicShellLocalFixtureSession();
        await hydratePublicShell();
    })();

    await ensurePublicShellStylesReady();
    removeGlobalLoader();

    try
    {
        await hydrateTask;
    }
    catch (error)
    {
        emitTelemetry('public_shell_hydration_failed', {
            error: error instanceof Error ? error.message : String(error)
        }, 'warn');
    }
}
