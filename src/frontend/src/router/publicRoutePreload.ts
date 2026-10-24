import { decodePublicAotPayload, decodePublicAotPayloadBytes } from '@/bootstrap/publicAotBinaryPayload';
import { getPublicShellLifetimeSignal } from '@/bootstrap/publicShellLifetime';
import { activateLocaleRuntime, isSupportedLocale } from '@/locales';
import { getLocaleDescriptor, LOCALE_CATALOG_DIGEST } from '@/locales/localeCatalog';
import type { LocaleDomain } from '@/locales/localeDomains';
import { requiredLocaleDomainsForRoute } from '@/locales/routeLocaleDomains';
import { getSharedPublicPageManifestEntry } from '@/public-renderers/generated/publicPageManifest';
import type { PublicPageSeed } from '@/public-renderers/pageSeed';
import { PUBLIC_RENDERER_VERSION } from '@/public-renderers/publicEntryCore';
import type {
    PublicAotBootstrapPayloadFor,
    PublicHydrationPayloadFor
} from '@/public-renderers/publicPayloadTypes';
import { hasCanonicalPublicSeedRenderTimestamp } from '@/public-renderers/publicRenderClock';
import {
    PUBLIC_ROUTE_PRELOAD_DEFINITIONS,
    type PublicRoutePreloadDefinition
} from '@/public-renderers/publicRouteRegistry';
import {
    peekPublicRouteSeed,
    putPublicRouteSeed,
    type PublicRouteSeedKind
} from '@/public-renderers/publicRouteSeedStore';
import {
    hasPreparedPublicSeoHead,
    validateAndPreparePublicSeoHead,
    type PublicSeoHeadModel
} from '@/router/publicSeoHead';
import { emitTelemetry as emitRuntimeTelemetry } from '@/services/telemetryBus';

export type PublicRoutePrewarmReason = 'idle' | 'pointerenter' | 'focus' | 'search-focus' | 'atomic-navigation';
export type PublicRoutePrewarmStatus = 'ready' | 'miss' | 'cancelled' | 'timeout' | 'failure';

export type PublicNavigationSnapshotEnvelope = Readonly<{
    kind: 'public-navigation-snapshot';
    pageKind: PublicRouteSeedKind;
    pageId: number;
    routeKey: string;
    path: string;
    queryString: string;
    fullPath: string;
    canonicalPath: string;
    rendererVersion: string;
    frontendAssetVersion: string;
    renderLocale: string;
    localeCatalogDigest: string;
    payloadHash: string;
    generatedAtUtc: string;
    bootstrapPayload: string;
    hydrationPropsPayload: string;
    seoHead: PublicSeoHeadModel;
}>;

export type PublicRoutePrewarmResult = Readonly<{
    status: PublicRoutePrewarmStatus;
    target: string;
    reason: PublicRoutePrewarmReason;
    routeKind: PublicRouteSeedKind | null;
    routeComponentReady: boolean;
    seedReady: boolean;
    error?: string;
    routeComponentMs?: number;
    routeSnapshotMs?: number;
}>;

export type PublicRoutePreloadCandidate = Readonly<{
    name: PublicRoutePreloadDefinition['name'];
    kind: PublicRoutePreloadDefinition['kind'];
    path: string;
    preloadComponent: () => Promise<unknown>;
    criticalStyleHrefs?: readonly string[];
    match?: (url: URL) => boolean;
}>;

export type PublicRoutePrewarmOptions = Readonly<{
    reason: PublicRoutePrewarmReason;
    signal?: AbortSignal;
    timeoutMs?: number;
    nowMs?: number;
    preparedLocaleSnapshot?: Readonly<{
        locale: string;
        domains: readonly LocaleDomain[];
    }>;
}>;

type PublicRoutePrewarmerDependencies = Readonly<{
    routePreloads?: readonly PublicRoutePreloadCandidate[];
    fetchNavigationSnapshot?: (target: URL, signal: AbortSignal) => Promise<Uint8Array | ArrayBuffer>;
    preloadStyle?: (href: string, signal: AbortSignal) => Promise<void>;
    emitTelemetry?: (name: string, detail?: Record<string, unknown>, level?: 'info' | 'warn' | 'error') => void;
    lifetimeSignal?: () => AbortSignal;
    timeoutMs?: number;
}>;

type NormalizedPrewarmTarget = Readonly<{
    url: URL;
    fullPath: string;
    key: string;
}>;

