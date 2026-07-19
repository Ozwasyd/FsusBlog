import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { authBroadcastRuntime } from '@/services/authBroadcastRuntime'
import {
  disposeAuthBroadcastComposition,
  installAuthBroadcastComposition
} from '@/services/authBroadcastComposition'
import { useAdminStore } from '@/store/admin'
import { useAppShellStore } from '@/store/appShell'
import { useNotificationStreamStore } from '@/store/notificationStream'
import { useUserStore } from '@/store/user'
import { notificationStreamRuntime } from '@/services/notificationStreamRuntime'
import { NotificationStreamEventType } from '@/services/notificationStreamTypes'

vi.mock('@/api/auth', () => ({
  getMe: vi.fn(),
  getAdminMe: vi.fn(),
  logout: vi.fn(),
  logoutAdmin: vi.fn()
}))

vi.mock('@/services/notificationStreamRuntime', () => ({
  notificationStreamRuntime: {
    stop: vi.fn().mockResolvedValue(undefined)
  }
}))

vi.mock('@/services/serviceWorkerRuntime', () => ({
  clearPrivateBrowserState: vi.fn().mockResolvedValue(undefined)
}))

import { clearPrivateBrowserState } from '@/services/serviceWorkerRuntime'
import { getAdminMe, getMe } from '@/api/auth'

class MockBroadcastChannel {
  static instances: MockBroadcastChannel[] = []
  public messages: unknown[] = []
  private listeners = new Set<(message: MessageEvent) => void>()

  constructor(public readonly name: string) {
    MockBroadcastChannel.instances.push(this)
  }

  postMessage(message: unknown): void {
    this.messages.push(message)
  }

  addEventListener(_event: 'message', listener: (message: MessageEvent) => void): void {
    this.listeners.add(listener)
  }

  removeEventListener(_event: 'message', listener: (message: MessageEvent) => void): void {
    this.listeners.delete(listener)
  }

  close(): void {}

  dispatch(message: unknown): void {
    for (const listener of this.listeners) {
      listener(new MessageEvent('message', { data: message }))
    }
  }
}

function anonymousUser(id: number) {
  return {
    accountId: id,
    identityKind: 'anonymous_account',
    publicHandle: `public-${id}`,
    passkeyEnabled: true,
    recoveryEnabled: true,
    totpStepUpEnabled: false,
    anonymousCredentialStatus: 'active',
    anonymousCredentialLevel: 'basic',
    status: 0,
    banReason: null,
    deletedAt: null
  }
}

function installBroadcastChannel(): void {
  Object.defineProperty(window, 'BroadcastChannel', {
    value: MockBroadcastChannel,
    configurable: true,
    writable: true
  })
}

function removeBroadcastChannel(): void {
  Object.defineProperty(window, 'BroadcastChannel', {
    value: undefined,
    configurable: true,
    writable: true
  })
}

function createRuntimePinia(): Pinia {
  const pinia = createPinia()
  setActivePinia(pinia)
  authBroadcastRuntime.init(pinia)
  installAuthBroadcastComposition(pinia)
  return pinia
}

