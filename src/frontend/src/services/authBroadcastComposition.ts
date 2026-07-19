import type { Pinia } from 'pinia'
import { authBroadcastRuntime, type AuthBroadcastEventOrigin } from './authBroadcastRuntime'
import { notificationStreamRuntime } from './notificationStreamRuntime'
import { clearLocalFixtureAdminSession, clearLocalFixtureSession } from './localFixtureSession'
import { clearPrivateBrowserState } from './serviceWorkerRuntime'
import { defaultChallengeProofStore } from '@/security/challenge-proof-store'
import { useAdminStore } from '@/store/admin'
import { useAppShellStore } from '@/store/appShell'
import { useNotificationStreamStore } from '@/store/notificationStream'
import { useUserStore } from '@/store/user'
import { dispatchSessionExpired } from '@/bootstrap/sessionExpiryBridge'
import { dispatchAdminLogout } from '@/bootstrap/adminLogoutBridge'

let activePinia: Pinia | null = null
let unsubscribe: (() => void) | null = null

export function installAuthBroadcastComposition(pinia: Pinia): void {
  if (activePinia === pinia && unsubscribe) {
    return
  }

  disposeAuthBroadcastComposition()
  activePinia = pinia

  const userStore = useUserStore(pinia)
  const adminStore = useAdminStore(pinia)
  const appShellStore = useAppShellStore(pinia)
  const notificationStore = useNotificationStreamStore(pinia)

  const stopAuthenticatedRuntime = (): void => {
    notificationStore.dispose()
    notificationStore.resetCursor()
    notificationStore.setStatus('stopped')
    void notificationStreamRuntime.stop(true)
  }

  unsubscribe = authBroadcastRuntime.subscribe((event, origin) => {
    defaultChallengeProofStore.clear()
    if (event.type === 'admin-logout') {
      if (origin === 'remote') {
        clearLocalFixtureAdminSession()
        adminStore.clearAdminPrincipal()
        void clearPrivateStateForBroadcast('logout', origin)
      }
      dispatchAdminLogout()
      return
    }

    if (event.type === 'admin-changed') {
      userStore.invalidateGuestCache()
      adminStore.invalidateMissingCache()
      return
    }

    // Any authentication transition can reflect a Cookie/Session change made
    // by another tab, Passkey completion, or admin step-up. Neither negative
    // cache is allowed to outlive that transition.
    userStore.invalidateGuestCache()
    adminStore.invalidateMissingCache()

    if (event.type === 'login') {
      void clearPrivateStateForBroadcast('account-switch', origin)
      if (origin === 'remote') {
        userStore.invalidateIdentityCache()
        dispatchSessionExpired()
      }
      return
    }

    if (event.type === 'user-expired') {
      clearLocalFixtureSession()
      void userStore.expireAuthentication({ broadcastCredentialPurge: origin !== 'remote' })
      appShellStore.markSessionExpired()
      stopAuthenticatedRuntime()
      if (origin === 'remote') dispatchSessionExpired()
      return
    }

    if (event.type === 'expired') {
      if (origin === 'remote') {
        void userStore.expireAuthentication({ broadcastCredentialPurge: false })
      } else {
        // The initiating runtime already advanced authGeneration and cleared
        // private state before publishing. Restore the terminal guest state
        // after the generic negative-cache invalidation above.
        userStore.markGuest()
      }
    } else {
      userStore.markGuest()
      void clearPrivateStateForBroadcast('logout', origin)
    }
    stopAuthenticatedRuntime()
    if (origin === 'remote') dispatchSessionExpired()
  })

  userStore.setLogoutBroadcast(() => authBroadcastRuntime.broadcastLogout())
  adminStore.setLogoutBroadcast(() => authBroadcastRuntime.broadcastAdminLogout())
  notificationStore.setSessionRevokedHandler(() => authBroadcastRuntime.expireUserSession())
}

export function disposeAuthBroadcastComposition(): void {
  if (activePinia) {
    useUserStore(activePinia).setLogoutBroadcast(null)
    useAdminStore(activePinia).setLogoutBroadcast(null)
    useNotificationStreamStore(activePinia).setSessionRevokedHandler(null)
  }
  unsubscribe?.()
  unsubscribe = null
  activePinia = null
}

function clearPrivateStateForBroadcast(
  reason: 'account-switch' | 'logout' | 'session-expired',
  origin: AuthBroadcastEventOrigin
): Promise<void> {
  const clear = origin === 'remote'
    ? clearPrivateBrowserState(reason, { broadcastCredentialPurge: false })
    : clearPrivateBrowserState(reason)
  return clear.then(() => undefined)
}
