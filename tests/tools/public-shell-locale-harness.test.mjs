import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
    admitPublicShellLocaleHarness,
    bindPublicShellLocaleResourceBarrier,
    createPublicShellLocaleResourceBarrier,
    observePublicShellLocaleProbe,
    projectPublicShellLocaleProbeObservation
// eslint-disable-next-line import-x/no-relative-parent-imports -- Exercise the canonical Browser Contract locale harness facade.
} from '../browser-contract/public-shell-locale-harness.mjs';

const { createProductionBuildReceipt } = await import(new URL('../../tools/ci/production-build-artifacts.mjs', import.meta.url));
const { buildFixtureReceipt } = await import(new URL('../../tools/test-fixtures/receipt/fixture-receipt.mjs', import.meta.url));
const { fixtureCatalogDigest, expandedCapabilityDigest } = await import(new URL('../../tools/testing/fixture-catalog.mjs', import.meta.url));
const { createPublicShellLocaleMatrix } = await import(new URL('../browser-contract/public-shell-locale-matrix.mjs', import.meta.url));
const { readPrivateJson, writePrivateJson } = await import(new URL('../../tools/test-fixtures/receipt/private-io.mjs', import.meta.url));
const lifecycleUrl = new URL('../browser-contract/fixture-lifecycle.mjs', import.meta.url);
const providerUrl = new URL('../browser-contract/default-fixture-provider.mjs', import.meta.url);
const { resolveBrowserContractRunIdentity, readPublicShellLocaleSceneBindings } = await import(lifecycleUrl);
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

