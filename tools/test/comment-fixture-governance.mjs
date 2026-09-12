import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
    commentFixtureInventoryErrors,
    commentFixtureOwnershipErrors,
    digestCommentFixtureValue,
    readCommentFixtureContract
} from './comment-fixture-contract.mjs';
import { runPostcondition } from '../test-fixtures/receipt/postconditions.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const producerMarker = `fixture-${'catalog: producer comment-moderation'}`;
const acceptedExtensions = new Set(['.cs', '.js', '.json', '.mjs', '.sh', '.ts', '.tsx', '.yml', '.yaml']);
const governancePaths = new Set([
    'config/testing/comment-fixture-inventory.json',
    'config/testing/comment-fixture-ownership.json',
    'tests/tools/comment-fixture-cleanup.test.mjs',
    'tests/tools/comment-fixture-contract.test.mjs',
    'tests/tools/comment-fixture-governance.test.mjs',
    'tools/test/check-comment-fixture-governance.mjs',
    'tools/test/comment-fixture-contract.mjs',
    'tools/test/comment-fixture-governance.mjs'
]);

const forbiddenPatterns = Object.freeze([
    ['direct-comment-storage', /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:public\.)?(?:comment|comment_revision|comment_moderation)/iu],
    ['cross-domain-storage-write', /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:public\.)?(?:article|user|admin|security|message)\b|\b(?:Insertable|Updateable|Deleteable)\s*<\s*(?:Article|User|Admin|Message)/iu],
    ['legacy-comment-actor', /\b(?:legacy_server_visible_pseudonymous|identified_opt_in|identified-opt-in|pseudonymous)\b/iu],
    ['queue-count-shortcut', /(?:queue|moderation)[\s\S]{0,100}(?:count\s*>\s*0|count-positive|rowCount|first\s+row)/iu],
    ['two-state-moderation', /(?:approved[\s,|]+pending|pending[\s,|]+approved)(?![\s\S]{0,120}(?:rejected|spam))/iu],
    ['demo-correctness-source', /(?:DemoFixtureSeeder|development-demo|demo[_ -]fixture)[\s\S]{0,120}(?:comment|moderation)/iu],
    ['compatibility-producer-wrapper', /(?:comment|moderation)[\s\S]{0,100}(?:legacy|compat(?:ibility)?|wrapper)[\s\S]{0,100}(?:prepare|producer|seed)/iu]
]);

function trackedFiles(root)
{
    const result = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024
    });
    if (result.status !== 0) throw new Error(`cannot enumerate comment fixture sources: ${result.stderr}`);
    return result.stdout.split('\0').filter(Boolean).sort();
}

function lineFor(source, index)
{
    return source.slice(0, index).split('\n').length;
}

