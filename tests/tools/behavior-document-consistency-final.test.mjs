import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { authorityDigest, loadPostRuntimeProducerRegistry } from '../../tools/test-matrix/post-runtime-producer-registry.mjs'

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
    buildVerifiedFinalConsistencyReport,
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
    // Complete current graph, but synthetic component evidence: never qualification.
    const catalog = JSON.parse(fs.readFileSync(new URL('../../config/contracts/behavior-contracts.json', import.meta.url), 'utf8'))
    const registry = loadPostRuntimeProducerRegistry()
    const active = catalog.contracts.filter((entry) => entry.status === 'active' && entry.releaseQualification)
    const preContracts = active.filter((entry) => entry.evidenceStage === 'pre-runtime')
    const catalogHash = digestCatalog(catalog)
    const owner = sealOwnerBindingReceipt({
        schema: 'fsusblog.behavior-owner-binding-receipt.v1',
        catalogDigest: catalogHash,
        worktreeDigest: fingerprint,
        status: 'ok',
        bindingCount: active.length,
        bindings: active.map((entry) => ({
            behaviorId: entry.id, language: 'csharp', sourcePath: 'src/fixture.cs',
            symbol: 'Fixture', bindingKind: 'attribute', sourceDigest: '6'.repeat(64),
            catalogDigest: catalogHash, worktreeDigest: fingerprint, status: 'ok'
        })),
        errors: []
    })
    const facts = [...new Set(active.map((entry) => entry.factExtractorId))].map((extractorId) =>
        buildFactObservationReceipt({
            extractorId,
            behaviorIds: active.filter((entry) => entry.factExtractorId === extractorId).map((entry) => entry.id),
            sourceCommit: commit, worktreeFingerprint: fingerprint, buildIdentity: null,
            extractorDigest: '8'.repeat(64), registryDigest: '9'.repeat(64),
            consumedInputDigests: [{ path: 'config/fixture.json', digest: 'a'.repeat(64) }],
            observations: { alphaValue: true }, status: 'ok'
        }))
    const claims = sealBare({
        schema: 'fsusblog.doc-claim-parse-receipt.v1',
        digestAlgorithm: 'sha256',
        canonicalSerialization: 'json-utf8-v1',
        behaviorCatalogDigest: catalogHash,
        claims: active.map((entry) => ({
            declaration: {
                behaviorId: entry.id, claimId: `${entry.id}.fixture`,
                claimType: 'behavioral', factPath: 'alphaValue', render: 'scalar'
            },
            location: { documentPath: entry.documents?.[0] ?? 'docs/fixture.md' }
        }))
    })
    const factObservationDigests = facts.map((fact) => ({
        extractorId: fact.extractorId, contentDigest: fact.contentDigest
    }))
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
        implementationOwner: { status: 'ok', bindingCount: active.length, contentDigest: owner.contentDigest },
        factObservations: Object.fromEntries(facts.map((fact) => [fact.extractorId, {
            status: 'ok', extractorDigest: fact.extractorDigest,
            semanticDigest: semanticDigestFromReceipt(fact), contentDigest: fact.contentDigest
        }])),
        minimalContractBuild: minimalBuildReceipt(),
        generated: { status: 'ok', documentCount: 0, contentDigest: generated.contentDigest },
        prose: { status: 'ok', verifiedClaimCount: claims.claims.length, contentDigest: verification.contentDigest },
        mutationFixtures: { status: 'ok', caseCount: 1, contentDigest: 'f'.repeat(64) },
        candidateSpawnCountBeforeReceipt: 0,
        status: 'ok', failureReasons: [], durationMs: 1
    }, true)
    const pre = seal({
        schema: 'fsusblog.behavior-evidence-pre-runtime-receipt.v1', scope: 'pre-runtime',
        runIdentity: runId, sourceIdentity: { commit, worktreeFingerprint: `sha256:${fingerprint}` },
        buildIdentities: {}, registryDigest: `sha256:${'9'.repeat(64)}`,
        catalogDigest: `sha256:${catalogHash}`, staticClaimVerificationDigest: `sha256:${verification.contentDigest}`,
        behaviorIds: preContracts.map((entry) => entry.id),
        requiredTestKinds: Object.fromEntries(preContracts.map((entry) => [entry.id, entry.requiredTestKinds])),
        observedTestKinds: Object.fromEntries(preContracts.map((entry) => [entry.id, entry.requiredTestKinds])),
        mutationStatus: Object.fromEntries(active.filter((entry) => entry.mutationPolicy?.mutationRequired)
            .map((entry) => [entry.id, { qualified: true, mutationStatus: 'passed' }])),
        runtimeCandidateSpawnCountBeforeReceipt: 0, status: 'ok', failureReasons: []
    })
    const reference = (name, contentDigest = authorityDigest({ name })) => ({
        ref: `.tmp/current-run/${name}.json`, fileDigest: authorityDigest({ bytes: name }), contentDigest
    })
    const results = registry.producers.flatMap((producer) =>
        [...new Set(Object.values(producer.requiredObservations).flat())].sort().map((classId) => ({
            behaviorId: producer.behaviorId, producerId: producer.producerId,
            extractorId: catalog.contracts.find((entry) => entry.id === producer.behaviorId).factExtractorId,
            classId, status: 'ok', contentDigest: authorityDigest({ classId })
        })))
    const producerClasses = Object.fromEntries(registry.producers.map((producer) => [producer.producerId,
        results.filter((result) => result.producerId === producer.producerId).map((result) => result.classId)]))
    const post = seal({
        schema: 'fsusblog.behavior-evidence-post-runtime-receipt.v1', scope: 'post-runtime',
        runIdentity: runId, sourceIdentity: { commit, worktreeFingerprint: `sha256:${fingerprint}` },
        candidateIdentity: {
            sourceCommit: commit, worktreeFingerprint: `sha256:${fingerprint}`,
            buildIdentity: authorityDigest({ build: 1 }), artifactDigest: authorityDigest({ artifact: 1 }),
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
        documentClaimDigests: Object.fromEntries(registry.producers.flatMap((producer) => producer.acceptedClaimRefs.map((claimId) => [claimId, authorityDigest({ claimId })]))),
        documentClaimTerminals: Object.fromEntries(registry.producers.map((producer) => [producer.behaviorId, authorityDigest({ terminal: 1 })])),
        observationRefs: results.map((result) => reference(result.classId, result.contentDigest)),
        acceptedClaimRefs: registry.producers.map((producer) => reference(producer.producerId)),
        missing: [], orphans: [], conflicts: [], stale: [], diagnostics: [],
        findingCounts: { missing: 0, orphans: 0, conflicts: 0, stale: 0, diagnostics: 0 },
        releaseFinalSpawnCountBeforeReceipt: 0, status: 'ok', failureReasons: []
    })
    const migrationLedger = { schema: 'fixture', scopes: [{ scopeId: 'fixture', entries: active.map((entry) => ({
        behaviorId: entry.id, documentPath: entry.documents?.[0] ?? 'docs/fixture.md',
        claimIds: [`${entry.id}.fixture`], generatedSectionIds: []
    })) }] }
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
                input.factObservationReceipts[0] = sealBare(Object.fromEntries(
                    Object.entries(fact).filter(([key]) => key !== 'contentDigest')
                ))
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

test('post-runtime seal must bind the exact pre-runtime receipt and the complete class graph', async (context) =>
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
            expected: /exact-match joined results|schema validation failed/u,
            rejects: true
        },
        {
            name: 'nullable candidate identity in an ok seal',
            mutate(post)
            {
                post.candidateIdentity.candidateId = null
            },
            expected: /schema validation failed/u,
            rejects: true
        },
        {
            name: 'one class missing from a multi-class behavior',
            mutate(post)
            {
                post.observedBehaviorResults.pop()
            },
            expected: /exact-match joined results/u,
            rejects: true
        },
        {
            name: 'missing individually accepted claim',
            mutate(post)
            {
                delete post.documentClaimDigests[Object.keys(post.documentClaimDigests)[0]]
            },
            expected: /post-runtime document claim IDs does not match/u
        },
        {
            name: 'orphan individually accepted claim',
            mutate(post)
            {
                post.documentClaimDigests['orphan.claim'] = authorityDigest({ orphan: true })
            },
            expected: /post-runtime document claim IDs does not match/u
        },
        {
            name: 'legacy behavior-keyed aggregate does not replace accepted claims',
            mutate(post)
            {
                post.documentClaimDigests = Object.fromEntries(post.behaviorIds.map((id) =>
                    [id, authorityDigest({ staticBundle: true })]))
            },
            expected: /post-runtime document claim IDs does not match/u
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
            if (scenario.rejects)
            {
                assert.throws(() => buildFinalConsistencyReport(input), scenario.expected)
                return
            }
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

test('formal terminal rejects in-memory qualification and sealed reports without raw current inputs', () =>
{
    const input = fixture()
    assert.equal(buildFinalConsistencyReport(input).status, 'ok')
    assert.throws(() => buildVerifiedFinalConsistencyReport(input), /explicit post-runtime and pre-runtime receipt paths/u)
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-terminal-raw-'))
    try
    {
        const post = path.join(directory, 'post.json')
        fs.writeFileSync(post, JSON.stringify(input.postRuntimeReceipt))
        assert.throws(() => buildVerifiedFinalConsistencyReport({
            ...input, postRuntimeReceipt: post, preRuntimeReceipt: path.join(directory, 'pre.json')
        }), /outside|contained|repository|current/u)
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true })
    }
})

test('formal terminal CLI cannot publish a self-consistent seal whose referenced raw evidence is missing', () =>
{
    fs.mkdirSync(new URL('../../.tmp/', import.meta.url), { recursive: true })
    const directory = fs.mkdtempSync(new URL('../../.tmp/terminal-raw-', import.meta.url))
    try
    {
        const input = fixture()
        const post = path.join(directory, 'post.json')
        const pre = path.join(directory, 'pre.json')
        const output = path.join(directory, 'report.json')
        fs.writeFileSync(post, JSON.stringify(input.postRuntimeReceipt))
        fs.writeFileSync(pre, JSON.stringify(input.preRuntimeReceipt))
        const result = spawnSync(process.execPath, [
            new URL('../../tools/docs/behavior-document-consistency-final.mjs', import.meta.url).pathname,
            '--post-runtime', post, '--pre-runtime', pre, '--out', output
        ], { encoding: 'utf8' })
        assert.equal(result.status, 1)
        assert.match(result.stderr, /ENOENT|missing/u)
        assert.equal(fs.existsSync(output), false)
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true })
    }
})