/** Explicit Node contract model: real admission/file/lease code, no host or rendered qualification. */
async function sceneHarnessModel(t, { beforeAdmission = null } = {})
{
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'fsusblog-locale-harness-model-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    await chmod(root, 0o700);
    const matrix = await createPublicShellLocaleMatrix(repositoryRoot);
    const sourceState = { commit: matrix.identity.sourceCommit, worktreeFingerprint: matrix.identity.worktreeFingerprint };
    const env = { ...process.env, FSUSBLOG_PLAYWRIGHT_SESSION_MODE: 'browser-contract',
        FSUSBLOG_BROWSER_CONTRACT_RUN_ID: `node-harness-model-${randomUUID()}` };
    const identity = { ...resolveBrowserContractRunIdentity({ env, sourceState, repoRoot: repositoryRoot }), fixtureRoot: root };
    const preparation = { id: randomUUID(), startedAt: new Date().toISOString() };
    const artifactRoot = path.join(root, 'build');
    const domains = ['backend-runtime', 'frontend-dist', 'generated-contracts', 'wasm'];
    for (const name of domains)
    {
        await mkdir(path.join(artifactRoot, name), { recursive: true });
        await writeFile(path.join(artifactRoot, name, 'node-model.txt'), `${name}: not a production build\n`);
    }
    const receipt = createProductionBuildReceipt({
        root: repositoryRoot, artifactRoot, sourceState,
        producer: { workflow: 'Node locale harness contract model', runId: identity.runId, runAttempt: 1, job: 'node-contract-model' },
        toolchain: { node: process.version, npm: 'node-model', dotnet: 'node-model', vite: 'node-model',
            vitest: 'node-model', playwright: 'node-model', emsdk: 'node-model' },
        inputPaths: ['tests/browser-contract/public-shell-locale-harness.mjs'],
        domains: domains.map((name) => ({ name, path: name })),
        build: { profile: 'node-contract-model', command: 'node --test tests/tools/public-shell-locale-harness.test.mjs' }
    });
    const build = { receiptContentDigest: receipt.contentDigest, profile: 'node-contract-model' };
    const resources = { fixtureRoot: root, databaseSchema: identity.databaseSchema, databaseInstance: identity.databaseInstance,
        redisNamespace: identity.redisNamespace, redisInstance: identity.redisInstance };
    const runtime = { frontendUrl: 'http://127.0.0.1:3000', backendUrl: 'http://127.0.0.1:7568',
        isolatedDatabase: true, testSessionHeader: false };
    const containers = { postgres: { name: resources.databaseInstance, id: 'd'.repeat(64) },
        redis: { name: resources.redisInstance, id: 'e'.repeat(64) } };
    const state = { schema: 'fsusblog.browser-contract-default-provider-state.v1', phase: 'prepared',
        namespace: identity.namespace, preparation, sourceState, buildIdentity: build,
        runtimeRunId: 'node-harness-runtime-model', runtime, containers };
    const manifest = {
        schema: 'fsusblog.browser-contract-fixture.v2', sealed: true,
        identity: { commit: identity.commit, runId: identity.runId, laneId: identity.laneId, namespace: identity.namespace },
        preparation, sourceState, buildIdentity: build, resources,
        baseUrl: runtime.frontendUrl, backendUrl: runtime.backendUrl,
        transport: { testSessionHeader: false }, topology: { sessions: 1, concurrency: 1 },
        ownership: { containers }, entities: {
            publicArticle: { id: '101', title: 'Node contract model', url: `${runtime.frontendUrl}/article/101` },
            user: { id: 303, storageStateFile: 'user.json' }, admin: { id: 404, storageStateFile: 'admin.json' }
        }
    };
    const fixtureReceipt = buildFixtureReceipt({
        terminalStatus: 'verified', executionIdentity: { runId: state.runtimeRunId, namespace: identity.namespace, source: sourceState },
        profileIdentity: { profileId: 'none', profileSource: 'dev-cli', executionClass: 'runtime', sealed: true },
        catalogDigest: fixtureCatalogDigest(), expandedCapabilityDigest: expandedCapabilityDigest([]), serviceIdentity: resources
    });
    const storage = { cookies: [{ name: 'node-model-auth-cookie', value: 'must-not-enter-anonymous-context',
        url: runtime.frontendUrl, httpOnly: true, secure: false, sameSite: 'Lax' }], origins: [] };
    for (const [name, value] of Object.entries({ 'provider-state.json': state, 'contract-fixture.json': manifest,
        'prepare-state.json': { producerOutputs: {} }, 'fixture-receipt.json': fixtureReceipt,
        'user.json': storage, 'admin.json': storage }))
    {
        await writeFile(path.join(root, name), JSON.stringify(value), { mode: 0o600 });
    }
    const provider = path.join(root, 'node-model-provider.mjs');
    await writeFile(provider, `
import { resolvePublicShellLocaleSceneAuthority } from ${JSON.stringify(providerUrl.href)};
import { preparePublicShellLocaleSceneBinding, transitionPublicShellLocaleSceneBinding } from ${JSON.stringify(lifecycleUrl.href)};
const chunks = [];
for await (const chunk of process.stdin) { chunks.push(chunk); }
const request = JSON.parse(Buffer.concat(chunks));
const { scene, authority } = await resolvePublicShellLocaleSceneAuthority(request);
const entity = request.operation === 'preparePublicShellLocaleScene'
    ? await preparePublicShellLocaleSceneBinding(request, scene, authority)
    : await transitionPublicShellLocaleSceneBinding(request, authority);
process.stdout.write(JSON.stringify({ schema: 'fsusblog.browser-contract-fixture-provider-response.v1', operation: request.operation, status: 'ok', entity }));
`, { mode: 0o600 });
    env.FSUSBLOG_BROWSER_CONTRACT_FIXTURE_PROVIDER = provider;
    const prepared = { root, identity, preparation, sourceState, build, env, repoRoot: repositoryRoot,
        lifecycle: { status: 'prepared', preparation } };
    await beforeAdmission?.(artifactRoot);
    const harness = await admitPublicShellLocaleHarness({ root: repositoryRoot, matrix, prepared,
        buildReceiptFile: path.join(artifactRoot, 'receipt.json'), env });
    const scenes = matrix.scenes.filter((scene) => scene.issue === 2083 && scene.authActionContext === 'anonymous'
        && scene.negotiationId.endsWith('/exact') && scene.route === 'Home');
    return { root, matrix, harness, scenes, artifactRoot };
}

function harnessBuildSnapshot(artifactRoot)
{
    return ['receipt.json', ...['backend-runtime', 'frontend-dist', 'generated-contracts', 'wasm']
        .map((domain) => `${domain}/node-model.txt`)].map((relative) =>
    {
        const file = path.join(artifactRoot, relative);
        return { relative, bytes: readFileSync(file), mode: statSync(file).mode };
    });
}

for (const [name, writable] of [
    ['receipt', ['receipt.json']],
    ['artifact', ['frontend-dist/node-model.txt']],
    ['receipt and artifact', ['receipt.json', 'frontend-dist/node-model.txt']]
])
{
    test(`harness read-only admission rejects writable ${name} without repairing inputs (Node I/O model)`, async (t) =>
    {
        let artifactRoot;
        let before;
        await assert.rejects(sceneHarnessModel(t, { beforeAdmission: async (directory) =>
        {
            artifactRoot = directory;
            for (const relative of writable)
            {
                await chmod(path.join(directory, relative), 0o644);
            }
            before = harnessBuildSnapshot(directory);
        } }), /read-only seal is missing/u);
        assert.deepEqual(harnessBuildSnapshot(artifactRoot), before);
    });
}

