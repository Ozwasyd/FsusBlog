import { computed, watch, type Ref, type WatchStopHandle } from 'vue'
import type { RouteLocationNormalizedLoaded } from 'vue-router'
import { useAppShellStore } from '@/store/appShell'
import { useAdminStore } from '@/store/admin'
import { useSiteStore } from '@/store/site'
import { useUserStore } from '@/store/user'
import { useI18nText } from '@/composables/useI18nText'
import { activeLocale, translate } from '@/locales'
import {
  createLocalFixtureAccountSnapshot,
  createLocalFixtureAdminPrincipal,
  isLocalFixtureAdminSessionActive,
  isLocalFixtureSessionActive
} from '@/services/localFixtureSession'

export interface AccountSessionEnsureOptions {
  force?: boolean
  maxAgeMs?: number
  forceWhenUnknown?: boolean
  reason?: 'bootstrap' | 'route' | 'interaction' | 'runtime'
}

export interface AdminSessionEnsureOptions {
  force?: boolean
  reason?: 'bootstrap' | 'route' | 'interaction' | 'runtime'
}

export function syncStaticDocumentTitleOnLocaleChange(
  route: Ref<RouteLocationNormalizedLoaded>,
  syncDocumentTitle: (route: RouteLocationNormalizedLoaded) => string
): WatchStopHandle {
  return watch(activeLocale, () => {
    if (route.value.meta.titleKey) {
      syncDocumentTitle(route.value)
    }
  })
}

export function useSessionBootstrap() {
  const appShellStore = useAppShellStore()
  const adminStore = useAdminStore()
  const siteStore = useSiteStore()
  const userStore = useUserStore()
  const { messages } = useI18nText()

  const baseTitle = computed(() => siteStore.siteInfo.title || messages.value.layout.siteHeader.fallbackTitle)

  const needsBootstrap = (): boolean => {
    return !appShellStore.isReady || !siteStore.isLoaded
  }

  const ensureBootstrap = async (force = false): Promise<void> => {
    await appShellStore.bootstrap(force)
  }

  const ensurePublicShell = async (force = false): Promise<void> => {
    await appShellStore.bootstrap(force)
    appShellStore.setRuntimePhase('shell-visible')
  }

  const ensureSiteInfo = async (force = false): Promise<void> => {
    await siteStore.fetchSiteInfo(force)
  }

  const ensureAccountSession = async (options: AccountSessionEnsureOptions = {}): Promise<void> => {
    if (isLocalFixtureSessionActive()) {
      if (!userStore.isLoggedIn) {
        userStore.markAuthenticated(createLocalFixtureAccountSnapshot())
      }
      appShellStore.syncAuthPhase()
      return
    }

    if (options.maxAgeMs !== undefined || options.forceWhenUnknown !== undefined) {
      await userStore.ensureUserInfoFresh({
        maxAgeMs: options.maxAgeMs,
        forceWhenUnknown: options.forceWhenUnknown
      })
    } else {
      await userStore.fetchUserInfo(options.force ?? false)
    }
    appShellStore.syncAuthPhase()
  }

  const ensureAdminSession = async (options: AdminSessionEnsureOptions = {}): Promise<void> => {
    if (isLocalFixtureSessionActive()) {
      if (isLocalFixtureAdminSessionActive()) {
        adminStore.setAdminPrincipal(createLocalFixtureAdminPrincipal())
      } else {
        adminStore.clearAdminPrincipal('missing')
      }
      return
    }

    await adminStore.ensureAdminSessionFresh({ force: options.force })
  }

  const ensureUserInfo = async (force = false): Promise<void> => {
    await ensureAccountSession({ force, reason: 'runtime' })
  }

  const ensureUserInfoFresh = async (options?: { maxAgeMs?: number; forceWhenUnknown?: boolean }): Promise<void> => {
    await ensureAccountSession({ ...options, reason: 'runtime' })
  }

  const syncDocumentTitle = (route?: RouteLocationNormalizedLoaded | null): string => {
    const pageTitle = route?.meta.titleKey
      ? translate(route.meta.titleKey)
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
    ensurePublicShell,
    ensureSiteInfo,
    ensureAccountSession,
    ensureAdminSession,
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
