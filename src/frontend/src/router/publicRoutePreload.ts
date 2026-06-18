import { decodePublicAotPayload, decodePublicAotPayloadBytes } from '@/bootstrap/publicAotBinaryPayload'
import { getPublicShellLifetimeSignal } from '@/bootstrap/publicShellLifetime'
import { emitTelemetry as emitRuntimeTelemetry } from '@/services/telemetryBus'
import type { PublicPageSeed } from '@/public-renderers/pageSeed'
import type {
  PublicAotBootstrapPayloadFor,
  PublicHydrationPayloadFor
} from '@/public-renderers/publicPayloadTypes'
import {
  putPublicRouteSeed,
  type PublicRouteSeedKind
} from '@/public-renderers/publicRouteSeedStore'
import {
  PUBLIC_ROUTE_PRELOAD_DEFINITIONS,
  type PublicRoutePreloadDefinition
} from '@/public-renderers/publicRouteRegistry'

export type PublicRoutePrewarmReason = 'idle' | 'pointerenter' | 'focus' | 'search-focus' | 'atomic-navigation'
export type PublicRoutePrewarmStatus = 'ready' | 'miss' | 'cancelled' | 'timeout' | 'failure'

export type PublicNavigationSnapshotEnvelope = Readonly<{
  kind: 'public-navigation-snapshot'
  pageKind: PublicRouteSeedKind
  pageId: number
  routeKey: string
  path: string
  queryString: string
  fullPath: string
  canonicalPath: string
  rendererVersion: string
  frontendAssetVersion: string
  payloadHash: string
  generatedAtUtc: string
  bootstrapPayload: string
  hydrationPropsPayload: string
}>

export type PublicRoutePrewarmResult = Readonly<{
  status: PublicRoutePrewarmStatus
  target: string
  reason: PublicRoutePrewarmReason
  routeKind: PublicRouteSeedKind | null
  fullAppReady: boolean
  routeComponentReady: boolean
  seedReady: boolean
  error?: string
}>

export type PublicRoutePreloadCandidate = Readonly<{
  name: PublicRoutePreloadDefinition['name']
  kind: PublicRoutePreloadDefinition['kind']
  path: string
  preloadComponent: () => Promise<unknown>
  criticalStyleHrefs?: readonly string[]
  match?: (url: URL) => boolean
}>

type PublicRoutePrewarmOptions = Readonly<{
  reason: PublicRoutePrewarmReason
  signal?: AbortSignal
  timeoutMs?: number
  nowMs?: number
}>

type PublicRoutePrewarmerDependencies = Readonly<{
  loadFullApp?: () => Promise<unknown>
  routePreloads?: readonly PublicRoutePreloadCandidate[]
  fetchNavigationSnapshot?: (target: URL, signal: AbortSignal) => Promise<Uint8Array | ArrayBuffer>
  preloadStyle?: (href: string, signal: AbortSignal) => Promise<void>
  emitTelemetry?: (name: string, detail?: Record<string, unknown>, level?: 'info' | 'warn' | 'error') => void
  lifetimeSignal?: () => AbortSignal
  timeoutMs?: number
}>

type NormalizedPrewarmTarget = Readonly<{
  url: URL
  fullPath: string
  key: string
}>

const NAVIGATION_SNAPSHOT_MEDIA_TYPE = 'application/vnd.fsus.aeds'
const DEFAULT_PREWARM_TIMEOUT_MS = 5_000

function normalizeTarget(target: string | URL): NormalizedPrewarmTarget | null {
  if (typeof window === 'undefined') {
    return null
  }

  const baseOrigin = resolveBrowserOrigin()
  let url: URL
  try {
    url = target instanceof URL ? target : new URL(target, baseOrigin)
  } catch {
    return null
  }

  if (url.origin !== baseOrigin || url.pathname.startsWith('/api/')) {
    return null
  }

  const pathname = url.pathname || '/'
  const fullPath = `${pathname}${url.search}`
  return {
    url,
    fullPath,
    key: fullPath
  }
}

function resolveBrowserOrigin(): string {
  const origin = window.location.origin
  return origin && origin !== 'null' ? origin : 'http://127.0.0.1'
}

function matchRoutePattern(pattern: string, pathname: string): boolean {
  const normalizedPath = pathname === '/' ? '/' : pathname.replace(/\/+$/u, '')
  if (pattern === '') {
    return normalizedPath === '/'
  }

  const routeSegments = pattern.split('/').filter(Boolean)
  const pathSegments = normalizedPath.split('/').filter(Boolean)
  if (routeSegments.length !== pathSegments.length) {
    return false
  }

  return routeSegments.every((segment, index) => {
    const value = pathSegments[index] ?? ''
    if (!segment.startsWith(':')) {
      return segment === value
    }

    return segment.includes('\\d+')
      ? /^\d+$/u.test(value)
      : value.length > 0
  })
}

