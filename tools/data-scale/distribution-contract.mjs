const { assertDigest: assertFixtureDigest, digestCanonical, freezeDeep } = await import(
    new URL('../test-fixtures/receipt/canonical.mjs', import.meta.url)
);

/** Restrict inputs to lossless JSON before using the existing fixture digest authority. */
function assertJson(value, ancestors = new Set())
{
    if (value === null || typeof value === 'string' || typeof value === 'boolean')
    {
        return;
    }
    if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0))
    {
        return;
    }
    if (typeof value !== 'object' || ancestors.has(value))
    {
        throw new Error('distribution_noncanonical_json');
    }
    if (Object.getPrototypeOf(value) !== (Array.isArray(value) ? Array.prototype : Object.prototype))
    {
        throw new Error('distribution_nonplain_json');
    }
    if (Reflect.ownKeys(value).some((key) => typeof key === 'symbol'))
    {
        throw new Error('distribution_symbol_key');
    }
    ancestors.add(value);
    for (const key of Reflect.ownKeys(value))
    {
        if (Array.isArray(value) && key === 'length')
        {
            continue;
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (key === '__proto__' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value'))
        {
            throw new Error('distribution_unsupported_property');
        }
        assertJson(descriptor.value, ancestors);
    }
    if (Array.isArray(value) && (Object.keys(value).length !== value.length
        || Object.keys(value).some((key, index) => key !== String(index))))
    {
        throw new Error('distribution_sparse_array');
    }
    ancestors.delete(value);
}

/** Canonical identities reuse the fixture receipt serializer, preserving array order. */
export function canonicalDigest(value)
{
    assertJson(value);
    return digestCanonical(value);
}

/** Closed objects refuse unsupported inputs instead of silently omitting their identity. */
export function exactKeys(value, keys, label = 'distribution')
{
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.getPrototypeOf(value) !== Object.prototype)
    {
        throw new Error(`${label}_object_invalid`);
    }
    const actual = Reflect.ownKeys(value);
    if (actual.length !== keys.length || actual.some((key) => !keys.includes(key)))
    {
        throw new Error(`${label}_fields_invalid`);
    }
    assertJson(value);
    return value;
}

/** Validate the original fixture digest format; no alternate digest spelling is accepted. */
export function assertDigest(value, label = 'digest')
{
    return assertFixtureDigest(value, label);
}

/** Freeze a defensive JSON copy through the original fixture receipt primitive. */
export function deepFreeze(value)
{
    assertJson(value);
    return freezeDeep(value);
}
