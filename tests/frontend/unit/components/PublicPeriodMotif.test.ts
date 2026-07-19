// @vitest-environment happy-dom

import { mount, shallowMount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import ArticleDetailHeader from '@/components/article/ArticleDetailHeader.vue'
import ArticleDetailCommentsPlaceholder from '@/components/public/ArticleDetailCommentsPlaceholder.vue'
import HomeArticleLoadingState from '@/components/home/HomeArticleLoadingState.vue'
import PublicArticleList from '@/components/public/PublicArticleList.vue'
import PublicContentState from '@/components/public/PublicContentState.vue'

afterEach(() => {
  document.body.replaceChildren()
})

describe('public punctuation motif', () => {
  it('uses midpoints for inline list and article metadata', () => {
    const list = mount(PublicArticleList, {
      props: {
        items: [{
          card: { kind: 'article-list-card', index: 0 },
          id: 1,
          href: '/article/1',
          title: '标点服务信息结构',
          summary: '列表元信息保持清晰的并列关系。',
          meta: {
            isoTime: '2026-07-19T00:00:00.000Z',
            displayTime: '2026-07-19',
            fullTime: '2026-07-19 08:00:00',
            categoryName: '设计',
            categoryHref: '/category/1'
          },
          tags: [{ label: '#排版', href: '/tag/1' }]
        }],
        pagination: {
          previous: { label: '上一页', disabled: true },
          next: { label: '下一页', disabled: true },
          indicator: '1 / 1'
        },
        showPagination: false,
        showReadCta: false
      },
      global: {
        stubs: { ElIcon: true }
      }
    })
    const detail = mount(ArticleDetailHeader, {
      props: {
        linkMode: 'anchor',
        view: {
          id: 1,
          title: '标点服务信息结构',
          viewsText: '18 浏览',
          meta: {
            isoTime: '2026-07-19T00:00:00.000Z',
            displayTime: '2026-07-19',
            fullTime: '2026-07-19 08:00:00',
            published: {
              isoTime: '2026-07-19T00:00:00.000Z',
              displayTime: '2026-07-19',
              fullTime: '2026-07-19 08:00:00'
            },
            modified: {
              isoTime: '2026-07-19T01:00:00.000Z',
              displayTime: '2026-07-19',
              fullTime: '2026-07-19 09:00:00'
            },
            categoryName: '设计',
            categoryHref: '/category/1'
          },
          tags: []
        }
      }
    })

    expect(list.findAll('[aria-hidden="true"]').map((node) => node.text())).toEqual(['·', '·'])
    expect(detail.findAll('[aria-hidden="true"]').map((node) => node.text())).toEqual(['·', '·', '·'])

    list.unmount()
    detail.unmount()
  })

  it('renders one shared dot for each loading surface', () => {
    const comments = mount(ArticleDetailCommentsPlaceholder, {
      props: { text: '评论加载中' }
    })
    const home = shallowMount(HomeArticleLoadingState, {
      global: {
        stubs: {
          ElSkeleton: true,
          ElSkeletonItem: true
        }
      }
    })

    expect(comments.findAll('.fsusblog-dot-loader')).toHaveLength(1)
    expect(comments.get('[role="status"]').text()).toBe('评论加载中')
    expect(home.findAll('.fsusblog-dot-loader')).toHaveLength(1)

    comments.unmount()
    home.unmount()
  })

  it('adds the dot to neutral empty states without decorating errors', async () => {
    const wrapper = mount(PublicContentState, {
      props: {
        title: '暂时还没有文章',
        description: '发布后的内容会显示在这里。',
        role: 'status'
      }
    })

    expect(wrapper.findAll('.fsusblog-dot-loader')).toHaveLength(1)
    expect(wrapper.get('.public-content-state__title-row').text()).toBe('暂时还没有文章')

    await wrapper.setProps({ tone: 'error', role: 'alert' })
    expect(wrapper.find('.fsusblog-dot-loader').exists()).toBe(false)
    expect(wrapper.attributes('role')).toBe('alert')

    wrapper.unmount()
  })
})
