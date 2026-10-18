// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { defineComponent, nextTick } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import PublicArticleDetailPageContent from '@/components/public/pages/PublicArticleDetailPageContent.vue'
import {
  emptyArticleRightsView,
  emptyArticleDetailPageView,
  type ArticleDetailPageViewContract
} from '@/view-contracts/articleDetail'

const detailView = (coverImageUrl?: string): ArticleDetailPageViewContract => ({
  ...emptyArticleDetailPageView,
  header: {
    ...emptyArticleDetailPageView.header,
    id: 42,
    title: 'Frame inspection',
    ...(coverImageUrl === undefined ? {} : { coverImageUrl }),
    meta: {
      ...emptyArticleDetailPageView.header.meta,
      isoTime: '2026-07-11T00:00:00.000Z',
      displayTime: '2026-07-11',
      fullTime: '2026-07-11 00:00:00',
      categoryName: 'Engineering'
    }
  },
  body: {
    content: 'Body',
    notice: { visible: false, wordCount: 4, readingMinutes: 1 }
  }
})

const ArticleDetailHeaderStub = defineComponent({
  name: 'ArticleDetailHeader',
  template: '<div data-test="article-header">complete header</div>'
})

const global = {
  stubs: {
    ArticleDetailHeader: ArticleDetailHeaderStub,
    ArticleResponsibilityDisclosure: true,
    ArticleDetailBody: { template: '<div><slot /></div>' },
    ArticleDetailCommentsPlaceholder: true,
    ArticleReadingNotice: true,
    MarkdownRenderer: true
  }
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('public article cover', () => {
  it('renders tags, rights, and related reading as a restrained appendix', () => {
    const view = detailView()
    const wrapper = mount(PublicArticleDetailPageContent, {
      props: {
        detailView: {
          ...view,
          header: {
            ...view.header,
            tags: [
              { label: '#DEMO', href: '/tag/1' },
              { label: '#AEDS', href: '/tag/2' }
            ]
          },
          rights: {
            ...emptyArticleRightsView,
            snapshotId: 'rights-42',
            enabled: true,
            showPublicBadge: true,
            licenseType: 'all-rights-reserved',
            copyrightHolder: "Fsu's Blog",
            copyrightYear: 2026,
            rightsStatement: '本文保留所有权利，引用或转载请遵循页面标注的复制策略。',
            attributionTemplate: '{title} — {holder} {url}',
            copyPolicy: 'append-attribution',
            maxExcerptChars: 300,
            allowCodeCopy: true,
            contentCanonicalHash: 'rights-v3:content-hash:recompute'
          },
          relatedReading: {
            ...view.relatedReading,
            previous: {
              id: 1,
              title: 'Public Preview Walkthrough',
              summary: '',
              reason: 'previous',
              href: '/article/1',
              displayTime: '06-01 18:00'
            },
            next: {
              id: 2,
              title: 'Acceptance Hot Read Note',
              summary: '',
              reason: 'next',
              href: '/article/2',
              displayTime: '2 hours ago'
            },
            items: [{
              id: 3,
              title: 'Public Preview Walkthrough',
              summary: '',
              reason: 'related',
              href: '/article/3',
              displayTime: '06-01 18:00'
            }]
          }
        },
        articleId: 42,
        authorName: 'Fixture Author',
        articleSummary: 'Summary',
        hasBodyContent: true
      },
      global
    })

    const appendix = wrapper.get('.fsus-appendix')
    expect(appendix.findAll('.fsus-appendix__tag').map((item) => item.text())).toEqual(['#demo', '#aeds'])
    expect(appendix.get('.fsus-appendix__copyright').text()).toBe(
      "© 2026 Fsu's Blog. 保留所有权利。允许代码块复制及最多 300 字符摘录，需追加署名 (rights-v3)。"
    )
    expect(appendix.get('.fsus-appendix__nav-label').text()).toBe('相关阅读')
    expect(appendix.findAll('.fsus-appendix__meta').map((item) => item.text())).toEqual([
      '上一篇 · 06-01 18:00',
      '下一篇 · 2 hours ago',
      '相关阅读 · 06-01 18:00'
    ])
    expect(appendix.findAll('.fsus-appendix__link').map((item) => item.text())).toEqual([
      'Public Preview Walkthrough',
      'Acceptance Hot Read Note',
      'Public Preview Walkthrough'
    ])
    expect(appendix.find('.fsus-colophon').exists()).toBe(false)

    wrapper.unmount()
  })

  it('uses the shared crop-safe evidence container when a cover exists', () => {
    const wrapper = mount(PublicArticleDetailPageContent, {
      props: {
        detailView: detailView('  /fixtures/demo-aeds-frame-inspection.svg  '),
        articleId: 42,
        authorName: 'Fixture Author',
        articleSummary: 'Summary',
        hasBodyContent: true
      },
      global
    })

    const cover = wrapper.get('[data-content-cover="article-detail"]')
    const image = cover.get('img')
    expect(cover.attributes('data-cover-safe-area')).toBe('center-80')
    expect(cover.classes()).toContain('border')
    expect(cover.classes()).toContain('shadow-none')
    expect(image.attributes('src')).toBe('/fixtures/demo-aeds-frame-inspection.svg')
    expect(image.attributes('style')).toBeUndefined()
    expect(image.classes()).toContain('object-cover')
    expect(image.classes()).toContain('object-center')
    expect(wrapper.get('[data-test="article-header"]').text()).toBe('complete header')
    wrapper.unmount()
  })

  it('removes the media DOM for a blank cover while retaining the article hierarchy', async () => {
    const wrapper = mount(PublicArticleDetailPageContent, {
      props: {
        detailView: detailView('   '),
        articleId: 42,
        authorName: 'Fixture Author',
        articleSummary: 'Summary',
        hasBodyContent: true
      },
      global
    })

    expect(wrapper.find('[data-content-cover]').exists()).toBe(false)
    expect(wrapper.get('[data-test="article-header"]').text()).toBe('complete header')

    await wrapper.setProps({ detailView: detailView(undefined) })
    await nextTick()
    expect(wrapper.find('[data-content-cover]').exists()).toBe(false)
    expect(wrapper.find('[data-test="article-header"]').exists()).toBe(true)
    wrapper.unmount()
  })
})
