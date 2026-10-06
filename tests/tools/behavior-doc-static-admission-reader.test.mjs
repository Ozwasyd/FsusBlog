import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createRuntimeRoleStaticV3Fixture } from './support/runtime-role-minimal-v3-fixture.mjs';

const { readBehaviorDocStaticAdmissionReceipt, validateBehaviorDocStaticAdmissionReceipt } = await import(new URL('../../tools/docs/behavior-doc-static-admission.mjs', import.meta.url));
const { digestPath, digestValue } = await import(new URL('../../tools/fact-extractors/identity.mjs', import.meta.url));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const identity = { sourceCommit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) };
const runId = 'physical-admission-reader-test';

function ownedDirectory(t)
{
    const temporaryRoot = path.join(root, '.tmp');
    fs.mkdirSync(temporaryRoot, { recursive: true });
    const directory = fs.mkdtempSync(path.join(temporaryRoot, 'physical-admission-reader-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}

function seal(value)
{
    const receipt = { ...structuredClone(value), contentDigest: null };
    receipt.contentDigest = digestValue(receipt);
    return receipt;
}

// Disposable source fixtures exercise the actual reader, never SDK qualification.
function materializeArtifacts(directory, receipt)
{
    const files = new Map();
    const write = (relative) =>
    {
        const bytes = `owned source fixture: ${relative}\n`;
        const absolute = path.join(directory, relative);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, bytes);
        files.set(relative, bytes);
        return digestPath(directory, relative);
    };
    for (const artifact of Object.values(receipt.minimalContractBuild.artifacts))
    {
        artifact.projectDigest = write(artifact.project);
        artifact.artifactDigest = write(artifact.path);
        artifact.buildReceipt.artifactDigest = artifact.artifactDigest;
        if (artifact.assemblyPath)
        {
            artifact.assemblyDigest = write(artifact.assemblyPath);
            artifact.deploymentArtifactDigest = write(artifact.deploymentArtifactPath);
            artifact.buildReceipt.projectDigest = artifact.projectDigest;
            artifact.buildReceipt.assemblyDigest = artifact.assemblyDigest;
            artifact.buildReceipt.deploymentArtifactDigest = artifact.deploymentArtifactDigest;
            artifact.buildReceipt.reproducibleBuild.assemblyDigest = artifact.assemblyDigest;
        }
        if (artifact.buildReceipt.openapiPath)
        {
            const projection = artifact.buildReceipt;
            projection.openapiDigest = write(projection.openapiPath);
            const absolute = path.join(directory, projection.openapiArtifactPath);
            fs.mkdirSync(path.dirname(absolute), { recursive: true });
            fs.writeFileSync(absolute, files.get(projection.openapiPath));
            files.set(projection.openapiArtifactPath, files.get(projection.openapiPath));
        }
    }
    receipt.minimalContractBuild = seal(receipt.minimalContractBuild);
    return { receipt: seal(receipt), files };
}

test('admission reader requires a physical regular file through every path component', (t) =>
{
    const directory = ownedDirectory(t);
    const receipt = createRuntimeRoleStaticV3Fixture(runId, identity, { repositoryRoot: root });
    const file = path.join(directory, 'receipt.json');
    const bytes = `${JSON.stringify(receipt)}\n`;
    fs.writeFileSync(file, bytes);
    assert.deepEqual(readBehaviorDocStaticAdmissionReceipt(file), receipt);
    assert.deepEqual(readBehaviorDocStaticAdmissionReceipt(path.relative(root, file)), receipt);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    for (const missing of [null, '', path.join(directory, 'missing.json')])
    {
        assert.throws(() => readBehaviorDocStaticAdmissionReceipt(missing), /receipt is missing/u);
    }
    const leafLink = path.join(directory, 'leaf-link.json');
    const danglingLink = path.join(directory, 'dangling-link.json');
    const ancestorLink = path.join(directory, 'ancestor-link');
    fs.symlinkSync(file, leafLink);
    fs.symlinkSync(path.join(directory, 'missing.json'), danglingLink);
    fs.symlinkSync(directory, ancestorLink);
    for (const invalid of [leafLink, path.join(ancestorLink, 'receipt.json'), danglingLink, directory])
    {
        assert.throws(() => readBehaviorDocStaticAdmissionReceipt(invalid), /physical regular file/u);
    }
    fs.writeFileSync(file, 'invalid-json');
    assert.throws(() => readBehaviorDocStaticAdmissionReceipt(file), SyntaxError);
    fs.writeFileSync(file, JSON.stringify({ ...receipt, contentDigest: '0'.repeat(64) }));
    assert.throws(() => readBehaviorDocStaticAdmissionReceipt(file), /content digest mismatch/u);
});

test('admission wrapper forwards artifact root and independently reads every current v3 artifact', (t) =>
{
    const directory = ownedDirectory(t);
    const { receipt, files } = materializeArtifacts(directory,
        createRuntimeRoleStaticV3Fixture(runId, identity, { repositoryRoot: root }));
    const before = structuredClone(receipt);
    const options = {
        artifactRepositoryRoot: directory,
        readArtifactDigest: () => assert.fail('the caller cannot substitute the owned digest reader')
    };
    assert.equal(files.size, 14);
    assert.equal(validateBehaviorDocStaticAdmissionReceipt(receipt, options), receipt);
    assert.deepEqual(receipt, before);
    const file = path.join(directory, 'receipt.json');
    fs.writeFileSync(file, JSON.stringify(receipt));
    assert.deepEqual(readBehaviorDocStaticAdmissionReceipt(file, options), receipt);
    for (const [relative, bytes] of files)
    {
        const absolute = path.join(directory, relative);
        fs.writeFileSync(absolute, 'tampered source fixture');
        try
        {
            assert.throws(() => validateBehaviorDocStaticAdmissionReceipt(receipt, options), /digest mismatch/u, relative);
            assert.throws(() => readBehaviorDocStaticAdmissionReceipt(file, options), /digest mismatch/u, relative);
        }
        finally
        {
            fs.writeFileSync(absolute, bytes);
        }
    }
    assert.equal(validateBehaviorDocStaticAdmissionReceipt(receipt, options), receipt);
    assert.deepEqual(receipt, before);
});

test('admission wrapper preserves expected identities and the independent worktree extractor roster', () =>
{
    const registry = JSON.parse(fs.readFileSync(path.join(root, 'config/contracts/behavior-fact-extractors.json'), 'utf8'));
    const receipt = createRuntimeRoleStaticV3Fixture(runId, identity, {
        repositoryRoot: root,
        extractorIds: registry.extractors.map((extractor) => extractor.id)
    });
    const options = { expectedRunId: runId, expectedSourceIdentity: identity, expectedWorktree: root };
    assert.equal(validateBehaviorDocStaticAdmissionReceipt(receipt, options), receipt);
    for (const [mutate, message] of [
        [(value) =>
        {
            value.run.id = 'different-run';
        }, /run identity mismatch/u],
        [(value) =>
        {
            value.source.commit = 'c'.repeat(40);
        }, /source\/worktree identity mismatch/u],
        [(value) =>
        {
            value.source.worktreeFingerprint = 'd'.repeat(64);
        }, /source\/worktree identity mismatch/u],
        [(value) =>
        {
            value.worktree.root = path.dirname(root);
        }, /worktree root mismatch/u],
        [(value) =>
        {
            delete value.factObservations[registry.extractors[0].id];
        }, /observation roster drifted/u]
    ])
    {
        const changed = structuredClone(receipt);
        mutate(changed);
        assert.throws(() => validateBehaviorDocStaticAdmissionReceipt(seal(changed), options), message);
    }
});
