import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    loadLifecycleActionContracts
} from '../../tools/test/release-reliability-lifecycle-actions.mjs';
import {
    inspectBackendIdentity,
    readMeasurementProcessTreeObservation,
    runLifecycleAction
} from '../../tools/test/release-reliability-lifecycle.mjs';
import {
    digestValue,
    sealDocument
} from '../../tools/test/release-reliability-receipt.mjs';
import {
    verifyDataScaleOwnerReceipt,
    verifyDataScaleTeardownRuntimeBinding,
    verifyLifecycleActionReceipt,
    verifyMeasurementProcessTreeBinding
} from '../../tools/test/verify-release-reliability-lifecycle-action.mjs';

const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../..'
);
const invocationId = 'fixture-invocation';
const runId = 'fixture-run';
const scenarioId = 'release-mutation-critical-slice';
const sourceCommit = 'a'.repeat(40);

test('measurement lanes do not self-produce lifecycle receipts', () =>
{
    assert.equal(
        fs.existsSync(path.join(
            repositoryRoot,
            'tools/test/lanes/_release-reliability-lifecycle.sh'
        )),
        false
    );
    for (const relativePath of [
        'tools/test/lanes/backend-mutation-critical.sh',
        'tools/test/lanes/data-scale.sh',
        'tools/test/lanes/load-profile.sh',
        'tools/test/lanes/release-resource-budget.sh',
        'tools/test/lanes/soak.sh'
    ])
    {
        const source = fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
        assert.doesNotMatch(
            source,
            /release-reliability-lifecycle|InitializeReleaseReliabilityLifecycle/u
        );
    }
});

function copy(root, relativePath)
{
    const target = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(repositoryRoot, relativePath), target);
}

function createFixture(context)
{
    const root = fs.mkdtempSync(
        path.join(os.tmpdir(), 'fsusblog-release-reliability-lifecycle-')
    );
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const relativePath of [
        'config/schemas/release-reliability-lifecycle-action-registry.schema.json',
        'config/testing/release-reliability-lifecycle-action-registry.json',
        'config/testing/release-reliability-scenario-catalog.json',
        'config/testing/physical-execution-process-policy.json',
        'config/testing/runtime-state-domain-registry.json'
    ])
    {
        copy(root, relativePath);
    }
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
            contentDigest: `sha256:${'c'.repeat(64)}`,
            imageDigest: `sha256:${'2'.repeat(64)}`
        },
        policy: {
            physicalExecution: {
                status: 'complete',
                path: 'config/testing/physical-execution-process-policy.json',
                fileDigest: rawDigest(fs.readFileSync(path.join(
                    root,
                    'config/testing/physical-execution-process-policy.json'
                )))
            }
        }
    });
    const identityRelativePath =
        `.tmp/release-reliability/${invocationId}/identity.json`;
    const identityPath = path.join(root, identityRelativePath);
    fs.mkdirSync(path.dirname(identityPath), { recursive: true });
    fs.writeFileSync(identityPath, `${JSON.stringify(identity, null, 2)}\n`);
    return {
        root,
        identity,
        identityReference: {
            path: identityRelativePath,
            contentDigest: identity.contentDigest
        },
        environment: {
            FSUSBLOG_RELEASE_RELIABILITY_INVOCATION_ID: invocationId,
            FSUSBLOG_RELEASE_RELIABILITY_RUN_ID: runId,
            FSUSBLOG_RELEASE_RELIABILITY_SCENARIO_ID: scenarioId,
            FSUSBLOG_RELEASE_RELIABILITY_IDENTITY_PATH: identityRelativePath,
            FSUSBLOG_RELEASE_RELIABILITY_IDENTITY_DIGEST: identity.contentDigest
        }
    };
}