const NAVIGATION_SNAPSHOT_MEDIA_TYPE = 'application/vnd.fsus.aeds';
const DEFAULT_PREWARM_TIMEOUT_MS = 5_000;
const snapshotHashEncoder = new TextEncoder();

function normalizeTarget(target: string | URL): NormalizedPrewarmTarget | null
{
    if (typeof window === 'undefined')
    {
        return null;
    }

    const baseOrigin = resolveBrowserOrigin();
    let url: URL;
    try
    {
        url = target instanceof URL ? target : new URL(target, baseOrigin);
    }
    catch
    {
        return null;
    }

    if (url.origin !== baseOrigin || url.pathname.startsWith('/api/'))
    {
        return null;
    }

    const pathname = url.pathname || '/';
    const fullPath = `${pathname}${url.search}`;
    return {
        url,
        fullPath,
        key: fullPath
    };
}

function resolveBrowserOrigin(): string
{
    const origin = window.location.origin;
    return origin && origin !== 'null' ? origin : 'http://127.0.0.1';
}

function matchRoutePattern(pattern: string, pathname: string): boolean
{
    const normalizedPath = pathname === '/' ? '/' : pathname.replace(/\/+$/u, '');
    if (pattern === '')
    {
        return normalizedPath === '/';
    }

    const routeSegments = pattern.split('/').filter(Boolean);
    const pathSegments = normalizedPath.split('/').filter(Boolean);
    if (routeSegments.length !== pathSegments.length)
    {
        return false;
    }

    return routeSegments.every((segment, index) =>
    {
        const value = pathSegments[index] ?? '';
        if (!segment.startsWith(':'))
        {
            return segment === value;
        }

        return segment.includes('\\d+')
            ? /^\d+$/u.test(value)
            : value.length > 0;
    });
}

function findRoutePreload(
    target: URL,
    routePreloads: readonly PublicRoutePreloadCandidate[]
): PublicRoutePreloadCandidate | null
{
    return routePreloads.find((candidate) =>
    {
        if (candidate.match)
        {
            return candidate.match(target);
        }

        return matchRoutePattern(candidate.path, target.pathname);
    }) ?? null;
}

function isAbortError(error: unknown): boolean
{
    return (error as { name?: string; } | null)?.name === 'AbortError';
}

function createLinkedAbortController(
    signals: readonly (AbortSignal | undefined)[]
): { controller: AbortController; dispose: () => void; }
{
    const controller = new AbortController();
    const listeners: (() => void)[] = [];

    for (const signal of signals)
    {
        if (!signal)
        {
            continue;
        }

        if (signal.aborted)
        {
            controller.abort(signal.reason);
            continue;
        }

        const listener = (): void => controller.abort(signal.reason);
        signal.addEventListener('abort', listener, { once: true });
        listeners.push(() => signal.removeEventListener('abort', listener));
    }

    return {
        controller,
        dispose: () =>
        {
            for (const cleanup of listeners)
            {
                cleanup();
            }
        }
    };
}

function throwIfAborted(signal: AbortSignal): void
{
    if (signal.aborted)
    {
        throw new DOMException('aborted', 'AbortError');
    }
}

function createAbortBarrier(signal: AbortSignal): {
    promise: Promise<never>;
    dispose: () => void;
}
{
    let rejectBarrier: (reason: DOMException) => void = () =>
    {
        // The Promise executor replaces this callback before abort is observed.
    };
    const promise = new Promise<never>((_resolve, reject) =>
    {
        rejectBarrier = reject;
    });
    const rejectForAbort = (): void =>
    {
        rejectBarrier(new DOMException('aborted', 'AbortError'));
    };
    if (signal.aborted)
    {
        rejectForAbort();
        return { promise, dispose: () =>
        {
            // No listener was registered for an already aborted signal.
        } };
    }

    signal.addEventListener('abort', rejectForAbort, { once: true });
    return {
        promise,
        dispose: () => signal.removeEventListener('abort', rejectForAbort)
    };
}

