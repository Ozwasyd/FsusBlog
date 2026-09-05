import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { resolveSourceCommit, resolveWorktreeFingerprint } from '../../tools/fact-extractors/identity.mjs'
import { observationSourceState, seal } from '../../tools/fact-extractors/post-runtime/adapter.mjs'
import { digestValue } from '../../tools/fact-extractors/lib/canonicalize.mjs'
import { projectProbeRaw, verifyProjectedRaw } from '../../tools/test-evidence/runtime-observation-raw.mjs'
import { verifyReceipt } from '../../tools/test-evidence/runtime-observation-probes.mjs'
import { deriveProbeRawFacts, verifyFacts } from '../../tools/test-evidence/runtime-observation-probe-facts.mjs'
import { projectPreparedPublicIds } from '../../tools/test-fixtures/receipt/projection.mjs'
import { loadPostRuntimeProducerRegistry, root } from '../../tools/test-matrix/post-runtime-producer-registry.mjs'
import { createPostRuntimeCandidateFixture } from './support/post-runtime-candidate-fixture.mjs'

const commit = resolveSourceCommit(root)
const fingerprint = resolveWorktreeFingerprint(root)
const runId = 'runtime-observation-test'
const digest = (character) => `sha256:${character.repeat(64)}`
const fileDigest = (file) => `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`
const sha = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`

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

function routeFacts(prepared, prepareStateDigest, releaseId)
{
  const projection = projectPreparedPublicIds(prepared)
  const value = (id, status, typedKind, hash, overrides = {}) => {
    const entry = {
    id,
    role: 'fixture-role',
    expectation: 'typed-semantic-result',
    status,
    headers: {},
    bodyDigest: digest(hash),
    byteLength: 1,
    typedPayloadDigest: digest(hash),
    typedKind,
    typedEntityId: null,
    typedTitleDigest: null,
    typedCode: null,
    typedCategory: null,
    typedStatusCode: null,
    typedMessageDigest: null,
    decodeError: null,
    ...overrides
    }
    entry.requestObservation = { method: 'GET', url: `http://127.0.0.1/fixture/${id}` }
    entry.typedPayloadProjection = typedKind === 'typed-error' ? { code: entry.typedCode,
      category: entry.typedCategory, statusCode: entry.typedStatusCode, messageDigest: entry.typedMessageDigest } : null
    return entry
  }
  return {
    schema: 'fsusblog.route-response-error-probe-facts.v1',
    fixtureAuthority: {
      prepareStateDigest,
      projectionDigest: projection.projectionDigest,
      articleIdDigest: sha(projection.articleId),
      articleTitleDigest: sha(projection.articleTitle),
      searchCanaryDigest: sha(projection.searchKeyword)
    },
    cases: [
      value('public-visible-first-read', 200, 'payload', '1', {
        headers: { 'content-type': 'application/octet-stream', 'x-fsus-frame-version': '2',
          'x-fsus-generation': '1', 'x-fsus-release-id': releaseId, etag: '"fixture-etag"' },
        typedEntityId: Number(projection.articleId), typedTitleDigest: sha(projection.articleTitle)
      }),
      value('public-visible-cache-revalidation', 304, 'payload', '2', {
        headers: { etag: '"fixture-etag"' }
      }),
      value('public-missing-typed-error', 404, 'typed-error', '3', {
        typedCode: 2, typedCategory: 4, typedStatusCode: 404, typedMessageDigest: sha('article_not_found')
      }),
      value('anonymous-auth-denied', 401, 'typed-error', '4', {
        typedCode: 4, typedCategory: 2, typedStatusCode: 401, typedMessageDigest: digest('4')
      }),
      value('user-self-visible', 200, 'payload', '5'),
      value('user-admin-denied', 403, 'typed-error', '6', {
        typedCode: 5, typedCategory: 3, typedStatusCode: 403, typedMessageDigest: digest('6')
      }),
      value('admin-list-visible', 200, 'payload', '7')
    ],
    coherent: true
  }
}

