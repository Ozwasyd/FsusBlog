import { createHash } from 'node:crypto';

// fixture-catalog: producer account-messaging

import {
    digestMessagingFixtureValue,
    readMessagingFixtureContract
} from '../../test/messaging-fixture-contract.mjs';
import { projectVerifiedIdentityReferences } from './auth-session-producer.mjs';

const PRODUCER_ID = 'account-messaging';
const STRATEGY = 'transaction-fixture';
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const integerPattern = /^[1-9][0-9]*$/u;
const forbiddenArtifactKeys = new Set([
    'body',
    'cookie',
    'notificationPayload',
    'sessionId',
    'token'
]);

function assertNoLegacyEnvironment()
{
    for (const key of [
        'FSUSBLOG_FIXTURE_PRODUCER_STRATEGY',
        'FSUSBLOG_MESSAGE_FIXTURE_STRATEGY',
        'FSUSBLOG_MESSAGE_RECIPIENT',
        'FSUSBLOG_NOTIFICATION_MOCK',
        'FSUSBLOG_FORCE_DIRECT_DB_SEED'
    ])
    {
        if (process.env[key])
        {
            throw new Error(`account-messaging legacy environment override ${key} is forbidden`);
        }
    }
}

function profileCapabilities(context)
{
    const selected = new Set(context?.plan?.capabilities ?? []);
    const contract = readMessagingFixtureContract();
    const requested = contract.capabilityIds.filter((id) => selected.has(id));
    if (selected.has('messages.thread'))
    {
        requested.push(...contract.capabilityIds.filter((id) => id.startsWith('messages.')));
    }
    if (selected.has('notifications.unread'))
    {
        requested.push(...contract.capabilityIds.filter((id) => id.startsWith('notifications.')));
    }
    return [...new Set(requested)].sort();
}

function positiveIdentity(value, label)
{
    const normalized = String(value ?? '').trim();
    if (!integerPattern.test(normalized))
    {
        throw new Error(`account-messaging requires verified ${label}`);
    }
    return normalized;
}

export function resolveMessagingIdentityReferences(context)
{
    const source = context?.producerOutputs?.['auth-session'] ?? null;
    if (!source
        || source.producerId !== 'auth-session'
        || !/^[a-f0-9]{64}$/u.test(String(source.producerResultDigest ?? ''))
        || !Array.isArray(source.identityPrepareReferences))
    {
        throw new Error('account-messaging requires #1713 exact auth-session prepare references');
    }
    const references = source.identityPrepareReferences
        .filter((item) => item?.consumerProducerId === PRODUCER_ID);
    const expected = Object.freeze({
        'primary-recipient': 'auth.user.active',
        'secondary-recipient': 'auth.user.active',
        'empty-recipient': 'auth.user.active',
        admin: 'auth.admin.full-permission'
    });
    if (references.length !== Object.keys(expected).length)
    {
        throw new Error('account-messaging identity prepare reference roles are missing or orphaned');
    }
    const byRole = new Map();
    for (const item of references)
    {
        const { digest, ...body } = item ?? {};
        if (item?.schema !== 'fsusblog.fixture-identity-prepare-reference.v1'
            || item.verified !== false
            || item.ownerProducerId !== 'auth-session'
            || item.runId !== context.runIdentity
            || item.namespace !== context.namespace
            || item.profileId !== context.profileIdentity?.profileId
            || item.capabilityId !== expected[item.role]
            || item.producerResultDigest !== source.producerResultDigest
            || !/^[a-f0-9]{64}$/u.test(String(digest ?? ''))
            || digest !== createHash('sha256').update(JSON.stringify(body), 'utf8').digest('hex')
            || !String(item.fixtureIdentity ?? '').trim()
            || byRole.has(item.role))
        {
            throw new Error(`account-messaging identity prepare reference ${item?.role ?? '<missing>'} is invalid`);
        }
        byRole.set(item.role, item);
    }
    if ([...Object.keys(expected)].some((role) => !byRole.has(role)))
    {
        throw new Error('account-messaging identity prepare reference roles are not exact');
    }
    const primary = byRole.get('primary-recipient');
    const secondary = byRole.get('secondary-recipient');
    const empty = byRole.get('empty-recipient');
    const admin = byRole.get('admin');
    const refs = Object.freeze({
        primaryRecipientId: positiveIdentity(primary.publicId, 'primary recipient'),
        secondaryRecipientId: positiveIdentity(secondary.publicId, 'secondary recipient'),
        emptyRecipientId: positiveIdentity(empty.publicId, 'empty recipient'),
        adminId: positiveIdentity(admin.publicId, 'admin principal'),
        adminActorAuditKey: contentDigest([
            'account-messaging-admin-actor-v1',
            admin.fixtureIdentity,
            admin.digest
        ].join('\0')),
        identityProducerResultDigest: source.producerResultDigest,
        prepareReferenceDigests: Object.freeze(references.map((item) => item.digest).sort())
    });
    if (new Set([
        refs.primaryRecipientId,
        refs.secondaryRecipientId,
        refs.emptyRecipientId
    ]).size !== 3)
    {
        throw new Error('account-messaging primary, secondary, and empty recipients must be distinct');
    }
    return refs;
}

