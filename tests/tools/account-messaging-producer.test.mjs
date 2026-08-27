import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
    defaultTimeoutPolicyDigest,
    qualificationTemporalContext
} from '../../tools/test/temporal-context.mjs';
import {
    buildMessagingFixturePlan,
    cleanupAccountMessaging,
    prepareAccountMessaging,
    resolveMessagingIdentityReferences,
    verifyAccountMessaging
} from '../../tools/test-fixtures/producers/account-messaging-producer.mjs';
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
        temporalContext: {
            schema: 'fsusblog.temporal-context.v1',
            digest: digest('d')
        },
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
    assert.equal(verification.ok, true);
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
            return buildRaw(messagingPlan);
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
