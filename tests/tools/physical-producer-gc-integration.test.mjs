import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { compilePhysicalProducerGcAtomicIntegration, compilePhysicalProducerGcIntegration } = await import(new URL('../../tools/test-matrix/physical-producer-gc-integration.mjs', import.meta.url));
const { compilePhysicalProducerFilesystemPlan, physicalProducerFilesystemCatalogSchema } = await import(new URL('../../tools/test-matrix/physical-producer-filesystem.mjs', import.meta.url));
const { compileAtomicProducerDag, verifyCompiledAtomicProducerDag } = await import(new URL('../../tools/test-matrix/atomic-producers/compiler.mjs', import.meta.url));
const { AtomicProducerExecutionError, executeCompiledAtomicProducerDag } = await import(new URL('../../tools/test-matrix/atomic-producers/execution.mjs', import.meta.url));
const { digestCanonical } = await import(new URL('../../tools/test/attempt-provenance.mjs', import.meta.url));
const { atomicExecutionOptions, atomicFixture, rebindAtomicFixture } = await import(new URL('./support/atomic-producer-fixture.mjs', import.meta.url));

function fixture(t, options)
{
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'physical-gc-integration-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'builds'));
    fs.mkdirSync(path.join(root, 'source'));
    const atomic = atomicFixture(options);
    // A controlled old global barrier, never a real production declaration.
    atomic.matrix.atomicProducerDeclarations.nodes.find((node) => node.producerId === 'beta-check').dependsOn = ['alpha-check'];
    rebindAtomicFixture(atomic);
    const compiled = compileAtomicProducerDag(atomic.matrix, atomic.authorities);
    const physicalOwners = compiled.steps.map((step) => ({
        producerId: step.id,
        ownerKind: step.command ? 'executable' : step.kind === 'logical-projection' ? 'projection'
            : step.kind === 'always-run-finalizer' ? 'receipt-only-finalizer' : 'summary',
        spawnEligibility: step.command !== undefined
    }));
    const filesystemInput = {
        catalog: { schema: physicalProducerFilesystemCatalogSchema,
            domains: [
                { domainId: 'managed-output', rootIds: ['build-pool', 'current-build'], sourceOfDeclaration: 'controlled build access contract' },
                { domainId: 'source-input', rootIds: ['repository'], sourceOfDeclaration: 'controlled source access contract' }
            ],
            producers: [
                { producerId: 'alpha-check', ownerKind: 'executable', sourceOfDeclaration: 'controlled GC mutation owner',
                    accesses: [{ rootId: 'build-pool', domainId: 'managed-output', accessMode: 'delete' }] },
                { producerId: 'beta-check', ownerKind: 'executable', sourceOfDeclaration: 'controlled source-only owner',
                    accesses: [{ rootId: 'repository', domainId: 'source-input', accessMode: 'read' }] },
                { producerId: 'dependent-check', ownerKind: 'executable', sourceOfDeclaration: 'controlled current build reader',
                    accesses: [{ rootId: 'current-build', domainId: 'managed-output', accessMode: 'read' }] }
            ] },
        physicalOwners,
        roots: [
            { rootId: 'build-pool', path: path.join(root, 'builds'), boundaryPath: root, role: 'repository' },
            { rootId: 'current-build', path: path.join(root, 'builds', 'current'), boundaryPath: path.join(root, 'builds'),
                role: 'current', runId: 'isolated-atomic-run' },
            { rootId: 'repository', path: path.join(root, 'source'), boundaryPath: root, role: 'repository' }
        ],
        context: { runId: 'isolated-atomic-run', attemptId: 'controlled-attempt',
            sourceState: { commit: '1'.repeat(40), worktreeFingerprint: `sha256:${'2'.repeat(64)}` } }
    };
    const input = { ...atomic, filesystemInput, filesystemPlan: compilePhysicalProducerFilesystemPlan(filesystemInput), gcProducerId: 'alpha-check' };
    const tiers = compiled.steps.map((step) => ({ id: step.id,
        ...(step.command ? { command: step.command } : {}),
        executionDependsOn: [...step.dependsOn, ...step.settledDependsOn],
        services: step.serviceDependencies ?? [], resources: step.resources,
        exclusiveResources: ['preserved-io-lock'], executionKey: `controlled/${step.id}` }));
    return { root, input, tiers };
}

