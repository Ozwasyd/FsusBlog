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
    validateCatalog
} = await import(pathToFileURL(path.join(repositoryRoot, 'tools/test/run-release-reliability-scenarios.mjs')).href);

const canonicalIds = [
    'release-soak-min',
    'release-load-peak',
    'release-load-burst',
    'release-data-scale-m',
    'release-mutation-critical-slice',
    'release-memory-leak-budget',
    'release-open-handle-budget'
];

const runIdentity = {
    source: {
        commit: '0123456789abcdef0123456789abcdef01234567',
        worktreeFingerprint: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    },
    policy: {
        catalogDigest: 'sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
        thresholdDigest: 'sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
        executorSchema: 'fsusblog.release-reliability-scenario-result.v1'
    }
};

const producerSource = `
import fs from 'node:fs';
import path from 'node:path';
const [mode, evidencePath] = process.argv.slice(2);
if (mode === 'nonzero') process.exit(19);
if (mode === 'signal') process.kill(process.pid, 'SIGTERM');
if (mode === 'missing') process.exit(0);
fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
if (mode === 'malformed') fs.writeFileSync(evidencePath, '{not-json');
else if (mode === 'failed') fs.writeFileSync(evidencePath, JSON.stringify({ status: 'failed' }));
else fs.writeFileSync(evidencePath, JSON.stringify({ status: 'ok', sentinel: 'created-by-producer' }));
`;

function createFixture()
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-release-reliability-'));
    const producer = path.join(root, 'producer.mjs');
    fs.writeFileSync(producer, producerSource, 'utf8');
    return { root, producer };
}

function removeFixture(fixture)
{
    fs.rmSync(fixture.root, { recursive: true, force: true });
}

function catalogFor(fixture, mode = 'success')
{
    return {
        schema: 'fsusblog.release-reliability-scenario-catalog.v2',
        catalogScenarioCount: canonicalIds.length,
        scenarios: canonicalIds.map((id) => ({
            id,
            owner: 'test-owner',
            command: {
                executable: process.execPath,
                args: [fixture.producer, mode, `.tmp/evidence/${id}.json`],
                env: {},
                cwd: '.'
            },
            resourceClass: 'test',
            isolation: {
                exclusiveResources: ['test-resource'],
                precondition: 'fresh-evidence',
                measurement: 'fixture-producer',
                postcondition: 'passing-evidence'
            },
            authoritativeEvidence: {
                path: `.tmp/evidence/${id}.json`,
                expectedSchema: {
                    required: ['status', 'sentinel'],
                    passStatusValues: ['ok']
                }
            }
        }))
    };
}

function scenarioResult(catalog, fixture, options = {})
{
    return executeScenario({
        catalog,
        scenarioId: canonicalIds[0],
        repositoryRoot: fixture.root,
        invocationId: options.invocationId ?? 'fixture-run',
        spawnProcess: options.spawnProcess ?? spawn,
        runIdentity
    });
}

function fakeChild(exitCode, signal = null)
{
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    queueMicrotask(() => child.emit('exit', exitCode, signal));
    return child;
}

test('catalog validator rejects command strings and incomplete structured producer declarations', () =>
{
    const fixture = createFixture();
    try
    {
        const catalog = catalogFor(fixture);
        catalog.scenarios[0].command = 'bash tools/test/lanes/soak.sh';
        const errors = validateCatalog(catalog);
        assert.ok(errors.some((error) => error.includes('command is forbidden')));
    }
    finally
    {
        removeFixture(fixture);
    }
});

test('a successful producer must create current authoritative evidence before passing', async () =>
{
    const fixture = createFixture();
    try
    {
        const result = await scenarioResult(catalogFor(fixture), fixture);
        assert.equal(result.status, 'passed');
        assert.equal(result.authoritativeEvidence.status, 'ok');
        assert.match(result.authoritativeEvidence.digest, /^sha256:[0-9a-f]{64}$/u);
        assert.equal(fs.existsSync(path.join(fixture.root, result.producer.stdoutLog)), true);
        assert.equal(fs.existsSync(path.join(fixture.root, result.producer.stderrLog)), true);
    }
    finally
    {
        removeFixture(fixture);
    }
});

