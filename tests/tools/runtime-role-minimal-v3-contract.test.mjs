import assert from 'node:assert/strict'
import test from 'node:test'

import { digestValue } from '../../tools/fact-extractors/lib/canonicalize.mjs'
import { validateMinimalContractBuildReceipt } from '../../tools/docs/behavior-doc-minimal-contract-build-v3-contract.mjs'
import { validateBehaviorDocStaticAdmissionReceipt } from '../../tools/docs/behavior-doc-static-admission-contract.mjs'
import { root, validatePostRuntimeReaderFirewall } from '../../tools/test-matrix/post-runtime-producer-registry.mjs'
import { createRuntimeRoleMinimalV3Fixture, createRuntimeRoleMinimalV4Fixture, createRuntimeRoleStaticV3Fixture, createRuntimeRoleStaticV4Fixture, readRuntimeRoleClaimStageAuthorityFixture } from './support/runtime-role-minimal-v3-fixture.mjs'

const identity = { sourceCommit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) }
const seal = (value) => {
    const receipt = { ...structuredClone(value), contentDigest: null }
    receipt.contentDigest = digestValue(receipt)
    return receipt
}
const fixture = () => createRuntimeRoleMinimalV4Fixture('v3-contract-test', identity)
const options = { expectedRunId: 'v3-contract-test', expectedSourceIdentity: identity }

test('canonical static admission validates the current runtime-role v4 build authority', () =>
{
    const admission = createRuntimeRoleStaticV4Fixture('v3-contract-test', identity, { repositoryRoot: root })
    const expected = { ...options, expectedWorktree: root, expectedExtractorIds: ['runtime-role'],
        expectedClaimStageAuthority: readRuntimeRoleClaimStageAuthorityFixture(root) }
    assert.equal(validateBehaviorDocStaticAdmissionReceipt(admission, expected), admission)
    for (const mutate of [
        (value) => { value.candidateSpawnCountBeforeReceipt = 1 },
        (value) => { value.status = 'failed' },
        (value) => { value.source.commit = 'f'.repeat(40) },
        (value) => { value.mutationFixtures.caseCount = 0 },
        (value) => { value.unknown = true },
        (value) => {
            value.minimalContractBuild.artifacts['runtime-role-observation'].buildReceipt.schema = 'fsusblog.runtime-role-observation-build-receipt.v2'
            value.minimalContractBuild = seal(value.minimalContractBuild)
        }
    ])
    {
        const changed = structuredClone(admission)
        mutate(changed)
        assert.throws(() => validateBehaviorDocStaticAdmissionReceipt(seal(changed), expected))
    }
})

test('canonical runtime-role v4 value validator preserves exact build and oracle identity', () =>
{
    const receipt = fixture()
    assert.equal(validateMinimalContractBuildReceipt(receipt, options), receipt)
    assert.equal(receipt.artifacts['runtime-role-observation'].buildReceipt.schema,
        'fsusblog.runtime-role-observation-build-receipt.v4')
    validatePostRuntimeReaderFirewall(root, 'tools/docs/behavior-doc-minimal-contract-build-v3-contract.mjs')
    validatePostRuntimeReaderFirewall(root, 'tools/docs/behavior-doc-static-admission-contract.mjs')
})

test('pure static admission requires closed complete source materials without authorizing their origin', () =>
{
    const admission = createRuntimeRoleStaticV4Fixture('v3-contract-test', identity, { repositoryRoot: root })
    const authority = readRuntimeRoleClaimStageAuthorityFixture(root)
    const expected = { ...options, expectedWorktree: root, expectedExtractorIds: ['runtime-role'],
        expectedClaimStageAuthority: authority }
    assert.equal(validateBehaviorDocStaticAdmissionReceipt(admission, expected), admission)
    for (const value of [null, {}, { ...authority, extra: true },
        { ...authority, catalog: null }, { ...authority, claimReceipt: null },
        { ...authority, migrationLedger: null }])
    {
        assert.throws(() => validateBehaviorDocStaticAdmissionReceipt(admission, {
            ...expected, expectedClaimStageAuthority: value
        }), /closed expected source materials/u)
    }
    const withoutMaterials = { ...expected }
    delete withoutMaterials.expectedClaimStageAuthority
    assert.throws(() => validateBehaviorDocStaticAdmissionReceipt(admission, withoutMaterials),
        /closed expected source materials/u)
    const changed = structuredClone(authority)
    changed.claimReceipt.claims[0].location.documentPath = 'docs/not-the-source.md'
    assert.throws(() => validateBehaviorDocStaticAdmissionReceipt(admission, {
        ...expected, expectedClaimStageAuthority: changed
    }), /parse receipt mismatch/u)
})

