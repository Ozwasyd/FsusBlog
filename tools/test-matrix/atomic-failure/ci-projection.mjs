import path from 'node:path';

import { admitMaterial, checkGraphMaterial, checkProjectionDigest, currentReference, digestFact, exactFields, freezeMaterial,
    requireFact, sameFact, sealProjection, stableIds } from './projection-contract.mjs';

/**
 * Consume the canonical #2248 compiler when its exact source capability is
 * installed. CI jobs come from ci-plan's logical tier assignments, not a new
 * job map. Runtime state facts need a separate canonical handoff; they cannot
 * be inferred from a stateAccessRef or considered conflict-free here.
 */
async function compiledCiGraph(material, runtimeAuthority = null)
{
    const { verifyCompiledAtomicProducerDag } = await import(new URL('../atomic-producers/compiler.mjs', import.meta.url));
    const { resolveAtomicReference } = await import(new URL('../atomic-producers/contract.mjs', import.meta.url));
    const { digestCanonical } = await import(new URL('../../test/attempt-provenance.mjs', import.meta.url));
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
        let stateAccess = [];
        if (runtimeAuthority)
        {
            const entry = runtimeAuthority.steps[step.id];
            requireFact(entry, 'atomic producer missing from canonical runtime state catalog');
            const mutating = new Set(['writes', 'creates', 'deletes', 'invalidates', 'exclusiveStateDomains']
                .flatMap((field) => entry[field] ?? []));
            stateAccess = [...new Set([...(entry.reads ?? []), ...mutating])].sort()
                .map((domain) => ({ domain, mode: mutating.has(domain) ? 'write' : 'read' }));
            if (step.stateAccessRef)
            {
                const source = resolveAtomicReference(material.authorities.stateAccess, step.stateAccessRef, 'runtime state access');
                sameFact(source.catalogDigest, runtimeAuthority.catalogDigest, 'state access canonical catalog binding');
                sameFact(source.catalogEntryDigest, digestCanonical(entry), 'state access canonical entry binding');
            }
            else
            {
                requireFact(stateAccess.length === 0, 'stateful producer requires original stateAccessRef');
            }
        }
        else
        {
            requireFact(!step.stateAccessRef, 'canonical runtime state-access fact bridge unavailable');
        }
        const declaration = declarations.get(step.id);
        requireFact(kinds[step.kind] && declaration, 'compiled kind/declaration mismatch');
        return { id: step.id, logicalParentId: step.logicalParentId, kind: kinds[step.kind],
            evidenceClass: ['atomic-producer', 'hard-prerequisite'].includes(step.kind) ? declaration.evidenceClass : 'coordination',
            dependsOn: [...step.dependsOn], settledDependsOn: [...step.settledDependsOn], ciJobId: owners[0].id,
            stateAccess, exclusiveResources: [...(step.resources.exclusiveResources ?? [])] };
    });
    return { graphRef: material.graphRef, dagDigest: compiled.contentDigest, nodes };
}

const compiledCiFields = ['compiled', 'matrix', 'authorities', 'ciPlan', 'graphRef', 'context', 'selectedIds'];

async function originalLaneCompilation(lane, frontendContexts)
{
    if (lane.kind === 'backend')
    {
        exactFields(lane.options, [], 'backend lane options');
        const { compileBackendAtomicBridge } = await import(new URL('../../test/backend-atomic-bridge.mjs', import.meta.url));
        const binding = compileBackendAtomicBridge(lane.input);
        return { compiled: binding.compiled, binding };
    }
    if (lane.kind === 'static')
    {
        exactFields(lane.options, [], 'static lane options');
        const { bindStaticAtomicCompilation } = await import(new URL('../../test/static-atomic/compiler-bridge.mjs', import.meta.url));
        return bindStaticAtomicCompilation(lane.input);
    }
    if (lane.kind === 'frontend')
    {
        exactFields(lane.options, [], 'frontend lane options');
        exactFields(lane.input, ['compiled', 'matrix', 'authorities', 'groupId'], 'frontend lane source');
        const { prepareFrontendManifestAdmission } = await import(new URL('../../test/frontend-atomic/manifest-admission.mjs', import.meta.url));
        requireFact(frontendContexts?.[lane.id], 'original frontend current-run admission context required');
        const binding = prepareFrontendManifestAdmission(lane.input.compiled,
            { ...frontendContexts[lane.id], ...lane.input });
        return { compiled: lane.input.compiled, binding };
    }
    if (lane.kind === 'public-runtime')
    {
        const { compilePublicRuntimeProducerDag } = await import(new URL('../../test/public-runtime-producers/compiler-adapter.mjs', import.meta.url));
        const binding = compilePublicRuntimeProducerDag(lane.input, lane.options);
        return { compiled: binding.compiled, binding };
    }
    if (lane.kind === 'coverage')
    {
        exactFields(lane.options, [], 'coverage lane options');
        exactFields(lane.input, ['root', 'plan', 'requests', 'matrix', 'authorities'], 'coverage lane source');
        const { compileCoverageProducerDag } = await import(new URL('../../coverage/atomic-coverage-compiler-bridge.mjs', import.meta.url));
        return { compiled: compileCoverageProducerDag(lane.input),
            binding: { plan: lane.input.plan, requests: lane.input.requests } };
    }
    throw new Error('atomic failure projection: original lane compiler capability unavailable');
}

