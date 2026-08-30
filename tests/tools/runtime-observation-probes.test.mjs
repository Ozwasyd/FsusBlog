import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { seal } from '../../tools/fact-extractors/post-runtime/adapter.mjs'
import { projectProbeRaw } from '../../tools/test-evidence/runtime-observation-raw.mjs'
import { verifyFacts, verifyReceipt } from '../../tools/test-evidence/runtime-observation-probes.mjs'
import {
  loadPostRuntimeProducerRegistry,
  root
} from '../../tools/test-matrix/post-runtime-producer-registry.mjs'

const commit = 'a'.repeat(40)
const fingerprint = 'b'.repeat(64)
const runId = 'runtime-observation-test'
const digest = (character) => `sha256:${character.repeat(64)}`
const fileDigest = (file) => `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`

function routeFacts()
{
  const value = (id, status, typedKind, hash) => ({
    id,
    role: 'fixture-role',
    expectation: 'typed-semantic-result',
    status,
    headers: {},
    bodyDigest: digest(hash),
    byteLength: 1,
    typedPayloadDigest: digest(hash),
    typedKind,
    decodeError: null
  })
  return {
    schema: 'fsusblog.route-response-error-probe-facts.v1',
    cases: [
      value('public-visible-first-read', 200, 'payload', '1'),
      value('public-visible-cache-revalidation', 304, 'payload', '2'),
      value('public-missing-typed-error', 404, 'typed-error', '3'),
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
  const directory = fs.mkdtempSync(path.join(root, '.tmp', 'runtime-observation-probe-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const buildPath = path.join(directory, 'build.json')
  const fixturePath = path.join(directory, 'fixture.json')
  const probePath = path.join(directory, 'probe.json')
  const relative = (file) => path.relative(root, file).replaceAll(path.sep, '/')
  const build = seal({
    schema: 'fsusblog.ci-production-build-receipt.v1',
    status: 'complete',
    sourceState: { commit, worktreeFingerprint: fingerprint },
    toolchain: { node: '24', dotnet: '10' }
  })
  const prepared = {
    schema: 'fsusblog.fixture-prepare-state.v1',
    terminalState: 'prepared',
    plan: { executionIdentity: { runId, sourceIdentity: { commit, worktreeFingerprint: fingerprint } } }
  }
  fs.writeFileSync(buildPath, `${JSON.stringify(build)}\n`)
  fs.writeFileSync(fixturePath, `${JSON.stringify(prepared)}\n`)
  const receipt = seal({
    schema: 'fsusblog.runtime-observation-probe.v1',
    kind: 'route-response-error',
    producerId: 'production-correctness-scheduler',
    sourceState: {
      sourceCommit: commit,
      worktreeFingerprint: `sha256:${fingerprint}`,
      runId,
      attemptId: 'attempt-1',
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
    facts: routeFacts(),
    terminalStatus: 'verified'
  })
  fs.writeFileSync(probePath, `${JSON.stringify(receipt)}\n`)
  return { receipt, build, directory, buildPath, fixturePath, probePath, relative }
}

function candidatePlan(value)
{
  const registry = loadPostRuntimeProducerRegistry(root)
  const producer = registry.producers[0]
  const observations = Object.entries(registry.observationClasses).sort(([left], [right]) => left.localeCompare(right))
    .map(([classId, definition]) => ({
      classId,
      schema: definition.schema,
      receiptPath: value.relative(path.join(value.directory, `${classId}-raw.json`)),
      requiredModes: Object.entries(producer.requiredObservations)
        .filter(([, classes]) => classes.includes(classId)).map(([mode]) => mode).sort()
    }))
  const plan = seal({
    schema: 'fsusblog.post-runtime-candidate-plan.v1',
    producerId: producer.producerId,
    sourceState: { commit, worktreeFingerprint: `sha256:${fingerprint}` },
    build: {
      receipt: value.relative(value.buildPath),
      receiptContentDigest: value.build.contentDigest,
      sourceState: value.build.sourceState
    },
    candidate: {
      candidateId: 'candidate-1', runId, attemptId: 'attempt-1', fixtureId: 'fixture-1',
      profileId: 'production-fresh', runtimeId: 'runtime-1', browserId: 'browser-1',
      releaseId: 'release-1', rolloutId: 'rollout-1'
    },
    preRuntimeReceiptDigest: digest('8'),
    acceptedClaimsReceiptDigest: digest('9'),
    observations,
    status: 'planned'
  })
  const planPath = path.join(value.directory, 'candidate-plan.json')
  fs.writeFileSync(planPath, `${JSON.stringify(plan)}\n`)
  return { plan, planPath }
}

test('probe verifier reopens exact current-run dependencies', (context) =>
{
  const value = fixture(context)
  assert.equal(verifyReceipt(value.receipt).terminalStatus, 'verified')
})

test('probe verifier rejects stale dependency bytes', (context) =>
{
  const value = fixture(context)
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
  assert.equal(raw.sourceState.runtimeId, 'runtime-1')
  assert.equal(raw.sourceState.attemptId, 'attempt-1')
  assert.equal(raw.sourceState.schemaIdentity, 'fsusblog.observation.route-response-error.v1')
  assert.equal(raw.sourceState.sourceReceiptSchemaIdentity, 'fsusblog.runtime-observation-probe.v1')
  assert.match(raw.sourceState.toolchainIdentity, /^sha256:[a-f0-9]{64}$/u)
  assert.equal(raw.semanticFacts.protocolIdentity, 'aeds-v2')
  assert.equal(raw.semanticFacts.semanticMatch, true)
})

test('production correctness wires probes after current backend identity checks', () =>
{
  const lane = fs.readFileSync(path.join(root, 'tools/test/lanes/runtime-observation-probes.sh'), 'utf8')
  const scheduler = fs.readFileSync(path.join(root, 'tools/test/lanes/production-correctness-receipt.sh'), 'utf8')
  assert.match(lane, /backend PID start-time identity changed/u)
  assert.match(lane, /backend process belongs to another worktree/u)
  assert.match(lane, /Jwt__SecretKey=\*\|Jwt__KeyVersion=\*\|Jwt__Issuer=\*\|Jwt__Audience=\*/u)
  assert.doesNotMatch(lane, /env\s*>|printenv/u)
  const probeOffset = scheduler.indexOf('runtime-observation-probes.sh')
  const receiptOffset = scheduler.indexOf('create-correctness')
  assert.ok(probeOffset >= 0 && receiptOffset > probeOffset)
})

test('raw projector rejects a probe from another attempt', (context) =>
{
  const value = fixture(context)
  const plan = candidatePlan(value)
  const mismatched = seal({ ...value.receipt, contentDigest: undefined,
    sourceState: { ...value.receipt.sourceState, attemptId: 'attempt-2' } })
  fs.writeFileSync(value.probePath, `${JSON.stringify(mismatched)}\n`)
  assert.throws(() => projectProbeRaw({
    candidatePlan: value.relative(plan.planPath),
    probeReceipt: value.relative(value.probePath),
    repositoryRoot: root
  }), /probe, build, and candidate plan identities do not exact-match/u)
})

test('route probe facts reject partial and mismatched semantic relations', () =>
{
  const partial = routeFacts()
  partial.cases.pop()
  assert.throws(() => verifyFacts('route-response-error', partial), /exact real request closure/u)

  const mismatched = routeFacts()
  mismatched.cases.find((entry) => entry.id === 'user-admin-denied').status = 200
  assert.throws(() => verifyFacts('route-response-error', mismatched), /role\/auth\/visibility\/cache relations/u)
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
