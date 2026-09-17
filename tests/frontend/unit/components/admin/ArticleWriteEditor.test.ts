// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { defineComponent, nextTick } from 'vue'
import { describe, expect, it } from 'vitest'

import ArticleWriteEditor from '@/components/admin/article/ArticleWriteEditor.vue'

const AdapterStub = defineComponent({
  name: 'MarkdownEditorAdapter',
  props: {
    chrome: { type: String, default: 'framed' },
    statusDensity: { type: String, default: 'detailed' },
    showModeSwitcher: { type: Boolean, default: true },
    toolbarDensity: { type: String, default: 'standard' },
    mode: { type: String, default: 'preview' },
    labelledBy: { type: String, default: '' },
    accessibleName: { type: String, default: '' },
    modelValue: { type: String, default: '' }
  },
  template: '<div data-markdown-adapter />'
})

describe('ArticleWriteEditor document canvas', () => {
  it('consumes embedded/minimal chrome and keeps live/source off a four-mode header', async () => {
    const wrapper = mount(ArticleWriteEditor, {
      props: {
        modelValue: '正文草稿'
      },
      global: {
        stubs: {
          MarkdownEditorAdapter: AdapterStub
        }
      }
    })

    const adapter = wrapper.getComponent(AdapterStub)
    expect(adapter.props('chrome')).toBe('embedded')
    expect(adapter.props('statusDensity')).toBe('minimal')
    expect(adapter.props('showModeSwitcher')).toBe(false)
    expect(adapter.props('toolbarDensity')).toBe('minimal')
    expect(adapter.props('mode')).toBe('source')
    expect(adapter.props('labelledBy')).toBe('article-body-heading')
    expect(wrapper.find('.editor-shell__header').exists()).toBe(false)
    expect(wrapper.findAll('[role="radio"]').length).toBe(0)

    await wrapper.get('[data-authoring-surface="live"]').trigger('click')
    await nextTick()
    expect(wrapper.getComponent(AdapterStub).props('mode')).toBe('live')

    await wrapper.get('[data-authoring-tool="source-compare"]').trigger('click')
    await nextTick()
    expect(wrapper.getComponent(AdapterStub).props('mode')).toBe('split')
    expect(wrapper.get('[data-authoring-tool="source-compare"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.get('[data-authoring-surface="live"]').attributes('aria-pressed')).toBe('true')

    wrapper.unmount()
  })
})
