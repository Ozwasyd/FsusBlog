// @vitest-environment happy-dom

import { mount, shallowMount } from '@vue/test-utils'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { createSSRApp } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import ArticleDetailHeader from '@/components/article/ArticleDetailHeader.vue'
import ArticleDetailCommentsPlaceholder from '@/components/public/ArticleDetailCommentsPlaceholder.vue'
import HomeArticleLoadingState from '@/components/home/HomeArticleLoadingState.vue'
import PublicArticleList from '@/components/public/PublicArticleList.vue'
import PublicContentState from '@/components/public/PublicContentState.vue'

const frontendRequire = createRequire(resolve(process.cwd(), 'package.json'))
const { renderToString } = frontendRequire('@vue/server-renderer') as typeof import('@vue/server-renderer')

afterEach(() => {
  document.body.replaceChildren()
})

const listItem = {
  card: { kind: 'article-list-card' as const, index: 0 },
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
}

describe('public content semantics', () => {
  it('keeps list and article metadata content available to users', () => {
    const list = mount(PublicArticleList, {
      props: {
        items: [listItem],
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
          title: listItem.title,
          viewsText: '18 浏览',
          meta: {
            ...listItem.meta,
            published: {
              isoTime: listItem.meta.isoTime,
              displayTime: listItem.meta.displayTime,
              fullTime: listItem.meta.fullTime
            },
            modified: {
              isoTime: '2026-07-19T01:00:00.000Z',
              displayTime: '2026-07-19',
              fullTime: '2026-07-19 09:00:00'
            }
          },
          tags: []
        }
      }
    })

    expect(list.get('h2').text()).toBe(listItem.title)
    expect(list.get('p').text()).toBe(listItem.summary)
    expect(list.get('time').attributes()).toMatchObject({
      datetime: listItem.meta.isoTime,
      title: listItem.meta.fullTime
    })
    expect(list.get('a[data-public-link="category"]').text()).toBe(listItem.meta.categoryName)
    expect(list.get('a[data-public-link="tag"]').text()).toBe(listItem.tags[0].label)
    expect(detail.get('h1').text()).toBe(listItem.title)
    expect(detail.get('[itemprop="articleSection"]').text()).toBe(listItem.meta.categoryName)
    expect(detail.text()).toContain('18 浏览')
    expect(detail.get('[itemprop="datePublished"]').attributes()).toMatchObject({
      datetime: listItem.meta.isoTime,
      title: listItem.meta.fullTime
    })
    expect(detail.get('[itemprop="datePublished"]').text()).toBe(listItem.meta.displayTime)
    expect(detail.get('[itemprop="dateModified"]').attributes()).toMatchObject({
      datetime: '2026-07-19T01:00:00.000Z',
      title: '2026-07-19 09:00:00'
    })
    expect(detail.get('[itemprop="dateModified"]').text()).toBe('2026-07-19')
    expect(detail.findAll('[data-article-metadata-group]')).toHaveLength(2)
    expect(detail.get('[data-article-metadata-group="dates"]').text()).toContain('2026')
    expect(detail.get('[data-article-metadata-group="context"]').text()).toContain('18 浏览')
    expect(
      detail
        .findAll('[data-article-metadata-group] [aria-hidden="true"]')
        .every((separator) =>
          separator.element.closest('.article-detail-metadata__unit--fixed')
        )
    ).toBe(true)
    expect(detail.get('[itemprop="articleSection"]').classes()).toEqual(
      expect.arrayContaining(['min-h-11', 'min-w-11', 'normal-case'])
    )
    expect(detail.get('[data-article-metadata]').classes()).toEqual(
      expect.arrayContaining(['gap-x-4', 'gap-y-2', 'normal-case'])
    )

    list.unmount()
    detail.unmount()
  })

  it('exposes loading states through stable status names', () => {
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

    expect(comments.get('[role="status"]').text()).toBe('评论加载中')
    expect(comments.get('[role="status"]').attributes('aria-live')).toBe('polite')
    expect(home.get('[role="status"]').attributes()).toMatchObject({
      'aria-label': '正在加载文章列表',
      'aria-live': 'polite'
    })

    comments.unmount()
    home.unmount()
  })

  it('switches empty and error announcements without losing content', async () => {
    const wrapper = mount(PublicContentState, {
      props: {
        title: '暂时还没有文章',
        description: '发布后的内容会显示在这里。',
        role: 'status',
        ariaLive: 'polite'
      }
    })

    expect(wrapper.get('[role="status"]').text()).toContain('暂时还没有文章')
    expect(wrapper.text()).toContain('发布后的内容会显示在这里。')

    await wrapper.setProps({
      title: '文章加载失败',
      description: '请稍后重试。',
      tone: 'error',
      role: 'alert',
      ariaLive: 'assertive'
    })
    expect(wrapper.get('[role="alert"]').attributes('aria-live')).toBe('assertive')
    expect(wrapper.text()).toContain('文章加载失败')
    expect(wrapper.text()).toContain('请稍后重试。')

    wrapper.unmount()
  })

  it('preserves content and status semantics through SSR, hydration and SPA rendering', async () => {
    const props = {
      title: '暂时没有匹配内容',
      description: '调整筛选条件后重试。',
      role: 'status' as const,
      ariaLive: 'polite' as const
    }
    const serverHtml = await renderToString(createSSRApp(PublicContentState, props))
    const hydrationHost = document.createElement('div')
    hydrationHost.innerHTML = serverHtml
    document.body.append(hydrationHost)
    const hydrationApp = createSSRApp(PublicContentState, props)
    hydrationApp.mount(hydrationHost)
    const spa = mount(PublicContentState, { props })

    const hydratedStatus = hydrationHost.querySelector('[role="status"]')
    expect(hydratedStatus?.textContent).toContain(props.title)
    expect(hydratedStatus?.textContent).toContain(props.description)
    expect(hydratedStatus?.getAttribute('aria-live')).toBe('polite')
    expect(spa.get('[role="status"]').text()).toContain(props.title)
    expect(spa.get('[role="status"]').text()).toContain(props.description)

    hydrationApp.unmount()
    spa.unmount()
  })
})
