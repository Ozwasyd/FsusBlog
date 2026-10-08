import assert from 'node:assert/strict';
import test from 'node:test';
import { URL } from 'node:url';

import { createSecurityAtomicFixture } from './support/security-atomic-fixtures.mjs';

const { createSecurityScenarioDispatchSession, projectSecurityScenarios } = await import(new URL('../../tools/test/security-atomic/scenarios.mjs', import.meta.url));

function dispatchFixture(options = {})
{
    const fixture = createSecurityAtomicFixture();
    const projection = fixture.register(projectSecurityScenarios({ ...fixture, mode: 'resident' }));
    const session = createSecurityScenarioDispatchSession({ ...fixture, projection,
        identity: { commit: fixture.context.sourceRevision, runId: fixture.context.runId,
            worktreeFingerprint: `sha256:${'c'.repeat(64)}` },
        resolveReferences: () => fixture.references,
        ...options });
    return { ...fixture, projection, session };
}

test('security dispatch initializes one shared host and invokes each original runner once without hidden reset', async () =>
{
    let initializationCount = 0;
    const calls = [];
    const originalUsername = process.env.FSUSBLOG_USER_USERNAME;
    const marker = {};
    const fixture = dispatchFixture({
        initializeRuntime: () =>
        {
            initializationCount += 1;
            return { marker };
        },
        loadRunner: (scenario) => async (request) =>
        {
            calls.push({ scenario, request, username: process.env.FSUSBLOG_USER_USERNAME });
            return { originalScenarioId: scenario.id };
        }
    });
    for (const producer of fixture.projection.producers)
    {
        assert.deepEqual(await fixture.session.dispatch({ scenarioId: producer.testId, attemptNumber: 1 }),
            { originalScenarioId: producer.testId });
    }
    assert.equal(initializationCount, 1);
    assert.equal(calls.length, fixture.projection.producers.length);
    assert.ok(calls.every(({ request }) => request.shared.marker === marker));
    assert.deepEqual(calls.map(({ request }) => request.scenarioId), fixture.projection.producers.map((item) => item.testId));
    assert.equal(new Set(calls.map((item) => item.username)).size, calls.length);
    assert.equal(process.env.FSUSBLOG_USER_USERNAME, originalUsername);
    assert.ok(fixture.session.attempts().every((attempt) => attempt.attemptNumber === 1 && attempt.status === 'success'));
    fixture.session.close();
});

test('failed dispatch preserves its original error and requires journal-backed revalidation before the next producer', async () =>
{
    const originalFailure = new Error('original runner assertion');
    let calls = 0;
    const fixture = dispatchFixture({ initializeRuntime: () => ({}), loadRunner: () => async () =>
    {
        calls += 1;
        if (calls === 1)
        {
            throw originalFailure;
        }
        return 'original second result';
    } });
    const [first, second] = fixture.projection.producers;
    await assert.rejects(fixture.session.dispatch({ scenarioId: first.testId, attemptNumber: 1 }),
        (error) => error === originalFailure);
    const failedReference = fixture.terminal(first.producerId, 'failed', [first.producerId]).reference;
    fixture.ownerVerifiers.hostAttemptReference = (attempt) =>
    {
        assert.equal(attempt.error, originalFailure);
        return failedReference;
    };
    fixture.references.hostRevalidation = fixture.reference('hostRevalidation', 'after-first-failure',
        { failures: [failedReference] });
    assert.equal(await fixture.session.dispatch({ scenarioId: second.testId, attemptNumber: 1 }), 'original second result');
    assert.equal(fixture.session.attempts()[0].error, originalFailure);
    assert.ok(fixture.calls.includes('hostRevalidation'));
});

test('cancelled dispatch holds its lease until the runner settles and then restores process environment', async () =>
{
    const controller = new AbortController();
    const reason = new Error('owned attempt cancelled');
    let finish;
    let started;
    const ready = new Promise((resolve) =>
    {
        started = resolve;
    });
    const settled = new Promise((resolve) =>
    {
        finish = resolve;
    });
    const previous = process.env.FSUSBLOG_DEVICE_FP;
    const fixture = dispatchFixture({ initializeRuntime: () => ({}), loadRunner: () => async () =>
    {
        started();
        await settled;
    } });
    const first = fixture.projection.producers[0];
    const dispatch = fixture.session.dispatch({ scenarioId: first.testId, attemptNumber: 1, signal: controller.signal });
    await ready;
    controller.abort(reason);
    assert.throws(() => fixture.session.close(), /active producer/u);
    const other = dispatchFixture({ initializeRuntime: () => ({}), loadRunner: () => async () => undefined });
    await assert.rejects(other.session.dispatch({ scenarioId: first.testId, attemptNumber: 1 }), /exclusive host lease/u);
    other.session.close();
    finish();
    await assert.rejects(dispatch, (error) => error === reason);
    assert.equal(fixture.session.attempts()[0].status, 'cancelled');
    assert.equal(process.env.FSUSBLOG_DEVICE_FP, previous);
    fixture.session.close();
});
