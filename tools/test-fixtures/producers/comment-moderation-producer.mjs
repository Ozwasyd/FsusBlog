import { createHash } from 'node:crypto';

// fixture-catalog: producer comment-moderation

import {
    digestCommentFixtureValue,
    readCommentFixtureInventory
} from '../../test/comment-fixture-contract.mjs';
import {
    fixtureTestSessionHeaders,
    fixtureTestSessionSchema,
    resolveFixtureTestSession
} from '../runtime-scope.mjs';

const PRODUCER_ID = 'comment-moderation';
const STRATEGY = 'transaction-fixture';
const digestPattern = /^sha256:[a-f0-9]{64}$/u;

function asDigest(value)
{
    const text = String(value ?? '');
    if (digestPattern.test(text)) return text;
    if (/^[a-f0-9]{64}$/u.test(text)) return `sha256:${text}`;
    return digestCommentFixtureValue(value);
}

function requirePositiveId(value, label)
{
    const text = String(value ?? '').trim();
    if (!/^[1-9][0-9]*$/u.test(text)) throw new Error(`comment-moderation requires ${label}`);
    return Number(text);
}

function resolveIdentityReferences(context)
{
    const source = context?.producerOutputs?.['auth-session'];
    if (!source || source.producerId !== 'auth-session'
        || !/^[a-f0-9]{64}$/u.test(String(source.producerResultDigest ?? ''))
        || !Array.isArray(source.identityPrepareReferences))
        throw new Error('comment-moderation requires current-run auth-session prepare references');
    const expected = new Map([
        ['admin', 'auth.admin.full-permission'],
        ['primary-author', 'auth.user.active'],
        ['secondary-author', 'auth.user.active']
    ]);
    const refs = source.identityPrepareReferences
        .filter((item) => item?.consumerProducerId === PRODUCER_ID);
    if (refs.length !== expected.size) throw new Error('comment-moderation auth roles are missing or orphaned');
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
            throw new Error(`comment-moderation auth role ${item?.role ?? '<missing>'} is invalid`);
        byRole.set(item.role, item);
    }
    for (const role of expected.keys()) if (!byRole.has(role)) throw new Error(`comment-moderation auth role ${role} is missing`);
    const primary = requirePositiveId(byRole.get('primary-author').publicId, 'primary account ID');
    const secondary = requirePositiveId(byRole.get('secondary-author').publicId, 'secondary account ID');
    if (primary === secondary) throw new Error('comment-moderation authors must be independent identities');
    return Object.freeze({
        primaryAccountId: primary,
        secondaryAccountId: secondary,
        adminPrincipalId: requirePositiveId(byRole.get('admin').publicId, 'admin principal ID'),
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
        throw new Error('comment-moderation requires the current-run published article projection');
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
    const { inventory, inventoryDigest } = readCommentFixtureInventory();
    const capabilities = [...new Set(context?.plan?.capabilities ?? [])]
        .filter((id) => ['comment.moderation-matrix', 'comment.threaded', 'moderation.policy-matrix'].includes(id))
        .sort();
    if (JSON.stringify(capabilities) !== JSON.stringify(['comment.moderation-matrix', 'comment.threaded', 'moderation.policy-matrix']))
        throw new Error('comment-moderation producer requires the exact comments-moderation capability profile');
    if (!context.temporalContext) throw new Error('comment-moderation requires the canonical temporal context');
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
    if (!baseUrl || !secret) throw new Error('comment-moderation requires explicit backend URL and local fixture secret handles');
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
    try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
    if (!response.ok) throw new Error(`comment fixture backend failed HTTP ${response.status}: ${payload?.detail ?? text.slice(0, 400)}`);
    return payload;
}

async function observeBackendTemporalContext(context, signal)
{
    const baseUrl = String(context.handles?.baseUrl ?? context.handles?.debugBackendUrl ?? '').replace(/\/+$/u, '');
    const secret = context.handles?.localPublicContentFixtureSecret ?? context.handles?.localAuthFixtureSecret ?? '';
    if (!baseUrl || !secret) throw new Error('comment-moderation requires explicit temporal observation handles');
    const response = await fetch(`${baseUrl}/__local/temporal-observation`, {
        headers: {
            'X-Fsus-Local-Temporal-Fixture-Secret': secret,
            ...fixtureTestSessionHeaders(context)
        },
        signal
    });
    const text = await response.text();
    let payload;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
    if (!response.ok || !payload || typeof payload !== 'object')
        throw new Error(`comment fixture temporal observation failed HTTP ${response.status}: ${text.slice(0, 400)}`);
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
    if (matches.length !== 1) throw new Error(`comment role ${role} has no exact typed variant`);
    return matches[0].id;
}

function normalizeResult(raw, context, plan, temporalObservation)
{
    const cleanupBinding = raw?.cleanupReceipt?.binding ?? raw?.cleanupReceipt;
    const moderationBinding = raw?.moderation?.binding;
    if (!raw || raw.producerId !== PRODUCER_ID || raw.strategy !== STRATEGY
        || raw.planDigest !== plan.planDigest || raw.inventoryDigest !== plan.inventoryDigest
        || cleanupBinding?.runId !== plan.runId || cleanupBinding?.namespace !== plan.namespace
        || cleanupBinding?.testSession !== plan.testSession || cleanupBinding?.owner !== `comment-fixture:${plan.namespace}:${plan.runId}`
        || cleanupBinding?.profileId !== plan.profileId
        || JSON.stringify(cleanupBinding?.capabilities) !== JSON.stringify(plan.capabilities)
        || cleanupBinding?.articleId !== plan.articleReference.articleId
        || cleanupBinding?.authProducerResultDigest !== plan.identityReferences.authProducerResultDigest
        || JSON.stringify(cleanupBinding?.authPrepareReferenceDigests) !== JSON.stringify(plan.identityReferences.authPrepareReferenceDigests)
        || cleanupBinding?.publicContentProducerResultDigest !== plan.articleReference.publicContentProducerResultDigest
        || cleanupBinding?.articleProjectionDigest !== plan.articleReference.articleProjectionDigest
        || cleanupBinding?.inventoryDigest !== plan.inventoryDigest
        || cleanupBinding?.capabilityCatalogDigest !== plan.capabilityCatalogDigest
        || cleanupBinding?.variantCatalogDigest !== plan.variantCatalogDigest
        || cleanupBinding?.temporalContextDigest !== plan.temporalContextDigest
        || cleanupBinding?.producerPlanDigest !== plan.producerPlanDigest
        || cleanupBinding?.planDigest !== plan.planDigest
        || JSON.stringify(moderationBinding) !== JSON.stringify(cleanupBinding)
        || raw.capabilityCatalogDigest !== plan.capabilityCatalogDigest
        || raw.variantCatalogDigest !== plan.variantCatalogDigest
        || raw.temporalContextDigest !== plan.temporalContextDigest
        || raw.producerPlanDigest !== plan.producerPlanDigest)
        throw new Error('comment fixture backend result is stale or cross-plan');
    const proofs = raw.capabilityProofs;
    if (!Array.isArray(proofs) || JSON.stringify(proofs.map((item) => item.capabilityId)) !== JSON.stringify(plan.capabilities)
        || proofs.some((item) => item.status !== 'verified'
            || [item.thread, item.moderation, item.publicReadModel, item.adminReadModel, item.queue, item.cacheOutbox].some((value) => value !== 'exact')))
        throw new Error('comment fixture capability proof is partial');
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
        throw new Error('comment fixture ZK authority evidence is missing, secret-bearing, or production-ambiguous');
    const variants = context.variantPlan?.variants ?? [];
    const moderationByRole = new Map((raw.moderation?.entities ?? []).map((item) => [item.semanticRole, item]));
    const entities = raw.threadEntities.map((item) => {
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
                moderatedByAdminPrincipalId: moderation?.moderatedByAdminPrincipalId == null
                    ? null
                    : String(moderation.moderatedByAdminPrincipalId),
                moderatedAt: moderation?.moderatedAt ?? null,
                queueMember: moderation?.queueMember ?? null,
                queueBucket: moderation?.queueBucket ?? null,
                queueOrder: moderation?.queueOrder ?? null,
                queueMembershipSize: moderation?.queueMembershipSize ?? null,
                regionCode: moderation?.regionCode ?? null,
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
    if (new Set(entities.map((item) => item.id)).size !== entities.length) throw new Error('comment fixture reused an entity identity');
    const entityIdentities = entities.map((item) => ({ kind: item.kind, id: item.id, variantId: item.variantId }));
    const cacheGenerationBefore = String(raw.cacheGenerationBefore ?? '');
    const cacheGenerationAfter = String(raw.cacheGenerationAfter ?? '');
    if (!/^[0-9]+$/u.test(cacheGenerationBefore) || !/^[1-9][0-9]*$/u.test(cacheGenerationAfter)
        || BigInt(cacheGenerationAfter) <= BigInt(cacheGenerationBefore))
        throw new Error('comment fixture lacks an advanced production cache generation');
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

export async function verifyCommentModeration(context, result)
{
    try
    {
        if (!result || result.producerId !== PRODUCER_ID || !Array.isArray(result.entityIdentities)
            || !result.observations?.database || !result.observations?.cache
            || !Array.isArray(result.zkAuthorityEvidence) || result.zkAuthorityEvidence.length !== 2
            || result.observations.cache.entries.some((item) => item.matchesDb !== true)
            || result.capabilityProofs.some((item) => item.status !== 'verified'))
            throw new Error('comment fixture verified result is incomplete');
        const semantics = result.runtimeSemantics;
        if (semantics?.schema !== 'fsusblog.comment-fixture-runtime-semantics.v1'
            || semantics.publicVisibility?.approved !== 'visible-exact'
            || ['pending', 'rejected', 'spam'].some((status) => semantics.publicVisibility?.[status] !== 'hidden-exact')
            || semantics.queueMembership?.approved !== 'excluded'
            || semantics.queueMembership?.pending !== 'included-pending'
            || semantics.queueMembership?.rejected !== 'included-rejected'
            || semantics.queueMembership?.spam !== 'included-rejected')
            throw new Error('comment fixture runtime semantic evidence drifted');
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
    if (!receipt) throw new Error('comment fixture exact cleanup receipt is missing');
    const cleanup = await invokeBackend(context, '/api/local/comment-fixture/cleanup', receipt, signal);
    const receiptBinding = receipt.binding ?? receipt;
    const cleanupBinding = cleanup?.binding ?? cleanup;
    const expectedIds = Object.keys(receipt.ownedComments ?? {}).sort((left, right) => BigInt(left) < BigInt(right) ? -1 : 1);
    const deletedIds = (cleanup?.deletedCommentIds ?? []).map(String).sort((left, right) => BigInt(left) < BigInt(right) ? -1 : 1);
    if (cleanup?.schema !== 'fsusblog.comment-thread-fixture-cleanup-result.v1'
        || cleanupBinding.runId !== receiptBinding.runId || cleanupBinding.namespace !== receiptBinding.namespace
        || cleanupBinding.testSession !== receiptBinding.testSession
        || cleanupBinding.owner !== receiptBinding.owner || cleanupBinding.inventoryDigest !== receiptBinding.inventoryDigest
        || cleanup.exact !== true || (cleanup.stillPublicCommentIds ?? []).length !== 0
        || JSON.stringify(deletedIds) !== JSON.stringify(expectedIds))
        throw new Error('comment fixture cleanup result is incomplete or cross-run');
    return Object.freeze(cleanup);
}
