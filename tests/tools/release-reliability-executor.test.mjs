import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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
const [mode, evidencePath, scenarioId, expectedResourcePid, expectedContainerId] = process.argv.slice(2);
console.log('producer-stdout-sentinel');
console.error('producer-stderr-sentinel');
if (process.env.FSUSBLOG_RELEASE_RELIABILITY_SCENARIO_ID !== scenarioId) process.exit(23);
if (process.env.FSUSBLOG_RELEASE_RESOURCE_PID !== expectedResourcePid) process.exit(29);
if (process.env.FSUSBLOG_RELEASE_RESOURCE_CONTAINER_ID !== expectedContainerId) process.exit(31);
if (mode === 'nonzero') process.exit(19);
if (mode === 'signal') process.kill(process.pid, 'SIGTERM');
if (mode === 'missing') process.exit(0);
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
fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
fs.writeFileSync(evidencePath, JSON.stringify({ status: 'ok', sentinel: 'current', releaseReliability: binding }));
const lifecycleRoot = process.env.FSUSBLOG_RELEASE_RELIABILITY_LIFECYCLE_ROOT;
const phases = ['precondition', 'reset', 'measurement', 'postcondition'];
const declarations = {
    precondition: 'fixture-precondition',
    reset: 'fixture-reset',
    measurement: 'fixture-measurement',
    postcondition: 'fixture-postcondition'
};
fs.mkdirSync(lifecycleRoot, { recursive: true });
for (let index = 0; index < phases.length; index += 1) {
    const phase = phases[index];
    const startedAt = new Date().toISOString();
    const receipt = {
        schema: 'fsusblog.release-reliability-lifecycle-action.v1',
        status: mode === 'failed-lifecycle' && phase === 'reset' ? 'failed' : 'complete',
        phase,
        scenarioId,
        invocationId: binding.invocationId,
        runId: binding.runId,
        identity: {
            path: process.env.FSUSBLOG_RELEASE_RELIABILITY_IDENTITY_PATH,
            contentDigest: identity.contentDigest
        },
        declaration: declarations[phase],
        stateDomains: ['fixture-state'],
        state: { before: phase + '-before', after: phase + '-after' },
        observations: mode === 'placeholder-lifecycle' ? null : { observed: true },
        startedAt,
        finishedAt: new Date().toISOString()
    };
    fs.writeFileSync(path.join(lifecycleRoot, phase + '.json'), JSON.stringify(seal(receipt)));
}
`;

function createFixture()
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-release-reliability-executor-'));
    const producer = path.join(root, 'producer.mjs');
    fs.writeFileSync(producer, producerSource, 'utf8');
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
        schema: 'fsusblog.release-reliability-scenario-catalog.v3',
        catalogScenarioCount: canonicalIds.length,
        canonicalScenarioIds: canonicalIds,
        identityTools: ['node'],
        childEnvironmentContract: repositoryCatalog.childEnvironmentContract,
        policyBindings: repositoryCatalog.policyBindings,
        lifecycleSchema: 'fsusblog.release-reliability-lifecycle-action.v1',
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
                    precondition: 'fixture-precondition',
                    reset: 'fixture-reset',
                    measurement: 'fixture-measurement',
                    postcondition: 'fixture-postcondition'
                },
                outputs: [{ id: 'authoritative-evidence', path: `.tmp/evidence/${id}.json` }]
            },
            authoritativeEvidence: {
                path: `.tmp/evidence/${id}.json`,
                expectedSchema: {
                    required: ['status', 'sentinel', 'releaseReliability'],
                    passStatusValues: ['ok']
                }
            }
        };
        })
    };
}

function executeFixtureScenario(fixture, catalog, options = {})
{
    return executeScenario({
        catalog,
        scenarioId: canonicalIds[0],
        evidenceClass: 'diagnostic',
        qualificationEligible: false,
        repositoryRoot: fixture.root,
        invocationId,
        runId,
        identity: options.identity ?? fixture.identity,
        identityReference: fixture.identityReference,
        spawnProcess: options.spawnProcess ?? spawn,
        ambientEnvironment: options.ambientEnvironment ?? fixtureAmbientEnvironment
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

test('catalog requires canonical IDs and explicit lifecycle/resources/outputs', () =>
{
    const fixture = createFixture();
    try
    {
        const catalog = catalogFor(fixture);
        assert.deepEqual(validateCatalog(catalog), []);
        delete catalog.scenarios[0].isolation.lifecycle.reset;
        catalog.scenarios[1].isolation.outputs = [];
        catalog.scenarios[2].isolation.exclusiveResources = [];
        const errors = validateCatalog(catalog);
        assert.ok(errors.some((error) => error.includes('lifecycle.reset')));
        assert.ok(errors.some((error) => error.includes('outputs')));
        assert.ok(errors.some((error) => error.includes('exclusiveResources')));
    }
    finally
    {
        removeFixture(fixture);
    }
});

test('a successful producer must emit current evidence and four real sealed lifecycle receipts', async () =>
{
    const fixture = createFixture();
    try
    {
        const result = await executeFixtureScenario(fixture, catalogFor(fixture));
        assert.equal(result.status, 'passed', result.failure);
        assert.equal(result.evidenceClass, 'diagnostic');
        assert.equal(result.qualificationEligible, false);
        assert.match(result.contentDigest, /^sha256:[0-9a-f]{64}$/u);
        assert.deepEqual(Object.keys(result.lifecycle), ['precondition', 'reset', 'measurement', 'postcondition']);
        assert.ok(Object.values(result.lifecycle).every((reference) => reference.status === 'complete'));
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
            assert.equal(result.lifecycle, null, mode);
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
        assert.match(nonzero.failure, /code: 19/u);

        const signalled = await executeFixtureScenario(fixture, catalogFor(fixture), {
            spawnProcess: () => fakeChild(null, 'SIGTERM')
        });
        assert.equal(signalled.status, 'failed');
        assert.match(signalled.failure, /signal: SIGTERM/u);

        const missing = catalogFor(fixture);
        missing.scenarios[0].command.executable = 'fsusblog-command-does-not-exist';
        const unavailable = await executeFixtureScenario(fixture, missing);
        assert.equal(unavailable.status, 'failed');
        assert.match(unavailable.failure, /spawn failed/u);
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
                observed.push(args[1].at(-1));
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
            ambientEnvironment: fixtureAmbientEnvironment
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
            invocationId: 'diagnostic-invocation',
            runId,
            identity: { ...fixture.identity, invocationId: 'diagnostic-invocation' },
            identityReference: {
                path: '.tmp/release-reliability/diagnostic-invocation/identity.json',
                contentDigest: fixture.identity.contentDigest
            },
            ambientEnvironment: fixtureAmbientEnvironment
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
        const results = await executeScenarios({
            catalog: catalogFor(fixture),
            evidenceClass: 'correctness',
            qualificationEligible: true,
            repositoryRoot: fixture.root,
            invocationId,
            runId,
            identity: fixture.identity,
            identityReference: fixture.identityReference,
            ambientEnvironment,
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
        const failed = await executeScenarios({
            catalog: catalogFor(fixture, 'nonzero'),
            evidenceClass: 'correctness',
            qualificationEligible: true,
            repositoryRoot: fixture.root,
            invocationId,
            runId,
            identity: fixture.identity,
            identityReference: fixture.identityReference,
            ambientEnvironment: fixtureAmbientEnvironment
        });

        assert.ok(failed.every((result) => result.status === 'failed'));
        assert.ok(failed.every((result) => result.qualificationEligible === true));
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
            assert.equal(result.status, 'failed');
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