test('measurement descendant binding rereads raw process-tree bytes and rejects tamper', (context) =>
{
    const fixture = createFixture(context);
    const contracts = loadLifecycleActionContracts({
        repositoryRoot: fixture.root
    });
    const scenario = contracts.catalog.scenarios.find(
        (candidate) => candidate.id === scenarioId
    );
    const measurementActionId = scenario.isolation.lifecycle.measurement;
    const receiptRelative =
        `.tmp/release-reliability/${invocationId}/process-trees/` +
        `${scenarioId}/${measurementActionId}.json`;
    const policy = JSON.parse(fs.readFileSync(path.join(
        fixture.root,
        fixture.identity.policy.physicalExecution.path
    ), 'utf8'));
    const receipt = sealDocument({
        schema: 'fsusblog.release-reliability-process-tree-receipt.v1',
        status: 'passed',
        invocationId,
        runId,
        scenarioId,
        actionId: measurementActionId,
        phase: 'measurement',
        identity: fixture.identityReference,
        physicalPolicy: fixture.identity.policy.physicalExecution,
        processTree: {
            policy,
            postObservation: 'zero-members',
            logComplete: true
        },
        logComplete: true
    });
    const receiptFile = path.join(fixture.root, receiptRelative);
    fs.mkdirSync(path.dirname(receiptFile), { recursive: true });
    fs.writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
    const contextValue = {
        contracts,
        environment: {
            ...fixture.environment,
            FSUSBLOG_RELEASE_RELIABILITY_PROCESS_TREE_RECEIPT_PATH:
                receiptRelative
        },
        identity: fixture.identity,
        identityReference: fixture.identityReference,
        invocationId,
        repositoryRoot: fixture.root,
        runId,
        scenarioId
    };
    const observation = readMeasurementProcessTreeObservation(contextValue);
    assert.equal(observation.status, 'zero');
    assert.equal(observation.bytesDigest, rawDigest(fs.readFileSync(receiptFile)));
    const actionReceipt = {
        invocationId,
        runId,
        identity: fixture.identityReference
    };
    verifyMeasurementProcessTreeBinding({
        repositoryRoot: fixture.root,
        binding: observation,
        actionReceipt,
        scenario,
        identity: fixture.identity
    });
    fs.appendFileSync(receiptFile, '\n');
    assert.throws(
        () => verifyMeasurementProcessTreeBinding({
            repositoryRoot: fixture.root,
            binding: observation,
            actionReceipt,
            scenario,
            identity: fixture.identity
        }),
        /bytes changed/u
    );
    const tampered = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    tampered.processTree.postObservation = 'members-remain';
    fs.writeFileSync(receiptFile, `${JSON.stringify(tampered, null, 2)}\n`);
    assert.equal(
        readMeasurementProcessTreeObservation(contextValue).status,
        'failed'
    );
});

function observedMutationState()
{
    return {
        source: {
            status: 'clean',
            commit: sourceCommit,
            trackedDirty: false
        },
        productionBuild: {
            status: 'observed',
            path: '.tmp/production-build',
            fileCount: 1,
            inventoryDigest: `sha256:${'d'.repeat(64)}`
        },
        mutationOutput: {
            path: '.tmp/mutation/backend-critical',
            status: 'absent'
        }
    };
}

test('local lifecycle action writes one sealed raw receipt and independent verifier rereads it', async (context) =>
{
    const fixture = createFixture(context);
    const receipt = await runLifecycleAction({
        actionId: 'mutation-observe-isolated-output-admission',
        repositoryRoot: fixture.root,
        environment: fixture.environment,
        observeState: async () => observedMutationState()
    });
    assert.equal(receipt.status, 'passed');
    assert.equal(
        receipt.schema,
        'fsusblog.release-reliability-lifecycle-action-receipt.v2'
    );
    assert.equal(receipt.contentDigest, digestValue(receipt));
    assert.equal(receipt.finalObservation.status, 'passed');

    const contracts = loadLifecycleActionContracts({
        repositoryRoot: fixture.root
    });
    const action = contracts.actions.get(receipt.actionId);
    const scenario = contracts.catalog.scenarios.find(
        (candidate) => candidate.id === scenarioId
    );
    const reference = verifyLifecycleActionReceipt({
        repositoryRoot: fixture.root,
        action,
        scenario,
        invocationId,
        runId,
        identity: fixture.identity,
        identityReference: fixture.identityReference
    });
    assert.equal(reference.actionId, action.actionId);
    assert.equal(reference.bytesDigest.startsWith('sha256:'), true);
    assert.deepEqual(reference.finalObservation, receipt.finalObservation);
});

