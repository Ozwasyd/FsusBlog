import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';

import {
    admitPublicShellLocaleHarness,
    createPublicShellLocaleResourceBarrier
// eslint-disable-next-line import-x/no-relative-parent-imports -- Exercise the canonical Browser Contract locale harness facade.
} from '../browser-contract/public-shell-locale-harness.mjs';

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