async function resolveTemporalRoles(context, resolver)
{
    if (!context.temporalContext)
    {
        throw new Error('account-messaging requires a sealed business temporal context');
    }
    let authority = resolver;
    if (!authority)
    {
        try
        {
            authority = await import('../../test/temporal-role-resolver.mjs');
        }
        catch (error)
        {
            throw new Error(`account-messaging temporal role authority is unavailable: ${error.message}`);
        }
    }
    if (typeof authority.resolveTemporalRoles !== 'function'
        || typeof authority.verifyResolvedTemporalArtifact !== 'function')
    {
        throw new Error('account-messaging temporal role authority is incomplete');
    }
    const artifact = await authority.resolveTemporalRoles({
        temporalContext: context.temporalContext,
        shapeId: 'auth-security-messaging-account-lifecycle',
        fixtureIdentity: {
            producerId: PRODUCER_ID,
            runId: context.runIdentity,
            namespace: context.namespace,
            fixtureId: PRODUCER_ID
        }
    });
    const verified = await authority.verifyResolvedTemporalArtifact(artifact, {
        temporalContext: context.temporalContext
    });
    if (verified === false || verified?.ok === false)
    {
        throw new Error('account-messaging temporal roles failed verification');
    }
    if (artifact?.schema !== 'fsusblog.resolved-temporal-roles.v1'
        || artifact?.shape?.id !== 'auth-security-messaging-account-lifecycle'
        || !digestPattern.test(String(artifact?.contentDigest ?? '')))
    {
        throw new Error('account-messaging temporal roles are not bound to the canonical messaging shape');
    }
    return artifact;
}

function requireCapabilityProofs(raw, capabilityIds)
{
    const proofs = raw?.capabilityProofs;
    if (!Array.isArray(proofs))
    {
        throw new Error('account-messaging composition root did not return capability proofs');
    }
    const ids = proofs.map((item) => item?.capabilityId);
    if (JSON.stringify(ids) !== JSON.stringify(capabilityIds))
    {
        throw new Error('account-messaging capability proofs are missing, duplicate, or orphaned');
    }
    for (const proof of proofs)
    {
        if (proof.status !== 'verified'
            || proof.database !== 'exact'
            || proof.api !== 'exact'
            || (proof.capabilityId.startsWith('notifications.') && proof.stream !== 'exact'))
        {
            throw new Error(`account-messaging capability ${proof.capabilityId} has incomplete projection parity`);
        }
        if (proof.warning != null || proof.fallback === true || proof.observed === 'count-only')
        {
            throw new Error(`account-messaging capability ${proof.capabilityId} used warning/fallback/count-only evidence`);
        }
    }
    return proofs;
}

function assertPrivacySafe(value, path = '$')
{
    if (Array.isArray(value))
    {
        value.forEach((item, index) => assertPrivacySafe(item, `${path}[${index}]`));
        return;
    }
    if (!value || typeof value !== 'object')
    {
        return;
    }
    for (const [key, child] of Object.entries(value))
    {
        if (forbiddenArtifactKeys.has(key))
        {
            throw new Error(`account-messaging ordinary artifact leaks forbidden ${path}.${key}`);
        }
        assertPrivacySafe(child, `${path}.${key}`);
    }
}

