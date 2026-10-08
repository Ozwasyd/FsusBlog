import { isDeepStrictEqual } from 'node:util';

import { readCurrentSchedulerCorrectness } from './scheduler-correctness-finalizer.mjs';
import { readCanonicalSchedulerCheckpoint } from './scheduler.mjs';

const { digestCanonical, sealContentDigest } = await import(new URL('../test/attempt-provenance.mjs', import.meta.url));
const { correctnessTerminalReceiptSchema } = await import(new URL('../release/correctness-terminal-receipt.mjs', import.meta.url));

const spawnFields = Object.freeze([
    'command', 'services', 'serviceDependencies', 'exclusiveResources', 'resources',
    'resourceClass', 'cpuUnits', 'memoryGiB', 'maxParallel', 'parallelizable',
    'timeoutMinutes', 'timeoutMs', 'fixtureProfile', 'fixtureBootstrap',
    'executionKey', 'executionVariant', 'resourceContractRef',
    'spawnEligibility', 'producerId', 'attemptPolicyId'
]);

/** A compatibility declaration has no command, resource grant, fixture or attempt owner. */
export function validateProductionSummaryDeclaration(tier)
{
    if (tier?.id !== 'production' || tier.executionMode !== 'summary'
        || !['aggregate', 'projection'].includes(tier.commandKind)
        || tier.projectFrom !== 'production-correctness'
        || spawnFields.some((field) => Object.hasOwn(tier, field)))
    {
        throw new Error('production summary requires an exact command-free production-correctness projection');
    }
    return sealContentDigest({
        schema: 'fsusblog.production-summary-topology.v1',
        logicalTier: tier.id,
        executionMode: tier.executionMode,
        physicalProducerOwner: 'production-correctness',
        projectionSource: tier.projectFrom,
        evidenceSchema: correctnessTerminalReceiptSchema,
        declarationDigest: digestCanonical(tier),
        spawnEligibility: false,
        qualificationEligible: false
    });
}

/** Call this at every roster consumer; a local folding exception cannot admit production. */
export function compileProductionSummaryTopology({ tiers, physicalProducerIds })
{
    const declarations = (tiers ?? []).filter((tier) => tier.id === 'production');
    if (declarations.length !== 1 || !Array.isArray(physicalProducerIds)
        || physicalProducerIds.some((id) => typeof id !== 'string' || !id)
        || new Set(physicalProducerIds).size !== physicalProducerIds.length
        || physicalProducerIds.includes('production'))
    {
        throw new Error('production requires exact-one summary and exclusion from the physical command roster');
    }
    return validateProductionSummaryDeclaration(declarations[0]);
}

/**
 * Read the canonical terminal child and completed scheduler owner. This does
 * not invoke a producer, finalize an attempt, persist a receipt or admit a run.
 * The caller supplies its exact current consumer binding, never a latest path.
 */
export function projectCurrentProductionSummary({ tier, checkpointFile, expected })
{
    const topology = validateProductionSummaryDeclaration(tier);
    const fields = ['runId', 'targetAttemptId', 'sourceState', 'buildReceiptDigest',
        'terminalReceiptDigest', 'canonicalCheckpointDigest'];
    if (!expected || !isDeepStrictEqual(Object.keys(expected).sort(), [...fields].sort())
        || typeof expected.runId !== 'string' || !expected.runId
        || typeof expected.targetAttemptId !== 'string' || !expected.targetAttemptId
        || !expected.sourceState
        || fields.filter((field) => field.endsWith('Digest'))
            .some((field) => !/^sha256:[a-f0-9]{64}$/u.test(expected[field])))
    {
        throw new Error('production summary requires a closed current run/attempt/source/build/terminal/checkpoint binding');
    }
    const canonical = readCanonicalSchedulerCheckpoint(checkpointFile);
    if (canonical?.checkpointDigest !== expected.canonicalCheckpointDigest)
    {
        throw new Error('production summary canonical checkpoint binding mismatch');
    }
    const current = readCurrentSchedulerCorrectness({ checkpointFile, readCanonical: readCanonicalSchedulerCheckpoint });
    const receipt = current.receipt;
    for (const field of ['runId', 'targetAttemptId', 'sourceState', 'buildReceiptDigest'])
    {
        if (!isDeepStrictEqual(receipt[field], expected[field]))
        {
            throw new Error(`production summary current ${field} binding mismatch`);
        }
    }
    if (receipt.schema !== correctnessTerminalReceiptSchema || receipt.status !== 'success'
        || receipt.producerAuthority !== 'scheduler-terminal-finalizer'
        || receipt.targetTierId !== topology.projectionSource
        || receipt.contentDigest !== expected.terminalReceiptDigest
        || !isDeepStrictEqual(current.finalizedCheckpoint, canonical.checkpoint))
    {
        throw new Error('production summary current terminal binding mismatch');
    }
    const after = readCanonicalSchedulerCheckpoint(checkpointFile);
    if (after?.checkpointDigest !== canonical.checkpointDigest
        || !isDeepStrictEqual(after.checkpoint, canonical.checkpoint))
    {
        throw new Error('production summary canonical checkpoint changed during projection');
    }
    return sealContentDigest({
        schema: 'fsusblog.production-summary-projection.v1',
        logicalTier: topology.logicalTier,
        status: 'success',
        spawnEligibility: false,
        qualificationEligible: false,
        topologyDigest: topology.contentDigest,
        ...structuredClone(expected),
        projectionSource: topology.projectionSource,
        evidenceSchema: receipt.schema
    });
}
