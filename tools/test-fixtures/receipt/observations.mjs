/**
 * Database / Redis / cache observation digests for FixtureReceipt (#1710).
 *
 * Observations cover only producer-owned namespace/entities/keys, use stable
 * sorting + canonical serialization, bind schema/catalog/service generation,
 * contain no secrets, recompute cheaply, and are sensitive to field drift
 * (not mtime).
 */

import { assertDigest, digestCanonical, freezeDeep, plainObject } from './canonical.mjs';
import { assertNoSecrets } from './secrets.mjs';

function sortedFreezeList(values, label)
{
    if (!Array.isArray(values))
    {
        throw new Error(`${label} must be an array`);
    }
    const list = values.map((item) =>
    {
        if (!plainObject(item))
        {
            throw new Error(`${label} entries must be objects`);
        }
        return freezeDeep(item);
    });
    return Object.freeze(
        [...list].sort((left, right) => digestCanonical(left).localeCompare(digestCanonical(right)))
    );
}

function requireText(value, label)
{
    if (typeof value !== 'string' || !value.trim())
    {
        throw new Error(`${label} is required`);
    }
    return value.trim();
}

/**
 * Normalize a database observation document.
 * entities: [{ domain, kind, id, fields: { status, deleted, currentPublicationId, ... } }]
 */
export function normalizeDatabaseObservation({
    namespace = null,
    schemaIdentity = 'public',
    catalogDigest = null,
    serviceGeneration = null,
    entities = []
} = {})
{
    const document = {
        kind: 'database',
        namespace: namespace == null ? null : requireText(String(namespace), 'namespace'),
        schemaIdentity: requireText(String(schemaIdentity), 'schemaIdentity'),
        catalogDigest: catalogDigest == null ? null : assertDigest(catalogDigest, 'catalogDigest'),
        serviceGeneration: serviceGeneration == null ? null : requireText(String(serviceGeneration), 'serviceGeneration'),
        entities: sortedFreezeList(entities, 'database entities')
    };
    assertNoSecrets(document);
    return freezeDeep(document);
}

/**
 * Redis observation: owned keys with field digests / presence flags only (no secret values).
 * keys: [{ domain, key, present, fieldDigest?, claimDigest? }]
 */
export function normalizeRedisObservation({
    namespace = null,
    redisNamespace = null,
    catalogDigest = null,
    serviceGeneration = null,
    keys = []
} = {})
{
    const document = {
        kind: 'redis',
        namespace: namespace == null ? null : requireText(String(namespace), 'namespace'),
        redisNamespace: redisNamespace == null ? null : requireText(String(redisNamespace), 'redisNamespace'),
        catalogDigest: catalogDigest == null ? null : assertDigest(catalogDigest, 'catalogDigest'),
        serviceGeneration: serviceGeneration == null ? null : requireText(String(serviceGeneration), 'serviceGeneration'),
        keys: sortedFreezeList(keys, 'redis keys')
    };
    assertNoSecrets(document);
    return freezeDeep(document);
}

/**
 * Cache / AOT generation observations.
 * entries: [{ domain, generation, visibleEntityIds?, endpoint?, matchesDb: boolean }]
 */
export function normalizeCacheObservation({
    namespace = null,
    catalogDigest = null,
    serviceGeneration = null,
    aotGeneration = null,
    entries = []
} = {})
{
    const document = {
        kind: 'cache',
        namespace: namespace == null ? null : requireText(String(namespace), 'namespace'),
        catalogDigest: catalogDigest == null ? null : assertDigest(catalogDigest, 'catalogDigest'),
        serviceGeneration: serviceGeneration == null ? null : requireText(String(serviceGeneration), 'serviceGeneration'),
        aotGeneration: aotGeneration == null ? null : requireText(String(aotGeneration), 'aotGeneration'),
        entries: sortedFreezeList(entries, 'cache entries')
    };
    assertNoSecrets(document);
    return freezeDeep(document);
}

export function digestDatabaseObservation(input)
{
    return digestCanonical(normalizeDatabaseObservation(input));
}

export function digestRedisObservation(input)
{
    return digestCanonical(normalizeRedisObservation(input));
}

export function digestCacheObservation(input)
{
    return digestCanonical(normalizeCacheObservation(input));
}

/** Empty / zero-mutation observation digests for the none profile. */
export function emptyDatabaseObservation({ namespace = null, catalogDigest = null, serviceGeneration = null } = {})
{
    return normalizeDatabaseObservation({
        namespace,
        schemaIdentity: 'public',
        catalogDigest,
        serviceGeneration,
        entities: []
    });
}

