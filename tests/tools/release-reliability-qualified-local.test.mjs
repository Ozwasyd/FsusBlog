import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const wrapper = path.join(root, 'tools/test/run-release-reliability-qualified-local.sh');
const runtimeEnvironmentTool = path.join(root, 'tools/test/release-reliability-runtime-environment.mjs');
const productionBuildEnvironmentTool = path.join(root, 'tools/test/export-production-build-environment.mjs');
const {
    readQualifiedRuntimeEnvironment,
    releaseReliabilityAuditedContainerOverrideKeys,
    releaseReliabilityAuditedContainerOverrides
} = await import(pathToFileURL(runtimeEnvironmentTool).href);
const {
    probeReleaseReliabilityRuntimeSmoke,
    validateAedsFrame,
    validateSeoConfigFrame
} = await import(pathToFileURL(path.join(root, 'tools/test/probe-release-reliability-runtime-smoke.mjs')).href);
const {
    productionBuildEnvironmentAssignments,
    productionBuildEnvironmentKeys,
    productionBuildEnvironment,
    resolveProductionBuildLayout
} = await import(pathToFileURL(path.join(root, 'tools/test-matrix/production-build-layout.mjs')).href);
const {
    parseProductionBuildEnvironmentAssignment
} = await import(pathToFileURL(productionBuildEnvironmentTool).href);
const {
    applySealedFixtureProfileEnvironment,
    sealMatrixFixtureProfile
} = await import(pathToFileURL(path.join(root, 'tools/testing/fixture-catalog.mjs')).href);
const {
    parseMatrix
} = await import(pathToFileURL(path.join(root, 'tools/test-matrix/parse-matrix.mjs')).href);

function executable(file, source)
{
    fs.writeFileSync(file, source);
    fs.chmodSync(file, 0o755);
}

const fakeDockerSource = `#!/usr/bin/env node
const fs = require('node:fs');

const statePath = process.env.FSUSBLOG_FAKE_DOCKER_STATE;
const logPath = process.env.FSUSBLOG_FAKE_DOCKER_LOG;
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
fs.appendFileSync(logPath, JSON.stringify(args) + '\\n');

const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const print = (value) => process.stdout.write(String(value) + '\\n');
const containerById = (id) => state.containers.find((container) => container.id === id);
const networkById = (id) => state.networks.find((network) => network.id === id);

if (args[0] === 'ps')
{
    const filters = [];
    for (let index = 0; index < args.length; index += 1)
    {
        if (args[index] === '--filter')
        {
            filters.push(args[index + 1]);
            index += 1;
        }
    }
    const runFilter = filters.find((filter) => filter.startsWith('label=io.fsusblog.test.run-id='));
    const namespaceFilter = filters.find((filter) => filter.startsWith('label=io.fsusblog.test.namespace='));
    const runId = runFilter?.slice('label=io.fsusblog.test.run-id='.length);
    const namespace = namespaceFilter?.slice('label=io.fsusblog.test.namespace='.length);
    const selected = state.filterPollution
        ? state.containers
        : state.containers.filter((container) => container.runId === runId && container.namespace === namespace);
    const ids = [...selected.map((container) => container.id), ...(state.malformedDiscoveryIds ?? [])];
    if (ids.length > 0)
    {
        process.stdout.write(ids.join('\\n') + '\\n');
    }
    process.exit(0);
}

if (args[0] === 'inspect')
{
    const id = args.at(-1);
    const container = containerById(id);
    if (!container)
    {
        process.exit(1);
    }
    if (args.includes('--format'))
    {
        print(container.id + '|' + container.runId + '|' + container.namespace);
    }
    process.exit(0);
}

if (args[0] === 'rm')
{
    const id = args.at(-1);
    if (!containerById(id))
    {
        process.exit(1);
    }
    if (!(state.stubbornContainerIds ?? []).includes(id))
    {
        state.containers = state.containers.filter((container) => container.id !== id);
        save();
    }
    process.exit(0);
}

if (args[0] === 'network' && args[1] === 'inspect')
{
    const id = args.at(-1);
    const network = networkById(id);
    if (!network)
    {
        process.exit(1);
    }
    if (args.includes('--format'))
    {
        print(network.id + '|' + network.runId + '|' + network.namespace);
    }
    process.exit(0);
}

if (args[0] === 'network' && args[1] === 'rm')
{
    const id = args.at(-1);
    if (!networkById(id))
    {
        process.exit(1);
    }
    state.networks = state.networks.filter((network) => network.id !== id);
    save();
    process.exit(0);
}

process.exit(91);
`;

function runBootstrapFailureCleanup(fixtureRoot, state, { runId, namespace })
{
    const fakeDocker = path.join(fixtureRoot, 'docker');
    const bootstrap = path.join(fixtureRoot, 'failing-bootstrap');
    const statePath = path.join(fixtureRoot, 'docker-state.json');
    const logPath = path.join(fixtureRoot, 'docker-log.jsonl');
    executable(fakeDocker, fakeDockerSource);
    executable(bootstrap, '#!/usr/bin/env bash\nexit 23\n');
    fs.writeFileSync(statePath, JSON.stringify({
        containers: [],
        networks: [],
        ...state
    }));
    fs.writeFileSync(logPath, '');
    const result = spawnSync('bash', [
        wrapper,
        '--test-bootstrap-cleanup',
        fakeDocker,
        bootstrap,
        runId,
        namespace
    ], {
        cwd: fixtureRoot,
        encoding: 'utf8',
        env: {
            ...process.env,
            FSUSBLOG_FAKE_DOCKER_STATE: statePath,
            FSUSBLOG_FAKE_DOCKER_LOG: logPath
        }
    });
    const commands = fs.readFileSync(logPath, 'utf8').trim().split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    return {
        result,
        commands,
        state: JSON.parse(fs.readFileSync(statePath, 'utf8'))
    };
}

function runContainerCleanup(fixtureRoot, state, {
    runId = 'bootstrap-cleanup-run',
    namespace = 'bootstrap-cleanup-namespace',
    backendId = '-',
    postgresId = '-',
    redisId = '-',
    networkId = '-'
} = {})
{
    const fakeDocker = path.join(fixtureRoot, 'docker');
    const statePath = path.join(fixtureRoot, 'docker-state.json');
    const logPath = path.join(fixtureRoot, 'docker-log.jsonl');
    executable(fakeDocker, fakeDockerSource);
    fs.writeFileSync(statePath, JSON.stringify({
        containers: [],
        networks: [],
        ...state
    }));
    fs.writeFileSync(logPath, '');
    const result = spawnSync('bash', [
        wrapper,
        '--test-container-cleanup',
        fakeDocker,
        runId,
        namespace,
        backendId,
        postgresId,
        redisId,
        networkId
    ], {
        cwd: fixtureRoot,
        encoding: 'utf8',
        env: {
            ...process.env,
            FSUSBLOG_FAKE_DOCKER_STATE: statePath,
            FSUSBLOG_FAKE_DOCKER_LOG: logPath
        }
    });
    const commands = fs.readFileSync(logPath, 'utf8').trim().split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    return {
        result,
        commands,
        state: JSON.parse(fs.readFileSync(statePath, 'utf8'))
    };
}

