/**
 * Unique FixtureOrchestrator (#1709 + #1710 receipts).
 *
 * Public surface:
 *   plan(profileIdentity, executionIdentity)
 *   prepare(plan, injectedPorts, signal) → prepare-state (not verified evidence)
 *   verify(prepareState, injectedVerifiers) → FixtureReceipt (verified or fail)
 *   cleanup(stateOrReceipt, injectedPorts, signal)
 *
 * Orchestrator reads only #1707 catalog authority (+ #1708 sealed digests).
 * It does not parse business SQL, open Docker/PostgreSQL/Redis, or import browser tests.
 * FixtureReceipt / ProducerReceipt authority lives in ./receipt/ (#1710).
 */

const { semanticOutcomeDigest, verifyTemporalReplay } = await import(new URL("../test/temporal-context.mjs", import.meta.url));
const { bindCorrectnessProducerTemporalArtifacts, resolveCorrectnessProducerTemporalContext } = await import(new URL("../test/temporal-producer-bindings.mjs", import.meta.url));
const { buildFixtureVariantPlan, buildProducerFixtureVariantPlan, fixtureCatalogDigest, planFixtureMutation, readFixtureCatalogs, resolveFixtureProfile, validateFixtureVariantEvidence } = await import(new URL("../testing/fixture-catalog.mjs", import.meta.url));

import { buildProducerDag, reverseTopo } from './dag.mjs';
import { createProducerContext, indexProducerPorts, requireProducerPorts } from './producer-port.mjs';
import {
    aggregateVerifiedFixtureReceipt,
    assertProfilePostconditionsBound,
    buildProducerReceipt,
    buildTerminalFailureReceipt,
    FIXTURE_PREPARE_STATE_SCHEMA,
    FIXTURE_RECEIPT_SCHEMA,
    validateFixtureReceipt,
    verifyCapabilityPostconditions
} from './receipt/index.mjs';
import { createTerminalState } from './terminal-state.mjs';

export { buildProducerDag } from './dag.mjs';
export { createTerminalState, FIXTURE_TERMINAL_STATES } from './terminal-state.mjs';
export { normalizeProducerPort, createProducerContext } from './producer-port.mjs';
export {
    FIXTURE_RECEIPT_SCHEMA,
    PRODUCER_RECEIPT_SCHEMA,
    FIXTURE_PREPARE_STATE_SCHEMA
} from './receipt/index.mjs';

function throwIfAborted(signal)
{
    if (signal?.aborted)
    {
        const reason = signal.reason instanceof Error ? signal.reason : new Error('fixture orchestration aborted');
        throw reason;
    }
}

function serializeError(error)
{
    if (!error)
    {
        return null;
    }
    const serialized = {
        name: error instanceof Error ? error.name : 'Error',
        message: error instanceof Error ? error.message : String(error)
    };
    const cause = error instanceof Error ? error.cause : undefined;
    if (cause !== undefined && cause !== null)
    {
        serialized.cause = cause instanceof Error
            ? serializeError(cause)
            : JSON.parse(JSON.stringify(cause));
    }
    return serialized;
}

function temporalContextForProducer(planDocument, producerId)
{
    if (!process.env.FSUSBLOG_TEMPORAL_CONTEXT_JSON
      && !process.env.FSUSBLOG_TEMPORAL_CONTEXT_FILE)
    {
        return null;
    }
    const source = planDocument.executionIdentity?.sourceIdentity;
    return resolveCorrectnessProducerTemporalContext({
        producerId,
        schedulerRunId: planDocument.executionIdentity?.runId,
        sourceCommit: source?.commit,
        sourceFingerprint: source?.worktreeFingerprint
    });
}

function bindProducerResultTemporalArtifacts(producerId, temporalContext, result)
{
    if (!temporalContext || result?.structuralOnly === true)
    {
        return null;
    }
    const { temporalObservation } = result;
    const outcome = { ...result };
    delete outcome.temporalObservation;
    delete outcome.temporalArtifacts;
    return bindCorrectnessProducerTemporalArtifacts({
        producerId,
        contextInput: temporalContext,
        outcome,
        observations: temporalObservation,
        generatedAt: new Date().toISOString()
    });
}

function verifyProducerResultTemporalArtifacts(producerId, result)
{
    const temporalArtifacts = result?.temporalArtifacts;
    if (!temporalArtifacts)
    {
        if (result?.structuralOnly === true)
        {
            return null;
        }
        if (process.env.FSUSBLOG_TEMPORAL_CONTEXT_JSON
        || process.env.FSUSBLOG_TEMPORAL_CONTEXT_FILE)
        {
            throw new Error(`producer ${producerId} is missing bound temporal artifacts`);
        }
        return null;
    }
    const verification = verifyTemporalReplay(temporalArtifacts);
    const outcome = { ...result };
    delete outcome.temporalObservation;
    delete outcome.temporalArtifacts;
    if (temporalArtifacts.receipt.semanticOutcomeDigest !== semanticOutcomeDigest(outcome))
    {
        throw new Error(`producer ${producerId} temporal receipt does not bind its exact output`);
    }
    return {
        planDigest: temporalArtifacts.plan.digest,
        actualDigest: temporalArtifacts.actual.digest,
        receiptDigest: temporalArtifacts.receipt.digest,
        contextDigest: temporalArtifacts.receipt.temporalContextDigest,
        semanticOutcomeDigest: temporalArtifacts.receipt.semanticOutcomeDigest,
        bindingDigest: temporalArtifacts.bindingDigest,
        qualificationEligible: verification.qualificationEligible
    };
}

