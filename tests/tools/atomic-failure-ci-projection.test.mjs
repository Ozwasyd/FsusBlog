import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { checkAtomicWorkflowMaterial, collectCompiledAtomicTerminalMaterial, collectCanonicalLaneAtomicTerminalMaterial, createCompiledAtomicRuntimeCiBinding, projectAtomicCiMaterial, projectCompiledAtomicCiMaterial, projectCompiledAtomicRuntimeCiMaterial, projectCanonicalLaneAtomicCiMaterial, prepareCanonicalAtomicCiGroup, executeCanonicalAtomicCiGroup } = await import(new URL('../../tools/test-matrix/atomic-failure/ci-projection.mjs', import.meta.url));
const { compileAtomicProducerDag } = await import(new URL('../../tools/test-matrix/atomic-producers/compiler.mjs', import.meta.url));
const { AtomicProducerExecutionError, executeCompiledAtomicProducerDag } = await import(new URL('../../tools/test-matrix/atomic-producers/execution.mjs', import.meta.url));
const { digestCanonical, sealContentDigest } = await import(new URL('../../tools/test/attempt-provenance.mjs', import.meta.url));
const { loadRuntimeStateAuthority } = await import(new URL('../../tools/test-runtime/catalog.mjs', import.meta.url));
const { readCanonicalSchedulerCheckpoint } = await import(new URL('../../tools/test-matrix/scheduler.mjs', import.meta.url));
import { atomicFixture, hostLimits, originalLaneFixture, composeOriginalLaneFixtures } from './support/atomic-failure-fixture.mjs';
import { atomicExecutionOptions, atomicFixture as compilerFixture, atomicReference, rebindAtomicFixture } from './support/atomic-producer-fixture.mjs';
import { writeCanonicalSchedulerFixture } from './support/canonical-scheduler-fixture.mjs';

function project(fixture = atomicFixture())
{
    const { worktreeFingerprint, ...context } = fixture.context;
    assert.ok(worktreeFingerprint);
    return projectAtomicCiMaterial({ context, graph: fixture.graph, selectedIds: fixture.graph.nodes.map((node) => node.id) }, hostLimits);
}

test('shared runner invokes one DAG and all jobs settle with collision-free current-attempt bindings', () =>
{
    const projection = project();
    const shared = projection.jobs.find((job) => job.id === 'shared-runner');
    assert.equal(shared.invocationCount, 1);
    assert.deepEqual(shared.producerIds, ['failure-a', 'independent-success']);
    assert.ok(projection.jobs.every((job) => job.failFast === false && job.condition === 'always()'));
    const bindings = projection.jobs.flatMap((job) => job.receiptBindings);
    assert.equal(new Set(bindings.map((binding) => binding.artifactName)).size, 7);
    assert.ok(bindings.every((binding) => binding.path.includes('/atomic-fixture/atomic/attempt-one/')));
    assert.equal(projection.aggregate.jobStatusIsEvidence, false);
    assert.equal(projection.aggregate.missingReceiptIsSuccess, false);
    assert.equal(projection.verificationStatus, 'unverified');
    assert.ok(Object.isFrozen(projection.jobs));
});

for (const mutation of ['needs', 'sequential', 'fail-fast', 'job-only', 'dag', 'artifact', 'ignore-exit'])
{
    test(`workflow exact comparison rejects ${mutation} drift`, () =>
    {
        const projection = project();
        const workflow = structuredClone({ dagDigest: projection.dagDigest, jobs: projection.jobs, aggregate: projection.aggregate });
        assert.equal(checkAtomicWorkflowMaterial(projection, workflow, hostLimits), true);
        if (mutation === 'needs')
        {
            workflow.jobs[0].needs = [];
        }
        if (mutation === 'sequential')
        {
            workflow.jobs[0].invocationCount = 2;
        }
        if (mutation === 'fail-fast')
        {
            workflow.jobs[0].failFast = true;
        }
        if (mutation === 'job-only')
        {
            workflow.aggregate.receiptRequired = false;
        }
        if (mutation === 'dag')
        {
            workflow.dagDigest = `sha256:${'0'.repeat(64)}`;
        }
        if (mutation === 'artifact')
        {
            workflow.jobs[0].receiptBindings[0].artifactName = 'latest';
        }
        if (mutation === 'ignore-exit')
        {
            workflow.jobs[0].continueOnError = true;
        }
        assert.throws(() => checkAtomicWorkflowMaterial(projection, workflow, hostLimits), /mismatch/u);
    });
}

test('job contraction cycle and selected producer without hard prerequisites fail closed', () =>
{
    const fixture = atomicFixture();
    fixture.graph.nodes.find((node) => node.id === 'dependent-transitive').ciJobId = 'shared-runner';
    assert.throws(() => project(fixture), /contraction/u);
    const { worktreeFingerprint, ...context } = fixture.context;
    assert.ok(worktreeFingerprint);
    assert.throws(() => projectAtomicCiMaterial({ context, graph: atomicFixture().graph, selectedIds: ['dependent'] }, hostLimits), /prerequisite/u);
});

