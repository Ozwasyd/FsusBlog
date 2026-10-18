// @vitest-environment happy-dom

import { defineComponent } from 'vue'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import ArticleCommentsVirtualList from '@/components/article/ArticleCommentsVirtualList.vue'
import type { CommentTreeViewNode } from '@/composables/useArticleCommentStream'

const CommentMarkdownRendererStub = defineComponent({
  inheritAttrs: false,
  props: { content: { type: String, required: true } },
  template: '<div class="fsus-markdown-body" v-bind="$attrs"><p>{{ content }}</p></div>'
})

const makeNode = (
  id: string,
  depth = 0,
  children: CommentTreeViewNode[] = [],
  overrides: Partial<CommentTreeViewNode> = {}
): CommentTreeViewNode => ({
  id,
  content: `Comment ${id}`,
  createTime: '2026-06-01T03:00:00.000Z',
  author: { mode: 'public', displayName: 'Demo Reader', displayLanguage: 'en', badge: null, scopeLabel: null },
  replyToAuthor: null,
  parentId: depth === 0 ? null : String(BigInt(id) - 1n),
  rootId: depth === 0 ? id : '1',
  replyToCommentId: depth === 0 ? null : String(BigInt(id) - 1n),
  depth,
  isDeleted: false,
  isEdited: false,
  childCount: children.length,
  hasMoreChildren: false,
  children,
  childrenExpanded: children.length > 0,
  ...overrides
})

const mountList = (
  thread: CommentTreeViewNode,
  isLoggedIn: boolean,
  ownedCommentIds: ReadonlySet<string> = new Set(),
  isAdmin = false
) => mount(ArticleCommentsVirtualList, {
  props: { threads: [thread], isAdmin, isLoggedIn, ownedCommentIds, loadingReplies: {} },
  global: { stubs: { CommentMarkdownRenderer: CommentMarkdownRendererStub } }
})

afterEach(() => { document.body.innerHTML = '' })

describe('ArticleCommentsVirtualList recursive comment tree', () => {
  it('renders the POD-derived edited marker without changing unedited comments', () => {
    const edited = makeNode('1', 0, [], { isEdited: true })
    const wrapper = mountList(edited, false)

    expect(wrapper.get('.fsus-comment-tree-node__edited').text()).toBe('已编辑')
    expect(wrapper.get('.fsus-comment-tree-node__edited').attributes('aria-label')).toBe('此评论已编辑')
    wrapper.unmount()

    const uneditedWrapper = mountList(makeNode('2'), false)
    expect(uneditedWrapper.find('.fsus-comment-tree-node__edited').exists()).toBe(false)
    uneditedWrapper.unmount()
  })

  it('renders public and anonymous identity states without account identifiers', () => {
    const publicWrapper = mountList(makeNode('1'), true)
    expect(publicWrapper.get('.fsus-comment-tree-node__author').classes()).toContain('is-authenticated')
    expect(publicWrapper.find('.fsus-comment-tree-node__badge').exists()).toBe(false)
    expect(publicWrapper.get('.fsus-comment-tree-node__action').text()).toBe('回复')
    publicWrapper.unmount()

    const anonymous = makeNode('1', 0, [], {
      author: { mode: 'zk_anonymous', displayName: 'Anonymous', displayLanguage: 'en', badge: null, scopeLabel: null }
    })
    const anonymousWrapper = mountList(anonymous, false)
    expect(anonymousWrapper.get('.fsus-comment-tree-node__author').classes()).toContain('is-anonymous')
    expect(anonymousWrapper.get('.fsus-comment-tree-node__badge').text()).toBe('匿名')
    expect(anonymousWrapper.get('.fsus-comment-tree-node__action').text()).toBe('登录后回复')
    anonymousWrapper.unmount()
  })

  it('keeps recursive groups, reply identity, permalink, and delete semantics accessible', () => {
    const child = makeNode('2', 1, [], {
      author: { mode: 'zk_anonymous', displayName: 'Anonymous', displayLanguage: 'en', badge: null, scopeLabel: null },
      replyToAuthor: { mode: 'public', displayName: 'Demo Reader', displayLanguage: 'en', badge: null, scopeLabel: null }
    })
    const wrapper = mountList(makeNode('1', 0, [child]), true, new Set(), true)

    expect(wrapper.get('[role="group"]').attributes('aria-label')).toContain('Demo Reader')
    expect(wrapper.get('#comment-2 .fsus-comment-tree-node__target').text()).toContain('@Demo Reader')
    expect(wrapper.get('#comment-2 .fsus-comment-tree-node__time').attributes('href')).toBe('#comment-2')
    expect(wrapper.get('#comment-2 .is-danger').attributes('aria-label')).toBe('删除回复')
    expect(wrapper.get('[aria-controls="comment-children-1"]').attributes('aria-expanded')).toBe('true')
    wrapper.unmount()
  })

  it('renders a path deeper than ten levels and compresses deep visual guides', () => {
    let branch = makeNode('12', 11)
    for (let depth = 10; depth >= 0; depth--) {
      branch = makeNode(String(depth + 1), depth, [branch])
    }
    const wrapper = mountList(branch, true)

    expect(wrapper.findAll('.fsus-comment-tree-node')).toHaveLength(12)
    expect(wrapper.findAll('.fsus-comment-tree-node.is-deep')).toHaveLength(8)
    expect(wrapper.get('#comment-12').classes()).toContain('fsus-comment-tree-node--depth-4')
    expect(wrapper.get('#comment-12').attributes('style')).toBeUndefined()
    wrapper.unmount()
  })

  it('lazy-expands a branch with ArrowRight and preserves private ownership actions', async () => {
    const root = makeNode('1', 0, [], { childCount: 2, hasMoreChildren: true })
    const wrapper = mountList(root, true, new Set(['1']))
    const node = wrapper.get('#comment-1')

    await node.trigger('keydown', { key: 'ArrowRight' })
    expect(wrapper.emitted('loadMoreReplies')?.[0]).toEqual(['1'])
    expect(wrapper.get('[aria-controls="comment-children-1"]').attributes('aria-expanded')).toBe('true')
    expect(wrapper.get('.is-danger').attributes('aria-label')).toBe('删除评论')
    wrapper.unmount()
  })
})
