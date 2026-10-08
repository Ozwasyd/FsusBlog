import { URL } from 'node:url';

const { canonicalDigest, deriveReplayStream, validateDiscoveryAgainstPlan, validateReplayPlan } = await import(new URL('../execution-replay-contract.mjs', import.meta.url));
const { deriveRandomConsumerStream, loadRandomStreamInventory, validateRandomExecutionObservation, validateRandomStreamInventory } = await import(new URL('../random-streams.mjs', import.meta.url));
const { sha256, validateExternalAuthorityReferences } = await import(new URL('../attempt-provenance.mjs', import.meta.url));
const { createTemporalContract } = await import(new URL('../temporal-context-contract.mjs', import.meta.url));
const { materializeTemporalEnvironment } = await import(new URL('../temporal-context.mjs', import.meta.url));
const { validateTemporalSourceObservation } = await import(new URL('../temporal-source-observation-contract.mjs', import.meta.url));

function same(actual, expected, label)
{
    if (canonicalDigest(actual) !== canonicalDigest(expected))
    {
        throw new Error(`frontend child ${label} mismatch`);
    }
}

function immutable(value)
{
    if (value && typeof value === 'object')
    {
        Object.values(value).forEach(immutable);
        Object.freeze(value);
    }
    return value;
}

/** Bind original externally verified bytes; source preparation grants no authority. */
export function validateFrontendChildReplayContext(options)
{
    const { context, replayBytes, temporalContextBytes, temporalAuthority, environment, command, testIds } = options;
    if (!context?.attemptId || context.attemptNumber !== 1)
    {
        throw new Error('frontend child requires an explicit first-attempt identity');
    }
    const plan = validateReplayPlan(JSON.parse(replayBytes));
    const temporalContext = createTemporalContract(temporalAuthority)
        .validateTemporalContext(JSON.parse(temporalContextBytes));
    const references = validateExternalAuthorityReferences(options.authorityReferences, options.verifyAuthority, {
        sourceCommit: context.sourceCommit,
        worktreeFingerprint: context.worktreeFingerprint,
        schedulerRunId: context.schedulerRunId,
        producerId: context.producerId
    });
    for (const [kind, bytes] of [['replay-plan', replayBytes], ['temporal-context', temporalContextBytes]])
    {
        same(references.find((reference) => reference.kind === kind).artifactDigest, sha256(bytes), `${kind} bytes`);
    }
    same(plan.source, { commit: context.sourceCommit, worktreeFingerprint: context.worktreeFingerprint }, 'replay source');
    same(plan.run, { id: context.schedulerRunId, mode: 'qualification' }, 'replay run');
    same(plan.producer.id, context.producerId, 'replay producer');
    same(plan.producer.framework, 'vitest', 'replay framework');
    if (plan.shards.length !== 1 || plan.frameworkModes.find((mode) => mode.name === 'retry')?.value !== 'disabled')
    {
        throw new Error('frontend child requires the original unsharded zero-retry framework mode');
    }
    same([plan.command.executable, ...plan.command.args], command, 'command');
    same(plan.command.environmentDigest, canonicalDigest(environment), 'environment');
    validateDiscoveryAgainstPlan(plan, testIds);
    for (const [field, expected] of Object.entries({ sourceCommit: context.sourceCommit,
        sourceFingerprint: context.worktreeFingerprint, schedulerRunId: context.schedulerRunId,
        producerId: context.producerId }))
    {
        same(temporalContext[field], expected, `temporal ${field}`);
    }
    for (const [name, value] of Object.entries(materializeTemporalEnvironment(temporalContext)))
    {
        same(environment[name] ?? null, value, `temporal environment ${name}`);
    }
    return immutable(structuredClone({ context, plan, temporalContext, temporalAuthority, environment,
        references, qualificationEligible: false }));
}

