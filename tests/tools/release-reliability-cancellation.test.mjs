import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    createReleaseReliabilityCancellation,
    executeScenario
} from '../../tools/test/run-release-reliability-scenarios.mjs';
import {
    createPhysicalExecutionOutputTracker
} from '../../tools/test/physical-execution-process-tree.mjs';
import { sealDocument } from '../../tools/test/release-reliability-receipt.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repositoryCatalog = JSON.parse(fs.readFileSync(
    path.join(repositoryRoot, 'config/testing/release-reliability-scenario-catalog.json'),
    'utf8'
));
const invocationId = 'cancellation-fixture-invocation';
const runId = 'cancellation-fixture-run';
const physicalPolicy = {
    schema: 'fsusblog.physical-execution-process-policy.v1',
    gracefulTerminationMs: 60,
    forceTerminationMs: 1200,
    pipeCloseTimeoutMs: 250,
    observationIntervalMs: 10,
    zeroMemberObservations: 2,
    maximumCapturedOutputBytesPerStream: 1024 * 1024,
    unixProcessGroupRequired: true,
    linuxCgroupRequired: true,
    windowsJobObjectRequired: true
};

function temporaryRoot(name)
{
    const root = fs.mkdtempSync(
        path.join(os.tmpdir(), `fsusblog-release-cancel-${name}-`)
    );
    const policyTarget = path.join(
        root,
        'config/testing/physical-execution-process-policy.json'
    );
    fs.mkdirSync(path.dirname(policyTarget), { recursive: true });
    fs.copyFileSync(path.join(
        repositoryRoot,
        'config/testing/physical-execution-process-policy.json'
    ), policyTarget);
    return root;
}

function fixtureCatalog()
{
    const canonical = structuredClone(repositoryCatalog.scenarios[1]);
    canonical.command = {
        executable: process.execPath,
        args: [
            '-e',
            "process.on('SIGTERM',()=>{});console.log('fixture-ready');setInterval(()=>{},1000)"
        ],
        env: {},
        inheritEnv: { required: [], optional: [] },
        cwd: '.'
    };
    canonical.identityTools = ['node'];
    canonical.authoritativeEvidence = {
        path: '.tmp/evidence/cancellation.json',
        expectedSchema: {
            required: ['status', 'releaseReliability'],
            passStatusValues: ['ok']
        }
    };
    canonical.isolation.outputs = [{
        id: 'authoritative-evidence',
        path: canonical.authoritativeEvidence.path
    }];
    canonical.isolation.lifecycle = {
        preconditions: [],
        resetsBefore: [],
        measurement: 'cancellation-fixture-measurement',
        postconditions: [],
        resetsAfter: []
    };
    canonical.isolation.exclusiveResources = [];
    return {
        schema: repositoryCatalog.schema,
        catalogScenarioCount: 1,
        canonicalScenarioIds: [canonical.id],
        identityTools: ['node'],
        childEnvironmentContract: repositoryCatalog.childEnvironmentContract,
        policyBindings: repositoryCatalog.policyBindings,
        lifecycleSchema: repositoryCatalog.lifecycleSchema,
        scenarios: [canonical]
    };
}

function fixtureIdentity()
{
    const policyBytes = fs.readFileSync(path.join(
        repositoryRoot,
        'config/testing/physical-execution-process-policy.json'
    ));
    return sealDocument({
        schema: 'fsusblog.release-reliability-run-identity.v1',
        status: 'complete',
        invocationId,
        runId,
        sourceState: {
            commit: 'a'.repeat(40),
            worktreeFingerprint: `sha256:${'b'.repeat(64)}`,
            dirtyPathCount: 0,
            hashedPathCount: 0
        },
        build: { contentDigest: `sha256:${'c'.repeat(64)}` },
        fixture: { topology: { content: { runtime: { backendContainer: null } } } },
        policy: {
            physicalExecution: {
                status: 'complete',
                path: 'config/testing/physical-execution-process-policy.json',
                fileDigest: `sha256:${createHash('sha256')
                    .update(policyBytes).digest('hex')}`
            }
        },
        tools: [{
            id: 'node',
            status: 'complete',
            executable: process.execPath,
            version: process.version
        }]
    });
}

function fixtureExecutionPolicy(scenarioId, timeoutMs)
{
    const physicalExecution = {
        path: 'config/testing/physical-execution-process-policy.json',
        fileDigest: `sha256:${'1'.repeat(64)}`
    };
    const testMatrix = {
        path: 'tests/matrix.yml',
        fileDigest: `sha256:${'2'.repeat(64)}`
    };
    return {
        schema: 'fsusblog.release-reliability-execution-policy.v1',
        physicalPolicy,
        sources: {
            physicalExecution,
            correctnessBudget: {
                path: 'config/testing/correctness-budget-policy.json',
                fileDigest: `sha256:${'3'.repeat(64)}`
            },
            testMatrix
        },
        scenarios: {
            [scenarioId]: {
                scenarioId,
                status: 'complete',
                timeoutMs,
                timeoutPhase: 'scheduler',
                gracefulTerminationMs: physicalPolicy.gracefulTerminationMs,
                forceTerminationMs: physicalPolicy.forceTerminationMs,
                pipeCloseTimeoutMs: physicalPolicy.pipeCloseTimeoutMs,
                sources: {
                    physicalExecution,
                    correctnessBudget: null,
                    testMatrix: {
                        ...testMatrix,
                        tierId: scenarioId,
                        timeoutMinutes: 5,
                        timeoutMs: 300000
                    }
                },
                conflict: null
            }
        }
    };
}

