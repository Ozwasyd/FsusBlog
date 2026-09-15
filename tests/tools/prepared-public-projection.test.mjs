import assert from 'node:assert/strict';
import test from 'node:test';

import {
    assertNotAuthoritativeReceipt,
    projectPreparedPublicIds
// eslint-disable-next-line import-x/no-relative-parent-imports -- This contract test exercises the canonical prepared-public projection owner.
} from '../../tools/test-fixtures/receipt/index.mjs';

function preparedState({ pagination = false } = {})
{
    const sourceIdentity = {
        commit: 'a'.repeat(40),
        worktreeFingerprint: `sha256:${'b'.repeat(64)}`
    };
    return {
        schema: 'fsusblog.fixture-prepare-state.v1',
        terminalState: 'prepared',
        plan: {
            profileIdentity: { profileId: pagination ? 'runtime-cache-pagination' : 'acceptance-representative' },
            executionIdentity: { runId: 'run-1', namespace: 'ns-1', sourceIdentity },
            catalogDigest: `sha256:${'c'.repeat(64)}`
        },
        producerOutputs: {
            'public-content': {
                producerId: 'public-content',
                strategy: 'transaction-fixture',
                enforceVariantEvidence: true,
                producerVariantPlanDigest: `sha256:${'d'.repeat(64)}`,
                variantIds: pagination
                    ? ['canonical.public.article.pagination-deep', 'canonical.public.article.published']
                    : ['canonical.public.article.published'],
                entityIdentities: [
                    { kind: 'article', id: '11', handle: 'Current article', variantId: 'canonical.public.article.published' },
                    ...(pagination ? [
                        { kind: 'article', id: '90', handle: 'Page 10 boundary', variantId: 'canonical.public.article.pagination-deep' },
                        { kind: 'article', id: '990', handle: 'Page 100 boundary', variantId: 'canonical.public.article.pagination-deep' },
                        { kind: 'article', id: '9990', handle: 'Page 1000 boundary', variantId: 'canonical.public.article.pagination-deep' }
                    ] : []),
                    { kind: 'category', id: '12', handle: 'Current category', variantId: 'canonical.public.article.published' },
                    { kind: 'tag', id: '13', handle: 'Current tag', variantId: 'canonical.public.article.published' }
                ],
                observations: {
                    source: 'service',
                    database: { entities: [] },
                    redis: { keys: [] },
                    cache: { entries: [] }
                },
                projection: {
                    articleId: '11',
                    articleTitle: 'Current article',
                    categoryId: '12',
                    tagId: '13',
                    searchKeyword: 'CURRENT_BODY',
                    ...(pagination ? {
                        pagination: {
                            route: 'article/list/home',
                            sort: 'latest',
                            pageSize: 10,
                            generation: 47,
                            articleCount: 10_023,
                            ownedArticleCount: 10_023,
                            cursors: [
                                { logicalPage: 10, cursor: 'opaque-page-10', boundaryIdentity: { articleId: '90', createTimeUtc: '2026-09-14T08:00:00Z', sortValue: 0, precedingItemCount: 90 } },
                                { logicalPage: 100, cursor: 'opaque-page-100', boundaryIdentity: { articleId: '990', createTimeUtc: '2026-09-14T07:59:00Z', sortValue: 0, precedingItemCount: 990 } },
                                { logicalPage: 1000, cursor: 'opaque-page-1000', boundaryIdentity: { articleId: '9990', createTimeUtc: '2026-09-14T07:58:00Z', sortValue: 0, precedingItemCount: 9990 } }
                            ]
                        }
                    } : {})
                }
            }
        }
    };
}

test('prepared public projection is current-run navigation input, never receipt evidence', () =>
{
    const projection = projectPreparedPublicIds(preparedState());
    assert.equal(projection.schema, 'fsusblog.prepared-public-id-projection.v1');
    assert.equal(projection.articleId, '11');
    assert.equal(projection.namespace, 'ns-1');
    assert.match(projection.projectionDigest, /^sha256:[0-9a-f]{64}$/u);
    assert.throws(() => assertNotAuthoritativeReceipt(projection), /not an authoritative FixtureReceipt/u);
});

test('prepared public projection rejects structural and foreign IDs', () =>
{
    const structural = preparedState();
    structural.producerOutputs['public-content'].structuralOnly = true;
    assert.throws(() => projectPreparedPublicIds(structural), /live public-content producer observations/u);

    const foreign = preparedState();
    foreign.producerOutputs['public-content'].projection.articleId = '999';
    assert.throws(() => projectPreparedPublicIds(foreign), /articleId is not producer-owned/u);
});

test('prepared pagination projection preserves backend cursors and rejects foreign boundaries', () =>
{
    const current = preparedState({ pagination: true });
    const projection = projectPreparedPublicIds(current);
    assert.equal(projection.pagination.generation, 47);
    assert.equal(projection.pagination.pageSize, 10);
    assert.deepEqual(projection.pagination.cursors.map((item) => item.logicalPage), [10, 100, 1000]);
    assert.equal(projection.pagination.cursors[2].cursor, 'opaque-page-1000');

    const foreign = preparedState({ pagination: true });
    foreign.producerOutputs['public-content'].projection.pagination.cursors[2].boundaryIdentity.articleId = '404';
    assert.throws(() => projectPreparedPublicIds(foreign), /logical page 1000 boundary is invalid/u);

    const missing = preparedState({ pagination: true });
    delete missing.producerOutputs['public-content'].projection.pagination;
    assert.throws(() => projectPreparedPublicIds(missing), /pagination projection is missing/u);
});
