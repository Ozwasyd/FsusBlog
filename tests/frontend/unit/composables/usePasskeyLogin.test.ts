import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  passkeyLoginBegin: vi.fn(),
  passkeyLoginComplete: vi.fn(),
  startAuthentication: vi.fn(),
  commitPostAuthSession: vi.fn(),
  routerPush: vi.fn(),
  broadcastLogin: vi.fn(),
  riskRun: vi.fn()
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

vi.mock('@/composables/usePostAuthCommit', () => ({
  usePostAuthCommit: () => ({ commitPostAuthSession: mocks.commitPostAuthSession })
}))

vi.mock('@/services/authBroadcastRuntime', () => ({
  authBroadcastRuntime: { broadcastLogin: mocks.broadcastLogin }
}))

vi.mock('@/composables/useRiskChallengeCommand', () => ({
  useRiskChallengeCommand: () => ({
    run: mocks.riskRun
  })
}))

describe('usePasskeyLogin', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.passkeyLoginBegin.mockReset()
    mocks.passkeyLoginComplete.mockReset()
    mocks.startAuthentication.mockReset()
    mocks.commitPostAuthSession.mockReset()
    mocks.riskRun.mockReset()
    mocks.riskRun.mockImplementation(
      async (_context: unknown, _policy: unknown, execute: (proof?: unknown) => Promise<unknown>) => await execute()
    )
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
    const { error, loginWithPasskey } = usePasskeyLogin(mocks.startAuthentication)

    await expect(loginWithPasskey(false)).resolves.toBe(false)

    expect(mocks.commitPostAuthSession).not.toHaveBeenCalled()
    expect(error.value).toBe('通行密钥登录失败，请重试')
    expect(error.value).not.toContain('raw webauthn internal detail')
    expect(alertSpy).not.toHaveBeenCalled()
    expect(mocks.passkeyLoginComplete).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('commits the server Session snapshot before broadcasting or entering a private route', async () => {
    mocks.passkeyLoginBegin.mockResolvedValue({
      challengeToken: 'challenge-token',
      options: { challenge: 'challenge', rpId: 'localhost', allowCredentials: [] }
    })
    mocks.startAuthentication.mockResolvedValue({ id: 'credential' })
    mocks.passkeyLoginComplete.mockResolvedValue({})
    mocks.commitPostAuthSession.mockResolvedValue(true)

    const { usePasskeyLogin } = await import('@/composables/usePasskeyLogin')
    const { loginWithPasskey } = usePasskeyLogin(mocks.startAuthentication)

    const result = await loginWithPasskey(false)

    expect(mocks.passkeyLoginBegin).toHaveBeenCalledOnce()
    expect(mocks.riskRun).toHaveBeenCalled()
    expect(mocks.startAuthentication).toHaveBeenCalledOnce()
    expect(mocks.passkeyLoginComplete).toHaveBeenCalledOnce()
    expect(mocks.commitPostAuthSession).toHaveBeenCalledOnce()
    expect(mocks.broadcastLogin).toHaveBeenCalledOnce()
    expect(mocks.routerPush).toHaveBeenCalledOnce()
    expect(mocks.commitPostAuthSession.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.broadcastLogin.mock.invocationCallOrder[0]!)
    expect(mocks.broadcastLogin.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.routerPush.mock.invocationCallOrder[0]!)
    expect(result).toBe(true)
  })

  it('does not broadcast or navigate when the Session snapshot cannot be committed', async () => {
    mocks.passkeyLoginBegin.mockResolvedValue({
      challengeToken: 'challenge-token',
      options: { challenge: 'challenge', rpId: 'localhost', allowCredentials: [] }
    })
    mocks.startAuthentication.mockResolvedValue({ id: 'credential' })
    mocks.passkeyLoginComplete.mockResolvedValue({})
    mocks.commitPostAuthSession.mockResolvedValue(false)

    const { usePasskeyLogin } = await import('@/composables/usePasskeyLogin')
    const { error, loginWithPasskey } = usePasskeyLogin(mocks.startAuthentication)

    const result = await loginWithPasskey(false)

    expect(mocks.passkeyLoginComplete).toHaveBeenCalledOnce()
    expect(mocks.commitPostAuthSession).toHaveBeenCalledOnce()
    expect(result).toBe(false)
    expect(error.value).toBe('登录状态同步失败，请重新登录')
    expect(mocks.broadcastLogin).not.toHaveBeenCalled()
    expect(mocks.routerPush).not.toHaveBeenCalled()
  })
})