/**
 * @param {object} profileIdentity - { profileId, profileSource, executionClass?, sealed? }
 * @param {object} [executionIdentity] - { runId?, namespace?, sourceIdentity?, handles? }
 */
export function plan(profileIdentity, executionIdentity = {}, { catalogs = readFixtureCatalogs() } = {})
{
    if (!profileIdentity || typeof profileIdentity !== 'object')
    {
        throw new Error('profileIdentity is required');
    }
    const profileId = String(profileIdentity.profileId ?? '').trim();
    if (!profileId)
    {
        throw new Error('profileIdentity.profileId is required');
    }

    const profileSource = profileIdentity.profileSource
    ?? (profileIdentity.sealed ? 'matrix' : 'dev-cli');

    const resolved = resolveFixtureProfile({
        profileId,
        profileSource,
        executionClass: profileIdentity.executionClass ?? null,
        requestedVariantIds: profileIdentity.variantIds ?? null,
        sealed: profileIdentity.sealed ?? null,
        catalogs,
        allowFreeProfileEnv: profileSource === 'dev-cli',
        freeProfileEnv: profileSource === 'dev-cli' ? '' : (profileIdentity.freeProfileEnv ?? '')
    });

    // Fail closed: unknown profile already rejected; re-check catalog digest for sealed matrix plans.
    const liveDigest = fixtureCatalogDigest(catalogs);
    if (resolved.catalogDigest !== liveDigest)
    {
        throw new Error('fixture catalog digest drifted; refusing plan');
    }

    const mutation = planFixtureMutation(profileId, catalogs);
    const dag = buildProducerDag(profileId, catalogs);

    if (profileId === 'none' || mutation.mutationPolicy === 'zero-mutation')
    {
        if (dag.producers.length !== 0 || dag.order.length !== 0)
        {
            throw new Error('none plan producer DAG must be empty');
        }
    }

    // Reject attempts to register producers for none via identity smuggling.
    if ((profileId === 'none' || mutation.capabilities.length === 0) && (executionIdentity?.forcedProducers ?? []).length)
    {
        throw new Error('none profile cannot register producers');
    }

    return Object.freeze({
        schema: 'fsusblog.fixture-orchestrator-plan.v1',
        profileIdentity: Object.freeze({
            profileId: resolved.profileId,
            profileSource: resolved.profileSource,
            executionClass: resolved.executionClass,
            sealed: resolved.sealed
        }),
        executionIdentity: Object.freeze({
            runId: executionIdentity.runId ?? null,
            namespace: executionIdentity.namespace ?? null,
            sourceIdentity: executionIdentity.sourceIdentity ?? null,
            handles: Object.freeze({ ...(executionIdentity.handles ?? {}) })
        }),
        catalogDigest: resolved.catalogDigest,
        expandedCapabilityDigest: resolved.expandedCapabilityDigest,
        capabilities: resolved.capabilities,
        // #1722: ports consume this sealed typed plan; they may not infer variant
        // validity from capability/profile names or introduce a local default.
        variantIds: resolved.variantIds,
        variantPlan: resolved.variantPlan,
        variantPlanDigest: resolved.variantPlanDigest,
        producers: Object.freeze(dag.producers.map((item) => item.id)),
        producerSpecs: dag.producers,
        edges: dag.edges,
        order: dag.order,
        waves: dag.waves,
        mutationPolicy: resolved.mutationPolicy,
        requiresLocalAuthBypass: resolved.requiresLocalAuthBypass,
        requiresAuthFixtures: resolved.requiresAuthFixtures,
        requiresPublicFixtures: resolved.requiresPublicFixtures,
        requiresDemoSeed: resolved.requiresDemoSeed,
        requiresSecurityState: resolved.requiresSecurityState,
        terminalState: 'planned'
    });
}

/**
 * Prepare producers for a planned DAG. First producer failure is the primary failure;
 * successful producers are cleaned in reverse topo. Cleanup failure is recorded separately.
 */