test('evidence-file preparation deletes only registry-owned mutation output', async (context) =>
{
    const fixture = createFixture(context);
    const owned = path.join(
        fixture.root,
        '.tmp/mutation/backend-critical/stale.json'
    );
    const adjacent = path.join(fixture.root, '.tmp/mutation/adjacent.json');
    fs.mkdirSync(path.dirname(owned), { recursive: true });
    fs.writeFileSync(owned, '{}\n');
    fs.writeFileSync(adjacent, '{}\n');
    const observeState = async () => ({
        targets: [{
            path: '.tmp/mutation/backend-critical',
            status: fs.existsSync(path.dirname(owned)) ? 'directory' : 'absent'
        }]
    });
    const receipt = await runLifecycleAction({
        actionId: 'mutation-prepare-isolated-output',
        repositoryRoot: fixture.root,
        environment: fixture.environment,
        observeState
    });
    assert.equal(receipt.status, 'passed');
    assert.equal(fs.existsSync(owned), false);
    assert.equal(fs.existsSync(adjacent), true);
    assert.deepEqual(receipt.stateDomains, ['artifact.mutation-output']);
});

test('failed final observation is sealed as failed and cannot verify as passed', async (context) =>
{
    const fixture = createFixture(context);
    const receipt = await runLifecycleAction({
        actionId: 'mutation-observe-isolated-output-admission',
        repositoryRoot: fixture.root,
        environment: fixture.environment,
        observeState: async () => ({
            ...observedMutationState(),
            productionBuild: {
                status: 'failed',
                reason: 'fixture unavailable'
            }
        })
    });
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.finalObservation.status, 'failed');
    const contracts = loadLifecycleActionContracts({
        repositoryRoot: fixture.root
    });
    assert.throws(
        () => verifyLifecycleActionReceipt({
            repositoryRoot: fixture.root,
            action: contracts.actions.get(receipt.actionId),
            scenario: contracts.catalog.scenarios.find(
                (candidate) => candidate.id === scenarioId
            ),
            invocationId,
            runId,
            identity: fixture.identity,
            identityReference: fixture.identityReference
        }),
        /status is not passing/u
    );
});

test('a resealed passed receipt with false post-state is rejected semantically', async (context) =>
{
    const fixture = createFixture(context);
    const receipt = await runLifecycleAction({
        actionId: 'mutation-observe-isolated-output-admission',
        repositoryRoot: fixture.root,
        environment: fixture.environment,
        observeState: async () => observedMutationState()
    });
    const falseAfter = {
        ...receipt.observations.after,
        productionBuild: { status: 'failed', reason: 'rewritten' }
    };
    const rewritten = sealDocument({
        ...receipt,
        contentDigest: undefined,
        observations: {
            ...receipt.observations,
            after: falseAfter
        },
        finalObservation: {
            status: 'passed',
            postStateDigest: digestValue({ state: falseAfter }),
            failures: []
        }
    });
    const receiptPath = path.join(
        fixture.root,
        `.tmp/release-reliability/${invocationId}/lifecycle/${scenarioId}/${receipt.actionId}.json`
    );
    fs.writeFileSync(receiptPath, JSON.stringify(rewritten));
    const contracts = loadLifecycleActionContracts({
        repositoryRoot: fixture.root
    });
    assert.throws(
        () => verifyLifecycleActionReceipt({
            repositoryRoot: fixture.root,
            action: contracts.actions.get(receipt.actionId),
            scenario: contracts.catalog.scenarios.find(
                (candidate) => candidate.id === scenarioId
            ),
            invocationId,
            runId,
            identity: fixture.identity,
            identityReference: fixture.identityReference
        }),
        /mutation source\/build post-state is invalid/u
    );
});

test('mutation postcondition fails when shared production-build inventory changed', async (context) =>
{
    const fixture = createFixture(context);
    await runLifecycleAction({
        actionId: 'mutation-observe-isolated-output-admission',
        repositoryRoot: fixture.root,
        environment: fixture.environment,
        observeState: async () => observedMutationState()
    });
    const changed = await runLifecycleAction({
        actionId: 'mutation-observe-shared-build-unchanged',
        repositoryRoot: fixture.root,
        environment: fixture.environment,
        observeState: async () => ({
            ...observedMutationState(),
            productionBuild: {
                ...observedMutationState().productionBuild,
                inventoryDigest: `sha256:${'e'.repeat(64)}`
            }
        })
    });
    assert.equal(changed.status, 'failed');
    assert.match(
        changed.finalObservation.failures.join('\n'),
        /inventory changed/u
    );
});

