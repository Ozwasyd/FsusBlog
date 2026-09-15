export function diffAuthorityViolations({
    diffFile,
    diffSource,
    structureSource,
    forbiddenDiffPatterns,
    forbiddenDiffOnlyPatterns
})
{
    const violations = [];
    for (const [label, pattern] of forbiddenDiffPatterns)
    {
        if (pattern.test(diffSource) || pattern.test(structureSource))
        {
            violations.push(`${diffFile}: ${label} is forbidden`);
        }
    }
    for (const [label, pattern] of forbiddenDiffOnlyPatterns)
    {
        if (pattern.test(diffSource))
        {
            violations.push(`${diffFile}: ${label} is forbidden`);
        }
    }
    if (!/Task\.Run\s*\(/u.test(diffSource)
        || !/ComputeAsync\s*\(\s*RevisionComparePlanBundle\s+bundle/u.test(diffSource))
    {
        violations.push(`${diffFile}: diff engine must execute from a sealed plan on a worker task`);
    }
    if (!/\bIRevisionMarkdownStructureAuthority\b/u.test(diffSource))
    {
        violations.push(`${diffFile}: diff engine must consume the canonical Markdown structure authority`);
    }
    return violations;
}