function firstRowViolations(relativePath, source)
{
    const violations = [];
    for (const match of source.matchAll(/\b(?:FirstAsync|FirstOrDefault(?:Async)?)\s*\(/gu))
    {
        const context = source.slice(Math.max(0, match.index - 260), match.index);
        if (!/\.Where\s*\([\s\S]*(?:\.Id|CommentId)\s*==/u.test(context))
            violations.push({
                id: 'first-row-discovery',
                path: relativePath,
                line: lineFor(source, match.index),
                detail: 'comment correctness must resolve an exact owned identity before reading one row'
            });
    }
    return violations;
}

function implementationPaths(ownership)
{
    return new Set([
        ownership.producer.implementation,
        ownership.composition.implementation,
        ...ownership.ports.map((item) => item.implementation),
        ...(ownership.supportImplementations ?? []).map((item) => item.implementation),
        ...ownership.gateways.map((item) => item.implementation)
    ]);
}

function scanSources(root, ownership)
{
    const violations = [];
    const expected = implementationPaths(ownership);
    const consumerPaths = new Set(ownership.consumers.map((item) => item.implementation));
    const markers = [];
    const tracked = trackedFiles(root);
    for (const relativePath of expected)
        if (!tracked.includes(relativePath))
            violations.push({ id: 'owned-implementation-missing', path: relativePath, line: 1, detail: 'declared comment fixture implementation is missing' });
    for (const relativePath of tracked)
    {
        if (!acceptedExtensions.has(path.extname(relativePath)) || governancePaths.has(relativePath)) continue;
        const absolutePath = path.join(root, relativePath);
        const stat = fs.lstatSync(absolutePath);
        if (!stat.isFile() || stat.isSymbolicLink())
        {
            violations.push({ id: 'source-file-identity', path: relativePath, line: 1, detail: 'source is not a regular file' });
            continue;
        }
        const source = fs.readFileSync(absolutePath, 'utf8');
        if (source.includes(producerMarker)) markers.push(relativePath);
        if (!expected.has(relativePath) && !consumerPaths.has(relativePath) && !source.includes(producerMarker)) continue;
        for (const [id, pattern] of forbiddenPatterns)
        {
            const match = pattern.exec(source);
            if (match) violations.push({
                id,
                path: relativePath,
                line: lineFor(source, match.index),
                detail: 'active comment fixture correctness source contains a forbidden legacy or shortcut pattern'
            });
        }
        violations.push(...firstRowViolations(relativePath, source));
        if (!expected.has(relativePath) && source.includes(producerMarker))
            violations.push({ id: 'second-producer', path: relativePath, line: 1, detail: 'producer marker is outside exact ownership' });
    }
    const supportPaths = new Set((ownership.supportImplementations ?? []).map((item) => item.implementation));
    const expectedMarkers = [...expected].filter((item) => !supportPaths.has(item)).sort();
    markers.sort();
    if (JSON.stringify(markers) !== JSON.stringify(expectedMarkers))
        violations.push({
            id: 'producer-owner-exactness',
            path: ownership.producer.implementation,
            line: 1,
            detail: `expected ${expectedMarkers.join(', ')}, observed ${markers.join(', ') || '<none>'}`
        });
    return violations;
}

function sourceIdentity(root, ownership)
{
    const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
    if (revision.status !== 0 || !/^[a-f0-9]{40}\n?$/u.test(revision.stdout))
        throw new Error('comment fixture governance cannot resolve source revision');
    const paths = [
        'config/testing/comment-fixture-inventory.json',
        'config/testing/comment-fixture-ownership.json',
        'config/testing/fixture-producer-registry.json',
        'tools/test/check-comment-fixture-governance.mjs',
        'tools/test/comment-fixture-contract.mjs',
        'tools/test/comment-fixture-governance.mjs',
        'tools/test/run-comment-fixture-simulated-runtime.mjs',
        'tools/test-fixtures/receipt/comment-cleanup-contract.mjs',
        'tools/test-fixtures/receipt/producer-receipt.mjs',
        ...implementationPaths(ownership),
        ...ownership.consumers.map((item) => item.implementation)
    ].sort();
    const hash = createHash('sha256');
    for (const relativePath of paths)
    {
        const absolutePath = path.join(root, relativePath);
        hash.update(relativePath);
        hash.update(fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath) : '<missing>');
    }
    return Object.freeze({
        commit: revision.stdout.trim(),
        worktreeFingerprint: `sha256:${hash.digest('hex')}`
    });
}

function mutationCases(contract)
{
    const cases = [
        ['approved-public-hidden', (inventory) => inventory.stateRules.readModels.approved.public = 'hidden-exact'],
        ['pending-public-visible', (inventory) => inventory.stateRules.readModels.pending.public = 'visible-exact'],
        ['spam-queue-excluded', (inventory) => inventory.stateRules.queueMembership.spam = 'excluded'],
        ['unknown-capability', (inventory) => {
            inventory.capabilities[0].id = 'comment.zz.unregistered';
            inventory.capabilities.sort((left, right) => left.id.localeCompare(right.id));
        }],
        ['queue-first-row', (inventory) => inventory.capabilities.find((item) => item.id === 'comment.queue.exact-membership').postconditions = ['admin.queue-exact', 'database.first-row']],
        ['missing-delete-history', (inventory) => inventory.capabilities.find((item) => item.id === 'comment.delete.root').proofTests = ['deleted-root-child-visible']],
        ['direct-sql-port', (_inventory, ownership) => ownership.ports[1].storageWrites = 'direct-sql'],
        ['cross-domain-delete', (_inventory, ownership) => ownership.ports[1].storageWrites = 'production-comment-and-article-delete-services'],
        ['rerun-duplicate', (_inventory, ownership) => ownership.composition.delegatesTo.push('comment-thread-lifecycle')],
        ['second-producer', (_inventory, ownership) => ownership.producer.implementation = 'tests/browser-contract/default-fixture-provider.mjs'],
        ['orphan-capability', (_inventory, ownership) => ownership.capabilityOwners.pop()],
        ['missing-support-implementation', (_inventory, ownership) => ownership.supportImplementations = []],
        ['renamed-compat-support', (_inventory, ownership) => ownership.supportImplementations[0].implementation = 'src/backend/Services/Fixtures/CommentCompatWrapper.cs'],
        ['demo-owner', (_inventory, ownership) => ownership.composition.implementation = 'src/backend/Services/Fixtures/DemoFixtureSeeder.cs']
    ];
    return cases.map(([id, mutate]) =>
    {
        const inventory = structuredClone(contract.inventory);
        const ownership = structuredClone(contract.ownership);
        mutate(inventory, ownership);
        const errors = [
            ...commentFixtureInventoryErrors(inventory),
            ...commentFixtureOwnershipErrors(inventory, ownership)
        ];
        return Object.freeze({ id, killed: errors.length > 0, errorDigest: digestCommentFixtureValue(errors) });
    });
}

function validRuntimeCrossDomain(value, articleId)
{
    return value?.schema === 'fsusblog.comment-fixture-cross-domain-sentinel.v1'
        && value.articleId === articleId
        && Array.isArray(value.accountIds) && value.accountIds.length === 2
        && value.accountIds.every((item) => Number.isSafeInteger(item) && item > 0)
        && JSON.stringify(value.accountIds) === JSON.stringify([...new Set(value.accountIds)].sort((left, right) => left - right))
        && Number.isSafeInteger(value.adminPrincipalId) && value.adminPrincipalId > 0
        && ['articleDigest', 'authDigest', 'adminDigest', 'securityDigest']
            .every((key) => /^sha256:[a-f0-9]{64}$/u.test(String(value[key] ?? '')));
}

function exactRuntimeErrors(run)
{
    const errors = [];
    if (run?.producerId !== 'comment-moderation' || run?.strategy !== 'transaction-fixture')
        errors.push('runtime producer identity is not canonical');
    const proofs = run?.capabilityProofs ?? [];
    const capabilityIds = ['comment.moderation-matrix', 'comment.threaded', 'moderation.policy-matrix'];
    if (JSON.stringify(proofs.map((item) => item?.capabilityId)) !== JSON.stringify(capabilityIds)
        || proofs.some((item) => item?.status !== 'verified'
            || [item.thread, item.moderation, item.publicReadModel, item.adminReadModel, item.queue, item.cacheOutbox]
                .some((value) => value !== 'exact')))
        errors.push('runtime capability proofs are partial');
    const threads = run?.threadEntities ?? [];
    const ids = threads.map((item) => String(item?.commentId ?? ''));
    if (threads.length === 0 || new Set(ids).size !== ids.length || ids.some((id) => !/^[1-9][0-9]*$/u.test(id)))
        errors.push('runtime comment identities are missing or reused');
    for (const role of ['approved-root', 'approved-reply', 'approved-nested', 'pending', 'rejected', 'spam', 'edited', 'deleted-root', 'deleted-root-child', 'deleted-reply', 'region-global', 'region-manual-review'])
        if (threads.filter((item) => item?.semanticRole === role).length !== 1) errors.push(`runtime semantic role ${role} is not exact`);
    if (!threads.some((item) => item?.actorMode === 'zk_anonymous'))
        errors.push('runtime zk_anonymous actor evidence is missing');
    const moderation = run?.moderation;
    const semantics = moderation?.runtimeSemantics;
    if (semantics?.schema !== 'fsusblog.comment-fixture-runtime-semantics.v1'
        || JSON.stringify(semantics.publicVisibility) !== JSON.stringify({ approved: 'visible-exact', pending: 'hidden-exact', rejected: 'hidden-exact', spam: 'hidden-exact' })
        || JSON.stringify(semantics.queueMembership) !== JSON.stringify({ approved: 'excluded', pending: 'included-pending', rejected: 'included-rejected', spam: 'included-rejected' })
        || semantics.source !== 'production-comment-query-and-authoring-moderation-queue')
        errors.push('runtime public/queue semantic evidence drifted');
    const moderated = moderation?.entities ?? [];
    const moderationByRole = new Map(moderated.map((item) => [item?.semanticRole, item]));
    const observations = {
        database: {
            entities: threads.map((thread) =>
            {
                const observed = moderationByRole.get(thread?.semanticRole);
                const semanticRole = thread?.semanticRole;
                return {
                    kind: semanticRole?.startsWith('region-') ? 'moderation-policy' : 'comment',
                    id: String(thread?.commentId ?? ''),
                    owned: true,
                    fields: {
                        capabilityId: observed?.capabilityId ?? null,
                        semanticRole,
                        articleId: String(thread?.articleId ?? ''),
                        actorMode: thread?.actorMode,
                        rootId: String(thread?.rootId ?? ''),
                        parentId: thread?.parentId == null ? null : String(thread.parentId),
                        replyToCommentId: thread?.replyToCommentId == null ? null : String(thread.replyToCommentId),
                        threadDepth: thread?.depth,
                        currentVersion: thread?.currentVersion,
                        isDeleted: thread?.isDeleted,
                        history: thread?.history,
                        publicVisible: observed?.publiclyVisible ?? thread?.publiclyVisible,
                        moderationStatus: observed?.semanticStatus ?? thread?.moderationStatus,
                        moderationRuntimeStatus: observed?.runtimeStatus ?? thread?.moderationStatus,
                        moderationReason: observed?.reason ?? null,
                        moderatedByAdminPrincipalId: observed?.moderatedByAdminPrincipalId == null
                            ? null
                            : String(observed.moderatedByAdminPrincipalId),
                        moderatedAt: observed?.moderatedAt ?? null,
                        queueMember: observed?.queueMember ?? null,
                        queueBucket: observed?.queueBucket ?? null,
                        queueOrder: observed?.queueOrder ?? null,
                        queueMembershipSize: observed?.queueMembershipSize ?? null,
                        regionCode: observed?.regionCode ?? null,
                        regionRequiresManualReview: observed?.regionRequiresManualReview ?? null,
                        regionPolicyVersion: observed?.regionPolicyVersion ?? null,
                        regionEvidence: observed?.regionEvidence ?? [],
                        signalEvidence: observed?.signalEvidence ?? [],
                        moderationEventIds: observed?.moderationEventIds ?? [],
                        depthOverrunFailureCode: semanticRole === 'depth-root'
                            ? run?.negativeResults?.['depth-overrun-negative'] ?? null
                            : null,
                        outboxEventIds: observed?.outboxEventIds ?? thread?.outboxEventIds
                    }
                };
            })
        }
    };
    for (const postconditionId of ['comment-moderation-matrix', 'comment-threaded', 'moderation-policy-matrix'])
    {
        const result = runPostcondition(postconditionId, { observations });
        if (result.ok !== true) errors.push(`runtime ${postconditionId}: ${result.reason}`);
    }
    const before = String(run?.cacheGenerationBefore ?? '');
    const after = String(run?.cacheGenerationAfter ?? '');
    if (!/^[0-9]+$/u.test(before) || !/^[1-9][0-9]*$/u.test(after) || BigInt(after) <= BigInt(before))
        errors.push('runtime cache generation did not advance');
    const receiptIds = Object.keys(run?.cleanupReceipt?.ownedComments ?? {}).sort();
    const receiptBinding = run?.cleanupReceipt?.binding ?? run?.cleanupReceipt;
    const threadById = new Map(threads.map((item) => [String(item?.commentId), item]));
    const invalidOwnedIdentity = Object.entries(run?.cleanupReceipt?.ownedComments ?? {}).some(([commentId, identity]) => {
        const thread = threadById.get(commentId);
        return !thread || String(identity?.commentId) !== commentId
            || identity?.articleId !== thread.articleId
            || identity?.semanticRole !== thread.semanticRole
            || identity?.actorMode !== thread.actorMode
            || identity?.accountId !== thread.accountId
            || identity?.contentDigest !== thread.contentDigest
            || identity?.currentVersion !== thread.currentVersion
            || identity?.isDeleted !== thread.isDeleted
            || identity?.operationPlanDigest !== thread.operationPlanDigest
            || !/^sha256:[a-f0-9]{64}$/u.test(String(identity?.operationPlanDigest ?? ''));
    });
    if (run?.cleanupReceipt?.schema !== 'fsusblog.comment-thread-fixture-cleanup.v1'
        || receiptBinding?.articleId != null && receiptBinding.articleId !== threads[0]?.articleId
        || JSON.stringify(receiptIds) !== JSON.stringify([...ids].sort())
        || invalidOwnedIdentity)
        errors.push('runtime cleanup receipt does not own the exact comment identity set');
    if (!validRuntimeCrossDomain(run?.crossDomainBefore, threads[0]?.articleId)
        || JSON.stringify(run.crossDomainBefore) !== JSON.stringify(run?.crossDomainAfterPrepare)
        || JSON.stringify(run.crossDomainBefore) !== JSON.stringify(run?.cleanupReceipt?.crossDomainBefore))
        errors.push('runtime cross-domain prepare sentinel is missing or changed');
    return errors;
}

function canonicalRuntimeRun(seed)
{
    const id = (offset) => seed * 1000 + offset;
    const history = (currentVersion = 1, operation = 'created') => currentVersion === 1
        ? [{ version: 1, operation: 'created' }]
        : [{ version: currentVersion, operation }, { version: 1, operation: 'created' }];
    const thread = (semanticRole, offset, fields = {}) => ({
        semanticRole,
        commentId: id(offset),
        articleId: 42,
        actorMode: 'public',
        accountId: 11,
        rootId: id(offset),
        parentId: null,
        replyToCommentId: null,
        depth: 0,
        currentVersion: 1,
        isDeleted: false,
        moderationStatus: 'approved',
        contentDigest: `sha256:${'1'.repeat(64)}`,
        history: history(),
        publiclyVisible: true,
        outboxEventIds: [`00000000-0000-4000-8000-${String(id(offset)).padStart(12, '0')}`],
        operationPlanDigest: `sha256:${createHash('sha256').update(`${seed}:${offset}`).digest('hex')}`,
        ...fields
    });
    const root = thread('approved-root', 1);
    const reply = thread('approved-reply', 2, {
        rootId: root.commentId, parentId: root.commentId, replyToCommentId: root.commentId, depth: 1
    });
    const nested = thread('approved-nested', 3, {
        rootId: root.commentId, parentId: reply.commentId, replyToCommentId: reply.commentId, depth: 2
    });
    const depthRoot = thread('depth-root', 10);
    const depthOne = thread('depth-1', 11, {
        rootId: depthRoot.commentId, parentId: depthRoot.commentId, replyToCommentId: depthRoot.commentId, depth: 1
    });
    const depthTwo = thread('depth-2', 12, {
        rootId: depthRoot.commentId, parentId: depthOne.commentId, replyToCommentId: depthOne.commentId, depth: 2
    });
    const pending = thread('pending', 20, {
        actorMode: 'zk_anonymous', accountId: null, publiclyVisible: false, moderationStatus: 'pending'
    });
    const rejected = thread('rejected', 21, { publiclyVisible: false, moderationStatus: 'rejected' });
    const spam = thread('spam', 22, { publiclyVisible: false, moderationStatus: 'rejected' });
    const edited = thread('edited', 30, { currentVersion: 2, history: history(2, 'edited') });
    const deletedRoot = thread('deleted-root', 40, {
        currentVersion: 2, isDeleted: true, history: history(2, 'deleted')
    });
    const deletedRootChild = thread('deleted-root-child', 41, {
        rootId: deletedRoot.commentId,
        parentId: deletedRoot.commentId,
        replyToCommentId: deletedRoot.commentId,
        depth: 1
    });
    const deletedReplyParent = thread('deleted-reply-parent', 50);
    const deletedReply = thread('deleted-reply', 51, {
        rootId: deletedReplyParent.commentId,
        parentId: deletedReplyParent.commentId,
        replyToCommentId: deletedReplyParent.commentId,
        depth: 1,
        currentVersion: 2,
        isDeleted: true,
        publiclyVisible: false,
        history: history(2, 'deleted')
    });
    const regionGlobal = thread('region-global', 70);
    const regionManual = thread('region-manual-review', 71, {
        actorMode: 'zk_anonymous', accountId: null, publiclyVisible: false, moderationStatus: 'pending'
    });
    const threadEntities = [
        root, reply, nested, depthRoot, depthOne, depthTwo, pending, rejected, spam, edited,
        deletedRoot, deletedRootChild, deletedReplyParent, deletedReply, regionGlobal, regionManual
    ];
    const regionEvidence = (commentId, regionCode, manual) => [{
        commentId,
        source: 'comment_region_compliance',
        regionCode,
        policyVersion: 'policy-v1',
        decisionDigest: `sha256:${manual ? 'c' : 'b'}`.padEnd(71, manual ? 'c' : 'b')
    }];
    const moderationEntity = (item, capabilityId, semanticStatus, fields = {}) => ({
        capabilityId,
        semanticRole: item.semanticRole,
        commentId: item.commentId,
        semanticStatus,
        runtimeStatus: semanticStatus === 'spam' ? 'rejected' : semanticStatus,
        reason: semanticStatus === 'approved' || semanticStatus === 'pending' ? null : `fixture_${semanticStatus}`,
        moderatedByAdminPrincipalId: semanticStatus === 'pending' ? null : 7,
        moderatedAt: semanticStatus === 'pending' ? null : '2042-05-17T09:30:00Z',
        publiclyVisible: semanticStatus === 'approved',
        queueBucket: semanticStatus === 'spam' ? 'rejected' : semanticStatus,
        queueMember: semanticStatus === 'pending' || semanticStatus === 'rejected' || semanticStatus === 'spam',
        queueOrder: -1,
        queueMembershipSize: 0,
        regionCode: null,
        regionPolicyVersion: null,
        regionRequiresManualReview: null,
        regionEvidence: [],
        signalEvidence: [],
        moderationEventIds: semanticStatus === 'pending' ? [] : [String(item.commentId + 5000)],
        outboxEventIds: item.outboxEventIds,
        ...fields
    });
    const moderationEntities = [
        moderationEntity(root, 'comment.moderation.approved', 'approved'),
        moderationEntity(pending, 'comment.moderation.pending', 'pending', { queueOrder: 0, queueMembershipSize: 2 }),
        moderationEntity(rejected, 'comment.moderation.rejected', 'rejected', { queueOrder: 0, queueMembershipSize: 2 }),
        moderationEntity(spam, 'comment.moderation.spam', 'spam', {
            queueOrder: 1,
            queueMembershipSize: 2,
            signalEvidence: [{
                signalId: id(801),
                commentId: spam.commentId,
                provider: 'built-in',
                contractVersion: 'v1',
                classification: 'risky',
                confidence: 0.99,
                evidenceDigest: `sha256:${'a'.repeat(64)}`
            }]
        }),
        moderationEntity(regionGlobal, 'comment.region.global', 'approved', {
            regionCode: 'global',
            regionPolicyVersion: 'policy-v1',
            regionRequiresManualReview: false,
            regionEvidence: regionEvidence(regionGlobal.commentId, 'global', false)
        }),
        moderationEntity(regionManual, 'comment.region.manual-review', 'pending', {
            queueOrder: 1,
            queueMembershipSize: 2,
            regionCode: 'eu',
            regionPolicyVersion: 'policy-v1',
            regionRequiresManualReview: true,
            regionEvidence: regionEvidence(regionManual.commentId, 'eu', true)
        })
    ];
    const ownedComments = Object.fromEntries(threadEntities.map((item) => [String(item.commentId), {
        commentId: item.commentId,
        articleId: item.articleId,
        semanticRole: item.semanticRole,
        actorMode: item.actorMode,
        accountId: item.accountId,
        contentDigest: item.contentDigest,
        currentVersion: item.currentVersion,
        isDeleted: item.isDeleted,
        operationPlanDigest: item.operationPlanDigest
    }]));
    const cleanupReceipt = {
        schema: 'fsusblog.comment-thread-fixture-cleanup.v1',
        runId: `canonical-run-${seed}`,
        namespace: `canonical-comment-${seed}`,
        owner: `comment-fixture:canonical-comment-${seed}:canonical-run-${seed}`,
        inventoryDigest: `sha256:${'d'.repeat(64)}`,
        ownedComments
    };
    const crossDomain = {
        schema: 'fsusblog.comment-fixture-cross-domain-sentinel.v1',
        articleId: 42,
        accountIds: [11, 12],
        adminPrincipalId: 7,
        articleDigest: `sha256:${'a'.repeat(64)}`,
        authDigest: `sha256:${'b'.repeat(64)}`,
        adminDigest: `sha256:${'c'.repeat(64)}`,
        securityDigest: `sha256:${'d'.repeat(64)}`
    };
    cleanupReceipt.crossDomainBefore = crossDomain;
    return {
        producerId: 'comment-moderation',
        strategy: 'transaction-fixture',
        capabilityProofs: ['comment.moderation-matrix', 'comment.threaded', 'moderation.policy-matrix'].map((capabilityId) => ({
            capabilityId,
            status: 'verified',
            thread: 'exact',
            moderation: 'exact',
            publicReadModel: 'exact',
            adminReadModel: 'exact',
            queue: 'exact',
            cacheOutbox: 'exact'
        })),
        threadEntities,
        moderation: {
            runtimeSemantics: {
                schema: 'fsusblog.comment-fixture-runtime-semantics.v1',
                publicVisibility: { approved: 'visible-exact', pending: 'hidden-exact', rejected: 'hidden-exact', spam: 'hidden-exact' },
                queueMembership: { approved: 'excluded', pending: 'included-pending', rejected: 'included-rejected', spam: 'included-rejected' },
                source: 'production-comment-query-and-authoring-moderation-queue'
            },
            entities: moderationEntities
        },
        negativeResults: { 'depth-overrun-negative': 'comment_thread_depth_limit' },
        cacheGenerationBefore: '10',
        cacheGenerationAfter: '11',
        crossDomainBefore: crossDomain,
        crossDomainAfterPrepare: structuredClone(crossDomain),
        cleanupReceipt
    };
}

export function buildCanonicalCommentFixtureRuntimeEvidence()
{
    const runs = [canonicalRuntimeRun(1), canonicalRuntimeRun(2)];
    return {
        schema: 'fsusblog.comment-fixture-canonical-runtime-evidence.v1',
        runs,
        cleanups: runs.map((run) => ({
            schema: 'fsusblog.comment-thread-fixture-cleanup-result.v1',
            runId: run.cleanupReceipt.runId,
            namespace: run.cleanupReceipt.namespace,
            owner: run.cleanupReceipt.owner,
            inventoryDigest: run.cleanupReceipt.inventoryDigest,
            deletedCommentIds: Object.keys(run.cleanupReceipt.ownedComments).map(Number),
            stillPublicCommentIds: [],
            exact: true,
            crossDomainBefore: structuredClone(run.crossDomainBefore),
            crossDomainAfter: structuredClone(run.crossDomainBefore)
        }))
    };
}

function cleanupResultErrors(run, cleanup)
{
    const receiptBinding = run?.cleanupReceipt?.binding ?? run?.cleanupReceipt;
    const cleanupBinding = cleanup?.binding ?? cleanup;
    const expected = Object.keys(run?.cleanupReceipt?.ownedComments ?? {}).sort();
    const actual = (cleanup?.deletedCommentIds ?? []).map(String).sort();
    return cleanup?.schema !== 'fsusblog.comment-thread-fixture-cleanup-result.v1'
        || cleanupBinding?.runId !== receiptBinding?.runId
        || cleanupBinding?.namespace !== receiptBinding?.namespace
        || cleanupBinding?.owner !== receiptBinding?.owner
        || cleanupBinding?.inventoryDigest !== receiptBinding?.inventoryDigest
        || cleanup?.exact !== true || (cleanup?.stillPublicCommentIds ?? []).length !== 0
        || JSON.stringify(actual) !== JSON.stringify(expected)
        || JSON.stringify(cleanup?.crossDomainBefore) !== JSON.stringify(run?.cleanupReceipt?.crossDomainBefore)
        || JSON.stringify(cleanup?.crossDomainAfter) !== JSON.stringify(run?.cleanupReceipt?.crossDomainBefore)
        ? ['runtime cleanup verification is missing, partial, or cross-run']
        : [];
}

function runtimeEvidenceErrors(runtimeEvidence, cleanup, runs, cleanups)
{
    const errors = [];
    if (runtimeEvidence?.schema !== 'fsusblog.comment-fixture-runtime-evidence.v2')
        errors.push('runtime evidence schema is not the invocation-bound v2 contract');
    if (!['local-runtime-producer-invocation', 'local-simulated-producer-invocation']
        .includes(runtimeEvidence?.authorityClass))
        errors.push('runtime evidence is not an actual producer invocation authority');
    if (JSON.stringify(runtimeEvidence?.source) !== JSON.stringify(cleanup.source))
        errors.push('runtime evidence source is stale or cross-worktree');
    const invocations = runs.map((run) => run?.producerInvocation);
    if (invocations.length !== 2
        || invocations.some((item) => item?.schema !== 'fsusblog.comment-fixture-producer-invocation.v1')
        || runtimeEvidence?.invocationSetDigest !== digestCommentFixtureValue(invocations))
        errors.push('runtime producer invocation set is missing or unsealed');
    runs.forEach((run, index) =>
    {
        const invocation = run?.producerInvocation;
        const binding = run?.cleanupReceipt?.binding ?? run?.cleanupReceipt;
        const unsignedRun = Object.fromEntries(Object.entries(run ?? {})
            .filter(([key]) => key !== 'producerInvocation'));
        const expectedRequests = [
            { method: 'POST', path: '/api/local/comment-fixture/prepare', status: 200 },
            { method: 'GET', path: '/__local/temporal-observation', status: 200 },
            { method: 'POST', path: '/api/local/comment-fixture/cleanup', status: 200 }
        ];
        if (invocation?.producerId !== 'comment-moderation'
            || invocation?.implementation !== 'tools/test-fixtures/producers/comment-moderation-producer.mjs'
            || invocation?.prepareExport !== 'prepareCommentModeration'
            || invocation?.verifyExport !== 'verifyCommentModeration'
            || invocation?.cleanupExport !== 'cleanupCommentModeration'
            || invocation?.transport !== 'loopback-http'
            || invocation?.runId !== binding?.runId
            || invocation?.namespace !== binding?.namespace
            || invocation?.ordinal !== index + 1
            || JSON.stringify(invocation?.requests) !== JSON.stringify(expectedRequests)
            || invocation?.producerResultDigest !== digestCommentFixtureValue(unsignedRun)
            || invocation?.cleanupResultDigest !== digestCommentFixtureValue(cleanups[index]))
            errors.push(`runtime producer invocation ${index + 1} is missing, forged, or cross-run`);
    });
    return errors;
}

export function buildCommentFixtureCleanupReceipt({ root = repositoryRoot } = {})
{
    const contract = readCommentFixtureContract();
    const violations = scanSources(root, contract.ownership);
    const receipt = {
        schema: 'fsusblog.comment-fixture-cleanup.v1',
        source: sourceIdentity(root, contract.ownership),
        inventoryDigest: contract.inventoryDigest,
        ownershipDigest: contract.ownershipDigest,
        producerId: contract.inventory.producerId,
        scanner: { status: violations.length === 0 ? 'accepted' : 'rejected', violations },
        exactOwnership: violations.every((item) => !['second-producer', 'producer-owner-exactness'].includes(item.id)),
        warnings: []
    };
    return Object.freeze({ ...receipt, contentDigest: digestCommentFixtureValue(receipt) });
}

export function verifyCommentFixtureCleanupReceipt(receipt, { root = repositoryRoot } = {})
{
    const live = buildCommentFixtureCleanupReceipt({ root });
    const unsigned = Object.fromEntries(Object.entries(receipt ?? {}).filter(([key]) => key !== 'contentDigest'));
    if (!receipt || receipt.schema !== live.schema
        || receipt.contentDigest !== digestCommentFixtureValue(unsigned)
        || receipt.contentDigest !== live.contentDigest
        || receipt.scanner.status !== 'accepted' || receipt.scanner.violations.length !== 0
        || receipt.exactOwnership !== true || receipt.warnings.length !== 0)
        throw new Error('comment fixture cleanup receipt is missing, stale, tampered, or rejected');
    return live;
}

export function buildCommentFixtureAcceptanceReceipt(cleanupReceipt, runtimeEvidence, { root = repositoryRoot } = {})
{
    const cleanup = verifyCommentFixtureCleanupReceipt(cleanupReceipt, { root });
    const contract = readCommentFixtureContract();
    const mutations = mutationCases(contract);
    const runs = runtimeEvidence?.runs ?? [];
    const cleanups = runtimeEvidence?.cleanups ?? [];
    const violations = [
        ...cleanup.scanner.violations,
        ...mutations.filter((item) => !item.killed).map((item) => ({ id: `mutation.${item.id}` }))
    ];
    runtimeEvidenceErrors(runtimeEvidence, cleanup, runs, cleanups)
        .forEach((detail) => violations.push({ id: 'runtime.provenance', detail }));
    if (runs.length !== 2 || cleanups.length !== 2)
        violations.push({ id: 'runtime.parallel-rerun', detail: 'two canonical runtime runs and cleanup results are required' });
    runs.forEach((run, index) => exactRuntimeErrors(run)
        .forEach((detail) => violations.push({ id: `runtime.run-${index + 1}`, detail })));
    cleanups.forEach((cleanupResult, index) => cleanupResultErrors(runs[index], cleanupResult)
        .forEach((detail) => violations.push({ id: `runtime.cleanup-${index + 1}`, detail })));
    if (runs.length === 2)
    {
        const left = new Set((runs[0].threadEntities ?? []).map((item) => String(item.commentId)));
        const right = (runs[1].threadEntities ?? []).map((item) => String(item.commentId));
        const firstBinding = runs[0]?.cleanupReceipt?.binding ?? runs[0]?.cleanupReceipt;
        const secondBinding = runs[1]?.cleanupReceipt?.binding ?? runs[1]?.cleanupReceipt;
        if (firstBinding?.runId === secondBinding?.runId
            || firstBinding?.namespace === secondBinding?.namespace
            || right.some((id) => left.has(id)))
            violations.push({ id: 'runtime.parallel-isolation', detail: 'parallel/rerun identities are not independent' });
    }
    const receipt = {
        schema: 'fsusblog.comment-fixture-acceptance.v1',
        source: cleanup.source,
        inputDigest: cleanup.contentDigest,
        runtimeEvidenceDigest: digestCommentFixtureValue(runtimeEvidence),
        inventoryDigest: contract.inventoryDigest,
        ownershipDigest: contract.ownershipDigest,
        producer: { id: contract.inventory.producerId, strategy: contract.inventory.strategy, exactOwner: cleanup.exactOwnership },
        ports: contract.ownership.ports.map((item) => ({
            id: item.id,
            implementation: item.implementation,
            storageWrites: item.storageWrites
        })),
        scanner: cleanup.scanner,
        mutations,
        demoIsolation: {
            status: cleanup.scanner.violations.some((item) => item.id === 'demo-correctness-source') ? 'rejected' : 'accepted',
            correctnessProducerId: contract.inventory.producerId
        },
        parallelRerun: {
            status: violations.some((item) => item.id.startsWith('runtime.parallel')) ? 'rejected' : 'accepted',
            runCount: runs.length,
            cleanupCount: cleanups.length
        },
        runtimeInvocations: {
            schema: runtimeEvidence?.schema ?? null,
            authorityClass: runtimeEvidence?.authorityClass ?? null,
            invocationSetDigest: runtimeEvidence?.invocationSetDigest ?? null,
            runs: runs.map((run) => ({
                runId: (run?.cleanupReceipt?.binding ?? run?.cleanupReceipt)?.runId ?? null,
                namespace: (run?.cleanupReceipt?.binding ?? run?.cleanupReceipt)?.namespace ?? null,
                producerResultDigest: run?.producerInvocation?.producerResultDigest ?? null,
                cleanupResultDigest: run?.producerInvocation?.cleanupResultDigest ?? null
            }))
        },
        cacheQueueReadModel: {
            status: violations.some((item) => item.id.startsWith('runtime.')) ? 'rejected' : 'accepted',
            evidence: runs.map((run) => ({
                cacheGenerationBefore: run?.cacheGenerationBefore ?? null,
                cacheGenerationAfter: run?.cacheGenerationAfter ?? null,
                runtimeSemantics: run?.moderation?.runtimeSemantics ?? null
            }))
        },
        consumerParity: {
            status: violations.some((item) => item.id.startsWith('runtime.')) ? 'rejected' : 'accepted',
            domains: ['admin-read-model', 'cache-generation', 'moderation-queue', 'outbox', 'public-read-model', 'storage'],
            authority: 'typed-production-comment-fixture-ports'
        },
        violations,
        warnings: [],
        status: violations.length === 0 ? 'accepted' : 'rejected'
    };
    return Object.freeze({ ...receipt, contentDigest: digestCommentFixtureValue(receipt) });
}

export function verifyCommentFixtureAcceptanceReceipt(receipt, cleanupReceipt, runtimeEvidence, { root = repositoryRoot } = {})
{
    const live = buildCommentFixtureAcceptanceReceipt(cleanupReceipt, runtimeEvidence, { root });
    const unsigned = Object.fromEntries(Object.entries(receipt ?? {}).filter(([key]) => key !== 'contentDigest'));
    if (!receipt || receipt.schema !== 'fsusblog.comment-fixture-acceptance.v1'
        || receipt.contentDigest !== digestCommentFixtureValue(unsigned)
        || receipt.contentDigest !== live.contentDigest
        || receipt.status !== 'accepted' || receipt.violations.length !== 0
        || receipt.warnings.length !== 0 || receipt.mutations.some((item) => item.killed !== true))
        throw new Error('comment fixture acceptance receipt is missing, stale, tampered, or not terminal accepted');
    return live;
}

export { repositoryRoot as COMMENT_FIXTURE_REPOSITORY_ROOT };
