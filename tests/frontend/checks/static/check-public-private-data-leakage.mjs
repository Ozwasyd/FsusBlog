#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs'
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

const distribution = read('src/backend/Services/Distribution/BlogDistributionService.cs')
const search = read('src/backend/Services/SearchIndexService.cs')
const publicAotSnapshots = read('src/backend/Infrastructure/PublicAot/PublicAotPageSnapshots.cs')
const publicAotMapper = read('src/backend/Infrastructure/PublicAot/PublicAotRendererPayloadMapper.cs')
const publicAotComposer = read('src/backend/Infrastructure/PublicAot/PublicAotDocumentComposer.cs')
const serviceWorker = read('src/frontend/public/sw.js')
const telemetry = read('src/frontend/src/services/telemetryService.ts')
const subscription = read('src/backend/Modules/Endpoints/SubscriptionEndpoints.cs')
const authoringEndpointsRoot = resolve(repoRoot, 'src/backend/Modules/Endpoints')
const authorPreviewEndpoint = readdirSync(authoringEndpointsRoot)
  .filter((name) => /^AuthoringEndpoints(?:\..+)?\.cs$/u.test(name))
  .sort()
  .map((name) => read(`src/backend/Modules/Endpoints/${name}`))
  .join('\n')
const bridgeAuthoringPrefixSymbol = ['BinaryBridgeInternalRequest', 'AuthoringPrefix'].join('.')
const bridgeInternalOnlyFilterSymbol = ['BinaryBridgeInternalOnly', 'Filter'].join('')

assert(distribution.includes('a.status = @Status'), 'distribution feeds/sitemap must filter to published articles')
assert(distribution.includes('new("@Status", (int)ArticleStatus.Published)'), 'distribution feeds/sitemap must bind published status')
assert(distribution.includes('a.published_at IS NULL OR a.published_at <= @Now'), 'distribution feeds/sitemap must respect PublishedAt')
assert(distribution.includes('a.scheduled_publish_at IS NULL OR a.scheduled_publish_at <= @Now'), 'distribution feeds/sitemap must respect ScheduledPublishAt')

assert(search.includes('ArticleStatus.Published'), 'search index must filter to published articles')
assert(search.includes('PublishedAt <= now') || search.includes('PublishedAt == null ||'), 'search index must respect PublishedAt')
assert(search.includes('ScheduledPublishAt <= now') || search.includes('ScheduledPublishAt == null ||'), 'search index must respect ScheduledPublishAt')

for (const [label, source] of [
  ['PublicAOT snapshots', publicAotSnapshots],
  ['PublicAOT renderer payload mapper', publicAotMapper],
  ['PublicAOT document composer', publicAotComposer]
]) {
  for (const forbidden of [
    'ArticleDraft',
    'ArticleRevision',
    'PrivatePreview',
    'RefreshToken',
    'EmailHash',
    'PasswordHash',
    'MfaSecret'
  ]) {
    assert(!source.includes(forbidden), `${label} must not expose private server model: ${forbidden}`)
  }
}

const shellPathBlock = serviceWorker.slice(
  serviceWorker.indexOf('const PUBLIC_SHELL_PATHS'),
  serviceWorker.indexOf('const STATIC_ASSET_PATTERN')
)
for (const forbiddenPath of ['/admin', '/user', '/login', '/api']) {
  assert(!shellPathBlock.includes(forbiddenPath), `service worker public shell cache must not include ${forbiddenPath}`)
}
assert(serviceWorker.includes("url.pathname.startsWith('/api/binary/')"), 'service worker must keep binary API outside public shell cache')
for (const publicArtifactPath of [
  '/api/binary/article/list/home/',
  '/api/binary/category.aeds',
  '/api/binary/tag.aeds'
]) {
  assert(!shellPathBlock.includes(publicArtifactPath), `service worker shell cache must not include ${publicArtifactPath}`)
}
assert(serviceWorker.includes("failureKind = url.pathname.startsWith('/api/binary/')"), 'service worker must classify binary requests as network-only')
assert(serviceWorker.includes('event.respondWith(networkOnlyRequest(request, failureKind))'), 'service worker must leave binary artifact browser cache policy to the server')
assert(serviceWorker.includes('clearLegacyFsusCaches'), 'service worker must clear old public caches on activate')
assert(serviceWorker.includes('shell.invalidate'), 'service worker must support public shell invalidation')

assert(telemetry.includes("if (pageType === 'private')"), 'RUM must skip private /user and /admin routes')
for (const forbidden of ['document.cookie', 'localStorage.getItem(\'token\')', 'localStorage.getItem("token")']) {
  assert(!telemetry.includes(forbidden), `RUM must not collect ${forbidden}`)
}

assert(subscription.includes('SiteSubscriptionIdentity.HashEmail(request.Email, configuration)'), 'subscription must hash email before storage')
assert(!subscription.includes('email ='), 'subscription responses must not echo raw email')

assert(authorPreviewEndpoint.includes('"/api/binary/author"'), 'author implementation must stay on the native binary author prefix')
assert(!authorPreviewEndpoint.includes(bridgeAuthoringPrefixSymbol), 'author implementation must not use internal bridge prefix')
assert(!authorPreviewEndpoint.includes(bridgeInternalOnlyFilterSymbol), 'author implementation must not depend on bridge-only filter')
assert(!authorPreviewEndpoint.includes('JsonApiResponse<'), 'author implementation must not expose JSON envelopes')
assert(authorPreviewEndpoint.includes('.RequireAdminPermission(AdminPermissions.ArticleWrite)'), 'author private preview endpoint group must require admin authorization')
assert(authorPreviewEndpoint.includes('group.MapPost("/preview"'), 'author private preview route must stay inside the admin authoring group')

console.log('[check-public-private-data-leakage] ok')
