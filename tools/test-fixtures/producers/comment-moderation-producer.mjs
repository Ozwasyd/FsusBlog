import { createHash } from 'node:crypto';

// fixture-catalog: producer comment-moderation

const {digestCommentFixtureValue, readCommentFixtureInventory} = await import(new URL('../../test/comment-fixture-contract.mjs', import.meta.url));
const {fixtureTestSessionHeaders, fixtureTestSessionSchema, resolveFixtureTestSession} = await import(new URL('../runtime-scope.mjs', import.meta.url));
const PRODUCER_ID = 'comment-moderation';
const STRATEGY = 'transaction-fixture';
const digestPattern = /^sha256:[a-f0-9]{64}$/u;

function asDigest(value)
{
    const text = String(value ?? '');
    if (digestPattern.test(text))
    {
        return text;
    }
    if (/^[a-f0-9]{64}$/u.test(text))
    {
        return `sha256:${text}`;
    }
    return digestCommentFixtureValue(value);
}

function requirePositiveId(value, label)
{
    const text = String(value ?? '').trim();
    if (!/^[1-9][0-9]*$/u.test(text))
    {
        throw new Error(`comment-moderation requires ${label}`);
    }
    return Number(text);
}

function resolveIdentityReferences(context)
{
    const source = context?.producerOutputs?.['auth-session'];
    if (!source || source.producerId !== 'auth-session'
        || !/^[a-f0-9]{64}$/u.test(String(source.producerResultDigest ?? ''))
        || !Array.isArray(source.identityPrepareReferences))
    {
        throw new Error('comment-moderation requires current-run auth-session prepare references');
    }
    const expected = new Map([
        ['admin', 'auth.admin.full-permission'],
        ['primary-author', 'auth.user.active'],
        ['secondary-author', 'auth.user.active']
    ]);
    const refs = source.identityPrepareReferences
        .filter((item) => item?.consumerProducerId === PRODUCER_ID);
    if (refs.length !== expected.size)
    {
        throw new Error('comment-moderation auth roles are missing or orphaned');
    }
    const byRole = new Map();
    for (const item of refs)
    {
        const { digest, ...body } = item ?? {};
        const recalculated = createHash('sha256').update(JSON.stringify(body), 'utf8').digest('hex');
        if (item?.schema !== 'fsusblog.fixture-identity-prepare-reference.v1'
            || item.ownerProducerId !== 'auth-session' || item.verified !== false
            || item.runId !== context.runIdentity || item.namespace !== context.namespace
            || item.profileId !== context.profileIdentity?.profileId
            || item.capabilityId !== expected.get(item.role)
            || item.producerResultDigest !== source.producerResultDigest
            || digest !== recalculated || byRole.has(item.role))
        {
            throw new Error(`comment-moderation auth role ${item?.role ?? '<missing>'} is invalid`);
        }
        byRole.set(item.role, item);
    }
    for (const role of expected.keys())
    {
        if (!byRole.has(role))
        {
            throw new Error(`comment-moderation auth role ${role} is missing`);
        }
    }
    const primary = requirePositiveId(byRole.get('primary-author').publicId, 'primary account ID');
    const secondary = requirePositiveId(byRole.get('secondary-author').publicId, 'secondary account ID');
    if (primary === secondary)
    {
        throw new Error('comment-moderation authors must be independent identities');
    }
    const adminActorReferenceDigest = asDigest(byRole.get('admin').digest);
    if (!refs.some((item) => item.role === 'admin' && asDigest(item.digest) === adminActorReferenceDigest))
    {
        throw new Error('comment-moderation admin actor reference is missing from auth-session refs');
    }
    return Object.freeze({
        primaryAccountId: primary,
        secondaryAccountId: secondary,
        adminPrincipalId: requirePositiveId(byRole.get('admin').publicId, 'admin principal ID'),
        adminActorReferenceDigest,
        authProducerResultDigest: asDigest(source.producerResultDigest),
        authPrepareReferenceDigests: Object.freeze(refs.map((item) => asDigest(item.digest)).sort())
    });
}

