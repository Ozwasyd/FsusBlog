import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { URL, fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { createSecurityAtomicFixture } from './support/security-atomic-fixtures.mjs';

const { createSecurityScenarioDispatchSession, projectSecurityScenarios } = await import(new URL('../../tools/test/security-atomic/scenarios.mjs', import.meta.url));
const { serveSecurityScenarioSession, requestSecurityScenarioDispatch } = await import(new URL('../../tools/test/security-atomic/resident-ipc.mjs', import.meta.url));
const clientFile = fileURLToPath(new URL('../../tools/test/security-atomic/resident-ipc-client.mjs', import.meta.url));
const executeFile = promisify(execFile);

async function ipcFixture(t, loadRunner)
{
    const fixture = createSecurityAtomicFixture();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'security-resident-ipc-'));
    const evidenceRoot = path.join(root, 'host-results');
    fs.mkdirSync(evidenceRoot, { mode: 0o700 });
    const projection = fixture.register(projectSecurityScenarios({ ...fixture, mode: 'resident' }));
    const identity = { commit: fixture.context.sourceRevision, runId: fixture.context.runId,
        worktreeFingerprint: `sha256:${'c'.repeat(64)}` };
    let initialized = 0;
    const session = createSecurityScenarioDispatchSession({ ...fixture, projection, identity,
        resolveReferences: () => fixture.references,
        initializeRuntime: () =>
        {
            initialized += 1;
            return { ordinarySharedMarker: 'one-original-session' };
        },
        loadRunner });
    const bridge = await serveSecurityScenarioSession({ session, ipcRoot: root, evidenceRoot });
    t.after(async () =>
    {
        await bridge.close();
        session.close();
        fs.rmSync(root, { recursive: true, force: true });
    });
    async function child(scenarioId, outputFile)
    {
        const command = ['--socket', bridge.socketPath, '--scenario', scenarioId,
            '--run-id', identity.runId, '--source-commit', identity.commit,
            '--source-fingerprint', identity.worktreeFingerprint, '--output-file', outputFile];
        try
        {
            const result = await executeFile(process.execPath, [clientFile, ...command]);
            return { ...result, exitCode: 0 };
        }
        catch (error)
        {
            return { stdout: error.stdout, stderr: error.stderr, exitCode: error.code };
        }
    }
    return { ...fixture, root, evidenceRoot, projection, identity, session, bridge, child,
        initializationCount: () => initialized };
}

test('two actual client processes dispatch original scenarios through one existing resident session', async (t) =>
{
    const calls = [];
    const fixture = await ipcFixture(t, (scenario) => async (request) =>
    {
        calls.push(scenario.id);
        return { originalScenarioId: scenario.id, hostPid: process.pid,
            sharedMarker: request.shared.ordinarySharedMarker };
    });
    const [first, second] = fixture.projection.producers;
    const firstOutput = path.join(fixture.root, 'first-original-result.json');
    const secondOutput = path.join(fixture.root, 'second-original-result.json');
    assert.equal((await fixture.child(first.testId, firstOutput)).exitCode, 0);
    assert.equal((await fixture.child(second.testId, secondOutput)).exitCode, 0);
    assert.equal(fixture.initializationCount(), 1);
    assert.deepEqual(calls, [first.testId, second.testId]);
    for (const [producer, output] of [[first, firstOutput], [second, secondOutput]])
    {
        const original = path.join(fixture.evidenceRoot, producer.scenario.evidencePath);
        assert.deepEqual(fs.readFileSync(output), fs.readFileSync(original));
        const document = JSON.parse(fs.readFileSync(output, 'utf8'));
        assert.equal(document.schema, 'fsusblog.runtime-scenario-result-evidence.v1');
        assert.equal(document.result.status, 'pass');
        assert.equal(document.result.diagnostics.runner.hostPid, process.pid);
        assert.equal(document.result.diagnostics.runner.originalScenarioId, producer.testId);
        assert.equal(document.result.diagnostics.runner.sharedMarker, 'one-original-session');
        assert.equal(document.runId, fixture.context.runId);
        assert.deepEqual(document.scenario.expectedAssertions, producer.scenario.expectedAssertions);
    }
    assert.equal(fs.statSync(fixture.bridge.socketPath).mode & 0o077, 0);
    await fixture.bridge.close();
    assert.ok(fs.existsSync(path.join(fixture.evidenceRoot, first.scenario.evidencePath)));
    assert.equal(fs.existsSync(fixture.bridge.socketPath), false);
});

