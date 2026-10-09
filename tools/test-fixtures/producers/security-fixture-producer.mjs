/**
 * Test-only security fixture composition root (#2153-#2156).
 *
 * The producer never writes storage or changes product policy directly. It binds a
 * sealed fixture plan to three narrow production-semantic adapter families, then
 * requires an independent observation pass before returning evidence to the unique
 * FixtureOrchestrator.
 */
// fixture-catalog: producer security-state

import { createHash } from 'node:crypto';

const {resolveTemporalRolesForProducer, verifyResolvedTemporalArtifact} = await import(new URL('../../test/temporal-role-resolver.mjs', import.meta.url));
const {digestCanonical} = await import(new URL('../receipt/canonical.mjs', import.meta.url));
const {assertNoSecrets} = await import(new URL('../receipt/secrets.mjs', import.meta.url));
const {observePreparedBackendTemporalContext, validateBackendTemporalObservation} = await import(new URL('./backend-temporal-observer.mjs', import.meta.url));
export const SECURITY_FIXTURE_OBSERVATION_SCHEMA = 'fsusblog.security-fixture-observation.v1';
export const SECURITY_FIXTURE_OPERATION_PLAN_SCHEMA = 'fsusblog.security-fixture-operation-plan.v1';

const HASH_VERSION = 'sha256-v1';
const FORBIDDEN_IDENTITY = /(?:\*|\?|\[|\]|(?:^|:)all(?::|$)|(?:^|-)global(?:-|$))/iu;
const RAW_IP = /(?:^|[^0-9])(?:127\.0\.0\.1|(?:\d{1,3}\.){3}\d{1,3})(?:$|[^0-9])/u;
const RAW_IP_FIELD = /"(?:rawIp|ipAddress|remoteIp|clientIp)"\s*:/iu;

function requireText(value, label)
{
    if (typeof value !== 'string' || !value.trim())
    {
        throw new Error(`${label} is required`);
    }
    return value.trim();
}

