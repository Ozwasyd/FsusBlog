/* eslint-disable import-x/no-relative-parent-imports -- Repository contract tests and tool authorities intentionally compose sibling owner modules. */
import {
    createProtectedFingerprint,
    normalizeSemantic,
    requireDigest,
    requireSafeId,
    requireText
} from '../../test-runtime/contract.mjs';
import { digestCanonical, freezeDeep, plainObject } from '../receipt/canonical.mjs';

import {
    assertOwnedHandle,
    assertReadonlyPort,
    normalizedObserverResult,
    observeDeclaredAbsence,
    readObserverSideEffects,
    requireClock,
    sideEffectDelta,
    stableRecords
} from './common.mjs';

function exactDeclaredKeys(actual, declared, label)
{
    const keys = Object.keys(actual ?? {}).sort();
    const expected = [...(declared ?? [])].sort();
    if (JSON.stringify(keys) !== JSON.stringify(expected))
    {
        throw new Error(`${label} is missing, extra or unknown`);
    }
}

function protectedValue(value, secretClass, context)
{
    if (value == null)
    {
        return freezeDeep({ secretClass, present: false, lengthClass: 'empty', fingerprint: null });
    }
    return createProtectedFingerprint({
        key: context.protectedFingerprintKey,
        scopeId: context.fingerprintScopeId,
        secretClass,
        value
    });
}

function secretClassId(prefix, value)
{
    const suffix = String(value).replace(/[^A-Za-z0-9_.-]+/gu, '-').replace(/^[^A-Za-z0-9]+/u, '');
    return requireSafeId(`${prefix}-${suffix || 'value'}`, 'secret class');
}

function normalizeCookie(cookie, context, clock)
{
    if (!plainObject(cookie))
    {
        throw new Error('auth observer received a malformed cookie');
    }
    const expiresAtEpochMs = cookie.expiresAtEpochMs == null ? null : Number(cookie.expiresAtEpochMs);
    if (expiresAtEpochMs != null && !Number.isSafeInteger(expiresAtEpochMs))
    {
        throw new Error('cookie expiry is invalid');
    }
    return freezeDeep({
        name: requireText(cookie.name, 'cookie name'),
        domain: requireText(cookie.domain, 'cookie domain'),
        path: requireText(cookie.path, 'cookie path'),
        sameSite: requireText(cookie.sameSite, 'cookie SameSite'),
        secure: cookie.secure === true,
        httpOnly: cookie.httpOnly === true,
        expiryOffsetMs: expiresAtEpochMs == null ? null : expiresAtEpochMs - clock.epochMs,
        value: protectedValue(cookie.value, secretClassId('cookie', cookie.name), context)
    });
}

function normalizeStorageEntries(storage, declared, context, label)
{
    exactDeclaredKeys(storage, declared, label);
    return stableRecords(Object.entries(storage ?? {}).map(([key, entry]) =>
    {
        if (!plainObject(entry))
        {
            throw new Error(`${label}.${key} is malformed`);
        }
        return {
            key,
            type: requireText(entry.type, `${label}.${key}.type`),
            present: entry.present === true,
            schema: requireText(entry.schema, `${label}.${key}.schema`),
            generation: entry.generation == null ? null : requireText(entry.generation, `${label}.${key}.generation`),
            value: entry.present === true ? protectedValue(entry.value, secretClassId(label, key), context) : null
        };
    }), ['key'], `${label} entries`);
}

