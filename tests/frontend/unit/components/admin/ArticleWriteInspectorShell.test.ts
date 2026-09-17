// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import { describe, expect, it, vi } from 'vitest'

import ArticleWriteCommandBar from '@/components/admin/article/ArticleWriteCommandBar.vue'
import ArticleWriteInspectorShell from '@/components/admin/article/ArticleWriteInspectorShell.vue'
import { useArticleWriteInspector } from '@/composables/useArticleWriteInspector'

const DrawerStub = defineComponent({
  name: 'ElDrawer',
  inheritAttrs: false,
  props: {
    modelValue: Boolean,
    title: String,
    modal: Boolean,
    lockScroll: Boolean,
    destroyOnClose: Boolean,
    size: [String, Number]
  },
  emits: ['update:modelValue', 'closed'],
  template: `
    <div
      v-show="modelValue"
      data-drawer
      :data-modal="String(modal)"
      :data-lock-scroll="String(lockScroll)"
      :data-destroy-on-close="String(destroyOnClose)"
      :data-size="String(size)"
    >
      <span data-drawer-title>{{ title }}</span>
      <slot />
    </div>
  `
})

const TaskPageHeaderStub = defineComponent({
  template: '<header><slot name="title" /><slot name="actions" /></header>'
})

describe('ArticleWriteInspectorShell', () => {
  it('keeps one interactive view without remounting the editor sentinel', async () => {
    const editorMounted = vi.fn()
    const EditorSentinel = defineComponent({
      setup() {
        editorMounted()
        return () => h('textarea', {
          'data-editor-sentinel': 'stable',
          value: '正文保持不变'
        })
      }
    })
    const Harness = defineComponent({
      components: {
        ArticleWriteInspectorShell,
        EditorSentinel
      },
      setup() {
        const inspector = useArticleWriteInspector()
        return {
          ...inspector
        }
      },
      template: `
        <div>
          <EditorSentinel />
          <ArticleWriteInspectorShell
            :active-inspector="activeInspector"
            :register-trigger-element="registerTrigger"
            :register-scroll-element="registerScrollContainer"
            @activate="open"
            @switch="switchTo"
            @close="close"
            @closed="restoreFocus"
            @scroll="updateScroll"
          >
            <template #publish><button data-slot-action="publish">发布设置</button></template>
            <template #rights><button data-slot-action="rights">版权设置</button></template>
            <template #check><button data-slot-action="check">内容检查</button></template>
            <template #preview><button data-slot-action="preview">阅读预览</button></template>
            <template #versions><button data-slot-action="versions">版本记录</button></template>
            <template #resources><button data-slot-action="resources">资源库</button></template>
          </ArticleWriteInspectorShell>
        </div>
      `
    })
    const wrapper = mount(Harness, {
      attachTo: document.body,
      global: {
        components: {
          ElDrawer: DrawerStub
        },
        stubs: {
          ElIcon: { template: '<i><slot /></i>' }
        }
      }
    })
    const sentinel = wrapper.get('[data-editor-sentinel]').element

    await wrapper.get('button[aria-label="发布"]').trigger('click')
    expect(wrapper.get('aside[role="complementary"]').attributes('aria-label')).toBe('发布')
    expect(wrapper.get('.article-write-inspector-pane__title').text()).toBe('发布')
    expect(wrapper.find('[aria-modal="true"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-inspector-view][aria-hidden="false"]')).toHaveLength(1)
    expect(wrapper.get('[data-inspector-view="publish"]').attributes('inert')).toBeUndefined()
    expect(wrapper.get('[data-inspector-view="check"]').attributes('inert')).toBeDefined()

    await wrapper.get('button[aria-label="检查"]').trigger('click')
    expect(wrapper.get('.article-write-inspector-pane__title').text()).toBe('检查')
    expect(wrapper.findAll('[data-inspector-view][aria-hidden="false"]')).toHaveLength(1)
    expect(wrapper.get('[data-inspector-view="publish"]').attributes('aria-hidden')).toBe('true')
    expect(wrapper.get('[data-inspector-view="check"]').attributes('aria-hidden')).toBe('false')
    expect(wrapper.get('[data-editor-sentinel]').element).toBe(sentinel)
    expect(wrapper.get('[data-editor-sentinel]').element.getAttribute('value')).toBe('正文保持不变')
    expect(editorMounted).toHaveBeenCalledTimes(1)

    await wrapper.get('button[aria-label="关闭文章检查器"]').trigger('click')
    await nextTick()
    await nextTick()
    expect(wrapper.get('aside[role="complementary"]').attributes('hidden')).toBeDefined()
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(wrapper.get('button[aria-label="检查"]').element)
    })
    wrapper.unmount()
  })

  it('closes the desktop complementary pane with Escape and restores the exact trigger', async () => {
    const Harness = defineComponent({
      components: {
        ArticleWriteInspectorShell
      },
      setup() {
        return useArticleWriteInspector()
      },
      template: `
        <ArticleWriteInspectorShell
          :active-inspector="activeInspector"
          :register-trigger-element="registerTrigger"
          @activate="open"
          @switch="switchTo"
          @close="close"
          @closed="restoreFocus"
        >
          <template #rights><button type="button">版权设置</button></template>
        </ArticleWriteInspectorShell>
      `
    })
    const wrapper = mount(Harness, {
      attachTo: document.body,
      global: {
        components: {
          ElDrawer: DrawerStub
        },
        stubs: {
          ElIcon: { template: '<i><slot /></i>' }
        }
      }
    })

    const rightsTrigger = wrapper.get('button[aria-label="版权"]')
    await rightsTrigger.trigger('click')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
    await nextTick()
    await nextTick()

    expect(wrapper.get('aside[role="complementary"]').attributes('hidden')).toBeDefined()
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(rightsTrigger.element)
    })
    wrapper.unmount()
  })

  it('uses one modal full-width drawer at the shared compact breakpoint', async () => {
    const originalMatchMedia = window.matchMedia
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(max-width: 1023px)',
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn()
    }))
    const Harness = defineComponent({
      components: {
        ArticleWriteInspectorShell
      },
      setup() {
        return useArticleWriteInspector()
      },
      template: `
        <ArticleWriteInspectorShell
          :active-inspector="activeInspector"
          :register-trigger-element="registerTrigger"
          @activate="open"
          @switch="switchTo"
          @close="close"
          @closed="restoreFocus"
        >
          <template #publish><button type="button">发布设置</button></template>
        </ArticleWriteInspectorShell>
      `
    })
    const wrapper = mount(Harness, {
      attachTo: document.body,
      global: {
        components: {
          ElDrawer: DrawerStub
        },
        stubs: {
          ElIcon: { template: '<i><slot /></i>' }
        }
      }
    })
    await nextTick()
    const launcher = wrapper.get('button[aria-label="打开文章检查器"]')
    await launcher.trigger('click')
    const drawer = wrapper.get('[data-drawer]')
    expect(drawer.attributes('data-modal')).toBe('true')
    expect(drawer.attributes('data-lock-scroll')).toBe('true')
    expect(drawer.attributes('data-destroy-on-close')).toBe('false')
    expect(drawer.attributes('data-size')).toBe('100%')
    expect(wrapper.findAllComponents(DrawerStub)).toHaveLength(1)
    expect(wrapper.find('aside[role="complementary"]').exists()).toBe(false)

    await wrapper.get('button[aria-label="版权"]').trigger('click')
    expect(wrapper.get('[data-inspector-view="rights"]').attributes('aria-hidden')).toBe('false')
    expect(wrapper.findAll('[data-inspector-view][aria-hidden="false"]')).toHaveLength(1)

    wrapper.getComponent(DrawerStub).vm.$emit('update:modelValue', false)
    await nextTick()
    wrapper.getComponent(DrawerStub).vm.$emit('closed')
    await nextTick()
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(launcher.element)
    })
    wrapper.unmount()
    window.matchMedia = originalMatchMedia
  })

  it('keeps a closed critical summary actionable without a count wall', async () => {
    const wrapper = mount(ArticleWriteCommandBar, {
      props: {
        pageTitle: '编辑文章',
        articleStateText: '草稿',
        statusText: '已保存',
        criticalStatusText: '2 项发布检查需处理',
        criticalStatusTarget: 'check',
        primaryActionText: '更新文章'
      },
      global: {
        stubs: {
          FsusUiTaskPageHeader: TaskPageHeaderStub,
          ElButton: {
            template: '<button type="button" @click="$emit(\'click\', $event)"><slot /></button>'
          }
        }
      }
    })
    const summary = wrapper.get('.article-write-command-bar__critical-status')
    await summary.trigger('click')
    expect(wrapper.emitted('openInspector')?.[0]?.[0]).toBe('check')
    expect(wrapper.text()).not.toContain('检查 2')
    expect(wrapper.findAll('.article-write-command-bar__critical-status')).toHaveLength(1)
    wrapper.unmount()
  })
})