test('not-selected is an explicit receipt disposition and cross-run graph refs are refused', () =>
{
    const fixture = atomicFixture();
    const { worktreeFingerprint, ...context } = fixture.context;
    assert.ok(worktreeFingerprint);
    const projection = projectAtomicCiMaterial({ context, graph: fixture.graph, selectedIds: [] }, hostLimits);
    assert.ok(projection.jobs.flatMap((job) => job.receiptBindings).every((binding) => binding.selected === false));
    fixture.graph.graphRef.path = '.tmp/test-runs/other-run/graph.json';
    assert.throws(() => project(fixture), /current-run/u);
});

function compiledInput(fixture = compilerFixture())
{
    const compiled = compileAtomicProducerDag(fixture.matrix, fixture.authorities);
    return { ...fixture, compiled,
        context: { schedulerRunId: 'isolated-atomic-run', attemptId: 'first-attempt', sourceCommit: '1'.repeat(40) },
        ciPlan: { jobs: [{ id: 'fixture-job', tiers: ['fixture-summary'] }] },
        graphRef: { path: '.tmp/test-runs/isolated-atomic-run/graph.json', objectDigest: compiled.contentDigest },
        selectedIds: compiled.steps.map((step) => step.id) };
}

test('original compiler supplies exact-one CI invocation without a second producer catalog', async () =>
{
    const input = compiledInput();
    const projection = await projectCompiledAtomicCiMaterial(input, hostLimits);
    assert.equal(projection.jobs.length, 1);
    assert.equal(projection.jobs[0].invocationCount, 1);
    assert.equal(projection.jobs[0].receiptBindings.length, input.compiled.steps.length);
    for (const mutate of [
        (value) =>
        {
            value.ciPlan.jobs = [];
        },
        (value) =>
        {
            value.ciPlan.jobs.push({ id: 'other-job', tiers: ['fixture-summary'] });
        },
        (value) =>
        {
            value.graphRef.objectDigest = `sha256:${'0'.repeat(64)}`;
        },
        (value) =>
        {
            value.compiled.steps[0].command.push('second-authority');
        }
    ])
    {
        const changed = structuredClone(input);
        mutate(changed);
        await assert.rejects(projectCompiledAtomicCiMaterial(changed, hostLimits));
    }
});

async function withTerminalInput(fixture, run, abort = false)
{
    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-terminal-collection-'));
    try
    {
        const input = compiledInput(fixture);
        const options = atomicExecutionOptions(fixture, path.join(repositoryRoot, '.tmp', 'test-runs'));
        if (abort)
        {
            options.capacity.signal = AbortSignal.abort(new Error('source-control-interrupt'));
        }
        let vector;
        try
        {
            vector = await executeCompiledAtomicProducerDag(input.compiled, options);
        }
        catch (error)
        {
            assert.ok(error instanceof AtomicProducerExecutionError);
            vector = error.terminalVector;
        }
        return await run({ ...input, vector, expectedVector: vector, repositoryRoot,
            worktreeFingerprint: options.context.worktreeFingerprint,
            terminalVectorRef: { path: `.tmp/test-runs/${vector.schedulerRunId}/atomic-dag/${input.compiled.contentDigest.slice(7)}/terminal-vector.json`,
                objectDigest: vector.contentDigest } });
    }
    finally
    {
        fs.rmSync(repositoryRoot, { recursive: true, force: true });
    }
}

function resealVector(input)
{
    const { contentDigest, ...body } = input.vector;
    assert.ok(contentDigest);
    input.vector = sealContentDigest(body);
    input.expectedVector = input.vector;
    input.terminalVectorRef.objectDigest = input.vector.contentDigest;
}

test('read-only collection retains two real independent failures, blocked work and original receipt identities', async () =>
    withTerminalInput(compilerFixture({ alphaScenario: 'product-failure', betaScenario: 'product-failure' }), async (input) =>
    {
        const filesBefore = fs.readdirSync(path.join(input.repositoryRoot, path.dirname(input.terminalVectorRef.path)));
        const material = await collectCompiledAtomicTerminalMaterial(input, hostLimits);
        assert.equal(material.sourceStatus, 'failed');
        assert.equal(material.receipts.length, 6);
        const byId = Object.fromEntries(material.receipts.map((receipt) => [receipt.producerId, receipt]));
        assert.equal(byId['alpha-check'].terminalState, 'failed');
        assert.equal(byId['beta-check'].terminalState, 'failed');
        assert.deepEqual(byId['dependent-check'].blockedBy, ['alpha-check']);
        assert.equal(byId['dependent-check'].attemptRef, null);
        assert.equal(byId['cleanup-inventory'].terminalState, 'success');
        for (const receipt of material.receipts)
        {
            const original = input.vector.receipts.find((entry) => entry.producerId === receipt.producerId);
            assert.equal(receipt.sourceReceiptDigest, original.contentDigest);
            assert.deepEqual(receipt.primaryFailureRefs, original.primaryFailureRefs);
            assert.equal(fs.existsSync(path.join(input.repositoryRoot, receipt.transportBinding.path)), false);
        }
        assert.equal(material.materializedTransport, false);
        assert.equal(material.qualificationEligible, false);
        assert.equal(material.verificationStatus, 'unverified');
        assert.equal(material.terminalAcceptancePending, true);
        assert.ok(Object.isFrozen(material.receipts));
        assert.deepEqual(fs.readdirSync(path.join(input.repositoryRoot, path.dirname(input.terminalVectorRef.path))), filesBefore);
    }));

