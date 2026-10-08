import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const { readFixtureCatalogs } = await import(new URL('../../../tools/testing/fixture-catalog.mjs', import.meta.url));


const producerId = 'account-profile-preferences';
const digest = 'ab'.repeat(32);
const catalog = JSON.parse(readFileSync(new URL('../../../src/shared/Contracts/Localization/locale-catalog.json', import.meta.url), 'utf8'));
const catalogDigest = createHash('sha256').update(JSON.stringify(catalog)).digest('hex');
const secondLocale = catalog.locales.find((locale) => locale.status === 'enabled' && locale.code !== catalog.defaultCode).code;
const roles = {
    'profile.public-handle.empty': 'profile-empty',
    'profile.public-handle.set': 'profile-set',
    'profile.public-handle.conflict': 'profile-conflict-owner',
    'preferences.locale.auto': 'preference-auto',
    'preferences.locale.fixed.zh-cn': 'preference-fixed-default',
    'preferences.locale.fixed.non-default': 'preference-fixed-non-default',
    'preferences.locale.device-explicit': 'preference-device-explicit',
    'preferences.locale.account-device-conflict': 'preference-account-device-conflict',
    'preferences.locale.revision-conflict': 'preference-revision-conflict',
    'preferences.locale.two-device-sync': 'preference-two-device'
};

/** Synthetic responses model the current C# DTO; they are not runtime authority evidence. */
export function accountCompositionTestSource(request)
{
    const catalogs = readFixtureCatalogs();
    const projections = [];
    const cleanupState = [];
    const entities = request.capabilities.map((capabilityId) =>
    {
        const ref = request.identityReferences.find((item) => item.role === roles[capabilityId]);
        const profile = capabilityId.startsWith('profile.');
        const auto = capabilityId === 'preferences.locale.auto' || capabilityId === 'preferences.locale.device-explicit';
        const fixedLocale = auto ? null : capabilityId === 'preferences.locale.fixed.zh-cn' ? catalog.defaultCode : secondLocale;
        const deviceRoles = capabilityId === 'preferences.locale.two-device-sync' ? ['device-a', 'device-b'] : ['device-primary'];
        const explicit = capabilityId === 'preferences.locale.device-explicit' ? secondLocale : auto ? null : fixedLocale;
        const incoming = capabilityId === 'preferences.locale.account-device-conflict' ? catalog.defaultCode
            : capabilityId === 'preferences.locale.device-explicit' ? secondLocale : null;
        const resolved = explicit ?? catalog.defaultCode;
        const id = `user-${ref.publicId}`;
        const handle = capabilityId === 'profile.public-handle.empty' ? null : `fx-profile-${ref.publicId}`;
        const fields = {
            revision: 2,
            readerMatchesDatabase: true,
            identityReferenceDigest: ref.digest,
            identityFixtureIdentity: ref.fixtureIdentity,
            identityOwnerProducerId: 'auth-session',
            identitySemanticRole: ref.semanticRole,
            securityStateDigest: digest,
            securityStateUnchanged: true,
            ...(profile ? {
                publicHandle: handle,
                uniqueOwnerCount: handle === null ? 0 : 1,
                preferenceMutation: false,
                ...(capabilityId === 'profile.public-handle.conflict'
                    ? { conflictErrorCode: 'conflict', challengerPreserved: true } : {})
            } : {
                localeMode: auto ? 'auto' : 'fixed',
                fixedLocale,
                catalogDigest,
                publicHandleMutation: false,
                deviceRoles,
                deviceProjectionCount: deviceRoles.length,
                incomingDeviceLocales: [incoming],
                explicitCookieLocales: [explicit],
                serverResolvedLocales: [resolved],
                isCatalogDefault: fixedLocale === catalog.defaultCode,
                isCatalogNonDefault: fixedLocale !== null && fixedLocale !== catalog.defaultCode,
                ...(capabilityId === 'preferences.locale.revision-conflict'
                    ? { conflictErrorCode: 'locale_preference_revision_conflict', newerValuePreserved: true, staleRevision: 1 } : {})
            })
        };
        cleanupState.push({ semanticRole: ref.role, userId: Number(ref.publicId), identityReferenceDigest: ref.digest,
            securityStateDigest: digest, profileChanged: profile, preferenceChanged: !profile,
            previousPublicHandle: null, previousPreferenceExisted: false,
            previousPreference: { mode: 'auto', fixedLocale: null, revision: 0 },
            committedPreference: profile ? null : { mode: fields.localeMode, fixedLocale, revision: fields.revision } });
        if (!profile)
        {
            for (const deviceRole of deviceRoles)
            {
                projections.push({ capabilityId, userRef: id, deviceRole,
                    accountMode: fields.localeMode, accountLocale: fixedLocale,
                    incomingDeviceLocale: incoming, explicitCookieLocale: explicit,
                    acceptLanguage: catalog.defaultCode, resolvedLocale: resolved,
                    resolutionSource: explicit === null ? 'AcceptLanguage' : 'ExplicitCookie', revision: fields.revision, catalogDigest });
            }
        }
        return { kind: profile ? 'profile' : 'preference', id, owned: true,
            capabilityHint: capabilityId,
            postconditionId: catalogs.capability.capabilities.find((item) => item.id === capabilityId).postconditionIds[0], fields };
    });
    if (request.capabilities.includes('profile.public-handle.conflict'))
    {
        const ref = request.identityReferences.find((item) => item.role === 'profile-conflict-challenger');
        cleanupState.push({ semanticRole: ref.role, userId: Number(ref.publicId), identityReferenceDigest: ref.digest,
            securityStateDigest: digest, profileChanged: true, preferenceChanged: false,
            previousPublicHandle: null, previousPreferenceExisted: false,
            previousPreference: { mode: 'auto', fixedLocale: null, revision: 0 }, committedPreference: null });
    }
    return {
        strategy: 'transaction-fixture', producerId, namespace: request.namespace, runId: request.runId, owner: request.owner,
        localeCatalogDigest: catalogDigest, providedCapabilities: request.capabilities,
        entityIdentities: entities.map((entity) => ({ kind: entity.kind, id: entity.id,
            handle: entity.fields.publicHandle ?? entity.fields.fixedLocale ?? null, capabilityHint: entity.capabilityHint })),
        observations: { source: 'production-command-and-independent-readers',
            database: { namespace: request.namespace, schemaIdentity: 'public', entities },
            cache: { namespace: request.namespace, entries: entities.map((entity) => ({
                domain: entity.kind === 'profile' ? 'redis.cache.private.account-snapshot' : 'application.preference-reader',
                identity: entity.id, matchesDatabase: true, revision: entity.fields.revision
            })) } },
        deviceProjections: projections, cleanupState, identityReferences: request.identityReferences,
        temporalObservation: { businessEpochUtc: '2024-02-29T23:59:59.000Z', backendCulture: 'Invariant', postgresTimezone: 'UTC' },
        contentDigest: digest
    };
}

