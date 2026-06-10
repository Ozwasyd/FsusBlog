#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = resolve(process.cwd(), '../..')

function read(path) {
  return readFileSync(resolve(repoRoot, path), 'utf8')
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

const endpoints = read('src/backend/Modules/Endpoints/DistributionEndpoints.cs')
const binaryArticleEndpoints = read('src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Articles.cs')
const service = read('src/backend/Services/Distribution/BlogDistributionService.cs')
const relatedService = read('src/backend/Services/Distribution/RelatedReadingService.cs')
const articleApi = read('src/frontend/src/api/article.ts')
const composer = read('src/backend/Infrastructure/PublicAot/PublicAotDocumentComposer.cs')
const aotSnapshots = read('src/backend/Infrastructure/PublicAot/PublicAotPageSnapshots.cs')
const aotMapper = read('src/backend/Infrastructure/PublicAot/PublicAotRendererPayloadMapper.cs')
const shell = read('src/frontend/src/components/public/PublicBlogLayoutShell.vue')
const complianceFooter = read('src/frontend/src/components/public/PublicComplianceFooter.vue')
const articlePage = read('src/frontend/src/components/public/pages/PublicArticleDetailPageContent.vue')
const articleViewContract = read('src/frontend/src/view-contracts/articleDetail.ts')
const publicEntryRegistry = read('src/frontend/src/public-renderers/publicEntryRegistry.ts')
const index = read('src/frontend/index.html')
const sqlSugarVisibilitySources = [
  'src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Taxonomy.cs',
  'src/backend/Modules/Endpoints/DistributionEndpoints.cs',
  'src/backend/Services/SearchIndexService.cs',
  'src/backend/Services/Distribution/BlogDistributionService.cs',
  'src/backend/Services/ArticleService.cs'
].map((path) => [path, read(path)])

for (const route of [
  '/feed/rss.xml',
  '/api/Article/rss',
  '/feed/atom.xml',
  '/feed/feed.json',
  '/sitemap.xml',
  '/robots.txt',
  '/api/public/articles/{articleId:int}/related'
]) {
  assert(endpoints.includes(route), `missing distribution route: ${route}`)
}

for (const mediaType of [
  'application/rss+xml; charset=utf-8',
  'application/atom+xml; charset=utf-8',
  'application/feed+json; charset=utf-8',
  'application/xml; charset=utf-8',
  'text/plain; charset=utf-8'
]) {
  assert(endpoints.includes(mediaType), `missing distribution content type: ${mediaType}`)
}

assert(endpoints.includes('CacheTag.ArticleList'), 'distribution cache must tag article list invalidation')
assert(endpoints.includes('CacheTag.Seo'), 'distribution cache must tag SEO invalidation')
assert(service.includes('article.Status == ArticleStatus.Published'), 'distribution snapshot must filter to published articles')
assert(service.includes('article.PublishedAt <= now'), 'distribution snapshot must respect PublishedAt')
assert(service.includes('article.ScheduledPublishAt <= now'), 'distribution snapshot must respect ScheduledPublishAt')
assert(endpoints.includes('JsonApiResponse<RelatedReadingResponse>'), 'deprecated related-reading JSON endpoint must keep the composite response contract until #105 cleanup')
assert(binaryArticleEndpoints.includes('"/article/{articleId:int}/related.aeds"'), 'related-reading must expose an AEDS endpoint')
assert(binaryArticleEndpoints.includes('AedsFrameType.ArticleRelatedReading'), 'related-reading AEDS endpoint must use ArticleRelatedReading frame')
assert(binaryArticleEndpoints.includes('PodBinaryCodec.WriteRelatedReading'), 'related-reading AEDS endpoint must encode the related-reading POD payload')
assert(binaryArticleEndpoints.includes('ErrorCode.NotFound, "article_not_found"'), 'related-reading AEDS endpoint must return ApiError for missing articles')
assert(articleApi.includes('FrameType.ArticleRelatedReading'), 'frontend related-reading API must request the ArticleRelatedReading frame')
assert(articleApi.includes('/api/binary/article/${normalizePositiveInt(id, 1)}/related.aeds'), 'frontend related-reading API must use the binary endpoint')
assert(!articleApi.includes('/api/public/articles'), 'frontend related-reading API must not call the deprecated JSON endpoint')
assert(!articleApi.includes('response.json'), 'frontend article API must not parse related-reading JSON envelopes')
assert(!articleApi.includes('JsonApiResponse'), 'frontend article API must not keep a related-reading JSON envelope helper')
assert(relatedService.includes('ArticleBody'), 'related-reading must use article body text for full-text keyword matching')
assert(relatedService.includes('全文关键词'), 'related-reading must expose explainable keyword-match reasons')
assert(relatedService.includes('上一篇'), 'related-reading must expose previous article navigation')
assert(relatedService.includes('下一篇'), 'related-reading must expose next article navigation')
assert(relatedService.includes('ArticleStatus.Published'), 'related-reading must filter to published articles')
assert(relatedService.includes('candidate.PublishedAt == null || candidate.PublishedAt <= now'), 'related-reading must respect PublishedAt')
assert(relatedService.includes('candidate.ScheduledPublishAt == null || candidate.ScheduledPublishAt <= now'), 'related-reading must respect ScheduledPublishAt')
assert(aotSnapshots.includes('PublicAotRelatedReadingSnapshot'), 'PublicAOT snapshots must carry related-reading data')
assert(aotMapper.includes('relatedReading'), 'PublicAOT renderer payload must include related-reading data')
assert(publicEntryRegistry.includes('normalizeRelatedReading'), 'public renderer must normalize related-reading payloads')
assert(articleViewContract.includes('ArticleDetailRelatedReadingViewContract'), 'article detail view contract must include related reading')
assert(articlePage.includes('data-public-related-reading="true"'), 'article detail page must render the related-reading section')
for (const forbidden of ['Like', 'Favorite', 'Follow', 'Profile']) {
  assert(!relatedService.includes(forbidden), `related-reading must not depend on social signal: ${forbidden}`)
}
assert(service.includes('Disallow: /user'), 'robots must disallow /user')
assert(service.includes('Disallow: /admin'), 'robots must disallow /admin')
assert(shell.includes('PublicComplianceFooter'), 'public shell must render the compliance footer')
assert(complianceFooter.includes('href="/feed/rss.xml"'), 'public footer must use canonical RSS feed path')
assert(index.includes('href="/feed/rss.xml"'), 'index must discover canonical RSS feed')
assert(index.includes('href="/feed/atom.xml"'), 'index must discover Atom feed')
assert(index.includes('href="/feed/feed.json"'), 'index must discover JSON Feed')
assert(composer.includes('href="/feed/rss.xml"'), 'AOT head must discover RSS feed')
assert(composer.includes('href="/feed/atom.xml"'), 'AOT head must discover Atom feed')
assert(composer.includes('href="/feed/feed.json"'), 'AOT head must discover JSON Feed')
assert(composer.includes('BreadcrumbList'), 'AOT head must include JSON-LD BreadcrumbList')
assert(composer.includes('BlogPosting'), 'AOT head must include JSON-LD BlogPosting')
assert(composer.includes('WebSite'), 'AOT head must include JSON-LD WebSite')
assert(composer.includes('SearchAction'), 'AOT head must include JSON-LD SearchAction')

for (const [path, source] of sqlSugarVisibilitySources) {
  assert(!source.includes('.PublishedAt.HasValue'), `${path}: SqlSugar visibility queries must not use nullable HasValue`)
  assert(!source.includes('.ScheduledPublishAt.HasValue'), `${path}: SqlSugar visibility queries must not use nullable HasValue`)
}

console.log('[check-public-distribution-contract] ok')
