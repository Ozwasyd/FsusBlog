import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const {
    executeScenario,
    executeScenarios,
    prepareInvocationOutputs,
    validateCatalog
} = await import(pathToFileURL(path.join(repositoryRoot, 'tools/test/run-release-reliability-scenarios.mjs')).href);
const {
    sealDocument
} = await import(pathToFileURL(path.join(repositoryRoot, 'tools/test/release-reliability-receipt.mjs')).href);
const { createTerminalEvents } = await import(
    pathToFileURL(path.join(repositoryRoot, 'tools/test/release-reliability-terminal.mjs')).href
);

const canonicalIds = [
    'release-soak-min',
    'release-load-peak',
    'release-load-burst',
    'release-data-scale-m',
    'release-mutation-critical-slice',
    'release-memory-leak-budget',
    'release-open-handle-budget'
];
const invocationId = 'fixture-invocation';
const runId = 'fixture-run';
const repositoryCatalog = JSON.parse(fs.readFileSync(
    path.join(repositoryRoot, 'config/testing/release-reliability-scenario-catalog.json'),
    'utf8'
));
const fixtureAmbientEnvironment = {
    HOME: process.env.HOME ?? os.tmpdir(),
    PATH: process.env.PATH ?? path.dirname(process.execPath),
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 0}`,
    FSUSBLOG_DEBUG_BACKEND_URL: 'http://127.0.0.1:24501',
    FSUSBLOG_POSTGRES_CONTAINER_NAME: 'fixture-postgres',
    FSUSBLOG_REDIS_CONTAINER_NAME: 'fixture-redis',
    FSUSBLOG_TEST_NAMESPACE: 'fixture-namespace',
    FSUSBLOG_TEST_RUN_ID: runId,
    FSUSBLOG_TEST_SOURCE_COMMIT: 'a'.repeat(40),
    FSUSBLOG_TEST_SOURCE_FINGERPRINT: `sha256:${'b'.repeat(64)}`
};
const producerSource = `
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
const canonicalize = value => Array.isArray(value)
    ? value.map(canonicalize)
    : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]))
        : value;
