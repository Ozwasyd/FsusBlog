import assert from 'node:assert/strict'
import test from 'node:test'

import { digestValue } from '../../tools/fact-extractors/lib/canonicalize.mjs'
import { validateMinimalContractBuildReceipt } from '../../tools/docs/behavior-doc-minimal-contract-build-v3-contract.mjs'
import { root, validatePostRuntimeReaderFirewall } from '../../tools/test-matrix/post-runtime-producer-registry.mjs'
import { createRuntimeRoleMinimalV3Fixture } from './support/runtime-role-minimal-v3-fixture.mjs'

const identity = { sourceCommit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) }
const seal = (value) => {
    const receipt = { ...structuredClone(value), contentDigest: null }
    receipt.contentDigest = digestValue(receipt)
    return receipt
}
const fixture = () => createRuntimeRoleMinimalV3Fixture('v3-contract-test', identity)
const options = { expectedRunId: 'v3-contract-test', expectedSourceIdentity: identity }

test('canonical runtime-role v3 value validator preserves exact build and oracle identity', () =>
{
    const receipt = fixture()
    assert.equal(validateMinimalContractBuildReceipt(receipt, options), receipt)
    assert.equal(receipt.artifacts['runtime-role-observation'].buildReceipt.schema,
        'fsusblog.runtime-role-observation-build-receipt.v3')
    validatePostRuntimeReaderFirewall(root, 'tools/docs/behavior-doc-minimal-contract-build-v3-contract.mjs')
})

test('canonical runtime-role v3 rejects re-sealed legacy, partial and coordinated identity drift', () =>
{
    for (const mutate of [
        (receipt, artifact) => { artifact.buildReceipt.schema = 'fsusblog.runtime-role-observation-build-receipt.v2' },
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

test('canonical runtime-role v3 independently checks every project, observation, assembly and deployment digest', () =>
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
