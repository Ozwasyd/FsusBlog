import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

const {defaultTimeoutPolicyDigest, qualificationTemporalContext} = await import(new URL('../../tools/test/temporal-context.mjs', import.meta.url));
const {buildMessagingFixturePlan, cleanupAccountMessaging, prepareAccountMessaging, resolveMessagingIdentityReferences, verifyAccountMessaging} = await import(new URL('../../tools/test-fixtures/producers/account-messaging-producer.mjs', import.meta.url));
const {buildProducerReceipt, digestCanonical} = await import(new URL('../../tools/test-fixtures/receipt/index.mjs', import.meta.url));
const {buildFixtureVariantPlan, buildProducerFixtureVariantPlan, fixtureCatalogDigest, readFixtureCatalogs} = await import(new URL('../../tools/testing/fixture-catalog.mjs', import.meta.url));
const digest = (character) => `sha256:${character.repeat(64)}`;
const temporalArtifact = Object.freeze({
    schema: 'fsusblog.resolved-temporal-roles.v1',
    contentDigest: digest('a'),
    shape: {
        id: 'auth-security-messaging-account-lifecycle'
    },
    roles: [
        {
            roleId: 'message-single-created',
            instantUtc: '2042-05-17T09:30:00.000Z',
            digest: digest('b')
        }
    ]
});
const temporalResolver = Object.freeze({
    resolveTemporalRoles: async () => temporalArtifact,
    verifyResolvedTemporalArtifact: async (artifact) => ({ ok: artifact === temporalArtifact })
});
const stableHexDigest = (value) => createHash('sha256')
    .update(JSON.stringify(value), 'utf8')
    .digest('hex');

function authSessionResult(runId = 'message-test-run', namespace = 'message-test-ns')
{
    const producerResultDigest = 'c'.repeat(64);
    const specs = [
        ['primary-recipient', 'auth.user.active', '101'],
        ['secondary-recipient', 'auth.user.active', '102'],
        ['empty-recipient', 'auth.user.active', '103'],
        ['admin', 'auth.admin.full-permission', '7']
    ];
    const identityPrepareReferences = specs.map(([role, capabilityId, publicId]) =>
    {
        const body = {
            schema: 'fsusblog.fixture-identity-prepare-reference.v1',
            verified: false,
            ownerProducerId: 'auth-session',
            consumerProducerId: 'account-messaging',
            runId,
            namespace,
            profileId: 'account-messaging',
            role,
            semanticRole: `consumer.account-messaging.${role}`,
            capabilityId,
            publicId,
            fixtureIdentity: `fixture-${role}`,
            producerResultDigest,
            planDigests: {
                authSessionPlanDigest: 'a'.repeat(64),
                catalogDigest: 'b'.repeat(64),
                fixtureVariantPlanDigest: 'c'.repeat(64),
                producerVariantPlanDigest: 'd'.repeat(64)
            }
        };
        return Object.freeze({ ...body, digest: stableHexDigest(body) });
    });
    return Object.freeze({
        producerId: 'auth-session',
        producerResultDigest,
        identityPrepareReferences: Object.freeze(identityPrepareReferences)
    });
}