function resolveArticleReference(context)
{
    const source = context?.producerOutputs?.['public-content'];
    const articleId = String(source?.projection?.articleId ?? '').trim();
    const resultBindingDigest = source?.temporalArtifacts?.bindingDigest;
    if (!source || source.producerId !== 'public-content' || source.strategy !== STRATEGY
        || source.structuralOnly === true || source.fallback === true
        || !source.observations?.database || !source.observations?.cache || !source.observations?.redis
        || !/^sha256:[a-f0-9]{64}$/u.test(String(resultBindingDigest ?? ''))
        || !/^[1-9][0-9]*$/u.test(articleId)
        || !(source.entityIdentities ?? []).some((item) => item.kind === 'article' && String(item.id) === articleId))
    {
        throw new Error('comment-moderation requires the current-run published article projection');
    }
    return Object.freeze({
        articleId: Number(articleId),
        publicContentProducerResultDigest: resultBindingDigest,
        articleProjectionDigest: digestCommentFixtureValue({
            articleId,
            producerResultDigest: resultBindingDigest,
            projection: source.projection
        })
    });
}

export function buildCommentFixturePlan(context)
{
    const { inventoryDigest } = readCommentFixtureInventory();
    const capabilities = [...new Set(context?.plan?.capabilities ?? [])]
        .filter((id) => ['comment.moderation-matrix', 'comment.threaded', 'moderation.policy-matrix'].includes(id))
        .sort();
    if (JSON.stringify(capabilities) !== JSON.stringify(['comment.moderation-matrix', 'comment.threaded', 'moderation.policy-matrix']))
    {
        throw new Error('comment-moderation producer requires the exact comments-moderation capability profile');
    }
    if (!context.temporalContext)
    {
        throw new Error('comment-moderation requires the canonical temporal context');
    }
    const identityReferences = resolveIdentityReferences(context);
    const articleReference = resolveArticleReference(context);
    const body = {
        schema: 'fsusblog.comment-fixture-plan.v1',
        producerId: PRODUCER_ID,
        strategy: STRATEGY,
        runId: context.runIdentity,
        namespace: context.namespace,
        testSession: resolveFixtureTestSession(context),
        profileId: context.profileIdentity?.profileId,
        capabilities,
        identityReferences,
        articleReference,
        inventoryDigest,
        capabilityCatalogDigest: asDigest(context.plan?.expandedCapabilityDigest),
        variantCatalogDigest: asDigest(context.plan?.variantPlanDigest),
        temporalContextDigest: digestCommentFixtureValue(context.temporalContext),
        producerPlanDigest: asDigest(context.variantPlan?.producerVariantPlanDigest)
    };
    return Object.freeze({ ...body, planDigest: digestCommentFixtureValue(body) });
}

async function invokeBackend(context, path, body, signal)
{
    const baseUrl = String(context.handles?.baseUrl ?? context.handles?.debugBackendUrl ?? '').replace(/\/+$/u, '');
    const secret = context.handles?.localCommentFixtureSecret ?? context.handles?.localAuthFixtureSecret ?? '';
    if (!baseUrl || !secret)
    {
        throw new Error('comment-moderation requires explicit backend URL and local fixture secret handles');
    }
    const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-Fsus-Local-Comment-Fixture-Secret': secret,
            'X-Fsus-Test-Namespace': String(context.namespace),
            'X-Fsus-Test-Run-Id': String(context.runIdentity),
            ...fixtureTestSessionHeaders(context)
        },
        body: JSON.stringify(body),
        signal
    });
    const text = await response.text();
    let payload;
    try
    {
        payload = text ? JSON.parse(text) : null;
    }
    catch
    {
        payload = null;
    }
    if (!response.ok)
    {
        throw createCommentFixtureBackendError(response.status, payload, text, body);
    }
    return payload;
}

function matchesCommentFixturePlanBinding(binding, plan)
{
    return plan?.schema === 'fsusblog.comment-fixture-plan.v1'
        && /^sha256:[a-f0-9]{64}$/u.test(plan?.planDigest)
        && binding?.runId === plan?.runId && binding?.namespace === plan?.namespace
        && binding?.testSession === plan?.testSession
        && binding?.owner === `comment-fixture:${plan?.namespace}:${plan?.runId}`
        && binding?.profileId === plan?.profileId
        && JSON.stringify(binding?.capabilities) === JSON.stringify(plan?.capabilities)
        && binding?.articleId === plan?.articleReference?.articleId
        && binding?.authProducerResultDigest === plan?.identityReferences?.authProducerResultDigest
        && JSON.stringify(binding?.authPrepareReferenceDigests) === JSON.stringify(plan?.identityReferences?.authPrepareReferenceDigests)
        && binding?.publicContentProducerResultDigest === plan?.articleReference?.publicContentProducerResultDigest
        && binding?.articleProjectionDigest === plan?.articleReference?.articleProjectionDigest
        && binding?.inventoryDigest === plan?.inventoryDigest
        && binding?.capabilityCatalogDigest === plan?.capabilityCatalogDigest
        && binding?.variantCatalogDigest === plan?.variantCatalogDigest
        && binding?.temporalContextDigest === plan?.temporalContextDigest
        && binding?.producerPlanDigest === plan?.producerPlanDigest
        && binding?.planDigest === plan?.planDigest;
}

