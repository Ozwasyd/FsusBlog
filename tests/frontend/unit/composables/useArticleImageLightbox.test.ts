// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, nextTick, ref } from 'vue'

import { useArticleImageLightbox } from '@/composables/article/useArticleImageLightbox'
import { activateLocaleRuntime, resetLocaleRuntimeForTests } from '@/locales'

vi.mock('@ozwasyd/element-plus/motion', () => ({
  useScrollReveal: () => ({
    reveal: vi.fn(),
    kill: vi.fn()
  })
}))

describe('useArticleImageLightbox focus and media workflow (#1788)', () => {
  beforeEach(async () => {
    document.body.innerHTML = ''
    await activateLocaleRuntime('zh-CN', ['common', 'article', 'public', 'layout'])
  })

  afterEach(() => {
    document.body.innerHTML = ''
    resetLocaleRuntimeForTests()
  })

  const mountHarness = () => {
    const Host = defineComponent({
      setup() {
        const root = ref<HTMLElement | null>(null)
        const api = useArticleImageLightbox(root)
        return { root, ...api }
      },
      template: `
        <div ref="root">
          <img src="/fixtures/one.svg" alt="Alpha" />
          <img src="/fixtures/two.svg" alt="Beta" />
        </div>
      `
    })

    return mount(Host, { attachTo: document.body })
  }

  it('opens from the trigger image and restores focus after close', async () => {
    const wrapper = mountHarness()
    await nextTick()
    await nextTick()

    const root = wrapper.element
    if (!(root instanceof HTMLElement)) throw new Error('expected the lightbox harness HTML root')
    const images = root.querySelectorAll<HTMLImageElement>('img')
    expect(images).toHaveLength(2)

    images[0]!.focus()
    expect(document.activeElement).toBe(images[0])

    images[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()

    expect(wrapper.vm.open).toBe(true)
    expect(wrapper.vm.activeIndex).toBe(0)
    expect(wrapper.vm.images).toHaveLength(2)
    expect(wrapper.vm.images[0]?.alt).toBe('Alpha')

    wrapper.vm.next()
    expect(wrapper.vm.activeIndex).toBe(1)
    wrapper.vm.previous()
    expect(wrapper.vm.activeIndex).toBe(0)

    wrapper.vm.close()
    await nextTick()
    await nextTick()

    expect(wrapper.vm.open).toBe(false)
    expect(document.activeElement).toBe(images[0])

    // Keyboard re-open path remains available.
    images[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await nextTick()
    expect(wrapper.vm.open).toBe(true)

    wrapper.vm.close()
    await nextTick()
    await nextTick()
    expect(document.activeElement).toBe(images[0])

    wrapper.unmount()
  })

  it('opens via Space on a second image and restores that trigger', async () => {
    const wrapper = mountHarness()
    await nextTick()
    await nextTick()

    const root = wrapper.element
    if (!(root instanceof HTMLElement)) throw new Error('expected the lightbox harness HTML root')
    const images = root.querySelectorAll<HTMLImageElement>('img')
    images[1]!.focus()
    images[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    await nextTick()

    expect(wrapper.vm.open).toBe(true)
    expect(wrapper.vm.activeIndex).toBe(1)

    wrapper.vm.close()
    await nextTick()
    await nextTick()
    expect(document.activeElement).toBe(images[1])

    wrapper.unmount()
  })
})