test('harness read-only admission accepts the producer seal without rewriting inputs (Node I/O model)', async (t) =>
{
    let before;
    const value = await sceneHarnessModel(t, { beforeAdmission: (directory) =>
    {
        before = harnessBuildSnapshot(directory);
    } });
    assert.deepEqual(harnessBuildSnapshot(value.artifactRoot), before);
});

function sceneBrowserModel({ createError = null, closeError = null } = {})
{
    const contexts = [];
    const options = [];
    let closed = 0;
    const browser = {
        contexts: () => [...contexts],
        async newContext(value)
        {
            options.push(value);
            if (createError)
            {
                throw createError;
            }
            const context = { browser: () => browser, async close()
            {
                closed += 1;
                if (closeError)
                {
                    throw closeError;
                }
                contexts.splice(contexts.indexOf(context), 1);
            } };
            contexts.push(context);
            return context;
        }
    };
    return { browser, options, closed: () => closed };
}

test('scene harness consumes the formal lease and closes it before the next scene', async (t) =>
{
    const value = await sceneHarnessModel(t);
    const model = sceneBrowserModel();
    const factory = value.harness.contextFactory(model.browser);
    await assert.rejects(() => factory({}), /current scene lease/u);
    assert.throws(() => value.harness.contextFactory(model.browser), /already bound/u);
    const actorIds = [];
    for (const scene of value.scenes.slice(0, 2))
    {
        const answer = await value.harness.withScene(scene.id, factory, async ({ context, lease }) =>
        {
            assert.equal(context.browser(), model.browser);
            assert.equal(lease.sceneId, scene.id);
            actorIds.push(lease.actorId);
            const current = readPublicShellLocaleSceneBindings(value.root).leases.at(-1);
            assert.equal(current.status, 'entered');
            assert.equal(current.ended, 0);
            await assert.rejects(() => value.harness.withScene(scene.id, factory, () =>
            {}), /serially/u);
            return 'observed-node-model';
        });
        assert.equal(answer, 'observed-node-model');
        assert.equal(readPublicShellLocaleSceneBindings(value.root).leases.at(-1).status, 'finished');
        await assert.rejects(() => value.harness.withScene(scene.id, factory, () =>
        {}), /retry/u);
    }
    assert.equal(new Set(actorIds).size, 2);
    assert.equal(model.closed(), 2);
    assert.equal(model.browser.contexts().length, 0);
    assert.equal(model.options.length, 2);
    for (const options of model.options)
    {
        assert.equal(options.javaScriptEnabled, false);
        assert.deepEqual(options.storageState, { cookies: [], origins: [] });
    }
});

test('scene harness rejects unregistered context factories before fixture or context creation', async (t) =>
{
    const value = await sceneHarnessModel(t);
    const model = sceneBrowserModel();
    value.harness.contextFactory(model.browser);
    await assert.rejects(() => value.harness.withScene(value.scenes[0].id, () => assert.fail('foreign factory'), () =>
    {}),
    /canonical leased context factory/u);
    assert.equal(readPublicShellLocaleSceneBindings(value.root), null);
    assert.equal(model.options.length, 0);
});

test('scene harness keeps unavailable authenticated actors blocked instead of reusing fixed cookies', async (t) =>
{
    const value = await sceneHarnessModel(t);
    const model = sceneBrowserModel();
    const factory = value.harness.contextFactory(model.browser);
    for (const role of ['authenticated', 'admin'])
    {
        const scene = value.matrix.scenes.find((item) => item.authActionContext === role);
        await assert.rejects(() => value.harness.withScene(scene.id, factory, () => assert.fail('blocked observer')),
            (error) => error.sceneBlocker?.reason === 'canonical-scene-auth-allocation-unavailable');
    }
    assert.equal(model.options.length, 0);
    assert.equal(readPublicShellLocaleSceneBindings(value.root).leases.length, 0);
});

test('scene harness preserves creation failure and refuses later admission over an unresolved owner', async (t) =>
{
    const value = await sceneHarnessModel(t);
    const first = new Error('node-model context creation failed');
    const model = sceneBrowserModel({ createError: first });
    const factory = value.harness.contextFactory(model.browser);
    await assert.rejects(() => value.harness.withScene(value.scenes[0].id, factory, () => assert.fail('uncreated observer')),
        (error) => error === first);
    const lease = readPublicShellLocaleSceneBindings(value.root).leases[0];
    assert.equal(lease.status, 'creation-failed');
    assert.equal(lease.firstFailure.message, first.message);
    assert.equal(lease.entered + lease.ended, 0);
    await assert.rejects(() => value.harness.withScene(value.scenes[1].id, factory, () =>
    {}), /serially/u);
    assert.equal(model.options.length, 1);
});

