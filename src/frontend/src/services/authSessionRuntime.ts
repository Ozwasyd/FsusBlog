import { effectScope, watch, type EffectScope } from 'vue'
import type { Pinia } from 'pinia'
import { getMe, refreshToken } from '@/api/auth'
import {
  disposeAuthBroadcastComposition,
  installAuthBroadcastComposition
} from '@/services/authBroadcastComposition'
import { authBroadcastRuntime } from '@/services/authBroadcastRuntime'
import {
  createBrowserAuthRefreshCoordinator,
  type AuthRefreshCoordinator
} from '@/services/authRefreshCoordinator'
import { ensureLocalFixtureSessionCookies, isLocalFixtureSessionActive } from '@/services/localFixtureSession'
import { useAdminStore } from '@/store/admin'
import { useAppShellStore } from '@/store/appShell'
import { useUserStore } from '@/store/user'
import { AppErrorCode, createAppError } from '@/utils/appError'
import { isAuthFailureError } from '@/utils/errorKinds'

const REFRESH_LEEWAY_MS = 2 * 60 * 1000
const MIN_REFRESH_DELAY_MS = 1_000
const NETWORK_RETRY_BASE_MS = 5_000
const NETWORK_RETRY_MAX_MS = 60_000

class AuthSessionRuntime {
  private scope: EffectScope | null = null
  private timer: ReturnType<typeof globalThis.setTimeout> | null = null
  private inflight: Promise<void> | null = null
  private pinia: Pinia | null = null
  private coordinator: AuthRefreshCoordinator | null = null
  private networkFailureCount = 0
  private refreshOutcomeUnknown = false

  init(pinia: Pinia): void {
    if (typeof window === 'undefined' || this.scope) {
      return
    }

    this.scope = effectScope()
    this.pinia = pinia
    this.coordinator = createBrowserAuthRefreshCoordinator()
    installAuthBroadcastComposition(pinia)
    this.scope.run(() => {
      const userStore = useUserStore(pinia)
      const appShellStore = useAppShellStore(pinia)

      const syncTimer = (): void => {
        if (!userStore.isLoggedIn) {
          this.stopTimer()
          return
        }

        this.scheduleNextRefresh()
      }

      watch(
        () => [userStore.isLoggedIn, userStore.userInfo?.accessExpiresAtUtc] as const,
        () => {
          syncTimer()
        },
        { immediate: true }
      )

      document.addEventListener('visibilitychange', this.handleVisibilityChange)
      window.addEventListener('focus', this.handleWindowFocus)

      watch(
        () => appShellStore.sessionPhase,
        (phase) => {
          if (phase === 'expired') {
            this.stopTimer()
          }
        }
      )
    })
  }

  dispose(): void {
    this.stopTimer()
    document.removeEventListener('visibilitychange', this.handleVisibilityChange)
    window.removeEventListener('focus', this.handleWindowFocus)
    this.scope?.stop()
    this.scope = null
    this.pinia = null
    this.coordinator?.dispose()
    this.coordinator = null
    this.networkFailureCount = 0
    this.refreshOutcomeUnknown = false
    disposeAuthBroadcastComposition()
  }

