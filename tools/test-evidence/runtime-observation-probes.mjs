#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  explicitJson as explicitPostRuntimeJson,
  seal,
  observationSourceState,
  validateCandidatePlan,
  writeReceipt
} from '../fact-extractors/post-runtime/adapter.mjs'
import { loadPostRuntimeProducerRegistry } from '../test-matrix/post-runtime-producer-registry.mjs'
import { deriveProbeRawFacts, verifyFacts } from './runtime-observation-probe-facts.mjs'
import { cacheProbe } from './runtime-observation-cache-probe.mjs'
import {
  digest,
  fail,
  fixtureProjection,
  sha
} from './runtime-observation-probe-io.mjs'
import { buildRuntimeObservationProbeReceipt } from './runtime-observation-probe-receipt-contract.mjs'
import { routeProbe } from './runtime-observation-route-probe.mjs'
import { sessionProbe } from './runtime-observation-session-probe.mjs'
export { deriveProbeRawFacts, verifyFacts } from './runtime-observation-probe-facts.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const receiptSchema = 'fsusblog.runtime-observation-probe.v1'
const failureReceiptSchema = 'fsusblog.runtime-observation-probe-failure.v1'
const digestPattern = /^sha256:[a-f0-9]{64}$/u
const probeKinds = new Set(['route-response-error', 'cache-search-outbox-convergence', 'session-cookie-runtime'])

function options(argv)
{
  const parsed = { _: [] }
  for (let index = 0; index < argv.length; index += 1)
  {
    const argument = argv[index]
    if (!argument.startsWith('--'))
    {
      parsed._.push(argument)
      continue
    }
    const key = argument.slice(2)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) fail(`${argument} requires a value`)
    parsed[key] = value
    index += 1
  }
  return parsed
}

function explicitJson(relative, label)
{
  if (typeof relative !== 'string' || !relative.endsWith('.json')) fail(`${label} path is required`)
  const absolute = path.resolve(root, relative)
  if (!absolute.startsWith(`${root}${path.sep}`) || /(?:^|[/\\])(?:latest|history|historical)(?:[/\\]|$)/iu.test(relative))
  {
    fail(`${label} must be an explicit current-run path`)
  }
  const stat = fs.lstatSync(absolute, { throwIfNoEntry: false })
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || fs.realpathSync(absolute) !== absolute)
  {
    fail(`${label} must be a regular non-symlink single-link current-run file`)
  }
  const bytes = fs.readFileSync(absolute)
  return {
    value: JSON.parse(bytes.toString('utf8')),
    ref: {
      path: path.relative(root, absolute).replaceAll(path.sep, '/'),
      contentDigest: sha(bytes)
    }
  }
}

function sourceIdentity(parsed, build, fixture, candidatePlan)
{
  const commit = String(process.env.FSUSBLOG_TEST_SOURCE_COMMIT || parsed['source-commit'] || '')
  const fingerprint = String(process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT || parsed['source-fingerprint'] || '').replace(/^sha256:/u, '')
  const runId = String(process.env.FSUSBLOG_TEST_RUN_ID || parsed['run-id'] || '')
  const attemptId = String(process.env.FSUSBLOG_TEST_ATTEMPT_ID || parsed['attempt-id'] || 'attempt-1')
  if (!/^[a-f0-9]{40}$/u.test(commit) || !/^[a-f0-9]{64}$/u.test(fingerprint) || !runId || !attemptId)
  {
    fail('source commit, worktree fingerprint, run id, and attempt id are required')
  }
  const buildSource = build.value.sourceState ?? {}
  if (buildSource.commit !== commit || String(buildSource.worktreeFingerprint ?? '').replace(/^sha256:/u, '') !== fingerprint)
  {
    fail('production build receipt does not match probe source identity')
  }
  const fixtureSource = fixture.value.plan?.executionIdentity?.sourceIdentity ?? {}
  if (fixtureSource.commit !== commit || String(fixtureSource.worktreeFingerprint ?? '').replace(/^sha256:/u, '') !== fingerprint
    || fixture.value.plan?.executionIdentity?.runId !== runId || fixture.value.terminalState !== 'prepared')
  {
    fail('fixture prepare receipt does not match the prepared current run')
  }
  const plan = candidatePlan.value
  if (plan.sourceState?.commit !== commit
    || plan.sourceState?.worktreeFingerprint !== `sha256:${fingerprint}`
    || plan.candidate?.runId !== runId
    || plan.candidate?.attemptId !== attemptId
    || plan.build?.receiptContentDigest !== build.value.contentDigest)
  {
    fail('candidate plan does not match the live probe run, attempt, source, and build')
  }
  return {
    sourceCommit: commit,
    worktreeFingerprint: `sha256:${fingerprint}`,
    runId,
    attemptId,
    buildIdentity: String(build.value.contentDigest ?? ''),
    fixtureIdentity: fixture.ref.contentDigest,
    candidateId: plan.candidate.candidateId,
    runtimeId: plan.candidate.runtimeId,
    releaseId: plan.candidate.releaseId,
    candidatePlanDigest: plan.contentDigest
  }
}

