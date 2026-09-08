import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    runPhysicalExecution
} from '../../tools/test/physical-execution-process-tree.mjs';
import {
    executeLifecycleActionPlan,
    executeRegisteredLifecycleAction
} from '../../tools/test/release-reliability-lifecycle-actions.mjs';
import {
    digestValue,
    sealDocument
} from '../../tools/test/release-reliability-receipt.mjs';
import {
    verifyLifecycleActionReceipt
} from '../../tools/test/verify-release-reliability-lifecycle-action.mjs';

const invocationId = 'fixture-invocation';
const runId = 'fixture-run';
const scenarioId = 'release-fixture-scenario';
const sourceCommit = 'a'.repeat(40);
const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../..'
);
const actionReceiptSchema =
    'fsusblog.release-reliability-lifecycle-action-receipt.v2';
const fixtureSource = String.raw`
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
const canonical = value => Array.isArray(value)
  ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
    : value;
const seal = value => {
  const document = { ...value, contentDigest: null };
  const { contentDigest, ...content } = document;
  document.contentDigest = 'sha256:' + createHash('sha256')
    .update(JSON.stringify(canonical(content))).digest('hex');
  return document;
};
const [mode, receiptPath, phase, stateDomain, schema, operationKind] = process.argv.slice(2);
if (mode === 'nonzero') process.exit(19);
if (mode === 'log-only') {
  console.log('status ok complete');
  process.exit(0);
}
if (mode === 'timeout') {
  setTimeout(() => process.exit(0), 30000);
} else {
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  const identity = JSON.parse(
    fs.readFileSync(process.env.FSUSBLOG_RELEASE_RELIABILITY_IDENTITY_PATH, 'utf8')
  );
  let document;
  if (phase === 'measurement') {
    document = {
      schema,
      status: mode === 'failed-status' ? 'failed' : 'ok',
      releaseReliability: {
        invocationId: process.env.FSUSBLOG_RELEASE_RELIABILITY_INVOCATION_ID,
        runId: process.env.FSUSBLOG_RELEASE_RELIABILITY_RUN_ID,
        scenarioId: process.env.FSUSBLOG_RELEASE_RELIABILITY_SCENARIO_ID,
        identityContentDigest: identity.contentDigest,
        sourceState: identity.sourceState,
        buildContentDigest: identity.build.contentDigest
      }
    };
  } else {
    const after = { fixtureState: 'observed' };
    document = seal({
      schema,
      status: mode === 'failed-status' ? 'failed' : 'passed',
      actionId: process.env.FSUSBLOG_RELEASE_RELIABILITY_ACTION_ID,
      phase,
      scenarioId: process.env.FSUSBLOG_RELEASE_RELIABILITY_SCENARIO_ID,
      invocationId: mode === 'wrong-identity'
        ? 'other-invocation'
        : process.env.FSUSBLOG_RELEASE_RELIABILITY_INVOCATION_ID,
      runId: process.env.FSUSBLOG_RELEASE_RELIABILITY_RUN_ID,
      identity: {
        path: process.env.FSUSBLOG_RELEASE_RELIABILITY_IDENTITY_PATH,
        contentDigest: identity.contentDigest
      },
      stateDomains: [stateDomain],
      operation: {
        kind: operationKind,
        deleted: []
      },
      observations: {
        before: { fixtureState: 'before' },
        after
      },
      finalObservation: {
        status: 'passed',
        postStateDigest: seal({ state: after }).contentDigest,
        failures: []
      },
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString()
    });
  }
  fs.writeFileSync(receiptPath, JSON.stringify(document));
}
`;

