import { digestValue, stable } from '../fact-extractors/lib/canonicalize.mjs'
import { fail } from './runtime-observation-probe-fact-common.mjs'

function seal(value)
{
  const receipt = { ...stable(value), contentDigest: null }
  receipt.contentDigest = `sha256:${digestValue(Object.fromEntries(
    Object.entries(receipt).filter(([key]) => key !== 'contentDigest')))}`
  return receipt
}

function required(value, label)
{
  if (value === null || typeof value !== 'object' || Array.isArray(value))
  {
    fail(`missing observed projection: ${label}`)
  }
  return value
}

function routeRawFacts(facts)
{
  const ids = ['public-visible-first-read', 'public-visible-cache-revalidation', 'public-missing-typed-error',
    'anonymous-auth-denied', 'user-self-visible', 'user-admin-denied', 'admin-list-visible']
  if (JSON.stringify(facts.cases?.map(({ id }) => id)) !== JSON.stringify(ids))
  {
    fail('raw route case closure mismatch')
  }
  const [first, second, missing] = facts.cases
  const response = (entry) => ({
    caseId: entry.id, role: entry.role, status: entry.status,
    typedKind: entry.typedKind, typedPayloadDigest: entry.typedPayloadDigest,
    typedEntityId: entry.typedEntityId, typedTitleDigest: entry.typedTitleDigest,
    decodeError: entry.decodeError
  })
  const cache = (entry) => ({ caseId: entry.id, status: entry.status, headers: entry.headers })
  return stable({
    requestIdentity: facts.cases.map((entry) => ({
      caseId: entry.id, request: required(entry.requestObservation, entry.id)
    })),
    responseStatus: missing.status,
    typedPayload: required(missing.typedPayloadProjection, 'missing typed payload'),
    protocolIdentity: {
      contentType: first.headers['content-type'],
      frameVersion: first.headers['x-fsus-frame-version'],
      frameEncoding: first.headers['x-fsus-frame-encoding'] ?? null,
      decodeError: first.decodeError
    },
    authorizationDecision: facts.cases.slice(3).map(response),
    visibilityState: [first, missing].map(response),
    cacheSemantics: [first, second].map(cache),
    errorSemantics: facts.cases.filter((entry) => entry.typedKind === 'typed-error').map((entry) => ({
      caseId: entry.id, status: entry.status,
      payload: required(entry.typedPayloadProjection, entry.id)
    }))
  })
}

function cacheRawFacts(facts)
{
  if (facts.schema !== 'fsusblog.cache-search-outbox-probe-facts.v1'
    || Object.hasOwn(facts, 'contentDigest') || Object.hasOwn(facts, 'rawFacts'))
  {
    fail('cache terminal must be unsealed observed facts')
  }
  if (typeof facts.generation?.value !== 'string' || facts.generation.value.length === 0)
  {
    fail('missing observed generation')
  }
  return stable({
    authorityCoordinates: required(facts.authorityCoordinate, 'coordinates'),
    event: facts.events,
    edge: required(facts.edges, 'edges'),
    generation: facts.generation,
    query: required(facts.query, 'query'),
    readModel: required(facts.readModel, 'read model'),
    output: required(facts.output, 'output'),
    terminalReceipt: seal(facts)
  })
}

function sessionRawFacts(facts)
{
  const projection = (key) => required(facts[key]?.projection, key)
  const storage = projection('storage')
  if (storage.surface !== 'postgresql-session-storage')
  {
    fail('session storage observation surface mismatch')
  }
  const outcomes = Object.fromEntries(Object.entries(facts.modeOutcomes).map(([key, value]) => [
    key,
    Object.fromEntries(Object.entries(value).filter(([field]) => field !== 'passed'))
  ]))
  return stable({
    databaseSession: projection('database'),
    credential: {
      presentedRefreshHashDigest: facts.credential.presentedRefreshHashDigest,
      storedRefreshHashDigest: facts.credential.storedRefreshHashDigest
    },
    authContext: projection('authContext'),
    jwtClaims: projection('jwt'),
    cookieClaims: projection('cookie'),
    storageClaims: storage,
    expiry: projection('expiry'),
    revision: projection('revision'),
    device: projection('device'),
    serviceResult: { service: projection('service'), outcomes }
  })
}

export function deriveProbeRawFacts(kind, facts)
{
  if (kind === 'route-response-error') return routeRawFacts(facts)
  if (kind === 'cache-search-outbox-convergence') return cacheRawFacts(facts)
  if (kind === 'session-cookie-runtime') return sessionRawFacts(facts)
  fail(`unsupported raw probe kind: ${kind}`)
}
