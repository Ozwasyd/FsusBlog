/* eslint-disable import-x/no-relative-parent-imports -- Repository contract tests and tool authorities intentionally compose sibling owner modules. */
import { createHash } from 'node:crypto';

import { normalizeSemantic, requireDigest, requireSafeId, requireText } from '../../test-runtime/contract.mjs';
import { digestCanonical, freezeDeep, plainObject } from '../receipt/canonical.mjs';

export const zeroObserverSideEffects = Object.freeze({
    writes: 0,
    networkMutations: 0,
    tokenRefreshes: 0,
    repairs: 0,
    lifecycleTransitions: 0
});

export function assertOwnedHandle(handle, identity, domain, label = 'observer handle')
{
    if (!plainObject(handle) || !plainObject(handle.owner))
    {
        throw new Error(`${label} is missing sealed ownership`);
    }
    const owner = handle.owner;
    if (owner.runId !== identity.runId || owner.attemptId !== identity.attemptId
    || owner.sessionId !== identity.sessionId || owner.domain !== domain)
    {
        throw new Error(`${label} is shared, stale or cross-session`);
    }
    if (handle.catalogDigest !== identity.catalogDigest)
    {
        throw new Error(`${label} catalog digest drifted`);
    }
    return handle;
}

export function assertReadonlyPort(port, operations, label)
{
    if (!plainObject(port) || port.readonly !== true)
    {
        throw new Error(`${label} must be an injected readonly port`);
    }
    for (const operation of operations)
    {
        if (typeof port[operation] !== 'function')
        {
            throw new Error(`${label} requires ${operation}()`);
        }
    }
    return port;
}

export async function readObserverSideEffects(port)
{
    if (typeof port.readSideEffectCounters !== 'function')
    {
        throw new Error('observer port cannot prove zero side effects');
    }
    const counters = await port.readSideEffectCounters();
    if (!plainObject(counters))
    {
        throw new Error('observer side-effect counters are unavailable');
    }
    const normalized = {};
    for (const field of Object.keys(zeroObserverSideEffects))
    {
        const value = Number(counters[field]);
        if (!Number.isInteger(value) || value < 0)
        {
            throw new Error(`observer side-effect counter ${field} is invalid`);
        }
        normalized[field] = value;
    }
    return freezeDeep(normalized);
}

export function sideEffectDelta(before, after)
{
    const delta = {};
    for (const field of Object.keys(zeroObserverSideEffects))
    {
        delta[field] = after[field] - before[field];
        if (delta[field] !== 0)
        {
            throw new Error(`observer caused side effect ${field}`);
        }
    }
    return freezeDeep(delta);
}

export function stableRecords(records, identityFields, label)
{
    const normalized = records.map((record, index) => normalizeSemantic(record, `${label}[${index}]`));
    normalized.sort((left, right) =>
    {
        const leftKey = identityFields.map((field) => JSON.stringify(left[field])).join('\0');
        const rightKey = identityFields.map((field) => JSON.stringify(right[field])).join('\0');
        return leftKey.localeCompare(rightKey) || digestCanonical(left).localeCompare(digestCanonical(right));
    });
    const identities = normalized.map((record) => identityFields.map((field) => JSON.stringify(record[field])).join('\0'));
    if (new Set(identities).size !== identities.length)
    {
        throw new Error(`${label} contains duplicate semantic identities`);
    }
    return Object.freeze(normalized);
}

export async function digestReadable(readable)
{
    const hash = createHash('sha256');
    let length = 0;
    for await (const chunk of readable)
    {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += bytes.length;
        hash.update(bytes);
    }
    return { length, contentDigest: `sha256:${hash.digest('hex')}` };
}

export function normalizedObserverResult(semantic, metadata, sideEffects)
{
    return freezeDeep({ status: 'observed', semantic: normalizeSemantic(semantic), metadata: freezeDeep(metadata ?? {}), sideEffects });
}

/**
 * A required domain may be genuinely absent at a pre-mutation boundary.  The
 * absence is still an observation: it must come from the current-session
 * producer authority and a readonly port, never from a missing file catch or
 * an empty-object fallback inside a domain observer.
 */
export async function observeDeclaredAbsence({ domain, identity, context, kind, handle: suppliedHandle = null })
{
    const handle = suppliedHandle ?? context?.handles?.[domain];
    if (handle?.observationStatus !== 'absent')
    {
        return null;
    }
    assertOwnedHandle(handle, identity, domain, `${kind} absence handle`);
    const port = assertReadonlyPort(context?.ports?.absence, [
        'readDeclaredAbsence', 'readSideEffectCounters'
    ], 'declared-absence observer port');
    const before = await readObserverSideEffects(port);
    const authority = await port.readDeclaredAbsence({ handle, domain });
    if (!plainObject(authority) || authority.status !== 'absent'
    || authority.domain !== domain || authority.namespace !== handle.namespace
    || authority.authorityDigest !== handle.absenceAuthorityDigest)
    {
        throw new Error(`${domain} absence authority is stale, shared or unverified`);
    }
    const after = await readObserverSideEffects(port);
    return normalizedObserverResult({
        kind,
        observationStatus: 'absent',
        namespace: handle.namespace,
        reasonCode: requireSafeId(authority.reasonCode, `${domain} absence reasonCode`),
        authorityDigest: requireDigest(authority.authorityDigest, `${domain} absence authorityDigest`)
    }, {
        producerRef: requireText(authority.producerRef, `${domain} absence producerRef`)
    }, sideEffectDelta(before, after));
}

export function requireObserverHandle(context, domain)
{
    const handle = context?.handles?.[domain];
    return assertOwnedHandle(handle, context.identity, domain);
}

export function requireClock(context)
{
    const fixedEpochMs = Number(context?.fixedClock?.epochMs);
    const digest = requireDigest(context?.fixedClock?.digest, 'fixed clock digest');
    if (!Number.isSafeInteger(fixedEpochMs))
    {
        throw new Error('fixed clock epoch is required');
    }
    if (digest !== context.identity.clockDigest)
    {
        throw new Error('fixed clock identity drifted');
    }
    return { epochMs: fixedEpochMs, digest };
}

export function normalizeOwnerIdentity(owner)
{
    return freezeDeep({
        runId: requireSafeId(owner.runId, 'owner.runId'),
        attemptId: requireSafeId(owner.attemptId, 'owner.attemptId'),
        sessionId: requireSafeId(owner.sessionId, 'owner.sessionId'),
        domain: requireText(owner.domain, 'owner.domain')
    });
}