export async function observeAuthState({ domain, identity, context, signal })
{
    if (!['fixture.auth-identities', 'browser.storage-state'].includes(domain))
    {
        throw new Error(`auth observer cannot own ${domain}`);
    }
    const handle = assertOwnedHandle(context?.handles?.[domain], identity, domain, 'auth session handle');
    const absent = await observeDeclaredAbsence({ domain, identity, context, kind: 'auth-state', handle });
    if (absent)
    {
        return absent;
    }
    const port = assertReadonlyPort(context?.ports?.authState, ['readAuthState', 'readSideEffectCounters'], 'auth-state observer port');
    const clock = requireClock({ ...context, identity });
    if (!(context.protectedFingerprintKey instanceof Uint8Array) || !context.fingerprintScopeId)
    {
        throw new Error('auth observer requires a protected run-scoped fingerprint key');
    }
    if (context.fingerprintScope === 'environment' && (!context.retentionBoundary || !context.correlationBoundary))
    {
        throw new Error('environment-scoped auth fingerprints require retention and correlation boundaries');
    }
    const before = await readObserverSideEffects(port);
    const state = await port.readAuthState({ handle, domain, signal });
    if (domain === 'fixture.auth-identities' && state?.stateClass === 'fixture-auth-catalog')
    {
        if (state.readonly !== true || state.clockDigest !== clock.digest || state.namespace !== handle.namespace)
        {
            throw new Error('fixture auth catalog identity/clock is stale, shared or unobservable');
        }
        const identities = stableRecords((state.identities ?? []).map((entry) => ({
            kind: requireSafeId(entry.kind, 'fixture auth identity kind'),
            id: requireSafeId(entry.id, 'fixture auth identity id'),
            domain: requireText(entry.domain, 'fixture auth identity domain'),
            fieldsDigest: requireDigest(entry.fieldsDigest, 'fixture auth fields digest')
        })), ['kind', 'id'], 'fixture auth identities');
        if (digestCanonical(identities) !== handle.expectedIdentityDigest)
        {
            throw new Error('fixture auth catalog planned/actual identity drifted');
        }
        const after = await readObserverSideEffects(port);
        return normalizedObserverResult({
            kind: 'auth-state', stateClass: 'fixture-auth-catalog', namespace: handle.namespace,
            identities, fixtureReceiptDigest: requireDigest(state.fixtureReceiptDigest, 'fixture auth receipt digest')
        }, {
            providerId: requireText(state.providerId, 'auth providerId'),
            providerVersion: requireText(state.providerVersion, 'auth providerVersion'),
            clockDigest: requireDigest(state.clockDigest, 'auth clockDigest'),
            secretPlaintextOccurrences: 0,
            fingerprintKeyOccurrences: 0
        }, sideEffectDelta(before, after));
    }
    if (!plainObject(state) || state.readonly !== true || state.clockDigest !== clock.digest
    || state.namespace !== handle.namespace || state.userId !== handle.userId
    || state.siteId !== handle.siteId || state.sessionId !== handle.authSessionId)
    {
        throw new Error('auth state identity/clock is stale, shared or unobservable');
    }
    exactDeclaredKeys(state.claims, handle.declaredClaims, 'auth claims');
    const issuedAt = Number(state.issuedAtEpochMs);
    const expiresAt = Number(state.expiresAtEpochMs);
    if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt) || expiresAt < issuedAt)
    {
        throw new Error('auth temporal claims are invalid');
    }
    const cookies = stableRecords((state.cookies ?? []).map((cookie) => normalizeCookie(cookie, context, clock)), ['name', 'domain', 'path'], 'auth cookies');
    const after = await readObserverSideEffects(port);
    return normalizedObserverResult({
        kind: 'auth-state',
        principal: {
            userId: requireSafeId(state.userId, 'auth userId'),
            siteId: requireSafeId(state.siteId, 'auth siteId'),
            roles: [...new Set(state.roles ?? [])].sort(),
            permissions: [...new Set(state.permissions ?? [])].sort()
        },
        session: {
            sessionId: requireSafeId(state.sessionId, 'auth sessionId'),
            deviceId: requireSafeId(state.deviceId, 'auth deviceId'),
            tokenClass: requireSafeId(state.tokenClass, 'auth tokenClass'),
            claims: normalizeSemantic(state.claims, 'auth claims'),
            issuedOffsetMs: issuedAt - clock.epochMs,
            expiryOffsetMs: expiresAt - clock.epochMs,
            temporalStatus: clock.epochMs < issuedAt ? 'not-yet-valid' : clock.epochMs >= expiresAt ? 'expired' : 'active',
            serverGeneration: requireText(state.serverGeneration, 'auth server generation'),
            token: protectedValue(state.token, 'session-token', context)
        },
        cookies,
        localStorage: normalizeStorageEntries(state.localStorage, handle.declaredLocalStorageKeys, context, 'local-storage'),
        sessionStorage: normalizeStorageEntries(state.sessionStorage, handle.declaredSessionStorageKeys, context, 'session-storage'),
        indexedDb: normalizeStorageEntries(state.indexedDb, handle.declaredIndexedDbStores, context, 'indexed-db'),
        fingerprintScope: {
            kind: context.fingerprintScope ?? 'run',
            id: requireSafeId(context.fingerprintScopeId, 'fingerprint scope id'),
            retentionBoundary: context.retentionBoundary ?? null,
            correlationBoundary: context.correlationBoundary ?? null
        }
    }, {
        providerId: requireText(state.providerId, 'auth providerId'),
        providerVersion: requireText(state.providerVersion, 'auth providerVersion'),
        clockDigest: requireDigest(state.clockDigest, 'auth clockDigest'),
        secretPlaintextOccurrences: 0,
        fingerprintKeyOccurrences: 0
    }, sideEffectDelta(before, after));
}

export function createAuthStateObserver()
{
    return Object.freeze({ observerId: 'auth-state', version: 'v1', observe: observeAuthState });
}
