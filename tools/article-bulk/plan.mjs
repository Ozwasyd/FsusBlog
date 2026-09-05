import {
    articleBulkOperationRegistry,
    canonicalDigest,
    canonicalJson,
    deepFreeze,
    digest,
    exactKeys,
    fail,
    normalizeOperationParameters,
    opaqueId,
    operationById,
    plainObject,
    requiredText,
    rfc3339,
    stableId,
    validateArticleBulkOperationRegistry
} from './contract.mjs';

export const ARTICLE_BULK_PLAN_SCHEMA = 'fsusblog.article-bulk.plan.v1';
export const ARTICLE_BULK_PLAN_REQUEST_SCHEMA = 'fsusblog.article-bulk.plan-request.v1';
export const ARTICLE_BULK_ITEM_CHUNK_SIZE = 250;

const sourceCommitPattern = /^[0-9a-f]{40}$/u;
const allowedSelectionKinds = Object.freeze(['current-page', 'explicit', 'query', 'saved-view']);
const allowedItemStatuses = Object.freeze(['blocked', 'eligible']);

function uniqueInOrder(values, field, maximum = 10000)
{
    if (!Array.isArray(values) || values.length > maximum)
    {
        fail('article-bulk.selection-invalid', `${field} must contain at most ${maximum} items`);
    }
    const normalized = values.map((value, index) => opaqueId(value, `${field}[${index}]`));
    if (new Set(normalized).size !== normalized.length)
    {
        fail('article-bulk.selection-invalid', `${field} must not contain duplicate article IDs`);
    }
    return normalized;
}

function normalizeSelection(selection)
{
    if (!plainObject(selection))
    {
        fail('article-bulk.selection-invalid', 'selection must be an object');
    }
    const kind = stableId(selection.kind, 'selection.kind');
    if (!allowedSelectionKinds.includes(kind))
    {
        fail('article-bulk.selection-invalid', `unsupported selection kind: ${kind}`);
    }
    if (kind === 'explicit')
    {
        exactKeys(selection, ['kind', 'articleIds'], 'explicit selection');
        return deepFreeze({ kind, articleIds: uniqueInOrder(selection.articleIds, 'selection.articleIds') });
    }
    if (kind === 'current-page')
    {
        exactKeys(selection, ['kind', 'pageIdentityDigest', 'articleIds'], 'current-page selection');
        return deepFreeze({
            kind,
            pageIdentityDigest: digest(selection.pageIdentityDigest, 'selection.pageIdentityDigest'),
            articleIds: uniqueInOrder(selection.articleIds, 'selection.articleIds')
        });
    }
    if (kind === 'saved-view')
    {
        exactKeys(selection, ['kind', 'savedViewId', 'savedViewRevision', 'savedViewDigest'], 'saved-view selection');
        return deepFreeze({
            kind,
            savedViewId: opaqueId(selection.savedViewId, 'selection.savedViewId'),
            savedViewRevision: opaqueId(selection.savedViewRevision, 'selection.savedViewRevision'),
            savedViewDigest: digest(selection.savedViewDigest, 'selection.savedViewDigest')
        });
    }
    exactKeys(selection, ['kind', 'queryId', 'queryDigest'], 'query selection');
    return deepFreeze({
        kind,
        queryId: opaqueId(selection.queryId, 'selection.queryId'),
        queryDigest: digest(selection.queryDigest, 'selection.queryDigest')
    });
}

function normalizeActor(actor)
{
    exactKeys(actor, ['userId', 'siteId', 'authorityDigest'], 'plan actor');
    return deepFreeze({
        userId: opaqueId(actor.userId, 'actor.userId'),
        siteId: opaqueId(actor.siteId, 'actor.siteId'),
        authorityDigest: digest(actor.authorityDigest, 'actor.authorityDigest')
    });
}

function normalizeSource(source)
{
    exactKeys(source, ['commit', 'buildDigest'], 'plan source');
    if (typeof source.commit !== 'string' || !sourceCommitPattern.test(source.commit))
    {
        fail('article-bulk.source-invalid', 'source.commit must be a lowercase 40-hex commit');
    }
    return deepFreeze({
        commit: source.commit,
        buildDigest: digest(source.buildDigest, 'source.buildDigest')
    });
}

