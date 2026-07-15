import { emitTelemetry } from '@/services/telemetryBus'
import { resolveServiceWorkerScriptUrl } from '@/config/releaseStorage'
import type { CacheControlPayload, SearchIndexUpdatePayload } from '@/services/notificationStreamTypes'

export type SwControlMessage =
  | { type: 'shell.invalidate'; scope?: string | null }
  | { type: 'search-index.updated'; version: string; manifestUrl?: string; generatedAt?: string }
  | { type: 'asset.clear'; cache: string; keys?: string[] | null }
  | { type: 'privacy.clear'; reason: PrivateBrowserStateClearReason }

export type PrivateBrowserStateClearReason = 'logout' | 'session-expired' | 'shared-device'

type SwRuntimeMessage =
  | { type: 'search-index-ready'; version: string }
  | { type: 'shell-updated'; scope?: string | null }
  | { type: 'cache-cleared'; cache?: string | null }
  | { type: 'private-state-cleared' }

type SwMessageListener = (message: SwRuntimeMessage) => void

const listeners = new Set<SwMessageListener>()
let registrationPromise: Promise<ServiceWorkerRegistration | null> | null = null
let listenerBound = false
let unregisterPromise: Promise<void> | null = null
let updateScheduled = false

type ServiceWorkerIdleWindow = Window & typeof globalThis & {
  requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number
  __FSUSBLOG_DISABLE_SERVICE_WORKER__?: boolean
}

const SERVICE_WORKER_UPDATE_IDLE_TIMEOUT_MS = 30_000
const SERVICE_WORKER_UPDATE_FALLBACK_DELAY_MS = 1_500
const PRIVATE_BROWSER_CACHE_NAME_PATTERN = /^fsus-(?:shell|search|search-meta)-/i
const PRIVATE_OR_SENSITIVE_PATH_PATTERN = /^\/(?:api(?:\/|$)|user(?:\/|$)|admin(?:\/|$)|login(?:\/|$)|account(?:\/|$)|manage(?:\/|$)|author(?:\/|$)|private(?:\/|$)|notifications?(?:\/|$))/i

function bindListener(): void {
  if (listenerBound || typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return
  }

  listenerBound = true
  navigator.serviceWorker.addEventListener('message', (event: MessageEvent<SwRuntimeMessage>) => {
    const payload = event.data
    if (!payload || typeof payload.type !== 'string') {
      return
    }

    for (const listener of listeners) {
      listener(payload)
    }
  })
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!import.meta.env.PROD
    || typeof window === 'undefined'
    || (window as ServiceWorkerIdleWindow).__FSUSBLOG_DISABLE_SERVICE_WORKER__ === true
    || !('serviceWorker' in navigator)) {
    await unregisterDevServiceWorkers()
    return null
  }

  bindListener()
  if (!registrationPromise) {
    const base = (import.meta.env.BASE_URL || '/').replace(/\/?$/, '/')
    registrationPromise = navigator.serviceWorker.register(resolveServiceWorkerScriptUrl(
      base,
      import.meta.env.VITE_FSUSBLOG_BUILD_ID), {
      scope: '/',
      type: 'module',
      updateViaCache: 'none'
    }).then((registration) => {
      if (!registration) {
        return null
      }
      scheduleServiceWorkerUpdate(registration)
      return registration
    }).catch((error) => {
      emitTelemetry('service_worker_register_failed', {
        error: error instanceof Error ? error.message : String(error)
      }, 'warn')
      registrationPromise = null
      return null
    })
  }

  return await registrationPromise
}

function scheduleServiceWorkerUpdate(registration: ServiceWorkerRegistration): void {
  if (updateScheduled || typeof window === 'undefined') {
    return
  }

  updateScheduled = true
  const scheduleIdleUpdate = (): void => {
    const idleWindow = window as ServiceWorkerIdleWindow
    const runUpdate = (): void => {
      void registration.update().catch((error) => {
        emitTelemetry('service_worker_update_failed', {
          error: error instanceof Error ? error.message : String(error)
        }, 'warn')
      })
    }

    if (typeof idleWindow.requestIdleCallback === 'function') {
      idleWindow.requestIdleCallback(runUpdate, { timeout: SERVICE_WORKER_UPDATE_IDLE_TIMEOUT_MS })
      return
    }

    window.setTimeout(runUpdate, SERVICE_WORKER_UPDATE_FALLBACK_DELAY_MS)
  }

  if (document.readyState === 'complete') {
    scheduleIdleUpdate()
    return
  }

  window.addEventListener('load', scheduleIdleUpdate, { once: true })
}

