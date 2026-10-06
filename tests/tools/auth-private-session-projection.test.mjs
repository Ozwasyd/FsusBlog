import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, chmodSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { authPrivateIdentity, persistAuthPrivateCarrier, readAuthPrivateCarrier, invokeAuthPrivate, requireAuthPrivateCarriers, verifyAuthSession } = await import(new URL('../../tools/test-fixtures/producers/auth-session-producer.mjs', import.meta.url));
const { digestCanonical } = await import(new URL('../../tools/test-fixtures/receipt/canonical.mjs', import.meta.url));

function owned(context)
{
    const root = mkdtempSync(path.join(tmpdir(), 'issue-1851-auth-private-'));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    const execution = { runIdentity: 'run', namespace: 'ns', profileIdentity: { profileId: 'auth-basic' },
        sourceIdentity: { commit: 'a'.repeat(40), worktreeFingerprint: `sha256:${'b'.repeat(64)}` },
        plan: { catalogDigest: `sha256:${'c'.repeat(64)}`, variantPlanDigest: `sha256:${'d'.repeat(64)}` },
        handles: { authPrivateCarrierDir: root, serviceGeneration: `sha256:${'e'.repeat(64)}`, baseUrl: 'http://127.0.0.1:1', localAuthFixtureSecret: 'task-test-secret' } };
    return { execution, carrier: { identity: authPrivateIdentity(execution, 'f'.repeat(64)), opaque: 'unit-only-opaque-not-runtime-qualification',
        publicFact: { kind: 'admin', id: '7', semanticRole: 'admin.full-permission', fields: { adminSessionId: 'sid' } } } };
}

test('opaque carrier and generated reference are private, digest bound and contain no clear credential', (context) =>
{
    const { execution, carrier } = owned(context);
    const reference = persistAuthPrivateCarrier(execution, carrier);
    assert.equal(statSync(reference.path).mode & 0o777, 0o600);
    assert.equal(statSync(reference.referenceFile).mode & 0o777, 0o600);
    assert.deepEqual(readAuthPrivateCarrier(reference), carrier);
    assert.doesNotMatch(readFileSync(reference.referenceFile, 'utf8'), /opaque|accessToken|cookie/u);
    assert.doesNotMatch(readFileSync(reference.path, 'utf8'), /accessToken|cookie/u);
    assert.throws(() => readAuthPrivateCarrier({ ...reference, contentDigest: `sha256:${'0'.repeat(64)}` }), /digest mismatch/u);
    chmodSync(reference.path, 0o644);
    assert.throws(() => readAuthPrivateCarrier(reference), /private/u);
    chmodSync(reference.path, 0o600);
    const link = path.join(execution.handles.authPrivateCarrierDir, 'foreign-link');
    symlinkSync(reference.path, link);
    assert.throws(() => readAuthPrivateCarrier({ ...reference, path: link }), /symlink/u);
    writeFileSync(reference.path, '{"tampered":true}', { mode: 0o600 });
    assert.throws(() => readAuthPrivateCarrier(reference), /digest mismatch/u);
});

for (const field of ['runId', 'namespace', 'profileId', 'sourceCommit', 'sourceFingerprint', 'serviceGeneration', 'catalogDigest', 'variantPlanDigest', 'planDigest'])
{
    test(`carrier cannot be persisted for foreign ${field}`, (context) =>
    {
        const { execution, carrier } = owned(context);
        const wrong = { ...carrier, identity: { ...carrier.identity, [field]: 'foreign' } };
        if (field === 'planDigest')
        {
            // The full plan binding is authenticated by the backend DP verifier, not invented by this file writer.
            assert.notEqual(digestCanonical(wrong.identity), digestCanonical(carrier.identity));
        }
        else
        {
            assert.throws(() => persistAuthPrivateCarrier(execution, wrong), /binding invalid/u);
        }
    });
}

