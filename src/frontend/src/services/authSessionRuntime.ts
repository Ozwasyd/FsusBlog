import { effectScope, watch, type EffectScope } from 'vue'
import type { Pinia } from 'pinia'
import { refreshToken } from '@/api/auth'
import { authBroadcastRuntime } from '@/services/authBroadcastRuntime'
import {
  disposeAuthBroadcastComposition,
  installAuthBroadcastComposition
} from '@/services/authBroadcastComposition'
import { useAppShellStore } from '@/store/appShell'
import { useAdminStore } from '@/store/admin'
import { useUserStore } from '@/store/user'
import { isAuthFailureError } from '@/utils/errorKinds'
import { ensureLocalFixtureSessionCookies, isLocalFixtureSessionActive } from '@/services/localFixtureSession'

const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000
const REFRESH_LEEWAY_MS = 2 * 60 * 1000
const MIN_REFRESH_DELAY_MS = 60 * 1000

class AuthSessionRuntime {
  private scope: EffectScope | null = null
  private timer: ReturnType<typeof window.setTimeout> | null = null
  private inflight: Promise<void> | null = null
  private pinia: Pinia | null = null

  init(pinia: Pinia): void {
    if (typeof window === 'undefined' || this.scope) {
      return
    }

    this.scope = effectScope()
    this.pinia = pinia
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
        () => userStore.isLoggedIn,
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
    const nextDelay = Math.max(MIN_REFRESH_DELAY_MS, ACCESS_TOKEN_TTL_MS - REFRESH_LEEWAY_MS)
    this.timer = window.setTimeout(() => {
      void this.refreshIfNeeded()
    }, nextDelay)
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer)
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

    const userStore = useUserStore()
    const appShellStore = useAppShellStore()
    if (!userStore.isLoggedIn) {
      this.stopTimer()
      return
    }

    this.inflight = (async () => {
      try {
        appShellStore.markSessionRefreshing()
        await refreshToken()
        appShellStore.markSessionActive()
        this.scheduleNextRefresh()
      } catch (error: unknown) {
        if (isAuthFailureError(error)) {
          userStore.markGuest()
          appShellStore.markSessionExpired()
          authBroadcastRuntime.broadcastExpired()
        } else {
          appShellStore.markSessionActive()
          this.stopTimer()
          this.timer = window.setTimeout(() => {
            void this.refreshIfNeeded()
          }, MIN_REFRESH_DELAY_MS)
        }
      } finally {
        this.inflight = null
      }
    })()

    return this.inflight
  }
}

export const authSessionRuntime = new AuthSessionRuntime()