test('IPC preserves original runner failure evidence and consumes journal revalidation before the next scenario', async (t) =>
{
    const originalFailure = new Error('original resident assertion failed');
    let calls = 0;
    const fixture = await ipcFixture(t, () => async () =>
    {
        calls += 1;
        if (calls === 1)
        {
            throw originalFailure;
        }
        return { original: 'later scenario result' };
    });
    const [first, second] = fixture.projection.producers;
    const firstOutput = path.join(fixture.root, 'first-failed-result.json');
    assert.equal((await fixture.child(first.testId, firstOutput)).exitCode, 1);
    const failure = JSON.parse(fs.readFileSync(firstOutput, 'utf8'));
    assert.equal(failure.result.status, 'failure');
    assert.equal(failure.result.error.message, originalFailure.message);
    assert.equal(failure.result.error.stack, originalFailure.stack);
    assert.equal(fixture.session.attempts()[0].error, originalFailure);
    const failedReference = fixture.terminal(first.producerId, 'failed', [first.producerId]).reference;
    fixture.ownerVerifiers.hostAttemptReference = (attempt) =>
    {
        assert.equal(attempt.error, originalFailure);
        return failedReference;
    };
    fixture.references.hostRevalidation = fixture.reference('hostRevalidation', 'ipc-first-failure-revalidation',
        { failures: [failedReference] });
    assert.equal((await fixture.child(second.testId, path.join(fixture.root, 'second-result.json'))).exitCode, 0);
    assert.ok(fixture.calls.includes('hostRevalidation'));
    assert.equal(fixture.session.attempts()[0].error, originalFailure);
    assert.equal(fixture.initializationCount(), 1);
});

test('request cancellation waits for original runner settlement and transports its original cancelled result', async (t) =>
{
    let started;
    let finish;
    let observedCancellation;
    const ready = new Promise((resolve) =>
    {
        started = resolve;
    });
    const settled = new Promise((resolve) =>
    {
        finish = resolve;
    });
    const cancelled = new Promise((resolve) =>
    {
        observedCancellation = resolve;
    });
    const fixture = await ipcFixture(t, () => async ({ signal }) =>
    {
        signal.addEventListener('abort', observedCancellation, { once: true });
        started();
        await settled;
    });
    const controller = new AbortController();
    const reason = new Error('original IPC producer cancelled');
    const producer = fixture.projection.producers[0];
    const dispatched = requestSecurityScenarioDispatch({ socketPath: fixture.bridge.socketPath,
        identity: fixture.identity, scenarioId: producer.testId, signal: controller.signal });
    await ready;
    controller.abort(reason);
    await cancelled;
    assert.throws(() => fixture.session.close(), /active producer/u);
    assert.equal(fixture.session.attempts()[0].status, 'running');
    finish();
    const result = await dispatched;
    assert.equal(result.document.result.status, 'cancelled');
    assert.equal(result.document.result.error.message, reason.message);
    assert.equal(result.document.result.error.stack, reason.stack);
    assert.equal(result.qualificationEligible, false);
    assert.equal(fixture.session.attempts()[0].status, 'cancelled');
    assert.deepEqual(result.resultBytes, fs.readFileSync(result.originalResultFile));
});

test('IPC shutdown cancels and awaits the original active scenario while preserving its evidence', async (t) =>
{
    let started;
    const ready = new Promise((resolve) =>
    {
        started = resolve;
    });
    const fixture = await ipcFixture(t, () => async ({ signal }) =>
    {
        const stopped = new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        started();
        await stopped;
    });
    const producer = fixture.projection.producers[0];
    const dispatched = requestSecurityScenarioDispatch({ socketPath: fixture.bridge.socketPath,
        identity: fixture.identity, scenarioId: producer.testId });
    await ready;
    const closed = fixture.bridge.close();
    const result = await dispatched;
    await closed;
    assert.equal(result.document.result.status, 'cancelled');
    assert.equal(result.document.result.error.message, 'resident IPC owner closing');
    assert.ok(fs.existsSync(result.originalResultFile));
    assert.equal(fs.existsSync(fixture.bridge.socketPath), false);
    assert.equal(fixture.initializationCount(), 1);
});
