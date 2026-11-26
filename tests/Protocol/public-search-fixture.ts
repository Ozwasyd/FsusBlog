import {
  PublicSearchMatchTier, PublicSearchSnippetField, PublicSearchTotalRelation, WireLimits,
  type PublicSearchHit, type PublicSearchResult,
} from '../../src/Contracts/wire.generated.ts';

export function oneHitSearchResult(
  hit: Pick<PublicSearchHit, 'id' | 'title' | 'publishedAtUnixMs'> & Partial<PublicSearchHit>,
  page: Pick<PublicSearchResult, 'generation'> & Partial<Omit<PublicSearchResult, 'items'>>,
): PublicSearchResult {
  return {
    profileVersion: WireLimits.SearchFas4Profile,
    analyzerVersion: WireLimits.SearchAnalyzerVersion,
    totalCount: 1,
    totalRelation: PublicSearchTotalRelation.Exact,
    primaryCount: 1,
    relaxedCount: 0,
    hasMore: false,
    nextCursor: '',
    ...page,
    items: [{
      revision: 1n,
      revisionNo: 1,
      publication: 1n,
      publicationNo: 1,
      createdAtUnixMs: hit.publishedAtUnixMs,
      views: 0,
      categoryId: 0,
      categoryName: '',
      tags: [],
      summary: 'Summary',
      matchTier: PublicSearchMatchTier.Primary,
      snippetField: PublicSearchSnippetField.Title,
      snippet: hit.title,
      highlights: [],
      ...hit,
    }],
  };
}
