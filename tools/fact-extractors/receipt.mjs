import { readFileSync } from 'node:fs';
import path from 'node:path';

import { digestValue, isPlainObject, stable } from './lib/canonicalize.mjs';
import { loadReceiptSchema, receiptSchemaId, root } from './registry.mjs';

export const forbiddenReceiptFields = Object.freeze([
    'observedAt',
    'timestamp',
    'warning',
    'warnings',
    'partial',
    'expected',
    'baseline',
    'approved',
    'lastVerifiedCommit',
    'shellCommand',
    'rawSource',
    'markdown',
    'statusOkWithWarnings'
]);

const digestPattern = /^[a-f0-9]{64}$/u;
const commitPattern = /^[a-f0-9]{40}$/u;
const idPattern = /^[a-z][a-z0-9-]*$/u;

const fail = (message) =>
{
    throw new Error(`[fact-observation-receipt] ${message}`);
};

export function validateReceiptSchemaContract(schema = loadReceiptSchema())
{
    if (schema?.$id !== receiptSchemaId || schema?.additionalProperties !== false)
    {
        fail('receipt schema identity or fail-closed root shape drifted');
    }
    const forbidden = schema?.$defs?.forbiddenReceiptFields?.enum ?? [];
    for (const field of ['observedAt', 'timestamp', 'warning', 'partial', 'expected', 'baseline'])
    {
        if (!forbidden.includes(field))
        {
            fail(`receipt schema must forbid ${field}`);
        }
    }
    if (schema.properties?.status?.enum?.includes('warning'))
    {
        fail('status must not admit warning');
    }
    if (schema.properties?.status?.enum?.includes('partial'))
    {
        fail('status must not admit partial');
    }
    return true;
}

function assertNoForbiddenKeys(value, label)
{
    if (Array.isArray(value))
    {
        value.forEach((entry, index) => assertNoForbiddenKeys(entry, `${label}[${index}]`));
        return;
    }
    if (!isPlainObject(value))
    {
        return;
    }
    for (const [key, nested] of Object.entries(value))
    {
        if (forbiddenReceiptFields.includes(key))
        {
            fail(`${label} contains forbidden field ${key}`);
        }
        if (key === 'unknown' || key === 'unknownField')
        {
            fail(`${label} contains unknown field marker ${key}`);
        }
        assertNoForbiddenKeys(nested, `${label}.${key}`);
    }
}

/**
 * Observations may only be scalar, boolean, set (array), map, transition graph, or failure-mode ids.
 * Reject free-form source dumps and non-deterministic timestamps.
 */
export function validateObservationValue(value, label = 'observations')
{
    if (value === null || value === undefined)
    {
        fail(`${label} must not be null/undefined`);
    }
    if (typeof value === 'string')
    {
        if (value.length === 0)
        {
            fail(`${label} string scalar must be non-empty`);
        }
        if (value.length > 4096)
        {
            fail(`${label} string scalar exceeds bound`);
        }
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/u.test(value))
        {
            fail(`${label} must not embed timestamps`);
        }
        return;
    }
    if (typeof value === 'number')
    {
        if (!Number.isFinite(value))
        {
            fail(`${label} number must be finite`);
        }
        return;
    }
    if (typeof value === 'boolean')
    {
        return;
    }
    if (Array.isArray(value))
    {
        if (value.length === 0)
        {
            fail(`${label} set/list must be non-empty when present as observation value`);
        }
        for (let index = 0; index < value.length; index += 1)
        {
            const entry = value[index];
            if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean')
            {
                if (typeof entry === 'string' && entry.length === 0)
                {
                    fail(`${label}[${index}] empty string`);
                }
                if (typeof entry === 'number' && !Number.isFinite(entry))
                {
                    fail(`${label}[${index}] non-finite`);
                }
                continue;
            }
            fail(`${label}[${index}] set members must be scalar/boolean`);
        }
        return;
    }
    if (isPlainObject(value))
    {
        const keys = Object.keys(value);
        if (keys.length === 0)
        {
            fail(`${label} map must be non-empty`);
        }
        for (const key of keys)
        {
            if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/u.test(key))
            {
                fail(`${label} has unstable map key ${key}`);
            }
            validateObservationValue(value[key], `${label}.${key}`);
        }
        return;
    }
    fail(`${label} has unsupported observation type ${typeof value}`);
}

