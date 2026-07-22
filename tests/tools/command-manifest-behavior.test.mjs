import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const controlledCommand = path.join(root, 'tests/fixtures/command-manifest/controlled-command.mjs');
const {
    runWeightedCommandManifest,
    validateCommandManifest
} = await import(pathToFileURL(path.join(root, 'tools/test/run-command-manifest.mjs')).href);

function fixture(t, name)
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `fsusblog-command-behavior-${name}-`));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}

function command(directory, id, overrides = {})
{
    const { mode = 'barrier', value = '0', ...metadata } = overrides;
    return {
        id,
        access: 'read',
        command: [process.execPath, controlledCommand, directory, id, mode, value],
        memoryCostGiB: 0.125,
        ...metadata
    };
}

function eventFile(directory, id, event)
{
    return path.join(directory, `${id}.${event}`);
}

function publishRelease(directory, id)
{
    fs.writeFileSync(eventFile(directory, id, 'release'), '');
}

function waitForEvent(directory, id, event)
{
    const file = eventFile(directory, id, event);
    if (fs.existsSync(file))
    {
        return Promise.resolve(file);
    }
    return new Promise((resolve, reject) =>
    {
        let settled = false;
        const finish = () =>
        {
            if (settled || !fs.existsSync(file))
            {
                return;
            }
            settled = true;
            watcher.close();
            resolve(file);
        };
        const watcher = fs.watch(directory, (_eventType, filename) =>
        {
            if (filename === path.basename(file))
            {
                finish();
            }
        });
        watcher.on('error', reject);
        finish();
    });
}

function manifest(lane, commands)
{
    return { schema: 'fsusblog.test-command-manifest.v1', lane, commands };
}

function runFixture(lane, commands, options = {})
{
    return runWeightedCommandManifest(manifest(lane, commands), {
        cwd: root,
        resolveWorkers: () => options.workers ?? 2,
        env: {
            FSUSBLOG_STEP_CPU_BUDGET: String(options.workers ?? 2),
            FSUSBLOG_STEP_MEMORY_GIB: '2'
        },
        ...options
    });
}

test('independent commands overlap at an explicit start barrier', { timeout: 10_000 }, async (t) =>
{
    const directory = fixture(t, 'parallel');
    const execution = runFixture('parallel', [command(directory, 'left'), command(directory, 'right')]);

    await Promise.all([
        waitForEvent(directory, 'left', 'started'),
        waitForEvent(directory, 'right', 'started')
    ]);
    assert.equal(fs.existsSync(eventFile(directory, 'left', 'completed')), false);
    assert.equal(fs.existsSync(eventFile(directory, 'right', 'completed')), false);

    publishRelease(directory, 'left');
    publishRelease(directory, 'right');
    const evidence = await execution;
    assert.equal(evidence.status, 'success');
});

test('commands sharing an exclusive resource never overlap', { timeout: 10_000 }, async (t) =>
{
    const directory = fixture(t, 'exclusive');
    const exclusiveResources = ['fixture-database'];
    const execution = runFixture('exclusive', [
        command(directory, 'first', { estimatedDurationMs: 2, exclusiveResources }),
        command(directory, 'second', { estimatedDurationMs: 1, exclusiveResources })
    ]);

    await waitForEvent(directory, 'first', 'started');
    assert.equal(fs.existsSync(eventFile(directory, 'second', 'started')), false);
    publishRelease(directory, 'first');
    await waitForEvent(directory, 'second', 'started');
    assert.ok(fs.existsSync(eventFile(directory, 'first', 'completed')));
    publishRelease(directory, 'second');
    await execution;
});

test('dependency readiness gates admission until the producer completes', { timeout: 10_000 }, async (t) =>
{
    const directory = fixture(t, 'dependency');
    const execution = runFixture('dependency', [
        command(directory, 'producer'),
        command(directory, 'consumer', { dependsOn: ['producer'] })
    ]);

    await waitForEvent(directory, 'producer', 'started');
    assert.equal(fs.existsSync(eventFile(directory, 'consumer', 'started')), false);
    publishRelease(directory, 'producer');
    await waitForEvent(directory, 'consumer', 'started');
    assert.ok(fs.existsSync(eventFile(directory, 'producer', 'completed')));
    publishRelease(directory, 'consumer');
    await execution;
});