test('shared static v4 fixture preserves explicit run, source, extractor and minimal-build inputs', () =>
{
    const source = { sourceCommit: 'c'.repeat(40), worktreeFingerprint: 'd'.repeat(64) }
    const runId = 'shared-static-v3-fixture'
    const minimalContractBuild = createRuntimeRoleMinimalV4Fixture(runId, source)
    const before = structuredClone(minimalContractBuild)
    const extractorIds = ['first-extractor', 'second-extractor']
    const admission = createRuntimeRoleStaticV4Fixture(runId, source, {
        repositoryRoot: root, extractorIds, minimalContractBuild
    })
    assert.equal(validateBehaviorDocStaticAdmissionReceipt(admission, {
        expectedRunId: runId, expectedSourceIdentity: source,
        expectedWorktree: root, expectedExtractorIds: extractorIds,
        expectedClaimStageAuthority: readRuntimeRoleClaimStageAuthorityFixture(root)
    }), admission)
    assert.deepEqual(admission.minimalContractBuild, minimalContractBuild)
    assert.notEqual(admission.minimalContractBuild, minimalContractBuild)
    assert.deepEqual(minimalContractBuild, before)
})

test('canonical runtime-role v4 rejects re-sealed legacy, partial and coordinated identity drift', () =>
{
    for (const mutate of [
        (receipt, artifact) => { artifact.buildReceipt.schema = 'fsusblog.runtime-role-observation-build-receipt.v2' },
        (receipt, artifact) => { artifact.buildReceipt.schema = 'fsusblog.runtime-role-observation-build-receipt.v3' },
        (receipt, artifact) => { artifact.buildReceipt.producer = 'synthetic-test-builder' },
        (receipt, artifact) => { artifact.buildReceipt.externalOracle = 'internal-yaml-parser' },
        (receipt, artifact) => { artifact.buildReceipt.externalOracleVersion = '' },
        (receipt, artifact) => { artifact.buildReceipt.sourceCommit = 'f'.repeat(40) },
        (receipt, artifact) => { artifact.buildReceipt.projectDigest = 'f'.repeat(64) },
        (receipt, artifact) => { artifact.buildReceipt.assemblyDigest = 'f'.repeat(64) },
        (receipt, artifact) => { artifact.buildReceipt.deploymentArtifactDigest = 'f'.repeat(64) },
        (receipt, artifact) => { artifact.buildReceipt.reproducibleBuild.sourceClosureDigest = 'f'.repeat(64) },
        (receipt, artifact) => { artifact.buildReceipt.reproducibleBuild.command[11] = '/p:PathMap=untrusted' },
        (receipt, artifact) => { artifact.buildReceipt.dockerExecutable.canonicalPath = 'docker' },
        (receipt, artifact) => { artifact.buildReceipt.composeImplementation.digest = 'invalid' },
        (receipt, artifact) => { delete artifact.deploymentArtifactPath },
        (receipt, artifact) => { artifact.buildReceipt.unknown = true },
        (receipt) => { delete receipt.artifacts['content-lifecycle-observation'] },
        (receipt) => { receipt.sourceClosureDigests.push(receipt.sourceClosureDigests[0]) },
        (receipt) => { receipt.runId = 'another-run' },
        (receipt) => { receipt.status = 'failed' }
    ])
    {
        const receipt = fixture()
        mutate(receipt, receipt.artifacts['runtime-role-observation'])
        assert.throws(() => validateMinimalContractBuildReceipt(seal(receipt), options),
            /minimal contract build/u)
    }
})

test('canonical runtime-role v4 independently checks every project, observation, assembly and deployment digest', () =>
{
    const receipt = fixture()
    const digests = new Map()
    for (const artifact of Object.values(receipt.artifacts))
    {
        digests.set(artifact.project, artifact.projectDigest)
        digests.set(artifact.path, artifact.artifactDigest)
        if (artifact.assemblyPath) digests.set(artifact.assemblyPath, artifact.assemblyDigest)
        if (artifact.deploymentArtifactPath) digests.set(artifact.deploymentArtifactPath, artifact.deploymentArtifactDigest)
    }
    const seen = []
    const withReader = { ...options, repositoryRoot: root, readArtifactDigest: (repositoryRoot, file) => {
        assert.equal(repositoryRoot, root)
        seen.push(file)
        return digests.get(file)
    } }
    validateMinimalContractBuildReceipt(receipt, withReader)
    assert.deepEqual([...new Set(seen)].sort(), [...digests.keys()].sort())
    assert.throws(() => validateMinimalContractBuildReceipt(receipt, { ...options, repositoryRoot: root }),
        /independent artifact reader/u)
    for (const file of digests.keys())
        assert.throws(() => validateMinimalContractBuildReceipt(receipt, {
            ...withReader, readArtifactDigest: (repositoryRoot, candidate) => candidate === file ? '0'.repeat(64) : digests.get(candidate)
        }), /digest mismatch/u)
})

test('explicit historical v3 fixtures remain rejected without relabeling their schema', () =>
{
    const legacyBuild = createRuntimeRoleMinimalV3Fixture('v3-contract-test', identity)
    assert.equal(legacyBuild.artifacts['runtime-role-observation'].buildReceipt.schema,
        'fsusblog.runtime-role-observation-build-receipt.v3')
    assert.throws(() => validateMinimalContractBuildReceipt(legacyBuild, options), /minimal contract build/u)
    const legacyAdmission = createRuntimeRoleStaticV3Fixture('v3-contract-test', identity, { repositoryRoot: root })
    assert.throws(() => validateBehaviorDocStaticAdmissionReceipt(legacyAdmission, {
        ...options, expectedWorktree: root, expectedExtractorIds: ['runtime-role'],
        expectedClaimStageAuthority: readRuntimeRoleClaimStageAuthorityFixture(root)
    }))
})
