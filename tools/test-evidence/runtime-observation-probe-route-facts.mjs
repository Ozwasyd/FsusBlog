import { digestPattern, fail, sha } from './runtime-observation-probe-fact-common.mjs'

const requiredCases = [
  'public-visible-first-read',
  'public-visible-cache-revalidation',
  'public-missing-typed-error',
  'anonymous-auth-denied',
  'user-self-visible',
  'user-admin-denied',
  'admin-list-visible'
]

function exactTypedError(entry, expectedStatus = entry?.status)
{
  return entry?.typedKind === 'typed-error'
    && entry.decodeError === null
    && digestPattern.test(String(entry.typedPayloadDigest ?? ''))
    && entry.typedStatusCode === expectedStatus
    && entry.typedCode === (expectedStatus === 404 ? 2 : expectedStatus === 401 ? 4 : 5)
    && entry.typedCategory === (expectedStatus === 404 ? 4 : expectedStatus === 401 ? 2 : 3)
    && digestPattern.test(String(entry.typedMessageDigest ?? ''))
}

function verifyFixtureAuthority(authority, projected)
{
  if (!projected || typeof projected.articleTitle !== 'string'
    || typeof projected.searchKeyword !== 'string'
    || !Number.isSafeInteger(Number(projected.articleId))
    || !digestPattern.test(String(projected.prepareStateDigest ?? ''))
    || !digestPattern.test(String(projected.projectionDigest ?? '')))
  {
    fail('verified fixture projection is invalid')
  }
  if (authority.prepareStateDigest !== projected.prepareStateDigest
    || authority.projectionDigest !== projected.projectionDigest
    || authority.articleIdDigest !== sha(String(projected.articleId))
    || authority.articleTitleDigest !== sha(projected.articleTitle)
    || authority.searchCanaryDigest !== sha(projected.searchKeyword))
  {
    fail('route facts fixture authority does not replay from the prepared current run')
  }
}

export function verifyRouteFacts(facts, { fixture = null, projectedFixture = null, expectedReleaseId = null } = {})
{
  if (facts.schema !== 'fsusblog.route-response-error-probe-facts.v1'
    || JSON.stringify(facts.cases?.map(({ id }) => id)) !== JSON.stringify(requiredCases)
    || facts.cases.some((item) => !digestPattern.test(item.bodyDigest ?? item.typedPayloadDigest ?? '')))
  {
    fail('route facts do not contain the exact real request closure')
  }
  const byId = new Map(facts.cases.map((item) => [item.id, item]))
  const first = byId.get('public-visible-first-read')
  const second = byId.get('public-visible-cache-revalidation')
  const authority = facts.fixtureAuthority ?? {}
  if ([authority.prepareStateDigest, authority.projectionDigest, authority.articleIdDigest,
    authority.articleTitleDigest, authority.searchCanaryDigest]
    .some((value) => !digestPattern.test(String(value ?? ''))))
  {
    fail('route facts do not bind the prepared fixture authority and canaries')
  }
  if (fixture || projectedFixture) verifyFixtureAuthority(authority, projectedFixture)
  if (first.status !== 200 || first.typedKind !== 'payload' || first.decodeError !== null
    || first.typedEntityId == null || sha(String(first.typedEntityId)) !== authority.articleIdDigest
    || first.typedTitleDigest !== authority.articleTitleDigest
    || first.headers?.['content-type']?.toLowerCase().includes('application/octet-stream') !== true
    || first.headers?.['x-fsus-frame-version'] !== '2'
    || first.headers?.['x-fsus-release-id'] !== expectedReleaseId
    || !digestPattern.test(String(first.typedPayloadDigest ?? ''))
    || !/^[0-9]+$/u.test(String(first.headers?.['x-fsus-generation'] ?? ''))
    || typeof first.headers?.etag !== 'string' || first.headers.etag.length === 0
    || second.status !== 304 || second.headers?.etag !== first.headers.etag
    || byId.get('public-missing-typed-error').status !== 404
    || !exactTypedError(byId.get('public-missing-typed-error'), 404)
    || byId.get('public-missing-typed-error').typedMessageDigest !== sha('article_not_found')
    || ![401, 403].includes(byId.get('anonymous-auth-denied').status)
    || !exactTypedError(byId.get('anonymous-auth-denied'))
    || byId.get('user-self-visible').status !== 200
    || byId.get('user-self-visible').typedKind !== 'payload'
    || byId.get('user-self-visible').decodeError !== null
    || !digestPattern.test(String(byId.get('user-self-visible').typedPayloadDigest ?? ''))
    || ![401, 403].includes(byId.get('user-admin-denied').status)
    || !exactTypedError(byId.get('user-admin-denied'))
    || byId.get('admin-list-visible').status !== 200
    || byId.get('admin-list-visible').typedKind !== 'payload'
    || byId.get('admin-list-visible').decodeError !== null
    || !digestPattern.test(String(byId.get('admin-list-visible').typedPayloadDigest ?? '')))
  {
    fail('route facts do not replay the required role/auth/visibility/cache relations')
  }
}