function validCrossDomainSentinel(value, plan)
{
    return value?.schema === 'fsusblog.comment-fixture-cross-domain-sentinel.v1'
        && value.articleId === plan?.articleReference?.articleId
        && JSON.stringify(value.accountIds) === JSON.stringify([
            plan?.identityReferences?.primaryAccountId,
            plan?.identityReferences?.secondaryAccountId
        ].sort((left, right) => left - right))
        && value.adminPrincipalId === plan?.identityReferences?.adminPrincipalId
        && ['articleDigest', 'authDigest', 'adminDigest', 'securityDigest']
            .every((key) => digestPattern.test(String(value[key] ?? '')));
}

function sameCrossDomainSentinel(left, right)
{
    return JSON.stringify(left) === JSON.stringify(right);
}

export function createCommentFixtureBackendError(httpStatus, payload, text, plan)
{
    const detail = payload?.message ?? payload?.originalError?.message ?? payload?.detail ?? String(text ?? '').slice(0, 400);
    const recoveryReceipt = payload?.recoveryReceipt;
    const recoveryBinding = recoveryReceipt?.binding ?? recoveryReceipt;
    const cleanupResult = payload?.cleanupResult;
    const cleanupBinding = cleanupResult?.binding ?? cleanupResult;
    const exactRecovery = payload?.schema === 'fsusblog.comment-fixture-prepare-failure.v1'
        && ['failed', 'canceled'].includes(payload?.status)
        && recoveryReceipt && matchesCommentFixturePlanBinding(recoveryBinding, plan)
        && (!cleanupResult || matchesCommentFixturePlanBinding(cleanupBinding, plan))
        ? Object.freeze({
            schema: payload.schema,
            status: payload.status,
            originalError: payload.originalError ?? null,
            cleanupError: payload.cleanupError ?? null,
            recoveryReceipt,
            cleanupResult: cleanupResult ?? null
        })
        : null;
    const error = new Error(
        `comment fixture backend failed HTTP ${httpStatus}: ${detail}`,
        exactRecovery ? { cause: exactRecovery } : undefined);
    error.name = 'CommentFixtureBackendError';
    error.httpStatus = httpStatus;
    if (exactRecovery)
    {
        error.recovery = exactRecovery;
        error.recoveryReceipt = exactRecovery.recoveryReceipt;
        error.cleanupResult = exactRecovery.cleanupResult;
    }
    return error;
}

async function observeBackendTemporalContext(context, signal)
{
    const baseUrl = String(context.handles?.baseUrl ?? context.handles?.debugBackendUrl ?? '').replace(/\/+$/u, '');
    const secret = context.handles?.localPublicContentFixtureSecret ?? context.handles?.localAuthFixtureSecret ?? '';
    if (!baseUrl || !secret)
    {
        throw new Error('comment-moderation requires explicit temporal observation handles');
    }
    const response = await fetch(`${baseUrl}/__local/temporal-observation`, {
        headers: {
            'X-Fsus-Local-Temporal-Fixture-Secret': secret,
            ...fixtureTestSessionHeaders(context)
        },
        signal
    });
    const text = await response.text();
    let payload;
    try
    {
        payload = text ? JSON.parse(text) : null;
    }
    catch
    {
        payload = null;
    }
    if (!response.ok || !payload || typeof payload !== 'object')
    {
        throw new Error(`comment fixture temporal observation failed HTTP ${response.status}: ${text.slice(0, 400)}`);
    }
    return payload;
}

function variantForRole(role, variants)
{
    const capability = role.startsWith('region-')
        ? 'moderation.policy-matrix'
        : ['approved-root', 'pending', 'rejected', 'spam'].includes(role)
            ? 'comment.moderation-matrix'
            : 'comment.threaded';
    const matches = variants.filter((item) => item.capabilityId === capability);
    if (matches.length !== 1)
    {
        throw new Error(`comment role ${role} has no exact typed variant`);
    }
    return matches[0].id;
}