test('scene harness retains the primary observation error when closing the leased context also fails', async (t) =>
{
    const value = await sceneHarnessModel(t);
    const primary = new Error('node-model observation failed');
    const secondary = new Error('node-model close failed');
    const model = sceneBrowserModel({ closeError: secondary });
    const factory = value.harness.contextFactory(model.browser);
    await assert.rejects(() => value.harness.withScene(value.scenes[0].id, factory, () =>
    {
        throw primary;
    }),
    (error) => error === primary && error.sceneCleanupError === secondary);
    const lease = readPublicShellLocaleSceneBindings(value.root).leases[0];
    assert.equal(lease.status, 'entered');
    assert.equal(lease.entered, 1);
    assert.equal(lease.ended, 0);
    assert.equal(lease.firstFailure.message, primary.message);
    await assert.rejects(() => value.harness.withScene(value.scenes[1].id, factory, () =>
    {}), /serially/u);
    assert.equal(model.options.length, 1);
});

test('missing formal readiness rejects before any fixture/browser callback', async () =>
{
    for (const status of [undefined, 'preparing', 'prepare-failure', 'cleaned'])
    {
        await assert.rejects(admitPublicShellLocaleHarness({
            env: { FSUSBLOG_PLAYWRIGHT_SESSION_MODE: 'browser-contract' },
            prepared: { lifecycle: { status } }
        }), /formal host\/fixture preparation/u);
    }
    await assert.rejects(admitPublicShellLocaleHarness({
        env: { FSUSBLOG_PLAYWRIGHT_SESSION_MODE: 'legacy-parallel' }
    }), /canonical browser-contract mode/u);
    await assert.rejects(admitPublicShellLocaleHarness({
        env: { FSUSBLOG_PLAYWRIGHT_SESSION_MODE: 'browser-contract' },
        prepared: { lifecycle: { status: 'prepared' } }
    }), /current-run prepared fixture identity/u);
});

test('probe serialization discards raw body, headers, cookies and custom text', () =>
{
    const catalog = JSON.parse(readFileSync(new URL('../../src/shared/Contracts/Localization/locale-catalog.json', import.meta.url)));
    const code = catalog.defaultCode;
    const secret = 'private-cookie-token-personal-data';
    const input = {
        firstResponse: {
            status: 200, contentType: `text/html; private=${secret}`, contentLanguage: code,
            bodyDigest: 'a'.repeat(64), bodyBytes: 100,
            body: secret, headers: { 'set-cookie': secret, authorization: secret }
        },
        observed: {
            language: code, title: secret, selectorLocales: [code], activeLocales: [code],
            hydrated: 'true', fontsStatus: 'loaded',
            fonts: [{ family: secret, weight: secret, status: 'loaded' }],
            resourceCount: 1, cookies: [{ value: secret }]
        }
    };
    const result = projectPublicShellLocaleProbeObservation(input, catalog);
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(result.firstResponse.contentType, 'text/html');
    assert.equal(result.observed.titleDigest.length, 64);
    const invalidLocale = structuredClone(input);
    invalidLocale.firstResponse.contentLanguage = secret;
    assert.throws(() => projectPublicShellLocaleProbeObservation(invalidLocale, catalog), /noncatalog locale/u);
    const invalidType = structuredClone(input);
    invalidType.firstResponse.contentType = 'application/json';
    assert.throws(() => projectPublicShellLocaleProbeObservation(invalidType, catalog), /must be HTML/u);
});

/** Node response/sink model only; no browser or rendered qualification. */
function probeOriginalModel({ body = Buffer.from('private document'), headers = null, bodyError = null,
    headerError = null, saveOriginalResponse = null } = {})
{
    const matrix = JSON.parse(readFileSync(new URL('../../src/shared/Contracts/Localization/locale-catalog.json', import.meta.url)));
    const code = matrix.defaultCode;
    const page = new EventEmitter();
    const frame = {};
    let reads = 0;
    let headerReads = 0;
    let evaluations = 0;
    page.mainFrame = () => frame;
    page.context = () => ({ cookies: async () => [] });
    page.evaluate = async () =>
    {
        evaluations += 1;
        return { language: code, title: 'private title', selectorLocales: [code], activeLocales: [code], hydrated: 'true',
            fontsStatus: 'loaded', fonts: [], resourceCount: 1 };
    };
    const identity = { namespace: 'node-response-model', matrixDigest: 'model-only' };
    const probe = observePublicShellLocaleProbe(page, identity, { matrix, saveOriginalResponse });
    page.emit('response', {
        request: () => ({ resourceType: () => 'document', frame: () => frame }),
        status: () => 200,
        async body()
        {
            reads += 1;
            if (bodyError)
            {
                throw bodyError;
            }
            return body;
        },
        async headersArray()
        {
            headerReads += 1;
            if (headerError)
            {
                throw headerError;
            }
            return headers ?? [{ name: 'Content-Type', value: 'text/html' }, { name: 'Content-Language', value: code }];
        }
    });
    return { probe, identity, reads: () => reads, headerReads: () => headerReads, evaluations: () => evaluations };
}

