import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createProductionBuildReceipt } from '../../tools/ci/production-build-artifacts.mjs'
import { digestCatalog } from '../../tools/contracts/behavior-contract-catalog.mjs'
import {
    createBrowserlessCorrectnessReceipt,
    sealBrowserContractReceipt
} from '../../tools/release/test-evidence-receipts.mjs'
import {
    joinBehaviorEvidencePostRuntime,
    joinPostRuntimeIdentities,
    postRuntimeObservationPaths,
    validatePostRuntimeReceipt
} from '../../tools/test-matrix/behavior-evidence-post-runtime.mjs'
import { authorityDigest, loadPostRuntimeProducerRegistry } from '../../tools/test-matrix/post-runtime-producer-registry.mjs'

const commit = 'a'.repeat(40)
const worktreeFingerprint = 'b'.repeat(64)
const runId = 'post-runtime-round-1'

test('post-runtime class paths derive only the current registry roster published by the observation bundle', () =>
{
    const registry = loadPostRuntimeProducerRegistry()
    const directory = '.tmp/post-runtime-observations/run-1/attempt-0001'
    const classes = [...new Set(registry.producers.flatMap((producer) => Object.values(producer.requiredObservations).flat()))].sort()
    assert.equal(classes.length, 7)
    assert.deepEqual(postRuntimeObservationPaths(registry, directory), classes.map((classId) => `${directory}/classes/${classId}.json`))
    assert.throws(() => postRuntimeObservationPaths(registry, '.tmp/../other'), /canonical/u)
    const ambiguous = structuredClone(registry)
    ambiguous.producers.push({ ...ambiguous.producers[0], producerId: 'other-owner' })
    assert.throws(() => postRuntimeObservationPaths(ambiguous, directory), /unambiguous/u)
})

function identityInputs()
{
    const context = seal({
        schema: 'fsusblog.current-run-evidence-context.v1',
        schedulerRunId: runId, attemptId: 'attempt-0001', sourceCommit: commit,
        worktreeFingerprint: `sha256:${worktreeFingerprint}`,
        candidateIdentity: { id: `${runId}:candidate`, digest: `sha256:${'5'.repeat(64)}` },
        buildIdentity: { id: 'production-build', digest: `sha256:${'6'.repeat(64)}` },
        ownedRoots: ['artifacts/current-run']
    })
    return {
        executionContext: context,
        preRuntimeReceipt: preRuntime(catalog()),
        observations: [{ sourceState: {
            sourceCommit: commit, worktreeFingerprint: context.worktreeFingerprint,
            runId, attemptId: context.attemptId, candidateId: context.candidateIdentity.id,
            buildIdentity: context.buildIdentity.digest
        } }],
        acceptedClaims: [{ sourceState: {
            commit, worktreeFingerprint: context.worktreeFingerprint, schedulerRunId: runId,
            attemptId: context.attemptId, candidateIdentityDigest: authorityDigest(context.candidateIdentity),
            buildIdentityDigest: authorityDigest(context.buildIdentity)
        } }]
    }
}

test('post-runtime identity join binds all six accepted-claim fields to canonical current-run context', () =>
{
    const input = identityInputs()
    assert.deepEqual(joinPostRuntimeIdentities(input), input.acceptedClaims[0].sourceState)
})

test('post-runtime identity join rejects every independently resealed accepted-claim identity mismatch', () =>
{
    for (const field of ['commit', 'worktreeFingerprint', 'schedulerRunId', 'attemptId', 'candidateIdentityDigest', 'buildIdentityDigest'])
    {
        const input = identityInputs()
        input.acceptedClaims[0].sourceState[field] += '-other'
        assert.throws(() => joinPostRuntimeIdentities(input), new RegExp(`accepted claims ${field}`, 'u'))
    }
})

