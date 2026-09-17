import { defineComponent, h, onUnmounted, ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createSessionExpiredNavigationHandler,
  SESSION_EXPIRED_EVENT
} from '@/bootstrap/sessionExpiryBridge'
import { authBroadcastRuntime } from '@/services/authBroadcastRuntime'
import {
  disposeAuthBroadcastComposition,
  installAuthBroadcastComposition
} from '@/services/authBroadcastComposition'
import { useUserStore } from '@/store/user'

vi.mock('@/api/auth', () => ({
  getMe: vi.fn(),
  logout: vi.fn()
}))

vi.mock('@/services/notificationStreamRuntime', () => ({
  notificationStreamRuntime: { stop: vi.fn().mockResolvedValue(undefined) }
}))

vi.mock('@/services/serviceWorkerRuntime', () => ({
  clearPrivateBrowserState: vi.fn().mockResolvedValue(undefined)
}))

class MockBroadcastChannel {
  static instance: MockBroadcastChannel | null = null
  private listeners = new Set<(event: MessageEvent) => void>()
  constructor() { MockBroadcastChannel.instance = this }
  addEventListener(_type: string, listener: (event: MessageEvent) => void) { this.listeners.add(listener) }
  removeEventListener(_type: string, listener: (event: MessageEvent) => void) { this.listeners.delete(listener) }
  postMessage() {}
  close() {}
  dispatch(data: unknown) {
    for (const listener of this.listeners) listener(new MessageEvent('message', { data }))
  }
}

describe('private session expiry navigation', () => {
  afterEach(() => {
    disposeAuthBroadcastComposition()
    authBroadcastRuntime.dispose()
    MockBroadcastChannel.instance = null
  })

  it('unmounts private DOM and cleans store, request and subscription on a remote expiry', async () => {
    vi.useFakeTimers()
    Object.defineProperty(window, 'BroadcastChannel', {
      value: MockBroadcastChannel,
      configurable: true
    })
    const request = new AbortController()
    const unsubscribe = vi.fn()
    const PrivateFixture = defineComponent({
      setup() {
        const privateValue = ref('private-account-view')
        onUnmounted(() => {
          request.abort()
          unsubscribe()
          privateValue.value = ''
        })
        return () => h('main', { 'data-private-view': '' }, privateValue.value)
      }
    })
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/login', component: { template: '<main data-login-view>login</main>' } },
        { path: '/user/identity', meta: { requiresAuth: true }, component: PrivateFixture }
      ]
    })
    const pinia = createPinia()
    setActivePinia(pinia)
    const userStore = useUserStore(pinia)
    userStore.markAuthenticated({
      accountId: 1,
      identityKind: 'anonymous_account',
      publicHandle: 'fixture',
      passkeyEnabled: true,
      recoveryEnabled: true,
      totpStepUpEnabled: false,
      anonymousCredentialStatus: 'active',
      anonymousCredentialLevel: 'basic',
      status: 0,
      banReason: null,
      deletedAt: null
    } as never)
    authBroadcastRuntime.init()
    installAuthBroadcastComposition(pinia)
    const handler = createSessionExpiredNavigationHandler(router, () => userStore.isLoggedIn)
    window.addEventListener(SESSION_EXPIRED_EVENT, handler)
    await router.push('/user/identity?token=secret')
    const wrapper = mount({ render: () => h(RouterView) }, {
      global: { plugins: [pinia, router] }
    })
    expect(wrapper.find('[data-private-view]').exists()).toBe(true)
    window.history.replaceState(null, '', '/user/identity?token=secret')

    MockBroadcastChannel.instance?.dispatch({ type: 'expired', at: Date.now() })
    await flushPromises()

    expect(router.currentRoute.value.path).toBe('/login')
    expect(router.currentRoute.value.query.redirect).toBe('/user/identity')
    expect(wrapper.find('[data-private-view]').exists()).toBe(false)
    expect(wrapper.find('[data-login-view]').exists()).toBe(true)
    expect(userStore.accountState).toBe('guest')
    expect(request.signal.aborted).toBe(true)
    expect(unsubscribe).toHaveBeenCalledOnce()

    window.removeEventListener(SESSION_EXPIRED_EVENT, handler)
    window.history.replaceState(null, '', '/')
    wrapper.unmount()
    vi.useRealTimers()
  })
})
