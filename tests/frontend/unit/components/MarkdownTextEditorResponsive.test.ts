// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { defineComponent, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'

import MarkdownTextEditor from '@/components/ui/MarkdownTextEditor.vue'

const MarkdownEditorStub = defineComponent({
  name: 'ElMarkdownEditor',
  props: {
    primaryCommandKeys: {
      type: Array,
      default: () => []
    },
    chrome: {
      type: String,
      default: ''
    },
    statusDensity: {
      type: String,
      default: ''
    },
    showModeSwitcher: {
      type: Boolean,
      default: false
    }
  },
  template: '<div data-markdown-editor><slot name="status" /></div>'
})

describe('MarkdownTextEditor responsive command composition', () => {
  const originalMatchMedia = window.matchMedia

  afterEach(() => {
    window.matchMedia = originalMatchMedia
  })

  it.each([
    [true, ['h1', 'h2', 'bold']],
    [false, ['h1', 'h2', 'bold', 'italic', 'quote', 'link']]
  ] as const)('keeps all commands reachable when narrow=%s', async (narrow, expected) => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(max-width: 639px)' && narrow,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn()
    }))

    const wrapper = mount(MarkdownTextEditor, {
      props: {
        modelValue: '正文'
      },
      global: {
        stubs: {
          ElMarkdownEditor: MarkdownEditorStub
        }
      }
    })
    await nextTick()

    const editor = wrapper.getComponent(MarkdownEditorStub)
    expect(editor.props('primaryCommandKeys')).toEqual(expected)
    expect(editor.props('chrome')).toBe('framed')
    expect(editor.props('statusDensity')).toBe('minimal')
    expect(editor.props('showModeSwitcher')).toBe(true)
    wrapper.unmount()
  })
})
