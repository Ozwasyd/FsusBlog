import assert from 'node:assert/strict';
import test from 'node:test';

const { runPostcondition } = await import(new URL('../../tools/test-fixtures/receipt/postconditions.mjs', import.meta.url));
function comment(role, id, fields = {})
{
    return {
        kind: 'comment',
        id: String(id),
        owned: true,
        fields: {
            semanticRole: role,
            articleId: '42',
            actorMode: 'public',
            rootId: String(id),
            parentId: null,
            replyToCommentId: null,
            threadDepth: 0,
            currentVersion: 1,
            isDeleted: false,
            publicVisible: true,
            moderationStatus: 'approved',
            moderationRuntimeStatus: 'approved',
            moderationReason: null,
            commentReferenceDigest: `sha256:${'f'.repeat(64)}`,
            reasonId: 'approved-none',
            regionStateId: null,
            signalStateId: null,
            applicableRegions: [],
            adminVisible: true,
            adminStatus: 'approved',
            adminModerationActor: 'admin:7',
            queueMember: false,
            queueBucket: 'approved',
            queueGroup: 'approved',
            queueReason: null,
            queueActor: 'admin:7',
            queueOrder: -1,
            queueMembershipSize: 0,
            history: [{ version: 1, operation: 'created' }],
            moderationEventIds: ['201'],
            outboxEventIds: [`00000000-0000-4000-8000-${String(id).padStart(12, '0')}`],
            moderatedByAdminPrincipalId: '7',
            moderatedAt: '2042-05-17T09:30:00Z',
            signalEvidence: [],
            ...fields
        }
    };
}

function observations()
{
    const root = comment('approved-root', 100);
    const reply = comment('approved-reply', 101, {
        rootId: '100', parentId: '100', replyToCommentId: '100', threadDepth: 1
    });
    const nested = comment('approved-nested', 102, {
        rootId: '100', parentId: '101', replyToCommentId: '101', threadDepth: 2
    });
    const depthRoot = comment('depth-root', 110, { depthOverrunFailureCode: 'comment_thread_depth_limit' });
    const depthOne = comment('depth-1', 111, {
        rootId: '110', parentId: '110', replyToCommentId: '110', threadDepth: 1
    });
    const depthTwo = comment('depth-2', 112, {
        rootId: '110', parentId: '111', replyToCommentId: '111', threadDepth: 2
    });
    const pending = comment('pending', 120, {
        publicVisible: false,
        moderationStatus: 'pending',
        moderationRuntimeStatus: 'pending',
        reasonId: 'pending-none',
        queueMember: true,
        queueBucket: 'pending',
        adminStatus: 'pending',
        adminModerationActor: 'human-review-pending',
        queueGroup: 'pending',
        queueActor: 'human-review-pending',
        queueOrder: 0,
        queueMembershipSize: 2,
        moderationEventIds: [],
        moderatedByAdminPrincipalId: null,
        moderatedAt: null
    });
    const rejected = comment('rejected', 121, {
        publicVisible: false,
        moderationStatus: 'rejected',
        moderationRuntimeStatus: 'rejected',
        reasonId: 'rejected-fixture',
        queueMember: true,
        queueBucket: 'rejected',
        moderationReason: 'fixture_rejected',
        adminStatus: 'rejected',
        adminModerationActor: 'admin:7',
        queueGroup: 'rejected',
        queueReason: 'fixture_rejected',
        queueActor: 'admin:7',
        queueOrder: 0,
        queueMembershipSize: 2
    });
    const spam = comment('spam', 122, {
        publicVisible: false,
        moderationStatus: 'spam',
        moderationRuntimeStatus: 'rejected',
        reasonId: 'spam-fixture',
        signalStateId: 'verified',
        queueMember: true,
        queueBucket: 'rejected',
        moderationReason: 'fixture_spam',
        adminStatus: 'rejected',
        adminModerationActor: 'admin:7',
        queueGroup: 'rejected',
        queueReason: 'fixture_spam',
        queueActor: 'admin:7',
        queueOrder: 1,
        queueMembershipSize: 2,
        signalEvidence: [{
            signalId: 801,
            commentId: 122,
            provider: 'built-in',
            contractVersion: 'v1',
            classification: 'risky',
            confidence: 0.99,
            evidenceDigest: `sha256:${'a'.repeat(64)}`,
            source: 'fsusblog',
            model: 'fixture-model',
            status: 'ok',
            score: 0.99,
            evidenceRefs: [`sha256:${'a'.repeat(64)}`]
        }]
    });
    const edited = comment('edited', 130, {
        currentVersion: 2,
        history: [{ version: 2, operation: 'edited' }, { version: 1, operation: 'created' }]
    });
    const deletedRoot = comment('deleted-root', 140, {
        isDeleted: true,
        history: [{ version: 2, operation: 'deleted' }, { version: 1, operation: 'created' }]
    });
    const deletedRootChild = comment('deleted-root-child', 141, {
        rootId: '140', parentId: '140', replyToCommentId: '140', threadDepth: 1, publicVisible: true
    });
    const deletedReplyParent = comment('deleted-reply-parent', 150);
    const deletedReply = comment('deleted-reply', 151, {
        rootId: '150', parentId: '150', replyToCommentId: '150', threadDepth: 1,
        isDeleted: true, publicVisible: false,
        history: [{ version: 2, operation: 'deleted' }, { version: 1, operation: 'created' }]
    });
    const anonymous = comment('zk-anonymous-root', 160, { actorMode: 'zk_anonymous' });
    const regionGlobal = {
        ...comment('region-global', 170, {
            regionCode: 'global',
            regionStateId: 'global',
            applicableRegions: ['global'],
            regionPolicyVersion: 'policy-v1',
            regionRequiresManualReview: false,
            regionEvidence: [{
                commentId: 170,
                source: 'comment_region_compliance',
                regionCode: 'global',
                policyVersion: 'policy-v1',
                decisionDigest: `sha256:${'b'.repeat(64)}`,
                provider: 'test-fixture-verified-region',
                canPublish: true,
                requiresManualReview: false,
                hideUntilReviewed: false,
                decisionReason: 'region_policy_allow',
                blockedRegions: []
            }]
        }),
        kind: 'moderation-policy'
    };
    const regionManual = {
        ...comment('region-manual-review', 171, {
            regionCode: 'eu',
            regionStateId: 'manual-review',
            applicableRegions: ['eu'],
            regionPolicyVersion: 'policy-v1',
            regionRequiresManualReview: true,
            regionEvidence: [{
                commentId: 171,
                source: 'comment_region_compliance',
                regionCode: 'eu',
                policyVersion: 'policy-v1',
                decisionDigest: `sha256:${'c'.repeat(64)}`,
                provider: 'test-fixture-verified-region',
                canPublish: true,
                requiresManualReview: true,
                hideUntilReviewed: false,
                decisionReason: 'submit_region_manual_review',
                blockedRegions: []
            }],
            publicVisible: false,
            moderationStatus: 'pending',
            moderationRuntimeStatus: 'pending',
            reasonId: 'pending-none',
            adminStatus: 'pending',
            adminModerationActor: 'human-review-pending',
            queueMember: true,
            queueBucket: 'pending',
            queueGroup: 'pending',
            queueActor: 'human-review-pending',
            queueOrder: 1,
            queueMembershipSize: 2
        }),
        kind: 'moderation-policy'
    };
    return {
        database: {
            namespace: 'comment-test',
            entities: [
                root, reply, nested, depthRoot, depthOne, depthTwo, pending, rejected, spam,
                edited, deletedRoot, deletedRootChild, deletedReplyParent, deletedReply,
                anonymous, regionGlobal, regionManual
            ]
        }
    };
}

