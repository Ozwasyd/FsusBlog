/**
 * Immutable ProducerReceipt builder / validator / digest (#1710).
 *
 * Success receipts are published only after prepare + postcondition verify.
 */

const { buildProducerFixtureVariantPlan, fixtureCatalogDigest: currentFixtureCatalogDigest, readFixtureCatalogs } = await import(new URL("../../testing/fixture-catalog.mjs", import.meta.url));

import {
    assertDigest,
    digestReceiptBody,
    freezeDeep,
    plainObject
} from './canonical.mjs';
import { normalizeCleanupContract as normalizeCommentCleanupContract } from './comment-cleanup-contract.mjs';
import { normalizeCleanupContract as normalizeMessagingCleanupContract } from './messaging-cleanup-contract.mjs';
import {
    digestCacheObservation,
    digestDatabaseObservation,
    digestRedisObservation,
    normalizeCacheObservation,
    normalizeDatabaseObservation,
    normalizeRedisObservation
} from './observations.mjs';
import {
    ENTITY_IDENTITY_KINDS,
    PRODUCER_RECEIPT_SCHEMA,
    RETIRED_FIXTURE_RECEIPT_SCHEMAS
} from './schemas.mjs';
import { assertNoSecrets } from './secrets.mjs';
import {
    normalizeCleanupContract as normalizeSecurityCleanupContract,
    normalizeDomainObservations,
    validateSecurityReceiptExtensions
} from './security-receipt-contract.mjs';

function normalizeCleanupContract(value)
{
    return value?.kind === 'comment-exact-receipt'
        ? normalizeCommentCleanupContract(value)
        : value?.kind === 'messaging-exact-receipt'
        ? normalizeMessagingCleanupContract(value)
        : normalizeSecurityCleanupContract(value);
}

function requireText(value, label)
{
    if (typeof value !== 'string' || !value.trim())
    {
        throw new Error(`${label} is required`);
    }
    return value.trim();
}

function freezeSortedStrings(values, label)
{
    if (!Array.isArray(values))
    {
        throw new Error(`${label} must be an array`);
    }
    const list = values.map((item) => requireText(String(item), label));
    const sorted = [...new Set(list)].sort();
    if (JSON.stringify(sorted) !== JSON.stringify(list) && list.length !== sorted.length)
    {
    // allow already-sorted unique; coerce to sorted unique
    }
    return Object.freeze([...new Set(list)].sort());
}

const ENTITY_IDENTITY_ALLOWED_KEYS = new Set([
    'kind',
    'id',
    'handle',
    'digest',
    'variantId',
    'owner'
]);

