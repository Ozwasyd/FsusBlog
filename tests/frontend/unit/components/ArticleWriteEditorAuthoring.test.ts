// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { defineComponent, nextTick } from 'vue'
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

const ArticleWriteOutlineRailStub = defineComponent({
  name: 'ArticleWriteOutlineRail',
  props: {
    activeHeadingId: String,
    snapshot: Object,
  },
  template: '<div data-outline-rail />',
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
          MarkdownEditorAdapter: MarkdownEditorAdapterStub,
          ArticleWriteOutlineRail: ArticleWriteOutlineRailStub,
        }
      }
    })

    const adapter = wrapper.getComponent(MarkdownEditorAdapterStub)
    expect(adapter.props('authoringCommands')).toEqual(commands)
    expect(adapter.props('commandSurfaces')).toEqual(commandSurfaces)
    expect(adapter.props('documentIdentity')).toEqual(documentIdentity)
    wrapper.unmount()
  })

  it('keeps the replacement article snapshot after an identity epoch change', async () => {
    const wrapper = mount(ArticleWriteEditor, {
      props: {
        modelValue: '# Same source',
        articleIdentity: 'article-a',
        documentIdentity: { id: 'article-a:tab', epoch: 1 },
      },
      global: {
        stubs: {
          MarkdownEditorAdapter: MarkdownEditorAdapterStub,
          ArticleWriteOutlineRail: ArticleWriteOutlineRailStub,
        },
      },
    })

    const before = wrapper.getComponent(ArticleWriteOutlineRailStub).props('snapshot') as {
      articleIdentity: string
      documentIdentity: { id: string, epoch: number }
      items: Array<{ nodeId: string }>
    }

    await wrapper.setProps({
      articleIdentity: 'article-b',
      documentIdentity: { id: 'article-b:tab', epoch: 2 },
    })
    await nextTick()

    const after = wrapper.getComponent(ArticleWriteOutlineRailStub).props('snapshot') as typeof before
    expect(after.articleIdentity).toBe('article-b')
    expect(after.documentIdentity).toEqual({ id: 'article-b:tab', epoch: 2 })
    expect(after.items[0]?.nodeId).not.toBe(before.items[0]?.nodeId)
    wrapper.unmount()
  })

  it('rejects selection events that are not bound to the current document', async () => {
    const wrapper = mount(ArticleWriteEditor, {
      props: {
        modelValue: '# First\n\nBody\n\n# Second\n',
        articleIdentity: 'article-a',
        documentIdentity: { id: 'article-a:tab', epoch: 1 },
      },
      global: {
        stubs: {
          MarkdownEditorAdapter: MarkdownEditorAdapterStub,
          ArticleWriteOutlineRail: ArticleWriteOutlineRailStub,
        },
      },
    })

    const before = wrapper.getComponent(ArticleWriteOutlineRailStub).props('activeHeadingId')
    wrapper.getComponent(MarkdownEditorAdapterStub).vm.$emit('selection-change', {
      revision: 0,
      selection: { start: 0, end: 0, direction: 'none' },
    })
    await nextTick()

    expect(wrapper.getComponent(ArticleWriteOutlineRailStub).props('activeHeadingId')).toBe(before)
    wrapper.unmount()
  })
})
