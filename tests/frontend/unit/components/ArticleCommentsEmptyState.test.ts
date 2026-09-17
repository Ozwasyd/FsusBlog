// @vitest-environment happy-dom

import { defineComponent } from 'vue'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import ArticleCommentsEmptyState from '@/components/public/ArticleCommentsEmptyState.vue'

const RouterLinkStub = defineComponent({
  inheritAttrs: false,
  props: {
    to: { type: [String, Object], required: true }
  },
  template: '<a v-bind="$attrs" :data-to="JSON.stringify(to)"><slot /></a>'
})

const mountState = (isLoggedIn = false, message = '暂无评论。') => mount(ArticleCommentsEmptyState, {
  props: {
    isLoggedIn,
    redirectPath: '/article/910002#comments',
    message
  },
  global: {
    stubs: { RouterLink: RouterLinkStub }
  }
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('ArticleCommentsEmptyState', () => {
  it('combines the empty message with the guest login action', () => {
    const wrapper = mountState()

    expect(wrapper.get('.fsus-comments-empty__text').text()).toBe('暂无评论。')
    expect(wrapper.get('.fsus-comments-empty__btn').text()).toBe('登录以参与讨论')
    expect(wrapper.get('.fsus-comments-empty__btn').attributes('data-to')).toContain('/login')

    wrapper.unmount()
  })

  it('keeps the empty message without a redundant login action for signed-in readers', () => {
    const wrapper = mountState(true)

    expect(wrapper.get('.fsus-comments-empty__text').text()).toBe('暂无评论。')
    expect(wrapper.find('.fsus-comments-empty__btn').exists()).toBe(false)

    wrapper.unmount()
  })

  it('renders the end-of-list message while keeping the guest action', () => {
    const wrapper = mountState(false, '上面的评论已为最后一条。')

    expect(wrapper.get('.fsus-comments-empty__text').text()).toBe('上面的评论已为最后一条。')
    expect(wrapper.get('.fsus-comments-empty__btn').text()).toBe('登录以参与讨论')

    wrapper.unmount()
  })
})