function normalizeResult(raw, context, plan, temporalObservation)
{
    const cleanupBinding = raw?.cleanupReceipt?.binding ?? raw?.cleanupReceipt;
    const moderationBinding = raw?.moderation?.binding;
    if (!raw || raw.producerId !== PRODUCER_ID || raw.strategy !== STRATEGY
        || raw.planDigest !== plan.planDigest || raw.inventoryDigest !== plan.inventoryDigest
        || !matchesCommentFixturePlanBinding(cleanupBinding, plan)
        || JSON.stringify(moderationBinding) !== JSON.stringify(cleanupBinding)
        || !digestPattern.test(String(raw.moderation?.contentDigest ?? ''))
        || raw.capabilityCatalogDigest !== plan.capabilityCatalogDigest
        || raw.variantCatalogDigest !== plan.variantCatalogDigest
        || raw.temporalContextDigest !== plan.temporalContextDigest
        || raw.producerPlanDigest !== plan.producerPlanDigest)
    {
        throw new Error('comment fixture backend result is stale or cross-plan');
    }
    if (!validCrossDomainSentinel(raw.crossDomainBefore, plan)
        || !sameCrossDomainSentinel(raw.crossDomainBefore, raw.crossDomainAfterPrepare)
        || !sameCrossDomainSentinel(raw.crossDomainBefore, raw.cleanupReceipt?.crossDomainBefore))
    {
        throw new Error('comment fixture cross-domain prepare sentinel is missing or changed');
    }
    const proofs = raw.capabilityProofs;
    if (!Array.isArray(proofs) || JSON.stringify(proofs.map((item) => item.capabilityId)) !== JSON.stringify(plan.capabilities)
        || proofs.some((item) => item.status !== 'verified'
            || [item.thread, item.moderation, item.publicReadModel, item.adminReadModel, item.queue, item.cacheOutbox].some((value) => value !== 'exact')))
    {
        throw new Error('comment fixture capability proof is partial');
    }
    const zkAuthorityEvidence = raw.zkAuthorityEvidence;
    if (!Array.isArray(zkAuthorityEvidence)
        || JSON.stringify(zkAuthorityEvidence.map((item) => item.semanticRole).sort())
            !== JSON.stringify(['pending', 'region-manual-review'])
        || zkAuthorityEvidence.some((item) => item.schema !== 'fsusblog.comment-fixture-zk-authority-evidence.v1'
            || item.authorityClass !== 'local-dev-simulation'
            || item.backend !== 'local_dev_fixture'
            || item.simulation !== true
            || item.productionUsable !== false
            || item.ticketStoredInProductionOneTimeStore !== true
            || item.ticketExposed !== false
            || !/^[a-f0-9]{64}$/u.test(item.operationPlanDigest)
            || !/^[a-f0-9]{64}$/u.test(item.publicInputsDigest)
            || !/^[a-f0-9]{64}$/u.test(item.rootDigest)))
    {
        throw new Error('comment fixture ZK authority evidence is missing, secret-bearing, or production-ambiguous');
    }
    const variants = context.variantPlan?.variants ?? [];
    const moderationByRole = new Map((raw.moderation?.entities ?? []).map((item) => [item.semanticRole, item]));
    const entities = raw.threadEntities.map((item) =>
    {
        const moderation = moderationByRole.get(item.semanticRole);
        const variantId = variantForRole(item.semanticRole, variants);
        return {
            kind: item.semanticRole.startsWith('region-') ? 'moderation-policy' : 'comment',
            id: String(item.commentId),
            variantId,
            fields: {
                capabilityId: moderation?.capabilityId ?? null,
                semanticRole: item.semanticRole,
                articleId: String(item.articleId),
                actorMode: item.actorMode,
                rootId: String(item.rootId),
                parentId: item.parentId == null ? null : String(item.parentId),
                replyToCommentId: item.replyToCommentId == null ? null : String(item.replyToCommentId),
                threadDepth: item.depth,
                currentVersion: item.currentVersion,
                isDeleted: item.isDeleted,
                contentDigest: item.contentDigest,
                history: item.history,
                publicVisible: moderation?.publiclyVisible ?? item.publiclyVisible,
                moderationStatus: moderation?.semanticStatus ?? item.moderationStatus,
                moderationRuntimeStatus: moderation?.runtimeStatus ?? item.moderationStatus,
                moderationReason: moderation?.reason ?? null,
                commentReferenceDigest: moderation?.commentReferenceDigest ?? null,
                reasonId: moderation?.reasonId ?? null,
                regionStateId: moderation?.regionStateId ?? null,
                signalStateId: moderation?.signalStateId ?? null,
                moderatedByAdminPrincipalId: moderation?.moderatedByAdminPrincipalId == null
                    ? null
                    : String(moderation.moderatedByAdminPrincipalId),
                moderatedAt: moderation?.moderatedAt ?? null,
                adminVisible: moderation?.adminVisible ?? false,
                adminStatus: moderation?.adminStatus ?? null,
                adminModerationActor: moderation?.adminModerationActor ?? null,
                queueMember: moderation?.queueMember ?? null,
                queueBucket: moderation?.queueBucket ?? null,
                queueGroup: moderation?.queueGroup ?? null,
                queueReason: moderation?.queueReason ?? null,
                queueActor: moderation?.queueActor ?? null,
                queueOrder: moderation?.queueOrder ?? null,
                queueMembershipSize: moderation?.queueMembershipSize ?? null,
                regionCode: moderation?.regionCode ?? null,
                applicableRegions: moderation?.applicableRegions ?? [],
                regionRequiresManualReview: moderation?.regionRequiresManualReview ?? null,
                regionPolicyVersion: moderation?.regionPolicyVersion ?? null,
                regionEvidence: moderation?.regionEvidence ?? [],
                signalEvidence: moderation?.signalEvidence ?? [],
                moderationEventIds: moderation?.moderationEventIds ?? [],
                depthOverrunFailureCode: item.semanticRole === 'depth-root'
                    ? raw.negativeResults?.['depth-overrun-negative'] ?? null
                    : null,
                outboxEventIds: moderation?.outboxEventIds ?? item.outboxEventIds
            }
        };
    });
    if (new Set(entities.map((item) => item.id)).size !== entities.length)
    {
        throw new Error('comment fixture reused an entity identity');
    }
    const entityIdentities = entities.map((item) => ({ kind: item.kind, id: item.id, variantId: item.variantId }));
    const cacheGenerationBefore = String(raw.cacheGenerationBefore ?? '');
    const cacheGenerationAfter = String(raw.cacheGenerationAfter ?? '');
    if (!/^[0-9]+$/u.test(cacheGenerationBefore) || !/^[1-9][0-9]*$/u.test(cacheGenerationAfter)
        || BigInt(cacheGenerationAfter) <= BigInt(cacheGenerationBefore))
    {
        throw new Error('comment fixture lacks an advanced production cache generation');
    }
    return Object.freeze({
        producerId: PRODUCER_ID,
        strategy: STRATEGY,
        implementation: 'src/backend/Services/Fixtures/CommentFixtureSeeder.cs',
        planDigest: plan.planDigest,
        inventoryDigest: plan.inventoryDigest,
        identityProducerResultDigest: plan.identityReferences.authProducerResultDigest,
        publicContentProducerResultDigest: plan.articleReference.publicContentProducerResultDigest,
        capabilities: plan.capabilities,
        providedCapabilities: plan.capabilities,
        variantIds: Object.freeze(context.variantPlan.variants.map((item) => item.id).sort()),
        producerVariantPlanDigest: context.variantPlan.producerVariantPlanDigest,
        capabilityProofs: proofs,
        entityIdentities,
        observations: {
            database: {
                namespace: context.namespace,
                schemaIdentity: fixtureTestSessionSchema(context),
                entities: entities.map((item) => ({ ...item, owned: true }))
            },
            redis: {
                namespace: context.namespace,
                keys: []
            },
            cache: {
                namespace: context.namespace,
                generation: cacheGenerationAfter,
                entries: [{
                    domain: 'redis.cache.public',
                    generation: cacheGenerationAfter,
                    matchesDb: true,
                    visibleEntityIds: entities.filter((item) => item.fields.publicVisible).map((item) => item.id)
                }]
            }
        },
        databaseObservation: null,
        redisObservation: null,
        cacheObservation: null,
        cleanupReceipt: raw.cleanupReceipt,
        cleanupContract: { kind: 'comment-exact-receipt', receipt: raw.cleanupReceipt },
        threadEntities: raw.threadEntities,
        zkAuthorityEvidence,
        moderation: raw.moderation,
        negativeResults: raw.negativeResults,
        cacheGenerationBefore,
        cacheGenerationAfter,
        crossDomainBefore: raw.crossDomainBefore,
        crossDomainAfterPrepare: raw.crossDomainAfterPrepare,
        runtimeSemantics: raw.moderation.runtimeSemantics,
        postconditions: [],
        temporalObservation
    });
}

