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

const distribution = read('src/backend/Services/Distribution/BlogDistributionService.cs')
const search = read('src/backend/Services/SearchIndexService.cs')
const publicAotSnapshots = read('src/backend/Infrastructure/PublicAot/PublicAotPageSnapshots.cs')
const publicAotMapper = read('src/backend/Infrastructure/PublicAot/PublicAotRendererPayloadMapper.cs')
const publicAotComposer = read('src/backend/Infrastructure/PublicAot/PublicAotDocumentComposer.cs')
const serviceWorker = read('src/frontend/public/sw.js')
const telemetry = read('src/frontend/src/services/telemetryService.ts')
const subscription = read('src/backend/Modules/Endpoints/SubscriptionEndpoints.cs')
const authorPreviewEndpoint = read('src/backend/Modules/Endpoints/AuthoringEndpoints.cs')
const bridgeAuthoringPrefixSymbol = ['BinaryBridgeInternalRequest', 'AuthoringPrefix'].join('.')
const bridgeInternalOnlyFilterSymbol = ['BinaryBridgeInternalOnly', 'Filter'].join('')

for (const [label, source] of [
  ['distribution feeds/sitemap', distribution],
  ['search index', search]
]) {
  assert(source.includes('ArticleStatus.Published'), `${label} must filter to published articles`)
  assert(source.includes('PublishedAt <= now') || source.includes('PublishedAt == null ||'), `${label} must respect PublishedAt`)
  assert(source.includes('ScheduledPublishAt <= now') || source.includes('ScheduledPublishAt == null ||'), `${label} must respect ScheduledPublishAt`)
}

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
assert(serviceWorker.includes('server headers own browser cache policy'), 'service worker must leave binary artifact browser cache policy to the server')
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
