import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, link, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// eslint-disable-next-line import-x/no-relative-parent-imports -- The contract test hashes fixture projections with the canonical receipt digest.
import { digestCanonical } from '../../tools/test-fixtures/receipt/canonical.mjs';
import {
    BrowserContractFailure,
    browserContractReceiptSchema,
    browserContractScenarios,
    classifyBrowserContractFailure,
    createBrowserContractReceipt,
    browserContractFixedFixtureTopology,
    browserContractFixtureAdapterSchema,
    fixtureReceiptView,
    loadBrowserContractFixture,
    resolveBrowserContractRunIdentity,
    selectBrowserContractScenarios
// eslint-disable-next-line import-x/no-relative-parent-imports -- The static contract test exercises the browser-contract facade owned by its sibling suite.
} from '../browser-contract/fixture.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const invariantRegistryFile = path.join(root, 'tests/browser-contract/invariant-owners.json');

// Explicit Node file-I/O models only; none of these inputs represent a browser execution.
async function sceneOriginalSinkModel(t, sceneFields = {})
{
    const { writePrivateJson, readPrivateJson } = await import(new URL('../../tools/test-fixtures/receipt/private-io.mjs', import.meta.url));
    const { gateDigest } = await import(new URL('../../tools/test-matrix/public-shell-locale-gate.mjs', import.meta.url));
    const { derivePublicShellLocaleRootIdentity } = await import(new URL('../../tools/test-matrix/public-shell-locale-evidence.mjs', import.meta.url));
    const runs = path.join(root, '.tmp/browser-contract/runs');
    await mkdir(runs, { recursive: true, mode: 0o700 });
    const directory = await realpath(await mkdtemp(path.join(runs, 'node-scene-original-model-')));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const namespace = path.basename(directory);
    const preparation = { id: 'cb10d681-ef3b-4b55-8e7d-6043f1ec1c24', startedAt: '2026-10-05T00:00:00.000Z' };
    const scene = { id: 'node-model/normal', authActionContext: 'anonymous', route: 'Home', requiredDomains: [], ...sceneFields };
    const matrix = {
        schema: 'fsusblog.public-shell-locale-matrix.v1', contentDigest: 'c'.repeat(64), scenes: [scene],
        identity: { sourceCommit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64), refs: [], catalogDigest: 'f'.repeat(64) },
        fontPlan: { digest: 'e'.repeat(64) }
    };
    const planBody = {
        schema: 'fsusblog.playwright-browser-identity.v1', executionClass: 'correctness', evidenceClass: 'browser-contract',
        qualificationEligible: true, managedExecutable: true, browserName: 'chromium', browserVersion: '140.0.0.0', revision: '1200',
        executablePath: '/node-contract-model/chromium-1200/chrome', executableSha256: `sha256:${'a'.repeat(64)}`,
        playwright: { package: '@playwright/test', version: '1.55.0', packageDigest: `sha256:${'b'.repeat(64)}`, browserCatalogDigest: `sha256:${'c'.repeat(64)}` },
        launchOptions: { headless: true, executablePath: '/node-contract-model/chromium-1200/chrome', args: ['--use-gl=angle'] },
        rendering: { fontSetDigest: `sha256:${'d'.repeat(64)}`, localeDataDigest: `sha256:${'e'.repeat(64)}`,
            locale: 'en-US', deviceScaleFactor: 1, renderingMode: 'headless', colorScheme: 'light', gpuMode: 'software' }
    };
    const plan = { ...planBody, contentDigest: `sha256:${gateDigest(planBody)}` };
    const actualBody = { ...planBody, schema: 'fsusblog.playwright-browser-actual.v1', planDigest: plan.contentDigest,
        renderingObservation: { locale: 'en-US', deviceScaleFactor: 1, colorScheme: 'light', renderer: 'swiftshader' } };
    const binding = {
        schema: 'fsusblog.public-shell-locale-root-binding.v1', matrixDigest: matrix.contentDigest,
        sourceState: { commit: matrix.identity.sourceCommit, worktreeFingerprint: matrix.identity.worktreeFingerprint },
        buildDigest: 'd'.repeat(64), identity: { commit: matrix.identity.sourceCommit, runId: 'node-model-run', laneId: 'browser-contract', namespace },
        preparation, resources: { fixtureRoot: directory, databaseInstance: 'node-model-pg', databaseSchema: 'public',
            redisInstance: 'node-model-redis', redisNamespace: namespace }, runtimeId: 'node-model-runtime',
        fixtureReceiptDigest: `sha256:${'e'.repeat(64)}`, plan,
        actual: { ...actualBody, contentDigest: `sha256:${gateDigest(actualBody)}` }, launchOrdinal: 1,
        refs: ['provider-state', 'fixture-manifest', 'prepare-state', 'fixture-receipt', 'build-receipt', 'browser-plan', 'browser-actual', 'cookie-source']
            .map((role) => ({ role, path: `.tmp/browser-contract/runs/${namespace}/bindings/${preparation.id}/${role}.json`, digest: gateDigest({ role }) }))
    };
    const bindingFile = path.join(directory, 'bindings', preparation.id, 'root-binding.json');
    const providerRef = binding.refs.find((ref) => ref.role === 'provider-state');
    providerRef.digest = writePrivateJson(path.join(root, providerRef.path), {
        runtimeRunId: binding.runtimeId, runtime: { frontendUrl: 'http://127.0.0.1:3000', backendUrl: 'http://127.0.0.1:7568' }
    }, { overwrite: false }).contentDigest;
    const published = writePrivateJson(bindingFile, binding, { overwrite: false });
    const rootBinding = { binding, identity: derivePublicShellLocaleRootIdentity(matrix, binding),
        artifact: path.relative(root, bindingFile).replaceAll(path.sep, '/'), digest: published.contentDigest };
    const identity = { matrixDigest: matrix.contentDigest, sourceState: binding.sourceState, buildDigest: binding.buildDigest,
        namespace, preparationId: preparation.id };
    const lease = {
        leaseId: '11111111-1111-4111-8111-111111111111', actorId: '22222222-2222-4222-8222-222222222222',
        contextId: '33333333-3333-4333-8333-333333333333', sceneId: scene.id, role: scene.authActionContext,
        owner: { identity: binding.identity, preparation, sourceState: binding.sourceState, buildDigest: binding.buildDigest,
            fixtureRoot: directory, resources: binding.resources },
        authority: { matrixDigest: matrix.contentDigest, runtimeRunId: binding.runtimeId, fixtureReceiptDigest: binding.fixtureReceiptDigest,
            runtime: { frontendUrl: 'http://127.0.0.1:3000', backendUrl: 'http://127.0.0.1:7568' },
            inputs: { viewport: { width: 960, height: 640 }, javaScriptEnabled: true, acceptLanguage: null, cookie: null, cookieName: 'node-cookie' },
            rawRefs: binding.refs.filter((ref) => ['provider-state', 'fixture-manifest', 'prepare-state', 'fixture-receipt', 'cookie-source'].includes(ref.role))
                .map((ref) => ({ path: ref.role === 'cookie-source' ? 'src/backend/Infrastructure/PublicAot/LocalePreferenceCookieService.cs'
                    : `${ref.role === 'fixture-manifest' ? 'contract-fixture' : ref.role}.json`, digest: ref.digest })) },
        status: 'prepared', entered: 0, ended: 0
    };
    const evidence = { identity, sceneId: scene.id, captureCut: 0, issues: [] };
    const privateOriginals = { binding: { identity, sceneId: scene.id }, captureCut: 0, originals: [], failures: [], overflow: false };
    return { directory, bindingFile, matrix, scene, lease, rootBinding, evidence, privateOriginals, readPrivateJson, writePrivateJson,
        options()
        {
            return { matrix: this.matrix, scene: this.scene, lease: this.lease, rootBinding: this.rootBinding };
        },
        input: () => ({ lease, evidence, privateOriginals, failure: null, page: { toJSON: () => assert.fail('page must not be serialized') } }) };
}

