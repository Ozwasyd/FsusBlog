// @vitest-environment happy-dom
// @fsusblog-vitest-host max-workers=1

import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, nextTick } from 'vue'
import type { Component } from 'vue'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  beginRecoveryPasskeyRegistration: vi.fn(),
  completeRecoveryPasskeyRegistration: vi.fn(),
  passkeyRegisterBegin: vi.fn(),
  passkeyRegisterComplete: vi.fn(),
  getPasskeySignalState: vi.fn(),
  startMfaChallenge: vi.fn(),
  startPasskeyRegistration: vi.fn(),
  verifyMfaChallenge: vi.fn(),
  commitAndReconcile: vi.fn()
}))

vi.mock('@/services/passkeyCeremony', () => ({
  startPasskeyRegistration: mocks.startPasskeyRegistration
}))

vi.mock('@/api/auth', () => ({
  beginRecoveryPasskeyRegistration: mocks.beginRecoveryPasskeyRegistration,
  completeRecoveryPasskeyRegistration: mocks.completeRecoveryPasskeyRegistration,
  passkeyRegisterBegin: mocks.passkeyRegisterBegin,
  passkeyRegisterComplete: mocks.passkeyRegisterComplete,
  getPasskeySignalState: mocks.getPasskeySignalState,
  startMfaChallenge: mocks.startMfaChallenge,
  verifyMfaChallenge: mocks.verifyMfaChallenge
}))

vi.mock('@/services/webauthnSignal', () => ({
  webauthnSignalService: {
    commitAndReconcile: mocks.commitAndReconcile
  }
}))

let PasskeyRegisterModal: Component

const DialogStub = defineComponent({
  props: {
    modelValue: { type: Boolean, required: true },
    title: { type: String, required: true }
  },
  template: '<section v-if="modelValue" role="dialog"><h2>{{ title }}</h2><slot /><footer><slot name="footer" /></footer></section>'
})

const ButtonStub = defineComponent({
  inheritAttrs: false,
  props: {
    disabled: { type: Boolean, default: false },
    loading: { type: Boolean, default: false },
    type: { type: String, default: '' }
  },
  emits: ['click'],
  template: '<button v-bind="$attrs" :data-type="type" :disabled="disabled || loading" @click="$emit(\'click\')"><slot /></button>'
})

const InputStub = defineComponent({
  inheritAttrs: false,
  props: {
    modelValue: { type: String, default: '' },
    disabled: { type: Boolean, default: false }
  },
  emits: ['update:modelValue'],
  template: '<input v-bind="$attrs" :value="modelValue" :disabled="disabled" @input="$emit(\'update:modelValue\', $event.target.value)" />'
})

const mountModal = (props: { visible: boolean, needsMfa?: boolean, recoverySessionToken?: string } = { visible: true }) =>
  mount(PasskeyRegisterModal, {
    props,
    global: {
      stubs: {
        Check: true,
        ElButton: ButtonStub,
        ElInput: InputStub,
        ElSkeleton: true,
        FsusDialog: DialogStub
      }
    }
  })

describe('PasskeyRegisterModal', () => {
  beforeAll(async () => {
    PasskeyRegisterModal = (await import('@/components/ui/PasskeyRegisterModal.vue')).default
  }, 30_000)

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.startMfaChallenge.mockResolvedValue({ proofToken: 'challenge-token' })
    mocks.verifyMfaChallenge.mockResolvedValue({ proofToken: 'mfa-proof' })
    mocks.passkeyRegisterBegin.mockResolvedValue({
      sessionKey: 'passkey-session',
      options: { challenge: 'challenge' }
    })
    mocks.startPasskeyRegistration.mockResolvedValue({ id: 'credential-1' })
    mocks.passkeyRegisterComplete.mockResolvedValue({ revision: 3 })
    mocks.commitAndReconcile.mockImplementation(async (commit: () => Promise<unknown>) => await commit())
  })

  it('runs the mounted MFA and WebAuthn state machine through the production auth adapter', async () => {
    const wrapper = mountModal({ visible: true, needsMfa: true })

    expect(wrapper.get('[role="dialog"]').attributes('aria-hidden')).toBeUndefined()
    expect(wrapper.find('#passkey-register-name').exists()).toBe(true)
    await wrapper.get('#passkey-register-name').setValue('工作电脑')
    await wrapper.get('button[data-type="primary"]').trigger('click')
    await nextTick()

    const verifyButton = wrapper.get('button[data-type="primary"]')
    expect(wrapper.find('#passkey-register-mfa-code').exists()).toBe(true)
    expect(verifyButton.attributes()).toHaveProperty('disabled')

    await wrapper.get('#passkey-register-mfa-code').setValue('123456')
    expect(verifyButton.attributes()).not.toHaveProperty('disabled')
    await verifyButton.trigger('click')
    await flushPromises()

    expect(mocks.startMfaChallenge).toHaveBeenCalledWith('passkey_register')
    expect(mocks.verifyMfaChallenge).toHaveBeenCalledWith(expect.objectContaining({
      challengeToken: 'challenge-token',
      code: '123456',
      action: 'passkey_register'
    }))
    expect(mocks.passkeyRegisterBegin).toHaveBeenCalledTimes(1)
    expect(mocks.startPasskeyRegistration).toHaveBeenCalledWith({ challenge: 'challenge' })
    await vi.waitFor(() => {
      expect(mocks.passkeyRegisterComplete).toHaveBeenCalledWith(expect.objectContaining({
        sessionKey: 'passkey-session',
        friendlyName: '工作电脑',
        mfaProofToken: 'mfa-proof'
      }))
    })
    expect(wrapper.text()).toContain('通行密钥注册成功')
    expect(mocks.commitAndReconcile).toHaveBeenCalledOnce()

    await wrapper.get('button[data-type="primary"]').trigger('click')
    expect(wrapper.emitted('success')).toHaveLength(1)
    expect(wrapper.emitted('update:visible')).toEqual([[false]])
  })

  it('keeps a failed registration inline and returns to the actionable name step', async () => {
    mocks.passkeyRegisterBegin.mockRejectedValue(new Error('认证器暂不可用'))
    const wrapper = mountModal({ visible: true })

    await wrapper.get('button[data-type="primary"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toBe('认证器暂不可用')
    expect(wrapper.find('#passkey-register-name').exists()).toBe(true)
    expect(wrapper.emitted('success')).toBeUndefined()
  })
})