function findRoutePreload(
  target: URL,
  routePreloads: readonly PublicRoutePreloadCandidate[]
): PublicRoutePreloadCandidate | null {
  return routePreloads.find((candidate) => {
    if (candidate.match) {
      return candidate.match(target)
    }

    return matchRoutePattern(candidate.path, target.pathname)
  }) ?? null
}

function isAbortError(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === 'AbortError'
}

function createLinkedAbortController(
  signals: readonly (AbortSignal | undefined)[]
): { controller: AbortController, dispose: () => void } {
  const controller = new AbortController()
  const listeners: Array<() => void> = []

  for (const signal of signals) {
    if (!signal) {
      continue
    }

    if (signal.aborted) {
      controller.abort(signal.reason)
      continue
    }

    const listener = (): void => controller.abort(signal.reason)
    signal.addEventListener('abort', listener, { once: true })
    listeners.push(() => signal.removeEventListener('abort', listener))
  }

  return {
    controller,
    dispose: () => {
      for (const cleanup of listeners) {
        cleanup()
      }
    }
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('aborted', 'AbortError')
  }
}

async function defaultLoadFullApp(): Promise<unknown> {
  return await import('@/bootstrap/fullApp')
}

async function defaultFetchNavigationSnapshot(target: URL, signal: AbortSignal): Promise<Uint8Array> {
  const endpoint = new URL('/api/public/navigation-snapshot.aeds', resolveBrowserOrigin())
  endpoint.searchParams.set('path', `${target.pathname}${target.search}`)
  const response = await fetch(endpoint.toString(), {
    headers: {
      Accept: NAVIGATION_SNAPSHOT_MEDIA_TYPE
    },
    credentials: 'same-origin',
    signal
  })

  if (!response.ok) {
    throw new Error(`navigation snapshot failed: ${response.status}`)
  }

  return new Uint8Array(await response.arrayBuffer())
}

async function defaultPreloadStyle(href: string, signal: AbortSignal): Promise<void> {
  if (typeof document === 'undefined' || !href || signal.aborted) {
    return
  }

  const absoluteHref = new URL(href, window.location.href).toString()
  const existing = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="preload"][as="style"]'))
    .some((link) => link.href === absoluteHref || link.getAttribute('href') === href)
  if (existing) {
    return
  }

  const link = document.createElement('link')
  link.rel = 'preload'
  link.as = 'style'
  link.href = href
  link.dataset.fsusPublicRoutePreload = 'style'
  document.head.appendChild(link)
}

function decodeSnapshotSeed(envelope: PublicNavigationSnapshotEnvelope): PublicPageSeed<PublicRouteSeedKind> | null {
  if (envelope.kind !== 'public-navigation-snapshot') {
    return null
  }

  const bootstrap = decodePublicAotPayload<PublicAotBootstrapPayloadFor<PublicRouteSeedKind>>(
    envelope.bootstrapPayload
  )
  const hydration = decodePublicAotPayload<PublicHydrationPayloadFor<PublicRouteSeedKind>>(
    envelope.hydrationPropsPayload
  )
  if (!bootstrap && !hydration) {
    return null
  }

  return {
    bootstrap,
    hydration
  }
}

function isModifiedMouseEvent(event: Event | null | undefined): boolean {
  if (!event || !('button' in event)) {
    return false
  }

  const mouseEvent = event as MouseEvent
  return mouseEvent.defaultPrevented ||
    mouseEvent.button !== 0 ||
    mouseEvent.metaKey ||
    mouseEvent.ctrlKey ||
    mouseEvent.shiftKey ||
    mouseEvent.altKey
}

export function resolvePublicRoutePrewarmTarget(anchor: HTMLAnchorElement, event?: Event | null): string | null {
  if (isModifiedMouseEvent(event) || anchor.target && anchor.target !== '_self' || anchor.hasAttribute('download')) {
    return null
  }

  const rawHref = anchor.getAttribute('href')
  if (!rawHref || rawHref.startsWith('#')) {
    return null
  }

  const target = normalizeTarget(anchor.href)
  return target ? target.fullPath : null
}

