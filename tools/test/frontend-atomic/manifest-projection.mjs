import { URL } from 'node:url';

const { resolveCommandGroup } = await import(new URL('../../test-matrix/command-groups.mjs', import.meta.url));
const { canonicalDigest } = await import(new URL('../execution-replay-contract.mjs', import.meta.url));
const { validateCommandManifest } = await import(new URL('../run-command-manifest.mjs', import.meta.url));

/**
 * Project source material for the atomic compiler owner, without registering a
 * second topology or granting attempt, fixture, replay or receipt authority.
 * Entry order never supplies a dependency. Missing entry contracts stay visible.
 */
export function projectFrontendManifestGroup(matrix, groupId)
{
    if (!groupId.startsWith('frontend-'))
    {
        throw new Error('frontend manifest projection requires a frontend group');
    }
    const manifest = resolveCommandGroup(matrix, groupId);
    const errors = validateCommandManifest(manifest);
    if (errors.length > 0)
    {
        throw new Error(errors.join('; '));
    }
    const parents = matrix.tiers.filter((tier) => tier.id === groupId);
    if (parents.length !== 1)
    {
        throw new Error(`${groupId} requires exactly one matrix parent`);
    }
    const ids = new Set(manifest.commands.map((entry) => entry.id));
    for (const entry of manifest.commands)
    {
        for (const dependency of [...(entry.dependsOn ?? []), ...(entry.settledDependsOn ?? [])])
        {
            if (!ids.has(dependency))
            {
                throw new Error(`${entry.id} references a non-entry dependency: ${dependency}`);
            }
        }
    }
    const parentDeclaration = structuredClone(parents[0]);
    const entries = manifest.commands.map((entry) => ({
        id: entry.id,
        logicalParentId: groupId,
        commandSourceRef: {
            path: 'tests/matrix.yml',
            groupId,
            entryId: entry.id
        },
        command: entry.script ? ['npm', 'run', entry.script] : [...entry.command],
        dependsOn: [...(entry.dependsOn ?? [])],
        settledDependsOn: [...(entry.settledDependsOn ?? [])],
        manifestEntry: structuredClone(entry),
        missingContracts: [
            'atomic-disposition',
            'attempt-and-replay-binding',
            ...(!entry.consumedInputs ? ['entry-input-closure'] : []),
            ...(!entry.resources ? ['entry-resource-contract'] : []),
            ...((entry.localCommands?.length ?? 0) > 0 ? ['composite-entry-disposition'] : [])
        ]
    }));
    return {
        qualificationEligible: false,
        groupId,
        sourceDigest: canonicalDigest({ manifest, parentDeclaration }),
        parentDeclaration,
        entries,
        settledProjection: {
            id: `${groupId}-summary`,
            dependsOn: [],
            settledDependsOn: entries.map((entry) => entry.id)
        }
    };
}

/** Derive the complete frontend group set from the sole matrix commandGroups. */
export function projectFrontendManifestGroups(matrix)
{
    const projections = Object.keys(matrix.commandGroups ?? {})
        .filter((id) => id.startsWith('frontend-'))
        .sort()
        .map((id) => projectFrontendManifestGroup(matrix, id));
    const ids = projections.flatMap((projection) => projection.entries.map((entry) => entry.id));
    if (new Set(ids).size !== ids.length)
    {
        throw new Error('frontend manifest entries require globally unique stable IDs');
    }
    return {
        qualificationEligible: false,
        sourceDigest: canonicalDigest(projections),
        groups: projections
    };
}
