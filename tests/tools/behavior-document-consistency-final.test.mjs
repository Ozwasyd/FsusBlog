import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { digestCatalog } from '../../tools/contracts/behavior-contract-catalog.mjs'
import {
    buildFinalConsistencyReport,
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
    const catalog = {
        schema: 'fsusblog.behavior-contract-catalog.v1',
        digestAlgorithm: 'sha256',
        canonicalSerialization: 'json-utf8-v1',
        domains: ['testing'],
        extractors: [{ id: 'alpha-facts', path: 'tools/alpha.mjs' }],
        contracts: [{
            id: 'alpha-behavior', domain: 'testing', risk: 'high', status: 'active',
            implementationOwnerCardinality: 'one', allowedImplementationOwnerRoles: [],
            factExtractorId: 'alpha-facts', requiredTestKinds: ['positive'],
            documentationPolicy: 'required', documentationRationale: 'Alpha is current.',
            allowedClaimTypes: ['behavioral'], releaseQualification: true,
            evidenceStage: 'pre-runtime', coverageIds: ['alpha'], documents: ['docs/alpha.md']
        }, {
            id: 'runtime-behavior', domain: 'testing', risk: 'critical', status: 'active',
            implementationOwnerCardinality: 'one', allowedImplementationOwnerRoles: [],
            factExtractorId: 'alpha-facts', requiredTestKinds: ['runtime'],
            documentationPolicy: 'required', documentationRationale: 'Runtime is current.',
            allowedClaimTypes: ['behavioral'], releaseQualification: true,
            evidenceStage: 'post-runtime',
            runtimeEvidence: {
                producerTierId: 'production-correctness',
                observationSchema: 'fsusblog.browserless-correctness-receipt.v1'
            },
            coverageIds: ['runtime'], documents: ['docs/runtime.md']
        }]
    }
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
        behaviorIds: ['alpha-behavior'], requiredTestKinds: { 'alpha-behavior': ['positive'] },
        observedTestKinds: { 'alpha-behavior': ['positive'] }, mutationStatus: {},
        runtimeCandidateSpawnCountBeforeReceipt: 0, status: 'ok', failureReasons: []
    })
    const post = seal({
        schema: 'fsusblog.behavior-evidence-post-runtime-receipt.v1', scope: 'post-runtime',
        runIdentity: runId, sourceIdentity: { commit, worktreeFingerprint: `sha256:${fingerprint}` },
        candidateIdentity: { buildReceiptDigest: `sha256:${'d'.repeat(64)}`, runtimeEvidenceDigest: `sha256:${'e'.repeat(64)}`, browserContractDigest: `sha256:${'f'.repeat(64)}` },
        preRuntimeReceiptDigest: pre.contentDigest, catalogDigest: `sha256:${catalogHash}`,
        behaviorIds: ['runtime-behavior'], requiredRuntimeProducers: ['production-correctness'],
        observedBehaviorResults: [{
            behaviorId: 'runtime-behavior', producerTierId: 'production-correctness',
            observationSchema: 'fsusblog.browserless-correctness-receipt.v1', status: 'ok',
            evidenceDigest: `sha256:${'e'.repeat(64)}`
        }],
        documentClaimDigests: { 'runtime-behavior': pre.staticClaimVerificationDigest },
        missing: [], orphans: [], conflicts: [], releaseFinalSpawnCountBeforeReceipt: 0,
        status: 'ok', failureReasons: []
    })
    const owner = seal({ status: 'ok', bindings: [
        { behaviorId: 'alpha-behavior', sourcePath: 'src/alpha.cs' },
        { behaviorId: 'runtime-behavior', sourcePath: 'src/runtime.cs' }
    ] })
    const fact = seal({ status: 'ok', extractorId: 'alpha-facts', behaviorIds: ['alpha-behavior', 'runtime-behavior'], sourceCommit: commit, worktreeFingerprint: fingerprint })
    const claims = seal({ claims: [
        { declaration: { behaviorId: 'alpha-behavior', claimId: 'alpha.current' } },
        { declaration: { behaviorId: 'runtime-behavior', claimId: 'runtime.current' } }
    ] })
    const verification = seal({ status: 'ok' })
    const generated = seal({ status: 'ok' })
    const migrationLedger = { schema: 'fixture', scopes: [{ scopeId: 'alpha', entries: [
        { behaviorId: 'alpha-behavior', documentPath: 'docs/alpha.md', claimIds: ['alpha.current'], generatedSectionIds: [] },
        { behaviorId: 'runtime-behavior', documentPath: 'docs/runtime.md', claimIds: ['runtime.current'], generatedSectionIds: [] }
    ] }] }
    const matrix = { tiers: [
        { id: 'static', executionDependsOn: [], summaryAuthority: null },
        { id: 'pre', executionDependsOn: ['static'], summaryAuthority: null },
        { id: 'post', executionDependsOn: ['pre'], summaryAuthority: null }
    ] }
    return {
        staticAdmissionReceipt: admission, preRuntimeReceipt: pre, postRuntimeReceipt: post,
        ownerReceipt: owner, factObservationReceipts: [fact], docClaimParseReceipt: claims,
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
    assert.equal(report.behaviorNodes[1].status, 'ok')
    assert.equal(report.dagAudit.stronglyConnectedComponents.length, 0)
    assert.deepEqual(report.dagAudit.postRuntimeBinding.errors, [])
})

test('post-runtime seal must bind the exact pre-runtime receipt and one observation per catalog behavior', async (context) =>
{
    const cases = [
        {
            name: 'same-run receipt from another pre-runtime qualification',
            mutate(post)
            {
                post.preRuntimeReceiptDigest = `sha256:${'0'.repeat(64)}`
            },
            expected: /pre-runtime receipt digest mismatch/u
        },
        {
            name: 'duplicate runtime observation',
            mutate(post)
            {
                post.observedBehaviorResults.push(structuredClone(post.observedBehaviorResults[0]))
            },
            expected: /observed post-runtime behavior IDs contains duplicate entries/u
        },
        {
            name: 'nullable candidate identity in an ok seal',
            mutate(post)
            {
                post.candidateIdentity.runtimeEvidenceDigest = null
            },
            expected: /candidate identity runtimeEvidenceDigest is missing/u
        }
    ]
    for (const scenario of cases)
    {
        await context.test(scenario.name, () =>
        {
            const input = fixture()
            const post = structuredClone(input.postRuntimeReceipt)
            scenario.mutate(post)
            input.postRuntimeReceipt = seal(post)
            const report = buildFinalConsistencyReport(input)
            assert.equal(report.status, 'failed')
            assert.match(report.failureReasons.join('\n'), scenario.expected)
        })
    }
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
    const report = buildFinalConsistencyReport(input)
    assert.equal(report.status, 'failed')
    assert.ok(report.failureReasons.some((reason) => reason.includes('identity mismatch')))
    assert.ok(report.failureReasons.some((reason) => reason.includes('SCC')))
    assert.ok(report.failureReasons.some((reason) => reason.includes('zero-legacy')))
})

test('tampered input receipt is rejected before final aggregation', () =>
{
    const input = fixture()
    input.ownerReceipt.bindings = []
    assert.throws(() => buildFinalConsistencyReport(input), /contentDigest mismatch/u)
})
