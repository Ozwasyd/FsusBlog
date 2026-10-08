import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(import.meta.dirname, '../..');
const adapter = path.join(root, 'tools/test/xunit-replay-adapter.mjs');
const assembly = 'tests/tools/fixtures/backend-outcome-reporter/journal/bin/Release/net10.0/FsusBlog.XunitJournalFixture.dll';

function read(file)
{
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function run(className, name, executionReferences = [])
{
    const dotnet = process.env.FSUSBLOG_BACKEND_DOTNET;
    assert.ok(dotnet && fs.existsSync(dotnet), 'actual consumer controls require the existing task SDK');
    assert.ok(fs.existsSync(path.join(root, assembly)), 'build the isolated journal fixture first');
    const directory = fs.mkdtempSync(path.join(root, '.tmp/backend-parent-publication-'));
    const referenceFile = path.join(directory, 'owner-execution-references.json');
    fs.writeFileSync(referenceFile, JSON.stringify(executionReferences), { mode: 0o600 });
    const child = spawn(process.execPath, [adapter, '--assembly', assembly, '--output-dir', path.relative(root, directory),
        '--root-seed', `seed256:${'37'.repeat(32)}`, '--workers', '1', '--run-id', `${name}-${path.basename(directory)}`,
        '--class', `FsusBlog.BackendOutcomeReporterFixture.${className}`,
        '--execution-references', path.relative(root, referenceFile)], {
        cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PATH: `${path.dirname(dotnet)}:${process.env.PATH}`,
            DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_GENERATE_ASPNET_CERTIFICATE: 'false' }
    });
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
            fs.writeFileSync(path.join(directory, 'control-process.json'), JSON.stringify(result), { mode: 0o600 });
            resolve(result);
        });
    });
    const timeout = setTimeout(() =>
    {
        try
        {
            process.kill(-child.pid, 'SIGKILL');
        }
        catch (error)
        {
            if (error.code !== 'ESRCH')
            {
                throw error;
            }
        }
    }, 30000);
    completion.finally(() => clearTimeout(timeout));
    return { directory, child, completion, executionReferences };
}

async function cleanup(probe)
{
    if (probe.child.exitCode === null && probe.child.signalCode === null)
    {
        process.kill(-probe.child.pid, 'SIGKILL');
        await probe.completion;
    }
}

function inspect(probe)
{
    const plan = read(path.join(probe.directory, 'plan.json'));
    const results = read(path.join(probe.directory, 'actual/process-results.json'));
    assert.equal(results.planDigest, plan.planDigest);
    assert.deepEqual(results.source, plan.source);
    assert.deepEqual(results.producer, plan.producer);
    assert.deepEqual(results.run, plan.run);
    assert.equal(results.qualificationEligible, false);
    assert.deepEqual(results.executionReferences, probe.executionReferences);
    assert.equal(results.inputReferences.length, 2);
    assert.equal(results.inputReferences.find((entry) => entry.kind === 'replay-plan').digest, plan.planDigest);
    const processResult = results.processes[0];
    assert.ok(Number.isInteger(processResult.processId) && processResult.processId > 0);
    assert.ok(Date.parse(processResult.finishedAt) >= Date.parse(processResult.startedAt));
    assert.deepEqual(processResult.inputReferences, results.inputReferences);
    assert.deepEqual(processResult.executionReferences, probe.executionReferences);
    const journal = fs.readFileSync(path.join(root, processResult.journal.reference.path));
    assert.equal(processResult.journal.reference.digest, `sha256:${createHash('sha256').update(journal).digest('hex')}`);
    for (const log of [processResult.stdout, processResult.stderr])
    {
        assert.equal(log.truncated, false);
        assert.equal(log.outputError, null);
        assert.equal(log.digest, `sha256:${createHash('sha256').update(fs.readFileSync(path.join(root, log.path))).digest('hex')}`);
    }
    return { plan, results, processResult };
}