test('probe original response separates one exact body and duplicate headers from safe diagnostics (Node model)', async () =>
{
    const body = Buffer.from('private-cookie-token-正文');
    let saved;
    const value = probeOriginalModel({ body, saveOriginalResponse: async (originals) =>
    {
        saved = structuredClone(originals);
    } });
    try
    {
        const result = await value.probe.finish();
        assert.deepEqual(saved.identity, value.identity);
        assert.deepEqual(Buffer.from(saved.bodyBase64, 'base64'), body);
        assert.equal(saved.bodyBytes, body.length);
        assert.deepEqual(saved.failures, []);
        assert.equal(saved.headersArray[0].name, 'Content-Type');
        assert.equal(saved.representation, 'playwright-response-body');
        assert.equal(value.reads(), 1);
        assert.equal(value.headerReads(), 1);
        assert.equal(result.qualificationEligible, false);
        assert.equal(result.evidenceKind, 'diagnostic-probe');
        assert.equal(JSON.stringify(result).includes('private-cookie-token'), false);
        assert.equal(Object.hasOwn(result.firstResponse, 'bodyBase64'), false);
        await assert.rejects(value.probe.finish(), /cannot repeat/u);
        assert.equal(value.reads(), 1);
    }
    finally
    {
        value.probe.dispose();
    }
});

test('probe original response preserves duplicate full headers without publishing their values (Node model)', async () =>
{
    const catalog = JSON.parse(readFileSync(new URL('../../src/shared/Contracts/Localization/locale-catalog.json', import.meta.url)));
    const headers = [{ name: 'content-type', value: 'text/html' }, { name: 'content-language', value: catalog.defaultCode },
        { name: 'Set-Cookie', value: 'first-private-cookie' }, { name: 'Set-Cookie', value: 'second-private-cookie' }];
    let saved;
    const value = probeOriginalModel({ headers, saveOriginalResponse: async (originals) =>
    {
        saved = structuredClone(originals);
    } });
    try
    {
        const result = await value.probe.finish();
        assert.deepEqual(saved.headersArray, headers);
        assert.equal(JSON.stringify(result).includes('private-cookie'), false);
    }
    finally
    {
        value.probe.dispose();
    }
});

for (const missing of ['body', 'headers'])
{
    test(`probe original response saves available evidence before rejecting missing ${missing} (Node model)`, async () =>
    {
        let saved;
        const value = probeOriginalModel({ bodyError: missing === 'body' ? new Error('private body transport detail') : null,
            headerError: missing === 'headers' ? new Error('private header transport detail') : null,
            saveOriginalResponse: async (originals) =>
            {
                saved = structuredClone(originals);
            } });
        try
        {
            await assert.rejects(value.probe.finish(), /capture is incomplete/u);
            assert.ok(saved.failures.includes(`${missing}-unavailable`));
            assert.equal(saved.bodyBase64 !== null, missing !== 'body');
            assert.equal(saved.headersArray !== null, missing !== 'headers');
            assert.equal(value.evaluations(), 0);
        }
        finally
        {
            value.probe.dispose();
        }
    });
}

test('probe original response retains capture failure when its private sink also fails (Node model)', async () =>
{
    const sinkError = new Error('private sink failed');
    const value = probeOriginalModel({ headerError: new Error('private original failure'), saveOriginalResponse: async () =>
    {
        throw sinkError;
    } });
    try
    {
        await assert.rejects(value.probe.finish(), (error) => error.message === 'locale probe original response capture is incomplete'
            && error.privateSinkError === sinkError);
        assert.equal(value.evaluations(), 0);
    }
    finally
    {
        value.probe.dispose();
    }
});

for (const overflow of ['body', 'headers'])
{
    test(`probe original response rejects ${overflow} overflow without retaining a truncated positive (Node model)`, async () =>
    {
        let saved;
        const value = probeOriginalModel({ body: overflow === 'body' ? Buffer.alloc(4 * 1024 * 1024 + 1) : Buffer.from('body'),
            headers: overflow === 'headers' ? Array.from({ length: 129 }, () => ({ name: 'model-header', value: 'private' })) : null,
            saveOriginalResponse: async (originals) =>
            {
                saved = structuredClone(originals);
            } });
        try
        {
            await assert.rejects(value.probe.finish(), /capture is incomplete/u);
            assert.equal(overflow === 'body' ? saved.bodyBase64 : saved.headersArray, null);
            assert.ok(saved.failures.some((failure) => failure.includes('overflow')));
            assert.equal(value.evaluations(), 0);
        }
        finally
        {
            value.probe.dispose();
        }
    });
}