function fixture(context)
{
  const candidate = createPostRuntimeCandidateFixture(context, {
    prefix: 'runtime-observation-probe-', runId
  })
  const { directory, commit, worktreeFingerprint: fingerprint } = candidate
  const buildPath = candidate.buildFile
  const fixturePath = path.join(directory, 'fixture.json')
  const probePath = path.join(directory, 'probe.json')
  const relative = (file) => path.relative(root, file).replaceAll(path.sep, '/')
  const build = candidate.build
  const prepared = {
    schema: 'fsusblog.fixture-prepare-state.v1',
    terminalState: 'prepared',
    plan: {
      profileIdentity: { profileId: 'acceptance-representative' },
      executionIdentity: { runId, namespace: runId, sourceIdentity: { commit, worktreeFingerprint: fingerprint } },
      catalogDigest: digest('c')
    },
    producerOutputs: {
      'public-content': {
        producerId: 'public-content', strategy: 'transaction-fixture',
        producerVariantPlanDigest: digest('d'), variantIds: ['canonical.public.article.published'],
        entityIdentities: [
          { kind: 'article', id: '11', handle: 'Current article', variantId: 'canonical.public.article.published' },
          { kind: 'category', id: '12', handle: 'Current category', variantId: 'canonical.public.article.published' },
          { kind: 'tag', id: '13', handle: 'Current tag', variantId: 'canonical.public.article.published' }
        ],
        observations: { source: 'service', database: { entities: [] }, redis: { keys: [] }, cache: { entries: [] } },
        projection: { articleId: '11', articleTitle: 'Current article', categoryId: '12', tagId: '13', searchKeyword: 'CURRENT_BODY' }
      }
    }
  }
  fs.writeFileSync(fixturePath, `${JSON.stringify(prepared)}\n`)
  const facts = routeFacts(prepared, fileDigest(fixturePath), candidate.plan.candidate.releaseId)
  const rerunCommand = 'node tools/test-evidence/runtime-observation-probes.mjs probe --kind route-response-error'
  const receipt = seal({
    schema: 'fsusblog.runtime-observation-probe.v1',
    kind: 'route-response-error',
    producerId: 'production-correctness-scheduler',
    toolVersion: loadPostRuntimeProducerRegistry(root).producers.find((entry) => entry.producerId === candidate.plan.producerId).toolVersion,
    sourceState: observationSourceState({ classId: 'route-response-error', plan: candidate.plan,
      artifactDigest: `sha256:${digestValue(facts)}`, repositoryRoot: root }),
    rawFacts: deriveProbeRawFacts('route-response-error', facts),
    canonicalRerunCommand: rerunCommand,
    independentVerifyCommand: `node tools/test-evidence/runtime-observation-raw.mjs verify --candidate-plan ${relative(candidate.planFile)} --receipt ${candidate.plan.observations.find((entry) => entry.classId === 'route-response-error').receiptPath}`,
    candidatePlanRef: {
      path: relative(candidate.planFile),
      fileDigest: fileDigest(candidate.planFile),
      contentDigest: candidate.plan.contentDigest,
      schema: candidate.plan.schema,
      role: 'candidate-plan'
    },
    buildReceipt: { path: relative(buildPath), fileDigest: fileDigest(buildPath),
      contentDigest: candidate.build.contentDigest, schema: candidate.build.schema, role: 'production-build' },
    fixtureReceipt: { path: relative(fixturePath), fileDigest: fileDigest(fixturePath),
      contentDigest: prepared.contentDigest ?? null, schema: prepared.schema, role: 'fixture' },
    provenance: {
      mode: 'local-real-runtime',
      semanticAuthority: 'current-candidate-application-and-owned-services',
      syntheticSemanticResult: false,
      rerunCommand
    },
    facts,
    terminalStatus: 'verified'
  })
  fs.writeFileSync(probePath, `${JSON.stringify(receipt)}\n`)
  return { receipt, build, directory, buildPath, fixturePath, probePath, relative, candidate }
}

function candidatePlan(value)
{
  return { plan: value.candidate.plan, planPath: value.candidate.planFile }
}

test('probe verifier reopens exact current-run dependencies', (context) =>
{
  const value = fixture(context)
  assert.equal(verifyReceipt(value.receipt).terminalStatus, 'verified')
})