function authSessionReceipt(result)
{
    const catalogs = readFixtureCatalogs();
    const fixtureVariantIds = [
        'canonical.auth.admin.full-permission',
        'canonical.auth.user.active'
    ];
    const fixturePlan = buildFixtureVariantPlan(fixtureVariantIds, catalogs);
    const producerPlan = buildProducerFixtureVariantPlan({
        producerId: 'auth-session',
        variantIds: fixtureVariantIds,
        fixtureVariantIds,
        fixtureVariantPlanDigest: fixturePlan.variantPlanDigest,
        catalogs
    });
    const variantFor = (item) => item.capabilityId === 'auth.admin.full-permission'
        ? 'canonical.auth.admin.full-permission'
        : 'canonical.auth.user.active';
    const databaseObservation = {
        namespace: result.identityPrepareReferences[0].namespace,
        entities: result.identityPrepareReferences.map((item) => ({
            kind: item.capabilityId === 'auth.admin.full-permission' ? 'admin' : 'user',
            id: item.publicId,
            semanticRole: item.semanticRole,
            variantId: variantFor(item),
            fields: { status: 'active' }
        }))
    };
    return buildProducerReceipt({
        producerId: 'auth-session',
        strategy: 'transaction-fixture',
        runId: result.identityPrepareReferences[0].runId,
        namespace: result.identityPrepareReferences[0].namespace,
        profileId: result.identityPrepareReferences[0].profileId,
        fixtureCatalogDigest: fixtureCatalogDigest(catalogs),
        expandedCapabilityDigest: digestCanonical([
            'auth.admin.full-permission',
            'auth.user.active'
        ]),
        fixtureVariantIds,
        variantPlanDigest: fixturePlan.variantPlanDigest,
        producerVariantPlanDigest: producerPlan.producerVariantPlanDigest,
        producedVariantIds: fixtureVariantIds,
        providedCapabilities: ['auth.admin.full-permission', 'auth.user.active'],
        ownedStateDomains: catalogs.producer.producers.find(
            (item) => item.id === 'auth-session'
        ).stateDomains,
        entityIdentities: result.identityPrepareReferences.map((item) => ({
            kind: item.capabilityId === 'auth.admin.full-permission' ? 'admin' : 'user',
            id: item.publicId,
            variantId: variantFor(item)
        })),
        postconditionObservations: [
            {
                capabilityId: 'auth.admin.full-permission',
                postconditionId: 'admin-full-permission',
                ok: true
            },
            {
                capabilityId: 'auth.user.active',
                postconditionId: 'user-active',
                ok: true
            }
        ],
        databaseObservation,
        catalogs
    });
}

function baseContext(adapter)
{
    const identityResult = authSessionResult();
    return {
        namespace: 'message-test-ns',
        runIdentity: 'message-test-run',
        plan: {
            capabilities: ['messages.thread', 'notifications.unread']
        },
        variantPlan: {
            producerId: 'account-messaging',
            producerVariantPlanDigest: digest('variant-plan'),
            variants: [
                { id: 'canonical.messages.thread', capabilityId: 'messages.thread' },
                { id: 'canonical.notifications.unread', capabilityId: 'notifications.unread' }
            ]
        },
        profileIdentity: {
            profileId: 'account-messaging'
        },
        temporalContext: qualificationTemporalContext({
            sourceCommit: 'a'.repeat(40),
            sourceFingerprint: digest('b'),
            producerId: 'account-messaging',
            schedulerRunId: 'message-test-run',
            businessEpochUtc: '2024-02-29T23:59:59.000Z',
            locale: 'en-US',
            uiLocale: 'en-US',
            timeoutPolicyDigest: defaultTimeoutPolicyDigest()
        }),
        producerOutputs: {
            'auth-session': identityResult
        },
        producerReceipts: {
            'auth-session': authSessionReceipt(identityResult)
        },
        handles: {
            accountMessagingAdapter: adapter
        }
    };
}

function buildRaw(plan, overrides = {})
{
    const namespace = plan.namespace;
    const capabilityProofs = plan.capabilities.map((capabilityId) => ({
        capabilityId,
        status: 'verified',
        database: 'exact',
        api: 'exact',
        stream: capabilityId.startsWith('notifications.') ? 'exact' : 'not-applicable'
    }));
    return {
        producerId: 'account-messaging',
        strategy: 'transaction-fixture',
        planDigest: plan.planDigest,
        inventoryDigest: plan.inventoryDigest,
        ownershipDigest: plan.ownershipDigest,
        temporalObservation: {
            businessEpochUtc: '2024-02-29T23:59:59.000Z',
            backendCulture: 'Invariant',
            postgresTimezone: 'UTC'
        },
        capabilityProofs,
        entityIdentities: [
            { kind: 'thread', id: '7001', semanticRole: 'single-thread' },
            { kind: 'message', id: '8001', semanticRole: 'single-message', contentDigest: digest('e') }
        ],
        observations: {
            database: {
                namespace,
                entities: [{ kind: 'thread', id: '7001', fields: { unreadCount: 1 } }]
            },
            redis: {
                namespace,
                keys: [{ domain: 'redis.notification', keyDigest: digest('f'), present: true }]
            },
            cache: {
                namespace,
                entries: [{ domain: 'message-unread', generation: '2', matchesDb: true }]
            }
        },
        cleanupReceipt: {
            schema: 'fsusblog.messaging-fixture-cleanup.v1',
            planDigest: plan.planDigest,
            runId: plan.runId,
            namespace: plan.namespace,
            ownedEntityIds: ['7001', '8001'],
            conversationIds: ['7001'],
            messageIds: ['8001'],
            eventIds: ['9001'],
            deliveryKeys: ['fixture-delivery-9001']
        },
        ...overrides
    };
}

