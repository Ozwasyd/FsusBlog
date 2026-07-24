import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    executeRuntimeScenarioHost,
    readCatalog,
    repositoryRoot,
    validateRuntimeScenarioCatalog
} from '../../tools/test/runtime-scenario-host.mjs';
import { runRetainedRuntimeScenario } from '../../tools/test/run-retained-runtime-scenario.mjs';
import { compareRuntimeScenarioRounds } from '../../tools/test/runtime-scenario-benchmark.mjs';
import { aggregateRuntimeScenarioProcesses } from '../../tools/test/aggregate-runtime-scenario-processes.mjs';

const sourceIdentity = {
    commit: 'a'.repeat(40),
    worktreeFingerprint: 'b'.repeat(64),
    runId: 'runtime-scenario-host-fixture'
};

function temporaryEvidenceRoot()
{
    return fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-runtime-scenario-host-'));
}

function passingReset({ barrier, scenario, identity })
{
    return {
        schema: 'fsusblog.runtime-scenario-reset-receipt.v1',
        barrier,
        scenarioId: scenario.id,
        status: 'pass',
        source: identity,
        identityBefore: null,
        identityAfter: null,
        pollutionDetected: false
    };
}

test('catalog retains every phase, negative capability, and post-resilience recheck', () =>
{
    const catalog = readCatalog();
    assert.deepEqual(validateRuntimeScenarioCatalog(catalog), []);
    assert.equal(catalog.scenarios.length, 25);
    assert.equal(catalog.migrationBaseline.scenarioCount, 23);
    assert.deepEqual(
        [...new Set(catalog.scenarios.map(({ phase }) => phase))].sort(),
        ['integration', 'resilience', 'security']
    );
    for (const id of [
        'resilience.post-notification-contract',
        'resilience.post-notification-live',
        'resilience.post-binary-smoke',
        'resilience.post-binary-contract',
        'resilience.reset-pollution-negative'
    ])
    {
        assert.ok(catalog.scenarios.some((scenario) => scenario.id === id), id);
    }
    assert.ok(catalog.scenarios.some(({ executor }) => executor === 'retained-cli'));
});

test('resident host writes independent results and one initialization receipt', async (context) =>
{
    const evidenceRoot = temporaryEvidenceRoot();
    context.after(() => fs.rmSync(evidenceRoot, { recursive: true, force: true }));
    const calls = [];
    const { summary, summaryFile, progressFile } = await executeRuntimeScenarioHost({
        phase: 'integration',
        evidenceRoot,
        identity: sourceIdentity,
        loadRunner: async (scenario) => async ({ shared, scenarioId }) =>
        {
            calls.push({ scenarioId, processId: shared.processId });
            return { assertionCount: scenario.expectedAssertions.length };
        },
        resetBarrier: passingReset
    });

    assert.equal(summary.status, 'success');
    assert.equal(summary.results.length, 8);
    assert.ok(summary.results.every(({ status }) => status === 'pass'));
    assert.equal(summary.initialization.nodeProcessCount, 1);
    assert.equal(summary.initialization.httpKeepAliveClientCount, 1);
    assert.equal(summary.initialization.aedsContractInitializationCount, 1);
    assert.equal(new Set(calls.map(({ processId }) => processId)).size, 1);
    assert.ok(summary.results.every(({ diagnostics }) => diagnostics.timingAffectsCorrectness === false));
    assert.equal(summary.performance.nodeProcessCount, 1);
    assert.equal(summary.performance.affectsCorrectness, false);
    assert.equal(summary.migration.before.scenarioCount, 23);
    assert.equal(summary.migration.after.scenarioCount, 25);
    assert.equal(summary.migration.scenarioCountRegressed, false);
    assert.equal(summary.migration.coverageRegressed, false);
    assert.equal(summary.migration.negativeCapabilityRegressed, false);
    assert.ok(summary.results.every(({ scenarioId }) =>
        fs.existsSync(path.join(evidenceRoot, `${scenarioId.replace('.', '/')}.json`))));
    assert.ok(fs.existsSync(summaryFile));
    assert.equal(fs.existsSync(progressFile), false);
});

