import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const inventoryPath = path.join(repositoryRoot, 'config/testing/comment-fixture-inventory.json');
const stableId = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const legacyActor = /(?:legacy|pseudonymous|identified-opt-in|current-equivalent|^anonymous$)/u;
const shortcut = /(?:count-positive|count>0|first-row|row-exists|status-integer|wildcard|demo)/u;
const expectedQueueMembership = Object.freeze({
    approved: 'excluded',
    pending: 'included-pending',
    rejected: 'included-rejected',
    spam: 'included-rejected'
});
const expectedReadModels = Object.freeze({
    approved: Object.freeze({ admin: 'visible-exact', public: 'visible-exact' }),
    pending: Object.freeze({ admin: 'visible-exact', public: 'hidden-exact' }),
    rejected: Object.freeze({ admin: 'visible-exact', public: 'hidden-exact' }),
    spam: Object.freeze({ admin: 'visible-exact', public: 'hidden-exact' })
});
const expectedSoftDelete = Object.freeze({
    childVisibility: 'approved-children-remain-visible-with-placeholder-chain',
    physicalDelete: 'forbidden',
    publicPlaceholder: 'required-for-visible-descendants'
});

const expectedCapabilityContracts = Object.freeze({
    'comment.actor.public': [['article.published', 'auth.user.active'], ['actorId', 'actorMode', 'commentId'], ['admin.actor-exact', 'database.actor-exact', 'public.actor-exact'], ['actor-canonical', 'actor-projection-parity']],
    'comment.actor.zk-anonymous': [['article.published', 'auth.zk-anonymous.active'], ['actorMode', 'commentId', 'publicIdentity'], ['admin.actor-exact', 'database.actor-exact', 'public.actor-exact'], ['actor-canonical', 'actor-private-credential-absent']],
    'comment.delete.reply': [['article.published', 'auth.user.active'], ['commentId', 'currentVersion', 'deleteState', 'history', 'parentId', 'rootId'], ['admin.deleted-reply-exact', 'cache.generation-exact', 'database.soft-delete-exact', 'public.deleted-reply-placeholder-exact'], ['deleted-reply-history', 'deleted-reply-not-physical']],
    'comment.delete.root': [['article.published', 'auth.user.active'], ['childIds', 'commentId', 'currentVersion', 'deleteState', 'history', 'rootId'], ['admin.deleted-root-exact', 'cache.generation-exact', 'database.soft-delete-exact', 'public.deleted-root-placeholder-chain-exact'], ['deleted-root-child-visible', 'deleted-root-history']],
    'comment.moderation.approved': [['auth.admin.full-permission', 'comment.thread.root'], ['commentId', 'moderatedAt', 'moderationReason', 'moderationStatus', 'policyDigest'], ['admin.status-exact', 'cache.public-membership-exact', 'database.moderation-audit-exact', 'public.visible-exact', 'queue.membership-exact'], ['approved-public', 'approved-queue-excluded']],
    'comment.moderation.pending': [['auth.admin.full-permission', 'comment.thread.root'], ['commentId', 'moderatedAt', 'moderationReason', 'moderationStatus', 'policyDigest'], ['admin.status-exact', 'cache.public-absence-exact', 'database.moderation-audit-exact', 'public.hidden-exact', 'queue.membership-exact'], ['pending-public-hidden', 'pending-queue-exact']],
    'comment.moderation.rejected': [['auth.admin.full-permission', 'comment.thread.root'], ['commentId', 'moderatedAt', 'moderationReason', 'moderationStatus', 'policyDigest'], ['admin.status-exact', 'cache.public-absence-exact', 'database.moderation-audit-exact', 'public.hidden-exact', 'queue.membership-exact'], ['rejected-public-hidden', 'rejected-queue-exact']],
    'comment.moderation.spam': [['auth.admin.full-permission', 'comment.thread.root'], ['classification', 'commentId', 'evidenceRef', 'moderationReason', 'moderationStatus', 'signalRef'], ['admin.signal-exact', 'database.evidence-exact', 'public.hidden-exact', 'queue.rejected-membership-exact'], ['spam-evidence-bound', 'spam-rejected-projection']],
    'comment.queue.exact-membership': [['auth.admin.full-permission', 'comment.moderation.pending', 'comment.moderation.rejected', 'comment.moderation.spam'], ['bucket', 'commentIds', 'group', 'order', 'reason'], ['admin.queue-exact', 'database.queue-source-exact'], ['queue-no-count-shortcut', 'queue-no-first-row']],
    'comment.region.global': [['comment.thread.root'], ['applicableRegions', 'commentId', 'decisionEvidence', 'policyDigest', 'policyVersion', 'regionCode'], ['admin.region-exact', 'database.region-evidence-exact', 'public.region-visibility-exact'], ['region-evidence-structured', 'region-policy-bound']],
    'comment.region.manual-review': [['comment.thread.root'], ['commentId', 'decisionEvidence', 'policyDigest', 'policyVersion', 'regionCode', 'requiresManualReview'], ['admin.region-exact', 'database.region-evidence-exact', 'public.hidden-exact', 'queue.membership-exact'], ['region-manual-review', 'region-policy-bound']],
    'comment.signal.verified': [['comment.thread.root'], ['classification', 'commentId', 'confidence', 'evidenceRef', 'provider', 'signalRef', 'version'], ['admin.signal-exact', 'database.evidence-exact', 'database.signal-exact'], ['signal-private-payload-absent', 'signal-provider-version-bound']],
    'comment.thread.depth-boundary': [['article.published', 'auth.user.active'], ['commentId', 'depth', 'parentId', 'rootId'], ['admin.relation-exact', 'database.depth-policy-exact', 'public.relation-exact'], ['depth-boundary-accepted', 'depth-overrun-rejected']],
    'comment.thread.nested': [['article.published', 'auth.user.active'], ['commentId', 'depth', 'parentId', 'replyToCommentId', 'rootId'], ['admin.relation-exact', 'database.relation-exact', 'public.relation-exact'], ['nested-public-order', 'nested-relation']],
    'comment.thread.reply': [['article.published', 'auth.user.active'], ['commentId', 'depth', 'parentId', 'replyToCommentId', 'rootId'], ['admin.relation-exact', 'database.relation-exact', 'public.relation-exact'], ['reply-parent-root', 'reply-target-exact']],
    'comment.thread.root': [['article.published', 'auth.user.active'], ['articleId', 'commentId', 'depth', 'parentId', 'replyToCommentId', 'rootId'], ['admin.relation-exact', 'database.relation-exact', 'public.relation-exact'], ['root-public-order', 'root-relation']],
    'comment.version.edited': [['article.published', 'auth.user.active'], ['commentId', 'contentDigest', 'currentVersion', 'editedAt', 'history', 'previousVersion'], ['admin.history-exact', 'cache.generation-exact', 'database.revision-exact', 'public.content-version-exact'], ['edit-history-current', 'edit-version-increment']]
});