async function defaultFetchNavigationSnapshot(target: URL, signal: AbortSignal): Promise<Uint8Array>
{
    const endpoint = new URL('/api/public/navigation-snapshot.aeds', resolveBrowserOrigin());
    endpoint.searchParams.set('path', `${target.pathname}${target.search}`);
    const documentLocale = document.documentElement.lang;
    if (!isSupportedLocale(documentLocale))
    {
        throw new Error('navigation snapshot document locale unavailable');
    }
    const response = await fetch(endpoint.toString(), {
        headers: {
            Accept: NAVIGATION_SNAPSHOT_MEDIA_TYPE,
            'Accept-Language': documentLocale
        },
        credentials: 'same-origin',
        signal
    });

    if (!response.ok)
    {
        throw new Error(`navigation snapshot failed: ${response.status}`);
    }

    return new Uint8Array(await response.arrayBuffer());
}

function defaultPreloadStyle(href: string, signal: AbortSignal): Promise<void>
{
    return new Promise((resolve) =>
    {
        if (typeof document === 'undefined' || !href || signal.aborted)
        {
            resolve();
            return;
        }

        const absoluteHref = new URL(href, window.location.href).toString();
        const existing = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="preload"][as="style"]'))
            .some((link) => link.href === absoluteHref || link.getAttribute('href') === href);
        if (existing)
        {
            resolve();
            return;
        }

        const link = document.createElement('link');
        link.rel = 'preload';
        link.as = 'style';
        link.href = href;
        link.dataset.fsusPublicRoutePreload = 'style';
        document.head.appendChild(link);
        resolve();
    });
}

function decodeSnapshotSeed(envelope: PublicNavigationSnapshotEnvelope): PublicPageSeed<PublicRouteSeedKind> | null
{
    if (envelope.kind !== 'public-navigation-snapshot')
    {
        return null;
    }

    const bootstrap = decodePublicAotPayload<PublicAotBootstrapPayloadFor<PublicRouteSeedKind>>(
        envelope.bootstrapPayload
    );
    const hydration = decodePublicAotPayload<PublicHydrationPayloadFor<PublicRouteSeedKind>>(
        envelope.hydrationPropsPayload
    );
    if (!bootstrap || !hydration ||
      bootstrap.kind !== envelope.pageKind ||
      bootstrap.pageKind !== envelope.pageKind ||
      hydration.pageKind !== envelope.pageKind ||
      bootstrap.routeKey !== envelope.routeKey ||
      hydration.routeKey !== envelope.routeKey ||
      bootstrap.rendererVersion !== envelope.rendererVersion ||
      hydration.rendererVersion !== envelope.rendererVersion ||
      bootstrap.renderLocale !== envelope.renderLocale ||
      hydration.renderLocale !== envelope.renderLocale ||
      bootstrap.localeCatalogDigest !== envelope.localeCatalogDigest ||
      hydration.localeCatalogDigest !== envelope.localeCatalogDigest ||
      !hasCanonicalPublicSeedRenderTimestamp(bootstrap, hydration))
    {
        return null;
    }

    return {
        bootstrap,
        hydration
    };
}

export async function computePublicNavigationSnapshotPayloadHash(
    envelope: Omit<PublicNavigationSnapshotEnvelope, 'payloadHash' | 'generatedAtUtc'>
): Promise<string>
{
    const values = [
        envelope.pageKind,
        envelope.pageKind,
        envelope.routeKey,
        envelope.path,
        envelope.queryString,
        envelope.canonicalPath,
        envelope.rendererVersion,
        envelope.frontendAssetVersion,
        envelope.localeCatalogDigest,
        envelope.renderLocale,
        envelope.bootstrapPayload,
        envelope.hydrationPropsPayload,
        envelope.seoHead.digest
    ];
    const chunks = values.flatMap((value) => [new Uint8Array([0]), snapshotHashEncoder.encode(value)]);
    const byteLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    const payload = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks)
    {
        payload.set(chunk, offset);
        offset += chunk.byteLength;
    }
    const digest = await globalThis.crypto.subtle.digest('SHA-256', payload);
    return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
}

function isModifiedMouseEvent(event: Event | null | undefined): boolean
{
    if (!event || !('button' in event))
    {
        return false;
    }

    const mouseEvent = event as MouseEvent;
    return mouseEvent.defaultPrevented ||
    mouseEvent.button !== 0 ||
    mouseEvent.metaKey ||
    mouseEvent.ctrlKey ||
    mouseEvent.shiftKey ||
    mouseEvent.altKey;
}

export function resolvePublicRoutePrewarmTarget(anchor: HTMLAnchorElement, event?: Event | null): string | null
{
    if (isModifiedMouseEvent(event) || anchor.target && anchor.target !== '_self' || anchor.hasAttribute('download'))
    {
        return null;
    }

    const rawHref = anchor.getAttribute('href');
    if (!rawHref || rawHref.startsWith('#'))
    {
        return null;
    }

    const target = normalizeTarget(anchor.href);
    return target ? target.fullPath : null;
}

