import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
    defaultTimeoutPolicyDigest,
    qualificationTemporalContext
} from '../../tools/test/temporal-context.mjs';
import {
    authSessionProducerMeta,
    buildAuthSessionPlan,
    prepareAuthSession,
    projectVerifiedIdentityReferences,
    validateAuthSessionResult,
    verifyAuthSession
} from '../../tools/test-fixtures/producers/auth-session-producer.mjs';
import {
    buildProducerReceipt,
    digestCanonical
} from '../../tools/test-fixtures/receipt/index.mjs';
import {
    buildFixtureVariantPlan,
    buildProducerFixtureVariantPlan,
    fixtureCatalogDigest,
    readFixtureCatalogs
} from '../../tools/testing/fixture-catalog.mjs';


const temporalContext = qualificationTemporalContext({
    sourceCommit: 'a'.repeat(40),
    sourceFingerprint: `sha256:${'b'.repeat(64)}`,
    producerId: 'auth-session',
    schedulerRunId: 'run-17',
    businessEpochUtc: '2024-02-29T23:59:59.000Z',
    locale: 'en-US',
    uiLocale: 'en-US',
    timeoutPolicyDigest: defaultTimeoutPolicyDigest()
});

function buildPlan(capabilities, identityRoleRequests = [])
{
    return buildAuthSessionPlan({
        capabilities: [...capabilities].sort(),
        namespace: 'acceptance-a',
        runId: 'run-17',
        profileId: 'auth-identity-matrix',
        catalogDigest: 'sha256:catalog-a',
        fixtureVariantPlanDigest: 'sha256:fixture-variants-a',
        producerVariantPlanDigest: 'sha256:producer-variants-a',
        temporalContext,
        identityRoleRequests
    });
}

function resultFor(plan)
{
    const entities = [];
    for (const role of plan.roles)
    {
        for (let index = 0; index < (role.sessionCount ?? 1); index++)
        {
            const fields = {
                state: role.expectedState,
                permissionCatalogDigest: role.kind === 'admin' ? 'a'.repeat(64) : undefined,
                authorizationVerified: role.kind === 'admin' ? true : undefined,
                allowedActions: role.kind === 'admin' && role.capabilityId !== 'auth.admin.disabled'
                    ? ['article.write']
                    : role.kind === 'admin' ? [] : undefined,
                deniedActions: role.kind === 'admin' ? ['article.publish'] : undefined,
                sessionIssuanceEligible: role.capabilityId === 'auth.admin.disabled' ? false : undefined,
                authorizationEligible: role.capabilityId === 'auth.admin.disabled' ? false : undefined,
                mfaEnabled: role.capabilityId === 'auth.user.mfa-enabled'
                    ? true
                    : role.capabilityId === 'auth.user.mfa-disabled' ? false : undefined,
                recoveryEnabled: role.capabilityId === 'auth.user.recovery-enabled' ? true : undefined
            };
            if (role.capabilityId === 'session.multi-device')
            {
                fields.deviceSignal = role.deviceSignals[index];
                fields.familyIdentity = role.familyIdentities[index];
                fields.live = true;
            }
            if (role.capabilityId === 'session.refresh-rotated')
            {
                Object.assign(fields, {
                    oldRefreshAccepted: false,
                    currentGeneration: 1,
                    currentPointerVerified: true
                });
            }
            if (role.capabilityId === 'auth.user.passkey-enabled')
            {
                fields.ceremony = {
                    validationBoundary: 'production-fido',
                    challengeSingleUse: true,
                    challengeConsumed: true,
                    signatureVerified: true,
                    originVerified: true,
                    rpIdVerified: true,
                    counterVerified: true
                };
            }
            entities.push({
                kind: role.kind,
                id: role.kind === 'session'
                    ? role.sessionIdentities[index]
                    : `${role.fixtureIdentity}-${index}`,
                owned: true,
                semanticRole: role.semanticRole,
                fixtureIdentity: role.fixtureIdentity,
                capabilityHint: role.capabilityId,
                fields
            });
        }
    }
    return {
        strategy: 'transaction-fixture',
        implementation: 'test-only-auth-fixture-composition-root',
        providedCapabilities: [...plan.capabilities],
        observations: {
            source: 'application-read-model',
            database: { namespace: plan.namespace, entities },
            redis: { namespace: plan.namespace, keys: [] },
            cache: { namespace: plan.namespace, entries: [] }
        },
        permissionCatalogDigest: 'a'.repeat(64),
        ceremonyEvidenceDigest: 'b'.repeat(64),
        temporalObservation: { businessEpochUtc: temporalContext.businessEpochUtc }
    };
}