test('probe verifier rejects stale dependency bytes', (context) =>
{
  const value = fixture(context)
  fs.chmodSync(value.buildPath, 0o644)
  fs.appendFileSync(value.buildPath, ' ')
  assert.throws(() => verifyReceipt(value.receipt), /dependency digest mismatch/u)
})

test('probe verifier rejects source identity mismatch even when resealed', (context) =>
{
  const value = fixture(context)
  const tampered = seal({ ...value.receipt, contentDigest: undefined,
    sourceState: { ...value.receipt.sourceState, sourceCommit: 'c'.repeat(40) } })
  assert.throws(() => verifyReceipt(tampered), /build dependency identity mismatch/u)
})

test('probe verifier rejects a symlinked current-run dependency', (context) =>
{
  const value = fixture(context)
  const target = path.join(value.directory, 'fixture-target.json')
  fs.renameSync(value.fixturePath, target)
  fs.symlinkSync(target, value.fixturePath)
  assert.throws(() => verifyReceipt(value.receipt), /regular non-symlink (?:single-link )?current-run file/u)
})

test('raw projector binds a verified probe to the exact candidate and toolchain', (context) =>
{
  const value = fixture(context)
  const plan = candidatePlan(value)
  const raw = projectProbeRaw({
    candidatePlan: value.relative(plan.planPath),
    probeReceipt: value.relative(value.probePath),
    repositoryRoot: root
  })
  assert.match(raw.independentVerifyCommand, /verify --candidate-plan .* --receipt /u)
  assert.equal(raw.schema, 'fsusblog.observation.route-response-error.v1')
  assert.equal(raw.producerId, 'production-correctness-scheduler')
  if ('requestIdentity' in raw.semanticFacts)
  {
    assert.equal(raw.sourceState.runtimeId, `${runId}:runtime`)
  }
  else
  {
    assert.equal(raw.sourceState.runtimeId, `${runId}-runtime`)
  }
  assert.equal(raw.sourceState.attemptId, 'attempt-0001')
  if (!('requestIdentity' in raw.semanticFacts))
  {
    assert.equal(raw.sourceState.schemaIdentity, 'fsusblog.observation.route-response-error.v1')
    assert.equal(raw.sourceState.sourceReceiptSchemaIdentity, 'fsusblog.runtime-observation-probe.v1')
    assert.match(raw.sourceState.toolchainIdentity, /^sha256:[a-f0-9]{64}$/u)
  }
  assert.equal(raw.semanticFacts.protocolIdentity, 'aeds-v2')
  assert.notEqual(raw.semanticFacts.semanticMatch, false)
})

test('production correctness wires probes after current backend identity checks', () =>
{
  const lane = fs.readFileSync(path.join(root, 'tools/test/lanes/runtime-observation-probes.sh'), 'utf8')
  const scheduler = fs.readFileSync(path.join(root, 'tools/test/lanes/production-correctness-receipt.sh'), 'utf8')
  assert.match(lane, /backend PID start-time identity changed/u)
  assert.match(lane, /backend process belongs to another worktree/u)
  assert.match(lane, /Jwt__SecretKey=\*\|Jwt__KeyVersion=\*\|Jwt__Issuer=\*\|Jwt__Audience=\*/u)
  assert.doesNotMatch(lane, /env\s*>|printenv/u)
  assert.match(lane, /runtime-observation-probes\/\$RUN_ID\/\$ATTEMPT_ID/u)
  assert.match(lane, /FSUSBLOG_PRODUCTION_FRESH_ATTEMPT_ID/u)
  assert.doesNotMatch(lane, /rm -f "\$output"/u)
  const probeOffset = scheduler.indexOf('runtime-observation-probes.sh')
  const receiptOffset = scheduler.indexOf('create-correctness')
  assert.ok(probeOffset >= 0 && receiptOffset > probeOffset)
})

