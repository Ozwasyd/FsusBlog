import assert from 'node:assert/strict'
import test from 'node:test'

import { seal } from '../../tools/fact-extractors/post-runtime/adapter.mjs'
import { deriveProbeRawFacts, verifyFacts } from '../../tools/test-evidence/runtime-observation-probe-facts.mjs'

const digest = (character) => `sha256:${character.repeat(64)}`

test('pure probe raw projection refuses a fixture without its verified public projection', () => {
  assert.throws(() => verifyFacts('route-response-error', {}, { fixture: {} }), /verified fixture projection is required/)
})

test('pure probe raw projection seals the full observed cache snapshot without a parent digest', () => {
  const facts = { schema: 'fsusblog.cache-search-outbox-probe-facts.v1',
    authorityCoordinate: { projectionVersion: 7 }, events: [{ id: 9, status: 'processed' }],
    edges: { eventTypes: ['published'] }, generation: { value: '11' },
    query: { responseStatus: 200, containsMarker: true }, readModel: { visible: true },
    output: { responseStatus: 200, containsMarker: true },
    terminal: { state: 'converged', processedEvents: 1, poisonEvents: 0 }, coherent: true }
  const raw = deriveProbeRawFacts('cache-search-outbox-convergence', facts)
  assert.deepEqual(raw.terminalReceipt, seal(facts))
  assert.equal(raw.terminalReceipt.schema, facts.schema)
  assert.deepEqual(facts.events, raw.event)
  const changed = structuredClone(facts)
  changed.events[0].status = 'pending'
  assert.notEqual(deriveProbeRawFacts('cache-search-outbox-convergence', changed).terminalReceipt.contentDigest,
    raw.terminalReceipt.contentDigest)
  assert.throws(() => deriveProbeRawFacts('cache-search-outbox-convergence', { ...facts, contentDigest: digest('a') }), /unsealed observed facts/)
  assert.throws(() => deriveProbeRawFacts('cache-search-outbox-convergence', { ...facts, generation: { valueDigest: digest('b') } }), /observed generation/)
})

test('pure probe raw projection requires actual route requests and decoded error projections', () => {
  const ids = ['public-visible-first-read', 'public-visible-cache-revalidation', 'public-missing-typed-error',
    'anonymous-auth-denied', 'user-self-visible', 'user-admin-denied', 'admin-list-visible']
  const facts = { cases: ids.map((id, index) => ({ id, role: index < 4 ? 'anonymous' : 'authenticated',
    requestObservation: { method: 'GET', url: `http://127.0.0.1/observed/${index}` },
    status: index === 2 ? 404 : 200, typedKind: index === 2 ? 'typed-error' : 'payload',
    typedPayloadProjection: index === 2 ? { code: 2, category: 4, statusCode: 404, messageDigest: digest('a') } : null,
    typedPayloadDigest: digest('b'), headers: { 'content-type': 'application/octet-stream', 'x-fsus-frame-version': '2' },
    decodeError: null, expectation: 'not-an-observation' })) }
  const raw = deriveProbeRawFacts('route-response-error', facts)
  assert.equal(raw.authorizationDecision.length, 4)
  assert.equal(raw.protocolIdentity.frameVersion, '2')
  assert.equal(JSON.stringify(raw).includes('not-an-observation'), false)
  const changed = structuredClone(facts)
  changed.cases[2].typedPayloadProjection = null
  assert.throws(() => deriveProbeRawFacts('route-response-error', changed), /missing typed payload/)
  changed.cases[2].typedPayloadProjection = facts.cases[2].typedPayloadProjection
  delete changed.cases[0].requestObservation
  assert.throws(() => deriveProbeRawFacts('route-response-error', changed), /observed projection/)
})

test('pure probe raw projection refuses digest-only session facts and browser-storage relabeling', () => {
  const fields = ['database', 'authContext', 'jwt', 'cookie', 'expiry', 'revision', 'device', 'service']
  const facts = Object.fromEntries(fields.map((key) => [key, { projection: { observedField: key } }]))
  facts.storage = { projection: { surface: 'postgresql-session-storage', refreshGeneration: 1 } }
  facts.credential = { presentedRefreshHashDigest: digest('a'), storedRefreshHashDigest: digest('a') }
  facts.modeOutcomes = { positive: { status: 200, passed: true } }
  const raw = deriveProbeRawFacts('session-cookie-runtime', facts)
  assert.equal(raw.storageClaims.surface, 'postgresql-session-storage')
  assert.equal(Object.hasOwn(raw.serviceResult.outcomes.positive, 'passed'), false)
  delete facts.jwt.projection
  facts.jwt.claimsDigest = digest('b')
  assert.throws(() => deriveProbeRawFacts('session-cookie-runtime', facts), /jwt/)
  facts.jwt.projection = { observedField: 'jwt' }
  facts.storage.projection.surface = 'browser-local-storage'
  assert.throws(() => deriveProbeRawFacts('session-cookie-runtime', facts), /storage observation surface/)
})