function configureTemporalFixture(fixture)
{
  const temporal = fixture.value.producerOutputs?.['auth-session']?.temporalArtifacts?.resolvedTemporalRoles
  if (!temporal || temporal.schema !== 'fsusblog.resolved-temporal-roles.v1'
    || !digestPattern.test(String(temporal.contentDigest ?? '')))
  {
    fail('prepared auth-session fixture has no sealed resolved temporal roles')
  }
  process.env.FSUSBLOG_RESOLVED_TEMPORAL_ROLES_JSON = JSON.stringify(temporal)
  process.env.FSUSBLOG_TEMPORAL_ROLE_ARTIFACT_DIGEST = temporal.contentDigest
}

function buildReceipt(kind, context, facts)
{
  const producer = loadPostRuntimeProducerRegistry(root).producers.find((entry) => entry.producerId === context.candidatePlan.value.producerId)
  const sourceState = observationSourceState({ classId: kind, plan: context.candidatePlan.value,
    artifactDigest: digest(facts), repositoryRoot: root })
  return buildRuntimeObservationProbeReceipt(kind, context, facts, { producer, sourceState })
}

function buildFailureReceipt(kind, context, error)
{
  const message = error instanceof Error ? error.message : String(error)
  return seal({
    schema: failureReceiptSchema,
    kind,
    producerId: 'production-correctness-scheduler',
    sourceState: context.identity,
    candidatePlanRef: {
      path: context.candidatePlan.relative,
      fileDigest: context.candidatePlan.fileDigest,
      contentDigest: context.candidatePlan.value.contentDigest,
      schema: context.candidatePlan.value.schema
    },
    buildReceipt: context.build.ref,
    fixtureReceipt: context.fixture.ref,
    provenance: {
      mode: 'local-real-runtime',
      semanticAuthority: 'current-candidate-application-and-owned-services',
      simulatedInfrastructure: ['docker-postgresql', 'docker-redis', 'loopback-network'],
      syntheticSemanticResult: false,
      rerunCommand: `node tools/test-evidence/runtime-observation-probes.mjs probe --kind ${kind} --candidate-plan ${context.candidatePlan.relative} --build ${context.build.ref.path} --fixture ${context.fixture.ref.path} --out <new-current-run-output.json>`
    },
    qualificationEligible: false,
    terminalStatus: 'failed',
    failure: {
      name: error instanceof Error ? error.name : 'Error',
      message: message.slice(0, 2048),
      messageDigest: sha(message)
    }
  })
}


