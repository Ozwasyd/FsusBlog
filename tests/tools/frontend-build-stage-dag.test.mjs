import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const {
    runFrontendBuildStageDag,
    validateFrontendBuildStages
} = await import(pathToFileURL(path.join(repositoryRoot, 'tools/frontend/build-stage-dag.mjs')).href);
const {
    createFrontendBuildStages,
    prepareFrontendBuildOutputRoot,
    renderStablePublicBootKernelAlias,
    renderStableSpaEntryAlias,
    resolveProductionFrontendBuildEnv,
    resolveReleaseBrowserBuildTrust
} = await import(pathToFileURL(path.join(repositoryRoot, 'tools/frontend/build.mjs')).href);

function resources(overrides = {})
{
    return {
        cpuWeight: 1,
        memoryWeight: 1,
        minCpuUnits: 1,
        minMemoryGiB: 0.25,
        exclusiveResources: [],
        ...overrides
    };
}

function stage(id, overrides = {})
{
    return {
        id,
        command: ['internal', id],
        dependsOn: [],
        consumedInputs: [],
        producedArtifacts: [],
        ownedOutputs: [],
        resources: resources(),
        estimatedDurationMs: 1,
        ...overrides
    };
}

function grantDocument(runId, cpuUnits, memoryGiB = cpuUnits)
{
    return JSON.stringify({
        schema: 'fsusblog.test-matrix.resource-grants.v1',
        runId,
        resourceBudget: { cpuUnits: Math.max(8, cpuUnits), memoryGiB: Math.max(8, memoryGiB) },
        grants: { frontend: { cpuUnits, memoryGiB } }
    });
}

function schedulerEnv(runId)
{
    return {
        ...process.env,
        FSUSBLOG_TEST_RUN_ID: runId,
        FSUSBLOG_SCHEDULER_RESOURCE_GRANT_FILE: '/virtual/frontend-grant.json',
        FSUSBLOG_SCHEDULER_RESOURCE_GRANT_TIER_ID: 'frontend'
    };
}

function deferred()
{
    let resolve;
    const promise = new Promise((complete) =>
    {
        resolve = complete;
    });
    return { promise, resolve };
}

