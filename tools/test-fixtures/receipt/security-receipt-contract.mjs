import {
    assertDigest,
    digestCanonical,
    freezeDeep,
    plainObject
} from './canonical.mjs';
import { assertNoSecrets } from './secrets.mjs';

function requireText(value, label)
{
    if (typeof value !== 'string' || !value.trim())
    {
        throw new Error(`${label} is required`);
    }
    return value.trim();
}

function sortedStrings(values, label)
{
    if (!Array.isArray(values))
    {
        throw new Error(`${label} must be an array`);
    }
    const normalized = values.map((value) => requireText(String(value), label));
    const expected = [...new Set(normalized)].sort();
    if (JSON.stringify(normalized) !== JSON.stringify(expected))
    {
        throw new Error(`${label} must be sorted and unique`);
    }
    return Object.freeze(normalized);
}

export function normalizeCleanupContract(value)
{
    if (value == null)
    {
        return Object.freeze({ kind: 'owned-namespace', notes: null });
    }
    if (!plainObject(value))
    {
        throw new Error('cleanupContract must be an object');
    }
    const kind = requireText(String(value.kind ?? 'owned-namespace'), 'cleanupContract.kind');
    if (kind !== 'receipt-owned-exact')
    {
        return freezeDeep({
            kind,
            notes: value.notes == null ? null : String(value.notes)
        });
    }
    const normalized = {
        kind,
        notes: value.notes == null ? null : String(value.notes),
        operationPlanDigest: value.operationPlanDigest == null
            ? null
            : assertDigest(value.operationPlanDigest, 'cleanupContract.operationPlanDigest'),
        ownedEntityDigests: sortedStrings(value.ownedEntityDigests ?? [], 'cleanupContract.ownedEntityDigests'),
        ownedRedisKeyDigests: sortedStrings(value.ownedRedisKeyDigests ?? [], 'cleanupContract.ownedRedisKeyDigests'),
        recoveryReceiptDigests: sortedStrings(value.recoveryReceiptDigests ?? [], 'cleanupContract.recoveryReceiptDigests')
    };
    for (const [field, values] of Object.entries({
        ownedEntityDigests: normalized.ownedEntityDigests,
        ownedRedisKeyDigests: normalized.ownedRedisKeyDigests,
        recoveryReceiptDigests: normalized.recoveryReceiptDigests
    }))
    {
        for (const digest of values)
        {
            assertDigest(digest, `cleanupContract.${field}`);
        }
    }
    if (!normalized.operationPlanDigest
      || normalized.ownedEntityDigests.length === 0
      || normalized.recoveryReceiptDigests.length === 0)
    {
        throw new Error('receipt-owned-exact cleanup requires plan, entity, and recovery receipt digests');
    }
    return freezeDeep(normalized);
}

export function normalizeDomainObservations(values, producerId)
{
    if (values == null)
    {
        return Object.freeze([]);
    }
    if (!Array.isArray(values))
    {
        throw new Error('domainObservations must be an array');
    }
    const normalized = values.map((value, index) =>
    {
        if (!plainObject(value) || !plainObject(value.document))
        {
            throw new Error(`domainObservations[${index}] must wrap a document`);
        }
        const schema = requireText(value.schema ?? value.document.schema, `domainObservations[${index}].schema`);
        const ownerProducerId = requireText(value.ownerProducerId, `domainObservations[${index}].ownerProducerId`);
        if (ownerProducerId !== producerId || value.document.schema !== schema)
        {
            throw new Error(`domainObservations[${index}] owner/schema mismatch`);
        }
        const contentDigest = assertDigest(
            value.contentDigest ?? value.document.contentDigest,
            `domainObservations[${index}].contentDigest`
        );
        const body = { ...value.document };
        delete body.contentDigest;
        if (digestCanonical(body) !== contentDigest)
        {
            throw new Error(`domainObservations[${index}] content digest mismatch`);
        }
        assertNoSecrets(value.document);
        return freezeDeep({ schema, ownerProducerId, contentDigest, document: value.document });
    });
    normalized.sort((left, right) => `${left.schema}:${left.contentDigest}`
        .localeCompare(`${right.schema}:${right.contentDigest}`));
    if (new Set(normalized.map((item) => `${item.schema}:${item.contentDigest}`)).size !== normalized.length)
    {
        throw new Error('domainObservations must be unique');
    }
    return Object.freeze(normalized);
}

export function validateSecurityReceiptExtensions(document)
{
    const canonicalCleanupContract = normalizeCleanupContract(document.cleanupContract);
    if (JSON.stringify(canonicalCleanupContract) !== JSON.stringify(document.cleanupContract))
    {
        throw new Error('ProducerReceipt cleanupContract is not canonical');
    }
    const canonicalDomainObservations = normalizeDomainObservations(
        document.domainObservations ?? [],
        document.producerId
    );
    if (JSON.stringify(canonicalDomainObservations) !== JSON.stringify(document.domainObservations ?? []))
    {
        throw new Error('ProducerReceipt domainObservations are not canonical');
    }
}
