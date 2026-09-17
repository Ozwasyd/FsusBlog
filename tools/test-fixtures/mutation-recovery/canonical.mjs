import crypto from 'node:crypto';

export const digestPattern = /^sha256:[a-f0-9]{64}$/u;
export const stableIdPattern = /^[a-z][a-z0-9_./-]*$/u;

export function canonicalize(value)
{
    if (Array.isArray(value))
    {
        return value.map(canonicalize);
    }
    if (value && typeof value === 'object')
    {
        return Object.fromEntries(Object.keys(value).sort()
            .map((key) => [key, canonicalize(value[key])]));
    }
    return value;
}

export function canonicalJson(value)
{
    return JSON.stringify(canonicalize(value));
}

export function digest(value)
{
    const bytes = typeof value === 'string' || Buffer.isBuffer(value)
        ? value
        : canonicalJson(value);
    return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

export function seal(body, digestField = 'contentDigest')
{
    const copy = { ...body };
    delete copy[digestField];
    return Object.freeze({ ...copy, [digestField]: digest(copy) });
}

export function verifySeal(value, digestField = 'contentDigest', label = 'document')
{
    if (!value || typeof value !== 'object' || Array.isArray(value))
    {
        throw new Error(`${label} must be an object`);
    }
    const expected = seal(value, digestField)[digestField];
    if (value[digestField] !== expected)
    {
        throw new Error(`${label} digest mismatch`);
    }
    return value;
}

export function requireDigest(value, label)
{
    if (!digestPattern.test(String(value ?? '')))
    {
        throw new Error(`${label} must be a sha256 digest`);
    }
    return value;
}

export function requireStableId(value, label)
{
    if (!stableIdPattern.test(String(value ?? '')))
    {
        throw new Error(`${label} must be a stable identifier`);
    }
    return String(value);
}