test('a producer that is not spawned cannot pass even when stale evidence exists', async () =>
{
    const fixture = createFixture();
    try
    {
        const catalog = catalogFor(fixture);
        const staleFile = path.join(fixture.root, catalog.scenarios[0].authoritativeEvidence.path);
        fs.mkdirSync(path.dirname(staleFile), { recursive: true });
        fs.writeFileSync(staleFile, JSON.stringify({ status: 'ok', sentinel: 'stale' }));
        const result = await scenarioResult(catalog, fixture, { spawnProcess: () => null });
        assert.equal(result.status, 'failed');
        assert.match(result.failure, /spawn did not return/u);
        assert.equal(fs.existsSync(staleFile), false);
    }
    finally
    {
        removeFixture(fixture);
    }
});

test('nonzero exit, signal termination, and an unavailable executable fail closed', async () =>
{
    const fixture = createFixture();
    try
    {
        const nonzero = await scenarioResult(catalogFor(fixture, 'nonzero'), fixture, { invocationId: 'nonzero' });
        assert.equal(nonzero.status, 'failed');
        assert.match(nonzero.failure, /exited with code: 19/u);

        const signalled = await scenarioResult(catalogFor(fixture), fixture, {
            invocationId: 'signal',
            spawnProcess: () => fakeChild(null, 'SIGTERM')
        });
        assert.equal(signalled.status, 'failed');
        assert.match(signalled.failure, /terminated by signal: SIGTERM/u);

        const missingExecutableCatalog = catalogFor(fixture);
        missingExecutableCatalog.scenarios[0].command.executable = 'fsusblog-command-that-does-not-exist';
        const missingExecutable = await scenarioResult(missingExecutableCatalog, fixture, { invocationId: 'missing-executable' });
        assert.equal(missingExecutable.status, 'failed');
        assert.match(missingExecutable.failure, /producer spawn failed/u);
    }
    finally
    {
        removeFixture(fixture);
    }
});

test('missing, malformed, and non-passing producer evidence fail closed', async () =>
{
    const fixture = createFixture();
    try
    {
        for (const mode of ['missing', 'malformed', 'failed'])
        {
            const result = await scenarioResult(catalogFor(fixture, mode), fixture, { invocationId: mode });
            assert.equal(result.status, 'failed', mode);
        }
    }
    finally
    {
        removeFixture(fixture);
    }
});

test('unknown IDs fail and single-scenario execution spawns only its declared producer once', async () =>
{
    const fixture = createFixture();
    try
    {
        const catalog = catalogFor(fixture);
        let spawnCount = 0;
        const countingSpawn = (...args) =>
        {
            spawnCount += 1;
            return spawn(...args);
        };
        await assert.rejects(
            executeScenarios({ catalog, scenarioId: 'unknown-scenario', repositoryRoot: fixture.root }),
            /Unknown scenario/u
        );
        const results = await executeScenarios({
            catalog,
            scenarioId: canonicalIds[2],
            repositoryRoot: fixture.root,
            invocationId: 'single',
            spawnProcess: countingSpawn,
            runIdentity
        });
        assert.equal(results.length, 1);
        assert.equal(results[0].scenarioId, canonicalIds[2]);
        assert.equal(spawnCount, 1);
    }
    finally
    {
        removeFixture(fixture);
    }
});

test('the complete entry executes every canonical scenario exactly once', async () =>
{
    const fixture = createFixture();
    try
    {
        const catalog = catalogFor(fixture);
        const spawned = [];
        const results = await executeScenarios({
            catalog,
            repositoryRoot: fixture.root,
            invocationId: 'complete',
            runIdentity,
            spawnProcess: (executable, args, options) =>
            {
                spawned.push(args.at(-1));
                return spawn(executable, args, options);
            }
        });
        assert.deepEqual(results.map((result) => result.scenarioId), canonicalIds);
        assert.equal(spawned.length, canonicalIds.length);
        assert.deepEqual(
            spawned.map((evidencePath) => path.basename(evidencePath, '.json')),
            canonicalIds
        );
        assert.ok(results.every((result) => result.status === 'passed'));
    }
    finally
    {
        removeFixture(fixture);
    }
});