function originalLaneStepIds(lane, original)
{
    if (lane.kind === 'coverage')
    {
        return [...lane.input.plan.producers, ...lane.input.plan.projections].map((entry) => entry.id);
    }
    if (lane.kind === 'static')
    {
        return [...new Set([...original.binding.projectionIds,
            ...original.binding.producerBindings.flatMap((binding) => [binding.producerId, ...binding.dependsOn])])];
    }
    if (lane.kind === 'public-runtime')
    {
        return [...lane.input.declarations.nodes.map((node) => node.id), ...lane.input.declarations.externalDependencies];
    }
    return original.compiled.steps.filter((step) => step.kind !== 'always-run-finalizer').map((step) => step.id);
}

/** Prepare available original lane ports without launching or granting runtime authority. */
export async function prepareCanonicalAtomicCiGroup(input, hostLimits, options)
{
    const material = admitMaterial(input, hostLimits);
    sameFact(options.context.schedulerRunId, material.context.schedulerRunId, 'canonical execution run');
    sameFact(options.context.sourceCommit, material.context.sourceCommit, 'canonical execution source');
    sameFact(options.context.worktreeFingerprint, material.worktreeFingerprint, 'canonical execution worktree');
    const frontendContexts = Object.fromEntries(material.lanes.filter((lane) => lane.kind === 'frontend')
        .map((lane) => [lane.id, { context: options.context, producerContexts: options.producerContexts }]));
    const ciMaterial = await projectCanonicalLaneAtomicCiMaterial(material, hostLimits, frontendContexts);
    const producerContexts = { ...options.producerContexts };
    const pendingLanes = [];
    const lanePreparations = [];
    for (const lane of material.lanes)
    {
        if (lane.kind === 'frontend')
        {
            lanePreparations.push({ id: lane.id, kind: lane.kind, status: 'original-admission-complete' });
        }
        else if (lane.kind === 'coverage')
        {
            const { validateCoverageExecutionRequest } = await import(new URL('../../coverage/atomic-coverage-compiler-bridge.mjs', import.meta.url));
            const { prepareCoverageProducer } = await import(new URL('../../coverage/atomic-coverage-inputs.mjs', import.meta.url));
            const { loadCoverageAttemptMaterial } = await import(new URL('../../coverage/atomic-coverage-command.mjs', import.meta.url));
            const { readCoverageBytes } = await import(new URL('../../coverage/atomic-coverage-plan.mjs', import.meta.url));
            const { digestCanonical, sha256 } = await import(new URL('../../test/attempt-provenance.mjs', import.meta.url));
            const { root, plan, requests } = lane.input;
            sameFact(plan.identity, { runId: options.context.schedulerRunId, sourceCommit: options.context.sourceCommit,
                sourceFingerprint: options.context.worktreeFingerprint }, 'coverage current execution identity');
            const owners = new Map();
            for (const producer of plan.producers)
            {
                const supplied = producerContexts[producer.id];
                requireFact(supplied && typeof supplied.verifyAuthority === 'function', 'original coverage producer context required');
                for (const reference of supplied.authorityReferences)
                {
                    owners.set(digestCanonical(reference), supplied.verifyAuthority);
                }
            }
            const verifyAuthority = (reference) => owners.get(digestCanonical(reference))?.(reference);
            for (const producer of plan.producers)
            {
                const step = material.compiled.steps.find((entry) => entry.id === producer.id);
                const item = requests.find((entry) => entry.request.producerId === producer.id);
                sameFact(path.resolve(root, item.request.evidenceRoot), options.context.evidenceRoot, 'coverage evidence root');
                const supplied = producerContexts[producer.id];
                const prior = supplied.requiredInputAdmission;
                if (prior !== undefined)
                {
                    exactFields(prior, ['inputClosureRef', 'validate'], 'held coverage input admission');
                    requireFact(typeof prior.validate === 'function', 'held coverage input validator required');
                    sameFact(prior.inputClosureRef, step.inputClosureRef, 'held coverage input closure');
                }
                producerContexts[producer.id] = { ...supplied, requiredInputAdmission: {
                    inputClosureRef: step.inputClosureRef,
                    validate: async (ready) =>
                    {
                        await prior?.validate(ready);
                        validateCoverageExecutionRequest(item.request, root);
                        sameFact(sha256(readCoverageBytes(root, item.request.requestPath)), sha256(item.bytes), 'coverage request bytes at admission');
                        const inputs = Object.fromEntries(producer.dependsOn.map((id) =>
                            [id, loadCoverageAttemptMaterial(root, item.request, id)]));
                        prepareCoverageProducer({ root, plan, producerId: producer.id, inputs, verifyAuthority });
                    }
                } };
            }
            lanePreparations.push({ id: lane.id, kind: lane.kind, status: 'original-input-admission-installed' });
        }
        else if (lane.kind === 'public-runtime')
        {
            const { preparePublicRuntimeAttemptContexts } = await import(new URL('../../test/public-runtime-producers/compiler-adapter.mjs', import.meta.url));
            const supplied = options.publicRuntimeContexts?.[lane.id];
            requireFact(supplied, 'original public runtime preparation context required');
            const binding = ciMaterial.laneBindings.find((entry) => entry.id === lane.id).originalBinding;
            const preparation = preparePublicRuntimeAttemptContexts(binding, lane.input,
                { ...supplied, context: options.context, producerContexts }, lane.options);
            lanePreparations.push({ id: lane.id, kind: lane.kind, preparation });
            pendingLanes.push({ id: lane.id, kind: lane.kind, reason: 'original-runtime-admission-and-reset-postflight-required' });
        }
        else
        {
            pendingLanes.push({ id: lane.id, kind: lane.kind, reason: 'original-prepare-only-port-unavailable' });
        }
    }
    return { compiled: material.compiled, selectedIds: material.selectedIds, ciMaterial, lanePreparations, pendingLanes,
        executionOptions: { ...options, matrix: material.matrix, authorities: material.authorities, producerContexts } };
}