function normalizeObservations(raw, context)
{
    const observations = raw?.observations;
    if (!observations?.database || !observations?.redis || !observations?.cache)
    {
        throw new Error('account-messaging requires database, Redis/stream, and cache observations');
    }
    const namespace = context.namespace ?? null;
    for (const [kind, observation] of Object.entries(observations))
    {
        if (observation && observation.namespace !== namespace)
        {
            throw new Error(`account-messaging ${kind} observation namespace mismatch`);
        }
    }
    return observations;
}

function bindTypedVariants(context, entityIdentities, observations)
{
    const variants = context?.variantPlan?.variants;
    if (!Array.isArray(variants))
    {
        throw new Error('account-messaging requires its sealed typed variant plan');
    }
    const byCapability = new Map(variants.map((item) => [item.capabilityId, item.id]));
    const variantFor = (entity) =>
    {
        const capabilityId = entity?.kind === 'notification-cursor'
            ? 'notifications.unread'
            : ['message', 'recipient', 'thread'].includes(entity?.kind)
        ? 'messages.thread'
        : null;
        const variantId = capabilityId ? byCapability.get(capabilityId) : null;
        if (!variantId)
        {
            throw new Error(`account-messaging entity ${entity?.kind ?? '<missing>'} has no planned capability variant`);
        }
        return Object.freeze({ ...entity, variantId });
    };
    return Object.freeze({
        entityIdentities: Object.freeze(entityIdentities.map(variantFor)),
        observations: Object.freeze({
            ...observations,
            database: Object.freeze({
                ...observations.database,
                entities: Object.freeze(observations.database.entities.map(variantFor))
            })
        })
    });
}

function contentDigest(value)
{
    return `sha256:${createHash('sha256').update(String(value)).digest('hex')}`;
}

export function buildMessagingFixturePlan(context, {
    identityReferences = resolveMessagingIdentityReferences(context),
    temporalRoles
} = {})
{
    const contract = readMessagingFixtureContract();
    const capabilities = profileCapabilities(context);
    if (capabilities.length === 0)
    {
        throw new Error('account-messaging producer invoked with zero messaging capabilities');
    }
    const requested = new Set(capabilities);
    const semanticRoles = Object.freeze(contract.inventory.capabilities
        .filter((item) => requested.has(item.id))
        .map((item) => Object.freeze({
            capabilityId: item.id,
            identityRoles: Object.freeze([...item.identityRoles]),
            portId: item.portId,
            stateFields: Object.freeze([...item.stateFields])
        })));
    return Object.freeze({
        schema: 'fsusblog.messaging-fixture-plan.v1',
        producerId: PRODUCER_ID,
        strategy: STRATEGY,
        runId: context.runIdentity,
        namespace: context.namespace,
        capabilities: Object.freeze(capabilities),
        identityReferences,
        semanticRoles,
        temporalRoles,
        inventoryDigest: contract.inventoryDigest,
        ownershipDigest: contract.ownershipDigest,
        planDigest: digestMessagingFixtureValue({
            producerId: PRODUCER_ID,
            runId: context.runIdentity,
            namespace: context.namespace,
            capabilities,
            identityReferences,
            semanticRoles,
            temporalRoles,
            inventoryDigest: contract.inventoryDigest,
            ownershipDigest: contract.ownershipDigest
        })
    });
}

