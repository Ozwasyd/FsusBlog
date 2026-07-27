import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    runLifecycleCommand
} from '../../tools/test/release-reliability-lifecycle.mjs';
import {
    digestValue,
    sealDocument
} from '../../tools/test/release-reliability-receipt.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const invocationId = 'fixture-invocation';
const runId = 'fixture-run';
const scenarioId = 'release-mutation-critical-slice';
const sourceCommit = 'a'.repeat(40);

function createFixture(context)
{
    const root = fs.mkdtempSync(
        path.join(os.tmpdir(), 'fsusblog-release-reliability-lifecycle-')
    );
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const catalogTarget = path.join(
        root,
        'config/testing/release-reliability-scenario-catalog.json'
    );
    fs.mkdirSync(path.dirname(catalogTarget), { recursive: true });
    fs.copyFileSync(
        path.join(repositoryRoot, 'config/testing/release-reliability-scenario-catalog.json'),
        catalogTarget
    );
    const identity = sealDocument({
        schema: 'fsusblog.release-reliability-run-identity.v1',
        status: 'complete',
        invocationId,
        runId,
        sourceState: {
            commit: sourceCommit,
            worktreeFingerprint: `sha256:${'b'.repeat(64)}`,
            dirtyPathCount: 0,
            hashedPathCount: 0
        },
        build: {
            contentDigest: `sha256:${'c'.repeat(64)}`
        }
    });
    const identityRelativePath = `.tmp/release-reliability/${invocationId}/identity.json`;
    const identityPath = path.join(root, identityRelativePath);
    fs.mkdirSync(path.dirname(identityPath), { recursive: true });
    fs.writeFileSync(identityPath, `${JSON.stringify(identity, null, 2)}\n`);
    const lifecycleRelativeRoot =
        `.tmp/release-reliability/${invocationId}/lifecycle/${scenarioId}`;
    return {
        root,
        identity,
        lifecycleRoot: path.join(root, lifecycleRelativeRoot),
        environment: {
            FSUSBLOG_RELEASE_RELIABILITY_INVOCATION_ID: invocationId,
            FSUSBLOG_RELEASE_RELIABILITY_RUN_ID: runId,
            FSUSBLOG_RELEASE_RELIABILITY_SCENARIO_ID: scenarioId,
            FSUSBLOG_RELEASE_RELIABILITY_IDENTITY_PATH: identityRelativePath,
            FSUSBLOG_RELEASE_RELIABILITY_IDENTITY_DIGEST: identity.contentDigest,
            FSUSBLOG_RELEASE_RELIABILITY_LIFECYCLE_ROOT: lifecycleRelativeRoot
        }
    };
}

function stateObserver({ resetState, authorityState })
{
    return async (lifecycleContext) => ({
        observedAt: new Date().toISOString(),
        domains: lifecycleContext.stateDomains,
        outputs: lifecycleContext.resetTargets.map((target) => ({
            path: target,
            status: authorityState.value
                ? 'directory'
                : resetState.value
                    ? 'absent'
                    : 'directory'
        })),
        source: {
            commit: sourceCommit,
            trackedDirty: false
        },
        cpu: {
            logicalProcessors: 4,
            loadAverage1m: 0
        },
        dataScaleCleanup: null
    });
}

test('producer lifecycle records ordered real phases around one authority window', async (context) =>
{
    const fixture = createFixture(context);
    const resetState = { value: false };
    const authorityState = { value: false };
    const observeState = stateObserver({ resetState, authorityState });
    const options = {
        repositoryRoot: fixture.root,
        environment: fixture.environment,
        observeState,
        resetState: async () =>
        {
            resetState.value = true;
            return {
                action: 'fixture-reset',
                deleted: [{ path: '.tmp/mutation/backend-critical', existed: true }]
            };
        }
    };

    const precondition = await runLifecycleCommand({
        ...options,
        command: 'phase',
        phase: 'precondition'
    });
    const reset = await runLifecycleCommand({
        ...options,
        command: 'phase',
        phase: 'reset'
    });
    const marker = await runLifecycleCommand({
        ...options,
        command: 'start-measurement'
    });
    const authorityFile = path.join(
        fixture.root,
        '.tmp/mutation/backend-critical/authority.json'
    );
    fs.mkdirSync(path.dirname(authorityFile), { recursive: true });
    fs.writeFileSync(authorityFile, '{"status":"success"}\n');
    authorityState.value = true;
    const measurement = await runLifecycleCommand({
        ...options,
        command: 'finish-measurement',
        producerStatus: 0
    });
    const postcondition = await runLifecycleCommand({
        ...options,
        command: 'phase',
        phase: 'postcondition',
        producerStatus: 0
    });

    assert.equal(precondition.status, 'complete');
    assert.equal(reset.status, 'complete');
    assert.equal(marker.status, 'started');
    assert.equal(measurement.status, 'complete');
    assert.equal(postcondition.status, 'complete');
    assert.ok(
        Date.parse(reset.startedAt) >= Date.parse(precondition.finishedAt)
    );
    assert.ok(
        Date.parse(measurement.startedAt) >= Date.parse(reset.finishedAt)
    );
    assert.ok(
        Date.parse(postcondition.startedAt) >= Date.parse(measurement.finishedAt)
    );
    for (const phase of ['precondition', 'reset', 'measurement', 'postcondition'])
    {
        const receipt = JSON.parse(
            fs.readFileSync(path.join(fixture.lifecycleRoot, `${phase}.json`), 'utf8')
        );
        assert.equal(
            receipt.schema,
            'fsusblog.release-reliability-lifecycle-action.v1'
        );
        assert.equal(receipt.phase, phase);
        assert.equal(receipt.contentDigest, digestValue(receipt));
        assert.ok(receipt.state.before.startsWith('sha256:'));
        assert.ok(receipt.state.after.startsWith('sha256:'));
        assert.ok(Object.keys(receipt.observations).length > 0);
    }
    assert.equal(
        fs.existsSync(path.join(fixture.lifecycleRoot, '.measurement-start.json')),
        false
    );
});