test('post-runtime identity join rejects cross-candidate observations and stale pre-runtime inputs', () =>
{
    for (const field of ['sourceCommit', 'worktreeFingerprint', 'runId', 'attemptId', 'candidateId', 'buildIdentity'])
    {
        const input = identityInputs()
        input.observations[0].sourceState[field] += '-other'
        assert.throws(() => joinPostRuntimeIdentities(input), new RegExp(`observation ${field}`, 'u'))
    }
    const input = identityInputs()
    input.preRuntimeReceipt = seal({ ...input.preRuntimeReceipt, runIdentity: 'prior-run' })
    assert.throws(() => joinPostRuntimeIdentities(input), /pre-runtime receipt does not match/u)
    for (const field of ['observations', 'acceptedClaims'])
    {
        const empty = identityInputs()
        empty[field] = []
        assert.throws(() => joinPostRuntimeIdentities(empty), /requires observations and accepted claims/u)
    }
})

test('post-runtime input reader rejects symlink hardlink traversal and historical aliases before joining', (context) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-post-runtime-pinned-'))
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    fs.writeFileSync(path.join(directory, 'pre.json'), JSON.stringify(preRuntime(catalog())))
    fs.symlinkSync('pre.json', path.join(directory, 'symlink.json'))
    const inputs = { repositoryRoot: directory, observationReceipts: [], acceptedClaimsReceipts: [] }
    assert.throws(() => joinBehaviorEvidencePostRuntime({ ...inputs, preRuntimeReceipt: 'symlink.json' }), /non-symlink/u)
    assert.throws(() => joinBehaviorEvidencePostRuntime({ ...inputs, preRuntimeReceipt: 'missing/../pre.json' }), /canonical/u)
    assert.throws(() => joinBehaviorEvidencePostRuntime({ ...inputs, preRuntimeReceipt: 'historical/pre.json' }), /current-run/u)
    fs.linkSync(path.join(directory, 'pre.json'), path.join(directory, 'hardlink.json'))
    assert.throws(() => joinBehaviorEvidencePostRuntime({ ...inputs, preRuntimeReceipt: 'pre.json' }), /single-link/u)
})

function joinedReceiptShape()
{
    const registry = loadPostRuntimeProducerRegistry()
    const currentCatalog = JSON.parse(fs.readFileSync(new URL('../../config/contracts/behavior-contracts.json', import.meta.url), 'utf8'))
    const input = identityInputs()
    const producer = registry.producers[0]
    const classes = [...new Set(Object.values(producer.requiredObservations).flat())].sort()
    const results = classes.map((classId, index) => ({
        behaviorId: producer.behaviorId,
        extractorId: currentCatalog.contracts.find((entry) => entry.id === producer.behaviorId).factExtractorId,
        producerId: producer.producerId, classId, status: 'ok',
        contentDigest: authorityDigest({ index })
    }))
    const reference = (name, contentDigest = authorityDigest({ name })) => ({
        ref: `.tmp/current-run/${name}.json`, fileDigest: authorityDigest({ bytes: name }), contentDigest
    })
    return seal({
        schema: 'fsusblog.behavior-evidence-post-runtime-receipt.v1', scope: 'post-runtime',
        runIdentity: runId, sourceIdentity: input.preRuntimeReceipt.sourceIdentity,
        candidateIdentity: {
            ...input.observations[0].sourceState, artifactDigest: authorityDigest({ artifact: 1 }),
            runtimeId: `${runId}:runtime`, browserIdentity: `${runId}:browser-contract`,
            releaseId: '20260830123456-abcdef123456', rolloutId: `${runId}:rollout`,
            fixtureId: `${runId}:fixture`, profileId: 'acceptance-representative'
        },
        executionIdentity: input.acceptedClaims[0].sourceState,
        executionContext: reference('context'), schedulerEvidence: reference('admission'),
        preRuntimeReceiptDigest: input.preRuntimeReceipt.contentDigest,
        registryDigest: authorityDigest(registry), catalogDigest: `sha256:${digestCatalog(currentCatalog)}`,
        behaviorIds: [producer.behaviorId], requiredRuntimeProducers: [producer.producerId],
        requiredProducerClasses: { [producer.producerId]: classes },
        observedProducerClasses: { [producer.producerId]: [...classes] },
        observedBehaviorResults: results,
        documentClaimDigests: Object.fromEntries(producer.acceptedClaimRefs.map((claimId) => [claimId, authorityDigest({ claimId })])),
        documentClaimTerminals: { [producer.behaviorId]: authorityDigest({ terminal: 1 }) },
        observationRefs: results.map((result) => reference(result.classId, result.contentDigest)),
        acceptedClaimRefs: [reference('claims')],
        missing: [], orphans: [], conflicts: [], stale: [], diagnostics: [],
        findingCounts: { missing: 0, orphans: 0, conflicts: 0, stale: 0, diagnostics: 0 },
        releaseFinalSpawnCountBeforeReceipt: 0, status: 'ok', failureReasons: []
    })
}

