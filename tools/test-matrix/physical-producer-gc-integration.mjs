import { isDeepStrictEqual } from 'node:util';

import { compileAtomicProducerDag } from './atomic-producers/compiler.mjs';
import { isAtomicExecutable, resolveAtomicReplayPlan } from './atomic-producers/contract.mjs';
import { compilePhysicalProducerGcOrdering } from './physical-producer-gc-ordering.mjs';

const { digestCanonical, sealContentDigest } = await import(new URL('../test/attempt-provenance.mjs', import.meta.url));

function executableIds(filesystemInput)
{
    return filesystemInput.physicalOwners.filter((owner) => owner.spawnEligibility === true)
        .map((owner) => owner.producerId).sort();
}

function exactRoster(actual, expected)
{
    if (!isDeepStrictEqual([...actual].sort(), [...expected].sort()) || new Set(actual).size !== actual.length)
    {
        throw new Error('GC integration executable ownership differs from filesystem catalog');
    }
}

function dependencies(previous, producerId, ordering)
{
    if (!Array.isArray(previous) || previous.some((id) => typeof id !== 'string' || !id)
        || new Set(previous).size !== previous.length)
    {
        throw new Error('GC integration requires explicit unique dependencies');
    }
    return [...previous.filter((id) => id !== ordering.gcProducerId),
        ...(ordering.dependentProducerIds.includes(producerId) ? [ordering.gcProducerId] : [])].sort();
}

function assertDag(nodes, edges)
{
    const byId = new Map(nodes.map((node) => [node.id, node]));
    if (byId.size !== nodes.length)
    {
        throw new Error('GC integration duplicate scheduler tier');
    }
    const active = new Set();
    const visited = new Set();
    const visit = (id) =>
    {
        if (!byId.has(id) || active.has(id))
        {
            throw new Error('GC integration unknown dependency or cycle');
        }
        if (visited.has(id))
        {
            return;
        }
        active.add(id);
        const dependencyIds = edges(byId.get(id));
        if (!Array.isArray(dependencyIds) || dependencyIds.some((dependency) => typeof dependency !== 'string' || !dependency)
            || new Set(dependencyIds).size !== dependencyIds.length)
        {
            throw new Error('GC integration requires explicit unique dependencies');
        }
        dependencyIds.forEach(visit);
        active.delete(id);
        visited.add(id);
    };
    nodes.forEach((node) => visit(node.id));
}

/**
 * Adapt canonical scheduler tiers without changing commands, services, locks,
 * resource contracts or protected-root/deletion policy. The caller retains
 * reservation.guardProducer before GC and every other spawn. This adapter
 * never runs a scheduler, seals capacity or grants execution permission.
 */
export function compilePhysicalProducerGcIntegration({ tiers, filesystemPlan, filesystemInput, gcProducerId })
{
    const ordering = compilePhysicalProducerGcOrdering({ filesystemPlan, filesystemInput, gcProducerId });
    if (!Array.isArray(tiers))
    {
        throw new Error('GC integration requires explicit scheduler tiers');
    }
    const physicalIds = executableIds(filesystemInput);
    exactRoster(tiers.filter((tier) => tier.command !== undefined).map((tier) => tier.id), physicalIds);
    for (const tier of tiers)
    {
        if (physicalIds.includes(tier.id)
            && (tier.executionMode === 'summary' || tier.executionMode === 'projection'
                || !(typeof tier.command === 'string' && tier.command.length > 0
                    || Array.isArray(tier.command) && tier.command.length > 0)))
        {
            throw new Error('GC integration physical command requires executable ownership');
        }
    }
    const planned = structuredClone(tiers).map((tier) => physicalIds.includes(tier.id) && tier.id !== gcProducerId
        ? { ...tier, executionDependsOn: dependencies(tier.executionDependsOn, tier.id, ordering) } : tier);
    assertDag(planned, (tier) => tier.executionDependsOn ?? []);
    return sealContentDigest({
        schema: 'fsusblog.physical-producer-gc-integration.v1',
        qualificationEligible: false,
        executionEligible: false,
        inputTiersDigest: digestCanonical(tiers),
        ordering,
        tiers: planned
    });
}

/**
 * Consume the existing atomic compiler. Only executable hard GC edges change;
 * the same authority material is rebound to the mechanically derived matrix
 * digest and revalidated by that compiler. Return both compiler inputs so the
 * existing execution adapter can verify the derived DAG without a new runner.
 * No external authority admission, retry or command-source repair occurs here.
 */
export function compilePhysicalProducerGcAtomicIntegration({ matrix, authorities, filesystemPlan, filesystemInput, gcProducerId })
{
    const original = compileAtomicProducerDag(matrix, authorities);
    const ordering = compilePhysicalProducerGcOrdering({ filesystemPlan, filesystemInput, gcProducerId });
    exactRoster(original.steps.filter(isAtomicExecutable).map((step) => step.id), executableIds(filesystemInput));
    const expectedOwners = original.steps.map((step) => ({
        producerId: step.id,
        ownerKind: isAtomicExecutable(step) ? 'executable'
            : step.kind === 'logical-projection' ? 'projection'
                : step.kind === 'always-run-finalizer' ? 'receipt-only-finalizer' : 'summary',
        spawnEligibility: isAtomicExecutable(step)
    })).sort((left, right) => left.producerId.localeCompare(right.producerId));
    if (!isDeepStrictEqual([...filesystemInput.physicalOwners]
        .sort((left, right) => left.producerId.localeCompare(right.producerId)), expectedOwners))
    {
        throw new Error('GC integration coordination ownership differs from compiled DAG');
    }
    for (const step of original.steps.filter(isAtomicExecutable))
    {
        const { plan } = resolveAtomicReplayPlan(authorities.replayPlans, step.replayPlanRef);
        const context = filesystemInput.context;
        if (plan.run.id !== context.runId || plan.source.commit !== context.sourceState.commit
            || plan.source.worktreeFingerprint !== context.sourceState.worktreeFingerprint)
        {
            throw new Error('GC integration filesystem run/source differs from compiled replay binding');
        }
        if (step.settledDependsOn.includes(gcProducerId))
        {
            throw new Error('GC integration cannot replace settled GC semantics with a hard prerequisite');
        }
    }
    const derivedMatrix = structuredClone(matrix);
    for (const node of derivedMatrix.atomicProducerDeclarations.nodes)
    {
        if (isAtomicExecutable(node) && node.producerId !== gcProducerId)
        {
            node.dependsOn = dependencies(node.dependsOn, node.producerId, ordering);
        }
    }
    const derivedAuthorities = { ...structuredClone(authorities), matrixDigest: digestCanonical(derivedMatrix) };
    const compiledDag = compileAtomicProducerDag(derivedMatrix, derivedAuthorities);
    return sealContentDigest({
        schema: 'fsusblog.physical-producer-gc-atomic-integration.v1',
        qualificationEligible: false,
        executionEligible: false,
        originalCompiledDagDigest: original.contentDigest,
        ordering,
        matrix: derivedMatrix,
        authorities: derivedAuthorities,
        compiledDag
    });
}
