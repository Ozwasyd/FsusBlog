import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const {prepareCoverageProducer} = await import(new URL('../../tools/coverage/atomic-coverage-inputs.mjs', import.meta.url));
const {projectCoverageSettled} = await import(new URL('../../tools/coverage/atomic-coverage-projection.mjs', import.meta.url));
import { coverageFixture } from './support/atomic-coverage-fixtures.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');

function project(fixture, projectionId, outcomes, extra = {})
{
    return projectCoverageSettled({ ...fixture, projectionId, outcomes, ...extra });
}

function blocked(fixture, producerId, blockedBy)
{
    const value = { producerId, identity: fixture.identity, planDigest: fixture.plan.contentDigest,
        terminalState: 'blocked', blockedBy, primaryFailureRefs: [{ path: 'synthetic-failure.json', digest: fixture.plan.contentDigest }] };
    return { outcome: { blockedRef: fixture.write(`.tmp/blocked/${producerId}.json`, value) },
        verifyBlocked: ({ bytes }) => JSON.parse(bytes) };
}

test('collection projection retains failed/blocked siblings and never publishes a partial merged ref', (t) =>
{
    const fixture = coverageFixture(t);
    const join = blocked(fixture, 'coverage-merge', ['coverage-backend']);
    const result = project(fixture, 'coverage-gate-summary', {
        'coverage-backend': fixture.makeMaterial('coverage-backend', 'failed-no-retry'),
        'coverage-frontend': fixture.makeMaterial('coverage-frontend'), 'coverage-merge': join.outcome
    }, { verifyBlocked: join.verifyBlocked });
    assert.deepEqual(result.nodes.map((item) => item.terminalState), ['failed-no-retry', 'clean-success', 'blocked']);
    assert.equal(result.status, 'failed-no-retry');
    assert.deepEqual(Object.keys(result.summaryRefs), ['frontend']);
    assert.equal(result.qualificationEligible, false);
});

test('gate success exposes exactly merged/backend/frontend explicit summary refs', (t) =>
{
    const fixture = coverageFixture(t);
    const outcomes = Object.fromEntries(fixture.plan.producers.slice(0, 3).map((producer) => [producer.id, fixture.makeMaterial(producer.id)]));
    const result = project(fixture, 'coverage-gate-summary', outcomes);
    assert.equal(result.status, 'clean-success');
    assert.deepEqual(Object.keys(result.summaryRefs).sort(), ['backend', 'frontend', 'merged']);
    assert.equal(new Set(Object.values(result.summaryRefs).map((ref) => ref.path)).size, 3);
});

test('scope, merged and simultaneous backend/frontend threshold failures all survive settled projection', (t) =>
{
    const fixture = coverageFixture(t);
    const outcomes = Object.fromEntries(fixture.plan.producers.slice(3).map((producer) => [producer.id, fixture.makeMaterial(producer.id, 'failed-no-retry')]));
    const result = project(fixture, 'coverage-threshold-summary', outcomes);
    assert.equal(result.nodes.length, 4);
    assert.ok(result.nodes.every((item) => item.terminalState === 'failed-no-retry'));
    assert.equal(result.status, 'failed-no-retry');
    delete outcomes['coverage-scope-snapshot'];
    assert.equal(project(fixture, 'coverage-threshold-summary', outcomes).nodes[0].terminalState, 'missing');
});

test('merged threshold failure leaves real backend/frontend checker commands independently usable', (t) =>
{
    const fixture = coverageFixture(t);
    const inputs = Object.fromEntries(fixture.plan.producers.slice(0, 3).map((producer) => [producer.id, fixture.makeMaterial(producer.id, 'clean-success', (summary) =>
    {
        if (producer.id === 'coverage-merge')
        {
            summary.summary.linecoverage = 0;
        }
        return summary;
    })]));
    const exits = [];
    for (const domain of ['merged', 'backend', 'frontend'])
    {
        const parent = domain === 'merged' ? 'coverage-merge' : `coverage-${domain}`;
        const request = prepareCoverageProducer({ ...fixture, producerId: `coverage-threshold-${domain}`, inputs: { [parent]: inputs[parent] } });
        const args = request.command.slice(1);
        args[args.length - 1] = path.join(repositoryRoot, 'tools/coverage/check-threshold.sh');
        exits.push(spawnSync(request.command[0], args, { cwd: fixture.root, encoding: 'utf8' }).status);
    }
    assert.deepEqual(exits, [1, 0, 0]);
});

test('projection rejects omitted verifier, blocked tamper, unrelated edges and unknown outcomes', (t) =>
{
    const fixture = coverageFixture(t);
    const join = blocked(fixture, 'coverage-merge', ['coverage-backend']);
    const outcomes = { 'coverage-merge': join.outcome };
    assert.throws(() => project(fixture, 'coverage-gate-summary', outcomes), /verifier unavailable/u);
    assert.throws(() => project(fixture, 'coverage-gate-summary', { rogue: join.outcome }), /unknown projection\/member/u);
    assert.throws(() => project(fixture, 'coverage-gate-summary', outcomes, {
        verifyBlocked: (context) => ({ ...join.verifyBlocked(context), blockedBy: ['coverage-threshold-backend'] })
    }), /unrelated blocked/u);
    fs.appendFileSync(path.join(fixture.root, join.outcome.blockedRef.path), ' ');
    assert.throws(() => project(fixture, 'coverage-gate-summary', outcomes, { verifyBlocked: join.verifyBlocked }), /blocked receipt tamper/u);
});
