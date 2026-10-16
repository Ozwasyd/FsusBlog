// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, nextTick } from 'vue'
import { afterEach, describe, expect, it, beforeEach, vi } from 'vitest'

import { ElDrawer, ElIcon } from '@ozwasyd/element-plus'

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
  })
})

const outlineCleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of outlineCleanups.splice(0)) cleanup()
  vi.restoreAllMocks()
})

function controlCompactViewport(initial = true) {
  const original = window.matchMedia.bind(window)
  const media = original('(max-width: 1023px)')
  let compact = initial
  vi.spyOn(media, 'matches', 'get').mockImplementation(() => compact)
  vi.spyOn(window, 'matchMedia').mockImplementation((query) =>
    query === '(max-width: 1023px)' ? media : original(query))
  return async (value: boolean) => {
    compact = value
    media.dispatchEvent(new Event('change'))
    await nextTick()
  }
}

function controlFocusFrames() {
  let nextHandle = 0
  const frames = new Map<number, FrameRequestCallback>()
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    const handle = ++nextHandle
    frames.set(handle, callback)
    return handle
  })
  const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((handle) => {
    frames.delete(handle)
  })
  return {
    frames,
    cancel,
    flush() {
      const ready = [...frames.values()]
      frames.clear()
      for (const callback of ready) callback(0)
    },
  }
}

async function openCompactOutline(activation: 'pointer' | 'keyboard' = 'pointer') {
  const setCompact = controlCompactViewport()
  const frames = controlFocusFrames()
  const wrapper = mount(ArticleWriteOutlineRail, {
    props: { snapshot },
    attachTo: document.body,
    global: { components: { ElIcon, ElDrawer } },
  })
  outlineCleanups.push(() => wrapper.unmount())
  await nextTick()
  const launcher = wrapper.get<HTMLButtonElement>('[data-article-outline-launcher="true"]').element
  if (activation === 'keyboard') launcher.focus()
  await wrapper.get('[data-article-outline-launcher="true"]').trigger('click', { detail: activation === 'pointer' ? 1 : 0 })
  await nextTick()
  await nextTick()
  expect(wrapper.get<HTMLButtonElement>('[data-article-outline-launcher="true"]').element).toBe(launcher)
  expect(launcher.isConnected).toBe(true)
  expect(window.getComputedStyle(launcher).display).not.toBe('none')
  expect(launcher.disabled).toBe(false)
  const close = async (order: 'closed-first' | 'model-first' = 'closed-first') => {
    // Control only the real Drawer's public event order; its source and child tree remain mounted.
    const drawer = wrapper.getComponent(ElDrawer)
    drawer.vm.$emit('close')
    if (order === 'closed-first') {
      drawer.vm.$emit('closed')
      drawer.vm.$emit('update:modelValue', false)
    } else {
      drawer.vm.$emit('update:modelValue', false)
      drawer.vm.$emit('closed')
    }
    await nextTick()
    await nextTick()
  }
  return { wrapper, launcher, frames, close, setCompact }
}

