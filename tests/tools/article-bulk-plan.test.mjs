import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canonicalDigest } from '../../tools/article-bulk/contract.mjs';
import {
    ARTICLE_BULK_ITEM_CHUNK_SIZE,
    ARTICLE_BULK_PLAN_REQUEST_SCHEMA,
    createArticleBulkPlan,
    verifyArticleBulkPlan
} from '../../tools/article-bulk/plan.mjs';

const digest = (value) => canonicalDigest({ value });
const actor = Object.freeze({
    userId: 'user-1',
    siteId: 'site-1',
    authorityDigest: digest('actor-authority')
});
const source = Object.freeze({ commit: '1'.repeat(40), buildDigest: digest('build') });
const timing = Object.freeze({
    createdAtUtc: '2030-01-01T00:00:00.000Z',
    expiresAtUtc: '2030-01-01T01:00:00.000Z'
});

function parametersFor(operationId)
{
    return operationId === 'lifecycle.archive'
        ? { reasonCode: 'editor-request' }
        : { categoryId: 'category-1' };
}

function authorities({ blockedIds = new Set(), revisionSuffix = '', calls = [] } = {})
{
    return {
        selection: {
            async resolve({ selection })
            {
                calls.push({ owner: 'selection', size: selection.articleIds?.length ?? null });
                const articleIds = selection.articleIds ?? ['article-1', 'article-2'];
                return {
                    authorityDigest: digest('selection-authority'),
                    resolutionDigest: digest({ selection, articleIds }),
                    articleIds
                };
            }
        },
        articles: {
            async observe({ articleIds, ordinalStart })
            {
                calls.push({ owner: 'articles', size: articleIds.length, ordinalStart });
                return {
                    authorityDigest: digest(`article-authority-${ordinalStart}`),
                    items: articleIds.map((articleId) => ({
                        articleId,
                        exists: true,
                        siteId: actor.siteId,
                        revision: `revision-${articleId}${revisionSuffix}`,
                        lifecycle: 'draft',
                        permitted: !blockedIds.has(articleId),
                        applicable: true,
                        permissionDigest: digest(`permission-${articleId}`),
                        stateDigest: digest(`state-${articleId}${revisionSuffix}`),
                        dependencyDigests: [digest(`dependency-${articleId}`)]
                    }))
                };
            }
        }
    };
}

async function makePlan({
    operationId = 'category.add',
    articleIds = ['article-1', 'article-2'],
    selection,
    productionAuthorities,
    blockedIds,
    requestedTiming = timing
} = {})
{
    return createArticleBulkPlan({
        request: {
            schema: ARTICLE_BULK_PLAN_REQUEST_SCHEMA,
            operationId,
            parameters: parametersFor(operationId),
            selection: selection ?? { kind: 'explicit', articleIds },
            actor,
            source,
            policyDigest: digest('policy'),
            permissionPolicyDigest: digest('permission-policy'),
            timing: requestedTiming
        },
        authorities: productionAuthorities ?? authorities({ blockedIds })
    });
}

test('explicit, current-page, saved-view and query sources resolve once into one immutable plan', async () =>
{
    const selections = [
        { kind: 'explicit', articleIds: ['article-1', 'article-2'] },
        { kind: 'current-page', pageIdentityDigest: digest('page'), articleIds: ['article-1', 'article-2'] },
        { kind: 'saved-view', savedViewId: 'view-1', savedViewRevision: 'view-rev-1', savedViewDigest: digest('view') },
        { kind: 'query', queryId: 'query-1', queryDigest: digest('query') }
    ];
    for (const selection of selections)
    {
        const calls = [];
        const plan = await makePlan({ selection, productionAuthorities: authorities({ calls }) });
        assert.equal(plan.request.selection.kind, selection.kind);
        assert.equal(plan.resolution.articleCount, 2);
        assert.deepEqual(calls.map((entry) => entry.owner), ['selection', 'articles']);
        assert.ok(Object.isFrozen(plan));
    }
});

test('0, 1, 100 and 10000 selections stay bounded at 250-item authority batches', async () =>
{
    for (const count of [0, 1, 100])
    {
        const plan = await makePlan({
            articleIds: Array.from({ length: count }, (_, index) => `article-${index}`)
        });
        assert.equal(plan.impact.totalCount, count);
        assert.equal(plan.impact.executable, count > 0);
    }
    const calls = [];
    const articleIds = Array.from({ length: 10000 }, (_, index) => `article-${index}`);
    const plan = await makePlan({ articleIds, productionAuthorities: authorities({ calls }) });
    const articleCalls = calls.filter((entry) => entry.owner === 'articles');
    assert.equal(plan.itemChunks.length, 10000 / ARTICLE_BULK_ITEM_CHUNK_SIZE);
    assert.equal(articleCalls.length, 10000 / ARTICLE_BULK_ITEM_CHUNK_SIZE);
    assert.ok(articleCalls.every((entry) => entry.size <= ARTICLE_BULK_ITEM_CHUNK_SIZE));
});

test('all-or-nothing blocks the set with zero-write while per-item retains visible blocked items', async () =>
{
    const blockedIds = new Set(['article-2']);
    const atomic = await makePlan({ operationId: 'lifecycle.archive', blockedIds });
    assert.equal(atomic.impact.executable, false);
    assert.equal(atomic.impact.zeroWriteRequired, true);
    const isolated = await makePlan({ blockedIds });
    assert.equal(isolated.impact.executable, true);
    assert.deepEqual(isolated.itemChunks[0].items[1].reasonCodes, ['permission.denied']);
});

