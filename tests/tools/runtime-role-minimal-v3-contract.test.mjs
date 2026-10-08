import assert from 'node:assert/strict';
import test from 'node:test';

const { validateMinimalContractBuildReceipt } = await import(new URL('../../tools/docs/behavior-doc-minimal-contract-build-v3-contract.mjs', import.meta.url));
const { validateBehaviorDocStaticAdmissionReceipt } = await import(new URL('../../tools/docs/behavior-doc-static-admission-contract.mjs', import.meta.url));
const { digestValue } = await import(new URL('../../tools/fact-extractors/lib/canonicalize.mjs', import.meta.url));
const { root, validatePostRuntimeReaderFirewall } = await import(new URL('../../tools/test-matrix/post-runtime-producer-registry.mjs', import.meta.url));

import { createRuntimeRoleMinimalV3Fixture, createRuntimeRoleMinimalV4Fixture, createRuntimeRoleStaticV3Fixture, createRuntimeRoleStaticV4Fixture } from './support/runtime-role-minimal-v3-fixture.mjs';

const identity = { sourceCommit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) };
const seal = (value) =>
{
    const receipt = { ...structuredClone(value), contentDigest: null };
    receipt.contentDigest = digestValue(receipt);
    return receipt;
};
const fixture = () => createRuntimeRoleMinimalV4Fixture('v3-contract-test', identity);
const options = { expectedRunId: 'v3-contract-test', expectedSourceIdentity: identity };

test('pure receipt contracts reject incomplete identities and non-integer counters without expectations', () =>
{
    const receipt = createRuntimeRoleStaticV3Fixture('v3-contract-test', identity, { repositoryRoot: root });
    const before = structuredClone(receipt);
    assert.equal(validateBehaviorDocStaticAdmissionReceipt(receipt), receipt);
    assert.equal(validateMinimalContractBuildReceipt(receipt.minimalContractBuild), receipt.minimalContractBuild);
    assert.deepEqual(receipt, before);
    const mutations = [
        (value) =>
        {
            value.run.id = '';
        },
        (value) =>
        {
            value.source.commit = 'bad';
        },
        (value) =>
        {
            value.source.worktreeFingerprint = '';
        },
        (value) =>
        {
            value.worktree.root = '';
        },
        ...['node', 'dotnet', 'platform', 'architecture'].map((field) => (value) =>
        {
            value.toolchain[field] = '';
        }),
        (value) =>
        {
            value.implementationOwner.bindingCount = 1.5;
        },
        (value) =>
        {
            value.generated.documentCount = -1;
        },
        (value) =>
        {
            value.prose.verifiedClaimCount = 0.5;
        },
        (value) =>
        {
            value.mutationFixtures.caseCount = 1.5;
        },
        (value) =>
        {
            value.durationMs = -1;
        }
    ];
    for (const mutate of mutations)
    {
        const value = structuredClone(receipt);
        mutate(value);
        assert.throws(() => validateBehaviorDocStaticAdmissionReceipt(seal(value)));
    }
    for (const [field, invalidValues] of [
        ['runId', ['', null, 1, {}]],
        ['sourceCommit', ['', null, 'bad', 'a'.repeat(39), 'a'.repeat(41), 'A'.repeat(40), 'g'.repeat(40)]],
        ['worktreeFingerprint', ['', null, 'bad', 'b'.repeat(63), 'b'.repeat(65), 'B'.repeat(64), 'g'.repeat(64)]]
    ])
    {
        for (const invalidValue of invalidValues)
        {
            const value = structuredClone(receipt.minimalContractBuild);
            value[field] = invalidValue;
            // Keep child bindings consistent so they cannot mask the intrinsic refusal.
            if (field !== 'runId')
            {
                value.artifacts['runtime-role-observation'].buildReceipt[field] = invalidValue;
            }
            const sealed = seal(value);
            const invalidBefore = structuredClone(sealed);
            assert.throws(() => validateMinimalContractBuildReceipt(sealed),
                /run\/source identity is incomplete/u, `${field}: ${JSON.stringify(invalidValue)}`);
            assert.deepEqual(sealed, invalidBefore);
        }
    }
});

test('intrinsic identity checks preserve explicit expected identity refusal order', () =>
{
    const receipt = fixture();
    assert.throws(() => validateMinimalContractBuildReceipt(receipt, { expectedRunId: 'another-run' }),
        /run id mismatch/u);
    for (const source of [
        { ...identity, sourceCommit: 'c'.repeat(40) },
        { ...identity, worktreeFingerprint: 'd'.repeat(64) }
    ])
    {
        assert.throws(() => validateMinimalContractBuildReceipt(receipt, { expectedSourceIdentity: source }),
            /source\/worktree identity mismatch/u);
    }
    const emptyRun = seal({ ...receipt, runId: '' });
    assert.throws(() => validateMinimalContractBuildReceipt(emptyRun, options), /run id mismatch/u);
    const emptySource = structuredClone(receipt);
    emptySource.sourceCommit = '';
    emptySource.artifacts['runtime-role-observation'].buildReceipt.sourceCommit = '';
    assert.throws(() => validateMinimalContractBuildReceipt(seal(emptySource), options),
        /source\/worktree identity mismatch/u);
});

