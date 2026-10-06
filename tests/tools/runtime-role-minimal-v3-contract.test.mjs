import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import { readRuntimeRoleExecutionClosure as readPhysicalExecutionClosure } from '../../tools/fact-extractors/lib/runtime-role-execution-closure.mjs';
import { readPinnedRepositoryFile } from '../../tools/test-matrix/post-runtime-producer-registry.mjs';

import { runtimeRoleRequiredExecutionFiles, runtimeReproduciblePathMapArgument, validateRuntimeRoleExecutionClosure } from '../../tools/docs/behavior-doc-minimal-contract-build-v3-contract.mjs';

const { validateMinimalContractBuildReceipt } = await import(new URL('../../tools/docs/behavior-doc-minimal-contract-build-v3-contract.mjs', import.meta.url));
const { validateBehaviorDocStaticAdmissionReceipt } = await import(new URL('../../tools/docs/behavior-doc-static-admission-contract.mjs', import.meta.url));
const { digestValue } = await import(new URL('../../tools/fact-extractors/lib/canonicalize.mjs', import.meta.url));
const { root, validatePostRuntimeReaderFirewall } = await import(new URL('../../tools/test-matrix/post-runtime-producer-registry.mjs', import.meta.url));

import { createRuntimeRoleMinimalV3Fixture, createRuntimeRoleMinimalV4Fixture, createRuntimeRoleStaticV3Fixture, createRuntimeRoleStaticV4Fixture } from './support/runtime-role-minimal-v3-fixture.mjs';