test('probe original response private sink failure cannot produce a diagnostic success (Node model)', async () =>
{
    const sinkError = new Error('private sink failed');
    const value = probeOriginalModel({ saveOriginalResponse: async () =>
    {
        throw sinkError;
    } });
    try
    {
        await assert.rejects(value.probe.finish(), (error) => error === sinkError);
        assert.equal(value.evaluations(), 0);
    }
    finally
    {
        value.probe.dispose();
    }
});

test('probe original response cleanup saves settled capture without success assertions or rereading (Node model)', async () =>
{
    let publications = 0;
    const value = probeOriginalModel({ saveOriginalResponse: async (originals) =>
    {
        publications += 1;
        assert.equal(Buffer.from(originals.bodyBase64, 'base64').toString(), 'private document');
    } });
    try
    {
        await nextTurn();
        const scenarioError = new Error('first scenario assertion failed');
        let observedError;
        try
        {
            throw scenarioError;
        }
        catch (error)
        {
            observedError = error;
        }
        finally
        {
            assert.equal(await value.probe.saveAvailableOriginal(), true);
        }
        assert.equal(observedError, scenarioError);
        assert.equal(await value.probe.saveAvailableOriginal(), true);
        assert.equal(publications, 1);
        assert.equal(value.reads(), 1);
        assert.equal(value.headerReads(), 1);
        assert.equal(value.evaluations(), 0);
    }
    finally
    {
        value.probe.dispose();
    }
});

test('probe original response cleanup does not wait for pending capture and can retain its later settlement (Node model)', async () =>
{
    let settleBody;
    let publications = 0;
    const body = new Promise((resolve) =>
    {
        settleBody = resolve;
    });
    const value = probeOriginalModel({ body, saveOriginalResponse: async () =>
    {
        publications += 1;
    } });
    try
    {
        await nextTurn();
        assert.equal(await value.probe.saveAvailableOriginal(), false);
        assert.equal(publications, 0);
        value.probe.dispose();
        settleBody(Buffer.from('settled after close model'));
        await nextTurn();
        assert.equal(await value.probe.saveAvailableOriginal(), true);
        assert.equal(publications, 1);
        assert.equal(value.reads(), 1);
        assert.equal(value.evaluations(), 0);
    }
    finally
    {
        value.probe.dispose();
    }
});

test('probe original response cleanup retains one failed publication without retrying or replacing the first error (Node model)', async () =>
{
    let publications = 0;
    const sinkError = new Error('private sink error must not enter the public receipt');
    const scenarioError = new Error('first scenario assertion failed');
    const value = probeOriginalModel({ saveOriginalResponse: async () =>
    {
        publications += 1;
        throw sinkError;
    } });
    try
    {
        await nextTurn();
        let firstError;
        let secondaryFailed = false;
        try
        {
            throw scenarioError;
        }
        catch (error)
        {
            firstError = error;
        }
        finally
        {
            try
            {
                await value.probe.saveAvailableOriginal();
            }
            catch
            {
                secondaryFailed = true;
            }
        }
        assert.equal(firstError, scenarioError);
        assert.equal(secondaryFailed, true);
        await assert.rejects(value.probe.saveAvailableOriginal(), (error) => error === sinkError);
        assert.equal(publications, 1);
        assert.equal(value.evaluations(), 0);
    }
    finally
    {
        value.probe.dispose();
    }
});

test('probe original response successful finish and cleanup share the same private publication (Node model)', async () =>
{
    let publications = 0;
    const value = probeOriginalModel({ saveOriginalResponse: async () =>
    {
        publications += 1;
    } });
    try
    {
        await value.probe.finish();
        assert.equal(await value.probe.saveAvailableOriginal(), true);
        assert.equal(publications, 1);
        assert.equal(value.reads(), 1);
        assert.equal(value.headerReads(), 1);
    }
    finally
    {
        value.probe.dispose();
    }
});

