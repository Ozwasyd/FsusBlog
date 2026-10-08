import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

const { buildSettledPhaseJoinEvidence, executeWeightedStepDag, StepDagExecutionError,
    StepTerminalError } = await import(new URL('../../tools/test/bundles/bundle-steps.mjs', import.meta.url));
const { projectAtomicCiMaterial } = await import(new URL('../../tools/test-matrix/atomic-failure/ci-projection.mjs', import.meta.url));
const { analyzeAtomicExecutionMaterial } = await import(new URL('../../tools/test-matrix/atomic-failure/conformance.mjs', import.meta.url));
const { analyzeExecutableAuthorityMaterial } = await import(new URL('../../tools/test-matrix/atomic-failure/executable-authorities.mjs', import.meta.url));
const { projectFailureNavigationMaterial } = await import(new URL('../../tools/test-matrix/atomic-failure/failure-navigation.mjs', import.meta.url));
const { sealProjection } = await import(new URL('../../tools/test-matrix/atomic-failure/projection-contract.mjs', import.meta.url));
import { atomicFixture, hostLimits, repositoryRoot } from './support/atomic-failure-fixture.mjs';

function conformanceFixture()
{
    const fixture = atomicFixture();
    const { worktreeFingerprint, ...context } = fixture.context;
    assert.ok(worktreeFingerprint);
    const ciProjection = projectAtomicCiMaterial({ context, graph: fixture.graph,
        selectedIds: fixture.graph.nodes.map((node) => node.id) }, hostLimits);
    const { launches, ...navigationInput } = fixture;
    return { graph: fixture.graph, observations: fixture.terminals.map((terminal) => ({
        producerId: terminal.producerId, terminalState: terminal.terminalState,
        spawnCount: terminal.terminalState === 'blocked' ? 0 : 1, attemptNumber: terminal.attemptNumber,
        retries: 0, blockedBy: terminal.blockedBy, primaryFailureRefs: terminal.primaryFailureRefs })),
    ciProjection, localProjection: structuredClone(ciProjection),
    navigation: projectFailureNavigationMaterial(navigationInput, hostLimits, repositoryRoot),
    scanner: analyzeExecutableAuthorityMaterial({ graph: fixture.graph, launches }, hostLimits) };
}

test('analysis preserves all independent failures and stays ineligible for terminal acceptance', () =>
{
    const result = analyzeAtomicExecutionMaterial(conformanceFixture(), hostLimits);
    assert.equal(result.independentFailures, 2);
    assert.equal(result.localCiDrift, 0);
    assert.equal(result.retries, 0);
    assert.equal(result.terminalAcceptancePending, true);
    assert.equal(result.dataOnly, true);
});

for (const mutation of ['first-error', 'retry', 'dependent-spawn', 'blocked-success', 'cleanup-omitted',
    'duplicate-build', 'local-ci-drift', 'first-only-navigation', 'hidden-wrapper', 'primary-overwrite', 'stale-dag'])
{
    test(`conformance rejects ${mutation} regression`, () =>
    {
        const input = structuredClone(conformanceFixture());
        const dependent = input.observations.find((entry) => entry.producerId === 'dependent');
        if (mutation === 'first-error')
        {
            input.observations.find((entry) => entry.producerId === 'failure-b').terminalState = 'cancelled';
        }
        if (mutation === 'retry')
        {
            input.observations[0].retries = 1;
        }
        if (mutation === 'dependent-spawn')
        {
            dependent.spawnCount = 1;
        }
        if (mutation === 'blocked-success')
        {
            dependent.terminalState = 'success';
        }
        if (mutation === 'cleanup-omitted')
        {
            input.observations.find((entry) => entry.producerId === 'cleanup').spawnCount = 0;
        }
        if (mutation === 'duplicate-build')
        {
            input.observations.find((entry) => entry.producerId === 'independent-success').spawnCount = 2;
        }
        if (mutation === 'local-ci-drift')
        {
            input.localProjection = sealProjection({ ...input.localProjection, jobs: [] });
        }
        if (mutation === 'first-only-navigation')
        {
            input.navigation = sealProjection({ ...input.navigation,
                producers: input.navigation.producers.filter((entry) => entry.producerId !== 'failure-b') });
        }
        if (mutation === 'hidden-wrapper')
        {
            input.scanner = sealProjection({ ...input.scanner,
                accepted: false, findings: [{ code: 'hidden-executable-authorities' }] });
        }
        if (mutation === 'primary-overwrite')
        {
            input.observations[0].primaryFailureRefs = [];
        }
        if (mutation === 'stale-dag')
        {
            input.graph.dagDigest = `sha256:${'0'.repeat(64)}`;
        }
        assert.throws(() => analyzeAtomicExecutionMaterial(input, hostLimits));
    });
}