export function accountCompositionTestInput()
{
    const references = Object.values(roles).concat('profile-conflict-challenger').map((role, index) => ({
        role, publicId: String(100 + index), semanticRole: `consumer.${producerId}.${role}`,
        digest, fixtureIdentity: `fxauth-${String(index + 1).padStart(24, '0')}`
    }));
    const raw = accountCompositionTestSource({ capabilities: Object.keys(roles).sort(), namespace: 'account-device',
        runId: 'account-device-run', owner: 'fxacct:account-device:account-device-run', identityReferences: references });
    return {
        context: { namespace: raw.namespace, runIdentity: raw.runId,
            profileIdentity: { profileId: 'account-profile-preferences' },
            variantPlan: { producerVariantPlanDigest: `sha256:${digest}`,
                variants: raw.providedCapabilities.map((capabilityId) => ({ capabilityId, validityClass: 'canonical-positive' })) },
            temporalContext: { unitTestOnly: true }, handles: { accountDeviceSiteOrigin: 'https://account-device.example' } },
        result: { compositionReceipt: raw, observations: raw.observations, deviceProjections: raw.deviceProjections,
            providedCapabilities: raw.providedCapabilities, producerVariantPlanDigest: `sha256:${digest}` },
        verifiedIdentities: { verified: true, ownerProducerId: 'auth-session', consumerProducerId: producerId,
            namespace: raw.namespace, runId: raw.runId, profileId: 'account-profile-preferences', sourceReceiptDigest: `sha256:${digest}`,
            references: references.map((ref) => ({ ...ref,
                schema: 'fsusblog.fixture-identity-reference.v1', ownerProducerId: 'auth-session', consumerProducerId: producerId,
                digest, prepareReferenceDigest: ref.digest, verified: true })) }
    };
}
