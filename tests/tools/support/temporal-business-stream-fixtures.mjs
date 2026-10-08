const { consumerContext, consumerEntityPlan } = await import(new URL('./temporal-entity-consumer-fixtures.mjs', import.meta.url));

/** Isolated ordinary inputs only; does not generate or correct production seed facts. */
export function businessStreamInputs(producerId = 'development-demo', batchSize = 2, plan = consumerEntityPlan(producerId))
{
    const temporalContext = consumerContext(producerId);
    const fixtureIdentity = { producerId, runId: temporalContext.schedulerRunId, namespace: 'ordinary',
        fixtureId: 'entity-stream-consumer-control', planDigest: plan.sourcePlanDigest };
    const { rootNested, ...distribution } = plan.distribution;
    const batches = [];
    for (let start = 0; start < plan.entities.length; start += batchSize)
    {
        const entities = plan.entities.slice(start, start + batchSize);
        const identities = new Set(entities.map((entity) => entity.coordinate.semanticIdentity));
        batches.push({ schema: 'fsusblog.temporal-entity-batch-input.v1', index: batches.length,
            entities, rootNested: rootNested.filter((link) => identities.has(link.commentIdentity)) });
    }
    let opens = 0;
    const source = () =>
    {
        opens++;
        return (async function* replay()
        {
            for (const batch of batches)
            {
                yield structuredClone(batch);
            }
        })();
    };
    return { temporalContext, fixtureIdentity, distribution, source, batches, opens: () => opens };
}
