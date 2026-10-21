// @vitest-environment happy-dom

import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick, reactive } from 'vue'

import ArticleImageLightbox from '@/components/article/ArticleImageLightbox.vue'

vi.mock('@/composables/useI18nText', () => ({
  useI18nText: () => ({
    messages: reactive({
      common: {
        actions: {
          close: '关闭'
        }
      },
      article: {
        actions: {
          viewImage: '查看大图',
          closeImage: '关闭大图',
          previousImage: '上一张',
          nextImage: '下一张'
        }
      }
    })
  })
}))

const images = [
  { src: '/fixtures/one.svg', alt: 'First figure' },
  { src: '/fixtures/two.svg', alt: 'Second figure' }
] as const

const mountLightbox = (props: {
  open?: boolean
  images?: Array<{ src: string; alt: string }>
  activeIndex?: number
} = {}) => mount(ArticleImageLightbox, {
  props: {
    open: props.open ?? true,
    images: props.images ?? [...images],
    activeIndex: props.activeIndex ?? 0
  },
  attachTo: document.body,
  global: {
    stubs: {
      // Keep content in-tree for deterministic unit queries; Blog still owns Teleport at runtime.
      teleport: true,
      Transition: false,
      FsuTransition: {
        name: 'FsuTransition',
        template: '<div data-test="fsu-transition"><slot /></div>'
      }
    }
  }
})