test('terminal collection refuses complete-vector drift even when caller reseals expected material', async (t) =>
    withTerminalInput(compilerFixture(), async (input) =>
    {
        const cases = {
            'missing terminal': (value) =>
            {
                value.vector.receipts.pop();
                resealVector(value);
            },
            'duplicate terminal': (value) =>
            {
                value.vector.receipts.push(value.vector.receipts[0]);
                resealVector(value);
            },
            'unsealed receipt': (value) =>
            {
                value.vector.receipts[0].reasonCode = 'changed';
                resealVector(value);
            },
            'other run': (value) =>
            {
                value.vector.schedulerRunId = 'other-run';
                resealVector(value);
            },
            'other source': (value) =>
            {
                value.vector.sourceCommit = '2'.repeat(40);
                resealVector(value);
            },
            'other worktree': (value) =>
            {
                value.worktreeFingerprint = `sha256:${'3'.repeat(64)}`;
            },
            'other vector reference': (value) =>
            {
                value.terminalVectorRef.objectDigest = `sha256:${'4'.repeat(64)}`;
            },
            'partial selection': (value) =>
            {
                value.selectedIds = [];
            },
            'authority promotion': (value) =>
            {
                value.vector.qualificationEligible = true;
                resealVector(value);
            },
            'cross-run original attempt': (value) =>
            {
                const receipt = value.vector.receipts.find((entry) => entry.attemptRef);
                receipt.attemptRef.path = path.join(value.repositoryRoot, '.tmp/test-runs/other-run/receipt.json');
                const { contentDigest, ...body } = receipt;
                assert.ok(contentDigest);
                value.vector.receipts[value.vector.receipts.indexOf(receipt)] = sealContentDigest(body);
                resealVector(value);
            }
        };
        for (const [name, mutate] of Object.entries(cases))
        {
            await t.test(name, async () =>
            {
                const changed = structuredClone(input);
                mutate(changed);
                await assert.rejects(collectCompiledAtomicTerminalMaterial(changed, hostLimits));
            });
        }
    }));

test('global interruption keeps unspawned cancellation and exact-once finalizer source receipts', async () =>
    withTerminalInput(compilerFixture(), async (input) =>
    {
        const material = await collectCompiledAtomicTerminalMaterial(input, hostLimits);
        assert.equal(material.interrupted, true);
        assert.ok(material.receipts.filter((receipt) => receipt.producerId.endsWith('-check'))
            .every((receipt) => receipt.terminalState === 'cancelled' && receipt.attemptRef === null));
        assert.equal(material.receipts.find((receipt) => receipt.producerId === 'cleanup-inventory').terminalState, 'success');
        assert.equal(Object.hasOwn(material, 'interruption'), false);
    }, true));

/** Controlled original-producer/state fixtures; no physical runtime admission or qualification. */
async function withRuntimeInput(run, { splitJobs = false, independentDomain = false } = {})
{
    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-runtime-ci-'));
    try
    {
        const fixture = compilerFixture();
        const declarations = fixture.matrix.atomicProducerDeclarations.nodes;
        if (splitJobs)
        {
            for (const producerId of ['alpha-check', 'beta-check'])
            {
                const parentId = `${producerId}-summary`;
                declarations.find((node) => node.producerId === producerId).logicalParentId = parentId;
                fixture.authorities.physicalOwnership.find((owner) => owner.producerId === producerId).logicalParentId = parentId;
                const projection = structuredClone(declarations.find((node) => node.kind === 'logical-projection'));
                projection.producerId = parentId;
                projection.logicalParentId = parentId;
                projection.settledDependsOn = [producerId];
                declarations.push(projection);
                fixture.matrix.tiers.push({ ...fixture.matrix.tiers[0], id: parentId, projectFrom: [producerId] });
                declarations.find((node) => node.kind === 'always-run-finalizer').settledDependsOn.push(parentId);
            }
            fixture.matrix.tiers[0].projectFrom = ['dependent-check'];
            declarations.find((node) => node.producerId === 'fixture-summary').settledDependsOn = ['dependent-check'];
            declarations.find((node) => node.kind === 'always-run-finalizer').settledDependsOn.sort();
        }
        const sourceRoot = path.resolve(import.meta.dirname, '../..');
        const catalogue = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'config/testing/runtime-state-domain-catalog.json'), 'utf8'));
        catalogue.steps = declarations.map((node) =>
        {
            if (!['atomic-producer', 'hard-prerequisite'].includes(node.kind))
            {
                return { stepId: node.producerId, stateAccess: 'none' };
            }
            const domain = node.producerId === 'beta-check' && independentDomain ? 'fixture.public-content' : 'postgres.article';
            const operation = node.producerId === 'alpha-check' ? 'writes' : 'reads';
            return { stepId: node.producerId, stateAccess: 'declared', reads: [], writes: [], creates: [], deletes: [],
                invalidates: [], exclusiveStateDomains: [], commutativeWrites: [], resetBefore: [], resetAfter: [],
                requiredPredecessors: [], postconditions: ['receipt'], operationOverlaps: [], [operation]: [domain],
                evidence: [{ proofKind: 'structured-test', operation, domain, assertionId: node.producerId,
                    verifier: 'tests/tools/atomic-failure-ci-projection.test.mjs' }] };
        });
        const runtimeCatalogPath = path.join(repositoryRoot, 'catalog.json');
        fs.writeFileSync(runtimeCatalogPath, JSON.stringify(catalogue));
        for (const node of declarations.filter((entry) => entry.kind === 'atomic-producer'))
        {
            const entry = catalogue.steps.find((item) => item.stepId === node.producerId);
            const state = sealContentDigest({ id: `${node.producerId}-state`, producerId: node.producerId,
                unknownAccess: false, catalogDigest: digestCanonical(catalogue), catalogEntryDigest: digestCanonical(entry) });
            fixture.authorities.stateAccess.push(state);
            node.executionClass = 'runtime';
            node.stateAccessRef = atomicReference(state);
        }
        rebindAtomicFixture(fixture);
        const input = compiledInput(fixture);
        if (splitJobs)
        {
            input.ciPlan.jobs = fixture.matrix.tiers.map((tier) => ({ id: `${tier.id}-job`, tiers: [tier.id] }));
        }
        const worktreeFingerprint = `sha256:${'2'.repeat(64)}`;
        const checkpointFile = path.join(repositoryRoot, '.tmp/test-runs', input.context.schedulerRunId, 'checkpoint.json');
        writeCanonicalSchedulerFixture(checkpointFile, { runId: input.context.schedulerRunId,
            sourceState: { commit: input.context.sourceCommit, worktreeFingerprint } });
        const canonical = readCanonicalSchedulerCheckpoint(checkpointFile);
        return await run({ ...input, repositoryRoot, runtimeCatalogPath, worktreeFingerprint,
            checkpointRef: { path: `.tmp/test-runs/${input.context.schedulerRunId}/checkpoint.json`, objectDigest: canonical.checkpointDigest } });
    }
    finally
    {
        fs.rmSync(repositoryRoot, { recursive: true, force: true });
    }
}