function normalizeTiming(timing)
{
    exactKeys(timing, ['createdAtUtc', 'expiresAtUtc'], 'plan timing');
    const createdAtUtc = rfc3339(timing.createdAtUtc, 'timing.createdAtUtc');
    const expiresAtUtc = rfc3339(timing.expiresAtUtc, 'timing.expiresAtUtc');
    if (Date.parse(expiresAtUtc) <= Date.parse(createdAtUtc))
    {
        fail('article-bulk.plan-expiry-invalid', 'plan expiry must be after creation');
    }
    return deepFreeze({ createdAtUtc, expiresAtUtc });
}

export function normalizeArticleBulkPlanRequest(
    request,
    registry = articleBulkOperationRegistry
)
{
    validateArticleBulkOperationRegistry(registry);
    exactKeys(request, [
        'schema',
        'operationId',
        'parameters',
        'selection',
        'actor',
        'source',
        'policyDigest',
        'permissionPolicyDigest',
        'timing'
    ], 'article bulk plan request', ['requestDigest']);
    if (request.schema !== ARTICLE_BULK_PLAN_REQUEST_SCHEMA)
    {
        fail('article-bulk.plan-request-invalid', 'plan request schema is unsupported');
    }
    const operation = operationById(request.operationId, registry);
    const normalized = {
        schema: ARTICLE_BULK_PLAN_REQUEST_SCHEMA,
        operationId: operation.id,
        parameters: normalizeOperationParameters(operation.id, request.parameters, registry),
        selection: normalizeSelection(request.selection),
        actor: normalizeActor(request.actor),
        source: normalizeSource(request.source),
        policyDigest: digest(request.policyDigest, 'request.policyDigest'),
        permissionPolicyDigest: digest(
            request.permissionPolicyDigest,
            'request.permissionPolicyDigest'
        ),
        timing: normalizeTiming(request.timing)
    };
    const requestDigest = canonicalDigest(normalized);
    if (request.requestDigest !== undefined
        && digest(request.requestDigest, 'request.requestDigest') !== requestDigest)
    {
        fail('article-bulk.plan-request-tampered', 'plan requestDigest mismatch');
    }
    return deepFreeze({ ...normalized, requestDigest });
}

function validateSelectionResolution(resolution, request)
{
    exactKeys(resolution, ['authorityDigest', 'resolutionDigest', 'articleIds'], 'selection resolution');
    const normalized = {
        authorityDigest: digest(resolution.authorityDigest, 'selection resolution.authorityDigest'),
        resolutionDigest: digest(resolution.resolutionDigest, 'selection resolution.resolutionDigest'),
        articleIds: uniqueInOrder(resolution.articleIds, 'selection resolution.articleIds')
    };
    if ((request.selection.kind === 'explicit' || request.selection.kind === 'current-page')
        && canonicalJson(normalized.articleIds) !== canonicalJson(request.selection.articleIds))
    {
        fail(
            'article-bulk.selection-drift',
            `${request.selection.kind} authority changed the exact client-selected article IDs`
        );
    }
    return deepFreeze(normalized);
}

function normalizeObservedItem(item, expectedArticleId, operation, parameters, actor, index)
{
    const label = `article observation[${index}]`;
    exactKeys(item, [
        'articleId',
        'exists',
        'siteId',
        'revision',
        'lifecycle',
        'permitted',
        'applicable',
        'permissionDigest',
        'stateDigest',
        'dependencyDigests'
    ], label);
    const articleId = opaqueId(item.articleId, `${label}.articleId`);
    if (articleId !== expectedArticleId)
    {
        fail('article-bulk.article-order-drift', `${label} does not match the frozen selection order`);
    }
    if (typeof item.exists !== 'boolean' || typeof item.permitted !== 'boolean'
        || typeof item.applicable !== 'boolean')
    {
        fail('article-bulk.article-observation-invalid', `${label} boolean facts are invalid`);
    }
    if (!Array.isArray(item.dependencyDigests) || item.dependencyDigests.length > 64)
    {
        fail('article-bulk.article-observation-invalid', `${label}.dependencyDigests is invalid`);
    }
    const reasons = [];
    let siteId = null;
    let revision = null;
    let lifecycle = null;
    let permissionDigest = null;
    let stateDigest = null;
    if (!item.exists)
    {
        if (item.siteId !== null || item.revision !== null || item.lifecycle !== null
            || item.permissionDigest !== null || item.stateDigest !== null
            || item.permitted || item.applicable || item.dependencyDigests.length !== 0)
        {
            fail('article-bulk.article-observation-invalid', `${label} missing article leaks state facts`);
        }
        reasons.push('article.not-found');
    }
    else
    {
        siteId = opaqueId(item.siteId, `${label}.siteId`);
        revision = opaqueId(item.revision, `${label}.revision`);
        lifecycle = stableId(item.lifecycle, `${label}.lifecycle`);
        permissionDigest = digest(item.permissionDigest, `${label}.permissionDigest`);
        stateDigest = digest(item.stateDigest, `${label}.stateDigest`);
        if (siteId !== actor.siteId)
        {
            reasons.push('article.scope-mismatch');
        }
        if (!item.permitted)
        {
            reasons.push('permission.denied');
        }
        if (!operation.expectedArticleStates.includes(lifecycle))
        {
            reasons.push('lifecycle.ineligible');
        }
        if (!item.applicable)
        {
            reasons.push('operation.inapplicable');
        }
    }
    const dependencyDigests = item.dependencyDigests.map((value, dependencyIndex) =>
        digest(value, `${label}.dependencyDigests[${dependencyIndex}]`));
    if (new Set(dependencyDigests).size !== dependencyDigests.length)
    {
        fail('article-bulk.article-observation-invalid', `${label}.dependencyDigests has duplicates`);
    }
    const body = {
        ordinal: index,
        articleId,
        siteId,
        expectedRevision: revision,
        lifecycle,
        permissionDigest,
        stateDigest,
        dependencyDigests: [...dependencyDigests].sort(),
        proposedChangeDigest: item.exists ? canonicalDigest({
            operationId: operation.id,
            parameters,
            articleId,
            expectedRevision: revision
        }) : null,
        status: reasons.length === 0 ? 'eligible' : 'blocked',
        reasonCodes: reasons.sort()
    };
    return deepFreeze({ ...body, contentDigest: canonicalDigest(body) });
}

