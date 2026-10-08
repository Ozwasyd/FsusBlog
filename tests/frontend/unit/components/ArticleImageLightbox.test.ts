// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick, reactive } from 'vue'
import ArticleImageLightbox from '@/components/article/ArticleImageLightbox.vue'

vi.mock('@/composables/useI18nText', () => ({
  useI18nText: () => ({ messages: reactive({ article: { actions: {
    viewImage: '查看大图', closeImage: '关闭大图', previousImage: '上一张', nextImage: '下一张'
  } } }) })
}))
const images = [{ src: '/fixtures/one.svg', alt: 'First figure' }, { src: '/fixtures/two.svg', alt: 'Second figure' }]
const wrappers: ReturnType<typeof mount>[] = []
const mountLightbox = (props = {}) => {
  const wrapper = mount(ArticleImageLightbox, { props: { open: true, images, activeIndex: 0, ...props }, attachTo: document.body })
  wrappers.push(wrapper)
  return wrapper
}
const settle = async () => { await flushPromises(); await nextTick(); await nextTick() }
const control = (wrapper: ReturnType<typeof mount>, name: string) => wrapper.get(`[role="button"][aria-label="${name}"]`)
const activeImage = (wrapper: ReturnType<typeof mount>) => wrapper.findAll('img').find(image => !image.classes().includes('is-hidden'))!

describe('ArticleImageLightbox public ImageViewer composition (#1892)', () => {
  afterEach(async () => {
    for (const wrapper of wrappers.splice(0)) wrapper.unmount()
    await new Promise(resolve => setTimeout(resolve, 250))
    document.body.innerHTML = ''
  })
  it('retains article names, alt and caption in one public dialog', async () => {
    const wrapper = mountLightbox()
    await settle()
    const dialogs = wrapper.findAll('[role="dialog"]')
    expect(dialogs).toHaveLength(1)
    expect(dialogs[0]!.attributes('aria-modal')).toBe('true')
    expect(dialogs[0]!.attributes('aria-label')).toBe('查看大图')
    expect(dialogs[0]!.attributes('data-fsus-material')).toBe('glass')
    expect(activeImage(wrapper).attributes('alt')).toBe('First figure')
    expect(activeImage(wrapper).attributes('src')).toBe('/fixtures/one.svg')
    expect(wrapper.find('[data-article-lightbox-caption]').text()).toBe('First figure')
    expect(dialogs[0]!.attributes('aria-describedby')).toBeTruthy()
    expect(wrapper.findAll('[role="button"]').map(button => button.attributes('aria-label'))).toEqual(['关闭大图', '上一张', '下一张'])
  })
  it('preserves single, closed and empty states without adding tools', async () => {
    const wrapper = mountLightbox({ images: [images[0]] })
    await settle()
    expect(wrapper.findAll('[role="button"]')).toHaveLength(1)
    await wrapper.setProps({ images: [] })
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    await wrapper.setProps({ images, open: false })
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
  })
  it('adapts circular two-image navigation intent and controlled active content', async () => {
    const wrapper = mountLightbox()
    await settle()
    await control(wrapper, '下一张').trigger('click')
    expect(wrapper.emitted('next')).toHaveLength(1)
    await wrapper.setProps({ activeIndex: 1 })
    expect(activeImage(wrapper).attributes('alt')).toBe('Second figure')
    expect(wrapper.find('[data-article-lightbox-caption]').text()).toBe('Second figure')
    await control(wrapper, '下一张').trigger('click')
    expect(wrapper.emitted('next')).toHaveLength(2)
    expect(wrapper.emitted('previous')).toBeUndefined()
    await wrapper.setProps({ activeIndex: 0 })
    await control(wrapper, '上一张').trigger('click')
    expect(wrapper.emitted('previous')).toHaveLength(1)
    await control(wrapper, '关闭大图').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
  it('does not close on image/caption clicks and handles document Escape', async () => {
    const wrapper = mountLightbox()
    await settle()
    await activeImage(wrapper).trigger('click')
    await wrapper.get('[data-article-lightbox-caption]').trigger('click')
    expect(wrapper.emitted('close')).toBeUndefined()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape' }))
    await settle()
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
  it('releases shared locks after repeated close and interrupted unmount', async () => {
    const wrapper = mountLightbox({ open: false })
    for (let i = 0; i < 20; i += 1) {
      await wrapper.setProps({ open: true })
      await settle()
      expect(document.body.classList.contains('el-popup-parent--hidden')).toBe(true)
      await wrapper.setProps({ open: false })
    }
    await wrapper.setProps({ open: true })
    wrapper.unmount()
    await new Promise(resolve => setTimeout(resolve, 250))
    expect(document.body.classList.contains('el-popup-parent--hidden')).toBe(false)
    expect(document.body.classList.contains('article-image-lightbox-open')).toBe(false)
    expect(document.querySelector('[inert]')).toBeNull()
  })
})