/** Dispatch one complete canonical runner group; preserve the original error and full vector. */
export async function executeCanonicalAtomicCiGroup(input, hostLimits, options)
{
    const prepared = await prepareCanonicalAtomicCiGroup(input, hostLimits, options);
    requireFact(prepared.pendingLanes.length === 0, 'original lane execution preparation remains pending');
    requireFact(prepared.ciMaterial.completeSourceCoverage, 'canonical execution has unconsumed producers');
    requireFact(prepared.ciMaterial.ciProjection?.jobs.length === 1, 'original job-scoped execution capability unavailable');
    sameFact([...prepared.selectedIds].sort(), prepared.compiled.steps.map((step) => step.id).sort(),
        'original full-selection execution capability');
    const { executeCompiledAtomicProducerDag } = await import(new URL('../atomic-producers/execution.mjs', import.meta.url));
    const terminalVector = await executeCompiledAtomicProducerDag(prepared.compiled, prepared.executionOptions);
    return { ciMaterial: prepared.ciMaterial, terminalVector };
}

/**
 * Consume original lane admissions and bind every physical step to the sole
 * owner-supplied whole graph. Never execute lane wrappers or combine matrices.
 * Frontend host contexts are passed only to its original admission API; they
 * cannot promote this always-DATA_ONLY source projection to runtime evidence.
 */
