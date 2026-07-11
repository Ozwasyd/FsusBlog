import { mount } from '@vue/test-utils'
import { defineComponent, nextTick } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import PublicArticleDetailPageContent from '@/components/public/pages/PublicArticleDetailPageContent.vue'
import {
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
    ArticleDetailTagsFooter: true,
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
    expect(image.attributes('style')).toContain('object-position: 50% 50%')
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
    expect(wrapper.get('[data-test="article-header"]').exists()).toBe(true)
    wrapper.unmount()
  })
})