export function validateObservations(observations)
{
    if (!isPlainObject(observations))
    {
        fail('observations must be an object');
    }
    const keys = Object.keys(observations);
    if (keys.length === 0)
    {
        fail('observations must be non-empty');
    }
    assertNoForbiddenKeys(observations, 'observations');
    for (const key of keys)
    {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key))
        {
            fail(`observation key ${key} is invalid`);
        }
        if (key === 'warning' || key === 'partial' || key === 'unknown')
        {
            fail(`observation key ${key} is reserved/forbidden`);
        }
        validateObservationValue(observations[key], `observations.${key}`);
    }
    return true;
}

export function computeSemanticDigest({ extractorId, behaviorIds, observations, status })
{
    return digestValue({
        extractorId,
        behaviorIds: [...behaviorIds].sort(),
        observations: stable(observations),
        status
    });
}

export function computeContentDigest(receipt)
{
    const clone = structuredClone(receipt);
    delete clone.contentDigest;
    return digestValue(clone);
}

export function sealReceipt(receipt)
{
    const sealed = { ...receipt, contentDigest: null };
    sealed.contentDigest = computeContentDigest(sealed);
    return sealed;
}

export function buildReceipt({
    extractorId,
    behaviorIds,
    sourceCommit,
    worktreeFingerprint,
    buildIdentity = null,
    extractorDigest,
    registryDigest,
    consumedInputDigests,
    observations,
    status,
    failureReasons = []
})
{
    if (!idPattern.test(extractorId))
    {
        fail(`invalid extractorId ${extractorId}`);
    }
    if (!Array.isArray(behaviorIds) || behaviorIds.length === 0 || new Set(behaviorIds).size !== behaviorIds.length)
    {
        fail('behaviorIds must be a unique non-empty list');
    }
    if (behaviorIds.some((id) => !idPattern.test(id)))
    {
        fail('behaviorIds contains invalid id');
    }
    if (!commitPattern.test(sourceCommit))
    {
        fail('sourceCommit must be full lowercase SHA');
    }
    if (!digestPattern.test(worktreeFingerprint))
    {
        fail('worktreeFingerprint must be sha256 hex');
    }
    if (!digestPattern.test(extractorDigest) || !digestPattern.test(registryDigest))
    {
        fail('extractor/registry digests invalid');
    }
    if (!Array.isArray(consumedInputDigests) || consumedInputDigests.length === 0)
    {
        fail('consumedInputDigests required');
    }
    for (const entry of consumedInputDigests)
    {
        if (!isPlainObject(entry) || typeof entry.path !== 'string' || !digestPattern.test(entry.digest))
        {
            fail('consumedInputDigests entries must be {path,digest}');
        }
    }
    if (!Array.isArray(failureReasons) || failureReasons.some((reason) => typeof reason !== 'string' || reason.length === 0))
    {
        fail('failureReasons must be a string list');
    }
    if (status !== 'ok' && status !== 'failed')
    {
        fail(`invalid status ${status}`);
    }

    if (status === 'ok')
    {
        if (failureReasons.length !== 0)
        {
            fail('status=ok cannot include failureReasons');
        }
        validateObservations(observations);
    }
    else
    {
        if (failureReasons.length === 0)
        {
            fail('status=failed requires failureReasons');
        }
        // Failed receipts may carry partial observations only when still typed; empty is allowed for hard failures.
        if (isPlainObject(observations) && Object.keys(observations).length > 0)
        {
            validateObservations(observations);
        }
        else if (!isPlainObject(observations))
        {
            fail('observations must be an object');
        }
    }

    assertNoForbiddenKeys({
        extractorId,
        behaviorIds,
        sourceCommit,
        worktreeFingerprint,
        buildIdentity,
        extractorDigest,
        registryDigest,
        consumedInputDigests,
        observations,
        status,
        failureReasons
    }, 'receipt');

    return sealReceipt({
        schema: receiptSchemaId,
        extractorId,
        behaviorIds: [...behaviorIds].sort(),
        sourceCommit,
        worktreeFingerprint,
        buildIdentity,
        extractorDigest,
        registryDigest,
        consumedInputDigests: [...consumedInputDigests].sort((left, right) => left.path.localeCompare(right.path)),
        observations: stable(observations),
        status,
        failureReasons: [...failureReasons].sort()
    });
}

