import { digestCanonical, freezeDeep } from './canonical.mjs';
import { FIXTURE_PREPARE_STATE_SCHEMA, PREPARED_PUBLIC_ID_PROJECTION_SCHEMA } from './schemas.mjs';
import { assertNoSecrets } from './secrets.mjs';

/** Navigation-only projection of a prepared public-content producer, never a verified fixture receipt. */
export function projectPreparedPublicIds(prepareState)
{
    if (prepareState?.schema !== FIXTURE_PREPARE_STATE_SCHEMA
    || prepareState?.terminalState !== 'prepared')
    {
        throw new Error('prepared public ID projection requires a prepared fixture state');
    }

    const output = prepareState.producerOutputs?.['public-content'];
    if (!output
    || output.producerId !== 'public-content'
    || output.strategy !== 'transaction-fixture'
    || output.structuralOnly === true
    || output.fallback === true
    || output.warningOnly === true
    || output.observations?.source === 'local-fallback'
    || !output.observations?.database
    || !output.observations?.redis
    || !output.observations?.cache)
    {
        throw new Error('prepared public ID projection requires live public-content producer observations');
    }

    const publicProjection = output.projection;
    const articleId = String(publicProjection?.articleId ?? '').trim();
    const categoryId = String(publicProjection?.categoryId ?? '').trim();
    const tagId = String(publicProjection?.tagId ?? '').trim();
    const articleTitle = String(publicProjection?.articleTitle ?? '').trim();
    const searchKeyword = String(publicProjection?.searchKeyword ?? '').trim();
    if (!articleId || !categoryId || !tagId || !articleTitle || !searchKeyword)
    {
        throw new Error('prepared public-content projection is incomplete');
    }

    const entities = (output.entityIdentities ?? []).map((entity) => ({
        producerId: 'public-content',
        kind: String(entity.kind ?? ''),
        id: String(entity.id ?? ''),
        handle: entity.handle == null ? null : String(entity.handle),
        variantId: entity.variantId == null ? null : String(entity.variantId)
    }));
    for (const [kind, id] of [
        ['article', articleId],
        ['category', categoryId],
        ['tag', tagId]
    ])
    {
        if (!entities.some((entity) => entity.kind === kind && entity.id === id))
        {
            throw new Error(`prepared public-content projection ${kind}Id is not producer-owned`);
        }
    }

    const plan = prepareState.plan;
    const projection = freezeDeep({
        schema: PREPARED_PUBLIC_ID_PROJECTION_SCHEMA,
        authority: 'derived-from-current-run-prepared-public-content',
        notAuthoritative: true,
        evidenceUse: 'navigation-input-only',
        sourcePrepareStateDigest: digestCanonical(prepareState),
        profileId: plan.profileIdentity?.profileId ?? null,
        runId: plan.executionIdentity?.runId ?? null,
        namespace: plan.executionIdentity?.namespace ?? null,
        sourceIdentity: plan.executionIdentity?.sourceIdentity ?? null,
        catalogDigest: plan.catalogDigest ?? null,
        producerVariantPlanDigest: output.producerVariantPlanDigest ?? null,
        variantIds: freezeDeep([...(output.variantIds ?? [])].map(String).sort()),
        entities: freezeDeep(entities),
        articleId,
        articleTitle,
        categoryId,
        tagId,
        searchKeyword,
        projectionDigest: null
    });
    assertNoSecrets(projection);
    return freezeDeep({
        ...projection,
        projectionDigest: digestCanonical({ ...projection, projectionDigest: undefined })
    });
}
