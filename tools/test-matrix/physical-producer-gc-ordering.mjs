import path from 'node:path';

import { verifyPhysicalProducerFilesystemPlan } from './physical-producer-filesystem.mjs';
import { productionDiskDemandDigest } from './production-disk-demand.mjs';

export const physicalProducerGcOrderingSchema = 'fsusblog.physical-producer-gc-ordering.v1';
const mutationModes = new Set(['create', 'write', 'replace', 'delete']);

function contains(root, candidate)
{
    const relative = path.relative(root, candidate);
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function overlaps(left, right)
{
    return left.filesystemIdentity === right.filesystemIdentity
        && (contains(left.filesystemPath, right.filesystemPath) || contains(right.filesystemPath, left.filesystemPath));
}

/**
 * Derive read/write/delete conflicts from a freshly reobserved access catalog.
 * This pure compiler is intended for the canonical planner, not as a scheduler
 * or deletion authority. Keep the collector's protected-root policy and the
 * existing reservation.guardProducer gate before GC and every producer spawn.
 */
export function compilePhysicalProducerGcOrdering({ filesystemPlan, filesystemInput, gcProducerId })
{
    const current = verifyPhysicalProducerFilesystemPlan(filesystemPlan, filesystemInput);
    const gc = current.producers.find((producer) => producer.producerId === gcProducerId);
    if (!gc || !gc.resolvedRoots.some((access) => mutationModes.has(access.accessMode)))
    {
        throw new Error('GC ordering requires an explicitly declared executable mutation owner');
    }
    const edges = [];
    for (const producer of current.producers)
    {
        if (producer.producerId === gcProducerId)
        {
            continue;
        }
        for (const access of producer.resolvedRoots)
        {
            for (const mutation of gc.resolvedRoots)
            {
                if (!overlaps(access, mutation)
                    || (!mutationModes.has(access.accessMode) && !mutationModes.has(mutation.accessMode)))
                {
                    continue;
                }
                edges.push({
                    dependentProducer: producer.producerId,
                    predecessorProducer: gcProducerId,
                    rootId: access.rootId,
                    domainId: access.domainId,
                    resolvedRoot: access.resolvedRoot,
                    filesystemIdentity: access.filesystemIdentity,
                    filesystemPath: access.filesystemPath,
                    accessMode: access.accessMode,
                    gcMutation: {
                        rootId: mutation.rootId,
                        domainId: mutation.domainId,
                        resolvedRoot: mutation.resolvedRoot,
                        filesystemPath: mutation.filesystemPath,
                        accessMode: mutation.accessMode
                    },
                    orderingReason: mutationModes.has(mutation.accessMode)
                        ? 'GC mutation overlaps producer access on the same resolved filesystem'
                        : 'producer mutation overlaps GC observation on the same resolved filesystem'
                });
            }
        }
    }
    edges.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    const plan = {
        schema: physicalProducerGcOrderingSchema,
        qualificationEligible: false,
        executionEligible: false,
        context: current.context,
        catalogDigest: current.catalogDigest,
        filesystemPlanDigest: current.planDigest,
        gcProducerId,
        edges,
        dependentProducerIds: [...new Set(edges.map((edge) => edge.dependentProducer))].sort(),
        independentProducerIds: current.producers.map((producer) => producer.producerId)
            .filter((producerId) => producerId !== gcProducerId && !edges.some((edge) => edge.dependentProducer === producerId))
            .sort()
    };
    return { ...plan, planDigest: productionDiskDemandDigest(plan) };
}
