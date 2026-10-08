import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(import.meta.dirname, '../..');
const assembly = path.join(root, 'tests/tools/fixtures/backend-outcome-reporter/journal/bin/Release/net10.0/FsusBlog.XunitJournalFixture.dll');
const runner = path.join(root, 'tools/test/xunit-replay-runner/bin/Release/net10.0/FsusBlog.XunitReplayRunner.dll');
let material;

function fixture()
{
    if (material)
    {
        return material;
    }
    const dotnet = process.env.FSUSBLOG_BACKEND_DOTNET;
    assert.ok(dotnet && fs.existsSync(dotnet), 'ordinary reporter controls require the actual task SDK');
    assert.ok(fs.existsSync(runner) && fs.existsSync(assembly), 'build original runner and locked native fixture first');
    const directory = fs.mkdtempSync(path.join(root, '.tmp/backend-journal-callbacks-'));
    const discoveryPath = path.join(directory, 'discovery.json');
    const discovery = spawnSync(dotnet, [runner, 'discover', '--assembly', assembly, '--output', discoveryPath],
        { encoding: 'utf8', timeout: 30000 });
    assert.equal(discovery.status, 0, discovery.stderr);
    const tests = JSON.parse(fs.readFileSync(discoveryPath, 'utf8')).tests.filter((entry) =>
        entry.testClassName === 'FsusBlog.BackendOutcomeReporterFixture.JournalMaterialTests');
    assert.equal(tests.length, 5);
    // This real assembly-byte digest is an ordinary protocol token. It is not a
    // replay plan or a qualified source/run/temporal authority.
    const planDigest = `sha256:${createHash('sha256').update(fs.readFileSync(assembly)).digest('hex')}`;
    material = { dotnet, directory, tests, planDigest };
    return material;
}

