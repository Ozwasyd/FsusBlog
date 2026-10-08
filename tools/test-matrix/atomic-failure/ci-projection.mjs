import path from 'node:path';

import { admitMaterial, checkGraphMaterial, checkProjectionDigest, currentReference, digestFact, exactFields,
    requireFact, sameFact, sealProjection, stableIds } from './projection-contract.mjs';

/**
 * Consume the canonical #2248 compiler when its exact source capability is
 * installed. CI jobs come from ci-plan's logical tier assignments, not a new
 * job map. Runtime state facts need a separate canonical handoff; they cannot
 * be inferred from a stateAccessRef or considered conflict-free here.
 */
export async function projectCompiledAtomicCiMaterial(input, hostLimits)
{
    const material = admitMaterial(input, hostLimits);
    exactFields(material, ['compiled', 'matrix', 'authorities', 'ciPlan', 'graphRef', 'context', 'selectedIds'],
        'compiled CI consumer input');
    const { verifyCompiledAtomicProducerDag } = await import(new URL('../atomic-producers/compiler.mjs', import.meta.url));
    const compiled = verifyCompiledAtomicProducerDag(material.compiled, material.matrix, material.authorities);
    sameFact(material.graphRef.objectDigest, compiled.contentDigest, 'compiled graph reference digest');
    requireFact(Array.isArray(material.ciPlan.jobs), 'canonical CI plan jobs required');
    const declarations = new Map(material.matrix.atomicProducerDeclarations.nodes.map((node) => [node.producerId, node]));
    const kinds = { 'atomic-producer': 'producer', 'hard-prerequisite': 'hard-prerequisite',
        'settled-join': 'settled-join', 'logical-projection': 'settled-join', 'always-run-finalizer': 'finalizer' };
    const nodes = compiled.steps.map((step) =>
    {
        const owners = material.ciPlan.jobs.filter((job) => Array.isArray(job.tiers) && job.tiers.includes(step.logicalParentId));
        requireFact(owners.length === 1, 'compiled logical parent must have exact-one canonical CI job');
        requireFact(!step.stateAccessRef, 'canonical runtime state-access fact bridge unavailable');
        const declaration = declarations.get(step.id);
        requireFact(kinds[step.kind] && declaration, 'compiled kind/declaration mismatch');
        return { id: step.id, logicalParentId: step.logicalParentId, kind: kinds[step.kind],
            evidenceClass: ['atomic-producer', 'hard-prerequisite'].includes(step.kind) ? declaration.evidenceClass : 'coordination',
            dependsOn: [...step.dependsOn], settledDependsOn: [...step.settledDependsOn], ciJobId: owners[0].id,
            stateAccess: [], exclusiveResources: [...(step.resources.exclusiveResources ?? [])] };
    });
    return projectAtomicCiMaterial({ context: material.context, selectedIds: material.selectedIds,
        graph: { graphRef: material.graphRef, dagDigest: compiled.contentDigest, nodes } }, hostLimits);
}

function terminalReference(reference, repositoryRoot, context)
{
    if (reference === null)
    {
        return null;
    }
    exactFields(reference, ['path', 'contentDigest'], 'original terminal reference');
    requireFact(typeof reference.path === 'string' && path.isAbsolute(reference.path)
        && path.resolve(reference.path) === reference.path, 'canonical absolute original terminal reference required');
    requireFact(typeof reference.contentDigest === 'string' && /^(?:sha256:)?[a-f0-9]{64}$/u.test(reference.contentDigest),
        'original SHA-256 reference digest required');
    const normalized = { path: path.relative(repositoryRoot, reference.path), contentDigest: reference.contentDigest };
    currentReference({ path: normalized.path, objectDigest: reference.contentDigest.startsWith('sha256:')
        ? reference.contentDigest : `sha256:${reference.contentDigest}` }, context, 'original terminal reference');
    return normalized;
}

/**
 * Read-only transport preparation from the original complete terminal vector.
 * Expected-vector equality and digests detect drift, not authentication. Binding
 * targets describe future transport; no receipt file is written or claimed here.
 */
