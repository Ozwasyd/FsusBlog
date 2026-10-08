import assert from 'node:assert/strict';
import test from 'node:test';

const { projectFailureNavigationMaterial, publishVerifiedFailureNavigation,
    renderFailureNavigationMaterial } = await import(new URL('../../tools/test-matrix/atomic-failure/failure-navigation.mjs', import.meta.url));
const { sealProjection } = await import(new URL('../../tools/test-matrix/atomic-failure/projection-contract.mjs', import.meta.url));
import { atomicFixture, hostLimits, repositoryRoot } from './support/atomic-failure-fixture.mjs';

function project(fixture = atomicFixture())
{
    const { launches, ...input } = fixture;
    assert.ok(launches);
    return projectFailureNavigationMaterial(input, hostLimits, repositoryRoot);
}

test('two original independent failures retain exact focused replay while transitive blocked has upstream refs only', () =>
{
    const projection = project();
    assert.deepEqual(projection.recommendedIndependentReplayGroups, [['failure-a', 'failure-b']]);
    for (const producer of projection.producers.filter((entry) => entry.producerId.startsWith('failure-')))
    {
        assert.equal(producer.firstFailurePreserved, true);
        for (const flag of ['--plan-digest', '--root-seed', '--shard-digest', '--workers', '--scheduler-seed', '--execution-envelope'])
        {
            assert.ok(producer.focusedReplayCommand.includes(flag));
        }
        assert.ok(producer.focusedReplayCommand.includes(producer.replayPlanRef.objectDigest));
        assert.equal(producer.focusedReplayCommand.includes('Production Fresh'), false);
    }
    const blocked = projection.producers.find((entry) => entry.producerId === 'dependent-transitive');
    assert.deepEqual(blocked.blockedBy, ['failure-a']);
    assert.equal(blocked.focusedReplayCommand, null);
    assert.equal(blocked.upstreamReplayRefs[0].producerId, 'failure-a');
    const summary = renderFailureNavigationMaterial(projection, hostLimits);
    assert.ok(summary.includes('failure-a: failed'));
    assert.ok(summary.includes('failure-b: failed'));
    assert.ok(summary.includes('blockedBy=failure-a'));
    assert.equal(summary.includes('independent-success:'), false);
});

for (const mutation of ['missing', 'duplicate', 'cross-run', 'private-path', 'blocked-self', 'blocked-wrong',
    'seed', 'worker', 'plan-ref', 'taxonomy', 'recovered', 'attempt-two'])
{
    test(`navigation refuses ${mutation} mutation`, () =>
    {
        const fixture = atomicFixture();
        const failed = fixture.terminals.find((entry) => entry.producerId === 'failure-a');
        const blocked = fixture.terminals.find((entry) => entry.producerId === 'dependent');
        if (mutation === 'missing')
        {
            fixture.terminals.pop();
        }
        if (mutation === 'duplicate')
        {
            fixture.terminals.push(structuredClone(failed));
        }
        if (mutation === 'cross-run')
        {
            failed.logRefs[0].path = '.tmp/test-runs/other/log.json';
        }
        if (mutation === 'private-path')
        {
            failed.logRefs[0].path = '.tmp/test-runs/atomic-fixture/private/source.json';
        }
        if (mutation === 'blocked-self')
        {
            blocked.replayPlanRef = failed.replayPlanRef;
        }
        if (mutation === 'blocked-wrong')
        {
            blocked.blockedBy = ['failure-b'];
        }
        if (mutation === 'seed')
        {
            failed.replayPlan.rootSeed = `seed256:${'88'.repeat(32)}`;
        }
        if (mutation === 'worker')
        {
            failed.replayPlan.workers.ids = ['worker-1'];
        }
        if (mutation === 'plan-ref')
        {
            failed.replayPlanRef.objectDigest = `sha256:${'0'.repeat(64)}`;
        }
        if (mutation === 'taxonomy')
        {
            failed.failures[0].kind = 'made-up.failure';
        }
        if (mutation === 'recovered')
        {
            failed.terminalState = 'success';
        }
        if (mutation === 'attempt-two')
        {
            failed.attemptNumber = 2;
        }
        assert.throws(() => project(fixture));
    });
}

test('replay grouping respects dependency, state write and exclusive-resource conflicts', () =>
{
    for (const mode of ['dependency', 'write', 'exclusive'])
    {
        const fixture = atomicFixture();
        const left = fixture.graph.nodes.find((node) => node.id === 'failure-a');
        const right = fixture.graph.nodes.find((node) => node.id === 'failure-b');
        if (mode === 'dependency')
        {
            right.settledDependsOn = ['failure-a'];
        }
        if (mode === 'write')
        {
            left.stateAccess = [{ domain: 'database', mode: 'write' }];
            right.stateAccess = [{ domain: 'database', mode: 'read' }];
        }
        if (mode === 'exclusive')
        {
            left.exclusiveResources = ['benchmark-window'];
            right.exclusiveResources = ['benchmark-window'];
        }
        assert.deepEqual(project(fixture).recommendedIndependentReplayGroups, [['failure-a'], ['failure-b']]);
    }
});

test('not-selected and diagnostic stay distinct from blocked and success', () =>
{
    const fixture = atomicFixture();
    const terminal = fixture.terminals.find((entry) => entry.producerId === 'independent-success');
    terminal.terminalState = 'not-selected';
    terminal.attemptReceiptRef = null;
    terminal.attemptNumber = 0;
    assert.equal(project(fixture).producers.find((entry) => entry.producerId === terminal.producerId).terminalState, 'not-selected');
    terminal.terminalState = 'diagnostic';
    terminal.attemptReceiptRef = fixture.terminals.find((entry) => entry.producerId === 'failure-b').attemptReceiptRef;
    terminal.attemptNumber = 1;
    assert.throws(() => project(fixture), /diagnostic/u);
    fixture.graph.nodes.find((node) => node.id === terminal.producerId).evidenceClass = 'diagnostic';
    assert.equal(project(fixture).producers.find((entry) => entry.producerId === terminal.producerId).terminalState, 'diagnostic');
});

test('digest tamper, data promotion and missing verifier bridge cannot publish correctness evidence', () =>
{
    const projection = structuredClone(project());
    projection.producers.pop();
    assert.throws(() => renderFailureNavigationMaterial(projection, hostLimits), /digest/u);
    const promoted = structuredClone(project());
    promoted.verificationStatus = 'verified';
    assert.throws(() => renderFailureNavigationMaterial(promoted, hostLimits));
    assert.throws(() => publishVerifiedFailureNavigation(sealProjection(projection), { verified: true }), /bridge unavailable/u);
});

test('descriptor-safe host budget checks run before material getters', () =>
{
    let reads = 0;
    const fixture = atomicFixture();
    delete fixture.launches;
    Object.defineProperty(fixture, 'aggregateRef', { enumerable: true, get()
    {
        reads += 1;
        return null;
    } });
    assert.throws(() => projectFailureNavigationMaterial(fixture, hostLimits, repositoryRoot), /accessor/u);
    assert.equal(reads, 0);
    assert.throws(() => projectFailureNavigationMaterial({}, {}, repositoryRoot), /host limits/u);
});
