import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { runDag } = await import(new URL('../../tools/test-matrix/scheduler.mjs', import.meta.url));

function fixture(t, count = 2)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-abort-input-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const controller = new AbortController();
    const tiers = Array.from({ length: count }, (_, index) => ({ id: `ordinary-${index}`,
        command: 'echo controlled', cacheInputs: [], executionDependsOn: [], services: [], parallelizable: true,
        exclusiveResources: [], resourceClass: 'cpu', cpuUnits: 1, memoryGiB: 1 }));
    const options = { root, runsRoot: path.join(root, 'runs'), runId: 'abort-input-run', signal: controller.signal,
        targetTierId: tiers.at(-1).id, tiers, maxParallel: 1, collectFailures: true, dynamicPriority: false,
        systemResources: { cpuCount: 1, availableMemoryGiB: 8, load1: 0 }, currentFreeMemoryGiB: () => 8,
        sourceState: { commit: 'b'.repeat(40), worktreeFingerprint: 'controlled' },
        snapshotWorktree: async () => ({ fingerprint: 'controlled', entries: new Map() }),
        executeTier: async () => ({ code: 0, signal: null }) };
    return { options, controller };
}

test('pre-aborted scheduler preserves the exact reason without snapshotting or acquiring an owner', async (t) =>
{
    const current = fixture(t);
    const reason = new Error('ordinary requested cancellation', { cause: new Error('caller') });
    current.controller.abort(reason);
    current.options.snapshotWorktree = async () => assert.fail('pre-aborted scheduler must not snapshot');
    current.options.executeTier = async () => assert.fail('pre-aborted scheduler must not execute');
    await assert.rejects(runDag(current.options), (error) => error === reason);
    assert.equal(fs.existsSync(current.options.runsRoot), false);
});

test('abort during initial source observation refuses ownership and admission', async (t) =>
{
    const current = fixture(t);
    const reason = new Error('cancel during source observation');
    current.options.snapshotWorktree = async () =>
    {
        current.controller.abort(reason);
        return { fingerprint: 'controlled', entries: new Map() };
    };
    await assert.rejects(runDag(current.options), (error) => error === reason);
    assert.equal(fs.existsSync(current.options.runsRoot), false);
});

test('abort before interrupt subscription records cancellation with zero pending admission', async (t) =>
{
    const current = fixture(t);
    current.options.onSourceState = () => current.controller.abort(new Error('cancel before admission'));
    current.options.executeTier = async () => assert.fail('cancelled work must not execute');
    const result = await runDag(current.options);
    assert.equal(result.status, 'failure');
    assert.equal(result.checkpoint.failure.signal, 'AbortSignal');
    assert.ok(Object.values(result.checkpoint.tiers).every((tier) => tier.status === 'cancelled'));
    assert.equal(Object.keys(result.checkpoint.schedulerAdmissions).length, 0);
    assert.equal(getEventListeners(current.controller.signal, 'abort').length, 0);
});

test('abort while active work holds capacity settles it and prevents pending admission even when collecting failures',
    { timeout: 5000 }, async (t) =>
    {
        const current = fixture(t);
        const started = [];
        const terminated = [];
        const ready = Promise.withResolvers();
        const settled = Promise.withResolvers();
        current.options.executeTier = async (tier, context) =>
        {
            assert.equal(context.signal, current.controller.signal);
            started.push(tier.id);
            ready.resolve();
            return settled.promise;
        };
        current.options.abortTier = (tier) =>
        {
            terminated.push(tier.id);
            settled.resolve({ code: 130, signal: null });
        };
        const execution = runDag(current.options);
        await ready.promise;
        current.controller.abort(new Error('cancel resource wait'));
        const result = await execution;
        assert.equal(result.status, 'failure');
        assert.deepEqual(started, ['ordinary-0']);
        assert.deepEqual(terminated, ['ordinary-0']);
        assert.equal(result.checkpoint.tiers['ordinary-0'].status, 'cancelled');
        assert.equal(result.checkpoint.tiers['ordinary-1'].status, 'cancelled');
        assert.equal(getEventListeners(current.controller.signal, 'abort').length, 0);
        assert.equal(result.checkpoint.authoritative, false);
    });

test('abort after the first dispatch closes the remainder of an already selected admission wave',
    { timeout: 5000 }, async (t) =>
    {
        const current = fixture(t);
        current.options.maxParallel = 2;
        current.options.systemResources.cpuCount = 2;
        const started = [];
        const settled = Promise.withResolvers();
        current.options.executeTier = async (tier) =>
        {
            started.push(tier.id);
            current.controller.abort(new Error('cancel during wave'));
            return settled.promise;
        };
        current.options.abortTier = () => settled.resolve({ code: 130, signal: null });
        const result = await runDag(current.options);
        assert.equal(result.status, 'failure');
        assert.deepEqual(started, ['ordinary-0']);
        assert.equal(result.checkpoint.tiers['ordinary-1'].status, 'cancelled');
    });

test('ordinary successful scheduling removes the abort subscription without invoking cancellation', async (t) =>
{
    const current = fixture(t, 1);
    current.options.abortTier = () => assert.fail('successful scheduler must not cancel');
    const result = await runDag(current.options);
    assert.equal(result.status, 'success');
    assert.equal(getEventListeners(current.controller.signal, 'abort').length, 0);
});

test('abort inside ordinary pre-dispatch preparation prevents executor invocation', async (t) =>
{
    const current = fixture(t);
    current.options.beforeTierStart = () => current.controller.abort(new Error('cancel prepared dispatch'));
    current.options.executeTier = async () => assert.fail('prepared cancelled work must not execute');
    const result = await runDag(current.options);
    assert.equal(result.status, 'failure');
    assert.ok(Object.values(result.checkpoint.tiers).every((tier) => tier.status === 'cancelled'));
});

test('abort during the last source snapshot closes the log pipeline before executor invocation', async (t) =>
{
    const current = fixture(t);
    let snapshots = 0;
    current.options.snapshotWorktree = async () =>
    {
        if (++snapshots === 2)
        {
            current.controller.abort(new Error('cancel before dispatch snapshot'));
        }
        return { fingerprint: 'controlled', entries: new Map() };
    };
    current.options.executeTier = async () => assert.fail('snapshot cancelled work must not execute');
    const result = await runDag(current.options);
    assert.equal(result.status, 'failure');
    assert.ok(Object.values(result.checkpoint.tiers).every((tier) => tier.status === 'cancelled'));
});