async function waitFor(predicate, message, timeoutMs = 2_000)
{
    const deadline = Date.now() + timeoutMs;
    while (!predicate())
    {
        if (Date.now() >= deadline)
        {
            throw new Error(message);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

async function temporaryDirectory(t)
{
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fsusblog-frontend-dag-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    return directory;
}

test('production frontend build consumes the sealed runtime release identity', () =>
{
    const commitSha = 'a'.repeat(40);
    const releaseId = `20260810150827-${commitSha.slice(0, 12)}`;
    const resolved = resolveProductionFrontendBuildEnv({
        FSUSBLOG_TEST_SOURCE_COMMIT: commitSha,
        FSUSBLOG_RELEASE_ID: releaseId
    });

    assert.equal(resolved.VITE_FSUSBLOG_BUILD_ID, releaseId);
    assert.throws(
        () => resolveProductionFrontendBuildEnv({
            FSUSBLOG_TEST_SOURCE_COMMIT: commitSha,
            FSUSBLOG_RELEASE_ID: releaseId,
            VITE_FSUSBLOG_BUILD_ID: `20260810151156-${commitSha.slice(0, 12)}`
        }),
        /does not match the sealed runtime release identity/u
    );
    assert.throws(
        () => resolveProductionFrontendBuildEnv({
            FSUSBLOG_TEST_SOURCE_COMMIT: 'b'.repeat(40),
            FSUSBLOG_RELEASE_ID: releaseId
        }),
        /does not match the frontend source commit/u
    );
    assert.throws(
        () => resolveProductionFrontendBuildEnv({
            FSUSBLOG_TEST_SOURCE_COMMIT: commitSha,
            FSUSBLOG_RELEASE_ID: 'local-unversioned'
        }),
        /sealed runtime release identity is invalid/u
    );
});

test('frontend build stage validation rejects unknown dependencies and cycles', () =>
{
    assert.throws(
        () => validateFrontendBuildStages([stage('a', { dependsOn: ['missing'] })]),
        /unknown stage/u
    );
    assert.throws(
        () => validateFrontendBuildStages([
            stage('a', { dependsOn: ['b'] }),
            stage('b', { dependsOn: ['a'] })
        ]),
        /contains a cycle/u
    );
    assert.throws(
        () => validateFrontendBuildStages([
            stage('parent', { ownedOutputs: ['dist/server'] }),
            stage('child', { ownedOutputs: ['dist/server/public-shell-emergency.css'] })
        ]),
        /overlapping ownedOutputs/u
    );
    assert.throws(
        () => validateFrontendBuildStages([
            stage('owner', { producedArtifacts: ['dist/result.js'], ownedOutputs: ['dist/other.js'] })
        ]),
        /not covered by ownedOutputs/u
    );
});

test('release build declares independent prebuild stages and explicit postbuild joins', () =>
{
    const stages = validateFrontendBuildStages(createFrontendBuildStages([], 'generate', {
        frontendRoot: path.join(repositoryRoot, 'src/frontend'),
        env: process.env
    }));
    const byId = new Map(stages.map((entry) => [entry.id, entry]));

    assert.deepEqual(byId.get('generate-public-page-manifest').dependsOn, []);
    assert.deepEqual(byId.get('generate-public-shell-emergency').dependsOn, []);
    assert.ok(byId.get('generate-public-shell-emergency').command.includes('--public-only'));
    assert.deepEqual(byId.get('generate-public-shell-emergency').consumedInputs, [
        'src/assets/public-shell-foundation.css'
    ]);
    assert.deepEqual(byId.get('ensure-wasm').dependsOn, []);
    assert.deepEqual(byId.get('vue-tsc').dependsOn, ['generate-public-page-manifest']);
    assert.deepEqual(byId.get('vite-build').dependsOn, [
        'generate-public-page-manifest',
        'generate-public-shell-emergency',
        'ensure-wasm'
    ]);
    assert.equal(byId.get('vite-build').command.includes('--emptyOutDir=false'), false);
    assert.deepEqual(byId.get('vite-public-ssr-build').dependsOn, [
        'generate-public-page-manifest',
        'generate-public-shell-emergency'
    ]);
    assert.equal(byId.has('assemble-run-bound-public-shell-emergency'), false);
    assert.equal(byId.has('sync-stable-spa-entry'), false);
    assert.ok(byId.get('vite-build').producedArtifacts.some((entry) => entry.endsWith('/assets/fsus-spa-entry.js')));
    assert.ok(byId.get('vite-build').producedArtifacts.some((entry) => entry.endsWith('/assets/fsus-public-boot-kernel.js')));
    assert.ok(byId.get('vite-public-ssr-build').producedArtifacts.some((entry) => entry.endsWith('/server/public-shell-emergency.css')));
    assert.match(
        byId.get('vite-public-ssr-build').consumedInputs[2],
        /(?:FsusUI\/vue\/packages\/wasm\/dist|node_modules\/@ozwasyd\/element-plus\/es\/wasm\/dist)$/u
    );
    assert.deepEqual(
        byId.get('vite-public-ssr-build').producedArtifacts
            .filter((entry) => entry.includes('/server/dist/'))
            .map((entry) => path.basename(entry))
            .sort(),
        [
            'markdown_basic.js',
            'markdown_basic.wasm',
            'markdown_simd.js',
            'markdown_simd.wasm'
        ]
    );
    assert.deepEqual(byId.get('vite-public-ssr-build').ownedOutputs, [
        path.join(repositoryRoot, 'src/frontend/dist/server')
    ]);
    assert.deepEqual(byId.get('sync-backend-wwwroot').dependsOn, [
        'vite-build',
        'vite-public-ssr-build',
        'sync-run-bound-public-assets',
        'sync-fsusui-markdown-runtime-assets'
    ]);
    assert.match(
        byId.get('sync-fsusui-markdown-runtime-assets').consumedInputs[0],
        /(?:FsusUI\/vue\/packages\/wasm\/dist|node_modules\/@ozwasyd\/element-plus\/es\/wasm\/dist)$/u
    );
});

test('current browser build fixes only public trust before Vite and preserves the run-bound consumer', () =>
{
    const frontendRoot = path.join(repositoryRoot, 'src/frontend');
    const dist = path.join(repositoryRoot, '.tmp/build/browser-trust-dist');
    const env = {
        ...process.env,
        FSUSBLOG_FRONTEND_DIST_ROOT: dist,
        FSUSBLOG_RELEASE_BROWSER_PUBLIC_KEY: '/tmp/explicit-public-key.pem',
        FSUSBLOG_RELEASE_BROWSER_PUBLIC_KEY_SHA256: `sha256:${'a'.repeat(64)}`,
        FSUSBLOG_RELEASE_BROWSER_KEY_ID: 'release-test-key'
    };
    const stages = validateFrontendBuildStages(createFrontendBuildStages([], 'generate', { frontendRoot, env }));
    const byId = new Map(stages.map((entry) => [entry.id, entry]));
    const trust = byId.get('prepare-current-release-browser-trust');
    assert.deepEqual(trust.dependsOn, []);
    assert.deepEqual(trust.consumedInputs, [env.FSUSBLOG_RELEASE_BROWSER_PUBLIC_KEY]);
    assert.deepEqual(trust.ownedOutputs, [path.join(frontendRoot, 'public/generated/current-release-trust.js')]);
    assert.deepEqual(trust.command.slice(1), [path.join(repositoryRoot, 'tools/storage/create-release-browser-artifacts.mjs'),
        '--mode', 'trust', '--public-key', env.FSUSBLOG_RELEASE_BROWSER_PUBLIC_KEY,
        '--public-key-sha256', env.FSUSBLOG_RELEASE_BROWSER_PUBLIC_KEY_SHA256,
        '--key-id', env.FSUSBLOG_RELEASE_BROWSER_KEY_ID, '--out', trust.ownedOutputs[0]]);
    assert.ok(byId.get('vite-build').dependsOn.includes(trust.id));
    assert.ok(byId.get('sync-run-bound-public-assets').producedArtifacts.includes(path.join(dist, 'current-release-assets.js')));
    assert.ok(byId.get('sync-run-bound-public-assets').dependsOn.includes('vite-build'));
});

test('partial or malformed public build trust refuses instead of inferring a key or candidate', () =>
{
    assert.equal(resolveReleaseBrowserBuildTrust({}), null);
    const complete = {
        FSUSBLOG_RELEASE_BROWSER_PUBLIC_KEY: '/tmp/explicit-public-key.pem',
        FSUSBLOG_RELEASE_BROWSER_PUBLIC_KEY_SHA256: 'a'.repeat(64),
        FSUSBLOG_RELEASE_BROWSER_KEY_ID: 'release-test-key'
    };
    for (const missing of Object.keys(complete))
    {
        const partial = { ...complete };
        delete partial[missing];
        assert.throws(() => resolveReleaseBrowserBuildTrust(partial), /all three explicit canonical pinned public inputs/u);
    }
    for (const invalid of [
        { FSUSBLOG_RELEASE_BROWSER_PUBLIC_KEY: 'relative.pem' },
        { FSUSBLOG_RELEASE_BROWSER_PUBLIC_KEY: '/tmp/../key.pem' },
        { FSUSBLOG_RELEASE_BROWSER_PUBLIC_KEY_SHA256: 'sha256:short' },
        { FSUSBLOG_RELEASE_BROWSER_KEY_ID: 'bad key' },
        { FSUSBLOG_RELEASE_BROWSER_KEY_ID: ' release-test-key' }
    ])
    {
        assert.throws(() => resolveReleaseBrowserBuildTrust({ ...complete, ...invalid }), /all three explicit canonical pinned public inputs/u);
    }
});

test('frontend stage declarations are identical across caller cwd and bind the explicit frontend root', () =>
{
    const frontendRoot = path.join(repositoryRoot, 'src/frontend');
    const runRoot = path.join(repositoryRoot, '.tmp/build/cwd-contract');
    const env = {
        ...process.env,
        FSUSBLOG_FRONTEND_DIST_ROOT: path.join(runRoot, 'frontend/dist'),
        FSUSBLOG_FRONTEND_WASM_ROOT: path.join(runRoot, 'frontend/wasm'),
        FSUSBLOG_BACKEND_WEBROOT: path.join(runRoot, 'frontend/wwwroot'),
        FSUSBLOG_SKIP_BACKEND_WWWROOT_SYNC: '1'
    };
    const moduleUrl = pathToFileURL(path.join(repositoryRoot, 'tools/frontend/build.mjs')).href;
    const script = `
    const { createFrontendBuildStages } = await import(${JSON.stringify(moduleUrl)});
    const stages = createFrontendBuildStages([], 'generate', { frontendRoot: process.argv[1], env: process.env });
    process.stdout.write(JSON.stringify(stages.map(({ id, command, dependsOn, producedArtifacts, ownedOutputs }) => ({ id, command, dependsOn, producedArtifacts, ownedOutputs }))));
  `;
    const declarations = [repositoryRoot, frontendRoot].map((cwd) =>
    {
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, frontendRoot], {
            cwd,
            env,
            encoding: 'utf8'
        });
        assert.equal(result.status, 0, result.stderr);
        return JSON.parse(result.stdout);
    });
    assert.deepEqual(declarations[0], declarations[1]);
    const byId = new Map(declarations[0].map((stage) => [stage.id, stage]));
    assert.equal(byId.get('vue-tsc').command[0], path.join(frontendRoot, 'node_modules/.bin/vue-tsc'));
    assert.equal(byId.get('vite-build').command[0], path.join(frontendRoot, 'node_modules/.bin/vite'));
    assert.ok(byId.get('vite-build').producedArtifacts.includes(
        path.join(runRoot, 'frontend/dist/assets/fsus-spa-entry.js')
    ));
});

test('run-bound typecheck, WASM, client, and SSR work is not serialized by false artifact edges', () =>
{
    const stages = validateFrontendBuildStages(createFrontendBuildStages([], 'generate', {
        frontendRoot: path.join(repositoryRoot, 'src/frontend'),
        env: {
            ...process.env,
            FSUSBLOG_FRONTEND_DIST_ROOT: path.join(repositoryRoot, '.tmp/build/run-bound-dist'),
            FSUSBLOG_FRONTEND_WASM_ROOT: path.join(repositoryRoot, '.tmp/build/run-bound-wasm')
        }
    }));
    const byId = new Map(stages.map((entry) => [entry.id, entry]));
    assert.equal(byId.get('vue-tsc').dependsOn.includes('ensure-wasm'), false);
    assert.equal(byId.get('vite-public-ssr-build').dependsOn.includes('vue-tsc'), false);
    assert.equal(byId.get('vite-public-ssr-build').dependsOn.includes('vite-build'), false);
    assert.equal(byId.get('vite-build').dependsOn.includes('ensure-wasm'), false);
    assert.equal(byId.get('vite-build').command.includes('--emptyOutDir=false'), true);
    assert.deepEqual(byId.get('vite-build').resources.exclusiveResources, ['frontend-dist-client']);
    assert.deepEqual(byId.get('vite-public-ssr-build').resources.exclusiveResources, ['frontend-dist-server']);
    assert.deepEqual(byId.get('sync-run-bound-public-assets').resources.exclusiveResources, ['frontend-dist-wasm']);
});

test('direct fallback lets Vite clean dist and waits for public WASM input', () =>
{
    const stages = validateFrontendBuildStages(createFrontendBuildStages([], 'generate', {
        frontendRoot: path.join(repositoryRoot, 'src/frontend'),
        env: { ...process.env, FSUSBLOG_FRONTEND_DIST_ROOT: '', FSUSBLOG_FRONTEND_WASM_ROOT: '' }
    }));
    const viteBuild = stages.find((entry) => entry.id === 'vite-build');
    assert.ok(viteBuild.dependsOn.includes('ensure-wasm'));
    assert.equal(viteBuild.command.includes('--emptyOutDir=false'), false);
});

test('stable SPA entry preserves the hashed entry as the only module identity', () =>
{
    assert.equal(
        renderStableSpaEntryAlias('index-Abc_123.js'),
        "import './index-Abc_123.js';\n"
    );
    assert.throws(
        () => renderStableSpaEntryAlias('../index-escape.js'),
        /stable spa entry alias target is invalid/u
    );
});

test('stable public BootKernel entry preserves the hashed kernel as the only module identity', () =>
{
    assert.equal(
        renderStablePublicBootKernelAlias('publicBootKernel-Abc_123.js'),
        "import './publicBootKernel-Abc_123.js';\n"
    );
    assert.throws(
        () => renderStablePublicBootKernelAlias('../publicBootKernel-escape.js'),
        /stable public boot kernel alias target is invalid/u
    );
});

test('build DAG emergency generator owns only public output and leaves SSR ownership untouched', async (t) =>
{
    const temporary = await temporaryDirectory(t);
    const result = spawnSync(process.execPath, [
        path.join(repositoryRoot, 'tools/frontend/generate-public-shell-emergency.mjs'),
        '--public-only'
    ], {
        cwd: path.join(repositoryRoot, 'src/frontend'),
        env: { ...process.env, FSUSBLOG_FRONTEND_DIST_ROOT: temporary },
        encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    await assert.rejects(
        fs.stat(path.join(temporary, 'server/public-shell-emergency.css')),
        { code: 'ENOENT' }
    );
});

test('run-bound shared dist root is cleaned once before admission and client Vite cannot wipe siblings', async (t) =>
{
    const temporary = await temporaryDirectory(t);
    const dist = path.join(temporary, 'run-bound-dist');
    await fs.mkdir(path.join(dist, 'server'), { recursive: true });
    await fs.writeFile(path.join(dist, 'server/stale.js'), 'stale');
    const preparation = await prepareFrontendBuildOutputRoot({
        frontendRoot: path.join(repositoryRoot, 'src/frontend'),
        distRoot: dist,
        runBound: true
    });
    assert.equal(preparation.mode, 'run-bound-fresh-root');
    assert.equal(preparation.removedExisting, true);
    await assert.rejects(fs.stat(path.join(dist, 'server/stale.js')), { code: 'ENOENT' });
    await fs.mkdir(path.join(dist, 'server'), { recursive: true });
    await fs.writeFile(path.join(dist, 'server/current.js'), 'current');
    const stages = createFrontendBuildStages([], 'generate', {
        frontendRoot: path.join(repositoryRoot, 'src/frontend'),
        env: { ...process.env, FSUSBLOG_FRONTEND_DIST_ROOT: dist }
    });
    assert.ok(stages.find((entry) => entry.id === 'vite-build').command.includes('--emptyOutDir=false'));
    assert.equal(await fs.readFile(path.join(dist, 'server/current.js'), 'utf8'), 'current');
});

test('direct fallback keeps Vite default output preparation semantics', async (t) =>
{
    const temporary = await temporaryDirectory(t);
    const sentinel = path.join(temporary, 'sentinel.txt');
    await fs.writeFile(sentinel, 'keep');
    const preparation = await prepareFrontendBuildOutputRoot({
        frontendRoot: path.join(repositoryRoot, 'src/frontend'),
        distRoot: temporary,
        runBound: false
    });
    assert.equal(preparation.mode, 'vite-default');
    assert.equal(preparation.status, 'skipped');
    assert.equal(await fs.readFile(sentinel, 'utf8'), 'keep');
});

test('live grant growth admits additional ready frontend stages without restarting the DAG', async (t) =>
{
    const cwd = await temporaryDirectory(t);
    const runId = 'frontend-growth';
    let liveGrant = grantDocument(runId, 2, 2);
    const started = [];
    const gates = new Map(['a', 'b', 'c', 'd'].map((id) => [id, deferred()]));
    const running = runFrontendBuildStageDag([...gates.keys()].map((id) => stage(id)), {
        cwd,
        env: schedulerEnv(runId),
        receiptFile: path.join(cwd, 'receipt.json'),
        readGrantFile: () => liveGrant,
        execute: async (entry, { env }) =>
        {
            started.push({ id: entry.id, cpu: Number(env.FSUSBLOG_STEP_CPU_BUDGET) });
            await gates.get(entry.id).promise;
        }
    });

    await waitFor(() => started.length === 2, 'initial two-CPU grant did not admit two stages');
    liveGrant = grantDocument(runId, 4, 4);
    await waitFor(() => started.length === 4, 'grown grant did not admit remaining stages');
    for (const gate of gates.values())
    {
        gate.resolve();
    }
    const receipt = await running;

    assert.equal(receipt.status, 'success');
    assert.deepEqual(receipt.grantHistory.map((entry) => entry.cpuUnits), [2, 4]);
    assert.ok(started.every((entry) => entry.cpu >= 1));
});

test('live grant shrink pauses new frontend admission until active usage fits', async (t) =>
{
    const cwd = await temporaryDirectory(t);
    const runId = 'frontend-shrink';
    let liveGrant = grantDocument(runId, 4, 4);
    const started = [];
    const gates = new Map(['a', 'b', 'c', 'd', 'e'].map((id) => [id, deferred()]));
    const running = runFrontendBuildStageDag([...gates.keys()].map((id) => stage(id)), {
        cwd,
        env: schedulerEnv(runId),
        receiptFile: path.join(cwd, 'receipt.json'),
        readGrantFile: () => liveGrant,
        execute: async (entry) =>
        {
            started.push(entry.id);
            await gates.get(entry.id).promise;
        }
    });

    await waitFor(() => started.length === 4, 'initial four-CPU grant did not admit four stages');
    liveGrant = grantDocument(runId, 1, 1);
    for (const id of started.slice(0, 3))
    {
        gates.get(id).resolve();
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(started.length, 4, 'new work started while active usage exceeded the shrunken grant');
    gates.get(started[3]).resolve();
    await waitFor(() => started.length === 5, 'pending stage did not resume after capacity became free');
    gates.get('e').resolve();
    const receipt = await running;

    assert.deepEqual(receipt.grantHistory.map((entry) => entry.cpuUnits), [4, 1]);
    assert.ok(receipt.blocked.some((entry) => entry.id === 'e'));
});

test('stage children receive only their exact admitted CPU and memory share', async (t) =>
{
    const cwd = await temporaryDirectory(t);
    const seen = [];
    const receipt = await runFrontendBuildStageDag([
        stage('left', { resources: resources({ cpuWeight: 2, memoryWeight: 3 }) }),
        stage('right', { resources: resources({ cpuWeight: 1, memoryWeight: 1 }) })
    ], {
        cwd,
        env: {
            ...process.env,
            FSUSBLOG_STEP_CPU_BUDGET: '3',
            FSUSBLOG_STEP_MEMORY_GIB: '4'
        },
        receiptFile: path.join(cwd, 'receipt.json'),
        execute: async (entry, { env }) => seen.push({
            id: entry.id,
            cpu: Number(env.FSUSBLOG_STEP_CPU_BUDGET),
            memory: Number(env.FSUSBLOG_STEP_MEMORY_GIB),
            workers: Number(env.FSUSBLOG_NODE_TEST_CONCURRENCY),
            uv: Number(env.UV_THREADPOOL_SIZE)
        })
    });

    assert.equal(seen.reduce((sum, entry) => sum + entry.cpu, 0), 3);
    assert.ok(seen.reduce((sum, entry) => sum + entry.memory, 0) <= 4);
    for (const entry of seen)
    {
        assert.equal(entry.workers, Math.max(1, Math.floor(entry.cpu)));
        assert.equal(entry.uv, entry.workers);
        const recorded = receipt.stages.find((stage) => stage.id === entry.id);
        assert.equal(entry.cpu, recorded.grant.cpuUnits);
        assert.equal(entry.memory, recorded.grant.memoryGiB);
    }
});

test('successful receipt records deterministic output digests and direct fallback', async (t) =>
{
    const cwd = await temporaryDirectory(t);
    const receiptFile = path.join(cwd, 'receipt.json');
    const receipt = await runFrontendBuildStageDag([
        stage('write-output', { ownedOutputs: ['dist/result.txt'] })
    ], {
        cwd,
        env: {
            ...process.env,
            FSUSBLOG_STEP_CPU_BUDGET: '1',
            FSUSBLOG_STEP_MEMORY_GIB: '1'
        },
        receiptFile,
        execute: async () =>
        {
            await fs.mkdir(path.join(cwd, 'dist'), { recursive: true });
            await fs.writeFile(path.join(cwd, 'dist/result.txt'), 'frontend-stage-output\n');
        }
    });

    assert.equal(receipt.executionMode, 'direct-fallback');
    assert.equal(receipt.grantSource, 'direct-invocation-fallback');
    assert.match(receipt.stages[0].outputs['dist/result.txt'].sha256, /^sha256:[a-f0-9]{64}$/u);
    assert.deepEqual(receipt.stages[0].producedArtifacts, []);
    assert.deepEqual(receipt.diagnostics.criticalPath.stageIds, ['write-output']);
    assert.ok(receipt.diagnostics.resourceWork.cpuMilliseconds >= 0);
    assert.equal(receipt.diagnostics.resourceWork.producedArtifactBytes, 0);
    assert.ok(receipt.diagnostics.waitReasons.every((entry) => Array.isArray(entry.observations)));
    assert.deepEqual(JSON.parse(await fs.readFile(receiptFile, 'utf8')), receipt);
});

test('failure preserves the original error, writes a partial receipt, and cleans partial outputs', async (t) =>
{
    const cwd = await temporaryDirectory(t);
    const receiptFile = path.join(cwd, 'receipt.json');
    const output = path.join(cwd, 'dist/partial.txt');
    let cleanupCalled = false;

    await assert.rejects(runFrontendBuildStageDag([
        stage('failing-stage', { ownedOutputs: ['dist/partial.txt'] })
    ], {
        cwd,
        env: { ...process.env, FSUSBLOG_STEP_CPU_BUDGET: '1', FSUSBLOG_STEP_MEMORY_GIB: '1' },
        receiptFile,
        execute: async () =>
        {
            await fs.mkdir(path.dirname(output), { recursive: true });
            await fs.writeFile(output, 'partial');
            throw new Error('intentional stage failure');
        },
        cleanupPartialOutputs: async () =>
        {
            cleanupCalled = true;
            await fs.rm(path.join(cwd, 'dist'), { recursive: true, force: true });
            return { status: 'success' };
        }
    }), /intentional stage failure/u);

    const receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8'));
    assert.equal(cleanupCalled, true);
    assert.equal(receipt.status, 'partial');
    assert.equal(receipt.stages[0].status, 'failure');
    assert.match(receipt.stages[0].outputs['dist/partial.txt'].sha256, /^sha256:/u);
    await assert.rejects(fs.stat(output), { code: 'ENOENT' });
});

test('wrong-run live grants fail closed before any frontend stage starts', async (t) =>
{
    const cwd = await temporaryDirectory(t);
    const receiptFile = path.join(cwd, 'receipt.json');
    let executions = 0;
    await assert.rejects(runFrontendBuildStageDag([stage('never-started')], {
        cwd,
        env: schedulerEnv('expected-run'),
        receiptFile,
        readGrantFile: () => grantDocument('stale-run', 2, 2),
        execute: async () =>
        {
            executions += 1;
        }
    }), /runId mismatch/u);

    assert.equal(executions, 0);
    const receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8'));
    assert.equal(receipt.status, 'partial');
    assert.equal(receipt.stages[0].status, 'blocked-or-not-admitted');
});

test('corrupt live grants fail closed and replace any stale successful receipt', async (t) =>
{
    const cwd = await temporaryDirectory(t);
    const receiptFile = path.join(cwd, 'receipt.json');
    await fs.writeFile(receiptFile, '{"status":"success","stale":true}\n');
    let executions = 0;

    await assert.rejects(runFrontendBuildStageDag([stage('never-started')], {
        cwd,
        env: schedulerEnv('corrupt-run'),
        receiptFile,
        readGrantFile: () => '{not-json',
        execute: async () =>
        {
            executions += 1;
        }
    }), /grant is unreadable/u);

    assert.equal(executions, 0);
    const receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8'));
    assert.equal(receipt.status, 'partial');
    assert.equal(receipt.stale, undefined);
});