test('a scenario assertion failure is retained while later scenarios continue', async (context) =>
{
    const evidenceRoot = temporaryEvidenceRoot();
    context.after(() => fs.rmSync(evidenceRoot, { recursive: true, force: true }));
    let executionCount = 0;
    const { summary, summaryFile, progressFile } = await executeRuntimeScenarioHost({
        phase: 'integration',
        evidenceRoot,
        identity: sourceIdentity,
        loadRunner: async (scenario) => async () =>
        {
            executionCount += 1;
            if (scenario.id === 'integration.binary-contract')
            {
                throw new Error('fixture assertion failed');
            }
        },
        resetBarrier: passingReset
    });

    assert.equal(summary.status, 'failure');
    assert.equal(executionCount, 8);
    assert.deepEqual(summary.correctness.failedScenarioIds, ['integration.binary-contract']);
    assert.ok(summary.results.some(({ scenarioId, status }) =>
        scenarioId === 'integration.distribution-coherence' && status === 'pass'));
    assert.equal(fs.existsSync(summaryFile), false);
    assert.ok(fs.existsSync(progressFile));
});

test('polluted reset receipt fails closed and cannot be overwritten by later success', async (context) =>
{
    const evidenceRoot = temporaryEvidenceRoot();
    context.after(() => fs.rmSync(evidenceRoot, { recursive: true, force: true }));
    const pollution = JSON.parse(fs.readFileSync(
        path.join(
            repositoryRoot,
            'tests/tools/fixtures/runtime-scenario-host/polluted-identity.json'
        ),
        'utf8'
    ));
    assert.equal(pollution.mustNeverProduceSuccess, true);
    const { summary } = await executeRuntimeScenarioHost({
        phase: 'resilience',
        evidenceRoot,
        identity: sourceIdentity,
        loadRunner: async () => async () => {},
        resetBarrier: async ({ barrier, scenario, identity }) =>
        {
            if (barrier === 'post-resilience-mutation')
            {
                return {
                    schema: 'fsusblog.runtime-scenario-reset-receipt.v1',
                    barrier,
                    scenarioId: scenario.id,
                    status: 'failure',
                    source: identity,
                    identityBefore: pollution.activeIdentity,
                    identityAfter: pollution.activeIdentity,
                    pollutionDetected: true
                };
            }
            return passingReset({ barrier, scenario, identity });
        }
    });

    assert.equal(summary.status, 'failure');
    assert.ok(summary.resetReceipts.some(({ pollutionDetected }) => pollutionDetected));
    assert.ok(summary.correctness.failedScenarioIds.includes('resilience.post-notification-contract'));
    assert.equal(summary.results.at(-1).status, 'failure');
});

test('user cancellation keeps partial evidence and never writes a success receipt', async (context) =>
{
    const evidenceRoot = temporaryEvidenceRoot();
    context.after(() => fs.rmSync(evidenceRoot, { recursive: true, force: true }));
    const controller = new AbortController();
    let calls = 0;
    const { summary, summaryFile, progressFile } = await executeRuntimeScenarioHost({
        phase: 'integration',
        evidenceRoot,
        identity: sourceIdentity,
        signal: controller.signal,
        loadRunner: async () => async () =>
        {
            calls += 1;
            controller.abort('fixture-user-cancelled');
        },
        resetBarrier: passingReset
    });

    assert.equal(calls, 1);
    assert.equal(summary.status, 'cancelled');
    assert.ok(summary.results.slice(1).every(({ status }) => status === 'cancelled'));
    assert.equal(fs.existsSync(summaryFile), false);
    assert.ok(fs.existsSync(progressFile));
});