async function invokeCompositionRoot(context, plan, signal)
{
    const baseUrl = String(context.handles?.baseUrl
        ?? context.handles?.debugBackendUrl
        ?? process.env.FSUSBLOG_BASE_URL
        ?? '').replace(/\/+$/u, '');
    const secret = context.handles?.localMessagingFixtureSecret
        ?? context.handles?.localAuthFixtureSecret
        ?? process.env.FSUSBLOG_LOCAL_MESSAGING_FIXTURE_SECRET
        ?? process.env.FSUSBLOG_LOCAL_AUTH_FIXTURE_SECRET
        ?? '';
    if (!baseUrl || !secret)
    {
        throw new Error('account-messaging composition root requires an explicit backend URL and local fixture secret');
    }
    const response = await fetch(`${baseUrl}/api/local/messaging-fixture/prepare`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-Fsus-Local-Messaging-Fixture-Secret': secret,
            'X-Fsus-Test-Namespace': String(context.namespace ?? ''),
            'X-Fsus-Test-Run-Id': String(context.runIdentity ?? '')
        },
        body: JSON.stringify(plan),
        signal
    });
    const text = await response.text();
    let payload = null;
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
        throw new Error(`account-messaging composition root failed HTTP ${response.status}: ${payload?.detail ?? text.slice(0, 400)}`);
    }
    return payload;
}

export async function prepareAccountMessaging(context, signal, { temporalResolver = null } = {})
{
    assertNoLegacyEnvironment();
    const identityReferences = resolveMessagingIdentityReferences(context);
    const temporalRoles = await resolveTemporalRoles(context, temporalResolver);
    const plan = buildMessagingFixturePlan(context, { identityReferences, temporalRoles });
    const adapter = context.handles?.accountMessagingAdapter;
    const raw = adapter && typeof adapter.prepare === 'function'
        ? await adapter.prepare({ ...context, messagingPlan: plan }, signal)
        : await invokeCompositionRoot(context, plan, signal);
    if (!raw || typeof raw !== 'object' || raw.strategy !== STRATEGY || raw.producerId !== PRODUCER_ID)
    {
        throw new Error('account-messaging composition root returned an invalid owner/strategy');
    }
    if (raw.fallback === true || raw.mock === true || raw.structuralOnly === true)
    {
        throw new Error('account-messaging cannot use fallback, mock, or structural-only results');
    }
    assertPrivacySafe(raw);
    if (raw.planDigest !== plan.planDigest
        || raw.inventoryDigest !== plan.inventoryDigest
        || raw.ownershipDigest !== plan.ownershipDigest)
    {
        throw new Error('account-messaging composition root result is stale or cross-plan');
    }
    const capabilityProofs = requireCapabilityProofs(raw, plan.capabilities);
    const observations = normalizeObservations(raw, context);
    const entityIdentities = raw.entityIdentities;
    if (!Array.isArray(entityIdentities) || entityIdentities.length === 0)
    {
        throw new Error('account-messaging did not return receipt-owned entity identities');
    }
    const typed = bindTypedVariants(context, entityIdentities, observations);
    const result = {
        producerId: PRODUCER_ID,
        strategy: STRATEGY,
        implementation: adapter
            ? 'injected-accountMessagingAdapter'
            : 'src/backend/Services/Fixtures/MessagingFixtureSeeder.cs',
        planDigest: plan.planDigest,
        inventoryDigest: plan.inventoryDigest,
        ownershipDigest: plan.ownershipDigest,
        identityProducerResultDigest: identityReferences.identityProducerResultDigest,
        identityPrepareReferenceDigests: identityReferences.prepareReferenceDigests,
        temporalRoleArtifactDigest: temporalRoles.contentDigest,
        capabilities: plan.capabilities,
        capabilityProofs,
        entityIdentities: typed.entityIdentities,
        observations: typed.observations,
        databaseObservation: typed.observations.database,
        redisObservation: observations.redis,
        cacheObservation: observations.cache,
        temporalObservation: raw.temporalObservation ?? raw.TemporalObservation ?? null,
        cleanupReceipt: raw.cleanupReceipt,
        contentDigest: contentDigest(JSON.stringify({
            planDigest: plan.planDigest,
            capabilityProofs,
            entityIdentities: typed.entityIdentities,
            observations: typed.observations,
            cleanupReceipt: raw.cleanupReceipt
        })),
        postconditions: []
    };
    assertPrivacySafe(result);
    return Object.freeze(result);
}

