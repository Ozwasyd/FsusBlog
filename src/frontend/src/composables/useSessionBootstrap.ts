import { computed } from 'vue'
import type { RouteLocationNormalizedLoaded } from 'vue-router'
import { useAppShellStore } from '@/store/appShell'
import { useAdminStore } from '@/store/admin'
import { useSiteStore } from '@/store/site'
import { useUserStore } from '@/store/user'

export function useSessionBootstrap() {
  const appShellStore = useAppShellStore()
  const adminStore = useAdminStore()
  const siteStore = useSiteStore()
  const userStore = useUserStore()

  const baseTitle = computed(() => siteStore.siteInfo.title || '站点')

  const needsBootstrap = (): boolean => {
    return !appShellStore.isReady || !userStore.isAuthChecked || !siteStore.isLoaded
  }

  const ensureBootstrap = async (force = false): Promise<void> => {
    await appShellStore.bootstrap(force)
  }

  const ensureSiteInfo = async (force = false): Promise<void> => {
    await siteStore.fetchSiteInfo(force)
  }

  const ensureUserInfo = async (force = false): Promise<void> => {
    await userStore.fetchUserInfo(force)
    await adminStore.ensureAdminSessionFresh(userStore.userInfo)
    appShellStore.syncAuthPhase()
  }

  const ensureUserInfoFresh = async (options?: { maxAgeMs?: number; forceWhenUnknown?: boolean }): Promise<void> => {
    await userStore.ensureUserInfoFresh(options)
    await adminStore.ensureAdminSessionFresh(userStore.userInfo)
    appShellStore.syncAuthPhase()
  }

  const syncDocumentTitle = (routeOrTitle?: RouteLocationNormalizedLoaded | string | null): string => {
    const pageTitle = typeof routeOrTitle === 'string'
      ? routeOrTitle
      : typeof routeOrTitle?.meta?.title === 'string'
        ? routeOrTitle.meta.title
        : ''

    const title = pageTitle ? `${pageTitle} - ${baseTitle.value}` : baseTitle.value
    if (typeof document !== 'undefined') {
      document.title = title
    }
    return title
  }

  return {
    appShellStore,
    adminStore,
    siteStore,
    userStore,
    baseTitle,
    needsBootstrap,
    ensureBootstrap,
    ensureSiteInfo,
    ensureUserInfo,
    ensureUserInfoFresh,
    syncDocumentTitle,
    syncAuthPhase: appShellStore.syncAuthPhase,
    setRuntimePhase: appShellStore.setRuntimePhase,
    markSessionRefreshing: appShellStore.markSessionRefreshing,
    markSessionActive: appShellStore.markSessionActive,
    markSessionExpired: appShellStore.markSessionExpired,
    setRiskPhase: appShellStore.setRiskPhase
  }
}
