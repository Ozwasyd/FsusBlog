import crypto from 'node:crypto';

export const backendEvidencePathAuthorityFile =
    'tests/backend/Fixtures/backend-evidence-path-authority.generated.json';

function sha256(value)
{
    return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function temporaryEvidencePaths(requirementCatalog)
{
    return [...new Set([
        ...(requirementCatalog.requirements ?? []),
        ...(requirementCatalog.profiles ?? [])
    ].flatMap((entry) => entry.evidencePaths ?? [])
        .filter((evidencePath) => typeof evidencePath === 'string' && evidencePath.startsWith('.tmp/')))]
        .sort();
}

export function buildBackendEvidencePathAuthority(matrixSource, matrix, requirementCatalog)
{
    const declaredOwners = new Map();
    for (const tier of matrix.tiers ?? [])
    {
        for (const declarationKind of ['evidence', 'artifacts'])
        {
            for (const evidencePath of tier[declarationKind] ?? [])
            {
                if (!evidencePath.startsWith('.tmp/'))
                {
                    continue;
                }
                const owners = declaredOwners.get(evidencePath) ?? [];
                owners.push({
                    tierId: tier.id,
                    tierOwner: tier.owner,
                    declarationKind
                });
                declaredOwners.set(evidencePath, owners);
            }
        }
    }

    const errors = [];
    const entries = temporaryEvidencePaths(requirementCatalog).map((evidencePath) =>
    {
        const owners = declaredOwners.get(evidencePath) ?? [];
        if (owners.length === 0)
        {
            errors.push(`generated backend evidence is not declared by an exact matrix tier output: ${evidencePath}`);
        }
        return { evidencePath, owners };
    });

    return {
        errors,
        authority: {
            schema: 'fsusblog.backend-evidence-path-authority.v1',
            generatedBy: 'tools/test/generate-backend-evidence-path-authority.mjs',
            sources: {
                'tests/matrix.yml': sha256(matrixSource),
                'tests/backend/Fixtures/backend-test-requirements.json': sha256(`${JSON.stringify(requirementCatalog, null, 4)}\n`)
            },
            entries
        }
    };
}
