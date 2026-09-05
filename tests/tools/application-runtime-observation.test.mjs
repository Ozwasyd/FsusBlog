import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { createProductionBuildReceipt } from '../../tools/ci/production-build-artifacts.mjs'
import { digestValue } from '../../tools/fact-extractors/lib/canonicalize.mjs'
import { resolveSourceCommit, resolveWorktreeFingerprint } from '../../tools/fact-extractors/identity.mjs'
import {
  produceAcceptedClaims,
  produceCandidateContext,
  produceCandidatePlan,
  produceClassReceipt,
  observationEnvelopeAuthorityFields,
  observationSourceState,
  observationSourceReceipt,
  seal,
  validateAcceptedClaims,
  validateCandidatePlan,
  validateClassReceipt
} from '../../tools/fact-extractors/post-runtime/adapter.mjs'
import {
  produceApplicationRuntimeObservation,
  validateApplicationRuntimeObservation
} from '../../tools/fact-extractors/post-runtime/application-runtime.mjs'
import {
  produceReleaseDeploymentObservation,
  validateReleaseDeploymentObservation
} from '../../tools/fact-extractors/post-runtime/release-deployment.mjs'
import { root } from '../../tools/test-matrix/post-runtime-producer-registry.mjs'
import { createRunId } from '../../tools/test-matrix/scheduler.mjs'
import { createBrowserContractObservationFixture } from './support/browser-contract-observation-fixture.mjs'
import { projectBrowserContractRaw } from '../../tools/test-evidence/browser-contract-observation-raw.mjs'
import { beginCurrentRunEvidencePublication, finalizeCurrentRunEvidencePublication }
  from '../../tools/test/current-run-evidence-publication.mjs'

const commit = resolveSourceCommit(root)
const fingerprint = resolveWorktreeFingerprint(root)
const classIds = [
  'aot-spa-hydration', 'blue-green-containment', 'browser-behavior-contract',
  'cache-search-outbox-convergence', 'release-identity-readiness',
  'route-response-error', 'session-cookie-runtime'
]
const digest = (value) => `sha256:${String(value).repeat(64).slice(0, 64)}`

function globalSeal(value)
{
  const receipt = { ...value, contentDigest: null }
  receipt.contentDigest = digestValue(receipt)
  return receipt
}