function action({
    actionId,
    phase,
    mode = 'success',
    timeoutMs = 5000
})
{
    const measurement = phase === 'measurement';
    const receiptPath = measurement
        ? '.tmp/measurement.json'
        : `.tmp/release-reliability/{invocationId}/lifecycle/{scenarioId}/${actionId}.json`;
    return {
        actionId,
        scenarioId,
        phase,
        operation: measurement ? 'run-measurement' : 'fixture-observation',
        executable: process.execPath,
        args: [
            '{fixtureSource}',
            mode,
            receiptPath,
            phase,
            'fixture.public-content',
            measurement ? 'fsusblog.fixture-measurement.v1' : actionReceiptSchema,
            measurement ? 'run-measurement' : 'fixture-observation'
        ],
        env: {},
        cwd: '.',
        expectedReceiptPath: receiptPath,
        expectedReceiptSchema: measurement
            ? 'fsusblog.fixture-measurement.v1'
            : actionReceiptSchema,
        requiredFields: measurement
            ? ['releaseReliability', 'schema', 'status']
            : [
                'actionId',
                'contentDigest',
                'finalObservation',
                'finishedAt',
                'invocationId',
                'phase',
                'runId',
                'scenarioId',
                'schema',
                'startedAt',
                'stateDomains',
                'status'
            ],
        passStatusValues: [measurement ? 'ok' : 'passed'],
        timeoutPolicy: { timeoutMs, terminateGraceMs: 10 },
        stateDomains: ['fixture.public-content'],
        safeAfterFailure: phase === 'reset-after'
    };
}

function createFixture(context)
{
    const root = fs.mkdtempSync(
        path.join(os.tmpdir(), 'fsusblog-release-reliability-action-executor-')
    );
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const producer = path.join(root, 'action-producer.mjs');
    fs.writeFileSync(producer, fixtureSource);
    const policyRelativePath =
        'config/testing/physical-execution-process-policy.json';
    const policyBytes = fs.readFileSync(
        path.join(repositoryRoot, policyRelativePath)
    );
    fs.mkdirSync(path.join(root, 'config/testing'), { recursive: true });
    fs.writeFileSync(path.join(root, policyRelativePath), policyBytes);
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
        build: { contentDigest: `sha256:${'c'.repeat(64)}` },
        fixture: { status: 'complete' },
        policy: {
            physicalExecution: {
                status: 'complete',
                path: policyRelativePath,
                fileDigest: bytesDigest(policyBytes)
            }
        }
    });
    const identityRelativePath =
        `.tmp/release-reliability/${invocationId}/identity.json`;
    const identityFile = path.join(root, identityRelativePath);
    fs.mkdirSync(path.dirname(identityFile), { recursive: true });
    fs.writeFileSync(identityFile, JSON.stringify(identity));
    const scenario = {
        id: scenarioId,
        command: {
            executable: process.execPath,
            args: [],
            env: {},
            cwd: '.'
        },
        authoritativeEvidence: {
            path: '.tmp/measurement.json',
            expectedSchema: {
                schema: 'fsusblog.fixture-measurement.v1',
                required: ['releaseReliability', 'schema', 'status'],
                passStatusValues: ['ok']
            }
        },
        isolation: {
            lifecycle: {
                preconditions: ['fixture-precondition'],
                resetsBefore: ['fixture-reset-before'],
                measurement: 'fixture-measurement',
                postconditions: ['fixture-postcondition'],
                resetsAfter: ['fixture-reset-after']
            }
        }
    };
    return {
        root,
        producer,
        identity,
        identityReference: {
            path: identityRelativePath,
            contentDigest: identity.contentDigest
        },
        environment: {
            HOME: os.tmpdir(),
            PATH: process.env.PATH ?? path.dirname(process.execPath),
            FSUSBLOG_RELEASE_RELIABILITY_INVOCATION_ID: invocationId,
            FSUSBLOG_RELEASE_RELIABILITY_RUN_ID: runId,
            FSUSBLOG_RELEASE_RELIABILITY_SCENARIO_ID: scenarioId,
            FSUSBLOG_RELEASE_RELIABILITY_IDENTITY_PATH: identityRelativePath,
            FSUSBLOG_RELEASE_RELIABILITY_IDENTITY_DIGEST: identity.contentDigest
        },
        scenario
    };
}

