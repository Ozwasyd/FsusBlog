import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';

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
    assert.equal(Object.hasOwn(reason, 'preparationOwnerAssertionError'), false);
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


// Additional original variant first-cause cases, adapted to current no-accessor diagnostics.
for (const [label, reason] of [['zero', 0], ['false', false], ['empty', ''], ['null', null], ['undefined', undefined],
    ['frozen', Object.freeze(new Error('frozen tool failure'))]])
{
    test(`managed preparation retains ${label} ahead of after-owner refusal`, async () =>
    {
        const secondary = new Error('owner after assertion refused');
        let preparationFailure;
        let afters = 0;
        let rejected = false;
        try
        {
            await executeManagedPreparation(request, {
                executePreparation() { throw reason; },
                assertPreparationExecution(observation)
                {
                    if (observation.phase === 'after')
                    {
                        afters++;
                        preparationFailure = observation.preparationFailure;
                        throw secondary;
                    }
                }
            });
        }
        catch (actual) { rejected = true; assert.equal(actual, reason); }
        assert.equal(rejected, true);
        assert.equal(afters, 1);
        assert.equal(preparationFailure.failed, true);
        assert.equal(preparationFailure.reason, reason);
        assert.equal(preparationFailure.diagnostic.secondary.message, secondary.message);
    });
}

test('managed preparation never reads hostile thrown physical or diagnostic getters', async () =>
{
    let calls = 0;
    const reason = Object.defineProperties({}, {
        physicalExecution: { get() { calls++; throw new Error('terminal accessor'); } },
        message: { get() { calls++; throw new Error('message accessor'); } }
    });
    let after;
    await assert.rejects(executeManagedPreparation(request, {
        executePreparation() { throw reason; },
        assertPreparationExecution(observation) { if (observation.phase === 'after') after = observation; }
    }), (actual) => actual === reason);
    assert.equal(calls, 0);
    assert.equal(after.physicalExecution, null);
    assert.equal(after.preparationFailure.failed, true);
});

test('closed preparation purpose and invalid tuple refuse before the held owner or effects', async () =>
{
    let effects = 0;
    const ports = { executePreparation() { effects++; }, assertPreparationExecution() { effects++; } };
    for (const invalid of [{ ...request, purpose: 'matrix-governance' }, { ...request, command: ['bad\0argv'] },
        { ...request, cwd: 'relative' }, { ...request, environment: { HOME: null } }])
        await assert.rejects(executeManagedPreparation(invalid, ports), /original derived tool tuple/u);
    assert.equal(effects, 0);
});

// Exact current client body with in-memory transport; no broker, native command or grant is started.

const nestedSource = fs.readFileSync(new URL('../../tools/test/physical-execution-nested-channel.mjs', import.meta.url), 'utf8');
const clientBody = nestedSource.slice(nestedSource.indexOf('export async function runNestedPhysicalExecution')).replace('export ', '');
for (const phase of ['authorize', 'connect', 'send'])
{
    test(`actual nested client refuses original cancellation at ${phase} await fence`, async () =>
    {
        const controller = new AbortController();
        const reason = Object.freeze(new Error('original cancellation'));
        let connections = 0, runWrites = 0, cancelWrites = 0;
        const socket = new EventEmitter();
        socket.destroy = () => {};
        socket.once = (name, callback) =>
        {
            if (name === 'connect')
            {
                if (phase === 'connect') controller.abort(reason);
                callback();
            }
            return socket;
        };
        const run = vm.runInNewContext(`(${clientBody})`, {
            assertNestedPreparationCancellation,
            currentProcessIdentity: () => ({ pid: 1 }),
            async authorize() { if (phase === 'authorize') controller.abort(reason); },
            randomUUID: () => 'controlled', net: { createConnection() { connections++; return socket; } },
            setTimeout: () => 1, clearTimeout() {}, assertSocket() {},
            async send(_socket, message)
            {
                if (message.kind === 'run')
                {
                    runWrites++;
                    if (phase === 'send') controller.abort(reason);
                }
                else if (message.kind === 'cancel') cancelWrites++;
            },
            async *messages() { assert.fail('cancelled client must not await a terminal message'); }
        });
        await assert.rejects(run({ descriptor: { socket: { path: '/in-memory/owner.sock' } },
            command: ['/in-memory/tool'], cwd: '/in-memory', env: {}, signal: controller.signal,
            policy: { systemdResourceStartupTimeoutMs: 1 }, stdout: null, stderr: null }), (actual) => actual === reason);
        assert.equal(connections, phase === 'authorize' ? 0 : 1);
        assert.equal(runWrites, phase === 'send' ? 1 : 0);
        assert.equal(cancelWrites, phase === 'send' ? 1 : 0);
    });
}

test('actual nested client retains optional signal on its original no-input route', async () =>
{
    let connections = 0;
    const socket = new EventEmitter();
    socket.destroy = () => {};
    socket.once = (name, callback) => { if (name === 'connect') callback(); return socket; };
    const expected = { postObservation: 'zero-members', logComplete: true };
    const identity = { pid: 1 };
    const run = vm.runInNewContext(`(${clientBody})`, {
        assertNestedPreparationCancellation, currentProcessIdentity: () => identity,
        authorize: async () => {}, randomUUID: () => 'controlled',
        net: { createConnection() { connections++; return socket; } },
        setTimeout: () => 1, clearTimeout() {}, assertSocket() {}, send: async () => {}, verify: () => true, Buffer,
        async *messages()
        {
            yield { kind: 'hello', hello: { nonce: 'controlled', channelId: 'controlled', peer: identity }, signature: '' };
            yield { kind: 'result', result: expected };
        }
    });
    const actual = await run({ descriptor: { id: 'controlled', socket: { path: '/in-memory/socket' }, publicKey: 'controlled' },
        command: ['/in-memory/tool'], cwd: '/in-memory', env: {},
        policy: { systemdResourceStartupTimeoutMs: 1 }, stdout: null, stderr: null });
    assert.equal(actual, expected);
    assert.equal(connections, 1);
});