function readRuntimeRoleExecutionClosure(repositoryRoot, assemblyPath)
{
    return readPhysicalExecutionClosure(repositoryRoot, assemblyPath, readPinnedRepositoryFile);
}

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
    const receipt = createRuntimeRoleStaticV4Fixture('v3-contract-test', identity, { repositoryRoot: root });
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
    const receipt = createRuntimeRoleStaticV4Fixture('v3-contract-test', identity, { repositoryRoot: root });
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
        readExecutionClosure: () => receipt.minimalContractBuild.artifacts['runtime-role-observation'].buildReceipt.reproducibleBuild.executionClosure,
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
            readExecutionClosure: () => receipt.minimalContractBuild.artifacts['runtime-role-observation'].buildReceipt.reproducibleBuild.executionClosure,
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
        readExecutionClosure: () => receipt.artifacts['runtime-role-observation'].buildReceipt.reproducibleBuild.executionClosure,
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
    const withReader = { ...options, repositoryRoot: root,
        readExecutionClosure: () => receipt.artifacts['runtime-role-observation'].buildReceipt.reproducibleBuild.executionClosure, readArtifactDigest: (repositoryRoot, file) =>
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


function physicalExecutionFixture(t)
{
    const temporaryRoot = path.join(root, '.tmp');
    fs.mkdirSync(temporaryRoot, { recursive: true });
    const directory = fs.mkdtempSync(path.join(temporaryRoot, 'runtime-execution-closure-source-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const receipt = fixture();
    const binding = receipt.artifacts['runtime-role-observation'];
    const output = path.posix.dirname(binding.assemblyPath);
    fs.mkdirSync(path.join(directory, output), { recursive: true });
    for (const file of runtimeRoleRequiredExecutionFiles)
    {
        fs.writeFileSync(path.join(directory, output, file), `source fixture only: ${file}`);
    }
    const closure = readRuntimeRoleExecutionClosure(directory, binding.assemblyPath);
    binding.assemblyDigest = closure.find((entry) => entry.path === 'FsusBlog.RuntimeRoleObservation.dll').digest;
    binding.buildReceipt.assemblyDigest = binding.assemblyDigest;
    Object.assign(binding.buildReceipt.reproducibleBuild, { assemblyDigest: binding.assemblyDigest, executionClosure: closure });
    return { directory, receipt: seal(receipt), binding, output, closure };
}

test('execution closure value contract rejects missing, malformed and resealed partial rosters', () =>
{
    const receipt = fixture();
    const binding = receipt.artifacts['runtime-role-observation'];
    assert.equal(validateRuntimeRoleExecutionClosure(binding.buildReceipt.reproducibleBuild.executionClosure,
        binding.assemblyDigest), binding.buildReceipt.reproducibleBuild.executionClosure);
    const mutations = [
        (closure) => closure.pop(), (closure) => closure.reverse(),
        (closure) => closure.push({ ...closure.at(-1) }),
        (closure) => { closure[0].path = '../escape'; },
        (closure) => { closure[0].path = '/absolute'; },
        (closure) => { closure[0].path = 'a//b'; },
        (closure) => { closure[0].path = 'a\\b'; },
        (closure) => { closure[0].mode = 0o1000; },
        (closure) => { closure[0].mode = 1.5; },
        (closure) => { closure[0].digest = '0'; },
        (closure) => { closure[0].extra = true; },
        (closure) => { closure.find((entry) => entry.path === 'FsusBlog.RuntimeRoleObservation.dll').digest = 'f'.repeat(64); }
    ];
    for (const mutate of mutations)
    {
        const changed = structuredClone(receipt);
        mutate(changed.artifacts['runtime-role-observation'].buildReceipt.reproducibleBuild.executionClosure);
        assert.throws(() => validateMinimalContractBuildReceipt(seal(changed)), /execution closure/u);
    }
    const digests = new Map(Object.values(receipt.artifacts).flatMap((artifact) => [
        [artifact.project, artifact.projectDigest], [artifact.path, artifact.artifactDigest],
        [artifact.assemblyPath, artifact.assemblyDigest], [artifact.deploymentArtifactPath, artifact.deploymentArtifactDigest],
        [artifact.buildReceipt.openapiPath, artifact.buildReceipt.openapiDigest],
        [artifact.buildReceipt.openapiArtifactPath, artifact.buildReceipt.openapiDigest]
    ]));
    assert.throws(() => validateMinimalContractBuildReceipt(receipt, {
        repositoryRoot: root, readArtifactDigest: (_root, file) => digests.get(file)
    }), /independent execution closure reader/u);
    assert.throws(() => validateMinimalContractBuildReceipt(receipt, {
        repositoryRoot: root, readArtifactDigest: (_root, file) => digests.get(file),
        readExecutionClosure: () => [...binding.buildReceipt.reproducibleBuild.executionClosure,
            { path: 'extra.dll', mode: 0o644, digest: 'f'.repeat(64) }]
    }), /execution closure digest mismatch/u);
});

test('execution closure physical reader binds dependent bytes modes extra files and no-follow paths', (t) =>
{
    const fixture = physicalExecutionFixture(t);
    const read = () => readRuntimeRoleExecutionClosure(fixture.directory, fixture.binding.assemblyPath);
    const server = path.join(fixture.directory, fixture.output, 'FsusBlog.Server.dll');
    const originalBytes = fs.readFileSync(server);
    const originalMode = fs.statSync(server).mode & 0o777;
    assert.throws(() => readPhysicalExecutionClosure(fixture.directory, fixture.binding.assemblyPath),
        /independent physical file reader/u);
    const foreignRoot = path.join(fixture.directory, 'foreign-root');
    fs.mkdirSync(path.join(foreignRoot, path.posix.dirname(fixture.output)), { recursive: true });
    fs.cpSync(path.join(fixture.directory, fixture.output), path.join(foreignRoot, fixture.output), { recursive: true });
    assert.throws(() => readPhysicalExecutionClosure(fixture.directory, fixture.binding.assemblyPath,
        (_repositoryRoot, relative, label) => readPinnedRepositoryFile(foreignRoot, relative, label)), /different file/u);
    assert.deepEqual(read(), fixture.closure);
    fs.writeFileSync(server, 'changed dependency only');
    assert.notEqual(digestValue(read()), digestValue(fixture.closure));
    fs.writeFileSync(server, originalBytes);
    fs.chmodSync(server, originalMode ^ 0o100);
    assert.notEqual(digestValue(read()), digestValue(fixture.closure));
    fs.chmodSync(server, originalMode);
    const extra = path.join(fixture.directory, fixture.output, 'extra.dll');
    fs.writeFileSync(extra, 'extra source fixture');
    assert.notEqual(digestValue(read()), digestValue(fixture.closure));
    fs.unlinkSync(extra);
    fs.linkSync(server, extra);
    assert.throws(read, /regular single-link/u);
    fs.unlinkSync(extra);
    fs.renameSync(server, extra);
    fs.symlinkSync(extra, server);
    assert.throws(read, /symbolic link/u);
    fs.unlinkSync(server);
    fs.renameSync(extra, server);
    const ancestorLink = path.join(fixture.directory, 'linked-output');
    fs.symlinkSync(path.join(fixture.directory, fixture.output), ancestorLink);
    assert.throws(() => readRuntimeRoleExecutionClosure(fixture.directory,
        'linked-output/FsusBlog.RuntimeRoleObservation.dll'), /symbolic link/u);
    assert.throws(() => readRuntimeRoleExecutionClosure(fixture.directory,
        '../escape/FsusBlog.RuntimeRoleObservation.dll'), /canonical relative/u);
    const originalRead = fs.readFileSync;
    let swapped = false;
    fs.readFileSync = (descriptor, ...args) => {
        const bytes = originalRead(descriptor, ...args);
        if (typeof descriptor === 'number' && !swapped)
        {
            swapped = true;
            const firstFile = path.join(fixture.directory, fixture.output, fixture.closure[0].path);
            const replacement = `${firstFile}.replacement`;
            fs.writeFileSync(replacement, originalRead(firstFile));
            fs.renameSync(replacement, firstFile);
        }
        return bytes;
    };
    try { assert.throws(read, /changed.*read|different file/u); }
    finally { fs.readFileSync = originalRead; }
    fs.unlinkSync(server);
    assert.throws(() => validateRuntimeRoleExecutionClosure(read(), fixture.binding.assemblyDigest), /required files/u);
});

test('execution closure original verifier body reopens cached dependencies and checks independent whole rebuild', (t) =>
{
    const fixture = physicalExecutionFixture(t);
    const source = fs.readFileSync(path.join(root, 'tools/fact-extractors/test-matrix/extract.mjs'), 'utf8');
    const body = source.slice(source.indexOf('function verifyRuntimeReproducibleBuild('),
        source.indexOf('function sortedUniqueStrings('));
    let builds = 0;
    let cleanup = 0;
    let differentDependency = false;
    const memo = new Map();
    const verify = vm.runInNewContext(`${body}; verifyRuntimeReproducibleBuild`, {
        path, digestValue, readRuntimeRoleExecutionClosure, validateRuntimeRoleExecutionClosure,
        runtimeReproduciblePathMapArgument, verifiedRuntimeAttestations: memo,
        exactKeys: (value, keys) => Object.keys(value).sort().join('\0') === [...keys].sort().join('\0'),
        reproduceRuntimeRoleAssembly: ({ verification }) => {
            assert.equal(verification, true);
            builds += 1;
            const attested = fixture.binding.buildReceipt.reproducibleBuild;
            const reproduced = structuredClone(attested);
            delete reproduced.sourceClosureDigest;
            const verifierOutput = `.tmp/runtime-role-verifier-builds/${fixture.receipt.buildKey}-${process.pid}`;
            reproduced.command = reproduced.command.map((argument) => argument === reproduced.outputRoot ? verifierOutput : argument);
            reproduced.outputRoot = verifierOutput;
            reproduced.assemblyPath = path.posix.join(verifierOutput, path.posix.relative(attested.outputRoot, attested.assemblyPath));
            if (differentDependency) reproduced.executionClosure.find((entry) => entry.path === 'FsusBlog.Server.dll').digest = 'f'.repeat(64);
            return reproduced;
        },
        removeRuntimeRoleVerificationBuild: () => { cleanup += 1; }
    });
    verify(fixture.directory, fixture.binding, fixture.receipt);
    verify(fixture.directory, fixture.binding, fixture.receipt);
    assert.equal(builds, 1);
    assert.equal(cleanup, 1);
    fs.writeFileSync(path.join(fixture.directory, fixture.output, 'FsusBlog.Server.dll'), 'changed after cached verification');
    assert.throws(() => verify(fixture.directory, fixture.binding, fixture.receipt), /execution closure/u);
    assert.equal(builds, 1);
    fs.writeFileSync(path.join(fixture.directory, fixture.output, 'FsusBlog.Server.dll'), 'source fixture only: FsusBlog.Server.dll');
    memo.clear();
    differentDependency = true;
    assert.throws(() => verify(fixture.directory, fixture.binding, fixture.receipt), /canonical reproducible build/u);
    assert.equal(builds, 2);
    assert.equal(cleanup, 2);
    assert.equal(memo.size, 0);
});


test('execution closure owned admission reader overrides caller callbacks and rejects dependent physical drift', async (t) =>
{
    const fixture = physicalExecutionFixture(t);
    const receipt = structuredClone(fixture.receipt);
    const write = (file, bytes) => {
        fs.mkdirSync(path.dirname(path.join(fixture.directory, file)), { recursive: true });
        fs.writeFileSync(path.join(fixture.directory, file), bytes);
        return createHash('sha256').update(bytes).digest('hex');
    };
    for (const artifact of Object.values(receipt.artifacts))
    {
        artifact.projectDigest = write(artifact.project, 'source project fixture only');
        artifact.artifactDigest = write(artifact.path, 'source observation fixture only');
        artifact.buildReceipt.artifactDigest = artifact.artifactDigest;
        if (artifact.assemblyPath)
        {
            artifact.deploymentArtifactDigest = write(artifact.deploymentArtifactPath, 'source deployment fixture only');
            artifact.buildReceipt.projectDigest = artifact.projectDigest;
            artifact.buildReceipt.deploymentArtifactDigest = artifact.deploymentArtifactDigest;
        }
        if (artifact.buildReceipt.openapiPath)
        {
            artifact.buildReceipt.openapiDigest = write(artifact.buildReceipt.openapiPath, 'source openapi fixture only');
            write(artifact.buildReceipt.openapiArtifactPath, 'source openapi fixture only');
        }
    }
    const admission = createRuntimeRoleStaticV4Fixture('v3-contract-test', identity, {
        repositoryRoot: fixture.directory, minimalContractBuild: seal(receipt)
    });
    const { validateBehaviorDocStaticAdmissionReceipt: readOwned } = await import('../../tools/docs/behavior-doc-static-admission-reader.mjs');
    const expected = {
        artifactRepositoryRoot: fixture.directory,
        readArtifactDigest: () => assert.fail('caller digest substitution'),
        readExecutionClosure: () => assert.fail('caller closure substitution')
    };
    assert.equal(readOwned(admission, expected), admission);
    fs.writeFileSync(path.join(fixture.directory, fixture.output, 'FsusBlog.Server.dll'), 'dependent bytes changed');
    assert.throws(() => readOwned(admission, expected), /execution closure digest mismatch/u);
});


test('execution closure preserves the actual post-runtime reader firewall without an allowlist change', () =>
{
    validatePostRuntimeReaderFirewall(root);
});


test('execution closure original runner service captures its root and OpenAPI refuses a missing closure capability', async (t) =>
{
    const fixture = physicalExecutionFixture(t);
    const { buildIdentitySchema, digestPath, resolveContainedPath, validateBuildIdentity } =
        await import('../../tools/fact-extractors/identity.mjs');
    const runnerSource = fs.readFileSync(path.join(root, 'tools/fact-extractors/runner.mjs'), 'utf8');
    const start = runnerSource.indexOf('minimalBuildServices: {') + 'minimalBuildServices: '.length;
    const end = runnerSource.indexOf('\n        }\n    });', start) + '\n        }'.length;
    assert.ok(start > 0 && end > start);
    const services = vm.runInNewContext(`(${runnerSource.slice(start, end)})`, {
        buildIdentitySchema, digestPath, resolveContainedPath, validateBuildIdentity,
        minimalBuildReceiptValidator: validateMinimalContractBuildReceipt,
        repositoryRoot: fixture.directory, path,
        readRuntimeRoleExecutionClosure: readPhysicalExecutionClosure, readPinnedRepositoryFile,
        fail: (message) => { throw new Error(message); }
    });
    assert.deepEqual(services.readExecutionClosure(fixture.directory, fixture.binding.assemblyPath), fixture.closure);
    assert.throws(() => services.readExecutionClosure(root, fixture.binding.assemblyPath), /differs from its actual runner/u);
    const openApiSource = fs.readFileSync(path.join(root, 'tools/fact-extractors/openapi-aeds/extract.mjs'), 'utf8');
    const body = openApiSource.slice(openApiSource.indexOf('function validateCanonicalMinimalReceipt('),
        openApiSource.indexOf('const encodedKey ='));
    const validate = vm.runInNewContext(`${body}; validateCanonicalMinimalReceipt`, {
        path, expectedArtifactId: 'openapi-aeds-observation', readFileSync: fs.readFileSync
    });
    const result = validate({ minimalBuildServices: { ...services, readExecutionClosure: undefined } });
    assert.match(result.failureReasons[0], /validation capability is missing/u);
    assert.equal(result.receipt, null);
});