function stableStringify(value)
{
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

export function digestCommentFixtureValue(value)
{
    return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

function exactKeys(value, expected, label, errors)
{
    if (!value || typeof value !== 'object' || Array.isArray(value))
    {
        errors.push(`${label} must be an object`);
        return;
    }
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    if (JSON.stringify(actual) !== JSON.stringify(wanted))
    {
        errors.push(`${label} keys are not closed`);
    }
}

function sortedUnique(values, pattern = stableId)
{
    return Array.isArray(values) && values.every((value, index) => typeof value === 'string'
        && pattern.test(value) && (index === 0 || values[index - 1] < value));
}

function exactArray(actual, expected)
{
    return Array.isArray(actual) && actual.length === expected.length
        && actual.every((value, index) => value === expected[index]);
}

function validateRuntimeAuthorities(inventory, errors)
{
    const refs = inventory?.runtimeReferences ?? {};
    const sources = Object.fromEntries(Object.entries(refs).map(([key, file]) => [
        key,
        typeof file === 'string' && fs.existsSync(path.join(repositoryRoot, file))
            ? fs.readFileSync(path.join(repositoryRoot, file), 'utf8')
            : ''
    ]));
    const anchors = {
        actorModes: [/public const string Public = "public";/u, /public const string ZkAnonymous = "zk_anonymous";/u],
        moderationStatuses: [/Pending\s*=\s*0/u, /Approved\s*=\s*1/u, /Rejected\s*=\s*2/u],
        revisionOperations: [/const string Created = "created";/u, /const string Edited = "edited";/u, /const string Deleted = "deleted";/u],
        threadPolicy: [/CommentThreads:MaxDepth/u, /comment_thread_depth_limit/u],
        regionPolicy: [/sealed record RegionModerationDecision/u, /RequiresManualReview/u, /HideUntilReviewed/u],
        signalEntity: [/class CommentModerationSignal/u, /ContractVersion/u, /EvidenceJson/u],
        signalModel: [/class AntiSpamModerationContract/u, /DefaultVersion/u, /AntiSpamModerationEvidence/u]
    };
    for (const [name, patterns] of Object.entries(anchors))
        for (const pattern of patterns)
            if (!pattern.test(sources[name] ?? '')) errors.push(`runtime authority ${name} is missing ${pattern.source}`);

    const publicReader = fs.readFileSync(path.join(repositoryRoot, 'src/backend/Services/CommentQueryService.cs'), 'utf8');
    const queueReader = fs.readFileSync(path.join(repositoryRoot, 'src/backend/Services/Authoring/AuthoringModerationWorkflowService.cs'), 'utf8');
    if (!/moderation_status\s*=\s*@Approved/u.test(publicReader)
        || !/CommentModerationStatus\.Approved/u.test(publicReader)
        || !/CommentModerationStatus\.Pending/u.test(queueReader)
        || !/CommentModerationStatus\.Rejected/u.test(queueReader))
        errors.push('public/queue state rules are not backed by current production readers');
}

export function commentFixtureInventoryErrors(inventory)
{
    const errors = [];
    exactKeys(inventory, [
        'schema', 'version', 'producerId', 'strategy', 'runtimeReferences', 'actorModes',
        'moderationStatuses', 'revisionOperations', 'threadRelations', 'stateRules', 'capabilities'
    ], 'inventory', errors);
    if (inventory?.schema !== 'fsusblog.comment-fixture-inventory.v1' || inventory?.version !== 1)
        errors.push('inventory schema/version is not current');
    if (inventory?.producerId !== 'comment-moderation' || inventory?.strategy !== 'transaction-fixture')
        errors.push('inventory does not bind the unique transaction-fixture producer');
    if (JSON.stringify(inventory?.actorModes) !== JSON.stringify(['public', 'zk_anonymous']))
        errors.push('actor modes must be exactly public and zk_anonymous');
    if ((inventory?.actorModes ?? []).some((value) => legacyActor.test(value)))
        errors.push('legacy actor alias is forbidden');
    if (JSON.stringify(inventory?.moderationStatuses) !== JSON.stringify(['approved', 'pending', 'rejected', 'spam']))
        errors.push('moderation states are incomplete or contain a private alias');
    if (JSON.stringify(inventory?.revisionOperations) !== JSON.stringify(['created', 'deleted', 'edited']))
        errors.push('revision operations are incomplete');
    if (JSON.stringify(inventory?.threadRelations) !== JSON.stringify(['depth', 'parent_id', 'reply_to_comment_id', 'root_id']))
        errors.push('thread relation schema is incomplete');

    exactKeys(inventory?.runtimeReferences, [
        'actorModes', 'moderationStatuses', 'revisionOperations', 'threadPolicy', 'regionPolicy', 'signalEntity', 'signalModel'
    ], 'runtimeReferences', errors);
    for (const file of Object.values(inventory?.runtimeReferences ?? {}))
    {
        if (typeof file !== 'string' || !fs.existsSync(path.join(repositoryRoot, file)))
            errors.push(`runtime reference is missing: ${file}`);
    }
    validateRuntimeAuthorities(inventory, errors);

    exactKeys(inventory?.stateRules, [
        'mutuallyExclusiveIdentityFields', 'queueMembership', 'readModels', 'softDelete'
    ], 'stateRules', errors);
    if (!sortedUnique(inventory?.stateRules?.mutuallyExclusiveIdentityFields, /^[A-Za-z][A-Za-z0-9]*$/u))
        errors.push('mutually exclusive identity fields must be sorted and unique');
    for (const status of inventory?.moderationStatuses ?? [])
    {
        if (!Object.hasOwn(inventory?.stateRules?.queueMembership ?? {}, status)
            || !Object.hasOwn(inventory?.stateRules?.readModels ?? {}, status))
            errors.push(`status ${status} has no exact queue/read-model rule`);
        exactKeys(inventory?.stateRules?.readModels?.[status], ['admin', 'public'], `readModels.${status}`, errors);
    }
    if (stableStringify(inventory?.stateRules?.queueMembership) !== stableStringify(expectedQueueMembership))
        errors.push('queue membership does not match the production moderation queue contract');
    if (stableStringify(inventory?.stateRules?.readModels) !== stableStringify(expectedReadModels))
        errors.push('read-model visibility does not match the production comment readers');
    if (stableStringify(inventory?.stateRules?.softDelete) !== stableStringify(expectedSoftDelete))
        errors.push('soft-delete rules do not match the production comment reader contract');
    if (Object.keys(inventory?.stateRules?.queueMembership ?? {}).some((key) => !inventory.moderationStatuses?.includes(key))
        || Object.keys(inventory?.stateRules?.readModels ?? {}).some((key) => !inventory.moderationStatuses?.includes(key)))
        errors.push('unknown moderation state has a second state map');

    const capabilities = inventory?.capabilities ?? [];
    if (!sortedUnique(capabilities.map((item) => item?.id)))
        errors.push('capabilities must be sorted, unique, and stable');
    const ids = new Set(capabilities.map((item) => item?.id));
    const required = [
        'comment.actor.public', 'comment.actor.zk-anonymous', 'comment.delete.reply', 'comment.delete.root',
        'comment.moderation.approved', 'comment.moderation.pending', 'comment.moderation.rejected',
        'comment.moderation.spam', 'comment.queue.exact-membership', 'comment.region.global',
        'comment.region.manual-review', 'comment.signal.verified', 'comment.thread.depth-boundary',
        'comment.thread.nested', 'comment.thread.reply', 'comment.thread.root', 'comment.version.edited'
    ];
    for (const id of required) if (!ids.has(id)) errors.push(`missing capability ${id}`);
    for (const capability of capabilities)
    {
        exactKeys(capability, ['id', 'portId', 'requiredRefs', 'stateFields', 'postconditions', 'proofTests'], `capability ${capability?.id}`, errors);
        if (!['comment-thread-lifecycle', 'comment-moderation-lifecycle'].includes(capability?.portId))
            errors.push(`capability ${capability?.id} has unknown port`);
        for (const [field, values] of Object.entries({
            requiredRefs: capability?.requiredRefs,
            stateFields: capability?.stateFields,
            postconditions: capability?.postconditions,
            proofTests: capability?.proofTests
        }))
        {
            if (!sortedUnique(values, /^[A-Za-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*$/u))
                errors.push(`capability ${capability?.id} ${field} must be sorted and unique`);
        }
        const expected = expectedCapabilityContracts[capability?.id];
        if (expected && (!exactArray(capability.requiredRefs, expected[0])
            || !exactArray(capability.stateFields, expected[1])
            || !exactArray(capability.postconditions, expected[2])
            || !exactArray(capability.proofTests, expected[3])))
            errors.push(`capability ${capability?.id} does not match its exact authority binding`);
        if ((capability?.postconditions ?? []).some((value) => shortcut.test(value)))
            errors.push(`capability ${capability?.id} uses a shortcut postcondition`);
        if (!(capability?.postconditions ?? []).some((value) => value.startsWith('database.'))
            || !(capability?.postconditions ?? []).some((value) => /^(?:admin|public)\./u.test(value)))
            errors.push(`capability ${capability?.id} lacks storage/read-model evidence`);
        const requiredStateFields = {
            'comment.queue.exact-membership': ['bucket', 'commentIds', 'group', 'order', 'reason'],
            'comment.signal.verified': ['classification', 'commentId', 'confidence', 'evidenceRef', 'provider', 'signalRef', 'version'],
            'comment.thread.depth-boundary': ['commentId', 'depth', 'parentId', 'rootId'],
            'comment.version.edited': ['commentId', 'contentDigest', 'currentVersion', 'history', 'previousVersion']
        }[capability?.id] ?? [];
        for (const field of requiredStateFields)
            if (!capability?.stateFields?.includes(field))
                errors.push(`capability ${capability?.id} stateFields is missing ${field}`);
    }
    return errors;
}

export function validateCommentFixtureInventory(inventory)
{
    const errors = commentFixtureInventoryErrors(inventory);
    if (errors.length) throw new Error(`comment fixture inventory invalid:\n- ${errors.join('\n- ')}`);
    return true;
}

export function readCommentFixtureInventory()
{
    const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
    validateCommentFixtureInventory(inventory);
    return Object.freeze({ inventory, inventoryDigest: digestCommentFixtureValue(inventory) });
}