export function createPublicRoutePrewarmer(dependencies: PublicRoutePrewarmerDependencies = {})
{
    // In-flight only: settled promises are never retained as artifact validity.
    // Seed/head stores own consumable/TTL-bound readiness independently.
    const tasks = new Map<string, Promise<PublicRoutePrewarmResult>>();
    const routePreloads = dependencies.routePreloads ?? PUBLIC_ROUTE_PRELOAD_DEFINITIONS;
    const fetchNavigationSnapshot = dependencies.fetchNavigationSnapshot ?? defaultFetchNavigationSnapshot;
    const preloadStyle = dependencies.preloadStyle ?? defaultPreloadStyle;
    const emitTelemetry = dependencies.emitTelemetry ?? emitRuntimeTelemetry;
    const lifetimeSignal = dependencies.lifetimeSignal ?? getPublicShellLifetimeSignal;
    const defaultTimeoutMs = dependencies.timeoutMs ?? DEFAULT_PREWARM_TIMEOUT_MS;

    function emit(name: string, target: NormalizedPrewarmTarget, options: PublicRoutePrewarmOptions, extra: Record<string, unknown> = {}, level: 'info' | 'warn' | 'error' = 'info'): void
    {
        emitTelemetry(name, {
            target: target.fullPath,
            reason: options.reason,
            ...extra
        }, level);
    }

    function createResult(
        status: PublicRoutePrewarmStatus,
        target: NormalizedPrewarmTarget,
        options: PublicRoutePrewarmOptions,
        route: PublicRoutePreloadCandidate | null,
        state: {
            routeComponentReady: boolean;
            seedReady: boolean;
            routeComponentMs?: number;
            routeSnapshotMs?: number;
        },
        error?: unknown
    ): PublicRoutePrewarmResult
    {
        return {
            status,
            target: target.fullPath,
            reason: options.reason,
            routeKind: route?.kind ?? null,
            routeComponentReady: state.routeComponentReady,
            seedReady: state.seedReady,
            routeComponentMs: state.routeComponentMs,
            routeSnapshotMs: state.routeSnapshotMs,
            error: error === undefined ? undefined : failureMessage(error)
        };
    }

    function failureMessage(error: unknown): string
    {
        return error instanceof Error ? error.message : String(error);
    }

    function hasUsableRouteArtifacts(
        route: PublicRoutePreloadCandidate,
        target: NormalizedPrewarmTarget,
        nowMs?: number
    ): boolean
    {
        const seed = peekPublicRouteSeed(route.kind, { fullPath: target.fullPath }, {
            nowMs,
            rendererVersion: PUBLIC_RENDERER_VERSION
        });
        if (!seed)
        {
            return false;
        }

        return hasPreparedPublicSeoHead(target.fullPath, nowMs ?? Date.now());
    }

    function releaseInFlightTask(key: string, task: Promise<PublicRoutePrewarmResult>): void
    {
        if (tasks.get(key) === task)
        {
            tasks.delete(key);
        }
    }

    function prewarm(target: string | URL, options: PublicRoutePrewarmOptions): Promise<PublicRoutePrewarmResult>
    {
        const normalized = normalizeTarget(target);
        if (!normalized)
        {
            return Promise.resolve({
                status: 'miss',
                target: String(target),
                reason: options.reason,
                routeKind: null,
                routeComponentReady: false,
                seedReady: false
            });
        }

        const existing = tasks.get(normalized.key);
        if (existing)
        {
            emit('public_route_prewarm_inflight_hit', normalized, options);
            return existing;
        }

        const route = findRoutePreload(normalized.url, routePreloads);
        if (!route)
        {
            emit('public_route_prewarm_miss', normalized, options);
            return Promise.resolve(createResult('miss', normalized, options, null, {
                routeComponentReady: false,
                seedReady: false
            }));
        }

        // Reuse currently valid seed/head without resurrecting a historical ready Promise.
        // Component chunks remain the browser module cache's responsibility.
        if (hasUsableRouteArtifacts(route, normalized, options.nowMs))
        {
            const artifactResult = createResult('ready', normalized, options, route, {
                routeComponentReady: true,
                seedReady: true
            });
            emit('public_route_prewarm_artifact_ready', normalized, options, {
                routeKind: route.kind
            });
            return Promise.resolve(artifactResult);
        }

        emit('public_route_prewarm_start', normalized, options);
        const linked = createLinkedAbortController([
            options.signal,
            lifetimeSignal()
        ]);
        let timedOut = false;
        const timeoutMs = Math.max(1, options.timeoutMs ?? defaultTimeoutMs);
        const timeoutId = window.setTimeout(() =>
        {
            timedOut = true;
            linked.controller.abort('timeout');
        }, timeoutMs);

        const state = {
            routeComponentReady: false,
            seedReady: false,
            routeComponentMs: undefined as number | undefined,
            routeSnapshotMs: undefined as number | undefined
        };

        const matchedRoute = route;
        const task = (async (): Promise<PublicRoutePrewarmResult> =>
        {
            try
            {
                await Promise.all((matchedRoute.criticalStyleHrefs ?? []).map((href) => preloadStyle(href, linked.controller.signal)));
                throwIfAborted(linked.controller.signal);

                // Component chunk and navigation snapshot are independent producers.
                // Start both before either resolves; abort the sibling on hard failure.
                const producerFailure: { current: { stage: 'component' | 'snapshot'; error: unknown; } | null; } = { current: null };
                const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

                const componentTask = (async () =>
                {
                    const startedAt = nowMs();
                    try
                    {
                        await matchedRoute.preloadComponent();
                        state.routeComponentReady = true;
                        state.routeComponentMs = Math.max(0, nowMs() - startedAt);
                    }
                    catch (error)
                    {
                        state.routeComponentMs = Math.max(0, nowMs() - startedAt);
                        if (!isAbortError(error))
                        {
                            producerFailure.current ??= { stage: 'component', error };
                            if (!linked.controller.signal.aborted)
                            {
                                linked.controller.abort(error);
                            }
                        }
                        throw error;
                    }
                })();

                const snapshotTask = (async () =>
                {
                    const startedAt = nowMs();
                    try
                    {
                        const frame = await fetchNavigationSnapshot(normalized.url, linked.controller.signal);
                        state.routeSnapshotMs = Math.max(0, nowMs() - startedAt);
                        return frame;
                    }
                    catch (error)
                    {
                        state.routeSnapshotMs = Math.max(0, nowMs() - startedAt);
                        if (!isAbortError(error) && !linked.controller.signal.aborted)
                        {
                            producerFailure.current ??= { stage: 'snapshot', error };
                            linked.controller.abort(error);
                        }
                        throw error;
                    }
                })();

                let frame: Uint8Array | ArrayBuffer;
                const abortBarrier = createAbortBarrier(linked.controller.signal);
                try
                {
                    ;[, frame] = await Promise.race([
                        Promise.all([componentTask, snapshotTask]),
                        abortBarrier.promise
                    ]);
                }
                catch (error)
                {
                    if (producerFailure.current?.stage === 'component')
                    {
                        throw new Error(`route-component-failed: ${failureMessage(producerFailure.current.error)}`, { cause: error });
                    }
                    if (producerFailure.current?.stage === 'snapshot')
                    {
                        throw new Error(`route-snapshot-failed: ${failureMessage(producerFailure.current.error)}`, { cause: error });
                    }
                    throw error;
                }
                finally
                {
                    abortBarrier.dispose();
                }

                throwIfAborted(linked.controller.signal);
                const envelope = decodePublicAotPayloadBytes<PublicNavigationSnapshotEnvelope>(frame);
                const expectedPageId = getSharedPublicPageManifestEntry(matchedRoute.kind).pageId;
                if (envelope?.pageKind !== matchedRoute.kind ||
            envelope.pageId !== expectedPageId)
                {
                    throw new Error('route-snapshot-decode-failed: invalid navigation snapshot');
                }
                const seed = decodeSnapshotSeed(envelope);
                if (!seed)
                {
                    throw new Error('route-snapshot-decode-failed: invalid navigation snapshot seed');
                }
                const descriptor = isSupportedLocale(envelope.renderLocale)
                    ? getLocaleDescriptor(envelope.renderLocale)
                    : null;
                const expectedPayloadHash = await computePublicNavigationSnapshotPayloadHash(envelope);
                if (!descriptor ||
            envelope.localeCatalogDigest !== LOCALE_CATALOG_DIGEST ||
            envelope.payloadHash !== expectedPayloadHash ||
            envelope.seoHead.locale !== descriptor.documentLanguage ||
            envelope.seoHead.openGraph.locale !== descriptor.openGraphLocale)
                {
                    throw new Error('route-snapshot-decode-failed: invalid navigation snapshot locale identity');
                }

                const envelopeFullPath = envelope.fullPath || `${envelope.path}${envelope.queryString}`;
                if (normalizeTarget(envelopeFullPath)?.key !== normalizeTarget(normalized.fullPath)?.key ||
            !await validateAndPreparePublicSeoHead(
                envelope.seoHead,
                envelopeFullPath,
                envelope.canonicalPath,
                options.nowMs))
                {
                    throw new Error('route-seo-validation-failed: invalid navigation snapshot SEO head');
                }

                const requiredLocaleDomains = requiredLocaleDomainsForRoute({
                    name: matchedRoute.name,
                    path: normalized.url.pathname,
                    meta: { routeState: 'public-shareable' }
                });
                const stagedLocale = options.preparedLocaleSnapshot;
                const preparedLocale = stagedLocale
                    ? stagedLocale.locale
                    : await activateLocaleRuntime(descriptor.code, requiredLocaleDomains);
                throwIfAborted(linked.controller.signal);
                if (preparedLocale !== descriptor.code)
                {
                    throw new Error(
                        `route-snapshot-decode-failed: navigation snapshot locale mismatch:${preparedLocale}:${descriptor.code}`
                    );
                }
                if (stagedLocale)
                {
                    const missingDomains = requiredLocaleDomains.filter(
                        (domain) => !stagedLocale.domains.includes(domain)
                    );
                    if (missingDomains.length > 0)
                    {
                        throw new Error(
                            `route-snapshot-decode-failed: navigation snapshot locale domains missing:${missingDomains.join(',')}`
                        );
                    }
                }
                // Seed/head commit only after component + snapshot + validation all succeed
                // and the intent generation is still current.
                putPublicRouteSeed({
                    kind: envelope.pageKind,
                    fullPath: envelopeFullPath,
                    routeKey: envelope.routeKey,
                    rendererVersion: envelope.rendererVersion,
                    seed,
                    nowMs: options.nowMs
                });
                state.seedReady = true;
                emit('public_route_prewarm_ready', normalized, options, {
                    routeKind: envelope.pageKind,
                    route_component_ms: state.routeComponentMs,
                    route_snapshot_ms: state.routeSnapshotMs
                });
                return createResult('ready', normalized, options, matchedRoute, state);
            }
            catch (error)
            {
                if (timedOut)
                {
                    emit('public_route_prewarm_timeout', normalized, options, {
                        route_component_ms: state.routeComponentMs,
                        route_snapshot_ms: state.routeSnapshotMs
                    }, 'warn');
                    return createResult('timeout', normalized, options, matchedRoute, state, error);
                }

                if (isAbortError(error) ||
            (linked.controller.signal.aborted &&
              !(error instanceof Error && (
                  error.message.startsWith('route-component-failed:') ||
                error.message.startsWith('route-snapshot-failed:') ||
                error.message.startsWith('route-snapshot-decode-failed:') ||
                error.message.startsWith('route-seo-validation-failed:')
              ))))
                {
                    emit('public_route_prewarm_cancel', normalized, options, {
                        route_component_ms: state.routeComponentMs,
                        route_snapshot_ms: state.routeSnapshotMs
                    });
                    return createResult('cancelled', normalized, options, matchedRoute, state, error);
                }

                emit('public_route_prewarm_failure', normalized, options, {
                    error: error instanceof Error ? error.message : String(error),
                    route_component_ms: state.routeComponentMs,
                    route_snapshot_ms: state.routeSnapshotMs
                }, 'warn');
                return createResult('failure', normalized, options, matchedRoute, state, error);
            }
            finally
            {
                window.clearTimeout(timeoutId);
                linked.dispose();
            }
        })();

        tasks.set(normalized.key, task);
        void task.finally(() =>
        {
            releaseInFlightTask(normalized.key, task);
        });
        return task;
    }

    return {
        prewarm
    };
}

const defaultPublicRoutePrewarmer = createPublicRoutePrewarmer();

export function prewarmPublicRoute(target: string | URL, options: PublicRoutePrewarmOptions): Promise<PublicRoutePrewarmResult>
{
    return defaultPublicRoutePrewarmer.prewarm(target, options);
}

export type PublicRoutePrewarmPort = typeof prewarmPublicRoute;
