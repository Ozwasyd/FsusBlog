// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { defineComponent, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MarkdownEditorCommandContext } from '@ozwasyd/element-plus'

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
    },
    documentIdentity: Object
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

  it('forwards the canonical document and four shared command surfaces to FsusUI', async () => {
    const extensionCommand = {
      key: 'fixture.extension.command',
      group: 'extension.insert',
      label: '扩展命令',
      run: vi.fn()
    }
    const documentIdentity = { id: 'article-42:tab-a', epoch: 3 }
    const surfaces = {
      toolbar: true,
      selectionToolbar: true,
      slashMenu: true,
      commandPalette: true
    }
    const wrapper = mount(MarkdownTextEditor, {
      props: {
        modelValue: '正文',
        authoringCommands: [extensionCommand],
        documentIdentity,
        commandSurfaces: surfaces
      },
      global: { stubs: { ElMarkdownEditor: MarkdownEditorStub } }
    })
    await nextTick()

    const editor = wrapper.getComponent(MarkdownEditorStub)
    expect(editor.props('documentIdentity')).toEqual(documentIdentity)
    expect(editor.props('surfaces')).toEqual(surfaces)
    expect(editor.props('commands')).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: extensionCommand.key })
    ]))
    expect(editor.props('commandOverflowLabel')).toBe('更多命令')
    wrapper.unmount()
  })

  it('rejects a late extension dispatch after the live selection changes', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const extensionCommand = {
      key: 'fixture.extension.command',
      group: 'extension.insert',
      label: '扩展命令',
      run: async (context: MarkdownEditorCommandContext) => {
        await gate
        context.dispatch.dispatch({
          changes: [{ from: 0, insert: '扩展', to: 0 }],
          history: 'separate',
          origin: 'command'
        })
        return { focus: 'none' as const }
      }
    }
    const dispatch = vi.fn(() => ({
      accepted: true,
      beforeRevision: 5,
      documentIdentity: { id: 'article-42:tab-a', epoch: 3 },
      history: { canRedo: false, canUndo: true, redoDepth: 0, retainedUnits: 1, undoDepth: 1 },
      revision: 6,
      selection: { direction: 'none', end: 2, start: 2 },
      value: '扩展正文'
    }))
    const wrapper = mount(MarkdownTextEditor, {
      props: {
        modelValue: '正文',
        authoringCommands: [extensionCommand],
        documentIdentity: { id: 'article-42:tab-a', epoch: 3 }
      },
      global: { stubs: { ElMarkdownEditor: MarkdownEditorStub } }
    })
    const editor = wrapper.getComponent(MarkdownEditorStub)
    const command = (editor.props('commands') as Array<typeof extensionCommand>)
      .find((candidate) => candidate.key === extensionCommand.key)
    const pending = command!.run({
      dispatch: { dispatch },
      documentIdentity: { id: 'article-42:tab-a', epoch: 3 },
      mode: 'source',
      readonly: false,
      revision: 5,
      selection: { direction: 'none', end: 0, start: 0 },
      signal: new AbortController().signal,
      value: '正文'
    } as never)

    editor.vm.$emit('selection-change', {
      revision: 5,
      selection: { direction: 'forward', end: 2, start: 0 }
    })
    release?.()

    await expect(pending).rejects.toThrow(/binding is stale/u)
    expect(dispatch).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})
