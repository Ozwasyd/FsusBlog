import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { authorityDigest, loadPostRuntimeProducerRegistry, validatePostRuntimeReaderFirewall } from '../../tools/test-matrix/post-runtime-producer-registry.mjs'
import { sealSourceIdentity } from '../../tools/fact-extractors/identity.mjs'
import { digestValue } from '../../tools/fact-extractors/lib/canonicalize.mjs'
import { runDag } from '../../tools/test-matrix/scheduler.mjs'
import { buildPostRuntimeAcceptedClaimsReceipt } from '../../tools/docs/post-runtime-accepted-claims.mjs'
import { createCanonicalPostRuntimeJoinObservations } from './support/post-runtime-join-fixture.mjs'

import { digestCatalog } from '../../tools/contracts/behavior-contract-catalog.mjs'
import {
    buildFinalConsistencyReport,
    buildVerifiedFinalConsistencyReport,
    root as sourceRoot,
    validateFinalReport
} from '../../tools/docs/behavior-document-consistency-final.mjs'

const commit = 'a'.repeat(40)
const fingerprint = 'b'.repeat(64)
const runId = 'final-round'
const stable = (value) => Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
        : value
const hash = (value) => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')
const seal = (value, keepNull = false) => {
    const receipt = { ...value, contentDigest: null }
    const content = keepNull ? receipt : Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== 'contentDigest'))
    receipt.contentDigest = `sha256:${hash(content)}`
    return receipt
}