export async function prepareCommentModeration(context, signal)
{
    const plan = buildCommentFixturePlan(context);
    const raw = await invokeBackend(context, '/api/local/comment-fixture/prepare', plan, signal);
    const temporalObservation = await observeBackendTemporalContext(context, signal);
    return normalizeResult(raw, context, plan, temporalObservation);
}

const moderationEntityExpectations = Object.freeze({
    'approved-root': Object.freeze({
        capabilityId: 'comment.moderation.approved',
        semanticStatus: 'approved',
        runtimeStatus: 'approved',
        publicVisible: true,
        queueMember: false,
        queueBucket: 'approved',
        regionStateId: null,
        signalStateId: null
    }),
    pending: Object.freeze({
        capabilityId: 'comment.moderation.pending',
        semanticStatus: 'pending',
        runtimeStatus: 'pending',
        publicVisible: false,
        queueMember: true,
        queueBucket: 'pending',
        regionStateId: null,
        signalStateId: null
    }),
    rejected: Object.freeze({
        capabilityId: 'comment.moderation.rejected',
        semanticStatus: 'rejected',
        runtimeStatus: 'rejected',
        publicVisible: false,
        queueMember: true,
        queueBucket: 'rejected',
        regionStateId: null,
        signalStateId: null
    }),
    spam: Object.freeze({
        capabilityId: 'comment.moderation.spam',
        semanticStatus: 'spam',
        runtimeStatus: 'rejected',
        publicVisible: false,
        queueMember: true,
        queueBucket: 'rejected',
        regionStateId: null,
        signalStateId: 'verified'
    }),
    'region-global': Object.freeze({
        capabilityId: 'comment.region.global',
        semanticStatus: 'approved',
        runtimeStatus: 'approved',
        publicVisible: true,
        queueMember: false,
        queueBucket: 'approved',
        regionStateId: 'global',
        signalStateId: null,
        regionRequiresManualReview: false
    }),
    'region-manual-review': Object.freeze({
        capabilityId: 'comment.region.manual-review',
        semanticStatus: 'pending',
        runtimeStatus: 'pending',
        publicVisible: false,
        queueMember: true,
        queueBucket: 'pending',
        regionStateId: 'manual-review',
        signalStateId: null,
        regionRequiresManualReview: true
    })
});

