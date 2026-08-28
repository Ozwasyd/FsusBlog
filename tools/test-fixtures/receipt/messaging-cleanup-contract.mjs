import {
    assertDigest,
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

function compareDecimalStrings(left, right)
{
    const leftId = BigInt(left);
    const rightId = BigInt(right);
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

function canonicalIds(items, label)
{
    if (!Array.isArray(items) || items.some((item) => !/^[1-9][0-9]*$/u.test(String(item))))
    {
        throw new Error(`messaging cleanup ${label} must be canonical decimal strings`);
    }
    const normalized = items.map(String).sort(compareDecimalStrings);
    if (new Set(normalized).size !== normalized.length)
    {
        throw new Error(`messaging cleanup ${label} must be unique`);
    }
    return Object.freeze(normalized);
}

function normalizeMessagingCleanupReceipt(receipt)
{
    const allowedKeys = new Set([
        'schema',
        'planDigest',
        'runId',
        'namespace',
        'ownedEntityIds',
        'conversationIds',
        'messageIds',
        'eventIds',
        'deliveryKeys'
    ]);
    if (!plainObject(receipt)
        || Object.keys(receipt).some((key) => !allowedKeys.has(key))
        || receipt.schema !== 'fsusblog.messaging-fixture-cleanup.v1')
    {
        throw new Error('messaging cleanup contract requires its exact typed receipt');
    }
    const conversationIds = canonicalIds(receipt.conversationIds, 'conversationIds');
    const messageIds = canonicalIds(receipt.messageIds, 'messageIds');
    const eventIds = canonicalIds(receipt.eventIds, 'eventIds');
    const ownedEntityIds = canonicalIds(receipt.ownedEntityIds, 'ownedEntityIds');
    if (JSON.stringify(ownedEntityIds) !== JSON.stringify(
        [...conversationIds, ...messageIds].sort(compareDecimalStrings)))
    {
        throw new Error('messaging cleanup ownedEntityIds do not bind conversations and messages');
    }
    if (!Array.isArray(receipt.deliveryKeys)
        || receipt.deliveryKeys.some((item) => typeof item !== 'string' || !item.trim())
        || new Set(receipt.deliveryKeys).size !== receipt.deliveryKeys.length)
    {
        throw new Error('messaging cleanup deliveryKeys must be unique non-empty strings');
    }
    const result = {
        schema: receipt.schema,
        planDigest: assertDigest(receipt.planDigest, 'messaging cleanup planDigest'),
        runId: requireText(String(receipt.runId ?? ''), 'messaging cleanup runId'),
        namespace: requireText(String(receipt.namespace ?? ''), 'messaging cleanup namespace'),
        ownedEntityIds,
        conversationIds,
        messageIds,
        eventIds,
        deliveryKeys: Object.freeze([...receipt.deliveryKeys].sort())
    };
    assertNoSecrets(result);
    return freezeDeep(result);
}

export function normalizeCleanupContract(value)
{
    if (value == null)
    {
        return Object.freeze({ kind: 'owned-namespace' });
    }
    if (!plainObject(value))
    {
        throw new Error('cleanupContract must be an object');
    }
    const kind = requireText(String(value.kind ?? 'owned-namespace'), 'cleanupContract.kind');
    return freezeDeep({
        kind,
        notes: value.notes == null ? null : String(value.notes),
        ...(kind === 'messaging-exact-receipt'
            ? { receipt: normalizeMessagingCleanupReceipt(value.receipt) }
            : {})
    });
}
