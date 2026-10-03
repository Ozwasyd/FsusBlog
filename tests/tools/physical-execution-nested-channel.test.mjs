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