function contractsFor(fixture, modes = {})
{
    const actions = [
        action({
            actionId: 'fixture-precondition',
            phase: 'precondition',
            mode: modes.precondition
        }),
        action({
            actionId: 'fixture-reset-before',
            phase: 'reset-before',
            mode: modes.resetBefore
        }),
        action({
            actionId: 'fixture-measurement',
            phase: 'measurement',
            mode: modes.measurement
        }),
        action({
            actionId: 'fixture-postcondition',
            phase: 'postcondition',
            mode: modes.postcondition
        }),
        action({
            actionId: 'fixture-reset-after',
            phase: 'reset-after',
            mode: modes.resetAfter
        })
    ];
    for (const candidate of actions)
    {
        candidate.args[0] = fixture.producer;
    }
    return { actions: new Map(actions.map((candidate) => [candidate.actionId, candidate])) };
}

function executePlan(fixture, modes = {})
{
    return executeLifecycleActionPlan({
        contracts: contractsFor(fixture, modes),
        scenario: fixture.scenario,
        repositoryRoot: fixture.root,
        invocationId,
        runId,
        identity: fixture.identity,
        identityReference: fixture.identityReference,
        actionEnvironment: {
            ...fixture.environment,
            FSUSBLOG_RELEASE_RELIABILITY_ATTEMPT_ID: 'attempt-1'
        },
        measurementEnvironment: fixture.environment,
        spawnProcess: spawn,
        physicalExecution: fixturePhysicalExecution
    });
}

function fixturePhysicalExecution(options)
{
    return runPhysicalExecution({
        ...options,
        spawnProcess: (...args) => spawn(...args)
    });
}

