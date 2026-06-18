import {
  createPublicTakeoverSnapshot,
  type PublicTakeoverSnapshot
} from '@/bootstrap/publicTakeoverSnapshot'
import {
  beginRouteReadiness,
  waitForRouteContentReady,
  type RouteReadinessResult
} from '@/bootstrap/routeReadiness'

export const DEFAULT_PUBLIC_TAKEOVER_ROUTE_READY_TIMEOUT_MS = 5000

export type PublicTakeoverVisualGuard = Readonly<{
  navigationId: string
  timeoutMs: number
  snapshot: PublicTakeoverSnapshot | null
}>

export class PublicTakeoverRouteReadinessError extends Error {
  readonly navigationId: string
  readonly result: Exclude<RouteReadinessResult, 'ready'>

  constructor(navigationId: string, result: Exclude<RouteReadinessResult, 'ready'>) {
    super(`public takeover route readiness ${result}: ${navigationId}`)
    this.name = 'PublicTakeoverRouteReadinessError'
    this.navigationId = navigationId
    this.result = result
  }
}

export function beginPublicTakeoverVisualGuard(options: {
  navigationId: string
  timeoutMs?: number
}): PublicTakeoverVisualGuard {
  beginRouteReadiness(options.navigationId)

  return {
    navigationId: options.navigationId,
    timeoutMs: options.timeoutMs ?? DEFAULT_PUBLIC_TAKEOVER_ROUTE_READY_TIMEOUT_MS,
    snapshot: createPublicTakeoverSnapshot()
  }
}

export async function waitForPublicTakeoverVisualReady(
  guard: PublicTakeoverVisualGuard | null
): Promise<void> {
  if (!guard) {
    return
  }

  const result = await waitForRouteContentReady(guard.navigationId, guard.timeoutMs)
  if (result !== 'ready') {
    throw new PublicTakeoverRouteReadinessError(guard.navigationId, result)
  }

  await guard.snapshot?.reveal()
}