test('preflight freezes existence, site, revision, lifecycle, permission, applicability and proposed change', async () =>
{
    const articleIds = ['missing', 'scope', 'denied', 'lifecycle', 'inapplicable'];
    const productionAuthorities = authorities();
    productionAuthorities.articles.observe = async ({ articleIds: batch }) => ({
        authorityDigest: digest('special-authority'),
        items: batch.map((articleId) => articleId === 'missing' ? {
            articleId,
            exists: false,
            siteId: null,
            revision: null,
            lifecycle: null,
            permitted: false,
            applicable: false,
            permissionDigest: null,
            stateDigest: null,
            dependencyDigests: []
        } : {
            articleId,
            exists: true,
            siteId: articleId === 'scope' ? 'site-2' : actor.siteId,
            revision: `revision-${articleId}`,
            lifecycle: articleId === 'lifecycle' ? 'published' : 'draft',
            permitted: articleId !== 'denied',
            applicable: articleId !== 'inapplicable',
            permissionDigest: digest(`permission-${articleId}`),
            stateDigest: digest(`state-${articleId}`),
            dependencyDigests: [digest(`dependency-${articleId}`)]
        })
    });
    const plan = await makePlan({ articleIds, productionAuthorities });
    assert.deepEqual(plan.itemChunks[0].items.map((item) => item.reasonCodes), [
        ['article.not-found'],
        ['article.scope-mismatch'],
        ['permission.denied'],
        ['lifecycle.ineligible'],
        ['operation.inapplicable']
    ]);
    assert.equal(plan.itemChunks[0].items[0].proposedChangeDigest, null);
    assert.match(plan.itemChunks[0].items[1].proposedChangeDigest, /^sha256:/u);
    assert.doesNotMatch(JSON.stringify(plan), /title|body|snippet|secret/iu);
});

test('independent verifier requires current time and rejects query, revision and policy identity drift', async () =>
{
    const plan = await makePlan();
    await assert.rejects(() => verifyArticleBulkPlan({ plan, authorities: authorities() }),
        (error) => error?.reasonCode === 'article-bulk.value-invalid');
    await assert.rejects(() => verifyArticleBulkPlan({
        plan,
        authorities: authorities({ revisionSuffix: '-changed' }),
        nowUtc: '2030-01-01T00:20:00.000Z'
    }), (error) => error?.reasonCode === 'article-bulk.plan-drift');
    const queryPlan = await makePlan({
        selection: { kind: 'query', queryId: 'query-1', queryDigest: digest('query') }
    });
    const changedQuery = authorities();
    changedQuery.selection.resolve = async () => ({
        authorityDigest: digest('selection-authority'),
        resolutionDigest: digest('changed-query-resolution'),
        articleIds: ['article-1', 'article-2', 'article-3']
    });
    await assert.rejects(() => verifyArticleBulkPlan({
        plan: queryPlan,
        authorities: changedQuery,
        nowUtc: '2030-01-01T00:20:00.000Z'
    }), (error) => error?.reasonCode === 'article-bulk.plan-drift');
    const policyMutation = structuredClone(plan);
    policyMutation.request.policyDigest = digest('new-policy');
    await assert.rejects(() => verifyArticleBulkPlan({
        plan: policyMutation,
        authorities: authorities(),
        nowUtc: '2030-01-01T00:20:00.000Z'
    }), (error) => error?.reasonCode === 'article-bulk.plan-request-tampered');
});

test('expiry and replan identity are explicit and old plans never refresh themselves', async () =>
{
    const plan = await makePlan();
    await assert.rejects(() => verifyArticleBulkPlan({
        plan,
        authorities: authorities(),
        nowUtc: timing.expiresAtUtc
    }), (error) => error?.reasonCode === 'article-bulk.plan-expired');
    const replacement = await makePlan({ requestedTiming: {
        createdAtUtc: '2030-01-01T02:00:00.000Z',
        expiresAtUtc: '2030-01-01T03:00:00.000Z'
    } });
    assert.notEqual(replacement.planDigest, plan.planDigest);
    assert.notEqual(replacement.request.requestDigest, plan.request.requestDigest);
});

test('UI order, mixed strategy, private fields and item mutation fail closed', async () =>
{
    const changedOrder = authorities();
    changedOrder.selection.resolve = async () => ({
        authorityDigest: digest('selection-authority'),
        resolutionDigest: digest('resolution'),
        articleIds: ['article-2', 'article-1']
    });
    await assert.rejects(() => makePlan({
        selection: {
            kind: 'current-page',
            pageIdentityDigest: digest('page'),
            articleIds: ['article-1', 'article-2']
        },
        productionAuthorities: changedOrder
    }), (error) => error?.reasonCode === 'article-bulk.selection-drift');

    const privateFields = authorities();
    const observe = privateFields.articles.observe;
    privateFields.articles.observe = async (input) => {
        const value = await observe(input);
        value.items[0].title = 'private';
        return value;
    };
    await assert.rejects(() => makePlan({ productionAuthorities: privateFields }),
        (error) => error?.reasonCode === 'article-bulk.schema-invalid');

    const plan = await makePlan();
    const mixed = structuredClone(plan);
    mixed.operation.strategy = 'all-or-nothing';
    await assert.rejects(() => verifyArticleBulkPlan({
        plan: mixed, authorities: authorities(), nowUtc: '2030-01-01T00:20:00.000Z'
    }), (error) => error?.reasonCode === 'article-bulk.operation-drift');
    const itemMutation = structuredClone(plan);
    itemMutation.itemChunks[0].items[0].expectedRevision = 'revision-forged';
    await assert.rejects(() => verifyArticleBulkPlan({
        plan: itemMutation, authorities: authorities(), nowUtc: '2030-01-01T00:20:00.000Z'
    }), (error) => error?.reasonCode === 'article-bulk.plan-invalid');
});