test('scheduler adapter removes only unsupported GC edges and preserves all other tier fields', (t) =>
{
    const current = fixture(t);
    const before = structuredClone(current.tiers);
    const result = compilePhysicalProducerGcIntegration({ ...current.input, tiers: current.tiers });
    assert.deepEqual(result.tiers.find((tier) => tier.id === 'beta-check').executionDependsOn, []);
    assert.deepEqual(result.tiers.find((tier) => tier.id === 'dependent-check').executionDependsOn, ['alpha-check']);
    for (const original of before)
    {
        const planned = structuredClone(result.tiers.find((tier) => tier.id === original.id));
        planned.executionDependsOn = original.executionDependsOn;
        assert.deepEqual(planned, original);
    }
    assert.deepEqual(current.tiers, before);
    assert.equal(result.executionEligible, false);
    assert.equal(result.qualificationEligible, false);
});

test('scheduler adapter adds a missing proven hard edge and retains non-GC prerequisites', (t) =>
{
    const current = fixture(t);
    current.tiers.find((tier) => tier.id === 'dependent-check').executionDependsOn = ['beta-check'];
    const result = compilePhysicalProducerGcIntegration({ ...current.input, tiers: current.tiers });
    assert.deepEqual(result.tiers.find((tier) => tier.id === 'dependent-check').executionDependsOn, ['alpha-check', 'beta-check']);
});

test('scheduler executable missing extra and summary-as-command ownership is rejected', (t) =>
{
    const current = fixture(t);
    assert.throws(() => compilePhysicalProducerGcIntegration({ ...current.input,
        tiers: current.tiers.filter((tier) => tier.id !== 'beta-check') }), /ownership/u);
    assert.throws(() => compilePhysicalProducerGcIntegration({ ...current.input,
        tiers: [...current.tiers, { id: 'summary-command', command: 'true', executionDependsOn: [] }] }), /ownership/u);
    const tiers = structuredClone(current.tiers);
    tiers.find((tier) => tier.id === 'beta-check').executionMode = 'summary';
    assert.throws(() => compilePhysicalProducerGcIntegration({ ...current.input, tiers }), /executable ownership/u);
});

test('scheduler unknown cycle and duplicate dependency declarations fail before execution', (t) =>
{
    const current = fixture(t);
    for (const dependencies of [['unknown'], ['dependent-check'], ['beta-check', 'beta-check']])
    {
        const tiers = structuredClone(current.tiers);
        tiers.find((tier) => tier.id === 'alpha-check').executionDependsOn = dependencies;
        assert.throws(() => compilePhysicalProducerGcIntegration({ ...current.input, tiers }), /dependency|dependencies/u);
    }
});

test('atomic adapter recompiles canonical DAG with exact source material and preserved coordination', (t) =>
{
    const current = fixture(t);
    const before = structuredClone(current.input);
    const result = compilePhysicalProducerGcAtomicIntegration(current.input);
    assert.deepEqual(verifyCompiledAtomicProducerDag(result.compiledDag, result.matrix, result.authorities), result.compiledDag);
    assert.notEqual(result.compiledDag.contentDigest, result.originalCompiledDagDigest);
    assert.deepEqual(result.compiledDag.steps.find((step) => step.id === 'beta-check').dependsOn, []);
    assert.deepEqual(result.compiledDag.steps.find((step) => step.id === 'dependent-check').dependsOn, ['alpha-check']);
    const restored = structuredClone(result.matrix);
    for (const node of restored.atomicProducerDeclarations.nodes)
    {
        node.dependsOn = before.matrix.atomicProducerDeclarations.nodes.find((original) => original.producerId === node.producerId).dependsOn;
    }
    assert.deepEqual(restored, before.matrix);
    assert.deepEqual({ ...result.authorities, matrixDigest: before.authorities.matrixDigest }, before.authorities);
    assert.deepEqual(current.input, before);
    assert.equal(result.executionEligible, false);
    assert.equal(result.compiledDag.qualificationEligible, false);
});

