import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { defineComponent, h, nextTick, onUnmounted } from 'vue'
import { mount } from '@vue/test-utils'
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
import { clearRegisteredPrivateState } from '@/services/privateStorageRegistry'
import { privateSurfaceRuntime } from '@/services/privateSurfaceRuntime'
import { privateRequestRuntime } from '@/services/privateRequestRuntime'

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
  clearPrivateBrowserState: vi.fn().mockResolvedValue({
    registeredStorageCleared: true,
    credentialStateCleared: true,
    legacyCredentialDatabaseCleared: true,
    serviceWorkerAcknowledged: true,
    cacheStorageCleared: true,
    items: []
  })
}))

import { clearPrivateBrowserState } from '@/services/serviceWorkerRuntime'
import { getAdminMe, getMe } from '@/api/auth'

class MockBroadcastChannel {
  static instances: MockBroadcastChannel[] = []
  public messages: unknown[] = []
  private listeners = new Set<(message: MessageEvent) => void>()
  public readonly name: string

  constructor(name: string) {
    this.name = name
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
    privateSurfaceRuntime.resetForTests()
    privateRequestRuntime.resetForTests()
    MockBroadcastChannel.instances = []
    installBroadcastChannel()
    localStorage.clear()
    vi.clearAllMocks()
  })

  afterEach(() => {
    disposeAuthBroadcastComposition()
    authBroadcastRuntime.dispose()
    privateSurfaceRuntime.resetForTests()
    privateRequestRuntime.resetForTests()
    installBroadcastChannel()
  })

  it('purges account-private state before broadcasting login without sensitive payload', async () => {
    createRuntimePinia()
    const order: string[] = []
    vi.mocked(clearPrivateBrowserState).mockImplementationOnce(async () => {
      order.push('purge')
      return {
        registeredStorageCleared: true,
        credentialStateCleared: true,
        legacyCredentialDatabaseCleared: true,
        serviceWorkerAcknowledged: true,
        cacheStorageCleared: true,
        items: []
      }
    })
    const channel = MockBroadcastChannel.instances[0]
    const postMessage = vi.spyOn(channel!, 'postMessage').mockImplementation((message) => {
      order.push('broadcast')
      channel!.messages.push(message)
    })

    await authBroadcastRuntime.broadcastLogin()

    const [message] = channel?.messages ?? []
    expect(message).toMatchObject({
      type: 'login',
      at: expect.any(Number)
    })
    const payloadText = JSON.stringify(message)
    expect(payloadText).not.toMatch(/accountId|permission|token|session/i)
    expect(clearPrivateBrowserState).toHaveBeenCalledWith('account-switch')
    expect(postMessage).toHaveBeenCalledOnce()
    expect(order).toEqual(['purge', 'broadcast'])
  })

  it('fails closed without publishing login when private-state cleanup is incomplete', async () => {
    createRuntimePinia()
    vi.mocked(clearPrivateBrowserState).mockResolvedValueOnce({
      registeredStorageCleared: false,
      credentialStateCleared: true,
      legacyCredentialDatabaseCleared: true,
      serviceWorkerAcknowledged: true,
      cacheStorageCleared: true,
      items: []
    })

    await expect(authBroadcastRuntime.broadcastLogin())
      .rejects.toThrow('auth_login_private_state_cleanup_failed')
    expect(MockBroadcastChannel.instances[0]?.messages).toEqual([])
  })

  it('login event invalidates account and admin negative caches', () => {
    const pinia = createRuntimePinia()
    const userStore = useUserStore(pinia)
    const adminStore = useAdminStore(pinia)
    userStore.markGuest()
    adminStore.markMissing()
    const generationBefore = privateRequestRuntime.currentGeneration('account')

    MockBroadcastChannel.instances[0]?.dispatch({ type: 'login', at: Date.now() })

    expect(userStore.accountState).toBe('unknown')
    expect(userStore.lastVerifiedAt).toBe(0)
    expect(adminStore.adminState).toBe('unknown')
    expect(privateRequestRuntime.currentGeneration('account')).toBe(generationBefore + 1)
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
    expect(clearPrivateBrowserState).toHaveBeenCalledWith('admin-logout', {
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

  it.each(['logout', 'expired'] as const)(
    '%s broadcast synchronously destroys the mounted private surface before redirect',
    async (eventType) => {
      const pinia = createRuntimePinia()
      const userStore = useUserStore(pinia)
      userStore.markAuthenticated(anonymousUser(73) as never)
      const generationBefore = privateSurfaceRuntime.authGeneration.value
      const request = new AbortController()
      const unregisterAbort = privateSurfaceRuntime.registerTerminationHandler(() => request.abort())
      let finishNavigation: (() => void) | undefined
      const navigation = new Promise<void>(resolve => { finishNavigation = resolve })
      const navigate = vi.fn(() => navigation)
      privateSurfaceRuntime.setNavigationHandler(navigate)
      const workerTerminate = vi.fn()
      const unsubscribePage = vi.fn()
      const clearPageTimer = vi.fn()
      const PrivatePage = defineComponent({
        setup: () => {
          onUnmounted(() => {
            workerTerminate()
            unsubscribePage()
            clearPageTimer()
          })
          return () => h('section', { 'data-private-surface': '' },
            `private account ${userStore.userInfo?.accountId ?? 'cleared'}`)
        }
      })
      const wrapper = mount(defineComponent({
        setup: () => () => privateSurfaceRuntime.isClearing.value
          ? null
          : h(PrivatePage, { key: privateSurfaceRuntime.authGeneration.value })
      }))

      MockBroadcastChannel.instances[0]?.dispatch({ type: eventType, at: Date.now() })

      expect(request.signal.aborted).toBe(true)
      expect(userStore.accountState).toBe('guest')
      expect(userStore.userInfo).toBeNull()
      expect(privateSurfaceRuntime.authGeneration.value).not.toBe(generationBefore)
      expect(privateSurfaceRuntime.authGeneration.value)
        .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
      await nextTick()
      expect(wrapper.find('[data-private-surface]').exists()).toBe(false)
      expect(workerTerminate).toHaveBeenCalledTimes(1)
      expect(unsubscribePage).toHaveBeenCalledTimes(1)
      expect(clearPageTimer).toHaveBeenCalledTimes(1)

      await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith(
        eventType === 'expired' ? 'session-expired' : 'logout'
      ))
      finishNavigation?.()
      await vi.waitFor(() => expect(privateSurfaceRuntime.isClearing.value).toBe(false))
      expect(wrapper.text()).not.toContain('account 73')

      unregisterAbort()
      wrapper.unmount()
    }
  )

  it('admin-changed invalidates both caches because the Cookie identity may have changed', () => {
    const pinia = createRuntimePinia()
    const userStore = useUserStore(pinia)
    const adminStore = useAdminStore(pinia)
    userStore.markGuest()
    adminStore.markMissing()
    const accountGeneration = privateRequestRuntime.currentGeneration('account')
    const adminGeneration = privateRequestRuntime.currentGeneration('admin')

    MockBroadcastChannel.instances[0]?.dispatch({ type: 'admin-changed', at: Date.now() })

    expect(adminStore.adminState).toBe('unknown')
    expect(userStore.accountState).toBe('unknown')
    expect(privateRequestRuntime.currentGeneration('account')).toBe(accountGeneration)
    expect(privateRequestRuntime.currentGeneration('admin')).toBe(adminGeneration + 1)
  })

  it('clears the sending tab before broadcasting session expiry', async () => {
    const pinia = createRuntimePinia()
    const userStore = useUserStore(pinia)
    userStore.markAuthenticated(anonymousUser(1) as never)

    await userStore.expireAuthentication()
    authBroadcastRuntime.broadcastExpired()

    expect(clearPrivateBrowserState).toHaveBeenCalledWith('session-expired', {
      broadcastCredentialPurge: true
    })
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
    vi.mocked(getMe).mockRejectedValueOnce({
      name: 'BinaryTransportError',
      kind: 'auth_failed',
      message: 'session revoked'
    })
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

  it('session revocation event keeps an unaffected device after server revalidation', async () => {
    const pinia = createRuntimePinia()
    const userStore = useUserStore(pinia)
    const notificationStore = useNotificationStreamStore(pinia)
    const current = anonymousUser(7)
    userStore.markAuthenticated(current as never)
    vi.mocked(getMe).mockResolvedValueOnce(current as never)

    notificationStore.consumeEvent({
      id: 43,
      type: NotificationStreamEventType.SessionRevoked,
      ts: Date.now(),
      payload: {
        reason: 'active_session_limit',
        revokedSessionCount: 1,
        time: new Date().toISOString()
      }
    })

    await vi.waitFor(() => expect(getMe).toHaveBeenCalledTimes(1))
    expect(userStore.accountState).toBe('authenticated')
    expect(userStore.userInfo?.accountId).toBe(7)
    expect(MockBroadcastChannel.instances[0]?.messages).not.toContainEqual(
      expect.objectContaining({ type: 'user-expired' })
    )
    expect(notificationStreamRuntime.stop).not.toHaveBeenCalled()
  })

  it('localStorage fallback dispatches and receives events', async () => {
    removeBroadcastChannel()
    const pinia = createRuntimePinia()
    const userStore = useUserStore(pinia)
    const adminStore = useAdminStore(pinia)
    userStore.markGuest()
    adminStore.markMissing()

    await authBroadcastRuntime.broadcastLogin()
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

  it('unregisters private cleanup handlers before replacing the Pinia root', async () => {
    const firstPinia = createRuntimePinia()
    const firstAdmin = useAdminStore(firstPinia)
    firstAdmin.setAdminPrincipal({
      id: 'first-admin',
      displayName: 'First',
      source: 'independent',
      permissions: ['admin.manage'],
      adminSessionStatus: 'active'
    })

    disposeAuthBroadcastComposition()
    authBroadcastRuntime.dispose()
    const secondPinia = createRuntimePinia()
    const secondAdmin = useAdminStore(secondPinia)
    secondAdmin.setAdminPrincipal({
      id: 'second-admin',
      displayName: 'Second',
      source: 'independent',
      permissions: ['admin.manage'],
      adminSessionStatus: 'active'
    })

    const result = await clearRegisteredPrivateState({ trigger: 'admin-logout' })

    expect(firstAdmin.adminPrincipal?.id).toBe('first-admin')
    expect(secondAdmin.adminPrincipal).toBeNull()
    expect(result.items.find(item => item.id === 'admin-pinia')).toMatchObject({ status: 'cleared', affected: 1 })
  })
})


describe('private surface rejection identity and transition ordering', () => {
  beforeEach(() => {
    privateSurfaceRuntime.resetForTests()
    privateRequestRuntime.resetForTests()
  })

  afterEach(() => {
    privateSurfaceRuntime.resetForTests()
    privateRequestRuntime.resetForTests()
  })

  const failures: [string, unknown][] = [
    ['Error', new Error('cleanup failed')],
    ['object', { code: 'cleanup failed' }],
    ['string', 'cleanup failed'],
    ['symbol', Symbol('cleanup failed')],
    ['undefined', undefined]
  ]

  it.each(failures)('preserves a thrown %s and synchronous cleanup before navigation', async (_label, failure) => {
    const order: string[] = []
    const previousGeneration = privateSurfaceRuntime.authGeneration.value
    privateSurfaceRuntime.registerTerminationHandler(() => {
      order.push('termination throws')
      throw failure
    })
    privateSurfaceRuntime.registerTerminationHandler(() => { order.push('next termination') })
    privateSurfaceRuntime.setNavigationHandler(() => { order.push('navigation') })

    const transition = privateSurfaceRuntime.invalidate('logout', () => {
      order.push('cleanup throws')
      throw failure
    })
    order.push('returned')

    expect(order).toEqual(['termination throws', 'next termination', 'cleanup throws', 'returned'])
    expect(privateSurfaceRuntime.isClearing.value).toBe(true)
    expect(privateSurfaceRuntime.authGeneration.value).not.toBe(previousGeneration)
    await expect(transition).rejects.toBe(failure)
    expect(order).toEqual(['termination throws', 'next termination', 'cleanup throws', 'returned', 'navigation'])
    expect(privateSurfaceRuntime.isClearing.value).toBe(false)
  })

  it('keeps overlapping transitions ordered when the first navigation rejects', async () => {
    const order: string[] = []
    const failure = { code: 'redirect failed' }
    let releaseCleanup!: () => void
    const cleanup = new Promise<void>((resolve) => { releaseCleanup = resolve })
    privateSurfaceRuntime.setNavigationHandler((reason) => {
      order.push(`navigation ${reason}`)
      expect(privateSurfaceRuntime.isClearing.value).toBe(true)
      if (reason === 'logout') throw failure
    })
    const first = privateSurfaceRuntime.invalidate('logout', () => {
      order.push('first cleanup')
      return cleanup
    })
    const firstResult = first.catch((error: unknown) => error)
    const second = privateSurfaceRuntime.invalidate('account-switch', () => { order.push('second cleanup') })

    expect(order).toEqual(['first cleanup'])
    expect(privateSurfaceRuntime.isClearing.value).toBe(true)
    releaseCleanup()
    await expect(firstResult).resolves.toBe(failure)
    await second

    expect(order).toEqual(['first cleanup', 'navigation logout', 'second cleanup', 'navigation account-switch'])
    expect(privateSurfaceRuntime.isClearing.value).toBe(false)
  })
})