const seal = value => {
    const document = { ...value, contentDigest: null };
    const { contentDigest, ...content } = document;
    document.contentDigest = 'sha256:' + createHash('sha256').update(JSON.stringify(canonicalize(content))).digest('hex');
    return document;
};
const [
    kind,
    mode,
    receiptPath,
    scenarioId,
    expectedResourcePid,
    expectedContainerId,
    phase = 'measurement',
    operationKind = 'run-measurement'
] = process.argv.slice(2);
if (kind === 'measurement') {
    console.log('producer-stdout-sentinel');
    console.error('producer-stderr-sentinel');
}
if (process.env.FSUSBLOG_RELEASE_RELIABILITY_SCENARIO_ID !== scenarioId) process.exit(23);
if (process.env.FSUSBLOG_RELEASE_RESOURCE_PID !== expectedResourcePid) process.exit(29);
if (process.env.FSUSBLOG_RELEASE_RESOURCE_CONTAINER_ID !== expectedContainerId) process.exit(31);
if (kind === 'measurement' && mode === 'nonzero') process.exit(19);
if (kind === 'measurement' && mode === 'signal') process.kill(process.pid, 'SIGTERM');
if (kind === 'measurement' && mode === 'missing') process.exit(0);
const identity = JSON.parse(fs.readFileSync(process.env.FSUSBLOG_RELEASE_RELIABILITY_IDENTITY_PATH, 'utf8'));
const binding = {
    invocationId: process.env.FSUSBLOG_RELEASE_RELIABILITY_INVOCATION_ID,
    runId: process.env.FSUSBLOG_RELEASE_RELIABILITY_RUN_ID,
    scenarioId: process.env.FSUSBLOG_RELEASE_RELIABILITY_SCENARIO_ID,
    identityContentDigest: identity.contentDigest,
    sourceState: identity.sourceState,
    buildContentDigest: identity.build.contentDigest
};
if (mode === 'wrong-invocation') binding.invocationId = 'other-invocation';
fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
if (kind === 'measurement') {
    fs.writeFileSync(receiptPath, JSON.stringify({
        schema: 'fsusblog.fixture-authoritative-evidence.v1',
        status: mode === 'product-failure' ? 'failed'
            : mode === 'noisy' ? 'infra-no-conclusion' : 'ok',
        ...(mode === 'noisy' ? { productConclusionEligible: false } : {}),
        sentinel: 'current',
        releaseReliability: binding
    }));
    if (mode === 'product-failure' || mode === 'noisy') process.exit(19);
} else {
    const after = { fixtureState: 'observed' };
    const receipt = seal({
        schema: 'fsusblog.release-reliability-lifecycle-action-receipt.v2',
        status: (mode === 'failed-lifecycle' && phase === 'reset-before')
            || (mode === 'failed-cleanup' && phase === 'reset-after')
            ? 'failed'
            : 'passed',
        actionId: process.env.FSUSBLOG_RELEASE_RELIABILITY_ACTION_ID,
        phase,
        scenarioId,
        invocationId: process.env.FSUSBLOG_RELEASE_RELIABILITY_INVOCATION_ID,
        runId: binding.runId,
        identity: {
            path: process.env.FSUSBLOG_RELEASE_RELIABILITY_IDENTITY_PATH,
            contentDigest: identity.contentDigest
        },
        stateDomains: ['fixture-state'],
        operation: { kind: operationKind },
        observations: mode === 'placeholder-lifecycle' && phase === 'precondition'
            ? null
            : {
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
    fs.writeFileSync(receiptPath, JSON.stringify(receipt));
}
`;

function createFixture()
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-release-reliability-executor-'));
    const producer = path.join(root, 'producer.mjs');
    fs.writeFileSync(producer, producerSource, 'utf8');
    const policyRelativePath =
        'config/testing/physical-execution-process-policy.json';
    const policyBytes = fs.readFileSync(
        path.join(repositoryRoot, policyRelativePath)
    );
    fs.mkdirSync(path.join(root, 'config/testing'), { recursive: true });
    fs.writeFileSync(path.join(root, policyRelativePath), policyBytes);
    const identityPath = `.tmp/release-reliability/${invocationId}/identity.json`;
    const identity = sealDocument({
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
        fixture: {
            topology: {
                content: {
                    runtime: {
                        backendContainer: {
                            id: 'd'.repeat(64),
                            hostPid: process.pid
                        }
                    }
                }
            }
        },
        policy: {
            physicalExecution: {
                status: 'complete',
                path: policyRelativePath,
                fileDigest: `sha256:${createHash('sha256')
                    .update(policyBytes).digest('hex')}`
            }
        }
    });
    fs.mkdirSync(path.dirname(path.join(root, identityPath)), { recursive: true });
    fs.writeFileSync(path.join(root, identityPath), JSON.stringify(identity));
    return {
        root,
        producer,
        identity,
        identityReference: { path: identityPath, contentDigest: identity.contentDigest }
    };
}

function removeFixture(fixture)
{
    fs.rmSync(fixture.root, { recursive: true, force: true });
}

function catalogFor(fixture, mode = 'success')
{
    return {
        schema: 'fsusblog.release-reliability-scenario-catalog.v4',
        catalogScenarioCount: canonicalIds.length,
        canonicalScenarioIds: canonicalIds,
        identityTools: ['node'],
        childEnvironmentContract: repositoryCatalog.childEnvironmentContract,
        policyBindings: repositoryCatalog.policyBindings,
        actionRegistry:
            'config/testing/release-reliability-lifecycle-action-registry.json',
        lifecycleSchema:
            'fsusblog.release-reliability-lifecycle-action-receipt.v2',
        scenarios: canonicalIds.map((id) =>
        {
            const canonicalScenario = repositoryCatalog.scenarios.find(
                (scenario) => scenario.id === id
            );
            return {
                id,
                owner: 'test-owner',
                command: {
                    executable: process.execPath,
                    args: [
                        fixture.producer,
                        'measurement',
                        mode,
                        `.tmp/evidence/${id}.json`,
                        id,
                        String(process.pid),
                        'd'.repeat(64)
                    ],
                    env: canonicalScenario.command.env,
                    inheritEnv: canonicalScenario.command.inheritEnv,
                    cwd: '.'
                },
                qualification: canonicalScenario.qualification,
                resourceClass: 'test',
                identityTools: ['node'],
                isolation: {
                    exclusiveResources: ['fixture-state'],
                    countableResources: [],
                    lifecycle: {
                        preconditions: [`${id}-fixture-precondition`],
                        resetsBefore: [`${id}-fixture-reset-before`],
                        measurement: `${id}-fixture-measurement`,
                        postconditions: [`${id}-fixture-postcondition`],
                        resetsAfter: [`${id}-fixture-reset-after`]
                    },
                    outputs: [{ id: 'authoritative-evidence', path: `.tmp/evidence/${id}.json` }]
                },
                authoritativeEvidence: {
                    path: `.tmp/evidence/${id}.json`,
                    expectedSchema: {
                        schema: 'fsusblog.fixture-authoritative-evidence.v1',
                        required: ['status', 'sentinel', 'releaseReliability'],
                        passStatusValues: ['ok']
                    }
                }
            };
        })
    };
}

function lifecycleAction({
    fixture,
    scenario,
    actionId,
    phase,
    mode
})
{
    const measurement = phase === 'measurement';
    const expectedReceiptPath = measurement
        ? scenario.authoritativeEvidence.path
        : `.tmp/release-reliability/{invocationId}/lifecycle/{scenarioId}/${actionId}.json`;
    return {
        actionId,
        scenarioId: scenario.id,
        phase,
        operation: measurement ? 'run-measurement' : 'fixture-observation',
        executable: measurement ? '$scenario.command' : process.execPath,
        args: measurement
            ? []
            : [
                fixture.producer,
                'lifecycle',
                mode,
                expectedReceiptPath,
                scenario.id,
                String(process.pid),
                'd'.repeat(64),
                phase,
                'fixture-observation'
            ],
        env: {},
        cwd: '.',
        expectedReceiptPath,
        expectedReceiptSchema: measurement
            ? scenario.authoritativeEvidence.expectedSchema.schema
            : 'fsusblog.release-reliability-lifecycle-action-receipt.v2',
        requiredFields: measurement
            ? ['releaseReliability', 'schema', 'sentinel', 'status']
            : [
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
        passStatusValues: [measurement ? 'ok' : 'passed'],
        timeoutPolicy: { timeoutMs: 5000, terminateGraceMs: 10 },
        stateDomains: ['fixture-state'],
        safeAfterFailure: phase === 'reset-after'
    };
}

function contractsFor(fixture, catalog)
{
    const actions = [];
    for (const scenario of catalog.scenarios)
    {
        const mode = scenario.command.args[2];
        for (const [actionId, phase] of [
            [scenario.isolation.lifecycle.preconditions[0], 'precondition'],
            [scenario.isolation.lifecycle.resetsBefore[0], 'reset-before'],
            [scenario.isolation.lifecycle.measurement, 'measurement'],
            [scenario.isolation.lifecycle.postconditions[0], 'postcondition'],
            [scenario.isolation.lifecycle.resetsAfter[0], 'reset-after']
        ])
        {
            actions.push(lifecycleAction({
                fixture,
                scenario,
                actionId,
                phase,
                mode
            }));
        }
    }
    return {
        actions: new Map(actions.map((action) => [action.actionId, action]))
    };
}

function executeFixtureScenario(fixture, catalog, options = {})
{
    return executeScenario({
        catalog,
        scenarioId: options.scenarioId ?? canonicalIds[0],
        evidenceClass: 'diagnostic',
        qualificationEligible: false,
        repositoryRoot: fixture.root,
        invocationId,
        runId,
        identity: options.identity ?? fixture.identity,
        identityReference: fixture.identityReference,
        spawnProcess: options.spawnProcess ?? spawn,
        physicalExecution:
            options.physicalExecution ?? fixturePhysicalExecution,
        ambientEnvironment: options.ambientEnvironment ?? fixtureAmbientEnvironment,
        lifecycleContracts: options.lifecycleContracts ?? contractsFor(fixture, catalog)
    });
}

function fixtureProcessEvidence(policy)
{
    return {
        schema: 'fsusblog.physical-execution-process-tree.v1',
        platform: process.platform,
        policy,
        authority: {
            schema: 'fsusblog.process-group-or-job-identity.v1',
            kind: 'fixture-process-group',
            platform: process.platform,
            established: true
        },
        lifecycle: [
            'created',
            'bounded-pipe-close',
            'post-observe-zero-members',
            'seal-completed-receipt'
        ],
        termination: [],
        postObservation: 'zero-members',
        processInventory: [],
        logComplete: true,
        logTruncationReason: null,
        forcedPipeClose: false,
        outputCapture: {
            maximumBytesPerStream: policy.maximumCapturedOutputBytesPerStream,
            stdoutBytes: 0,
            stderrBytes: 0,
            stdoutCapturedBytes: 0,
            stderrCapturedBytes: 0,
            stdoutTruncated: false,
            stderrTruncated: false
        },
        stdout: '',
        stderr: ''
    };
}

function fixturePhysicalExecution(options)
{
    return new Promise((resolve, reject) =>
    {
        let child;
        try
        {
            child = options.spawnProcess(
                options.command[0],
                options.command.slice(1),
                {
                    cwd: options.cwd,
                    env: options.env,
                    stdio: ['ignore', 'pipe', 'pipe']
                }
            );
        }
        catch (error)
        {
            reject(error);
            return;
        }
        if (!child || typeof child.once !== 'function')
        {
            reject(new Error('spawn did not return a child process'));
            return;
        }
        child.stdout?.on('data', (chunk) => options.stdout?.write(chunk));
        child.stderr?.on('data', (chunk) => options.stderr?.write(chunk));
        const evidence = fixtureProcessEvidence(options.policy);
        const onAbort = () => child.kill?.('SIGTERM');
        options.signal?.addEventListener('abort', onAbort, { once: true });
        child.once('error', (error) =>
        {
            options.signal?.removeEventListener('abort', onAbort);
            error.physicalExecution = evidence;
            reject(error);
        });
        child.once('close', (exitCode, signal) =>
        {
            options.signal?.removeEventListener('abort', onAbort);
            if (options.signal?.aborted)
            {
                const error = options.signal.reason;
                error.physicalExecution = evidence;
                reject(error);
                return;
            }
            if (exitCode !== 0 || signal)
            {
                const error = Object.assign(
                    new Error(signal
                        ? `command failed by signal ${signal}`
                        : `command failed with exit ${exitCode}`),
                    { exitCode, signal, physicalExecution: evidence }
                );
                reject(error);
                return;
            }
            resolve(evidence);
        });
    });
}

function fakeChild(exitCode, signal = null)
{
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    queueMicrotask(() =>
    {
        child.stdout.end();
        child.stderr.end();
        child.emit('close', exitCode, signal);
    });
    return child;
}

test('catalog requires canonical IDs and structured lifecycle/resources/outputs', () =>
{
    const fixture = createFixture();
    try
    {
        const catalog = catalogFor(fixture);
        assert.deepEqual(validateCatalog(catalog), []);
        delete catalog.scenarios[0].isolation.lifecycle.resetsBefore;
        catalog.scenarios[1].isolation.outputs = [];
        catalog.scenarios[2].isolation.exclusiveResources = [];
        const errors = validateCatalog(catalog);
        assert.ok(errors.some((error) => error.includes('lifecycle')));
        assert.ok(errors.some((error) => error.includes('outputs')));
        assert.ok(errors.some((error) => error.includes('exclusiveResources')));
    }
    finally
    {
        removeFixture(fixture);
    }
});

test('a successful scenario executes five registered actions and binds raw verified receipts', async () =>
{
    const fixture = createFixture();
    try
    {
        const result = await executeFixtureScenario(fixture, catalogFor(fixture));
        assert.equal(result.status, 'passed', result.failure);
        assert.equal(result.evidenceClass, 'diagnostic');
        assert.equal(result.qualificationEligible, false);
        assert.match(result.contentDigest, /^sha256:[0-9a-f]{64}$/u);
        assert.deepEqual(
            result.lifecycle.actions.map(({ phase }) => phase),
            [
                'precondition',
                'reset-before',
                'measurement',
                'postcondition',
                'reset-after'
            ]
        );
        assert.ok(result.lifecycle.actions.every((record) => record.status === 'passed'));
        assert.equal(result.lifecycle.verifiedActionReceipts.length, 5);
        assert.ok(result.lifecycle.verifiedActionReceipts.every(
            (reference) => /^sha256:[0-9a-f]{64}$/u.test(reference.bytesDigest)
        ));
        assert.equal(result.outputs[0].digest, result.authoritativeEvidence.digest);
        assert.match(
            fs.readFileSync(path.join(fixture.root, result.producer.stdoutLog), 'utf8'),
            /producer-stdout-sentinel/u
        );
        assert.match(
            fs.readFileSync(path.join(fixture.root, result.producer.stderrLog), 'utf8'),
            /producer-stderr-sentinel/u
        );
    }
    finally
    {
        removeFixture(fixture);
    }
});

test('placeholder, failed, missing, and wrong-invocation lifecycle/evidence fail closed', async () =>
{
    for (const mode of ['placeholder-lifecycle', 'failed-lifecycle', 'missing', 'wrong-invocation'])
    {
        const fixture = createFixture();
        try
        {
            const result = await executeFixtureScenario(fixture, catalogFor(fixture, mode));
            assert.equal(result.status, 'failed', mode);
            assert.ok(result.lifecycle.actions.some(
                (record) => record.status === 'failed'
            ), mode);
            assert.ok(result.firstFailure, mode);
            assert.equal(result.qualificationEligible, false, mode);
        }
        finally
        {
            removeFixture(fixture);
        }
    }
});

test('precondition and cleanup failures revoke correctness qualification eligibility', async () =>
{
    for (const [mode, expectedPhase] of [
        ['placeholder-lifecycle', 'precondition'],
        ['failed-cleanup', 'reset-after']
    ])
    {
        const fixture = createFixture();
        try
        {
            const catalog = catalogFor(fixture, mode);
            const result = await executeScenario({
                catalog,
                scenarioId: canonicalIds[0],
                evidenceClass: 'correctness',
                qualificationEligible: true,
                repositoryRoot: fixture.root,
                invocationId,
                runId,
                identity: fixture.identity,
                identityReference: fixture.identityReference,
                physicalExecution: fixturePhysicalExecution,
                ambientEnvironment: fixtureAmbientEnvironment,
                lifecycleContracts: contractsFor(fixture, catalog)
            });
            assert.equal(result.status, 'failed', mode);
            assert.equal(result.qualificationEligible, false, mode);
            assert.equal(result.firstFailure.phase, expectedPhase, mode);
            assert.equal(
                result.cleanupFailures.length,
                mode === 'failed-cleanup' ? 1 : 0,
                mode
            );
        }
        finally
        {
            removeFixture(fixture);
        }
    }
});

test('an incomplete identity prevents the producer from executing', async () =>
{
    const fixture = createFixture();
    try
    {
        let spawnCount = 0;
        const result = await executeFixtureScenario(fixture, catalogFor(fixture), {
            identity: { ...fixture.identity, status: 'unavailable' },
            spawnProcess: (...args) =>
            {
                spawnCount += 1;
                return spawn(...args);
            }
        });
        assert.equal(result.status, 'failed');
        assert.equal(spawnCount, 0);
        assert.match(result.failure, /identity is incomplete/u);
    }
    finally
    {
        removeFixture(fixture);
    }
});

test('stale evidence is removed and cannot pass when the producer is not spawned', async () =>
{
    const fixture = createFixture();
    try
    {
        const catalog = catalogFor(fixture);
        const stale = path.join(fixture.root, catalog.scenarios[0].authoritativeEvidence.path);
        fs.mkdirSync(path.dirname(stale), { recursive: true });
        fs.writeFileSync(stale, JSON.stringify({ status: 'ok', sentinel: 'stale' }));
        const result = await executeFixtureScenario(fixture, catalog, { spawnProcess: () => null });
        assert.equal(result.status, 'failed');
        assert.equal(fs.existsSync(stale), false);
        assert.equal(result.producerSpawned, false);
        assert.equal(result.authoritativeEvidence, null);
    }
    finally
    {
        removeFixture(fixture);
    }
});

test('nonzero exit, signal cancellation, and unavailable executable fail closed', async () =>
{
    const fixture = createFixture();
    try
    {
        const nonzero = await executeFixtureScenario(fixture, catalogFor(fixture, 'nonzero'));
        assert.equal(nonzero.status, 'failed');
        assert.match(nonzero.failure, /exit 19/u);

        const signalled = await executeFixtureScenario(fixture, catalogFor(fixture), {
            spawnProcess: () => fakeChild(null, 'SIGTERM')
        });
        assert.equal(signalled.status, 'cancelled');
        assert.match(signalled.failure, /signal SIGTERM/u);

        const missing = catalogFor(fixture);
        missing.scenarios[0].command.executable = 'fsusblog-command-does-not-exist';
        const unavailable = await executeFixtureScenario(fixture, missing);
        assert.equal(unavailable.status, 'failed');
        assert.match(unavailable.failure, /ENOENT/u);
    }
    finally
    {
        removeFixture(fixture);
    }
});

test('complete execution stays serial and single-scenario execution produces only one result', async () =>
{
    const fixture = createFixture();
    try
    {
        const catalog = catalogFor(fixture);
        let active = 0;
        let maximumActive = 0;
        const observed = [];
        const spawnProcess = (...args) =>
        {
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            const child = spawn(...args);
            child.once('exit', () =>
            {
                active -= 1;
                if (String(args[2]?.env?.FSUSBLOG_RELEASE_RELIABILITY_ACTION_ID)
                    .endsWith('-fixture-measurement'))
                {
                    observed.push(
                        args[2].env.FSUSBLOG_RELEASE_RELIABILITY_SCENARIO_ID
                    );
                }
            });
            return child;
        };
        const complete = await executeScenarios({
            catalog,
            evidenceClass: 'correctness',
            qualificationEligible: true,
            repositoryRoot: fixture.root,
            invocationId,
            runId,
            identity: fixture.identity,
            identityReference: fixture.identityReference,
            spawnProcess,
            physicalExecution: fixturePhysicalExecution,
            ambientEnvironment: fixtureAmbientEnvironment,
            lifecycleContracts: contractsFor(fixture, catalog)
        });
        assert.equal(complete.length, 7);
        assert.ok(complete.every((result) => result.status === 'passed'));
        assert.ok(complete.every((result) => (
            result.evidenceClass === 'correctness'
            && result.qualificationEligible === true
        )));
        assert.equal(maximumActive, 1);
        assert.equal(observed.length, 7);

        const diagnostic = await executeScenarios({
            catalog,
            scenarioId: canonicalIds[2],
            evidenceClass: 'diagnostic',
            qualificationEligible: false,
            repositoryRoot: fixture.root,
            invocationId,
            runId,
            identity: fixture.identity,
            identityReference: fixture.identityReference,
            physicalExecution: fixturePhysicalExecution,
            ambientEnvironment: fixtureAmbientEnvironment,
            lifecycleContracts: contractsFor(fixture, catalog)
        });
        assert.equal(diagnostic.length, 1);
        assert.equal(diagnostic[0].scenarioId, canonicalIds[2]);
        assert.equal(diagnostic[0].evidenceClass, 'diagnostic');
        assert.equal(diagnostic[0].qualificationEligible, false);
    }
    finally
    {
        removeFixture(fixture);
    }
});

test('exact-seven admission failure retains its event and never spawns later members', async () =>
{
    const fixture = createFixture();
    try
    {
        const catalog = catalogFor(fixture);
        let spawnCount = 0;
        const results = await executeScenarios({
            catalog, evidenceClass: 'correctness', qualificationEligible: true,
            repositoryRoot: fixture.root, invocationId, runId,
            identity: { ...fixture.identity, status: 'unavailable' },
            identityReference: fixture.identityReference,
            spawnProcess: () =>
            {
                spawnCount += 1;
                throw new Error('unexpected spawn');
            },
            physicalExecution: fixturePhysicalExecution,
            ambientEnvironment: fixtureAmbientEnvironment,
            lifecycleContracts: contractsFor(fixture, catalog)
        });
        assert.equal(spawnCount, 0);
        assert.deepEqual(createTerminalEvents(results).map(event => event.terminalClassification),
            ['precondition-failure', ...Array(6).fill('not-reached')]);
        assert.ok(results.every(result => !result.producerSpawned && !result.authoritativeEvidence));
    }
    finally
    {
        removeFixture(fixture);
    }
});

test('physical status or nonzero exit without command spawn cannot establish a producer', async () =>
{
    for (const exitCode of [0, 19])
    {
        const fixture = createFixture();
        try
        {
            const catalog = catalogFor(fixture);
            const result = await executeFixtureScenario(fixture, catalog, {
                physicalExecution: async options =>
                {
                    if (!options.env.FSUSBLOG_RELEASE_RELIABILITY_ACTION_ID.endsWith('-fixture-measurement'))
                    {
                        return await fixturePhysicalExecution(options);
                    }
                    const evidence = fixtureProcessEvidence(options.policy);
                    if (exitCode !== 0)
                    {
                        throw Object.assign(new Error('structured launch failure'), { exitCode, physicalExecution: evidence });
                    }
                    return evidence;
                }
            });
            assert.equal(result.producerSpawned, false);
            assert.equal(result.authoritativeEvidence, null);
            assert.equal(result.qualificationEligible, false);
            assert.equal(createTerminalEvents([
                ...canonicalIds.filter(id => id !== result.scenarioId).map(id => ({
                    scenarioId: id, status: 'not-reached', producerSpawned: false,
                    lifecycle: { actions: [] }, authoritativeEvidence: null,
                    finishedAt: result.finishedAt
                })), result
            ]).find(event => event.scenarioId === result.scenarioId).terminalClassification, 'precondition-failure');
        }
        finally
        {
            removeFixture(fixture);
        }
    }
});

test('real controlled producer failure and noisy window keep distinct bound terminal evidence', async () =>
{
    for (const mode of ['product-failure', 'noisy', 'nonzero', 'missing-window'])
    {
        const fixture = createFixture();
        try
        {
            const catalog = catalogFor(fixture);
            catalog.scenarios[2].command.args[2] = mode === 'missing-window' ? 'product-failure' : mode;
            if (mode === 'missing-window')
            {
                delete catalog.scenarios[2].authoritativeEvidence.expectedSchema.schema;
            }
            const results = await executeScenarios({
                catalog, evidenceClass: 'correctness', qualificationEligible: true,
                repositoryRoot: fixture.root, invocationId, runId,
                identity: fixture.identity, identityReference: fixture.identityReference,
                physicalExecution: fixturePhysicalExecution,
                ambientEnvironment: fixtureAmbientEnvironment,
                lifecycleContracts: contractsFor(fixture, catalog)
            });
            const events = createTerminalEvents(results);
            assert.deepEqual(events.map(event => event.terminalClassification), [
                'qualified-success', 'qualified-success',
                mode === 'product-failure' ? 'product-failure' : 'infra-no-conclusion',
                ...Array(4).fill('not-reached')
            ]);
            assert.equal(events[2].producerSpawned, true);
            assert.equal(events[2].exitCode, 19);
            assert.equal(Boolean(events[2].authoritativeEvidence), !['nonzero', 'missing-window'].includes(mode));
            if (events[2].authoritativeEvidence)
            {
                assert.equal(fs.existsSync(path.join(fixture.root, events[2].authoritativeEvidence.path)), true);
            }
        }
        finally
        {
            removeFixture(fixture);
        }
    }
});

test('ambient semantic overrides and undeclared keys never reach any scenario producer', async () =>
{
    const fixture = createFixture();
    try
    {
        const observed = new Map();
        const ambientEnvironment = {
            ...fixtureAmbientEnvironment,
            NODE_OPTIONS: '--inspect',
            DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/forged-user-bus',
            FSUSBLOG_SECRET_SENTINEL: 'must-not-leak',
            FSUSBLOG_SOAK_SHORT_SECONDS: '1',
            FSUSBLOG_LOAD_PROFILE_CONCURRENCY: '1',
            FSUSBLOG_LOAD_PROFILE_ROUNDS: '1',
            FSUSBLOG_LOAD_PROFILE_DURATION_MS: '1',
            FSUSBLOG_RELEASE_RESOURCE_REQUESTS: '1',
            FSUSBLOG_RELEASE_RESOURCE_CONCURRENCY: '1',
            FSUSBLOG_RELEASE_RESOURCE_RSS_DELTA_THRESHOLD_BYTES: '999999999999',
            FSUSBLOG_RELEASE_RESOURCE_FD_DELTA_THRESHOLD: '999999',
            FSUSBLOG_SCALE_TIER: 'scale-xs',
            FSUSBLOG_DATA_SCALE_REQUESTS: '1',
            FSUSBLOG_DATA_SCALE_CONCURRENCY: '1',
            FSUSBLOG_MUTATION_RELEASE_SUBSET_POLICY: 'forged-subset.json'
        };
        const catalog = catalogFor(fixture);
        const results = await executeScenarios({
            catalog,
            evidenceClass: 'correctness',
            qualificationEligible: true,
            repositoryRoot: fixture.root,
            invocationId,
            runId,
            identity: fixture.identity,
            identityReference: fixture.identityReference,
            ambientEnvironment,
            physicalExecution: fixturePhysicalExecution,
            lifecycleContracts: contractsFor(fixture, catalog),
            spawnProcess: (executable, args, options) =>
            {
                observed.set(options.env.FSUSBLOG_RELEASE_RELIABILITY_SCENARIO_ID, options.env);
                return spawn(executable, args, options);
            }
        });
        assert.ok(results.every((result) => result.status === 'passed'));
        for (const [scenarioId, environment] of observed)
        {
            const canonical = repositoryCatalog.scenarios.find(
                (scenario) => scenario.id === scenarioId
            ).command.env;
            for (const [key, value] of Object.entries(canonical))
            {
                assert.equal(environment[key], value, `${scenarioId}:${key}`);
            }
            assert.equal('NODE_OPTIONS' in environment, false);
            assert.equal('DBUS_SESSION_BUS_ADDRESS' in environment, false);
            assert.equal('FSUSBLOG_SECRET_SENTINEL' in environment, false);
            if (scenarioId !== 'release-mutation-critical-slice')
            {
                assert.equal(
                    environment.FSUSBLOG_POSTGRES_CONTAINER_NAME,
                    fixtureAmbientEnvironment.FSUSBLOG_POSTGRES_CONTAINER_NAME
                );
                assert.equal(
                    environment.FSUSBLOG_REDIS_CONTAINER_NAME,
                    fixtureAmbientEnvironment.FSUSBLOG_REDIS_CONTAINER_NAME
                );
            }
        }
        assert.ok(results.every(
            (result) => !JSON.stringify(result).includes('must-not-leak')
        ));
    }
    finally
    {
        removeFixture(fixture);
    }
});

test('data-scale owner inputs reach lifecycle actions but not the workload', async () =>
{
    const fixture = createFixture();
    try
    {
        const ownerInputs = {
            FSUSBLOG_RELEASE_RUNTIME_IMAGE: `sha256:${'3'.repeat(64)}`,
            FSUSBLOG_TEST_FIXTURE_CONFIG: 'config/testing/fixture.json',
            FSUSBLOG_DATA_SCALE_CALLER_JOURNAL: path.join(fixture.root, 'parent-caller-journal.json')
        };
        const observed = new Map();
        const result = await executeFixtureScenario(fixture, catalogFor(fixture), {
            scenarioId: 'release-data-scale-m',
            ambientEnvironment: {
                ...fixtureAmbientEnvironment,
                ...ownerInputs
            },
            spawnProcess: (executable, args, options) =>
            {
                observed.set(
                    options.env.FSUSBLOG_RELEASE_RELIABILITY_ACTION_ID,
                    options.env
                );
                return spawn(executable, args, options);
            }
        });

        assert.equal(result.status, 'passed', result.failure);
        const lifecycleEnvironment = observed.get(
            'release-data-scale-m-fixture-precondition'
        );
        const measurementEnvironment = observed.get(
            'release-data-scale-m-fixture-measurement'
        );
        for (const [key, value] of Object.entries(ownerInputs))
        {
            assert.equal(lifecycleEnvironment[key], value, key);
            assert.equal(key in measurementEnvironment, false, key);
        }
    }
    finally
    {
        removeFixture(fixture);
    }
});

test('full execution clears old qualification and scenario results before a failed rerun', async () =>
{
    const fixture = createFixture();
    try
    {
        const invocationRoot = path.join(
            fixture.root,
            '.tmp/release-reliability',
            invocationId
        );
        const scenarioResultRoot = path.join(invocationRoot, 'scenario-results');
        fs.mkdirSync(scenarioResultRoot, { recursive: true });
        for (const scenarioId of canonicalIds)
        {
            fs.writeFileSync(
                path.join(scenarioResultRoot, `${scenarioId}.json`),
                JSON.stringify({ status: 'passed', stale: true })
            );
        }
        for (const name of [
            'candidate-receipt.json',
            'verified-attestation.json',
            'qualified-receipt.json',
            'timeline.json'
        ])
        {
            fs.writeFileSync(
                path.join(invocationRoot, name),
                JSON.stringify({ status: 'qualified', stale: true })
            );
        }

        prepareInvocationOutputs({
            repositoryRoot: fixture.root,
            invocationId,
            scenarioId: null
        });
        const catalog = catalogFor(fixture, 'nonzero');
        const failed = await executeScenarios({
            catalog,
            evidenceClass: 'correctness',
            qualificationEligible: true,
            repositoryRoot: fixture.root,
            invocationId,
            runId,
            identity: fixture.identity,
            identityReference: fixture.identityReference,
            physicalExecution: fixturePhysicalExecution,
            ambientEnvironment: fixtureAmbientEnvironment,
            lifecycleContracts: contractsFor(fixture, catalog)
        });

        assert.equal(failed[0].status, 'failed');
        assert.ok(failed.slice(1).every((result) => result.status === 'not-reached'));
        assert.ok(failed.every((result) => result.qualificationEligible === false));
        for (const name of [
            'candidate-receipt.json',
            'verified-attestation.json',
            'qualified-receipt.json',
            'timeline.json'
        ])
        {
            assert.equal(fs.existsSync(path.join(invocationRoot, name)), false);
        }
        for (const scenarioId of canonicalIds)
        {
            const result = JSON.parse(fs.readFileSync(
                path.join(scenarioResultRoot, `${scenarioId}.json`),
                'utf8'
            ));
            assert.equal(result.status, scenarioId === canonicalIds[0] ? 'failed' : 'not-reached');
            assert.equal(result.stale, undefined);
        }
    }
    finally
    {
        removeFixture(fixture);
    }
});

test('missing required inherited environment fails before producer spawn', async () =>
{
    const fixture = createFixture();
    try
    {
        let spawnCount = 0;
        const ambientEnvironment = { ...fixtureAmbientEnvironment };
        delete ambientEnvironment.FSUSBLOG_DEBUG_BACKEND_URL;
        const result = await executeFixtureScenario(fixture, catalogFor(fixture), {
            ambientEnvironment,
            spawnProcess: () =>
            {
                spawnCount += 1;
                return fakeChild(0);
            }
        });
        assert.equal(spawnCount, 0);
        assert.equal(result.status, 'failed');
        assert.match(result.failure, /required inherited child environment key is missing/u);
    }
    finally
    {
        removeFixture(fixture);
    }
});

test('missing required XDG runtime carrier fails before producer spawn', async () =>
{
    const fixture = createFixture();
    try
    {
        let spawnCount = 0;
        const ambientEnvironment = { ...fixtureAmbientEnvironment };
        delete ambientEnvironment.XDG_RUNTIME_DIR;
        const result = await executeFixtureScenario(fixture, catalogFor(fixture), {
            ambientEnvironment,
            spawnProcess: () =>
            {
                spawnCount += 1;
                return fakeChild(0);
            }
        });
        assert.equal(spawnCount, 0);
        assert.equal(result.status, 'failed');
        assert.match(result.failure, /XDG_RUNTIME_DIR/u);
    }
    finally
    {
        removeFixture(fixture);
    }
});
