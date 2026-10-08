import { URL } from 'node:url';

import { isAtomicExecutable, resolveAtomicReference, validateAtomicProducerDeclarations } from './contract.mjs';

const { digestCanonical, sealContentDigest } = await import(new URL('../../test/attempt-provenance.mjs', import.meta.url));

function freezeTree(value)
{
    if (value && typeof value === 'object')
    {
        Object.values(value).forEach(freezeTree);
        Object.freeze(value);
    }
    return value;
}

/**
 * One projection for direct, Fresh, resume and CI consumers. No shell scanning,
 * test discovery, seed selection, or additional scheduler is performed here.
 */
export function compileAtomicProducerDag(matrix, authorities)
{
    const declarations = validateAtomicProducerDeclarations(matrix, authorities);
    const steps = declarations.nodes.map((node) =>
    {
        const common = {
            id: node.producerId,
            kind: node.kind,
            logicalParentId: node.logicalParentId,
            owner: node.owner,
            projectionOwner: node.projectionOwner,
            dependsOn: node.dependsOn,
            settledDependsOn: node.settledDependsOn
        };
        if (isAtomicExecutable(node))
        {
            const source = resolveAtomicReference(authorities.commandSources, node.commandSourceRef, 'command source');
            const resources = resolveAtomicReference(authorities.resourceContracts, node.resourceContractRef, 'resource contract');
            return {
                ...common,
                command: source.command,
                commandSourceRef: node.commandSourceRef,
                inputClosureRef: source.inputClosureRef,
                attemptPolicyId: node.attemptPolicyId,
                executionClass: node.executionClass,
                fixtureProfile: node.fixtureProfile,
                stateAccessRef: node.stateAccessRef,
                resourceContractRef: node.resourceContractRef,
                resources: resources.resources,
                serviceDependencies: node.serviceDependencies,
                artifacts: node.artifacts,
                evidence: node.evidence,
                replayOwner: node.replayOwner,
                replayPlanRef: node.replayPlanRef
            };
        }
        const coordination = {
            ...common,
            resources: { coordinationOnly: true, cpuWeight: 0, memoryWeight: 0, minCpuUnits: 0 }
        };
        return node.kind === 'always-run-finalizer'
            ? { ...coordination, alwaysRunFinalizer: true, finalizerPurpose: node.finalizerPurpose, operationRef: node.operationRef }
            : { ...coordination, runAfterSettled: true };
    }).sort((left, right) => left.id.localeCompare(right.id, 'en'));
    return freezeTree(sealContentDigest({
        schema: 'fsusblog.compiled-atomic-producer-dag.v1',
        matrixDigest: digestCanonical(matrix),
        authorityProjectionDigest: digestCanonical(authorities),
        declarationsDigest: digestCanonical({ ...declarations, nodes: [...declarations.nodes].sort((left, right) =>
            left.producerId.localeCompare(right.producerId, 'en')) }),
        qualificationEligible: false,
        steps
    }));
}

export function verifyCompiledAtomicProducerDag(compiled, matrix, authorities)
{
    const expected = compileAtomicProducerDag(matrix, authorities);
    if (digestCanonical(compiled) !== digestCanonical(expected))
    {
        throw new Error('compiled atomic DAG differs from exact matrix/authority projection');
    }
    return expected;
}
