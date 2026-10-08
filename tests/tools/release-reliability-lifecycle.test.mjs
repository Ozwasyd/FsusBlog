import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const {
    loadLifecycleActionContracts,
    ordinaryRuntimeResourceStateErrors
} = await import(new URL('../../tools/test/release-reliability-lifecycle-actions.mjs', import.meta.url));
const {
    observeOrdinaryRuntimeResourceState,
    inspectBackendIdentity,
    readMeasurementProcessTreeObservation,
    runLifecycleAction
} = await import(new URL('../../tools/test/release-reliability-lifecycle.mjs', import.meta.url));
const {
    digestValue,
    sealDocument
} = await import(new URL('../../tools/test/release-reliability-receipt.mjs', import.meta.url));
const {
    verifyDataScaleOwnerReceipt,
    verifyDataScaleTeardownRuntimeBinding,
    verifyLifecycleActionReceipt,
    verifyMeasurementProcessTreeBinding
} = await import(new URL('../../tools/test/verify-release-reliability-lifecycle-action.mjs', import.meta.url));
const {
    readDockerPostgresqlDatabaseState,
    readDockerPublicCacheState,
    resetDockerPublicCache
} = await import(new URL('../../tools/test-runtime/production-observer-ports.mjs', import.meta.url));

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
        fixture: { status: 'complete' },
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
        schema: 'fsusblog.data-scale-teardown.v2',
        status: 'complete',
        dataScaleRunId: 'data-scale-run',
        parentSchedulerRunId: runId,
        invocationId,
        attemptId: 'attempt-1',
        sourceCommit,
        runtimePlanDigest: `sha256:${'f'.repeat(64)}`,
        runtimeReceiptDigest: `sha256:${'e'.repeat(64)}`,
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
        runId,
        invocationId,
        attemptId: 'attempt-1'
    });
    assert.equal(verified.schema, 'fsusblog.data-scale-teardown.v2');
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
            runId,
            invocationId,
            attemptId: 'attempt-1'
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
        schema: 'fsusblog.data-scale-runtime.v2',
        dataScaleRunId,
        parentSchedulerRunId: runId,
        invocationId,
        attemptId: 'attempt-1',
        sourceCommit,
        worktreeFingerprint: fixture.identity.sourceState.worktreeFingerprint,
        buildReceiptDigest: fixture.identity.build.contentDigest,
        imageDigest: `sha256:${'2'.repeat(64)}`,
        fixtureIdentityDigest: digestValue(fixture.identity.fixture),
        namespace: 'data-scale-namespace',
        network: { id: '8'.repeat(64), name: 'data-scale-network' },
        permissionHelper: {
            name: 'data-scale-permission-helper',
            postExists: false
        },
        lifecycle: {
            start: 'complete',
            reset: 'complete',
            readiness: 'complete',
            postcondition: 'pending'
        },
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
        connections: {
            postgres: {
                applicationName: `FsusBlogDataScale-${dataScaleRunId}`,
                backendAddress: '172.24.0.4',
                database: 'fsusblog_data_scale',
                matchingClientCount: 2,
                foreignClientCount: 0
            },
            redis: {
                clientName: `FsusBlogDataScale-${dataScaleRunId}`,
                backendAddress: '172.24.0.4',
                matchingClientCount: 2,
                foreignClientCount: 0
            }
        },
        aotRoot: `.tmp/${dataScaleRunId}/aot`,
        searchRoot: `.tmp/${dataScaleRunId}/search`,
        hotReadRoot: `.tmp/${dataScaleRunId}/hot-read`,
        dataRoot: `.tmp/${dataScaleRunId}/data`,
        envManifestDigest: `sha256:${'9'.repeat(64)}`,
        seedReceiptPath: seedRelative,
        seedReceiptDigest: rawDigest(fs.readFileSync(seedFile)),
        seedSummary: {
            status: 'ok', tier: 'scale-m', namespace: 'data-scale-namespace',
            declared: { articles: 10000, comments: 100000 },
            expected: { articles: 10000, comments: 100000 },
            observed: { articles: 10000, comments: 100000 }
        },
        createdAt: '2026-07-30T00:00:00.000Z'
    });
    const relative = `.tmp/${dataScaleRunId}/runtime.json`;
    fs.writeFileSync(path.join(fixture.root, relative), JSON.stringify(receipt));
    const verified = verifyDataScaleOwnerReceipt({
        repositoryRoot: fixture.root,
        ownerReceipt: 'data-scale-runtime',
        receiptPath: relative,
        identity: fixture.identity,
        runId,
        invocationId,
        attemptId: 'attempt-1'
    });
    assert.equal(verified.dataScaleRunId, dataScaleRunId);
    const missingConnections = sealDocument({
        ...receipt,
        contentDigest: undefined,
        connections: undefined
    });
    fs.writeFileSync(
        path.join(fixture.root, relative),
        JSON.stringify(missingConnections)
    );
    assert.throws(
        () => verifyDataScaleOwnerReceipt({
            repositoryRoot: fixture.root,
            ownerReceipt: 'data-scale-runtime',
            receiptPath: relative,
            identity: fixture.identity,
            runId,
            invocationId,
            attemptId: 'attempt-1'
        }),
        /top-level fields mismatch/u
    );
    const unknownConnectionField = sealDocument({
        ...receipt,
        contentDigest: undefined,
        connections: {
            ...receipt.connections,
            redis: { ...receipt.connections.redis, unknown: true }
        }
    });
    fs.writeFileSync(
        path.join(fixture.root, relative),
        JSON.stringify(unknownConnectionField)
    );
    assert.throws(
        () => verifyDataScaleOwnerReceipt({
            repositoryRoot: fixture.root,
            ownerReceipt: 'data-scale-runtime',
            receiptPath: relative,
            identity: fixture.identity,
            runId,
            invocationId,
            attemptId: 'attempt-1'
        }),
        /Redis connection identity top-level fields mismatch/u
    );
    fs.writeFileSync(
        path.join(fixture.root, relative),
        JSON.stringify(receipt)
    );
    assert.throws(
        () => verifyDataScaleOwnerReceipt({
            repositoryRoot: fixture.root,
            ownerReceipt: 'data-scale-runtime',
            receiptPath: relative,
            identity: fixture.identity,
            runId,
            invocationId,
            attemptId: 'attempt-2'
        }),
        /identity mismatch/u
    );
    const notReady = sealDocument({
        ...receipt,
        contentDigest: undefined,
        lifecycle: { ...receipt.lifecycle, readiness: 'failed' }
    });
    fs.writeFileSync(path.join(fixture.root, relative), JSON.stringify(notReady));
    assert.throws(
        () => verifyDataScaleOwnerReceipt({
            repositoryRoot: fixture.root,
            ownerReceipt: 'data-scale-runtime',
            receiptPath: relative,
            identity: fixture.identity,
            runId,
            invocationId,
            attemptId: 'attempt-1'
        }),
        /lifecycle state is incomplete/u
    );
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
            runId,
            invocationId,
            attemptId: 'attempt-1'
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
            runId,
            invocationId,
            attemptId: 'attempt-1'
        }),
        /seed receipt path\/digest binding mismatch/u
    );
});

