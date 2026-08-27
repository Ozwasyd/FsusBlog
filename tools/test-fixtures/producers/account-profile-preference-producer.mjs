// fixture-catalog: producer account-profile-preferences
/**
 * Canonical account public-profile and locale-preference fixture producer
 * (#1717, #2168, #2169).
 *
 * The producer consumes auth-session identity references, invokes the
 * development-only backend composition root, and returns live observations.
 * It never creates users/sessions or writes SQL, Cookie, or localStorage.
 */

import { createHash } from 'node:crypto';

import { projectVerifiedIdentityReferences } from './auth-session-producer.mjs';
import {
    createTemporalDomainProducerReceipt,
    projectTemporalRolesForBrowser,
    projectTemporalRolesForPostgres,
    resolveTemporalRolesForProducer,
    verifyResolvedTemporalArtifact
} from '../../test/temporal-role-resolver.mjs';

const producerId = 'account-profile-preferences';
const strategy = 'transaction-fixture';
const capabilityPrefixes = Object.freeze(['profile.', 'preferences.']);
const identityRoles = Object.freeze([
    'preference-account-device-conflict',
    'preference-auto',
    'preference-device-explicit',
    'preference-fixed-default',
    'preference-fixed-non-default',
    'preference-revision-conflict',
    'preference-two-device',
    'profile-conflict-challenger',
    'profile-conflict-owner',
    'profile-empty',
    'profile-set'
]);

export const accountProfilePreferenceIdentityRoleRequests = Object.freeze(identityRoles.map((role) => Object.freeze({
    ownerProducerId: 'auth-session',
    consumerProducerId: producerId,
    role,
    capabilityId: 'auth.user.active'
})));

