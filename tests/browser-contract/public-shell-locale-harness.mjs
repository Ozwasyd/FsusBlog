import assert from 'node:assert/strict';
import path from 'node:path';

// eslint-disable-next-line import-x/no-relative-parent-imports -- Reuse the immutable production build admission authority.
import { verifyProductionBuildReceipt } from '../../tools/ci/production-build-artifacts.mjs';

import { loadBrowserContractFixture } from './fixture.mjs';
import { validatePublicShellLocaleMatrix } from './public-shell-locale-matrix.mjs';

/** Consume the existing runner's prepared host; this facade never starts another lifecycle. */
export async function admitPublicShellLocaleHarness({ root, matrix, prepared, buildReceiptFile, env })
{
    assert.equal(env?.FSUSBLOG_PLAYWRIGHT_SESSION_MODE, 'browser-contract', 'canonical browser-contract mode required');
    assert.equal(prepared?.lifecycle?.status, 'prepared', 'formal host/fixture preparation must finish before locale admission');
    assert.ok(prepared.root && prepared.lifecycle.preparation?.id, 'current-run prepared fixture identity required');
    await validatePublicShellLocaleMatrix(matrix, root);
    const sourceState = {
        commit: matrix.identity.sourceCommit,
        worktreeFingerprint: matrix.identity.worktreeFingerprint
    };
    const verified = verifyProductionBuildReceipt({
        artifactRoot: path.dirname(buildReceiptFile),
        receiptFile: path.basename(buildReceiptFile),
        expectedSourceState: sourceState
    });
    for (const domain of ['backend-runtime', 'frontend-dist', 'generated-contracts', 'wasm'])
    {
        assert.ok(verified.receipt.domains.some((item) => item.name === domain), `missing immutable build domain: ${domain}`);
    }
    const fixture = await loadBrowserContractFixture({
        repoRoot: root,
        env: { ...env, FSUSBLOG_TEST_SESSION: prepared.identity.namespace },
        fixtureRoot: prepared.root,
        lifecycle: prepared.lifecycle,
        expectedSourceState: sourceState,
        expectedBuild: { receiptContentDigest: verified.receipt.contentDigest }
    });
    assert.equal(fixture.testSession, null, 'locale harness cannot send a test-session header');
    let active = false;
    const visited = new Set();
    return Object.freeze({
        identity: Object.freeze({
            matrixDigest: matrix.contentDigest,
            sourceState,
            buildDigest: verified.receipt.contentDigest,
            namespace: fixture.namespace,
            preparationId: prepared.lifecycle.preparation.id
        }),
        fixture,
        /** The runner supplies its single browser context factory, preserving launch ownership. */
        async withScene(sceneId, createContext, observe)
        {
            assert.equal(active, false, 'locale scenes must run serially');
            assert.equal(visited.has(sceneId), false, 'locale scene retry is forbidden');
            const scene = matrix.scenes.find((item) => item.id === sceneId);
            assert.ok(scene, 'unknown locale scene');
            const negotiation = matrix.negotiationCases.find((item) => item.id === scene.negotiationId);
            assert.ok(negotiation, 'missing negotiation case');
            const storageState = scene.authActionContext === 'anonymous'
                ? { cookies: [], origins: [] }
                : structuredClone(scene.authActionContext === 'admin' ? fixture.admin.storageState : fixture.user.storageState);
            storageState.cookies = storageState.cookies.filter((item) => item.name !== 'fsusblog.locale');
            if (negotiation.cookie !== null)
            {
                storageState.cookies.push({
                    name: 'fsusblog.locale', value: negotiation.cookie, url: fixture.baseUrl,
                    httpOnly: true, secure: fixture.baseUrl.startsWith('https:'), sameSite: 'Lax'
                });
            }
            const options = {
                viewport: scene.viewport,
                storageState,
                serviceWorkers: 'block',
                extraHTTPHeaders: negotiation.header === null ? {} : { 'Accept-Language': negotiation.header }
            };
            active = true;
            visited.add(sceneId);
            let context;
            try
            {
                context = await createContext(options);
                return await observe({ context, fixture, scene, negotiation });
            }
            finally
            {
                try
                {
                    if (context)
                    {
                        await context.close();
                    }
                }
                finally
                {
                    active = false;
                }
            }
        }
    });
}

/** An explicit event barrier at the resource boundary; no timers or product state hooks. */
export function createPublicShellLocaleResourceBarrier()
{
    const entered = Promise.withResolvers();
    const released = Promise.withResolvers();
    let state = 'pending';
    let requests = 0;
    return Object.freeze({
        entered: entered.promise,
        async wait()
        {
            assert.notEqual(state, 'closed', 'resource barrier is closed');
            requests += 1;
            assert.equal(requests, 1, 'resource barrier cannot hide duplicate requests');
            entered.resolve();
            return await released.promise;
        },
        release(action = { kind: 'continue' })
        {
            assert.equal(state, 'pending', 'resource barrier is already settled');
            assert.ok(['continue', 'abort', 'http-error', 'invalid-content'].includes(action.kind), 'unknown resource action');
            if (action.kind === 'http-error')
            {
                assert.ok(Number.isInteger(action.status) && action.status >= 400 && action.status <= 599, 'failure status required');
            }
            if (action.kind === 'invalid-content')
            {
                assert.equal(typeof action.body, 'string', 'invalid-content bytes required');
                assert.equal(typeof action.contentType, 'string', 'invalid-content type required');
            }
            state = 'released';
            released.resolve(structuredClone(action));
        },
        close()
        {
            if (state === 'pending')
            {
                released.resolve({ kind: 'abort' });
            }
            state = 'closed';
        }
    });
}

/** Install on the existing context before navigation; exact URLs come from artifact identities. */
export async function bindPublicShellLocaleResourceBarrier(context, resourceUrl, barrier)
{
    const url = new URL(resourceUrl);
    assert.ok(['http:', 'https:'].includes(url.protocol), 'resource must use HTTP');
    assert.equal(url.username + url.password + url.hash, '', 'resource URL must not contain credentials or a fragment');
    const matches = (candidate) => candidate.href === url.href;
    const handler = async (route) =>
    {
        const action = await barrier.wait();
        if (action.kind === 'continue')
        {
            await route.continue();
        }
        else if (action.kind === 'abort')
        {
            await route.abort('failed');
        }
        else if (action.kind === 'http-error')
        {
            await route.fulfill({ status: action.status, body: '' });
        }
        else
        {
            await route.fulfill({ status: 200, contentType: action.contentType, body: action.body });
        }
    };
    await context.route(matches, handler);
    return async () =>
    {
        barrier.close();
        await context.unroute(matches, handler);
    };
}