// Explicit diagnostic opt-in: these native primitives do not admit or qualify a release runtime.
test('native lifecycle state detects summary-only pollution and verifies exact cache cleanup', {
    skip: process.env.FSUSBLOG_LIFECYCLE_NATIVE !== '1'
}, async (context) =>
{
    const runId = `lifecycle-native-${randomUUID()}`;
    const namespace = runId;
    const directory = path.join(repositoryRoot, '.tmp/release-reliability/lifecycle-native', runId);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const evidence = {
        sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim(),
        runId, namespace, startedAt: new Date().toISOString(), qualificationEligible: false,
        nativeControls: [], resources: [], cleanup: [], status: 'running'
    };
    const ids = {};
    const docker = (...args) => execFileSync('docker', args, {
        encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024
    }).trim();
    const sql = (query) => docker('exec', ids.postgres, 'psql', '-X', '-qAt', '-v',
        'ON_ERROR_STOP=1', '-U', 'fsusblog', '-d', 'fsusblog', '-c', query);
    const redis = (...args) => JSON.parse(docker('exec', ids.redis, 'redis-cli', '--json', ...args));
    try
    {
        for (const [kind, image, args] of [
            ['postgres', 'postgres:17-alpine', ['--tmpfs', '/var/lib/postgresql/data:rw',
                '-e', 'POSTGRES_USER=fsusblog', '-e', 'POSTGRES_DB=fsusblog', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust']],
            ['redis', 'redis:7-alpine', ['--tmpfs', '/data:rw']]
        ])
        {
            ids[kind] = docker('run', '-d', '--name', `fsusblog-test-${runId}-${kind}`,
                '--label', `io.fsusblog.test.run-id=${runId}`, '--label', `io.fsusblog.test.namespace=${namespace}`,
                '--cpus', '0.5', '--memory', '256m', '--pids-limit', '64', ...args, image);
            evidence.resources.push({ kind, id: ids[kind], image });
        }
        const deadline = Date.now() + 20_000;
        let ready = false;
        while (Date.now() < deadline)
        {
            try
            {
                assert.equal(sql('SELECT 1;'), '1');
                assert.equal(redis('PING'), 'PONG');
                ready = true;
                break;
            }
            catch
            {
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
        }
        assert.equal(ready, true, 'real PostgreSQL and Redis must become ready');
        sql("CREATE TABLE lifecycle_probe (id integer PRIMARY KEY, value text NOT NULL); INSERT INTO lifecycle_probe VALUES (1, 'fixture'); CREATE SEQUENCE lifecycle_sequence;");
        const namespacePrefix = `FsusBlog_${namespace}_`;
        const initialDatabase = readDockerPostgresqlDatabaseState({ container: ids.postgres });
        assert.equal(initialDatabase.relations.length, 2, 'both fixture rows and sequences must be observed');
        const imageId = (id) => JSON.parse(docker('inspect', id))[0].Image;
        const topology = { runId, namespace,
            postgres: { instance: ids.postgres, imageId: imageId(ids.postgres) },
            redis: { instance: ids.redis, imageId: imageId(ids.redis) },
            runtime: { environmentProjection: { effective: { RedisOptions__InstanceName: namespacePrefix } } } };
        topology.resourceState = await observeOrdinaryRuntimeResourceState({ topology, runId });
        assert.equal(topology.resourceState.postgres.status, 'observed');
        assert.equal(topology.resourceState.redis.status, 'observed');
        const action = { operation: 'reset-runtime-state', phase: 'reset-before' };
        const reset = () => resetDockerPublicCache({ container: ids.redis, runId, namespace, namespacePrefix });
        const errors = async (proof) => ordinaryRuntimeResourceStateErrors({ action, topology,
            observation: { resourceState: await observeOrdinaryRuntimeResourceState({ topology, runId }) }, reset: proof });
        const publicKey = `${namespacePrefix}blog:scenario-a`;
        const protectedKey = `${namespacePrefix}session:protected`;
        const foreignKey = 'foreign:blog:protected';
        redis('SET', protectedKey, 'keep');
        redis('SET', foreignKey, 'keep');
        for (let cycle = 0; cycle < 2; cycle += 1)
        {
            assert.deepEqual(await errors(await reset()), []);
            sql("INSERT INTO lifecycle_probe VALUES (2, 'scenario-a-residue');");
            redis('SET', publicKey, 'residue');
            const summary = path.join(directory, 'summary.json');
            fs.writeFileSync(summary, '{"status":"ok"}\n');
            fs.rmSync(summary);
            const afterSummaryOnly = await observeOrdinaryRuntimeResourceState({ topology, runId });
            const refusal = ordinaryRuntimeResourceStateErrors({ action, topology,
                observation: { resourceState: afterSummaryOnly } });
            assert.ok(refusal.some((error) => error.includes('database schema/rows/sequences')));
            assert.ok(refusal.some((error) => error.includes('public cache reset left keys')));
            const proof = await reset();
            const databaseRefusal = await errors(proof);
            assert.ok(databaseRefusal.some((error) => error.includes('database schema/rows/sequences')));
            assert.equal(proof.after.publicKeyCount, 0);
            // Only the test restores its deliberate mutation; the online lifecycle remains readonly.
            sql('DELETE FROM lifecycle_probe WHERE id = 2;');
            assert.deepEqual(await errors(await reset()), []);
            evidence.nativeControls.push({ cycle, afterSummaryOnly, refusal, cacheReset: proof, databaseRefusal });
        }
        sql("UPDATE lifecycle_probe SET value = 'same-count-mutation' WHERE id = 1;");
        assert.notEqual(readDockerPostgresqlDatabaseState({ container: ids.postgres }).stateDigest,
            topology.resourceState.postgres.stateDigest, 'same-count row mutation must be detected');
        sql("UPDATE lifecycle_probe SET value = 'fixture' WHERE id = 1;");
        sql("SELECT nextval('lifecycle_sequence');");
        assert.notEqual(readDockerPostgresqlDatabaseState({ container: ids.postgres }).stateDigest,
            topology.resourceState.postgres.stateDigest, 'sequence mutation must be detected');
        evidence.nativeControls.push({ sameCountRowMutation: 'rejected', sequenceMutation: 'rejected' });
        redis('SET', publicKey, 'cleanup-negative');
        await assert.rejects(() => resetDockerPublicCache({ container: ids.redis, runId: 'foreign-run',
            namespace, namespacePrefix }), /ownership changed/u);
        assert.equal(redis('GET', publicKey), 'cleanup-negative');
        // Real Redis remains the observer; only DEL is refused by a negative transport control.
        const actualDocker = execFileSync('which', ['docker'], { encoding: 'utf8' }).trim();
        const originalPath = process.env.PATH;
        const transportDirectory = path.join(directory, 'negative-transport');
        fs.mkdirSync(transportDirectory);
        const transport = path.join(transportDirectory, 'docker');
        fs.writeFileSync(transport, `#!${process.execPath}\nconst { spawnSync } = require('node:child_process');\nconst args = process.argv.slice(2);\nif (args[0] === 'exec' && args.includes('redis-cli') && args.includes('DEL')) { process.stdout.write('0\\n'); } else { const result = spawnSync(${JSON.stringify(actualDocker)}, args, { stdio: 'inherit' }); process.exit(result.status ?? 1); }\n`, { mode: 0o700 });
        // A diagnostic identity has no admitted backend or precondition receipt.
        // Exercise the real action anyway: it must attempt owned cleanup and remain failed.
        const fixture = createFixture(context);
        fixture.identity = sealDocument({ ...fixture.identity, runId,
            fixture: { status: 'complete', topology: { content: topology } } });
        fs.writeFileSync(path.join(fixture.root, fixture.identityReference.path),
            `${JSON.stringify(fixture.identity)}\n`);
        fixture.environment.FSUSBLOG_RELEASE_RELIABILITY_RUN_ID = runId;
        fixture.environment.FSUSBLOG_RELEASE_RELIABILITY_SCENARIO_ID = 'release-soak-min';
        fixture.environment.FSUSBLOG_RELEASE_RELIABILITY_IDENTITY_DIGEST = fixture.identity.contentDigest;
        const cleanupAction = () => runLifecycleAction({ actionId: 'soak-observe-final-runtime-state',
            repositoryRoot: fixture.root, environment: fixture.environment });
        let falseDeletion;
        try
        {
            process.env.PATH = `${transportDirectory}${path.delimiter}${originalPath}`;
            falseDeletion = await reset();
            assert.equal(falseDeletion.status, 'failed');
            assert.equal(falseDeletion.after.publicKeyCount, 1);
            const failedCleanup = await cleanupAction();
            assert.equal(failedCleanup.status, 'failed');
            assert.equal(failedCleanup.operation.publicCacheReset.status, 'failed');
            evidence.nativeControls.push({ failedCleanupAction: failedCleanup });
        }
        finally
        {
            process.env.PATH = originalPath;
        }
        evidence.nativeControls.push({ successfulCommandWithResidue: falseDeletion });
        const safeCleanup = await cleanupAction();
        assert.equal(safeCleanup.operation.publicCacheReset.status, 'complete');
        assert.equal(safeCleanup.status, 'failed');
        assert.ok(safeCleanup.finalObservation.failures.some((value) => value.includes('runtime baseline receipt is unavailable')));
        evidence.nativeControls.push({ missingBaselineSafeCleanupAction: safeCleanup });
        assert.equal((await reset()).status, 'complete');
        assert.equal((await reset()).deleted.length, 0, 'repeated cleanup must be idempotent');
        assert.equal(redis('GET', protectedKey), 'keep');
        assert.equal(redis('GET', foreignKey), 'keep');
        assert.equal((await readDockerPublicCacheState({ container: ids.redis, namespacePrefix })).publicKeyCount, 0);
        evidence.nativeControls.push({ wrongOwner: 'rejected', repeatedCleanup: 'passed', protectedKeys: 'unchanged' });
        evidence.status = 'diagnostic-passed';
    }
    catch (error)
    {
        evidence.status = 'failed';
        evidence.error = error.message;
        throw error;
    }
    finally
    {
        let cleanupFailure = false;
        for (const [kind, id] of Object.entries(ids))
        {
            try
            {
                const [owner] = JSON.parse(docker('inspect', id));
                assert.equal(owner.Config.Labels['io.fsusblog.test.run-id'], runId);
                assert.equal(owner.Config.Labels['io.fsusblog.test.namespace'], namespace);
                docker('rm', '-f', '-v', id);
                let absent = false;
                try
                {
                    docker('inspect', id);
                }
                catch
                {
                    absent = true;
                }
                assert.equal(absent, true);
                evidence.cleanup.push({ kind, id, absent });
            }
            catch (error)
            {
                cleanupFailure = true;
                evidence.cleanup.push({ kind, id, error: error.message });
            }
        }
        evidence.finishedAt = new Date().toISOString();
        if (cleanupFailure)
        {
            evidence.status = 'failed';
        }
        const file = path.join(directory, 'native-observation.json');
        fs.writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
        console.log(`native lifecycle diagnostic evidence: ${file}`);
        assert.equal(cleanupFailure, false, 'every task-private container must be confirmed absent');
    }
});
