export type RouteReadinessResult = 'ready' | 'failed' | 'timeout'
export type RouteReadinessRouteLike = Readonly<{
  fullPath?: unknown
  path?: unknown
}>

type RouteReadinessEntry = {
  status: 'pending' | 'ready' | 'failed'
  waiters: Set<(result: Exclude<RouteReadinessResult, 'timeout'>) => void>
}

const routeReadinessEntries = new Map<string, RouteReadinessEntry>()

function normalizeNavigationId(navigationId: string): string {
  const normalized = navigationId.trim()
  return normalized.length > 0 ? normalized : '/'
}

function readBrowserNavigationId(): string {
  if (typeof window === 'undefined') {
    return '/'
  }

  return `${window.location.pathname}${window.location.search}${window.location.hash}` || '/'
}

export function resolveCurrentRouteReadinessNavigationId(route?: RouteReadinessRouteLike | null): string {
  if (typeof route?.fullPath === 'string' && route.fullPath.trim().length > 0) {
    return normalizeNavigationId(route.fullPath)
  }

  if (typeof route?.path === 'string' && route.path.trim().length > 0) {
    return normalizeNavigationId(route.path)
  }

  return normalizeNavigationId(readBrowserNavigationId())
}

function resolveRouteReadiness(
  navigationId: string,
  status: Exclude<RouteReadinessResult, 'timeout'>
): boolean {
  const key = normalizeNavigationId(navigationId)
  const entry = routeReadinessEntries.get(key)
  if (!entry || entry.status !== 'pending') {
    return false
  }

  entry.status = status
  for (const resolve of entry.waiters) {
    resolve(status)
  }
  entry.waiters.clear()
  return true
}

export function beginRouteReadiness(navigationId: string): void {
  routeReadinessEntries.set(normalizeNavigationId(navigationId), {
    status: 'pending',
    waiters: new Set()
  })
}

export function markRouteContentReady(navigationId: string): boolean {
  return resolveRouteReadiness(navigationId, 'ready')
}

export function markRouteFailed(navigationId: string): boolean {
  return resolveRouteReadiness(navigationId, 'failed')
}

export function markCurrentRouteContentReady(route?: RouteReadinessRouteLike | null): boolean {
  return markRouteContentReady(resolveCurrentRouteReadinessNavigationId(route))
}

export function markCurrentRouteFailed(route?: RouteReadinessRouteLike | null): boolean {
  return markRouteFailed(resolveCurrentRouteReadinessNavigationId(route))
}

export function waitForRouteContentReady(
  navigationId: string,
  timeoutMs: number
): Promise<RouteReadinessResult> {
  const key = normalizeNavigationId(navigationId)
  const entry = routeReadinessEntries.get(key)
  if (!entry) {
    return Promise.resolve('ready')
  }

  if (entry.status !== 'pending') {
    return Promise.resolve(entry.status)
  }

  return new Promise((resolve) => {
    const timeout = window.setTimeout(() => {
      entry.waiters.delete(onResolve)
      if (entry.status === 'pending') {
        routeReadinessEntries.delete(key)
        resolve('timeout')
      } else {
        resolve(entry.status)
      }
    }, Math.max(0, timeoutMs))

    const onResolve = (result: Exclude<RouteReadinessResult, 'timeout'>): void => {
      window.clearTimeout(timeout)
      resolve(result)
    }

    entry.waiters.add(onResolve)
  })
}

export function resetRouteReadinessForTests(): void {
  routeReadinessEntries.clear()
}