export async function projectCanonicalLaneAtomicCiMaterial(input, hostLimits, frontendContexts = {})
{
    const material = admitMaterial(input, hostLimits);
    const hasState = Object.hasOwn(material, 'runtimeAuthority');
    exactFields(material, [...compiledCiFields, 'worktreeFingerprint', 'lanes',
        ...(hasState ? ['runtimeAuthority'] : [])], 'canonical lane CI input');
    digestFact(material.worktreeFingerprint, 'canonical lane worktree fingerprint');
    const { verifyCompiledAtomicProducerDag } = await import(new URL('../atomic-producers/compiler.mjs', import.meta.url));
    const { isAtomicExecutable, resolveAtomicReplayPlan } = await import(new URL('../atomic-producers/contract.mjs', import.meta.url));
    const { digestCanonical } = await import(new URL('../../test/attempt-provenance.mjs', import.meta.url));
    const compiled = verifyCompiledAtomicProducerDag(material.compiled, material.matrix, material.authorities);
    sameFact(material.graphRef.objectDigest, compiled.contentDigest, 'canonical lane graph reference');
    currentReference(material.graphRef, material.context, 'canonical lane graph reference');
    requireFact(Array.isArray(material.lanes) && material.lanes.length > 0, 'original lane sources required');
    stableIds(material.lanes.map((lane) => lane.id), 'lane source IDs');
    const byId = new Map(compiled.steps.map((step) => [step.id, step]));
    const claims = new Map();
    const laneBindings = [];
    for (const lane of material.lanes)
    {
        exactFields(lane, ['id', 'kind', 'input', 'options'], 'original lane source');
        const original = await originalLaneCompilation(lane, frontendContexts);
        const originalById = new Map(original.compiled.steps.map((step) => [step.id, step]));
        const ownedIds = originalLaneStepIds(lane, original);
        for (const id of ownedIds)
        {
            const step = originalById.get(id);
            requireFact(step, 'original lane binding references a missing compiled producer');
            requireFact(byId.has(step.id), `original lane producer absent from canonical matrix: ${step.id}`);
            sameFact(byId.get(step.id), step, `original lane step ${step.id}`);
            const consumers = claims.get(step.id) ?? [];
            requireFact(consumers.length === 0 || step.kind !== 'atomic-producer',
                `multiple lane executable/projection owners: ${step.id}`);
            consumers.push(lane.id);
            claims.set(step.id, consumers);
        }
        laneBindings.push({ id: lane.id, kind: lane.kind,
            originalBindingDigest: original.binding.contentDigest ?? digestCanonical(original.binding),
            compiledFragmentDigest: original.compiled.contentDigest,
            producerIds: ownedIds.filter((id) => isAtomicExecutable(originalById.get(id))).sort(),
            originalBinding: original.binding, runtimeAuthorityStatus: original.binding.runtimeAuthorityStatus ?? 'unverified' });
    }
    for (const step of compiled.steps.filter(isAtomicExecutable))
    {
        const replay = resolveAtomicReplayPlan(material.authorities.replayPlans, step.replayPlanRef).plan;
        sameFact(replay.source, { commit: material.context.sourceCommit, worktreeFingerprint: material.worktreeFingerprint },
            `canonical lane replay source ${step.id}`);
        sameFact(replay.run.id, material.context.schedulerRunId, `canonical lane replay run ${step.id}`);
    }
    const unconsumedProducerIds = compiled.steps.filter(isAtomicExecutable).filter((step) => !claims.has(step.id))
        .map((step) => step.id).sort();
    const runtimeStatePendingProducerIds = hasState ? [] : compiled.steps.filter((step) => step.stateAccessRef)
        .map((step) => step.id).sort();
    const ciInput = Object.fromEntries(compiledCiFields.map((field) => [field, material[field]]));
    const ciProjection = runtimeStatePendingProducerIds.length ? null
        : hasState ? (await projectCompiledAtomicRuntimeCiMaterial({ ...ciInput, runtimeAuthority: material.runtimeAuthority }, hostLimits)).ciProjection
            : await projectCompiledAtomicCiMaterial(ciInput, hostLimits);
    return sealProjection({ schema: 'fsusblog.canonical-lane-atomic-ci-material.v1', context: material.context,
        worktreeFingerprint: material.worktreeFingerprint, compiledDagDigest: compiled.contentDigest,
        graphRef: material.graphRef, ciProjection, laneBindings: laneBindings.sort((a, b) => a.id.localeCompare(b.id)),
        unconsumedProducerIds, completeSourceCoverage: unconsumedProducerIds.length === 0,
        runtimeStatePendingProducerIds, executableAdmissionPending: true,
        canonicalExecutionOwner: 'executeCompiledAtomicProducerDag', qualificationEligible: false });
}

