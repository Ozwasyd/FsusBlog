import type { Pinia } from 'pinia'
import { notificationStreamRuntime } from '@/services/notificationStreamRuntime'
import { useAdminStore } from '@/store/admin'
import { useAppShellStore } from '@/store/appShell'
import { useNotificationStreamStore } from '@/store/notificationStream'
import { useUserStore } from '@/store/user'
import { clearPrivateBrowserState } from '@/services/serviceWorkerRuntime'
import { clearLocalFixtureSession } from '@/services/localFixtureSession'
import { defaultChallengeProofStore } from '@/security/challenge-proof-store'

export type AuthBroadcastEvent =
  | { type: 'login'; at: number }
  | { type: 'logout'; at: number }
  | { type: 'expired'; at: number }
  | { type: 'user-expired'; at: number }
  | { type: 'admin-changed'; at: number }

const AUTH_BROADCAST_CHANNEL = 'fsus-auth'
const AUTH_BROADCAST_STORAGE_KEY = 'fsus:auth:broadcast'

type BroadcastChannelConstructor = new (name: string) => BroadcastChannel

function isAuthBroadcastEvent(value: unknown): value is AuthBroadcastEvent {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const candidate = value as Partial<AuthBroadcastEvent>
  return (
    (candidate.type === 'login'
      || candidate.type === 'logout'
      || candidate.type === 'expired'
      || candidate.type === 'user-expired'
      || candidate.type === 'admin-changed')
    && typeof candidate.at === 'number'
    && Number.isFinite(candidate.at)
  )
}

function createEvent(type: AuthBroadcastEvent['type']): AuthBroadcastEvent {
  return {
    type,
    at: Date.now()
  }
}

class AuthBroadcastRuntime {
  private pinia: Pinia | null = null
  private channel: BroadcastChannel | null = null
  private storageListenerInstalled = false

  init(pinia: Pinia): void {
    if (typeof window === 'undefined' || this.pinia) {
      return
    }

    this.pinia = pinia
    const BroadcastChannelImpl = (window as Window & {
      BroadcastChannel?: BroadcastChannelConstructor
    }).BroadcastChannel

    if (typeof BroadcastChannelImpl === 'function') {
      this.channel = new BroadcastChannelImpl(AUTH_BROADCAST_CHANNEL)
      this.channel.addEventListener('message', this.handleChannelMessage)
      return
    }

    window.addEventListener('storage', this.handleStorageEvent)
    this.storageListenerInstalled = true
  }

  dispose(): void {
    this.channel?.removeEventListener('message', this.handleChannelMessage)
    this.channel?.close()
    this.channel = null

    if (this.storageListenerInstalled && typeof window !== 'undefined') {
      window.removeEventListener('storage', this.handleStorageEvent)
    }
    this.storageListenerInstalled = false
    this.pinia = null
  }

  broadcastLogin(): void {
    defaultChallengeProofStore.clear()
    void clearPrivateBrowserState('account-switch')
    this.broadcast(createEvent('login'))
  }

  broadcastLogout(): void {
    defaultChallengeProofStore.clear()
    this.broadcast(createEvent('logout'))
  }

  broadcastExpired(): void {
    defaultChallengeProofStore.clear()
    void clearPrivateBrowserState('session-expired')
    this.broadcast(createEvent('expired'))
  }

  expireUserSession(): void {
    defaultChallengeProofStore.clear()
    void clearPrivateBrowserState('session-expired')
    const event = createEvent('user-expired')
    this.handleAuthBroadcastEvent(event)
    this.broadcast(event)
  }

  broadcastAdminChanged(): void {
    defaultChallengeProofStore.clear()
    this.broadcast(createEvent('admin-changed'))
  }

  handleAuthBroadcastEvent(event: AuthBroadcastEvent): void {
    defaultChallengeProofStore.clear()
    if (!this.pinia) {
      return
    }

    const userStore = useUserStore(this.pinia)
    const adminStore = useAdminStore(this.pinia)

    if (event.type === 'login') {
      void clearPrivateBrowserState('account-switch', { broadcastCredentialPurge: false })
      userStore.invalidateGuestCache()
      adminStore.invalidateMissingCache()
      return
    }

    if (event.type === 'admin-changed') {
      adminStore.invalidateMissingCache()
      return
    }

    if (event.type === 'user-expired') {
      clearLocalFixtureSession()
      userStore.markGuest()
      void clearPrivateBrowserState('session-expired', { broadcastCredentialPurge: false })
      useAppShellStore(this.pinia).markSessionExpired()
      this.stopAuthenticatedRuntime()
      return
    }

    userStore.markGuest()
    adminStore.markMissing()
    void clearPrivateBrowserState(event.type === 'expired' ? 'session-expired' : 'logout', {
      broadcastCredentialPurge: false
    })
    this.stopAuthenticatedRuntime()
  }

  private broadcast(event: AuthBroadcastEvent): void {
    if (this.channel) {
      this.channel.postMessage(event)
      return
    }

    if (typeof window === 'undefined') {
      return
    }

    try {
      window.localStorage.setItem(AUTH_BROADCAST_STORAGE_KEY, JSON.stringify(event))
    } catch {
      // Ignore storage failures in restricted browser contexts.
    }
  }

  private stopAuthenticatedRuntime(): void {
    if (!this.pinia) {
      return
    }

    const notificationStreamStore = useNotificationStreamStore(this.pinia)
    notificationStreamStore.dispose()
    notificationStreamStore.resetCursor()
    notificationStreamStore.setStatus('stopped')
    void notificationStreamRuntime.stop(true)
  }

  private handleChannelMessage = (message: MessageEvent): void => {
    if (isAuthBroadcastEvent(message.data)) {
      this.handleAuthBroadcastEvent(message.data)
    }
  }

  private handleStorageEvent = (event: StorageEvent): void => {
    if (event.key !== AUTH_BROADCAST_STORAGE_KEY || !event.newValue) {
      return
    }

    try {
      const payload = JSON.parse(event.newValue) as unknown
      if (isAuthBroadcastEvent(payload)) {
        this.handleAuthBroadcastEvent(payload)
      }
    } catch {
      // Ignore malformed cross-tab payloads.
    }
  }
}

export const authBroadcastRuntime = new AuthBroadcastRuntime()