function launch(name, methods, prepare = () =>
{})
{
    const { dotnet, directory, tests, planDigest } = fixture();
    const selected = tests.filter((entry) => methods.includes(entry.testMethodName));
    assert.equal(selected.length, methods.length);
    const slotId = `ordinary-${name}`;
    const output = path.join(directory, `${slotId}.json`);
    const queuePath = path.join(directory, `${slotId}-queue.json`);
    const queue = { schema: 'fsusblog.xunit-replay-slot-queue.v1', planDigest, slotId,
        collections: [...new Set(selected.map((entry) => entry.testCollectionUniqueId))].map((testCollectionUniqueId) => ({
            testCollectionUniqueId, tests: selected.filter((entry) => entry.testCollectionUniqueId === testCollectionUniqueId)
                .map(({ testCaseUniqueId, serialization }) => ({ testCollectionUniqueId, testCaseUniqueId, serialization }))
        })) };
    fs.writeFileSync(queuePath, JSON.stringify(queue), { mode: 0o600 });
    prepare(`${output}.events.jsonl`);
    const child = spawn(dotnet, [runner, 'run-slot', '--assembly', assembly, '--queue', queuePath, '--output', output],
        { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (bytes) =>
    {
        stdout += bytes;
    });
    child.stderr.on('data', (bytes) =>
    {
        stderr += bytes;
    });
    const completion = new Promise((resolve, reject) =>
    {
        child.once('error', reject);
        child.once('close', (exitCode, signal) =>
        {
            const result = { exitCode, signal, processId: child.pid, stdout, stderr };
            fs.writeFileSync(`${output}.process.json`, JSON.stringify(result), { mode: 0o600 });
            resolve(result);
        });
    });
    return { child, completion, output, journal: `${output}.events.jsonl`, queue, selected };
}

function events(file)
{
    if (!fs.existsSync(file))
    {
        return [];
    }
    const bytes = fs.readFileSync(file, 'utf8');
    // Only complete callback lines are read while the live original writer runs.
    return bytes.slice(0, bytes.lastIndexOf('\n') + 1).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function callbackIdentity(probe, records)
{
    assert.ok(records.length > 0);
    for (const [sequence, record] of records.entries())
    {
        assert.equal(record.schema, 'fsusblog.xunit-replay-slot-journal-event.v1');
        assert.equal(record.sequence, sequence);
        assert.equal(record.processId, probe.child.pid);
        assert.equal(record.planDigest, probe.queue.planDigest);
        assert.equal(record.slotId, probe.queue.slotId);
        assert.equal(record.qualificationEligible, false);
    }
}

test('original callback journal retains successful failed and skipped outcomes and unchanged exit one', { timeout: 30000 }, async () =>
{
    const probe = launch('completed', ['AlphaPass', 'BravoFailure', 'CharlieSkip']);
    const result = await probe.completion;
    assert.equal(result.exitCode, 1);
    assert.equal(result.signal, null);
    const receipt = JSON.parse(fs.readFileSync(probe.output, 'utf8'));
    const records = events(probe.journal);
    callbackIdentity(probe, records);
    assert.equal(records[0].kind, 'run-opened');
    assert.deepEqual(records.filter((record) => record.kind === 'collection-admitted').map((record) => record.payload), receipt.admissions);
    assert.deepEqual(records.filter((record) => record.kind === 'test-started').map((record) => record.payload), receipt.starts);
    assert.deepEqual(records.filter((record) => record.kind === 'test-outcome').map((record) => record.payload), receipt.outcomes);
    assert.deepEqual(receipt.outcomes.map((entry) => entry.outcome), ['passed', 'failed', 'skipped']);
    const failure = records.find((record) => record.kind === 'test-failure').payload;
    const failedOutcome = receipt.outcomes.find((outcome) => outcome.outcome === 'failed');
    assert.equal(failure.testCaseUniqueId, failedOutcome.testCaseUniqueId);
    assert.equal(failure.testUniqueId, failedOutcome.testUniqueId);
    assert.equal(failure.cause, 'Assertion');
    assert.deepEqual(failure.exceptionTypes, ['Xunit.Sdk.EqualException']);
    assert.deepEqual(failure.exceptionParentIndices, [-1]);
    assert.equal(failure.messages.join('\n'), failedOutcome.detail);
    assert.equal(failure.stackTraces.length, failure.exceptionTypes.length);
    assert.equal(records.at(-2).kind, 'assembly-finished');
    assert.deepEqual(records.at(-1).payload, { exitCode: 1 });
    assert.equal(records.at(-1).kind, 'runner-terminal');
});

test('native exit zero remains zero with an ordinary complete journal', { timeout: 30000 }, async () =>
{
    const probe = launch('passed', ['AlphaPass']);
    const result = await probe.completion;
    assert.equal(result.exitCode, 0);
    assert.equal(result.signal, null);
    const records = events(probe.journal);
    callbackIdentity(probe, records);
    assert.equal(records.at(-1).payload.exitCode, 0);
});

test('real process kill preserves the flushed first failure and live incomplete start', { timeout: 30000 }, async () =>
{
    const probe = launch('killed', ['AlphaPass', 'BravoFailure', 'DeltaWait']);
    const waiting = probe.selected.find((entry) => entry.testMethodName === 'DeltaWait');
    try
    {
        const deadline = Date.now() + 20000;
        while (!events(probe.journal).some((record) => record.kind === 'test-started'
            && record.payload.testCaseUniqueId === waiting.testCaseUniqueId))
        {
            assert.ok(Date.now() < deadline, 'original native waiting-case callback was not received');
            await delay(20);
        }
        assert.equal(probe.child.kill('SIGKILL'), true);
        const result = await probe.completion;
        assert.equal(result.exitCode, null);
        assert.equal(result.signal, 'SIGKILL');
        const records = events(probe.journal);
        callbackIdentity(probe, records);
        assert.deepEqual(records.filter((record) => record.kind === 'test-outcome').map((record) => record.payload.outcome), ['passed', 'failed']);
        assert.equal(records.find((record) => record.kind === 'test-failure').payload.cause, 'Assertion');
        assert.equal(records.at(-1).kind, 'test-started');
        assert.equal(records.at(-1).payload.testCaseUniqueId, waiting.testCaseUniqueId);
        assert.equal(records.some((record) => record.kind === 'runner-terminal'), false);
        assert.equal(fs.existsSync(probe.output), false);
    }
    finally
    {
        if (probe.child.exitCode === null && probe.child.signalCode === null)
        {
            probe.child.kill('SIGKILL');
            await probe.completion;
        }
    }
});

test('bounded journal stops explicitly while the original large assertion failure remains exit one', { timeout: 30000 }, async () =>
{
    const probe = launch('bounded', ['EchoLargeFailure']);
    const result = await probe.completion;
    assert.equal(result.exitCode, 1);
    const receipt = JSON.parse(fs.readFileSync(probe.output, 'utf8'));
    assert.equal(receipt.outcomes[0].outcome, 'failed');
    assert.ok(receipt.outcomes[0].detail.length > 128 * 1024);
    const records = events(probe.journal);
    callbackIdentity(probe, records);
    assert.equal(records.at(-1).kind, 'journal-stopped');
    assert.ok(fs.statSync(probe.journal).size <= 16 * 1024 * 1024);
    assert.match(result.stderr, /xUnit slot journal stopped/u);
});

test('unavailable journal output preserves original reporter failure receipt and exit one', { timeout: 30000 }, async () =>
{
    const probe = launch('unavailable', ['BravoFailure'], (file) => fs.mkdirSync(file));
    const result = await probe.completion;
    assert.equal(result.exitCode, 1);
    assert.equal(result.signal, null);
    const receipt = JSON.parse(fs.readFileSync(probe.output, 'utf8'));
    assert.equal(receipt.outcomes[0].outcome, 'failed');
    assert.match(result.stderr, /xUnit slot journal unavailable/u);
});

test('ordinary final-receipt IO failure retains native exit two and prior callbacks', { timeout: 30000 }, async () =>
{
    const probe = launch('final-output-failure', ['AlphaPass'], (file) =>
    {
        fs.mkdirSync(file.slice(0, -'.events.jsonl'.length));
    });
    const result = await probe.completion;
    assert.equal(result.exitCode, 2);
    assert.equal(result.signal, null);
    const records = events(probe.journal);
    callbackIdentity(probe, records);
    assert.equal(records.filter((record) => record.kind === 'test-outcome')[0].payload.outcome, 'passed');
    assert.equal(records.at(-1).kind, 'runner-terminal');
    assert.equal(records.at(-1).payload.exitCode, 2);
    assert.equal(records.at(-1).qualificationEligible, false);
});
