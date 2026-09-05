import { createHash } from 'node:crypto'
import { digestValue, stable } from '../fact-extractors/lib/canonicalize.mjs'

const digestPattern = /^sha256:[a-f0-9]{64}$/u
const fail = (message) => { throw new Error(`[runtime-observation-probe] ${message}`) }
const sha = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`

function seal(value)
{
  const receipt = { ...stable(value), contentDigest: null }
  receipt.contentDigest = `sha256:${digestValue(Object.fromEntries(
    Object.entries(receipt).filter(([key]) => key !== 'contentDigest')))}`
  return receipt
}

export function deriveProbeRawFacts(kind, facts)
{
  const required = (value, label) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`missing observed projection: ${label}`)
    return value
  }
  if (kind === 'route-response-error')
  {
    const ids = ['public-visible-first-read', 'public-visible-cache-revalidation', 'public-missing-typed-error',
      'anonymous-auth-denied', 'user-self-visible', 'user-admin-denied', 'admin-list-visible']
    if (JSON.stringify(facts.cases?.map(({ id }) => id)) !== JSON.stringify(ids)) fail('raw route case closure mismatch')
    const [first, second, missing] = facts.cases
    const response = (entry) => ({ caseId: entry.id, role: entry.role, status: entry.status,
      typedKind: entry.typedKind, typedPayloadDigest: entry.typedPayloadDigest,
      typedEntityId: entry.typedEntityId, typedTitleDigest: entry.typedTitleDigest, decodeError: entry.decodeError })
    const cache = (entry) => ({ caseId: entry.id, status: entry.status, headers: entry.headers })
    return stable({
      requestIdentity: facts.cases.map((entry) => ({ caseId: entry.id,
        request: required(entry.requestObservation, entry.id) })),
      responseStatus: missing.status,
      typedPayload: required(missing.typedPayloadProjection, 'missing typed payload'),
      protocolIdentity: { contentType: first.headers['content-type'], frameVersion: first.headers['x-fsus-frame-version'],
        frameEncoding: first.headers['x-fsus-frame-encoding'] ?? null, decodeError: first.decodeError },
      authorizationDecision: facts.cases.slice(3).map(response),
      visibilityState: [first, missing].map(response), cacheSemantics: [first, second].map(cache),
      errorSemantics: facts.cases.filter((entry) => entry.typedKind === 'typed-error').map((entry) => ({
        caseId: entry.id, status: entry.status, payload: required(entry.typedPayloadProjection, entry.id) }))
    })
  }
  if (kind === 'cache-search-outbox-convergence')
  {
    if (facts.schema !== 'fsusblog.cache-search-outbox-probe-facts.v1'
      || Object.hasOwn(facts, 'contentDigest') || Object.hasOwn(facts, 'rawFacts')) fail('cache terminal must be unsealed observed facts')
    if (typeof facts.generation?.value !== 'string' || facts.generation.value.length === 0) fail('missing observed generation')
    return stable({ authorityCoordinates: required(facts.authorityCoordinate, 'coordinates'), event: facts.events,
      edge: required(facts.edges, 'edges'), generation: facts.generation,
      query: required(facts.query, 'query'), readModel: required(facts.readModel, 'read model'),
      output: required(facts.output, 'output'), terminalReceipt: seal(facts) })
  }
  if (kind === 'session-cookie-runtime')
  {
    const projection = (key) => required(facts[key]?.projection, key)
    const storage = projection('storage')
    if (storage.surface !== 'postgresql-session-storage') fail('session storage observation surface mismatch')
    const outcomes = Object.fromEntries(Object.entries(facts.modeOutcomes).map(([key, value]) => [key,
      Object.fromEntries(Object.entries(value).filter(([field]) => field !== 'passed'))]))
    return stable({ databaseSession: projection('database'),
      credential: { presentedRefreshHashDigest: facts.credential.presentedRefreshHashDigest,
        storedRefreshHashDigest: facts.credential.storedRefreshHashDigest },
      authContext: projection('authContext'), jwtClaims: projection('jwt'), cookieClaims: projection('cookie'),
      storageClaims: storage, expiry: projection('expiry'), revision: projection('revision'), device: projection('device'),
      serviceResult: { service: projection('service'), outcomes } })
  }
  fail(`unsupported raw probe kind: ${kind}`)
}

export function verifyFacts(kind, facts, { fixture = null, fixtureProjection: projectedFixture = null, expectedReleaseId = null } = {})
{
  if (fixture && !projectedFixture) fail('verified fixture projection is required')
  if (facts?.coherent !== true) fail(`${kind} facts are partial or incoherent`)
  if (kind === 'route-response-error')
  {
    const required = ['public-visible-first-read', 'public-visible-cache-revalidation', 'public-missing-typed-error',
      'anonymous-auth-denied', 'user-self-visible', 'user-admin-denied', 'admin-list-visible']
    if (facts.schema !== 'fsusblog.route-response-error-probe-facts.v1'
      || JSON.stringify(facts.cases?.map(({ id }) => id)) !== JSON.stringify(required)
      || facts.cases.some((item) => !digestPattern.test(item.bodyDigest ?? item.typedPayloadDigest ?? '')))
    {
      fail('route facts do not contain the exact real request closure')
    }
    const byId = new Map(facts.cases.map((item) => [item.id, item]))
    const first = byId.get('public-visible-first-read')
    const second = byId.get('public-visible-cache-revalidation')
    const authority = facts.fixtureAuthority ?? {}
    const exactTypedError = (entry, expectedStatus = entry?.status) => entry?.typedKind === 'typed-error'
      && entry.decodeError === null
      && digestPattern.test(String(entry.typedPayloadDigest ?? ''))
      && entry.typedStatusCode === expectedStatus
      && entry.typedCode === (expectedStatus === 404 ? 2 : expectedStatus === 401 ? 4 : 5)
      && entry.typedCategory === (expectedStatus === 404 ? 4 : expectedStatus === 401 ? 2 : 3)
      && digestPattern.test(String(entry.typedMessageDigest ?? ''))
    if ([authority.prepareStateDigest, authority.projectionDigest, authority.articleIdDigest,
      authority.articleTitleDigest, authority.searchCanaryDigest]
      .some((value) => !digestPattern.test(String(value ?? ''))))
    {
      fail('route facts do not bind the prepared fixture authority and canaries')
    }
    if (fixture || projectedFixture)
    {
      const projected = projectedFixture
      if (!projected || typeof projected.articleTitle !== 'string' || typeof projected.searchKeyword !== 'string'
        || !Number.isSafeInteger(Number(projected.articleId))
        || !digestPattern.test(String(projected.prepareStateDigest ?? ''))
        || !digestPattern.test(String(projected.projectionDigest ?? ''))) fail('verified fixture projection is invalid')
      if (authority.prepareStateDigest !== projected.prepareStateDigest
        || authority.projectionDigest !== projected.projectionDigest
        || authority.articleIdDigest !== sha(String(projected.articleId))
        || authority.articleTitleDigest !== sha(projected.articleTitle)
        || authority.searchCanaryDigest !== sha(projected.searchKeyword))
      {
        fail('route facts fixture authority does not replay from the prepared current run')
      }
    }
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
  else if (kind === 'session-cookie-runtime')
  {
    const relations = [facts.credential?.matches, facts.authContext?.jwtMatches, facts.jwt?.sessionMatches,
      facts.cookie?.sessionMatches, facts.expiry?.ordered, facts.revision?.current,
      facts.device?.matches, facts.service?.currentSessionMatches]
    const digests = [facts.database?.sessionDigest, facts.database?.sessionIdDigest,
      facts.database?.refreshTokenHashDigest, facts.credential?.presentedRefreshHashDigest,
      facts.credential?.storedRefreshHashDigest, facts.authContext?.digest,
      facts.jwt?.tokenDigest, facts.jwt?.claimsDigest, facts.cookie?.digest,
      facts.expiry?.digest, facts.revision?.digest, facts.device?.digest, facts.service?.digest]
    if (facts.schema !== 'fsusblog.session-cookie-runtime-probe-facts.v1'
      || relations.some((value) => value !== true) || digests.some((value) => !digestPattern.test(String(value ?? '')))
      || facts.service?.status?.me !== 200 || facts.service?.status?.sessions !== 200
      || facts.service?.releaseIds?.length !== 2
      || facts.service.releaseIds.some((value) => value !== expectedReleaseId)
      || facts.modeOutcomes?.positive?.caseId !== 'current-session-coherence'
      || facts.modeOutcomes.positive.status !== 200 || facts.modeOutcomes.positive.passed !== true
      || facts.modeOutcomes.positive.releaseId !== expectedReleaseId
      || facts.modeOutcomes?.negative?.caseId !== 'replaced-session-refresh-denied'
      || ![401, 403].includes(facts.modeOutcomes.negative.status)
      || facts.modeOutcomes.negative.passed !== true || facts.modeOutcomes.negative.releaseId !== expectedReleaseId
      || facts.modeOutcomes?.failure?.caseId !== 'revoked-session-refresh-denied'
      || facts.modeOutcomes.failure.revokeStatus < 200 || facts.modeOutcomes.failure.revokeStatus >= 300
      || ![401, 403].includes(facts.modeOutcomes.failure.refreshStatus)
      || facts.modeOutcomes.failure.passed !== true
      || facts.modeOutcomes.failure.releaseIds?.length !== 2
      || facts.modeOutcomes.failure.releaseIds.some((value) => value !== expectedReleaseId))
    {
      fail('session facts do not replay the exact DB/JWT/cookie/service relations')
    }
  }
  else if (facts.schema !== 'fsusblog.cache-search-outbox-probe-facts.v1'
    || facts.terminal?.state !== 'converged' || facts.terminal.processedEvents < 1
    || facts.terminal.poisonEvents !== 0 || facts.query?.containsMarker !== true
    || facts.query?.releaseId !== expectedReleaseId
    || facts.query?.releaseScopedPath !== `/release-derived/${expectedReleaseId}/search/index.bin`
    || facts.readModel?.visible !== true || facts.output?.containsMarker !== true
    || !Array.isArray(facts.events) || facts.events.length !== facts.terminal.processedEvents
    || facts.events.some((event) => event.status !== 'processed' || event.last_error != null)
    || new Set(facts.events.map(({ id }) => id)).size !== facts.events.length
    || !Array.isArray(facts.edges?.eventTypes) || facts.edges.eventTypes.length !== facts.events.length
    || facts.generation?.present !== true
    || [facts.authorityCoordinate?.articleIdDigest, facts.authorityCoordinate?.mutationIdDigest,
      facts.generation?.valueDigest, facts.query?.searchIndexDigest, facts.readModel?.projectionDigest,
      facts.readModel?.detailDigest, facts.readModel?.detailTitleDigest, facts.output?.navigationDigest,
      facts.output?.envelopeDigest].some((value) => !digestPattern.test(String(value ?? ''))))
  {
    fail('cache/search/outbox facts are stale or partial')
  }
}