function validateArticleObservation(observation, articleIds, operation, parameters, actor, ordinalStart)
{
    exactKeys(observation, ['authorityDigest', 'items'], 'article observation');
    const authorityDigest = digest(observation.authorityDigest, 'article observation.authorityDigest');
    if (!Array.isArray(observation.items) || observation.items.length !== articleIds.length)
    {
        fail('article-bulk.article-observation-invalid', 'article observation batch must cover its exact requested slice');
    }
    const items = observation.items.map((item, index) =>
        normalizeObservedItem(item, articleIds[index], operation, parameters, actor, ordinalStart + index));
    return deepFreeze({ authorityDigest, items });
}

function chunkItems(items)
{
    const chunks = [];
    for (let start = 0; start < items.length; start += ARTICLE_BULK_ITEM_CHUNK_SIZE)
    {
        const body = {
            ordinalStart: start,
            ordinalEndExclusive: Math.min(start + ARTICLE_BULK_ITEM_CHUNK_SIZE, items.length),
            items: items.slice(start, start + ARTICLE_BULK_ITEM_CHUNK_SIZE)
        };
        chunks.push(deepFreeze({ ...body, contentDigest: canonicalDigest(body) }));
    }
    return deepFreeze(chunks);
}

function impactFor(operation, items)
{
    const eligibleCount = items.filter((item) => item.status === 'eligible').length;
    const blockedCount = items.length - eligibleCount;
    const executable = items.length > 0 && (operation.strategy === 'all-or-nothing'
        ? blockedCount === 0
        : eligibleCount > 0);
    return deepFreeze({
        totalCount: items.length,
        eligibleCount,
        blockedCount,
        executable,
        zeroWriteRequired: operation.strategy === 'all-or-nothing' && !executable,
        estimatedBatches: Math.ceil(items.length / ARTICLE_BULK_ITEM_CHUNK_SIZE),
        sideEffectOwners: operation.sideEffectOwners,
        warnings: [],
        errors: items.length === 0 ? ['selection.empty']
            : blockedCount === 0 ? []
                : [...new Set(items.flatMap((item) => item.reasonCodes))].sort()
    });
}

function requireAuthority(authorities, owner, method)
{
    const candidate = authorities?.[owner]?.[method];
    if (typeof candidate !== 'function')
    {
        fail(
            'article-bulk.authority-missing',
            `${owner}.${method} production authority interface is required`
        );
    }
    return candidate.bind(authorities[owner]);
}