async function unregisterDevServiceWorkers(): Promise<void> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return
  }

  if (!unregisterPromise) {
    unregisterPromise = (async () => {
      try {
        const registrations = await navigator.serviceWorker.getRegistrations()
        await Promise.all(registrations.map((registration) => registration.unregister()))

        if (typeof caches !== 'undefined') {
          const keys = await caches.keys()
          await Promise.all(
            keys
              .filter((key) => key.startsWith('fsus-'))
              .map((key) => caches.delete(key))
          )
        }
      } catch (error) {
        emitTelemetry('service_worker_unregister_failed', {
          error: error instanceof Error ? error.message : String(error)
        }, 'warn')
      }
    })()
  }

  await unregisterPromise
}

export function subscribeServiceWorkerMessages(listener: SwMessageListener): () => void {
  bindListener()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function postSwControlMessage(message: SwControlMessage): void {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return
  }

  void postSwControlMessageToAllWorkers(message)
}

async function postSwControlMessageToAllWorkers(message: SwControlMessage): Promise<void> {
  const workers = new Set<ServiceWorker>()
  if (navigator.serviceWorker.controller) {
    workers.add(navigator.serviceWorker.controller)
  }

  try {
    const registrations = await navigator.serviceWorker.getRegistrations()
    for (const registration of registrations) {
      if (registration.active) workers.add(registration.active)
      if (registration.waiting) workers.add(registration.waiting)
      if (registration.installing) workers.add(registration.installing)
    }
  } catch (error) {
    emitTelemetry('service_worker_control_targets_failed', {
      error: error instanceof Error ? error.message : String(error)
    }, 'warn')
  }

  for (const worker of workers) {
    try {
      worker.postMessage(message)
    } catch (error) {
      emitTelemetry('service_worker_control_message_failed', {
        type: message.type,
        error: error instanceof Error ? error.message : String(error)
      }, 'warn')
    }
  }
}

export async function clearPrivateBrowserState(reason: PrivateBrowserStateClearReason): Promise<void> {
  if (typeof window === 'undefined') {
    return
  }

  if ('serviceWorker' in navigator) {
    await postSwControlMessageToAllWorkers({ type: 'privacy.clear', reason })
  }

  if (typeof caches === 'undefined') {
    return
  }

  try {
    const cacheNames = await caches.keys()
    await Promise.all(cacheNames.map(async (cacheName) => {
      if (PRIVATE_BROWSER_CACHE_NAME_PATTERN.test(cacheName)) {
        await caches.delete(cacheName)
        return
      }

      if (!cacheName.startsWith('fsus-')) {
        return
      }

      const cache = await caches.open(cacheName)
      const requests = await cache.keys()
      await Promise.all(requests
        .filter((request) => PRIVATE_OR_SENSITIVE_PATH_PATTERN.test(new URL(request.url).pathname))
        .map((request) => cache.delete(request)))
    }))
  } catch (error) {
    emitTelemetry('service_worker_private_state_clear_failed', {
      reason,
      error: error instanceof Error ? error.message : String(error)
    }, 'warn')
  }
}

export function forwardCacheControlPayload(payload: CacheControlPayload): void {
  if (payload.type === 'asset.clear' && payload.cache) {
    postSwControlMessage({
      type: 'asset.clear',
      cache: payload.cache,
      keys: payload.keys ?? undefined
    })
    return
  }

  if (payload.type === 'search-index.updated') {
    postSwControlMessage({
      type: 'search-index.updated',
      version: payload.keys?.[0] ?? payload.scope ?? 'latest',
      manifestUrl: payload.cache ?? undefined,
      generatedAt: new Date().toISOString()
    })
    return
  }

  postSwControlMessage({
    type: 'shell.invalidate',
    scope: payload.scope ?? undefined
  })
}

export function forwardSearchIndexUpdate(payload: SearchIndexUpdatePayload): void {
  postSwControlMessage({
    type: 'search-index.updated',
    version: payload.version,
    manifestUrl: payload.manifestUrl,
    generatedAt: payload.generatedAt
  })
}