test('actual original consumer publishes successful process evidence and preserves complete verification', { timeout: 40000 }, async () =>
{
    const fixtureSource = 'tests/tools/fixtures/backend-outcome-reporter/journal/JournalMaterialTests.cs';
    const supplied = [{ kind: 'unqualified-native-fixture-source', path: fixtureSource,
        digest: `sha256:${createHash('sha256').update(fs.readFileSync(path.join(root, fixtureSource))).digest('hex')}` }];
    const probe = run('JournalSuccessTests', 'success', supplied);
    try
    {
        const result = await probe.completion;
        assert.equal(result.exitCode, 0, result.stderr);
        const { processResult } = inspect(probe);
        assert.equal(processResult.exitCode, 0);
        assert.equal(processResult.signal, null);
        assert.equal(processResult.journal.status, 'complete');
        assert.ok(fs.existsSync(path.join(probe.directory, 'actual/verification.json')));
        assert.ok(fs.existsSync(path.join(probe.directory, 'actual/receipt.json')));
        assert.equal(fs.existsSync(path.join(probe.directory, 'actual/partial-framework-actual.json')), false);
    }
    finally
    {
        await cleanup(probe);
    }
});

test('actual original consumer preserves first assertion failure and native exit one', { timeout: 40000 }, async () =>
{
    const probe = run('JournalFailureTests', 'failure');
    try
    {
        const result = await probe.completion;
        assert.equal(result.exitCode, 1);
        const { processResult } = inspect(probe);
        assert.equal(processResult.exitCode, 1);
        assert.equal(processResult.signal, null);
        const actual = read(path.join(probe.directory, 'actual/framework-actual.json'));
        assert.equal(actual.qualificationEligible, false);
        assert.ok(actual.workers[0].outcomes.some((entry) => entry.outcome === 'failed'));
        assert.equal(fs.existsSync(path.join(probe.directory, 'actual/verification.json')), false);
    }
    finally
    {
        await cleanup(probe);
    }
});

test('actual original consumer retains cancelled native callback prefix before failing incomplete execution', { timeout: 40000 }, async () =>
{
    const probe = run('JournalMaterialTests', 'cancelled');
    try
    {
        const journal = path.join(probe.directory, 'actual/slots/xunit-slot-1.json.events.jsonl');
        const deadline = Date.now() + 20000;
        let started = false;
        while (!started)
        {
            if (fs.existsSync(journal))
            {
                const bytes = fs.readFileSync(journal, 'utf8');
                const records = bytes.slice(0, bytes.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(JSON.parse);
                started = records.some((entry) => entry.kind === 'test-started'
                    && entry.payload.testDisplayName.endsWith('.DeltaWait'));
            }
            assert.ok(Date.now() < deadline, 'actual original consumer never reached its owned waiting callback');
            if (!started)
            {
                await delay(20);
            }
        }
        const running = read(path.join(probe.directory, 'actual/processes/xunit-slot-1.json.running.json'));
        assert.equal(running.command[0], 'dotnet');
        process.kill(running.processId, 'SIGKILL');
        const result = await probe.completion;
        assert.equal(result.exitCode, 1);
        assert.equal(result.signal, null);
        const { processResult } = inspect(probe);
        assert.equal(processResult.processId, running.processId);
        assert.equal(processResult.exitCode, null);
        assert.equal(processResult.signal, 'SIGKILL');
        assert.equal(processResult.journal.status, 'partial');
        assert.equal(processResult.finalReceiptReference, null);
        const partial = read(path.join(probe.directory, 'actual/partial-framework-actual.json'));
        assert.equal(partial.qualificationEligible, false);
        assert.deepEqual(partial.workers[0].outcomes.map((entry) => entry.outcome), ['passed', 'failed', 'skipped']);
        assert.ok(partial.workers[0].starts.at(-1).testDisplayName.endsWith('.DeltaWait'));
        assert.equal(fs.existsSync(path.join(probe.directory, 'actual/verification.json')), false);
        assert.equal(fs.existsSync(path.join(probe.directory, 'actual/receipt.json')), false);
        assert.match(result.stderr, /incomplete; actual process and partial callback evidence retained/u);
    }
    finally
    {
        await cleanup(probe);
    }
});
