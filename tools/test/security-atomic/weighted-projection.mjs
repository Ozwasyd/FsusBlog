import {
    consumeOwnerReference,
    requireExactKeys,
    sealProjection,
    validateContext,
    verifyProjection
} from './contract.mjs';

const { digestCanonical } = await import(new URL('../../test-fixtures/receipt/canonical.mjs', import.meta.url));

/**
 * Materialize security declarations into the existing weighted DAG's native
 * step shape. Execution, attempts, resource grants and terminal sealing remain
 * with the canonical scheduler/executor; this adapter only produces steps.
 */
export async function materializeSecurityWeightedSteps({ barriers, scenarios, boundaries, context, ownership, ownerVerifiers })
{
    verifyProjection(barriers);
    verifyProjection(scenarios);
    verifyProjection(boundaries);
    const binding = validateContext(context);
    if (barriers.schema !== 'fsusblog.security-atomic-barrier-projection.v1'
      || scenarios.schema !== 'fsusblog.security-atomic-scenario-projection.v1'
      || boundaries.schema !== 'fsusblog.security-atomic-boundary-projection.v1'
      || barriers.catalogDigest !== scenarios.catalogDigest || barriers.catalogDigest !== boundaries.catalogDigest
      || digestCanonical(boundaries.context) !== digestCanonical(binding)
      || scenarios.producers.some((producer) => producer.invocation.mode !== barriers.mode)
      || barriers.fixturePlan?.profileId !== binding.profileId)
    {
        throw new Error('security weighted projection catalog/mode/profile/context binding mismatch');
    }
    const declarations = [
        ...barriers.nodes.filter((node) => node.kind !== 'cleanup-finalizer'),
        ...scenarios.producers,
        ...boundaries.producers,
        scenarios.aggregate,
        boundaries.aggregate,
        ...barriers.nodes.filter((node) => node.kind === 'cleanup-finalizer')
    ];
    if (!Array.isArray(ownership) || ownership.length !== declarations.length
      || new Set(ownership.map((item) => item.producerId)).size !== declarations.length)
    {
        throw new Error('weighted security ownership must cover every declaration exactly once');
    }
    const steps = [];
    for (const declaration of declarations)
    {
        const owner = ownership.find((item) => item.producerId === declaration.producerId);
        requireExactKeys(owner, ['producerId', 'reference', 'resources'], 'weighted ownership');
        await consumeOwnerReference('weightedOwnership', owner.reference, binding, ownerVerifiers);
        const verifier = ownerVerifiers?.weightedDeclaration;
        if (typeof verifier !== 'function' || await verifier(declaration, owner, binding) !== declaration.producerId)
        {
            throw new Error('weighted declaration/resources require canonical physical ownership');
        }
        const step = {
            id: declaration.producerId,
            dependsOn: [...(declaration.dependsOn ?? [])],
            resources: owner.resources,
            securityDeclaration: declaration,
            securityOwnershipReference: owner.reference
        };
        if (declaration.kind === 'settled-projection')
        {
            if (owner.resources.coordinationOnly !== true)
            {
                throw new Error('security aggregate must be coordination-only');
            }
            step.runAfterSettled = true;
            step.settledDependsOn = [...declaration.settledDependsOn];
        }
        if (declaration.kind === 'cleanup-finalizer')
        {
            if (owner.resources.coordinationOnly !== true || declaration.unlocksCorrectness !== false)
            {
                throw new Error('security cleanup must not unlock correctness');
            }
            step.alwaysRunFinalizer = true;
            step.finalizerPurpose = 'cleanup';
            step.settledDependsOn = declarations.filter((item) => item.kind !== 'cleanup-finalizer')
                .map((item) => item.producerId);
        }
        steps.push(step);
    }
    const ids = new Set(steps.map((step) => step.id));
    if (ids.size !== steps.length)
    {
        throw new Error('duplicate security weighted step identity');
    }
    for (const step of steps)
    {
        for (const dependency of [...step.dependsOn, ...(step.settledDependsOn ?? [])])
        {
            if (!ids.has(dependency) || dependency === step.id)
            {
                throw new Error('security weighted declaration has an unresolved dependency');
            }
        }
    }
    return sealProjection({
        schema: 'fsusblog.security-atomic-weighted-projection.v1',
        context: binding,
        steps
    });
}
