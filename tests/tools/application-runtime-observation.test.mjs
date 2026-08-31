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
  seal,
  validateAcceptedClaims,
  validateCandidatePlan
} from '../../tools/fact-extractors/post-runtime/adapter.mjs'
import { produceApplicationRuntimeObservation } from '../../tools/fact-extractors/post-runtime/application-runtime.mjs'
import { produceReleaseDeploymentObservation } from '../../tools/fact-extractors/post-runtime/release-deployment.mjs'
import { root } from '../../tools/test-matrix/post-runtime-producer-registry.mjs'

const commit = resolveSourceCommit(root)
const fingerprint = resolveWorktreeFingerprint(root)
const classIds = [
  'aot-spa-hydration', 'blue-green-containment', 'browser-behavior-contract',
  'cache-search-outbox-convergence', 'release-identity-readiness',
  'route-response-error', 'session-cookie-runtime'
]
const digest = (value) => `sha256:${String(value).repeat(64).slice(0, 64)}`

function semanticFacts(classId)
{
  if (classId === 'route-response-error') return {
    statusCode: 404, typedResult: 'typed-error', protocolIdentity: 'aeds-v2', contentIdentity: 'missing-article',
    authSemantics: 'anonymous', permissionSemantics: 'public', visibilitySemantics: 'not-found',
    cacheSemantics: 'not-cacheable', semanticMatch: true
  }
  if (classId === 'aot-spa-hydration') return {
    buildDigest: digest('1'), manifestDigest: digest('2'), publicationDigest: digest('3'),
    localeCanaryDigest: digest('4'), dataCanaryDigest: digest('5'), serverHtmlDigest: digest('6'),
    hydratedDomDigest: digest('7'), clientStateDigest: digest('8'), networkResourceDigest: digest('9'), coherent: true
  }
  if (classId === 'cache-search-outbox-convergence') return {
    authorityCoordinateDigest: digest('1'), eventDigest: digest('2'), edgeDigest: digest('3'),
    generationDigest: digest('4'), queryDigest: digest('5'), readModelDigest: digest('6'),
    outputDigest: digest('7'), terminalReceiptDigest: digest('8'), terminalState: 'converged', coherent: true
  }
  if (classId === 'session-cookie-runtime') return {
    databaseSessionDigest: digest('1'), credentialDigest: digest('2'), authContextDigest: digest('3'),
    jwtDigest: digest('4'), cookieDigest: digest('5'), storageClaimsDigest: digest('6'), expiryDigest: digest('7'),
    revisionDigest: digest('8'), deviceDigest: digest('9'), serviceResultDigest: digest('a'), coherent: true
  }
  if (classId === 'browser-behavior-contract') return {
    requiredTestIds: ['article-route'], viewportId: 'desktop', themeId: 'light', stateId: 'loaded',
    interactionDigest: digest('1'), domDigest: digest('2'), a11yDigest: digest('3'),
    networkDigest: digest('4'), consoleDigest: digest('5'), contractSatisfied: true, consoleClean: true,
    screenshotOnly: false
  }
  if (classId === 'release-identity-readiness') return {
    imageDigest: digest('1'), packageDigest: digest('2'), configDigest: digest('3'), schemaDigest: digest('4'),
    manifestDigest: digest('5'), signingDigest: digest('6'), trustDigest: digest('7'), readinessReceiptDigest: digest('8'),
    serviceReady: true, routeDataReady: true, cacheReady: true, dependenciesReady: true, versionReady: true,
    credentialReady: true, identityMatch: true, runtimeRoleContractSatisfied: true, monolithicOwnershipSatisfied: true
  }
  return {
    activeBeforeDigest: digest('1'), standbyBeforeDigest: digest('2'), activeAfterDigest: digest('3'),
    standbyAfterDigest: digest('4'), promotionReceiptDigest: digest('5'), switchReceiptDigest: digest('6'),
    healthReceiptDigest: digest('7'), rollbackReceiptDigest: digest('8'), failureReceiptDigest: digest('9'),
    trafficOwnershipDigest: digest('a'), artifactContainmentDigest: digest('b'), volumeContainmentDigest: digest('c'),
    schemaContainmentDigest: digest('d'), processContainmentDigest: digest('e'), cleanupReceiptDigest: digest('f'),
    terminalReceiptDigest: digest('0'), activeReleaseProtected: true, activeIdentityKnown: true, switchComplete: true,
    splitBrainAbsent: true, cleanupInactiveOnly: true, sharedFactsPreserved: true, runtimeRoleContractSatisfied: true
  }
}

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
  const relative = (name) => path.relative(root, path.join(directory, name)).replaceAll(path.sep, '/')
  const write = (name, value) => fs.writeFileSync(path.join(directory, name), `${JSON.stringify(value)}\n`)
  const ledger = JSON.parse(fs.readFileSync(path.join(root, 'config/contracts/document-claim-migration-ledger.json'), 'utf8'))
  const terminal = globalSeal({
    schema: 'fsusblog.global-claim-exactness-terminal-receipt.v1', scopeId: 'global-document-claim-exactness',
    source: { sourceCommit: commit, worktreeFingerprint: fingerprint, catalogDigest: '1'.repeat(64),
      migrationLedgerDigest: digestValue(ledger), sectionCatalogDigest: '2'.repeat(64), observationDigests: {} },
    authorityDigests: [], counts: { requiredBehaviors: 10, scopes: 6, ledgerEntries: 10,
      generatedClaimCount: 1, proseClaimCount: 1, proseTotal: 1, proseVerified: 1,
      generatedSectionsVerified: 1, generatedSectionDrifts: 0, missing: 0, extra: 0,
      residue: 0, mutationKilled: 1, mutationTotal: 1, warnings: 0 },
    mutationAggregate: { killed: 1, total: 1 }, residue: [], proseVerification: {},
    status: 'ok', failureReasons: []
  })
  write('terminal.json', terminal)
  const claims = produceAcceptedClaims({ terminalReceipt: relative('terminal.json'), repositoryRoot: root })
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
  const contextReceipt = produceCandidateContext({
    preRuntimeReceipt: relative('pre.json'),
    runId: 'run-0001',
    attemptId: 'attempt-0001',
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
  for (const classId of classIds)
  {
    const modes = Object.entries(producer.requiredObservations).filter(([, ids]) => ids.includes(classId)).map(([mode]) => mode).sort()
    const identity = { sourceCommit: plan.sourceState.commit, worktreeFingerprint: plan.sourceState.worktreeFingerprint,
      buildIdentity: plan.build.receiptContentDigest, candidateId: plan.candidate.candidateId,
      runId: plan.candidate.runId, browserIdentity: plan.candidate.browserId,
      releaseId: plan.candidate.releaseId, rolloutId: plan.candidate.rolloutId,
      artifactDigest: digest('f'), slot: 'standby' }
    write(`${classId}-source.json`, seal({ schema: `fsusblog.${classId}.source.v1`, classId, status: 'passed' }))
    const result = seal({ schema: registry.observationClasses[classId].schema,
      producerId: producer.producerId, toolVersion: producer.toolVersion, sourceState: identity, executionClass: 'correctness',
      evidenceClass: 'correctness', qualificationEligible: true, planned: true, executed: true,
      outcome: 'passed', recovered: false, modes,
      terminal: { timeout: false, cancelled: false, processTreeTerminated: false, priorAttemptDigest: null },
      semanticFacts: semanticFacts(classId), candidatePlanRef: ref('plan.json'),
      sourceReceiptRef: ref(`${classId}-source.json`), canonicalRerunCommand: `run ${classId}`,
      independentVerifyCommand: `verify ${classId}` })
    write(`${classId}.json`, result)
    classReceipts[classId] = produceClassReceipt({ candidatePlan: relative('plan.json'), classId,
      result: paths[classId], repositoryRoot: root })
    write(`${classId}-receipt.json`, classReceipts[classId])
  }
  return { relative, classReceipts }
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
})