function digestText(value)
{
    return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function exactSortedStrings(values, label)
{
    if (!Array.isArray(values))
    {
        throw new Error(`${label} must be an array`);
    }
    const result = values.map((value) => requireText(value, label));
    const expected = [...new Set(result)].sort();
    if (JSON.stringify(result) !== JSON.stringify(expected))
    {
        throw new Error(`${label} must be sorted and unique`);
    }
    return Object.freeze(result);
}

function assertPublicDocument(value, label)
{
    assertNoSecrets(value);
    const serialized = JSON.stringify(value);
    if (RAW_IP.test(serialized) || RAW_IP_FIELD.test(serialized))
    {
        throw new Error(`${label} forbids raw IP material`);
    }
}

function identityRef(kind, runId, namespace, semanticRole)
{
    const digest = digestText(`${kind}\0${runId}\0${namespace}\0${semanticRole}`);
    return Object.freeze({
        kind,
        semanticRole,
        hashVersion: HASH_VERSION,
        digest
    });
}

export function securityCapabilityFamily(capabilityId)
{
    if (/^security\.(?:clean|pow\.|risk\.|rate-limit\.)/u.test(capabilityId))
    {
        return 'risk-pow-rate-limit';
    }
    if (/^security\.subject\./u.test(capabilityId))
    {
        return 'ban';
    }
    if (/^security\.(?:credential\.|nullifier\.|issuance\.|audit\.)/u.test(capabilityId))
    {
        return 'credential';
    }
    throw new Error(`unknown security fixture capability ${capabilityId}`);
}

function requireAuthIdentityRef(context, capabilityId)
{
    if (capabilityId === 'security.clean')
    {
        return null;
    }
    const expectedRole = capabilityId === 'security.subject.banned'
        ? 'subject.banned'
        : capabilityId === 'security.subject.unbanned'
            ? 'subject.unbanned'
            : 'primary';
    const explicit = context.handles?.authIdentityPrepareRefs?.[expectedRole]
        ?? context.handles?.authIdentityPrepareRef;
    const fromProducer = context.producerOutputs?.['auth-session']?.identityPrepareReferences?.find((item) =>
        item?.consumerProducerId === 'security-state'
        && item?.role === expectedRole);
    const value = explicit ?? fromProducer;
    if (!value || typeof value !== 'object')
    {
        throw new Error('security fixture requires a provisional consumer-scoped auth identity reference');
    }
    const role = requireText(value.role ?? value.semanticRole, 'auth identity role');
    const digest = requireText(value.digest, 'auth identity digest');
    const producerResultDigest = requireText(value.producerResultDigest, 'auth identity producer result digest');
    if (value.schema !== 'fsusblog.fixture-identity-prepare-reference.v1'
      || value.verified !== false
      || value.ownerProducerId !== 'auth-session'
      || value.consumerProducerId !== 'security-state'
      || value.runId !== context.runIdentity
      || value.namespace !== context.namespace
      || value.profileId !== context.profileIdentity?.profileId
      || role !== expectedRole
      || !/^(?:sha256:)?[0-9a-f]{64}$/u.test(digest)
      || !/^(?:sha256:)?[0-9a-f]{64}$/u.test(producerResultDigest)
      || value.planDigests?.catalogDigest !== context.plan?.catalogDigest
      || value.planDigests?.fixtureVariantPlanDigest !== context.plan?.variantPlanDigest
      || !/^(?:sha256:)?[0-9a-f]{64}$/u.test(value.planDigests?.authSessionPlanDigest ?? '')
      || !/^(?:sha256:)?[0-9a-f]{64}$/u.test(value.planDigests?.producerVariantPlanDigest ?? ''))
    {
        throw new Error('security fixture auth identity prepare reference is not current/digest-bound for the allocated role');
    }
    const normalized = Object.freeze({
        schema: value.schema,
        verified: false,
        ownerProducerId: value.ownerProducerId,
        consumerProducerId: value.consumerProducerId,
        runId: value.runId,
        namespace: value.namespace,
        profileId: value.profileId,
        role,
        publicId: requireText(value.publicId, 'auth identity public id'),
        fixtureIdentity: requireText(value.fixtureIdentity, 'auth identity fixture identity'),
        digest,
        producerResultDigest,
        planDigests: Object.freeze({
            authSessionPlanDigest: value.planDigests.authSessionPlanDigest,
            catalogDigest: value.planDigests.catalogDigest,
            fixtureVariantPlanDigest: value.planDigests.fixtureVariantPlanDigest,
            producerVariantPlanDigest: value.planDigests.producerVariantPlanDigest
        })
    });
    assertPublicDocument(normalized, 'auth identity reference');
    return normalized;
}

function temporalFacts(context)
{
    const artifact = resolveTemporalRolesForProducer({
        temporalContext: context.temporalContext,
        namespace: context.namespace,
        fixtureId: 'security-state'
    });
    verifyResolvedTemporalArtifact(artifact, { temporalContext: context.temporalContext });
    return Object.freeze({
        businessEpochUtc: artifact.contextIdentity.businessEpochUtc,
        businessClockMode: 'fixed',
        timezone: artifact.projection.timezone,
        locale: artifact.projection.locale,
        contextDigest: artifact.contextIdentity.contextDigest,
        catalogDigest: artifact.catalog.digest,
        shape: artifact.shape,
        semanticDigest: artifact.semanticDigest,
        contentDigest: artifact.contentDigest,
        roles: artifact.roles
    });
}

function temporalRoleIds(capabilityId)
{
    if (/^security\.risk\./u.test(capabilityId))
    {
        return ['security.risk-occurred', 'security.risk-expiry'];
    }
    if (capabilityId === 'security.pow.elevated')
    {
        return ['security.pow-window-start', 'security.pow-window-end'];
    }
    if (/^security\.rate-limit\./u.test(capabilityId))
    {
        return ['security.rate-limit-window-start', 'security.rate-limit-window-end'];
    }
    if (/^security\.subject\./u.test(capabilityId))
    {
        return ['security.ban-start', 'security.ban-end'];
    }
    if (/^security\.credential\./u.test(capabilityId))
    {
        return ['security.credential-issued', 'security.credential-revoked', 'security.credential-expiry'];
    }
    if (capabilityId === 'security.nullifier.blocked')
    {
        return ['security.nullifier-issued'];
    }
    if (/^security\.(?:issuance|audit)\./u.test(capabilityId))
    {
        return ['security.credential-issued', 'security.credential-revoked'];
    }
    return ['security.risk-occurred'];
}

function variantByCapability(context)
{
    return new Map((context.variantPlan?.variants ?? []).map((variant) => [variant.capabilityId, variant.id]));
}

export function buildSecurityFixtureOperationPlan(context)
{
    const securityVariants = (context.variantPlan?.variants ?? [])
        .filter((variant) => variant.ownerProducerId === 'security-state');
    const capabilities = securityVariants.map((variant) => variant.capabilityId).sort();
    const runId = requireText(context.runIdentity, 'security run identity');
    const namespace = requireText(context.namespace, 'security namespace');
    if (FORBIDDEN_IDENTITY.test(namespace))
    {
        throw new Error('security namespace must be exact and cannot be global/wildcard');
    }
    const variants = variantByCapability(context);
    const variantEntries = new Map(securityVariants.map((variant) => [variant.capabilityId, variant]));
    for (const capabilityId of capabilities)
    {
        if (!variants.has(capabilityId))
        {
            throw new Error(`security capability ${capabilityId} has no sealed variant`);
        }
    }
    const temporal = temporalFacts(context);
    const operations = capabilities.map((capabilityId) =>
    {
        const semanticRole = capabilityId.slice('security.'.length);
        const subject = identityRef('subject', runId, namespace, semanticRole);
        const operation = {
            capabilityId,
            family: securityCapabilityFamily(capabilityId),
            semanticRole,
            variantId: variants.get(capabilityId),
            expectedBoundary: requireText(variantEntries.get(capabilityId)?.expectedBoundary, `${capabilityId} expected boundary`),
            operationId: digestText(`operation\0${runId}\0${namespace}\0${capabilityId}`),
            owner: Object.freeze({ runId, namespace, producerId: 'security-state' }),
            subject,
            ipPseudonym: identityRef('ip-pseudonym', runId, namespace, semanticRole),
            credential: identityRef('credential', runId, namespace, semanticRole),
            nullifier: identityRef('nullifier', runId, namespace, semanticRole),
            issuance: identityRef('issuance', runId, namespace, semanticRole),
            temporal,
            temporalRoles: Object.freeze(temporalRoleIds(capabilityId).map((roleId) =>
                temporal.roles.find((role) => role.roleId === roleId))),
            authIdentityRef: requireAuthIdentityRef(context, capabilityId)
        };
        assertPublicDocument(operation, `security operation ${capabilityId}`);
        return Object.freeze(operation);
    });
    const body = {
        schema: SECURITY_FIXTURE_OPERATION_PLAN_SCHEMA,
        runId,
        namespace,
        profileId: requireText(context.profileIdentity?.profileId, 'security profile identity'),
        producerId: 'security-state',
        fixtureCatalogDigest: requireText(context.plan?.catalogDigest, 'security fixture catalog digest'),
        producerVariantPlanDigest: requireText(context.variantPlan?.producerVariantPlanDigest, 'security variant plan digest'),
        temporal,
        capabilities: Object.freeze(capabilities),
        operations: Object.freeze(operations)
    };
    const plan = Object.freeze({ ...body, contentDigest: digestCanonical(body) });
    assertPublicDocument(plan, 'security operation plan');
    return plan;
}

function requireDomainAdapter(value, family)
{
    if (!value || typeof value !== 'object')
    {
        throw new Error(`security ${family} production-semantic adapter is required`);
    }
    for (const method of ['apply', 'observe', 'cleanup', 'observeCleanup'])
    {
        if (typeof value[method] !== 'function')
        {
            throw new Error(`security ${family} adapter requires ${method}()`);
        }
    }
    for (const forbidden of ['executeSql', 'redisCommand', 'resetAll', 'scan', 'overrideThreshold'])
    {
        if (typeof value[forbidden] === 'function')
        {
            throw new Error(`security ${family} adapter exposes forbidden direct operation ${forbidden}`);
        }
    }
    return value;
}

function securityFixtureBaseUrl(context)
{
    return String(
        context.handles?.baseUrl
        ?? context.handles?.debugBackendUrl
        ?? process.env.FSUSBLOG_BASE_URL
        ?? process.env.FSUSBLOG_DEBUG_BACKEND_URL
        ?? ''
    ).replace(/\/+$/u, '');
}

function createHttpSecurityFixturePorts(context)
{
    const baseUrl = securityFixtureBaseUrl(context);
    const secret = String(
        context.handles?.localSecurityFixtureSecret
        ?? process.env.FSUSBLOG_LOCAL_SECURITY_FIXTURE_SECRET
        ?? ''
    );
    if (!baseUrl || !secret)
    {
        throw new Error('security fixture requires backend URL and explicit local security fixture secret');
    }

    async function invoke(action, document, signal)
    {
        const response = await fetch(`${baseUrl}/__local/security-fixture/${action}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                'X-Fsus-Local-Security-Fixture-Secret': secret,
                'X-Fsus-Test-Run-Id': String(context.runIdentity ?? ''),
                'X-Fsus-Test-Namespace': String(context.namespace ?? ''),
                'X-Fsus-Test-Profile-Id': String(context.profileIdentity?.profileId ?? '')
            },
            body: JSON.stringify(document),
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
            payload = null;
        }
        if (!response.ok)
        {
            throw new Error(`security fixture ${action} failed (${response.status}): ${payload?.detail ?? text}`);
        }
        return payload;
    }

    const adapter = Object.freeze({
        apply: (fragment, signal) => invoke('apply', fragment, signal),
        observe: (fragment, signal) => invoke('observe', fragment, signal),
        cleanup: (plan, signal) => invoke('cleanup', plan, signal),
        observeCleanup: (plan, signal) => invoke('observe-cleanup', plan, signal)
    });
    return Object.freeze({
        riskPowRateLimit: adapter,
        ban: adapter,
        credential: adapter
    });
}

function familyAdapters(context)
{
    const input = context.handles?.securityFixturePorts ?? createHttpSecurityFixturePorts(context);
    return Object.freeze({
        'risk-pow-rate-limit': requireDomainAdapter(input.riskPowRateLimit, 'risk-pow-rate-limit'),
        ban: requireDomainAdapter(input.ban, 'ban'),
        credential: requireDomainAdapter(input.credential, 'credential')
    });
}

async function observeSecurityTemporalContext(context, familyObservations, signal)
{
    const first = familyObservations[0];
    if (context.handles?.securityFixturePorts)
    {
        for (const observed of familyObservations)
        {
            validateBackendTemporalObservation(context.temporalContext, observed);
        }
        return Object.freeze({
            businessEpochUtc: first.businessEpochUtc,
            backendCulture: first.backendCulture,
            postgresTimezone: first.postgresTimezone
        });
    }
    return observePreparedBackendTemporalContext(context, {
        businessEpochUtc: first.businessEpochUtc
    }, signal, { baseUrl: securityFixtureBaseUrl(context) });
}

function fragmentForFamily(plan, family)
{
    const operations = plan.operations.filter((operation) => operation.family === family);
    const body = {
        schema: 'fsusblog.security-fixture-operation-fragment.v1',
        planDigest: plan.contentDigest,
        runId: plan.runId,
        namespace: plan.namespace,
        producerId: plan.producerId,
        family,
        capabilities: Object.freeze(operations.map((operation) => operation.capabilityId)),
        operations: Object.freeze(operations)
    };
    return Object.freeze({ ...body, contentDigest: digestCanonical(body) });
}

function assertExactFact(fact, operation, observation)
{
    if (!fact || typeof fact !== 'object'
      || fact.capabilityId !== operation.capabilityId
      || fact.operationId !== operation.operationId
      || fact.subjectDigest !== operation.subject.digest
      || fact.ipPseudonymDigest !== operation.ipPseudonym.digest
      || fact.credentialDigest !== operation.credential.digest
      || fact.nullifierDigest !== operation.nullifier.digest
      || fact.issuanceDigest !== operation.issuance.digest
      || fact.hashVersion !== HASH_VERSION)
    {
        throw new Error(`security ${operation.capabilityId} fact identity mismatch`);
    }
    const clean = operation.capabilityId === 'security.clean';
    const database = fact.database;
    const redis = fact.redis;
    const service = fact.service;
    const cache = fact.cache;
    const audit = fact.audit;
    if (!database || database.present !== !clean || database.version == null
      || database.windowStartUtc !== observation.businessEpochUtc
      || typeof database.reason !== 'string')
    {
        throw new Error(`security ${operation.capabilityId} database postcondition mismatch`);
    }
    if (!redis || redis.present !== !clean || redis.namespace !== observation.namespace
      || redis.hashVersion !== HASH_VERSION
      || (!clean && (!Number.isInteger(redis.ttlSeconds) || redis.ttlSeconds <= 0)))
    {
        throw new Error(`security ${operation.capabilityId} Redis/TTL postcondition mismatch`);
    }
    if (!service || service.observed !== true || typeof service.decision !== 'string'
      || !cache || cache.invalidationObserved !== true || !Number.isInteger(cache.generation)
      || !audit || audit.present !== true || typeof audit.eventDigest !== 'string')
    {
        throw new Error(`security ${operation.capabilityId} service/cache/audit postcondition mismatch`);
    }
    if (!clean && (typeof database.expiresAtUtc !== 'string'
      || Date.parse(database.expiresAtUtc) <= Date.parse(observation.businessEpochUtc)))
    {
        throw new Error(`security ${operation.capabilityId} expiry/window is not active at the injected business epoch`);
    }
    if (clean && service.decision !== 'clean')
    {
        throw new Error('security clean service decision mismatch');
    }
    if (operation.capabilityId === 'security.rate-limit.near-limit'
      && (fact.counter?.blocked !== false || fact.counter.current !== fact.counter.limit - 1))
    {
        throw new Error('security rate-limit near-limit boundary is not exact');
    }
    if (operation.capabilityId === 'security.rate-limit.blocked'
      && (fact.counter?.blocked !== true || fact.counter.current < fact.counter.limit))
    {
        throw new Error('security rate-limit blocked boundary is not exact');
    }
    if (operation.capabilityId === 'security.credential.revoked' && service.decision !== 'rejected')
    {
        throw new Error('revoked credential was not rejected by the service decision');
    }
    if (operation.capabilityId === 'security.credential.active' && service.decision !== 'accepted')
    {
        throw new Error('active credential was not accepted by the service decision');
    }
    if (operation.capabilityId === 'security.nullifier.blocked' && service.decision !== 'rejected')
    {
        throw new Error('blocked nullifier was not rejected by the service decision');
    }
    if (operation.capabilityId === 'security.pow.elevated' && service.decision !== 'elevated')
    {
        throw new Error('elevated PoW service decision mismatch');
    }
    if (operation.capabilityId === 'security.rate-limit.near-limit' && service.decision !== 'near-limit')
    {
        throw new Error('near-limit service decision mismatch');
    }
    if (operation.capabilityId === 'security.rate-limit.blocked' && service.decision !== 'blocked')
    {
        throw new Error('blocked rate-limit service decision mismatch');
    }
    if (operation.capabilityId === 'security.issuance.replay-observed' && service.decision !== 'replay-rejected')
    {
        throw new Error('issuance replay was not rejected by the anti-replay decision');
    }
    if (operation.capabilityId === 'security.audit.active-window' && service.decision !== 'active-window')
    {
        throw new Error('security audit event was not observed in the active business window');
    }
    if (operation.capabilityId === 'security.risk.escalated' && service.decision !== 'escalated')
    {
        throw new Error('escalated risk service decision mismatch');
    }
    if (operation.capabilityId === 'security.risk.low' && service.decision !== 'low')
    {
        throw new Error('low risk service decision mismatch');
    }
    if (operation.capabilityId === 'security.subject.banned' && service.decision !== 'rejected')
    {
        throw new Error('banned subject was not rejected by the service decision');
    }
    if (operation.capabilityId === 'security.subject.unbanned' && service.decision !== 'accepted')
    {
        throw new Error('unbanned subject was not accepted by the service decision');
    }
}

export function validateSecurityFixtureObservation(value, plan, family)
{
    if (!value || typeof value !== 'object' || value.schema !== SECURITY_FIXTURE_OBSERVATION_SCHEMA)
    {
        throw new Error(`security ${family} observation schema is invalid`);
    }
    const operations = plan.operations.filter((operation) => operation.family === family);
    const expectedCapabilities = operations.map((operation) => operation.capabilityId);
    const capabilities = exactSortedStrings(value.capabilities, `security ${family} observation capabilities`);
    if (JSON.stringify(capabilities) !== JSON.stringify(expectedCapabilities)
      || value.planDigest !== plan.contentDigest
      || value.runId !== plan.runId
      || value.namespace !== plan.namespace
      || value.family !== family
      || value.businessEpochUtc !== plan.temporal.businessEpochUtc
      || value.partial !== false
      || !Array.isArray(value.warnings) || value.warnings.length !== 0
      || !Array.isArray(value.privacyLeaks) || value.privacyLeaks.length !== 0)
    {
        throw new Error(`security ${family} observation identity/status mismatch`);
    }
    if (!Array.isArray(value.facts) || value.facts.length !== operations.length)
    {
        throw new Error(`security ${family} observation must contain one fact per operation`);
    }
    for (const operation of operations)
    {
        const fact = value.facts.find((candidate) => candidate?.capabilityId === operation.capabilityId);
        assertExactFact(fact, operation, value);
    }
    const body = { ...value };
    delete body.contentDigest;
    if (value.contentDigest !== digestCanonical(body))
    {
        throw new Error(`security ${family} observation content digest mismatch`);
    }
    assertPublicDocument(value, `security ${family} observation`);
    return Object.freeze(value);
}

function genericObservations(plan, familyObservations)
{
    const facts = familyObservations.flatMap((observation) => observation.facts);
    const operationByCapability = new Map(plan.operations.map((operation) => [operation.capabilityId, operation]));
    const databaseEntities = [];
    const redisKeys = [];
    const cacheEntries = [];
    const entityIdentities = [];
    const variantEvidence = [];
    for (const fact of facts)
    {
        const operation = operationByCapability.get(fact.capabilityId);
        const entityId = `${operation.subject.kind}:${operation.subject.digest}`;
        const fields = {
            capabilityId: fact.capabilityId,
            state: fact.service.decision,
            hashVersion: fact.hashVersion,
            version: fact.database.version,
            reason: fact.database.reason,
            windowStartUtc: fact.database.windowStartUtc,
            expiresAtUtc: fact.database.expiresAtUtc ?? null,
            databasePresent: fact.database.present,
            redisPresent: fact.redis.present,
            redisTtlSeconds: fact.redis.ttlSeconds ?? null,
            serviceDecision: fact.service.decision,
            serviceObserved: fact.service.observed,
            cacheGeneration: fact.cache.generation,
            cacheInvalidationObserved: fact.cache.invalidationObserved,
            auditPresent: fact.audit.present,
            counter: fact.counter ?? null
        };
        databaseEntities.push({
            domain: 'postgres.security',
            kind: fact.capabilityId === 'security.clean' ? 'security-clean-observation' : 'security-subject',
            id: entityId,
            owner: plan.namespace,
            variantId: operation.variantId,
            postconditionId: fact.capabilityId.slice('security.'.length),
            fields
        });
        redisKeys.push({
            domain: 'redis.rate-limit',
            key: fact.redis.keyIdentity ?? operation.operationId,
            present: fact.redis.present,
            namespace: fact.redis.namespace,
            hashVersion: fact.redis.hashVersion,
            ttlSeconds: fact.redis.ttlSeconds ?? null,
            valueDigest: fact.redis.valueDigest ?? null,
            capabilityId: fact.capabilityId
        });
        cacheEntries.push({
            domain: 'security.service-decision',
            generation: String(fact.cache.generation),
            matchesDb: true,
            capabilityId: fact.capabilityId,
            serviceDecision: fact.service.decision,
            serviceObserved: fact.service.observed,
            invalidationObserved: fact.cache.invalidationObserved
        });
        for (const [kind, identity] of [
            ['security-subject', operation.subject],
            ['security-credential', operation.credential],
            ['security-nullifier', operation.nullifier],
            ['security-issuance', operation.issuance],
            ['security-rate-limit', operation.ipPseudonym]
        ])
        {
            entityIdentities.push({
                kind,
                id: `${kind}:${identity.digest}`,
                digest: identity.digest,
                variantId: operation.variantId,
                owner: `security-state:${plan.namespace}`
            });
        }
        variantEvidence.push({
            variantId: operation.variantId,
            source: 'live-service',
            entityIds: [entityId],
            expectedBoundary: operation.expectedBoundary
        });
    }
    return {
        observations: {
            source: 'live-service',
            database: {
                namespace: plan.namespace,
                schemaIdentity: 'public',
                catalogDigest: plan.fixtureCatalogDigest,
                entities: databaseEntities
            },
            redis: {
                namespace: plan.namespace,
                redisNamespace: plan.namespace,
                catalogDigest: plan.fixtureCatalogDigest,
                keys: redisKeys
            },
            cache: {
                namespace: plan.namespace,
                catalogDigest: plan.fixtureCatalogDigest,
                entries: cacheEntries
            }
        },
        entityIdentities,
        variantEvidence: { variants: variantEvidence }
    };
}

function selectedFamilies(plan)
{
    return [...new Set(plan.operations.map((operation) => operation.family))].sort();
}

function validateRecoveryReceipt(value, plan, fragment)
{
    const expectedIds = fragment.operations.map((operation) => operation.operationId).sort();
    if (!value || typeof value !== 'object'
      || value.schema !== 'fsusblog.security-fixture-recovery-receipt.v1'
      || value.status !== 'ready'
      || value.planDigest !== plan.contentDigest
      || value.family !== fragment.family
      || JSON.stringify(value.ownedOperationIds) !== JSON.stringify(expectedIds))
    {
        throw new Error(`security ${fragment.family} recovery receipt is missing or not exact`);
    }
    const body = { ...value };
    delete body.contentDigest;
    if (value.contentDigest !== digestCanonical(body))
    {
        throw new Error(`security ${fragment.family} recovery receipt digest mismatch`);
    }
    assertPublicDocument(value, `security ${fragment.family} recovery receipt`);
    return Object.freeze(value);
}

async function cleanupFamily(adapter, plan, fragment, signal)
{
    const ownedOperationIds = fragment.operations.map((operation) => operation.operationId).sort();
    if (ownedOperationIds.some((identity) => FORBIDDEN_IDENTITY.test(identity)))
    {
        throw new Error('security cleanup forbids wildcard/global identities');
    }
    const cleanupPlan = Object.freeze({
        schema: 'fsusblog.security-fixture-cleanup-plan.v1',
        planDigest: plan.contentDigest,
        runId: plan.runId,
        namespace: plan.namespace,
        family: fragment.family,
        ownedOperationIds
    });
    const result = await adapter.cleanup(cleanupPlan, signal);
    if (!result || result.status !== 'cleaned'
      || result.planDigest !== plan.contentDigest
      || JSON.stringify(result.removedOperationIds) !== JSON.stringify(ownedOperationIds)
      || result.nonOwnedMutationCount !== 0)
    {
        throw new Error(`security ${fragment.family} exact owned cleanup failed`);
    }
    const observation = await adapter.observeCleanup(cleanupPlan, signal);
    if (!observation || observation.schema !== 'fsusblog.security-fixture-cleanup-observation.v1'
      || observation.planDigest !== plan.contentDigest
      || observation.family !== fragment.family
      || JSON.stringify(observation.removedOperationIds) !== JSON.stringify(ownedOperationIds)
      || !Array.isArray(observation.residualOwnedOperationIds)
      || observation.residualOwnedOperationIds.length !== 0
      || observation.nonOwnedMutationCount !== 0
      || !Array.isArray(observation.preservedNamespaceDigests)
      || observation.preservedNamespaceDigests.length === 0)
    {
        throw new Error(`security ${fragment.family} independent cleanup observation failed`);
    }
    const body = { ...observation };
    delete body.contentDigest;
    if (observation.contentDigest !== digestCanonical(body))
    {
        throw new Error(`security ${fragment.family} cleanup observation digest mismatch`);
    }
    assertPublicDocument(observation, `security ${fragment.family} cleanup observation`);
    return observation;
}

export async function prepareSecurityFixtures(context, signal)
{
    const plan = buildSecurityFixtureOperationPlan(context);
    if (plan.capabilities.length === 0)
    {
        throw new Error('security-state producer cannot run for a profile with no security capability');
    }
    const adapters = familyAdapters(context);
    const familyObservations = [];
    const recoveryReceipts = [];
    const applied = [];
    let temporalObservation;
    try
    {
        for (const family of selectedFamilies(plan))
        {
            const fragment = fragmentForFamily(plan, family);
            const result = await adapters[family].apply(fragment, signal);
            if (!result || result.status !== 'applied' || result.planDigest !== plan.contentDigest
              || result.partial === true || result.warningOnly === true)
            {
                throw new Error(`security ${family} apply did not reach an exact applied state`);
            }
            const recoveryReceipt = validateRecoveryReceipt(result.recoveryReceipt, plan, fragment);
            recoveryReceipts.push(recoveryReceipt);
            applied.push({ family, fragment });
            const observed = validateSecurityFixtureObservation(
                await adapters[family].observe(fragment, signal),
                plan,
                family
            );
            familyObservations.push(observed);
        }
        temporalObservation = await observeSecurityTemporalContext(context, familyObservations, signal);
    }
    catch (error)
    {
        const cleanupErrors = [];
        for (const { family, fragment } of [...applied].reverse())
        {
            try
            {
                await cleanupFamily(adapters[family], plan, fragment, signal);
            }
            catch (cleanupError)
            {
                cleanupErrors.push(cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
            }
        }
        if (cleanupErrors.length)
        {
            // eslint-disable-next-line preserve-caught-error
            throw new AggregateError([error], `security prepare failed and recovery cleanup failed: ${cleanupErrors.join('; ')}`);
        }
        throw error;
    }
    const generic = genericObservations(plan, familyObservations);
    const result = {
        producerId: 'security-state',
        strategy: 'transaction-fixture',
        implementation: 'tools/test-fixtures/producers/security-fixture-producer.mjs',
        structuralOnly: false,
        enforceVariantEvidence: true,
        variantIds: context.variantPlan.variants.map((variant) => variant.id).sort(),
        producerVariantPlanDigest: context.variantPlan.producerVariantPlanDigest,
        providedCapabilities: plan.capabilities,
        operationPlan: plan,
        familyObservationDigests: familyObservations.map((observation) => observation.contentDigest).sort(),
        temporalObservation,
        recoveryReceipts,
        domainObservations: familyObservations.map((observation) => ({
            schema: observation.schema,
            ownerProducerId: 'security-state',
            contentDigest: observation.contentDigest,
            document: observation
        })),
        cleanupContract: {
            kind: 'receipt-owned-exact',
            operationPlanDigest: plan.contentDigest,
            ownedEntityDigests: [...new Set(plan.operations.flatMap((operation) => [
                operation.subject.digest,
                operation.ipPseudonym.digest,
                operation.credential.digest,
                operation.nullifier.digest,
                operation.issuance.digest
            ]))].sort(),
            ownedRedisKeyDigests: plan.operations.map((operation) => operation.operationId).sort(),
            recoveryReceiptDigests: recoveryReceipts.map((receipt) => receipt.contentDigest).sort()
        },
        ...generic
    };
    assertPublicDocument(result, 'security producer result');
    return Object.freeze(result);
}

export async function verifySecurityFixtures(context, producerResult, signal)
{
    const plan = producerResult?.operationPlan;
    if (!plan || plan.contentDigest !== buildSecurityFixtureOperationPlan(context).contentDigest)
    {
        throw new Error('security producer result is not bound to the current operation plan');
    }
    validateBackendTemporalObservation(context.temporalContext, producerResult.temporalObservation);
    const adapters = familyAdapters(context);
    const observed = [];
    for (const family of selectedFamilies(plan))
    {
        observed.push(validateSecurityFixtureObservation(
            await adapters[family].observe(fragmentForFamily(plan, family), signal),
            plan,
            family
        ));
    }
    await observeSecurityTemporalContext(context, observed, signal);
    const digests = observed.map((item) => item.contentDigest).sort();
    if (JSON.stringify(digests) !== JSON.stringify(producerResult.familyObservationDigests))
    {
        throw new Error('security independent verifier observed state drift');
    }
    return { ok: true, observations: genericObservations(plan, observed).observations };
}

export async function cleanupSecurityFixtures(context, producerResult, signal)
{
    const plan = producerResult?.operationPlan;
    if (!plan || plan.runId !== context.runIdentity || plan.namespace !== context.namespace)
    {
        throw new Error('security cleanup requires the exact current operation plan');
    }
    const adapters = familyAdapters(context);
    const observations = [];
    for (const family of [...selectedFamilies(plan)].reverse())
    {
        const fragment = fragmentForFamily(plan, family);
        observations.push(await cleanupFamily(adapters[family], plan, fragment, signal));
    }
    return Object.freeze(observations);
}