function stableDigest(value)
{
    return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function assertNoLegacyOverride()
{
    const forbidden = [
        'FSUSBLOG_ACCOUNT_PROFILE_FIXTURE_STRATEGY',
        'FSUSBLOG_FIXTURE_PRODUCER_STRATEGY',
        'FSUSBLOG_FORCE_DIRECT_DB_SEED',
        'FSUSBLOG_PROFILE_FIXTURE_USER_ID',
        'FSUSBLOG_PROFILE_FIXTURE_HANDLE'
    ];
    for (const key of forbidden)
    {
        if (process.env[key])
        {
            throw new Error(`account profile/preference producer override ${key} is forbidden`);
        }
    }
}

function selectedCapabilities(context)
{
    const capabilities = (context?.variantPlan?.variants ?? [])
        .map((variant) => String(variant.capabilityId ?? ''))
        .filter((id) => capabilityPrefixes.some((prefix) => id.startsWith(prefix)));
    const sorted = [...new Set(capabilities)].sort();
    if (sorted.length === 0)
    {
        throw new Error('account profile/preference producer received zero owned capabilities');
    }
    return Object.freeze(sorted);
}

function safeIdentity(value, label)
{
    const normalized = String(value ?? '').trim();
    if (!/^[a-zA-Z0-9_.:-]{1,96}$/u.test(normalized))
    {
        throw new Error(`${label} must be a bounded stable identity`);
    }
    return normalized;
}

function identityReferences(context)
{
    const explicit = context.handles?.accountProfilePreferenceIdentityRefs;
    const authResult = context.producerOutputs?.['auth-session'];
    const references = explicit ?? authResult?.identityPrepareReferences;
    if (!Array.isArray(references) || references.length === 0)
    {
        throw new Error(
            'account profile/preference producer requires auth-session identityPrepareReferences; first-existing-user discovery is forbidden'
        );
    }

    const namespace = safeIdentity(context.namespace, 'fixture namespace');
    const runId = safeIdentity(context.runIdentity, 'fixture run id');
    const profileId = safeIdentity(context.profileIdentity?.profileId, 'fixture profile id');
    const owner = safeIdentity(
        context.handles?.accountProfilePreferenceOwner
            ?? `fxacct:${namespace}:${runId}`,
        'fixture owner'
    );
    const roles = new Set();
    const publicIds = new Set();
    const producerResultDigest = String(authResult?.producerResultDigest
        ?? references[0]?.producerResultDigest
        ?? '');
    const normalized = references
        .filter((reference) => reference?.consumerProducerId === producerId)
        .map((reference) =>
    {
        const role = safeIdentity(reference.role, 'identity consumer semantic role');
        if (roles.has(role))
        {
            throw new Error(`duplicate auth identity consumer role ${role}`);
        }
        roles.add(role);
        const publicId = String(reference.publicId ?? '');
        const { digest, ...body } = reference;
        if (reference.schema !== 'fsusblog.fixture-identity-prepare-reference.v1'
            || reference.verified !== false
            || reference.ownerProducerId !== 'auth-session'
            || reference.consumerProducerId !== producerId
            || reference.namespace !== namespace
            || reference.runId !== runId
            || reference.profileId !== profileId
            || reference.capabilityId !== 'auth.user.active'
            || reference.producerResultDigest !== producerResultDigest
            || !/^\d+$/u.test(publicId)
            || Number(publicId) <= 0
            || publicIds.has(publicId)
            || !/^fxauth-[a-f0-9]{24}$/u.test(String(reference.fixtureIdentity ?? ''))
            || !/^[a-f0-9]{64}$/u.test(String(digest ?? ''))
            || stableDigest(body) !== digest)
        {
            throw new Error(`auth identity prepare reference ${role} is stale, cross-run, or unverified`);
        }
        publicIds.add(publicId);
        return Object.freeze({ ...reference });
    });
    if (JSON.stringify([...roles].sort()) !== JSON.stringify([...identityRoles]))
    {
        throw new Error('auth-session identity allocation does not exact-match profile consumer roles');
    }
    return Object.freeze({ owner, references: Object.freeze(normalized) });
}

function verifyIdentityReferences(context, producerResult)
{
    const authResult = context.producerOutputs?.['auth-session'];
    const authReceipt = context.producerReceipts?.['auth-session'];
    const verified = projectVerifiedIdentityReferences({
        producerResult: authResult,
        producerReceipt: authReceipt,
        consumerProducerId: producerId
    });
    const prepared = producerResult.compositionReceipt?.identityReferences ?? [];
    if (verified.ownerProducerId !== 'auth-session'
        || verified.consumerProducerId !== producerId
        || verified.references.length !== prepared.length)
    {
        throw new Error('verified auth-session identity projection does not cover profile prepare refs');
    }
    const verifiedByRole = new Map(verified.references.map((reference) => [reference.role, reference]));
    for (const reference of prepared)
    {
        const sealed = verifiedByRole.get(reference.role);
        if (!sealed
            || sealed.prepareReferenceDigest !== reference.digest
            || sealed.publicId !== reference.publicId
            || sealed.fixtureIdentity !== reference.fixtureIdentity
            || sealed.ownerProducerId !== reference.ownerProducerId)
        {
            throw new Error(`profile identity role ${reference.role} is not sealed by the auth ProducerReceipt`);
        }
    }
    return verified;
}

function endpointContext(context)
{
    const baseUrl = String(
        context.handles?.debugBackendUrl
            ?? context.handles?.baseUrl
            ?? process.env.FSUSBLOG_DEBUG_BACKEND_URL
            ?? process.env.FSUSBLOG_BASE_URL
            ?? ''
    ).replace(/\/+$/u, '');
    const secret = String(
        context.handles?.accountProfilePreferenceFixtureSecret
            ?? process.env.FSUSBLOG_ACCOUNT_PROFILE_PREFERENCE_FIXTURE_SECRET
            ?? ''
    );
    if (!baseUrl || !secret)
    {
        throw new Error(
            'account profile/preference composition root requires an explicit backend URL and fixture secret'
        );
    }
    return Object.freeze({ baseUrl, secret });
}

async function invoke(context, action, body, signal)
{
    const adapter = context.handles?.accountProfilePreferenceAdapter;
    if (adapter && typeof adapter[action] === 'function')
    {
        return adapter[action](body, context, signal);
    }
    const { baseUrl, secret } = endpointContext(context);
    const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Fsus-Account-Profile-Preference-Fixture-Secret': secret
    };
    if (action === 'prepare')
    {
        headers['X-Fsus-Test-Namespace'] = String(context.namespace ?? '');
        headers['X-Fsus-Test-Run-Id'] = String(context.runIdentity ?? '');
    }
    const response = await fetch(`${baseUrl}/__local/account-profile-preferences/${action}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
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
        throw new Error(
            `account profile/preference ${action} failed HTTP ${response.status}: ${payload?.detail ?? text.slice(0, 400)}`
        );
    }
    return payload;
}

function variantForCapability(context, capabilityId)
{
    const matches = (context.variantPlan?.variants ?? [])
        .filter((variant) => variant.capabilityId === capabilityId);
    if (matches.length !== 1)
    {
        throw new Error(`capability ${capabilityId} must resolve to exactly one typed fixture variant`);
    }
    if (matches[0].validityClass !== 'canonical-positive')
    {
        throw new Error(`account profile/preference production commands cannot claim ${matches[0].validityClass}`);
    }
    return matches[0];
}

function normalizeResult(raw, context, capabilities, resolvedTemporalRoles)
{
    if (!raw || typeof raw !== 'object'
        || raw.strategy !== strategy
        || raw.producerId !== producerId
        || raw.localeCatalogDigest == null
        || !/^[a-f0-9]{64}$/u.test(String(raw.contentDigest ?? '')))
    {
        throw new Error('account profile/preference composition result identity is invalid');
    }
    const provided = [...(raw.providedCapabilities ?? [])].sort();
    if (JSON.stringify(provided) !== JSON.stringify([...capabilities]))
    {
        throw new Error('account profile/preference composition result capability set drifted');
    }
    const database = raw.observations?.database;
    const cache = raw.observations?.cache;
    if (!database || !cache || !Array.isArray(database.entities) || !Array.isArray(cache.entries))
    {
        throw new Error('account profile/preference result requires database and cache/reader observations');
    }

    const entities = database.entities.map((entity) =>
    {
        const variant = variantForCapability(context, entity.capabilityHint);
        return Object.freeze({
            kind: String(entity.kind),
            id: String(entity.id),
            owned: entity.owned === true,
            capabilityHint: entity.capabilityHint,
            postconditionId: entity.postconditionId,
            variantId: variant.id,
            fields: Object.freeze({ ...(entity.fields ?? {}) })
        });
    });
    for (const capability of capabilities)
    {
        if (!entities.some((entity) => entity.capabilityHint === capability && entity.owned))
        {
            throw new Error(`account profile/preference capability ${capability} has no owned live observation`);
        }
    }

    verifyResolvedTemporalArtifact(resolvedTemporalRoles, {
        temporalContext: context.temporalContext
    });
    return Object.freeze({
        producerId,
        strategy,
        implementation: 'src/backend/Services/Fixtures/AccountProfilePreferenceFixtureService.cs',
        enforceVariantEvidence: true,
        variantIds: Object.freeze((context.variantPlan?.variants ?? []).map((variant) => variant.id).sort()),
        producerVariantPlanDigest: context.variantPlan?.producerVariantPlanDigest,
        providedCapabilities: capabilities,
        entityIdentities: Object.freeze((raw.entityIdentities ?? []).map((identity) => ({
            kind: String(identity.kind),
            id: String(identity.id),
            handle: identity.handle ?? null,
            variantId: variantForCapability(context, identity.capabilityHint).id
        }))),
        observations: Object.freeze({
            source: raw.observations.source,
            database: Object.freeze({
                namespace: database.namespace,
                schemaIdentity: database.schemaIdentity,
                entities: Object.freeze(entities)
            }),
            cache: Object.freeze({
                namespace: cache.namespace,
                entries: Object.freeze(cache.entries.map((entry) => Object.freeze({ ...entry })))
            })
        }),
        databaseObservation: Object.freeze({
            namespace: database.namespace,
            schemaIdentity: database.schemaIdentity,
            entities: Object.freeze(entities)
        }),
        cacheObservation: Object.freeze({
            namespace: cache.namespace,
            entries: Object.freeze(cache.entries.map((entry) => Object.freeze({ ...entry })))
        }),
        deviceProjections: Object.freeze((raw.deviceProjections ?? []).map((projection) => Object.freeze({ ...projection }))),
        variantEvidence: Object.freeze({
            variants: Object.freeze((context.variantPlan?.variants ?? []).map((variant) => Object.freeze({
                variantId: variant.id,
                source: 'live-service',
                entityIds: Object.freeze(entities
                    .filter((entity) => entity.variantId === variant.id)
                    .map((entity) => entity.id)),
                expectedBoundary: variant.expectedBoundary
            })))
        }),
        cleanupContract: Object.freeze({ kind: 'owned-fields', owner: raw.owner }),
        compositionReceipt: raw,
        resolvedTemporalRoles,
        temporalRoleReceipt: createTemporalDomainProducerReceipt(resolvedTemporalRoles),
        postgresTemporalRoles: projectTemporalRolesForPostgres(resolvedTemporalRoles),
        browserTemporalRoles: projectTemporalRolesForBrowser(resolvedTemporalRoles),
        ...(raw.temporalObservation ? { temporalObservation: raw.temporalObservation } : {})
    });
}

export async function prepareAccountProfilePreferences(context, signal)
{
    assertNoLegacyOverride();
    const capabilities = selectedCapabilities(context);
    const identities = identityReferences(context);
    const resolvedTemporalRoles = resolveTemporalRolesForProducer({
        temporalContext: context.temporalContext,
        namespace: safeIdentity(context.namespace, 'fixture namespace'),
        fixtureId: producerId,
        planDigest: context.variantPlan?.producerVariantPlanDigest
    });
    verifyResolvedTemporalArtifact(resolvedTemporalRoles, {
        temporalContext: context.temporalContext
    });
    const request = {
        capabilities,
        namespace: safeIdentity(context.namespace, 'fixture namespace'),
        runId: safeIdentity(context.runIdentity, 'fixture run id'),
        profileId: safeIdentity(context.profileIdentity?.profileId, 'fixture profile id'),
        owner: identities.owner,
        identityReferences: identities.references,
        temporalContext: context.temporalContext,
        resolvedTemporalRoles
    };
    const raw = await invoke(context, 'prepare', request, signal);
    return normalizeResult(raw, context, capabilities, resolvedTemporalRoles);
}

export async function verifyAccountProfilePreferences(context, producerResult, signal)
{
    assertNoLegacyOverride();
    if (!producerResult?.compositionReceipt)
    {
        return { ok: false, producerId, reason: 'missing composition receipt' };
    }
    try
    {
        const verifiedIdentityReferences = verifyIdentityReferences(context, producerResult);
        const verification = await invoke(
            context,
            'verify',
            producerResult.compositionReceipt,
            signal
        );
        if (verification?.ok !== true
            || verification.contentDigest !== producerResult.compositionReceipt.contentDigest)
        {
            return { ok: false, producerId, reason: verification?.failure ?? 'live verification failed' };
        }
        return {
            ok: true,
            producerId,
            observations: producerResult.observations,
            databaseObservation: producerResult.databaseObservation,
            cacheObservation: producerResult.cacheObservation,
            entityIdentities: producerResult.entityIdentities,
            verifiedIdentityReferences
        };
    }
    catch (error)
    {
        return {
            ok: false,
            producerId,
            reason: error instanceof Error ? error.message : String(error)
        };
    }
}

export async function cleanupAccountProfilePreferences(context, producerResult, signal)
{
    assertNoLegacyOverride();
    if (!producerResult?.compositionReceipt)
    {
        throw new Error('account profile/preference cleanup requires the exact composition receipt');
    }
    await invoke(context, 'cleanup', producerResult.compositionReceipt, signal);
}

export const accountProfilePreferenceProducerMeta = Object.freeze({
    id: producerId,
    strategy
});
