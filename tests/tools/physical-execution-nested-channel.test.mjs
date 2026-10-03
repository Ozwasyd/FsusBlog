import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { executeManagedPreparation } from '../../tools/test/execution-envelope-environment.mjs';
import { assertNestedPreparationCancellation } from '../../tools/test/physical-execution-nested-channel.mjs';

// COMPONENT_SIMULATION: genuine AbortSignals, the production cancellation predicate and public consumer.
// Private admission/tool callbacks below are test doubles, not managed/kernel/cleanup qualifications.
const request = { purpose: 'executable-version', command: ['/component-fixture/tool', '--version'],
    cwd: '/component-fixture', environment: { PATH: '/component-fixture' } };
const retainedAttempt = () => ({ retainedDirectories: { fragment: { ownedRoot: '/component-fixture/owned-root' } } });

test('live production cancellation predicate leaves retained attempt unchanged', () =>
{
    const controller = new AbortController();
    const attempt = retainedAttempt();
    assert.equal(assertNestedPreparationCancellation(controller.signal, undefined, attempt), undefined);
    assert.deepEqual(Object.keys(attempt), ['retainedDirectories']);
});

test('public consumer preserves original cancellation at before entry without executing a tool', async () =>
{
    const controller = new AbortController();
    const reason = new Error('specific original before cancellation');
    const attempt = retainedAttempt();
    controller.abort(reason);
    let executions = 0;
    await assert.rejects(executeManagedPreparation(request, {
        assertPreparationExecution() { assertNestedPreparationCancellation(controller.signal, undefined, attempt); },
        executePreparation() { executions++; }
    }), (error) => error === reason);
    assert.equal(executions, 0);
    assert.equal(attempt.preparationCancellationReason, reason);
    assert.equal(attempt.recoveryObligation.ownedRoot, '/component-fixture/owned-root');
});

test('public consumer preserves execute cancellation ahead of its secondary after assertion', async () =>
{
    const controller = new AbortController();
    const reason = new Error('specific original execute cancellation');
    const attempt = retainedAttempt();
    let effects = 0;
    await assert.rejects(executeManagedPreparation(request, {
        assertPreparationExecution() { assertNestedPreparationCancellation(controller.signal, undefined, attempt); },
        executePreparation()
        {
            controller.abort(reason);
            assertNestedPreparationCancellation(controller.signal, undefined, attempt);
            effects++;
        }
    }), (error) => error === reason);
    assert.equal(effects, 0);
    assert.equal(reason.preparationOwnerAssertionError, reason);
    assert.equal(attempt.preparationCancellationReason, reason);
});

test('public consumer keeps cancel first reason after an admission await and simulated phase closure', async () =>
{
    const controller = new AbortController();
    const reason = new Error('specific original awaiting cancellation');
    const attempt = retainedAttempt();
    let release;
    const admission = new Promise((resolve) => { release = resolve; });
    let entered;
    const admitted = new Promise((resolve) => { entered = resolve; });
    let effects = 0;
    const result = executeManagedPreparation(request, {
        assertPreparationExecution() { assertNestedPreparationCancellation(controller.signal, undefined, attempt); },
        async executePreparation()
        {
            entered();
            await admission;
            assertNestedPreparationCancellation(controller.signal, undefined, attempt);
            if (attempt.phase === 'finalizing') throw new Error('simulated secondary closed phase');
            effects++;
        }
    });
    await admitted;
    attempt.phase = 'finalizing';
    controller.abort(reason);
    release();
    await assert.rejects(result, (error) => error === reason);
    assert.equal(effects, 0);
    assert.equal(attempt.preparationCancellationReason, reason);
});

test('live public consumer keeps original tool failure as first reason', async () =>
{
    const controller = new AbortController();
    const attempt = retainedAttempt();
    const reason = new Error('original tool failure with live cancellation signal');
    let assertions = 0;
    await assert.rejects(executeManagedPreparation(request, {
        assertPreparationExecution()
        {
            assertions++;
            assertNestedPreparationCancellation(controller.signal, undefined, attempt);
        },
        executePreparation() { throw reason; }
    }), (error) => error === reason);
    assert.equal(assertions, 2);
    assert.equal(attempt.preparationCancellationReason, undefined);
});

test('frozen original cancellation reason is not mutated and existing recovery obligation is retained', async () =>
{
    const controller = new AbortController();
    const reason = Object.freeze(new Error('frozen original cancellation'));
    const obligation = { ownedRoot: '/component-fixture/original', reason: 'original recovery obligation' };
    const attempt = { ...retainedAttempt(), recoveryObligation: obligation };
    controller.abort(reason);
    await assert.rejects(executeManagedPreparation(request, {
        assertPreparationExecution() { assertNestedPreparationCancellation(controller.signal, undefined, attempt); },
        executePreparation() { assert.fail('canceled before entry must not execute'); }
    }), (error) => error === reason);
    assert.equal(attempt.recoveryObligation, obligation);
    assert.equal(Object.hasOwn(reason, 'recoveryObligation'), false);
});

test('cancellation nullish priority matches original admission and preserves upstream reason', () =>
{
    const controller = new AbortController();
    const upstream = new AbortController();
    const reason = new Error('original upstream cancellation');
    controller.abort(null);
    upstream.abort(reason);
    const attempt = retainedAttempt();
    assert.throws(() => assertNestedPreparationCancellation(controller.signal, upstream.signal, attempt),
        (error) => error === reason);
    assert.equal(attempt.preparationCancellationReason, reason);
});