test('builds independent deterministic identities for every mutually exclusive auth state', () =>
{
    const plan = buildPlan([
        'auth.user.active',
        'auth.user.deleted',
        'auth.user.mfa-enabled',
        'auth.admin.disabled',
        'auth.admin.full-permission'
    ]);
    assert.equal(plan.roles.length, 5);
    assert.equal(new Set(plan.roles.map((item) => item.fixtureIdentity)).size, 5);
    assert.equal(new Set(plan.roles.map((item) => item.semanticRole)).size, 5);
    assert.equal(buildPlan([...plan.capabilities]).planDigest, plan.planDigest);
    assert.equal(plan.profileId, 'auth-identity-matrix');
});

test('allocates consumer-requested same-capability identities under the auth-session owner', () =>
{
    const requests = Array.from({ length: 11 }, (_, index) => ({
        ownerProducerId: 'auth-session',
        consumerProducerId: 'account-profile',
        role: `profile-role-${String(index + 1).padStart(2, '0')}`,
        capabilityId: 'auth.user.active'
    }));
    const plan = buildPlan(['auth.user.active'], requests);
    assert.equal(plan.roles.length, 12);
    assert.equal(plan.identityRoleRequests.length, 11);
    assert.equal(new Set(plan.roles.map((item) => item.fixtureIdentity)).size, 12);
    assert.ok(plan.roles.slice(1).every((item) =>
        item.ownerIdentity === 'auth-session:acceptance-a:run-17'
        && item.allocationConsumerProducerId === 'account-profile'));
    assert.equal(buildPlan(['auth.user.active'], requests).planDigest, plan.planDigest);
    assert.throws(() => buildPlan(['auth.user.active'], [{
        ...requests[0],
        capabilityId: 'auth.user.passkey-enabled'
    }]), /invalid or non-identity allocation/u);
});

test('rejects security-state capabilities and missing sealed temporal context', () =>
{
    assert.throws(() => buildPlan(['security.subject.banned']), /unknown or security-owned/u);
    assert.throws(() => buildAuthSessionPlan({
        capabilities: ['auth.user.active'],
        namespace: 'a',
        runId: 'b',
        profileId: 'auth-identity-matrix',
        catalogDigest: 'sha256:catalog-a',
        fixtureVariantPlanDigest: 'sha256:fixture-variants-a',
        producerVariantPlanDigest: 'sha256:producer-variants-a'
    }), /sealed temporal context/u);
});

test('validates the complete identity, session, admin and real WebAuthn matrix', () =>
{
    const plan = buildPlan(authSessionProducerMeta.capabilities);
    const result = validateAuthSessionResult(plan, resultFor(plan));
    assert.deepEqual(result.providedCapabilities, plan.capabilities);
    assert.equal(result.entityIdentities.length, plan.roles.reduce(
        (total, item) => total + (item.sessionCount ?? 1),
        0
    ));
    const activeRef = result.identityPrepareReferences.find((item) => item.role === 'user.active');
    assert.equal(activeRef.schema, 'fsusblog.fixture-identity-prepare-reference.v1');
    assert.equal(activeRef.verified, false);
    assert.equal(activeRef.ownerProducerId, 'auth-session');
    assert.equal(activeRef.runId, 'run-17');
    assert.equal(activeRef.namespace, 'acceptance-a');
    assert.equal(activeRef.profileId, 'auth-identity-matrix');
    assert.equal(activeRef.planDigests.authSessionPlanDigest, plan.planDigest);
    assert.match(activeRef.digest, /^[a-f0-9]{64}$/u);
});

test('fails closed when multi-device sessions share a family or revoke each other', () =>
{
    const plan = buildPlan(['session.multi-device']);
    const raw = resultFor(plan);
    const entities = raw.observations.database.entities;
    entities[1].fields.familyIdentity = entities[0].fields.familyIdentity;
    assert.throws(() => validateAuthSessionResult(plan, raw), /distinct devices and families/u);
    entities[1].fields.familyIdentity = plan.roles[0].familyIdentities[1];
    entities[0].fields.live = false;
    assert.throws(() => validateAuthSessionResult(plan, raw), /two live sessions/u);
});

test('fails closed for weakened or incomplete WebAuthn evidence', () =>
{
    const plan = buildPlan(['auth.user.passkey-enabled']);
    const raw = resultFor(plan);
    raw.observations.database.entities[0].fields.ceremony.acceptAnySignature = true;
    assert.throws(() => validateAuthSessionResult(plan, raw), /weakened WebAuthn/u);

    const second = resultFor(plan);
    second.observations.database.entities[0].fields.ceremony.challengeConsumed = false;
    assert.throws(() => validateAuthSessionResult(plan, second), /challengeConsumed/u);
});

