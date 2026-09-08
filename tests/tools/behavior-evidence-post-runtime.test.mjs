import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
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
    joinPostRuntimeCandidateIdentities,
    postRuntimeObservationPaths,
    verifyPostRuntimeSchedulerEvidence,
    validatePostRuntimeReceipt
} from '../../tools/test-matrix/behavior-evidence-post-runtime.mjs'
import { authorityDigest, loadPostRuntimeProducerRegistry } from '../../tools/test-matrix/post-runtime-producer-registry.mjs'
import * as schedulerAuthority from '../../tools/test-matrix/scheduler.mjs'
import { root as sourceRoot, validatePostRuntimeReaderFirewall } from '../../tools/test-matrix/post-runtime-producer-registry.mjs'
import { createCanonicalPostRuntimeJoinObservations } from './support/post-runtime-join-fixture.mjs'
import { buildPostRuntimeAcceptedClaimsReceipt } from '../../tools/docs/post-runtime-accepted-claims.mjs'
import { sealSourceIdentity } from '../../tools/fact-extractors/identity.mjs'
import { digestValue } from '../../tools/fact-extractors/lib/canonicalize.mjs'

test('canonical synthetic join replays the CLI against running, downstream and completed scheduler authority', async (context) =>
{
    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'post-runtime-join-cli-'))
    context.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }))
    const preview = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'config/docs/public-preview-screenshots.json'), 'utf8'))
    const files = ['config/contracts/behavior-contracts.json', 'config/contracts/document-claim-migration-ledger.json',
        'config/testing/post-runtime-producer-registry.json', 'config/testing/evidence-locator-registry.json',
        'config/schemas/post-runtime-accepted-claims.schema.json', 'config/schemas/post-runtime-observation-result.schema.json',
        'config/schemas/behavior-evidence-post-runtime-receipt.schema.json', 'config/configuration-ownership.json',
        'tools/run-test-matrix.mjs', 'tools/test/lanes/production-correctness-receipt.sh',
        'tests/matrix.yml', 'config/testing/correctness-attempt-producers.json', 'config/testing/fixture-profile-catalog.json',
        'config/docs/public-preview-screenshots.json', preview.qualityPolicyFile, ...preview.qualityScenarioFiles,
        ...validatePostRuntimeReaderFirewall(sourceRoot).modules]
    for (const file of new Set(files))
    {
        fs.mkdirSync(path.dirname(path.join(repositoryRoot, file)), { recursive: true })
        fs.copyFileSync(path.join(sourceRoot, file), path.join(repositoryRoot, file))
    }
    fs.writeFileSync(path.join(repositoryRoot, '.gitignore'), '.tmp/\nartifacts/\n')
    for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']])
        assert.equal(spawnSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' }).status, 0)
    const source = sealSourceIdentity(repositoryRoot)
    const sourceState = { commit: source.sourceCommit, worktreeFingerprint: source.worktreeFingerprint }
    const { receipts, build } = createCanonicalPostRuntimeJoinObservations(repositoryRoot, sourceState)
    const write = (relative, value) =>
    {
        const absolute = path.join(repositoryRoot, relative)
        fs.mkdirSync(path.dirname(absolute), { recursive: true })
        fs.writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`)
        return relative
    }
    const observationPaths = receipts.map((receipt, index) => write(`.tmp/join/observation-${index}.json`, receipt))
    const actualCatalog = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'config/contracts/behavior-contracts.json'), 'utf8'))
    write('.tmp/join/pre.json', seal({ ...preRuntime(actualCatalog), runIdentity: 'run-1',
        sourceIdentity: { commit: source.sourceCommit, worktreeFingerprint: `sha256:${source.worktreeFingerprint}` } }))
    const executionContext = seal({ schema: 'fsusblog.current-run-evidence-context.v1', schedulerRunId: 'run-1',
        attemptId: 'attempt-0001', sourceCommit: source.sourceCommit, worktreeFingerprint: `sha256:${source.worktreeFingerprint}`,
        candidateIdentity: { id: 'run-1:candidate', digest: authorityDigest({ candidate: 'run-1' }) },
        buildIdentity: { id: 'production-build', digest: build.contentDigest }, ownedRoots: ['artifacts/current-run'] })
    write('.tmp/join/context.json', executionContext)
    const ledger = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'config/contracts/document-claim-migration-ledger.json'), 'utf8'))
    const claimAcceptance = ledger.scopes.flatMap((scope) => scope.entries.flatMap((entry) => entry.claimIds.map((claimId, index) => ({
        claimId, behaviorId: entry.behaviorId, scopeId: scope.scopeId, documentPath: entry.documentPath,
        claimType: entry.generatedSectionIds[index] ? 'generated-section' : 'prose',
        generatedSectionId: entry.generatedSectionIds[index] ?? null, claimDigest: authorityDigest({ claimId })
    })))).sort((left, right) => left.claimId.localeCompare(right.claimId))
    const generatedClaimCount = claimAcceptance.filter((claim) => claim.claimType === 'generated-section').length
    const terminal = { schema: 'fsusblog.global-claim-exactness-terminal-receipt.v1', scopeId: 'global-document-claim-exactness', runId: 'run-1',
        source: { sourceCommit: source.sourceCommit, worktreeFingerprint: source.worktreeFingerprint, catalogDigest: '1'.repeat(64),
            migrationLedgerDigest: digestValue(ledger), sectionCatalogDigest: '2'.repeat(64), observationDigests: {} },
        authorityDigests: [], claimAcceptance, counts: { requiredBehaviors: 9, scopes: 6, ledgerEntries: 43,
            generatedClaimCount, proseClaimCount: claimAcceptance.length - generatedClaimCount, proseTotal: 35, proseVerified: 35,
            generatedSectionsVerified: 84, generatedSectionDrifts: 0, missing: 0, extra: 0, residue: 0,
            mutationKilled: 12, mutationTotal: 12, warnings: 0 }, mutationAggregate: { killed: 12, total: 12 },
        residue: [], proseVerification: { diagnostics: [] }, status: 'ok', failureReasons: [], contentDigest: null }
    terminal.contentDigest = digestValue(terminal)
    const authority = loadPostRuntimeProducerRegistry(repositoryRoot).receiptSemantics.acceptedTerminalAuthority
    const directory = `${authority.referenceRoot}/run-1/attempt-0001`
    const payload = write(`${directory}/${authority.payloadName}`, terminal)
    const body = { schema: authority.referenceSchema, schedulerRunId: 'run-1', attemptId: 'attempt-0001',
        sourceCommit: source.sourceCommit, worktreeFingerprint: source.worktreeFingerprint,
        candidateIdentity: executionContext.candidateIdentity, buildIdentity: executionContext.buildIdentity,
        authorityId: authority.authorityId, producerId: authority.producerId,
        payload: { path: payload, schema: terminal.schema, digest: `sha256:${createHash('sha256').update(fs.readFileSync(path.join(repositoryRoot, payload))).digest('hex')}` } }
    const publication = { ...body, contentDigest: authorityDigest(body) }
    const terminalReceiptPath = write(`${directory}/${authority.referenceName}`, { ...publication, producerReceiptDigest: authorityDigest(publication) })
    write('.tmp/join/claims.json', buildPostRuntimeAcceptedClaimsReceipt({ terminalReceiptPath, expectedRunId: 'run-1', repositoryRoot }))
    const makeTier = (id, dependencies, artifacts = []) => ({ id, command: id, executionDependsOn: dependencies, artifacts,
        services: [], parallelizable: true, exclusiveResources: [], resourceClass: 'cpu', maxParallel: 1,
        cpuUnits: 1, memoryGiB: 0.1, cacheInputs: [], executionKey: id, executionVariant: 'ordinary', coverage: [] })
    const post = makeTier('behavior-evidence-post-runtime', [], ['.tmp/join/post.json'])
    const final = makeTier('release-final', [post.id])
    let pins
    let downstreamVerified = false
    const cli = (phase, produce = false, selectedObservations = observationPaths) => spawnSync(process.execPath, ['--input-type=module', '-e',
        `import { runBehaviorEvidencePostRuntimeCli } from ${JSON.stringify(path.join(sourceRoot, 'tools/test-matrix/behavior-evidence-post-runtime.mjs'))}; process.exitCode = await runBehaviorEvidencePostRuntimeCli(process.argv.slice(1), ${JSON.stringify(repositoryRoot)});`,
        '--', '--pre-runtime', '.tmp/join/pre.json', '--catalog', 'config/contracts/behavior-contracts.json',
        '--registry', 'config/testing/post-runtime-producer-registry.json', ...selectedObservations.flatMap((file) => ['--observation', file]),
        '--accepted-claims', '.tmp/join/claims.json', '--execution-context', '.tmp/join/context.json', ...pins,
        '--verification-mode', phase, produce ? '--out' : '--verify-receipt', '.tmp/join/post.json'],
    { cwd: repositoryRoot, encoding: 'utf8' })
    const pass = (result) => assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    const result = await schedulerAuthority.runDag({ tiers: [post, final], root: repositoryRoot,
        runsRoot: path.join(repositoryRoot, '.tmp/test-runs'), runId: 'run-1', namespace: 'join-cli', targetTierId: final.id,
        mode: 'fresh', sourceState, snapshotWorktree: async () => ({ fingerprint: source.worktreeFingerprint, entries: {} }),
        executeTier: async (tier, execution) =>
        {
            if (tier.id === post.id)
            {
                pins = ['--scheduler-evidence', execution.env.FSUSBLOG_SCHEDULER_CHECKPOINT,
                    '--scheduler-context', execution.env.FSUSBLOG_SCHEDULER_VERIFICATION_CONTEXT,
                    '--scheduler-context-digest', execution.env.FSUSBLOG_SCHEDULER_VERIFICATION_CONTEXT_DIGEST,
                    '--scheduler-run-id', 'run-1', '--scheduler-candidate-digest', execution.env.FSUSBLOG_SCHEDULER_CANDIDATE_IDENTITY_DIGEST]
                pass(cli('running', true))
                pass(cli('running'))
                assert.match(cli('completed-tier').stderr, /no later successful completion/u)
                assert.match(cli('running', false, observationPaths.slice(1)).stderr, /missing observations/u)
                const file = path.join(repositoryRoot, observationPaths[0])
                const original = fs.readFileSync(file)
                fs.writeFileSync(file, '{}\n')
                assert.notEqual(cli('running').status, 0)
                fs.writeFileSync(file, original)
                for (const field of ['sourceCommit', 'candidateId'])
                {
                    const stale = JSON.parse(original)
                    stale.sourceState[field] = field === 'sourceCommit' ? 'f'.repeat(40) : 'other-candidate'
                    write(observationPaths[0], seal(stale))
                    assert.match(cli('running').stderr, new RegExp(`observation ${field} does not match`, 'u'))
                    fs.writeFileSync(file, original)
                }
                const claimsFile = path.join(repositoryRoot, '.tmp/join/claims.json')
                const originalClaims = fs.readFileSync(claimsFile)
                const staleClaims = JSON.parse(originalClaims)
                staleClaims.sourceState.commit = 'f'.repeat(40)
                write('.tmp/join/claims.json', seal(staleClaims))
                assert.match(cli('running').stderr, /accepted claims commit does not match/u)
                fs.writeFileSync(claimsFile, originalClaims)
                const receiptFile = path.join(repositoryRoot, '.tmp/join/post.json')
                const originalReceipt = fs.readFileSync(receiptFile)
                const changed = JSON.parse(originalReceipt)
                changed.releaseFinalSpawnCountBeforeReceipt = 1
                write('.tmp/join/post.json', seal(changed))
                assert.notEqual(cli('running').status, 0)
                fs.writeFileSync(receiptFile, originalReceipt)
                const wrongArtifactMap = JSON.parse(originalReceipt)
                wrongArtifactMap.observationArtifactDigests[Object.keys(wrongArtifactMap.observationArtifactDigests)[0]] = authorityDigest({ wrong: true })
                write('.tmp/join/post.json', seal(wrongArtifactMap))
                assert.match(cli('running').stderr, /artifact digests/u)
                fs.writeFileSync(receiptFile, originalReceipt)
                pass(cli('running'))
            }
            else { pass(cli('completed-tier')); downstreamVerified = true }
            return { code: 0, signal: null }
        } })
    assert.equal(result.status, 'success', JSON.stringify(result.failure))
    assert.equal(downstreamVerified, true)
    pass(cli('completed-run'))
})

const commit = 'a'.repeat(40)
const worktreeFingerprint = 'b'.repeat(64)
const runId = 'post-runtime-round-1'

test('candidate identity keeps canonical class artifacts separate without relaxing shared identity', () =>
{
    const shared = identityInputs().observations[0].sourceState
    const observations = ['probe', 'aot', 'browser'].map((classId) => ({
        producerId: 'production-correctness-scheduler',
        sourceState: { ...shared, artifactDigest: authorityDigest({ classId }) }
    }))
    assert.deepEqual(joinPostRuntimeCandidateIdentities(observations), shared)
    for (const field of Object.keys(shared))
    {
        const changed = structuredClone(observations)
        changed[1].sourceState[field] += '-other'
        assert.throws(() => joinPostRuntimeCandidateIdentities(changed), new RegExp(`cross-candidate identity ${field}`, 'u'))
    }
})

test('scheduler replay requires an explicit phase and independent caller context before inspecting admission', () =>
{
    for (const verificationMode of [undefined, 'active', 'success', 'auto'])
    {
        assert.throws(() => verifyPostRuntimeSchedulerEvidence({ verificationMode }), /explicit scheduler verification mode/u)
    }
    for (const verificationMode of ['running', 'completed-tier', 'completed-run'])
    {
        assert.throws(() => verifyPostRuntimeSchedulerEvidence({ verificationMode }), /independent scheduler verification context/u)
    }
})

async function verifySchedulerPhases(context, finalExitCode)
{
    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-post-scheduler-'))
    context.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }))
    const runsRoot = path.join(repositoryRoot, '.tmp/test-runs')
    const schedulerRunId = 'post-scheduler-proof'
    const sourceState = { commit, worktreeFingerprint: 'stable' }
    const makeTier = (id, dependencies, artifacts = []) => ({
        id, command: id, executionDependsOn: dependencies, artifacts,
        services: [], parallelizable: true, exclusiveResources: [], resourceClass: 'cpu',
        maxParallel: 1, cpuUnits: 1, memoryGiB: 0.1, cacheInputs: [],
        executionKey: id, executionVariant: 'ordinary', coverage: []
    })
    const post = makeTier('behavior-evidence-post-runtime', [], ['post.json'])
    const final = makeTier('release-final', [post.id])
    let admission
    let reference
    let schedulerVerificationContext
    let schedulerContextInputs
    let downstreamVerified = false
    const verify = (verificationMode, overrides = {}) => verifyPostRuntimeSchedulerEvidence({
        repositoryRoot, admission, reference, verificationMode, schedulerVerificationContext, ...overrides
    })
    const result = await schedulerAuthority.runDag({
        tiers: [post, final], root: repositoryRoot, runsRoot, runId: schedulerRunId,
        namespace: 'post-scheduler', targetTierId: final.id, mode: 'fresh', sourceState,
        snapshotWorktree: async () => ({ fingerprint: 'stable', entries: {} }),
        executeTier: async (tier, execution) =>
        {
            if (tier.id === post.id)
            {
                schedulerContextInputs = {
                    root: repositoryRoot, runsRoot,
                    file: execution.env.FSUSBLOG_SCHEDULER_VERIFICATION_CONTEXT,
                    expectedContentDigest: execution.env.FSUSBLOG_SCHEDULER_VERIFICATION_CONTEXT_DIGEST,
                    expectedRunId: schedulerRunId, expectedSourceState: sourceState,
                    expectedCandidateIdentityDigest: execution.env.FSUSBLOG_SCHEDULER_CANDIDATE_IDENTITY_DIGEST
                }
                schedulerVerificationContext = schedulerAuthority.readSchedulerVerificationContext(schedulerContextInputs)
                const bytes = fs.readFileSync(execution.env.FSUSBLOG_SCHEDULER_CHECKPOINT)
                admission = JSON.parse(bytes)
                reference = {
                    schema: admission.schema,
                    ref: path.relative(repositoryRoot, execution.env.FSUSBLOG_SCHEDULER_CHECKPOINT).replaceAll(path.sep, '/'),
                    fileDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
                    contentDigest: admission.contentDigest, currentTierId: post.id,
                    admissionSequence: admission.admissionSequence
                }
                fs.writeFileSync(path.join(repositoryRoot, 'post.json'), '{"verified":true}\n')
                assert.equal(verify('running').status, 'active')
                assert.throws(() => verify('completed-tier'), /no later successful completion/u)
                assert.throws(() => verify('running', {
                    schedulerVerificationContext: structuredClone(schedulerVerificationContext)
                }), /independently verified/u)
                assert.throws(() => verify('running', {
                    admission: { ...admission, schedulerCandidateIdentityDigest: 'forged' }
                }), /independent caller context/u)
            }
            else
            {
                assert.equal(verify('completed-tier').status, 'verified')
                assert.throws(() => verify('running'), /not authoritative/u)
                downstreamVerified = true
            }
            return { code: tier.id === final.id ? finalExitCode : 0, signal: null }
        }
    })
    assert.equal(downstreamVerified, true, 'all downstream phase assertions must execute before the deliberate exit')
    if (finalExitCode !== 0)
    {
        assert.equal(result.status, 'failure')
        assert.equal(result.failure.tierId, final.id)
        assert.equal(result.failure.exitCode, finalExitCode)
        const checkpoint = JSON.parse(fs.readFileSync(result.checkpointPath, 'utf8'))
        assert.equal(checkpoint.status, 'failure')
        assert.equal(checkpoint.tiers[post.id].status, 'success')
        const owner = JSON.parse(fs.readFileSync(path.join(runsRoot, '.locks', '.terminal',
            schedulerRunId, `${admission.schedulerOwnerToken}.json`), 'utf8'))
        assert.equal(owner.state, 'failed')
        assert.equal(owner.ownerToken, admission.schedulerOwnerToken)
        assert.equal(owner.candidateIdentityDigest, schedulerVerificationContext.expectedCandidateIdentityDigest)
        // Failed owners cannot issue a correctness context, even when the prior
        // post-runtime tier succeeded. Do not bypass this earlier authority gate.
        assert.throws(() => schedulerAuthority.readSchedulerVerificationContext(schedulerContextInputs), {
            message: 'scheduler verification context: context lacks matching scheduler owner authority'
        })
        assert.throws(() => verify('completed-run'), {
            message: 'scheduler verification context: context lacks matching scheduler owner authority'
        })
        return
    }
    assert.equal(result.status, 'success', JSON.stringify(result.failure))
    assert.equal(verify('completed-run').status, 'verified')
    assert.throws(() => verify('completed-tier'), /original live scheduler owner/u)
    fs.writeFileSync(path.join(repositoryRoot, 'post.json'), '{"verified":false}\n')
    assert.throws(() => verify('completed-run'), /output identity mismatch/u)
}

test('post-runtime scheduler verifier distinguishes producer, downstream and archived completion using real scheduler journal', async (context) =>
{
    await verifySchedulerPhases(context, 0)
})

test('completed-run rejects a successful post-runtime tier inside a coherently finalized failed run', async (context) =>
{
    await verifySchedulerPhases(context, 1)
})

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
        contentDigest: authorityDigest({ index }), artifactDigest: authorityDigest({ classId })
    }))
    const reference = (name, contentDigest = authorityDigest({ name })) => ({
        ref: `.tmp/current-run/${name}.json`, fileDigest: authorityDigest({ bytes: name }), contentDigest
    })
    return seal({
        schema: 'fsusblog.behavior-evidence-post-runtime-receipt.v1', scope: 'post-runtime',
        runIdentity: runId, sourceIdentity: input.preRuntimeReceipt.sourceIdentity,
        candidateIdentity: {
            ...input.observations[0].sourceState,
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
        observationArtifactDigests: Object.fromEntries(results.map((result) =>
            [`${result.producerId}:${result.classId}`, result.artifactDigest])),
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
        [(value) => { value.observationArtifactDigests[Object.keys(value.observationArtifactDigests)[0]] = authorityDigest({ tampered: true }) }, /artifact digests/u],
        [(value) => { delete value.observationArtifactDigests[Object.keys(value.observationArtifactDigests)[0]] }, /artifact digests/u],
        [(value) => { value.observationArtifactDigests.orphan = authorityDigest({ orphan: true }) }, /artifact digests/u],
        [(value) => { value.candidateIdentity.artifactDigest = authorityDigest({ legacy: true }) }, /schema validation/u],
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