test('canonical state binding feeds the original runtime executor without changing commands or capacity', async () =>
    withRuntimeInput(async (input) =>
    {
        const binding = await createCompiledAtomicRuntimeCiBinding(input, hostLimits);
        const alpha = binding.projection.graph.nodes.find((node) => node.id === 'alpha-check');
        assert.deepEqual(alpha.stateAccess, [{ domain: 'postgres.article', mode: 'write' }]);
        assert.equal(binding.stateConflictPolicy.evaluate('alpha-check', 'beta-check').conflict, true);
        assert.equal(binding.projection.qualificationEligible, false);
        assert.equal(binding.projection.runtimeAcceptancePending, true);
        assert.equal(binding.projection.verificationStatus, 'unverified');
        assert.equal(binding.checkpointBinding.revision, 1);
        const options = atomicExecutionOptions(input, path.join(input.repositoryRoot, '.tmp/test-runs'));
        const originalCapacity = { ...options.capacity };
        options.capacity.stateConflictPolicy = binding.stateConflictPolicy;
        const vector = await executeCompiledAtomicProducerDag(input.compiled, options);
        assert.equal(vector.status, 'success');
        const { runtimeCatalogPath, checkpointRef, ...terminalInput } = input;
        assert.ok(runtimeCatalogPath && checkpointRef);
        const collected = await collectCompiledAtomicTerminalMaterial({ ...terminalInput, runtimeAuthority: binding.runtimeAuthority,
            vector, expectedVector: vector,
            terminalVectorRef: { path: `.tmp/test-runs/${vector.schedulerRunId}/atomic-dag/${input.compiled.contentDigest.slice(7)}/terminal-vector.json`,
                objectDigest: vector.contentDigest } }, hostLimits);
        assert.equal(collected.ciProjectionDigest, binding.projection.ciProjection.contentDigest);
        assert.equal(collected.receipts.length, vector.receipts.length);
        assert.equal(collected.sourceStatus, 'success');
        assert.equal(collected.qualificationEligible, false);
        assert.deepEqual(Object.fromEntries(Object.keys(originalCapacity).map((key) => [key, options.capacity[key]])), originalCapacity);
        const attempts = vector.receipts.filter((receipt) => receipt.attemptRef).map((receipt) =>
            ({ id: receipt.producerId, ...JSON.parse(fs.readFileSync(receipt.attemptRef.path, 'utf8')) }));
        const a = attempts.find((attempt) => attempt.id === 'alpha-check');
        const b = attempts.find((attempt) => attempt.id === 'beta-check');
        assert.ok(Date.parse(a.finishedAt) <= Date.parse(b.startedAt) || Date.parse(b.finishedAt) <= Date.parse(a.startedAt));
        assert.ok(attempts.every((attempt) => attempt.attemptNumber === 1 && attempt.maxAttempts === 1));
        const again = readCanonicalSchedulerCheckpoint(path.join(input.repositoryRoot, input.checkpointRef.path));
        assert.equal(again.checkpointDigest, input.checkpointRef.objectDigest);
        assert.equal(again.checkpoint.revision, 1);
    }));

test('canonical CI planner must keep conflicting independent runtime producers on the same runner', async () =>
    withRuntimeInput(async (input) =>
    {
        await assert.rejects(createCompiledAtomicRuntimeCiBinding(input, hostLimits), /co-locate/u);
    }, { splitJobs: true }));

