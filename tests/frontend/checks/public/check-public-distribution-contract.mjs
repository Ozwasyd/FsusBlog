#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(process.cwd(), '../..');

function read(path)
{
    return readFileSync(resolve(repoRoot, path), 'utf8');
}

function assert(condition, message)
{
    if (!condition)
    {
        throw new Error(message);
    }
}

const endpoints = read('src/backend/Modules/Endpoints/DistributionEndpoints.cs');
const binaryArticleEndpoints = read('src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Articles.cs');
const service = read('src/backend/Services/Distribution/BlogDistributionService.cs');
const relatedService = read('src/backend/Services/Distribution/RelatedReadingService.cs');
const articleApi = read('src/frontend/src/api/article.ts');
const composer = read('src/backend/Infrastructure/PublicAot/PublicAotDocumentComposer.cs');
const aotSnapshots = read('src/backend/Infrastructure/PublicAot/PublicAotPageSnapshots.cs');
const aotMapper = read('src/backend/Infrastructure/PublicAot/PublicAotRendererPayloadMapper.cs');
const shell = read('src/frontend/src/components/public/PublicBlogLayoutShell.vue');
const complianceFooter = read('src/frontend/src/components/public/PublicComplianceFooter.vue');
const articlePage = read('src/frontend/src/components/public/pages/PublicArticleDetailPageContent.vue');
const articleViewContract = read('src/frontend/src/view-contracts/articleDetail.ts');
const publicEntryRegistry = read('src/frontend/src/public-renderers/publicEntryRegistry.ts');
const index = read('src/frontend/index.html');
const searchRequestPolicy = read('src/backend/Infrastructure/Spa/PublicSearchRequestPolicy.cs');
const searchRoutePolicy = read('src/frontend/src/public-renderers/publicSearchRoutePolicy.ts');
const generatedPageManifest = read('src/frontend/src/public-renderers/generated/publicPageManifest.ts');
const applicationComposition = [
    read('src/backend/Infrastructure/Bootstrap/PublicWebRuntime.cs'),
    read('src/backend/Infrastructure/Bootstrap/PublicWebRuntime.HtmlMaterialization.cs')
].join('\n');
const publicOriginPolicy = read('src/backend/Infrastructure/PublicAot/PublicOriginPolicy.cs');
const lifecycleBootstrap = read('src/backend/Infrastructure/Bootstrap/LifecycleHostedBootstrapService.cs');
const sqlSugarVisibilitySources = [
    'src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Taxonomy.cs',
    'src/backend/Modules/Endpoints/DistributionEndpoints.cs',
    'src/backend/Services/SearchIndexService.cs',
    'src/backend/Services/Distribution/BlogDistributionService.cs',
    'src/backend/Services/ArticleService.cs'
].map((path) => [path, read(path)]);

for (const route of [
    '/feed/rss.xml',
    '/api/Article/rss',
    '/feed/atom.xml',
    '/feed/feed.json',
    '/sitemap.xml',
    '/robots.txt'
])
{
    assert(endpoints.includes(route), `missing distribution route: ${route}`);
}

for (const mediaType of [
    'application/rss+xml; charset=utf-8',
    'application/atom+xml; charset=utf-8',
    'application/feed+json; charset=utf-8',
    'application/xml; charset=utf-8',
    'text/plain; charset=utf-8'
])
{
    assert(endpoints.includes(mediaType), `missing distribution content type: ${mediaType}`);
}