test('pure admission validation requires independent artifact reads when requested', () =>
{
    const receipt = createRuntimeRoleStaticV3Fixture('v3-contract-test', identity, { repositoryRoot: root });
    const expected = { ...options, expectedWorktree: root, expectedExtractorIds: ['runtime-role'], artifactRepositoryRoot: root };
    assert.throws(() => validateBehaviorDocStaticAdmissionReceipt(receipt, expected), /independent artifact reader/u);
    const digests = new Map();
    for (const artifact of Object.values(receipt.minimalContractBuild.artifacts))
    {
        digests.set(artifact.project, artifact.projectDigest);
        digests.set(artifact.path, artifact.artifactDigest);
        if (artifact.assemblyPath)
        {
            digests.set(artifact.assemblyPath, artifact.assemblyDigest);
            digests.set(artifact.deploymentArtifactPath, artifact.deploymentArtifactDigest);
        }
        if (artifact.buildReceipt.openapiPath)
        {
            digests.set(artifact.buildReceipt.openapiPath, artifact.buildReceipt.openapiDigest);
            digests.set(artifact.buildReceipt.openapiArtifactPath, artifact.buildReceipt.openapiDigest);
        }
    }
    const visited = new Set();
    const before = structuredClone(receipt);
    assert.equal(validateBehaviorDocStaticAdmissionReceipt(receipt, {
        ...expected,
        readArtifactDigest: (repositoryRoot, relative) =>
        {
            assert.equal(repositoryRoot, root);
            assert.ok(digests.has(relative));
            visited.add(relative);
            return digests.get(relative);
        }
    }), receipt);
    assert.deepEqual([...visited].sort(), [...digests.keys()].sort());
    assert.deepEqual(receipt, before);
    for (const relative of digests.keys())
    {
        assert.throws(() => validateBehaviorDocStaticAdmissionReceipt(receipt, {
            ...expected,
            readArtifactDigest: (_repositoryRoot, candidate) => candidate === relative ? '0'.repeat(64) : digests.get(candidate)
        }), /digest mismatch/u, relative);
    }
});

test('canonical OpenAPI receipt seals cached and published projection bytes independently', () =>
{
    const receipt = fixture();
    const artifact = receipt.artifacts['openapi-aeds-observation'];
    Object.assign(artifact.buildReceipt, {
        openapiPath: `${receipt.buildRoot}/observations/fsusblog.openapi.observed.json`,
        openapiArtifactPath: '.tmp/contracts/openapi/fsusblog.openapi.observed.json',
        openapiDigest: '8'.repeat(64)
    });
    const sealed = seal(receipt);
    const digests = new Map();
    for (const current of Object.values(sealed.artifacts))
    {
        digests.set(current.project, current.projectDigest);
        digests.set(current.path, current.artifactDigest);
        if (current.assemblyPath)
        {
            digests.set(current.assemblyPath, current.assemblyDigest);
        }
        if (current.deploymentArtifactPath)
        {
            digests.set(current.deploymentArtifactPath, current.deploymentArtifactDigest);
        }
    }
    digests.set(artifact.buildReceipt.openapiPath, artifact.buildReceipt.openapiDigest);
    digests.set(artifact.buildReceipt.openapiArtifactPath, artifact.buildReceipt.openapiDigest);
    const seen = [];
    const withReader = {
        ...options,
        repositoryRoot: root,
        readArtifactDigest: (_repositoryRoot, file) =>
        {
            seen.push(file);
            return digests.get(file);
        }
    };
    assert.equal(validateMinimalContractBuildReceipt(sealed, withReader), sealed);
    for (const file of [artifact.buildReceipt.openapiPath, artifact.buildReceipt.openapiArtifactPath])
    {
        assert.ok(seen.includes(file), file);
        assert.throws(() => validateMinimalContractBuildReceipt(sealed, {
            ...withReader,
            readArtifactDigest: (_repositoryRoot, candidate) => candidate === file ? '0'.repeat(64) : digests.get(candidate)
        }), /projection.*digest mismatch/u);
    }
    for (const mutate of [
        (value) =>
        {
            delete value.openapiPath;
        },
        (value) =>
        {
            value.openapiPath = '.tmp/contracts/openapi/fsusblog.openapi.observed.json';
        },
        (value) =>
        {
            value.openapiArtifactPath = '../outside.json';
        },
        (value) =>
        {
            value.openapiDigest = 'not-a-digest';
        },
        (value) =>
        {
            value.unknown = true;
        }
    ])
    {
        const changed = structuredClone(sealed);
        mutate(changed.artifacts['openapi-aeds-observation'].buildReceipt);
        assert.throws(() => validateMinimalContractBuildReceipt(seal(changed), options), /minimal contract build/u);
    }
});