test('original state policy permits independent-domain CI jobs while keeping hard job prerequisites', async () =>
    withRuntimeInput(async (input) =>
    {
        const binding = await createCompiledAtomicRuntimeCiBinding(input, hostLimits);
        assert.equal(binding.projection.ciProjection.jobs.length, 3);
        const dependentJob = binding.projection.ciProjection.jobs.find((job) => job.id === 'fixture-summary-job');
        assert.ok(dependentJob.needs.includes('alpha-check-summary-job'));
        assert.ok(binding.projection.ciProjection.jobs.every((job) => job.failFast === false));
    }, { splitJobs: true, independentDomain: true }));

test('runtime state input remains DATA_ONLY and must preserve the original catalog reference binding', async () =>
    withRuntimeInput(async (input) =>
    {
        const { repositoryRoot, runtimeCatalogPath, checkpointRef, worktreeFingerprint, ...compiledMaterial } = input;
        assert.ok(repositoryRoot && checkpointRef && worktreeFingerprint);
        const sourceRoot = path.resolve(import.meta.dirname, '../..');
        const steps = input.compiled.steps.map((step) => ({ id: step.id, resources: step.resources, dependsOn: step.dependsOn,
            command: (step.command ?? []).map((arg) => arg.startsWith(`${sourceRoot}/`) ? path.relative(sourceRoot, arg) : arg).join(' ') }));
        const runtimeAuthority = loadRuntimeStateAuthority({ catalogPath: runtimeCatalogPath, steps });
        const projected = await projectCompiledAtomicRuntimeCiMaterial({ ...compiledMaterial, runtimeAuthority }, hostLimits);
        assert.equal(projected.runtimeCatalogDigest, runtimeAuthority.catalogDigest);
        assert.equal(projected.verificationStatus, 'unverified');
        const changed = structuredClone(runtimeAuthority);
        changed.steps['alpha-check'].writes = ['postgres.auth'];
        await assert.rejects(projectCompiledAtomicRuntimeCiMaterial({ ...compiledMaterial, runtimeAuthority: changed }, hostLimits), /mismatch/u);
    }));

test('running canonical checkpoint source is required; disposable JSON cannot replace readback', async () =>
    withRuntimeInput(async (input) =>
    {
        await assert.rejects(createCompiledAtomicRuntimeCiBinding({ ...input, selectedIds: [] }, hostLimits), /selection capability/u);
        const wrongSource = { ...input, worktreeFingerprint: `sha256:${'3'.repeat(64)}` };
        await assert.rejects(createCompiledAtomicRuntimeCiBinding(wrongSource, hostLimits), /worktree/u);
        const file = path.join(input.repositoryRoot, input.checkpointRef.path);
        fs.rmSync(path.join(path.dirname(file), 'evidence-store'), { recursive: true, force: true });
        await assert.rejects(createCompiledAtomicRuntimeCiBinding(input, hostLimits), /missing-canonical-checkpoint/u);
    }));

test('original runtime catalog drift is refused before a later admission wave', async () =>
    withRuntimeInput(async (input) =>
    {
        const binding = await createCompiledAtomicRuntimeCiBinding(input, hostLimits);
        binding.stateConflictPolicy.assertCurrent();
        const catalog = JSON.parse(fs.readFileSync(input.runtimeCatalogPath, 'utf8'));
        catalog.auditBaseline = '0'.repeat(40);
        fs.writeFileSync(input.runtimeCatalogPath, JSON.stringify(catalog));
        assert.throws(() => binding.stateConflictPolicy.assertCurrent(), /drifted/u);
    }));

const laneHostLimits = { maxDepth: 60, maxNodes: 200000, maxBytes: 20000000, maxItems: 140000 };

for (const kind of ['backend', 'static', 'frontend', 'public-runtime', 'coverage'])
{
    test(`canonical planner consumes the original ${kind} lane compiler without launching children`, async (t) =>
    {
        const { material, frontendContexts } = composeOriginalLaneFixtures([originalLaneFixture(t, kind)]);
        const result = await projectCanonicalLaneAtomicCiMaterial(material, laneHostLimits, frontendContexts);
        assert.equal(result.compiledDagDigest, material.compiled.contentDigest);
        assert.equal(result.completeSourceCoverage, true);
        assert.equal(result.laneBindings.length, 1);
        assert.equal(result.laneBindings[0].kind, kind);
        assert.equal(result.qualificationEligible, false);
        assert.equal(result.executableAdmissionPending, true);
        assert.equal(result.verificationStatus, 'unverified');
        if (kind === 'public-runtime')
        {
            assert.equal(result.ciProjection, null);
            assert.ok(result.runtimeStatePendingProducerIds.length > 0);
            assert.equal(result.laneBindings[0].runtimeAuthorityStatus, 'unverified');
        }
        else
        {
            assert.equal(result.ciProjection.jobs.length, 1);
            assert.equal(result.ciProjection.jobs[0].invocationCount, 1);
            assert.equal(result.ciProjection.jobs[0].producerIds.length, material.compiled.steps.length);
        }
    });
}