export function validateReceipt(receipt, options = {})
{
    validateReceiptSchemaContract(options.schema ?? loadReceiptSchema(path.join(options.repositoryRoot ?? root, 'config/schemas/fact-observation-receipt.schema.json')));
    if (!isPlainObject(receipt))
    {
        fail('receipt must be an object');
    }
    assertNoForbiddenKeys(receipt, 'receipt');
    if (receipt.schema !== receiptSchemaId)
    {
        fail(`unexpected receipt schema ${receipt.schema}`);
    }
    const required = [
        'schema',
        'extractorId',
        'behaviorIds',
        'sourceCommit',
        'worktreeFingerprint',
        'buildIdentity',
        'extractorDigest',
        'registryDigest',
        'consumedInputDigests',
        'observations',
        'status',
        'failureReasons',
        'contentDigest'
    ];
    for (const key of required)
    {
        if (!Object.hasOwn(receipt, key))
        {
            fail(`receipt missing ${key}`);
        }
    }
    const extra = Object.keys(receipt).filter((key) => !required.includes(key));
    if (extra.length > 0)
    {
        fail(`receipt has unknown fields: ${extra.join(', ')}`);
    }

    if (receipt.status === 'ok')
    {
        if (!Array.isArray(receipt.failureReasons) || receipt.failureReasons.length !== 0)
        {
            fail('status=ok cannot carry failureReasons or warnings');
        }
        validateObservations(receipt.observations);
    }
    else if (receipt.status === 'failed')
    {
        if (!Array.isArray(receipt.failureReasons) || receipt.failureReasons.length === 0)
        {
            fail('status=failed requires failureReasons');
        }
        if (isPlainObject(receipt.observations) && Object.keys(receipt.observations).length > 0)
        {
            validateObservations(receipt.observations);
        }
    }
    else
    {
        fail(`invalid status ${receipt.status}`);
    }

    const expected = computeContentDigest(receipt);
    if (receipt.contentDigest !== expected)
    {
        fail('contentDigest mismatch');
    }

    if (options.expectedSourceCommit && receipt.sourceCommit !== options.expectedSourceCommit)
    {
        fail('receipt sourceCommit does not match current source');
    }
    if (options.expectedWorktreeFingerprint && receipt.worktreeFingerprint !== options.expectedWorktreeFingerprint)
    {
        fail('receipt worktreeFingerprint does not match current worktree (HEAD receipt reuse is rejected)');
    }
    if (options.expectedRegistryDigest && receipt.registryDigest !== options.expectedRegistryDigest)
    {
        fail('receipt registryDigest does not match current registry');
    }
    if (options.expectedInputDigests)
    {
        const actual = digestValue(receipt.consumedInputDigests);
        const expectedInputs = digestValue(options.expectedInputDigests);
        if (actual !== expectedInputs)
        {
            fail('receipt consumedInputDigests do not match current inputs; cache reuse rejected');
        }
    }
    return true;
}

export function loadReceiptFromFile(filePath)
{
    return JSON.parse(readFileSync(filePath, 'utf8'));
}

export function semanticDigestFromReceipt(receipt)
{
    return computeSemanticDigest({
        extractorId: receipt.extractorId,
        behaviorIds: receipt.behaviorIds,
        observations: receipt.observations,
        status: receipt.status
    });
}
