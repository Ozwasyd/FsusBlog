import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { createProductionBuildReceipt } from '../../tools/ci/production-build-artifacts.mjs'
import { BehaviorId } from '../../tools/contracts/behavior-contract-catalog.mjs'
import { digestValue } from '../../tools/fact-extractors/lib/canonicalize.mjs'
import { resolveSourceCommit, resolveWorktreeFingerprint } from '../../tools/fact-extractors/identity.mjs'
import {
  produceAcceptedClaims,
  produceCandidateContext,
  produceCandidatePlan,
  produceClassReceipt,
  observationSourceState,
  seal,
  validateClassReceipt
} from '../../tools/fact-extractors/post-runtime/adapter.mjs'
import {
  produceApplicationRuntimeObservation,
  validateApplicationRuntimeObservation
} from '../../tools/fact-extractors/post-runtime/application-runtime.mjs'
import {
  produceAotSpaHydrationSourceBundle,
  projectAotSpaHydrationRaw
} from '../../tools/test-evidence/aot-spa-hydration-raw.mjs'
import { projectProbeRaw } from '../../tools/test-evidence/runtime-observation-raw.mjs'
import { sealBrowserContractReceipt } from '../../tools/release/test-evidence-receipts.mjs'
import { root } from '../../tools/test-matrix/post-runtime-producer-registry.mjs'
import {
  beginCurrentRunEvidencePublication,
  createBrowserContractObservationFixture,
  createCanonicalHydrationFixtureObservation,
  createCanonicalPreparedFixture,
  createCanonicalProbeSourceFixture,
  finalizeCurrentRunEvidencePublication
}
  from './support/canonical-post-runtime-source-fixture.mjs'
import { projectBrowserContractRaw } from '../../tools/test-evidence/browser-contract-observation-raw.mjs'

const commit = resolveSourceCommit(root)
const fingerprint = resolveWorktreeFingerprint(root)
const classIds = [
  'aot-spa-hydration', 'blue-green-containment', 'browser-behavior-contract',
  'cache-search-outbox-convergence', 'release-identity-readiness',
  'route-response-error', 'session-cookie-runtime'
]
const applicationClassIds = [
  'aot-spa-hydration', 'browser-behavior-contract',
  'cache-search-outbox-convergence', 'route-response-error',
  'session-cookie-runtime'
]
const digest = (value) => `sha256:${String(value).repeat(64).slice(0, 64)}`
const fileDigest = (file) => `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`

function globalSeal(value)
{
  const receipt = { ...value, contentDigest: null }
  receipt.contentDigest = digestValue(receipt)
  return receipt
}