export function verifyReceipt(receipt)
{
  if (receipt?.schema !== receiptSchema || !probeKinds.has(receipt.kind)
    || receipt.producerId !== 'production-correctness-scheduler' || receipt.terminalStatus !== 'verified'
    || receipt.provenance?.syntheticSemanticResult !== false || receipt.provenance?.mode !== 'local-real-runtime')
  {
    fail('probe receipt authority/schema/status mismatch')
  }
  const replay = seal(Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== 'contentDigest')))
  if (receipt.contentDigest !== replay.contentDigest) fail('probe receipt content digest mismatch')
  for (const [reference, schema, role] of [
    [receipt.buildReceipt, 'fsusblog.ci-production-build-receipt.v1', 'production-build'],
    [receipt.fixtureReceipt, 'fsusblog.fixture-prepare-state.v1', 'fixture']
  ])
  {
    const current = explicitJson(reference?.path, 'probe dependency')
    if (Object.keys(reference).sort().join(',') !== 'contentDigest,fileDigest,path,role,schema'
      || reference.schema !== schema || current.value.schema !== schema || reference.role !== role
      || current.ref.contentDigest !== reference.fileDigest
      || (current.value.contentDigest ?? null) !== reference.contentDigest)
    {
      fail(`probe dependency digest/schema mismatch: ${reference?.path}`)
    }
  }
  const build = explicitJson(receipt.buildReceipt.path, 'production build receipt')
  const fixture = explicitJson(receipt.fixtureReceipt.path, 'fixture prepare receipt')
  const source = receipt.sourceState ?? {}
  const buildSource = build.value.sourceState ?? {}
  const fixtureSource = fixture.value.plan?.executionIdentity?.sourceIdentity ?? {}
  if (buildSource.commit !== source.sourceCommit
    || `sha256:${String(buildSource.worktreeFingerprint ?? '').replace(/^sha256:/u, '')}` !== source.worktreeFingerprint
    || build.value.contentDigest !== source.buildIdentity)
  {
    fail('probe build dependency identity mismatch')
  }
  if (fixture.value.terminalState !== 'prepared'
    || fixtureSource.commit !== source.sourceCommit
    || `sha256:${String(fixtureSource.worktreeFingerprint ?? '').replace(/^sha256:/u, '')}` !== source.worktreeFingerprint
    || fixture.value.plan?.executionIdentity?.runId !== source.runId)
  {
    fail('probe fixture dependency identity mismatch')
  }
  const candidatePlanInput = explicitPostRuntimeJson(receipt.candidatePlanRef?.path,
    'probe candidate plan')
  const candidatePlan = validateCandidatePlan(candidatePlanInput.value)
  if (receipt.candidatePlanRef?.fileDigest !== candidatePlanInput.fileDigest
    || receipt.candidatePlanRef?.contentDigest !== candidatePlan.contentDigest
    || receipt.candidatePlanRef?.schema !== candidatePlan.schema
    || receipt.candidatePlanRef?.role !== 'candidate-plan'
    || source.candidateId !== candidatePlan.candidate.candidateId
    || source.runtimeId !== candidatePlan.candidate.runtimeId)
  {
    fail('probe candidate identity does not replay from the candidate plan')
  }
  const producer = loadPostRuntimeProducerRegistry(root).producers.find((entry) => entry.producerId === receipt.producerId)
  const expectedSource = observationSourceState({ classId: receipt.kind, plan: candidatePlan,
    artifactDigest: digest(receipt.facts), repositoryRoot: root })
  if (!producer || receipt.toolVersion !== producer.toolVersion || digest(source) !== digest(expectedSource)
    || receipt.canonicalRerunCommand !== receipt.provenance.rerunCommand
    || receipt.independentVerifyCommand !== `node tools/test-evidence/runtime-observation-raw.mjs verify --candidate-plan ${receipt.candidatePlanRef.path} --receipt ${candidatePlan.observations.find((entry) => entry.classId === receipt.kind).receiptPath}`
    || digest(receipt.rawFacts) !== digest(deriveProbeRawFacts(receipt.kind, receipt.facts)))
  {
    fail('probe raw facts, source identity, tool or commands do not replay')
  }
  verifyFacts(receipt.kind, receipt.facts, { fixture, fixtureProjection: fixtureProjection(fixture),
    expectedReleaseId: candidatePlan.candidate.releaseId })
  return receipt
}

async function main()
{
  const parsed = options(process.argv.slice(2))
  const command = parsed._[0]
  if (command === 'verify')
  {
    const receipt = explicitJson(parsed.receipt, 'probe receipt').value
    verifyReceipt(receipt)
    process.stdout.write(`[runtime-observation-probe] verified kind=${receipt.kind} digest=${receipt.contentDigest}\n`)
    return
  }
  if (command !== 'probe' || !probeKinds.has(parsed.kind)) fail('usage: probe --kind <canonical-kind> ... or verify --receipt <path>')
  const build = explicitJson(parsed.build, 'production build receipt')
  const fixture = explicitJson(parsed.fixture, 'fixture prepare receipt')
  const candidatePlan = explicitPostRuntimeJson(
    process.env.FSUSBLOG_POST_RUNTIME_CANDIDATE_PLAN || parsed['candidate-plan'], 'probe candidate plan')
  validateCandidatePlan(candidatePlan.value)
  configureTemporalFixture(fixture)
  const identity = sourceIdentity(parsed, build, fixture, candidatePlan)
  const context = { build, fixture, candidatePlan, identity, output: parsed.out }
  let facts
  try
  {
    facts = parsed.kind === 'route-response-error'
      ? await routeProbe(context)
      : parsed.kind === 'session-cookie-runtime'
        ? await sessionProbe(context)
        : await cacheProbe(context)
  }
  catch (error)
  {
    const failure = buildFailureReceipt(parsed.kind, context, error)
    writeReceipt(`${parsed.out}.failure.json`, failure, root)
    throw error
  }
  const receipt = buildReceipt(parsed.kind, context, facts)
  writeReceipt(parsed.out, receipt, root)
  verifyReceipt(receipt)
  process.stdout.write(`[runtime-observation-probe] ok kind=${parsed.kind} digest=${receipt.contentDigest}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
    process.exitCode = 1
  })
}