/** Consume a catalog-owner child projection, preserving every existing consumer budget/version. */
export function prepareFrontendChildReplay(options)
{
    const prepared = validateFrontendChildReplayContext(options);
    const producerId = prepared.context.producerId;
    if (!['frontend-property', 'frontend-state-machines'].includes(producerId))
    {
        throw new Error('frontend random replay requires a property or state-machine child');
    }
    const baseline = loadRandomStreamInventory();
    const inventory = options.inventory;
    validateRandomStreamInventory(baseline);
    validateRandomStreamInventory(inventory);
    const property = producerId === 'frontend-property';
    const legacy = property ? baseline.consumers : baseline.nonRandomDeclarations;
    const baselineOwner = legacy.some((consumer) => consumer.producerId === producerId)
        ? producerId : 'frontend-property-model-perf';
    const expected = legacy.filter((consumer) => consumer.producerId === baselineOwner)
        .map((consumer) => ({ ...consumer, producerId,
            ...(property ? { receiptOwner: baselineOwner === producerId ? consumer.receiptOwner : options.receiptOwner } : {}) }));
    if (expected.length === 0 || (property && !options.receiptOwner))
    {
        throw new Error('frontend child requires explicit canonical consumer and receipt ownership');
    }
    const actual = (property ? inventory.consumers : inventory.nonRandomDeclarations)
        .filter((consumer) => consumer.producerId === producerId);
    if (property && actual.some((consumer) => consumer.receiptOwner !== options.receiptOwner))
    {
        throw new Error('frontend child receipt owner differs from its canonical declaration');
    }
    const ordered = (rows) => [...rows].sort((left, right) => left.canonicalTestId.localeCompare(right.canonicalTestId));
    same(ordered(actual), ordered(expected), 'catalog consumer preservation');
    if ((property ? inventory.nonRandomDeclarations : inventory.consumers)
        .some((consumer) => consumer.producerId === producerId))
    {
        throw new Error('frontend child cannot change its random/non-random disposition');
    }
    const declaredIds = new Set(prepared.plan.testEnumerationOrder);
    if (actual.some((consumer) => !declaredIds.has(consumer.canonicalTestId)))
    {
        throw new Error('frontend child replay omits an inventoried consumer');
    }
    const bindings = property ? actual.map((consumer) => ({ consumer,
        stream: deriveRandomConsumerStream({ rootSeed: prepared.plan.rootSeed, consumer }) })) : [];
    const streams = bindings.map(({ consumer }) => deriveReplayStream({ rootSeed: prepared.plan.rootSeed,
        producerId, canonicalTestId: consumer.canonicalTestId, streamId: consumer.streamId }))
        .sort((left, right) => left.streamId.localeCompare(right.streamId));
    same(prepared.plan.randomStreams, streams, 'sealed streams');
    if (property)
    {
        const seeds = Object.fromEntries(bindings.map(({ consumer, stream }) =>
            [`${consumer.canonicalTestId}\u0000${consumer.streamId}`, stream.derivedSeed]));
        same(JSON.parse(prepared.environment.FSUSBLOG_RANDOM_STREAMS_JSON ?? 'null'), seeds, 'stream environment');
        same(prepared.environment.FSUSBLOG_REPLAY_ROOT_SEED ?? null, prepared.plan.rootSeed, 'root-seed environment');
        same(prepared.environment.FSUSBLOG_REPLAY_MODE ?? null, 'qualification', 'replay mode');
    }
    return immutable({ ...prepared, inventoryDigest: canonicalDigest(inventory), bindings: structuredClone(bindings) });
}

/** Validate actual observations without generating receipts or filling missing fields. */
export function validateFrontendChildObservations(prepared, { temporalObservation, randomObservations })
{
    const temporal = validateTemporalSourceObservation({ kind: 'node', context: prepared.temporalContext,
        observation: temporalObservation }, prepared.temporalAuthority);
    if (!Array.isArray(randomObservations)
        || randomObservations.length !== prepared.bindings.length
        || new Set(randomObservations.map((observation) => observation.streamId)).size !== randomObservations.length)
    {
        throw new Error('frontend child requires the exact observed stream roster');
    }
    for (const { consumer, stream } of prepared.bindings)
    {
        validateRandomExecutionObservation(randomObservations.find((observation) => observation.streamId === consumer.streamId), {
            consumer, stream, runId: prepared.context.schedulerRunId,
            attemptId: prepared.context.attemptId, planDigest: prepared.plan.planDigest
        });
    }
    return immutable(structuredClone({ temporal, randomObservations, qualificationEligible: false }));
}