function fixture(overrides = {})
{
    const catalog = JSON.parse(fs.readFileSync(new URL('../../config/contracts/behavior-contracts.json', import.meta.url), 'utf8'))
    const registry = loadPostRuntimeProducerRegistry()
    const active = catalog.contracts.filter((entry) => entry.status === 'active' && entry.releaseQualification)
    const preContracts = active.filter((entry) => entry.evidenceStage === 'pre-runtime')
    const reference = (name, contentDigest = authorityDigest({ name })) => ({
        ref: `.tmp/current-run/${name}.json`, fileDigest: authorityDigest({ bytes: name }), contentDigest
    })
    const catalogHash = digestCatalog(catalog)
    const admission = seal({
        schema: 'fsusblog.behavior-doc-static-admission-receipt.v1',
        run: { id: runId },
        source: { commit, worktreeFingerprint: fingerprint },
        worktree: { root: '/repo' },
        toolchain: { node: 'v24', dotnet: '10', platform: 'linux', architecture: 'x64', directoryBuildPropsDigest: '1'.repeat(64) },
        authorityDigests: {
            catalog: catalogHash, claim: '2'.repeat(64), extractorRegistry: '3'.repeat(64),
            generatedSectionCatalog: '4'.repeat(64), generatedRenderer: '5'.repeat(64),
            proseRenderer: '6'.repeat(64), mutationCatalog: '7'.repeat(64)
        },
        implementationOwner: { status: 'ok', bindingCount: 1, contentDigest: '8'.repeat(64) },
        factObservations: {},
        minimalContractBuild: { contentDigest: '9'.repeat(64) },
        generated: { status: 'ok' }, prose: { status: 'ok' }, mutationFixtures: { status: 'ok' },
        candidateSpawnCountBeforeReceipt: 0,
        status: 'ok', failureReasons: [], durationMs: 1
    }, true)
    const pre = seal({
        schema: 'fsusblog.behavior-evidence-pre-runtime-receipt.v1', scope: 'pre-runtime',
        runIdentity: runId, sourceIdentity: { commit, worktreeFingerprint: `sha256:${fingerprint}` },
        buildIdentities: {}, registryDigest: `sha256:${'3'.repeat(64)}`,
        catalogDigest: `sha256:${catalogHash}`, staticClaimVerificationDigest: `sha256:${'c'.repeat(64)}`,
        behaviorIds: preContracts.map((entry) => entry.id),
        requiredTestKinds: Object.fromEntries(preContracts.map((entry) => [entry.id, entry.requiredTestKinds])),
        observedTestKinds: Object.fromEntries(preContracts.map((entry) => [entry.id, entry.requiredTestKinds])),
        mutationStatus: Object.fromEntries(active.filter((entry) => entry.mutationPolicy?.mutationRequired).map((entry) => [entry.id, { qualified: true }])),
        runtimeCandidateSpawnCountBeforeReceipt: 0, status: 'ok', failureReasons: []
    })
    const results = registry.producers.flatMap((producer) =>
        [...new Set(Object.values(producer.requiredObservations).flat())].sort().map((classId) => ({
            behaviorId: producer.behaviorId, producerId: producer.producerId,
            extractorId: catalog.contracts.find((entry) => entry.id === producer.behaviorId).factExtractorId,
            classId, status: 'ok', contentDigest: authorityDigest({ classId }), artifactDigest: authorityDigest({ artifact: classId })
        })))
    const producerClasses = Object.fromEntries(registry.producers.map((producer) => [producer.producerId,
        results.filter((result) => result.producerId === producer.producerId).map((result) => result.classId)]))
    const post = seal({
        schema: 'fsusblog.behavior-evidence-post-runtime-receipt.v1', scope: 'post-runtime',
        runIdentity: runId, sourceIdentity: { commit, worktreeFingerprint: `sha256:${fingerprint}` },
        candidateIdentity: {
            sourceCommit: commit, worktreeFingerprint: `sha256:${fingerprint}`,
            buildIdentity: authorityDigest({ build: 1 }),
            candidateId: `${runId}:candidate`, runtimeId: `${runId}:runtime`,
            browserIdentity: `${runId}:browser-contract`, releaseId: '20260830123456-abcdef123456',
            rolloutId: `${runId}:rollout`, runId, attemptId: 'attempt-0001',
            fixtureId: `${runId}:fixture`, profileId: 'acceptance-representative'
        },
        executionIdentity: {
            commit, worktreeFingerprint: `sha256:${fingerprint}`, schedulerRunId: runId, attemptId: 'attempt-0001',
            candidateIdentityDigest: authorityDigest({ candidate: 1 }), buildIdentityDigest: authorityDigest({ build: 1 })
        },
        executionContext: reference('context'), schedulerEvidence: reference('admission'),
        preRuntimeReceiptDigest: pre.contentDigest, catalogDigest: `sha256:${catalogHash}`,
        registryDigest: authorityDigest(registry),
        behaviorIds: registry.producers.map((producer) => producer.behaviorId),
        requiredRuntimeProducers: registry.producers.map((producer) => producer.producerId),
        requiredProducerClasses: producerClasses, observedProducerClasses: structuredClone(producerClasses),
        observedBehaviorResults: results,
        observationArtifactDigests: Object.fromEntries(results.map((result) =>
            [`${result.producerId}:${result.classId}`, result.artifactDigest])),
        documentClaimDigests: Object.fromEntries(registry.producers.flatMap((producer) => producer.acceptedClaimRefs.map((claimId) => [claimId, authorityDigest({ claimId })]))),
        documentClaimTerminals: Object.fromEntries(registry.producers.map((producer) => [producer.behaviorId, authorityDigest({ terminal: 1 })])),
        observationRefs: results.map((result) => reference(result.classId, result.contentDigest)),
        acceptedClaimRefs: registry.producers.map((producer) => reference(producer.producerId)),
        missing: [], orphans: [], conflicts: [], stale: [], diagnostics: [],
        findingCounts: { missing: 0, orphans: 0, conflicts: 0, stale: 0, diagnostics: 0 },
        releaseFinalSpawnCountBeforeReceipt: 0, status: 'ok', failureReasons: []
    })
    const owner = seal({ status: 'ok', bindings: active.map((entry) => ({ behaviorId: entry.id, sourcePath: 'src/alpha.cs' })) })
    const facts = [...new Set(active.map((entry) => entry.factExtractorId))].map((extractorId) => seal({
        status: 'ok', extractorId,
        behaviorIds: active.filter((entry) => entry.factExtractorId === extractorId).map((entry) => entry.id),
        sourceCommit: commit, worktreeFingerprint: fingerprint
    }))
    const claims = seal({ claims: active.map((entry) => ({ declaration: { behaviorId: entry.id, claimId: `${entry.id}.fixture` } })) })
    const verification = seal({ status: 'ok' })
    const generated = seal({ status: 'ok' })
    const migrationLedger = { schema: 'fixture', scopes: [{ scopeId: 'alpha', entries: active.map((entry) => ({ behaviorId: entry.id, documentPath: entry.documents[0], claimIds: [`${entry.id}.fixture`], generatedSectionIds: [] })) }] }
    const matrix = { tiers: [
        { id: 'static', executionDependsOn: [], summaryAuthority: null },
        { id: 'pre', executionDependsOn: ['static'], summaryAuthority: null },
        { id: 'post', executionDependsOn: ['pre'], summaryAuthority: null }
    ] }
    return {
        staticAdmissionReceipt: admission, preRuntimeReceipt: pre, postRuntimeReceipt: post,
        ownerReceipt: owner, factObservationReceipts: facts, docClaimParseReceipt: claims,
        docClaimVerificationReceipt: verification, generatedSectionReceipt: generated,
        catalog, migrationLedger, matrix, zeroLegacyScan: { scannedFileCount: 10, findings: [] },
        ...overrides
    }
}