describe('ArticleWriteOutlineRail focus intent ownership', () => {
  beforeEach(() => window.localStorage.clear())

  it.each(['closed-first', 'model-first'] as const)('lets the shared trap restore the same connected opener once for close order %s', async (order) => {
    const { wrapper, launcher, frames, close } = await openCompactOutline()
    const focus = vi.spyOn(launcher, 'focus')
    await close(order)
    expect(wrapper.get('[data-article-outline-launcher="true"]').element).toBe(launcher)
    expect(document.activeElement).toBe(launcher)
    expect(focus).toHaveBeenCalledTimes(1)
    expect(frames.frames.size).toBe(0)
    expect(frames.cancel).not.toHaveBeenCalled()
    wrapper.getComponent(ElDrawer).vm.$emit('closed')
    wrapper.getComponent(ElDrawer).vm.$emit('update:modelValue', false)
    await nextTick()
    expect(frames.frames.size).toBe(0)
    expect(focus).toHaveBeenCalledTimes(1)
  })

  it('leaves close A, open B and close B to the shared trap without a stale consumer task', async () => {
    const { wrapper, launcher, frames, close } = await openCompactOutline()
    const focus = vi.spyOn(launcher, 'focus')
    await close('model-first')
    expect(focus).toHaveBeenCalledTimes(1)
    await wrapper.get('[data-article-outline-launcher="true"]').trigger('click', { detail: 1 })
    await nextTick()
    await nextTick()
    const inside = document.activeElement
    expect(inside).not.toBe(launcher)
    wrapper.getComponent(ElDrawer).vm.$emit('closed')
    await nextTick()
    expect(document.activeElement).toBe(inside)
    expect(focus).toHaveBeenCalledTimes(1)
    await close('model-first')
    expect(focus).toHaveBeenCalledTimes(2)
    expect(document.activeElement).toBe(launcher)
    expect(wrapper.get('[data-article-outline-launcher="true"]').element).toBe(launcher)
    expect(frames.frames.size).toBe(0)
    expect(frames.cancel).not.toHaveBeenCalled()
  })

  it.each(['unmount', 'breakpoint', 'snapshot'] as const)('does not add a consumer focus task after shared restoration and %s', async (change) => {
    const { wrapper, launcher, frames, close, setCompact } = await openCompactOutline()
    const focus = vi.spyOn(launcher, 'focus')
    await close('model-first')
    expect(focus).toHaveBeenCalledTimes(1)
    if (change === 'unmount') {
      wrapper.unmount()
      outlineCleanups.pop()
    } else if (change === 'breakpoint') {
      await setCompact(false)
    } else {
      await wrapper.setProps({ snapshot: createArticleOutlineSnapshot({
        articleIdentity: 'article-b', documentIdentity: { id: 'article-b:tab', epoch: 1 },
        source: '# Replacement', sourceRevision: 0,
      }) })
    }
    frames.flush()
    await nextTick()
    expect(frames.frames.size).toBe(0)
    expect(frames.cancel).not.toHaveBeenCalled()
    expect(focus).toHaveBeenCalledTimes(1)
  })

  it('does not retarget focus after compact close while switching to the desktop host', async () => {
    const { wrapper, launcher, frames, close, setCompact } = await openCompactOutline()
    await close()
    const outside = document.createElement('button')
    document.body.append(outside)
    outlineCleanups.push(() => outside.remove())
    outside.focus()
    const focus = vi.spyOn(launcher, 'focus')
    await setCompact(false)
    frames.flush()
    await nextTick()
    expect(frames.frames.size).toBe(0)
    expect(document.activeElement).toBe(outside)
    expect(focus).not.toHaveBeenCalled()
    expect(wrapper.get('[data-article-outline-launcher="true"]').element).toBe(launcher)
  })

  it('invalidates a desktop close tick when switching to the compact host', async () => {
    const setCompact = controlCompactViewport(false)
    const frames = controlFocusFrames()
    const wrapper = mount(ArticleWriteOutlineRail, {
      props: { snapshot }, attachTo: document.body,
      global: { components: { ElIcon, ElDrawer } },
    })
    outlineCleanups.push(() => wrapper.unmount())
    await wrapper.get('[data-article-outline-launcher="true"]').trigger('click')
    wrapper.get<HTMLButtonElement>('[aria-label="关闭文章大纲"]').element.click()
    await setCompact(true)
    await nextTick()
    expect(frames.frames.size).toBe(0)
    expect(document.activeElement?.getAttribute('data-article-outline-launcher')).not.toBe('true')
  })

  it('does not schedule a frame after disposal during the compact close tick', async () => {
    const { wrapper, frames } = await openCompactOutline()
    const drawer = wrapper.getComponent(ElDrawer)
    drawer.vm.$emit('close')
    drawer.vm.$emit('update:modelValue', false)
    drawer.vm.$emit('closed')
    wrapper.unmount()
    outlineCleanups.pop()
    await nextTick()
    expect(frames.frames.size).toBe(0)
    expect(frames.cancel).not.toHaveBeenCalled()
  })

  it('returns tick focus failures to the existing Vue event error handler exactly once', async () => {
    const failure = new Error('outline tick focus failed')
    const errors: unknown[] = []
    const originalFocus = HTMLButtonElement.prototype.focus
    vi.spyOn(HTMLButtonElement.prototype, 'focus').mockImplementation(function (this: HTMLButtonElement, options?: FocusOptions) {
      if (this.hasAttribute('data-article-outline-launcher')) throw failure
      originalFocus.call(this, options)
    })
    const wrapper = mount(ArticleWriteOutlineRail, {
      props: { snapshot }, attachTo: document.body,
      global: {
        components: { ElIcon, ElDrawer },
        config: { errorHandler(error) { errors.push(error) } },
      },
    })
    outlineCleanups.push(() => wrapper.unmount())
    await wrapper.get('[data-article-outline-launcher="true"]').trigger('click')
    await wrapper.get('[aria-label="关闭文章大纲"]').trigger('click')
    await flushPromises()
    expect(errors).toEqual([failure])
  })

  it('lets the shared trap restore a keyboard opener without a second handler or frame', async () => {
    const { launcher, frames, close } = await openCompactOutline('keyboard')
    const focus = vi.spyOn(launcher, 'focus')
    await close('model-first')
    expect(document.activeElement).toBe(launcher)
    expect(focus).toHaveBeenCalledTimes(1)
    expect(frames.frames.size).toBe(0)
    expect(frames.cancel).not.toHaveBeenCalled()
  })

  it('delegates the actual public Drawer built-in close through its real lifecycle', async () => {
    controlCompactViewport()
    const wrapper = mount(ArticleWriteOutlineRail, {
      props: { snapshot }, attachTo: document.body,
      global: { components: { ElIcon, ElDrawer }, stubs: { transition: false } },
    })
    outlineCleanups.push(() => wrapper.unmount())
    await nextTick()
    const launcher = wrapper.get<HTMLButtonElement>('[data-article-outline-launcher="true"]').element
    await wrapper.get('[data-article-outline-launcher="true"]').trigger('click', { detail: 1 })
    await flushPromises()
    expect(wrapper.get('[data-article-outline-launcher="true"]').element).toBe(launcher)
    expect(window.getComputedStyle(launcher).display).not.toBe('none')
    const dialog = wrapper.get('[role="dialog"][aria-label="文章大纲"]')
    const button = dialog.get<HTMLButtonElement>('header button[aria-label]')
    expect(button.attributes('aria-label')).toBeTruthy()
    await button.trigger('click')
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(wrapper.get('[data-article-outline-launcher="true"]').element)
      expect(wrapper.getComponent(ElDrawer).emitted('closed')).toHaveLength(1)
      expect(wrapper.getComponent(ElDrawer).emitted('update:modelValue')).toEqual([[false]])
    })
  })
})