test('canonical static admission validates the current runtime-role v4 build authority', () =>
{
    const admission = createRuntimeRoleStaticV4Fixture('v3-contract-test', identity, { repositoryRoot: root });
    const expected = { ...options, expectedWorktree: root, expectedExtractorIds: ['runtime-role'] };
    assert.equal(validateBehaviorDocStaticAdmissionReceipt(admission, expected), admission);
    for (const mutate of [
        (value) =>
        {
            value.candidateSpawnCountBeforeReceipt = 1;
        },
        (value) =>
        {
            value.status = 'failed';
        },
        (value) =>
        {
            value.source.commit = 'f'.repeat(40);
        },
        (value) =>
        {
            value.mutationFixtures.caseCount = 0;
        },
        (value) =>
        {
            value.unknown = true;
        },
        (value) =>
        {
            value.minimalContractBuild.artifacts['runtime-role-observation'].buildReceipt.schema = 'fsusblog.runtime-role-observation-build-receipt.v2';
            value.minimalContractBuild = seal(value.minimalContractBuild);
        }
    ])
    {
        const changed = structuredClone(admission);
        mutate(changed);
        assert.throws(() => validateBehaviorDocStaticAdmissionReceipt(seal(changed), expected));
    }
});

test('canonical runtime-role v4 value validator preserves exact build and oracle identity', () =>
{
    const receipt = fixture();
    assert.equal(validateMinimalContractBuildReceipt(receipt, options), receipt);
    assert.equal(receipt.artifacts['runtime-role-observation'].buildReceipt.schema,
        'fsusblog.runtime-role-observation-build-receipt.v4');
    validatePostRuntimeReaderFirewall(root, 'tools/docs/behavior-doc-minimal-contract-build-v3-contract.mjs');
});

test('shared static v4 fixture preserves explicit run, source, extractor and minimal-build inputs', () =>
{
    const source = { sourceCommit: 'c'.repeat(40), worktreeFingerprint: 'd'.repeat(64) };
    const runId = 'shared-static-v3-fixture';
    const minimalContractBuild = createRuntimeRoleMinimalV4Fixture(runId, source);
    const before = structuredClone(minimalContractBuild);
    const extractorIds = ['first-extractor', 'second-extractor'];
    const admission = createRuntimeRoleStaticV4Fixture(runId, source, {
        repositoryRoot: root, extractorIds, minimalContractBuild
    });
    assert.equal(validateBehaviorDocStaticAdmissionReceipt(admission, {
        expectedRunId: runId, expectedSourceIdentity: source,
        expectedWorktree: root, expectedExtractorIds: extractorIds
    }), admission);
    assert.deepEqual(admission.minimalContractBuild, minimalContractBuild);
    assert.notEqual(admission.minimalContractBuild, minimalContractBuild);
    assert.deepEqual(minimalContractBuild, before);
});