export async function projectCompiledAtomicCiMaterial(input, hostLimits)
{
    const material = admitMaterial(input, hostLimits);
    exactFields(material, compiledCiFields, 'compiled CI consumer input');
    return projectAtomicCiMaterial({ context: material.context, selectedIds: material.selectedIds,
        graph: await compiledCiGraph(material) }, hostLimits);
}

async function runtimeCiBinding(material, hostLimits)
{
    const { digestCanonical } = await import(new URL('../../test/attempt-provenance.mjs', import.meta.url));
    const { createStateConflictPolicy } = await import(new URL('../../test-runtime/state-conflict.mjs', import.meta.url));
    const authority = material.runtimeAuthority;
    requireFact(authority.catalog.schema === 'fsusblog.runtime-state-domain-catalog.v1'
        && authority.registry.schema === 'fsusblog.runtime-state-domain-registry.v1', 'original runtime state schemas required');
    sameFact(authority.catalogDigest, digestCanonical(authority.catalog), 'runtime catalog digest');
    sameFact(authority.registryDigest, digestCanonical(authority.registry), 'runtime registry digest');
    requireFact(Array.isArray(authority.catalog.steps), 'original runtime catalog steps required');
    sameFact(authority.steps, Object.fromEntries(authority.catalog.steps.map((entry) => [entry.stepId, entry])), 'runtime catalog step facts');
    requireFact(new Set(authority.catalog.steps.map((entry) => entry.stepId)).size === authority.catalog.steps.length,
        'duplicate runtime catalog step');
    requireFact(Array.isArray(authority.registry.domains), 'canonical state domain registry required');
    const domains = new Set(authority.registry.domains);
    for (const entry of authority.catalog.steps)
    {
        requireFact(['none', 'declared'].includes(entry.stateAccess), 'closed original state-access kind required');
        for (const field of ['reads', 'writes', 'creates', 'deletes', 'invalidates', 'exclusiveStateDomains'])
        {
            const values = entry[field] ?? (entry.stateAccess === 'none' ? [] : null);
            requireFact(Array.isArray(values) && new Set(values).size === values.length
                && values.every((domain) => domains.has(domain)), 'canonical state operation domains required');
            requireFact(entry.stateAccess !== 'none' || values.length === 0, 'coordination cannot declare runtime state');
        }
    }
    const graph = await compiledCiGraph(material, authority);
    const ciProjection = projectAtomicCiMaterial({ context: material.context, selectedIds: material.selectedIds, graph }, hostLimits);
    const stateConflictPolicy = createStateConflictPolicy(authority);
    const jobs = new Map(ciProjection.jobs.map((job) => [job.id, job]));
    const precedes = (before, after) => jobs.get(after).needs.some((id) => id === before || precedes(before, id));
    const executable = graph.nodes.filter((node) => ['producer', 'hard-prerequisite'].includes(node.kind));
    for (let left = 0; left < executable.length; left += 1)
    {
        for (let right = left + 1; right < executable.length; right += 1)
        {
            const a = executable[left];
            const b = executable[right];
            if (a.ciJobId !== b.ciJobId && !precedes(a.ciJobId, b.ciJobId) && !precedes(b.ciJobId, a.ciJobId))
            {
                requireFact(!stateConflictPolicy.evaluate(a.id, b.id).conflict,
                    `canonical CI planner must co-locate conflicting independent producers: ${a.id}, ${b.id}`);
            }
        }
    }
    const projection = sealProjection({ schema: 'fsusblog.atomic-runtime-ci-projection-material.v1', ciProjection,
        graph, runtimeCatalogDigest: authority.catalogDigest, runtimeRegistryDigest: authority.registryDigest,
        runtimeAcceptancePending: true, qualificationEligible: false });
    return { projection, stateConflictPolicy };
}

/** DATA_ONLY projection from explicit original state facts; this does not authenticate supplied facts. */
export async function projectCompiledAtomicRuntimeCiMaterial(input, hostLimits)
{
    const material = admitMaterial(input, hostLimits);
    exactFields(material, [...compiledCiFields, 'runtimeAuthority'], 'runtime CI projection input');
    return (await runtimeCiBinding(material, hostLimits)).projection;
}