export async function createArticleBulkPlan({
    request,
    authorities,
    registry = articleBulkOperationRegistry
})
{
    const normalizedRequest = normalizeArticleBulkPlanRequest(request, registry);
    const operation = operationById(normalizedRequest.operationId, registry);
    const resolveSelection = requireAuthority(authorities, 'selection', 'resolve');
    const observeArticles = requireAuthority(authorities, 'articles', 'observe');
    const resolution = validateSelectionResolution(await resolveSelection({
        selection: normalizedRequest.selection,
        actor: normalizedRequest.actor,
        operationId: operation.id
    }), normalizedRequest);
    if (resolution.articleIds.length > operation.maximumBatchSize)
    {
        fail('article-bulk.selection-too-large', 'selection exceeds the operation maximum batch size');
    }
    const observations = [];
    const observedItems = [];
    for (let start = 0; start < resolution.articleIds.length; start += ARTICLE_BULK_ITEM_CHUNK_SIZE)
    {
        const articleIds = resolution.articleIds.slice(start, start + ARTICLE_BULK_ITEM_CHUNK_SIZE);
        const observation = validateArticleObservation(await observeArticles({
            articleIds,
            ordinalStart: start,
            actor: normalizedRequest.actor,
            operationId: operation.id,
            parameters: normalizedRequest.parameters,
            policyDigest: normalizedRequest.policyDigest,
            permissionPolicyDigest: normalizedRequest.permissionPolicyDigest
        }), articleIds, operation, normalizedRequest.parameters, normalizedRequest.actor, start);
        observations.push({
            ordinalStart: start,
            itemCount: observation.items.length,
            authorityDigest: observation.authorityDigest
        });
        observedItems.push(...observation.items);
    }
    const itemChunks = chunkItems(observedItems);
    const impact = impactFor(operation, observedItems);
    const body = {
        schema: ARTICLE_BULK_PLAN_SCHEMA,
        request: normalizedRequest,
        registry: {
            schema: registry.schema,
            version: registry.version,
            contentDigest: registry.contentDigest
        },
        operation: {
            id: operation.id,
            version: operation.version,
            strategy: operation.strategy,
            commandOwner: operation.commandOwner,
            parametersDigest: canonicalDigest(normalizedRequest.parameters),
            permissionPolicy: operation.permissionPolicy,
            sideEffectOwners: operation.sideEffectOwners,
            resultKind: operation.resultKind,
            mutatesBusinessState: operation.mutatesBusinessState
        },
        resolution: {
            selectionAuthorityDigest: resolution.authorityDigest,
            resolutionDigest: resolution.resolutionDigest,
            articleAuthorityDigest: canonicalDigest(observations),
            articleCount: resolution.articleIds.length,
            orderedArticleIdsDigest: canonicalDigest(resolution.articleIds),
            frozenSetDigest: canonicalDigest(observedItems.map((item) => ({
                ordinal: item.ordinal,
                articleId: item.articleId,
                expectedRevision: item.expectedRevision,
                contentDigest: item.contentDigest
            })))
        },
        itemChunks,
        impact
    };
    return validateArticleBulkPlan(
        deepFreeze({ ...body, planDigest: canonicalDigest(body) }),
        registry
    );
}

function validatePlanItem(item, operation, parameters, ordinal)
{
    exactKeys(item, [
        'ordinal',
        'articleId',
        'siteId',
        'expectedRevision',
        'lifecycle',
        'permissionDigest',
        'stateDigest',
        'dependencyDigests',
        'proposedChangeDigest',
        'status',
        'reasonCodes',
        'contentDigest'
    ], `plan item[${ordinal}]`);
    if (item.ordinal !== ordinal || !allowedItemStatuses.includes(item.status))
    {
        fail('article-bulk.plan-invalid', `plan item[${ordinal}] ordinal/status is invalid`);
    }
    opaqueId(item.articleId, `plan item[${ordinal}].articleId`);
    if (item.expectedRevision === null)
    {
        if (item.siteId !== null || item.lifecycle !== null || item.permissionDigest !== null
            || item.stateDigest !== null || item.proposedChangeDigest !== null
            || canonicalJson(item.dependencyDigests) !== '[]'
            || canonicalJson(item.reasonCodes) !== '["article.not-found"]' || item.status !== 'blocked')
        {
            fail('article-bulk.plan-invalid', `plan item[${ordinal}] missing article facts are inconsistent`);
        }
    }
    else
    {
        opaqueId(item.siteId, `plan item[${ordinal}].siteId`);
        opaqueId(item.expectedRevision, `plan item[${ordinal}].expectedRevision`);
        stableId(item.lifecycle, `plan item[${ordinal}].lifecycle`);
        digest(item.permissionDigest, `plan item[${ordinal}].permissionDigest`);
        digest(item.stateDigest, `plan item[${ordinal}].stateDigest`);
        if (digest(item.proposedChangeDigest, `plan item[${ordinal}].proposedChangeDigest`)
            !== canonicalDigest({
                operationId: operation.id,
                parameters,
                articleId: item.articleId,
                expectedRevision: item.expectedRevision
            }))
        {
            fail('article-bulk.plan-invalid', `plan item[${ordinal}] proposed change is not derived`);
        }
    }
    if (!Array.isArray(item.dependencyDigests) || !Array.isArray(item.reasonCodes)
        || item.dependencyDigests.some((value, index) =>
            value !== digest(value, `plan item[${ordinal}].dependencyDigests[${index}]`))
        || item.reasonCodes.some((value, index) =>
            value !== stableId(value, `plan item[${ordinal}].reasonCodes[${index}]`)))
    {
        fail('article-bulk.plan-invalid', `plan item[${ordinal}] dependency/reason facts are invalid`);
    }
    const reasons = [...item.reasonCodes].sort();
    if (new Set(reasons).size !== reasons.length || canonicalJson(reasons) !== canonicalJson(item.reasonCodes)
        || (item.status === 'eligible') !== (reasons.length === 0)
        || (item.lifecycle !== null && item.status === 'eligible'
        && !operation.expectedArticleStates.includes(item.lifecycle)))
    {
        fail('article-bulk.plan-invalid', `plan item[${ordinal}] status/reasons are inconsistent`);
    }
    const { contentDigest, ...body } = item;
    digest(contentDigest, `plan item[${ordinal}].contentDigest`);
    if (contentDigest !== canonicalDigest(body))
    {
        fail('article-bulk.plan-tampered', `plan item[${ordinal}] contentDigest mismatch`);
    }
}