test('mutation reset-after deletes owned output and rejects a residual observation', async (context) =>
{
    const fixture = createFixture(context);
    await runLifecycleAction({
        actionId: 'mutation-observe-isolated-output-admission',
        repositoryRoot: fixture.root,
        environment: fixture.environment,
        observeState: async () => observedMutationState()
    });
    const output = path.join(
        fixture.root,
        '.tmp/mutation/backend-critical/authority.json'
    );
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, '{}\n');
    const receipt = await runLifecycleAction({
        actionId: 'mutation-observe-final-output-state',
        repositoryRoot: fixture.root,
        environment: fixture.environment,
        observeState: async () => ({
            ...observedMutationState(),
            mutationOutput: {
                path: '.tmp/mutation/backend-critical',
                status: fs.existsSync(path.dirname(output))
                    ? 'directory'
                    : 'absent'
            },
            measurementDescendants: { status: 'zero', pids: [] }
        })
    });
    assert.equal(receipt.status, 'passed');
    assert.equal(fs.existsSync(output), false);
    assert.deepEqual(receipt.operation.deleted, [{
        path: '.tmp/mutation/backend-critical',
        existed: true
    }]);

    const residual = await runLifecycleAction({
        actionId: 'mutation-observe-final-output-state',
        repositoryRoot: fixture.root,
        environment: fixture.environment,
        observeState: async () => ({
            ...observedMutationState(),
            mutationOutput: {
                path: '.tmp/mutation/backend-critical',
                status: 'directory'
            },
            measurementDescendants: { status: 'zero', pids: [] }
        })
    });
    assert.equal(residual.status, 'failed');
    assert.match(
        residual.finalObservation.failures.join('\n'),
        /cleanup final observation is not absent/u
    );
});

test('PID data-scale backend observation uses executable bytes digest', () =>
{
    const observed = inspectBackendIdentity(
        {
            pidOrContainerId: process.pid,
            startTicks: 'unused',
            executableOrImageDigest: 'unused'
        },
        () =>
        {
            throw new Error('docker must not be used for a PID owner');
        },
        repositoryRoot
    );
    const executable = fs.readlinkSync(`/proc/${process.pid}/exe`);
    assert.equal(observed.status, 'running');
    assert.equal(
        observed.executableOrImageDigest,
        rawDigest(fs.readFileSync(executable))
    );
    assert.notEqual(
        observed.executableOrImageDigest,
        `sha256:${'0'.repeat(64)}`
    );
});