test('raw projector rejects a probe from another attempt', (context) =>
{
  const value = fixture(context)
  const plan = candidatePlan(value)
  const mismatched = seal({ ...value.receipt, contentDigest: undefined,
    sourceState: { ...value.receipt.sourceState, attemptId: 'attempt-0002' } })
  fs.writeFileSync(value.probePath, `${JSON.stringify(mismatched)}\n`)
  assert.throws(() => projectProbeRaw({
    candidatePlan: value.relative(plan.planPath),
    probeReceipt: value.relative(value.probePath),
    repositoryRoot: root
  }), /probe, build, and candidate plan identities do not exact-match/u)
})

test('raw verifier rejects a relocated extra result outside the candidate plan', (context) =>
{
  const value = fixture(context)
  const plan = candidatePlan(value)
  const raw = projectProbeRaw({
    candidatePlan: value.relative(plan.planPath),
    probeReceipt: value.relative(value.probePath),
    repositoryRoot: root
  })
  const relocated = path.join(value.directory, 'relocated-route-raw.json')
  fs.writeFileSync(relocated, `${JSON.stringify(raw)}\n`)
  assert.throws(() => verifyProjectedRaw(
    value.relative(relocated), root, value.relative(plan.planPath)), /path does not exact-match candidate plan/u)
})

test('route probe facts reject partial and mismatched semantic relations', () =>
{
  const prepared = {
    schema: 'fsusblog.fixture-prepare-state.v1', terminalState: 'prepared',
    plan: { profileIdentity: { profileId: 'acceptance-representative' }, executionIdentity: {
      runId, namespace: runId, sourceIdentity: { commit, worktreeFingerprint: fingerprint }
    }, catalogDigest: digest('c') },
    producerOutputs: { 'public-content': {
      producerId: 'public-content', strategy: 'transaction-fixture', producerVariantPlanDigest: digest('d'),
      variantIds: ['canonical.public.article.published'], entityIdentities: [
        { kind: 'article', id: '11' }, { kind: 'category', id: '12' }, { kind: 'tag', id: '13' }
      ], observations: { source: 'service', database: {}, redis: {}, cache: {} },
      projection: { articleId: '11', articleTitle: 'Current article', categoryId: '12', tagId: '13', searchKeyword: 'CURRENT_BODY' }
    } }
  }
  const expectedReleaseId = '20260830123456-aaaaaaaaaaaa'
  const partial = routeFacts(prepared, digest('e'), expectedReleaseId)
  partial.cases.pop()
  assert.throws(() => verifyFacts('route-response-error', partial, { expectedReleaseId }), /exact real request closure/u)

  const mismatched = routeFacts(prepared, digest('e'), expectedReleaseId)
  mismatched.cases.find((entry) => entry.id === 'user-admin-denied').status = 200
  assert.throws(() => verifyFacts('route-response-error', mismatched, { expectedReleaseId }), /role\/auth\/visibility\/cache relations/u)

  for (const mutate of [
    (facts) => { facts.cases[0].typedEntityId = 99 },
    (facts) => { facts.cases[0].typedTitleDigest = digest('f') },
    (facts) => { delete facts.cases[0].headers['x-fsus-frame-version'] },
    (facts) => { facts.cases[1].headers.etag = '"stale-etag"' },
    (facts) => { facts.cases[2].typedCode = 3 },
    (facts) => { facts.cases[3].typedPayloadDigest = null }
  ])
  {
    const stale = routeFacts(prepared, digest('e'), expectedReleaseId)
    mutate(stale)
    assert.throws(() => verifyFacts('route-response-error', stale, { expectedReleaseId }), /role\/auth\/visibility\/cache relations/u)
  }
})

test('cache and session probe facts reject partial terminal relations', () =>
{
  assert.throws(() => verifyFacts('cache-search-outbox-convergence', {
    schema: 'fsusblog.cache-search-outbox-probe-facts.v1', coherent: true,
    terminal: { state: 'converged', processedEvents: 1, poisonEvents: 0 },
    events: [], query: { containsMarker: true }, readModel: { visible: true }, output: { containsMarker: true }
  }), /stale or partial/u)
  assert.throws(() => verifyFacts('session-cookie-runtime', {
    schema: 'fsusblog.session-cookie-runtime-probe-facts.v1', coherent: true,
    credential: { matches: true }, authContext: { jwtMatches: true }, jwt: { sessionMatches: true },
    cookie: { sessionMatches: true }, expiry: { ordered: true }, revision: { current: true },
    device: { matches: true }, service: { currentSessionMatches: true, status: { me: 200, sessions: 200 } }
  }), /DB\/JWT\/cookie\/service relations/u)
})

