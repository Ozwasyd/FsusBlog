import { URL } from 'node:url';

const { canonicalDigest } = await import(new URL('../execution-replay-contract.mjs', import.meta.url));

/**
 * Preserve the existing visual lanes, fixtures, classification and artifacts.
 * Provide settled-edge source material to the matrix/compiler owner; do not
 * create an install/runtime owner or validate fixture receipts a second time.
 */
export function projectFrontendVisual(matrix)
{
    const declarations = ['visual-public', 'visual-console', 'visual'].map((id) =>
    {
        const matches = matrix.tiers.filter((tier) => tier.id === id);
        if (matches.length !== 1)
        {
            throw new Error(`${id} requires exactly one matrix declaration`);
        }
        return structuredClone(matches[0]);
    });
    const entries = declarations.slice(0, 2);
    const aggregate = declarations[2];
    if (aggregate.executionClass !== 'coordination'
        || aggregate.executionDependsOn.length !== entries.length
        || entries.some((entry) => !aggregate.executionDependsOn.includes(entry.id)))
    {
        throw new Error('visual aggregate must bind exactly the two canonical visual lanes');
    }
    return {
        qualificationEligible: false,
        sourceDigest: canonicalDigest(declarations),
        entries,
        existingAggregate: aggregate,
        settledProjection: {
            id: 'visual-summary',
            dependsOn: [],
            settledDependsOn: entries.map((entry) => entry.id)
        },
        missingContracts: [
            'atomic-disposition',
            'attempt-and-replay-binding',
            'verified-fixture-lifecycle-admission',
            'shared-candidate-and-browser-admission'
        ]
    };
}

/**
 * Compare held identity material before its independent owner admits execution.
 * Matching strings are necessary, but never constitute verified runtime proof.
 * Public and console URLs may differ; shared build/browser identities may not.
 */
export function compareVisualSharedIdentityMaterial(publicIdentity, consoleIdentity)
{
    const fields = ['runId', 'sourceCommit', 'candidateDigest', 'frontendBuildDigest',
        'backendBuildDigest', 'releasePreviewDigest', 'fsusUiDigest', 'browserPlanDigest',
        'serviceGeneration'];
    const differences = fields.filter((field) =>
        typeof publicIdentity?.[field] !== 'string' || !publicIdentity[field].trim()
        || typeof consoleIdentity?.[field] !== 'string' || !consoleIdentity[field].trim()
        || publicIdentity[field] !== consoleIdentity[field]);
    return { qualificationEligible: false, matches: differences.length === 0, differences };
}
