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
    validatePostRuntimeObservationInputs,
    validatePostRuntimeClaimInputs,
    validatePostRuntimeReceipt
} from '../../tools/test-matrix/behavior-evidence-post-runtime.mjs'
import { loadPostRuntimeProducerRegistry } from '../../tools/test-matrix/post-runtime-producer-registry.mjs'

const commit = 'a'.repeat(40)
const worktreeFingerprint = 'b'.repeat(64)
const runId = 'post-runtime-round-1'

function currentObservationInputs()
{
    const registry = loadPostRuntimeProducerRegistry()
    const currentCatalog = JSON.parse(fs.readFileSync(new URL('../../config/contracts/behavior-contracts.json', import.meta.url), 'utf8'))
    const observations = registry.producers.flatMap((producer) =>
        [...new Set(Object.values(producer.requiredObservations).flat())].map((classId) => seal({
            schema: registry.observationClasses[classId].schema,
            producerId: producer.producerId,
            toolVersion: producer.toolVersion,
            sourceState: {
                sourceCommit: commit, worktreeFingerprint: `sha256:${worktreeFingerprint}`,
                buildIdentity: 'build-1', candidateId: 'candidate-1', artifactDigest: `sha256:${'4'.repeat(64)}`,
                runId, browserIdentity: 'browser-1', releaseId: 'release-1', slot: 'blue', rolloutId: 'rollout-1'
            },
            executionClass: 'correctness', evidenceClass: 'correctness', qualificationEligible: true,
            planned: true, executed: true, outcome: 'passed', recovered: false,
            modes: Object.entries(producer.requiredObservations).filter(([, classes]) => classes.includes(classId)).map(([mode]) => mode),
            terminal: { timeout: false, cancelled: false, processTreeTerminated: false, priorAttemptDigest: null },
            semanticFacts: { coherent: true },
            candidatePlanRef: { path: '.tmp/current-run/plan.json', fileDigest: `sha256:${'5'.repeat(64)}`, contentDigest: `sha256:${'6'.repeat(64)}` },
            sourceReceiptRef: { path: `.tmp/current-run/${classId}.json`, fileDigest: `sha256:${'7'.repeat(64)}`, contentDigest: `sha256:${'8'.repeat(64)}` },
            canonicalRerunCommand: 'node forbidden-producer.mjs', independentVerifyCommand: 'node forbidden-verifier.mjs'
        })))
    return { registry, catalog: currentCatalog, preRuntimeReceipt: preRuntime(currentCatalog), observations }
}

test('current registry observation admission joins one scheduler and all seven classes without running commands', () =>
{
    const input = currentObservationInputs()
    const results = validatePostRuntimeObservationInputs(input)
    assert.equal(results.length, 7)
    assert.deepEqual([...new Set(results.map((result) => result.producerId))], ['production-correctness-scheduler'])
    assert.ok(results.every((result) => result.behaviorId === 'browserless-production-correctness'))
})

test('current registry observation admission rejects missing duplicate orphan and cross-candidate inputs', () =>
{
    for (const [mutation, expected] of [
        [(input) => input.observations.pop(), /missing observations/u],
        [(input) => input.observations.push(input.observations[0]), /duplicate observation/u],
        [(input) => { input.observations[0].producerId = 'unowned' }, /orphan/u],
        [(input) => { input.observations[0].sourceState.runId = 'stale' }, /run identity mismatch/u],
        [(input) => { input.observations[1].sourceState.candidateId = 'other' }, /cross-candidate/u],
        [(input) => { input.observations[1].candidatePlanRef.contentDigest = `sha256:${'9'.repeat(64)}` }, /candidate plan mismatch/u],
        [(input) => { input.observations[0].qualificationEligible = false }, /cannot satisfy qualification/u],
        [(input) => { input.observations[0].recovered = true; input.observations[0].terminal.priorAttemptDigest = `sha256:${'9'.repeat(64)}` }, /cannot satisfy qualification/u]
    ])
    {
        const input = currentObservationInputs()
        mutation(input)
        input.observations = input.observations.map(seal)
        assert.throws(() => validatePostRuntimeObservationInputs(input), expected)
    }
})

test('current registry admission rejects legacy runtimeEvidence and missing accepted claims', () =>
{
    const input = currentObservationInputs()
    input.observations = [{ schema: 'fsusblog.browserless-correctness-receipt.v1', aggregate: { status: 'success' } }]
    assert.throws(() => validatePostRuntimeObservationInputs(input), /orphan/u)
    assert.throws(() => validatePostRuntimeClaimInputs({ ...input, acceptedClaims: [] }), /missing accepted claims/u)
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
