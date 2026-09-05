import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    ARTICLE_BULK_REGISTRY_VERSION,
    articleBulkOperationRegistry,
    canonicalDigest,
    normalizeOperationParameters,
    operationById,
    validateArticleBulkOperationRegistry
} from '../../tools/article-bulk/contract.mjs';

const digest = (value) => canonicalDigest({ value });

function parametersFor(operationId)
{
    if (operationId.startsWith('category.')) return { categoryId: 'category-1' };
    if (operationId.startsWith('tag.')) return { tagId: 'tag-1' };
    if (operationId === 'property.set')
    {
        return { definitionId: 'property-1', typedValueDigest: digest('typed-value') };
    }
    if (operationId === 'property.clear') return { definitionId: 'property-1' };
    if (operationId === 'content-check.run') return { checkIds: ['links', 'spelling'] };
    if (operationId.endsWith('.reindex')) return { indexAuthorityDigest: digest('index') };
    if (operationId === 'schedule.change') return { scheduledAtUtc: '2030-02-01T00:00:00.000Z' };
    return { reasonCode: 'editor-request' };
}

function expectReason(reasonCode, action)
{
    assert.throws(action, (error) => error?.reasonCode === reasonCode);
}

function reseal(registry)
{
    delete registry.contentDigest;
    registry.contentDigest = canonicalDigest(registry);
    return registry;
}

test('registry is the exact closed versioned first operation set and has no default strategy', () =>
{
    assert.equal(ARTICLE_BULK_REGISTRY_VERSION, 1);
    assert.equal(articleBulkOperationRegistry.defaultStrategy, null);
    assert.equal(articleBulkOperationRegistry.operations.length, 14);
    assert.deepEqual(
        articleBulkOperationRegistry.operations.filter((entry) => entry.strategy === 'all-or-nothing')
            .map((entry) => entry.id),
        [
            'lifecycle.archive',
            'lifecycle.restore',
            'lifecycle.inbox-to-draft',
            'lifecycle.draft-to-inbox',
            'schedule.change'
        ]
    );
    for (const operation of articleBulkOperationRegistry.operations)
    {
        assert.equal(operation.maximumBatchSize, 10000);
        assert.equal(operation.dependencies.query, 'plan-resolution-only');
        assert.equal(operation.itemReceiptSchema, 'fsusblog.article-bulk.item-receipt.v1');
        assert.equal(operation.aggregateReceiptSchema, 'fsusblog.article-bulk.aggregate-receipt.v1');
        assert.equal(operation.strategy === 'per-item-isolated',
            !['lifecycle.archive', 'lifecycle.restore', 'lifecycle.inbox-to-draft',
                'lifecycle.draft-to-inbox', 'schedule.change'].includes(operation.id));
    }
});

test('independent validator rejects recomputed mapping, owner, side-effect and registry-set mutations', () =>
{
    for (const mutate of [
        (registry) => { registry.operations[0].strategy = 'all-or-nothing'; },
        (registry) => { registry.operations[0].sideEffectOwners = ['rogue-owner']; },
        (registry) => { delete registry.operations[0].commandOwner; },
        (registry) => { registry.commandOwners.push(structuredClone(registry.commandOwners[0])); },
        (registry) => {
            registry.operations.push({ ...structuredClone(registry.operations[0]), id: 'new.operation' });
        }
    ])
    {
        const registry = structuredClone(articleBulkOperationRegistry);
        mutate(registry);
        expectReason(
            Object.hasOwn(registry.operations[0], 'commandOwner') ? 'article-bulk.registry-invalid'
                : 'article-bulk.schema-invalid',
            () => validateArticleBulkOperationRegistry(reseal(registry))
        );
    }
});

test('every registered operation has one closed parameter codec and no runtime strategy override', () =>
{
    for (const operation of articleBulkOperationRegistry.operations)
    {
        const normalized = normalizeOperationParameters(operation.id, parametersFor(operation.id));
        assert.deepEqual(Object.keys(normalized), operation.parameters.fields.map((field) => field.name));
    }
    expectReason('article-bulk.schema-invalid', () => normalizeOperationParameters(
        'category.add',
        { categoryId: 'category-1', tagId: 'tag-1' }
    ));
    expectReason('article-bulk.value-invalid', () => normalizeOperationParameters(
        'content-check.run',
        { checkIds: [] }
    ));
});

test('unknown body, publish, template, SQL, script, AI and arbitrary endpoint operations fail closed', () =>
{
    for (const operationId of [
        'body.replace',
        'publish.bypass',
        'template.apply',
        'sql.execute',
        'script.run',
        'ai.rewrite',
        'endpoint.invoke'
    ])
    {
        expectReason('article-bulk.operation-unsupported', () => operationById(operationId));
    }
});

test('diagnostic and reindex results cannot claim article business mutation', () =>
{
    for (const operationId of ['content-check.run', 'relation.reindex', 'search.reindex'])
    {
        const operation = operationById(operationId);
        assert.equal(operation.mutatesBusinessState, false);
        assert.notEqual(operation.resultKind, 'article-revision');
    }
});

test('registry version and digest drift are independently rejected', () =>
{
    const versionDrift = structuredClone(articleBulkOperationRegistry);
    versionDrift.version = 2;
    expectReason('article-bulk.registry-invalid', () =>
        validateArticleBulkOperationRegistry(reseal(versionDrift)));
    const digestTamper = structuredClone(articleBulkOperationRegistry);
    digestTamper.contentDigest = digest('forged');
    expectReason('article-bulk.registry-tampered', () =>
        validateArticleBulkOperationRegistry(digestTamper));
});
