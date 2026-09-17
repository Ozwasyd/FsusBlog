import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const {
    createCrossStackOwnerReceipt,
    joinCrossStackReceipts,
    validateCrossStackOwnershipRegistry
} = await import(pathToFileURL(path.join(root, 'tools/test-matrix/cross-stack-receipts.mjs')).href);
const { projectionContentDigest } = await import(pathToFileURL(
    path.join(root, 'tools/test-matrix/evidence-projection.mjs')
).href);

const registry = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/evidence-projection/cross-stack-assertion-ownership.json'), 'utf8'));
const sourceState = { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) };

function fixture()
{
    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-stack-join-'));
    const fixtureRegistry = structuredClone(registry);
    for (const assertion of fixtureRegistry.assertions)
    {
        assertion.artifactPaths = [`evidence/${assertion.id}.txt`];
        const file = path.join(repositoryRoot, assertion.artifactPaths[0]);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, assertion.id);
    }
    const owners = [...new Set(fixtureRegistry.assertions.map((entry) => entry.canonicalOwner))];
    const receipts = owners.map((owner) => createCrossStackOwnerReceipt({
        registry: fixtureRegistry,
        owner,
        repositoryRoot,
        sourceState,
        runId: 'run-1381',
        namespace: 'ns-1381'
    }));
    return { repositoryRoot, registry: fixtureRegistry, receipts };
}

test('ownership registry assigns every legacy assertion to one physical owner', () =>
{
    const validated = validateCrossStackOwnershipRegistry(registry);
    assert.equal(validated.assertions.length, 19);
    assert.equal(new Set(validated.assertions.map((entry) => entry.legacyCommand)).size, 19);
    assert.deepEqual(new Set(validated.assertions.filter((entry) => entry.kind === 'unique').map((entry) => entry.canonicalOwner)), new Set(['cross-stack-runtime', 'cross-stack-static']));
});

test('join binds all current-run owner receipts and keeps the original coverage IDs', () =>
{
    const value = fixture();
    const joined = joinCrossStackReceipts({
        registry: value.registry,
        ownerReceipts: value.receipts,
        repositoryRoot: value.repositoryRoot,
        sourceState,
        runId: 'run-1381',
        namespace: 'ns-1381'
    });
    assert.equal(joined.status, 'success');
    assert.equal(joined.assertions.length, 19);
    assert.deepEqual(joined.coverageIds, ['CROSS-BINARY-ENDPOINT-MATRIX', 'frontend-backend-contract-coherence']);
    assert.equal(joined.executionBoundary.sharedCheckerLaunches, 0);
    assert.equal(joined.ownerReceipts.length, 5);
});

test('join fails closed for missing shared or unique assertions', () =>
{
    for (const id of ['binary-matrix', 'distribution'])
    {
        const value = fixture();
        const receipt = value.receipts.find((entry) => entry.assertions.some((assertion) => assertion.id === id));
        receipt.assertions = receipt.assertions.filter((entry) => entry.id !== id);
        receipt.contentDigest = projectionContentDigest(receipt);
        assert.throws(() => joinCrossStackReceipts({ registry: value.registry, ownerReceipts: value.receipts, repositoryRoot: value.repositoryRoot, sourceState, runId: 'run-1381', namespace: 'ns-1381' }), /assertion set mismatch/u);
    }
});

test('join rejects stale source, failed outcome, replaced receipt, and changed artifacts', () =>
{
    const mutations = [
        (value) =>
        {
            value.receipts[0].sourceState.commit = 'c'.repeat(40);
        },
        (value) =>
        {
            value.receipts[0].runId = 'old-run';
            value.receipts[0].contentDigest = projectionContentDigest(value.receipts[0]);
        },
        (value) =>
        {
            value.receipts[0].namespace = 'other-ns';
            value.receipts[0].contentDigest = projectionContentDigest(value.receipts[0]);
        },
        (value) =>
        {
            value.receipts[0].assertions[0].outcome = 'Failed';
        },
        (value) =>
        {
            value.receipts[0].contentDigest = `sha256:${'0'.repeat(64)}`;
        },
        (value) =>
        {
            fs.writeFileSync(path.join(value.repositoryRoot, value.registry.assertions[0].artifactPaths[0]), 'changed');
        }
    ];
    for (const mutate of mutations)
    {
        const value = fixture();
        mutate(value);
        assert.throws(() => joinCrossStackReceipts({ registry: value.registry, ownerReceipts: value.receipts, repositoryRoot: value.repositoryRoot, sourceState, runId: 'run-1381', namespace: 'ns-1381' }), /digest|source|Passed/u);
    }
});