test('atomic filesystem roster cannot omit a physical executable or invent a coordination owner', (t) =>
{
    const current = fixture(t);
    const missing = structuredClone(current.input);
    missing.filesystemInput.physicalOwners = missing.filesystemInput.physicalOwners.filter((owner) => owner.producerId !== 'beta-check');
    missing.filesystemInput.catalog.producers = missing.filesystemInput.catalog.producers.filter((owner) => owner.producerId !== 'beta-check');
    missing.filesystemPlan = compilePhysicalProducerFilesystemPlan(missing.filesystemInput);
    assert.throws(() => compilePhysicalProducerGcAtomicIntegration(missing), /ownership/u);
    const wrong = structuredClone(current.input);
    wrong.filesystemInput.physicalOwners.find((owner) => owner.producerId === 'fixture-summary').ownerKind = 'summary';
    wrong.filesystemPlan = compilePhysicalProducerFilesystemPlan(wrong.filesystemInput);
    assert.throws(() => compilePhysicalProducerGcAtomicIntegration(wrong), /coordination ownership/u);
});

test('atomic filesystem run source and worktree must match every compiled replay binding', (t) =>
{
    const current = fixture(t);
    for (const field of ['runId', 'commit', 'worktreeFingerprint'])
    {
        const input = structuredClone(current.input);
        if (field === 'runId')
        {
            input.filesystemInput.context.runId = 'other-run';
            input.filesystemInput.roots.find((root) => root.role === 'current').runId = 'other-run';
        }
        else
        {
            input.filesystemInput.context.sourceState[field] = field === 'commit' ? '3'.repeat(40) : `sha256:${'4'.repeat(64)}`;
        }
        input.filesystemPlan = compilePhysicalProducerFilesystemPlan(input.filesystemInput);
        assert.throws(() => compilePhysicalProducerGcAtomicIntegration(input), /run\/source/u);
    }
});

test('atomic settled GC semantics cannot be silently converted into hard success ordering', (t) =>
{
    const current = fixture(t);
    const node = current.input.matrix.atomicProducerDeclarations.nodes.find((item) => item.producerId === 'beta-check');
    node.dependsOn = [];
    node.settledDependsOn = ['alpha-check'];
    rebindAtomicFixture(current.input);
    assert.throws(() => compilePhysicalProducerGcAtomicIntegration(current.input), /settled GC/u);
});

test('atomic derived cycles are rejected by canonical compiler', (t) =>
{
    const current = fixture(t);
    const nodes = current.input.matrix.atomicProducerDeclarations.nodes;
    nodes.find((node) => node.producerId === 'alpha-check').dependsOn = ['dependent-check'];
    nodes.find((node) => node.producerId === 'dependent-check').dependsOn = [];
    rebindAtomicFixture(current.input);
    assert.throws(() => compilePhysicalProducerGcAtomicIntegration(current.input), /cycle/u);
});

test('stale resealed and remapped filesystem witnesses cannot reach either edge adapter', (t) =>
{
    const current = fixture(t);
    const input = structuredClone(current.input);
    input.filesystemPlan.producers[0].resolvedRoots[0].filesystemIdentity = 'invented-volume';
    const { planDigest, ...body } = input.filesystemPlan;
    assert.equal(typeof planDigest, 'string');
    input.filesystemPlan.planDigest = digestCanonical(body);
    assert.throws(() => compilePhysicalProducerGcAtomicIntegration(input), /plan/u);
    assert.throws(() => compilePhysicalProducerGcIntegration({ ...input, tiers: current.tiers }), /plan/u);
});

test('real canonical executor confines controlled GC failure to the proven dependency closure', async (t) =>
{
    const current = fixture(t, { alphaScenario: 'product-failure' });
    const result = compilePhysicalProducerGcAtomicIntegration(current.input);
    const options = atomicExecutionOptions({ matrix: result.matrix, authorities: result.authorities }, path.join(current.root, 'evidence'));
    let failure;
    await assert.rejects(executeCompiledAtomicProducerDag(result.compiledDag, options), (error) =>
    {
        assert.ok(error instanceof AtomicProducerExecutionError);
        failure = error;
        return true;
    });
    const receipts = Object.fromEntries(failure.terminalVector.receipts.map((receipt) => [receipt.producerId, receipt]));
    assert.equal(receipts['alpha-check'].terminalState, 'failed');
    assert.equal(receipts['beta-check'].terminalState, 'success');
    assert.equal(receipts['dependent-check'].terminalState, 'blocked');
    assert.equal(receipts['dependent-check'].attemptRef, null);
    assert.equal(failure.terminalVector.qualificationEligible, false);
});