test('post-runtime receipt shape binds the entire current graph and rejects resealed count class and owner tampering', () =>
{
    const receipt = joinedReceiptShape()
    assert.equal(validatePostRuntimeReceipt(receipt).status, 'ok')
    for (const [mutation, expected] of [
        [(value) => { value.observedBehaviorResults[0].extractorId = 'wrong-owner' }, /ownership mismatch/u],
        [(value) => { value.findingCounts.stale = 1 }, /finding counts/u],
        [(value) => { value.observedProducerClasses[value.requiredRuntimeProducers[0]].pop() }, /producer classes/u],
        [(value) => { value.requiredProducerClasses[value.requiredRuntimeProducers[0]].pop() }, /complete current registry/u],
        [(value) => { value.observationRefs.pop() }, /observation references/u],
        [(value) => { value.candidateIdentity.attemptId = 'attempt-0002' }, /identities do not match/u],
        [(value) => { value.releaseFinalSpawnCountBeforeReceipt = 1 }, /schema validation/u],
        [(value) => { value.unknown = true }, /schema validation/u]
    ])
    {
        const changed = structuredClone(receipt)
        mutation(changed)
        assert.throws(() => validatePostRuntimeReceipt(seal(changed)), expected)
    }
})
const stable = (value) => Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
        : value
const seal = (value) => {
    const receipt = { ...value, contentDigest: null }
    const content = { ...receipt }
    delete content.contentDigest
    receipt.contentDigest = `sha256:${createHash('sha256').update(JSON.stringify(stable(content))).digest('hex')}`
    return receipt
}

function catalog()
{
    return {
        schema: 'fsusblog.behavior-contract-catalog.v1',
        digestAlgorithm: 'sha256',
        canonicalSerialization: 'json-utf8-v1',
        domains: ['testing'],
        extractors: [{ id: 'runtime-facts', path: 'tools/runtime-facts.mjs' }],
        contracts: [{
            id: 'browserless-production-correctness',
            domain: 'testing',
            risk: 'critical',
            status: 'active',
            implementationOwnerCardinality: 'one',
            allowedImplementationOwnerRoles: [],
            factExtractorId: 'runtime-facts',
            requiredTestKinds: ['runtime'],
            documentationPolicy: 'required',
            documentationRationale: 'Candidate behavior must be observed.',
            allowedClaimTypes: ['behavioral'],
            releaseQualification: true,
            evidenceStage: 'post-runtime',
            runtimeEvidence: {
                producerTierId: 'production-correctness',
                observationSchema: 'fsusblog.browserless-correctness-receipt.v1'
            },
            coverageIds: ['production-correctness'],
            documents: ['docs/testing.md']
        }]
    }
}

function preRuntime(behaviorCatalog)
{
    return seal({
        schema: 'fsusblog.behavior-evidence-pre-runtime-receipt.v1',
        scope: 'pre-runtime',
        runIdentity: runId,
        sourceIdentity: { commit, worktreeFingerprint: `sha256:${worktreeFingerprint}` },
        buildIdentities: {},
        registryDigest: `sha256:${'3'.repeat(64)}`,
        catalogDigest: `sha256:${digestCatalog(behaviorCatalog)}`,
        staticClaimVerificationDigest: `sha256:${'c'.repeat(64)}`,
        behaviorIds: [],
        runtimeCandidateSpawnCountBeforeReceipt: 0,
        status: 'ok',
        failureReasons: []
    })
}

