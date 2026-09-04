import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const inventoryPath = path.join(repositoryRoot, 'config/testing/comment-fixture-inventory.json');
const stableId = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const legacyActor = /(?:legacy|pseudonymous|identified-opt-in|current-equivalent|^anonymous$)/u;
const shortcut = /(?:count-positive|count>0|first-row|row-exists|status-integer|wildcard|demo)/u;

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
        'actorModes', 'moderationStatuses', 'revisionOperations', 'threadPolicy', 'regionPolicy', 'signalContract'
    ], 'runtimeReferences', errors);
    for (const file of Object.values(inventory?.runtimeReferences ?? {}))
    {
        if (typeof file !== 'string' || !fs.existsSync(path.join(repositoryRoot, file)))
            errors.push(`runtime reference is missing: ${file}`);
    }

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
