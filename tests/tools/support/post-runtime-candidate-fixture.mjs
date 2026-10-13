import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'

import { createProductionBuildReceipt } from '../../../tools/ci/production-build-artifacts.mjs'
import { BehaviorId } from '../../../tools/contracts/behavior-contract-catalog.mjs'
import { digestValue } from '../../../tools/fact-extractors/lib/canonicalize.mjs'
import { resolveSourceCommit, resolveWorktreeFingerprint } from '../../../tools/fact-extractors/identity.mjs'
import {
  produceAcceptedClaims,
  produceCandidateContext,
  produceCandidatePlan,
  seal
} from '../../../tools/fact-extractors/post-runtime/adapter.mjs'
import {
  loadPostRuntimeProducerRegistry,
  root
} from '../../../tools/test-matrix/post-runtime-producer-registry.mjs'
import { loadGlobalDocumentAuthority } from '../../../tools/docs/global-claim-exactness-final.mjs'
import { beginCurrentRunEvidencePublication, finalizeCurrentRunEvidencePublication }
  from '../../../tools/test/current-run-evidence-publication.mjs'

function globalSeal(value)
{
  const receipt = { ...value, contentDigest: null }
  receipt.contentDigest = digestValue(receipt)
  return receipt
}

export function createPostRuntimeCandidateFixture(context, {
  prefix = 'post-runtime-candidate-',
  runId = 'run-focused-0001',
  candidate = {}
} = {})
{
  fs.mkdirSync(path.join(root, '.tmp'), { recursive: true })
  const directory = fs.mkdtempSync(path.join(root, '.tmp', prefix))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  context.after(() => fs.rmSync(
    path.join(root, '.tmp/post-runtime-source-receipts', runId),
    { recursive: true, force: true }
  ))
  const relative = (file) => path.relative(root, file).replaceAll(path.sep, '/')
  const write = (name, value) => {
    const file = path.join(directory, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`)
    return file
  }
  const commit = resolveSourceCommit(root)
  const worktreeFingerprint = resolveWorktreeFingerprint(root)
  const sourceState = { commit, worktreeFingerprint }
  const documentAuthority = loadGlobalDocumentAuthority(root)
  const claimAcceptance = documentAuthority.claimAcceptance
  const summary = documentAuthority.ledgerSummary
  const generatedClaimCount = summary.generatedClaimCount
  // Synthetic consumer envelope; this is not a compiled-observation acceptance receipt.
  const terminal = globalSeal({
    schema: 'fsusblog.global-claim-exactness-terminal-receipt.v1',
    scopeId: 'global-document-claim-exactness',
    runId, claimAcceptance,
    source: {
      sourceCommit: commit,
      worktreeFingerprint,
      ...documentAuthority.documentAuthorityDigests,
      observationDigests: {}
    },
    authorityDigests: [],
    counts: {
      requiredBehaviors: summary.requiredBehaviorCount, scopes: summary.scopeCount, ledgerEntries: summary.entryCount,
      generatedClaimCount, proseClaimCount: claimAcceptance.length - generatedClaimCount, proseTotal: summary.proseClaimCount, proseVerified: summary.proseClaimCount,
      generatedSectionsVerified: generatedClaimCount, generatedSectionDrifts: 0, missing: 0, extra: 0,
      residue: 0, mutationKilled: 1, mutationTotal: 1, warnings: 0
    },
    mutationAggregate: { killed: 1, total: 1 },
    residue: [], proseVerification: {}, status: 'ok', failureReasons: []
  })
  const authority = loadPostRuntimeProducerRegistry(root).receiptSemantics.acceptedTerminalAuthority
  const publicationDirectory = path.join(root, authority.referenceRoot, runId, 'attempt-0001')
  const terminalFile = path.join(publicationDirectory, authority.referenceName)
  const payloadFile = path.join(publicationDirectory, authority.payloadName)
  const terminalBytes = `${JSON.stringify(terminal, null, 2)}\n`
  if (fs.existsSync(terminalFile))
  {
    assert.equal(fs.readFileSync(payloadFile, 'utf8'), terminalBytes,
      'one fixture run cannot reuse a different terminal publication')
  }
  else
  {
    fs.mkdirSync(publicationDirectory, { recursive: true })
    context.after(() => fs.rmSync(path.dirname(publicationDirectory), { recursive: true, force: true }))
    const publicationContext = {
      schema: 'fsusblog.current-run-evidence-context.v1', schedulerRunId: runId, attemptId: 'attempt-0001',
      sourceCommit: commit, worktreeFingerprint: `sha256:${worktreeFingerprint}`,
      candidateIdentity: { id: `${runId}:candidate`, digest: `sha256:${'1'.repeat(64)}` },
      buildIdentity: { id: `${runId}:build`, digest: `sha256:${'2'.repeat(64)}` },
      ownedRoots: [relative(publicationDirectory)]
    }
    publicationContext.contentDigest = `sha256:${digestValue(publicationContext)}`
    const options = { authorityId: authority.authorityId, producerId: authority.producerId,
      context: publicationContext, outputPath: relative(terminalFile), payloadPath: relative(payloadFile), repositoryRoot: root }
    const session = beginCurrentRunEvidencePublication(options)
    fs.writeFileSync(payloadFile, terminalBytes)
    finalizeCurrentRunEvidencePublication({ ...options, sessionId: session.sessionId,
      payloadSchema: terminal.schema, terminalStatus: 'success' })
  }
  const claims = produceAcceptedClaims({ terminalReceipt: relative(terminalFile), expectedRunId: runId, repositoryRoot: root })
  const claimsFile = write('accepted-claims.json', claims)
  const fixtureBehaviorId = BehaviorId('deployment-blue-green-runtime-role')
  const pre = seal({
    schema: 'fsusblog.behavior-evidence-pre-runtime-receipt.v1', scope: 'pre-runtime',
    runIdentity: runId,
    sourceIdentity: { commit, worktreeFingerprint: `sha256:${worktreeFingerprint}` },
    buildIdentities: {}, registryDigest: `sha256:${'3'.repeat(64)}`,
    catalogDigest: `sha256:${'4'.repeat(64)}`,
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
  const preFile = write('pre-runtime.json', pre)
  const artifactRoot = path.join(directory, 'build')
  const inputRoot = path.join(directory, 'repository')
  fs.mkdirSync(path.join(artifactRoot, 'frontend-dist', '.vite'), { recursive: true })
  fs.mkdirSync(path.join(inputRoot, 'inputs'), { recursive: true })
  fs.writeFileSync(path.join(artifactRoot, 'frontend-dist', 'index.html'), '<!doctype html>')
  fs.writeFileSync(path.join(artifactRoot, 'frontend-dist', '.vite', 'manifest.json'),
    '{"entry":{"file":"assets/app.js"}}')
  fs.writeFileSync(path.join(inputRoot, 'inputs', 'input.json'), '{}')
  const build = createProductionBuildReceipt({
    root: inputRoot, artifactRoot, sourceState,
    producer: { workflow: 'focused', runId, runAttempt: 1, job: 'production-build-artifacts' },
    toolchain: { node: '24', npm: '11', dotnet: '10', vite: '7', vitest: '3', playwright: '1', emsdk: '4' },
    inputPaths: ['inputs'], domains: [{ name: 'frontend-dist', path: 'frontend-dist' }]
  })
  const buildFile = path.join(artifactRoot, 'receipt.json')
  const observationSchema = JSON.parse(fs.readFileSync(
    path.join(root, 'config/schemas/post-runtime-observation-result.schema.json'), 'utf8'))
  const typedIdentity = observationSchema.properties?.sourceState?.properties?.runtimeId !== undefined
  const candidateContext = produceCandidateContext({
    preRuntimeReceipt: relative(preFile), runId, attemptId: 'attempt-0001',
    candidate: typedIdentity
      ? {
          ...candidate,
          candidateId: `${runId}:candidate`, runtimeId: `${runId}:runtime`,
          browserId: `${runId}:browser-contract`, fixtureId: `${runId}:fixture`,
          rolloutId: candidate.rolloutId ?? `${runId}-rollout`,
          releaseId: candidate.releaseId ?? `20260830123456-${commit.slice(0, 12)}`
        }
      : candidate,
    repositoryRoot: root
  })
  const contextFile = write('candidate-context.json', candidateContext)
  const registry = loadPostRuntimeProducerRegistry(root)
  const observationPaths = Object.fromEntries(Object.keys(registry.observationClasses)
    .map((classId) => [classId, relative(path.join(directory, `${classId}-raw.json`))]))
  const plan = produceCandidatePlan({
    preRuntimeReceipt: relative(preFile), acceptedClaimsReceipt: relative(claimsFile),
    buildReceipt: relative(buildFile), context: relative(contextFile),
    identityAuthorityDirectory: relative(path.join(directory, 'identity-authorities')),
    observationPaths, repositoryRoot: root
  })
  const planFile = write('candidate-plan.json', plan)
  return {
    directory, relative, write, commit, worktreeFingerprint, sourceState,
    terminal, terminalFile, claims, claimsFile, pre, preFile,
    build, buildFile, artifactRoot, context: candidateContext, contextFile,
    plan, planFile, observationPaths
  }
}