function flattenAndValidateChunks(chunks, operation, parameters)
{
    if (!Array.isArray(chunks) || chunks.length > 40)
    {
        fail('article-bulk.plan-invalid', 'plan item chunks are missing or unbounded');
    }
    const items = [];
    for (const [chunkIndex, chunk] of chunks.entries())
    {
        exactKeys(chunk, ['ordinalStart', 'ordinalEndExclusive', 'items', 'contentDigest'], `chunk[${chunkIndex}]`);
        if (chunk.ordinalStart !== items.length || !Array.isArray(chunk.items)
            || chunk.items.length === 0 || chunk.items.length > ARTICLE_BULK_ITEM_CHUNK_SIZE
            || chunk.ordinalEndExclusive !== chunk.ordinalStart + chunk.items.length)
        {
            fail('article-bulk.plan-invalid', `chunk[${chunkIndex}] bounds are invalid`);
        }
        chunk.items.forEach((item) =>
        {
            validatePlanItem(item, operation, parameters, items.length);
            items.push(item);
        });
        const { contentDigest, ...body } = chunk;
        digest(contentDigest, `chunk[${chunkIndex}].contentDigest`);
        if (contentDigest !== canonicalDigest(body))
        {
            fail('article-bulk.plan-tampered', `chunk[${chunkIndex}] contentDigest mismatch`);
        }
    }
    if (items.length > operation.maximumBatchSize
        || new Set(items.map((item) => item.articleId)).size !== items.length)
    {
        fail('article-bulk.plan-invalid', 'plan item set is too large or contains duplicates');
    }
    return items;
}