export async function prepare(planDocument, injectedPorts, signal = undefined, {
    catalogs = readFixtureCatalogs(),
    handles = null,
    previousFixtureReceipt = null,
    artifactOutlet = null
} = {})
{
    if (!planDocument || planDocument.schema !== 'fsusblog.fixture-orchestrator-plan.v1')
    {
        throw new Error('prepare requires an orchestrator plan');
    }
    throwIfAborted(signal);

    const terminal = createTerminalState('planned');
    terminal.transition('preparing');

    const producerIds = [...(planDocument.order ?? planDocument.producers ?? [])];
    const catalogProducers = planDocument.producerSpecs
    ?? (catalogs.producer.producers ?? []).filter((item) => producerIds.includes(item.id));
    const portMap = indexProducerPorts(injectedPorts ?? [], { catalogProducers });
    requireProducerPorts(producerIds, portMap);
    const identityRoleRequests = Object.freeze([...portMap.values()]
        .filter((port) => producerIds.includes(port.id))
        .flatMap((port) => port.identityRoleRequests));
    if (identityRoleRequests.length > 0 && !producerIds.includes('auth-session'))
    {
        throw new Error('consumer identity role requests require the planned auth-session owner producer');
    }

    let previousReceiptByProducer = new Map();
    if (previousFixtureReceipt != null)
    {
        const expectedExecutionIdentity = {
            runId: planDocument.executionIdentity?.runId ?? null,
            namespace: planDocument.executionIdentity?.namespace ?? null,
            source: planDocument.executionIdentity?.sourceIdentity ?? null,
            serviceGeneration: planDocument.executionIdentity?.handles?.serviceGeneration ?? null
        };
        const previous = validateFixtureReceipt(previousFixtureReceipt, {
            catalogs,
            requireVerified: true,
            expectedCatalogDigest: planDocument.catalogDigest,
            expectedProfileId: planDocument.profileIdentity.profileId,
            expectedExecutionIdentity
        });
        if (previous.expandedCapabilityDigest !== planDocument.expandedCapabilityDigest)
        {
            throw new Error('previous FixtureReceipt capability digest does not match the current plan');
        }

        previousReceiptByProducer = new Map();
        for (const producerReceipt of previous.producerReceipts ?? [])
        {
            if (!producerIds.includes(producerReceipt.producerId)
          || previousReceiptByProducer.has(producerReceipt.producerId)
          || producerReceipt.runId !== expectedExecutionIdentity.runId
          || producerReceipt.namespace !== expectedExecutionIdentity.namespace
          || producerReceipt.profileId !== planDocument.profileIdentity.profileId
          || producerReceipt.fixtureCatalogDigest !== planDocument.catalogDigest
          || producerReceipt.expandedCapabilityDigest !== planDocument.expandedCapabilityDigest
          || producerReceipt.serviceGeneration !== expectedExecutionIdentity.serviceGeneration)
            {
                throw new Error('previous FixtureReceipt producer identity does not match the current plan');
            }
            previousReceiptByProducer.set(producerReceipt.producerId, producerReceipt);
        }
        if (previousReceiptByProducer.size !== producerIds.length)
        {
            throw new Error('previous FixtureReceipt does not cover every producer in the current plan');
        }
    }

    // Fail closed if caller injects ports for producers outside the plan AND profile is none.
    if (planDocument.profileIdentity.profileId === 'none' && portMap.size > 0 && producerIds.length === 0)
    {
    // Ports may be a full registry; only planned producers are invoked.
    }

    const producerOutputs = {};
    const producerResults = [];
    const succeeded = [];
    let primaryFailure;
    let cleanupFailure = null;
    const strategies = [];

    const baseHandles = Object.freeze({
        ...(planDocument.executionIdentity?.handles ?? {}),
        ...(handles ?? {}),
        ...(artifactOutlet ? { fixtureArtifactOutlet: artifactOutlet, fixtureArtifactConsumerId: artifactOutlet.consumerId } : {})
    });

    try
    {
        for (const wave of planDocument.waves ?? [])
        {
            throwIfAborted(signal);
            // Parallel within a wave (state-domain disjoint by construction).
            const waveResults = await Promise.all(wave.map(async (producerId) =>
            {
                throwIfAborted(signal);
                const port = portMap.get(producerId);
                if (!port)
                {
                    throw new Error(`missing producer port ${producerId}`);
                }
                const spec = catalogProducers.find((item) => item.id === producerId);
                if (spec && port.strategy !== spec.strategy)
                {
                    throw new Error(`producer ${producerId} attempted strategy change ${port.strategy} != ${spec.strategy}`);
                }
                const context = createProducerContext({
                    plan: planDocument,
                    producerId,
                    namespace: planDocument.executionIdentity?.namespace,
                    runIdentity: planDocument.executionIdentity?.runId,
                    sourceIdentity: planDocument.executionIdentity?.sourceIdentity,
                    profileIdentity: planDocument.profileIdentity,
                    producerOutputs,
                    handles: baseHandles,
                    catalogs,
                    previousProducerReceipt: previousReceiptByProducer.get(producerId) ?? null,
                    temporalContext: temporalContextForProducer(planDocument, producerId),
                    identityRoleRequests: producerId === 'auth-session' ? identityRoleRequests : []
                });
                const rawResult = await port.prepare(context, signal);
                throwIfAborted(signal);
                if (!rawResult || typeof rawResult !== 'object')
                {
                    throw new Error(`producer ${producerId} prepare must return a producerResult object`);
                }
                const temporalArtifacts = bindProducerResultTemporalArtifacts(
                    producerId,
                    context.temporalContext,
                    rawResult
                );
                const result = temporalArtifacts
                    ? { ...rawResult, temporalArtifacts }
                    : rawResult;
                if (result.strategy && result.strategy !== port.strategy)
                {
                    throw new Error(
                        `producer ${producerId} returned strategy ${result.strategy}; cannot fallback from ${port.strategy}`
                    );
                }
                // Prepare must not publish ProducerReceipt success; only raw results until verify.
                if (result.producerReceiptDigest || result.schema === 'fsusblog.fixture-producer-receipt.v1')
                {
                    throw new Error(`producer ${producerId} must not publish ProducerReceipt during prepare`);
                }
                assertProducerVariantOutput(result, planDocument, producerId, catalogs);
                return {
                    producerId,
                    strategy: port.strategy,
                    context,
                    result: Object.freeze({ ...result, strategy: port.strategy, producerId })
                };
            }));

            for (const entry of waveResults)
            {
                succeeded.push(entry.producerId);
                strategies.push({ producerId: entry.producerId, strategy: entry.strategy });
                producerOutputs[entry.producerId] = entry.result;
                producerResults.push(entry.result);
            }
            for (const entry of waveResults)
            {
                artifactOutlet?.recordPort(entry.context, 'prepare', entry.result);
            }
        }

        terminal.transition('prepared');
        terminal.assertPublishable('prepared');

        // Prepare-state is not verified evidence (no dual legacy fixture-receipt.v1).
        return Object.freeze({
            schema: FIXTURE_PREPARE_STATE_SCHEMA,
            terminalState: terminal.state,
            terminalHistory: terminal.history,
            plan: planDocument,
            catalogDigest: planDocument.catalogDigest,
            expandedCapabilityDigest: planDocument.expandedCapabilityDigest,
            profileId: planDocument.profileIdentity.profileId,
            profileSource: planDocument.profileIdentity.profileSource,
            producerIds: Object.freeze([...producerIds]),
            strategies: Object.freeze(strategies.map((item) => Object.freeze({ ...item }))),
            producerResults: Object.freeze(producerResults),
            producerOutputs: Object.freeze({ ...producerOutputs }),
            // Explicitly empty: ProducerReceipt success is publish-only after verify.
            producerReceipts: Object.freeze([]),
            primaryFailure: null,
            cleanupFailure: null,
            zeroData: producerIds.length === 0,
            mutations: Object.freeze([...succeeded])
        });
    }
    catch (error)
    {
        primaryFailure = error;
        // Do not publish prepared/verified for partial results.
        try
        {
            if (terminal.state === 'preparing')
            {
                terminal.transition('failed');
            }
        }
        catch
        {
            /* state already terminal */
        }

        // Reverse-topo cleanup of succeeded producers only.
        const reverse = reverseTopo(succeeded);
        if (reverse.length)
        {
            try
            {
                if (terminal.state === 'failed')
                {
                    terminal.transition('cleaning');
                }
            }
            catch
            { /* ignore */ }
            for (const producerId of reverse)
            {
                try
                {
                    // Always attempt cleanup after cancel/timeout; pass signal so producers
                    // stop mutating, but do not skip cleanup invocation solely because prepare aborted.
                    const port = portMap.get(producerId);
                    const context = createProducerContext({
                        plan: planDocument,
                        producerId,
                        namespace: planDocument.executionIdentity?.namespace,
                        runIdentity: planDocument.executionIdentity?.runId,
                        sourceIdentity: planDocument.executionIdentity?.sourceIdentity,
                        profileIdentity: planDocument.profileIdentity,
                        producerOutputs,
                        handles: baseHandles,
                        catalogs,
                        // Prepare success has not published any sealed receipts.
                        producerReceipts: {}
                    });
                    const cleanupResult = await port.cleanup(context, producerOutputs[producerId], signal);
                    throwIfAborted(signal);
                    artifactOutlet?.recordPort(context, 'cleanup', cleanupResult);
                }
                catch (cleanupError)
                {
                    if (!cleanupFailure)
                    {
                        cleanupFailure = cleanupError;
                    }
                }
            }
            try
            {
                if (terminal.state === 'cleaning')
                {
                    terminal.transition(cleanupFailure ? 'cleanup-failed' : 'cleaned');
                }
            }
            catch
            { /* ignore */ }
        }

        const terminalStatus = cleanupFailure ? 'cleanup-failed' : (succeeded.length ? 'partial' : 'failed');
        const prepareState = Object.freeze({
            schema: FIXTURE_PREPARE_STATE_SCHEMA,
            terminalState: terminal.state === 'preparing' ? 'failed' : terminal.state,
            terminalHistory: terminal.history,
            plan: planDocument,
            catalogDigest: planDocument.catalogDigest,
            expandedCapabilityDigest: planDocument.expandedCapabilityDigest,
            profileId: planDocument.profileIdentity.profileId,
            profileSource: planDocument.profileIdentity.profileSource,
            producerIds: Object.freeze([...producerIds]),
            strategies: Object.freeze(strategies.map((item) => Object.freeze({ ...item }))),
            producerResults: Object.freeze(producerResults),
            producerOutputs: Object.freeze({ ...producerOutputs }),
            producerReceipts: Object.freeze([]),
            primaryFailure: serializeError(primaryFailure),
            cleanupFailure: serializeError(cleanupFailure),
            zeroData: false,
            mutations: Object.freeze([...succeeded])
        });

        let fixtureReceipt;
        try
        {
            fixtureReceipt = buildTerminalFailureReceipt({
                terminalStatus,
                plan: planDocument,
                primaryFailure: serializeError(primaryFailure),
                cleanupFailure: serializeError(cleanupFailure),
                catalogs
            });
        }
        catch
        {
            fixtureReceipt = null;
        }

        const wrapped = new Error(primaryFailure instanceof Error ? primaryFailure.message : String(primaryFailure));
        wrapped.name = primaryFailure instanceof Error ? primaryFailure.name : 'Error';
        wrapped.receipt = prepareState;
        wrapped.fixtureReceipt = fixtureReceipt;
        wrapped.cause = primaryFailure instanceof Error ? primaryFailure : undefined;
        throw wrapped;
    }
}