function requireNonEmptyString(value, label)
{
    if (typeof value !== 'string' || value.trim().length === 0)
    {
        throw new Error(`${label} is missing`);
    }
}

function requirePositiveFixtureId(value, label)
{
    if (!/^[1-9][0-9]*$/u.test(String(value ?? '')))
    {
        throw new Error(`${label} is invalid`);
    }
}

function verifySignalEvidence(entity, role)
{
    const evidence = entity.signalEvidence;
    if (!Array.isArray(evidence))
    {
        throw new Error(`${role} signal evidence is not an array`);
    }
    for (const item of evidence)
    {
        requirePositiveFixtureId(item?.signalId, `${role} signal ID`);
        if (String(item?.commentId) !== String(entity.commentId))
        {
            throw new Error(`${role} signal comment identity drifted`);
        }
        for (const field of ['provider', 'contractVersion', 'classification', 'source', 'model'])
        {
            requireNonEmptyString(item?.[field], `${role} signal ${field}`);
        }
        if (item.status !== 'ok'
            || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1
            || !Number.isFinite(item.score) || item.score !== item.confidence
            || !digestPattern.test(String(item.evidenceDigest ?? ''))
            || !Array.isArray(item.evidenceRefs) || item.evidenceRefs.length === 0
            || item.evidenceRefs.some((ref) => !digestPattern.test(String(ref))))
        {
            throw new Error(`${role} signal score/status/evidence binding is invalid`);
        }
        if (!item.evidenceRefs.includes(item.evidenceDigest))
        {
            throw new Error(`${role} signal evidence digest is not referenced`);
        }
    }
}

function verifyRegionEvidence(entity, role, expected)
{
    requireNonEmptyString(entity.regionCode, `${role} region code`);
    requireNonEmptyString(entity.regionPolicyVersion, `${role} region policy version`);
    if (entity.regionStateId !== expected.regionStateId
        || entity.regionRequiresManualReview !== expected.regionRequiresManualReview
        || !Array.isArray(entity.applicableRegions)
        || !entity.applicableRegions.includes(entity.regionCode))
    {
        throw new Error(`${role} region state/jurisdiction binding is invalid`);
    }
    if (!Array.isArray(entity.regionEvidence) || entity.regionEvidence.length === 0)
    {
        throw new Error(`${role} region evidence is missing`);
    }
    for (const item of entity.regionEvidence)
    {
        if (String(item?.commentId) !== String(entity.commentId)
            || !['comment_region_compliance', 'comment_blocked_region'].includes(item?.source)
            || typeof item?.regionCode !== 'string' || item.regionCode.length === 0
            || item.policyVersion !== entity.regionPolicyVersion
            || typeof item?.canPublish !== 'boolean'
            || typeof item?.requiresManualReview !== 'boolean'
            || typeof item?.hideUntilReviewed !== 'boolean'
            || !Array.isArray(item?.blockedRegions)
            || !digestPattern.test(String(item?.decisionDigest ?? '')))
        {
            throw new Error(`${role} region evidence binding is invalid`);
        }
        requireNonEmptyString(item.provider, `${role} region provider`);
        requireNonEmptyString(item.decisionReason, `${role} region decision reason`);
    }
}