test('one canonical whole graph consumes backend, thirteen static producers and frontend source memberships', async (t) =>
{
    const fragments = ['backend', 'static', 'frontend'].map((kind) => originalLaneFixture(t, kind));
    const { material, frontendContexts } = composeOriginalLaneFixtures(fragments);
    const before = structuredClone(material);
    const result = await projectCanonicalLaneAtomicCiMaterial(material, laneHostLimits, frontendContexts);
    assert.equal(result.completeSourceCoverage, true);
    assert.equal(result.laneBindings.length, 3);
    assert.equal(result.laneBindings.find((binding) => binding.kind === 'static').producerIds.length, 13);
    assert.equal(result.ciProjection.jobs.length, 1);
    assert.equal(result.ciProjection.jobs[0].invocationCount, 1);
    assert.equal(result.ciProjection.jobs[0].receiptBindings.length, material.compiled.steps.length);
    assert.equal(new Set(result.ciProjection.jobs[0].receiptBindings.map((binding) => binding.artifactName)).size, material.compiled.steps.length);
    assert.deepEqual(material, before);
});

test('all four original lane bridges share the canonical graph while missing public state admission stays pending', async (t) =>
{
    const { material, frontendContexts } = composeOriginalLaneFixtures(['backend', 'static', 'frontend', 'public-runtime']
        .map((kind) => originalLaneFixture(t, kind)));
    const result = await projectCanonicalLaneAtomicCiMaterial(material, laneHostLimits, frontendContexts);
    assert.equal(result.laneBindings.length, 4);
    assert.deepEqual(result.unconsumedProducerIds, []);
    const originalPublicProducer = material.lanes.find((lane) => lane.kind === 'public-runtime').input.declarations.nodes[0].id;
    assert.ok(result.runtimeStatePendingProducerIds.includes(originalPublicProducer));
    assert.equal(result.ciProjection, null);
    assert.equal(result.qualificationEligible, false);
});

test('lane consumption exposes omitted domains and refuses duplicate primary ownership', async (t) =>
{
    const { material, frontendContexts } = composeOriginalLaneFixtures(['backend', 'static'].map((kind) => originalLaneFixture(t, kind)));
    const omitted = { ...material, lanes: [material.lanes[0]] };
    const result = await projectCanonicalLaneAtomicCiMaterial(omitted, laneHostLimits, frontendContexts);
    assert.equal(result.completeSourceCoverage, false);
    assert.equal(result.unconsumedProducerIds.length, 13);
    const duplicate = { ...material, lanes: [...material.lanes, { ...material.lanes[0], id: 'duplicate-backend-source' }] };
    await assert.rejects(projectCanonicalLaneAtomicCiMaterial(duplicate, laneHostLimits, frontendContexts), /multiple lane/u);
});

test('canonical lane projection refuses cross-run replay source without rewriting any producer', async (t) =>
{
    const { material, frontendContexts } = composeOriginalLaneFixtures([originalLaneFixture(t, 'static')]);
    await assert.rejects(projectCanonicalLaneAtomicCiMaterial({ ...material, context: { ...material.context, schedulerRunId: 'other-run' },
        graphRef: { ...material.graphRef, path: '.tmp/test-runs/other-run/graph.json' } }, laneHostLimits, frontendContexts), /replay run/u);
});

function frontendExecutionFixture(t, scenarios = {})
{
    const fragment = originalLaneFixture(t, 'frontend', scenarios);
    const combined = composeOriginalLaneFixtures([fragment]);
    const options = { ...fragment.frontendContext, ...combined.frontendContexts[fragment.lane.id] };
    return { ...combined, options };
}

test('canonical CI invocation executes original frontend attempts once and returns the complete vector', async (t) =>
{
    const { material, options } = frontendExecutionFixture(t);
    let cleanupCount = 0;
    Object.values(options.finalizerOperations)[0].execute = () => cleanupCount++;
    const capacity = structuredClone(options.capacity);
    const result = await executeCanonicalAtomicCiGroup(material, laneHostLimits, options);
    assert.equal(result.terminalVector.status, 'success');
    assert.equal(result.terminalVector.receipts.length, material.compiled.steps.length);
    assert.equal(result.ciMaterial.ciProjection.jobs[0].invocationCount, 1);
    assert.equal(cleanupCount, 1);
    assert.deepEqual(options.capacity, capacity);
    assert.equal(fs.readdirSync(path.join(options.context.evidenceRoot, options.context.schedulerRunId, 'atomic-dag')).length, 1);
    for (const receipt of result.terminalVector.receipts.filter((entry) => entry.attemptRef))
    {
        const attempt = JSON.parse(fs.readFileSync(receipt.attemptRef.path, 'utf8'));
        assert.equal(attempt.attemptNumber, 1);
        assert.equal(attempt.maxAttempts, 1);
    }
});

