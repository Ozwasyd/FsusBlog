import assert from 'node:assert/strict';
import test from 'node:test';

import {
    defaultTimeoutPolicyDigest,
    qualificationTemporalContext
} from '../../tools/test/temporal-context.mjs';
import {
    buildMessagingFixturePlan,
    cleanupAccountMessaging,
    prepareAccountMessaging,
    verifyAccountMessaging
} from '../../tools/test-fixtures/producers/account-messaging-producer.mjs';

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
const identityReferences = Object.freeze({
    schema: 'fsusblog.fixture-identity-references.v1',
    sourceReceiptDigest: digest('c'),
    roles: {
        'primary-recipient': { accountId: 101 },
        'secondary-recipient': { accountId: 102 },
        'empty-recipient': { accountId: 103 },
        admin: { adminId: 7, sessionAuditReference: 'sha256-admin-session-audit' }
    }
});

function baseContext(adapter)
{
    return {
        namespace: 'message-test-ns',
        runIdentity: 'message-test-run',
        plan: {
            capabilities: ['messages.thread', 'notifications.unread']
        },
        temporalContext: {
            schema: 'fsusblog.temporal-context.v1',
            digest: digest('d')
        },
        producerOutputs: {
            'auth-session': {
                identityReferences
            }
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
            ownedEntityIds: ['7001', '8001']
        },
        ...overrides
    };
}

test('account-messaging builds a full deterministic matrix from legacy coarse capabilities', async () =>
{
    const context = baseContext(null);
    const plan = buildMessagingFixturePlan(context, {
        identityReferences: {
            primaryRecipientId: '101',
            secondaryRecipientId: '102',
            emptyRecipientId: '103',
            adminId: '7',
            adminSessionAuditReference: 'sha256-admin-session-audit',
            sourceReceiptDigest: digest('c')
        },
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
    assert.deepEqual(await verifyAccountMessaging(context, result), {
        ok: true,
        producerId: 'account-messaging',
        warnings: []
    });
    await cleanupAccountMessaging(context, result);
    assert.deepEqual(cleaned.ownedEntityIds, ['7001', '8001']);
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
    duplicateIdentityContext.producerOutputs['auth-session'].identityReferences = {
        ...identityReferences,
        roles: {
            ...identityReferences.roles,
            'empty-recipient': { accountId: 101 }
        }
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
