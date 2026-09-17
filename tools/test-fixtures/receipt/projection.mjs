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
function projectDeepPaginationInput(raw, entities, required)
{
    if (raw == null)
    {
        if (required)
        {
            throw new Error('prepared runtime-cache-pagination projection is missing');
        }
        return null;
    }
    const pageSize = raw.pageSize;
    const generation = raw.generation;
    const articleCount = raw.articleCount;
    const ownedArticleCount = raw.ownedArticleCount;
    if (raw.route !== 'article/list/home'
    || raw.sort !== 'latest'
    || pageSize !== 10
    || !Number.isSafeInteger(generation)
    || generation < 0
    || !Number.isSafeInteger(articleCount)
    || articleCount < 10_020
    || !Number.isSafeInteger(ownedArticleCount)
    || ownedArticleCount < 10_020)
    {
        throw new Error('prepared runtime-cache-pagination generation/size/count binding is invalid');
    }

    const expectedPages = [10, 100, 1000];
    const cursors = raw.cursors;
    if (!Array.isArray(cursors) || cursors.length !== expectedPages.length)
    {
        throw new Error('prepared runtime-cache-pagination requires page 10/100/1000 cursors');
    }
    const projectedCursors = cursors.map((pageCursor, index) =>
    {
        const expectedPage = expectedPages[index];
        const cursor = String(pageCursor?.cursor ?? '');
        const boundary = pageCursor?.boundaryIdentity ?? {};
        const articleId = String(boundary.articleId ?? '');
        if (pageCursor?.logicalPage !== expectedPage
        || !cursor
        || cursor.length > 512
        || !entities.some((entity) => entity.kind === 'article' && entity.id === articleId)
        || !String(boundary.createTimeUtc ?? '').trim()
        || boundary.sortValue !== 0
        || boundary.precedingItemCount !== (expectedPage - 1) * pageSize)
        {
            throw new Error(`prepared runtime-cache-pagination logical page ${expectedPage} boundary is invalid`);
        }
        return {
            logicalPage: expectedPage,
            cursor,
            boundaryIdentity: {
                articleId,
                createTimeUtc: String(boundary.createTimeUtc),
                sortValue: 0,
                precedingItemCount: boundary.precedingItemCount
            }
        };
    });
    return {
        route: raw.route,
        sort: raw.sort,
        pageSize,
        generation,
        articleCount,
        ownedArticleCount,
        cursors: projectedCursors
    };
}

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
    const profileId = plan.profileIdentity?.profileId ?? null;
    const pagination = projectDeepPaginationInput(
        publicProjection?.pagination,
        entities,
        profileId === 'runtime-cache-pagination');
    const projection = freezeDeep({
        schema: PREPARED_PUBLIC_ID_PROJECTION_SCHEMA,
        authority: 'derived-from-current-run-prepared-public-content',
        notAuthoritative: true,
        evidenceUse: 'navigation-input-only',
        sourcePrepareStateDigest: digestCanonical(prepareState),
        profileId,
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
        ...(pagination ? { pagination } : {}),
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
