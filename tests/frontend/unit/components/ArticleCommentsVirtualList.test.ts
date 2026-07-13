// @vitest-environment happy-dom

import { defineComponent } from 'vue'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import ArticleCommentsVirtualList from '@/components/article/ArticleCommentsVirtualList.vue'
import type { CommentThreadItem } from '@/api/comment'

const CommentMarkdownRendererStub = defineComponent({
  inheritAttrs: false,
  props: {
    content: { type: String, required: true }
  },
  template: '<div class="fsus-markdown-body" v-bind="$attrs"><p>{{ content }}</p></div>'
})

const baseThread: CommentThreadItem = {
  id: 'thread-1',
  content: 'A restrained comment.',
  createTime: '2026-06-01T03:00:00.000Z',
  author: {
    mode: 'public',
    displayName: 'Demo Reader',
    displayLanguage: 'en'
  },
  authorAccountId: 7,
  rootId: 'thread-1',
  isDeleted: false,
  replyCount: 0,
  hasMoreReplies: false,
  repliesPreview: []
}

const mountList = (thread: CommentThreadItem, isLoggedIn: boolean) => mount(ArticleCommentsVirtualList, {
  props: {
    threads: [thread],
    isAdmin: false,
    isLoggedIn,
    currentAccountId: null,
    loadingReplies: {}
  },
  global: {
    stubs: {
      CommentMarkdownRenderer: CommentMarkdownRendererStub
    }
  }
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('ArticleCommentsVirtualList editorial comment items', () => {
  it('renders authenticated authors without an identity badge', () => {
    const wrapper = mountList(baseThread, true)

    expect(wrapper.get('.fsus-comment').classes()).toContain('fsus-comment')
    expect(wrapper.get('.fsus-comment__author').classes()).toContain('is-authenticated')
    expect(wrapper.find('.fsus-comment__badge').exists()).toBe(false)
    expect(wrapper.get('.fsus-comment__footer .fsus-comment__action').text()).toBe('回复')

    wrapper.unmount()
  })

  it('demotes anonymous authors with a plain anonymous badge and login action', () => {
    const anonymousThread: CommentThreadItem = {
      ...baseThread,
      author: {
        ...baseThread.author,
        mode: 'anonymous',
        displayName: 'Anonymous'
      }
    }
    const wrapper = mountList(anonymousThread, false)

    expect(wrapper.get('.fsus-comment__author').classes()).toContain('is-anonymous')
    expect(wrapper.get('.fsus-comment__badge').text()).toBe('匿名')
    expect(wrapper.get('.fsus-comment__footer .fsus-comment__action').text()).toBe('登录后回复')

    wrapper.unmount()
  })
})