function resolveVerifierPorts(prepareState, injectedVerifiers, catalogs)
{
    const planDocument = prepareState.plan;
    const producerIds = [...(prepareState.producerIds ?? [])];
    const catalogProducers = planDocument.producerSpecs
    ?? (catalogs.producer.producers ?? []).filter((item) => producerIds.includes(item.id));
    if (injectedVerifiers instanceof Map)
    {
        return injectedVerifiers;
    }
    if (Array.isArray(injectedVerifiers))
    {
        return indexProducerPorts(injectedVerifiers, { catalogProducers });
    }
    if (injectedVerifiers && typeof injectedVerifiers === 'object')
    {
        return indexProducerPorts(
            Object.entries(injectedVerifiers).map(([id, port]) => ({ id, ...port })),
            { catalogProducers }
        );
    }
    return new Map();
}

function observationsFromProducerResult(result)
{
    if (result?.observations && typeof result.observations === 'object')
    {
        return {
            database: result.observations.database ?? result.databaseObservation ?? null,
            redis: result.observations.redis ?? result.redisObservation ?? null,
            cache: result.observations.cache ?? result.cacheObservation ?? null,
            source: result.observations.source,
            fallback: result.observations.fallback,
            warningOnly: result.observations.warningOnly,
            stale: result.observations.stale
        };
    }
    return {
        database: result?.databaseObservation ?? null,
        redis: result?.redisObservation ?? null,
        cache: result?.cacheObservation ?? null,
        source: result?.observationSource,
        fallback: result?.fallback === true,
        warningOnly: result?.warningOnly === true,
        stale: result?.stale === true
    };
}