test('independent private verification rejects ok-only, mismatched carrier and HTTP failure without leaking body', async (context) =>
{
    const { execution, carrier } = owned(context);
    const original = globalThis.fetch;
    context.after(() =>
    {
        globalThis.fetch = original;
    });
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });
    await assert.rejects(invokeAuthPrivate(execution, carrier), /binding mismatch|canonical/u);
    globalThis.fetch = async () => new Response('sensitive-body-must-not-be-echoed', { status: 400 });
    await assert.rejects(invokeAuthPrivate(execution, carrier), (error) =>
    {
        assert.match(error.message, /HTTP 400/u);
        assert.doesNotMatch(error.message, /sensitive-body/u);
        return true;
    });
    globalThis.fetch = async (_url, request) =>
    {
        const body = JSON.parse(request.body);
        assert.equal(request.headers['X-Fsus-Test-Run-Id'], execution.runIdentity);
        assert.equal(body.reveal, false);
        return new Response(JSON.stringify({ ok: true, identity: carrier.identity, publicFact: carrier.publicFact,
            carrierDigest: createHash('sha256').update(carrier.opaque).digest('hex'), credentials: null }), { status: 200 });
    };
    const verified = await invokeAuthPrivate(execution, carrier);
    assert.equal(verified.credentials, null);
});

test('production prepare cannot qualify missing, duplicate, foreign or fact-drifted private carriers', (context) =>
{
    const { carrier } = owned(context);
    carrier.publicFact.fixtureIdentity = 'fxauth-owned';
    carrier.publicFact.kind = 'admin';
    const plan = { planDigest: carrier.identity.planDigest, roles: [{ kind: 'admin', expectedState: 'active',
        semanticRole: carrier.publicFact.semanticRole, fixtureIdentity: carrier.publicFact.fixtureIdentity }] };
    const result = { observations: { database: { entities: [carrier.publicFact] } } };
    requireAuthPrivateCarriers(plan, result, [carrier]);
    for (const wrong of [[], [carrier, carrier], [{ ...carrier, identity: { ...carrier.identity, planDigest: 'foreign' } }],
        [{ ...carrier, publicFact: { ...carrier.publicFact, id: 'foreign' } }],
        [{ ...carrier, publicFact: { ...carrier.publicFact, fields: { adminSessionId: 'foreign' } } }]])
    {
        assert.throws(() => requireAuthPrivateCarriers(plan, result, wrong), /exactly cover/u);
    }
});

test('already aborted private HTTP never starts a request', async (context) =>
{
    const { execution, carrier } = owned(context);
    const originalFetch = globalThis.fetch;
    context.after(() =>
    {
        globalThis.fetch = originalFetch;
    });
    let requests = 0;
    globalThis.fetch = async () =>
    {
        requests += 1;
        throw new Error('aborted private request reached transport');
    };
    const controller = new AbortController();
    const reason = new Error('abort-before-private-http');
    controller.abort(reason);
    await assert.rejects(invokeAuthPrivate(execution, carrier, { callerAbortSignal: controller.signal }),
        (error) => error === reason);
    assert.equal(requests, 0);
});

