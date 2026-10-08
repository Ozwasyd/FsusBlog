// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { defineComponent, nextTick } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'

import ArticleWriteEditor from '@/components/admin/article/ArticleWriteEditor.vue'
import type { ArticleOutlineSnapshot } from '@/composables/useArticleOutline'

const AdapterStub = defineComponent({
  name: 'MarkdownEditorAdapter',
  emits: ['selection-change'],
  template: '<div data-selection-event-adapter />',
})

const OutlineStub = defineComponent({
  name: 'ArticleWriteOutlineRail',
  props: ['snapshot', 'activeHeadingId'],
  template: '<div data-selection-event-outline />',
})

const documentIdentity = { id: 'document:N', epoch: 7 }
const source = '# First\n\nFirst body\n\n# Last\n\nLast body\n'
const selection = (position: number) => ({ start: position, end: position, direction: 'none' })

const mountEditor = () => mount(ArticleWriteEditor, {
  props: { articleIdentity: 'article-a', documentIdentity, modelValue: source },
  global: { stubs: { MarkdownEditorAdapter: AdapterStub, ArticleWriteOutlineRail: OutlineStub } },
})

const wrappers: ReturnType<typeof mountEditor>[] = []
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
})

describe('article outline identity-bound selection consumption', () => {
  it.each([
    ['missing identity', { revision: 5, selection: selection(source.length) }],
    ['other opaque document', { documentIdentity: { id: 'document:N:other', epoch: 7 }, revision: 5, selection: selection(source.length) }],
    ['old epoch', { documentIdentity: { id: 'document:N', epoch: 6 }, revision: 5, selection: selection(source.length) }],
    ['old revision', { documentIdentity, revision: 3, selection: selection(source.length) }],
  ])('rejects %s after accepting a current event', async (_name, rejectedEvent) => {
    const wrapper = mountEditor()
    wrappers.push(wrapper)
    const adapter = wrapper.getComponent(AdapterStub)
    const rail = wrapper.getComponent(OutlineStub)
    const snapshot = rail.props('snapshot') as ArticleOutlineSnapshot
    expect(snapshot.items).toHaveLength(2)
    const [first, last] = snapshot.items
    expect(rail.props('activeHeadingId')).toBe(last!.nodeId)

    adapter.vm.$emit('selection-change', {
      documentIdentity,
      revision: 4,
      selection: selection(0),
    })
    await nextTick()
    expect(rail.props('activeHeadingId')).toBe(first!.nodeId)
    expect((rail.props('snapshot') as ArticleOutlineSnapshot).sourceRevision).toBe(4)

    adapter.vm.$emit('selection-change', rejectedEvent)
    await nextTick()
    expect(rail.props('activeHeadingId')).toBe(first!.nodeId)
    expect((rail.props('snapshot') as ArticleOutlineSnapshot).sourceRevision).toBe(4)

    adapter.vm.$emit('selection-change', {
      documentIdentity,
      revision: 4,
      selection: selection(source.length),
    })
    await nextTick()
    expect(rail.props('activeHeadingId')).toBe(last!.nodeId)
  })

  it.each([
    ['same document, new epoch', { id: 'document:N', epoch: 8 }],
    ['same source, different document', { id: 'document:Other', epoch: 7 }],
  ])('rejects late observations after %s rebind', async (_name, nextIdentity) => {
    const wrapper = mountEditor()
    wrappers.push(wrapper)
    const adapter = wrapper.getComponent(AdapterStub)
    const rail = wrapper.getComponent(OutlineStub)
    const before = rail.props('snapshot') as ArticleOutlineSnapshot
    const queuedEvent = { documentIdentity, revision: 0, selection: selection(0) }

    await wrapper.setProps({ documentIdentity: nextIdentity })
    const current = rail.props('snapshot') as ArticleOutlineSnapshot
    expect(current.documentIdentity).toEqual(nextIdentity)
    expect(current.items).toHaveLength(2)
    expect(current.items[0]!.nodeId).not.toBe(before.items[0]!.nodeId)
    expect(rail.props('activeHeadingId')).toBe(current.items[1]!.nodeId)

    adapter.vm.$emit('selection-change', queuedEvent)
    await nextTick()
    expect(rail.props('activeHeadingId')).toBe(current.items[1]!.nodeId)
    expect((rail.props('snapshot') as ArticleOutlineSnapshot).documentIdentity).toEqual(nextIdentity)

    adapter.vm.$emit('selection-change', {
      documentIdentity: nextIdentity,
      revision: 0,
      selection: selection(0),
    })
    await nextTick()
    expect(rail.props('activeHeadingId')).toBe(current.items[0]!.nodeId)
  })
})
