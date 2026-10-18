import { resolveServiceWorkerScriptUrl } from '@/config/releaseStorage';
import {
    purgeCommentPrivacyCredentialState,
    type CommentPrivacyCredentialPurgeReason
} from '@/privacy/commentPrivacyCredentialLifecycle';
import { deleteLegacyCommentPrivacyCredentialDatabases } from '@/privacy/commentPrivacyCredentialVault';
import { toTrustedServiceWorkerScriptUrl } from '@/security/trustedTypesRuntime';
import type { CacheControlPayload, SearchIndexUpdatePayload } from '@/services/notificationStreamTypes';
import {
    clearRegisteredPrivateState,
    type PrivateStorageCleanupItemResult,
    type PrivateStorageCleanupResult
} from '@/services/privateStorageRegistry';
import { emitTelemetry } from '@/services/telemetryBus';

export type SwControlMessage =
  | { type: 'shell.invalidate'; scope?: string | null; }
  | { type: 'search-index.updated'; version: string; manifestUrl?: string; generatedAt?: string; }
  | { type: 'asset.clear'; cache: string; keys?: string[] | null; }
  | { type: 'privacy.clear'; reason: PrivateBrowserStateClearReason; };

export type PrivateBrowserStateClearReason = CommentPrivacyCredentialPurgeReason | 'admin-logout';

export interface PrivateBrowserStateClearResult {
    registeredStorageCleared: boolean;
    credentialStateCleared: boolean;
    legacyCredentialDatabaseCleared: boolean;
    serviceWorkerAcknowledged: boolean;
    cacheStorageCleared: boolean;
    items: readonly PrivateStorageCleanupItemResult[];
}

type SwRuntimeMessage =
  | { type: 'search-index-ready'; version: string; }
  | { type: 'shell-updated'; scope?: string | null; }
  | { type: 'cache-cleared'; cache?: string | null; }
  | { type: 'private-state-cleared'; };

type SwMessageListener = (message: SwRuntimeMessage) => void;

const listeners = new Set<SwMessageListener>();
let registrationPromise: Promise<ServiceWorkerRegistration | null> | null = null;
let listenerBound = false;
let unregisterPromise: Promise<void> | null = null;
let updateScheduled = false;

type ServiceWorkerIdleWindow = Window & typeof globalThis & {
    requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
    __FSUSBLOG_DISABLE_SERVICE_WORKER__?: boolean;
};

