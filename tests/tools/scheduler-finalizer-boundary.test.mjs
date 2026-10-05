import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = fs.readFileSync(path.join(root, 'tools/test-matrix/scheduler.mjs'), 'utf8');
const marker = 'export async function runDag(options)';
assert.equal(source.split(marker).length, 2);
const boundary = source.slice(source.indexOf(marker)).replace('export ', '');

// Execute the current canonical boundary with dependency ports, not a second
// scheduler implementation. These Node models do not qualify physical resources.
function model({ executionFailure, throwsExecution = false, cleanupFailures = [] } = {})
{
    const events = [];
    const result = { status: 'success', checkpoint: { modelOnly: true } };
    const release = (state) => events.push(['release', state]);
    release.owner = { candidateIdentityDigest: 'unit-candidate', ownerToken: 'unit-owner' };
    release.markRunning = () => events.push(['running']);
    release.markFinalizing = () => events.push(['finalizing']);
    const run = runInNewContext('(' + boundary + ')', {
        path,
        process: { env: {} },
        resolveRealOrAncestralPath: (value) => value,
        safeRunId: (value) => value,
        acquireRunLock: () => release,
        async runDagUnlocked(options)
        {
            assert.equal(options.runId, 'unit-finalization');
            assert.equal(options.schedulerRunOwnerToken, release.owner.ownerToken);
            assert.equal(options.schedulerCandidateIdentityDigest, release.owner.candidateIdentityDigest);
            for (const [index, failure] of cleanupFailures.entries())
            {
                options.registerSchedulerFinalizer(async () =>
                {
                    events.push(['cleanup', index]);
                    if (failure !== null)
                    {
                        throw failure;
                    }
                });
            }
            if (throwsExecution)
            {
                throw executionFailure;
            }
            return result;
        }
    });
    return { events, result, run: () => run({
        root,
        runId: 'unit-finalization',
        sourceState: { commit: 'unit-source', worktreeFingerprint: 'unit-fingerprint' },
        snapshotWorktree: async () => ({ fingerprint: 'unit-fingerprint' })
    }) };
}

test('finalizer unit model retains successful result and cleans each port once in reverse order', async () =>
{
    const current = model({ cleanupFailures: [null, null] });
    assert.equal(await current.run(), current.result);
    assert.deepEqual(current.events, [['running'], ['finalizing'], ['cleanup', 1], ['cleanup', 0], ['release', 'complete']]);
});

test('finalizer unit model rejects cleanup-only failure instead of returning a successful result', async () =>
{
    const first = new Error('first cleanup');
    const second = new Error('second cleanup');
    const current = model({ cleanupFailures: [first, second] });
    await assert.rejects(current.run(), (error) =>
    {
        assert.equal(error.name, 'AggregateError');
        assert.deepEqual([...error.errors], [second, first]);
        return true;
    });
    assert.deepEqual(current.events, [['running'], ['finalizing'], ['cleanup', 1], ['cleanup', 0], ['release', 'failed']]);
});

for (const [name, failure] of [
    ['ordinary', new Error('original execution')],
    ['frozen', Object.freeze(new Error('frozen execution'))],
    ['primitive', 'original string failure'],
    ['zero', 0],
    ['undefined', undefined]
])
{
    test('finalizer unit model preserves ' + name + ' original rejection before secondary cleanup', async () =>
    {
        const cleanup = new Error('secondary cleanup');
        const current = model({ executionFailure: failure, throwsExecution: true, cleanupFailures: [cleanup] });
        let rejected = false;
        try
        {
            await current.run();
        }
        catch (error)
        {
            rejected = true;
            assert.equal(error, failure);
        }
        assert.equal(rejected, true);
        if (failure instanceof Error && !Object.isFrozen(failure))
        {
            assert.deepEqual([...failure.schedulerFinalizationFailures], [cleanup]);
        }
        assert.deepEqual(current.events, [['running'], ['finalizing'], ['cleanup', 0], ['release', 'failed']]);
    });
}

test('finalizer unit model retains cancelled rejection while recording failed cleanup terminal state', async () =>
{
    const failure = new Error('original cancellation');
    failure.name = 'AbortError';
    const current = model({ executionFailure: failure, throwsExecution: true, cleanupFailures: [new Error('cleanup')] });
    await assert.rejects(current.run(), (error) => error === failure);
    assert.equal(current.events.at(-1)[1], 'failed');
});

