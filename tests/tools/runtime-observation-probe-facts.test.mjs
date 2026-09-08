import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import * as probe from '../../tools/test-evidence/runtime-observation-probe-facts.mjs'
import { digestValue } from '../../tools/fact-extractors/lib/canonicalize.mjs'

const sha = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`
const digest = (value) => `sha256:${digestValue(value)}`
const expectedReleaseId = '20260905120000-aaaaaaaaaaaa'
const verifySession = (facts) => probe.verifyFacts('session-cookie-runtime', facts, { expectedReleaseId })
const verifyCache = (facts) => probe.verifyFacts('cache-search-outbox-convergence', facts, { expectedReleaseId })

function sessionFacts()
{
  const hash = sha('a'.repeat(64))
  const database = { refreshtokenhash: hash, idleexpiresat: '2026-09-05T13:00:00Z',
    absoluteexpiresat: '2026-09-06T13:00:00Z', duration_policy: 'observed-policy' }
  const expiry = { accessTokenExp: 1788613200, issuedAt: 1788609600,
    idleExpiresAt: database.idleexpiresat, absoluteExpiresAt: database.absoluteexpiresat,
    durationPolicy: database.duration_policy }
  const token = sha('observed-token')
  return {
    schema: 'fsusblog.session-cookie-runtime-probe-facts.v1', coherent: true,
    database: { projection: database, sessionDigest: digest(database), sessionIdDigest: token,
      refreshTokenHashDigest: hash },
    credential: { presentedRefreshHashDigest: hash, storedRefreshHashDigest: hash, matches: true },
    storage: { projection: { surface: 'postgresql-session-storage', refreshTokenHashDigest: hash } },
    authContext: { digest: token, jwtMatches: true },
    jwt: { projection: { exp: expiry.accessTokenExp, iat: expiry.issuedAt },
      tokenDigest: token, claimsDigest: token, sessionMatches: true },
    cookie: { digest: token, sessionMatches: true },
    expiry: { projection: expiry, ordered: true, digest: digest({ accessTokenExp: expiry.accessTokenExp,
      idleExpiresAt: expiry.idleExpiresAt, absoluteExpiresAt: expiry.absoluteExpiresAt,
      durationPolicy: expiry.durationPolicy }) },
    revision: { digest: token, current: true }, device: { digest: token, matches: true },
    service: { digest: token, currentSessionMatches: true, status: { me: 200, sessions: 200 },
      releaseIds: [expectedReleaseId, expectedReleaseId] },
    modeOutcomes: {
      positive: { caseId: 'current-session-coherence', status: 200, passed: true, releaseId: expectedReleaseId },
      negative: { caseId: 'replaced-session-refresh-denied', status: 401, passed: true, releaseId: expectedReleaseId },
      failure: { caseId: 'revoked-session-refresh-denied', revokeStatus: 204, refreshStatus: 401,
        passed: true, releaseIds: [expectedReleaseId, expectedReleaseId] }
    }
  }
}

function cacheFacts()
{
  const hash = sha('observed')
  return { schema: 'fsusblog.cache-search-outbox-probe-facts.v1', coherent: true,
    terminal: { state: 'converged', processedEvents: 1, poisonEvents: 0 },
    events: [{ id: 1, status: 'processed', last_error: null }], edges: { eventTypes: ['published'] },
    authorityCoordinate: { articleIdDigest: hash, mutationIdDigest: hash },
    generation: { value: '0011', valueDigest: sha('0011'), present: true },
    query: { containsMarker: true, releaseId: expectedReleaseId,
      releaseScopedPath: `/release-derived/${expectedReleaseId}/search/index.bin`, searchIndexDigest: hash },
    readModel: { visible: true, projectionDigest: hash, detailDigest: hash, detailTitleDigest: hash },
    output: { containsMarker: true, navigationDigest: hash, envelopeDigest: hash } }
}

function resealExpiry(facts)
{
  const expiry = facts.expiry.projection
  facts.expiry.digest = digest({ accessTokenExp: expiry.accessTokenExp,
    idleExpiresAt: expiry.idleExpiresAt, absoluteExpiresAt: expiry.absoluteExpiresAt,
    durationPolicy: expiry.durationPolicy })
}

test('pure probe replay accepts coherent retained credential, expiry and generation relationships', () => {
  assert.doesNotThrow(() => verifySession(sessionFacts()))
  assert.doesNotThrow(() => verifyCache(cacheFacts()))
})

test('session replay rejects contradictory credential projections even with matches true', () => {
  for (const mutate of [
    (facts) => { facts.credential.presentedRefreshHashDigest = sha('different') },
    (facts) => { facts.credential.storedRefreshHashDigest = sha('different') },
    (facts) => { facts.database.refreshTokenHashDigest = sha('different') },
    (facts) => { facts.database.projection.refreshtokenhash = sha('different') },
    (facts) => { facts.storage.projection.refreshTokenHashDigest = sha('different') },
    (facts) => { delete facts.storage.projection.refreshTokenHashDigest }
  ])
  {
    const facts = sessionFacts()
    mutate(facts)
    assert.throws(() => verifySession(facts), /credential projections/)
  }
})

test('session replay recomputes original expiry ordering and exact JWT and DB projection bindings', () => {
  for (const mutate of [
    (facts) => { facts.expiry.projection.accessTokenExp = facts.expiry.projection.issuedAt },
    (facts) => { facts.expiry.projection.absoluteExpiresAt = '2026-09-04T00:00:00Z' },
    (facts) => { facts.expiry.projection.accessTokenExp = null },
    (facts) => { facts.expiry.projection.issuedAt = '' },
    (facts) => { facts.expiry.projection.idleExpiresAt = 'invalid' },
    (facts) => { facts.jwt.projection.exp += 1 },
    (facts) => { facts.jwt.projection.iat += 1 },
    (facts) => { facts.database.projection.idleexpiresat = '2026-09-05T14:00:00Z' },
    (facts) => { facts.database.projection.absoluteexpiresat = '2026-09-07T13:00:00Z' },
    (facts) => { facts.database.projection.duration_policy = 'other' },
    (facts) => { facts.expiry.digest = sha('different') }
  ])
  {
    const facts = sessionFacts()
    mutate(facts)
    assert.throws(() => verifySession(facts), /expiry projections/)
  }
})

test('session ordering rejects coordinated retained projection changes without imposing a new token lifetime policy', () => {
  const expired = sessionFacts()
  expired.expiry.projection.accessTokenExp = expired.expiry.projection.issuedAt
  expired.jwt.projection.exp = expired.expiry.projection.accessTokenExp
  resealExpiry(expired)
  assert.throws(() => verifySession(expired), /expiry projections/)
  const reversed = sessionFacts()
  reversed.expiry.projection.absoluteExpiresAt = '2026-09-04T00:00:00Z'
  reversed.database.projection.absoluteexpiresat = reversed.expiry.projection.absoluteExpiresAt
  resealExpiry(reversed)
  assert.throws(() => verifySession(reversed), /expiry projections/)
  const equalDatabaseBounds = sessionFacts()
  equalDatabaseBounds.expiry.projection.absoluteExpiresAt = equalDatabaseBounds.expiry.projection.idleExpiresAt
  equalDatabaseBounds.database.projection.absoluteexpiresat = equalDatabaseBounds.expiry.projection.absoluteExpiresAt
  resealExpiry(equalDatabaseBounds)
  assert.doesNotThrow(() => verifySession(equalDatabaseBounds))
  const laterToken = sessionFacts()
  laterToken.expiry.projection.accessTokenExp = 4102444800
  laterToken.jwt.projection.exp = laterToken.expiry.projection.accessTokenExp
  resealExpiry(laterToken)
  assert.doesNotThrow(() => verifySession(laterToken))
})

test('cache replay derives generation digest from exact observed bytes without numeric normalization', () => {
  for (const mutate of [
    (facts) => { facts.generation.valueDigest = sha('11') },
    (facts) => { facts.generation.value = '11' },
    (facts) => { facts.generation.value = '' },
    (facts) => { delete facts.generation.value },
    (facts) => { facts.generation.present = false }
  ])
  {
    const facts = cacheFacts()
    mutate(facts)
    assert.throws(() => verifyCache(facts), /cache\/search\/outbox/)
  }
})

test('refresh hash projection canonicalizes only valid hexadecimal casing before digesting', () => {
  assert.equal(typeof probe.refreshHashDigest, 'function')
  assert.equal(probe.refreshHashDigest('aB'.repeat(32)), sha('ab'.repeat(32)))
  assert.equal(probe.refreshHashDigest('AB'.repeat(32)), probe.refreshHashDigest('ab'.repeat(32)))
  assert.notEqual(probe.refreshHashDigest('ab'.repeat(32)), probe.refreshHashDigest('ac'.repeat(32)))
  for (const value of [null, '', 'ab', ` ${'ab'.repeat(32)}`, 'gg'.repeat(32)])
    assert.throws(() => probe.refreshHashDigest(value), /refresh hash/)
})