test('canonical runtime-role v4 rejects re-sealed legacy, partial and coordinated identity drift', () =>
{
    for (const mutate of [
        (receipt, artifact) =>
        {
            artifact.buildReceipt.schema = 'fsusblog.runtime-role-observation-build-receipt.v2';
        },
        (receipt, artifact) =>
        {
            artifact.buildReceipt.schema = 'fsusblog.runtime-role-observation-build-receipt.v3';
        },
        (receipt, artifact) =>
        {
            artifact.buildReceipt.producer = 'synthetic-test-builder';
        },
        (receipt, artifact) =>
        {
            artifact.buildReceipt.externalOracle = 'internal-yaml-parser';
        },
        (receipt, artifact) =>
        {
            artifact.buildReceipt.externalOracleVersion = '';
        },
        (receipt, artifact) =>
        {
            artifact.buildReceipt.sourceCommit = 'f'.repeat(40);
        },
        (receipt, artifact) =>
        {
            artifact.buildReceipt.projectDigest = 'f'.repeat(64);
        },
        (receipt, artifact) =>
        {
            artifact.buildReceipt.assemblyDigest = 'f'.repeat(64);
        },
        (receipt, artifact) =>
        {
            artifact.buildReceipt.deploymentArtifactDigest = 'f'.repeat(64);
        },
        (receipt, artifact) =>
        {
            artifact.buildReceipt.reproducibleBuild.sourceClosureDigest = 'f'.repeat(64);
        },
        (receipt, artifact) =>
        {
            artifact.buildReceipt.reproducibleBuild.command[11] = '/p:PathMap=untrusted';
        },
        (receipt, artifact) =>
        {
            artifact.buildReceipt.dockerExecutable.canonicalPath = 'docker';
        },
        (receipt, artifact) =>
        {
            artifact.buildReceipt.composeImplementation.digest = 'invalid';
        },
        (receipt, artifact) =>
        {
            delete artifact.deploymentArtifactPath;
        },
        (receipt, artifact) =>
        {
            artifact.buildReceipt.unknown = true;
        },
        (receipt) =>
        {
            delete receipt.artifacts['content-lifecycle-observation'];
        },
        (receipt) =>
        {
            receipt.sourceClosureDigests.push(receipt.sourceClosureDigests[0]);
        },
        (receipt) =>
        {
            receipt.runId = 'another-run';
        },
        (receipt) =>
        {
            receipt.status = 'failed';
        }
    ])
    {
        const receipt = fixture();
        mutate(receipt, receipt.artifacts['runtime-role-observation']);
        assert.throws(() => validateMinimalContractBuildReceipt(seal(receipt), options),
            /minimal contract build/u);
    }
});

test('canonical runtime-role v4 independently checks every project, observation, assembly and deployment digest', () =>
{
    const receipt = fixture();
    const digests = new Map();
    for (const artifact of Object.values(receipt.artifacts))
    {
        digests.set(artifact.project, artifact.projectDigest);
        digests.set(artifact.path, artifact.artifactDigest);
        if (artifact.assemblyPath)
        {
            digests.set(artifact.assemblyPath, artifact.assemblyDigest);
        }
        if (artifact.deploymentArtifactPath)
        {
            digests.set(artifact.deploymentArtifactPath, artifact.deploymentArtifactDigest);
        }
        if (artifact.buildReceipt.openapiPath)
        {
            digests.set(artifact.buildReceipt.openapiPath, artifact.buildReceipt.openapiDigest);
            digests.set(artifact.buildReceipt.openapiArtifactPath, artifact.buildReceipt.openapiDigest);
        }
    }
    const seen = [];
    const withReader = { ...options, repositoryRoot: root, readArtifactDigest: (repositoryRoot, file) =>
    {
        assert.equal(repositoryRoot, root);
        seen.push(file);
        return digests.get(file);
    } };
    validateMinimalContractBuildReceipt(receipt, withReader);
    assert.deepEqual([...new Set(seen)].sort(), [...digests.keys()].sort());
    assert.throws(() => validateMinimalContractBuildReceipt(receipt, { ...options, repositoryRoot: root }),
        /independent artifact reader/u);
    for (const file of digests.keys())
    {
        assert.throws(() => validateMinimalContractBuildReceipt(receipt, {
            ...withReader, readArtifactDigest: (repositoryRoot, candidate) => candidate === file ? '0'.repeat(64) : digests.get(candidate)
        }), /digest mismatch/u);
    }
});

test('canonical runtime-role v4 rejects re-sealed observation and evidence-stage drift', () =>
{
    for (const mutate of [
        (value) => { value.observationSchema = 'fsusblog.runtime-role-observation.v2'; },
        (value) => { value.evidenceStage = 'post-runtime'; },
        (value) => { value.evidenceClass = 'native-qualification'; },
        (value) => { delete value.observationSchema; },
        (value) => { delete value.evidenceStage; },
        (value) => { delete value.evidenceClass; }
    ])
    {
        const receipt = fixture();
        mutate(receipt.artifacts['runtime-role-observation'].buildReceipt);
        assert.throws(() => validateMinimalContractBuildReceipt(seal(receipt), options), /minimal contract build/u);
    }
});

test('explicit historical v3 fixtures remain rejected without relabeling their schema', () =>
{
    const legacyBuild = createRuntimeRoleMinimalV3Fixture('v3-contract-test', identity)
    assert.equal(legacyBuild.artifacts['runtime-role-observation'].buildReceipt.schema,
        'fsusblog.runtime-role-observation-build-receipt.v3')
    assert.throws(() => validateMinimalContractBuildReceipt(legacyBuild, options), /minimal contract build/u)
    const legacyAdmission = createRuntimeRoleStaticV3Fixture('v3-contract-test', identity, { repositoryRoot: root })
    assert.throws(() => validateBehaviorDocStaticAdmissionReceipt(legacyAdmission, {
        ...options, expectedWorktree: root, expectedExtractorIds: ['runtime-role']
    }))
})