test('ordinary receipts reject tokens, recovery material, and security owner state', () =>
{
    const plan = buildPlan(['auth.user.active']);
    const token = resultFor(plan);
    token.observations.database.entities[0].fields.accessToken = 'plaintext';
    assert.throws(() => validateAuthSessionResult(plan, token), /forbidden secret field/u);

    const security = resultFor(plan);
    security.observations.database.entities[0].fields.banCleared = true;
    assert.throws(() => validateAuthSessionResult(plan, security), /security-state owner boundary/u);
});

test('profile with no auth capability never invokes the producer', async () =>
{
    let calls = 0;
    await assert.rejects(() => prepareAuthSession({
        plan: { capabilities: ['public.article.published'] },
        namespace: 'a',
        runIdentity: 'b',
        temporalContext,
        handles: { authFixtureAdapter: { prepare: async () =>
        {
            calls++;
        } } }
    }), /at least one capability/u);
    assert.equal(calls, 0);
});

test('prepare binds receipt-safe entity identities and database evidence to typed variants', async () =>
{
    const result = await prepareAuthSession({
        plan: {
            capabilities: ['auth.user.active'],
            catalogDigest: 'sha256:catalog-a',
            variantPlanDigest: 'sha256:fixture-variants-a'
        },
        namespace: 'acceptance-a',
        runIdentity: 'run-17',
        profileIdentity: { profileId: 'auth-identity-matrix' },
        variantPlan: {
            producerVariantPlanDigest: 'sha256:producer-variants-a',
            variants: [{
                id: 'auth-user-active-default',
                capabilityId: 'auth.user.active'
            }]
        },
        temporalContext,
        identityRoleRequests: [],
        handles: {
            authFixtureAdapter: {
                prepare: async ({ authFixturePlan }) => resultFor(authFixturePlan)
            }
        }
    });
    assert.deepEqual(Object.keys(result.entityIdentities[0]).sort(), [
        'id', 'kind', 'owner', 'variantId'
    ]);
    assert.equal(result.entityIdentities[0].variantId, 'auth-user-active-default');
    assert.equal(result.observations.database.entities[0].variantId, 'auth-user-active-default');
    assert.equal(result.authVerificationEntities[0].semanticRole, 'user.active');
});

test('live prepare and verify consume environment secret without persisting it', async (context) =>
{
    const originalFetch = globalThis.fetch;
    const originalBaseUrl = process.env.FSUSBLOG_BASE_URL;
    const originalSecret = process.env.FSUSBLOG_LOCAL_AUTH_FIXTURE_SECRET;
    const fixtureSecret = 'current-process-private-fixture-secret';
    process.env.FSUSBLOG_BASE_URL = 'http://127.0.0.1:5088/';
    process.env.FSUSBLOG_LOCAL_AUTH_FIXTURE_SECRET = fixtureSecret;
    context.after(() =>
    {
        globalThis.fetch = originalFetch;
        if (originalBaseUrl === undefined)
        {
            delete process.env.FSUSBLOG_BASE_URL;
        }
        else
        {
            process.env.FSUSBLOG_BASE_URL = originalBaseUrl;
        }
        if (originalSecret === undefined)
        {
            delete process.env.FSUSBLOG_LOCAL_AUTH_FIXTURE_SECRET;
        }
        else
        {
            process.env.FSUSBLOG_LOCAL_AUTH_FIXTURE_SECRET = originalSecret;
        }
    });

    globalThis.fetch = async (url, request) =>
    {
        assert.match(String(url), /^http:\/\/127\.0\.0\.1:5088\/api\/local\/auth-fixture\/(?:prepare|verify)$/u);
        assert.equal(request.headers['X-Fsus-Local-Auth-Fixture-Secret'], fixtureSecret);
        assert.doesNotMatch(request.body, new RegExp(fixtureSecret, 'u'));
        const body = JSON.parse(request.body);
        const payload = String(url).endsWith('/prepare')
            ? resultFor(body)
            : { ok: true, receiptDigest: body.receiptDigest };
        return new Response(JSON.stringify(payload), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });
    };

    const producerResult = await prepareAuthSession({
        plan: {
            capabilities: ['auth.user.active'],
            catalogDigest: 'sha256:catalog-a',
            variantPlanDigest: 'sha256:fixture-variants-a'
        },
        namespace: 'acceptance-a',
        runIdentity: 'run-17',
        profileIdentity: { profileId: 'auth-identity-matrix' },
        variantPlan: {
            producerVariantPlanDigest: 'sha256:producer-variants-a',
            variants: [{
                id: 'auth-user-active-default',
                capabilityId: 'auth.user.active'
            }]
        },
        temporalContext,
        identityRoleRequests: [],
        handles: {}
    });
    assert.doesNotMatch(JSON.stringify(producerResult), new RegExp(fixtureSecret, 'u'));
    assert.equal((await verifyAuthSession({ handles: {} }, producerResult)).ok, true);
});

