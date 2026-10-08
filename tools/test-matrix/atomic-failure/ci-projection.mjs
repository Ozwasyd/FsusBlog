import { admitMaterial, checkGraphMaterial, checkProjectionDigest, currentReference, exactFields,
    requireFact, sameFact, sealProjection, stableIds } from './projection-contract.mjs';

/**
 * Derive a non-executable CI transport/job projection from explicit compiled facts.
 * Job dependencies settle even on failure: the canonical invocation must decide
 * hard blocked propagation from receipts, avoiding GitHub's job-wide skip cascade.
 */
export function projectAtomicCiMaterial(input, hostLimits)
{
    const material = admitMaterial(input, hostLimits);
    exactFields(material, ['context', 'graph', 'selectedIds'], 'CI projection input');
    const { context, graph } = material;
    exactFields(context, ['schedulerRunId', 'attemptId', 'sourceCommit'], 'CI projection context');
    requireFact(/^[a-z0-9][a-z0-9-]*$/u.test(context.schedulerRunId)
        && /^[a-z0-9][a-z0-9-]*$/u.test(context.attemptId) && /^[a-f0-9]{40}$/u.test(context.sourceCommit), 'invalid run/source/attempt');
    checkGraphMaterial(graph);
    currentReference(graph.graphRef, context, 'compiled graph');
    const selected = new Set(stableIds(material.selectedIds, 'selected producers'));
    requireFact([...selected].every((id) => graph.nodes.some((node) => node.id === id)), 'unknown selected producer');
    for (const node of graph.nodes.filter((entry) => selected.has(entry.id)))
    {
        requireFact([...node.dependsOn, ...node.settledDependsOn].every((id) => selected.has(id)),
            'selected producer is missing a prerequisite');
    }
    const jobs = new Map();
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    for (const node of graph.nodes)
    {
        const job = jobs.get(node.ciJobId) ?? { id: node.ciJobId, producerIds: [], needs: new Set(),
            receiptBindings: [], invocationCount: 1, invocationOwner: 'canonical-atomic-dag',
            condition: 'always()', failFast: false };
        job.producerIds.push(node.id);
        for (const id of [...node.dependsOn, ...node.settledDependsOn])
        {
            if (byId.get(id).ciJobId !== job.id)
            {
                job.needs.add(byId.get(id).ciJobId);
            }
        }
        const artifactName = `atomic-${context.schedulerRunId}-${context.attemptId}-${node.id}`;
        job.receiptBindings.push({ producerId: node.id, selected: selected.has(node.id), artifactName,
            path: `.tmp/test-runs/${context.schedulerRunId}/atomic/${context.attemptId}/${node.id}/terminal.json` });
        jobs.set(job.id, job);
    }
    const resultJobs = [...jobs.values()].map((job) => ({ ...job, producerIds: job.producerIds.sort(),
        needs: [...job.needs].sort(), receiptBindings: job.receiptBindings.sort((a, b) => a.producerId.localeCompare(b.producerId)) }))
        .sort((a, b) => a.id.localeCompare(b.id));
    // Contraction into jobs can create a cycle even when the producer DAG is valid.
    const remaining = new Set(resultJobs.map((job) => job.id));
    while (remaining.size)
    {
        const ready = resultJobs.filter((job) => remaining.has(job.id) && job.needs.every((id) => !remaining.has(id)));
        requireFact(ready.length > 0, 'CI job contraction creates a dependency cycle');
        ready.forEach((job) => remaining.delete(job.id));
    }
    return sealProjection({ schema: 'fsusblog.atomic-ci-projection-material.v1', context, graphRef: graph.graphRef,
        dagDigest: graph.dagDigest, jobs: resultJobs,
        aggregate: { condition: 'always()', expectedProducerIds: graph.nodes.map((node) => node.id).sort(),
            conclusionOwner: 'verified-semantic-aggregate', receiptRequired: true,
            jobStatusIsEvidence: false, missingReceiptIsSuccess: false } });
}

/** Compare actual extracted workflow facts, never accepting a caller's job status as evidence. */
export function checkAtomicWorkflowMaterial(projection, workflowFacts, hostLimits)
{
    const input = admitMaterial({ projection, workflowFacts }, hostLimits);
    checkProjectionDigest(input.projection);
    sameFact(input.workflowFacts, { dagDigest: input.projection.dagDigest,
        jobs: input.projection.jobs, aggregate: input.projection.aggregate }, 'workflow graph/receipt topology');
    return true;
}
