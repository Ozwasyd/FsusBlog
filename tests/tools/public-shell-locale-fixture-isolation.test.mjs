import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import { chmod, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const lifecycleUrl = new URL('../browser-contract/fixture-lifecycle.mjs', import.meta.url);
const providerUrl = new URL('../browser-contract/default-fixture-provider.mjs', import.meta.url);
const {
    assertPublicShellLocaleScenesReleased, closePublicShellLocaleSceneBindings,
    preparePublicShellLocaleSceneBinding, readPublicShellLocaleSceneBindings,
    transitionPublicShellLocaleSceneBinding, cleanupBrowserContractFixture, resolveBrowserContractRunIdentity
} = await import(lifecycleUrl);
const { resolvePublicShellLocaleSceneAuthority } = await import(providerUrl);
const {
    preparePublicShellLocaleScene, consumePublicShellLocaleScene,
    finishPublicShellLocaleScene, abandonPublicShellLocaleScene,
    readPublicShellLocaleRootAuthority
} = await import(new URL('../browser-contract/fixture.mjs', import.meta.url));
const { createPublicShellLocaleMatrix } = await import(new URL('../browser-contract/public-shell-locale-matrix.mjs', import.meta.url));
const { buildFixtureReceipt } = await import(new URL('../../tools/test-fixtures/receipt/fixture-receipt.mjs', import.meta.url));
const { fixtureCatalogDigest, expandedCapabilityDigest } = await import(new URL('../../tools/testing/fixture-catalog.mjs', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const matrix = await createPublicShellLocaleMatrix(repoRoot);
const anonymous = matrix.scenes.find((scene) => scene.issue === 2083 && scene.authActionContext === 'anonymous'
    && scene.negotiationId.endsWith('/exact') && scene.route === 'Home');
const otherAnonymous = matrix.scenes.find((scene) => scene.issue === 2084 && scene.authActionContext === 'anonymous');
const authenticated = matrix.scenes.find((scene) => scene.authActionContext === 'authenticated');
const admin = matrix.scenes.find((scene) => scene.authActionContext === 'admin');
const ledgerName = 'public-shell-locale-scene-bindings.json';

// All fixtures below are explicit Node contract models. No host, session minting or rendered qualification.
async function model(t, scene = anonymous)
{
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'fsusblog-chain4-scene-model-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const env = {
        ...process.env, FSUSBLOG_PLAYWRIGHT_SESSION_MODE: 'browser-contract',
        FSUSBLOG_BROWSER_CONTRACT_RUN_ID: 'node-scene-boundary-model'
    };
    const sourceState = { commit: matrix.identity.sourceCommit, worktreeFingerprint: matrix.identity.worktreeFingerprint };
    const identity = { ...resolveBrowserContractRunIdentity({ env, sourceState, repoRoot }), fixtureRoot: root };
    const preparation = { id: randomUUID(), startedAt: new Date().toISOString() };
    const build = { receiptContentDigest: `sha256:${'c'.repeat(64)}`, profile: 'release' };
    const request = {
        identity: { commit: identity.commit, runId: identity.runId, laneId: identity.laneId, namespace: identity.namespace },
        preparation, sourceState, build, sceneId: scene.id,
        resources: {
            fixtureRoot: root, databaseSchema: identity.databaseSchema, databaseInstance: identity.databaseInstance,
            redisNamespace: identity.redisNamespace, redisInstance: identity.redisInstance
        }
    };
    const runtime = { frontendUrl: 'http://127.0.0.1:3000', backendUrl: 'http://127.0.0.1:7568', isolatedDatabase: true, testSessionHeader: false };
    const state = {
        schema: 'fsusblog.browser-contract-default-provider-state.v1', phase: 'prepared',
        namespace: identity.namespace, preparation, sourceState, buildIdentity: build,
        runtimeRunId: 'node-fixture-model', runtime,
        containers: { postgres: { name: identity.databaseInstance, id: 'd'.repeat(64) }, redis: { name: identity.redisInstance, id: 'e'.repeat(64) } }
    };
    const manifest = {
        schema: 'fsusblog.browser-contract-fixture.v2', sealed: true,
        identity: request.identity, preparation, sourceState, buildIdentity: build,
        baseUrl: runtime.frontendUrl, backendUrl: runtime.backendUrl, transport: { testSessionHeader: false }
    };
    const receipt = buildFixtureReceipt({
        terminalStatus: 'verified',
        executionIdentity: { runId: state.runtimeRunId, namespace: identity.namespace, source: sourceState },
        profileIdentity: { profileId: 'none', profileSource: 'dev-cli', executionClass: 'runtime', sealed: true },
        catalogDigest: fixtureCatalogDigest(), expandedCapabilityDigest: expandedCapabilityDigest([]),
        serviceIdentity: request.resources
    });
    for (const [name, value] of Object.entries({
        'provider-state.json': state, 'contract-fixture.json': manifest,
        'prepare-state.json': { producerOutputs: {} }, 'fixture-receipt.json': receipt
    }))
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
const entity = request.operation === 'readPublicShellLocaleAuthority'
    ? authority : request.operation === 'preparePublicShellLocaleScene'
    ? await preparePublicShellLocaleSceneBinding(request, scene, authority)
    : await transitionPublicShellLocaleSceneBinding(request, authority);
process.stdout.write(JSON.stringify({ schema: 'fsusblog.browser-contract-fixture-provider-response.v1', operation: request.operation, status: 'ok', entity }));
`, { mode: 0o600 });
    env.FSUSBLOG_BROWSER_CONTRACT_FIXTURE_PROVIDER = provider;
    const prepared = { identity, preparation, sourceState, build, root, repoRoot, env, lifecycle: { status: 'prepared', runtime } };
    const { authority } = await resolvePublicShellLocaleSceneAuthority(request);
    return { root, request, authority, prepared };
}

function modelBrowser(context, observe = () =>
{
    // No-op observation hook for the Node-only Browser model.
})
{
    const contexts = [];
    const close = context.close;
    context.close = async () =>
    {
        await close();
        contexts.splice(contexts.indexOf(context), 1);
    };
    const browser = {
        contexts: () => [...contexts],
        newContext: async (options) =>
        {
            observe(options);
            contexts.push(context);
            return context;
        }
    };
    context.browser = () => browser;
    return browser;
}

test('Root authority query uses the configured provider without allocating any scene lease (Node owner model)', async (t) =>
{
    assert.equal(typeof readPublicShellLocaleRootAuthority, 'function');
    const { prepared, root, authority } = await model(t, matrix.scenes[0]);
    const actual = await readPublicShellLocaleRootAuthority(prepared, { matrix });
    assert.deepEqual(actual, authority);
    assert.equal(readPublicShellLocaleSceneBindings(root), null);
    await assert.rejects(() => readPublicShellLocaleRootAuthority({ ...prepared, sourceState: {
        ...prepared.sourceState, commit: 'a'.repeat(40)
    } }, { matrix }), /source/);
    assert.equal(readPublicShellLocaleSceneBindings(root), null);
});

test('Root authority cancellation rejects a configured provider late success without allocating leases (Node owner model)', async (t) =>
{
    const { prepared, root } = await model(t, matrix.scenes[0]);
    const readyFile = path.join(root, 'query-ready');
    await writeFile(prepared.env.FSUSBLOG_BROWSER_CONTRACT_FIXTURE_PROVIDER, `
import { writeFile } from 'node:fs/promises';
const chunks = [];
for await (const chunk of process.stdin) { chunks.push(chunk); }
const request = JSON.parse(Buffer.concat(chunks));
process.on('SIGTERM', () => {
    process.stdout.write(JSON.stringify({ schema: 'fsusblog.browser-contract-fixture-provider-response.v1', operation: request.operation, status: 'ok', entity: {} }));
    process.exit(0);
});
await writeFile(${JSON.stringify(readyFile)}, 'query pending', { flag: 'wx', mode: 0o600 });
setInterval(() => {}, 1000);
`, { mode: 0o600 });
    const ready = Promise.withResolvers();
    const watcher = watch(root, (_event, name) =>
    {
        if (name === 'query-ready')
        {
            ready.resolve();
        }
    });
    t.after(() => watcher.close());
    const controller = new AbortController();
    t.after(() => controller.abort());
    const outcome = assert.rejects(() => readPublicShellLocaleRootAuthority(prepared, {
        matrix, signal: controller.signal
    }), (error) => error.failureClass === 'infra' && /cancelled/u.test(error.message));
    await Promise.race([ready.promise, outcome.then(() =>
    {
        throw new Error('query ended before the configured provider became pending');
    })]);
    controller.abort();
    await outcome;
    watcher.close();
    assert.equal(readPublicShellLocaleSceneBindings(root), null);
    await assert.rejects(() => readPublicShellLocaleRootAuthority(prepared, {
        matrix, signal: controller.signal
    }), (error) => error.failureClass === 'infra' && /cancelled/u.test(error.message));
    assert.equal(readPublicShellLocaleSceneBindings(root), null);
});

test('anonymous JS-disabled context uses no login state; exact real-factory enter/close facts', async (t) =>
{
    const { prepared, root } = await model(t);
    const handle = await preparePublicShellLocaleScene(prepared, { matrix, sceneId: anonymous.id });
    let options;
    let closed = 0;
    const context = { close: async () =>
    {
        closed += 1;
    } };
    const browser = modelBrowser(context, (value) =>
    {
        options = value;
    });
    const actual = await consumePublicShellLocaleScene(prepared, handle, browser);
    assert.equal(actual, context);
    assert.equal(options.javaScriptEnabled, false);
    assert.equal(options.serviceWorkers, 'block');
    assert.deepEqual(options.storageState, { cookies: [], origins: [] });
    assert.deepEqual(options.viewport, anonymous.viewport);
    assert.equal(options.extraHTTPHeaders['Accept-Language'], anonymous.locale);
    assert.throws(() => assertPublicShellLocaleScenesReleased(root), /premature/);
    await assert.rejects(() => cleanupBrowserContractFixture(prepared), /premature/);
    await assert.rejects(() => consumePublicShellLocaleScene(prepared, handle, browser), /already consumed/);
    await assert.rejects(() => finishPublicShellLocaleScene(prepared, handle, { close: async () =>
    {
        assert.fail('foreign context must not close');
    } }), /exact live context/);
    const finished = await finishPublicShellLocaleScene(prepared, handle, context);
    assert.equal(closed, 1);
    assert.equal(finished.entered, 1);
    assert.equal(finished.ended, 1);
    assert.equal(finished.status, 'finished');
    assert.equal(finished.authority.fixtureReceiptDigest.startsWith('sha256:'), true);
    assertPublicShellLocaleScenesReleased(root);
    await assert.rejects(() => finishPublicShellLocaleScene(prepared, handle, context), /exact live context/);
    const next = await preparePublicShellLocaleScene(prepared, { matrix, sceneId: otherAnonymous.id });
    assert.notEqual(next.actorId, handle.actorId);
    assert.notEqual(next.contextId, handle.contextId);
    await assert.rejects(() => consumePublicShellLocaleScene(prepared, next, browser), /reused/);
    assert.throws(() => assertPublicShellLocaleScenesReleased(root), /premature/);
});

test('missing Accept-Language removes browser defaults at the request boundary, not just context extras', async (t) =>
{
    const scene = matrix.scenes.find((item) => item.issue === 2083 && item.authActionContext === 'anonymous'
        && item.negotiationId === 'default/missing' && item.route === 'Home');
    const { prepared, root } = await model(t, scene);
    const handle = await preparePublicShellLocaleScene(prepared, { matrix, sceneId: scene.id });
    let handler;
    let options;
    const context = {
        close: async () =>
        {},
        route: async (pattern, callback) =>
        {
            assert.equal(pattern, '**/*');
            handler = callback;
        }
    };
    await consumePublicShellLocaleScene(prepared, handle, modelBrowser(context, (value) =>
    {
        options = value;
    }));
    assert.equal(options.javaScriptEnabled, false);
    assert.equal(options.serviceWorkers, 'block');
    assert.deepEqual(options.extraHTTPHeaders, {});
    assert.equal(typeof handler, 'function');
    for (const headerName of ['accept-language', 'Accept-Language', 'ACCEPT-LANGUAGE'])
    {
        const original = { [headerName]: 'en-US,en;q=0.9', accept: 'text/html', 'x-fsus-client': 'existing-client' };
        let sent;
        await handler({
            request: () => ({ allHeaders: async () => original }),
            continue: async (override) =>
            {
                sent = override.headers;
            }
        });
        assert.deepEqual(sent, { accept: 'text/html', 'x-fsus-client': 'existing-client' });
        assert.equal(original[headerName], 'en-US,en;q=0.9');
    }
    const finished = await finishPublicShellLocaleScene(prepared, handle, context);
    assert.equal(finished.firstFailure, null);
    assertPublicShellLocaleScenesReleased(root);
});

test('missing-header route setup failure retains first failure and closes the owned context', async (t) =>
{
    const scene = matrix.scenes.find((item) => item.issue === 2083 && item.authActionContext === 'anonymous'
        && item.negotiationId === 'default/missing' && item.route === 'Home');
    const { prepared, root } = await model(t, scene);
    const handle = await preparePublicShellLocaleScene(prepared, { matrix, sceneId: scene.id });
    const failure = new Error('route setup rejected');
    let closed = 0;
    const context = {
        close: async () =>
        {
            closed += 1;
        },
        route: async () =>
        {
            throw failure;
        }
    };
    await assert.rejects(() => consumePublicShellLocaleScene(prepared, handle, modelBrowser(context)), (error) => error === failure);
    assert.equal(closed, 1);
    const [lease] = readPublicShellLocaleSceneBindings(root).leases;
    assert.equal(lease.status, 'finished');
    assert.equal(lease.firstFailure.message, failure.message);
    assertPublicShellLocaleScenesReleased(root);
});

test('missing-header setup failure stays primary when context close fails; recovery does not re-enter', async (t) =>
{
    const scene = matrix.scenes.find((item) => item.issue === 2083 && item.authActionContext === 'anonymous'
        && item.negotiationId === 'default/missing' && item.route === 'Home');
    const { prepared, root } = await model(t, scene);
    const handle = await preparePublicShellLocaleScene(prepared, { matrix, sceneId: scene.id });
    const primary = new Error('missing-header route rejected');
    const secondary = new Error('context close rejected');
    let attempts = 0;
    const context = {
        close: async () =>
        {
            if (++attempts === 1)
            {
                throw secondary;
            }
        },
        route: async () =>
        {
            throw primary;
        }
    };
    await assert.rejects(() => consumePublicShellLocaleScene(prepared, handle, modelBrowser(context)), (error) => error === primary);
    assert.equal(primary.sceneCleanupError, secondary);
    const [retained] = readPublicShellLocaleSceneBindings(root).leases;
    assert.equal(retained.status, 'entered');
    assert.equal(retained.entered, 1);
    assert.equal(retained.ended, 0);
    assert.equal(retained.firstFailure.message, primary.message);
    assert.throws(() => assertPublicShellLocaleScenesReleased(root), /premature/);
    const finished = await finishPublicShellLocaleScene(prepared, handle, context);
    assert.equal(finished.entered, 1);
    assert.equal(finished.ended, 1);
    assert.equal(finished.firstFailure.message, primary.message);
    assert.equal(attempts, 2);
    assertPublicShellLocaleScenesReleased(root);
});

test('official auth allocation gap blocks user/admin and cannot consume fixed sessions', async (t) =>
{
    const { root, prepared } = await model(t);
    for (const scene of [authenticated, admin])
    {
        const blocker = await preparePublicShellLocaleScene(prepared, { matrix, sceneId: scene.id });
        assert.equal(blocker.status, 'blocked');
        assert.equal(blocker.reason, 'canonical-scene-auth-allocation-unavailable');
        assert.equal(blocker.contextCount, 0);
        await assert.rejects(() => consumePublicShellLocaleScene(prepared, blocker, {
            newContext: () => assert.fail('blocked auth must not create a context')
        }), /missing/);
    }
    assert.equal(readPublicShellLocaleSceneBindings(root).leases.length, 0);
    assertPublicShellLocaleScenesReleased(root);
});

test('abandoned prepared lease never enters; namespace closing forbids late preparation', async (t) =>
{
    const { prepared, root, request, authority } = await model(t);
    const handle = await preparePublicShellLocaleScene(prepared, { matrix, sceneId: anonymous.id });
    await assert.rejects(() => abandonPublicShellLocaleScene({ ...prepared }, handle), /foreign/);
    const ended = await abandonPublicShellLocaleScene(prepared, handle, new Error('node model scene cancelled'));
    assert.equal(ended.entered, 0);
    assert.equal(ended.ended, 0);
    assert.equal(ended.firstFailure.message, 'node model scene cancelled');
    await closePublicShellLocaleSceneBindings(root);
    await assert.rejects(() => preparePublicShellLocaleSceneBinding({ ...request, sceneId: otherAnonymous.id }, otherAnonymous, authority), /closing/);
});

test('creation failure preserves original error and owns zero successful contexts', async (t) =>
{
    const { prepared, root } = await model(t);
    const handle = await preparePublicShellLocaleScene(prepared, { matrix, sceneId: anonymous.id });
    const original = new Error('node model factory failure');
    await assert.rejects(() => consumePublicShellLocaleScene(prepared, handle, { contexts: () => [], newContext: async () =>
    {
        throw original;
    } }), (error) => error === original);
    const [lease] = readPublicShellLocaleSceneBindings(root).leases;
    assert.equal(lease.status, 'creation-failed');
    assert.equal(lease.firstFailure.message, original.message);
    assert.equal(lease.entered + lease.ended, 0);
    assertPublicShellLocaleScenesReleased(root);
});

test('close failure retains entered lease and first failure across a verified retry', async (t) =>
{
    const { prepared, root } = await model(t);
    const handle = await preparePublicShellLocaleScene(prepared, { matrix, sceneId: anonymous.id });
    let attempts = 0;
    const first = new Error('node model close failure');
    const context = { close: async () =>
    {
        attempts += 1;
        if (attempts === 1)
        {
            throw first;
        }
    } };
    await consumePublicShellLocaleScene(prepared, handle, modelBrowser(context));
    await assert.rejects(() => finishPublicShellLocaleScene(prepared, handle, context), (error) => error === first);
    assert.equal(readPublicShellLocaleSceneBindings(root).leases[0].firstFailure.message, first.message);
    assert.throws(() => assertPublicShellLocaleScenesReleased(root), /premature/);
    const finished = await finishPublicShellLocaleScene(prepared, handle, context, new Error('later failure'));
    assert.equal(finished.firstFailure.message, first.message);
    assert.equal(finished.ended, 1);
});

for (const field of ['leaseId', 'actorId', 'contextId', 'sceneId', 'owner', 'authority'])
{
    test(`reject foreign/mismatched ${field} before consuming; retain raw references`, async (t) =>
    {
        const { root, request, authority } = await model(t);
        const lease = await preparePublicShellLocaleSceneBinding(request, anonymous, authority);
        const changed = structuredClone(lease);
        changed[field] = field === 'owner' || field === 'authority' ? {} : 'foreign';
        await assert.rejects(() => transitionPublicShellLocaleSceneBinding({ ...request, lease: changed, phase: 'reserved' }, authority), /missing, foreign, stale or mismatched/);
        const retained = readPublicShellLocaleSceneBindings(root).leases[0];
        assert.equal(retained.status, 'prepared');
        assert.deepEqual(retained.authority.rawRefs, authority.rawRefs);
    });
}

for (const field of ['identity', 'preparation', 'sourceState', 'build', 'resources'])
{
    test(`reject stale or foreign canonical ${field}`, async (t) =>
    {
        const { request, authority } = await model(t);
        const lease = await preparePublicShellLocaleSceneBinding(request, anonymous, authority);
        const changed = structuredClone(request);
        if (field === 'resources')
        {
            changed.resources.databaseInstance = 'foreign';
        }
        else
        {
            changed[field] = {};
        }
        await assert.rejects(() => resolvePublicShellLocaleSceneAuthority(changed), /mismatch|stale/);
        if (field !== 'resources')
        {
            await assert.rejects(() => transitionPublicShellLocaleSceneBinding({ ...changed, lease, phase: 'reserved' }, authority), /mismatched/);
        }
    });
}

test('missing actor source, duplicate preparation and finish-before-enter fail closed', async (t) =>
{
    const { root, request, authority } = await model(t);
    await assert.rejects(() => preparePublicShellLocaleSceneBinding(request, anonymous, { ...authority, rawRefs: [] }), /incomplete/);
    const lease = await preparePublicShellLocaleSceneBinding(request, anonymous, authority);
    await assert.rejects(() => preparePublicShellLocaleSceneBinding(request, anonymous, authority), /reused/);
    await assert.rejects(() => preparePublicShellLocaleSceneBinding({ ...request, sceneId: otherAnonymous.id }, otherAnonymous, authority), /concurrency/);
    await assert.rejects(() => transitionPublicShellLocaleSceneBinding({ ...request, lease, phase: 'finished' }, authority), /out of order/);
    assert.equal(readPublicShellLocaleSceneBindings(root).leases[0].entered, 0);
});

for (const mutation of ['missing', 'mode', 'symlink', 'digest', 'runtime'])
{
    test(`official source ${mutation} is rejected without browser execution`, async (t) =>
    {
        const { root, request, authority } = await model(t);
        const lease = await preparePublicShellLocaleSceneBinding(request, anonymous, authority);
        const file = path.join(root, 'fixture-receipt.json');
        if (mutation === 'missing')
        {
            await rm(file);
        }
        if (mutation === 'mode')
        {
            await chmod(file, 0o644);
        }
        if (mutation === 'symlink')
        {
            const raw = await readFile(file);
            await rm(file);
            await writeFile(`${file}.model`, raw, { mode: 0o600 });
            await symlink(`${file}.model`, file);
        }
        if (mutation === 'digest')
        {
            const receipt = JSON.parse(await readFile(file, 'utf8'));
            receipt.executionIdentity.runId = 'tampered';
            await writeFile(file, JSON.stringify(receipt));
        }
        if (mutation === 'runtime')
        {
            const stateFile = path.join(root, 'provider-state.json');
            const state = JSON.parse(await readFile(stateFile, 'utf8'));
            state.runtime.frontendUrl = 'http://127.0.0.1:3999';
            await writeFile(stateFile, JSON.stringify(state));
        }
        await assert.rejects(() => resolvePublicShellLocaleSceneAuthority(request), /unreadable|private|symlink|digest mismatch|owner mismatch/);
        assert.deepEqual(readPublicShellLocaleSceneBindings(root).leases[0].authority.rawRefs, lease.authority.rawRefs);
    });
}

test('ledger tampering is not a context-count shortcut', async (t) =>
{
    const { root, request, authority } = await model(t);
    await preparePublicShellLocaleSceneBinding(request, anonymous, authority);
    const file = path.join(root, ledgerName);
    const state = JSON.parse(await readFile(file, 'utf8'));
    state.leases[0].status = 'finished';
    await writeFile(file, JSON.stringify(state));
    assert.throws(() => assertPublicShellLocaleScenesReleased(root), /schema/);
});

test('existing Browser context cannot be adopted as a fresh scene context', async (t) =>
{
    const { prepared, root } = await model(t);
    const handle = await preparePublicShellLocaleScene(prepared, { matrix, sceneId: anonymous.id });
    const context = { close: async () => assert.fail('foreign context must not close') };
    const browser = { contexts: () => [context], newContext: async () => context };
    context.browser = () => browser;
    await assert.rejects(() => consumePublicShellLocaleScene(prepared, handle, browser), /foreign or reused/);
    assert.equal(readPublicShellLocaleSceneBindings(root).leases[0].status, 'reserved');
    assert.throws(() => assertPublicShellLocaleScenesReleased(root), /premature/);
});

test('an unknown or edited matrix scene never reaches the provider', async (t) =>
{
    const { prepared } = await model(t);
    await assert.rejects(() => preparePublicShellLocaleScene(prepared, { matrix, sceneId: 'private-runner-scene' }), /canonical matrix/);
    const edited = structuredClone(matrix);
    edited.scenes[0].viewport.width += 1;
    await assert.rejects(() => preparePublicShellLocaleScene(prepared, { matrix: edited, sceneId: anonymous.id }), /current authority/);
});

test('late change to raw official preparation bytes invalidates an existing lease', async (t) =>
{
    const { root, request, authority } = await model(t);
    const lease = await preparePublicShellLocaleSceneBinding(request, anonymous, authority);
    await writeFile(path.join(root, 'prepare-state.json'), JSON.stringify({ producerOutputs: {}, changed: true }));
    const changed = await resolvePublicShellLocaleSceneAuthority(request);
    assert.notDeepEqual(changed.authority.rawRefs, authority.rawRefs);
    await assert.rejects(() => transitionPublicShellLocaleSceneBinding({ ...request, lease, phase: 'reserved' }, changed.authority), /mismatched/);
    assert.equal(readPublicShellLocaleSceneBindings(root).leases[0].entered, 0);
});

test('missing ledger after scene preparation cannot authorize early cleanup', async (t) =>
{
    const { root, prepared } = await model(t);
    await preparePublicShellLocaleScene(prepared, { matrix, sceneId: anonymous.id });
    await rm(path.join(root, ledgerName));
    await assert.rejects(() => cleanupBrowserContractFixture(prepared), /binding source is missing/);
    assert.equal(prepared.lifecycle.status, 'prepared');
});

test('driver failure remains primary when closing also fails and then retries', async (t) =>
{
    const { prepared, root } = await model(t);
    const handle = await preparePublicShellLocaleScene(prepared, { matrix, sceneId: anonymous.id });
    const primary = new Error('node model driver failure');
    const secondary = new Error('node model secondary close failure');
    let attempts = 0;
    const context = { close: async () =>
    {
        attempts += 1;
        if (attempts === 1)
        {
            throw secondary;
        }
    } };
    await consumePublicShellLocaleScene(prepared, handle, modelBrowser(context));
    await assert.rejects(() => finishPublicShellLocaleScene(prepared, handle, context, primary), (error) => error === secondary);
    assert.equal(readPublicShellLocaleSceneBindings(root).leases[0].firstFailure.message, primary.message);
    const ended = await finishPublicShellLocaleScene(prepared, handle, context);
    assert.equal(ended.firstFailure.message, primary.message);
    assert.equal(ended.entered, 1);
    assert.equal(ended.ended, 1);
});

test('published read capability requires the exact entered handle and live context (Node owner model)', async (t) =>
{
    const { readPublicShellLocaleScenePublishedArtifact } = await import(new URL('../browser-contract/fixture.mjs', import.meta.url));
    const { prepared } = await model(t);
    await writeFile(prepared.env.FSUSBLOG_BROWSER_CONTRACT_FIXTURE_PROVIDER, `
import { resolvePublicShellLocaleSceneAuthority } from ${JSON.stringify(providerUrl.href)};
import { preparePublicShellLocaleSceneBinding, transitionPublicShellLocaleSceneBinding } from ${JSON.stringify(lifecycleUrl.href)};
const chunks = [];
for await (const chunk of process.stdin) { chunks.push(chunk); }
const request = JSON.parse(Buffer.concat(chunks));
const { scene, authority } = await resolvePublicShellLocaleSceneAuthority(request);
let entity;
if (request.operation === 'readPublicShellLocalePublishedArtifact') {
    if (request.path !== '/') throw new Error('Node published-read path mismatch');
    entity = { sceneId: scene.id, matrixDigest: authority.matrixDigest, runtimeRunId: authority.runtimeRunId,
        artifact: { path: 'published-artifact-11111111-1111-4111-8111-111111111111.json', digest: 'sha256:' + 'a'.repeat(64) } };
} else if (request.operation === 'preparePublicShellLocaleScene') {
    entity = await preparePublicShellLocaleSceneBinding(request, scene, authority);
} else {
    entity = await transitionPublicShellLocaleSceneBinding(request, authority);
}
process.stdout.write(JSON.stringify({ schema: 'fsusblog.browser-contract-fixture-provider-response.v1', operation: request.operation, status: 'ok', entity }));
`, { mode: 0o600 });
    const handle = await preparePublicShellLocaleScene(prepared, { matrix, sceneId: anonymous.id });
    const context = { close: async () =>
    {} };
    await assert.rejects(readPublicShellLocaleScenePublishedArtifact(prepared, handle, context, '/'), /exact entered/);
    await consumePublicShellLocaleScene(prepared, handle, modelBrowser(context));
    await assert.rejects(readPublicShellLocaleScenePublishedArtifact(prepared, structuredClone(handle), context, '/'), /exact entered/);
    await assert.rejects(readPublicShellLocaleScenePublishedArtifact({ ...prepared }, handle, context, '/'), /exact entered/);
    await assert.rejects(readPublicShellLocaleScenePublishedArtifact(prepared, handle, {}, '/'), /exact entered/);
    const result = await readPublicShellLocaleScenePublishedArtifact(prepared, handle, context, '/');
    assert.equal(result.sceneId, anonymous.id);
    assert.equal(result.runtimeRunId, handle.authority.runtimeRunId);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.hasOwn(result, 'qualificationEligible'), false);
    await finishPublicShellLocaleScene(prepared, handle, context);
    await assert.rejects(readPublicShellLocaleScenePublishedArtifact(prepared, handle, context, '/'), /exact entered/);
});


test('account/device matrix plans cannot become prepared HTTP scenes through synthetic cookies', async t =>
{
    for (const plan of matrix.negotiationCases.filter(item => item.preferencePreparation !== null))
    {
        const scene = matrix.scenes.find(item => item.negotiationId === plan.id && item.route === 'Home');
        const { request } = await model(t, scene);
        await assert.rejects(resolvePublicShellLocaleSceneAuthority(request), /requires verified login\/refresh or explicit-auto cookie preparation/u);
    }
});