const SERVICE_WORKER_UPDATE_IDLE_TIMEOUT_MS = 30_000;
const SERVICE_WORKER_UPDATE_FALLBACK_DELAY_MS = 1_500;
const SERVICE_WORKER_CONTROL_ACK_TIMEOUT_MS = 2_000;
function bindListener(): void
{
    if (listenerBound || typeof window === 'undefined' || !('serviceWorker' in navigator))
    {
        return;
    }

    listenerBound = true;
    navigator.serviceWorker.addEventListener('message', (event: MessageEvent<SwRuntimeMessage>) =>
    {
        const payload = event.data;
        if (!payload || typeof payload.type !== 'string')
        {
            return;
        }

        for (const listener of listeners)
        {
            listener(payload);
        }
    });
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null>
{
    if (!import.meta.env.PROD
    || typeof window === 'undefined'
    || (window as ServiceWorkerIdleWindow).__FSUSBLOG_DISABLE_SERVICE_WORKER__ === true
    || !('serviceWorker' in navigator))
    {
        await unregisterDevServiceWorkers();
        return null;
    }

    bindListener();
    if (!registrationPromise)
    {
        const base = (import.meta.env.BASE_URL || '/').replace(/\/?$/, '/');
        const scriptUrl = resolveServiceWorkerScriptUrl(
            base,
            import.meta.env.VITE_FSUSBLOG_BUILD_ID,
            true);
        registrationPromise = navigator.serviceWorker.register(toTrustedServiceWorkerScriptUrl(
            scriptUrl
        ) as string, {
            scope: '/',
            updateViaCache: 'none'
        }).then((registration) =>
        {
            if (!registration)
            {
                return null;
            }
            scheduleServiceWorkerUpdate(registration);
            return registration;
        }).catch((error) =>
        {
            emitTelemetry('service_worker_register_failed', {
                error: error instanceof Error ? error.message : String(error)
            }, 'warn');
            registrationPromise = null;
            return null;
        });
    }

    return await registrationPromise;
}

function scheduleServiceWorkerUpdate(registration: ServiceWorkerRegistration): void
{
    if (updateScheduled || typeof window === 'undefined')
    {
        return;
    }

    updateScheduled = true;
    const scheduleIdleUpdate = (): void =>
    {
        const idleWindow = window as ServiceWorkerIdleWindow;
        const runUpdate = (): void =>
        {
            void registration.update().catch((error) =>
            {
                emitTelemetry('service_worker_update_failed', {
                    error: error instanceof Error ? error.message : String(error)
                }, 'warn');
            });
        };

        if (typeof idleWindow.requestIdleCallback === 'function')
        {
            idleWindow.requestIdleCallback(runUpdate, { timeout: SERVICE_WORKER_UPDATE_IDLE_TIMEOUT_MS });
            return;
        }

        window.setTimeout(runUpdate, SERVICE_WORKER_UPDATE_FALLBACK_DELAY_MS);
    };

    if (document.readyState === 'complete')
    {
        scheduleIdleUpdate();
        return;
    }

    window.addEventListener('load', scheduleIdleUpdate, { once: true });
}

async function unregisterDevServiceWorkers(): Promise<void>
{
    if (typeof window === 'undefined' || !('serviceWorker' in navigator))
    {
        return;
    }

    unregisterPromise ??= (async () =>
    {
        try
        {
            const registrations = await navigator.serviceWorker.getRegistrations();
            await Promise.all(registrations.map((registration) => registration.unregister()));

            if (typeof caches !== 'undefined')
            {
                const keys = await caches.keys();
                await Promise.all(
                    keys
                        .filter((key) => key.startsWith('fsus-'))
                        .map((key) => caches.delete(key))
                );
            }
        }
        catch (error)
        {
            emitTelemetry('service_worker_unregister_failed', {
                error: error instanceof Error ? error.message : String(error)
            }, 'warn');
        }
    })();

    await unregisterPromise;
}

export function subscribeServiceWorkerMessages(listener: SwMessageListener): () => void
{
    bindListener();
    listeners.add(listener);
    return () =>
    {
        listeners.delete(listener);
    };
}

export function postSwControlMessage(message: SwControlMessage): void
{
    if (typeof window === 'undefined' || !('serviceWorker' in navigator))
    {
        return;
    }

    void postSwControlMessageToAllWorkers(message);
}

async function postSwControlMessageToAllWorkers(message: SwControlMessage): Promise<{
    targetCount: number;
    acknowledgedCount: number;
}>
{
    const workers = new Set<ServiceWorker>();
    if (navigator.serviceWorker.controller)
    {
        workers.add(navigator.serviceWorker.controller);
    }

    try
    {
        const registrations = await navigator.serviceWorker.getRegistrations();
        for (const registration of registrations)
        {
            if (registration.active)
            {
                workers.add(registration.active);
            }
            if (registration.waiting)
            {
                workers.add(registration.waiting);
            }
            if (registration.installing)
            {
                workers.add(registration.installing);
            }
        }
    }
    catch (error)
    {
        emitTelemetry('service_worker_control_targets_failed', {
            error: error instanceof Error ? error.message : String(error)
        }, 'warn');
    }

    const acknowledgements = await Promise.all([...workers].map(worker => postSwControlMessageWithAck(worker, message)));
    return {
        targetCount: workers.size,
        acknowledgedCount: acknowledgements.filter(Boolean).length
    };
}

export async function clearPrivateBrowserState(
    reason: PrivateBrowserStateClearReason,
    options: { broadcastCredentialPurge?: boolean; } = {}
): Promise<PrivateBrowserStateClearResult>
{
    const storageCleanup = clearRegisteredPrivateState({
        trigger: reason
    });
    const panicCachePurge = reason === 'panic'
        ? storageCleanup.then(() => clearEveryFsusBlogCache())
        : Promise.resolve(true);
    const credentialPurge = reason === 'admin-logout'
        ? Promise.resolve()
        : purgeCommentPrivacyCredentialState(reason, {
        broadcast: options.broadcastCredentialPurge !== false
      });
    const legacyDatabasePurge = reason === 'admin-logout'
        ? Promise.resolve()
        : deleteLegacyCommentPrivacyCredentialDatabases();
    const credentialPurgeStatus = cleanupStatus(credentialPurge);
    const legacyDatabasePurgeStatus = cleanupStatus(legacyDatabasePurge);
    const serviceWorkerPurge = reason !== 'admin-logout' && typeof window !== 'undefined' && 'serviceWorker' in navigator
        ? postSwControlMessageToAllWorkers({ type: 'privacy.clear', reason })
        : Promise.resolve({ targetCount: 0, acknowledgedCount: 0 });
    return await buildPrivateBrowserStateClearResult(
        credentialPurgeStatus,
        legacyDatabasePurgeStatus,
        serviceWorkerPurge,
        storageCleanup,
        panicCachePurge
    );
}

export async function panicWipePrivateBrowserState(): Promise<PrivateBrowserStateClearResult>
{
    return await clearPrivateBrowserState('panic');
}

async function postSwControlMessageWithAck(worker: ServiceWorker, message: SwControlMessage): Promise<boolean>
{
    if (typeof MessageChannel === 'undefined')
    {
        try
        {
            worker.postMessage(message);
        }
        catch
        {
            return false;
        }
        return false;
    }

    return await new Promise<boolean>((resolve) =>
    {
        const channel = new MessageChannel();
        let settled = false;
        const settle = (acknowledged: boolean): void =>
        {
            if (settled)
            {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            channel.port1.close();
            channel.port2.close();
            resolve(acknowledged);
        };
        const timeout = setTimeout(() => settle(false), SERVICE_WORKER_CONTROL_ACK_TIMEOUT_MS);
        channel.port1.onmessage = (event: MessageEvent) =>
        {
            const payload = event.data as { type?: unknown; controlType?: unknown; } | null;
            settle(payload?.type === 'control-complete' && payload.controlType === message.type);
        };
        channel.port1.start();
        try
        {
            worker.postMessage(message, [channel.port2]);
        }
        catch (error)
        {
            emitTelemetry('service_worker_control_message_failed', {
                type: message.type,
                error: error instanceof Error ? error.message : String(error)
            }, 'warn');
            settle(false);
        }
    });
}

async function cleanupStatus(promise: Promise<unknown>): Promise<boolean>
{
    try
    {
        await promise;
        return true;
    }
    catch
    {
        return false;
    }
}

async function clearEveryFsusBlogCache(): Promise<boolean>
{
    if (typeof caches === 'undefined')
    {
        return true;
    };
    try
    {
        const cacheNames = await caches.keys();
        const results = await Promise.all(cacheNames.map(async cacheName =>
            !cacheName.startsWith('fsus-') || await caches.delete(cacheName)));
        return results.every(Boolean);
    }
    catch
    {
        return false;
    }
}

async function buildPrivateBrowserStateClearResult(
    credentialPurgeStatus: Promise<boolean>,
    legacyDatabasePurgeStatus: Promise<boolean>,
    serviceWorkerPurge: Promise<{ targetCount: number; acknowledgedCount: number; }>,
    storageCleanup: Promise<PrivateStorageCleanupResult>,
    panicCachePurge: Promise<boolean>
): Promise<PrivateBrowserStateClearResult>
{
    const [credentialStateCleared, legacyCredentialDatabaseCleared, workerResult, registryResult, panicCachesCleared] = await Promise.all([
        credentialPurgeStatus,
        legacyDatabasePurgeStatus,
        serviceWorkerPurge,
        storageCleanup,
        panicCachePurge
    ]);
    const cacheStorageCleared = registryResult.items
        .filter(item => item.medium === 'cache-storage')
        .every(item => item.status !== 'failed') && panicCachesCleared;
    return {
        registeredStorageCleared: registryResult.complete,
        credentialStateCleared,
        legacyCredentialDatabaseCleared,
        serviceWorkerAcknowledged: workerResult.acknowledgedCount === workerResult.targetCount,
        cacheStorageCleared,
        items: registryResult.items
    };
}

export function forwardCacheControlPayload(payload: CacheControlPayload): void
{
    if (payload.type === 'asset.clear' && payload.cache)
    {
        postSwControlMessage({
            type: 'asset.clear',
            cache: payload.cache,
            keys: payload.keys ?? undefined
        });
        return;
    }

    if (payload.type === 'search-index.updated')
    {
        postSwControlMessage({
            type: 'search-index.updated',
            version: payload.keys?.[0] ?? payload.scope ?? 'latest',
            manifestUrl: payload.cache ?? undefined,
            generatedAt: new Date().toISOString()
        });
        return;
    }

    postSwControlMessage({
        type: 'shell.invalidate',
        scope: payload.scope ?? undefined
    });
}

export function forwardSearchIndexUpdate(payload: SearchIndexUpdatePayload): void
{
    postSwControlMessage({
        type: 'search-index.updated',
        version: payload.version,
        manifestUrl: payload.manifestUrl,
        generatedAt: payload.generatedAt
    });
}