describe('authBroadcastRuntime', () => {
  beforeEach(() => {
    disposeAuthBroadcastComposition()
    authBroadcastRuntime.dispose()
    MockBroadcastChannel.instances = []
    installBroadcastChannel()
    localStorage.clear()
    vi.clearAllMocks()
  })

  afterEach(() => {
    disposeAuthBroadcastComposition()
    authBroadcastRuntime.dispose()
    installBroadcastChannel()
  })

  it('broadcasts login without sensitive payload', () => {
    createRuntimePinia()

    authBroadcastRuntime.broadcastLogin()

    const [message] = MockBroadcastChannel.instances[0]?.messages ?? []
    expect(message).toMatchObject({
      type: 'login',
      at: expect.any(Number)
    })
    const payloadText = JSON.stringify(message)
    expect(payloadText).not.toMatch(/accountId|permission|token|session/i)
    expect(clearPrivateBrowserState).toHaveBeenCalledWith('account-switch')
  })

  it('login event invalidates account and admin negative caches', () => {
    const pinia = createRuntimePinia()
    const userStore = useUserStore(pinia)
    const adminStore = useAdminStore(pinia)
    userStore.markGuest()
    adminStore.markMissing()

    MockBroadcastChannel.instances[0]?.dispatch({ type: 'login', at: Date.now() })

    expect(userStore.accountState).toBe('unknown')
    expect(userStore.lastVerifiedAt).toBe(0)
    expect(adminStore.adminState).toBe('unknown')
    expect(clearPrivateBrowserState).toHaveBeenCalledWith('account-switch', {
      broadcastCredentialPurge: false
    })
  })

  it('account-switch broadcast requires fresh server snapshots before restoring identity', async () => {
    const pinia = createRuntimePinia()
    const userStore = useUserStore(pinia)
    const adminStore = useAdminStore(pinia)
    userStore.markGuest()
    adminStore.markMissing()
    vi.mocked(getMe).mockResolvedValueOnce(anonymousUser(9) as never)
    vi.mocked(getAdminMe).mockResolvedValueOnce({
      id: 'admin-9',
      displayName: 'Admin 9',
      source: 'independent',
      permissions: ['admin.manage'],
      adminSessionStatus: 'active'
    })

    MockBroadcastChannel.instances[0]?.dispatch({ type: 'login', at: Date.now() })

    expect(userStore.accountState).toBe('unknown')
    expect(adminStore.adminState).toBe('unknown')
    await Promise.all([
      userStore.fetchUserInfo(),
      adminStore.ensureAdminSessionFresh()
    ])

    expect(getMe).toHaveBeenCalledTimes(1)
    expect(getAdminMe).toHaveBeenCalledTimes(1)
    expect(userStore.accountState).toBe('authenticated')
    expect(userStore.userInfo?.accountId).toBe(9)
    expect(adminStore.adminState).toBe('active')
    expect(adminStore.hasPermission('admin.manage')).toBe(true)
  })

  it('logout event marks the account guest without changing the admin session', () => {
    const pinia = createRuntimePinia()
    const userStore = useUserStore(pinia)
    const adminStore = useAdminStore(pinia)
    userStore.markAuthenticated(anonymousUser(1) as never)
    adminStore.setAdminPrincipal({
      id: 'admin',
      displayName: 'Admin',
      source: 'independent',
      permissions: ['admin.manage'],
      adminSessionStatus: 'active'
    })

    MockBroadcastChannel.instances[0]?.dispatch({ type: 'logout', at: Date.now() })

    expect(userStore.accountState).toBe('guest')
    expect(userStore.userInfo).toBeNull()
    expect(adminStore.adminState).toBe('active')
    expect(adminStore.adminPrincipal?.id).toBe('admin')
    expect(clearPrivateBrowserState).toHaveBeenCalledWith('logout', {
      broadcastCredentialPurge: false
    })
  })

  it('admin logout clears only the admin plane in remote tabs', () => {
    const pinia = createRuntimePinia()
    const userStore = useUserStore(pinia)
    const adminStore = useAdminStore(pinia)
    userStore.markAuthenticated(anonymousUser(1) as never)
    adminStore.setAdminPrincipal({
      id: 'admin',
      displayName: 'Admin',
      source: 'independent',
      permissions: ['admin.manage'],
      adminSessionStatus: 'active'
    })

    MockBroadcastChannel.instances[0]?.dispatch({ type: 'admin-logout', at: Date.now() })

    expect(userStore.accountState).toBe('authenticated')
    expect(userStore.userInfo?.accountId).toBe(1)
    expect(adminStore.adminState).toBe('missing')
    expect(adminStore.adminPrincipal).toBeNull()
    expect(clearPrivateBrowserState).toHaveBeenCalledWith('logout', {
      broadcastCredentialPurge: false
    })
  })

  it('admin logout broadcast contains no identity or session material', async () => {
    const pinia = createRuntimePinia()
    const adminStore = useAdminStore(pinia)

    adminStore.setAdminPrincipal({
      id: 'admin-secret-id',
      displayName: 'Admin',
      source: 'independent',
      permissions: ['admin.manage'],
      adminSessionStatus: 'active'
    })
    await adminStore.logout()

    const [message] = MockBroadcastChannel.instances[0]?.messages ?? []
    expect(message).toMatchObject({ type: 'admin-logout', at: expect.any(Number) })
    expect(JSON.stringify(message)).not.toMatch(/admin-secret-id|accountId|permission|token|session/i)
  })

  it('expired event stops authenticated runtime', () => {
    const pinia = createRuntimePinia()
    const userStore = useUserStore(pinia)
    const adminStore = useAdminStore(pinia)
    userStore.markAuthenticated(anonymousUser(1) as never)
    adminStore.setAdminPrincipal({
      id: 'admin',
      displayName: 'Admin',
      source: 'independent',
      permissions: ['admin.manage'],
      adminSessionStatus: 'active'
    })

    MockBroadcastChannel.instances[0]?.dispatch({ type: 'expired', at: Date.now() })

    expect(userStore.accountState).toBe('guest')
    expect(adminStore.adminState).toBe('active')
    expect(notificationStreamRuntime.stop).toHaveBeenCalledWith(true)
    expect(clearPrivateBrowserState).toHaveBeenCalledWith('session-expired', {
      broadcastCredentialPurge: false
    })
  })

  it('admin-changed invalidates both caches because the Cookie identity may have changed', () => {
    const pinia = createRuntimePinia()
    const userStore = useUserStore(pinia)
    const adminStore = useAdminStore(pinia)
    userStore.markGuest()
    adminStore.markMissing()

    MockBroadcastChannel.instances[0]?.dispatch({ type: 'admin-changed', at: Date.now() })

    expect(adminStore.adminState).toBe('unknown')
    expect(userStore.accountState).toBe('unknown')
  })

  it('clears the sending tab before broadcasting session expiry', () => {
    createRuntimePinia()

    authBroadcastRuntime.broadcastExpired()

    expect(clearPrivateBrowserState).toHaveBeenCalledWith('session-expired')
    expect(MockBroadcastChannel.instances[0]?.messages).toEqual([
      expect.objectContaining({ type: 'expired' })
    ])
  })

  it('session revocation event forces only the user account to reauthenticate across tabs', async () => {
    const pinia = createRuntimePinia()
    const userStore = useUserStore(pinia)
    const adminStore = useAdminStore(pinia)
    const appShellStore = useAppShellStore(pinia)
    const notificationStore = useNotificationStreamStore(pinia)
    userStore.markAuthenticated(anonymousUser(1) as never)
    adminStore.setAdminPrincipal({
      id: 'admin',
      displayName: 'Admin',
      source: 'independent',
      permissions: ['admin.manage'],
      adminSessionStatus: 'active'
    })

    notificationStore.consumeEvent({
      id: 42,
      type: NotificationStreamEventType.SessionRevoked,
      ts: Date.now(),
      payload: {
        reason: 'passkey_counter_rollback',
        revokedSessionCount: 2,
        time: new Date().toISOString()
      }
    })

    await vi.waitFor(() => expect(userStore.accountState).toBe('guest'))
    expect(notificationStore.sessionRevocationRevision).toBe(1)
    expect(notificationStore.sessionRevocation?.reason).toBe('passkey_counter_rollback')
    expect(appShellStore.sessionPhase).toBe('expired')
    expect(adminStore.adminState).toBe('active')
    expect(MockBroadcastChannel.instances[0]?.messages).toContainEqual({
      type: 'user-expired',
      at: expect.any(Number)
    })
    expect(notificationStreamRuntime.stop).toHaveBeenCalledWith(true)
  })

  it('localStorage fallback dispatches and receives events', () => {
    removeBroadcastChannel()
    const pinia = createRuntimePinia()
    const userStore = useUserStore(pinia)
    const adminStore = useAdminStore(pinia)
    userStore.markGuest()
    adminStore.markMissing()

    authBroadcastRuntime.broadcastLogin()
    const rawPayload = localStorage.getItem('fsus:auth:broadcast')
    expect(rawPayload).toContain('"type":"login"')

    const storageEvent = typeof window.StorageEvent === 'function'
      ? new window.StorageEvent('storage', {
          key: 'fsus:auth:broadcast',
          newValue: JSON.stringify({ type: 'login', at: Date.now() })
        })
      : Object.assign(new Event('storage'), {
          key: 'fsus:auth:broadcast',
          newValue: JSON.stringify({ type: 'login', at: Date.now() })
        })

    window.dispatchEvent(storageEvent)

    expect(userStore.accountState).toBe('unknown')
    expect(adminStore.adminState).toBe('unknown')
  })

  it('drops sensitive extra fields and applies duplicate events once', () => {
    const pinia = createRuntimePinia()
    const userStore = useUserStore(pinia)
    userStore.markGuest()
    const event = {
      type: 'login',
      at: Date.now(),
      accountId: 42,
      token: 'must-not-cross-boundary'
    }

    MockBroadcastChannel.instances[0]?.dispatch(event)
    userStore.markGuest()
    MockBroadcastChannel.instances[0]?.dispatch(event)

    expect(userStore.accountState).toBe('guest')
    expect(clearPrivateBrowserState).toHaveBeenCalledTimes(1)
  })

  it('disposes transport and rebuilds composition against a new Pinia root', () => {
    const firstPinia = createRuntimePinia()
    useUserStore(firstPinia).markGuest()
    const firstChannel = MockBroadcastChannel.instances[0]

    disposeAuthBroadcastComposition()
    authBroadcastRuntime.dispose()
    const secondPinia = createRuntimePinia()
    useUserStore(secondPinia).markGuest()

    firstChannel?.dispatch({ type: 'login', at: Date.now() })
    expect(useUserStore(firstPinia).accountState).toBe('guest')

    MockBroadcastChannel.instances[1]?.dispatch({ type: 'login', at: Date.now() + 1 })
    expect(useUserStore(secondPinia).accountState).toBe('unknown')
    expect(useUserStore(firstPinia).accountState).toBe('guest')
  })
})