function expectedProducerVariantIds(planDocument, producerId)
{
    return Object.freeze((planDocument.variantPlan?.byProducer
        ?.find((item) => item.producerId === producerId)?.variants ?? [])
        .map((item) => item.id)
        .sort());
}

function assertProducerVariantOutput(result, planDocument, producerId, catalogs)
{
    const expected = expectedProducerVariantIds(planDocument, producerId);
    const producerPlan = buildProducerFixtureVariantPlan({
        producerId,
        variantIds: expected,
        fixtureVariantIds: planDocument.variantIds,
        fixtureVariantPlanDigest: planDocument.variantPlanDigest,
        catalogs
    });
    const actual = Array.isArray(result.variantIds) ? [...result.variantIds].map(String).sort() : null;
    if (actual == null || JSON.stringify(actual) !== JSON.stringify(expected))
    {
        throw new Error(`producer ${producerId} output variant IDs must exactly match its typed variant plan`);
    }
    if (result.producerVariantPlanDigest !== producerPlan.producerVariantPlanDigest)
    {
        throw new Error(`producer ${producerId} output typed variant plan digest does not match its immutable plan`);
    }
    const allowed = new Set(expected);
    for (const identity of result.entityIdentities ?? [])
    {
        if (!identity?.variantId || !allowed.has(identity.variantId))
        {
            throw new Error(`producer ${producerId} entity ${identity?.id ?? '<missing>'} has no registered planned variant`);
        }
    }
    const databaseEntities = result.observations?.database?.entities
    ?? result.databaseObservation?.entities
    ?? [];
    for (const entity of databaseEntities)
    {
        if (!entity?.variantId || !allowed.has(entity.variantId))
        {
            throw new Error(`producer ${producerId} database entity ${entity?.id ?? '<missing>'} has no registered planned variant`);
        }
    }
    const evidenceErrors = validateFixtureVariantEvidence({ result, variantIds: expected, catalogs });
    if (evidenceErrors.length)
    {
        throw new Error(`producer ${producerId} variant evidence rejected: ${evidenceErrors.join('; ')}`);
    }
    return expected;
}

/**
 * Verify prepare-state into a FixtureReceipt.
 * Only terminalStatus=verified is success evidence; missing postconditions fail closed.
 */