test('probe private publication uses the original writer without replacing an existing final leaf (Node I/O model)', () =>
{
    const directory = mkdtempSync(path.join(os.tmpdir(), 'fsusblog-probe-publication-model-'));
    const target = path.join(directory, 'original.json');
    try
    {
        const first = writePrivateJson(target, { source: 'first-observed-model' }, { overwrite: false });
        const before = { bytes: readFileSync(target), ino: statSync(target).ino, mode: statSync(target).mode };
        assert.throws(() => writePrivateJson(target, { source: 'later-model' }, { overwrite: false }), { code: 'EEXIST' });
        assert.deepEqual(readFileSync(target), before.bytes);
        assert.equal(statSync(target).ino, before.ino);
        assert.equal(statSync(target).mode, before.mode);
        assert.equal(before.mode & 0o777, 0o600);
        assert.equal(readPrivateJson(target).contentDigest, first.contentDigest);
        assert.deepEqual(readdirSync(directory), ['original.json']);
        writePrivateJson(target, { source: 'existing-replacement-default' });
        assert.equal(readPrivateJson(target).document.source, 'existing-replacement-default');
    }
    finally
    {
        rmSync(directory, { recursive: true });
    }
});

test('probe private publication validates its option before creating a misleading final leaf (Node I/O model)', () =>
{
    const directory = mkdtempSync(path.join(os.tmpdir(), 'fsusblog-probe-publication-model-'));
    const target = path.join(directory, 'original.json');
    try
    {
        assert.throws(() => writePrivateJson(target, { source: 'model' }, { overwrite: 'false' }), /must be boolean/u);
        assert.equal(existsSync(target), false);
        assert.deepEqual(readdirSync(directory), []);
        assert.throws(() => readPrivateJson(target), (error) => error.cause?.code === 'ENOENT');
    }
    finally
    {
        rmSync(directory, { recursive: true });
    }
});

test('observer event subscriptions are removed on explicit cleanup, page close and abort', async () =>
{
    // Only listener lifecycle is simulated here; no DOM/HTML or browser observations are fabricated.
    for (const end of ['dispose', 'close', 'abort'])
    {
        const events = new EventEmitter();
        const controller = new AbortController();
        const probe = observePublicShellLocaleProbe(events, {}, { signal: controller.signal });
        assert.equal(events.eventNames().length, 6);
        if (end === 'dispose')
        {
            probe.dispose();
        }
        if (end === 'close')
        {
            events.emit('close');
        }
        if (end === 'abort')
        {
            controller.abort();
        }
        assert.deepEqual(events.eventNames(), []);
        probe.dispose();
        await assert.rejects(probe.finish(), /already disposed/u);
    }
    const controller = new AbortController();
    controller.abort();
    const events = new EventEmitter();
    assert.throws(() => observePublicShellLocaleProbe(events, {}, { signal: controller.signal }), /after abort/u);
    assert.deepEqual(events.eventNames(), []);
});

test('resource pass-through retains earlier handlers rather than bypassing the missing-header route (Node route model)', async () =>
{
    let handler;
    let earlierHandlerCalls = 0;
    let unregistered = false;
    const context = {
        route(_matches, value)
        {
            handler = value;
        },
        unroute(_matches, value)
        {
            assert.equal(value, handler);
            unregistered = true;
        }
    };
    const barrier = createPublicShellLocaleResourceBarrier();
    const cleanup = await bindPublicShellLocaleResourceBarrier(context, 'http://runtime.invalid/domain-resource', barrier);
    const pending = handler({
        async fallback()
        {
            earlierHandlerCalls += 1;
        },
        continue: () => assert.fail('pass-through bypassed the earlier route')
    });
    await barrier.entered;
    assert.equal(earlierHandlerCalls, 0);
    barrier.release();
    await pending;
    assert.equal(earlierHandlerCalls, 1);
    await cleanup();
    assert.equal(unregistered, true);
});

test('resource pass-through fails closed when routing composition is unavailable (Node route model)', async () =>
{
    let handler;
    let networkCalls = 0;
    const context = {
        route(_matches, value)
        {
            handler = value;
        },
        unroute(_matches, value)
        {
            assert.equal(value, handler);
        }
    };
    const barrier = createPublicShellLocaleResourceBarrier();
    const cleanup = await bindPublicShellLocaleResourceBarrier(context, 'http://runtime.invalid/domain-resource', barrier);
    const pending = handler({ continue: () => networkCalls += 1 });
    const rejected = assert.rejects(pending, /fallback/u);
    await barrier.entered;
    barrier.release();
    await rejected;
    assert.equal(networkCalls, 0);
    await cleanup();
});

