import { nextTick } from 'vue'
import type { RouteLocationNormalized, Router } from 'vue-router'
import { resolveMotionPreference } from '@ozwasyd/element-plus'
import { preloadPublicRoute } from './publicEntry'
import { runSiteViewTransition } from './viewTransition'

const prefetchBudgetMs = 220
const safetySettleMs = 1_000
const routeSurfaceSelector = '#page-content, .site-auth-main, .account-workspace-content, main.editor-page, main.canvas-workspace, main.media-page'

let pendingFallbackFade = false
let prefetchAbort: AbortController | undefined
let pendingUpdateResolve: (() => void) | undefined
let safetyTimer: number | undefined

function isEditorRoute(route: RouteLocationNormalized): boolean {
  return route.name === 'write' || route.name === 'article-workspace' || route.name === 'edit'
}

function isAdminOrWorkspaceRoute(route: RouteLocationNormalized): boolean {
  return route.meta.adminSection !== undefined ||
    route.path === '/admin' || route.path.startsWith('/admin/') ||
    route.path === '/user' || route.path.startsWith('/user/')
}

function needsWorkspacePreload(to: RouteLocationNormalized, from: RouteLocationNormalized): boolean {
  return to.name === 'login' ||
    to.name === 'register' ||
    isAdminOrWorkspaceRoute(to) ||
    isAdminOrWorkspaceRoute(from)
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

export function findActiveRouteSurface(): HTMLElement | null {
  return document.querySelector<HTMLElement>(routeSurfaceSelector)
}

export function focusRouteContent(): void {
  if (document.activeElement && document.activeElement !== document.body && document.activeElement !== document.documentElement) return
  findActiveRouteSurface()?.focus({ preventScroll: true })
}

export function consumeFallbackRouteFade(): boolean {
  const value = pendingFallbackFade
  pendingFallbackFade = false
  return value
}

export function installRouteTransitions(router: Router): void {
  router.beforeResolve(async (to, from) => {
    flushPendingUpdate()
    pendingFallbackFade = false
    prefetchAbort?.abort()
    prefetchAbort = undefined

    if (!from.name || to.path === from.path) return
    // Keep in-editor draft saves (write -> edit/:id) and tab switches instant so
    // a root snapshot never interrupts typing or cursor focus.
    if (isEditorRoute(from) && isEditorRoute(to)) return

    const controller = new AbortController()
    prefetchAbort = controller
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(prefetchBudgetMs)])

    let redirect: Awaited<ReturnType<typeof import('./workspacePreload')['preloadWorkspaceRoute']>>['redirect']
    if (needsWorkspacePreload(to, from)) {
      const workspaceModule = await import('./workspacePreload')
      if (controller.signal.aborted) return
      const [, outcome] = await Promise.all([
        preloadPublicRoute(to, signal),
        workspaceModule.preloadWorkspaceRoute(to, from, signal),
      ])
      redirect = outcome.redirect
    } else {
      await preloadPublicRoute(to, signal)
    }
    if (controller.signal.aborted) return
    if (redirect) return redirect

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
        void result.finished.finally(() => {
          focusRouteContent()
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
