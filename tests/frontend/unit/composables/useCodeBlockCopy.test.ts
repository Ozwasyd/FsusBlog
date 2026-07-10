import { mount } from '@vue/test-utils'
import { defineComponent, nextTick, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useCodeBlockCopy } from '@/composables/article/useCodeBlockCopy'

const { revealMock, killMock } = vi.hoisted(() => ({
  revealMock: vi.fn(),
  killMock: vi.fn()
}))

vi.mock('@ozwasyd/element-plus/motion', () => ({
  useScrollReveal: () => ({
    reveal: revealMock,
    kill: killMock
  })
}))

vi.mock('@/fsusui/feedback', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn()
  }
}))

describe('useCodeBlockCopy', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.clearAllMocks()
  })

  it('does not insert code copy controls when Rights V3 disables code copying', async () => {
    const wrapper = mount(defineComponent({
      setup() {
        const root = ref<HTMLElement | null>(null)
        const allowCodeCopy = ref(false)
        const controls = useCodeBlockCopy(() => root.value, () => allowCodeCopy.value)
        return { root, allowCodeCopy, refreshCodeCopy: controls.refresh }
      },
      template: '<div><div ref="root"><pre><code>const value = 1</code></pre></div></div>'
    }))

    await nextTick()
    await (wrapper.vm as unknown as { refreshCodeCopy: () => Promise<void> }).refreshCodeCopy()

    expect(wrapper.element.querySelector('.fsus-code-copy-button')).toBeNull()
    expect(wrapper.element.querySelector('pre')?.hasAttribute('data-fsus-code-copy')).toBe(false)

    ;(wrapper.vm as unknown as { allowCodeCopy: boolean }).allowCodeCopy = true
    await nextTick()
    await (wrapper.vm as unknown as { refreshCodeCopy: () => Promise<void> }).refreshCodeCopy()

    expect(wrapper.element.querySelector('.fsus-code-copy-button')).not.toBeNull()
    expect(wrapper.element.querySelector('pre')?.getAttribute('data-fsus-code-copy')).toBe('true')

    ;(wrapper.vm as unknown as { allowCodeCopy: boolean }).allowCodeCopy = false
    await nextTick()
    await (wrapper.vm as unknown as { refreshCodeCopy: () => Promise<void> }).refreshCodeCopy()

    expect(wrapper.element.querySelector('.fsus-code-copy-button')).toBeNull()
    expect(wrapper.element.querySelector('pre')?.hasAttribute('data-fsus-code-copy')).toBe(false)

    wrapper.unmount()
  })

  it('keeps code copy usable when motion reveal cannot initialize', async () => {
    revealMock.mockImplementationOnce(() => {
      throw new ReferenceError('ScrollTrigger environment is unavailable')
    })
    const wrapper = mount(defineComponent({
      setup() {
        const root = ref<HTMLElement | null>(null)
        const controls = useCodeBlockCopy(() => root.value, true)
        return { root, refreshCodeCopy: controls.refresh }
      },
      template: '<div><div ref="root"><pre><code>const value = 1</code></pre></div></div>'
    }))

    await nextTick()
    await (wrapper.vm as unknown as { refreshCodeCopy: () => Promise<void> }).refreshCodeCopy()

    expect(wrapper.element.querySelector('.fsus-code-copy-button')).not.toBeNull()
    expect(wrapper.element.querySelector('pre')?.getAttribute('data-fsus-code-copy')).toBe('true')

    wrapper.unmount()
  })
})