async function loadSceneOriginalSink()
{
    const runner = await readFile(path.join(root, 'tests/browser-contract/run.mjs'), 'utf8');
    assert.match(runner, /export function createPublicShellLocaleOriginalSink\(/u, 'original runner must own the actual sink');
    const before = ['SIGTERM', 'SIGINT'].map((signal) => process.listenerCount(signal));
    const runnerModule = await import(new URL('../browser-contract/run.mjs', import.meta.url));
    assert.deepEqual(['SIGTERM', 'SIGINT'].map((signal) => process.listenerCount(signal)), before,
        'importing the storage boundary must not register the runner signal lifecycle');
    return runnerModule.createPublicShellLocaleOriginalSink;
}

test('browser contract invariant registry assigns one canonical owner per layer', async () =>
{
    const registry = JSON.parse(await readFile(invariantRegistryFile, 'utf8'));
    assert.equal(registry.schema, 'fsusblog.browser-contract-invariant-owners.v1');
    assert.ok(Array.isArray(registry.invariants));
    assert.ok(registry.invariants.length > 0);
    assert.equal(new Set(registry.invariants.map((entry) => entry.id)).size, registry.invariants.length);

    const ownerKeys = registry.invariants.map((entry) => `${entry.owner.file}#${entry.owner.test}`);
    assert.equal(new Set(ownerKeys).size, ownerKeys.length);
    const ownerSources = new Map();
    for (const invariant of registry.invariants)
    {
        assert.ok(['static', 'dynamic'].includes(invariant.layer), `${invariant.id} has an invalid layer`);
        const expectedFile = invariant.layer === 'static'
            ? 'tests/tools/browser-contract.test.mjs'
            : 'tests/browser-contract/fixture-lifecycle.test.mjs';
        assert.equal(invariant.owner.file, expectedFile, `${invariant.id} is owned by the wrong layer`);
        if (!ownerSources.has(invariant.owner.file))
        {
            ownerSources.set(invariant.owner.file, await readFile(path.join(root, invariant.owner.file), 'utf8'));
        }
        const ownerSource = ownerSources.get(invariant.owner.file);
        assert.ok(ownerSource.includes(`test('${invariant.owner.test}'`), `${invariant.id} owner test is missing`);
    }
    for (const [ownerFile, ownerSource] of ownerSources)
    {
        const discovered = [...ownerSource.matchAll(/^test\('([^']+)'/gmu)].map((match) => match[1]).sort();
        const registered = registry.invariants
            .filter((entry) => entry.owner.file === ownerFile)
            .map((entry) => entry.owner.test)
            .sort();
        assert.deepEqual(registered, discovered, `${ownerFile} has an unregistered or stale top-level owner`);
    }
});

test('browser contract declarative topology rejects noncanonical session configuration', () =>
{
    const env = {
        FSUSBLOG_PLAYWRIGHT_SESSION_MODE: 'browser-contract',
        FSUSBLOG_BROWSER_CONTRACT_SESSIONS: '1',
        FSUSBLOG_BROWSER_CONTRACT_CONCURRENCY: '1',
        FSUSBLOG_BROWSER_CONTRACT_RUN_ID: 'static-topology-contract',
        FSUSBLOG_TEST_SOURCE_COMMIT: 'a'.repeat(40),
        FSUSBLOG_TEST_SOURCE_FINGERPRINT: 'b'.repeat(64)
    };
    assert.deepEqual(browserContractFixedFixtureTopology, { sessions: 1, concurrency: 1 });
    const identity = resolveBrowserContractRunIdentity({ env, repoRoot: root });
    assert.equal(identity.sessions, 1);
    assert.equal(identity.concurrency, 1);

    for (const invalid of [
        { FSUSBLOG_BROWSER_CONTRACT_SESSIONS: '2' },
        { FSUSBLOG_BROWSER_CONTRACT_CONCURRENCY: '2' },
        { FSUSBLOG_PLAYWRIGHT_SESSION_MODE: 'browser-diagnostics' }
    ])
    {
        assert.throws(
            () => resolveBrowserContractRunIdentity({ env: { ...env, ...invalid }, repoRoot: root }),
            /fixed at 1 session|requires browser-contract session mode/u
        );
    }
});

test('release browser contract exposes a six-scenario catalog with fixed serial metadata', () =>
{
    assert.equal(browserContractScenarios.length, 6);
    assert.equal(new Set(browserContractScenarios.map((scenario) => scenario.id)).size, 6);
    assert.deepEqual(browserContractScenarios.map((scenario) => scenario.capability), [
        'public-hydration',
        'account-session',
        'admin-session',
        'critical-write',
        'webauthn',
        'service-worker'
    ]);
    assert.equal(browserContractScenarios.filter((scenario) => scenario.role === 'user').length, 2);
    assert.equal(browserContractScenarios.filter((scenario) => scenario.role === 'admin').length, 2);
});

test('immutable fixture capability selects five baseline scenarios or the sixth WebAuthn success path', () =>
{
    const baseline = selectBrowserContractScenarios({ webAuthnRegistration: false });
    const webAuthnReady = selectBrowserContractScenarios({ webAuthnRegistration: true });
    assert.equal(baseline.length, 5);
    assert.equal(baseline.some((scenario) => scenario.capability === 'webauthn'), false);
    assert.equal(webAuthnReady.length, 6);
    assert.equal(webAuthnReady.some((scenario) => scenario.capability === 'webauthn'), true);
});

test('receipt exposes one managed Chromium, zero retries, and exact scenario IDs', async () =>
{
    const runIdentity = {
        runId: 'release-run-42',
        namespace: 'bc-aaaaaaaa-0123456789-abcdef',
        commit: 'a'.repeat(40),
        laneId: 'browser-contract'
    };
    const receipt = createBrowserContractReceipt({
        sourceState: { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) },
        build: { receiptContentDigest: `sha256:${'c'.repeat(64)}` },
        fixture: {
            namespace: runIdentity.namespace,
            lifecycle: {
                identity: runIdentity
            }
        },
        playwright: { chromiumRevision: '1234' }
    });
    receipt.topology.browserLaunchCount = 1;
    receipt.topology.maxConcurrentBrowserRoots = 1;
    receipt.topology.contextCount = browserContractScenarios.length;

    assert.equal(receipt.schema, browserContractReceiptSchema);
    assert.equal(receipt.topology.runner, 'playwright-library');
    assert.equal(receipt.topology.managedBrowser, true);
    assert.equal(receipt.topology.workerPool, false);
    assert.equal(receipt.topology.shard, null);
    assert.equal(receipt.topology.retries, 0);
    assert.equal(receipt.topology.browserLaunchCount, 1);
    assert.equal(receipt.topology.maxConcurrentBrowserRoots, 1);
    assert.equal(receipt.topology.contextCount, 6);
    assert.deepEqual(receipt.runIdentity, runIdentity);
    assert.deepEqual(receipt.scenarios.map((scenario) => scenario.id), browserContractScenarios.map((scenario) => scenario.id));

    // A Node contract model, not an executed browser matrix. Locale contexts are
    // counted separately without weakening the original product-context equation.
    const { projectBrowserContractLocaleTopology, validateBrowserContractLocaleTopology } = await import(
        new URL('../../tools/release/browser-contract-receipt-contract.mjs', import.meta.url)
    );
    const matrix = {
        contentDigest: 'd'.repeat(64),
        identity: { sourceCommit: runIdentity.commit, worktreeFingerprint: 'b'.repeat(64) },
        scenes: [390, 1440].map((width) => ({ id: `2083/en-US/exact/Home/anonymous/${width}/first-response` }))
    };
    const owner = {
        identity: runIdentity,
        sourceState: receipt.sourceState,
        buildDigest: receipt.build.receiptContentDigest,
        preparation: { id: 'node-contract-model-preparation' },
        fixtureRoot: '/node-contract-model/private-fixture'
    };
    const bindings = {
        owner,
        contentDigest: 'e'.repeat(64),
        blocked: [],
        leases: matrix.scenes.map((scene, index) => ({
            sceneId: scene.id, contextId: `context-${index}`, leaseId: `lease-${index}`,
            owner, authority: { matrixDigest: matrix.contentDigest },
            status: 'finished', entered: 1, ended: 1, firstFailure: null
        }))
    };
    const topology = projectBrowserContractLocaleTopology({ matrix, bindings, expectedOwner: owner });
    assert.equal(topology.matrixDigest, `sha256:${matrix.contentDigest}`);
    for (const contentDigest of [`sha256:${matrix.contentDigest}`, 'd'.repeat(63), 'D'.repeat(64), null])
    {
        assert.throws(() => projectBrowserContractLocaleTopology({
            matrix: { ...matrix, contentDigest }, bindings, expectedOwner: owner
        }), /matrix or current owner identity is invalid/u);
    }
    assert.ok(validateBrowserContractLocaleTopology({ ...topology, matrixDigest: matrix.contentDigest }).length > 0);
    assert.equal(topology.contextCount, 2);
    assert.equal(topology.endedContextCount, 2);
    assert.deepEqual(topology.requiredSceneIds, matrix.scenes.map((scene) => scene.id));
    assert.deepEqual(validateBrowserContractLocaleTopology(topology, { requireSuccess: true }), []);
    for (const mutate of [
        (value) => value.contexts[0] = null,
        (value) => value.contexts[0].status = 'invented',
        (value) => value.contexts[0].status = { valueOf: null, toString: null },
        (value) => value.contexts[0].entered = { valueOf: null, toString: null },
        (value) => value.contexts[0].ended = 0,
        (value) => value.contexts[0].hiddenContextCount = 1,
        (value) => value.hiddenContextCount = 1,
        (value) => value.blockedSceneIds = null
    ])
    {
        const candidate = structuredClone(topology);
        mutate(candidate);
        assert.ok(validateBrowserContractLocaleTopology(candidate, { requireSuccess: true }).length > 0);
    }
    const missing = projectBrowserContractLocaleTopology({ matrix, bindings: null, expectedOwner: owner });
    assert.equal(missing.contextCount, 0);
    assert.ok(validateBrowserContractLocaleTopology(missing, { requireSuccess: true }).length > 0);
    const unclosed = structuredClone(bindings);
    Object.assign(unclosed.leases[0], { status: 'entered', ended: 0 });
    assert.ok(validateBrowserContractLocaleTopology(
        projectBrowserContractLocaleTopology({ matrix, bindings: unclosed, expectedOwner: owner }),
        { requireSuccess: true }
    ).length > 0);
    const priorFailure = structuredClone(bindings);
    priorFailure.leases[0].firstFailure = { message: 'retained first scene failure' };
    assert.ok(validateBrowserContractLocaleTopology(
        projectBrowserContractLocaleTopology({ matrix, bindings: priorFailure, expectedOwner: owner }),
        { requireSuccess: true }
    ).length > 0);
    for (const mutate of [
        (value) => value.leases.push(structuredClone(value.leases[0])),
        (value) => value.leases[0].sceneId = 'unregistered-extra-scene',
        (value) => value.owner.buildDigest = `sha256:${'f'.repeat(64)}`,
        (value) => value.leases[0].authority.matrixDigest = `sha256:${'f'.repeat(64)}`
    ])
    {
        const candidate = structuredClone(bindings);
        mutate(candidate);
        assert.throws(() => projectBrowserContractLocaleTopology({ matrix, bindings: candidate, expectedOwner: owner }));
    }
    assert.equal(receipt.topology.contextCount, browserContractScenarios.length);
});

test('failure classification keeps browser crashes separate from product and contract failures', () =>
{
    assert.equal(classifyBrowserContractFailure(new BrowserContractFailure('fixture missing', 'contract')), 'contract');
    assert.equal(classifyBrowserContractFailure(new BrowserContractFailure('publish request failed', 'product')), 'product');
    assert.equal(classifyBrowserContractFailure(new Error('Target page, context or browser has been closed')), 'infra');
    assert.equal(classifyBrowserContractFailure(new Error('ordinary assertion mismatch')), 'product');
});

test('fixture adapter consumes one immutable namespace without exposing infrastructure commands', async (context) =>
{
    const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'fsus-browser-contract-')));
    context.after(async () =>
    {
        await rm(directory, { recursive: true, force: true });
    });
    const authDirectory = path.join(directory, 'auth');
    await mkdir(authDirectory, { recursive: true });
    const publicProjection = {
        schema: 'fsusblog.prepared-public-id-projection.v1',
        authority: 'derived-from-current-run-prepared-public-content',
        notAuthoritative: true,
        evidenceUse: 'navigation-input-only',
        sourcePrepareStateDigest: `sha256:${'a'.repeat(64)}`,
        namespace: 'contract-one',
        articleId: '17',
        articleTitle: 'Contract article',
        categoryId: '3',
        tagId: '4',
        searchKeyword: 'Contract',
        entities: [
            { producerId: 'public-content', kind: 'article', id: '17', handle: 'Contract article', variantId: null },
            { producerId: 'public-content', kind: 'category', id: '3', handle: 'Contract category', variantId: null },
            { producerId: 'public-content', kind: 'tag', id: '4', handle: 'Contract tag', variantId: null }
        ],
        projectionDigest: null
    };
    publicProjection.projectionDigest = digestCanonical({
        ...publicProjection,
        projectionDigest: undefined
    });
    await writeFile(
        path.join(directory, 'public-content-projection.json'),
        `${JSON.stringify(publicProjection, null, 2)}\n`
    );
    await writeFile(path.join(authDirectory, 'auth-fixtures.json'), JSON.stringify({
        generatedAt: '2026-07-16T00:00:00.000Z',
        user: { id: 21, storageStateFile: 'user.storage-state.json' },
        admin: { id: 22, storageStateFile: 'admin.storage-state.json' }
    }));
    const userStorageState = JSON.stringify({
        cookies: [
            {
                name: '__Host-AccessToken',
                value: 'secure-token',
                url: 'https://127.0.0.1:27231',
                path: '/',
                secure: true,
                httpOnly: true,
                sameSite: 'Strict'
            },
            {
                name: 'AccessToken',
                value: 'portable-token',
                url: 'http://127.0.0.1:27231',
                path: '/',
                secure: false,
                httpOnly: true,
                sameSite: 'Lax',
                expires: 1709337599
            }
        ],
        origins: []
    });
    const adminStorageState = JSON.stringify({
        cookies: [{
            name: 'AdminAccessToken',
            value: 'portable-admin-token',
            url: 'http://127.0.0.1:27231',
            path: '/',
            secure: false,
            httpOnly: true,
            sameSite: 'Lax',
            expires: 1709337599
        }],
        origins: []
    });
    await writeFile(path.join(authDirectory, 'user.storage-state.json'), userStorageState);
    await writeFile(path.join(authDirectory, 'admin.storage-state.json'), adminStorageState);

    const fixture = await loadBrowserContractFixture({
        repoRoot: root,
        env: {
            FSUSBLOG_FIXTURE_ROOT: directory,
            FSUSBLOG_TEST_NAMESPACE: 'contract-one',
            PLAYWRIGHT_BASE_URL: 'http://127.0.0.1:3000',
            FSUSBLOG_BASE_URL: 'http://127.0.0.1:7568'
        }
    });
    const view = fixtureReceiptView(fixture, root);
    assert.equal(fixture.schema, browserContractFixtureAdapterSchema);
    assert.equal(fixture.namespace, 'contract-one');
    assert.equal(fixture.publicArticle.id, '17');
    assert.equal(view.userId, 21);
    assert.equal(view.adminId, 22);
    assert.deepEqual(view.capabilities, { webAuthnRegistration: false });
    assert.equal('cookies' in view, false);
    assert.deepEqual(fixture.user.storageState.cookies, [{
        name: 'AccessToken',
        value: 'portable-token',
        url: 'http://127.0.0.1:3000',
        secure: false,
        httpOnly: true,
        sameSite: 'Lax'
    }]);
    assert.deepEqual(fixture.admin.storageState.cookies, [
        ...fixture.user.storageState.cookies,
        {
            name: 'AdminAccessToken',
            value: 'portable-admin-token',
            url: 'http://127.0.0.1:3000',
            secure: false,
            httpOnly: true,
            sameSite: 'Lax'
        }
    ]);
});