test('account-messaging builds a full deterministic matrix from legacy coarse capabilities', async () =>
{
    const context = baseContext(null);
    const plan = buildMessagingFixturePlan(context, {
        identityReferences: resolveMessagingIdentityReferences(context),
        temporalRoles: temporalArtifact
    });
    assert.equal(plan.capabilities.length, 13);
    assert.equal(plan.semanticRoles.length, 13);
    assert.match(plan.planDigest, /^sha256:[a-f0-9]{64}$/u);
});

test('account-messaging prepares, independently verifies, and exactly cleans owned entities', async () =>
{
    let cleaned = null;
    const adapter = {
        prepare: async ({ messagingPlan }) => buildRaw(messagingPlan),
        verify: async (_context, result) => ({ ok: result.capabilityProofs.every((item) => item.status === 'verified'), warnings: [] }),
        cleanup: async (_context, receipt) =>
        {
            cleaned = receipt;
        }
    };
    const context = baseContext(adapter);
    const result = await prepareAccountMessaging(context, undefined, { temporalResolver });
    assert.equal(result.capabilities.length, 13);
    assert.equal(result.capabilityProofs.length, 13);
    assert.match(result.contentDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.deepEqual(result.entityIdentities, [
        { kind: 'thread', id: '7001', variantId: 'canonical.messages.thread' },
        {
            kind: 'message',
            id: '8001',
            variantId: 'canonical.messages.thread',
            digest: digest('e')
        }
    ]);
    const verification = await verifyAccountMessaging(context, result);
    assert.equal(verification.ok, true, verification.reason);
    assert.equal(verification.producerId, 'account-messaging');
    assert.match(verification.identitySourceReceiptDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.match(verification.identityReferencesDigest, /^[a-f0-9]{64}$/u);
    assert.deepEqual(verification.warnings, []);
    await cleanupAccountMessaging(context, result);
    assert.deepEqual(cleaned.ownedEntityIds, ['7001', '8001']);

    await cleanupAccountMessaging(context, {
        schema: 'fsusblog.fixture-producer-receipt.v1',
        producerId: 'account-messaging',
        entityIdentities: result.entityIdentities,
        cleanupContract: result.cleanupContract
    });
    assert.deepEqual(cleaned.conversationIds, ['7001']);
});

test('account-messaging consumes the canonical temporal resolver without a local fallback', async () =>
{
    let capturedPlan = null;
    const context = baseContext({
        prepare: async ({ messagingPlan }) =>
        {
            capturedPlan = messagingPlan;
            return buildRaw(messagingPlan, {
                temporalObservation: {
                    businessEpochUtc: '2042-05-17T09:30:00.000Z',
                    backendCulture: 'Invariant',
                    postgresTimezone: 'UTC'
                }
            });
        }
    });
    context.temporalContext = qualificationTemporalContext({
        sourceCommit: 'a'.repeat(40),
        sourceFingerprint: digest('b'),
        producerId: 'account-messaging',
        schedulerRunId: context.runIdentity,
        businessEpochUtc: '2042-05-17T09:30:00.000Z',
        locale: 'en-US',
        uiLocale: 'en-US',
        timeoutPolicyDigest: defaultTimeoutPolicyDigest()
    });

    const result = await prepareAccountMessaging(context);

    assert.equal(capturedPlan.temporalRoles.shape.id, 'auth-security-messaging-account-lifecycle');
    assert.equal(result.temporalRoleArtifactDigest, capturedPlan.temporalRoles.contentDigest);
    assert.equal(capturedPlan.temporalRoles.fixtureIdentity.fixtureId, 'account-messaging');
});

test('account-messaging rejects missing or drifting backend and database observations', async () =>
{
    for (const field of ['businessEpochUtc', 'backendCulture', 'postgresTimezone'])
    {
        for (const missing of [true, false])
        {
            const context = baseContext({
                prepare: async ({ messagingPlan }) =>
                {
                    const raw = buildRaw(messagingPlan);
                    if (missing)
                    {
                        delete raw.temporalObservation[field];
                    }
                    else
                    {
                        raw.temporalObservation[field] = field === 'businessEpochUtc'
                            ? '2030-01-01T00:00:00.000Z'
                            : 'drifting-runtime-setting';
                    }
                    return raw;
                }
            });
            await assert.rejects(prepareAccountMessaging(context, undefined, { temporalResolver }),
                missing ? /requires actual/u : /observation does not match planned temporal context/u);
        }
    }
});

test('account-messaging HTTP preparation binds the protected backend session observation', async (testContext) =>
{
    const originalFetch = globalThis.fetch;
    testContext.after(() =>
    {
        globalThis.fetch = originalFetch;
    });
    const context = baseContext(undefined);
    context.handles = {
        baseUrl: 'http://127.0.0.1:5088/',
        localAuthFixtureSecret: 'controlled-temporal-secret',
        localMessagingFixtureSecret: 'controlled-messaging-secret'
    };
    const paths = [];
    globalThis.fetch = async (url, request) =>
    {
        const endpoint = new URL(url).pathname;
        paths.push(endpoint);
        if (endpoint === '/api/local/messaging-fixture/prepare')
        {
            assert.equal(request.headers['X-Fsus-Local-Messaging-Fixture-Secret'], 'controlled-messaging-secret');
            return new Response(JSON.stringify(buildRaw(JSON.parse(request.body), {
                temporalObservation: {
                    businessEpochUtc: '2024-02-29T23:59:59.000Z',
                    resolvedTemporalRoleArtifactDigest: temporalArtifact.contentDigest
                }
            })), { status: 200 });
        }
        assert.equal(endpoint, '/__local/temporal-observation');
        assert.equal(request.headers['X-Fsus-Local-Temporal-Fixture-Secret'], 'controlled-temporal-secret');
        return new Response(JSON.stringify({
            businessEpochUtc: '2024-02-29T23:59:59.000Z',
            backendCulture: 'Invariant',
            postgresTimezone: 'UTC',
            observationBoundary: 'backend-and-postgres-session'
        }), { status: 200 });
    };
    const result = await prepareAccountMessaging(context, undefined, { temporalResolver });
    assert.deepEqual(paths, ['/api/local/messaging-fixture/prepare', '/__local/temporal-observation']);
    assert.equal(result.temporalObservation.postgresTimezone, 'UTC');
    assert.equal(result.temporalObservation.resolvedTemporalRoleArtifactDigest, temporalArtifact.contentDigest);
});

test('account-messaging reruns idempotently and parallel namespaces clean only receipt-owned entities', async () =>
{
    const cleaned = [];
    const makeContext = (suffix) =>
    {
        const context = baseContext({
            prepare: async ({ messagingPlan }) => buildRaw(messagingPlan, {
                entityIdentities: [
                    { kind: 'thread', id: `${suffix}-7001`, semanticRole: 'single-thread' },
                    { kind: 'message', id: `${suffix}-8001`, semanticRole: 'single-message', contentDigest: digest(suffix) }
                ],
                cleanupReceipt: {
                    schema: 'fsusblog.messaging-fixture-cleanup.v1',
                    planDigest: messagingPlan.planDigest,
                    runId: messagingPlan.runId,
                    namespace: messagingPlan.namespace,
                    ownedEntityIds: [`${suffix}-7001`, `${suffix}-8001`]
                }
            }),
            cleanup: async ({ namespace }, receipt) => cleaned.push({ namespace, ids: receipt.ownedEntityIds })
        });
        context.namespace = `message-test-${suffix}`;
        context.runIdentity = `message-run-${suffix}`;
        const identityResult = authSessionResult(context.runIdentity, context.namespace);
        context.producerOutputs['auth-session'] = identityResult;
        context.producerReceipts['auth-session'] = authSessionReceipt(identityResult);
        return context;
    };
    const contextA = makeContext('a');
    const contextB = makeContext('b');
    const [firstA, resultB] = await Promise.all([
        prepareAccountMessaging(contextA, undefined, { temporalResolver }),
        prepareAccountMessaging(contextB, undefined, { temporalResolver })
    ]);
    const secondA = await prepareAccountMessaging(contextA, undefined, { temporalResolver });

    assert.equal(firstA.planDigest, secondA.planDigest);
    assert.deepEqual(firstA.cleanupReceipt, secondA.cleanupReceipt);
    await Promise.all([
        cleanupAccountMessaging(contextA, secondA),
        cleanupAccountMessaging(contextB, resultB)
    ]);
    assert.deepEqual(cleaned.sort((left, right) => left.namespace.localeCompare(right.namespace)), [
        { namespace: 'message-test-a', ids: ['a-7001', 'a-8001'] },
        { namespace: 'message-test-b', ids: ['b-7001', 'b-8001'] }
    ]);
});

test('account-messaging rejects projection mismatch, payload leaks, and duplicate identities', async () =>
{
    const mismatch = baseContext({
        prepare: async ({ messagingPlan }) =>
        {
            const raw = buildRaw(messagingPlan);
            raw.capabilityProofs[0].api = 'mismatch';
            return raw;
        }
    });
    await assert.rejects(
        prepareAccountMessaging(mismatch, undefined, { temporalResolver }),
        /incomplete projection parity/u
    );

    const leak = baseContext({
        prepare: async ({ messagingPlan }) => buildRaw(messagingPlan, { body: 'private message' })
    });
    await assert.rejects(
        prepareAccountMessaging(leak, undefined, { temporalResolver }),
        /leaks forbidden/u
    );

    const duplicateIdentityContext = baseContext(null);
    const duplicateResult = duplicateIdentityContext.producerOutputs['auth-session'];
    duplicateIdentityContext.producerOutputs['auth-session'] = {
        ...duplicateResult,
        identityPrepareReferences: duplicateResult.identityPrepareReferences.map((item) =>
        {
            if (item.role !== 'empty-recipient')
            {
                return item;
            }
            // eslint-disable-next-line no-unused-vars
            const { digest: _digest, ...body } = item;
            const changed = { ...body, publicId: '101' };
            return { ...changed, digest: stableHexDigest(changed) };
        })
    };
    await assert.rejects(
        prepareAccountMessaging(duplicateIdentityContext, undefined, { temporalResolver }),
        /must be distinct/u
    );
});

test('account-messaging rejects missing sealed temporal authority and inexact cleanup', async () =>
{
    const context = baseContext({ prepare: async () => null });
    context.temporalContext = null;
    await assert.rejects(
        prepareAccountMessaging(context, undefined, { temporalResolver }),
        /sealed business temporal context/u
    );
    await assert.rejects(
        cleanupAccountMessaging(baseContext({}), { producerId: 'account-messaging' }),
        /exact prepare cleanup receipt/u
    );
});

test('C2 unit model rejects an injected messaging adapter without an independent verifier', async () =>
{
    const context = baseContext({ prepare: async ({ messagingPlan }) => buildRaw(messagingPlan) });
    const result = await prepareAccountMessaging(context, undefined, { temporalResolver });
    const verification = await verifyAccountMessaging(context, result);
    assert.equal(verification.ok, false);
    assert.match(verification.reason, /independent.*verif/u);
});

test('C2 unit model cannot verify prepare observations without the live gateway', async () =>
{
    const context = baseContext({ prepare: async ({ messagingPlan }) => buildRaw(messagingPlan) });
    const result = await prepareAccountMessaging(context, undefined, { temporalResolver });
    context.handles.accountMessagingAdapter = null;
    const verification = await verifyAccountMessaging(context, result);
    assert.equal(verification.ok, false);
    assert.match(verification.reason, /composition root|binding|source/u);
});

test('C2 readonly cache source port is distinct from the production recovery path', async () =>
{
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../../src/backend/Infrastructure/Cache/MessageCacheService.cs', import.meta.url), 'utf8');
    assert.match(source, /ReadUnreadAsync\(long accountId, CancellationToken cancellationToken/u);
    const read = source.slice(source.indexOf('public async ValueTask<int> ReadUnreadAsync'), source.indexOf('public async ValueTask<int> GetUnreadOrRecoverAsync'));
    assert.match(read, /stringReader.GetStringAsync\(CachePolicyId.MessageUnread, BuildAccountIdentity\(accountId\), cancellationToken\)/u);
    assert.doesNotMatch(read, /RefreshUnread|Increment|compareExchange|stringWriter/u);
});

// HTTP/receipt unit models below are transport controls, not PG/Redis runtime qualification.
async function c2HttpUnitModel()
{
    let preparedRaw;
    const context = baseContext({
        prepare: async ({ messagingPlan }) =>
        {
            preparedRaw = buildRaw(messagingPlan);
            preparedRaw.temporalObservation.businessEpochUtc = '2042-05-17T09:30:00.000Z';
            preparedRaw.capabilityProofs = preparedRaw.capabilityProofs.map((proof) => ({ ...proof, cache: 'exact', outbox: 'exact' }));
            preparedRaw.observations.database.entities[0].semanticRole = 'single-thread';
            return preparedRaw;
        }
    });
    context.sourceIdentity = { commit: 'a'.repeat(40), worktreeFingerprint: digest('b') };
    context.handles.serviceGeneration = digest('c');
    const auth = context.producerReceipts['auth-session'];
    const unsigned = { ...auth, source: context.sourceIdentity, serviceGeneration: context.handles.serviceGeneration };
    delete unsigned.producerReceiptDigest;
    context.producerReceipts['auth-session'] = { ...unsigned, producerReceiptDigest: digestCanonical(unsigned) };
    Object.assign(context.plan, {
        catalogDigest: auth.fixtureCatalogDigest,
        expandedCapabilityDigest: auth.expandedCapabilityDigest,
        variantPlanDigest: auth.variantPlanDigest
    });
    context.variantPlan.producerVariantPlanDigest = digest('e');
    context.temporalContext = qualificationTemporalContext({
        sourceCommit: context.sourceIdentity.commit,
        sourceFingerprint: context.sourceIdentity.worktreeFingerprint,
        producerId: 'account-messaging',
        schedulerRunId: context.runIdentity,
        businessEpochUtc: '2042-05-17T09:30:00.000Z',
        locale: 'en-US',
        uiLocale: 'en-US',
        timeoutPolicyDigest: defaultTimeoutPolicyDigest()
    });
    const result = await prepareAccountMessaging(context);
    context.handles.accountMessagingAdapter = null;
    context.handles.baseUrl = 'http://c2-unit-model.invalid';
    context.handles.localMessagingFixtureSecret = 'unit-model-secret-not-runtime';
    return { context, result, preparedRaw };
}

async function withC2UnitFetch(fetchPort, action)
{
    const original = globalThis.fetch;
    globalThis.fetch = fetchPort;
    try
    {
        return await action();
    }
    finally
    {
        globalThis.fetch = original;
    }
}

function c2UnitRead(request, raw)
{
    return { ok: true, binding: request.binding, authSourceReceiptDigest: request.authReference.receipt.producerReceiptDigest,
        result: structuredClone(raw), warnings: [] };
}

test('C2 actual Node verify path consumes a fresh independent HTTP read and bound auth projection', async () =>
{
    const { context, result, preparedRaw } = await c2HttpUnitModel();
    const controller = new AbortController();
    let calls = 0;
    const verification = await withC2UnitFetch(async (url, options) =>
    {
        calls++;
        assert.equal(url, 'http://c2-unit-model.invalid/api/local/messaging-fixture/verify');
        assert.equal(options.signal, controller.signal);
        assert.equal(options.headers['X-Fsus-Test-Namespace'], context.namespace);
        assert.equal(options.headers['X-Fsus-Test-Run-Id'], context.runIdentity);
        const request = JSON.parse(options.body);
        assert.equal(request.binding.sourceCommit, context.sourceIdentity.commit);
        assert.equal(request.binding.sourceFingerprint, context.sourceIdentity.worktreeFingerprint);
        assert.equal(request.binding.serviceGeneration, context.handles.serviceGeneration);
        assert.equal(request.binding.temporalContextDigest, digestCanonical(context.temporalContext));
        assert.equal(request.plan.temporalRoles.contextIdentity.contextDigest, request.binding.temporalContextDigest);
        assert.deepEqual(request.roles, { 'single-thread': '7001' });
        assert.equal(request.verifiedAuthReferences.verified, true);
        assert.equal(request.verifiedAuthReferences.consumerProducerId, 'account-messaging');
        assert.deepEqual(request.cleanupReceipt, result.cleanupReceipt);
        return new Response(JSON.stringify(c2UnitRead(request, preparedRaw)));
    }, () => verifyAccountMessaging(context, result, controller.signal));
    assert.equal(calls, 1);
    assert.equal(verification.ok, true, verification.reason);
    assert.match(verification.readObservationDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.deepEqual(verification.observations, result.observations);
});

for (const field of ['source', 'generation', 'run', 'namespace', 'profile', 'catalog', 'capability', 'variant', 'temporal', 'producerVariant'])
{
    test(`C2 unit model rejects current ${field} drift before any live read`, async () =>
    {
        const { context, result } = await c2HttpUnitModel();
        switch (field)
        {
            case 'source':
                context.sourceIdentity.commit = 'f'.repeat(40);
                break;
            case 'generation':
                context.handles.serviceGeneration = digest('f');
                break;
            case 'run':
                context.runIdentity = 'other-run';
                break;
            case 'namespace':
                context.namespace = 'other-ns';
                break;
            case 'profile':
                context.profileIdentity.profileId = 'other-profile';
                break;
            case 'catalog':
                context.plan.catalogDigest = digest('f');
                break;
            case 'capability':
                context.plan.expandedCapabilityDigest = digest('f');
                break;
            case 'variant':
                context.plan.variantPlanDigest = digest('f');
                break;
            case 'temporal':
                context.temporalContext = { ...context.temporalContext, sourceCommit: 'f'.repeat(40) };
                break;
            default:
                context.variantPlan.producerVariantPlanDigest = 'invalid';
                break;
        }
        let calls = 0;
        const verification = await withC2UnitFetch(async () =>
        {
            calls++;
            throw new Error('must not fetch');
        },
        () => verifyAccountMessaging(context, result));
        assert.equal(verification.ok, false);
        assert.equal(calls, 0);
    });
}

for (const mutation of ['prepared-only', 'warning', 'structural', 'fallback', 'binding', 'auth-digest', 'cleanup',
    'cache-missing', 'cache-drift', 'cache-proof', 'db-drift', 'stream-drift', 'outbox-proof', 'count-only', 'payload', 'owner', 'empty',
    'temporal-clock-missing', 'temporal-epoch-drift'])
{
    test(`C2 unit model rejects independent ${mutation} evidence instead of repairing or accepting prepare`, async () =>
    {
        const { context, result, preparedRaw } = await c2HttpUnitModel();
        let calls = 0;
        const verification = await withC2UnitFetch(async (_url, options) =>
        {
            calls++;
            const request = JSON.parse(options.body);
            const read = c2UnitRead(request, preparedRaw);
            switch (mutation)
            {
                case 'temporal-clock-missing':
                    delete read.result.temporalObservation;
                    break;
                case 'temporal-epoch-drift':
                    read.result.temporalObservation.businessEpochUtc = '2024-02-29T23:59:59.000Z';
                    break;
                case 'prepared-only':
                    delete read.ok;
                    break;
                case 'warning':
                    read.warnings = ['drift'];
                    break;
                case 'structural':
                    read.structuralOnly = true;
                    break;
                case 'fallback':
                    read.fallback = true;
                    break;
                case 'binding':
                    read.binding.sourceCommit = 'f'.repeat(40);
                    break;
                case 'auth-digest':
                    read.authSourceReceiptDigest = digest('f');
                    break;
                case 'cleanup':
                    read.result.cleanupReceipt.eventIds = ['9002'];
                    break;
                case 'cache-missing':
                    delete read.result.observations.cache;
                    break;
                case 'cache-drift':
                    read.result.observations.cache.entries[0].generation = '3';
                    break;
                case 'db-drift':
                    read.result.observations.database.entities[0].fields.unreadCount = 2;
                    break;
                case 'stream-drift':
                    read.result.observations.redis.keys[0].keyDigest = digest('a');
                    break;
                case 'outbox-proof':
                    read.result.capabilityProofs[0].outbox = 'mismatch';
                    break;
                case 'cache-proof':
                    read.result.capabilityProofs[0].cache = 'mismatch';
                    break;
                case 'count-only':
                    read.result.capabilityProofs[0].observed = 'count-only';
                    break;
                case 'payload':
                    read.result.notificationPayload = 'must-not-publish';
                    break;
                case 'owner':
                    read.result.producerId = 'other-owner';
                    break;
                default: return new Response('');
            }
            return new Response(JSON.stringify(read));
        }, () => verifyAccountMessaging(context, result));
        assert.equal(verification.ok, false);
        assert.equal(calls, 1);
    });
}

test('C2 HTTP failure does not publish private diagnostics or invoke recovery', async () =>
{
    const { context, result } = await c2HttpUnitModel();
    let calls = 0;
    const verification = await withC2UnitFetch(async () =>
    {
        calls++;
        return new Response(JSON.stringify({ detail: 'unit-private-value-never-published' }), { status: 400 });
    }, () => verifyAccountMessaging(context, result));
    assert.equal(verification.ok, false);
    assert.match(verification.reason, /HTTP 400/u);
    assert.doesNotMatch(JSON.stringify(verification), /unit-private-value/u);
    assert.equal(calls, 1);
});

test('C2 actual default catalog port transfers cancellation and rejects a late ignored cancel', async () =>
{
    const { createAccountMessagingPort } = await import(new URL('../../tools/test-fixtures/producers/catalog-ports.mjs', import.meta.url));
    const { context, result, preparedRaw } = await c2HttpUnitModel();
    const controller = new AbortController();
    const first = new Error('original-c2-cancellation');
    await withC2UnitFetch(async (_url, options) =>
    {
        assert.equal(options.signal, controller.signal);
        const read = c2UnitRead(JSON.parse(options.body), preparedRaw);
        controller.abort(first);
        return new Response(JSON.stringify(read));
    }, async () => assert.rejects(createAccountMessagingPort().verify(context, result, controller.signal),
        (error) => error === first));
});

test('C2 actual fetch signal is cancelled with original failure; no retry or post-abort green', async () =>
{
    const { context, result } = await c2HttpUnitModel();
    const controller = new AbortController();
    const first = new Error('abort-during-c2-fetch');
    let cancelled = false;
    let calls = 0;
    await withC2UnitFetch((_url, options) => new Promise((_resolve, reject) =>
    {
        calls++;
        assert.equal(options.signal, controller.signal);
        options.signal.addEventListener('abort', () =>
        {
            cancelled = true;
            reject(options.signal.reason);
        }, { once: true });
        controller.abort(first);
    }), async () => assert.rejects(verifyAccountMessaging(context, result, controller.signal), (error) => error === first));
    assert.equal(cancelled, true);
    assert.equal(calls, 1);
    await withC2UnitFetch(async () =>
    {
        calls++;
        throw new Error('unexpected post-abort fetch');
    },
    async () => assert.rejects(verifyAccountMessaging(context, result, controller.signal), (error) => error === first));
    assert.equal(calls, 1);
});