describe('ArticleWriteOutlineRail transient tree navigation', () => {
  const nested = createArticleOutlineSnapshot({
    articleIdentity: 'nested-article', documentIdentity: { id: 'nested-tab', epoch: 1 },
    source: '# First\n\n### First A\n\n### First B\n\n# Second\n\n## Second A\n', sourceRevision: 0,
  })

  beforeEach(() => window.localStorage.clear())

  it('uses true sibling positions and one tab stop while navigation preserves selection', async () => {
    const selectedId = nested?.items[2]?.nodeId
    expect(selectedId).toBeDefined()
    const wrapper = mount(ArticleWriteOutlineRail, {
      props: { snapshot: nested, activeHeadingId: selectedId }, attachTo: document.body,
      global: { components: { ElIcon, ElDrawer } },
    })
    outlineCleanups.push(() => wrapper.unmount())
    await wrapper.get('[data-article-outline-launcher="true"]').trigger('click')
    const items = wrapper.findAll<HTMLButtonElement>('[role="treeitem"]')
    expect(items.map((item) => item.attributes('aria-level'))).toEqual(['1', '2', '2', '1', '2'])
    expect(items.map((item) => [item.attributes('aria-posinset'), item.attributes('aria-setsize')])).toEqual([
      ['1', '2'], ['1', '2'], ['2', '2'], ['2', '2'], ['1', '1'],
    ])
    expect(wrapper.findAll('[role="treeitem"][tabindex="0"]')).toHaveLength(1)
    expect(items[2]?.attributes('tabindex')).toBe('0')
    items[2]?.element.focus()
    await items[2]?.trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items[3]?.element)
    expect(wrapper.findAll('[role="treeitem"][tabindex="0"]')).toHaveLength(1)
    expect(items[3]?.attributes('tabindex')).toBe('0')
    await items[3]?.trigger('keydown', { key: 'Home' })
    expect(document.activeElement).toBe(items[0]?.element)
    await items[0]?.trigger('keydown', { key: 'End' })
    expect(document.activeElement).toBe(items[4]?.element)
    expect(items[4]?.attributes('tabindex')).toBe('0')
    expect(wrapper.findAll('[role="treeitem"][aria-selected="true"]')).toHaveLength(1)
    expect(items[2]?.attributes('aria-selected')).toBe('true')
    expect(wrapper.emitted('reveal-heading')).toBeUndefined()
  })

  it('moves a collapsed descendant tab stop to its visible parent and resets removed snapshots', async () => {
    const wrapper = mount(ArticleWriteOutlineRail, {
      props: { snapshot: nested }, attachTo: document.body,
      global: { components: { ElIcon, ElDrawer } },
    })
    outlineCleanups.push(() => wrapper.unmount())
    await wrapper.get('[data-article-outline-launcher="true"]').trigger('click')
    const items = wrapper.findAll<HTMLButtonElement>('[role="treeitem"]')
    items[2]?.element.focus()
    await nextTick()
    await items[0]?.get('[aria-hidden="true"]').trigger('click')
    await nextTick()
    expect(document.activeElement).toBe(items[0]?.element)
    expect(wrapper.findAll('[role="treeitem"][tabindex="0"]')).toHaveLength(1)
    expect(items[0]?.attributes('tabindex')).toBe('0')
    await wrapper.setProps({ snapshot })
    expect(wrapper.findAll('[role="treeitem"][tabindex="0"]')).toHaveLength(1)
    expect(wrapper.find('[role="treeitem"]').attributes('tabindex')).toBe('0')
  })
})
