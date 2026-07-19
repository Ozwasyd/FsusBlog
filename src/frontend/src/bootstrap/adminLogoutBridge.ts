import type { Router } from 'vue-router'

export const ADMIN_LOGOUT_EVENT = 'fsus:admin-logout'

export function dispatchAdminLogout(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new window.CustomEvent(ADMIN_LOGOUT_EVENT))
}

export function createAdminLogoutNavigationHandler(
  router: Router,
  isAccountLoggedIn: () => boolean
): () => void {
  return (): void => {
    const currentRoute = router.currentRoute.value
    if (currentRoute.meta.accountArea !== 'manage') {
      return
    }

    void router.replace(isAccountLoggedIn() ? '/user/identity' : '/')
  }
}
