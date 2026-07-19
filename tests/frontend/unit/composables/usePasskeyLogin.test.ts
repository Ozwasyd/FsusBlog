import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  passkeyLoginBegin: vi.fn(),
  passkeyLoginComplete: vi.fn(),
  startAuthentication: vi.fn(),
  ensureBootstrap: vi.fn(),
  routerPush: vi.fn(),
  invalidateGuestCache: vi.fn()
}))

vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: mocks.startAuthentication
}))

vi.mock('vue-router', () => ({
  useRoute: () => ({ query: {} }),
  useRouter: () => ({
    push: mocks.routerPush,
    resolve: (target: string) => ({
      fullPath: target,
      path: target,
      name: null,
      params: {},
      query: {},
      meta: {}
    })
  })
}))

vi.mock('@/api/auth', () => ({
  passkeyLoginBegin: mocks.passkeyLoginBegin,
  passkeyLoginComplete: mocks.passkeyLoginComplete
}))

vi.mock('@/composables/useSessionBootstrap', () => ({
  useSessionBootstrap: () => ({
    ensureBootstrap: mocks.ensureBootstrap,
    userStore: { invalidateGuestCache: mocks.invalidateGuestCache }
  })
}))

describe('usePasskeyLogin', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('location', { hostname: 'localhost' })
  })

  it('uses a standardized UI error and no alert when WebAuthn authentication fails', async () => {
    const alertSpy = vi.fn()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    Object.defineProperty(window, 'alert', {
      configurable: true,
      writable: true,
      value: alertSpy
    })
    vi.stubGlobal('alert', alertSpy)
    mocks.passkeyLoginBegin.mockResolvedValue({
      challengeToken: 'challenge-token',
      options: {
        challenge: 'challenge',
        rpId: 'localhost',
        allowCredentials: []
      }
    })
    mocks.startAuthentication.mockRejectedValue(new Error('raw webauthn internal detail'))

    const { usePasskeyLogin } = await import('@/composables/usePasskeyLogin')
    const { error, loginWithPasskey } = usePasskeyLogin()

    await expect(loginWithPasskey(false)).resolves.toBe(false)

    expect(mocks.invalidateGuestCache).toHaveBeenCalledOnce()
    expect(error.value).toBe('通行密钥登录失败，请重试')
    expect(error.value).not.toContain('raw webauthn internal detail')
    expect(alertSpy).not.toHaveBeenCalled()
    expect(mocks.passkeyLoginComplete).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})