test('collect-failures preserves every child failure while independent safe work completes', { timeout: 10_000 }, async (t) =>
{
    const directory = fixture(t, 'failures');
    const execution = runFixture('collect-failures', [
        command(directory, 'failure-a', { mode: 'fail', value: '17' }),
        command(directory, 'failure-b', { mode: 'fail', value: '23' }),
        command(directory, 'safe', { mode: 'complete' })
    ], { workers: 3 });

    await assert.rejects(execution, (error) =>
    {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors.length, 2);
        assert.match(error.message, /failure-a: .*exit 17/u);
        assert.match(error.message, /failure-b: .*exit 23/u);
        assert.equal(error.liveGrantEvidence.status, 'failure');
        assert.deepEqual(
            error.liveGrantEvidence.children.filter((child) => child.status === 'failure').map((child) => child.id),
            ['failure-a', 'failure-b']
        );
        return true;
    });
    assert.ok(fs.existsSync(eventFile(directory, 'safe', 'completed')));
});

test('cancellation terminates the complete process group and persists partial evidence', {
    skip: process.platform === 'win32',
    timeout: 10_000
}, async (t) =>
{
    const directory = fixture(t, 'cancel');
    const evidenceFile = path.join(directory, 'partial-evidence.json');
    const controller = new AbortController();
    const execution = runFixture('cancel', [command(directory, 'parent', { mode: 'descendant' })], {
        workers: 1,
        signal: controller.signal,
        evidenceFile
    });

    await Promise.all([
        waitForEvent(directory, 'parent-descendant', 'started'),
        waitForEvent(directory, 'parent', 'descendant-pid')
    ]);
    const parentPid = Number(fs.readFileSync(eventFile(directory, 'parent', 'started'), 'utf8'));
    const descendantPid = Number(fs.readFileSync(eventFile(directory, 'parent', 'descendant-pid'), 'utf8'));
    controller.abort(new Error('fixture cancellation'));
    await assert.rejects(execution, (error) =>
    {
        assert.equal(error.liveGrantEvidence.status, 'cancelled');
        assert.equal(error.liveGrantEvidence.children[0].status, 'cancelled');
        assert.match(error.liveGrantEvidence.children[0].error, /fixture cancellation/u);
        return true;
    });

    const alive = (pid) =>
    {
        try
        {
            const state = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')[2];
            return state !== 'Z';
        }
        catch (error)
        {
            if (error.code === 'ENOENT')
            {
                return false;
            }
            throw error;
        }
    };
    while (alive(parentPid) || alive(descendantPid))
    {
        await new Promise((resolve) => setImmediate(resolve));
    }
    const evidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
    assert.equal(evidence.status, 'cancelled');
    assert.equal(evidence.children[0].id, 'parent');
    assert.ok(Number.isFinite(evidence.finishedAtMs));
});

test('validator rejects shared writer ownership before any command is admitted', async (t) =>
{
    const directory = fixture(t, 'ownership-conflict');
    const conflicting = manifest('ownership-conflict', [
        command(directory, 'directory-owner', {
            access: 'write',
            ownedOutputs: ['.tmp/fixture-output']
        }),
        command(directory, 'file-owner', {
            access: 'write',
            ownedOutputs: ['.tmp/fixture-output/result.json']
        })
    ]);

    assert.deepEqual(validateCommandManifest(conflicting).filter((error) => error.includes('overlapping ownedOutputs')), [
        'directory-owner and file-owner declare overlapping ownedOutputs: .tmp/fixture-output <> .tmp/fixture-output/result.json'
    ]);
    await assert.rejects(runWeightedCommandManifest(conflicting), /overlapping ownedOutputs/u);
    assert.equal(fs.existsSync(eventFile(directory, 'directory-owner', 'started')), false);
    assert.equal(fs.existsSync(eventFile(directory, 'file-owner', 'started')), false);
});

test('disjoint ownedOutputs remain isolated while writers overlap', { timeout: 10_000 }, async (t) =>
{
    const directory = fixture(t, 'owned-isolation');
    const alphaOutput = path.join(directory, 'alpha/result.txt');
    const betaOutput = path.join(directory, 'beta/result.txt');
    const execution = runFixture('owned-isolation', [
        command(directory, 'alpha', {
            mode: 'write',
            value: alphaOutput,
            access: 'write',
            ownedOutputs: ['fixture/alpha']
        }),
        command(directory, 'beta', {
            mode: 'write',
            value: betaOutput,
            access: 'write',
            ownedOutputs: ['fixture/beta']
        })
    ]);

    await Promise.all([
        waitForEvent(directory, 'alpha', 'ready'),
        waitForEvent(directory, 'beta', 'ready')
    ]);
    assert.equal(fs.readFileSync(alphaOutput, 'utf8'), 'alpha\n');
    assert.equal(fs.readFileSync(betaOutput, 'utf8'), 'beta\n');
    publishRelease(directory, 'alpha');
    publishRelease(directory, 'beta');
    await execution;
    assert.equal(fs.readFileSync(alphaOutput, 'utf8'), 'alpha\n');
    assert.equal(fs.readFileSync(betaOutput, 'utf8'), 'beta\n');
});