test('one frontend CI invocation preserves both independent failures, blocked child and cleanup in the original error', async (t) =>
{
    const { material, options } = frontendExecutionFixture(t, { alphaScenario: 'product-failure', betaScenario: 'product-failure' });
    let cleanupCount = 0;
    Object.values(options.finalizerOperations)[0].execute = () => cleanupCount++;
    await assert.rejects(executeCanonicalAtomicCiGroup(material, laneHostLimits, options), (error) =>
    {
        assert.ok(error instanceof AtomicProducerExecutionError);
        const receipts = Object.fromEntries(error.terminalVector.receipts.map((entry) => [entry.producerId, entry]));
        assert.equal(receipts['alpha-check'].terminalState, 'failed');
        assert.equal(receipts['beta-check'].terminalState, 'failed');
        assert.equal(receipts['dependent-check'].terminalState, 'blocked');
        assert.equal(receipts['dependent-check'].attemptRef, null);
        assert.equal(receipts['cleanup-inventory'].terminalState, 'success');
        assert.equal(error.terminalVector.qualificationEligible, false);
        return true;
    });
    assert.equal(cleanupCount, 1);
    assert.equal(fs.existsSync(path.join(options.context.evidenceRoot, options.context.schedulerRunId, 'dependent-check')), false);
});

test('canonical frontend invocation refuses partial selection and unknown CI ownership before creating attempts', async (t) =>
{
    const { material, options } = frontendExecutionFixture(t);
    await assert.rejects(executeCanonicalAtomicCiGroup({ ...material, selectedIds: [] }, laneHostLimits, options), /full-selection/u);
    const unrelatedJob = structuredClone(material);
    unrelatedJob.ciPlan.jobs.push({ id: 'second-ci-job', tiers: [] });
    // Empty planner jobs do not create another runner; actual step ownership stays canonical.
    unrelatedJob.ciPlan.jobs[0].tiers = [];
    await assert.rejects(executeCanonicalAtomicCiGroup(unrelatedJob, laneHostLimits, options), /exact-one canonical CI job/u);
    assert.deepEqual(fs.readdirSync(options.context.evidenceRoot), []);
});

function coverageFrontendExecutionFixture(t, scenarios = {})
{
    const coverage = originalLaneFixture(t, 'coverage', scenarios);
    const frontend = originalLaneFixture(t, 'frontend');
    const combined = composeOriginalLaneFixtures([coverage, frontend]);
    const options = { ...coverage.coverageContext,
        producerContexts: { ...coverage.coverageContext.producerContexts,
            ...combined.frontendContexts[frontend.lane.id].producerContexts },
        finalizerOperations: frontend.frontendContext.finalizerOperations };
    return { ...combined, options, coverage };
}

test('one global CI invocation executes original coverage input preparation alongside frontend without duplicate attempts', async (t) =>
{
    const { material, options } = coverageFrontendExecutionFixture(t);
    const result = await executeCanonicalAtomicCiGroup(material, laneHostLimits, options);
    assert.equal(result.terminalVector.status, 'success');
    assert.equal(result.terminalVector.receipts.length, material.compiled.steps.length);
    assert.equal(result.ciMaterial.laneBindings.length, 2);
    assert.equal(fs.readdirSync(path.join(options.context.evidenceRoot, options.context.schedulerRunId, 'atomic-dag')).length, 1);
});

async function collectedLaneTerminals(t, scenarios = {})
{
    const fixture = coverageFrontendExecutionFixture(t, scenarios);
    const { material, options, coverage, frontendContexts } = fixture;
    let vector;
    try
    {
        vector = (await executeCanonicalAtomicCiGroup(material, laneHostLimits, options)).terminalVector;
    }
    catch (error)
    {
        assert.ok(error instanceof AtomicProducerExecutionError);
        vector = error.terminalVector;
    }
    const repositoryRoot = coverage.lane.input.root;
    const vectorPath = path.join(options.context.evidenceRoot, vector.schedulerRunId, 'atomic-dag',
        material.compiled.contentDigest.slice(7), 'terminal-vector.json');
    const filesBefore = fs.readdirSync(path.dirname(vectorPath));
    const result = await collectCanonicalLaneAtomicTerminalMaterial({ ...material, repositoryRoot,
        vector, expectedVector: vector, terminalVectorRef: {
            path: path.relative(repositoryRoot, vectorPath).replaceAll(path.sep, '/'), objectDigest: vector.contentDigest
        } }, laneHostLimits, frontendContexts);
    assert.deepEqual(fs.readdirSync(path.dirname(vectorPath)), filesBefore);
    assert.equal(fs.readdirSync(path.dirname(path.dirname(vectorPath))).length, 1);
    return { result, vector, material, repositoryRoot };
}

test('canonical lane terminal collection indexes one successful coverage and frontend vector by original bindings', async (t) =>
{
    const { result, vector, material } = await collectedLaneTerminals(t);
    assert.equal(result.terminalCollection.sourceStatus, 'success');
    assert.equal(result.terminalCollection.receipts.length, material.compiled.steps.length);
    assert.equal(result.laneCollections.length, 2);
    for (const lane of result.laneCollections)
    {
        assert.deepEqual(lane.terminalStates.success, lane.producerIds);
        assert.deepEqual(lane.primaryFailureRefs, []);
        for (const reference of lane.receiptReferences)
        {
            assert.equal(reference.sourceReceiptDigest,
                vector.receipts.find((receipt) => receipt.producerId === reference.producerId).contentDigest);
        }
    }
    assert.equal(result.completeSourceCoverage, true);
    assert.equal(result.materializedTransport, false);
    assert.equal(result.qualificationEligible, false);
    assert.equal(result.verificationStatus, 'unverified');
});

