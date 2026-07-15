import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { authBroadcastRuntime } from '@/services/authBroadcastRuntime'
import { useAdminStore } from '@/store/admin'
import { useUserStore } from '@/store/user'
import { notificationStreamRuntime } from '@/services/notificationStreamRuntime'

vi.mock('@/api/auth', () => ({
  getMe: vi.fn(),
  logout: vi.fn()
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
  return pinia
}

describe('authBroadcastRuntime', () => {
  beforeEach(() => {
    authBroadcastRuntime.dispose()
    MockBroadcastChannel.instances = []
    installBroadcastChannel()
    localStorage.clear()
    vi.clearAllMocks()
  })

  afterEach(() => {
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
  })

  it('login event invalidates guest cache', () => {
    const pinia = createRuntimePinia()
    const userStore = useUserStore(pinia)
    const adminStore = useAdminStore(pinia)
    userStore.markGuest()
    adminStore.markMissing()

    MockBroadcastChannel.instances[0]?.dispatch({ type: 'login', at: Date.now() })

    expect(userStore.accountState).toBe('unknown')
    expect(userStore.lastVerifiedAt).toBe(0)
    expect(adminStore.adminState).toBe('unknown')
    expect(adminStore.adminCheckedAt).toBe(0)
  })

  it('logout event marks account guest and admin missing', () => {
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
    expect(adminStore.adminState).toBe('missing')
    expect(adminStore.adminPrincipal).toBeNull()
    expect(clearPrivateBrowserState).toHaveBeenCalledWith('logout')
  })

  it('expired event stops authenticated runtime', () => {
    const pinia = createRuntimePinia()
    const userStore = useUserStore(pinia)
    userStore.markAuthenticated(anonymousUser(1) as never)

    MockBroadcastChannel.instances[0]?.dispatch({ type: 'expired', at: Date.now() })

    expect(userStore.accountState).toBe('guest')
    expect(notificationStreamRuntime.stop).toHaveBeenCalledWith(true)
    expect(clearPrivateBrowserState).toHaveBeenCalledWith('session-expired')
  })

  it('clears the sending tab before broadcasting session expiry', () => {
    createRuntimePinia()

    authBroadcastRuntime.broadcastExpired()

    expect(clearPrivateBrowserState).toHaveBeenCalledWith('session-expired')
    expect(MockBroadcastChannel.instances[0]?.messages).toEqual([
      expect.objectContaining({ type: 'expired' })
    ])
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
})