test('independent verifier is mandatory and binds the exact producer result digest', async (context) =>
{
    const ingressNames = [
        'FSUSBLOG_BASE_URL',
        'FSUSBLOG_DEBUG_BACKEND_URL',
        'FSUSBLOG_LOCAL_AUTH_FIXTURE_SECRET'
    ];
    const originalIngress = Object.fromEntries(ingressNames.map((name) => [name, process.env[name]]));
    for (const name of ingressNames)
    {
        delete process.env[name];
    }
    context.after(() =>
    {
        for (const name of ingressNames)
        {
            if (originalIngress[name] === undefined)
            {
                delete process.env[name];
            }
            else
            {
                process.env[name] = originalIngress[name];
            }
        }
    });
    const plan = buildPlan(['auth.user.active']);
    const producerResult = validateAuthSessionResult(plan, resultFor(plan));
    const missing = await verifyAuthSession({ handles: {} }, producerResult);
    assert.equal(missing.ok, false);
    assert.match(missing.reason, /independent live verifier/u);

    const mismatch = await verifyAuthSession({
        handles: {
            authFixtureAdapter: {
                verify: async () => ({ ok: true, receiptDigest: '0'.repeat(64) })
            }
        }
    }, producerResult);
    assert.equal(mismatch.ok, false);

    const verified = await verifyAuthSession({
        handles: {
            authFixtureAdapter: {
                verify: async () => ({
                    ok: true,
                    receiptDigest: createHash('sha256')
                        .update(JSON.stringify(producerResult), 'utf8')
                        .digest('hex'),
                    observations: {
                        database: {
                            entities: [{ id: 'untyped-verifier-observation' }]
                        }
                    }
                })
            }
        }
    }, producerResult);
    assert.equal(verified.ok, true);
    assert.equal(verified.observations, producerResult.observations);
});

test('projects only consumer-owned requested refs after the exact ProducerReceipt is sealed', () =>
{
    const plan = buildPlan(['auth.user.active'], [{
        ownerProducerId: 'auth-session',
        consumerProducerId: 'message',
        role: 'primary-recipient',
        capabilityId: 'auth.user.active'
    }]);
    const producerResult = validateAuthSessionResult(plan, resultFor(plan));
    const catalogs = readFixtureCatalogs();
    const fixtureVariantIds = ['canonical.auth.user.active'];
    const fixtureVariantPlan = buildFixtureVariantPlan(fixtureVariantIds, catalogs);
    const producerVariantPlan = buildProducerFixtureVariantPlan({
        producerId: 'auth-session',
        variantIds: fixtureVariantIds,
        fixtureVariantIds,
        fixtureVariantPlanDigest: fixtureVariantPlan.variantPlanDigest,
        catalogs
    });
    const databaseObservation = {
        ...producerResult.observations.database,
        entities: producerResult.observations.database.entities.map((item) => ({
            ...item,
            variantId: fixtureVariantIds[0]
        }))
    };
    const producerReceipt = buildProducerReceipt({
        producerId: 'auth-session',
        strategy: 'transaction-fixture',
        runId: plan.runId,
        namespace: plan.namespace,
        fixtureCatalogDigest: fixtureCatalogDigest(catalogs),
        profileId: plan.profileId,
        expandedCapabilityDigest: digestCanonical(['auth.user.active']),
        fixtureVariantIds,
        variantPlanDigest: fixtureVariantPlan.variantPlanDigest,
        producerVariantPlanDigest: producerVariantPlan.producerVariantPlanDigest,
        producedVariantIds: fixtureVariantIds,
        providedCapabilities: ['auth.user.active'],
        ownedStateDomains: catalogs.producer.producers.find(
            (item) => item.id === 'auth-session'
        ).stateDomains,
        entityIdentities: producerResult.entityIdentities.map((item) => ({
            kind: item.kind,
            id: item.id,
            variantId: fixtureVariantIds[0]
        })),
        postconditionObservations: [{
            capabilityId: 'auth.user.active',
            postconditionId: 'user-active',
            ok: true
        }],
        databaseObservation,
        catalogs
    });
    assert.match(producerReceipt.producerReceiptDigest, /^sha256:[a-f0-9]{64}$/u);
    const reorderedResult = {
        ...producerResult,
        identityPrepareReferences: Object.freeze([
            ...producerResult.identityPrepareReferences
        ].reverse())
    };
    const projection = projectVerifiedIdentityReferences({
        producerResult: reorderedResult,
        producerReceipt,
        consumerProducerId: 'message'
    });
    assert.equal(projection.schema, 'fsusblog.fixture-identity-references.v1');
    assert.equal(projection.verified, true);
    assert.equal(projection.references.length, 1);
    assert.equal(projection.references[0].role, 'primary-recipient');
    assert.equal(
        projection.references[0].sourceReceiptDigest,
        producerReceipt.producerReceiptDigest
    );
    assert.equal(projection.references[0].ownerProducerId, 'auth-session');

    const tamperedResult = {
        ...reorderedResult,
        identityPrepareReferences: reorderedResult.identityPrepareReferences.map((item) =>
            item.consumerProducerId === 'message' ? { ...item, publicId: 'tampered' } : item)
    };
    assert.throws(() => projectVerifiedIdentityReferences({
        producerResult: tamperedResult,
        producerReceipt,
        consumerProducerId: 'message'
    }), /not bound to the sealed receipt/u);
});

