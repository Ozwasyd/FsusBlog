import assert from 'node:assert/strict';
import { test } from 'node:test';

const { defaultTimeoutPolicyDigest, qualificationTemporalContext } = await import(new URL('../../tools/test/temporal-context.mjs', import.meta.url));
const { readTemporalShapeCatalog } = await import(new URL('../../tools/test/temporal-shape-catalog.mjs', import.meta.url));
const { bindDataScaleTemporalBusinessFields, dataScaleTemporalFieldMappings } = await import(new URL('../../tools/data-scale/temporal-business-binding.mjs', import.meta.url));
const { bindDemoTemporalBusinessFields, demoTemporalFieldMappings, prepareDemoTemporalBinding } = await import(new URL('../../tools/test-fixtures/producers/demo-temporal-binding.mjs', import.meta.url));
const { prepareDemoPublic, verifyDemoPublic } = await import(new URL('../../tools/test-fixtures/producers/demo-public-producer.mjs', import.meta.url));

function context(producerId)
{
    return qualificationTemporalContext({
        sourceCommit: 'a'.repeat(40),
        sourceFingerprint: `sha256:${'b'.repeat(64)}`,
        producerId,
        schedulerRunId: 'demo-scale-test',
        businessEpochUtc: '2024-02-29T23:59:59.000Z',
        locale: 'en-US',
        uiLocale: 'en-US',
        timeoutPolicyDigest: defaultTimeoutPolicyDigest()
    });
}

test('demo and scale field mappings reference only catalog-owned business roles', () =>
{
    const catalog = readTemporalShapeCatalog().catalog;
    for (const mapping of [...demoTemporalFieldMappings, ...dataScaleTemporalFieldMappings])
    {
        const role = catalog.roleRegistry.find((candidate) => candidate.id === mapping.roleId);
        assert.equal(role?.clockKind, 'business-wall');
        assert.equal(role?.semanticEffect, 'included');
        assert.equal('offsetMilliseconds' in mapping, false);
    }
    assert.equal(demoTemporalFieldMappings.find((mapping) => mapping.field === 'article-revision.created-at').roleId, 'article.revision');
    assert.equal(demoTemporalFieldMappings.find((mapping) => mapping.field === 'article-publication.published-at').roleId, 'article.publication');
    assert.equal(demoTemporalFieldMappings.find((mapping) => mapping.field === 'article-rights-snapshot.created-at').roleId, 'article.revision');
    assert.equal(demoTemporalFieldMappings.find((mapping) => mapping.field === 'comment-revision.created-at').roleId, 'comment.created');
});

test('demo cannot claim a binding before canonical producer registration exists', () =>
{
    assert.throws(() => prepareDemoTemporalBinding({
        temporalContext: context('development-demo'),
        namespace: 'demo-scale-test',
        runIdentity: 'demo-scale-test',
        plan: { variantPlanDigest: `sha256:${'c'.repeat(64)}` }
    }), /temporal.*|has no semantic temporal role binding/u);
});

test('domain consumers refuse cross-producer reuse and missing held artifact authority', () =>
{
    assert.throws(() => bindDemoTemporalBusinessFields({ temporalContext: context('scale-data') }), /development-demo context/u);
    assert.throws(() => bindDataScaleTemporalBusinessFields({ temporalContext: context('development-demo') }), /scale-data context/u);
    assert.throws(() => bindDataScaleTemporalBusinessFields({ temporalContext: context('scale-data') }), /independently held/u);
});

test('sealed demo preparation refuses unimplemented roles before cleanup or HTTP writes', async () =>
{
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = () =>
    {
        requests += 1;
        throw new Error('unexpected business write');
    };
    try
    {
        await assert.rejects(prepareDemoPublic({
            temporalContext: context('development-demo'),
            namespace: 'demo-scale-test',
            runIdentity: 'demo-scale-test',
            plan: { variantPlanDigest: `sha256:${'c'.repeat(64)}` },
            previousProducerReceipt: { deliberately: 'invalid' },
            handles: { baseUrl: 'http://127.0.0.1:7568', localDemoFixtureSecret: 'test-only' }
        }), /has no semantic temporal role binding/u);
        assert.equal(requests, 0);
    }
    finally
    {
        globalThis.fetch = originalFetch;
    }
});

test('sealed demo verification cannot promote a result with unimplemented temporal roles', async () =>
{
    await assert.rejects(verifyDemoPublic({
        temporalContext: context('development-demo'),
        namespace: 'demo-scale-test',
        runIdentity: 'demo-scale-test',
        plan: { variantPlanDigest: `sha256:${'c'.repeat(64)}` }
    }, { temporalBusinessFields: {} }), /has no semantic temporal role binding/u);
});