test('final consistency report deterministically closes every behavior edge', () =>
{
    const report = buildFinalConsistencyReport(fixture())
    assert.equal(validateFinalReport(report).status, 'ok', report.failureReasons.join('; '))
    assert.equal(report.behaviorNodes[0].status, 'ok')
    assert.equal(report.dagAudit.stronglyConnectedComponents.length, 0)
})

test('stale identities, graph cycles and legacy residue fail without repairing producers', () =>
{
    const stalePost = fixture().postRuntimeReceipt
    stalePost.sourceIdentity.commit = 'd'.repeat(40)
    stalePost.contentDigest = seal(Object.fromEntries(Object.entries(stalePost).filter(([key]) => key !== 'contentDigest'))).contentDigest
    const input = fixture({
        postRuntimeReceipt: stalePost,
        matrix: { tiers: [{ id: 'a', executionDependsOn: ['b'] }, { id: 'b', executionDependsOn: ['a'] }] },
        zeroLegacyScan: { scannedFileCount: 10, findings: [{ file: 'config/active.json', rule: 'forbidden-machine-field:lastReviewedAt', location: '$.lastReviewedAt' }] }
    })
    assert.throws(() => buildFinalConsistencyReport(input), /identities do not match/u)
    input.postRuntimeReceipt = fixture().postRuntimeReceipt
    const report = buildFinalConsistencyReport(input)
    assert.equal(report.status, 'failed')
    assert.ok(report.failureReasons.some((reason) => reason.includes('SCC')))
    assert.ok(report.failureReasons.some((reason) => reason.includes('zero-legacy')))
})

test('tampered input receipt is rejected before final aggregation', () =>
{
    const input = fixture()
    input.ownerReceipt.bindings = []
    assert.throws(() => buildFinalConsistencyReport(input), /contentDigest mismatch/u)
})

test('formal terminal rejects in-memory receipts before trusting caller qualification', () =>
{
    assert.throws(() => buildVerifiedFinalConsistencyReport(fixture()), /explicit postRuntimeReceipt/u)
})

