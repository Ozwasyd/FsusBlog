import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { canonicalJson, digestCanonical, freezeDeep } from './receipt/canonical.mjs';
import { runPostcondition } from './receipt/postconditions.mjs';
import { assertNoSecrets } from './receipt/secrets.mjs';

const { readFixtureCatalogs } = await import(new URL('../testing/fixture-catalog.mjs', import.meta.url));

const producerId = 'account-profile-preferences';
const projectionKeys = [
    'capabilityId', 'userRef', 'deviceRole', 'accountMode', 'accountLocale',
    'incomingDeviceLocale', 'explicitCookieLocale', 'acceptLanguage',
    'resolvedLocale', 'resolutionSource', 'revision', 'catalogDigest'
].sort();

function requireCondition(condition, code)
{
    if (!condition)
    {
        // Error text contains only a controlled code, never server/private material.
        throw new Error(`account-device composition: ${code}`);
    }
}

function same(left, right)
{
    return canonicalJson(left) === canonicalJson(right);
}

function sourceObservations(observations)
{
    return { ...observations, database: { ...observations?.database,
        entities: observations?.database?.entities?.map((entity) =>
        {
            const source = { ...entity };
            delete source.variantId;
            return source;
        }) } };
}

function assertNoAccountPrivateMaterial(value)
{
    assertNoSecrets(value);
    function visit(current)
    {
        if (!current || typeof current !== 'object')
        {
            return;
        }
        for (const [key, child] of Object.entries(current))
        {
            const normalized = key.replace(/[^a-z]/giu, '').toLowerCase();
            requireCondition(!/(?:accesstoken|refreshtoken|sessiontoken|privatekey|password|recovery|proofsecret|credentialsecret|devicefingerprint|deviceprivatedata|rawstoragestate)/u.test(normalized)
                && !/^(?:cookies?|storagestate|authorization)$/u.test(normalized), 'ordinary-private-material');
            visit(child);
        }
    }
    visit(value);
}

function selectedCapabilities(context, catalogs)
{
    const variants = context.variantPlan?.variants ?? [];
    const selected = variants.filter((variant) =>
        variant.capabilityId?.startsWith('profile.') || variant.capabilityId?.startsWith('preferences.'));
    const ids = selected.map((variant) => variant.capabilityId).sort();
    requireCondition(new Set(ids).size === ids.length, 'duplicate-capability');
    for (const variant of selected)
    {
        const capability = catalogs.capability.capabilities.find((item) => item.id === variant.capabilityId);
        requireCondition(capability?.ownerProducerId === producerId
            && variant.validityClass === 'canonical-positive', 'capability-owner-or-variant');
    }
    return ids;
}

function localeAuthority()
{
    const catalog = JSON.parse(readFileSync(new URL('../../src/shared/Contracts/Localization/locale-catalog.json', import.meta.url), 'utf8'));
    return {
        digest: createHash('sha256').update(JSON.stringify(catalog)).digest('hex'),
        codes: new Set(catalog.locales.filter((locale) => locale.status === 'enabled').map((locale) => locale.code))
    };
}

/**
 * Join existing account observations with sealed auth references. These are source
 * checks and projection requests, never a device/AOT receipt or a second producer.
 * Locale resolution and Cookie encoding remain with their production authorities.
 */
