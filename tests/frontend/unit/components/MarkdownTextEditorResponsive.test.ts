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

    expect(wrapper.getComponent(MarkdownEditorStub).props('primaryCommandKeys')).toEqual(expected)
    wrapper.unmount()
  })
})
