// @vitest-environment happy-dom

import { ElButton } from '@ozwasyd/element-plus'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getComments } from '@/api/comment'
import type { CommentTreeNode, CommentTreeRoot } from '@/contracts/binaryApi'
import PublicArticleCommentsIsland from '@/public-renderers/PublicArticleCommentsIsland.vue'

vi.mock('@/api/comment', () => ({ getComments: vi.fn() }))

const api = vi.mocked(getComments)
const wrappers: ReturnType<typeof mount>[] = []

function node(id: string, rootId = id): CommentTreeNode {
  return {
    id,
    rootId,
    content: `Comment ${id}`,
    createTime: '2026-10-25T00:00:00Z',
    author: { mode: 'public', displayName: `Author ${id}`, displayLanguage: 'en' },
    depth: id === rootId ? 0 : 1,
    isDeleted: false,
    isEdited: false,
    childCount: 0,
    hasMoreChildren: false
  }
}

function root(id: string): CommentTreeRoot {
  return { node: node(id), childrenPreview: [] }
}

function render() {
  const wrapper = mount(PublicArticleCommentsIsland, {
    props: { articleId: 42 },
    global: { components: { ElButton } }
  })
  wrappers.push(wrapper)
  return wrapper
}

beforeEach(() => api.mockReset())
afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount())
})

describe('public comment tree island', () => {
  it('renders the actual tree root and child preview contract', async () => {
    const first = root('9007199254740993')
    first.node.childCount = 1
    first.childrenPreview = [node('9007199254740994', first.node.id)]
    api.mockResolvedValue({ data: [first], nextCursor: null, hasMore: false })

    const wrapper = render()
    await flushPromises()

    expect(api).toHaveBeenCalledWith(42, null, 10)
    expect(wrapper.findAll('article')).toHaveLength(1)
    expect(wrapper.text()).toContain('Comment 9007199254740993')
    expect(wrapper.text()).toContain('Author 9007199254740993')
    expect(wrapper.text()).toContain('Comment 9007199254740994')
    expect(wrapper.text()).toContain('Author 9007199254740994')
    expect(wrapper.find('button').exists()).toBe(false)
  })

  it('reveals retained roots before fetching and appending the next cursor page', async () => {
    const cursor = '9007199254740999'
    api.mockResolvedValueOnce({
      data: ['1', '2', '3', '4', '5', '6'].map(root),
      nextCursor: cursor,
      hasMore: true
    }).mockResolvedValueOnce({ data: [root('7')], nextCursor: null, hasMore: false })

    const wrapper = render()
    await flushPromises()
    expect(wrapper.findAll('article')).toHaveLength(5)
    expect(wrapper.get('button').text()).toBe('显示更多评论（1）')

    await wrapper.get('button').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('article')).toHaveLength(6)
    expect(api).toHaveBeenCalledTimes(1)
    expect(wrapper.get('button').text()).toBe('加载更多')

    await wrapper.get('button').trigger('click')
    await flushPromises()
    expect(api).toHaveBeenLastCalledWith(42, cursor, 10)
    expect(wrapper.findAll('article')).toHaveLength(7)
    expect(wrapper.text()).toContain('Comment 7')
    expect(wrapper.find('button').exists()).toBe(false)
  })
})
