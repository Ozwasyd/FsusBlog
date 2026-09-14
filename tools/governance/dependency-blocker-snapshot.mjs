import { collectDependencyPullSnapshot } from './dependency-blocker-pull-snapshot.mjs';
import { parseRenovatePullRequests } from './dependency-freshness-pulls.mjs';
import { resolveDependencyPullTarget } from './dependency-pull-target.mjs';
import { resolveGroupChecks } from './dependency-required-checks.mjs';

function mappingIdentity(mappings)
{
    return JSON.stringify(mappings.map((item) => [item.number, item.dependencyId, item.packageName, item.group,
        item.targetVersion, item.updateType, item.headSha, item.state]).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));
}

/** Join canonical freshness PR mappings with fresh, source-bound check observations. */
export async function buildDependencyBlockerSnapshot({ report, catalog, exceptions, requiredChecks, client, config = {} })
{
    if (!Array.isArray(report?.pullRequests) || !Array.isArray(catalog?.items))
    {
        throw new Error('dependency_blocker_missing_canonical_pull_mapping');
    }
    const byNumber = new Map();
    const items = new Map(catalog.items.map((item) => [item.id, item]));
    for (const mapping of report.pullRequests)
    {
        if (mapping.state !== 'open')
        {
            continue;
        }
        const item = items.get(mapping.dependencyId);
        if (!item || item.packageName !== mapping.packageName || item.group !== mapping.group
            || !Number.isSafeInteger(mapping.number) || mapping.number <= 0 || !/^[0-9a-f]{40}$/.test(mapping.headSha)
            || resolveGroupChecks(requiredChecks, mapping.group, mapping.updateType).length === 0)
        {
            throw new Error('dependency_blocker_invalid_canonical_pull_mapping');
        }
        const mappings = byNumber.get(mapping.number) ?? [];
        if (mappings.some((prior) => prior.dependencyId === mapping.dependencyId))
        {
            throw new Error('dependency_blocker_duplicate_canonical_pull_mapping');
        }
        mappings.push(mapping);
        byNumber.set(mapping.number, mappings);
    }
    const pullRequests = [];
    for (const [number, mappings] of [...byNumber].sort(([left], [right]) => left - right))
    {
        const expected = mappingIdentity(mappings);
        pullRequests.push(await collectDependencyPullSnapshot({
            client, number,
            dependencyIds: mappings.map((item) => item.dependencyId).sort(),
            requirements: mappings.map((item) => ({ group: item.group, updateType: item.updateType })),
            verifyPull: async (pull) =>
            {
                const declared = parseRenovatePullRequests([pull], catalog);
                const expectedDeclarations = mappings.map(mapping => ({ ...mapping, targetVersion: mapping.declaredTargetVersion ?? mapping.targetVersion }));
                if (mappingIdentity(declared) !== mappingIdentity(expectedDeclarations))
                {
                    throw new Error('dependency_blocker_pull_mapping_changed');
                }
                const verified = [];
                for (const mapping of declared)
                {
                    const prior = mappings.find(item => item.dependencyId === mapping.dependencyId);
                    verified.push(prior.declaredTargetVersion === undefined ? mapping : await resolveDependencyPullTarget({
                        mapping, item: items.get(mapping.dependencyId), config, readFileAtHead: client.readFileAtHead
                    }));
                }
                if (mappingIdentity(verified) !== expected)
                {
                    throw new Error('dependency_blocker_pull_target_changed');
                }
            }
        }));
    }
    return { report, catalog, exceptions, requiredChecks, pullRequests };
}