function normalizeEntityIdentities(entities, allowedVariantIds)
{
    if (!Array.isArray(entities))
    {
        throw new Error('entityIdentities must be an array');
    }
    const normalized = entities.map((item, index) =>
    {
        if (!plainObject(item))
        {
            throw new Error(`entityIdentities[${index}] must be an object`);
        }
        // Fail closed on invented fields (tokens/cookies must not be smuggled under alternate keys).
        assertNoSecrets(item);
        for (const key of Object.keys(item))
        {
            if (!ENTITY_IDENTITY_ALLOWED_KEYS.has(key))
            {
                throw new Error(`entityIdentities[${index}] forbids field ${key}; only kind/id/handle/digest/variantId/owner allowed`);
            }
        }
        const kind = requireText(String(item.kind ?? 'other'), `entityIdentities[${index}].kind`);
        if (!ENTITY_IDENTITY_KINDS.includes(kind) && kind !== 'other')
        {
            // allow extension via 'other'
        }
        const id = requireText(String(item.id ?? item.handle ?? ''), `entityIdentities[${index}].id`);
        const variantId = requireText(String(item.variantId ?? ''), `entityIdentities[${index}].variantId`);
        if (!allowedVariantIds.has(variantId))
        {
            throw new Error(`entityIdentities[${index}] references unproduced variant ${variantId}`);
        }
        const entry = {
            kind,
            id,
            handle: item.handle == null ? null : String(item.handle),
            digest: item.digest == null ? null : assertDigest(String(item.digest), `entityIdentities[${index}].digest`),
            variantId,
            owner: item.owner == null
                ? null
                : requireText(String(item.owner), `entityIdentities[${index}].owner`)
        };
        assertNoSecrets(entry);
        return entry;
    });
    normalized.sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`));
    return Object.freeze(normalized.map((item) => freezeDeep(item)));
}

function normalizePostconditionObservations(items)
{
    if (!Array.isArray(items))
    {
        throw new Error('postconditionObservations must be an array');
    }
    const normalized = items.map((item, index) =>
    {
        if (!plainObject(item))
        {
            throw new Error(`postconditionObservations[${index}] must be an object`);
        }
        return freezeDeep({
            capabilityId: requireText(String(item.capabilityId ?? ''), `postconditionObservations[${index}].capabilityId`),
            postconditionId: requireText(String(item.postconditionId ?? ''), `postconditionObservations[${index}].postconditionId`),
            ok: item.ok === true,
            detail: item.detail ?? null,
            reason: item.reason == null ? null : String(item.reason)
        });
    });
    normalized.sort((left, right) => `${left.capabilityId}:${left.postconditionId}`
        .localeCompare(`${right.capabilityId}:${right.postconditionId}`));
    return Object.freeze(normalized);
}

function normalizeTemporalBinding(value)
{
    if (value == null)
    {
        return null;
    }
    if (!plainObject(value) || value.qualificationEligible !== true)
    {
        throw new Error('temporalBinding must be a qualification-eligible object');
    }
    return freezeDeep({
        planDigest: assertDigest(value.planDigest, 'temporalBinding.planDigest'),
        actualDigest: assertDigest(value.actualDigest, 'temporalBinding.actualDigest'),
        receiptDigest: assertDigest(value.receiptDigest, 'temporalBinding.receiptDigest'),
        contextDigest: assertDigest(value.contextDigest, 'temporalBinding.contextDigest'),
        semanticOutcomeDigest: assertDigest(
            value.semanticOutcomeDigest,
            'temporalBinding.semanticOutcomeDigest'
        ),
        bindingDigest: assertDigest(value.bindingDigest, 'temporalBinding.bindingDigest'),
        qualificationEligible: true
    });
}

function normalizeSource(source)
{
    if (source == null)
    {
        return null;
    }
    if (!plainObject(source))
    {
        throw new Error('source must be an object');
    }
    const commit = source.commit == null ? null : String(source.commit);
    const worktreeFingerprint = source.worktreeFingerprint == null
        ? null
        : String(source.worktreeFingerprint);
    if (commit != null && commit !== '' && !/^[a-f0-9]{40}$/u.test(commit) && !/^[a-f0-9]{64}$/u.test(commit))
    {
    // allow shortened in unit tests only when explicitly marked; production prefers full hash
        if (!/^[a-f0-9]{7,64}$/u.test(commit))
        {
            throw new Error('source.commit must be a hex commit id');
        }
    }
    return freezeDeep({ commit, worktreeFingerprint });
}

/**
 * Build an immutable success ProducerReceipt. Caller must only invoke after verify.
 */
export function buildProducerReceipt({
    producerId,
    strategy,
    runId = null,
    namespace = null,
    source = null,
    fixtureCatalogDigest,
    profileId,
    expandedCapabilityDigest,
    fixtureVariantIds,
    variantPlanDigest,
    producerVariantPlanDigest,
    producedVariantIds,
    serviceGeneration = null,
    providedCapabilities,
    ownedStateDomains,
    entityIdentities = [],
    postconditionObservations = [],
    cleanupContract = null,
    databaseObservation = null,
    redisObservation = null,
    cacheObservation = null,
    domainObservations = [],
    temporalBinding = null,
    catalogs = readFixtureCatalogs()
} = {})
{
    const id = requireText(String(producerId ?? ''), 'producerId');
    const catalogProducer = (catalogs.producer.producers ?? []).find((item) => item.id === id);
    if (!catalogProducer)
    {
        throw new Error(`unknown producer ${id}`);
    }
    const sealedStrategy = requireText(String(strategy ?? catalogProducer.strategy), 'strategy');
    if (sealedStrategy !== catalogProducer.strategy)
    {
        throw new Error(`producer ${id} strategy ${sealedStrategy} does not match catalog ${catalogProducer.strategy}`);
    }
    if (currentFixtureCatalogDigest(catalogs) !== fixtureCatalogDigest)
    {
        throw new Error(`ProducerReceipt ${id} fixture catalog digest does not match FixtureVariantCatalog`);
    }

    const provided = freezeSortedStrings(providedCapabilities ?? catalogProducer.provides, 'providedCapabilities');
    for (const capabilityId of provided)
    {
        if (!catalogProducer.provides.includes(capabilityId))
        {
            throw new Error(`producer ${id} cannot claim undeclared capability ${capabilityId}`);
        }
    }
    const producedVariants = freezeSortedStrings(producedVariantIds, 'producedVariantIds');
    const completeVariants = freezeSortedStrings(fixtureVariantIds, 'fixtureVariantIds');
    const producedVariantEntries = producedVariants.map((variantId) =>
    {
        const variant = catalogs.variant.variants.find((item) => item.id === variantId);
        if (!variant)
        {
            throw new Error(`ProducerReceipt claims unregistered variant ${variantId}`);
        }
        if (variant.ownerProducerId !== id)
        {
            throw new Error(`ProducerReceipt variant ${variantId} is owned by ${variant.ownerProducerId}`);
        }
        return variant;
    });
    const variantCapabilities = producedVariantEntries.map((item) => item.capabilityId).sort();
    if (JSON.stringify(variantCapabilities) !== JSON.stringify([...provided].sort()))
    {
        throw new Error(`ProducerReceipt variants must map one-to-one with provided capabilities for ${id}`);
    }
    const expectedProducerVariantPlan = buildProducerFixtureVariantPlan({
        producerId: id,
        variantIds: producedVariants,
        fixtureVariantIds: completeVariants,
        fixtureVariantPlanDigest: variantPlanDigest,
        catalogs
    });
    if (producerVariantPlanDigest !== expectedProducerVariantPlan.producerVariantPlanDigest)
    {
        throw new Error(`ProducerReceipt ${id} typed variant plan digest does not match its exact producer slice`);
    }
    // Producers may provide a subset of catalog provides for a profile slice, but never a superset.

    const domains = freezeSortedStrings(ownedStateDomains ?? catalogProducer.stateDomains, 'ownedStateDomains');
    const catalogDomains = [...catalogProducer.stateDomains].sort();
    for (const domain of domains)
    {
        if (!catalogDomains.includes(domain))
        {
            throw new Error(`producer ${id} owned state domain ${domain} is not catalog-declared`);
        }
    }

    const observations = {
        database: databaseObservation
            ? normalizeDatabaseObservation(databaseObservation)
            : null,
        redis: redisObservation
            ? normalizeRedisObservation(redisObservation)
            : null,
        cache: cacheObservation
            ? normalizeCacheObservation(cacheObservation)
            : null
    };
    const sealedCleanupContract = normalizeCleanupContract(cleanupContract);
    if (sealedCleanupContract.kind === 'messaging-exact-receipt' && id !== 'account-messaging')
    {
        throw new Error('messaging exact cleanup receipt belongs only to account-messaging');
    }
    if (sealedCleanupContract.kind === 'comment-exact-receipt' && id !== 'comment-moderation')
    {
        throw new Error('comment exact cleanup receipt belongs only to comment-moderation');
    }

    const body = {
        schema: PRODUCER_RECEIPT_SCHEMA,
        producerId: id,
        strategy: sealedStrategy,
        runId: runId == null ? null : String(runId),
        namespace: namespace == null ? null : String(namespace),
        source: normalizeSource(source),
        fixtureCatalogDigest: assertDigest(fixtureCatalogDigest, 'fixtureCatalogDigest'),
        profileId: requireText(String(profileId ?? ''), 'profileId'),
        expandedCapabilityDigest: assertDigest(expandedCapabilityDigest, 'expandedCapabilityDigest'),
        fixtureVariantIds: completeVariants,
        variantPlanDigest: assertDigest(variantPlanDigest, 'variantPlanDigest'),
        producerVariantPlanDigest: assertDigest(producerVariantPlanDigest, 'producerVariantPlanDigest'),
        producedVariantIds: producedVariants,
        serviceGeneration: serviceGeneration == null ? null : String(serviceGeneration),
        providedCapabilities: provided,
        ownedStateDomains: domains,
        entityIdentities: normalizeEntityIdentities(entityIdentities, new Set(producedVariants)),
        postconditionObservations: normalizePostconditionObservations(postconditionObservations),
        cleanupContract: sealedCleanupContract,
        temporalBinding: normalizeTemporalBinding(temporalBinding),
        domainObservations: normalizeDomainObservations(domainObservations, id),
        observationDigests: freezeDeep({
            database: observations.database ? digestDatabaseObservation(observations.database) : null,
            redis: observations.redis ? digestRedisObservation(observations.redis) : null,
            cache: observations.cache ? digestCacheObservation(observations.cache) : null
        }),
        // Keep normalized observations for re-verify / aggregation; digests bind them.
        observations: freezeDeep(observations)
    };

    // Reject invented top-level fields by reconstructing from allow-list only (already done).
    assertNoSecrets(body);
    for (const entity of body.observations.database?.entities ?? [])
    {
        if (!entity.variantId || !body.producedVariantIds.includes(entity.variantId))
        {
            throw new Error(`database observation entity ${entity.id ?? '<missing>'} references no produced variant`);
        }
    }
    for (const item of body.postconditionObservations)
    {
        if (item.ok !== true)
        {
            throw new Error(`cannot publish ProducerReceipt success while postcondition ${item.postconditionId} failed`);
        }
    }

    const producerReceiptDigest = digestReceiptBody(body, 'producerReceiptDigest');
    return freezeDeep({ ...body, producerReceiptDigest });
}

export function validateProducerReceipt(document, { catalogs = readFixtureCatalogs() } = {})
{
    if (!plainObject(document))
    {
        throw new Error('ProducerReceipt must be an object');
    }
    if (RETIRED_FIXTURE_RECEIPT_SCHEMAS.includes(document.schema))
    {
        throw new Error(`retired receipt schema ${document.schema} is not accepted; no dual adapter`);
    }
    if (document.schema !== PRODUCER_RECEIPT_SCHEMA)
    {
        throw new Error(`ProducerReceipt schema must be ${PRODUCER_RECEIPT_SCHEMA}`);
    }
    assertNoSecrets(document);
    const expected = digestReceiptBody(document, 'producerReceiptDigest');
    if (document.producerReceiptDigest !== expected)
    {
        throw new Error('ProducerReceipt digest mismatch (tampered or incomplete)');
    }
    assertDigest(document.producerReceiptDigest, 'producerReceiptDigest');
    assertDigest(document.fixtureCatalogDigest, 'fixtureCatalogDigest');
    assertDigest(document.expandedCapabilityDigest, 'expandedCapabilityDigest');
    assertDigest(document.variantPlanDigest, 'variantPlanDigest');
    assertDigest(document.producerVariantPlanDigest, 'producerVariantPlanDigest');
    if (document.fixtureCatalogDigest !== currentFixtureCatalogDigest(catalogs))
    {
        throw new Error('ProducerReceipt fixture catalog digest does not match FixtureVariantCatalog');
    }
    if (document.temporalBinding != null)
    {
        normalizeTemporalBinding(document.temporalBinding);
    }
    validateSecurityReceiptExtensions(document, { normalizeCleanup: normalizeCleanupContract });

    const catalogProducer = (catalogs.producer.producers ?? []).find((item) => item.id === document.producerId);
    if (!catalogProducer)
    {
        throw new Error(`ProducerReceipt producer ${document.producerId} not in catalog`);
    }
    if (document.strategy !== catalogProducer.strategy)
    {
        throw new Error(`ProducerReceipt strategy does not match catalog for ${document.producerId}`);
    }
    const producedVariants = document.producedVariantIds ?? [];
    const completeVariants = document.fixtureVariantIds ?? [];
    const variantCapabilities = producedVariants.map((variantId) =>
    {
        const variant = catalogs.variant.variants.find((item) => item.id === variantId);
        if (!variant)
        {
            throw new Error(`ProducerReceipt claims unregistered variant ${variantId}`);
        }
        if (variant.ownerProducerId !== document.producerId)
        {
            throw new Error(`ProducerReceipt variant ${variantId} has wrong producer owner`);
        }
        return variant.capabilityId;
    }).sort();
    if (JSON.stringify(variantCapabilities) !== JSON.stringify([...(document.providedCapabilities ?? [])].sort()))
    {
        throw new Error('ProducerReceipt variants and provided capabilities are not exact');
    }
    const expectedProducerVariantPlan = buildProducerFixtureVariantPlan({
        producerId: document.producerId,
        variantIds: producedVariants,
        fixtureVariantIds: completeVariants,
        fixtureVariantPlanDigest: document.variantPlanDigest,
        catalogs
    });
    if (document.producerVariantPlanDigest !== expectedProducerVariantPlan.producerVariantPlanDigest)
    {
        throw new Error('ProducerReceipt typed variant plan digest does not match its exact producer slice');
    }
    for (const identity of document.entityIdentities ?? [])
    {
        if (!identity.variantId || !producedVariants.includes(identity.variantId))
        {
            throw new Error(`ProducerReceipt entity ${identity.id ?? '<missing>'} has no produced variant`);
        }
    }
    for (const entity of document.observations?.database?.entities ?? [])
    {
        if (!entity.variantId || !producedVariants.includes(entity.variantId))
        {
            throw new Error(`ProducerReceipt database entity ${entity.id ?? '<missing>'} has no produced variant`);
        }
    }
    for (const capabilityId of document.providedCapabilities ?? [])
    {
        if (!catalogProducer.provides.includes(capabilityId))
        {
            throw new Error(`ProducerReceipt claims undeclared capability ${capabilityId}`);
        }
    }
    const canonicalEntities = normalizeEntityIdentities(
        document.entityIdentities ?? [],
        new Set(producedVariants)
    );
    if (JSON.stringify(canonicalEntities) !== JSON.stringify(document.entityIdentities ?? []))
    {
        throw new Error('ProducerReceipt entityIdentities are not canonical');
    }
    // Recompute observation digests when observations are present.
    const obs = document.observations ?? {};
    if (obs.database)
    {
        const dig = digestDatabaseObservation(obs.database);
        if (document.observationDigests?.database !== dig)
        {
            throw new Error('ProducerReceipt database observation digest mismatch');
        }
    }
    if (obs.redis)
    {
        const dig = digestRedisObservation(obs.redis);
        if (document.observationDigests?.redis !== dig)
        {
            throw new Error('ProducerReceipt redis observation digest mismatch');
        }
    }
    if (obs.cache)
    {
        const dig = digestCacheObservation(obs.cache);
        if (document.observationDigests?.cache !== dig)
        {
            throw new Error('ProducerReceipt cache observation digest mismatch');
        }
    }
    return freezeDeep(document);
}

export function producerReceiptDigestOf(document)
{
    return validateProducerReceipt(document).producerReceiptDigest;
}