function bytesDigest(bytes)
{
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

test('real subprocess actions execute in fixed order and bind only raw verified receipts', async (context) =>
{
    const fixture = createFixture(context);
    const result = await executePlan(fixture);
    assert.equal(result.status, 'passed', JSON.stringify(result.actions, null, 2));
    assert.deepEqual(
        result.actions.map(({ actionId }) => actionId),
        [
            'fixture-precondition',
            'fixture-reset-before',
            'fixture-measurement',
            'fixture-postcondition',
            'fixture-reset-after'
        ]
    );
    assert.equal(result.verifiedActionReceipts.length, 5);
    assert.ok(result.verifiedActionReceipts.every(
        (reference) => reference.bytesDigest.startsWith('sha256:')
    ));
    assert.equal(result.resetPostObservation.status, 'passed');
    assert.equal(result.finalPostObservation.status, 'passed');
    assert.equal(result.firstFailure, null);
    assert.deepEqual(result.cleanupFailures, []);
});

test('exit zero with a missing receipt and log keywords without structured receipt fail', async (context) =>
{
    for (const mode of ['log-only'])
    {
        const fixture = createFixture(context);
        const result = await executePlan(fixture, { precondition: mode });
        assert.equal(result.status, 'failed');
        assert.match(result.firstFailure.message, /receipt is missing/u);
        assert.equal(
            result.actions.find((record) => record.phase === 'measurement').status,
            'not-run'
        );
    }
});

test('receipt status and run identity are verified independently of exit code', async (context) =>
{
    for (const [mode, pattern] of [
        ['failed-status', /status is not passing/u],
        ['wrong-identity', /run\/invocation identity mismatch/u]
    ])
    {
        const fixture = createFixture(context);
        const result = await executePlan(fixture, { precondition: mode });
        assert.equal(result.status, 'failed');
        assert.match(result.firstFailure.message, pattern);
    }
});

test('timeout deletes a preexisting receipt and cannot consume a later stale receipt', async (context) =>
{
    const fixture = createFixture(context);
    const contracts = contractsFor(fixture, { precondition: 'timeout' });
    const timedAction = contracts.actions.get('fixture-precondition');
    timedAction.timeoutPolicy.timeoutMs = 30;
    const receiptPath = path.join(
        fixture.root,
        `.tmp/release-reliability/${invocationId}/lifecycle/${scenarioId}/fixture-precondition.json`
    );
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
    fs.writeFileSync(receiptPath, '{"status":"passed","stale":true}');
    const record = await executeRegisteredLifecycleAction({
        action: timedAction,
        scenario: fixture.scenario,
        repositoryRoot: fixture.root,
        invocationId,
        runId,
        identity: fixture.identity,
        identityReference: fixture.identityReference,
        actionEnvironment: fixture.environment,
        measurementEnvironment: fixture.environment,
        spawnProcess: spawn,
        physicalExecution: fixturePhysicalExecution
    });
    assert.equal(record.status, 'timed-out');
    assert.equal(record.timedOut, true);
    assert.equal(fs.existsSync(receiptPath), false);
    fs.writeFileSync(receiptPath, '{"status":"passed","stale":true}');
    assert.throws(
        () => verifyLifecycleActionReceipt({
            repositoryRoot: fixture.root,
            action: timedAction,
            scenario: fixture.scenario,
            invocationId,
            runId,
            identity: fixture.identity,
            identityReference: fixture.identityReference,
            processOutcome: { timedOut: true }
        }),
        /timed out action/u
    );
});

test('producer first failure remains immutable while safe reset-after executes and fails separately', async (context) =>
{
    const fixture = createFixture(context);
    const result = await executePlan(fixture, {
        measurement: 'nonzero',
        resetAfter: 'failed-status'
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.firstFailure.actionId, 'fixture-measurement');
    assert.equal(result.firstFailure.kind, 'failed');
    assert.equal(result.cleanupFailures.length, 1);
    assert.equal(result.cleanupFailures[0].actionId, 'fixture-reset-after');
    assert.equal(
        result.actions.find((record) => record.actionId === 'fixture-postcondition').status,
        'not-run'
    );
    assert.equal(
        result.actions.find((record) => record.actionId === 'fixture-reset-after').status,
        'failed'
    );
});

test('cleanup failure makes an otherwise passing producer fail qualification', async (context) =>
{
    const fixture = createFixture(context);
    const result = await executePlan(fixture, {
        resetAfter: 'failed-status'
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.firstFailure.actionId, 'fixture-reset-after');
    assert.equal(result.cleanupFailures.length, 1);
});

test('raw receipt bytes tampering is rejected against the sealed reference digest', async (context) =>
{
    const fixture = createFixture(context);
    const contracts = contractsFor(fixture);
    const candidate = contracts.actions.get('fixture-precondition');
    const record = await executeRegisteredLifecycleAction({
        action: candidate,
        scenario: fixture.scenario,
        repositoryRoot: fixture.root,
        invocationId,
        runId,
        identity: fixture.identity,
        identityReference: fixture.identityReference,
        actionEnvironment: fixture.environment,
        measurementEnvironment: fixture.environment,
        spawnProcess: spawn,
        physicalExecution: fixturePhysicalExecution
    });
    assert.equal(record.status, 'passed', record.failure);
    const receiptPath = path.join(fixture.root, record.receipt.path);
    fs.appendFileSync(receiptPath, '\n');
    assert.throws(
        () => verifyLifecycleActionReceipt({
            repositoryRoot: fixture.root,
            action: candidate,
            scenario: fixture.scenario,
            invocationId,
            runId,
            identity: fixture.identity,
            identityReference: fixture.identityReference,
            expectedBytesDigest: record.receipt.bytesDigest
        }),
        /bytes digest mismatch/u
    );
});

test('stale passed postcondition cannot substitute an unexecuted current action', async (context) =>
{
    const fixture = createFixture(context);
    const passed = await executePlan(fixture);
    assert.equal(passed.status, 'passed');
    const stalePostcondition = path.join(
        fixture.root,
        passed.actions.find(
            (record) => record.actionId === 'fixture-postcondition'
        ).receipt.path
    );
    assert.equal(fs.existsSync(stalePostcondition), true);

    const result = await executePlan(fixture, { postcondition: 'log-only' });
    const postcondition = result.actions.find(
        (record) => record.actionId === 'fixture-postcondition'
    );
    assert.equal(result.status, 'failed');
    assert.equal(postcondition.status, 'failed');
    assert.match(postcondition.failure, /receipt is missing/u);
    assert.equal(
        result.actions.find(
            (record) => record.actionId === 'fixture-reset-after'
        ).status,
        'passed'
    );
});

test('verified data-scale owner replaces shared ambient targets before measurement', async (context) =>
{
    const fixture = createFixture(context);
    const dataScaleRunId = 'data-scale-run-1';
    const seedPath = `.tmp/${dataScaleRunId}/seed.json`;
    const seedBytes = Buffer.from('{"status":"seeded"}\n');
    fs.mkdirSync(path.dirname(path.join(fixture.root, seedPath)), {
        recursive: true
    });
    fs.writeFileSync(path.join(fixture.root, seedPath), seedBytes);
    const ownerPath = `.tmp/${dataScaleRunId}/runtime.json`;
    const dataScaleIdentity = {
        ...fixture.identity,
        build: {
            ...fixture.identity.build,
            imageDigest: `sha256:${'2'.repeat(64)}`
        }
    };
    const owner = sealDocument({
        schema: 'fsusblog.data-scale-runtime.v2',
        dataScaleRunId,
        parentSchedulerRunId: runId,
        invocationId,
        attemptId: 'attempt-1',
        sourceCommit,
        worktreeFingerprint: fixture.identity.sourceState.worktreeFingerprint,
        buildReceiptDigest: dataScaleIdentity.build.contentDigest,
        imageDigest: dataScaleIdentity.build.imageDigest,
        fixtureIdentityDigest: digestValue(dataScaleIdentity.fixture),
        namespace: 'dedicated-namespace',
        network: { id: 'a'.repeat(64), name: 'dedicated-network' },
        permissionHelper: {
            name: 'dedicated-permission-helper',
            postExists: false
        },
        lifecycle: {
            start: 'complete',
            reset: 'complete',
            readiness: 'complete',
            postcondition: 'pending'
        },
        postgres: {
            containerId: 'e'.repeat(64),
            imageDigest: `sha256:${'3'.repeat(64)}`,
            volumeId: 'dedicated-postgres-volume',
            database: 'fsusblog'
        },
        redis: {
            containerId: 'f'.repeat(64),
            imageDigest: `sha256:${'4'.repeat(64)}`,
            volumeId: 'dedicated-redis-volume'
        },
        backend: {
            pidOrContainerId: process.pid,
            startTicks: '12345',
            baseUrl: 'http://127.0.0.1:34567',
            executableOrImageDigest: `sha256:${'5'.repeat(64)}`
        },
        connections: {
            postgres: {
                applicationName: `FsusBlogDataScale-${dataScaleRunId}`,
                backendAddress: '172.24.0.4',
                database: 'fsusblog',
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
        envManifestDigest: `sha256:${'6'.repeat(64)}`,
        seedReceiptPath: seedPath,
        seedReceiptDigest: bytesDigest(seedBytes),
        seedSummary: {
            status: 'ok', tier: 'scale-m', namespace: 'dedicated-namespace',
            declared: { articles: 10000, comments: 100000 },
            expected: { articles: 10000, comments: 100000 },
            observed: { articles: 10000, comments: 100000 }
        },
        createdAt: new Date().toISOString()
    });
    fs.writeFileSync(path.join(fixture.root, ownerPath), JSON.stringify(owner));

    const scenario = {
        ...fixture.scenario,
        id: 'release-data-scale-m',
        isolation: {
            lifecycle: {
                preconditions: ['data-precondition'],
                resetsBefore: ['data-reset-before'],
                measurement: 'data-measurement',
                postconditions: ['data-postcondition'],
                resetsAfter: ['data-reset-after']
            }
        }
    };
    const actions = [
        ['data-precondition', 'precondition'],
        ['data-reset-before', 'reset-before'],
        ['data-measurement', 'measurement'],
        ['data-postcondition', 'postcondition'],
        ['data-reset-after', 'reset-after']
    ].map(([actionId, phase]) => ({
        actionId,
        phase,
        ownerReceipt: phase === 'precondition'
            ? 'data-scale-runtime'
            : undefined,
        expectedReceiptPath:
            `.tmp/release-reliability/{invocationId}/lifecycle/{scenarioId}/${actionId}.json`
    }));
    const contracts = {
        actions: new Map(actions.map((candidate) => [
            candidate.actionId,
            candidate
        ]))
    };
    let measurementSpawnCount = 0;
    let boundMeasurementEnvironment = null;
    const executeAction = async ({ action, measurementEnvironment }) =>
    {
        const timestamp = new Date().toISOString();
        let receipt = null;
        if (action.phase === 'precondition')
        {
            const adapterRelative =
                `.tmp/release-reliability/${invocationId}/lifecycle/${scenario.id}/${action.actionId}.json`;
            const adapter = {
                ownerReceipt: {
                    path: ownerPath,
                    bytesDigest: bytesDigest(
                        fs.readFileSync(path.join(fixture.root, ownerPath))
                    )
                }
            };
            const adapterBytes = Buffer.from(JSON.stringify(adapter));
            const adapterAbsolute = path.join(fixture.root, adapterRelative);
            fs.mkdirSync(path.dirname(adapterAbsolute), { recursive: true });
            fs.writeFileSync(adapterAbsolute, adapterBytes);
            receipt = {
                path: adapterRelative,
                bytesDigest: bytesDigest(adapterBytes)
            };
        }
        if (action.phase === 'measurement')
        {
            measurementSpawnCount += 1;
            boundMeasurementEnvironment = measurementEnvironment;
        }
        return {
            actionId: action.actionId,
            phase: action.phase,
            status: 'passed',
            startedAt: timestamp,
            finishedAt: timestamp,
            durationMs: 0,
            exitCode: 0,
            signal: null,
            timedOut: false,
            receipt,
            finalObservation: {
                status: 'passed',
                postStateDigest: `sha256:${'7'.repeat(64)}`
            },
            failure: null
        };
    };
    const result = await executeLifecycleActionPlan({
        contracts,
        scenario,
        repositoryRoot: fixture.root,
        invocationId,
        runId,
        identity: dataScaleIdentity,
        identityReference: fixture.identityReference,
        actionEnvironment: {
            ...fixture.environment,
            FSUSBLOG_RELEASE_RELIABILITY_ATTEMPT_ID: 'attempt-1'
        },
        measurementEnvironment: {
            ...fixture.environment,
            FSUSBLOG_DEBUG_BACKEND_URL: 'http://127.0.0.1:24501',
            FSUSBLOG_POSTGRES_CONTAINER_NAME: 'shared-postgres',
            FSUSBLOG_REDIS_CONTAINER_NAME: 'shared-redis',
            FSUSBLOG_TEST_NAMESPACE: 'shared',
            FSUSBLOG_TEST_RUN_ID: runId
        },
        executeAction,
        dataScaleLivenessVerifier: async () => ({ status: 'ready' })
    });
    assert.equal(result.status, 'passed');
    assert.equal(measurementSpawnCount, 1);
    assert.equal(
        boundMeasurementEnvironment.FSUSBLOG_DEBUG_BACKEND_URL,
        owner.backend.baseUrl
    );
    assert.equal(
        boundMeasurementEnvironment.FSUSBLOG_POSTGRES_CONTAINER_NAME,
        owner.postgres.containerId
    );

    measurementSpawnCount = 0;
    const deadOwner = await executeLifecycleActionPlan({
        contracts,
        scenario,
        repositoryRoot: fixture.root,
        invocationId,
        runId,
        identity: dataScaleIdentity,
        identityReference: fixture.identityReference,
        actionEnvironment: {
            ...fixture.environment,
            FSUSBLOG_RELEASE_RELIABILITY_ATTEMPT_ID: 'attempt-1'
        },
        measurementEnvironment: fixture.environment,
        executeAction,
        dataScaleLivenessVerifier: async () =>
        {
            throw new Error('dedicated runtime owner exited');
        }
    });
    assert.equal(deadOwner.status, 'failed');
    assert.equal(deadOwner.firstFailure.phase, 'measurement');
    assert.equal(deadOwner.measurementRecord.producerSpawned, false);
    assert.equal(measurementSpawnCount, 0);
});

test('old runtime URL or ambient service identity blocks measurement spawn', async (context) =>
{
    const fixture = createFixture(context);
    const namespace = 'qualified-runtime';
    const scenario = {
        ...fixture.scenario,
        id: 'release-soak-min',
        isolation: {
            lifecycle: {
                preconditions: ['runtime-precondition'],
                resetsBefore: ['runtime-reset-before'],
                measurement: 'runtime-measurement',
                postconditions: ['runtime-postcondition'],
                resetsAfter: ['runtime-reset-after']
            }
        }
    };
    const identity = {
        ...fixture.identity,
        fixture: {
            namespace,
            topology: {
                content: {
                    postgres: { instance: 'a'.repeat(64) },
                    redis: { instance: 'b'.repeat(64) },
                    runtime: {
                        backendContainer: {
                            id: 'c'.repeat(64),
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
    const actions = [
        ['runtime-precondition', 'precondition', 'observe-runtime'],
        ['runtime-reset-before', 'reset-before', 'prepare-evidence-files'],
        ['runtime-measurement', 'measurement', 'run-measurement'],
        ['runtime-postcondition', 'postcondition', 'observe-runtime'],
        ['runtime-reset-after', 'reset-after', 'observe-runtime']
    ].map(([actionId, phase, operation]) => ({
        actionId,
        phase,
        operation,
        expectedReceiptPath:
            `.tmp/release-reliability/{invocationId}/lifecycle/{scenarioId}/${actionId}.json`
    }));
    const contracts = {
        actions: new Map(actions.map((candidate) => [
            candidate.actionId,
            candidate
        ]))
    };
    let measurementSpawnCount = 0;
    const executeAction = async ({ action }) =>
    {
        if (action.phase === 'measurement')
        {
            measurementSpawnCount += 1;
        }
        const timestamp = new Date().toISOString();
        return {
            actionId: action.actionId,
            phase: action.phase,
            status: 'passed',
            startedAt: timestamp,
            finishedAt: timestamp,
            durationMs: 0,
            exitCode: 0,
            signal: null,
            timedOut: false,
            receipt: null,
            finalObservation: {
                status: 'passed',
                postStateDigest: `sha256:${'8'.repeat(64)}`
            },
            failure: null
        };
    };
    const result = await executeLifecycleActionPlan({
        contracts,
        scenario,
        repositoryRoot: fixture.root,
        invocationId,
        runId,
        identity,
        identityReference: fixture.identityReference,
        actionEnvironment: fixture.environment,
        measurementEnvironment: {
            ...fixture.environment,
            FSUSBLOG_DEBUG_BACKEND_URL: 'http://127.0.0.1:7568',
            FSUSBLOG_POSTGRES_CONTAINER_NAME:
                `fsusblog-test-postgres-${namespace}`,
            FSUSBLOG_REDIS_CONTAINER_NAME:
                `fsusblog-test-redis-${namespace}`,
            FSUSBLOG_TEST_NAMESPACE: namespace,
            FSUSBLOG_TEST_RUN_ID: runId
        },
        executeAction
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.firstFailure.phase, 'measurement');
    assert.match(result.firstFailure.message, /not bound to the verified run identity/u);
    assert.equal(measurementSpawnCount, 0);
});
