// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { computed, defineComponent, nextTick, ref } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Login from '@/views/auth/Login.vue'
import Register from '@/views/auth/Register.vue'

type OnboardingState = {
  localError: Ref<string>
  publicHandle: Ref<string>
  publicHandleHint: Ref<string>
  isAgreed: Ref<boolean>
  showGuidelines: Ref<boolean>
  loading: Ref<boolean>
  step: Ref<'account' | 'recovery' | 'passkey' | 'complete'>
  recoveryKeyPlaintext: Ref<string>
  recoveryKeyVersion: Ref<number | null>
  recoveryKeyCreatedAt: Ref<string | null>
  recoveryKeySaved: Ref<boolean>
  passkeyModalVisible: Ref<boolean>
  isProcessing: ComputedRef<boolean>
  canCreateAnonymousAccount: ComputedRef<boolean>
  canRegisterPasskey: ComputedRef<boolean>
  handleGuidelinesActivator: ReturnType<typeof vi.fn>
  createAnonymousAccount: ReturnType<typeof vi.fn>
  copyRecoveryKey: ReturnType<typeof vi.fn>
  openPasskeyRegistration: ReturnType<typeof vi.fn>
  onPasskeyRegistered: ReturnType<typeof vi.fn>
  finishOnboarding: ReturnType<typeof vi.fn>
}

type LoginState = {
  errorMessage: Ref<string>
  rememberMe: Ref<boolean>
  isProcessing: Ref<boolean>
  handleMfaVerify: ReturnType<typeof vi.fn>
  requiresMfa: Ref<boolean>
  mfaMode: Ref<'totp' | 'recovery'>
  mfaCode: Ref<string>
  mfaRecoveryCode: Ref<string>
}

type PasskeyState = {
  loading: Ref<boolean>
  error: Ref<string>
  loginWithPasskey: ReturnType<typeof vi.fn>
  riskChallenge: {
    challengeVisible: Ref<boolean>
    challengeContext: Ref<unknown | null>
    challengeClient: object
    handleVerified: ReturnType<typeof vi.fn>
    handleError: ReturnType<typeof vi.fn>
    handleExpired: ReturnType<typeof vi.fn>
    handleCancel: ReturnType<typeof vi.fn>
  }
}

const state = vi.hoisted(() => ({
  login: null as LoginState | null,
  onboarding: null as OnboardingState | null,
  passkey: null as PasskeyState | null
}))

vi.mock('@/composables/useAnonymousOnboarding', () => ({
  useAnonymousOnboarding: () => state.onboarding
}))

vi.mock('@/composables/useAuthLogin', () => ({
  useAuthLogin: () => state.login
}))

vi.mock('@/composables/usePasskeyLogin', () => ({
  usePasskeyLogin: () => state.passkey
}))

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

const ElCheckboxStub = defineComponent({
  inheritAttrs: false,
  props: {
    modelValue: { type: Boolean, default: false },
    disabled: { type: Boolean, default: false }
  },
  emits: ['update:modelValue'],
  template: '<label><input v-bind="$attrs" type="checkbox" :checked="modelValue" :disabled="disabled" @change="$emit(\'update:modelValue\', $event.target.checked)" /><slot /></label>'
})

const PassthroughStub = defineComponent({
  template: '<div><slot /></div>'
})

const RouterLinkStub = defineComponent({
  inheritAttrs: false,
  props: {
    to: { type: [String, Object], required: true }
  },
  template: '<a v-bind="$attrs" :data-to="JSON.stringify(to)"><slot /></a>'
})

const mountOptions = {
  global: {
    stubs: {
      ElButton: ElButtonStub,
      ElCheckbox: ElCheckboxStub,
      ElIcon: PassthroughStub,
      ElInput: ElInputStub,
      ElRadioButton: PassthroughStub,
      ElRadioGroup: PassthroughStub,
      PasskeyRegisterModal: true,
      PolicyModal: true,
      RouterLink: RouterLinkStub
    }
  }
}