function startScenario(root, {
    signal = null,
    timeoutMs = 5000
} = {})
{
    const catalog = fixtureCatalog();
    const scenario = catalog.scenarios[0];
    const identity = fixtureIdentity();
    const action = {
        actionId: scenario.isolation.lifecycle.measurement,
        phase: 'measurement',
        scenarioId: scenario.id,
        operation: 'run-measurement',
        executable: '$scenario.command',
        args: [],
        env: {},
        cwd: '.',
        expectedReceiptPath: scenario.authoritativeEvidence.path,
        expectedReceiptSchema: 'catalog-authoritative-evidence',
        requiredFields: ['releaseReliability', 'status'],
        passStatusValues: ['ok'],
        stateDomains: [],
        safeAfterFailure: false,
        timeoutPolicy: {
            timeoutMs,
            terminateGraceMs: 100
        }
    };
    const result = executeScenario({
        catalog,
        scenarioId: scenario.id,
        repositoryRoot: root,
        invocationId,
        runId,
        identity,
        identityReference: {
            path: `.tmp/release-reliability/${invocationId}/identity.json`,
            contentDigest: identity.contentDigest
        },
        executionPolicy: fixtureExecutionPolicy(scenario.id, timeoutMs),
        lifecycleContracts: {
            actions: new Map([[action.actionId, action]])
        },
        evidenceClass: 'diagnostic',
        qualificationEligible: false,
        signal,
        ambientEnvironment: {
            HOME: process.env.HOME,
            PATH: process.env.PATH,
            XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? '/tmp'
        }
    });
    return {
        result,
        scenario,
        stdoutLog: path.join(
            root,
            `.tmp/release-reliability/${invocationId}/logs/lifecycle/` +
            `${scenario.id}/${action.actionId}.stdout.log`
        ),
        claimedEvidence: path.join(
            root,
            `.tmp/release-reliability/${invocationId}/authoritative-evidence/${scenario.id}.json`
        )
    };
}