export function validateArticleBulkPlan(
    plan,
    registry = articleBulkOperationRegistry,
    { nowUtc = null } = {}
)
{
    validateArticleBulkOperationRegistry(registry);
    exactKeys(plan, [
        'schema',
        'request',
        'registry',
        'operation',
        'resolution',
        'itemChunks',
        'impact',
        'planDigest'
    ], 'article bulk plan');
    if (plan.schema !== ARTICLE_BULK_PLAN_SCHEMA)
    {
        fail('article-bulk.plan-invalid', 'plan schema is unsupported');
    }
    const request = normalizeArticleBulkPlanRequest(plan.request, registry);
    if (request.requestDigest !== plan.request.requestDigest)
    {
        fail('article-bulk.plan-tampered', 'plan requestDigest mismatch');
    }
    exactKeys(plan.registry, ['schema', 'version', 'contentDigest'], 'plan registry reference');
    if (plan.registry.schema !== registry.schema || plan.registry.version !== registry.version
        || plan.registry.contentDigest !== registry.contentDigest)
    {
        fail('article-bulk.registry-drift', 'plan does not bind the current operation registry');
    }
    const operation = operationById(request.operationId, registry);
    exactKeys(plan.operation, [
        'id',
        'version',
        'strategy',
        'commandOwner',
        'parametersDigest',
        'permissionPolicy',
        'sideEffectOwners',
        'resultKind',
        'mutatesBusinessState'
    ], 'plan operation');
    const expectedOperation = {
        id: operation.id,
        version: operation.version,
        strategy: operation.strategy,
        commandOwner: operation.commandOwner,
        parametersDigest: canonicalDigest(request.parameters),
        permissionPolicy: operation.permissionPolicy,
        sideEffectOwners: operation.sideEffectOwners,
        resultKind: operation.resultKind,
        mutatesBusinessState: operation.mutatesBusinessState
    };
    if (canonicalJson(plan.operation) !== canonicalJson(expectedOperation))
    {
        fail('article-bulk.operation-drift', 'plan operation differs from its registry entry');
    }
    const items = flattenAndValidateChunks(plan.itemChunks, operation, request.parameters);
    exactKeys(plan.resolution, [
        'selectionAuthorityDigest',
        'resolutionDigest',
        'articleAuthorityDigest',
        'articleCount',
        'orderedArticleIdsDigest',
        'frozenSetDigest'
    ], 'plan resolution');
    for (const field of [
        'selectionAuthorityDigest',
        'resolutionDigest',
        'articleAuthorityDigest',
        'orderedArticleIdsDigest',
        'frozenSetDigest'
    ])
    {
        digest(plan.resolution[field], `plan.resolution.${field}`);
    }
    if (plan.resolution.articleCount !== items.length
        || plan.resolution.orderedArticleIdsDigest !== canonicalDigest(items.map((item) => item.articleId))
        || plan.resolution.frozenSetDigest !== canonicalDigest(items.map((item) => ({
            ordinal: item.ordinal,
            articleId: item.articleId,
            expectedRevision: item.expectedRevision,
            contentDigest: item.contentDigest
        }))))
    {
        fail('article-bulk.plan-tampered', 'plan frozen set identity mismatch');
    }
    exactKeys(plan.impact, [
        'totalCount',
        'eligibleCount',
        'blockedCount',
        'executable',
        'zeroWriteRequired',
        'estimatedBatches',
        'sideEffectOwners',
        'warnings',
        'errors'
    ], 'plan impact');
    if (canonicalJson(plan.impact) !== canonicalJson(impactFor(operation, items)))
    {
        fail('article-bulk.plan-tampered', 'plan impact summary is not derived from its frozen items');
    }
    if (nowUtc !== null && Date.parse(rfc3339(nowUtc, 'nowUtc')) >= Date.parse(request.timing.expiresAtUtc))
    {
        fail('article-bulk.plan-expired', 'plan has expired and must be replaced by an explicit new plan');
    }
    const { planDigest, ...body } = plan;
    digest(planDigest, 'plan.planDigest');
    if (planDigest !== canonicalDigest(body))
    {
        fail('article-bulk.plan-tampered', 'planDigest mismatch');
    }
    return deepFreeze(plan);
}

export async function verifyArticleBulkPlan({
    plan,
    authorities,
    registry = articleBulkOperationRegistry,
    nowUtc
})
{
    rfc3339(nowUtc, 'nowUtc');
    validateArticleBulkPlan(plan, registry, { nowUtc });
    const recomputed = await createArticleBulkPlan({
        request: plan.request,
        authorities,
        registry
    });
    if (recomputed.planDigest !== plan.planDigest)
    {
        fail(
            'article-bulk.plan-drift',
            'selection, article, permission, lifecycle, registry, or policy facts changed; explicit replan required',
            { expected: plan.planDigest, observed: recomputed.planDigest }
        );
    }
    return deepFreeze({
        schema: 'fsusblog.article-bulk.plan-verification.v1',
        status: 'verified',
        planDigest: plan.planDigest,
        verifiedAtUtc: nowUtc,
        contentDigest: canonicalDigest({
            schema: 'fsusblog.article-bulk.plan-verification.v1',
            status: 'verified',
            planDigest: plan.planDigest,
            verifiedAtUtc: nowUtc
        })
    });
}

export function articleBulkPlanItems(plan, registry = articleBulkOperationRegistry)
{
    validateArticleBulkPlan(plan, registry);
    return deepFreeze(plan.itemChunks.flatMap((chunk) => chunk.items));
}

export function *iterateArticleBulkPlanItems(plan, registry = articleBulkOperationRegistry)
{
    validateArticleBulkPlan(plan, registry);
    for (const chunk of plan.itemChunks)
    {
        yield *chunk.items;
    }
}