test('cache facts reject wrong release paths, duplicate events, and unsealed generations', () =>
{
  const expectedReleaseId = '20260830123456-aaaaaaaaaaaa'
  const facts = {
    schema: 'fsusblog.cache-search-outbox-probe-facts.v1', coherent: true,
    terminal: { state: 'converged', processedEvents: 1, poisonEvents: 0 },
    events: [{ id: 1, status: 'processed', last_error: null }],
    edges: { eventTypes: ['article-published'] },
    authorityCoordinate: { articleIdDigest: digest('1'), mutationIdDigest: digest('2') },
    generation: { value: '3', valueDigest: sha('3'), present: true },
    query: {
      searchIndexDigest: digest('4'),
      releaseScopedPath: `/release-derived/${expectedReleaseId}/search/index.bin`,
      releaseId: expectedReleaseId,
      containsMarker: true
    },
    readModel: {
      projectionDigest: digest('5'), detailDigest: digest('6'),
      detailTitleDigest: digest('7'), visible: true
    },
    output: { navigationDigest: digest('8'), envelopeDigest: digest('9'), containsMarker: true }
  }
  assert.doesNotThrow(() => verifyFacts('cache-search-outbox-convergence', facts, { expectedReleaseId }))
  for (const mutate of [
    (value) => { value.query.releaseScopedPath = '/release-derived/other/search/index.bin' },
    (value) => {
      value.terminal.processedEvents = 2
      value.events.push(structuredClone(value.events[0]))
      value.edges.eventTypes.push('article-published')
    },
    (value) => { value.generation.present = false }
  ])
  {
    const changed = structuredClone(facts)
    mutate(changed)
    assert.throws(() => verifyFacts('cache-search-outbox-convergence', changed, { expectedReleaseId }),
      /stale or partial/u)
  }
})

test('session facts require distinct positive, negative, and revoked-session failure outcomes', () =>
{
  const expectedReleaseId = '20260830123456-aaaaaaaaaaaa'
  const facts = {
    schema: 'fsusblog.session-cookie-runtime-probe-facts.v1', coherent: true,
    database: { sessionDigest: digest('1'), sessionIdDigest: digest('b'), refreshTokenHashDigest: digest('c') },
    credential: { matches: true, presentedRefreshHashDigest: digest('2'),
      storedRefreshHashDigest: digest('3') },
    authContext: { jwtMatches: true, digest: digest('4') },
    jwt: { sessionMatches: true, tokenDigest: digest('d'), claimsDigest: digest('5') },
    cookie: { sessionMatches: true, digest: digest('6') }, expiry: { ordered: true, digest: digest('7') },
    revision: { current: true, digest: digest('8') }, device: { matches: true, digest: digest('9') },
    service: { currentSessionMatches: true, status: { me: 200, sessions: 200 }, digest: digest('a'),
      releaseIds: [expectedReleaseId, expectedReleaseId] },
    modeOutcomes: {
      positive: { caseId: 'current-session-coherence', status: 200, releaseId: expectedReleaseId, passed: true },
      negative: { caseId: 'replaced-session-refresh-denied', status: 401, releaseId: expectedReleaseId, passed: true },
      failure: { caseId: 'revoked-session-refresh-denied', revokeStatus: 200, refreshStatus: 403,
        releaseIds: [expectedReleaseId, expectedReleaseId], passed: true }
    }
  }
  assert.doesNotThrow(() => verifyFacts('session-cookie-runtime', facts, { expectedReleaseId }))
  for (const mode of ['positive', 'negative', 'failure'])
  {
    const changed = structuredClone(facts)
    changed.modeOutcomes[mode].passed = false
    assert.throws(() => verifyFacts('session-cookie-runtime', changed, { expectedReleaseId }),
      /DB\/JWT\/cookie\/service relations/u)
  }
})
