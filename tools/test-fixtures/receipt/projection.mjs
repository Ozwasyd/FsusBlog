/**
 * Narrow ID projection from a verified FixtureReceipt (#1710).
 *
 * Projections are consumer convenience only — never authoritative receipt evidence.
 */

import { digestCanonical, freezeDeep } from './canonical.mjs';
import { validateFixtureReceipt } from './fixture-receipt.mjs';
import { runPostcondition } from './postconditions.mjs';
import { projectPreparedPublicIds } from './prepared-public-projection-contract.mjs';
import { writePrivateJson } from './private-io.mjs';
import {
    FIXTURE_ID_PROJECTION_SCHEMA,
    PREPARED_PUBLIC_ID_PROJECTION_SCHEMA
} from './schemas.mjs';
import { assertNoSecrets } from './secrets.mjs';

export { projectPreparedPublicIds } from './prepared-public-projection-contract.mjs';

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

    const publicReceipt = validated.producerReceipts.find((item) => item.producerId === 'public-content');
    const requiresPagination = publicReceipt?.providedCapabilities.includes('public.article.pagination-deep');
    let pagination = null;
    if (requiresPagination)
    {
        const database = publicReceipt.databaseObservation ?? publicReceipt.observations?.database;
        const checked = runPostcondition('article-pagination-deep', { observations: { database } });
        if (!checked.ok)
        {
            throw new Error(`verified pagination projection rejected: ${checked.reason}`);
        }
        const keyset = database.entities.find((item) => item.kind === 'pagination-keyset'
            && item.owned !== false
            && (item.capabilityHint === 'article-pagination-deep' || item.postconditionId === 'article-pagination-deep'));
        const fields = keyset.fields;
        pagination = {
            route: fields.route,
            sort: fields.sort,
            pageSize: fields.pageSize,
            generation: fields.generation,
            articleCount: fields.articleCount,
            ownedArticleCount: fields.ownedArticleCount,
            cursors: fields.cursors
        };
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
        ...(pagination ? { pagination } : {}),
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
