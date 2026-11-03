const { readCatalog, validateRuntimeScenarioCatalog } = await import(new URL('../runtime-scenario-host.mjs', import.meta.url));
const { digestCanonical } = await import(new URL('../../test-fixtures/receipt/canonical.mjs', import.meta.url));

import {
    consumeOwnerReference,
    requireExactKeys,
    requireText,
    sealProjection,
    validateContext,
    validateReference
} from './contract.mjs';

// Fixed external identities from #2260, not an application scenario catalog.
export const securityBoundaryIds = Object.freeze([
    'security-local-runtime-exposure',
    'security-firewall-evidence',
    'security-external-production-exposure',
    'security-dast'
]);

export async function projectSecurityBoundaries({ catalog = readCatalog(), policyReference, context, ownerVerifiers })
{
    const errors = validateRuntimeScenarioCatalog(catalog);
    if (errors.length > 0)
    {
        throw new Error(errors.join('; '));
    }
    const binding = validateContext(context);
    await consumeOwnerReference('boundaryPolicy', policyReference, binding, ownerVerifiers);
    const project = ownerVerifiers?.boundaryPolicyProjection;
    if (typeof project !== 'function')
    {
        throw new Error('missing canonical boundary policy projection capability');
    }
    const selection = await project(policyReference, binding);
    requireExactKeys(selection, securityBoundaryIds, 'boundary policy projection');
    const producers = securityBoundaryIds.map((producerId) =>
    {
        const entry = selection[producerId];
        requireExactKeys(entry, [
            'applicable', 'reasonCode', 'classification', 'explicitInputs', 'envelope', 'replay', 'stateAccess'
        ], 'boundary selection');
        if (typeof entry.applicable !== 'boolean'
          || !['correctness', 'diagnostic'].includes(entry.classification)
          || !Array.isArray(entry.explicitInputs))
        {
            throw new Error('boundary applicability requires explicit closed policy disposition');
        }
        requireText(entry.reasonCode, 'policy reasonCode');
        for (const reference of entry.explicitInputs)
        {
            validateReference(reference);
        }
        for (const field of ['envelope', 'replay', 'stateAccess'])
        {
            validateReference(entry[field]);
        }
        if (entry.applicable && producerId === 'security-firewall-evidence' && entry.explicitInputs.length === 0)
        {
            throw new Error('applicable firewall requires explicit evidence binding');
        }
        if (entry.applicable && producerId === 'security-external-production-exposure' && entry.explicitInputs.length === 0)
        {
            throw new Error('external exposure requires explicit live-policy inputs');
        }
        const scenarioId = producerId === 'security-local-runtime-exposure' ? 'security.local-runtime-exposure'
            : producerId === 'security-dast' ? 'security.dast' : null;
        const scenario = scenarioId ? catalog.scenarios.find((item) => item.id === scenarioId && item.phase === 'security') : null;
        if (scenarioId && !scenario)
        {
            throw new Error(`missing canonical external scenario: ${scenarioId}`);
        }
        return {
            producerId,
            kind: 'conditional-atomic',
            allowedRetries: 0,
            attemptNumber: 1,
            policyReference,
            selection: entry,
            dependsOn: producerId === 'security-local-runtime-exposure' || producerId === 'security-dast'
                ? ['security-runtime-ready'] : [],
            invocation: scenario ? { kind: 'catalog-scenario', scenario }
                : { kind: 'existing-boundary-owner', producerId }
        };
    });
    return sealProjection({
        schema: 'fsusblog.security-atomic-boundary-projection.v1',
        catalogDigest: digestCanonical(catalog),
        context: binding,
        producers,
        aggregate: {
            producerId: 'security-external-boundaries-summary',
            kind: 'settled-projection',
            settledDependsOn: [...securityBoundaryIds],
            executesCommands: false
        }
    });
}

export async function admitSecurityBoundary({ producer, context, runtimeReference, ownerVerifiers })
{
    const binding = validateContext(context);
    if (!securityBoundaryIds.includes(producer.producerId) || producer.kind !== 'conditional-atomic'
      || producer.allowedRetries !== 0 || producer.attemptNumber !== 1)
    {
        throw new Error('boundary requires exact-one zero-retry declaration');
    }
    await consumeOwnerReference('boundaryPolicy', producer.policyReference, binding, ownerVerifiers);
    const project = ownerVerifiers?.boundaryPolicyProjection;
    if (typeof project !== 'function')
    {
        throw new Error('missing canonical boundary policy projection capability');
    }
    const currentSelection = await project(producer.policyReference, binding);
    requireExactKeys(currentSelection, securityBoundaryIds, 'boundary policy projection');
    const verifyDeclaration = ownerVerifiers?.boundaryDeclaration;
    if (typeof verifyDeclaration !== 'function'
      || await verifyDeclaration(producer, currentSelection, binding) !== producer.producerId)
    {
        throw new Error('boundary declaration drift from canonical policy/catalog');
    }
    if (!producer.selection.applicable)
    {
        return sealProjection({
            schema: 'fsusblog.security-atomic-non-applicability-request.v1',
            producerId: producer.producerId,
            context: binding,
            policyReference: producer.policyReference,
            reasonCode: producer.selection.reasonCode,
            spawn: false,
            requiresTerminalReceipt: true
        });
    }
    for (const reference of producer.selection.explicitInputs)
    {
        await consumeOwnerReference('boundaryInput', reference, binding, ownerVerifiers);
    }
    for (const kind of ['envelope', 'replay', 'stateAccess'])
    {
        await consumeOwnerReference(kind, producer.selection[kind], binding, ownerVerifiers);
    }
    if (producer.dependsOn.includes('security-runtime-ready'))
    {
        await consumeOwnerReference('runtime', runtimeReference, binding, ownerVerifiers);
    }
    return sealProjection({
        schema: 'fsusblog.security-atomic-admission-request.v1',
        producerId: producer.producerId,
        context: binding,
        declaration: producer,
        runtimeReference: runtimeReference ?? null
    });
}