test('comment postconditions accept complete typed runtime observations', () =>
{
    for (const id of ['comment-moderation-matrix', 'comment-threaded', 'moderation-policy-matrix'])
    {
        assert.equal(runPostcondition(id, { observations: observations() }).ok, true, id);
    }
});

test('comment moderation postcondition rejects public/queue/signal projection drift', () =>
{
    for (const mutate of [
        (items) => items.find((item) => item.fields.semanticRole === 'pending').fields.publicVisible = true,
        (items) => delete items.find((item) => item.fields.semanticRole === 'pending').fields.queueOrder,
        (items) => items.find((item) => item.fields.semanticRole === 'spam').fields.queueBucket = 'pending',
        (items) => items.find((item) => item.fields.semanticRole === 'spam').fields.signalEvidence = [],
        (items) => items.find((item) => item.fields.semanticRole === 'spam').fields.signalEvidence[0].evidenceDigest = 'placeholder'
    ])
    {
        const observation = observations();
        mutate(observation.database.entities);
        assert.equal(runPostcondition('comment-moderation-matrix', { observations: observation }).ok, false);
    }
});

test('comment thread postcondition rejects relation, history, delete, depth, and actor drift', () =>
{
    for (const mutate of [
        (items) => items.find((item) => item.fields.semanticRole === 'approved-nested').fields.rootId = '101',
        (items) => items.find((item) => item.fields.semanticRole === 'edited').fields.history = [{ version: 2, operation: 'edited' }],
        (items) => items.find((item) => item.fields.semanticRole === 'deleted-root').fields.isDeleted = false,
        (items) => items.find((item) => item.fields.semanticRole === 'deleted-root-child').fields.rootId = '150',
        (items) => items.find((item) => item.fields.semanticRole === 'depth-root').fields.depthOverrunFailureCode = null,
        (items) => items.find((item) => item.fields.semanticRole === 'zk-anonymous-root').fields.actorMode = 'public'
    ])
    {
        const observation = observations();
        mutate(observation.database.entities);
        assert.equal(runPostcondition('comment-threaded', { observations: observation }).ok, false);
    }
});

test('comment region postcondition rejects missing/manual visibility evidence', () =>
{
    const observation = observations();
    observation.database.entities.find((item) => item.fields.semanticRole === 'region-manual-review')
        .fields.regionEvidence = [];
    assert.equal(runPostcondition('moderation-policy-matrix', { observations: observation }).ok, false);

    const sameRegion = observations();
    sameRegion.database.entities.find((item) => item.fields.semanticRole === 'region-manual-review')
        .fields.regionCode = 'global';
    assert.equal(runPostcondition('moderation-policy-matrix', { observations: sameRegion }).ok, false);
});
