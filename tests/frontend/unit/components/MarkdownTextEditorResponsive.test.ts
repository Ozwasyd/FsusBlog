// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { defineComponent, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'

import MarkdownTextEditor from '@/components/ui/MarkdownTextEditor.vue'

const MarkdownEditorStub = defineComponent({
  name: 'ElMarkdownEditor',
  props: {
    commands: {
      type: Array,
      default: () => []
    },
    commandOverflowLabel: String,
    documentIdentity: Object,
    primaryCommandKeys: {
      type: Array,
      default: () => []
    },
    surfaces: Object
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
      run: async (context: { dispatch: { dispatch: (transaction: unknown) => unknown } }) => {
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
