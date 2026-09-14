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
    commandOverflowLabel: {
      type: String,
      default: ''
    },
    commands: {
      type: Array,
      default: () => []
    }
  },
  template: '<div data-markdown-editor><slot name="status" /></div>'
})

function mockMatchMedia(narrow: boolean): void {
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
}

describe('MarkdownTextEditor responsive command composition', () => {
  const originalMatchMedia = window.matchMedia

  afterEach(() => {
    window.matchMedia = originalMatchMedia
  })

  it.each([
    [true, ['h1', 'h2', 'bold']],
    [false, ['h1', 'h2', 'bold', 'italic', 'quote', 'link']]
  ] as const)('keeps all commands reachable when narrow=%s', async (narrow, expected) => {
    mockMatchMedia(narrow)

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

  it('uses compact toolbar labels and overflow copy on the mobile command bar', async () => {
    mockMatchMedia(true)

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
    const commands = editor.props('commands') as Array<{ key: string; label: string; title: string; description?: string }>
    const byKey = Object.fromEntries(commands.map((command) => [command.key, command]))

    expect(editor.props('commandOverflowLabel')).toBe('更多')
    expect(byKey.h1).toMatchObject({ label: 'H1', title: 'H1', description: '插入一级标题' })
    expect(byKey.h2).toMatchObject({ label: 'H2', title: 'H2', description: '插入二级标题' })
    expect(byKey.bold).toMatchObject({ label: 'B', title: 'B', description: '加粗选中文本' })
    expect(wrapper.find('.markdown-text-editor__status-hint').exists()).toBe(true)
    wrapper.unmount()
  })

  it('keeps full command labels on the desktop toolbar', async () => {
    mockMatchMedia(false)

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
    const commands = editor.props('commands') as Array<{ key: string; label: string; title: string }>
    const byKey = Object.fromEntries(commands.map((command) => [command.key, command]))

    expect(editor.props('commandOverflowLabel')).toBe('格式工具')
    expect(byKey.h1).toMatchObject({ label: '一级标题', title: '一级标题' })
    expect(byKey.bold).toMatchObject({ label: '粗体', title: '粗体' })
    wrapper.unmount()
  })

  it('stacks status groups without a colliding grid on the mobile editor', async () => {
    mockMatchMedia(true)

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

    expect(wrapper.find('.markdown-text-editor__status').exists()).toBe(true)
    expect(wrapper.find('.markdown-text-editor__status-group--primary').exists()).toBe(true)
    expect(wrapper.find('.markdown-text-editor__status-group--metrics').exists()).toBe(true)
    expect(wrapper.find('.markdown-text-editor__status-group--secondary').exists()).toBe(true)
    expect(wrapper.find('.markdown-text-editor__status-hint').exists()).toBe(true)
    wrapper.unmount()
  })
})
