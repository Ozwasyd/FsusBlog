import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const { runDag } = await import(new URL('../../tools/test-matrix/scheduler.mjs', import.meta.url));
const { runProcess } = await import(new URL('../../tools/test-fixtures/producers/spawn-helper.mjs', import.meta.url));
const { collectProcessIdentity } = await import(new URL('../../tools/test/process-identity.mjs', import.meta.url));

function readiness(file)
{
    const ready = Promise.withResolvers();
    const read = () =>
    {
        if (fs.existsSync(file))
        {
            ready.resolve(JSON.parse(fs.readFileSync(file, 'utf8')));
        }
    };
    const watcher = fs.watch(path.dirname(file), (_event, name) =>
    {
        if (String(name) === path.basename(file))
        {
            try
            {
                read();
            }
            catch (error)
            {
                ready.reject(error);
            }
        }
    });
    const timer = setTimeout(() => ready.reject(new Error('task child did not report readiness')), 3000);
    read();
    return { promise: ready.promise, close()
    {
        clearTimeout(timer);
        watcher.close();
    } };
}

function isAlive(pid)
{
    try
    {
        process.kill(pid, 0);
        return true;
    }
    catch (error)
    {
        if (error.code !== 'ESRCH')
        {
            throw error;
        }
        return false;
    }
}

test('scheduler waits for its real producer child terminal before returning cancellation', { timeout: 15000 }, async (t) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-producer-terminal-'));
    const controller = new AbortController();
    const token = randomUUID();
    const readyFile = path.join(root, 'ready.json');
    const childFile = path.join(root, 'producer-child.mjs');
    fs.writeFileSync(childFile, [
        'import fs from "node:fs";',
        'const [ready, token] = process.argv.slice(2);',
        'process.on("SIGTERM", () => {});',
        'fs.writeFileSync(ready + ".tmp", JSON.stringify({pid: process.pid, token}), {flag: "wx"});',
        'fs.renameSync(ready + ".tmp", ready);',
        'setInterval(() => {}, 1000);'
    ].join('\n'));
    const ready = readiness(readyFile);
    let childIdentity = null;
    t.after(async () =>
    {
        ready.close();
        controller.abort(new Error('task test cleanup'));
        if (childIdentity)
        {
            const current = collectProcessIdentity(childIdentity.pid);
            if (current.status === 'verified' && current.processStartIdentity === childIdentity.processStartIdentity)
            {
                process.kill(childIdentity.pid, 'SIGKILL');
                const deadline = Date.now() + 3000;
                while (isAlive(childIdentity.pid) && Date.now() < deadline)
                {
                    await delay(10);
                }
                assert.equal(isAlive(childIdentity.pid), false, 'task child cleanup must complete');
            }
        }
        fs.rmSync(root, { recursive: true, force: true });
    });
    const started = [];
    const tiers = ['producer', 'pending'].map((id) => ({ id, command: 'controlled producer adapter',
        cacheInputs: [], executionDependsOn: [], services: [], parallelizable: true,
        exclusiveResources: [], resourceClass: 'cpu', cpuUnits: 1, memoryGiB: 1 }));
    const execution = runDag({ root, runsRoot: path.join(root, 'runs'), runId: 'producer-terminal-run',
        targetTierId: 'pending', signal: controller.signal, tiers, maxParallel: 1, collectFailures: true,
        systemResources: { cpuCount: 1, availableMemoryGiB: 4, load1: 0 }, currentFreeMemoryGiB: () => 4,
        snapshotWorktree: async () => ({ fingerprint: 'controlled', entries: new Map() }),
        sourceState: { commit: 'a'.repeat(40), worktreeFingerprint: 'controlled' }, dynamicPriority: false,
        executeTier: async (tier, context) =>
        {
            started.push(tier.id);
            const result = await runProcess(process.execPath, [childFile, readyFile, token], {
                cwd: root, signal: context.signal, timeoutMs: 8000
            });
            return { code: result.code, signal: null };
        } });
    // Observe readiness rather than guessing that a child started after a sleep.
    const observed = await ready.promise;
    ready.close();
    assert.equal(observed.token, token);
    childIdentity = collectProcessIdentity(observed.pid);
    assert.equal(childIdentity.status, 'verified');
    controller.abort(new Error('ordinary requested producer cancellation'));
    const result = await execution;
    assert.equal(result.status, 'failure');
    assert.deepEqual(started, ['producer']);
    assert.equal(result.checkpoint.tiers.pending.status, 'cancelled');
    assert.equal(isAlive(observed.pid), false, 'scheduler settlement must not precede child terminal');
    assert.equal(result.checkpoint.authoritative, false);
});