test('null cancellation without upstream keeps original admission fallback message', () =>
{
    const controller = new AbortController();
    controller.abort(null);
    const attempt = retainedAttempt();
    assert.throws(() => assertNestedPreparationCancellation(controller.signal, undefined, attempt),
        (error) => error === attempt.preparationCancellationReason && error.message === 'nested execution owner is closed');
    assert.equal(attempt.recoveryObligation.ownedRoot, '/component-fixture/owned-root');
});

test('native default AbortSignal reason remains the original reason object', () =>
{
    const controller = new AbortController();
    controller.abort();
    assert.throws(() => assertNestedPreparationCancellation(controller.signal, undefined, retainedAttempt()),
        (error) => error === controller.signal.reason);
});

test('SOURCE wiring keeps the tested cancellation predicate before the private phase refusal and effect fence', () =>
{
    const source = fs.readFileSync(new URL('../../tools/test/physical-execution-nested-channel.mjs', import.meta.url), 'utf8');
    assert.match(source, /const assertPreparationOpen = \(\) =>\s*\{\s*assertNestedPreparationCancellation\(preparationSignal, signal, attempt\);\s*if \(preparationClosed/u);
    assert.match(source, /assertPreparationOpen\(\);\s*tool\.phase = 'running';\s*tool\.started = true;/u);
    // This source wiring assertion is not execution of the actual private controller/admission/cleanup race.
});

// SOURCE COMPONENT_SIMULATION: the production local diagnostic codec/carrier only; no broker or physical owner runs.
// The old ten SOURCE controls above are unchanged. Importing this module is not a recorded qualification run.
const { nestedFailureProperty, retainNestedFailure, serializedNestedError, rebuiltNestedError }
    = await import('../../tools/test/physical-execution-nested-channel.mjs');

for (const [label, reason] of [['frozen', Object.freeze(new Error('specific first'))], ['zero', 0], ['false', false],
    ['empty', ''], ['null', null], ['undefined', undefined]])
{
    test(`production nested local carrier preserves ${label} first reason through cleanup and six-field projection`, () =>
    {
        const owner = {};
        const secondary = new Error('cleanup');
        retainNestedFailure(owner, reason);
        retainNestedFailure(owner, secondary, true);
        assert.equal(owner.failed, true);
        assert.equal(owner.failure, reason);
        assert.equal(owner.secondaryFailures[0].reason, secondary);
        assert.equal(owner.secondaryFailures[0].cleanup, true);
        const diagnostic = serializedNestedError(owner, reason);
        assert.deepEqual(Object.keys(diagnostic).sort(), ['name', 'message', 'code', 'exitCode', 'signal', 'physicalExecution'].sort());
        assert.equal(typeof diagnostic.message, 'string');
        const signal = { aborted: true, reason }; // Includes undefined: explicit presence, not native abort()'s default DOMException.
        assert.equal(rebuiltNestedError(diagnostic, signal), reason);
    });
}

test('production nested mutable compatibility and live remote diagnostic reconstruction are non-authoritative', () =>
{
    const owner = {};
    const first = new Error('specific first');
    const secondary = new Error('cleanup');
    retainNestedFailure(owner, first);
    retainNestedFailure(owner, secondary, true);
    assert.equal(first.nestedExecutionCleanupError, secondary);
    const diagnostic = serializedNestedError(owner, first);
    const remote = rebuiltNestedError(diagnostic, new AbortController().signal);
    assert.notEqual(remote, first); // Cross-process arbitrary object identity is not promised by the six-field DTO.
    assert.equal(remote.message, first.message);
    assert.equal(remote.physicalExecution, null);
    assert.equal(rebuiltNestedError({ ...diagnostic, forgedPermission: true }, undefined).message,
        'nested execution error diagnostic is invalid');
});

test('nested codec retains getter/cycle failures and cannot report unknown physical evidence as zero', () =>
{
    const owner = {};
    const metadataReason = new Error('hostile physical getter');
    const first = Object.defineProperty({}, 'physicalExecution', { get() { throw metadataReason; } });
    retainNestedFailure(owner, first);
    assert.equal(nestedFailureProperty(owner, first, 'physicalExecution'), null);
    assert.equal(serializedNestedError(owner, first).physicalExecution, null);
    assert.equal(owner.failure, first);
    assert.ok(owner.metadataFailures.some((record) => record.reason === metadataReason));
    const cycle = {};
    cycle.self = cycle;
    assert.equal(serializedNestedError(owner, { physicalExecution: cycle }).physicalExecution, null);
    assert.equal(owner.failure, first);
});

test('SOURCE request, attempt, startup cleanup and local cancel paths consume the production safe carrier', () =>
{
    const source = fs.readFileSync(new URL('../../tools/test/physical-execution-nested-channel.mjs', import.meta.url), 'utf8');
    assert.match(source, /retainNestedFailure\(attempt, error\);\s*attempt\.physicalExecution = nestedFailureProperty/u);
    assert.match(source, /retainNestedFailure\(request, error\);/u);
    assert.match(source, /error: serializedNestedError\(request, error\)/u);
    assert.match(source, /retainNestedFailure\(failureState, cleanupError, true\);/u);
    assert.match(source, /throw rebuiltNestedError\(message\.error, signal\);/u);
    assert.match(source, /if \(failureState\.failed\) throw failureState\.failure;/u);
    assert.doesNotMatch(source, /error\.nestedExecutionCleanupError\s*=|if \(error\.physicalExecution\)|failure \?\?=/u);
    // These are SOURCE wiring assertions, not live transport/cancel/cleanup or SO_PEERCRED qualification.
});