export function createPublicRoutePrewarmer(dependencies: PublicRoutePrewarmerDependencies = {}) {
  const tasks = new Map<string, Promise<PublicRoutePrewarmResult>>()
  const routePreloads = dependencies.routePreloads ?? PUBLIC_ROUTE_PRELOAD_DEFINITIONS
  const loadFullApp = dependencies.loadFullApp ?? defaultLoadFullApp
  const fetchNavigationSnapshot = dependencies.fetchNavigationSnapshot ?? defaultFetchNavigationSnapshot
  const preloadStyle = dependencies.preloadStyle ?? defaultPreloadStyle
  const emitTelemetry = dependencies.emitTelemetry ?? emitRuntimeTelemetry
  const lifetimeSignal = dependencies.lifetimeSignal ?? getPublicShellLifetimeSignal
  const defaultTimeoutMs = dependencies.timeoutMs ?? DEFAULT_PREWARM_TIMEOUT_MS

  function emit(name: string, target: NormalizedPrewarmTarget, options: PublicRoutePrewarmOptions, extra: Record<string, unknown> = {}, level: 'info' | 'warn' | 'error' = 'info'): void {
    emitTelemetry(name, {
      target: target.fullPath,
      reason: options.reason,
      ...extra
    }, level)
  }

  function createResult(
    status: PublicRoutePrewarmStatus,
    target: NormalizedPrewarmTarget,
    options: PublicRoutePrewarmOptions,
    route: PublicRoutePreloadCandidate | null,
    state: { fullAppReady: boolean, routeComponentReady: boolean, seedReady: boolean },
    error?: unknown
  ): PublicRoutePrewarmResult {
    return {
      status,
      target: target.fullPath,
      reason: options.reason,
      routeKind: route?.kind ?? null,
      fullAppReady: state.fullAppReady,
      routeComponentReady: state.routeComponentReady,
      seedReady: state.seedReady,
      error: error instanceof Error ? error.message : error === undefined ? undefined : String(error)
    }
  }

  function prewarm(target: string | URL, options: PublicRoutePrewarmOptions): Promise<PublicRoutePrewarmResult> {
    const normalized = normalizeTarget(target)
    if (!normalized) {
      return Promise.resolve({
        status: 'miss',
        target: String(target),
        reason: options.reason,
        routeKind: null,
        fullAppReady: false,
        routeComponentReady: false,
        seedReady: false
      })
    }

    const existing = tasks.get(normalized.key)
    if (existing) {
      emit('public_route_prewarm_hit', normalized, options)
      return existing
    }

    emit('public_route_prewarm_start', normalized, options)
    const route = findRoutePreload(normalized.url, routePreloads)
    const linked = createLinkedAbortController([
      options.signal,
      lifetimeSignal()
    ])
    let timedOut = false
    const timeoutMs = Math.max(1, options.timeoutMs ?? defaultTimeoutMs)
    const timeoutId = window.setTimeout(() => {
      timedOut = true
      linked.controller.abort('timeout')
    }, timeoutMs)

    const state = {
      fullAppReady: false,
      routeComponentReady: false,
      seedReady: false
    }

    const task = (async (): Promise<PublicRoutePrewarmResult> => {
      try {
        await loadFullApp()
        state.fullAppReady = true
        throwIfAborted(linked.controller.signal)

        if (!route) {
          emit('public_route_prewarm_miss', normalized, options)
          return createResult('miss', normalized, options, null, state)
        }

        await Promise.all((route.criticalStyleHrefs ?? []).map((href) => preloadStyle(href, linked.controller.signal)))
        throwIfAborted(linked.controller.signal)
        await route.preloadComponent()
        state.routeComponentReady = true
        throwIfAborted(linked.controller.signal)

        const frame = await fetchNavigationSnapshot(normalized.url, linked.controller.signal)
        throwIfAborted(linked.controller.signal)
        const envelope = decodePublicAotPayloadBytes<PublicNavigationSnapshotEnvelope>(frame)
        const seed = envelope ? decodeSnapshotSeed(envelope) : null
        if (!envelope || !seed) {
          throw new Error('invalid navigation snapshot')
        }

        putPublicRouteSeed({
          kind: envelope.pageKind,
          fullPath: envelope.fullPath || `${envelope.path}${envelope.queryString}`,
          routeKey: envelope.routeKey,
          rendererVersion: envelope.rendererVersion,
          seed,
          nowMs: options.nowMs
        })
        state.seedReady = true
        emit('public_route_prewarm_ready', normalized, options, { routeKind: envelope.pageKind })
        return createResult('ready', normalized, options, route, state)
      } catch (error) {
        if (timedOut) {
          emit('public_route_prewarm_timeout', normalized, options, {}, 'warn')
          return createResult('timeout', normalized, options, route, state, error)
        }

        if (isAbortError(error) || linked.controller.signal.aborted) {
          emit('public_route_prewarm_cancel', normalized, options)
          return createResult('cancelled', normalized, options, route, state, error)
        }

        emit('public_route_prewarm_failure', normalized, options, {
          error: error instanceof Error ? error.message : String(error)
        }, 'warn')
        return createResult('failure', normalized, options, route, state, error)
      } finally {
        window.clearTimeout(timeoutId)
        linked.dispose()
      }
    })()

    tasks.set(normalized.key, task)
    void task.then((result) => {
      if (result.status !== 'ready' && result.status !== 'miss') {
        tasks.delete(normalized.key)
      }
    })
    return task
  }

  return {
    prewarm
  }
}

const defaultPublicRoutePrewarmer = createPublicRoutePrewarmer()

export function prewarmPublicRoute(target: string | URL, options: PublicRoutePrewarmOptions): Promise<PublicRoutePrewarmResult> {
  return defaultPublicRoutePrewarmer.prewarm(target, options)
}