describe('auth page component states', () => {
  beforeEach(() => {
    const publicHandle = ref('')
    const publicHandleHint = ref('')
    const isAgreed = ref(false)
    const loading = ref(false)
    const step = ref<'account' | 'recovery' | 'passkey' | 'complete'>('account')
    const recoveryKeyPlaintext = ref('')
    const recoveryKeySaved = ref(false)

    state.onboarding = {
      localError: ref(''),
      publicHandle,
      publicHandleHint,
      isAgreed,
      showGuidelines: ref(false),
      loading,
      step,
      recoveryKeyPlaintext,
      recoveryKeyVersion: ref<number | null>(null),
      recoveryKeyCreatedAt: ref<string | null>(null),
      recoveryKeySaved,
      passkeyModalVisible: ref(false),
      isProcessing: computed(() => loading.value),
      canCreateAnonymousAccount: computed(() =>
        step.value === 'account'
          && isAgreed.value
          && publicHandle.value.trim().length > 0
          && !publicHandleHint.value
          && !loading.value
      ),
      canRegisterPasskey: computed(() =>
        step.value === 'recovery'
          && recoveryKeySaved.value
          && recoveryKeyPlaintext.value.length > 0
          && !loading.value
      ),
      handleGuidelinesActivator: vi.fn(),
      createAnonymousAccount: vi.fn(),
      copyRecoveryKey: vi.fn(),
      openPasskeyRegistration: vi.fn(),
      onPasskeyRegistered: vi.fn(),
      finishOnboarding: vi.fn()
    }

    state.login = {
      errorMessage: ref(''),
      rememberMe: ref(true),
      isProcessing: ref(false),
      handleMfaVerify: vi.fn(),
      requiresMfa: ref(false),
      mfaMode: ref<'totp' | 'recovery'>('totp'),
      mfaCode: ref(''),
      mfaRecoveryCode: ref('')
    }

    state.passkey = {
      loading: ref(false),
      error: ref(''),
      loginWithPasskey: vi.fn(),
      riskChallenge: {
        challengeVisible: ref(false),
        challengeContext: ref(null),
        challengeClient: {},
        handleVerified: vi.fn(),
        handleError: vi.fn(),
        handleExpired: vi.fn(),
        handleCancel: vi.fn()
      }
    }
  })

  it('enables registration only after valid input and agreement', async () => {
    const wrapper = mount(Register, mountOptions)
    const submit = wrapper.get('button[aria-describedby="register-error"]')

    expect(submit.attributes()).toHaveProperty('disabled')

    await wrapper.get('#public-handle').setValue('reader-one')
    await wrapper.get('#agreement').setValue(true)
    await nextTick()

    expect(wrapper.get('#public-handle').attributes('aria-invalid')).toBe('false')
    expect(submit.attributes()).not.toHaveProperty('disabled')
    await submit.trigger('click')
    expect(state.onboarding!.createAnonymousAccount).toHaveBeenCalledTimes(1)
  })

  it('keeps registration validation and adapter failures inline', async () => {
    const wrapper = mount(Register, mountOptions)
    const hint = state.onboarding!.publicHandleHint
    const error = state.onboarding!.localError

    hint.value = '公开名称格式不正确'
    error.value = '匿名账号创建失败。稍后重试。'
    await nextTick()

    expect(wrapper.get('#public-handle').attributes('aria-invalid')).toBe('true')
    expect(wrapper.get('#public-handle-hint').text()).toBe('公开名称格式不正确')
    expect(wrapper.get('#register-error').attributes('role')).toBe('alert')
    expect(wrapper.get('#register-error').text()).toContain('匿名账号创建失败')
  })

  it('renders passkey-first login and exposes a recoverable inline failure', async () => {
    const wrapper = mount(Login, mountOptions)

    expect(wrapper.find('#username').exists()).toBe(false)
    expect(wrapper.find('#password').exists()).toBe(false)
    expect(wrapper.get('a[data-to]').attributes('data-to')).toContain('/recover')

    const passkeyError = state.passkey!.error
    passkeyError.value = '通行密钥登录失败，请重试'
    await nextTick()

    expect(wrapper.get('[role="alert"]').text()).toContain('通行密钥登录失败，请重试')
    await wrapper.get('button').trigger('click')
    expect(state.passkey!.loginWithPasskey).toHaveBeenCalledWith(true)
  })

  it('keeps MFA validation state in the mounted page without a browser round trip', async () => {
    const requiresMfa = state.login!.requiresMfa
    const errorMessage = state.login!.errorMessage
    requiresMfa.value = true
    errorMessage.value = '请输入验证码'
    const wrapper = mount(Login, mountOptions)

    expect(wrapper.get('#mfa-code').attributes('aria-invalid')).toBe('true')
    expect(wrapper.get('#mfa-error').text()).toBe('请输入验证码')
    await wrapper.get('form').trigger('submit')
    expect(state.login!.handleMfaVerify).toHaveBeenCalledTimes(1)
  })
})