test('resealed runtime observation cannot substitute non-current topology identities', () =>
{
    const fixture = createFixture({ after: () =>
    {} });
    try
    {
        const actionId = 'runtime-identity-precondition';
        const action = {
            actionId,
            scenarioId: 'release-soak-min',
            phase: 'precondition',
            operation: 'observe-runtime',
            expectedReceiptPath: `.tmp/release-reliability/{invocationId}/lifecycle/{scenarioId}/${actionId}.json`,
            expectedReceiptSchema:
                'fsusblog.release-reliability-lifecycle-action-receipt.v2',
            requiredFields: [
                'actionId',
                'contentDigest',
                'finalObservation',
                'finishedAt',
                'invocationId',
                'observations',
                'operation',
                'phase',
                'runId',
                'scenarioId',
                'schema',
                'startedAt',
                'stateDomains',
                'status'
            ],
            passStatusValues: ['passed'],
            stateDomains: [
                'network.host-topology',
                'postgres.schema',
                'redis.cache.public',
                'runtime.backend-process'
            ]
        };
        const identity = {
            ...fixture.identity,
            fixture: {
                topology: {
                    content: {
                        postgres: { instance: '1'.repeat(64) },
                        redis: { instance: '2'.repeat(64) },
                        runtime: {
                            backendContainer: {
                                id: '3'.repeat(64),
                                portBinding: {
                                    hostIp: '127.0.0.1',
                                    hostPort: 24501
                                }
                            }
                        }
                    }
                }
            }
        };
        const after = {
            expectedBaseUrl: 'http://127.0.0.1:24501',
            configuredBaseUrl: 'http://127.0.0.1:24501',
            backend: { status: 'running', id: '4'.repeat(64) },
            postgres: { status: 'running', id: '1'.repeat(64) },
            redis: { status: 'running', id: '2'.repeat(64) },
            network: { status: 'bound' },
            live: { status: 'live' }
        };
        const receipt = sealDocument({
            schema: action.expectedReceiptSchema,
            status: 'passed',
            actionId,
            phase: action.phase,
            scenarioId: action.scenarioId,
            invocationId,
            runId,
            identity: fixture.identityReference,
            stateDomains: action.stateDomains,
            operation: { kind: action.operation },
            observations: { before: after, after },
            finalObservation: {
                status: 'passed',
                postStateDigest: digestValue({ state: after }),
                failures: []
            },
            startedAt: '2026-07-30T00:00:00.000Z',
            finishedAt: '2026-07-30T00:00:01.000Z'
        });
        const relative =
            `.tmp/release-reliability/${invocationId}/lifecycle/${action.scenarioId}/${actionId}.json`;
        const absolute = path.join(fixture.root, relative);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, JSON.stringify(receipt));
        assert.throws(
            () => verifyLifecycleActionReceipt({
                repositoryRoot: fixture.root,
                action,
                scenario: {
                    id: action.scenarioId,
                    isolation: {
                        lifecycle: { preconditions: [actionId] }
                    }
                },
                invocationId,
                runId,
                identity,
                identityReference: fixture.identityReference
            }),
            /not bound to run identity/u
        );
    }
    finally
    {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

function rawDigest(bytes)
{
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

test('owner verifier accepts #1620 array-shaped teardown and rejects obsolete timestamps object', (context) =>
{
    const fixture = createFixture(context);
    const receipt = sealDocument({
        schema: 'fsusblog.data-scale-teardown.v1',
        status: 'complete',
        dataScaleRunId: 'data-scale-run',
        parentSchedulerRunId: runId,
        sourceCommit,
        runtimePlanDigest: `sha256:${'f'.repeat(64)}`,
        startedAt: '2026-07-30T00:00:00.000Z',
        finishedAt: '2026-07-30T00:00:01.000Z',
        resources: [{
            plannedId: 'container-a',
            observedId: 'container-a',
            ownershipStatus: 'owned',
            action: 'remove',
            actionExit: 0,
            postObservation: { status: 'absent' },
            status: 'complete'
        }],
        ports: [{ port: 24501, postListeningPids: [] }],
        leases: [{ id: 'lease-a', postStatus: 'released' }],
        roots: [{
            path: '.tmp/data-scale-run/data',
            postExists: false
        }],
        failures: []
    });
    const relative = '.tmp/data-scale-run/teardown.json';
    const file = path.join(fixture.root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(receipt));
    const verified = verifyDataScaleOwnerReceipt({
        repositoryRoot: fixture.root,
        ownerReceipt: 'data-scale-teardown',
        receiptPath: relative,
        identity: fixture.identity,
        runId
    });
    assert.equal(verified.schema, 'fsusblog.data-scale-teardown.v1');
    const obsolete = sealDocument({
        ...receipt,
        contentDigest: undefined,
        timestamps: {
            startedAt: receipt.startedAt,
            finishedAt: receipt.finishedAt
        }
    });
    delete obsolete.startedAt;
    delete obsolete.finishedAt;
    fs.writeFileSync(file, JSON.stringify(obsolete));
    assert.throws(
        () => verifyDataScaleOwnerReceipt({
            repositoryRoot: fixture.root,
            ownerReceipt: 'data-scale-teardown',
            receiptPath: relative,
            identity: fixture.identity,
            runId
        }),
        /top-level fields mismatch/u
    );
});

test('#1620 teardown cannot substitute another data-scale runtime in the same scheduler run', () =>
{
    assert.throws(
        () => verifyDataScaleTeardownRuntimeBinding({
            runtimeReceipt: {
                actionId: 'data-scale-require-dedicated-runtime',
                ownerReceipt: { dataScaleRunId: 'data-scale-run-a' }
            },
            teardownReceipt: { dataScaleRunId: 'data-scale-run-b' },
            operationBinding: { dataScaleRunId: 'data-scale-run-a' },
            expectedRuntimeActionId: 'data-scale-require-dedicated-runtime'
        }),
        /targets another runtime owner/u
    );
});

test('#1617 runtime owner binds exact nested identities, dedicated roots, and seed bytes', (context) =>
{
    const fixture = createFixture(context);
    const dataScaleRunId = 'data-scale-run';
    const seedRelative = `.tmp/${dataScaleRunId}/seed.json`;
    const seedFile = path.join(fixture.root, seedRelative);
    fs.mkdirSync(path.dirname(seedFile), { recursive: true });
    fs.writeFileSync(seedFile, '{"seed":"bound"}\n');
    for (const name of ['aot', 'search', 'hot-read', 'data'])
    {
        fs.mkdirSync(
            path.join(fixture.root, `.tmp/${dataScaleRunId}/${name}`),
            { recursive: true }
        );
    }
    const receipt = sealDocument({
        schema: 'fsusblog.data-scale-runtime.v1',
        dataScaleRunId,
        parentSchedulerRunId: runId,
        sourceCommit,
        worktreeFingerprint: fixture.identity.sourceState.worktreeFingerprint,
        buildReceiptDigest: fixture.identity.build.contentDigest,
        imageDigest: `sha256:${'2'.repeat(64)}`,
        namespace: 'data-scale-namespace',
        postgres: {
            containerId: '3'.repeat(64),
            imageDigest: `sha256:${'4'.repeat(64)}`,
            volumeId: 'postgres-volume',
            database: 'fsusblog_data_scale'
        },
        redis: {
            containerId: '5'.repeat(64),
            imageDigest: `sha256:${'6'.repeat(64)}`,
            volumeId: 'redis-volume'
        },
        backend: {
            pidOrContainerId: '7'.repeat(64),
            startTicks: '12345',
            baseUrl: 'http://127.0.0.1:24501',
            executableOrImageDigest: fixture.identity.build.imageDigest
        },
        aotRoot: `.tmp/${dataScaleRunId}/aot`,
        searchRoot: `.tmp/${dataScaleRunId}/search`,
        hotReadRoot: `.tmp/${dataScaleRunId}/hot-read`,
        dataRoot: `.tmp/${dataScaleRunId}/data`,
        envManifestDigest: `sha256:${'9'.repeat(64)}`,
        seedReceiptPath: seedRelative,
        seedReceiptDigest: rawDigest(fs.readFileSync(seedFile)),
        createdAt: '2026-07-30T00:00:00.000Z'
    });
    const relative = `.tmp/${dataScaleRunId}/runtime.json`;
    fs.writeFileSync(path.join(fixture.root, relative), JSON.stringify(receipt));
    const verified = verifyDataScaleOwnerReceipt({
        repositoryRoot: fixture.root,
        ownerReceipt: 'data-scale-runtime',
        receiptPath: relative,
        identity: fixture.identity,
        runId
    });
    assert.equal(verified.dataScaleRunId, dataScaleRunId);
    const wrongBuild = sealDocument({
        ...receipt,
        contentDigest: undefined,
        buildReceiptDigest: `sha256:${'0'.repeat(64)}`
    });
    fs.writeFileSync(
        path.join(fixture.root, relative),
        JSON.stringify(wrongBuild)
    );
    assert.throws(
        () => verifyDataScaleOwnerReceipt({
            repositoryRoot: fixture.root,
            ownerReceipt: 'data-scale-runtime',
            receiptPath: relative,
            identity: fixture.identity,
            runId
        }),
        /identity mismatch/u
    );
    fs.writeFileSync(
        path.join(fixture.root, relative),
        JSON.stringify(receipt)
    );
    fs.writeFileSync(seedFile, '{"seed":"tampered"}\n');
    assert.throws(
        () => verifyDataScaleOwnerReceipt({
            repositoryRoot: fixture.root,
            ownerReceipt: 'data-scale-runtime',
            receiptPath: relative,
            identity: fixture.identity,
            runId
        }),
        /seed receipt path\/digest binding mismatch/u
    );
});
