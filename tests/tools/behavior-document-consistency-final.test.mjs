import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import {
    digestCatalog
} from '../../tools/contracts/behavior-contract-catalog.mjs'
import {
    sealDocClaimVerificationReceipt,
    sealGeneratedSectionCheckReceipt,
    sealOwnerBindingReceipt
} from '../../tools/contracts/behavior-graph-join.mjs'
import { hostDeclarations } from '../../tools/docs/behavior-doc-minimal-contract-build.mjs'
import {
    buildFinalConsistencyReport,
    validateFinalReport
} from '../../tools/docs/behavior-document-consistency-final.mjs'
import {
    buildReceipt as buildFactObservationReceipt,
    semanticDigestFromReceipt
} from '../../tools/fact-extractors/receipt.mjs'

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
const sealBare = (value, keepNull = false) => {
    const receipt = { ...value, contentDigest: null }
    const content = keepNull ? receipt : Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== 'contentDigest'))
    receipt.contentDigest = hash(content)
    return receipt
}

function minimalBuildReceipt()
{
    return sealBare({
        schema: 'fsusblog.behavior-doc-minimal-contract-build-receipt.v1',
        runId,
        sourceCommit: commit,
        worktreeFingerprint: fingerprint,
        toolchain: {
            dotnet: '10.0.100',
            configuration: 'Release',
            targetFramework: 'net10.0'
        },
        buildKey: '1'.repeat(64),
        buildRoot: `.tmp/behavior-doc-contract-builds/${'1'.repeat(64)}`,
        sourceClosureDigests: [
            { path: 'Directory.Build.props', digest: '2'.repeat(64) },
            { path: 'Directory.Packages.props', digest: '3'.repeat(64) }
        ],
        artifacts: Object.fromEntries(Object.entries(hostDeclarations).map(([artifactId, declaration]) => [
            artifactId,
            {
                project: declaration.project,
                projectDigest: '4'.repeat(64),
                path: `.tmp/behavior-doc-contract-builds/${'1'.repeat(64)}/${declaration.cacheFile}`,
                artifactDigest: '5'.repeat(64)
            }
        ])),
        status: 'ok',
        failureReasons: []
    }, true)
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
    const owner = sealOwnerBindingReceipt({
        schema: 'fsusblog.behavior-owner-binding-receipt.v1',
        catalogDigest: catalogHash,
        worktreeDigest: fingerprint,
        status: 'ok',
        bindingCount: 2,
        bindings: [
            {
                behaviorId: 'alpha-behavior', language: 'csharp',
                sourcePath: 'src/alpha.cs', symbol: 'Alpha', bindingKind: 'attribute',
                sourceDigest: '6'.repeat(64), catalogDigest: catalogHash,
                worktreeDigest: fingerprint, status: 'ok'
            },
            {
                behaviorId: 'runtime-behavior', language: 'csharp',
                sourcePath: 'src/runtime.cs', symbol: 'Runtime', bindingKind: 'attribute',
                sourceDigest: '7'.repeat(64), catalogDigest: catalogHash,
                worktreeDigest: fingerprint, status: 'ok'
            }
        ],
        errors: []
    })
    const fact = buildFactObservationReceipt({
        extractorId: 'alpha-facts',
        behaviorIds: ['alpha-behavior', 'runtime-behavior'],
        sourceCommit: commit,
        worktreeFingerprint: fingerprint,
        buildIdentity: null,
        extractorDigest: '8'.repeat(64),
        registryDigest: '9'.repeat(64),
        consumedInputDigests: [{ path: 'config/alpha.json', digest: 'a'.repeat(64) }],
        observations: { alphaValue: true, runtimeValue: 'qualified' },
        status: 'ok'
    })
    const claims = sealBare({
        schema: 'fsusblog.doc-claim-parse-receipt.v1',
        digestAlgorithm: 'sha256',
        canonicalSerialization: 'json-utf8-v1',
        behaviorCatalogDigest: catalogHash,
        claims: [
            {
                declaration: {
                    behaviorId: 'alpha-behavior', claimId: 'alpha.current',
                    claimType: 'behavioral', factPath: 'alphaValue', render: 'scalar'
                },
                location: { documentPath: 'docs/alpha.md' }
            },
            {
                declaration: {
                    behaviorId: 'runtime-behavior', claimId: 'runtime.current',
                    claimType: 'behavioral', factPath: 'runtimeValue', render: 'scalar'
                },
                location: { documentPath: 'docs/runtime.md' }
            }
        ]
    })
    const factObservationDigests = [{
        extractorId: fact.extractorId,
        contentDigest: fact.contentDigest
    }]
    const verification = sealDocClaimVerificationReceipt({
        sourceCommit: commit,
        worktreeFingerprint: fingerprint,
        catalogDigest: catalogHash,
        parseReceiptDigest: claims.contentDigest,
        factObservationDigests,
        results: claims.claims.map((claim) => ({
            claimId: claim.declaration.claimId,
            behaviorId: claim.declaration.behaviorId,
            claimType: claim.declaration.claimType,
            documentPath: claim.location.documentPath,
            documentStatus: 'current',
            factPath: claim.declaration.factPath,
            status: 'verified',
            reason: 'claim matches current fact observation'
        })),
        status: 'ok'
    })
    const generated = sealGeneratedSectionCheckReceipt({
        sourceCommit: commit,
        worktreeFingerprint: fingerprint,
        catalogDigest: catalogHash,
        sectionCatalogDigest: 'b'.repeat(64),
        factObservationDigests,
        sections: [],
        status: 'ok'
    })
    const admission = sealBare({
        schema: 'fsusblog.behavior-doc-static-admission-receipt.v1',
        run: { id: runId },
        source: { commit, worktreeFingerprint: fingerprint },
        worktree: { root: '/repo' },
        toolchain: { node: 'v24', dotnet: '10', platform: 'linux', architecture: 'x64', directoryBuildPropsDigest: '1'.repeat(64) },
        authorityDigests: {
            catalog: catalogHash, claim: claims.contentDigest, extractorRegistry: '9'.repeat(64),
            generatedSectionCatalog: generated.sectionCatalogDigest, generatedRenderer: 'c'.repeat(64),
            proseRenderer: 'd'.repeat(64), mutationCatalog: 'e'.repeat(64)
        },
        implementationOwner: { status: 'ok', bindingCount: 2, contentDigest: owner.contentDigest },
        factObservations: {
            [fact.extractorId]: {
                status: 'ok', extractorDigest: fact.extractorDigest,
                semanticDigest: semanticDigestFromReceipt(fact), contentDigest: fact.contentDigest
            }
        },
        minimalContractBuild: minimalBuildReceipt(),
        generated: { status: 'ok', documentCount: 0, contentDigest: generated.contentDigest },
        prose: { status: 'ok', verifiedClaimCount: 2, contentDigest: verification.contentDigest },
        mutationFixtures: { status: 'ok', caseCount: 1, contentDigest: 'f'.repeat(64) },
        candidateSpawnCountBeforeReceipt: 0,
        status: 'ok', failureReasons: [], durationMs: 1
    }, true)
    const pre = seal({
        schema: 'fsusblog.behavior-evidence-pre-runtime-receipt.v1', scope: 'pre-runtime',
        runIdentity: runId, sourceIdentity: { commit, worktreeFingerprint: `sha256:${fingerprint}` },
        buildIdentities: {}, registryDigest: `sha256:${'9'.repeat(64)}`,
        catalogDigest: `sha256:${catalogHash}`, staticClaimVerificationDigest: `sha256:${verification.contentDigest}`,
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

test('self-consistent substitute static component receipts cannot escape the admission seal', async (context) =>
{
    const cases = [
        {
            name: 'implementation owner from another scan',
            mutate(input)
            {
                const owner = structuredClone(input.ownerReceipt)
                owner.bindings[0].sourcePath = 'src/substitute.cs'
                input.ownerReceipt = sealBare(Object.fromEntries(
                    Object.entries(owner).filter(([key]) => key !== 'contentDigest')
                ))
            },
            expected: /implementation owner receipt does not match static admission/u
        },
        {
            name: 'fact receipt with another semantic observation',
            mutate(input)
            {
                const fact = structuredClone(input.factObservationReceipts[0])
                fact.observations.alphaValue = false
                input.factObservationReceipts = [sealBare(Object.fromEntries(
                    Object.entries(fact).filter(([key]) => key !== 'contentDigest')
                ))]
            },
            expected: /content digest does not match static admission/u
        },
        {
            name: 'DocClaim verification from another component bundle',
            mutate(input)
            {
                const verification = structuredClone(input.docClaimVerificationReceipt)
                verification.results[0].reason = 'substitute verification'
                input.docClaimVerificationReceipt = sealBare(Object.fromEntries(
                    Object.entries(verification).filter(([key]) => key !== 'contentDigest')
                ))
            },
            expected: /DocClaim verification receipt does not match static admission/u
        },
        {
            name: 'generated receipt from another component bundle',
            mutate(input)
            {
                const generated = structuredClone(input.generatedSectionReceipt)
                generated.sections.push({
                    sectionId: 'substitute.section', behaviorId: 'alpha-behavior',
                    documentPath: 'docs/substitute.md', factPath: 'alphaValue',
                    status: 'ok', reason: 'substitute section'
                })
                input.generatedSectionReceipt = sealBare(Object.fromEntries(
                    Object.entries(generated).filter(([key]) => key !== 'contentDigest')
                ))
            },
            expected: /generated section receipt does not match static admission/u
        }
    ]
    for (const scenario of cases)
    {
        await context.test(scenario.name, () =>
        {
            const input = fixture()
            scenario.mutate(input)
            const report = buildFinalConsistencyReport(input)
            assert.equal(report.status, 'failed')
            assert.match(report.failureReasons.join('\n'), scenario.expected)
        })
    }
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
