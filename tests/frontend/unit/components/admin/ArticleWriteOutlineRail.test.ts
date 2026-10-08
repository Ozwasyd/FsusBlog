// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { defineComponent, nextTick } from 'vue'
import { describe, expect, it, beforeEach, vi } from 'vitest'

import ArticleWriteOutlineRail from '@/components/admin/article/ArticleWriteOutlineRail.vue'
import { createArticleOutlineSnapshot } from '@/composables/useArticleOutline'

const iconStub = defineComponent({
  template: '<span><slot /></span>',
})

const snapshot = createArticleOutlineSnapshot({
  articleIdentity: 'article-a',
  documentIdentity: { id: 'article-a:tab', epoch: 1 },
  source: '# One\n\n## A long heading with an accessible name\n\n# One\n',
  sourceRevision: 0,
})

describe('ArticleWriteOutlineRail', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('opens a plain tree, preserves long accessible names and routes keyboard reveal', async () => {
    const wrapper = mount(ArticleWriteOutlineRail, {
      props: { snapshot },
      attachTo: document.body,
      global: { components: { ElIcon: iconStub, ElDrawer: iconStub } },
    })

    const launcher = wrapper.get('[data-article-outline-launcher="true"]')
    await launcher.trigger('click')
    expect(wrapper.get('[data-article-outline-panel="true"]')).toBeTruthy()

    const items = wrapper.findAll('[role="treeitem"]')
    expect(items).toHaveLength(3)
    expect(items[1]?.attributes('aria-label')).toBe('A long heading with an accessible name')
    expect(wrapper.findAll('[data-outline-diagnostic="duplicate-h1"]')).toHaveLength(1)

    await items[0]!.trigger('keydown', { key: 'ArrowLeft' })
    expect(wrapper.findAll('[role="treeitem"]')).toHaveLength(2)
    await wrapper.find('[role="treeitem"]').trigger('keydown', { key: 'ArrowRight' })
    expect(wrapper.findAll('[role="treeitem"]')).toHaveLength(3)
    await wrapper.findAll('[role="treeitem"]')[1]!.trigger('keydown', { key: ' ' })
    expect(wrapper.emitted('reveal-heading')).toHaveLength(1)

    await wrapper.find('[data-outline-diagnostic="duplicate-h1"]').trigger('click')
    expect(wrapper.emitted('reveal-range')).toHaveLength(1)

    await wrapper.get('[aria-label="关闭文章大纲"]').trigger('click')
    await nextTick()
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
    expect(document.activeElement).toBe(wrapper.get('[data-article-outline-launcher="true"]').element)
    wrapper.unmount()
  })

  it('persists only the open preference, never outline content or active ranges', async () => {
    const wrapper = mount(ArticleWriteOutlineRail, {
      props: { snapshot },
      global: { components: { ElIcon: iconStub, ElDrawer: iconStub } },
    })
    await wrapper.get('[data-article-outline-launcher="true"]').trigger('click')
    expect(window.localStorage.getItem('fsusblog.article-outline.rail-open.v1')).toBe('true')
    expect(window.localStorage.length).toBe(1)
    expect(window.localStorage.key(0)).toBe('fsusblog.article-outline.rail-open.v1')
    expect(window.localStorage.getItem('fsusblog.article-outline.rail-open.v1')).not.toContain('article-a')
    wrapper.unmount()
  })

  it('renders a single sentence for an empty outline', async () => {
    const wrapper = mount(ArticleWriteOutlineRail, {
      props: {
        snapshot: createArticleOutlineSnapshot({
          articleIdentity: 'article-empty',
          documentIdentity: { id: 'article-empty:tab', epoch: 1 },
          source: '没有标题的正文。',
          sourceRevision: 0,
        }),
      },
      global: { components: { ElIcon: iconStub, ElDrawer: iconStub } },
    })
    await wrapper.get('[data-article-outline-launcher="true"]').trigger('click')
    expect(wrapper.get('[data-article-outline-status="empty"]').text()).toBe('文章大纲正文中暂无标题。')
    expect(wrapper.find('[role="tree"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('keeps one roving tab stop and announces positions within canonical siblings', async () => {
    const wrapper = mount(ArticleWriteOutlineRail, {
      props: { snapshot, activeHeadingId: snapshot?.items[2]?.nodeId },
      attachTo: document.body,
      global: { components: { ElIcon: iconStub, ElDrawer: iconStub } },
    })
    await wrapper.get('[data-article-outline-launcher="true"]').trigger('click')
    const items = wrapper.findAll('[role="treeitem"]')
    expect(wrapper.findAll('[role="treeitem"][tabindex="0"]')).toHaveLength(1)
    expect(items[0]?.attributes('aria-setsize')).toBe('2')
    expect(items[1]?.attributes('aria-setsize')).toBe('1')
    expect(items[1]?.attributes('aria-posinset')).toBe('1')
    expect(items[2]?.attributes('aria-posinset')).toBe('2')
    ;(items[0]!.element as HTMLButtonElement).focus()
    await nextTick()
    await items[0]!.trigger('keydown', { key: 'ArrowDown' })
    await nextTick()
    expect(document.activeElement).toBe(items[1]!.element)
    expect(wrapper.findAll('[role="treeitem"][tabindex="0"]')).toHaveLength(1)
    expect(items[1]?.attributes('tabindex')).toBe('0')
    await wrapper.get('[data-outline-diagnostic="duplicate-h1"]').trigger('keydown', { key: 'Escape' })
    await nextTick()
    expect(wrapper.find('[data-article-outline-panel="true"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('defers mobile reveal until Drawer closure and rejects an obsolete revision', async () => {
    const media = vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    } as unknown as MediaQueryList)
    const drawer = defineComponent({
      props: ['modelValue'], emits: ['closed', 'update:modelValue'],
      template: '<div><slot v-if="modelValue" /></div>',
    })
    const wrapper = mount(ArticleWriteOutlineRail, {
      props: { snapshot },
      global: { components: { ElIcon: iconStub, ElDrawer: drawer } },
    })
    await wrapper.get('[data-article-outline-launcher="true"]').trigger('click')
    await wrapper.findAll('[role="treeitem"]')[1]!.trigger('click')
    expect(wrapper.emitted('reveal-heading')).toBeUndefined()
    wrapper.findComponent(drawer).vm.$emit('closed')
    await nextTick()
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
    expect(wrapper.emitted('reveal-heading')).toHaveLength(1)

    await wrapper.get('[data-article-outline-launcher="true"]').trigger('click')
    await wrapper.findAll('[role="treeitem"]')[1]!.trigger('click')
    await wrapper.setProps({ snapshot: snapshot ? { ...snapshot, sourceRevision: 1 } : null })
    wrapper.findComponent(drawer).vm.$emit('closed')
    await nextTick()
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
    expect(wrapper.emitted('reveal-heading')).toHaveLength(1)
    wrapper.unmount()
    media.mockRestore()
  })
})