export function emptyRedisObservation({ namespace = null, catalogDigest = null, serviceGeneration = null } = {})
{
    return normalizeRedisObservation({
        namespace,
        redisNamespace: namespace == null ? null : `FsusBlog_${namespace}_`,
        catalogDigest,
        serviceGeneration,
        keys: []
    });
}

export function emptyCacheObservation({ namespace = null, catalogDigest = null, serviceGeneration = null } = {})
{
    return normalizeCacheObservation({
        namespace,
        catalogDigest,
        serviceGeneration,
        aotGeneration: null,
        entries: []
    });
}

/**
 * Merge producer-owned observations (disjoint entities/keys by construction).
 * Fail closed on identity mismatches.
 */
export function mergeDatabaseObservations(parts, identity)
{
    const entities = [];
    for (const part of parts ?? [])
    {
        if (!part)
        {
            continue;
        }
        const normalized = normalizeDatabaseObservation(part);
        if (identity.namespace != null && normalized.namespace != null && normalized.namespace !== identity.namespace)
        {
            throw new Error('database observation namespace mismatch across producers');
        }
        if (identity.catalogDigest != null && normalized.catalogDigest != null
      && normalized.catalogDigest !== identity.catalogDigest)
        {
            throw new Error('database observation catalogDigest mismatch across producers');
        }
        entities.push(...normalized.entities);
    }
    return normalizeDatabaseObservation({
        namespace: identity.namespace ?? null,
        schemaIdentity: identity.schemaIdentity ?? 'public',
        catalogDigest: identity.catalogDigest ?? null,
        serviceGeneration: identity.serviceGeneration ?? null,
        entities
    });
}

export function mergeRedisObservations(parts, identity)
{
    const keys = [];
    for (const part of parts ?? [])
    {
        if (!part)
        {
            continue;
        }
        const normalized = normalizeRedisObservation(part);
        if (identity.namespace != null && normalized.namespace != null && normalized.namespace !== identity.namespace)
        {
            throw new Error('redis observation namespace mismatch across producers');
        }
        keys.push(...normalized.keys);
    }
    return normalizeRedisObservation({
        namespace: identity.namespace ?? null,
        redisNamespace: identity.redisNamespace ?? (identity.namespace == null ? null : `FsusBlog_${identity.namespace}_`),
        catalogDigest: identity.catalogDigest ?? null,
        serviceGeneration: identity.serviceGeneration ?? null,
        keys
    });
}

export function mergeCacheObservations(parts, identity)
{
    const entries = [];
    let aotGeneration = identity.aotGeneration ?? null;
    for (const part of parts ?? [])
    {
        if (!part)
        {
            continue;
        }
        const normalized = normalizeCacheObservation(part);
        if (normalized.aotGeneration != null)
        {
            if (aotGeneration != null && aotGeneration !== normalized.aotGeneration)
            {
                throw new Error('cache aotGeneration mismatch across producers');
            }
            aotGeneration = normalized.aotGeneration;
        }
        entries.push(...normalized.entries);
    }
    return normalizeCacheObservation({
        namespace: identity.namespace ?? null,
        catalogDigest: identity.catalogDigest ?? null,
        serviceGeneration: identity.serviceGeneration ?? null,
        aotGeneration,
        entries
    });
}

/**
 * Recompute digests and ensure they match published values.
 */
export function reverifyObservationDigests({
    databaseObservation,
    redisObservation,
    cacheObservation,
    databaseObservationDigest,
    redisObservationDigest,
    cacheObservationDigest
})
{
    const db = digestCanonical(normalizeDatabaseObservation(databaseObservation));
    const redis = digestCanonical(normalizeRedisObservation(redisObservation));
    const cache = digestCanonical(normalizeCacheObservation(cacheObservation));
    if (databaseObservationDigest && databaseObservationDigest !== db)
    {
        throw new Error('database observation digest re-verification failed');
    }
    if (redisObservationDigest && redisObservationDigest !== redis)
    {
        throw new Error('redis observation digest re-verification failed');
    }
    if (cacheObservationDigest && cacheObservationDigest !== cache)
    {
        throw new Error('cache observation digest re-verification failed');
    }
    return { databaseObservationDigest: db, redisObservationDigest: redis, cacheObservationDigest: cache };
}