function candidateFixture(context)
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-post-runtime-'))
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const repositoryRoot = path.join(directory, 'repo')
    const artifactRoot = path.join(directory, 'build')
    fs.mkdirSync(path.join(repositoryRoot, 'inputs'), { recursive: true })
    fs.mkdirSync(path.join(artifactRoot, 'frontend-dist'), { recursive: true })
    fs.writeFileSync(path.join(repositoryRoot, 'inputs', 'lock.json'), '{}\n')
    fs.writeFileSync(path.join(artifactRoot, 'frontend-dist', 'index.html'), '<!doctype html>\n')
    const sourceState = { commit, worktreeFingerprint }
    const build = createProductionBuildReceipt({
        root: repositoryRoot,
        artifactRoot,
        sourceState,
        producer: { workflow: 'fixture', runId, runAttempt: 1, job: 'production-build-artifacts' },
        toolchain: {
            node: 'v24.0.0', npm: '11.0.0', dotnet: '10.0.100', vite: '7.0.0',
            vitest: '3.0.0', playwright: '1.55.0', emsdk: '4.0.0'
        },
        inputPaths: ['inputs'],
        domains: [{ name: 'frontend-dist', path: 'frontend-dist' }],
        now: () => new Date('2026-08-27T00:00:00.000Z')
    })
    const correctness = createBrowserlessCorrectnessReceipt({
        matrix: { tiers: [{ id: 'production-correctness', dependsOn: [], requiresPlaywright: 'none' }] },
        buildReceipt: build,
        buildReceiptPath: 'build/receipt.json',
        jobSummaries: [{
            schema: 'fsusblog.ci.job-result.v1',
            jobId: 'production-correctness',
            status: 'success',
            evidenceClass: 'correctness',
            affectsCorrectness: true,
            commit,
            tierIds: ['production-correctness'],
            testIds: ['tier:production-correctness'],
            schedulerRunId: runId
        }],
        authority: { kind: 'scheduler-checkpoint', status: 'success', runId, authoritative: true },
        now: () => new Date('2026-08-27T00:01:00.000Z')
    })
    const browserPlan = seal({
        schema: 'fsusblog.playwright-browser-identity.v1',
        executionClass: 'correctness', evidenceClass: 'browser-contract',
        qualificationEligible: true, managedExecutable: true,
        browserName: 'chromium', browserVersion: '140.0.0', revision: '123456',
        executablePath: '/managed/chromium-123456/chrome',
        executableSha256: `sha256:${'f'.repeat(64)}`,
        playwright: { package: '@playwright/test', version: '1.59.1' },
        launchOptions: { headless: true, executablePath: '/managed/chromium-123456/chrome', args: [] },
        rendering: {
            fontSetDigest: `sha256:${'1'.repeat(64)}`,
            localeDataDigest: `sha256:${'2'.repeat(64)}`,
            locale: 'zh-CN', deviceScaleFactor: 1, renderingMode: 'headless',
            colorScheme: 'light', gpuMode: 'software'
        }
    })
    const browserActual = seal({
        ...structuredClone(browserPlan),
        schema: 'fsusblog.playwright-browser-actual.v1',
        planDigest: browserPlan.contentDigest,
        renderingObservation: {
            locale: 'zh-CN', deviceScaleFactor: 1, colorScheme: 'light',
            renderer: 'SwiftShader fixture renderer'
        }
    })
    const browserContract = sealBrowserContractReceipt({
        schema: 'fsusblog.browser-contract-receipt.v2',
        status: 'success',
        classification: 'clean',
        runIdentity: { runId },
        sourceState,
        build: {
            receipt: 'build/receipt.json',
            receiptContentDigest: build.contentDigest,
            sourceState,
            profile: build.build.profile
        },
        fixture: { namespace: 'browser-contract-post-runtime' },
        playwright: {
            chromiumRevision: '123456', chromiumVersion: '140.0.0',
            browserIdentity: { plan: browserPlan, actual: browserActual }
        },
        topology: {
            runner: 'playwright-library', browserType: 'chromium', managedBrowser: true,
            workerPool: false, shard: null, retries: 0, browserLaunchCount: 1,
            maxConcurrentBrowserRoots: 1, contextCount: 1
        },
        scenarios: [{ id: 'runtime-contract', status: 'success', classification: 'clean', issues: [], artifacts: [] }],
        publicPreview: {
            schema: 'fsusblog.public-preview-screenshot-verification.v1',
            status: 'ok',
            sourceCommit: commit,
            releaseId: `20260827000000-${commit.slice(0, 12)}`,
            manifestSchema: 'fsusblog.public-preview-screenshot-manifest.v1',
            visualInputDigest: 'c'.repeat(64),
            runtimeAudit: true,
            layoutAudit: true,
            sanitizationCheck: true,
            images: Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`screenshot-${index + 1}`, `${index + 1}`.repeat(64)])),
            differences: [],
            commandVersion: 'd'.repeat(64),
            captureContextCount: 9,
            evidencePath: '.tmp/release-evidence/public-preview-screenshots.json',
            evidenceFileDigest: `sha256:${'e'.repeat(64)}`
        },
        startedAt: '2026-08-27T00:00:00.000Z',
        finishedAt: '2026-08-27T00:00:01.000Z',
        wallClockMs: 1_000,
        error: null
    })
    return { build, correctness, browserContract }
}

