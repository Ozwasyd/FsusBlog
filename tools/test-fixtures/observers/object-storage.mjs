/* eslint-disable import-x/no-relative-parent-imports -- Repository contract tests and tool authorities intentionally compose sibling owner modules. */
import { normalizeSemantic, requireSafeId, requireText } from '../../test-runtime/contract.mjs';
import { digestCanonical, plainObject } from '../receipt/canonical.mjs';

import {
    assertOwnedHandle,
    assertReadonlyPort,
    digestReadable,
    normalizedObserverResult,
    observeDeclaredAbsence,
    readObserverSideEffects,
    sideEffectDelta,
    stableRecords
} from './common.mjs';

function normalizeKey(value)
{
    const key = requireText(value, 'object key').replaceAll('\\', '/');
    if (key.startsWith('/') || key.split('/').some((segment) => !segment || segment === '.' || segment === '..'))
    {
        throw new Error(`object key is not canonical: ${key}`);
    }
    return key;
}

export async function observeObjectStorage({ domain, identity, context, signal })
{
    if (domain !== 'storage.fixture-objects')
    {
        throw new Error(`object-storage observer cannot own ${domain}`);
    }
    const handle = assertOwnedHandle(context?.handles?.[domain], identity, domain, 'object storage namespace handle');
    const absent = await observeDeclaredAbsence({ domain, identity, context, kind: 'object-storage', handle });
    if (absent)
    {
        return absent;
    }
    const port = assertReadonlyPort(context?.ports?.objectStorage, ['listObjects', 'openRead', 'readSideEffectCounters'], 'object-storage observer port');
    if (handle.namespaceClass !== 'fixture-session' || handle.production === true || handle.shared === true)
    {
        throw new Error('object-storage observer refuses shared, production or user namespaces');
    }
    const expected = new Map((handle.expectedObjects ?? []).map((item) => [normalizeKey(item.key), item]));
    if (expected.size !== (handle.expectedObjects ?? []).length)
    {
        throw new Error('object-storage expected catalog has duplicate keys');
    }
    const before = await readObserverSideEffects(port);
    const records = [];
    let pageCount = 0;
    for await (const page of port.listObjects({ handle, pageSize: 256, signal }))
    {
        pageCount += 1;
        if (!plainObject(page) || page.complete !== true || !Array.isArray(page.objects))
        {
            throw new Error('object-storage provider returned partial pagination');
        }
        for (const item of page.objects)
        {
            const key = normalizeKey(item.key);
            const expectedItem = expected.get(key);
            if (!expectedItem)
            {
                throw new Error(`object-storage unexpected object ${key}`);
            }
            const state = requireSafeId(item.state, `${key} state`);
            if (!['active', 'tombstone', 'absent'].includes(state))
            {
                throw new Error(`object-storage unknown state ${state}`);
            }
            let content = { length: 0, contentDigest: null };
            if (state === 'active')
            {
                const readable = await port.openRead({ handle, key, generation: item.generation, signal });
                if (!readable?.[Symbol.asyncIterator])
                {
                    throw new Error(`object-storage ${key} has no streaming reader`);
                }
                content = await digestReadable(readable);
            }
            if (expectedItem.required === true && state !== 'active')
            {
                throw new Error(`object-storage required object is missing: ${key}`);
            }
            if (item.length != null && Number(item.length) !== content.length)
            {
                throw new Error(`object-storage length mismatch: ${key}`);
            }
            if (item.contentDigest != null && item.contentDigest !== content.contentDigest)
            {
                throw new Error(`object-storage content digest mismatch: ${key}`);
            }
            records.push({
                namespaceId: requireSafeId(handle.namespaceId, 'object namespaceId'),
                key,
                state,
                mediaType: state === 'active' ? requireText(item.mediaType, `${key} mediaType`).toLowerCase() : null,
                length: content.length,
                contentDigest: content.contentDigest,
                generation: item.generation == null ? null : requireText(item.generation, `${key} generation`),
                version: item.version == null ? null : requireText(item.version, `${key} version`),
                metadataDigest: item.metadata == null
                    ? null
                    : digestCanonical(normalizeSemantic(item.metadata, `${key} metadata`)),
                observationStatus: 'observed'
            });
        }
    }
    const observedKeys = records.map((record) => record.key);
    if (new Set(observedKeys).size !== observedKeys.length)
    {
        throw new Error('object-storage duplicate key/generation observation');
    }
    const missing = [...expected.keys()].filter((key) => !observedKeys.includes(key));
    if (missing.length > 0)
    {
        throw new Error(`object-storage provider omitted expected objects: ${missing.join(', ')}`);
    }
    const after = await readObserverSideEffects(port);
    return normalizedObserverResult({
        kind: 'object-storage',
        providerId: requireSafeId(handle.providerId, 'object storage providerId'),
        namespaceId: requireSafeId(handle.namespaceId, 'object namespaceId'),
        objects: stableRecords(records, ['namespaceId', 'key', 'generation'], 'object-storage records')
    }, {
        pageCount,
        objectCount: records.length,
        providerEndpointClass: handle.providerEndpointClass ?? 'session-local'
    }, sideEffectDelta(before, after));
}

export function createObjectStorageObserver()
{
    return Object.freeze({ observerId: 'object-storage', version: 'v1', observe: observeObjectStorage });
}
