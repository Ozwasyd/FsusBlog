function tierExecutionDependencies(tier)
{
    return tier?.executionDependsOn ?? tier?.dependsOn ?? [];
}

function tierEvidenceDependencies(tier)
{
    return tier?.requiresEvidenceFrom ?? tierExecutionDependencies(tier);
}

export function validateNativeMatrix({ catalog, matrix })
{
    const errors = [];
    const targets = catalog?.targets ?? [];
    const profiles = catalog?.profiles ?? [];
    const tiers = new Map((matrix?.tiers ?? []).map((tier) => [tier.id, tier]));

    for (const profile of profiles)
    {
        const profileTargets = targets.filter((target) => target.profile === profile.id);
        if (profileTargets.length !== 1)
        {
            errors.push(`profile ${profile.id} must own exactly one native target`);
        }
        const tier = tiers.get(profile.matrixTier);
        if (!tier)
        {
            errors.push(`matrix tier is missing: ${profile.matrixTier}`);
            continue;
        }
        if (tier.owner !== catalog.owner)
        {
            errors.push(`matrix tier ${tier.id} has the wrong owner`);
        }
        if (!String(tier.command ?? '').includes(`--profile ${profile.id}`))
        {
            errors.push(`matrix tier ${tier.id} does not execute profile ${profile.id}`);
        }
        if (!(tier.evidence ?? []).includes(profile.receipt))
        {
            errors.push(`matrix tier ${tier.id} does not own receipt ${profile.receipt}`);
        }
    }

    const production = tiers.get('production-correctness');
    const releaseFinal = tiers.get('release-final');
    const smoke = profiles.find((profile) => profile.consumers?.includes('production-fresh'));
    const fuzz = profiles.find((profile) => profile.consumers?.includes('release-final'));
    if (!smoke || tierExecutionDependencies(production).filter((tierId) => tierId === smoke.matrixTier).length !== 1)
    {
        errors.push('production fresh must consume the native smoke tier exactly once');
    }
    if (!fuzz || tierEvidenceDependencies(releaseFinal).filter((tierId) => tierId === fuzz.matrixTier).length !== 1)
    {
        errors.push('release-final must consume the native fuzz/sanitizer tier exactly once');
    }
    if (smoke && tierExecutionDependencies(tiers.get(smoke.matrixTier)).includes(fuzz?.matrixTier))
    {
        errors.push('native smoke must not be blocked by the fuzz/sanitizer tier');
    }
    return errors;
}
