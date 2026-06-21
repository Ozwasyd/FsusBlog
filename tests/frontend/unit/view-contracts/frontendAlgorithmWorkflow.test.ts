import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoFile = (path: string): string => fileURLToPath(new URL(`../../../../${path}`, import.meta.url))
const readRepoFile = (path: string): string => readFileSync(repoFile(path), 'utf8')

describe('frontend algorithm workflow contract', () => {
  const contentFilter = readRepoFile('src/frontend/src/utils/contentFilter.ts')
  const localSearch = readRepoFile('src/frontend/src/services/localSearch.ts')
  const searchRanking = readRepoFile('src/frontend/src/services/searchRanking.ts')
  const notificationStreamRenderScheduler = readRepoFile('src/frontend/src/services/notificationStreamRenderScheduler.ts')
  const articleListStableCache = readRepoFile('src/frontend/src/view-contracts/articleListStableCache.ts')
  const anonymousOnboarding = readRepoFile('src/frontend/src/composables/useAnonymousOnboarding.ts')

  it('keeps content moderation on normalization, AC matching, and risk scoring', () => {
    expect(contentFilter).toContain('function tryDecodeUriComponent')
    expect(contentFilter).toContain('export function normalizeModerationText')
    expect(contentFilter).toContain('export function createAhoCorasickMatcher')
    expect(contentFilter).toContain('export function scoreContentRisk')
    expect(contentFilter).toContain('const adMatcher = createAhoCorasickMatcher')
  })

  it('keeps search ranking on explicit field weights and post-runtime scoring', () => {
    expect(searchRanking).toContain('SEARCH_RANKING_FIELD_WEIGHTS')
    expect(searchRanking).toContain('scoreArticleSearchResult')
    expect(searchRanking).toContain('resolveHotScore')
    expect(searchRanking).toContain('resolveFreshnessScore')
    expect(localSearch).toContain('rankSearchPage(mapArticleSearchFromPodPayload(payload), query, sort)')
  })

  it('keeps notification stream article coalescing on a patch merge table', () => {
    expect(notificationStreamRenderScheduler).toContain('articlePatchMergeTable')
    expect(notificationStreamRenderScheduler).toContain('export function mergeNotificationStreamRenderPatch')
    expect(notificationStreamRenderScheduler).toContain("return `article:${payload?.articleId ?? 0}`")
  })

  it('keeps article card cache cleanup generation-based', () => {
    expect(articleListStableCache).toContain('let generation = 0')
    expect(articleListStableCache).toContain('cached.generation !== generation')
    expect(articleListStableCache).not.toContain('liveIds')
  })

  it('keeps anonymous public handles on the shared constraint schema', () => {
    expect(anonymousOnboarding).toContain('PUBLIC_HANDLE_CONSTRAINT')
    expect(anonymousOnboarding).toContain('validatePublicHandle(value)')
    expect(anonymousOnboarding).not.toContain('USERNAME_CONSTRAINT')
    expect(anonymousOnboarding).not.toContain('validateUsername')
  })
})
