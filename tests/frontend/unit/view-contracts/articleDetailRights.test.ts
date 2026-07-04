import { describe, expect, expectTypeOf, it } from 'vitest'
import type { ArticleDetailResponse } from '@/api/article'
import {
  createArticleDetailPageViewContract,
  emptyArticleDetailPageView
} from '@/view-contracts/articleDetail'
import { articleRightsFixture } from '../fixtures/articleRights'

const article: ArticleDetailResponse = {
  id: 42,
  title: 'Rights article',
  content: 'Body',
  summary: 'Summary',
  coverImageUrl: '/cover.webp',
  views: 7,
  createTime: '2026-01-02T03:04:05.000Z',
  category: {
    id: 2,
    name: 'Rights'
  },
  tags: [],
  rights: articleRightsFixture
}

describe('article detail rights view contract', () => {
  it('requires ArticleDetailResponse.rights at the TypeScript contract boundary', () => {
    type MissingRightsArticle = Omit<ArticleDetailResponse, 'rights'>

    expectTypeOf<MissingRightsArticle>().not.toMatchTypeOf<ArticleDetailResponse>()
  })

  it('maps ArticleDetail rights into the page view contract', () => {
    const view = createArticleDetailPageViewContract(article, 0, false)

    expect(view.rights).toEqual(articleRightsFixture)
  })

  it('provides explicit disabled rights for the empty detail view', () => {
    expect(emptyArticleDetailPageView.rights).toMatchObject({
      snapshotId: '0',
      articleRevisionId: '0',
      revisionNo: 0,
      enabled: false,
      licenseType: 'all-rights-reserved',
      copyPolicy: 'disabled',
      maxExcerptChars: 0,
      allowCodeCopy: false,
      showPublicBadge: false,
      proofBindingEnabled: false
    })
  })
})