export async function verify(prepareState, injectedVerifiers = {}, {
    catalogs = readFixtureCatalogs(),
    signal = undefined,
    serviceIdentity = null,
    outputArtifacts = [],
    handles = null,
    artifactOutlet = null
} = {})
{
    if (!prepareState || prepareState.schema !== FIXTURE_PREPARE_STATE_SCHEMA)
    {
        if (prepareState?.schema === 'fsusblog.fixture-orchestrator-receipt.v1'
      || prepareState?.schema === 'fsusblog.fixture-receipt.v1')
        {
            throw new Error('retired prepare/receipt schema; no dual adapter — re-run prepare under #1710');
        }
        throw new Error('verify requires a fixture prepare-state');
    }
    if (prepareState.terminalState !== 'prepared' && prepareState.terminalState !== 'verified')
    {
        throw new Error(`cannot verify prepare-state in terminal state ${prepareState.terminalState}`);
    }
    throwIfAborted(signal);

    const terminal = createTerminalState('prepared');
    terminal.transition('verifying');

    const planDocument = prepareState.plan;
    const producerIds = [...(prepareState.producerIds ?? [])];
    const profileCapabilities = [...(planDocument.capabilities ?? [])];
    assertProfilePostconditionsBound(profileCapabilities, catalogs);

    const verifierMap = resolveVerifierPorts(prepareState, injectedVerifiers, catalogs);
    const sealedProducerReceipts = [];
    const sealedProducerReceiptsById = {};
    const portPostconditions = [];
    const verifierHandles = Object.freeze({
        ...(planDocument.executionIdentity?.handles ?? {}),
        ...(handles ?? {}),
        ...(artifactOutlet ? { fixtureArtifactOutlet: artifactOutlet, fixtureArtifactConsumerId: artifactOutlet.consumerId } : {})
    });

    try
    {
    // none profile: zero producers, zero business mutation, still verified.
        if (planDocument.profileIdentity.profileId === 'none' || producerIds.length === 0)
        {
            if (profileCapabilities.length !== 0)
            {
                throw new Error('none/zero-producer plan cannot claim non-empty capabilities');
            }
            terminal.transition('verified');
            terminal.assertPublishable('verified');
            // Return pure FixtureReceipt only — extra fields would invalidate receiptDigest.
            return aggregateVerifiedFixtureReceipt({
                plan: planDocument,
                producerReceipts: [],
                serviceIdentity,
                outputArtifacts,
                catalogs
            });
        }

        for (const producerId of producerIds)
        {
            throwIfAborted(signal);
            const port = verifierMap.get?.(producerId) ?? verifierMap[producerId];
            if (!port || typeof port.verify !== 'function')
            {
                throw new Error(`missing verifier port for producer ${producerId}`);
            }
            const rawResult = prepareState.producerOutputs[producerId];
            if (!rawResult)
            {
                throw new Error(`missing prepare result for producer ${producerId}`);
            }
            const producedVariantIds = assertProducerVariantOutput(rawResult, planDocument, producerId, catalogs);

            const context = createProducerContext({
                plan: planDocument,
                producerId,
                namespace: planDocument.executionIdentity?.namespace,
                runIdentity: planDocument.executionIdentity?.runId,
                sourceIdentity: planDocument.executionIdentity?.sourceIdentity,
                profileIdentity: planDocument.profileIdentity,
                producerOutputs: prepareState.producerOutputs,
                handles: verifierHandles,
                catalogs,
                temporalContext: temporalContextForProducer(planDocument, producerId),
                producerReceipts: sealedProducerReceiptsById
            });
            const portVerify = await port.verify(context, rawResult, signal);
            throwIfAborted(signal);
            const portOk = portVerify === true
        || (portVerify && typeof portVerify === 'object' && portVerify.ok === true);
            if (!portOk)
            {
                artifactOutlet?.recordRejectedPort(context, portVerify);
                const reason = portVerify && typeof portVerify === 'object'
                    ? (portVerify.reason ?? portVerify.note ?? 'producer verify returned not-ok')
                    : 'producer verify returned not-ok';
                throw new Error(`producer ${producerId} verify failed: ${reason}`);
            }
            if (portVerify?.structuralOnly === true)
            {
                artifactOutlet?.recordRejectedPort(context, portVerify);
                throw new Error(
                    `producer ${producerId} structural-only prepare cannot verify; business observations required (#1712+)`
                );
            }
            if (portVerify?.fallback === true || portVerify?.warningOnly === true || portVerify?.stale === true)
            {
                artifactOutlet?.recordRejectedPort(context, portVerify);
                throw new Error(`producer ${producerId} warning/fallback/stale verify cannot become verified evidence`);
            }
            portPostconditions.push(Object.freeze({
                producerId,
                ...(portVerify && typeof portVerify === 'object' ? portVerify : { ok: true })
            }));

            const catalogProducer = (planDocument.producerSpecs ?? catalogs.producer.producers)
                .find((item) => item.id === producerId);
            if (!catalogProducer)
            {
                throw new Error(`catalog producer ${producerId} missing during verify`);
            }

            // Profile-scoped provided capabilities = catalog provides ∩ plan capabilities.
            const providedCapabilities = catalogProducer.provides.filter((id) => profileCapabilities.includes(id));
            // Producer must not claim extra capabilities beyond the profile or catalog.
            const claimed = Array.isArray(rawResult.providedCapabilities)
                ? rawResult.providedCapabilities
                : providedCapabilities;
            for (const capabilityId of claimed)
            {
                if (!catalogProducer.provides.includes(capabilityId))
                {
                    throw new Error(`producer ${producerId} provided undeclared capability ${capabilityId}`);
                }
                if (!profileCapabilities.includes(capabilityId))
                {
                    throw new Error(`producer ${producerId} provided capability ${capabilityId} outside profile`);
                }
            }
            // Fail closed if producer invents receipt fields outside the allow-list shape.
            if (rawResult.inventedReceiptField != null)
            {
                throw new Error(`producer ${producerId} invented receipt fields are forbidden`);
            }

            const observations = observationsFromProducerResult({
                ...rawResult,
                ...(portVerify && typeof portVerify === 'object' ? portVerify : {})
            });
            // Local constructed objects / file-only evidence cannot satisfy postconditions.
            if (observations.source === 'local-fallback' || rawResult.localConstructed === true)
            {
                throw new Error(`producer ${producerId} local constructed objects cannot serve as service postconditions`);
            }

            const postconditionResult = verifyCapabilityPostconditions({
                capabilities: profileCapabilities,
                producerId,
                providedCapabilities,
                observations,
                entityIdentities: rawResult.entityIdentities ?? portVerify?.entityIdentities ?? [],
                runId: planDocument.executionIdentity?.runId ?? null,
                namespace: planDocument.executionIdentity?.namespace ?? null,
                catalogs
            });
            const temporalBinding = verifyProducerResultTemporalArtifacts(producerId, rawResult);

            const producerReceipt = buildProducerReceipt({
                producerId,
                strategy: catalogProducer.strategy,
                runId: planDocument.executionIdentity?.runId ?? null,
                namespace: planDocument.executionIdentity?.namespace ?? null,
                source: planDocument.executionIdentity?.sourceIdentity ?? null,
                fixtureCatalogDigest: planDocument.catalogDigest,
                profileId: planDocument.profileIdentity.profileId,
                expandedCapabilityDigest: planDocument.expandedCapabilityDigest,
                fixtureVariantIds: planDocument.variantIds,
                variantPlanDigest: planDocument.variantPlanDigest,
                producerVariantPlanDigest: rawResult.producerVariantPlanDigest,
                producedVariantIds,
                serviceGeneration: planDocument.executionIdentity?.handles?.serviceGeneration ?? null,
                providedCapabilities,
                ownedStateDomains: catalogProducer.stateDomains,
                entityIdentities: rawResult.entityIdentities ?? portVerify?.entityIdentities ?? [],
                postconditionObservations: postconditionResult.results,
                cleanupContract: rawResult.cleanupContract ?? { kind: 'owned-namespace' },
                databaseObservation: observations.database,
                redisObservation: observations.redis,
                cacheObservation: observations.cache,
                domainObservations: rawResult.domainObservations ?? portVerify?.domainObservations ?? [],
                temporalBinding,
                catalogs
            });
            artifactOutlet?.recordPort(context, 'verify', portVerify, postconditionResult.results);
            sealedProducerReceipts.push(producerReceipt);
            sealedProducerReceiptsById[producerId] = producerReceipt;
        }

        // Every profile capability must be covered by a sealed ProducerReceipt.
        const covered = new Set(sealedProducerReceipts.flatMap((item) => item.providedCapabilities));
        for (const capabilityId of profileCapabilities)
        {
            if (!covered.has(capabilityId))
            {
                throw new Error(`profile capability ${capabilityId} has no verified ProducerReceipt (fail closed)`);
            }
        }

        throwIfAborted(signal);
        const artifactReferences = artifactOutlet?.publish('verify') ?? [];
        throwIfAborted(signal);
        terminal.transition('verified');
        terminal.assertPublishable('verified');

        // Pure FixtureReceipt only (schema + digest). Orchestrator annotations must not be mixed in.
        return aggregateVerifiedFixtureReceipt({
            plan: planDocument,
            producerReceipts: sealedProducerReceipts,
            serviceIdentity,
            outputArtifacts: [...(outputArtifacts.length
                ? outputArtifacts
                : (prepareState.outputArtifacts ?? [])), ...artifactReferences],
            catalogs
        });
    }
    catch (error)
    {
        let fixtureReceipt;
        try
        {
            fixtureReceipt = buildTerminalFailureReceipt({
                terminalStatus: sealedProducerReceipts.length ? 'partial' : 'failed',
                plan: planDocument,
                primaryFailure: serializeError(error),
                producerReceipts: sealedProducerReceipts,
                catalogs
            });
        }
        catch
        {
            fixtureReceipt = null;
        }
        const wrapped = new Error(error instanceof Error ? error.message : String(error));
        wrapped.name = error instanceof Error ? error.name : 'Error';
        wrapped.receipt = Object.freeze({
            ...prepareState,
            terminalState: 'failed',
            primaryFailure: serializeError(error),
            portPostconditions: Object.freeze(portPostconditions),
            producerReceipts: Object.freeze(sealedProducerReceipts)
        });
        wrapped.fixtureReceipt = fixtureReceipt;
        wrapped.cause = error instanceof Error ? error : undefined;
        throw wrapped;
    }
}

