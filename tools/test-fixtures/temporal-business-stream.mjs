const { digestCanonical, TemporalContractError } = await import(new URL('../test/temporal-context.mjs', import.meta.url));
const { describeTemporalEntityPartition, sealTemporalEntityStreamPlan, resolveTemporalEntityStream } = await import(new URL('../test/temporal-entity-stream.mjs', import.meta.url));
const { createTemporalEntityTransport, createTemporalDomainProducerReceipt } = await import(new URL('../test/temporal-role-resolver.mjs', import.meta.url));
const { bindTemporalEntityBatchBusinessFields } = await import(new URL('./temporal-business-fields.mjs', import.meta.url));

function fail(message)
{
    throw new TemporalContractError('temporal.business-stream-invalid', message);
}

/** Describe the first source pass without retaining records or assigning business facts. */
export async function sealTemporalBusinessFieldStream({ temporalContext, fixtureIdentity, distribution, source, signal })
{
    signal?.throwIfAborted();
    if (typeof source !== 'function')
    {
        fail('stream ingress requires a replayable ordinary source factory');
    }
    const partitions = [];
    let entityStartIndex = 0;
    let relationshipStartIndex = 0;
    for await (const input of source())
    {
        signal?.throwIfAborted();
        const partition = describeTemporalEntityPartition(input, { entityStartIndex, relationshipStartIndex });
        if (partition.index !== partitions.length || partition.entityCount + partition.relationshipCount === 0)
        {
            fail('source pass must retain its original nonempty partition order');
        }
        partitions.push(partition);
        entityStartIndex += partition.entityCount;
        relationshipStartIndex += partition.relationshipCount;
    }
    signal?.throwIfAborted();
    return sealTemporalEntityStreamPlan({ temporalContext, fixtureIdentity, distribution, partitions });
}

/**
 * Replay the exact sealed source through the sole global validator. Each bounded
 * callback receives business fields and the canonical .NET/file/env transport.
 * Root completion is emitted only after all handlers finish; no runtime claim.
 */
export async function resolveTemporalBusinessFieldStream({ temporalContext, fixtureIdentity, distribution,
    source, streamPlan, fieldMappings, onBatch, signal })
{
    signal?.throwIfAborted();
    if (typeof source !== 'function' || !Array.isArray(fieldMappings) || typeof onBatch !== 'function')
    {
        fail('stream ingress requires source replay, a field binder and a bounded output handler');
    }
    const fixture = structuredClone(fixtureIdentity);
    const mappings = structuredClone(fieldMappings);
    const plan = structuredClone(streamPlan ?? await sealTemporalBusinessFieldStream({
        temporalContext, fixtureIdentity: fixture, distribution, source, signal }));
    const streamPlanDigest = digestCanonical(plan);
    const manifest = await resolveTemporalEntityStream({ temporalContext, fixtureIdentity: fixture,
        streamPlan: plan, batches: source(), signal,
        async onBatch(artifact)
        {
            signal?.throwIfAborted();
            const binding = bindTemporalEntityBatchBusinessFields({ temporalContext, artifact, fieldMappings: mappings, expected: { ...fixture,
                streamPlanDigest, catalogDigest: plan.catalogDigest, shapeDigest: plan.shapeDigest,
                partition: plan.partitions[artifact.batch.index] } });
            // Pass the ORIGINAL callback object to the canonical carrier creator.
            const transport = createTemporalEntityTransport({ artifact, temporalContext });
            await onBatch(Object.freeze({ binding, transport }));
            signal?.throwIfAborted();
        } });
    signal?.throwIfAborted();
    const receipt = createTemporalDomainProducerReceipt(manifest, { temporalContext });
    return Object.freeze({ streamPlan: plan, manifest, receipt, qualificationEligible: false });
}
