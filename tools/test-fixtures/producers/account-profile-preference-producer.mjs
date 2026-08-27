// fixture-catalog: producer account-profile-preferences
/**
 * Canonical account public-profile and locale-preference fixture producer
 * (#1717, #2168, #2169).
 *
 * The producer consumes auth-session identity references, invokes the
 * development-only backend composition root, and returns live observations.
 * It never creates users/sessions or writes SQL, Cookie, or localStorage.
 */

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
    const consumed = context.producerOutputs?.['auth-session']?.identityReferences;
    const references = explicit ?? consumed;
    if (!Array.isArray(references) || references.length === 0)
    {
        throw new Error(
            'account profile/preference producer requires verified auth-session identityReferences; first-existing-user discovery is forbidden'
        );
    }

    const namespace = safeIdentity(context.namespace, 'fixture namespace');
    const runId = safeIdentity(context.runIdentity, 'fixture run id');
    const owner = safeIdentity(
        context.handles?.accountProfilePreferenceOwner
            ?? `fxacct:${namespace}:${runId}`,
        'fixture owner'
    );
    const roles = new Set();
    const normalized = references.map((reference) =>
    {
        const semanticRole = safeIdentity(reference.semanticRole, 'identity semantic role');
        if (roles.has(semanticRole))
        {
            throw new Error(`duplicate auth identity semantic role ${semanticRole}`);
        }
        roles.add(semanticRole);
        const userId = Number(reference.userId);
        const identityDigest = String(reference.identityDigest ?? '');
        const sessionDigest = String(reference.sessionDigest ?? '');
        if (!Number.isSafeInteger(userId) || userId <= 0
            || !/^[a-f0-9]{64}$/iu.test(identityDigest)
            || !/^[a-f0-9]{64}$/iu.test(sessionDigest))
        {
            throw new Error(`auth identity reference ${semanticRole} is not verified`);
        }
        if (reference.namespace != null && reference.namespace !== namespace
            || reference.runId != null && reference.runId !== runId
            || reference.owner != null && reference.owner !== owner)
        {
            throw new Error(`auth identity reference ${semanticRole} is cross-run or cross-owner`);
        }
        const deviceRoles = reference.deviceRoles == null
            ? null
            : [...new Set(reference.deviceRoles.map((role) => safeIdentity(role, 'device semantic role')))].sort();
        return Object.freeze({
            semanticRole,
            userId,
            identityDigest: identityDigest.toLowerCase(),
            sessionDigest: sessionDigest.toLowerCase(),
            namespace,
            runId,
            owner,
            deviceRoles
        });
    });
    return Object.freeze({ owner, references: Object.freeze(normalized) });
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
    const response = await fetch(`${baseUrl}/__local/account-profile-preferences/${action}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-Fsus-Account-Profile-Preference-Fixture-Secret': secret,
            'X-Fsus-Test-Namespace': String(context.namespace ?? ''),
            'X-Fsus-Test-Run-Id': String(context.runIdentity ?? '')
        },
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
            entityIdentities: producerResult.entityIdentities
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
