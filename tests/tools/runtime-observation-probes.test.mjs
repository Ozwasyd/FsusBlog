import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { observationSourceState, seal } from '../../tools/fact-extractors/post-runtime/adapter.mjs'
import { digestValue } from '../../tools/fact-extractors/lib/canonicalize.mjs'
import { projectProbeRaw, verifyProjectedRaw } from '../../tools/test-evidence/runtime-observation-raw.mjs'
import { verifyReceipt } from '../../tools/test-evidence/runtime-observation-probes.mjs'
import { deriveProbeRawFacts } from '../../tools/test-evidence/runtime-observation-probe-facts.mjs'
import { loadPostRuntimeProducerRegistry, root } from '../../tools/test-matrix/post-runtime-producer-registry.mjs'
import { createPostRuntimeCandidateFixture } from './support/post-runtime-candidate-fixture.mjs'
import {
  createCanonicalPreparedFixture,
  createCanonicalProbeFixtureFacts
} from './support/canonical-post-runtime-source-fixture.mjs'

const runId = 'runtime-observation-test'
const fileDigest = (file) => `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`

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
  const prepared = createCanonicalPreparedFixture({
    sourceCommit: commit,
    worktreeFingerprint: fingerprint,
    profileId: 'acceptance-representative',
    runId
  })
  fs.writeFileSync(fixturePath, `${JSON.stringify(prepared, null, 2)}\n`)
  const { facts } = createCanonicalProbeFixtureFacts('route-response-error', {
    prepareState: prepared,
    prepareStateDigest: fileDigest(fixturePath),
    releaseId: candidate.plan.candidate.releaseId
  })
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
  fs.writeFileSync(probePath, `${JSON.stringify(receipt, null, 2)}\n`)
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
  assert.throws(() => verifyReceipt(value.receipt), /dependency digest\/schema mismatch/u)
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
  assert.deepEqual(raw.semanticFacts.protocolIdentity, {
    contentType: 'application/octet-stream',
    decodeError: null,
    frameEncoding: null,
    frameVersion: '2'
  })
  assert.notEqual(raw.semanticFacts.semanticMatch, false)
})

test('raw projector rejects a probe from another attempt', (context) =>
{
  const value = fixture(context)
  const plan = candidatePlan(value)
  const mismatched = seal({ ...value.receipt, contentDigest: undefined,
    sourceState: { ...value.receipt.sourceState, attemptId: 'attempt-0002' } })
  fs.writeFileSync(value.probePath, `${JSON.stringify(mismatched, null, 2)}\n`)
  assert.throws(() => projectProbeRaw({
    candidatePlan: value.relative(plan.planPath),
    probeReceipt: value.relative(value.probePath),
    repositoryRoot: root
  }), /(?:probe raw facts, source identity, tool or commands do not replay|probe, build, and candidate plan identities do not exact-match)/u)
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
  fs.writeFileSync(relocated, `${JSON.stringify(raw, null, 2)}\n`)
  assert.throws(() => verifyProjectedRaw(
    value.relative(relocated), root, value.relative(plan.planPath)), /path does not exact-match candidate plan/u)
})
