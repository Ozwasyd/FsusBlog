/** Canonical serialization and digests for fixture receipts (#1710). */

import { createHash } from 'node:crypto';

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function plainObject(value)
{
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Stable JSON: sorted object keys, array order preserved, no whitespace.
 * Matches tools/testing/fixture-catalog stableStringify so catalog digests align.
 */
/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
export function canonicalJson(value)
{
    if (value === null || typeof value !== 'object')
    {
        return JSON.stringify(value);
    }
    if (Array.isArray(value))
    {
        return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
    }
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

/**
 * @param {import('node:crypto').BinaryLike} text
 * @returns {string}
 */
export function sha256Text(text)
{
    return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

/**
 * @param {import('node:crypto').BinaryLike} bytes
 * @returns {string}
 */
export function sha256Bytes(bytes)
{
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function digestCanonical(value)
{
    return sha256Text(canonicalJson(value));
}

/** Body digest excludes the digest field itself. */
/**
 * @param {Record<string, unknown>} document
 * @param {string} [digestField]
 * @returns {string}
 */
export function digestReceiptBody(document, digestField = 'receiptDigest')
{
    if (!plainObject(document))
    {
        throw new Error('receipt body must be a plain object');
    }
    const { [digestField]: _ignored, ...body } = document;
    return digestCanonical(body);
}

/**
 * @param {unknown} value
 * @param {string} [label]
 * @returns {string}
 */
export function assertDigest(value, label = 'digest')
{
    if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value))
    {
        throw new Error(`${label} must be sha256:<64 hex>`);
    }
    return value;
}

/**
 * @template T
 * @param {T} value
 * @returns {Readonly<T>}
 */
export function freezeDeep(value)
{
    if (Array.isArray(value))
    {
        return Object.freeze(value.map((item) => freezeDeep(item)));
    }
    if (plainObject(value))
    {
        const next = {};
        for (const key of Object.keys(value).sort())
        {
            next[key] = freezeDeep(value[key]);
        }
        return Object.freeze(next);
    }
    return value;
}
