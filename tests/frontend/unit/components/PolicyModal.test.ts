// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'

import PolicyModal from '@/components/PolicyModal.vue'
import { resetLocaleRuntimeForTests, setLocale } from '@/locales'

const dialogStub = {
  props: ['modelValue', 'title'],
  emits: ['update:modelValue', 'closed'],
  template: '<section><h2 data-test="dialog-title">{{ title }}</h2><slot /><slot name="footer" /></section>'
}

const mountPolicyModal = (type: 'privacy' | 'guidelines') => mount(PolicyModal, {
  props: {
    type,
    visible: false
  },
  global: {
    stubs: {
      FsusDialog: dialogStub,
      MarkdownRenderer: true,
      ElButton: true,
      ElScrollbar: { template: '<div><slot /></div>' },
      ElSkeleton: true
    }
  }
})

afterEach(() => {
  resetLocaleRuntimeForTests()
})

describe('PolicyModal localized title', () => {
  it('renders the registry-owned Chinese titles for both policy kinds', () => {
    const privacy = mountPolicyModal('privacy')
    const guidelines = mountPolicyModal('guidelines')

    expect(privacy.get('[data-test="dialog-title"]').text()).toBe('隐私政策')
    expect(guidelines.get('[data-test="dialog-title"]').text()).toBe('用户守则')

    privacy.unmount()
    guidelines.unmount()
  })

  it('updates the mounted title when the runtime locale and policy kind change', async () => {
    const wrapper = mountPolicyModal('privacy')

    setLocale('en-US')
    await nextTick()
    expect(wrapper.get('[data-test="dialog-title"]').text()).toBe('Privacy policy')

    await wrapper.setProps({ type: 'guidelines' })
    expect(wrapper.get('[data-test="dialog-title"]').text()).toBe('Site guidelines')

    setLocale('zh-CN')
    await nextTick()
    expect(wrapper.get('[data-test="dialog-title"]').text()).toBe('用户守则')

    wrapper.unmount()
  })
})