/**
 * Load the original validated state catalog and canonical scheduler readback.
 * The returned original conflict policy can be passed to the original executor;
 * resource capacity, finalizers, admission and receipts remain with their owners.
 */
export async function createCompiledAtomicRuntimeCiBinding(input, hostLimits)
{
    const material = admitMaterial(input, hostLimits);
    exactFields(material, [...compiledCiFields, 'repositoryRoot', 'runtimeCatalogPath', 'checkpointRef',
        'worktreeFingerprint'], 'runtime CI binding input');
    requireFact(typeof material.repositoryRoot === 'string' && path.isAbsolute(material.repositoryRoot), 'absolute repository root required');
    digestFact(material.worktreeFingerprint, 'runtime worktree fingerprint');
    const { loadRuntimeStateAuthority, assertRuntimeAuthorityUnchanged } = await import(new URL('../../test-runtime/catalog.mjs', import.meta.url));
    const { verifyCompiledAtomicProducerDag } = await import(new URL('../atomic-producers/compiler.mjs', import.meta.url));
    const { readCanonicalSchedulerCheckpoint } = await import(new URL('../scheduler.mjs', import.meta.url));
    const compiled = verifyCompiledAtomicProducerDag(material.compiled, material.matrix, material.authorities);
    sameFact(stableIds(material.selectedIds, 'runtime selected producers'), stableIds(compiled.steps.map((step) => step.id),
        'compiled runtime producers'), 'canonical runtime executor selection capability');
    const commandRepositoryRoot = path.resolve(import.meta.dirname, '../../..');
    const steps = compiled.steps.map((step) => ({ id: step.id, dependsOn: step.dependsOn, resources: step.resources,
        command: (step.command ?? []).map((argument) =>
        {
            const value = path.isAbsolute(argument) && argument.startsWith(`${commandRepositoryRoot}${path.sep}`)
                ? path.relative(commandRepositoryRoot, argument) : argument;
            requireFact(!/[\s;&|`$"'<>]/u.test(value), 'runtime catalog needs an original structured argv analyzer for this command');
            return value;
        }).join(' ') }));
    const catalogOptions = { steps };
    if (material.runtimeCatalogPath !== null)
    {
        requireFact(typeof material.runtimeCatalogPath === 'string' && path.isAbsolute(material.runtimeCatalogPath), 'absolute runtime catalog path required');
        catalogOptions.catalogPath = material.runtimeCatalogPath;
    }
    const runtimeAuthority = freezeMaterial(admitMaterial(loadRuntimeStateAuthority(catalogOptions), hostLimits));
    currentReference(material.checkpointRef, material.context, 'canonical scheduler checkpoint');
    requireFact(material.checkpointRef.path === `.tmp/test-runs/${material.context.schedulerRunId}/checkpoint.json`,
        'explicit canonical checkpoint path required');
    const canonical = readCanonicalSchedulerCheckpoint(path.join(material.repositoryRoot, material.checkpointRef.path));
    requireFact(canonical, 'canonical scheduler checkpoint unavailable');
    sameFact(canonical.checkpointDigest, material.checkpointRef.objectDigest, 'canonical scheduler checkpoint digest');
    sameFact(canonical.checkpoint.runId, material.context.schedulerRunId, 'canonical scheduler run');
    sameFact(canonical.checkpoint.sourceState.commit, material.context.sourceCommit, 'canonical scheduler source');
    sameFact(canonical.checkpoint.sourceState.worktreeFingerprint, material.worktreeFingerprint, 'canonical scheduler worktree');
    requireFact(canonical.checkpoint.status === 'running', 'canonical scheduler must be running before runtime binding');
    const binding = await runtimeCiBinding({ ...material, runtimeAuthority }, hostLimits);
    const originalPolicy = binding.stateConflictPolicy;
    const assertCurrent = () =>
    {
        assertRuntimeAuthorityUnchanged(runtimeAuthority, catalogOptions);
        sameFact(loadRuntimeStateAuthority(catalogOptions).registryDigest, runtimeAuthority.registryDigest, 'current runtime state registry');
        const current = readCanonicalSchedulerCheckpoint(path.join(material.repositoryRoot, material.checkpointRef.path));
        requireFact(current && current.checkpoint.runId === material.context.schedulerRunId
            && current.checkpoint.sourceState.commit === material.context.sourceCommit
            && current.checkpoint.sourceState.worktreeFingerprint === material.worktreeFingerprint
            && current.checkpoint.status === 'running',
        'canonical scheduler runtime binding drifted');
    };
    return Object.freeze({ projection: binding.projection,
        runtimeAuthority,
        checkpointBinding: Object.freeze({ checkpointRef: material.checkpointRef, revision: canonical.checkpoint.revision,
            lastSequence: canonical.lastSequence }),
        stateConflictPolicy: Object.freeze({ ...originalPolicy, assertCurrent }) });
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
        'vector', 'expectedVector', 'terminalVectorRef', 'worktreeFingerprint', 'repositoryRoot',
        ...(Object.hasOwn(material, 'runtimeAuthority') ? ['runtimeAuthority'] : [])], 'terminal collection input');
    const { compiled, matrix, authorities, ciPlan, graphRef, context, selectedIds, vector } = material;
    const ciInput = { compiled, matrix, authorities, ciPlan, graphRef, context, selectedIds };
    const projection = Object.hasOwn(material, 'runtimeAuthority')
        ? (await runtimeCiBinding({ ...ciInput, runtimeAuthority: material.runtimeAuthority }, hostLimits)).projection.ciProjection
        : await projectCompiledAtomicCiMaterial(ciInput, hostLimits);
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

/** Index the same complete vector by original lane memberships, without another execution or receipt writer. */
export async function collectCanonicalLaneAtomicTerminalMaterial(input, hostLimits, frontendContexts = {})
{
    const material = admitMaterial(input, hostLimits);
    const runtimeFields = Object.hasOwn(material, 'runtimeAuthority') ? ['runtimeAuthority'] : [];
    const laneFields = [...compiledCiFields, 'worktreeFingerprint', 'lanes', ...runtimeFields];
    const terminalFields = [...compiledCiFields, 'vector', 'expectedVector', 'terminalVectorRef',
        'worktreeFingerprint', 'repositoryRoot', ...runtimeFields];
    exactFields(material, [...new Set([...laneFields, ...terminalFields])], 'canonical lane terminal input');
    const laneInput = Object.fromEntries(laneFields.map((field) => [field, material[field]]));
    const terminalInput = Object.fromEntries(terminalFields.map((field) => [field, material[field]]));
    const ciMaterial = await projectCanonicalLaneAtomicCiMaterial(laneInput, hostLimits, frontendContexts);
    const terminalCollection = await collectCompiledAtomicTerminalMaterial(terminalInput, hostLimits);
    sameFact(terminalCollection.ciProjectionDigest, ciMaterial.ciProjection.contentDigest, 'lane terminal CI projection');
    const receipts = new Map(terminalCollection.receipts.map((receipt) => [receipt.producerId, receipt]));
    const laneCollections = ciMaterial.laneBindings.map((binding) =>
    {
        const members = binding.producerIds.map((id) => receipts.get(id));
        requireFact(members.every(Boolean), 'original lane terminal member missing');
        const terminalStates = Object.fromEntries(['success', 'failed', 'timed-out', 'internal-error', 'blocked', 'cancelled']
            .map((state) => [state, members.filter((receipt) => receipt.terminalState === state).map((receipt) => receipt.producerId)]));
        return { id: binding.id, kind: binding.kind, originalBindingDigest: binding.originalBindingDigest,
            producerIds: binding.producerIds,
            receiptReferences: members.map((receipt) => ({ producerId: receipt.producerId,
                sourceReceiptDigest: receipt.sourceReceiptDigest })), terminalStates,
            primaryFailureRefs: [...new Set(members.flatMap((receipt) => receipt.primaryFailureRefs))].sort(),
            blockedBy: [...new Set(members.flatMap((receipt) => receipt.blockedBy))].sort() };
    });
    return sealProjection({ schema: 'fsusblog.canonical-lane-atomic-terminal-material.v1', context: material.context,
        compiledDagDigest: terminalCollection.compiledDagDigest, ciMaterialDigest: ciMaterial.contentDigest,
        terminalCollection, laneCollections, unconsumedProducerIds: ciMaterial.unconsumedProducerIds,
        completeSourceCoverage: ciMaterial.completeSourceCoverage, qualificationEligible: false,
        terminalAcceptancePending: true, materializedTransport: false });
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
