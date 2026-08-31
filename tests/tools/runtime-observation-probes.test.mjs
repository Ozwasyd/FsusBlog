import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { resolveSourceCommit, resolveWorktreeFingerprint } from '../../tools/fact-extractors/identity.mjs'
import { seal } from '../../tools/fact-extractors/post-runtime/adapter.mjs'
import { projectProbeRaw } from '../../tools/test-evidence/runtime-observation-raw.mjs'
import { verifyFacts, verifyReceipt } from '../../tools/test-evidence/runtime-observation-probes.mjs'
import { projectPreparedPublicIds } from '../../tools/test-fixtures/receipt/projection.mjs'
import { root } from '../../tools/test-matrix/post-runtime-producer-registry.mjs'
import { createPostRuntimeCandidateFixture } from './support/post-runtime-candidate-fixture.mjs'

const commit = resolveSourceCommit(root)
const fingerprint = resolveWorktreeFingerprint(root)
const runId = 'runtime-observation-test'
const digest = (character) => `sha256:${character.repeat(64)}`
const fileDigest = (file) => `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`
const sha = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`

function routeFacts(prepared, prepareStateDigest)
{
  const projection = projectPreparedPublicIds(prepared)
  const value = (id, status, typedKind, hash, overrides = {}) => ({
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
    typedStatusCode: null,
    decodeError: null,
    ...overrides
  })
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
          'x-fsus-generation': '1', etag: '"fixture-etag"' },
        typedEntityId: Number(projection.articleId), typedTitleDigest: sha(projection.articleTitle)
      }),
      value('public-visible-cache-revalidation', 304, 'payload', '2', {
        headers: { etag: '"fixture-etag"' }
      }),
      value('public-missing-typed-error', 404, 'typed-error', '3', { typedStatusCode: 404 }),
      value('anonymous-auth-denied', 401, 'typed-error', '4'),
      value('user-self-visible', 200, 'payload', '5'),
      value('user-admin-denied', 403, 'typed-error', '6'),
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
  const receipt = seal({
    schema: 'fsusblog.runtime-observation-probe.v1',
    kind: 'route-response-error',
    producerId: 'production-correctness-scheduler',
    sourceState: {
      sourceCommit: commit,
      worktreeFingerprint: `sha256:${fingerprint}`,
      runId,
      attemptId: 'attempt-0001',
      buildIdentity: build.contentDigest,
      fixtureIdentity: fileDigest(fixturePath)
    },
    buildReceipt: { path: relative(buildPath), contentDigest: fileDigest(buildPath) },
    fixtureReceipt: { path: relative(fixturePath), contentDigest: fileDigest(fixturePath) },
    provenance: {
      mode: 'local-real-runtime',
      semanticAuthority: 'current-candidate-application-and-owned-services',
      syntheticSemanticResult: false,
      rerunCommand: 'node tools/test-evidence/runtime-observation-probes.mjs probe --kind route-response-error'
    },
    facts: routeFacts(prepared, fileDigest(fixturePath)),
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
  assert.throws(() => verifyReceipt(value.receipt), /regular non-symlink current-run file/u)
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
  const partial = routeFacts(prepared, digest('e'))
  partial.cases.pop()
  assert.throws(() => verifyFacts('route-response-error', partial), /exact real request closure/u)

  const mismatched = routeFacts(prepared, digest('e'))
  mismatched.cases.find((entry) => entry.id === 'user-admin-denied').status = 200
  assert.throws(() => verifyFacts('route-response-error', mismatched), /role\/auth\/visibility\/cache relations/u)

  for (const mutate of [
    (facts) => { facts.cases[0].typedEntityId = 99 },
    (facts) => { facts.cases[0].typedTitleDigest = digest('f') },
    (facts) => { delete facts.cases[0].headers['x-fsus-frame-version'] },
    (facts) => { facts.cases[1].headers.etag = '"stale-etag"' }
  ])
  {
    const stale = routeFacts(prepared, digest('e'))
    mutate(stale)
    assert.throws(() => verifyFacts('route-response-error', stale), /role\/auth\/visibility\/cache relations/u)
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