test('synthetic terminal CLI rereads canonical inputs with independent pins after post-runtime completion', async (context) =>
{
    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-canonical-cli-'))
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
    const input = fixture()
    const observationPaths = receipts.map((receipt, index) => write(`.tmp/terminal/observation-${index}.json`, receipt))
    const terminalMatrix = write('.tmp/terminal/matrix.json', input.matrix)
    const pre = seal({ ...input.preRuntimeReceipt, runIdentity: 'run-1',
        sourceIdentity: { commit: source.sourceCommit, worktreeFingerprint: `sha256:${source.worktreeFingerprint}` } })
    write('.tmp/terminal/pre.json', pre)
    write('.tmp/terminal/admission.json', seal({ ...input.staticAdmissionReceipt,
        source: { commit: source.sourceCommit, worktreeFingerprint: source.worktreeFingerprint }, run: { id: 'run-1' } }, true))
    const componentArgs = ['--static-admission', '.tmp/terminal/admission.json', '--pre-runtime', '.tmp/terminal/pre.json',
        '--post-runtime', '.tmp/terminal/post.json', '--catalog', 'config/contracts/behavior-contracts.json',
        '--migration-ledger', 'config/contracts/document-claim-migration-ledger.json', '--matrix', terminalMatrix,
        '--out', path.join(repositoryRoot, '.tmp/terminal/report.json')]
    for (const [flag, name] of [['--owner', 'ownerReceipt'], ['--doc-claim-parse', 'docClaimParseReceipt'],
        ['--doc-claim-verification', 'docClaimVerificationReceipt'], ['--generated-section', 'generatedSectionReceipt']])
        componentArgs.push(flag, write(`.tmp/terminal/${name}.json`, input[name]))
    for (const [index, fact] of input.factObservationReceipts.entries())
        componentArgs.push('--fact', write(`.tmp/terminal/fact-${index}.json`, seal({ ...fact,
            sourceCommit: source.sourceCommit, worktreeFingerprint: source.worktreeFingerprint })))
    const executionContext = seal({ schema: 'fsusblog.current-run-evidence-context.v1', schedulerRunId: 'run-1',
        attemptId: 'attempt-0001', sourceCommit: source.sourceCommit, worktreeFingerprint: `sha256:${source.worktreeFingerprint}`,
        candidateIdentity: { id: 'run-1:candidate', digest: authorityDigest({ candidate: 'run-1' }) },
        buildIdentity: { id: 'production-build', digest: build.contentDigest }, ownedRoots: ['artifacts/current-run'] })
    write('.tmp/terminal/context.json', executionContext)
    const ledger = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'config/contracts/document-claim-migration-ledger.json'), 'utf8'))
    const claimAcceptance = ledger.scopes.flatMap((scope) => scope.entries.flatMap((entry) => entry.claimIds.map((claimId, index) => ({
        claimId, behaviorId: entry.behaviorId, scopeId: scope.scopeId, documentPath: entry.documentPath,
        claimType: entry.generatedSectionIds[index] ? 'generated-section' : 'prose',
        generatedSectionId: entry.generatedSectionIds[index] ?? null, claimDigest: authorityDigest({ claimId })
    })))).sort((left, right) => left.claimId.localeCompare(right.claimId))
    const generatedClaimCount = claimAcceptance.filter((claim) => claim.claimType === 'generated-section').length
    const claimsTerminal = { schema: 'fsusblog.global-claim-exactness-terminal-receipt.v1', scopeId: 'global-document-claim-exactness', runId: 'run-1',
        source: { sourceCommit: source.sourceCommit, worktreeFingerprint: source.worktreeFingerprint, catalogDigest: '1'.repeat(64),
            migrationLedgerDigest: digestValue(ledger), sectionCatalogDigest: '2'.repeat(64), observationDigests: {} },
        authorityDigests: [], claimAcceptance, counts: { requiredBehaviors: 9, scopes: 6, ledgerEntries: 43,
            generatedClaimCount, proseClaimCount: claimAcceptance.length - generatedClaimCount, proseTotal: 35, proseVerified: 35,
            generatedSectionsVerified: 84, generatedSectionDrifts: 0, missing: 0, extra: 0, residue: 0,
            mutationKilled: 12, mutationTotal: 12, warnings: 0 }, mutationAggregate: { killed: 12, total: 12 },
        residue: [], proseVerification: { diagnostics: [] }, status: 'ok', failureReasons: [], contentDigest: null }
    claimsTerminal.contentDigest = digestValue(claimsTerminal)
    const authority = loadPostRuntimeProducerRegistry(repositoryRoot).receiptSemantics.acceptedTerminalAuthority
    const directory = `${authority.referenceRoot}/run-1/attempt-0001`
    const payload = write(`${directory}/${authority.payloadName}`, claimsTerminal)
    const body = { schema: authority.referenceSchema, schedulerRunId: 'run-1', attemptId: 'attempt-0001',
        sourceCommit: source.sourceCommit, worktreeFingerprint: source.worktreeFingerprint,
        candidateIdentity: executionContext.candidateIdentity, buildIdentity: executionContext.buildIdentity,
        authorityId: authority.authorityId, producerId: authority.producerId,
        payload: { path: payload, schema: claimsTerminal.schema,
            digest: `sha256:${createHash('sha256').update(fs.readFileSync(path.join(repositoryRoot, payload))).digest('hex')}` } }
    const publication = { ...body, contentDigest: authorityDigest(body) }
    const terminalReceiptPath = write(`${directory}/${authority.referenceName}`, { ...publication, producerReceiptDigest: authorityDigest(publication) })
    write('.tmp/terminal/claims.json', buildPostRuntimeAcceptedClaimsReceipt({ terminalReceiptPath, expectedRunId: 'run-1', repositoryRoot }))
    const makeTier = (id, dependencies, artifacts = []) => ({ id, command: id, executionDependsOn: dependencies, artifacts,
        services: [], parallelizable: true, exclusiveResources: [], resourceClass: 'cpu', maxParallel: 1,
        cpuUnits: 1, memoryGiB: 0.1, cacheInputs: [], executionKey: id, executionVariant: 'ordinary', coverage: [] })
    const postTier = makeTier('behavior-evidence-post-runtime', [], ['.tmp/terminal/post.json'])
    const terminalTier = makeTier('behavior-document-consistency-final', [postTier.id])
    const releaseTier = makeTier('release-final', [terminalTier.id])
    let pins
    let verified = false
    const invoke = (module, name, args) => spawnSync(process.execPath, ['--input-type=module', '-e',
        `import { ${name} } from ${JSON.stringify(path.join(sourceRoot, module))}; process.exitCode = await ${name}(process.argv.slice(1), ${JSON.stringify(repositoryRoot)});`,
        '--', ...args], { cwd: repositoryRoot, encoding: 'utf8' })
    const cli = (overrides = []) => invoke('tools/docs/behavior-document-consistency-final.mjs',
        'runBehaviorDocumentConsistencyFinalCli', [...componentArgs, ...(overrides.length ? overrides : pins)])
    const pass = (result) => assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    const reportFile = path.join(repositoryRoot, '.tmp/terminal/report.json')
    const reject = (result, expected) =>
    {
        assert.equal(result.status, 1, result.stdout)
        assert.match(result.stderr, expected)
        assert.equal(fs.existsSync(reportFile), false)
    }
    const run = await runDag({ tiers: [postTier, terminalTier, releaseTier], root: repositoryRoot,
        runsRoot: path.join(repositoryRoot, '.tmp/test-runs'), runId: 'run-1', namespace: 'terminal-cli', targetTierId: releaseTier.id,
        mode: 'fresh', sourceState, snapshotWorktree: async () => ({ fingerprint: source.worktreeFingerprint, entries: {} }),
        executeTier: async (tier, execution) =>
        {
            if (tier.id === postTier.id)
            {
                const env = execution.env
                pins = ['--run-id', 'run-1', '--scheduler-verification-context', env.FSUSBLOG_SCHEDULER_VERIFICATION_CONTEXT,
                    '--scheduler-verification-context-digest', env.FSUSBLOG_SCHEDULER_VERIFICATION_CONTEXT_DIGEST,
                    '--candidate-identity-digest', env.FSUSBLOG_SCHEDULER_CANDIDATE_IDENTITY_DIGEST]
                pass(invoke('tools/test-matrix/behavior-evidence-post-runtime.mjs', 'runBehaviorEvidencePostRuntimeCli', [
                    '--pre-runtime', '.tmp/terminal/pre.json', '--catalog', 'config/contracts/behavior-contracts.json',
                    '--registry', 'config/testing/post-runtime-producer-registry.json',
                    ...observationPaths.flatMap((file) => ['--observation', file]), '--accepted-claims', '.tmp/terminal/claims.json',
                    '--execution-context', '.tmp/terminal/context.json', '--scheduler-evidence', env.FSUSBLOG_SCHEDULER_CHECKPOINT,
                    '--scheduler-context', env.FSUSBLOG_SCHEDULER_VERIFICATION_CONTEXT,
                    '--scheduler-context-digest', env.FSUSBLOG_SCHEDULER_VERIFICATION_CONTEXT_DIGEST,
                    '--scheduler-run-id', 'run-1', '--scheduler-candidate-digest', env.FSUSBLOG_SCHEDULER_CANDIDATE_IDENTITY_DIGEST,
                    '--verification-mode', 'running', '--out', '.tmp/terminal/post.json']))
                reject(cli(), /no later successful completion/u)
            }
            else if (tier.id === terminalTier.id)
            {
                for (let index = 0; index < pins.length; index += 2)
                {
                    reject(cli(pins.filter((_, position) => position !== index && position !== index + 1)), /requires explicit/u)
                    const changed = [...pins]
                    changed[index + 1] = index === 2 ? path.join(repositoryRoot, 'outside.json') : 'wrong-pin'
                    reject(cli(changed), /scheduler verification context/u)
                }
                reject(cli([...pins, '--run-id', 'other-run']), /duplicate argument/u)
                for (const relative of [observationPaths[0], '.tmp/terminal/claims.json', '.tmp/terminal/context.json'])
                {
                    const file = path.join(repositoryRoot, relative)
                    const original = fs.readFileSync(file)
                    const changed = JSON.parse(original)
                    if (relative === '.tmp/terminal/context.json') changed.sourceCommit = 'f'.repeat(40)
                    else if (relative === '.tmp/terminal/claims.json') changed.sourceState.commit = 'f'.repeat(40)
                    else changed.sourceState.sourceCommit = 'f'.repeat(40)
                    fs.writeFileSync(file, JSON.stringify(changed))
                    reject(cli(), /mismatch|does not match/u)
                    fs.writeFileSync(file, original)
                    fs.renameSync(file, `${file}.held`)
                    reject(cli(), /ENOENT/u)
                    fs.renameSync(`${file}.held`, file)
                }
                const preFile = path.join(repositoryRoot, '.tmp/terminal/pre.json')
                const originalPre = fs.readFileSync(preFile)
                write('.tmp/terminal/pre.json', seal({ ...pre, sourceIdentity: { ...pre.sourceIdentity, commit: 'f'.repeat(40) } }))
                reject(cli(), /does not match|mismatch/u)
                fs.writeFileSync(preFile, originalPre)
                pass(cli())
                const report = validateFinalReport(JSON.parse(fs.readFileSync(reportFile, 'utf8')))
                const post = JSON.parse(fs.readFileSync(path.join(repositoryRoot, '.tmp/terminal/post.json'), 'utf8'))
                assert.equal(report.receiptDigests.postRuntime, post.contentDigest)
                assert.equal(report.buildIdentity.candidateBuildIdentityDigest, post.executionIdentity.buildIdentityDigest)
                verified = true
            }
            return { exitCode: 0, signal: null, timedOut: false }
        } })
    assert.equal(run.status, 'success', JSON.stringify(run.failure))
    assert.equal(verified, true)
})
