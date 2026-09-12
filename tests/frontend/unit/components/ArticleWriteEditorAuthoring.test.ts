// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { describe, expect, it, vi } from 'vitest'

import ArticleWriteEditor from '@/components/admin/article/ArticleWriteEditor.vue'

const MarkdownEditorAdapterStub = defineComponent({
  name: 'MarkdownEditorAdapter',
  props: {
    authoringCommands: Array,
    commandSurfaces: Object,
    documentIdentity: Object,
    modelValue: String
  },
  template: '<div data-markdown-editor-adapter />'
})

describe('ArticleWriteEditor authoring command plumbing', () => {
  it('keeps the production authoring fixture importable by the direct unit toolchain', async () => {
    const fixture = await import('../../fixtures/articleEditorProductionVisual')

    expect(fixture.mountArticleEditorProductionFixture).toBeTypeOf('function')
  })

  it('forwards one registry, document identity, and four surfaces without adding handlers', () => {
    const commands = [{
      key: 'fixture.author-tools.insert-callout',
      group: 'extension.insert',
      label: '插入提示块',
      run: vi.fn()
    }]
    const commandSurfaces = {
      toolbar: true,
      selectionToolbar: true,
      slashMenu: true,
      commandPalette: true
    }
    const documentIdentity = { id: 'article-42:tab-a', epoch: 4 }
    const wrapper = mount(ArticleWriteEditor, {
      props: {
        modelValue: '正文',
        authoringCommands: commands,
        commandSurfaces,
        documentIdentity
      },
      global: {
        stubs: {
          MarkdownEditorAdapter: MarkdownEditorAdapterStub
        }
      }
    })

    const adapter = wrapper.getComponent(MarkdownEditorAdapterStub)
    expect(adapter.props('authoringCommands')).toEqual(commands)
    expect(adapter.props('commandSurfaces')).toEqual(commandSurfaces)
    expect(adapter.props('documentIdentity')).toEqual(documentIdentity)
    wrapper.unmount()
  })
})
