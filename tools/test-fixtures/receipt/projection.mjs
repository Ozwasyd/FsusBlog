/**
 * Narrow ID projection from a verified FixtureReceipt (#1710).
 *
 * Projections are consumer convenience only — never authoritative receipt evidence.
 */

import { digestCanonical, freezeDeep } from './canonical.mjs';
import { validateFixtureReceipt } from './fixture-receipt.mjs';
import { writePrivateJson } from './private-io.mjs';
import {
    FIXTURE_ID_PROJECTION_SCHEMA,
    FIXTURE_PREPARE_STATE_SCHEMA,
    PREPARED_PUBLIC_ID_PROJECTION_SCHEMA
} from './schemas.mjs';
import { assertNoSecrets } from './secrets.mjs';

/**
 * Deterministically project stable entity IDs from a verified receipt.
 */
export function projectFixtureIds(receipt, {
    catalogs,
    requireVerified = true
} = {})
{
    const validated = validateFixtureReceipt(receipt, { catalogs, requireVerified });
    if (validated.terminalStatus !== 'verified')
    {
        throw new Error('ID projection requires a verified FixtureReceipt');
    }

    const entities = [];
    for (const producerReceipt of validated.producerReceipts ?? [])
    {
        for (const entity of producerReceipt.entityIdentities ?? [])
        {
            entities.push({
                producerId: producerReceipt.producerId,
                kind: entity.kind,
                id: entity.id,
                handle: entity.handle ?? null,
                variantId: entity.variantId ?? null,
                owner: entity.owner ?? null
            });
        }
    }
    entities.sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`));

    const byKind = {};
    for (const entity of entities)
    {
        if (!byKind[entity.kind])
        {
            byKind[entity.kind] = [];
        }
        byKind[entity.kind].push(entity.id);
    }

    const projection = freezeDeep({
        schema: FIXTURE_ID_PROJECTION_SCHEMA,
        authority: 'derived-from-verified-fixture-receipt',
        notAuthoritative: true,
        sourceReceiptDigest: validated.receiptDigest,
        profileId: validated.profileIdentity.profileId,
        runId: validated.executionIdentity.runId,
        namespace: validated.executionIdentity.namespace,
        catalogDigest: validated.catalogDigest,
        entities: Object.freeze(entities.map((item) => freezeDeep(item))),
        idsByKind: freezeDeep(byKind),
        // Convenience single-ID fields when exactly one article/category/tag exists.
        articleId: byKind.article?.length === 1 ? byKind.article[0] : null,
        categoryId: byKind.category?.length === 1 ? byKind.category[0] : null,
        tagId: byKind.tag?.length === 1 ? byKind.tag[0] : null,
        projectionDigest: null
    });

    assertNoSecrets(projection);
    const projectionDigest = digestCanonical({
        ...projection,
        projectionDigest: undefined
    });
    return freezeDeep({ ...projection, projectionDigest });
}

export function writeFixtureIdProjection(file, receipt, options = {})
{
    const projection = projectFixtureIds(receipt, options);
    writePrivateJson(file, projection, { label: 'fixture-id-projection' });
    return projection;
}

/**
 * Navigation-only projection from the current run's prepared public-content
 * producer. This never stands in for a verified FixtureReceipt.
 */
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

export function writePreparedPublicIdProjection(file, prepareState)
{
    const projection = projectPreparedPublicIds(prepareState);
    writePrivateJson(file, projection, { label: 'prepared-public-id-projection' });
    return projection;
}

/**
 * Fail closed if a consumer treats a projection document as a verified receipt.
 */
export function assertNotAuthoritativeReceipt(document)
{
    if (document?.schema === FIXTURE_ID_PROJECTION_SCHEMA
    || document?.schema === PREPARED_PUBLIC_ID_PROJECTION_SCHEMA
    || document?.notAuthoritative === true)
    {
        throw new Error('fixture ID projection is not an authoritative FixtureReceipt');
    }
    if (document?.schema === 'fsusblog.fixture-receipt.v1')
    {
        throw new Error('retired fixture receipt schema cannot authorize fixtures');
    }
}