test('runner source enforces one managed launch, one context factory, and process-group timeout', async () =>
{
    const [runner, scenarios, fixture, lifecycle, prepareFacade, defaultProvider, lane,
        postgresInitializer, runtimeTemporalContext] = await Promise.all([
        readFile(path.join(root, 'tests/browser-contract/run.mjs'), 'utf8'),
        readFile(path.join(root, 'tests/browser-contract/scenarios.mjs'), 'utf8'),
        readFile(path.join(root, 'tests/browser-contract/fixture.mjs'), 'utf8'),
        readFile(path.join(root, 'tests/browser-contract/fixture-lifecycle.mjs'), 'utf8'),
        readFile(path.join(root, 'tests/browser-contract/prepare-fixture.mjs'), 'utf8'),
        readFile(path.join(root, 'tests/browser-contract/default-fixture-provider.mjs'), 'utf8'),
        readFile(path.join(root, 'tools/test/lanes/browser-contract.sh'), 'utf8'),
        readFile(path.join(root, 'src/backend/Infrastructure/Helpers/Initializer/SqlSugarInitializer.cs'), 'utf8'),
        readFile(path.join(root, 'src/backend/Infrastructure/Testing/TestTemporalRuntimeContext.cs'), 'utf8')
    ]);

    assert.equal((runner.match(/managed\.chromium\.launch\(/gu) ?? []).length, 1);
    assert.equal((runner.match(/browser\.newContext\(/gu) ?? []).length, 1);
    assert.match(runner, /browser\.on\('disconnected'/u);
    assert.match(runner, /verifyProductionBuildReceipt/u);
    assert.match(runner, /createCorrectnessBrowserPlan/u);
    assert.match(runner, /observeCorrectnessBrowser/u);
    assert.match(runner, /await applyBrowserTemporalClock\(temporalContext, page\)/u);
    assert.match(runner, /browserBusinessEpochUtc: new Date\(\)\.toISOString\(\)/u);
    assert.ok(runner.indexOf('await applyBrowserTemporalClock(temporalContext, page)')
        < runner.indexOf('const browserObservation = await page.evaluate'));
    assert.ok(runner.indexOf('browserTemporalObservation = observeBrowserTemporalContext')
        < runner.indexOf('await runner({ browser, context, page'));
    assert.doesNotMatch(runner, /page\.clock\.(?:install|pauseAt|fastForward)\(/u);
    assert.match(runner, /productFailures\.push/u);
    assert.match(runner, /scenarioReceipt\.classification === 'product'/u);
    assert.doesNotMatch(runner, /max(?:imum)?[-_ ]?(?:errors|failures)|failFast/iu);
    assert.doesNotMatch(runner, /executablePath\s*:|system-chromium|resolveSystemChromium/u);
    assert.doesNotMatch(runner, /os\.(?:loadavg|freemem)|resolve-playwright-workers|FSUSBLOG_PLAYWRIGHT_WORKERS|TEST_PARALLEL_INDEX/u);
    assert.doesNotMatch(`${scenarios}\n${fixture}`, /node:child_process|\bdocker\b|\bpsql\b|\bredis-cli\b/u);
    assert.match(lane, /timeout --signal=TERM --kill-after=15s/u);
    assert.match(lane, /CONTRACT_TIMEOUT="\$\{FSUSBLOG_BROWSER_CONTRACT_TIMEOUT:-9m\}"/u);
    assert.match(lane, /FSUSBLOG_BROWSER_CONTRACT_FIXTURE_PROVIDER[^\n]+default-fixture-provider\.mjs/u);
    assert.doesNotMatch(lane, /npx\s+playwright\s+test|--workers|--shard/u);
    assert.match(lifecycle, /FSUSBLOG_BROWSER_CONTRACT_PROVIDER_INVOCATION_ID/u);
    assert.match(lifecycle, /providerProcessGroupIsOwned/u);
    assert.match(lifecycle, /FSUSBLOG_BROWSER_CONTRACT_PROVIDER_TIMEOUT_MS/u);
    assert.match(lifecycle, /FSUSBLOG_BROWSER_CONTRACT_CLEANUP_TIMEOUT_MS/u);
    assert.match(lifecycle, /\? 300_000\s*:\s*30_000/u);
    assert.match(prepareFacade, /export async function prepareSingleBrowserContractFixture/u);
    assert.match(prepareFacade, /export async function cleanupSingleBrowserContractFixture/u);
    assert.doesNotMatch(prepareFacade, /isMain|process\.argv|pathToFileURL|#!\/usr\/bin\/env/u);
    assert.match(defaultProvider, /testSessionHeader:\s*false/u);
    assert.match(defaultProvider, /databaseSchema !== 'public'/u);
    assert.match(defaultProvider, /databaseInstance !== `fsusblog-test-postgres-\$\{namespace\}`/u);
    assert.match(defaultProvider, /redisInstance !== `fsusblog-test-redis-\$\{namespace\}`/u);
    assert.match(defaultProvider, /FSUSBLOG_PLAYWRIGHT_WORKERS:\s*'1'/u);
    assert.match(defaultProvider, /dedicatedTerminationGraceMs:\s*8_000/u);
    assert.match(defaultProvider, /FSUSBLOG_PLAYWRIGHT_SESSION_PREP_CONCURRENCY:\s*'1'/u);
    assert.match(defaultProvider, /FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME:\s*'1'/u);
    assert.match(defaultProvider, /FSUSBLOG_BROWSER_CONTRACT_PREPARATION_ID:\s*request\.preparation\.id/u);
    assert.match(defaultProvider, /io\.fsusblog\.test\.preparation-id/u);
    assert.match(defaultProvider, /phase:\s*'preparing'/u);
    assert.match(defaultProvider, /phase:\s*'prepared'/u);
    assert.match(defaultProvider, /FSUSBLOG_TEMPORAL_CONTEXT_JSON:\s*JSON\.stringify\(temporal\.context\)/u);
    assert.match(defaultProvider, /temporalObservation:\s*await fetch\(/u);
    assert.match(defaultProvider, /\/__local\/temporal-observation/u);
    assert.match(postgresInitializer, /builder\.Options[\s\S]*temporalContext\.PostgresSessionOptions/u);
    assert.match(runtimeTemporalContext, /-c timezone=\{PostgresTimezone\} -c fsusblog\.test_business_epoch_utc=\{BusinessEpochUtc:O\}/u);
    assert.match(defaultProvider, /readFixtureReceipt\([\s\S]*requireVerified: true/u);
    assert.match(defaultProvider, /producerId === 'comment-moderation'/u);
    assert.match(defaultProvider, /canonical comment FixtureReceipt is stale or cross-run/u);
    assert.match(
        defaultProvider,
        /FSUSBLOG_PUBLIC_AOT_SSR_CLIENT_ROOT:\s*consumerWebRoot/u
    );
    assert.match(
        defaultProvider,
        /FSUSBLOG_PUBLIC_AOT_SSR_WORKER_SCRIPT:\s*'\.\/server\/server-public-ssr\.bundle\.mjs'/u
    );
    assert.match(defaultProvider, /PublicAot__SsrClientRoot:\s*consumerWebRoot/u);
    assert.match(
        defaultProvider,
        /PublicAot__SsrWorkerScript:\s*'\.\/server\/server-public-ssr\.bundle\.mjs'/u
    );
    assert.match(defaultProvider, /'empty-staticwebassets\.runtime\.json'/u);
    assert.match(defaultProvider, /ASPNETCORE_STATICWEBASSETS:\s*staticWebAssetsManifest/u);
    assert.match(defaultProvider, /ContentRoots:\s*\[\]/u);
    assert.match(defaultProvider, /retainedRuntimeState/u);
    assert.match(
        defaultProvider,
        /if \(result\.retainedRuntimeState[\s\S]*result\.containerCleanupFailures\.length > 0[\s\S]*compensationFailures\.length > 0\)[\s\S]*result = await retryLocalRuntimeCleanup\(cleanupRuntime\)/u
    );
    assert.match(defaultProvider, /releaseProductionBuildConsumer/u);
    assert.match(defaultProvider, /reason:\s*'browser-contract-cleanup'/u);
    assert.doesNotMatch(defaultProvider, /os\.(?:loadavg|freemem)|FSUSBLOG_POSTGRES_PID_HEADROOM/u);
    assert.match(runner, /extraHTTPHeaders:\s*fixture\.testSession\s*\?\s*\{ 'X-Fsus-Test-Session': fixture\.testSession \}\s*:\s*(?:undefined|\{\})/u);
    assert.match(runner, /async function resetRunOutput\(\)[\s\S]+await rm\(ownedReceiptFile, \{ force: true \}\)/u);
    assert.doesNotMatch(runner, /rm\(ownedOutputRoot, \{ recursive: true, force: true \}\)/u);
    assert.match(runner, /path\.join\(outputRoot, 'runs', preparedFixture\.identity\.namespace\)/u);
    assert.ok(
        runner.indexOf('const sourceState = expectedSourceState()') < runner.indexOf('await resetRunOutput()'),
        'complete current source identity must be admitted before the fixed receipt can be touched'
    );
    assert.ok(
        runner.indexOf('const build = await verifyImmutableBuild(sourceState)') < runner.indexOf('await resetRunOutput()'),
        'the immutable build identity must be admitted before the fixed receipt can be touched'
    );
    assert.ok(
        runner.indexOf('const build = await verifyImmutableBuild(sourceState)')
            < runner.indexOf('temporalContext = loadTemporalContext()'),
        'source and build identity admission must precede temporal context admission'
    );
    assert.ok(
        runner.indexOf('temporalContext = loadTemporalContext()') < runner.indexOf('await resetRunOutput()'),
        'temporal context admission must remain fail closed before output mutation'
    );
    assert.match(runner, /expectedSourceState:\s*sourceState/u);
    assert.doesNotMatch(runner, /process\.env\.GITHUB_SHA|return null/u);
    assert.match(lane, /FSUSBLOG_TEST_SOURCE_COMMIT/u);
    assert.match(lane, /FSUSBLOG_TEST_SOURCE_FINGERPRINT/u);
    assert.match(runner, /const fallbackFixture = \{[\s\S]+createBrowserContractReceipt\(\{[\s\S]+fixture: fallbackFixture/u);
    assert.doesNotMatch(runner, /fallback\.fixture\s*=/u);

});

async function sceneOriginalSinkModels(t)
{
    await t.test('scene originals sink stores exact normal and tail inputs in separate exclusive private leaves', async (child) =>
    {
        const model = await sceneOriginalSinkModel(child);
        const createSink = await loadSceneOriginalSink();
        const save = createSink(model.options());
        model.privateOriginals.originals.push({ sequence: 0, bodyBase64: Buffer.from([0, 255, 13, 10]).toString('base64'),
            headers: [{ name: 'X-Original', value: 'private-value' }, { name: 'X-Original', value: 'duplicate-value' }],
            url: 'http://127.0.0.1:3000/private-original-model' });
        const failure = { name: 'OriginalFailure', message: 'keep first failure' };
        const normal = await save({ ...model.input(), failure });
        const before = model.readPrivateJson(path.join(root, normal.path));
        assert.deepEqual(before.document, { scene: model.scene, lease: {
            leaseId: model.lease.leaseId, actorId: model.lease.actorId, contextId: model.lease.contextId,
            sceneId: model.scene.id, role: model.lease.role, owner: model.lease.owner, authority: model.lease.authority, status: 'prepared'
        }, evidence: model.evidence, privateOriginals: model.privateOriginals, failure,
        rootBinding: { artifact: model.rootBinding.artifact, digest: model.rootBinding.digest } });
        assert.deepEqual(Object.keys(normal).sort(), ['digest', 'path']);
        assert.equal(JSON.stringify(normal).includes('private-value'), false);
        assert.equal(JSON.stringify(normal).includes(model.privateOriginals.originals[0].bodyBase64), false);
        assert.equal(before.contentDigest, normal.digest);
        assert.equal(before.mode, 0o600);
        assert.equal((await stat(path.dirname(path.join(root, normal.path)))).mode & 0o777, 0o700);
        const tail = await save({ ...model.input(), evidence: { ...model.evidence, phase: 'observer-disposal' }, failure });
        assert.notEqual(tail.path, normal.path);
        assert.deepEqual(model.readPrivateJson(path.join(root, tail.path)).document.failure, failure);
        await assert.rejects(save(model.input()), /already|exist/u);
        assert.deepEqual((await readFile(path.join(root, normal.path))), before.bytes);
        assert.equal(model.lease.status, 'prepared');
        assert.equal(model.rootBinding.binding.refs.length, 8);
    });
    await t.test('scene originals sink rejects missing normal cut and independently preserves actual tail cut', async (child) =>
    {
        const model = await sceneOriginalSinkModel(child);
        const createSink = await loadSceneOriginalSink();
        const save = createSink(model.options());
        const evidence = { ...model.evidence };
        delete evidence.captureCut;
        const failure = { name: 'NoPage', message: 'original first failure' };
        await assert.rejects(save({ ...model.input(), evidence, failure }), /cut/u);
        const tail = await save({ ...model.input(), evidence: { ...model.evidence, phase: 'observer-disposal' }, failure });
        const saved = model.readPrivateJson(path.join(root, tail.path));
        assert.deepEqual(saved.document.failure, failure);
        assert.equal(saved.document.evidence.captureCut, 0);
        assert.equal((await readdir(path.dirname(path.join(root, tail.path)))).length, 1);
    });
    for (const [name, mutate] of [
        ['foreign lease reference', (model, input) =>
        {
            input.lease = structuredClone(model.lease);
        }],
        ['evidence scene', (model, input) =>
        {
            input.evidence = { ...model.evidence, sceneId: 'other' };
        }],
        ['batch scene', (model, input) =>
        {
            input.privateOriginals = { ...model.privateOriginals, binding: { ...model.privateOriginals.binding, sceneId: 'other' } };
        }],
        ['cut mismatch', (model, input) =>
        {
            input.evidence = { ...model.evidence, captureCut: 1 };
        }],
        ['negative cut', (model, input) =>
        {
            input.evidence = { ...model.evidence, captureCut: -1 };
        }],
        ['fractional cut', (model, input) =>
        {
            input.evidence = { ...model.evidence, captureCut: 0.5 };
        }],
        ['evidence identity', (model, input) =>
        {
            input.evidence = { ...model.evidence, identity: { ...model.evidence.identity, namespace: 'foreign' } };
        }],
        ['batch source', (model, input) =>
        {
            input.privateOriginals = { ...model.privateOriginals, binding: { ...model.privateOriginals.binding,
                identity: { ...model.privateOriginals.binding.identity, sourceState: { ...model.evidence.identity.sourceState, commit: 'f'.repeat(40) } } } };
        }],
        ['batch build', (model, input) =>
        {
            input.privateOriginals = { ...model.privateOriginals, binding: { ...model.privateOriginals.binding,
                identity: { ...model.privateOriginals.binding.identity, buildDigest: 'e'.repeat(64) } } };
        }],
        ['batch preparation', (model, input) =>
        {
            input.privateOriginals = { ...model.privateOriginals, binding: { ...model.privateOriginals.binding,
                identity: { ...model.privateOriginals.binding.identity, preparationId: 'foreign' } } };
        }],
        ['batch namespace', (model, input) =>
        {
            input.privateOriginals = { ...model.privateOriginals, binding: { ...model.privateOriginals.binding,
                identity: { ...model.privateOriginals.binding.identity, namespace: 'foreign' } } };
        }],
        ['circular evidence', (model, input) =>
        {
            input.evidence = { ...model.evidence };
            input.evidence.circular = input.evidence;
        }],
        ['non-JSON failure', (model, input) =>
        {
            input.failure = { message: undefined };
        }],
        ['accessor evidence', (model, input) =>
        {
            input.evidence = { ...model.evidence };
            Object.defineProperty(input.evidence, 'secret', {
                enumerable: true, get: () => assert.fail('must not invoke evidence getter') });
        }]
    ])
    {
        await t.test(`scene originals sink rejects ${name}`, async (child) =>
        {
            const model = await sceneOriginalSinkModel(child);
            const createSink = await loadSceneOriginalSink();
            const save = createSink(model.options());
            const input = model.input();
            mutate(model, input);
            await assert.rejects(save(input), /scene|lease|cut|identity|serial|JSON/u);
        });
    }
    for (const [name, mutate] of [
        ['caller Root digest', (model) =>
        {
            model.rootBinding.digest = `sha256:${'0'.repeat(64)}`;
        }],
        ['caller Root identity', (model) =>
        {
            model.rootBinding.identity = { ...model.rootBinding.identity, runtimeId: 'foreign' };
        }],
        ['caller Root path escape', (model) =>
        {
            model.rootBinding.artifact = `../${model.rootBinding.artifact}`;
        }],
        ['Root namespace', (model) =>
        {
            model.rootBinding.binding.identity.namespace = 'foreign';
        }],
        ['scene descriptor', (model) =>
        {
            model.scene = { ...model.scene, route: 'other' };
        }],
        ['lease owner source', (model) =>
        {
            model.lease.owner = { ...model.lease.owner, sourceState: { ...model.lease.owner.sourceState, commit: 'f'.repeat(40) } };
        }],
        ['lease owner resources', (model) =>
        {
            model.lease.owner = { ...model.lease.owner, resources: { ...model.lease.owner.resources, redisNamespace: 'foreign' } };
        }],
        ['lease authority', (model) =>
        {
            model.lease.authority = { ...model.lease.authority, runtimeRunId: 'foreign' };
        }],
        ['lease role', (model) =>
        {
            model.lease.role = 'admin';
        }],
        ['lease finished inference', (model) =>
        {
            model.lease.status = 'finished';
        }]
    ])
    {
        await t.test(`scene originals sink refuses ${name}`, async (child) =>
        {
            const model = await sceneOriginalSinkModel(child);
            const createSink = await loadSceneOriginalSink();
            mutate(model);
            assert.throws(() => createSink(model.options()), /Root|scene|lease|identity|source|path|namespace/u);
        });
    }
    await t.test('scene originals sink detects Root byte drift during publication preparation', async (child) =>
    {
        const model = await sceneOriginalSinkModel(child);
        const createSink = await loadSceneOriginalSink();
        const save = createSink(model.options());
        const pending = save(model.input());
        model.writePrivateJson(model.bindingFile, { ...model.rootBinding.binding, runtimeId: 'changed-during-save' });
        await assert.rejects(pending, /Root/u);
        const sceneDirectory = path.join(path.dirname(model.bindingFile), 'scene-originals', `scene-${encodeURIComponent(model.scene.id)}`);
        assert.deepEqual(await readdir(sceneDirectory), []);
    });
    await t.test('scene originals sink refuses an existing symlink ancestor without writing outside the run', async (child) =>
    {
        const model = await sceneOriginalSinkModel(child);
        const createSink = await loadSceneOriginalSink();
        const save = createSink(model.options());
        const external = await mkdtemp(path.join(os.tmpdir(), 'node-scene-original-outside-'));
        child.after(() => rm(external, { recursive: true, force: true }));
        await symlink(external, path.join(path.dirname(model.bindingFile), 'scene-originals'));
        await assert.rejects(save(model.input()), /symlink|unsafe/u);
        assert.deepEqual(await readdir(external), []);
    });
    await t.test('scene originals sink takes an immutable input cut before its first async boundary', async (child) =>
    {
        const model = await sceneOriginalSinkModel(child);
        const createSink = await loadSceneOriginalSink();
        const save = createSink(model.options());
        const pending = save(model.input());
        model.evidence.issues.push('late mutation');
        model.privateOriginals.originals.push({ bodyBase64: 'late' });
        const ref = await pending;
        const saved = model.readPrivateJson(path.join(root, ref.path));
        assert.deepEqual(saved.document.evidence.issues, []);
        assert.deepEqual(saved.document.privateOriginals.originals, []);
    });
    await t.test('scene originals sink keeps opaque live handle fields out of the JSON identity projection', async (child) =>
    {
        const model = await sceneOriginalSinkModel(child);
        model.lease.liveContext = { toJSON: () => assert.fail('live lease fields must not be visited') };
        const createSink = await loadSceneOriginalSink();
        const ref = await createSink(model.options())(model.input());
        const saved = model.readPrivateJson(path.join(root, ref.path));
        assert.equal(Object.hasOwn(saved.document.lease, 'liveContext'), false);
        assert.equal(saved.document.lease.status, 'prepared');
        assert.equal(Object.hasOwn(saved.document.lease, 'ended'), false);
    });
    await t.test('scene originals sink separates successive cuts and atomically rejects concurrent duplicate leaves', async (child) =>
    {
        const model = await sceneOriginalSinkModel(child);
        const createSink = await loadSceneOriginalSink();
        const save = createSink(model.options());
        const concurrent = await Promise.allSettled([save(model.input()), save(model.input())]);
        assert.equal(concurrent.filter((item) => item.status === 'fulfilled').length, 1);
        assert.equal(concurrent.filter((item) => item.status === 'rejected').length, 1);
        const first = concurrent.find((item) => item.status === 'fulfilled').value;
        const next = await save({ ...model.input(), evidence: { ...model.evidence, captureCut: 1 },
            privateOriginals: { ...model.privateOriginals, captureCut: 1 } });
        assert.notEqual(first.path, next.path);
        assert.equal(model.readPrivateJson(path.join(root, next.path)).document.privateOriginals.captureCut, 1);
        assert.equal((await readdir(path.dirname(path.join(root, first.path)))).length, 2);
    });
    for (const boundary of ['constructor', 'input'])
    {
        const fields = boundary === 'constructor' ? ['matrix', 'scene', 'lease', 'rootBinding']
            : ['lease', 'evidence', 'privateOriginals', 'failure'];
        for (const field of fields)
        {
            await t.test(`scene originals top-level ${boundary} ${field} getter is rejected without invocation`, async (child) =>
            {
                const model = await sceneOriginalSinkModel(child);
                const createSink = await loadSceneOriginalSink();
                const save = boundary === 'input' ? createSink(model.options()) : null;
                const envelope = boundary === 'constructor' ? model.options() : model.input();
                const original = envelope[field];
                let calls = 0;
                Object.defineProperty(envelope, field, {
                    enumerable: true,
                    get()
                    {
                        calls += 1;
                        return original;
                    }
                });
                let failure;
                try
                {
                    if (boundary === 'constructor')
                    {
                        createSink(envelope);
                    }
                    else
                    {
                        await save(envelope);
                    }
                }
                catch (error)
                {
                    failure = error;
                }
                assert.equal(calls, 0, 'selected outer getter must not execute before descriptor admission');
                assert.ok(failure instanceof BrowserContractFailure, 'outer accessor must fail closed before publication');
            });
            for (const invalid of ['missing', 'undefined'])
            {
                await t.test(`scene originals top-level ${boundary} rejects ${invalid} ${field}`, async (child) =>
                {
                    const model = await sceneOriginalSinkModel(child);
                    const createSink = await loadSceneOriginalSink();
                    const save = boundary === 'input' ? createSink(model.options()) : null;
                    const envelope = boundary === 'constructor' ? model.options() : model.input();
                    if (invalid === 'missing')
                    {
                        delete envelope[field];
                    }
                    else
                    {
                        envelope[field] = undefined;
                    }
                    if (boundary === 'constructor')
                    {
                        assert.throws(() => createSink(envelope), BrowserContractFailure);
                    }
                    else
                    {
                        await assert.rejects(save(envelope), BrowserContractFailure);
                    }
                });
            }
        }
        for (const invalid of ['custom prototype', 'non-enumerable field', 'null envelope', 'undefined envelope'])
        {
            await t.test(`scene originals top-level ${boundary} rejects ${invalid}`, async (child) =>
            {
                const model = await sceneOriginalSinkModel(child);
                const createSink = await loadSceneOriginalSink();
                const save = boundary === 'input' ? createSink(model.options()) : null;
                let envelope = boundary === 'constructor' ? model.options() : model.input();
                if (invalid === 'custom prototype')
                {
                    Object.setPrototypeOf(envelope, { unexpected: 'not a plain data envelope' });
                }
                else if (invalid === 'non-enumerable field')
                {
                    Object.defineProperty(envelope, fields[0], { enumerable: false });
                }
                else
                {
                    envelope = invalid === 'null envelope' ? null : undefined;
                }
                if (boundary === 'constructor')
                {
                    assert.throws(() => createSink(envelope), BrowserContractFailure);
                }
                else
                {
                    await assert.rejects(save(envelope), BrowserContractFailure);
                }
            });
        }
    }
    await t.test('scene originals top-level data envelopes preserve actual lease and ignore page and opaque getters', async (child) =>
    {
        const model = await sceneOriginalSinkModel(child);
        const createSink = await loadSceneOriginalSink();
        let calls = 0;
        const getter = {
            enumerable: true,
            get()
            {
                calls += 1;
                throw new Error('unselected live field must not be read');
            }
        };
        const options = model.options();
        Object.defineProperty(options, 'opaque', getter);
        Object.defineProperty(model.lease, 'opaqueContext', getter);
        const save = createSink(options);
        const input = model.input();
        Object.defineProperty(input, 'page', getter);
        Object.defineProperty(input, 'opaque', getter);
        assert.equal(input.lease, model.lease);
        const ref = await save(input);
        const saved = model.readPrivateJson(path.join(root, ref.path));
        assert.equal(calls, 0);
        assert.equal(input.lease, model.lease);
        assert.equal(model.lease.status, 'prepared');
        assert.equal(Object.hasOwn(saved.document, 'page'), false);
        assert.equal(Object.hasOwn(saved.document.lease, 'opaqueContext'), false);
        assert.deepEqual(saved.document.privateOriginals.binding.identity, model.privateOriginals.binding.identity);
    });
}

// Actual runner/wrapper/private-I/O execution with explicit Node contexts, not rendered acceptance.
async function localeSceneLoopModels(t)
{
    const runner = await import(new URL('../browser-contract/run.mjs', import.meta.url));
    await localeSwitchResourceHoldModels(t);
    const setup = async (child, sceneFields = {}) =>
    {
        const model = await sceneOriginalSinkModel(child, sceneFields);
        const calls = [];
        const contexts = [];
        const browser = { contexts: () => contexts };
        let active = 0;
        let pageCreations = 0;
        let actualLease;
        const harness = {
            identity: model.evidence.identity,
            contextFactory(actualBrowser)
            {
                assert.equal(actualBrowser, browser);
                calls.push('factory');
                return async (lease) =>
                {
                    assert.equal(lease, actualLease);
                    assert.equal(active, 0);
                    active++;
                    const pages = [];
                    const listeners = new Map();
                    const context = {
                        on: (name, callback) => listeners.set(name, callback), off: (name) => listeners.delete(name),
                        pages: () => pages, addInitScript: async () =>
                        {},
                        async newPage()
                        {
                            pageCreations += 1;
                            const page = { on: () =>
                            {}, off: () =>
                            {}, isClosed: () => false,
                            evaluate: async (callback) => callback.toString().includes('performance:')
                                ? { recorder: { frames: [], marks: [], events: [], errors: [], overflow: false },
                                    performance: [], preloads: [] } : null };
                            pages.push(page);
                            listeners.get('page')(page);
                            return page;
                        },
                        async close()
                        {
                            calls.push('close');
                            active--;
                            contexts.splice(contexts.indexOf(context), 1);
                        }
                    };
                    contexts.push(context);
                    return context;
                };
            },
            async withScene(sceneId, createContext, observe)
            {
                assert.ok(model.matrix.scenes.some((scene) => scene.id === sceneId));
                actualLease = sceneId === model.scene.id ? model.lease : { ...model.lease, sceneId,
                    leaseId: '44444444-4444-4444-8444-444444444444', actorId: '55555555-5555-4555-8555-555555555555',
                    contextId: '66666666-6666-4666-8666-666666666666' };
                calls.push('enter');
                const context = await createContext(actualLease);
                try
                {
                    return await observe({ context, fixture: {}, lease: actualLease, negotiation: {} });
                }
                finally
                {
                    await context.close();
                    calls.push('finished');
                }
            }
        };
        const bindings = { identity: harness.identity, resources: [], preferenceUrl: 'http://127.0.0.1/preference' };
        const options = { browser, matrix: model.matrix, harness, bindings, rootBinding: model.rootBinding };
        return { model, calls, harness, options, pageCreations: () => pageCreations };
    };
    await t.test('canonical locale loop uses the actual factory/lease and retains stages before actual close', async (child) =>
    {
        const { model, calls, options } = await setup(child);
        const refs = await runner.runPublicShellLocaleScenes({ ...options, observe: async ({ context, observer, lease, saveStage }) =>
        {
            assert.equal(lease, model.lease);
            const page = await context.newPage();
            const evidence = await observer.capture(page);
            await saveStage({ evidence: { stage: 'node-first', evidence }, privateOriginals: observer.rawCapture.snapshot(evidence.captureCut) });
            await saveStage({ evidence: { stage: 'node-second', evidence }, privateOriginals: observer.rawCapture.snapshot(evidence.captureCut) });
            calls.push('observe');
        } });
        assert.deepEqual(calls, ['factory', 'enter', 'observe', 'close', 'finished']);
        assert.equal(refs.length, 2);
        const normal = model.readPrivateJson(path.join(root, refs[0].path)).document;
        const tail = model.readPrivateJson(path.join(root, refs[1].path)).document;
        assert.deepEqual(normal.evidence.driverObservations.map((item) => item.stage), ['node-first', 'node-second']);
        assert.deepEqual(tail.evidence.driverObservations, normal.evidence.driverObservations);
        assert.equal(normal.evidence.captureCut, 0);
        assert.equal(tail.evidence.phase, 'observer-disposal');
        assert.deepEqual(normal.privateOriginals.binding.identity, model.privateOriginals.binding.identity);
        assert.equal(normal.lease.status, 'prepared');
        assert.equal(Object.hasOwn(normal.evidence, 'checked'), false);
    });
    await t.test('canonical locale loop retains metadata-only stages without snapshotting another body batch', async (child) =>
    {
        const { model, options } = await setup(child);
        const refs = await runner.runPublicShellLocaleScenes({ ...options, observe: async ({ context, matrix, observer, saveStage }) =>
        {
            assert.equal(matrix, model.matrix);
            const page = await context.newPage();
            const evidence = await observer.capture(page);
            await saveStage({ page, evidence: { stage: 'before-click', evidence } });
            await saveStage({ page, evidence: { stage: 'pending', evidence } });
        } });
        assert.equal(refs.length, 2, 'only outer normal and disposal body batches are published');
        const normal = model.readPrivateJson(path.join(root, refs[0].path)).document;
        assert.deepEqual(normal.evidence.driverObservations.map((item) => item.stage), ['before-click', 'pending']);
        assert.deepEqual(normal.evidence.driverObservations.map((item) => item.evidence.captureCut), [0, 0]);
    });
    await t.test('canonical locale loop rejects a future metadata-only cut against the original capture', async (child) =>
    {
        const { options } = await setup(child);
        await assert.rejects(runner.runPublicShellLocaleScenes({ ...options, observe: async ({ context, observer, saveStage }) =>
        {
            const page = await context.newPage();
            const evidence = await observer.capture(page);
            await saveStage({ evidence: { stage: 'future-cut', evidence: { ...evidence,
                captureCut: observer.rawCapture.cut() + 1 } } });
        } }), /matching actual capture cut/u);
    });
    await t.test('canonical locale loop reaches the entered switch adapter and rejects missing cold authority before navigation', async (child) =>
    {
        const { model, calls, options, pageCreations } = await setup(child, { issue: 2086, stage: 'commit', locale: 'en-US',
            requiredDomains: ['public-shell'], selectorItems: [{ code: 'en-US' }] });
        await assert.rejects(runner.runPublicShellLocaleScenes(options), /cold domain is missing/u);
        assert.equal(pageCreations(), 0);
        assert.deepEqual(calls, ['factory', 'enter', 'close', 'finished']);
        const directory = path.join(path.dirname(model.bindingFile), 'scene-originals', `scene-${encodeURIComponent(model.scene.id)}`);
        for (const name of await readdir(directory))
        {
            const retained = model.readPrivateJson(path.join(directory, name)).document;
            if (retained.evidence.phase !== 'observer-disposal')
            {
                assert.equal(retained.evidence.pageCount, 0);
            }
            assert.match(retained.failure.message, /cold domain is missing/u);
        }
    });
    await t.test('canonical locale loop retains original driver failure and does not retry or admit the next scene', async (child) =>
    {
        const { model, calls, options } = await setup(child);
        model.matrix.scenes.push({ ...model.scene, id: 'node-model/never-entered' });
        const first = new Error('original driver failed');
        const refs = [];
        await assert.rejects(runner.runPublicShellLocaleScenes({ ...options, retainOriginal: (ref) => refs.push(ref), observe: async ({ context }) =>
        {
            await context.newPage();
            throw first;
        } }), (error) => error === first);
        assert.deepEqual(calls, ['factory', 'enter', 'close', 'finished']);
        assert.equal(refs.length, 2, 'first-failure refs must reach canonical finally without a successful loop return');
        const directory = path.join(path.dirname(model.bindingFile), 'scene-originals', `scene-${encodeURIComponent(model.scene.id)}`);
        for (const name of await readdir(directory))
        {
            assert.deepEqual(model.readPrivateJson(path.join(directory, name)).document.failure,
                { name: first.name, message: first.message });
        }
    });
    await t.test('canonical locale loop enumerates the actual matrix serially with independent original leases', async (child) =>
    {
        const { model, calls, options } = await setup(child);
        model.matrix.scenes.push({ ...model.scene, id: 'node-model/second' });
        const leases = [];
        const refs = await runner.runPublicShellLocaleScenes({ ...options, observe: async ({ context, lease }) =>
        {
            leases.push(lease);
            await context.newPage();
        } });
        assert.deepEqual(calls, ['factory', 'enter', 'close', 'finished', 'enter', 'close', 'finished']);
        assert.equal(refs.length, 4);
        assert.equal(new Set(refs.map((ref) => ref.path)).size, 4);
        assert.notEqual(leases[0], leases[1]);
        for (let index = 0; index < refs.length; index++)
        {
            const original = model.readPrivateJson(path.join(root, refs[index].path)).document;
            assert.equal(original.lease.leaseId, leases[Math.floor(index / 2)].leaseId);
            assert.equal(original.scene.id, model.matrix.scenes[Math.floor(index / 2)].id);
        }
    });
    await t.test('canonical locale loop does not admit leftover contexts or cross-admission bindings', async (child) =>
    {
        const { calls, options } = await setup(child);
        await assert.rejects(runner.runPublicShellLocaleScenes({ ...options, browser: { contexts: () => [{}] } }), /context boundary/u);
        await assert.rejects(runner.runPublicShellLocaleScenes({ ...options, bindings: { ...options.bindings,
            identity: { ...options.bindings.identity, namespace: 'another-run' } } }), /admission/u);
        assert.deepEqual(calls, []);
    });
    await t.test('canonical locale loop rejects mismatched stage cuts without erasing first failure or original identity', async (child) =>
    {
        const { model, options } = await setup(child);
        await assert.rejects(runner.runPublicShellLocaleScenes({ ...options, observe: async ({ context, observer, saveStage }) =>
        {
            const page = await context.newPage();
            const evidence = await observer.capture(page);
            await saveStage({ evidence: { stage: 'invalid-cut', evidence }, privateOriginals: { captureCut: evidence.captureCut + 1 } });
        } }), /matching actual capture cut/u);
        const directory = path.join(path.dirname(model.bindingFile), 'scene-originals', `scene-${encodeURIComponent(model.scene.id)}`);
        for (const name of await readdir(directory))
        {
            const retained = model.readPrivateJson(path.join(directory, name)).document;
            assert.match(retained.failure.message, /matching actual capture cut/u);
            assert.deepEqual(retained.evidence.driverObservations, []);
            assert.deepEqual(retained.privateOriginals.binding.identity, model.privateOriginals.binding.identity);
        }
    });
    await t.test('canonical locale loop propagates missing auth allocation without fallback or raw publication', async (child) =>
    {
        const { model, calls, harness, options } = await setup(child);
        const first = Object.assign(new Error('actual actor blocked'), { sceneBlocker: { status: 'blocked' } });
        harness.withScene = async () =>
        {
            throw first;
        };
        await assert.rejects(runner.runPublicShellLocaleScenes(options), (error) => error === first);
        assert.deepEqual(calls, ['factory']);
        await assert.rejects(readdir(path.join(path.dirname(model.bindingFile), 'scene-originals')), { code: 'ENOENT' });
    });
    await t.test('canonical locale loop rejects missing first-response authority and keeps the independent disposal tail', async (child) =>
    {
        const { model, options } = await setup(child);
        model.scene.issue = 2083;
        model.scene.stage = 'first-response';
        await assert.rejects(runner.runPublicShellLocaleScenes(options), /first-response.*authority/u);
        const directory = path.join(path.dirname(model.bindingFile), 'scene-originals', `scene-${encodeURIComponent(model.scene.id)}`);
        assert.deepEqual(await readdir(directory), ['cut-0-tail.json']);
        assert.match(model.readPrivateJson(path.join(directory, 'cut-0-tail.json')).document.failure.message, /first-response/u);
    });
    await t.test('terminal ledger retention preserves exact owner bytes and actual entered state, never manufactures ended', async (child) =>
    {
        const { model } = await setup(child);
        const { entered, ended, ...lease } = model.lease;
        assert.equal(entered, 0);
        assert.equal(ended, 0);
        const body = { schema: 'fsusblog.browser-contract-public-shell-scene-bindings.v1', owner: model.lease.owner,
            leases: [{ ...lease, status: 'entered', entered: 1, ended: 0 }] };
        const ledger = { ...body, contentDigest: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
        const file = path.join(model.directory, 'public-shell-locale-scene-bindings.json');
        model.writePrivateJson(file, ledger, { overwrite: false });
        const original = model.readPrivateJson(file);
        const outputDirectory = path.join(model.directory, 'terminal-output');
        const save = runner.createPublicShellLocaleOriginalSink(model.options());
        const originalRef = await save(model.input());
        const result = await runner.retainPublicShellLocaleSceneLedger({ fixtureRoot: model.directory, outputDirectory,
            rootBinding: model.rootBinding, matrix: model.matrix, originals: [originalRef] });
        assert.deepEqual(result.bindings, ledger);
        const retained = model.readPrivateJson(path.join(root, result.reference.artifact));
        assert.deepEqual(retained.bytes, original.bytes);
        assert.equal(retained.contentDigest, result.reference.digest);
        assert.equal(retained.mode, 0o600);
        assert.equal(retained.document.leases[0].ended, 0);
        await assert.rejects(runner.retainPublicShellLocaleSceneLedger({ fixtureRoot: model.directory, outputDirectory,
            rootBinding: model.rootBinding, matrix: model.matrix, originals: [originalRef] }), /exist/u);
        assert.deepEqual(model.readPrivateJson(file).bytes, original.bytes);
    });
    await t.test('terminal ledger retention refuses another Root owner without publishing bytes', async (child) =>
    {
        const { model } = await setup(child);
        const body = { schema: 'fsusblog.browser-contract-public-shell-scene-bindings.v1', owner: { ...model.lease.owner,
            buildDigest: `sha256:${'9'.repeat(64)}` }, leases: [] };
        model.writePrivateJson(path.join(model.directory, 'public-shell-locale-scene-bindings.json'), {
            ...body, contentDigest: createHash('sha256').update(JSON.stringify(body)).digest('hex')
        }, { overwrite: false });
        await assert.rejects(runner.retainPublicShellLocaleSceneLedger({ fixtureRoot: model.directory,
            outputDirectory: path.join(model.directory, 'terminal-output'), rootBinding: model.rootBinding, matrix: model.matrix,
            originals: [] }), /owner/u);
        await assert.rejects(readdir(path.join(model.directory, 'terminal-output')), { code: 'ENOENT' });
    });
    for (const field of ['scene', 'leaseId', 'source', 'cut', 'digest'])
    {
        await t.test(`terminal ledger join rejects original ${field} tamper without rewriting the owner ledger`, async (child) =>
        {
            const { model } = await setup(child);
            const body = { schema: 'fsusblog.browser-contract-public-shell-scene-bindings.v1', owner: model.lease.owner,
                leases: [{ ...model.lease, status: 'finished', entered: 1, ended: 1 }] };
            const file = path.join(model.directory, 'public-shell-locale-scene-bindings.json');
            model.writePrivateJson(file, { ...body,
                contentDigest: createHash('sha256').update(JSON.stringify(body)).digest('hex') }, { overwrite: false });
            const before = model.readPrivateJson(file);
            const ref = await runner.createPublicShellLocaleOriginalSink(model.options())(model.input());
            const leaf = path.join(root, ref.path);
            const value = model.readPrivateJson(leaf).document;
            if (field === 'scene')
            {
                value.scene.id = 'another-scene';
            }
            else if (field === 'leaseId')
            {
                value.lease.leaseId = '77777777-7777-4777-8777-777777777777';
            }
            else if (field === 'source')
            {
                value.lease.authority.matrixDigest = '9'.repeat(64);
            }
            else if (field === 'cut')
            {
                value.evidence.captureCut++;
                value.privateOriginals.captureCut++;
            }
            const rewritten = model.writePrivateJson(leaf, value);
            const currentRef = { ...ref, digest: field === 'digest' ? `sha256:${'8'.repeat(64)}` : rewritten.contentDigest };
            await assert.rejects(runner.retainPublicShellLocaleSceneLedger({ fixtureRoot: model.directory,
                outputDirectory: path.join(model.directory, 'terminal-output'), rootBinding: model.rootBinding,
                matrix: model.matrix, originals: [currentRef] }), /join/u);
            assert.deepEqual(model.readPrivateJson(file).bytes, before.bytes);
            await assert.rejects(readdir(path.join(model.directory, 'terminal-output')), { code: 'ENOENT' });
        });
    }
    await t.test('canonical main keeps the one-browser driver admission and terminal retention in the existing failure owner', async () =>
    {
        const source = await readFile(path.join(root, 'tests/browser-contract/run.mjs'), 'utf8');
        const main = source.slice(source.indexOf('async function main()'));
        assert.ok(main.indexOf('try\n    {') < main.indexOf('await admitPublicShellLocaleRuntimeBindings('));
        assert.ok(main.indexOf('await admitPublicShellLocaleRuntimeBindings(') < main.indexOf('managed.chromium.launch('));
        assert.ok(main.indexOf('if (productFailures.length > 0)') < main.indexOf('await runPublicShellLocaleScenes('));
        assert.ok(main.indexOf('await runPublicShellLocaleScenes(') < main.indexOf('await capturePublicPreviewGallery('));
        assert.ok(main.indexOf('await retainPublicShellLocaleSceneLedger(') < main.indexOf('await cleanupSingleBrowserContractFixture('));
        assert.equal((source.match(/managed\.chromium\.launch\(/gu) ?? []).length, 1);
        assert.match(source, /return await drivePublicShellLocaleInitialHydration\(input\)/u);
        assert.match(source, /return assertPublicShellLocaleResourceWaterfall\(/u);
        assert.doesNotMatch(main, /observe:.*(?:checked|generation)/u);
    });
}

async function localeSwitchResourceHoldModels(t)
{
    await t.test('canonical locale switch holds use unique receipted planned domains, not observed URLs (Node model)', async () =>
    {
        const runner = await import(new URL('../browser-contract/run.mjs', import.meta.url));
        const scene = { stage: 'latest-wins', locale: 'ja-JP', requiredDomains: ['public-shell'],
            transition: { rapidTargets: ['ja-JP', 'de-DE', 'ru-RU', 'ja-JP'] },
            selectorItems: ['ja-JP', 'de-DE', 'ru-RU'].map((code) => ({ code })) };
        const bindings = { resources: scene.selectorItems.map(({ code }) => ({
            url: `http://127.0.0.1:3001/assets/${code}.js`, identities: [{ kind: 'domain', locale: code, domain: 'public-shell' }]
        })) };
        const holds = runner.createPublicShellLocaleSwitchResourceHolds({ scene, bindings });
        assert.deepEqual(holds.map(({ locale, url }) => ({ locale, url })), bindings.resources.map((resource, index) =>
            ({ locale: scene.selectorItems[index].code, url: resource.url })));
        assert.equal(new Set(holds.map((hold) => hold.barrier)).size, 3);
        for (const hold of holds)
        {
            hold.barrier.close();
        }
        for (const mutate of [
            (value) => value.resources.pop(),
            (value) => value.resources.push(structuredClone(value.resources[0])),
            (value) => value.resources[0].identities[0].domain = 'foreign-domain',
            (value) => value.resources[1].url = value.resources[0].url
        ])
        {
            const candidate = structuredClone(bindings);
            mutate(candidate);
            assert.throws(() => runner.createPublicShellLocaleSwitchResourceHolds({ scene, bindings: candidate }), /cold domain/u);
        }
        assert.throws(() => runner.createPublicShellLocaleSwitchResourceHolds({
            scene: { ...scene, transition: { rapidTargets: [] } }, bindings }), /planned resource authority/u);
        const source = await readFile(path.join(root, 'tests/browser-contract/run.mjs'), 'utf8');
        const operation = source.slice(source.indexOf('async function observePublicShellLocaleScene('),
            source.indexOf('export async function runPublicShellLocaleScenes('));
        assert.match(operation, /scene\.issue === 2086/u);
        assert.match(operation, /drivePublicShellLocaleSwitchInContext\(/u);
        assert.doesNotMatch(operation, /drivePublicShellLocaleSwitchScene\(|withScene\(|newContext\(|launch\(/u);
    });
}

test('authenticated Browser Contract evidence never retains or uploads raw Playwright traces', async (t) =>
{
    const [runner, workflow] = await Promise.all([
        readFile(path.join(root, 'tests/browser-contract/run.mjs'), 'utf8'),
        readFile(path.join(root, '.github/workflows/quality-gate.yml'), 'utf8')
    ]);
    const browserContractJob = workflow.slice(
        workflow.indexOf('  browser-contract:\n'),
        workflow.indexOf('\n  resilience-runtime:', workflow.indexOf('  browser-contract:\n'))
    );

    assert.match(runner, /const mayRetainRawTrace = scenario\.role === 'anonymous'/u);
    assert.equal((runner.match(/context\.tracing\.start\(/gu) ?? []).length, 1);
    assert.equal((runner.match(/context\.tracing\.stop\(/gu) ?? []).length, 1);
    assert.match(
        runner,
        /if \(mayRetainRawTrace\)\s*\{\s*await context\.tracing\.start\(/u,
        'raw tracing must be opt-in for the anonymous role only'
    );
    assert.match(
        runner,
        /if \(mayRetainRawTrace\)\s*\{\s*const traced = await context\.tracing\.stop\(/u,
        'a trace must never be materialized unless the anonymous allowlist admitted it'
    );

    assert.match(browserContractJob, /\.tmp\/browser-contract\/receipt\.json/u);
    assert.match(browserContractJob, /\.tmp\/release-evidence\/jobs\/\*\*/u);
    assert.doesNotMatch(browserContractJob, /\.tmp\/browser-contract\/(?:fixtures|runs)\/\*\*/u);
    await sceneOriginalSinkModels(t);
    await localeSceneLoopModels(t);
});

test('first-response route inputs use production owners for every planned route and owned dynamic IDs', async () =>
{
    const { resolvePublicShellLocalePublishedRoute } = await import(new URL('../browser-contract/public-shell-locale-runtime-bindings.mjs', import.meta.url));
    const fixture = { baseUrl: 'http://127.0.0.1:3000',
        publicArticle: { id: '7', url: 'http://127.0.0.1:3000/article/7' }, category: { id: '9' } };
    const cases = [
        ['Home', '/', 'home'], ['ArticleDetail', '/article/7', 'article:7'],
        ['Archive', '/archive', 'archive'], ['About', '/about', 'about'],
        ['Privacy', '/privacy', 'privacy'], ['Guidelines', '/guidelines', 'guidelines'],
        ['Copyright', '/copyright', 'copyright'], ['Filter', '/category/9', 'category:9']
    ];
    for (const [route, selectedPath, routeKey] of cases)
    {
        const result = await resolvePublicShellLocalePublishedRoute({ root, fixture,
            scene: { issue: 2083, stage: 'first-response', route } });
        assert.equal(result.path, selectedPath);
        assert.equal(result.routeKey, routeKey);
        assert.equal(result.refs.length, 7);
        assert.ok(result.refs.every((ref) => /^sha256:[a-f0-9]{64}$/u.test(ref.digest)));
    }
    await assert.rejects(resolvePublicShellLocalePublishedRoute({ root, fixture,
        scene: { issue: 2083, stage: 'first-response', route: 'Account' } }));
    for (const id of ['', '0', '-1', '7junk', '2147483648', '9007199254740993'])
    {
        await assert.rejects(resolvePublicShellLocalePublishedRoute({ root,
            fixture: { ...fixture, publicArticle: { ...fixture.publicArticle, id } },
            scene: { issue: 2083, stage: 'first-response', route: 'ArticleDetail' } }));
        await assert.rejects(resolvePublicShellLocalePublishedRoute({ root,
            fixture: { ...fixture, category: { id } },
            scene: { issue: 2083, stage: 'first-response', route: 'Filter' } }));
    }
    await assert.rejects(resolvePublicShellLocalePublishedRoute({ root,
        fixture: { ...fixture, publicArticle: { ...fixture.publicArticle, url: 'http://foreign.invalid/article/7' } },
        scene: { issue: 2083, stage: 'first-response', route: 'ArticleDetail' } }));
});

async function publishedArtifactRefModel(t)
{
    const model = await sceneOriginalSinkModel(t, { issue: 2083, stage: 'first-response', locale: 'zh-CN' });
    const fixtureRoot = path.join(root, '.tmp/browser-contract/fixtures', path.basename(model.directory));
    await mkdir(fixtureRoot, { recursive: true, mode: 0o700 });
    t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
    model.rootBinding.binding.resources.fixtureRoot = fixtureRoot;
    model.lease.owner.fixtureRoot = fixtureRoot;
    const { derivePublicShellLocaleRootIdentity } = await import(new URL('../../tools/test-matrix/public-shell-locale-evidence.mjs', import.meta.url));
    model.rootBinding.identity = derivePublicShellLocaleRootIdentity(model.matrix, model.rootBinding.binding);
    model.rootBinding.digest = model.writePrivateJson(model.bindingFile, model.rootBinding.binding).contentDigest;
    const owner = { namespace: path.basename(model.directory), runtimeRunId: model.lease.authority.runtimeRunId,
        sourceCommit: model.lease.owner.sourceState.commit,
        worktreeFingerprint: model.lease.owner.sourceState.worktreeFingerprint,
        buildDigest: model.lease.owner.buildDigest, runtimeScope: '' };
    const bytes = Buffer.from('<html>independently published Node model</html>');
    const observation = { schema: 'fsusblog.public-content-published-artifact-observation.v1', owner,
        route: { path: '/', routeKey: 'home', kind: 'Home', locale: 'zh-CN' },
        publication: { source: 'server-ssr', generation: 0, effectiveCacheControl: 'private,no-store' },
        originals: [{ role: 'published-artifact', encoding: 'base64', bytes: bytes.length,
            content: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') }] };
    const embedded = JSON.stringify(observation);
    const original = `{"observation":${embedded},"contentDigest":"${createHash('sha256').update(embedded).digest('hex')}"}`;
    const name = 'published-artifact-11111111-1111-4111-8111-111111111111.json';
    const file = path.join(fixtureRoot, name);
    const retained = model.writePrivateJson(file, original, { overwrite: false });
    const result = { sceneId: model.scene.id, matrixDigest: model.matrix.contentDigest,
        runtimeRunId: owner.runtimeRunId, artifact: { path: name, digest: retained.contentDigest } };
    const { readPublicShellLocalePublishedArtifactRef } = await import(new URL('../browser-contract/run.mjs', import.meta.url));
    const args = { matrix: model.matrix, lease: model.lease, rootBinding: model.rootBinding, result, scene: model.scene,
        owner, route: { path: '/', routeKey: 'home' } };
    return { ...model, fixtureRoot, file, name, original, args, read: readPublicShellLocalePublishedArtifactRef };
}

test('first-response published reference retains actual fixtures-root bytes independently of cleanup and navigation', async (t) =>
{
    const model = await publishedArtifactRefModel(t);
    const result = model.read(model.args);
    assert.equal(result.observation.owner.runtimeScope, '');
    assert.equal(result.observation.route.routeKey, 'home');
    const prefix = `.tmp/browser-contract/runs/${model.args.owner.namespace}/bindings/${model.lease.owner.preparation.id}/published-artifacts/scene-${encodeURIComponent(model.scene.id)}/`;
    assert.equal(result.ref.path, `${prefix}${model.name}`);
    assert.equal(result.ref.digest, model.args.result.artifact.digest);
    assert.equal(Object.hasOwn(result, 'qualificationEligible'), false);
    assert.equal((await readFile(path.join(root, result.ref.path), 'utf8')), model.original);
    await rm(model.fixtureRoot, { recursive: true, force: true });
    const { readPublicShellLocaleSceneOriginalArtifact } = await import(new URL('../../tools/test-matrix/verify-public-shell-locale.mjs', import.meta.url));
    assert.equal(readPublicShellLocaleSceneOriginalArtifact({ root, ref: result.ref, prefix }).bytes.toString('utf8'), model.original);
    assert.throws(() => readPublicShellLocaleSceneOriginalArtifact({ root, ref: {
        path: `.tmp/browser-contract/fixtures/${model.args.owner.namespace}/${model.name}`, digest: result.ref.digest
    }, prefix: `.tmp/browser-contract/fixtures/${model.args.owner.namespace}/` }), /ref is not canonical/u);
});

test('first-response published reference rejects foreign owner, route, hash and provider reference', async (t) =>
{
    const model = await publishedArtifactRefModel(t);
    for (const field of ['sourceCommit', 'worktreeFingerprint', 'buildDigest'])
    {
        assert.throws(() => model.read({ ...model.args, owner: { ...model.args.owner, [field]: 'foreign' } }));
    }
    for (const [field, value] of [['sceneId', 'foreign'], ['matrixDigest', 'foreign'], ['runtimeRunId', 'foreign']])
    {
        assert.throws(() => model.read({ ...model.args, result: { ...model.args.result, [field]: value } }));
    }
    for (const selectedPath of ['../outside.json', '/absolute.json', `nested/${model.name}`, 'published-artifact-latest.json'])
    {
        assert.throws(() => model.read({ ...model.args, result: { ...model.args.result,
            artifact: { ...model.args.result.artifact, path: selectedPath } } }));
    }
    assert.throws(() => model.read({ ...model.args, lease: { ...model.lease,
        owner: { ...model.lease.owner, fixtureRoot: path.dirname(model.fixtureRoot) } } }));
    assert.throws(() => model.read({ ...model.args, route: { path: '/about', routeKey: 'about' } }));
    assert.throws(() => model.read({ ...model.args, result: { ...model.args.result,
        artifact: { ...model.args.result.artifact, digest: `sha256:${'0'.repeat(64)}` } } }));
    const linked = path.join(model.fixtureRoot, 'published-artifact-22222222-2222-4222-8222-222222222222.json');
    await symlink(model.file, linked);
    assert.throws(() => model.read({ ...model.args, result: { ...model.args.result,
        artifact: { ...model.args.result.artifact, path: path.basename(linked) } } }));
});

test('first-response published reference rejects unbounded, linked and non-private original files before retention', async (t) =>
{
    const model = await publishedArtifactRefModel(t);
    const linked = path.join(model.fixtureRoot, 'node-model-hardlink.json');
    await link(model.file, linked);
    assert.throws(() => model.read(model.args), /single-link/u);
    await rm(linked);
    await chmod(model.file, 0o644);
    assert.throws(() => model.read(model.args), /private/u);
    await chmod(model.file, 0o600);
    await truncate(model.file, 16 * 1024 * 1024 + 1);
    assert.throws(() => model.read(model.args), /bounded/u);
    await truncate(model.file, 0);
    assert.throws(() => model.read(model.args), /bounded/u);
});

test('first-response published reference cannot overwrite a retained original or cross its frozen preparation', async (t) =>
{
    const model = await publishedArtifactRefModel(t);
    const retained = model.read(model.args);
    assert.throws(() => model.read(model.args), /EEXIST/u);
    assert.equal(await readFile(path.join(root, retained.ref.path), 'utf8'), model.original);
    const foreignLease = structuredClone(model.lease);
    foreignLease.owner.preparation.id = '44444444-4444-4444-8444-444444444444';
    assert.throws(() => model.read({ ...model.args, lease: foreignLease }), /Root owner/u);
    const foreignRoot = structuredClone(model.rootBinding);
    foreignRoot.binding.preparation.id = foreignLease.owner.preparation.id;
    assert.throws(() => model.read({ ...model.args, rootBinding: foreignRoot }), /Root path/u);
});