assert(endpoints.includes('CacheTag.ArticleList'), 'distribution cache must tag article list invalidation');
assert(endpoints.includes('CacheTag.Seo'), 'distribution cache must tag SEO invalidation');
assert(service.includes('a.status = @Status'), 'distribution projections must filter to published articles');
assert(service.includes('a.published_at <= @Now'), 'distribution projections must respect PublishedAt');
assert(service.includes('a.scheduled_publish_at <= @Now'), 'distribution projections must respect ScheduledPublishAt');
assert(service.includes('LoadFeedArticlesAsync'), 'feed must use its own bounded article projection');
assert(service.includes('LoadSitemapArticlesAsync'), 'sitemap must use its own complete article projection');
assert(service.includes('LIMIT @Limit'), 'feed projection must retain the explicit item bound');
assert(service.includes('COALESCE(a.public_updated_at, a.published_at, a.createtime)'), 'distribution modified time must prefer the public article update time');
assert(!service.includes('new XElement(ns + "priority"'), 'sitemap must not emit pseudo-ranking priority values');
assert(service.includes('CountSitemapUrlsFromFinalArtifacts'), 'distribution diagnostics must parse final sitemap XML artifacts');
assert(service.includes('XDocument.Parse(rss).Descendants("item").Count()'), 'distribution diagnostics must parse final feed XML');
assert(service.includes('SitemapPageSize = 45_000'), 'sitemap must reserve bounded index/page capacity below the protocol limit');
assert(endpoints.includes('/sitemap/{page:int}.xml'), 'sitemap index child documents must be routable');
assert(publicOriginPolicy.includes('public_origin_conflict'), 'public origin policy must fail closed on origin drift');
assert(lifecycleBootstrap.includes('PublicOriginTask'), 'startup lifecycle must validate the authoritative public origin');
assert(!endpoints.includes('JsonApiResponse<RelatedReadingResponse>'), 'deprecated related-reading JSON endpoint must be removed after #105 cleanup');
assert(binaryArticleEndpoints.includes('"/article/{articleId:int}/related.aeds"'), 'related-reading must expose an AEDS endpoint');
assert(binaryArticleEndpoints.includes('AedsFrameType.ArticleRelatedReading'), 'related-reading AEDS endpoint must use ArticleRelatedReading frame');
assert(binaryArticleEndpoints.includes('PodBinaryCodec.WriteRelatedReading'), 'related-reading AEDS endpoint must encode the related-reading POD payload');
assert(binaryArticleEndpoints.includes('ErrorCode.NotFound, "article_not_found"'), 'related-reading AEDS endpoint must return ApiError for missing articles');
assert(articleApi.includes('FrameType.ArticleRelatedReading'), 'frontend related-reading API must request the ArticleRelatedReading frame');
assert(articleApi.includes("operationId: 'binary_get_article_articleId_int_related_aeds'"), 'frontend related-reading API must use the generated binary route descriptor');
assert(articleApi.includes('params: { articleId: normalizePositiveInt(id, 1) }'), 'frontend related-reading API must bind the canonical articleId route parameter');
assert(!articleApi.includes('/api/public/articles'), 'frontend related-reading API must not call the deprecated JSON endpoint');
assert(!articleApi.includes('response.json'), 'frontend article API must not parse related-reading JSON envelopes');
assert(!articleApi.includes('JsonApiResponse'), 'frontend article API must not keep a related-reading JSON envelope helper');
assert(relatedService.includes('ExtractKeywords(article.Title, article.Summary)'), 'related-reading must derive keywords from the bounded public title/summary projection');
assert(relatedService.includes('CountKeywordMatches(candidateTitle, candidateSummary, keywords)'), 'related-reading must score candidate title/summary keyword matches');
assert(relatedService.includes('全文关键词'), 'related-reading must expose explainable keyword-match reasons');
assert(relatedService.includes('上一篇'), 'related-reading must expose previous article navigation');
assert(relatedService.includes('下一篇'), 'related-reading must expose next article navigation');
assert(relatedService.includes('ArticleStatus.Published'), 'related-reading must filter to published articles');
assert(relatedService.includes('candidate.PublishedAt == null || candidate.PublishedAt <= now'), 'related-reading must respect PublishedAt');
assert(relatedService.includes('candidate.ScheduledPublishAt == null || candidate.ScheduledPublishAt <= now'), 'related-reading must respect ScheduledPublishAt');
assert(aotSnapshots.includes('PublicAotRelatedReadingSnapshot'), 'PublicAOT snapshots must carry related-reading data');
assert(aotMapper.includes('relatedReading'), 'PublicAOT renderer payload must include related-reading data');
assert(publicEntryRegistry.includes('normalizeRelatedReading'), 'public renderer must normalize related-reading payloads');
assert(articleViewContract.includes('ArticleDetailRelatedReadingViewContract'), 'article detail view contract must include related reading');
assert(articlePage.includes('data-public-related-reading="true"'), 'article detail page must render the related-reading section');
for (const forbidden of ['Like', 'Favorite', 'Follow', 'Profile'])
{
    assert(!relatedService.includes(forbidden), `related-reading must not depend on social signal: ${forbidden}`);
}
assert(service.includes('Disallow: /user'), 'robots must disallow /user');
assert(service.includes('Disallow: /admin'), 'robots must disallow /admin');
assert(!service.includes('"Disallow: /search",'), 'robots must allow search HTML crawls so noindex remains visible');
assert(shell.includes('PublicComplianceFooter'), 'public shell must render the compliance footer');
assert(complianceFooter.includes('href="/feed/rss.xml"'), 'public footer must use canonical RSS feed path');
assert(index.includes('href="/feed/rss.xml"'), 'index must discover canonical RSS feed');
assert(index.includes('href="/feed/atom.xml"'), 'index must discover Atom feed');
assert(index.includes('href="/feed/feed.json"'), 'index must discover JSON Feed');
assert(composer.includes('href="/feed/rss.xml"'), 'AOT head must discover RSS feed');
assert(composer.includes('href="/feed/atom.xml"'), 'AOT head must discover Atom feed');
assert(composer.includes('href="/feed/feed.json"'), 'AOT head must discover JSON Feed');
assert(composer.includes('BreadcrumbList'), 'AOT head must include JSON-LD BreadcrumbList');
assert(composer.includes('BlogPosting'), 'AOT head must include JSON-LD BlogPosting');
assert(composer.includes('WebSite'), 'AOT head must include JSON-LD WebSite');
assert(!composer.includes('SearchAction'), 'indexable JSON-LD must not advertise the noindex search route');
assert(searchRequestPolicy.includes('PublicSearchRoutePolicy.MaxKeywordChars'), 'server search policy must consume the shared keyword bound');
assert(searchRequestPolicy.includes('PublicSearchRoutePolicy.MaxPage'), 'server search policy must consume the shared page bound');
assert(searchRequestPolicy.includes('PublicSearchRoutePolicy.MaxQueryStringChars'), 'server search policy must consume the shared raw query bound');
assert(searchRoutePolicy.includes('PUBLIC_SEARCH_ROUTE_POLICY'), 'SPA search policy must consume the generated shared contract');
assert(generatedPageManifest.includes('maxKeywordChars: 128'), 'generated search policy must expose the shared keyword bound');
assert(applicationComposition.includes('X-Robots-Tag"] = "noindex, follow"'), 'server search HTML must emit noindex before SPA rendering');
assert(applicationComposition.includes('s_searchNoIndexHeadInjection'), 'server search HTML must inject noindex before hydration');

for (const [path, source] of sqlSugarVisibilitySources)
{
    assert(!source.includes('.PublishedAt.HasValue'), `${path}: SqlSugar visibility queries must not use nullable HasValue`);
    assert(!source.includes('.ScheduledPublishAt.HasValue'), `${path}: SqlSugar visibility queries must not use nullable HasValue`);
}

console.log('[check-public-distribution-contract] ok');