  private handleVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') {
      this.invalidateNegativeCaches()
      void this.refreshIfNeeded()
    }
  }

  private handleWindowFocus = (): void => {
    this.invalidateNegativeCaches()
    void this.refreshIfNeeded()
  }

  private invalidateNegativeCaches(): void {
    if (!this.pinia) return

    useUserStore(this.pinia).invalidateGuestCache()
    useAdminStore(this.pinia).invalidateMissingCache()
  }

  private scheduleNextRefresh(): void {
    this.stopTimer()
    if (!this.pinia) return
    const expiry = Date.parse(useUserStore(this.pinia).userInfo?.accessExpiresAtUtc ?? '')
    if (!Number.isFinite(expiry)) return
    const nextDelay = Math.max(MIN_REFRESH_DELAY_MS, expiry - Date.now() - REFRESH_LEEWAY_MS)
    this.timer = globalThis.setTimeout(() => {
      void this.refreshIfNeeded()
    }, nextDelay)
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      globalThis.clearTimeout(this.timer)
      this.timer = null
    }
  }

  private async refreshIfNeeded(): Promise<void> {
    if (isLocalFixtureSessionActive()) {
      const appShellStore = useAppShellStore()
      if (await ensureLocalFixtureSessionCookies()) {
        appShellStore.markSessionActive()
      }
      this.stopTimer()
      return
    }

    if (this.inflight) {
      return this.inflight
    }

    if (!this.pinia || !this.coordinator) return
    const coordinator = this.coordinator
    const userStore = useUserStore(this.pinia)
    const appShellStore = useAppShellStore(this.pinia)
    if (!userStore.isLoggedIn) {
      this.stopTimer()
      return
    }

    this.inflight = (async () => {
      try {
        if (this.refreshOutcomeUnknown) {
          await this.revalidateSession(userStore)
          if (userStore.isLoggedIn && !this.isRefreshDue()) {
            this.refreshOutcomeUnknown = false
            this.networkFailureCount = 0
            appShellStore.markSessionActive()
            this.scheduleNextRefresh()
            return
          }
          if (userStore.accountState === 'guest') {
            throw authFailure('auth_refresh_unknown_outcome_expired')
          }
          this.scheduleNetworkRetry()
          return
        }

        if (!this.isRefreshDue()) {
          this.scheduleNextRefresh()
          return
        }

        appShellStore.markSessionRefreshing()
        await coordinator.coordinate({
          isRefreshDue: () => this.isRefreshDue(),
          refreshAndRevalidate: async () => {
            await refreshToken()
            await this.revalidateSession(userStore)
          },
          revalidate: async () => {
            await this.revalidateSession(userStore)
            if (this.isRefreshDue()) throw createAppError(AppErrorCode.Validation, 'auth_refresh_follower_revalidation_stale')
          }
        })
        this.networkFailureCount = 0
        this.refreshOutcomeUnknown = false
        appShellStore.markSessionActive()
        this.scheduleNextRefresh()
      } catch (error: unknown) {
        if (isAuthFailureError(error)) {
          if (userStore.accountState !== 'guest') {
            await userStore.expireAuthentication()
          }
          appShellStore.markSessionExpired()
          authBroadcastRuntime.broadcastExpired()
        } else {
          appShellStore.markSessionActive()
          this.refreshOutcomeUnknown = true
          this.scheduleNetworkRetry()
        }
      } finally {
        this.inflight = null
      }
    })()

    return this.inflight
  }

  private isRefreshDue(): boolean {
    if (!this.pinia) return false
    const expiry = Date.parse(useUserStore(this.pinia).userInfo?.accessExpiresAtUtc ?? '')
    return Number.isFinite(expiry) && expiry - Date.now() <= REFRESH_LEEWAY_MS
  }

  private async revalidateSession(userStore: ReturnType<typeof useUserStore>): Promise<void> {
    const snapshot = await getMe()
    userStore.markAuthenticated(snapshot)
  }

  private scheduleNetworkRetry(): void {
    this.stopTimer()
    const exponent = Math.min(this.networkFailureCount, 8)
    const delay = Math.min(NETWORK_RETRY_MAX_MS, NETWORK_RETRY_BASE_MS * (2 ** exponent))
    this.networkFailureCount += 1
    this.timer = globalThis.setTimeout(() => {
      void this.refreshIfNeeded()
    }, delay)
  }
}

function authFailure(message: string): Error & { name: 'BinaryTransportError'; kind: 'auth_failed' } {
  return Object.assign(new Error(message), {
    name: 'BinaryTransportError' as const,
    kind: 'auth_failed' as const
  })
}

export const authSessionRuntime = new AuthSessionRuntime()