test('producer failure remains explicit in measurement and postcondition receipts', async (context) =>
{
    const fixture = createFixture(context);
    const resetState = { value: true };
    const authorityState = { value: false };
    const observeState = stateObserver({ resetState, authorityState });
    const options = {
        repositoryRoot: fixture.root,
        environment: fixture.environment,
        observeState
    };
    await runLifecycleCommand({ ...options, command: 'start-measurement' });
    const measurement = await runLifecycleCommand({
        ...options,
        command: 'finish-measurement',
        producerStatus: 19
    });
    const postcondition = await runLifecycleCommand({
        ...options,
        command: 'phase',
        phase: 'postcondition',
        producerStatus: 19
    });
    assert.equal(measurement.status, 'failed');
    assert.match(measurement.observations.checks[0], /status 19/u);
    assert.equal(postcondition.status, 'failed');
    assert.match(postcondition.observations.checks.at(-1), /status 19/u);
});

test('default reset removes only the selected scenario-owned target', async (context) =>
{
    const fixture = createFixture(context);
    const stale = path.join(fixture.root, '.tmp/mutation/backend-critical/stale.json');
    const adjacent = path.join(fixture.root, '.tmp/mutation/adjacent.json');
    fs.mkdirSync(path.dirname(stale), { recursive: true });
    fs.writeFileSync(stale, '{}\n');
    fs.writeFileSync(adjacent, '{}\n');
    const observeState = async (lifecycleContext) => ({
        observedAt: new Date().toISOString(),
        domains: lifecycleContext.stateDomains,
        outputs: lifecycleContext.resetTargets.map((target) => ({
            path: target,
            status: fs.existsSync(path.join(fixture.root, target))
                ? 'directory'
                : 'absent'
        })),
        source: { commit: sourceCommit, trackedDirty: false },
        cpu: { logicalProcessors: 4, loadAverage1m: 0 },
        dataScaleCleanup: null
    });
    const receipt = await runLifecycleCommand({
        repositoryRoot: fixture.root,
        environment: fixture.environment,
        observeState,
        command: 'phase',
        phase: 'reset'
    });
    assert.equal(receipt.status, 'complete');
    assert.equal(fs.existsSync(stale), false);
    assert.equal(fs.existsSync(adjacent), true);
});

test('lifecycle root is bound to the exact invocation and scenario', async (context) =>
{
    const fixture = createFixture(context);
    await assert.rejects(
        runLifecycleCommand({
            repositoryRoot: fixture.root,
            environment: {
                ...fixture.environment,
                FSUSBLOG_RELEASE_RELIABILITY_LIFECYCLE_ROOT:
                    `.tmp/release-reliability/${invocationId}/lifecycle/other-scenario`
            },
            command: 'phase',
            phase: 'precondition'
        }),
        /root is not canonical/u
    );
});

test('all seven real lane entrypoints initialize producer-owned lifecycle', () =>
{
    for (const file of [
        'tools/test/lanes/soak.sh',
        'tools/test/lanes/load-profile.sh',
        'tools/test/lanes/data-scale.sh',
        'tools/test/lanes/backend-mutation-critical.sh',
        'tools/test/lanes/release-resource-budget.sh'
    ])
    {
        const source = fs.readFileSync(path.join(repositoryRoot, file), 'utf8');
        assert.match(source, /_release-reliability-lifecycle\.sh/u, file);
        assert.match(source, /InitializeReleaseReliabilityLifecycle/u, file);
    }
});