export function planFromState(state)
{
    if (state?.plan)
    {
        return state.plan;
    }
    if (state?.schema === FIXTURE_RECEIPT_SCHEMA)
    {
        const catalogs = readFixtureCatalogs();
        const variantPlan = buildFixtureVariantPlan(state.fixtureVariantIds ?? [], catalogs);
        if (variantPlan.catalogDigest !== state.catalogDigest
      || variantPlan.variantPlanDigest !== state.variantPlanDigest)
        {
            throw new Error('cleanup FixtureReceipt variant plan drifted from the live catalog');
        }
        // Cleanup may receive a FixtureReceipt; reconstruct a minimal plan handle via producer ids.
        return {
            producerSpecs: (state.producerReceipts ?? []).map((item) => ({
                id: item.producerId,
                strategy: item.strategy,
                provides: item.providedCapabilities,
                consumes: [],
                stateDomains: item.ownedStateDomains
            })),
            executionIdentity: state.executionIdentity,
            profileIdentity: state.profileIdentity,
            catalogDigest: state.catalogDigest,
            expandedCapabilityDigest: state.expandedCapabilityDigest,
            variantIds: state.fixtureVariantIds,
            variantPlan,
            variantPlanDigest: state.variantPlanDigest
        };
    }
    return null;
}

