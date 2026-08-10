import assert from 'node:assert/strict';
import test from 'node:test';

import {
    assertNotAuthoritativeReceipt,
    projectPreparedPublicIds
// eslint-disable-next-line import-x/no-relative-parent-imports -- This contract test exercises the canonical prepared-public projection owner.
} from '../../tools/test-fixtures/receipt/index.mjs';

function preparedState()
{
    const sourceIdentity = {
        commit: 'a'.repeat(40),
        worktreeFingerprint: `sha256:${'b'.repeat(64)}`
    };
    return {
        schema: 'fsusblog.fixture-prepare-state.v1',
        terminalState: 'prepared',
        plan: {
            profileIdentity: { profileId: 'acceptance-representative' },
            executionIdentity: { runId: 'run-1', namespace: 'ns-1', sourceIdentity },
            catalogDigest: `sha256:${'c'.repeat(64)}`
        },
        producerOutputs: {
            'public-content': {
                producerId: 'public-content',
                strategy: 'transaction-fixture',
                enforceVariantEvidence: true,
                producerVariantPlanDigest: `sha256:${'d'.repeat(64)}`,
                variantIds: ['canonical.public.article.published'],
                entityIdentities: [
                    { kind: 'article', id: '11', handle: 'Current article', variantId: 'canonical.public.article.published' },
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
                    searchKeyword: 'CURRENT_BODY'
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