test('canonical lane terminal collection preserves coverage failure and blocked roots alongside independent frontend success', async (t) =>
{
    const { result, vector, repositoryRoot } = await collectedLaneTerminals(t, { failedDomain: 'backend' });
    const coverage = result.laneCollections.find((lane) => lane.kind === 'coverage');
    const frontend = result.laneCollections.find((lane) => lane.kind === 'frontend');
    assert.deepEqual(coverage.terminalStates.failed, ['coverage-backend']);
    assert.ok(coverage.terminalStates.blocked.includes('coverage-merge'));
    assert.deepEqual(coverage.primaryFailureRefs, ['coverage-backend']);
    assert.ok(coverage.blockedBy.includes('coverage-backend'));
    assert.deepEqual(frontend.terminalStates.success, frontend.producerIds);
    assert.deepEqual(frontend.primaryFailureRefs, []);
    const original = vector.receipts.find((receipt) => receipt.producerId === 'coverage-backend');
    assert.deepEqual(result.terminalCollection.receipts.find((receipt) => receipt.producerId === 'coverage-backend').attemptRef,
        { path: path.relative(repositoryRoot, original.attemptRef.path), contentDigest: original.attemptRef.contentDigest });
});

test('separate canonical CI runner groups require the absent original job-scoped executor port', async (t) =>
{
    const { material, options, coverage } = coverageFrontendExecutionFixture(t);
    material.ciPlan.jobs = [{ id: 'coverage-runner', tiers: coverage.lane.input.matrix.tiers.map((entry) => entry.id) },
        { id: 'frontend-runner', tiers: ['frontend-source-fixture'] }];
    await assert.rejects(executeCanonicalAtomicCiGroup(material, laneHostLimits, options), /job-scoped execution capability/u);
    assert.equal(fs.existsSync(path.join(options.context.evidenceRoot, options.context.schedulerRunId)), false);
});

test('one global CI invocation settles real coverage collection failure and an independent frontend group', async (t) =>
{
    const { material, options, coverage } = coverageFrontendExecutionFixture(t, { failedDomain: 'backend' });
    await assert.rejects(executeCanonicalAtomicCiGroup(material, laneHostLimits, options), (error) =>
    {
        assert.ok(error instanceof AtomicProducerExecutionError);
        assert.equal(error.terminalVector.receipts.length, material.compiled.steps.length);
        const receipts = Object.fromEntries(error.terminalVector.receipts.map((entry) => [entry.producerId, entry]));
        assert.equal(receipts['coverage-backend'].terminalState, 'failed');
        assert.equal(receipts['coverage-frontend'].terminalState, 'success');
        assert.equal(receipts['coverage-merge'].terminalState, 'blocked');
        assert.equal(receipts['coverage-merge'].attemptRef, null);
        assert.equal(receipts['alpha-check'].terminalState, 'success');
        assert.equal(receipts['beta-check'].terminalState, 'success');
        return true;
    });
    assert.equal(fs.readdirSync(path.join(options.context.evidenceRoot, options.context.schedulerRunId, 'atomic-dag')).length, 1);
    assert.equal(fs.existsSync(path.join(coverage.lane.input.root, 'evidence', options.context.schedulerRunId, 'coverage-merge')), false);
});

test('global coverage input preparation preserves a held refusal with zero attempts and independent frontend success', async (t) =>
{
    const { material, options } = coverageFrontendExecutionFixture(t);
    const step = material.compiled.steps.find((entry) => entry.id === 'coverage-backend');
    options.producerContexts[step.id].requiredInputAdmission = { inputClosureRef: step.inputClosureRef,
        validate: () =>
        {
            throw new Error('held original input refusal');
        } };
    await assert.rejects(executeCanonicalAtomicCiGroup(material, laneHostLimits, options), (error) =>
    {
        const receipts = Object.fromEntries(error.terminalVector.receipts.map((entry) => [entry.producerId, entry]));
        assert.equal(receipts[step.id].reasonCode, 'required-input-admission-failed');
        assert.equal(receipts[step.id].attemptRef, null);
        assert.equal(receipts['coverage-merge'].terminalState, 'blocked');
        assert.equal(receipts['alpha-check'].terminalState, 'success');
        return true;
    });
});

test('public runtime preparation consumes its available original context port without granting reset or runtime admission', async (t) =>
{
    const fragment = originalLaneFixture(t, 'public-runtime');
    const { material } = composeOriginalLaneFixtures([fragment]);
    const held = fragment.publicRuntimeContext;
    const options = { ...held.executionOptions, publicRuntimeContexts: { [fragment.lane.id]: held } };
    const prepared = await prepareCanonicalAtomicCiGroup(material, laneHostLimits, options);
    assert.equal(prepared.lanePreparations[0].preparation.runtimeAuthorityStatus, 'unverified');
    assert.equal(prepared.ciMaterial.ciProjection, null);
    assert.equal(prepared.pendingLanes[0].reason, 'original-runtime-admission-and-reset-postflight-required');
    await assert.rejects(executeCanonicalAtomicCiGroup(material, laneHostLimits, options), /preparation remains pending/u);
    held.timeoutProfiles.load = 0;
    await assert.rejects(prepareCanonicalAtomicCiGroup(material, laneHostLimits, options), /original timeout profile/u);
    assert.equal(fs.existsSync(held.context.evidenceRoot), false);
});