// This is a loopback HTTP adapter for resource-boundary unit tests, not a browser receipt.
async function loopbackResourceContext(t)
{
    const bindings = [];
    const failures = [];
    const server = http.createServer((request, response) =>
    {
        const url = new URL(request.url, `http://127.0.0.1:${server.address().port}`);
        const binding = bindings.find((item) => item.matches(url));
        const original = () =>
        {
            response.writeHead(200, { 'Content-Type': 'text/plain' });
            response.end('original resource');
        };
        if (!binding)
        {
            original();
            return;
        }
        Promise.resolve(binding.handler({
            continue: original,
            fallback: original,
            abort: () => response.destroy(),
            fulfill: ({ status, contentType = 'text/plain', body }) =>
            {
                response.writeHead(status, { 'Content-Type': contentType });
                response.end(body);
            }
        })).catch((error) =>
        {
            failures.push(error);
            response.destroy();
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () =>
    {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        assert.deepEqual(failures, []);
    });
    return {
        url: `http://127.0.0.1:${server.address().port}/locale-resource`,
        context: {
            route(matches, handler)
            {
                bindings.push({ matches, handler });
            },
            unroute(matches, handler)
            {
                const index = bindings.findIndex((item) => item.matches === matches && item.handler === handler);
                assert.notEqual(index, -1, 'cleanup must unregister the exact binding');
                bindings.splice(index, 1);
            }
        }
    };
}

for (const action of [
    { kind: 'continue' },
    { kind: 'http-error', status: 409 },
    { kind: 'invalid-content', body: '{invalid-artifact', contentType: 'application/json' },
    { kind: 'abort' }
])
{
    test(`HTTP binding executes ${action.kind} only for the exact resource and restores traffic on cleanup`, async (t) =>
    {
        const { context, url } = await loopbackResourceContext(t);
        const barrier = createPublicShellLocaleResourceBarrier();
        const cleanup = await bindPublicShellLocaleResourceBarrier(context, url, barrier);
        t.after(() => barrier.close());
        const unrelated = await fetch(`${url}?different-identity=1`);
        assert.equal(await unrelated.text(), 'original resource');
        let completed = false;
        const result = fetch(url).then(async (response) =>
        {
            completed = true;
            return { status: response.status, contentType: response.headers.get('content-type'), body: await response.text() };
        }, (error) =>
        {
            completed = true;
            return { error };
        });
        await barrier.entered;
        assert.equal(completed, false);
        barrier.release(action);
        const observed = await result;
        if (action.kind === 'abort')
        {
            assert.ok(observed.error);
        }
        else
        {
            assert.equal(observed.status, action.status ?? 200);
            assert.equal(observed.body, action.kind === 'continue' ? 'original resource' : action.body ?? '');
            assert.equal(observed.contentType, action.contentType ?? 'text/plain');
        }
        await cleanup();
        const restored = await fetch(url);
        assert.equal(restored.status, 200);
        assert.equal(await restored.text(), 'original resource');
    });
}

test('HTTP binding cleanup aborts a pending request without waiting for an artificial delay', async (t) =>
{
    const { context, url } = await loopbackResourceContext(t);
    const barrier = createPublicShellLocaleResourceBarrier();
    const cleanup = await bindPublicShellLocaleResourceBarrier(context, url, barrier);
    const outcome = fetch(url).then(() => 'unexpected-response', () => 'aborted');
    await barrier.entered;
    await cleanup();
    assert.equal(await outcome, 'aborted');
    assert.equal(await (await fetch(url)).text(), 'original resource');
});

test('resource barrier delays a real loopback HTTP response until explicitly released', async (t) =>
{
    const barrier = createPublicShellLocaleResourceBarrier();
    const server = http.createServer(async (_request, response) =>
    {
        const action = await barrier.wait();
        response.writeHead(action.kind === 'http-error' ? action.status : 200);
        response.end('local resource-boundary test');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () =>
    {
        barrier.close();
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    });
    let completed = false;
    const request = http.get(`http://127.0.0.1:${server.address().port}/domain-resource`);
    const responsePromise = once(request, 'response').then(([response]) =>
    {
        completed = true;
        response.resume();
        return response;
    });
    await barrier.entered;
    assert.equal(completed, false);
    barrier.release({ kind: 'http-error', status: 503 });
    const response = await responsePromise;
    assert.equal(response.statusCode, 503);
    await once(response, 'end');
    assert.equal(completed, true);
    await assert.rejects(barrier.wait(), /duplicate requests/u);
});

test('cleanup unblocks a pending resource and duplicate or invalid actions fail closed', async () =>
{
    const barrier = createPublicShellLocaleResourceBarrier();
    const pending = barrier.wait();
    await barrier.entered;
    assert.throws(() => barrier.release({ kind: 'unknown' }), /unknown resource action/u);
    assert.throws(() => barrier.release({ kind: 'http-error', status: 200 }), /failure status/u);
    barrier.close();
    assert.deepEqual(await pending, { kind: 'abort' });
    await assert.rejects(barrier.wait(), /closed/u);
    assert.throws(() => barrier.release(), /already settled/u);
});
