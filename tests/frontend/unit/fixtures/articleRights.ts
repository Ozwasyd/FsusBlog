import type { ArticleRightsResponse } from '@/api/article'

export const articleRightsFixture: ArticleRightsResponse = {
  snapshotId: '901',
  articleRevisionId: '801',
  revisionNo: 7,
  enabled: true,
  licenseType: 'CC-BY-4.0',
  copyrightHolder: 'Fsus',
  copyrightYear: 2026,
  rightsStatement: 'Reuse with attribution.',
  attributionTemplate: '{title} - {holder}',
  copyPolicy: 'append-attribution',
  maxExcerptChars: 300,
  allowCodeCopy: true,
  showPublicBadge: true,
  proofBindingEnabled: true,
  canonicalUrl: 'https://fsus.example/article/42',
  policyHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  contentCanonicalHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  proofUrl: 'urn:fsus:rights-proof:901',
  proofStatus: 'ready'
}

export function cloneArticleRightsFixture(
  overrides: Partial<ArticleRightsResponse> = {}
): ArticleRightsResponse {
  return {
    ...articleRightsFixture,
    ...overrides
  }
}