export async function cleanup(state, injectedPorts, signal = undefined, {
    catalogs = readFixtureCatalogs(),
    handles = null,
    artifactOutlet = null
} = {})
{
    if (!state)
    {
        throw new Error('cleanup requires prepare-state or FixtureReceipt');
    }
    if (state.schema === 'fsusblog.fixture-orchestrator-receipt.v1'
    || state.schema === 'fsusblog.fixture-receipt.v1')
    {
        throw new Error('retired receipt schema; no dual adapter for cleanup');
    }
    if (state.schema !== FIXTURE_PREPARE_STATE_SCHEMA && state.schema !== FIXTURE_RECEIPT_SCHEMA)
    {
        throw new Error('cleanup requires prepare-state or FixtureReceipt');
    }
    throwIfAborted(signal);

    const terminalState = state.terminalState
    ?? (state.terminalStatus === 'verified' ? 'verified'
        : state.terminalStatus === 'cleanup-failed' ? 'cleanup-failed'
        : state.terminalStatus === 'failed' || state.terminalStatus === 'partial' ? 'failed'
          : 'prepared');

    const terminal = createTerminalState(
    ['prepared', 'verified', 'failed', 'cleaned', 'cleanup-failed'].includes(terminalState)
        ? (terminalState === 'cleaned' || terminalState === 'cleanup-failed'
        ? terminalState
        : terminalState === 'failed' ? 'failed' : (terminalState === 'verified' ? 'verified' : 'prepared'))
        : 'prepared'
    );

    if (terminal.state === 'cleaned')
    {
        return Object.freeze({ ...state, terminalState: 'cleaned' });
    }
    if (terminal.state === 'cleanup-failed')
    {
        return Object.freeze({ ...state, terminalState: 'cleanup-failed' });
    }

    if (terminal.state === 'failed')
    {
        terminal.transition('cleaning');
    }
    else if (terminal.state === 'prepared' || terminal.state === 'verified')
    {
        terminal.transition('cleaning');
    }
    else
    {
        terminal.transition('cleaning');
    }

    const planDocument = planFromState(state);
    // Cleanup reverse of actual success order (mutations), not a re-sorted catalog topo alone.
    let succeeded = [];
    if (Array.isArray(state.mutations) && state.mutations.length)
    {
        succeeded = [...state.mutations];
    }
    else if (state.producerOutputs && Object.keys(state.producerOutputs).length)
    {
        succeeded = Object.keys(state.producerOutputs);
    }
    else if (Array.isArray(state.producerReceipts) && state.producerReceipts.length)
    {
        succeeded = state.producerReceipts.map((item) => item.producerId);
    }
    else if (Array.isArray(state.producerIds) && state.producerIds.length)
    {
        succeeded = [...state.producerIds];
    }
    const producerIds = reverseTopo(succeeded);
    // Always index ports against full catalog producers (not profile-scoped provides subsets).
    const catalogProducers = (catalogs.producer.producers ?? []).filter((item) => producerIds.includes(item.id));
    const portMap = indexProducerPorts(injectedPorts ?? [], { catalogProducers });

    let cleanupFailure = null;
    const baseHandles = Object.freeze({
        ...(planDocument?.executionIdentity?.handles ?? {}),
        ...(planDocument?.executionIdentity?.serviceGeneration ? { serviceGeneration: planDocument.executionIdentity.serviceGeneration } : {}),
        ...(handles ?? {}),
        ...(artifactOutlet ? { fixtureArtifactOutlet: artifactOutlet, fixtureArtifactConsumerId: artifactOutlet.consumerId } : {})
    });

    for (const producerId of producerIds)
    {
        try
        {
            throwIfAborted(signal);
            const port = portMap.get(producerId);
            if (!port)
            {
                throw new Error(`missing producer port ${producerId} for cleanup`);
            }
            const context = createProducerContext({
                plan: planDocument,
                producerId,
                namespace: planDocument?.executionIdentity?.namespace
          ?? state.executionIdentity?.namespace,
                runIdentity: planDocument?.executionIdentity?.runId
          ?? state.executionIdentity?.runId,
                sourceIdentity: planDocument?.executionIdentity?.sourceIdentity
          ?? state.executionIdentity?.source,
                profileIdentity: planDocument?.profileIdentity ?? state.profileIdentity,
                producerOutputs: state.producerOutputs ?? {},
                handles: baseHandles,
                catalogs,
                producerReceipts: Object.fromEntries((state.producerReceipts ?? [])
                    .map((receipt) => [receipt.producerId, receipt]))
            });
            const cleanupResult = await port.cleanup(
                context,
                state.producerOutputs?.[producerId] ?? state.producerReceipts?.find((item) => item.producerId === producerId),
                signal
            );
            throwIfAborted(signal);
            artifactOutlet?.recordPort(context, 'cleanup', cleanupResult);
        }
        catch (error)
        {
            if (!cleanupFailure)
            {
                cleanupFailure = error;
            }
        }
    }

    const nextState = cleanupFailure ? 'cleanup-failed' : 'cleaned';
    try
    {
        terminal.transition(nextState);
    }
    catch
    {
    /* ignore illegal if already terminal */
    }

    const next = Object.freeze({
        ...state,
        terminalState: nextState,
        cleanupFailure: cleanupFailure
            ? serializeError(cleanupFailure)
            : (state.cleanupFailure ?? null),
        // Never overwrite primary failure with cleanup failure.
        primaryFailure: state.primaryFailure ?? null
    });

    if (cleanupFailure)
    {
        const wrapped = new Error(cleanupFailure instanceof Error ? cleanupFailure.message : String(cleanupFailure));
        wrapped.name = 'FixtureCleanupError';
        wrapped.receipt = next;
        wrapped.cause = cleanupFailure instanceof Error ? cleanupFailure : undefined;
        throw wrapped;
    }
    return next;
}