test('existing weighted scheduler collects two real child failures, blocks transitive descendants and runs settled join/finalizer once', async () =>
{
    const fixture = atomicFixture();
    const counts = new Map();
    const results = new Map();
    const steps = fixture.graph.nodes.map((node) => ({ id: node.id, dependsOn: node.dependsOn,
        settledDependsOn: node.settledDependsOn, command: node.evidenceClass === 'coordination' ? [] : [process.execPath, '--eval',
            node.id.startsWith('failure-') ? 'process.exit(7)' : 'process.exit(0)'], members: [],
        runAfterSettled: node.kind === 'settled-join', alwaysRunFinalizer: node.kind === 'finalizer',
        ...(node.kind === 'finalizer' ? { finalizerPurpose: 'cleanup' } : {}),
        resources: node.evidenceClass === 'coordination' ? { coordinationOnly: true }
            : { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 } }));
    let failure;
    try
    {
        await executeWeightedStepDag(steps, { maxParallel: 3, cpuUnits: 3, memoryGiB: 3 }, async (entry) =>
        {
            counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1);
            if (entry.runAfterSettled)
            {
                const { evidence } = buildSettledPhaseJoinEvidence({ stepId: entry.id, dependencyIds: entry.settledDependsOn,
                    dependencyOutcomes: entry.dependencyOutcomes, dependencyResults: results });
                return { terminalState: evidence.terminalState, evidence };
            }
            if (entry.alwaysRunFinalizer)
            {
                return { terminalState: 'success' };
            }
            const exit = await new Promise((resolve, reject) =>
            {
                const child = spawn(entry.command[0], entry.command.slice(1), { stdio: 'ignore' });
                child.once('error', reject);
                child.once('exit', (code) => resolve(code));
            });
            results.set(entry.id, { terminalState: exit === 0 ? 'success' : 'failed', startedAtMs: 0, finishedAtMs: 1 });
            if (exit !== 0)
            {
                throw new Error(`child exit ${exit}`);
            }
            return { terminalState: 'success' };
        });
    }
    catch (error)
    {
        failure = error;
    }
    assert.ok(failure instanceof StepDagExecutionError);
    assert.equal(failure.states['failure-a'], 'failed');
    assert.equal(failure.states['failure-b'], 'failed');
    assert.equal(failure.states['independent-success'], 'success');
    assert.equal(failure.states.dependent, 'blocked');
    assert.equal(failure.states['dependent-transitive'], 'blocked');
    assert.equal(failure.states['settled-summary'], 'failed');
    assert.equal(failure.states.cleanup, 'success');
    assert.equal(counts.has('dependent'), false);
    assert.equal(counts.has('dependent-transitive'), false);
    assert.ok([...counts.values()].every((count) => count === 1));
    assert.deepEqual(failure.terminalReceipts['settled-summary'].primaryFailureRefs, ['failure-a', 'failure-b']);
});

for (const state of ['failed', 'timed-out', 'cancelled'])
{
    test(`weighted scheduler invokes declared cleanup after ${state} without replacing primary failure`, async () =>
    {
        const counts = [];
        const steps = [{ id: 'primary', dependsOn: [], command: ['fixture'], members: [],
            resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 } },
        { id: 'cleanup', dependsOn: [], settledDependsOn: ['primary'], command: [], members: [],
            alwaysRunFinalizer: true, finalizerPurpose: 'cleanup', resources: { coordinationOnly: true } }];
        const primary = new StepTerminalError(state, 'fixture-primary', 'original primary');
        await assert.rejects(executeWeightedStepDag(steps, { maxParallel: 1, cpuUnits: 1, memoryGiB: 2 }, (entry) =>
        {
            counts.push(entry.id);
            if (entry.id === 'primary')
            {
                throw primary;
            }
            throw new Error('cleanup failed');
        }), (error) =>
        {
            assert.equal(error.cause, primary);
            assert.equal(error.states.primary, state);
            assert.equal(error.states.cleanup, 'failed');
            return true;
        });
        assert.deepEqual(counts, ['primary', 'cleanup']);
    });
}
