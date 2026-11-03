const {
    assertDigest,
    digestCanonical,
    freezeDeep,
    plainObject
} = await import(new URL('../../test-fixtures/receipt/canonical.mjs', import.meta.url));

export function requireExactKeys(value, keys, label)
{
    if (!plainObject(value)
      || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort()))
    {
        throw new Error(`${label} requires exactly ${keys.join(', ')}`);
    }
}

export function requireText(value, label)
{
    if (typeof value !== 'string' || !value.trim())
    {
        throw new Error(`${label} is required`);
    }
    return value;
}

export function validateContext(context)
{
    requireExactKeys(context, [
        'runId', 'namespace', 'profileId', 'sourceRevision', 'runtimeDigest', 'stateCatalogDigest'
    ], 'security context');
    for (const key of ['runId', 'namespace', 'profileId'])
    {
        requireText(context[key], key);
    }
    if (!/^[0-9a-f]{40}$/u.test(context.sourceRevision))
    {
        throw new Error('sourceRevision must be an exact Git commit');
    }
    assertDigest(context.runtimeDigest, 'runtimeDigest');
    assertDigest(context.stateCatalogDigest, 'stateCatalogDigest');
    return freezeDeep(context);
}

export function validateReference(reference)
{
    requireExactKeys(reference, ['owner', 'sourceRevision', 'path', 'contentDigest'], 'owner reference');
    requireText(reference.owner, 'reference.owner');
    requireText(reference.path, 'reference.path');
    if (!/^[0-9a-f]{40}$/u.test(reference.sourceRevision))
    {
        throw new Error('owner reference requires exact sourceRevision');
    }
    assertDigest(reference.contentDigest, 'reference.contentDigest');
    return freezeDeep(reference);
}

export function sealProjection(body)
{
    return freezeDeep({ ...body, contentDigest: digestCanonical(body) });
}

export function verifyProjection(projection)
{
    const { contentDigest, ...body } = projection;
    if (assertDigest(contentDigest) !== digestCanonical(body))
    {
        throw new Error('security projection content digest mismatch');
    }
    return projection;
}

// The upstream verifier, not a self-reported `verified` field or body digest,
// establishes authority. These ports deliberately have no permissive default.
export async function consumeOwnerReference(kind, reference, context, ownerVerifiers)
{
    const boundReference = validateReference(reference);
    const verifier = ownerVerifiers?.[kind];
    if (typeof verifier !== 'function')
    {
        throw new Error(`missing canonical ${kind} verifier capability`);
    }
    const verifiedDigest = await verifier(boundReference, validateContext(context));
    if (verifiedDigest !== boundReference.contentDigest)
    {
        throw new Error(`${kind} owner verifier rejected current-run reference`);
    }
    return boundReference;
}

export async function collectSecurityTerminals({ producerIds, references, context, ownerVerifiers })
{
    if (!Array.isArray(producerIds) || new Set(producerIds).size !== producerIds.length
      || !Array.isArray(references) || references.length !== producerIds.length)
    {
        throw new Error('settled aggregate requires exact-one terminal per producer');
    }
    const terminals = [];
    for (const producerId of producerIds)
    {
        const matches = references.filter((item) => item.producerId === producerId);
        if (matches.length !== 1)
        {
            throw new Error(`settled aggregate missing/duplicate terminal: ${producerId}`);
        }
        const item = matches[0];
        requireExactKeys(item, [
            'producerId', 'terminalState', 'reasonCode', 'primaryFailureRefs', 'reference'
        ], 'terminal projection');
        if (!['success', 'failed', 'blocked', 'cancelled', 'timed-out', 'internal-error', 'not-applicable', 'diagnostic'].includes(item.terminalState)
          || !Array.isArray(item.primaryFailureRefs))
        {
            throw new Error(`invalid terminal disposition: ${producerId}`);
        }
        requireText(item.reasonCode, 'terminal reasonCode');
        await consumeOwnerReference('terminal', item.reference, context, ownerVerifiers);
        const verifier = ownerVerifiers?.terminalProjection;
        if (typeof verifier !== 'function' || await verifier(item, context) !== item.reference.contentDigest)
        {
            throw new Error('terminal fields must match the canonical owner receipt');
        }
        terminals.push(item);
    }
    return sealProjection({
        schema: 'fsusblog.security-atomic-settled-projection.v1',
        context: validateContext(context),
        status: terminals.every((item) => ['success', 'not-applicable'].includes(item.terminalState))
            ? 'success' : 'failed',
        terminals,
        primaryFailureRefs: [...new Set(terminals.flatMap((item) => item.primaryFailureRefs))]
    });
}