export function composeAccountDeviceRequests(context, result, verifiedIdentities, catalogs = readFixtureCatalogs())
{
    const capabilities = selectedCapabilities(context, catalogs);
    if (capabilities.length === 0)
    {
        requireCondition(result == null, 'unrequested-account-state');
        return Object.freeze([]);
    }
    const raw = result?.compositionReceipt;
    requireCondition(raw?.producerId === producerId && raw.strategy === 'transaction-fixture', 'missing-account-source');
    assertNoAccountPrivateMaterial(raw);
    requireCondition(raw.namespace === context.namespace && raw.runId === context.runIdentity
        && raw.owner === `fxacct:${context.namespace}:${context.runIdentity}`, 'account-run-binding');
    requireCondition(same(raw.providedCapabilities, capabilities)
        && same(result.providedCapabilities, capabilities), 'capability-coverage');
    requireCondition(same(raw.observations, sourceObservations(result.observations))
        && same(raw.deviceProjections, result.deviceProjections), 'normalized-source-drift');
    requireCondition(verifiedIdentities?.verified === true
        && verifiedIdentities.ownerProducerId === 'auth-session'
        && verifiedIdentities.consumerProducerId === producerId
        && verifiedIdentities.namespace === context.namespace
        && verifiedIdentities.runId === context.runIdentity
        && verifiedIdentities.profileId === context.profileIdentity?.profileId, 'auth-run-binding');
    const refs = verifiedIdentities.references;
    requireCondition(Array.isArray(refs) && new Set(refs.map((ref) => ref.publicId)).size === refs.length
        && new Set(refs.map((ref) => ref.semanticRole)).size === refs.length, 'independent-account-identities');
    const database = raw.observations?.database;
    const cache = raw.observations?.cache;
    requireCondition(database?.namespace === context.namespace && database.schemaIdentity === 'public'
        && cache?.namespace === context.namespace && Array.isArray(database.entities)
        && Array.isArray(cache.entries), 'database-reader-binding');
    const entities = database.entities;
    requireCondition(entities.length === capabilities.length && cache.entries.length === entities.length
        && new Set(entities.map((entity) => entity.id)).size === entities.length
        && same(entities.map((entity) => entity.capabilityHint).sort(), capabilities), 'independent-capability-matrix');
    const authority = localeAuthority();
    requireCondition(raw.localeCatalogDigest === authority.digest, 'locale-catalog-drift');
    requireCondition(/^[a-f0-9]{64}$/u.test(raw.contentDigest), 'account-source-digest');
    requireCondition(result.producerVariantPlanDigest === context.variantPlan?.producerVariantPlanDigest,
        'producer-plan-drift');
    requireCondition(Array.isArray(raw.entityIdentities) && raw.entityIdentities.length === entities.length
        && entities.every((entity) => raw.entityIdentities.filter((identity) =>
            identity.id === entity.id && identity.kind === entity.kind
            && identity.capabilityHint === entity.capabilityHint).length === 1), 'entity-identity-coverage');
    const requests = [];
    for (const entity of entities)
    {
        const fields = entity.fields;
        const ref = refs.find((item) => `user-${item.publicId}` === entity.id);
        requireCondition(ref?.verified === true && entity.owned === true
            && entity.kind === (entity.capabilityHint.startsWith('profile.') ? 'profile' : 'preference')
            && fields?.identityReferenceDigest === ref.prepareReferenceDigest
            && fields.identityFixtureIdentity === ref.fixtureIdentity
            && fields.identitySemanticRole === ref.semanticRole
            && fields.identityOwnerProducerId === 'auth-session', 'entity-auth-ownership');
        const capability = catalogs.capability.capabilities.find((item) => item.id === entity.capabilityHint);
        requireCondition(capability.postconditionIds.includes(entity.postconditionId), 'entity-postcondition-binding');
        for (const postconditionId of capability.postconditionIds)
        {
            requireCondition(runPostcondition(postconditionId, {
                observations: raw.observations,
                entityIdentities: raw.entityIdentities,
                capabilityId: entity.capabilityHint,
                producerId
            }).ok === true, 'account-postcondition-failed');
        }
        const readers = cache.entries.filter((item) => item.identity === entity.id);
        requireCondition(readers.length === 1 && readers[0].matchesDatabase === true
            && readers[0].revision === fields.revision
            && readers[0].domain === (entity.kind === 'profile'
                ? 'redis.cache.private.account-snapshot' : 'application.preference-reader'), 'reader-revision-drift');
        const projections = raw.deviceProjections.filter((item) => item.userRef === entity.id);
        if (entity.kind === 'profile')
        {
            requireCondition(projections.length === 0, 'profile-device-side-effect');
            continue;
        }
        requireCondition(entity.kind === 'preference' && Array.isArray(fields.deviceRoles)
            && same(projections.map((item) => item.deviceRole).sort(), [...fields.deviceRoles].sort())
            && new Set(fields.deviceRoles).size === fields.deviceRoles.length
            && projections.length > 0 && projections.length === fields.deviceProjectionCount, 'device-role-coverage');
        for (const [field, projectedField] of [
            ['incomingDeviceLocales', 'incomingDeviceLocale'],
            ['explicitCookieLocales', 'explicitCookieLocale'],
            ['serverResolvedLocales', 'resolvedLocale']
        ])
        {
            requireCondition(same(fields[field], [...new Set(projections.map((projection) => projection[projectedField]))]),
                'device-resolution-summary-drift');
        }
        let siteOrigin;
        try
        {
            const site = new URL(context.handles?.accountDeviceSiteOrigin);
            requireCondition(['http:', 'https:'].includes(site.protocol)
                && site.origin === context.handles.accountDeviceSiteOrigin, 'device-site-origin');
            siteOrigin = site.origin;
        }
        catch
        {
            throw new Error('account-device composition: device-site-origin');
        }
        for (const projection of projections)
        {
            requireCondition(same(Object.keys(projection).sort(), projectionKeys), 'device-projection-shape');
            requireCondition(projection.capabilityId === entity.capabilityHint
                && projection.catalogDigest === authority.digest
                && projection.revision === fields.revision
                && projection.accountMode === fields.localeMode
                && projection.accountLocale === fields.fixedLocale, 'device-account-revision-drift');
            requireCondition(Number.isSafeInteger(projection.revision) && projection.revision > 0
                && typeof projection.deviceRole === 'string' && /^[a-z0-9][a-z0-9._-]{0,95}$/u.test(projection.deviceRole)
                && typeof projection.acceptLanguage === 'string' && projection.acceptLanguage.length <= 1024
                && typeof projection.resolutionSource === 'string' && projection.resolutionSource.length > 0,
            'device-source-shape');
            requireCondition(['accountLocale', 'incomingDeviceLocale', 'explicitCookieLocale', 'resolvedLocale']
                .every((key) => projection[key] === null && key !== 'resolvedLocale' || authority.codes.has(projection[key])), 'noncanonical-locale');
            requests.push({
                notAuthoritative: true,
                siteOrigin,
                namespace: context.namespace,
                runId: context.runIdentity,
                profileId: context.profileIdentity.profileId,
                accountResultDigest: raw.contentDigest,
                authSourceReceiptDigest: verifiedIdentities.sourceReceiptDigest,
                identityReferenceDigest: ref.digest,
                producerVariantPlanDigest: result.producerVariantPlanDigest,
                temporalContextDigest: digestCanonical(context.temporalContext),
                projection
            });
        }
    }
    requireCondition(raw.deviceProjections.length === requests.length, 'unowned-device-projection');
    assertNoAccountPrivateMaterial(requests);
    return freezeDeep(requests);
}