describe('ArticleImageLightbox Overlay migration (#1788)', () => {
  afterEach(() => {
    document.body.className = ''
    document.body.innerHTML = ''
  })

  it('renders media content through FsusUiOverlay scrim root', async () => {
    const wrapper = mountLightbox()
    await flushPromises()
    await nextTick()

    expect(wrapper.find('.el-overlay').exists()).toBe(true)
    const dialog = wrapper.find('[data-article-lightbox="true"]')
    expect(dialog.exists()).toBe(true)
    expect(dialog.attributes('role')).toBe('dialog')
    expect(dialog.attributes('aria-modal')).toBe('true')
    expect(dialog.attributes('data-fsus-material')).toBe('glass')
    expect(dialog.attributes('aria-label')).toBe('查看大图')
    expect(wrapper.find('.article-image-lightbox img').attributes('alt')).toBe('First figure')
    expect(wrapper.find('.article-image-lightbox img').attributes('src')).toBe('/fixtures/one.svg')
    expect(wrapper.find('figcaption').text()).toBe('First figure')
    expect(wrapper.html()).not.toMatch(/image-viewer|ElImageViewer/i)

    wrapper.unmount()
  })

  it('renders navigation controls conditionally based on image count', async () => {
    const singleWrapper = mountLightbox({
      images: [{ src: '/fixtures/single.svg', alt: 'Single figure' }],
      activeIndex: 0
    })
    await flushPromises()
    await nextTick()

    expect(singleWrapper.find('.article-image-lightbox__close').exists()).toBe(true)
    expect(singleWrapper.find('.article-image-lightbox__nav--prev').exists()).toBe(false)
    expect(singleWrapper.find('.article-image-lightbox__nav--next').exists()).toBe(false)
    singleWrapper.unmount()

    const multiWrapper = mountLightbox({
      images: [
        { src: '/fixtures/one.svg', alt: 'First' },
        { src: '/fixtures/two.svg', alt: 'Second' }
      ],
      activeIndex: 0
    })
    await flushPromises()
    await nextTick()

    expect(multiWrapper.find('.article-image-lightbox__close').exists()).toBe(true)
    expect(multiWrapper.find('.article-image-lightbox__nav--prev').exists()).toBe(true)
    expect(multiWrapper.find('.article-image-lightbox__nav--next').exists()).toBe(true)
    expect(multiWrapper.find('.article-image-lightbox__nav--prev').attributes('aria-label')).toBe('上一张')
    expect(multiWrapper.find('.article-image-lightbox__nav--next').attributes('aria-label')).toBe('下一张')
    multiWrapper.unmount()
  })

  it('handles empty images gracefully without rendering overlay', async () => {
    const wrapper = mountLightbox({
      images: [],
      activeIndex: 0
    })
    await flushPromises()
    await nextTick()

    expect(wrapper.find('.el-overlay').exists()).toBe(false)
    expect(wrapper.find('[data-article-lightbox="true"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('emits previous/next and close from controls without losing active media', async () => {
    const wrapper = mountLightbox({ activeIndex: 0 })
    await flushPromises()
    await nextTick()

    await wrapper.get('.article-image-lightbox__nav--next').trigger('click')
    expect(wrapper.emitted('next')).toHaveLength(1)

    await wrapper.setProps({ activeIndex: 1 })
    await nextTick()
    expect(wrapper.find('.article-image-lightbox img').attributes('alt')).toBe('Second figure')
    expect(wrapper.find('.article-image-lightbox img').attributes('src')).toBe('/fixtures/two.svg')
    expect(wrapper.find('figcaption').text()).toBe('Second figure')

    await wrapper.get('.article-image-lightbox__nav--prev').trigger('click')
    expect(wrapper.emitted('previous')).toHaveLength(1)

    await wrapper.get('.article-image-lightbox__close').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)

    wrapper.unmount()
  })

  it('closes on overlay backdrop click but not on image or caption', async () => {
    const wrapper = mountLightbox()
    await flushPromises()
    await nextTick()

    const overlay = wrapper.get('.el-overlay')
    const figure = wrapper.get('.article-image-lightbox__figure')
    const img = wrapper.get('.article-image-lightbox__figure img')
    const caption = wrapper.get('figcaption')

    await figure.trigger('mousedown')
    await figure.trigger('mouseup')
    await figure.trigger('click')
    await img.trigger('mousedown')
    await img.trigger('mouseup')
    await img.trigger('click')
    await caption.trigger('mousedown')
    await caption.trigger('mouseup')
    await caption.trigger('click')
    expect(wrapper.emitted('close') ?? []).toHaveLength(0)

    // Overlay useSameTarget: only same-target mask clicks emit.
    await overlay.trigger('mousedown')
    await overlay.trigger('mouseup')
    await overlay.trigger('click')
    await nextTick()
    expect(wrapper.emitted('close')?.length ?? 0).toBeGreaterThanOrEqual(1)

    wrapper.unmount()
  })

  it('closes on Escape while dialog owns focus', async () => {
    const wrapper = mountLightbox()
    await flushPromises()
    await nextTick()

    const dialog = wrapper.get('[data-article-lightbox="true"]')
    ;(dialog.element as HTMLElement).focus()
    expect(document.activeElement).toBe(dialog.element)

    await dialog.trigger('keydown.esc')
    expect(wrapper.emitted('close')).toHaveLength(1)

    wrapper.unmount()
  })

  it('locks body scroll on open and clears on close and unmount', async () => {
    const wrapper = mountLightbox({ open: false })
    await flushPromises()
    expect(document.body.classList.contains('article-image-lightbox-open')).toBe(false)

    await wrapper.setProps({ open: true })
    await nextTick()
    expect(document.body.classList.contains('article-image-lightbox-open')).toBe(true)

    for (let i = 0; i < 20; i += 1) {
      await wrapper.setProps({ open: false })
      await nextTick()
      expect(document.body.classList.contains('article-image-lightbox-open')).toBe(false)
      await wrapper.setProps({ open: true })
      await nextTick()
      expect(document.body.classList.contains('article-image-lightbox-open')).toBe(true)
    }

    await wrapper.setProps({ open: false })
    await nextTick()
    expect(document.body.classList.contains('article-image-lightbox-open')).toBe(false)

    await wrapper.setProps({ open: true })
    await nextTick()
    wrapper.unmount()
    expect(document.body.classList.contains('article-image-lightbox-open')).toBe(false)
  })

  it('does not introduce ImageViewer markers into the mounted tree', async () => {
    const wrapper = mountLightbox()
    await flushPromises()
    await nextTick()
    expect(wrapper.find('.el-image-viewer').exists()).toBe(false)
    expect(wrapper.html()).not.toMatch(/image-viewer|zoom-in|rotate/i)
    wrapper.unmount()
  })
})