function fixture(context, { includeObservations = true } = {})
{
  const directory = fs.mkdtempSync(path.join(root, '.tmp', 'post-runtime-current-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const runId = path.basename(directory)
  const registry = JSON.parse(fs.readFileSync(path.join(root,
    'config/testing/post-runtime-producer-registry.json'), 'utf8'))
  const producer = registry.producers.find(({ behaviorId }) =>
    behaviorId === BehaviorId('browserless-production-correctness'))
  assert.ok(producer, 'the fixture requires its registered application producer')
  const authority = registry.receiptSemantics.acceptedTerminalAuthority
  const publicationDirectory = path.join(root, authority.referenceRoot, runId, 'attempt-0001')
  fs.mkdirSync(publicationDirectory, { recursive: true })
  context.after(() => fs.rmSync(path.dirname(publicationDirectory), { recursive: true, force: true }))
  const terminalReference = path.relative(root, path.join(publicationDirectory, authority.referenceName)).replaceAll(path.sep, '/')
  const terminalPayload = path.relative(root, path.join(publicationDirectory, authority.payloadName)).replaceAll(path.sep, '/')
  const relative = (name) => name === 'terminal.json' ? terminalReference
    : path.relative(root, path.join(directory, name)).replaceAll(path.sep, '/')
  const write = (name, value) => {
    const file = path.join(directory, name)
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
    return file
  }
  const ledger = JSON.parse(fs.readFileSync(path.join(root, 'config/contracts/document-claim-migration-ledger.json'), 'utf8'))
  const claimAcceptance = ledger.scopes.flatMap((scope) => scope.entries.flatMap((entry) =>
    entry.claimIds.map((claimId, index) => ({
      claimId, behaviorId: BehaviorId(entry.behaviorId), scopeId: scope.scopeId,
      documentPath: entry.documentPath,
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
  const claims = produceAcceptedClaims({ terminalReceipt: relative('terminal.json'), expectedRunId: runId,
    producerId: producer.producerId, repositoryRoot: root })
  const fixtureBehaviorId = BehaviorId('browserless-production-correctness')
  const pre = seal({
    schema: 'fsusblog.behavior-evidence-pre-runtime-receipt.v1', scope: 'pre-runtime',
    runIdentity: 'run-1', sourceIdentity: { commit, worktreeFingerprint: `sha256:${fingerprint}` },
    buildIdentities: {}, registryDigest: `sha256:${'3'.repeat(64)}`, catalogDigest: `sha256:${'4'.repeat(64)}`,
    staticAdmissionDigest: `sha256:${'5'.repeat(64)}`,
    behaviorGraphDigest: `sha256:${'6'.repeat(64)}`,
    testEvidenceDigests: [`sha256:${'7'.repeat(64)}`],
    rawResultDigests: { testEvidence: `sha256:${'8'.repeat(64)}` },
    mutationEvidenceDigest: null,
    behaviorIds: [BehaviorId(fixtureBehaviorId)],
    requiredTestKinds: { [fixtureBehaviorId]: [] },
    observedTestKinds: { [fixtureBehaviorId]: [] },
    mutationStatus: {
      [fixtureBehaviorId]: {
        behaviorId: BehaviorId(fixtureBehaviorId),
        mutationRequired: false,
        mutationStatus: 'not-applicable',
        qualified: true,
        failures: []
      }
    },
    staticClaimVerificationDigest: '9'.repeat(64),
    missing: [], orphans: [], conflicts: [],
    runtimeCandidateSpawnCountBeforeReceipt: 0, status: 'ok', failureReasons: []
  })
  const artifactRoot = path.join(directory, 'artifact')
  const inputRoot = path.join(directory, 'repository')
  fs.mkdirSync(path.join(artifactRoot, 'frontend-dist', '.vite'), { recursive: true })
  fs.mkdirSync(path.join(inputRoot, 'inputs'), { recursive: true })
  fs.writeFileSync(path.join(artifactRoot, 'frontend-dist', 'index.html'), '<!doctype html>')
  fs.writeFileSync(path.join(artifactRoot, 'frontend-dist', '.vite', 'manifest.json'),
    '{"entry":{"file":"assets/app.js"}}')
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
  const ref = (name) => {
    const relativePath = relative(name)
    const bytes = fs.readFileSync(path.join(root, relativePath))
    const value = JSON.parse(bytes.toString('utf8'))
    return { path: relativePath, fileDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, contentDigest: value.contentDigest ?? null }
  }
  const classReceipts = {}
  context.after(() => fs.rmSync(path.join(root, '.tmp/post-runtime-source-receipts', runId), { recursive: true, force: true }))
  if (!includeObservations) return { relative, classReceipts, runId }
  for (const classId of applicationClassIds)
  {
    if (classId === 'aot-spa-hydration')
    {
      const browserFixture = createBrowserContractObservationFixture(context, {
        directory, commit, worktreeFingerprint: fingerprint, build,
        buildFile: path.join(artifactRoot, 'receipt.json'), plan,
        planFile: path.join(directory, 'plan.json'), observationPaths: paths
      })
      const browser = structuredClone(browserFixture.browser)
      const hydration = browser.scenarios.find(({ id }) => id === 'public-hydration-history-reload')
      hydration.observation = createCanonicalHydrationFixtureObservation(plan.candidate.releaseId)
      const browserFile = write('aot-browser-contract.json', sealBrowserContractReceipt(browser))

      const manifestArtifact = build.artifacts.find(({ path: artifactPath }) =>
        artifactPath.endsWith('frontend-dist/.vite/manifest.json'))
      assert.ok(manifestArtifact, 'AOT fixture requires the immutable frontend manifest')
      const assetRoot = path.join(directory, 'runtime-assets', plan.candidate.releaseId)
      const retainedManifest = path.join(assetRoot, '.vite', 'manifest.json')
      const assetInventory = path.join(assetRoot, 'asset-manifest.json')
      fs.mkdirSync(path.dirname(retainedManifest), { recursive: true })
      fs.copyFileSync(path.join(artifactRoot, manifestArtifact.path), retainedManifest)
      write(path.relative(directory, assetInventory), {
        schema: 'fsusblog.release-assets.v1',
        releaseId: plan.candidate.releaseId,
        slot: 'green',
        frontendBuildId: plan.candidate.releaseId,
        files: [],
        compatibilityFile: null
      })
      const descriptor = seal({
        schema: 'fsusblog.spa-manifest-descriptor.v1',
        releaseId: plan.candidate.releaseId,
        sourceCommit: commit,
        worktreeFingerprint: `sha256:${fingerprint}`,
        buildReceiptDigest: build.contentDigest,
        assetRoot,
        manifestPath: retainedManifest,
        manifestDigest: fileDigest(retainedManifest),
        assetInventoryDigest: fileDigest(assetInventory)
      })
      const descriptorFile = write('aot-manifest-descriptor.json', descriptor)
      const source = produceAotSpaHydrationSourceBundle({
        candidatePlan: relative('plan.json'),
        evidence: {
          manifest: relative(path.basename(descriptorFile)),
          browserContract: relative(path.basename(browserFile))
        },
        repositoryRoot: root
      })
      const sourceFile = write('aot-spa-hydration-source.json', source)
      const result = projectAotSpaHydrationRaw({
        candidatePlan: relative('plan.json'),
        sourceReceipt: relative(path.basename(sourceFile)),
        repositoryRoot: root
      })
      write(`${classId}.json`, result)
      classReceipts[classId] = produceClassReceipt({
        candidatePlan: relative('plan.json'), classId,
        result: paths[classId], repositoryRoot: root
      })
      write(`${classId}-receipt.json`, classReceipts[classId])
      continue
    }
    if (['cache-search-outbox-convergence', 'route-response-error', 'session-cookie-runtime'].includes(classId))
    {
      const definition = registry.observationClasses[classId]
      const identity = {
        sourceCommit: plan.sourceState.commit,
        worktreeFingerprint: plan.sourceState.worktreeFingerprint,
        buildIdentity: plan.build.receiptContentDigest,
        candidateId: plan.candidate.candidateId,
        runId: plan.candidate.runId,
        attemptId: plan.candidate.attemptId,
        fixtureId: plan.candidate.fixtureId,
        profileId: plan.candidate.profileId,
        runtimeId: plan.candidate.runtimeId,
        browserIdentity: plan.candidate.browserId,
        releaseId: plan.candidate.releaseId,
        rolloutId: plan.candidate.rolloutId
      }
      const sourceState = observationSourceState({
        classId, plan, artifactDigest: digest('f'), repositoryRoot: root, legacy: identity
      })
      const prepared = createCanonicalPreparedFixture(sourceState)
      const preparedFile = write(`${classId}-prepared-fixture.json`, prepared)
      const planRef = ref('plan.json')
      const buildRelative = path.relative(root, path.join(artifactRoot, 'receipt.json')).replaceAll(path.sep, '/')
      const { upstream } = createCanonicalProbeSourceFixture(classId, {
        candidatePlan: { relative: planRef.path, fileDigest: planRef.fileDigest, value: plan },
        build: {
          ref: { path: buildRelative, contentDigest: fileDigest(path.join(root, buildRelative)) },
          value: build
        },
        fixture: {
          ref: { path: relative(path.basename(preparedFile)), contentDigest: fileDigest(preparedFile) },
          value: prepared
        },
        output: paths[classId]
      }, { producer, sourceState })
      const sourceFile = write(`${classId}-source.json`, upstream)
      const result = projectProbeRaw({
        candidatePlan: relative('plan.json'),
        probeReceipt: relative(path.basename(sourceFile)),
        repositoryRoot: root
      })
      assert.equal(result.schema, definition.schema)
      write(`${classId}.json`, result)
      classReceipts[classId] = produceClassReceipt({
        candidatePlan: relative('plan.json'), classId,
        result: paths[classId], repositoryRoot: root
      })
      write(`${classId}-receipt.json`, classReceipts[classId])
      continue
    }
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