async function waitForReady(file)
{
    const deadlineAt = Date.now() + 5000;
    while (Date.now() <= deadlineAt)
    {
        if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('fixture-ready'))
        {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('fixture producer did not become ready');
}

test('timeout uses the shared cancellation path and can never produce a passed result', {
    skip: process.platform !== 'linux'
}, async (context) =>
{
    const root = temporaryRoot('timeout');
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const fixture = startScenario(root, { timeoutMs: 500 });
    const result = await fixture.result;
    assert.equal(result.status, 'timed-out');
    assert.match(result.failure, /timeout after 500ms/u);
    assert.equal(result.authoritativeEvidence, null);
    assert.equal(result.outputs.length, 0);
    assert.equal(result.firstFailure.classification, 'timeout');
    assert.ok(Array.isArray(result.cleanupFailures));
    assert.equal(result.cancellation.status, 'timed-out');
    const receipt = JSON.parse(fs.readFileSync(
        path.join(root, result.cancellation.path),
        'utf8'
    ));
    assert.equal(receipt.status, 'timed-out');
    assert.equal(receipt.processTree.postObservation, 'zero-members');
    assert.equal(receipt.logComplete, true);
    const gracefulTermination = receipt.processTree.termination.some((entry) =>
        entry.phase === 'graceful' && entry.signal === 'SIGTERM'
    );
    if (fs.readFileSync(fixture.stdoutLog, 'utf8').includes('fixture-ready'))
    {
        assert.equal(gracefulTermination, true);
        assert.ok(receipt.processTree.termination.some(
            (entry) => entry.phase === 'forced' && entry.signal === 'SIGKILL'
        ));
    }
    else
    {
        assert.ok(gracefulTermination || !receipt.processTree.processInventory.some(
            (entry) => entry.role === 'direct-child'
        ));
    }
});

test('SIGINT SIGTERM SIGHUP and plain AbortSignal all cancel the same Release path', {
    skip: process.platform !== 'linux'
}, async (context) =>
{
    for (const signalName of ['SIGINT', 'SIGTERM', 'SIGHUP', null])
    {
        const root = temporaryRoot(signalName ?? 'abort');
        context.after(() => fs.rmSync(root, { recursive: true, force: true }));
        const controller = new AbortController();
        const fixture = startScenario(root, { signal: controller.signal });
        await waitForReady(fixture.stdoutLog);
        controller.abort(Object.assign(new Error(signalName ?? 'AbortSignal fixture'), {
            name: 'AbortError',
            signal: signalName
        }));
        const result = await fixture.result;
        assert.equal(result.status, 'cancelled', signalName ?? 'AbortSignal');
        assert.equal(result.firstFailure.classification, 'cancelled');
        assert.ok(Array.isArray(result.cleanupFailures));
        const receipt = JSON.parse(fs.readFileSync(
            path.join(root, result.cancellation.path),
            'utf8'
        ));
        assert.equal(receipt.signal, signalName);
        assert.equal(receipt.processTree.postObservation, 'zero-members');
        assert.equal(receipt.logComplete, true);
    }
});

test('concurrent duplicate driver signals preserve the first reason and one idempotent receipt', {
    skip: process.platform !== 'linux'
}, async (context) =>
{
    const root = temporaryRoot('double-signal');
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const driver = createReleaseReliabilityCancellation();
    const fixture = startScenario(root, { signal: driver.signal });
    await waitForReady(fixture.stdoutLog);
    assert.equal(driver.request({
        kind: 'signal',
        signal: 'SIGINT',
        reason: new Error('first signal')
    }), true);
    assert.equal(driver.request({
        kind: 'signal',
        signal: 'SIGTERM',
        reason: new Error('second signal')
    }), false);
    const result = await fixture.result;
    driver.dispose();
    const receipt = JSON.parse(fs.readFileSync(
        path.join(root, result.cancellation.path),
        'utf8'
    ));
    assert.equal(result.status, 'cancelled');
    assert.equal(result.firstFailure.message, 'first signal');
    assert.equal(receipt.signal, 'SIGINT');
    assert.equal(receipt.reason, 'first signal');
    assert.equal(receipt.duplicateRequests, 1);
});

test('late producer-path evidence after cancellation is rejected by the terminal fence', {
    skip: process.platform !== 'linux'
}, async (context) =>
{
    const root = temporaryRoot('late-evidence');
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const controller = new AbortController();
    const fixture = startScenario(root, { signal: controller.signal });
    await waitForReady(fixture.stdoutLog);
    controller.abort(Object.assign(new Error('cancel before late evidence'), {
        name: 'AbortError',
        signal: 'SIGTERM'
    }));
    const result = await fixture.result;
    const lateEvidence = path.join(root, fixture.scenario.authoritativeEvidence.path);
    fs.mkdirSync(path.dirname(lateEvidence), { recursive: true });
    fs.writeFileSync(lateEvidence, JSON.stringify({
        status: 'ok',
        releaseReliability: { invocationId, runId }
    }));
    assert.equal(result.status, 'cancelled');
    assert.equal(result.terminalFence.lateEvidenceAccepted, false);
    assert.equal(result.authoritativeEvidence, null);
    assert.equal(fs.existsSync(fixture.claimedEvidence), false);
    assert.equal(fs.existsSync(lateEvidence), true);
});

test('a pipe that never closes is bounded and reports forced truncation honestly', async () =>
{
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const tracker = createPhysicalExecutionOutputTracker({
        policy: { ...physicalPolicy, pipeCloseTimeoutMs: 30 },
        stdout: { write() { return true; } },
        stderr: { write() { return true; } }
    });
    tracker.attach(stdout, 'stdout');
    tracker.attach(stderr, 'stderr');
    stdout.write('partial stdout');
    const startedAt = Date.now();
    const evidence = await tracker.close();
    assert.ok(Date.now() - startedAt < 500);
    assert.equal(evidence.logComplete, false);
    assert.equal(evidence.logTruncationReason, 'pipe-close-deadline-exceeded');
    assert.equal(evidence.forcedPipeClose, true);
    assert.match(evidence.stdout, /partial stdout/u);
});

test('bounded receipt capture reports truncation without mislabeling complete external logs', async () =>
{
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let externalLog = '';
    const tracker = createPhysicalExecutionOutputTracker({
        policy: { ...physicalPolicy, maximumCapturedOutputBytesPerStream: 8 },
        stdout: {
            write(chunk)
            {
                externalLog += chunk.toString();
                return true;
            }
        },
        stderr: { write() { return true; } }
    });
    tracker.attach(stdout, 'stdout');
    tracker.attach(stderr, 'stderr');
    stdout.end('complete-log');
    stderr.end();
    const evidence = await tracker.close();
    assert.equal(evidence.logComplete, true);
    assert.equal(evidence.logTruncationReason, null);
    assert.equal(evidence.forcedPipeClose, false);
    assert.equal(evidence.outputCapture.stdoutTruncated, true);
    assert.equal(evidence.outputCapture.stdoutBytes, Buffer.byteLength('complete-log'));
    assert.equal(evidence.outputCapture.stdoutCapturedBytes, 8);
    assert.equal(evidence.stdout, 'complete');
    assert.equal(externalLog, 'complete-log');
});