test('class producer rejects existence-only and cross-plan results', (context) =>
{
  const value = fixture(context)
  const badPath = value.relative('route-response-error.json')
  const raw = JSON.parse(fs.readFileSync(path.join(root, badPath), 'utf8'))
  raw.semanticFacts = { exact: true }
  fs.writeFileSync(path.join(root, badPath), `${JSON.stringify(seal(raw))}\n`)
  assert.throws(() => produceClassReceipt({ candidatePlan: value.relative('plan.json'), classId: 'route-response-error',
    result: badPath, repositoryRoot: root }), /unsupported or missing fields/u)
})

test('#2205 accepted-claim CLI produces and independently replays one explicit terminal receipt', (context) =>
{
  const value = fixture(context)
  const cli = path.join(root, 'tools/fact-extractors/post-runtime/current-run.mjs')
  const output = value.relative('accepted-claims-cli.json')
  const produced = spawnSync(process.execPath, [
    cli, 'accepted-claims', '--terminal', value.relative('terminal.json'), '--out', output
  ], { cwd: root, encoding: 'utf8' })
  assert.equal(produced.status, 0, produced.stderr)
  assert.match(produced.stdout, /accepted-claims status=accepted/u)

  const verified = spawnSync(process.execPath, [
    cli, 'verify-accepted-claims', '--receipt', output
  ], { cwd: root, encoding: 'utf8' })
  assert.equal(verified.status, 0, verified.stderr)
  assert.match(verified.stdout, /verify-accepted-claims status=accepted/u)
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
  const realDirectory = path.join(root, value.relative('terminal-authority'))
  fs.mkdirSync(realDirectory)
  const realTerminal = path.join(realDirectory, 'terminal.json')
  fs.copyFileSync(path.join(root, value.relative('terminal.json')), realTerminal)
  const linkDirectory = path.join(root, value.relative('terminal-link'))
  fs.symlinkSync(realDirectory, linkDirectory)
  const claims = structuredClone(JSON.parse(fs.readFileSync(path.join(root, value.relative('claims.json')), 'utf8')))
  claims.terminalReceiptRef.path = path.relative(root, path.join(linkDirectory, 'terminal.json')).replaceAll(path.sep, '/')
  claims.contentDigest = null
  const resealed = seal(claims)
  assert.throws(() => validateAcceptedClaims(resealed, { repositoryRoot: root }), /canonical|symlink/u)
})
