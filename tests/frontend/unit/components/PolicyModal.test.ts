// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

import PolicyModal from '@/components/PolicyModal.vue'
import { getPageData } from '@/api/system'
import { resetLocaleRuntimeForTests, setLocale } from '@/locales'

vi.mock('@/api/system', () => ({
  getPageData: vi.fn()
}))

const dialogStub = {
  props: ['modelValue', 'title'],
  emits: ['update:modelValue', 'closed'],
  template: '<section><h2 data-test="dialog-title">{{ title }}</h2><slot /><slot name="footer" /></section>'
}

const markdownRendererStub = {
  inheritAttrs: false,
  props: ['content', 'mode'],
  template: `
    <article
      data-test="policy-document"
      v-bind="$attrs"
      :data-mode="mode"
    >
      <h1>Policy title</h1>
      <p>{{ content }}</p>
      <blockquote><p>Policy note</p></blockquote>
    </article>
  `
}

const mountPolicyModal = (type: 'privacy' | 'guidelines') => mount(PolicyModal, {
  props: {
    type,
    visible: false
  },
  global: {
    stubs: {
      FsusDialog: dialogStub,
      MarkdownRenderer: markdownRendererStub,
      ElButton: true,
      ElScrollbar: { template: '<div><slot /></div>' },
      ElSkeleton: true
    }
  }
})

afterEach(() => {
  vi.mocked(getPageData).mockReset()
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

describe('PolicyModal document style ownership', () => {
  it('renders fetched policy copy through the stable consumer-owned document surface', async () => {
    vi.mocked(getPageData).mockResolvedValue({
      data: {
        content: 'Policy body'
      }
    } as never)
    const wrapper = mountPolicyModal('privacy')

    await wrapper.setProps({ visible: true })
    await flushPromises()

    const document = wrapper.get('[data-test="policy-document"]')
    expect(document.classes()).toContain('policy-legal-doc')
    expect(document.attributes('data-policy-document')).toBe('')
    expect(document.attributes('data-mode')).toBe('about')
    expect(document.get('p').text()).toBe('Policy body')
    expect(document.findAll('h1')).toHaveLength(1)
    expect(document.findAll('blockquote')).toHaveLength(1)

    wrapper.unmount()
  })

  it('does not pierce rendered markdown with scoped deep selectors', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/components/PolicyModal.vue'),
      'utf8'
    )
    const style = source.match(/<style[^>]*>([\s\S]*?)<\/style>/u)?.[1] ?? ''

    expect(source.match(/:deep\(/gu) ?? []).toHaveLength(0)
    expect(source).toContain('class="policy-legal-doc"')
    expect(source).toContain('data-policy-document')
    expect(source).toContain('mode="about"')
    expect(style).toContain('[data-policy-document].policy-legal-doc')
    expect(
      style.replaceAll('[data-policy-document].policy-legal-doc', '')
    ).not.toContain('.policy-legal-doc')
    expect(style).not.toContain('.el-')
    expect(style).not.toContain('!important')
    expect(style).not.toMatch(/(?:^|[\s{;])margin(?:-[a-z]+)?:\s*-/mu)
    expect(style).not.toContain('position: absolute')
  })
})
