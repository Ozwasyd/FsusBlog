import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const {
    canonicalTerminalScenarioIds,
    createTerminalEvents,
    scenarioTerminalEvent,
    verifyTerminalEvents
} = await import(pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tools/test/release-reliability-terminal.mjs')).href);

function results()
{
    return canonicalTerminalScenarioIds.map(scenarioId => ({
        scenarioId, status: 'passed', producerSpawned: true,
        evidenceClass: 'correctness', qualificationEligible: true,
        authoritativeEvidence: { path: `${scenarioId}.json`, digest: 'sha256:controlled' },
        cleanupFailures: [], firstFailure: null,
        producer: { exitCode: 0, signal: null, timedOut: false },
        lifecycle: { actions: [{ phase: 'measurement', status: 'passed', receipt: { path: scenarioId } }] },
        startedAt: '2026-10-08T00:00:00.000Z', finishedAt: '2026-10-08T00:00:01.000Z'
    }));
}

test('all seven successful terminal events retain independent attribution', () =>
{
    const input = results();
    const events = createTerminalEvents(input);
    assert.equal(events.length, 7);
    assert.ok(events.every(event => event.terminalClassification === 'qualified-success'));
    assert.equal(verifyTerminalEvents(events, input), true);
    input[2].status = 'failed';
    assert.equal(createTerminalEvents(input)[2].terminalClassification, 'infra-no-conclusion');
    assert.equal(createTerminalEvents(input)[1].terminalClassification, 'qualified-success');
});

test('missing, duplicate, extra, unknown and reordered events fail closed', () =>
{
    const input = results();
    for (const invalid of [input.slice(1), [...input, input[0]],
        [...input.slice(1), input[1]], [...input.slice(1), { ...input[0], scenarioId: 'unknown' }]])
    {
        assert.throws(() => createTerminalEvents(invalid), /exactly seven/u);
    }
    assert.throws(() => verifyTerminalEvents(createTerminalEvents(input).reverse(), input), /canonical order/u);
    const substituted = createTerminalEvents(input);
    substituted[2].terminalClassification = 'product-failure';
    assert.throws(() => verifyTerminalEvents(substituted, input), /attribution/u);
});

test('cancel, signal and timeout remain distinct from product and admission failures', () =>
{
    const original = results()[0];
    for (const change of [{ status: 'cancelled' }, { producer: { signal: 'SIGTERM' } }])
    {
        const event = scenarioTerminalEvent({ ...original, ...change });
        assert.equal(event.terminalClassification, 'cancelled');
        assert.equal(event.authoritativeEvidence, null);
    }
    const timedOut = scenarioTerminalEvent({ ...original, status: 'timed-out',
        cancellation: {}, producer: { timedOut: true, signal: 'SIGTERM' } });
    assert.equal(timedOut.terminalClassification, 'infra-no-conclusion');
    assert.throws(() => scenarioTerminalEvent({ ...original, producerSpawned: false }), /cannot have/u);
    assert.throws(() => scenarioTerminalEvent({ ...original, producerSpawned: false,
        status: 'cancelled' }), /cannot have/u);
    assert.equal(scenarioTerminalEvent({ ...original, producerSpawned: false,
        authoritativeEvidence: null, status: 'failed' }).terminalClassification, 'precondition-failure');
});

test('not reached cannot contain executed actions or authoritative payloads', () =>
{
    const original = results()[0];
    assert.throws(() => scenarioTerminalEvent({ ...original, status: 'not-reached' }), /contains execution/u);
    const event = scenarioTerminalEvent({ ...original, status: 'not-reached',
        producerSpawned: false, authoritativeEvidence: null, lifecycle: { actions: [] } });
    assert.equal(event.terminalClassification, 'not-reached');
    assert.equal(event.startedAt, null);
});

test('secondary cleanup failure cannot replace the first attributable product failure', () =>
{
    const original = results()[0];
    const event = scenarioTerminalEvent({
        ...original, status: 'failed', qualificationEligible: false,
        firstFailure: { phase: 'measurement', message: 'original measured product failure' },
        cleanupFailures: [{ phase: 'reset-after', message: 'secondary cleanup failure' }],
        lifecycle: { actions: [{ phase: 'measurement', status: 'failed',
            failureEvidence: { classification: 'product-failure',
                path: original.authoritativeEvidence.path, bytesDigest: original.authoritativeEvidence.digest },
            processTreeReceipt: { postObservation: 'zero-members' } }] }
    });
    assert.equal(event.terminalClassification, 'product-failure');
    assert.equal(event.firstBlockingReason, 'original measured product failure');
});