test('static governance keeps the unique producer out of DB, Redis, JWT, legacy, and security-owner paths', () =>
{
    const source = readFileSync(
        new URL('../../tools/test-fixtures/producers/auth-session-producer.mjs', import.meta.url),
        'utf8'
    );
    for (const forbidden of [
        /node:child_process/u,
        /\b(?:psql|redis-cli|pg_dump)\b/u,
        /\b(?:createHmac|jsonwebtoken|jwt\.sign)\b/u,
        /prepare-auth-smoke-users/u,
        /session-fixtures\.mjs/u,
        /\b(?:banCleared|riskReset|credentialIssuanceDeleted)\b/u
    ])
    {
        assert.doesNotMatch(source, forbidden);
    }
    const producerDeclaration = new RegExp(
        ['fixture-catalog:', 'producer', 'auth-session'].join(' '),
        'gu'
    );
    assert.equal((source.match(producerDeclaration) ?? []).length, 1);

    const seeder = readFileSync(
        new URL('../../src/backend/Services/Fixtures/AuthFixtureSeeder.cs', import.meta.url),
        'utf8'
    );
    assert.match(seeder, /AdminPermissions\.All/u);
    assert.match(seeder, /controlled WebAuthn authenticator is unavailable/u);
    assert.doesNotMatch(seeder, /ISqlSugarClient|\.Insertable<|\.Updateable<|\.Deleteable<|\.Ado\b/u);
    assert.doesNotMatch(seeder, /acceptAny|RevokeAllSessions|RevokeOtherSessions/u);
    assert.doesNotMatch(seeder, /BanReason\s*==|RiskFlags\s*==|Blacklist/u);
    assert.match(seeder, /AccountSubjectHash/u);
    assert.doesNotMatch(seeder, /user\.PublicHandle\s*,\s*entity\.FixtureIdentity/u);

    for (const servicePath of [
        '../../src/backend/Services/UserService.cs',
        '../../src/backend/Services/Security/PasskeyService.cs',
        '../../src/backend/Services/Security/RecoveryKeyService.cs'
    ])
    {
        const service = readFileSync(new URL(servicePath, import.meta.url), 'utf8');
        assert.match(service, /TimeProvider/u);
        assert.doesNotMatch(service, /DateTime\.(?:Now|UtcNow)/u);
    }

    const lifecycleRepository = readFileSync(
        new URL(
            '../../src/backend/Infrastructure/Testing/SqlSugarAuthFixtureLifecycleRepository.cs',
            import.meta.url
        ),
        'utf8'
    );
    assert.doesNotMatch(
        lifecycleRepository,
        /BanReason|RiskFlags|CredentialIssuance|Blacklist|RevokeAll/u
    );

    const runtimeRegistration = readFileSync(
        new URL('../../src/backend/Infrastructure/Bootstrap/RuntimeDomainServiceCollectionExtensions.cs', import.meta.url),
        'utf8'
    );
    assert.doesNotMatch(runtimeRegistration, /IAuthFixtureSeeder/u);
    const program = readFileSync(new URL('../../src/backend/Program.cs', import.meta.url), 'utf8');
    assert.match(
        program,
        /builder\.Environment\.IsDevelopment\(\)[\s\S]*IAuthFixtureSeeder[\s\S]*IAuthFixtureLifecycleRepository/u
    );
});