function fixture(context)
{
  const directory = fs.mkdtempSync(path.join(root, '.tmp', 'post-runtime-current-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const runId = path.basename(directory)
  const authority = JSON.parse(fs.readFileSync(path.join(root,
    'config/testing/post-runtime-producer-registry.json'), 'utf8')).receiptSemantics.acceptedTerminalAuthority
  const publicationDirectory = path.join(root, authority.referenceRoot, runId, 'attempt-0001')
  fs.mkdirSync(publicationDirectory, { recursive: true })
  context.after(() => fs.rmSync(path.dirname(publicationDirectory), { recursive: true, force: true }))
  const terminalReference = path.relative(root, path.join(publicationDirectory, authority.referenceName)).replaceAll(path.sep, '/')
  const terminalPayload = path.relative(root, path.join(publicationDirectory, authority.payloadName)).replaceAll(path.sep, '/')
  const relative = (name) => name === 'terminal.json' ? terminalReference
    : path.relative(root, path.join(directory, name)).replaceAll(path.sep, '/')
  const write = (name, value) => fs.writeFileSync(path.join(directory, name), `${JSON.stringify(value, null, 2)}\n`)
  const ledger = JSON.parse(fs.readFileSync(path.join(root, 'config/contracts/document-claim-migration-ledger.json'), 'utf8'))
  const claimAcceptance = ledger.scopes.flatMap((scope) => scope.entries.flatMap((entry) =>
    entry.claimIds.map((claimId, index) => ({
      claimId, behaviorId: entry.behaviorId, scopeId: scope.scopeId, documentPath: entry.documentPath,
      claimType: entry.generatedSectionIds[index] ? 'generated-section' : 'prose',
      generatedSectionId: entry.generatedSectionIds[index] ?? null,
      claimDigest: `sha256:${digestValue({ claimId })}`
    })))).sort((left, right) => left.claimId.localeCompare(right.claimId))
  const generatedClaimCount = claimAcceptance.filter((claim) => claim.claimType === 'generated-section').length
  const terminal = globalSeal({
    schema: 'fsusblog.global-claim-exactness-terminal-receipt.v1', scopeId: 'global-document-claim-exactness',
    runId, claimAcceptance,
    source: { sourceCommit: commit, worktreeFingerprint: fingerprint, catalogDigest: '1'.repeat(64),
      migrationLedgerDigest: digestValue(ledger), sectionCatalogDigest: '2'.repeat(64), observationDigests: {} },
    authorityDigests: [], counts: { requiredBehaviors: 10, scopes: 6, ledgerEntries: 10,
      generatedClaimCount, proseClaimCount: claimAcceptance.length - generatedClaimCount, proseTotal: 1, proseVerified: 1,
      generatedSectionsVerified: 1, generatedSectionDrifts: 0, missing: 0, extra: 0,
      residue: 0, mutationKilled: 1, mutationTotal: 1, warnings: 0 },
    mutationAggregate: { killed: 1, total: 1 }, residue: [], proseVerification: {},
    status: 'ok', failureReasons: []
  })
  const publicationContext = {
    schema: 'fsusblog.current-run-evidence-context.v1', schedulerRunId: runId, attemptId: 'attempt-0001',
    sourceCommit: commit, worktreeFingerprint: `sha256:${fingerprint}`,
    candidateIdentity: { id: `${runId}:candidate`, digest: digest('1') },
    buildIdentity: { id: `${runId}:build`, digest: digest('2') },
    ownedRoots: [path.relative(root, publicationDirectory).replaceAll(path.sep, '/')]
  }
  publicationContext.contentDigest = `sha256:${digestValue(publicationContext)}`
  const publicationOptions = { authorityId: authority.authorityId, producerId: authority.producerId,
    context: publicationContext, outputPath: terminalReference, payloadPath: terminalPayload, repositoryRoot: root }
  const session = beginCurrentRunEvidencePublication(publicationOptions)
  fs.writeFileSync(path.join(root, terminalPayload), `${JSON.stringify(terminal, null, 2)}\n`)
  finalizeCurrentRunEvidencePublication({ ...publicationOptions, sessionId: session.sessionId,
    payloadSchema: terminal.schema, terminalStatus: 'success' })
  const claims = produceAcceptedClaims({ terminalReceipt: relative('terminal.json'), expectedRunId: runId, repositoryRoot: root })
  const pre = seal({
    schema: 'fsusblog.behavior-evidence-pre-runtime-receipt.v1', scope: 'pre-runtime',
    runIdentity: 'run-1', sourceIdentity: { commit, worktreeFingerprint: `sha256:${fingerprint}` },
    buildIdentities: {}, registryDigest: `sha256:${'3'.repeat(64)}`, catalogDigest: `sha256:${'4'.repeat(64)}`,
    staticClaimVerificationDigest: `sha256:${'5'.repeat(64)}`, behaviorIds: [], missing: [], orphans: [],
    conflicts: [], runtimeCandidateSpawnCountBeforeReceipt: 0, status: 'ok', failureReasons: []
  })
  const artifactRoot = path.join(directory, 'artifact')
  const inputRoot = path.join(directory, 'repository')
  fs.mkdirSync(path.join(artifactRoot, 'frontend-dist'), { recursive: true })
  fs.mkdirSync(path.join(inputRoot, 'inputs'), { recursive: true })
  fs.writeFileSync(path.join(artifactRoot, 'frontend-dist', 'index.html'), '<!doctype html>')
  fs.writeFileSync(path.join(inputRoot, 'inputs', 'input.json'), '{}')
  const build = createProductionBuildReceipt({
    root: inputRoot, artifactRoot, sourceState: { commit, worktreeFingerprint: fingerprint },
    producer: { workflow: 'fixture', runId: 'run-1', runAttempt: 1, job: 'production-build-artifacts' },
    toolchain: { node: '24', npm: '11', dotnet: '10', vite: '7', vitest: '3', playwright: '1', emsdk: '4' },
    inputPaths: ['inputs'], domains: [{ name: 'frontend-dist', path: 'frontend-dist' }]
  })
  write('claims.json', claims)
  write('pre.json', pre)
  const observationSchema = JSON.parse(fs.readFileSync(
    path.join(root, 'config/schemas/post-runtime-observation-result.schema.json'), 'utf8'))
  const contextReceipt = produceCandidateContext({
    preRuntimeReceipt: relative('pre.json'),
    runId,
    attemptId: 'attempt-0001',
    candidate: observationSchema.properties?.sourceState?.properties?.runtimeId !== undefined
      ? { releaseId: `20260830123456-${commit.slice(0, 12)}` }
      : {},
    repositoryRoot: root
  })
  write('context.json', contextReceipt)
  const paths = Object.fromEntries(classIds.map((classId) => [classId, relative(`${classId}.json`)]))
  const plan = produceCandidatePlan({ preRuntimeReceipt: relative('pre.json'), acceptedClaimsReceipt: relative('claims.json'),
    buildReceipt: path.relative(root, path.join(artifactRoot, 'receipt.json')).replaceAll(path.sep, '/'),
    context: relative('context.json'), identityAuthorityDirectory: relative('identity-authorities'),
    observationPaths: paths, repositoryRoot: root })
  write('plan.json', plan)
  const registry = JSON.parse(fs.readFileSync(path.join(root, 'config/testing/post-runtime-producer-registry.json'), 'utf8'))
  const producer = registry.producers[0]
  const ref = (name) => {
    const relativePath = relative(name)
    const bytes = fs.readFileSync(path.join(root, relativePath))
    const value = JSON.parse(bytes.toString('utf8'))
    return { path: relativePath, fileDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, contentDigest: value.contentDigest }
  }
  const classReceipts = {}
  context.after(() => fs.rmSync(path.join(root, '.tmp/post-runtime-source-receipts', runId), { recursive: true, force: true }))
  for (const classId of classIds)
  {
    if (classId === 'browser-behavior-contract')
    {
      const browser = createBrowserContractObservationFixture(context, {
        directory, commit, worktreeFingerprint: fingerprint, build,
        buildFile: path.join(artifactRoot, 'receipt.json'), plan,
        planFile: path.join(directory, 'plan.json'), observationPaths: paths
      })
      const result = projectBrowserContractRaw({ candidatePlan: relative('plan.json'),
        browserContractReceipt: browser.relative(browser.browserFile), repositoryRoot: root })
      write(`${classId}.json`, result)
      classReceipts[classId] = produceClassReceipt({ candidatePlan: relative('plan.json'), classId,
        result: paths[classId], repositoryRoot: root })
      write(`${classId}-receipt.json`, classReceipts[classId])
      continue
    }
    const modes = Object.entries(producer.requiredObservations).filter(([, ids]) => ids.includes(classId)).map(([mode]) => mode).sort()
    const definition = registry.observationClasses[classId]
    const identity = { sourceCommit: plan.sourceState.commit, worktreeFingerprint: plan.sourceState.worktreeFingerprint,
      buildIdentity: plan.build.receiptContentDigest, candidateId: plan.candidate.candidateId,
      runId: plan.candidate.runId, browserIdentity: plan.candidate.browserId,
      releaseId: plan.candidate.releaseId, rolloutId: plan.candidate.rolloutId,
      artifactDigest: digest('f'), slot: 'standby' }
    const sourceState = observationSourceState({ classId, plan, artifactDigest: digest('f'), repositoryRoot: root, legacy: identity })
    const rawField = (field) => field.endsWith('Digest') ? field.slice(0, -'Digest'.length) : field
    const rawFacts = Object.fromEntries(definition.requiredSemanticFactFields.map((field) =>
      [rawField(field), field === 'responseStatus' ? 404 : sourceState[field] ?? `${rawField(field)}-raw-value`]))
    const facts = Object.fromEntries(definition.requiredSemanticFactFields.map((field) =>
      [field, field.endsWith('Digest') ? `sha256:${digestValue(rawFacts[rawField(field)])}` : rawFacts[field]]))
    const canonicalRerunCommand = `run ${classId}`
    const independentVerifyCommand = `verify ${classId}`
    const contract = definition.sourceReceipt
    const dependency = (field, referenceContract) => {
      const name = `${classId}-${field.replaceAll('.', '-')}-dependency.json`
      write(name, seal({ schema: referenceContract.schema, sourceState }))
      return { ...ref(name), schema: referenceContract.schema, role: referenceContract.role }
    }
    const upstream = { schema: contract.schema, producerId: producer.producerId, toolVersion: producer.toolVersion,
      sourceState, rawFacts, canonicalRerunCommand, independentVerifyCommand }
    if (contract.discriminator) upstream[contract.discriminator.field] = contract.discriminator.value
    for (const field of contract.requiredReferenceFields)
    {
      upstream[field] = dependency(field, contract.referenceContracts[field])
    }
    if (contract.referenceMap)
    {
      upstream[contract.referenceMap.field] = Object.fromEntries(contract.referenceMap.keys.map((key) => {
        const field = `${contract.referenceMap.field}.${key}`
        return [key, dependency(field, contract.referenceContracts[field])]
      }))
    }
    for (const field of contract.requiredFields)
    {
      if (!(field in upstream) && field !== 'contentDigest') upstream[field] = { fixture: `${classId}-${field}` }
    }
    write(`${classId}-source.json`, seal(upstream))
    const sourceReceiptRef = observationSourceReceipt({ classId, plan, sourceState,
      upstreamRef: { ...ref(`${classId}-source.json`), schema: contract.schema },
      canonicalRerunCommand, independentVerifyCommand, repositoryRoot: root })
    const result = seal({ schema: definition.schema,
      producerId: producer.producerId, toolVersion: producer.toolVersion,
      sourceState,
      executionClass: 'correctness',
      evidenceClass: 'correctness', qualificationEligible: true, planned: true, executed: true,
      outcome: 'passed', recovered: false, modes,
      terminal: { timeout: false, cancelled: false, processTreeTerminated: false, priorAttemptDigest: null },
      semanticFacts: facts,
      ...observationEnvelopeAuthorityFields({ plan, candidatePlanRef: ref('plan.json'), repositoryRoot: root }),
      sourceReceiptRef, canonicalRerunCommand, independentVerifyCommand })
    write(`${classId}.json`, result)
    classReceipts[classId] = produceClassReceipt({ candidatePlan: relative('plan.json'), classId,
      result: paths[classId], repositoryRoot: root })
    write(`${classId}-receipt.json`, classReceipts[classId])
  }
  return { relative, classReceipts, runId }
}

test('current-run application producer binds #2205 claims, one plan, and exact five semantic class receipts', (context) =>
{
  const value = fixture(context)
  const receipt = produceApplicationRuntimeObservation({
    candidatePlan: value.relative('plan.json'), acceptedClaimsReceipt: value.relative('claims.json'),
    classReceipts: ['aot-spa-hydration', 'browser-behavior-contract', 'cache-search-outbox-convergence',
      'route-response-error', 'session-cookie-runtime'].map((id) => value.relative(`${id}-receipt.json`)), repositoryRoot: root
  })
  assert.equal(receipt.status, 'qualified')
  assert.equal(receipt.observations.length, 5)
  assert.equal(receipt.observations.every(({ classReceiptRef }) => classReceiptRef?.role === 'class'), true)
  assert.equal(receipt.observations.every(({ rawResultRef }) => rawResultRef?.role === 'raw-result'), true)
  assert.equal(validateApplicationRuntimeObservation(receipt, { repositoryRoot: root }).contentDigest,
    receipt.contentDigest)
})

test('current-run release producer binds the exact release and deployment class receipts', (context) =>
{
  const value = fixture(context)
  const receipt = produceReleaseDeploymentObservation({
    candidatePlan: value.relative('plan.json'), acceptedClaimsReceipt: value.relative('claims.json'),
    classReceipts: ['blue-green-containment', 'release-identity-readiness']
      .map((id) => value.relative(`${id}-receipt.json`)), repositoryRoot: root
  })
  assert.equal(receipt.status, 'qualified')
  assert.deepEqual(receipt.observations.map(({ classId }) => classId), [
    'blue-green-containment', 'release-identity-readiness'
  ])
  assert.equal(validateReleaseDeploymentObservation(receipt, { repositoryRoot: root }).contentDigest,
    receipt.contentDigest)
})

test('aggregate verifier independently reopens class and raw receipt bytes', (context) =>
{
  const value = fixture(context)
  const receipt = produceApplicationRuntimeObservation({
    candidatePlan: value.relative('plan.json'), acceptedClaimsReceipt: value.relative('claims.json'),
    classReceipts: ['aot-spa-hydration', 'browser-behavior-contract', 'cache-search-outbox-convergence',
      'route-response-error', 'session-cookie-runtime'].map((id) => value.relative(`${id}-receipt.json`)), repositoryRoot: root
  })
  const classPath = path.join(root, receipt.observations[0].classReceiptRef.path)
  fs.appendFileSync(classPath, ' ')
  assert.throws(() => validateApplicationRuntimeObservation(receipt, { repositoryRoot: root }),
    /reference bytes, content, or schema changed/u)
})

test('class receipt is self-contained and rejects byte-only raw result tamper', (context) =>
{
  const value = fixture(context)
  const receipt = value.classReceipts['route-response-error']
  assert.equal(receipt.candidatePlanRef.schema, 'fsusblog.post-runtime-candidate-plan.v1')
  assert.equal(receipt.rawResultRef.role, 'raw-result')
  assert.equal(validateClassReceipt(receipt, { repositoryRoot: root }).contentDigest, receipt.contentDigest)
  fs.appendFileSync(path.join(root, receipt.rawResultRef.path), ' ')
  assert.throws(() => validateClassReceipt(receipt, { repositoryRoot: root }),
    /raw result reference bytes, content, or schema changed/u)
})

test('class receipt verifier rejects a hard-linked raw result authority', (context) =>
{
  const value = fixture(context)
  const receipt = structuredClone(value.classReceipts['route-response-error'])
  const original = path.join(root, receipt.rawResultRef.path)
  const alias = path.join(path.dirname(original), 'route-response-error-hardlink.json')
  fs.linkSync(original, alias)
  assert.throws(() => validateClassReceipt(receipt, { repositoryRoot: root }), /single-link current-run file/u)
})

test('class producer rejects existence-only semantic facts against retained source observations', (context) =>
{
  const value = fixture(context)
  const badPath = value.relative('route-response-error.json')
  const raw = JSON.parse(fs.readFileSync(path.join(root, badPath), 'utf8'))
  raw.semanticFacts = { exact: true }
  fs.writeFileSync(path.join(root, badPath), `${JSON.stringify(seal(raw))}\n`)
  assert.throws(() => produceClassReceipt({ candidatePlan: value.relative('plan.json'), classId: 'route-response-error',
    result: badPath, repositoryRoot: root }), /source receipt raw semantic facts mismatch/u)
})

test('#2205 accepted-claim CLI produces and independently replays one explicit terminal receipt', (context) =>
{
  const value = fixture(context)
  const cli = path.join(root, 'tools/fact-extractors/post-runtime/current-run.mjs')
  const output = value.relative('accepted-claims-cli.json')
  const produced = spawnSync(process.execPath, [
    cli, 'accepted-claims', '--terminal', value.relative('terminal.json'), '--run-id', value.runId, '--out', output
  ], { cwd: root, encoding: 'utf8' })
  assert.equal(produced.status, 0, produced.stderr)
  assert.match(produced.stdout, /accepted-claims status=accepted/u)

  const verified = spawnSync(process.execPath, [
    cli, 'verify-accepted-claims', '--receipt', output, '--run-id', value.runId
  ], { cwd: root, encoding: 'utf8' })
  assert.equal(verified.status, 0, verified.stderr)
  assert.match(verified.stdout, /verify-accepted-claims status=accepted/u)
})

test('accepted-claim adapter refuses payloads and requires an independently supplied current run', (context) =>
{
  const value = fixture(context)
  const terminalReference = JSON.parse(fs.readFileSync(path.join(root, value.relative('terminal.json')), 'utf8'))
  assert.throws(() => produceAcceptedClaims({
    terminalReceipt: terminalReference.payload.path, expectedRunId: value.runId, repositoryRoot: root
  }), /path|payload|reference/u)
  assert.throws(() => produceAcceptedClaims({
    terminalReceipt: value.relative('terminal.json'), repositoryRoot: root
  }), /expected run id is required/u)
  assert.throws(() => produceAcceptedClaims({
    terminalReceipt: value.relative('terminal.json'), expectedRunId: `${value.runId}-other`, repositoryRoot: root
  }), /run/u)
  const claims = JSON.parse(fs.readFileSync(path.join(root, value.relative('claims.json')), 'utf8'))
  assert.throws(() => validateAcceptedClaims(claims, {
    expectedRunId: `${value.runId}-other`, repositoryRoot: root
  }), /run/u)
})

test('candidate plans bind the current registry/schema/tool identity', (context) =>
{
  const value = fixture(context)
  const planPath = path.join(root, value.relative('plan.json'))
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'))
  plan.registryBinding.contentDigest = digest('0')
  fs.writeFileSync(planPath, `${JSON.stringify(seal(plan))}\n`)
  assert.throws(() => produceClassReceipt({
    candidatePlan: value.relative('plan.json'),
    classId: 'route-response-error',
    result: value.relative('route-response-error.json'),
    repositoryRoot: root
  }), /registry\/schema\/tool identity binding mismatch/u)
})

test('candidate context accepts the canonical scheduler run identity', (context) =>
{
  const value = fixture(context)
  const schedulerRunId = createRunId('post-runtime-candidate-plan')
  const receipt = produceCandidateContext({
    preRuntimeReceipt: value.relative('pre.json'),
    runId: schedulerRunId,
    attemptId: 'attempt-0002',
    candidate: { releaseId: `20260830123456-${commit.slice(0, 12)}` },
    repositoryRoot: root
  })
  assert.equal(receipt.candidate.runId, schedulerRunId)
  assert.equal(receipt.candidate.attemptId, 'attempt-0002')
})

test('candidate verifier rejects absolute or noncanonical observation paths', (context) =>
{
  const value = fixture(context)
  const planFile = path.join(root, value.relative('plan.json'))
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'))
  plan.observations[0].receiptPath = path.join(root, '.tmp', 'outside-plan.json')
  assert.throws(() => validateCandidatePlan(seal(plan), { repositoryRoot: root }),
    /canonical repository-relative current-run JSON/u)
})

test('candidate plan rejects non-current-run and duplicate class output paths', (context) =>
{
  for (const [label, mutate, pattern] of [
    ['non-current-run path', (plan) => { plan.observations[0].receiptPath = 'artifacts/result.json' },
      /canonical repository-relative current-run JSON/u],
    ['duplicate output path', (plan) => { plan.observations[1].receiptPath = plan.observations[0].receiptPath },
      /output paths must be exact-one per class/u]
  ])
  {
    const value = fixture(context)
    const plan = JSON.parse(fs.readFileSync(path.join(root, value.relative('plan.json')), 'utf8'))
    mutate(plan)
    assert.throws(() => validateCandidatePlan(seal(plan), { repositoryRoot: root }), pattern, label)
  }
})

test('current-run adapters reject symlinked JSON inputs', (context) =>
{
  const value = fixture(context)
  const link = path.join(root, value.relative('plan-link.json'))
  fs.symlinkSync(path.join(root, value.relative('plan.json')), link)
  assert.throws(() => produceClassReceipt({
    candidatePlan: value.relative('plan-link.json'),
    classId: 'route-response-error',
    result: value.relative('route-response-error.json'),
    repositoryRoot: root
  }), /(?:regular non-symlink current-run file|must not traverse a symlink)/u)
})

test('candidate verifier independently rejects forged source, candidate, and upstream bytes', (context) =>
{
  for (const [label, mutate, pattern] of [
    ['source', (value, plan) => { plan.sourceState.commit = 'f'.repeat(40) }, /upstream replay identity mismatch/u],
    ['candidate', (value, plan) => { plan.candidate.runtimeId = 'forged-runtime' }, /upstream replay identity mismatch/u],
    ['pre-runtime bytes', (value) => { fs.appendFileSync(path.join(root, value.relative('pre.json')), ' ') }, /reference bytes/u],
    ['build bytes', (value) => {
      const file = path.join(root, value.relative('artifact/receipt.json'))
      fs.chmodSync(file, 0o644)
      fs.appendFileSync(file, ' ')
    }, /reference bytes/u]
  ])
  {
    const value = fixture(context)
    const planFile = path.join(root, value.relative('plan.json'))
    const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'))
    mutate(value, plan)
    if (label === 'source' || label === 'candidate') fs.writeFileSync(planFile, `${JSON.stringify(seal(plan))}\n`)
    assert.throws(() => validateCandidatePlan(JSON.parse(fs.readFileSync(planFile, 'utf8')), {
      repositoryRoot: root
    }), pattern, label)
  }
})

test('candidate verifier rejects a tampered typed identity authority', (context) =>
{
  const value = fixture(context)
  const plan = JSON.parse(fs.readFileSync(path.join(root, value.relative('plan.json')), 'utf8'))
  const authorityFile = path.join(root, plan.identityAuthorityRefs.fixture.path)
  const authority = JSON.parse(fs.readFileSync(authorityFile, 'utf8'))
  authority.authorityId = 'forged-fixture'
  fs.writeFileSync(authorityFile, `${JSON.stringify(seal(authority))}\n`)
  assert.throws(() => validateCandidatePlan(plan, { repositoryRoot: root }), /authority bytes or identity mismatch/u)
})

test('#2205 accepted-claim verifier rejects a symlinked ancestor even when leaf bytes are regular', (context) =>
{
  const value = fixture(context)
  const linkDirectory = path.dirname(path.join(root, value.relative('terminal.json')))
  const realDirectory = path.join(root, value.relative('terminal-authority'))
  fs.renameSync(linkDirectory, realDirectory)
  fs.symlinkSync(realDirectory, linkDirectory)
  const claims = structuredClone(JSON.parse(fs.readFileSync(path.join(root, value.relative('claims.json')), 'utf8')))
  assert.throws(() => validateAcceptedClaims(claims, { expectedRunId: value.runId, repositoryRoot: root }), /canonical|symlink/u)
})