function verifyModerationEntities(result)
{
    if (result.moderation?.schema !== 'fsusblog.comment-moderation-fixture-result.v1'
        || JSON.stringify(result.moderation.binding) !== JSON.stringify(result.cleanupReceipt?.binding))
    {
        throw new Error('comment fixture moderation result binding is stale');
    }
    const entities = result.moderation.entities;
    if (!Array.isArray(entities) || entities.length !== Object.keys(moderationEntityExpectations).length)
    {
        throw new Error('comment fixture moderation matrix is incomplete');
    }
    const byRole = new Map();
    for (const entity of entities)
    {
        if (!moderationEntityExpectations[entity?.semanticRole] || byRole.has(entity.semanticRole))
        {
            throw new Error('comment fixture moderation roles are duplicated or unknown');
        }
        byRole.set(entity.semanticRole, entity);
    }
    const queuePositions = new Set();
    for (const [role, expected] of Object.entries(moderationEntityExpectations))
    {
        const entity = byRole.get(role);
        if (!entity || entity.capabilityId !== expected.capabilityId
            || entity.semanticStatus !== expected.semanticStatus
            || entity.runtimeStatus !== expected.runtimeStatus
            || entity.publiclyVisible !== expected.publicVisible
            || entity.queueMember !== expected.queueMember
            || entity.queueBucket !== expected.queueBucket
            || entity.queueGroup !== expected.queueBucket
            || entity.regionStateId !== expected.regionStateId
            || entity.signalStateId !== expected.signalStateId
            || !digestPattern.test(String(entity.commentReferenceDigest ?? ''))
            || entity.adminVisible !== true
            || entity.adminStatus !== expected.runtimeStatus)
        {
            throw new Error(`${role} moderation/public/admin semantic binding is invalid`);
        }
        requirePositiveFixtureId(entity.commentId, `${role} comment ID`);
        requireNonEmptyString(entity.adminModerationActor, `${role} admin moderation actor`);
        requireNonEmptyString(entity.queueActor, `${role} queue actor`);
        if (entity.queueReason !== (entity.reason ?? null))
        {
            throw new Error(`${role} queue reason is not bound to moderation reason`);
        }
        if (!Number.isSafeInteger(entity.queueOrder) || !Number.isSafeInteger(entity.queueMembershipSize)
            || entity.queueMembershipSize < 0
            || (entity.queueMember
                ? entity.queueOrder < 0 || entity.queueOrder >= entity.queueMembershipSize
                : entity.queueOrder !== -1))
        {
            throw new Error(`${role} queue order/membership evidence is invalid`);
        }
        if (entity.queueMember)
        {
            const position = `${entity.queueBucket}:${entity.queueOrder}`;
            if (queuePositions.has(position))
            {
                throw new Error(`${role} queue order is duplicated`);
            }
            queuePositions.add(position);
        }
        if (!Array.isArray(entity.moderationEventIds) || entity.moderationEventIds.length === 0
            || new Set(entity.moderationEventIds).size !== entity.moderationEventIds.length
            || entity.moderationEventIds.some((id) => !/^[1-9][0-9]*$/u.test(String(id)))
            || !Array.isArray(entity.outboxEventIds) || entity.outboxEventIds.length === 0
            || new Set(entity.outboxEventIds).size !== entity.outboxEventIds.length
            || entity.outboxEventIds.some((id) => !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(String(id))))
        {
            throw new Error(`${role} audit/outbox evidence is incomplete`);
        }
        const needsAdminActor = ['approved-root', 'rejected', 'spam', 'region-global'].includes(role);
        if (needsAdminActor
            && (!/^[1-9][0-9]*$/u.test(String(entity.moderatedByAdminPrincipalId ?? ''))
                || typeof entity.moderatedAt !== 'string' || entity.moderatedAt.length === 0))
        {
            throw new Error(`${role} admin actor evidence is incomplete`);
        }
        verifySignalEvidence(entity, role);
        if (role.startsWith('region-'))
        {
            verifyRegionEvidence(entity, role, expected);
        }
        else if (role === 'spam' && entity.signalEvidence.length !== 1)
        {
            throw new Error('spam must expose exactly one moderation signal');
        }
    }
}