/** Validate the existing backend compensation plan without treating it as cleanup evidence. */
export function assertAccountCleanupOwnership(context, result, verifiedIdentities)
{
    assertCleanupOwnership(context, result, verifiedIdentities, true);
}

/** Recovery binds provisional allocation facts; it never publishes verified auth facts. */
export function assertAccountPreparedCleanupOwnership(context, result, preparedIdentities)
{
    assertCleanupOwnership(context, result, preparedIdentities, false);
}

function assertCleanupOwnership(context, result, verifiedIdentities, sealed)
{
    const raw = result?.compositionReceipt;
    assertNoAccountPrivateMaterial(raw);
    requireCondition(raw?.namespace === context.namespace && raw.runId === context.runIdentity
        && raw.owner === `fxacct:${context.namespace}:${context.runIdentity}`
        && verifiedIdentities?.namespace === context.namespace
        && verifiedIdentities.runId === context.runIdentity
        && verifiedIdentities.profileId === context.profileIdentity?.profileId, 'cleanup-run-binding');
    const entities = raw.observations?.database?.entities;
    const states = raw.cleanupState;
    const authority = localeAuthority();
    requireCondition(Array.isArray(entities) && entities.length > 0 && Array.isArray(states), 'missing-cleanup-plan');
    const users = new Set(entities.map((entity) => entity.id));
    if (raw.providedCapabilities.includes('profile.public-handle.conflict'))
    {
        const challenger = verifiedIdentities.references.find((ref) => ref.role === 'profile-conflict-challenger');
        requireCondition(challenger != null, 'missing-handle-challenger');
        users.add(`user-${challenger.publicId}`);
    }
    requireCondition(states.length === users.size
        && new Set(states.map((state) => state.userId)).size === states.length, 'cleanup-ownership-coverage');
    for (const state of states)
    {
        const ref = verifiedIdentities.references.find((item) => item.publicId === String(state.userId));
        const entity = entities.find((item) => item.id === `user-${state.userId}`);
        requireCondition(ref?.verified === sealed
            && ref.schema === (sealed ? 'fsusblog.fixture-identity-reference.v1' : 'fsusblog.fixture-identity-prepare-reference.v1')
            && ref.ownerProducerId === 'auth-session' && ref.consumerProducerId === producerId
            && users.has(`user-${state.userId}`)
            && ref.role === state.semanticRole
            && (sealed ? ref.prepareReferenceDigest : ref.digest) === state.identityReferenceDigest
            && /^[a-f0-9]{64}$/u.test(state.securityStateDigest)
            && (!entity || state.securityStateDigest === entity.fields.securityStateDigest), 'cleanup-unowned-account');
        requireCondition(typeof state.profileChanged === 'boolean' && typeof state.preferenceChanged === 'boolean'
            && (entity?.kind !== 'profile' || state.preferenceChanged === false)
            && (entity?.kind !== 'preference' || state.profileChanged === false), 'cleanup-domain-crossing');
        requireCondition(typeof state.previousPreferenceExisted === 'boolean'
            && state.previousPreference && ['auto', 'fixed'].includes(state.previousPreference.mode)
            && Number.isSafeInteger(state.previousPreference.revision) && state.previousPreference.revision >= 0
            && (state.previousPreference.fixedLocale === null
                || authority.codes.has(state.previousPreference.fixedLocale))
            && (state.previousPublicHandle === null || typeof state.previousPublicHandle === 'string'),
        'cleanup-previous-state-shape');
        if (state.preferenceChanged)
        {
            const committed = state.committedPreference;
            requireCondition(entity?.kind === 'preference' && committed != null
                && committed.mode === entity.fields.localeMode
                && committed.fixedLocale === entity.fields.fixedLocale
                && committed.revision === entity.fields.revision,
            'cleanup-committed-preference-drift');
        }
    }
}
