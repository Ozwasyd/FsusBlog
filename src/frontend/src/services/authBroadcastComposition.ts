import type { Pinia } from 'pinia'
import { authBroadcastRuntime, type AuthBroadcastEventOrigin } from './authBroadcastRuntime'
import { notificationStreamRuntime } from './notificationStreamRuntime'
import { clearLocalFixtureSession } from './localFixtureSession'
import { clearPrivateBrowserState } from './serviceWorkerRuntime'
import { defaultChallengeProofStore } from '@/security/challenge-proof-store'
import { useAdminStore } from '@/store/admin'
import { useAppShellStore } from '@/store/appShell'
import { useNotificationStreamStore } from '@/store/notificationStream'
import { useUserStore } from '@/store/user'
import { dispatchSessionExpired } from '@/bootstrap/sessionExpiryBridge'

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

    if (event.type === 'admin-changed') {
      return
    }

    if (event.type === 'user-expired') {
      clearLocalFixtureSession()
      userStore.markGuest()
      appShellStore.markSessionExpired()
      void clearPrivateStateForBroadcast('session-expired', origin)
      stopAuthenticatedRuntime()
      if (origin === 'remote') dispatchSessionExpired()
      return
    }

    userStore.markGuest()
    void clearPrivateStateForBroadcast(event.type === 'expired' ? 'session-expired' : 'logout', origin)
    stopAuthenticatedRuntime()
    if (origin === 'remote') dispatchSessionExpired()
  })

  userStore.setLogoutBroadcast(() => authBroadcastRuntime.broadcastLogout())
  notificationStore.setSessionRevokedHandler(() => authBroadcastRuntime.expireUserSession())
}

export function disposeAuthBroadcastComposition(): void {
  if (activePinia) {
    useUserStore(activePinia).setLogoutBroadcast(null)
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
  return origin === 'remote'
    ? clearPrivateBrowserState(reason, { broadcastCredentialPurge: false })
    : clearPrivateBrowserState(reason)
}
