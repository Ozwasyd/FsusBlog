export const releaseFinalDomainProjectionTierIds = Object.freeze([
    'release-admin-console',
    'release-aot-generation',
    'release-auth-flow',
    'release-authoring-flow',
    'release-error-boundary',
    'release-private-preview',
    'release-static-asset-digest-coherence'
]);

function isDigest(value)
{
    return /^sha256:[a-f0-9]{64}$/u.test(String(value ?? ''));
}

export function createReleaseDomainProjectionBindings(receipts)
{
    if (!Array.isArray(receipts))
    {
        throw new Error('release-final requires release-domain projection receipts');
    }
    const bindings = receipts.map((receipt) => ({
        tierId: String(receipt?.tierId ?? ''),
        path: String(receipt?.path ?? '').replaceAll('\\', '/'),
        fileDigest: receipt?.fileDigest,
        contentDigest: receipt?.contentDigest,
        buildIdentity: receipt?.buildIdentity,
        policyIdentity: receipt?.policyIdentity
    }));
    if (validateReleaseDomainProjectionBindings(bindings).length > 0)
    {
        throw new Error('release-final release-domain projection receipt bindings are invalid');
    }
    return bindings;
}

export function validateReleaseDomainProjectionBindings(bindings)
{
    if (!Array.isArray(bindings))
    {
        return ['release-final binding releaseDomains must be an array'];
    }
    const errors = [];
    const tierIds = bindings.map((receipt) => receipt?.tierId);
    if (JSON.stringify(tierIds) !== JSON.stringify(releaseFinalDomainProjectionTierIds))
    {
        errors.push('release-final binding releaseDomains do not exactly match the canonical release-domain set');
    }
    for (const [index, receipt] of bindings.entries())
    {
        const expectedPath =
            `.tmp/release-evidence/projections/${receipt?.tierId ?? 'missing'}.json`;
        if (receipt?.path !== expectedPath)
        {
            errors.push(`release-final binding releaseDomains[${index}].path must be ${expectedPath}`);
        }
        for (const key of ['fileDigest', 'contentDigest', 'buildIdentity', 'policyIdentity'])
        {
            if (!isDigest(receipt?.[key]))
            {
                errors.push(`release-final binding releaseDomains[${index}].${key} is invalid`);
            }
        }
    }
    return errors;
}
