/* eslint-disable import-x/no-relative-parent-imports -- Repository contract tests and tool authorities intentionally compose sibling owner modules. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { observeAuthState } from '../../tools/test-fixtures/observers/auth-state.mjs';
import { digestCanonical } from '../../tools/test-fixtures/receipt/canonical.mjs';

import { noSideEffects, runtimeIdentity } from './support/runtime-state-fixture.mjs';

const identity = runtimeIdentity();
const domain = 'fixture.auth-identities';
const handle = {
    owner: { runId: identity.runId, attemptId: identity.attemptId, sessionId: identity.sessionId, domain },
    catalogDigest: identity.catalogDigest,
    namespace: 'session-auth',
    userId: 'user-a',
    siteId: 'site-a',
    authSessionId: 'auth-session-a',
    declaredClaims: ['aud', 'sub'],
    declaredLocalStorageKeys: ['locale'],
    declaredSessionStorageKeys: [],
    declaredIndexedDbStores: []
};

function state(overrides = {})
{
    return {
        readonly: true,
        clockDigest: identity.clockDigest,
        namespace: handle.namespace,
        userId: handle.userId,
        siteId: handle.siteId,
        sessionId: handle.authSessionId,
        deviceId: 'device-a',
        tokenClass: 'access-token',
        claims: { aud: 'site-a', sub: 'user-a' },
        issuedAtEpochMs: 900,
        expiresAtEpochMs: 1900,
        serverGeneration: 'generation-1',
        token: 'secret-token-value',
        roles: ['admin'],
        permissions: ['article.read'],
        cookies: [{ name: '__Host-session', domain: 'localhost', path: '/', sameSite: 'Strict', secure: true, httpOnly: true, expiresAtEpochMs: 1900, value: 'cookie-secret' }],
        localStorage: { locale: { type: 'string', present: true, schema: 'locale-v1', generation: '1', value: 'zh-TW' } },
        sessionStorage: {},
        indexedDb: {},
        providerId: 'readonly-auth',
        providerVersion: 'v1',
        ...overrides
    };
}

function context(document, counters = noSideEffects())
{
    return {
        handles: { [domain]: handle },
        ports: {
            authState: {
                readonly: true,
                async readAuthState()
                {
                    return document;
                },
                async readSideEffectCounters()
                {
                    return counters;
                }
            }
        },
        fixedClock: { epochMs: 1000, digest: identity.clockDigest },
        protectedFingerprintKey: Buffer.alloc(32, 7),
        fingerprintScopeId: 'run-auth-fingerprint',
        fingerprintScope: 'run'
    };
}

test('auth observer canonicalizes claims/expiry and never emits secret plaintext or key', async () =>
{
    const first = await observeAuthState({ domain, identity, context: context(state()) });
    const reordered = await observeAuthState({ domain, identity, context: context(state({ claims: { sub: 'user-a', aud: 'site-a' } })) });
    assert.equal(digestCanonical(first.semantic), digestCanonical(reordered.semantic));
    const serialized = JSON.stringify(first);
    assert.equal(serialized.includes('secret-token-value'), false);
    assert.equal(serialized.includes('cookie-secret'), false);
    assert.equal(serialized.includes(Buffer.alloc(32, 7).toString('hex')), false);
    assert.equal(first.semantic.session.temporalStatus, 'active');
    const rotated = await observeAuthState({ domain, identity, context: context(state({ token: 'rotated-token' })) });
    assert.notEqual(rotated.semantic.session.token.fingerprint, first.semantic.session.token.fingerprint);
});

test('auth observer rejects cross-session, unknown claims and refresh side effects', async () =>
{
    await assert.rejects(observeAuthState({ domain, identity: runtimeIdentity({ sessionId: 'other' }), context: context(state()) }), /cross-session/);
    await assert.rejects(observeAuthState({ domain, identity, context: context(state({ claims: { aud: 'site-a', sub: 'user-a', extra: true } })) }), /missing, extra or unknown/);
    let calls = 0;
    const sideEffectContext = context(state());
    sideEffectContext.ports.authState.readSideEffectCounters = async () => ({ ...noSideEffects(), tokenRefreshes: calls++ });
    await assert.rejects(observeAuthState({ domain, identity, context: sideEffectContext }), /side effect tokenRefreshes/);
});
