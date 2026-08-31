// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { defineComponent, nextTick, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppErrorCode, createAppError } from '@/utils/appError'

const mocks = vi.hoisted(() => ({
  verifyMfaChallenge: vi.fn(),
  commitPostAuthSession: vi.fn(),
  broadcastLogin: vi.fn(),
  setRiskPhase: vi.fn(),
  initNotification: vi.fn(),
  routerPush: vi.fn(),
  routeQuery: {} as Record<string, string>,
  isLoggedIn: true,
  overrideAuthState: null as any
}))

vi.mock('vue-router', () => ({
  useRoute: () => ({ query: mocks.routeQuery }),
  useRouter: () => ({
    push: mocks.routerPush,
    resolve: (target: string) => ({
      fullPath: typeof target === 'string' ? target : '/',
      path: typeof target === 'string' ? target : '/',
      name: null,
      params: {},
      query: {},
      meta: {}
    })
  })
}))

vi.mock('@/api/auth', () => ({
  verifyMfaChallenge: mocks.verifyMfaChallenge
}))

vi.mock('@/composables/usePostAuthCommit', () => ({
  usePostAuthCommit: () => ({
    commitPostAuthSession: mocks.commitPostAuthSession
  })
}))

vi.mock('@/services/authBroadcastRuntime', () => ({
  authBroadcastRuntime: {
    broadcastLogin: mocks.broadcastLogin
  }
}))

vi.mock('@/composables/useSessionBootstrap', () => ({
  useSessionBootstrap: () => ({
    userStore: {
      get isLoggedIn() {
        return mocks.isLoggedIn
      }
    },
    siteStore: {},
    setRiskPhase: mocks.setRiskPhase
  })
}))

vi.mock('@/composables/useNotification', () => ({
  useNotification: () => ({
    initNotification: mocks.initNotification
  })
}))

vi.mock('@/composables/useAuthLogin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/composables/useAuthLogin')>()
  return {
    ...actual,
    useAuthLogin: () => {
      if (mocks.overrideAuthState) {
        return mocks.overrideAuthState
      }
      return actual.useAuthLogin()
    }
  }
})

const ElButtonStub = defineComponent({
  inheritAttrs: false,
  props: {
    disabled: { type: Boolean, default: false },
    loading: { type: Boolean, default: false },
    nativeType: { type: String, default: 'button' }
  },
  emits: ['click'],
  template: '<button v-bind="$attrs" :type="nativeType" :disabled="disabled || loading" @click="$emit(\'click\')"><slot name="icon" /><slot /></button>'
})

const ElInputStub = defineComponent({
  inheritAttrs: false,
  props: {
    modelValue: { type: String, default: '' },
    disabled: { type: Boolean, default: false },
    type: { type: String, default: 'text' }
  },
  emits: ['update:modelValue'],
  template: '<input v-bind="$attrs" :type="type" :value="modelValue" :disabled="disabled" @input="$emit(\'update:modelValue\', $event.target.value)" />'
})

const ElRadioGroupStub = defineComponent({
  inheritAttrs: false,
  props: {
    modelValue: { type: String, default: 'totp' }
  },
  emits: ['update:modelValue'],
  template: '<div role="radiogroup" v-bind="$attrs"><slot /></div>'
})

const ElRadioButtonStub = defineComponent({
  inheritAttrs: false,
  props: {
    value: { type: String, required: true }
  },
  template: '<button type="button" role="radio" :data-value="value" @click="$parent?.$emit(\'update:modelValue\', value)"><slot /></button>'
})

const ElCheckboxStub = defineComponent({
  inheritAttrs: false,
  props: {
    modelValue: { type: Boolean, default: false },
    disabled: { type: Boolean, default: false }
  },
  emits: ['update:modelValue'],
  template: '<label><input type="checkbox" v-bind="$attrs" :checked="modelValue" :disabled="disabled" @change="$emit(\'update:modelValue\', $event.target.checked)"><slot /></label>'
})

const RouterLinkStub = defineComponent({
  props: {
    to: { type: [String, Object], required: true }
  },
  template: '<a :href="typeof to === \'string\' ? to : to.path"><slot /></a>'
})

const globalStubs = {
  ElButton: ElButtonStub,
  ElInput: ElInputStub,
  ElRadioGroup: ElRadioGroupStub,
  ElRadioButton: ElRadioButtonStub,
  ElCheckbox: ElCheckboxStub,
  RouterLink: RouterLinkStub,
  'router-link': RouterLinkStub,
  ElIcon: defineComponent({ template: '<span><slot /></span>' })
}