export async function verifyAccountMessaging(context, producerResult)
{
    if (!producerResult || producerResult.producerId !== PRODUCER_ID)
    {
        return { ok: false, producerId: PRODUCER_ID, reason: 'producer identity mismatch' };
    }
    try
    {
        const authSessionResult = context.producerOutputs?.['auth-session'];
        const authSessionReceipt = context.producerReceipts?.['auth-session'];
        const verifiedIdentities = projectVerifiedIdentityReferences({
            producerResult: authSessionResult,
            producerReceipt: authSessionReceipt,
            consumerProducerId: PRODUCER_ID
        });
        const verifiedPrepareDigests = verifiedIdentities.references
            .map((item) => item.prepareReferenceDigest)
            .sort();
        if (producerResult.identityProducerResultDigest !== authSessionResult?.producerResultDigest
            || JSON.stringify(producerResult.identityPrepareReferenceDigests)
                !== JSON.stringify(verifiedPrepareDigests))
        {
            throw new Error('messaging identity prepare references do not bind the sealed auth-session receipt');
        }
        const contract = readMessagingFixtureContract();
        if (producerResult.inventoryDigest !== contract.inventoryDigest
            || producerResult.ownershipDigest !== contract.ownershipDigest)
        {
            throw new Error('inventory/ownership digest drift');
        }
        requireCapabilityProofs(producerResult, producerResult.capabilities);
        normalizeObservations(producerResult, context);
        assertPrivacySafe(producerResult);
        const adapter = context.handles?.accountMessagingAdapter;
        if (adapter && typeof adapter.verify === 'function')
        {
            const verification = await adapter.verify({ ...context, messagingPlanDigest: producerResult.planDigest }, producerResult);
            if (!verification || verification.ok !== true || verification.warnings?.length)
            {
                throw new Error(verification?.reason ?? 'independent adapter verification failed');
            }
        }
        return {
            ok: true,
            producerId: PRODUCER_ID,
            identitySourceReceiptDigest: verifiedIdentities.sourceReceiptDigest,
            identityReferencesDigest: verifiedIdentities.digest,
            warnings: []
        };
    }
    catch (error)
    {
        return { ok: false, producerId: PRODUCER_ID, reason: error.message };
    }
}

export async function cleanupAccountMessaging(context, producerResult, signal)
{
    const cleanupReceipt = producerResult?.cleanupReceipt;
    if (!cleanupReceipt
        || cleanupReceipt.schema !== 'fsusblog.messaging-fixture-cleanup.v1'
        || cleanupReceipt.planDigest !== producerResult.planDigest
        || cleanupReceipt.runId !== context.runIdentity
        || cleanupReceipt.namespace !== context.namespace
        || !Array.isArray(cleanupReceipt.ownedEntityIds))
    {
        throw new Error('account-messaging cleanup requires the exact prepare cleanup receipt');
    }
    const adapter = context.handles?.accountMessagingAdapter;
    if (adapter && typeof adapter.cleanup === 'function')
    {
        await adapter.cleanup(context, cleanupReceipt, signal);
        return;
    }
    const baseUrl = String(context.handles?.baseUrl
        ?? context.handles?.debugBackendUrl
        ?? process.env.FSUSBLOG_BASE_URL
        ?? '').replace(/\/+$/u, '');
    const secret = context.handles?.localMessagingFixtureSecret
        ?? context.handles?.localAuthFixtureSecret
        ?? process.env.FSUSBLOG_LOCAL_MESSAGING_FIXTURE_SECRET
        ?? process.env.FSUSBLOG_LOCAL_AUTH_FIXTURE_SECRET
        ?? '';
    if (!baseUrl || !secret)
    {
        throw new Error('account-messaging cleanup composition root is unavailable');
    }
    const response = await fetch(`${baseUrl}/api/local/messaging-fixture/cleanup`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Fsus-Local-Messaging-Fixture-Secret': secret,
            'X-Fsus-Test-Namespace': String(context.namespace ?? ''),
            'X-Fsus-Test-Run-Id': String(context.runIdentity ?? '')
        },
        body: JSON.stringify(cleanupReceipt),
        signal
    });
    if (!response.ok)
    {
        throw new Error(`account-messaging cleanup failed HTTP ${response.status}`);
    }
}