function copyProductionBuildEnvironmentTool(targetRoot)
{
    const pending = ['tools/test/export-production-build-environment.mjs'];
    const copied = new Set();
    while (pending.length > 0)
    {
        const relativePath = pending.pop();
        if (copied.has(relativePath))
        {
            continue;
        }
        copied.add(relativePath);
        const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
        const target = path.join(targetRoot, relativePath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, source);
        // Keep the real static import closure, including literal new URL imports.
        for (const match of source.matchAll(/(?:from\s*|import\s*\(\s*|new URL\(\s*)['"](\.[^'"]+\.mjs)['"]/gu))
        {
            const dependency = path.normalize(path.join(path.dirname(relativePath), match[1]));
            assert.ok(!dependency.startsWith('..') && !path.isAbsolute(dependency));
            pending.push(dependency);
        }
    }
    const policy = 'config/testing/temporal-policy.json';
    fs.mkdirSync(path.dirname(path.join(targetRoot, policy)), { recursive: true });
    fs.copyFileSync(path.join(root, policy), path.join(targetRoot, policy));
    return path.join(targetRoot, 'tools/test/export-production-build-environment.mjs');
}

function productionBuildAssignments(stdout)
{
    return new Map(
        stdout
            .split('\0')
            .filter(Boolean)
            .map((assignment) => parseProductionBuildEnvironmentAssignment(assignment))
    );
}

function runWorkflow(fixtureRoot, runnerSource, verifierSource, receiptName = 'qualified-receipt.json')
{
    const runner = path.join(fixtureRoot, 'runner');
    const verifier = path.join(fixtureRoot, 'verifier');
    const receipt = path.join(fixtureRoot, receiptName);
    const resource = path.join(fixtureRoot, 'backend-container.marker');
    executable(runner, runnerSource);
    executable(verifier, verifierSource);
    const result = spawnSync('bash', [
        wrapper,
        '--test-workflow',
        runner,
        verifier,
        receipt,
        resource
    ], { cwd: fixtureRoot, encoding: 'utf8' });
    return { result, receipt, resource };
}

function writeRuntimeEnvironment(fixtureRoot, namespace, overrides = {}, extraLines = [])
{
    const environment = {
        FSUSBLOG_TEST_NAMESPACE: namespace,
        FSUSBLOG_TEST_RUN_ID: 'qualified-run',
        FSUSBLOG_POSTGRES_CONTAINER_NAME: `fsusblog-test-postgres-${namespace}`,
        FSUSBLOG_REDIS_CONTAINER_NAME: `fsusblog-test-redis-${namespace}`,
        FSUSBLOG_DEBUG_BACKEND_PORT: '24501',
        FSUSBLOG_DEBUG_FRONTEND_PORT: '26501',
        FSUSBLOG_RELEASE_PREVIEW_PORT: '28501',
        FSUSBLOG_DEBUG_BACKEND_URL: 'http://127.0.0.1:24501',
        FSUSBLOG_DEBUG_FRONTEND_URL: 'http://127.0.0.1:26501',
        FSUSBLOG_RELEASE_PREVIEW_URL: 'http://127.0.0.1:28501',
        ASPNETCORE_URLS: 'http://127.0.0.1:24501',
        ...overrides
    };
    const file = path.join(fixtureRoot, '.tmp/env', `${namespace}.env`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
        ...Object.entries(environment).map(([key, value]) => `${key}=${value}`),
        ...extraLines
    ].join('\n'));
    return file;
}

function crc16(bytes)
{
    let value = 0xffff;
    for (const byte of bytes)
    {
        value ^= byte;
        for (let bit = 0; bit < 8; bit += 1)
        {
            value = (value & 1) !== 0 ? ((value >>> 1) ^ 0xa001) : (value >>> 1);
        }
    }
    return value & 0xffff;
}

function createAedsFrame(frameType, payload = Uint8Array.from([1, 2, 3, 4]))
{
    const frame = new Uint8Array(16 + payload.byteLength);
    const view = new DataView(frame.buffer);
    view.setUint32(0, 0x53444541, true);
    view.setUint8(4, 2);
    view.setUint8(5, 16);
    view.setUint16(8, frameType, true);
    view.setUint32(10, payload.byteLength, true);
    frame.set(payload, 16);
    view.setUint16(14, crc16(payload), true);
    return frame;
}

async function waitForDedicatedProcessIdentity(pid)
{
    const deadline = Date.now() + 2000;
    while (Date.now() <= deadline)
    {
        try
        {
            const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
            const close = stat.lastIndexOf(')');
            const tail = close < 0
                ? []
                : stat.slice(close + 2).trim().split(/\s+/u);
            if (Number(tail[2]) === pid
                && Number(tail[3]) === pid
                && /^\d+$/u.test(String(tail[19] ?? '')))
            {
                return tail[19];
            }
        }
        catch (error)
        {
            if (error?.code !== 'ENOENT')
            {
                throw error;
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('dedicated test process identity did not stabilize');
}

function runManagedRuntimeOwned(pidFile, pid, runId, namespace, role)
{
    return spawnSync('bash', [
        wrapper,
        '--test-managed-runtime-owned',
        pidFile,
        String(pid),
        runId,
        namespace,
        role
    ], {
        cwd: root,
        encoding: 'utf8'
    });
}

async function runUserSystemdCarrier({
    fixtureRoot,
    runtimeDirectory,
    userId = process.getuid(),
    createDirectory = true,
    mode = 0o700,
    prepare = () =>
    {}
})
{
    const runtimeRoot = path.join(fixtureRoot, 'run-user');
    const producer = path.join(fixtureRoot, 'carrier-producer');
    const marker = path.join(fixtureRoot, 'producer-ran.json');
    fs.rmSync(marker, { force: true });
    if (createDirectory)
    {
        fs.mkdirSync(runtimeDirectory, { recursive: true, mode });
        fs.chmodSync(runtimeDirectory, mode);
    }
    executable(producer, `#!/usr/bin/env bash
set -euo pipefail
node - "${marker}" <<'NODE'
const fs = require('node:fs');
fs.writeFileSync(process.argv[2], JSON.stringify(process.env));
NODE
`);
    const close = await prepare({ runtimeDirectory });
    const result = spawnSync('bash', [
        wrapper,
        '--test-user-systemd-carrier',
        runtimeDirectory,
        String(userId),
        runtimeRoot,
        producer
    ], {
        cwd: root,
        encoding: 'utf8',
        env: {
            ...process.env,
            DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/forged-user-bus'
        }
    });
    await close?.();
    return { result, marker, runtimeRoot };
}

test('qualified local wrapper validates and exclusively carries the Linux user-systemd runtime directory', async (context) =>
{
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-qualified-user-systemd-'));
    context.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
    const userId = process.getuid();
    const runtimeRoot = path.join(fixtureRoot, 'run-user');
    const runtimeDirectory = path.join(runtimeRoot, String(userId));
    const valid = await runUserSystemdCarrier({
        fixtureRoot,
        runtimeDirectory,
        prepare: async ({ runtimeDirectory: directory }) =>
        {
            const server = net.createServer();
            await new Promise((resolve, reject) =>
            {
                server.once('error', reject);
                server.listen(path.join(directory, 'bus'), resolve);
            });
            return () => new Promise((resolve) => server.close(resolve));
        }
    });
    assert.equal(valid.result.status, 0, valid.result.stderr);
    const environment = JSON.parse(fs.readFileSync(valid.marker, 'utf8'));
    assert.equal(environment.XDG_RUNTIME_DIR, runtimeDirectory);
    assert.equal(environment.DBUS_SESSION_BUS_ADDRESS, undefined);

    const invalidCases = [
        {
            name: 'missing directory',
            runtimeDirectory: path.join(runtimeRoot, String(userId)),
            createDirectory: false
        },
        {
            name: 'forged path',
            runtimeDirectory: path.join(runtimeRoot, `${userId}-forged`)
        },
        {
            name: 'wrong owner',
            runtimeDirectory: path.join(runtimeRoot, String(userId + 1)),
            userId: userId + 1
        },
        {
            name: 'wrong mode',
            runtimeDirectory: path.join(runtimeRoot, String(userId)),
            mode: 0o755
        },
        {
            name: 'missing socket',
            runtimeDirectory: path.join(runtimeRoot, String(userId))
        }
    ];
    for (const invalidCase of invalidCases)
    {
        fs.rmSync(runtimeRoot, { recursive: true, force: true });
        const outcome = await runUserSystemdCarrier({
            fixtureRoot,
            userId: invalidCase.userId ?? userId,
            runtimeDirectory: invalidCase.runtimeDirectory,
            createDirectory: invalidCase.createDirectory,
            mode: invalidCase.mode
        });
        assert.notEqual(outcome.result.status, 0, invalidCase.name);
        assert.equal(fs.existsSync(outcome.marker), false, invalidCase.name);
    }

    fs.rmSync(runtimeRoot, { recursive: true, force: true });
    const symlinkTarget = path.join(fixtureRoot, 'symlink-target');
    const symlinkDirectory = path.join(runtimeRoot, String(userId));
    fs.mkdirSync(symlinkTarget, { recursive: true, mode: 0o700 });
    fs.mkdirSync(runtimeRoot, { recursive: true });
    fs.symlinkSync(symlinkTarget, symlinkDirectory, 'dir');
    const symlink = await runUserSystemdCarrier({
        fixtureRoot,
        runtimeDirectory: symlinkDirectory,
        createDirectory: false
    });
    assert.notEqual(symlink.result.status, 0);
    assert.equal(fs.existsSync(symlink.marker), false);
});

test('qualified local wrapper propagates independent verifier success and always cleans runtime state', (context) =>
{
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-qualified-wrapper-'));
    context.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
    const { result, receipt, resource } = runWorkflow(
        fixtureRoot,
        '#!/usr/bin/env bash\nset -euo pipefail\nprintf \'{"status":"qualified"}\\n\' >"$1"\n',
        '#!/usr/bin/env bash\nset -euo pipefail\n[[ "$1" == */qualified-receipt.json ]]\ngrep -q \'"status":"qualified"\' "$1"\n'
    );
    assert.equal(result.status, 0, result.stderr);
    assert.ok(fs.existsSync(receipt));
    assert.equal(fs.existsSync(resource), false);
});

test('qualified local wrapper propagates verifier failure and cleans runtime state', (context) =>
{
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-qualified-wrapper-failure-'));
    context.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
    const { result, resource } = runWorkflow(
        fixtureRoot,
        '#!/usr/bin/env bash\nset -euo pipefail\nprintf \'{"status":"qualified"}\\n\' >"$1"\n',
        '#!/usr/bin/env bash\nexit 19\n'
    );
    assert.equal(result.status, 19);
    assert.equal(fs.existsSync(resource), false);
});

test('qualified local bootstrap boundary propagates the canonical matrix-sealed fixture identity', (context) =>
{
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-qualified-bootstrap-'));
    context.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
    const bootstrap = path.join(fixtureRoot, 'bootstrap');
    const capture = `${bootstrap}.capture.json`;
    executable(bootstrap, `#!/usr/bin/env bash
set -euo pipefail
node - "${capture}" <<'NODE'
const fs = require('node:fs');
const keys = [
    'FSUSBLOG_SEALED_FIXTURE_PROFILE_ID',
    'FSUSBLOG_SEALED_FIXTURE_CATALOG_DIGEST',
    'FSUSBLOG_SEALED_EXPANDED_CAPABILITY_DIGEST',
    'FSUSBLOG_SEALED_FIXTURE_VARIANT_IDS',
    'FSUSBLOG_SEALED_FIXTURE_VARIANT_PLAN_DIGEST',
    'FSUSBLOG_SEALED_FIXTURE_EXECUTION_CLASS',
    'FSUSBLOG_FIXTURE_PROFILE_SOURCE',
    'FSUSBLOG_FIXTURE_PROFILE',
    'FSUSBLOG_RUNTIME_NO_BUILD',
    'FSUSBLOG_RUNTIME_CONFIGURATION'
];
fs.writeFileSync(process.argv[2], JSON.stringify(Object.fromEntries(keys.map((key) => [key, process.env[key]]))));
NODE
`);
    const ambientEnvironment = {
        ...process.env,
        FSUSBLOG_SEALED_FIXTURE_PROFILE_ID: 'ambient-profile-must-not-win',
        FSUSBLOG_SEALED_FIXTURE_CATALOG_DIGEST: `sha256:${'0'.repeat(64)}`,
        FSUSBLOG_SEALED_EXPANDED_CAPABILITY_DIGEST: `sha256:${'1'.repeat(64)}`,
        FSUSBLOG_SEALED_FIXTURE_EXECUTION_CLASS: 'load'
    };
    const rejected = spawnSync('bash', [
        wrapper,
        '--test-bootstrap-boundary',
        bootstrap
    ], {
        cwd: root,
        encoding: 'utf8',
        env: {
            ...ambientEnvironment,
            FSUSBLOG_FIXTURE_PROFILE: 'scale-m'
        }
    });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /correctness fixture profile cannot be overridden/u);
    assert.equal(fs.existsSync(capture), false);

    const result = spawnSync('bash', [
        wrapper,
        '--test-bootstrap-boundary',
        bootstrap
    ], {
        cwd: root,
        encoding: 'utf8',
        env: {
            ...ambientEnvironment,
            FSUSBLOG_FIXTURE_PROFILE: ''
        }
    });
    assert.equal(result.status, 0, result.stderr);

    const matrix = parseMatrix(fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'));
    const bootstrapTiers = matrix.tiers.filter((tier) => tier.id === 'bootstrap');
    assert.equal(bootstrapTiers.length, 1);
    const expected = applySealedFixtureProfileEnvironment(
        {},
        sealMatrixFixtureProfile(bootstrapTiers[0])
    );
    assert.equal(expected.FSUSBLOG_SEALED_FIXTURE_PROFILE_ID, 'acceptance-representative');
    // The acceptance profile and runtime execution class are separate canonical contracts.
    assert.equal(bootstrapTiers[0].executionClass, 'runtime');
    assert.equal(expected.FSUSBLOG_SEALED_FIXTURE_EXECUTION_CLASS, 'runtime');
    assert.deepEqual(JSON.parse(fs.readFileSync(capture, 'utf8')), {
        FSUSBLOG_SEALED_FIXTURE_PROFILE_ID: expected.FSUSBLOG_SEALED_FIXTURE_PROFILE_ID,
        FSUSBLOG_SEALED_FIXTURE_CATALOG_DIGEST: expected.FSUSBLOG_SEALED_FIXTURE_CATALOG_DIGEST,
        FSUSBLOG_SEALED_EXPANDED_CAPABILITY_DIGEST: expected.FSUSBLOG_SEALED_EXPANDED_CAPABILITY_DIGEST,
        FSUSBLOG_SEALED_FIXTURE_VARIANT_IDS: expected.FSUSBLOG_SEALED_FIXTURE_VARIANT_IDS,
        FSUSBLOG_SEALED_FIXTURE_VARIANT_PLAN_DIGEST: expected.FSUSBLOG_SEALED_FIXTURE_VARIANT_PLAN_DIGEST,
        FSUSBLOG_SEALED_FIXTURE_EXECUTION_CLASS: expected.FSUSBLOG_SEALED_FIXTURE_EXECUTION_CLASS,
        FSUSBLOG_FIXTURE_PROFILE_SOURCE: 'matrix',
        FSUSBLOG_FIXTURE_PROFILE: '',
        FSUSBLOG_RUNTIME_NO_BUILD: '1',
        FSUSBLOG_RUNTIME_CONFIGURATION: 'Release'
    });
});

test('qualified cleanup discovers bootstrap containers before outer IDs are assigned and preserves external containers', (context) =>
{
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-qualified-bootstrap-cleanup-'));
    context.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
    const runId = 'bootstrap-cleanup-run';
    const namespace = 'bootstrap-cleanup-namespace';
    const postgresId = '1'.repeat(64);
    const redisId = '2'.repeat(64);
    const externalRunId = '3'.repeat(64);
    const externalNamespaceId = '4'.repeat(64);
    const outcome = runBootstrapFailureCleanup(fixtureRoot, {
        containers: [
            { id: postgresId, runId, namespace },
            { id: redisId, runId, namespace },
            { id: externalRunId, runId: 'external-run', namespace },
            { id: externalNamespaceId, runId, namespace: 'external-namespace' }
        ]
    }, { runId, namespace });

    assert.equal(outcome.result.status, 23, outcome.result.stderr);
    assert.deepEqual(
        outcome.state.containers.map((container) => container.id).sort(),
        [externalRunId, externalNamespaceId].sort()
    );
    assert.deepEqual(
        outcome.commands.filter((args) => args[0] === 'rm').map((args) => args.at(-1)).sort(),
        [postgresId, redisId].sort()
    );
    const observations = outcome.commands.filter((args) => args[0] === 'ps');
    assert.equal(observations.length, 2);
    for (const observation of observations)
    {
        assert.ok(observation.includes(`label=io.fsusblog.test.run-id=${runId}`));
        assert.ok(observation.includes(`label=io.fsusblog.test.namespace=${namespace}`));
        assert.ok(observation.includes('--no-trunc'));
    }
});

test('qualified cleanup with uninitialized identity is a Docker no-op', (context) =>
{
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-qualified-uninitialized-cleanup-'));
    context.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
    const ownedId = '5'.repeat(64);
    const outcome = runContainerCleanup(fixtureRoot, {
        containers: [{ id: ownedId, runId: 'unused-run', namespace: 'unused-namespace' }]
    }, { runId: '-', namespace: '-' });

    assert.equal(outcome.result.status, 0, outcome.result.stderr);
    assert.deepEqual(outcome.commands, []);
    assert.deepEqual(outcome.state.containers.map((container) => container.id), [ownedId]);
});

test('qualified cleanup removes explicit IDs before fallback discovery and observes zero residual before network cleanup', (context) =>
{
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-qualified-cleanup-order-'));
    context.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
    const runId = 'ordered-cleanup-run';
    const namespace = 'ordered-cleanup-namespace';
    const postgresId = '6'.repeat(64);
    const redisId = '7'.repeat(64);
    const networkId = '8'.repeat(64);
    const outcome = runContainerCleanup(fixtureRoot, {
        containers: [
            { id: postgresId, runId, namespace },
            { id: redisId, runId, namespace }
        ],
        networks: [{ id: networkId, runId, namespace }]
    }, { runId, namespace, postgresId, redisId, networkId });

    assert.equal(outcome.result.status, 0, outcome.result.stderr);
    const postgresRemoval = outcome.commands.findIndex((args) => args[0] === 'rm' && args.at(-1) === postgresId);
    const redisRemoval = outcome.commands.findIndex((args) => args[0] === 'rm' && args.at(-1) === redisId);
    const observations = outcome.commands
        .map((args, index) => ({ args, index }))
        .filter(({ args }) => args[0] === 'ps');
    const networkRemoval = outcome.commands.findIndex((args) => args[0] === 'network' && args[1] === 'rm');
    assert.equal(observations.length, 2);
    assert.ok(postgresRemoval >= 0 && redisRemoval > postgresRemoval);
    assert.ok(observations[0].index > redisRemoval);
    assert.ok(observations[1].index > observations[0].index && networkRemoval > observations[1].index);
    assert.deepEqual(outcome.state.containers, []);
    assert.deepEqual(outcome.state.networks, []);
});

test('qualified cleanup fails closed on Docker label-filter pollution and preserves the foreign container', (context) =>
{
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-qualified-filter-pollution-'));
    context.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
    const foreignId = '9'.repeat(64);
    const outcome = runContainerCleanup(fixtureRoot, {
        containers: [{ id: foreignId, runId: 'foreign-run', namespace: 'foreign-namespace' }],
        filterPollution: true
    });

    assert.notEqual(outcome.result.status, 0);
    assert.deepEqual(outcome.commands.filter((args) => args[0] === 'rm'), []);
    assert.deepEqual(outcome.state.containers.map((container) => container.id), [foreignId]);
});

test('qualified cleanup rejects malformed discovered IDs without attempting removal', (context) =>
{
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-qualified-malformed-discovery-'));
    context.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
    const outcome = runContainerCleanup(fixtureRoot, {
        malformedDiscoveryIds: ['abcdef123456']
    });

    assert.notEqual(outcome.result.status, 0);
    assert.match(outcome.result.stderr, /malformed full ID/u);
    assert.deepEqual(outcome.commands.filter((args) => args[0] === 'rm'), []);
});

test('qualified cleanup fails when post-cleanup observation still finds a run-owned container', (context) =>
{
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-qualified-residual-cleanup-'));
    context.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
    const runId = 'residual-cleanup-run';
    const namespace = 'residual-cleanup-namespace';
    const residualId = 'a'.repeat(64);
    const outcome = runContainerCleanup(fixtureRoot, {
        containers: [{ id: residualId, runId, namespace }],
        stubbornContainerIds: [residualId]
    }, { runId, namespace });

    assert.notEqual(outcome.result.status, 0);
    assert.match(outcome.result.stderr, /remain after qualified runtime cleanup/u);
    assert.deepEqual(outcome.state.containers.map((container) => container.id), [residualId]);
});

test('qualified cleanup is idempotent after label-discovered containers are gone', (context) =>
{
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-qualified-idempotent-cleanup-'));
    context.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
    const runId = 'idempotent-cleanup-run';
    const namespace = 'idempotent-cleanup-namespace';
    const ownedId = 'b'.repeat(64);
    const first = runContainerCleanup(fixtureRoot, {
        containers: [{ id: ownedId, runId, namespace }]
    }, { runId, namespace });
    assert.equal(first.result.status, 0, first.result.stderr);

    const second = runContainerCleanup(fixtureRoot, first.state, { runId, namespace });
    assert.equal(second.result.status, 0, second.result.stderr);
    assert.deepEqual(second.commands.filter((args) => args[0] === 'rm'), []);
    assert.equal(second.commands.filter((args) => args[0] === 'ps').length, 2);
});

test('qualified local wrapper rejects a wrong receipt path and cleans runtime state', (context) =>
{
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-qualified-wrapper-path-'));
    context.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
    const { result, resource } = runWorkflow(
        fixtureRoot,
        '#!/usr/bin/env bash\nset -euo pipefail\nprintf \'{"status":"qualified"}\\n\' >"$1.actual"\n',
        '#!/usr/bin/env bash\nset -euo pipefail\ntest -f "$1"\n'
    );
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(resource), false);
});

test('qualified runtime environment preserves spaces, quotes, and command text without shell evaluation', (context) =>
{
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-qualified-environment-'));
    context.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
    const marker = path.join(fixtureRoot, 'command-was-executed');
    const literal = `allowed.example value "quoted value" $(touch ${marker})`;
    writeRuntimeEnvironment(fixtureRoot, 'qualified-environment', { CORS_ALLOWED_HOSTS: literal });

    const environment = readQualifiedRuntimeEnvironment({
        repositoryRoot: fixtureRoot,
        namespace: 'qualified-environment',
        runId: 'qualified-run'
    });
    const result = spawnSync(process.execPath, [
        runtimeEnvironmentTool,
        'get',
        '--root', fixtureRoot,
        '--namespace', 'qualified-environment',
        '--run-id', 'qualified-run',
        '--field', 'backend-url'
    ], { encoding: 'utf8' });
    const portResult = spawnSync(process.execPath, [
        runtimeEnvironmentTool,
        'get',
        '--root', fixtureRoot,
        '--namespace', 'qualified-environment',
        '--run-id', 'qualified-run',
        '--field', 'backend-port'
    ], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(portResult.status, 0, portResult.stderr);
    assert.equal(result.stdout, 'http://127.0.0.1:24501');
    assert.equal(portResult.stdout, '24501');
    assert.equal(environment.CORS_ALLOWED_HOSTS, literal);
    assert.equal(fs.existsSync(marker), false);
});

test('qualified runtime environment rejects duplicate and malformed assignments before use', (context) =>
{
    for (const extraLine of [
        'FSUSBLOG_DEBUG_BACKEND_URL=http://127.0.0.1:24501',
        'malformed assignment without equals'
    ])
    {
        const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-qualified-invalid-environment-'));
        context.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
        writeRuntimeEnvironment(fixtureRoot, 'qualified-invalid', {}, [extraLine]);
        const result = spawnSync(process.execPath, [
            runtimeEnvironmentTool,
            'get',
            '--root', fixtureRoot,
            '--namespace', 'qualified-invalid',
            '--run-id', 'qualified-run',
            '--field', 'backend-url'
        ], { encoding: 'utf8' });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /duplicated|malformed/u);
    }
    const invalidPortRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-qualified-invalid-port-'));
    context.after(() => fs.rmSync(invalidPortRoot, { recursive: true, force: true }));
    writeRuntimeEnvironment(invalidPortRoot, 'qualified-invalid-port', {
        FSUSBLOG_DEBUG_BACKEND_PORT: '24501suffix'
    });
    const invalidPort = spawnSync(process.execPath, [
        runtimeEnvironmentTool,
        'get',
        '--root', invalidPortRoot,
        '--namespace', 'qualified-invalid-port',
        '--run-id', 'qualified-run',
        '--field', 'backend-port'
    ], { encoding: 'utf8' });
    assert.notEqual(invalidPort.status, 0);
    assert.match(invalidPort.stderr, /invalid FSUSBLOG_DEBUG_BACKEND_PORT/u);
});

test('qualified container environment projection is strict, private, atomic, and Docker-exact', (context) =>
{
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-container-environment-'));
    context.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
    const namespace = 'qualified-container';
    const runId = 'qualified-run';
    const retainedValue = 'literal value = "quoted" $(must-not-run)';
    const environmentFile = writeRuntimeEnvironment(fixtureRoot, namespace, {
        FSUSBLOG_DATA_ROOT: '/host/run-bound/data',
        FSUSBLOG_RELEASE_DERIVED_ROOT: '/host/run-bound/release-derived',
        PublicAot__SsrClientRoot: '/host/run-bound/frontend/dist',
        ConnectionStrings__DefaultConnection: 'Host=127.0.0.1;Port=20001',
        ConnectionStrings__Redis: '127.0.0.1:22001',
        RedisOptions__Configuration: '127.0.0.1:22001',
        RedisOptions__InstanceName: 'FsusBlog_qualified-container_',
        HumanReadProof__SigningKey: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
        HumanReadProof__Dedup__CurrentKey: 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8=',
        ReadAnalyticsPrivacy__NoiseKey: 'QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8=',
        CORS_ALLOWED_HOSTS: retainedValue
    });
    const validInput = fs.readFileSync(environmentFile, 'utf8');
    const invoke = () => spawnSync(process.execPath, [
        runtimeEnvironmentTool,
        'project-container-environment',
        '--root', fixtureRoot,
        '--namespace', namespace,
        '--run-id', runId
    ], { encoding: 'utf8' });
    const result = invoke();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const output = result.stdout;
    assert.equal(
        path.relative(fixtureRoot, output),
        path.join('.tmp', 'env', `${namespace}.${runId}.container.env`)
    );
    const outputStat = fs.statSync(output);
    assert.equal(outputStat.mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(output)).mode & 0o777, 0o700);
    if (typeof process.getuid === 'function')
    {
        assert.equal(outputStat.uid, process.getuid());
    }
    const projectedContents = fs.readFileSync(output, 'utf8');
    const projectedEntries = projectedContents.trimEnd().split('\n');
    const projectedEnvironment = Object.fromEntries(projectedEntries.map((entry) => (
        entry.split(/=(.*)/su).slice(0, 2)
    )));
    const projectedKeys = Object.keys(projectedEnvironment);
    assert.deepEqual(projectedKeys, [...projectedKeys].sort());
    assert.equal(projectedEnvironment.CORS_ALLOWED_HOSTS, retainedValue);
    assert.equal(projectedEnvironment.RedisOptions__InstanceName, 'FsusBlog_qualified-container_');
    assert.equal(
        projectedEnvironment.ReadAnalyticsPrivacy__NoiseKey,
        'QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8='
    );
    assert.deepEqual(
        projectedKeys.filter((key) => releaseReliabilityAuditedContainerOverrideKeys.includes(key)),
        []
    );
    const repeated = invoke();
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.equal(repeated.stdout, output);
    assert.equal(fs.readFileSync(output, 'utf8'), projectedContents);

    const runtimeEnvironment = readQualifiedRuntimeEnvironment({
        repositoryRoot: fixtureRoot,
        namespace,
        runId
    });
    const overrides = releaseReliabilityAuditedContainerOverrides({
        runId,
        namespace,
        sourceCommit: 'a'.repeat(40),
        sourceFingerprint: 'b'.repeat(64)
    });
    assert.equal(overrides.FSUSBLOG_RELEASE_DERIVED_ROOT, '/app/release-derived');
    assert.equal(overrides.AllowedHosts, 'localhost;*');
    assert.deepEqual(overrides.AllowedHosts.split(';'), ['localhost', '*']);
    const imageEnvironment = {
        DOTNET_RUNNING_IN_CONTAINER: 'true',
        ASPNETCORE_URLS: 'http://image-default:8080'
    };
    const suppliedEnvironment = { ...projectedEnvironment, ...overrides };
    const mockedDockerConfigEnvironment = [
        ...Object.entries(imageEnvironment)
            .filter(([key]) => !Object.hasOwn(suppliedEnvironment, key)),
        ...Object.entries(projectedEnvironment),
        ...Object.entries(overrides)
    ].map(([key, value]) => `${key}=${value}`);
    const mockedDockerKeys = mockedDockerConfigEnvironment.map((entry) => entry.slice(0, entry.indexOf('=')));
    assert.equal(new Set(mockedDockerKeys).size, mockedDockerKeys.length);
    assert.deepEqual(
        Object.fromEntries(mockedDockerConfigEnvironment.map((entry) => entry.split(/=(.*)/su).slice(0, 2))),
        { ...imageEnvironment, ...projectedEnvironment, ...overrides }
    );
    const rawPlusOverrides = [
        ...Object.keys(runtimeEnvironment),
        ...Object.keys(overrides)
    ];
    assert.ok(new Set(rawPlusOverrides).size < rawPlusOverrides.length);

    const committedProjection = fs.readFileSync(output, 'utf8');
    for (const invalidLine of [
        'CORS_ALLOWED_HOSTS=duplicate-secret',
        'malformed-secret',
        '=empty-key-secret'
    ])
    {
        fs.writeFileSync(environmentFile, `${validInput}\n${invalidLine}\n`);
        const invalid = invoke();
        assert.notEqual(invalid.status, 0);
        assert.equal(invalid.stdout, '');
        assert.doesNotMatch(invalid.stderr, /duplicate-secret|malformed-secret|empty-key-secret/u);
        assert.equal(fs.readFileSync(output, 'utf8'), committedProjection);
    }
});

test('qualified runtime smoke validates canonical taxonomy and SEO AEDS header, length, CRC, and frame type', () =>
{
    const category = createAedsFrame(9);
    const tag = createAedsFrame(10);
    const seo = createAedsFrame(13);

    const expectedCategory = {
        version: 2,
        headerLength: 16,
        frameType: 9,
        payloadLength: 4,
        crcValidated: true
    };
    assert.deepEqual(validateAedsFrame(category, 9), expectedCategory);
    assert.deepEqual(validateAedsFrame(tag, 10), {
        ...expectedCategory,
        frameType: 10
    });
    assert.deepEqual(validateSeoConfigFrame(seo), {
        ...expectedCategory,
        frameType: 13
    });

    const invalidHeader = category.slice();
    invalidHeader[0] ^= 0xff;
    assert.throws(() => validateAedsFrame(invalidHeader, 9), /valid CategoryList AEDS v2 frame/u);

    const invalidLength = tag.slice();
    new DataView(invalidLength.buffer).setUint32(10, 5, true);
    assert.throws(() => validateAedsFrame(invalidLength, 10), /valid TagList AEDS v2 frame/u);

    const invalidCrc = seo.slice();
    invalidCrc[16] ^= 0xff;
    assert.throws(() => validateSeoConfigFrame(invalidCrc), /valid SeoConfig AEDS v2 frame/u);

    assert.throws(() => validateAedsFrame(category, 10), /valid TagList AEDS v2 frame/u);
});

test('qualified runtime smoke requires live JSON and the exact canonical runtime-load-soak route set', async (context) =>
{
    const requests = [];
    const liveBody = JSON.stringify({
        status: 'live',
        checkedAt: '2026-07-31T00:04:22.6481393+00:00'
    });
    const routes = new Map([
        ['/api/binary/system/seo', createAedsFrame(13)],
        ['/api/binary/article/list/home/1/10.aeds', createAedsFrame(1)],
        ['/api/binary/category', createAedsFrame(9)],
        ['/api/binary/tag', createAedsFrame(10)],
        ['/api/binary/article/hot/5.aeds', createAedsFrame(3)],
        ['/api/binary/article/featured/4.aeds', createAedsFrame(15)]
    ]);
    const server = http.createServer((request, response) =>
    {
        requests.push(request.url);
        if (request.url === '/health/live')
        {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(liveBody);
            return;
        }
        const frame = routes.get(request.url);
        if (frame)
        {
            response.writeHead(200, {
                'content-type': 'application/octet-stream',
                'x-fsus-frame-version': '2'
            });
            response.end(frame);
            return;
        }
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end('{"status":"not_ready"}');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    context.after(() => server.close());
    const address = server.address();
    assert.equal(typeof address, 'object');
    const result = await probeReleaseReliabilityRuntimeSmoke({
        baseUrl: `http://127.0.0.1:${address.port}/`,
        timeoutMs: 1000
    });
    assert.equal(result.schema, 'fsusblog.release-reliability-runtime-smoke.v1');
    assert.equal(result.status, 'passed');
    assert.match(result.contentDigest, /^sha256:[0-9a-f]{64}$/u);
    assert.deepEqual(result.live, {
        method: 'GET',
        path: '/health/live',
        status: 200,
        contentType: 'application/json',
        bodyBytes: Buffer.byteLength(liveBody),
        reportStatus: 'live',
        checkedAt: '2026-07-31T00:04:22.648Z'
    });
    assert.deepEqual(
        result.routes.map((route) => ({
            routeId: route.routeId,
            method: route.method,
            path: route.path,
            status: route.status,
            contentType: route.contentType,
            fsusHeaders: route.fsusHeaders,
            bodyBytes: route.bodyBytes,
            aeds: route.aeds
        })),
        [
            ['system-seo', '/api/binary/system/seo', 13],
            ['article-list-home-10', '/api/binary/article/list/home/1/10.aeds', 1],
            ['category-list', '/api/binary/category', 9],
            ['tag-list', '/api/binary/tag', 10],
            ['article-hot', '/api/binary/article/hot/5.aeds', 3],
            ['article-featured', '/api/binary/article/featured/4.aeds', 15]
        ].map(([routeId, routePath, frameType]) => ({
            routeId,
            method: 'GET',
            path: routePath,
            status: 200,
            contentType: 'application/octet-stream',
            fsusHeaders: { 'x-fsus-frame-version': '2' },
            bodyBytes: 20,
            aeds: {
                version: 2,
                headerLength: 16,
                frameType,
                payloadLength: 4,
                crcValidated: true
            }
        }))
    );
    assert.deepEqual(requests, [
        '/health/live',
        '/api/binary/system/seo',
        '/api/binary/article/list/home/1/10.aeds',
        '/api/binary/category',
        '/api/binary/tag',
        '/api/binary/article/hot/5.aeds',
        '/api/binary/article/featured/4.aeds'
    ]);
});

test('qualified runtime smoke canonicalizes equivalent timestamp forms and rejects invalid live timestamps', async (context) =>
{
    const routes = new Map([
        ['/api/binary/system/seo', createAedsFrame(13)],
        ['/api/binary/article/list/home/1/10.aeds', createAedsFrame(1)],
        ['/api/binary/category', createAedsFrame(9)],
        ['/api/binary/tag', createAedsFrame(10)],
        ['/api/binary/article/hot/5.aeds', createAedsFrame(3)],
        ['/api/binary/article/featured/4.aeds', createAedsFrame(15)]
    ]);
    let liveContentType = 'application/json';
    let liveReport = {
        status: 'live',
        checkedAt: '2026-07-31T00:04:22.000Z'
    };
    const server = http.createServer((request, response) =>
    {
        if (request.url === '/health/live')
        {
            response.writeHead(200, { 'content-type': liveContentType });
            response.end(JSON.stringify(liveReport));
            return;
        }
        const frame = routes.get(request.url);
        if (frame)
        {
            response.writeHead(200, {
                'content-type': 'application/octet-stream',
                'x-fsus-frame-version': '2'
            });
            response.end(frame);
            return;
        }
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end('{"status":"not_found"}');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    context.after(() => server.close());
    const address = server.address();
    assert.equal(typeof address, 'object');
    const invoke = () => probeReleaseReliabilityRuntimeSmoke({
        baseUrl: `http://127.0.0.1:${address.port}/`,
        timeoutMs: 1000
    });

    for (const [input, expected] of [
        ['2026-07-31T00:04:22.000Z', '2026-07-31T00:04:22.000Z'],
        ['2026-07-31T00:04:22.6481393+00:00', '2026-07-31T00:04:22.648Z'],
        ['2026-07-31T02:04:22.648+02:00', '2026-07-31T00:04:22.648Z']
    ])
    {
        liveReport = { status: 'live', checkedAt: input };
        const result = await invoke();
        assert.equal(result.live.checkedAt, expected);
    }

    for (const checkedAt of [
        '',
        0,
        null,
        {},
        'not-a-timestamp',
        '2026-02-30T00:00:00.000Z'
    ])
    {
        liveReport = { status: 'live', checkedAt };
        await assert.rejects(invoke, /returned an invalid live report/u);
    }

    liveReport = { status: 'ready', checkedAt: '2026-07-31T00:04:22.000Z' };
    await assert.rejects(invoke, /returned an invalid live report/u);
    liveReport = { status: 'live', checkedAt: '2026-07-31T00:04:22.000Z' };
    liveContentType = 'text/plain';
    await assert.rejects(invoke, /did not return JSON/u);
});

test('qualified runtime smoke blocks every incomplete taxonomy response', async (context) =>
{
    const taxonomy = [
        { path: '/api/binary/category', frameType: 9, name: 'CategoryList' },
        { path: '/api/binary/tag', frameType: 10, name: 'TagList' }
    ];
    const validRoutes = new Map([
        ['/api/binary/system/seo', createAedsFrame(13)],
        ['/api/binary/article/list/home/1/10.aeds', createAedsFrame(1)],
        ['/api/binary/category', createAedsFrame(9)],
        ['/api/binary/tag', createAedsFrame(10)],
        ['/api/binary/article/hot/5.aeds', createAedsFrame(3)],
        ['/api/binary/article/featured/4.aeds', createAedsFrame(15)]
    ]);
    let override = null;
    const server = http.createServer((request, response) =>
    {
        if (request.url === '/health/live')
        {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end('{"status":"live","checkedAt":"2026-07-26T20:00:00.000Z"}');
            return;
        }
        const frame = override?.path === request.url
            ? override.frame
            : validRoutes.get(request.url);
        const selectedOverride = override?.path === request.url ? override : null;
        response.writeHead(selectedOverride ? selectedOverride.status : 200, {
            'content-type': selectedOverride
                ? selectedOverride.contentType
                : 'application/octet-stream',
            ...(selectedOverride?.headers ?? { 'x-fsus-frame-version': '2' })
        });
        response.end(frame);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    context.after(() => server.close());
    const address = server.address();
    assert.equal(typeof address, 'object');
    const invoke = () => probeReleaseReliabilityRuntimeSmoke({
        baseUrl: `http://127.0.0.1:${address.port}/`,
        timeoutMs: 1000
    });

    for (const route of taxonomy)
    {
        const invalidHeader = createAedsFrame(route.frameType);
        invalidHeader[0] ^= 0xff;
        const invalidVersion = createAedsFrame(route.frameType);
        invalidVersion[4] = 1;
        const invalidHeaderLength = createAedsFrame(route.frameType);
        invalidHeaderLength[5] = 15;
        const invalidLength = createAedsFrame(route.frameType);
        new DataView(invalidLength.buffer).setUint32(10, 5, true);
        const invalidCrc = createAedsFrame(route.frameType);
        invalidCrc[16] ^= 0xff;
        const cases = [
            {
                name: '404',
                status: 404,
                contentType: 'application/octet-stream',
                frame: createAedsFrame(route.frameType),
                expected: /returned HTTP 404/u
            },
            {
                name: 'content type',
                status: 200,
                contentType: 'application/json',
                frame: createAedsFrame(route.frameType),
                expected: /did not return application\/octet-stream/u
            },
            {
                name: 'missing Fsus header',
                status: 200,
                contentType: 'application/octet-stream',
                headers: {},
                frame: createAedsFrame(route.frameType),
                expected: /invalid X-Fsus-Frame-Version header/u
            },
            {
                name: 'wrong Fsus header',
                status: 200,
                contentType: 'application/octet-stream',
                headers: { 'x-fsus-frame-version': '1' },
                frame: createAedsFrame(route.frameType),
                expected: /invalid X-Fsus-Frame-Version header/u
            },
            {
                name: 'header',
                status: 200,
                contentType: 'application/octet-stream',
                frame: invalidHeader,
                expected: new RegExp(`valid ${route.name} AEDS v2 frame`, 'u')
            },
            {
                name: 'version',
                status: 200,
                contentType: 'application/octet-stream',
                frame: invalidVersion,
                expected: new RegExp(`valid ${route.name} AEDS v2 frame`, 'u')
            },
            {
                name: 'header length',
                status: 200,
                contentType: 'application/octet-stream',
                frame: invalidHeaderLength,
                expected: new RegExp(`valid ${route.name} AEDS v2 frame`, 'u')
            },
            {
                name: 'body bounds',
                status: 200,
                contentType: 'application/octet-stream',
                frame: new Uint8Array(),
                expected: /out-of-bounds AEDS frame/u
            },
            {
                name: 'length',
                status: 200,
                contentType: 'application/octet-stream',
                frame: invalidLength,
                expected: new RegExp(`valid ${route.name} AEDS v2 frame`, 'u')
            },
            {
                name: 'CRC',
                status: 200,
                contentType: 'application/octet-stream',
                frame: invalidCrc,
                expected: new RegExp(`valid ${route.name} AEDS v2 frame`, 'u')
            },
            {
                name: 'frame type',
                status: 200,
                contentType: 'application/octet-stream',
                frame: createAedsFrame(route.frameType === 9 ? 10 : 9),
                expected: new RegExp(`valid ${route.name} AEDS v2 frame`, 'u')
            }
        ];
        for (const candidate of cases)
        {
            override = { path: route.path, ...candidate };
            await assert.rejects(invoke, candidate.expected, `${route.name} ${candidate.name}`);
        }
    }
});

test('qualified local wrapper uses strict runtime parsing and canonical semantic runtime smoke canaries', () =>
{
    const source = fs.readFileSync(wrapper, 'utf8');
    assert.doesNotMatch(source, /(?:^|[;\s])source\s+[^\n]*\.env/mu);
    assert.match(source, /release-reliability-runtime-environment\.mjs/u);
    assert.match(source, /FSUSBLOG_RELEASE_LOAD_RUNTIME_ENVIRONMENT=1/u);
    assert.match(source, /qualified_executor_environment=\(/u);
    assert.match(
        source,
        /env -i "\$\{qualified_executor_environment\[@\]\}"[\s\S]*run-release-reliability-scenarios\.mjs/u
    );
    assert.doesNotMatch(
        source,
        /qualified_executor_environment[\s\S]*FSUSBLOG_(?:SOAK_SHORT_SECONDS|LOAD_PROFILE_CONCURRENCY|RELEASE_RESOURCE_REQUESTS|DATA_SCALE_REQUESTS)=/u
    );
    assert.match(source, /probe-release-reliability-runtime-smoke\.mjs/u);
    assert.doesNotMatch(source, /runtime_smoke_deadline=/u);
    assert.match(source, /runtime_smoke_attempt_count=1/u);
    assert.match(source, /did not satisfy live\/canonical AEDS route admission on its first attempt/u);
    assert.match(source, /live\/canonical AEDS route admission/u);
    assert.doesNotMatch(source, /health\/ready/u);
    assert.match(source, /audit-retention-policy/u);
    assert.match(source, /RemoveOwnedContainer "\$backend_container_id"/u);
    assert.match(source, /RemoveOwnedNetwork "\$backend_network_id"/u);
    assert.match(source, /StopManagedRuntime "\$managed_dev_pid_file" "\$debug_frontend_pid" debug-frontend/u);
    assert.match(source, /StopManagedRuntime "\$managed_preview_pid_file" "\$release_preview_pid" release-preview/u);
    assert.match(source, /export-production-build-environment\.mjs/u);
    assert.match(source, /read -r -d '' assignment/u);
    assert.doesNotMatch(source, /eval\s/u);
});

test('production build environment CLI executes from ASCII and Unicode script paths', (context) =>
{
    const fixtureRoot = fs.mkdtempSync('/tmp/fsusblog-production-build-environment-cli-');
    context.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
    const candidates = [
        copyProductionBuildEnvironmentTool(path.join(fixtureRoot, 'ascii')),
        copyProductionBuildEnvironmentTool(path.join(fixtureRoot, 'unicode-路徑'))
    ];
    assert.doesNotMatch(candidates[0], /[^\x00-\x7f]/u); // eslint-disable-line no-control-regex -- intentional ASCII-boundary probe
    assert.match(candidates[1], /[^\x00-\x7f]/u); // eslint-disable-line no-control-regex -- intentional ASCII-boundary probe

    for (const [index, tool] of candidates.entries())
    {
        const runId = `production-environment-cli-${index}`;
        const result = spawnSync(process.execPath, [
            tool,
            '--root',
            root,
            '--run-id',
            runId
        ], { cwd: fixtureRoot, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        const assignments = productionBuildAssignments(result.stdout);
        assert.deepEqual([...assignments.keys()], productionBuildEnvironmentKeys);
        assert.equal(
            assignments.get('FSUSBLOG_PRODUCTION_BUILD_ROOT'),
            path.join(root, '.tmp/build', runId)
        );
    }
});

test('production build environment module import does not execute the CLI branch', () =>
{
    const result = spawnSync(process.execPath, [
        '--input-type=module',
        '--eval',
        `await import(${JSON.stringify(pathToFileURL(productionBuildEnvironmentTool).href)}); process.stdout.write('imported\\n');`
    ], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'imported\n');
    assert.equal(result.stderr, '');
});

test('qualified local runtime ownership uses bounded identity and rejects every identity mismatch', async (context) =>
{
    const source = fs.readFileSync(wrapper, 'utf8');
    const start = source.indexOf('ManagedRuntimeOwned() {');
    const end = source.indexOf('\nStopManagedRuntime() {', start);
    assert.ok(start >= 0 && end > start);
    const ownership = source.slice(start, end);
    assert.match(ownership, /\/proc\/\$\{pid\}\/stat/u);
    assert.doesNotMatch(
        ownership,
        /\/proc\/\$\{pid\}\/(?:environ|cmdline)|readFileSync\([^)]*(?:environ|cmdline)/u
    );
    for (const binding of [
        'identity.pid !== pid',
        'identity.processGroupId !== pid',
        'identity.startTimeTicks !== tail[19]',
        'identity.runId !== runId',
        'identity.namespace !== namespace',
        'identity.role !== role',
        'Number(tail[2]) !== identity.processGroupId',
        'Number(tail[3]) !== identity.processGroupId'
    ])
    {
        assert.ok(ownership.includes(binding), binding);
    }

    const fixtureRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'fsusblog-qualified-owned-runtime-')
    );
    context.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
    const child = spawn('sleep', ['30'], {
        detached: true,
        stdio: 'ignore'
    });
    context.after(() =>
    {
        try
        {
            process.kill(-child.pid, 'SIGKILL');
        }
        catch (error)
        {
            if (error?.code !== 'ESRCH')
            {
                throw error;
            }
        }
    });
    const startTimeTicks = await waitForDedicatedProcessIdentity(child.pid);
    const pidFile = path.join(fixtureRoot, 'backend.pid');
    const identityFile = path.join(fixtureRoot, 'backend.identity.json');
    const expected = {
        schema: 'fsusblog.local-runtime-process-identity.v1',
        pid: child.pid,
        processGroupId: child.pid,
        startTimeTicks,
        runId: 'owned-runtime',
        namespace: 'owned-namespace',
        role: 'backend'
    };
    fs.writeFileSync(pidFile, `${child.pid}\n`, { mode: 0o600 });
    const writeIdentity = (value) =>
    {
        fs.writeFileSync(identityFile, `${JSON.stringify(value)}\n`, { mode: 0o600 });
        fs.chmodSync(identityFile, 0o600);
    };
    writeIdentity(expected);
    const valid = runManagedRuntimeOwned(
        pidFile,
        child.pid,
        expected.runId,
        expected.namespace,
        expected.role
    );
    assert.equal(valid.status, 0, valid.stderr);

    const mismatches = [
        ['schema', { schema: 'fsusblog.local-runtime-process-identity.invalid' }],
        ['PID', { pid: child.pid + 1 }],
        ['process group', { processGroupId: child.pid + 1 }],
        ['start time', { startTimeTicks: String(Number(startTimeTicks) + 1) }],
        ['run ID', { runId: 'wrong-run' }],
        ['namespace', { namespace: 'wrong-namespace' }],
        ['role', { role: 'release-preview' }]
    ];
    for (const [name, mutation] of mismatches)
    {
        writeIdentity({ ...expected, ...mutation });
        const invalid = runManagedRuntimeOwned(
            pidFile,
            child.pid,
            expected.runId,
            expected.namespace,
            expected.role
        );
        assert.notEqual(invalid.status, 0, name);
    }
    writeIdentity(expected);
    fs.writeFileSync(pidFile, `${child.pid + 1}\n`);
    const wrongPidFile = runManagedRuntimeOwned(
        pidFile,
        child.pid,
        expected.runId,
        expected.namespace,
        expected.role
    );
    assert.notEqual(wrongPidFile.status, 0, 'PID file');
});

test('qualified local wrapper binds bootstrap to the freshly completed production build receipt digest', () =>
{
    const source = fs.readFileSync(wrapper, 'utf8');
    const producer = source.indexOf('"$root/tools/test/lanes/production-build-artifacts.sh"');
    const digestRead = source.indexOf('build_receipt_digest="$(node - "$root/$FSUSBLOG_CI_PRODUCTION_ARTIFACT_ROOT/receipt.json"');
    const digestExport = source.indexOf('export FSUSBLOG_CI_PRODUCTION_RECEIPT_DIGEST="$build_receipt_digest"');
    const imageBuild = source.indexOf('FSUSBLOG_FINAL_LOCAL_ONLY=1 FSUSBLOG_FINAL_IMAGE_TAG="$image"');
    const consumerEnvironment = source.indexOf('ImportProductionBuildEnvironment "${run_id}-acceptance"');
    const bootstrap = source.indexOf('"$root/tools/bootstrap-acceptance-env.sh"');
    assert.ok(producer >= 0 && producer < digestRead, 'receipt digest must be read after the production build completes');
    assert.ok(digestRead < digestExport && digestExport < bootstrap, 'fresh receipt digest must be exported before bootstrap');
    assert.ok(
        imageBuild < consumerEnvironment && consumerEnvironment < bootstrap,
        'bootstrap must materialize into a distinct acceptance consumer layout after the producer image is complete'
    );
    assert.match(source, /ImportProductionBuildEnvironment "\$run_id"[\s\S]*production-build-artifacts\.sh/u);
    assert.match(source, /FSUSBLOG_CI_PRODUCTION_PRODUCER_WORKFLOW="Local production"/u);
    assert.match(source, /FSUSBLOG_CI_PRODUCTION_PRODUCER_RUN_ID="\$run_id"/u);
    assert.match(source, /FSUSBLOG_CI_PRODUCTION_PRODUCER_RUN_ATTEMPT="1"/u);
    assert.match(source, /FSUSBLOG_CI_PRODUCTION_PRODUCER_JOB="production-build-artifacts"/u);
    assert.match(source, /receipt\.producer\) !== JSON\.stringify\(expectedProducer\)/u);
    assert.match(source, /candidate_receipt="\.tmp\/release-reliability\/\$\{invocation_id\}\/candidate-receipt\.json"/u);
    assert.match(source, /verified_attestation="\.tmp\/release-reliability\/\$\{invocation_id\}\/verified-attestation\.json"/u);
    assert.match(source, /--candidate "\$candidate_receipt" --attestation-out "\$verified_attestation"/u);
    assert.match(source, /--candidate "\$candidate_receipt" --attestation "\$verified_attestation"[\s\S]*--finalize-out "\$qualified_receipt"/u);
    const attest = source.indexOf('--attestation-out "$verified_attestation"');
    const cleanup = source.lastIndexOf('CleanupQualifiedRuntimeResources 0');
    const finalize = source.indexOf('--finalize-out "$qualified_receipt"');
    const terminal = source.indexOf('--receipt "$qualified_receipt"');
    assert.ok(attest >= 0 && cleanup > attest && finalize > cleanup && terminal > finalize);
    assert.match(
        source,
        /export-production-build-environment\.mjs" --root "\$root" --run-id "\$environmentRunId"/u
    );
    assert.match(source, /receipt\?\.status !== 'complete'/u);
    assert.match(source, /\^sha256:\[0-9a-f\]\{64\}\$/u);
    assert.doesNotMatch(source.slice(digestRead, digestExport), /FSUSBLOG_CI_PRODUCTION_RECEIPT_DIGEST/u);
});

test('qualified local wrapper exposes only repository-relative run identity bindings', () =>
{
    const source = fs.readFileSync(wrapper, 'utf8');
    const runner = source.indexOf('run-release-reliability-scenarios.mjs');
    const resourcePolicy = source.indexOf(
        'export FSUSBLOG_RELEASE_RESOURCE_POLICY="config/deployment/zero-downtime-resource-policy.json"'
    );
    assert.match(source, /^cd "\$root"$/mu);
    assert.match(
        source,
        /export FSUSBLOG_CI_PRODUCTION_ARTIFACT_ROOT="\.tmp\/ci-production-build\/\$run_id"/u
    );
    assert.match(source, /fixture_config="\.tmp\/env\/\$\{namespace\}\.env"/u);
    assert.match(source, /--config "\$fixture_config"/u);
    assert.match(source, /FSUSBLOG_TEST_FIXTURE_CONFIG="\$fixture_config"/u);
    assert.ok(resourcePolicy >= 0 && resourcePolicy < runner, 'resource policy must be bound before identity collection');
    assert.doesNotMatch(
        source,
        /FSUSBLOG_(?:CI_PRODUCTION_ARTIFACT_ROOT|TEST_FIXTURE_CONFIG)="\$root\//u
    );
});

test('qualified final container overrides host-bound runtime paths with a UID-owned transient mount', () =>
{
    const source = fs.readFileSync(wrapper, 'utf8');
    const start = source.indexOf('backend_container_id="$(docker run');
    const end = source.indexOf('"$image")', start);
    assert.ok(start >= 0 && end > start, 'qualified final container invocation is missing');
    const invocation = source.slice(start, end);
    assert.match(invocation, /--network "\$backend_network"/u);
    assert.doesNotMatch(invocation, /--network host/u);
    assert.match(invocation, /-p "127\.0\.0\.1:\$\{backend_host_port\}:8080"/u);
    assert.match(invocation, /--env-file "\$container_env_file"/u);
    assert.doesNotMatch(invocation, /--env-file "\$env_file"/u);
    assert.match(invocation, /--tmpfs \/app\/data:uid=1654,gid=1654,mode=0700/u);
    assert.match(invocation, /--tmpfs \/app\/\.upload-sessions:uid=1654,gid=1654,mode=0700/u);
    assert.match(invocation, /--tmpfs \/app\/runtime-cache:uid=1654,gid=1654,mode=0700/u);
    assert.equal(invocation.match(/--tmpfs /gu)?.length, 3, 'only audited instance-scoped paths may be writable tmpfs mounts');
    assert.doesNotMatch(invocation, /--tmpfs \/app(?::|\s)/u);
    assert.match(invocation, /-e FSUSBLOG_DATA_ROOT=\/app\/data/u);
    assert.match(invocation, /-e FSUSBLOG_RELEASE_DERIVED_ROOT=\/app\/release-derived/u);
    assert.match(invocation, /-e PublicAot__SsrClientRoot=\/app\/wwwroot/u);
    assert.match(invocation, /-e ASPNETCORE_URLS=http:\/\/0\.0\.0\.0:8080/u);
    assert.match(invocation, /-e "AllowedHosts=localhost;\*"/u);
    assert.doesNotMatch(invocation, /AllowedHosts=\*/u);
    assert.doesNotMatch(invocation, /AllowedHosts=127\.0\.0\.1/u);
    assert.match(invocation, /Host=postgres;Port=5432;Database=fsusblog/u);
    assert.equal(
        invocation.match(/redis:6379,abortConnect=false,connectTimeout=10000/gu)?.length,
        2
    );
    assert.match(invocation, /-e DOTNET_DbgEnableMiniDump=1/u);
    assert.match(invocation, /-e DOTNET_DbgMiniDumpType=4/u);
    assert.match(invocation, /-e DOTNET_DbgMiniDumpName=\/app\/runtime-cache\/coredump\.%p/u);
    assert.match(invocation, /-e DOTNET_EnableCrashReport=1/u);
    assert.match(invocation, /-e DOTNET_CreateDumpDiagnostics=1/u);
    assert.match(invocation, /-e DOTNET_CreateDumpLogToFile=\/app\/runtime-cache\/createdump\.log/u);
    assert.ok(
        invocation.indexOf('--env-file "$container_env_file"') < invocation.indexOf('-e FSUSBLOG_DATA_ROOT=/app/data'),
        'audited container overrides must follow the projected runtime environment'
    );
    const explicitEnvironmentKeys = [...invocation.matchAll(
        /-e "?([A-Za-z_][A-Za-z0-9_]*)=/gu
    )].map((match) => match[1]);
    assert.equal(new Set(explicitEnvironmentKeys).size, explicitEnvironmentKeys.length);
    assert.deepEqual(
        [...explicitEnvironmentKeys].sort(),
        [...releaseReliabilityAuditedContainerOverrideKeys].sort()
    );
    const projection = source.indexOf('project-container-environment');
    const dockerRun = source.indexOf('backend_container_id="$(docker run');
    assert.ok(projection >= 0 && projection < dockerRun);
    assert.doesNotMatch(invocation, /\.tmp\/(?:data|build)\//u);
    assert.doesNotMatch(invocation, /--health-cmd/u);
});

test('qualified final topology owns one bridge, waits for native health, and cleans network last', () =>
{
    const source = fs.readFileSync(wrapper, 'utf8');
    assert.match(source, /docker network create --driver bridge/u);
    assert.match(source, /--label "io\.fsusblog\.test\.run-id=\$run_id"/u);
    assert.match(source, /--label "io\.fsusblog\.test\.namespace=\$namespace"/u);
    assert.match(source, /docker network connect --alias postgres "\$backend_network" "\$postgres_container_id"/u);
    assert.match(source, /docker network connect --alias redis "\$backend_network" "\$redis_container_id"/u);
    assert.match(source, /runtime_health_deadline=\$\(\(SECONDS \+ 180\)\)/u);
    assert.match(source, /\.State\.Health\.Status/u);
    assert.match(source, /runtime_health_status" in/u);
    assert.doesNotMatch(source, /health\/ready/u);
    const backendRemoval = source.indexOf('RemoveOwnedContainer "$backend_container_id"');
    const postgresRemoval = source.indexOf('RemoveOwnedContainer "$postgres_container_id"');
    const redisRemoval = source.indexOf('RemoveOwnedContainer "$redis_container_id"');
    const networkRemoval = source.indexOf('RemoveOwnedNetwork "$backend_network_id"');
    assert.ok(
        backendRemoval >= 0
        && postgresRemoval > backendRemoval
        && redisRemoval > postgresRemoval
        && networkRemoval > redisRemoval
    );
    const healthyGate = source.indexOf('case "$runtime_health_status" in');
    const fixtureCollection = source.indexOf('collect-release-reliability-fixture.mjs');
    assert.ok(healthyGate >= 0 && fixtureCollection > healthyGate);
});

test('qualified local wrapper captures bounded crash diagnostics before removing only its owned failed backend container', () =>
{
    const source = fs.readFileSync(wrapper, 'utf8');
    const cleanup = source.indexOf('CleanupQualifiedRuntimeResources()');
    const capture = source.indexOf('CaptureOwnedBackendCrashDiagnostics "$backend_container_id"');
    const remove = source.indexOf('RemoveOwnedContainer "$backend_container_id"');
    assert.ok(cleanup >= 0 && capture > cleanup && remove > capture, 'crash diagnostics must precede backend removal');
    assert.match(source, /\[\[ "\$binding" == "\$containerId\|\$run_id\|\$namespace" \]\]/u);
    assert.match(source, /\[\[ "\$running" != "true" \|\| "\$exitCode" != "0" \]\] \|\| return 0/u);
    assert.match(source, /\.tmp\/release-reliability\/\$\{run_id\}\/crash-diagnostics/u);
    assert.match(source, /docker inspect --format '\{\{json \.State\}\}'/u);
    assert.match(source, /docker logs --tail 200/u);
    assert.match(source, /\/app\/runtime-cache\/coredump\.1\.crashreport\.json/u);
    assert.match(source, /\/app\/runtime-cache\/createdump\.log/u);
    assert.match(source, /bytes > 1048576/u);
    assert.match(source, /logBytes <= 1048576/u);
    assert.match(source, /umask 077/u);
    assert.match(source, /chmod 700/u);
    assert.doesNotMatch(source, /docker cp[^\n]*\/app\/runtime-cache\/\./u);
    assert.doesNotMatch(source, /docker cp[^\n]*coredump/u);
});

test('qualified local production environment export is exact factory parity and preserves literal values', (context) =>
{
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-qualified-production-environment-'));
    context.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
    const marker = path.join(fixtureRoot, 'command-was-executed');
    const env = {
        FSUSBLOG_ZK_PRODUCTION_ENABLED: `value with spaces "quotes" $(touch ${marker})`
    };
    const layout = resolveProductionBuildLayout({ root: fixtureRoot, runId: 'qualified-export' });
    const expected = productionBuildEnvironment(layout, env);
    const assignments = productionBuildEnvironmentAssignments({ root: fixtureRoot, runId: 'qualified-export', env });
    assert.deepEqual(assignments, productionBuildEnvironmentKeys.map((key) => [key, expected[key]]));
    const cli = spawnSync(process.execPath, [
        productionBuildEnvironmentTool,
        '--root', fixtureRoot,
        '--run-id', 'qualified-export'
    ], { encoding: 'utf8', env: { ...process.env, ...env } });
    assert.equal(cli.status, 0, cli.stderr);
    assert.deepEqual(
        cli.stdout.split('\0').filter(Boolean).map((assignment) =>
        {
            const separator = assignment.indexOf('=');
            return [assignment.slice(0, separator), assignment.slice(separator + 1)];
        }),
        assignments
    );
    assert.equal(fs.existsSync(marker), false);
    assert.equal(parseProductionBuildEnvironmentAssignment(assignments[13].join('='))[1], env.FSUSBLOG_ZK_PRODUCTION_ENABLED);
});

test('qualified local production environment export rejects malformed, duplicate, unknown, and unsafe run inputs', () =>
{
    assert.throws(() => parseProductionBuildEnvironmentAssignment('MALFORMED'), /malformed/u);
    assert.throws(() => parseProductionBuildEnvironmentAssignment('=missing-key'), /malformed/u);
    assert.throws(() => parseProductionBuildEnvironmentAssignment('UNEXPECTED=value'), /not allowed/u);
    assert.throws(() => parseProductionBuildEnvironmentAssignment('FSUSBLOG_BACKEND_SERVER_DLL='), /missing/u);
    const seen = new Set();
    parseProductionBuildEnvironmentAssignment('FSUSBLOG_BACKEND_SERVER_DLL=value', { seen });
    assert.throws(
        () => parseProductionBuildEnvironmentAssignment('FSUSBLOG_BACKEND_SERVER_DLL=value', { seen }),
        /duplicated/u
    );
    const malformedRoot = path.join(os.tmpdir(), 'fsusblog-qualified-production-environment-missing');
    const missing = spawnSync(process.execPath, [productionBuildEnvironmentTool, '--root', malformedRoot, '--run-id', 'safe-run'], { encoding: 'utf8' });
    assert.notEqual(missing.status, 0);
    const unsafe = spawnSync(process.execPath, [productionBuildEnvironmentTool, '--root', root, '--run-id', '../escape'], { encoding: 'utf8' });
    assert.notEqual(unsafe.status, 0);
    assert.match(unsafe.stderr, /unsafe production build run id/u);
});