describe('useAuthLogin MFA and recovery flow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.verifyMfaChallenge.mockReset()
    mocks.commitPostAuthSession.mockReset()
    mocks.broadcastLogin.mockReset()
    mocks.setRiskPhase.mockReset()
    mocks.initNotification.mockReset()
    mocks.routerPush.mockReset()
    mocks.routeQuery = {}
    mocks.isLoggedIn = true
    mocks.overrideAuthState = null
  })

  it('does not trigger API, session commit, broadcast or navigation when requiresMfa is false or challenge token is missing', async () => {
    const { useAuthLogin } = await import('@/composables/useAuthLogin')
    const auth = useAuthLogin()

    auth.requiresMfa.value = false
    auth.mfaChallengeToken.value = 'token-123'
    auth.mfaCode.value = '123456'
    await auth.handleMfaVerify()

    expect(mocks.verifyMfaChallenge).not.toHaveBeenCalled()
    expect(mocks.commitPostAuthSession).not.toHaveBeenCalled()
    expect(mocks.broadcastLogin).not.toHaveBeenCalled()
    expect(mocks.routerPush).not.toHaveBeenCalled()

    auth.requiresMfa.value = true
    auth.mfaChallengeToken.value = ''
    await auth.handleMfaVerify()

    expect(mocks.verifyMfaChallenge).not.toHaveBeenCalled()
    expect(mocks.commitPostAuthSession).not.toHaveBeenCalled()
    expect(mocks.broadcastLogin).not.toHaveBeenCalled()
    expect(mocks.routerPush).not.toHaveBeenCalled()
  })

  it('sends only trimmed code in TOTP mode and ensures recoveryCode is absent', async () => {
    mocks.verifyMfaChallenge.mockResolvedValue({
      verified: true,
      user: { id: 1, name: 'Admin' }
    })
    mocks.commitPostAuthSession.mockResolvedValue(true)

    const { useAuthLogin } = await import('@/composables/useAuthLogin')
    const auth = useAuthLogin()

    auth.requiresMfa.value = true
    auth.mfaChallengeToken.value = 'challenge-xyz'
    auth.mfaMode.value = 'totp'
    auth.mfaCode.value = '  654321  '
    auth.mfaRecoveryCode.value = 'recovery-should-be-omitted'

    await auth.handleMfaVerify()

    expect(mocks.verifyMfaChallenge).toHaveBeenCalledOnce()
    expect(mocks.verifyMfaChallenge).toHaveBeenCalledWith({
      challengeToken: 'challenge-xyz',
      code: '654321',
      recoveryCode: undefined
    }, { signal: expect.any(AbortSignal) })
  })

  it('sends only trimmed recoveryCode in recovery mode and ensures code is absent', async () => {
    mocks.verifyMfaChallenge.mockResolvedValue({
      verified: true,
      user: { id: 1, name: 'Admin' }
    })
    mocks.commitPostAuthSession.mockResolvedValue(true)

    const { useAuthLogin } = await import('@/composables/useAuthLogin')
    const auth = useAuthLogin()

    auth.requiresMfa.value = true
    auth.mfaChallengeToken.value = 'challenge-xyz'
    auth.mfaMode.value = 'recovery'
    auth.mfaCode.value = 'totp-should-be-omitted'
    auth.mfaRecoveryCode.value = '  RC-998877  '

    await auth.handleMfaVerify()

    expect(mocks.verifyMfaChallenge).toHaveBeenCalledOnce()
    expect(mocks.verifyMfaChallenge).toHaveBeenCalledWith({
      challengeToken: 'challenge-xyz',
      code: undefined,
      recoveryCode: 'RC-998877'
    }, { signal: expect.any(AbortSignal) })
  })

  it('validates empty/whitespace inputs with validation errors and zero API calls', async () => {
    const { useAuthLogin } = await import('@/composables/useAuthLogin')
    const auth = useAuthLogin()

    auth.requiresMfa.value = true
    auth.mfaChallengeToken.value = 'challenge-xyz'
    auth.mfaMode.value = 'totp'
    auth.mfaCode.value = '   '

    await auth.handleMfaVerify()
    expect(auth.errorMessage.value).toBe('请输入验证码')
    expect(mocks.verifyMfaChallenge).not.toHaveBeenCalled()

    auth.mfaMode.value = 'recovery'
    auth.mfaRecoveryCode.value = '   '

    await auth.handleMfaVerify()
    expect(auth.errorMessage.value).toBe('请输入恢复码')
    expect(mocks.verifyMfaChallenge).not.toHaveBeenCalled()
  })

  it('guards against duplicate concurrent submits allowing only one in-flight request', async () => {
    let resolveVerify: (val: unknown) => void = () => {}
    mocks.verifyMfaChallenge.mockImplementation(() => new Promise((resolve) => {
      resolveVerify = resolve
    }))
    mocks.commitPostAuthSession.mockResolvedValue(true)

    const { useAuthLogin } = await import('@/composables/useAuthLogin')
    const auth = useAuthLogin()

    auth.requiresMfa.value = true
    auth.mfaChallengeToken.value = 'challenge-xyz'
    auth.mfaMode.value = 'totp'
    auth.mfaCode.value = '123456'

    const promise1 = auth.handleMfaVerify()
    const promise2 = auth.handleMfaVerify()

    expect(mocks.verifyMfaChallenge).toHaveBeenCalledTimes(1)

    resolveVerify({ verified: true, user: { id: 1 } })
    await Promise.all([promise1, promise2])

    expect(mocks.verifyMfaChallenge).toHaveBeenCalledTimes(1)
  })

  it('keeps MFA state intact and aborts side-effects on verified=false, missing user, protocol or commit failure', async () => {
    const { useAuthLogin } = await import('@/composables/useAuthLogin')
    const auth = useAuthLogin()
    auth.requiresMfa.value = true
    auth.mfaChallengeToken.value = 'challenge-xyz'
    auth.mfaMode.value = 'totp'
    auth.mfaCode.value = '123456'

    // 1. verified: false
    mocks.verifyMfaChallenge.mockResolvedValueOnce({ verified: false })
    await auth.handleMfaVerify()
    expect(auth.requiresMfa.value).toBe(true)
    expect(auth.mfaChallengeToken.value).toBe('challenge-xyz')
    expect(mocks.commitPostAuthSession).not.toHaveBeenCalled()
    expect(mocks.broadcastLogin).not.toHaveBeenCalled()
    expect(mocks.routerPush).not.toHaveBeenCalled()

    // 2. verified: true but user missing
    mocks.verifyMfaChallenge.mockResolvedValueOnce({ verified: true, user: null })
    await auth.handleMfaVerify()
    expect(auth.requiresMfa.value).toBe(true)
    expect(auth.mfaChallengeToken.value).toBe('challenge-xyz')
    expect(mocks.commitPostAuthSession).not.toHaveBeenCalled()
    expect(mocks.broadcastLogin).not.toHaveBeenCalled()
    expect(mocks.routerPush).not.toHaveBeenCalled()

    // 3. API / network failure
    mocks.verifyMfaChallenge.mockRejectedValueOnce(createAppError(AppErrorCode.Unauthorized, 'MFA_FAILED'))
    await auth.handleMfaVerify()
    expect(auth.errorMessage.value).toBe('验证失败，请重新尝试')
    expect(auth.requiresMfa.value).toBe(true)
    expect(auth.mfaChallengeToken.value).toBe('challenge-xyz')
    expect(mocks.commitPostAuthSession).not.toHaveBeenCalled()
    expect(mocks.broadcastLogin).not.toHaveBeenCalled()
    expect(mocks.routerPush).not.toHaveBeenCalled()

    // 4. protocol failure
    mocks.verifyMfaChallenge.mockRejectedValueOnce(createAppError(AppErrorCode.ProtocolFailure, 'MFA_VERIFY_FAILED'))
    await auth.handleMfaVerify()
    expect(auth.errorMessage.value).toBe('验证状态异常，请重新登录后再试')
    expect(auth.requiresMfa.value).toBe(true)
    expect(auth.mfaChallengeToken.value).toBe('challenge-xyz')
    expect(mocks.commitPostAuthSession).not.toHaveBeenCalled()
    expect(mocks.broadcastLogin).not.toHaveBeenCalled()
    expect(mocks.routerPush).not.toHaveBeenCalled()

    // 5. commitPostAuthSession failure
    mocks.verifyMfaChallenge.mockResolvedValueOnce({ verified: true, user: { id: 1 } })
    mocks.commitPostAuthSession.mockResolvedValueOnce(false)
    await auth.handleMfaVerify()
    expect(auth.errorMessage.value).toBe('登录状态同步失败，请重新登录')
    expect(auth.requiresMfa.value).toBe(true)
    expect(auth.mfaChallengeToken.value).toBe('challenge-xyz')
    expect(mocks.broadcastLogin).not.toHaveBeenCalled()
    expect(mocks.routerPush).not.toHaveBeenCalled()
  })

  it('aborts in-flight verification on unmount and ignores a late successful result', async () => {
    let resolveVerify: (value: unknown) => void = () => {}
    mocks.verifyMfaChallenge.mockImplementation(() => new Promise((resolve) => {
      resolveVerify = resolve
    }))
    mocks.commitPostAuthSession.mockResolvedValue(true)

    const { useAuthLogin } = await import('@/composables/useAuthLogin')
    let auth: ReturnType<typeof useAuthLogin> | undefined
    const wrapper = mount(defineComponent({
      setup() {
        auth = useAuthLogin()
        return () => null
      }
    }))

    auth!.requiresMfa.value = true
    auth!.mfaChallengeToken.value = 'challenge-xyz'
    auth!.mfaCode.value = '123456'

    const pending = auth!.handleMfaVerify()
    const signal = mocks.verifyMfaChallenge.mock.calls[0]?.[1]?.signal as AbortSignal
    expect(signal.aborted).toBe(false)

    wrapper.unmount()
    expect(signal.aborted).toBe(true)

    resolveVerify({ verified: true, user: { id: 1 } })
    await pending

    expect(mocks.commitPostAuthSession).not.toHaveBeenCalled()
    expect(mocks.setRiskPhase).not.toHaveBeenCalled()
    expect(mocks.broadcastLogin).not.toHaveBeenCalled()
    expect(mocks.routerPush).not.toHaveBeenCalled()
    expect(auth!.mfaChallengeToken.value).toBe('challenge-xyz')
  })

  it('executes the full post-auth sequence in strict order upon verification and session commit success', async () => {
    mocks.verifyMfaChallenge.mockResolvedValue({
      verified: true,
      user: { id: 1, name: 'Admin' }
    })
    mocks.commitPostAuthSession.mockResolvedValue(true)
    mocks.routeQuery = { redirect: '/archive' }

    const { useAuthLogin } = await import('@/composables/useAuthLogin')
    const auth = useAuthLogin()

    auth.requiresMfa.value = true
    auth.mfaChallengeToken.value = 'challenge-xyz'
    auth.mfaMode.value = 'recovery'
    auth.mfaRecoveryCode.value = 'RC-123456'

    await auth.handleMfaVerify()

    expect(mocks.verifyMfaChallenge).toHaveBeenCalledOnce()
    expect(mocks.commitPostAuthSession).toHaveBeenCalledOnce()
    expect(mocks.setRiskPhase).toHaveBeenCalledWith('normal')
    expect(mocks.broadcastLogin).toHaveBeenCalledOnce()
    expect(mocks.routerPush).toHaveBeenCalledWith('/archive')

    expect(mocks.verifyMfaChallenge.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.commitPostAuthSession.mock.invocationCallOrder[0]!)
    expect(mocks.commitPostAuthSession.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.setRiskPhase.mock.invocationCallOrder[0]!)
    expect(mocks.setRiskPhase.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.broadcastLogin.mock.invocationCallOrder[0]!)
    expect(mocks.broadcastLogin.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.routerPush.mock.invocationCallOrder[0]!)

    expect(auth.requiresMfa.value).toBe(false)
    expect(auth.mfaChallengeToken.value).toBe('')
    expect(auth.mfaMode.value).toBe('totp')
    expect(auth.mfaCode.value).toBe('')
    expect(auth.mfaRecoveryCode.value).toBe('')
  })

  it('mounts Login.vue, switches between TOTP and recovery modes, and wires accessible fields', async () => {
    const Login = (await import('@/views/auth/Login.vue')).default

    // Default mount in passkey mode
    const passkeyWrapper = mount(Login, {
      global: {
        stubs: globalStubs
      }
    })
    expect(passkeyWrapper.find('form[aria-labelledby="mfa-title"]').exists()).toBe(false)
    expect(passkeyWrapper.find('#anonymous-remember-me').exists()).toBe(true)

    // Set custom auth state with MFA enabled
    const mfaHandle = vi.fn()
    const state = {
      errorMessage: ref(''),
      rememberMe: ref(true),
      isProcessing: ref(false),
      handleMfaVerify: mfaHandle,
      requiresMfa: ref(true),
      mfaChallengeToken: ref('token'),
      mfaMode: ref<'totp' | 'recovery'>('totp'),
      mfaCode: ref(''),
      mfaRecoveryCode: ref('')
    }
    mocks.overrideAuthState = state

    const mfaWrapper = mount(Login, {
      global: {
        stubs: globalStubs
      }
    })

    expect(mfaWrapper.find('form[aria-labelledby="mfa-title"]').exists()).toBe(true)
    expect(mfaWrapper.find('#mfa-code').exists()).toBe(true)
    expect(mfaWrapper.find('#mfa-recovery').exists()).toBe(false)

    // Switch mode to recovery
    state.mfaMode.value = 'recovery'
    await nextTick()

    expect(mfaWrapper.find('#mfa-code').exists()).toBe(false)
    expect(mfaWrapper.find('#mfa-recovery').exists()).toBe(true)

    // Form submit invokes handleMfaVerify
    await mfaWrapper.find('form[aria-labelledby="mfa-title"]').trigger('submit')
    expect(mfaHandle).toHaveBeenCalledOnce()
  })
})