test('lane wiring retains one-shot probes and routes repeated probes through the host', () =>
{
    const source = fs.readFileSync(
        path.join(repositoryRoot, 'tools/test/lanes/_suite-support.sh'),
        'utf8'
    );
    assert.match(source, /run-runtime-scenario-host\.mjs" \\\n\s+--phase integration/u);
    assert.match(source, /run-runtime-scenario-host\.mjs" \\\n\s+--phase security/u);
    assert.match(source, /run-runtime-scenario-host\.mjs" \\\n\s+--phase resilience/u);
    assert.match(source, /check:sw-search-runtime/u);
    assert.match(source, /check:aot-cache-resilience/u);
    assert.match(source, /check:security:dast/u);
    assert.doesNotMatch(source, /RunIntegrationParallelChecks/u);
});

test('retained one-shot scenario writes an independent structured result', async (context) =>
{
    const runId = `retained-runtime-fixture-${process.pid}`;
    const outputRoot = path.join(repositoryRoot, '.tmp/runtime-scenario-host', runId);
    const previous = {
        runId: process.env.FSUSBLOG_TEST_RUN_ID,
        commit: process.env.FSUSBLOG_TEST_SOURCE_COMMIT,
        fingerprint: process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT
    };
    process.env.FSUSBLOG_TEST_RUN_ID = runId;
    process.env.FSUSBLOG_TEST_SOURCE_COMMIT = sourceIdentity.commit;
    process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT = sourceIdentity.worktreeFingerprint;
    context.after(() =>
    {
        fs.rmSync(outputRoot, { recursive: true, force: true });
        for (const [key, value] of [
            ['FSUSBLOG_TEST_RUN_ID', previous.runId],
            ['FSUSBLOG_TEST_SOURCE_COMMIT', previous.commit],
            ['FSUSBLOG_TEST_SOURCE_FINGERPRINT', previous.fingerprint]
        ])
        {
            if (value === undefined)
            {
                delete process.env[key];
            }
            else
            {
                process.env[key] = value;
            }
        }
    });

    const document = await runRetainedRuntimeScenario([
        '--scenario',
        'integration.sw-search',
        '--cwd',
        '.',
        '--',
        process.execPath,
        '-e',
        'process.exit(0)'
    ]);
    assert.equal(document.result.status, 'pass');
    assert.equal(document.result.diagnostics.timingAffectsCorrectness, false);
    assert.ok(fs.existsSync(path.join(outputRoot, 'integration/sw-search.json')));
});

test('three-round comparison records slower metrics without turning them into correctness failure', () =>
{
    const round = (runId, wallTimeMs) => ({
        status: 'success',
        source: {
            commit: sourceIdentity.commit,
            worktreeFingerprint: sourceIdentity.worktreeFingerprint
        },
        runId,
        performance: {
            wallTimeMs,
            cpuSeconds: wallTimeMs / 2000,
            nodeProcessCount: 1,
            connectionSetupCount: 2,
            machineFingerprint: 'same-machine'
        }
    });
    const comparison = compareRuntimeScenarioRounds({
        before: [round('before-1', 10), round('before-2', 11), round('before-3', 12)],
        after: [round('after-1', 20), round('after-2', 21), round('after-3', 22)]
    });
    assert.equal(comparison.roundCount.before, 3);
    assert.equal(comparison.correctness.performanceAffectsCorrectness, false);
    assert.ok(comparison.metrics.wallTimeMs.delta > 0);
    assert.throws(
        () => compareRuntimeScenarioRounds({
            before: [round('before-1', 10)],
            after: [round('after-1', 9)]
        }),
        /three before and three after rounds are required/u
    );
});

test('per-CLI before observer records real Node process, CPU, and connection counters', (context) =>
{
    const root = temporaryEvidenceRoot();
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const processes = path.join(root, 'processes');
    const output = path.join(root, 'before-summary.json');
    const startedAtMs = Date.now();
    execFileSync(process.execPath, ['-e', 'void 0'], {
        cwd: repositoryRoot,
        env: {
            ...process.env,
            FSUSBLOG_TEST_RUN_ID: sourceIdentity.runId,
            FSUSBLOG_TEST_SOURCE_COMMIT: sourceIdentity.commit,
            FSUSBLOG_TEST_SOURCE_FINGERPRINT: sourceIdentity.worktreeFingerprint,
            FSUSBLOG_RUNTIME_SCENARIO_PROCESS_EVIDENCE_DIR: processes,
            NODE_OPTIONS: `--import=${path.join(repositoryRoot, 'tools/test/runtime-scenario-process-observer.mjs')}`
        }
    });
    const document = aggregateRuntimeScenarioProcesses({
        phase: 'integration',
        input: processes,
        output,
        status: 'success',
        startedAtMs,
        env: {
            FSUSBLOG_TEST_RUN_ID: sourceIdentity.runId,
            FSUSBLOG_TEST_SOURCE_COMMIT: sourceIdentity.commit,
            FSUSBLOG_TEST_SOURCE_FINGERPRINT: sourceIdentity.worktreeFingerprint
        }
    });
    assert.equal(document.performance.nodeProcessCount, 1);
    assert.ok(document.performance.cpuSeconds >= 0);
    assert.ok(document.performance.connectionSetupCount >= 0);
    assert.equal(document.performance.affectsCorrectness, false);
    assert.ok(fs.existsSync(output));
});
