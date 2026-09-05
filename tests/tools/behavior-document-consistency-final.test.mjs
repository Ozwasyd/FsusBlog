import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import fs from 'node:fs'
import { authorityDigest, loadPostRuntimeProducerRegistry } from '../../tools/test-matrix/post-runtime-producer-registry.mjs'

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
