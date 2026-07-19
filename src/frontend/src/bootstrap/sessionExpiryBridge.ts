import type { Router } from 'vue-router'
import { resolveSafeRedirectTarget } from '@/security/privateNavigationPolicy'

export const SESSION_EXPIRED_EVENT = 'fsus:session-expired'

export type SessionExpiredDetail = Readonly<{
  currentPath: string
}>

export function dispatchSessionExpired(currentPath?: string): void {
  if (typeof window === 'undefined') return
  const path = currentPath ?? `${window.location.pathname}${window.location.search}${window.location.hash}`
  window.dispatchEvent(new window.CustomEvent<SessionExpiredDetail>(SESSION_EXPIRED_EVENT, {
    detail: { currentPath: path }
  }))
}

export function createSessionExpiredNavigationHandler(
  router: Router,
  isLoggedIn: () => boolean
): (event: Event) => void {
  return (event: Event): void => {
    const detail = (event as CustomEvent<SessionExpiredDetail>).detail
    const currentPath = resolveSafeRedirectTarget(
      router,
      detail?.currentPath || (typeof window === 'undefined' ? '/' : window.location.pathname),
      '/'
    )
    const currentRoute = router.currentRoute.value
    if (currentPath.includes('/login') || currentPath.includes('/register')) return

    if (isLoggedIn() || currentRoute.meta.requiresAuth === true) {
      void router.push({ path: '/login', query: { redirect: currentPath } })
    }
  }
}