export async function collectCompiledAtomicTerminalMaterial(input, hostLimits)
{
    const material = admitMaterial(input, hostLimits);
    exactFields(material, ['compiled', 'matrix', 'authorities', 'ciPlan', 'graphRef', 'context', 'selectedIds',
        'vector', 'expectedVector', 'terminalVectorRef', 'worktreeFingerprint', 'repositoryRoot'], 'terminal collection input');
    const { compiled, matrix, authorities, ciPlan, graphRef, context, selectedIds, vector } = material;
    const projection = await projectCompiledAtomicCiMaterial({ compiled, matrix, authorities, ciPlan,
        graphRef, context, selectedIds }, hostLimits);
    const { verifyAtomicTerminalVector } = await import(new URL('../atomic-producers/execution.mjs', import.meta.url));
    const { digestCanonical } = await import(new URL('../../test/attempt-provenance.mjs', import.meta.url));
    verifyAtomicTerminalVector(vector, material.expectedVector);
    exactFields(vector, ['schema', 'compiledDagDigest', 'matrixDigest', 'schedulerRunId', 'sourceCommit',
        'worktreeFingerprint', 'qualificationEligible', 'interruption', 'status', 'receipts', 'contentDigest'], 'terminal vector');
    requireFact(vector.schema === 'fsusblog.atomic-producer-terminal-vector.v1'
        && vector.qualificationEligible === false && ['success', 'failed'].includes(vector.status), 'unsupported terminal vector');
    sameFact(vector.compiledDagDigest, compiled.contentDigest, 'terminal compiled identity');
    sameFact(vector.matrixDigest, compiled.matrixDigest, 'terminal matrix identity');
    sameFact(vector.schedulerRunId, context.schedulerRunId, 'terminal run identity');
    sameFact(vector.sourceCommit, context.sourceCommit, 'terminal source identity');
    digestFact(material.worktreeFingerprint, 'terminal worktree fingerprint');
    sameFact(vector.worktreeFingerprint, material.worktreeFingerprint, 'terminal worktree identity');
    requireFact(typeof material.repositoryRoot === 'string' && path.isAbsolute(material.repositoryRoot), 'absolute repository root required');
    currentReference(material.terminalVectorRef, context, 'terminal vector reference');
    sameFact(material.terminalVectorRef.objectDigest, vector.contentDigest, 'terminal vector reference digest');
    requireFact(Array.isArray(vector.receipts), 'complete terminal receipts required');
    sameFact(stableIds(vector.receipts.map((receipt) => receipt.producerId), 'terminal producer IDs'),
        projection.aggregate.expectedProducerIds, 'complete terminal producer set');
    const bindings = new Map(projection.jobs.flatMap((job) => job.receiptBindings).map((binding) => [binding.producerId, binding]));
    requireFact([...bindings.values()].every((binding) => binding.selected), 'partial selection needs canonical not-selected terminal capability');
    const steps = new Map(compiled.steps.map((step) => [step.id, step]));
    const receipts = vector.receipts.map((receipt) =>
    {
        exactFields(receipt, ['schema', 'producerId', 'kind', 'logicalParentId', 'compiledDagDigest', 'schedulerRunId',
            'sourceCommit', 'worktreeFingerprint', 'terminalState', 'reasonCode', 'primaryFailureRefs', 'blockedBy',
            'attemptRef', 'aggregateAttemptRef', 'artifactRefs', 'evidenceRefs', 'schedulerReceiptDigest', 'contentDigest'], 'original terminal receipt');
        const { contentDigest, ...body } = receipt;
        sameFact(contentDigest, digestCanonical(body), 'original terminal receipt digest');
        const step = steps.get(receipt.producerId);
        requireFact(receipt.schema === 'fsusblog.atomic-producer-terminal-receipt.v1'
            && ['success', 'failed', 'timed-out', 'internal-error', 'blocked', 'cancelled'].includes(receipt.terminalState), 'unsupported original terminal receipt');
        for (const field of ['kind', 'logicalParentId'])
        {
            sameFact(receipt[field], step[field], `terminal ${field}`);
        }
        for (const field of ['compiledDagDigest', 'schedulerRunId', 'sourceCommit', 'worktreeFingerprint'])
        {
            sameFact(receipt[field], vector[field], `receipt ${field}`);
        }
        digestFact(receipt.schedulerReceiptDigest, 'original scheduler receipt digest');
        requireFact(typeof receipt.reasonCode === 'string' && /^[a-z][a-z0-9-]*$/u.test(receipt.reasonCode), 'original reason code required');
        for (const field of ['primaryFailureRefs', 'blockedBy'])
        {
            requireFact(stableIds(receipt[field], field).every((id) => steps.has(id)), 'unknown original failure dependency');
        }
        requireFact(Array.isArray(receipt.artifactRefs) && Array.isArray(receipt.evidenceRefs), 'original terminal refs required');
        return { producerId: receipt.producerId, sourceReceiptDigest: contentDigest,
            schedulerReceiptDigest: receipt.schedulerReceiptDigest, terminalState: receipt.terminalState,
            reasonCode: receipt.reasonCode, primaryFailureRefs: receipt.primaryFailureRefs, blockedBy: receipt.blockedBy,
            attemptRef: terminalReference(receipt.attemptRef, material.repositoryRoot, context),
            aggregateAttemptRef: terminalReference(receipt.aggregateAttemptRef, material.repositoryRoot, context),
            artifactRefs: receipt.artifactRefs.map((ref) => terminalReference(ref, material.repositoryRoot, context)),
            evidenceRefs: receipt.evidenceRefs.map((ref) => terminalReference(ref, material.repositoryRoot, context)),
            transportBinding: bindings.get(receipt.producerId) };
    }).sort((a, b) => a.producerId.localeCompare(b.producerId));
    return sealProjection({ schema: 'fsusblog.atomic-terminal-collection-material.v1', context,
        worktreeFingerprint: vector.worktreeFingerprint, compiledDagDigest: compiled.contentDigest,
        ciProjectionDigest: projection.contentDigest, terminalVectorRef: material.terminalVectorRef,
        sourceStatus: vector.status, interrupted: vector.interruption !== null, receipts,
        qualificationEligible: false, terminalAcceptancePending: true, materializedTransport: false });
}

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