test('post-runtime join rejects the retired pre/runtime/browser fixture-only input shape', (context) =>
{
    const behaviorCatalog = catalog()
    const candidate = candidateFixture(context)
    assert.throws(() => joinBehaviorEvidencePostRuntime({
        preRuntimeReceipt: preRuntime(behaviorCatalog),
        catalog: behaviorCatalog,
        browserContractReceipt: candidate.browserContract,
        runtimeEvidenceReceipts: [candidate.correctness]
    }), /legacy or unknown/u)
})

test('HTTP 200, diagnostic browser evidence, stale candidate and missing browser cannot qualify', (context) =>
{
    const behaviorCatalog = catalog()
    const pre = preRuntime(behaviorCatalog)
    const candidate = candidateFixture(context)
    const cases = [
        {
            name: 'HTTP 200 only',
            browserContractReceipt: candidate.browserContract,
            runtimeEvidenceReceipts: [{ schema: 'fsusblog.browserless-correctness-receipt.v1', httpStatus: 200 }]
        },
        {
            name: 'diagnostic browser receipt',
            browserContractReceipt: { schema: 'fsusblog.browser-diagnostics-receipt.v1', status: 'success' },
            runtimeEvidenceReceipts: [candidate.correctness]
        },
        {
            name: 'stale candidate',
            browserContractReceipt: candidate.browserContract,
            runtimeEvidenceReceipts: [{ ...candidate.correctness, sourceState: { ...candidate.correctness.sourceState, commit: 'd'.repeat(40) } }]
        },
        {
            name: 'missing browser contract',
            runtimeEvidenceReceipts: [candidate.correctness]
        }
    ]
    for (const scenario of cases)
    {
        assert.throws(() => joinBehaviorEvidencePostRuntime({ preRuntimeReceipt: pre, catalog: behaviorCatalog, ...scenario }), /legacy or unknown/u, scenario.name)
    }
})

test('post-runtime join rejects caller-reported release-final spawn counts including zero', (context) =>
{
    const behaviorCatalog = catalog()
    const candidate = candidateFixture(context)
    for (const count of [0, 1]) assert.throws(() => joinBehaviorEvidencePostRuntime({
        preRuntimeReceipt: preRuntime(behaviorCatalog),
        catalog: behaviorCatalog,
        browserContractReceipt: candidate.browserContract,
        runtimeEvidenceReceipts: [candidate.correctness],
        releaseFinalSpawnCountBeforeReceipt: count
    }), /legacy or unknown/u)
})
