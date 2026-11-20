import { nextTick } from 'vue'
import type { RouteLocationNormalized, Router } from 'vue-router'
import { resolveMotionPreference } from '@ozwasyd/element-plus'
import { preloadPublicRoute } from './publicEntry'
import { runSiteViewTransition } from './viewTransition'

const prefetchBudgetMs = 180
const safetySettleMs = 1_000

let pendingFallbackFade = false
let prefetchAbort: AbortController | undefined
let pendingUpdateResolve: (() => void) | undefined
let safetyTimer: number | undefined

function isPublicOrAuthRoute(route: RouteLocationNormalized): boolean {
  if (route.meta.adminSection !== undefined) return false
  if (route.path === '/admin' || route.path.startsWith('/admin/')) return false
  if (route.path === '/user' || route.path.startsWith('/user/')) return false
  return true
}

function flushPendingUpdate(): void {
  if (safetyTimer !== undefined) {
    window.clearTimeout(safetyTimer)
    safetyTimer = undefined
  }
  const resolve = pendingUpdateResolve
  pendingUpdateResolve = undefined
  resolve?.()
}

export function consumeFallbackRouteFade(): boolean {
  const value = pendingFallbackFade
  pendingFallbackFade = false
  return value
}

export function installPublicRouteTransitions(router: Router): void {
  router.beforeResolve(async (to, from) => {
    flushPendingUpdate()
    pendingFallbackFade = false
    prefetchAbort?.abort()
    prefetchAbort = undefined

    if (!from.name || to.path === from.path) return
    if (!isPublicOrAuthRoute(from) || !isPublicOrAuthRoute(to)) return

    const controller = new AbortController()
    prefetchAbort = controller
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(prefetchBudgetMs)])
    await preloadPublicRoute(to, signal)
    if (controller.signal.aborted) return

    if (document.visibilityState !== 'visible') return
    if (resolveMotionPreference().reduced) return

    const supportsViewTransition =
      typeof (document as Document & { startViewTransition?: unknown }).startViewTransition === 'function'

    if (supportsViewTransition) {
      await new Promise<void>(resolveReadyToCommit => {
        const updateDone = new Promise<void>(resolveUpdate => {
          pendingUpdateResolve = resolveUpdate
        })
        safetyTimer = window.setTimeout(flushPendingUpdate, safetySettleMs)
        const result = runSiteViewTransition(async () => {
          resolveReadyToCommit()
          await updateDone
          await nextTick()
          await nextTick()
        }, { name: 'route-crossfade' })
        void result.finished.then(() => {
          if (document.activeElement === document.body) {
            const target = document.querySelector<HTMLElement>('#page-content, .site-auth-main')
            target?.focus({ preventScroll: true })
          }
        })
      })
      return
    }

    pendingFallbackFade = true
  })

  router.afterEach(() => {
    flushPendingUpdate()
  })

  router.onError(() => {
    prefetchAbort?.abort()
    prefetchAbort = undefined
    pendingFallbackFade = false
    flushPendingUpdate()
  })
}
