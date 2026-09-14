// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { defineComponent, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  articleBodyCommandOverflowLabel,
  articleBodyCommandSurfaces,
  articleBodyLocaleText,
  articleBodyPrimaryCommandKeys
} from '@/components/ui/markdown-editor/articleBodyCommandConfig'
import MarkdownTextEditor from '@/components/ui/MarkdownTextEditor.vue'

vi.mock('@ozwasyd/element-plus', async () => {
  const vue = await import('vue')
  const command = (key: string, group: string, priority: number) => ({
    key,
    label: key,
    group,
    priority,
    run: () => ({})
  })
  return {
    ElMarkdownEditor: vue.defineComponent({
      name: 'ElMarkdownEditor',
      props: {
        primaryCommandKeys: { type: Array, default: () => [] },
        commands: { type: Array, default: () => [] },
        surfaces: { type: Object, default: () => ({}) },
        localeText: { type: Object, default: () => ({}) },
        commandOverflowLabel: { type: String, default: '' },
        toolbarDensity: { type: String, default: '' },
        mobileLayout: { type: String, default: '' }
      },
      template: '<div data-markdown-editor><slot name="status" /></div>'
    }),
    defaultMarkdownEditorCommands: [
      command('heading', 'block', 80),
      command('bold', 'format', 100),
      command('italic', 'format', 90),
      command('quote', 'block', 70),
      command('code', 'format', 60),
      command('link', 'insert', 50),
      command('image', 'insert', 40)
    ]
  }
})

const MarkdownEditorStub = defineComponent({
  name: 'ElMarkdownEditor',
  props: {
    primaryCommandKeys: {
      type: Array,
      default: () => []
    },
    commands: {
      type: Array,
      default: () => []
    },
    surfaces: {
      type: Object,
      default: () => ({})
    },
    localeText: {
      type: Object,
      default: () => ({})
    },
    commandOverflowLabel: {
      type: String,
      default: ''
    },
    toolbarDensity: {
      type: String,
      default: ''
    },
    mobileLayout: {
      type: String,
      default: ''
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

describe('MarkdownTextEditor article body command composition', () => {
  const originalMatchMedia = window.matchMedia

  afterEach(() => {
    window.matchMedia = originalMatchMedia
  })

  const mountEditor = async (modelValue: string, narrow = false) => {
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
        modelValue
      },
      global: {
        stubs: {
          ElMarkdownEditor: MarkdownEditorStub
        }
      }
    })
    await nextTick()
    return wrapper
  }

  it.each([true, false] as const)('uses the same six primary keys when narrow=%s', async (narrow) => {
    const wrapper = await mountEditor('正文', narrow)
    const editor = wrapper.getComponent(MarkdownEditorStub)

    expect(editor.props('primaryCommandKeys')).toEqual([...articleBodyPrimaryCommandKeys])
    expect(editor.props('surfaces')).toEqual(articleBodyCommandSurfaces)
    expect(editor.props('localeText')).toEqual(articleBodyLocaleText)
    expect(editor.props('commandOverflowLabel')).toBe(articleBodyCommandOverflowLabel)
    expect(editor.props('toolbarDensity')).toBe('standard')
    expect(editor.props('mobileLayout')).toBe('auto')
    expect(editor.props('chrome')).toBe('framed')
    expect(editor.props('statusDensity')).toBe('minimal')
    expect(editor.props('showModeSwitcher')).toBe(true)
    wrapper.unmount()
  })

  it('does not register an H1 insert command while keeping long-tail extras', async () => {
    const wrapper = await mountEditor('正文')
    const commands = wrapper.getComponent(MarkdownEditorStub).props('commands') as Array<{ key: string }>
    const keys = commands.map((command) => command.key)

    expect(keys).not.toContain('h1')
    expect(keys).not.toContain('heading-1')
    expect(keys).toEqual(expect.arrayContaining([
      'heading',
      'bold',
      'italic',
      'link',
      'quote',
      'code',
      'heading-3',
      'ul',
      'block'
    ]))
    wrapper.unmount()
  })

  it('preserves existing body H1 source and shows a structure diagnostic', async () => {
    const source = '# 历史标题\n\n## 章节'
    const wrapper = await mountEditor(source)

    expect(wrapper.props('modelValue')).toBe(source)
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    expect(wrapper.get('[role="status"]').text()).toContain('正文含 1 个一级标题（第 1 行）')
    expect(wrapper.get('[role="status"]').text()).toContain('不会被改写')
    wrapper.unmount()
  })

  it('does not diagnose empty or H2-H6-only bodies', async () => {
    const wrapper = await mountEditor('## 章节\n\n### 小节')
    expect(wrapper.find('.markdown-text-editor__heading-diagnostic').exists()).toBe(false)
    wrapper.unmount()
  })
})
