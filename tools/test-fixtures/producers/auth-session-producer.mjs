// fixture-catalog: producer auth-session
/**
 * Unique identity/MFA/WebAuthn/session/admin transaction fixture producer.
 *
 * The producer owns orchestration and receipt shaping only. All mutations and
 * independent reads are delegated to the test-only backend composition root.
 * It never signs tokens, opens PostgreSQL/Redis, or owns security-state facts.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';

const { readPrivateJson, writePrivateJson } = await import(new URL('../receipt/private-io.mjs', import.meta.url));
const { digestCanonical } = await import(new URL('../receipt/canonical.mjs', import.meta.url));

const {resolveTemporalRolesForProducer, verifyResolvedTemporalArtifact} = await import(new URL('../../test/temporal-role-resolver.mjs', import.meta.url));
const {validateProducerReceipt} = await import(new URL('../receipt/producer-receipt.mjs', import.meta.url));
const PRODUCER_ID = 'auth-session';
const STRATEGY = 'transaction-fixture';

const CAPABILITY_ROLES = Object.freeze({
    'auth.admin.disabled': Object.freeze({ kind: 'admin', role: 'admin.disabled', state: 'disabled' }),
    'auth.admin.full-permission': Object.freeze({ kind: 'admin', role: 'admin.full-permission', state: 'active' }),
    'auth.admin.partial-permission': Object.freeze({ kind: 'admin', role: 'admin.partial-permission', state: 'active' }),
    'auth.admin.read-only': Object.freeze({ kind: 'admin', role: 'admin.read-only', state: 'active' }),
    'auth.admin.root-bootstrap-empty': Object.freeze({ kind: 'admin-root-set', role: 'admin.root-bootstrap-empty', state: 'empty' }),
    'auth.user.active': Object.freeze({ kind: 'user', role: 'user.active', state: 'active' }),
    'auth.user.deleted': Object.freeze({ kind: 'user', role: 'user.deleted', state: 'deleted' }),
    'auth.user.mfa-disabled': Object.freeze({ kind: 'user', role: 'user.mfa-disabled', state: 'active' }),
    'auth.user.mfa-enabled': Object.freeze({ kind: 'user', role: 'user.mfa-enabled', state: 'active' }),
    'auth.user.passkey-enabled': Object.freeze({ kind: 'user', role: 'user.passkey-enabled', state: 'active' }),
    'auth.user.recovery-enabled': Object.freeze({ kind: 'user', role: 'user.recovery-enabled', state: 'active' }),
    'session.expired': Object.freeze({ kind: 'session', role: 'session.expired', state: 'expired' }),
    'session.multi-device': Object.freeze({ kind: 'session', role: 'session.multi-device', state: 'active', count: 2 }),
    'session.refresh-rotated': Object.freeze({ kind: 'session', role: 'session.refresh-rotated', state: 'rotated' }),
    'session.remembered': Object.freeze({ kind: 'session', role: 'session.remembered', state: 'active' }),
    'session.revoked': Object.freeze({ kind: 'session', role: 'session.revoked', state: 'revoked' }),
    'session.single-device': Object.freeze({ kind: 'session', role: 'session.single-device', state: 'active' })
});

const FORBIDDEN_RECEIPT_KEY = /(?:access|refresh)?token|secret|private(?:key|material)|cookie|storage(?:state)?|password|recovery(?:code|material)/iu;
const FORBIDDEN_SECURITY_KEY = /ban|blacklist|risk|credentialissuance|credential-issuance|pow/iu;
const ALLOCATABLE_IDENTITY_CAPABILITIES = new Set([
    'auth.admin.full-permission',
    'auth.user.active'
]);
const STABLE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;

function stableDigest(value)
{
    return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function fixtureIdentity(namespace, runId, semanticRole)
{
    const digest = createHash('sha256')
        .update(['fsusblog-auth-fixture-v1', namespace, runId, semanticRole].join('\u0000'), 'utf8')
        .digest('hex');
    return `fxauth-${digest.slice(0, 24)}`;
}

function exactSortedStrings(values, label)
{
    if (!Array.isArray(values))
    {
        throw new Error(`${label} must be an array`);
    }
    const result = [...new Set(values.map((item) => String(item).trim()).filter(Boolean))].sort();
    if (result.length !== values.length || JSON.stringify(result) !== JSON.stringify(values))
    {
        throw new Error(`${label} must be sorted and unique`);
    }
    return result;
}

function assertNoSecret(value, path = '$')
{
    if (Array.isArray(value))
    {
        value.forEach((item, index) => assertNoSecret(item, `${path}[${index}]`));
        return;
    }
    if (!value || typeof value !== 'object')
    {
        return;
    }
    for (const [key, child] of Object.entries(value))
    {
        if (FORBIDDEN_RECEIPT_KEY.test(key))
        {
            throw new Error(`auth-session receipt contains forbidden secret field ${path}.${key}`);
        }
        assertNoSecret(child, `${path}.${key}`);
    }
}

function assertNoSecurityOwnership(value, path = '$')
{
    if (Array.isArray(value))
    {
        value.forEach((item, index) => assertNoSecurityOwnership(item, `${path}[${index}]`));
        return;
    }
    if (!value || typeof value !== 'object')
    {
        return;
    }
    for (const [key, child] of Object.entries(value))
    {
        if (FORBIDDEN_SECURITY_KEY.test(key))
        {
            throw new Error(`auth-session crossed security-state owner boundary at ${path}.${key}`);
        }
        assertNoSecurityOwnership(child, `${path}.${key}`);
    }
}

function plannedRole(capabilityId, spec, namespace, runId)
{
    const identity = fixtureIdentity(namespace, runId, spec.role);
    const base = {
        capabilityId,
        semanticRole: spec.role,
        kind: spec.kind,
        expectedState: spec.state,
        fixtureIdentity: identity,
        ownerIdentity: `${PRODUCER_ID}:${namespace}:${runId}`
    };
    if (spec.kind === 'session')
    {
        return Object.freeze({
            ...base,
            subjectRole: `user.for-${spec.role}`,
            subjectFixtureIdentity: fixtureIdentity(namespace, runId, `user.for-${spec.role}`),
            sessionCount: spec.count ?? 1,
            sessionIdentities: Object.freeze(Array.from(
                { length: spec.count ?? 1 },
                (_, index) => fixtureIdentity(namespace, runId, `${spec.role}.session-${index + 1}`)
            )),
            deviceSignals: Object.freeze(Array.from(
                { length: spec.count ?? 1 },
                (_, index) => fixtureIdentity(namespace, runId, `${spec.role}.device-${index + 1}`)
            )),
            familyIdentities: Object.freeze(Array.from(
                { length: spec.count ?? 1 },
                (_, index) => fixtureIdentity(namespace, runId, `${spec.role}.family-${index + 1}`)
            ))
        });
    }
    if (capabilityId.startsWith('auth.admin.'))
    {
        return Object.freeze({
            ...base,
            permissionProjection: capabilityId.slice('auth.admin.'.length),
            requireProductionPermissionCatalog: true
        });
    }
    if (capabilityId === 'auth.user.passkey-enabled')
    {
        return Object.freeze({ ...base, requireProductionWebAuthnCeremony: true });
    }
    if (capabilityId === 'auth.user.recovery-enabled')
    {
        return Object.freeze({ ...base, requireOpaquePrivateProjectionRef: true });
    }
    return Object.freeze(base);
}

function normalizedIdentityRoleRequests(values)
{
    if (!Array.isArray(values))
    {
        throw new Error('auth-session identity role requests must be an array');
    }
    const result = values.map((value) =>
    {
        const request = {
            ownerProducerId: String(value?.ownerProducerId ?? '').trim(),
            consumerProducerId: String(value?.consumerProducerId ?? '').trim(),
            role: String(value?.role ?? '').trim(),
            capabilityId: String(value?.capabilityId ?? '').trim()
        };
        if (request.ownerProducerId !== PRODUCER_ID
            || !STABLE_ID.test(request.consumerProducerId)
            || !STABLE_ID.test(request.role)
            || !ALLOCATABLE_IDENTITY_CAPABILITIES.has(request.capabilityId))
        {
            throw new Error('auth-session received an invalid or non-identity allocation request');
        }
        return request;
    }).sort((left, right) =>
        `${left.consumerProducerId}\0${left.role}`.localeCompare(
            `${right.consumerProducerId}\0${right.role}`,
            'en'
        ));
    const keys = result.map((item) => `${item.consumerProducerId}\0${item.role}`);
    if (new Set(keys).size !== keys.length)
    {
        throw new Error('auth-session identity allocation roles must be unique per consumer');
    }
    return Object.freeze(result.map(Object.freeze));
}

function plannedAllocatedRole(request, namespace, runId)
{
    const spec = CAPABILITY_ROLES[request.capabilityId];
    const allocationIdentity = `consumer.${request.consumerProducerId}.${request.role}`;
    return Object.freeze({
        ...plannedRole(request.capabilityId, {
            ...spec,
            role: allocationIdentity
        }, namespace, runId),
        allocationConsumerProducerId: request.consumerProducerId,
        allocationRole: request.role
    });
}

export function buildAuthSessionPlan({
    capabilities,
    namespace,
    runId,
    profileId,
    catalogDigest,
    fixtureVariantPlanDigest,
    producerVariantPlanDigest,
    temporalContext = null,
    identityRoleRequests = []
})
{
    const selected = exactSortedStrings(capabilities ?? [], 'auth-session capabilities');
    if (selected.length === 0)
    {
        throw new Error('auth-session producer requires at least one capability');
    }
    const unknown = selected.filter((id) => !Object.hasOwn(CAPABILITY_ROLES, id));
    if (unknown.length)
    {
        throw new Error(`auth-session received unknown or security-owned capabilities: ${unknown.join(', ')}`);
    }
    const normalizedNamespace = String(namespace ?? '').trim();
    const normalizedRunId = String(runId ?? '').trim();
    if (!normalizedNamespace || !normalizedRunId)
    {
        throw new Error('auth-session requires current run and namespace');
    }
    const normalizedProfileId = String(profileId ?? '').trim();
    const normalizedDigests = {
        catalogDigest: String(catalogDigest ?? '').trim(),
        fixtureVariantPlanDigest: String(fixtureVariantPlanDigest ?? '').trim(),
        producerVariantPlanDigest: String(producerVariantPlanDigest ?? '').trim()
    };
    if (!normalizedProfileId || Object.values(normalizedDigests).some((value) => !value))
    {
        throw new Error('auth-session requires sealed profile/catalog/variant plan identity');
    }
    if (!temporalContext || typeof temporalContext !== 'object')
    {
        throw new Error('auth-session requires sealed temporal context');
    }
    if (temporalContext.producerId !== PRODUCER_ID)
    {
        throw new Error('auth-session temporal context producerId mismatch');
    }
    const resolvedTemporalRoles = resolveTemporalRolesForProducer({
        temporalContext,
        namespace: normalizedNamespace,
        fixtureId: PRODUCER_ID
    });
    verifyResolvedTemporalArtifact(resolvedTemporalRoles, { temporalContext });
    const allocationRequests = normalizedIdentityRoleRequests(identityRoleRequests);
    const missingAllocationCapabilities = allocationRequests
        .filter((item) => !selected.includes(item.capabilityId));
    if (missingAllocationCapabilities.length)
    {
        throw new Error('auth-session identity allocation capability is outside the sealed profile plan');
    }
    const roles = selected.map((id) => plannedRole(
        id,
        CAPABILITY_ROLES[id],
        normalizedNamespace,
        normalizedRunId
    )).concat(allocationRequests.map((request) => plannedAllocatedRole(
        request,
        normalizedNamespace,
        normalizedRunId
    )));
    const roleIds = roles.map((item) => item.semanticRole);
    if (new Set(roleIds).size !== roleIds.length)
    {
        throw new Error('auth-session semantic roles must be unique');
    }
    const plan = {
        schema: 'fsusblog.auth-session-fixture-plan.v1',
        strategy: STRATEGY,
        producerId: PRODUCER_ID,
        namespace: normalizedNamespace,
        runId: normalizedRunId,
        profileId: normalizedProfileId,
        ...normalizedDigests,
        capabilities: Object.freeze(selected),
        roles: Object.freeze(roles),
        identityRoleRequests: allocationRequests,
        identityAllocationRequestDigest: stableDigest(allocationRequests),
        temporalContext,
        resolvedTemporalRoles,
        securityStateOwnership: 'forbidden',
        privateProjectionPolicy: 'opaque-ref-only'
    };
    return Object.freeze({ ...plan, planDigest: stableDigest(plan) });
}

function normalizedEntities(raw)
{
    return (raw ?? []).map((item) => ({
        kind: String(item.kind ?? item.Kind ?? ''),
        id: String(item.id ?? item.Id ?? ''),
        owned: item.owned ?? item.Owned ?? true,
        capabilityHint: item.capabilityHint ?? item.CapabilityHint ?? null,
        postconditionId: item.postconditionId ?? item.PostconditionId ?? null,
        semanticRole: item.semanticRole ?? item.SemanticRole ?? null,
        fixtureIdentity: item.fixtureIdentity ?? item.FixtureIdentity ?? null,
        fields: item.fields ?? item.Fields ?? {}
    }));
}

function normalizeObservations(value)
{
    const raw = value ?? {};
    const database = raw.database ?? raw.Database ?? null;
    const redis = raw.redis ?? raw.Redis ?? null;
    const cache = raw.cache ?? raw.Cache ?? null;
    return {
        source: raw.source ?? raw.Source ?? 'application-read-model',
        database: database
            ? {
                namespace: database.namespace ?? database.Namespace ?? null,
                schemaIdentity: database.schemaIdentity ?? database.SchemaIdentity ?? 'public',
                entities: normalizedEntities(database.entities ?? database.Entities)
            }
            : null,
        redis: redis
            ? {
                namespace: redis.namespace ?? redis.Namespace ?? null,
                keys: redis.keys ?? redis.Keys ?? []
            }
            : null,
        cache: cache
            ? {
                namespace: cache.namespace ?? cache.Namespace ?? null,
                entries: cache.entries ?? cache.Entries ?? []
            }
            : null
    };
}

function validateCeremony(entity)
{
    const ceremony = entity.fields?.ceremony;
    if (!ceremony || ceremony.validationBoundary !== 'production-fido')
    {
        throw new Error(`passkey role ${entity.semanticRole} lacks production FIDO ceremony evidence`);
    }
    for (const field of ['challengeSingleUse', 'challengeConsumed', 'signatureVerified', 'originVerified', 'rpIdVerified', 'counterVerified'])
    {
        if (ceremony[field] !== true)
        {
            throw new Error(`passkey role ${entity.semanticRole} ceremony ${field} is not verified`);
        }
    }
    if (ceremony.acceptAnySignature === true || ceremony.validationDisabled === true)
    {
        throw new Error(`passkey role ${entity.semanticRole} used weakened WebAuthn validation`);
    }
}

function validateRoleObservation(role, entities)
{
    const scoped = entities.filter((item) => item.semanticRole === role.semanticRole);
    const expectedCount = role.kind === 'session' ? role.sessionCount : 1;
    if (scoped.length !== expectedCount)
    {
        throw new Error(`auth-session role ${role.semanticRole} expected ${expectedCount} observed entities, got ${scoped.length}`);
    }
    for (const entity of scoped)
    {
        if (entity.owned !== true || entity.fixtureIdentity !== role.fixtureIdentity)
        {
            throw new Error(`auth-session role ${role.semanticRole} is not bound to its owned fixture identity`);
        }
        if (String(entity.fields?.state ?? '') !== role.expectedState)
        {
            throw new Error(`auth-session role ${role.semanticRole} state mismatch`);
        }
    }
    if (role.capabilityId === 'session.multi-device')
    {
        const deviceSignals = new Set(scoped.map((item) => item.fields?.deviceSignal));
        const families = new Set(scoped.map((item) => item.fields?.familyIdentity));
        if (deviceSignals.size !== 2 || families.size !== 2 || scoped.some((item) => item.fields?.live !== true))
        {
            throw new Error('session.multi-device requires two live sessions with distinct devices and families');
        }
    }
    if (role.kind === 'session')
    {
        const observedIds = scoped.map((item) => item.id).sort();
        if (JSON.stringify(observedIds) !== JSON.stringify([...role.sessionIdentities].sort()))
        {
            throw new Error(`session role ${role.semanticRole} public IDs drifted from its sealed plan`);
        }
    }
    if (role.capabilityId === 'session.refresh-rotated')
    {
        const fields = scoped[0].fields ?? {};
        if (fields.oldRefreshAccepted !== false || fields.currentGeneration !== 1 || fields.currentPointerVerified !== true)
        {
            throw new Error('session.refresh-rotated postcondition mismatch');
        }
    }
    if (role.capabilityId === 'auth.user.mfa-disabled' && scoped[0].fields?.mfaEnabled !== false)
    {
        throw new Error('auth.user.mfa-disabled postcondition mismatch');
    }
    if (role.capabilityId === 'auth.user.mfa-enabled' && scoped[0].fields?.mfaEnabled !== true)
    {
        throw new Error('auth.user.mfa-enabled postcondition mismatch');
    }
    if (role.capabilityId === 'auth.user.recovery-enabled' && scoped[0].fields?.recoveryEnabled !== true)
    {
        throw new Error('auth.user.recovery-enabled postcondition mismatch');
    }
    if (role.capabilityId === 'auth.user.passkey-enabled')
    {
        validateCeremony(scoped[0]);
    }
    if (role.kind === 'admin' && !scoped[0].fields?.permissionCatalogDigest)
    {
        throw new Error(`admin role ${role.semanticRole} lacks production permission catalog digest`);
    }
    if (role.kind === 'admin')
    {
        const fields = scoped[0].fields ?? {};
        if (fields.authorizationVerified !== true || !Array.isArray(fields.allowedActions)
            || !Array.isArray(fields.deniedActions))
        {
            throw new Error(`admin role ${role.semanticRole} lacks exact authorization evidence`);
        }
        if (role.capabilityId === 'auth.admin.read-only'
            && !fields.deniedActions.includes('article.publish'))
        {
            throw new Error('auth.admin.read-only unexpectedly allows article.publish');
        }
        if (role.capabilityId === 'auth.admin.disabled'
            && (fields.sessionIssuanceEligible !== false || fields.authorizationEligible !== false))
        {
            throw new Error('auth.admin.disabled remains token/authorization eligible');
        }
    }
}

export function validateAuthSessionResult(plan, raw)
{
    if (!raw || typeof raw !== 'object')
    {
        throw new Error('auth-session composition root returned empty result');
    }
    if ((raw.strategy ?? raw.Strategy) !== STRATEGY)
    {
        throw new Error('auth-session strategy drift or fallback');
    }
    if (raw.fallback === true || raw.localConstructed === true || raw.warningOnly === true)
    {
        throw new Error('auth-session fallback/warning evidence rejected');
    }
    const provided = exactSortedStrings(
        raw.providedCapabilities ?? raw.ProvidedCapabilities ?? [],
        'auth-session providedCapabilities'
    );
    if (JSON.stringify(provided) !== JSON.stringify(plan.capabilities))
    {
        throw new Error('auth-session provided capabilities do not exact-match plan');
    }
    const observations = normalizeObservations(raw.observations ?? raw.Observations);
    if (!observations.database)
    {
        throw new Error('auth-session requires independent database/read-model observations');
    }
    if (observations.source === 'producer-self-report' || observations.source === 'local-fallback')
    {
        throw new Error('auth-session observations must come from independent application read models');
    }
    const entities = observations.database.entities;
    plan.roles.forEach((role) => validateRoleObservation(role, entities));
    const resultCore = {
        producerId: PRODUCER_ID,
        strategy: STRATEGY,
        implementation: raw.implementation ?? raw.Implementation ?? 'test-only-auth-fixture-composition-root',
        planDigest: plan.planDigest,
        providedCapabilities: provided,
        entityIdentities: entities.map((item) => ({
            kind: item.kind,
            id: item.id,
            semanticRole: item.semanticRole,
            fixtureIdentity: item.fixtureIdentity,
            capabilityHint: item.capabilityHint
        })),
        observations,
        databaseObservation: observations.database,
        redisObservation: observations.redis,
        cacheObservation: observations.cache,
        permissionCatalogDigest: raw.permissionCatalogDigest ?? raw.PermissionCatalogDigest ?? null,
        ceremonyEvidenceDigest: raw.ceremonyEvidenceDigest ?? raw.CeremonyEvidenceDigest ?? null,
        temporalObservation: raw.temporalObservation ?? raw.TemporalObservation ?? null,
        cleanupContract: { kind: 'owned-identities', ownerIdentity: plan.roles[0].ownerIdentity }
    };
    const producerResultDigest = stableDigest(resultCore);
    const planDigests = Object.freeze({
        authSessionPlanDigest: plan.planDigest,
        catalogDigest: plan.catalogDigest,
        fixtureVariantPlanDigest: plan.fixtureVariantPlanDigest,
        producerVariantPlanDigest: plan.producerVariantPlanDigest
    });
    const roleBySemanticRole = new Map(plan.roles.map((item) => [item.semanticRole, item]));
    const identityPrepareReferences = entities
        .filter((item) => item.kind === 'user' || item.kind === 'admin')
        .map((item) =>
        {
            const role = roleBySemanticRole.get(item.semanticRole);
            if (!role)
            {
                throw new Error(`auth-session identity entity ${item.semanticRole} is outside its sealed role plan`);
            }
            const value = {
                schema: 'fsusblog.fixture-identity-prepare-reference.v1',
                verified: false,
                ownerProducerId: PRODUCER_ID,
                consumerProducerId: role.allocationConsumerProducerId ?? null,
                runId: plan.runId,
                namespace: plan.namespace,
                profileId: plan.profileId,
                role: role.allocationRole ?? item.semanticRole,
                semanticRole: item.semanticRole,
                capabilityId: role.capabilityId,
                publicId: item.id,
                fixtureIdentity: item.fixtureIdentity,
                producerResultDigest,
                planDigests
            };
            return Object.freeze({ ...value, digest: stableDigest(value) });
        });
    const result = {
        ...resultCore,
        producerResultDigest,
        identityPrepareReferences: Object.freeze(identityPrepareReferences)
    };
    assertNoSecret(result);
    assertNoSecurityOwnership(result);
    return Object.freeze(result);
}

async function invokeLocalCompositionRoot(context, plan, signal)
{
    const { baseUrl, secret } = resolveLocalCompositionRoot(context);
    if (!baseUrl || !secret)
    {
        throw new Error('auth-session requires explicit backend URL and local fixture secret ingress');
    }
    const response = await fetch(`${baseUrl}/api/local/auth-fixture/prepare`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-Fsus-Local-Auth-Fixture-Secret': secret
        },
        body: JSON.stringify({ ...plan, privateProjectionIdentity: authPrivateIdentity(context, plan.planDigest) }),
        signal
    });
    const text = await response.text();
    // eslint-disable-next-line no-useless-assignment
    let payload = null;
    try
    {
        payload = text ? JSON.parse(text) : null;
    }
    catch
    {
        throw new Error('auth-session composition root returned invalid JSON');
    }
    if (!response.ok)
    {
        for (const carrier of payload?.privateCarriers ?? [])
        {
            persistAuthPrivateCarrier(context, carrier);
        }
        throw new Error(`auth-session composition root failed HTTP ${response.status}; private recovery retained when supplied`);
    }
    return payload;
}

function resolveLocalCompositionRoot(context)
{
    const baseUrl = String(
        context.handles?.baseUrl
        ?? context.handles?.debugBackendUrl
        ?? process.env.FSUSBLOG_BASE_URL
        ?? process.env.FSUSBLOG_DEBUG_BACKEND_URL
        ?? ''
    ).replace(/\/+$/u, '');
    const secret = String(
        context.handles?.localAuthFixtureSecret
        ?? process.env.FSUSBLOG_LOCAL_AUTH_FIXTURE_SECRET
        ?? ''
    );
    return { baseUrl, secret };
}

export async function prepareAuthSession(context, signal)
{
    const capabilities = (context.plan?.capabilities ?? [])
        .filter((id) => Object.hasOwn(CAPABILITY_ROLES, String(id)))
        .map(String)
        .sort();
    const plan = buildAuthSessionPlan({
        capabilities,
        namespace: context.namespace,
        runId: context.runIdentity,
        profileId: context.profileIdentity?.profileId,
        catalogDigest: context.plan?.catalogDigest,
        fixtureVariantPlanDigest: context.plan?.variantPlanDigest,
        producerVariantPlanDigest: context.variantPlan?.producerVariantPlanDigest,
        temporalContext: context.temporalContext,
        identityRoleRequests: context.identityRoleRequests
    });
    const adapter = context.handles?.authFixtureAdapter;
    const injectedPrepare = typeof adapter?.prepare === 'function';
    if (!injectedPrepare && plan.roles.some((role) => role.kind === 'admin' && role.expectedState === 'active')
        && !context.handles?.authPrivateCarrierDir)
    {
        throw new Error('auth-session private carrier owned output directory required before issuance');
    }
    const raw = injectedPrepare
        ? await adapter.prepare({ ...context, authFixturePlan: plan }, signal)
        : await invokeLocalCompositionRoot(context, plan, signal);
    const carriers = raw.privateCarriers ?? raw.PrivateCarriers ?? [];
    const publicRaw = { ...raw };
    delete publicRaw.privateCarriers;
    delete publicRaw.PrivateCarriers;
    const result = validateAuthSessionResult(plan, publicRaw);
    const privateCarrierReferences = [];
    try
    {
        if (!injectedPrepare)
        {
            requireAuthPrivateCarriers(plan, result, carriers);
        }
        for (const carrier of carriers)
        {
            const identity = authPrivateIdentity(context, plan.planDigest);
            if (!context.handles?.authPrivateCarrierDir || digestCanonical(carrier.identity) !== digestCanonical(identity)
                || typeof carrier.opaque !== 'string' || !carrier.publicFact)
            {
                throw new Error('auth-session private carrier binding invalid');
            }
            privateCarrierReferences.push(persistAuthPrivateCarrier(context, carrier));
        }
    }
    catch (error)
    {
        for (const carrier of carriers)
        {
            try
            {
                await invokeAuthPrivate(context, carrier, { cleanup: true });
            }
            catch
            {
                throw new Error('auth private carrier publication failed; exact cleanup recovery required', { cause: error });
            }
        }
        throw error;
    }
    const variantByCapability = new Map((context.variantPlan?.variants ?? [])
        .map((item) => [item.capabilityId, item.id]));
    if (plan.capabilities.some((capabilityId) => !variantByCapability.has(capabilityId)))
    {
        throw new Error('auth-session typed variant plan does not cover every sealed capability');
    }
    const verificationEntities = result.entityIdentities;
    const entityIdentities = verificationEntities.map((item) => Object.freeze({
        kind: item.kind,
        id: item.id,
        variantId: variantByCapability.get(item.capabilityHint),
        owner: plan.roles[0].ownerIdentity
    }));
    const database = {
        ...result.observations.database,
        entities: result.observations.database.entities.map((item) => Object.freeze({
            ...item,
            variantId: variantByCapability.get(item.capabilityHint)
        }))
    };
    const observations = {
        ...result.observations,
        database
    };
    return Object.freeze({
        ...result,
        entityIdentities: Object.freeze(entityIdentities),
        authVerificationEntities: verificationEntities,
        privateCarrierReferences: Object.freeze(privateCarrierReferences),
        observations,
        databaseObservation: database
    });
}

export function authPrivateIdentity(context, planDigest)
{
    return Object.freeze({
        runId: context.runIdentity, namespace: context.namespace,
        profileId: context.profileIdentity?.profileId,
        sourceCommit: context.sourceIdentity?.commit,
        sourceFingerprint: context.sourceIdentity?.worktreeFingerprint,
        serviceGeneration: context.handles?.serviceGeneration,
        catalogDigest: context.plan?.catalogDigest,
        variantPlanDigest: context.plan?.variantPlanDigest,
        planDigest
    });
}

export function readAuthPrivateCarrier(reference)
{
    const result = readPrivateJson(reference.path, { label: 'auth-private-carrier' });
    if (result.contentDigest !== reference.contentDigest)
    {
        throw new Error('auth private carrier file digest mismatch');
    }
    return result.document;
}

export function requireAuthPrivateCarriers(plan, result, carriers)
{
    const roles = plan.roles.filter((role) => role.kind === 'admin' && role.expectedState === 'active');
    if (!Array.isArray(carriers) || carriers.length !== roles.length
        || new Set(carriers.map((carrier) => carrier.publicFact?.semanticRole)).size !== roles.length
        || roles.some((role) =>
        {
            const carrier = carriers.find((item) => item.publicFact?.semanticRole === role.semanticRole);
            const fact = result.observations.database.entities.find((item) => item.kind === 'admin'
                && item.semanticRole === role.semanticRole && item.fixtureIdentity === role.fixtureIdentity);
            return !carrier || !fact || carrier.identity?.planDigest !== plan.planDigest
                || carrier.publicFact.id !== fact.id || !fact.fields.adminSessionId
                || digestCanonical(carrier.publicFact.fields) !== digestCanonical(fact.fields);
        }))
    {
        throw new Error('auth private active-admin carriers do not exactly cover production session facts');
    }
}

export function persistAuthPrivateCarrier(context, carrier)
{
    if (!context.handles?.authPrivateCarrierDir || !carrier.identity?.planDigest
        || digestCanonical(carrier.identity) !== digestCanonical(authPrivateIdentity(context, carrier.identity.planDigest))
        || typeof carrier.opaque !== 'string' || !carrier.publicFact)
    {
        throw new Error('auth private carrier owned binding invalid');
    }
    const file = path.join(context.handles.authPrivateCarrierDir,
        `${createHash('sha256').update(carrier.opaque).digest('hex')}.json`);
    const written = writePrivateJson(file, carrier, { label: 'auth-private-carrier' });
    const reference = Object.freeze({ path: written.path, contentDigest: written.contentDigest,
        principalId: String(carrier.publicFact.id), semanticRole: carrier.publicFact.semanticRole });
    const referenceFile = `${file}.reference.json`;
    writePrivateJson(referenceFile, reference, { label: 'auth-private-carrier-reference' });
    return Object.freeze({ ...reference, referenceFile });
}

export async function invokeAuthPrivate(context, carrier, { reveal = false, receiptDigest = null, cleanup = false, callerAbortSignal } = {})
{
    callerAbortSignal?.throwIfAborted();
    const { baseUrl, secret } = resolveLocalCompositionRoot(context);
    if (!baseUrl || !secret)
    {
        throw new Error('auth private explicit backend ingress required');
    }
    const response = await fetch(`${baseUrl}/api/local/auth-fixture/private/${cleanup ? 'cleanup' : 'verify'}`, {
        method: 'POST', headers: {
            'Content-Type': 'application/json', 'X-Fsus-Local-Auth-Fixture-Secret': secret,
            'X-Fsus-Test-Run-Id': context.runIdentity, 'X-Fsus-Test-Namespace': context.namespace
        },
        body: JSON.stringify({ ...carrier, reveal, fixtureReceiptDigest: receiptDigest }),
        signal: callerAbortSignal
            ? AbortSignal.any([callerAbortSignal, AbortSignal.timeout(60_000)])
            : AbortSignal.timeout(60_000)
    });
    callerAbortSignal?.throwIfAborted();
    if (!response.ok)
    {
        throw new Error(`auth private port rejected HTTP ${response.status}`);
    }
    const value = await response.json();
    callerAbortSignal?.throwIfAborted();
    if (value?.ok !== true || (!cleanup && (!value.identity || !value.publicFact
        || digestCanonical(value.identity) !== digestCanonical(carrier.identity)
        || value.carrierDigest !== createHash('sha256').update(carrier.opaque).digest('hex')
        || digestCanonical(value.publicFact) !== digestCanonical(carrier.publicFact))))
    {
        throw new Error('auth private independent verification binding mismatch');
    }
    return value;
}

export function projectVerifiedIdentityReferences({
    producerResult,
    producerReceipt,
    consumerProducerId
} = {})
{
    const consumer = String(consumerProducerId ?? '').trim();
    if (!STABLE_ID.test(consumer))
    {
        throw new Error('verified identity projection requires a stable consumerProducerId');
    }
    try
    {
        validateProducerReceipt(producerReceipt);
    }
    catch
    {
        throw new Error(
            'verified identity projection requires the exact sealed auth-session ProducerReceipt'
        );
    }
    const prepareReferences = producerResult?.identityPrepareReferences;
    if (!producerResult || producerResult.producerId !== PRODUCER_ID
        || producerReceipt.producerId !== PRODUCER_ID
        || !Array.isArray(prepareReferences) || prepareReferences.length === 0
        || !prepareReferences.every((item) =>
            item.runId === producerReceipt.runId
            && item.namespace === producerReceipt.namespace
            && item.profileId === producerReceipt.profileId))
    {
        throw new Error('verified identity projection requires the exact sealed auth-session ProducerReceipt');
    }
    const receiptEntities = new Map((producerReceipt.observations?.database?.entities ?? [])
        .map((item) => [`${item.semanticRole}\0${item.id}`, item]));
    const references = prepareReferences
        .filter((item) => item.consumerProducerId === consumer)
        .map((item) =>
        {
            const { digest, ...prepareBody } = item;
            if (item.schema !== 'fsusblog.fixture-identity-prepare-reference.v1'
                || item.verified !== false
                || item.ownerProducerId !== PRODUCER_ID
                || item.producerResultDigest !== producerResult.producerResultDigest
                || digest !== stableDigest(prepareBody)
                || !receiptEntities.has(`${item.semanticRole}\0${item.publicId}`))
            {
                throw new Error(`identity prepare reference ${item.role ?? '<missing>'} is not bound to the sealed receipt`);
            }
            const verified = {
                schema: 'fsusblog.fixture-identity-reference.v1',
                verified: true,
                ownerProducerId: PRODUCER_ID,
                consumerProducerId: consumer,
                runId: item.runId,
                namespace: item.namespace,
                profileId: item.profileId,
                role: item.role,
                semanticRole: item.semanticRole,
                capabilityId: item.capabilityId,
                publicId: item.publicId,
                fixtureIdentity: item.fixtureIdentity,
                producerResultDigest: item.producerResultDigest,
                sourceReceiptDigest: producerReceipt.producerReceiptDigest,
                prepareReferenceDigest: item.digest,
                planDigests: item.planDigests
            };
            return Object.freeze({ ...verified, digest: stableDigest(verified) });
        });
    if (references.length === 0)
    {
        throw new Error(`auth-session has no requested identity allocation for ${consumer}`);
    }
    const body = {
        schema: 'fsusblog.fixture-identity-references.v1',
        verified: true,
        ownerProducerId: PRODUCER_ID,
        consumerProducerId: consumer,
        runId: producerReceipt.runId,
        namespace: producerReceipt.namespace,
        profileId: producerReceipt.profileId,
        sourceReceiptDigest: producerReceipt.producerReceiptDigest,
        references: Object.freeze(references)
    };
    return Object.freeze({ ...body, digest: stableDigest(body) });
}

export async function verifyAuthSession(context, producerResult, signal = undefined)
{
    signal?.throwIfAborted();
    try
    {
        assertNoSecret(producerResult);
        assertNoSecurityOwnership(producerResult);
    }
    catch (error)
    {
        return { ok: false, producerId: PRODUCER_ID, reason: error.message };
    }
    const adapter = context.handles?.authFixtureAdapter;
    let verification;
    if (adapter && typeof adapter.verify === 'function')
    {
        verification = await adapter.verify(context, producerResult, signal);
    }
    else
    {
        const { baseUrl, secret } = resolveLocalCompositionRoot(context);
        if (!baseUrl || !secret)
        {
            return {
                ok: false,
                producerId: PRODUCER_ID,
                reason: 'auth-session independent live verifier is required'
            };
        }
        const response = await fetch(`${baseUrl}/api/local/auth-fixture/verify`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                'X-Fsus-Local-Auth-Fixture-Secret': secret
            },
            body: JSON.stringify({
                receiptDigest: stableDigest(producerResult),
                entityIdentities: producerResult.authVerificationEntities,
                providedCapabilities: producerResult.providedCapabilities,
                planDigest: producerResult.planDigest
            }),
            signal
        });
        signal?.throwIfAborted();
        verification = response.ok ? await response.json() : {
            ok: false,
            reason: `auth-session live verifier failed HTTP ${response.status}`
        };
    }
    signal?.throwIfAborted();
    if (verification?.ok !== true || verification.receiptDigest !== stableDigest(producerResult))
    {
        return {
            ok: false,
            producerId: PRODUCER_ID,
            reason: verification?.reason ?? 'auth-session independent verification mismatch'
        };
    }
    for (const reference of producerResult.privateCarrierReferences ?? [])
    {
        const carrier = readAuthPrivateCarrier(reference);
        if (digestCanonical(carrier.identity) !== digestCanonical(authPrivateIdentity(context, producerResult.planDigest)))
        {
            return { ok: false, producerId: PRODUCER_ID, reason: 'auth private execution identity drift' };
        }
        const fact = producerResult.observations.database.entities.find((item) =>
            item.kind === 'admin' && item.id === reference.principalId && item.semanticRole === reference.semanticRole);
        if (!fact || digestCanonical(fact.fields) !== digestCanonical(carrier.publicFact.fields))
        {
            return { ok: false, producerId: PRODUCER_ID, reason: 'auth private public fact drift' };
        }
        await invokeAuthPrivate(context, { ...carrier, publicFact: { ...carrier.publicFact, fields: fact.fields } },
            { callerAbortSignal: signal });
        signal?.throwIfAborted();
    }
    return {
        ok: true,
        producerId: PRODUCER_ID,
        observations: producerResult.observations,
        entityIdentities: producerResult.entityIdentities
    };
}

export async function cleanupAuthSession(context, receipt, signal)
{
    for (const reference of receipt.privateCarrierReferences ?? [])
    {
        const carrier = readAuthPrivateCarrier(reference);
        if (digestCanonical(carrier.identity) !== digestCanonical(authPrivateIdentity(context, receipt.planDigest)))
        {
            throw new Error('auth private cleanup execution identity drift');
        }
        await invokeAuthPrivate(context, carrier, { cleanup: true });
    }
    const adapter = context.handles?.authFixtureAdapter;
    if (adapter && typeof adapter.cleanup === 'function')
    {
        await adapter.cleanup(context, receipt, signal);
    }
}

export const authSessionProducerMeta = Object.freeze({
    id: PRODUCER_ID,
    strategy: STRATEGY,
    capabilities: Object.freeze(Object.keys(CAPABILITY_ROLES).sort())
});