for (const phase of ['pending-headers', 'pending-body'])
{
    test(`caller cancellation aborts actual private fetch ${phase} while preserving the 60-second timeout`, async (context) =>
    {
        const { execution, carrier } = owned(context);
        const controller = new AbortController();
        const reason = new Error('abort-in-private-http');
        let received;
        const arrived = new Promise((resolve) =>
        {
            received = resolve;
        });
        let disconnected;
        const closed = new Promise((resolve) =>
        {
            disconnected = resolve;
        });
        const server = createServer((_request, response) =>
        {
            response.on('close', disconnected);
            if (phase === 'pending-body')
            {
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.write('{"ok":');
            }
            received();
        // An actual loopback transport with a pending response, not PG/Redis/JWT qualification.
        });
        context.after(() =>
        {
            server.closeAllConnections();
            server.close();
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        execution.handles.baseUrl = `http://127.0.0.1:${server.address().port}`;
        const originalTimeout = AbortSignal.timeout;
        const timeouts = [];
        AbortSignal.timeout = (milliseconds) =>
        {
            timeouts.push(milliseconds);
            return originalTimeout(milliseconds);
        };
        context.after(() =>
        {
            AbortSignal.timeout = originalTimeout;
        });
        const request = invokeAuthPrivate(execution, carrier, { callerAbortSignal: controller.signal });
        const rejected = assert.rejects(request, (error) => error === reason || error.name === 'AbortError');
        await arrived;
        controller.abort(reason);
        // Bound the red run: the old implementation ignores caller cancellation.
        let deadline;
        const outcome = await Promise.race([rejected.then(() => 'cancelled'),
            new Promise((resolve) =>
            {
                deadline = setTimeout(() => resolve('caller-cancellation-lost'), 2_000);
            })]);
        clearTimeout(deadline);
        if (outcome !== 'cancelled')
        {
            server.closeAllConnections();
            await rejected.catch(() => undefined);
        }
        assert.equal(outcome, 'cancelled');
        assert.deepEqual(timeouts, [60_000]);
        await closed;
    });
}

test('ordinary private callers retain the existing timeout without caller cancellation', async (context) =>
{
    const { execution, carrier } = owned(context);
    const originalFetch = globalThis.fetch;
    const originalTimeout = AbortSignal.timeout;
    const timeoutSignal = new AbortController().signal;
    context.after(() =>
    {
        globalThis.fetch = originalFetch;
        AbortSignal.timeout = originalTimeout;
    });
    let timeoutCalls = 0;
    AbortSignal.timeout = (milliseconds) =>
    {
        assert.equal(milliseconds, 60_000);
        timeoutCalls += 1;
        return timeoutSignal;
    };
    globalThis.fetch = async (_url, request) =>
    {
        assert.equal(request.signal, timeoutSignal);
        return new Response(JSON.stringify({ ok: true, identity: carrier.identity, publicFact: carrier.publicFact,
            carrierDigest: createHash('sha256').update(carrier.opaque).digest('hex'), credentials: null }), { status: 200 });
    };
    await invokeAuthPrivate(execution, carrier);
    assert.equal(timeoutCalls, 1);
});

test('auth verifier propagates caller cancellation to its nested actual private HTTP', async (context) =>
{
    const { execution, carrier } = owned(context);
    const reference = persistAuthPrivateCarrier(execution, carrier);
    const result = { planDigest: carrier.identity.planDigest, privateCarrierReferences: [reference],
        observations: { database: { entities: [carrier.publicFact] } }, entityIdentities: [] };
    const controller = new AbortController();
    const reason = new Error('abort-in-nested-private-verification');
    execution.handles.authFixtureAdapter = { async verify()
    {
        return { ok: true, receiptDigest: createHash('sha256').update(JSON.stringify(result)).digest('hex') };
    } };
    let received;
    const arrived = new Promise((resolve) =>
    {
        received = resolve;
    });
    let disconnected;
    const closed = new Promise((resolve) =>
    {
        disconnected = resolve;
    });
    let calls = 0;
    const server = createServer((request, response) =>
    {
        calls += 1;
        assert.equal(request.url, '/api/local/auth-fixture/private/verify');
        response.on('close', disconnected);
        received();
    });
    context.after(() =>
    {
        server.closeAllConnections();
        server.close();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    execution.handles.baseUrl = `http://127.0.0.1:${server.address().port}`;
    const operation = verifyAuthSession(execution, result, controller.signal);
    const rejected = assert.rejects(operation, (error) => error === reason);
    await arrived;
    controller.abort(reason);
    let deadline;
    const outcome = await Promise.race([rejected.then(() => 'cancelled'), new Promise((resolve) =>
    {
        deadline = setTimeout(() => resolve('caller-cancellation-lost'), 2_000);
    })]);
    clearTimeout(deadline);
    if (outcome !== 'cancelled')
    {
        server.closeAllConnections();
        await rejected.catch(() => undefined);
    }
    assert.equal(outcome, 'cancelled');
    assert.equal(calls, 1);
    await closed;
});