export async function verifyCommentModeration(context, result)
{
    try
    {
        if (!result || result.producerId !== PRODUCER_ID || !Array.isArray(result.entityIdentities)
            || !result.observations?.database || !result.observations?.cache
            || !Array.isArray(result.zkAuthorityEvidence) || result.zkAuthorityEvidence.length !== 2
            || result.observations.cache.entries.some((item) => item.matchesDb !== true)
            || result.capabilityProofs.some((item) => item.status !== 'verified')
            || result.crossDomainBefore?.schema !== 'fsusblog.comment-fixture-cross-domain-sentinel.v1'
            || !sameCrossDomainSentinel(result.crossDomainBefore, result.crossDomainAfterPrepare)
            || !sameCrossDomainSentinel(result.crossDomainBefore, result.cleanupReceipt?.crossDomainBefore))
        {
            throw new Error('comment fixture verified result is incomplete');
        }
        const semantics = result.runtimeSemantics;
        if (semantics?.schema !== 'fsusblog.comment-fixture-runtime-semantics.v1'
            || semantics.publicVisibility?.approved !== 'visible-exact'
            || ['pending', 'rejected', 'spam'].some((status) => semantics.publicVisibility?.[status] !== 'hidden-exact')
            || ['approved', 'pending', 'rejected', 'spam'].some((status) => semantics.adminVisibility?.[status] !== 'visible-exact')
            || semantics.queueMembership?.approved !== 'excluded'
            || semantics.queueMembership?.pending !== 'included-pending'
            || semantics.queueMembership?.rejected !== 'included-rejected'
            || semantics.queueMembership?.spam !== 'included-rejected')
        {
            throw new Error('comment fixture runtime semantic evidence drifted');
        }
        if (!digestPattern.test(String(result.moderation?.contentDigest ?? ''))
            || (result.moderation?.entities ?? []).some((item) => item.adminVisible !== true
                || typeof item.adminStatus !== 'string' || item.adminStatus.length === 0
                || typeof item.adminModerationActor !== 'string' || item.adminModerationActor.length === 0
                || typeof item.queueGroup !== 'string' || item.queueGroup.length === 0
                || typeof item.queueActor !== 'string' || item.queueActor.length === 0))
        {
            throw new Error('comment fixture admin/queue evidence is incomplete');
        }
        verifyModerationEntities(result);
        return { ok: true, producerId: PRODUCER_ID };
    }
    catch (error)
    {
        return { ok: false, producerId: PRODUCER_ID, reason: error.message };
    }
}

export async function cleanupCommentModeration(context, result, signal)
{
    const receipt = result?.cleanupReceipt ?? result?.cleanupContract?.receipt;
    if (!receipt)
    {
        throw new Error('comment fixture exact cleanup receipt is missing');
    }
    const cleanup = await invokeBackend(context, '/api/local/comment-fixture/cleanup', receipt, signal);
    const receiptBinding = receipt.binding ?? receipt;
    const cleanupBinding = cleanup?.binding ?? cleanup;
    const expectedIds = Object.keys(receipt.ownedComments ?? {}).sort((left, right) => BigInt(left) < BigInt(right) ? -1 : 1);
    const deletedIds = (cleanup?.deletedCommentIds ?? []).map(String).sort((left, right) => BigInt(left) < BigInt(right) ? -1 : 1);
    if (cleanup?.schema !== 'fsusblog.comment-thread-fixture-cleanup-result.v1'
        || receipt.crossDomainBefore?.schema !== 'fsusblog.comment-fixture-cross-domain-sentinel.v1'
        || cleanup.crossDomainBefore?.schema !== 'fsusblog.comment-fixture-cross-domain-sentinel.v1'
        || cleanup.crossDomainAfter?.schema !== 'fsusblog.comment-fixture-cross-domain-sentinel.v1'
        || cleanupBinding.runId !== receiptBinding.runId || cleanupBinding.namespace !== receiptBinding.namespace
        || cleanupBinding.testSession !== receiptBinding.testSession
        || cleanupBinding.owner !== receiptBinding.owner || cleanupBinding.inventoryDigest !== receiptBinding.inventoryDigest
        || cleanup.exact !== true || (cleanup.stillPublicCommentIds ?? []).length !== 0
        || JSON.stringify(deletedIds) !== JSON.stringify(expectedIds)
        || !sameCrossDomainSentinel(cleanup.crossDomainBefore, receipt.crossDomainBefore)
        || !sameCrossDomainSentinel(cleanup.crossDomainAfter, receipt.crossDomainBefore))
    {
        throw new Error('comment fixture cleanup result is incomplete or cross-run');
    }
    return Object.freeze(cleanup);
}
