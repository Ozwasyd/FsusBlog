import { createHash } from 'node:crypto';

export const ARTICLE_BULK_REGISTRY_SCHEMA = 'fsusblog.article-bulk.operation-registry.v1';
export const ARTICLE_BULK_REGISTRY_VERSION = 1;
export const ARTICLE_BULK_STRATEGIES = Object.freeze([
    'all-or-nothing',
    'per-item-isolated'
]);

const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const stableIdPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const fieldNamePattern = /^[a-z][A-Za-z0-9]*$/u;
const opaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const rfc3339Pattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

export class ArticleBulkContractError extends Error
{
    constructor(reasonCode, message, details = {})
    {
        super(`${reasonCode}: ${message}`);
        this.name = 'ArticleBulkContractError';
        this.reasonCode = reasonCode;
        this.details = details;
    }
}

export function fail(reasonCode, message, details = {})
{
    throw new ArticleBulkContractError(reasonCode, message, details);
}

export function plainObject(value)
{
    if (value === null || typeof value !== 'object' || Array.isArray(value))
    {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function compareUtf8(left, right)
{
    return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

export function canonicalJson(value)
{
    if (value === null || typeof value === 'boolean' || typeof value === 'string')
    {
        return JSON.stringify(value);
    }
    if (typeof value === 'number')
    {
        if (!Number.isFinite(value))
        {
            fail('article-bulk.canonical-invalid', 'canonical JSON rejects non-finite numbers');
        }
        return JSON.stringify(Object.is(value, -0) ? 0 : value);
    }
    if (Array.isArray(value))
    {
        return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
    }
    if (plainObject(value))
    {
        return `{${Object.keys(value).sort(compareUtf8).map((key) =>
            `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
    fail('article-bulk.canonical-invalid', 'canonical JSON only accepts JSON values');
}

export function canonicalDigest(value)
{
    return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

export function deepFreeze(value)
{
    if (Array.isArray(value))
    {
        for (const entry of value)
        {
            deepFreeze(entry);
        }
        return Object.freeze(value);
    }
    if (plainObject(value))
    {
        for (const entry of Object.values(value))
        {
            deepFreeze(entry);
        }
        return Object.freeze(value);
    }
    return value;
}

export function exactKeys(value, required, label, optional = [])
{
    if (!plainObject(value))
    {
        fail('article-bulk.schema-invalid', `${label} must be an object`);
    }
    const allowed = new Set([...required, ...optional]);
    const missing = required.filter((field) => !Object.hasOwn(value, field));
    const unknown = Object.keys(value).filter((field) => !allowed.has(field)).sort(compareUtf8);
    if (missing.length > 0 || unknown.length > 0)
    {
        fail('article-bulk.schema-invalid', `${label} fields are not closed exact`, {
            label,
            missing,
            unknown
        });
    }
    return value;
}

export function requiredText(value, field, maximumLength = 256)
{
    if (typeof value !== 'string' || value.length === 0 || value.length > maximumLength
        || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value))
    {
        fail('article-bulk.value-invalid', `${field} must be non-empty exact text`);
    }
    return value;
}

export function stableId(value, field)
{
    const text = requiredText(value, field, 128);
    if (!stableIdPattern.test(text))
    {
        fail('article-bulk.value-invalid', `${field} must use lowercase stable-id syntax`);
    }
    return text;
}

export function opaqueId(value, field)
{
    const text = requiredText(value, field, 128);
    if (!opaqueIdPattern.test(text))
    {
        fail('article-bulk.value-invalid', `${field} must be a bounded opaque identifier`);
    }
    return text;
}

export function digest(value, field)
{
    if (typeof value !== 'string' || !digestPattern.test(value))
    {
        fail('article-bulk.digest-invalid', `${field} must be a lowercase sha256 digest`);
    }
    return value;
}

export function rfc3339(value, field)
{
    if (typeof value !== 'string' || !rfc3339Pattern.test(value)
        || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value)
    {
        fail('article-bulk.value-invalid', `${field} must be canonical RFC3339 UTC`);
    }
    return value;
}

export function sortedUnique(values, field, validator = stableId, maximum = 256)
{
    if (!Array.isArray(values) || values.length === 0 || values.length > maximum)
    {
        fail('article-bulk.value-invalid', `${field} must be a non-empty bounded array`);
    }
    const normalized = values.map((value, index) => validator(value, `${field}[${index}]`));
    const sorted = [...normalized].sort(compareUtf8);
    if (new Set(sorted).size !== sorted.length)
    {
        fail('article-bulk.value-invalid', `${field} must not contain duplicates`);
    }
    return sorted;
}

function parameterField(name, type, options = {})
{
    return deepFreeze({
        name,
        type,
        required: options.required ?? true,
        maximumItems: options.maximumItems ?? null,
        maximumLength: options.maximumLength ?? null
    });
}

function operation({
    id,
    strategy,
    commandOwner,
    parameterFields,
    expectedArticleStates,
    permissionPolicy,
    sideEffectOwners,
    fixtureDependencies = [],
    resultKind,
    mutatesBusinessState
})
{
    return deepFreeze({
        id,
        version: 1,
        strategy,
        commandOwner,
        parameters: {
            schema: `fsusblog.article-bulk.parameters.${id}.v1`,
            allowUnknown: false,
            fields: parameterFields
        },
        expectedArticleStates,
        permissionPolicy,
        sideEffectOwners,
        dependencies: {
            revision: 'expected-exact',
            permission: permissionPolicy,
            lifecycle: 'registry-expected-states',
            fixtures: fixtureDependencies,
            query: 'plan-resolution-only'
        },
        idempotencyScope: 'plan-operation-parameters-article-actor',
        retryEligibility: strategy === 'per-item-isolated' ? 'failed-items-explicit-revision' : 'none',
        cancelBoundary: strategy === 'per-item-isolated'
            ? 'stop-admission-wait-active'
            : 'before-group-commit-only',
        maximumBatchSize: 10000,
        itemReceiptSchema: 'fsusblog.article-bulk.item-receipt.v1',
        aggregateReceiptSchema: 'fsusblog.article-bulk.aggregate-receipt.v1',
        resultKind,
        mutatesBusinessState
    });
}

const allEditableStates = Object.freeze(['draft', 'inbox', 'scheduled']);
const metadataEffects = Object.freeze(['article-audit', 'article-cache', 'article-mutation-outbox']);
const lifecycleEffects = Object.freeze([
    'article-audit',
    'article-cache',
    'article-mutation-outbox',
    'article-publication-projection',
    'author-search-index'
]);

const operations = [
    operation({
        id: 'category.add',
        strategy: 'per-item-isolated',
        commandOwner: 'article-category-command',
        parameterFields: [parameterField('categoryId', 'opaque-id')],
        expectedArticleStates: allEditableStates,
        permissionPolicy: 'article.metadata.write',
        sideEffectOwners: metadataEffects,
        fixtureDependencies: ['category-catalog'],
        resultKind: 'article-revision',
        mutatesBusinessState: true
    }),
    operation({
        id: 'category.remove',
        strategy: 'per-item-isolated',
        commandOwner: 'article-category-command',
        parameterFields: [parameterField('categoryId', 'opaque-id')],
        expectedArticleStates: allEditableStates,
        permissionPolicy: 'article.metadata.write',
        sideEffectOwners: metadataEffects,
        fixtureDependencies: ['category-catalog'],
        resultKind: 'article-revision',
        mutatesBusinessState: true
    }),
    operation({
        id: 'tag.add',
        strategy: 'per-item-isolated',
        commandOwner: 'article-tag-command',
        parameterFields: [parameterField('tagId', 'opaque-id')],
        expectedArticleStates: allEditableStates,
        permissionPolicy: 'article.metadata.write',
        sideEffectOwners: metadataEffects,
        fixtureDependencies: ['tag-catalog'],
        resultKind: 'article-revision',
        mutatesBusinessState: true
    }),
    operation({
        id: 'tag.remove',
        strategy: 'per-item-isolated',
        commandOwner: 'article-tag-command',
        parameterFields: [parameterField('tagId', 'opaque-id')],
        expectedArticleStates: allEditableStates,
        permissionPolicy: 'article.metadata.write',
        sideEffectOwners: metadataEffects,
        fixtureDependencies: ['tag-catalog'],
        resultKind: 'article-revision',
        mutatesBusinessState: true
    }),
    operation({
        id: 'property.set',
        strategy: 'per-item-isolated',
        commandOwner: 'article-property-command',
        parameterFields: [
            parameterField('definitionId', 'opaque-id'),
            parameterField('typedValueDigest', 'digest')
        ],
        expectedArticleStates: allEditableStates,
        permissionPolicy: 'article.property.write',
        sideEffectOwners: [...metadataEffects, 'author-search-index'],
        fixtureDependencies: ['property-definition'],
        resultKind: 'article-property-revision',
        mutatesBusinessState: true
    }),
    operation({
        id: 'property.clear',
        strategy: 'per-item-isolated',
        commandOwner: 'article-property-command',
        parameterFields: [parameterField('definitionId', 'opaque-id')],
        expectedArticleStates: allEditableStates,
        permissionPolicy: 'article.property.write',
        sideEffectOwners: [...metadataEffects, 'author-search-index'],
        fixtureDependencies: ['property-definition'],
        resultKind: 'article-property-revision',
        mutatesBusinessState: true
    }),
    operation({
        id: 'content-check.run',
        strategy: 'per-item-isolated',
        commandOwner: 'article-content-check-command',
        parameterFields: [parameterField('checkIds', 'stable-id-array', { maximumItems: 64 })],
        expectedArticleStates: allEditableStates,
        permissionPolicy: 'article.read',
        sideEffectOwners: ['article-content-check-result'],
        fixtureDependencies: ['content-check-catalog'],
        resultKind: 'diagnostic-result',
        mutatesBusinessState: false
    }),
    operation({
        id: 'relation.reindex',
        strategy: 'per-item-isolated',
        commandOwner: 'article-relation-reindex-command',
        parameterFields: [parameterField('indexAuthorityDigest', 'digest')],
        expectedArticleStates: ['archived', 'draft', 'inbox', 'published', 'scheduled'],
        permissionPolicy: 'article.reindex',
        sideEffectOwners: ['article-relation-index'],
        resultKind: 'reindex-result',
        mutatesBusinessState: false
    }),
    operation({
        id: 'search.reindex',
        strategy: 'per-item-isolated',
        commandOwner: 'author-search-reindex-command',
        parameterFields: [parameterField('indexAuthorityDigest', 'digest')],
        expectedArticleStates: ['archived', 'draft', 'inbox', 'published', 'scheduled'],
        permissionPolicy: 'article.reindex',
        sideEffectOwners: ['author-search-index'],
        resultKind: 'reindex-result',
        mutatesBusinessState: false
    }),
    operation({
        id: 'lifecycle.archive',
        strategy: 'all-or-nothing',
        commandOwner: 'article-lifecycle-command',
        parameterFields: [parameterField('reasonCode', 'stable-id')],
        expectedArticleStates: ['draft', 'inbox', 'published', 'scheduled'],
        permissionPolicy: 'article.lifecycle.write',
        sideEffectOwners: lifecycleEffects,
        resultKind: 'article-lifecycle-revision',
        mutatesBusinessState: true
    }),
    operation({
        id: 'lifecycle.restore',
        strategy: 'all-or-nothing',
        commandOwner: 'article-lifecycle-command',
        parameterFields: [parameterField('reasonCode', 'stable-id')],
        expectedArticleStates: ['archived'],
        permissionPolicy: 'article.lifecycle.write',
        sideEffectOwners: lifecycleEffects,
        resultKind: 'article-lifecycle-revision',
        mutatesBusinessState: true
    }),
    operation({
        id: 'lifecycle.inbox-to-draft',
        strategy: 'all-or-nothing',
        commandOwner: 'article-lifecycle-command',
        parameterFields: [parameterField('reasonCode', 'stable-id')],
        expectedArticleStates: ['inbox'],
        permissionPolicy: 'article.lifecycle.write',
        sideEffectOwners: lifecycleEffects,
        resultKind: 'article-lifecycle-revision',
        mutatesBusinessState: true
    }),
    operation({
        id: 'lifecycle.draft-to-inbox',
        strategy: 'all-or-nothing',
        commandOwner: 'article-lifecycle-command',
        parameterFields: [parameterField('reasonCode', 'stable-id')],
        expectedArticleStates: ['draft'],
        permissionPolicy: 'article.lifecycle.write',
        sideEffectOwners: lifecycleEffects,
        resultKind: 'article-lifecycle-revision',
        mutatesBusinessState: true
    }),
    operation({
        id: 'schedule.change',
        strategy: 'all-or-nothing',
        commandOwner: 'article-schedule-command',
        parameterFields: [parameterField('scheduledAtUtc', 'rfc3339')],
        expectedArticleStates: ['draft', 'scheduled'],
        permissionPolicy: 'article.schedule.write',
        sideEffectOwners: lifecycleEffects,
        resultKind: 'article-lifecycle-revision',
        mutatesBusinessState: true
    })
];

function buildCommandOwners(operationList)
{
    const byOwner = new Map();
    for (const item of operationList)
    {
        const ids = byOwner.get(item.commandOwner) ?? [];
        ids.push(item.id);
        byOwner.set(item.commandOwner, ids);
    }
    return [...byOwner.entries()].sort(([left], [right]) => compareUtf8(left, right)).map(
        ([ownerId, operationIds]) => ({ ownerId, operationIds: operationIds.sort(compareUtf8) })
    );
}

function sealRegistry(value)
{
    const body = structuredClone(value);
    body.contentDigest = canonicalDigest(body);
    return deepFreeze(body);
}

export const articleBulkOperationRegistry = sealRegistry({
    schema: ARTICLE_BULK_REGISTRY_SCHEMA,
    version: ARTICLE_BULK_REGISTRY_VERSION,
    defaultStrategy: null,
    operations,
    commandOwners: buildCommandOwners(operations)
});

function validateParameterField(field, label)
{
    exactKeys(field, ['name', 'type', 'required', 'maximumItems', 'maximumLength'], label);
    requiredText(field.name, `${label}.name`, 64);
    if (!fieldNamePattern.test(field.name))
    {
        fail('article-bulk.registry-invalid', `${label}.name must use camelCase field syntax`);
    }
    if (!['digest', 'opaque-id', 'rfc3339', 'stable-id', 'stable-id-array'].includes(field.type))
    {
        fail('article-bulk.registry-invalid', `${label}.type is unsupported`);
    }
    if (field.required !== true || (field.maximumItems !== null
        && (!Number.isInteger(field.maximumItems) || field.maximumItems < 1 || field.maximumItems > 256))
        || (field.maximumLength !== null
        && (!Number.isInteger(field.maximumLength) || field.maximumLength < 1 || field.maximumLength > 4096)))
    {
        fail('article-bulk.registry-invalid', `${label} bounds are invalid`);
    }
}

function validateOperation(operationValue, label)
{
    exactKeys(operationValue, [
        'id',
        'version',
        'strategy',
        'commandOwner',
        'parameters',
        'expectedArticleStates',
        'permissionPolicy',
        'sideEffectOwners',
        'dependencies',
        'idempotencyScope',
        'retryEligibility',
        'cancelBoundary',
        'maximumBatchSize',
        'itemReceiptSchema',
        'aggregateReceiptSchema',
        'resultKind',
        'mutatesBusinessState'
    ], label);
    stableId(operationValue.id, `${label}.id`);
    if (operationValue.version !== 1 || !ARTICLE_BULK_STRATEGIES.includes(operationValue.strategy))
    {
        fail('article-bulk.registry-invalid', `${label} version or strategy is invalid`);
    }
    stableId(operationValue.commandOwner, `${label}.commandOwner`);
    exactKeys(operationValue.parameters, ['schema', 'allowUnknown', 'fields'], `${label}.parameters`);
    requiredText(operationValue.parameters.schema, `${label}.parameters.schema`);
    if (operationValue.parameters.allowUnknown !== false || !Array.isArray(operationValue.parameters.fields)
        || operationValue.parameters.fields.length === 0)
    {
        fail('article-bulk.registry-invalid', `${label}.parameters must be closed and non-empty`);
    }
    operationValue.parameters.fields.forEach((field, index) =>
        validateParameterField(field, `${label}.parameters.fields[${index}]`));
    const fieldNames = operationValue.parameters.fields.map((field) => field.name);
    if (new Set(fieldNames).size !== fieldNames.length)
    {
        fail('article-bulk.registry-invalid', `${label}.parameters fields must be unique`);
    }
    sortedUnique(operationValue.expectedArticleStates, `${label}.expectedArticleStates`);
    stableId(operationValue.permissionPolicy, `${label}.permissionPolicy`);
    sortedUnique(operationValue.sideEffectOwners, `${label}.sideEffectOwners`);
    exactKeys(operationValue.dependencies, [
        'revision',
        'permission',
        'lifecycle',
        'fixtures',
        'query'
    ], `${label}.dependencies`);
    if (operationValue.dependencies.revision !== 'expected-exact'
        || operationValue.dependencies.permission !== operationValue.permissionPolicy
        || operationValue.dependencies.lifecycle !== 'registry-expected-states'
        || operationValue.dependencies.query !== 'plan-resolution-only'
        || !Array.isArray(operationValue.dependencies.fixtures)
        || operationValue.dependencies.fixtures.length > 64)
    {
        fail('article-bulk.registry-invalid', `${label} dependency declarations are invalid`);
    }
    const fixtures = operationValue.dependencies.fixtures.map((value, index) =>
        stableId(value, `${label}.dependencies.fixtures[${index}]`));
    if (new Set(fixtures).size !== fixtures.length)
    {
        fail('article-bulk.registry-invalid', `${label} fixture dependencies contain duplicates`);
    }
    if (operationValue.idempotencyScope !== 'plan-operation-parameters-article-actor'
        || operationValue.maximumBatchSize !== 10000
        || operationValue.itemReceiptSchema !== 'fsusblog.article-bulk.item-receipt.v1'
        || operationValue.aggregateReceiptSchema !== 'fsusblog.article-bulk.aggregate-receipt.v1'
        || typeof operationValue.mutatesBusinessState !== 'boolean')
    {
        fail('article-bulk.registry-invalid', `${label} execution contract is invalid`);
    }
    const expectedRetry = operationValue.strategy === 'per-item-isolated'
        ? 'failed-items-explicit-revision'
        : 'none';
    const expectedCancel = operationValue.strategy === 'per-item-isolated'
        ? 'stop-admission-wait-active'
        : 'before-group-commit-only';
    if (operationValue.retryEligibility !== expectedRetry || operationValue.cancelBoundary !== expectedCancel)
    {
        fail('article-bulk.registry-invalid', `${label} retry/cancel contract contradicts its strategy`);
    }
    if (['content-check.run', 'relation.reindex', 'search.reindex'].includes(operationValue.id)
        && operationValue.mutatesBusinessState !== false)
    {
        fail('article-bulk.registry-invalid', `${label} diagnostic/reindex operations cannot mutate article state`);
    }
}

export function validateArticleBulkOperationRegistry(registry)
{
    exactKeys(registry, [
        'schema',
        'version',
        'defaultStrategy',
        'operations',
        'commandOwners',
        'contentDigest'
    ], 'operation registry');
    if (registry.schema !== ARTICLE_BULK_REGISTRY_SCHEMA
        || registry.version !== ARTICLE_BULK_REGISTRY_VERSION || registry.defaultStrategy !== null)
    {
        fail('article-bulk.registry-invalid', 'operation registry identity or default strategy is invalid');
    }
    if (!Array.isArray(registry.operations) || registry.operations.length !== operations.length)
    {
        fail('article-bulk.registry-invalid', 'operation registry must contain the exact first-version set');
    }
    registry.operations.forEach((item, index) => validateOperation(item, `operations[${index}]`));
    const ids = registry.operations.map((item) => item.id);
    if (new Set(ids).size !== ids.length || canonicalJson([...ids].sort(compareUtf8))
        !== canonicalJson(operations.map((item) => item.id).sort(compareUtf8)))
    {
        fail('article-bulk.registry-invalid', 'operation registry IDs are missing, duplicate, or unknown');
    }
    const expectedById = new Map(operations.map((item) => [item.id, item]));
    for (const item of registry.operations)
    {
        const expected = expectedById.get(item.id);
        if (canonicalJson(item) !== canonicalJson(expected))
        {
            fail('article-bulk.registry-invalid', `${item.id} closed operation mapping drifted`);
        }
    }
    if (!Array.isArray(registry.commandOwners)
        || canonicalJson(registry.commandOwners) !== canonicalJson(buildCommandOwners(registry.operations)))
    {
        fail('article-bulk.registry-invalid', 'command owners are not bidirectionally exact');
    }
    const { contentDigest, ...body } = registry;
    digest(contentDigest, 'operation registry.contentDigest');
    if (contentDigest !== canonicalDigest(body))
    {
        fail('article-bulk.registry-tampered', 'operation registry contentDigest mismatch');
    }
    return registry;
}

export function operationById(operationId, registry = articleBulkOperationRegistry)
{
    validateArticleBulkOperationRegistry(registry);
    const normalizedId = stableId(operationId, 'operationId');
    const found = registry.operations.find((item) => item.id === normalizedId);
    if (!found)
    {
        fail('article-bulk.operation-unsupported', `operation is not registered: ${normalizedId}`);
    }
    return found;
}

function validateParameterValue(field, value, label)
{
    if (field.type === 'digest')
    {
        return digest(value, label);
    }
    if (field.type === 'opaque-id')
    {
        return opaqueId(value, label);
    }
    if (field.type === 'rfc3339')
    {
        return rfc3339(value, label);
    }
    if (field.type === 'stable-id')
    {
        return stableId(value, label);
    }
    if (field.type === 'stable-id-array')
    {
        return sortedUnique(value, label, stableId, field.maximumItems ?? 256);
    }
    fail('article-bulk.parameter-invalid', `${label} has unsupported parameter type`);
}

export function normalizeOperationParameters(operationId, parameters, registry = articleBulkOperationRegistry)
{
    const operationValue = operationById(operationId, registry);
    const required = operationValue.parameters.fields.map((field) => field.name);
    exactKeys(parameters, required, `${operationId} parameters`);
    const normalized = {};
    for (const field of operationValue.parameters.fields)
    {
        normalized[field.name] = validateParameterValue(
            field,
            parameters[field.name],
            `${operationId}.${field.name}`
        );
    }
    return deepFreeze(normalized);
}

validateArticleBulkOperationRegistry(articleBulkOperationRegistry);
